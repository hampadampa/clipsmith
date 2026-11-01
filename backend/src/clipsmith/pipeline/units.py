"""Words -> numbered 'units' (sentence-ish chunks) that the LLM reasons about.

Why units? LLMs are unreliable at copying precise timestamps but very good at
referring to numbered lines. So the LLM only ever sees/returns unit IDs; all
timestamp math happens deterministically in timeline.py.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher


@dataclass(frozen=True, slots=True)
class Word:
    text: str
    start: float
    end: float


@dataclass(slots=True)
class Unit:
    id: int
    words: list[Word]
    repeat_of: int | None = None      # set by annotate_repeats(): probable retake of this earlier unit
    repeat_similarity: float = 0.0

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


_SENTENCE_END = (".", "?", "!", "…")


def build_units(
    words: list[Word],
    *,
    max_unit_s: float = 14.0,
    split_gap_s: float = 0.8,
    min_sentence_s: float = 1.5,
    max_words: int = 45,
) -> list[Unit]:
    """Split on sentence punctuation, long pauses, or when a unit grows too long."""
    units: list[Unit] = []
    cur: list[Word] = []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        dur = w.end - cur[0].start
        ends_sentence = w.text.endswith(_SENTENCE_END) and dur >= min_sentence_s
        long_gap = nxt is not None and (nxt.start - w.end) > split_gap_s
        too_long = dur >= max_unit_s or len(cur) >= max_words
        if nxt is None or ends_sentence or long_gap or too_long:
            units.append(Unit(id=len(units), words=cur))
            cur = []
    return units


_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)


def _tokens(text: str) -> list[str]:
    return [t for t in _NON_WORD.sub(" ", text.lower()).split() if t]


def annotate_repeats(units: list[Unit], *, lookback: int = 8, threshold: float = 0.70, min_words: int = 4) -> None:
    """Flag probable retakes ("säg om"): unit i says (almost) the same as a recent unit j < i.

    Creators re-say sentences constantly. A cheap string-similarity hint makes
    the LLM's job much more reliable than asking it to spot them cold.
    The earlier take may be truncated (false start), so besides the plain ratio
    we also score how much of the *shorter* text is contained in the longer one.
    """
    toks = [_tokens(u.text) for u in units]
    for i, u in enumerate(units):
        if len(toks[i]) < min_words:
            continue
        best_id, best = None, 0.0
        for j in range(max(0, i - lookback), i):
            if len(toks[j]) < min_words:
                continue
            sm = SequenceMatcher(None, toks[j], toks[i], autojunk=False)
            matched = sum(b.size for b in sm.get_matching_blocks())
            score = max(sm.ratio(), 0.9 * matched / min(len(toks[j]), len(toks[i])))
            if score > best:
                best_id, best = units[j].id, score
        if best >= threshold:
            u.repeat_of, u.repeat_similarity = best_id, best
