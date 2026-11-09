#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""التحقّق من كل سبب نزول ومطابقته على الآية الصحيحة — tools/asbab/align.py

The publisher stores each book as an object keyed by "<sura>_<aya>", and scraped
data of this kind has had offsets before. Every key is re-checked against the
real ayah text in data/quran_data.js:

  1. the verse the book quotes at the head of the entry («قوله تعالى: {...} {٧٠}»)
     is located in the mushaf by its longest run of words; the number the book
     prints («{٧٠}», «الآية {٧٠}») settles the cases where two ayat open alike
     (5:11 and 33:9, 2:234 and 2:240);
  2. a key that is not an ayah at all (2230_76), or that holds a neighbour's
     words (2_2 quoting 2:6), follows the text — the printed number wins, then
     the ayah that carries the longest run of the quoted words;
  3. an entry that quotes no verse (a chapter heading) stays on its key when the
     key is a real ayah, and is only flagged;
  4. when the scrape repeated one entry on several ayat (a range in the book),
     the parts are kept once and the span becomes the entry's range; a range the
     book itself prints («الآيات {١١ - ٢٠}») is used when present.

Nothing is deleted silently: every move, merge and drop is written to
tools/asbab/aligned/align_report.json with its reason. Hand decisions live in
tools/asbab/curation/align_fixes.json (key -> {action, to, reason, range,
surah_wide, not_a_sabab}) and win over the automatic verdict.

Output:
  tools/asbab/aligned/asbab_2919.json   {"book": {...}, "ayat": {key: entry}}
  tools/asbab/aligned/align_report.json
"""
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(HERE, 'raw')
ALIGNED = os.path.join(HERE, 'aligned')
CURATION = os.path.join(HERE, 'curation')

TASHKEEL = re.compile(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]')
AR_DIGITS = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')


def norm(s):
    """Normalise Arabic for comparison only — never for display."""
    s = unicodedata.normalize('NFKC', s)
    s = TASHKEEL.sub('', s)
    s = (s.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ٱ', 'ا')
          .replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي'))
    s = s.translate(AR_DIGITS)
    s = re.sub(r'[^\u0621-\u064a0-9 ]+', ' ', s)
    # Uthmani spelling writes a final ة as ت (نعمت، رحمت): make the two sides agree
    s = ' '.join(w[:-1] + 'ه' if len(w) > 2 and w.endswith('ت') else w for w in s.split())
    return re.sub(r'\s+', ' ', s).strip()


def strip_tags(html):
    html = re.sub(r'<br\s*/?>', '\n', html)
    out = []
    for p in re.split(r'</p>\s*', html):
        t = re.sub(r'<[^>]+>', ' ', p)
        t = t.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
        t = re.sub(r'[ \t]+', ' ', t).strip()
        if t:
            out.append(t)
    return out


def load_quran():
    src = open(os.path.join(ROOT, 'data', 'quran_data.js'), encoding='utf-8').read()
    data = json.loads(src[src.index('=') + 1:].strip().rstrip(';'))
    ayah, order = {}, {}
    for a in data['ayahs']:
        k = '%d_%d' % (a[0], a[1])
        ayah[k] = a[4]
        order.setdefault(a[0], []).append(a[1])
    return data, ayah, order


def quoted_verse(text):
    """The verse words printed at the head of the entry ('' when there are none)."""
    head = text[:900]
    m = re.search(r'[﴿{]([^﴾}]{4,220})[﴾}]', head)               # {…} or ﴿…﴾
    if not m:
        m = re.search(r'(?:و?قوله|وقوله)\s*(?:-?\s*عز\s*وجل\s*-?\s*)?[^\n:]{0,16}:\s*([^\.\[]{6,200})', head)
    q = m.group(1) if m else ''
    q = re.sub(r'\[[^\]]*\]|\([^)]*\)', ' ', q)
    return q.strip()


def claims(text):
    """Ayah numbers the book prints for its verse, in order: «{٧٠}», «الآية {٧٦}»."""
    head = text[:400].translate(AR_DIGITS)
    out = []
    out += [int(x) for x in re.findall(r'الآي[ةه][^0-9]{0,14}?([0-9]{1,3})', head)]
    out += [int(x) for x in re.findall(r'[﴾}]\s*[{\[]?\s*([0-9]{1,3})\s*[}\]]?\s*[\.\n\[]', head)]
    out += [int(x) for x in re.findall(r'﴿[^﴾]{4,220}﴾\s*[{\[]?([0-9]{1,3})', head)]
    seen = []
    for n in out:
        if n and n not in seen:
            seen.append(n)
    return seen


def printed_range(text):
    """«{١١ - ٢٠}» → (11, 20): the verses the sabab covers, as the book prints it."""
    head = text[:400].translate(AR_DIGITS)
    m = re.search(r'[﴾}{]\s*([0-9]{1,3})\s*[-–]\s*([0-9]{1,3})\s*[}\]）)]?\s*[\.\n\[]', head)
    if m:
        a1, a2 = int(m.group(1)), int(m.group(2))
        if 0 < a1 < a2:
            return a1, a2
    return None


def main():
    os.makedirs(ALIGNED, exist_ok=True)
    os.makedirs(CURATION, exist_ok=True)
    fixes_path = os.path.join(CURATION, 'align_fixes.json')
    fixes = json.load(open(fixes_path, encoding='utf-8')) if os.path.exists(fixes_path) else {}

    raw = json.load(open(os.path.join(RAW, 'asbab-book-2919.json'), encoding='utf-8'))
    quran, ayah, order = load_quran()
    toks = {k: norm(v).split() for k, v in ayah.items()}
    flat = {k: ' ' + ' '.join(v) + ' ' for k, v in toks.items()}

    def longest_run(qwords, key):
        """How many words of the quote run contiguously inside this ayah."""
        t = flat[key]
        for n in range(min(len(qwords), 14), 1, -1):
            if ' ' + ' '.join(qwords[:n]) + ' ' in t:
                return n
        return 0

    def score_quote(quote):
        w = norm(quote).split()
        if len(w) < 4:
            return {}
        stem = ' ' + ' '.join(w[:4]) + ' '
        hits = [k for k, t in flat.items() if stem in t]
        return {k: longest_run(w, k) for k in hits}

    out = {}
    report = {'book': raw['book'], 'moves': [], 'repeats': [], 'drops': [],
              'kept_without_quote': [], 'ambiguous': [], 'ranges': [], 'kept': 0}
    raw_text = {k: v for k, v in raw['ayat'].items()}

    for key, html in sorted(raw['ayat'].items(), key=lambda kv: (int(kv[0].split('_')[0]), int(kv[0].split('_')[1]))):
        parts = strip_tags(html)
        text = ' '.join(parts)
        s_key = int(key.split('_')[0])
        quote = quoted_verse(text)
        # footnotes («(١) سورة الزخرف: الآية ٣١») print other surahs' ayah numbers: never read them as claims
        body = re.split(r'\(\s*[\u0660-\u0669]{1,2}\s*\)\s*(?:سورة|البقرة|آل|التوبة|الأنفال)', text)[0]
        claim = claims(body)
        target, reason, kind = key, None, None

        fix = fixes.get(key, {})
        if fix.get('action') == 'drop':
            report['drops'].append({'key': key, 'reason': fix.get('reason', 'curated drop')})
            continue

        scores = score_quote(quote) if quote else {}
        scores.pop(key, None)
        best = max(scores, key=lambda k: (scores[k], k == key)) if scores else None

        if fix.get('action') == 'move':
            target, reason, kind = fix['to'], fix.get('reason', 'curated move'), 'offset'
        elif claim and key in ayah and '%d_%d' % (s_key, claim[0]) in ayah:
            want = '%d_%d' % (s_key, claim[0])
            if want == key:
                if best and scores[best] >= 6:
                    report['ambiguous'].append({'key': key, 'other': best,
                                                'reason': 'the book prints this ayah number but quotes words shared with %s' % best})
            else:
                target, reason, kind = want, 'the book prints its ayah number as %d' % claim[0], 'offset'
        elif best and scores[best] >= 5 and (key not in ayah or scores[best] > longest_run(norm(quote).split(), key) + 1):
            target, kind = best, 'offset'
            s_t, a_t = (int(x) for x in best.split('_'))
            reason = 'the entry quotes the words of %d:%d (%d words)' % (s_t, a_t, scores[best])
            if s_t != s_key:
                reason += '; its key names sura %d' % s_key
        elif key not in ayah:
            report['drops'].append({'key': key,
                                    'reason': 'not an ayah of this mushaf, and no verse can be located from its text'})
            continue

        if target != key:
            same = raw_text.get(target) == raw_text.get(key)
            if same:
                report['repeats'].append({'from': key, 'to': target,
                                          'reason': 'the same entry is scraped on every ayah of the span'})
            else:
                report['moves'].append({'from': key, 'to': target, 'reason': reason})
        elif key in ayah and not quote:
            report['kept_without_quote'].append(key)

        rec = out.get(target)
        if rec is not None:
            if text.strip() == rec['_text'].strip():
                rec['_keys'].append(key)                    # same span: remember the ayah it also covers
                continue                                    # (already logged as a repeat above)
            rec['_keys'].append(key)
            for p in parts:
                if p not in rec['parts']:
                    rec['parts'].append(p)
            report['repeats'].append({'from': key, 'to': target,
                                      'reason': 'a second fragment of the same entry, kept in order'})
            continue

        rng = printed_range(text)
        a_t = int(target.split('_')[1])
        if rng and not (rng[0] <= a_t <= rng[1]):
            rng = None
        out[target] = {'parts': parts, 'range': list(rng) if rng else None,
                       'surah_wide': False, 'not_a_sabab': False, '_text': text, '_keys': [key]}

    # the scrape may repeat one entry on every ayah of a span under keys the header
    # cannot correct (74:11-24 arrived 14 times): collapse identical texts once
    seen_txt, dup = {}, []
    for tgt in sorted(out, key=lambda k: (int(k.split('_')[0]), int(k.split('_')[1]))):
        rec = out[tgt]
        # a shared text stays one entry per surah: collapsing across surahs would
        # hide the sabab from the ayahs of the other surah (107:1 and 108:1-2, 113/114)
        sig = (int(tgt.split('_')[0]), ' '.join(rec['parts']).strip())
        if sig in seen_txt:
            keep = seen_txt[sig]
            out[keep]['_keys'].extend(rec['_keys'])
            dup.append({'from': tgt, 'to': keep,
                        'reason': 'the same entry is scraped on every ayah of the span'})
            del out[tgt]
        else:
            seen_txt[sig] = tgt
    for d in dup:
        report['repeats'].append({'from': d['from'], 'to': d['to'], 'reason': d['reason']})

    for tgt, rec in out.items():
        s_t = int(tgt.split('_')[0])
        own = [int(k.split('_')[1]) for k in rec['_keys'] if int(k.split('_')[0]) == s_t]
        if rec['range'] is None and len(own) > 1 and max(own) - min(own) <= 40:
            rec['range'] = [min(own), max(own)]
        if rec['range']:
            first, last = rec['range']
            if not (first <= int(tgt.split('_')[1]) <= last):
                rec['range'] = None
            else:
                report['ranges'].append({'key': tgt, 'range': rec['range']})
                if first == 1 and last >= max(order.get(s_t, [1])) - 1 and last > 3:
                    rec['surah_wide'] = True
        if rec['range'] and len(rec['range']) == 2 and rec['range'][1] > max(order.get(s_t, [1])):
            rec['range'][1] = max(order.get(s_t, [1]))

    for key, fix in fixes.items():
        tgt = fix.get('to', key)
        if tgt in out:
            for f in ('range', 'surah_wide', 'not_a_sabab', 'note'):
                if f in fix:
                    out[tgt][f] = fix[f]

    # ---- entries the old build had and the 501-key scrape lost, plus the spans the
    # publisher repeated (curation/restore.json records every decision and its reason)
    restored = json.load(open(os.path.join(RAW, 'asbab-restored-2919.json'), encoding='utf-8')) \
        if os.path.exists(os.path.join(RAW, 'asbab-restored-2919.json')) else {'ayat': {}}
    for key, rec in restored.get('ayat', {}).items():
        if key not in ayah:
            raise SystemExit('restore 2919: %s is not a real ayah' % key)
        if key in out:
            continue
        out[key] = {'parts': rec['parts'], 'range': rec.get('range'),
                    'surah_wide': False, 'not_a_sabab': False}

    # ---- every entry is cut at its own «قوله تعالى: {…} {N}» headers: one section,
    # one ayah, one range (see split_sections.py). A range is never inherited from a
    # block that carries several sections.
    from split_sections import split_entry
    last_ayah = {}
    for k in ayah:
        s0, a0 = (int(x) for x in k.split('_'))
        last_ayah[s0] = max(last_ayah.get(s0, 0), a0)
    report['splits'] = []
    report['ranges'] = []
    new_out = {}
    for key in sorted(out, key=lambda k: (int(k.split('_')[0]), int(k.split('_')[1]))):
        rec = out[key]
        for tgt, piece in split_entry(key, rec, ayah, norm, last_ayah):
            if tgt != key:
                report['splits'].append({'from': key, 'to': tgt,
                                         'why': 'the block carries a second «قوله تعالى» header'})
            if tgt in new_out:                       # a restored entry already sits here
                for p in piece['parts']:
                    if p not in new_out[tgt]['parts']:
                        new_out[tgt]['parts'].append(p)
                if piece.get('range') and not new_out[tgt].get('range'):
                    new_out[tgt]['range'] = piece['range']
            else:
                new_out[tgt] = piece
    out = new_out
    for key, rec in out.items():
        if rec.get('range'):
            report['ranges'].append({'key': key, 'range': rec['range']})

    for rec in out.values():
        rec.pop('_text', None)
        rec.pop('_keys', None)
    report['kept'] = len(out)
    json.dump({'book': raw['book'], 'provenance': raw.get('provenance', {}), 'ayat': out},
              open(os.path.join(ALIGNED, 'asbab_2919.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=0)
    json.dump({'book': raw['book'], 'provenance': raw.get('provenance', {}), **report},
              open(os.path.join(ALIGNED, 'align_report.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('align: %d ayahs kept | %d moves | %d repeated-span keys | %d drops | %d without a quoted verse | %d ambiguous | %d ranges'
          % (len(out), len(report['moves']), len(report['repeats']), len(report['drops']),
             len(report['kept_without_quote']), len(report['ambiguous']), len(report['ranges'])))
    for mv in report['moves']:
        print('  move %s -> %s : %s' % (mv['from'], mv['to'], mv['reason']))
    for dp in report['drops']:
        print('  drop %s : %s' % (dp['key'], dp['reason']))
    for am in report['ambiguous']:
        print('  ambiguous %s (also %s) : %s' % (am['key'], am['other'], am['reason']))
    return 0


def align_460():
    """Book 460 arrives per ayah from the publisher's index, so its keys need no
    relocation — only a proof that each key is a real ayah of this mushaf."""
    path = os.path.join(RAW, 'asbab-book-460.json')
    if not os.path.exists(path):
        print('align 460: no raw file')
        return 0
    raw = json.load(open(path, encoding='utf-8'))
    quran, ayah, order = load_quran()
    out = {}
    rest_path = os.path.join(RAW, 'asbab-restored-460.json')
    restored = json.load(open(rest_path, encoding='utf-8'))['ayat'] if os.path.exists(rest_path) else {}
    for key, rec in list(raw['ayat'].items()) + list(restored.items()):
        if key not in ayah:
            raise SystemExit('460: %s is not a real ayah' % key)
        out[key] = {'parts': rec['parts'], 'range': rec.get('range'),
                    'surah_wide': rec.get('surah_wide', False),
                    'not_a_sabab': rec.get('not_a_sabab', False)}
    json.dump({'book': raw['book'], 'provenance': raw.get('provenance', {}), 'ayat': out},
              open(os.path.join(ALIGNED, 'asbab_460.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=0)
    print('align 460: %d ayahs kept' % len(out))
    return 0


if __name__ == '__main__':
    rc = main()
    align_460()
    sys.exit(rc)
