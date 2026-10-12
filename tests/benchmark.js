/* Benchmark: OLD (v2.9.2) vs NEW (v3) through the same live path.
 *   node tests/benchmark.js            -> held-out seeds (the numbers we report)
 *   node tests/benchmark.js --tune     -> tuning seeds (free to look at while tuning)
 *   node tests/benchmark.js --n 40     -> scenarios per family (default 60)
 * Metrics (scored at every speech event against the truth of the last word heard):
 *   acc       shown position within ±1 word of the truth
 *   falseJump shown moved >5 words away from a correct position to a wrong one
 *   flip      A -> B -> A between far positions within 3 consecutive changes
 *   lock      words needed after a real jump / cold start until correct and stable
 */
'use strict';
const H = require('./harness');

const args = process.argv.slice(2);
const TUNE = args.includes('--tune');
const N = +(args[args.indexOf('--n') + 1] || 0) || 60;
const ONLY = args.includes('--new-only');
const SEED_BASE = TUNE ? 1000 : 900000; // disjoint seed ranges: tuning vs held-out

const NOISE = (vocab) => ({ drop: 0.10, insert: 0.05, restart: 0.02, stutter: 0.03, merge: 0.03,
  split: 0.02, subst: 0.07, spell: 0.10, vocab });

function startPos(C, r, minWords) {
  for (;;) {
    const ai = r.int(C.ayahs.length - 60);
    const p = C.ayahFirst[ai];
    if (C.L - p > minWords + 10) return { ai, p };
  }
}

/* one scenario -> list of events with truth; families build them */
function scenario(fam, C, r, vocab) {
  const noise = fam.endsWith('noisy') ? NOISE(vocab) : null;
  if (fam === 'clean' || fam === 'noisy') {
    const s = startPos(C, r, 60);
    const rc = H.recite(C, s.p, 30 + r.int(30), r, noise);
    return { page: C.ayahs[s.ai].page, utts: H.chunk(rc.heard, rc.truth, r, 3, 10), jumpAt: -1 };
  }
  if (fam === 'jump' || fam === 'jump-noisy') {
    const s = startPos(C, r, 30);
    const a = H.recite(C, s.p, 20, r, noise);
    let t;
    if (r.chance(0.3)) { // review jump backwards inside the surah (18:42 -> 18:37 style)
      const back = 4 + r.int(10);
      t = { ai: Math.max(0, s.ai - back), p: C.ayahFirst[Math.max(0, s.ai - back)] };
    } else {
      do { t = startPos(C, r, 40); } while (Math.abs(C.ayahs[t.ai].page - C.ayahs[s.ai].page) < 3);
    }
    const b = H.recite(C, t.p, 30, r, noise);
    const ua = H.chunk(a.heard, a.truth, r, 3, 10), ub = H.chunk(b.heard, b.truth, r, 3, 10);
    return { page: C.ayahs[s.ai].page, utts: ua.concat(ub), jumpAt: ua.length };
  }
  if (fam === 'cold') { // reader starts mid-ayah somewhere far from the open page
    const s = startPos(C, r, 30);
    const p = s.p + r.int(Math.max(1, C.ayahLast[s.ai] - s.p + 1));
    const rc = H.recite(C, p, 25, r, null);
    let page; do { page = 1 + r.int(604); } while (Math.abs(page - C.ayahs[s.ai].page) < 5);
    return { page, utts: H.chunk(rc.heard, rc.truth, r, 1, 4), jumpAt: 0, cold: true, first4: rc.heard.slice(0, 4) };
  }
  if (fam === 'offquran') { // locked, then 15 words of ordinary speech
    const s = startPos(C, r, 30);
    const a = H.recite(C, s.p, 15, r, null);
    const last = a.truth[a.truth.length - 1];
    const junk = []; for (let i = 0; i < 15; i++) junk.push(r.pick(H.OFF_QURAN));
    const ua = H.chunk(a.heard, a.truth, r, 3, 8);
    const uj = H.chunk(junk, junk.map(() => last), r, 3, 6);
    return { page: C.ayahs[s.ai].page, utts: ua.concat(uj), jumpAt: -1, off: ua.length };
  }
  throw new Error(fam);
}

function isUnique4(C, words) { // first 4 heard words occur once in the corpus (normalised)
  if (words.length < 4) return false;
  const key = words.join(' ');
  let hits = 0;
  for (let p = 0; p + 4 <= C.L; p++) {
    if (C.words[p] === words[0] && C.words[p + 1] === words[1] && C.words[p + 2] === words[2] && C.words[p + 3] === words[3]) {
      if (++hits > 1) return false;
    }
  }
  return hits === 1 && key.length > 0;
}

function run(engine, fam, n, C, vocab, opts) {
  const st = { events: 0, correct: 0, falseJump: 0, flip: 0, wrongMoveOff: 0, locks: [], lockU4: [], lockU4fail: 0,
    calib: [], ms: [] };
  for (let i = 0; i < n; i++) {
    const r = H.rng(SEED_BASE + i * 7919 + fam.length * 104729);
    const sc = scenario(fam, C, r, vocab);
    const evs = H.chromeEvents(sc.utts, r, { reviseRate: 0.25, android: opts.android });
    engine.start(sc.page);
    let prevG = null, prevOk = false, changes = [], heardTotal = 0, jumpHeard = -1, lockedAt = -1, stable = 0;
    for (const ev of evs) {
      if (sc.jumpAt >= 0 && ev.u === sc.jumpAt && jumpHeard < 0) jumpHeard = heardTotal;
      const t0 = process.hrtime.bigint();
      engine.event(ev);
      st.ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (ev.final) heardTotal += ev.heardCount;
      const s = engine.shown();
      const g = H.gpos(C, s);
      const ok = g !== null && Math.abs(g - ev.truth) <= 1;
      const inOff = sc.off !== undefined && ev.u >= sc.off;
      if (!inOff && !(sc.cold && ev.u === 0)) { st.events++; if (ok) st.correct++; }
      if (engine.rawResult && !inOff) { // calibration on the tracker's own belief, not the held display
        const rr = engine.R.lastResult;
        if (rr && !rr.lost) st.calib.push([rr.conf, Math.abs(rr.pos - ev.truth) <= 1]);
      }
      if (prevG !== null && g !== null && g !== prevG) {
        if (prevOk && !ok && Math.abs(g - prevG) > 5) st.falseJump++;
        if (inOff && Math.abs(g - prevG) > 2) st.wrongMoveOff++;
        changes.push(g);
        if (changes.length >= 3) {
          const [a, b, c] = changes.slice(-3);
          if (Math.abs(a - c) <= 2 && Math.abs(a - b) > 5) st.flip++;
        }
      }
      // lock latency after the jump / cold start: correct for 3 events in a row
      if (jumpHeard >= 0 && lockedAt < 0 && ev.u >= sc.jumpAt) {
        stable = ok ? stable + 1 : 0;
        if (stable >= 3) lockedAt = heardTotal + (ev.final ? 0 : ev.heardCount) - jumpHeard - 2;
      }
      prevG = g === null ? prevG : g; prevOk = g === null ? prevOk : ok;
    }
    if (jumpHeard >= 0) {
      const lk = lockedAt < 0 ? 99 : Math.max(1, lockedAt);
      st.locks.push(lk);
      if (sc.cold && isUnique4(C, sc.first4.map(w => w))) { st.lockU4.push(lk); if (lk > 4) st.lockU4fail++; }
    }
  }
  return st;
}

function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '-'; }
function median(a) { if (!a.length) return '-'; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function q(a, p) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

function main() {
  const t0 = Date.now();
  const nw = H.newEngine();
  const C = nw.C;
  const vocab = Array.from(C.uni.keys());
  const engines = ONLY ? [nw] : [H.oldEngine(), nw];
  console.log(`seeds: ${TUNE ? 'TUNING' : 'HELD-OUT'}  scenarios/family: ${N}  (setup ${Date.now() - t0} ms)\n`);
  const fams = ['clean', 'noisy', 'jump', 'jump-noisy', 'cold', 'offquran'];
  const rows = [];
  const calibAll = [];
  for (const fam of fams) {
    for (const android of [false, true]) {
      if (android && fam !== 'noisy') continue;
      const label = fam + (android ? '+android' : '');
      for (const e of engines) {
        const st = run(e, fam, N, C, vocab, { android });
        if (e === nw) calibAll.push(...st.calib);
        rows.push({ label, eng: e.name, acc: pct(st.correct, st.events), fj: st.falseJump, flip: st.flip,
          lock: st.locks.length ? `med ${median(st.locks)} / fail ${st.locks.filter(x => x >= 99).length}` : '',
          u4: st.lockU4.length ? `${st.lockU4.length - st.lockU4fail}/${st.lockU4.length} ≤4w` : '',
          off: fam === 'offquran' ? st.wrongMoveOff : '', ms: `${q(st.ms, 0.5).toFixed(2)}/${q(st.ms, 0.95).toFixed(2)}/${q(st.ms, 0.99).toFixed(2)}`,
          words: st.events });
      }
    }
  }
  const cols = ['label', 'eng', 'acc', 'fj', 'flip', 'lock', 'u4', 'off', 'ms', 'words'];
  const head = { label: 'family', eng: 'engine', acc: 'acc ±1w', fj: 'falseJump', flip: 'flip', lock: 'lock words',
    u4: 'unique-4 lock', off: 'off-Quran moves', ms: 'ms p50/p95/p99', words: 'events' };
  const w = {}; cols.forEach(c => { w[c] = Math.max(String(head[c]).length, ...rows.map(r => String(r[c]).length)); });
  const line = (r) => cols.map(c => String(r[c]).padEnd(w[c])).join(' | ');
  console.log(line(head)); console.log(cols.map(c => '-'.repeat(w[c])).join('-|-'));
  rows.forEach(r => console.log(line(r)));
  // calibration of the new engine's confidence
  console.log('\nconfidence calibration (v3, all families, events with a shown position):');
  for (const [lo, hi] of [[0, 0.45], [0.45, 0.7], [0.7, 0.9], [0.9, 1.01]]) {
    const b = calibAll.filter(([c]) => c >= lo && c < hi);
    console.log(`  ${lo.toFixed(2)}-${Math.min(1, hi).toFixed(2)}: ${pct(b.filter(x => x[1]).length, b.length)} correct of ${b.length}`);
  }
  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (require.main === module) main();
module.exports = { scenario, NOISE, SEED_BASE };
