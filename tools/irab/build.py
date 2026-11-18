"""إعراب الآية — build data/irab/SSS.js (one file per surah) from إعراب القرآن الكريم (الدعاس وحميدان والقاسم,
دار المنير ودار الفارابي، دمشق 1425هـ) as digitised by Quranpedia.net (e3rab-book-316, pinned by sha256).

The book prints a heading «[سورة X (n) : آية k]» or «[… : الآيات a الى b]», then the ayat in its own (imla'i) script,
then their iʿrāb. The source's own ayah→page map is page-level (and maps سورة الإخلاص to the next page), so this
script ignores it: it joins the pages in book order and cuts at the headings. Every passage keeps the book's wording;
only the book's copy of the Quran text is dropped (the app shows its own Uthmani text). A passage on several ayat stays
whole and is reachable from each of them; inside it, a marker <i data-a="N"></i> shows where ayah N's analysis starts
(when its first word is found in order — never guessed).

usage: python -I tools/irab/build.py            (downloads the pinned file into tools/irab/raw/ if missing)
       python -I tools/irab/build.py --check    (build into memory, run the checks, write nothing)"""
import gzip, hashlib, html, json, os, re, sys, urllib.request

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))
SRC = {
    "url": "https://api.quranpedia.net/dumps/e3rab-book-316.json.gz",
    "file": os.path.join(HERE, "raw", "e3rab-book-316.json.gz"),
    "sha256": "2e8ce313524f720e7a7c389d819d1bbbcf7924f96ca6291725fbf2dc5a9fbd68",
    "dump_version": "2026-11-16",
}
OUT = os.path.join(APP, "data", "irab")
AR = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
HEAD = re.compile(r'<p class="text-center">\s*\[سورة ([^\]\(]*?)\s*\(([٠-٩]+)\)\s*:\s*(?:آية|الآيات|الآية)\s*([٠-٩]+)'
                  r'(?:\s*(?:الى|إلى)\s*([٠-٩]+))?\]\s*</p>')
BASM = re.compile(r'^\s*<p class="text-center">\s*بِسْمِ اللَّهِ الرَّحْمنِ الرَّحِيمِ\s*</p>')
REFS = {k: v for k, v in json.load(open(os.path.join(HERE, "refs.json"), encoding="utf-8")).items() if not k.startswith("_")}
REFWORDS = re.compile(r"سبق|تقدم|انظر|تشبه|مثيل|نظير|والإعراب واحد")
DIAC = re.compile("[ً-ٰٟۖ-ۭـ]")


def fetch():
    f = SRC["file"]
    if not os.path.exists(f):
        os.makedirs(os.path.dirname(f), exist_ok=True)
        req = urllib.request.Request(SRC["url"], headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, timeout=120).read()
        open(f + ".tmp", "wb").write(data); os.replace(f + ".tmp", f)
    h = hashlib.sha256(open(f, "rb").read()).hexdigest()
    if h != SRC["sha256"]:
        sys.exit(f"source file changed: sha256 {h} != pinned {SRC['sha256']} — review the new dump before re-pinning")
    return json.load(gzip.open(f, "rt", encoding="utf-8"))


def norm(s):
    s = DIAC.sub("", html.unescape(re.sub(r"<[^>]+>", "", s)))
    s = re.sub("[أإآٱ]", "ا", s).replace("ى", "ي").replace("ة", "ه").replace("ؤ", "و").replace("ئ", "ي")
    return re.sub(r"[^ء-ي ]", "", s).strip()


def boundaries(irab, ayat, a, b):
    W = [(w, k) for k in range(a, b + 1) for w in norm(ayat.get(k, "")).split()]
    def same(x, y): return x == y or min(len(x), len(y)) >= 3 and (x.startswith(y) or y.startswith(x))
    def fits(qw, j): return j + len(qw) <= len(W) and all(same(qw[t], W[j + t][0]) for t in range(len(qw)))
    i, first = 0, {}
    for q in re.finditer(r"(<strong>)?«([^»]{1,300})»", irab):
        qw = norm(q.group(2)).split()
        if not qw: continue
        if i > 0 and fits(qw, 0) and len(qw[0]) >= 2:
            i, first = 0, {}
        for j in range(i, min(len(W), i + 12)):
            if fits(qw, j):
                first.setdefault(W[j][1], q.start()); i = j + len(qw); break
    return first


INLINE = re.compile(r"(?:(?:سبق|تقدم)\s+(?:إعرابها|إعرابه|إعرابهما|إعرابهم|اعرابها|إعراب مثلها|إعراب مثيلها|إعراب نظيرها|إعراب مثله|مثلها|مثله)|انظر)"
                    r"(?P<tail>\s*(?:في|ب)?\s*(?:الآية|الآيتين|الآيات)\s*(?:رقم)?\s*[-«(]?\s*(?P<n>[٠-٩]+)\s*[»)-]?|\s*في الآية السابقة|\s*في السابقة)?")


def link_inline(sur, text, verses):
    """«… » سبق إعرابها inside a passage -> <u data-r="s:a">سبق إعرابها</u> when the place is certain: the book's number,
    «السابقة», or else the nearest earlier ayah whose text holds the quoted words (and is not itself only a pointer)."""
    pointer = {(s, k) for s, P in sur.items() for p in P if len(p) > 3 for k in range(p[0], p[1] + 1)}
    orig = {(s, k): p[2] for s, P in sur.items() for p in P for k in range(p[0], p[1] + 1)}   # before any link is added

    def defers(t, ph):   # the passage of t quotes these words and says «سبق إعرابها» too: go further back
        H = orig[t]
        for q in re.finditer(r"«([^»]{2,200})»\s*(?:</strong>)?\s*(?::|،)?\s*", H):
            if " " + norm(q.group(1)) + " " == ph and INLINE.match(H, q.end()): return True
        return False
    order = sorted(text)
    where = {k: i for i, k in enumerate(order)}
    n_ok = n_all = 0
    for s, P in sur.items():
        for p in P:
            if len(p) > 3: continue
            h, out, last = p[2], [], 0
            for m in INLINE.finditer(h):
                n_all += 1
                before = h[:m.start()]
                ks = re.findall(r'<i data-a="(\d+)"></i>', before)
                k = int(ks[-1]) if ks else p[0]
                tgt = None
                if m.group("n"):
                    t = (s, int(m.group("n").translate(AR)))
                    if t in text and t < (s, k): tgt = t
                elif m.group("tail"):
                    if (s, k - 1) in text: tgt = (s, k - 1)
                else:
                    q = re.search(r"«([^»]{2,200})»\s*(?:</strong>)?\s*(?::|،)?\s*$", before)
                    if q:
                        ph = " " + norm(q.group(1)) + " "
                        seen_here = any(" " + norm(x) + " " == ph for x in re.findall(r"«([^»]{2,200})»", before[:q.start()]))
                        if not seen_here and len(ph.strip()) >= 3:      # already analysed above in this passage: no link needed
                            i = where[(s, k)] - 1
                            while i >= 0:
                                t = order[i]
                                if ph in text[t] and t not in pointer and not defers(t, ph): tgt = t; break
                                i -= 1
                if tgt:
                    n_ok += 1
                    out.append(h[last:m.start()] + f'<u data-r="{tgt[0]}:{tgt[1]}">' + h[m.start():m.end()] + "</u>")
                    last = m.end()
            if out: p[2] = "".join(out) + h[last:]
    return f"{n_ok}/{n_all}"


def clean(t):
    """the book's markup -> the few tags the app renders (br, strong, small.ir-fn); anything else is an error"""
    t = t.replace("\r", "")
    t = re.sub(r"<br\s*/?>", "<br>", t)

    def poem(m):   # the book (mis)uses a 2-column table for running iʿrāb text: read it as one paragraph
        cells = re.findall(r"<td>(.*?)</td>", m.group(0), flags=re.S)
        out = cells[0] if cells else ""
        for c in cells[1:]:
            out += ("" if out.count("«") > out.count("»") else " ") + c
        return out
    t = re.sub(r"<table class='poem'>.*?</table>", poem, t, flags=re.S)
    t = re.sub(r'<div class="foot-notes">\s*(.*?)</div>', lambda m: '<small class="ir-fn">' + m.group(1).strip() + "</small>", t, flags=re.S)
    t = re.sub(r'<p class="text-center">\s*(.*?)\s*</p>', r"<br>\1<br>", t, flags=re.S)
    t = re.sub(r"[ \t\n]+", " ", t)
    t = re.sub(r"(\s*<br>\s*)+", "<br>", t)
    t = re.sub(r"^(<br>|\s)+|(<br>|\s)+$", "", t)
    bad = [x for x in re.findall(r"<[^>]+>", t) if x not in ("<br>", "<strong>", "</strong>", '<small class="ir-fn">', "</small>")]
    return t, bad


def build():
    src = fetch()
    pages = {}
    for a in src["ayahs"]:
        for c in a["content"]:
            pages[(int(c["part"]), int(c["page"]))] = c["text"]
    T = " ".join(pages[k] for k in sorted(pages))      # pages break mid-sentence, never mid-word
    T = T.replace("\r", "")
    heads = list(HEAD.finditer(T))
    qd = open(os.path.join(APP, "data", "quran_data.js"), encoding="utf-8").read()
    meta = json.loads(qd[qd.index("{"): qd.rindex("}") + 1])
    verses = {s["s_id"]: s["verses"] for s in meta["surahs"]}
    text = {(r[0], r[1]): " " + norm(re.sub(r"\(\d+\)\s*$", "", r[4])) + " " for r in meta["ayahs"]}
    sur = {}
    problems, marks_found, marks_want = [], 0, 0
    for i, m in enumerate(heads):
        s, a, b = int(m.group(2).translate(AR)), int(m.group(3).translate(AR)), int((m.group(4) or m.group(3)).translate(AR))
        body = T[m.end(): heads[i + 1].start() if i + 1 < len(heads) else len(T)]
        body = BASM.sub("", body)
        if i + 1 < len(heads) and int(heads[i + 1].group(2).translate(AR)) != s:      # the next surah's title line
            body = re.sub(r"\s*(<br\s*/?>)?\s*سورة [ء-ْ ]{1,20}\s*$", "", body.rstrip())
        body = re.sub(r"^\s*سورة [ء-ْ ]{1,20}\s*$", "", body)
        body = re.sub(r"<br\s*/?>\s*تم بعون الله تعالى هذا الكتاب.*$", "", body, flags=re.S)
        # the book's copy of the ayat: up to «(b)» (and the line break after it, when there is one)
        endq = re.search(r"\(" + str(b).translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")) + r"\)\s*(<br\s*/?>)?", body)
        if not endq:
            problems.append(f"{s}:{a}-{b}: the book's ayah text does not end with ({b})"); continue
        quote, irab = body[:endq.end()], body[endq.end():]
        ayat = {}
        for mm in re.finditer(r"(.*?)\(([٠-٩]+)\)", re.sub(r"<[^>]+>", " ", quote), flags=re.S):
            ayat[int(mm.group(2).translate(AR))] = mm.group(1).strip()
        if sorted(ayat) != list(range(a, b + 1)):
            problems.append(f"{s}:{a}-{b}: the book quotes ayat {sorted(ayat)}")
        # where each later ayah's analysis starts: walk the «quotes» in order along the ayat's own words (the
        # book quotes them in order); ayah k starts at the first quote that lands on one of its words. A quote
        # equal to the passage's first words starts the walk again (the book's word notes come first, then the
        # iʿrāb from the top). Markers must come in ayah order; anything else is dropped, never guessed.
        if b > a:
            marks_want += b - a
            first = boundaries(irab, ayat, a, b)
            last, ins = -1, []
            for k in range(a + 1, b + 1):
                if k in first and first[k] > last:
                    ins.append((first[k], k)); last = first[k]; marks_found += 1
            for at, k in sorted(ins, reverse=True):
                irab = irab[:at] + f'<i data-a="{k}"></i>' + irab[at:]
        h, bad = clean(irab)
        h = h.replace("&lt;i data-a", "<i data-a")
        bad = [x for x in bad if not re.fullmatch(r'<i data-a="\d+">|</i>', x)]
        if bad: problems.append(f"{s}:{a}-{b}: unknown markup {sorted(set(bad))[:4]}")
        ref = REFS.pop(f"{s}:{a}", None)
        if ref is None and (len(norm(h)) < 12 or REFWORDS.search(h) and len(norm(h)) < 60):
            problems.append(f"{s}:{a}-{b}: the book refers elsewhere or says too little, and refs.json does not say where: {h[:80]!r}")
        sur.setdefault(s, []).append([a, b, h] + ([ref] if ref else []))
    for k in REFS: problems.append(f"refs.json {k}: no passage starts there")
    inl = link_inline(sur, text, verses)
    for s, P in sur.items():                       # every pointer lands on ayat that exist
        for p in P:
            for ts, ta, tb in (p[3] if len(p) > 3 else []):
                if not (1 <= ta <= tb <= verses[ts]) or (ts, ta) >= (s, p[0]): problems.append(f"{s}:{p[0]}: bad pointer {ts}:{ta}-{tb}")
    # coverage: every ayah of the app's numbering, once
    covered = 0
    for s in range(1, 115):
        P = sur.get(s, [])
        want = 1
        for a, b, *_ in P:
            if a != want: problems.append(f"surah {s}: passage {a}-{b} but expected to start at {want}")
            want = b + 1
        if want - 1 != verses[s]: problems.append(f"surah {s}: passages end at {want - 1}, the surah has {verses[s]}")
        covered += sum(p[1] - p[0] + 1 for p in P)
    return sur, problems, {"headings": len(heads), "ayat": covered, "passages": sum(len(v) for v in sur.values()),
                           "shared": sum(1 for v in sur.values() for p in v if p[1] > p[0]),
                           "pointers": sum(1 for v in sur.values() for p in v if len(p) > 3),
                           "markers": f"{marks_found}/{marks_want}", "inline_refs_linked": inl}


if __name__ == "__main__":
    sur, problems, st = build()
    print(st)
    for p in problems[:40]: print("PROBLEM", p)
    if problems: sys.exit(f"{len(problems)} problems — nothing written")
    if "--check" in sys.argv: sys.exit(0)
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for s, P in sur.items():
        js = "__irabPut(%d,%s);\n" % (s, json.dumps(P, ensure_ascii=False, separators=(",", ":")))
        f = os.path.join(OUT, f"{s:03d}.js")
        open(f + ".tmp", "w", encoding="utf-8", newline="\n").write(js); os.replace(f + ".tmp", f); total += len(js.encode("utf-8"))
    man = {"book": "إعراب القرآن الكريم", "authors": "أحمد عبيد الدعاس، أحمد محمد حميدان، إسماعيل محمود القاسم",
           "publisher": "دار المنير ودار الفارابي، دمشق", "edition": "الأولى 1425هـ", "digitised_by": "https://quranpedia.net",
           "source": SRC, **st}
    json.dump(man, open(os.path.join(HERE, "MANIFEST.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"wrote {len(sur)} files, {total / 1e6:.2f} MB")
