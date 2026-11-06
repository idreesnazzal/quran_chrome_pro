"""Collect, clean and validate the gharib books per ayah.
out: books.json  {"s:a": [[book, term, meaning], ...]}   (validated, relocated)
     ctx.json    {"s:a": {"t": diacritized ayah, "y": muyassar}}
     prep_report.txt"""
import json, gzip, re, sys, html, collections
sys.stdout.reconfigure(encoding="utf-8")
HERE = __file__.rsplit("\\", 1)[0] if "\\" in __file__ else "."

DIAC = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ﻿]")
def norm(s):
    s = DIAC.sub("", s)
    for a, b in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ٱ", "ا"), ("ى", "ي"), ("ة", "ه"), ("ؤ", "و"), ("ئ", "ي"), ("ء", "")):
        s = s.replace(a, b)
    return re.sub("[^ء-ي ]", " ", s)
def skel(s):
    return re.sub("[اوي ]", "", norm(s))

def clean(t):
    t = html.unescape(re.sub(r"<[^>]+>", "", t or ""))
    t = re.sub(r"\[زه\]|\(\d+\)|\[\d+\]", "", t)
    t = t.replace("‏", "").replace("‎", "")
    return re.sub(r"\s+", " ", t).strip(" .:،")

# ---- ayah texts
m1 = json.load(gzip.open(f"{HERE}/m1.json.gz", "rt", encoding="utf-8"))["data"]
TXT = {}
for su in m1["surahs"]:
    for a in su["ayahs"]:
        TXT[(su["id"], a["number"])] = a["text"].replace("﻿", "").strip()
assert len(TXT) == 6236, len(TXT)
SK = {k: skel(v) for k, v in TXT.items()}
VERSES = collections.Counter(s for s, a in TXT)

yz = json.load(gzip.open(f"{HERE}/tb2012.json.gz", "rt", encoding="utf-8"))["ayahs"]
MUY = {(r["surah"], r["ayah"]): clean(" ".join(c["text"] for c in r["content"])) for r in yz}

# ---- raw entries: (s, a, book, term, meaning)
raw = []
BOOK = {491: "S", 1424: "K", 208: "J", 327: "H"}
for r in json.load(gzip.open(f"{HERE}/meanings.json.gz", "rt", encoding="utf-8"))["data"]:
    for m in r["meanings"]:
        b = BOOK[m["book_info"]["id"]]
        for w in m["words"]:
            raw.append((r["surah"], r["ayah"], b, clean(w["text"]), clean(w["meaning"])))
nz = json.load(gzip.open(f"{HERE}/tb27760.json.gz", "rt", encoding="utf-8"))["ayahs"]
SPAN = re.compile(r'<span class="book-ayah[^"]*">\s*﴿([^﴾]*)﴾\s*</span>\s*:?')
for r in nz:
    for c in r["content"]:
        parts = SPAN.split(c["text"])
        # parts = [pre, term1, def1, term2, def2, ...]
        for i in range(1, len(parts) - 1, 2):
            raw.append((r["surah"], r["ayah"], "N", clean(parts[i]), clean(parts[i + 1])))

PFX = ("وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ل", "ك", "س")
def forms(tok):
    f = {tok}
    for p in PFX:
        if tok.startswith(p) and len(tok) - len(p) >= 2: f.add(tok[len(p):])
    return f
AT = {k: set(x for t in norm(v).split() for x in forms(t)) for k, v in TXT.items()}
def tok_ok(t, key):
    if not set(forms(t)) & AT[key] and not (forms(t) & {x for x in AT[key]}):
        sk = re.sub("[اوي]", "", t)
        return len(sk) >= 3 and sk in SK[key]
    return True
def score(term, key):
    toks = [t for t in norm(term).split() if len(t) >= 2 and t not in ("او", "اي", "ان", "من", "في", "ما", "لا", "الي", "علي", "عن")]
    if not toks: return 0.0
    return sum(1 for t in toks if tok_ok(t, key)) / len(toks)

out = collections.defaultdict(list); stat = collections.Counter(); moved = []
for s, a, b, term, mean in raw:
    if not term or not mean or (s, a) not in TXT:
        stat["empty"] += 1; continue
    if term == mean or (len(term) > 14 and mean.startswith(term[:10])) or len(norm(term).split()) > 7:
        stat["badsplit"] += 1; continue
    if score(term, (s, a)) >= 0.6:
        out[(s, a)].append([b, term, mean]); stat["ok"] += 1; continue
    cands = [(s + ds, a + da) for ds in (0, -1, 1, -2, 2) for da in range(-6, 7) if (s + ds, a + da) in TXT and (ds, da) != (0, 0) and (ds == 0 or da == 0)]
    sc = sorted(((score(term, c), -abs(c[0] - s) * 10 - abs(c[1] - a), c) for c in cands), reverse=True)
    meaty = len(norm(term).replace(" ", "")) >= 4
    sc = [x for x in sc if x[2][0] == s or len(norm(term).replace(" ", "")) >= 5]
    best = sc[0] if sc and meaty else (0, 0, None)
    if best[0] >= 0.8 and (best[2][0] == s or len(sc) < 2 or sc[1][0] < best[0] or abs(best[2][1] - a) <= 1):
        out[best[2]].append([b, term, mean]); stat["moved"] += 1; moved.append(f"{b} {s}:{a}->{best[2][0]}:{best[2][1]} {term}")
    else:
        stat["dropped"] += 1; moved.append(f"DROP {b} {s}:{a} {term} :: {mean[:60]}")

# de-duplicate identical (book, term) within an ayah
for k in out:
    seen = set(); keep = []
    for e in out[k]:
        if (e[0], norm(e[1]).strip()) in seen: continue
        seen.add((e[0], norm(e[1]).strip())); keep.append(e)
    out[k] = keep

json.dump({f"{s}:{a}": v for (s, a), v in sorted(out.items())}, open(f"{HERE}/books.json", "w", encoding="utf-8"), ensure_ascii=False)
json.dump({f"{s}:{a}": {"t": TXT[(s, a)], "y": MUY.get((s, a), "")} for (s, a) in sorted(TXT)}, open(f"{HERE}/ctx.json", "w", encoding="utf-8"), ensure_ascii=False)
per = collections.Counter(e[0] for v in out.values() for e in v)
with open(f"{HERE}/prep_report.txt", "w", encoding="utf-8") as f:
    f.write(json.dumps(stat) + "\n" + json.dumps(per) + "\n" + "\n".join(moved))
print(stat, per, "ayahs with any book:", len(out))
