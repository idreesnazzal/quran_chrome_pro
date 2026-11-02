"""وضع التسميع on the reader's own Chrome sessions (2026-11-02, al-Naba 1-7,
read correctly): every recorded event replayed at its real time (x3) into the
page. Chrome wrote «كل» for «كلا», «ان» for «عم», «الاردن هذا» for «الارض
مهادا»: none of it may count as a mistake.

usage: python tests/tasmee_real.py [port]   (server running)"""
import sys, json, os
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
HERE = os.path.dirname(os.path.abspath(__file__))
SPEED = 3.0
INIT = """window.SpeechRecognition = window.webkitSpeechRecognition = function () {
  window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); }; this.stop = () => {}; this.abort = () => {}; };
try { localStorage.setItem('recite_ears', 'browser'); localStorage.setItem('recite_ears_v', '3'); } catch (e) {}"""
SEND = """(e) => { const rs = e.res.map(r => { const o = [{ transcript: r.t }]; o.isFinal = r.fin; return o; });
  window.__rec.onresult({ resultIndex: e.ri, results: rs }); }"""
STATE = """() => { const st = Tasmee._state(), T = st.T, X = st.X; if (!X) return null;
  const s = Tasmee.Core.summary(T, X); return { i: T.i, err: s.err, uns: s.uns, reached: s.reached,
  red: [...document.querySelectorAll('.tsm-w.tsm-err')].length }; }"""

def events(S):
    # same-timestamp lines are one event; its results = the finals so far + this group
    groups, order, evs, finals = {}, [], [], []
    for t, kind, txt in S["events"]:
        if kind not in ("interim", "final"): continue
        if t not in groups: groups[t] = []; order.append(t)
        groups[t].append((kind, txt))
    for t in order:
        g = groups[t]
        evs.append({"at": t, "ri": len(finals), "res": [{"t": f, "fin": True} for f in finals] + [{"t": x, "fin": k == "final"} for k, x in g]})
        finals += [x for k, x in g if k == "final"]
    return evs

# (file, words of al-Naba reached: 78:1-7 = 20, 78:1-5 = 14)
CASES = [("tasmee_real_naba_1.json", 20), ("tasmee_real_naba_2.json", 14)]
fails = []
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    for name, want in CASES:
        ctx = br.new_context(viewport={"width": 1366, "height": 900}); ctx.add_init_script(INIT)
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{PORT}/#p=582", wait_until="load"); pg.wait_for_timeout(1500)
        pg.click("#tasmeeBtn"); pg.wait_for_timeout(300)
        prev, worst = 0, 0
        for e in events(json.load(open(os.path.join(HERE, "data", name), encoding="utf-8"))):
            pg.wait_for_timeout(max(0, (e["at"] - prev) / SPEED)); prev = e["at"]
            pg.evaluate(SEND, e)
        pg.wait_for_timeout(300)
        s = pg.evaluate(STATE)
        ok = s is not None and s["i"] >= want and s["err"] == 0 and s["red"] == 0 and not errs
        print(("PASS " if ok else "FAIL ") + name + f": {want} words read right, no mistakes", "" if ok else (s, errs))
        if not ok: fails.append(name)
        ctx.close()
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
