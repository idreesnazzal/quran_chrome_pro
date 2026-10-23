/* Reader+: resume reading, deep links, hizb/rub' navigation, sajda marks,
 * lazy asbab al-nuzul, and the installable offline app (PWA).
 *
 * Hooks in index.html: goToPage() ends with ReaderPlus.onPage(); openAyahTafsir()
 * calls ReaderPlus.onAyah(sura, aya). Data: data/quran_meta.js (Tanzil, CC BY 3.0).
 * Storage: localStorage 'mushaf_last' {page, s, a, t}.
 */
(function () {
  'use strict';
  var LAST_KEY = 'mushaf_last';
  var QNAMES = ['', '¼', '½', '¾'];
  // read BEFORE the app starts: initApp opens page 1 and would overwrite it
  var saved = null; try { saved = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) {}
  var ready = false, deferredInstall = null;

  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  function call(name) { var f = g(name); if (typeof f === 'function') return f.apply(null, [].slice.call(arguments, 1)); }
  function toast(m) { call('showToast', m); }
  function meta() { return window.QURAN_META || { quarters: [], sajdas: [] }; }
  function surahName(s) { var S = (window.QURAN_DATA && window.QURAN_DATA.surahs) || []; return (S[s - 1] && S[s - 1].name) || ('سورة ' + s); }
  function visible() {
    var dbl = !!g('isDoublePageMode');
    return dbl ? [g('currentRightPage'), g('currentLeftPage')].filter(Boolean) : [g('currentPage')];
  }
  function quarterLabel(i) { var h = Math.floor(i / 4) + 1, q = i % 4; return 'الحزب ' + h + (q ? ' • ' + QNAMES[q] : ''); }
  function quarterAt(page) {   // the quarter the reader is in on this page
    var Q = meta().quarters, k = -1;
    for (var i = 0; i < Q.length; i++) { if (Q[i][2] <= page) k = i; else break; }
    return k;
  }
  function highlight(s, a, page) {
    call('goToPage', page);
    setTimeout(function () { call('highlightSearchedAyah', s, a, surahName(s)); }, 60);
  }

  /* ----------------------------- strip ------------------------------ */
  function ensureStrip() {
    var el = document.getElementById('readerStrip');
    if (el) return el;
    var bar = document.querySelector('.reader-controls-bar');
    if (!bar || !bar.parentNode) return null;
    el = document.createElement('div');
    el.id = 'readerStrip'; el.className = 'rp-strip'; el.setAttribute('dir', 'rtl');
    bar.parentNode.insertBefore(el, bar.nextSibling);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-go]'); if (!b) return;
      var v = b.getAttribute('data-go').split(':').map(Number);
      highlight(v[0], v[1], v[2]);
    });
    return el;
  }
  function renderStrip() {
    var el = ensureStrip(); if (!el) return;
    var pages = visible(), Q = meta().quarters, chips = [];
    var cur = quarterAt(pages[0] || 1);
    if (cur >= 0) chips.push('<span class="rp-pill rp-hizb" title="الحزب والربع الذي أنت فيه">۞ ' + quarterLabel(cur) + '</span>');
    Q.forEach(function (q, i) {
      if (pages.indexOf(q[2]) >= 0) chips.push('<button class="rp-pill rp-q" data-go="' + q[0] + ':' + q[1] + ':' + q[2] + '" title="بداية ' + quarterLabel(i) + ' — انقر للتظليل">' +
        (i % 4 ? 'بداية الربع ' + QNAMES[i % 4] : 'بداية الحزب ' + (Math.floor(i / 4) + 1)) + ': ' + surahName(q[0]) + ' ' + q[1] + '</button>');
    });
    meta().sajdas.forEach(function (sj) {
      if (pages.indexOf(sj[2]) >= 0) chips.push('<button class="rp-pill rp-sajda" data-go="' + sj[0] + ':' + sj[1] + ':' + sj[2] + '" title="آية سجدة تلاوة' +
        (sj[3] === 'obligatory' ? ' (من العزائم عند بعض الفقهاء)' : '') + ' — انقر للتظليل">۩ سجدة: ' + surahName(sj[0]) + ' ' + sj[1] + '</button>');
    });
    el.innerHTML = chips.join('');
    el.style.display = chips.length ? '' : 'none';
  }

  /* --------------------------- hizb select --------------------------- */
  function ensureHizbSelect() {
    var sel = document.getElementById('hizbSelect');
    if (sel) return sel;
    var juz = document.getElementById('juzSelect'); if (!juz) return null;
    sel = document.createElement('select');
    sel.id = 'hizbSelect'; sel.className = juz.className; sel.title = 'انتقل إلى حزب أو ربع';
    var html = '<option value="">انتقل للحزب...</option>';
    meta().quarters.forEach(function (q, i) {
      if (i % 4 === 0) html += (i ? '</optgroup>' : '') + '<optgroup label="الحزب ' + (i / 4 + 1) + '">';
      html += '<option value="' + i + '">' + (i % 4 ? 'ربع ' + QNAMES[i % 4] : 'الحزب ' + (i / 4 + 1)) + ' — ' + surahName(q[0]) + ' ' + q[1] + ' (ص ' + q[2] + ')</option>';
    });
    sel.innerHTML = html + '</optgroup>';
    juz.parentNode.insertBefore(sel, juz.nextSibling);
    sel.addEventListener('change', function () {
      if (sel.value === '') return;
      var q = meta().quarters[+sel.value]; if (q) highlight(q[0], q[1], q[2]);
    });
    return sel;
  }

  /* ------------------------------ hooks ------------------------------ */
  function onPage() {
    renderStrip();
    var sel = ensureHizbSelect(), pages = visible();
    if (sel) { var k = quarterAt(pages[0] || 1); if (k >= 0 && sel.value !== String(k)) sel.value = String(k); }
    if (!ready) return;   // the start-up page 1 must not overwrite the saved place
    var h = g('currentHighlightedAyah'), p = pages[0] || 1;
    if (h && pages.indexOf(pageOf(h.sura, h.aya)) < 0) h = null;   // a highlight left behind on another page is not the place
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ page: p, s: h ? h.sura : null, a: h ? h.aya : null, t: Date.now() })); } catch (e) {}
    try { history.replaceState(null, '', location.pathname + location.search + (h ? '#' + h.sura + ':' + h.aya : '#p=' + p)); } catch (e) {}
  }
  function onAyah(s, a) {
    var hdr = document.getElementById('tafsirPageBadge'); if (!hdr) return;
    var b = document.getElementById('tafsirSajdaBadge');
    var sj = meta().sajdas.filter(function (x) { return x[0] === +s && x[1] === +a; })[0];
    if (!sj) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.id = 'tafsirSajdaBadge'; b.className = 'tafsir-badge rp-sajda-badge'; hdr.parentNode.insertBefore(b, hdr.nextSibling); }
    b.textContent = '۩ آية سجدة';
  }

  /* --------------------------- start-up ------------------------------ */
  function parseHash() {
    var h = decodeURIComponent(location.hash || '').replace(/^#/, '');
    var m = h.match(/^(\d{1,3}):(\d{1,3})$/);
    if (m) return { s: +m[1], a: +m[2] };
    m = h.match(/^p=(\d{1,3})$/);
    if (m) return { page: Math.min(604, Math.max(1, +m[1])) };
    return null;
  }
  function pageOf(s, a) {
    var map = g('ayaIndexMap'), data = g('activeData'); if (!map || !data) return null;
    var i = map.get(s + '_' + a); return i === undefined ? null : data[i][2];
  }
  function go(target, from) {
    if (!target) return;
    if (target.s && target.a) {
      var p = pageOf(target.s, target.a);
      if (p) { highlight(target.s, target.a, p); if (from === 'saved') toast('📖 تابع من حيث توقفت: سورة ' + surahName(target.s) + ' (آية ' + target.a + ')'); }
      else if (from === 'link') toast('الرابط لا يدل على آية موجودة');
    } else if (target.page && target.page !== g('currentPage')) {
      call('goToPage', target.page);
      if (from === 'saved') toast('📖 تابع من حيث توقفت: صفحة ' + target.page);
    }
  }
  function resume() {
    var target = parseHash();
    if (target) go(target, 'link'); else if (saved && saved.page) go(saved, 'saved');
    setTimeout(function () { ready = true; onPage(); }, 150);
  }
  // a typed or clicked #2:255 in the open page (replaceState never fires this)
  window.addEventListener('hashchange', function () { go(parseHash(), 'link'); });

  /* asbab al-nuzul (2.3 MB): loaded after the page is up, not before it */
  function loadAsbab() {
    if (window.ASBAB_DATA || document.getElementById('asbabScript')) return;
    var s = document.createElement('script'); s.id = 'asbabScript'; s.src = 'data/asbab_data.js'; s.async = true;
    s.onload = function () {   // the tafsir modal may be open already: refresh its revelation tab
      var bd = document.getElementById('tafsirModalBackdrop'), i = g('currentTafsirIndex'), data = g('activeData');
      if (bd && bd.classList.contains('active') && data && i >= 0 && data[i]) call('renderAyahRevelationContext', data[i][0], data[i][1], data[i][3]);
    };
    document.body.appendChild(s);
  }

  /* ------------------------------ PWA -------------------------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  function downloadAllPages(onProgress) {
    return new Promise(function (resolve, reject) {
      if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return reject(new Error('no service worker'));   // file:// never gets one
      navigator.serviceWorker.ready.then(function (reg) {
        var ch = new MessageChannel();
        ch.port1.onmessage = function (e) { onProgress && onProgress(e.data); if (e.data.done >= e.data.total) resolve(e.data); };
        reg.active.postMessage({ type: 'cache-pages' }, [ch.port2]);
      }, reject);
    });
  }
  function cachedPages() {
    if (!window.caches) return Promise.resolve(0);
    return caches.open('mushaf-pages').then(function (c) { return c.keys(); }).then(function (k) { return k.length; }).catch(function () { return 0; });
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; });
  window.addEventListener('appinstalled', function () { deferredInstall = null; toast('✅ ثُبّت المصحف كتطبيق'); });
  window.addEventListener('offline', function () { toast('📴 لا يوجد اتصال — الصفحات المحفوظة والتسميع بالنموذج القرآني تعمل؛ تعرّف Chrome والتلاوة الصوتية يحتاجان الإنترنت'); });
  window.addEventListener('online', function () { toast('🌐 عاد الاتصال بالإنترنت'); });

  function init() {
    registerSW();
    resume();
    setTimeout(loadAsbab, 1200);
  }
  if (document.readyState === 'complete') setTimeout(init, 0); else window.addEventListener('load', init);

  window.ReaderPlus = {
    onPage: onPage, onAyah: onAyah, downloadAllPages: downloadAllPages, cachedPages: cachedPages,
    canInstall: function () { return !!deferredInstall; },
    install: function () { if (!deferredInstall) return Promise.resolve(false); var d = deferredInstall; deferredInstall = null; d.prompt(); return d.userChoice.then(function (c) { return c && c.outcome === 'accepted'; }); },
    quarterAt: quarterAt
  };
})();
