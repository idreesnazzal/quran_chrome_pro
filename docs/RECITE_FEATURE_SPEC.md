# Recite-by-Mic — Feature Specification for Independent Implementation

**Purpose of this document:** hire/ask an external developer to design and build
the recitation-tracking algorithm **from zero**, without giving them the app or
any existing code. Hand over **only this file**. It specifies *what* must be
built and *how it will be judged* — never *how* to build it.

**One-line brief:** while the user recites Quran aloud (Arabic speech-to-text
provides the words), track *which ayah and which word* they are on, in real
time, and report it so the UI can highlight and turn pages.

---

## 1. User stories (what the user experiences)

1. As a reciter, I open any mushaf page, tap the mic button, and start
   reciting — the current word lights up as I say it, without noticeable lag.
2. When I finish an ayah and continue into the next (even a 3-word ayah), the
   tracker advances mid-stream — it never waits for me to "finish and pause".
3. When I start a surah, I recite the opener (`بسم الله الرحمن الرحيم`) and
   usually the session opener (`أعوذ بالله من الشيطان الرجيم`) — the tracker
   must NOT teleport me to Al-Fatiha (or anywhere else) because of them.
4. When I jump to another surah, the tracker follows me there within a few
   words and turns the page.
5. When I re-recite an already-finished passage (review / memorization loops),
   the tracker comes back with me instead of freezing ahead.
6. When the microphone hears non-Quran speech or noise, the tracker holds its
   position instead of jumping somewhere random.
7. When I recite verses that repeat identically elsewhere (e.g. the Ar-Rahman
   refrain ×31), the tracker stays where I am rather than guessing.

## 2. Inputs

### 2.1 Quran corpus (provided by the app, read-only)
An ordered array of **6,236 records**, one per ayah, in mushaf order:
```
{ sura: number (1-114), aya: number, page: number (1-604),
  suraName: string, text: string (fully vocalized Uthmani-ish Arabic) }
```
The module must work with this exact shape. ayah `text` may carry a trailing
ayah-number marker like `(1)` which must be ignored for matching.

### 2.2 Live speech (provided by the app, streaming)
- Plain-text Arabic words arriving **incrementally** (interim results that grow
  and get revised, plus finalized chunks), in recitation order.
- The text is MSA-style, mostly **without diacritics**, with ASR errors:
  dropped/added/substituted words, hamza variants (يؤمنون/يومنون),
  alef/hamza/ta-marbuta spelling drift.
- The module must NEVER assume the stream is clean, complete, or final.

### 2.3 Text normalization (required behavior, implementer's choice of code)
Before any comparison, both corpus text and spoken text must be normalized so
that vocalized vs. unvocalized and ASR spelling variants meet. Required
equivalences (grapheme level):
- strip all tashkeel/diacritics (including dagger-alef), tatweel, ZWNJ/ZWJ;
- unify alef forms إ أ آ ٱ → ا; ة → ه; ى → ي; ئ / ؤ → ء;
- **must NOT collapse** اء → ء (سماء must stay distinct);
- drop non-Arabic characters, collapse whitespace.
- Light, explicitly-documented stemming/inflection tolerance is allowed, but
  any rule that merges distinct common words (e.g. stripping و-/ف- prefixes
  from any word, or ة/ت endings globally) is forbidden — it will fail the
  acceptance tests.

## 3. Module interface (language-agnostic; TypeScript shown for precision)

```ts
// Opaque state owned by the module.
interface Tracker { /* implementer-defined */ }

// 1. Build once from the corpus above. Must complete in < 1 s for 6,236 ayahs
//    on a mid-range phone/laptop, client-side, offline, no network.
function buildIndex(ayahs: Ayah[]): Tracker;

// 2. Feed newly recognized words (already in recitation order, oldest first).
//    Called many times per second with small batches (1-6 words typical).
function pushWords(t: Tracker, words: string[]): void;

// 3. Advance the position using all words pushed so far. Called after every
//    push. Must cost microseconds-to-∼1 ms (never a full-corpus scan).
//    Emits at most one position update per call (see events).
function follow(t: Tracker): void;

// 4. One-shot global match (used for manual search/simulator and for
//    recovery). May scan the corpus; budget ∼20 ms.
function matchUtterance(t: Tracker, text: string, anchorIdx: number): Match | null;

// 5. Reset session state (new recitation). Corpus index is kept.
function resetSession(t: Tracker): void;

interface Position { ayahIdx: number; wordIdx: number; } // wordIdx = index inside the ayah
interface Match extends Position { confidence: number /* 50..99, computed, never constant */;
                                   isJump: boolean /* true if far from anchor */; }
```

**Events (the app subscribes):** `onPosition(pos, transcriptTail)` after every
`follow()` that moved the pointer; `onJump(match)` only on genuine far jumps
(for toasts/page turns). The module must not touch the DOM.

## 4. Functional requirements

- **FR-1 Word following:** each pushed word that continues the current ayah
  advances `wordIdx` immediately (same call, no waiting for ayah end).
- **FR-2 Ayah transitions:** crossing into the next ayah — including 1–3-word
  ayahs — commits as soon as its head words arrive, mid-stream.
- **FR-3 Repeats:** re-reciting the last 1–3 words (correction/tajweed fixing)
  moves the pointer back slightly and stays on the ayah; it must not trigger
  recovery machinery.
- **FR-4 Skips:** skipping a word advances over it (follow, don't grade).
- **FR-5 Surah jumps:** reciting a far passage relocates within ~4–8 new words,
  with protection against single-word flukes (one shared common word must
  never teleport the mushaf).
- **FR-6 Mutashabihat abstention:** input equally matching N ayahs (identical
  refrains) holds position when far from all copies; follows normally when
  parked next to one.
- **FR-7 Opener immunity:** the session opener
  (`أعوذ بالله من الشيطان الرجيم`, incl. the longer السميع العليم form) and
  the surah opener (`بسم الله الرحمن الرحيم`) must never cause a far jump —
  even though they textually match 1:1, 27:30, 16:98, 7:200, 41:36. Exception:
  if the user is parked within ±3 ayahs of one of those carriers (studying
  it), matching there is allowed.
- **FR-8 Shared heads:** consecutive surahs with identical openings
  (113:1 vs 114:1 share قل أعوذ برب) must resolve by the first
  *distinguishing* word, never by guessing; until then, hold.
- **FR-9 Backward review:** going back several ayahs to re-recite must
  relocate there (recovery path), not freeze ahead forever.
- **FR-10 Garbage stall:** non-Quran input changes nothing (pointer and page
  frozen, no toasts).
- **FR-11 Short ayahs:** 1–4-word ayahs (الم, ق, والعصر…) are matchable alone
  (exact) and crossable mid-stream.
- **FR-12 ASR noise tolerance:** hamza drift (يؤمنون/يومنون), alef/taa drift,
  1–2 dropped words per utterance must not break tracking; heavy dialect or
  singing that changes most words is out of scope (hold position).
- **FR-13 Determinism:** same word sequence → same positions, every run.
  No randomness, no wall-clock dependence, no network.

## 5. Non-functional requirements

- **NFR-1** Zero dependencies, offline, no network calls, no eval/obfuscation.
- **NFR-2** `buildIndex` < 1 s for 6,236 ayahs on commodity hardware.
- **NFR-3** `follow()` amortized ≤ 1 ms per call; `matchUtterance` ≤ 25 ms.
- **NFR-4** Memory bounded (stream history capped; no unbounded growth over a
  1-hour session).
- **NFR-5** No uncaught exceptions on any input, including empty corpus,
  empty strings, non-Arabic text, and 600-word pastes.

## 6. Known pitfalls (distilled from production pain — read before designing)

1. **Do not score by adding raw n-gram/bag-of-words points.** The same
   evidence gets counted 3–5× (a trigram contains its bigrams/unigrams) and
   common words outvote rare ones. Any additive scheme needs length
   normalization plus rarity (IDF-style) weighting, or it will prefer long
   wrong ayahs and stick to finished ones.
2. **Do not normalize scores by the whole input** when the input spans several
   ayahs — no single ayah can then ever win (e.g. 15 words of Ikhlas match
   nothing). Score subsegments; let recitation order break ties.
3. **A single shared word is not evidence.** `من`, `الله`, `قل` each occur in
   hundreds of ayahs; one exact common word must never move the mushaf.
   Demand runs/confirmation for boundary crossings.
4. **Forward and backward need different strictness.** Repeats behind the
   pointer should require near-exactness (else foreign words pin the pointer);
   forward steps may be lenient (ASR noise), because continuation self-heals.
5. **Greedy first-hit alignment breaks on the first ASR deletion.** Prefer
   edit-distance/DP alignment with backtrace over forward scanning, and never
   use raw prefix matching on Arabic roots.
6. **Interim results wobble.** Design the ingest so grown-then-revised
   prefixes deduplicate (overlap-join) instead of duplicating or rewinding
   state destructively.
7. **Test with real transcripts**, including stuttered repeats
   (قال… قالوا… اتخذ), dialectal drift, and multi-ayah pastes — not just clean
   single ayahs.

## 7. Acceptance tests (all must pass; harness injects transcripts, no mic)

Notation: `A→B` = start parked at A (pointer set), feed the words, assert end
position. Corpus = the real 6,236 ayahs.

| ID | Setup | Input (words fed in order) | Must end at |
|----|-------|---------------------------|-------------|
| T01 | parked 1:1 start | بسم الله الرحمن الرحيم (in 3 chunks) | 1:1 end |
| T02 | after T01 | الحمد لله رب العالمين | 1:2 end (crossed mid-stream) |
| T03 | parked 1:2 end | رب العالمين (repeat) | 1:2 end (hold, slight rewind ok) |
| T04 | parked 1:2 word لله | العالمين (skip رب) | 1:2 end |
| T05 | parked 1:2 end | صباح الخير يا صديقي ×3 | 1:2 end (frozen) |
| T06 | parked 1:2 end | full Ikhlas 112:1–4 | 112:4 end (walks through all four) |
| T07 | parked end of 112:1 | الله الصمد | 112:2 end |
| T08 | parked 2:1 start | full 2:3 (الذين يؤمنون…) | 2:3 end |
| T09 | parked 18:1 start | feed 18:1…18:5 in order | 18:5 end incl. 3-word 18:3 |
| T10 | parked 18:42 end | full 18:37 | 18:37 (backward review recovers) |
| T11 | parked 55:13 | its refrain ×3 | stays 55:13 (no wild jump) |
| T12 | parked 18:1 | bare بسم الله الرحمن الرحيم | holds (null — opener is not a destination) |
| T13 | parked 18:1 | bare أعوذ بالله من الشيطان الرجيم | holds (null) |
| T14 | parked 18:1 | opener + basmala + full 18:37 | 18:37 (openers must not crown 1:1/16:98) |
| T15 | parked 16:98 | bare isti'adha | 16:98 (studying exception) |
| T16 | parked 1:2 end | full Ikhlas as ONE single-shot query | 112:1 (first recited, not null) |
| T17 | parked 1:2 word رب | أحد (single fuzzy word) | holds 1:2 word رب (no rewind on fuzzy) |
| T18 | parked 112:1 end | الم (unrelated singleton) | holds (no hijack) |
| T19 | parked F1-end (toy ayahs) | single word equal to F3[0] (two ahead) | holds (no +2 skip); then full F2, F3 → walks F2→F3 |
| T20 | parked 114:1 area | shared head قل أعوذ برب only | holds; + الناس/الفلق → commits to the right surah |
| T21 | empty corpus | any input | nulls everywhere, zero exceptions |
| T22 | no-mic env (no WebSpeech/DOM) | start/stop/toggle | zero exceptions |
| T23 | any | 100-word paste then two follow() calls | all 100 consumed, zero exceptions |
| T24 | mic-less | fully vocalized input بسم الله with tashkeel | matches 1:1 |

Performance assertions: buildIndex(6236) < 1000 ms; any single matchUtterance
< 25 ms; follow() per call < 1 ms amortized (measure in-harness).

## 8. Deliverables & evaluation

1. **One dependency-free JS module** (or language of your choice if the
   hirer agrees — the tests above are language-agnostic) exposing the §3
   interface, plus a 1-page note explaining the algorithm and its thresholds.
2. **A test report** running every row of §7 (pass/fail + timings), executed
   by the hirer in Node (or equivalent) with the real corpus — no microphone
   needed, transcripts are injected as strings.
3. The module must not contain app/UI code, network calls, or analytics.

## 9. Explicitly out of scope

- Tajweed/makharij grading, pronunciation scoring, memorization statistics.
- The speech recognizer itself (Web Speech API input is assumed; a
  server-side Whisper upgrade is a separate follow-up project).
- Any UI, styling, page images, tafsir, audio playback, or backend work.
- Anything not listed in §4/§5 — when in doubt, hold position rather than act.
