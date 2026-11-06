#!/usr/bin/env python3
"""Generate the Phase-2 Kaggle notebook (evaluation + optional fine-tuning)."""
import json, os

cells = []
def md(text): cells.append({"cell_type":"markdown","metadata":{},"source":text.splitlines(keepends=True)})
def code(text): cells.append({"cell_type":"code","execution_count":None,"metadata":{},"outputs":[],"source":text.splitlines(keepends=True)})

md("""# Tasmee Ears — evaluate / fine-tune a Quran CTC on the owner's voice

This is the Phase-2 notebook for the optional **ears** mode of the tasmee app.
It evaluates the **Tilawi FastConformer** (Quran CTC, CC-BY-4.0) on the owner's
exported tasmee sessions and, if the measured error rates miss the targets,
fine-tunes it.

The Arabic report for the owner is `docs/PHASE1_EARS_REPORT.md`. The Phase-1
harness is in `ml/`.

## What you need
- A Kaggle notebook (CPU for evaluation; T4 GPU for fine-tuning).
- The owner's exported session JSON files (from the app's 🎙️ recorder) uploaded
  as a Kaggle dataset. Each file has `meta` (expected words + verdicts) and
  `audio.dataUrl` (WebM/Opus, base64).
- Internet access to HuggingFace (Kaggle has it).

## Targets
- ≤1 false mistake per 100 correctly read words.
- ≥90% of substituted or skipped words caught.
- <1.5 s from the end of a word to its verdict (measure on a phone; this notebook
  measures the model, not the phone UI).

## How to use
1. Run the evaluation cells. They print the false-mistake rate, caught-mistake
   rate, latency, and the threshold sweep.
2. If the false-mistake rate is >1% or the caught-mistake rate is <90%, run the
   optional fine-tuning cells (GPU).
3. Export the fine-tuned model to ONNX and upload it to HuggingFace. The app can
   then load it with onnxruntime-web.

## Important
- The model is a **Quran CTC** fine-tune from NVIDIA FastConformer. It is not a
  Whisper model. The Phase-1 Whisper baseline failed the false-mistake target.
- The numbers in `docs/PHASE1_EARS_REPORT.md` for Tilawi are third-party
  measurements (0.17% false, 91.65% strict / 97.83% lenient caught). This
  notebook measures **your voice**, which is the only measurement that matters.
""")

code("""import subprocess, sys, os
# Kaggle usually has torch/torchaudio. Install only what is missing.
def pip(*args):
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', *args], check=True)
try:
    import torch, torchaudio
except ImportError:
    pip('torch', 'torchaudio')
pip('onnxruntime', 'huggingface_hub', 'imageio-ffmpeg', 'soundfile', 'librosa', 'numpy')
import torch, torchaudio
print('torch', torch.__version__, 'torchaudio', torchaudio.__version__)
""")

code("""import os, json, glob, base64, io, wave, math, time, tempfile, subprocess
import numpy as np
import torch, torchaudio
import onnxruntime as ort
from huggingface_hub import snapshot_download
import imageio_ffmpeg

MODEL_ID = 'muhdur/tilawi-fastconformer-quran'
SESSION_DIR = os.environ.get('TASMEE_SESSIONS', '/kaggle/input/tasmee-sessions')
OUT_DIR = '/kaggle/working'
ASSET_DIR = os.path.join(OUT_DIR, 'assets')
os.makedirs(ASSET_DIR, exist_ok=True)
SAMPLE_RATE = 16000
BLANK_ID = 1024
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
print('model', MODEL_ID)
print('sessions', SESSION_DIR, os.path.isdir(SESSION_DIR))
print('ffmpeg', FFMPEG)
""")

code("""# Download the model + assets from HuggingFace (about 110 MB).
# The repo is public; the model is CC-BY-4.0 (attribution required).
snapshot_download(MODEL_ID, local_dir=ASSET_DIR)
print(os.listdir(ASSET_DIR))
""")

code("""# Load the assets and the ONNX session.
with open(os.path.join(ASSET_DIR, 'vocab.json'), encoding='utf-8') as f:
    VOCAB = json.load(f)                       # {id: sentencepiece token}
with open(os.path.join(ASSET_DIR, 'quran_ctc_tokens.json'), encoding='utf-8') as f:
    CTC_TOKENS = json.load(f)                  # {"surah:ayah:ayahEnd": [token ids]}
with open(os.path.join(ASSET_DIR, 'quran.json'), encoding='utf-8') as f:
    QURAN = json.load(f)                       # list of verses
print('vocab', len(VOCAB), 'verses', len(QURAN), 'ctc keys', len(CTC_TOKENS))
print(QURAN[0])

SESS = ort.InferenceSession(os.path.join(ASSET_DIR, 'fastconformer_full_mixed.onnx'),
                            providers=['CPUExecutionProvider'])
print('inputs', [(i.name, i.shape, i.type) for i in SESS.get_inputs()])
print('outputs', [(o.name, o.shape, o.type) for o in SESS.get_outputs()])
""")

code("""# Audio: data URL (WebM/Opus) -> 16 kHz mono float32.
def decode_data_url(data_url, out_path):
    if ',' not in data_url:
        raise ValueError('not a data URL')
    head, b64 = data_url.split(',', 1)
    open(out_path, 'wb').write(base64.b64decode(b64))
    return out_path

def to_pcm16k(src_path, wav_path):
    subprocess.run([FFMPEG, '-y', '-v', 'error', '-i', src_path,
                    '-ac', '1', '-ar', str(SAMPLE_RATE), '-c:a', 'pcm_s16le', wav_path],
                   check=True)
    with wave.open(wav_path, 'rb') as w:
        n = w.getnframes(); sr = w.getframerate()
        x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return x, sr

def run_ctc(audio):
    audio = np.asarray(audio, dtype=np.float32)
    length = np.array([audio.shape[0]], dtype=np.int64)
    out = SESS.run(None, {'audio_signal': audio[None, :], 'length': length})[0]
    # out: [1, T, vocab]
    return out[0]
""")

code("""# CTC text utilities (port of Tilawi's TextCTCDecoder).
WORD_PREFIX = '▁'
def token_ids_to_text(ids):
    toks = [VOCAB.get(str(i), '') for i in ids if i != BLANK_ID]
    s = ''.join(t for t in toks if t and t not in ('<unk>', '<blank>'))
    s = s.replace(WORD_PREFIX, ' ')
    return ' '.join(s.split())

def token_ids_to_word_ends(ids):
    toks = [VOCAB.get(str(i), '') for i in ids if i != BLANK_ID]
    ends, in_word = [], False
    for i, t in enumerate(toks):
        if t == WORD_PREFIX or t.startswith(WORD_PREFIX):
            if in_word: ends.append(i)
            in_word = t != WORD_PREFIX
            continue
        in_word = True
    if in_word: ends.append(len(toks))
    return [e for i, e in enumerate(ends) if i == 0 or e > ends[i-1]]

def verse_word_tokens(surah, ayah, ayah_end=None):
    key = f'{surah}:{ayah}:{ayah_end if ayah_end else ayah}'
    ids = CTC_TOKENS.get(key)
    if ids is None:
        key = f'{surah}:{ayah}:{ayah}'
        ids = CTC_TOKENS.get(key)
    if ids is None: return []
    ends = token_ids_to_word_ends(ids)
    out, start = [], 0
    for e in ends:
        out.append(ids[start:e]); start = e
    return out
""")

code("""# Forced alignment: torchaudio if available, else a compact Viterbi.
def align_tokens(logprobs, tokens, blank_id=BLANK_ID):
    if len(tokens) == 0: return None, None
    lp = torch.as_tensor(logprobs, dtype=torch.float32)
    try:
        aligned, scores = torchaudio.functional.forced_align(lp, torch.tensor(tokens, dtype=torch.int32), blank_id)
        return aligned.tolist(), scores.tolist()
    except Exception:
        pass
    # Viterbi over the extended state sequence [blank, t1, blank, t2, ..., blank]
    ext = [blank_id]
    for t in tokens: ext.extend([t, blank_id])
    S = len(ext); T = lp.shape[0]
    dp = np.full((T, S), -1e9, dtype=np.float64); bp = np.zeros((T, S), dtype=np.int32)
    dp[0, 0] = lp[0, ext[0]]
    if S > 1: dp[0, 1] = lp[0, ext[1]]
    for t in range(1, T):
        for s in range(S):
            best, arg = -1e9, 0
            if s > 0:
                v = dp[t-1, s-1]
                if v > best: best, arg = v, s-1
            v = dp[t-1, s]
            if v > best: best, arg = v, s
            if s + 1 < S and ext[s+1] == ext[s]:
                v = dp[t-1, s+1]
                if v > best: best, arg = v, s+1
            dp[t, s] = best + lp[t, ext[s]]; bp[t, s] = arg
    s = int(np.argmax(dp[-1])); path = []
    for t in range(T-1, -1, -1):
        path.append(ext[s]); s = int(bp[t, s])
    path = list(reversed(path))
    # token scores: sum of the aligned frames for each token occurrence
    scores, i = [], 0
    for tok in tokens:
        vals = []
        while i < len(path) and path[i] == blank_id: i += 1
        while i < len(path) and path[i] == tok:
            vals.append(lp[i, tok]); i += 1
        scores.append(float(np.mean(vals)) if vals else -1e9)
    return path, scores
""")

code("""# Evaluate one session.
def evaluate_session(session, threshold=-1.0, use_transcript=False):
    meta = session['meta']
    audio_url = session['audio']['dataUrl']
    tmp = os.path.join(tempfile.gettempdir(), 's.webm')
    wav = os.path.join(tempfile.gettempdir(), 's.wav')
    decode_data_url(audio_url, tmp)
    audio, sr = to_pcm16k(tmp, wav)
    t0 = time.time(); logprobs = run_ctc(audio); infer_s = time.time() - t0
    # transcript-based judge (baseline)
    hyp_ids = []
    prev = -1
    for t in range(logprobs.shape[0]):
        a = int(np.argmax(logprobs[t]))
        if a != prev and a != BLANK_ID: hyp_ids.append(a)
        prev = a
    hyp_text = token_ids_to_text(hyp_ids)
    rows = []
    for w in meta['words']:
        if w['state'] == 0: continue
        if w['state'] == 1: truth = 'correct'
        elif w['state'] == 7: truth = 'yellow'
        else: truth = 'error'
        if truth == 'yellow': continue
        ai = w['ai']; widx = w['w']
        if ai is None or widx is None: continue
        verse = QURAN[ai]
        toks = verse_word_tokens(verse['surah'], verse['ayah'])
        if widx >= len(toks): continue
        word_toks = toks[widx]
        aligned, scores = align_tokens(logprobs, word_toks)
        score = float(np.mean(scores)) if scores else -1e9
        # transcript baseline: is the expected word in the transcript?
        exp = w['expected']
        found = any(exp == hw or exp.replace('أ','ا') == hw.replace('أ','ا') for hw in hyp_text.split())
        rows.append({'k': w['k'], 'expected': exp, 'truth': truth, 'score': score,
                     'transcript_found': found, 'word_toks': word_toks})
    return {'rows': rows, 'infer_s': infer_s, 'audio_s': len(audio)/sr,
            'hyp_text': hyp_text, 'meta': meta}
""")

code("""# Load the owner's sessions.
files = sorted(glob.glob(os.path.join(SESSION_DIR, '*.json')))
print('session files', len(files))
if not files:
    print('No sessions found. Upload the exported JSON files to', SESSION_DIR)
else:
    sessions = []
    for f in files:
        try:
            sessions.append(json.load(open(f, encoding='utf-8')))
        except Exception as e:
            print('skip', f, e)
    print('loaded', len(sessions))
    print(sessions[0]['meta'].keys())
    print(sessions[0]['meta']['range'], len(sessions[0]['meta']['words']))
""")

code("""# Evaluate all sessions at a fixed threshold first.
if files:
    results = [evaluate_session(s, threshold=-1.0) for s in sessions]
    rows = [r for res in results for r in res['rows']]
    correct = [r for r in rows if r['truth'] == 'correct']
    errors = [r for r in rows if r['truth'] == 'error']
    print('correct words', len(correct), 'error words', len(errors))
    print('median inference s', float(np.median([r['infer_s'] for r in results])))
    print('audio s median', float(np.median([r['audio_s'] for r in results])))
    print('threshold sweep (CTC score):')
    for th in [-3, -2, -1.5, -1, -0.5, 0]:
        fp = sum(1 for r in correct if r['score'] < th)
        ca = sum(1 for r in errors if r['score'] < th)
        print(f'  th={th:5.2f}  false={100*fp/max(1,len(correct)):6.2f}%  caught={100*ca/max(1,len(errors)):6.2f}%')
""")

code("""# Leave-one-session-out threshold: choose the threshold on the other sessions
# to hit <=1% false mistakes, then evaluate the held-out session.
if files and len(sessions) > 1:
    print('leave-one-session-out (target <=1% false mistakes):')
    agg = []
    for i, s in enumerate(sessions):
        res = evaluate_session(s, threshold=-1.0)
        others = [r for j, sj in enumerate(sessions) if j != i for r in evaluate_session(sj, threshold=-1.0)['rows']]
        oc = [r['score'] for r in others if r['truth'] == 'correct']
        oe = [r['score'] for r in others if r['truth'] == 'error']
        if not oc or not oe: continue
        # the 1st percentile of correct scores -> ~1% false mistakes on the other sessions
        th = float(np.percentile(oc, 1))
        c = [r for r in res['rows'] if r['truth'] == 'correct']
        e = [r for r in res['rows'] if r['truth'] == 'error']
        fp = sum(1 for r in c if r['score'] < th); ca = sum(1 for r in e if r['score'] < th)
        agg.append((th, len(c), fp, len(e), ca))
        print(f'  {s["meta"].get("range","?"):24s} th={th:5.2f}  false={100*fp/max(1,len(c)):6.2f}%  caught={100*ca/max(1,len(e)):6.2f}%')
    if agg:
        print('mean false', 100*np.mean([a[2]/max(1,a[1]) for a in agg]))
        print('mean caught', 100*np.mean([a[4]/max(1,a[3]) for a in agg]))
""")

md("""## Optional: fine-tune on the owner's voice (GPU)

Run this section only if the measured false-mistake rate is >1% or the
caught-mistake rate is <90%. Fine-tuning a large FastConformer on a few hours of
one speaker can overfit; use a small learning rate, a held-out session, and
early stopping. The notebook below is a template; the owner should adapt the
NeMo config and the data manifest.

The model is fine-tuned from NVIDIA's `stt_ar_fastconformer_hybrid_large_pcd_v1.0`
(CC-BY-4.0). The Tilawi ONNX model is a fine-tune of that model. To fine-tune,
use the NeMo toolkit and the owner's audio + expected word sequences. Export the
fine-tuned model to ONNX with NeMo's `export()` or the
`moabdelmoez/fastconformer-quran-onnx` script, then upload it to HuggingFace.
""")

code("""# GPU check (Kaggle T4). This cell is optional.
print('cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')
""")

code("""# Fine-tuning template (optional, requires a GPU and the NeMo model).
# The owner's sessions are small; use a low LR and a few epochs.
import subprocess, sys
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'nemo_toolkit[asr]'], check=True)

import nemo.collections.asr as nemo_asr

# The base model is the same family as the Tilawi model. Use the NeMo config
# for the FastConformer hybrid large PCD. The exact config may differ; adapt it.
# model = nemo_asr.models.ASRModel.from_pretrained('nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0')
# ... prepare a NeMo manifest from the owner's sessions (audio_filepath, duration, text)
# ... set up the trainer with max_epochs=5, learning_rate=1e-5, devices=1, accelerator='gpu'
# ... model.fit(...)
# ... model.export('fastconformer_tasmee_owner.onnx')
print('Fine-tuning template: adapt the NeMo config and the manifest to the owner data.')
""")

md("""## What to report back

- The false-mistake rate and caught-mistake rate on the owner's voice, with the
  threshold and the number of correct/error words.
- The latency of the model on the Kaggle CPU (not the phone). The phone latency
  must be measured in the app with onnxruntime-web.
- Whether the model needs fine-tuning. If yes, the fine-tuned ONNX model and the
  evaluation on a held-out session.
- The model size and licence. The Tilawi model is CC-BY-4.0; the Quran-Lab
  Zipformer is NPL-1.2 (non-commercial); Hifdh-Compass is NPL-1.0 (non-commercial).

## Limitations

- The owner's voice is not available in the Phase-1 sandbox; this notebook is a
  template. The numbers on public reciters are not enough.
- The CTC forced-alignment score is not the same as the transcript-based judge.
  Compare both; the forced-alignment score is more likely to meet the 1%
  false-mistake target because it scores the expected word's pronunciation
  directly.
- The model may still "autocorrect" toward the Quran text. The forced-alignment
  score is the check against that risk.
""")

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
      "language_info": {"name": "python", "version": "3.11"}}, "nbformat": 4, "nbformat_minor": 5}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tasmee_ears_eval_finetune.ipynb')
with open(out, 'w', encoding='utf-8') as f:
    json.dump(nb, f, ensure_ascii=False, indent=1)
print('wrote', out, len(cells), 'cells')
