"""Editorial planning: transcript units -> what to cut / which shorts to make.

Two interchangeable planners behind one Protocol:
  * LLMPlanner       - the real thing (structured tool-call output)
  * HeuristicPlanner - deterministic fallback; no API key needed (dev, CI, offline)

Everything the LLM returns is treated as UNTRUSTED: ids are validated against
real units, ranges are bounded, and over-eager cutting is reverted.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

from ..config import Settings
from ..models import Preferences
from . import prompts
from .units import Unit

log = logging.getLogger(__name__)

MAX_DROP_FRACTION = 0.75        # never let the planner delete more than this share of the speech
SHORT_MIN_S = 20.0              # raw duration bounds (final clip is a bit shorter after tightening)
SHORT_HARD_MAX_S = 90.0
MAX_CHARS_PER_CALL = 90_000     # ~25k tokens of transcript; longer recordings are processed in parts
CUT_REASONS = {"dead_air", "false_start", "retake", "repetition", "off_topic", "meta_talk", "low_value"}


@dataclass(frozen=True)
class Cut:
    from_id: int
    to_id: int
    reason: str
    confidence: float


@dataclass
class MainPlan:
    storyline: str
    cuts: list[Cut] = field(default_factory=list)


@dataclass(frozen=True)
class ShortPlan:
    start_id: int
    end_id: int
    drop_ids: frozenset[int]
    hook_title: str
    score: float
    reason: str


class StructuredLLM(Protocol):
    def call_tool(self, *, system: str, user: str, tool_name: str, tool_description: str,
                  schema: dict[str, Any]) -> dict[str, Any]: ...


class Planner(Protocol):
    def plan_main_cuts(self, units: Sequence[Unit], prefs: Preferences, *, current_seconds: float,
                       target_seconds: float, storyline: str | None = None) -> MainPlan: ...

    def plan_shorts(self, units: Sequence[Unit], prefs: Preferences) -> list[ShortPlan]: ...


# --------------------------------------------------------------------------- formatting

def mmss(t: float) -> str:
    m, s = divmod(int(t), 60)
    return f"{m:02d}:{s:02d}"


def format_transcript(units: Sequence[Unit]) -> str:
    lines, prev_end = [], None
    for u in units:
        tags = ""
        if prev_end is not None and u.start - prev_end >= 1.5:
            tags += f" (paus {u.start - prev_end:.1f}s)"
        if u.repeat_of is not None:
            tags += f" (liknar #{u.repeat_of})"
        lines.append(f"#{u.id} [{mmss(u.start)}-{mmss(u.end)}]{tags} {u.text}")
        prev_end = u.end
    return "\n".join(lines)


def chunk_units(units: Sequence[Unit], max_chars: int = MAX_CHARS_PER_CALL) -> list[list[Unit]]:
    chunks: list[list[Unit]] = []
    cur: list[Unit] = []
    size = 0
    for u in units:
        n = len(u.text) + 40
        if cur and size + n > max_chars:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(u)
        size += n
    if cur:
        chunks.append(cur)
    return chunks or [[]]


# --------------------------------------------------------------------------- validation (untrusted LLM output)

def _as_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def covered_ids(cut: Cut, units: Sequence[Unit]) -> list[int]:
    return [u.id for u in units if cut.from_id <= u.id <= cut.to_id]


def parse_main_plan(raw: Any, units: Sequence[Unit]) -> MainPlan:
    raw = raw if isinstance(raw, dict) else {}
    cuts: list[Cut] = []
    for c in raw.get("cuts") or []:
        if not isinstance(c, dict):
            continue
        a, b = _as_int(c.get("from_id")), _as_int(c.get("to_id"))
        if a is None or b is None:
            continue
        if a > b:
            a, b = b, a
        cut = Cut(a, b, c.get("reason") if c.get("reason") in CUT_REASONS else "low_value",
                  min(max(float(c.get("confidence", 0.5) or 0.5), 0.0), 1.0))
        if covered_ids(cut, units):
            cuts.append(cut)

    # Safety net: if the model got trigger-happy, revert its least confident cuts first.
    total = sum(u.duration for u in units) or 1.0
    by_id = {u.id: u for u in units}

    def dropped_share(cs: list[Cut]) -> float:
        ids = {i for c in cs for i in covered_ids(c, units)}
        return sum(by_id[i].duration for i in ids) / total

    cuts.sort(key=lambda c: c.confidence)
    while cuts and dropped_share(cuts) > MAX_DROP_FRACTION:
        removed = cuts.pop(0)
        log.warning("Planner cut too much; reverting low-confidence cut %s", removed)
    cuts.sort(key=lambda c: c.from_id)
    return MainPlan(storyline=str(raw.get("storyline") or ""), cuts=cuts)


def expand_cuts(cuts: Sequence[Cut], units: Sequence[Unit]) -> set[int]:
    return {i for c in cuts for i in covered_ids(c, units)}


def parse_shorts(raw: Any, units: Sequence[Unit]) -> list[ShortPlan]:
    raw = raw if isinstance(raw, dict) else {}
    by_id = {u.id: u for u in units}
    out: list[ShortPlan] = []
    for s in raw.get("shorts") or []:
        if not isinstance(s, dict):
            continue
        a, b = _as_int(s.get("start_id")), _as_int(s.get("end_id"))
        if a is None or b is None or a not in by_id or b not in by_id or a >= b:
            continue
        drop = frozenset(i for i in (_as_int(x) for x in (s.get("drop_ids") or [])) if i is not None and a < i < b)
        dur = (by_id[b].end - by_id[a].start) - sum(by_id[i].duration for i in drop if i in by_id)
        if not (SHORT_MIN_S <= dur <= SHORT_HARD_MAX_S):
            log.info("Discarding short %s-%s: raw duration %.0fs out of bounds", a, b, dur)
            continue
        try:
            score = min(max(float(s.get("score", 50)), 0.0), 100.0)
        except (TypeError, ValueError):
            score = 50.0
        out.append(ShortPlan(a, b, drop, str(s.get("hook_title") or "")[:80], score, str(s.get("reason") or "")))
    return out


def select_shorts(candidates: Sequence[ShortPlan], n: int) -> list[ShortPlan]:
    """Best score first; skip anything overlapping an already chosen clip."""
    chosen: list[ShortPlan] = []
    for c in sorted(candidates, key=lambda c: c.score, reverse=True):
        if all(c.end_id < k.start_id or c.start_id > k.end_id for k in chosen):
            chosen.append(c)
        if len(chosen) == n:
            break
    return chosen


# --------------------------------------------------------------------------- planners

class LLMPlanner:
    def __init__(self, client: StructuredLLM, *, max_chars: int = MAX_CHARS_PER_CALL):
        self.client = client
        self.max_chars = max_chars

    def plan_main_cuts(self, units, prefs, *, current_seconds, target_seconds, storyline=None) -> MainPlan:
        chunks = chunk_units(units, self.max_chars)
        total = sum(u.duration for u in units) or 1.0
        story, cuts = storyline, []
        for i, chunk in enumerate(chunks):
            share = sum(u.duration for u in chunk) / total      # split the budget proportionally
            raw = self.client.call_tool(
                system=prompts.main_system_prompt(prefs),
                user=prompts.main_user_prompt(
                    transcript=format_transcript(chunk), current_seconds=current_seconds * share,
                    target_seconds=target_seconds * share, storyline=story, part=(i + 1, len(chunks))),
                tool_name="submit_edit_plan",
                tool_description="Submit the unit ranges to remove and the storyline.",
                schema=prompts.MAIN_SCHEMA,
            )
            plan = parse_main_plan(raw, chunk)
            story = story or plan.storyline
            cuts += plan.cuts
        return MainPlan(story or "", cuts)

    def plan_shorts(self, units, prefs) -> list[ShortPlan]:
        chunks = chunk_units(units, self.max_chars)
        candidates: list[ShortPlan] = []
        for i, chunk in enumerate(chunks):
            raw = self.client.call_tool(
                system=prompts.shorts_system_prompt(prefs),
                user=prompts.shorts_user_prompt(transcript=format_transcript(chunk), part=(i + 1, len(chunks))),
                tool_name="submit_shorts",
                tool_description="Submit the best short-form clip candidates.",
                schema=prompts.SHORTS_SCHEMA,
            )
            candidates += parse_shorts(raw, chunk)
        return select_shorts(candidates, prefs.num_shorts)


class HeuristicPlanner:
    """No-LLM fallback. Not smart, but deterministic and good enough to exercise the whole pipeline."""

    def plan_main_cuts(self, units, prefs, *, current_seconds, target_seconds, storyline=None) -> MainPlan:
        cuts = [Cut(u.repeat_of, u.repeat_of, "retake", 0.7) for u in units
                if u.repeat_of is not None and u.repeat_similarity >= 0.8
                and any(x.id == u.repeat_of for x in units)]            # drop the EARLIER take
        return MainPlan(storyline or "(heuristic planner: no storyline)", cuts)

    def plan_shorts(self, units, prefs) -> list[ShortPlan]:
        cands: list[ShortPlan] = []
        j = 0
        for i, u in enumerate(units):
            j = max(j, i)
            while j < len(units) - 1 and units[j].end - u.start < 40:
                j += 1
            while j < len(units) - 1 and not units[j].text.endswith((".", "?", "!")) and units[j].end - u.start < 60:
                j += 1
            win = units[i:j + 1]
            dur = win[-1].end - u.start
            if i == j or not (SHORT_MIN_S <= dur <= SHORT_HARD_MAX_S):
                continue
            density = sum(len(x.words) for x in win) / dur            # words per second
            after_pause = i == 0 or u.start - units[i - 1].end > 0.8
            cands.append(ShortPlan(u.id, win[-1].id, frozenset(), "", density * 20 + (10 if after_pause else 0),
                                   "heuristic: dense speech window"))
        return select_shorts(cands, prefs.num_shorts)


def make_planner(settings: Settings, *, force_heuristic: bool = False) -> Planner:
    if force_heuristic or not settings.anthropic_api_key:
        log.warning("No ANTHROPIC_API_KEY (or --no-llm): using HeuristicPlanner.")
        return HeuristicPlanner()
    from ..llm.anthropic_client import AnthropicClient
    return LLMPlanner(AnthropicClient(settings.anthropic_api_key, settings.llm_model))
