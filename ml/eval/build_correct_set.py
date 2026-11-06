#!/usr/bin/env python3
"""Phase-1 eval set (a): correct recitation from three less-known reciters.

Audio: EveryAyah Hafs collections mirrored in iptvchecker/content-everyayah
(public-domain mirror; the original recordings remain the reciters' property).
Timings: Abdalla-Eldoumani/maqra timings (ayah boundary offsets).
We keep only ayahs whose MP3 duration matches the timing duration within 0.5 s,
so the expected text and the audio are the same recitation.
"""
import json, os, random, subprocess, sys, urllib.request, time
import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # ml/
CACHE = os.path.join(ROOT, '.cache')
AUDIO = os.path.join(CACHE, 'audio')
QURAN = json.load(open(os.path.join(CACHE, 'quran_text.json')))
Q = {(x['s'], x['a']): x for x in QURAN}
FF = imageio_ffmpeg.get_ffmpeg_exe()
API = 'https://api.github.com/repos/iptvchecker/content-everyayah/contents/data'
RECITERS = [
    ('hudhaify', 'Hudhaify_128kbps', 'hudhaify-128kbps-timings.json', 'hudhaify'),
    ('ajamy', 'ahmed_ibn_ali_al_ajamy_128kbps', 'ahmed-ibn-ali-al-ajamy-128kbps.json', 'ajamy'),
    ('basit', 'Abdul_Basit_Murattal_192kbps', 'abdul-basit-murattal-timings.json', 'basit'),
]

def strip_diacritics(s):
    import re
    s = re.sub(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]', '', s)
    s = s.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ى', 'ي').replace('ة', 'ه')
    return s

def words(text):
    import re
    t = re.sub(r'\s*\(\d+\)\s*$', '', text)
    return [w for w in re.split(r'\s+', t.strip()) if w]

def dur(path):
    out = subprocess.run([FF, '-i', path], capture_output=True, text=True).stderr
    import re
    m = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', out)
    if not m: return None
    h, mi, se = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(se)

def fetch(collection, s, a, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return dest
    name = f'{s:03d}{a:03d}.mp3'
    url = f'{API}/{collection}/{name}'
    req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github.raw', 'User-Agent': 'phase1-eval'})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    if len(data) < 1000:
        raise RuntimeError(f'short file {url} {len(data)}')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest, 'wb').write(data)
    return dest

def eligible(timings):
    out = []
    for s, x in timings['surahs'].items():
        if x.get('parts'):
            continue
        n = x['ayahs']
        seg = x['segments']
        if len(seg) != n + 1:
            continue
        for i in range(n):
            d = (seg[i + 1] - seg[i]) / 1000.0
            if 5.0 <= d <= 25.0:
                out.append((int(s), i + 1, d))
    return out

def main():
    random.seed(1)
    manifest = []
    for key, collection, tfile, short in RECITERS:
        timings = json.load(open(os.path.join(CACHE, 'timings', tfile)))
        cand = eligible(timings)
        # prefer a spread over surahs; shuffle then take 20
        random.shuffle(cand)
        picked = []
        used = set()
        for s, a, d in cand:
            if (s, a) in used: continue
            q = Q.get((s, a))
            if not q: continue
            w = words(q['text'])
            if len(w) < 4: continue
            if short == 'hudhaify':
                path = os.path.join(AUDIO, 'hudhaify', 'data', collection, f'{s:03d}{a:03d}.mp3')
                if not os.path.exists(path): continue
            else:
                path = os.path.join(AUDIO, 'iptvchecker', collection, f'{s:03d}{a:03d}.mp3')
                try:
                    fetch(collection, s, a, path)
                except Exception as e:
                    print('fetch failed', s, a, e, file=sys.stderr)
                    continue
            try:
                ad = dur(path)
            except Exception:
                continue
            if ad is None or abs(ad - d) > 0.5:
                print('duration mismatch', short, s, a, ad, d, file=sys.stderr)
                continue
            used.add((s, a))
            picked.append({'reciter': short, 's': s, 'a': a, 'audio': os.path.relpath(path, ROOT),
                           'timing_s': round(d, 3), 'audio_s': round(ad, 3), 'text': q['text'], 'words': w})
            if len(picked) >= 20: break
        print(short, 'picked', len(picked), 'of', len(cand), 'candidates')
        manifest.extend(picked)
    out = os.path.join(ROOT, 'results', 'correct_set.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(manifest, open(out, 'w'), ensure_ascii=False, indent=1)
    print('wrote', out, len(manifest))

if __name__ == '__main__':
    main()
