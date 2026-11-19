/* «تسميع سلس» (assets/js/tasmee.js, feedS): no verdict — a cover opens when its word is heard or passed, a word
 * after the last one heard waits, nothing is ever red or yellow. Unit cases on the real text, then the reader's
 * own Chrome sessions (tests/data/tasmee_real_*.json) against engine v2 on the same finals.
 * usage: node tests/tasmee_smooth.js */
'use strict';
const H = require('./harness');
const RM = require('../assets/js/recite-by-mic.js');
const Core = require('../assets/js/tasmee.js');
const { S } = Core;
const C = RM.buildCorpus(H.loadData().ayahs);
const BI = new Set();
for (let p = 0; p + 1 < C.L; p++) if (!C.virt[p] && !C.virt[p + 1]) BI.add(C.words[p] + ' ' + C.words[p + 1]);
const tok = (s) => RM.tokenize(s);
function test(sura, a1, a2, o) {
  const E = [], as = [], pas = [], ref = [];
  let prev = -1;
  C.ayahs.forEach((A) => {
    if (A.sura !== sura || A.aya < a1 || A.aya > a2) return;
    const st = E.length;
    A.words.forEach((w, wi) => { E.push(w); as.push(st); pas.push(prev); ref.push(A.aya + ':' + (wi + 1)); });
    prev = st;
  });
  const X = Core.makeCtx(E, as, pas, Object.assign({ smooth: true, sim: RM.wordSim, bi: (a, b) => BI.has(a + ' ' + b) }, o));
  const t = { X, T: Core.create(E.length), E, ref };
  t.say = (s, final) => { t.T = Core.feed(final === false ? Core.clone(t.T) : t.T, X, tok(s), final !== false); return t; };
  t.peek = (s) => Core.feed(Core.clone(t.T), X, tok(s), false);
  t.at = () => ref[t.T.i] || 'END';
  t.open = (T) => E.map((w, k) => ((T || t.T).st[k] !== S.HID ? ref[k] : null)).filter(Boolean);
  t.shut = (from, to) => ref.slice(ref.indexOf(from), ref.indexOf(to) + 1).filter((r) => t.T.st[ref.indexOf(r)] === S.HID);
  // nothing but «covered» and «open»: no red, no yellow, no mistake type, in this state
  t.clean = (T) => { T = T || t.T; for (let k = 0; k < E.length; k++) if ((T.st[k] !== S.HID && T.st[k] !== S.OK) || T.ty[k]) return false; return true; };
  return t;
}
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
}

ok('makeCtx({smooth}) picks the smooth engine, even over «صارم جدًا»', test(1, 1, 1).X.engine === 'smooth' && test(1, 1, 1, { level: 'very' }).X.engine === 'smooth');

// ---- reading it right
let t = test(1, 1, 7);
['بسم الله الرحمن الرحيم', 'الحمد لله رب العالمين', 'الرحمن الرحيم', 'مالك يوم الدين', 'اياك نعبد واياك نستعين', 'اهدنا الصراط المستقيم',
  'صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين'].forEach((s) => t.say(s));
ok('al-Fatiha read right: every word open, at the end', t.at() === 'END' && t.open().length === t.E.length && t.clean());

// ---- Chrome's noise inside an utterance: opened, never coloured
t = test(78, 1, 16);
['عم يتساءلون عن النبا العظيم الذي هم فيه مختلفون', 'كلا سيعلمون ثم كلا سيعلمون', 'الم نجعل الاردن هذا', 'والجبال اوتادا وخلقناكم ازواجا'].forEach((s) => t.say(s));
ok('«الاردن هذا» for «الارض مهادا», then the text: both open, plain, the test at 78:9', t.at() === '9:1' && !t.shut('1:1', '8:2').length && t.clean(), { at: t.at(), shut: t.shut('1:1', '8:2') });
t = test(78, 1, 16);
['عم يتساءلون عن النبا العظيم الذي هم فيه مختلفون', 'كلا سيعلمون ثم كلا سيعلمون', 'الم نجعل الارض فراشا والجبال اوتادا'].forEach((s) => t.say(s));
ok('a wrong word inside the reading («فراشا» for «مهادا»): passed, opened, no red', t.at() === '8:1' && !t.shut('1:1', '7:2').length && t.clean(), { at: t.at() });
t = test(102, 1, 8);
['الهاكم التكاثر حتى زرتم المقابر', 'كلا سوف تعلمون ثم كلا سوف تعلمون', 'كلا لو تعلمون علم اليقين لترون الجحيم', 'ثم لتسالن يومئذ عن النعيم'].forEach((s) => t.say(s));
ok('102:7 left out: the test follows to the end, nothing red', t.at() === 'END' && t.clean(), { at: t.at() });

// ---- the last word heard decides how far it opens
t = test(78, 1, 8);
t.say('عم يتساءلون عن النبا العظيم الذي هم فيه');
t.say('مسرورون');
ok('a wrong last word («مسرورون» for «مختلفون»), then a pause: it stays covered, nothing red', t.at() === '3:4' && t.T.st[t.ref.indexOf('3:4')] === S.HID && t.clean(), { at: t.at() });
t.say('مختلفون');
ok('...said right: it opens, the test goes on', t.at() === '4:1' && t.T.st[t.ref.indexOf('3:4')] === S.OK && t.clean());
t = test(78, 1, 8);
t.say('عم يتساءلون عن النبا العظيم الذي هم فيه مسرورون كلا سيعلمون');
ok('...or the reader goes on: the wrong word is passed and opens (no verdict)', t.at() === '5:1' && t.T.st[t.ref.indexOf('3:4')] === S.OK && t.clean(), { at: t.at() });
t = test(78, 1, 8);
t.say('عم يتساءلون عن النبا').say('العظيم الذي');
ok('...and a word not reached yet is never opened ahead', t.at() === '3:2' && t.T.st[t.ref.indexOf('3:2')] === S.HID && t.T.st[t.ref.indexOf('3:3')] === S.HID);

// ---- interim words: open at once, from the first letters; the committed state untouched
t = test(78, 1, 8);
t.say('عم يتساءلون عن النبا العظيم');
let iv = t.peek('الذي هم فيه مختل');
ok('interim «مختل» of «مختلفون»: opens at once', iv.i === t.ref.indexOf('4:1') && iv.st[t.ref.indexOf('3:4')] === S.OK && t.clean(iv), { i: iv.i });
ok('...the committed state is untouched', t.at() === '3:1');
iv = t.peek('الذي هم فيه مخلفين ثم');
ok('interim noise at the end opens nothing past the last word heard', iv.st[t.ref.indexOf('4:1')] === S.HID && t.clean(iv), { i: iv.i, open: t.open(iv) });
iv = t.peek('الذي هم');
ok('interim: open exactly as far as heard («الذي هم»)', iv.i === t.ref.indexOf('3:3') && t.clean(iv), { i: iv.i });
t = test(78, 1, 5);
t.say('عم يتساء').say('لون عن النبا العظيم');
ok('«عم يتساء» | «لون عن النبا العظيم»: one word cut in two, all open', t.at() === '3:1' && !t.shut('1:1', '2:3').length && t.clean(), { at: t.at() });

// ---- other talk, repeating, a far move, lost audio
t = test(78, 1, 10);
t.say('عم يتساءلون عن النبا العظيم').say('طيب شو دخل اسرائيل بالموضوع القصه انه').say('لازم نرجع للبدايه');
ok('talk that is not the text: nothing moves, nothing opens', t.at() === '3:1' && t.open().length === 5 && t.clean(), { at: t.at(), open: t.open() });
t = test(2, 10, 12);
t.say('في قلوبهم مرض فزادهم الله مرضا ولهم عذاب اليم بما كانوا يكذبون').say('فيما كانوا يكذبون بما كانوا يكذبون');
const before = t.open().length;
t.say('واذا قيل لهم لا تفسدوا في الارض قالوا انما نحن مصلحون');
ok('saying words again: nothing covered again, the test goes on', before === t.ref.indexOf('11:1') && t.at() === '12:1' && t.clean(), { before, at: t.at() });
t = test(2, 1, 20);
t.say('الم ذلك الكتاب لا ريب فيه هدى للمتقين').say('ومن الناس من يقول امنا بالله وباليوم الاخر وما هم بمؤمنين يخادعون الله والذين امنوا');
ok('a move far ahead (2:2 -> 2:8, 50 words): the words between stay covered (not recited)', /^9:/.test(t.at()) && t.T.st[t.ref.indexOf('3:1')] === S.HID && t.T.st[t.ref.indexOf('8:1')] === S.OK && t.clean(), { at: t.at() });
t = test(2, 40, 46);
t.say('يا بني اسرائيل اذكروا نعمتي التي انعمت عليكم واوفوا بعهدي اوف بعهدكم واياي فارهبون');
t.say('وامنوا بما انزلت مصدقا لما معكم ولا تكونوا اول كافر به ولا تشتروا باياتي ثمنا قليلا واياي فاتقون');
t.T.gap = true;
t.say('الصلاه واتوا الزكاه واركعوا مع الراكعين اتامرون الناس بالبر وتنسون انفسكم وانتم تتلون الكتاب افلا تعقلون');
ok('words lost when the recogniser restarted: open, plain, the test at 2:45', t.at() === '45:1' && !t.shut('40:1', '44:10').length && t.clean(), { at: t.at() });
t = test(2, 6, 8);
t.say('ان الذين كفروا سواء عليهم اانذرتهم ام لم تنذرهم لا يؤمنون').say('ختم الله على قلوبهم وعلى سمعهم وعلى ابصارهم غشاوه ولهم عذاب اليم');
ok('«عذاب اليم» for «عذاب عظيم» at the end (red in the judging engine): «عظيم» just stays covered', t.at() === '7:12' && t.T.st[t.ref.indexOf('7:12')] === S.HID && t.clean(), { at: t.at() });
t.say('ومن الناس من يقول');
ok('...the reader goes on: it opens, plain', t.at() === '8:5' && t.T.st[t.ref.indexOf('7:12')] === S.OK && t.clean(), { at: t.at() });

// ---- the reader's own sessions: as far as v2 (or further), and never a colour
function replay(file, sura, a1, a2, o) {
  const t = test(sura, a1, a2, o);
  let first = true;
  require('./data/' + file).events.forEach(([, kind, txt]) => {
    if (kind === 'end') { t.T.gap = true; return; }
    if (kind !== 'final' || !txt.trim()) return;
    if (first) {
      first = false;
      const tk = tok(txt);
      for (let k = 0; k + 1 < t.E.length; k++) if (Core.eqStrict(t.E[k], tk[0]) && Core.eqStrict(t.E[k + 1], tk[1])) { t.T = Core.create(t.E.length, k); break; }
    }
    t.say(txt);
  });
  return t;
}
[['tasmee_real_kursi.json', 2, 255, 257], ['tasmee_real_baqara_1_16.json', 2, 1, 20], ['tasmee_real_baqara_1_9.json', 2, 1, 20],
 ['tasmee_real_baqara_1_6.json', 2, 1, 20], ['tasmee_real_naba_1_14.json', 78, 1, 40], ['tasmee_real_kahf_31_60.json', 18, 31, 70],
 ['tasmee_real_kursi_then_285.json', 2, 255, 257]].forEach(([f, s, a1, a2]) => {
  const sm = replay(f, s, a1, a2), v2 = replay(f, s, a1, a2, { smooth: false });
  const shut = sm.T.i - (sm.T.base || 0) - sm.open().filter((r) => sm.ref.indexOf(r) < sm.T.i && sm.ref.indexOf(r) >= (sm.T.base || 0)).length;
  ok(`real: ${f.replace('tasmee_real_', '').replace('.json', '')} — reaches ${sm.at()} (v2 ${v2.at()}), ${shut} covered behind the cursor, no colour`,
    sm.T.i >= v2.T.i && sm.clean() && shut === 0, { sm: sm.at(), v2: v2.at(), shut });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
