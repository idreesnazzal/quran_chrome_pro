/* ⚙️ الإعدادات — one drawer for every setting of the app.
 * Existing settings keep their own storage keys and are changed through the
 * app's own functions (setTheme, setBrightness, setEyeComfort, setViewMode,
 * setReciter, setAudioSpeed, setAudioRepeatTarget, the tafsir select, the
 * search match tags, the 🧠 ears button), so nothing gets out of sync.
 * New settings live in localStorage 'mushaf_ui' and act through body classes:
 *   fit       the whole page fits the window height (no scrolling inside a page)
 *   hint      the «انقر على أي آية…» tip
 *   floatNav  the floating «السابقة / التالية» buttons
 *   autoTurn  recitation turns pages by itself (read by index.html)
 *   karaoke   the recite dock's word ribbon
 *   heard     the recite dock's «ما التقطه المايك» row
 */
(function () {
  'use strict';
  var UI_KEY = 'mushaf_ui';
  var DEF = { fit: false, hint: true, floatNav: true, autoTurn: true, karaoke: true, heard: true };
  var THEMES = [['dark', '🌙', 'ليلي'], ['light', '☀️', 'نهاري'], ['sepia', '📜', 'ورقي دافئ'], ['oled', '🖤', 'داكن OLED']];

  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }
  function call(name) { var f = g(name); if (typeof f === 'function') return f.apply(null, [].slice.call(arguments, 1)); }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }

  function uiPrefs() {
    var p = {}; try { p = JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) {}
    return Object.assign({}, DEF, p);
  }
  function setUi(k, v) { var p = uiPrefs(); p[k] = v; try { localStorage.setItem(UI_KEY, JSON.stringify(p)); } catch (e) {} applyUi(); }
  function applyUi() {
    var p = uiPrefs(), b = document.body; if (!b) return;
    b.classList.toggle('ui-fit', !!p.fit);
    b.classList.toggle('ui-no-hint', !p.hint);
    b.classList.toggle('ui-no-floatnav', !p.floatNav);
    b.classList.toggle('ui-no-karaoke', !p.karaoke);
    b.classList.toggle('ui-no-heard', !p.heard);
    window.MUSHAF_UI = p;   // index.html reads autoTurn
  }
  // the recite dock sits under the pages: «fit» leaves room for it
  function watchDock() {
    var d = document.getElementById('voiceFloatingDock');
    if (!d || typeof ResizeObserver === 'undefined') return;
    new ResizeObserver(function () {
      var h = d.offsetParent ? d.getBoundingClientRect().height + 14 : 0;
      document.documentElement.style.setProperty('--dock-h', Math.round(h) + 'px');
    }).observe(d);
  }

  /* ------------------------------ drawer ------------------------------ */
  var dr = null;
  function open() {
    if (!dr) {
      dr = document.createElement('div');
      dr.className = 'st-backdrop';
      dr.setAttribute('dir', 'rtl');
      dr.innerHTML = '<aside class="st-drawer" role="dialog" aria-label="الإعدادات"></aside>';
      dr.addEventListener('mousedown', function (e) { if (e.target === dr) close(); });
      document.body.appendChild(dr);
    }
    render();
    var d0 = dr; requestAnimationFrame(function () { if (d0 === dr) d0.classList.add('show'); });
  }
  function close() { if (!dr) return; dr.classList.remove('show'); var d = dr; dr = null; setTimeout(function () { d.remove(); }, 220); }

  function seg(name, items, cur) {
    return '<div class="st-seg" data-seg="' + name + '">' + items.map(function (it) {
      return '<button data-v="' + esc(it[0]) + '" class="' + (String(cur) === String(it[0]) ? 'on' : '') + '">' + it[1] + '</button>';
    }).join('') + '</div>';
  }
  function sw(name, label, on, hint) {
    return '<label class="st-row st-switch"><span><b>' + label + '</b>' + (hint ? '<small>' + hint + '</small>' : '') + '</span>' +
      '<input type="checkbox" data-ui="' + name + '"' + (on ? ' checked' : '') + '><i></i></label>';
  }
  function cloneSelect(id, name, val) {
    var src = document.getElementById(id); if (!src) return '';
    return '<select class="st-select" data-sel="' + name + '">' + [].map.call(src.options, function (o) {
      return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(val) ? ' selected' : '') + '>' + esc(o.textContent) + '</option>';
    }).join('') + '</select>';
  }

  function render() {
    var p = uiPrefs();
    var theme = document.documentElement.getAttribute('data-theme') || ls('mushaf_theme', 'dark');
    var bright = +ls('mushaf_brightness', '100');
    var eye = ls('mushaf_eye_comfort', 'false') === 'true';
    var dbl = !!g('isDoublePageMode');
    var ears = ls('recite_ears', 'browser');
    var match = ls('search_match', 'any');
    var lists = window.AyahLists && window.AyahLists._state ? window.AyahLists._state().lists.length : 0;

    dr.querySelector('.st-drawer').innerHTML =
      '<header class="st-head"><span class="st-title">⚙️ الإعدادات</span><button class="st-x" data-act="close" title="إغلاق (Esc)">✕</button></header>' +
      '<div class="st-body">' +

      '<section class="st-sec"><h3>🎨 المظهر</h3>' +
        '<div class="st-themes">' + THEMES.map(function (t) {
          return '<button class="st-theme' + (theme === t[0] ? ' on' : '') + '" data-theme-pick="' + t[0] + '"><span class="st-swatch st-sw-' + t[0] + '">' + t[1] + '</span>' + t[2] + '</button>';
        }).join('') + '</div>' +
        '<div class="st-row"><span><b>سطوع صفحة المصحف</b><small>يخفّف بياض الصفحة في الإضاءة الخافتة</small></span><output class="st-val">' + bright + '%</output></div>' +
        '<input class="st-range" type="range" min="50" max="100" step="5" value="' + bright + '" data-range="bright">' +
        sw('eye', '🛡️ فلتر راحة العين', eye, 'لون دافئ لصفحات المصحف') +
      '</section>' +

      '<section class="st-sec"><h3>📖 عرض المصحف</h3>' +
        '<div class="st-row"><span><b>عدد الصفحات</b></span>' + seg('view', [['single', '📄 صفحة واحدة'], ['double', '📖 صفحتان']], dbl ? 'double' : 'single') + '</div>' +
        '<div class="st-row"><span><b>حجم الصفحة</b><small>«على الشاشة» تُظهر الصفحة كاملة دون تمرير</small></span>' + seg('fit', [['0', '↔ ملء العرض'], ['1', '⤢ على الشاشة']], p.fit ? '1' : '0') + '</div>' +
        sw('hint', 'تلميح «انقر على أي آية»', p.hint) +
        sw('floatNav', 'أزرار التنقل العائمة', p.floatNav, '«السابقة / التالية» على جانبي الشاشة') +
      '</section>' +

      '<section class="st-sec"><h3>🎧 التلاوة الصوتية</h3>' +
        sw('player', 'لوحة المشغّل فوق المصحف', !!(document.getElementById('quranAudioPlayerBar') || {}).classList && document.getElementById('quranAudioPlayerBar').classList.contains('active'),
          'تُفتح وتُغلق أيضًا بزر 🎧 في الأعلى، ويُحفظ اختيارك') +
        '<div class="st-row"><span><b>القارئ</b></span>' + cloneSelect('modalReciterSelect', 'reciter', g('currentReciterKey')) + '</div>' +
        '<div class="st-row"><span><b>السرعة</b></span>' + cloneSelect('modalAudioSpeedSelect', 'speed', String(g('currentAudioSpeed'))) + '</div>' +
        '<div class="st-row"><span><b>تكرار الآية</b></span>' + cloneSelect('modalAudioRepeatSelect', 'repeat', g('audioRepeatTarget')) + '</div>' +
      '</section>' +

      '<section class="st-sec"><h3>🎙️ التسميع بالمايك</h3>' +
        '<div class="st-row"><span><b>التعرّف على الصوت</b><small>' + (ears === 'quran' ? 'النموذج القرآني داخل المتصفح (تجريبي، أبطأ)' : 'تعرّف Chrome (الأدق لصوتك)') + '</small></span>' +
          seg('ears', [['browser', '🎧 Chrome'], ['quran', '🧠 القرآني']], ears) + '</div>' +
        sw('autoTurn', 'قلب الصفحة تلقائيًا', p.autoTurn, 'ينتقل المصحف إلى صفحة الآية التي تتلوها') +
        sw('karaoke', 'شريط كلمات الآية', p.karaoke, 'كلمات الآية الحالية كلمةً كلمة في شريط التسميع') +
        sw('heard', 'إظهار ما التقطه المايك', p.heard, 'النص الذي سمعه التعرّف') +
      '</section>' +

      '<section class="st-sec"><h3>📚 التفسير والبحث</h3>' +
        '<div class="st-row"><span><b>التفسير الافتراضي</b></span>' + cloneSelect('tafsirSourceSelect', 'tafsir', g('currentTafsirSource')) + '</div>' +
        '<div class="st-row"><span><b>البحث بعدة كلمات</b></span>' + seg('match', [['any', 'كلمات متفرقة'], ['exact', 'عبارة متصلة']], match) + '</div>' +
      '</section>' +

      '<section class="st-sec"><h3>⌨️ اختصارات لوحة المفاتيح</h3><div class="st-keys">' +
        [['Ctrl + K', 'البحث'], ['/', 'البحث'], ['→  ←', 'الصفحة السابقة / التالية'], ['B', 'حفظ الآية المظللة في قائمة'], ['Esc', 'إغلاق النوافذ']].map(function (k) {
          return '<div><kbd>' + k[0] + '</kbd><span>' + k[1] + '</span></div>'; }).join('') + '</div></section>' +

      '<section class="st-sec"><h3>📴 دون إنترنت وتثبيت التطبيق</h3>' +
        '<div class="st-row"><span><b>صفحات المصحف على هذا الجهاز</b><small id="stPagesInfo">…</small></span>' +
        '<button class="st-btn" data-act="cachepages">📥 تنزيل كل الصفحات</button></div>' +
        '<p class="st-note">بعد التنزيل يعمل المصحف والبحث والتفسير الميسر والقوائم دون إنترنت. تعرّف Chrome على الصوت والتلاوة الصوتية والتفاسير الأخرى تحتاج الاتصال.</p>' +
        (window.ReaderPlus && window.ReaderPlus.canInstall() ? '<div class="st-btns"><button class="st-btn" data-act="install">📲 تثبيت المصحف كتطبيق</button></div>' :
          '<p class="st-note">للتثبيت كتطبيق: قائمة المتصفح ← «تثبيت التطبيق» (أو «إضافة إلى الشاشة الرئيسية» على الهاتف).</p>') +
      '</section>' +

      '<section class="st-sec"><h3>💾 البيانات</h3>' +
        '<p class="st-note">كل الإعدادات والقوائم (' + lists + ') محفوظة في هذا المتصفح فقط.</p>' +
        '<div class="st-btns"><button class="st-btn" data-act="stats">📊 إحصاءاتي وخطة الختمة</button></div>' +
        '<div class="st-btns"><button class="st-btn" data-act="lists">📚 قوائمي والنسخ الاحتياطي</button>' +
        '<button class="st-btn danger" data-act="reset">↺ الإعدادات الافتراضية</button></div>' +
      '</section>' +
      '</div>';
    wire();
    var pi = dr.querySelector('#stPagesInfo');
    if (pi && window.ReaderPlus) window.ReaderPlus.cachedPages().then(function (n) {
      pi.textContent = n >= 604 ? '✅ كل الصفحات محفوظة (604)' : (n ? n + ' من 604 محفوظة (كل صفحة تُحفظ عند فتحها)' : 'لم تُنزّل بعد — كل صفحة تُحفظ عند فتحها');
    });
  }

  function wire() {
    var d = dr.querySelector('.st-drawer');
    d.onclick = function (e) {
      var b;
      if ((b = e.target.closest('[data-act]'))) {
        var a = b.getAttribute('data-act');
        if (a === 'close') close();
        if (a === 'lists') { close(); if (window.AyahLists) window.AyahLists.open(); }
        if (a === 'stats') { close(); if (window.ReadingStats) window.ReadingStats.open(); }
        if (a === 'install' && window.ReaderPlus) { window.ReaderPlus.install().then(function () { if (dr) render(); }); }
        if (a === 'cachepages' && window.ReaderPlus) {
          b.disabled = true;
          var info = d.querySelector('#stPagesInfo');
          window.ReaderPlus.downloadAllPages(function (pr) {
            if (info) info.textContent = 'جارٍ التنزيل… ' + pr.done + ' / ' + pr.total + (pr.failed ? ' (تعذّر ' + pr.failed + ')' : '');
          }).then(function (pr) {
            call('showToast', pr.failed ? 'نُزّلت الصفحات إلا ' + pr.failed : '✅ نُزّلت صفحات المصحف الـ604 — يعمل الآن دون إنترنت');
            if (dr) render();
          }, function () { call('showToast', 'التنزيل يحتاج فتح التطبيق عبر الخادم (http) لا كملف'); b.disabled = false; });
        }
        if (a === 'reset' && confirm('إعادة كل الإعدادات إلى الافتراضي؟ (القوائم والملاحظات تبقى)')) {
          try { ['mushaf_ui', 'mushaf_theme', 'mushaf_brightness', 'mushaf_eye_comfort', 'search_match'].forEach(function (k) { localStorage.removeItem(k); }); } catch (x) {}
          call('setTheme', 'dark'); call('setBrightness', '100'); call('setEyeComfort', false); applyUi();
          // every setting the drawer shows: view mode, reciter, speed, repeat, tafsir
          call('setViewMode', 'single', true);
          var rc = g('RECITERS_CONFIG'); call('setReciter', rc && rc.minshawi_murattal ? 'minshawi_murattal' : Object.keys(rc || {})[0]);
          call('setAudioSpeed', 1); call('setAudioRepeatTarget', '1');
          call('setAudioPanel', window.innerWidth >= 768);   // the panel's default: open, closed on a phone
          var ts = document.getElementById('tafsirSourceSelect'); if (ts && ts.value !== 'muyassar') { ts.value = 'muyassar'; ts.dispatchEvent(new Event('change')); }
          var m = document.querySelector('.match-tag[data-match=any]'); if (m) m.click();
          render(); call('showToast', 'أُعيدت الإعدادات الافتراضية');
        }
        return;
      }
      if ((b = e.target.closest('[data-theme-pick]'))) { call('setTheme', b.getAttribute('data-theme-pick')); render(); return; }
      if ((b = e.target.closest('.st-seg button'))) {
        var name = b.parentNode.getAttribute('data-seg'), v = b.getAttribute('data-v');
        if (name === 'view') call('setViewMode', v);
        if (name === 'fit') setUi('fit', v === '1');
        if (name === 'match') { var t = document.querySelector('.match-tag[data-match=' + v + ']'); if (t) t.click(); else try { localStorage.setItem('search_match', v); } catch (x) {} }
        if (name === 'ears' && v !== ls('recite_ears', 'browser')) { var eb = document.getElementById('dockEarsBtn'); if (eb) eb.click(); }
        setTimeout(render, 30); return;
      }
    };
    d.querySelectorAll('[data-ui]').forEach(function (cb) {
      cb.onchange = function () {
        var k = cb.getAttribute('data-ui');
        if (k === 'eye') call('setEyeComfort', cb.checked);
        else if (k === 'player') call('setAudioPanel', cb.checked);
        else setUi(k, cb.checked);
      };
    });
    var r = d.querySelector('[data-range=bright]');
    if (r) r.oninput = function () { call('setBrightness', r.value); d.querySelector('.st-val').textContent = r.value + '%'; };
    d.querySelectorAll('[data-sel]').forEach(function (s) {
      s.onchange = function () {
        var k = s.getAttribute('data-sel');
        if (k === 'reciter') call('setReciter', s.value);
        if (k === 'speed') call('setAudioSpeed', parseFloat(s.value));
        if (k === 'repeat') call('setAudioRepeatTarget', s.value);
        if (k === 'tafsir') { var t = document.getElementById('tafsirSourceSelect'); if (t) { t.value = s.value; t.dispatchEvent(new Event('change')); } }
        call('showToast', 'حُفظ الإعداد');
      };
    });
  }

  function init() {
    applyUi(); watchDock();
    var b = document.getElementById('settingsBtn'); if (b) b.addEventListener('click', open);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dr) { close(); e.stopPropagation(); } }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.MushafSettings = { open: open, close: close, prefs: uiPrefs };
})();
