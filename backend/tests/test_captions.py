import unittest

from clipsmith.pipeline.captions import build_ass, build_srt, group_words, _ass_time
from clipsmith.pipeline.units import Word


def ws(*items):
    return [Word(t, s, e) for t, s, e in items]


class CaptionTests(unittest.TestCase):
    words = ws(("Nu", 0.0, 0.3), ("byter", 0.35, 0.7), ("vi", 0.75, 0.9), ("bromsarna.", 0.95, 1.6),
               ("Sen", 2.5, 2.8), ("drar", 2.85, 3.2), ("vi", 3.25, 3.4), ("åt.", 3.45, 3.8))

    def test_ass_time_format(self):
        self.assertEqual(_ass_time(3725.456), "1:02:05.46")
        self.assertEqual(_ass_time(0), "0:00:00.00")

    def test_groups_break_on_sentence_end_and_size(self):
        groups = group_words(self.words, max_words=3, max_chars=20)
        self.assertTrue(all(len(g) <= 3 for g in groups))
        self.assertEqual(sum(len(g) for g in groups), len(self.words))
        self.assertEqual(groups[1][-1].text, "bromsarna.")

    def test_pop_style_highlights_each_word(self):
        ass = build_ass(self.words, "pop")
        events = [l for l in ass.splitlines() if l.startswith("Dialogue")]
        self.assertEqual(len(events), len(self.words))          # one event per word
        self.assertIn("\\c&H00D7FF&", events[0])
        self.assertIn("NU", events[0])                          # uppercase style

    def test_karaoke_uses_k_tags(self):
        ass = build_ass(self.words, "karaoke")
        self.assertIn("{\\k", ass)

    def test_none_disables(self):
        self.assertIsNone(build_ass(self.words, "none"))
        self.assertIsNone(build_ass([], "pop"))

    def test_override_braces_are_escaped(self):
        ass = build_ass(ws(("{\\an8}hej", 0.0, 0.5)), "minimal")
        self.assertNotIn("{\\an8}", ass.split("[Events]")[1])

    def test_srt(self):
        srt = build_srt(self.words)
        self.assertTrue(srt.startswith("1\n00:00:00,000 --> "))


if __name__ == "__main__":
    unittest.main()
