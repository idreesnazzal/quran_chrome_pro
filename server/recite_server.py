#!/usr/bin/env python3
"""Local Quran recitation transcription server for the mushaf app.

The browser's built-in speech recognition (generic MSA acoustics) mangles
melodic tajweed recitation ("تلك الجنة" loops on silence, wrong words on
madd/ghunna). This server transcribes mic chunks with a Whisper model and
returns plain Arabic text that the app's follower can actually track.

Run:
    pip install faster-whisper
    python recite_server.py                      # CPU, small model
    python recite_server.py --model medium --device cuda --compute float16

Then just open the app THROUGH the server (not as a file):

    http://127.0.0.1:8001/

Why: Chrome does not remember microphone permission for file:// pages, so it
re-asks on every visit. Over http://127.0.0.1 the grant persists, and the app
+ transcription share one origin (no CORS issues at all). The server also
serves the mushaf pages/data with proper caching (no-store on html/js so you
always get the newest engine).

Model tips:
  - "small" (default): decent Arabic, OK on CPU (~1-2 s per 10 s chunk).
  - Any faster-whisper/CTranslate2 id, e.g. a converted Quran-fine-tuned
    turbo model, via --model. Known Quran checkpoints (transformers format,
    convert with `ct2-transformers-converter` first):
      wasimlhr/whisper-quran-v1  (5.35% WER, trained on murattal)
      baristiran/whisper-turbo-quran (fully diacritized output)
  - Groq whisper-large-v3 is a zero-GPU alternative (needs API key);
    see docs/RECITE_ALGORITHM.md.
"""
import argparse
import json
import mimetypes
import os
import tempfile
import urllib.parse

import io
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODEL = None
MODEL_NAME = ""

# App root = parent of this script's folder (quran-mushaf-app/).
APP_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

MIME_EXTRA = {
    ".webp": "image/webp",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".md": "text/markdown; charset=utf-8",
}

# Never cache code (always newest engine); cache heavy page images.
NO_STORE_EXTS = {".html", ".js", ".css", ".json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ReciteServer/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome Private-Network-Access preflight (file:// -> 127.0.0.1)
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health" or parsed.path == "/health/":
            body = json.dumps({"ok": MODEL is not None,
                               "model": MODEL_NAME or None,
                               "note": None if MODEL is not None
                               else "static hosting only; pip install faster-whisper for transcription"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # Static app files (mic permission persists on http:// origins).
        rel = urllib.parse.unquote(parsed.path.lstrip("/")) or "index.html"
        if rel in ("", "/"):
            rel = "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        target = os.path.normpath(os.path.join(APP_ROOT, rel))
        if not target.startswith(APP_ROOT + os.sep) and target != APP_ROOT:
            self.send_response(403)
            self._cors()
            self.end_headers()
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        ext = os.path.splitext(target)[1].lower()
        ctype = MIME_EXTRA.get(ext) or mimetypes.guess_type(target)[0] or "application/octet-stream"
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self._cors()
        iso = "iso=1" in (parsed.query or "") or ext in (".js", ".mjs", ".wasm")
        if ext in (".html", ".js", ".mjs", ".wasm") and (ext != ".html" or iso):
            # opt-in (open http://127.0.0.1:8001/?iso=1): cross-origin isolation
            # gives the in-browser model multi-threaded WASM. Off by default,
            # matching the setup in which Chrome's recogniser worked.
            # cross-origin isolation -> SharedArrayBuffer -> multi-threaded
            # WASM for the in-browser Quran model (2-3x faster on CPU).
            # "credentialless" still lets fonts / recitation audio load.
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        if ext in NO_STORE_EXTS:
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(data)

    def do_HEAD(self):
        # same headers as GET, no body (the app probes optional files with HEAD)
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def do_POST(self):
        if self.path.startswith("/debug-save"):
            return self._debug_save()
        if self.path.rstrip("/") != "/recite-chunk":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            if MODEL is None:
                return self._json(503, {"error": "transcription model not loaded "
                                        "(pip install faster-whisper, then restart)",
                                        "text": ""})
            form = self._parse_multipart()
            audio_field = form.get("audio")
            if audio_field is None or not getattr(audio_field, "file", None):
                return self._json(400, {"error": "missing audio field"})
            data = audio_field.file.read()
            if not data:
                return self._json(400, {"error": "empty audio"})
            suffix = ".webm"
            filename = getattr(audio_field, "filename", "") or ""
            if filename.lower().endswith((".wav", ".mp3", ".m4a", ".ogg", ".webm")):
                suffix = "." + filename.lower().rsplit(".", 1)[1]
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(data)
                path = tmp.name
            try:
                segments, _info = MODEL.transcribe(
                    path,
                    language="ar",
                    task="transcribe",
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 400},
                    condition_on_previous_text=False,
                    no_speech_threshold=0.6,
                    logprob_threshold=-1.0,
                    compression_ratio_threshold=2.4,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            return self._json(200, {"text": text})
        except Exception as exc:  # never break the live session with a 500
            try:
                return self._json(500, {"error": str(exc)[:300], "text": ""})
            except Exception:
                pass

    def _parse_multipart(self):
        """multipart/form-data -> {name: Field(file, filename)}.
        (The cgi module this used was removed in Python 3.13.)"""
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length > 0 else b""
        head = ("Content-Type: " + self.headers.get("Content-Type", "") + "\r\n\r\n").encode("latin-1")
        msg = BytesParser(policy=HTTP).parsebytes(head + body)
        fields = {}
        if msg.is_multipart():
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name:
                    fields[name] = _Field(io.BytesIO(part.get_payload(decode=True) or b""),
                                          part.get_filename() or "")
        return fields

    def _debug_save(self):
        """🩺 button in the recite panel: store the reader's test recording
        (WAV) and the recogniser log under _debug/ for offline analysis.
        Only listens on 127.0.0.1; files never leave this machine."""
        import time
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        kind = "wav" if q.get("kind", ["wav"])[0] == "wav" else "json"
        stamp = q.get("stamp", [time.strftime("%Y%m%d-%H%M%S")])[0]
        stamp = "".join(ch for ch in stamp if ch.isalnum() or ch in "-_")[:40]
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 30_000_000:
            return self._json(400, {"error": "bad length"})
        data = self.rfile.read(length)
        folder = os.path.join(APP_ROOT, "_debug")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"rec_{stamp}.{kind}")
        with open(path, "wb") as fh:
            fh.write(data)
        return self._json(200, {"saved": os.path.relpath(path, APP_ROOT)})

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # quiet; the app is the UI


class _Field:
    def __init__(self, file, filename):
        self.file, self.filename = file, filename


def serve(port):
    # threaded: one slow/stalled connection (e.g. a browser keep-alive) must
    # not freeze every other request (the old single-threaded server did)
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main():
    global MODEL, MODEL_NAME
    ap = argparse.ArgumentParser(description="Quran recitation transcription server")
    ap.add_argument("--model", default="small",
                    help="faster-whisper model id/path (default: small)")
    ap.add_argument("--device", default="cpu", help="cpu or cuda")
    ap.add_argument("--compute", default="int8",
                    help="compute type: int8 (cpu), float16 (cuda), ...")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--no-model", action="store_true",
                    help="serve the app only (instant start, fixes mic permission); "
                         "no transcription until restarted without this flag")
    args = ap.parse_args()

    if args.no_model:
        print("[recite] --no-model: static hosting only (no transcription).",
              flush=True)
        print(f"[recite] app:    http://127.0.0.1:{args.port}/  <- open THIS (mic permission persists)",
              flush=True)
        serve(args.port)
        return

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[recite] WARNING: faster-whisper not installed — static hosting only.",
              flush=True)
        print("[recite] for transcription run: pip install faster-whisper",
              flush=True)
        MODEL = None
        MODEL_NAME = ""
        print(f"[recite] app:    http://127.0.0.1:{args.port}/  <- open THIS (mic permission persists)",
              flush=True)
        serve(args.port)
        return

    MODEL_NAME = args.model
    print(f"[recite] loading model {args.model!r} on {args.device} ({args.compute}) ...",
          flush=True)
    MODEL = WhisperModel(args.model, device=args.device, compute_type=args.compute)
    print(f"[recite] app:    http://127.0.0.1:{args.port}/  <- open THIS (mic permission persists)",
          flush=True)
    print(f"[recite] health: http://127.0.0.1:{args.port}/health  (Ctrl+C to stop)",
          flush=True)
    serve(args.port)


if __name__ == "__main__":
    main()
