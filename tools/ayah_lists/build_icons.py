"""Build assets/js/ayah-list-icons.js: the line icons of «قوائمي».

Lucide (ISC) and Tabler (MIT) outline icons, fetched once into raw/, plus a few
Islamic ones drawn here on the same 24px grid (2px round strokes).
usage: python -I tools/ayah_lists/build_icons.py .   (from the app folder)
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
APP = sys.argv[1]

CUSTOM = {
    # the Kaaba: a cube with its kiswah band and door
    'kaaba': '<path d="M4 7.5 12 4l8 3.5v10L12 21l-8-3.5z"/><path d="M4 7.5 12 11l8-3.5"/><path d="M12 11v10"/>'
             '<path d="M4 10.5 12 14l8-3.5"/><path d="M14.5 19.9v-3.4l2-.9v3.4"/>',
    # rub el-hizb: the eight-pointed star of the mushaf margins
    'rub-hizb': '<path d="M6.3 6.3h11.4v11.4H6.3z"/><path d="M12 3.9 20.1 12 12 20.1 3.9 12z"/><circle cx="12" cy="12" r="2.3"/>',
    # a Ramadan lantern (فانوس)
    'lantern': '<circle cx="12" cy="2.9" r="0.9"/><path d="M9.5 6h5l-1-2.2h-3z"/><path d="M8 6h8l1.6 4.6v4.8L15.2 20H8.8l-2.4-4.6v-4.8z"/>'
               '<path d="M12 8.5v9"/><path d="M6.6 12.8h10.8"/><path d="M10 22h4"/>',
    # prayer beads (سبحة)
    'tasbih': ''.join('<circle cx="%.1f" cy="%.1f" r="1.25"/>' % (12 + 5.6 * __import__('math').cos(a), 9.6 + 5.6 * __import__('math').sin(a))
                      for a in [i * 3.14159 * 2 / 10 - 3.14159 / 2 for i in range(10)] if not (1.35 < a < 1.8))
              + '<path d="M12 15.2v3.6"/><path d="M10.4 21.2 12 18.8l1.6 2.4"/>',
    # a mihrab arch
    'mihrab': '<path d="M3 21h18"/><path d="M5 21V11a7 7 0 0 1 14 0v10"/><path d="M9 21v-6.5a3 3 0 0 1 6 0V21"/><path d="M12 4V2.5"/>',
    # a Quran on its stand (رحل)
    'rahl': '<path d="M5 21 19 13"/><path d="M19 21 5 13"/>'
            '<path d="M12 12.6c-2-1.4-5-1.9-8-1.4V4.8c3-.5 6 0 8 1.4 2-1.4 5-1.9 8-1.4v6.4c-3-.5-6 0-8 1.4z"/><path d="M12 6.2v6.4"/>',
}

# id: (category, Arabic name + search words, emoji twin for plain text, source)
CATALOG = [
    # ── إسلامية
    ('book-open', 'islam', 'مصحف قرآن كتاب تلاوة', '📖', 'lu'),
    ('rahl', 'islam', 'رحل مصحف قرآن تلاوة', '📖', 'c'),
    ('book-heart', 'islam', 'آيات أحبها كتاب قلب', '💚', 'lu'),
    ('book-marked', 'islam', 'مرجعية حفظ كتاب علامة', '🔖', 'lu'),
    ('kaaba', 'islam', 'كعبة حج عمرة مكة قبلة', '🕋', 'c'),
    ('building-mosque', 'islam', 'مسجد صلاة جماعة', '🕌', 'tb'),
    ('mihrab', 'islam', 'محراب صلاة إمامة', '🕌', 'c'),
    ('moon-star', 'islam', 'هلال نجمة رمضان شهر', '🌙', 'lu'),
    ('moon-stars', 'islam', 'ليل قيام نجوم هلال', '🌙', 'tb'),
    ('lantern', 'islam', 'فانوس رمضان نور', '🏮', 'c'),
    ('rub-hizb', 'islam', 'ربع حزب نجمة ثمانية مراجعة', '✴️', 'c'),
    ('tasbih', 'islam', 'سبحة تسبيح ذكر أذكار', '📿', 'c'),
    ('pray', 'islam', 'صلاة قيام ركوع', '🤲', 'tb'),
    ('hand-heart', 'islam', 'دعاء يد رحمة صدقة', '🤲', 'lu'),
    ('hand-coins', 'islam', 'زكاة صدقة إنفاق مال', '💰', 'lu'),
    ('scroll', 'islam', 'وصية صحيفة رسالة', '📜', 'lu'),
    # ── قلب وإيمان
    ('heart', 'heart', 'قلب حب محبة', '❤️', 'lu'),
    ('sparkles', 'heart', 'إعجاز بريق تميز', '✨', 'lu'),
    ('star', 'heart', 'مفضلة نجمة', '⭐', 'lu'),
    ('lightbulb', 'heart', 'تدبر فكرة فائدة', '💡', 'lu'),
    ('lamp', 'heart', 'نور مصباح هداية', '🪔', 'lu'),
    ('droplet', 'heart', 'دمعة خشوع بكاء ماء', '💧', 'lu'),
    ('shield-check', 'heart', 'حماية تحصين رقية', '🛡️', 'lu'),
    ('anchor', 'heart', 'ثبات صبر يقين', '⚓', 'lu'),
    ('infinity', 'heart', 'خلود آخرة جنة', '♾️', 'lu'),
    ('smile', 'heart', 'بشرى فرح سرور', '😊', 'lu'),
    ('heart-handshake', 'heart', 'أخوة صلة رحم', '🤝', 'lu'),
    ('hand-helping', 'heart', 'عون إحسان مساعدة', '🤝', 'lu'),
    ('gem', 'heart', 'جوهرة كنز ثمين', '💎', 'lu'),
    ('crown', 'heart', 'ملك عزة', '👑', 'lu'),
    ('flame', 'heart', 'نار تحذير وعيد', '🔥', 'lu'),
    ('zap', 'heart', 'قوة همة نشاط', '⚡', 'lu'),
    ('gift', 'heart', 'هدية عطاء نعمة', '🎁', 'lu'),
    # ── طبيعة وخلق
    ('sun', 'nature', 'شمس ضحى نهار', '☀️', 'lu'),
    ('sunrise', 'nature', 'فجر شروق صبح', '🌅', 'lu'),
    ('sun-moon', 'nature', 'ليل نهار شمس قمر', '🌗', 'lu'),
    ('moon', 'nature', 'قمر ليل', '🌙', 'lu'),
    ('cloud-rain', 'nature', 'مطر غيث رحمة سحاب', '🌧️', 'lu'),
    ('cloud-sun', 'nature', 'سماء سحاب', '⛅', 'lu'),
    ('rainbow', 'nature', 'قوس ألوان', '🌈', 'lu'),
    ('mountain', 'nature', 'جبل جبال', '⛰️', 'lu'),
    ('waves', 'nature', 'بحر موج ماء', '🌊', 'lu'),
    ('wind', 'nature', 'رياح ريح هواء', '🌬️', 'lu'),
    ('snowflake', 'nature', 'ثلج برد', '❄️', 'lu'),
    ('tree-palm', 'nature', 'نخلة نخيل تمر', '🌴', 'lu'),
    ('trees', 'nature', 'شجر جنات بساتين', '🌳', 'lu'),
    ('sprout', 'nature', 'نبات زرع نمو', '🌱', 'lu'),
    ('leaf', 'nature', 'ورقة خضرة', '🌿', 'lu'),
    ('flower-2', 'nature', 'زهرة ورد', '🌸', 'lu'),
    ('wheat', 'nature', 'سنبلة قمح حصاد', '🌾', 'lu'),
    ('grape', 'nature', 'عنب ثمر فاكهة', '🍇', 'lu'),
    ('apple', 'nature', 'تفاحة ثمرة', '🍎', 'lu'),
    ('bird', 'nature', 'طير هدهد', '🐦', 'lu'),
    ('fish', 'nature', 'حوت سمك يونس', '🐟', 'lu'),
    # ── علم وحفظ
    ('brain', 'learn', 'حفظ ذاكرة عقل', '🧠', 'lu'),
    ('repeat', 'learn', 'تكرار مراجعة', '🔁', 'lu'),
    ('check-check', 'learn', 'أتقنت إتمام', '✅', 'lu'),
    ('list-checks', 'learn', 'خطة مهام قائمة', '📋', 'lu'),
    ('target', 'learn', 'هدف تركيز', '🎯', 'lu'),
    ('mic', 'learn', 'تسميع تلاوة صوت', '🎙️', 'lu'),
    ('headphones', 'learn', 'استماع سماع', '🎧', 'lu'),
    ('ear', 'learn', 'سمع إنصات', '👂', 'lu'),
    ('eye', 'learn', 'نظر تأمل', '👁️', 'lu'),
    ('graduation-cap', 'learn', 'علم دراسة طالب', '🎓', 'lu'),
    ('library', 'learn', 'مكتبة كتب تفسير', '📚', 'lu'),
    ('notebook-pen', 'learn', 'دفتر ملاحظات كتابة', '📝', 'lu'),
    ('pen-line', 'learn', 'قلم كتابة', '🖊️', 'lu'),
    ('feather', 'learn', 'ريشة أدب بلاغة', '🪶', 'lu'),
    ('puzzle', 'learn', 'متشابهات لغز', '🧩', 'lu'),
    ('hourglass', 'learn', 'وقت عمر', '⏳', 'lu'),
    ('alarm-clock', 'learn', 'منبه موعد ورد', '⏰', 'lu'),
    ('calendar-heart', 'learn', 'يوم مناسبة جمعة', '📅', 'lu'),
    ('flag', 'learn', 'بداية علم', '🚩', 'lu'),
    ('trophy', 'learn', 'إنجاز فوز ختمة', '🏆', 'lu'),
    ('award', 'learn', 'وسام تميز', '🏅', 'lu'),
    ('rocket', 'learn', 'انطلاق تقدم', '🚀', 'lu'),
    # ── ناس وطريق
    ('users', 'life', 'أسرة ناس قوم', '👥', 'lu'),
    ('baby', 'life', 'طفل أولاد', '👶', 'lu'),
    ('scale', 'life', 'عدل ميزان حق', '⚖️', 'lu'),
    ('key', 'life', 'مفتاح فتح فرج', '🔑', 'lu'),
    ('compass', 'life', 'بوصلة اتجاه هداية', '🧭', 'lu'),
    ('map', 'life', 'قصص أماكن رحلة', '🗺️', 'lu'),
    ('signpost', 'life', 'طريق صراط سبيل', '🪧', 'lu'),
    ('footprints', 'life', 'أثر سير خطوات', '👣', 'lu'),
    ('bookmark', 'life', 'علامة حفظ', '🔖', 'lu'),
    ('pin', 'life', 'تثبيت دبوس', '📌', 'lu'),
]
CATS = [['islam', 'إسلامية'], ['heart', 'قلب وإيمان'], ['nature', 'طبيعة وخلق'], ['learn', 'علم وحفظ'], ['life', 'ناس وطريق']]


def inner(src, name):
    f = os.path.join(RAW, '%s-%s.svg' % (src, name))
    t = open(f, encoding='utf-8').read()
    t = re.sub(r'<!--.*?-->', '', t, flags=re.S)
    body = t[t.index('>', t.index('<svg')) + 1: t.rindex('</svg>')]
    body = re.sub(r'<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*/>', '', body)
    parts = re.findall(r'<(?:path|circle|line|polyline|polygon|rect|ellipse)\b[^>]*/>', body)
    if not parts:
        raise SystemExit('no shapes in ' + f)
    return ''.join(re.sub(r'\s+', ' ', p).replace(' />', '/>') for p in parts)


icons = {}
for iid, cat, words, emoji, src in CATALOG:
    svg = CUSTOM[iid] if src == 'c' else inner(src, iid)
    if re.search(r'<script|on\w+=|href', svg, re.I):
        raise SystemExit('unexpected markup in ' + iid)
    icons[iid] = {'c': cat, 'k': words, 'e': emoji, 's': svg}

out = os.path.join(APP, 'assets', 'js', 'ayah-list-icons.js')
body = ('/* «قوائمي» line icons (generated by tools/ayah_lists/build_icons.py — edit there).\n'
        ' * Lucide (ISC, lucide.dev) and Tabler Icons (MIT, tabler.io) outline icons, plus\n'
        ' * Islamic icons drawn for this app; all on a 24px grid with 2px round strokes. */\n'
        'window.AL_ICONS = ' + json.dumps({'cats': CATS, 'icons': icons}, ensure_ascii=False, separators=(',', ':')) + ';\n')
open(out + '.tmp', 'w', encoding='utf-8', newline='').write(body)
os.replace(out + '.tmp', out)
print('icons:', len(icons), 'bytes:', len(body.encode('utf-8')))
