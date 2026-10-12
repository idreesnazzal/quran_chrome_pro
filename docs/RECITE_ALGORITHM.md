# Recite-by-Mic v3: the algorithm

File: `assets/js/recite-by-mic.js`. It has no dependencies. Its UI contract with `index.html` is the same as v2's.
The old engine is kept at `assets/js/legacy/recite-by-mic.v2.9.2.js`. The benchmark uses it, and nothing else does.

## Why v2 was replaced

v2 started from a reasonable core: BM25 retrieval, a Smith-Waterman rerank and a per-word follower. Around that core it grew 13 patches, each one fixing a single screenshot: a basmala guard, an isti'adha guard, an opener strip, tie rules, a drift counter, a watchdog, a re-anchor and a pending-jump confirm. Each rule made a local decision, and they interfered with each other.

v2 also had defects in its live input:

- **Interim revisions duplicated words.** Chrome rewrites its interim guess, for example قال → قل. v2's overlap-join could not tell a revision from new speech, so it appended both. The follower then saw repeats and treated them as "backward drift".
- **Two input paths wrote into one stream.** Web Speech and Whisper both fed the same stream, so text arriving late was consumed twice.
- **The "92%" confidence was a constant.**

On the held-out benchmark below, v2 places 50–83% of words correctly. It makes 117 false jumps and 36 flip-flops.

## The model

The Quran is read as **one word sequence**. That is 77,797 data words, plus a virtual basmala before every surah except 1 and 9. The tracker keeps a belief over positions. This is the standard approach to following a known text (score following and lyrics tracking), implemented as a forward algorithm over a hidden Markov model.

| piece | v3 |
|---|---|
| state `g` | "the last recited word is `g`" |
| next word | 0.80 |
| skip 1..5 words (ASR deletions) | 0.06 / 0.02 / 0.008 / 0.005 / 0.004 |
| two text words heard as one token (يا ايها → يايها) | 0.04, compared against the concatenation |
| same word again | 0.03 |
| restart 1..8 words back | 0.035, spread evenly |
| restart at the start of the current ayah | 0.015 |
| heard word is not Quran text (stay) | 0.08 |
| surah end → next surah without its basmala | 0.35 |
| **teleport** (a real jump) | 0.006, split over *seeds* |
| emission | `clamp(5·(sim − 0.55), −4, 2.25)`, where sim = 1 − Levenshtein/maxlen |

- **Seeds.** Seed positions come from an inverted index:
  - the positions of the bigram (previous word, word), or else the positions of the word itself;
  - for a spelling that never occurs in the text, a fuzzy match (sim ≥ 0.8) against the vocabulary.

  The teleport mass is split across the seeds. A common word therefore barely teleports, and a rare one does.
- **Inference.** The forward algorithm runs in log space with a beam of 96 states. One step costs about 1 ms.
- **Answer.** The answer is the best state. **Confidence** is the posterior mass within ±3 words of it. It is a real probability, and the table below shows it is calibrated.

### What the model does without special cases

- **Refrains (mutashabihat), such as فبأي آلاء ربكما تكذبان ×31.** The sequential path keeps winning because a teleport is expensive. Starting cold on a refrain gives a split belief, so the engine shows nothing and waits for a word that tells the copies apart.
- **Basmala before a surah.** The basmala is literally text before every surah, so the words that follow pick the surah. A basmala followed by الحمد لله رب العالمين resolves to 1:2. A basmala followed by براءة resolves to 9:1, through a teleport.
- **Short ayahs (الم, مدهامتان, 18:3).** These are just positions, so the tracker passes through them in the middle of the speech stream.
- **Garbage input** (MSA acoustics hearing melodic recitation). Every hypothesis scores badly and confidence drops. The *lost* detector then fires: at least 3 of the last 6 words scored badly, and there were not yet 2 good words in a row.

### The only rule-based parts

1. **Opener filter.** This is a streaming matcher that swallows text which is not Quran: أعوذ بالله (من الشيطان الرجيم | السميع العليم…), صدق الله العظيم, الله أكبر and آمين. Patterns of 2 words or fewer must match exactly, so «امين» cannot swallow «امن».
2. **Display gate** (`decide()`):
   - Show a position only when its confidence is at least 0.45.
   - A move of more than 8 words needs confidence of at least 0.75.
   - The highlight never moves onto a word that the last heard word does not resemble (sim < 0.5).
   - The page turns immediately at confidence ≥ 0.80. At confidence ≥ 0.55 it turns only after two consecutive updates agree.

### Live input

- **Web Speech results are consumed by result index.** Each final result is committed to the tracker exactly once.
- **Interim text is evaluated on a copy of the belief** (`peek`). This lets the highlight move as you speak, and a revised guess can never leave anything behind. The steps from the previous peek are reused up to the first word that changed, so each interim event costs 1–3 steps.
- **Android Chrome sometimes re-sends the previous final result as a prefix.** Exactly that prefix is stripped, and nothing looser.
- **Only one input source is active at a time:** the browser recognizer, or the Whisper server if `server/recite_server.py` reports a model loaded.

## Ears: where the words come from

The tracker is fed by one of three sources. Only one is active at a time.

| source | when | quality |
|---|---|---|
| **Quran model in the browser** (🧠 button in the recite dock) | the reader turned it on; the app was opened over http(s) | Whisper base fine-tuned on Quran recitation (`tarteel-ai/whisper-base-ar-quran`, ONNX build `iqbalaesthetic/Basira`, Apache-2.0) |
| Whisper server (`server/recite_server.py` with a model) | the server reports a loaded model | depends on the model |
| Chrome's recognizer (`ar-SA`) | default | general Arabic (MSA) acoustics; weak on melodic tajweed |

How the Quran model runs:

- **Files.**
  - `assets/js/whisper-worker.js` is an ES-module Web Worker.
  - `assets/vendor/transformers/` holds transformers.js 3.8.1 and the ONNX Runtime wasm (21.6 MB). These are vendored, so there is no CDN dependency.
  - The model itself is about 103 MB (int8, on WASM), or fp16/q4 on WebGPU. It is downloaded from huggingface.co once and cached in the browser's Cache Storage. After that it works offline, and audio never leaves the device.
- **Speed.** When served by `recite_server.py`, the page is cross-origin isolated (COOP `same-origin` and COEP `credentialless`). That allows multi-threaded WASM.
- **Streaming** (`recite-by-mic.js`, the "local ears" section):
  1. The mic is captured at 16 kHz through an AudioWorklet.
  2. An energy-based voice-activity detector with an adaptive noise floor splits speech into segments. A segment closes at a pause of 650 ms (a natural waqf), or is cut at 18 s.
  3. While a segment grows, it is re-transcribed every 0.9 s. Words that two consecutive passes agree on are committed to the tracker; this is "local agreement" (as in whisper_streaming). The rest is shown as tentative.
  4. At the pause, the whole segment is transcribed once more and the remainder is committed.
- **Downloading.** While the model downloads, Chrome's recognizer keeps following the reader. When the model is ready, the source switches without restarting the session.

## Results

Each row was produced by `node tests/benchmark.js`. Both engines run through the same fake Chrome event stream: interim results grow, 25% of interims get revised, then the final arrives. The text is the real 6,236-ayah corpus. The **held-out** seeds were never used for tuning. Tuning used `--tune`.

See `tests/benchmark_heldout.txt` for the latest full table, including per-event timings (p50/p95/p99).

Noise in the `noisy` rows is applied per word:

| noise | rate |
|---|---|
| dropped | 10% |
| inserted junk | 5% |
| restart | 2% |
| stutter | 3% |
| merged | 3% |
| split | 2% |
| substituted | 7% |
| misspelled | 10% |

**Golden cases:** `node tests/run_tests.js` runs 38 checks covering the scenarios listed in the recite-algorithm prompt. All of them pass. `tests/golden_results.txt` holds the last run.

## Known limits (honest list)

- **This is a text model.** The engine is only as good as the words it hears. Chrome's ar-SA recognizer uses MSA acoustics, and on melodic tajweed recitation it often returns cadence-shaped nonsense. v3 *holds* instead of jumping when that happens, but it cannot follow words it never hears. The real fix is on the acoustic side: a Quran-trained ASR model. See the next steps in `docs/AUDIT_2026-10-12.md`.
- **The noise is synthetic.** The noise model is mine, not recorded from real recitation. Real Web Speech logs should be added as a separate test set before the numbers are trusted further.
- **Heavy noise right after a jump takes longer to lock.** Jumps under heavy noise lock after a median of 5 words. That costs accuracy during the lock, which is why the jump-noisy row is lower than the others.
- **Word boxes.** `data/word_boxes.js` is measured from the page images by `scripts/build_word_boxes.py`. Words that begin with a detached «إ» are sometimes split, with a neighbouring pair merged to compensate. 9 ayahs fall back to the proportional estimate.
