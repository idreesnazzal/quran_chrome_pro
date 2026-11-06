/* Tasmee Ears (Phase 3, opt-in): a Quran-trained CTC second opinion.
 *
 * The app already knows the expected next word. This module loads the Tilawi
 * FastConformer (Quran CTC, CC-BY-4.0) from HuggingFace with onnxruntime-web,
 * keeps the last few seconds of mic audio, and scores the expected word's CTC
 * token sequence. It never replaces the Chrome transcript; it only reviews a
 * final word and can turn a correct word red or a false red word correct.
 *
 * Chrome stays the default. The model is loaded only when the owner selects
 * the ears mode in settings. The model is not in git.
 */
(function (G) {
  'use strict';
  var MODEL_URL = 'https://huggingface.co/muhdur/tilawi-fastconformer-quran/resolve/main/fastconformer_full_mixed.onnx';
  var VOCAB_URL = 'https://huggingface.co/muhdur/tilawi-fastconformer-quran/resolve/main/vocab.json';
  var CTC_URL = 'https://huggingface.co/muhdur/tilawi-fastconformer-quran/resolve/main/quran_ctc_tokens.json';
  var WASM_PATHS = 'assets/vendor/onnxruntime/';
  var SAMPLE_RATE = 16000;
  var BLANK_ID = 1024;
  var WORD_PREFIX = '▁';
  var MAX_BUF = SAMPLE_RATE * 4;
  var state = { loading: false, ready: false, session: null, vocab: null, ctc: null,
    chunks: [], total: 0, threshold: -1.0, error: null };

  function status(s) { if (G.Tasmee && G.Tasmee.earsStatus) G.Tasmee.earsStatus(s); }
  function tokenizeText(ids) {
    var toks = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (id === BLANK_ID) continue;
      var t = state.vocab && state.vocab[String(id)];
      if (t && t !== '<unk>' && t !== '<blank>') toks.push(t);
    }
    return toks;
  }
  function tokenIdsToText(ids) {
    var s = tokenizeText(ids).join('').split(WORD_PREFIX).join(' ');
    return s.replace(/\s+/g, ' ').trim();
  }
  function tokenIdsToWordEnds(ids) {
    var toks = tokenizeText(ids), ends = [], inWord = false;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t === WORD_PREFIX || t.lastIndexOf(WORD_PREFIX, 0) === 0) {
        if (inWord) ends.push(i);
        inWord = t !== WORD_PREFIX;
        continue;
      }
      inWord = true;
    }
    if (inWord) ends.push(toks.length);
    var out = [];
    for (var j = 0; j < ends.length; j++) if (j === 0 || ends[j] > ends[j - 1]) out.push(ends[j]);
    return out;
  }
  function getWordTokens(ctc, vocab, surah, ayah, wordIndex) {
    var key = surah + ':' + ayah + ':' + ayah;
    var ids = ctc[key];
    if (!ids) return null;
    var saved = state.vocab; state.vocab = vocab;
    var ends = tokenIdsToWordEnds(ids);
    state.vocab = saved;
    var start = 0;
    for (var i = 0; i < ends.length; i++) {
      if (i === wordIndex) return ids.slice(start, ends[i]);
      start = ends[i];
    }
    return null;
  }
  function alignTokens(logprobs, T, V, tokens, blankId) {
    if (!tokens || !tokens.length) return { score: -Infinity, path: [], scores: [] };
    var ext = [blankId];
    for (var i = 0; i < tokens.length; i++) { ext.push(tokens[i], blankId); }
    var S = ext.length;
    var dp = new Float64Array(T * S), bp = new Int32Array(T * S);
    for (var k = 0; k < dp.length; k++) dp[k] = -Infinity;
    dp[0] = logprobs[ext[0]];
    if (S > 1) dp[1] = logprobs[ext[1]];
    for (var t = 1; t < T; t++) {
      for (var s = 0; s < S; s++) {
        var best = -Infinity, arg = 0;
        if (s > 0) { var v1 = dp[(t - 1) * S + (s - 1)]; if (v1 > best) { best = v1; arg = s - 1; } }
        var v2 = dp[(t - 1) * S + s]; if (v2 > best) { best = v2; arg = s; }
        if (s + 1 < S && ext[s + 1] === ext[s]) { var v3 = dp[(t - 1) * S + (s + 1)]; if (v3 > best) { best = v3; arg = s + 1; } }
        dp[t * S + s] = best + logprobs[t * V + ext[s]];
        bp[t * S + s] = arg;
      }
    }
    var s = 0, best = -Infinity;
    for (var j = 0; j < S; j++) { var v = dp[(T - 1) * S + j]; if (v > best) { best = v; s = j; } }
    var path = new Array(T);
    for (var tt = T - 1; tt >= 0; tt--) { path[tt] = ext[s]; s = bp[tt * S + s]; }
    var scores = [], idx = 0;
    for (var wi = 0; wi < tokens.length; wi++) {
      var vals = [];
      while (idx < path.length && path[idx] === blankId) idx++;
      while (idx < path.length && path[idx] === tokens[wi]) { vals.push(logprobs[idx * V + tokens[wi]]); idx++; }
      scores.push(vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : -Infinity);
    }
    var score = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    return { score: score, path: path, scores: scores };
  }
  function load() {
    if (state.ready || state.loading) return;
    if (!G.ort || !G.ort.InferenceSession) { state.error = 'onnxruntime-web not loaded'; status('error'); return; }
    state.loading = true; status('loading');
    try { G.ort.env.wasm.wasmPaths = WASM_PATHS; G.ort.env.wasm.numThreads = 1; } catch (e) {}
    Promise.all([
      fetch(VOCAB_URL).then(function (r) { return r.json(); }),
      fetch(CTC_URL).then(function (r) { return r.json(); })
    ]).then(function (assets) {
      state.vocab = assets[0]; state.ctc = assets[1];
      return G.ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    }).then(function (session) {
      state.session = session; state.ready = true; state.loading = false; state.error = null;
      status('ready');
    }).catch(function (e) {
      state.error = e && e.message ? e.message : String(e);
      state.loading = false; status('error');
    });
  }
  function feedAudio(audio) {
    if (!state.ready || !audio || !audio.length) return;
    state.chunks.push(audio);
    state.total += audio.length;
    while (state.total > MAX_BUF && state.chunks.length > 1) { state.total -= state.chunks[0].length; state.chunks.shift(); }
    if (state.total > MAX_BUF) {
      var drop = state.total - MAX_BUF;
      state.chunks[0] = state.chunks[0].slice(drop);
      state.total -= drop;
    }
  }
  function recentAudio(seconds) {
    var n = Math.min(state.total, Math.floor(seconds * SAMPLE_RATE));
    var out = new Float32Array(n), pos = n;
    for (var i = state.chunks.length - 1; i >= 0 && pos > 0; i--) {
      var c = state.chunks[i], take = Math.min(c.length, pos);
      out.set(c.subarray(c.length - take), pos - take);
      pos -= take;
    }
    return out;
  }
  function review(st, k, surah, ayah, wordIndex) {
    if (!state.ready || !st || !st.X || !st.at || k == null || k < 0 || k >= st.X.N) return Promise.resolve({ ready: false, score: null, ok: null });
    var p = st.at[k];
    if (!p || p.w == null) return Promise.resolve({ ready: false, score: null, ok: null });
    var wordTokens = getWordTokens(state.ctc, state.vocab, surah, ayah, p.w);
    if (!wordTokens || !wordTokens.length) return Promise.resolve({ ready: false, score: null, ok: null });
    var audio = recentAudio(3);
    if (audio.length < SAMPLE_RATE * 0.5) return Promise.resolve({ ready: false, score: null, ok: null });
    var input = new G.ort.Tensor('float32', audio, [1, audio.length]);
    var length = new G.ort.Tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]);
    return state.session.run({ audio_signal: input, length: length }).then(function (outputs) {
      var out = outputs[state.session.outputNames[0]];
      var dims = out.dims, T = dims[dims.length - 2], V = dims[dims.length - 1];
      var aligned = alignTokens(out.data, T, V, wordTokens, BLANK_ID);
      var score = aligned.score;
      return { ready: true, score: score, ok: score >= state.threshold, threshold: state.threshold,
        expected: st.X.E[k], wordTokens: wordTokens };
    }).catch(function (e) {
      return { ready: false, score: null, ok: null, error: e && e.message ? e.message : String(e) };
    });
  }
  function reset() { state.chunks = []; state.total = 0; }
  G.TasmeeEars = {
    load: load, feedAudio: feedAudio, review: review, reset: reset,
    ready: function () { return state.ready; },
    loading: function () { return state.loading; },
    error: function () { return state.error; },
    threshold: function (v) { if (v != null) state.threshold = +v; return state.threshold; },
    _state: function () { return state; },
    _pure: { tokenIdsToText: tokenIdsToText, tokenIdsToWordEnds: tokenIdsToWordEnds,
      getWordTokens: getWordTokens, alignTokens: alignTokens }
  };
})(typeof window !== 'undefined' ? window : globalThis);
