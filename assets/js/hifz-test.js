/* Hifz test (اختبار الحفظ): the words of the open page are hidden, and each
 * word appears when it is recited. Skipped, wrong and hinted words are marked
 * on the page, summed up at the end, and logged for review.
 *
 * Hooks: index.html onVoiceAyahDetected() -> HifzTest.onWord(m) for every
 * painted word (m.pos = corpus position); goToPage() -> HifzTest.onPage();
 * recite-by-mic.js commitWords() -> HifzTest.onHeard(words) (final tokens).
 *
 * Skips are found by ALIGNING the heard words with the text (align(), pure,
 * tested in tests/hifz_align.js), not from the highlight: the highlight steps
 * through short gaps word by word whether or not they were recited.
 *
 * Storage: 'hifz_prefs' {mode}, 'hifz_history' [last 60 tests],
 * 'hifz_words' {"s:a:w": {n, t}} (how often each word went wrong).
 */
(function (G) {
  'use strict';
  var HAS_DOM = typeof document !== 'undefined';

  /* ------------------------- alignment (pure) ------------------------- */
  // E = expected words, T = heard tokens (both normalised), sim(a, b) in [0, 1].
  // Returns labels[i] for every E word: 'ok' | 'weak' | 'wrong' | 'skip', and
  // match[i] = the T index it was matched with (-1 = none).
  // Costs: a heard word that is not in the text (a repeat, noise, «صدق الله»)
  // is cheap; a text word nobody said costs 1; Chrome's merged / split words
  // («يا ايها» -> «ياايها») match two-for-one.
  var COST = { EXTRA: 0.55, LEAD: 0.15, TRAIL: 0.05, SKIP: 1.0, WRONG: 1.2, WEAK: 0.45 };
  function align(E, T, sim, opt) {
    opt = opt || {};
    var n = E.length, m = T.length, W = m + 1, INF = 1e9;
    var lead = opt.lead == null ? COST.LEAD : opt.lead, trail = opt.trail == null ? COST.TRAIL : opt.trail;
    var D = new Float64Array((n + 1) * W), B = new Int8Array((n + 1) * W);
    for (var q = 0; q < D.length; q++) D[q] = INF;
    D[0] = 0;
    var band = (n * m > 60000) ? 60 : 0;   // long stretches: stay near the diagonal
    var cache = {};
    function S(a, b) { var k = a + '|' + b; var v = cache[k]; if (v === undefined) v = cache[k] = sim(a, b); return v; }
    function sub(sv) { return sv >= 0.75 ? (1 - sv) * 0.5 : sv >= 0.5 ? COST.WEAK : COST.WRONG; }
    for (var i = 0; i <= n; i++) {
      var jc = m ? Math.round(i * m / Math.max(1, n)) : 0;
      for (var j = 0; j <= m; j++) {
        if (band && Math.abs(j - jc) > band) continue;
        var k = i * W + j, best = D[k], bp = B[k], c;
        if (i > 0 && j > 0 && D[k - W - 1] < INF) {
          c = D[k - W - 1] + sub(S(E[i - 1], T[j - 1])); if (c < best) { best = c; bp = 1; }
        }
        if (i > 0 && D[k - W] < INF) { c = D[k - W] + COST.SKIP; if (c < best) { best = c; bp = 2; } }
        if (j > 0 && D[k - 1] < INF) {
          c = D[k - 1] + (i === 0 ? lead : i === n ? trail : COST.EXTRA); if (c < best) { best = c; bp = 3; }
        }
        if (i > 1 && j > 0 && D[k - 2 * W - 1] < INF) {
          // only when the pair explains the heard word clearly better than one word
          // alone: «القيوم لا» ~ «القيوم» (0.81) must stay a skipped «لا»
          var sm = S(E[i - 2] + E[i - 1], T[j - 1]);
          if (sm >= 0.8 && sm > S(E[i - 2], T[j - 1]) + 0.1 && sm > S(E[i - 1], T[j - 1]) + 0.1) { c = D[k - 2 * W - 1] + (1 - sm) * 0.5 + 0.05; if (c < best) { best = c; bp = 4; } }
        }
        if (i > 0 && j > 1 && D[k - W - 2] < INF) {
          var ss = S(E[i - 1], T[j - 2] + T[j - 1]);
          if (ss >= 0.8 && ss > S(E[i - 1], T[j - 2]) + 0.1 && ss > S(E[i - 1], T[j - 1]) + 0.1) { c = D[k - W - 2] + (1 - ss) * 0.5 + 0.05; if (c < best) { best = c; bp = 5; } }
        }
        D[k] = best; B[k] = bp;
      }
    }
    var labels = new Array(n), match = new Array(n);
    for (var x = 0; x < n; x++) { labels[x] = 'skip'; match[x] = -1; }
    i = n; j = m;
    while (i > 0 || j > 0) {
      var b = B[i * W + j];
      if (b === 1) {
        var sv = S(E[i - 1], T[j - 1]);
        labels[i - 1] = sv >= 0.75 ? 'ok' : sv >= 0.5 ? 'weak' : 'wrong'; match[i - 1] = j - 1; i--; j--;
      } else if (b === 2) { labels[i - 1] = 'skip'; i--; }
      else if (b === 3) { j--; }
      else if (b === 4) { labels[i - 1] = labels[i - 2] = 'ok'; match[i - 1] = match[i - 2] = j - 1; i -= 2; j--; }
      else if (b === 5) { labels[i - 1] = 'ok'; match[i - 1] = j - 1; i--; j -= 2; }
      else break;   // unreachable cell (outside the band)
    }
    return { labels: labels, match: match, cost: D[n * W + m] };
  }

  var API = { align: align, COST: COST };
  G.HifzTest = API;
  if (!HAS_DOM) return;

  /* ------------------------------ state ------------------------------- */
  var LIVE_TAIL = 4;    // the last words shown from an interim: not judged until the final arrives
  var KEEP = 25;        // words kept open behind the newest one; older ones are frozen
  var PREF_KEY = 'hifz_prefs', HIST_KEY = 'hifz_history', WORDS_KEY = 'hifz_words';
  var st = null;        // null = off
  var prefs = readJSON(PREF_KEY, { mode: 'blur' });

  function readJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  function call(name) { var f = g(name); if (typeof f === 'function') return f.apply(null, [].slice.call(arguments, 1)); }
  function toast(msg) { call('showToast', msg); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function C() { return G.ReciteByMic && G.ReciteByMic.corpus && G.ReciteByMic.corpus(); }
  function sim(a, b) { return G.ReciteByMic.wordSim(a, b); }
  function reciting() { var S = G.ReciteByMic && G.ReciteByMic._session; return !!(S && S.active); }
  function visiblePages() {
    return g('isDoublePageMode') ? [g('currentRightPage'), g('currentLeftPage')].filter(Boolean) : [g('currentPage')];
  }
  function cardFor(page) {
    if (g('isDoublePageMode')) {
      if (page === g('currentRightPage')) return document.getElementById('mushafCardRight');
      if (page === g('currentLeftPage')) return document.getElementById('mushafCardLeft');
      return null;
    }
    return page === g('currentPage') ? document.getElementById('mushafCardRight') : null;
  }
  var pageAyahs = null;   // page -> [ayah index]
  function ayahsOn(page) {
    var c = C(); if (!c) return [];
    if (!pageAyahs) { pageAyahs = {}; c.ayahs.forEach(function (a, i) { (pageAyahs[a.page] = pageAyahs[a.page] || []).push(i); }); }
    return pageAyahs[page] || [];
  }
  function posOf(ai, w) { return C().ayahFirst[ai] + w; }
  function where(p) { var c = C(), a = c.ayahs[c.ayahOf[p]]; return { s: a.sura, a: a.aya, w: c.wordOf[p], page: a.page, name: a.suraName, ai: c.ayahOf[p] }; }

  function fresh() {
    return { segs: [], cur: null, mark: {}, seen: {}, lastPos: -1, pending: [], t0: Date.now(), peeks: 0, timer: 0 };
  }

  /* ---------------------------- segments ------------------------------ */
  // a segment = one continuous stretch of recitation: text positions
  // [from..to] and the words heard while reciting it
  function newSeg(from, carry) {
    if (st.cur) alignSeg(st.cur, true);
    var s = { from: from, to: from, toks: (carry || []).slice(), fE: 0, fT: 0 };
    st.segs.push(s); st.cur = s;
    return s;
  }
  function positions(seg) {
    var c = C(), P = [];
    for (var p = seg.from; p <= seg.to; p++) if (!c.virt[p]) P.push(p);
    return P;
  }
  function alignSeg(seg, final) {
    var c = C(); if (!c) return;
    var P = positions(seg), E = P.map(function (p) { return c.words[p]; });
    var toks = seg.toks;
    if (final && seg === st.cur) {   // words still in an interim when the test ends
      var S = G.ReciteByMic._session; if (S && S.lastInterim && S.lastInterim.length) toks = toks.concat(S.lastInterim);
    }
    var Es = E.slice(seg.fE), Ts = toks.slice(seg.fT);
    if (!Es.length) return;
    var r = align(Es, Ts, sim, { lead: seg.fE ? COST.EXTRA : COST.LEAD });
    for (var k = 0; k < Es.length; k++) {
      var idx = seg.fE + k;
      if (!final && idx >= E.length - LIVE_TAIL) continue;
      var p = P[idx];
      if (st.mark[p] === 'hint') continue;
      st.mark[p] = r.labels[k]; st.seen[p] = 1;
    }
    if (!final) {   // freeze the settled part: the next alignment starts after it
      for (var f = Es.length - 1; f >= 0; f--) {
        if (seg.fE + f <= E.length - 1 - KEEP && r.labels[f] === 'ok' && r.match[f] >= 0) {
          seg.fT += r.match[f] + 1; seg.fE += f + 1; break;
        }
      }
    }
  }
  function scheduleAlign() {
    if (!st || st.timer) return;
    st.timer = setTimeout(function () { if (!st) return; st.timer = 0; if (st.cur) alignSeg(st.cur, false); paintAll(); }, 350);
  }

  /* ------------------------------ hooks ------------------------------- */
  function onWord(m) {
    if (!st || !m || m.pos == null || m.pos < 0) return;
    var c = C(); if (!c || c.virt[m.pos]) return;
    var p = m.pos, seg = st.cur;
    if (!seg || m.isJump || p > seg.to + 40 || p < seg.from - 2 || p < seg.to - 40) {
      // a new stretch: from the ayah's start when the engine painted from there
      var w = c.wordOf[p], from = (w >= 0 && w <= 4) ? c.ayahFirst[c.ayahOf[p]] : p;
      var carry = seg ? seg.toks.slice(-6) : st.pending.slice(-30);
      st.pending = [];
      if (!seg && from === c.ayahFirst[c.ayahOf[p]]) from = extendBack(c.ayahOf[p], carry, from);
      seg = newSeg(Math.min(from, p), carry);
    }
    if (p > seg.to) seg.to = p;
    st.seen[p] = 1; st.lastPos = p;
    for (var q = seg.from; q < p; q++) if (!c.virt[q] && !st.seen[q] && q >= seg.to - 12) st.seen[q] = 1;   // stepped over by the highlight
    paintPos(p);
    scheduleAlign();
    updateBar();
  }
  // the engine shows nothing until the place is certain («الم» opens six
  // surahs: 2:1 is first shown at 2:2). Ayahs before the first shown one that
  // the words heard so far really contain belong to the test too.
  function extendBack(ai, toks, from) {
    var c = C(), cur = c.ayahs[ai];
    for (var back = 1; back <= 3 && ai - back >= 0; back++) {
      if (c.ayahs[ai - back].sura !== cur.sura) break;
      var E = [], nPrev = 0;
      for (var k = ai - back; k < ai; k++) { E = E.concat(c.ayahs[k].words); nPrev += c.ayahs[k].wordCount; }
      E = E.concat(cur.words.slice(0, 4));
      var r = align(E, toks, sim);
      for (var i = 0; i < nPrev; i++) if (r.labels[i] !== 'ok') return from;
      from = c.ayahFirst[ai - back];
    }
    return from;
  }
  function onHeard(words) {
    if (!st || !words || !words.length) return;
    if (st.cur) st.cur.toks = st.cur.toks.concat(words);
    else st.pending = st.pending.concat(words).slice(-60);
    scheduleAlign();
  }
  function onPage() { if (st) buildLayers(); }

  /* ------------------------------ masks ------------------------------- */
  function buildLayers() {
    document.querySelectorAll('.hz-layer').forEach(function (el) { el.remove(); });
    if (!st) return;
    var getBoxes = g('getAyahWordBoxes'), place = g('placeOnMushaf');
    if (typeof getBoxes !== 'function' || typeof place !== 'function') return;
    visiblePages().forEach(function (page) {
      var card = cardFor(page); if (!card) return;
      var layer = document.createElement('div');
      layer.className = 'hz-layer'; layer.setAttribute('data-page', page);
      var c = C();
      ayahsOn(page).forEach(function (ai) {
        var a = c.ayahs[ai], boxes = getBoxes(a.sura, a.aya) || [];
        for (var w = 0; w < boxes.length && w < a.wordCount; w++) {
          if (boxes[w].page !== page) continue;
          var el = document.createElement('div');
          el.className = 'hz-w'; el.setAttribute('data-pos', posOf(ai, w));
          place(el, boxes[w], 1);
          layer.appendChild(el);
        }
      });
      card.appendChild(layer);
      layer.addEventListener('click', onMaskClick);
    });
    paintAll();
  }
  function cls(p) {
    var mk = st.mark[p];
    if (mk) return 'hz-w ' + (mk === 'ok' ? 'hz-ok' : 'hz-' + mk);
    return st.seen[p] ? 'hz-w hz-ok' : 'hz-w';
  }
  function paintPos(p) {
    var el = document.querySelector('.hz-w[data-pos="' + p + '"]');
    if (el) el.className = cls(p);
  }
  function paintAll() {
    if (!st) return;
    document.querySelectorAll('.hz-w').forEach(function (el) { el.className = cls(+el.getAttribute('data-pos')); });
    updateBar();
  }
  function onMaskClick(e) {
    var el = e.target.closest('.hz-w'); if (!el || !st) return;
    var p = +el.getAttribute('data-pos');
    if (st.seen[p] || st.mark[p]) return;   // already shown: let the click through to the page
    e.stopPropagation(); e.preventDefault();
    hint(p);
  }
  function hint(p) {
    st.mark[p] = 'hint'; st.seen[p] = 1; paintPos(p); updateBar();
  }
  function nextHidden() {
    var c = C(), pages = visiblePages(), list = [];
    pages.forEach(function (pg) { ayahsOn(pg).forEach(function (ai) { for (var w = 0; w < c.ayahs[ai].wordCount; w++) list.push(posOf(ai, w)); }); });
    for (var i = 0; i < list.length; i++) if (list[i] > st.lastPos && !st.seen[list[i]] && !st.mark[list[i]]) return list[i];
    for (i = 0; i < list.length; i++) if (!st.seen[list[i]] && !st.mark[list[i]]) return list[i];
    return -1;
  }

  /* ------------------------------ counts ------------------------------ */
  function counts() {
    var n = { total: 0, ok: 0, weak: 0, wrong: 0, skip: 0, hint: 0 };
    if (!st) return n;
    var done = {};
    st.segs.forEach(function (seg) {
      positions(seg).forEach(function (p) {
        if (done[p]) return; done[p] = 1; n.total++;
        var mk = st.mark[p] || 'ok'; n[mk] = (n[mk] || 0) + 1;
      });
    });
    Object.keys(st.mark).forEach(function (p) { if (!done[p] && st.mark[p] === 'hint') { n.hint++; n.total++; } });
    return n;
  }
  function score(n) { return n.total ? Math.round(100 * (n.ok + 0.5 * n.weak) / n.total) : 0; }

  /* ------------------------------- bar -------------------------------- */
  function ensureBar() {
    var bar = document.getElementById('hifzBar');
    if (bar) return bar;
    var anchor = document.getElementById('readerStrip') || document.querySelector('.reader-controls-bar');
    if (!anchor) return null;
    bar = document.createElement('div');
    bar.id = 'hifzBar'; bar.className = 'hz-bar'; bar.setAttribute('dir', 'rtl');
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-hz]'); if (!b) return;
      var a = b.getAttribute('data-hz');
      if (a === 'mic') call('startVoiceRecitation');
      if (a === 'hint') { var p = nextHidden(); if (p >= 0) hint(p); else toast('لا كلمات مخفية في هذه الصفحة'); }
      if (a === 'mode') { prefs.mode = prefs.mode === 'blur' ? 'hide' : 'blur'; writeJSON(PREF_KEY, prefs); applyMode(); updateBar(); }
      if (a === 'finish') results();
      if (a === 'exit') { if (counts().total) results(); else stop(); }
    });
    return bar;
  }
  function updateBar() {
    if (!st) return;
    var bar = ensureBar(); if (!bar) return;
    var n = counts();
    bar.innerHTML =
      '<span class="hz-title">🙈 اختبار الحفظ</span>' +
      '<span class="hz-c hz-c-ok" title="كلمات صحيحة">✓ ' + n.ok + '</span>' +
      (n.skip ? '<span class="hz-c hz-c-skip" title="كلمات تجاوزتها">⤼ ' + n.skip + ' تجاوز</span>' : '') +
      (n.wrong ? '<span class="hz-c hz-c-wrong" title="كلمات قيلت بغير لفظها">✗ ' + n.wrong + '</span>' : '') +
      (n.weak ? '<span class="hz-c hz-c-weak" title="كلمات غير واضحة">≈ ' + n.weak + '</span>' : '') +
      (n.hint ? '<span class="hz-c hz-c-hint" title="كلمات كشفتها تلميحًا">💡 ' + n.hint + '</span>' : '') +
      '<span class="hz-sp"></span>' +
      (reciting() ? '' : '<button class="hz-b hz-b-gold" data-hz="mic">🎙️ ابدأ التسميع</button>') +
      '<button class="hz-b" data-hz="hint" title="اكشف الكلمة التالية (أو انقر أي كلمة مخفية)">💡 تلميح</button>' +
      '<button class="hz-b" data-hz="peek" title="اضغط مطوّلًا لرؤية الصفحة كاملة">👁 اضغط لترى</button>' +
      '<button class="hz-b" data-hz="mode" title="طريقة الإخفاء">' + (prefs.mode === 'blur' ? '🌫️ ضبابي' : '⬜ مخفي') + '</button>' +
      '<button class="hz-b" data-hz="finish">🏁 النتيجة</button>' +
      '<button class="hz-b hz-x" data-hz="exit" title="إنهاء الاختبار">✕</button>';
    var peek = bar.querySelector('[data-hz=peek]');
    var on = function (e) { e.preventDefault(); document.body.classList.add('hz-peek'); if (st) st.peeks++; };
    var off = function () { document.body.classList.remove('hz-peek'); };
    peek.addEventListener('pointerdown', on); peek.addEventListener('pointerup', off); peek.addEventListener('pointerleave', off); peek.addEventListener('pointercancel', off);
  }
  function applyMode() { document.body.classList.toggle('hz-hide', prefs.mode === 'hide'); }

  /* ----------------------------- results ------------------------------ */
  var modal = null;
  function closeResults() { if (modal) { modal.remove(); modal = null; } }
  function finalizeAll() {
    if (!st) return;
    clearTimeout(st.timer); st.timer = 0;
    st.segs.forEach(function (seg) { alignSeg(seg, true); });
    paintAll();
  }
  function mistakeAyahs() {
    var by = {}, order = [];
    Object.keys(st.mark).forEach(function (p) {
      p = +p; var mk = st.mark[p]; if (mk === 'ok') return;
      var w = where(p), k = w.s + ':' + w.a;
      if (!by[k]) { by[k] = { s: w.s, a: w.a, ai: w.ai, page: w.page, name: w.name, marks: {} }; order.push(k); }
      by[k].marks[w.w] = mk;
    });
    return order.map(function (k) { return by[k]; }).sort(function (x, y) { return x.ai - y.ai; });
  }
  function results() {
    if (!st) return;
    finalizeAll();
    var n = counts(), sc = score(n), mist = mistakeAyahs();
    var range = rangeText();
    var dur = Math.round((Date.now() - st.t0) / 1000);
    var hist = readJSON(HIST_KEY, []);
    if (n.total && !st.saved) {
      st.saved = true;
      var r0 = rangeRef();
      hist.unshift({ t: Date.now(), dur: dur, from: r0.from, to: r0.to, total: n.total, ok: n.ok, weak: n.weak, wrong: n.wrong, skip: n.skip, hint: n.hint, score: sc });
      writeJSON(HIST_KEY, hist.slice(0, 60));
      var words = readJSON(WORDS_KEY, {});
      Object.keys(st.mark).forEach(function (p) {
        var mk = st.mark[p]; if (mk === 'ok' || mk === 'weak') return;
        var w = where(+p), k = w.s + ':' + w.a + ':' + w.w;
        words[k] = { n: ((words[k] && words[k].n) || 0) + 1, t: Date.now() };
      });
      writeJSON(WORDS_KEY, words);
    }
    closeResults();
    modal = document.createElement('div');
    modal.className = 'hz-modal'; modal.setAttribute('dir', 'rtl');
    var ring = sc >= 90 ? 'hz-great' : sc >= 70 ? 'hz-good' : 'hz-low';
    modal.innerHTML =
      '<div class="hz-card" role="dialog" aria-label="نتيجة اختبار الحفظ">' +
      '<header class="hz-head"><b>🏁 نتيجة اختبار الحفظ</b><button class="hz-b hz-x" data-r="close" title="إغلاق">✕</button></header>' +
      '<div class="hz-body">' +
      (n.total ? (
        '<div class="hz-score"><div class="hz-ring ' + ring + '" style="--p:' + sc + '"><span>' + sc + '%</span></div>' +
        '<div class="hz-sum"><div class="hz-range">' + esc(range) + '</div>' +
        '<div class="hz-meta">' + n.total + ' كلمة • ' + fmtDur(dur) + (st.peeks ? ' • نظرتَ إلى الصفحة ' + st.peeks + ' مرة' : '') + '</div>' +
        '<div class="hz-chips"><span class="hz-c hz-c-ok">✓ ' + n.ok + ' صحيحة</span>' +
        (n.skip ? '<span class="hz-c hz-c-skip">⤼ ' + n.skip + ' تجاوز</span>' : '') +
        (n.wrong ? '<span class="hz-c hz-c-wrong">✗ ' + n.wrong + ' خطأ</span>' : '') +
        (n.weak ? '<span class="hz-c hz-c-weak">≈ ' + n.weak + ' غير واضحة</span>' : '') +
        (n.hint ? '<span class="hz-c hz-c-hint">💡 ' + n.hint + ' تلميح</span>' : '') + '</div></div></div>' +
        (mist.length ? '<h4>مواضع الأخطاء (' + mist.length + ' آية)</h4><div class="hz-mist">' + mist.slice(0, 40).map(ayahHtml).join('') + '</div>'
          : '<p class="hz-perfect">ما شاء الله! لا أخطاء في هذا المقطع.</p>')
      ) : '<p class="hz-empty">لم تُتلَ كلمات بعد. ابدأ التسميع 🎙️ وستظهر كل كلمة حين تتلوها.</p>') +
      historyHtml() +
      '</div>' +
      '<footer class="hz-foot">' +
      (mist.length && window.AyahLists && window.AyahLists.addMistakes ? '<button class="hz-b hz-b-gold" data-r="list">🎙️ أضف ' + mist.length + ' آية إلى «أخطاء التسميع»</button>' : '') +
      (n.total ? '<button class="hz-b" data-r="again">🔁 أعد الاختبار</button>' : '') +
      '<button class="hz-b" data-r="close">متابعة الاختبار</button>' +
      '<button class="hz-b" data-r="end">إنهاء الاختبار</button>' +
      '</footer></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) return closeResults();
      var go = e.target.closest('[data-go]');
      if (go) { var v = go.getAttribute('data-go').split(':').map(Number); closeResults(); call('goToPage', v[2]); setTimeout(function () { call('highlightSearchedAyah', v[0], v[1]); }, 60); return; }
      var b = e.target.closest('[data-r]'); if (!b) return;
      var a = b.getAttribute('data-r');
      if (a === 'close') closeResults();
      if (a === 'end') { closeResults(); stop(); }
      if (a === 'again') { var p0 = rangeRef(); closeResults(); var keep = prefs; st = fresh(); prefs = keep; buildLayers(); updateBar(); if (p0.page) call('goToPage', p0.page); toast('🔁 من جديد: ابدأ التلاوة'); }
      if (a === 'list') {
        var added = window.AyahLists.addMistakes(mist.map(function (x) { return { s: x.s, a: x.a }; }));
        toast(added ? '✅ أُضيفت ' + added + ' آية إلى «أخطاء التسميع» للمراجعة' : 'الآيات موجودة في القائمة، وأُعيدت إلى أول المراجعة');
        b.disabled = true;
      }
    });
  }
  function ayahHtml(x) {
    var getBoxes = g('getAyahWordBoxes'), boxes = (typeof getBoxes === 'function' && getBoxes(x.s, x.a)) || [];
    var words = boxes.length ? boxes.map(function (b) { return b.rawWord; }) : C().ayahs[x.ai].words;
    return '<div class="hz-ay"><button class="hz-ref" data-go="' + x.s + ':' + x.a + ':' + x.page + '" title="اذهب إلى الآية">' + esc(x.name) + ' ' + x.a + '</button>' +
      '<span class="hz-txt">' + words.map(function (w, i) {
        var mk = x.marks[i];
        return mk ? '<span class="hz-m hz-m-' + mk + '" title="' + LABEL[mk] + '">' + esc(w) + '</span>' : esc(w);
      }).join(' ') + '</span></div>';
  }
  var LABEL = { skip: 'تجاوزتها', wrong: 'قيلت بغير لفظها', weak: 'غير واضحة', hint: 'كشفتها تلميحًا' };
  function historyHtml() {
    var hist = readJSON(HIST_KEY, []), words = readJSON(WORDS_KEY, {});
    if (!hist.length) return '';
    var c = C();
    var top = Object.keys(words).map(function (k) { return [k, words[k].n]; }).filter(function (x) { return x[1] >= 2; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
    var getBoxes = g('getAyahWordBoxes');
    return '<h4>📈 سجلّك</h4><div class="hz-hist">' + hist.slice(0, 8).map(function (h) {
      return '<div class="hz-h"><span>' + new Date(h.t).toLocaleDateString('ar', { day: 'numeric', month: 'short' }) + '</span><span>' +
        esc(refName(h.from)) + ' ← ' + esc(refName(h.to)) + '</span><b class="' + (h.score >= 90 ? 'hz-great' : h.score >= 70 ? 'hz-good' : 'hz-low') + '">' + h.score + '%</b></div>';
    }).join('') + '</div>' +
    (top.length ? '<h4>كلمات تتكرر أخطاؤك فيها</h4><div class="hz-top">' + top.map(function (x) {
      var v = x[0].split(':').map(Number), raw = '';
      try { var bx = getBoxes(v[0], v[1]); raw = bx && bx[v[2]] ? bx[v[2]].rawWord : ''; } catch (e) {}
      var ai = g('ayaIndexMap') && g('ayaIndexMap').get(v[0] + '_' + v[1]), page = ai != null && c ? c.ayahs[ai].page : 0;
      return '<button class="hz-tw" data-go="' + v[0] + ':' + v[1] + ':' + page + '">' + esc(raw) + ' <small>' + esc(refName([v[0], v[1]])) + ' • ×' + x[1] + '</small></button>';
    }).join('') + '</div>' : '');
  }
  function refName(r) {
    if (!r) return '';
    var S = (window.QURAN_DATA && window.QURAN_DATA.surahs) || [];
    return ((S[r[0] - 1] && S[r[0] - 1].name) || ('سورة ' + r[0])) + ' ' + r[1];
  }
  function rangeRef() {
    var lo = Infinity, hi = -1;
    st.segs.forEach(function (s) { lo = Math.min(lo, s.from); hi = Math.max(hi, s.to); });
    if (hi < 0) return { from: null, to: null, page: 0 };
    var a = where(lo), b = where(hi);
    return { from: [a.s, a.a], to: [b.s, b.a], page: a.page };
  }
  function rangeText() {
    var r = rangeRef(); if (!r.from) return '';
    return 'من ' + refName(r.from) + ' إلى ' + refName(r.to);
  }
  function fmtDur(s) { var m = Math.floor(s / 60); return m ? m + ' د ' + (s % 60) + ' ث' : s + ' ث'; }

  /* ---------------------------- on / off ------------------------------ */
  function start() {
    if (st) return;
    if (!C()) { try { call('buildVoiceRecitationIndex'); } catch (e) {} }
    if (!C()) { toast('بيانات التسميع لم تُحمَّل بعد'); return; }
    st = fresh();
    document.body.classList.add('hz-on'); applyMode();
    buildLayers(); updateBar(); syncButtons();
    toast(reciting() ? '🙈 اختبار الحفظ: تابع التلاوة وستظهر كل كلمة حين تتلوها' : '🙈 اختبار الحفظ: اضغط «ابدأ التسميع» ثم اتلُ من حفظك');
  }
  function stop() {
    if (!st) return;
    clearTimeout(st.timer);
    st = null;
    document.body.classList.remove('hz-on', 'hz-hide', 'hz-peek');
    document.querySelectorAll('.hz-layer').forEach(function (el) { el.remove(); });
    var bar = document.getElementById('hifzBar'); if (bar) bar.remove();
    closeResults(); syncButtons();
  }
  function toggle() { if (st) { if (counts().total) results(); else stop(); } else start(); }
  function syncButtons() {
    var b = document.getElementById('dockHifzBtn'); if (b) b.classList.toggle('on', !!st);
  }
  function addDockButton() {
    if (document.getElementById('dockHifzBtn')) return;
    var ref = document.getElementById('dockSaveAyahBtn'); if (!ref) return;
    var b = document.createElement('button');
    b.id = 'dockHifzBtn'; b.className = 'dock-icon-btn hz-dock-btn';
    b.title = 'اختبار الحفظ: تُخفى كلمات الصفحة وتظهر كل كلمة حين تتلوها';
    b.innerHTML = '🙈<span>اختبار الحفظ</span>';
    ref.parentNode.insertBefore(b, ref);
    b.addEventListener('click', toggle);
  }
  // the reciting state changes outside this module: keep the bar's mic button honest
  setInterval(function () { if (st) { var has = !!document.querySelector('#hifzBar [data-hz=mic]'); if (has === reciting()) updateBar(); } }, 1000);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal) closeResults(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addDockButton); else addDockButton();

  API.start = start; API.stop = stop; API.toggle = toggle; API.results = results;
  API.onWord = onWord; API.onHeard = onHeard; API.onPage = onPage;
  API.isOn = function () { return !!st; };
  API._state = function () { return st; }; API._counts = counts;
})(typeof window !== 'undefined' ? window : globalThis);
