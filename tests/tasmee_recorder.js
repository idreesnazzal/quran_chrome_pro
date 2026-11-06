/* Recorder metadata builder (pure part): the opt-in recorder must capture the
 * expected words, the verdicts and the session range without touching the
 * tasmee engine. usage: node tests/tasmee_recorder.js */
'use strict';
const fs = require('fs');
const path = require('path');
const store = {};
const fakeWindow = {
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  navigator: { userAgent: 'test-agent' },
  screen: { width: 390, height: 844 },
  devicePixelRatio: 2,
  document: { addEventListener: () => {} },
  Tasmee: {
    prefs: () => ({ level: 'strict' }),
    Core: { summary: () => ({ reached: 2, ok: 1, err: 1, uns: 0, types: {} }) }
  }
};
global.window = fakeWindow;
global.document = fakeWindow.document;
const src = fs.readFileSync(path.join(__dirname, '../assets/js/tasmee_recorder.js'), 'utf8');
new Function('window', src)(fakeWindow);
const R = fakeWindow.TasmeeRecorder;
if (!R || typeof R.metaFromState !== 'function') { console.error('FAIL: no TasmeeRecorder.metaFromState'); process.exit(1); }
const st = {
  mode: 'voice', seg0: 1000,
  acc: { reached: 2, ok: 1, err: 1, uns: 0, types: { 2: 1 }, added: 0, errs: [], t0: 900, fixed: null, range: 'النبأ 1' },
  X: { N: 2, E: ['عم', 'يتساءلون'], reveal: 3, as: [0, 0], pas: [-1, -1] },
  T: { st: [1, 2], ty: [0, 2], tries: [0, 1] },
  at: [{ ai: 0, w: 0 }, { ai: 0, w: 1 }],
  heard: ['عم', 'يتساءلون'], lastHeard: 'عم يتساءلون', warn: ''
};
const meta = R.metaFromState(st);
let fail = 0;
function ok(name, cond, extra) { if (cond) console.log('  ok   ' + name); else { fail++; console.error('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); } }
ok('two expected words', meta && meta.words.length === 2, meta && meta.words.length);
ok('first expected word', meta && meta.words[0].expected === 'عم', meta && meta.words[0]);
ok('second word state is error', meta && meta.words[1].state === 2, meta && meta.words[1]);
ok('range captured', meta && meta.range === 'النبأ 1', meta && meta.range);
ok('mode captured', meta && meta.mode === 'voice', meta && meta.mode);
ok('summary captured', meta && meta.summary && meta.summary.reached === 2, meta && meta.summary);
ok('device captured', meta && meta.device && meta.device.w === 390, meta && meta.device);
ok('no audio in metadata', meta && !meta.audio, meta && meta.audio);
if (fail) { console.error(fail + ' failed'); process.exit(1); }
console.log('tasmee_recorder: all checks passed');
