"""HTTP API (FastAPI). Thin by design: validate, store, enqueue, report.

POST /jobs                       multipart: `video` file + `preferences` (JSON string)  -> 202 + job
GET  /jobs/{id}                  status / stage / progress / outputs / result manifest
GET  /jobs/{id}/files/{name}     download an output (only files listed in the job's `outputs`)
DELETE /jobs/{id}                remove the job and all its files
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import __version__
from ..config import Settings
from ..models import Preferences
from ..pipeline.planner import make_planner
from .jobs import JobRunner, JobStore

ALLOWED_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
CHUNK = 1024 * 1024


def create_app(settings: Settings | None = None, runner: JobRunner | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = JobStore(settings.data_dir / "jobs")
    store.recover_interrupted()
    runner = runner or JobRunner(store, settings, make_planner(settings))
    app = FastAPI(title="Clipsmith API", version=__version__)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "version": __version__}

    @app.post("/jobs", status_code=202)
    async def create_job(video: UploadFile = File(...), preferences: str = Form("{}")) -> dict:
        try:
            prefs = Preferences.from_dict(json.loads(preferences))
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=422, detail=f"Invalid preferences: {e}")

        ext = Path(video.filename or "").suffix.lower()
        if ext not in ALLOWED_EXT:
            raise HTTPException(status_code=415, detail=f"Unsupported file type {ext!r}; use one of {sorted(ALLOWED_EXT)}")

        job_id = store.create(prefs)
        dest = store.job_dir(job_id) / f"source{ext}"
        limit, size = settings.max_upload_mb * 1024 * 1024, 0
        try:
            with dest.open("wb") as f:
                while chunk := await video.read(CHUNK):
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(status_code=413, detail=f"File exceeds {settings.max_upload_mb} MB")
                    f.write(chunk)
        except BaseException:
            store.delete(job_id)
            raise

        store.update(job_id, status="queued")
        runner.submit(job_id)
        return store.get(job_id)

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str) -> dict:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    @app.get("/jobs/{job_id}/files/{name:path}")
    def get_file(job_id: str, name: str) -> FileResponse:
        job = store.get(job_id)
        if job is None or name not in job.get("outputs", []):    # whitelist => no path traversal
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(store.job_dir(job_id) / "output" / name)

    @app.delete("/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str) -> None:
        if store.get(job_id) is None:
            raise HTTPException(status_code=404, detail="Job not found")
        store.delete(job_id)

    return app


def app() -> FastAPI:  # uvicorn clipsmith.api.app:app --factory
    return create_app()
