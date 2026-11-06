/* Tasmee Ears pure functions: CTC token boundaries and forced alignment.
 * usage: node tests/tasmee_ears.js */
'use strict';
const fs = require('fs');
const path = require('path');
const fakeWindow = { Tasmee: { earsStatus: () => {} } };
global.window = fakeWindow;
const src = fs.readFileSync(path.join(__dirname, '../assets/js/tasmee_ears.js'), 'utf8');
new Function('window', src)(fakeWindow);
const E = fakeWindow.TasmeeEars;
if (!E || !E._pure) { console.error('FAIL: no TasmeeEars._pure'); process.exit(1); }
const P = E._pure;
const vocab = { '1': '▁', '2': 'a', '3': 'b', '4': '▁', '5': 'c' };
E._state().vocab = vocab;
let fail = 0;
function ok(name, cond, extra) { if (cond) console.log('  ok   ' + name); else { fail++; console.error('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); } }

const text = P.tokenIdsToText([2, 3, 4, 5]);
ok('tokenIdsToText joins pieces', text === 'ab c', text);
const ends = P.tokenIdsToWordEnds([2, 3, 4, 5]);
ok('word ends', JSON.stringify(ends) === '[2,4]', ends);
const ctc = { '1:1:1': [2, 3, 4, 5] };
const w0 = P.getWordTokens(ctc, vocab, 1, 1, 0);
const w1 = P.getWordTokens(ctc, vocab, 1, 1, 1);
ok('first word tokens', JSON.stringify(w0) === '[2,3]', w0);
ok('second word tokens', JSON.stringify(w1) === '[4,5]', w1);
const lp = [0, 10, 0, 0, 0, 10, 0, 0, 10, 0, 0, 10];
const al = P.alignTokens(lp, 4, 3, [1], 0);
ok('alignment returns a finite score', Number.isFinite(al.score) && al.score > 0, al);
ok('alignment path length', al.path.length === 4, al.path.length);
if (fail) { console.error(fail + ' failed'); process.exit(1); }
console.log('tasmee_ears: all checks passed');
