// Mutashabihat test: start reciting at places whose first words are shared
// with other places in the Quran. For each start p, U = the uniqueness point
// (how many words until the phrase exists in ONE place only). An ideal engine
// moves at word U, never earlier to a wrong place.
// node tests/mutashabihat.js [CFG-json] [scenarios per bucket and mode, default 40]
// SHOWW=1 prints every wrong move and every place never found.
'use strict';
const path = require('path');
const [cfgJson, perB] = process.argv.slice(2);
const H = require('./harness.js');
const e = H.newEngine(); const C = e.C, R = e.R;
if (cfgJson) Object.assign(R.config, JSON.parse(cfgJson));
if (R.relog) R.relog();
const PER = +perB || 50;

// real-word sequence (no virtual basmalas)
const real = []; for (let g = 0; g < C.L; g++) if (!C.virt[g]) real.push(g);
const W = real.map((g) => C.words[g]);
const N = W.length, KMAX = 14;
const U = new Int16Array(N).fill(99);
for (let k = 1; k <= KMAX; k++) {
  const cnt = new Map();
  for (let i = 0; i + k <= N; i++) { const s = W.slice(i, i + k).join(' '); cnt.set(s, (cnt.get(s) || 0) + 1); }
  for (let i = 0; i + k <= N; i++) if (U[i] === 99 && cnt.get(W.slice(i, i + k).join(' ')) === 1) U[i] = k;
}
const buckets = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 6], [7, 10], [11, 99]];
const isAyahStart = (i) => C.wordOf[real[i]] === 0;
// stats of the whole Quran: uniqueness point at ayah starts
const hist = buckets.map(([a, b]) => { let n = 0, t = 0; for (let i = 0; i < N; i++) if (isAyahStart(i)) { t++; if (U[i] >= a && U[i] <= b) n++; } return (100 * n / t).toFixed(1) + '%'; });
if (!cfgJson) console.log('ayah starts by words-needed-to-be-unique', buckets.map((b) => b.join('-')).join(' / '), '=>', hist.join(' / '));

let dbg = 0; let rs = 12345; const rnd = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
const res = [];
const MODES = ['cold', 'jump', 'open'];
const tot = {}; MODES.forEach((m) => tot[m] = { n: 0, scWrong: 0, wrong: 0, early: 0, lag: [], first: [], never: 0 });
for (const [a, b] of buckets) {
  const cand = []; for (let i = 0; i < N - 40; i++) if (U[i] >= a && U[i] <= b && (isAyahStart(i) || rnd() < 0.15)) cand.push(i);
  const row = { U: a === b ? '' + a : a + '-' + (b === 99 ? '+' : b) };
  for (let s = 0; s < PER * 3 && cand.length; s++) {
    const mode = MODES[s % 3], st = tot[mode];
    const i0 = cand[Math.floor(rnd() * cand.length)];
    const truthPage = C.ayahs[C.ayahOf[real[i0]]].page;
    let page; do { page = 1 + Math.floor(rnd() * 604); } while (Math.abs(page - truthPage) < 5);
    const finals = [];
    const feed = (words, truths, scoreIt) => {
      for (let c = 0; c < words.length;) {
        const len = Math.min(words.length - c, 3 + Math.floor(rnd() * 3));
        const utt = words.slice(c, c + len);
        for (let k = 1; k <= len; k++) {
          const fin = k === len;
          const t = utt.slice(0, k).join(' ');
          if (fin) finals.push(t);
          e.event({ results: finals.map((f) => ({ t: f, fin: true })).concat(fin ? [] : [{ t, fin: false }]), resultIndex: fin ? finals.length - 1 : finals.length });
          if (scoreIt) scoreIt(c + k, truths[c + k - 1]);
        }
        c += len;
      }
    };
    if (mode === 'jump') { // locked somewhere else first
      let j0; do { j0 = Math.floor(rnd() * (N - 40)); } while (U[j0] > 3 || Math.abs(j0 - i0) < 400);
      e.start(C.ayahs[C.ayahOf[real[j0]]].page);
      feed(W.slice(j0, j0 + 8), real.slice(j0, j0 + 8), null);
    } else e.start(mode === 'open' ? truthPage : page);
    const nW = Math.min(KMAX + 6, U[i0] + 6);
    let lastG = H.gpos(C, e.shown()), locked = -1, wrongHere = 0;
    feed(W.slice(i0, i0 + nW), real.slice(i0, i0 + nW), (k, truth) => {
      const g = H.gpos(C, e.shown());
      if (g !== null && g !== lastG) {
        const ok = Math.abs(g - truth) <= 1;
        const continuation = lastG !== null && g > lastG && g - lastG <= 3 && locked < 0; // reader might just go on
        if (!ok && !continuation) { wrongHere++; if (process.env.SHOWW && dbg++ < 40) { const rr = R.lastResult, A = (q) => C.ayahs[C.ayahOf[q]]; console.log(`WRONG ${mode} U=${U[i0]} k=${k} truth ${A(truth).sura}:${A(truth).aya}#${C.wordOf[truth]+1} shown ${A(g).sura}:${A(g).aya}#${C.wordOf[g]+1} conf=${rr ? rr.conf.toFixed(2) : '?'} heard=«${W.slice(i0, i0 + k).join(' ')}»`); } }
      }
      if (g !== null && Math.abs(g - truth) <= 1 && locked < 0) locked = k;
      lastG = g;
    });
    st.n++; st.wrong += wrongHere; if (wrongHere) st.scWrong++;
    row[mode + ' wrong'] = (row[mode + ' wrong'] || 0) + (wrongHere ? 1 : 0);
    if (locked < 0) { st.never++; if (process.env.SHOWW) console.log(`NEVER ${mode} U=${U[i0]} at ${C.ayahs[C.ayahOf[real[i0]]].sura}:${C.ayahs[C.ayahOf[real[i0]]].aya}#${C.wordOf[real[i0]]+1} heard=«${W.slice(i0, i0 + nW).join(' ')}»`); }
    else { if (mode === 'open') st.first.push(locked); else st.lag.push(locked - Math.min(U[i0], nW)); if (locked < U[i0] && mode !== 'open') st.early++; }
  }
  res.push(row);
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : '-'; };
const p90 = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.9)] : '-'; };
const summ = MODES.map((m) => { const t = tot[m]; return { mode: m, scenarios: t.n, 'with a wrong move': t.scWrong + ' (' + (100 * t.scWrong / t.n).toFixed(1) + '%)',
  'words after unique point (med/p90)': m === 'open' ? '-' : med(t.lag) + '/' + p90(t.lag), 'open: words until first show (med/p90)': m === 'open' ? med(t.first) + '/' + p90(t.first) : '-', 'never found': t.never }; });
console.log((cfgJson || 'default'));
console.table(res); console.table(summ);
