"""No two Arabic words run into each other: every window of the app is opened and tests/arabic_join_audit.js looks
for two inline runs that touch with an Arabic letter on both sides and no space (Chrome shapes them as one word, so
the first one's last letter takes its joined form — the «cut» word in «معاني الكلمات», 2026-11-19).
usage: python tests/arabic_join_e2e.py [port]   (server running)"""
import sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
INIT = """window.SpeechRecognition = window.webkitSpeechRecognition = function () { window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); }; this.stop = () => {}; this.abort = () => {}; };
try { localStorage.setItem('tasmee_prefs', JSON.stringify({ ask: false })); localStorage.setItem('recite_ears', 'browser'); } catch (e) {}"""
SAY = """(t) => { window.__n = (window.__n || 0); const res = []; for (let k = 0; k < window.__n; k++) { const x = [{ transcript: '' }]; x.isFinal = true; res[k] = x; }
  const r = [{ transcript: t }]; r.isFinal = true; res[window.__n] = r; window.__rec.onresult({ resultIndex: window.__n, results: res }); window.__n++; }"""
fails, seen = [], 0

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    for vw in [(1400, 900, False), (375, 812, True)]:
        ctx = br.new_context(viewport={"width": vw[0], "height": vw[1]}, is_mobile=vw[2], has_touch=vw[2])
        ctx.add_init_script(INIT)
        pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{PORT}/#p=96", wait_until="load"); pg.wait_for_timeout(1500)
        pg.add_script_tag(url=f"http://127.0.0.1:{PORT}/tests/arabic_join_audit.js")
        def audit(name, root="null"):
            global seen
            r = pg.evaluate(f"window.__joinAudit({root})"); seen += 1
            ok = not r
            print(("PASS " if ok else "FAIL ") + f"{vw[0]}px {name}", "" if ok else r[:4])
            if not ok: fails.append(f"{vw[0]} {name}")
        def wait(ms): pg.wait_for_timeout(ms)

        for s, a in [(4, 107), (2, 255), (73, 3), (112, 1)]:       # the ayah window, every tab
            pg.evaluate(f"openAyahTafsir({s}, {a})")
            for tab in ["tafsir", "words", "nuzul", "irab"]:
                pg.evaluate(f"switchTafsirTab('{tab}')"); wait(1300)
                audit(f"ayah window {s}:{a} {tab}", "document.getElementById('tafsirModal')")
            pg.evaluate("closeTafsirModal()")
        pg.evaluate("setViewMode('study'); goToPage(96)"); wait(600)   # «صفحة وآيات», every tab
        if vw[2]: pg.evaluate("document.querySelector('#studySwitch button[data-view=list]') && document.querySelector('#studySwitch button[data-view=list]').click()")
        for tab in ["tafsir", "words", "nuzul", "irab"]:
            pg.evaluate(f"document.querySelector('#studyPanel .sp-tabs button[data-k={tab}]').click()"); wait(1600)
            audit(f"study panel p.96 {tab}", "document.getElementById('studyPanel')")
        pg.evaluate("setViewMode('single')"); wait(300)
        pg.evaluate("openModal()"); pg.fill("#modalSearchInput", "الصمد"); wait(700)        # search
        audit("search results", "document.getElementById('searchModal')"); pg.evaluate("closeModal()")
        pg.evaluate("AyahLists.openSaver(4, 107, document.getElementById('tafsirSaveListBtn'))"); wait(300)   # lists
        audit("save popover"); pg.keyboard.press("Escape"); wait(200)
        pg.evaluate("AyahLists.open()"); wait(500); audit("قوائمي"); pg.evaluate("AyahLists.close()"); wait(200)
        pg.evaluate("MushafSettings.open()"); wait(400); audit("الإعدادات"); pg.evaluate("MushafSettings.close()"); wait(300)
        pg.evaluate("ReadingStats.open()"); wait(500); audit("إحصاءات القراءة"); pg.evaluate("ReadingStats.close()"); wait(300)
        pg.evaluate("goToPage(604)"); wait(500)                                                   # وضع التسميع
        pg.evaluate("ReciteByMic.config.testNoCapture = true"); pg.click("#tasmeeBtn"); wait(500)
        pg.evaluate(SAY, "بسم الله الرحمن الرحيم قل هو الله احد"); wait(400)
        audit("وضع التسميع bar"); pg.click("#tasmeeBtn"); wait(500); audit("وضع التسميع results")
        pg.evaluate("Tasmee.closeModal && Tasmee.closeModal(); Tasmee.openLog()"); wait(400); audit("سجل الأخطاء")
        if errs: fails.append(f"{vw[0]} page errors: {errs[:2]}")
        ctx.close()
    br.close()
print(f"{seen} views audited. FAILS:", fails)
sys.exit(1 if fails else 0)
