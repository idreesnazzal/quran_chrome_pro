#!/usr/bin/env python3
"""Import every المحرر (book 460) entry from the clean `asbab-v2` payload.

The previous agent downloaded the whole dump (615 ayahs, 210 المحرر entries)
into `data/asbab_data.js` on the branch `asbab-v2`, each entry's text verbatim
including «دراسة السبب» and «النتيجة».  We only READ that branch — never merge
it — and we rebuild our own raw file from it, so that `align.py` validates every
key against our mushaf exactly as it does for الواحدي.

    python3 import460.py [path-to-asbab-v2-data.js]

The grade is re-derived here from the «النتيجة» section alone (its first
sentence is kept verbatim as evidence); anything without a grading word is
«لم يُحكم عليه».  The `g` field of the source payload is never read.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'raw', 'asbab-book-460.json')
SOURCE_REF = 'origin/asbab-v2:data/asbab_data.js'

DIAC = re.compile(r'[\u064B-\u0652\u0670\u06D6-\u06ED]')
MARKS = (('sabab', 'سبب النزول'), ('dirasa', 'دراسة السبب'), ('natija', 'النتيجة'))


def bare(text):
    return DIAC.sub('', text)


def with_map(text):
    """bare text + a map from each bare index back to the original index"""
    out, back = [], []
    for i, ch in enumerate(text):
        if DIAC.match(ch):
            continue
        out.append(ch)
        back.append(i)
    back.append(len(text))
    return ''.join(out), back


def sections(y):
    """slice the entry text into (preamble, سبب, دراسة, النتيجة) on the markers"""
    flat, back = with_map(y)
    cut = []
    for name, marker in MARKS:
        i = flat.find(marker)
        if i < 0:
            cut.append((name, None, None))
            continue
        start = back[i]
        # the marker line ends with ':' — keep the colon too
        j = flat.find(':', i)
        end = back[j + 1] if 0 <= j < i + 40 else back[i + len(marker)]
        cut.append((name, start, end))
    first = min(c[1] for c in cut if c[1] is not None)
    out = {'preamble': y[:first].strip()}
    for idx, (name, start, end) in enumerate(cut):
        if start is None:
            out[name] = ''
            continue
        nxt = [c[1] for c in cut if c[1] is not None and c[1] > start]
        stop = min(nxt) if nxt else len(y)
        out[name] = y[end:stop].strip()
    return out


def grade_of(natija):
    """grade + verbatim evidence, from «النتيجة» only

    A negation («لا يصح»، «غير صحيح»، «لم يصح سنده»…) is a weakness verdict even
    though it contains the word «صحيح», so negations are tested first; the
    evidence is the single sentence that carries the verdict.
    """
    if not natija.strip():
        return 'لم يُحكم عليه', ''
    sentences = [x.strip() for x in re.split(r'(?<=[.!؟])\s+', natija.strip()) if x.strip()]
    def pick(rx):
        for sent in sentences:
            if re.search(rx, bare(sent)):
                return sent
        return ''
    ev = pick(r'غير صحيح|لا يصح|لم يصح|ليس بصحيح|لا تصح|لا يثبت|لا تصح')
    if ev:
        return 'ضعيف', ev
    ev = pick(r'لصحة|صحة سند|صحيح')
    if ev:
        return 'صحيح', ev
    ev = pick(r'لحسن|حسن')
    if ev:
        return 'حسن', ev
    ev = pick(r'لضعف|ضعيف|واه|معلول')
    if ev:
        return 'ضعيف', ev
    return 'لم يُحكم عليه', ''


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if path:
        src = open(path, encoding='utf-8').read()
    else:
        src = subprocess.check_output(['git', '-C', HERE, 'show', SOURCE_REF]).decode('utf-8')
    data = json.loads(src[src.index('{'):src.rindex('}') + 1])
    ayat, n = {}, 0
    for key, rec in data['a'].items():
        for ent in rec['x']:
            if ent['b'] != 'M':
                continue
            s = sections(ent['y'])
            parts = []
            if s['preamble']:
                parts.append(s['preamble'])
            parts.append('* سَبَبُ النُّزُولِ:\n' + s['sabab'])
            if s['dirasa']:
                parts.append('* دِرَاسَةُ السَّبَبِ:\n' + s['dirasa'])
            if s['natija']:
                parts.append('* النتيجة:\n' + s['natija'])
            rng = [rec['f'], rec['t']] if rec['t'] > rec['f'] else None
            ayat[key.replace(':', '_')] = {
                'parts': parts,
                'range': rng,
                'surah_wide': bool(rec.get('w')),
                'not_a_sabab': False,
            }
            n += 1
            break                          # one المحرر entry per ayah in the source
    payload = {
        'book': {'id': 460,
                 'name': 'المحرر في أسباب نزول القرآن من خلال الكتب التسعة',
                 'author': 'خالد بن سليمان المزيني'},
        'provenance': {
            'source': 'quranpedia.net book 460 (asbab-book-460.json.gz dump, sha256 76fb71b14557379cfca95583cffa7f4bb44063acfebdf939e2b1fa377f4ebb56)',
            'via': 'origin/asbab-v2:data/asbab_data.js — the clean download of the same dump, entry text verbatim',
            'retrieved': '2026-11-06',
            'selection': 'the sections «سبب النزول» و«دراسة السبب» و«النتيجة» are carried verbatim; grades are re-derived here from «النتيجة»',
        },
        'ayat': ayat,
    }
    with open(OUT + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=0)
        f.flush()
        os.fsync(f.fileno())
    os.replace(OUT + '.tmp', OUT)
    graded = {}
    for k, v in ayat.items():
        g, _ = grade_of([p for p in v['parts'] if p.startswith('* النتيجة')][0].split(':', 1)[1])
        graded[g] = graded.get(g, 0) + 1
    print('import460: %d المحرر entries from %d source ayahs -> %s'
          % (n, len(data['a']), os.path.relpath(OUT, HERE)))
    print('import460: grades', graded)


if __name__ == '__main__':
    main()
