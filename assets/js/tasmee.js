/* وضع التسميع (Tasmee): one press of 🧠 covers the open page; the reciter
 * uncovers the words one by one, by voice (strict: nothing moves on until the
 * word is said exactly; where they start is found from their first words) or
 * by eye (a setting: Home = next word, End = previous). The covers follow the
 * reciter page after page until 🧠 / ✕ / Esc ends the mode.
 * Spec: docs/TASMEE_SPEC.md.
 *
 * Core (pure, tests/tasmee_core.js): a cursor over the expected words E.
 *   feed(T, X, tokens, final) judges heard tokens at the cursor: a match moves
 *   on; going back to repeat words or restart the ayah is no mistake; anything
 *   else turns the word red and counts one attempt (a run of wrong tokens is
 *   one attempt; a pause ends it). After X.reveal attempts the word is shown.
 *   Interim results are replayed on a copy of the committed state (the newest
 *   interim word is not judged), so a later correction never leaves a stale
 *   mistake behind.
 *
 * Hooks: recite-by-mic.js commitWords/tentativeWords -> Tasmee.heard() while a
 * voice test runs (the tracker is bypassed); index.html goToPage() ->
 * Tasmee.onPage().
 *
 * Storage: 'tasmee_prefs' (mode, range, level, reveal), 'tasmee_log.v1'
 * {words: {"s:a:w": {n, e, t, ty, last, ok, w}}, reach: {"s:a": n}, sessions: [...]}.
 */
(function (G) {
  'use strict';
  var HAS_DOM = typeof document !== 'undefined';

  /* ------------------------------ core ------------------------------- */
  var S_HID = 0, S_OK = 1, S_ERR = 2, S_FIX = 3, S_REV = 4, S_HINT = 5, S_MARK = 6, S_UNS = 7;   // UNS: yellow, Chrome wrote it otherwise
  var T_SKIP = 1, T_SUB = 2, T_ATF = 4, T_EXTRA = 8, T_ORDER = 16, T_HINT = 32, T_REV = 64, T_MARK = 128;
  var TYPES = [[T_SKIP, 'ترك'], [T_SUB, 'إبدال'], [T_ATF, 'حرف عطف'], [T_EXTRA, 'زيادة'], [T_ORDER, 'تقديم وتأخير'],
    [T_HINT, 'مساعدة'], [T_REV, 'كُشفت بعد المحاولات'], [T_MARK, '«أخطأت»']];

  // very strict: the same letters (after the engine's normalisation and its
  // map of Chrome's MSA spellings, applied by tokenize)
  function eqVery(e, t) {
    return e === t || (e === 'ياسين' && t === 'يس') || (e === 'يس' && t === 'ياسين');
  }
  // strict: also what Chrome writes wrongly for a correct recitation
  function eqStrict(e, t) {
    if (eqVery(e, t)) return true;
    var l = e.length;
    if (l >= 3 && l === t.length && e.slice(0, -1) === t.slice(0, -1) &&
        ((e[l - 1] === 'ه' && t[l - 1] === 'ي') || (e[l - 1] === 'ي' && t[l - 1] === 'ه'))) return true;  // «يره» -> «يرى»
    if (l > 2 && (e[0] === 'و' || e[0] === 'ف') && e.slice(1) === t) return true;   // a spoken و / ف dropped
    if (l >= 3 && e[l - 1] === 'ا' && (t === e.slice(0, -1) || t === e.slice(0, -1) + 'ه')) return true;   // «كلا» -> «كل», «مهادا» -> «مهاده»
    if (e.indexOf('ء') >= 0 || t.indexOf('ء') >= 0) return e.replace(/ء/g, '') === t.replace(/ء/g, '');  // hamza unwritten
    return false;
  }
  function stripWF(x) { return x.length > 2 && (x[0] === 'و' || x[0] === 'ف') ? x.slice(1) : x; }
  function isAtf(e, t) { return e !== t && (stripWF(e) === t || stripWF(t) === e || stripWF(e) === stripWF(t)); }

  // isti'adha, basmala and «صدق الله العظيم» may be said anywhere
  var OPT = ['اعوذ بالله من الشيطان الرجيم', 'اعوذ بالله السميع العليم من الشيطان الرجيم',
    'بسم الله الرحمن الرحيم', 'صدق الله العظيم', 'امين'].map(function (s) { return s.split(' '); });

  // E: expected words; as[k] / pas[k]: index in E of the first word of k's
  // ayah / of the ayah before it (-1 = none)
  function makeCtx(E, as, pas, o) {
    o = o || {};
    return { E: E, N: E.length, as: as, pas: pas, eq: o.level === 'very' ? eqVery : eqStrict, uns: o.level !== 'very',
      reveal: o.reveal == null ? 3 : o.reveal, pauseOnFinal: o.pauseOnFinal !== false,
      sim: o.sim || function (a, b) { return a === b ? 1 : 0; } };
  }
  // base: the first word of the test (the reciter started mid-ayah); the words before it are left open
  function create(N, base) {
    base = base || 0;
    return { i: base, base: base, st: new Uint8Array(N), tries: new Uint8Array(N), ty: new Uint16Array(N),
      run: -1, runLen: 0, runKind: 0, runTok: '', runNew: false, shadow: -1, opt: -1, optJ: 0, pendAt: -1, pendLen: 0, pendTok: '' };
  }
  function clone(T) {
    return { i: T.i, base: T.base, st: T.st.slice(), tries: T.tries.slice(), ty: T.ty.slice(), run: T.run, runLen: T.runLen,
      runKind: T.runKind, runTok: T.runTok, runNew: T.runNew, shadow: T.shadow, opt: T.opt, optJ: T.optJ,
      pendAt: T.pendAt, pendLen: T.pendLen, pendTok: T.pendTok };
  }
  function matchAt(X, i, t, nx) {
    var E = X.E;
    if (i >= X.N) return null;
    if (X.eq(E[i], t)) return { e: 1, t: 1 };
    if (i + 1 < X.N && X.eq(E[i] + E[i + 1], t)) return { e: 2, t: 1 };        // «يا ايها» written as one word
    if (nx != null && X.eq(E[i], t + nx)) return { e: 1, t: 2 };                // one word written as two
    return null;
  }
  // going back is no mistake: the word just said (k = i-1) at once; the start
  // of this or the previous ayah, or any of the last 20 words, when the next
  // heard word goes on from there. A word that is the expected one with a
  // و / ف more or less («اياك» at «واياك», which also opens the ayah) needs
  // that next word: alone it is the mistake. -1 = no, -2 = cannot tell yet
  function backTo(X, i, t, nx, waiting) {
    var E = X.E;
    if (i <= 0) return -1;
    if (X.eq(E[i - 1], t)) return i - 1;
    var cands = [], a = X.as[i] === i ? X.pas[i] : X.as[i];
    if (a >= 0 && a < i) cands.push(a);
    if (X.pas[i] >= 0 && X.pas[i] < i && cands.indexOf(X.pas[i]) < 0) cands.push(X.pas[i]);
    for (var k = i - 2; k >= Math.max(0, i - 20); k--) if (cands.indexOf(k) < 0) cands.push(k);
    var undecided = false, nearCur = isAtf(E[i], t);
    for (var c = 0; c < cands.length; c++) {
      k = cands[c];
      if (!X.eq(E[k], t)) continue;
      if (nx != null) { if (k + 1 >= i || X.eq(E[k + 1], nx)) return k; continue; }
      if (waiting) undecided = true;
      else if (!nearCur && (k === X.as[i] || k === X.pas[i])) return k;   // restarted the ayah, then paused
    }
    return undecided ? -2 : -1;
  }
  function classify(X, i, t) {
    var E = X.E;
    for (var d = 1; d <= 4 && i + d < X.N; d++) if (X.eq(E[i + d], t)) return T_SKIP;
    if (i + 2 < X.N && X.eq(E[i + 1] + E[i + 2], t)) return T_SKIP;
    if (isAtf(E[i], t)) return T_ATF;
    return T_SUB;
  }
  // Chrome wrote a correctly said word otherwise («كل» for «كلا», «الاردن هذا»
  // for «الارض مهادا»): the heard words go on exactly from the next one or two
  // expected words. -> {a: expected words shown yellow, b: heard tokens they
  // took}; a later word said here (a skip) or a و / ف more or less stays a
  // mistake. The words heard at this word just before a pause count too
  // (credit). null = a mistake, -2 = cannot tell yet
  var UNS_TRY = [[1, 0], [2, 0], [1, 1], [1, 2], [2, 2]];
  // a particle said instead of another («في» for «بـ», «من» for «في») is the reciter's, not Chrome's
  var PARTICLES = ['في', 'من', 'على', 'الى', 'عن', 'ب', 'ل', 'ك', 'و', 'ف', 'لا', 'ما', 'ان', 'قد', 'لم', 'لن', 'ثم', 'او', 'بل'];
  function unsure(T, X, i, toks, j, final) {
    var E = X.E, credit = T.pendAt === i ? T.pendLen : 0, wait = false;
    for (var u = 0; u < UNS_TRY.length; u++) {
      var a = UNS_TRY[u][0], b = UNS_TRY[u][1];
      if (b === 0 && credit < a) continue;
      if (i + a > X.N) continue;
      var bad = false;
      for (var q = 0; q < b && !bad; q++) {
        var h = toks[j + q];
        if (h == null || (!final && j + q === toks.length - 1)) { if (!final) wait = true; bad = true; break; }
        for (var d = 0; d <= 4 && i + d < X.N; d++) if (X.eq(E[i + d], h)) bad = true;
        if (isAtf(E[i], h) || PARTICLES.indexOf(h) >= 0) bad = true;
      }
      if (bad) continue;
      var need = Math.min(2, X.N - i - a), got = 0, len = 0;
      if (need <= 0) continue;   // the last word: nothing after it to tell
      for (q = 0; q < need; q++) {
        var x = j + b + q, tk = toks[x];
        if (tk == null || (!final && x === toks.length - 1)) { if (!final) wait = true; break; }
        if (!X.eq(E[i + a + q], tk)) { got = -1; break; }
        got++; len += tk.length;
      }
      if (got === need || (final && got > 0 && len >= 4 && toks[j + b + got] == null)) return { a: a, b: b };
    }
    return wait ? -2 : null;
  }
  function markUns(T, k) {
    if (T.st[k] === S_ERR && T.tries[k] <= 1 && !(T.ty[k] & ~T_SUB)) { T.ty[k] = 0; T.tries[k] = 0; }
    T.st[k] = T.st[k] === S_ERR && T.ty[k] ? S_FIX : S_UNS;
  }
  function accept(T, k) {
    if (T.st[k] === S_ERR) T.st[k] = S_FIX;
    else if (T.st[k] === S_HID) T.st[k] = S_OK;
  }
  function feed(T, X, toks, final) {
    var E = X.E;
    for (var j = 0; j < toks.length; j++) {
      if (T.i >= X.N) break;
      var t = toks[j], nx = j + 1 < toks.length ? toks[j + 1] : null, last = j === toks.length - 1;
      if (!t) continue;
      if (T.shadow >= 0) {                       // repeating words already said
        if (X.eq(E[T.shadow], t)) { if (T.st[T.shadow] === S_UNS) T.st[T.shadow] = S_OK; T.shadow++; if (T.shadow >= T.i) T.shadow = -1; T.run = -1; continue; }
        T.shadow = -1;
      }
      var i = T.i, m = matchAt(X, i, t, nx);
      if (m) {
        if (T.run === i && T.runLen === 1 && T.runNew) {   // what the one wrong word before it really was
          if (T.runKind === T_SKIP && i + 1 < X.N && X.eq(E[i + 1], T.runTok)) T.ty[i] = (T.ty[i] & ~T_SKIP) | T_ORDER;
          else if (T.runKind === T_SUB && X.sim(T.runTok, E[i]) < 0.5) T.ty[i] = (T.ty[i] & ~T_SUB) | T_EXTRA;
        }
        if (X.uns && T.pendAt === i && T.st[i] === S_ERR && T.tries[i] === 1 && T.ty[i] === T_SUB && X.sim(T.pendTok, E[i]) >= 0.7) {
          T.st[i] = S_UNS; T.ty[i] = 0; T.tries[i] = 0;   // red after a pause, then said again at once: Chrome misheard it
        }
        for (var q = 0; q < m.e; q++) accept(T, i + q);
        T.i = i + m.e; j += m.t - 1; T.run = -1; T.opt = -1; T.pendAt = -1;
        continue;
      }
      var k = backTo(X, i, t, nx, last && !final);
      if (k === -2) break;
      if (k >= 0) { if (T.st[k] === S_UNS) T.st[k] = S_OK; T.shadow = k + 1 < i ? k + 1 : -1; T.run = -1; continue; }   // a yellow word said again and heard right
      if (T.opt >= 0) {                          // inside the isti'adha / basmala
        var p = OPT[T.opt], at = p.indexOf(t, T.optJ);
        if (at >= 0) { T.optJ = at + 1; if (T.optJ >= p.length) T.opt = -1; continue; }
        T.opt = -1;
      }
      var o = -1;
      for (var z = 0; z < OPT.length && o < 0; z++) if (OPT[z][0] === t) o = z;
      if (o >= 0) { T.opt = o; T.optJ = 1; continue; }
      if (X.uns && T.run !== i) {
        var u = unsure(T, X, i, toks, j, final);
        if (u === -2) break;
        if (u) {
          for (q = 0; q < u.a; q++) markUns(T, i + q);
          T.i = i + u.a; j += u.b - 1; T.run = -1; T.opt = -1; T.pendAt = -1;
          continue;
        }
      }
      if (!final) break;                         // interim words may still change: a mistake waits for the final ones
      if (T.run !== i) {                         // a new attempt at this word
        var kind = classify(X, i, t);
        T.tries[i] = Math.min(255, T.tries[i] + 1);
        T.runNew = !(T.ty[i] & kind); T.ty[i] |= kind;
        T.run = i; T.runLen = 0; T.runKind = kind; T.runTok = t;
        T.st[i] = S_ERR;
        if (X.reveal && T.tries[i] >= X.reveal) {
          T.st[i] = S_REV; T.ty[i] |= T_REV; T.i = i + 1; T.run = -1;
          if (matchAt(X, T.i, t, nx)) j--;       // the reciter went on: this word may be the next one
          continue;
        }
      }
      T.runLen++;
    }
    if (final && X.pauseOnFinal) {               // a pause ends the attempt; what was heard there may still be Chrome's
      T.pendAt = T.run === T.i && T.runKind === T_SUB ? T.i : -1; T.pendLen = T.runLen; T.pendTok = T.runTok;
      T.run = -1;
    }
    return T;
  }
  // voice: show the word at the cursor (help); eye: next / back / «أخطأت»
  function hint(T, X) {
    if (T.i >= X.N) return false;
    T.st[T.i] = S_HINT; T.ty[T.i] |= T_HINT; T.i++; T.run = -1; T.shadow = -1;
    return true;
  }
  function eyeNext(T, X) {
    if (T.i >= X.N) return false;
    T.st[T.i] = (T.ty[T.i] & T_MARK) ? S_MARK : S_OK; T.i++;
    return true;
  }
  function eyeBack(T) {
    if (T.i <= (T.base || 0)) return false;
    T.i--; T.st[T.i] = S_HID;
    return true;
  }
  function eyeMark(T) {
    var k = T.i - 1;
    if (k < 0) return 0;
    if (T.ty[k] & T_MARK) { T.ty[k] &= ~T_MARK; T.tries[k] = Math.max(0, T.tries[k] - 1); T.st[k] = S_OK; return -1; }
    T.ty[k] |= T_MARK; T.tries[k] = Math.min(255, T.tries[k] + 1); T.st[k] = S_MARK; return 1;
  }
  function summary(T, X) {
    var n = { reached: 0, ok: 0, err: 0, uns: 0, types: {} }, end = Math.min(X.N - 1, T.i);
    for (var k = T.base || 0; k <= end; k++) {   // nothing past the cursor was touched
      if (k >= T.i && T.st[k] === S_HID) continue;
      n.reached++;
      if (T.ty[k]) { n.err++; TYPES.forEach(function (ty) { if (T.ty[k] & ty[0]) n.types[ty[0]] = (n.types[ty[0]] || 0) + 1; }); }
      else { n.ok++; if (T.st[k] === S_UNS) n.uns++; }
    }
    return n;
  }

  var Core = { create: create, clone: clone, feed: feed, makeCtx: makeCtx, hint: hint, eyeNext: eyeNext, eyeBack: eyeBack,
    eyeMark: eyeMark, summary: summary, eqVery: eqVery, eqStrict: eqStrict, TYPES: TYPES,
    S: { HID: S_HID, OK: S_OK, ERR: S_ERR, FIX: S_FIX, REV: S_REV, HINT: S_HINT, MARK: S_MARK, UNS: S_UNS }, unsure: unsure,
    T: { SKIP: T_SKIP, SUB: T_SUB, ATF: T_ATF, EXTRA: T_EXTRA, ORDER: T_ORDER, HINT: T_HINT, REV: T_REV, MARK: T_MARK } };
  if (!HAS_DOM) { if (typeof module !== 'undefined' && module.exports) module.exports = Core; return; }

  /* ------------------------------ helpers ------------------------------ */
  var PREF_KEY = 'tasmee_prefs', LOG_KEY = 'tasmee_log.v1';
  function readJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  function call(name) { var f = g(name); if (typeof f === 'function') return f.apply(null, [].slice.call(arguments, 1)); }
  function toast(m) { call('showToast', m); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function R() { return G.ReciteByMic; }
  function C() { var r = R(); if (!r) return null; if (!r.corpus()) r.buildIndex(); return r.corpus(); }
  function touch() { return !!(G.matchMedia && G.matchMedia('(pointer: coarse)').matches); }
  function typing(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
  function otherOverlay() { return document.querySelector('.al-backdrop, .st-backdrop, .rs-modal, .al-pop, .search-modal-backdrop.active, .tafsir-modal-backdrop.active, .tsm-modal'); }
  function micOn() { var S = R() && R()._session; return !!(S && S.active); }
  function visiblePages() { return g('isDoublePageMode') ? [g('currentRightPage'), g('currentLeftPage')].filter(Boolean) : [g('currentPage')]; }
  function cardFor(page) {
    if (g('isDoublePageMode')) {
      if (page === g('currentRightPage')) return document.getElementById('mushafCardRight');
      if (page === g('currentLeftPage')) return document.getElementById('mushafCardLeft');
      return null;
    }
    return page === g('currentPage') ? document.getElementById('mushafCardRight') : null;
  }
  function plural(n, one, two, few, many) { return n === 1 ? one : n === 2 ? two : (n >= 3 && n <= 10) ? n + ' ' + few : n + ' ' + many; }
  function triesTxt(n) { return plural(n, 'محاولة واحدة', 'محاولتان', 'محاولات', 'محاولة'); }
  function ayahTxt(n) { return plural(n, 'آية واحدة', 'آيتان', 'آيات', 'آية'); }
  function sessTxt(n) { return plural(n, 'جلسة واحدة', 'جلستين', 'جلسات', 'جلسة'); }
  function wordsTxt(n) { return plural(n, 'كلمة واحدة', 'كلمتان', 'كلمات', 'كلمة'); }
  function typeNames(bits) { return TYPES.filter(function (t) { return bits & t[0]; }).map(function (t) { return t[1]; }); }
  function dateTxt(ts) { try { return new Date(ts).toLocaleDateString('ar-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }

  var prefs = Object.assign({ mode: 'voice', level: 'strict', reveal: 3, ears: 'chrome' }, readJSON(PREF_KEY, {}));
  if (prefs.mode !== 'eye') prefs.mode = 'voice';
  function savePrefs() { writeJSON(PREF_KEY, prefs); }

  /* raw words of an ayah as the page shows them (boxes follow these), and the
     raw index of every normalised word */
  var rawCache = {};
  function rawOf(ai) {
    if (rawCache[ai]) return rawCache[ai];
    var a = C().ayahs[ai];
    var raw = String(a.rawText || '').replace(/\(\d+\)\s*$/, '').trim().split(/\s+/).filter(Boolean);
    var idx = [];
    raw.forEach(function (w, r) { if (R().normalize(w)) idx.push(r); });
    return (rawCache[ai] = { raw: raw, idx: idx });
  }
  var pageAyahs = null;   // page -> its ayah indices
  function ayahsOn(page) {
    if (!pageAyahs) { pageAyahs = {}; C().ayahs.forEach(function (a, i) { (pageAyahs[a.page] = pageAyahs[a.page] || []).push(i); }); }
    return pageAyahs[page] || [];
  }

  /* ------------------------------ the mode ------------------------------
   * st = the running mode (null = off). One mode = one or more segments: a
   * segment is a test from where the reciter started (voice: found from the
   * first words, like the highlight; eye: the top of the page) onward, page
   * after page. Turning the page by hand ends the segment and starts another
   * there. st.X/T = the segment's test, null while waiting for the start.
   * st.acc = what the closed segments added up to. */
  var st = null;

  function newAcc() { return { reached: 0, ok: 0, err: 0, uns: 0, types: {}, errs: [], added: 0, t0: Date.now(), first: null, fixed: null }; }

  // ayah indices -> expected words with their places
  function buildTest(ayahIdx, base) {
    var c = C(), E = [], as = [], pas = [], at = [], first = {}, prevStart = -1, lastAi = -2;
    ayahIdx.forEach(function (ai) {
      var a = c.ayahs[ai], start = E.length, ps = (ai === lastAi + 1 && c.ayahs[ai].sura === c.ayahs[lastAi].sura) ? prevStart : -1;
      first[ai] = start;
      for (var w = 0; w < a.words.length; w++) { E.push(a.words[w]); as.push(start); pas.push(ps); at.push({ ai: ai, w: w }); }
      prevStart = start; lastAi = ai;
    });
    st.X = makeCtx(E, as, pas, { level: prefs.level, reveal: +prefs.reveal, sim: R().wordSim });
    st.T = st.shown = create(E.length, base || 0);
    st.at = at; st.first = first; st.seg0 = Date.now();
    if (!st.acc.first && !st.fixed) st.acc.first = { ai: ayahIdx[0], w: base || 0 };
  }
  // a test from word w of ayah ai to the end of the Quran
  function anchorAt(ai, w) {
    var list = [];
    for (var i = ai; i < C().ayahs.length; i++) list.push(i);
    buildTest(list, w);
  }
  function anchorPageTop() {
    var page = visiblePages()[0], list = ayahsOn(page);
    if (list.length) anchorAt(list[0], 0);
  }

  function start(o) {
    o = o || {};
    if (!C()) { toast('بيانات المصحف لم تُحمّل بعد'); return false; }
    if (st) stop(true);
    closeDone(); closeModal();
    var mode = o.mode || prefs.mode;
    if (mode === 'voice' && !(G.SpeechRecognition || G.webkitSpeechRecognition) && localStorage.getItem('recite_ears') !== 'quran') {
      toast('المتصفح لا يدعم التعرّف الصوتي هنا: التسميع بالعين'); mode = 'eye';
    }
    st = { mode: mode, X: null, T: null, shown: null, at: null, first: null, pre: [], heard: [], lastHeard: '', warn: '',
      acc: newAcc(), fixed: o.ayahs && o.ayahs.length ? o.ayahs.slice() : null };
    st.acc.fixed = st.fixed;
    if (st.fixed) buildTest(st.fixed, 0);
    else if (o.at) anchorAt(o.at.ai, o.at.w);
    else if (mode === 'eye') anchorPageTop();
    document.body.classList.add('tsm-on');
    document.body.classList.toggle('tsm-voice', mode === 'voice');
    document.body.classList.toggle('tsm-eye', mode === 'eye');
    headerBtn();
    if (st.X) followCursor();
    buildLayers();
    if (mode === 'voice') {
      var dock = document.getElementById('voiceFloatingDock');
      st.dockWas = !!(dock && dock.classList.contains('show'));
      st.ownMic = !micOn();
      if (st.ownMic) call('startVoiceRecitation');
      watchWarnings();
    }
    setIdleStatus();
    paint();
    showPage();
    if (window.TasmeeRecorder) TasmeeRecorder.onStart(st);
    if (prefs.ears === 'tilawi' && window.TasmeeEars) TasmeeEars.load();
    return true;
  }
  // the covered page in view, under the sticky header and the bar
  function showPage() {
    var card = cardFor(visiblePages()[0]), bar = document.getElementById('tsmBar'), hd = document.querySelector('header');
    if (!card || !G.scrollTo) return;
    var top = card.getBoundingClientRect().top, above = (hd && getComputedStyle(hd).position === 'sticky' ? hd.offsetHeight : 0) + (bar ? bar.offsetHeight + 12 : 0);
    if (top < above || top > G.innerHeight * 0.5) G.scrollTo({ top: G.scrollY + top - above - 6, behavior: 'smooth' });
  }
  // end the mode: covers off, the session saved, a short summary
  function stop(silent) {
    if (!st) return;
    var s = st;
    s.stopping = true;
    if (window.TasmeeRecorder) TasmeeRecorder.onStop(s);
    if (window.TasmeeEars) TasmeeEars.reset();
    closeSegment();
    st = null;
    if (s.ownMic && micOn()) call('stopVoiceRecitation');
    if (s.warnObs) s.warnObs.disconnect();
    var alert = document.getElementById('dockMicAlertBanner');   // the mode opened the dock: close it, unless it holds a mic alert
    if (s.mode === 'voice' && !s.dockWas && !(alert && alert.style.display === 'flex')) call('minimizeVoiceDock');
    document.querySelectorAll('.tsm-layer').forEach(function (el) { el.remove(); });
    var bar = document.getElementById('tsmBar'); if (bar) bar.remove();
    document.body.classList.remove('tsm-on', 'tsm-voice', 'tsm-eye');
    headerBtn();
    lastAcc = s.acc;
    if (silent) return;
    if (s.acc.reached) showDone(s.acc);
    else toast('أُوقف وضع التسميع');
  }
  function toggle() { if (st) stop(); else start(); }
  function setIdleStatus() {
    if (!st) return;
    if (st.mode === 'eye') st.status = touch() ? 'انقر الصفحة أو «التالية» لتكشف الكلمة، و✗ إن أخطأت فيها' : 'Home للكلمة التالية، End للسابقة، Delete إن أخطأت';
    else if (!st.X) st.status = 'اقرأ من أي موضع: أعرف مكانك من أول كلماتك';
    else st.status = 'التالية من ' + where(st.shown.i);
  }
  function wordAt(k) { var p = st.at[k], r = rawOf(p.ai); return r.raw[r.idx[p.w]] || C().ayahs[p.ai].words[p.w]; }
  function where(k) {
    var c = C(), p = st.at[Math.min(k, st.at.length - 1)], a = c.ayahs[p.ai];
    return a.suraName + ' ' + a.aya;
  }

  /* close the running segment: into the log and the mode's totals */
  function closeSegment() {
    if (!st || !st.X) return;
    st.T = st.shown = st.T;   // drop an interim replay
    var n = summary(st.T, st.X);
    if (n.reached) {
      var r = record(), A = st.acc;
      A.reached += n.reached; A.ok += n.ok; A.err += n.err; A.uns += n.uns; A.added += r.added;
      Object.keys(n.types).forEach(function (t) { A.types[t] = (A.types[t] || 0) + n.types[t]; });
      A.errs = A.errs.concat(r.errs);
    }
    st.X = st.T = st.shown = st.at = st.first = null;
    st.pre = [];
  }
  // the reader turned the page by hand: the test moves there
  function rearm() {
    closeSegment();
    if (st.mode === 'eye') anchorPageTop();
    setIdleStatus();
  }

  /* ------------------------------ heard words ---------------------------- */
  function takesWords() { return !!(st && st.mode === 'voice'); }
  // where the reciter started: the corpus position from which all the heard
  // words (noise at the start dropped) run on exactly. The open page wins;
  // elsewhere the words must single out one place. -> {pos, from} | null = wait
  function locate(toks) {
    var c = C(), W = c.words, eq = prefs.level === 'very' ? eqVery : eqStrict, pages = visiblePages();
    for (var s = 0; s < toks.length; s++) {
      var t0 = toks[s], seeds = [];
      [t0, 'و' + t0, 'ف' + t0].forEach(function (v) { var l = c.uni.get(v); if (l) seeds = seeds.concat(l); });
      var cands = seeds.filter(function (p) {
        if (c.virt[p]) return false;
        for (var j = s; j < toks.length; j++) { var q = p + j - s; if (q >= c.L || !eq(W[q], toks[j])) return false; }
        return true;
      });
      if (!cands.length) continue;
      var n = toks.length - s;
      var vis = cands.filter(function (p) { return pages.indexOf(c.ayahs[c.ayahOf[p]].page) >= 0; });
      if (vis.length) {
        var p0 = vis[0];
        if (vis.length === 1 && (n >= 2 || c.wordOf[p0] === 0)) return { pos: p0, from: s };
        return n >= 5 ? { pos: p0, from: s } : null;
      }
      if (cands.length === 1 && n >= 3) return { pos: cands[0], from: s };
      if (n >= 7) {   // still twins: the one nearest the open page
        var pg = pages[0];
        cands.sort(function (a, b) { return Math.abs(c.ayahs[c.ayahOf[a]].page - pg) - Math.abs(c.ayahs[c.ayahOf[b]].page - pg); });
        return { pos: cands[0], from: s };
      }
      return null;
    }
    return null;
  }
  // the isti'adha / basmala before the first word: dropped (page 1 keeps its
  // basmala, it is 1:1); a phrase still being said -> null = wait
  function dropOpeners(toks) {
    if (visiblePages().indexOf(1) >= 0) return toks;
    for (var again = true; again;) {
      again = false;
      for (var z = 0; z < OPT.length; z++) {
        var p = OPT[z], m = 0;
        while (m < p.length && m < toks.length && p[m] === toks[m]) m++;
        if (!m) continue;
        if (m === toks.length && m < p.length) return null;
        if (m === p.length) { toks = toks.slice(m); again = true; break; }
      }
    }
    return toks;
  }
  function tryAnchor(committed, interim) {
    var all = committed.concat(interim.slice(0, -1)), toks = dropOpeners(all);
    if (!toks || !toks.length) return false;
    var hit = locate(toks);
    if (!hit) return false;
    var c = C(), pos = hit.pos, skipped = all.length - toks.length + hit.from, w0 = c.wordOf[pos];
    // words heard before an ayah's 2nd/3rd word: its first words, written otherwise by Chrome («ان يتساءلون»)
    var snap = w0 >= 1 && w0 <= 2 && hit.from >= w0;
    anchorAt(c.ayahOf[pos], snap ? 0 : w0);
    if (snap) { for (var q = 0; q < w0; q++) st.T.st[q] = S_UNS; st.T.i = w0; }
    var cm = committed.slice(Math.min(skipped, committed.length));
    if (cm.length) feed(st.T, st.X, cm, true);
    st.shown = st.T;
    st.pre = [];
    st.skipIv = Math.max(0, skipped - committed.length);   // the utterance still being said begins before the start
    followCursor();
    buildLayers();
    return true;
  }
  function heard(words, raw, final) {
    if (!takesWords()) return;
    var S = R()._session;
    st.warn = '';
    var shownHeard = final ? (st.heard = st.heard.concat(raw || words).slice(-12)) : st.heard.concat(raw || words).slice(-12);
    var sp = document.getElementById('dockSpeechText'); if (sp) sp.textContent = '"' + shownHeard.slice(-8).join(' ') + '"';
    st.lastHeard = shownHeard.slice(-6).join(' ');
    if (final && window.TasmeeRecorder) TasmeeRecorder.onHeard(st, words, raw, final);
    if (!st.X) {   // where does the reciter start?
      if (final) st.pre = st.pre.concat(words).slice(-24);
      if (!tryAnchor(st.pre, final ? [] : words)) {
        if (final && st.pre.length >= 4) st.status = 'لم أعرف موضعك بعد… تابع القراءة، أو 💡 لتبدأ من أول الصفحة';
        renderBar();
        return;
      }
      if (final) { st.skipIv = 0; afterChange(); return; }
    }
    st.X.pauseOnFinal = !(S && S.ears === 'local');   // the local model commits mid-speech
    var ws = st.skipIv ? words.slice(st.skipIv) : words;
    var k0 = st.T ? st.T.i : -1;
    if (final) { st.skipIv = 0; if (ws.length) feed(st.T, st.X, ws, true); st.shown = st.T; }
    else st.shown = ws.length ? feed(clone(st.T), st.X, ws, false) : st.T;
    afterChange();
    if (final && prefs.ears === 'tilawi' && window.TasmeeEars && TasmeeEars.ready() && k0 >= 0) {
      var snapshot = st;
      var p0 = snapshot.at && snapshot.at[k0];
      var a0 = p0 ? C().ayahs[p0.ai] : null;
      if (a0) {
        TasmeeEars.review(snapshot, k0, a0.sura, a0.aya, p0.w).then(function (res) {
          if (!res || !res.ready || res.score == null || !snapshot.T || !snapshot.X) return;
          var T = snapshot.T, X = snapshot.X;
          if (k0 < 0 || k0 >= X.N) return;
          var state = T.st[k0];
          if (res.ok) {
            if (state === 2) { T.st[k0] = 1; T.ty[k0] = 0; T.tries[k0] = 0; snapshot.status = '✅ «' + X.E[k0] + '» أكدت الأذن القرآنية صحتها'; }
          } else {
            if (state === 1) { T.st[k0] = 2; T.ty[k0] = 2; T.tries[k0] = 1; snapshot.status = '✗ «' + X.E[k0] + '» الأذن القرآنية لم تسمعها صحيحة'; }
          }
          if (st === snapshot) afterChange();
        });
      }
    }
  }
  function afterChange() {
    if (!st || !st.X) { renderBar(); return; }
    var T = st.shown, X = st.X;
    if (T.i < X.N && T.st[T.i] === S_ERR) {
      var left = X.reveal ? X.reveal - T.tries[T.i] : 0;
      st.status = '✗ ' + typeNames(T.ty[T.i] & 31).join('، ') + ' — أعد الكلمة الحمراء' +
        (X.reveal ? ' (' + triesTxt(T.tries[T.i]) + '، تنكشف بعد ' + (left === 1 ? 'محاولة أخرى' : left === 2 ? 'محاولتين' : left + ' محاولات') + ')' : ' (' + triesTxt(T.tries[T.i]) + ')');
    } else if (T.i < X.N && st.mode === 'voice') {
      var u = -1;
      for (var k = T.i - 1; k >= Math.max(T.base, T.i - 4) && u < 0; k--) if (T.st[k] === S_UNS) u = k;
      st.status = u >= 0 ? '🟡 «' + wordAt(u) + '» لم تُحسب خطأً: كتبها Chrome على غير ما قرأت. المسها إن كنت أخطأت فيها'
        : 'التالية من ' + where(T.i);
    }
    followCursor();
    paint();
    if (st.T.i >= X.N) stop();   // the end of the range (or of the Quran)
  }
  // the engine's own warnings (no speech, no network...) land in the dock, which the mode hides
  function watchWarnings() {
    var el = document.getElementById('dockSpeechText');
    if (!el || typeof MutationObserver === 'undefined') return;
    st.warnObs = new MutationObserver(function () {
      if (!st) return;
      var t = el.textContent || '';
      if (/^\s*⚠/.test(t) && t !== st.warn) { st.warn = t; renderBar(); }
    });
    st.warnObs.observe(el, { childList: true, characterData: true, subtree: true });
  }
  // the mic was switched off outside the mode (its dock or header button, a denied permission): the mode ends with it
  function onMicStop() { if (st && st.mode === 'voice' && !st.pausing && !st.stopping) stop(); }

  /* --------------------------------- actions ---------------------------- */
  function doHint() {
    if (!st) return;
    if (st.mode === 'eye') return doNext();
    if (!st.X) { anchorPageTop(); followCursor(); buildLayers(); }
    if (st.X && hint(st.T, st.X)) { st.shown = st.T; afterChange(); }
  }
  function doNext(ayah) {
    if (!st) return;
    if (st.mode === 'voice') return doHint();
    if (!st.X) anchorPageTop();
    var T = st.T, X = st.X, a = T.i < X.N ? st.at[T.i].ai : -1;
    do { if (!eyeNext(T, X)) break; } while (ayah && T.i < X.N && st.at[T.i].ai === a);
    st.shown = T; afterChange();
  }
  function doBack(ayah) {
    if (!st || st.mode !== 'eye' || !st.X) return;
    var T = st.T;
    if (ayah) {   // to the start of this ayah, or of the one before when already there
      if (T.i > T.base && T.i < st.X.N && st.X.as[T.i] === T.i) eyeBack(T);
      var s = Math.max(T.base, T.i < st.X.N ? st.X.as[T.i] : st.X.as[T.i - 1]);
      while (T.i > s && eyeBack(T)) {}
    } else eyeBack(T);
    st.shown = T; afterChange();
  }
  function doMark() {
    if (!st || st.mode !== 'eye' || !st.X) return;
    if (!eyeMark(st.T)) { toast(touch() ? 'اكشف كلمة أولًا' : 'اكشف كلمة أولًا (Home)'); return; }
    st.shown = st.T; afterChange();
  }
  function togglePause() {
    if (!st || st.mode !== 'voice') return;
    if (micOn()) { st.pausing = true; call('stopVoiceRecitation'); st.pausing = false; st.status = '⏸ المايك متوقف: ▶ للمتابعة'; }
    else { call('startVoiceRecitation'); st.ownMic = true; setIdleStatus(); }
    renderBar();
    setTimeout(renderBar, 80);
  }

  /* --------------------------------- pages ------------------------------ */
  function cursorPage() {
    var k = Math.min(st.shown.i, st.X.N - 1);
    return C().ayahs[st.at[k].ai].page;
  }
  function followCursor() {
    if (!st || !st.X) return;
    var page = cursorPage();
    if (visiblePages().indexOf(page) < 0) { st.turning = true; try { call('goToPage', page); } finally { if (st) st.turning = false; } }
  }
  function onPage() {
    if (!st) return;
    if (st.X && !st.turning && !st.fixed && visiblePages().indexOf(cursorPage()) < 0) rearm();
    buildLayers();
  }
  function buildLayers() {
    document.querySelectorAll('.tsm-layer').forEach(function (el) { el.remove(); });
    if (!st) return;
    var getBoxes = g('getAyahWordBoxes'), place = g('placeOnMushaf');
    if (typeof getBoxes !== 'function' || typeof place !== 'function') return;
    var c = C();
    visiblePages().forEach(function (page) {
      var card = cardFor(page); if (!card) return;
      var layer = document.createElement('div');
      layer.className = 'tsm-layer'; layer.setAttribute('data-page', page);
      ayahsOn(page).forEach(function (ai) {
        var k0 = -1;
        if (st.X) { if (!(ai in st.first)) return; k0 = st.first[ai]; }   // not in the test: left open
        var a = c.ayahs[ai], boxes = getBoxes(a.sura, a.aya) || [], ro = rawOf(ai);
        for (var w = 0; w < a.words.length; w++) {
          var b = boxes[ro.idx[w]];
          if (!b || b.page !== page) continue;
          var k = k0 >= 0 ? k0 + w : -1;
          if (st.X && k < st.T.base) continue;   // before where the reciter started
          var el = document.createElement('div');
          el.className = 'tsm-w'; el.setAttribute('data-k', k);
          place(el, b, -3);   // a little taller than the box: no letter tails or marks peek out
          layer.appendChild(el);
        }
      });
      card.appendChild(layer);
    });
    paint();
  }
  var CLS = ['', ' tsm-ok', ' tsm-err', ' tsm-fix', ' tsm-fix', ' tsm-fix', ' tsm-fix', ' tsm-uns'];
  function paint() {
    if (!st) return;
    var T = st.shown;
    document.querySelectorAll('.tsm-w').forEach(function (el) {
      var k = +el.getAttribute('data-k');
      var c = T && k >= 0 ? 'tsm-w' + CLS[T.st[k]] + (k === T.i ? ' tsm-cur' : '') : 'tsm-w';
      if (el.className !== c) el.className = c;
    });
    renderBar();
  }
  function headerBtn() {
    var b = document.getElementById('tasmeeBtn'); if (!b) return;
    var on = !!st;
    b.classList.toggle('tsm-active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? 'إنهاء وضع التسميع (Esc)' : 'وضع التسميع: تُغطّى الكلمات وتنكشف حين تقرؤها صحيحة';
    var t = b.querySelector('span:nth-child(2)'); if (t) t.textContent = on ? 'إنهاء التسميع' : 'وضع التسميع';
  }

  /* ---------------------------------- bar ------------------------------- */
  function ensureBar() {
    var bar = document.getElementById('tsmBar');
    if (bar) return bar;
    var anchor = document.getElementById('readerStrip') || document.querySelector('.reader-controls-bar');
    if (!anchor) return null;
    bar = document.createElement('div');
    bar.id = 'tsmBar'; bar.className = 'tsm-bar'; bar.setAttribute('dir', 'rtl');
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tsm]'); if (!b || !st) return;
      var a = b.getAttribute('data-tsm');
      if (a === 'mic') togglePause();
      if (a === 'next') doNext();
      if (a === 'back') doBack();
      if (a === 'hint') doHint();
      if (a === 'rec') { if (window.TasmeeRecorder) TasmeeRecorder.openPanel(); }
      if (a === 'mark') doMark();
      if (a === 'log') openLog();
      if (a === 'end') stop();
    });
    return bar;
  }
  function lbl(t) { return '<span class="tsm-lbl"> ' + t + '</span>'; }   // hidden on a phone: the icon stays
  function renderBar() {
    var bar = ensureBar(); if (!bar || !st) return;
    var hd = document.querySelector('header');   // sticks under the sticky header, not over it
    bar.style.top = ((hd && getComputedStyle(hd).position === 'sticky' ? hd.offsetHeight : 0) + 6) + 'px';
    var voice = st.mode === 'voice', T = st.shown, X = st.X, A = st.acc;
    var n = X ? summary(T, X) : { reached: 0, ok: 0, err: 0 };
    var ok = A.ok + n.ok, err = A.err + n.err;
    var errNow = X && T.i < X.N && T.st[T.i] === S_ERR;
    var place = X ? where(T.i) : 'ص ' + visiblePages().join('–');
    var status = st.warn && voice ? st.warn : st.status;
    bar.innerHTML =
      '<div class="tsm-row">' +
        '<span class="tsm-title">' + (voice ? '🎙️' : '👁') + ' التسميع<small>' + esc(place) + '</small></span>' +
        '<span class="tsm-c tsm-c-ok" title="صحيحة من أول مرة">✓ ' + ok + '</span>' +
        '<span class="tsm-c tsm-c-err" title="كلمات فيها خطأ">✗ ' + err + '</span>' +
        '<span class="tsm-sp"></span>' +
        (voice ? '<button class="tsm-b" data-tsm="mic" title="' + (micOn() ? 'أوقف المايك مؤقتًا' : 'شغّل المايك') + '">' + (micOn() ? '⏸' + lbl('إيقاف مؤقت') : '▶' + lbl('متابعة')) + '</button>' +
          '<button class="tsm-b" data-tsm="hint" title="اكشف الكلمة التالية (Home) — تُسجَّل خطأً">💡' + lbl('مساعدة') + '</button>' +
          '<button class="tsm-b tsm-rec' + (window.TasmeeRecorder && TasmeeRecorder.isRecording() ? ' tsm-rec-on' : '') + '" data-tsm="rec" title="تسجيل الجلسة (اختياري)">🎙️' + lbl('تسجيل') + '</button>'
        : '<button class="tsm-b" data-tsm="back" title="الكلمة السابقة (End)">→' + lbl('السابقة') + '</button>' +
          '<button class="tsm-b tsm-gold" data-tsm="next" title="الكلمة التالية (Home)">التالية ←</button>' +
          '<button class="tsm-b tsm-red" data-tsm="mark" title="أخطأت في الكلمة التي كشفتها (Delete)">✗' + lbl('أخطأت') + '</button>') +
        '<button class="tsm-b" data-tsm="log" title="سجل الأخطاء">📋</button>' +
        '<button class="tsm-b tsm-end" data-tsm="end" title="إنهاء التسميع (Esc)">✕' + lbl('إنهاء') + '</button>' +
      '</div>' +
      '<div class="tsm-status' + (errNow ? ' tsm-status-err' : '') + (/^(🟡|✗) «/.test(status) ? ' tsm-status-wrap' : '') + (st.warn && voice ? ' tsm-status-warn' : '') + '">' +
        '<span class="tsm-cm"><i class="tsm-cm-ok">✓' + ok + '</i> <i class="tsm-cm-err">✗' + err + '</i></span>' + esc(status) +
        (voice && st.lastHeard ? '<span class="tsm-heard">سمعت: «' + esc(st.lastHeard) + '»</span>' : '') + '</div>';
  }

  /* ------------------------------- results ------------------------------ */
  // the segment into the log; its error ayahs into «أخطاء التسميع»
  function record() {
    var c = C(), T = st.T, X = st.X, L = loadLog(), now = Date.now(), reachedAyah = {}, byAyah = {}, order = [];
    var end = Math.min(X.N - 1, T.i);
    for (var k = T.base; k <= end; k++) {
      if (k >= T.i && T.st[k] === S_HID) continue;
      var p = st.at[k], a = c.ayahs[p.ai], ak = a.sura + ':' + a.aya, key = ak + ':' + p.w;
      if (!reachedAyah[ak]) { reachedAyah[ak] = 1; L.reach[ak] = (L.reach[ak] || 0) + 1; }
      var e = L.words[key];
      if (T.ty[k]) {
        if (!e) e = L.words[key] = { n: (L.reach[ak] || 1) - 1, e: 0, t: 0, ty: 0, last: 0, ok: false, w: rawOf(p.ai).raw[rawOf(p.ai).idx[p.w]] || a.words[p.w] };
        e.n++; e.e++; e.t += Math.max(1, T.tries[k]); e.ty |= T.ty[k]; e.last = now; e.ok = false;
        if (!byAyah[p.ai]) { byAyah[p.ai] = {}; order.push(p.ai); }
        byAyah[p.ai][p.w] = typeNames(T.ty[k]).join('، ') + (T.tries[k] > 1 ? ' — ' + triesTxt(T.tries[k]) : '');
      } else if (e) { e.n++; e.ok = true; }
    }
    var n = summary(T, X);
    var a0 = c.ayahs[st.at[T.base].ai], a1 = c.ayahs[st.at[end].ai];
    var range = a0.sura === a1.sura ? a0.suraName + ' ' + a0.aya + (a1.aya !== a0.aya ? '–' + a1.aya : '') : a0.suraName + ' ' + a0.aya + ' – ' + a1.suraName + ' ' + a1.aya;
    L.sessions.unshift({ t: now, mode: st.mode, range: range, words: n.reached, ok: n.ok, err: n.err, types: n.types, dur: Math.round((now - st.seg0) / 1000) });
    L.sessions = L.sessions.slice(0, 100);
    if (!writeJSON(LOG_KEY, L)) toast('تعذّر حفظ سجل الأخطاء في المتصفح');
    var items = order.map(function (ai) { return { s: c.ayahs[ai].sura, a: c.ayahs[ai].aya }; });
    var added = items.length && G.AyahLists && G.AyahLists.addMistakes ? G.AyahLists.addMistakes(items) : 0;
    st.acc.range = st.acc.range ? st.acc.range + '، ' + range : range;
    return { added: added, errs: order.map(function (ai) { return { ai: ai, marks: byAyah[ai] }; }) };
  }
  function loadLog() {
    var L = readJSON(LOG_KEY, null);
    if (!L || typeof L !== 'object' || !L.words || typeof L.words !== 'object') L = { v: 1, words: {}, reach: {}, sessions: [] };
    if (!L.reach || typeof L.reach !== 'object') L.reach = {};
    if (!Array.isArray(L.sessions)) L.sessions = [];
    Object.keys(L.words).forEach(function (k) {   // drop broken rows instead of breaking the page
      var e = L.words[k];
      if (!e || typeof e !== 'object' || !/^\d+:\d+:\d+$/.test(k) || !(e.e >= 1)) { delete L.words[k]; return; }
      e.n = Math.max(+e.n || 0, e.e); e.t = Math.max(+e.t || 0, e.e); e.ty = +e.ty || 0; e.last = +e.last || 0;
    });
    return L;
  }

  // the small card after the mode ends; the full result is one tap away
  var lastAcc = null, doneT = 0;
  function closeDone() { clearTimeout(doneT); var d = document.getElementById('tsmDone'); if (d) d.remove(); }
  function showDone(A) {
    closeDone();
    var tm = document.getElementById('toastMsg'); if (tm) tm.classList.remove('show');   // an older toast sits on the same spot
    var pct = A.reached ? Math.round(100 * A.ok / A.reached) : 0;
    var d = document.createElement('div');
    d.id = 'tsmDone'; d.className = 'tsm-done'; d.setAttribute('dir', 'rtl'); d.setAttribute('role', 'status');
    d.innerHTML = '<b>🧠 انتهى التسميع</b><span>' + wordsTxt(A.reached) + ' · <i class="tsm-d-ok">✓ ' + A.ok + '</i> · <i class="tsm-d-err">✗ ' + A.err + '</i>' +
      (A.uns ? ' · <i class="tsm-d-uns" title="كتبها Chrome على غير ما قرأت، فلم تُحسب خطأً">🟡 ' + A.uns + '</i>' : '') + ' · ' + pct + '%</span>' +
      '<button class="tsm-b tsm-gold" data-d="res">النتيجة</button><button class="tsm-x" data-d="x" title="إغلاق">✕</button>';
    d.addEventListener('click', function (e) {
      var b = e.target.closest('[data-d]'); if (!b) return;
      closeDone();
      if (b.getAttribute('data-d') === 'res') showResults(A);
    });
    d.addEventListener('mouseenter', function () { clearTimeout(doneT); });
    document.body.appendChild(d);
    doneT = setTimeout(closeDone, 12000);
  }

  var modal = null;
  function closeModal() { if (modal) { modal.remove(); modal = null; } }
  function openModal(html, cls) {
    closeModal();
    modal = document.createElement('div');
    modal.className = 'tsm-modal'; modal.setAttribute('dir', 'rtl');
    modal.innerHTML = '<div class="tsm-card ' + (cls || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) closeModal(); });
    document.body.appendChild(modal);
    return modal;
  }
  function ayahHtml(ai, marks) {
    var r = rawOf(ai), html = [];
    r.raw.forEach(function (w, ri) {
      var wi = r.idx.indexOf(ri), mk = wi >= 0 ? marks[wi] : null;
      html.push(mk ? '<mark class="tsm-m" title="' + esc(mk) + '">' + esc(w) + '</mark>' : esc(w));
    });
    return html.join(' ');
  }
  function showResults(A) {
    A = A || lastAcc; if (!A) return;
    var c = C(), pct = A.reached ? Math.round(100 * A.ok / A.reached) : 0;
    var mins = Math.max(1, Math.round((Date.now() - A.t0) / 60000));
    var errAyahs = [];
    var list = A.errs.map(function (x) {
      var ai = x.ai, a = c.ayahs[ai], marks = x.marks;
      if (errAyahs.indexOf(ai) < 0) errAyahs.push(ai);
      var detail = Object.keys(marks).map(function (w) {
        return '<li><b>' + esc(rawOf(ai).raw[rawOf(ai).idx[w]] || a.words[w]) + '</b> (الكلمة ' + (+w + 1) + '): ' + esc(marks[w]) + '</li>';
      }).join('');
      return '<div class="tsm-ay" data-go="' + ai + '"><div class="tsm-ay-h">' + esc(a.suraName) + ' ' + a.aya + ' <small>ص ' + a.page + '</small></div>' +
        '<div class="tsm-ay-t">' + ayahHtml(ai, marks) + '</div><ul>' + detail + '</ul></div>';
    }).join('');
    var chips = TYPES.filter(function (t) { return A.types[t[0]]; }).map(function (t) {
      return '<span class="tsm-chip">' + t[1] + ' <b>' + A.types[t[0]] + '</b></span>'; }).join('');
    var m = openModal(
      '<header class="tsm-head"><b>🏁 نتيجة التسميع</b><button class="tsm-x" data-r="close" title="إغلاق (Esc)">✕</button></header>' +
      '<div class="tsm-body">' +
        '<div class="tsm-score"><b>' + pct + '%</b><span>' + A.ok + ' من ' + A.reached + ' كلمة صحيحة من أول مرة' +
          (A.uns ? ' (منها 🟡 ' + A.uns + ' كتبها Chrome على غير ما قرأت)' : '') + ' · ' + esc(A.range || '') + ' · ' +
          (mins === 1 ? 'دقيقة' : mins === 2 ? 'دقيقتان' : mins + (mins <= 10 ? ' دقائق' : ' دقيقة')) + '</span></div>' +
        (chips ? '<div class="tsm-chips">' + chips + '</div>' : '<p class="tsm-perfect">ما شاء الله، لا أخطاء 🌟</p>') +
        (errAyahs.length ? '<p class="tsm-note">' + (A.added ? 'أُضيفت ' + ayahTxt(A.added) + ' إلى «أخطاء التسميع» في قوائمي.' : 'آيات الأخطاء موجودة في «أخطاء التسميع» في قوائمي، وأُعيدت إلى أول المراجعة.') + '</p>' : '') +
        (list ? '<h4>الآيات التي فيها أخطاء</h4>' + list : '') +
      '</div>' +
      '<footer class="tsm-foot">' +
        '<button class="tsm-b tsm-gold" data-r="again">⟲ أعد التسميع</button>' +
        (errAyahs.length ? '<button class="tsm-b" data-r="errs">🎯 سمّع الأخطاء فقط</button>' : '') +
        '<button class="tsm-b" data-r="log">📋 سجل الأخطاء</button>' +
        '<button class="tsm-b" data-r="close">إغلاق</button>' +
      '</footer>', 'tsm-results');
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-r]'), go = e.target.closest('[data-go]');
      if (b) {
        var a = b.getAttribute('data-r');
        if (a === 'close') closeModal();
        if (a === 'again') { closeModal(); start(A.fixed ? { ayahs: A.fixed } : A.first ? { at: A.first } : {}); }
        if (a === 'errs') { closeModal(); start({ ayahs: errAyahs.slice().sort(function (x, y) { return x - y; }) }); }
        if (a === 'log') openLog();
        return;
      }
      if (go) { closeModal(); goAyah(+go.getAttribute('data-go')); }
    });
  }
  function goAyah(ai, w) {
    var a = C().ayahs[ai];
    call('goToPage', a.page);
    setTimeout(function () {
      var boxes = (g('getAyahWordBoxes') || function () { return []; })(a.sura, a.aya) || [], r = rawOf(ai), place = g('placeOnMushaf');
      var list = w == null ? boxes : [boxes[r.idx[w]]];
      list.forEach(function (b) {
        if (!b || !place) return;
        var card = cardFor(b.page); if (!card) return;
        var el = document.createElement('div'); el.className = 'tsm-flash'; place(el, b, 1); card.appendChild(el);
        setTimeout(function () { el.remove(); }, 2600);
      });
      var card0 = boxes[0] && cardFor(boxes[0].page);
      if (card0 && card0.scrollIntoView) card0.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 250);
  }

  /* ------------------------------- error log ---------------------------- */
  var logUi = { sort: 'ratio', sura: 0, type: 0, open: false };
  function logRows() {
    var L = loadLog(), rows = [];
    Object.keys(L.words).forEach(function (key) {
      var e = L.words[key], p = key.split(':');
      rows.push({ key: key, s: +p[0], a: +p[1], w: +p[2], e: e });
    });
    return rows;
  }
  function openLog() {
    closeModal();
    var c = C(); if (!c) return;
    var rows = logRows(), names = {};
    c.ayahs.forEach(function (a) { names[a.sura] = a.suraName; });
    var suras = {}; rows.forEach(function (r) { suras[r.s] = 1; });
    var shown = rows.filter(function (r) {
      return (!logUi.sura || r.s === logUi.sura) && (!logUi.type || (r.e.ty & logUi.type)) && (!logUi.open || !r.e.ok);
    });
    shown.sort(function (x, y) {
      if (logUi.sort === 'recent') return y.e.last - x.e.last;
      if (logUi.sort === 'mushaf') return x.s - y.s || x.a - y.a || x.w - y.w;
      return (y.e.e / y.e.n) - (x.e.e / x.e.n) || y.e.t - x.e.t || y.e.last - x.e.last;
    });
    var body = shown.map(function (r) {
      var e = r.e;
      return '<div class="tsm-lr" data-key="' + r.key + '">' +
        '<span class="tsm-lw">' + esc(e.w) + '</span>' +
        '<span class="tsm-lp">' + esc(names[r.s] || r.s) + ' ' + r.a + '<small>الكلمة ' + (r.w + 1) + '</small></span>' +
        '<span class="tsm-lt">' + typeNames(e.ty).map(function (t) { return '<i>' + t + '</i>'; }).join('') + '</span>' +
        '<span class="tsm-ln"><b>أخطأت فيها في ' + sessTxt(e.e) + ' من ' + e.n + '</b><small>' + triesTxt(e.t) + ' خاطئة إجمالًا</small></span>' +
        '<span class="tsm-ll">' + dateTxt(e.last) + (e.ok ? '<small class="tsm-okk">✓ قرأتها صحيحة آخر مرة</small>' : '<small class="tsm-bad">لم تُصحَّح بعد</small>') + '</span>' +
      '</div>';
    }).join('');
    var L = loadLog();
    var m = openModal(
      '<header class="tsm-head"><b>📋 سجل الأخطاء</b><button class="tsm-x" data-l="close" title="إغلاق (Esc)">✕</button></header>' +
      '<div class="tsm-tools">' +
        '<select data-f="sort" aria-label="الترتيب">' + [['ratio', 'الأسوأ نسبةً'], ['recent', 'الأحدث'], ['mushaf', 'ترتيب المصحف']].map(function (o) {
          return '<option value="' + o[0] + '"' + (logUi.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '<select data-f="sura" aria-label="السورة"><option value="0">كل السور</option>' + Object.keys(suras).sort(function (a, b) { return a - b; }).map(function (s) {
          return '<option value="' + s + '"' + (logUi.sura === +s ? ' selected' : '') + '>' + esc(names[s]) + '</option>'; }).join('') + '</select>' +
        '<select data-f="type" aria-label="نوع الخطأ"><option value="0">كل الأنواع</option>' + TYPES.map(function (t) {
          return '<option value="' + t[0] + '"' + (logUi.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select>' +
        '<label class="tsm-chk"><input type="checkbox" data-f="open"' + (logUi.open ? ' checked' : '') + '> لم تُصحَّح بعد</label>' +
      '</div>' +
      '<div class="tsm-body">' +
        (rows.length ? '<p class="tsm-note">' + rows.length + ' كلمة أخطأت فيها في ' + L.sessions.length + ' جلسة تسميع' + (shown.length !== rows.length ? '، يظهر منها ' + shown.length : '') + '. انقر أي صف لتذهب إلى الكلمة.</p>' +
          '<div class="tsm-lh"><span>الكلمة</span><span>الموضع</span><span>النوع</span><span>كم مرة</span><span>آخر مرة</span></div>' +
          (body || '<p class="tsm-empty">لا شيء يطابق التصفية.</p>')
        : '<p class="tsm-empty">لا أخطاء مسجّلة بعد. كل كلمة تخطئ فيها في وضع التسميع تظهر هنا مع عدد مرات الخطأ.</p>') +
      '</div>' +
      '<footer class="tsm-foot">' +
        (shown.length ? '<button class="tsm-b tsm-gold" data-l="drill">🎯 سمّع هذه فقط</button>' : '') +
        (rows.length ? '<button class="tsm-b tsm-red" data-l="clear">🗑 امسح السجل</button>' : '') +
        '<button class="tsm-b" data-l="close">إغلاق</button>' +
      '</footer>', 'tsm-log');
    m.addEventListener('change', function (e) {
      var f = e.target.getAttribute('data-f'); if (!f) return;
      if (f === 'sort') logUi.sort = e.target.value;
      if (f === 'sura') logUi.sura = +e.target.value;
      if (f === 'type') logUi.type = +e.target.value;
      if (f === 'open') logUi.open = e.target.checked;
      openLog();
    });
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-l]'), row = e.target.closest('[data-key]');
      if (b) {
        var a = b.getAttribute('data-l');
        if (a === 'close') closeModal();
        if (a === 'clear' && confirm('مسح سجل الأخطاء كله؟ لا يمكن التراجع.')) { writeJSON(LOG_KEY, { v: 1, words: {}, reach: {}, sessions: [] }); openLog(); toast('مُسح سجل الأخطاء'); }
        if (a === 'drill') {
          var want = {}, list = [];
          shown.forEach(function (r) { want[r.s + ':' + r.a] = 1; });
          c.ayahs.forEach(function (A, i) { if (want[A.sura + ':' + A.aya]) list.push(i); });
          closeModal(); start({ ayahs: list });
        }
        return;
      }
      if (row) {
        var p = row.getAttribute('data-key').split(':').map(Number), ai = -1;
        for (var i = 0; i < c.ayahs.length; i++) if (c.ayahs[i].sura === p[0] && c.ayahs[i].aya === p[1]) { ai = i; break; }
        if (ai >= 0) { closeModal(); if (st) stop(); goAyah(ai, p[2]); }
      }
    });
  }

  function earsStatus(s) {
    if (!st) return;
    if (s === 'loading') st.status = '🧠 جارٍ تحميل الأذن القرآنية (مرة واحدة)...';
    else if (s === 'ready') st.status = '🧠 الأذن القرآنية جاهزة';
    else if (s === 'error') st.status = '⚠️ تعذّر تحميل الأذن القرآنية: ' + (window.TasmeeEars ? TasmeeEars.error() : '');
    renderBar();
  }

  /* ------------------------------- input -------------------------------- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal) { closeModal(); e.stopPropagation(); e.preventDefault(); return; }
    if (!st || modal || typing(e.target) || otherOverlay() || e.ctrlKey || e.altKey || e.metaKey) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
    else if (k === 'Home') { e.preventDefault(); e.stopPropagation(); if (st.mode === 'eye') doNext(e.shiftKey); else doHint(); }
    else if (k === 'End') { e.preventDefault(); e.stopPropagation(); doBack(e.shiftKey); }
    else if ((k === 'Delete' || k === 'Backspace') && st.mode === 'eye') { e.preventDefault(); e.stopPropagation(); doMark(); }
  }, true);
  // a tap on the page: eye mode = next word; never the tafsir of a covered ayah
  function onCardClick(e) {
    if (!st || !e.target.closest('#mushafCardRight, #mushafCardLeft')) return;
    e.stopPropagation(); e.preventDefault();
    if (st.mode === 'eye') { doNext(); return; }
    var w = e.target.closest('.tsm-w'), k = w ? +w.getAttribute('data-k') : -1;
    if (k >= 0 && st.T) toggleUns(k);
  }
  // voice: a yellow word tapped = «أخطأت» (counted), tapped again = yellow
  function toggleUns(k) {
    [st.T, st.shown].forEach(function (T, n) {
      if (n && T === st.T) return;
      if (T.st[k] === S_UNS) { T.st[k] = S_MARK; T.ty[k] = T_MARK; T.tries[k] = 1; }
      else if (T.st[k] === S_MARK && T.ty[k] === T_MARK) { T.st[k] = S_UNS; T.ty[k] = 0; T.tries[k] = 0; }
    });
    var now = st.T.st[k];
    if (now === S_MARK) st.status = '✗ «' + wordAt(k) + '» سُجّلت خطأً (المسها ثانيةً للتراجع)';
    else if (now === S_UNS) st.status = '🟡 «' + wordAt(k) + '» لم تُحسب خطأً';
    paint();
  }
  document.addEventListener('click', onCardClick, true);

  G.Tasmee = { toggle: toggle, open: toggle, start: start, stop: stop, openLog: openLog, showResults: showResults, closeModal: closeModal,
    heard: heard, takesWords: takesWords, onPage: onPage, onMicStop: onMicStop, isOn: function () { return !!st; },
    prefs: function () { return prefs; }, setPref: function (k, v) { prefs[k] = v; savePrefs(); }, earsStatus: earsStatus,
    next: doNext, back: doBack, mark: doMark, hint: doHint,
    _state: function () { return st; }, _log: loadLog, Core: Core };
})(typeof window !== 'undefined' ? window : globalThis);
