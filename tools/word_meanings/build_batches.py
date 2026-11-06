"""Split all ayahs into batch input files for the meaning writers.
in : books.json, ctx.json   out: batches/bNN.txt + batches/index.json"""
import json, os, sys
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(f"{HERE}/books.json", encoding="utf-8"))
C = json.load(open(f"{HERE}/ctx.json", encoding="utf-8"))
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 90000   # chars per batch
os.makedirs(f"{HERE}/batches", exist_ok=True)

def rec(k):
    c = C[k]; out = [f"## {k}", f"آية: {c['t']}", f"ميسر: {c['y']}"]
    for b, t, m in B.get(k, []):
        out.append(f"{b}| {t}: {m[:240]}")
    return "\n".join(out) + "\n"

keys = sorted(C, key=lambda k: tuple(map(int, k.split(":"))))
batches, cur, size = [], [], 0
for k in keys:
    r = rec(k)
    if cur and size + len(r) > LIMIT:
        batches.append(cur); cur, size = [], 0
    cur.append((k, r)); size += len(r)
batches.append(cur)
index = []
for i, b in enumerate(batches):
    open(f"{HERE}/batches/b{i:03d}.txt", "w", encoding="utf-8").write("".join(r for k, r in b))
    index.append({"b": f"b{i:03d}", "first": b[0][0], "last": b[-1][0], "n": len(b), "chars": sum(len(r) for k, r in b)})
json.dump(index, open(f"{HERE}/batches/index.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(len(batches), "batches;", sum(x["chars"] for x in index), "chars")
for x in index[:3] + index[-3:]: print(x)
