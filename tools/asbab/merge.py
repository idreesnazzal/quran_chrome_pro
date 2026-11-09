#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""بناء data/asbab_data.js — tools/asbab/merge.py (v4: cards, not single-book entries)

A card is one **event** on one ayah. Several books can testify to the same event:
their verdicts stand side by side and their texts share one «النص من الكتب (n)».
Different events on the same ayah stay different cards.

Input
  aligned/asbab_2919.json, aligned/asbab_460.json   الواحدي + المحرر, matched to the mushaf
  raw/asbab-suyuti.json                              لباب النقول narrations, each tied to the
                                                    aligned entry whose words it echoes
  summaries/*.jsonl                                  the easy summaries + grades written here
  curation/entries.json, curation/restore.json       hand decisions

Output (atomic: tmp + os.replace)
  data/asbab_data.js  {v:4, gen, books, checked, cards:[{r,sw,na,s,v:[{b,g,e}],t:[{b,t}]}], index}
"""
import datetime
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ALIGNED = os.path.join(HERE, 'aligned')
SUMM = os.path.join(HERE, 'summaries')
CURATION = os.path.join(HERE, 'curation')
RAW = os.path.join(HERE, 'raw')
OUT = os.path.join(ROOT, 'data', 'asbab_data.js')
SW = os.path.join(ROOT, 'sw.js')

GRADES = ('صحيح', 'حسن', 'ضعيف', 'لم يُحكم عليه')
RANK = {'صحيح': 0, 'حسن': 1, 'لم يُحكم عليه': 2, 'ضعيف': 3}     # the order the reader sees
TASHKEEL = re.compile(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]')

BOOKS = {
    '2919': {'n': 'أسباب نزول القرآن', 'a': 'أبو الحسن علي بن أحمد الواحدي النيسابوري', 's': 'الواحدي',
             'note': 'يسوق الواحدي الأثر بأسانيده؛ ولم يشترط الحكم على الأسانيد، فما في الحاشية فهو لِمُحقِّق الطبعة لا له.'},
    '460': {'n': 'المحرر في أسباب نزول القرآن من خلال الكتب التسعة', 'a': 'خالد بن سليمان المزيني', 's': 'المحرر',
            'note': 'المحرر يعرض سبب النزول ثم يُعقّبه بـ«النتيجة»، وهي موضع الحكم على الأثر.'},
    'suyuti': {'n': 'لباب النقول في أسباب النزول', 'a': 'جلال الدين عبد الرحمن بن أبي بكر السيوطي (ت 911هـ)', 's': 'السيوطي',
               'note': 'نص السيوطي وحده من طبعة دار الكتب العلمية (نسخة Shamela 0002247)؛ والنص الكامل لكل أثر هو ما في الكتاب.'},
}


def norm(s):
    s = TASHKEEL.sub('', s)
    s = (s.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ٱ', 'ا')
         .replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي'))
    return re.sub(r'\s+', ' ', re.sub(r'[^\u0621-\u064a ]+', ' ', s)).strip()


def load(path, default=None):
    if not os.path.exists(path):
        return default
    return json.load(open(path, encoding='utf-8'))


STOP = set("""عن بن ابن قال قالا قالت أن ان إن حدثنا أخبرنا ثنا نا أبو ابي أبي عبد الرحمن
رسول الله صلى عليه وسلم وهو في من على إلى الذي الذين ما لا و يا كل هذا هذه ذلك ثم قد كان
يكون هو هي وقد كما بين يديه بينهم نبي""".split())


def words(t):
    return {w for w in norm(t).split() if w not in STOP and len(w) > 2}


def same_event(a, b):
    """Two books, one event: a long verbatim echo, or a heavy overlap of the
    content words (the modern book paraphrases the classical one)."""
    n = shared_run(a, b)
    if n >= 8:
        return n, 'echo'
    ta, tb = words(a), words(b)
    j = len(ta & tb) / max(1, len(ta | tb))
    if j >= 0.20:
        return int(j * 100), 'words'
    return 0, ''


def shared_run(a, b):
    """Longest run of words a and b have in common — the test for «same event»."""
    wa, wb = norm(a), norm(b)
    best = 0
    for n in (18, 14, 12, 10, 9, 8, 7, 6):
        if best:
            break
        n = min(n, len(wa.split()))
        if n < 6:
            continue
        first = ' '.join(wa.split()[:n])
        if first and first in wb:
            best = n
    return best


def main():
    quran = open(os.path.join(ROOT, 'data', 'quran_data.js'), encoding='utf-8').read()
    verses = {}
    for m in re.finditer(r'"s_id":\s*(\d+),\s*"name":\s*"[^"]*",\s*"verses":\s*(\d+)', quran):
        verses[int(m.group(1))] = int(m.group(2))

    book_data = {}
    for bid, fname in (('2919', 'asbab_2919.json'), ('460', 'asbab_460.json')):
        book_data[bid] = load(os.path.join(ALIGNED, fname), {'ayat': {}})['ayat']
    suyuti = load(os.path.join(RAW, 'asbab-suyuti.json'), {'narrations': []})['narrations']

    summ = {}
    for f in sorted(os.listdir(SUMM)):
        if not f.endswith('.jsonl'):
            continue
        for line in open(os.path.join(SUMM, f), encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            row = json.loads(line)
            summ[(str(row['b']), row['k'].replace(':', '_'))] = row

    overrides = load(os.path.join(CURATION, 'entries.json'), {})
    # Books 2 and 3 (الاستيعاب، الصحيح المسند) are copyrighted: they arrive as verdicts
    # and references only, never as text. The file is empty until a clean source exists
    # — check.py refuses a reference-book row without a reference or with a quote > 15 words.
    refs = load(os.path.join(CURATION, 'references.json'), {'books': {}, 'rows': []})

    # ---- one entry per (book, ayah), each with its summary and its own verdict
    entries = []
    by_key = {}
    for bid in ('2919', '460'):
        for key in sorted(book_data[bid], key=lambda k: (int(k.split('_')[0]), int(k.split('_')[1]))):
            rec = book_data[bid][key]
            row = summ.get((bid, key), {})
            if not row:
                s, a = (int(x) for x in key.split('_'))
                rng = rec.get('range')
                if rng:
                    for i in range(rng[0], rng[1] + 1):
                        row = summ.get((bid, '%d_%d' % (s, i)), {})
                        if row:
                            break
            ov = overrides.get(bid, {}).get(key, {})
            g = row.get('g') or 'لم يُحكم عليه'
            if g not in GRADES:
                raise SystemExit('merge: bad grade %r for %s/%s' % (g, bid, key))
            e = {'b': bid, 'key': key, 't': rec['parts'], 's': row.get('s') or '',
                 'g': g, 'ev': row.get('e') or '', 'suy': [],
                 'r': ov.get('range', rec.get('range')),
                 'sw': bool(ov.get('surah_wide', rec.get('surah_wide'))),
                 'na': bool(ov.get('not_a_sabab', rec.get('not_a_sabab')))}
            entries.append(e)
            by_key['%s:%s' % (bid, key)] = e

    # ---- لباب النقول: every narration joins the entry whose words it echoes
    for n in suyuti:
        tgt = by_key.get(n['attach'])
        if tgt is None:
            continue
        tgt['suy'].append(n)

    # ---- group entries of the same ayah into one card when they tell one event
    groups, groupings = [], []
    for bid in ('2919', '460'):
        for e in [x for x in entries if x['b'] == bid]:
            placed = False
            for grp in groups:
                host = grp[0]
                if host['key'] != e['key'] or host['b'] == e['b']:
                    continue
                n, why = same_event(' '.join(host['t']), ' '.join(e['t']))
                if n:
                    grp.append(e)
                    groupings.append({'ayah': e['key'], 'books': [host['b'], e['b']],
                                      'run': n, 'why': why})
                    placed = True
                    break
            if not placed:
                groups.append([e])

    # ---- cards
    cards = []
    for grp in groups:
        host = grp[0]
        texts = []
        verdicts = []
        for e in grp:
            texts.append({'b': e['b'], 't': e['t']})
            verdicts.append({'b': e['b'], 'g': e['g'], 'e': e['ev']})
        for n in host['suy']:
            texts.append({'b': 'suyuti', 't': n['parts'], 'page': n.get('page')})
            verdicts.append({'b': 'suyuti', 'g': n['g'], 'e': n['e']})
        for e in grp[1:]:
            for n in e['suy']:
                texts.append({'b': 'suyuti', 't': n['parts'], 'page': n.get('page')})
                verdicts.append({'b': 'suyuti', 'g': n['g'], 'e': n['e']})
        # one row per book: a book with several narrations on the card is shown by its
        # strongest verdict, with that verdict's own sentence
        best_by_book = {}
        for v in verdicts:
            cur = best_by_book.get(v['b'])
            if cur is None or RANK.get(v['g'], 2) < RANK.get(cur['g'], 2):
                best_by_book[v['b']] = dict(v, n=1 + (cur or {}).get('n', 0))
            else:
                cur['n'] = cur.get('n', 1) + 1
        verdicts = sorted(best_by_book.values(), key=lambda v: RANK.get(v['g'], 2))
        summary = next((e['s'] for e in grp if e['s']), '')
        if not summary:
            summary = next((n.get('s', '') for n in host['suy']), '')
        cards.append({'r': host['r'] or 0, 'sw': 1 if host['sw'] else 0, 'na': 1 if host['na'] else 0,
                      'n': '', 's': summary, 'v': verdicts, 't': texts,
                      '_s': int(host['key'].split('_')[0]), '_a': int(host['key'].split('_')[1]),
                      '_k': host['key']})

    cards.sort(key=lambda c: (c['_s'], c['_a'], RANK.get(c['v'][0]['g'], 2)))
    index = {}
    for i, c in enumerate(cards):
        if c['sw']:
            first, last = 1, verses.get(c['_s'], c['_a'])
        elif c['r']:
            first, last = c['r']
        else:
            first, last = c['_a'], c['_a']
        for x in range(first, last + 1):
            if x > verses.get(c['_s'], 10 ** 6):
                continue
            index.setdefault('%d_%d' % (c['_s'], x), []).append(i)
    for c in cards:
        for f in ('_s', '_a', '_k'):
            c.pop(f)

    if refs.get('rows'):
        for row in refs['rows']:
            key = row['k'].replace(':', '_')
            rid = row['b']
            if rid not in BOOKS:
                raise SystemExit('merge: reference book %r is not declared' % rid)
            cards.append({'r': row.get('r') or 0, 'sw': 1 if row.get('sw') else 0, 'na': 0, 'n': '',
                          's': '', 'v': [{'b': rid, 'g': row['g'], 'e': '', 'ref': row['ref'],
                                          'q': row.get('q', '')}], 't': [],
                          '_s': int(key.split('_')[0]), '_a': int(key.split('_')[1]), '_k': key})
        cards.sort(key=lambda c: (c['_s'], c['_a'], RANK.get(c['v'][0]['g'], 2)))
        index = {}
        for i, c in enumerate(cards):
            if c['sw']:
                first, last = 1, verses.get(c['_s'], c['_a'])
            elif c['r']:
                first, last = c['r']
            else:
                first, last = c['_a'], c['_a']
            for x in range(first, last + 1):
                index.setdefault('%d_%d' % (c['_s'], x), []).append(i)
        for c in cards:
            for f in ('_s', '_a', '_k'):
                c.pop(f, None)

    payload = {
        'v': 4,
        'gen': datetime.date.today().isoformat(),
        'books': dict(BOOKS, **{k: v for k, v in (refs.get('books') or {}).items()}),
        'refBooks': sorted((refs.get('books') or {}).keys()),
        # 1 = the whole book was imported: an ayah without a card from it has none there
        'checked': {'2919': 1, '460': 1, 'suyuti': 1},
        'cards': cards,
        'index': index,
    }

    body = 'window.ASBAB_DATA = ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, OUT)
    sha = hashlib.sha256(body.encode('utf-8')).hexdigest()[:12]

    sw = open(SW, encoding='utf-8').read()
    m = re.search(r"const VERSION = 'mushaf-v(\d+)';", sw)
    if m:
        new = "const VERSION = 'mushaf-v%d';" % (int(m.group(1)) + 1)
        if new != m.group(0):
            open(SW + '.tmp', 'w', encoding='utf-8').write(sw.replace(m.group(0), new))
            os.replace(SW + '.tmp', SW)

    suy_cards = sum(1 for c in cards if any(t['b'] == 'suyuti' for t in c['t']))
    print('merge: %d cards over %d ayahs (%d with السيوطي) | %d grouped | %s %.2f MB; sw bumped'
          % (len(cards), len(index), suy_cards, len(groupings), sha, os.path.getsize(OUT) / 1048576.0))
    for gp in groupings[:10]:
        print('  group %s: %s + %s (%s %d)' % (gp['ayah'], gp['books'][0], gp['books'][1], gp['why'], gp['run']))
    if os.path.getsize(OUT) > 5 * 1048576:
        raise SystemExit('merge: the payload passed 5 MB — split it before shipping')
    return 0


if __name__ == '__main__':
    sys.exit(main())
