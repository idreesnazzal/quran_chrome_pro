/* Debug trace: feed words one by one (final results) and print the belief.
 *   node tests/trace.js <page> "words ..." ["more words" ...]
 * Each extra argument is one final result. */
'use strict';
const H = require('./harness');
const e = H.newEngine();
const C = e.C;
const page = +process.argv[2] || 1;
const utts = process.argv.slice(3);
e.start(page);
const fmt = (g) => g < 0 ? 'START' : `${C.ayahs[C.ayahOf[g]].sura}:${C.ayahs[C.ayahOf[g]].aya}#${C.wordOf[g] + 1}${C.virt[g] ? '(bsm)' : ''} ${C.words[g]}`;
let finals = [];
for (const u of utts) {
  for (const w of e.R.tokenize(u)) {
    finals.push(w);
    e.event({ results: finals.map(t => ({ t, fin: true })), resultIndex: finals.length - 1, truth: 0 });
    const res = e.rawResult();
    const tr = e.R.tracker();
    const top = Array.from(tr.alpha.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const s = e.shown();
    console.log(`${w.padEnd(12)} -> raw ${res ? fmt(res.pos) : '-'} conf ${res ? res.conf.toFixed(3) : '-'} lost ${res && res.lost} gain ${tr.alpha.rawBest && tr.alpha.rawBest.toFixed(2)}` +
      ` | shown ${s ? fmt(H.gpos(C, s)) : '-'}\n      top: ${top.map(([g, v]) => fmt(g) + ' ' + v.toFixed(1)).join(' ; ')}`);
  }
}
