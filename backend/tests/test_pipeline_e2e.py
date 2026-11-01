"""Whole pipeline: synthetic 100 s video, fake transcript, scripted 'LLM', real ffmpeg."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from clipsmith.config import Settings
from clipsmith.models import Preferences
from clipsmith.pipeline import media
from clipsmith.pipeline.planner import LLMPlanner
from clipsmith.pipeline.run import run_pipeline
from clipsmith.pipeline.units import Word

HAVE_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
BURSTS = 16          # one 4 s sentence every 6 s


def make_source(path: Path):
    dur = BURSTS * 6
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size=1280x720:rate=30:duration={dur}",
        "-f", "lavfi", "-i", f"sine=frequency=330:sample_rate=48000:duration={dur}",
        "-af", "volume='if(lt(mod(t,6),4),0.8,0)':eval=frame",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)


def fake_transcript(_wav):
    words = []
    for b in range(BURSTS):
        text = "Nu gör vi detta steg för steg." if b in (2, 3) else f"Del nummer {b} handlar om bromsar och mer."
        toks = text.split()
        for k, tok in enumerate(toks):
            t0 = b * 6 + 0.1 + k * (3.6 / len(toks))
            words.append(Word(tok, t0, t0 + 3.6 / len(toks) * 0.85))
    return words


class ScriptedLLM:
    def __init__(self):
        self.calls = []

    def call_tool(self, **kw):
        self.calls.append(kw["tool_name"])
        if kw["tool_name"] == "submit_edit_plan":
            # unit 2 is the weaker take of the retake pair (units 2 & 3 say the same thing)
            return {"storyline": "Bromsbyte steg för steg",
                    "cuts": [{"from_id": 2, "to_id": 2, "reason": "retake", "confidence": 0.9}] if len(self.calls) == 1 else []}
        return {"shorts": [
            {"start_id": 4, "end_id": 10, "hook_title": "Så gör du", "score": 88, "reason": "tydlig lösning"},
            {"start_id": 11, "end_id": 13, "hook_title": "Fel", "score": 40, "reason": "för kort"},   # ~16 s raw -> discarded
        ]}


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class PipelineE2E(unittest.TestCase):
    def test_full_run(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            src = tmp / "raw.mp4"
            make_source(src)
            llm = ScriptedLLM()
            stages = []
            manifest = run_pipeline(
                src, tmp / "out", Preferences(niche="garage", pace="fast", caption_style="pop", target_minutes=1.0, num_shorts=3),
                Settings(x264_preset="ultrafast", caption_font="DejaVu Sans"), LLMPlanner(llm),
                progress=lambda s, f: stages.append(s), transcribe_fn=fake_transcript)

            out = tmp / "out"
            main = media.probe(out / "main.mp4")
            self.assertLess(main.duration, 100 * 0.75)                       # pauses + retake removed
            self.assertAlmostEqual(main.duration, manifest["main"]["duration"], delta=0.8)
            self.assertEqual(manifest["storyline"], "Bromsbyte steg för steg")
            self.assertEqual(manifest["main"]["dropped_units"], 1)

            self.assertEqual(len(manifest["shorts"]), 1)                     # the too-short candidate was rejected
            short = media.probe(out / manifest["shorts"][0]["file"])
            self.assertEqual((short.width, short.height), (1080, 1920))
            self.assertTrue(20 < short.duration < 45, short.duration)
            self.assertTrue((out / "main.srt").read_text().startswith("1\n"))
            self.assertIn("#", (out / "work" / "short_1.ass").read_text() + "#")   # ASS written
            self.assertEqual(stages[0], "analysing")
            self.assertEqual(stages[-1], "done")
            json.loads((out / "manifest.json").read_text())                  # valid JSON on disk
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
