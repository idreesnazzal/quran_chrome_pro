/* Tasmee recorder (Phase 2, opt-in). Records the microphone during a tasmee
 * session and stores the audio + expected words + verdicts in IndexedDB on the
 * device. It never changes the tasmee engine and never uploads anything.
 *
 * The owner must tick the consent box. The recorder is off by default. The
 * panel is opened from the tasmee bar (🎙️). It records only in voice mode.
 */
(function (G) {
  'use strict';
  var PREF_KEY = 'tasmee_recorder_prefs';
  var DB_NAME = 'tasmee_recorder.v1';
  var STORE = 'sessions';
  var state = {
    active: false, recorder: null, stream: null, chunks: [], startedAt: 0,
    timer: 0, session: null, panel: null, lastSessionId: 0, lastSessionLabel: ''
  };
  var prefs = readPrefs();

  function readPrefs() {
    try {
      var p = JSON.parse(G.localStorage.getItem(PREF_KEY) || 'null');
      return Object.assign({ consent: false }, p || {});
    } catch (e) { return { consent: false }; }
  }
  function savePrefs() { try { G.localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function toast(msg) { if (G.toast) G.toast(msg); else if (G.alert) G.alert(msg); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function dateTxt(ts) {
    try { return new Date(ts).toLocaleString('ar-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return new Date(ts).toLocaleString(); }
  }

  /* ------------------------------- IndexedDB ---------------------------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!G.indexedDB) { reject(new Error('no indexeddb')); return; }
      var req = G.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexeddb open failed')); };
    });
  }
  function saveSession(meta, blob) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var id = 's' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        tx.objectStore(STORE).put({ id: id, createdAt: Date.now(), meta: meta, blob: blob });
        tx.oncomplete = function () { resolve(id); };
        tx.onerror = function () { reject(tx.error || new Error('indexeddb put failed')); };
        tx.onabort = function () { reject(tx.error || new Error('indexeddb aborted')); };
      });
    });
  }
  function listSessions() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () {
          var all = (req.result || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
          resolve(all.map(function (r) { return { id: r.id, createdAt: r.createdAt, meta: r.meta }; }));
        };
        req.onerror = function () { reject(req.error || new Error('indexeddb getAll failed')); };
      });
    });
  }
  function getSession(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error || new Error('indexeddb get failed')); };
      });
    });
  }
  function deleteSession(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error || new Error('indexeddb delete failed')); };
      });
    });
  }

  /* ------------------------------- metadata ----------------------------- */
  function expectedWord(st, k) {
    if (!st || !st.X || !st.X.E) return '';
    return st.X.E[k] == null ? '' : st.X.E[k];
  }
  function metaFromState(st) {
    if (!st) return null;
    var X = st.X, T = st.T, words = [];
    if (X && st.at) {
      for (var k = 0; k < X.N; k++) {
        var p = st.at[k] || {};
        words.push({
          k: k, ai: p.ai == null ? null : p.ai, w: p.w == null ? null : p.w,
          expected: expectedWord(st, k),
          state: T ? T.st[k] : 0, type: T ? T.ty[k] : 0, tries: T ? T.tries[k] : 0
        });
      }
    }
    var summary = null;
    try { summary = (G.Tasmee && G.Tasmee.Core && T && X) ? G.Tasmee.Core.summary(T, X) : null; } catch (e) {}
    return {
      mode: st.mode,
      level: G.Tasmee && G.Tasmee.prefs ? G.Tasmee.prefs().level : null,
      reveal: X ? X.reveal : null,
      startedAt: st.seg0 || (st.acc && st.acc.t0) || Date.now(),
      endedAt: Date.now(),
      range: st.acc && st.acc.range ? st.acc.range : null,
      fixed: st.acc && st.acc.fixed ? st.acc.fixed.slice() : null,
      acc: st.acc ? {
        reached: st.acc.reached, ok: st.acc.ok, err: st.acc.err, uns: st.acc.uns,
        types: Object.assign({}, st.acc.types), added: st.acc.added,
        errs: st.acc.errs ? st.acc.errs.slice() : []
      } : null,
      summary: summary,
      words: words,
      heard: st.heard ? st.heard.slice() : [],
      lastHeard: st.lastHeard || '',
      warn: st.warn || '',
      device: {
        ua: G.navigator ? G.navigator.userAgent : '',
        w: G.screen ? G.screen.width : null, h: G.screen ? G.screen.height : null,
        dpr: G.devicePixelRatio || null
      }
    };
  }
  function mergeMeta(a, b) {
    if (!a) return b;
    if (!b) return a;
    return Object.assign({}, a, b, {
      events: (a.events || []).concat(b.events || []),
      words: b.words && b.words.length ? b.words : a.words
    });
  }

  /* ------------------------------- recorder ----------------------------- */
  function start() {
    if (state.active) return;
    if (!prefs.consent) { toast('أوافق على التسجيل أولًا'); openPanel(); return; }
    if (!G.navigator || !G.navigator.mediaDevices || !G.navigator.mediaDevices.getUserMedia || typeof G.MediaRecorder === 'undefined') {
      toast('المتصفح لا يدعم التسجيل الصوتي'); return;
    }
    var st = G.Tasmee && G.Tasmee._state ? G.Tasmee._state() : null;
    if (!st || st.mode !== 'voice') { toast('التسجيل متاح في الوضع الصوتي فقط'); return; }
    G.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .then(function (stream) {
        var mime = '';
        try { mime = G.MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'; } catch (e) {}
        var rec;
        try {
          rec = mime ? new G.MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000, timeslice: 10000 })
                     : new G.MediaRecorder(stream, { timeslice: 10000 });
        } catch (e) { rec = new G.MediaRecorder(stream); }
        state.stream = stream;
        state.recorder = rec;
        state.chunks = [];
        state.startedAt = Date.now();
        state.session = { meta: metaFromState(st), events: [], mime: rec.mimeType || mime || 'audio/webm' };
        rec.ondataavailable = function (e) { if (e.data && e.data.size) state.chunks.push(e.data); };
        rec.onstop = function () { finalize(); };
        rec.onerror = function (e) { toast('توقف التسجيل: ' + ((e && e.error && e.error.message) || 'خطأ')); };
        try { rec.start(10000); } catch (e) { try { rec.start(); } catch (e2) { toast('تعذّر بدء التسجيل'); return; } }
        state.active = true;
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(function () { if (state.active) updatePanel(); }, 1000);
        updatePanel();
        toast('بدأ التسجيل على جهازك');
      })
      .catch(function (e) { toast('تعذّر فتح المايك: ' + ((e && e.message) || '')); });
  }
  function stop() {
    if (!state.active) return;
    var st = G.Tasmee && G.Tasmee._state ? G.Tasmee._state() : null;
    if (st && state.session) state.session.meta = mergeMeta(state.session.meta, metaFromState(st));
    state.active = false;
    try { if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop(); } catch (e) {}
    try { if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    state.stream = null;
    if (state.timer) { clearInterval(state.timer); state.timer = 0; }
    updatePanel();
  }
  function finalize() {
    var chunks = state.chunks, session = state.session;
    state.recorder = null;
    state.chunks = [];
    if (!chunks.length) { state.session = null; updatePanel(); return; }
    var blob = new Blob(chunks, { type: (session && session.mime) || 'audio/webm' });
    var meta = session && session.meta ? session.meta : {};
    meta.events = (session && session.events) || [];
    meta.audio = { mime: blob.type, size: blob.size, durationMs: Date.now() - state.startedAt };
    saveSession(meta, blob).then(function (id) {
      state.session = null;
      state.lastSessionId = id;
      state.lastSessionLabel = dateTxt(Date.now());
      updatePanel();
      toast('حُفظت الجلسة على جهازك: ' + id);
    }).catch(function () {
      state.session = null;
      updatePanel();
      toast('تعذّر حفظ الجلسة في المتصفح');
    });
  }

  /* ------------------------------- panel -------------------------------- */
  function closePanel() {
    if (state.panel) { state.panel.remove(); state.panel = null; }
  }
  function openPanel() {
    closePanel();
    var m = document.createElement('div');
    m.id = 'tsmRecModal'; m.className = 'tsm-modal'; m.setAttribute('dir', 'rtl');
    m.innerHTML =
      '<div class="tsm-card tsm-rec-card" role="dialog" aria-modal="true">' +
        '<header class="tsm-head"><b>🎙️ تسجيل جلسة التسميع</b><button class="tsm-x" data-rec="close" title="إغلاق">✕</button></header>' +
        '<div class="tsm-body">' +
          '<p class="tsm-note">سيسجّل هذا المايك صوتك في هذه الجلسة فقط، ويُحفظ على جهازك. لا يُرفع تلقائيًا. يمكنك حذفه في أي وقت.</p>' +
          '<label class="tsm-chk"><input type="checkbox" id="tsmRecConsent"' + (prefs.consent ? ' checked' : '') + '> أوافق على تسجيل صوتي في هذه الجلسة</label>' +
          '<div class="tsm-rec-status" id="tsmRecStatus"></div>' +
          '<div class="tsm-rec-actions">' +
            '<button class="tsm-b tsm-gold" data-rec="start">🎙️ ابدأ التسجيل</button>' +
            '<button class="tsm-b" data-rec="stop">⏹ أوقف التسجيل</button>' +
            '<button class="tsm-b" data-rec="export">📤 صدّر آخر جلسة</button>' +
            '<button class="tsm-b tsm-red" data-rec="delete">🗑 احذف آخر جلسة</button>' +
          '</div>' +
          '<p class="tsm-rec-note">التسجيل متاح في الوضع الصوتي فقط. لا يسجّل في القراءة العادية. يُحفظ الصوت والبيانات الوصفية في IndexedDB على جهازك، ولا يُرفع. ملف التصدير JSON يحتوي الصوت (data URL) والكلمات المطلوبة والأحكام، وهو ما يقرأه Kaggle notebook.</p>' +
        '</div>' +
        '<footer class="tsm-foot"><button class="tsm-b" data-rec="close">إغلاق</button></footer>' +
      '</div>';
    m.addEventListener('mousedown', function (e) { if (e.target === m) closePanel(); });
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rec]');
      var c = e.target.closest('#tsmRecConsent');
      if (c) { prefs.consent = !!c.checked; savePrefs(); updatePanel(); return; }
      if (!b) return;
      var a = b.getAttribute('data-rec');
      if (a === 'close') closePanel();
      if (a === 'start') start();
      if (a === 'stop') stop();
      if (a === 'export') exportLast();
      if (a === 'delete') deleteLast();
    });
    document.body.appendChild(m);
    state.panel = m;
    updatePanel();
    refreshLast();
  }
  function refreshLast() {
    listSessions().then(function (list) {
      if (list && list.length) {
        state.lastSessionId = list[0].id;
        state.lastSessionLabel = dateTxt(list[0].createdAt);
      }
      updatePanel();
    }).catch(function () {});
  }
  function updatePanel() {
    var m = state.panel; if (!m) return;
    var status = m.querySelector('#tsmRecStatus');
    var start = m.querySelector('[data-rec=start]'), stop = m.querySelector('[data-rec=stop]');
    var exp = m.querySelector('[data-rec=export]'), del = m.querySelector('[data-rec=delete]');
    var consent = m.querySelector('#tsmRecConsent');
    if (status) {
      if (state.active) {
        status.textContent = '🔴 جارٍ التسجيل... ' + fmtTime((Date.now() - state.startedAt) / 1000) + ' — ' + state.chunks.length + ' chunks';
      } else {
        status.textContent = state.lastSessionId
          ? 'آخر جلسة محفوظة: ' + state.lastSessionLabel + ' — ' + state.lastSessionId
          : 'التسجيل مغلق. وافق ثم اضغط «ابدأ التسجيل».';
      }
    }
    if (start) start.disabled = state.active || !(consent && consent.checked);
    if (stop) stop.disabled = !state.active;
    if (exp) exp.disabled = !state.lastSessionId;
    if (del) del.disabled = !state.lastSessionId;
  }
  function exportLast() {
    if (!state.lastSessionId) { toast('لا توجد جلسة محفوظة'); return; }
    getSession(state.lastSessionId).then(function (rec) {
      if (!rec) { toast('الجلسة غير موجودة'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var payload = {
          app: 'quran_chrome_pro', kind: 'tasmee_session', version: 1,
          exportedAt: new Date().toISOString(), meta: rec.meta,
          audio: { mime: rec.blob.type, dataUrl: reader.result }
        };
        var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'tasmee_session_' + rec.id + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        toast('صُدّرت الجلسة');
      };
      reader.readAsDataURL(rec.blob);
    }).catch(function () { toast('تعذّر تصدير الجلسة'); });
  }
  function deleteLast() {
    if (!state.lastSessionId) { toast('لا توجد جلسة محفوظة'); return; }
    if (!G.confirm || !G.confirm('حذف الجلسة الأخيرة نهائيًا؟')) return;
    deleteSession(state.lastSessionId).then(function () {
      state.lastSessionId = 0; state.lastSessionLabel = '';
      updatePanel(); refreshLast(); toast('حُذفت الجلسة');
    }).catch(function () { toast('تعذّر حذف الجلسة'); });
  }

  /* ------------------------------- hooks -------------------------------- */
  function onStart(st) {
    if (!state.active || !state.session || !st) return;
    state.session.meta = mergeMeta(state.session.meta, metaFromState(st));
  }
  function onHeard(st, words, raw, final) {
    if (!state.active || !state.session || !final) return;
    state.session.events.push({
      t: Date.now() - state.startedAt,
      words: (words || []).slice(), raw: (raw || words || []).slice(),
      i: st && st.T ? st.T.i : null,
      reached: st && st.acc ? st.acc.reached : null,
      err: st && st.acc ? st.acc.err : null,
      uns: st && st.acc ? st.acc.uns : null
    });
  }
  function onStop(st) {
    if (!state.active) return;
    if (st && state.session) state.session.meta = mergeMeta(state.session.meta, metaFromState(st));
    stop();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.panel) { closePanel(); e.stopPropagation(); }
  }, true);

  G.TasmeeRecorder = {
    openPanel: openPanel, closePanel: closePanel, start: start, stop: stop,
    onStart: onStart, onHeard: onHeard, onStop: onStop,
    isRecording: function () { return state.active; },
    metaFromState: metaFromState,
    prefs: function () { return prefs; },
    setPref: function (k, v) { prefs[k] = v; savePrefs(); },
    list: listSessions, export: exportLast, remove: deleteLast
  };
})(typeof window !== 'undefined' ? window : globalThis);
