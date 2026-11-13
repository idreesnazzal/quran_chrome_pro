/* The Quran ear: Tilawi FastConformer CTC (muhdur/tilawi-fastconformer-quran, CC-BY-4.0), a model
 * already trained on Quran recitation (Hafs). Same protocol as whisper-worker.js, so recite-by-mic.js
 * drives it the same way:
 *   in : {type:'load'}                      out: {type:'progress', loaded, total} … {type:'ready', device}
 *   in : {type:'transcribe', id, audio}     out: {type:'result', id, text, ms} | {type:'error', id, message}
 * audio = Float32Array, 16 kHz mono. Two backends, chosen at load:
 *   - 'server': the app's local server (server/recite_server.py, POST /ctc) runs the model natively —
 *     10 s of recitation in ~0.5 s. Used whenever the page is served by it.
 *   - 'wasm': onnxruntime-web in this worker (assets/vendor/onnxruntime, MIT); the 88 MB model comes
 *     once from Hugging Face and is kept in Cache Storage. ~0.6 s per second of audio on one thread
 *     (more threads when the page is cross-origin isolated).
 * A classic worker (importScripts): ort.wasm.min.js is a plain script. */
'use strict';
var BASE = new URL('../', self.location.href).href;          // …/assets/
var HF = 'https://huggingface.co/muhdur/tilawi-fastconformer-quran/resolve/main/';
var FILES = { model: 'fastconformer_full_mixed.onnx', vocab: 'vocab.json' };
var CACHE = 'quran-ear-tilawi-v1';
var BLANK = 1024;
var E = { backend: '', session: null, vocab: null };

function post(m) { self.postMessage(m); }

// a file: the local copy if the server has one (assets/models/tilawi/), else Hugging Face via the cache
function getFile(name, progress) {
  var local = BASE + 'models/tilawi/' + name;
  return fetch(local, { method: 'HEAD' }).then(function (r) {
    // (a host that answers every path with index.html is not a model)
    if (r.ok && !/text\/html/i.test(r.headers.get('Content-Type') || '')) return fetch(local).then(function (x) { return x.arrayBuffer(); });
    throw new Error('no local copy');
  }).catch(function () {
    var url = HF + name;
    return caches.open(CACHE).then(function (c) {
      return c.match(url).then(function (hit) {
        if (hit) return hit.arrayBuffer();
        return fetch(url).then(function (res) {
          if (!res.ok) throw new Error('download failed: ' + res.status);
          var total = +res.headers.get('Content-Length') || 0, loaded = 0, parts = [];
          var rd = res.body.getReader();
          function pump() {
            return rd.read().then(function (x) {
              if (x.done) {
                var buf = new Uint8Array(loaded), o = 0;
                parts.forEach(function (p) { buf.set(p, o); o += p.length; });
                return c.put(url, new Response(buf.slice(0))).catch(function () {}).then(function () { return buf.buffer; });
              }
              parts.push(x.value); loaded += x.value.length;
              if (progress) progress(loaded, total);
              return pump();
            });
          }
          return pump();
        });
      });
    });
  });
}

function greedy(data, T, V) {
  var out = '', prev = -1;
  for (var t = 0; t < T; t++) {
    var best = 0, bv = -Infinity, o = t * V;
    for (var v = 0; v < V; v++) if (data[o + v] > bv) { bv = data[o + v]; best = v; }
    if (best !== prev && best !== BLANK) out += E.vocab[best] || '';
    prev = best;
  }
  return out.split('▁').join(' ').replace(/\s+/g, ' ').trim();
}

function loadServer() {
  return fetch(new URL('/ctc', self.location.href).href).then(function (r) { return r.json(); })
    .then(function (j) { if (!j || !j.ok) throw new Error('server ear off'); E.backend = 'server'; });
}
function loadWasm() {
  importScripts(BASE + 'vendor/onnxruntime/ort.wasm.min.js');
  ort.env.wasm.wasmPaths = BASE + 'vendor/onnxruntime/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  return getFile(FILES.vocab).then(function (b) {
    var v = JSON.parse(new TextDecoder().decode(b));
    E.vocab = []; for (var i = 0; i < Object.keys(v).length; i++) E.vocab.push(v[String(i)] || '');
    return getFile(FILES.model, function (l, t) { post({ type: 'progress', loaded: l, total: t }); });
  }).then(function (buf) {
    return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] });
  }).then(function (s) { E.session = s; E.backend = 'wasm'; });
}

function transcribe(audio) {
  if (E.backend === 'server') {
    var copy = audio.slice(0);   // kept for the browser if the server is gone
    return fetch(new URL('/ctc', self.location.href).href, { method: 'POST', body: audio.buffer })
      .then(function (r) { if (!r.ok) throw new Error('server ear: ' + r.status); return r.json(); })
      .then(function (j) { if (j.error) throw new Error(j.error); return { text: j.text || '', ms: j.ms }; })
      .catch(function (err) {      // the local server stopped (closed window, restarted): carry on in the browser
        if (E.session) { E.backend = 'wasm'; return transcribe(copy); }
        post({ type: 'warn', message: 'server ear lost (' + ((err && err.message) || err) + '): loading it in the browser' });
        return loadWasm().then(function () { return transcribe(copy); });
      });
  }
  var t0 = performance.now();
  return E.session.run({ audio_signal: new ort.Tensor('float32', audio, [1, audio.length]),
    length: new ort.Tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]) }).then(function (out) {
    var o = out[E.session.outputNames[0]], d = o.dims;
    return { text: greedy(o.data, d[d.length - 2], d[d.length - 1]), ms: Math.round(performance.now() - t0) };
  });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'load') {
    // force 'wasm' (localStorage recite_whisper_force): test the browser path where a server ear exists
    (m.force === 'wasm' ? Promise.reject(new Error('forced')) : loadServer()).catch(function () { return loadWasm(); }).then(function () {
      post({ type: 'ready', device: E.backend, dtype: 'tilawi-ctc' });
    }).catch(function (err) { post({ type: 'error', message: String((err && err.message) || err) }); });
  } else if (m.type === 'transcribe') {
    transcribe(m.audio).then(function (r) { post({ type: 'result', id: m.id, text: r.text, ms: r.ms }); })
      .catch(function (err) { post({ type: 'error', id: m.id, message: String((err && err.message) || err) }); });
  }
};
