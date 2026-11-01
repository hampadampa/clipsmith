"""THE CORE: turn "which units to drop" into exact, click-free cut ranges.

The LLM decides *what* to cut (editorial judgement, by unit ID).
This module decides *where* to cut (deterministic, testable):

  1. Collect kept words, forcing a hard break wherever content was dropped.
  2. Shorten internal pauses longer than `max_pause` down to `keep_pause`
     (this is the "tystnader / dötid" removal; the pace preference sets the numbers).
  3. Optionally cut filler sounds ("eh", "öhm") at word level.
  4. Pad each cut and snap it into a *real* silence found by ffmpeg, because
     Whisper timestamps are only good to ~100 ms.
  5. Merge ranges that ended up touching.

Result: a list of source-time Ranges. A Timeline maps source time -> output
time, which is what makes captions line up after cutting.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, replace
from typing import Iterable, Sequence

from .units import Unit, Word


@dataclass(frozen=True)
class Range:
    start: float  # seconds in the SOURCE video
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class PaceParams:
    max_pause: float       # pauses longer than this are shortened
    keep_pause: float      # ...down to this much silence
    edge_pad: float        # breathing room kept around hard cuts
    remove_fillers: bool


PACE: dict[str, PaceParams] = {
    "calm":     PaceParams(max_pause=0.90, keep_pause=0.45, edge_pad=0.10, remove_fillers=False),
    "balanced": PaceParams(max_pause=0.65, keep_pause=0.30, edge_pad=0.08, remove_fillers=True),
    "fast":     PaceParams(max_pause=0.40, keep_pause=0.16, edge_pad=0.06, remove_fillers=True),
}

# Deliberately conservative: "liksom"/"typ"/"alltså" are often meaningful, and
# cutting them mid-sentence sounds jumpy. Only pure hesitation sounds.
FILLERS_SV = frozenset({"eh", "ehm", "öh", "öhm", "äh", "ähm", "mm", "mmm", "hmm", "uh", "um"})

_STRIP = ".,!?…-–—:;\"'"


def resolve_pace(pace: str, remove_fillers: bool | None = None, *, for_shorts: bool = False) -> PaceParams:
    """Shorts are cut one notch tighter than the main video."""
    if for_shorts:
        pace = "balanced" if pace == "calm" else "fast"
    params = PACE[pace]
    if remove_fillers is not None:
        params = replace(params, remove_fillers=remove_fillers)
    return params


def snap_to_silence(t: float, silences: Sequence[tuple[float, float]], lo: float, hi: float, inset: float = 0.03) -> float:
    """Move `t` to the nearest point that lies inside a detected silence AND within [lo, hi].

    [lo, hi] is the "allowed to move" window, chosen by the caller so a cut can
    never swallow the neighbouring word. If no silence qualifies, `t` is returned unchanged.
    """
    best, best_d = None, 0.0
    for a, b in silences:
        s, e = max(a + inset, lo), min(b - inset, hi)
        if s > e:
            continue
        cand = min(max(t, s), e)
        d = abs(cand - t)
        if best is None or d < best_d:
            best, best_d = cand, d
    return t if best is None else best


def _norm(word: str) -> str:
    return word.lower().strip(_STRIP)


def build_ranges(
    units: Sequence[Unit],
    dropped: set[int],
    pace: PaceParams,
    *,
    media_duration: float,
    silences: Sequence[tuple[float, float]] = (),
    snap_window: float = 0.25,
    tail: float = 0.20,
    fillers: frozenset[str] = FILLERS_SV,
) -> list[Range]:
    """Units (+ the ids to drop) -> ordered, non-overlapping source ranges to keep."""

    # 1) Flatten kept words; mark where a hard (content-removal) break precedes a word.
    seq: list[tuple[Word, bool]] = []
    force = True
    prev_id: int | None = None
    for u in units:
        if prev_id is not None and u.id != prev_id + 1:
            force = True                      # caller passed a subset: ids are missing in between
        prev_id = u.id
        if u.id in dropped:
            force = True
            continue
        for w in u.words:
            if pace.remove_fillers and _norm(w.text) in fillers:
                force = True
                continue
            seq.append((w, force))
            force = False
    if not seq:
        return []

    # 2) Group into continuous runs. Break on removed content or on a too-long pause.
    runs: list[list[Word]] = []
    kinds: list[str] = []                     # kinds[i] = kind of break between runs[i] and runs[i+1]
    cur: list[Word] = []
    for w, forced in seq:
        if cur:
            gap = w.start - cur[-1].end
            if forced:
                runs.append(cur); kinds.append("hard"); cur = []
            elif gap > pace.max_pause:
                runs.append(cur); kinds.append("pause"); cur = []
        cur.append(w)
    runs.append(cur)

    def pad_for(kind: str) -> float:
        # A shortened pause keeps `keep_pause` in total, split across both sides.
        return pace.keep_pause / 2 if kind == "pause" else pace.edge_pad

    # 3) Turn each run into a Range: pad, then snap into real silence.
    ranges: list[Range] = []
    last_index = len(runs) - 1
    for i, run in enumerate(runs):
        first, last = run[0], run[-1]

        if i == 0:
            start = first.start - pace.edge_pad
            lo = first.start - snap_window
        else:
            prev_last = runs[i - 1][-1]
            gap = max(first.start - prev_last.end, 0.0)
            start = first.start - min(pad_for(kinds[i - 1]), gap / 2)
            lo = max(first.start - snap_window, prev_last.end)
        start = snap_to_silence(start, silences, lo, first.start)

        if i == last_index:
            end = last.end + pace.edge_pad + tail
            hi = last.end + snap_window + tail
        else:
            next_first = runs[i + 1][0]
            gap = max(next_first.start - last.end, 0.0)
            end = last.end + min(pad_for(kinds[i]), gap / 2)
            hi = min(last.end + snap_window, next_first.start)
        end = snap_to_silence(end, silences, last.end, hi)

        start, end = max(0.0, start), min(media_duration, end)
        if end - start > 0.05:
            ranges.append(Range(start, end))

    return merge_ranges(ranges)


def merge_ranges(ranges: Iterable[Range], max_gap: float = 0.03) -> list[Range]:
    """Merge overlapping or (almost) touching ranges: a 30 ms cut is just a glitch."""
    out: list[Range] = []
    for r in sorted(ranges, key=lambda r: r.start):
        if out and r.start - out[-1].end <= max_gap:
            out[-1] = Range(out[-1].start, max(out[-1].end, r.end))
        else:
            out.append(r)
    return out


class Timeline:
    """Ordered source ranges + the mapping source time -> output time."""

    def __init__(self, ranges: Sequence[Range]):
        self.ranges = list(ranges)
        self._starts = [r.start for r in self.ranges]
        self._offsets: list[float] = []
        acc = 0.0
        for r in self.ranges:
            self._offsets.append(acc)
            acc += r.duration
        self.duration = acc

    def to_output(self, t: float) -> float | None:
        """Output time of source time `t`, or None if `t` was cut away."""
        i = bisect_right(self._starts, t) - 1
        if i < 0:
            return None
        r = self.ranges[i]
        return self._offsets[i] + (t - r.start) if t < r.end else None

    def remap_words(self, words: Iterable[Word]) -> list[Word]:
        """Words that survived the cut, re-timed to the OUTPUT timeline (for captions)."""
        out: list[Word] = []
        for w in words:
            mid = (w.start + w.end) / 2
            i = bisect_right(self._starts, mid) - 1
            if i < 0 or mid >= self.ranges[i].end:
                continue
            r, off = self.ranges[i], self._offsets[i]
            s = off + max(w.start, r.start) - r.start
            e = off + min(w.end, r.end) - r.start
            out.append(Word(w.text, s, max(e, s + 0.02)))
        return out

    def to_edl(self) -> list[dict[str, float]]:
        """Edit decision list: lets a future editor UI show/adjust cuts non-destructively."""
        return [{"src_start": round(r.start, 3), "src_end": round(r.end, 3),
                 "out_start": round(o, 3)} for r, o in zip(self.ranges, self._offsets)]
