# أسباب النزول — specification of the shipped feature
`tools/asbab/SPEC.md` · v5 · 2026-11-09

The feature is a data file plus the reader UI. There is no build step: `index.html`
loads `data/asbab_data.js` lazily the first time a reader opens the sabab panel, and
the service worker's `VERSION` is bumped by `merge.py` whenever that file changes.

## 1. What the reader gets, per ayah

1. **ملخّص سهل** — 1–2 sentences, ≤40 words, modern Arabic, says who or what was
   involved and that the ayah came down about it. No isnad, no book names, no narrator
   chains, «ﷺ» for the Prophet, and it never starts mid-story: each summary stands on
   its own.
2. **الدرجة** — one of `صحيح` / `حسن` / `ضعيف` / `لم يُحكم عليه`, taken **only** from the
   book's own judgement, with the book's sentence quoted verbatim underneath. Where
   the book judges nothing, the label is `لم يُحكم عليه` and the evidence is empty —
   الواحدي never grades, so every الواحدي entry carries that label.
3. **النص من الكتب (n)** — collapsed `<details>`, one block per book, each opening with
   the book name and the pages it came from, text quoted exactly as the book prints it
   (the author's analysis section of المحرر is not reproduced).
4. **Copy** — the copy button copies ayah number + ayah text + summary + grade +
   evidence + the book texts.

Special cases the UI states explicitly:

* **range** — the sabab covers several ayahs: shown on every ayah of the range, with
  «الآيات ٨٢–٨٦» at the head of the entry.
* **surah-general** — «سبب عام للسورة» instead of a single ayah.
* **not a sabab** — «ليس في كلام الكتاب سبب نزول» with the note, rather than a fake one.
* **no sabab** — one line, naming only the books that were actually read for that ayah
  (`curation/checked_460.json::ayahs`); no invented sentence.

The search list shows a `📜 سبب النزول` badge with the grade for any ayah that has one.

## 2. Data shape (`data/asbab_data.js`)

```js
window.ASBAB_DATA = {
  v: 4, gen: "2026-11-09",
  books: { "2919": {n,a,s,note}, "460": {…}, "suyuti": {…} },   // full-text books
  refBooks: [],                                     // verdict-only books (2 & 3), no text
  checked: { "2919": 1, "460": 1, "suyuti": 1 },    // 1 = the whole book was imported
  cards: [ { r: [82,86] | 0, sw: 0|1, na: 0|1, n: "", s: "ملخّص الحدث",
             v: [ { b: "2919", g: "صحيح", e: "جملة الكتاب", ref: "…", q: "…" } ],
             t: [ { b: "460", t: ["…"], page: [1,31] } ] } ],
  index: { "5_83": [12], "2_6": [3] }               // ayah key -> card indices
};
```

* one **card = one event** on one ayah; the books that narrate it sit side by side
  (`v` = their verdicts, `t` = their texts), so the reader reads the story once;
* a card with a verdict but no text is a **reference-only** row (`refBooks`): its
  `ref` is «رقم/صفحة + الطبعة» and any `q` quote is ≤ 15 words (copyright);
* cards are ordered صحيح → حسن → ثم ما لم يُحكم عليه → ضعيف.

* `r` = range `[first,last]` inside one surah, `0` when the entry is about one ayah.
* `sw` = 1 when the book's words are about the whole surah.
* `na` = 1 when the book itself says there is no sabab here.
* every ayah of a range points at the same entry, so the panel never depends on the
  reader opening the first ayah.

## 3. Pipeline (`tools/asbab/`, one command: `./run_all.sh`)

| step | file | guarantee |
|---|---|---|
| 1 | `download.py --check` | sha256 of every raw/aligned/curated file and of `data/asbab_data.js`; prints the dump URLs and hashes the data came from |
| 2 | `align.py` (+ `split_sections.py`) | every entry is matched to a real ayah of `data/quran_data.js`; wrong-ayah entries are moved, nothing deleted without a written reason in `aligned/align_report.json`; curated overrides live in `curation/align_fixes.json` and win; every block is **cut at its own «قوله تعالى: {…} {N}» headers**, so one section = one ayah = one range (see §6) |
| 3 | `merge.py` | writes `data/asbab_data.js` atomically (`tmp` + `os.replace`), bumps `sw.js`, splits the file if it ever passes 5 MB, and refuses a `checked_460` key that is not an ayah |
| 4 | `make_groups.py` | rebuilds `curation/groups.json`: one row per multi-book card; hand rows and rejections are preserved, missing rows are added as `echo` or `unreviewed` |
| 5 | `check.py` | the nine rules below; must print `OK` |
| 6 | `ui_test.js` | headless Chromium: desktop 1280 + 375px, dark + light, 19 named ayahs, the search badge, zero console errors from this feature, no horizontal overflow, screenshots into `screens/` |

Summaries live in `summaries/*.jsonl`, one JSON object per line:
`{"k":"2:144","b":"460","s":"…","g":"صحيح","e":"…"}`.

## 4. The nine rules `check.py` enforces

1. **A real ayah key.** Every `k` must exist in `data/quran_data.js`; a range must sit
   inside its surah and contain the ayah the entry is on.
2. **Arabic, ≤40 words.** Latin text, an empty summary, or a summary that rambles past
   40 words is refused.
3. **Not a summary without a source.** The named book must actually carry that ayah in
   `aligned/` (directly or through the entry's range).
4. **No isnad** — no `أخرج`, `حدثنا`, `أخبرنا`, `رواه`, no `عن … عن`, no `بن … عن`, and
   no book name used as an authority (`البخاري`, `مسلم`, … matched as whole words only,
   so «المسلمين» is not a false hit).
5. **No detail from outside the books.** Every word in a summary must occur in the two
   books' text or in the app's own Arabic corpus — that is how a name, a place or an
   event recalled from memory gets caught.
6. **Grades are quoted, not invented.** A grade outside the four labels is refused; a
   grade other than `لم يُحكم عليه` is refused unless its evidence sentence appears
   word for word in the book text.
7. **One stray ayah header at most** (added in v5). A card whose texts open with
   «قوله تعالى: {…} {N}» for more than one ayah number *outside* its own range is a
   fused block and is refused. This is the rule the 4:102 / 4:105 case broke.
8. **One event, one card** (v5). Two cards that sit on the same ayah may not share a
   run of eight consecutive words once Quranic wording and isnad words are removed —
   unless `curation/rejected.json` records that the pair was read and tells two stories.
9. **A reviewed row for every multi-book card** (v6). Every card that carries two or
   more books must have a row in `curation/groups.json` with `same_event: true`, the
   same book set (السيوطي aside) and a non-empty reason. A group the reader cannot
   justify fails the build instead of shipping.

## 5. How a range is decided (v5)

Only the section's **own** wording may produce a range:

* `قَوْلُهُ تَعَالَى: {…} الآيات {٤١ - ٤٧}` — the book's own numbers;
* `قَوْلُهُ تَعَالَى: {…} {١ - ٤}` — the numbers printed after the quote;
* `… إِلَى قَوْلِهِ تَعَالَى: {…}` — the closing verse, matched word-for-word
  against the mushaf and accepted only if three or more words match;
* `نزلت كلها في قصة واحدة` and the same explicit wording.

Refused on purpose: a range inherited from a block that carries several
`قوله تعالى` sections, and `إلى آخر السورة` (it would hang one story on every
remaining ayah of the surah). Both were the v4 fusing bug.

Grouping (v6): one test only — **eight consecutive story words** (non-Quranic,
isnad-free) shared verbatim by two entries whose ayahs touch. The v5 percentage
overlap, the five-word-chain count and the «بن/ابن» name test are gone: they joined
59:9 (the guest story with the land story) and 31:6, 33:4, 49:11 … and put one book's
grade beside another book's story. A row of `curation/groups.json` may still join a
pair the echo cannot see, but only after a reader compared the two stories, and every
multi-book card must have such a row. A curated rejection (`curation/rejected.json`)
wins over the echo test and over the last-resort join in `merge.py`.

## 5b. Where a لباب النقول narration is shown (v6)

The narration keeps the ayah the book files it under *only if* it shares nine or more
consecutive words with that entry. Otherwise it moves to the entry it does echo; if it
echoes nothing it is left out rather than shown on a story it does not tell. A
narration that shares nothing with the card it sits on is moved to the card it echoes
or dropped. Six narrations the book files under سورة الأحزاب rather than under a verse
are settled by hand in `curation/suyuti_fix.json` (sid = its index in
`raw/asbab-suyuti.json`): three move to the verse their own text names (2:231, 28:57,
31:6, 49:2), three are left out because they name no verse.

## 5c. The summary of a joined card (v6)

When one card keeps two books that tell the event differently, the summary is the one
belonging to the book whose grade is shown first (صحيح → حسن → لم يُحكم عليه →
ضعيف); a grade never appears beside a summary of another story, because a group that
mixes stories is split instead of summarised.

## 6. Adding a summary (the only routine task left)

1. open the ayah in the app, or read `aligned/asbab_2919.json` / `asbab_460.json`;
2. write the summary from the book text only;
3. append one line to `summaries/bNNNN_*.jsonl` with `g` and (for المحرر) the exact
   `النتيجة` sentence in `e`;
4. `python3 check.py && python3 merge.py` — the file, the count and `sw.js` update
   themselves; `./run_all.sh --ui` re-checks the page.
