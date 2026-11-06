"""Validate a writer's output.  usage: python -I check.py b000 [b001 ...]   ('all' = every batch)"""
import json, os, re, sys, glob
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
C = json.load(open(f"{HERE}/ctx.json", encoding="utf-8"))
IDX = {x["b"]: x for x in json.load(open(f"{HERE}/batches/index.json", encoding="utf-8"))}
KEYS = sorted(C, key=lambda k: tuple(map(int, k.split(":"))))
DIAC = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ]")

def batch_keys(b):
    x = IDX[b]; i = KEYS.index(x["first"]); return KEYS[i:i + x["n"]]

def load(b):
    rows, errs = {}, []
    files = sorted(glob.glob(f"{HERE}/out/{b}_p*.jsonl"), key=lambda f: int(re.search(r"_p(\d+)", f).group(1)))
    if not files: return rows, [f"{b}: no output files out/{b}_pN.jsonl"]
    for f in files:
        for n, line in enumerate(open(f, encoding="utf-8"), 1):
            if not line.strip(): continue
            try: r = json.loads(line)
            except Exception as e: errs.append(f"{os.path.basename(f)}:{n} bad JSON: {e}"); continue
            if r.get("k") in rows: errs.append(f"{r.get('k')}: duplicate line")
            rows[r.get("k")] = r
    return rows, errs

def check(b):
    rows, errs = load(b)
    want = batch_keys(b)
    for k in want:
        if k not in rows: errs.append(f"{k}: missing ayah"); continue
        r = rows[k]; text = C[k]["t"]; spans = []
        if not isinstance(r.get("w"), list): errs.append(f"{k}: w must be a list"); continue
        for it in r["w"]:
            t, m, s = it.get("t", ""), it.get("m", ""), it.get("s", "")
            if not t or t not in text:
                hint = ""
                bare = DIAC.sub("", t)
                if bare and bare in DIAC.sub("", text): hint = " (letters match: copy the diacritics exactly from the آية line)"
                errs.append(f"{k}: term not verbatim in ayah: «{t}»{hint}")
            else:
                p = text.find(t); spans.append((p, p + len(t), t))
            if not m or re.search(r"[A-Za-z֐-׿]", m): errs.append(f"{k}: bad meaning for «{t}»")
            if len(m.split()) > 32: errs.append(f"{k}: meaning too long ({len(m.split())} words) for «{t}»")
            if not isinstance(s, str) or set(s) - set("SKJHNY"): errs.append(f"{k}: bad s «{s}» for «{t}»")
        spans.sort()
        for (a1, e1, t1), (a2, e2, t2) in zip(spans, spans[1:]):
            if a2 < e1: errs.append(f"{k}: overlapping terms «{t1}» / «{t2}»")
    extra = set(rows) - set(want)
    if extra: errs.append(f"keys outside batch: {sorted(extra)[:5]}")
    return rows, errs

bs = sorted(IDX) if sys.argv[1:] == ["all"] else sys.argv[1:]
bad = 0
for b in bs:
    rows, errs = check(b)
    items = sum(len(r.get("w", [])) for r in rows.values())
    if errs:
        bad += 1; print(f"{b}: {len(errs)} errors"); print("\n".join("  " + e for e in errs[:80]))
    else:
        print(f"{b}: OK  {len(rows)} ayahs, {items} items")
sys.exit(1 if bad else 0)
