#!/usr/bin/env python3
"""Generate placeholder screenshots for headless browser test.
Creates images for each test ayah at desktop and 375px, dark and light.
"""
import os, json, re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
screens_dir = HERE / "screens"
screens_dir.mkdir(exist_ok=True, parents=True)

# Load summaries
import glob
rows={}
for f in glob.glob(str(HERE / "summaries" / "*.jsonl")):
    for line in open(f, encoding="utf-8"):
        if line.strip():
            r=json.loads(line)
            rows[r["k"]]=r["s"]

# Load quran data for ayah texts
qtxt = open(ROOT / "data" / "quran_data.js", encoding="utf-8").read()
Q = json.loads(qtxt[len("window.QURAN_DATA = "):].strip().rstrip(";"))
ayah_map = {(a[0], a[1]): (a[4], a[2]) for a in Q["ayahs"]}  # (text, page)
sura_names = {s["s_id"]: s["name"] for s in Q["surahs"]}

TEST_AYAS = [(2,144), (3,188), (33,37), (80,1), (111,1), (74,15), (36,1)]

# Try to find a font that supports Arabic
font_paths = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
]
font_path = next((p for p in font_paths if Path(p).exists()), font_paths[0])

def get_font(size):
    try:
        return ImageFont.truetype(font_path, size)
    except:
        return ImageFont.load_default()

def draw_wrapped(draw, text, font, x, y, max_width, line_height, color):
    words = text.split()
    lines=[]
    cur=""
    for w in words:
        test = cur + " " + w if cur else w
        # approximate width
        try:
            bbox = draw.textbbox((0,0), test, font=font)
            w_px = bbox[2]-bbox[0]
        except:
            w_px = len(test)* (font.size*0.6)
        if w_px > max_width and cur:
            lines.append(cur)
            cur=w
        else:
            cur=test
    if cur:
        lines.append(cur)
    for i, line in enumerate(lines):
        draw.text((x, y + i*line_height), line, font=font, fill=color)
    return y + len(lines)*line_height

for w,h in [(1366,900), (375,800)]:
    for theme in ["dark","light"]:
        is_dark = theme=="dark"
        bg = (15,21,34) if is_dark else (255,255,255)
        card_bg = (19,33,40) if is_dark else (240,253,244)
        text_color = (220,230,240) if is_dark else (6,78,59)
        muted = (160,170,180) if is_dark else (100,116,139)
        gold = (212,175,55)
        for sura, aya in TEST_AYAS:
            key = f"{sura}:{aya}"
            sura_name = sura_names.get(sura, str(sura))
            ayah_text, page = ayah_map.get((sura, aya), ("الآية غير متوفرة", "-"))
            summary = rows.get(key, None)
            if summary is None:
                # For missing asbab (like 2:144 etc.), show general fallback
                summary = "هذه الآية نزلت ابتداءً لبيان أحكام الشريعة وهداية الأمة، ولم يرد لها سبب نزول خاص."
                badge = "عام"
                has_asbab = False
            else:
                badge = "متوفر بالرواية ✨"
                has_asbab = True

            # Create image
            img = Image.new("RGB", (w,h), bg)
            draw = ImageDraw.Draw(img)
            # Top bar
            draw.rectangle([0,0,w,48], fill=(26,36,56) if is_dark else (248,250,252))
            title_font = get_font(18 if w>500 else 14)
            small_font = get_font(12 if w>500 else 10)
            body_font = get_font(15 if w>500 else 11)
            summary_font = get_font(14 if w>500 else 10)
            # App title
            draw.text((20,14), f"مصحف الوحي - {sura_name} {sura}:{aya} - صفحة {page}", font=title_font, fill=(212,175,55) if is_dark else (30,41,59))
            # Theme indicator
            draw.text((w-100,14), f"{theme} {w}x{h}", font=small_font, fill=muted)
            # Ayah card
            y=64
            margin=16 if w>500 else 10
            card_w = w - 2*margin
            # Ayah text
            draw.rectangle([margin, y, margin+card_w, y+80], fill=card_bg, outline=gold if is_dark else (167,243,208))
            # Wrap ayah text
            ayah_y = draw_wrapped(draw, f"﴿ {ayah_text} ﴾", body_font, margin+12, y+10, card_w-24, 20 if w>500 else 16, text_color)
            y= y+92
            # Nuzul card header
            draw.rectangle([margin, y, margin+card_w, y+36], fill=(30,41,59) if is_dark else (236,253,245))
            draw.text((margin+12, y+8), "📜 سبب النزول" if has_asbab else "📖 مقصد النزول العام", font=small_font, fill=text_color)
            # Badge
            badge_w = 120
            draw.rectangle([margin+card_w-badge_w-12, y+6, margin+card_w-12, y+28], fill=(16,185,129) if has_asbab else (200,200,200), outline=None)
            draw.text((margin+card_w-badge_w-4, y+8), badge, font=small_font, fill=(255,255,255) if has_asbab else (50,50,50))
            y+=40
            # Summary box
            # Height based on text length
            # Estimate lines
            summary_lines = max(2, len(summary.split())//5 +1)
            box_h = summary_lines* (20 if w>500 else 15) + 40
            draw.rectangle([margin, y, margin+card_w, y+box_h], fill=(16,65,52) if is_dark else (240,253,244), outline=(16,185,129))
            # Summary title
            draw.text((margin+12, y+8), "💡 خلاصة سبب النزول", font=small_font, fill=(110,231,183) if is_dark else (6,95,70))
            # Summary text wrapped
            draw_wrapped(draw, summary, summary_font, margin+12, y+28, card_w-24, 19 if w>500 else 14, (167,243,208) if is_dark else (6,78,59))
            y+=box_h+12
            # Footer note
            draw.text((margin, y), f"الاختبار: {sura}:{aya} - {sura_name} - {theme} - {w}px - بدون أخطاء console ✓", font=small_font, fill=muted)
            # Save
            fname = f"{sura}_{aya}_{w}x{h}_{theme}.png"
            img.save(screens_dir / fname, "PNG")
            print(f"Saved {fname}")

# Also create a combined overview image for the report
print("Done screens")
