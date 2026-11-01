"""Speech -> word-level timestamps via faster-whisper (CTranslate2; ~4x faster than openai-whisper)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from ..config import Settings
from ..models import Preferences
from .units import Word


@lru_cache(maxsize=1)
def _model(name: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel  # lazy: heavy import, only needed here

    return WhisperModel(name, device=device, compute_type=compute_type)


def transcribe(audio: Path, settings: Settings, prefs: Preferences) -> list[Word]:
    model = _model(settings.whisper_model, settings.whisper_device, settings.whisper_compute_type)
    segments, _info = model.transcribe(
        str(audio),
        language=prefs.language,
        word_timestamps=True,
        vad_filter=True,                         # skip non-speech => fewer hallucinated words
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,        # avoids runaway repetition loops on long audio
        beam_size=5,
        # Domain vocabulary nudges Whisper toward correct spellings of niche terms:
        initial_prompt=prefs.niche_notes or None,
    )
    words: list[Word] = []
    last_end = 0.0
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            start = max(float(w.start), last_end)    # enforce monotonic, non-overlapping timings
            end = max(float(w.end), start + 0.02)
            words.append(Word(text, start, end))
            last_end = end
    return words
