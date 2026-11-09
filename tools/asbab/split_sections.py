#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""تقسيم مدخل الواحدي إلى مقاطعه — tools/asbab/split_sections.py

الواحدي يبدأ كل قولٍ بترويسة «قَوْلُهُ تَعَالَى: {الآية} {N}»، وقد يحمل مدخلٌ واحد
عدة ترويسات (4:102 عسفان ثم 4:105 طعمة بن أبيرق، و2:115 ثم 2:116، و39:17 ثم 39:22).
جمعُها في مدخل واحد ينشر حديثَ آيةٍ على آياتٍ لا تخصّه، فالفاصل هنا هو الترويسة:

  * كل ترويسة تفتح مقطعًا جديدًا، وتُتبَع بحواشيها «(n) - …» حتى الترويسة التالية؛
  * رقم الآية والمدى لا يُؤخذان إلا من ترويسة المقطع نفسه، أو من لفظ الكتاب الصريح
    («إلى آخر السورة»، «إلى قوله تعالى {…}» ثم يُطابَق المقتبس على المصحف)؛
  * ومَن لم تُطابق ترويسته آيةً تبقى على مفتاح مدخلها (ولا يُخترع لها مدى).
"""
import re
import unicodedata

TASHKEEL = re.compile(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]')
AR_DIGITS = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
# a section opens at «قوله تعالى: {…}», with or without the «(١) - » in front
HEADER = re.compile(r'(?:^|(?<=[\s\.]))\(?[0-9٠-٩]{0,2}\)?\s*[-–]?\s*قوله تعالى\s*:?\s*[\{﴿]')


def bare(text):
    """Diacritics stripped, with a map back to the original index."""
    out, back = [], []
    for i, ch in enumerate(text):
        if TASHKEEL.match(ch):
            continue
        out.append(ch)
        back.append(i)
    back.append(len(text))
    return ''.join(out), back


def headers(b):
    """Header offsets in a bare string — never the «إلى قوله تعالى {…}» end quote."""
    out = []
    for m in HEADER.finditer(b):
        before = b[max(0, m.start() - 8):m.start()]
        if re.search(r'(?:^|\s)(?:إلى|الى|الي)\s*$', b[:m.start()].translate(str.maketrans('أإآٱ', 'اااا'))):
            continue
        if 'الي ' in before or 'الى ' in before or 'إلى ' in before:
            continue
        out.append(m.start())
    return out


def split_parts(parts):
    """[<p>, …] → [[<p>, …], [<p>, …]]: one list per «قوله تعالى» section."""
    sections, cur = [], []
    for p in parts:
        b, back = bare(p)
        cuts = headers(b)
        starts = [c for c in cuts if c > 0]           # a header inside the part
        if cuts and cuts[0] == 0:                     # this part opens a section
            if cur:
                sections.append(cur)
            cur = []
            cuts = cuts[1:]
        pos = 0
        for c in cuts:
            i = back[c]
            if i > pos:
                cur.append(p[pos:i])
                sections.append(cur)
                cur = []
            pos = i
        if p[pos:].strip():
            cur.append(p[pos:].strip())
    if cur:
        sections.append(cur)
    return [s for s in sections if s]


def lead_number(text):
    """(first, last) from the section's own header, or None."""
    head = bare(text)[0][:420].translate(AR_DIGITS)
    m = re.search(r'[\}﴾]\s*\{?\s*([0-9]{1,3})\s*[-–]\s*([0-9]{1,3})\s*\}?', head)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        if 0 < a <= b:
            return a, b
    m = re.search(r'الآي[ةه]\s*\{?\s*([0-9]{1,3})', head)
    if m:
        return int(m.group(1)), None
    m = re.search(r'[\}﴾]\s*\{?\s*([0-9]{1,3})\s*\}', head)
    if m:
        return int(m.group(1)), None
    m = re.search(r'[\}﴾]\s*([0-9]{1,3})\s*[\.\[]', head)
    if m:
        return int(m.group(1)), None
    return None


def end_ayah(section_text, sura, ayah_texts, norm):
    """The end of the span as the book itself words it — (last_ayah, explicit).

    Only two wordings are accepted: «إلى قوله تعالى: {…}» (the quote is matched
    against the mushaf) and the book's own numbers «الآيات {N - M}» / «الآية {N}».
    «إلى آخر السورة» is refused on purpose: it would hang one story on every rest of
    the surah — exactly the fusing this pass exists to undo.
    """
    raw = bare(section_text[:900])[0].translate(AR_DIGITS)
    m = re.search(r'(?:إلى|الى|الي)\s*قوله(?:\s*(?:تعالى|تعالي))?\s*:?\s*(?:\}|\))?\s*[\{﴿]', raw)
    if m:
        quote = norm(re.split(r'[\}﴾]', raw[m.end():])[0]).split()[:8]
        if len(quote) >= 3:
            best, score = None, 0
            for k, t in ayah_texts.items():
                if int(k.split('_')[0]) != sura:
                    continue
                for n in range(len(quote), 2, -1):
                    if ' '.join(quote[:n]) in t and n > score:
                        best, score = int(k.split('_')[1]), n
                        break
            if best:
                return best, True
    m2 = re.search(r'(?:الآيات|الايات|الآية|الايه)\s*:?\s*[\{﴿]?\s*(\d+)\s*(?:[-–—]|إلى|الى)\s*(\d+)\s*[\}﴾]?', raw)
    if m2:
        return int(m2.group(2)), True
    m3 = re.search(r'(?:الآيات|الايات|الآية|الايه)\s*:?\s*[\{﴿]\s*(\d+)\s*[\}﴾]', raw)
    if m3:
        return int(m3.group(1)), True
    return None, False


def inner_ayahs(section_text, sura, ayah_texts, norm, normfn=None):
    """Ayah numbers the section itself quotes after its first 150 characters."""
    raw = bare(section_text)[0][150:].translate(AR_DIGITS)
    found = []
    for m in re.finditer(r'قوله تعالى\s*:?\s*[\{﴿]', raw):
        if re.search(r'(?:إلى|الى|الي)\s*$', raw[:m.start()]):
            continue
        quote = norm(re.split(r'[\}﴾]', raw[m.end():])[0]).split()[:6]
        if len(quote) < 3:
            continue
        best, score = None, 0
        for k, t in ayah_texts.items():
            if int(k.split('_')[0]) != sura:
                continue
            for n in range(len(quote), 2, -1):
                if ' '.join(quote[:n]) in t:
                    if n > score:
                        best, score = int(k.split('_')[1]), n
                    break
        if best:
            found.append(best)
    return found


def split_entry(key, rec, ayah, norm, verses_last):
    """One aligned entry → [(key, rec)] after splitting it at its headers."""
    sura = int(key.split('_')[0])
    secs = split_parts(rec['parts'])
    if len(secs) < 2:
        # one section: still re-derive the range from its own header / printed wording
        text = ' '.join(rec['parts'])
        lead = lead_number(text)
        n, last = (lead if lead else (int(key.split('_')[1]), None))
        explicit = False
        if last is None:
            last, explicit = end_ayah(text, sura, {k: norm(v) for k, v in ayah.items()}, norm)
        inner = [] if explicit else inner_ayahs(text, sura, {k: norm(v) for k, v in ayah.items()}, norm)
        if inner:
            cap = min([x for x in inner if x > n] or [n])
            last = min(last, cap - 1) if last else None
        rng = [n, last] if (last and last > n) else None
        rec = dict(rec, range=rng, surah_wide=bool(rec.get('surah_wide')) and n == 1)
        return [(key, rec)]
    ayah_texts = {k: norm(v) for k, v in ayah.items()}
    out, used = [], set()
    for idx, parts in enumerate(secs):
        text = ' '.join(parts)
        lead = lead_number(text)
        # the first section belongs to the entry's own ayah even when the printed
        # header carries only «الآيات {N - M}» and no bare number
        n, last = (lead if lead else ((int(key.split('_')[1]), None) if idx == 0 else (None, None)))
        if n is None or not (1 <= n <= verses_last.get(sura, 10 ** 6)):
            tgt = key
        else:
            tgt = '%d_%d' % (sura, n)
        explicit = False
        if last is None and n is not None:
            last, explicit = end_ayah(text, sura, ayah_texts, norm)
        inner = inner_ayahs(text, sura, ayah_texts, norm) if (n is not None and not explicit) else []
        if inner:
            cap = min([x for x in inner if x > n] or [n])
            last = min(last, cap - 1) if last else None
        rng = None
        if n is not None and last and last > n:
            rng = [n, last]
        if tgt in used:                       # two sections on one ayah: keep both texts
            out[-1][1]['parts'].extend(parts)
            continue
        used.add(tgt)
        out.append((tgt, {'parts': parts, 'range': rng,
                          'surah_wide': bool(rec.get('surah_wide')) and tgt == key,
                          'not_a_sabab': rec.get('not_a_sabab', False)}))
    return out
