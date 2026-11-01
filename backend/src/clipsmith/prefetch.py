"""Download a Whisper model now, so the first real job does not stall on a multi-gigabyte download.

    python -m clipsmith.prefetch --model small

Honours HF_HOME / HF_HUB_CACHE, which is how the desktop app keeps the model inside its own data folder.
Progress bars from huggingface_hub go to stderr; the last stdout line is a JSON result.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Callable


def main(argv: list[str] | None = None, *, download: Callable[..., str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m clipsmith.prefetch")
    p.add_argument("--model", required=True, help="faster-whisper model name (small, medium, large-v3, ...) or a Hugging Face repo id")
    args = p.parse_args(argv)
    try:
        if download is None:
            from faster_whisper.utils import download_model as download
        path = download(args.model)
    except ModuleNotFoundError as e:
        print(f"Missing Python package: {e.name}", file=sys.stderr, flush=True)
        return 3
    except Exception as e:                        # noqa: BLE001 - network errors, unknown model names, disk full, ...
        print(f"Could not download model {args.model!r}: {e}", file=sys.stderr, flush=True)
        return 1
    print(json.dumps({"model": args.model, "path": str(path)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
