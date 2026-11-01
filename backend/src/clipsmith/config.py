"""Runtime settings, read from environment variables (see .env.example)."""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("./data")

    # Transcription (faster-whisper). For Swedish, a fine-tuned model such as
    # KBLab's KB-Whisper is worth benchmarking against "large-v3".
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"          # "cuda" | "cpu" | "auto"
    whisper_compute_type: str = "auto"    # "float16" on GPU, "int8" on CPU

    # LLM planner. No key => deterministic HeuristicPlanner (handy for dev/tests).
    anthropic_api_key: str | None = None
    llm_model: str = "claude-sonnet-5-5"

    # Rendering
    x264_preset: str = "medium"
    x264_crf: int = 20
    caption_font: str = "Poppins"
    fonts_dir: Path | None = None

    # API
    max_concurrent_jobs: int = 1
    max_upload_mb: int = 4096
    delete_source_after: bool = False     # drop the uploaded source once the outputs exist (the desktop app keeps its own copy)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        e = (os.environ if env is None else env).get
        fonts = e("CLIPSMITH_FONTS_DIR")
        return cls(
            data_dir=Path(e("CLIPSMITH_DATA_DIR", "./data")),
            whisper_model=e("CLIPSMITH_WHISPER_MODEL", "large-v3"),
            whisper_device=e("CLIPSMITH_WHISPER_DEVICE", "auto"),
            whisper_compute_type=e("CLIPSMITH_WHISPER_COMPUTE", "auto"),
            anthropic_api_key=e("ANTHROPIC_API_KEY") or None,
            llm_model=e("CLIPSMITH_LLM_MODEL", "claude-sonnet-5-5"),
            x264_preset=e("CLIPSMITH_X264_PRESET", "medium"),
            x264_crf=int(e("CLIPSMITH_X264_CRF", "20")),
            caption_font=e("CLIPSMITH_CAPTION_FONT", "Poppins"),
            fonts_dir=Path(fonts) if fonts else None,
            max_concurrent_jobs=int(e("CLIPSMITH_MAX_JOBS", "1")),
            max_upload_mb=int(e("CLIPSMITH_MAX_UPLOAD_MB", "4096")),
            delete_source_after=e("CLIPSMITH_DELETE_SOURCE_AFTER", "0").lower() in ("1", "true", "yes"),
        )
