/* Ayah lists ("قوائمي"): save ayahs into named lists, notes per ayah,
 * per-list properties (sort, group by surah, spaced review, quiz mode, pin,
 * icon, colour), export/import. Stored in this browser (localStorage).
 * Icons: line SVGs of assets/js/ayah-list-icons.js (tools/ayah_lists/build_icons.py), or an emoji.
 * A new list is a draft (ui.form) until «إنشاء القائمة»; list names are unique (nameKey).
 *
 * Entry points (index.html):
 *   header «📚 قوائمي»            -> AyahLists.open()
 *   tafsir modal «🔖 حفظ»         -> AyahLists.openSaver(sura, aya, button)
 *   search result «🔖 حفظ»        -> same
 *   recite dock 🔖                -> saves the ayah being recited
 *   key «b» (not typing)          -> saver for the highlighted ayah
 *   openAyahTafsir()              -> AyahLists.renderAyahInfo(sura, aya)
 * It reads index.html's globals at call time: activeData, ayaIndexMap,
 * currentHighlightedAyah, selectResult, openAyahTafsir, getAyahAudioUrl, showToast.
 */
(function () {
  'use strict';

  var KEY = 'ayahLists.v1';
  var REVIEW_DAYS = [1, 3, 7, 14, 30, 60];          // spaced review intervals
  // icons: ids of assets/js/ayah-list-icons.js (line SVGs); any other string is shown as typed (an emoji)
  var ICONS = ['star', 'book-heart', 'kaaba', 'moon-star', 'tasbih', 'hand-heart', 'lightbulb', 'anchor', 'brain', 'repeat', 'sparkles', 'leaf', 'cloud-rain', 'rub-hizb', 'lantern', 'gem'];
  var COLORS = ['#c9a227', '#d97706', '#ea580c', '#dc2626', '#e11d48', '#db2777', '#c026d3', '#7c3aed', '#4f46e5',
                '#2563eb', '#0284c7', '#0891b2', '#0d9488', '#059669', '#16a34a', '#65a30d', '#92400e', '#475569'];
  // the emoji icons of v1 lists, drawn again as line icons
  var EMOJI_TO_ICON = { '⭐': 'star', '🔖': 'bookmark', '📌': 'pin', '💚': 'book-heart', '🌙': 'moon-star', '🕋': 'kaaba',
    '📿': 'tasbih', '🤲': 'hand-heart', '🎯': 'target', '🧠': 'brain', '🎙️': 'mic', '🎙': 'mic', '📖': 'book-open',
    '✨': 'sparkles', '🌿': 'leaf', '🔥': 'flame', '💎': 'gem' };
  // ready ideas for a new list: [name, icon, colour, description, review]
  var TEMPLATES = [
    ['آيات الصبر والثبات', 'anchor', '#0d9488', 'آيات تثبّت القلب عند الشدة'],
    ['أدعية من القرآن', 'hand-heart', '#7c3aed', 'أدعية قرآنية أدعو بها'],
    ['مراجعة الحفظ', 'repeat', '#2563eb', 'آيات أراجعها على فترات متباعدة', true],
    ['آيات أثّرت فيّ', 'book-heart', '#e11d48', ''],
    ['للتدبر والسؤال', 'lightbulb', '#d97706', 'آيات أريد أن أتعمق في معناها'],
    ['بشرى ورحمة', 'cloud-rain', '#059669', 'آيات الرجاء والبشارة'],
    ['قصص الأنبياء', 'map', '#92400e', ''],
    ['المتشابهات', 'puzzle', '#c026d3', 'آيات متشابهة الألفاظ أخلط بينها']
  ];
  var DEFAULT_NAME = 'قائمة جديدة';
  var SORTS = [
    ['added_desc', 'الأحدث إضافة'], ['added_asc', 'الأقدم إضافة'],
    ['mushaf', 'ترتيب المصحف'], ['manual', 'ترتيب يدوي'], ['due', 'الأقرب للمراجعة']
  ];
  var DAY = 86400000;

  /* ------------------------------ store ------------------------------ */
  var st = null;
  function uid() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function newList(o) {
    return Object.assign({ id: uid(), name: DEFAULT_NAME, icon: 'bookmark', color: COLORS[0], desc: '',
      sort: 'added_desc', group: false, review: false, quiz: false, pinned: false, created: Date.now(), items: [] }, o || {});
  }
  function mistakesList() {
    return newList({ name: 'أخطاء التسميع', kind: 'mistakes', icon: 'mic', color: '#dc2626', review: true, sort: 'due',
      desc: 'آيات أخطأتُ فيها أثناء التسميع — تُعرض للمراجعة على فترات متباعدة' });
  }
  // a name the reader would call «the same»: spaces, alef/ya/ta-marbuta forms and tashkeel aside
  function nameKey(n) {
    return String(n || '').replace(/[ً-ْٰـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function nameTaken(name, exceptId) {
    var key = nameKey(name);
    return load().lists.filter(function (l) { return l.id !== exceptId && nameKey(l.name) === key; })[0] || null;
  }
  function uniqueName(base) {
    var n = base, i = 2;
    while (nameTaken(n)) n = base + ' ' + i++;
    return n;
  }
  function load() {
    if (st) return st;
    try { st = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { st = null; }
    if (!st || !Array.isArray(st.lists)) {
      st = { v: 2, lists: [], notes: {}, activeId: null, lastIds: [] };
      st.lists.push(newList({ name: 'المفضلة', icon: 'star', color: COLORS[0], desc: 'آيات أحبها وأعود إليها' }));
      st.lists.push(mistakesList());
      st.activeId = st.lists[0].id;
      save();
    }
    st.notes = st.notes || {};
    st.lastIds = st.lastIds || [];
    if ((st.v || 1) < 2) migrateV2();
    return st;
  }
  // v1 → v2: «＋ قائمة جديدة» used to save an unnamed list at once, so every unfinished
  // attempt left an empty «قائمة جديدة» behind; drop those, make every name unique,
  // draw the emoji icons as line icons, and mark the mistakes list by kind (not by name)
  function migrateV2() {
    st.lists = st.lists.filter(function (l) {
      return l && Array.isArray(l.items) && !(nameKey(l.name) === nameKey(DEFAULT_NAME) && !l.items.length && !l.desc);
    });
    var seen = {};
    st.lists.forEach(function (l) {
      var base = String(l.name || '').trim() || 'قائمة', n = base, i = 2;
      while (seen[nameKey(n)]) n = base + ' ' + i++;
      l.name = n; seen[nameKey(n)] = 1;
      if (EMOJI_TO_ICON[l.icon]) l.icon = EMOJI_TO_ICON[l.icon];
      if (!l.kind && nameKey(l.name) === nameKey('أخطاء التسميع')) l.kind = 'mistakes';
    });
    if (!st.lists.some(function (l) { return l.id === st.activeId; })) st.activeId = st.lists.length ? st.lists[0].id : null;
    st.v = 2;
    save();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { toast('تعذّر الحفظ في المتصفح'); } }
  function listById(id) { return load().lists.filter(function (l) { return l.id === id; })[0] || null; }
  function k(s, a) { return s + ':' + a; }
  function hasItem(l, s, a) { return l.items.some(function (it) { return it.s === s && it.a === a; }); }
  function listsWith(s, a) { return load().lists.filter(function (l) { return hasItem(l, s, a); }); }

  function addItem(l, s, a) {
    if (hasItem(l, s, a)) return false;
    var maxO = l.items.reduce(function (m, it) { return Math.max(m, it.order || 0); }, 0);
    l.items.push({ s: s, a: a, added: Date.now(), order: maxO + 1, lvl: 0, next: Date.now() });
    st.lastIds = [l.id].concat(st.lastIds.filter(function (x) { return x !== l.id; })).slice(0, 5);
    save(); return true;
  }
  function removeItem(l, s, a) { l.items = l.items.filter(function (it) { return !(it.s === s && it.a === a); }); save(); }

  /* ----------------------------- helpers ----------------------------- */
  function g(name) { try { return (0, eval)(name); } catch (e) { return undefined; } }   // index.html globals (let/const)
  function toast(m) { var f = g('showToast'); if (typeof f === 'function') f(m); }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // a list's icon: a line icon of ayah-list-icons.js, or the emoji the reader typed
  function iconDef(icon) { var I = window.AL_ICONS; return (I && I.icons && I.icons[icon]) || null; }
  function iconHtml(icon) {
    var d = iconDef(icon);
    if (d) return '<svg class="al-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d.s + '</svg>';
    return '<span class="al-emo">' + esc(icon || '🔖') + '</span>';
  }
  function iconText(icon) { var d = iconDef(icon); return d ? d.e : (icon || '🔖'); }   // for copied plain text
  function ayahRow(s, a) {
    var map = g('ayaIndexMap'), data = g('activeData');
    if (!map || !data) return null;
    var i = map.get(s + '_' + a);
    return i === undefined ? null : data[i];
  }
  function ayahText(s, a) { var r = ayahRow(s, a); return r ? String(r[4]).replace(/\s*\(\d+\)\s*$/, '') : ''; }
  function ago(t) {
    if (!isFinite(t)) return '—';
    var d = (t - Date.now()) / 1000, rtf;
    try { rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }); } catch (e) { return new Date(t).toLocaleDateString('ar'); }
    var u = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (var i = 0; i < u.length; i++) if (Math.abs(d) >= u[i][1] * 0.97) return rtf.format(Math.round(d / u[i][1]), u[i][0]);
    return rtf.format(Math.round(d), 'second');
  }
  function isDue(it) { return !isFinite(it.next) || (it.next || 0) <= Date.now(); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  /* =========================== the saver ============================= */
  var pop = null;
  function closeSaver() { if (pop) { pop.remove(); pop = null; document.removeEventListener('mousedown', outsideSaver, true); } }
  function outsideSaver(e) { if (pop && !pop.contains(e.target)) closeSaver(); }

  function openSaver(s, a, anchor) {
    s = +s; a = +a; load(); closeSaver();
    var row = ayahRow(s, a);
    if (!row) { toast('لم يتم العثور على الآية'); return; }
    pop = el('div', 'al-pop');
    pop.setAttribute('dir', 'rtl');
    pop.setAttribute('role', 'dialog');
    renderSaver(s, a, row);
    document.body.appendChild(pop);
    placePop(anchor);
    setTimeout(function () { document.addEventListener('mousedown', outsideSaver, true); }, 0);
  }

  function renderSaver(s, a, row) {
    var lists = sortedLists();
    var note = (st.notes[k(s, a)] || {}).text || '';
    pop.innerHTML =
      '<div class="al-pop-head"><span class="al-pop-title">🔖 حفظ الآية</span>' +
      '<span class="al-pop-ref">سورة ' + esc(row[3]) + ' • آية ' + a + '</span>' +
      '<button class="al-x" data-act="close" title="إغلاق">✕</button></div>' +
      '<form class="al-pop-new" data-act="new"><input type="search" maxlength="40" autocomplete="off" placeholder="🔍 ابحث عن قائمة، أو اكتب اسمًا جديدًا ثم Enter"></form>' +
      '<div class="al-pop-lists">' + lists.map(function (l) {
        var on = hasItem(l, s, a);
        return '<label class="al-pop-row' + (on ? ' on' : '') + '" style="--lc:' + esc(l.color) + '" data-find="' + esc(nameKey(l.name + ' ' + (l.desc || ''))) + '">' +
          '<input type="checkbox" data-list="' + esc(l.id) + '"' + (on ? ' checked' : '') + '>' +
          '<span class="al-dot">' + iconHtml(l.icon) + '</span><span class="al-pop-name">' + esc(l.name) + '</span>' +
          '<span class="al-pop-count">' + l.items.length + '</span></label>';
      }).join('') + '<div class="al-pop-hint" hidden></div></div>' +
      '<div class="al-pop-note"><div class="al-pop-label">📝 ملاحظة على الآية <span>تظهر في كل قوائمها</span></div>' +
      '<textarea rows="2" placeholder="مثال: أخطأت في «…»، أو فائدة من التفسير…">' + esc(note) + '</textarea></div>' +
      '<div class="al-pop-foot"><button class="al-btn ghost" data-act="lists">📚 فتح قوائمي</button>' +
      '<button class="al-btn gold" data-act="close">تم</button></div>';

    pop.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var l = listById(cb.getAttribute('data-list'));
        if (!l) return;
        if (cb.checked) { addItem(l, s, a); toast('أُضيفت إلى «' + l.name + '»'); }
        else { removeItem(l, s, a); toast('أُزيلت من «' + l.name + '»'); }
        cb.closest('.al-pop-row').classList.toggle('on', cb.checked);
        cb.closest('.al-pop-row').querySelector('.al-pop-count').textContent = l.items.length;
        refreshAll(s, a);
      });
    });
    // one box: it narrows the lists as you type; Enter saves into the list of that name, or makes it
    var findIn = pop.querySelector('.al-pop-new input');
    findIn.addEventListener('input', function () {
      var raw = findIn.value.trim(), q = nameKey(raw), shown = 0;
      pop.querySelectorAll('.al-pop-row').forEach(function (r) { var hit = !q || r.getAttribute('data-find').indexOf(q) >= 0; r.hidden = !hit; if (hit) shown++; });
      var hint = pop.querySelector('.al-pop-hint'), exact = raw && nameTaken(raw);
      hint.hidden = !raw || !!exact;
      if (raw && !exact) hint.innerHTML = (shown ? '' : 'لا قائمة بهذا الاسم — ') + 'اضغط <b>Enter</b> لإنشاء «' + esc(raw) + '» وحفظ الآية فيها';
    });
    pop.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = this.querySelector('input').value.trim().replace(/\s+/g, ' ');
      if (!name) return;
      var same = nameTaken(name);
      if (same) {                       // never a second list with the same name: use that one
        if (hasItem(same, s, a)) toast('الآية محفوظة في «' + same.name + '» من قبل');
        else { addItem(same, s, a); toast('أُضيفت إلى «' + same.name + '»'); }
      } else {
        var l = newList({ name: name, icon: ICONS[(st.lists.length + 2) % ICONS.length], color: COLORS[(st.lists.length * 5) % COLORS.length] });
        st.lists.push(l); addItem(l, s, a);
        toast('أُنشئت «' + name + '» وأُضيفت الآية إليها');
      }
      renderSaver(s, a, row); refreshAll(s, a);
    });
    var ta = pop.querySelector('textarea'), tmr = 0;
    ta.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(function () { setNote(s, a, ta.value); }, 350); });
    ta.addEventListener('blur', function () { setNote(s, a, ta.value); });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.tagName === 'FORM') return;
      var act = b.getAttribute('data-act');
      if (act === 'close') { setNote(s, a, ta.value); closeSaver(); }
      if (act === 'lists') { setNote(s, a, ta.value); closeSaver(); open(); }
    });
  }

  function placePop(anchor) {
    var w = Math.min(340, window.innerWidth - 24);
    pop.style.width = w + 'px';
    if (!anchor || window.innerWidth < 560) { pop.classList.add('sheet'); return; }  // phone: bottom sheet
    var r = anchor.getBoundingClientRect(), h = pop.offsetHeight;
    var top = r.bottom + 8; if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 8);
    var left = Math.min(Math.max(10, r.left + r.width / 2 - w / 2), window.innerWidth - w - 10);
    pop.style.top = top + 'px'; pop.style.left = left + 'px';
  }

  function setNote(s, a, text) {
    text = String(text || '').trim();
    var key = k(s, a), old = (st.notes[key] || {}).text || '';
    if (text === old) return;
    if (text) st.notes[key] = { text: text, updated: Date.now() }; else delete st.notes[key];
    save(); refreshAll(s, a);
  }

  /* ====================== info inside the tafsir modal ================ */
  function renderAyahInfo(s, a) {
    load();
    var box = document.getElementById('ayahListsInfo');
    if (!box) return;
    box.setAttribute('data-s', s); box.setAttribute('data-a', a);
    var ls = listsWith(+s, +a), note = (st.notes[k(+s, +a)] || {}).text;
    if (!ls.length && !note) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = (ls.length ? '<div class="al-info-lists">🔖 محفوظة في: ' + ls.map(function (l) {
      return '<button class="al-chip" style="--lc:' + esc(l.color) + '" data-open="' + esc(l.id) + '">' + iconHtml(l.icon) + ' ' + esc(l.name) + '</button>';
    }).join('') + '</div>' : '') + (note ? '<div class="al-info-note">📝 ' + esc(note) + '</div>' : '');
    box.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { st.activeId = b.getAttribute('data-open'); save(); open(); };
    });
  }
  function refreshAll(s, a) {
    var box = document.getElementById('ayahListsInfo');
    if (box && +box.getAttribute('data-s') === +s && +box.getAttribute('data-a') === +a) renderAyahInfo(s, a);
    if (modal) renderModal();
    paintSaveButtons();
  }
  function paintSaveButtons() {   // gold «محفوظة» state on the tafsir modal's button
    var b = document.getElementById('tafsirSaveListBtn'), box = document.getElementById('ayahListsInfo');
    if (!b || !box) return;
    var n = listsWith(+box.getAttribute('data-s'), +box.getAttribute('data-a')).length;
    b.classList.toggle('al-saved', n > 0);
    b.innerHTML = n ? '🔖 محفوظة (' + n + ')' : '🔖 حفظ في قائمة';
  }

  /* =========================== lists modal =========================== */
  // editing: null | 'new' (a draft, not in the store until «إنشاء») | 'edit'; form: the editor's values
  // lq: the side search; sel: {keys:{'s:a':1}, last:'s:a'} while «تحديد» is on; undo: {text, run, until}
  var modal = null, ui = { q: '', filter: 'all', editing: null, form: null, audio: null, playing: null, revealed: {}, lq: '', sel: null, undo: null };

  function sortedLists() {
    return load().lists.slice().sort(function (x, y) { return (y.pinned - x.pinned) || (x.created - y.created); });
  }

  function open() {
    load();
    if (!listById(st.activeId)) st.activeId = st.lists.length ? st.lists[0].id : null;
    if (!modal) {
      modal = el('div', 'al-backdrop');
      modal.setAttribute('dir', 'rtl');
      modal.innerHTML = '<div class="al-modal" role="dialog" aria-label="قوائمي"><aside class="al-side"></aside><section class="al-main"></section></div>';
      modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
      document.body.appendChild(modal);
    }
    ui.editing = null; ui.form = null; ui.q = ''; ui.filter = 'all'; ui.revealed = {}; ui.lq = ''; ui.sel = null; ui.undo = null;
    renderModal();
    var m0 = modal, show = function () { if (m0 === modal) m0.classList.add('show'); };   // closed meanwhile: nothing
    requestAnimationFrame(show); setTimeout(show, 60);   // a background tab runs no frames: the timer still shows it
  }
  function close() {
    if (!modal) return;
    stopAudio(); closeSaver();
    modal.classList.remove('show');
    var m = modal; modal = null;
    setTimeout(function () { m.remove(); }, 200);
  }

  function renderModal() {
    if (!modal) return;
    renderSide();
    renderMain();
  }

  function renderSide() {
    var side = modal.querySelector('.al-side');
    var lists = sortedLists();
    side.innerHTML =
      '<div class="al-side-head"><span class="al-brand">📚 قوائمي</span><button class="al-x" data-act="close" title="إغلاق (Esc)">✕</button></div>' +
      '<label class="al-side-search"><span aria-hidden="true">🔍</span><input type="search" autocomplete="off" placeholder="ابحث عن قائمة…" aria-label="ابحث عن قائمة بالاسم أو الوصف"></label>' +
      '<div class="al-side-lists">' + lists.map(function (l) {
        var due = l.review ? l.items.filter(isDue).length : 0;
        return '<button class="al-side-item' + (l.id === st.activeId && ui.editing !== 'new' ? ' active' : '') + '" data-pick="' + esc(l.id) + '" style="--lc:' + esc(l.color) + '"' +
          ' data-find="' + esc(nameKey(l.name + ' ' + (l.desc || ''))) + '">' +
          '<span class="al-dot">' + iconHtml(l.icon) + '</span>' +
          '<span class="al-side-name" data-name="' + esc(l.name) + '">' + esc(l.name) + (l.pinned ? ' <i class="al-pin" title="مثبّتة">📌</i>' : '') + '</span>' +
          (due ? '<span class="al-due" title="' + due + ' مستحقة للمراجعة الآن">⏰ ' + due + '</span>' : '') +
          '<span class="al-count" title="عدد الآيات">' + l.items.length + '</span></button>';
      }).join('') +
      (ui.editing === 'new' && ui.form ? '<div class="al-side-item active al-draft" style="--lc:' + esc(ui.form.color) + '">' +
        '<span class="al-dot">' + iconHtml(ui.form.icon) + '</span><span class="al-side-name">' + esc(ui.form.name || 'قائمة جديدة…') + '</span>' +
        '<span class="al-count">مسودة</span></div>' : '') +
        '<div class="al-side-none" hidden><span>لا قائمة بهذا الاسم</span><button type="button" class="al-btn ghost" data-act="new-named"></button></div>' +
      '</div>' +
      '<button class="al-new" data-act="new"' + (ui.editing === 'new' ? ' disabled' : '') + '>＋ قائمة جديدة</button>' +
      '<div class="al-side-foot"><button class="al-link" data-act="export" title="نسخة احتياطية لكل القوائم والملاحظات">⬇ تصدير</button>' +
      '<button class="al-link" data-act="import" title="استيراد نسخة احتياطية (تُدمج مع الموجود)">⬆ استيراد</button></div>';
    side.querySelectorAll('[data-pick]').forEach(function (b) {
      b.onclick = function () { st.activeId = b.getAttribute('data-pick'); ui.editing = null; ui.form = null; ui.q = ''; ui.filter = 'all'; ui.revealed = {}; ui.sel = null; save(); renderModal(); };
    });
    // the search keeps its text across redraws; Enter opens the first list it shows
    var find = side.querySelector('.al-side-search input');
    find.value = ui.lq || '';
    find.addEventListener('input', function () { ui.lq = find.value; filterSide(side); });
    find.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var first = side.querySelector('[data-pick]:not([hidden])');
        if (first) first.click(); else if (ui.lq.trim()) startDraft(ui.lq.trim());
      }
    });
    filterSide(side);
    side.onclick = function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'close') close();
      if (act === 'new-named') startDraft((ui.lq || '').trim());
      if (act === 'new' && ui.editing !== 'new') startDraft('');
      if (act === 'export') exportAll();
      if (act === 'import') importAll();
    };
  }

  // hide the lists the search does not match; mark the matched letters when they are written as typed
  function filterSide(side) {
    var raw = (ui.lq || '').trim(), q = nameKey(raw), shown = 0;
    side.querySelectorAll('[data-pick]').forEach(function (b) {
      var hit = !q || b.getAttribute('data-find').indexOf(q) >= 0;
      b.hidden = !hit; if (hit) shown++;
      var nm = b.querySelector('.al-side-name'), name = nm.getAttribute('data-name'), at = raw ? name.indexOf(raw) : -1;
      var pin = nm.querySelector('.al-pin'), pinHtml = pin ? ' ' + pin.outerHTML : '';
      nm.innerHTML = (at >= 0 ? esc(name.slice(0, at)) + '<mark>' + esc(name.slice(at, at + raw.length)) + '</mark>' + esc(name.slice(at + raw.length)) : esc(name)) + pinHtml;
    });
    var none = side.querySelector('.al-side-none');
    none.hidden = !(q && !shown);
    if (q && !shown) none.querySelector('button').textContent = '＋ أنشئ «' + raw + '»';
  }

  function startDraft(name) {     // a draft only: nothing is stored until «إنشاء القائمة»
    if (ui.editing === 'new') return;
    var used = {};
    st.lists.forEach(function (l) { used[l.icon] = 1; used[l.color] = 1; });
    ui.editing = 'new'; ui.sel = null; ui.lq = '';
    ui.form = { name: name || '', desc: '', review: false,
      icon: ICONS.filter(function (x) { return !used[x]; })[0] || ICONS[st.lists.length % ICONS.length],
      color: COLORS.filter(function (x) { return !used[x]; })[0] || COLORS[(st.lists.length * 5) % COLORS.length],
      cat: 'all', q: '' };
    renderModal();
    var inp = modal.querySelector('.al-in-name');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }

  function itemsView(l) {
    var it = l.items.slice(), q = ui.q.trim();
    if (q) {
      var nq = (typeof normalizeArabic === 'function') ? normalizeArabic(q) : q;
      it = it.filter(function (x) {
        var r = ayahRow(x.s, x.a), note = (st.notes[k(x.s, x.a)] || {}).text || '';
        return (r && (r.normalized || '').indexOf(nq) >= 0) || (r && r[3].indexOf(q) >= 0) || note.indexOf(q) >= 0;
      });
    }
    if (ui.filter === 'notes') it = it.filter(function (x) { return !!st.notes[k(x.s, x.a)]; });
    if (ui.filter === 'due') it = it.filter(isDue);
    var by = {
      added_desc: function (x, y) { return y.added - x.added; },
      added_asc: function (x, y) { return x.added - y.added; },
      mushaf: function (x, y) { return (x.s - y.s) || (x.a - y.a); },
      manual: function (x, y) { return (x.order || 0) - (y.order || 0); },
      due: function (x, y) { return (x.next || 0) - (y.next || 0); }
    }[l.sort] || function () { return 0; };
    it.sort(by);
    if (l.group) {   // one block per surah (duplicate headers with a non-mushaf sort), surahs in order of first appearance
      var firstAt = {};
      it.forEach(function (x, n) { if (firstAt[x.s] === undefined) firstAt[x.s] = n; });
      it = it.map(function (x, n) { return [x, n]; }).sort(function (A, B) { return (firstAt[A[0].s] - firstAt[B[0].s]) || (A[1] - B[1]); }).map(function (A) { return A[0]; });
    }
    return it;
  }

  function renderMain() {
    var main = modal.querySelector('.al-main');
    var l = listById(st.activeId);
    if (ui.editing && ui.form && (ui.editing === 'new' || l)) { renderStudio(main, ui.editing === 'edit' ? l : null); return; }
    if (!l) { main.innerHTML = '<div class="al-empty"><div>📚</div><h3>لا توجد قوائم بعد</h3><p>أنشئ قائمة من الشريط الجانبي.</p></div>'; return; }
    var items = itemsView(l);
    var suras = {}, pages = {};
    l.items.forEach(function (x) { suras[x.s] = 1; var r = ayahRow(x.s, x.a); if (r) pages[r[2]] = 1; });
    var due = l.items.filter(isDue).length;

    var head =
      '<div class="al-head" style="--lc:' + esc(l.color) + '">' +
        '<div class="al-head-icon">' + iconHtml(l.icon) + '</div>' +
        '<div class="al-head-txt"><h2>' + esc(l.name) + '</h2>' + (l.desc ? '<p>' + esc(l.desc) + '</p>' : '') +
        '<div class="al-stats"><span>' + l.items.length + ' آية</span><span>' + Object.keys(suras).length + ' سورة</span><span>' + Object.keys(pages).length + ' صفحة</span>' +
        (l.review ? '<span class="al-stat-due">' + due + ' مستحقة للمراجعة</span>' : '') + '</div></div>' +
        '<div class="al-head-btns"><button class="al-btn ghost" data-act="edit" title="الاسم والأيقونة واللون والوصف">✏️ تعديل</button>' +
        '<button class="al-btn ghost" data-act="copy" title="نسخ آيات القائمة وملاحظاتها كنص">📋 نسخ</button>' +
        '<button class="al-btn ghost danger" data-act="delete" title="حذف القائمة">🗑</button></div></div>';

    var props =
      '<div class="al-props">' +
        '<label class="al-prop"><span>↕ الترتيب</span><select data-prop="sort">' + SORTS.filter(function (o) { return o[0] !== 'due' || l.review; }).map(function (o) {
          return '<option value="' + o[0] + '"' + (l.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        toggle('group', '🗂 تجميع حسب السورة', l.group, 'عناوين للسور داخل القائمة') +
        toggle('review', '🧠 مراجعة متباعدة', l.review, 'كل آية تعود للمراجعة بعد 1، 3، 7، 14، 30، 60 يومًا كلما أتقنتها') +
        toggle('quiz', '🙈 وضع الاختبار', l.quiz, 'إخفاء نص الآيات — تظهر أول كلمة فقط، وانقر لكشف الباقي') +
        toggle('pinned', '📌 تثبيت', l.pinned, 'إظهار القائمة أولًا') +
      '</div>' +
      '<div class="al-tools"><input class="al-search" type="search" placeholder="🔍 ابحث في هذه القائمة (نص، سورة، ملاحظة)…" value="' + esc(ui.q) + '">' +
        '<div class="al-seg">' + seg('all', 'الكل') + seg('notes', 'بملاحظات') + (l.review ? seg('due', 'مستحقة الآن') : '') + '</div>' +
        (l.items.length ? '<button class="al-btn al-sel-btn' + (ui.sel ? ' on' : '') + '" data-act="select" title="حدّد آيات لتنقلها أو تنسخها أو تزيلها معًا (أو اضغط مطوّلًا على آية)">' +
          (ui.sel ? '✓ إنهاء التحديد' : '☑ تحديد') + '</button>' : '') + '</div>';

    var body;
    if (!l.items.length) {
      body = '<div class="al-empty" style="--lc:' + esc(l.color) + '"><div class="al-empty-ic">' + iconHtml(l.icon) + '</div><h3>القائمة فارغة</h3>' +
        '<p>احفظ آيات هنا من زر <b>🔖 حفظ</b> في نافذة الآية (انقر أي آية في المصحف)، أو في نتائج البحث، أو أثناء التسميع، أو بالضغط على <kbd>B</kbd> بعد تظليل آية.</p></div>';
    } else if (!items.length) {
      body = '<div class="al-empty small"><h3>لا نتائج</h3><p>غيّر البحث أو المرشّح.</p></div>';
    } else {
      var html = '', lastS = null;
      items.forEach(function (x, i) {
        if (l.group && x.s !== lastS) {
          var r0 = ayahRow(x.s, x.a);
          html += '<div class="al-group">سورة ' + esc(r0 ? r0[3] : x.s) + '</div>';
          lastS = x.s;
        }
        html += card(l, x, i, items.length);
      });
      body = '<div class="al-items">' + html + '</div>';
    }
    main.innerHTML = '<div class="al-main-top">' + head + props + '</div>' + body + selBarHtml(l, items) + undoHtml();
    main.classList.toggle('al-selecting', !!ui.sel);
    wireMain(l);
  }

  function toggle(prop, label, on, title) {
    return '<button class="al-toggle' + (on ? ' on' : '') + '" data-toggle="' + prop + '" title="' + esc(title) + '"><i></i>' + label + '</button>';
  }
  function seg(v, label) { return '<button class="' + (ui.filter === v ? 'on' : '') + '" data-filter="' + v + '">' + label + '</button>'; }

  function card(l, x, i, n) {
    var r = ayahRow(x.s, x.a);
    if (!r) return '';
    var text = ayahText(x.s, x.a), note = (st.notes[k(x.s, x.a)] || {}).text || '';
    var key = k(x.s, x.a), hidden = l.quiz && !ui.revealed[key];
    var words = text.split(/\s+/);
    var shown = hidden ? '<span>' + esc(words[0]) + '</span> <span class="al-veil">' + words.slice(1).map(function () { return '•••'; }).join(' ') + '</span>' : esc(text);
    var rev = '';
    if (l.review) {
      var dueNow = isDue(x);
      var lv = Math.max(0, Math.min(6, (x.lvl | 0)));   // clamp: imported data may be anything
      rev = '<div class="al-rev"><span class="al-lvl" title="مستوى الإتقان">' + '●'.repeat(lv) + '<b>' + '●'.repeat(6 - lv) + '</b></span>' +
        '<span class="al-next' + (dueNow ? ' due' : '') + '">' + (dueNow ? '⏰ مستحقة الآن' : 'المراجعة ' + ago(x.next)) + '</span>' +
        '<button class="al-btn ok" data-rev="ok" title="راجعتها وأتقنتها: تعود بعد مدة أطول">✓ أتقنتها</button>' +
        '<button class="al-btn bad" data-rev="bad" title="أخطأت فيها: تعود قريبًا">✗ أخطأت</button></div>';
    }
    var picked = ui.sel && ui.sel.keys[key];
    return '<article class="al-card' + (picked ? ' picked' : '') + '" data-s="' + x.s + '" data-a="' + x.a + '" data-k="' + key + '" style="--lc:' + esc(l.color) + '"' +
      (ui.sel ? ' role="checkbox" aria-checked="' + !!picked + '" tabindex="0"' : '') + '>' +
      '<div class="al-card-head">' + (ui.sel ? '<span class="al-tick" aria-hidden="true"></span>' : '') +
      '<span class="al-ref">سورة ' + esc(r[3]) + ' <b>' + x.a + '</b></span><span class="al-page">ص ' + r[2] + '</span>' +
      '<span class="al-when" title="' + esc(new Date(x.added).toLocaleString('ar')) + '">أُضيفت ' + ago(x.added) + '</span>' +
      (l.sort === 'manual' && !ui.q.trim() && ui.filter === 'all' && !l.group ? '<span class="al-move"><button data-move="-1" ' + (i === 0 ? 'disabled' : '') + ' title="إلى الأعلى">▲</button><button data-move="1" ' + (i === n - 1 ? 'disabled' : '') + ' title="إلى الأسفل">▼</button></span>' : '') +
      '</div>' +
      '<div class="al-text' + (hidden ? ' quiz' : '') + '"' + (hidden ? ' title="انقر لكشف الآية"' : '') + '>' + shown + ' <span class="al-num">﴿' + x.a + '﴾</span></div>' +
      '<div class="al-note' + (note ? ' has' : '') + '"><textarea rows="1" placeholder="📝 أضف ملاحظة…">' + esc(note) + '</textarea></div>' +
      rev +
      '<div class="al-card-foot"><button class="al-btn gold" data-do="go">📖 في المصحف</button>' +
      '<button class="al-btn ghost" data-do="tafsir">التفسير</button>' +
      '<button class="al-btn ghost" data-do="play">' + (ui.playing === key ? '⏸ إيقاف' : '🎧 استماع') + '</button>' +
      '<button class="al-btn ghost" data-do="save" title="نسخ/نقل إلى قوائم أخرى">🔖 القوائم</button>' +
      '<button class="al-btn ghost danger" data-do="remove" title="إزالة من هذه القائمة">إزالة</button></div></article>';
  }

  /* ------------------ «تحديد»: pick ayahs, then act on them together ------------------ */
  function selKeys() { return ui.sel ? Object.keys(ui.sel.keys) : []; }
  function selBarHtml(l, items) {
    if (!ui.sel) return '';
    var n = selKeys().length, all = items.length && items.every(function (x) { return ui.sel.keys[k(x.s, x.a)]; });
    var dis = n ? '' : ' disabled';
    return '<div class="al-selbar" role="toolbar" aria-label="أوامر الآيات المحددة" style="--lc:' + esc(l.color) + '">' +
      '<button class="al-sb-x" data-act="sel-close" title="إنهاء التحديد (Esc)">✕</button>' +
      '<span class="al-sb-count"><b>' + n + '</b> ' + (n === 1 ? 'آية محددة' : n === 2 ? 'آيتان محددتان' : 'محددة') + '</span>' +
      '<button class="al-sb-btn" data-act="sel-all">' + (all ? '◻ إلغاء الكل' : '☑ تحديد الكل (' + items.length + ')') + '</button>' +
      '<span class="al-sb-sep"></span>' +
      '<button class="al-sb-btn" data-act="sel-move"' + dis + ' title="انقلها إلى قائمة أخرى (تُحذف من هذه)">↪ نقل إلى…</button>' +
      '<button class="al-sb-btn" data-act="sel-copy"' + dis + ' title="انسخها إلى قائمة أخرى (تبقى هنا أيضًا)">⧉ نسخ إلى…</button>' +
      '<button class="al-sb-btn" data-act="sel-text"' + dis + ' title="انسخ نصها وملاحظاتها">📋 نص</button>' +
      (l.review ? '<button class="al-sb-btn" data-act="sel-review"' + dis + ' title="أعدها للمراجعة الآن من البداية">↺ للمراجعة</button>' : '') +
      '<button class="al-sb-btn danger" data-act="sel-remove"' + dis + ' title="أزلها من هذه القائمة">🗑 إزالة</button>' +
    '</div>';
  }
  function undoHtml() {
    if (!ui.undo || ui.undo.until < Date.now()) { ui.undo = null; return ''; }
    return '<div class="al-undo" role="status"><span>' + esc(ui.undo.text) + '</span><button data-act="undo">↶ تراجع</button></div>';
  }
  function offerUndo(text, run) {
    ui.undo = { text: text, run: run, until: Date.now() + 8000 };
    clearTimeout(ui.undoTimer);
    ui.undoTimer = setTimeout(function () { ui.undo = null; var u = modal && modal.querySelector('.al-undo'); if (u) u.remove(); }, 8000);
  }
  // the bar and the cards follow a click without redrawing the list (keeps the scroll)
  function paintSel(l) {
    var main = modal.querySelector('.al-main');
    main.querySelectorAll('.al-card').forEach(function (c) {
      var on = !!(ui.sel && ui.sel.keys[c.getAttribute('data-k')]);
      c.classList.toggle('picked', on); c.setAttribute('aria-checked', String(on));
    });
    var bar = main.querySelector('.al-selbar');
    if (bar) { var tmp = el('div', null, selBarHtml(l, itemsView(l))); bar.replaceWith(tmp.firstChild); }
  }
  function toggleKey(l, key, range) {
    if (!ui.sel) ui.sel = { keys: {}, last: null };
    var view = itemsView(l).map(function (x) { return k(x.s, x.a); });
    if (range && ui.sel.last && view.indexOf(ui.sel.last) >= 0) {          // Shift: everything between
      var i = view.indexOf(ui.sel.last), j = view.indexOf(key), on = !ui.sel.keys[key];
      view.slice(Math.min(i, j), Math.max(i, j) + 1).forEach(function (x) { if (on) ui.sel.keys[x] = 1; else delete ui.sel.keys[x]; });
    } else if (ui.sel.keys[key]) delete ui.sel.keys[key]; else ui.sel.keys[key] = 1;
    ui.sel.last = key;
    paintSel(l);
  }
  function itemsOf(l, keys) { return l.items.filter(function (x) { return keys.indexOf(k(x.s, x.a)) >= 0; }); }
  function plural(n) { return n === 1 ? 'آية' : n === 2 ? 'آيتان' : n <= 10 ? n + ' آيات' : n + ' آية'; }

  // move / copy: a picker of the other lists, with its own search and «＋ أنشئ»
  function openPicker(l, mode, anchor) {
    var keys = selKeys(); if (!keys.length) return;
    closeSaver();
    pop = el('div', 'al-pop al-picker'); pop.setAttribute('dir', 'rtl'); pop.setAttribute('role', 'dialog');
    pop.innerHTML = '<div class="al-pop-head"><span class="al-pop-title">' + (mode === 'move' ? '↪ نقل ' : '⧉ نسخ ') + plural(keys.length) + ' إلى…</span>' +
      '<button class="al-x" data-act="close" title="إغلاق">✕</button></div>' +
      '<input class="al-pick-q" type="search" autocomplete="off" placeholder="🔍 ابحث عن قائمة أو اكتب اسمًا جديدًا">' +
      '<div class="al-pop-lists"></div>';
    var box = pop.querySelector('.al-pop-lists'), q = pop.querySelector('.al-pick-q');
    function rows() {
      var raw = q.value.trim(), key = nameKey(raw), exact = raw && nameTaken(raw);
      var others = sortedLists().filter(function (x) { return x.id !== l.id && (!key || nameKey(x.name + ' ' + (x.desc || '')).indexOf(key) >= 0); });
      box.innerHTML = others.map(function (x) {
        var have = keys.filter(function (kk) { var p = kk.split(':'); return hasItem(x, +p[0], +p[1]); }).length;
        return '<button class="al-pop-row al-pick-row" data-to="' + esc(x.id) + '" style="--lc:' + esc(x.color) + '">' +
          '<span class="al-dot">' + iconHtml(x.icon) + '</span><span class="al-pop-name">' + esc(x.name) + '</span>' +
          (have ? '<span class="al-pick-have" title="موجودة فيها من قبل">' + (have === keys.length ? 'كلها فيها' : have + ' فيها') + '</span>' : '') +
          '<span class="al-pop-count">' + x.items.length + '</span></button>';
      }).join('') +
      (raw && !exact ? '<button class="al-pop-row al-pick-new" data-new="1"><span class="al-dot">＋</span><span class="al-pop-name">قائمة جديدة «' + esc(raw) + '»</span></button>' : '') +
      (!others.length && !raw ? '<div class="al-ic-none">لا قوائم أخرى — اكتب اسمًا لإنشاء واحدة</div>' : '');
    }
    rows();
    document.body.appendChild(pop); placePop(anchor);
    setTimeout(function () { document.addEventListener('mousedown', outsideSaver, true); q.focus(); }, 0);
    q.addEventListener('input', rows);
    q.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var first = box.querySelector('[data-to], [data-new]'); if (first) first.click();
    });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('[data-to], [data-new], [data-act=close]'); if (!b) return;
      if (b.getAttribute('data-act') === 'close') { closeSaver(); return; }
      var to;
      if (b.hasAttribute('data-new')) {
        to = newList({ name: q.value.trim().replace(/\s+/g, ' '), icon: ICONS[(st.lists.length + 2) % ICONS.length], color: COLORS[(st.lists.length * 5) % COLORS.length] });
        st.lists.push(to);
      } else to = listById(b.getAttribute('data-to'));
      closeSaver();
      if (to) transfer(l, to, keys, mode);
    });
  }

  function transfer(from, to, keys, mode) {
    var now = Date.now(), maxO = to.items.reduce(function (m, it) { return Math.max(m, it.order || 0); }, 0);
    var src = itemsOf(from, keys), addedKeys = [], had = 0;
    src.forEach(function (it) {
      if (hasItem(to, it.s, it.a)) { had++; return; }
      // a move keeps the ayah's review progress; a copy starts it fresh in the new list
      to.items.push(mode === 'move' ? Object.assign({}, it, { order: ++maxO })
        : { s: it.s, a: it.a, added: now, order: ++maxO, lvl: 0, next: now });
      addedKeys.push(k(it.s, it.a));
    });
    if (mode === 'move') from.items = from.items.filter(function (x) { return keys.indexOf(k(x.s, x.a)) < 0; });
    st.lastIds = [to.id].concat(st.lastIds.filter(function (x) { return x !== to.id; })).slice(0, 5);
    ui.sel = null; save();
    var verb = mode === 'move' ? 'نُقلت ' : 'نُسخت ';
    var msg = verb + plural(src.length) + ' إلى «' + to.name + '»' + (had ? ' (' + had + ' كانت فيها)' : '');
    offerUndo(msg, function () {
      to.items = to.items.filter(function (x) { return addedKeys.indexOf(k(x.s, x.a)) < 0; });
      if (mode === 'move') src.forEach(function (it) { if (!hasItem(from, it.s, it.a)) from.items.push(it); });
      if (!to.items.length && nameKey(to.name) && st.lists.indexOf(to) >= 0 && to.created > now - 1000) st.lists = st.lists.filter(function (x) { return x !== to; });
    });
    renderModal(); paintSaveButtons();
  }

  function removeSelected(l) {
    var keys = selKeys(), gone = itemsOf(l, keys);
    if (!gone.length) return;
    if (gone.length > 1 && !confirm('إزالة ' + plural(gone.length) + ' من «' + l.name + '»؟ (يمكنك التراجع بعدها)')) return;
    l.items = l.items.filter(function (x) { return keys.indexOf(k(x.s, x.a)) < 0; });
    ui.sel = null; save();
    offerUndo('أُزيلت ' + plural(gone.length) + ' من «' + l.name + '»', function () {
      gone.forEach(function (it) { if (!hasItem(l, it.s, it.a)) l.items.push(it); });
    });
    renderModal(); paintSaveButtons();
  }

  function wireMain(l) {
    var main = modal.querySelector('.al-main');
    // a long press on a card starts «تحديد» with that ayah picked (the phone's way in)
    var lp = null;
    main.onpointerdown = function (e) {
      var c = e.target.closest('.al-card');
      if (!c || ui.sel || e.target.closest('button, textarea, input, select, a') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      var x0 = e.clientX, y0 = e.clientY;
      lp = { t: setTimeout(function () { lp = { fired: true }; ui.sel = { keys: {}, last: null }; ui.sel.keys[c.getAttribute('data-k')] = 1; ui.sel.last = c.getAttribute('data-k'); renderMain(); if (navigator.vibrate) navigator.vibrate(15); }, 480),
        x: x0, y: y0 };
    };
    main.onpointermove = function (e) { if (lp && lp.t && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) { clearTimeout(lp.t); lp = null; } };
    main.onpointerup = main.onpointercancel = function () { if (lp && lp.t) { clearTimeout(lp.t); lp = null; } };
    main.onclick = function (e) {
      var b;
      if (lp && lp.fired) { lp = null; return; }         // the click that ends the long press
      if (ui.sel && !e.target.closest('[data-act], .al-main-top')) {
        var pc = e.target.closest('.al-card');
        if (pc) { e.preventDefault(); toggleKey(l, pc.getAttribute('data-k'), e.shiftKey); }
        return;
      }
      if ((b = e.target.closest('[data-act]'))) {
        var act = b.getAttribute('data-act');
        if (act === 'select') { ui.sel = ui.sel ? null : { keys: {}, last: null }; renderMain(); return; }
        if (act === 'sel-close') { ui.sel = null; renderMain(); return; }
        if (act === 'sel-all') {
          var view = itemsView(l).map(function (x) { return k(x.s, x.a); });
          var allOn = view.every(function (x) { return ui.sel.keys[x]; });
          view.forEach(function (x) { if (allOn) delete ui.sel.keys[x]; else ui.sel.keys[x] = 1; });
          paintSel(l); return;
        }
        if (act === 'sel-move' || act === 'sel-copy') { openPicker(l, act === 'sel-move' ? 'move' : 'copy', b); return; }
        if (act === 'sel-text') { copyList(l, selKeys()); return; }
        if (act === 'sel-review') {
          var rk = itemsOf(l, selKeys());
          rk.forEach(function (it) { it.lvl = 0; it.next = Date.now(); });
          ui.sel = null; save(); renderModal(); toast('عادت ' + plural(rk.length) + ' للمراجعة الآن'); return;
        }
        if (act === 'sel-remove') { removeSelected(l); return; }
        if (act === 'undo') { if (ui.undo) { var run = ui.undo.run; ui.undo = null; run(); save(); renderModal(); paintSaveButtons(); toast('تم التراجع'); } return; }
        if (act === 'edit') {
          ui.editing = 'edit';
          ui.form = { name: l.name, desc: l.desc || '', icon: l.icon, color: l.color, review: !!l.review, cat: 'all', q: '' };
          renderModal();
        }
        if (act === 'copy') copyList(l);
        if (act === 'delete') {
          if (confirm('حذف القائمة «' + l.name + '» (' + l.items.length + ' آية)؟ الملاحظات على الآيات تبقى.')) {
            st.lists = st.lists.filter(function (x) { return x.id !== l.id; });
            st.activeId = st.lists.length ? sortedLists()[0].id : null; save(); renderModal(); toast('حُذفت القائمة');
          }
        }
        return;
      }
      if ((b = e.target.closest('[data-toggle]'))) {
        var p = b.getAttribute('data-toggle'); l[p] = !l[p];
        if (p === 'review') { if (l.review) l.sort = 'due'; else if (l.sort === 'due') l.sort = 'added_desc'; if (!l.review && ui.filter === 'due') ui.filter = 'all'; }
        if (p === 'quiz') ui.revealed = {};
        save(); renderModal(); return;
      }
      if ((b = e.target.closest('[data-filter]'))) { ui.filter = b.getAttribute('data-filter'); renderMain(); return; }
      var cardEl = e.target.closest('.al-card'); if (!cardEl) return;
      var s = +cardEl.getAttribute('data-s'), a = +cardEl.getAttribute('data-a'), it = l.items.filter(function (x) { return x.s === s && x.a === a; })[0];
      if (e.target.closest('.al-text.quiz')) { ui.revealed[k(s, a)] = true; renderMain(); return; }
      if ((b = e.target.closest('[data-move]'))) { moveItem(l, it, +b.getAttribute('data-move')); return; }
      if ((b = e.target.closest('[data-rev]'))) {
        if (b.getAttribute('data-rev') === 'ok') { it.lvl = Math.min((it.lvl || 0) + 1, REVIEW_DAYS.length); it.next = Date.now() + REVIEW_DAYS[it.lvl - 1] * DAY; toast('أحسنت! تعود للمراجعة ' + ago(it.next)); }
        else { it.lvl = 0; it.next = Date.now() + 4 * 3600000; toast('تعود للمراجعة بعد 4 ساعات'); }
        it.reviewed = Date.now(); save(); renderModal(); return;
      }
      if ((b = e.target.closest('[data-do]'))) {
        var d = b.getAttribute('data-do'), r = ayahRow(s, a);
        if (d === 'go') { close(); var sr = g('selectResult'); if (typeof sr === 'function' && r) sr(r[2], s, a, r[3]); }
        if (d === 'tafsir') { close(); var ot = g('openAyahTafsir'); if (typeof ot === 'function') ot(s, a); }
        if (d === 'play') togglePlay(s, a);
        if (d === 'save') openSaver(s, a, b);
        if (d === 'remove') { removeItem(l, s, a); toast('أُزيلت من «' + l.name + '»'); renderModal(); }
      }
    };
    var srch = main.querySelector('.al-search');
    if (srch) srch.oninput = function () {
      ui.q = srch.value; var pos = srch.selectionStart; renderMain();
      var s2 = modal.querySelector('.al-search'); if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (x) {} }
    };
    var sel = main.querySelector('select[data-prop=sort]');
    if (sel) sel.onchange = function () { l.sort = sel.value; save(); renderMain(); };
    main.querySelectorAll('.al-note textarea').forEach(function (ta) {
      var c = ta.closest('.al-card'), s = +c.getAttribute('data-s'), a = +c.getAttribute('data-a'), t = 0;
      fit(ta);
      ta.addEventListener('input', function () { fit(ta); clearTimeout(t); t = setTimeout(function () { setNoteQuiet(s, a, ta.value); ta.parentNode.classList.toggle('has', !!ta.value.trim()); }, 400); });
      ta.addEventListener('blur', function () { setNoteQuiet(s, a, ta.value); });
    });
  }
  function fit(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; }
  function setNoteQuiet(s, a, text) {   // from inside the modal: no re-render (keeps the caret)
    text = String(text || '').trim(); var key = k(s, a);
    if (((st.notes[key] || {}).text || '') === text) return;
    if (text) st.notes[key] = { text: text, updated: Date.now() }; else delete st.notes[key];
    save();
    var box = document.getElementById('ayahListsInfo');
    if (box && +box.getAttribute('data-s') === s && +box.getAttribute('data-a') === a) renderAyahInfo(s, a);
  }

  function moveItem(l, it, dir) {
    var arr = l.items.slice().sort(function (x, y) { return (x.order || 0) - (y.order || 0); });
    var i = arr.indexOf(it), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i].order; arr[i].order = arr[j].order; arr[j].order = t;
    if (arr[i].order === arr[j].order) arr.forEach(function (x, n) { x.order = n + 1; });
    save(); renderMain();
  }

  /* ------------- the list studio: create (a draft) or edit, with a live preview ------------- */
  function renderStudio(main, l) {
    var f = ui.form, isNew = !l, I = window.AL_ICONS || { cats: [], icons: {} };
    var tpls = isNew ? TEMPLATES.filter(function (t) { return !nameTaken(t[0]); }) : [];
    main.innerHTML =
      '<div class="al-studio" style="--lc:' + esc(f.color) + '">' +
        '<div class="al-studio-top">' +
          '<div class="al-studio-title">' + (isNew ? 'قائمة جديدة' : 'تعديل القائمة') + '</div>' +
          '<div class="al-preview" aria-label="معاينة">' +
            '<div class="al-pv-tile">' + iconHtml(f.icon) + '</div>' +
            '<div class="al-pv-txt"><div class="al-pv-name"></div><div class="al-pv-desc"></div>' +
              '<div class="al-pv-meta">' + (isNew ? '0 آية' : l.items.length + ' آية') + '<span class="al-pv-rev"> · 🧠 مراجعة متباعدة</span></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="al-studio-body">' +
          '<label class="al-field"><span>اسم القائمة</span>' +
            '<input class="al-in-name" maxlength="40" autocomplete="off" placeholder="مثال: آيات الصبر، مراجعة جزء عمّ"></label>' +
          '<div class="al-err" role="alert"></div>' +
          '<label class="al-field"><span>وصف قصير <small>(اختياري)</small></span>' +
            '<input class="al-in-desc" maxlength="120" autocomplete="off" placeholder="ما الذي تجمعه هذه القائمة؟"></label>' +
          (tpls.length ? '<div class="al-field"><span>أفكار جاهزة <small>— اضغط لتعبئة الاسم والأيقونة واللون</small></span><div class="al-templates">' +
            tpls.map(function (t) { return '<button type="button" class="al-tpl" data-tpl="' + esc(t[0]) + '" style="--lc:' + t[2] + '">' + iconHtml(t[1]) + '<span>' + esc(t[0]) + '</span></button>'; }).join('') +
            '</div></div>' : '') +
          '<div class="al-field"><span>الأيقونة</span>' +
            '<div class="al-ic-tools"><div class="al-ic-cats" role="tablist">' +
              [['all', 'الكل']].concat(I.cats).map(function (c) {
                return '<button type="button" data-cat="' + c[0] + '"' + (f.cat === c[0] ? ' class="on"' : '') + '>' + esc(c[1]) + '</button>'; }).join('') +
              '</div><input class="al-ic-search" type="search" autocomplete="off" placeholder="ابحث: صبر، دعاء، ليل، حفظ…"></div>' +
            '<div class="al-icons" role="listbox" aria-label="الأيقونات"></div>' +
            '<label class="al-emoji-in"><span>أو اكتب رمزًا تعبيريًا:</span><input class="al-in-emoji" maxlength="8" placeholder="🌷"></label>' +
          '</div>' +
          '<div class="al-field"><span>اللون</span><div class="al-colors">' +
            COLORS.map(function (c) { return '<button type="button" data-color="' + c + '" style="--c:' + c + '" title="' + c + '"></button>'; }).join('') +
            '<label class="al-color-custom" title="لون من اختيارك"><input type="color"><span aria-hidden="true">＋</span></label>' +
          '</div></div>' +
          '<label class="al-check"><input type="checkbox" class="al-in-review"> 🧠 مراجعة متباعدة <small>تعود كل آية للمراجعة بعد 1، 3، 7، 14، 30، 60 يومًا</small></label>' +
        '</div>' +
        '<div class="al-studio-foot"><button type="button" class="al-btn ghost" data-st="cancel">إلغاء</button>' +
          '<button type="button" class="al-btn gold" data-st="save">' + (isNew ? '✓ إنشاء القائمة' : '✓ حفظ التعديلات') + '</button></div>' +
      '</div>';
    // values go in through the DOM, never through markup
    main.querySelector('.al-in-name').value = f.name;
    main.querySelector('.al-in-desc').value = f.desc;
    main.querySelector('.al-ic-search').value = f.q;
    main.querySelector('.al-in-emoji').value = iconDef(f.icon) ? '' : f.icon;
    main.querySelector('.al-in-review').checked = !!f.review;
    main.querySelector('.al-color-custom input').value = /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#c9a227';
    paintIcons(main); paintPreview(main, l); wireStudio(main, l);
  }

  function paintIcons(main) {
    var f = ui.form, I = window.AL_ICONS || { icons: {} }, q = nameKey(f.q);
    var ids = Object.keys(I.icons).filter(function (id) {
      var d = I.icons[id];
      if (q) return nameKey(d.k).indexOf(q) >= 0 || id.indexOf(q) >= 0;
      return f.cat === 'all' || d.c === f.cat;
    });
    var box = main.querySelector('.al-icons');
    box.innerHTML = ids.length ? ids.map(function (id) {
      return '<button type="button" role="option" data-icon="' + id + '" title="' + esc(I.icons[id].k.split(' ')[0]) + '"' +
        (id === f.icon ? ' class="on" aria-selected="true"' : '') + '>' + iconHtml(id) + '</button>';
    }).join('') : '<div class="al-ic-none">لا أيقونة بهذا الوصف — جرّب كلمة أخرى أو اكتب رمزًا تعبيريًا</div>';
  }

  function paintPreview(main, l) {
    var f = ui.form, studio = main.querySelector('.al-studio');
    studio.style.setProperty('--lc', f.color);
    main.querySelector('.al-pv-tile').innerHTML = iconHtml(f.icon);
    main.querySelector('.al-pv-name').textContent = f.name.trim() || 'اسم القائمة';
    main.querySelector('.al-pv-name').classList.toggle('ph', !f.name.trim());
    main.querySelector('.al-pv-desc').textContent = f.desc.trim() || 'وصف قصير يظهر تحت الاسم';
    main.querySelector('.al-pv-desc').classList.toggle('ph', !f.desc.trim());
    main.querySelector('.al-pv-rev').style.display = f.review ? '' : 'none';
    main.querySelectorAll('[data-color]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-color').toLowerCase() === f.color.toLowerCase()); });
    main.querySelector('.al-color-custom').classList.toggle('on', COLORS.indexOf(f.color) < 0);
    // the name must be new: «آيات الصبر» twice is one list
    var name = f.name.trim(), same = name && nameTaken(name, l && l.id), err = main.querySelector('.al-err');
    err.textContent = same ? 'توجد قائمة بهذا الاسم: «' + same.name + '» — اختر اسمًا آخر.' : '';
    main.querySelector('[data-st=save]').disabled = !name || !!same;
    var draft = modal && modal.querySelector('.al-draft');   // the draft row in the side list follows along
    if (draft) {
      draft.style.setProperty('--lc', f.color);
      draft.querySelector('.al-dot').innerHTML = iconHtml(f.icon);
      draft.querySelector('.al-side-name').textContent = name || 'قائمة جديدة…';
    }
  }

  function wireStudio(main, l) {
    var f = ui.form;
    main.querySelector('.al-in-name').addEventListener('input', function () { f.name = this.value; paintPreview(main, l); });
    main.querySelector('.al-in-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveStudio(main, l); } });
    main.querySelector('.al-in-desc').addEventListener('input', function () { f.desc = this.value; paintPreview(main, l); });
    main.querySelector('.al-ic-search').addEventListener('input', function () { f.q = this.value; paintIcons(main); });
    main.querySelector('.al-in-emoji').addEventListener('input', function () {
      var v = this.value.trim();
      if (v) { f.icon = v; } else if (!iconDef(f.icon)) { f.icon = f.lastIcon || ICONS[0]; }
      paintIcons(main); paintPreview(main, l);
    });
    main.querySelector('.al-in-review').addEventListener('change', function () { f.review = this.checked; paintPreview(main, l); });
    main.querySelector('.al-color-custom input').addEventListener('input', function () { f.color = this.value; paintPreview(main, l); });
    main.onclick = function (e) {
      var b;
      if ((b = e.target.closest('[data-icon]'))) {
        f.icon = f.lastIcon = b.getAttribute('data-icon'); main.querySelector('.al-in-emoji').value = '';
        main.querySelectorAll('[data-icon]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); });
        paintPreview(main, l); return;
      }
      if ((b = e.target.closest('[data-cat]'))) {
        f.cat = b.getAttribute('data-cat'); f.q = ''; main.querySelector('.al-ic-search').value = '';
        main.querySelectorAll('[data-cat]').forEach(function (x) { x.classList.toggle('on', x === b); });
        paintIcons(main); return;
      }
      if ((b = e.target.closest('[data-color]'))) { f.color = b.getAttribute('data-color'); paintPreview(main, l); return; }
      if ((b = e.target.closest('[data-tpl]'))) {
        var t = TEMPLATES.filter(function (x) { return x[0] === b.getAttribute('data-tpl'); })[0];
        if (t) { f.name = t[0]; f.icon = f.lastIcon = t[1]; f.color = t[2]; f.desc = t[3] || ''; f.review = !!t[4]; renderStudio(main, l); renderSide(); }
        return;
      }
      if ((b = e.target.closest('[data-st]'))) {
        if (b.getAttribute('data-st') === 'save') saveStudio(main, l);
        else { ui.editing = null; ui.form = null; renderModal(); }
      }
    };
  }

  function saveStudio(main, l) {
    var f = ui.form, name = f.name.trim().replace(/\s+/g, ' ');
    if (!name) { main.querySelector('.al-in-name').focus(); return; }
    if (nameTaken(name, l && l.id)) { paintPreview(main, l); main.querySelector('.al-in-name').focus(); return; }
    var fields = { name: name, desc: f.desc.trim(), icon: f.icon || ICONS[0], color: f.color };
    if (!l) {
      var nl = newList(Object.assign(fields, { review: !!f.review, sort: f.review ? 'due' : 'added_desc' }));
      st.lists.push(nl); st.activeId = nl.id;
      toast('أُنشئت قائمة «' + name + '»');
    } else {
      Object.assign(l, fields);
      if (!!f.review !== !!l.review) { l.review = !!f.review; if (l.review) l.sort = 'due'; else if (l.sort === 'due') l.sort = 'added_desc'; }
      toast('حُفظت التعديلات');
    }
    ui.editing = null; ui.form = null; save(); renderModal();
  }

  /* ----------------------------- audio ------------------------------- */
  function stopAudio() { if (ui.audio) { try { ui.audio.pause(); } catch (e) {} } ui.audio = null; ui.playing = null; }
  function togglePlay(s, a) {
    var key = k(s, a);
    if (ui.playing === key) { stopAudio(); renderMain(); return; }
    stopAudio();
    var f = g('getAyahAudioUrl'); if (typeof f !== 'function') { toast('التلاوة الصوتية غير متاحة'); return; }
    var main = g('quranAudio'); if (main && !main.paused) { try { main.pause(); } catch (e) {} }   // one recitation at a time
    ui.audio = new Audio(f(s, a)); ui.playing = key;
    ui.audio.onended = function () { stopAudio(); if (modal) renderMain(); };
    ui.audio.onerror = function () { stopAudio(); toast('تعذّر تشغيل التلاوة (تحتاج اتصالًا بالإنترنت)'); if (modal) renderMain(); };
    ui.audio.play().catch(function () {});
    renderMain();
  }

  /* -------------------------- copy / backup -------------------------- */
  function copyList(l, onlyKeys) {   // onlyKeys: the picked ayahs of «تحديد»
    var lines = [iconText(l.icon) + ' ' + l.name + (l.desc ? ' — ' + l.desc : ''), ''];
    itemsView(l).filter(function (x) { return !onlyKeys || onlyKeys.indexOf(k(x.s, x.a)) >= 0; }).forEach(function (x) {
      var r = ayahRow(x.s, x.a); if (!r) return;
      lines.push('﴿' + ayahText(x.s, x.a) + '﴾ [' + r[3] + ': ' + x.a + ']');
      var n = (st.notes[k(x.s, x.a)] || {}).text; if (n) lines.push('📝 ' + n);
      lines.push('');
    });
    var txt = lines.join('\n');
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { toast('نُسخت القائمة كنص'); }, function () { prompt('انسخ النص:', txt); });
  }
  function exportAll() {
    var blob = new Blob([JSON.stringify({ app: 'quran-mushaf', type: 'ayah-lists', v: 1, exported: new Date().toISOString(), lists: st.lists, notes: st.notes }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'قوائمي-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('صُدّرت ' + st.lists.length + ' قوائم');
  }
  function importAll() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      f.text().then(function (t) {
        var d = JSON.parse(t);
        if (!d || d.type !== 'ayah-lists' || !Array.isArray(d.lists)) throw new Error('bad');
        var added = 0;
        var clean = function (it, n) {   // a backup may come from an older version: give every field a value
          var now = Date.now();
          return Object.assign({}, it, { s: +it.s, a: +it.a, added: isFinite(it.added) ? +it.added : now, order: isFinite(it.order) ? +it.order : n + 1,
            lvl: Math.max(0, Math.min(6, it.lvl | 0)), next: isFinite(it.next) ? +it.next : now });
        };
        d.lists.forEach(function (nl) {
          if (!nl || !Array.isArray(nl.items) || !String(nl.name || '').trim()) return;
          var cur = listById(nl.id) || nameTaken(nl.name);   // same id or same name = same list
          var items = nl.items.filter(function (it) { return it && +it.s > 0 && +it.a > 0; });
          if (!cur) {
            var fresh = newList(Object.assign({}, nl, { icon: EMOJI_TO_ICON[nl.icon] || nl.icon || 'bookmark', items: [] }));
            if (listById(fresh.id)) fresh.id = uid();
            items.forEach(function (it, n) { if (!hasItem(fresh, +it.s, +it.a)) fresh.items.push(clean(it, n)); });
            st.lists.push(fresh); added++; return;
          }
          var maxO = cur.items.reduce(function (m, it) { return Math.max(m, it.order || 0); }, 0);
          items.forEach(function (it, n) { if (!hasItem(cur, +it.s, +it.a)) cur.items.push(clean(it, maxO + n)); });
        });
        Object.keys(d.notes || {}).forEach(function (key) { if (!st.notes[key]) st.notes[key] = d.notes[key]; });
        save(); renderModal(); toast('استُوردت القوائم (' + added + ' جديدة، والباقي دُمج)');
      }).catch(function () { toast('الملف ليس نسخة قوائم صالحة'); });
    };
    inp.click();
  }

  /* ---------------------------- wiring ------------------------------- */
  function currentReciteAyah() {
    var R = window.ReciteByMic, m = R && R.lastShown;
    return m && m.bestAyah ? { s: m.bestAyah.sura, a: m.bestAyah.aya } : null;
  }
  function init() {
    load();
    var hb = document.getElementById('ayahListsBtn'); if (hb) hb.addEventListener('click', open);
    var tb = document.getElementById('tafsirSaveListBtn');
    if (tb) tb.addEventListener('click', function () {
      var box = document.getElementById('ayahListsInfo');
      if (box && box.getAttribute('data-s')) openSaver(+box.getAttribute('data-s'), +box.getAttribute('data-a'), tb);
    });
    var db = document.getElementById('dockSaveAyahBtn');
    if (db) db.addEventListener('click', function () {
      var c = currentReciteAyah();
      if (!c) { toast('ابدأ التسميع أولًا: تُحفظ الآية التي تُتلى الآن'); return; }
      openSaver(c.s, c.a, db);
    });
    document.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (pop) { closeSaver(); e.stopPropagation(); return; }
        if (modal) {                                   // one step back at a time
          e.stopPropagation();
          if (t && t.matches && t.matches('.al-side-search input') && t.value) { t.value = ''; ui.lq = ''; filterSide(modal.querySelector('.al-side')); return; }
          if (ui.sel) { ui.sel = null; renderMain(); return; }
          close(); return;
        }
      }
      if (modal && ui.sel && !typing && (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A' || e.key === 'ش')) {
        e.preventDefault();
        var cur = listById(st.activeId);
        if (cur) { itemsView(cur).forEach(function (x) { ui.sel.keys[k(x.s, x.a)] = 1; }); paintSel(cur); }
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'b' || e.key === 'B' || e.key === 'لا') {
        var h = g('currentHighlightedAyah') || null, c = currentReciteAyah();
        var target = h ? { s: h.sura, a: h.aya } : c;
        if (target) { e.preventDefault(); openSaver(target.s, target.a, null); }
        else toast('ظلّل آية أولًا (انقر عليها في المصحف) ثم اضغط B');
      }
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.AyahLists = { open: open, close: close, openSaver: openSaver, stopAudio: function () { if (ui.audio) { stopAudio(); if (modal) renderMain(); } }, renderAyahInfo: function (s, a) { renderAyahInfo(s, a); paintSaveButtons(); },
    _state: function () { return load(); },
    // وضع التسميع results: into «أخطاء التسميع» (made again if deleted); an ayah
    // already there goes back to the start of its review
    addMistakes: function (items) {
      load();
      // by its kind, so renaming the list does not make a second one appear
      var l = st.lists.filter(function (x) { return x.kind === 'mistakes'; })[0] || nameTaken('أخطاء التسميع');
      if (!l) { l = mistakesList(); l.name = uniqueName(l.name); st.lists.push(l); }
      l.kind = 'mistakes';
      var added = 0;
      (items || []).forEach(function (it) {
        if (addItem(l, +it.s, +it.a)) added++;
        else l.items.forEach(function (x) { if (x.s === +it.s && x.a === +it.a) { x.lvl = 0; x.next = Date.now(); } });
      });
      save(); paintSaveButtons();
      return added;
    } };
})();
