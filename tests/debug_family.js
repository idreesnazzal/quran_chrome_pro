/* node tests/debug_family.js <family> [n] [--tune] : print scenarios with false jumps / misses */
'use strict';
const H = require('./harness');
const B = require('./benchmark');
const fam = process.argv[2], n = +process.argv[3] || 30;
const e = H.newEngine(), C = e.C, vocab = Array.from(C.uni.keys());
const fmt = (g) => g == null ? '-' : g < 0 ? 'START' : `${C.ayahs[C.ayahOf[g]].sura}:${C.ayahs[C.ayahOf[g]].aya}#${C.wordOf[g] + 1}`;
for (let i = 0; i < n; i++) {
  const r = H.rng(B.SEED_BASE + i * 7919 + fam.length * 104729);
  const sc = B.scenario(fam, C, r, vocab);
  const evs = H.chromeEvents(sc.utts, r, { reviseRate: 0.25 });
  e.start(sc.page);
  const lines = []; let bad = 0, prevG = null, prevOk = false;
  for (const ev of evs) {
    e.event(ev);
    const s = e.shown(), g = H.gpos(C, s), ok = g !== null && Math.abs(g - ev.truth) <= 1;
    const rr = e.R.lastResult;
    const fj = prevG !== null && g !== null && g !== prevG && prevOk && !ok && Math.abs(g - prevG) > 5;
    if (fj) bad++;
    const txt = ev.results[ev.results.length - 1].t.split(' ').slice(-3).join(' ');
    lines.push(`${ev.final ? 'F' : 'i'} u${ev.u} [..${txt}] truth ${fmt(ev.truth)} shown ${fmt(g)} ${ok ? '' : 'X'}${fj ? ' FALSEJUMP' : ''} raw ${rr ? fmt(rr.pos) + ' c' + rr.conf.toFixed(2) + (rr.lost ? ' L' : '') + ' g' + rr.lastGain.toFixed(1) : ''}`);
    if (g !== null) { prevG = g; prevOk = ok; }
  }
  const misses = lines.filter(l => / X/.test(l)).length;
  if (bad || (process.argv.includes('--miss') && misses >= 4)) { console.log(`=== scenario ${i} page ${sc.page}`); console.log(lines.join('\n')); }
}
