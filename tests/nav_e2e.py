"""The navigation bar on the real page (2026-11-07): one line on desktop, two
rows on phones, the ayah box, the top/bottom switches in settings, no strip,
pill or hint under it.

usage: python tests/nav_e2e.py [port]   (server running)"""
import sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
URL = f"http://127.0.0.1:{PORT}/"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name, "" if ok else info)
    if not ok: fails.append(name)

BAR = """() => { const b = document.getElementById('topControlsBar'); if (!b || !b.offsetParent) return null;
  const r = b.getBoundingClientRect(); const kids = [...b.querySelectorAll('.nav-btn, .page-input-box, .select-dropdown')].filter(e => e.offsetParent);
  const tops = new Set(kids.map(e => { const q = e.getBoundingClientRect(); return Math.round((q.top + q.bottom) / 2 / 20); }));
  return { h: Math.round(r.height), w: Math.round(r.width), rows: tops.size, sw: document.documentElement.scrollWidth, vw: innerWidth,
    over: kids.filter(e => { const q = e.getBoundingClientRect(); return q.left < r.left - 1 || q.right > r.right + 1; }).length }; }"""
ST = """() => ({ sura: document.getElementById('surahSelect').selectedIndex, aya: document.getElementById('ayahNumberInput').value,
  max: document.getElementById('ayahNumberInput').max, page: currentPage, hl: currentHighlightedAyah ? currentHighlightedAyah.sura + ':' + currentHighlightedAyah.aya : null,
  shadows: document.querySelectorAll('.searched-ayah-shadow').length })"""

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    for theme in ("light", "dark"):
        for w, h in ((1366, 900), (1024, 800), (768, 1000), (412, 900), (375, 800), (320, 700)):
            ctx = br.new_context(viewport={"width": w, "height": h}, color_scheme=theme)
            ctx.add_init_script(f"try {{ localStorage.setItem('mushaf_theme', '{theme}'); localStorage.removeItem('mushaf_ui'); }} catch (e) {{}}")
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(URL + "#p=9", wait_until="load"); pg.wait_for_timeout(1200)
            b = pg.evaluate(BAR)
            gone = pg.evaluate("() => ['readerStrip','highlightedAyahBadge','mushafHint'].filter(id => { const e = document.getElementById(id); return e && e.offsetParent; })")
            bottom = pg.evaluate("() => !!document.getElementById('bottomControlsBar').offsetParent")
            one = b and b["rows"] == 1
            want_one = w >= 721
            check(f"{theme} {w}px: bar {'one row' if want_one else '≤2 rows'}, inside, no sideways scroll",
                  b is not None and (one if want_one else b["rows"] <= 2) and b["over"] == 0 and b["sw"] <= b["vw"] and not errs, (b, errs))
            print(f"      bar h={b and b['h']} rows={b and b['rows']}")
            check(f"{theme} {w}px: no strip / pill / hint, bottom bar off by default", not gone and not bottom, (gone, bottom))
            ctx.close()

    # ---------- behaviour (desktop, light) ----------
    ctx = br.new_context(viewport={"width": 1366, "height": 900})
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL + "#p=9", wait_until="load"); pg.wait_for_timeout(1200)
    s = pg.evaluate(ST); check("p9: سورة البقرة, آية 58 (first ayah on the page), max 286", s["sura"] == 2 and s["aya"] == "58" and s["max"] == "286", s)
    def typ(v):
        pg.click("#ayahNumberInput"); pg.keyboard.type(str(v)); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
        return pg.evaluate(ST)
    s = typ(60); check("type 60: stays p9, 2:60 highlighted, box 60", s["page"] == 9 and s["hl"] == "2:60" and s["aya"] == "60" and s["shadows"] > 0, s)
    s = typ(255); check("type 255: p42, 2:255 highlighted", s["page"] == 42 and s["hl"] == "2:255" and s["aya"] == "255", s)
    s = typ(999); check("type 999: clamped to 286 (p49)", s["hl"] == "2:286" and s["aya"] == "286" and s["page"] == 49, s)
    pg.click("#ayahNumberInput"); pg.keyboard.press("ArrowLeft"); pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(300)
    check("arrow keys inside the box do not turn the page", pg.evaluate(ST)["page"] == 49)
    pg.keyboard.press("Escape"); pg.click("body", position={"x": 5, "y": 600}); pg.wait_for_timeout(100)
    pg.click("#nextPageBtn"); pg.wait_for_timeout(500)
    s = pg.evaluate(ST); check("next page (p50): box follows the page — آل عمران 1", s["page"] == 50 and s["sura"] == 3 and s["aya"] == "1" and s["max"] == "200", s)
    pg.select_option("#surahSelect", index=18); pg.wait_for_timeout(500)
    s = pg.evaluate(ST); check("pick الكهف: p293, آية 1, max 110", s["page"] == 293 and s["sura"] == 18 and s["aya"] == "1" and s["max"] == "110", s)
    pg.select_option("#surahSelect", index=114); pg.wait_for_timeout(500)
    s = pg.evaluate(ST); check("pick الناس (p604 shares 3 surahs): box = الناس 1", s["page"] == 604 and s["sura"] == 114 and s["aya"] == "1" and s["max"] == "6", s)
    s = typ(4); check("type 4 there: 114:4", s["hl"] == "114:4" and s["aya"] == "4", s)
    pg.select_option("#surahSelect", index=112); pg.wait_for_timeout(500)
    s = pg.evaluate(ST); check("pick الإخلاص on the same page: box = 112:1 (max 4)", s["sura"] == 112 and s["aya"] == "1" and s["max"] == "4", s)
    # a hizb pick highlights an ayah: the box names it
    pg.select_option("#hizbSelect", index=3); pg.wait_for_timeout(600)
    s = pg.evaluate(ST); check("hizb select ¾ of hizb 1: box shows its ayah", s["hl"] is not None and s["aya"] == s["hl"].split(":")[1] and str(s["sura"]) == s["hl"].split(":")[0], s)
    # emptied box + Enter: back to what it shows
    pg.click("#ayahNumberInput"); pg.keyboard.press("Backspace"); pg.keyboard.press("Backspace"); pg.keyboard.press("Backspace"); pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
    s2 = pg.evaluate(ST); check("emptied + Enter: nothing moves, the number comes back", s2["page"] == s["page"] and s2["aya"] == s["aya"], s2)

    # ---------- settings ----------
    pg.click("#settingsBtn"); pg.wait_for_timeout(400)
    txt = pg.inner_text(".st-drawer")
    check("settings: the three nav switches under «التنقل بين الصفحات», no hint switch",
          "التنقل بين الصفحات" in txt and "شريط التنقل أعلى المصحف" in txt and "شريط التنقل أسفل المصحف" in txt and "انقر على أي آية" not in txt)
    sec = pg.locator(".st-sec", has_text="عرض المصحف")
    pg.click("label:has([data-ui=navBottom]) i"); pg.wait_for_timeout(200)
    pg.click("label:has([data-ui=navTop]) i"); pg.wait_for_timeout(200)
    vis = pg.evaluate("() => [!!document.getElementById('topControlsBar').offsetParent, !!document.getElementById('bottomControlsBar').offsetParent]")
    check("switch: top off, bottom on", vis == [False, True], vis)
    pg.click(".st-x"); pg.wait_for_timeout(300)
    pg.reload(wait_until="load"); pg.wait_for_timeout(1200)
    vis = pg.evaluate("() => [!!document.getElementById('topControlsBar').offsetParent, !!document.getElementById('bottomControlsBar').offsetParent]")
    check("kept after reload", vis == [False, True], vis)
    arrows = pg.evaluate("() => [document.getElementById('prevPageBtnBottom').textContent.trim(), document.getElementById('nextPageBtnBottom').textContent.trim()]")
    check("bottom arrows: ▶ السابقة / التالية ◀ (like the top)", arrows == ["▶ السابقة", "التالية ◀"], arrows)
    p0 = pg.evaluate("currentPage"); pg.click("#prevPageBtnBottom"); pg.wait_for_timeout(400)
    check("bottom السابقة goes back one page", pg.evaluate("currentPage") == p0 - 1, (p0, pg.evaluate("currentPage")))
    # tasmee bar still finds its place when the top bar is hidden
    pg.evaluate("Tasmee.setPref('mode', 'eye')"); pg.click("#tasmeeBtn"); pg.wait_for_timeout(500)
    tb = pg.evaluate("() => { const b = document.getElementById('tsmBar'); return b && !!b.offsetParent; }")
    check("tasmee bar shows with the top bar hidden", tb, tb)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    # reset brings the defaults back
    pg.click("#settingsBtn"); pg.wait_for_timeout(300)
    pg.once("dialog", lambda d: d.accept()); pg.click("[data-act=reset]"); pg.wait_for_timeout(400)
    vis = pg.evaluate("() => [!!document.getElementById('topControlsBar').offsetParent, !!document.getElementById('bottomControlsBar').offsetParent]")
    check("reset: top on, bottom off", vis == [True, False], vis)
    check("no page errors", not errs, errs)
    ctx.close()

    # double-page spread: the box names an ayah on the right page
    ctx = br.new_context(viewport={"width": 1600, "height": 1000})
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL + "#p=9", wait_until="load"); pg.wait_for_timeout(1000)
    pg.evaluate("setViewMode('double')"); pg.wait_for_timeout(600)
    s = pg.evaluate(ST); b = pg.evaluate(BAR)
    check("spread: box shows an ayah of the open spread, bar one row", s["sura"] == 2 and int(s["aya"]) > 1 and b["rows"] == 1 and not errs, (s, b, errs))
    pg.evaluate("setViewMode('single')")
    ctx.close()
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
