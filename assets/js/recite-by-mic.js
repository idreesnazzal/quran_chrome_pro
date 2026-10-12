/* ============================================================================
 * Recite-by-Mic v3 — probabilistic recitation tracker
 * ----------------------------------------------------------------------------
 * WHY v3 (read before touching): v2 was a stack of special cases (basmala
 * guard, isti'adha guard, opener strip, tie rules, drift counter, watchdog,
 * re-anchor, pending-jump...). Each patched one screenshot and broke another.
 * Its live input also duplicated words whenever Chrome revised an interim
 * guess (overlap-join could not tell a revision from new speech).
 *
 * v3 replaces all of it with ONE model, the standard approach for following a
 * known text (score following / lyrics tracking):
 *
 *   Hidden state  = position in the Quran read as ONE word sequence
 *                   (77,797 words + a virtual basmala before each surah
 *                   except 1 and 9). State g = "last recited word is g".
 *   Transitions   = next word (dominant), skip 1..5 words (ASR deletions),
 *                   repeat a word, restart a few words back / at the ayah
 *                   start (tasmee' corrections), skip the basmala, two text
 *                   words heard as one ASR token, garbage word (stay), and a
 *                   rare TELEPORT to positions seeded by an inverted index
 *                   (real jumps). Teleport mass is split across its seeds, so
 *                   common words barely teleport and rare ones do (IDF for
 *                   free).
 *   Emission      = char-Levenshtein similarity between heard and text word.
 *   Inference     = forward algorithm in log space with a beam (top-K
 *                   states). The answer is the best state; CONFIDENCE is the
 *                   real posterior mass near it, not a constant.
 *
 * What falls out without special cases:
 *   - mutashabihat / refrains: belief stays split until a disambiguating word,
 *     and the local sequential path wins because teleport is expensive;
 *   - basmala at a surah start: it IS text before every surah, so the next
 *     words pick the surah; no "teleport to page 1" bug;
 *   - garbage ASR (melodic recitation through MSA acoustics): every candidate
 *     scores badly, confidence drops, the UI holds instead of jumping.
 * The only rule-based piece left is the opener filter (isti'adha and
 * "sadaqa Allah al-azim" are not Quran text), a tiny streaming matcher.
 *
 * Live input: Web Speech results are consumed by RESULT INDEX. A final result
 * is committed to the tracker exactly once; interim text is evaluated on a
 * throw-away copy of the beam (peek) for instant display and never mutates
 * state, so a revised guess can never leave duplicates behind.
 * Only one source of "ears" is active at a time (browser OR server Whisper).
 *
 * Tests + benchmark (old vs new, real 6,236-ayah corpus):
 *   node tests/run_tests.js        node tests/benchmark.js
 * ========================================================================== */
(function (G) {
'use strict';

var RECITE_VERSION = '3.1.0-hmm+quran-whisper';

var CFG = {
  BEAM: 96,              // states kept after each word (64..320 give the same accuracy; 96 = margin)
  PRUNE: 20,             // drop states this far (log) below the best
  T_NEXT: 0.80,          // P(next word)
  T_SKIP: [0, 0, 0.06, 0.02, 0.008, 0.005, 0.004], // index = distance d (2..6)
  T_MERGE: 0.04,         // two text words heard as one token
  T_REPEAT: 0.03,        // same word again
  T_BACK: 0.035,         // restart 1..8 words back (spread)
  T_AYAH_START: 0.015,   // restart at the beginning of the current ayah
  T_GARBAGE: 0.08,       // heard word is not Quran text: stay
  T_BASMALA_SKIP: 0.35,  // surah end -> next surah's first word, no basmala
  TELEPORT: 0.006,       // total mass for jumping anywhere (split over seeds); tuned:
                         // 0.0002..0.01 no false jumps, 0.03 starts jumping on off-Quran speech
  SEED_BIGRAM_MAX: 400,  // bigram postings longer than this are uninformative
  SEED_UNIGRAM_MAX: 160,
  FUZZY_SEED_SIM: 0.80,
  E_SLOPE: 5.0,          // emission log-ratio = clamp(E_SLOPE*(sim-E_MID))
  E_MID: 0.55,
  E_MAX: 2.25,
  E_MIN: -4.0,           // unrelated word: advancing on it must lose to 'garbage, stay'
  SHOW_CONF: 0.45,       // min posterior to move the highlight
  JUMP_CONF: 0.75,       // min posterior to move the highlight more than 8 words
  WEAK_SIM: 0.5,         // highlight never moves onto a word the last heard word does not resemble
  TURN_CONF: 0.80,       // posterior that turns the page immediately
  TURN_CONF_2: 0.55,     // ...or this, on two consecutive updates
  DEBUG: false,
  whisper: { enabled: false, endpoint: '', chunkSeconds: 4, lang: 'ar' }
};

/* ------------------------------ text ---------------------------------- */
function normalizeArabic(text) {
  if (!text) return '';
  return String(text)
    .replace(/[ً-ٰٟۖ-ۭ]/g, '') // tashkeel, dagger alif, Uthmani marks
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ـ‌‍]/g, '')
    .replace(/[ئؤ]/g, 'ء')
    .replace(/[^؀-ۿ\s]/g, ' ')
    .replace(/[٠-٩۰-۹]/g, ' ')          // Arabic-Indic digits
    .replace(/[،؛؟٪-٭۔]/g, ' ') // Arabic punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Spelled-out muqatta'at as speech engines write them -> the text token.
var MUQ = [
  ['كاف ها يا عين صاد', 'كهيعص'], ['الف لام ميم صاد', 'المص'],
  ['الف لام ميم را', 'المر'], ['الف لام ميم', 'الم'], ['الف لام را', 'الر'],
  ['عين سين قاف', 'عسق'], ['طا سين ميم', 'طسم'], ['طا سين', 'طس'],
  ['حا ميم', 'حم'], ['طا ها', 'طه'], ['يا سين', 'يس'],
  ['طاها', 'طه'], ['ياسين', 'يس'], ['حاميم', 'حم'], ['طاسين', 'طس'],
  ['قاف', 'ق'], ['نون', 'ن'], ['صاد', 'ص']
].map(function (e) { return [normalizeArabic(e[0]).split(' '), normalizeArabic(e[1])]; });

function tokenize(text) {
  var n = normalizeArabic(text);
  if (!n) return [];
  var t = n.split(' ');
  var out = [];
  for (var i = 0; i < t.length;) {
    var hit = null;
    for (var m = 0; m < MUQ.length && !hit; m++) {
      var ph = MUQ[m][0];
      if (i + ph.length > t.length) continue;
      var ok = true;
      for (var k = 0; k < ph.length; k++) if (t[i + k] !== ph[k]) { ok = false; break; }
      if (ok) hit = MUQ[m];
    }
    if (hit) { out.push(hit[1]); i += hit[0].length; }
    else { out.push(t[i]); i++; }
  }
  return out;
}

function lev(a, b) {
  var m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  var prev = new Array(n + 1), cur = new Array(n + 1), j, i;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    var ca = a.charCodeAt(i - 1);
    for (j = 1; j <= n; j++) {
      var v = prev[j] + 1, ins = cur[j - 1] + 1, sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      if (ins < v) v = ins;
      if (sub < v) v = sub;
      cur[j] = v;
    }
    var tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function wordSim(a, b) {
  if (a === b) return 1;
  var m = Math.max(a.length, b.length);
  if (!m) return 0;
  if (Math.abs(a.length - b.length) > Math.max(2, Math.min(a.length, b.length))) return 0;
  return 1 - lev(a, b) / m;
}

/* ------------------------------ corpus -------------------------------- */
var BASMALA = normalizeArabic('بسم الله الرحمن الرحيم').split(' ');

/* ayahs: QURAN_DATA.ayahs rows [sura, aya, page, suraName, text, ...] */
function buildCorpus(ayahs) {
  var words = [], ayahOf = [], wordOf = [], virt = [];
  var ayahFirst = new Int32Array(ayahs.length), ayahLast = new Int32Array(ayahs.length);
  var ayahList = [];
  var surahEndBeforeBasmala = {}; // position of a surah's last word -> its next surah's first real word
  for (var i = 0; i < ayahs.length; i++) {
    var r = ayahs[i];
    var sura = r[0], aya = r[1];
    if (aya === 1 && sura !== 1 && sura !== 9) {
      var before = words.length - 1;
      for (var b = 0; b < BASMALA.length; b++) {
        words.push(BASMALA[b]); ayahOf.push(i); wordOf.push(-1); virt.push(1);
      }
      if (before >= 0) surahEndBeforeBasmala[before] = words.length; // first real word follows
    }
    var clean = String(r[4] || '').replace(/\(\d+\)\s*$/, '').trim();
    var ws = normalizeArabic(clean).split(' ').filter(Boolean);
    ayahFirst[i] = words.length;
    for (var w = 0; w < ws.length; w++) {
      words.push(ws[w]); ayahOf.push(i); wordOf.push(w); virt.push(0);
    }
    ayahLast[i] = words.length - 1;
    ayahList.push({ idx: i, sura: sura, aya: aya, page: r[2], suraName: r[3],
      rawText: r[4], cleanText: clean, normText: ws.join(' '), words: ws, wordCount: ws.length });
  }
  var L = words.length;
  var uni = new Map(), bi = new Map();
  for (var p = 0; p < L; p++) {
    var a = uni.get(words[p]); if (!a) { a = []; uni.set(words[p], a); } a.push(p);
    if (p > 0) {
      var key = words[p - 1] + ' ' + words[p];
      var c = bi.get(key); if (!c) { c = []; bi.set(key, c); } c.push(p);
    }
  }
  var byLen = [];
  uni.forEach(function (_, tok) {
    var l = tok.length;
    (byLen[l] || (byLen[l] = [])).push(tok);
  });
  return { words: words, ayahOf: ayahOf, wordOf: wordOf, virt: virt, L: L,
    ayahFirst: ayahFirst, ayahLast: ayahLast, ayahs: ayahList,
    uni: uni, bi: bi, byLen: byLen, basmalaSkip: surahEndBeforeBasmala,
    simCache: new Map(), seedCache: new Map() };
}

/* ------------------------------ model --------------------------------- */
function lse(a, b) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
}

function simCached(C, h, t) {
  if (h === t) return 1;
  var k = h + '\u0001' + t;
  var v = C.simCache.get(k);
  if (v === undefined) {
    v = wordSim(h, t);
    if (C.simCache.size > 200000) C.simCache.clear();
    C.simCache.set(k, v);
  }
  return v;
}

var STEP_MEMO = null, STEP_H = null; // per-step memo: text word -> sim with the heard word
function emis(C, h, q) {
  var t = C.words[q], s;
  if (STEP_H === h) { s = STEP_MEMO.get(t); if (s === undefined) { s = wordSim(h, t); STEP_MEMO.set(t, s); } }
  else s = simCached(C, h, t);
  var e = CFG.E_SLOPE * (s - CFG.E_MID);
  return e > CFG.E_MAX ? CFG.E_MAX : (e < CFG.E_MIN ? CFG.E_MIN : e);
}

function seedsFor(C, h, hPrev) {
  if (hPrev) {
    var b = C.bi.get(hPrev + ' ' + h);
    if (b && b.length <= CFG.SEED_BIGRAM_MAX) return b;
  }
  return unigramSeeds(C, h);
}

/* exact postings, or (unseen spelling) a fuzzy expansion through the
 * length-bucketed vocabulary; cached per heard word */
function unigramSeeds(C, h) {
  var hit = C.seedCache.get(h);
  if (hit) return hit;
  var out = [];
  var u = C.uni.get(h);
  if (u) { if (u.length <= CFG.SEED_UNIGRAM_MAX) out = u; }
  else {
    var acc = [];
    for (var l = Math.max(1, h.length - 2); l <= h.length + 2; l++) {
      var bucket = C.byLen[l];
      if (!bucket) continue;
      for (var i = 0; i < bucket.length; i++) {
        if (wordSim(h, bucket[i]) >= CFG.FUZZY_SEED_SIM) {
          var ps = C.uni.get(bucket[i]);
          if (ps.length <= CFG.SEED_UNIGRAM_MAX) acc = acc.concat(ps);
        }
      }
    }
    if (acc.length <= CFG.SEED_UNIGRAM_MAX * 2) out = acc;
  }
  if (C.seedCache.size > 50000) C.seedCache.clear();
  C.seedCache.set(h, out);
  return out;
}

var LOG = {};
function logs() {
  LOG.next = Math.log(CFG.T_NEXT);
  LOG.skip = CFG.T_SKIP.map(function (p) { return p > 0 ? Math.log(p) : -Infinity; });
  LOG.merge = Math.log(CFG.T_MERGE);
  LOG.repeat = Math.log(CFG.T_REPEAT);
  LOG.back = Math.log(CFG.T_BACK / 8);
  LOG.ayahStart = Math.log(CFG.T_AYAH_START);
  LOG.garbage = Math.log(CFG.T_GARBAGE);
  LOG.bskip = Math.log(CFG.T_BASMALA_SKIP);
  LOG.tele = Math.log(CFG.TELEPORT);
}
logs();

/* One forward step: alpha (Map pos->log) + heard word -> new alpha.
 * Pure: never mutates its input (peek relies on that). */
function stepAlpha(C, alpha, h, hPrev) {
  var nx = new Map();
  var L = C.L, words = C.words;
  STEP_H = h; STEP_MEMO = new Map();
  function add(q, v) {
    var o = nx.get(q);
    nx.set(q, o === undefined ? v : lse(o, v));
  }
  var total = -Infinity;
  alpha.forEach(function (a, g) {
    total = lse(total, a);
    // forward: next word and skips
    for (var d = 1; d <= 6; d++) {
      var q = g + d;
      if (q >= L) break;
      add(q, a + (d === 1 ? LOG.next : LOG.skip[d]) + emis(C, h, q));
    }
    // two text words fused into one heard token (يا ايها -> يايها)
    if (g + 2 < L) {
      var s2 = simCached(C, h, words[g + 1] + words[g + 2]);
      var e2 = CFG.E_SLOPE * (s2 - CFG.E_MID);
      e2 = e2 > CFG.E_MAX ? CFG.E_MAX : (e2 < CFG.E_MIN ? CFG.E_MIN : e2);
      add(g + 2, a + LOG.merge + e2);
    }
    // surah end -> skip the next surah's basmala
    var bs = C.basmalaSkip[g];
    if (bs !== undefined && bs < L) add(bs, a + LOG.bskip + emis(C, h, bs));
    if (g >= 0) {
      add(g, a + LOG.repeat + emis(C, h, g));            // repeated word
      for (var k = 1; k <= 8 && g - k >= 0; k++) {        // restart a few words back
        add(g - k, a + LOG.back + emis(C, h, g - k));
      }
      var ai = C.ayahOf[g];
      var f0 = C.ayahFirst[ai];
      if (g - f0 > 8) add(f0, a + LOG.ayahStart + emis(C, h, f0)); // restart the ayah
    }
    add(g, a + LOG.garbage);                               // not Quran text
  });
  // teleport (real jumps), split over seeds
  var seeds = seedsFor(C, h, hPrev);
  if (seeds.length) {
    var t = total + LOG.tele - Math.log(seeds.length);
    for (var i = 0; i < seeds.length; i++) add(seeds[i], t + emis(C, h, seeds[i]));
  }
  // beam
  var arr = [];
  nx.forEach(function (v, q) { arr.push([q, v]); });
  arr.sort(function (x, y) { return y[1] - x[1]; });
  var best = arr.length ? arr[0][1] : 0;
  var out = new Map();
  for (var j = 0; j < arr.length && j < CFG.BEAM; j++) {
    if (arr[j][1] < best - CFG.PRUNE) break;
    out.set(arr[j][0], arr[j][1] - best); // renormalise: best = 0
  }
  out.rawBest = best; // log-gain of the best path on this word (lost detector)
  return out;
}

function summarize(C, alpha) {
  var bestQ = -1, bestV = -Infinity, total = -Infinity;
  alpha.forEach(function (v, q) {
    total = lse(total, v);
    if (v > bestV) { bestV = v; bestQ = q; }
  });
  if (bestQ < 0) return null;
  var near = -Infinity;
  alpha.forEach(function (v, q) { if (Math.abs(q - bestQ) <= 3) near = lse(near, v); });
  var conf = Math.exp(near - total);
  var ai = C.ayahOf[bestQ];
  return { pos: bestQ, ayahIdx: ai, wordIdx: C.wordOf[bestQ], basmala: !!C.virt[bestQ],
    conf: conf, ayah: C.ayahs[ai] };
}

/* ------------------------------ opener filter ------------------------- */
// Not Quran text, said around recitation. Patterns of <=2 words must match
// exactly (a fuzzy «امين» would swallow «امن»); longer ones tolerate ASR noise.
// «الله اكبر» also occurs inside 9:72 / 29:45: swallowing it there costs two
// skipped words, which the model absorbs; NOT swallowing it elsewhere lets a
// 2-word bigram teleport to 29:45.
var OPENERS = [
  'اعوذ بالله من الشيطان الرجيم',
  'اعوذ بالله السميع العليم من الشيطان الرجيم',
  'صدق الله العظيم',
  'الله اكبر',
  'امين'
].map(function (s) { return normalizeArabic(s).split(' '); });

function openerState(hold) { return { hold: hold ? hold.slice() : [] }; }

/* push one word; returns words released to the tracker */
function openerPush(st, w) {
  st.hold.push(w);
  var released = [];
  for (;;) {
    var n = st.hold.length;
    if (!n) return released;
    var full = false, prefix = false;
    for (var o = 0; o < OPENERS.length; o++) {
      var P = OPENERS[o];
      if (n > P.length) continue;
      var ok = true;
      var need = P.length <= 2 ? 1 : 0.75;
      for (var k = 0; k < n; k++) if (wordSim(st.hold[k], P[k]) < need) { ok = false; break; }
      if (!ok) continue;
      if (n === P.length) full = true; else prefix = true;
    }
    if (full) { st.hold = []; return released; }   // swallow the opener
    if (prefix) return released;                    // wait for more words
    released.push(st.hold.shift());                 // not an opener: release head
  }
}

/* ------------------------------ tracker ------------------------------- */
function Tracker(C) {
  this.C = C;
  this.reset();
}
Tracker.prototype.reset = function () {
  this.peekCache = [];    // [{w, alpha, prev, hold, gains}] of the last peek
  this.alpha = new Map();
  this.opener = openerState();
  this.prev = null;       // last word fed to the model
  this.gains = [];        // recent best-path gains (lost detector)
  this.steps = 0;
};
/* prior: ayah indexes the reader is likely to start at (current page...) */
Tracker.prototype.setPrior = function (ayahIdxs, weight) {
  var C = this.C, a = new Map(), lw = Math.log(weight || 1);
  for (var i = 0; i < ayahIdxs.length; i++) {
    var ai = ayahIdxs[i];
    if (ai < 0 || ai >= C.ayahs.length) continue;
    var f = C.ayahFirst[ai];
    // a surah's first ayah: the reader may start with its basmala
    if (C.ayahs[ai].aya === 1 && f >= 4 && C.virt[f - 1]) a.set(f - 5, lw);
    a.set(f - 1, lw);
  }
  if (!a.size) a.set(-1, 0);
  // merge into existing belief (manual page change mid-session keeps context)
  if (this.alpha.size) {
    this.alpha.forEach(function (v, q) { a.set(q, a.has(q) ? lse(a.get(q), v) : v); });
  }
  this.alpha = a;
};
Tracker.prototype.setPriorAt = function (ayahIdx, wordIdx) {
  var C = this.C;
  if (ayahIdx < 0 || ayahIdx >= C.ayahs.length) return;
  this.alpha = new Map();
  this.alpha.set(C.ayahFirst[ayahIdx] + Math.max(-1, wordIdx | 0) , 0);
};
Tracker.prototype._feed = function (alpha, w, prev) {
  if (!alpha.size) alpha = new Map([[-1, 0]]);
  return stepAlpha(this.C, alpha, w, prev);
};
/* commit words (final results) */
Tracker.prototype.push = function (words) {
  this.peekCache = [];
  for (var i = 0; i < words.length; i++) {
    var rel = openerPush(this.opener, words[i]);
    for (var j = 0; j < rel.length; j++) {
      var before = this.alpha;
      var nx = this._feed(before, rel[j], this.prev);
      this.gains.push(nx.rawBest);
      if (this.gains.length > 6) this.gains.shift();
      this.alpha = nx;
      this.prev = rel[j];
      this.steps++;
    }
  }
  return this.result();
};
/* release words still held by the opener filter (end of a typed query) */
Tracker.prototype.flush = function () {
  var held = this.opener.hold;
  this.opener.hold = [];
  for (var i = 0; i < held.length; i++) {
    var nx = this._feed(this.alpha, held[i], this.prev);
    this.gains.push(nx.rawBest); if (this.gains.length > 6) this.gains.shift();
    this.alpha = nx; this.prev = held[i]; this.steps++;
  }
  this.peekCache = [];
};
/* Evaluate tentative (interim) words on a copy; committed state untouched.
 * Interims grow by a word and revise the last one or two, so the steps of
 * the previous peek are reused up to the first differing word: each interim
 * event costs ~1-3 model steps instead of re-running the whole utterance. */
Tracker.prototype.peek = function (words) {
  var cache = this.peekCache, k = 0;
  while (k < words.length && k < cache.length && cache[k].w === words[k]) k++;
  cache.length = k;
  var base = k ? cache[k - 1] : { alpha: this.alpha, prev: this.prev,
    hold: this.opener.hold, gains: this.gains };
  var alpha = base.alpha, prev = base.prev, st = openerState(base.hold), gains = base.gains.slice();
  for (var i = k; i < words.length; i++) {
    var rel = openerPush(st, words[i]);
    for (var j = 0; j < rel.length; j++) {
      alpha = this._feed(alpha, rel[j], prev);
      gains.push(alpha.rawBest); if (gains.length > 6) gains.shift();
      prev = rel[j];
    }
    cache.push({ w: words[i], alpha: alpha, prev: prev, hold: st.hold.slice(), gains: gains.slice() });
  }
  return this._result(alpha, gains, prev);
};
Tracker.prototype.result = function () { return this._result(this.alpha, this.gains, this.prev); };
Tracker.prototype._result = function (alpha, gains, lastWord) {
  var s = summarize(this.C, alpha);
  if (!s) return null;
  // how well the last heard word matches the tracked word (or the tracked
  // word fused with its predecessor: يا ايها heard as يايها)
  var C = this.C, sim = 0;
  if (lastWord && s.pos >= 0) {
    sim = wordSim(lastWord, C.words[s.pos]);
    if (s.pos > 0) sim = Math.max(sim, wordSim(lastWord, C.words[s.pos - 1] + C.words[s.pos]));
  }
  s.lastSim = sim;
  // lost detector: the best path has been explaining nothing for a while
  // LOST = >=3 of the last 6 words explained badly, and not yet 2 good
  // words in a row (hysteresis: one half-matching word must not un-lose)
  var bad = 0, good = 0;
  for (var i = 0; i < gains.length; i++) if (gains[i] < -1.0) bad++;
  for (var j = gains.length - 1; j >= 0 && gains[j] >= 0.5; j--) good++;
  s.lost = bad >= 3 && good < 2;
  s.lastGain = gains.length ? gains[gains.length - 1] : 0;
  return s;
};

/* =========================== browser glue ============================= */
var HAS_DOM = typeof document !== 'undefined';
var CORPUS = null, TRACKER = null;

function gv(name, dflt) { // read an index.html global (let) safely
  try { return (0, eval)(name); } catch (e) { return dflt; }
}
function sv(name, val) {
  try { (0, eval)(name + '=' + JSON.stringify(val)); } catch (e) {}
}
function log() { if (CFG.DEBUG && G.console) console.log.apply(console, arguments); }

function ayahRows() {
  var d = gv('activeData', null);
  if (d && d.length) return d;
  return (G.QURAN_DATA && G.QURAN_DATA.ayahs) || [];
}

function buildVoiceRecitationIndex() {
  if (CORPUS) return;
  var rows = ayahRows();
  if (!rows.length) return;
  var t0 = Date.now();
  CORPUS = buildCorpus(rows);
  TRACKER = new Tracker(CORPUS);
  sv('isVoiceIndexBuilt', true);
  try { ayahVoiceIndex = CORPUS.ayahs; } catch (e) { G.ayahVoiceIndex = CORPUS.ayahs; }
  log('[recite] corpus', CORPUS.L, 'positions in', Date.now() - t0, 'ms');
}

function visiblePages() {
  if (gv('isDoublePageMode', false)) return [gv('currentRightPage', 1), gv('currentLeftPage', 2)];
  return [gv('currentPage', 1)];
}
function ayahsOnPages(pages) {
  var out = [];
  for (var i = 0; i < CORPUS.ayahs.length; i++) if (pages.indexOf(CORPUS.ayahs[i].page) !== -1) out.push(i);
  return out;
}

/* ---------- UI bridge: tracker result -> kept index.html UI ---------- */
var UI = { lastPos: -1, lastAyah: -1, lastWord: -2, pendingPage: -1, autoPage: -1, raf: 0, queued: null };

/* decide synchronously (testable in Node), paint on the next frame */
function emit(res, transcript, tentative) {
  if (!res) return;
  API.lastResult = res;
  var d = decide(res, tentative);
  API.lastShown = d.m || API.lastShown;
  if (!HAS_DOM) return;
  // several speech events can land in one frame: a later "no change" must
  // not swallow an earlier move that has not been painted yet
  var pendingM = d.m || (UI.queued && UI.queued.d.m) || null;
  UI.queued = { d: { m: pendingM, status: d.status }, transcript: transcript };
  if (UI.raf) return;
  var run = function () { UI.raf = 0; var q = UI.queued; UI.queued = null; if (q) paint(q.d, q.transcript); };
  UI.raf = (G.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(run);
}

function setStatus(text) {
  try { var el = document.getElementById('voiceStatusText'); if (el) el.textContent = text; } catch (e) {}
}

/* -> { status, m } ; m = what the highlight should show (null = hold) */
function decide(res, tentative) {
  if (res.lost) return { status: 'لم أتعرف على التلاوة بعد... تابع القراءة' };
  if (res.conf < CFG.SHOW_CONF) return { status: 'أتحقق من الموضع...' };
  var ay = res.ayah;
  // page turn hysteresis: a confident result turns at once, a medium one
  // must repeat on the next update (prevents flip-flopping between twins)
  var pages = visiblePages();
  if (pages.indexOf(ay.page) === -1) {
    var ok = res.conf >= CFG.TURN_CONF || (res.conf >= CFG.TURN_CONF_2 && UI.pendingPage === ay.page);
    UI.pendingPage = ay.page;
    if (!ok) return { status: 'أتحقق من الموضع...' };
    UI.autoPage = ay.page;
  }
  UI.pendingPage = -1;
  var wordIdx = res.basmala ? -1 : res.wordIdx;
  if (res.ayahIdx === UI.lastAyah && wordIdx === UI.lastWord) return { same: true };
  // a word that matched nothing may not push the highlight forward (it is
  // either noise or the start of a jump; the next real words decide)
  if (UI.lastPos >= 0 && res.lastSim < CFG.WEAK_SIM) return { same: true };
  // a far move (jump) needs a confident belief, not a 50/50 one
  if (UI.lastPos >= 0 && Math.abs(res.pos - UI.lastPos) > 8 && res.conf < CFG.JUMP_CONF) return { status: 'أتحقق من الموضع...' };
  UI.lastPos = res.pos;
  var isJump = UI.lastAyah >= 0 && Math.abs(res.ayahIdx - UI.lastAyah) > 3;
  UI.lastAyah = res.ayahIdx; UI.lastWord = wordIdx;
  return { m: { bestIdx: res.ayahIdx, bestAyah: ay, activeWordIdx: wordIdx,
    score: res.conf, baseScore: res.conf, confidence: Math.round(res.conf * 100),
    isJump: isJump, tentative: !!tentative, basmala: res.basmala } };
}

function paint(d, transcript) {
  showTranscript(transcript);
  if (d.status) setStatus(d.status);
  if (!d.m) return;
  try { onVoiceAyahDetected(d.m, null); } catch (e) { log('ui err', e); }
  if (!d.m.isJump) setStatus(d.m.basmala ? 'البسملة... تابع' : 'متابعة التسميع جارية... 🎙️');
}

function showTranscript(words) {
  if (!words || !HAS_DOM) return;
  var tail = words.slice(-25).join(' ');
  if (words.length > 25) tail = '…' + tail;
  // say WHO heard it: the reader could not tell Chrome's recogniser from the
  // in-browser model (which mishears non-professional voices)
  var src = S.ears === 'local' ? '🧠 النموذج القرآني (تجريبي): ' : (S.ears === 'server' ? '🖥️ الخادم: ' : '🎧 Chrome: ');
  ['voiceTranscriptText', 'dockSpeechText'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = src + '"' + tail + '"';
  });
}

/* ---------- live session ---------- */
var S = { active: false, heard: [], finalIdx: 0, lastFinal: [], rec: null, running: false,
  restartT: null, ears: 'browser', userPage: -1 };

function onUserPageCheck() {
  // the reader turned the page by hand mid-session: they want to recite it
  var p = gv('currentPage', 1);
  if (p !== S.userPage) {
    if (S.userPage !== -1 && p !== UI.autoPage) TRACKER.setPrior(ayahsOnPages(visiblePages()), 50);
    S.userPage = p;
  }
}

/* words = normalised tokens for the tracker; raw = the same words as the
 * recogniser wrote them, for display (the normalised forms «يءمنون», «علي»,
 * «الصلاه» read as wrong words). raw falls back to words when the counts
 * differ (e.g. spelled-out muqatta'at merged into one token). */
function rawFor(words, raw) { return raw && raw.length === words.length ? raw : words; }
function rawSplit(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }

function commitWords(words, raw) {
  if (!words.length || !TRACKER) return;
  onUserPageCheck();
  S.heard = S.heard.concat(words).slice(-200);
  S.heardRaw = (S.heardRaw || []).concat(rawFor(words, raw)).slice(-200);
  emit(TRACKER.push(words), S.heardRaw, false);
}

function tentativeWords(words, raw) {
  if (!TRACKER) return;
  onUserPageCheck();
  if (!words.length) return;
  emit(TRACKER.peek(words), (S.heardRaw || []).concat(rawFor(words, raw)), true);
}

/* Chrome on Android sometimes re-sends the previous final as the prefix of
 * the next one; strip exactly that, nothing fuzzier. */
function stripRepeatedPrefix(words) {
  var p = S.lastFinal;
  if (p.length && words.length >= p.length) {
    for (var i = 0; i < p.length; i++) if (words[i] !== p[i]) return words;
    return words.slice(p.length);
  }
  return words;
}

/* Live feedback for the browser recogniser. Seen on a real Chrome: it
 * starts, detects speech, then returns EMPTY transcripts for recitation, and
 * the panel stayed silent. Now the reader always sees what is happening, and
 * after ~8 s of heard-but-empty speech the app offers the Quran model. */
var HEAR = { speechAt: 0, words: false, timer: null, offered: false };
function lwPanel(text) { var el = HAS_DOM && document.getElementById('dockSpeechText'); if (el) el.textContent = text; }
function hearSpeechStart() {
  if (!HEAR.words && !MIC.silenceWarned && (!MIC.an || MIC.peak > 0.004)) lwPanel('🔊 أسمع صوتًا... أحاول التعرف على الكلمات');
  if (HEAR.speechAt) return;
  HEAR.speechAt = Date.now();
  clearTimeout(HEAR.timer);
  HEAR.timer = setTimeout(offerQuranModel, 25000);
}

function offerQuranModel() {
  if (!S.active || S.ears !== 'browser' || HEAR.words || HEAR.offered) return;
  // the level meter is the judge: Chrome fires speechstart even on a silent
  // input, and a silent mic is a microphone problem, not a recogniser one
  if (MIC.an && (MIC.silenceWarned || MIC.loudMs < 2000)) return;
  HEAR.offered = true;
  lwPanel('⏳ لم تصل كلمات من Chrome بعد 25 ثانية. إن استمر ذلك جرّب 🧠 النموذج القرآني.');
  var b = document.getElementById('dockEarsBtn');
  if (b) b.classList.add('loading');            // pulse the button
  // no dialog: it interrupted a recogniser that is merely slow on this machine
}

/* ---------- microphone monitor (diagnostics) ----------
 * Runs alongside any ears while a session is on:
 *   - shows WHICH microphone Chrome gave us (track label);
 *   - drives the dock's wave bars from the real input level (proof the mic
 *     hears you, independent of any recogniser);
 *   - 6 s of pure silence -> warning + a picker of the audio inputs (Chrome
 *     can stay bound to a disconnected Bluetooth headset and deliver silence);
 *   - sound present but the browser recogniser returns no words -> offer the
 *     Quran model (the onspeechstart path alone missed this).
 * The chosen input (localStorage recite_mic) is used by the Quran model's
 * capture; Chrome's own recogniser always uses Chrome's microphone setting. */
var MIC = { stream: null, ctx: null, an: null, buf: null, raf: 0, peak: 0, started: 0,
  loudMs: 0, lastT: 0, label: '', silenceWarned: false };

function micConstraints(extra) {
  var id = null;
  try { id = localStorage.getItem('recite_mic'); } catch (e) {}
  var a = extra || {};
  if (id) a.deviceId = { exact: id };
  return { audio: Object.keys(a).length ? a : true };
}

function micMonitorStart() {
  micMonitorStop();
  if (!HAS_DOM || CFG.testNoCapture || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  navigator.mediaDevices.getUserMedia(micConstraints({ echoCancellation: false, noiseSuppression: false,
    autoGainControl: false })).then(function (stream) {
    if (!S.active || HEAR.words) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    MIC.stream = stream;
    var tr = stream.getAudioTracks()[0];
    MIC.label = (tr && tr.label) || 'ميكروفون غير معروف';
    var AC = G.AudioContext || G.webkitAudioContext;
    MIC.ctx = new AC();
    MIC.an = MIC.ctx.createAnalyser(); MIC.an.fftSize = 1024;
    MIC.ctx.createMediaStreamSource(stream).connect(MIC.an);
    MIC.buf = new Float32Array(MIC.an.fftSize);
    MIC.peak = 0; MIC.loudMs = 0; MIC.started = MIC.lastT = Date.now(); MIC.silenceWarned = false;
    if (!HEAR.words) lwPanel('🎙️ الميكروفون: ' + MIC.label + ' — ابدأ التلاوة');
    micLoop();
  }).catch(function (err) {
    var n = (err && err.name) || '';
    if (n === 'OverconstrainedError' || n === 'NotFoundError') {   // saved mic is gone: back to default
      try { localStorage.removeItem('recite_mic'); } catch (e) {}
      lwPanel('⚠️ الميكروفون المحفوظ غير موجود — سيُستخدم الافتراضي');
      setTimeout(function () { if (S.active) micMonitorStart(); }, 300);
    } else {
      lwPanel('⚠️ تعذّر فتح الميكروفون (' + n + '). اسمح بالميكروفون من 🔒 بجانب العنوان.');
    }
  });
}

function micLoop() {
  if (!MIC.an || !S.active) return;
  MIC.an.getFloatTimeDomainData(MIC.buf);
  var e = 0;
  for (var i = 0; i < MIC.buf.length; i++) e += MIC.buf[i] * MIC.buf[i];
  var rms = Math.sqrt(e / MIC.buf.length), now = Date.now(), dt = now - MIC.lastT;
  MIC.lastT = now;
  if (rms > MIC.peak) MIC.peak = rms;
  // live level on the dock's wave bars
  var w = document.getElementById('dockAudioWave');
  if (w) {
    var lvl = Math.min(1, rms * 14), bars = w.children, shape = [0.55, 0.85, 1, 0.75, 0.6];
    for (var b = 0; b < bars.length; b++) { bars[b].style.animation = 'none'; bars[b].style.height = (4 + 20 * lvl * shape[b % 5]) + 'px'; }
  }
  // sound present while the browser recogniser stays wordless -> offer the model
  if (rms > 0.02) MIC.loudMs += dt;
  if (S.ears === 'browser' && !HEAR.words && !HEAR.offered && MIC.loudMs > 8000) {
    HEAR.speechAt = HEAR.speechAt || now;
    offerQuranModel();
  }
  // 6 s of silence from the very start -> the mic is not delivering audio
  if (!MIC.silenceWarned && now - MIC.started > 6000 && MIC.peak < 0.004) {
    MIC.silenceWarned = true;
    micSilenceWarning();
  }
  MIC.raf = (G.requestAnimationFrame || function (f) { return setTimeout(f, 50); })(micLoop);
}

function micSilenceWarning() {
  var el = document.getElementById('dockSpeechText');
  if (!el) return;
  navigator.mediaDevices.enumerateDevices().then(function (list) {
    var ins = list.filter(function (d) { return d.kind === 'audioinput'; });
    el.innerHTML = '';
    var msg = document.createElement('span');
    msg.textContent = '⚠️ الميكروفون «' + MIC.label + '» لا يلتقط أي صوت. اختر ميكروفونًا آخر: ';
    el.appendChild(msg);
    var sel = document.createElement('select');
    sel.style.cssText = 'margin:0 6px;max-width:260px;font:inherit';
    var cur = MIC.stream && MIC.stream.getAudioTracks()[0] && MIC.stream.getAudioTracks()[0].getSettings().deviceId;
    ins.forEach(function (d) {
      var o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || ('ميكروفون ' + d.deviceId.slice(0, 6));
      if (d.deviceId === cur) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      try { localStorage.setItem('recite_mic', sel.value); } catch (e) {}
      micMonitorStart();
      if (S.ears === 'local') { lwStopCapture(); lwStartCapture(); }
    };
    el.appendChild(sel);
    var hint = document.createElement('span');
    hint.textContent = ' (التعرف العام للمتصفح يستخدم ميكروفون Chrome: 🔒 بجانب العنوان ← الميكروفون، أو chrome://settings/content/microphone)';
    hint.style.cssText = 'opacity:.8;font-size:.85em';
    el.appendChild(hint);
  });
}

function micMonitorStop() {
  try { if (MIC.raf) (G.cancelAnimationFrame || clearTimeout)(MIC.raf); } catch (e) {}
  try { if (MIC.stream) MIC.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  try { if (MIC.ctx) MIC.ctx.close(); } catch (e) {}
  MIC.stream = MIC.ctx = MIC.an = null; MIC.raf = 0;
  var w = HAS_DOM && document.getElementById('dockAudioWave');
  if (w) for (var b = 0; b < w.children.length; b++) { w.children[b].style.height = ''; w.children[b].style.animation = ''; }
}

/* timing log of the browser recogniser, saved locally by the server under
 * _debug/session_*.json every 10 s and at stop (only when served by
 * recite_server.py on 127.0.0.1). Used to measure Chrome's delay. */
var EVLOG = { t0: 0, list: [], stamp: '', timer: null };
function evlog(type, text) {
  if (!EVLOG.t0) return;
  EVLOG.list.push([Date.now() - EVLOG.t0, type, text || '']);
  if (EVLOG.list.length > 3000) EVLOG.list.shift();
}
function evlogStart() {
  EVLOG.t0 = Date.now(); EVLOG.list = [];
  EVLOG.stamp = 'session-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  clearInterval(EVLOG.timer);
  EVLOG.timer = setInterval(evlogSave, 10000);
}
function evlogSave() {
  if (!EVLOG.t0 || !HAS_DOM || location.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;
  try {
    fetch('/debug-save?kind=json&stamp=' + EVLOG.stamp, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ua: navigator.userAgent, ears: S.ears, events: EVLOG.list }) }).catch(function () {});
  } catch (e) {}
}
function evlogStop() { evlogSave(); clearInterval(EVLOG.timer); EVLOG.t0 = 0; }

function onSpeechResult(ev) {
  try {
    for (var k = ev.resultIndex; k < ev.results.length; k++)
      evlog(ev.results[k].isFinal ? 'final' : 'interim', ev.results[k][0].transcript);
  } catch (e) {}
  var interim = [], interimRaw = [];
  try {
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var r = ev.results[i];
      var toks = tokenize(r[0].transcript);
      var raw = rawFor(toks, rawSplit(r[0].transcript));
      if (toks.length && !HEAR.words) { HEAR.words = true; micMonitorStop(); } // words flow: no diagnostics needed
      if (r.isFinal) {
        if (i < S.finalIdx) continue;        // already committed
        S.finalIdx = i + 1;
        var fresh = stripRepeatedPrefix(toks);
        S.lastFinal = toks;
        commitWords(fresh, raw.slice(raw.length - fresh.length));
      } else if (i >= S.finalIdx) {
        interim = interim.concat(toks);
        interimRaw = interimRaw.concat(raw);
      }
    }
  } catch (e) { log('result err', e); return; }
  tentativeWords(interim, interimRaw);
}

/* Chrome runs ONE speech recognition at a time for the whole browser.
 * Seen on the reader's machine: two app tabs (each auto-restarting its
 * recogniser) aborted each other about once a second, so no words ever
 * arrived ("nothing appears", "massive delay"). Starting the mic here now
 * tells every other tab of the app to stop. */
var TAB_ID = Math.random().toString(36).slice(2);
var TAB_BC = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    TAB_BC = new BroadcastChannel('recite-mic');
    TAB_BC.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'claim' && m.id !== TAB_ID && S.active) {
        stopVoiceRecitation();
        lwPanel('⏸️ أُوقف التسميع هنا لأنه بدأ في نافذة/تبويب آخر للتطبيق');
      }
    };
  }
} catch (e) {}

function startVoiceRecitation() {
  try { if (TAB_BC) TAB_BC.postMessage({ type: 'claim', id: TAB_ID }); } catch (e) {}
  try { if (typeof openVoiceDock === 'function') openVoiceDock(); } catch (e) {}
  buildVoiceRecitationIndex();
  if (!TRACKER) { try { showToast('بيانات المصحف لم تُحمّل بعد'); } catch (e) {} return; }
  var SR = G.SpeechRecognition || G.webkitSpeechRecognition;
  var useServer = CFG.whisper.enabled && CFG.whisper.endpoint;
  if (!SR && !useServer && !(earsPref() === 'quran' && lwSupported())) {
    try { showToast('المتصفح لا يدعم التعرف الصوتي المباشر، يمكنك استخدام لوحة المحاكاة'); } catch (e) {}
    try { if (typeof toggleDockSim === 'function') toggleDockSim(); } catch (e) {}
    return;
  }
  // fresh belief: the visible page(s), the highlighted ayah strongest
  TRACKER.reset();
  TRACKER.setPrior(ayahsOnPages(visiblePages()), 1);
  var hl = gv('currentHighlightedAyah', null);
  if (hl) {
    for (var i = 0; i < CORPUS.ayahs.length; i++) {
      if (CORPUS.ayahs[i].sura === hl.sura && CORPUS.ayahs[i].aya === hl.aya) { TRACKER.setPrior([i], 30); break; }
    }
  }
  UI.lastPos = -1; UI.lastAyah = -1; UI.lastWord = -2; UI.pendingPage = -1; UI.autoPage = -1;
  S.active = true; S.heard = []; S.heardRaw = []; S.noSpeech = 0; S.aborts = []; S.backoff = 0; S.finalIdx = 0; S.lastFinal = []; S.userPage = gv('currentPage', 1);
  clearTimeout(HEAR.timer); HEAR.speechAt = 0; HEAR.words = false; HEAR.offered = false;
  evlogStart();
  // diagnostics only if nothing arrives: a second capture next to Chrome's
  // recogniser is avoided while it works
  clearTimeout(MIC.lazyT);
  sv('isVoiceReciteActive', true);
  try { updateVoiceReciteUI(true); } catch (e) {}
  setStatus('ابدأ التلاوة من أي موضع...');
  // ONE ears at a time: the in-browser Quran model if chosen, else the
  // Whisper server if it is up, else the browser recogniser
  if (earsPref() === 'quran' && lwSupported()) { localStart(); return; }
  if (useServer) { S.ears = 'server'; serverStart(); return; }
  S.ears = 'browser';
  browserStart(SR);
}

function browserStart(SR) {
  if (!S.rec) {
    var rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'ar-SA';
    rec.maxAlternatives = 1;
    // (Chrome 154's `quality` is left at its default: the version that worked
    //  on the reader's machine never set it)
    rec.onstart = function () {
      S.running = true; S.finalIdx = 0; S.lastFinal = []; // indexes restart per session
      try { hideMicDisconnectedWarning(); } catch (e) {}
      try { updateVoiceReciteUI(true); } catch (e) {}
      evlog('start');
      if (!HEAR.words && !HEAR.offered && !S.noSpeech) lwPanel('🎙️ الميكروفون يعمل' + (MIC.label ? ': ' + MIC.label : '') + ' — ابدأ التلاوة');
    };
    rec.onspeechstart = function () { evlog('speechstart'); hearSpeechStart(); };
    rec.onaudiostart = function () { evlog('audiostart'); };
    rec.onsoundstart = function () { evlog('soundstart'); };
    rec.onresult = onSpeechResult;
    rec.onerror = function (e) {
      var err = e && e.error;
      evlog('error', err);
      if (err === 'no-speech') {   // say it instead of silently restarting
        S.noSpeech = (S.noSpeech || 0) + 1;
        if (!HEAR.words) lwPanel('⚠️ Chrome لم يسمع كلامًا (no-speech ×' + S.noSpeech + '). اقترب من الميكروفون، أو اضغط 🩺 لتسجيل تشخيص.');
        return;
      }
      if (err === 'aborted') {
        var now = Date.now();
        S.aborts = (S.aborts || []).filter(function (t) { return now - t < 6000; });
        S.aborts.push(now);
        if (S.aborts.length >= 3) {
          S.backoff = 3000;   // stop the ping-pong: wait before restarting
          lwPanel('⚠️ التعرف الصوتي يُقطع باستمرار: تبويب آخر في Chrome يستخدم التعرف الصوتي (ربما نسخة أخرى من التطبيق). أغلق التبويبات الأخرى ثم أعد التشغيل.');
        }
        return;
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        try { showMicDisconnectedWarning('not-allowed'); } catch (x) {}
        stopVoiceRecitation();
      } else if (err === 'network') {
        try { showMicDisconnectedWarning('network'); } catch (x) {}
        lwPanel('⚠️ التعرف الصوتي للمتصفح يحتاج اتصالًا بالإنترنت (خوادم Google). النموذج القرآني 🧠 يعمل دون إنترنت.');
      } else if (err === 'audio-capture') {
        lwPanel('⚠️ لم يُعثر على ميكروفون. تأكد من توصيله ومن اختياره في إعدادات المتصفح.');
      } else if (err === 'language-not-supported') {
        lwPanel('⚠️ المتصفح لا يدعم التعرف على العربية هنا. اضغط 🧠 لتفعيل النموذج القرآني.');
      } else if (err) {
        lwPanel('⚠️ خطأ في التعرف الصوتي: ' + err);
      }
    };
    rec.onend = function () {
      evlog('end');
      S.running = false;
      if (!S.active) { try { updateVoiceReciteUI(false); } catch (x) {} return; }
      clearTimeout(S.restartT);
      var wait = S.backoff || 250; S.backoff = 0;
      S.restartT = setTimeout(function () {
        if (S.active && !S.running && S.ears === 'browser') {
          try { S.rec.start(); } catch (err) {
            if (err && err.name !== 'InvalidStateError') { try { showMicDisconnectedWarning('disconnect'); } catch (x) {} }
          }
        }
      }, wait);
    };
    S.rec = rec;
  }
  try { S.rec.start(); }
  catch (e) {
    if (e && e.name === 'NotAllowedError') { try { showMicDisconnectedWarning('not-allowed'); } catch (x) {} }
    else if (!e || e.name !== 'InvalidStateError') { try { showMicDisconnectedWarning('disconnect'); } catch (x) {} }
  }
}

function stopVoiceRecitation() {
  S.active = false;
  sv('isVoiceReciteActive', false);
  clearTimeout(S.restartT);
  try { if (S.rec) S.rec.stop(); } catch (e) {}
  serverStop();
  lwStopCapture();
  micMonitorStop();
  clearTimeout(MIC.lazyT);
  evlogStop();
  try { updateVoiceReciteUI(false); } catch (e) {}
}

function toggleVoiceRecitation() {
  if (S.active) stopVoiceRecitation(); else startVoiceRecitation();
}

/* ---------- server ears (server/recite_server.py, Whisper) ---------- */
var SV = { rec: null, timer: null, stream: null, chunks: [] };
function serverProbe() {
  if (typeof fetch === 'undefined' || !HAS_DOM) return;
  var base = (location.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(location.hostname))
    ? location.origin : 'http://127.0.0.1:8001';
  fetch(base + '/health').then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.ok) {
      CFG.whisper.enabled = true;
      CFG.whisper.endpoint = base + '/recite-chunk';
      try { console.info('[recite] Whisper server:', base, 'model:', j.model); } catch (e) {}
      try { showToast('مخدم التسميع الدقيق متصل — سيُستخدم بدل التعرف الصوتي للمتصفح'); } catch (e) {}
    }
  }).catch(function () {});
}
function serverStart() {
  if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') { browserStart(G.SpeechRecognition || G.webkitSpeechRecognition); return; }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    SV.stream = stream;
    var mk = function () {
      var r;
      try { r = new MediaRecorder(stream, { mimeType: 'audio/webm' }); } catch (e) { r = new MediaRecorder(stream); }
      r.ondataavailable = function (ev) { if (ev.data && ev.data.size) SV.chunks.push(ev.data); };
      r.onstop = function () {     // take the batch only here (stop flushes async)
        var batch = SV.chunks; SV.chunks = [];
        if (batch.length) serverSend(batch);
        if (S.active && S.ears === 'server') { SV.rec = mk(); SV.rec.start(); }
      };
      return r;
    };
    SV.rec = mk(); SV.rec.start();
    SV.timer = setInterval(function () {
      if (SV.rec && SV.rec.state === 'recording') SV.rec.stop();
    }, Math.max(2, CFG.whisper.chunkSeconds) * 1000);
    try { updateVoiceReciteUI(true); } catch (e) {}
  }).catch(function () { try { showMicDisconnectedWarning('not-allowed'); } catch (e) {} });
}
var SEND_Q = Promise.resolve();
function serverSend(batch) {
  var blob = new Blob(batch, { type: 'audio/webm' });
  var fd = new FormData();
  fd.append('audio', blob, 'chunk.webm');
  fd.append('lang', CFG.whisper.lang);
  // serialise: chunks must reach the tracker in recording order
  SEND_Q = SEND_Q.then(function () {
    return fetch(CFG.whisper.endpoint, { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.text && S.active) commitWords(tokenize(j.text)); })
      .catch(function () {});
  });
}
function serverStop() {
  clearInterval(SV.timer); SV.timer = null;
  try { if (SV.rec && SV.rec.state === 'recording') SV.rec.stop(); } catch (e) {}
  SV.rec = null;
  try { if (SV.stream) SV.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  SV.stream = null;
}

/* ---------- local ears: Quran Whisper running in the browser ----------
 * assets/js/whisper-worker.js runs tarteel-ai/whisper-base-ar-quran
 * (ONNX) with the vendored transformers.js. This side captures the mic at
 * 16 kHz and streams it:
 *   - voice-activity segmentation: a segment ends at a pause (waqf) of
 *     END_SILENCE_MS, or is cut at MAX_SEG_S;
 *   - while a segment grows it is re-transcribed every INTERIM_MS. Words that
 *     two consecutive passes agree on ("local agreement") are committed to the
 *     tracker; the rest is shown as tentative (peek);
 *   - at the pause the whole segment is transcribed once more and whatever
 *     was not committed yet is committed.
 * Requests are strictly sequential (one model call at a time); a segment's
 * final pass is queued and never dropped, interim passes are skipped when busy.
 */
var LW_CFG = {
  BLOCK: 1600,            // 100 ms at 16 kHz
  PREROLL_BLOCKS: 3,      // audio kept from before speech onset
  END_SILENCE_MS: 650,    // pause that closes a segment
  INTERIM_MS: 700,        // re-transcribe a growing segment this often (never overlaps: busy-gated)
  MIN_INTERIM_S: 0.7,     // first tentative words after this much speech
  MAX_SEG_S: 12,          // each pass re-decodes the whole segment: keep it short
  FINAL_SKIP_BLOCKS: 4,   // last interim covered all but <=0.4 s: commit it, skip the final pass
  SPEECH_RATIO: 3.0,      // speech = RMS above noise floor x this
  MIN_RMS: 0.004
};
var LW = { worker: null, ready: false, loading: false, device: '', dtype: '',
  ctx: null, stream: null, src: null, node: null, rate: 16000, frac: 0,
  block: new Float32Array(1600), fill: 0, floor: 0.002,
  voiced: false, seg: [], preroll: [], silenceMs: 0, segId: 0, segs: {},
  lastInterimAt: 0, busy: false, queue: [], reqId: 0, pending: {}, afterReady: null };

var ENGINE_SRC = (HAS_DOM && document.currentScript && document.currentScript.src) || 'assets/js/recite-by-mic.js';

function earsPref() {
  try {
    if (localStorage.getItem('recite_ears_v') !== '2') {
      localStorage.setItem('recite_ears_v', '2');
      localStorage.setItem('recite_ears', 'browser');
    }
    return localStorage.getItem('recite_ears') || 'browser';
  } catch (e) { return 'browser'; }
}
function lwSupported() {
  return HAS_DOM && typeof Worker !== 'undefined' && location.protocol !== 'file:' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    !!(G.AudioContext || G.webkitAudioContext);
}
function lwStatus(text) {
  var el = HAS_DOM && document.getElementById('dockSpeechText');
  if (el) el.textContent = text;
  setStatus(text);
}
function lwButton() {
  var b = HAS_DOM && document.getElementById('dockEarsBtn');
  if (!b) return;
  var on = earsPref() === 'quran';
  b.classList.toggle('on', on);
  b.classList.toggle('loading', LW.loading);
  b.title = on ? '🧠 النموذج القرآني التجريبي مفعّل — اضغط لإيقافه والعودة إلى تعرّف Chrome'
               : 'تجريبي: النموذج القرآني داخل المتصفح (قد لا يفهم كل الأصوات؛ تعرّف Chrome هو الافتراضي)';
}

function lwLoad(done) {
  if (LW.ready) { if (done) done(); return; }
  LW.afterReady = done || LW.afterReady;
  if (LW.loading) return;
  LW.loading = true; lwButton();
  try {
    LW.worker = new Worker(new URL('whisper-worker.js', ENGINE_SRC), { type: 'module' });
  } catch (e) {
    LW.loading = false; lwButton();
    try { showToast('تعذّر تشغيل النموذج القرآني في هذا المتصفح'); } catch (x) {}
    return;
  }
  LW.worker.onmessage = lwOnMessage;
  LW.worker.onerror = function (e) {
    LW.loading = false; lwButton();
    lwStatus('تعذّر تحميل النموذج القرآني: ' + ((e && e.message) || ''));
  };
  lwStatus('جاري تحميل النموذج القرآني...');
  var force = null; // 'cpu' | 'hybrid' to override the automatic choice (debugging)
  try { force = localStorage.getItem('recite_whisper_force'); } catch (e) {}
  LW.worker.postMessage({ type: 'load', force: force });
}

function lwOnMessage(ev) {
  var m = ev.data || {};
  if (m.type === 'progress') {
    var mb = function (x) { return Math.round(x / 1e6); };
    var pct = m.total ? Math.floor(100 * m.loaded / m.total) : 0;
    lwStatus('تحميل النموذج القرآني (مرة واحدة فقط)... ' + pct + '% (' + mb(m.loaded) + ' / ' + mb(m.total) + ' MB)');
  } else if (m.type === 'ready') {
    LW.ready = true; LW.loading = false; LW.device = m.device; LW.dtype = m.dtype; lwButton();
    try { localStorage.setItem('recite_model_ok', '1'); } catch (e) {}
    try { showToast('النموذج القرآني جاهز (' + (m.device === 'cpu' ? 'المعالج' : 'كرت الشاشة + المعالج') + ')'); } catch (e) {}
    lwStatus('النموذج القرآني جاهز — تابع التلاوة');
    var f = LW.afterReady; LW.afterReady = null;
    if (f) f();
  } else if (m.type === 'warn') {
    try { console.warn('[recite] ' + m.message); } catch (e) {}
  } else if (m.type === 'result') {
    lwOnResult(m);
  } else if (m.type === 'error') {
    LW.busy = false;
    if (!LW.ready) {
      LW.loading = false; lwButton();
      lwStatus('تعذّر تحميل النموذج القرآني: ' + m.message);
      try { showToast('تعذّر تحميل النموذج القرآني — سيُستخدم التعرف العام'); } catch (e) {}
    }
    delete LW.pending[m.id];
    lwPump();
  }
}

/* ---- capture ---- */
function lwStartCapture() {
  lwResetSegments();
  if (CFG.testNoCapture) return; // tests push audio with ReciteByMic._lwFeed
  navigator.mediaDevices.getUserMedia(micConstraints({ channelCount: 1, echoCancellation: false,
    noiseSuppression: false, autoGainControl: true })).then(function (stream) {
    if (!S.active || S.ears !== 'local') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    LW.stream = stream;
    var AC = G.AudioContext || G.webkitAudioContext;
    try { LW.ctx = new AC({ sampleRate: 16000 }); } catch (e) { LW.ctx = new AC(); }
    LW.rate = LW.ctx.sampleRate; LW.frac = 0;
    try { LW.src = LW.ctx.createMediaStreamSource(stream); }
    catch (e) { // e.g. Firefox refuses a 16 kHz context for a 48 kHz mic: resample ourselves
      try { LW.ctx.close(); } catch (x) {}
      LW.ctx = new AC(); LW.rate = LW.ctx.sampleRate;
      LW.src = LW.ctx.createMediaStreamSource(stream);
    }
    var sink = LW.ctx.createGain(); sink.gain.value = 0; sink.connect(LW.ctx.destination);
    var code = "class T extends AudioWorkletProcessor{process(i){var c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('lw-tap',T)";
    if (LW.ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      LW.ctx.audioWorklet.addModule(url).then(function () {
        LW.node = new AudioWorkletNode(LW.ctx, 'lw-tap');
        LW.node.port.onmessage = function (e) { lwFeed(e.data); };
        LW.src.connect(LW.node); LW.node.connect(sink);
      });
    } else {
      LW.node = LW.ctx.createScriptProcessor(2048, 1, 1);
      LW.node.onaudioprocess = function (e) { lwFeed(e.inputBuffer.getChannelData(0).slice(0)); };
      LW.src.connect(LW.node); LW.node.connect(sink);
    }
    try { updateVoiceReciteUI(true); } catch (e) {}
    lwStatus('🎙️ النموذج القرآني يستمع... ابدأ التلاوة');
  }).catch(function () { try { showMicDisconnectedWarning('not-allowed'); } catch (e) {} });
}

function lwStopCapture() {
  try { if (LW.node) LW.node.disconnect(); } catch (e) {}
  try { if (LW.src) LW.src.disconnect(); } catch (e) {}
  try { if (LW.stream) LW.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  try { if (LW.ctx) LW.ctx.close(); } catch (e) {}
  LW.node = LW.src = LW.stream = LW.ctx = null;
  if (LW.voiced) lwEndSegment();          // finish what was said before the stop
  lwWave(false);
}

function lwResetSegments() {
  LW.fill = 0; LW.voiced = false; LW.seg = []; LW.preroll = []; LW.silenceMs = 0;
  LW.segs = {}; LW.queue = []; LW.floor = 0.002;
}

/* samples at LW.rate -> 16 kHz blocks of 100 ms */
function lwFeed(x) {
  var step = LW.rate / 16000;
  if (step === 1) { for (var i = 0; i < x.length; i++) lwPush(x[i]); return; }
  for (var t = LW.frac; t < x.length; t += step) lwPush(x[Math.floor(t)]); // decimate (mic is band-limited by AGC/NS)
  LW.frac = t - x.length;
}
function lwPush(v) {
  LW.block[LW.fill++] = v;
  if (LW.fill === LW_CFG.BLOCK) { LW.fill = 0; lwBlock(LW.block.slice(0)); }
}

function lwWave(on) {
  if (MIC.an) return; // the live level meter drives the bars
  var w = HAS_DOM && document.getElementById('dockAudioWave');
  if (w) w.classList.toggle('active', !!on);
}

function lwBlock(b) {
  var e = 0;
  for (var i = 0; i < b.length; i++) e += b[i] * b[i];
  var rms = Math.sqrt(e / b.length);
  var speech = rms > Math.max(LW_CFG.MIN_RMS, LW.floor * LW_CFG.SPEECH_RATIO);
  if (!LW.voiced) {
    if (!speech) LW.floor = 0.95 * LW.floor + 0.05 * Math.max(0.0005, rms); // track the room noise
    LW.preroll.push(b);
    if (LW.preroll.length > LW_CFG.PREROLL_BLOCKS) LW.preroll.shift();
    if (speech) {
      LW.voiced = true; LW.silenceMs = 0; LW.seg = LW.preroll.slice(); LW.preroll = [];
      LW.segId++; LW.segs[LW.segId] = { committed: 0, lastHyp: [] };
      LW.lastInterimAt = Date.now(); lwWave(true);
      if (!S.heard.length) lwPanel('🔊 أسمعك... النموذج القرآني يكتب الكلمات');
    }
    return;
  }
  LW.seg.push(b);
  LW.silenceMs = speech ? 0 : LW.silenceMs + 100;
  var dur = LW.seg.length * 0.1;
  if (LW.silenceMs >= LW_CFG.END_SILENCE_MS || dur >= LW_CFG.MAX_SEG_S) {
    var cut = dur >= LW_CFG.MAX_SEG_S && LW.silenceMs < LW_CFG.END_SILENCE_MS;
    lwEndSegment();
    if (cut) { // no pause yet: keep listening in a fresh segment
      LW.voiced = true; LW.segId++; LW.segs[LW.segId] = { committed: 0, lastHyp: [] };
      LW.lastInterimAt = Date.now(); lwWave(true);
    }
  } else if (!LW.busy && !LW.queue.length && dur >= LW_CFG.MIN_INTERIM_S &&
             Date.now() - LW.lastInterimAt >= LW_CFG.INTERIM_MS) {
    LW.lastInterimAt = Date.now();
    lwSend('interim', LW.segId, lwConcat(LW.seg, 0), LW.seg.length);
  }
}

function lwConcat(blocks, dropTailBlocks) {
  var n = Math.max(1, blocks.length - dropTailBlocks), out = new Float32Array(n * LW_CFG.BLOCK);
  for (var i = 0; i < n; i++) out.set(blocks[i], i * LW_CFG.BLOCK);
  return out;
}

function lwEndSegment() {
  var tail = Math.max(0, Math.floor(LW.silenceMs / 100) - 2); // keep 200 ms of the pause
  var st = LW.segs[LW.segId], speechBlocks = LW.seg.length - Math.floor(LW.silenceMs / 100);
  if (st && st.lastHyp.length && st.covered >= speechBlocks - LW_CFG.FINAL_SKIP_BLOCKS) {
    // the last interim pass already heard (almost) all of it: commit it now
    // instead of spending another model call (the queue is the latency)
    if (st.lastHyp.length > st.committed && S.active && S.ears === 'local') commitWords(st.lastHyp.slice(st.committed), (st.lastRaw || st.lastHyp).slice(st.committed));
    delete LW.segs[LW.segId];
  } else if (LW.seg.length - tail >= 3) LW.queue.push({ segId: LW.segId, audio: lwConcat(LW.seg, tail) });
  else delete LW.segs[LW.segId];
  LW.voiced = false; LW.seg = []; LW.preroll = []; LW.silenceMs = 0; lwWave(false);
  lwPump();
}

function lwSend(kind, segId, audio, blocks) {
  if (!LW.worker || !LW.ready) return;
  var id = ++LW.reqId;
  LW.pending[id] = { kind: kind, segId: segId, blocks: blocks || 0 };
  LW.busy = true;
  LW.worker.postMessage({ type: 'transcribe', id: id, audio: audio }, [audio.buffer]);
}
function lwPump() {
  if (LW.busy || !LW.queue.length) return;
  var q = LW.queue.shift();
  lwSend('final', q.segId, q.audio);
}

function lcpLen(a, b) {
  var n = Math.min(a.length, b.length), i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function lwOnResult(m) {
  LW.busy = false;
  var req = LW.pending[m.id]; delete LW.pending[m.id];
  LW.lastMs = m.ms;
  (LW.msLog = LW.msLog || []).push(m.ms); if (LW.msLog.length > 300) LW.msLog.shift();
  if (req && S.active && S.ears === 'local') {
    var st = LW.segs[req.segId];
    var words = tokenize(m.text);
    var raw = rawFor(words, rawSplit(m.text));
    if (st && req.kind === 'interim') {
      if (req.segId === LW.segId && LW.voiced) {
        var agreed = lcpLen(words, st.lastHyp);
        if (agreed > st.committed) { commitWords(words.slice(st.committed, agreed), raw.slice(st.committed, agreed)); st.committed = agreed; }
        st.lastHyp = words; st.lastRaw = raw; st.covered = req.blocks;
        tentativeWords(words.slice(st.committed), raw.slice(st.committed));
      }
    } else if (st && req.kind === 'final') {
      if (words.length > st.committed) commitWords(words.slice(st.committed), raw.slice(st.committed));
      delete LW.segs[req.segId];
    }
  }
  lwPump();
}

function localStart() {
  S.ears = 'local';
  if (LW.ready) { lwStartCapture(); return; }
  // the browser recogniser keeps you followed while the model downloads
  var SR = G.SpeechRecognition || G.webkitSpeechRecognition;
  if (SR) { S.ears = 'browser'; browserStart(SR); }
  lwLoad(function () {
    if (!S.active || earsPref() !== 'quran') return;
    switchEars('local');
  });
}

/* stop the current ears and start `to` without ending the session */
function switchEars(to) {
  if (S.ears === to) return;
  if (S.ears === 'browser') { S.ears = to; try { if (S.rec) S.rec.stop(); } catch (e) {} }
  else if (S.ears === 'local') { lwStopCapture(); S.ears = to; }
  else if (S.ears === 'server') { serverStop(); S.ears = to; }
  if (to === 'local') lwStartCapture();
  else if (to === 'browser') browserStart(G.SpeechRecognition || G.webkitSpeechRecognition);
}

function setEars(pref) {
  try { localStorage.setItem('recite_ears', pref); } catch (e) {}
  lwButton();
  if (pref === 'quran') {
    if (!S.active) { lwLoad(null); return; } // preload now, used at the next start
    if (LW.ready) switchEars('local'); else localStart();
  } else if (S.active && S.ears === 'local') {
    switchEars('browser');
  }
}

function onEarsButton() {
  if (earsPref() === 'quran') { setEars('browser'); lwPanel('🎧 عاد التسميع إلى تعرّف Chrome — تابع التلاوة'); try { showToast('🧠 أُوقف — التعرف الآن عبر Chrome'); } catch (e) {} return; }
  if (!lwSupported()) {
    try { showToast(location.protocol === 'file:' ? 'افتح التطبيق عبر الخادم المحلي (http://127.0.0.1:8001) لتفعيل النموذج القرآني'
                                                  : 'المتصفح لا يدعم تشغيل النموذج القرآني'); } catch (e) {}
    return;
  }
  var known = false;
  try { known = localStorage.getItem('recite_model_ok') === '1'; } catch (e) {}
  if (!known && !G.confirm('ميزة تجريبية: النموذج القرآني داخل المتصفح (حوالي 100–120 ميغابايت تُحمَّل مرة واحدة). مدرَّب على تلاوات القرّاء المحترفين وقد لا يفهم صوتك جيدًا؛ تعرّف Chrome يبقى الافتراضي. متابعة؟')) return;
  setEars('quran');
}

/* ---------- 🩺 diagnostic recording ----------
 * Records 8 s from the default microphone (Chrome's normal processing, like
 * the recogniser) while a FRESH Chrome recogniser listens, then saves the WAV
 * and the full event log through the local server (_debug/rec_*.wav/json) so
 * the real voice can be analysed offline. */
function diagRun() {
  if (!HAS_DOM || !navigator.mediaDevices) return;
  if (S.active) stopVoiceRecitation();
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var log = { stamp: stamp, ua: navigator.userAgent, events: [], level: {} };
  var t0 = Date.now(), DUR = 8000;
  var ev = function (x) { log.events.push([Date.now() - t0, x]); };
  try { openVoiceDock(); } catch (e) {}
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    var tr = stream.getAudioTracks()[0];
    log.track = { label: tr.label, settings: tr.getSettings() };
    var AC = G.AudioContext || G.webkitAudioContext, ctx = new AC();
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1), chunks = [], peak = 0, sum = 0, n = 0;
    proc.onaudioprocess = function (e) {
      var d = e.inputBuffer.getChannelData(0), c = new Float32Array(d), en = 0;
      for (var i = 0; i < c.length; i++) en += c[i] * c[i];
      var rms = Math.sqrt(en / c.length); peak = Math.max(peak, rms); sum += rms; n++;
      chunks.push(c);
      var w = document.getElementById('dockAudioWave');
      if (w) for (var b = 0; b < w.children.length; b++) { w.children[b].style.animation = 'none'; w.children[b].style.height = (4 + Math.min(20, rms * 300)) + 'px'; }
    };
    var sink = ctx.createGain(); sink.gain.value = 0;
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    // a fresh recogniser, every event logged
    var R = G.SpeechRecognition || G.webkitSpeechRecognition, r = null;
    if (R) {
      r = new R(); r.lang = 'ar-SA'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      try { if ('quality' in r) { r.quality = 'dictation'; log.quality = r.quality; } } catch (e) {}
      ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'end', 'nomatch'].forEach(function (k) {
        r.addEventListener(k, function () { ev(k); });
      });
      r.onerror = function (e) { ev('error:' + e.error + (e.message ? ' ' + e.message : '')); };
      r.onresult = function (e) {
        for (var i = e.resultIndex; i < e.results.length; i++) ev((e.results[i].isFinal ? 'FINAL ' : 'interim ') + e.results[i][0].transcript);
      };
      try { r.start(); } catch (e) { ev('start-threw:' + e.name); }
    } else ev('no SpeechRecognition');
    var left = DUR / 1000;
    lwPanel('🩺 اقرأ آية الآن بصوت واضح... ' + left);
    var iv = setInterval(function () { left--; if (left > 0) lwPanel('🩺 اقرأ آية الآن بصوت واضح... ' + left); }, 1000);
    setTimeout(function () {
      clearInterval(iv);
      try { if (r) r.stop(); } catch (e) {}
      setTimeout(function () {   // let the last results arrive
        proc.disconnect(); stream.getTracks().forEach(function (x) { x.stop(); });
        log.level = { meanRms: +(sum / Math.max(1, n)).toFixed(5), peakRms: +peak.toFixed(5), sampleRate: ctx.sampleRate };
        var wav = encodeWav(chunks, ctx.sampleRate); ctx.close();
        var heard = log.events.filter(function (x) { return /^FINAL|^interim/.test(x[1]); }).map(function (x) { return x[1]; });
        var save = function (kind, body, type) {
          return fetch('/debug-save?kind=' + kind + '&stamp=' + stamp, { method: 'POST', headers: { 'Content-Type': type }, body: body })
            .then(function (x) { return x.json(); });
        };
        save('wav', wav, 'audio/wav').then(function () { return save('json', JSON.stringify(log, null, 1), 'application/json'); })
          .then(function () {
            lwPanel('🩺 حُفظ التسجيل (_debug/rec_' + stamp + '). مستوى الصوت الأعلى: ' + log.level.peakRms +
              ' — ما سمعه Chrome: ' + (heard.length ? '«' + heard[heard.length - 1].replace(/^(FINAL|interim) /, '') + '»' : 'لا شيء') +
              ' — الأحداث: ' + log.events.map(function (x) { return x[1].split(' ')[0]; }).join(', '));
          })
          .catch(function () { lwPanel('🩺 تعذّر الحفظ: افتح التطبيق عبر الخادم المحلي (Open Mushaf.cmd)'); });
      }, 1500);
    }, DUR);
  }).catch(function (e) { lwPanel('🩺 تعذّر فتح الميكروفون: ' + (e && e.name)); });
}

function encodeWav(chunks, rate) {
  var n = 0; chunks.forEach(function (c) { n += c.length; });
  var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), o = 0;
  var str = function (s) { for (var i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
  str('RIFF'); v.setUint32(o, 36 + n * 2, true); o += 4; str('WAVE'); str('fmt ');
  v.setUint32(o, 16, true); o += 4; v.setUint16(o, 1, true); o += 2; v.setUint16(o, 1, true); o += 2;
  v.setUint32(o, rate, true); o += 4; v.setUint32(o, rate * 2, true); o += 4; v.setUint16(o, 2, true); o += 2;
  v.setUint16(o, 16, true); o += 2; str('data'); v.setUint32(o, n * 2, true); o += 4;
  chunks.forEach(function (c) { for (var i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 32767, true); });
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------- one-shot API (simulator, voice search) ---------- */
function oneShot(text, priorAyahs) {
  buildVoiceRecitationIndex();
  if (!TRACKER) return null;
  var toks = tokenize(text);
  if (!toks.length) return null;
  // a typed query is a SEARCH: jumping anywhere is the point, so teleport is
  // cheap here (live following keeps the small value)
  var keep = CFG.TELEPORT;
  CFG.TELEPORT = 0.5; logs();
  try {
    var t = new Tracker(CORPUS);
    t.setPrior(priorAyahs, 1);
    t.push(toks);
    t.flush(); // the query ends here: release words held by the opener filter
    return t.result();
  } finally { CFG.TELEPORT = keep; logs(); }
}

function simulateVoiceRecitation(text) {
  if (!text) return null;
  buildVoiceRecitationIndex();
  if (!CORPUS) return null;
  try { if (typeof openVoiceDock === 'function') openVoiceDock(); } catch (e) {}
  var res = oneShot(text, ayahsOnPages(visiblePages()));
  var toks = tokenize(text);
  if (!res || res.lost || res.conf < CFG.SHOW_CONF) {
    var ds = HAS_DOM && document.getElementById('dockSpeechText');
    if (ds) ds.textContent = 'لم يتم العثور على موضع مطابق لـ "' + text + '"';
    return null;
  }
  UI.lastPos = -1; UI.lastAyah = -1; UI.lastWord = -2; UI.pendingPage = -1;
  var keep = CFG.TURN_CONF; CFG.TURN_CONF = 0; // a typed query turns the page at once
  var d;
  try { d = decide(res, false); } finally { CFG.TURN_CONF = keep; }
  if (HAS_DOM) paint(d, toks);
  return { bestIdx: res.ayahIdx, score: res.conf, confidence: Math.round(res.conf * 100),
    sura: res.ayah.sura, aya: res.ayah.aya, page: res.ayah.page, suraName: res.ayah.suraName,
    wordIdx: res.wordIdx };
}

/* compat: old signature, returns old result shape */
function matchRecitedSpeech(text, anchorIdx) {
  buildVoiceRecitationIndex();
  if (!CORPUS) return null;
  var res = oneShot(text, [Math.max(0, anchorIdx | 0)]);
  if (!res || res.lost || res.conf < CFG.SHOW_CONF) return null;
  return { bestIdx: res.ayahIdx, bestAyah: res.ayah, activeWordIdx: res.basmala ? -1 : res.wordIdx,
    score: res.conf, baseScore: res.conf, confidence: Math.round(res.conf * 100),
    isJump: Math.abs(res.ayahIdx - anchorIdx) > 3 };
}

function initVoiceRecitation() {
  serverProbe();
  try { console.info('[recite] engine v' + RECITE_VERSION); } catch (e) {}
  if (!HAS_DOM) return;
  function on(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  on('voiceReciteToggleBtn', 'click', toggleVoiceRecitation);
  on('floatingMicLauncher', 'click', function () {
    try { openVoiceDock(); } catch (e) {}
    if (!S.active) startVoiceRecitation();
  });
  on('dockMainToggleBtn', 'click', toggleVoiceRecitation);
  on('dockMinimizeBtn', 'click', function () { try { minimizeVoiceDock(); } catch (e) {} });
  on('dockToggleSimBtn', 'click', function () { try { toggleDockSim(); } catch (e) {} });
  on('dockEarsBtn', 'click', onEarsButton);
  on('dockDiagBtn', 'click', diagRun);
  lwButton();
  // chosen before and already downloaded: warm the model up in the background
  try { if (earsPref() === 'quran' && localStorage.getItem('recite_model_ok') === '1' && lwSupported()) lwLoad(null); } catch (e) {}
  var sim = function () {
    var inp = document.getElementById('dockSimInput');
    var v = inp ? inp.value.trim() : '';
    if (v) simulateVoiceRecitation(v);
  };
  on('dockSimSubmitBtn', 'click', sim);
  on('dockSimInput', 'keydown', function (e) { if (e.key === 'Enter') sim(); });
  try {
    document.querySelectorAll('.dock-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var p = chip.dataset.phrase;
        if (!p) return;
        var inp = document.getElementById('dockSimInput');
        if (inp) inp.value = p;
        simulateVoiceRecitation(p);
      });
    });
  } catch (e) {}
  var openTafsir = function () {
    try {
      var a = CORPUS && CORPUS.ayahs[gv('currentVoiceAnchorIdx', -1)];
      if (a) openAyahTafsir(a.sura, a.aya);
    } catch (e) {}
  };
  on('dockOpenTafsirBtn', 'click', openTafsir);
  on('voiceOpenTafsirBtn', 'click', openTafsir);
  on('dockAllowMicBtn', 'click', function () { try { requestMicPermissionAndReconnect(); } catch (e) {} });
  on('dockDismissAlertBtn', 'click', function () { try { hideMicDisconnectedWarning(); } catch (e) {} });
  on('voiceHudStopBtn', 'click', stopVoiceRecitation);
  on('voiceTestSimBtn', 'click', function () { try { toggleVoiceSimDrawer(); } catch (e) {} });
  on('simCloseBtn', 'click', function () { try { closeVoiceSimDrawer(); } catch (e) {} });
}

/* ------------------------------ exports ------------------------------- */
var API = {
  version: RECITE_VERSION, config: CFG, relog: logs,
  normalize: normalizeArabic, tokenize: tokenize, wordSim: wordSim, levenshtein: lev,
  buildCorpus: buildCorpus, Tracker: Tracker, openerState: openerState, openerPush: openerPush,
  // live-path hooks (tests drive these with fake SpeechRecognition events)
  _onSpeechResult: onSpeechResult, _session: S, _lw: LW, _lwCfg: LW_CFG, setEars: setEars,
  _mic: MIC, diag: diagRun,
  _lwFeed: function (f32) { LW.rate = 16000; lwFeed(f32); }, _ui: UI, _decide: decide, lastShown: null,
  buildIndex: buildVoiceRecitationIndex, match: matchRecitedSpeech,
  simulate: simulateVoiceRecitation, start: startVoiceRecitation,
  stop: stopVoiceRecitation, toggle: toggleVoiceRecitation,
  corpus: function () { return CORPUS; }, tracker: function () { return TRACKER; }
};
G.ReciteByMic = API;
G.normalizeArabic = normalizeArabic;
G.buildVoiceRecitationIndex = buildVoiceRecitationIndex;
G.matchRecitedSpeech = matchRecitedSpeech;
G.startVoiceRecitation = startVoiceRecitation;
G.stopVoiceRecitation = stopVoiceRecitation;
G.toggleVoiceRecitation = toggleVoiceRecitation;
G.initVoiceRecitation = initVoiceRecitation;
G.simulateVoiceRecitation = simulateVoiceRecitation;
G.setVoiceAnchor = function (idx) {
  buildVoiceRecitationIndex();
  if (TRACKER) { TRACKER.reset(); TRACKER.setPrior([idx], 1); }
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
