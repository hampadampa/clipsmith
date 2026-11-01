"""Run the whole pipeline locally, no server. The fastest loop for tuning prompts and cut parameters.

    clipsmith raw.mp4 --out ./out --prefs prefs.json
    clipsmith raw.mp4 --niche garage --pace fast --no-llm
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from .config import Settings
from .models import CAPTION_STYLES, NICHES, PACES, SOURCE_TYPES, Preferences
from .pipeline.planner import make_planner
from .pipeline.run import run_pipeline


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="clipsmith", description="Raw recording -> tight main video + vertical shorts")
    p.add_argument("video", type=Path)
    p.add_argument("--out", type=Path, default=Path("./out"))
    p.add_argument("--prefs", type=Path, help="JSON file with preferences (CLI flags override it)")
    p.add_argument("--niche", choices=NICHES)
    p.add_argument("--pace", choices=PACES)
    p.add_argument("--captions", choices=CAPTION_STYLES, dest="caption_style")
    p.add_argument("--source-type", choices=SOURCE_TYPES, dest="source_type")
    p.add_argument("--target-minutes", type=float, dest="target_minutes")
    p.add_argument("--shorts", type=int, dest="num_shorts")
    p.add_argument("--no-llm", action="store_true", help="use the deterministic heuristic planner")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    data = json.loads(args.prefs.read_text()) if args.prefs else {}
    data.update({k: getattr(args, k) for k in ("niche", "pace", "caption_style", "source_type",
                                                "target_minutes", "num_shorts") if getattr(args, k) is not None})
    try:
        prefs = Preferences.from_dict(data)
    except ValueError as e:
        print(f"Invalid preferences: {e}", file=sys.stderr)
        return 2

    settings = Settings.from_env()
    manifest = run_pipeline(
        args.video, args.out, prefs, settings, make_planner(settings, force_heuristic=args.no_llm),
        progress=lambda stage, frac: print(f"[{frac:5.0%}] {stage}", flush=True),
    )
    print(json.dumps({k: manifest[k] for k in ("storyline", "main", "shorts")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
