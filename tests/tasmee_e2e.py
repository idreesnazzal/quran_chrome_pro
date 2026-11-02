"""وضع التسميع on the real page: one press on 🧠 starts and ends it, the start
is found from the first words, strict voice judging, page following, every way
out (✕, 🧠, Esc, the mic's own stop), eye mode from the settings, the end card,
results, the «أخطاء التسميع» list, the error log, double pages, a phone.

usage: python tests/tasmee_e2e.py [port] [screenshot-prefix]   (server running)"""
import sys, json
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
OUT = sys.argv[2] if len(sys.argv) > 2 else None
URL = f"http://127.0.0.1:{PORT}/"
INIT = """window.SpeechRecognition = window.webkitSpeechRecognition = function () {
  window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); }; this.stop = () => {}; this.abort = () => {}; };
try { localStorage.setItem('recite_ears', 'browser'); localStorage.setItem('recite_ears_v', '3'); } catch (e) {}"""
# each phrase = one utterance: interim grows word by word, then the final
FEED = """async (phrases) => {
  for (const w of phrases) {
    const ws = w.split(' ');
    for (let k = 1; k <= ws.length; k++) {
      const o = [{ transcript: ws.slice(0, k).join(' ') }]; o.isFinal = false;
      window.__rec.onresult({ resultIndex: 0, results: [o] });
      await new Promise(z => setTimeout(z, 40));
    }
    const f = [{ transcript: w }]; f.isFinal = true;
    window.__rec.onresult({ resultIndex: 0, results: [f] });
    window.__rec.onend && window.__rec.onend();
    await new Promise(z => setTimeout(z, 80));
  }
}"""
fails = []
def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name, extra if not ok or extra == "" else "")
    if not ok: fails.append(name)

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    ctx = br.new_context(viewport={"width": 1366, "height": 900}); ctx.add_init_script(INIT)
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append("PAGEERROR " + str(e)))
    q = pg.evaluate
    pg.goto(URL + "#p=1", wait_until="load"); pg.wait_for_timeout(1500)
    cls = lambda: q("[...document.querySelectorAll('.tsm-w')].map(e => e.className.replace('tsm-w', '').trim() || '-')")
    feed = lambda *ph: (q(FEED, list(ph)), pg.wait_for_timeout(150))
    on = lambda: q("Tasmee.isOn()")
    clean = lambda: q("!document.querySelector('.tsm-w') && !document.getElementById('tsmBar') && !document.body.classList.contains('tsm-on')")
    bar = lambda: q("(document.getElementById('tsmBar') || {}).innerText || ''")

    # one press: on at once, no window
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(400)
    check("🧠 starts the mode at once: no window, mic on", on() and not q("!!document.querySelector('.tsm-modal')") and q("ReciteByMic._session.active"))
    check("🧠 shows it is on", q("document.getElementById('tasmeeBtn').classList.contains('tsm-active')") and "إنهاء" in q("document.getElementById('tasmeeBtn').innerText"))
    c = cls()
    check("page 1: all 29 words covered, waiting for the first words", len(c) == 29 and all(x == "-" for x in c) and q("Tasmee._state().X") is None, c[:4])
    check("covers are opaque", q("getComputedStyle(document.querySelector('.tsm-w')).backgroundColor") == "rgb(74, 85, 104)")
    check("voice dock hidden (its «إيقاف التسميع» only stopped the mic)", q("getComputedStyle(document.getElementById('voiceFloatingDock')).display") == "none")
    if OUT: pg.screenshot(path=OUT + "_covered.png")

    feed("بسم الله الرحمن الرحيم")
    c = cls()
    check("1:1 recited: found the start, 4 words shown, cursor on 1:2", c[:4] == ["tsm-ok"] * 4 and c[4] == "tsm-cur", c[:6])
    feed("الحمد رب العالمين")
    c = cls()
    check("«لله» skipped: red and waiting, the rest covered", c[4] == "tsm-ok" and "tsm-err" in c[5] and c[6] == "-" and c[7] == "-", c[4:8])
    st = q("document.querySelector('.tsm-status').innerText")
    check("status says what went wrong", "ترك" in st and "أعد" in st, st)
    if OUT: pg.screenshot(path=OUT + "_error.png")
    feed("لله رب العالمين")
    c = cls()
    check("said right: «لله» red-translucent, then on", c[5] == "tsm-fix" and c[6] == "tsm-ok" and c[7] == "tsm-ok", c[4:9])
    feed("الرحمن الرحيم", "ملك يوم الدين")
    c = cls()
    check("«ملك» for «مالك»: substitution", "tsm-err" in c[10], c[9:13])
    feed("مالك يوم الدين", "اياك نعبد اياك نستعين")
    c = cls()
    check("strict: a dropped «و» in «واياك» passes", c[15] == "tsm-ok" and c[16] == "tsm-ok", c[13:18])
    pg.click("#tsmBar [data-tsm=hint]"); pg.wait_for_timeout(100)
    c = cls()
    check("💡 help shows «اهدنا» as a mistake", c[17] == "tsm-fix" and c[18] == "tsm-cur", c[16:19])
    y0 = q("scrollY"); pg.keyboard.press("Home"); pg.wait_for_timeout(100)
    check("Home in voice mode = help, page does not jump", cls()[18] == "tsm-fix" and q("scrollY") == y0)
    pg.click("#mushafCardRight", position={"x": 200, "y": 300}); pg.wait_for_timeout(200)
    check("a tap on the page opens no tafsir", not q("document.getElementById('tafsirModalBackdrop').classList.contains('active')"))
    feed("المستقيم صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين")
    pg.wait_for_timeout(300)
    check("end of page 1: the mushaf turns to page 2, covered", q("currentPage") == 2 and q("document.querySelector('.tsm-layer').dataset.page") == "2" and cls()[0] == "tsm-cur", q("currentPage"))
    pg.click("#tsmBar [data-tsm=mic]"); pg.wait_for_timeout(150)
    check("⏸ pauses the mic, the mode stays", on() and not q("ReciteByMic._session.active"))
    pg.click("#tsmBar [data-tsm=mic]"); pg.wait_for_timeout(150)
    check("▶ resumes", on() and q("ReciteByMic._session.active"))

    pg.click("#tsmBar [data-tsm=end]"); pg.wait_for_timeout(300)
    check("✕ ends the mode: no covers, no bar, mic off", clean() and not q("ReciteByMic._session.active") and not on())
    check("the dock the mode opened is closed again", not q("document.getElementById('voiceFloatingDock').classList.contains('show')"))
    check("🧠 back to normal", not q("document.getElementById('tasmeeBtn').classList.contains('tsm-active')"))
    done = q("(document.getElementById('tsmDone') || {}).innerText || ''")
    check("a small end card with the counts", "انتهى" in done and "✗ 4" in done and "29 كلمة" in done, done)
    if OUT: pg.screenshot(path=OUT + "_done.png")
    pg.click("#tsmDone [data-d=res]"); pg.wait_for_timeout(300)
    txt = q("document.querySelector('.tsm-results').innerText")
    check("results: score, types and the ayahs", "%" in txt and "ترك" in txt and "إبدال" in txt and "مساعدة" in txt and "الفاتحة 2" in txt, txt[:200])
    if OUT: pg.screenshot(path=OUT + "_results.png")
    lst = q("(() => { const l = AyahLists._state().lists.find(x => x.name === 'أخطاء التسميع'); return l ? l.items.map(i => i.s + ':' + i.a) : null; })()")
    check("error ayahs added to «أخطاء التسميع»", lst is not None and "1:2" in lst and "1:4" in lst and "1:6" in lst, lst)
    log = q("Tasmee._log()")
    w = log["words"].get("1:2:1")
    check("log: «لله» wrong in 1 of 1, type ترك", w and w["e"] == 1 and w["n"] == 1 and w["ty"] & 1, w)
    check("log: «واياك» (strict, passed) is not logged", "1:5:2" not in log["words"])
    pg.click(".tsm-foot [data-r=close]"); pg.wait_for_timeout(150)

    # every way out
    q("goToPage(1)"); pg.wait_for_timeout(300)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200); pg.click("#tasmeeBtn"); pg.wait_for_timeout(200)
    check("🧠 twice = on then off, nothing left", not on() and clean() and not q("ReciteByMic._session.active") and not q("!!document.getElementById('tsmDone')"))
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    check("Esc ends it", not on() and clean())
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200); q("ReciteByMic.stop()"); pg.wait_for_timeout(200)
    check("the mic's own stop (dock / header mic) ends it", not on() and clean())
    q("ReciteByMic.start()"); pg.wait_for_timeout(200)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200); pg.click("#tasmeeBtn"); pg.wait_for_timeout(200)
    check("a mic that was already on stays on for the highlight", not on() and q("ReciteByMic._session.active"))
    q("ReciteByMic.stop()")

    # second session: «لله» right this time -> 1 of 2
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200)
    feed("بسم الله الرحمن الرحيم الحمد لله رب العالمين")
    pg.click("#tsmBar [data-tsm=end]"); pg.wait_for_timeout(200)
    w = q("Tasmee._log().words['1:2:1']")
    check("log: «لله» now wrong in 1 of 2, read right last time", w["e"] == 1 and w["n"] == 2 and w["ok"] is True, w)

    # the start is found from the words: mid-page, isti'adha first, another page
    q("goToPage(3)"); pg.wait_for_timeout(300)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200)
    n3 = len(cls())
    feed("اعوذ بالله من الشيطان الرجيم", "ومن الناس من يقول امنا بالله")
    s = q("(() => { const s = Tasmee._state(); if (!s.X) return null; const a = ReciteByMic.corpus().ayahs[s.at[s.T.base].ai]; return [a.sura, a.aya, s.T.i - s.T.base]; })()")
    check("isti'adha dropped, started mid-page at 2:8, 6 words shown", s == [2, 8, 6], s)
    c = cls()
    check("the ayahs above the start are left open", len(c) < n3 and c[:6] == ["tsm-ok"] * 6 and c[6] == "tsm-cur", [n3, len(c), c[:7]])
    q("goToPage(5)"); pg.wait_for_timeout(300)
    c = cls()
    check("page turned by hand: the test moves there, waiting for the words", q("Tasmee._state().X") is None and len(c) > 100 and all(x == "-" for x in c))
    feed("قل هو الله احد", "الله الصمد")
    pg.wait_for_timeout(300)
    c = cls()
    check("recited another place: the mushaf goes there (112:1)", q("currentPage") == 604 and c[:7] == ["tsm-ok"] * 6 + ["tsm-cur"], [q("currentPage"), c[:8]])
    check("bar counts both parts", "✓ 12" in bar(), bar()[:80])
    q("Tasmee.stop()"); pg.wait_for_timeout(200)
    pg.click("#tsmDone [data-d=res]"); pg.wait_for_timeout(200)
    txt = q("document.querySelector('.tsm-score').innerText")
    check("result names both places", "البقرة" in txt and "الإخلاص" in txt, txt)
    q("Tasmee.closeModal()")

    # three attempts reveal; very strict catches the «و»
    q("goToPage(1)"); pg.wait_for_timeout(300)
    q("Tasmee.setPref('level', 'very')")
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200)
    feed("بسم الله الرحمن الرحيم الحمد للناس", "للناس", "للعالم")
    c = cls()
    check("3rd wrong attempt: word shown red-translucent, cursor on", c[5] == "tsm-fix" and c[6] == "tsm-cur", c[4:8])
    feed("رب العالمين الرحمن الرحيم مالك يوم الدين اياك نعبد اياك")
    c = cls()
    check("very strict: «اياك» for «واياك» = mistake", "tsm-err" in c[15], c[13:17])
    q("Tasmee.stop(true)")
    q("Tasmee.setPref('level', 'strict')")

    # eye mode: a setting, the same 🧠 button
    q("goToPage(2)"); pg.wait_for_timeout(300)
    pg.click("#settingsBtn"); pg.wait_for_timeout(300)
    pg.click("[data-seg=tsmMode] [data-v=eye]"); pg.wait_for_timeout(100)
    check("settings: eye mode chosen", q("Tasmee.prefs().mode") == "eye")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    check("eye mode: no mic, cursor on the page's first word", not q("ReciteByMic._session.active") and cls()[0] == "tsm-cur")
    y0 = q("scrollY")
    for _ in range(3): pg.keyboard.press("Home")
    c = cls()
    check("Home x3 = 3 words shown, page did not jump", c[:3] == ["tsm-ok"] * 3 and c[3] == "tsm-cur" and q("scrollY") == y0, c[:5])
    pg.keyboard.press("Delete"); pg.wait_for_timeout(50)
    check("Delete = «أخطأت» on the last shown word", cls()[2] == "tsm-fix")
    pg.keyboard.press("End"); pg.wait_for_timeout(50)
    check("End = covered again", cls()[2] == "tsm-cur")
    pg.keyboard.press("Shift+Home"); pg.wait_for_timeout(50)
    n21 = q("ReciteByMic.corpus().ayahs.find(a => a.sura === 2 && a.aya === 1).wordCount")
    c = cls()
    check("Shift+Home = the rest of the ayah", c[2] == "tsm-fix" and all(x in ("tsm-ok", "tsm-fix") for x in c[:n21]), c[:n21 + 2])
    before = sum(1 for x in cls() if x != "-" and x != "tsm-cur")
    pg.click("#mushafCardRight", position={"x": 30, "y": 30}); pg.wait_for_timeout(150)
    check("tap on the page = next word, no tafsir", sum(1 for x in cls() if x != "-" and x != "tsm-cur") == before + 1 and not q("document.getElementById('tafsirModalBackdrop').classList.contains('active')"))
    pg.focus("#pageNumberInput"); pg.keyboard.press("Home"); pg.wait_for_timeout(50)
    check("Home while typing in a field does nothing", sum(1 for x in cls() if x != "-" and x != "tsm-cur") == before + 1)
    pg.click("body", position={"x": 5, "y": 5})
    if OUT: pg.screenshot(path=OUT + "_eye.png")
    on2 = q("(() => { const s = Tasmee._state(); return s.at.filter((p, k) => k >= s.T.i && ReciteByMic.corpus().ayahs[p.ai].page === 2).length; })()")
    for _ in range(on2): q("Tasmee.next()")
    pg.wait_for_timeout(300)
    check("eye: past page 2 the mushaf turns to page 3", q("currentPage") == 3 and q("document.querySelector('.tsm-layer').dataset.page") == "3")
    pg.click("#tsmBar [data-tsm=end]"); pg.wait_for_timeout(200)
    pg.click("#tsmDone [data-d=res]"); pg.wait_for_timeout(200)
    check("eye session: «أخطأت» word in the results", "«أخطأت»" in q("document.querySelector('.tsm-results').innerText"))
    pg.click(".tsm-foot [data-r=errs]"); pg.wait_for_timeout(300)
    ays = q("Tasmee._state().fixed.map(i => ReciteByMic.corpus().ayahs[i].sura + ':' + ReciteByMic.corpus().ayahs[i].aya)")
    check("«سمّع الأخطاء فقط» = a test of those ayahs", ays == ["2:2"], ays)
    q("Tasmee.stop(true)")

    # double page
    q("setViewMode('double')"); pg.wait_for_timeout(400)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    layers = q("[...document.querySelectorAll('.tsm-layer')].map(l => l.dataset.page + ':' + l.children.length)")
    check("double page: both pages covered", len(layers) == 2 and all(int(x.split(':')[1]) > 20 for x in layers), layers)
    if OUT: pg.screenshot(path=OUT + "_double.png")
    q("Tasmee.stop(true)"); q("setViewMode('single')"); pg.wait_for_timeout(300)
    q("Tasmee.setPref('mode', 'voice')")

    # the log window
    q("Tasmee.openLog()"); pg.wait_for_timeout(200)
    rows = q("document.querySelectorAll('.tsm-lr').length")
    lr = q("[...document.querySelectorAll('.tsm-lr')].map(r => r.innerText.replace(/\\n/g, ' | '))")
    check("log lists every wrong word with «كذا من كذا»", rows >= 5 and any("من 2" in r for r in lr), lr[:3])
    if OUT: pg.screenshot(path=OUT + "_log.png")
    pg.select_option("[data-f=sort]", "mushaf"); pg.wait_for_timeout(150)
    first = q("document.querySelector('.tsm-lr').dataset.key")
    check("sort by mushaf order", first == "1:2:1", first)
    pg.select_option("[data-f=sura]", "2"); pg.wait_for_timeout(150)
    check("filter by surah", q("[...document.querySelectorAll('.tsm-lr')].every(r => r.dataset.key.startsWith('2:'))"))
    pg.select_option("[data-f=sura]", "0"); pg.wait_for_timeout(150)
    pg.click("[data-l=drill]"); pg.wait_for_timeout(300)
    ays = q("Tasmee._state().fixed.map(i => ReciteByMic.corpus().ayahs[i].sura + ':' + ReciteByMic.corpus().ayahs[i].aya)")
    check("«سمّع هذه فقط» = a test of the error ayahs", "1:2" in ays and "1:4" in ays and len(ays) <= 14, ays)
    q("Tasmee.stop(true)")
    q("Tasmee.openLog()"); pg.wait_for_timeout(150)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    check("Escape closes the log", not q("!!document.querySelector('.tsm-modal')"))
    q("Tasmee.openLog()"); pg.wait_for_timeout(150); pg.keyboard.press("Control+k"); pg.wait_for_timeout(250)
    check("Ctrl+K closes the log and opens search", not q("!!document.querySelector('.tsm-modal')") and q("document.getElementById('searchModalBackdrop').classList.contains('active')"))
    q("closeModal()")

    # settings
    pg.click("#settingsBtn"); pg.wait_for_timeout(300)
    check("settings: tasmee section", q("!!document.querySelector('[data-seg=tsmLevel]') && !!document.querySelector('[data-seg=tsmMode]') && !!document.querySelector('[data-act=tasmeelog]')"))
    pg.click("[data-seg=tsmReveal] [data-v='0']"); pg.wait_for_timeout(100)
    check("settings: «لا تكشفها أبدًا» saved", q("Tasmee.prefs().reveal") == 0)
    pg.click("[data-seg=tsmReveal] [data-v='3']"); pg.wait_for_timeout(100)
    pg.click("[data-act=tasmee]"); pg.wait_for_timeout(300)
    check("settings button starts the mode", on())
    q("Tasmee.stop(true)")

    # corrupted log does not break anything
    q("localStorage.setItem('tasmee_log.v1', '{\"words\":{\"x\":5,\"1:1:0\":{\"e\":\"a\"},\"1:1:1\":{\"e\":2,\"n\":1}}}')")
    q("Tasmee.openLog()"); pg.wait_for_timeout(150)
    check("broken log rows are dropped, the window opens", q("document.querySelectorAll('.tsm-lr').length") == 1)
    q("Tasmee.closeModal()")

    # phone
    m = br.new_context(viewport={"width": 320, "height": 700}, device_scale_factor=2, is_mobile=True, has_touch=True); m.add_init_script(INIT)
    mp = m.new_page(); mp.on("pageerror", lambda e: errs.append("PAGEERROR m " + str(e)))
    mp.goto(URL + "#p=3", wait_until="load"); mp.wait_for_timeout(1500)
    mp.tap("#tasmeeBtn"); mp.wait_for_timeout(300)
    check("320px: bar fits, no sideways scroll", mp.evaluate("Tasmee.isOn()") and mp.evaluate("document.documentElement.scrollWidth") <= 320 and mp.evaluate("document.getElementById('tsmBar').getBoundingClientRect().right") <= 320)
    check("320px: bar is one compact block", mp.evaluate("document.getElementById('tsmBar').offsetHeight") <= 100, mp.evaluate("document.getElementById('tsmBar').offsetHeight"))
    if OUT: mp.screenshot(path=OUT + "_phone.png")
    mp.tap("#tsmBar [data-tsm=end]"); mp.wait_for_timeout(200)
    check("320px: ✕ ends it", not mp.evaluate("Tasmee.isOn()"))
    mp.evaluate("Tasmee.setPref('mode', 'eye')"); mp.tap("#tasmeeBtn"); mp.wait_for_timeout(300)
    mp.tap("#tsmBar [data-tsm=next]"); mp.tap("#tsmBar [data-tsm=next]"); mp.wait_for_timeout(100)
    check("320px: «التالية» button works", mp.evaluate("Tasmee._state().T.i") == 2)
    mp.tap("#tasmeeBtn"); mp.wait_for_timeout(300)
    check("320px: end card fits", mp.evaluate("document.getElementById('tsmDone').getBoundingClientRect().right") <= 320 and mp.evaluate("document.documentElement.scrollWidth") <= 320)
    if OUT: mp.screenshot(path=OUT + "_phone_done.png")

    check("no page errors", not errs, "\n".join(errs[:6]))
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
