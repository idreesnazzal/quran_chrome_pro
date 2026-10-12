/* Quran Whisper in the browser (Web Worker, ES module).
 *
 * Model: tarteel-ai/whisper-base-ar-quran (Whisper base fine-tuned on
 * everyayah recitations), ONNX export "iqbalaesthetic/Basira" (Apache-2.0).
 * Runtime: transformers.js 3.8.1, vendored in assets/vendor/transformers
 * (no CDN: the app keeps working offline once the model is cached).
 * The model files (~103 MB int8, or fp16/q4 on WebGPU) are downloaded from
 * huggingface.co ONCE and kept in the browser's Cache Storage.
 *
 * Protocol (postMessage):
 *   in : {type:'load'}                       -> progress* , ready | error
 *   in : {type:'transcribe', id, audio: Float32Array (16 kHz mono)}
 *   out: {type:'result', id, text, ms}
 */
import { pipeline, env } from '../vendor/transformers/transformers.min.js';

const MODEL = 'iqbalaesthetic/Basira';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
// threads only help when the page is cross-origin isolated (server sends COOP/COEP)
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let asr = null;
let loading = null;

/* Encoder on WebGPU (q4, 19 MB), decoder on CPU (int8, 79 MB): ~98 MB.
 * The encoder is the fixed cost of every call (Whisper always encodes a 30 s
 * window); the decoder is small per token. Measured dead ends on an Intel Arc
 * laptop: fp16 decoder on WebGPU aborts ONNX Runtime (out of memory) after a
 * 200 MB download; fp16 encoder + int8 decoder fails (float16 hidden states
 * into a float32 input). q4 keeps float32 I/O. No usable adapter: all CPU. */
const HYBRID = { device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' },
                 dtype: { encoder_model: 'q4', decoder_model_merged: 'q8' }, label: 'webgpu+cpu' };
const CPU = { device: 'wasm', dtype: 'q8', label: 'cpu' };

async function pickDevice() {
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter();
      const info = ad && (ad.info || {});
      if (ad && !ad.isFallbackAdapter && !info.isFallbackAdapter) return HYBRID;
    }
  } catch (e) { /* fall back to CPU */ }
  return CPU;
}

async function load(force) {
  if (asr) return;
  const choice = force === 'cpu' ? CPU : force === 'hybrid' ? HYBRID : await pickDevice();
  const files = {};
  const p = await pipeline('automatic-speech-recognition', MODEL, {
    device: choice.device,
    dtype: choice.dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file) {
        files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
        let loaded = 0, total = 0;
        for (const k in files) { loaded += files[k].loaded; total += files[k].total; }
        postMessage({ type: 'progress', loaded, total });
      }
    }
  });
  // warm-up: compiles kernels so the first real chunk is not slow, and proves
  // the configuration actually runs before we commit to it
  await p(new Float32Array(16000), { max_new_tokens: 4 });
  asr = p;
  postMessage({ type: 'ready', device: choice.label, dtype: JSON.stringify(choice.dtype) });
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      if (!loading) {
        loading = load(m.force).catch(async (err) => {
          // WebGPU can fail late (driver/feature issues): retry on wasm once
          if (!m.force && !asr) {
            postMessage({ type: 'warn', message: 'WebGPU failed, using CPU: ' + String((err && err.message) || err) });
            asr = null; await load('cpu');
          }
          else throw err;
        });
      }
      await loading;
    } else if (m.type === 'transcribe') {
      if (!asr) await (loading || load());
      const t0 = performance.now();
      const out = await asr(m.audio, { max_new_tokens: 160, num_beams: 1, do_sample: false });
      postMessage({ type: 'result', id: m.id, text: (out && out.text) || '', ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
