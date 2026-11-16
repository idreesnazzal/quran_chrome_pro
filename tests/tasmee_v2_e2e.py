"""وضع التسميع, engine v2, in a real browser (recogniser mocked): the two ears chosen at every start, yellow and
red as the reader sees them, a tap that overturns a verdict, the table that compares the ears, the mic that
pauses itself. usage: python tests/tasmee_v2_e2e.py [port] [screenshot-dir]   (server running)"""
import sys, json
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
INIT = """window.SpeechRecognition = window.webkitSpeechRecognition = function () {
  window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); }; this.stop = () => {}; this.abort = () => {}; };"""
SAY = """(t) => { window.__n = (window.__n || 0); const res = []; for (let k = 0; k < window.__n; k++) { const x = [{ transcript: '' }]; x.isFinal = true; res[k] = x; }
  const r = [{ transcript: t }]; r.isFinal = true; res[window.__n] = r; window.__rec.onresult({ resultIndex: window.__n, results: res }); window.__n++; }"""
ST = """() => { const st = Tasmee._state(); if (!st) return null; const T = st.T, X = st.X; if (!X) return { tech: st.tech, wait: true };
  const cls = (w) => { const k = X.E.indexOf(w); const el = document.querySelector('.tsm-w[data-k="' + k + '"]'); return el ? el.className.replace('tsm-w', '').trim() : '?'; };
  return { tech: st.tech, i: T.i, sum: Tasmee.Core.summary(T, X), cleared: st.acc.cleared || 0, status: st.status, cls: cls('عظيم'), clsY: cls('غشاوه'), paused: !isVoiceReciteActive }; }"""
fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond: fails.append(name)

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    ctx = br.new_context(viewport={"width": 1366, "height": 900}); ctx.add_init_script(INIT)
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{PORT}/#p=2", wait_until="load"); pg.wait_for_timeout(1500)
    pg.evaluate("ReciteByMic.config.testNoCapture = true")

    # 1. the chooser, at every start
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    cards = pg.locator(".tsm-tech").all_inner_texts()
    check("🧠 opens two cards: Chrome and the Quran ear", len(cards) == 2 and "Chrome" in cards[0] and "القرآنية" in cards[1], cards)
    check("...the mode has not started yet", pg.evaluate("!Tasmee.isOn()"))
    if SHOTS: pg.screenshot(path=SHOTS + "/choose_desk.png")
    pg.click(".tsm-tech[data-tech=chrome]"); pg.wait_for_timeout(400)
    s = pg.evaluate(ST)
    check("Chrome picked: the mode runs with the Chrome ear", s and s["tech"] == "chrome" and pg.evaluate("localStorage.getItem('recite_ears')") == "browser", s)

    # 2. reading 2:6-7: a garbled word is yellow, a swap with a similar ayah is red; nothing waits
    pg.evaluate(SAY, "ان الذين كفروا سواء عليهم اانذرتهم ام لم تنذرهم لا يؤمنون"); pg.wait_for_timeout(150)
    pg.evaluate(SAY, "ختم الله على قلوبهم وعلى سمعهم وعلى ابصارهم غشاوات ولهم عذاب اليم"); pg.wait_for_timeout(150)
    pg.evaluate(SAY, "ومن الناس من يقول امنا بالله وباليوم الاخر وما هم بمؤمنين"); pg.wait_for_timeout(300)
    s = pg.evaluate(ST)
    check("«عذاب اليم» for «عذاب عظيم»: red, shown, and the test went on to 2:9", s["cls"] == "tsm-fix" and s["sum"]["err"] == 1 and s["i"] > 30, s)
    check("«غشاوات» for «غشاوة»: yellow, not counted", s["clsY"] == "tsm-uns" and s["sum"]["uns"] == 1, s)
    check("the bar says what happened and what a tap does", "بُدّلت" in s["status"] and "المسها" in s["status"], s["status"])
    if SHOTS: pg.screenshot(path=SHOTS + "/marks_desk.png")

    # 3. the reader's verdict: a tap on the red word = not a mistake (and back); on the yellow = a mistake
    box = pg.evaluate("""() => { const st = Tasmee._state(), k = st.X.E.indexOf('عظيم'), r = document.querySelector('.tsm-w[data-k="' + k + '"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }""")
    pg.mouse.click(box[0], box[1]); pg.wait_for_timeout(150)
    s = pg.evaluate(ST)
    check("tap on the red word: not a mistake (a thin green line marks it)", s["cls"] == "tsm-ok tsm-over" and s["sum"]["err"] == 0 and s["cleared"] == 1, s)
    pg.mouse.click(box[0], box[1]); pg.wait_for_timeout(150)
    s = pg.evaluate(ST)
    check("...tapped again: the ear's verdict is back", s["cls"] == "tsm-fix" and s["sum"]["err"] == 1 and s["cleared"] == 0, s)
    pg.mouse.click(box[0], box[1]); pg.wait_for_timeout(150)                       # leave it cleared
    boxY = pg.evaluate("""() => { const st = Tasmee._state(), k = st.X.E.indexOf('غشاوه'), r = document.querySelector('.tsm-w[data-k="' + k + '"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }""")
    pg.mouse.click(boxY[0], boxY[1]); pg.wait_for_timeout(150)
    s = pg.evaluate(ST)
    check("tap on the yellow word: a mistake", s["sum"]["err"] == 1 and s["sum"]["uns"] == 0, s)

    # 4. the mode ends: this session is added to the Chrome column
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(400)
    t = pg.evaluate("Tasmee.techStats()")
    c = t["chrome"]
    check("the table: 1 Chrome session, 1 red of which 1 cleared (a false red), 1 yellow of which 1 marked",
          c["n"] == 1 and c["red"] == 1 and c["cleared"] == 1 and c["yellow"] == 1 and c["marked"] == 1 and c["words"] > 30 and t["tilawi"]["n"] == 0, t)
    pg.evaluate("document.getElementById('tsmDone') && document.getElementById('tsmDone').remove()")
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    tbl = pg.locator(".tsm-cmp").inner_text()
    check("the chooser shows the comparison table", "أحمر كاذب" in tbl and "1 من 1" in tbl, tbl)
    if SHOTS: pg.screenshot(path=SHOTS + "/table_desk.png")

    # 5. the Quran ear picked: the pref changes, the session is the Quran ear's
    pg.click(".tsm-tech[data-tech=tilawi]"); pg.wait_for_timeout(500)
    s = pg.evaluate(ST)
    check("the Quran ear picked: recite_ears = ctc, the session is «tilawi»", s and s["tech"] == "tilawi" and pg.evaluate("localStorage.getItem('recite_ears')") == "ctc", s)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check("Esc ends it", pg.evaluate("!Tasmee.isOn()"))

    # 6. «do not ask»: the button starts at once with the last ear
    pg.evaluate("Tasmee.setPref('ask', false); ReciteByMic.setEars('browser')")
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    check("ask = off: 🧠 starts at once", pg.evaluate("Tasmee.isOn() && !document.querySelector('.tsm-choose')"))

    # 7. a mic left open: three minutes without a step forward -> paused
    pg.evaluate(SAY, "ان الذين كفروا سواء عليهم"); pg.wait_for_timeout(200)
    pg.evaluate("Tasmee._state().movedAt -= 200000")
    pg.wait_for_function("!isVoiceReciteActive", timeout=20000)
    s = pg.evaluate(ST)
    check("idle 3 minutes: the mic is paused, the mode stays, the bar says why", s and "3 دقائق" in s["status"], s)
    pg.keyboard.press("Escape")
    ctx.close()

    # 8. a phone: the two cards stack, nothing overflows
    m = br.new_context(viewport={"width": 360, "height": 740}, device_scale_factor=2, is_mobile=True, has_touch=True); m.add_init_script(INIT)
    mp = m.new_page(); mp.goto(f"http://127.0.0.1:{PORT}/#p=2", wait_until="load"); mp.wait_for_timeout(1500)
    mp.evaluate("ReciteByMic.config.testNoCapture = true")
    mp.tap("#tasmeeBtn"); mp.wait_for_timeout(300)
    geo = mp.evaluate("""() => { const c = document.querySelector('.tsm-choose').getBoundingClientRect(), a = [...document.querySelectorAll('.tsm-tech')].map((e) => e.getBoundingClientRect());
      return { w: innerWidth, left: c.left, right: c.right, stacked: a[1].top >= a[0].bottom - 1, overflow: document.documentElement.scrollWidth > innerWidth }; }""")
    check("360px: the cards stack inside the screen, no sideways scroll", geo["stacked"] and geo["left"] >= 0 and geo["right"] <= geo["w"] and not geo["overflow"], geo)
    if SHOTS: mp.screenshot(path=SHOTS + "/choose_phone.png")
    mp.tap(".tsm-tech[data-tech=chrome]"); mp.wait_for_timeout(300)
    check("360px: a tap on a card starts the mode", mp.evaluate("Tasmee.isOn()"))
    m.close()
    check("no page errors", not errs, errs)
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
