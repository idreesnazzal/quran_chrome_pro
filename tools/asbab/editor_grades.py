"""حكم المحقق: attach the verdicts of the modern editor of الواحدي to the cards.

الواحدي himself does not grade his narrations ('لم يُحكم عليه' stays his verdict). The
edition's footnotes do: «إسناده ضعيف بسبب عطية», «وسنده صحيح». Each footnote was read once
(curation/editor_grades.json, keyed by the sha1 of its diacritic-free text) and gives
  g    the editor's conclusion on that narration, or null
  q    his own words for it, verbatim from the footnote, at most 15 words
  src  'البخاري' / 'مسلم' / 'البخاري ومسلم' when the footnote says the narration is there
This step runs after merge.py and adds them as v['ed'] on the الواحدي verdict of the card
that prints the footnote. It never changes the book's own grade.

usage: python3 editor_grades.py            (rewrites data/asbab_data.js atomically, bumps sw.js)
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
GRADES = os.path.join(HERE, 'curation', 'editor_grades.json')

DIA = re.compile('[ً-ْٰـ]')
FN = re.compile(r'^\s*\(([٠-٩0-9]+)\)\s*-?\s*')
LABELS = ('صحيح', 'حسن', 'صحيح لغيره', 'حسن لغيره', 'ضعيف', 'ضعيف جدًا', 'مرسل', 'موضوع')


def plain(s):
    return DIA.sub('', s)


def ratio(s):
    letters = len(re.findall('[ء-ي]', s)) or 1
    return len(DIA.findall(s)) / letters


def is_note(p):
    """An editor's footnote: «(n) - …» in undiacritized prose, not الواحدي's own text."""
    m = FN.match(p)
    if not m:
        return False
    body = p[m.end():]
    return ratio(body) < 0.15 and not re.match(r'\s*(قوله|وقال|قال|أخبرنا|حدثنا|نزلت|روى)', plain(body))


def notes(parts):
    """The footnotes in a text block; a footnote may run on over the next plain paragraphs."""
    out, cur = [], None
    for p in parts:
        if is_note(p):
            cur = [p]
            out.append(cur)
        elif cur is not None and ratio(p) < 0.15 and not FN.match(p):
            cur.append(p)
        else:
            cur = None
    return [' '.join(x) for x in out]


def key(note):
    return hashlib.sha1(plain(note).strip().encode('utf-8')).hexdigest()[:12]


def main():
    grades = json.load(open(GRADES, encoding='utf-8'))
    src = open(OUT, encoding='utf-8').read()
    head = src[:src.index('{')]
    payload = json.loads(src[src.index('{'):src.rindex('}') + 1])
    seen, unread, attached, cards_with = set(), 0, 0, 0
    for c in payload['cards']:
        own = [v for v in c.get('v') or [] if str(v.get('b')) == '2919']
        if not own:
            continue
        own[0].pop('ed', None)
        ed = []
        for t in c.get('t') or []:
            if str(t.get('b')) != '2919':
                continue
            for n in notes(t.get('t') or []):
                k = key(n)
                seen.add(k)
                r = grades.get(k)
                if r is None:
                    unread += 1
                    continue
                if not (r.get('g') or r.get('src')):
                    continue
                row = {'g': r.get('g'), 'q': r.get('q') or '', 'src': r.get('src')}
                if row not in ed:
                    ed.append(row)
        if ed:
            own[0]['ed'] = ed
            attached += len(ed)
            cards_with += 1
    if unread:
        raise SystemExit('editor_grades: %d footnotes have no reading in curation/editor_grades.json' % unread)

    body = head + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
    if body != src:
        tmp = OUT + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, OUT)
        sw = open(SW, encoding='utf-8').read()
        m = re.search(r"const VERSION = 'mushaf-v(\d+)';", sw)
        if m:
            with open(SW + '.tmp', 'w', encoding='utf-8', newline='') as f:
                f.write(sw.replace(m.group(0), "const VERSION = 'mushaf-v%d';" % (int(m.group(1)) + 1)))
            os.replace(SW + '.tmp', SW)
    print('editor_grades: %d footnotes read, %d verdicts on %d cards%s'
          % (len(seen), attached, cards_with, '' if body != src else ' (unchanged)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
