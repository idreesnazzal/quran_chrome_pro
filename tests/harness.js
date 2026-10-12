/* Shared test harness: real corpus, seeded noise, fake Chrome speech events,
 * and adapters that drive the NEW engine (v3) and the OLD one (v2.9.2,
 * assets/js/legacy) through the exact same live path (rec.onresult). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let _data = null;
function loadData() {
  if (_data) return _data;
  const ctx = { window: {} };
  vm.runInNewContext(read('data/quran_data.js'), ctx);
  _data = ctx.window.QURAN_DATA;
  return _data;
}

/* ---------------- seeded RNG ---------------- */
function rng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.int = (n) => Math.floor(f() * n);
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  return f;
}

/* ---------------- fake SpeechRecognition ---------------- */
function makeFakeSR(holder) {
  return function FakeSR() {
    this.continuous = false; this.interimResults = false; this.lang = ''; this.maxAlternatives = 1;
    this.start = () => { holder.rec = this; if (this.onstart) this.onstart(); };
    this.stop = () => {};
    this.abort = () => {};
  };
}

/* An "utterance" = words of one final result. Chrome sends interim events
 * that grow word by word (sometimes revising / truncating the last word)
 * and then one final. results[] accumulates across utterances in continuous
 * mode; resultIndex points at the first changed result. */
function chromeEvents(utterances, r, opts) {
  opts = opts || {};
  const events = [];
  const finals = [];
  for (let u = 0; u < utterances.length; u++) {
    const words = utterances[u].words;
    const truth = utterances[u].truth; // truth position after each word
    for (let k = 1; k <= words.length; k++) {
      if (opts.noInterim) break;
      const w = words.slice(0, k);
      let lastShown = w;
      if (opts.reviseRate && r.chance(opts.reviseRate) && w[k - 1].length > 2) {
        // revised guess: truncated or mutated last word, corrected later
        const lw = w[k - 1];
        const bad = r.chance(0.5) ? lw.slice(0, Math.max(1, lw.length - 2)) : mutate(lw, r);
        lastShown = w.slice(0, -1).concat([bad]);
      }
      events.push({ results: finals.map((f) => ({ t: f, fin: true })).concat([{ t: lastShown.join(' '), fin: false }]),
        resultIndex: finals.length, truth: truth[k - 1], heardCount: k, u });
    }
    let finalText = words.join(' ');
    if (opts.android && finals.length) finalText = finals[finals.length - 1] + ' ' + finalText; // cumulative re-send
    finals.push(finalText);
    events.push({ results: finals.map((f) => ({ t: f, fin: true })), resultIndex: finals.length - 1,
      truth: truth[truth.length - 1], heardCount: words.length, u, final: true });
  }
  return events;
}

function toSREvent(ev) {
  const results = ev.results.map((x) => { const o = [{ transcript: x.t }]; o.isFinal = x.fin; return o; });
  return { resultIndex: ev.resultIndex, results };
}

/* ---------------- noise ---------------- */
const PHON = { 'س': 'ص', 'ص': 'س', 'ت': 'ط', 'ط': 'ت', 'د': 'ض', 'ض': 'د', 'ذ': 'ز', 'ز': 'ذ',
  'ث': 'س', 'ق': 'ك', 'ك': 'ق', 'ح': 'ه', 'ه': 'ح', 'ع': 'ا', 'ظ': 'ض', 'ء': 'ا' };
function mutate(w, r) {
  const i = r.int(w.length);
  const op = r.int(3);
  if (op === 0) return w.slice(0, i) + 'ا' + w.slice(i);                   // madd alif
  if (op === 1 && w.length > 3) return w.slice(0, i) + w.slice(i + 1);     // dropped letter
  const c = w[i];
  return w.slice(0, i) + (PHON[c] || c) + w.slice(i + 1);                  // phonetic swap
}

const OFF_QURAN = ('اليوم الجو جميل جدا وانا ذاهب الى السوق لشراء بعض الخضار والفواكه ثم ' +
  'سوف ارجع الى البيت واتصل بصديقي لنتحدث عن المباراة والامتحان القادم في الجامعة').split(' ');

/* Recite `n` words from global corpus position `start` (new-engine corpus,
 * real words only). Returns heard words with per-word truth positions. */
function recite(C, start, n, r, noise) {
  const heard = [], truth = [];
  let g = start, said = 0, guard = 0;
  const realAt = (p) => { while (p < C.L && C.virt[p]) p++; return p; };
  g = realAt(g);
  while (said < n && g < C.L && guard++ < n * 4) {
    if (C.virt[g]) { g++; continue; } // tests recite without basmala unless asked
    const w = C.words[g];
    if (noise) {
      if (r.chance(noise.drop)) { g++; said++; continue; }                 // ASR deletion
      if (r.chance(noise.insert)) { heard.push(r.pick(noise.vocab)); truth.push(truth.length ? truth[truth.length - 1] : g - 1); }
      if (r.chance(noise.restart) && heard.length > 4) {                   // go back 2-4 words
        const back = 2 + r.int(3);
        g = Math.max(start, g - back);
        continue;
      }
      if (r.chance(noise.stutter)) { heard.push(w); truth.push(g); }      // repeated word
      if (r.chance(noise.merge) && g + 1 < C.L && !C.virt[g + 1]) {       // two words heard as one
        heard.push(w + C.words[g + 1]); truth.push(g + 1); g += 2; said += 2; continue;
      }
      if (r.chance(noise.split) && w.length >= 6) {                        // one word heard as two
        const cut = 2 + r.int(w.length - 3);
        heard.push(w.slice(0, cut)); truth.push(g);
        heard.push(w.slice(cut)); truth.push(g); g++; said++; continue;
      }
      if (r.chance(noise.subst)) {
        heard.push(r.chance(0.5) ? r.pick(noise.vocab) : mutate(mutate(w, r), r)); truth.push(g); g++; said++; continue;
      }
      if (r.chance(noise.spell)) { heard.push(mutate(w, r)); truth.push(g); g++; said++; continue; }
    }
    heard.push(w); truth.push(g); g++; said++;
  }
  return { heard, truth, end: g };
}

function chunk(heard, truth, r, minL, maxL) {
  const out = [];
  for (let i = 0; i < heard.length;) {
    const n = Math.min(heard.length - i, minL + r.int(maxL - minL + 1));
    out.push({ words: heard.slice(i, i + n), truth: truth.slice(i, i + n) });
    i += n;
  }
  return out;
}

/* ---------------- engine adapters ---------------- */
function newEngine() {
  const holder = {};
  const D = loadData();
  const ctx = vm.createContext({ console, Math, Date, JSON, Map, Set, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    QURAN_DATA: D, currentPage: 1, isDoublePageMode: false, currentHighlightedAyah: null });
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.SpeechRecognition = makeFakeSR(holder);
  vm.runInContext(read('assets/js/recite-by-mic.js'), ctx, { filename: 'recite-by-mic.js' });
  const R = ctx.ReciteByMic;
  if (process.env.RECITE_CFG) { Object.assign(R.config, JSON.parse(process.env.RECITE_CFG)); R.relog(); }
  R.buildIndex();
  const C = R.corpus();
  return {
    name: 'v3', R, C, ctx,
    start(page, hl) {
      ctx.currentPage = page; ctx.currentHighlightedAyah = hl || null;
      R.stop(); R.lastShown = null;
      R.start();
    },
    event(ev) {
      holder.rec.onresult(toSREvent(ev));
      const m = R.lastShown;
      if (m && m.bestAyah.page !== ctx.currentPage) ctx.currentPage = m.bestAyah.page; // goToPage
    },
    shown() {
      const m = R.lastShown;
      if (!m) return null;
      return { ayahIdx: m.bestIdx, wordIdx: m.activeWordIdx, conf: m.confidence / 100 };
    },
    rawResult() { return R.tracker().result(); }
  };
}

function oldEngine() {
  const holder = {};
  const D = loadData();
  const ctx = vm.createContext({ console, Math, Date, JSON, Map, Set, Promise, setTimeout, clearTimeout, setInterval, clearInterval });
  ctx.window = ctx;
  ctx.QURAN_DATA = D;
  ctx.SpeechRecognition = makeFakeSR(holder);
  vm.runInContext(`
    var activeData = QURAN_DATA.ayahs, currentPage = 1, isDoublePageMode = false,
        currentRightPage = 1, currentLeftPage = 2, ayahVoiceIndex = [], isVoiceIndexBuilt = false,
        currentVoiceAnchorIdx = 0, voiceLastDetectedIdx = -1, voiceActiveWordIdx = -1,
        isVoiceReciteActive = false, micRestartTimeout = null, __shown = null;
    function onVoiceAyahDetected(m) {            // same state effects as index.html
      voiceLastDetectedIdx = m.bestIdx; currentVoiceAnchorIdx = m.bestIdx;
      voiceActiveWordIdx = m.activeWordIdx; __shown = m;
      if (m.bestAyah.page !== currentPage) currentPage = m.bestAyah.page;
    }`, ctx);
  vm.runInContext(read('assets/js/legacy/recite-by-mic.v2.9.2.js'), ctx, { filename: 'v2.js' });
  vm.runInContext('buildVoiceRecitationIndex()', ctx);
  return {
    name: 'v2.9.2', ctx,
    start(page) {
      vm.runInContext(`stopVoiceRecitation(); currentPage = ${page}; currentVoiceAnchorIdx = 0;
        voiceActiveWordIdx = -1; voiceLastDetectedIdx = -1; __shown = null; startVoiceRecitation();`, ctx);
    },
    event(ev) { holder.rec.onresult(toSREvent(ev)); },
    shown() {
      const m = ctx.__shown;
      if (!m) return null;
      return { ayahIdx: m.bestIdx, wordIdx: m.activeWordIdx, conf: null };
    }
  };
}

/* shown (ayahIdx, wordIdx) -> global position in the v3 corpus */
function gpos(C, s) {
  if (!s) return null;
  if (s.wordIdx < 0) return C.ayahFirst[s.ayahIdx] - 1; // basmala: last virtual word
  return C.ayahFirst[s.ayahIdx] + s.wordIdx;
}

module.exports = { loadData, rng, chromeEvents, toSREvent, mutate, recite, chunk, newEngine, oldEngine,
  gpos, OFF_QURAN };
