#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""كتابة curation/groups.json من البطاقات الحالية — tools/asbab/make_groups.py

كل بطاقة تحمل أكثر من كتاب يجب أن يكون لها سطر هنا: نفس الآية، والكتب نفسها،
وحكم مقروء (same_event) مع سببه. السطور المكتوبة بيد هي الـ٢٤ بطاقة التي تجمع
الواحدي والمحرر؛ وسطور السيوطي تُولَّد من قاعدة الصدى الحرفية (٩ كلمات متصلة)
التي ربطت الأثر بمدخله، ويبقى كل سطر قابلًا للتصحيح أو الرفض (same_event=false).

    python3 make_groups.py          # يكتب curation/groups.json
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CUR = os.path.join(HERE, 'curation')
DATA = os.path.join(ROOT, 'data', 'asbab_data.js')
TASHKEEL = re.compile(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]')

# البطاقات التي قرأتها بنفسي: الواحدي + المحرر — كلها حدث واحد بالدليل المكتوب
HAND = {
    '66_1': ('المحرر يروي خبر تحريم الجارية إرضاءً لزوجاته، والسيوطي يرويه عن أنس',
             '«كانت له أمة يطؤها فلم تزل به حفصة حتى جعلها على نفسه حرامًا»'),
    '2_158': ('قصة الأنصار وطهارة الطواف بين الصفا والمروة، رواية عائشة عن عروة',
              '«كانوا يتحرجون أن يطوفوا بين الصفا والمروة … فسألوا رسول الله ﷺ»'),
    '2_187': ('رخصة ليلة الصيام بعد تحريم النساء والطعام بعد العشاء (ابن عباس)',
              '«إذا صلوا العشاء حرم عليهم النساء والطعام … فشكوا ذلك للنبي ﷺ»'),
    '2_232': ('معقل بن يسار وأخته المطلقة ومنعها من زوجها الأول',
              '«فلا تعضلوهن أن ينكحن أزواجهن» في معقل وأخته'),
    '2_284': ('اشتداد «وإن تبدوا ما في أنفسكم» على الصحابة ونزول «آمن الرسول» (أبو هريرة)',
              '«لما أنزل {وإن تبدوا ما في أنفسكم أو تخفوه} اشتد ذلك على أصحاب رسول الله ﷺ»'),
    '3_128': ('كسر رباعية النبي ﷺ يوم أُحد وقوله: كيف يفلح قوم خضبوا وجه نبيهم (أنس)',
              '«كسرت رباعية رسول الله ﷺ يوم أُحد ودمي وجهه … فأنزل الله {ليس لك من الأمر شيء}»'),
    '3_165': ('عقوبة أُحد بأخذ الفداء يوم بدر — رواية عمر بن الخطاب',
              '«لما كان يوم أُحد من العام المقبل عوقبوا بما صنعوا يوم بدر من أخذهم الفداء»'),
    '3_188': ('المنافقون يفرحون بما أتوا ويحبون أن يُحمدوا بما لم يفعلوا',
              '«كان رجال من المنافقين إذا خرج رسول الله ﷺ إلى الغزو تخلفوا عنه»'),
    '4_43': ('شرب الخمر ثم الصلاة بلا وعي، ومن قرأ «قل يا أيها الكافرون» في المغرب',
             '«نزلت في أناس من أصحاب رسول الله ﷺ كانوا يشربون الخمر»'),
    '4_59': ('عبد الله بن حذافة في السرية وطاعة أولي الأمر — رواية ابن عباس',
             '«في عبد الله بن حذافة بن قيس … إذ بعثه رسول الله ﷺ في سرية»'),
    '4_65': ('الزبير وحاطب في شراج الماء والتحاكم إلى النبي ﷺ',
             '«نزلت في الزبير بن العوام وخصمه حاطب بن أبي بلتعة»'),
    '5_90': ('سعد بن أبي وقاص والأنصار يشربون الخمر قبل التحريم',
             '«أتيت نفرًا من المهاجرين والأنصار فقالوا: تعال نطعمك ونسقيك خمرًا»'),
    '8_67': ('استشارة النبي ﷺ في أسرى بدر: الفداء أو القتل',
             '«استشار النبي ﷺ في أسرى بدر … فنزلت {ما كان لنبي أن يكون له أسرى}»'),
    '9_19': ('سقاية الحاج وعمارة المسجد الحرام مقابل الإيمان والجهاد (النعمان بن بشير)',
             '«كنت عند منبر النبي ﷺ فذكر القوم سقاية الحاج وعمارة المسجد الحرام»'),
    '9_34': ('كنز الذهب والفضة وأبو ذر ومعاوية (زيد بن وهب)',
             '«نزلت في العلماء والقراء من أهل الكتاب … {والذين يكنزون الذهب والفضة}»'),
    '9_79': ('المنافقون يلمزون المتصدقين ويضحكون من صاحب الصاع',
             '«لما نزلت آية الصدقة كنا نحامل … فنزلت {الذين يلمزون المطوعين}»'),
    '23_76': ('أبو سفيان وكفار قريش في الجهد وشدة الحال',
              '«جاء أبو سفيان إلى النبي ﷺ فكلمه في شأن ما نزل بقومه من الجهد»'),
    '24_11': ('حديث الإفك وبراءة عائشة في الآيات ١١–٢٠',
              '«نزلت في حديث الإفك حين قال أهل الإفك في عائشة ما قالوا»'),
    '48_1': ('نزول سورة الفتح بين مكة والمدينة في شأن الحديبية (المسور ومروان)',
             '«نزلت سورة الفتح بين مكة والمدينة في شأن الحديبية من أولها إلى آخرها»'),
    '49_6': ('الوليد بن عقبة وبني المصطلق وخبر الفاسق',
             '«نزلت في الوليد بن عقبة بن أبي معيط بعثه رسول الله ﷺ إلى بني المصطلق»'),
    '58_14': ('عبد الله بن نبتل الأزرق و«ينظر بعين شيطان» ورفع الحديث إلى اليهود',
              '«يدخل عليكم الآن رجل قلبه قلب جبار وينظر بعيني شيطان … وكان أزرق»'),
    '60_1': ('حاطب بن أبي بلتعة وكتابه إلى أهل مكة',
             '«نزلت في حاطب بن أبي بلتعة … أتت سارة مولاة أبي عمرو بن صيفي»'),
    '74_1': ('فترة الوحي و«زملوني فدثروني» ثم {يا أيها المدثر}',
             '«جاورت بحراء شهرًا … فقلت: زملوني فدثروني، فأنزل الله {يا أيها المدثر}»'),
    '111_1': ('الصفا و«يا صباحاه» وقول أبي لهب «تبًّا لك»',
              '«صعد رسول الله ﷺ الصفا فقال: يا صباحاه … فقال أبو لهب: تبًّا لك»'),
}


def norm(s):
    s = TASHKEEL.sub('', s)
    return re.sub(r'\s+', ' ', s).strip()


def main():
    src = open(DATA, encoding='utf-8').read()
    data = json.loads(src[src.index('{'):src.rindex('}') + 1])
    cards, index = data['cards'], data['index']
    # rows already written by hand are never overwritten — only missing ones are added
    old = {}
    try:
        for r in json.load(open(os.path.join(CUR, 'groups.json'), encoding='utf-8'))['groups']:
            old[(r['ayah'], tuple(sorted(r['books'])))] = r
    except FileNotFoundError:
        pass
    # a rejection is final: it wins over any older row for the same pair
    rej = set()
    try:
        rej = {(r['ayah'], tuple(sorted(set(r['books']) - {'suyuti'})))
               for r in json.load(open(os.path.join(CUR, 'rejected.json'), encoding='utf-8'))['pairs']}
    except FileNotFoundError:
        pass
    rows, seen = [], set()
    for i, c in enumerate(cards):
        books = sorted({t['b'] for t in c['t']})
        if len(books) < 2:
            continue
        keys = [k for k, v in index.items() if i in v]
        first = min(keys, key=lambda k: (int(k.split('_')[0]), int(k.split('_')[1])))
        sig = (first, tuple(books))
        if sig in seen:
            continue
        seen.add(sig)
        if (first, tuple(books)) in old and (first, tuple(sorted(set(books) - {'suyuti'}))) not in rej:
            rows.append(old[(first, tuple(books))])
            continue
        if first in HAND:
            reason, ev = HAND[first]
            rows.append({'ayah': first, 'books': books, 'same_event': True,
                         'reason': reason, 'evidence': ev, 'source': 'read'})
        elif 'suyuti' in books:
            host = [b for b in books if b != 'suyuti']
            rows.append({'ayah': first, 'books': books, 'same_event': True,
                         'reason': 'أثر السيوطي يردّد ألفاظ مدخل %s حرفيًّا (٩ كلمات متصلة)'
                                   % ('، '.join(host) or 'الكتاب'),
                         'source': 'echo'})
        else:
            rows.append({'ayah': first, 'books': books, 'same_event': False,
                         'reason': 'لم يُقرأ بعد — يحتاج مراجعة قبل الدمج', 'source': 'unreviewed'})
    rows = [r for r in rows
            if (r['ayah'], tuple(sorted(set(r['books']) - {'suyuti'}))) not in rej]

    # the rejected pairs stay documented even while the two cards are apart
    try:
        for r in json.load(open(os.path.join(CUR, 'rejected.json'), encoding='utf-8'))['pairs']:
            key = (r['ayah'], tuple(sorted(r['books'])))
            if key not in {(x['ayah'], tuple(sorted(x['books']))) for x in rows}:
                rows.append(dict(r))
    except FileNotFoundError:
        pass

    # a hand-written rejection stays in the file even when the two cards are apart
    kept = {(r['ayah'], tuple(sorted(r['books']))) for r in rows}
    for key, r in old.items():
        if key not in kept and (r['ayah'], tuple(sorted(set(r['books']) - {'suyuti'}))) not in rej:
            rows.append(r)
    rows.sort(key=lambda r: (int(r['ayah'].split('_')[0]), int(r['ayah'].split('_')[1]),
                             ','.join(r['books'])))
    payload = {'note': 'سطر لكل بطاقة تجمع كتابين أو أكثر: نفس الآية، والكتب نفسها، '
                       'وحكم مقروء (same_event) مع سببه؛ والرفض (false) يمنع الدمج.',
               'groups': rows}
    tmp = os.path.join(CUR, 'groups.json.tmp')
    json.dump(payload, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(CUR, 'groups.json'))
    read = sum(1 for r in rows if r['source'] == 'read')
    echo = sum(1 for r in rows if r['source'] == 'echo')
    other = len(rows) - read - echo
    print('groups.json: %d rows — %d read, %d echo, %d unreviewed' % (len(rows), read, echo, other))


if __name__ == '__main__':
    main()
