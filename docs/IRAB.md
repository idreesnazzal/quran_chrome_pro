# إعراب الآية

Every ayah has its grammatical analysis, opened from a fourth tab «🧩 الإعراب» in the ayah window.

## Source

**إعراب القرآن الكريم**: أحمد عبيد الدعاس، أحمد محمد حميدان، إسماعيل محمود القاسم.
- Publisher: دار المنير ودار الفارابي، دمشق، الطبعة الأولى 1425هـ.
- Digitised by [Quranpedia.net](https://quranpedia.net) as `e3rab-book-316.json.gz`.
- Pinned by sha256 `2e8ce313…bd68` (dump of 2026-11-16).
- `tools/irab/MANIFEST.json` records everything.

The book's own wording is shown unchanged, including the diacritics of the words it quotes. The only thing removed is the book's copy of the Quran text: the app shows its own Uthmani text above.

### Rights: read this before publishing

Quranpedia's [licence](https://api.quranpedia.net/dumps/LICENSE.md) allows the data inside apps. It also says that contemporary works "remain the property of their authors and publishers". This book is a contemporary work (1425هـ).

On 2026-11-18 the owner of this app chose to use it anyway. No written permission from the publisher exists. If permission is ever refused, take the data out:
- delete `data/irab/`;
- remove `assets/js/irab.js` from `index.html`.

### Why this book

The other candidates were compared on 2026-11-18:

| Candidate | Why it was not chosen |
|---|---|
| الجدول (صافي) | Complete, but published after the author's death, so still protected. |
| درويش | Complete, but contemporary and protected. |
| الإعراب الميسر | Author unknown. |
| النحاس / العكبري | Classical and free to use, but they do not cover every ayah (5106 / 4992 ayat under a heading). |
| NoorBayan Quranic Treebank | MIT licence and covers every ayah, but about 60% of its syntax was produced by a deep-learning parser. |

This book was chosen because it covers every ayah, word by word, with the role of each sentence, and briefly enough for a phone.

## Build

```
python -I tools/irab/build.py          # downloads the pinned file into tools/irab/raw/ (gitignored), writes data/irab/SSS.js
python -I tools/irab/build.py --check  # build in memory, check, write nothing
python -I tools/irab/spotcheck.py 30   # compare with QUL's copy of the same book (network)
```

### How the build works

1. **Splitting.** The book prints the heading `[سورة X (n) : الآيات a الى b]`, then the ayat, then their iʿrāb. The build joins the book's pages in order and cuts at these headings. The result is 3639 passages covering all 6236 ayat. The book's own ayah→page map is not used: it maps سورة الإخلاص to the wrong page.
2. **Shared passages.** 1174 passages cover several ayat; the book analysed them together. Such a passage stays whole and opens from each of its ayat, labelled «مقطع مشترك».
   - The build marks where each ayah's part starts. It does this by walking the book's «quoted words» along the ayat's words.
   - 2223 of 2597 starts were found. The opened ayah's part is lit with its number.
   - Where a start is not found, nothing is guessed.
3. **Pointers** (`tools/irab/refs.json`, 66, each read by hand). Some passages say only «سبق إعرابها» or «انظر الآية ١٣». The passage they mean is shown under them, labelled.
4. **Inline links** (198 of 347). Inside a passage, «… » سبق إعرابها becomes a button that opens the earlier analysis. The target is either the book's own number («السابقة» counts as a number), or the nearest earlier ayah whose text contains the quoted words and which analyses them itself rather than deferring again. When the target is not certain, no link is made.

## Where a reader opens it

| Place | How |
|---|---|
| Ayah window (from the mushaf, the study list ⤢, the recitation) | «🧩 الإعراب» tab. It stays on that tab with السابقة/التالية, and 📋 copies it with the source. |
| Study panel («صفحة وآيات») | «🧩 الإعراب» tab. A shared passage is shown once; the other ayat point to it. |
| Search results | Small «🧩 الإعراب» button. |
| قوائمي (saved ayat) | «الإعراب» button on each card. |

A surah's file (2–460 KB) is fetched only when its analysis is opened. Reading never waits for it, and the service worker keeps it for offline use.

## Tests

- `python -I tests/irab_data.py`
  - The files equal a fresh build from the pinned source.
  - Every one of the 6236 ayat opens exactly one non-empty passage.
  - Only known markup is used.
  - Every pointer, link and marker is valid.
- `python tests/irab_e2e.py [port]`
  - The real page, at 1366 px and 360 px.
  - All four places to open the analysis.
  - Shared passages, pointers, links (by keyboard too) and copy.
  - No file is fetched before the analysis is opened.
