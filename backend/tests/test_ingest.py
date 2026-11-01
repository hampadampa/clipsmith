"""Files produced by a browser MediaRecorder (the desktop app) must be accepted like any other."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from clipsmith.config import Settings
from clipsmith.models import Preferences
from clipsmith.pipeline import media
from clipsmith.pipeline.planner import HeuristicPlanner
from clipsmith.pipeline.run import run_pipeline
from clipsmith.pipeline.units import Word

FIXTURE = Path(__file__).parent / "fixtures" / "mediarecorder_chromium_vp9_opus.webm"
HAVE_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")


def container_duration(path: Path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True).stdout
    return json.loads(out).get("format", {}).get("duration")


def make_unseekable_webm(path: Path, seconds: int = 3) -> None:
    """Writing to a pipe makes the muxer unable to go back and write the duration: like a live encoder."""
    with path.open("wb") as f:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size=640x360:rate=15:duration={seconds}",
                        "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}", "-c:v", "libvpx", "-b:v", "500k",
                        "-c:a", "libopus", "-f", "webm", "pipe:1"], stdout=f, check=True)


def fake_words(_wav):
    """Two DIFFERENT sentences (identical ones would be treated as a retake and the first one cut)."""
    words = []
    for start, text in ((0.5, "Nu visar jag hur man byter bromsklossar på bilen"), (3.2, "Sedan drar vi åt bultarna med rätt moment")):
        for k, t in enumerate(text.split()):
            words.append(Word(t, start + k * 0.2, start + k * 0.2 + 0.17))
    return words


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class MediaRecorderIngest(unittest.TestCase):
    def test_probe_recovers_duration_when_the_container_has_none(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            src = tmp / "live.webm"
            make_unseekable_webm(src, seconds=3)
            self.assertIsNone(container_duration(src), "precondition: the file really has no duration header")
            info = media.probe(src)
            self.assertAlmostEqual(info.duration, 3.0, delta=0.25)
            self.assertTrue(info.has_audio)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_real_chromium_recording_has_no_duration_but_probe_finds_it(self):
        self.assertIsNone(container_duration(FIXTURE), "precondition: real MediaRecorder output has no duration")
        info = media.probe(FIXTURE)
        self.assertAlmostEqual(info.duration, 6.0, delta=0.25)
        self.assertEqual((info.width, info.height), (1280, 720))

    def test_probe_still_trusts_the_header_when_there_is_one(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            src = tmp / "normal.mp4"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2",
                            "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-pix_fmt", "yuv420p", str(src)], check=True)
            self.assertAlmostEqual(media.probe(src).duration, 2.0, delta=0.2)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_pipeline_edits_a_real_chromium_recording(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            manifest = run_pipeline(FIXTURE, tmp / "out", Preferences(source_type="screen", pace="balanced", num_shorts=1),
                                    Settings(x264_preset="ultrafast"), HeuristicPlanner(), transcribe_fn=fake_words)
            main = media.probe(tmp / "out" / "main.mp4")
            self.assertEqual(manifest["main"]["dropped_units"], 0)
            self.assertGreater(main.duration, 3.0)       # ~3.4 s of speech + padding, the 0.9 s pause shortened
            self.assertLess(main.duration, 6.3)
            self.assertTrue(main.has_audio)
            self.assertEqual(manifest["source"]["duration"], round(media.probe(FIXTURE).duration, 2))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
