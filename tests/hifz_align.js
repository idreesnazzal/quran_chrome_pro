/* Hifz test: the alignment that finds skipped / wrong words (assets/js/hifz-test.js
 * align()), on the real text with the engine's own wordSim and tokenize.
 * Run: node tests/hifz_align.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./harness');

const eng = H.newEngine();
const { R, C, ctx } = eng;
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets/js/hifz-test.js'), 'utf8'), ctx, { filename: 'hifz-test.js' });
const HT = ctx.HifzTest;
const sim = (a, b) => R.wordSim(a, b);

const ayahIdx = (s, a) => C.ayahs.findIndex((x) => x.sura === s && x.aya === a);
const words = (s, a, b) => { const out = []; for (let k = a; k <= (b || a); k++) out.push(...C.ayahs[ayahIdx(s, k)].words); return out; };
const said = (text) => R.tokenize(text);

let pass = 0, fail = 0;
function check(name, E, T, want) {
  const t0 = Date.now();
  const r = HT.align(E, T, sim);
  const ms = Date.now() - t0;
  const got = {};
  r.labels.forEach((l, i) => { if (l !== 'ok') got[i] = l; });
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '\n     want ' + JSON.stringify(want) + '\n     got  ' + JSON.stringify(got)) + `  (${E.length}x${T.length}, ${ms} ms)`);
  ok ? pass++ : fail++;
}

const kursi = words(2, 255);
check('2:255 recited perfectly', kursi, kursi.slice(), {});
check('2:255, one word skipped (#5 «الحي»)', kursi, kursi.filter((_, i) => i !== 4), { 4: 'skip' });
check('2:255, three words skipped (#11-13)', kursi, kursi.filter((_, i) => i < 10 || i > 12), { 10: 'skip', 11: 'skip', 12: 'skip' });
const wrong = kursi.slice(); wrong[7] = 'سماء';
check('2:255, a different word said (#8)', kursi, wrong, { 7: 'wrong' });
check('2:255, a phrase repeated (self-correction)', kursi, kursi.slice(0, 12).concat(kursi.slice(8, 12), kursi.slice(12)), {});
check("isti'adha + basmala before 2:255", kursi, said('اعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم').concat(kursi), {});
check('2:255 then the start of 2:256 (not shown yet)', kursi, kursi.concat(words(2, 256).slice(0, 4)), {});
const nisa = words(4, 1);   // «يا ايها الناس»
check('Chrome merges «يا ايها» -> «ياايها»', nisa, ['ياايها'].concat(nisa.slice(2)), {});
const kahf = words(18, 1, 5);
check('18:1-5, a whole line (12 words) skipped', kahf, kahf.filter((_, i) => i < 15 || i > 26),
  Object.fromEntries(Array.from({ length: 12 }, (_, k) => [15 + k, 'skip'])));
check('18:1-5, ASR spelling noise (ة/ه, ى/ي, hamza)', kahf, kahf.map((w) => R.normalize(w.replace(/ه$/, 'ة').replace(/ي$/, 'ى'))), {});
check('2:255, short «لا» skipped after a long word', kursi, kursi.filter((_, i) => i !== 7), { 7: 'skip' });
const nas = words(114, 1, 6);
check('114, «من» skipped (short word between two)', nas, nas.filter((_, i) => i !== nas.indexOf('من')), { [nas.indexOf('من')]: 'skip' });
check('112, last word missing at the very end', words(112, 1, 4), words(112, 1, 4).slice(0, -1), { 14: 'skip' });

// a long stretch (2:1-40, ~600 words) stays fast
const long = words(2, 1, 40);
check('2:1-40 perfect (long stretch)', long, long.slice(), {});
const t0 = Date.now(); HT.align(long, long.filter((_, i) => i % 50 !== 7), sim); const ms = Date.now() - t0;
console.log((ms < 1500 ? 'ok   ' : 'FAIL ') + `2:1-40 with 12 skips aligns in ${ms} ms (< 1500)`); ms < 1500 ? pass++ : fail++;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
