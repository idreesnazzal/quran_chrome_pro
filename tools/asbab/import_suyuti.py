#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""استيراد «لباب النقول في أسباب النزول» للسيوطي (ت 911هـ) — tools/asbab/import_suyuti.py

Source (public domain, author died 911 AH):
  OpenITI RELEASE, 0911Suyuti.LubabNuqul.Shamela0002247-ara1
  edition: دار الكتب العلمية، بيروت (as the OpenITI header records it)
  https://github.com/OpenITI/RELEASE/blob/main/data/0911Suyuti/0911Suyuti.LubabNuqul/0911Suyuti.LubabNuqul.Shamela0002247-ara1

What the text is: one continuous stream of narrations, ordered by the mushaf, with
page markers (`# PageV01P015`) but **no ayah keys**. Guessing the ayah from the
quoted verse drifts: the book quotes three or four words («قوله تعالى أو كصيب
الآية») and every section then runs through several narrations.

So this importer never guesses an ayah. It accepts a narration only when it
reproduces a run of at least nine consecutive words that already exists verbatim
in an *aligned* entry of الواحدي or المحرر (both already validated against the
mushaf by align.py). That narration is the same event, on the same ayah; anything
else is dropped and counted. The match keeps the narration, the page it was read
on, and — when السيوطي himself grades it in that narration — the grade with the
sentence quoted verbatim.

Output  tools/asbab/raw/asbab-suyuti.json
"""
import hashlib
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'raw', 'lubab-nuqul.shamela0002247.openiti.txt')
OUT = os.path.join(HERE, 'raw', 'asbab-suyuti.json')
ALIGNED = os.path.join(HERE, 'aligned')

TASHKEEL = re.compile(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]')
GRADE_PATTERNS = [
    (r'إسناده\s+صحيح', 'صحيح'),
    (r'إسناده\s+حسن', 'حسن'),
    (r'إسناده\s+ضعيف', 'ضعيف'),
    (r'صحيح\s+على\s+شرط\s+(?:مسلم|البخاري|الشيخين)', 'صحيح'),
    (r'أسانيده\s+صحاح', 'صحيح'),
]
# «واه» and a bare «ضعيف» judge the chain that came before them in the printed page,
# not always the narration this slice starts with — left out on purpose.
ISNAD_STOP = set('''عن بن ابن قال قالا قالت أن ان إن حدثنا أخبرنا ثنا نا أبو ابي أبي عبد الرحمن رسول
الله صلى عليه وسلم وهو في من على إلى الذي الذين ما لا و يا كل هذا هذه ذلك ثم قد كان يكون
أيضا به له بها منها منها عنه عنها أنه أنها هم هو هي وقد كما بين يديه بينهم'''.split())
# a narration starts here; used only to cut the slice we copy, never to interpret it
START = re.compile(r'(?<!\S)(?:و?أخرج|و?أخرجه|و?روى|و?رواه|قال\s+عبد\s+الرزاق|قال\s+ابن\s+أبي\s+حاتم)\b')


def norm(s):
    s = unicodedata.normalize('NFKC', s)
    s = TASHKEEL.sub('', s)
    s = (s.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ٱ', 'ا')
         .replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي'))
    s = re.sub(r'[^\u0621-\u064a ]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def parse(path):
    """The OpenITI file → ('text', page) units with the page every line sits on."""
    page = (1, 0)
    out, cur = [], []
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('#META'):
            continue
        m = re.match(r'#\s*PageV(\d+)P(\d+)', line)
        if m:
            if cur:
                out.append((' '.join(cur), page))
                cur = []
            page = (int(m.group(1)), int(m.group(2)))
            continue
        if line.startswith('~~'):
            line = line[2:]
        elif line.startswith('#'):
            line = line.lstrip('#').strip()
        line = re.sub(r'\bms\d+\b', ' ', line).strip()
        if re.match(r'^سورة\s+\S+\s*$', line):   # a surah heading, not narration
            continue
        if line:
            cur.append(line)
    if cur:
        out.append((' '.join(cur), page))
    text = ' '.join(t for t, _ in out)
    text = re.sub(r'\s+', ' ', text).strip()
    # page boundaries as character offsets, so a slice keeps its printed page
    offs, pos = [], 0
    for t, p in out:
        offs.append((pos, p))
        pos += len(t) + 1
    return text, offs


def page_at(offs, i):
    lo, hi, ans = 0, len(offs) - 1, offs[0][1]
    while lo <= hi:
        mid = (lo + hi) // 2
        if offs[mid][0] <= i:
            ans = offs[mid][1]
            lo = mid + 1
        else:
            hi = mid - 1
    return ans


def build_index():
    """8-gram → aligned entry ids, from the two books already matched to the mushaf."""
    idx, texts = {}, {}
    for bid, fname in (('2919', 'asbab_2919.json'), ('460', 'asbab_460.json')):
        data = json.load(open(os.path.join(ALIGNED, fname), encoding='utf-8'))
        for key, rec in data['ayat'].items():
            w = norm(' '.join(rec['parts'])).split()
            texts[(bid, key)] = w
            for i in range(len(w) - 7):
                idx.setdefault(' '.join(w[i:i + 8]), set()).add((bid, key))
    return idx, texts


def grade_of(narration):
    """Only what السيوطي says in this narration; the sentence is returned verbatim."""
    plain = re.sub(r'\s+', ' ', narration)
    best = None
    for pat, g in GRADE_PATTERNS:
        m = re.search(pat, plain)
        if not m:
            continue
        start = max(plain.rfind('.', 0, m.start()), plain.rfind('،', 0, m.start()))
        end = plain.find('.', m.end())
        sent = plain[start + 1: end + 1 if end != -1 else len(plain)].strip(' .،')
        if len(sent) > 240:
            sent = plain[m.start(): m.end() + 80].strip(' .،')
        # «إسناده ضعيف» inside a weak-grade sentence must win over a stray «صحيح»
        best = (g, sent)
        if g == 'ضعيف':
            break
    return best or ('لم يُحكم عليه', '')


def units(text):
    """The book cut into narrations: each begins at its own opening («أخرج…»,
    «روى…») and stops before the next opening or the next verse heading
    («قوله تعالى…»), so a slice never carries the neighbour's story."""
    starts = sorted(m.start() for m in START.finditer(text))
    heads = [m.start() for m in re.finditer(r'قوله تعالى', text)]
    out = []
    for n, st in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(text)
        nxt_head = next((h for h in heads if h > st), None)
        if nxt_head is not None and nxt_head < end:
            end = nxt_head
        piece = text[st:end].strip()
        if 80 < len(piece) <= 4000:
            out.append((st, piece))
    return out


def quran_grams():
    """Everything the mushaf itself says: a shared run of these proves nothing."""
    src = open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'data', 'quran_data.js'),
               encoding='utf-8').read()
    data = json.loads(src[src.index('=') + 1:].strip().rstrip(';'))
    grams = set()
    for a in data['ayahs']:
        w = norm(a[4]).split()
        for i in range(len(w) - 7):
            grams.add(' '.join(w[i:i + 8]))
    return grams


def main():
    raw = open(SRC, encoding='utf-8').read()
    sha = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    text, offs = parse(SRC)
    idx, _texts = build_index()
    qgrams = quran_grams()

    narrations, dropped = [], []
    for off, piece in units(text):
        w = norm(piece).split()
        grams = {}
        for i in range(len(w) - 7):
            g = ' '.join(w[i:i + 8])
            if g in qgrams:                 # Quranic words: no evidence of the event
                continue
            if sum(1 for w in g.split() if w not in ISNAD_STOP) < 4:
                continue                    # an isnad line: shared by every book, proves nothing
            grams[g] = grams.get(g) or 0
        score = {}
        for g in grams:
            for t in idx.get(g, ()):
                score[t] = score.get(t, 0) + 1
        if not score:
            dropped.append({'page': list(page_at(offs, off)), 'reason': 'no echo outside the Quran',
                            'head': piece[:90]})
            continue
        ranked = sorted(score.items(), key=lambda kv: -kv[1])
        best, n = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0
        if n < 2:
            dropped.append({'page': list(page_at(offs, off)), 'reason': 'only one 8-word echo',
                            'head': piece[:90]})
            continue
        if second and n < 2 * second:
            dropped.append({'page': list(page_at(offs, off)),
                            'reason': 'echo shared by %d entries (%s/…) — ambiguous' % (len(ranked), best[1]),
                            'head': piece[:90]})
            continue
        g, e = grade_of(piece)
        vol, page = page_at(offs, off)
        narrations.append({'k': best[1], 'attach': '%s:%s' % best, 'page': [vol, page],
                           'parts': [piece], 'g': g, 'e': e, 'echo': n})

    narrations.sort(key=lambda n: (int(n['k'].split('_')[0]), int(n['k'].split('_')[1]), n['attach']))
    payload = {
        'book': 'suyuti',
        'provenance': {
            'title': 'لباب النقول في أسباب النزول',
            'author': 'عبد الرحمن بن أبي بكر، جلال الدين السيوطي (ت 911هـ)',
            'edition': 'دار الكتب العلمية، بيروت — نسخة Shamela 0002247 (OpenITI RELEASE)',
            'url': 'https://github.com/OpenITI/RELEASE/blob/main/data/0911Suyuti/0911Suyuti.LubabNuqul/0911Suyuti.LubabNuqul.Shamela0002247-ara1',
            'sha256': sha,
            'note': 'نص السيوطي وحده؛ ولا يُنسب إليه سبب لم يرد في نصه.',
        },
        'narrations': narrations,
        'dropped': dropped,
    }
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=0)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, OUT)

    by_ayah = {n['k'] for n in narrations}
    grades = {}
    for n in narrations:
        grades[n['g']] = grades.get(n['g'], 0) + 1
    print('suyuti: %d narrations on %d ayahs | dropped %d | grades %s | sha %s…'
          % (len(narrations), len(by_ayah), len(dropped), grades, sha[:12]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
