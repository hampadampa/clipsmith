"""Real ffmpeg, synthetic media. Skipped automatically when ffmpeg is missing."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from clipsmith.pipeline import media, render
from clipsmith.pipeline.captions import build_ass
from clipsmith.pipeline.timeline import PACE, Timeline, build_ranges
from clipsmith.pipeline.units import Word, build_units

HAVE_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")


def make_source(path: Path, w=1280, h=720):
    # 24 s: tone for 2.5 s, silence 3.5 s, repeating every 6 s => 3 long pauses
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size={w}x{h}:rate=30:duration=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=24",
        "-af", "volume='if(lt(mod(t,6),2.5),0.8,0)':eval=frame",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)


def fake_words():
    """Three 'sentences' of 4 words, each inside a tone burst (0-2.5, 6-8.5, 12-14.5, 18-20.5)."""
    words = []
    for base in (0.0, 6.0, 12.0, 18.0):
        for k, t in enumerate(("Nu", "gör", "vi", "detta.")):
            words.append(Word(t, base + 0.1 + k * 0.55, base + 0.1 + k * 0.55 + 0.45))
    return words


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class RenderIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.src = cls.tmp / "src.mp4"
        make_source(cls.src)
        cls.info = media.probe(cls.src)
        cls.wav = cls.tmp / "a.wav"
        media.extract_audio(cls.src, cls.wav)
        cls.silences = media.detect_silences(cls.wav)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_probe(self):
        self.assertEqual((self.info.width, self.info.height), (1280, 720))
        self.assertTrue(self.info.has_audio)
        self.assertAlmostEqual(self.info.duration, 24.0, delta=0.3)

    def test_silence_detection_finds_the_gaps(self):
        self.assertGreaterEqual(len(self.silences), 3)
        self.assertTrue(any(2.4 <= a <= 2.7 and 5.8 <= b <= 6.1 for a, b in self.silences), self.silences)

    def test_main_render_shortens_pauses(self):
        words = fake_words()
        units = build_units(words)
        ranges = build_ranges(units, set(), PACE["fast"], media_duration=self.info.duration, silences=self.silences)
        tl = Timeline(ranges)
        out = render.render(self.src, ranges, self.tmp / "main.mp4", info=self.info, preset="ultrafast")
        got = media.probe(out)
        self.assertAlmostEqual(got.duration, tl.duration, delta=0.5)
        self.assertLess(got.duration, 16.0)          # source is 24 s, pauses removed
        self.assertTrue(got.has_audio)

    def test_vertical_render_with_captions_from_landscape_camera_and_screen(self):
        words = fake_words()[:8]
        units = build_units(words)
        ranges = build_ranges(units, set(), PACE["fast"], media_duration=self.info.duration, silences=self.silences)
        tl = Timeline(ranges)
        ass = build_ass(tl.remap_words(words), "pop", font="DejaVu Sans")
        ass_path = self.tmp / "c.ass"
        ass_path.write_text(ass, encoding="utf-8")
        for st in ("camera", "screen"):
            out = render.render(self.src, ranges, self.tmp / f"v_{st}.mp4", info=self.info, preset="ultrafast",
                                vertical=True, source_type=st, ass_path=ass_path)
            got = media.probe(out)
            self.assertEqual((got.width, got.height), (1080, 1920), st)
            self.assertAlmostEqual(got.duration, tl.duration, delta=0.5)

    def test_filter_graph_has_one_trim_per_range(self):
        from clipsmith.pipeline.timeline import Range
        g = render.build_filter_graph([Range(0, 1), Range(2, 3), Range(4, 5)], has_audio=True, fps=30,
                                      video_post="[vcat]null[vout]")
        self.assertEqual(g.count("trim=start"), 6)   # 3 video + 3 audio (atrim also contains 'trim=start')
        self.assertIn("concat=n=3:v=1:a=1", g)


if __name__ == "__main__":
    unittest.main()
