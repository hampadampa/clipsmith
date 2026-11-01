"""Prompts + tool schemas for the editorial LLM calls.

Design rules:
  * The LLM only ever references numbered units (#id). It never writes timestamps.
  * Output is forced through a tool call (JSON schema) => no free-text parsing.
  * Niche + pace from onboarding are injected as editorial guidance: this is the "röda tråden".
"""
from __future__ import annotations

from ..models import Preferences

LANGUAGE_NAMES = {"sv": "Swedish", "en": "English", "no": "Norwegian", "da": "Danish", "fi": "Finnish", "de": "German"}

NICHE_GUIDE = {
    "garage": (
        "Mechanics / garage / car repair. The viewer wants the diagnostic reasoning and the hands-on steps IN ORDER: "
        "symptom -> test -> finding -> fix. Keep torque values, part names/numbers, measurements, tool names, "
        "safety warnings and 'why' explanations. Cut: hunting for tools, waiting, re-explaining the same bolt, "
        "off-topic small talk while working."),
    "tech": (
        "Tech / review / explainer. Keep claims together with their evidence, comparisons, numbers, benchmarks and "
        "opinions with a reason. Cut over-long intros, throat-clearing transitions and repeated caveats."),
    "vlog": (
        "Vlog. Personality is the product: keep humour, emotional beats, spontaneous moments and story momentum. "
        "Cut dull logistics, dead air and repeating yourself. Be looser than for tutorials."),
    "tutorial": (
        "Tutorial / screen recording (coding, wiring diagrams, software). Keep every step together with the "
        "explanation that makes it reproducible. Cut mistakes that are immediately corrected, long waits "
        "(loading, compiling), and narration of trivial mouse movement."),
    "presentation": (
        "Presentation / talk. Keep the structure (problem -> idea -> evidence -> takeaway), key messages and "
        "memorable examples. Cut filler transitions, repeated summaries and slide-reading padding."),
    "other": "General spoken-word video. Keep what serves the central point; cut waste.",
}

PACE_GUIDE = {
    "calm": ("Calm pace: cut conservatively. Leave room to breathe and let explanations finish. "
             "Only remove clear waste (dead air, aborted sentences, retakes, obvious repetition)."),
    "balanced": ("Balanced pace: remove waste and mild repetition; trim tangents that don't serve the thread; "
                 "keep a natural conversational rhythm."),
    "fast": ("Fast, high-energy pace: be aggressive. If a unit doesn't drive the point forward, cut it. "
             "Prefer punchy, dense sections; drop hedging, recaps and slow build-ups."),
}

# --------------------------------------------------------------------------- main video

MAIN_SCHEMA = {
    "type": "object",
    "properties": {
        "storyline": {"type": "string",
                      "description": "1-2 sentences: the red thread of this video (what it is about and where it ends up)."},
        "cuts": {
            "type": "array",
            "description": "Ranges of unit ids to REMOVE (inclusive). Anything not listed is kept.",
            "items": {
                "type": "object",
                "properties": {
                    "from_id": {"type": "integer"},
                    "to_id": {"type": "integer"},
                    "reason": {"type": "string",
                               "enum": ["dead_air", "false_start", "retake", "repetition",
                                        "off_topic", "meta_talk", "low_value"]},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1,
                                   "description": "0.9+ = obvious waste; 0.5-0.7 = judgement call made for length/pace."},
                },
                "required": ["from_id", "to_id", "reason", "confidence"],
            },
        },
    },
    "required": ["storyline", "cuts"],
}


def main_system_prompt(prefs: Preferences) -> str:
    lang = LANGUAGE_NAMES.get(prefs.language, prefs.language)
    return f"""You are a senior video editor tightening a raw {lang} spoken-word recording into a clean final cut.
You receive the transcript as numbered units: `#id [mm:ss-mm:ss] text`. Decide which units to REMOVE.

Rules
- Chronological only. You never reorder, rewrite or invent. You only remove whole units (contiguous ranges are fine).
- REMOVE: dead air and off-camera chatter; aborted sentences and false starts; retakes (the speaker says the same thing again - keep the BEST take, usually the later, more complete one); repetition that adds nothing; tangents that don't serve the red thread; meta-talk about recording ("wait, am I recording?", "let me start over").
- KEEP: the explanation, the steps, the numbers/names/specs, and the moments that carry personality.
- Units tagged `(liknar #N)` are probable retakes of unit N. It is only a hint: read both before deciding.
- Never cut the setup that a kept unit depends on (don't remove "first take out the 10 mm bolt" and keep "now that the bolt is out").
- The target length is a CEILING, never a floor. Never pad. If the video is already short enough, remove only genuine waste.
- Set `confidence` honestly. Cuts you make only to reach the target length are 0.5-0.7; they are the first to be reverted if needed.

Editorial profile
- Niche: {NICHE_GUIDE[prefs.niche]}
- Pace: {PACE_GUIDE[prefs.pace]}
{('- Creator notes: ' + prefs.niche_notes) if prefs.niche_notes else ''}""".strip()


def main_user_prompt(*, transcript: str, current_seconds: float, target_seconds: float,
                     storyline: str | None, part: tuple[int, int]) -> str:
    over = current_seconds - target_seconds
    length = (f"Current length of this part: {current_seconds / 60:.1f} min. Target: at most {target_seconds / 60:.1f} min. "
              + (f"Remove roughly {over / 60:.1f} min ({over:.0f} s) beyond obvious waste, starting with the least important material."
                 if over > 0 else "It is already within target: remove only genuine waste."))
    ctx = f"\nRed thread established so far: {storyline}\n" if storyline else ""
    part_note = f"\n(Part {part[0]} of {part[1]} of a longer recording.)\n" if part[1] > 1 else ""
    return f"{length}{part_note}{ctx}\nTRANSCRIPT\n{transcript}"


# --------------------------------------------------------------------------- shorts

SHORTS_SCHEMA = {
    "type": "object",
    "properties": {
        "shorts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_id": {"type": "integer", "description": "First unit of the clip (inclusive)."},
                    "end_id": {"type": "integer", "description": "Last unit of the clip (inclusive)."},
                    "drop_ids": {"type": "array", "items": {"type": "integer"},
                                 "description": "Rambling units inside the range to skip. Never the first or last unit."},
                    "hook_title": {"type": "string", "description": "Short on-screen/title hook, max ~60 chars, in the video's language."},
                    "score": {"type": "number", "minimum": 0, "maximum": 100},
                    "reason": {"type": "string", "description": "One sentence: why a stranger would watch this to the end."},
                },
                "required": ["start_id", "end_id", "hook_title", "score", "reason"],
            },
        }
    },
    "required": ["shorts"],
}


def shorts_system_prompt(prefs: Preferences) -> str:
    lang = LANGUAGE_NAMES.get(prefs.language, prefs.language)
    return f"""You pick self-contained short-form clips (YouTube Shorts / Instagram Reels / TikTok) from a long {lang} spoken video.
You receive the transcript as numbered units: `#id [mm:ss-mm:ss] text`.

A great clip
- is ONE idea with a clear beginning and end, understandable without the rest of the video;
- opens with a hook in its first 1-2 seconds: a bold claim, a question, a surprising result or a concrete problem. Never "hej och välkomna", never context that needs earlier explanation;
- ends on the payoff (conclusion, punchline, result), at a sentence end - not mid-thought;
- is roughly 30-60 s of speech (never under 20 s, never over 90 s);
- starts and ends exactly on unit boundaries (start_id / end_id are inclusive);
- may skip rambling units inside via drop_ids (never the first or last unit);
- does not overlap other clips.

Score 0-100 = how likely a stranger scrolling stays to the end: hook strength, standalone clarity, payoff/utility/emotion, density.
Return at most {prefs.num_shorts} clips. Fewer strong clips beat padding with weak ones.

Niche: {NICHE_GUIDE[prefs.niche]}
{('Creator notes: ' + prefs.niche_notes) if prefs.niche_notes else ''}""".strip()


def shorts_user_prompt(*, transcript: str, part: tuple[int, int]) -> str:
    note = f"(Part {part[0]} of {part[1]} of a longer recording. Pick the best clips from this part only.)\n\n" if part[1] > 1 else ""
    return f"{note}TRANSCRIPT\n{transcript}"
