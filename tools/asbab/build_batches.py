"""Export ayahs into batches, each with the ayah text plus its book texts.
in : data/asbab_data.js, data/quran_data.js   out: tools/asbab/batches/*.txt + index.json
"""
import json, os, re, sys
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

# Load asbab_data
asbab_path = os.path.join(ROOT, "data", "asbab_data.js")
txt = open(asbab_path, encoding="utf-8").read()
j = json.loads(txt[len("window.ASBAB_DATA = "):].strip().rstrip(";"))

# Load quran_data for ayah texts
qtxt = open(os.path.join(ROOT, "data", "quran_data.js"), encoding="utf-8").read()
qj = json.loads(qtxt[len("window.QURAN_DATA = "):].strip().rstrip(";"))
ayah_map = {(a[0], a[1]): a[4] for a in qj["ayahs"]}  # sura, aya -> text
# Also keep tafsir maybe?
tafsir_map = {(a[0], a[1]): a[5] for a in qj["ayahs"]}

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 90000

def clean_html(html):
    # keep paragraphs readable, preserve Arabic
    # replace tags with newline
    t = re.sub(r"<[^>]+>", "\n", html)
    t = re.sub(r"\s*\n\s*", "\n", t)
    t = re.sub(r"[ \t]+", " ", t)
    return t.strip()

def rec(k):
    # k is like "3_188"
    s, a = map(int, k.split("_"))
    ayah_text = ayah_map.get((s, a), f"الآية {s}:{a}")
    # try to get tafsir for context
    tafsir = tafsir_map.get((s, a), "")
    raw = j[k]
    cleaned = clean_html(raw)
    # split into book texts: each <p> is a report
    # We'll keep whole cleaned as book texts
    out = [f"## {s}:{a}", f"آية: {ayah_text}", f"ميسر: {tafsir[:500] if tafsir else ''}", "كتب:"]
    # Add book paragraphs as separate lines, but limit length
    paras = [p.strip() for p in re.split(r"\n+", cleaned) if p.strip()]
    for idx, p in enumerate(paras):
        # truncate long paras
        if len(p) > 1200:
            p = p[:1200] + " …"
        out.append(f"W| {p}")
    return "\n".join(out) + "\n"

keys = sorted(j.keys(), key=lambda k: tuple(map(int, k.split("_"))))
batches, cur, size = [], [], 0
for k in keys:
    r = rec(k)
    if cur and size + len(r) > LIMIT:
        batches.append(cur); cur, size = [], 0
    cur.append((k, r)); size += len(r)
batches.append(cur)

os.makedirs(os.path.join(HERE, "batches"), exist_ok=True)
index = []
for i, b in enumerate(batches):
    path = os.path.join(HERE, "batches", f"b{i:03d}.txt")
    open(path, "w", encoding="utf-8").write("".join(r for k, r in b))
    # also count chars
    total_chars = sum(len(r) for k, r in b)
    index.append({"b": f"b{i:03d}", "first": b[0][0].replace("_", ":"), "last": b[-1][0].replace("_", ":"), "n": len(b), "chars": total_chars})

open(os.path.join(HERE, "batches", "index.json"), "w", encoding="utf-8").write(json.dumps(index, ensure_ascii=False, indent=2))

print(f"{len(batches)} batches; total ayahs {len(keys)}; total chars {sum(x['chars'] for x in index)}")
for x in index:
    print(x)
