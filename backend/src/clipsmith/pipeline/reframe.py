"""Turn a landscape or portrait source into a 1080x1920 (9:16) frame.

Three layouts:
  * portrait source        -> cover-scale (phone clips are already vertical)
  * landscape + camera     -> crop a 9:16 window around the subject (x_center)
  * landscape + screen     -> keep the whole screen, fit to width, blurred backdrop
                              (cropping a screen recording would cut off the UI)
"""
from __future__ import annotations

from pathlib import Path

from .media import MediaInfo

OUT_W, OUT_H = 1080, 1920


def estimate_x_center(source: Path, start: float, end: float) -> float | None:
    """SEAM FOR FACE TRACKING (phase 2). Return the subject's horizontal centre as 0..1.

    Planned implementation: sample ~2 frames/s in [start, end], detect faces
    (MediaPipe / OpenCV DNN), take the median x, then smooth it. Time-varying
    follow-cam later = replace the constant in `x=` below with an expression
    or drive the crop through ffmpeg's `sendcmd`.
    None => centre crop.
    """
    return None


def vertical_graph(info: MediaInfo, source_type: str, *, x_center: float | None = None,
                   in_label: str = "vcat", out_label: str = "vref") -> str:
    src, dst = f"[{in_label}]", f"[{out_label}]"
    if info.is_portrait:
        return f"{src}scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},setsar=1{dst}"

    if source_type == "screen":
        return (
            f"{src}split=2[bgsrc][fgsrc];"
            f"[bgsrc]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},"
            f"boxblur=40:6,eq=brightness=-0.08[bg];"
            f"[fgsrc]scale={OUT_W}:-2,setsar=1[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1{dst}"
        )

    xc = 0.5 if x_center is None else min(max(x_center, 0.0), 1.0)
    return (
        f"{src}crop=w='trunc(ih*9/16/2)*2':h=ih:x='clip(iw*{xc:.4f}-ow/2,0,iw-ow)':y=0,"
        f"scale={OUT_W}:{OUT_H},setsar=1{dst}"
    )
