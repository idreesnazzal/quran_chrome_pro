"""وضع التسميع on the real page: covers, strict voice judging, eye mode keys,
results, the «أخطاء التسميع» list, the error log, page turns, double pages.

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

    # start window -> voice, current page
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(250)
    check("start window opens from the header", q("!!document.querySelector('.tsm-start')"))
    pg.click(".tsm-seg[data-seg=mode] [data-v=voice]"); pg.wait_for_timeout(150)
    pg.click("input[value=page]"); pg.click("[data-s=go]"); pg.wait_for_timeout(400)
    c = cls()
    check("page 1: 29 words covered, the first is the cursor", len(c) == 29 and c[0] == "tsm-cur" and all(x == "-" for x in c[1:]), c[:4])
    check("covers are opaque", q("getComputedStyle(document.querySelector('.tsm-w')).backgroundColor") == "rgb(74, 85, 104)")
    check("bar + mic on", q("!!document.getElementById('tsmBar') && ReciteByMic._session.active"))
    check("karaoke ribbon hidden", q("getComputedStyle(document.getElementById('dockKaraokeRow')).display") == "none")
    if OUT: pg.screenshot(path=OUT + "_covered.png")

    feed("بسم الله الرحمن الرحيم")
    c = cls()
    check("1:1 recited: 4 words shown, cursor on 1:2", c[:4] == ["tsm-ok"] * 4 and c[4] == "tsm-cur", c[:6])
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
    check("«ملك» for «مالك»: substitution (a real difference)", "tsm-err" in c[10], c[9:13])
    feed("مالك يوم الدين", "اياك نعبد اياك نستعين")
    c = cls()
    check("strict: a dropped «و» in «واياك» passes", c[15] == "tsm-ok" and c[16] == "tsm-ok", c[13:18])
    pg.click("#tsmBar [data-tsm=hint]"); pg.wait_for_timeout(100)
    c = cls()
    check("💡 help shows «اهدنا» as a mistake", c[17] == "tsm-fix" and c[18] == "tsm-cur", c[16:19])
    y0 = q("scrollY"); pg.keyboard.press("Home"); pg.wait_for_timeout(100)
    check("Home in voice mode = help, page does not jump", cls()[18] == "tsm-fix" and q("scrollY") == y0)
    pg.click("#mushafCardRight", position={"x": 200, "y": 300}); pg.wait_for_timeout(200)
    check("a tap on the page opens no tafsir during the test", not q("document.getElementById('tafsirModalBackdrop').classList.contains('active')"))

    pg.click("#tsmBar [data-tsm=finish]"); pg.wait_for_timeout(400)
    txt = q("document.querySelector('.tsm-results').innerText")
    check("results: score, types and the ayahs", "%" in txt and "ترك" in txt and "إبدال" in txt and "مساعدة" in txt and "الفاتحة 2" in txt, txt[:200])
    if OUT: pg.screenshot(path=OUT + "_results.png")
    lst = q("(() => { const l = AyahLists._state().lists.find(x => x.name === 'أخطاء التسميع'); return l ? l.items.map(i => i.s + ':' + i.a) : null; })()")
    check("error ayahs added to «أخطاء التسميع»", lst is not None and "1:2" in lst and "1:4" in lst and "1:6" in lst, lst)
    log = q("Tasmee._log()")
    w = log["words"].get("1:2:1")
    check("log: «لله» wrong in 1 of 1, type ترك", w and w["e"] == 1 and w["n"] == 1 and w["ty"] & 1, w)
    check("log: «واياك» (strict, passed) is not logged", "1:5:2" not in log["words"])
    pg.click(".tsm-foot [data-r=close]"); pg.wait_for_timeout(200)
    check("close ends the test: no covers, no bar", q("!document.querySelector('.tsm-w') && !document.getElementById('tsmBar') && !document.body.classList.contains('tsm-on')"))
    check("mic stopped", not q("ReciteByMic._session.active"))

    # second session on the same page: «لله» right this time -> 1 of 2
    q("Tasmee.start(Tasmee._state ? [0,1,2,3,4,5,6] : [], 'voice')"); pg.wait_for_timeout(300)
    feed("بسم الله الرحمن الرحيم الحمد لله رب العالمين")
    pg.click("#tsmBar [data-tsm=finish]"); pg.wait_for_timeout(300); pg.click(".tsm-foot [data-r=close]")
    w = q("Tasmee._log().words['1:2:1']")
    check("log: «لله» now wrong in 1 of 2, read right last time", w["e"] == 1 and w["n"] == 2 and w["ok"] is True, w)

    # three attempts reveal; very strict catches the «و»
    q("Tasmee.setPref('level', 'very')")
    q("Tasmee.start([0,1,2,3,4,5,6], 'voice')"); pg.wait_for_timeout(300)
    feed("بسم الله الرحمن الرحيم الحمد للناس", "للناس", "للعالم")
    c = cls()
    check("3rd wrong attempt: word shown red-translucent, cursor on", c[5] == "tsm-fix" and c[6] == "tsm-cur", c[4:8])
    feed("رب العالمين الرحمن الرحيم مالك يوم الدين اياك نعبد اياك")
    c = cls()
    check("very strict: «اياك» for «واياك» = mistake", "tsm-err" in c[15], c[13:17])
    pg.click("#tsmBar [data-tsm=finish]"); pg.wait_for_timeout(300); pg.click(".tsm-foot [data-r=close]")
    q("Tasmee.setPref('level', 'strict')")

    # eye mode on page 2 with keys
    q("goToPage(2)"); pg.wait_for_timeout(300)
    q("Tasmee.setPref('mode', 'eye'); Tasmee.setPref('range', 'page')")
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(200); pg.click("[data-s=go]"); pg.wait_for_timeout(300)
    check("eye mode: no mic", not q("ReciteByMic._session.active"))
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
    pg.click("#tsmBar [data-tsm=finish]"); pg.wait_for_timeout(300)
    check("eye session: «أخطأت» word in the results", "«أخطأت»" in q("document.querySelector('.tsm-results').innerText"))
    pg.click(".tsm-foot [data-r=close]"); pg.wait_for_timeout(150)

    # page turn: finish page 2 by keys -> the cursor moves to page 3
    q("Tasmee.stop(true); Tasmee.start(ReciteByMic.corpus().ayahs.map((a, i) => a.sura === 2 && a.aya <= 8 ? i : -1).filter(i => i >= 0), 'eye')")
    pg.wait_for_timeout(300)
    n = q("Tasmee._state().X.N")
    on2 = q("Tasmee._state().at.filter(p => ReciteByMic.corpus().ayahs[p.ai].page === 2).length")
    for _ in range(on2): q("Tasmee.next()")
    pg.wait_for_timeout(400)
    check("cursor past page 2: the mushaf turns to page 3, covers rebuilt", q("currentPage") == 3 and q("document.querySelector('.tsm-layer').dataset.page") == "3", q("currentPage"))
    for _ in range(n - on2): q("Tasmee.next()")
    pg.wait_for_timeout(300)
    check("all words shown: results open by themselves", q("!!document.querySelector('.tsm-results')"))
    pg.click(".tsm-foot [data-r=close]")

    # double page
    q("setViewMode('double')"); pg.wait_for_timeout(400)
    q("Tasmee.setPref('range', 'page')"); pg.click("#tasmeeBtn"); pg.wait_for_timeout(200); pg.click("[data-s=go]"); pg.wait_for_timeout(300)
    layers = q("[...document.querySelectorAll('.tsm-layer')].map(l => l.dataset.page + ':' + l.children.length)")
    check("double page: both pages covered", len(layers) == 2 and all(int(x.split(':')[1]) > 50 for x in layers), layers)
    if OUT: pg.screenshot(path=OUT + "_double.png")
    q("Tasmee.stop(true)"); q("setViewMode('single')"); pg.wait_for_timeout(300)

    # the log window
    q("Tasmee.openLog()"); pg.wait_for_timeout(200)
    rows = q("document.querySelectorAll('.tsm-lr').length")
    lr = q("[...document.querySelectorAll('.tsm-lr')].map(r => r.innerText.replace(/\\n/g, ' | '))")
    check("log lists every wrong word with «كذا من كذا»", rows >= 5 and any("من 3" in r or "من 2" in r for r in lr), lr[:3])
    if OUT: pg.screenshot(path=OUT + "_log.png")
    pg.select_option("[data-f=sort]", "mushaf"); pg.wait_for_timeout(150)
    first = q("document.querySelector('.tsm-lr').dataset.key")
    check("sort by mushaf order", first == "1:2:1", first)
    pg.select_option("[data-f=sura]", "2"); pg.wait_for_timeout(150)
    check("filter by surah", q("[...document.querySelectorAll('.tsm-lr')].every(r => r.dataset.key.startsWith('2:'))"))
    pg.select_option("[data-f=sura]", "0"); pg.wait_for_timeout(150)
    pg.click("[data-l=drill]"); pg.wait_for_timeout(300)
    ays = q("Tasmee._state().ayahs.map(i => ReciteByMic.corpus().ayahs[i].sura + ':' + ReciteByMic.corpus().ayahs[i].aya)")
    check("«سمّع هذه فقط» = a test of the error ayahs", "1:2" in ays and "1:4" in ays and len(ays) <= 12, ays)
    q("Tasmee.stop(true)")
    q("Tasmee.openLog()"); pg.wait_for_timeout(150)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    check("Escape closes the log", not q("!!document.querySelector('.tsm-modal')"))
    q("Tasmee.open()"); pg.wait_for_timeout(150); pg.keyboard.press("Control+k"); pg.wait_for_timeout(250)
    check("Ctrl+K closes the start window and opens search", not q("!!document.querySelector('.tsm-modal')") and q("document.getElementById('searchModalBackdrop').classList.contains('active')"))
    q("closeModal()")

    # settings
    pg.click("#settingsBtn"); pg.wait_for_timeout(300)
    check("settings: tasmee section", q("!!document.querySelector('[data-seg=tsmLevel]') && !!document.querySelector('[data-act=tasmeelog]')"))
    pg.click("[data-seg=tsmReveal] [data-v='0']"); pg.wait_for_timeout(100)
    check("settings: «لا تكشفها أبدًا» saved", q("Tasmee.prefs().reveal") == 0)
    pg.click("[data-seg=tsmReveal] [data-v='3']"); pg.wait_for_timeout(100)
    pg.keyboard.press("Escape")

    # corrupted log does not break anything
    q("localStorage.setItem('tasmee_log.v1', '{\"words\":{\"x\":5,\"1:1:0\":{\"e\":\"a\"},\"1:1:1\":{\"e\":2,\"n\":1}}}')")
    q("Tasmee.openLog()"); pg.wait_for_timeout(150)
    check("broken log rows are dropped, the window opens", q("document.querySelectorAll('.tsm-lr').length") == 1)
    q("Tasmee.closeModal()")

    # phone
    m = br.new_context(viewport={"width": 320, "height": 700}, device_scale_factor=2, is_mobile=True, has_touch=True); m.add_init_script(INIT)
    mp = m.new_page(); mp.on("pageerror", lambda e: errs.append("PAGEERROR m " + str(e)))
    mp.goto(URL + "#p=3", wait_until="load"); mp.wait_for_timeout(1500)
    mp.evaluate("Tasmee.setPref('mode', 'eye'); Tasmee.open()"); mp.wait_for_timeout(200)
    check("320px: start window fits", mp.evaluate("document.documentElement.scrollWidth") <= 320 and mp.evaluate("document.querySelector('.tsm-card').getBoundingClientRect().right") <= 320)
    if OUT: mp.screenshot(path=OUT + "_phone_start.png")
    mp.click("[data-s=go]"); mp.wait_for_timeout(300)
    check("320px: bar fits, no sideways scroll", mp.evaluate("document.documentElement.scrollWidth") <= 320 and mp.evaluate("document.getElementById('tsmBar').getBoundingClientRect().right") <= 320)
    mp.tap("#tsmBar [data-tsm=next]"); mp.tap("#tsmBar [data-tsm=next]"); mp.wait_for_timeout(100)
    check("320px: «التالية» button works", mp.evaluate("Tasmee._state().T.i") == 2)
    if OUT: mp.screenshot(path=OUT + "_phone.png")

    check("no page errors", not errs, "\n".join(errs[:6]))
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
