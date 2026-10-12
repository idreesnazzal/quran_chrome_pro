"""Build data/word_boxes.js: one real box per word, measured on the page images.

Why: the app used to split each ayah's line rectangles proportionally to the
letter count of its words, so the word spotlight often straddled two words.

How (per ayah, per page):
  1. Map the ayah's line rectangles (QURAN_DATA.coords, its own coordinate
     space) onto the 700x1100 page image with the measured affine map
     (fit on 4,306 line ends of 151 pages, residual sd ~2 px):
         x_img = XA * x + XB        y_img = YA * y + YB
  2. Column ink profile of each rectangle (rows 30%..95% of the line band:
     skips tashkeel/waqf marks above the letters, which bridge word gaps).
  3. The ayah needs (words + 1 medallion) segments in total, so it needs
     (words + 1 - rectangles) cut points: take the widest blank gaps across
     ALL its rectangles. This decides both the word boundaries and which
     words sit on which line. The last (leftmost) segment is the ayah-number
     medallion and is dropped.
  4. If the ink offers fewer gaps than needed (e.g. the print joins words the
     data text splits, like يا أيها), the ayah is left out and the app falls
     back to the proportional estimate for it.

Output: window.QURAN_WORD_BOXES = {"s_a": [line, x1, x2, line, x1, x2, ...]}
in image pixels (700 wide), one triple per data word, in reading order.
Run:  python scripts/build_word_boxes.py   (needs numpy + Pillow)
"""
import json, os, sys
import numpy as np
from PIL import Image

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
XA, XB = 0.54540, -14.48
YA, YB = 0.55122, 29.10
ROW_LO, ROW_HI = 0.30, 0.95


def load():
    raw = open(os.path.join(APP, "data", "quran_data.js"), encoding="utf-8").read()
    return json.loads(raw[raw.index("{"): raw.rindex("}") + 1])


def gaps_of(prof, x0):
    """blank runs strictly inside the profile -> [(width, left_x, right_x)]"""
    out, n, i = [], len(prof), 0
    blank = prof <= 1
    while i < n:
        if blank[i]:
            j = i
            while j < n and blank[j]:
                j += 1
            if i > 0 and j < n:
                out.append((j - i, x0 + i, x0 + j - 1))
            i = j
        else:
            i += 1
    return out


LAMBDA = 6.0      # px of gap traded for a factor-e mismatch in segment width
MEDALLION_W = 30  # expected width of the ayah-number medallion (px)
MAX_ATOMS = 14    # a word is at most this many ink runs


def letters(w):
    return max(1, len([ch for ch in w if "ء" <= ch <= "ي"]))


def segment(atoms, words, S):
    """Partition atoms into S segments (cut only at gaps, always at rectangle
    ends) maximising  sum(gap widths at cuts) - LAMBDA*sum|log(width/expected)|."""
    A = len(atoms)
    if A < S:
        return None
    ink_w = sum(a[3] - a[2] + 1 for a in atoms)
    gaps_w = sum(a[4] for a in atoms if a[4])
    span = ink_w + gaps_w - MEDALLION_W
    chars = [letters(w) for w in words]
    tot = float(sum(chars))
    exp = [max(6.0, span * c / tot) for c in chars] + [MEDALLION_W]
    NEG = -1e18
    # best[i][k]: atoms[0..i] form k+1 segments, cut right after atom i
    best = [[NEG] * S for _ in range(A)]
    back = [[-1] * S for _ in range(A)]
    for i in range(A):
        lo_k = max(0, S - (A - i))
        for j in range(i, max(-1, i - MAX_ATOMS), -1):   # segment = atoms j..i
            if j < i and atoms[j][4] is None:              # cannot span a rectangle end
                break
            # reading order is right -> left: atom j is the segment's right end, atom i its left end
            w = atoms[j][3] - atoms[i][2] + 1 if atoms[i][0] == atoms[j][0] else None
            if w is None or w <= 0:
                continue
            cut = atoms[i][4] or 0.0
            for k in range(lo_k, min(S, i + 1)):
                prev = 0.0 if (j == 0 and k == 0) else (best[j - 1][k - 1] if j > 0 and k > 0 else NEG)
                if prev == NEG:
                    continue
                v = prev + cut - LAMBDA * abs(np.log(w / exp[k]))
                if v > best[i][k]:
                    best[i][k] = v
                    back[i][k] = j
    if best[A - 1][S - 1] == NEG:
        return None
    segs, i, k = [], A - 1, S - 1
    while i >= 0 and k >= 0:
        j = back[i][k]
        segs.append((atoms[i][1], atoms[i][2], atoms[j][3]))
        i, k = j - 1, k - 1
    segs.reverse()
    return segs[:-1]  # drop the medallion


def main():
    d = load()
    ayahs, coords, lines = d["ayahs"], d["coords"], d["lines"]
    by_page = {}
    for a in ayahs:
        by_page.setdefault(a[2], []).append(a)
    out, skipped, total = {}, 0, 0
    for page in sorted(by_page):
        img = np.asarray(Image.open(os.path.join(APP, "pages", f"{page:03d}.webp")).convert("RGB")).astype(np.int16)
        ink = ((img.max(axis=2) - img.min(axis=2)) > 70) | (img.min(axis=2) < 180)  # grey silent letters count
        pl = lines[str(page)]
        for a in by_page[page]:
            total += 1
            key = f"{a[0]}_{a[1]}"
            words = str(a[4]).rsplit("(", 1)[0].split()
            rects = [r for r in coords.get(key, []) if r[0] == page]
            if not rects or not words:
                skipped += 1
                continue
            # atoms = ink runs between blank gaps, in reading order
            # (rectangles in data order, each right -> left)
            atoms = []  # (rect_index, line, left, right, gap_after_width or None at rect end)
            for ri, (p, ln, x1, y1, x2, y2) in enumerate(rects):
                ly = pl[str(ln)]
                top, bot = YA * ly[0] + YB, YA * ly[1] + YB
                h = bot - top
                r0, r1 = int(top + h * ROW_LO), int(top + h * ROW_HI)
                X1, X2 = max(0, int(round(XA * x1 + XB))), min(ink.shape[1], int(round(XA * x2 + XB)))
                prof = ink[r0:r1, X1:X2].sum(axis=0)
                nz = np.nonzero(prof > 1)[0]
                if len(nz) == 0:
                    continue
                L, R = X1 + nz[0], X1 + nz[-1]
                gs = sorted(gaps_of(prof[nz[0]: nz[-1] + 1], L), key=lambda g: -g[1])  # right -> left
                right = R
                for g in gs:
                    atoms.append([ri, ln, g[2] + 1, right, g[0]])
                    right = g[1] - 1
                atoms.append([ri, ln, L, right, None])
            S = len(words) + 1  # + medallion
            boxes = segment(atoms, words, S)
            if boxes is None:
                skipped += 1
                continue
            flat = []
            for ln, x1, x2 in boxes:
                flat += [int(ln), int(x1), int(x2)]
            out[key] = flat
        sys.stdout.write(f"\rpage {page}/604")
    js = "window.QURAN_WORD_BOXES = " + json.dumps(out, separators=(",", ":")) + ";\n"
    tmp = os.path.join(APP, "data", "word_boxes.js.tmp")
    open(tmp, "w", encoding="utf-8").write(js)
    os.replace(tmp, os.path.join(APP, "data", "word_boxes.js"))
    print(f"\n{len(out)}/{total} ayahs with measured word boxes ({skipped} fall back), {len(js) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
