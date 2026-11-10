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


ISNAD = set("""حدثنا أخبرنا أنبأنا ثنا نا قال قالت قالا عن بن ابن أبي أبو عبد الرحمن
رسول الله صلى عليه وسلم رضي عنهما عنه عنها رواه أخرجه الحاكم البخاري مسلم الترمذي
النسائي أبو داود ابن ماجه أحمد الطبراني البيهقي عبد الرزاق معمر الزهري سعيد جابر
أنس عائشة ابن عباس عمر علي""".split())

STOP = set("""عن بن ابن قال قالا قالت أن ان إن حدثنا أخبرنا ثنا نا أبو ابي أبي عبد الرحمن
رسول الله صلى عليه وسلم وهو في من على إلى الذي الذين ما لا و يا كل هذا هذه ذلك ثم قد كان
يكون هو هي وقد كما بين يديه بينهم نبي""".split())


def words(t):
    return {w for w in norm(t).split() if w not in STOP and len(w) > 2}


def grams(t, n=5):
    w = norm(t).split()
    return {' '.join(w[i:i + n]) for i in range(max(0, len(w) - n + 1))}


def names(t):
    """Names the text puts next to «بن/ابن» — the people of the story."""
    w = norm(t).split()
    out = set()
    for i, x in enumerate(w):
        if x in ('بن', 'ابن') and 0 < i < len(w) - 1:
            for cand in (w[i - 1], w[i + 1]):
                if cand not in ('الله', 'قال', 'عن', 'عبد', 'ابو', 'ابي', 'رسول', 'نبي',
                                'الحافظ', 'الامام', 'رجل', 'ابنه', 'اليهود', 'المشركين') and len(cand) > 2:
                    out.add(cand)
    return out


QURAN_WORDS = set()


def story_words(t):
    """Words of a narration that are neither Quranic nor isnad — the story itself."""
    return [w for w in norm(t).split()
            if len(w) > 2 and w not in ISNAD and w not in QURAN_WORDS]


def same_event(a, b):
    """One event only on a long verbatim echo: eight consecutive story words.

    A shared ayah is not a shared event. The two books often hang unrelated
    reports on one ayah (59:9: the guest story in المحرر, the land story in
    الواحدي), and the percentage overlap test used in v5 grouped them because
    both are «أنصار» stories — which put one book's grade on another book's
    story. Nothing but a verbatim run is accepted automatically now.
    """
    wa, wb = story_words(a), story_words(b)
    n = 8
    if len(wa) < n or len(wb) < n:
        return 0, ''
    ga = {' '.join(wa[i:i + n]) for i in range(len(wa) - n + 1)}
    gb = {' '.join(wb[i:i + n]) for i in range(len(wb) - n + 1)}
    if ga & gb:
        return n, 'echo'
    return 0, ''


def main():
    quran = open(os.path.join(ROOT, 'data', 'quran_data.js'), encoding='utf-8').read()
    verses = {}
    for m in re.finditer(r'"s_id":\s*(\d+),\s*"name":\s*"[^"]*",\s*"verses":\s*(\d+)', quran):
        verses[int(m.group(1))] = int(m.group(2))
    global QURAN_WORDS
    try:
        qdata = json.loads(quran[quran.index('=') + 1:].strip().rstrip(';'))
        for a0 in qdata['ayahs']:
            QURAN_WORDS |= set(norm(a0[4]).split())
    except Exception:                                  # noqa: BLE001 — optional guard
        QURAN_WORDS = set()

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

    # ---- one block, one card: the same passage reaches align through several of its
    # ayat (a block quoting ٢٨٤-٢٨٦ becomes three keys with identical text), so the
    # repeated copies collapse onto the first ayah of the span
    seen_block, deduped = {}, []
    for e in entries:
        sig = (e['b'], tuple(e['t']))
        if sig in seen_block:
            host = seen_block[sig]
            if e['suy']:
                host['suy'].extend(e['suy'])
            if e['r'] and not host['r']:
                host['r'] = e['r']
            continue
        seen_block[sig] = e
        deduped.append(e)
    entries = deduped

    # ---- لباب النقول: every narration joins the entry whose words it echoes.
    # The book files some narrations under the whole surah or a neighbouring ayah
    # (five narrations on 2:231, 3:174, 28:57, 31:6 and 95:5 sat on 33:4), so the
    # filing is a hint: a narration goes to the entry it actually echoes, and one
    # that echoes nothing is left out rather than shown on a story it does not tell.
    def gather(parts):
        out = []
        for p in parts:
            if isinstance(p, list):
                out.extend(gather(p))
            elif isinstance(p, str):
                out.append(p)
        return ' '.join(out)

    def tokens(parts):
        return norm(gather(parts)).split()

    def grams(toks):
        """Qualifying eight-word runs: not an isnad line, not a Quran quotation."""
        out = set()
        for i in range(len(toks) - 7):
            g = toks[i:i + 8]
            if sum(1 for w in g if w not in ISNAD) < 4:
                continue
            if sum(1 for w in g if w not in QURAN_WORDS) < 3:
                continue
            out.add(tuple(g))
        return out

    full = lambda e: '%s:%s' % (e['b'], e['key'])
    gram_hits = {}
    for e in entries:
        for g in grams(tokens(e['t'])):
            gram_hits.setdefault(g, set()).add(full(e))

    for i, n in enumerate(suyuti):
        n['sid'] = i
    moved = orphan = 0
    for n in suyuti:
        score = {}
        for g in grams(tokens(n['parts'])):
            for key in gram_hits.get(g, ()):
                score[key] = score.get(key, 0) + 1
        ranked = sorted(score.items(), key=lambda kv: -kv[1])
        best_key = n['attach']
        if ranked and ranked[0][1] >= 2:
            cand, hits = ranked[0]
            second = ranked[1][1] if len(ranked) > 1 else 0
            # a move only on a clear win; a tie keeps the filing the book gave it
            if cand != n['attach'] and hits >= 2 * max(second, 1):
                best_key = cand
                moved += 1
        if best_key not in by_key:
            orphan += 1
            continue
        n['attach'] = best_key
        by_key[best_key]['suy'].append(n)
    if orphan or moved:
        print('suyuti: %d narration(s) moved to the entry they echo, %d left out'
              % (moved, orphan))

    # ---- group entries of the same ayah into one card when they tell one event.
    # A block's ayah now comes from its own header, but the two books can still hang the
    # same event on neighbouring ayat (one quotes 5:83, the other 5:82), so the test is
    # the overlap of the spans, not the equality of the keys.
    def span(e):
        if not e['r']:
            return {e['key']}
        sura = int(e['key'].split('_')[0])
        return {'%d_%d' % (sura, i) for i in range(e['r'][0], e['r'][1] + 1)}

    curated = load(os.path.join(CURATION, 'groups.json'), {'groups': []})['groups']

    def reviewed(a, b):
        """The recorded verdict for this pair of books on this ayah, if any."""
        for g in curated:
            ayah = g.get('ayah') or g.get('k')
            if {a['b'], b['b']} == (set(g['books']) - {'suyuti'}) and ayah in (a['key'], b['key']) \
                    and (span(a) & span(b)):
                return g
        return None

    groups, groupings = [], []
    for bid in ('2919', '460'):
        for e in [x for x in entries if x['b'] == bid]:
            placed = False
            for grp in groups:
                host = grp[0]
                if not (span(host) & span(e)):
                    continue
                n, why = same_event(' '.join(host['t']), ' '.join(e['t']))
                if not n and host['b'] == e['b']:
                    # a long passage card may already hold this very narration: the echo
                    # is against the group's whole text, not only its first entry
                    for other in grp[1:]:
                        n, why = same_event(' '.join(other['t']), ' '.join(e['t']))
                        if n:
                            break
                if host['b'] == e['b'] and n and why != 'echo':
                    n, why = 0, ''       # one book's two sections: only a verbatim echo
                row = reviewed(host, e)
                if row is not None and not row.get('same_event', True):
                    n, why = 0, ''            # read and rejected: two different stories
                elif row is not None:
                    n, why = 100, 'curated: ' + (row.get('reason') or '')
                if n:
                    grp.append(e)
                    groupings.append({'ayah': e['key'], 'books': [host['b'], e['b']],
                                      'run': n, 'why': why,
                                      'keys': [host['key'], e['key']],
                                      'ranges': [host['r'], e['r']]})
                    placed = True
                    break
            if not placed:
                groups.append([e])
    json.dump([{'ayah': (g[0]['key'] if len(g) == 1 else min((x['key'] for x in g),
                                                              key=lambda k: (int(k.split('_')[0]), int(k.split('_')[1])))),
                'books': sorted({x['b'] for x in g}),
                'keys': [x['key'] for x in g],
                'why': next((gp['why'] for gp in groupings if gp['keys'][0] == g[0]['key']), 'single book')}
               for g in groups], open(os.path.join(HERE, 'aligned', 'groups_seen.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

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
            texts.append({'b': 'suyuti', 't': n['parts'], 'page': n.get('page'), 'sid': n['sid']})
            verdicts.append({'b': 'suyuti', 'g': n['g'], 'e': n['e'], 'sid': n['sid']})
        for e in grp[1:]:
            for n in e['suy']:
                texts.append({'b': 'suyuti', 't': n['parts'], 'page': n.get('page'), 'sid': n['sid']})
                verdicts.append({'b': 'suyuti', 'g': n['g'], 'e': n['e'], 'sid': n['sid']})
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
        # the summary must belong to the story whose grade the reader sees first:
        # with several books on one card the best-graded book speaks first
        by_rank = sorted(grp, key=lambda e: RANK.get(e['g'], 2))
        summary = next((e['s'] for e in by_rank if e['s']), '')
        if not summary:
            summary = next((n.get('s', '') for n in host['suy']), '')
        rngs = [e['r'] for e in grp if e['r']]
        if rngs and all(x == rngs[0] for x in rngs):
            card_range = rngs[0]
        else:
            lo = max(x[0] for x in rngs) if rngs else 0
            hi = min(x[1] for x in rngs) if rngs else 0
            card_range = [lo, hi] if lo and hi >= lo else None
        cards.append({'r': card_range or 0, 'sw': 1 if host['sw'] else 0, 'na': 1 if host['na'] else 0,
                      'n': '', 's': summary, 'v': verdicts, 't': texts,
                      '_s': int(host['key'].split('_')[0]), '_a': int(host['key'].split('_')[1]),
                      '_k': host['key']})

    # ---- last guard: two cards that landed on the same ayah and still share a verbatim
    # run of eight story words are one event told twice — join them, so the reader never
    # sees one book's grade beside another book's summary
    def span_keys(c):
        if c['sw']:
            return {'%d_%d' % (c['_s'], i) for i in range(1, verses.get(c['_s'], c['_a']) + 1)}
        if c['r']:
            return {'%d_%d' % (c['_s'], i) for i in range(c['r'][0], c['r'][1] + 1)}
        return {'%d_%d' % (c['_s'], c['_a'])}

    rejected = set()
    try:
        for r in json.load(open(os.path.join('curation', 'groups.json'), encoding='utf-8'))['groups']:
            if not r['same_event']:
                rejected.add((r['ayah'], frozenset(set(r['books']) - {'suyuti'})))
    except FileNotFoundError:
        pass

    changed = True
    while changed:
        changed = False
        for i in range(len(cards)):
            if i >= len(cards):
                break
            for j in range(i + 1, len(cards)):
                if j >= len(cards):
                    break
                if cards[i]['_s'] != cards[j]['_s'] or not (span_keys(cards[i]) & span_keys(cards[j])):
                    continue
                shared = span_keys(cards[i]) & span_keys(cards[j])
                bset = frozenset({t['b'] for t in cards[i]['t'] + cards[j]['t']} - {'suyuti'})
                if any((k, bset) in rejected for k in shared):
                    continue
                a_txt = ' '.join(p for t in cards[i]['t'] for p in t['t'])
                b_txt = ' '.join(p for t in cards[j]['t'] for p in t['t'])
                if not same_event(a_txt, b_txt)[0]:
                    continue
                A, B = cards[i], cards[j]
                for t in B['t']:
                    if t not in A['t']:
                        A['t'].append(t)
                best = {}
                for v in A['v'] + B['v']:
                    cur = best.get(v['b'])
                    if cur is None or RANK.get(v['g'], 2) < RANK.get(cur['g'], 2):
                        best[v['b']] = dict(v)
                    cur = best[v['b']]
                    cur['n'] = cur.get('n', 0) + 1
                A['v'] = sorted(best.values(), key=lambda v: RANK.get(v['g'], 2))
                if not A['s']:
                    A['s'] = B['s']
                if B['r'] and not A['r']:
                    A['r'] = B['r']
                if B['sw']:
                    A['sw'], A['r'] = 1, 0
                cards.pop(j)
                changed = True
                break
            if changed:
                break

    # ---- a narration filed by echo alone can land on the wrong ayah. One that shares
    # nothing with its own card moves to the card it does echo, or is left out; the
    # narrations listed in curation/suyuti_fix.json are settled by hand instead.
    def card_text(c):
        return norm(' '.join(p for t in c['t'] if t['b'] != 'suyuti' for p in t['t']))

    def eight(words):
        return {tuple(words[i:i + 8]) for i in range(len(words) - 7)}

    card_grams = [eight(card_text(c).split()) for c in cards]
    gram_cards = {}
    for ci, gs in enumerate(card_grams):
        for g in gs:
            gram_cards.setdefault(g, set()).add(ci)

    def nar_grams(parts):
        out = []
        for p in parts:
            out.extend(p if isinstance(p, list) else [p])
        return eight(norm(' '.join(out)).split())

    payload_index = {}
    for ci, c in enumerate(cards):
        if c['sw']:
            ks = {'%d_%d' % (c['_s'], i) for i in range(1, verses.get(c['_s'], c['_a']) + 1)}
        elif c['r']:
            ks = {'%d_%d' % (c['_s'], i) for i in range(c['r'][0], c['r'][1] + 1)}
        else:
            ks = {'%d_%d' % (c['_s'], c['_a'])}
        for k in ks:
            payload_index.setdefault(k, []).append(ci)

    fixes = []
    fixfile = os.path.join('curation', 'suyuti_fix.json')
    if os.path.exists(fixfile):
        fixes = json.load(open(fixfile, encoding='utf-8'))['fixes']
    fix_sids = {f['sid'] for f in fixes}
    page_of = {n['sid']: tuple(n.get('page') or []) for n in suyuti}

    moves, drops = [], []
    for ci, c in enumerate(cards):
        for t in [t for t in c['t'] if t['b'] == 'suyuti']:
            if t['sid'] in fix_sids:
                continue
            score = {}
            for g in nar_grams(t['t']):
                for cj in gram_cards.get(g, ()):
                    score[cj] = score.get(cj, 0) + 1
            here = score.get(ci, 0)
            if here >= 2:
                continue                                # it echoes the card it sits on
            ranked = sorted(((cj, n) for cj, n in score.items() if cj != ci), key=lambda kv: -kv[1])
            if ranked and ranked[0][1] >= 2:
                moves.append((ci, ranked[0][0], t['sid']))
            else:
                drops.append((ci, t['sid']))

    def take(cards, ci, sid):
        """Remove the narration's text and verdict from card ci, return them."""
        got = []
        for lst in (cards[ci]['t'], cards[ci]['v']):
            for item in list(lst):
                if item.get('sid') == sid:
                    lst.remove(item)
                    got.append(item)
        return got

    for ci, cj, sid in moves:
        for item in take(cards, ci, sid):
            (cards[cj]['t'] if 't' in item else cards[cj]['v']).append(item)
        print('suyuti: page %s moved %s → %s' % (page_of.get(sid), [k for k, v in payload_index.items() if ci in v][:1],
                                                 [k for k, v in payload_index.items() if cj in v][:1]))
    for ci, sid in drops:
        take(cards, ci, sid)
        print('suyuti: page %s left out of %s — it echoes nothing there'
              % (page_of.get(sid), [k for k, v in payload_index.items() if ci in v][:1]))

    for f in fixes:
        sid = f['sid']
        if sid is None:
            print('fix: no narration with sid %s' % (f['sid'],))
            continue
        src = next((ci for ci, c in enumerate(cards) if any(t.get('sid') == sid for t in c['t'])), None)
        if src is None:
            continue
        if f.get('to') and f['to'] in payload_index:
            picks = payload_index[f['to']]
            dst = picks[min(f.get('to_index', 0), len(picks) - 1)]
            for item in take(cards, src, sid):
                (cards[dst]['t'] if 't' in item else cards[dst]['v']).append(item)
            print('fix: sid %s → %s' % (f['sid'], f['to']))
        else:
            take(cards, src, sid)
            print('fix: sid %s left out — %s' % (f['sid'], f.get('reason', '')[:50]))

    cards = [c for c in cards if c['t']]

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
