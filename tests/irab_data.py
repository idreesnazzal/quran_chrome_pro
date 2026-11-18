"""إعراب الآية — the data, checked without a browser:
  1. data/irab/*.js are exactly what tools/irab/build.py makes from the pinned source (sha256) — nothing hand-edited
  2. every ayah of the app's numbering (6236, the basmala of الفاتحة = 1:1) opens one passage; no ayah twice, no gap
  3. no empty passage; only the markup the app renders; a passage that only refers back has a pointer that lands
  4. every ayah marker sits inside its passage, in order; every «سبق إعرابها» link points to an earlier ayah
usage: python -I tests/irab_data.py"""
import json, os, re, sys
sys.stdout.reconfigure(encoding="utf-8")
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(APP, "tools", "irab"))
import build as B

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond: fails.append(name)

sur, problems, st = B.build()
check("the build finds no problem in the source", not problems, problems[:5])
disk = {}
for s in range(1, 115):
    js = open(os.path.join(APP, "data", "irab", f"{s:03d}.js"), encoding="utf-8").read()
    m = re.fullmatch(r"__irabPut\((\d+),(.*)\);\n", js, flags=re.S)
    disk[s] = json.loads(m.group(2)) if m and int(m.group(1)) == s else None
check("1. the 114 files on disk = a fresh build from the pinned source", all(disk[s] == sur.get(s) for s in range(1, 115)),
      [s for s in range(1, 115) if disk[s] != sur.get(s)][:5])

qd = open(os.path.join(APP, "data", "quran_data.js"), encoding="utf-8").read()
meta = json.loads(qd[qd.index("{"): qd.rindex("}") + 1])
keys = [(r[0], r[1]) for r in meta["ayahs"]]
hits = {}
for s, P in disk.items():
    for p in P or []:
        for a in range(p[0], p[1] + 1): hits.setdefault((s, a), []).append(p)
check("2. the app has 6236 ayat and 1:1 is the basmala", len(keys) == 6236 and "بسم الله" in meta["ayahs"][0][4])
check("2. every ayah opens exactly one passage", all(len(hits.get(k, [])) == 1 for k in keys),
      [k for k in keys if len(hits.get(k, [])) != 1][:8])
check("2. no passage for an ayah the app does not have", set(hits) <= set(keys), sorted(set(hits) - set(keys))[:5])

allp = [(s, p) for s, P in disk.items() for p in P or []]
bad_tags = [(s, p[0], t) for s, p in allp for t in re.findall(r"<[^>]+>", p[2])
            if not re.fullmatch(r'<br>|</?strong>|<small class="ir-fn">|</small>|<i data-a="\d+"></i>|<i data-a="\d+">|</i>|<u data-r="\d+:\d+">|</u>', t)]
check("3. only the markup the app renders", not bad_tags, bad_tags[:5])
words = lambda h: len(B.norm(re.sub(r"<[^>]+>", " ", h)).split())
empty = [(s, p[0]) for s, p in allp if words(p[2]) < 2]
check("3. no empty passage", not empty, empty)
thin = [(s, p[0], p[2][:40]) for s, p in allp if len(p) < 4 and B.REFWORDS.search(p[2]) and words(p[2]) < 8]
check("3. every passage that only refers back carries a pointer", not thin, thin[:5])
ptr = [(s, p[0], r) for s, p in allp if len(p) > 3 for r in p[3]
       if not all((r[0], k) in hits for k in range(r[1], r[2] + 1)) or (r[0], r[1]) >= (s, p[0])]
check(f"3. all {sum(1 for s, p in allp if len(p) > 3)} pointers land on earlier ayat that exist", not ptr, ptr[:5])

badm = []
for s, p in allp:
    ks = [int(k) for k in re.findall(r'<i data-a="(\d+)"></i>', p[2])]
    if ks != sorted(set(ks)) or any(not (p[0] < k <= p[1]) for k in ks): badm.append((s, p[0], ks))
check("4. ayah markers in order, inside their passage", not badm, badm[:5])
links = [(s, p, int(m.group(1)), int(m.group(2))) for s, p in allp for m in re.finditer(r'<u data-r="(\d+):(\d+)">', p[2])]
badl = [(s, p[0], t, a) for s, p, t, a in links if (t, a) not in hits or (t, a) >= (s, p[1])]
check(f"4. all {len(links)} «سبق إعرابها» links point to an earlier ayah", not badl, badl[:5])
print(st)
print("FAILS:", fails)
sys.exit(1 if fails else 0)
