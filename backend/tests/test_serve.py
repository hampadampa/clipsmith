import contextlib
import io
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from clipsmith import serve
from clipsmith.config import Settings

SRC = str(Path(__file__).resolve().parents[1] / "src")


class ArgTests(unittest.TestCase):
    def quiet(self, argv):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = serve.main(argv, run=lambda *a: None, make_app=lambda s: object())
        return code, err.getvalue()

    def test_defaults_to_loopback(self):
        args = serve.parse_args([])
        self.assertEqual((args.host, args.port), ("127.0.0.1", 8000))

    def test_refuses_a_public_address_without_the_flag(self):
        code, err = self.quiet(["--host", "0.0.0.0"])
        self.assertEqual(code, 2)
        self.assertIn("no authentication", err)
        self.assertEqual(serve.parse_args(["--host", "0.0.0.0", "--allow-remote"]).host, "0.0.0.0")

    def test_rejects_bad_ports(self):
        for bad in ("0", "70000", "-1"):
            self.assertEqual(self.quiet(["--port", bad])[0], 2, bad)

    def test_settings_come_from_the_environment_and_data_dir_flag_wins(self):
        env = {"CLIPSMITH_WHISPER_MODEL": "small", "ANTHROPIC_API_KEY": "k", "CLIPSMITH_DATA_DIR": "/from/env"}
        args = serve.parse_args(["--data-dir", "/from/flag"])
        s = serve.build_settings(args, env)
        self.assertEqual((s.whisper_model, s.anthropic_api_key, s.data_dir), ("small", "k", Path("/from/flag")))
        self.assertEqual(serve.build_settings(serve.parse_args([]), env).data_dir, Path("/from/env"))

    def test_runs_the_app_it_was_given_on_the_requested_address(self):
        calls = []
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = serve.main(["--port", "4321"], run=lambda app, h, p: calls.append((app, h, p)),
                              make_app=lambda s: ("app", s.data_dir), environ={})
        self.assertEqual(code, 0)
        self.assertEqual(calls, [(("app", Path("./data")), "127.0.0.1", 4321)])
        self.assertIn("http://127.0.0.1:4321", buf.getvalue())

    def test_missing_dependency_exits_3_with_the_package_name(self):
        def boom(_):
            raise ModuleNotFoundError("No module named 'fastapi'", name="fastapi")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = serve.main([], make_app=boom, run=lambda *a: None)
        self.assertEqual(code, serve.EXIT_MISSING_DEPENDENCY)
        self.assertIn("fastapi", err.getvalue())

    def test_the_api_key_is_never_printed(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            serve.main(["--port", "4322"], run=lambda *a: None, make_app=lambda s: object(),
                       environ={"ANTHROPIC_API_KEY": "sk-secret-123"})
        self.assertNotIn("sk-secret-123", out.getvalue() + err.getvalue())


class StdinWatchTests(unittest.TestCase):
    def test_calls_back_when_the_other_end_closes(self):
        r, w = os.pipe()
        fired = threading.Event()
        serve.watch_stdin(os.fdopen(r, "rb"), fired.set)
        os.write(w, b"ignored noise")
        self.assertFalse(fired.wait(0.2), "must not fire while the pipe is open")
        os.close(w)
        self.assertTrue(fired.wait(3))

    def test_main_wires_the_flag_to_the_callback(self):
        r, w = os.pipe()
        fired = threading.Event()
        serve.main(["--port", "4330", "--exit-when-stdin-closes"], run=lambda *a: None, make_app=lambda s: object(),
                   stdin=os.fdopen(r, "rb"), on_stdin_closed=fired.set)
        os.close(w)
        self.assertTrue(fired.wait(3))

    def test_without_the_flag_stdin_is_not_touched(self):
        class Boom:
            def read(self, n):
                raise AssertionError("stdin must not be read")
        serve.main(["--port", "4331"], run=lambda *a: None, make_app=lambda s: object(), stdin=Boom())


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except ImportError:
        return False


@unittest.skipUnless(have("uvicorn") and have("starlette"), "uvicorn/starlette not installed")
class RealUvicornTests(unittest.TestCase):
    """Runs serve.main with the real uvicorn and a tiny Starlette app standing in for FastAPI (not installable here).

    What this proves: the host/port wiring, that the process answers over HTTP, and that SIGTERM ends it cleanly.
    What it does not prove: that api/app.py imports and serves under a real FastAPI.
    """

    CHILD = (
        "import sys\n"
        "from starlette.applications import Starlette\n"
        "from starlette.responses import JSONResponse\n"
        "from starlette.routing import Route\n"
        "from clipsmith import serve\n"
        "app = Starlette(routes=[Route('/health', lambda r: JSONResponse({'ok': True}))])\n"
        "sys.exit(serve.main(sys.argv[1:], make_app=lambda s: app))\n"
    )

    def test_answers_health_and_stops_on_sigterm(self):
        port = free_port()
        env = {**os.environ, "PYTHONPATH": SRC}
        proc = subprocess.Popen([sys.executable, "-c", self.CHILD, "--port", str(port)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline, body = time.time() + 15, None
            while time.time() < deadline and body is None:
                try:
                    body = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1))
                except OSError:
                    time.sleep(0.1)
            self.assertEqual(body, {"ok": True})
            proc.terminate()
            code = proc.wait(timeout=10)
            # uvicorn finishes its graceful shutdown and then re-raises the signal it caught, so a clean stop
            # shows up as "killed by SIGTERM" (-15) rather than 0. SIGKILL (-9) or a hang would mean it did not shut down.
            self.assertIn(code, (0, -signal.SIGTERM))
            self.assertIn("Finished server process", proc.stderr.read())
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.communicate()


@unittest.skipUnless(have("uvicorn") and have("starlette"), "uvicorn/starlette not installed")
class OrphanProtectionTests(unittest.TestCase):
    def test_server_exits_by_itself_when_its_parent_pipe_closes(self):
        port = free_port()
        proc = subprocess.Popen([sys.executable, "-c", RealUvicornTests.CHILD, "--port", str(port), "--exit-when-stdin-closes"],
                                env={**os.environ, "PYTHONPATH": SRC}, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.time() + 15
            up = False
            while time.time() < deadline and not up:
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
                    up = True
                except OSError:
                    time.sleep(0.1)
            self.assertTrue(up)
            self.assertIsNone(proc.poll(), "must keep running while the pipe is open")
            proc.stdin.close()                    # what the OS does for us when the desktop app dies
            self.assertEqual(proc.wait(timeout=10), 0)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()


if __name__ == "__main__":
    unittest.main()
