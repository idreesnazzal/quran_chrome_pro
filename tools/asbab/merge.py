#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""بناء data/asbab_data.js من الكتب المُحقّقة — tools/asbab/merge.py

Input
  tools/asbab/aligned/asbab_2919.json   the aligned Wahidi entries
  tools/asbab/aligned/asbab_460.json    the aligned المحرر entries
  tools/asbab/summaries/*.jsonl         the easy summaries + grades written for
                                        this app, one line per ayah per book
  tools/asbab/curation/entries.json     hand overrides: range, surah-wide, the
                                        book's «this is not a sabab» note
  tools/asbab/curation/checked_460.json ayahs that were actually read in المحرر
                                        (an ayah outside this list must never be
                                        told to the reader that المحرر has none)

Output (atomic: tmp file + os.replace)
  data/asbab_data.js
    window.ASBAB_DATA = {
      v: 3, gen: <date>, books: {id: {n, a, s, note}},
      checked: {"2919": 1, "460": ["2_144", ...]},
      entries: [{b, r, sw, na, n, s, g, e, t: [ ... book text ... ]}],
      index:   {"2_144": [0, 5], ...}       ayah -> entry ids (ranges expanded)
    }

Ayahs with no entry are simply absent from `index`: the reader is shown one
honest line naming the books that were really checked for that ayah.

The service worker VERSION is bumped when the payload changes.
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
OUT = os.path.join(ROOT, 'data', 'asbab_data.js')
SW = os.path.join(ROOT, 'sw.js')

GRADES = ('صحيح', 'حسن', 'ضعيف', 'لم يُحكم عليه')
NOTE_2919 = 'يسوق الواحدي الأثر بأسانيده؛ ولم يشترط الحكم على الأسانيد، فما في الحاشية فهو لِمُحقِّق الطبعة لا له.'
NOTE_460 = 'المحرر يعرض سبب النزول ثم يُعقّبه بـ«النتيجة»، وهي موضع الحكم على الأثر.'


def load(path, default=None):
    if not os.path.exists(path):
        return default
    return json.load(open(path, encoding='utf-8'))


def main():
    quran = open(os.path.join(ROOT, 'data', 'quran_data.js'), encoding='utf-8').read()
    verses = {}
    for m in re.finditer(r'"s_id":\s*(\d+),\s*"name":\s*"[^"]*",\s*"verses":\s*(\d+)', quran):
        verses[int(m.group(1))] = int(m.group(2))

    books = {}
    for bid, fname in (('2919', 'asbab_2919.json'), ('460', 'asbab_460.json')):
        data = load(os.path.join(ALIGNED, fname), {'ayat': {}})
        books[bid] = data['ayat']

    # summaries written for this app
    summ = {}
    for f in sorted(os.listdir(SUMM)):
        if not f.endswith('.jsonl'):
            continue
        for line in open(os.path.join(SUMM, f), encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            row = json.loads(line)
            key = (str(row['b']), row['k'].replace(':', '_'))
            summ[key] = row

    overrides = load(os.path.join(CURATION, 'entries.json'), {})
    cov = load(os.path.join(CURATION, 'checked_460.json'), [])
    if isinstance(cov, dict):
        cov = [x['k'] for x in cov.get('ayahs', [])]      # a list of {k, seed, page, verdict}
    checked_460 = set(k.replace(':', '_') for k in cov)

    entries, index = [], {}

    def summary_for(bid, key):
        """A summary written for this ayah, or for any ayah of the entry's range."""
        if (bid, key) in summ:
            return summ[(bid, key)]
        s, a = (int(x) for x in key.split('_'))
        rec = books[bid].get(key, {})
        rng = rec.get('range')
        if rng:
            for i in range(rng[0], rng[1] + 1):
                k2 = '%d_%d' % (s, i)
                if (bid, k2) in summ:
                    return summ[(bid, k2)]
        return {}

    def put(bid, key, rec):
        row = summary_for(bid, key)
        ov = overrides.get(bid, {}).get(key, {})
        s, a = (int(x) for x in key.split('_'))
        rng = ov.get('range', rec.get('range'))
        if rng and not (rng[0] <= a <= rng[1]):
            rng = None
        grade = row.get('g') or 'لم يُحكم عليه'
        if grade not in GRADES:
            raise SystemExit('merge: bad grade %r for %s/%s' % (grade, bid, key))
        ent = {
            'b': int(bid),
            'r': rng or 0,
            'sw': 1 if ov.get('surah_wide', rec.get('surah_wide')) else 0,
            'na': 1 if ov.get('not_a_sabab', rec.get('not_a_sabab')) else 0,
            'n': ov.get('note') or row.get('n') or '',
            's': row.get('s') or '',
            'g': grade,
            'e': row.get('e') or '',
            't': rec['parts'],
        }
        i = len(entries)
        entries.append(ent)
        s0 = int(key.split('_')[0])
        if ent['sw']:                       # general to the surah: shown on every ayah of it
            first, last = 1, verses.get(s0, a)
        else:
            first, last = (rng if rng else (a, a))
        for x in range(first, last + 1):
            if x > verses.get(s, 10 ** 6):
                continue
            index.setdefault('%d_%d' % (s, x), []).append(i)

    for bid in ('2919', '460'):
        for key in sorted(books[bid], key=lambda k: (int(k.split('_')[0]), int(k.split('_')[1]))):
            put(bid, key, books[bid][key])

    # an ayah with a المحرر entry is, by definition, an ayah we read in المحرر
    for key in books['460']:
        checked_460.add(key)
    for key in checked_460:
        if key not in [k for k in checked_460 if k in books['460']] and not re.match(r'^\d{1,3}_\d{1,3}$', key):
            raise SystemExit('merge: bad coverage key %r' % key)

    payload = {
        'v': 3,
        'gen': datetime.date.today().isoformat(),
        'books': {
            '2919': {'n': 'أسباب نزول القرآن', 'a': 'أبو الحسن علي بن أحمد الواحدي النيسابوري', 's': 'الواحدي', 'note': NOTE_2919},
            '460': {'n': 'المحرر في أسباب نزول القرآن من خلال الكتب التسعة', 'a': 'خالد بن سليمان المزيني', 's': 'المحرر', 'note': NOTE_460},
        },
        # 1 means «the whole book was imported», so an ayah without an entry here has
        # no sabab in that book — and the empty line may name it confidently.
        'checked': {'2919': 1, '460': 1},
        'entries': entries,
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

    # the service worker must serve the new payload to an installed app
    sw = open(SW, encoding='utf-8').read()
    m = re.search(r"const VERSION = 'mushaf-v(\d+)';", sw)
    if m:
        new = 'const VERSION = \'mushaf-v%d\';' % (int(m.group(1)) + 1)
        if new != m.group(0):
            open(SW + '.tmp', 'w', encoding='utf-8').write(sw.replace(m.group(0), new))
            os.replace(SW + '.tmp', SW)

    print('merge: %d entries (%d الواحدي, %d المحرر) over %d ayahs, %d with a summary; %s %.2f MB; sw bumped'
          % (len(entries), len(books['2919']), len(books['460']), len(index),
             sum(1 for e in entries if e['s']), sha, os.path.getsize(OUT) / 1048576.0))
    if os.path.getsize(OUT) > 5 * 1048576:
        raise SystemExit('merge: the payload passed 5 MB — split it before shipping')
    return 0


if __name__ == '__main__':
    sys.exit(main())
