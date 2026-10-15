/* Golden cases for the v3 tracker, driven through the LIVE path (fake Chrome
 * events: interim hypotheses that grow and get revised, then finals).
 *   node tests/run_tests.js
 * Each case names what must happen AND what must never be shown. */
'use strict';
const H = require('./harness');

const e = H.newEngine();
const R = e.R, C = e.C;
let pass = 0, fail = 0;

const idx = (sura, aya) => C.ayahs.findIndex(a => a.sura === sura && a.aya === aya);
const pageOf = (sura, aya) => C.ayahs[idx(sura, aya)].page;
const where = (s) => s ? `${C.ayahs[s.ayahIdx].sura}:${C.ayahs[s.ayahIdx].aya}#${s.wordIdx + 1}` : 'nothing';
const toks = (t) => R.tokenize(t);

/* run utterances (each = one final result, preceded by growing interims;
 * `revise` makes the last interim word wrong 3 times before the final) */
function live(page, utts, opts) {
  opts = opts || {};
  e.start(page, opts.hl);
  const seen = [];
  const finals = [];
  for (const u of utts) {
    const w = toks(u);
    for (let k = 1; k <= w.length && !opts.noInterim; k++) {
      const hyp = w.slice(0, k);
      const variants = [hyp];
      if (opts.revise && k === w.length) {
        variants.unshift(hyp.slice(0, -1).concat([hyp[k - 1] + 'ا']),
          hyp.slice(0, -1).concat([hyp[k - 1].slice(0, -1)]),
          hyp.slice(0, -1).concat(['قال']));
      }
      for (const v of variants) {
        e.event({ results: finals.map(t => ({ t, fin: true })).concat([{ t: v.join(' '), fin: false }]), resultIndex: finals.length });
        seen.push(e.shown());
      }
    }
    finals.push(opts.android && finals.length ? finals[finals.length - 1] + ' ' + w.join(' ') : w.join(' '));
    e.event({ results: finals.map(t => ({ t, fin: true })), resultIndex: finals.length - 1 });
    seen.push(e.shown());
  }
  return { seen, last: e.shown(), res: R.lastResult };
}

function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (info ? '  -> ' + info : '')); }
}
const at = (s, sura, aya, word) => !!s && C.ayahs[s.ayahIdx].sura === sura && C.ayahs[s.ayahIdx].aya === aya &&
  (word === undefined || s.wordIdx === word - 1);
const everAt = (seen, sura, aya) => seen.some(s => s && C.ayahs[s.ayahIdx].sura === sura && C.ayahs[s.ayahIdx].aya === aya);
const ayahText = (sura, aya) => C.ayahs[idx(sura, aya)].normText;
const range = (sura, a1, a2) => { const o = []; for (let a = a1; a <= a2; a++) o.push(ayahText(sura, a)); return o; };
const flips = (seen) => { // A -> B -> A between far positions
  const g = seen.filter(Boolean).map(s => H.gpos(C, s));
  const ch = g.filter((x, i) => i === 0 || x !== g[i - 1]);
  let n = 0;
  for (let i = 2; i < ch.length; i++) if (Math.abs(ch[i] - ch[i - 2]) <= 2 && Math.abs(ch[i] - ch[i - 1]) > 5) n++;
  return n;
};

console.log('text');
{
  let bad = 0;
  const D = H.loadData();
  D.ayahs.forEach((a, i) => {
    const raw = String(a[4]).replace(/\(\d+\)\s*$/, '').trim().split(/\s+/).filter(Boolean).length;
    if (raw !== C.ayahs[i].wordCount) bad++;
  });
  check('word count per ayah == data split on spaces (all 6,236)', bad === 0, bad + ' mismatches');
  check('normaliser: hamza/ta marbuta/maqsura/tashkeel', R.normalize('إِنَّ الصَّلَاةَ عَلَى') === R.normalize('ان الصلاه علي'));
  check('muqattaat spelled out -> text token', toks('الف لام ميم ذلك').join(' ') === 'الم ذلك');
  check('digits dropped, not words', toks('قل هو الله 1').join(' ') === 'قل هو الله');
}

console.log('following');
{
  const r = live(pageOf(1, 5), range(1, 5, 7).concat(['بسم الله الرحمن الرحيم', 'الم', ayahText(2, 2)]));
  check('clean across a surah boundary (1:5 -> 2:2)', at(r.last, 2, 2, C.ayahs[idx(2, 2)].wordCount), where(r.last));
  check('  ...and showed the basmala/1st ayah of al-Baqarah on the way', everAt(r.seen, 2, 1));
}
{
  const rg = H.rng(42);
  const words = toks(range(1, 5, 7).concat(range(2, 1, 5)).join(' '));
  const noisy = [];
  for (const w of words) {
    if (rg.chance(0.2)) continue;                       // 20% dropped
    if (rg.chance(0.1)) noisy.push(rg.pick(H.OFF_QURAN)); // 10% inserted
    noisy.push(rg.chance(0.2) ? w.replace(/ا/, 'أ').replace(/ه$/, 'ة') : w);
  }
  const utts = []; for (let i = 0; i < noisy.length; i += 5) utts.push(noisy.slice(i, i + 5).join(' '));
  const r = live(pageOf(1, 5), utts);
  check('same with 20% drops + 10% inserts + spelling', !!r.last && C.ayahs[r.last.ayahIdx].sura === 2 && C.ayahs[r.last.ayahIdx].aya >= 4, where(r.last));
}
{
  const r = live(pageOf(18, 2), [ayahText(18, 2), ayahText(18, 3) + ' ' + ayahText(18, 4)]);
  check('short ayah mid-stream: 18:3 shown while crossing 18:2 -> 18:4', everAt(r.seen, 18, 3) && at(r.last, 18, 4));
  const r2 = live(pageOf(55, 62), [ayahText(55, 62), ayahText(55, 63) + ' ' + ayahText(55, 64) + ' ' + ayahText(55, 65)]);
  check('one-word ayah: مدهامتان 55:64 shown between 55:63 and 55:65', everAt(r2.seen, 55, 64) && at(r2.last, 55, 65), where(r2.last));
}
{
  const r = live(pageOf(18, 5), [ayahText(18, 5), 'الارض']); // الارض occurs in 18:7, not in 18:6
  check('one common word never jumps over an ayah (18:5 + الارض -/-> 18:7)', !everAt(r.seen, 18, 7), where(r.last));
}
{
  // «يا ايها الناس» is in 20 places: a cold start waits for «اعبدوا» (unique)
  const r = live(pageOf(2, 21), ['يايها الناس اعبدوا']);
  check('merged يايها, then «الناس اعبدوا» -> 2:21 word 4, never a wrong ayah', at(r.last, 2, 21, 4) && r.seen.every(s => !s || at(s, 2, 21)), where(r.last));
  const r2 = live(pageOf(2, 21), ['يا ايها الناس اعبدوا']);
  check('split يا ايها ends on the same word (2:21 word 4)', at(r2.last, 2, 21, 4), where(r2.last));
}
{
  const r = live(pageOf(2, 31), ['قالوا سبحانك لا علم لنا', 'لا علم لنا', 'الا ما علمتنا']);
  check('restart 3 words back, then continue (2:32)', at(r.last, 2, 32, 8), where(r.last));
  const r2 = live(pageOf(2, 31), ['قالوا سبحانك سبحانك سبحانك لا علم']);
  check('word stuttered 3 times', at(r2.last, 2, 32, 4), where(r2.last));
  const r3 = live(pageOf(112, 1), [ayahText(112, 1), ayahText(112, 2), ayahText(112, 1)]);
  check('whole ayah repeated (memorising) -> back at 112:1', at(r3.last, 112, 1, 4), where(r3.last));
}
{
  const r = live(pageOf(18, 1), range(18, 1, 2), { android: true });
  const g = r.seen.filter(Boolean).map(s => H.gpos(C, s));
  const back = g.some((x, i) => i > 0 && x < g[i - 1] - 1);
  check('Android cumulative re-sends never move the highlight backwards', !back && at(r.last, 18, 2));
}
{
  const r = live(pageOf(67, 1), range(67, 1, 3), { revise: true });
  check('interim revised 3x before each final: no flip-flop', flips(r.seen) === 0 && at(r.last, 67, 3), where(r.last));
}

console.log('jumps');
{
  const r = live(pageOf(2, 255), [ayahText(2, 255), ayahText(67, 1), ayahText(67, 2)]);
  check('forward jump al-Baqarah -> al-Mulk', at(r.last, 67, 2), where(r.last));
  check('  ...without flip-flop', flips(r.seen) === 0);
  const r2 = live(pageOf(18, 41), [ayahText(18, 41), ayahText(18, 42), ayahText(18, 37), ayahText(18, 38)]);
  check('review jump backwards 18:42 -> 18:37 is followed', at(r2.last, 18, 38), where(r2.last));
}
{
  const r = live(pageOf(2, 255), ['الله لا اله الا هو الحي القيوم لا تاخذه', 'السوق', 'سنه ولا نوم']);
  check('one odd word inside a locked recitation: no jump', at(r.last, 2, 255, 12) && r.seen.filter(Boolean).every(s => C.ayahs[s.ayahIdx].sura === 2), where(r.last));
}

console.log('mutashabihat');
{
  const r = live(pageOf(55, 14), range(55, 14, 17));
  const atRefrain = r.seen.filter(Boolean).some(s => at(s, 55, 13));
  check('Rahman locked: 55:15 -> refrain is 55:16 (not 55:13) -> 55:17', everAt(r.seen, 55, 16) && !atRefrain && at(r.last, 55, 17), where(r.last));
  const r2 = live(pageOf(55, 24), range(55, 24, 25));
  check('Rahman 55:24 -> 55:25', at(r2.last, 55, 25), where(r2.last));
}
{
  const r = live(1, ['فباي الاء ربكما تكذبان']);
  check('cold «فباي الاء ربكما تكذبان» alone: no guess', r.last === null, where(r.last));
  const r2 = live(1, ['فباي الاء ربكما تكذبان', 'يرسل عليكما شواظ من نار']);
  check('  ...then disambiguating words decide: 55:35', at(r2.last, 55, 35), where(r2.last));
}

console.log('openers');
{
  const r = live(250, ['اعوذ بالله من الشيطان الرجيم', 'بسم الله الرحمن الرحيم', 'الحمد لله الذي انزل علي عبده الكتاب']);
  check('isti\'adha + basmala + al-Kahf -> 18:1', at(r.last, 18, 1, 7), where(r.last));
  check('  ...never showed 1:1 or 16:98', !everAt(r.seen, 1, 1) && !everAt(r.seen, 16, 98));
  const r2 = live(300, ['بسم الله الرحمن الرحيم', 'الحمد لله رب العالمين']);
  check('basmala + «الحمد لله رب العالمين» -> al-Fatiha 1:2', at(r2.last, 1, 2, 4), where(r2.last));
  const r3 = live(300, ['بسم الله الرحمن الرحيم', 'براءه من الله ورسوله']);
  check('basmala + «براءة من الله» -> 9:1', at(r3.last, 9, 1, 4), where(r3.last));
  const r4 = live(pageOf(16, 97), [ayahText(16, 97), ayahText(16, 98)]);
  check('16:98 itself, recited in context, IS followed', at(r4.last, 16, 98), where(r4.last));
}
{
  for (const [label, t] of [['spelled out', 'الف لام ميم ذلك الكتاب لا ريب فيه'], ['as a word', 'الم ذلك الكتاب لا ريب فيه'], ['dropped', 'ذلك الكتاب لا ريب فيه']]) {
    const r = live(pageOf(2, 1), [t]);
    check('muqatta\'at of al-Baqarah ' + label + ' -> 2:2', at(r.last, 2, 2, 5), where(r.last));
  }
}
{
  const r = live(pageOf(112, 1), range(112, 1, 4).concat(['صدق الله العظيم']));
  check('«صدق الله العظيم» after the last ayah: ignored, stays locked', at(r.last, 112, 4) && !r.res.lost, where(r.last));
  const r2 = live(pageOf(18, 1), [ayahText(18, 1), H.OFF_QURAN.slice(0, 8).join(' '), H.OFF_QURAN.slice(8, 15).join(' ')]);
  check('15 off-Quran words: no wrong position shown', at(r2.last, 18, 1) && r2.res.lost, where(r2.last) + ' lost=' + r2.res.lost);
}

console.log('one-shot (simulator)');
{
  const m = R.match('مدهامتان', idx(1, 1));
  check('cold single unique word «مدهامتان» -> 55:64', m && m.bestAyah.sura === 55 && m.bestAyah.aya === 64, m && m.bestAyah.sura + ':' + m.bestAyah.aya);
  const m2 = R.match('قل', idx(1, 1));
  check('cold single common word «قل» -> no answer', !m2, m2 && m2.bestAyah.sura + ':' + m2.bestAyah.aya);
  const m3 = R.match('قل هو الله احد الله الصمد', idx(1, 1));
  check('multi-ayah query lands on the LAST recited ayah (112:2)', m3 && m3.bestAyah.sura === 112 && m3.bestAyah.aya === 2, m3 && m3.bestAyah.sura + ':' + m3.bestAyah.aya);
}


console.log('live-mic-fixes (v3.2.0)');
{
  // mid-recitation (111 read first): «الله» is not held back waiting for «اكبر»
  const r1 = live(603, ['تبت يدا ابي لهب وتب', 'ما اغني عنه ماله وما كسب', 'سيصلي نارا ذات لهب', 'وامراته حماله الحطب', 'في جيدها حبل من مسد', 'قل هو الله']);
  check('«الله» inside «قل هو الله» highlights immediately (not held by openerPush)', at(r1.last, 112, 1, 3), where(r1.last));
  const r2 = live(604, ['قل هو الله احد', 'الله']);
  check('«الله» at start of 112:2 highlights immediately', at(r2.last, 112, 2, 1), where(r2.last));
  const r3 = live(604, ['قل اعوذ برب الفلق']);
  check('«أعوذ» after «قل» is not swallowed as isti\'adha (113:1#4)', at(r3.last, 113, 1, 4), where(r3.last));
  const r4 = live(1, ['الحمد لله ربي العالمين', 'الرحمان الرحيم', 'مالك يوم الدين', 'اياك نعبد واياك نستعين', 'اهدينا السراط المستقيم', 'صراط الذين ان عمت عليهم']);
  check('Chrome MSA spellings (ربي/الرحمان/اهدينا/السراط) + split «ان عمت» -> 1:7#4', at(r4.last, 1, 7, 4), where(r4.last));
  const r5 = live(604, ['كل هو الله احد', 'الله الصمت']);
  check('phonetic ASR swaps «كل» for «قل» and «الصمت» for «الصمد» -> 112:2#2', at(r5.last, 112, 2, 2), where(r5.last));
  const r6 = live(pageOf(94, 1), ['الم نشرح لك صدرك', 'و وضعنا عنك وزرك']);
  check('split prefix «و وضعنا» for «ووضعنا» -> 94:2#3', at(r6.last, 94, 2, 3), where(r6.last));
  const r7 = live(pageOf(78, 1), ['عما يتساءلون', 'عن النبا العظيم']);
  check('MSA «عما يتساءلون» for «عم يتساءلون» -> 78:2#3', at(r7.last, 78, 2, 3), where(r7.last));
  // «يعلم ما بين ايديهم وما خلفهم» is in 4 places (2:255, 20:110, 21:28, 22:76)
  // «يعلم ما بين ايديهم وما خلفهم ولا يحيطون» is in 2 places; «بشيء» makes it unique
  const r8 = live(pageOf(2, 255), ['يعلم ما بين ايديهم وما خلفهم ولا يحيطون بشيء']);
  check('mid-ayah start on open page (2:255 «يعلم ما بين أيديهم... بشيء») -> 2:255#35, never a twin', at(r8.last, 2, 255, 35) && r8.seen.every(s => !s || at(s, 2, 255)), where(r8.last));
  const r9 = live(1, ['الم']);
  check('first-word weak-sim guard: «الم» on Page 1 never falsely highlights 1:1#1', r9.last === null, where(r9.last));
  e.start(604);
  e.event({
    results: [
      { t: 'قل هو الله احد', fin: true },
      { alts: ['الله الصمت', 'الله الصمد'], fin: true }
    ],
    resultIndex: 0
  });
  check('N-best speech alternatives pick exact Quranic token («الله الصمد» over «الله الصمت»)', at(e.shown(), 112, 2, 2), where(e.shown()));
  // mutashabihat: wait until the words single out ONE place, then go there
  const m1 = live(59, ['رب فانظرني الي يوم يبعثون', 'قال فانك من المنظرين الي يوم الوقت المعلوم', 'قال فبعزتك لاغوينهم']);
  check('15:36-38 = 38:79-81 twins: no highlight until «فبعزتك» (38:82), then 38:82',
    at(m1.last, 38, 82) && !everAt(m1.seen, 15, 36) && !everAt(m1.seen, 15, 37) && !everAt(m1.seen, 15, 38), where(m1.last));
  const m2 = live(1, ['يا بني اسراءيل اذكروا نعمتي التي انعمت عليكم']);
  check('2:40 / 2:47 / 2:122 share «يا بني اسراءيل اذكروا نعمتي التي انعمت عليكم»: wait (nothing shown)',
    m2.seen.every(s => s === null), where(m2.last));
  const m6 = live(pageOf(33, 41), ['يا ايها الذين امنوا لا تقتلوا الصيد']);
  check('open page has «يا ايها الذين امنوا» (33:41) but the reader is at 5:95: never 33:41, lands on 5:95',
    !everAt(m6.seen, 33, 41) && at(m6.last, 5, 95), where(m6.last));
  const m3 = live(300, ['الم', 'ذلك الكتاب']);
  check('«الم» (6 surahs) waits; «ذلك الكتاب» -> 2:2', at(m3.last, 2, 2) && m3.seen.every(s => !s || at(s, 2, 2)), where(m3.last));
  const m4 = live(pageOf(55, 13), ['فباي الاء ربكما تكذبان', 'خلق الانسان من صلصال كالفخار']);
  check('al-Rahman refrain (31x) then «خلق الانسان» -> 55:14', at(m4.last, 55, 14), where(m4.last));
  const m5 = live(pageOf(109, 1), ['قل يا ايها الكافرون', 'لا اعبد ما تعبدون', 'ولا انتم عابدون ما اعبد', 'ولا انا عابد ما عبدتم', 'ولا انتم عابدون ما اعبد']);
  check('109:3 = 109:5 word for word: read in order -> 109:5 (not back to 109:3)', at(m5.last, 109, 5), where(m5.last));
  const r10 = live(604, ['الله اكبر']);
  check('takbir «الله اكبر» before reciting shows nothing (was 112:2#1)', r10.seen.every(s => s === null), where(r10.last));
  const r11 = live(604, ['قل هو الله احد', 'قل هو الله احد']);
  check('hifz: the same ayah recited twice ends on its last word (112:1#4)', at(r11.last, 112, 1, 4), where(r11.last));
  const r12 = live(pageOf(29, 45), ['واقم الصلاه ان الصلاه تنهي عن الفحشاء والمنكر ولذكر الله', 'اكبر والله يعلم ما تصنعون']);
  check('«ولذكر الله | اكبر» across two utterances keeps the real «اكبر» -> 29:45 last word',
    at(r12.last, 29, 45, C.ayahs[idx(29, 45)].wordCount), where(r12.last));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
