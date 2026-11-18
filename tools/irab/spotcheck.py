"""Spot-check the imported iʿrāb against a second, independent digitisation of the same book (QUL resource 515,
qul.tarteel.ai — إعراب القرآن للدعاس). For each sampled ayah: how much of our passage's wording appears, in order, in
QUL's text for that ayah (words, diacritics ignored). Short / long / grouped / pointer / start and end of the Quran.
usage: python -I tools/irab/spotcheck.py [n_random=30]   (needs the network; reads data/irab/*.js)"""
import difflib, json, os, random, re, sys, time, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from build import norm

def ours(s, a):
    js = open(os.path.join(APP, "data", "irab", f"{s:03d}.js"), encoding="utf-8").read()
    P = json.loads(js[js.index(",") + 1: js.rindex(")")])
    p = next(p for p in P if p[0] <= a <= p[1])
    return p, norm(re.sub(r"<[^>]+>", " ", p[2])).split()

def qul(s, a):
    req = urllib.request.Request(f"https://qul.tarteel.ai/resources/tafsir/515?ayah={s}:{a}", headers={"User-Agent": "Mozilla/5.0"})
    h = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
    m = re.search(r'<div class="tafsir arabic">(.*?)</div>\s*</div>', h, flags=re.S)
    return norm(re.sub(r"<[^>]+>", " ", m.group(1) if m else "")).split()

FIXED = [(1, 1), (1, 6), (2, 1), (2, 3), (2, 255), (2, 282), (3, 7), (4, 11), (9, 60), (12, 4), (18, 109), (24, 35),
         (36, 1), (55, 16), (55, 74), (56, 63), (73, 3), (78, 1), (82, 3), (103, 2), (108, 1), (112, 1), (112, 4), (114, 6)]
if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    meta = open(os.path.join(APP, "data", "quran_data.js"), encoding="utf-8").read()
    S = json.loads(meta[meta.index("{"): meta.rindex("}") + 1])["surahs"]
    random.seed(20261118)
    sample = FIXED + [(s, random.randint(1, S[s - 1]["verses"])) for s in random.sample(range(1, 115), n)]
    low = []
    for s, a in sample:
        p, w = ours(s, a)
        try: q = qul(s, a)
        except Exception as e: print(f"{s}:{a}  QUL fetch failed: {e}"); continue
        sm = difflib.SequenceMatcher(None, w, q, autojunk=False)
        found = sum(b.size for b in sm.get_matching_blocks()) / max(1, len(w))
        tag = f"{p[0]}-{p[1]}" + (" →" + str(p[3]) if len(p) > 3 else "")
        print(f"{s}:{a:<4} passage {tag:<18} ours {len(w):>4} words  QUL {len(q):>4}  ours found in QUL: {found:6.1%}")
        if found < 0.9: low.append((s, a, found))
        time.sleep(0.4)
    print("\nbelow 90%:", low or "none")
