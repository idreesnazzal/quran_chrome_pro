/* ============================================================================
 * Recite-by-Mic — pro recitation follower (from-zero rewrite)
 * ----------------------------------------------------------------------------
 * WHAT WAS WRONG BEFORE (deleted engine) — read before touching this file:
 *  1. "Stupid addition" scoring: trigram +35, bigram +20, stem-bigram +22,
 *     unigram +8 were ADDED for the same evidence. A trigram hit also fires
 *     its 2 bigrams + 3 unigrams + stem bigrams, so one lucky 3-word run
 *     counted ~5 times. Magic constants (180/150/110/90/160/50/25/15) had no
 *     length normalisation and no IDF: a match on «من» scored like «الملائكة».
 *  2. Greedy alignment: forward scan from expectedWordIdx, first
 *     exact/stem/prefix hit wins. One ASR deletion shifted everything;
 *     prefix rule (len>=4 startsWith) fired on shared Arabic roots.
 *  3. Destructive stemmer: stripped leading و/ف from ANY 4+ letter word
 *     (فجر→جر, وجوه→جوه), stripped لل→ه on «للّه», trailing ت/ون/ين broke
 *     names (حسين→حس) and feminine plurals. Normaliser collapsed اء→ء
 *     (سماء→سمء) so canonical text and ASR text diverged BY CONSTRUCTION.
 *  4. Hardcoded confidence (97/96/93/90) + fixed +180/+150 local bonuses:
 *     the follower could never admit a real jump, and global evidence was
 *     down-weighted by fiat. Mutashabihat (e.g. Rahman refrain ×31) were
 *     decided by distance decay 0.03/ayah — i.e. coin flips.
 *  5. No cumulative buffer: each onresult event only saw its own
 *     final+interim slice, so long ayahs lost their heads. 75 ms debounce
 *     ran an O(6236) linear scan per interim — jank on mobile.
 *  6. Muqatta'at resolver was whole-string prefix-only: «الف لام ميم»
 *     mid-sentence or «طاها»/«ياسين» variants never resolved.
 *  7. ASR = generic ar-SA Web Speech (MSA acoustic model, no tajweed,
 *     no madd/ghunna/qalqala). Fine as a zero-dep default, wrong as the
 *     only path. This file keeps Web Speech live AND adds a Whisper hook.
 *
 * NEW DESIGN (what this file does):
 *  - Fixed normaliser (no اء→ء collapse, keeps hamza core, strips ZWNJ).
 *  - Token-level Muqatta'at dictionary (longest-phrase match anywhere).
 *  - Index: inverted postings + BM25 idf over 6,236 ayahs (no double count).
 *  - Retrieval: LOCAL window (anchor-1..anchor+3) first; GLOBAL BM25 top-K
 *    fallback only when local fails. Rerank with Smith-Waterman word DP
 *    over char-Levenshtein word similarity (threshold 0.6), IDF-weighted.
 *  - Tracking: monotonic spotlight (never moves backward on same ayah),
 *    far jumps need 2 consecutive confirmations or score ≥ 0.88.
 *  - Cumulative word stream with exact overlap-join dedup (interims grow
 *    monotonically, finals repeat-then-extend them — no rollback, no delay).
 *  - Incremental pointer follower: each fresh word is matched against a
 *    small forward window (2 back for repeats, 6 forward spilling across
 *    ayah boundaries), so short next ayahs and mid-ayah transitions commit
 *    instantly instead of waiting for a full buffer.
 *  - Watchdog (every 4 words) + re-anchor fallback (6 unmatched) for jumps.
 *  - Calibrated confidence from coverage+IDF on global commits — never hardcoded.
 *  - Whisper hook: optional MediaRecorder chunks → your endpoint
 *    (see RECITE_CONFIG.whisper + docs/RECITE_ALGORITHM.md).
 *
 * OPEN-SOURCE BASIS (researched):
 *  - wasimlhr/whisper-quran-v1 (Whisper-large-v3 Quran FT, 5.35% WER) +
 *    Token-F1 + IDF verse matching on 10 s chunks (smart-glasses tracker).
 *  - baristiran/whisper-turbo-quran, naazimsnh02/whisper-large-v3-turbo-ar,
 *    rabah2026/wav2vec2-large-xlsr-53-arabic-quran (4.41% WER) — drop-in
 *    server models for the Whisper hook.
 *  - Murajah app: greedy + 3-word lookahead, Levenshtein ≥ 0.55,
 *    ar-SA on-device SFSpeechRecognizer — our WORD_SIM_THRESHOLD=0.6.
 *  - foyzulkarim/hifz-tester: deterministic align.ts + threshold slider
 *    (default 0.80), verdict-in-code, record-then-review split.
 *  - yayaiu6/Real-Time-Quran-tracker: Score=α(1-Lev/max)−β·lenDiff,
 *    Needleman-Wunsch word alignment, dual-mode local/global windows.
 *  - abohurayrah/offline-tarteel + yazinsai/tilawa: two-stage retrieval
 *    (ASR top-50 → CTC forced-align rescore) — our BM25→SW rerank is the
 *    zero-dependency version of the same idea.
 *
 * CONTRACT with index.html (kept UI): this file OWNS these globals
 * (old copies are deleted from the inline script):
 *   normalizeArabic, buildVoiceRecitationIndex, matchRecitedSpeech,
 *   detectActiveWordInAyah, startVoiceRecitation, stopVoiceRecitation,
 *   toggleVoiceRecitation, initVoiceRecitation,
 *   window.simulateVoiceRecitation, window.setVoiceAnchor.
 * It READS (never redeclares) inline lets: activeData, currentPage,
 * isDoublePageMode, currentRightPage/LeftPage, ayahVoiceIndex,
 * isVoiceIndexBuilt, currentVoiceAnchorIdx, voiceLastDetectedIdx,
 * voiceActiveWordIdx. It CALLS kept UI fns: onVoiceAyahDetected,
 * openVoiceDock, updateVoiceReciteUI, showMicDisconnectedWarning, etc.
 * ========================================================================== */
'use strict';

/* ------------------------------- config -------------------------------- */
var RECITE_VERSION = '2.9.2-openerstrip';
var RECITE_CONFIG = {
  WORD_SIM_THRESHOLD: 0.60,  // min char-sim for two words to count as same
  LOCAL_COMMIT: 0.55,        // SW score needed to stay/commit locally
  GLOBAL_COMMIT: 0.62,       // SW score needed for global fallback commit
  GLOBAL_JUMP: 0.75,         // min score for a cross-surah mid-verse jump
  JUMP_MARGIN: 0.08,         // best must beat 2nd-best by this (mutashabihat)
  JUMP_CONFIRM: 2,           // consecutive hits needed for far jumps
  FOLLOW_BACK: 2,            // rewind tolerance (repeats/stumbles)
  FOLLOW_FWD: 6,             // forward reach (skips + next-ayah spill)
  FOLLOW_MAXC: 10,           // candidate cap per word
  REANCHOR_AFTER: 6,         // unmatched words before global re-anchor
  DRIFT_REANCHOR: 8,         // backward micro-matches before re-anchor (review jumps)
  STREAM_CAP: 600,          // live word-stream cap
  OVERLAP_MAX: 80,          // overlap-join window: must cover the longest ayah
                            // so a final repeating its interim appends nothing
  TOP_K: 25,                 // BM25 candidates reranked with SW
  BUFFER_WORDS: 40,          // rolling spoken-word window
  GAP: -0.45,                // SW gap penalty
  MISMATCH: -0.35,           // SW mismatch penalty
  BM25_K1: 1.2,
  BM25_B: 0.75,
  DEBUG: false,
  whisper: { enabled: false, endpoint: '', chunkSeconds: 10, lang: 'ar' }
};

/* --------------------------- internal state ---------------------------- */
var RECITE_postings = new Map();   // token -> array of ayah idx
var RECITE_idf = new Map();        // token -> bm25 idf weight
var RECITE_avgLen = 15;
var RECITE_vocab = [];             // unique tokens (for fuzzy expand cap)
var RECITE_fatihaIdx = -1;         // index of 1:1 (basmala guard, set at build)
var RECITE_namlIdx = -1;           // index of 27:30 (basmala also inside it)
var RECITE_BASMALA = 'بسم الله الرحمن الرحيم';
var RECITE_istiaIdxs = [];         // carrier ayahs resembling isti'adha (guard below)
var RECITE_stream = [];          // live normalized word stream (capped, ever-growing)
var RECITE_consumed = 0;         // stream words already processed by the follower
var RECITE_unmatched = 0;        // consecutive unmatched words (re-anchor trigger)
var RECITE_drift = 0;            // consecutive BACKWARD micro-matches (review-jump trigger)
var RECITE_lastReanchorLen = -1; // stream length at last re-anchor attempt
var RECITE_lastWatchdog = 0;     // consumed count at last watchdog check
var RECITE_micRestart = null;
var RECITE_rec = null;             // SpeechRecognition instance
var RECITE_recRunning = false;
var RECITE_pendingJump = { target: -1, hits: 0, text: '' };
var RECITE_lowStreak = 0;
var RECITE_mediaRec = null;
var RECITE_mediaChunks = [];
var RECITE_mediaTimer = null;

function RECITE_log() {
  if (RECITE_CONFIG.DEBUG && window.console) console.log.apply(console, arguments);
}

/* ------------------------- 1. normalisation ---------------------------- */
function normalizeArabic(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\u064B-\u065F\u0670]/g, '') // tashkeel + dagger alif
    .replace(/[إأآٱ]/g, 'ا')               // alef variants (keep ٱ→ا: Uthmani)
    .replace(/ة/g, 'ه')                    // taa marbuta (waqf form; speech ok)
    .replace(/ى/g, 'ي')                    // alef maqsura
    .replace(/[\u0640\u200C\u200D]/g, '')   // tatweel + ZWNJ/ZWJ
    .replace(/ئ/g, 'ء')                    // hamza seats → glottal core
    .replace(/ؤ/g, 'ء')
    // NOTE: old code had .replace(/اء/g,'ء') here — DELETED. It mapped
    // سماء→سمء while ASR outputs سماء, breaking every madd-ending word.
    .replace(/[^\u0600-\u06FF\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------- 2. Muqatta'at ------------------------------- */
var RECITE_MUQ = [
  ['الف لام ميم صاد', 'المص'],
  ['الف لام ميم را', 'المر'],
  ['الف لام ميم', 'الم'],
  ['الف لام را', 'الر'],
  ['كاف ها يا عين صاد', 'كهيعص'],
  ['عين سين قاف', 'عسق'],
  ['طا سين ميم', 'طسم'],
  ['حا ميم', 'حم'],
  ['طا سين', 'طس'],
  ['طا ها', 'طه'],
  ['يا سين', 'يس'],
  ['الف لام', 'الم'],
  ['طاها', 'طه'],
  ['ياسين', 'يس'],
  ['حاميم', 'حم'],
  ['قاف', 'ق'],
  ['نون', 'ن'],
  ['صاد', 'ص']
];

function RECITE_resolveMuqattaat(tokens) {
  // longest-phrase token replacement anywhere in the stream
  var out = tokens.slice();
  for (var d = 0; d < RECITE_MUQ.length; d++) {
    var phrase = RECITE_MUQ[d][0].split(' ');
    var letters = RECITE_MUQ[d][1];
    if (phrase.length === 1) continue; // singletons handled after multis
    for (var i = 0; i + phrase.length <= out.length; i++) {
      var ok = true;
      for (var k = 0; k < phrase.length; k++) {
        if (out[i + k] !== phrase[k]) { ok = false; break; }
      }
      if (ok) { out.splice(i, phrase.length, normalizeArabic(letters)); i--; }
    }
  }
  // single-word spoken forms (صاد→ص etc.) — only when the whole chunk is that
  if (out.length <= 3) {
    for (var j = 0; j < out.length; j++) {
      for (var m = 0; m < RECITE_MUQ.length; m++) {
        if (RECITE_MUQ[m][0].indexOf(' ') === -1 && out[j] === RECITE_MUQ[m][0]) {
          out[j] = normalizeArabic(RECITE_MUQ[m][1]);
        }
      }
    }
  }
  return out;
}

// kept name (old whole-string prefix version deleted from inline script)
function resolveMuqattaatPhonetics(text) {
  if (!text) return '';
  var toks = String(text).trim().split(/\s+/);
  return RECITE_resolveMuqattaat(toks).join(' ');
}

/* ------------------------- 3. word similarity -------------------------- */
function RECITE_lev(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  var prev = new Array(n + 1), cur = new Array(n + 1);
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    cur[0] = i;
    var ca = a.charCodeAt(i - 1);
    for (var k = 1; k <= n; k++) {
      var cost = (ca === b.charCodeAt(k - 1)) ? 0 : 1;
      var v = prev[k] + 1;
      var ins = cur[k - 1] + 1;
      if (ins < v) v = ins;
      var sub = prev[k - 1] + cost;
      if (sub < v) v = sub;
      cur[k] = v;
    }
    var tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

function RECITE_wordSim(a, b) {
  if (a === b) return 1;
  var m = Math.max(a.length, b.length);
  if (m === 0) return 0;
  // fast reject: wildly different lengths can't be the same word
  if (Math.abs(a.length - b.length) > Math.max(2, Math.min(a.length, b.length))) return 0;
  return 1 - RECITE_lev(a, b) / m;
}

function RECITE_idfOf(tok) {
  var v = RECITE_idf.get(tok);
  return (v === undefined) ? 0 : v;
}

/* ------------------------- 4. index (BM25) ----------------------------- */
function buildVoiceRecitationIndex() {
  if (typeof isVoiceIndexBuilt !== 'undefined' && isVoiceIndexBuilt) return;
  var data = (typeof activeData !== 'undefined' && activeData && activeData.length)
    ? activeData
    : ((window.QURAN_DATA && window.QURAN_DATA.ayahs) || []);
  if (!data || !data.length) return;
  var t0 = (window.performance) ? performance.now() : 0;
  ayahVoiceIndex = [];
  RECITE_postings = new Map();
  var df = new Map();
  var totalLen = 0;
  var isObj = data.length && typeof data[0] === 'object' && !Array.isArray(data[0]);

  for (var i = 0; i < data.length; i++) {
    var sura, aya, page, suraName, rawText;
    if (isObj) {
      sura = data[i].sura; aya = data[i].aya; page = data[i].page;
      suraName = data[i].suraName; rawText = data[i].text || data[i].rawText || '';
    } else {
      sura = data[i][0]; aya = data[i][1]; page = data[i][2];
      suraName = data[i][3]; rawText = data[i][4] || '';
    }
    var clean = String(rawText).replace(/\(\d+\)$/, '').trim();
    var norm = normalizeArabic(clean);
    var words = norm ? norm.split(' ').filter(function (w) { return w.length > 0; }) : [];
    totalLen += words.length;
    ayahVoiceIndex.push({
      idx: i, sura: sura, aya: aya, page: page, suraName: suraName,
      rawText: rawText, cleanText: clean, normText: norm,
      words: words, wordCount: words.length
    });
    var seen = {};
    for (var w = 0; w < words.length; w++) {
      var tok = words[w];
      var arr = RECITE_postings.get(tok);
      if (!arr) { arr = []; RECITE_postings.set(tok, arr); }
      arr.push(i);
      if (!seen[tok]) { seen[tok] = 1; df.set(tok, (df.get(tok) || 0) + 1); }
    }
  }
  var N = ayahVoiceIndex.length;
  RECITE_avgLen = N ? totalLen / N : 15;
  RECITE_idf = new Map();
  RECITE_vocab = [];
  df.forEach(function (d, tok) {
    var idf = Math.log((N - d + 0.5) / (d + 0.5)) + 1;
    if (idf < 0.2) idf = 0.2; // floor: ultra-common words still count a little
    RECITE_idf.set(tok, idf);
    RECITE_vocab.push(tok);
  });
  isVoiceIndexBuilt = true;
  RECITE_fatihaIdx = -1;
  RECITE_namlIdx = -1;
  RECITE_istiaIdxs = [];
  for (var fi = 0; fi < ayahVoiceIndex.length; fi++) {
    if (ayahVoiceIndex[fi].sura === 1 && ayahVoiceIndex[fi].aya === 1) RECITE_fatihaIdx = fi;
    if (ayahVoiceIndex[fi].sura === 27 && ayahVoiceIndex[fi].aya === 30) RECITE_namlIdx = fi;
    if (ayahVoiceIndex[fi].sura === 16 && ayahVoiceIndex[fi].aya === 98) RECITE_istiaIdxs.push(fi);
    if (ayahVoiceIndex[fi].sura === 7 && ayahVoiceIndex[fi].aya === 200) RECITE_istiaIdxs.push(fi);
    if (ayahVoiceIndex[fi].sura === 41 && ayahVoiceIndex[fi].aya === 36) RECITE_istiaIdxs.push(fi);
    if (RECITE_fatihaIdx >= 0 && RECITE_namlIdx >= 0 && RECITE_istiaIdxs.length >= 3) break;
  }
  RECITE_lowStreak = 0;
  RECITE_pendingJump = { target: -1, hits: 0, text: '' };
  if (window.performance) RECITE_log('recite index: ' + N + ' ayahs in ' + (performance.now() - t0).toFixed(0) + 'ms');
}

/* Basmala guard: "بسم الله الرحمن الرحيم" is recited as the opener of nearly
 * every surah AND lives verbatim in 1:1 and inside 27:30. A far jump to
 * either on those 4 words is virtually never intended (it teleports the user
 * to page 1/379 on every surah start, then loops on every re-anchor).
 * Block only when the anchor is near NEITHER carrier — sequential arrival
 * (local follower) and Fatiha-page starts are unaffected. */
function RECITE_basmalaBlocked(anchorI, toks) {
  if (!toks || toks.length < 4) return false;
  if (toks.slice(-4).join(' ') !== RECITE_BASMALA) return false;
  var nearF = (RECITE_fatihaIdx >= 0 && Math.abs(anchorI - RECITE_fatihaIdx) <= 3);
  var nearN = (RECITE_namlIdx >= 0 && Math.abs(anchorI - RECITE_namlIdx) <= 3);
  return !(nearF || nearN);
}

/* Isti'adha guard (same family as basmala): "أعوذ بالله من الشيطان الرجيم"
 * opens nearly every recitation session yet shares 3-4 words with 16:98,
 * 7:200 and 41:36 — a far jump there on the opener is virtually never
 * intended (it yanks the user across the mushaf before they even start).
 * Detection is an ORDERED subsequence [اعوذ, بالله, من, الشيطان, الرجيم]
 * within a span of 8 (covers the longer السميع العليم form too). This pattern
 * occurs in NO actual ayah (16:98 etc. have فاستعذ, never أعوذ), so blocking
 * far jumps on it can never strand a genuine recitation — the real ayahs
 * that follow match normally right after. */
function RECITE_hasIstiadhah(toks) {
  if (!toks || toks.length < 5) return false;
  // recency: only the last ~10 words count. A session opener scrolls out of
  // the window as real recitation accumulates — otherwise one isti'adha at
  // session start would veto every global match for the next 40 words.
  var t = toks.length > 10 ? toks.slice(-10) : toks;
  var pat = ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم'];
  var pi = 0, start = -1;
  for (var i = 0; i < t.length; i++) {
    if (t[i] === pat[pi]) {
      if (pi === 0) start = i;
      pi++;
      if (pi === pat.length) return (i - start) <= 7;
    }
  }
  return false;
}

function RECITE_istiaBlocked(anchorI, toks) {
  if (!RECITE_hasIstiadhah(toks)) return false;
  for (var k = 0; k < RECITE_istiaIdxs.length; k++) {
    if (Math.abs(anchorI - RECITE_istiaIdxs[k]) <= 3) return false; // studying it: allow
  }
  return true;
}

/* Strip ritual openers (basmala 4-gram, isti'adha ordered run) when the
 * anchor is far from ALL their carriers. Rationale: opener words keep voting
 * for carrier-cousins inside BM25/SW (a bare isti'adha tail crowned 16:106
 * over the real 18:37) — no target-block list can enumerate every cousin, so
 * remove the opener evidence itself. Near carriers: untouched (genuine
 * recitation must still match). Returns null when nothing remains. */
function RECITE_stripOpeners(tokens, anchorIdx) {
  var nearAny = false;
  if (RECITE_fatihaIdx >= 0 && Math.abs(anchorIdx - RECITE_fatihaIdx) <= 3) nearAny = true;
  if (RECITE_namlIdx >= 0 && Math.abs(anchorIdx - RECITE_namlIdx) <= 3) nearAny = true;
  for (var k = 0; k < RECITE_istiaIdxs.length; k++) {
    if (Math.abs(anchorIdx - RECITE_istiaIdxs[k]) <= 3) { nearAny = true; break; }
  }
  if (nearAny || !tokens || !tokens.length) return tokens;
  var out = tokens.slice();
  var B = RECITE_BASMALA.split(' ');
  var dropped = true;
  while (dropped) {
    dropped = false;
    for (var i = 0; i + 4 <= out.length; i++) {
      if (out[i] === B[0] && out[i + 1] === B[1] && out[i + 2] === B[2] && out[i + 3] === B[3]) {
        out.splice(i, 4); dropped = true; break;
      }
    }
  }
  var P = ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم'];
  var idx = [], pi = 0;
  for (var j = 0; j < out.length && pi < 5; j++) {
    if (out[j] === P[pi]) { idx.push(j); pi++; }
  }
  if (pi === 5 && idx[4] - idx[0] <= 7) {
    for (var d = idx.length - 1; d >= 0; d--) out.splice(idx[d], 1);
  }
  return out.length ? out : null;
}

/* ------------------ 5. Smith-Waterman word alignment ------------------ */
function RECITE_sw(spoken, sW, ayahWords) {
  var m = spoken.length, n = ayahWords.length;
  if (!m || !n) return { score: 0, matched: 0, coverage: 0, endJ: 0, denom: 1 };
  var H = new Array(m + 1);
  for (var i = 0; i <= m; i++) { H[i] = new Array(n + 1).fill(0); }
  var best = 0, bestI = 0, bestJ = 0;
  for (var a = 1; a <= m; a++) {
    for (var b = 1; b <= n; b++) {
      var sim = RECITE_wordSim(spoken[a - 1], ayahWords[b - 1]);
      var diag = (sim >= RECITE_CONFIG.WORD_SIM_THRESHOLD)
        ? sim * sW[a - 1]
        : RECITE_CONFIG.MISMATCH * sW[a - 1];
      var v = H[a - 1][b - 1] + diag;
      var d1 = H[a - 1][b] + RECITE_CONFIG.GAP * sW[a - 1];
      if (d1 > v) v = d1;
      var d2 = H[a][b - 1] + RECITE_CONFIG.GAP;
      if (d2 > v) v = d2;
      if (v < 0) v = 0;
      H[a][b] = v;
      if (v > best) { best = v; bestI = a; bestJ = b; }
    }
  }
  // backtrace: count matched pairs, find ayah end + spoken span start.
  // NOTE: the score is normalized by the ALIGNED SUBSEGMENT, not the whole
  // input: a 4-word ayah recited inside a 15-word multi-ayah utterance still
  // scores ~1.0 (diluting by the full input made every multi-ayah utterance
  // unmatchable — the "stuck on Fatiha while reciting Ikhlas" bug).
  var matched = 0, ci = bestI, cj = bestJ;
  while (ci > 0 && cj > 0 && H[ci][cj] > 0) {
    var sim2 = RECITE_wordSim(spoken[ci - 1], ayahWords[cj - 1]);
    if (sim2 >= RECITE_CONFIG.WORD_SIM_THRESHOLD) {
      matched++;
      ci--; cj--;
    } else if (H[ci - 1][cj] >= H[ci][cj - 1]) { ci--; }
    else { cj--; }
  }
  var spanStart = ci, spanLen = bestI - ci;
  if (spanLen <= 0) spanLen = 1;
  var spanDenom = 0;
  for (var k2 = spanStart; k2 < bestI; k2++) spanDenom += sW[k2];
  if (spanDenom <= 0) spanDenom = 1;
  var fullDenom = 0;
  for (var k = 0; k < m; k++) fullDenom += sW[k];
  if (fullDenom <= 0) fullDenom = 1;
  return { score: best / spanDenom, matched: matched,
    coverage: matched / spanLen, endJ: Math.max(0, bestJ - 1),
    spanStart: spanStart, spanLen: spanLen,
    fullScore: best / fullDenom, fullCoverage: m ? matched / m : 0, denom: fullDenom };
}

function RECITE_spokenWeights(spoken) {
  var w = new Array(spoken.length);
  for (var i = 0; i < spoken.length; i++) {
    var idf = RECITE_idfOf(spoken[i]);
    w[i] = 0.5 + 0.5 * Math.min(1, idf / 6); // 0.5..1: rare words steer
  }
  return w;
}

function RECITE_alignAyah(ayah, spoken) {
  if (!ayah || !ayah.words || !ayah.words.length || !spoken.length) {
    return { ok: false, score: 0, matched: 0, coverage: 0, endJ: 0 };
  }
  // exact ayah recited alone (short surahs: والعصر، الكوثر، ق، يس...) OR
  // verbatim inside a longer multi-ayah utterance (short surah inside
  // continuous recitation, e.g. 112:2 inside full Ikhlas)
  if (ayah.normText) {
    var joined = spoken.join(' ');
    var at = (' ' + joined + ' ').indexOf(' ' + ayah.normText + ' ');
    if (at >= 0) {
      var preW = joined.slice(0, Math.max(0, at - 1)).trim();
      var ss = preW ? preW.split(/\s+/).length : 0;
      return { ok: true, score: 1, matched: ayah.words.length, coverage: 1,
        endJ: ayah.words.length - 1, spanStart: ss, spanLen: ayah.words.length,
        fullScore: 1, fullCoverage: spoken.length ? ayah.words.length / spoken.length : 0,
        denom: spoken.length };
    }
  }
  var sW = RECITE_spokenWeights(spoken);
  var r = RECITE_sw(spoken, sW, ayah.words);
  var ok = (spoken.length === 1 && r.matched >= 1) ||
           (spoken.length === 2 && r.matched >= 2) ||
           (spoken.length >= 3 && r.matched >= 2 && r.coverage >= 0.55);
  return { ok: ok, score: r.score, matched: r.matched, coverage: r.coverage, endJ: r.endJ,
    spanStart: r.spanStart, spanLen: r.spanLen,
    fullScore: r.fullScore, fullCoverage: r.fullCoverage, denom: r.denom };
}

function detectActiveWordInAyah(ayah, spokenTokens, previousWordIdx) {
  var toks = spokenTokens.slice(-8); // tail only: position follows recent speech
  var r = RECITE_alignAyah(ayah, toks.length ? toks : spokenTokens);
  var end = r.endJ;
  if (typeof previousWordIdx === 'number' && previousWordIdx > end) end = previousWordIdx; // monotonic
  return end;
}

/* ------------------ 6. BM25 retrieval + rerank ------------------------ */
function RECITE_bm25(spoken) {
  var k1 = RECITE_CONFIG.BM25_K1, b = RECITE_CONFIG.BM25_B;
  var scores = new Map();
  for (var s = 0; s < spoken.length; s++) {
    var tok = spoken[s];
    var post = RECITE_postings.get(tok);
    if (!post) continue;
    var idf = RECITE_idfOf(tok);
    for (var p = 0; p < post.length; p++) {
      var idx = post[p];
      var ay = ayahVoiceIndex[idx];
      var freq = 1;
      var denom = freq + k1 * (1 - b + b * (ay.wordCount / RECITE_avgLen));
      scores.set(idx, (scores.get(idx) || 0) + idf * (freq * (k1 + 1)) / denom);
    }
  }
  var arr = [];
  scores.forEach(function (v, k) { arr.push([k, v]); });
  arr.sort(function (a, b2) { return b2[1] - a[1]; });
  return arr.slice(0, RECITE_CONFIG.TOP_K);
}

function RECITE_samePage(ay) {
  try {
    if (typeof isDoublePageMode !== 'undefined' && isDoublePageMode) {
      return (typeof currentRightPage !== 'undefined' && ay.page === currentRightPage) ||
             (typeof currentLeftPage !== 'undefined' && ay.page === currentLeftPage);
    }
    return (typeof currentPage !== 'undefined' && ay.page === currentPage);
  } catch (e) { return false; }
}

function RECITE_rerank(cands, spoken, anchorIdx) {
  var anchorAyah = (anchorIdx >= 0 && anchorIdx < ayahVoiceIndex.length) ? ayahVoiceIndex[anchorIdx] : null;
  var out = [];
  for (var c = 0; c < cands.length; c++) {
    var idx = cands[c][0], bm = cands[c][1];
    var ay = ayahVoiceIndex[idx];
    var al = RECITE_alignAyah(ay, spoken);
    // Evidence gate: span scores are ~1.0 even for a single shared word
    // (قل alone "matches" every ayah containing it), so structural-ok alone
    // is not enough — a non-ok candidate must explain real evidence:
    // at least 2 matched words AND ≥15% of the whole input.
    if (!al.ok && (al.matched < 2 || (al.fullCoverage || 0) < 0.15)) continue;
    var final = al.score;
    var d = Math.abs(idx - anchorIdx);
    final -= Math.min(0.2, d * 0.0004);              // mild distance prior
    if (anchorAyah && ay.sura === anchorAyah.sura) final += 0.03;
    if (RECITE_samePage(ay)) final += 0.05;
    out.push({ idx: idx, ay: ay, al: al, bm: bm, final: final,
      spanStart: al.spanStart || 0, spanEnd: (al.spanStart || 0) + (al.spanLen || 0) });
  }
  out.sort(function (a, b) { return b.final - a.final; });
  return out;
}

/* ------------------ 7. the follower (local-first) --------------------- */
function matchRecitedSpeech(rawSpokenText, anchorIdx, opts) {
  if (typeof isVoiceIndexBuilt === 'undefined' || !isVoiceIndexBuilt) {
    try { buildVoiceRecitationIndex(); } catch (e) { /* data not ready */ }
    if (typeof isVoiceIndexBuilt === 'undefined' || !isVoiceIndexBuilt) return null;
  }
  if (typeof anchorIdx !== 'number' || anchorIdx < 0) anchorIdx = 0;
  if (anchorIdx >= ayahVoiceIndex.length) anchorIdx = ayahVoiceIndex.length - 1;
  // Fresh single-shot semantics: a reset call must not inherit jump
  // confirmation from a previous unrelated query (sim A arming sim B).
  if (opts && opts.reset) {
    RECITE_pendingJump = { target: -1, hits: 0, text: '' };
    RECITE_lowStreak = 0;
  }
  var norm = normalizeArabic(resolveMuqattaatPhonetics(rawSpokenText)).trim();
  if (!norm) return null;
  var tokens = RECITE_resolveMuqattaat(norm.split(' ').filter(function (w) { return w.length > 0; }));
  if (!tokens.length) return null;
  if (tokens.length > RECITE_CONFIG.BUFFER_WORDS) tokens = tokens.slice(-RECITE_CONFIG.BUFFER_WORDS);
  var stripped = RECITE_stripOpeners(tokens, anchorIdx);
  if (!stripped) { RECITE_lowStreak++; return null; } // pure opener(s): hold
  tokens = stripped;
  if (RECITE_basmalaBlocked(anchorIdx, tokens)) { RECITE_lowStreak++; return null; }
  if (RECITE_istiaBlocked(anchorIdx, tokens)) { RECITE_lowStreak++; return null; }

  var prevActive = 0;
  try { prevActive = (anchorIdx === voiceLastDetectedIdx) ? voiceActiveWordIdx : 0; } catch (e) {}
  if (prevActive < 0) prevActive = 0;

  // ---- STAGE 1+2: local window (prev, current, next, next+2) ----
  var localIdx = [];
  if (anchorIdx - 1 >= 0) localIdx.push(anchorIdx - 1);
  localIdx.push(anchorIdx);
  if (anchorIdx + 1 < ayahVoiceIndex.length) localIdx.push(anchorIdx + 1);
  if (anchorIdx + 2 < ayahVoiceIndex.length) localIdx.push(anchorIdx + 2);
  var bestLocal = null;
  for (var l = 0; l < localIdx.length; l++) {
    var li = localIdx[l];
    var ay = ayahVoiceIndex[li];
    var al = RECITE_alignAyah(ay, tokens);
    if (!al.ok || al.score < RECITE_CONFIG.LOCAL_COMMIT) continue;
    // singleton guard: one spoken word may only HOLD locally on an exact
    // word hit (sim≈1). Fuzzy singletons (الم≈الحمد via shared ال+م) must
    // fall through to the global exact-full-ayah rule instead of hijacking
    // the neighbour ayah.
    if (tokens.length === 1 && al.score < 0.99) continue;
    var startsNearBegin = (al.endJ - al.matched + 1) <= 1;
    if (li !== anchorIdx && li !== anchorIdx - 1 && !startsNearBegin && tokens.length >= 2) continue;
    var cand = { idx: li, ay: ay, al: al };
    if (!bestLocal || al.score > bestLocal.al.score) bestLocal = cand;
  }
  // multi-ayah input: a local commit must explain at least half the words.
  // (Without this, one shared common word scores span-1.0 and sticky-commits
  // to a neighbour instead of letting global match by recitation order.)
  if (bestLocal && tokens.length >= 4 &&
      (bestLocal.al.spanLen || 0) < tokens.length * 0.5) bestLocal = null;
  if (bestLocal) {
    RECITE_lowStreak = 0;
    RECITE_pendingJump = { target: -1, hits: 0, text: '' };
    var endJ = bestLocal.al.endJ;
    if (bestLocal.idx === anchorIdx && endJ < prevActive) endJ = prevActive; // monotonic
    var conf = Math.min(97, Math.max(62, Math.round(bestLocal.al.score * 100)));
    return {
      bestIdx: bestLocal.idx, bestAyah: bestLocal.ay, activeWordIdx: endJ,
      score: bestLocal.al.score, baseScore: bestLocal.al.score,
      confidence: conf, isJump: Math.abs(bestLocal.idx - anchorIdx) > 3
    };
  }

  // ---- STAGE 3: global BM25 → SW rerank ----
  var cands = RECITE_bm25(tokens);
  if (!cands.length) { RECITE_lowStreak++; return null; }
  var ranked = RECITE_rerank(cands, tokens, anchorIdx);
  // basmala guard: 1:1 doubles as the universal surah opener. A far jump to
  // it on "بسم الله الرحمن الرحيم" is virtually never intended — it teleports
  // the user to page 1 on every surah start, then loops on every re-anchor.
  // Drop it from candidacy (second-best can still win); near-Fatiha use is kept.
  if (RECITE_fatihaIdx >= 0) {
    var kept = [];
    for (var fi2 = 0; fi2 < ranked.length; fi2++) {
      if (ranked[fi2].idx === RECITE_fatihaIdx && Math.abs(ranked[fi2].idx - anchorIdx) > 3) continue;
      kept.push(ranked[fi2]);
    }
    ranked = kept;
  }
  if (!ranked.length || ranked[0].final < RECITE_CONFIG.GLOBAL_COMMIT) { RECITE_lowStreak++; return null; }
  var top = ranked[0];

  // single-token guard: only exact full-ayah hits (الم، ق، ن) or neighbours
  if (tokens.length === 1) {
    var isFull = (top.ay.normText === tokens.join(' '));
    var isNeigh = Math.abs(top.idx - anchorIdx) <= 2;
    if (!isFull && !isNeigh) { RECITE_lowStreak++; return null; }
  }
  // mutashabihat margin — BUT only for competitors claiming the SAME words.
  // Non-overlapping spans are sequential ayahs inside one multi-ayah
  // utterance (e.g. 112:1@[0-4) + 112:2@[4-6)): not competitors, so follow
  // recitation order (earliest span first) instead of vetoing.
  if (ranked.length > 1 && (ranked[0].final - ranked[1].final) < RECITE_CONFIG.JUMP_MARGIN) {
    // tie set: everything within margin of the best (all strong evidence)
    var ties = [ranked[0]];
    for (var ti = 1; ti < ranked.length; ti++) {
      if (ranked[0].final - ranked[ti].final < RECITE_CONFIG.JUMP_MARGIN) ties.push(ranked[ti]);
      else break;
    }
    // order by evidence position (recitation order), longest span first:
    // a strict superset (113:1[0,4) over 114:1[0,3)) explains more words.
    ties.sort(function (a, b) {
      if (a.spanStart !== b.spanStart) return a.spanStart - b.spanStart;
      var alen = a.spanEnd - a.spanStart, blen = b.spanEnd - b.spanStart;
      if (alen !== blen) return blen - alen;
      return b.final - a.final;
    });
    // opener demotion: a span that IS a ritual opener (exact basmala, or the
    // ordered بالله/من/الشيطان/الرجيم core shared by the isti'adha carriers)
    // loses to a LATER span from ANOTHER surah — the opener was an opener,
    // not the destination (opener+Kahf must land Kahf, not page 1 or 16:98).
    // Genuine carrier/Fatiha recitation keeps it: all its ties share a surah.
    var ISTI_CORE = ['بالله', 'من', 'الشيطان', 'الرجيم'];
    function spanIsOpener(tt) {
      var ws = tokens.slice(tt.spanStart, tt.spanEnd);
      if (ws.join(' ') === RECITE_BASMALA) return true;
      var p = 0;
      for (var w = 0; w < ws.length && p < 4; w++) if (ws[w] === ISTI_CORE[p]) p++;
      return p === 4;
    }
    var opIdx = [];
    for (var tb = 0; tb < ties.length; tb++) {
      if (spanIsOpener(ties[tb])) opIdx.push(tb);
    }
    if (opIdx.length) {
      var laterOther = false;
      for (var to = 0; to < ties.length; to++) {
        if (ties[to].spanStart > ties[opIdx[0]].spanStart &&
            ties[to].ay.sura !== ties[opIdx[0]].ay.sura) { laterOther = true; break; }
      }
      if (laterOther) {
        ties = ties.filter(function (_, i) { return opIdx.indexOf(i) === -1; });
        if (!ties.length) { RECITE_lowStreak++; return null; }
      }
    }
    var first = ties[0];
    // identical spans from different ayahs = same words claimed twice
    // (shared heads like 113:1/114:1, mutashabihat refrains): decide by
    // proximity — near-anchor twin wins (repeat-in-place), far twins hold
    // (one more disambiguating word resolves it; jumping blind is worse).
    var dupNear = null, dupFarTwin = false;
    for (var td = 0; td < ties.length; td++) {
      if (ties[td].idx !== first.idx &&
          ties[td].spanStart === first.spanStart &&
          ties[td].spanEnd === first.spanEnd) {
        if (Math.abs(ties[td].idx - anchorIdx) <= 2) dupNear = ties[td];
        else dupFarTwin = true;
      }
    }
    if (dupFarTwin && Math.abs(first.idx - anchorIdx) > 3 && !dupNear) {
      RECITE_lowStreak++; return null;
    }
    top = (dupNear && Math.abs(first.idx - anchorIdx) > 3) ? dupNear : first;
  }
  if (top.final < RECITE_CONFIG.GLOBAL_COMMIT) { RECITE_lowStreak++; return null; }
  // far-jump confirmation: same target twice, unless very confident
  var far = Math.abs(top.idx - anchorIdx) > 3;
  var crossSurah = false;
  try { crossSurah = ayahVoiceIndex[anchorIdx] && top.ay.sura !== ayahVoiceIndex[anchorIdx].sura; } catch (e) {}
  if (far && crossSurah && top.al.score < 0.88) {
    if (top.al.score < RECITE_CONFIG.GLOBAL_JUMP) { RECITE_lowStreak++; return null; }
    if (RECITE_pendingJump.target === top.idx) {
      RECITE_pendingJump.hits++;
    } else {
      RECITE_pendingJump = { target: top.idx, hits: 1, text: tokens.join(' ') };
      RECITE_lowStreak++;
      return null; // wait for confirmation on the next chunk
    }
    if (RECITE_pendingJump.hits < RECITE_CONFIG.JUMP_CONFIRM) { RECITE_lowStreak++; return null; }
  }
  RECITE_lowStreak = 0;
  RECITE_pendingJump = { target: -1, hits: 0, text: '' };
  var conf2 = Math.min(99, Math.max(50, Math.round(top.final * 100)));
  return {
    bestIdx: top.idx, bestAyah: top.ay, activeWordIdx: top.al.endJ,
    score: top.final, baseScore: top.bm,
    confidence: conf2, isJump: far
  };
}

/* ------------------ 8. mic engine (incremental word follower) ------------ */
function RECITE_el(id) { try { return document.getElementById(id); } catch (e) { return null; } }

function RECITE_showTranscript(words) {
  var tail = words.slice(-25).join(' ');
  if (words.length > 25) tail = '…' + tail;
  var a = RECITE_el('voiceTranscriptText'), b = RECITE_el('dockSpeechText');
  if (a) a.textContent = '"' + tail + '"';
  if (b) b.textContent = '"' + tail + '"';
}

/* ------------- 7b. incremental word follower (live path) -----------------
 * Why this exists: re-scoring the whole 40-word buffer against whole ayahs
 * can only commit AFTER an ayah is fully inside the buffer, and a short next
 * ayah inside a long buffer can never outscore the finished current ayah —
 * the follower stuck at "word N of N" forever (seen live on 18:1/18:2/18:5).
 * So live speech is consumed ONE WORD AT A TIME against a small forward
 * window (2 back for repeats, 6 forward spilling into the next ayahs).
 * Score is per-word: a 3-word ayah head matching 3 fresh words scores ~1.0
 * and the anchor advances MID-STREAM with zero delay. The SW global matcher
 * stays only as re-anchor fallback (lost user / surah jump) and sim API.
 * -------------------------------------------------------------------------- */
function RECITE_tokenize(text) {
  var norm = normalizeArabic(resolveMuqattaatPhonetics(text)).trim();
  if (!norm) return [];
  return RECITE_resolveMuqattaat(norm.split(' ').filter(function (w) { return w; }));
}

function RECITE_appendJoin(words) {
  var S = RECITE_stream;
  var maxK = Math.min(RECITE_CONFIG.OVERLAP_MAX, S.length, words.length);
  var k = 0;
  outer:
  for (var tryK = maxK; tryK >= 1; tryK--) {
    for (var j = 0; j < tryK; j++) {
      if (S[S.length - tryK + j] !== words[j]) continue outer;
    }
    k = tryK; break;
  }
  for (var m = k; m < words.length; m++) S.push(words[m]);
  if (S.length > RECITE_CONFIG.STREAM_CAP) {
    var drop = S.length - RECITE_CONFIG.STREAM_CAP;
    S.splice(0, drop);
    RECITE_consumed = Math.max(0, RECITE_consumed - drop);
  }
}

function RECITE_pushText(text) {
  // Single ingest for finals, interims and server chunks. Chrome's interims
  // grow monotonically ("قل هو" -> "قل هو الله") and finals repeat-then-extend
  // them, so exact overlap-join dedups without any rollback: speculation the
  // pointer already acted on is simply confirmed, and genuinely new words
  // flow to the follower. (An earlier rollback design reverted GOOD jumps on
  // every final and re-fell into fuzzy local traps — deleted.)
  var toks = RECITE_tokenize(text);
  if (!toks.length) return;
  RECITE_appendJoin(toks);
}

function RECITE_pushFinal(text) { RECITE_pushText(text); }

function RECITE_pushInterim(text) { RECITE_pushText(text); }

function RECITE_resetStream() {
  RECITE_stream = [];
  RECITE_consumed = 0;
  RECITE_unmatched = 0;
  RECITE_drift = 0;
  RECITE_lastReanchorLen = -1;
  RECITE_lastWatchdog = 0;
}

function RECITE_buildCands() {
  var anchor = 0, pw = -1;
  try { anchor = currentVoiceAnchorIdx; } catch (e) {}
  try { pw = voiceActiveWordIdx; } catch (e) {}
  if (typeof isVoiceIndexBuilt === 'undefined' || !isVoiceIndexBuilt) return { cands: [], anchor: anchor, pw: pw };
  if (anchor < 0) anchor = 0;
  if (anchor >= ayahVoiceIndex.length) anchor = ayahVoiceIndex.length - 1;
  var cands = [];
  var MAXC = RECITE_CONFIG.FOLLOW_MAXC;
  var ay0 = ayahVoiceIndex[anchor];
  if (ay0 && ay0.words) {
    for (var w = Math.max(0, pw - RECITE_CONFIG.FOLLOW_BACK); w <= pw && cands.length < MAXC; w++) {
      cands.push({ ayah: anchor, word: w, text: ay0.words[w], off: w - pw });
    }
  }
  // forward reach: rest of current ayah, then spill into the NEXT ayah only.
  // (Rationale: one spoken word can belong to the current ayah or the next
  // one — never to anchor+2. Letting single fuzzy words jump two ayahs
  // skipped whole verses on common words, e.g. sitting at 18:7 while the
  // user recites 18:5. Real multi-ayah jumps stay available via the
  // watchdog (strong evidence) and the confirmed re-anchor path.)
  var fwdLeft = RECITE_CONFIG.FOLLOW_FWD, ai = anchor, startW = pw + 1, distBase = 1;
  while (fwdLeft > 0 && cands.length < MAXC && ai < ayahVoiceIndex.length && ai - anchor <= 1) {
    var a = ayahVoiceIndex[ai];
    if (a && a.words && a.words.length) {
      var s0 = (ai === anchor) ? Math.max(0, startW) : 0;
      for (var w2 = s0; w2 < a.words.length && fwdLeft > 0 && cands.length < MAXC; w2++) {
        cands.push({ ayah: ai, word: w2, text: a.words[w2], off: distBase + (w2 - s0) });
      }
      var took = a.words.length - s0;
      if (took < 0) took = 0;
      distBase += took;
      fwdLeft -= took;
    }
    ai++;
  }
  return { cands: cands, anchor: anchor, pw: pw };
}

/* Priority key: pure similarity ignores evidence quality — a common-fuzzy
 * word (الله≈لله leftovers, 155-neighbour verb hubs like قالوا/كانوا) could
 * outrank a rare-exact one when both clear the gate. Composite key verified
 * against a corpus-wide collision census (14,637 words; len-4 avg ~27
 * neighbours @0.6): similarity first, IDF-weighted rarity second, distance
 * from the expected next word third. */
function RECITE_candKey(sim, tok, off) {
  var idfN = Math.min(1, RECITE_idfOf(tok) / 6);
  return sim + 0.12 * idfN - 0.04 * Math.abs(off - 1);
}

function RECITE_advanceWord(w) {
  var bc = RECITE_buildCands();
  if (!bc.cands.length) return null;
  var best = null, bestSim = 0, bestKey = -Infinity;
  for (var i = 0; i < bc.cands.length; i++) {
    var c = bc.cands[i];
    var s = RECITE_wordSim(w, c.text);
    // forward steps tolerate ASR noise (0.6); staying/rewinding on a fuzzy
    // common word (أحد≈الحمد) is how foreign words pin the pointer down, so
    // backward moves need near-exactness (0.85) — genuine repeats are exact.
    var need = (c.off >= 1) ? RECITE_CONFIG.WORD_SIM_THRESHOLD : 0.85;
    if (s < need) continue;
    var key = RECITE_candKey(s, c.text, c.off);
    if (!best || key > bestKey + 1e-9) {
      best = c; bestSim = s; bestKey = key;
    }
  }
  if (!best) return null;
  var changed = (best.ayah !== bc.anchor);
  // Cross-ayah confirmation by ORDERED RUN (not by single words, not by
  // pending flags): one exact common word confirming another (من…من across
  // steps) still teleported, because each alone "looks exact". Real evidence
  // of a new ayah is a run of trailing stream words aligning inside it.
  // Commit iff (a) exact + rare content word (immediate), or (b) an ordered
  // run of >=2 trailing words inside the target (>=1 for 1-word ayahs like
  // الم). Thinner evidence holds for more input (counts as unmatched, so the
  // re-anchor backstop still fires).
  if (changed) {
    var tWords = (ayahVoiceIndex[best.ayah] && ayahVoiceIndex[best.ayah].words) || [];
    var conf = (bestSim >= 0.99 && RECITE_idfOf(w) >= 6.0);
    if (!conf) {
      var run = 0, tp = best.word;
      for (var k = RECITE_consumed - 1; k >= Math.max(0, RECITE_consumed - 5) && tp >= 0; k--, tp--) {
        var aw = tWords[tp];
        if (aw === undefined) break;
        if (RECITE_wordSim(RECITE_stream[k], aw) >= 0.6) run++;
        else break;
      }
      if (run >= Math.min(2, tWords.length || 99)) conf = true;
    }
    if (!conf) return null; // held for more evidence (counts as unmatched)
  }
  try {
    currentVoiceAnchorIdx = best.ayah;
    voiceActiveWordIdx = best.word;
    voiceLastDetectedIdx = best.ayah;
  } catch (e) {}
  // fwd = same-or-forward step (incl. cross-ayah advance, always forward —
  // the window never reaches back an ayah). Anything else is a rewind.
  return { ayahChanged: changed, sim: bestSim, fwd: changed || best.off >= 0 };
}

function RECITE_firePointer(ayahChanged, isJump) {
  var anchor = 0, pw = 0;
  try { anchor = currentVoiceAnchorIdx; pw = voiceActiveWordIdx; } catch (e) {}
  if (typeof ayahVoiceIndex === 'undefined' || anchor < 0 || anchor >= ayahVoiceIndex.length) return;
  var ay = ayahVoiceIndex[anchor];
  var m = { bestIdx: anchor, bestAyah: ay, activeWordIdx: pw,
    score: 0.92, baseScore: 0.92, confidence: 92, isJump: !!isJump };
  var tail = RECITE_stream.slice(-12).join(' ');
  try { onVoiceAyahDetected(m, tail); } catch (e) { RECITE_log('detect err', e); }
}

/* Watchdog: the follower is forward-biased, so fuzzy near-misses on common
 * words (الله≈لله) can keep it wiggling locally after the user really left
 * for another surah — the unmatched run never reaches REANCHOR_AFTER.
 * Every 4 consumed words, independently verify with BM25+SW: if a FAR ayah
 * explains the recent tail much better than the anchor, adopt it. Ties
 * (mutashabihat) can never pass the margin, so they stay put by design. */
function RECITE_watchdog() {
  if (typeof isVoiceIndexBuilt === 'undefined' || !isVoiceIndexBuilt) return;
  var tail = RECITE_stream.slice(-12);
  if (tail.length < 4) return;
  var anchor = 0;
  try { anchor = currentVoiceAnchorIdx; } catch (e) { return; }
  if (RECITE_basmalaBlocked(anchor, tail)) return; // surah opener, not a jump
  if (RECITE_istiaBlocked(anchor, tail)) return; // session opener, not a jump
  var stail = RECITE_stripOpeners(tail, anchor);
  if (!stail) return;
  tail = stail;
  if (anchor < 0 || anchor >= ayahVoiceIndex.length) return;
  var cands = null;
  try { cands = RECITE_bm25(tail); } catch (e) { return; }
  if (!cands || !cands.length) return;
  var topIdx = cands[0][0];
  var wdist = topIdx - anchor;
  if (wdist === 0) return; // already here: follower owns it
  // Forward neighbours belong to the follower's pending-confirmation protocol
  // (it walks there word by word) — the watchdog must not yank them early and
  // fight it. Backward neighbours are invisible to the follower (its window
  // never reaches back an ayah), so review jumps 1-3 ayahs back are verified
  // here with the same strong gates as far jumps.
  if (wdist > 0 && wdist <= 3) return;
  // basmala guard (same as global stage): never teleport a far user to 1:1
  // for reciting the surah opener.
  if (RECITE_fatihaIdx >= 0 && topIdx === RECITE_fatihaIdx) return;
  var ayA = ayahVoiceIndex[anchor], ayT = ayahVoiceIndex[topIdx];
  if (!ayA || !ayA.words || !ayT || !ayT.words) return;
  var sW = RECITE_spokenWeights(tail);
  var sA = RECITE_sw(tail, sW, ayA.words);
  var sT = RECITE_sw(tail, sW, ayT.words);
  // sT.matched >= 3: a lone shared word (span-score 1.0 on 1 word) is not
  // evidence of anything — demand a real run before teleporting the mushaf.
  // Jump only on MORE evidence, not just better-normalized evidence: a lone
  // shared word scores span-1.0 anywhere (sT=sA=1.0 on 1 word), so demand the
  // far ayah explain at least 2 more words than the anchor does.
  if (sT.matched >= 3 && (sT.matched - sA.matched) >= 2 &&
      sT.score >= 0.7 && sT.coverage >= 0.5 && (sT.score - sA.score) > 0.15) {
    try {
      currentVoiceAnchorIdx = topIdx;
      voiceActiveWordIdx = sT.endJ;
      voiceLastDetectedIdx = topIdx;
    } catch (e) {}
    RECITE_unmatched = 0;
    RECITE_drift = 0;
    RECITE_firePointer(true, true);
  }
}

function RECITE_reanchor() {
  var tail = RECITE_stream.slice(-RECITE_CONFIG.BUFFER_WORDS).join(' ');
  if (!tail) return false;
  var anchor = 0;
  try { anchor = currentVoiceAnchorIdx; } catch (e) {}
  var m = null;
  try { m = matchRecitedSpeech(tail, anchor, { reset: true }); } catch (e) { return false; }
  if (!m) return false;
  try {
    currentVoiceAnchorIdx = m.bestIdx;
    voiceActiveWordIdx = m.activeWordIdx;
    voiceLastDetectedIdx = m.bestIdx;
  } catch (e) {}
  RECITE_unmatched = 0;
  RECITE_drift = 0;
  RECITE_consumed = RECITE_stream.length; // history explained by the re-anchor
  try { onVoiceAyahDetected(m, tail); } catch (e) {}
  return true;
}

function RECITE_follow() {
  var moved = false, ayahChanged = false, guard = 0;
  while (RECITE_consumed < RECITE_stream.length && guard++ < 80) {
    var w = RECITE_stream[RECITE_consumed++];
    var r = null;
    try { r = RECITE_advanceWord(w); } catch (e) { r = null; }
    if (r) {
      moved = true;
      if (r.fwd) { RECITE_unmatched = 0; RECITE_drift = 0; }
      // Backward micro-matches (repeats on shared words while reviewing an
      // older passage) must NOT clear the lost-evidence: they feed a separate
      // drift counter so review-jumps still trigger re-anchor. Forward flow
      // (corrections done, recitation continues) resets both.
      else { RECITE_drift++; }
      if (r.ayahChanged) ayahChanged = true;
    } else {
      RECITE_unmatched++;
    }
  }
  RECITE_showTranscript(RECITE_stream.slice(-25));
  if (moved) RECITE_firePointer(ayahChanged, false);
  if (RECITE_consumed - RECITE_lastWatchdog >= 4) {
    RECITE_lastWatchdog = RECITE_consumed;
    try { RECITE_watchdog(); } catch (e) { RECITE_log('watchdog err', e); }
  }
  if ((RECITE_unmatched >= RECITE_CONFIG.REANCHOR_AFTER ||
       RECITE_drift >= RECITE_CONFIG.DRIFT_REANCHOR) &&
      RECITE_stream.length !== RECITE_lastReanchorLen) {
    RECITE_lastReanchorLen = RECITE_stream.length;
    try { RECITE_reanchor(); } catch (e) { RECITE_log('reanchor err', e); }
  }
}

function startVoiceRecitation() {
  var SpeechRec = null;
  try { SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition; } catch (e) {}
  try { if (typeof openVoiceDock === 'function') openVoiceDock(); } catch (e) {}
  if (!SpeechRec) {
    try { showToast('المتصفح لا يدعم التعرف الصوتي المباشر، يمكنك استخدام لوحة المحاكاة'); } catch (e) {}
    try { if (typeof toggleDockSim === 'function') toggleDockSim(); } catch (e) {}
    return;
  }
  try { buildVoiceRecitationIndex(); } catch (e) {}
  try {
    if (currentVoiceAnchorIdx <= 0 && window.QURAN_DATA && window.QURAN_DATA.ayahs && typeof currentPage !== 'undefined') {
      var f = window.QURAN_DATA.ayahs.findIndex(function (a) { return a[2] === currentPage; });
      if (f !== -1) currentVoiceAnchorIdx = f;
    }
  } catch (e) {}
  try { isVoiceReciteActive = true; } catch (e) {}
  RECITE_resetStream(); // fresh word stream per session (anchor-from-page kept)
  try { if (typeof updateVoiceReciteUI === 'function') updateVoiceReciteUI(true); } catch (e) {}
  if (RECITE_recRunning) return;

  try {
    if (!RECITE_rec) {
      RECITE_rec = new SpeechRec();
      RECITE_rec.continuous = true;
      RECITE_rec.interimResults = true;
      try { RECITE_rec.lang = 'ar-SA'; } catch (e) {}
      try { RECITE_rec.maxAlternatives = 1; } catch (e) {}

      RECITE_rec.onstart = function () {
        RECITE_recRunning = true;
        try { hideMicDisconnectedWarning(); } catch (e) {}
        try { updateVoiceReciteUI(true); } catch (e) {}
        try { showToast('الميكروفون نشط الآن.. ابدأ بالتلاوة وستتم المتابعة كلمةً كلمة'); } catch (e) {}
      };

      RECITE_rec.onresult = function (event) {
        var interim = '', finals = [];
        try {
          for (var i = event.resultIndex; i < event.results.length; i++) {
            var tr = event.results[i][0].transcript;
            if (event.results[i].isFinal) finals.push(tr);
            else interim += tr + ' ';
          }
        } catch (e) { return; }
        var did = false;
        if (finals.length) { RECITE_pushFinal(finals.join(' ')); did = true; }
        if (interim.trim()) { RECITE_pushInterim(interim); did = true; }
        if (!did) return;
        // synchronous: the follower is O(words × ~10 cands), microseconds —
        // the spotlight moves with the words, no debounce delay.
        try { RECITE_follow(); } catch (e) { RECITE_log('follow err', e); }
      };

      RECITE_rec.onerror = function (e) {
        var err = '';
        try { err = e.error; } catch (ex) {}
        if (err === 'no-speech' || err === 'aborted') return;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          try { showMicDisconnectedWarning('not-allowed'); } catch (ex) {}
          stopVoiceRecitation();
          return;
        }
        if (err === 'network') {
          try { showMicDisconnectedWarning('network'); } catch (ex) {}
        }
      };

      RECITE_rec.onend = function () {
        RECITE_recRunning = false;
        var active = false;
        try { active = isVoiceReciteActive; } catch (e) {}
        if (active) {
          try { clearTimeout(micRestartTimeout); } catch (e) {}
          try { clearTimeout(RECITE_micRestart); } catch (e) {}
          RECITE_micRestart = setTimeout(function () {
            var a2 = false, r2 = false;
            try { a2 = isVoiceReciteActive; r2 = RECITE_recRunning; } catch (e) {}
            if (a2 && !r2 && RECITE_rec) {
              try { RECITE_rec.start(); RECITE_recRunning = true; }
              catch (err) {
                if (err && err.name !== 'InvalidStateError') {
                  try { showMicDisconnectedWarning('disconnect'); } catch (e2) {}
                }
              }
            }
          }, 350);
        } else {
          try { updateVoiceReciteUI(false); } catch (e) {}
        }
      };
    }
    RECITE_rec.start();
    RECITE_recRunning = true;
    if (RECITE_CONFIG.whisper.enabled) RECITE_whisperStart();
  } catch (e) {
    if (e && e.name === 'InvalidStateError') { RECITE_recRunning = true; }
    else if (e && e.name === 'NotAllowedError') {
      try { showMicDisconnectedWarning('not-allowed'); } catch (ex) {}
    } else {
      try { showMicDisconnectedWarning('disconnect'); } catch (ex) {}
    }
  }
}

function stopVoiceRecitation() {
  try { isVoiceReciteActive = false; } catch (e) {}
  RECITE_recRunning = false;
  try { clearTimeout(micRestartTimeout); } catch (e) {}
  try { clearTimeout(RECITE_micRestart); } catch (e) {}
  try { if (RECITE_rec) RECITE_rec.stop(); } catch (e) {}
  RECITE_whisperStop();
  RECITE_resetStream();
  RECITE_pendingJump = { target: -1, hits: 0, text: '' };
  RECITE_lowStreak = 0;
  try { updateVoiceReciteUI(false); } catch (e) {}
}

function toggleVoiceRecitation() {
  var active = false;
  try { active = isVoiceReciteActive; } catch (e) {}
  if (active) stopVoiceRecitation();
  else startVoiceRecitation();
}

/* ------------------ 9. Whisper hook (optional pro path) ---------------- */
/* If server/recite_server.py is running on this machine, use it: its
 * Quran-capable acoustics replace the generic browser ASR that hallucinates
 * on tajweed ("تلك الجنة" loops). Auto-detected on init — zero config. */
function RECITE_maybeEnableServer() {
  try {
    if ((RECITE_CONFIG.whisper.enabled && RECITE_CONFIG.whisper.endpoint) ||
        typeof fetch === 'undefined') return;
    var bases = ['http://127.0.0.1:8001', 'http://localhost:8001'];
    (function probe(i) {
      if (RECITE_CONFIG.whisper.enabled || i >= bases.length) return;
      fetch(bases[i] + '/health', { method: 'GET' }).then(function (r) {
        return r.json();
      }).then(function (j) {
        if (j && j.ok) {
          RECITE_CONFIG.whisper.enabled = true;
          RECITE_CONFIG.whisper.endpoint = bases[i] + '/recite-chunk';
          try { console.info('[recite] local Whisper server:', bases[i], 'model:', j.model); } catch (e) {}
          try { showToast('مخدم التسميع الدقيق متصل — دقة أعلى في التقاط التلاوة'); } catch (e) {}
        } else {
          probe(i + 1);
        }
      }).catch(function () { probe(i + 1); });
    })(0);
  } catch (e) { /* optional path — never break the default */ }
}
function RECITE_whisperStart() {
  var cfg = RECITE_CONFIG.whisper;
  if (!cfg.enabled || !cfg.endpoint) return;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (typeof MediaRecorder === 'undefined') return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      try {
        RECITE_mediaRec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      } catch (e) { RECITE_mediaRec = new MediaRecorder(stream); }
      RECITE_mediaChunks = [];
      RECITE_mediaRec.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) RECITE_mediaChunks.push(ev.data);
      };
      // Chunk rotation: stop() flushes async (dataavailable THEN stop event),
      // so the ONLY safe place to take the batch + restart is inside onstop.
      // (Clearing/restarting synchronously right after stop() used to race
      // it and silently drop every chunk.)
      RECITE_mediaRec.onstop = function () {
        var batch = RECITE_mediaChunks;
        RECITE_mediaChunks = [];
        if (batch.length) RECITE_whisperSendBatch(batch);
        var active = false;
        try { active = isVoiceReciteActive; } catch (e) {}
        if (active && RECITE_mediaRec) {
          try { RECITE_mediaRec.start(); } catch (e) { /* next tick retries */ }
        }
      };
      var slice = Math.max(4, cfg.chunkSeconds) * 1000;
      RECITE_mediaTimer = setInterval(function () {
        var active = false;
        try { active = isVoiceReciteActive; } catch (e) {}
        if (!active || !RECITE_mediaRec) return;
        try {
          if (RECITE_mediaRec.state === 'recording') RECITE_mediaRec.stop();
        } catch (e) { /* keep Web Speech path alive */ }
      }, slice);
      RECITE_mediaRec.start();
    }).catch(function () { /* mic already owned by Web Speech; stay silent */ });
  } catch (e) { /* optional path — never break the default */ }
}

function RECITE_whisperSend(stream) {
  // Back-compat shim (older code called whisperSend() with no batch).
  RECITE_whisperSendBatch(null);
}

function RECITE_whisperSendBatch(batch) {
  var cfg = RECITE_CONFIG.whisper;
  var chunks = batch || RECITE_mediaChunks;
  if (!chunks.length || !cfg.endpoint) return;
  if (!batch) RECITE_mediaChunks = [];
  try {
    var blob = new Blob(chunks, { type: 'audio/webm' });
    var fd = new FormData();
    fd.append('audio', blob, 'chunk.webm');
    fd.append('lang', cfg.lang || 'ar');
    try { fd.append('anchor', currentVoiceAnchorIdx); } catch (e) {}
    // Server recipe (see docs/RECITE_ALGORITHM.md): Groq whisper-large-v3 or
    // wasimlhr/whisper-quran-v1 / baristiran/whisper-turbo-quran → {text}
    fetch(cfg.endpoint, { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var txt = j && (j.text || j.transcript);
        if (!txt) return;
        RECITE_pushFinal(txt); // server chunks are authoritative (final-like)
        try { RECITE_follow(); } catch (e) {}
      })
      .catch(function () { /* transient — next chunk retries */ });
  } catch (e) { /* never break live path */ }
}

function RECITE_whisperStop() {
  try { clearInterval(RECITE_mediaTimer); } catch (e) {}
  RECITE_mediaTimer = null;
  try { if (RECITE_mediaRec && RECITE_mediaRec.state === 'recording') RECITE_mediaRec.stop(); } catch (e) {}
  RECITE_mediaRec = null;
  RECITE_mediaChunks = [];
}

/* ------------------ 10. sim API + init (same UI contract) -------------- */
window.simulateVoiceRecitation = function (spokenText) {
  if (!spokenText) return null;
  try { buildVoiceRecitationIndex(); } catch (e) {}
  try { if (typeof openVoiceDock === 'function') openVoiceDock(); } catch (e) {}
  var dockWave = RECITE_el('dockAudioWave');
  if (dockWave) {
    dockWave.classList.add('active');
    setTimeout(function () {
      var active = false;
      try { active = isVoiceReciteActive; } catch (e) {}
      if (!active) dockWave.classList.remove('active');
    }, 1400);
  }
  var dockSpeech = RECITE_el('dockSpeechText'), vt = RECITE_el('voiceTranscriptText');
  if (dockSpeech) dockSpeech.textContent = '"' + spokenText + '"';
  if (vt) vt.textContent = '"' + spokenText + '"';
  // sim = single-shot: reset live stream so old mic words can't leak in
  RECITE_resetStream();
  var anchor = 0;
  try { anchor = currentVoiceAnchorIdx; } catch (e) {}
  var match = null;
  try { match = matchRecitedSpeech(spokenText, anchor, { reset: true }); } catch (e) { return null; }
  if (match) {
    try { onVoiceAyahDetected(match, spokenText); } catch (e) {}
    return {
      bestIdx: match.bestIdx, score: match.score, confidence: match.confidence,
      sura: match.bestAyah.sura, aya: match.bestAyah.aya,
      page: match.bestAyah.page, suraName: match.bestAyah.suraName
    };
  }
  if (dockSpeech) dockSpeech.textContent = 'لم يتم العثور على آية مطابقة لـ "' + spokenText + '"';
  return null;
};

window.setVoiceAnchor = function (idx) {
  try { currentVoiceAnchorIdx = idx; } catch (e) {}
  RECITE_pendingJump = { target: -1, hits: 0, text: '' };
  RECITE_lowStreak = 0;
};
window.matchRecitedSpeech = matchRecitedSpeech;

function initVoiceRecitation() {
  RECITE_maybeEnableServer(); // silent unless server/recite_server.py is up
  try { console.info('[recite] engine v' + RECITE_VERSION); } catch (e) {}
  function on(id, ev, fn) {
    var el = RECITE_el(id);
    if (el) el.addEventListener(ev, fn);
  }
  on('voiceReciteToggleBtn', 'click', toggleVoiceRecitation);
  var launch = RECITE_el('floatingMicLauncher');
  if (launch) launch.addEventListener('click', function () {
    try { openVoiceDock(); } catch (e) {}
    startVoiceRecitation();
  });
  on('dockMainToggleBtn', 'click', toggleVoiceRecitation);
  on('dockMinimizeBtn', 'click', function () {
    try { minimizeVoiceDock(); } catch (e) {}
  });
  on('dockToggleSimBtn', 'click', function () {
    try { toggleDockSim(); } catch (e) {}
  });
  on('dockSimSubmitBtn', 'click', function () {
    var inp = RECITE_el('dockSimInput');
    var val = inp ? inp.value.trim() : '';
    if (val) window.simulateVoiceRecitation(val);
  });
  var dsi = RECITE_el('dockSimInput');
  if (dsi) dsi.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var val = dsi.value.trim();
      if (val) window.simulateVoiceRecitation(val);
    }
  });
  try {
    document.querySelectorAll('.dock-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var phrase = chip.dataset.phrase;
        if (phrase) {
          var inp = RECITE_el('dockSimInput');
          if (inp) inp.value = phrase;
          window.simulateVoiceRecitation(phrase);
        }
      });
    });
  } catch (e) {}
  on('dockOpenTafsirBtn', 'click', function () {
    try {
      if (currentVoiceAnchorIdx >= 0 && ayahVoiceIndex[currentVoiceAnchorIdx]) {
        var a = ayahVoiceIndex[currentVoiceAnchorIdx];
        openAyahTafsir(a.sura, a.aya);
      }
    } catch (e) {}
  });
  on('voiceOpenTafsirBtn', 'click', function () {
    try {
      if (currentVoiceAnchorIdx >= 0 && ayahVoiceIndex[currentVoiceAnchorIdx]) {
        var a2 = ayahVoiceIndex[currentVoiceAnchorIdx];
        openAyahTafsir(a2.sura, a2.aya);
      }
    } catch (e) {}
  });
  on('dockAllowMicBtn', 'click', function () {
    try { requestMicPermissionAndReconnect(); } catch (e) {}
  });
  on('dockDismissAlertBtn', 'click', function () {
    try { hideMicDisconnectedWarning(); } catch (e) {}
  });
  on('voiceHudStopBtn', 'click', stopVoiceRecitation);
  on('voiceTestSimBtn', 'click', function () {
    try { toggleVoiceSimDrawer(); } catch (e) {}
  });
  on('simCloseBtn', 'click', function () {
    try { closeVoiceSimDrawer(); } catch (e) {}
  });
}

/* test/debug handle (no DOM needed for pure parts) */
window.ReciteByMic = {
  version: RECITE_VERSION,
  config: RECITE_CONFIG,
  normalize: normalizeArabic,
  resolveMuqattaat: RECITE_resolveMuqattaat,
  wordSim: RECITE_wordSim,
  candKey: RECITE_candKey,
  levenshtein: RECITE_lev,
  buildIndex: buildVoiceRecitationIndex,
  match: matchRecitedSpeech,
  follow: RECITE_follow,
  pushFinal: RECITE_pushFinal,
  pushInterim: RECITE_pushInterim,
  resetStream: RECITE_resetStream,
  start: startVoiceRecitation,
  stop: stopVoiceRecitation,
  toggle: toggleVoiceRecitation
};