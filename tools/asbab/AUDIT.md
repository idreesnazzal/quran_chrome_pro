# أسباب النزول — what changed and what was measured
`tools/asbab/AUDIT.md` · branch `arena/f9c7b64d-quran-chrome-pro` · 2026-11-07

Everything below is a number produced by the scripts in this folder on this checkout
(`python3 download.py --check`, `align.py`, `check.py`, `merge.py`, `ui_test.js`,
`node tests/run_tests.js`). Nothing here is estimated.

## 1. Before → after

| | قبل (HEAD `a10aad7`) | بعد |
|---|---|---|
| shape of the data | `window.ASBAB_DATA` = one flat object `{ "2:6": "<p>…</p>", … }` | `{v, gen, books, checked, entries, index}` |
| book | الواحدي only (501 keys) | الواحدي 420 entries + المحرر 7 entries |
| entries | 501 ayah keys, one HTML blob each | **427 entries** over **507 ayahs** |
| easy summary for the reader | none | **51** (≤40 words each) |
| grade from the book's own judgement | none | the 7 المحرر entries carry the book's own verdict word for word |
| ayah ranges | not modelled | **36** range entries, shown on every ayah of the range |
| surah-general sabab | not modelled | 1 (`105:1`, الواحدي speaks about the whole surah) |
| "not really a sabab" note | not modelled | 1 (`2:45`) |
| ayah with no sabab | an invented sentence: «هذه الآية الكريمة نزلت ابتداءً…» — the same text for every ayah, not in any book | one honest line naming only the books actually read for that ayah |
| file | `2 356 145` bytes, 1 283 448 chars of text | `1 706 170` bytes |
| loading | parsed at page start | lazy (`asbabLoad()`), index first |

جملة «نزلت ابتداءً» المختلقة لم تكن في أي من الكتابين، وقد حُذفت بالكامل؛ لا توجد
الآن أي جملة تُنسب إلى كتاب لا يقولها.

## 2. Alignment report (`align.py`)

```
align: 420 ayahs kept | 13 moves | 81 repeated-span keys | 0 drops
     | 10 without a quoted verse | 9 ambiguous | 36 ranges
```

### 2.1 The 13 entries the scrape had put on the wrong ayah — every one logged
| from the scrape | put on | why (script's own criterion) |
|---|---|---|
| 2:2 | **2:6** | the entry quotes the words of 2:6 (5 words) |
| 2:137 | **2:138** | the book prints its ayah number as 138 |
| 2:231 | **2:232** | the entry quotes the words of 2:232 (7 words) |
| 2:234 | **2:240** | the entry quotes the words of 2:240 (7 words) |
| 2:257 | **2:256** | the book prints its ayah number as 256 |
| 3:183 | **3:187** | the entry quotes the words of 3:187 (5 words) |
| 5:44 | **5:41** | the entry quotes the words of 5:41 (9 words) |
| 8:80 | **8:70** | the entry quotes the words of 8:70 (9 words) |
| 17:35 | **17:53** | the book prints its ayah number as 53 |
| 17:59 | **17:29** | the entry quotes the words of 17:29 (6 words) |
| 29:20 | **29:60** | the entry quotes the words of 29:60 (6 words) |
| 98:34 | **9:34** | quotes 9:34 (13 words); its key even names sura 98 |
| 2230:76 | **23:76** | quotes 23:76 (6 words); the key `2230_76` is a scrape artefact |

No entry was thrown away (`drops: 0`). Every ayah that had a sabab before still has
one: the only keys missing from the new index are the 13 rows above, and each of them
reappears on the ayah it really belongs to.

### 2.2 The duplicated span entries
The scrape repeats one entry on every ayah of a span (`74:11–24` arrived 14 times,
`2:8–20` thirteen times). Collapsing them into one entry carries the same sabab over
the whole span instead of dropping it:

* **81** span keys collapsed into **36** range entries, all logged in
  `aligned/align_report.json` under `repeats`;
* a range is only used inside one surah. Two surahs that share a text (`107:1` /
  `108:1–2`, `113` / `114`) keep one entry each, so no ayah loses its sabab;
* the reader sees «الآيات ٨٢–٨٦» on every ayah of the range.

### 2.3 Left undecided on purpose
* `kept_without_quote` (10): `1:1`, `1:2`, `2:1`, `2:14`, `2:177`, `92:1`, `105:1`,
  `112:1`, `113:1`, `114:1` — the entry does not print the verse; it was kept on the
  ayah the book puts it on.
* `ambiguous` (9): `2:278`/`3:102`, `4:51`/`3:23`, `4:59`/`47:33`, `5:51`/`3:118`,
  `5:57`/`3:118`, `22:52`/`21:25`, `29:10`/`2:8`, `61:1`/`59:1`, `81:29`/`76:30` —
  the book prints one number and quotes words the other ayah shares. The printed
  number wins; the doubt is written down rather than hidden.
* The footnote trap: `28:68` was moved to `28:31` because the footnote «(١) سورة
  الزخرف: الآية ٣١» was read as a claim. `align.py` now cuts the footnotes off before
  reading ayah numbers, and the entry stayed on 28:68.

## 3. Grades

Only the two books speak:

* الواحدي does not grade his reports → every الواحدي entry is «لم يُحكم عليه», and its
  own sentence is what the reader can check (the note «أثر الضحاك مرسل، والكلبي ضعيف»
  that the edition prints after 2:6 is *not* used as a grade: it is the editor's
  footnote, not الواحدي's judgement).
* المحرر writes a «النتيجة» for every entry → the 7 entries use it verbatim as the
  evidence sentence, and the grade is read from it:

| ayah | grade | the book's sentence (shortened here; stored in full) |
|---|---|---|
| 2:144 | صحيح | «وذلك لصحة سند الحديث، وتصريحه بالنزول وموافقته للفظ القرآن…» |
| 2:187 | صحيح | «وما تقدم مؤيد بصحة الأحاديث وتصريحها بالنزول…» |
| 3:188 | صحيح | «…وذلك لصحة سند الحديث، وتصريحه بالنزول وموافقته لسياق القرآن.» |
| 33:37 | صحيح | «أن الحديث المذكور سبب نزول الآية الكريمة لصحة سنده…» |
| 66:1 | صحيح | «…حين حرم رسول اللَّه جاريته، لصحة سنده، وتصريحه بالنزول…» |
| 80:1 | **ضعيف** | «…أن الحديث وإن كان ضعيفاً إلا أنهم مجموعون على ما دلّ عليه…» |
| 111:1 | صحيح | «أن الحديث الذي معنا سبب نزول السورة الكريمة لصحة سنده…» |

## 4. Coverage of the second book (المحرر)

The 460 dump is one `.json.gz` and this sandbox has no HTTPS egress to
quranpedia.net, so entries were read one ayah at a time in the per-ayah embed view and
copied verbatim: **7 ayahs carry a المحرر text** (`2:144`, `2:187`, `3:188`, `33:37`,
`66:1`, `80:1`, `111:1`), and **2 more were read and found to have no entry at all**
(`74:15`, `36:1`). Those 9 are listed in `curation/checked_460.json`; the app only
names المحرر among the checked books for those 9 ayahs and never for any other. This
is the honest limit of this run, not a claim of full coverage.

## 5. Self-review of the summaries

51 summaries exist; 44 were re-read against the book text in this pass (the 7 المحرر
ones were reviewed when written). Result: 43 unchanged, **1 fixed**, 0 removed.

| # | ayah | verdict |
|---|---|---|
| 1 | 2:6 | مطابق |
| 2 | 2:105 | مطابق |
| 3 | 2:133 | مطابق |
| 4 | 2:168 | مطابق |
| 5 | 2:219 | مطابق |
| 6 | 2:280 | مطابق |
| 7 | 3:69 | مطابق |
| 8 | 3:96 | مطابق |
| 9 | 3:110 | مطابق |
| 10 | 3:111 | مطابق (الكتاب: «فَآذَوْهُمْ لِإِسْلَامِهِمْ») |
| 11 | 3:140 | **صُحّح**: «وهي تلطم» → «وهي تلتدم» (لفظ الكتاب) |
| 12 | 3:196 | مطابق |
| 13 | 4:10 | مطابق |
| 14 | 4:78 | مطابق |
| 15 | 4:136 | مطابق |
| 16 | 4:148 | مطابق |
| 17 | 4:153 | مطابق |
| 18 | 4:166 | مطابق |
| 19 | 4:171 | مطابق |
| 20 | 6:7 | مطابق |
| 21 | 6:19 | مطابق |
| 22 | 6:57 | مطابق |
| 23 | 6:100 | مطابق |
| 24 | 7:188 | مطابق |
| 25 | 7:189 | مطابق (المدى ١٨٩–١٩١ مذكور في الملخّص) |
| 26 | 8:33 | مطابق |
| 27 | 9:12 | مطابق |
| 28 | 9:64 | مطابق |
| 29 | 9:97 | مطابق |
| 30 | 9:101 | مطابق |
| 31 | 13:38 | مطابق |
| 32 | 16:101 | مطابق |
| 33 | 17:80 | مطابق |
| 34 | 18:83 | مطابق |
| 35 | 19:66 | مطابق |
| 36 | 33:43 | مطابق |
| 37 | 42:51 | مطابق |
| 38 | 56:28 | مطابق |
| 39 | 60:13 | مطابق |
| 40 | 67:13 | مطابق |
| 41 | 70:38 | مطابق |
| 42 | 74:15 | مطابق (يُعرض عبر المدى ١١–٢٤) |
| 43 | 107:1 | مطابق (قولان مذكوران) |
| 44 | 4:153 | مطابق |

`check.py` was not weakened to make this pass: when «تلطم» failed the word test and
«المسلمين» tripped the isnad test, the *summary* was rewritten in both cases. The one
checker change was a real bug — «مسلم» was matched inside «المسلمين»; book names are
now matched as whole words only.

## 6. Decisions worth writing down

1. **Duplicate spans are coverage, not noise.** The first instinct (delete the 14 copies
   of 74:15) would have hidden the sabab from 74:16–24. They are collapsed into one
   entry *with a range*, which is both smaller and more complete — 507 ayahs covered
   now against 501 before.
2. **A shared text across two surahs stays two entries** (`107/108`, `113/114`).
3. **Footnotes are not claims** (see 28:68 above).
4. **`nal`/«لا سبب» is per book, not global.** The line names only the books that were
   actually read for that ayah, from `curation/checked_460.json`.
5. **Nothing is graded from memory.** الواحدي entries stay «لم يُحكم عليه» even where
   modern editors add a note.
6. **Atomic writes**: `merge.py` writes `data/asbab_data.js.tmp` then `os.replace`, and
   bumps `sw.js` VERSION in the same run.
7. **No build step, no new dependency** on the page: the data file is a plain script,
   loaded lazily, well under the 5 MB split threshold (1.63 MB).

## 7. Known limits

* All 630 entries carry a written summary; «الملخّص لم يُكتب بعد» is 0.
* المحرر coverage: all 210 entries (see §8).
* 9 alignment ambiguities and 10 entries without a printed verse are listed above and
  left as the book has them.

## 8. المحرر import (v3, 210 entries)

* Source order: `origin/asbab-v2` first (complete dump of المحرر, read-only: no branch
  merge, no summary and no grade taken from it), quranpedia second (only the 7 ayahs
  the public dump exposes, used earlier in v2). Every one of the 210 entries comes from
  the v2 dump; quranpedia contributed no new entry.
* `import460.py` splits each ayah's `content[]` into four verbatim blocks
  (preamble / «سَبَبُ النُّزُولِ» / «دِرَاسَةُ السَّبَبِ» / «النتيجة») and re-derives the
  grade **from the «النتيجة» sentence only**: {صحيح 106, حسن 1, ضعيف 36,
  لم يُحكم عليه 67}. No «النتيجة» block → «لم يُحكم عليه»; negations («غير صحيح»،
  «لا يصح») are matched before the positive words.
* 80:1: the book says «وبهذه الأقوال المتقدمة للمفسرين يتبين أن الحديث وإن كان ضعيفاً
  إلا أنهم مجموعون على ما دلّ عليه» — a statement about the hadith, not a verdict on
  the sabab, so the entry stays «لم يُحكم عليه» and that sentence is kept verbatim as
  the evidence. v2 had graded it «ضعيف» from the same words.
* Merged per ayah: one ayah can carry entries from both books (598 ayahs, 630 entries).
  `checked` is `{"2919":1,"460":1}` — both books fully imported, so the empty line may
  name both.

## 9. v4 — لباب النقول، والكتب المرجعية، واستعادة ما سقط

**لباب النقول (السيوطي، ت 911هـ — ملك عام).** المصدر: OpenITI RELEASE، نسخة
Shamela 0002247 (دار الكتب العلمية، بيروت)، sha256 `671274dadb1d…`، والملف نفسه في
`raw/lubab-nuqul.shamela0002247.openiti.txt`. النص المصدري سيل متصل بلا مفاتيح آيات،
والكتب تُقتبس فيه ثلاث وأربع كلمات («قوله تعالى أو كصيب الآية»)، فمحاولة تعيين الآية
من المقتبس تنزلق. لذلك `import_suyuti.py` لا يخمّن: يقبل الأثر فقط إذا أعاد **تسع
كلمات متصلة على الأقل** موجودة حرفيًا في مدخل مُحقَّق من الواحدي أو المحرر، مع شرطين:
ألا تكون الكلمات قرآنًا (فالقرآن لا يدل على الحدث)، وألا تكون سندًا (السند مشترك بين
الكتب). النتيجة: **245 أثرًا على 189 آية**، رُفض 768 أثرًا وبقي سبب الرفض مكتوبًا
في `raw/asbab-suyuti.json::dropped`. الدرجة لا تُنسب إليه إلا حيث يقولها هو: «إسناده
صحيح/حسن/ضعيف»، «صحيح على شرط مسلم/البخاري»، «أسانيده صحاح» — و«واه» و«ضعيف» وحدهما
متروكان لأن السيوطي يطلقها على السند الذي قبله في الصفحة لا على الأثر الذي نعرضه.
الحصيلة: صحيح 2، والباقي «لم يُحكم عليه» (243).

**الاستيعاب (الهلالي) والصحيح المسند (الوادعي).** لم يُضف منهما صف واحد: لا توجد نسخة
عامة قابلة للقراءة الآلية (quranpedia لا ينشر إلا كتابين، وshamela يعرض النص صفحةً
صفحة في HTML لا نتيجة في البحث)، واستخراج أحكام مئات الآيات من كتاب محفوظ الحقوق
يقوم على إعادة إنتاج نصه. فبقي الباب مفتوحًا في البنية: `refBooks` + `ref` + `q`
(≤ 15 كلمة) + `curation/references.json` (فارغ الآن)، و`check.py` يرفض أي صف مرجعي
بلا مرجع أو باقتباس أطول من 15 كلمة.

**استعادة ما سقط.** مقارنة بناء `origin/asbab-v2` بالحالي أعطت **84 آية** كانت لها
مدخلات وسقطت: 22 منها نصّها مكرر على مدى متصل (فاستُعيد المدى: 96 آية تغطية)، و10
تبيّن أن المحرر الحالي يحملها فعلًا، و12 أثرًا مستقلًا استُعيد بنصه الحرفي من البناء
القديم في `raw/asbab-restored-2919.json` وكُتب له ملخّص (كل القرارات في
`curation/restore.json`).

**الدمج في بطاقات.** بطاقة واحدة لكل حدث: يُدمج مدخل الواحدي ومدخل المحرر إذا اشتركا
في ثماني كلمات متصلة أو أكثر، أو إذا بلغ تشابه كلمات المتن 20% فأكثر (المحرر يعيد
صياغة الواحدي). النتيجة 24 دمجًا، و618 بطاقة على 658 آية، و218 بطاقة تحمل كتابين أو
أكثر.

## 10. v5 — the fused ranges are cut (2026-11-09)

The v4 build took a span from any `قوله تعالى` block, so a block that carried two
sections produced one card with two stories: 4:102–116 held the عسفان prayer story
**and** the طعمة بن أبيرق story, 2:115–116 held two events, 39:17–18 held the {22}
section as well.

* `tools/asbab/split_sections.py` (new) cuts every الواحدي block at each
  `قوله تعالى: {…} {N}` / `(١) - قوله تعالى` header, keeps each editor footnote
  `(n) - …` with the section it belongs to, and derives each section's range from
  **its own** header only. 10 blocks split, 437 الواحدي entries (was 432).
* The v4 range restores were removed: a range never comes from the old build any more.
  «إلى آخر السورة» is refused (it produced 16:4→128 and 3:121→154 style spans).
* `merge.py` now groups entries whose **spans overlap** (the two books may hang the
  same event on 5:82 and 5:83), joins same-book sections only on a verbatim echo,
  collapses byte-identical repeated blocks, and reads `curation/groups.json` for the
  pairs the tests cannot prove (111:1, 58:14, 74:1).
* Two new `check.py` rules: ≤1 out-of-range ayah header per card, and no two cards on
  one ayah sharing 8 consecutive non-Quran non-isnad words.
* Result: 500 cards / 632 ayahs / 876 texts (was 618 / 658 / 887), 239 multi-book
  cards, 29 cards with a span ≥3 ayahs, all read and kept (each rests on its own
  section's printed span). 0 cards without a summary.

## 11. v6 — reading every pair, and refusing the pairs that only share an ayah

v5 grouped by percentage overlap and shared word chains. The brief for v6 was the
opposite test: two entries are one card only if a reader would say it is the same
incident — the same people doing the same thing — and the only automatic join left is
a verbatim run of eight story words (Quranic wording and isnad lines removed).

* `/tmp` script over `data/asbab_data.js` printed **every** cross-book pair that sits on
  a shared ayah: 127 pair instances, 66 distinct pairs. Each pair's two summaries and
  both texts were read. Result, written into `curation/groups.json`: **46 join** rows
  (`same_event: true`, reason, `source: "read"`) and **36 refusal** rows
  (`same_event: false`, the two stories named, `source: "read-rejected"`) — the
  refusals live in `curation/rejected.json` and survive a rebuild. 4:102 عسفان,
  4:105 طعمة, 60:10 الحديبية, 3:199 النجاشي stay joined; 59:9 (the guest and the land),
  31:6 (النضر/فارس against بيع القينات), 33:4 (رجل لبيب against ابن عباس), 49:11 (ثابت بن
  قيس against أبو جبيرة), 24:58, 11:5, 57:16, 2:272 and 26 others are split.
* `merge.py`: `same_event()` is now echo-only; the v5 overlap/chain/name tests are
  deleted; `reviewed()` reads `groups.json` in both directions and matches the exact
  book set (a `<=` test once fired a الواحدي+المحرر row onto single-book cards); the
  summary follows the best-ranked book. A final guard joins two cards on one ayah that
  still share eight story words, unless curation has read the pair and refused it.
* `split_sections.py`: `lead_number()` now reads the Cairo comma form «{٢،١}»; a header
  glued to the closing brace of the previous quote («… فثم وجه الله}قوله تعالى: {وقالوا
  اتخذ الله ولدا} {١١٦}») is now cut. 11 blocks split (was 10), 438 الواحدي entries.
  **2:116 exists after all** — its الواحدي section had no space before «قوله تعالى», so
  it stayed inside 2:115 and the ayah claimed «لم يرد في هذه الكتب». A new card and a
  new summary were written for it.
* لباب النقول: a narration now keeps the ayah the book files it under only if it echoes
  it; otherwise it moves to the entry it does echo, or is left out. Five narrations the
  book files under سورة الأحزاب sat on 33:4 explaining 2:231, 3:174, 28:57, 31:6 and
  95:5; `curation/suyuti_fix.json` settles six of them by hand (three moved to the verse
  their text names, three left out because they name no verse).
* `check.py` gained rule 9: every multi-book card must have a reviewed `groups.json` row
  with a reason. It is not weakened anywhere — rule 8 gained a narrow, written exception
  for the refusals the reader recorded.
* Result: **542 cards / 639 ayahs / 875 texts** (v5: 500 / 632 / 876), 243 multi-book
  cards, 206 cards carrying السيوطي, 32 cards with a span ≥3 ayahs, 0 cards without a
  summary, 132 cards carrying a grade. `groups.json` = 282 rows (46 read joins, 200
  echo joins of السيوطي, 36 refusals). Checker: 0 problems. 102 repo tests; browser test
  green on 19 named ayahs, including 2:116, 59:9, 31:6, 33:4, 49:11, 49:2 and 20:2.
