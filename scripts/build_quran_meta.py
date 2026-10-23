"""Build data/quran_meta.js (hizb quarters, sajdas) from Tanzil's metadata.

Source: https://tanzil.net/res/text/metadata/quran-data.js
        (C) Tanzil.info, Creative Commons Attribution 3.0.
Pages come from OUR data (data/quran_data.js: the ayah -> page of this
mushaf's images), and Tanzil's own page table is used only as a cross-check.

usage: python scripts/build_quran_meta.py path/to/tanzil/quran-data.js
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(sys.argv[1], encoding="utf-8").read()


def block(name):
    m = re.search(r"QuranData\." + name + r" = \[(.*?)\n\];", src, re.S)
    rows = [list(map(lambda v: v.strip().strip("'\""), x.split(",")))
            for x in re.findall(r"\[([^\[\]]+)\]", m.group(1))]
    # skip the commented header rows ([sura, aya]) and the end sentinel [115, 1]
    return [r for r in rows if r and r[0].isdigit() and int(r[0]) <= 114]


raw = open(os.path.join(ROOT, "data", "quran_data.js"), encoding="utf-8").read()
data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
page_of = {(r[0], r[1]): r[2] for r in data["ayahs"]}

quarters = [[int(s), int(a)] for s, a in block("HizbQaurter")]
assert len(quarters) == 240, len(quarters)
sajdas = [[int(s), int(a), t] for s, a, t in block("Sajda")]
assert len(sajdas) == 15, len(sajdas)

# cross-check: Tanzil's page starts against our ayah -> page
tpages = [[int(s), int(a)] for s, a in block("Page")]
bad = [(i + 1, s, a, page_of.get((s, a))) for i, (s, a) in enumerate(tpages[:604]) if page_of.get((s, a)) != i + 1]
print("Tanzil page starts that disagree with our pages:", len(bad), bad[:5])

meta = {
    "source": "Tanzil.info quran-data.js (CC BY 3.0); pages from this mushaf's data",
    # i = 0..239 -> hizb i//4 + 1, quarter i%4 (0 = start of the hizb, 1 = ¼, 2 = ½, 3 = ¾)
    "quarters": [[s, a, page_of[(s, a)]] for s, a in quarters],
    "sajdas": [[s, a, page_of[(s, a)], t] for s, a, t in sajdas],
}
out = os.path.join(ROOT, "data", "quran_meta.js")
txt = "/* Hizb quarters and sajdas — built by scripts/build_quran_meta.py from Tanzil.info (CC BY 3.0). */\n" \
      "window.QURAN_META = " + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + ";\n"
open(out + ".tmp", "w", encoding="utf-8", newline="\n").write(txt)
os.replace(out + ".tmp", out)
print("wrote", out, len(txt), "bytes;", len(meta["quarters"]), "quarters,", len(meta["sajdas"]), "sajdas")
