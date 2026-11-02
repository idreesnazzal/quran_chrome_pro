/* Tasmee core (assets/js/tasmee.js): the strict cursor on the real text.
 * usage: node tests/tasmee_core.js */
'use strict';
const H = require('./harness');
const RM = require('../assets/js/recite-by-mic.js');
const Core = require('../assets/js/tasmee.js');
const { S, T: TY } = Core;

const C = RM.buildCorpus(H.loadData().ayahs);
function ayahIdx(s, a1, a2) {
  const out = [];
  C.ayahs.forEach((A, i) => { if (A.sura === s && A.aya >= a1 && A.aya <= (a2 || a1)) out.push(i); });
  return out;
}
function test(list, o) {
  const E = [], as = [], pas = [];
  let prev = -1, last = -2;
  list.forEach((ai) => {
    const start = E.length, ps = ai === last + 1 ? prev : -1;
    C.ayahs[ai].words.forEach((w) => { E.push(w); as.push(start); pas.push(ps); });
    prev = start; last = ai;
  });
  const X = Core.makeCtx(E, as, pas, Object.assign({ sim: RM.wordSim }, o));
  return { X, T: Core.create(E.length), E };
}
const tok = (s) => RM.tokenize(s);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
}
const states = (t, n) => Array.from(t.T.st.slice(0, n || t.X.N));

// 1. al-Fatiha read correctly, one final per ayah
let t = test(ayahIdx(1, 1, 7));
['بسم الله الرحمن الرحيم', 'الحمد لله رب العالمين', 'الرحمن الرحيم', 'مالك يوم الدين', 'اياك نعبد واياك نستعين',
  'اهدنا الصراط المستقيم', 'صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين'].forEach((s) => Core.feed(t.T, t.X, tok(s), true));
ok('al-Fatiha: every word right, cursor at the end', t.T.i === t.X.N && states(t).every((x) => x === S.OK), Core.summary(t.T, t.X));
// Chrome's MSA spellings are no mistake
t = test(ayahIdx(1, 1, 7));
['بسم الله الرحمان الرحيم', 'الحمد لله ربي العالمين', 'الرحمان الرحيم', 'مالك يوم الدين', 'اياك نعبد واياك نستعين', 'اهدينا السراط المستقيم'].forEach((s) => Core.feed(t.T, t.X, tok(s), true));
ok('MSA spellings «الرحمان», «ربي العالمين», «اهدينا السراط» pass', Core.summary(t.T, t.X).err === 0 && t.T.i === 20, Core.summary(t.T, t.X));

// 2. a skipped word stops the test at that word
t = test(ayahIdx(1, 2));
Core.feed(t.T, t.X, tok('الحمد رب العالمين'), true);
ok('skip «لله»: red, cursor stays on it', t.T.i === 1 && t.T.st[1] === S.ERR && (t.T.ty[1] & TY.SKIP) && t.T.tries[1] === 1, { i: t.T.i, st: states(t), ty: t.T.ty[1] });
ok('...the words after it stay covered', t.T.st[2] === S.HID && t.T.st[3] === S.HID);
Core.feed(t.T, t.X, tok('لله رب العالمين'), true);
ok('...said right: «لله» red-translucent (fixed), the rest right', t.T.st[1] === S.FIX && t.T.st[2] === S.OK && t.T.st[3] === S.OK && t.T.i === 4, states(t));

// 3. «في» instead of «بـ»
t = test(ayahIdx(1, 1));
Core.feed(t.T, t.X, tok('في اسم الله'), true);
ok('«في اسم» for «بسم»: substitution, ONE attempt', t.T.i === 0 && t.T.st[0] === S.ERR && (t.T.ty[0] & TY.SUB) && t.T.tries[0] === 1, { st: states(t), ty: t.T.ty[0], tries: t.T.tries[0] });
Core.feed(t.T, t.X, tok('بسم الله الرحمن الرحيم'), true);
ok('...then right: fixed', t.T.st[0] === S.FIX && t.T.i === 4);

// 4. a dropped «و»: very strict = mistake; strict = Chrome's fault, passes
const a24 = ayahIdx(2, 4);
t = test(a24, { level: 'very' });
Core.feed(t.T, t.X, tok('الذين يؤمنون بما انزل اليك'), true);
ok('very strict: «الذين» for «والذين» = حرف عطف', t.T.i === 0 && (t.T.ty[0] & TY.ATF) && t.T.st[0] === S.ERR, { st: states(t, 5), ty: t.T.ty[0] });
t = test(a24, { level: 'strict' });
Core.feed(t.T, t.X, tok('الذين يؤمنون بما انزل اليك'), true);
ok('strict: the same passes', t.T.i === 5 && Core.summary(t.T, t.X).err === 0, states(t, 5));
t = test(ayahIdx(1, 5), { level: 'very' });
Core.feed(t.T, t.X, tok('اياك نعبد اياك'), true);
ok('very strict: «اياك» for «واياك» at a pause = mistake, not a restart', t.T.i === 2 && (t.T.ty[2] & TY.ATF), { i: t.T.i, ty: t.T.ty[2] });
Core.feed(t.T, t.X, tok('اياك نعبد واياك نستعين'), true);
ok('...a real restart of the ayah afterwards is fine', t.T.i === 4 && t.T.st[2] === S.FIX, Array.from(t.T.st));
t = test(a24, { level: 'strict' });
Core.feed(t.T, t.X, tok('فالذين يؤمنون'), true);
ok('strict still catches «ف» for «و»', t.T.i === 0 && (t.T.ty[0] & TY.ATF), { st: states(t, 3), ty: t.T.ty[0] });

// 5. three wrong attempts reveal the word; «never» keeps waiting
t = test(ayahIdx(1, 2), { reveal: 3 });
Core.feed(t.T, t.X, tok('الحمد للناس'), true);
Core.feed(t.T, t.X, tok('للناس'), true);
ok('2 attempts: still red, cursor on it', t.T.i === 1 && t.T.st[1] === S.ERR && t.T.tries[1] === 2, { i: t.T.i, tries: t.T.tries[1] });
Core.feed(t.T, t.X, tok('للعالم'), true);
ok('3rd attempt: shown (red-translucent), cursor moves on', t.T.i === 2 && t.T.st[1] === S.REV && (t.T.ty[1] & TY.REV), { i: t.T.i, st: states(t) });
t = test(ayahIdx(1, 2), { reveal: 0 });
Core.feed(t.T, t.X, tok('الحمد'), true);
for (let k = 0; k < 5; k++) Core.feed(t.T, t.X, tok('للناس'), true);
ok('«never»: 5 attempts, still waiting', t.T.i === 1 && t.T.st[1] === S.ERR && t.T.tries[1] === 5, { i: t.T.i, tries: t.T.tries[1] });
// one long wrong stretch without a pause is ONE attempt
t = test(ayahIdx(1, 2, 4), { reveal: 3 });
Core.feed(t.T, t.X, tok('الحمد رب العالمين الرحمن الرحيم مالك يوم'), true);
ok('reciting on past a skipped word = 1 attempt, not 6', t.T.i === 1 && t.T.tries[1] === 1, { i: t.T.i, tries: t.T.tries[1] });
// the reciter went on after the 3rd: the word that revealed it counts at its place
t = test(ayahIdx(1, 2), { reveal: 3 });
Core.feed(t.T, t.X, tok('الحمد رب'), true); Core.feed(t.T, t.X, tok('رب'), true); Core.feed(t.T, t.X, tok('رب العالمين'), true);
ok('3rd skip «رب العالمين»: «لله» shown, «رب العالمين» right', t.T.i === 4 && t.T.st[1] === S.REV && t.T.st[2] === S.OK && t.T.st[3] === S.OK, states(t));

// 6. going back is no mistake
t = test(ayahIdx(1, 2, 3));
Core.feed(t.T, t.X, tok('الحمد لله رب'), true);
Core.feed(t.T, t.X, tok('الحمد لله رب العالمين الرحمن الرحيم'), true);
ok('restart the ayah from its start: no mistake', t.T.i === 6 && Core.summary(t.T, t.X).err === 0, states(t));
t = test(ayahIdx(1, 2, 3));
Core.feed(t.T, t.X, tok('الحمد لله لله رب رب العالمين'), true);
ok('repeating the last word: no mistake', t.T.i === 4 && Core.summary(t.T, t.X).err === 0, states(t));
t = test(ayahIdx(112, 1, 4));
Core.feed(t.T, t.X, tok('قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له'), true);
Core.feed(t.T, t.X, tok('لم يلد ولم يولد ولم يكن له كفوا احد'), true);
ok('back to the previous ayah\'s start and on: no mistake', t.T.i === t.X.N && Core.summary(t.T, t.X).err === 0, states(t));

// 7. isti'adha + basmala before a surah are not extra words
t = test(ayahIdx(112, 1, 2));
Core.feed(t.T, t.X, tok('أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم قل هو الله احد الله الصمد'), true);
ok('isti\'adha + basmala + al-Ikhlas 1-2: no mistake', t.T.i === t.X.N && Core.summary(t.T, t.X).err === 0, states(t));
t = test(ayahIdx(112, 1));
Core.feed(t.T, t.X, tok('قل هو الله احد صدق الله العظيم'), true);
ok('«صدق الله العظيم» at the end: no mistake', Core.summary(t.T, t.X).err === 0);

// 8. extra word / word order
t = test(ayahIdx(1, 2));
Core.feed(t.T, t.X, tok('الحمد لله كثيرا رب العالمين'), true);
ok('an extra word «كثيرا»: زيادة on the next word, then on', t.T.i === 4 && (t.T.ty[2] & TY.EXTRA) && !(t.T.ty[2] & TY.SUB) && t.T.st[2] === S.FIX, { ty: t.T.ty[2], st: states(t) });
t = test(ayahIdx(1, 2));
Core.feed(t.T, t.X, tok('الحمد رب لله رب العالمين'), true);
ok('«رب» before «لله»: تقديم وتأخير', t.T.i === 4 && (t.T.ty[1] & TY.ORDER) && !(t.T.ty[1] & TY.SKIP), { ty: t.T.ty[1], st: states(t) });

// 9. interim results: the newest word is not judged, a replay never touches the committed state
t = test(ayahIdx(1, 2));
let sh = Core.feed(Core.clone(t.T), t.X, tok('الحمد للع'), false);
ok('interim «الحمد للع»: «الحمد» shown, the cut word not judged', sh.i === 1 && sh.st[1] === S.HID && t.T.i === 0, { i: sh.i, st: Array.from(sh.st) });
sh = Core.feed(Core.clone(t.T), t.X, tok('الحمد لله رب'), false);
ok('interim grows: 3 words shown', sh.i === 3);
Core.feed(t.T, t.X, tok('الحمد لله رب العالمين'), true);
ok('final: all 4', t.T.i === 4 && Core.summary(t.T, t.X).err === 0);
t = test(ayahIdx(1, 2));
sh = Core.feed(Core.clone(t.T), t.X, tok('الحمد للحق رب'), false);
ok('interim with a wrong word: red in the replay only', sh.st[1] === S.ERR && t.T.st[1] === S.HID);
Core.feed(t.T, t.X, tok('الحمد لله رب'), true);
ok('...the final corrects it: no stale mistake', t.T.st[1] === S.OK && t.T.ty[1] === 0, { st: states(t), ty: t.T.ty[1] });

// 10. merged / split words
const a221 = ayahIdx(2, 21);
t = test(a221);
Core.feed(t.T, t.X, ['ياايها', 'الناس', 'اعبدوا', 'ربكم'], true);
ok('«ياايها» as one word = «يا ايها»', t.T.i === 5 && Core.summary(t.T, t.X).err === 0, { E: t.E.slice(0, 4), st: states(t, 5) });

// 11. help and eye mode
t = test(ayahIdx(1, 2));
Core.feed(t.T, t.X, tok('الحمد'), true); Core.hint(t.T, t.X);
ok('help: the word shown, counted as a mistake', t.T.i === 2 && t.T.st[1] === S.HINT && (t.T.ty[1] & TY.HINT) && Core.summary(t.T, t.X).err === 1);
t = test(ayahIdx(1, 2));
Core.eyeNext(t.T, t.X); Core.eyeNext(t.T, t.X);
ok('eye: Home twice = 2 shown', t.T.i === 2 && t.T.st[0] === S.OK && t.T.st[1] === S.OK);
Core.eyeMark(t.T);
ok('eye: «أخطأت» marks the last shown word', t.T.st[1] === S.MARK && (t.T.ty[1] & TY.MARK) && t.T.tries[1] === 1);
Core.eyeBack(t.T);
ok('eye: End covers it again, the mistake is kept', t.T.i === 1 && t.T.st[1] === S.HID && (t.T.ty[1] & TY.MARK));
Core.eyeNext(t.T, t.X);
ok('eye: shown again = still marked', t.T.st[1] === S.MARK);
Core.eyeMark(t.T);
ok('eye: «أخطأت» again = undo', t.T.st[1] === S.OK && !(t.T.ty[1] & TY.MARK) && t.T.tries[1] === 0);
ok('summary counts reached words only', Core.summary(t.T, t.X).reached === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
