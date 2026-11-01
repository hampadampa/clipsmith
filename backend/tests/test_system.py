import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from clipsmith import system

SRC = str(Path(__file__).resolve().parents[1] / "src")

FILTERS = """Filters:
  T.. = Timeline support
 ... assrender         V->V       Render ASS (fake)
 ... ass               V->V       Render ASS subtitles onto input video using the libass library.
 ... subtitles         V->V       Render text subtitles onto input video using the libass library.
"""
ENCODERS = " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC\n"


def fake_run(filters=FILTERS, encoders=ENCODERS):
    def run(cmd):
        if "-filters" in cmd:
            return filters
        if "-encoders" in cmd:
            return encoders
        return "ffmpeg version 7.1 Copyright (c) 2000-2024\nbuilt with gcc\n"
    return run


ALL_MODULES = {"fastapi", "uvicorn", "python_multipart", "faster_whisper", "anthropic"}


def by_id(checks):
    return {c.id: c for c in checks}


class SystemCheckTests(unittest.TestCase):
    def run_checks(self, *, which=lambda n: f"/bin/{n}", run=None, modules=ALL_MODULES, version=(3, 12)):
        return by_id(system.run_checks(which=which, run=run or fake_run(), find_spec=lambda m: object() if m in modules else None,
                                       python_version=version))

    def test_everything_present(self):
        c = self.run_checks()
        self.assertTrue(system.summarize(c.values())["ok"])
        self.assertTrue(all(x.ok for x in c.values()))

    def test_ass_filter_must_be_the_real_name_not_a_prefix(self):
        only_assrender = "Filters:\n ... assrender         V->V       Render ASS (fake)\n ... subtitles V->V x\n"
        c = self.run_checks(run=fake_run(filters=only_assrender))
        self.assertFalse(c["libass"].ok)
        self.assertFalse(system.summarize(c.values())["ok"])

    def test_missing_x264(self):
        self.assertFalse(self.run_checks(run=fake_run(encoders=" V....D libx265 x\n"))["libx264"].ok)

    def test_no_ffmpeg_marks_dependent_checks_failed(self):
        c = self.run_checks(which=lambda n: None)
        self.assertFalse(c["ffmpeg"].ok)
        self.assertFalse(c["libass"].ok)
        self.assertFalse(c["ffprobe"].ok)

    def test_old_python(self):
        self.assertFalse(self.run_checks(version=(3, 10))["python"].ok)

    def test_anthropic_is_optional(self):
        c = self.run_checks(modules=ALL_MODULES - {"anthropic"})
        self.assertFalse(c["anthropic"].ok)
        self.assertTrue(system.summarize(c.values())["ok"])

    def test_missing_required_package_fails_the_summary(self):
        c = self.run_checks(modules=ALL_MODULES - {"faster_whisper"})
        self.assertFalse(c["faster_whisper"].ok)
        self.assertFalse(system.summarize(c.values())["ok"])

    def test_multipart_accepts_either_module_name(self):
        c = self.run_checks(modules=(ALL_MODULES - {"python_multipart"}) | {"multipart"})
        self.assertTrue(c["multipart"].ok)

    def test_cli_prints_one_json_document(self):
        done = subprocess.run([sys.executable, "-m", "clipsmith.system"], capture_output=True, text=True,
                              env={**os.environ, "PYTHONPATH": SRC})
        report = json.loads(done.stdout)
        self.assertEqual(set(report), {"ok", "checks"})
        self.assertEqual(done.returncode, 0 if report["ok"] else 1)
        self.assertIn("python", {c["id"] for c in report["checks"]})

    @unittest.skipUnless(system.shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_real_ffmpeg_in_this_environment(self):
        c = by_id(system.run_checks())
        self.assertTrue(c["ffmpeg"].ok and c["libass"].ok and c["libx264"].ok, [x for x in c.values() if not x.ok])


if __name__ == "__main__":
    unittest.main()
