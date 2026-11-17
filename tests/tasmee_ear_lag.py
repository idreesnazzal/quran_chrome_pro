# usage: python tests/tasmee_ear_lag.py [port] [wasm]  — how late the Quran ear shows each ayah (al-Minshawi 78:1-5, real time)
# Real-time lag of the Quran ear in the page: al-Minshawi 78:1-5 pushed at real speed;
# for each ayah: (time its last word is uncovered) - (time its audio ended).
import sys, json
sys.stdout.reconfigure(encoding="utf-8")
import os
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(APP + "/tests/tasmee_ears.py", encoding="utf-8").read().split("fails = []")[0]
ns = {"__name__": "x"}; sys.argv = ["x", sys.argv[1] if len(sys.argv) > 1 else "8002"] + sys.argv[2:]; exec(src, ns)
from playwright.sync_api import sync_playwright
force = sys.argv[2] if len(sys.argv) > 2 else ""
with sync_playwright() as p:
    br = p.chromium.launch(channel="chrome", headless=True)
    ctx, pg, errs = ns["page"](br, "ctc", force)
    pg.click("#tasmeeBtn")
    pg.wait_for_function("ReciteByMic._lw.ready", timeout=240000)
    print("backend:", pg.evaluate("ReciteByMic._lw.device"))
    ends = pg.evaluate("""async () => { const ends = []; let t = 0;
      for (let a = 1; a <= 5; a++) { const url = 'https://everyayah.com/data/Minshawy_Murattal_128kbps/078' + String(a).padStart(3, '0') + '.mp3';
        const buf = await (await fetch(url)).arrayBuffer(), ac = new AudioContext(), dec = await ac.decodeAudioData(buf);
        const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000), s = off.createBufferSource(); s.buffer = dec; s.connect(off.destination); s.start();
        const pcm = (await off.startRendering()).getChannelData(0); ac.close(); (window.__parts = window.__parts || []).push(pcm); }
      return window.__parts.map((x) => x.length / 16000); }""")
    res = pg.evaluate("""async () => {
      const st0 = Tasmee._state(), seen = {}, ayEnd = [], t0 = performance.now(); window.__lw = [];
      const oh = Tasmee.heard; Tasmee.heard = function (w, r, f) { window.__lw.push([Math.round(performance.now() - t0), f ? 'F' : 'i', w.join(' '), !!(Tasmee._state() && Tasmee._state().X)]); return oh.apply(this, arguments); };
      const probe = () => { const st = Tasmee._state(); if (!st || !st.X) return; const T = st.shown || st.T; for (let k = 0; k < T.i; k++) if (!(k in seen)) seen[k] = performance.now() - t0; };
      const iv = setInterval(probe, 30);
      for (const pcm of window.__parts.concat([new Float32Array(9600)])) {
        for (let o = 0; o < pcm.length; o += 1600) { ReciteByMic._lwFeed(pcm.subarray(o, o + 1600)); await new Promise((r) => setTimeout(r, 100)); }
        ayEnd.push(performance.now() - t0);
        for (let k = 0; k < 6; k++) { ReciteByMic._lwFeed(new Float32Array(1600)); await new Promise((r) => setTimeout(r, 100)); }   // a 0.6 s pause
      }
      await new Promise((r) => setTimeout(r, 4000)); clearInterval(iv); probe();
      const st = Tasmee._state(); return { lwlog: window.__lw || [], seen, ayEnd, E: st.X.E.slice(0, 25), at: st.at.slice(0, 25).map((p) => p.ai), ms: ReciteByMic._lw.msLog }; }""")
    E, at, seen = res["E"], res["at"], {int(k): v for k, v in res["seen"].items()}
    a0 = at[0]
    for i, endt in enumerate(res["ayEnd"][:5]):
        ks = [k for k in range(len(E)) if at[k] == a0 + i]
        if not ks: continue
        last = ks[-1]
        t = seen.get(last)
        print(f"78:{i+1} ends at {endt/1000:5.1f}s; its last word «{E[last]}» shown at " + (f"{t/1000:5.1f}s → lag {(t-endt)/1000:+.2f}s" if t else "never"))
    for x in res["lwlog"][:40]: print("   heard", x)
    print("first words shown at:", [(E[k], round(seen[k]/1000,2)) for k in range(4) if k in seen])
    ms = res["ms"] or []
    print("model passes:", len(ms), "median ms", sorted(ms)[len(ms)//2] if ms else None, "errors", errs)
    br.close()
