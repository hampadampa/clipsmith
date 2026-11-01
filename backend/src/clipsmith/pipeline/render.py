"""FFmpeg rendering: one decode pass, N trims, concat, optional 9:16 + burned captions.

A single `filter_complex` graph (written to a script file, because hundreds of
segments would overflow the command line) means the video is decoded once and
encoded once: no generation loss, no audio glitches at joins (each segment gets
a 15 ms fade in/out).
"""
from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Sequence

from . import reframe
from .media import FFmpegError, MediaInfo, run
from .timeline import Range

AUDIO_FADE = 0.015


def build_filter_graph(ranges: Sequence[Range], *, has_audio: bool, fps: int, video_post: str) -> str:
    """`video_post` is a graph fragment that reads [vcat] and must produce [vout]."""
    if not ranges:
        raise ValueError("Cannot render an empty timeline")
    parts: list[str] = []
    for i, r in enumerate(ranges):
        parts.append(f"[0:v]trim=start={r.start:.3f}:end={r.end:.3f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            f = min(AUDIO_FADE, r.duration / 2)
            parts.append(
                f"[0:a]atrim=start={r.start:.3f}:end={r.end:.3f},asetpts=PTS-STARTPTS,"
                f"afade=t=in:st=0:d={f:.3f},afade=t=out:st={r.duration - f:.3f}:d={f:.3f}[a{i}]"
            )
    n = len(ranges)
    pads = "".join(f"[v{i}][a{i}]" if has_audio else f"[v{i}]" for i in range(n))
    parts.append(f"{pads}concat=n={n}:v=1:a={1 if has_audio else 0}[vc]" + ("[acat]" if has_audio else ""))
    parts.append(f"[vc]fps={fps}[vcat]")
    parts.append(video_post)
    if has_audio:
        parts.append("[acat]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]")
    return ";\n".join(parts)


def _quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:") + "'"


@lru_cache(maxsize=1)
def _filter_script_flag() -> str:
    """ffmpeg >= 7 deprecates -filter_complex_script in favour of -/filter_complex."""
    out = run(["ffmpeg", "-version"]).stdout
    m = re.search(r"ffmpeg version [nN]?(\d+)", out)
    return "-/filter_complex" if m and int(m.group(1)) >= 7 else "-filter_complex_script"


def render(
    source: Path,
    ranges: Sequence[Range],
    out_path: Path,
    *,
    info: MediaInfo,
    preset: str = "medium",
    crf: int = 20,
    vertical: bool = False,
    source_type: str = "camera",
    x_center: float | None = None,
    ass_path: Path | None = None,
    fonts_dir: Path | None = None,
) -> Path:
    source = source.resolve()
    out_path = out_path.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fps = int(round(min(max(info.fps, 24), 60)))

    # For clips cut from a long source: seek close to the first range so we
    # don't decode 30 minutes to render 40 seconds.
    seek = max(0.0, ranges[0].start - 1.0) if vertical else 0.0
    shifted = [Range(r.start - seek, r.end - seek) for r in ranges]

    cwd: Path | None = None
    if vertical:
        post = reframe.vertical_graph(info, source_type, x_center=x_center)
        if ass_path is not None:
            cwd = ass_path.resolve().parent       # libass resolves the filename relative to cwd
            sub = f"ass={ass_path.name}" + (f":fontsdir={_quote(str(fonts_dir.resolve()))}" if fonts_dir else "")
            post += f";[vref]{sub}[vout]"
        else:
            post += ";[vref]null[vout]"
    else:
        post = "[vcat]null[vout]"

    graph = build_filter_graph(shifted, has_audio=info.has_audio, fps=fps, video_post=post)
    script = out_path.with_suffix(".filtergraph.txt")
    script.write_text(graph, encoding="utf-8")

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if seek:
        cmd += ["-ss", f"{seek:.3f}"]
    cmd += ["-i", str(source), _filter_script_flag(), str(script), "-map", "[vout]"]
    if info.has_audio:
        cmd += ["-map", "[aout]"]
    cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p"]
    if info.has_audio:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += ["-movflags", "+faststart", str(out_path)]

    run(cmd, cwd=cwd)  # the .filtergraph.txt stays next to the output: invaluable when debugging a bad cut
    return out_path
