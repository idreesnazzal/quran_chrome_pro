#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""فاحص الملخّصات والدرجات — tools/asbab/check.py

Run it until it prints OK. It refuses:

  * a key that is not a real ayah of data/quran_data.js (any file in tools/asbab);
  * a summary without a source text: every summary must name a book that carries
    that ayah in tools/asbab/aligned/;
  * a summary that is not Arabic, is longer than 40 words, or carries an isnad
    (أخرج، حدثنا، أخبرنا، رواه، «عن … عن …»، «بن … عن») — the reader gets the
    story, not the chain;
  * a summary using a word that appears neither in the two books nor in the
    app's own Arabic corpus: that is how a name, a place or an event added from
    memory gets caught;
  * a grade outside صحيح / حسن / ضعيف / لم يُحكم عليه, or a grade that is not
    «لم يُحكم عليه» without the book's own sentence quoted verbatim;
  * an evidence sentence that is not found, word for word, in the book text;
  * a range that leaves its surah, or a range that does not contain the ayah the
    entry sits on;
  * a drop in the alignment report without a written reason.

Usage: python3 -I check.py [--quiet]
"""
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ALIGNED = os.path.join(HERE, 'aligned')
SUMM = os.path.join(HERE, 'summaries')
CURATION = os.path.join(HERE, 'curation')

GRADES = ('صحيح', 'حسن', 'ضعيف', 'لم يُحكم عليه')
ISNAD = re.compile(r'(أخرج|أخرجه|حدثنا|حدّثنا|حدثني|أخبرنا|أخبرني|رواه|روى|عن\s+\S+\s+عن|بن\s+\S+\s+عن)')
# book names only as whole words: «المسلمين» is not «مسلم»
ISNAD_BOOKS = re.compile(r'(?<![\u0621-\u064a])(الطبراني|البخاري|مسلم|الترمذي|أبو\s+داود|النسائي|ابن\s+ماجه|الإمام\s+أحمد)(?![\u0621-\u064a])')
TASHKEEL = re.compile(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]')
AR = re.compile(r'[\u0621-\u064a]')


def norm(s):
    s = unicodedata.normalize('NFKC', s or '')
    s = TASHKEEL.sub('', s)
    s = (s.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ٱ', 'ا')
          .replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي'))
    s = re.sub(r'[^\u0621-\u064a0-9 ]+', ' ', s)
    s = ' '.join(w[:-1] + 'ه' if len(w) > 2 and w.endswith('ت') else w for w in s.split())
    return re.sub(r'\s+', ' ', s).strip()


PREFIX = ('وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'و', 'ف', 'ب', 'ك', 'ل', 'س')
SUFFIX = ('هما', 'هم', 'ها', 'كم', 'نا', 'ون', 'ين', 'ات', 'ان', 'ه', 'ت', 'ا', 'ي', 'ن', 'م')


def stem(w):
    """Light Arabic stemming: enough to match a name or a word across its
    prefixes and pronouns, so the check speaks about words, not vowels."""
    for p in PREFIX:
        if w.startswith(p) and len(w) - len(p) >= 3:
            w = w[len(p):]
            break
    changed = True
    while changed and len(w) > 3:
        changed = False
        for suf in SUFFIX:
            if w.endswith(suf) and len(w) - len(suf) >= 3:
                w = w[:-len(suf)]
                changed = True
                break
    return w


def words(s):
    return [w for w in norm(s).split() if AR.search(w)]


def load_quran():
    src = open(os.path.join(ROOT, 'data', 'quran_data.js'), encoding='utf-8').read()
    data = json.loads(src[src.index('=') + 1:].strip().rstrip(';'))
    ayah, verses = {}, {}
    for a in data['ayahs']:
        ayah['%d_%d' % (a[0], a[1])] = a[4]
        verses.setdefault(a[0], []).append(a[1])
    return data, ayah, verses


def entry_at(book, key):
    """The entry that carries this ayah: its own, or the one whose range covers it."""
    if key in book:
        return book[key]
    s, a = (int(x) for x in key.split('_'))
    for k, rec in book.items():
        r = rec.get('range')
        if r and int(k.split('_')[0]) == s and r[0] <= a <= r[1]:
            return rec
    return None


def lexicon(data):
    """Every word the app already carries: the ayat and their tafsir."""
    out = set()
    for a in data['ayahs']:
        out.update(words(a[4]))
        out.update(words(a[5] if len(a) > 5 else ''))
    for w in (data.get('words') or {}).values():
        out.update(words(w))
    return out


def main(argv):
    quiet = '--quiet' in argv
    errors, notes = [], []

    quran, ayah, verses = load_quran()
    lex = lexicon(quran)

    books = {}
    for bid, fname in (('2919', 'asbab_2919.json'), ('460', 'asbab_460.json')):
        path = os.path.join(ALIGNED, fname)
        if not os.path.exists(path):
            errors.append('missing aligned file %s (run align.py)' % fname)
            continue
        books[bid] = json.load(open(path, encoding='utf-8'))

    # 1. every key is a real ayah; every range stays inside its surah
    for bid, data in books.items():
        for key, rec in data['ayat'].items():
            if key not in ayah:
                errors.append('%s: key %s is not a real ayah' % (bid, key))
                continue
            s, a = (int(x) for x in key.split('_'))
            rng = rec.get('range')
            if rng:
                if not (1 <= rng[0] <= rng[1] <= max(verses[s])):
                    errors.append('%s %s: range %s leaves surah %d (1..%d)' % (bid, key, rng, s, max(verses[s])))
                if not (rng[0] <= a <= rng[1]):
                    errors.append('%s %s: range %s does not contain the ayah' % (bid, key, rng))
            if not rec.get('parts'):
                errors.append('%s %s: no book text' % (bid, key))

    # 2. the alignment report must explain every drop and every move
    rep_path = os.path.join(ALIGNED, 'align_report.json')
    if os.path.exists(rep_path):
        rep = json.load(open(rep_path, encoding='utf-8'))
        for dp in rep.get('drops', []):
            if not dp.get('reason'):
                errors.append('align: drop of %s has no reason' % dp.get('key'))
        for mv in rep.get('moves', []):
            if not mv.get('reason'):
                errors.append('align: move %s -> %s has no reason' % (mv.get('from'), mv.get('to')))

    # 3. the summaries
    files = sorted(f for f in os.listdir(SUMM) if f.endswith('.jsonl'))
    seen = set()
    total = 0
    for f in files:
        for ln, line in enumerate(open(os.path.join(SUMM, f), encoding='utf-8'), 1):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            where = '%s:%d' % (f, ln)
            try:
                row = json.loads(line)
            except Exception as exc:
                errors.append('%s: not JSON (%s)' % (where, exc))
                continue
            total += 1
            key = (row.get('k', '') or '').replace(':', '_')
            bid = str(row.get('b', ''))
            s, summary = row.get('s', ''), row.get('s', '')
            if key not in ayah:
                errors.append('%s: %s is not a real ayah' % (where, key))
                continue
            if bid not in books:
                errors.append('%s: unknown book %r' % (where, bid))
                continue
            if (key, bid) in seen:
                errors.append('%s: %s already has a %s summary' % (where, key, bid))
            seen.add((key, bid))
            rec = entry_at(books[bid]['ayat'], key)              # the ayah, or the range entry covering it
            if rec is None:                                       # no source text
                errors.append('%s: %s has no text in book %s' % (where, key, bid))
                continue
            parts = rec['parts']
            booktext = ' '.join(parts)
            # Arabic only, and short
            if not summary or not AR.search(summary):
                errors.append('%s: summary is not Arabic' % where)
            if re.search(r'[A-Za-z]{3,}', summary):
                errors.append('%s: summary has latin letters' % where)
            nw = len(summary.split())
            if nw > 40:
                errors.append('%s: summary has %d words (max 40)' % (where, nw))
            # no isnad
            m = ISNAD.search(summary) or ISNAD_BOOKS.search(summary)
            if m:
                errors.append('%s: summary carries an isnad (%r)' % (where, m.group(0)))
            # a word that no book and no ayah/tafsir of the app carries
            known = {stem(w) for w in words(booktext)} | {stem(w) for w in lex}
            for w in words(summary):
                if len(w) < 3 or stem(w) in known:
                    continue
                errors.append('%s: word %r is in no book text (name or detail from outside)' % (where, w))
            # grade + evidence
            g = row.get('g', '')
            if g not in GRADES:
                errors.append('%s: grade %r is not one of %s' % (where, g, '/'.join(GRADES)))
            ev = (row.get('e') or '').strip()
            if g != 'لم يُحكم عليه':
                if not ev:
                    errors.append('%s: grade %s without the book\'s sentence' % (where, g))
                elif norm(ev) not in norm(booktext):
                    errors.append('%s: evidence is not verbatim in book %s' % (where, bid))
            elif ev and norm(ev) not in norm(booktext):
                errors.append('%s: evidence is not verbatim in book %s' % (where, bid))
            if row.get('r'):
                rng = row['r']
                s0 = int(key.split('_')[0])
                if not (1 <= rng[0] <= rng[1] <= max(verses[s0])):
                    errors.append('%s: range %s leaves surah %d' % (where, rng, s0))

    # 4. coverage claims: the ayahs told to the reader as «checked in المحرر»
    cov_path = os.path.join(CURATION, 'checked_460.json')
    if os.path.exists(cov_path):
        cov = json.load(open(cov_path, encoding='utf-8'))
        if isinstance(cov, dict):                              # {note, ayahs:[{k,…}]}
            cov = [x['k'] for x in cov.get('ayahs', [])]
        for k in cov:
            if k.replace(':', '_') not in ayah:
                errors.append('coverage: %s is not a real ayah' % k)

    if errors:
        print('check: %d problem(s)' % len(errors))
        for e in errors:
            print('  ✗', e)
        return 1
    print('OK — %d ayahs in الواحدي, %d in المحرر, %d summaries in %d file(s), 0 problems'
          % (len(books.get('2919', {}).get('ayat', {})), len(books.get('460', {}).get('ayat', {})),
             total, len(files)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
