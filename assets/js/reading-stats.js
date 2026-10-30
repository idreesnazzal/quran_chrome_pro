/* Reading stats, daily streak and khatma planner (إحصاءاتي وخطة الختمة).
 *
 * A page counts as READ after it has been on screen for a while (20 s, or
 * 30 s for a two-page spread) while the reader is active: the tab is visible
 * and there was input in the last 5 minutes, or audio / the mic is running.
 * Flipping through pages or jumping from search counts nothing.
 *
 * Storage: localStorage 'mushaf_stats.v1'
 *   { v, days: {"YYYY-MM-DD": {p: [pages], s: seconds}}, goal,
 *     khatma: {start, from, days, end, covered: [pages], log: {date: new pages}} | null,
 *     done: [{start, end, days}] }
 * Entry points: the pill in the reader strip (reader-plus.js) and ⚙️ الإعدادات.
 */
(function () {
  'use strict';
  var KEY = 'mushaf_stats.v1';
  var DWELL_1 = 20, DWELL_2 = 30, TICK = 5, IDLE = 5 * 60 * 1000, KEEP_DAYS = 400, TOTAL = 604;
  var st = load();
  var view = { key: '', dwell: 0, marked: false }, lastAct = Date.now(), dirty = 0, modal = null;

  /* ------------------------------ helpers ------------------------------ */
  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  function call(name) { var f = g(name); if (typeof f === 'function') return f.apply(null, [].slice.call(arguments, 1)); }
  function toast(m) { call('showToast', m); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dk(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(k) { var a = k.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
  function addDays(k, n) { var d = parse(k); d.setDate(d.getDate() + n); return dk(d); }
  function diffDays(a, b) { return Math.round((Date.UTC.apply(null, ymd(b)) - Date.UTC.apply(null, ymd(a))) / 864e5); }   // b - a
  function ymd(k) { var a = k.split('-').map(Number); return [a[0], a[1] - 1, a[2]]; }
  function fmtDate(k, o) { return parse(k).toLocaleDateString('ar', o || { day: 'numeric', month: 'long' }); }
  function mins(s) { var m = Math.round(s / 60); return m < 60 ? m + ' د' : Math.floor(m / 60) + ' س ' + (m % 60) + ' د'; }
  // Arabic number agreement: صفحة واحدة / صفحتان / 3-10 صفحات / 11+ صفحة
  function count(n, one, two, few, many) { return n === 1 ? one : n === 2 ? two : (n >= 3 && n <= 10 ? n + ' ' + few : n + ' ' + many); }
  function pagesTxt(n) { return count(n, 'صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة'); }
  function daysTxt(n) { return count(n, 'يوم واحد', 'يومان', 'أيام', 'يومًا'); }
  function juzTxt(x) { return x < 0.75 ? 'أقل من جزء' : x < 1.5 ? 'نحو جزء' : 'نحو ' + count(Math.round(x), 'جزء', 'جزأين', 'أجزاء', 'جزءًا'); }
  function surahOfPage(p) {
    var S = (window.QURAN_DATA && window.QURAN_DATA.surahs) || [], name = '';
    for (var i = 0; i < S.length; i++) { if (S[i].page_start <= p) name = S[i].name; else break; }
    return name;
  }

  function load() {
    var s = null; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    // anything stored may be damaged: keep only what has the right shape
    if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
    var days = {};
    if (s.days && typeof s.days === 'object') Object.keys(s.days).forEach(function (k) {
      var d = s.days[k];
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && d && typeof d === 'object')
        days[k] = { p: Array.isArray(d.p) ? d.p.filter(validPage) : [], s: +d.s > 0 ? +d.s : 0 };
    });
    var k = s.khatma, khatma = null;
    if (k && typeof k === 'object' && validPage(k.from) && +k.days >= 1 && typeof k.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k.end))
      khatma = { start: +k.start || Date.now(), from: +k.from, days: +k.days, end: k.end,
        covered: Array.isArray(k.covered) ? k.covered.filter(validPage) : [], log: k.log && typeof k.log === 'object' ? k.log : {} };
    return { v: 1, days: days, goal: [0, 1, 2, 4, 5, 10, 20].indexOf(+s.goal) >= 0 ? +s.goal : 5, khatma: khatma,
      done: Array.isArray(s.done) ? s.done.filter(function (x) { return x && +x.days > 0; }) : [] };
  }
  function validPage(p) { return typeof p === 'number' && p >= 1 && p <= TOTAL && p === Math.floor(p);
  }
  function save() {
    var keys = Object.keys(st.days).sort();
    if (keys.length > KEEP_DAYS) keys.slice(0, keys.length - KEEP_DAYS).forEach(function (k) { delete st.days[k]; });
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {}
    dirty = 0;
  }
  function today() { var k = dk(); return st.days[k] || (st.days[k] = { p: [], s: 0 }); }

  /* ------------------------------ tracking ----------------------------- */
  function visible() {
    return g('isDoublePageMode') ? [g('currentRightPage'), g('currentLeftPage')].filter(Boolean) : [g('currentPage')].filter(Boolean);
  }
  function reciting() { var S = window.ReciteByMic && window.ReciteByMic._session; return !!(S && S.active); }
  function active() { return Date.now() - lastAct < IDLE || !!g('isAudioPlaying') || reciting(); }
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastAct = Date.now(); }, { passive: true, capture: true });
  });
  function tick() {
    if (document.hidden) return;
    var pages = visible(), key = pages.join('|');
    if (!key) return;
    if (key !== view.key) view = { key: key, dwell: 0, marked: false };
    if (!active()) return;
    view.dwell += TICK;
    today().s += TICK; dirty += TICK;
    if (!view.marked && view.dwell >= (pages.length > 1 ? DWELL_2 : DWELL_1)) { view.marked = true; markRead(pages); }
    if (dirty >= 30) save();
  }
  function markRead(pages) {
    var t = today(), before = goalState().done;
    pages.forEach(function (p) { if (t.p.indexOf(p) < 0) t.p.push(p); });
    var k = st.khatma;
    if (k) {
      pages.forEach(function (p) {
        if (p >= k.from && k.covered.indexOf(p) < 0) { k.covered.push(p); k.log[dk()] = (k.log[dk()] || 0) + 1; }
      });
      if (k.covered.length >= TOTAL - k.from + 1) return finishKhatma();
    }
    save();
    var gs = goalState();
    if (!before && gs.done && gs.target) toast(st.khatma ? '🎉 أتممت ورد اليوم من الختمة — بارك الله فيك' : '🎉 أتممت هدف اليوم: ' + pagesTxt(gs.target));
    refresh();
  }
  function refresh() {
    if (window.ReaderPlus && window.ReaderPlus.refresh) window.ReaderPlus.refresh();
    if (modal) render();
  }

  /* ------------------------------ numbers ------------------------------ */
  function streak() {
    var k = dk(), cur = 0, readToday = !!(st.days[k] && st.days[k].p.length);
    var d = readToday ? k : addDays(k, -1);
    while (st.days[d] && st.days[d].p.length) { cur++; d = addDays(d, -1); }
    var keys = Object.keys(st.days).filter(function (x) { return st.days[x].p.length; }).sort(), best = 0, run = 0, prev = null;
    keys.forEach(function (x) { run = (prev && diffDays(prev, x) === 1) ? run + 1 : 1; best = Math.max(best, run); prev = x; });
    return { cur: cur, best: best, readToday: readToday };
  }
  function khatmaPlan() {
    var k = st.khatma; if (!k) return null;
    var total = TOTAL - k.from + 1, covered = k.covered.length, tk = dk();
    var todayNew = k.log[tk] || 0;
    var dayNo = diffDays(dk(new Date(k.start)), tk) + 1;
    var daysLeft = Math.max(1, diffDays(tk, k.end) + 1);
    var overdue = diffDays(tk, k.end) < 0;
    var remainingAtDawn = total - covered + todayNew;
    var target = Math.max(1, Math.ceil(remainingAtDawn / daysLeft));
    var planned = Math.min(total, Math.ceil(total * Math.min(dayNo - 1, k.days) / k.days));   // by the end of yesterday
    var next = [];
    for (var p = k.from; p <= TOTAL && next.length < Math.max(0, target - todayNew); p++) if (k.covered.indexOf(p) < 0) next.push(p);
    var first = -1; for (p = k.from; p <= TOTAL; p++) if (k.covered.indexOf(p) < 0) { first = p; break; }
    return { total: total, covered: covered, todayNew: todayNew, dayNo: dayNo, daysLeft: daysLeft, overdue: overdue,
      target: target, planned: planned, diff: covered - todayNew - planned, next: next, first: first, pct: Math.floor(100 * covered / total) };
  }
  function goalState() {
    var t = st.days[dk()], read = t ? t.p.length : 0, kp = khatmaPlan();
    if (kp) return { target: kp.target, read: kp.todayNew, done: kp.todayNew >= kp.target, khatma: true };
    return { target: st.goal, read: read, done: st.goal > 0 && read >= st.goal, khatma: false };
  }

  /* ------------------------------ khatma ------------------------------- */
  function startKhatma(from, days) {
    var total = TOTAL - from + 1;
    days = Math.max(1, Math.min(total, Math.round(days)));
    st.khatma = { start: Date.now(), from: from, days: days, end: addDays(dk(), days - 1), covered: [], log: {} };
    save(); refresh();
    toast('📖 بدأت ختمة جديدة: ' + pagesTxt(Math.ceil(total / days)) + ' يوميًا حتى ' + fmtDate(st.khatma.end));
  }
  function finishKhatma() {
    var k = st.khatma;
    st.done.unshift({ start: k.start, end: Date.now(), days: diffDays(dk(new Date(k.start)), dk()) + 1, from: k.from });
    st.khatma = null; save(); refresh();
    open('done');
  }

  /* ------------------------------- pill -------------------------------- */
  function pill() {
    var s = streak(), gs = goalState();
    var lead = s.cur ? '🔥 ' + (s.cur <= 2 ? s.cur + ' ' + (s.cur === 1 ? 'يوم' : 'يومان') : daysTxt(s.cur)) : '📊';
    var tail = gs.target ? (gs.khatma ? 'الورد ' : 'اليوم ') + Math.min(gs.read, gs.target) + '/' + gs.target + (gs.done ? ' ✓' : '') : 'إحصاءاتي';
    return '<button class="rp-pill rs-pill' + (gs.done ? ' rs-done' : '') + '" data-stats title="إحصاءات القراءة وخطة الختمة">' + lead + ' • ' + tail + '</button>';
  }

  /* ------------------------------- modal ------------------------------- */
  function open(view) {
    if (!modal) {
      form = { days: 30, from: 1 };
      modal = document.createElement('div');
      modal.className = 'rs-modal'; modal.setAttribute('dir', 'rtl');
      document.body.appendChild(modal);
      modal.addEventListener('click', onClick);
      modal.addEventListener('input', onInput);
      modal.addEventListener('mouseover', onHover);
      modal.addEventListener('mouseout', function (e) { if (e.target.closest('[data-tip]')) hideTip(); });
      modal.addEventListener('focusin', onHover);
    }
    modal.dataset.view = view || '';
    render();
  }
  function close() { if (modal) { modal.remove(); modal = null; } }
  // capture + stop: one Escape closes this panel only, not the window under it
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal) { close(); e.stopPropagation(); } }, true);

  function render() {
    var s = streak(), t = st.days[dk()] || { p: [], s: 0 }, gs = goalState(), kp = khatmaPlan();
    var week = 0, weekS = 0, total = 0, totalS = 0;
    for (var i = 0; i < 7; i++) { var d = st.days[addDays(dk(), -i)]; if (d) { week += d.p.length; weekS += d.s; } }
    Object.keys(st.days).forEach(function (k) { total += st.days[k].p.length; totalS += st.days[k].s; });
    var justDone = modal.dataset.view === 'done';
    modal.innerHTML =
      '<div class="rs-card" role="dialog" aria-label="إحصاءاتي وخطة الختمة">' +
      '<header class="rs-head"><b>📊 إحصاءاتي وخطة الختمة</b><button class="rs-x" data-a="close" title="إغلاق (Esc)">✕</button></header>' +
      '<div class="rs-body">' +
      (justDone ? '<div class="rs-celebrate">🎉 <b>ختمتَ القرآن الكريم!</b><span>تقبّل الله منك. سُجّلت الختمة في «ختماتي» أدناه.</span></div>' : '') +
      '<div class="rs-tiles">' +
        tile('🔥', s.cur, s.cur === 1 ? 'يوم متتالٍ' : 'أيام متتالية', s.readToday || !s.cur ? 'أطول سلسلة: ' + s.best : 'اقرأ اليوم لتحافظ عليها') +
        tile('📖', t.p.length, 'صفحة اليوم', gs.target ? (gs.done ? '✓ تمّ ' + (gs.khatma ? 'الورد' : 'الهدف') : 'الهدف ' + gs.target + (gs.khatma ? ' (الورد)' : '')) : mins(t.s)) +
        tile('🗓️', week, 'صفحة في 7 أيام', mins(weekS)) +
        tile('∑', total, 'صفحة منذ البدء', mins(totalS)) +
      '</div>' +
      '<section class="rs-sec"><h4>آخر 14 يومًا</h4>' + bars() + '</section>' +
      '<section class="rs-sec"><h4>المداومة — آخر 18 أسبوعًا</h4>' + heatmap() + '</section>' +
      '<section class="rs-sec"><h4>📖 خطة الختمة</h4>' + (kp ? khatmaHtml(kp) : khatmaForm()) + '</section>' +
      (st.done.length ? '<section class="rs-sec"><h4>🏆 ختماتي (' + st.done.length + ')</h4><div class="rs-done-list">' + st.done.slice(0, 12).map(function (x) {
        return '<div><span>' + fmtDate(dk(new Date(x.end)), { day: 'numeric', month: 'long', year: 'numeric' }) + '</span><b>في ' + daysTxt(x.days) + '</b></div>';
      }).join('') + '</div></section>' : '') +
      (!kp ? '<section class="rs-sec"><h4>🎯 هدف القراءة اليومي</h4><div class="rs-chips">' + [0, 1, 2, 4, 5, 10, 20].map(function (n) {
        return '<button class="rs-chip' + (st.goal === n ? ' on' : '') + '" data-goal="' + n + '">' + (n ? n + ' ص' : 'بلا هدف') + '</button>';
      }).join('') + '</div></section>' : '') +
      '<p class="rs-note">تُحسب الصفحة مقروءة بعد بقائها على الشاشة ' + DWELL_1 + ' ثانية وأنت نشط (أو ' + DWELL_2 + ' ثانية للصفحتين). كل البيانات محفوظة في هذا المتصفح فقط.' +
        ' <button class="rs-link" data-a="reset">مسح الإحصاءات</button></p>' +
      '</div></div><div class="rs-tip" hidden></div>';
    preview();
  }
  function tile(icon, num, label, sub) {
    return '<div class="rs-tile"><span class="rs-ic">' + icon + '</span><b class="rs-num">' + num + '</b><span class="rs-lbl">' + label + '</span><small>' + esc(sub) + '</small></div>';
  }

  // 14 bars, one series (one hue): today labelled, the goal as a dashed reference line
  function bars() {
    var data = [], max = 1, goal = goalState().target;
    for (var i = 13; i >= 0; i--) { var k = addDays(dk(), -i), d = st.days[k]; data.push({ k: k, n: d ? d.p.length : 0, s: d ? d.s : 0 }); }
    data.forEach(function (x) { max = Math.max(max, x.n); });
    var top = Math.max(max, goal || 0, 4) * 1.15;   // headroom: the goal line and the top label stay inside the plot
    return '<div class="rs-bars" role="img" aria-label="الصفحات المقروءة في آخر 14 يومًا">' +
      (goal ? '<div class="rs-goal" style="bottom:calc(var(--plot) * ' + (goal / top).toFixed(4) + ')"><span>الهدف ' + goal + '</span></div>' : '') +
      data.map(function (x, i) {
        var last = i === data.length - 1;
        return '<div class="rs-bar-col' + (last ? ' rs-today' : '') + '" tabindex="0" data-tip="' + esc(fmtDate(x.k, { weekday: 'long', day: 'numeric', month: 'long' }) + ' — ' + x.n + ' صفحة' + (x.s ? ' • ' + mins(x.s) : '')) + '">' +
          (last && x.n ? '<em>' + x.n + '</em>' : '') +
          '<i style="height:' + (x.n ? Math.max(3, x.n / top * 100) : 0) + '%"></i>' +
          '<span>' + (last ? 'اليوم' : parse(x.k).getDate()) + '</span></div>';
      }).join('') + '</div>';
  }

  // weeks as columns (newest on the left: RTL), Saturday on top; one hue, 5 steps
  function heatmap() {
    var tk = dk(), dow = (parse(tk).getDay() + 1) % 7;   // 0 = Saturday
    var start = addDays(tk, -(17 * 7 + dow)), cells = '', months = '', lastMonth = -1;
    for (var w = 0; w < 18; w++) {
      var col = '';
      for (var r = 0; r < 7; r++) {
        var k = addDays(start, w * 7 + r);
        if (diffDays(k, tk) < 0) { col += '<i class="rs-c rs-future"></i>'; continue; }
        var n = st.days[k] ? st.days[k].p.length : 0;
        var lv = n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 10 ? 3 : n <= 19 ? 4 : 5;
        col += '<i class="rs-c rs-l' + lv + (k === tk ? ' rs-now' : '') + '" tabindex="0" data-tip="' + esc(fmtDate(k, { weekday: 'long', day: 'numeric', month: 'long' }) + ' — ' + (n ? n + ' صفحة' : 'لا قراءة')) + '"></i>';
      }
      var m = parse(addDays(start, w * 7)).getMonth();
      // a month is named on its first full week (never on column 0: the next month would collide with it)
      months += '<span>' + (w > 0 && m !== lastMonth ? parse(addDays(start, w * 7)).toLocaleDateString('ar', { month: 'short' }) : '') + '</span>';
      lastMonth = m;
      cells += '<div class="rs-wk">' + col + '</div>';
    }
    return '<div class="rs-heat"><div class="rs-days"><span>سبت</span><span></span><span>اثنين</span><span></span><span>أربعاء</span><span></span><span>جمعة</span></div>' +
      '<div class="rs-grid-wrap"><div class="rs-months">' + months + '</div><div class="rs-grid">' + cells + '</div></div></div>' +
      '<div class="rs-legend"><span>أقل</span>' + [0, 1, 2, 3, 4, 5].map(function (l) { return '<i class="rs-c rs-l' + l + '"></i>'; }).join('') + '<span>أكثر</span></div>';
  }

  function khatmaHtml(kp) {
    var k = st.khatma;
    var status = kp.overdue ? '<span class="rs-tag rs-behind">انتهت المدة — بقي ' + pagesTxt(kp.total - kp.covered) + '</span>'
      : kp.diff >= 0 ? '<span class="rs-tag rs-ahead">' + (kp.diff > 0 ? 'متقدّم بـ' + pagesTxt(kp.diff) : 'على الخطة ✓') + '</span>'
      : '<span class="rs-tag rs-behind">متأخر بـ' + pagesTxt(-kp.diff) + ' عن الخطة</span>';
    var wird = kp.todayNew >= kp.target ? '<b>✓ أتممت ورد اليوم (' + pagesTxt(kp.todayNew) + ')</b>'
      : '<b>ورد اليوم: ' + pagesTxt(kp.target) + '</b> — بقي ' + pagesTxt(kp.target - kp.todayNew) +
        (kp.next.length ? ' <span class="rs-range">(من ص ' + kp.next[0] + (kp.next.length > 1 ? ' إلى ص ' + kp.next[kp.next.length - 1] : '') + ' • ' + esc(surahOfPage(kp.next[0])) + ')</span>' : '');
    return '<div class="rs-k">' +
      '<div class="rs-k-top"><div class="rs-k-pct"><b>' + kp.pct + '%</b><span>' + kp.covered + ' / ' + kp.total + ' صفحة</span></div>' +
        '<div class="rs-k-meta">اليوم ' + Math.min(kp.dayNo, k.days) + ' من ' + k.days + ' • تنتهي ' + fmtDate(k.end) + (k.from > 1 ? ' • من ص ' + k.from : '') + '<br>' + status + '</div></div>' +
      juzBar(k) +
      '<div class="rs-wird">' + wird + '</div>' +
      '<div class="rs-btns">' + (kp.first > 0 ? '<button class="rs-btn rs-gold" data-a="go" data-p="' + kp.first + '">📖 تابع وردك (ص ' + kp.first + ')</button>' : '') +
      '<button class="rs-btn" data-a="cancel">إلغاء الختمة</button></div></div>';
  }
  // the 30 juz', each filled by the share of its pages read in this khatma
  function juzBar(k) {
    var J = (window.QURAN_DATA && window.QURAN_DATA.juz) || [];
    if (J.length < 30) return '';
    return '<div class="rs-juz" role="img" aria-label="التقدّم في الأجزاء">' + J.map(function (j, i) {
      var a = Math.max(j.page, k.from), b = (i < 29 ? J[i + 1].page - 1 : TOTAL), n = 0, tot = Math.max(0, b - a + 1);
      for (var p = a; p <= b; p++) if (k.covered.indexOf(p) >= 0) n++;
      var f = tot ? n / tot : 0;
      return '<span class="rs-j' + (tot ? '' : ' rs-j-off') + '" tabindex="0" data-tip="الجزء ' + (i + 1) + ': ' + (tot ? n + ' / ' + tot + ' صفحة' : 'قبل بداية الختمة') + '"><i style="height:' + (f * 100) + '%"></i><em>' + (i + 1) + '</em></span>';
    }).join('') + '</div>';
  }
  function khatmaForm() {
    var cur = visible()[0] || 1;
    return '<div class="rs-form">' +
      '<div class="rs-row"><span>المدة</span><div class="rs-chips">' + [7, 10, 15, 30, 60, 90, 180, 365].map(function (n) {
        return '<button class="rs-chip' + (n === 30 ? ' on' : '') + '" data-days="' + n + '">' + (n === 365 ? 'سنة' : daysTxt(n)) + '</button>';
      }).join('') + '<label class="rs-custom"><input type="number" min="1" max="604" value="30" id="rsDays"> يومًا</label></div></div>' +
      '<div class="rs-row"><span>أو</span><div class="rs-chips">' + [1, 2, 4, 5, 10, 20].map(function (n) {
        return '<button class="rs-chip" data-per="' + n + '">' + pagesTxt(n) + ' يوميًا</button>';
      }).join('') + '</div></div>' +
      '<div class="rs-row"><span>البداية</span><div class="rs-chips"><button class="rs-chip on" data-from="1">من الفاتحة</button>' +
        (cur > 1 ? '<button class="rs-chip" data-from="' + cur + '">من الصفحة الحالية (' + cur + ')</button>' : '') + '</div></div>' +
      '<div class="rs-preview" id="rsPreview"></div>' +
      '<div class="rs-btns"><button class="rs-btn rs-gold" data-a="start">ابدأ الختمة</button></div></div>';
  }
  var form = { days: 30, from: 1 };
  function preview() {
    var el = modal && modal.querySelector('#rsPreview'); if (!el) return;
    var total = TOTAL - form.from + 1, days = Math.max(1, Math.min(total, form.days | 0 || 1));
    var per = Math.ceil(total / days);
    el.innerHTML = '<b>' + pagesTxt(per) + ' يوميًا</b> (' + juzTxt(per / 20) + ' في اليوم) — تنتهي ' + fmtDate(addDays(dk(), days - 1), { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* ------------------------------ events ------------------------------- */
  function onClick(e) {
    if (e.target === modal) return close();
    var b = e.target.closest('button'); if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'close') return close();
    if (a === 'go') { close(); call('goToPage', +b.getAttribute('data-p')); return; }
    if (a === 'start') return startKhatma(form.from, form.days);
    if (a === 'cancel') { if (confirm('إلغاء الختمة الحالية؟ يبقى سجل القراءة كما هو.')) { st.khatma = null; save(); refresh(); } return; }
    if (a === 'reset') { if (confirm('مسح كل إحصاءات القراءة والسلسلة والختمات؟ لا يمكن التراجع.')) { st = { v: 1, days: {}, goal: 5, khatma: null, done: [] }; save(); refresh(); } return; }
    if (b.hasAttribute('data-goal')) { st.goal = +b.getAttribute('data-goal'); save(); refresh(); return; }
    if (b.hasAttribute('data-days') || b.hasAttribute('data-per') || b.hasAttribute('data-from')) {
      if (b.hasAttribute('data-from')) form.from = +b.getAttribute('data-from');
      if (b.hasAttribute('data-days')) form.days = +b.getAttribute('data-days');
      if (b.hasAttribute('data-per')) form.days = Math.ceil((TOTAL - form.from + 1) / +b.getAttribute('data-per'));
      var grp = b.parentNode; grp.querySelectorAll('.rs-chip').forEach(function (c) { c.classList.toggle('on', c === b); });
      if (!b.hasAttribute('data-from')) {   // a duration and a pace are one choice
        modal.querySelectorAll('[data-days],[data-per]').forEach(function (c) { c.classList.toggle('on', c === b); });
        var inp = modal.querySelector('#rsDays'); if (inp) inp.value = form.days;
      }
      preview();
    }
  }
  function onInput(e) {
    if (e.target.id === 'rsDays') {
      form.days = Math.max(1, Math.min(604, +e.target.value || 1));
      modal.querySelectorAll('[data-days],[data-per]').forEach(function (c) { c.classList.toggle('on', +c.getAttribute('data-days') === form.days); });
      preview();
    }
  }
  function onHover(e) {
    var el = e.target.closest && e.target.closest('[data-tip]'); if (!el || !modal) return;
    var tip = modal.querySelector('.rs-tip'); if (!tip) return;
    tip.textContent = el.getAttribute('data-tip'); tip.hidden = false;
    var r = el.getBoundingClientRect(), tw = tip.offsetWidth;
    tip.style.top = (r.top - tip.offsetHeight - 8) + 'px';
    tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2)) + 'px';
  }
  function hideTip() { var tip = modal && modal.querySelector('.rs-tip'); if (tip) tip.hidden = true; }

  /* ------------------------------ start -------------------------------- */
  setInterval(tick, TICK * 1000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && dirty) save(); });
  window.addEventListener('pagehide', function () { if (dirty) save(); });
  window.ReadingStats = {
    open: function () { open(); }, close: close, pill: pill,
    _state: function () { return st; }, _tick: tick, _plan: khatmaPlan, _goal: goalState, _streak: streak,
    _reload: function () { st = load(); refresh(); }
  };
})();
