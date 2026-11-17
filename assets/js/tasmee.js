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
    // «ءأنذرتهم» and the 17 other words that open with a double alif (ءأنتم، ءأسلمتم…): Chrome writes the
    // two as one alif, a hamza, or a و (2:6, every session of 2026-11-13)
    if (e[0] === 'ا' && e[1] === 'ا' && l > 3) { var r = e.slice(2), h = t.replace(/^(اا|ءا|اء|ءء|وا|ا|ء)/, ''); if (h === r) return true; }
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
      engine: o.engine || (o.level === 'very' ? 'v1' : 'v2'), bi: o.bi || null,   // bi(a, b): is «a b» a phrase of the Qur'an?
      reveal: o.reveal == null ? 3 : o.reveal, pauseOnFinal: o.pauseOnFinal !== false,
      sim: o.sim || function (a, b) { return a === b ? 1 : 0; } };
  }
  // base: the first word of the test (the reciter started mid-ayah); the words before it are left open
  function create(N, base) {
    base = base || 0;
    return { i: base, base: base, st: new Uint8Array(N), tries: new Uint8Array(N), ty: new Uint16Array(N),
      run: -1, runLen: 0, runKind: 0, runTok: '', runNew: false, shadow: -1, opt: -1, optJ: 0, pendAt: -1, pendLen: 0, pendTok: '',
      held: [], pfx: '', tail: 0, gap: false };   // v2: words not placed yet; the rest of a word an utterance ended inside;
      // unplaced words at the end of the last utterance; the recogniser restarted (audio may be lost)
  }
  function clone(T) {
    return { i: T.i, base: T.base, st: T.st.slice(), tries: T.tries.slice(), ty: T.ty.slice(), run: T.run, runLen: T.runLen,
      runKind: T.runKind, runTok: T.runTok, runNew: T.runNew, shadow: T.shadow, opt: T.opt, optJ: T.optJ,
      pendAt: T.pendAt, pendLen: T.pendLen, pendTok: T.pendTok, held: (T.held || []).slice(), pfx: T.pfx || '', tail: T.tail || 0, gap: !!T.gap };
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
  function backTo(X, i, t, nx, waiting, T) {
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
      else if (!nearCur && (k === X.as[i] || k === X.pas[i] || k >= i - 8 ||
               (T && T.st[k] !== S_OK && T.st[k] !== S_HID))) return k;   // restarted the ayah / said a recent or a doubtful word again, then paused
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
  // [2, 1]: two words written as one other word («من ذا» -> «عند», 2:255, fast recitation)
  var UNS_TRY = [[1, 0], [2, 0], [1, 1], [2, 1], [1, 2], [2, 2]];
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
        if (!confirms(X, E[i + a + q], tk)) { got = -1; break; }
        got++; len += tk.length;
      }
      if (got === need || (final && got > 0 && len >= 4 && toks[j + b + got] == null)) return { a: a, b: b };
    }
    // nothing heard for one or two words, and the next THREE go on exactly: in fast recitation Chrome
    // drops words it heard («the reciter said it, Chrome did not write it»). Yellow, never red: a red
    // word nobody misread stopped the reader for nothing (2026-11-13, al-Kursi read at speed)
    for (a = 1; a <= 2; a++) {
      if (i + a + 3 > X.N) break;
      var ok3 = true;
      for (q = 0; q < 3 && ok3; q++) {
        x = j + q; tk = toks[x];
        if (tk == null || (!final && x === toks.length - 1)) { if (!final) wait = true; ok3 = false; break; }
        if (!X.eq(E[i + a + q], tk)) ok3 = false;
      }
      if (ok3) return { a: a, b: 0 };
    }
    // the same, with Chrome's noise in the words after («يؤمنون» for «يوقنون», then «اولئك لهدى من ربهم»)
    var TOL = [[1, 0], [1, 1], [2, 1], [2, 0], [1, 2], [2, 2]];
    for (u = 0; u < TOL.length; u++) {
      a = TOL[u][0]; b = TOL[u][1];
      if (i + a >= X.N || (b === 0 && credit < a)) continue;   // a word not heard at all needs the exact rule above
      bad = false;
      for (q = 0; q < b && !bad; q++) {
        h = toks[j + q];
        if (h == null || (!final && j + q === toks.length - 1)) { if (!final) wait = true; bad = true; break; }
        for (d = 0; d <= 4 && i + d < X.N; d++) if (X.eq(E[i + d], h)) bad = true;
        if (isAtf(E[i], h) || PARTICLES.indexOf(h) >= 0) bad = true;
      }
      if (bad) continue;
      var f = flows(X, i + a, toks, j + b, final);
      if (f === 1) return { a: a, b: b };
      if (f === -1) wait = true;
    }
    return wait ? -2 : null;
  }
  // going back to repeat, Chrome writing the FIRST repeated word otherwise («فيما كانوا يكذبون» repeating
  // «بما كانوا يكذبون», «وما يشعرون» repeating «لا يشعرون», 2:10-12): the words after it repeat words
  // already said, up to the cursor or for two words -> k, the start of the repetition; -1 none, -2 wait
  function repeatFrom(X, T, i, toks, j, final) {
    var E = X.E, wait = false;
    for (var k = i - 1; k >= Math.max(T.base || 0, i - 20); k--) {
      var m = 0;
      for (var x = j + 1; k + 1 + m < i; x++, m++) {
        var tk = toks[x];
        if (tk == null) break;
        if (!final && x === toks.length - 1) { wait = true; break; }
        if (!X.eq(E[k + 1 + m], tk)) { m = -1; break; }
      }
      if (m >= 2 || (m >= 1 && k + 1 + m === i && (final || toks[j + 1 + m] != null))) return k;
    }
    return wait ? -2 : -1;
  }
  // after a red word the reader went on: the next three words follow it exactly -> the test follows the
  // reader (the word stays a mistake, shown) instead of waiting there while the reading runs away
  function goesOn(X, i, toks, j, final) { return flows(X, i + 1, toks, j, final) === 1; }
  // do the heard words from toks[j] go on with the expected words from E[s]? The first exactly, then at
  // least three in order within five tokens, with Chrome's noise allowed: one token that is no word here
  // and up to two expected words it swallowed or dropped («اولئك لهدى من ربهم» for «اولئك على هدى من
  // ربهم», 2:5). 1 yes, 0 no, -1 cannot tell yet (the newest interim word is not judged)
  function flows(X, s, toks, j, final) {
    var E = X.E, p = s, got = 0, noise = 0, skip = 0;
    if (s >= X.N) return 0;
    for (var x = j; x < toks.length && x < j + 5; x++) {
      var tk = toks[x];
      if (!final && x === toks.length - 1) return -1;
      var hit = -1;
      for (var d = 0; d <= (got ? 2 : 0) && p + d < X.N; d++) if (confirms(X, E[p + d], tk)) { hit = d; break; }
      if (hit < 0) { if (!got || noise) return 0; noise++; continue; }
      skip += hit; if (skip > 2) return 0;
      p += hit + 1; got++;
      if (got >= 3 || (p >= X.N && got >= 2)) return 1;
    }
    return final ? 0 : -1;
  }
  // a word that CONFIRMS the reader went on (never the word judged): also Chrome's usual slips on it —
  // an added «وا» («امنوا» for «امن») or the first letter among ا / و / ف («ولا» for «الا», 2:13)
  function confirms(X, e, t) {
    if (X.eq(e, t) || t === e + 'وا') return true;
    return e.length >= 3 && e.length === t.length && e.slice(1) === t.slice(1) && 'اوف'.indexOf(e[0]) >= 0 && 'اوف'.indexOf(t[0]) >= 0;
  }
  function markUns(T, k) {
    if (T.st[k] === S_ERR && T.tries[k] <= 1 && !(T.ty[k] & ~T_SUB)) { T.ty[k] = 0; T.tries[k] = 0; }
    T.st[k] = T.st[k] === S_ERR && T.ty[k] ? S_FIX : S_UNS;
  }
  function accept(T, k) {
    // v2: words the reader passed over, then went back and read: not left out after all
    if (T.st[k] === S_REV && T.ty[k] === T_SKIP) { T.st[k] = S_OK; T.ty[k] = 0; T.tries[k] = 0; return; }
    if (T.st[k] === S_ERR || (T.st[k] === S_REV && (T.ty[k] & T_SUB))) T.st[k] = S_FIX;   // a mistake, then said right
    else if (T.st[k] === S_HID) T.st[k] = S_OK;
  }
  function feed1(T, X, toks, final) {
    var E = X.E, defer = null;
    for (var j = 0; j < toks.length; j++) {
      if (T.i >= X.N) break;
      var t = toks[j], nx = j + 1 < toks.length ? toks[j + 1] : null, last = j === toks.length - 1;
      if (!t) continue;
      if (T.shadow >= 0) {                       // repeating words already said
        if (X.eq(E[T.shadow], t)) { if (T.st[T.shadow] === S_UNS) T.st[T.shadow] = S_OK; T.shadow++; if (T.shadow >= T.i) T.shadow = -1; T.run = -1; continue; }
        // a repeated word Chrome wrote otherwise («بعنده» for «عنده», 2:255): the repetition goes on after it,
        // so it is not judged (repeating is never graded) and it may not break the repetition
        if (X.uns && nx != null && T.shadow + 1 < X.N && (X.eq(E[T.shadow + 1], nx) || T.shadow + 1 === T.i)) {
          T.shadow++; if (T.shadow >= T.i) T.shadow = -1; T.run = -1; continue;
        }
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
      // the word Chrome is still writing shows as soon as its first letters are the expected word's
      // («تنذ» of «تنذرهم»): display only (an interim is fed to a copy), the final judges the word
      if (!final && last && t.length >= 3 && t.length * 2 >= E[i].length && E[i].indexOf(t) === 0) { accept(T, i); T.i = i + 1; break; }
      var k = backTo(X, i, t, nx, last && !final, T);
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
      if (X.uns && i > (T.base || 0)) {
        var rk = repeatFrom(X, T, i, toks, j, final);
        if (rk === -2) break;
        if (rk >= 0) { T.shadow = rk + 1 < i ? rk + 1 : -1; T.run = -1; continue; }   // repeating: not judged
      }
      if (X.uns && T.run !== i) {
        var u = unsure(T, X, i, toks, j, final);
        if (u === -2) break;
        if (u) {
          for (q = 0; q < u.a; q++) markUns(T, i + q);
          T.i = i + u.a; j += u.b - 1; T.run = -1; T.opt = -1; T.pendAt = -1;
          continue;
        }
      }
      if (X.uns && T.st[i] === S_ERR && goesOn(X, i, toks, j, final)) {
        T.st[i] = S_REV; T.i = i + 1; T.run = -1; T.pendAt = -1; j--;   // the token is the next word: judge it there
        continue;
      }
      if (!final) break;                         // interim words may still change: a mistake waits for the final ones
      // the last word of an utterance, close to the expected one, nothing after it to tell Chrome's slip
      // from the reader's («بمؤمنون» for «بمؤمنين», then a pause): not red yet — the next words decide
      if (X.uns && last && T.run !== i && !T.tries[i] && X.sim(t, E[i]) >= 0.6) { defer = t; break; }
      if (T.run !== i) {                         // a new attempt at this word
        var kind = classify(X, i, t);
        T.tries[i] = Math.min(255, T.tries[i] + 1);
        T.runNew = !(T.ty[i] & kind); T.ty[i] |= kind;
        T.run = i; T.runLen = 0; T.runKind = kind; T.runTok = t;
        T.st[i] = S_ERR;
        if (X.reveal && T.tries[i] >= X.reveal) {
          T.st[i] = S_REV; T.ty[i] |= T_REV; T.i = i + 1; T.run = -1;
          // the rest of this attempt is still that word, garbled (Chrome: «ما انسى زاجه» for «ماء ثجاجا»,
          // 78:14): judge from the first token that IS the next word, never the garble at the next word
          for (var y = j; y < toks.length; y++) if (matchAt(X, T.i, toks[y], toks[y + 1])) break;
          j = y - 1;
          continue;
        }
      }
      T.runLen++;
    }
    if (final && X.pauseOnFinal) {               // a pause ends the attempt; what was heard there may still be Chrome's
      T.pendAt = T.run === T.i && T.runKind === T_SUB ? T.i : -1; T.pendLen = T.runLen; T.pendTok = T.runTok;
      T.run = -1;
    }
    if (defer != null) { T.pendAt = T.i; T.pendLen = 1; T.pendTok = defer; }   // credit for unsure() with the next words
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
      if (T.st[k] === S_HID && (k >= T.i || X.engine !== 'v1')) continue;
      n.reached++;
      if (T.ty[k]) { n.err++; TYPES.forEach(function (ty) { if (T.ty[k] & ty[0]) n.types[ty[0]] = (n.types[ty[0]] || 0) + 1; }); }
      else { n.ok++; if (T.st[k] === S_UNS) n.uns++; }
    }
    return n;
  }

  /* ------------------------- the engine, version 2 -------------------------
   * Measured on the reader's 32 real Chrome sessions (2026-11-16): the cursor above (v1) was right about
   * one red word in four. Its mistakes were not single words: after two garbled words it fell behind the
   * reader and judged what came later against a place already left. So here the PLACE comes first:
   *
   *   every utterance is aligned as a whole to the text around the cursor (dynamic programming: a heard
   *   word matches, replaces, is noise, or two are one; an expected word may not be heard; the reader may
   *   go back), and the cursor follows the alignment. Then each word passed gets one of three states:
   *     right   — heard as written;
   *     yellow  — not heard as written, and nothing shows the reader said something else (not counted);
   *     mistake — only on evidence: three or more words (or a whole ayah) with nothing heard between two
   *               stretches heard exactly = left out; or another word that makes, with the word before
   *               it, a phrase found elsewhere in the Qur'an («عذاب اليم» for «عذاب عظيم») = swapped
   *               with a similar ayah. The test never waits on a red word.
   * v1 stays for «صارم جدًا». */
  var V2 = { BACK: 25, AHEAD: 70, C_DEL: 0.9, C_INS: 0.8, C_BACK: 1.0, C_NEAR: 0.4, C_MID: 0.95, C_FAR: 1.25, HELD: 30 };
  function skipCost(n) { return Math.min(V2.C_DEL * n, 2.4 + 0.25 * n); }   // many words left out at once cost less each
  // 0 = the word; 1 = Chrome's spelling of it or nearly it (yellow); 2 = another word
  function wkind(X, e, h) {
    if (X.eq(e, h)) return 0;
    if (confirms(X, e, h) || isAtf(e, h) || X.sim(h, e) >= 0.7) return 1;
    if (e.replace(/^(و|ف|ب|ل)?ال/, '$1') === h.replace(/^(و|ف|ب|ل)?ال/, '$1')) return 1;   // «الخوف» / «خوف»: the ear adds and drops «ال»
    return 2;
  }
  // «عذاب اليم» where the text has «عذاب عظيم»: the heard word follows the word before it somewhere in the Qur'an
  function swapLike(X, k, h) { return !!X.bi && k > 0 && h.length >= 3 && X.E[k].length >= 3 && X.bi(X.E[k - 1], h); }
  function align2(T, X, toks, final) {
    var E = X.E, c = T.i, lo = Math.max(T.base || 0, c - V2.BACK), hi = Math.min(X.N, c + V2.AHEAD), W = hi - lo, m = toks.length;
    if (!m || W <= 0) return null;
    var S = W + 1, dp = new Float32Array((m + 1) * S).fill(1e9), bp = new Int32Array((m + 1) * S).fill(-1), op = new Uint8Array((m + 1) * S);
    // op: 1 match(1:1) 2 two expected in one heard 3 one expected in two heard 4 two-for-two 5 expected not heard 6 heard not placed 7 back
    function set(j, k, v, pj, pk, o) { var x = j * S + k; if (v < dp[x] - 1e-6) { dp[x] = v; bp[x] = pj * S + pk; op[x] = o; } }
    function relax(j) {
      var k, x;
      for (k = 0; k < W; k++) { x = j * S + k; if (dp[x] < 1e8) set(j, k + 1, dp[x] + (j === 0 && lo + k >= c ? skipCost(lo + k + 1 - c) - skipCost(lo + k - c) : V2.C_DEL), j, k, 5); }
      var best = 1e9, bk = -1;
      for (k = W; k >= 0; k--) {              // going back to say words again
        x = j * S + k;
        if (bk >= 0 && best + V2.C_BACK < dp[x] - 1e-6 && bk - k <= V2.BACK) { dp[x] = best + V2.C_BACK; bp[x] = j * S + bk; op[x] = 7; }
        if (dp[x] < best && op[x] !== 7) { best = dp[x]; bk = k; }
      }
      for (k = 0; k < W; k++) { x = j * S + k; if (dp[x] < 1e8 && op[x] === 7) set(j, k + 1, dp[x] + V2.C_DEL, j, k, 5); }
    }
    dp[0 * S + (c - lo)] = 0; op[c - lo] = 0;
    for (var k0 = 0; k0 < c - lo; k0++) { dp[k0] = 0.3; op[k0] = 0; }    // the utterance starts on words already said
    relax(0);
    for (var j = 0; j < m; j++) {
      var h = toks[j], h2 = j + 1 < m ? toks[j + 1] : null, lastTok = j === m - 1;
      for (var k = 0; k <= W; k++) {
        var x = j * S + k, d = dp[x];
        if (d > 1e8) continue;
        set(j + 1, k, d + V2.C_INS, j, k, 6);
        if (k >= W) continue;
        var e = E[lo + k], kd = wkind(X, e, h), cost = kd === 0 ? 0 : kd === 1 ? V2.C_NEAR : X.sim(h, e) >= 0.55 ? V2.C_MID : V2.C_FAR;
        if (kd === 2 && swapLike(X, lo + k, h)) cost = 0.7;                // cheaper than leaving it unplaced
        // the word Chrome was still writing when the utterance ended («يتساء» of «يتساءلون»)
        if (kd && lastTok && h.length >= 3 && h.length * 2 >= e.length && e.indexOf(h) === 0) cost = 0.1;
        set(j + 1, k + 1, d + cost, j, k, 1);
        if (k + 1 < W && X.eq(e + E[lo + k + 1], h)) set(j + 1, k + 2, d, j, k, 2);
        if (h2 != null && X.eq(e, h + h2)) set(j + 2, k + 1, d, j, k, 3);
        if (kd && h2 != null && k + 1 < W && h + h2 === e + E[lo + k + 1]) set(j + 2, k + 2, d, j, k, 4);   // «ما لهذا» / «مال هذا»
      }
      relax(j + 1);
    }
    var end = -1, bestV = 1e9;
    for (k = 0; k <= W; k++) if (dp[m * S + k] < bestV - 1e-6) { bestV = dp[m * S + k]; end = k; }
    var path = [];
    for (var cur = m * S + end; bp[cur] >= 0; cur = bp[cur]) path.push({ o: op[cur], j: Math.floor(bp[cur] / S), k: lo + (bp[cur] % S) });
    path.reverse();
    return { path: path, cost: bestV, end: lo + end };
  }
  // the utterance (but for its first or last word) is the text word for word from some place ahead of the
  // cursor: the words between were not said. -> the same shape as align2's result, or null
  function runAhead(T, X, toks) {
    var E = X.E, c = T.i, hi = Math.min(X.N, c + V2.AHEAD), m = toks.length;
    for (var j0 = 0; j0 <= 1 && j0 < m; j0++) {
      for (var s = c + 1; s < hi; s++) {
        var r = 0;
        while (j0 + r < m && s + r < X.N && X.eq(E[s + r], toks[j0 + r])) r++;
        if (r < 3 || r < m - j0 - 1) continue;
        var path = [], k;
        for (k = c; k < s; k++) path.push({ o: 5, j: 0, k: k });
        if (j0) path.push({ o: 6, j: 0, k: s });
        for (k = 0; k < r; k++) path.push({ o: 1, j: j0 + k, k: s + k });
        if (j0 + r < m) path.push({ o: 6, j: j0 + r, k: s + r });
        return { path: path, cost: 0, end: s + r, hits: r };
      }
    }
    return null;
  }
  function hitsOf(X, toks, R) {
    var n = 0;
    R.path.forEach(function (s) { if (s.o === 2 || s.o === 3) n++; else if (s.o === 4) n += 2; else if (s.o === 1 && X.eq(X.E[s.k], toks[s.j])) n++; });
    return n;
  }
  function feed2(T, X, toks, final) {
    var E = X.E;
    toks = toks.filter(Boolean);
    if (!toks.length || T.i >= X.N) return T;
    // the rest of a word the last utterance ended inside («يتساء» | «لون»)
    if (T.pfx && toks.length && (toks[0] === T.pfx || (T.pfx.length > toks[0].length && T.pfx.slice(-toks[0].length) === toks[0]))) toks = toks.slice(1);
    if (final) T.pfx = '';
    // isti'adha, basmala, «صدق الله العظيم» at the start of an utterance are not the text
    for (var z = 0; z < OPT.length; z++) {
      var p = OPT[z], n = 0;
      while (n < p.length && n < toks.length && p[n] === toks[n]) n++;
      if (n === p.length && !(T.i < X.N && X.eq(E[T.i], p[0]) && T.i + 1 < X.N && X.eq(E[T.i + 1], p[1]))) { toks = toks.slice(n); break; }
    }
    if (!toks.length) return T;
    var held = T.held || [], tries = held.length ? [toks, held.concat(toks)] : [toks], A = null, used = null;
    for (var a = 0; a < tries.length && !A; a++) {
      var R = align2(T, X, tries[a], final), ok = R && placed(T, X, tries[a], R);
      var F = final || tries[a].length >= 5 ? runAhead(T, X, tries[a]) : null;      // an interim needs more words to say so
      if (F && (!ok || F.hits > hitsOf(X, tries[a], R))) { A = F; used = tries[a]; }
      else if (ok) { A = R; used = tries[a]; }
    }
    if (!A) { if (final) { T.held = held.concat(toks).slice(-V2.HELD); T.tail = T.held.length; } return T; }   // not placed yet: wait for more
    var dirty = !!(T.tail || T.gap || used !== toks);   // noise or lost audio before this utterance
    if (final) { T.held = []; T.gap = false; var tn = 0; for (var u = A.path.length - 1; u >= 0 && A.path[u].o === 6; u--) tn++; T.tail = tn; }
    toks = used;
    var c0 = T.i, m = toks.length, path = A.path, exact = function (s) { return s && (s.o === 2 || s.o === 3 || s.o === 4 || (s.o === 1 && X.eq(E[s.k], toks[s.j]))); };
    var maxK = T.i;
    for (var q = 0; q < path.length; q++) {
      var s = path[q], k = s.k, lastTok = s.j === m - 1;
      if (s.o === 1) {
        var kd = wkind(X, E[k], toks[s.j]);
        if (kd && lastTok && toks[s.j].length >= 3 && toks[s.j].length * 2 >= E[k].length && E[k].indexOf(toks[s.j]) === 0) {
          if (final) { T.pfx = E[k].slice(toks[s.j].length); accept(T, k); } else accept(T, k);
        } else if (kd === 0) { if (T.st[k] === S_UNS) T.st[k] = S_OK; else accept(T, k); }
        else if (!final && lastTok) { /* the newest interim word is not judged */ }
        else if (T.st[k] === S_HID && k >= c0) {
          var red = false;
          if (final && kd === 2 && swapLike(X, k, toks[s.j]) && exact(path[q - 1]) && path[q - 1].k + (path[q - 1].o === 2 || path[q - 1].o === 4 ? 2 : 1) === k) {
            // another word that goes with the word before it elsewhere in the Qur'an, and then the text again or nothing
            var after = path[q + 1];
            red = !after || exact(after) || path.slice(q + 1).every(function (y) { return y.o === 6; });
          }
          if (red) { T.st[k] = S_REV; T.ty[k] |= T_SUB; T.tries[k] = 1; } else T.st[k] = S_UNS;
        }
        maxK = Math.max(maxK, k + 1);
      } else if (s.o === 2 || s.o === 4) { accept(T, k); accept(T, k + 1); if (T.st[k] === S_UNS) T.st[k] = S_OK; if (T.st[k + 1] === S_UNS) T.st[k + 1] = S_OK; maxK = Math.max(maxK, k + 2); }
      else if (s.o === 3) { accept(T, k); if (T.st[k] === S_UNS) T.st[k] = S_OK; maxK = Math.max(maxK, k + 1); }
      else if (s.o === 5) {
        if (k < c0 || T.st[k] !== S_HID) continue;
        var r = q; while (r < path.length && path[r].o === 5) r++;          // a run of words not heard: path[q..r)
        var len = r - q, k1 = path[r - 1].k + 1;
        if (r >= path.length) break;                                         // the utterance ended before them: not passed yet
        var before = q === 0 ? (!dirty && k === c0 && k > (T.base || 0) && T.st[k - 1] !== S_HID) : exact(path[q - 1]);
        var landed = exact(path[r]) && exact(path[r + 1]);
        var wholeAyah = X.as[k] === k && (k1 >= X.N || X.as[k1] === k1);
        var out = final && before && landed && len <= 30 && (len >= 3 || wholeAyah);
        for (var y = q; y < r; y++) {
          var kk = path[y].k;
          if (T.st[kk] !== S_HID) continue;
          if (len > 30) continue;                                            // the reader moved on far ahead: not tested, not judged
          if (out) { T.st[kk] = S_REV; T.ty[kk] |= T_SKIP; T.tries[kk] = 1; } else if (final) T.st[kk] = S_UNS; else T.st[kk] = S_UNS;
        }
        maxK = Math.max(maxK, k1);
        q = r - 1;
      }
    }
    if (maxK > T.i) T.i = Math.min(maxK, X.N);
    return T;
  }
  // is the alignment a real placing of these words in the text (not noise that happened to touch it)?
  function placed(T, X, toks, R) {
    var E = X.E, m = toks.length, hit = 0, atCursor = false, run = 0, bestRun = 0;
    R.path.forEach(function (s) {
      var h = s.o === 1 ? toks[s.j] : '', e = E[s.k];
      // the word itself, or its first letters at the cursor when the utterance ended inside it («يتساء» of a long madd)
      var ok = s.o === 2 || s.o === 3 || s.o === 4 || (s.o === 1 && (wkind(X, e, h) === 0 ||
        (s.k === T.i && s.j === m - 1 && h.length >= 3 && h.length * 2 >= e.length && e.indexOf(h) === 0)));
      if (ok) { hit += s.o === 3 || s.o === 4 ? 2 : 1; run++; if (run > bestRun) bestRun = run; if (s.k === T.i) atCursor = true; }
      else if (s.o === 1 || s.o === 6) run = 0;
    });
    if (hit === m) return true;
    if (atCursor && hit >= 1 && hit * 2 >= m) return true;
    return hit >= 2 && hit >= 0.34 * m && (bestRun >= 2 || atCursor);
  }
  function feed(T, X, toks, final) { return X.engine === 'v1' ? feed1(T, X, toks, final) : feed2(T, X, toks, final); }

  var Core = { create: create, clone: clone, feed: feed, align2: align2, makeCtx: makeCtx, hint: hint, eyeNext: eyeNext, eyeBack: eyeBack,
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
  function wordsTxt(n) { return plural(n, 'كلمة واحدة', 'كلمتان', 'كلمات', 'كلمة'); }
  function typeNames(bits) { return TYPES.filter(function (t) { return bits & t[0]; }).map(function (t) { return t[1]; }); }
  function dateTxt(ts) { try { return new Date(ts).toLocaleDateString('ar-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }

  var prefs = Object.assign({ mode: 'voice', level: 'strict', reveal: 3 }, readJSON(PREF_KEY, {}));
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
    st.X = makeCtx(E, as, pas, { level: prefs.level, reveal: +prefs.reveal, sim: R().wordSim, bi: quranPhrase,
      engine: prefs.engine === 'v1' ? 'v1' : undefined });   // (prefs.engine = 'v1': the old cursor with «صارم»'s spelling, kept to measure against)
    st.over = {};
    st.T = st.shown = create(E.length, base || 0);
    st.at = at; st.first = first; st.seg0 = Date.now();
    if (!st.acc.first && !st.fixed) st.acc.first = { ai: ayahIdx[0], w: base || 0 };
  }
  var BI = null;   // every pair of neighbouring words in the Qur'an (built once, ~75k)
  function quranPhrase(a, b) {
    if (!BI) { BI = new Set(); var c = C(), W = c.words; for (var p = 0; p + 1 < c.L; p++) if (!c.virt[p] && !c.virt[p + 1]) BI.add(W[p] + ' ' + W[p + 1]); }
    return BI.has(a + ' ' + b);
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
    if (mode === 'voice' && o.tech && R() && R().setEars && !st) R().setEars(o.tech === 'tilawi' ? 'ctc' : 'browser');
    if (mode === 'voice' && !(G.SpeechRecognition || G.webkitSpeechRecognition) && ['quran', 'ctc'].indexOf(localStorage.getItem('recite_ears')) < 0) {
      toast('المتصفح لا يدعم التعرّف الصوتي هنا: التسميع بالعين'); mode = 'eye';
    }
    st = { mode: mode, X: null, T: null, shown: null, at: null, first: null, pre: [], heard: [], lastHeard: '', warn: '',
      acc: newAcc(), fixed: o.ayahs && o.ayahs.length ? o.ayahs.slice() : null, over: {}, movedAt: Date.now(), lastI: -1,
      tech: mode !== 'voice' ? '' : (['ctc', 'quran'].indexOf(R() && R().earsPref ? R().earsPref() : '') >= 0 ? 'tilawi' : 'chrome') };
    if (mode === 'voice') st.idleT = setInterval(idleWatch, 15000);
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
    clearInterval(s.idleT);
    closeSegment();
    st = null;
    techAdd(s);
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
  function toggle() { if (st) stop(); else if (prefs.mode === 'voice' && prefs.ask !== false) choose(); else start(); }

  /* ----------------- two ears, chosen at every start, compared over time -----------------
   * 'tasmee_tech.v1' = { chrome: {n, words, red, cleared, yellow, marked, hints, secs}, tilawi: {...} }:
   * red = words the engine made a mistake; cleared = of those, the ones the reader tapped «not a mistake»
   * (the false reds, by the reader's own judgement); marked = yellow words the reader made a mistake. */
  var TECH_KEY = 'tasmee_tech.v1';
  var TECHS = [['chrome', '🎧', 'Chrome', 'سريع ويعمل على كل جهاز. تعرّف عام، غير مدرَّب على التلاوة.'],
               ['tilawi', '🧠', 'الأذن القرآنية', 'نموذج Tilawi المدرَّب على التلاوة. يعمل على جهازك (90 ميغابايت مرة واحدة)، وأسرع مع الخادم المحلي.']];
  function techLoad() { var d = readJSON(TECH_KEY, {}); if (!d || typeof d !== 'object') d = {}; TECHS.forEach(function (t) { d[t[0]] = Object.assign({ n: 0, words: 0, red: 0, cleared: 0, yellow: 0, marked: 0, hints: 0, secs: 0 }, d[t[0]]); }); return d; }
  function techAdd(s) {
    var A = s.acc;
    if (s.mode !== 'voice' || !s.tech || !A || A.reached < 5) return;      // a few words are not a session
    var d = techLoad(), t = d[s.tech], marked = A.types[T_MARK] || 0, hints = A.types[T_HINT] || 0, cleared = A.cleared || 0;
    t.n++; t.words += A.reached; t.red += Math.max(0, A.err - marked - hints) + cleared; t.cleared += cleared;
    t.yellow += A.uns + marked; t.marked += marked; t.hints += hints; t.secs += Math.round((Date.now() - A.t0) / 1000);
    writeJSON(TECH_KEY, d);
  }
  function per100(a, b) { return b ? (Math.round(1000 * a / b) / 10) + '' : '—'; }
  function techTable() {
    var d = techLoad();
    if (!TECHS.some(function (t) { return d[t[0]].n; })) return '<p class="tsm-note">لا جلسات بعد. بعد بضع جلسات بكل أذن يظهر هنا جدول يقارن بينهما.</p>';
    var row = function (label, f, hint) { return '<tr' + (hint ? ' title="' + esc(hint) + '"' : '') + '><th>' + label + '</th>' + TECHS.map(function (t) { return '<td>' + f(d[t[0]]) + '</td>'; }).join('') + '</tr>'; };
    return '<table class="tsm-cmp"><thead><tr><th></th>' + TECHS.map(function (t) { return '<th>' + t[1] + ' ' + t[2] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      row('الجلسات', function (x) { return x.n; }) +
      row('الكلمات', function (x) { return x.words; }) +
      row('أحمر لكل 100 كلمة', function (x) { return per100(x.red, x.words); }, 'كلمات حكمت الأذن بأنها خطأ') +
      row('<b>أحمر كاذب</b> (ألغيتَه)', function (x) { return x.red ? '<b>' + x.cleared + ' من ' + x.red + '</b>' : '—'; }, 'كلمات حمراء لمستَها لأنها لم تكن خطأً: كلما قلّت كانت الأذن أصدق') +
      row('أصفر لكل 100 كلمة', function (x) { return per100(x.yellow, x.words); }, 'كلمات لم تُسمع كما هي فلم يُحكم عليها: كلما قلّت كانت الأذن أدق سمعًا') +
      row('أصفر كان خطأً (علّمتَه)', function (x) { return x.yellow ? x.marked + ' من ' + x.yellow : '—'; }) +
      row('مساعدة 💡', function (x) { return x.hints; }) +
      '</tbody></table><p class="tsm-note">الحكم لك: المس الكلمة <b>الحمراء</b> إن لم تكن خطأً، و<b>الصفراء</b> إن كانت خطأً. بهذا يُقاس صدق كل أذن على قراءتك أنت.</p>';
  }
  function choose() {
    var last = 'chrome'; try { last = ['ctc', 'quran'].indexOf(R().earsPref()) >= 0 ? 'tilawi' : 'chrome'; } catch (e) {}
    var canLocal = !!(G.Worker && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && location.protocol !== 'file:');
    var canChrome = !!(G.SpeechRecognition || G.webkitSpeechRecognition);
    var d = techLoad();
    var m = openModal('<div class="tsm-head"><b>🧠 بأي أذن تسمّع الآن؟</b><button class="tsm-x" data-c="x" title="إغلاق">✕</button></div>' +
      '<div class="tsm-body"><div class="tsm-techs">' + TECHS.map(function (t) {
        var ok = t[0] === 'chrome' ? canChrome : canLocal, x = d[t[0]];
        return '<button class="tsm-tech' + (t[0] === last ? ' on' : '') + '" data-tech="' + t[0] + '"' + (ok ? '' : ' disabled') + '>' +
          '<span class="tsm-tech-ic">' + t[1] + '</span><b>' + t[2] + '</b><small>' + (ok ? t[3] : 'غير متاحة في هذا المتصفح') + '</small>' +
          '<i>' + (x.n ? sessTxt(x.n) + ' · ' + x.words + ' كلمة' : 'لم تُجرَّب بعد') + '</i></button>'; }).join('') + '</div>' +
      techTable() + '</div>' +
      '<div class="tsm-foot"><button class="tsm-b" data-c="eye">👁 بالعين (بلا صوت)</button><span class="tsm-foot-note">يُسأل عند كل بدء · يُلغى من ⚙️ الإعدادات</span></div>', 'tsm-choose');
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tech], [data-c]'); if (!b || b.disabled) return;
      var tech = b.getAttribute('data-tech'), c = b.getAttribute('data-c');
      closeModal();
      if (tech) start({ tech: tech }); else if (c === 'eye') start({ mode: 'eye' });
    });
    var on = m.querySelector('.tsm-tech.on:not([disabled])') || m.querySelector('.tsm-tech:not([disabled])'); if (on) on.focus();
  }
  // a mic left open: three minutes with no step forward in the text -> paused (2026-11: sessions ran for hours)
  function idleWatch() {
    if (!st || st.mode !== 'voice' || !micOn()) return;
    if (Date.now() - st.movedAt < 180000) return;
    togglePause();
    if (st) { st.status = '⏸ أُوقف المايك: لا تلاوة منذ 3 دقائق. اضغط ▶ للمتابعة'; renderBar(); }
  }
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
    st.X = st.T = st.shown = st.at = st.first = st.stall = null;
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
  // the reader went on somewhere else (al-Kursi, then «آمن الرسول», 2026-11-13): the words heard since
  // the cursor last moved run on exactly for 6+ words at a place more than an ayah away -> close this
  // segment as it stood before those words (they are not its mistakes) and start a new one there
  function jumpTo(stall) {
    var toks = dropOpeners(stall.toks) || [];
    if (toks.length < 6) return false;
    var hit = locate(toks);
    if (!hit || toks.length - hit.from < 6) return false;
    var c = C(), aiNew = c.ayahOf[hit.pos], cur = st.at[Math.min(st.T.i, st.at.length - 1)];
    if (!cur || (aiNew >= cur.ai - 1 && aiNew <= cur.ai + 1)) return false;   // near: the test itself judges it
    st.T = st.shown = stall.T; st.stall = null;
    closeSegment();
    toast('↪ انتقلتَ إلى موضع آخر: التسميع يتابعك من هناك');
    return tryAnchor(toks, []);
  }
  function gap() { if (st && st.T) st.T.gap = true; }
  function heard(words, raw, final) {
    if (!takesWords()) return;
    var S = R()._session;
    st.warn = '';
    var shownHeard = final ? (st.heard = st.heard.concat(raw || words).slice(-12)) : st.heard.concat(raw || words).slice(-12);
    var sp = document.getElementById('dockSpeechText'); if (sp) sp.textContent = '"' + shownHeard.slice(-8).join(' ') + '"';
    st.lastHeard = shownHeard.slice(-6).join(' ');
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
    if (final) {
      st.skipIv = 0;
      var before = clone(st.T), startedAt = st.lastFinalAt || st.seg0;
      if (ws.length) feed(st.T, st.X, ws, true);
      st.shown = st.T;
      if (st.T.i > before.i) st.stall = null;
      else if (ws.length && !st.fixed) {          // no step forward: did the reader go somewhere else?
        if (!st.stall) st.stall = { T: before, toks: [] };
        st.stall.toks = st.stall.toks.concat(ws).slice(-30);
        if (jumpTo(st.stall)) { afterChange(); return; }
      }
      maybeRescue(before, before.pendAt === before.i && st.prevFinalAt ? st.prevFinalAt : startedAt);
      st.prevFinalAt = startedAt; st.lastFinalAt = Date.now();
    }
    else st.shown = ws.length ? feed(clone(st.T), st.X, ws, false) : st.T;
    afterChange();
  }
  // the rescue ear (⚙️ «Chrome + إنقاذ قرآني»): a word this final turned into a mistake is heard again by the
  // Quran-trained model (Tilawi) on the same stretch of audio; its words are fed to the state BEFORE this
  // final, and every word that comes out right there is cleared here — it can only clear, never accuse
  function maybeRescue(before, from) {
    var rb = R();
    if (!rb || !rb.rescueOn || !rb.rescueOn() || !st || !st.X) return;
    var T = st.T, hit = -1, end = Math.min(T.i, st.X.N - 1);
    for (var k = before.i; k <= end; k++) if (T.ty[k] && !before.ty[k]) { hit = k; break; }
    if (hit < 0) return;
    var secs = Math.max(6, Math.min(20, (Date.now() - (from || Date.now() - 8000)) / 1000 + 1.5));   // more is harmless: earlier words are a repeat
    var seg = st.seg0, base = clone(before), X = st.X;
    st.rescuing = (st.rescuing || 0) + 1;
    rb.rescueHear(secs).then(function (r) {
      if (st) st.rescuing = Math.max(0, (st.rescuing || 1) - 1);
      if (st) st.lastRescue = { secs: secs, text: r && r.text, ms: r && r.ms, at: hit };
      if (!st || st.X !== X || st.seg0 !== seg || !r || !r.text) return;
      var toks = rb.tokenize(r.text), alt = feed(base, X, toks, true), T = st.T, cleared = [];
      for (var q = before.i; q < Math.min(Math.max(alt.i, T.i + 1), X.N); q++) {
        if (!T.ty[q]) continue;
        // right in the Quran ear's reading from the same start, or heard right beside a right neighbour
        // anywhere in it («… ماء ثجاجا»: the window may cut the first words)
        if ((q < alt.i && !alt.ty[q] && (alt.st[q] === S_OK || alt.st[q] === S_UNS)) || heardIn(X, toks, q)) {
          T.ty[q] = 0; T.tries[q] = 0; T.st[q] = S_OK; cleared.push(q);
        }
      }
      if (!cleared.length) return;
      if (cleared.indexOf(T.i) >= 0) {             // still waiting on a word it cleared: go on
        var to = Math.max(T.i + 1, alt.i);
        for (q = T.i; q < to; q++) if (T.st[q] === S_HID || T.st[q] === S_ERR) { T.st[q] = S_OK; T.ty[q] = 0; T.tries[q] = 0; }
        T.i = to; T.run = -1; T.pendAt = -1;
      }
      st.shown = st.T; st.acc.rescued = (st.acc.rescued || 0) + cleared.length;
      toast('🧠 الأذن القرآنية سمعت «' + cleared.map(wordAt).join(' ') + '» صحيحة');
      afterChange();
    });
  }
  // the expected word q among heard tokens, next to its own neighbour (before or after it)
  function heardIn(X, toks, q) {
    var E = X.E;
    for (var p = 0; p < toks.length; p++) {
      if (!X.eq(E[q], toks[p])) continue;
      if (q > 0 && p > 0 && confirms(X, E[q - 1], toks[p - 1])) return true;
      if (q + 1 < X.N && p + 1 < toks.length && confirms(X, E[q + 1], toks[p + 1])) return true;
    }
    return false;
  }
  function afterChange() {
    if (!st || !st.X) { renderBar(); return; }
    var T = st.shown, X = st.X;
    if (T.i < X.N && T.st[T.i] === S_ERR) {
      var left = X.reveal ? X.reveal - T.tries[T.i] : 0;
      st.status = '✗ ' + typeNames(T.ty[T.i] & 31).join('، ') + ' — أعد الكلمة الحمراء' +
        (X.reveal ? ' (' + triesTxt(T.tries[T.i]) + '، تنكشف بعد ' + (left === 1 ? 'محاولة أخرى' : left === 2 ? 'محاولتين' : left + ' محاولات') + ')' : ' (' + triesTxt(T.tries[T.i]) + ')');
    } else if (T.i < X.N && st.mode === 'voice') {
      var u = -1, rd = -1;
      for (var k = T.i - 1; k >= Math.max(T.base, T.i - 12) && rd < 0; k--) if (T.st[k] === S_REV && (T.ty[k] & (T_SKIP | T_SUB))) rd = k;
      for (k = T.i - 1; k >= Math.max(T.base, T.i - 4) && u < 0; k--) if (T.st[k] === S_UNS) u = k;
      st.status = rd >= 0 ? '✗ ' + ((T.ty[rd] & T_SKIP) ? 'تُركت' : 'بُدّلت') + ' «' + wordAt(rd) + '» — المسها إن لم تكن خطأً'
        : u >= 0 ? '🟡 «' + wordAt(u) + '» لم تُسمع كما هي، فلم تُحسب خطأً. المسها إن كنت أخطأت فيها'
        : 'التالية من ' + where(T.i);
    }
    if (st.T.i !== st.lastI) { st.lastI = st.T.i; st.movedAt = Date.now(); }
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
      var c = T && k >= 0 ? 'tsm-w' + CLS[T.st[k]] + (k === T.i ? ' tsm-cur' : '') + (st.over && st.over[k] ? ' tsm-over' : '') : 'tsm-w';
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
    var anchor = document.getElementById('topControlsBar');
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
          '<button class="tsm-b" data-tsm="hint" title="اكشف الكلمة التالية (Home) — تُسجَّل خطأً">💡' + lbl('مساعدة') + '</button>'
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
      if (T.st[k] === S_HID && (k >= T.i || X.engine !== 'v1')) continue;
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
    var T0 = st.T, engineRed = (T0.st[k] === S_REV || T0.st[k] === S_FIX) && (T0.ty[k] & (T_SKIP | T_SUB)) && !(T0.ty[k] & (T_HINT | T_MARK)) && st.X.engine !== 'v1';
    if (engineRed) {                                    // «not a mistake»: the ear was wrong
      st.over[k] = { st: T0.st[k], ty: T0.ty[k], tries: T0.tries[k] };
      [st.T, st.shown].forEach(function (T, n) { if (n && T === st.T) return; T.st[k] = S_OK; T.ty[k] = 0; T.tries[k] = 0; });
      st.acc.cleared = (st.acc.cleared || 0) + 1;
      st.status = '✓ «' + wordAt(k) + '» ليست خطأً (المسها ثانيةً للتراجع)';
      paint(); return;
    }
    if (st.over[k] && T0.st[k] === S_OK) {              // back to the ear's verdict
      var o = st.over[k]; delete st.over[k];
      [st.T, st.shown].forEach(function (T, n) { if (n && T === st.T) return; T.st[k] = o.st; T.ty[k] = o.ty; T.tries[k] = o.tries; });
      st.acc.cleared = Math.max(0, (st.acc.cleared || 0) - 1);
      st.status = '✗ «' + wordAt(k) + '» خطأ كما حكمت الأذن';
      paint(); return;
    }
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
    heard: heard, takesWords: takesWords, onPage: onPage, onMicStop: onMicStop, isOn: function () { return !!st; }, gap: gap,
    choose: choose, techStats: techLoad,
    prefs: function () { return prefs; }, setPref: function (k, v) { prefs[k] = v; savePrefs(); },
    next: doNext, back: doBack, mark: doMark, hint: doHint,
    _state: function () { return st; }, _log: loadLog, Core: Core };
})(typeof window !== 'undefined' ? window : globalThis);
