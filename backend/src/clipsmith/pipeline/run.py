"""Pipeline orchestrator: upload -> transcript -> editorial plan -> FFmpeg renders -> manifest."""
from __future__ import annotations

import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Callable

from ..config import Settings
from ..models import Preferences
from . import captions, media, planner as planning, reframe, render
from .timeline import Timeline, build_ranges, resolve_pace
from .units import Word, annotate_repeats, build_units

log = logging.getLogger(__name__)

ProgressFn = Callable[[str, float], None]
TranscribeFn = Callable[[Path], list[Word]]

MAX_TIGHTEN_PASSES = 2        # extra LLM passes if the cut is still over target
TARGET_TOLERANCE = 1.12       # accept up to 12 % over target before asking for more cuts


def _noop(stage: str, fraction: float) -> None:
    pass


def run_pipeline(
    source: Path,
    out_dir: Path,
    prefs: Preferences,
    settings: Settings,
    planner: planning.Planner,
    *,
    progress: ProgressFn = _noop,
    transcribe_fn: TranscribeFn | None = None,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"
    work.mkdir(exist_ok=True)

    # ---- 1. analyse -------------------------------------------------------
    progress("analysing", 0.02)
    info = media.probe(source)
    if not info.has_audio:
        raise ValueError("The video has no audio track, so there is no speech to edit.")
    wav = work / "audio.wav"
    media.extract_audio(source, wav)
    silences = media.detect_silences(wav)

    # ---- 2. transcribe ----------------------------------------------------
    progress("transcribing", 0.08)
    if transcribe_fn is None:
        from .transcribe import transcribe
        words = transcribe(wav, settings, prefs)
    else:
        words = transcribe_fn(wav)
    if len(words) < 5:
        raise ValueError("No speech detected in the video.")
    (out_dir / "transcript.json").write_text(json.dumps([asdict(w) for w in words], ensure_ascii=False))

    units = build_units(words)
    annotate_repeats(units)

    # ---- 3. main video: LLM picks cuts, timeline.py makes them exact ------
    progress("planning_main", 0.30)
    pace = resolve_pace(prefs.pace, prefs.remove_fillers)
    target = prefs.target_minutes * 60
    dropped: set[int] = set()
    storyline: str | None = None
    all_cuts: list[planning.Cut] = []

    def ranges_for(dropped_ids: set[int]):
        return build_ranges(units, dropped_ids, pace, media_duration=info.duration, silences=silences)

    for attempt in range(1 + MAX_TIGHTEN_PASSES):
        current = Timeline(ranges_for(dropped)).duration
        if attempt > 0 and current <= target * TARGET_TOLERANCE:
            break
        remaining = [u for u in units if u.id not in dropped]
        plan = planner.plan_main_cuts(remaining, prefs, current_seconds=current, target_seconds=target,
                                      storyline=storyline)
        storyline = storyline or plan.storyline
        new_ids = planning.expand_cuts(plan.cuts, remaining)
        log.info("Pass %d: %.0fs -> dropping %d units (target %.0fs)", attempt, current, len(new_ids), target)
        if not new_ids:
            break
        dropped |= new_ids
        all_cuts += plan.cuts

    main_ranges = ranges_for(dropped)
    main_tl = Timeline(main_ranges)
    if not main_ranges:
        raise ValueError("Editing removed everything; refusing to render an empty video.")

    progress("rendering_main", 0.45)
    main_path = render.render(source, main_ranges, out_dir / "main.mp4", info=info,
                              preset=settings.x264_preset, crf=settings.x264_crf)
    (out_dir / "main.srt").write_text(captions.build_srt(main_tl.remap_words(words)), encoding="utf-8")
    (out_dir / "main.edl.json").write_text(json.dumps(main_tl.to_edl()))

    # ---- 4. shorts: pick moments from the ORIGINAL timeline ----------------
    progress("planning_shorts", 0.60)
    short_plans = planner.plan_shorts(units, prefs)
    short_pace = resolve_pace(prefs.pace, prefs.remove_fillers, for_shorts=True)
    shorts_meta: list[dict] = []
    for n, sp in enumerate(short_plans, 1):
        progress(f"rendering_short_{n}", 0.60 + 0.38 * (n - 1) / max(len(short_plans), 1))
        s_units = [u for u in units if sp.start_id <= u.id <= sp.end_id and u.id not in sp.drop_ids]
        s_ranges = build_ranges(s_units, set(), short_pace, media_duration=info.duration, silences=silences)
        if not s_ranges:
            continue
        s_tl = Timeline(s_ranges)

        ass_path = None
        ass = captions.build_ass(s_tl.remap_words(words), prefs.caption_style, font=settings.caption_font)
        if ass:
            ass_path = work / f"short_{n}.ass"
            ass_path.write_text(ass, encoding="utf-8")

        x_center = reframe.estimate_x_center(source, s_ranges[0].start, s_ranges[-1].end)
        out = render.render(source, s_ranges, out_dir / f"short_{n}.mp4", info=info,
                            preset=settings.x264_preset, crf=settings.x264_crf, vertical=True,
                            source_type=prefs.source_type, x_center=x_center, ass_path=ass_path,
                            fonts_dir=settings.fonts_dir)
        shorts_meta.append({
            "file": out.name, "title": sp.hook_title, "score": sp.score, "reason": sp.reason,
            "duration": round(s_tl.duration, 2),
            "source_start": round(s_ranges[0].start, 2), "source_end": round(s_ranges[-1].end, 2),
            "unit_range": [sp.start_id, sp.end_id],
        })

    # ---- 5. manifest --------------------------------------------------------
    manifest = {
        "preferences": prefs.to_dict(),
        "source": {"duration": round(info.duration, 2), "width": info.width, "height": info.height},
        "storyline": storyline,
        "main": {
            "file": main_path.name, "subtitles": "main.srt", "edl": "main.edl.json",
            "duration": round(main_tl.duration, 2), "target": target,
            "segments": len(main_ranges), "dropped_units": len(dropped),
            "cuts": [asdict(c) for c in all_cuts],
        },
        "shorts": shorts_meta,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    progress("done", 1.0)
    return manifest
