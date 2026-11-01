"""A stand-in for backend/src/clipsmith/api/app.py for environments without FastAPI.

Same routes, same status codes, same JobStore / JobRunner / Preferences / pipeline from the real
backend; only the HTTP shell is swapped for the standard library. Transcription is faked (the
test recording has no speech) and the planner is the deterministic HeuristicPlanner.

    PYTHONPATH=../../../backend/src python3 backend_shim.py --data-dir /tmp/clipsmith-data [--port N]

Takes the same arguments as `python -m clipsmith.serve` (--host, --port, --data-dir), so the desktop app's
BackendManager can launch it in place of the real server. Prints `PORT=<n>` once it listens, and one
`UPLOAD {...}` line per received file.

Test hooks, only active with CLIPSMITH_SHIM_DEBUG=1:
    GET /debug/env      what the child process received (API key presence, model, PATH head, HF_HOME) - never the key itself
    POST /debug/crash   exit immediately with code 7
    CLIPSMITH_SHIM_START_DELAY=<seconds> delays listening, CLIPSMITH_SHIM_NEVER_READY=1 listens but fails /health
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from clipsmith import __version__
from clipsmith.api.jobs import JobRunner, JobStore
from clipsmith.config import Settings
from clipsmith.models import Preferences
from clipsmith.pipeline.planner import HeuristicPlanner
from clipsmith.pipeline.units import Word

ALLOWED_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
SENTENCES = [
    "Nu visar jag hur man byter bromsklossar på bilen",
    "Först lyfter vi bilen och tar av hjulet",
    "Sedan skruvar vi loss bromsoket med en tolva",
    "Observera att slangen inte får hänga fritt",
    "Kolven pressas tillbaka med en gammal klammer",
    "De nya klossarna smörjs med lite kopparfett",
    "Allt monteras i omvänd ordning och dras med moment",
    "Pumpa bromspedalen innan du kör iväg",
    "Kontrollera nivån i bromsvätskebehållaren efteråt",
    "Provkör försiktigt på en tom väg innan du litar på dem",
    "Skivorna bör bytas samtidigt om de är riffliga",
    "Slutligen torkar vi av allt med bromsrengöring",
]
POOL = ["momentnyckel", "batteriet", "kylvätskan", "tändstiften", "remskivan", "oljefiltret", "kamremmen", "generatorn"]


def fake_transcribe(wav: Path) -> list[Word]:
    """Distinct sentences with pauses between them, plus ONE deliberate retake (sentence 3 repeats sentence 2).

    Near-identical sentences are treated as retakes by the planner, so everything else must differ.
    """
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
                         capture_output=True, text=True, check=True).stdout.strip()
    duration = float(out)
    words, i = [], 0
    while 0.4 + i * 4.6 + 2.2 < duration:
        if i == 3:
            text = SENTENCES[2]
        elif i < len(SENTENCES):
            text = SENTENCES[i]
        else:
            text = f"Efter det byter vi {POOL[i % len(POOL)]} och kontrollerar {POOL[(i * 3 + 1) % len(POOL)]} steg {i}"
        start = 0.4 + i * 4.6
        for k, t in enumerate(text.split()):
            words.append(Word(t, start + k * 0.2, start + k * 0.2 + 0.17))
        i += 1
    return words


def parse_multipart(body: bytes, content_type: str) -> dict[str, tuple[dict[str, str], bytes]]:
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type)
    if not m:
        raise ValueError("no boundary")
    boundary = (m.group(1) or m.group(2)).encode()
    parts: dict[str, tuple[dict[str, str], bytes]] = {}
    for chunk in body.split(b"--" + boundary):
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        if not chunk or chunk == b"--":
            continue
        head, _, data = chunk.partition(b"\r\n\r\n")
        disp = head.decode("utf-8", "replace")
        name = re.search(r'name="([^"]*)"', disp)
        filename = re.search(r'filename="([^"]*)"', disp)
        if name:
            parts[name.group(1)] = ({"filename": filename.group(1) if filename else ""}, data)
    return parts


def make_handler(store: JobStore, runner: JobRunner):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # quiet
            pass

        def _json(self, status: int, obj) -> None:
            data = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _err(self, status: int, detail: str) -> None:
            self._json(status, {"detail": detail})

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/health":
                if os.environ.get("CLIPSMITH_SHIM_NEVER_READY") == "1":
                    return self._err(503, "starting")
                return self._json(200, {"ok": True, "version": __version__})
            if path == "/debug/env" and os.environ.get("CLIPSMITH_SHIM_DEBUG") == "1":
                key = os.environ.get("ANTHROPIC_API_KEY", "")
                return self._json(200, {
                    "has_api_key": bool(key), "api_key_length": len(key),
                    "whisper_model": os.environ.get("CLIPSMITH_WHISPER_MODEL"),
                    "path_head": os.environ.get("PATH", "").split(os.pathsep)[0],
                    "hf_home": os.environ.get("HF_HOME"), "data_dir": os.environ.get("CLIPSMITH_DATA_DIR"),
                    "argv": sys.argv[1:], "pid": os.getpid(),
                })
            m = re.fullmatch(r"/jobs/([^/]+)(?:/files/(.+))?", path)
            if not m:
                return self._err(404, "Not Found")
            job = store.get(m.group(1))
            if job is None:
                return self._err(404, "Job not found")
            if not m.group(2):
                return self._json(200, job)
            from urllib.parse import unquote
            name = unquote(m.group(2))
            if name not in job.get("outputs", []):
                return self._err(404, "File not found")
            data = (store.job_dir(job["id"]) / "output" / name).read_bytes()
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_DELETE(self):
            m = re.fullmatch(r"/jobs/([^/]+)", self.path)
            if not m or store.get(m.group(1)) is None:
                return self._err(404, "Job not found")
            store.delete(m.group(1))
            self.send_response(204)
            self.send_header("content-length", "0")
            self.end_headers()

        def do_POST(self):
            if self.path == "/debug/crash" and os.environ.get("CLIPSMITH_SHIM_DEBUG") == "1":
                os._exit(7)
            if self.path != "/jobs":
                return self._err(404, "Not Found")
            if "chunked" in self.headers.get("transfer-encoding", "").lower() or "content-length" not in self.headers:
                return self._err(411, "Content-Length required")
            declared = int(self.headers["content-length"])
            body = self.rfile.read(declared)
            parts = parse_multipart(body, self.headers.get("content-type", ""))
            if "video" not in parts:
                return self._err(422, "field required: video")
            meta, data = parts["video"]
            try:
                prefs = Preferences.from_dict(json.loads(parts.get("preferences", ({}, b"{}"))[1].decode()))
            except (ValueError, TypeError) as e:
                return self._err(422, f"Invalid preferences: {e}")
            ext = Path(meta["filename"]).suffix.lower()
            if ext not in ALLOWED_EXT:
                return self._err(415, f"Unsupported file type {ext!r}")
            job_id = store.create(prefs)
            (store.job_dir(job_id) / f"source{ext}").write_bytes(data)
            store.update(job_id, status="queued")
            runner.submit(job_id)
            print("UPLOAD " + json.dumps({"content_length": declared, "received": len(body), "file_bytes": len(data), "filename": meta["filename"], "job": job_id}), flush=True)
            self._json(202, store.get(job_id))

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--allow-remote", action="store_true")
    ap.add_argument("--exit-when-stdin-closes", action="store_true")
    args = ap.parse_args()
    if args.exit_when_stdin_closes:                # same behaviour as clipsmith.serve
        from clipsmith.serve import watch_stdin
        watch_stdin(sys.stdin.buffer, lambda: os._exit(0))
    delay = float(os.environ.get("CLIPSMITH_SHIM_START_DELAY", "0") or 0)
    if delay:
        time.sleep(delay)
    settings = Settings(
        data_dir=Path(args.data_dir),
        x264_preset="ultrafast",
        delete_source_after=os.environ.get("CLIPSMITH_DELETE_SOURCE_AFTER", "0").lower() in ("1", "true", "yes"),
    )
    store = JobStore(settings.data_dir / "jobs")
    store.recover_interrupted()                    # same as api/app.py create_app()
    runner = JobRunner(store, settings, HeuristicPlanner(), transcribe_fn=fake_transcribe)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store, runner))
    print(f"PORT={server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
