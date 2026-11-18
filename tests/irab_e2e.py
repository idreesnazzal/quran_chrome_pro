"""إعراب الآية in a real browser: where a reader opens it, what it shows, and that reading never waits for it.
usage: python tests/irab_e2e.py [port] [screenshot-dir]   (server running)"""
import sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
import re
D = lambda t: re.sub("[ً-ٰٟ]", "", t or "")      # diacritics in either order: compare the letters
fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond: fails.append(name)

BODY = """() => { const b = document.getElementById('irabBody'); return { text: b.innerText, shared: (b.querySelector('.ir-shared') || {}).textContent || '',
  cur: (b.querySelector('.ir-cur') || {}).dataset ? b.querySelector('.ir-cur').dataset.a : null, src: !!b.querySelector('.ir-src'),
  ref: (b.querySelector('.ir-ref-t') || {}).innerText || '', links: b.querySelectorAll('.ir-link').length, tab: currentActiveTab }; }"""

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    ctx = br.new_context(viewport={"width": 1366, "height": 900})
    ctx.add_init_script("try { localStorage.setItem('mushaf_view_mode', 'single'); } catch (e) {}")
    pg = ctx.new_page(); errs = []; reqs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("request", lambda r: reqs.append(r.url))
    pg.goto(f"http://127.0.0.1:{PORT}/#p=574", wait_until="load"); pg.wait_for_timeout(1500)
    check("reading: no iʿrāb file is fetched until it is opened", not [u for u in reqs if "/data/irab/" in u])

    # 1. the ayah window: the fourth tab
    pg.evaluate("openAyahTafsir(73, 3)"); pg.wait_for_timeout(300)
    check("...nor when the ayah window opens on another tab", not [u for u in reqs if "/data/irab/" in u])
    pg.click("#tabBtnIrab"); pg.wait_for_function("document.querySelector('#irabBody .ir-text')", timeout=10000)
    s = pg.evaluate(BODY)
    check("73:3: the book analysed 73:1-4 together — labelled, ayah 3's part lit", "1–4" in s["shared"] and s["cur"] == "3", s)
    check("...the book's words: «نِصْفَهُ» بدل من الليل", D("«نِصْفَهُ» بدل من الليل") in D(s["text"]), s["text"][:200])
    check("...the source is named under it", s["src"] and "الدعاس" in s["text"])
    check("...only that surah's file was fetched", [u.split("/data/irab/")[1].split("?")[0] for u in reqs if "/data/irab/" in u] == ["073.js"])
    if SHOTS: pg.screenshot(path=SHOTS + "/irab_desk.png")
    pg.click("#tafsirNextAyahBtn"); pg.wait_for_timeout(400)
    s = pg.evaluate(BODY)
    check("«الآية التالية» stays on the tab: 73:4, ayah 4 lit", s["tab"] == "irab" and s["cur"] == "4", s)
    pg.click("#tafsirNextAyahBtn"); pg.wait_for_timeout(400)
    s = pg.evaluate(BODY)
    check("73:5 is analysed alone: no shared label", not s["shared"] and D("سَنُلْقِي") in D(s["text"]), s)

    # 2. the book refers back: what it means is shown, labelled
    pg.evaluate("openAyahTafsir(55, 16)"); pg.wait_for_function("(document.querySelector('#irabBody .ir-ref-t') || {}).innerText && !document.querySelector('#irabBody .ir-ref-t .ir-wait')", timeout=10000)
    s = pg.evaluate(BODY)
    check("55:16 «انظر الآية ١٣»: the analysis of 55:13 is under it", "انظر" in s["text"] and "١٣" in s["text"] and " 13" in s["text"] and D("«فَبِأَيِّ»") in D(s["ref"]), s)
    pg.evaluate("openAyahTafsir(82, 3)"); pg.wait_for_timeout(1200)
    s = pg.evaluate(BODY)
    check("82:3 points to سورة التكوير 1-14 (another surah's file)", "سورة التكوير" in s["text"] and D("الشَّمْسُ") in D(s["ref"]) and D("عَلِمَتْ") in D(s["ref"]), s["ref"][:120])

    # 3. «سبق إعرابها» inside a passage: a button that opens it, by keyboard too
    pg.evaluate("openAyahTafsir(5, 11)"); pg.wait_for_function("document.querySelector('#irabBody .ir-link')", timeout=10000)
    pg.focus("#irabBody .ir-link"); pg.keyboard.press("Enter")
    pg.wait_for_function("(document.querySelector('#irabBody .ir-peek .ir-ref-t') || {}).innerText && !document.querySelector('#irabBody .ir-peek .ir-wait')", timeout=10000)
    peek = pg.evaluate("document.querySelector('#irabBody .ir-peek').innerText")
    check("5:11 «تقدم إعرابها» (Enter): where the book first analysed «يا أيها الذين آمنوا» (5:1) opens under the text",
          D("الآية 1 من سورة المائدة") in D(peek) and D("يا أَيُّهَا الَّذِينَ آمَنُوا") in D(peek), peek[:160])
    pg.keyboard.press("Enter"); pg.wait_for_timeout(150)
    check("...Enter again closes it", pg.evaluate("!document.querySelector('#irabBody .ir-peek')"))
    txt = pg.evaluate("Irab.copyText(73, 3)")
    check("📋 copies the passage with its source", txt.startswith("إعراب الآيات 1–4") and "دار المنير" in txt, txt[:80])
    pg.evaluate("closeTafsirModal()")

    # 4. search results: a small button, the same window
    pg.evaluate("openModal()"); pg.fill("#modalSearchInput", "الصمد"); pg.wait_for_timeout(700)
    pg.locator("#modalResultsList button", has_text="الإعراب").first.click(); pg.wait_for_timeout(800)
    s = pg.evaluate(BODY)
    check("search «الصمد» → 🧩 الإعراب: 112:2 opens on the tab", s["tab"] == "irab" and D("«اللَّهُ الصَّمَدُ» مبتدأ وخبره") in D(s["text"]), s)
    pg.evaluate("closeTafsirModal(); closeModal()")

    # 4b. a saved ayah (قوائمي): a small button, the same window
    pg.evaluate("AyahLists.openSaver(112, 1, document.getElementById('tafsirSaveListBtn'))"); pg.wait_for_timeout(300)
    pg.locator("text=المفضلة").first.click(); pg.locator("button", has_text="تم").last.click(); pg.wait_for_timeout(300)
    pg.evaluate("AyahLists.open()"); pg.wait_for_timeout(400)
    pg.locator(".al-backdrop.show").locator("text=المفضلة").first.click(); pg.wait_for_timeout(400)
    pg.locator('.al-card[data-k] [data-do="irab"]').first.click(); pg.wait_for_timeout(800)
    s = pg.evaluate(BODY)
    check("قوائمي → «الإعراب» on a saved ayah (112:1): the same window, on the tab", s["tab"] == "irab" and D("«قُلْ» أمر فاعله مستتر") in D(s["text"]), s["text"][:80])
    pg.evaluate("closeTafsirModal()")

    # 5. the study panel: one passage shown once, the others say where it is
    pg.evaluate("setViewMode('study'); goToPage(2)"); pg.wait_for_timeout(800)
    pg.click("#studyPanel .sp-tabs button[data-k=irab]")
    pg.wait_for_function("document.querySelector('#sp-2-1 .ir-text') && /الآية 1/.test(document.querySelector('#sp-2-2 .sp-body').innerText)", timeout=10000)
    st = pg.evaluate("[1, 2, 5].map((a) => document.querySelector('#sp-2-' + a + ' .sp-body').innerText)")
    check("study panel: 2:1-5 shown once (in 2:1), 2:2..5 point to it", "معًا" in st[0] and "«الم»" in D(st[0]) and "مع الآيات 1–5" in st[1] and "مع الآيات 1–5" in st[2], st)
    if SHOTS: pg.screenshot(path=SHOTS + "/irab_study.png")
    pg.evaluate("setViewMode('single')")
    check("no page errors", not errs, errs)
    ctx.close()

    # 6. a phone: the four tabs fit, the analysis wraps inside the screen
    m = br.new_context(viewport={"width": 360, "height": 740}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mp = m.new_page(); merrs = []; mp.on("pageerror", lambda e: merrs.append(str(e)))
    mp.goto(f"http://127.0.0.1:{PORT}/#p=42", wait_until="load"); mp.wait_for_timeout(1500)
    mp.evaluate("openAyahTafsir(2, 282)"); mp.tap("#tabBtnIrab")
    mp.wait_for_function("document.querySelector('#irabBody .ir-text')", timeout=10000)
    geo = mp.evaluate("""() => { const t = [...document.querySelectorAll('.tafsir-tab-btn')].map((b) => b.getBoundingClientRect()), x = document.querySelector('#irabBody .ir-text').getBoundingClientRect();
      return { tabsIn: t.every((r) => r.left >= 0 && r.right <= innerWidth), clipped: [...document.querySelectorAll('.tafsir-tab-btn')].some((b) => b.scrollWidth > b.clientWidth + 1),
               textIn: x.left >= 0 && x.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }; }""")
    check("360px: four tabs inside the screen, none cut; the longest ayah's analysis (2:282) wraps inside", geo["tabsIn"] and not geo["clipped"] and geo["textIn"] and not geo["overflow"], geo)
    if SHOTS: mp.screenshot(path=SHOTS + "/irab_phone.png")
    check("phone: no page errors", not merrs, merrs)
    m.close(); br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
