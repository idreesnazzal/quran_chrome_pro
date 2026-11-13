"""The Quran ear (Tilawi FastConformer CTC) in وضع التسميع, on real reciters' audio (everyayah.com):

  A. ears = 'ctc' (the Quran ear alone): al-Minshawi reciting 78:1-5 is pushed into the engine's capture;
     the test must follow it to 78:6 with no mistake.
  B. ears = 'rescue' (Chrome leads): Chrome's real transcript of the reader's 78:14 («وانزلنا من المعصرات ما
     انزل الزجاجا», 2026-11-13) makes «ثجاجا» red; the Quran ear re-hears al-Minshawi's 78:14 from the
     ring buffer and must clear it (and never add a mistake).

Needs the local server with the ear (server/recite_server.py: POST /ctc, pip install onnxruntime) or the
model in the browser. usage: python tests/tasmee_ears.py [port]"""
import sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
PORT = sys.argv[1] if len(sys.argv) > 1 else "8001"

INIT = """(ears) => {}"""
FAKE_SR = """window.SpeechRecognition = window.webkitSpeechRecognition = function () {
  window.__rec = this; this.start = () => { setTimeout(() => this.onstart && this.onstart(), 0); }; this.stop = () => {}; this.abort = () => {}; };"""
AUDIO = """async (list) => {   // everyayah mp3s -> one 16 kHz Float32Array, 0.6 s of silence between ayat
  const parts = [];
  for (const [folder, s, a] of list) {
    const url = `https://everyayah.com/data/${folder}/${String(s).padStart(3, '0')}${String(a).padStart(3, '0')}.mp3`;
    const buf = await (await fetch(url)).arrayBuffer(), ac = new AudioContext(), dec = await ac.decodeAudioData(buf);
    const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000), src = off.createBufferSource();
    src.buffer = dec; src.connect(off.destination); src.start(); parts.push((await off.startRendering()).getChannelData(0)); ac.close();
    parts.push(new Float32Array(9600));
  }
  const n = parts.reduce((x, p) => x + p.length, 0), out = new Float32Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  window.__audio = out; return n / 16000;
}"""
STATE = """() => { const st = Tasmee._state(); if (!st || !st.X) return null; const T = st.T, C = ReciteByMic.corpus();
  const at = st.at[Math.min(T.i, st.at.length - 1)], A = C.ayahs[at.ai], s = Tasmee.Core.summary(T, st.X);
  return { at: A.sura + ":" + A.aya + ":" + (at.w + 1), err: s.err, accErr: st.acc.err, rescued: st.acc.rescued || 0, last: st.lastRescue,
           red: Array.from(T.st).filter((x) => x === 2).length }; }"""

def page(br, ears, force=""):
    ctx = br.new_context(viewport={"width": 1366, "height": 900})
    ctx.add_init_script(FAKE_SR + f"""try {{ localStorage.setItem('recite_ears', '{ears}'); localStorage.setItem('recite_ears_v', '3');
      localStorage.setItem('recite_model_ok', '1'); localStorage.setItem('recite_whisper_force', '{force}'); }} catch (e) {{}}""")
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{PORT}/#p=582", wait_until="load"); pg.wait_for_timeout(1200)
    pg.evaluate("ReciteByMic.config.testNoCapture = true")
    return ctx, pg, errs

fails = []
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)

    # A. the Quran ear alone
    ctx, pg, errs = page(br, "ctc")
    pg.click("#tasmeeBtn")
    pg.wait_for_function("ReciteByMic._lw.ready", timeout=120000)
    dev = pg.evaluate("ReciteByMic._lw.device")
    sec = pg.evaluate(AUDIO, [["Minshawy_Murattal_128kbps", 78, a] for a in range(1, 6)])
    pg.evaluate("""async () => { const a = window.__audio;   // real time x2, in 100 ms blocks
      for (let o = 0; o < a.length; o += 1600) { ReciteByMic._lwFeed(a.subarray(o, o + 1600)); await new Promise((r) => setTimeout(r, 50)); }
      for (let k = 0; k < 15; k++) { ReciteByMic._lwFeed(new Float32Array(1600)); await new Promise((r) => setTimeout(r, 50)); } }""")
    pg.wait_for_timeout(4000)
    s = pg.evaluate(STATE)
    ok = bool(s) and s["at"].startswith("78:6") and s["err"] == 0 and s["accErr"] == 0 and not errs
    print(("PASS " if ok else "FAIL ") + f"A. Quran ear alone ({dev}): al-Minshawi 78:1-5 ({sec:.0f} s) followed to 78:6, no mistake", "" if ok else (s, errs))
    if not ok: fails.append("A")
    ctx.close()

    # B. Chrome leads, the Quran ear rescues
    ctx, pg, errs = page(br, "rescue")
    pg.click("#tasmeeBtn")
    pg.wait_for_function("ReciteByMic._lw.ready", timeout=120000)
    finals = ["عم يتساءلون عن النبا العظيم الذي هم فيه مختلفون", "كلا سيعلمون ثم كلا سيعلمون", "الم نجعل الارض مهادا والجبال اوتادا",
              "وخلقناكم ازواجا وجعلنا نومكم سباتا", "وجعلنا الليل لباسا وجعلنا النهار معاشا", "وبنينا فوقكم سبعا شدادا وجعلنا سراجا وهاجا"]
    send = """([i, t]) => { const r = [{ transcript: t }]; r.isFinal = true; const res = []; res[i] = r;
      for (let k = 0; k < i; k++) { const x = [{ transcript: '' }]; x.isFinal = true; res[k] = x; }
      window.__rec.onresult({ resultIndex: i, results: res }); }"""
    for i, t in enumerate(finals):
        pg.evaluate(send, [i, t]); pg.wait_for_timeout(150)
    pg.evaluate(AUDIO, [["Minshawy_Murattal_128kbps", 78, 14]])
    pg.evaluate("() => { const a = window.__audio; for (let k = 0; k < a.length; k++) ReciteByMic._ringPush(a[k]); }")
    pg.evaluate(send, [len(finals), "وانزلنا من المعصرات ما انزل الزجاجا"])
    red_at_once = pg.evaluate(STATE)
    pg.wait_for_timeout(6000)
    s = pg.evaluate(STATE)
    ok = bool(s) and s["red"] == 0 and s["err"] == 0 and s["rescued"] >= 1 and s["at"].startswith("78:15") and not errs
    print(("PASS " if ok else "FAIL ") + "B. rescue: Chrome's «ما انزل الزجاجا» red, the Quran ear clears «ثجاجا», the test goes on to 78:15",
          f"(red at first: {red_at_once['red'] if red_at_once else '?'})" if ok else (red_at_once, s, errs))
    if not ok: fails.append("B")
    ctx.close()

    # C. the rescue never clears what it did not hear: the ring holds 78:13, not «ثجاجا» -> it stays a mistake
    ctx, pg, errs = page(br, "rescue")
    pg.click("#tasmeeBtn")
    pg.wait_for_function("ReciteByMic._lw.ready", timeout=120000)
    for i, t in enumerate(finals):
        pg.evaluate(send, [i, t]); pg.wait_for_timeout(150)
    pg.evaluate(AUDIO, [["Minshawy_Murattal_128kbps", 78, 13]])
    pg.evaluate("() => { const a = window.__audio; for (let k = 0; k < a.length; k++) ReciteByMic._ringPush(a[k]); }")
    pg.evaluate(send, [len(finals), "وانزلنا من المعصرات ما انزل الزجاجا"])
    pg.wait_for_timeout(6000)
    s = pg.evaluate(STATE)
    ok = bool(s) and s["rescued"] == 0 and s["err"] >= 1 and s["at"].startswith("78:14") and s["last"] and not errs
    print(("PASS " if ok else "FAIL ") + "C. the rescue heard other words (78:13): «ثجاجا» stays a mistake", "" if ok else (s, errs))
    if not ok: fails.append("C")
    ctx.close()

    # D. no local server ear (the published site): the model runs in the browser (WASM)
    ctx, pg, errs = page(br, "ctc", "wasm")
    pg.click("#tasmeeBtn")
    pg.wait_for_function("ReciteByMic._lw.ready", timeout=240000)
    dev = pg.evaluate("ReciteByMic._lw.device")
    sec = pg.evaluate(AUDIO, [["Minshawy_Murattal_128kbps", 78, a] for a in range(1, 3)])
    pg.evaluate("""async () => { const a = window.__audio;
      for (let o = 0; o < a.length; o += 1600) { ReciteByMic._lwFeed(a.subarray(o, o + 1600)); await new Promise((r) => setTimeout(r, 100)); }
      for (let k = 0; k < 15; k++) { ReciteByMic._lwFeed(new Float32Array(1600)); await new Promise((r) => setTimeout(r, 100)); } }""")
    pg.wait_for_function("(() => { const st = Tasmee._state(); return st && st.X && st.T.i >= 5; })()", timeout=60000)
    s = pg.evaluate(STATE)
    ms = pg.evaluate("ReciteByMic._lw.msLog || []")
    ok = dev == "wasm" and bool(s) and s["err"] == 0 and not errs
    print(("PASS " if ok else "FAIL ") + f"D. in the browser ({dev}): 78:1-2 ({sec:.0f} s) followed, no mistake; model passes {ms[:8]} ms", "" if ok else (s, errs))
    if not ok: fails.append("D")
    ctx.close()
    br.close()
print("FAILS:", fails)
sys.exit(1 if fails else 0)
