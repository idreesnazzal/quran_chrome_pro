"""Real-browser test of the recite feature: the REAL page and paint path.

tests/run_tests.js drives the engine in Node, where the highlighting code
(paint -> onVoiceAyahDetected) never runs. A crash there (3.3.2 of
2026-10-17: CORPUS.isBasmala undefined) left the page frozen while every Node
test passed. This test opens the app in headless Chrome, replaces Chrome's
recogniser with a fake, and feeds results at the real word times of a reciter.

Data: tests/data/minshawi_general_asr.json = al-Minshawi (murattal, the
app's default reciter, everyayah.com) transcribed by a GENERAL Arabic model
(Whisper large-v3-turbo, not Quran-tuned) with word timestamps: a stand-in for
Chrome's ar-SA recogniser. Each ayah is one utterance: interim results grow
word by word at each word's end time, then the final.

Checks per passage: no page errors; every ayah highlighted; every word of it
painted (word by word); nothing highlighted outside the passage.

usage: python tests/browser_e2e.py [port]     (server must be running; Open Mushaf.cmd)
needs: pip install playwright, and Google Chrome installed."""
import json, os, sys
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"
ASR = json.load(open(os.path.join(HERE, "data", "minshawi_general_asr.json"), encoding="utf-8"))
PASSAGES = [  # (open page, sura, first aya, last aya)
    (596, 94, 1, 8),     # al-Sharh on its page
    (1, 94, 1, 8),       # al-Sharh while page 1 is open: must jump
    (604, 112, 1, 4),    # al-Ikhlas
    (562, 67, 1, 5),     # al-Mulk 1-5
    (42, 2, 255, 257),   # Ayat al-Kursi (shared with 3:2 for 7 words) + page turn to 43
]
INIT = """window.SpeechRecognition = window.webkitSpeechRecognition = function () {
  window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); };
  this.stop = () => {}; this.abort = () => {}; };
try { localStorage.setItem('recite_ears', 'browser'); localStorage.setItem('recite_ears_v', '3'); } catch (e) {}"""


def timeline(sura, a0, a1):
    utts, t0 = [], 0.0
    for a in range(a0, a1 + 1):
        A = ASR["Minshawy_%03d%03d.mp3" % (sura, a)]
        ws = [w for w in A["words"] if w["w"] and not w["w"].rstrip(".").isdigit()]
        utts.append([(t0 + w["e"], w["w"]) for w in ws])
        t0 += A["dur"] + 0.6
    events, finals = [], []
    for u in utts:
        for k in range(1, len(u) + 1):
            events.append({"t": u[k - 1][0], "idx": len(finals),
                           "results": [[f, True] for f in finals] + [[" ".join(w for _, w in u[:k]), False]]})
        finals.append(" ".join(w for _, w in u))
        events.append({"t": u[-1][0] + 0.35, "idx": len(finals) - 1, "results": [[f, True] for f in finals]})
    return utts, events


def run(pg, page_no, sura, a0, a1):
    utts, events = timeline(sura, a0, a1)
    pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load", timeout=120000)
    pg.wait_for_timeout(1200)
    pg.evaluate(f"""() => {{ goToPage({page_no}); window.__paints = [];
      const orig = window.onVoiceAyahDetected;
      window.onVoiceAyahDetected = function (m) {{
        window.__paints.push([performance.now(), m.bestAyah.sura + ':' + m.bestAyah.aya, m.activeWordIdx]);
        return orig.apply(this, arguments); }};
      startVoiceRecitation(); }}""")
    pg.wait_for_timeout(400)
    res = pg.evaluate("""async (events) => {
      const t0 = performance.now();
      for (const ev of events) {
        const wait = t0 + ev.t * 1000 - performance.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const results = ev.results.map(([t, fin]) => { const o = [{ transcript: t, confidence: 0.9 }]; o.isFinal = fin; return o; });
        window.__rec.onresult({ resultIndex: ev.idx, results });
      }
      await new Promise(r => setTimeout(r, 1200));
      stopVoiceRecitation();
      return window.__paints.map(([t, a, w]) => [t - t0, a, w]);
    }""", events)
    want = {"%d:%d" % (sura, a0 + i): (u[0][0] * 1000, len(u)) for i, u in enumerate(utts)}
    first, words = {}, {}
    for t, a, w in res:
        first.setdefault(a, t)
        words.setdefault(a, set()).add(w)
    counts = pg.evaluate("""(keys) => keys.map(k => { const [s, a] = k.split(':').map(Number);
      return ReciteByMic.corpus().ayahs.find(x => x.sura === s && x.aya === a).wordCount; })""", list(want))
    problems, rows = [], []
    for (a, (st, _)), n in zip(want.items(), counts):
        if a not in first:
            problems.append(a + " never highlighted"); continue
        got = len([w for w in words[a] if w >= 0])
        rows.append(f"{a} +{(first[a] - st) / 1000:.2f}s {got}/{n}w")
        if got < n: problems.append(f"{a}: only {got} of {n} words painted")
    outside = sorted({a for _, a, _ in res if a not in want})
    if outside: problems.append("highlighted outside the passage: " + ", ".join(outside))
    return rows, problems


fails = 0
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    ctx = br.new_context(viewport={"width": 1366, "height": 900})
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    for page_no, sura, a0, a1 in PASSAGES:
        errs.clear()
        rows, problems = run(pg, page_no, sura, a0, a1)
        if errs: problems.append(f"{len(errs)} page errors, first: {errs[0]}")
        ok = not problems
        fails += not ok
        print(f"\n{'ok  ' if ok else 'FAIL'} page {page_no}, {sura}:{a0}-{a1}: " + " | ".join(rows))
        for pr in problems: print("       ->", pr)
    ver = pg.evaluate("ReciteByMic.version")
    br.close()
print(f"\nengine {ver}: {len(PASSAGES) - fails} passed, {fails} failed")
sys.exit(1 if fails else 0)
