#!/usr/bin/env python3
"""Phase-1 eval set (b): curated near-sounding substitutions + skips.

Audio: QuranHub Hafs Husary (Unlicense mirror).
Timings: spa5k/quran_timings_api word segments (quran.com / EveryAyah).
Substitutions use real words from the same reciter, chosen from the pairs the
task names (الارض/العرب, كلا/كل, ...) plus other phonetic near pairs.
"""
import json, os, random, re, subprocess, wave
import numpy as np
import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache')
AUDIO = os.path.join(CACHE, 'audio')
WAV = os.path.join(AUDIO, 'husary_wav')
OUT = os.path.join(AUDIO, 'spliced')
QURAN = json.load(open(os.path.join(CACHE, 'quran_text.json')))
Q = {(x['s'], x['a']): x for x in QURAN}
FF = imageio_ffmpeg.get_ffmpeg_exe()
HUS = {}
for s in range(1, 115):
    p = os.path.join(CACHE, 'timings', 'spa5k', 'murattal', 'mishari_al_afasy', f'{s}.json')
    if os.path.exists(p):
        d = json.load(open(p))
        if d['audio_files'] and 'khalil_al_husary' in d['audio_files'][0]['audio_url']:
            HUS[s] = d['audio_files'][0]

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

def to_wav(s, a):
    os.makedirs(WAV, exist_ok=True)
    out = os.path.join(WAV, f'{s:03d}{a:03d}.wav')
    if os.path.exists(out): return out
    src = os.path.join(AUDIO, 'husary', 'verses', f'{s:03d}{a:03d}.mp3')
    if not os.path.exists(src): return None
    subprocess.run([FF, '-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out],
                   check=True, capture_output=True)
    return out

def read_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes(); sr = w.getframerate()
        x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return x, sr

def write_wav(path, x, sr=16000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    y = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(y.tobytes())

def concat_parts(parts, sr=16000, fade=0.01):
    out = []
    for i, p in enumerate(parts):
        if i > 0 and fade > 0:
            n = int(fade * sr)
            if len(out) >= n and len(p) >= n:
                t = np.linspace(0, 1, n, dtype=np.float32)
                out[-n:] = out[-n:] * (1 - t) + p[:n] * t
                p = p[n:]
        out.append(p)
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)

WT = {}
def word_times(s, a):
    if (s, a) in WT: return WT[(s, a)]
    if s not in HUS: return None
    v = next((v for v in HUS[s]['verse_timings'] if v['verse_key'] == f'{s}:{a}'), None)
    if not v: return None
    wav = to_wav(s, a)
    if not wav: return None
    x, sr = read_wav(wav)
    d = len(x) / sr
    t0 = v['timestamp_from'] / 1000.0; t1 = v['timestamp_to'] / 1000.0
    if t1 <= t0: return None
    scale = d / (t1 - t0)
    out = []
    for seg in v['segments']:
        if not isinstance(seg, list) or len(seg) < 3: continue
        idx, st, en = seg[0], seg[1], seg[2]
        out.append((idx, (st / 1000.0 - t0) * scale, (en / 1000.0 - t0) * scale))
    WT[(s, a)] = (out, wav, d)
    return out, wav, d

def word_audio(s, a, i):
    wt = word_times(s, a)
    if not wt: return None
    times, wav, d = wt
    for idx, st, en in times:
        if idx == i + 1:
            x, sr = read_wav(wav)
            st = max(0, st - 0.02); en = min(d, en + 0.02)
            if en <= st: return None
            return x[int(st * sr):int(en * sr)], sr, x, d, times
    return None

def find_occurrences(word):
    nw = norm(word)
    out = []
    for (s, a), q in Q.items():
        for i, w in enumerate(words(q['text'])):
            if norm(w) == nw:
                out.append((s, a, i))
    return out

PAIRS = [
    ('كلا', 'كل'), ('يعلمون', 'تعلمون'), ('الرحمن', 'الرحيم'), ('الرحيم', 'الرحمن'),
    ('نور', 'نار'), ('مالك', 'ملك'), ('قال', 'كان'), ('في', 'من'), ('من', 'في'),
    ('على', 'الى'), ('الاولى', 'الاخرى'), ('خير', 'خسر'), ('مهادا', 'مهاد'),
    ('الارض', 'الاعراب'), ('السموات', 'الارض'), ('الذين', 'الدين'),
]

def main():
    random.seed(1)
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    used_targets = set()
    made = 0
    # 3 clips per pair where possible, then fill with skips
    for target, donor in PAIRS:
        occ = find_occurrences(target)
        random.shuffle(occ)
        made_p = 0
        for (s, a, i) in occ:
            if made_p >= 3 or made >= 30: break
            if (s, a, i) in used_targets: continue
            q = Q.get((s, a))
            if not q: continue
            w = words(q['text'])
            if i <= 0 or i >= len(w) - 1: continue
            wt = word_times(s, a)
            if not wt: continue
            times, wav, d = wt
            if not (5.0 <= d <= 25.0): continue
            if len(times) != len(w) and len(times) != len(w) + 1: continue
            got = word_audio(s, a, i)
            if got is None: continue
            ta, sr, x, ad, ttimes = got
            st = max(0, ttimes[i][1] - 0.02); en = min(ad, ttimes[i][2] + 0.02)
            before = x[:int(st * sr)]; after = x[int(en * sr):]
            # find a donor occurrence with audio
            donor_occ = find_occurrences(donor)
            random.shuffle(donor_occ)
            donor_got = None
            for (ds, da, di) in donor_occ:
                if (ds, da, di) == (s, a, i): continue
                dg = word_audio(ds, da, di)
                if dg is None: continue
                donor_got = (ds, da, di, dg[0])
                break
            if donor_got is None: continue
            ds, da, di, daudio = donor_got
            y = concat_parts([before, daudio, after], sr=sr, fade=0.01)
            out = os.path.join(OUT, f'{made:03d}_{s:03d}{a:03d}_sub.wav')
            write_wav(out, y, sr)
            manifest.append({'id': made, 's': s, 'a': a, 'kind': 'sub', 'target_index': i,
                             'target': target, 'donor': donor, 'donor_ayah': [ds, da],
                             'expected': q['text'], 'words': w, 'audio': os.path.relpath(out, ROOT),
                             'duration_s': round(len(y) / sr, 3)})
            used_targets.add((s, a, i))
            made += 1; made_p += 1
        print(target, '->', donor, 'made', made_p)
    # fill with skips from random 5-25s ayahs
    cand = []
    for s in HUS:
        for a in range(1, 115):
            q = Q.get((s, a))
            if not q: continue
            w = words(q['text'])
            if len(w) < 4: continue
            v = next((v for v in HUS[s]['verse_timings'] if v['verse_key'] == f'{s}:{a}'), None)
            if not v: continue
            d = (v['timestamp_to'] - v['timestamp_from']) / 1000.0
            if 5.0 <= d <= 25.0: cand.append((s, a, d, w, q))
    random.shuffle(cand)
    for (s, a, d, w, q) in cand:
        if made >= 48: break
        wt = word_times(s, a)
        if not wt: continue
        times, wav, ad = wt
        if abs(ad - d) > 0.5: continue
        if len(times) != len(w) and len(times) != len(w) + 1: continue
        idxs = [i for i in range(1, len(w) - 1) if len(w[i]) >= 3 and i < len(times)]
        if not idxs: continue
        i = random.choice(idxs)
        got = word_audio(s, a, i)
        if got is None: continue
        ta, sr, x, ad, ttimes = got
        st = max(0, ttimes[i][1] - 0.02); en = min(ad, ttimes[i][2] + 0.02)
        y = concat_parts([x[:int(st * sr)], x[int(en * sr):]], sr=sr, fade=0.01)
        out = os.path.join(OUT, f'{made:03d}_{s:03d}{a:03d}_skip.wav')
        write_wav(out, y, sr)
        manifest.append({'id': made, 's': s, 'a': a, 'kind': 'skip', 'target_index': i,
                         'target': w[i], 'expected': q['text'], 'words': w,
                         'audio': os.path.relpath(out, ROOT), 'duration_s': round(len(y) / sr, 3)})
        made += 1
    out = os.path.join(ROOT, 'results', 'spliced_set.json')
    json.dump(manifest, open(out, 'w'), ensure_ascii=False, indent=1)
    print('wrote', out, len(manifest), 'subs', sum(1 for x in manifest if x['kind'] == 'sub'), 'skips', sum(1 for x in manifest if x['kind'] == 'skip'))

if __name__ == '__main__':
    main()
