"""Onboarding preferences: the contract between the apps and the pipeline.

Plain dataclass + explicit validation so the core has zero third-party deps.
The mobile/desktop apps send this as JSON next to the video upload.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from typing import Any

NICHES = ("garage", "tech", "vlog", "tutorial", "presentation", "other")
PACES = ("calm", "balanced", "fast")
CAPTION_STYLES = ("pop", "karaoke", "minimal", "none")
SOURCE_TYPES = ("camera", "screen")
LANGUAGES = ("sv", "en", "no", "da", "fi", "de")      # offered in the apps; any Whisper language code is accepted
JOB_STATUSES = ("uploading", "queued", "processing", "done", "failed")
TARGET_MINUTES_RANGE = (1.0, 60.0)
SHORTS_RANGE = (1, 8)
NOTES_MAX_CHARS = 1000


@dataclass(frozen=True)
class Preferences:
    niche: str = "other"
    niche_notes: str = ""            # free text: "bil-el, scheman, felsökning ..."
    pace: str = "balanced"           # calm | balanced | fast
    caption_style: str = "pop"       # pop | karaoke | minimal | none
    source_type: str = "camera"      # camera (phone) | screen (desktop recorder)
    language: str = "sv"
    target_minutes: float = 10.0     # ceiling for the main video
    num_shorts: int = 4              # 3-5
    remove_fillers: bool | None = None  # None => derived from pace

    def __post_init__(self) -> None:
        def check(name: str, allowed: tuple[str, ...]) -> None:
            if getattr(self, name) not in allowed:
                raise ValueError(f"{name} must be one of {allowed}, got {getattr(self, name)!r}")

        check("niche", NICHES)
        check("pace", PACES)
        check("caption_style", CAPTION_STYLES)
        check("source_type", SOURCE_TYPES)
        lo, hi = TARGET_MINUTES_RANGE
        if not (lo <= self.target_minutes <= hi):
            raise ValueError(f"target_minutes must be between {lo:g} and {hi:g}")
        lo_s, hi_s = SHORTS_RANGE
        if not (lo_s <= self.num_shorts <= hi_s):
            raise ValueError(f"num_shorts must be between {lo_s} and {hi_s}")
        if len(self.niche_notes) > NOTES_MAX_CHARS:
            raise ValueError(f"niche_notes is limited to {NOTES_MAX_CHARS} characters")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Preferences":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})  # ignore unknown keys (forward compat)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
