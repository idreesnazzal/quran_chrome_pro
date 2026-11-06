#!/usr/bin/env python3
"""Post-hoc 'score the expected word' analysis of the Whisper transcripts.

For each expected word we take the best similarity to a transcript word in a
window around its aligned position. Sweeping the threshold shows the trade-off
between false mistakes on correct recitation and caught mistakes on spliced
clips. This is still a transcription-based scorer, not CTC log-probs.
"""
import json, os, re, statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'results')
D = json.load(open(os.path.join(RES, 'whisper_results.json')))

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

def clean(t):
    t = re.sub(r'[0-9\u0660-\u0669]+', ' ', t)
    t = re.sub(r'[^\u0621-\u064a\s]', ' ', t)
    return [w for w in re.split(r'\s+', t.strip()) if w]

def align(exp, hyp):
    n, m = len(exp), len(hyp)
    dp = [[0]*(m+1) for _ in range(n+1)]
    for i in range(1, n+1): dp[i][0] = i
    for j in range(1, m+1): dp[0][j] = j
    for i in range(1, n+1):
        for j in range(1, m+1):
            c = 0 if norm(exp[i-1]) == norm(hyp[j-1]) else 1
            dp[i][j] = min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+c)
    i, j = n, m; out = []
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            c = 0 if norm(exp[i-1]) == norm(hyp[j-1]) else 1
            if dp[i][j] == dp[i-1][j-1]+c:
                out.append((i-1, j-1)); i -= 1; j -= 1; continue
        if i > 0 and dp[i][j] == dp[i-1][j]+1:
            out.append((i-1, None)); i -= 1; continue
        out.append((None, j-1)); j -= 1
    return list(reversed(out))

def sim(a, b):
    a, b = norm(a), norm(b)
    if not a and not b: return 1.0
    m, n = len(a), len(b)
    dp = list(range(n+1))
    for i in range(1, m+1):
        prev = dp[0]; dp[0] = i
        for j in range(1, n+1):
            cur = dp[j]
            dp[j] = min(dp[j]+1, dp[j-1]+1, prev+(a[i-1] != b[j-1]))
            prev = cur
    return 1.0 - dp[n]/max(m, n, 1)

def best_sims(exp, hyp, al, window):
    pos = {}
    for ei, hj in al:
        if ei is not None: pos[ei] = hj
    out = []
    for ei, w in enumerate(exp):
        hj = pos.get(ei)
        if hj is None:
            out.append(0.0); continue
        lo = max(0, hj-window); hi = min(len(hyp), hj+window+1)
        out.append(max(sim(w, hyp[j]) for j in range(lo, hi)))
    return out

correct = []
for x in D['correct']:
    exp = words(x['expected']); hyp = clean(x['text'])
    al = align(exp, hyp)
    correct.append((exp, hyp, best_sims(exp, hyp, al, 2)))
spliced = []
for x in D['spliced']:
    exp = words(x['expected']); hyp = clean(x['text'])
    al = align(exp, hyp)
    sims = best_sims(exp, hyp, al, 2)
    spliced.append((x['target_index'], sims, x['kind'], x['target'], x['donor'], x['heard_at']))

print('threshold window false_mistake_pct strict_caught_pct lenient_caught_pct')
for window in [0, 1, 2, 3]:
    for th in [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9]:
        fw = 0; ew = 0
        for exp, hyp, sims in correct:
            ew += len(exp)
            fw += sum(1 for s in sims if s < th)
        sc = 0; lc = 0
        for ti, sims, kind, target, donor, heard in spliced:
            s = sims[ti] if ti < len(sims) else 0.0
            if s < th: sc += 1
            if s < th or not any(sim(target, h) >= th for h in clean(' '.join([]))): pass
        # lenient: target not found anywhere in the transcript at this threshold
        lc = 0
        for (ti, sims, kind, target, donor, heard), (exp, hyp, _) in zip(spliced, [ (words(x['expected']), clean(x['text']), None) for x in D['spliced']]):
            found = any(sim(target, h) >= th for h in hyp)
            if not found: lc += 1
        print(f'{th:.2f} {window} {100*fw/ew:.2f} {100*sc/len(spliced):.2f} {100*lc/len(spliced):.2f}')
