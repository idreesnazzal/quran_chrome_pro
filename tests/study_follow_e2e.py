"""«صفحة وآيات» + 🎙️ التسميع بالمايك: the list on the left follows the ayah being recited, as a tap would.

Real page, Chrome's recogniser faked and fed al-Minshawi's word times (the data of browser_e2e.py).
  1. desktop, page 562, التفسير: tap 67:1, recite 67:2-5; switch to معاني الكلمات then سبب النزول mid-way.
     Every 80 ms: the outlined card = the ayah highlighted on the page, and (once its scroll had time) it is
     inside the list's view. The window itself is not scrolled by the list.
  2. a page turn: 2:255-257 from page 42 (257 is on 43): the rebuilt list marks the new ayah.
  3. the mic stopped: a tap on another ayah still marks and scrolls to it.
  4. a phone (390 px) on «الصفحة»: no switch to the list; the card is marked; «آيات الصفحة» opens on it.
usage: python tests/study_follow_e2e.py [port]     (server running)"""
import os, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
src = open(os.path.join(HERE, "browser_e2e.py"), encoding="utf-8").read().split("def run(")[0]
ns = {"__name__": "x", "__file__": os.path.join(HERE, "browser_e2e.py")}
sys.argv = sys.argv[:1] + [PORT]; exec(src, ns)
timeline, INIT = ns["timeline"], ns["INIT"]
INIT += """
try { localStorage.setItem('mushaf_view_mode', 'study'); localStorage.setItem('study_content', 'tafsir');
      localStorage.setItem('study_tafsir_source', 'muyassar'); } catch (e) {}"""

SAMPLE = """() => { const hl = currentHighlightedAyah ? currentHighlightedAyah.sura + ':' + currentHighlightedAyah.aya : '';
  const ons = [...document.querySelectorAll('#studyList .sp-item.on')], on = ons.map((e) => e.dataset.s + ':' + e.dataset.a).join(',');
  const list = document.getElementById('studyList'), L = list.getBoundingClientRect();
  let vis = false;
  if (ons[0]) { const r = ons[0].getBoundingClientRect(), narrow = matchMedia('(max-width: 899px)').matches;
    const top = narrow ? 0 : L.top, bot = narrow ? innerHeight : L.bottom;
    vis = r.top >= top - 2 && r.top < bot - 40; }      // its head is in view
  const tab = (document.querySelector('#studyPanel .sp-tabs button.on') || {}).dataset;
  const has = !!(hl && document.getElementById('sp-' + hl.replace(':', '-')));   // the ayah is on the listed page
  return [has ? hl : '', on, vis, tab ? tab.k : '', scrollY, currentPage]; }"""
TAP = """([s, a]) => { highlightSearchedAyah(s, a, ''); const b = document.querySelector('.searched-ayah-shadow').getBoundingClientRect();
  clearAyahHighlight(); return [b.x + b.width / 2, b.y + b.height / 2]; }"""

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond: fails.append(name)

def recite(pg, sura, a0, a1, tabs=()):
    """feed the passage at real speed; tabs = [(seconds, tab key)]; returns samples [t, hl, on, vis, tab, scrollY, page]"""
    _, events = timeline(sura, a0, a1)
    events = events + [{"t": t, "tab": k} for t, k in tabs]
    events.sort(key=lambda e: e["t"])
    pg.evaluate("startVoiceRecitation()"); pg.wait_for_timeout(400)
    return pg.evaluate("""async ([events, SAMPLE]) => {
      const sample = eval('(' + SAMPLE + ')'), out = [], t0 = performance.now();
      const iv = setInterval(() => out.push([performance.now() - t0].concat(sample())), 80);
      for (const ev of events) {
        const wait = t0 + ev.t * 1000 - performance.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
        if (ev.tab) { document.querySelector('#studyPanel .sp-tabs button[data-k="' + ev.tab + '"]').click(); continue; }
        const results = ev.results.map(([t, fin]) => { const o = [{ transcript: t, confidence: 0.9 }]; o.isFinal = fin; return o; });
        window.__rec.onresult({ resultIndex: ev.idx, results });
      }
      await new Promise(r => setTimeout(r, 1500)); clearInterval(iv); out.push([performance.now() - t0].concat(sample()));
      stopVoiceRecitation(); return out; }""", [events, SAMPLE])

def judge(name, S, want):
    """every sample: the outlined card is the highlighted ayah; 700 ms after a change it is in view"""
    bad, hidden, seen, since, last = [], [], [], 0, None
    for t, hl, on, vis, tab, y, page in S:
        if not hl: continue
        if hl != last: last, since = hl, t; seen.append(hl)
        if on != hl: bad.append((round(t), hl, on, tab))
        elif t - since > 700 and not vis: hidden.append((round(t), hl, tab))
    check(f"{name}: the ayat followed {want}", [a for a in want if a in seen] == want, seen)
    check(f"{name}: the outlined card is always the ayah highlighted on the page", not bad, bad[:6])
    check(f"{name}: it is in view without a tap", not hidden, hidden[:6])

with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    ctx = br.new_context(viewport={"width": 1366, "height": 900}); ctx.add_init_script(INIT)
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(f"http://127.0.0.1:{PORT}/#p=562", wait_until="load", timeout=120000); pg.wait_for_timeout(1500)
    pg.evaluate("goToPage(562)"); pg.wait_for_timeout(300)

    # 1. tap 67:1, then recite 67:2-5 switching the tab twice
    x, y = pg.evaluate(TAP, [67, 1]); pg.mouse.click(x, y); pg.wait_for_timeout(300)
    s = pg.evaluate(SAMPLE)
    check("the tap on 67:1 marks its card", s[0] == "67:1" and s[1] == "67:1", s)
    y0 = pg.evaluate("scrollY")
    _, ev = timeline(67, 2, 5)
    finals = [e["t"] for e in ev if all(f for _, f in e["results"])]          # end of each ayah
    S = recite(pg, 67, 2, 5, tabs=[(finals[0] + 0.5, "words"), (finals[2] + 0.5, "nuzul")])
    judge("67:2-5 on page 562", S, ["67:2", "67:3", "67:4", "67:5"])
    tabs_at = {}
    for t, hl, on, vis, tab, *_ in S: tabs_at.setdefault(tab, []).append(hl)
    check("the tab changed mid-way and the new tab followed too (tafsir -> words -> nuzul)",
          list(tabs_at) == ["tafsir", "words", "nuzul"] and len(set(tabs_at["words"])) >= 2 and len(set(tabs_at["nuzul"])) >= 1, {k: sorted(set(v)) for k, v in tabs_at.items()})
    check("the list scrolls itself, not the window over the cards", max(r[5] for r in S) - min(r[5] for r in S) < 400, (y0, min(r[5] for r in S), max(r[5] for r in S)))
    pg.screenshot(path=os.environ.get("SHOT", os.path.join(HERE, "..", "_debug", "study_follow.png")))

    # 2. a page turn: 2:255-257 from page 42
    pg.evaluate("document.querySelector('#studyPanel .sp-tabs button[data-k=\"tafsir\"]').click(); clearAyahHighlight(); goToPage(42)"); pg.wait_for_timeout(400)
    S = recite(pg, 2, 255, 257)
    judge("2:255-257 across the page turn 42 -> 43", S, ["2:255", "2:256", "2:257"])
    check("...the page turned and the list is page 43's", S[-1][6] == 43 and pg.evaluate("!!document.getElementById('sp-2-257')"), S[-1])

    # 3. the mic stopped: a manual tap
    x, y = pg.evaluate(TAP, [2, 258]); pg.mouse.click(x, y); pg.wait_for_timeout(900)
    s = pg.evaluate(SAMPLE)
    check("mic stopped: a tap on 2:258 marks it and brings it into view", s[0] == "2:258" and s[1] == "2:258" and s[2], s)
    x, y = pg.evaluate(TAP, [2, 257]); pg.mouse.click(x, y); pg.wait_for_timeout(900)
    s = pg.evaluate(SAMPLE)
    check("...and a tap back on 2:257 too", s[0] == "2:257" and s[1] == "2:257" and s[2], s)
    check("no page errors (desktop)", not errs, errs)
    ctx.close()

    # 4. a phone on «الصفحة»
    m = br.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True); m.add_init_script(INIT)
    mp = m.new_page(); merr = []; mp.on("pageerror", lambda e: merr.append(str(e)[:200]))
    mp.goto(f"http://127.0.0.1:{PORT}/#p=562", wait_until="load", timeout=120000); mp.wait_for_timeout(1500)
    mp.evaluate("goToPage(562)"); mp.wait_for_timeout(300)
    S = recite(mp, 67, 1, 3)
    view = mp.evaluate("studyPhone")
    check("phone: reciting does not switch «الصفحة» to the list", view == "page", view)
    check("phone: the card of the ayah read is marked", S[-1][1] == S[-1][2] == "67:3", S[-1])
    mp.evaluate("startVoiceRecitation()"); mp.wait_for_timeout(300)        # the mic on while the list is opened
    mp.tap("#studySwitch button[data-view=list]"); mp.wait_for_timeout(500)
    s = mp.evaluate(SAMPLE)
    check("phone: «آيات الصفحة» opens on the ayah being read", s[1] == "67:3" and s[2], s)
    mp.evaluate("stopVoiceRecitation()")
    check("no page errors (phone)", not merr, merr)
    m.close(); br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
