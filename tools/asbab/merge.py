"""Merge summaries into data/asbab_data.js atomically (tmp + replace), and bump VERSION in sw.js.
Usage: python -I merge.py
"""
import json, os, re, sys
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

asbab_path = os.path.join(ROOT, "data", "asbab_data.js")
sw_path = os.path.join(ROOT, "sw.js")

# Load original asbab
txt = open(asbab_path, encoding="utf-8").read()
prefix = "window.ASBAB_DATA = "
assert txt.startswith(prefix), "unexpected asbab_data.js format"
j = json.loads(txt[len(prefix):].strip().rstrip(";"))

# Load summaries
import glob
SUMDIR = os.path.join(HERE, "summaries")
rows = {}
for f in glob.glob(os.path.join(SUMDIR, "*.jsonl")):
    for line in open(f, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        rows[r["k"].replace(":", "_")] = r["s"]

print(f"Loaded {len(rows)} summaries, {len(j)} asbab entries")

# For each key, prepend summary as a styled block at top of HTML
# We keep original HTML intact after summary
updated = 0
for k, v in list(j.items()):
    s = rows.get(k)
    if not s:
        continue
    # Avoid double-insertion: if already has asbab-summary, replace it
    if 'asbab-summary' in v:
        # replace existing summary block
        v = re.sub(r'<div class="asbab-summary".*?</div>', '', v, flags=re.DOTALL)
    summary_html = (
        f'<div class="asbab-summary" style="background:linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 100%);'
        f'border:1px solid #a7f3d0;border-right:4px solid #10b981;border-radius:10px;'
        f'padding:12px 14px;margin:10px 0 14px 0;font-size:15px;line-height:1.7;color:#064e3b;">'
        f'<div style="font-weight:700;margin-bottom:4px;color:#065f46;">💡 خلاصة سبب النزول</div>'
        f'<div>{s}</div></div>'
    )
    j[k] = summary_html + v
    updated += 1

print(f"Updated {updated} entries with summaries")

# Write atomically
new_body = prefix + json.dumps(j, ensure_ascii=False, separators=(",", ":")) + ";\n"
tmp_path = asbab_path + ".tmp"
open(tmp_path, "w", encoding="utf-8", newline="").write(new_body)
os.replace(tmp_path, asbab_path)
print(f"Wrote {asbab_path} ({len(new_body.encode('utf-8'))/1e6:.2f} MB)")

# Bump VERSION in sw.js
sw = open(sw_path, encoding="utf-8").read()
m = re.search(r"const VERSION = '([^']+)'", sw)
if m:
    old = m.group(1)
    # bump v7 -> v8, or vN -> v(N+1), or mushaf-v7 -> mushaf-v8
    def bump(v):
        # find trailing number
        mm = re.search(r"(\d+)(?!.*\d)", v)
        if mm:
            n = int(mm.group(1))
            return v[:mm.start(1)] + str(n+1) + v[mm.end(1):]
        else:
            return v + "-v2"
    new = bump(old)
    sw = sw.replace(f"const VERSION = '{old}'", f"const VERSION = '{new}'", 1)
    open(sw_path, "w", encoding="utf-8").write(sw)
    print(f"Bumped sw.js VERSION: {old} -> {new}")
else:
    print("No VERSION found in sw.js")

print("Merge done")
