"""Caption generation (ASS for burned-in dynamic captions, SRT for the main video).

Word timings must already be on the OUTPUT timeline (see Timeline.remap_words).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .units import Word

ACTIVE = "&H00D7FF&"  # gold, in ASS override-tag colour order (BGR)


@dataclass(frozen=True)
class CaptionStyle:
    font_size: int
    primary: str      # ASS style colour: &HAABBGGRR
    secondary: str
    outline: int
    margin_v: int     # distance from bottom; keeps text above the TikTok/Reels/Shorts UI zone
    max_words: int
    max_chars: int
    upper: bool
    mode: str         # "pop" (one event per word) | "karaoke" (\k tags) | "plain"


STYLES: dict[str, CaptionStyle] = {
    "pop":      CaptionStyle(104, "&H00FFFFFF", "&H00FFFFFF", 9, 560, 3, 20, True,  "pop"),
    "karaoke":  CaptionStyle(92,  "&H0000D7FF", "&H00FFFFFF", 8, 520, 4, 26, False, "karaoke"),
    "minimal":  CaptionStyle(64,  "&H00FFFFFF", "&H00FFFFFF", 4, 330, 7, 38, False, "plain"),
}


def group_words(words: Sequence[Word], *, max_words: int, max_chars: int, max_gap: float = 0.6) -> list[list[Word]]:
    groups: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur:
            too_many = len(cur) >= max_words
            too_long = len(" ".join(x.text for x in cur + [w])) > max_chars
            gap = w.start - cur[-1].end > max_gap
            sentence_done = cur[-1].text.endswith((".", "?", "!"))
            if too_many or too_long or gap or sentence_done:
                groups.append(cur)
                cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def _esc(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def build_ass(words: Sequence[Word], style_name: str, *, font: str = "Arial",
              width: int = 1080, height: int = 1920) -> str | None:
    """Return ASS text, or None if captions are disabled / there is nothing to show."""
    style = STYLES.get(style_name)
    if style is None or not words:
        return None

    header = (
        "[Script Info]\nScriptType: v4.00+\n"
        f"PlayResX: {width}\nPlayResY: {height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font},{style.font_size},{style.primary},{style.secondary},&H00000000,&H64000000,"
        f"-1,0,0,0,100,100,0,0,1,{style.outline},2,2,60,60,{style.margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    def fmt(w: Word) -> str:
        return _esc(w.text.upper() if style.upper else w.text)

    groups = group_words(words, max_words=style.max_words, max_chars=style.max_chars)
    lines: list[str] = []
    for gi, group in enumerate(groups):
        hold_until = group[-1].end + 0.15
        if gi + 1 < len(groups):
            hold_until = min(hold_until, groups[gi + 1][0].start)
        hold_until = max(hold_until, group[-1].end)

        if style.mode == "pop":
            # one event per word; the active word is gold and slightly larger
            for wi, w in enumerate(group):
                end = group[wi + 1].start if wi + 1 < len(group) else hold_until
                parts = [
                    ("{\\c" + ACTIVE + "\\fscx112\\fscy112}" + fmt(x) + "{\\r}") if xi == wi else fmt(x)
                    for xi, x in enumerate(group)
                ]
                lines.append(f"Dialogue: 0,{_ass_time(w.start)},{_ass_time(end)},Default,,0,0,0,,{' '.join(parts)}")
        elif style.mode == "karaoke":
            parts = []
            for wi, w in enumerate(group):
                nxt = group[wi + 1].start if wi + 1 < len(group) else hold_until
                parts.append(f"{{\\k{max(1, round((nxt - w.start) * 100))}}}{fmt(w)}")
            lines.append(f"Dialogue: 0,{_ass_time(group[0].start)},{_ass_time(hold_until)},Default,,0,0,0,,{' '.join(parts)}")
        else:
            text = " ".join(fmt(w) for w in group)
            lines.append(f"Dialogue: 0,{_ass_time(group[0].start)},{_ass_time(hold_until)},Default,,0,0,0,,{text}")

    return header + "\n".join(lines) + "\n"


def _srt_time(t: float) -> str:
    ms = max(0, round(t * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(words: Sequence[Word]) -> str:
    groups = group_words(words, max_words=9, max_chars=42, max_gap=0.8)
    blocks = []
    for i, g in enumerate(groups, 1):
        blocks.append(f"{i}\n{_srt_time(g[0].start)} --> {_srt_time(g[-1].end)}\n{' '.join(w.text for w in g)}\n")
    return "\n".join(blocks)
