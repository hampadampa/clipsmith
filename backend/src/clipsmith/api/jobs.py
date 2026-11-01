"""Job persistence + background execution.

Phase 1 keeps this deliberately boring: one status.json per job on disk and a
thread pool. The seam to replace it later (Redis/Arq/Celery + Postgres + S3) is
exactly JobStore + JobRunner.submit(); the pipeline itself never changes.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from ..config import Settings
from ..models import Preferences
from ..pipeline.planner import Planner
from ..pipeline.run import TranscribeFn, run_pipeline

log = logging.getLogger(__name__)

_JOB_ID = re.compile(r"^[0-9a-f]{32}$")
EXPOSED_SUFFIXES = {".mp4", ".srt", ".json"}
INTERRUPTED_MESSAGE = "Processing was interrupted because the engine stopped. Send the recording again."


class JobStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def job_dir(self, job_id: str) -> Path:
        if not _JOB_ID.match(job_id):           # also blocks path traversal
            raise KeyError(job_id)
        return self.root / job_id

    def create(self, prefs: Preferences) -> str:
        job_id = uuid.uuid4().hex
        (self.job_dir(job_id) / "output").mkdir(parents=True)
        self._write(job_id, {
            "id": job_id, "status": "uploading", "stage": None, "progress": 0.0, "error": None,
            "created_at": time.time(), "preferences": prefs.to_dict(), "outputs": [], "result": None,
        })
        return job_id

    def get(self, job_id: str) -> dict[str, Any] | None:
        try:
            path = self.job_dir(job_id) / "status.json"
        except KeyError:
            return None
        with self._lock:
            return json.loads(path.read_text()) if path.exists() else None

    def update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            path = self.job_dir(job_id) / "status.json"
            data = json.loads(path.read_text())
            data.update(fields)
            self._write_unlocked(path, data)

    def delete(self, job_id: str) -> None:
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    def recover_interrupted(self) -> list[str]:
        """Call once at start-up, before any job runs.

        A job that was uploading, queued or processing when the process died would otherwise stay in that state
        forever and the client would poll it endlessly. The pipeline is not resumable, so mark it failed with a
        message that tells the person what to do. Returns the ids that were changed.
        """
        changed: list[str] = []
        for d in sorted(p for p in self.root.iterdir() if p.is_dir() and _JOB_ID.match(p.name)):
            status_path = d / "status.json"
            try:
                job = json.loads(status_path.read_text())
            except (OSError, ValueError):
                continue                          # unreadable status: leave it alone rather than guess
            if job.get("status") in ("uploading", "queued", "processing"):
                self.update(d.name, status="failed", error=INTERRUPTED_MESSAGE)
                changed.append(d.name)
        return changed

    def _write(self, job_id: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._write_unlocked(self.job_dir(job_id) / "status.json", data)

    @staticmethod
    def _write_unlocked(path: Path, data: dict[str, Any]) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        os.replace(tmp, path)                    # atomic: readers never see half a file


class JobRunner:
    def __init__(self, store: JobStore, settings: Settings, planner: Planner, *,
                 transcribe_fn: TranscribeFn | None = None):
        self.store, self.settings, self.planner, self.transcribe_fn = store, settings, planner, transcribe_fn
        self._pool = ThreadPoolExecutor(max_workers=settings.max_concurrent_jobs, thread_name_prefix="job")

    def submit(self, job_id: str) -> Future:
        return self._pool.submit(self._run, job_id)

    def _run(self, job_id: str) -> None:
        job_dir = self.store.job_dir(job_id)
        out_dir = job_dir / "output"
        try:
            status = self.store.get(job_id) or {}
            prefs = Preferences.from_dict(status["preferences"])
            source = next(job_dir.glob("source.*"))
            self.store.update(job_id, status="processing")

            manifest = run_pipeline(
                source, out_dir, prefs, self.settings, self.planner,
                progress=lambda stage, frac: self.store.update(job_id, stage=stage, progress=round(frac, 3)),
                transcribe_fn=self.transcribe_fn,
            )
            outputs = sorted(p.name for p in out_dir.iterdir() if p.is_file() and p.suffix in EXPOSED_SUFFIXES)
            if self.settings.delete_source_after:
                source.unlink(missing_ok=True)
            self.store.update(job_id, status="done", stage="done", progress=1.0, outputs=outputs, result=manifest)
        except ValueError as e:                  # expected, user-actionable problems (no speech, no audio...)
            log.warning("Job %s rejected: %s", job_id, e)
            self.store.update(job_id, status="failed", error=str(e))
        except Exception:                        # noqa: BLE001 - never leak internals to the client
            log.exception("Job %s crashed", job_id)
            self.store.update(job_id, status="failed", error="Processing failed. Please try again.")
