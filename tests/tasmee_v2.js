/* Tasmee engine v2 (assets/js/tasmee.js, feed2): the place first, a mistake only on evidence.
 * Unit cases on the real text, then the reader's own Chrome sessions (tests/data/tasmee_real_*.json).
 * usage: node tests/tasmee_v2.js */
'use strict';
const H = require('./harness');
const RM = require('../assets/js/recite-by-mic.js');
const Core = require('../assets/js/tasmee.js');
const { S, T: TY } = Core;
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
  const X = Core.makeCtx(E, as, pas, Object.assign({ sim: RM.wordSim, bi: (a, b) => BI.has(a + ' ' + b) }, o));
  const t = { X, T: Core.create(E.length), E, ref };
  t.say = (s, final) => { t.T = Core.feed(final === false ? Core.clone(t.T) : t.T, X, tok(s), final !== false); return t; };
  t.red = () => E.map((w, k) => (t.T.ty[k] ? ref[k] + ' ' + w : null)).filter(Boolean);
  t.yellow = () => E.map((w, k) => (!t.T.ty[k] && t.T.st[k] === S.UNS ? ref[k] + ' ' + w : null)).filter(Boolean);
  t.at = () => ref[t.T.i] || 'END';
  return t;
}
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
}

// ---- reading it right
let t = test(1, 1, 7);
['بسم الله الرحمن الرحيم', 'الحمد لله رب العالمين', 'الرحمن الرحيم', 'مالك يوم الدين', 'اياك نعبد واياك نستعين', 'اهدنا الصراط المستقيم',
  'صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين'].forEach((s) => t.say(s));
ok('al-Fatiha read right: every word right, at the end', t.at() === 'END' && !t.red().length && !t.yellow().length, { red: t.red(), y: t.yellow() });

// ---- Chrome's noise is yellow, and the place is never lost
t = test(78, 1, 16);
['عم يتساءلون عن النبا العظيم الذي هم فيه مختلفون', 'كلا سيعلمون ثم كلا سيعلمون', 'الم نجعل الاردن هذا', 'والجبال اوتادا وخلقناكم ازواجا'].forEach((s) => t.say(s));
ok('«الاردن هذا» for «الارض مهادا», then the text: two yellow words, no mistake, the test goes on', !t.red().length && t.yellow().join() === '6:3 الارض,6:4 مهادا' && t.at() === '9:1', { red: t.red(), y: t.yellow(), at: t.at() });
t = test(18, 48, 52);
['وعرضوا على ربك صفا لقد جئتمونا كما خلقناكم اول مره بل زعمتم الن نجعل لكم موعدا', 'ووضع الكتاب فترى المجرمين مشفقين مما فيه ويقولون يا ويلتنا ما لهذا الكتاب',
  'لا يغادر صغيره ولا كبيره الا احصاها ووجدوا ما عملوا حاضرا ولا يظلم ربك احدا'].forEach((s) => t.say(s));
ok('18:49 «ما لهذا الكتاب» (the text: «مال هذا»): the same letters, right, and the test is at 18:50', !t.red().length && t.at() === '50:1', { red: t.red(), y: t.yellow(), at: t.at() });
t = test(2, 100, 104);
['او كلما عاهدوا عهدا نبذه فريق منهم بل اكثرهم لا يؤمنون', 'ولما جاءهم رسول من عند الله مصدق لما معهم نبذ فريق من الذين اوتوا الكتاب كتاب الله وراء ظهورهم كانهم لا يعلمون'].forEach((s) => t.say(s));
ok('two garbled words do not stop the test («او كلما» as two words)', !t.red().length && t.at() === '102:1', { red: t.red(), y: t.yellow(), at: t.at() });

// ---- an utterance cut inside a word
t = test(78, 1, 5);
t.say('عم يتساء').say('لون عن النبا العظيم');
ok('«عم يتساء» | «لون عن النبا العظيم»: no mistake, no yellow', !t.red().length && !t.yellow().length && t.at() === '3:1', { red: t.red(), y: t.yellow(), at: t.at() });

// ---- left out
t = test(102, 1, 8);
['الهاكم التكاثر حتى زرتم المقابر', 'كلا سوف تعلمون ثم كلا سوف تعلمون', 'كلا لو تعلمون علم اليقين لترون الجحيم', 'ثم لتسالن يومئذ عن النعيم'].forEach((s) => t.say(s));
ok('102:7 left out («ثم لتسألن» after «لترون الجحيم»): a mistake', t.red().some((x) => /^7:/.test(x)) && t.at() === 'END', { red: t.red(), y: t.yellow() });
t = test(2, 8, 12);
['ومن الناس من يقول امنا بالله وباليوم الاخر وما هم بمؤمنين', 'يخادعون الله والذين امنوا وما يخدعون الا انفسهم', 'في قلوبهم مرض فزادهم الله مرضا ولهم عذاب اليم بما كانوا يكذبون'].forEach((s) => t.say(s));
ok('one or two words not heard («وما يشعرون»): yellow, never a mistake', !t.red().length && t.yellow().join() === '9:9 وما,9:10 يشعرون', { red: t.red(), y: t.yellow() });
t = test(2, 40, 46);
t.say('يا بني اسرائيل اذكروا نعمتي التي انعمت عليكم واوفوا بعهدي اوف بعهدكم واياي فارهبون');
t.say('وامنوا بما انزلت مصدقا لما معكم ولا تكونوا اول كافر به ولا تشتروا باياتي ثمنا قليلا واياي فاتقون');
t.T.gap = true;   // the recogniser restarted here («error network», the reader's session of 2026-11-03)
t.say('الصلاه واتوا الزكاه واركعوا مع الراكعين اتامرون الناس بالبر وتنسون انفسكم وانتم تتلون الكتاب افلا تعقلون');
ok('words missing after the recogniser restarted (audio lost): yellow, not «left out»', !t.red().length && t.yellow().length >= 9 && t.at() === '45:1', { red: t.red(), at: t.at() });
t = test(2, 40, 46);
t.say('يا بني اسرائيل اذكروا نعمتي التي انعمت عليكم واوفوا بعهدي اوف بعهدكم واياي فارهبون');
t.say('وامنوا بما انزلت مصدقا لما معكم ولا تكونوا اول كافر به ولا تشتروا باياتي ثمنا قليلا واياي فاتقون');
t.say('واقيموا الصلاه واتوا الزكاه واركعوا مع الراكعين');
ok('the same with no restart: ayah 42 left out is a mistake (8 words)', t.red().length === 8 && t.red().every((x) => /^42:/.test(x)), { red: t.red() });

// ---- swapped with a similar ayah
t = test(2, 6, 8);
t.say('ان الذين كفروا سواء عليهم اانذرتهم ام لم تنذرهم لا يؤمنون').say('ختم الله على قلوبهم وعلى سمعهم وعلى ابصارهم غشاوه ولهم عذاب اليم');
ok('«عذاب اليم» for «عذاب عظيم»: a mistake (the phrase is in the Qur\'an elsewhere)', t.red().join() === '7:12 عظيم' && (t.T.ty[t.E.length - 1 - t.E.slice().reverse().indexOf('عظيم')] & TY.SUB), { red: t.red() });
t.say('عظيم');
ok('...said right after: red-translucent (corrected), still counted', t.red().join() === '7:12 عظيم' && t.T.st[t.ref.indexOf('7:12')] === S.FIX);
t = test(2, 76, 77);
t.say('واذا لقوا الذين امنوا قالوا امنا واذا خلا بعضهم الى بعض قالوا اتحدثونهم بما فتح الله عليكم ليحاجوكم به عند ربكم افلا تعقلون').say('اولا تعلمون ان الله يعلم ما يسرون وما يعلنون');
ok('«تعلمون» for «يعلمون» (one letter, the ear cannot tell): yellow, not a mistake', !t.red().length && t.yellow().some((x) => /يعلمون/.test(x)), { red: t.red(), y: t.yellow() });

// ---- repeating, other talk, a far move
t = test(2, 10, 12);
t.say('في قلوبهم مرض فزادهم الله مرضا ولهم عذاب اليم بما كانوا يكذبون').say('فيما كانوا يكذبون بما كانوا يكذبون').say('واذا قيل لهم لا تفسدوا في الارض قالوا انما نحن مصلحون');
ok('saying words again (Chrome garbling the first): nothing marked', !t.red().length && !t.yellow().length && t.at() === '12:1', { red: t.red(), y: t.yellow(), at: t.at() });
t = test(78, 1, 10);
t.say('عم يتساءلون عن النبا العظيم').say('طيب شو دخل اسرائيل بالموضوع القصه انه').say('لازم نرجع للبدايه');
ok('talk that is not the text: the test does not move, nothing is marked', t.at() === '3:1' && !t.red().length && !t.yellow().length, { at: t.at(), y: t.yellow() });
t = test(2, 1, 20);
t.say('الم ذلك الكتاب لا ريب فيه هدى للمتقين').say('ومن الناس من يقول امنا بالله وباليوم الاخر وما هم بمؤمنين يخادعون الله والذين امنوا');
ok('a move far ahead (2:2 -> 2:8, 50 words): nothing judged in between, no mistake', !t.red().length && /^9:/.test(t.at()) && Core.summary(t.T, t.X).reached < 30, { red: t.red().length, at: t.at(), sum: Core.summary(t.T, t.X) });

// ---- interim words (a copy): show, never judge
t = test(78, 1, 8);
t.say('عم يتساءلون عن النبا العظيم');
const iv = Core.feed(Core.clone(t.T), t.X, tok('الذي هم فيه مختل'), false);
ok('interim «مختل» of «مختلفون»: shown at once', iv.i === t.ref.indexOf('4:1') && iv.st[t.ref.indexOf('3:4')] === S.OK, { i: iv.i });
ok('...and the committed state is untouched', t.at() === '3:1');
const iv2 = Core.feed(Core.clone(t.T), t.X, tok('الذي هم فيه مخلفين ثم'), false);
ok('interim never makes a mistake', !Array.from(iv2.ty).some(Boolean));

// ---- the reader's own sessions, every final (the recogniser's restarts told to the engine as in the page)
function replay(file, sura, a1, a2) {
  const t = test(sura, a1, a2);
  let first = true;
  require('./data/' + file).events.forEach(([, kind, txt]) => {
    if (kind === 'end') { t.T.gap = true; return; }
    if (kind !== 'final' || !txt.trim()) return;
    if (first) {   // the page finds the first word; here: the first two heard words in the range
      first = false;
      const tk = tok(txt);
      for (let k = 0; k + 1 < t.E.length; k++) if (Core.eqStrict(t.E[k], tk[0]) && Core.eqStrict(t.E[k + 1], tk[1])) { t.T = Core.create(t.E.length, k); break; }
    }
    t.say(txt);
  });
  return t;
}
t = replay('tasmee_real_kursi.json', 2, 255, 257);
ok('real: al-Kursi at speed — no mistake, no yellow, to its end', !t.red().length && t.at() === '256:1', { red: t.red(), y: t.yellow(), at: t.at() });
t = replay('tasmee_real_baqara_1_16.json', 2, 1, 20);
ok('real: 2:1-16 — the only mistake is the reader\'s «اليم» for «عظيم»', t.red().join() === '7:12 عظيم', { red: t.red(), y: t.yellow() });
t = replay('tasmee_real_baqara_1_9.json', 2, 1, 20);
ok('real: 2:1-9 (13:37) — the same single mistake', t.red().join() === '7:12 عظيم', { red: t.red(), y: t.yellow() });
t = replay('tasmee_real_baqara_1_6.json', 2, 1, 20);
ok('real: 2:1-6 (13:58) — no mistake', !t.red().length, { red: t.red(), y: t.yellow() });
t = replay('tasmee_real_naba_1_14.json', 78, 1, 40);
ok('real: 78:1-14 — no mistake; «ماء ثجاجا» as Chrome writes it is yellow', !t.red().length, { red: t.red(), y: t.yellow() });
t = replay('tasmee_real_kahf_31_60.json', 18, 31, 70);
ok('real: 18:31-60 (45 finals, two «error network» restarts) — no mistake, the place kept to 18:60', !t.red().length && /^6\d:/.test(t.at()), { red: t.red(), at: t.at() });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
