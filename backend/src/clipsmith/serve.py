"""Start the HTTP API. This is what the desktop app launches as a child process.

    python -m clipsmith.serve --port 8765 --data-dir ~/.clipsmith/data

Configuration comes from the environment (see config.py / .env.example); --data-dir overrides CLIPSMITH_DATA_DIR.
The API key is deliberately NOT a command-line flag: arguments are visible to every process on the machine.
There is no authentication, so the server refuses a non-loopback host unless --allow-remote is given.
"""
from __future__ import annotations

import argparse
import dataclasses
import logging
import os
import sys
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, BinaryIO

from . import __version__
from .config import Settings

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
EXIT_BAD_ARGS = 2
EXIT_MISSING_DEPENDENCY = 3


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m clipsmith.serve", description="Clipsmith engine (HTTP API)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--data-dir", type=Path, help="where jobs and results are stored (default: $CLIPSMITH_DATA_DIR or ./data)")
    p.add_argument("--allow-remote", action="store_true", help="listen on a non-loopback address (the API has no authentication!)")
    p.add_argument("--exit-when-stdin-closes", action="store_true",
                   help="exit when standard input reaches EOF. The desktop app keeps a pipe open to us, so if the app dies "
                        "(even a crash) the OS closes it and the engine does not linger as an orphan.")
    args = p.parse_args(argv)
    if not 1 <= args.port <= 65535:
        p.error("--port must be between 1 and 65535")
    if args.host not in LOOPBACK_HOSTS and not args.allow_remote:
        p.error(f"refusing to listen on {args.host!r}: the API has no authentication. Pass --allow-remote if you really mean it.")
    return args


def build_settings(args: argparse.Namespace, environ: Mapping[str, str] | None = None) -> Settings:
    settings = Settings.from_env(environ)
    if args.data_dir is not None:
        settings = dataclasses.replace(settings, data_dir=args.data_dir)
    return settings


def watch_stdin(stream: BinaryIO, on_eof: Callable[[], None]) -> threading.Thread:
    """Calls `on_eof` once `stream` is closed by the other end. Runs in a daemon thread."""
    def wait() -> None:
        try:
            while stream.read(4096):             # anything written to us is ignored
                pass
        except (OSError, ValueError):
            pass
        on_eof()

    t = threading.Thread(target=wait, name="stdin-watch", daemon=True)
    t.start()
    return t


def _exit_now() -> None:
    # Not a graceful shutdown on purpose: a running job cannot finish without the app that asked for it, and
    # waiting for the worker thread would keep an orphaned engine alive for minutes.
    os._exit(0)


def _default_run(app: Any, host: str, port: int) -> None:
    import uvicorn

    # access_log off: the desktop app polls job status every second and would drown the useful lines.
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


def _default_make_app(settings: Settings) -> Any:
    from .api.app import create_app

    return create_app(settings)


def main(
    argv: list[str] | None = None,
    *,
    run: Callable[[Any, str, int], None] | None = None,
    make_app: Callable[[Settings], Any] | None = None,
    environ: Mapping[str, str] | None = None,
    stdin: BinaryIO | None = None,
    on_stdin_closed: Callable[[], None] | None = None,
) -> int:
    try:
        args = parse_args(argv)
    except SystemExit as e:                       # argparse already printed the reason on stderr
        return int(e.code) if isinstance(e.code, int) else EXIT_BAD_ARGS

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    settings = build_settings(args, environ)
    if args.exit_when_stdin_closes:
        watch_stdin(stdin if stdin is not None else sys.stdin.buffer, on_stdin_closed or _exit_now)
    try:
        app = (make_app or _default_make_app)(settings)
        print(f"clipsmith engine {__version__} on http://{args.host}:{args.port} (data: {settings.data_dir})", flush=True)
        (run or _default_run)(app, args.host, args.port)
    except ModuleNotFoundError as e:
        print(f"Missing Python package: {e.name}. Install the engine's requirements (pip install -r requirements.txt).",
              file=sys.stderr, flush=True)
        return EXIT_MISSING_DEPENDENCY
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
