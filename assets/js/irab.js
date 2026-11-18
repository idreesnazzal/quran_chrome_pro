/* إعراب الآية — the grammatical analysis of every ayah, from
 *   إعراب القرآن الكريم، أحمد عبيد الدعاس وأحمد محمد حميدان وإسماعيل محمود القاسم
 *   (دار المنير ودار الفارابي، دمشق، الطبعة الأولى 1425هـ), digitised by Quranpedia.net.
 * data/irab/SSS.js (built by tools/irab/build.py) holds one surah: __irabPut(s, [[from, to, html, refs?], ...]).
 * A file is fetched only when an analysis is opened, so reading the mushaf never waits for it.
 *   - a passage the book wrote for several ayat stays whole; the opened ayah's part is lit (<i data-a="N">
 *     marks where ayah N's analysis starts, when the build could find it)
 *   - refs: the book says «سبق إعرابها» — the passage it points to is shown under it, labelled
 * Hooks in index.html: the «الإعراب» tab of the ayah window, the study panel's tab, a button on search results;
 * ayah-lists.js adds one on saved ayat. */
(function () {
  'use strict';
  var SRC_SHORT = 'إعراب القرآن الكريم — الدعاس وحميدان والقاسم';
  var SRC_LONG = 'إعراب القرآن الكريم، تأليف أحمد عبيد الدعاس وأحمد محمد حميدان وإسماعيل محمود القاسم — دار المنير ودار الفارابي، دمشق، الطبعة الأولى 1425هـ';
  var DATA_V = '1';
  var store = {}, waiting = {};

  window.__irabPut = function (s, passages) {
    store[s] = passages;
    (waiting[s] || []).forEach(function (w) { w.ok(passages); });
    delete waiting[s];
  };

  function load(s) {
    if (store[s]) return Promise.resolve(store[s]);
    return new Promise(function (ok, fail) {
      var first = !waiting[s];
      (waiting[s] = waiting[s] || []).push({ ok: ok, fail: fail });
      if (!first) return;
      var el = document.createElement('script');
      el.src = 'data/irab/' + String(s).padStart(3, '0') + '.js?v=' + DATA_V;
      el.async = true;
      el.onerror = function () {
        el.remove();
        (waiting[s] || []).forEach(function (w) { w.fail(new Error('irab ' + s)); });
        delete waiting[s];
      };
      document.head.appendChild(el);
    });
  }

  function find(P, a) {
    for (var i = 0; i < P.length; i++) if (P[i][0] <= a && a <= P[i][1]) return P[i];
    return null;
  }

  function passage(s, a) {
    return load(s).then(function (P) { return find(P, a); });
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function suraName(s) {
    var S = (window.QURAN_DATA && window.QURAN_DATA.surahs) || [];
    return (S[s - 1] && S[s - 1].name) || String(s);
  }

  // the book's text -> segments, one per ayah of the passage; «quoted words» get the Quran's typeface
  var peekSura = 0;
  function bodyHtml(p, lit) {
    var from = p[0], to = p[1];
    var parts = p[2].split(/<i data-a="(\d+)"><\/i>/), html = '', k = from;
    for (var i = 0; i < parts.length; i += 2) {
      if (i) k = Number(parts[i - 1]);
      var t = parts[i].replace(/«([^»<]{1,300})»/g, '<span class="ir-w">«$1»</span>')
        .replace(/<u data-r="(\d+):(\d+)">([^<]*)<\/u>/g, function (m, rs, ra, w) {     // «سبق إعرابها»: open what it means
          return '<button type="button" class="ir-link" data-r="' + rs + ':' + ra + '" title="اعرض إعراب الآية ' + ra + (Number(rs) !== peekSura ? ' من سورة ' + esc(suraName(Number(rs))) : '') + '">' + w + '</button>';
        });
      var cls = 'ir-seg' + (to > from && k === lit ? ' ir-cur' : '');
      html += '<span class="' + cls + '" data-a="' + k + '">' + (to > from ? '<span class="ir-n" aria-label="الآية ' + k + '">' + k + '</span>' : '') + t + '</span>';
    }
    return html;
  }

  function rangeLabel(a, b) { return a === b ? 'الآية ' + a : 'الآيات ' + a + '–' + b; }

  // a tap on «سبق إعرابها»: the passage it points to opens under the text (a second tap, or ✕, closes it)
  function peek(btn) {
    var host = btn.closest('.ir-text'), r = btn.getAttribute('data-r').split(':').map(Number);
    if (!host) return;
    var open = host.nextElementSibling && host.nextElementSibling.classList.contains('ir-peek') ? host.nextElementSibling : null;
    if (open && open.getAttribute('data-r') === btn.getAttribute('data-r')) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
    if (open) open.remove();
    host.parentNode.querySelectorAll('.ir-link[aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    btn.setAttribute('aria-expanded', 'true');
    var box = document.createElement('section');
    box.className = 'ir-ref ir-peek'; box.setAttribute('data-r', r.join(':'));
    box.innerHTML = '<div class="ir-ref-h"><span>↩ إعراب الآية ' + r[1] + ' من سورة ' + esc(suraName(r[0])) + ' (أحال إليه الكتاب)</span>' +
      '<button type="button" class="ir-peek-x" title="إغلاق" aria-label="إغلاق">✕</button></div><div class="ir-text ir-ref-t" lang="ar" dir="rtl"><p class="ir-wait">جارٍ التحميل…</p></div>';
    host.parentNode.insertBefore(box, host.nextSibling);
    box.querySelector('.ir-peek-x').addEventListener('click', function () { box.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); });
    load(r[0]).then(function (P) {
      var q = find(P, r[1]), t = box.querySelector('.ir-ref-t');
      peekSura = r[0];
      if (t) t.innerHTML = q ? bodyHtml(q, r[1]) : '<p class="ir-wait">تعذّر العثور عليه.</p>';
    }, function () { var t = box.querySelector('.ir-ref-t'); if (t) t.innerHTML = '<p class="ir-wait">تعذّر التحميل.</p>'; });
  }

  /* the analysis of s:a into el. opts.compact: the study panel's card (no title row) */
  function render(el, s, a, opts) {
    opts = opts || {};
    peekSura = s;
    if (!el.__irClick) {
      el.__irClick = true;
      el.addEventListener('click', function (e) { var b = e.target.closest('.ir-link'); if (b && el.contains(b)) { e.stopPropagation(); peek(b); } });
    }
    var seq = (el.__irSeq = (el.__irSeq || 0) + 1);
    el.innerHTML = '<p class="ir-wait">جارٍ تحميل الإعراب…</p>';
    return passage(s, a).then(function (p) {
      if (el.__irSeq !== seq) return;
      if (!p) { el.innerHTML = '<p class="ir-wait">لا يوجد إعراب لهذه الآية في المصدر.</p>'; return; }
      var shared = p[1] > p[0];
      var head = opts.compact ? (shared ? '<p class="ir-with">إعراب ' + rangeLabel(p[0], p[1]) + ' معًا:</p>' : '') :
        '<div class="ir-head"><div class="words-panel-title"><span aria-hidden="true">🧩</span><span>إعراب ' + (shared ? 'الآية ' + a : 'الآية') + '</span></div>' +
        (shared ? '<span class="ir-shared" title="أعرب الكتاب هذه الآيات معًا؛ جزء الآية ' + a + ' مظلَّل">مقطع مشترك: ' + rangeLabel(p[0], p[1]) + '</span>' : '') + '</div>';
      var refs = p[3] || [];
      el.innerHTML = head +
        '<div class="ir-text' + (opts.compact ? ' ir-compact' : '') + '" lang="ar" dir="rtl">' + bodyHtml(p, opts.compact ? -1 : a) + '</div>' +
        refs.map(function (r, i) {
          return '<section class="ir-ref" data-i="' + i + '"><div class="ir-ref-h">↩ أحال الكتاب هنا إلى إعراب ' + rangeLabel(r[1], r[2]) +
            (r[0] !== s ? ' من سورة ' + esc(suraName(r[0])) : '') + '، وهذا نصه:</div><div class="ir-text ir-ref-t" lang="ar" dir="rtl"><p class="ir-wait">جارٍ التحميل…</p></div></section>';
        }).join('') +
        (opts.compact ? '' : '<p class="ir-src" title="' + esc(SRC_LONG) + '">المصدر: ' + esc(SRC_SHORT) + '</p>');
      refs.forEach(function (r, i) {
        load(r[0]).then(function (P) {
          if (el.__irSeq !== seq) return;
          var box = el.querySelector('.ir-ref[data-i="' + i + '"] .ir-ref-t'), seen = [], html = '';
          for (var k = r[1]; k <= r[2]; k++) {
            var q = find(P, k);
            if (q && seen.indexOf(q) < 0) { seen.push(q); html += '<div class="ir-ref-p">' + bodyHtml(q, r[1] === r[2] ? r[1] : -1) + '</div>'; }
          }
          if (box) box.innerHTML = html || '<p class="ir-wait">تعذّر العثور على المقطع المحال إليه.</p>';
        }, function () { var box = el.querySelector('.ir-ref[data-i="' + i + '"] .ir-ref-t'); if (box) box.innerHTML = '<p class="ir-wait">تعذّر التحميل.</p>'; });
      });
      if (shared && !opts.compact && opts.scroll !== false) {
        var cur = el.querySelector('.ir-cur');
        if (cur && a > p[0]) setTimeout(function () { if (el.__irSeq === seq) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 60);
      }
      return p;
    }, function () {
      if (el.__irSeq === seq) el.innerHTML = '<p class="ir-wait">تعذّر تحميل الإعراب. تحقّق من الاتصال ثم أعد المحاولة.</p>';
    });
  }

  function plain(h) {
    var d = document.createElement('div');
    d.innerHTML = String(h).replace(/<br>/g, '\n').replace(/<i data-a="(\d+)"><\/i>/g, '\n($1) ');
    return (d.textContent || '').replace(/\n{2,}/g, '\n').trim();
  }

  /* the text the «📋 نسخ» button copies */
  function copyText(s, a) {
    return passage(s, a).then(function (p) {
      if (!p) return '';
      var out = (p[1] > p[0] ? 'إعراب ' + rangeLabel(p[0], p[1]) + ' (مقطع مشترك):\n' : 'الإعراب:\n') + plain(p[2]);
      return Promise.all((p[3] || []).map(function (r) {
        return load(r[0]).then(function (P) {
          var seen = [], t = [];
          for (var k = r[1]; k <= r[2]; k++) { var q = find(P, k); if (q && seen.indexOf(q) < 0) { seen.push(q); t.push(plain(q[2])); } }
          return '\n\n[إعراب ' + rangeLabel(r[1], r[2]) + (r[0] !== s ? ' من سورة ' + suraName(r[0]) : '') + ']\n' + t.join('\n');
        });
      })).then(function (more) { return out + more.join('') + '\n\nالمصدر: ' + SRC_LONG; });
    });
  }

  window.Irab = { load: load, passage: passage, render: render, copyText: copyText, source: SRC_LONG,
                  _find: find };
})();
