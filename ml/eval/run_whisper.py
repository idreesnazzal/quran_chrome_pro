#!/usr/bin/env python3
"""Phase-1 candidate A: general Whisper small (CTranslate2 int8) on CPU.

We measure (1) transcription false-mistake rate on correct recitation and
(2) whether a skipped/substituted word is caught, plus wall-clock latency.
This is a transcription baseline, not a forced-alignment scorer; the
limitation is part of the result.
"""
import json, os, re, sys, time, statistics
from faster_whisper import WhisperModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache')
RES = os.path.join(ROOT, 'results')
MODEL = os.environ.get('WHISPER_MODEL', '/home/user/tmp/pkgs/whisper_model/package')

def strip_diacritics(s):
    return re.sub(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]', '', s)

def norm(s):
    s = strip_diacritics(s)
    for a, b in [('أ','ا'),('إ','ا'),('آ','ا'),('ى','ي'),('ة','ه'),('ؤ','و'),('ئ','ي'),('ء','')]:
        s = s.replace(a, b)
    return s

def words(text):
    t = re.sub(r'\s*\(\d+\)\s*$', '', text)
    return [w for w in re.split(r'\s+', t.strip()) if w]

def clean_transcript(t):
    t = re.sub(r'[0-9\u0660-\u0669]+', ' ', t)
    t = re.sub(r'[^\u0621-\u064a\s]', ' ', t)
    return [w for w in re.split(r'\s+', t.strip()) if w]

def align(exp, hyp):
    """Word-level Levenshtein alignment. Returns list of (exp_i, hyp_j, cost)."""
    n, m = len(exp), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1): dp[i][0] = i
    for j in range(1, m + 1): dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if norm(exp[i-1]) == norm(hyp[j-1]) else 1
            dp[i][j] = min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost)
    i, j = n, m
    out = []
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            cost = 0 if norm(exp[i-1]) == norm(hyp[j-1]) else 1
            if dp[i][j] == dp[i-1][j-1] + cost:
                out.append((i-1, j-1, cost)); i -= 1; j -= 1; continue
        if i > 0 and dp[i][j] == dp[i-1][j] + 1:
            out.append((i-1, None, 1)); i -= 1; continue
        out.append((None, j-1, 1)); j -= 1
    return list(reversed(out))

def sim(a, b):
    a, b = norm(a), norm(b)
    if not a and not b: return 1.0
    m, n = len(a), len(b)
    dp = list(range(n + 1))
    for i in range(1, m + 1):
        prev = dp[0]; dp[0] = i
        for j in range(1, n + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j-1] + 1, prev + (a[i-1] != b[j-1]))
            prev = cur
    return 1.0 - dp[n] / max(m, n, 1)

def main():
    correct = json.load(open(os.path.join(RES, 'correct_set.json')))
    spliced = json.load(open(os.path.join(RES, 'spliced_set.json')))
    model = WhisperModel(MODEL, device='cpu', compute_type='int8', cpu_threads=2)
    out = {'correct': [], 'spliced': [], 'latency': []}
    t0 = time.time()
    for idx, item in enumerate(correct):
        path = os.path.join(ROOT, item['audio'])
        exp = words(item['text'])
        t = time.time()
        segs, info = model.transcribe(path, language='ar', task='transcribe', beam_size=1,
                                      vad_filter=False, condition_on_previous_text=False)
        text = ' '.join(s.text for s in segs)
        dt = time.time() - t
        hyp = clean_transcript(text)
        al = align(exp, hyp)
        exp_aligned = {}
        for ei, hj, cost in al:
            if ei is not None:
                exp_aligned[ei] = (hj, cost)
        false_words = []
        for ei, w in enumerate(exp):
            hj, cost = exp_aligned.get(ei, (None, 1))
            hw = hyp[hj] if hj is not None else None
            s = sim(w, hw) if hw is not None else 0.0
            if cost != 0 or s < 0.8:
                false_words.append({'i': ei, 'word': w, 'heard': hw, 'sim': round(s, 2)})
        out['correct'].append({'id': idx, 's': item['s'], 'a': item['a'], 'reciter': item['reciter'],
                               'audio_s': item['audio_s'], 'infer_s': round(dt, 2),
                               'text': text, 'expected': item['text'], 'false_words': false_words})
        out['latency'].append(dt)
        print(f'[correct {idx+1}/{len(correct)}] {item["reciter"]} {item["s"]}:{item["a"]} {dt:.2f}s false={len(false_words)}/{len(exp)}', flush=True)
        json.dump(out, open(os.path.join(RES, 'whisper_results.json'), 'w'), ensure_ascii=False)
    for idx, item in enumerate(spliced):
        path = os.path.join(ROOT, item['audio'])
        exp = words(item['expected'])
        ti = item['target_index']
        t = time.time()
        segs, info = model.transcribe(path, language='ar', task='transcribe', beam_size=1,
                                      vad_filter=False, condition_on_previous_text=False)
        text = ' '.join(s.text for s in segs)
        dt = time.time() - t
        hyp = clean_transcript(text)
        al = align(exp, hyp)
        exp_aligned = {}
        for ei, hj, cost in al:
            if ei is not None: exp_aligned[ei] = (hj, cost)
        hj, cost = exp_aligned.get(ti, (None, 1))
        hw = hyp[hj] if hj is not None else None
        s = sim(exp[ti], hw) if hw is not None else 0.0
        strict = (cost == 0 and s >= 0.8)
        # lenient: target appears anywhere in the transcript
        lenient = any(sim(exp[ti], x) >= 0.8 for x in hyp)
        out['spliced'].append({'id': item['id'], 's': item['s'], 'a': item['a'], 'kind': item['kind'],
                               'target': item['target'], 'donor': item.get('donor'),
                               'target_index': ti, 'heard_at': hw, 'sim': round(s, 2),
                               'strict_caught': not strict, 'lenient_caught': not lenient,
                               'infer_s': round(dt, 2), 'text': text, 'expected': item['expected']})
        out['latency'].append(dt)
        print(f'[spliced {idx+1}/{len(spliced)}] {item["kind"]} {item["s"]}:{item["a"]} {dt:.2f}s target={item["target"]} heard={hw} sim={s:.2f}', flush=True)
        json.dump(out, open(os.path.join(RES, 'whisper_results.json'), 'w'), ensure_ascii=False)
    n = len(out['correct'])
    fw = sum(len(x['false_words']) for x in out['correct'])
    ew = sum(len(words(x['expected'])) for x in out['correct'])
    sc = sum(1 for x in out['spliced'] if x['strict_caught'])
    lc = sum(1 for x in out['spliced'] if x['lenient_caught'])
    ns = len(out['spliced'])
    summary = {
        'model': 'openai/whisper-small (CTranslate2 int8) via @skillninja npm package',
        'correct_clips': n, 'expected_words': ew, 'false_words': fw,
        'false_mistake_word_pct': round(100 * fw / ew, 2),
        'spliced_clips': ns, 'strict_caught': sc, 'strict_caught_pct': round(100 * sc / ns, 2),
        'lenient_caught': lc, 'lenient_caught_pct': round(100 * lc / ns, 2),
        'latency_s_median': round(statistics.median(out['latency']), 2),
        'latency_s_p90': round(sorted(out['latency'])[int(0.9 * len(out['latency']))], 2),
        'latency_s_max': round(max(out['latency']), 2),
        'total_infer_s': round(sum(out['latency']), 1),
        'wall_s': round(time.time() - t0, 1),
    }
    json.dump(summary, open(os.path.join(RES, 'whisper_summary.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()
