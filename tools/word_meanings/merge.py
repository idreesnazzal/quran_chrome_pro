"""Merge the writers' meanings (out/*.jsonl) with the validated book lines (books.json)
into the app's data/word_meanings.js:
  window.WORD_MEANINGS = {"s_a": [[term, meaning, src, [[book, term, text], ...]], ...]}
usage: python -I merge.py <app dir> [--allow-missing]"""
import json, os, re, sys, glob, collections
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
APP = sys.argv[1]; ALLOW = "--allow-missing" in sys.argv
B = json.load(open(f"{HERE}/books.json", encoding="utf-8"))
C = json.load(open(f"{HERE}/ctx.json", encoding="utf-8"))
DIAC = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ﻿]")
def norm(s):
    s = DIAC.sub("", s)
    for a, b in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ٱ", "ا"), ("ى", "ي"), ("ة", "ه"), ("ؤ", "و"), ("ئ", "ي"), ("ء", "")):
        s = s.replace(a, b)
    return re.sub("[^ء-ي ]", " ", s)
PFX = ("وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ل", "ك")
def core(tok):
    for p in PFX:
        if tok.startswith(p) and len(tok) - len(p) >= 2: return tok[len(p):]
    return tok
STOP = {"او", "اي", "ان", "من", "في", "ما", "لا", "الي", "علي", "عن", "الذي", "الذين", "هو", "هم", "قد", "لم", "الله"}
def toks(s): return {core(t) for t in norm(s).split() if len(t) >= 2 and t not in STOP}

rows = {}
for f in glob.glob(f"{HERE}/out/*.jsonl"):
    for line in open(f, encoding="utf-8"):
        if line.strip():
            r = json.loads(line); rows[r["k"]] = r
missing = [k for k in C if k not in rows]
if missing and not ALLOW: sys.exit(f"{len(missing)} ayahs not written yet, e.g. {missing[:5]}")

def cap(t, n=500): return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + " …"

W, stat = {}, collections.Counter()
for k in sorted(C, key=lambda k: tuple(map(int, k.split(":")))):
    text = C[k]["t"]; ntext = norm(text)
    r = rows.get(k, {"w": [], "x": []})
    bad = {(x.split(":", 1)[0], norm(x.split(":", 1)[1]).strip()) for x in r.get("x", []) if ":" in x}
    items = [[it["t"], it["m"].strip(), it.get("s", ""), []] for it in r["w"]]
    loose = collections.OrderedDict()
    for b, t, m in B.get(k, []):
        if (b, norm(t).strip()) in bad: stat["book_rejected"] += 1; continue
        bt = toks(t); best, bi = 0, -1
        for i, it in enumerate(items):
            ov = len(bt & toks(it[0]))
            if ov > best: best, bi = ov, i
        if bi >= 0:
            items[bi][3].append([b, t, cap(m)]); stat["book_linked"] += 1
        else:
            loose.setdefault(norm(t).strip(), [t, "", "", []])[3].append([b, t, cap(m)]); stat["book_only"] += 1
    items += list(loose.values())
    def pos(it):
        p = ntext.find(norm(it[0]).strip())
        if p < 0:
            ts = [t for t in norm(it[0]).split() if len(t) >= 2]
            p = min((ntext.find(t) for t in ts if ntext.find(t) >= 0), default=10**6)
        return p
    items.sort(key=pos)
    order = "SKJHN"
    for it in items: it[3].sort(key=lambda e: order.index(e[0]))
    if items: W[k.replace(":", "_")] = items
    stat["items"] += len(items); stat["ai_items"] += len(r["w"]); stat["own"] += sum(1 for it in r["w"] if not it.get("s"))

out = os.path.join(APP, "data", "word_meanings.js")
body = "window.WORD_MEANINGS = " + json.dumps(W, ensure_ascii=False, separators=(",", ":")) + ";\n"
open(out + ".tmp", "w", encoding="utf-8", newline="").write(body); os.replace(out + ".tmp", out)
print(dict(stat), "ayahs with meanings:", len(W), "size MB:", round(len(body.encode()) / 1e6, 2), "missing:", len(missing))
