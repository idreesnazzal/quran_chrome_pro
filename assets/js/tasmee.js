/* وضع التسميع (Tasmee): the words of the chosen range are covered, and the
 * reciter uncovers them one by one, by voice (strict: nothing moves on until
 * the word is said exactly) or by eye (Home = next word, End = previous).
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
  var S_HID = 0, S_OK = 1, S_ERR = 2, S_FIX = 3, S_REV = 4, S_HINT = 5, S_MARK = 6;
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
    return { E: E, N: E.length, as: as, pas: pas, eq: o.level === 'very' ? eqVery : eqStrict,
      reveal: o.reveal == null ? 3 : o.reveal, pauseOnFinal: o.pauseOnFinal !== false,
      sim: o.sim || function (a, b) { return a === b ? 1 : 0; } };
  }
  function create(N) {
    return { i: 0, st: new Uint8Array(N), tries: new Uint8Array(N), ty: new Uint16Array(N),
      run: -1, runLen: 0, runKind: 0, runTok: '', runNew: false, shadow: -1, opt: -1, optJ: 0 };
  }
  function clone(T) {
    return { i: T.i, st: T.st.slice(), tries: T.tries.slice(), ty: T.ty.slice(), run: T.run, runLen: T.runLen,
      runKind: T.runKind, runTok: T.runTok, runNew: T.runNew, shadow: T.shadow, opt: T.opt, optJ: T.optJ };
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
        if (X.eq(E[T.shadow], t)) { T.shadow++; if (T.shadow >= T.i) T.shadow = -1; T.run = -1; continue; }
        T.shadow = -1;
      }
      var i = T.i, m = matchAt(X, i, t, nx);
      if (m) {
        if (T.run === i && T.runLen === 1 && T.runNew) {   // what the one wrong word before it really was
          if (T.runKind === T_SKIP && i + 1 < X.N && X.eq(E[i + 1], T.runTok)) T.ty[i] = (T.ty[i] & ~T_SKIP) | T_ORDER;
          else if (T.runKind === T_SUB && X.sim(T.runTok, E[i]) < 0.5) T.ty[i] = (T.ty[i] & ~T_SUB) | T_EXTRA;
        }
        for (var q = 0; q < m.e; q++) accept(T, i + q);
        T.i = i + m.e; j += m.t - 1; T.run = -1; T.opt = -1;
        continue;
      }
      var k = backTo(X, i, t, nx, last && !final);
      if (k === -2) break;
      if (k >= 0) { T.shadow = k + 1 < i ? k + 1 : -1; T.run = -1; continue; }
      if (T.opt >= 0) {                          // inside the isti'adha / basmala
        var p = OPT[T.opt], at = p.indexOf(t, T.optJ);
        if (at >= 0) { T.optJ = at + 1; if (T.optJ >= p.length) T.opt = -1; continue; }
        T.opt = -1;
      }
      var o = -1;
      for (var z = 0; z < OPT.length && o < 0; z++) if (OPT[z][0] === t) o = z;
      if (o >= 0) { T.opt = o; T.optJ = 1; continue; }
      if (last && !final) break;                 // the newest interim word may still change
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
    if (final && X.pauseOnFinal) T.run = -1;     // a pause ends the attempt
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
    if (T.i <= 0) return false;
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
    var n = { reached: 0, ok: 0, err: 0, types: {} };
    for (var k = 0; k < X.N; k++) {
      if (k >= T.i && T.st[k] === S_HID) continue;
      n.reached++;
      if (T.ty[k]) { n.err++; TYPES.forEach(function (ty) { if (T.ty[k] & ty[0]) n.types[ty[0]] = (n.types[ty[0]] || 0) + 1; }); }
      else n.ok++;
    }
    return n;
  }

  var Core = { create: create, clone: clone, feed: feed, makeCtx: makeCtx, hint: hint, eyeNext: eyeNext, eyeBack: eyeBack,
    eyeMark: eyeMark, summary: summary, eqVery: eqVery, eqStrict: eqStrict, TYPES: TYPES,
    S: { HID: S_HID, OK: S_OK, ERR: S_ERR, FIX: S_FIX, REV: S_REV, HINT: S_HINT, MARK: S_MARK },
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
  function otherOverlay() { return document.querySelector('.al-backdrop, .st-backdrop, .rs-modal, .al-pop, .search-modal-backdrop.active, .tafsir-modal-backdrop.active'); }
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
  function typeNames(bits) { return TYPES.filter(function (t) { return bits & t[0]; }).map(function (t) { return t[1]; }); }
  function dateTxt(ts) { try { return new Date(ts).toLocaleDateString('ar-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }

  var prefs = Object.assign({ mode: 'voice', range: 'page', level: 'strict', reveal: 3, cs: 1, ca1: 1, ca2: 7 }, readJSON(PREF_KEY, {}));
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

  /* ------------------------------ test state ---------------------------- */
  var st = null;   // the running test, null = off

  // ayah indices -> expected words with their places
  function buildTest(ayahIdx, o) {
    var c = C(), E = [], as = [], pas = [], at = [], prevStart = -1, lastAi = -2;
    ayahIdx.forEach(function (ai) {
      var a = c.ayahs[ai], start = E.length, ps = (ai === lastAi + 1 && c.ayahs[ai].sura === c.ayahs[lastAi].sura) ? prevStart : -1;
      for (var w = 0; w < a.words.length; w++) { E.push(a.words[w]); as.push(start); pas.push(ps); at.push({ ai: ai, w: w }); }
      prevStart = start; lastAi = ai;
    });
    var X = makeCtx(E, as, pas, { level: o.level, reveal: o.reveal, sim: R().wordSim });
    return { X: X, T: create(E.length), shown: null, at: at, ayahs: ayahIdx, mode: o.mode, t0: Date.now(), heard: [],
      status: '', range: o.label || '', byPage: null };
  }
  function ayahsInRange(kind) {
    var c = C(), out = [], i;
    var page = g('isDoublePageMode') ? g('currentRightPage') : g('currentPage');
    var hl = g('currentHighlightedAyah');
    var first = -1;
    for (i = 0; i < c.ayahs.length; i++) if (c.ayahs[i].page === page) { first = i; break; }
    var cur = first;
    if (hl) for (i = 0; i < c.ayahs.length; i++) if (c.ayahs[i].sura === hl.sura && c.ayahs[i].aya === hl.aya) { cur = i; break; }
    if (kind === 'page') {
      var pages = visiblePages();
      for (i = 0; i < c.ayahs.length; i++) if (pages.indexOf(c.ayahs[i].page) >= 0) out.push(i);
    } else if (kind === 'fromAyah' || kind === 'sura') {
      var s = c.ayahs[cur].sura;
      for (i = 0; i < c.ayahs.length; i++) if (c.ayahs[i].sura === s && (kind === 'sura' || i >= cur)) out.push(i);
    } else if (kind === 'custom') {
      for (i = 0; i < c.ayahs.length; i++) {
        var A = c.ayahs[i];
        if (A.sura === +prefs.cs && A.aya >= +prefs.ca1 && A.aya <= +prefs.ca2) out.push(i);
      }
    }
    return out;
  }
  function label(ayahIdx) {
    var c = C(), a = c.ayahs[ayahIdx[0]], b = c.ayahs[ayahIdx[ayahIdx.length - 1]];
    if (a.sura === b.sura) return 'سورة ' + a.suraName + ' ' + a.aya + (b.aya !== a.aya ? '–' + b.aya : '');
    return a.suraName + ' ' + a.aya + ' – ' + b.suraName + ' ' + b.aya;
  }

  function start(ayahIdx, mode) {
    if (!C()) { toast('بيانات المصحف لم تُحمّل بعد'); return false; }
    if (!ayahIdx || !ayahIdx.length) { toast('النطاق فارغ'); return false; }
    if (st) stop(true);
    mode = mode || prefs.mode;
    if (mode === 'voice' && !(G.SpeechRecognition || G.webkitSpeechRecognition) && localStorage.getItem('recite_ears') !== 'quran') {
      toast('المتصفح لا يدعم التعرّف الصوتي هنا: استعمل التسميع بالعين'); mode = 'eye';
    }
    st = buildTest(ayahIdx, { mode: mode, level: prefs.level, reveal: +prefs.reveal, label: label(ayahIdx) });
    st.shown = st.T;
    document.body.classList.add('tsm-on');
    document.body.classList.toggle('tsm-voice', mode === 'voice');
    document.body.classList.toggle('tsm-eye', mode === 'eye');
    closeModal();
    followCursor();
    buildLayers();
    if (mode === 'voice') {
      if (!micOn()) call('startVoiceRecitation');
      st.ownMic = true;
      st.status = 'ابدأ التلاوة من: ' + where(0);
    } else st.status = touch() ? 'انقر الصفحة أو «التالية» لتكشف الكلمة، و✗ إن أخطأت فيها' : 'Home للكلمة التالية، End للسابقة، Delete إن أخطأت';
    paint();
    return true;
  }
  function stop(silent) {
    if (!st) return;
    if (st.ownMic && micOn()) call('stopVoiceRecitation');
    st = null;
    document.querySelectorAll('.tsm-layer').forEach(function (el) { el.remove(); });
    var bar = document.getElementById('tsmBar'); if (bar) bar.remove();
    document.body.classList.remove('tsm-on', 'tsm-voice', 'tsm-eye');
    if (!silent) toast('انتهى التسميع');
  }
  function where(k) {
    var c = C(), p = st.at[Math.min(k, st.at.length - 1)], a = c.ayahs[p.ai];
    return a.suraName + ' ' + a.aya;
  }

  /* ------------------------------ heard words ---------------------------- */
  function takesWords() { return !!(st && st.mode === 'voice' && !st.finished); }
  function heard(words, raw, final) {
    if (!takesWords()) return;
    var S = R()._session;
    st.X.pauseOnFinal = !(S && S.ears === 'local');   // the local model commits mid-speech
    if (final) { if (words.length) { feed(st.T, st.X, words, true); st.heard = st.heard.concat(raw || words).slice(-12); } st.shown = st.T; }
    else st.shown = words.length ? feed(clone(st.T), st.X, words, false) : st.T;
    var shownHeard = final ? st.heard : st.heard.concat(raw || words).slice(-12);
    var sp = document.getElementById('dockSpeechText'); if (sp) sp.textContent = '"' + shownHeard.slice(-8).join(' ') + '"';
    st.lastHeard = shownHeard.slice(-6).join(' ');
    afterChange();
  }
  function afterChange() {
    var T = st.shown, X = st.X;
    if (T.i < X.N && T.st[T.i] === S_ERR) {
      var left = X.reveal ? X.reveal - T.tries[T.i] : 0;
      st.status = '✗ ' + typeNames(T.ty[T.i] & 31).join('، ') + ' — أعد الكلمة الحمراء' +
        (X.reveal ? ' (' + triesTxt(T.tries[T.i]) + '، تنكشف بعد ' + (left === 1 ? 'محاولة أخرى' : left === 2 ? 'محاولتين' : left + ' محاولات') + ')' : ' (' + triesTxt(T.tries[T.i]) + ')');
    } else if (T.i < X.N) st.status = st.mode === 'voice' ? 'التالية من ' + where(T.i) : st.status;
    followCursor();
    paint();
    if (st.T.i >= X.N && !st.finished) finish();
  }

  /* --------------------------------- actions ---------------------------- */
  function doHint() {
    if (!st) return;
    if (st.mode === 'eye') return doNext();
    if (hint(st.T, st.X)) { st.shown = st.T; afterChange(); }
  }
  function doNext(ayah) {
    if (!st) return;
    if (st.mode === 'voice') return doHint();
    var T = st.T, X = st.X, a = T.i < X.N ? st.at[T.i].ai : -1;
    do { if (!eyeNext(T, X)) break; } while (ayah && T.i < X.N && st.at[T.i].ai === a);
    st.shown = T; afterChange();
  }
  function doBack(ayah) {
    if (!st || st.mode !== 'eye') return;
    var T = st.T;
    if (ayah) {   // to the start of this ayah, or of the one before when already there
      if (T.i > 0 && T.i < st.X.N && st.X.as[T.i] === T.i) eyeBack(T);
      var s = T.i < st.X.N ? st.X.as[T.i] : st.X.as[T.i - 1];
      while (T.i > s && eyeBack(T)) {}
    } else eyeBack(T);
    st.shown = T; st.finished = false; afterChange();
  }
  function doMark() {
    if (!st) return;
    if (st.mode !== 'eye') return;
    var r = eyeMark(st.T);
    if (!r) { toast('اكشف كلمة أولًا (Home)'); return; }
    st.shown = st.T; afterChange();
  }
  function restartAyah() {
    if (!st) return;
    var T = st.T, k = Math.min(T.i, st.X.N - 1);
    if (st.mode === 'eye') { doBack(true); return; }
    T.shadow = -1; T.run = -1;
    st.status = 'أعد من أول ' + where(st.X.as[k]); st.shown = T; paint();
  }

  /* --------------------------------- pages ------------------------------ */
  function followCursor() {
    if (!st) return;
    var k = Math.min(st.shown.i, st.X.N - 1), page = C().ayahs[st.at[k].ai].page;
    if (visiblePages().indexOf(page) < 0) call('goToPage', page);
  }
  function onPage() { if (st) buildLayers(); }
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
      var lastAi = -1, boxes = null, ro = null;
      for (var k = 0; k < st.at.length; k++) {
        var p = st.at[k];
        if (p.ai !== lastAi) { lastAi = p.ai; var a = c.ayahs[p.ai]; boxes = getBoxes(a.sura, a.aya) || []; ro = rawOf(p.ai); }
        var b = boxes[ro.idx[p.w]];
        if (!b || b.page !== page) continue;
        var el = document.createElement('div');
        el.className = 'tsm-w'; el.setAttribute('data-k', k);
        place(el, b, -3);   // a little taller than the box: no letter tails or marks peek out
        layer.appendChild(el);
      }
      card.appendChild(layer);
    });
    paint();
  }
  var CLS = ['', ' tsm-ok', ' tsm-err', ' tsm-fix', ' tsm-fix', ' tsm-fix', ' tsm-fix'];
  function paint() {
    if (!st) return;
    var T = st.shown;
    document.querySelectorAll('.tsm-w').forEach(function (el) {
      var k = +el.getAttribute('data-k');
      var c = 'tsm-w' + CLS[T.st[k]] + (k === T.i ? ' tsm-cur' : '');
      if (el.className !== c) el.className = c;
    });
    renderBar();
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
      if (a === 'mic') { if (micOn()) call('stopVoiceRecitation'); else { call('startVoiceRecitation'); st.ownMic = true; } setTimeout(paint, 60); }
      if (a === 'next') doNext();
      if (a === 'back') doBack();
      if (a === 'hint') doHint();
      if (a === 'mark') doMark();
      if (a === 'again') restartAyah();
      if (a === 'log') openLog();
      if (a === 'finish') finish();
    });
    return bar;
  }
  function lbl(t) { return '<span class="tsm-lbl"> ' + t + '</span>'; }   // hidden on a phone: the icon stays
  function renderBar() {
    var bar = ensureBar(); if (!bar || !st) return;
    var hd = document.querySelector('header');   // sticks under the sticky header, not over it
    bar.style.top = ((hd && getComputedStyle(hd).position === 'sticky' ? hd.offsetHeight : 0) + 6) + 'px';
    var T = st.shown, X = st.X, n = summary(T, X), voice = st.mode === 'voice';
    var errNow = T.i < X.N && T.st[T.i] === S_ERR;
    bar.innerHTML =
      '<div class="tsm-row">' +
        '<span class="tsm-title">' + (voice ? '🎙️' : '👁') + ' التسميع' + '<small>' + esc(st.range) + '</small></span>' +
        '<span class="tsm-c" title="الكلمات التي كُشفت من النطاق">' + Math.min(T.i, X.N) + ' / ' + X.N + '</span>' +
        '<span class="tsm-c tsm-c-ok" title="صحيحة من أول مرة">✓ ' + n.ok + '</span>' +
        '<span class="tsm-c tsm-c-err" title="كلمات فيها خطأ">✗ ' + n.err + '</span>' +
        '<span class="tsm-sp"></span>' +
        (voice ? '<button class="tsm-b' + (micOn() ? '' : ' tsm-gold') + '" data-tsm="mic">' + (micOn() ? '⏸' + lbl('إيقاف المايك') : '🎙️' + lbl('شغّل المايك')) + '</button>' +
          '<button class="tsm-b" data-tsm="hint" title="اكشف الكلمة التالية (Home) — تُسجَّل خطأً">💡' + lbl('مساعدة') + '</button>' +
          '<button class="tsm-b" data-tsm="again" title="ابدأ الآية من أولها">↺' + lbl('أعد الآية') + '</button>'
        : '<button class="tsm-b" data-tsm="back" title="الكلمة السابقة (End)">→' + lbl('السابقة') + '</button>' +
          '<button class="tsm-b tsm-gold" data-tsm="next" title="الكلمة التالية (Home)">التالية ←</button>' +
          '<button class="tsm-b tsm-red" data-tsm="mark" title="أخطأت في الكلمة التي كشفتها (Delete)">✗' + lbl('أخطأت') + '</button>') +
        '<button class="tsm-b" data-tsm="log" title="سجل الأخطاء">📋</button>' +
        '<button class="tsm-b" data-tsm="finish" title="إنهاء وعرض النتيجة">🏁' + lbl('إنهاء') + '</button>' +
      '</div>' +
      '<div class="tsm-status' + (errNow ? ' tsm-status-err' : '') + '">' + esc(st.status) +
        (voice && st.lastHeard ? '<span class="tsm-heard">سمعت: «' + esc(st.lastHeard) + '»</span>' : '') + '</div>';
  }

  /* ------------------------------- results ------------------------------ */
  function finish() {
    if (!st) return;
    if (st.ownMic && micOn()) call('stopVoiceRecitation');
    st.T = st.shown = st.T;   // drop an interim replay
    st.finished = true;
    var n = summary(st.T, st.X);
    if (!n.reached) { stop(true); return; }
    if (!st.saved) { st.saved = true; st.result = record(); }
    paint();
    showResults();
  }
  function errorAyahs() {
    var T = st.T, X = st.X, out = [], seen = {};
    for (var k = 0; k < X.N; k++) if (T.ty[k] && !seen[st.at[k].ai]) { seen[st.at[k].ai] = 1; out.push(st.at[k].ai); }
    return out;
  }
  // the session into the log; the error ayahs into «أخطاء التسميع»
  function record() {
    var c = C(), T = st.T, X = st.X, L = loadLog(), now = Date.now(), reachedAyah = {};
    for (var k = 0; k < X.N; k++) {
      if (k >= T.i && T.st[k] === S_HID) continue;
      var p = st.at[k], a = c.ayahs[p.ai], ak = a.sura + ':' + a.aya, key = ak + ':' + p.w;
      if (!reachedAyah[ak]) { reachedAyah[ak] = 1; L.reach[ak] = (L.reach[ak] || 0) + 1; }
      var e = L.words[key];
      if (T.ty[k]) {
        if (!e) e = L.words[key] = { n: (L.reach[ak] || 1) - 1, e: 0, t: 0, ty: 0, last: 0, ok: false, w: rawOf(p.ai).raw[rawOf(p.ai).idx[p.w]] || a.words[p.w] };
        e.n++; e.e++; e.t += Math.max(1, T.tries[k]); e.ty |= T.ty[k]; e.last = now; e.ok = false;
      } else if (e) { e.n++; e.ok = true; }
    }
    var n = summary(T, X);
    L.sessions.unshift({ t: now, mode: st.mode, range: st.range, words: n.reached, ok: n.ok, err: n.err, types: n.types, dur: Math.round((now - st.t0) / 1000) });
    L.sessions = L.sessions.slice(0, 100);
    if (!writeJSON(LOG_KEY, L)) toast('تعذّر حفظ سجل الأخطاء في المتصفح');
    var items = errorAyahs().map(function (ai) { return { s: c.ayahs[ai].sura, a: c.ayahs[ai].aya }; });
    var added = items.length && G.AyahLists && G.AyahLists.addMistakes ? G.AyahLists.addMistakes(items) : 0;
    return { added: added, items: items.length };
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

  var modal = null;
  function closeModal() { if (modal) { modal.remove(); modal = null; } }
  function openModal(html, cls) {
    closeModal();
    modal = document.createElement('div');
    modal.className = 'tsm-modal'; modal.setAttribute('dir', 'rtl');
    modal.innerHTML = '<div class="tsm-card ' + (cls || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) { var m = modal; closeModal(); if (m.onclose) m.onclose(); } });
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
  function showResults() {
    var c = C(), T = st.T, X = st.X, n = summary(T, X), pct = n.reached ? Math.round(100 * n.ok / n.reached) : 0;
    var mins = Math.max(1, Math.round((Date.now() - st.t0) / 60000));
    var byAyah = {};
    for (var k = 0; k < X.N; k++) if (T.ty[k]) {
      var p = st.at[k];
      (byAyah[p.ai] = byAyah[p.ai] || {})[p.w] = typeNames(T.ty[k]).join('، ') + (T.tries[k] > 1 ? ' — ' + triesTxt(T.tries[k]) : '');
    }
    var list = errorAyahs().map(function (ai) {
      var a = c.ayahs[ai], marks = byAyah[ai];
      var detail = Object.keys(marks).map(function (w) {
        return '<li><b>' + esc(rawOf(ai).raw[rawOf(ai).idx[w]] || a.words[w]) + '</b> (الكلمة ' + (+w + 1) + '): ' + esc(marks[w]) + '</li>';
      }).join('');
      return '<div class="tsm-ay" data-go="' + ai + '"><div class="tsm-ay-h">' + esc(a.suraName) + ' ' + a.aya + ' <small>ص ' + a.page + '</small></div>' +
        '<div class="tsm-ay-t">' + ayahHtml(ai, marks) + '</div><ul>' + detail + '</ul></div>';
    }).join('');
    var chips = TYPES.filter(function (t) { return n.types[t[0]]; }).map(function (t) {
      return '<span class="tsm-chip">' + t[1] + ' <b>' + n.types[t[0]] + '</b></span>'; }).join('');
    var m = openModal(
      '<header class="tsm-head"><b>🏁 نتيجة التسميع</b><button class="tsm-x" data-r="close" title="إغلاق (Esc)">✕</button></header>' +
      '<div class="tsm-body">' +
        '<div class="tsm-score"><b>' + pct + '%</b><span>' + n.ok + ' من ' + n.reached + ' كلمة صحيحة من أول مرة · ' + esc(st.range) + ' · ' +
          (mins === 1 ? 'دقيقة' : mins === 2 ? 'دقيقتان' : mins + (mins <= 10 ? ' دقائق' : ' دقيقة')) + '</span></div>' +
        (chips ? '<div class="tsm-chips">' + chips + '</div>' : '<p class="tsm-perfect">ما شاء الله، لا أخطاء 🌟</p>') +
        (st.result && st.result.items ? '<p class="tsm-note">' + (st.result.added ? 'أُضيفت ' + ayahTxt(st.result.added) + ' إلى «أخطاء التسميع» في قوائمي.' : 'آيات الأخطاء موجودة في «أخطاء التسميع» في قوائمي، وأُعيدت إلى أول المراجعة.') + '</p>' : '') +
        (list ? '<h4>الآيات التي فيها أخطاء</h4>' + list : '') +
      '</div>' +
      '<footer class="tsm-foot">' +
        '<button class="tsm-b tsm-gold" data-r="again">⟲ أعد التسميع</button>' +
        (list ? '<button class="tsm-b" data-r="errs">🎯 سمّع الأخطاء فقط</button>' : '') +
        '<button class="tsm-b" data-r="log">📋 سجل الأخطاء</button>' +
        '<button class="tsm-b" data-r="close">إغلاق</button>' +
      '</footer>', 'tsm-results');
    m.onclose = function () { stop(true); };
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-r]'), go = e.target.closest('[data-go]');
      var ayahs = st ? st.ayahs.slice() : [], mode = st ? st.mode : prefs.mode;
      if (b) {
        var a = b.getAttribute('data-r');
        if (a === 'close') { closeModal(); stop(true); }
        if (a === 'again') start(ayahs, mode);
        if (a === 'errs') start(errorAyahs(), mode);
        if (a === 'log') { stop(true); openLog(); }
        return;
      }
      if (go) { var ai = +go.getAttribute('data-go'); closeModal(); stop(true); goAyah(ai); }
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
        : '<p class="tsm-empty">لا أخطاء مسجّلة بعد. ابدأ تسميعًا، وكل كلمة تخطئ فيها تظهر هنا مع عدد مرات الخطأ.</p>') +
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
          closeModal(); start(list);
        }
        return;
      }
      if (row) {
        var p = row.getAttribute('data-key').split(':').map(Number), ai = -1;
        for (var i = 0; i < c.ayahs.length; i++) if (c.ayahs[i].sura === p[0] && c.ayahs[i].aya === p[1]) { ai = i; break; }
        if (ai >= 0) { closeModal(); if (st) stop(true); goAyah(ai, p[2]); }
      }
    });
  }

  /* ------------------------------- start panel -------------------------- */
  function openStart() {
    var c = C(); if (!c) { toast('بيانات المصحف لم تُحمّل بعد'); return; }
    var suras = [], seen = {};
    c.ayahs.forEach(function (a) { if (!seen[a.sura]) { seen[a.sura] = 1; suras.push({ s: a.sura, name: a.suraName, n: 0 }); } suras[suras.length - 1].n = a.aya; });
    var cs = suras[(+prefs.cs || 1) - 1] || suras[0];
    function seg(name, items, cur) {
      return '<div class="tsm-seg" data-seg="' + name + '">' + items.map(function (it) {
        return '<button type="button" data-v="' + it[0] + '"' + (String(cur) === String(it[0]) ? ' class="on"' : '') + '>' + it[1] + '</button>'; }).join('') + '</div>';
    }
    var counts = {}; ['page', 'fromAyah', 'sura', 'custom'].forEach(function (k) { counts[k] = ayahsInRange(k); });
    function rlabel(k) { var l = counts[k]; return l.length ? label(l) : '—'; }
    var m = openModal(
      '<header class="tsm-head"><b>🧠 وضع التسميع</b><button class="tsm-x" data-s="close" title="إغلاق (Esc)">✕</button></header>' +
      '<div class="tsm-body tsm-form">' +
        '<div class="tsm-fr"><span>الطريقة</span>' + seg('mode', [['voice', '🎙️ بالصوت'], ['eye', '👁 بالعين (بلا صوت)']], prefs.mode) + '</div>' +
        '<div class="tsm-fr"><span>النطاق</span><div class="tsm-ranges">' +
          [['page', 'الصفحة الحالية'], ['fromAyah', 'من الآية الحالية إلى آخر السورة'], ['sura', 'السورة كاملة'], ['custom', 'نطاق أختاره']].map(function (r) {
            return '<label class="tsm-rad"><input type="radio" name="tsmRange" value="' + r[0] + '"' + (prefs.range === r[0] ? ' checked' : '') + '><b>' + r[1] + '</b>' +
              (r[0] !== 'custom' ? '<small>' + esc(rlabel(r[0])) + '</small>' : '') + '</label>'; }).join('') +
          '<div class="tsm-custom"><select data-c="s" aria-label="السورة">' + suras.map(function (s) {
              return '<option value="' + s.s + '"' + (s.s === cs.s ? ' selected' : '') + '>' + s.s + '. ' + esc(s.name) + '</option>'; }).join('') + '</select>' +
            '<label>من <input type="number" data-c="a1" min="1" max="' + cs.n + '" value="' + Math.min(+prefs.ca1 || 1, cs.n) + '"></label>' +
            '<label>إلى <input type="number" data-c="a2" min="1" max="' + cs.n + '" value="' + Math.min(+prefs.ca2 || cs.n, cs.n) + '"></label></div>' +
        '</div></div>' +
        '<div class="tsm-fr tsm-voice-only"><span>الصرامة</span>' + seg('level', [['strict', 'صارم'], ['very', 'صارم جدًا']], prefs.level) +
          '<small>' + (prefs.level === 'very' ? 'يطابق كل حرف، وأي «و» أو «ف» لم يكتبها Chrome تُحسب خطأً.' : 'يتسامح فقط مع ما يكتبه Chrome خطأً لقراءة صحيحة، مثل حذف «و» و«ف» المنطوقتين.') + '</small></div>' +
        '<div class="tsm-fr tsm-voice-only"><span>عند الخطأ</span>' + seg('reveal', [['3', 'اكشف الكلمة بعد 3 محاولات'], ['0', 'لا تكشف أبدًا']], prefs.reveal) + '</div>' +
        '<p class="tsm-note">' + (prefs.mode === 'voice'
          ? 'تُغطّى الكلمات، وتنكشف كل كلمة حين تقرؤها صحيحة. عند الخطأ تصبح الكلمة حمراء ويقف التسميع عندها حتى تقرأها صحيحة. التشكيل والتجويد لا يُكشفان: التعرّف الصوتي يكتب حروفًا بلا حركات.'
          : 'تُغطّى الكلمات وتكشفها بنفسك: <kbd>Home</kbd> للكلمة التالية و<kbd>End</kbd> للسابقة، ومع <kbd>Shift</kbd> آية كاملة، و<kbd>Delete</kbd> إن أخطأت في الكلمة التي كشفتها. على الهاتف: انقر الصفحة للكلمة التالية.') + '</p>' +
      '</div>' +
      '<footer class="tsm-foot"><button class="tsm-b tsm-gold" data-s="go">ابدأ التسميع</button>' +
        '<button class="tsm-b" data-s="log">📋 سجل الأخطاء</button><button class="tsm-b" data-s="close">إلغاء</button></footer>', 'tsm-start');
    m.classList.toggle('tsm-m-eye', prefs.mode === 'eye');
    function readCustom() {
      var s = +m.querySelector('[data-c=s]').value, n = suras[s - 1].n;
      var a1 = Math.max(1, Math.min(n, Math.round(+m.querySelector('[data-c=a1]').value) || 1));
      var a2 = Math.max(a1, Math.min(n, Math.round(+m.querySelector('[data-c=a2]').value) || n));
      prefs.cs = s; prefs.ca1 = a1; prefs.ca2 = a2;
    }
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-s]'), sg = e.target.closest('.tsm-seg button');
      if (sg) { prefs[sg.parentNode.getAttribute('data-seg')] = sg.getAttribute('data-v'); savePrefs(); openStart(); return; }
      if (!b) return;
      var a = b.getAttribute('data-s');
      if (a === 'close') closeModal();
      if (a === 'log') openLog();
      if (a === 'go') {
        var r = m.querySelector('input[name=tsmRange]:checked'); prefs.range = r ? r.value : 'page';
        if (prefs.range === 'custom') readCustom();
        savePrefs();
        start(ayahsInRange(prefs.range));
      }
    });
    m.addEventListener('change', function (e) {
      if (e.target.name === 'tsmRange') { prefs.range = e.target.value; savePrefs(); }
      if (e.target.getAttribute('data-c')) {
        if (e.target.getAttribute('data-c') === 's') { prefs.cs = +e.target.value; prefs.ca1 = 1; prefs.ca2 = suras[prefs.cs - 1].n; prefs.range = 'custom'; savePrefs(); openStart(); return; }
        readCustom(); prefs.range = 'custom'; savePrefs();
        var rc = m.querySelector('input[value=custom]'); if (rc) rc.checked = true;
      }
    });
    var go = m.querySelector('[data-s=go]'); if (go) go.focus();
  }

  /* ------------------------------- input -------------------------------- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal) { var mm = modal; closeModal(); if (mm.onclose) mm.onclose(); e.stopPropagation(); e.preventDefault(); return; }
    if (!st || st.finished || modal || typing(e.target) || otherOverlay() || e.ctrlKey || e.altKey || e.metaKey) return;
    var k = e.key;
    if (k === 'Home') { e.preventDefault(); e.stopPropagation(); if (st.mode === 'eye') doNext(e.shiftKey); else doHint(); }
    else if (k === 'End') { e.preventDefault(); e.stopPropagation(); doBack(e.shiftKey); }
    else if ((k === 'Delete' || k === 'Backspace') && st.mode === 'eye') { e.preventDefault(); e.stopPropagation(); doMark(); }
  }, true);
  // a tap on the page: eye mode = next word; never the tafsir of a covered ayah
  function onCardClick(e) {
    if (!st || st.finished || !e.target.closest('#mushafCardRight, #mushafCardLeft')) return;
    e.stopPropagation(); e.preventDefault();
    if (st.mode === 'eye') doNext();
  }
  document.addEventListener('click', onCardClick, true);

  G.Tasmee = { open: openStart, start: start, stop: stop, finish: finish, openLog: openLog, closeModal: closeModal,
    heard: heard, takesWords: takesWords, onPage: onPage, isOn: function () { return !!st; },
    prefs: function () { return prefs; }, setPref: function (k, v) { prefs[k] = v; savePrefs(); },
    next: doNext, back: doBack, mark: doMark, hint: doHint,
    _state: function () { return st; }, _log: loadLog, Core: Core };
})(typeof window !== 'undefined' ? window : globalThis);
