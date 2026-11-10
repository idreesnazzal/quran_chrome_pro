"""لباب النقول: the narrations import_suyuti.py could not attach by echo, placed by reading.

import_suyuti.py keeps an السيوطي narration only when it repeats 8+ words of a الواحدي or
المحرر entry; 768 did not. Each of those was read once (curation/suyuti_extra.json): its
ayah (and range, only when the narration states one), an easy summary written from the
narration alone, and السيوطي's own verdict with his words. A placement was accepted only if
the narration or the «قوله تعالى» heading before it quotes 3+ consecutive words of that
ayah, and only inside the surah heading it sits under.

This step runs after editor_grades.py. Each placed narration becomes its own card (book
'suyuti', marked "sx": 1). Re-running first removes the cards it added before.

usage: python3 suyuti_extra.py      (rewrites data/asbab_data.js atomically, bumps sw.js)
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'data', 'asbab_data.js')
SW = os.path.join(ROOT, 'sw.js')
EXTRA = os.path.join(HERE, 'curation', 'suyuti_extra.json')
JOIN = os.path.join(HERE, 'curation', 'suyuti_join.json')
GROUPS = os.path.join(HERE, 'curation', 'suyuti_groups.json')     # read by check.py rule (g)
RANK = {'صحيح': 0, 'حسن': 1, 'لم يُحكم عليه': 2, 'ضعيف': 3}


def main():
    rows = json.load(open(EXTRA, encoding='utf-8'))['placed']
    src = open(OUT, encoding='utf-8').read()
    head = src[:src.index('{')]
    payload = json.loads(src[src.index('{'):src.rindex('}') + 1])
    cards, index = payload['cards'], payload['index']

    # drop what an earlier run added (whole cards, and texts/verdicts joined into old cards)
    for c in cards:
        if c.get('sx'):
            continue
        c['t'] = [t for t in c.get('t') or [] if not t.get('sx')]
        vs = []
        for v in c.get('v') or []:
            if v.get('sx'):
                continue
            if 'sx_orig' in v:
                v.update(v.pop('sx_orig'))
            vs.append(v)
        c['v'] = vs
    keep = [i for i, c in enumerate(cards) if not c.get('sx')]
    if len(keep) != len(cards):
        remap = {old: new for new, old in enumerate(keep)}
        cards = [cards[i] for i in keep]
        index = {k: [remap[i] for i in ids if i in remap] for k, ids in index.items()}
        index = {k: ids for k, ids in index.items() if ids}

    # joins (curation/suyuti_join.json): a narration that tells the same incident as an
    # existing card, or as another new narration, goes INTO that card instead of beside it
    jd = json.load(open(JOIN, encoding='utf-8')) if os.path.exists(JOIN) else {}
    joins = jd.get('join') or {}
    by_sum = {'c' + hashlib.sha1(c['s'].encode('utf-8')).hexdigest()[:10]: i for i, c in enumerate(cards)}
    group_rows = []

    def add_into(cid, r, why):
        c = cards[cid]
        c['t'].append({'b': 'suyuti', 't': [r['text']], 'page': r['page'], 'sx': 1})
        old = [v for v in c['v'] if v.get('b') == 'suyuti']
        g = r.get('g')
        if not old:
            c['v'].append({'b': 'suyuti', 'g': g or 'لم يُحكم عليه', 'e': r.get('q') or '', 'sx': 1})
        elif g and old[0].get('g') == 'لم يُحكم عليه':
            old[0]['sx_orig'] = {'g': old[0]['g'], 'e': old[0].get('e', '')}
            old[0]['g'], old[0]['e'] = g, r.get('q') or ''
        c['v'].sort(key=lambda v: RANK.get(v.get('g'), 2))
        books = sorted({str(t['b']) for t in c['t']})
        if len(books) > 1:
            group_rows.append({'ayah': r['k'].replace(':', '_'), 'books': books, 'same_event': True,
                               'reason': 'لباب النقول: ' + (why or 'same incident'), 'source': 'read'})

    added, joined, ayahs, home = 0, 0, set(), {}
    for r in rows:
        j = joins.get(r['id']) or {}
        target = j.get('join')
        while target and target.startswith('n') and target in joins and (joins[target] or {}).get('join'):
            target = joins[target]['join']          # follow a chain to its first member
        if target and target.startswith('c') and target in by_sum:
            add_into(by_sum[target], r, j.get('why')); home[r['id']] = by_sum[target]; joined += 1
            continue
        if target and target.startswith('n') and target in home:
            add_into(home[target], r, j.get('why')); home[r['id']] = home[target]; joined += 1
            continue
        s, a = (int(x) for x in r['k'].split(':'))
        first, last = r['r'] if r.get('r') else (a, a)
        g = r.get('g') or 'لم يُحكم عليه'
        card = {'r': [first, last] if last > first else 0, 'sw': 0, 'na': 0, 'n': '', 's': r['s'],
                'v': [{'b': 'suyuti', 'g': g, 'e': r.get('q') or ''}],
                't': [{'b': 'suyuti', 't': [r['text']], 'page': r['page']}],
                'sx': 1}
        cards.append(card)
        cid = len(cards) - 1
        home[r['id']] = cid
        for x in range(first, last + 1):
            key = '%d_%d' % (s, x)
            index.setdefault(key, []).append(cid)
            ayahs.add(key)
        added += 1

    # pairs read and found to be two incidents although they share wording (check.py rule b)
    group_rows += [{k: r[k] for k in ('ayah', 'books', 'same_event', 'reason')} for r in jd.get('rejected') or []]
    tmp = GROUPS + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        json.dump({'note': 'written by suyuti_extra.py from curation/suyuti_join.json', 'groups': group_rows},
                  f, ensure_ascii=False, indent=0)
    os.replace(tmp, GROUPS)

    # within an ayah: صحيح, حسن, the rest, ضعيف (as merge.py orders them)
    def best(i):
        return min(RANK.get(v.get('g'), 2) for v in cards[i]['v'])
    for key in ayahs:
        index[key] = sorted(index[key], key=lambda i: (best(i), i))

    payload['cards'], payload['index'] = cards, dict(sorted(index.items(), key=lambda kv: tuple(int(x) for x in kv[0].split('_'))))
    body = head + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
    if body != src:
        with open(OUT + '.tmp', 'w', encoding='utf-8', newline='') as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(OUT + '.tmp', OUT)
        sw = open(SW, encoding='utf-8').read()
        m = re.search(r"const VERSION = 'mushaf-v(\d+)';", sw)
        if m:
            with open(SW + '.tmp', 'w', encoding='utf-8', newline='') as f:
                f.write(sw.replace(m.group(0), "const VERSION = 'mushaf-v%d';" % (int(m.group(1)) + 1)))
            os.replace(SW + '.tmp', SW)
    print('suyuti_extra: %d new cards on %d ayahs, %d joined into a card of the same incident | %d cards over %d ayahs | %.2f MB'
          % (added, len(ayahs), joined, len(cards), len(payload['index']), len(body.encode('utf-8')) / 1048576.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
