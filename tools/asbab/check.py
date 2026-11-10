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
ED_LABELS = ('صحيح', 'حسن', 'صحيح لغيره', 'حسن لغيره', 'ضعيف', 'ضعيف جدًا', 'مرسل', 'موضوع', None)
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


AR2ASCII = {ord(a): ord(b) for a, b in zip('٠١٢٣٤٥٦٧٨٩', '0123456789')}

ISNAD_WORDS = set("""حدثنا أخبرنا أنبأنا ثنا نا قال قالت قالا عن بن ابن أبي أبو عبد الرحمن
رسول الله صلى عليه وسلم رضي عنهما عنه عنها رواه أخرجه الحاكم البخاري مسلم الترمذي
النسائي أبو داود ابن ماجه أحمد الطبراني البيهقي عبد الرزاق معمر الزهري سعيد جابر
أنس عائشة ابن عباس عمر علي""".split())


QU = None


def lexicon_words():
    """Every word of the mushaf — a shared Quranic phrase is not a shared story."""
    global QU
    if QU is None:
        QU = set()
        _data, ayah_txt, _verses = load_quran()
        for t in ayah_txt.values():
            QU |= set(norm(t).split())
    return QU


def story_words(text, qwords):
    """The words of a narration that are neither Quran nor isnad."""
    out = []
    for w in norm(text).split():
        if len(w) < 3 or w in ISNAD_WORDS or w in qwords:
            continue
        out.append(w)
    return out


def same_story(ca, cb, qwords=None, n=8):
    if qwords is None:
        qwords = set(lexicon_words())
    best = 0
    for ta in ca.get('t') or []:
        for tb in cb.get('t') or []:
            wa = story_words(' '.join(ta['t']), qwords)
            wb = story_words(' '.join(tb['t']), qwords)
            ga = {' '.join(wa[i:i + n]) for i in range(max(0, len(wa) - n + 1))}
            gb = {' '.join(wb[i:i + n]) for i in range(max(0, len(wb) - n + 1))}
            if ga & gb:
                best = max(best, n)
    return best


# one spelling for the helper, whichever casing the caller uses
same_STORY = same_story


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

    # 5. the built payload: cards, verdicts, references and groupings
    data_path = os.path.join(ROOT, 'data', 'asbab_data.js')
    if os.path.exists(data_path):
        src = open(data_path, encoding='utf-8').read()
        payload = json.loads(src[src.index('{'):src.rindex('}') + 1])
        cards = payload.get('cards', [])
        full_books = set(payload.get('books', {}))
        ref_books = set(payload.get('refBooks') or {})            # verdicts only: no text at all
        seen_ayah = set()
        for i, c in enumerate(cards):
            tag = 'card %d (%s)' % (i, c.get('s', '')[:30])
            verdicts, texts = c.get('v') or [], c.get('t') or []
            if not verdicts:
                errors.append('%s: no verdict at all' % tag)
            if not texts:
                errors.append('%s: no book text (a card must rest on a full-text book)' % tag)
            if not c.get('s'):
                errors.append('%s: no summary' % tag)
            elif len(c['s'].split()) > 40:
                errors.append('%s: summary has %d words (max 40)' % (tag, len(c['s'].split())))
            seen_b = [v.get('b') for v in verdicts]
            if len(seen_b) != len(set(seen_b)):
                errors.append('%s: the same book gives two verdicts on one card' % tag)
            for v in verdicts:
                b, g = str(v.get('b')), v.get('g')
                if g not in GRADES:
                    errors.append('%s: grade %r is not one of %s' % (tag, g, '/'.join(GRADES)))
                    continue
                if b in ref_books:                                 # الاستيعاب / الصحيح المسند
                    if not v.get('ref'):
                        errors.append('%s: %s verdict without its reference' % (tag, b))
                    q = (v.get('q') or '').strip()
                    if len(q.split()) > 15:
                        errors.append('%s: %s quote is %d words (max 15, copyright)' % (tag, b, len(q.split())))
                    if v.get('t'):
                        errors.append('%s: %s carries text; reference books carry none' % (tag, b))
                    continue
                if b not in full_books:
                    errors.append('%s: verdict from unknown book %r' % (tag, b))
                    continue
                if g != 'لم يُحكم عليه' and not (v.get('e') or '').strip():
                    errors.append('%s: %s says %s with no quoted sentence' % (tag, b, g))
                # حكم المحقق (editor_grades.py): only on الواحدي, a known label, and the
                # editor's own words, verbatim from a footnote this card prints, ≤ 15 words
                if v.get('ed'):
                    if b != '2919':
                        errors.append('%s: an editor verdict on %s (only الواحدي has one)' % (tag, b))
                    own = re.sub(r'\s+', ' ', re.sub('[ً-ْٰـ]', '', ' '.join(
                        p for t in texts if str(t.get('b')) == '2919' for p in t.get('t') or [])))
                    for e in v['ed']:
                        if e.get('g') not in ED_LABELS:
                            errors.append('%s: editor label %r' % (tag, e.get('g')))
                        q = re.sub(r'\s+', ' ', e.get('q') or '').strip()
                        if e.get('g') and not q:
                            errors.append('%s: editor verdict %s without his words' % (tag, e.get('g')))
                        if len(q.split()) > 15:
                            errors.append('%s: editor quote is %d words (max 15)' % (tag, len(q.split())))
                        if q and q not in own:
                            errors.append('%s: editor quote not in the footnotes: «%s»' % (tag, q))
            for t in texts:
                if str(t.get('b')) not in full_books:
                    errors.append('%s: text from %r, which is not a full-text book' % (tag, t.get('b')))
                if not t.get('t'):
                    errors.append('%s: an empty text block' % tag)
        # (a) a card may carry at most one ayah header from outside its own span — two
        # of them means a block of several sections is still fused into one card
        for i, c in enumerate(cards):
            tag = 'card %d (%s)' % (i, c.get('s', '')[:30])
            rng = c.get('r') or None
            texts = c.get('t') or []      # this card's own texts (the old loop reused the last card's)
            outside = set()
            for t in texts:
                for part in t['t']:
                    head = part[:160]
                    if not re.search(r'قوله|قال\s+اللَّ?ه|قال\s+الله', head):
                        continue
                    for m in re.finditer(r'[\{\(﴿]([0-9٠-٩]{1,3})[\}\)﴾]', head):
                        num = int(m.group(1).translate(AR2ASCII))
                        if rng and not (rng[0] <= num <= rng[1]):
                            outside.add(num)
            if len(outside) > 1:
                errors.append('%s: %d ayah headers from outside its range (%s)'
                              % (tag, len(outside), ','.join(str(x) for x in sorted(outside))))

        # (g) every card that carries two books or more must be a reviewed one:
        # a row in curation/groups.json with same_event=true and a written reason.
        # This is what keeps a grade from sitting beside another story's summary.
        groups_path = os.path.join(HERE, 'curation', 'groups.json')
        rows = json.load(open(groups_path, encoding='utf-8'))['groups'] if os.path.exists(groups_path) else []
        extra_path = os.path.join(HERE, 'curation', 'suyuti_groups.json')     # suyuti_extra.py joins
        if os.path.exists(extra_path):
            rows = rows + json.load(open(extra_path, encoding='utf-8'))['groups']
        for i, c in enumerate(cards):
            card_books = sorted({str(t.get('b')) for t in (c.get('t') or [])})
            if len(card_books) < 2:
                continue
            keys = [k for k, ids in (payload.get('index') or {}).items() if i in ids]
            ok_row = None
            for r in rows:
                rb = sorted(set(r.get('books') or []) - {'suyuti'}) if 'suyuti' in (r.get('books') or []) else sorted(r.get('books') or [])
                cb = sorted(set(card_books) - {'suyuti'})
                if rb and cb and set(rb) != set(cb):
                    continue
                if r.get('ayah') not in keys:
                    continue
                if r.get('same_event') is not True:
                    errors.append('card %d at %s: groups.json marks it same_event=false' % (i, r.get('ayah')))
                    ok_row = r
                    break
                if not (r.get('reason') or '').strip():
                    errors.append('card %d at %s: groups.json row has no reason' % (i, r.get('ayah')))
                ok_row = r
                break
            if ok_row is None:
                errors.append('card %d (%s): %d books with no reviewed row in groups.json'
                              % (i, ','.join(card_books), len(card_books)))

        # (b) two cards on one ayah must not tell the same story — unless curation
        # has already read the pair and recorded that the stories differ
        rejected = set()
        for r in rows:
            if r.get('same_event') is False:
                rejected.add((r.get('ayah'), frozenset(set(r.get('books') or []) - {'suyuti'})))
        by_ayah = (payload.get('index') or {})
        for key, ids in by_ayah.items():
            if len(ids) < 2:
                continue
            for x in range(len(ids)):
                for y in range(x + 1, len(ids)):
                    a, b = cards[ids[x]], cards[ids[y]]
                    run = same_story(a, b)
                    both = frozenset({t.get('b') for t in (a.get('t') or []) + (b.get('t') or [])} - {'suyuti'})
                    if run and (key, both) in rejected:
                        run = 0
                    if run:
                        errors.append('index %s: cards %d and %d share %d words — one event, two cards'
                                      % (key, ids[x], ids[y], run))

        for key, ids in (payload.get('index') or {}).items():
            if key not in ayah:
                errors.append('index: %s is not a real ayah' % key)
                continue
            seen_ayah.add(key)
            s0, a0 = (int(x) for x in key.split('_'))
            for i in ids:
                if not (0 <= i < len(cards)):
                    errors.append('index: %s points at card %s, which does not exist' % (key, i))
                    continue
                c = cards[i]
                rng = c.get('r') or None
                sw = c.get('sw')
                if rng and not (rng[0] <= a0 <= rng[1]):
                    errors.append('index: %s points at a card for %s' % (key, rng))
                if not rng and not sw and cards[i] and False:
                    pass

    if errors:
        print('check: %d problem(s)' % len(errors))
        for e in errors:
            print('  ✗', e)
        return 1
    suy = 0
    suy_path = os.path.join(HERE, 'raw', 'asbab-suyuti.json')
    if os.path.exists(suy_path):
        suy = len(json.load(open(suy_path, encoding='utf-8'))['narrations'])
    print('OK — %d ayahs in الواحدي, %d in المحرر, %d narrations in السيوطي, %d summaries in %d file(s), 0 problems'
          % (len(books.get('2919', {}).get('ayat', {})), len(books.get('460', {}).get('ayat', {})),
             suy, total, len(files)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
