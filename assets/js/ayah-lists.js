/* Ayah lists ("قوائمي"): save ayahs into named lists, notes per ayah,
 * per-list properties (sort, group by surah, spaced review, quiz mode, pin,
 * icon, colour), export/import. Stored in this browser (localStorage).
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
  var ICONS = ['⭐', '🔖', '📌', '💚', '🌙', '🕋', '📿', '🤲', '🎯', '🧠', '🎙️', '📖', '✨', '🌿', '🔥', '💎'];
  var COLORS = ['#c9a227', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#f97316', '#14b8a6', '#ec4899'];
  var SORTS = [
    ['added_desc', 'الأحدث إضافة'], ['added_asc', 'الأقدم إضافة'],
    ['mushaf', 'ترتيب المصحف'], ['manual', 'ترتيب يدوي'], ['due', 'الأقرب للمراجعة']
  ];
  var DAY = 86400000;

  /* ------------------------------ store ------------------------------ */
  var st = null;
  function uid() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function newList(o) {
    return Object.assign({ id: uid(), name: 'قائمة جديدة', icon: '🔖', color: COLORS[0], desc: '',
      sort: 'added_desc', group: false, review: false, quiz: false, pinned: false, created: Date.now(), items: [] }, o || {});
  }
  function load() {
    if (st) return st;
    try { st = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { st = null; }
    if (!st || !Array.isArray(st.lists)) {
      st = { v: 1, lists: [], notes: {}, activeId: null, lastIds: [] };
      st.lists.push(newList({ name: 'المفضلة', icon: '⭐', color: COLORS[0], desc: 'آيات أحبها وأعود إليها' }));
      st.lists.push(newList({ name: 'أخطاء التسميع', icon: '🎙️', color: COLORS[4], review: true, sort: 'due',
        desc: 'آيات أخطأتُ فيها أثناء التسميع — تُعرض للمراجعة على فترات متباعدة' }));
      st.activeId = st.lists[0].id;
      save();
    }
    st.notes = st.notes || {};
    st.lastIds = st.lastIds || [];
    return st;
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
      '<div class="al-pop-lists">' + lists.map(function (l) {
        var on = hasItem(l, s, a);
        return '<label class="al-pop-row' + (on ? ' on' : '') + '" style="--lc:' + esc(l.color) + '">' +
          '<input type="checkbox" data-list="' + esc(l.id) + '"' + (on ? ' checked' : '') + '>' +
          '<span class="al-dot">' + esc(l.icon) + '</span><span class="al-pop-name">' + esc(l.name) + '</span>' +
          '<span class="al-pop-count">' + l.items.length + '</span></label>';
      }).join('') + '</div>' +
      '<form class="al-pop-new" data-act="new"><input type="text" maxlength="40" placeholder="＋ قائمة جديدة… (اكتب الاسم ثم Enter)"></form>' +
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
    pop.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = this.querySelector('input').value.trim();
      if (!name) return;
      var l = newList({ name: name, icon: ICONS[(st.lists.length + 2) % ICONS.length], color: COLORS[st.lists.length % COLORS.length] });
      st.lists.push(l); addItem(l, s, a);
      toast('أُنشئت «' + name + '» وأُضيفت الآية إليها');
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
      return '<button class="al-chip" style="--lc:' + esc(l.color) + '" data-open="' + esc(l.id) + '">' + esc(l.icon) + ' ' + esc(l.name) + '</button>';
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
  var modal = null, ui = { q: '', filter: 'all', editing: null, audio: null, playing: null, revealed: {} };

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
    ui.editing = null; ui.q = ''; ui.filter = 'all'; ui.revealed = {};
    renderModal();
    var m0 = modal; requestAnimationFrame(function () { if (m0 === modal) m0.classList.add('show'); });   // closed meanwhile: nothing
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
      '<div class="al-side-lists">' + lists.map(function (l) {
        var due = l.review ? l.items.filter(isDue).length : 0;
        return '<button class="al-side-item' + (l.id === st.activeId ? ' active' : '') + '" data-pick="' + esc(l.id) + '" style="--lc:' + esc(l.color) + '">' +
          '<span class="al-dot">' + esc(l.icon) + '</span>' +
          '<span class="al-side-name">' + esc(l.name) + (l.pinned ? ' <i class="al-pin">📌</i>' : '') + '</span>' +
          (due ? '<span class="al-due" title="مستحقة للمراجعة">' + due + '</span>' : '') +
          '<span class="al-count">' + l.items.length + '</span></button>';
      }).join('') + '</div>' +
      '<button class="al-new" data-act="new">＋ قائمة جديدة</button>' +
      '<div class="al-side-foot"><button class="al-link" data-act="export" title="نسخة احتياطية لكل القوائم والملاحظات">⬇ تصدير</button>' +
      '<button class="al-link" data-act="import" title="استيراد نسخة احتياطية (تُدمج مع الموجود)">⬆ استيراد</button></div>';
    side.querySelectorAll('[data-pick]').forEach(function (b) {
      b.onclick = function () { st.activeId = b.getAttribute('data-pick'); ui.editing = null; ui.q = ''; ui.filter = 'all'; ui.revealed = {}; save(); renderModal(); };
    });
    side.onclick = function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'close') close();
      if (act === 'new') { var l = newList({ icon: ICONS[(st.lists.length + 2) % ICONS.length], color: COLORS[st.lists.length % COLORS.length] }); st.lists.push(l); st.activeId = l.id; ui.editing = 'new'; save(); renderModal(); }
      if (act === 'export') exportAll();
      if (act === 'import') importAll();
    };
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
    if (!l) { main.innerHTML = '<div class="al-empty"><div>📚</div><h3>لا توجد قوائم بعد</h3><p>أنشئ قائمة من الشريط الجانبي.</p></div>'; return; }
    var items = itemsView(l);
    var suras = {}, pages = {};
    l.items.forEach(function (x) { suras[x.s] = 1; var r = ayahRow(x.s, x.a); if (r) pages[r[2]] = 1; });
    var due = l.items.filter(isDue).length;

    var head = ui.editing ? editForm(l) :
      '<div class="al-head" style="--lc:' + esc(l.color) + '">' +
        '<div class="al-head-icon">' + esc(l.icon) + '</div>' +
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
        '<div class="al-seg">' + seg('all', 'الكل') + seg('notes', 'بملاحظات') + (l.review ? seg('due', 'مستحقة الآن') : '') + '</div></div>';

    var body;
    if (!l.items.length) {
      body = '<div class="al-empty"><div>' + esc(l.icon) + '</div><h3>القائمة فارغة</h3>' +
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
    main.innerHTML = '<div class="al-main-top">' + head + (ui.editing ? '' : props) + '</div>' + body;
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
    return '<article class="al-card" data-s="' + x.s + '" data-a="' + x.a + '" style="--lc:' + esc(l.color) + '">' +
      '<div class="al-card-head"><span class="al-ref">سورة ' + esc(r[3]) + ' <b>' + x.a + '</b></span><span class="al-page">ص ' + r[2] + '</span>' +
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

  function wireMain(l) {
    var main = modal.querySelector('.al-main');
    main.onclick = function (e) {
      var b;
      if ((b = e.target.closest('[data-act]'))) {
        var act = b.getAttribute('data-act');
        if (act === 'edit') { ui.editing = 'edit'; renderMain(); }
        if (act === 'copy') copyList(l);
        if (act === 'delete') {
          if (confirm('حذف القائمة «' + l.name + '» (' + l.items.length + ' آية)؟ الملاحظات على الآيات تبقى.')) {
            st.lists = st.lists.filter(function (x) { return x.id !== l.id; });
            st.activeId = st.lists.length ? sortedLists()[0].id : null; save(); renderModal(); toast('حُذفت القائمة');
          }
        }
        if (act === 'save-edit') saveEdit(l, main);
        if (act === 'cancel-edit') {
          if (ui.editing === 'new' && !l.items.length && l.name === 'قائمة جديدة') { st.lists = st.lists.filter(function (x) { return x.id !== l.id; }); st.activeId = st.lists.length ? st.lists[0].id : null; save(); }
          ui.editing = null; renderModal();
        }
        if (act === 'pick-icon') { main.querySelectorAll('[data-act=pick-icon]').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); }
        if (act === 'pick-color') { main.querySelectorAll('[data-act=pick-color]').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); }
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

  function editForm(l) {
    return '<div class="al-edit" style="--lc:' + esc(l.color) + '">' +
      '<div class="al-edit-row"><input class="al-in-name" maxlength="40" value="' + esc(ui.editing === 'new' ? '' : l.name) + '" placeholder="اسم القائمة (مثال: آيات الصبر، مراجعة جزء عمّ)">' +
      '<input class="al-in-desc" maxlength="120" value="' + esc(l.desc) + '" placeholder="وصف قصير (اختياري)"></div>' +
      '<div class="al-edit-lbl">الأيقونة</div><div class="al-icons">' + ICONS.map(function (ic) {
        return '<button data-act="pick-icon" data-v="' + ic + '" class="' + (ic === l.icon ? 'on' : '') + '">' + ic + '</button>'; }).join('') + '</div>' +
      '<div class="al-edit-lbl">اللون</div><div class="al-colors">' + COLORS.map(function (c) {
        return '<button data-act="pick-color" data-v="' + c + '" class="' + (c === l.color ? 'on' : '') + '" style="--c:' + c + '"></button>'; }).join('') + '</div>' +
      '<div class="al-edit-foot"><button class="al-btn ghost" data-act="cancel-edit">إلغاء</button><button class="al-btn gold" data-act="save-edit">حفظ</button></div></div>';
  }
  function saveEdit(l, main) {
    var name = main.querySelector('.al-in-name').value.trim();
    if (!name) { main.querySelector('.al-in-name').focus(); toast('اكتب اسمًا للقائمة'); return; }
    l.name = name; l.desc = main.querySelector('.al-in-desc').value.trim();
    var ic = main.querySelector('[data-act=pick-icon].on'), co = main.querySelector('[data-act=pick-color].on');
    if (ic) l.icon = ic.getAttribute('data-v'); if (co) l.color = co.getAttribute('data-v');
    ui.editing = null; save(); renderModal();
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
  function copyList(l) {
    var lines = [l.icon + ' ' + l.name + (l.desc ? ' — ' + l.desc : ''), ''];
    itemsView(l).forEach(function (x) {
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
        d.lists.forEach(function (nl) {
          if (!nl || !Array.isArray(nl.items)) return;
          var cur = listById(nl.id) || st.lists.filter(function (x) { return x.name === nl.name; })[0];   // same name = same list
          if (!cur) { st.lists.push(newList(nl)); added++; return; }
          nl.items.forEach(function (it) { if (it && +it.s > 0 && +it.a > 0 && !hasItem(cur, +it.s, +it.a)) cur.items.push(Object.assign({}, it, { s: +it.s, a: +it.a })); });
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
      if (e.key === 'Escape') { if (pop) { closeSaver(); e.stopPropagation(); return; } if (modal) { close(); e.stopPropagation(); return; } }
      var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
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
    // hifz test results: into «أخطاء التسميع» (made again if deleted); an ayah
    // already there goes back to the start of its review
    addMistakes: function (items) {
      load();
      var l = st.lists.filter(function (x) { return x.name === 'أخطاء التسميع'; })[0];
      if (!l) { l = newList({ name: 'أخطاء التسميع', icon: '🎙️', color: COLORS[4], review: true, sort: 'due',
        desc: 'آيات أخطأتُ فيها أثناء التسميع — تُعرض للمراجعة على فترات متباعدة' }); st.lists.push(l); }
      var added = 0;
      (items || []).forEach(function (it) {
        if (addItem(l, +it.s, +it.a)) added++;
        else l.items.forEach(function (x) { if (x.s === +it.s && x.a === +it.a) { x.lvl = 0; x.next = Date.now(); } });
      });
      save(); paintSaveButtons();
      return added;
    } };
})();
