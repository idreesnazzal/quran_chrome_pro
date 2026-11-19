"""«تسميع سلس» in a real browser (recogniser mocked): picked in the start window or ⚙️, the covers open as the words
are said (interim words at once), never a colour, a wrong last word waits, a tap peeks, 💡 helps, the page follows,
nothing reaches the error log or «أخطاء التسميع», and the judging mode is untouched.
usage: python tests/tasmee_smooth_e2e.py [port] [screenshot-dir]   (server running)"""
import sys, json
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
INIT = """window.SpeechRecognition = window.webkitSpeechRecognition = function () {
  window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); }; this.stop = () => {}; this.abort = () => {}; };
try { localStorage.removeItem('tasmee_prefs'); } catch (e) {}"""
# a final result / an interim one (Chrome's results list: the finals so far, then this one)
SAY = """([t, fin]) => { window.__n = (window.__n || 0); const res = []; for (let k = 0; k < window.__n; k++) { const x = [{ transcript: '' }]; x.isFinal = true; res[k] = x; }
  const r = [{ transcript: t }]; r.isFinal = fin; res[window.__n] = r; window.__rec.onresult({ resultIndex: window.__n, results: res }); if (fin) window.__n++; }"""
ST = """() => { const st = Tasmee._state(); if (!st) return null; const T = st.shown, X = st.X; if (!X) return { wait: true, smooth: st.smooth, bar: (document.getElementById('tsmBar') || {}).innerText || '' };
  const C = ReciteByMic.corpus(), at = (k) => { const p = st.at[Math.min(k, X.N - 1)], A = C.ayahs[p.ai]; return A.sura + ':' + A.aya + ':' + (p.w + 1); };
  const open = [...document.querySelectorAll('.tsm-w.tsm-ok')].length;
  return { smooth: st.smooth, engine: X.engine, i: T.i, at: at(T.i), word: X.E[T.i], open, help: st.acc.help || 0,
    colours: [...document.querySelectorAll('.tsm-w.tsm-err, .tsm-w.tsm-uns, .tsm-w.tsm-fix, .tsm-w.tsm-over')].length,
    cur: (document.querySelector('.tsm-w.tsm-cur') || {}).className || '', page: currentPage,
    bar: (document.getElementById('tsmBar') || {}).innerText || '' }; }"""
BOX = """(k) => { const el = document.querySelector('.tsm-w[data-k="' + k + '"]'); el.scrollIntoView({ block: 'center' }); const r = document.querySelector('.tsm-w[data-k="' + k + '"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }"""
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
    pg.add_script_tag(url=f"http://127.0.0.1:{PORT}/tests/arabic_join_audit.js")
    say = lambda t, fin=True: (pg.evaluate(SAY, [t, fin]), pg.wait_for_timeout(160))
    log0 = pg.evaluate("localStorage.getItem('tasmee_log.v1')"); tech0 = pg.evaluate("localStorage.getItem('tasmee_tech.v1')")
    lists0 = pg.evaluate("localStorage.getItem('ayahLists')")

    # 1. the start window: the way to recite, then the ear
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    styles = pg.locator(".tsm-style button").all_inner_texts()
    check("🧠: the start window offers «🎯 يحكم» and «🌊 سلس», «يحكم» on by default",
          len(styles) == 2 and "يحكم" in styles[0] and "سلس" in styles[1] and pg.evaluate("document.querySelector('.tsm-style .on').dataset.style") == "judge", styles)
    pg.click(".tsm-style [data-style=smooth]"); pg.wait_for_timeout(120)
    check("«سلس» picked: remembered, the window stays open for the ear", pg.evaluate("Tasmee.prefs().smooth === true && !!document.querySelector('.tsm-choose') && !Tasmee.isOn()"))
    check("chooser: no two Arabic words run together", not pg.evaluate("window.__joinAudit(document.querySelector('.tsm-choose'))"), pg.evaluate("window.__joinAudit(document.querySelector('.tsm-choose'))"))
    if SHOTS: pg.screenshot(path=SHOTS + "/smooth_choose.png")
    pg.click(".tsm-tech[data-tech=chrome]"); pg.wait_for_timeout(400)
    s = pg.evaluate(ST)
    check("the mode runs smooth: body.tsm-smooth, bar «🌊 تسميع سلس», no ✓/✗ counters, no 📋",
          s and s["smooth"] and pg.evaluate("document.body.classList.contains('tsm-smooth')") and "تسميع سلس" in s["bar"] and "✗" not in s["bar"]
          and not pg.evaluate("!!document.querySelector('#tsmBar [data-tsm=log]')"), s)

    # 2. reading 2:1-4: interim words open at once, the final keeps them; Chrome's noise opens plain
    say("الم ذلك الكتاب", False)
    s = pg.evaluate(ST)
    check("interim «الم ذلك الكتاب»: the start is found and those words open at once", s and not s.get("wait") and s["engine"] == "smooth" and s["at"] == "2:2:3" and s["open"] == 3, s)
    say("الم ذلك الكتاب لا ريب فيه هدى للمتقين")
    say("الذين يؤمنون بالغيب ويقيمون الصلات ومما رزقناهم ينفقون")
    s = pg.evaluate(ST)
    check("«الصلات» for «الصلاة» inside the reading: opened, no colour, the test at 2:4", s["at"] == "2:4:1" and s["colours"] == 0, s)

    # 3. a wrong last word waits (covered, no red); said right, it opens
    say("والذين يؤمنون بما انزل اليك وما انزل من قبلك وبالاخره هم مسرورون")
    s = pg.evaluate(ST)
    check("wrong last word («مسرورون» for «يوقنون»): it stays covered at the cursor, nothing red",
          s["word"] == "يوقنون" and "tsm-ok" not in s["cur"] and s["colours"] == 0, s)
    if SHOTS: pg.screenshot(path=SHOTS + "/smooth_waits.png")

    # 4. a tap peeks (the test does not move), 💡 opens the next word (a gold line, not red)
    k = s["i"]; xy = pg.evaluate(BOX, k)
    pg.mouse.click(xy[0], xy[1]); pg.wait_for_timeout(120)
    s2 = pg.evaluate(ST)
    check("tap on the covered word: it shows for a moment (peek), the cursor stays", "tsm-peek" in s2["cur"] and s2["i"] == k and s2["help"] == 1, s2)
    pg.wait_for_timeout(1900)
    check("...and covers again by itself", "tsm-peek" not in pg.evaluate(ST)["cur"])
    say("يوقنون")
    s = pg.evaluate(ST)
    check("said right: «يوقنون» opens, the test goes on to 2:5", s["at"] == "2:5:1" and s["colours"] == 0, s)
    pg.keyboard.press("Home"); pg.wait_for_timeout(150)
    s = pg.evaluate(ST)
    hinted = pg.evaluate("document.querySelector('.tsm-w[data-k=\"%d\"]').className" % (s["i"] - 1))
    check("💡 (Home): the next word opens with a thin gold line, counted as help, not a mistake",
          "tsm-hinted" in hinted and s["help"] == 2 and s["colours"] == 0 and "💡 2" in s["bar"], [hinted, s])

    # 5. on to the next page: the covers follow
    say("على هدى من ربهم واولئك هم المفلحون")
    say("ان الذين كفروا سواء عليهم اانذرتهم ام لم تنذرهم لا يؤمنون")
    s = pg.evaluate(ST)
    check("2:5 then 2:6: the page turned to 3 and the covers follow", s["page"] == 3 and s["at"] == "2:7:1" and s["colours"] == 0, s)
    check("bar: no two Arabic words run together", not pg.evaluate("window.__joinAudit(document.getElementById('tsmBar'))"))
    if SHOTS: pg.screenshot(path=SHOTS + "/smooth_reading.png")

    # 6. the end: a calm card, nothing saved as a mistake anywhere
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    done = pg.evaluate("(document.getElementById('tsmDone') || {}).innerText || ''")
    check("end card: «🌊 انتهى التسميع», the words read, no score and no ✗", "🌊" in done and "✗" not in done and "%" not in done and "كلمة" in done, done)
    check("nothing written to the error log, the ear table or the lists",
          pg.evaluate("localStorage.getItem('tasmee_log.v1')") == log0 and pg.evaluate("localStorage.getItem('tasmee_tech.v1')") == tech0
          and pg.evaluate("localStorage.getItem('ayahLists')") == lists0)
    if SHOTS: pg.screenshot(path=SHOTS + "/smooth_done.png")
    pg.click("#tsmDone [data-d=again]"); pg.wait_for_timeout(300)
    check("«⟲ من جديد»: starts smooth again", pg.evaluate("Tasmee.isOn() && Tasmee._state().smooth"))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200); pg.evaluate("document.getElementById('tsmDone') && document.getElementById('tsmDone').remove()")

    # 7. ⚙️: the same choice; back to «يحكم» and the judging engine is as before
    pg.evaluate("MushafSettings.open()"); pg.wait_for_timeout(400)
    check("⚙️ shows «طريقة التسميع» on «سلس», the «الحكم» row hidden",
          pg.evaluate("!!document.querySelector('[data-seg=tsmStyle] button.on[data-v=smooth]') && !document.querySelector('[data-seg=tsmLevel]')"))
    pg.click("[data-seg=tsmStyle] button[data-v=judge]"); pg.wait_for_timeout(200)
    check("⚙️ «يحكم»: saved, «الحكم» row back", pg.evaluate("Tasmee.prefs().smooth === false && !!document.querySelector('[data-seg=tsmLevel]')"))
    pg.evaluate("MushafSettings.close()"); pg.wait_for_timeout(300)
    pg.evaluate("goToPage(3)"); pg.wait_for_timeout(300)
    pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
    check("the start window now has «يحكم» on", pg.evaluate("document.querySelector('.tsm-style .on').dataset.style") == "judge")
    pg.click(".tsm-tech[data-tech=chrome]"); pg.wait_for_timeout(300)
    say("ان الذين كفروا سواء عليهم اانذرتهم ام لم تنذرهم لا يؤمنون")   # (the start is found from words that run on exactly)
    say("ختم الله على قلوبهم وعلى سمعهم وعلى ابصارهم غشاوه ولهم عذاب اليم")
    say("ومن الناس من يقول امنا بالله")
    s = pg.evaluate(ST)
    check("«يحكم» unchanged: engine v2, «اليم» for «عظيم» is red", s["engine"] == "v2" and not s["smooth"] and s["colours"] == 1, s)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)

    # 8. a phone: the start window and the bar fit
    ph = br.new_context(viewport={"width": 360, "height": 760}, is_mobile=True, has_touch=True); ph.add_init_script(INIT)
    pp = ph.new_page(); pp.on("pageerror", lambda e: errs.append(str(e)))
    pp.goto(f"http://127.0.0.1:{PORT}/#p=2", wait_until="load"); pp.wait_for_timeout(1500)
    pp.evaluate("ReciteByMic.config.testNoCapture = true")
    pp.click("#tasmeeBtn"); pp.wait_for_timeout(300); pp.click(".tsm-style [data-style=smooth]"); pp.wait_for_timeout(100)
    over = pp.evaluate("(() => { const c = document.querySelector('.tsm-choose'), r = c.getBoundingClientRect(); return [r.left >= -1 && r.right <= innerWidth + 1, document.documentElement.scrollWidth <= innerWidth + 1]; })()")
    check("phone 360px: the start window fits, no sideways scroll", all(over), over)
    if SHOTS: pp.screenshot(path=SHOTS + "/smooth_choose_phone.png")
    pp.click(".tsm-tech[data-tech=chrome]"); pp.wait_for_timeout(400)
    pp.evaluate(SAY, ["الم ذلك الكتاب لا ريب فيه هدى للمتقين", True]); pp.wait_for_timeout(250)
    bar = pp.evaluate("(() => { const b = document.getElementById('tsmBar').getBoundingClientRect(); return [b.right <= innerWidth + 1, document.documentElement.scrollWidth <= innerWidth + 1, document.getElementById('tsmBar').innerText]; })()")
    check("phone: the bar fits and shows 📖 words read", bar[0] and bar[1] and "📖" in bar[2], bar)
    if SHOTS: pp.screenshot(path=SHOTS + "/smooth_phone.png")
    ph.close()

    check("no page errors", not errs, errs[:3])
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
