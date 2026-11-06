# Phase 1 — Tasmee "ears" evaluation

This directory contains the Phase-1 evaluation harness only. No app code, tasmee
behaviour, or `docs/TASMEE_SPEC.md` decision was changed. The Arabic report for
the owner is `docs/PHASE1_EARS_REPORT.md`.

## What is measured

- **Correct recitation (60 clips, 5–25 s):** 20 clips each from Hudhaify, Ahmed
  ibn Ali al-Ajamy and Abdul Basit (murattal). Audio: `iptvchecker/content-everyayah`
  (public mirror of EveryAyah). Timings: `Abdalla-Eldoumani/maqra`. Only ayahs
  whose MP3 duration matches the timing duration within 0.5 s are kept.
- **Spliced clips (48):** 30 substitutions + 18 skips from Husary (QuranHub,
  Unlicense) with word timings from `spa5k/quran_timings_api`. Substitutions use
  real words from the same reciter, including `كلا → كل`, `يعلمون → تعلمون`,
  `الرحمن → الرحيم`, `نور → نار`, `قال → كان`, `في → من`, `من → في`, `على → إلى`,
  `الأولى → الآخرة`, `خير → خسر`, `الأرض → الأعراب`. `العرب` is not in the Quran
  text, so `الأعراب` is used as the near-sounding donor.
- **Owner's voice:** none. The opt-in recorder is designed but not built.

## Candidate run

`openai/whisper-small` converted to CTranslate2 int8, from the npm package
`@skillninja/shortmovie-telop-model-p0..p3` (the package is a general Whisper
small model, not Tarteel). The model is concatenated from the four parts and
verified against the published SHA-256. It is **not committed**.

Results (2 vCPU, 4 GB RAM, no GPU):

| metric | value |
|---|---:|
| correct clips | 60 |
| expected words | 552 |
| false words | 105 |
| false-mistake word rate | **19.02%** |
| spliced clips | 48 (30 sub, 18 skip) |
| strict caught (aligned position) | **48/48 (100%)** |
| lenient caught (target anywhere) | 42/48 (87.5%) |
| latency median / p90 / max | 4.42 s / 5.02 s / 7.3 s per clip |

Windowed "score the expected word" sweep (best transcript similarity in a ±2
window):

| threshold | false-mistake | strict caught | lenient caught |
|---:|---:|---:|---:|
| 0.50 | 5.07% | 64.58% | 47.92% |
| 0.70 | 9.60% | 91.67% | 83.33% |
| 0.90 | 19.02% | 97.92% | 93.75% |

No threshold meets both targets (≤1% false mistakes and ≥90% caught). This is a
transcription-based scorer, not a CTC log-prob scorer; the limitation is part of
the result.

## Third-party Quran CTC (re-analysed, not run here)

`Tilawi/quran-asr` publishes raw results for 600 verses (200 each: Minshawi,
Husary, Alafasy) and a word-level memorization eval. Re-analysis of the raw JSON:

- clean: 7,551 expected words, 13 false accusations = **0.17%**, 9/600 verses.
- substitution: 549/599 strict = **91.65%**, 586/599 lenient = 97.83%.
- omission: 593/596 = **99.5%**; insertion: 597/599 = **99.67%**.
- latency: median 0.92–1.12 s per clip, p90 1.8–2.4 s, max 5.8 s on their CPU
  (hardware unknown). Model: 88,307,366 bytes ONNX. Code MIT, model CC-BY-4.0.

The model weights are on HuggingFace, which is blocked in this sandbox, so we
could not run it. The numbers are third-party measurements, not ours.

## Reproduce

```bash
# Python 3.11, 2 vCPU, 4 GB RAM
python -m venv .venv && . .venv/bin/activate
pip install faster-whisper imageio-ffmpeg numpy

# audio + timings are already under ml/.cache (gitignored)
python ml/eval/build_correct_set.py       # writes ml/results/correct_set.json
python ml/eval/build_curated_spliced.py   # writes ml/results/spliced_set.json
python ml/eval/run_whisper.py             # writes ml/results/whisper_*.json
python ml/eval/whisper_scoring_tradeoff.py
```

The Whisper model is not in this repo. It was assembled from the four npm
parts (`model.bin.part0..3` + `config.json`, `tokenizer.json`,
`preprocessor_config.json`, `vocabulary.json`); `model.bin` SHA-256 is
`ca732cb1379efc49417d028465f543d83a39de2c61f3027678de103dc404ce73`. Set
`WHISPER_MODEL` to the directory that contains those files before running
`run_whisper.py`.

## Data/licence notes

- Audio is not committed. `ml/.cache/` is gitignored.
- QuranHub audio is Unlicense; the EveryAyah mirror is a public mirror but the
  original recordings remain the reciters' property. Used for internal
  evaluation only.
- `spa5k/quran_timings_api` and `Abdalla-Eldoumani/maqra` timings are used for
  evaluation; their licences are not asserted here.
- The Tarteel model is Apache-2.0; the Tilawi model is CC-BY-4.0; the Quran-Lab
  Zipformer is NPL-1.2 (non-commercial); Hifdh-Compass is NPL-1.0 (non-commercial).

## Blockers

- HuggingFace and GitHub release assets are blocked in the sandbox. We could not
  download the Tarteel, Tilawi, Quran-Lab or Hifdh-Compass weights.
- No owner recordings. All numbers are on public reciters.
- Only 2 less-known reciters with matching audio+timings; the third is famous.
- `العرب` is not in the Quran text; `الأعراب` is the donor.
- Word-to-verdict latency is not measured; the Tilawi numbers are per clip.

## Phase 2 — opt-in recorder + Kaggle notebook

- `assets/js/tasmee_recorder.js` — opt-in recorder. It opens a separate
  `getUserMedia` stream with the same constraints as the speech recogniser,
  records WebM/Opus in 10 s chunks, and stores the audio + expected words +
  verdicts in IndexedDB. Nothing is uploaded. The owner must tick a consent box.
  The bar button (🎙️) opens the panel; the panel can start/stop/export/delete.
- `assets/js/tasmee.js` — optional hooks only (`onStart`, `onHeard`, `onStop`)
  and the 🎙️ button. The hooks are no-ops when the recorder module is absent.
- `tests/tasmee_recorder.js` — 8/8 checks of the metadata builder.
- `ml/kaggle/tasmee_ears_eval_finetune.ipynb` — Kaggle notebook: downloads the
  Tilawi FastConformer, converts the exported sessions to 16 kHz mono, runs the
  CTC model, computes per-word forced-alignment scores, reports false-mistake
  and caught-mistake rates with a leave-one-session-out threshold, and includes
  an optional NeMo fine-tuning template. `ml/kaggle/make_notebook.py` generates
  it.
- The exported session JSON is `{meta, audio:{mime, dataUrl}}`; the notebook
  reads it directly. The audio stays local until the owner exports it.
- The recorder is not tested on a real phone (Playwright Chromium download is
  blocked in this sandbox). The Kaggle notebook is a template; it was not run
  because HuggingFace is blocked in this sandbox.

The Arabic Phase-2 report for the owner is `docs/PHASE2_RECORDER_REPORT.md`.

## Phase 3 — opt-in ears mode (Tilawi FastConformer)

- `assets/js/tasmee_ears.js` — loads the Tilawi FastConformer (Quran CTC,
  CC-BY-4.0) from HuggingFace with onnxruntime-web, keeps the last 4 s of mic
  audio, and scores the expected word with a Viterbi CTC forced alignment.
- `assets/vendor/onnxruntime/` — onnxruntime-web 1.31.1 (MIT), WASM build
  (`ort.wasm.min.js` 53 KB + `ort-wasm-simd-threaded.wasm` 15 MB). The model
  (88 MB) and the 12 MB `quran_ctc_tokens.json` are fetched from HuggingFace at
  runtime and are **not** in git.
- `assets/js/recite-by-mic.js` — a `tilawi` ears mode reuses the existing
  `LW` capture (16 kHz) and feeds the audio to `TasmeeEars.feedAudio`.
- `assets/js/tasmee.js` — after each final result, if the ears mode is on, it
  calls `TasmeeEars.review` and applies a conservative second opinion: a
  correct word whose score is below the threshold turns red; a false red word
  whose score is above the threshold turns correct. Yellow words are untouched.
- `assets/js/settings.js` — the setting is in ⚙️ الإعدادات ← 🧠 وضع التسميع ←
  الأذن: Chrome (default) or Tilawi. The choice is stored in `tasmee_prefs.ears`.
- `tests/tasmee_ears.js` — 6/6 checks of the CTC token boundaries and Viterbi
  alignment.

The browser tests (`tests/tasmee_e2e.py`, `tests/tasmee_real.py`,
`tests/browser_e2e.py`) fail in this sandbox because Chrome is not installed
and the Playwright Chromium download is blocked. The Node tests pass:
`tasmee_core` 53/53, `run_tests` 102/102, `tasmee_recorder` 8/8,
`tasmee_ears` 6/6.

The Arabic Phase-3 report for the owner is `docs/PHASE3_EARS_REPORT.md`.
