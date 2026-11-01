"""Is this machine able to run the engine? One JSON document, so the desktop app can show an exact reason.

    python -m clipsmith.system          # exit code 0 when every *required* check passes

Check ids are stable (the desktop app maps them to its own wording); `detail` is English and meant for logs.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass

MIN_PYTHON = (3, 11)


@dataclass(frozen=True)
class Check:
    id: str
    ok: bool
    required: bool
    detail: str


Runner = Callable[[Sequence[str]], str]


def _run(cmd: Sequence[str]) -> str:
    done = subprocess.run(list(cmd), capture_output=True, text=True, timeout=30, check=False)
    return done.stdout + done.stderr


def _module_check(id_: str, modules: Sequence[str], *, required: bool, find_spec: Callable[[str], object | None]) -> Check:
    for name in modules:
        try:
            if find_spec(name) is not None:
                return Check(id_, True, required, f"{name} found")
        except (ImportError, ValueError):
            continue
    return Check(id_, False, required, f"Python package not installed ({' or '.join(modules)})")


def run_checks(
    *,
    which: Callable[[str], str | None] = shutil.which,
    run: Runner = _run,
    find_spec: Callable[[str], object | None] = importlib.util.find_spec,
    python_version: tuple[int, int] | None = None,
) -> list[Check]:
    major_minor = python_version or (sys.version_info.major, sys.version_info.minor)
    checks = [Check("python", major_minor >= MIN_PYTHON, True,
                    f"Python {major_minor[0]}.{major_minor[1]} (need {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer)")]

    ffmpeg = which("ffmpeg")
    if ffmpeg:
        first = (run([ffmpeg, "-hide_banner", "-version"]).splitlines() or ["ffmpeg"])[0]
        checks.append(Check("ffmpeg", True, True, first))
        filters = run([ffmpeg, "-hide_banner", "-filters"])
        encoders = run([ffmpeg, "-hide_banner", "-encoders"])
        # The caption stage burns subtitles with the `ass` filter, which only exists when ffmpeg was built with libass.
        has_ass = re.search(r"^\s*\S+\s+ass\s", filters, re.MULTILINE) is not None
        has_x264 = re.search(r"\blibx264\b", encoders) is not None
        checks.append(Check("libass", has_ass, True, "ass filter available" if has_ass else "this ffmpeg build has no `ass` filter (libass)"))
        checks.append(Check("libx264", has_x264, True, "libx264 encoder available" if has_x264 else "this ffmpeg build has no libx264 encoder"))
    else:
        checks.append(Check("ffmpeg", False, True, "ffmpeg not found on PATH"))
        checks.append(Check("libass", False, True, "needs ffmpeg"))
        checks.append(Check("libx264", False, True, "needs ffmpeg"))

    checks.append(Check("ffprobe", which("ffprobe") is not None, True,
                        "ffprobe found" if which("ffprobe") else "ffprobe not found on PATH"))
    checks.append(_module_check("fastapi", ["fastapi"], required=True, find_spec=find_spec))
    checks.append(_module_check("uvicorn", ["uvicorn"], required=True, find_spec=find_spec))
    checks.append(_module_check("multipart", ["python_multipart", "multipart"], required=True, find_spec=find_spec))
    checks.append(_module_check("faster_whisper", ["faster_whisper"], required=True, find_spec=find_spec))
    checks.append(_module_check("anthropic", ["anthropic"], required=False, find_spec=find_spec))   # only with an API key
    return checks


def summarize(checks: Sequence[Check]) -> dict:
    return {"ok": all(c.ok for c in checks if c.required), "checks": [asdict(c) for c in checks]}


def main(argv: list[str] | None = None) -> int:
    report = summarize(run_checks())
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
