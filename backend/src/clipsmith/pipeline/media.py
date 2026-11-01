"""Thin wrappers around ffprobe / ffmpeg for probing, audio extraction and silence detection."""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise FFmpegError(f"{cmd[0]} failed ({proc.returncode}):\n{tail}")
    return proc


@dataclass(frozen=True)
class MediaInfo:
    duration: float
    width: int           # display width (rotation already applied)
    height: int          # display height
    fps: float
    has_audio: bool

    @property
    def is_portrait(self) -> bool:
        return self.height >= self.width


def probe(path: Path) -> MediaInfo:
    out = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)])
    data = json.loads(out.stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise FFmpegError("No video stream found")
    w, h = int(video["width"]), int(video["height"])

    # Phones store landscape pixels + a rotation flag. ffmpeg auto-rotates when
    # decoding, so the *display* size is what the filter graph will see.
    rotation = 0
    for sd in video.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    rotation = rotation or int(float(video.get("tags", {}).get("rotate", 0) or 0))
    if abs(rotation) % 180 == 90:
        w, h = h, w

    num, _, den = (video.get("avg_frame_rate") or "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    raw_duration = data.get("format", {}).get("duration") or video.get("duration")
    try:
        duration = float(raw_duration) if raw_duration not in (None, "N/A") else 0.0
    except ValueError:
        duration = 0.0
    if duration <= 0:
        duration = scan_duration(path)  # e.g. a browser MediaRecorder file: no duration in the header
    return MediaInfo(
        duration=duration,
        width=w,
        height=h,
        fps=fps if 1 < fps < 121 else 30.0,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
    )


def scan_duration(path: Path) -> float:
    """End time of the last packet in any stream (demuxing only, no decoding).

    Files written by a live encoder, such as a browser's MediaRecorder (the desktop app), have no
    duration in the container header, so ffprobe reports N/A. Treating that as 0 s would make the
    cut logic clamp every range away.
    """
    end = 0.0
    with subprocess.Popen(
        ["ffprobe", "-v", "error", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", str(path)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    ) as proc:                                   # the context manager closes the pipe and reaps the process
        assert proc.stdout is not None
        for line in proc.stdout:  # streamed: a multi-hour file has hundreds of thousands of packets
            pts, _, dur = line.strip().partition(",")
            try:
                start = float(pts)
            except ValueError:
                continue
            try:
                length = float(dur)
            except ValueError:
                length = 0.0
            end = max(end, start + length)
    if end <= 0:
        raise FFmpegError(f"Could not determine the duration of {path.name}")
    return end


def extract_audio(src: Path, dst: Path) -> None:
    """16 kHz mono PCM: what Whisper wants, and cheap to analyse."""
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
         "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)])


_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def detect_silences(audio: Path, *, noise_db: float = -35.0, min_duration: float = 0.20) -> list[tuple[float, float]]:
    """Return (start, end) intervals where the audio is below `noise_db`.

    Whisper word timestamps are only accurate to roughly +-100 ms. These
    intervals are the ground truth we snap cut points into, so cuts land in
    real silence instead of clipping the start/end of a word.
    """
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(audio),
         "-af", f"silencedetect=noise={noise_db}dB:d={min_duration}", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr[-800:])
    silences: list[tuple[float, float]] = []
    start: float | None = None
    for line in proc.stderr.splitlines():
        if (m := _SIL_START.search(line)):
            start = max(0.0, float(m.group(1)))
        elif (m := _SIL_END.search(line)) and start is not None:
            silences.append((start, float(m.group(1))))
            start = None
    if start is not None:  # file ends in silence
        silences.append((start, probe_audio_duration(audio)))
    return silences


def probe_audio_duration(audio: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(audio)])
    return float(out.stdout.strip())
