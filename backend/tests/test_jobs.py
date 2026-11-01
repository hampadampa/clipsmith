import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from clipsmith.config import Settings
from clipsmith.models import Preferences
from clipsmith.api.jobs import JobRunner, JobStore
from clipsmith.pipeline.planner import HeuristicPlanner
from clipsmith.pipeline.units import Word


class JobStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = JobStore(self.tmp / "jobs")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_create_get_update(self):
        jid = self.store.create(Preferences(niche="garage"))
        job = self.store.get(jid)
        self.assertEqual(job["status"], "uploading")
        self.assertEqual(job["preferences"]["niche"], "garage")
        self.store.update(jid, status="queued", progress=0.5)
        self.assertEqual(self.store.get(jid)["progress"], 0.5)

    def test_rejects_path_traversal_ids(self):
        self.assertIsNone(self.store.get("../../etc/passwd"))
        self.assertIsNone(self.store.get("0" * 31))
        with self.assertRaises(KeyError):
            self.store.job_dir("../x")


class RecoveryTests(unittest.TestCase):
    def test_jobs_left_running_by_a_dead_process_are_failed_with_a_clear_message(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            store = JobStore(tmp / "jobs")
            states = {}
            for status in ("uploading", "queued", "processing", "done", "failed"):
                jid = store.create(Preferences())
                store.update(jid, status=status, error="old" if status == "failed" else None)
                states[status] = jid
            broken = store.create(Preferences())
            (store.job_dir(broken) / "status.json").write_text("{not json")

            changed = JobStore(tmp / "jobs").recover_interrupted()

            self.assertEqual(sorted(changed), sorted(states[s] for s in ("uploading", "queued", "processing")))
            for s in ("uploading", "queued", "processing"):
                job = store.get(states[s])
                self.assertEqual(job["status"], "failed")
                self.assertIn("interrupted", job["error"])
            self.assertEqual(store.get(states["done"])["status"], "done")
            self.assertEqual(store.get(states["failed"])["error"], "old")
            self.assertEqual((store.job_dir(broken) / "status.json").read_text(), "{not json")   # left alone
            self.assertEqual(JobStore(tmp / "jobs").recover_interrupted(), [])                   # idempotent
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class JobRunnerTests(unittest.TestCase):
    def test_video_without_audio_fails_with_actionable_message(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            store = JobStore(tmp / "jobs")
            jid = store.create(Preferences())
            src = store.job_dir(jid) / "source.mp4"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2",
                            "-pix_fmt", "yuv420p", str(src)], check=True)
            store.update(jid, status="queued")
            runner = JobRunner(store, Settings(data_dir=tmp), HeuristicPlanner(), transcribe_fn=lambda _: [])
            runner.submit(jid).result(timeout=60)
            job = store.get(jid)
            self.assertEqual(job["status"], "failed")
            self.assertIn("no audio", job["error"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _run_one(self, **settings):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        store = JobStore(tmp / "jobs")
        jid = store.create(Preferences())
        src = store.job_dir(jid) / "source.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2",
                        "-f", "lavfi", "-i", "sine=duration=2", "-pix_fmt", "yuv420p", "-shortest", str(src)], check=True)
        store.update(jid, status="queued")
        words = [Word(t, 0.2 + i * 0.25, 0.2 + i * 0.25 + 0.2) for i, t in enumerate("det här är en kort men giltig mening".split())]
        JobRunner(store, Settings(data_dir=tmp, x264_preset="ultrafast", **settings), HeuristicPlanner(),
                  transcribe_fn=lambda _: words).submit(jid).result(timeout=90)
        return store, jid, src

    def test_source_is_kept_by_default(self):
        store, jid, src = self._run_one()
        self.assertEqual(store.get(jid)["status"], "done", store.get(jid))
        self.assertTrue(src.exists())

    def test_source_is_deleted_after_success_when_asked(self):
        store, jid, src = self._run_one(delete_source_after=True)
        job = store.get(jid)
        self.assertEqual(job["status"], "done", job)
        self.assertFalse(src.exists())
        self.assertIn("main.mp4", job["outputs"])

    def test_env_flag_parses(self):
        self.assertTrue(Settings.from_env({"CLIPSMITH_DELETE_SOURCE_AFTER": "1"}).delete_source_after)
        self.assertFalse(Settings.from_env({}).delete_source_after)


if __name__ == "__main__":
    unittest.main()
