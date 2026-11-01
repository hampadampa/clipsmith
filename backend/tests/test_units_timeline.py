import unittest

from clipsmith.pipeline.timeline import (PACE, Range, Timeline, build_ranges, merge_ranges,
                                         resolve_pace, snap_to_silence)
from clipsmith.pipeline.units import Word, annotate_repeats, build_units
from tests.helpers import sentence


def make_units(*parts):
    """parts: (text, start). Returns all words and units."""
    words = []
    for text, start in parts:
        w, _ = sentence(text, start)
        words += w
    return words, build_units(words)


class UnitsTests(unittest.TestCase):
    def test_splits_on_sentence_end_and_gap(self):
        words, units = make_units(
            ("Nu tar vi bort bulten. Sen vänder vi på den", 0.0),   # sentence end splits
            ("Efter en lång paus kommer mer", 8.0),                  # gap splits
        )
        self.assertGreaterEqual(len(units), 3)
        self.assertEqual([u.id for u in units], list(range(len(units))))
        self.assertEqual(sum(len(u.words) for u in units), len(words))

    def test_retake_is_flagged(self):
        _, units = make_units(
            ("Nu ska vi byta bromsklossarna på framhjulet.", 0.0),
            ("Äh nej, vänta. Okej.", 5.0),
            ("Nu ska vi byta bromsklossarna på framhjulet här.", 9.0),
            ("Först lossar vi hjulet.", 14.0),
        )
        annotate_repeats(units)
        flagged = {u.id: u.repeat_of for u in units if u.repeat_of is not None}
        retake = next(u for u in units if "framhjulet här" in u.text)
        self.assertIn(retake.id, flagged)
        self.assertEqual(units[flagged[retake.id]].text.startswith("Nu ska vi byta"), True)
        self.assertNotIn(units[-1].id, flagged)  # unrelated sentence stays unflagged


class SnapTests(unittest.TestCase):
    def test_snaps_into_silence_within_window(self):
        sil = [(2.0, 3.0)]
        self.assertAlmostEqual(snap_to_silence(1.9, sil, lo=1.7, hi=2.2), 2.03)

    def test_never_leaves_allowed_window(self):
        sil = [(2.0, 3.0)]
        # silence exists but only outside [lo, hi]: leave t alone
        self.assertEqual(snap_to_silence(1.0, sil, lo=0.8, hi=1.2), 1.0)

    def test_inside_silence_is_untouched(self):
        self.assertEqual(snap_to_silence(2.5, [(2.0, 3.0)], lo=2.0, hi=3.0), 2.5)


class RangesTests(unittest.TestCase):
    def test_long_pause_is_shortened_to_keep_pause(self):
        w1, _ = sentence("det här är första delen", 0.0)
        w2, _ = sentence("och det här är andra delen", 6.0)    # ~5 s pause
        units = build_units(w1 + w2, split_gap_s=0.8)
        pace = PACE["balanced"]
        ranges = build_ranges(units, set(), pace, media_duration=20)
        self.assertEqual(len(ranges), 2)
        # silence that SURVIVES around the cut = tail of range 0 + lead-in of range 1
        kept_silence = (ranges[0].end - w1[-1].end) + (w2[0].start - ranges[1].start)
        self.assertAlmostEqual(kept_silence, pace.keep_pause, delta=0.02)
        removed = ranges[1].start - ranges[0].end
        self.assertGreater(removed, 4.0)          # the ~4.4 s pause is mostly gone

    def test_short_pause_is_left_alone(self):
        w1, e1 = sentence("kort paus här", 0.0)
        w2, _ = sentence("och sen mer", e1 + 0.3)
        units = build_units(w1 + w2)
        ranges = build_ranges(units, set(), PACE["balanced"], media_duration=20)
        self.assertEqual(len(ranges), 1)

    def test_dropped_unit_creates_hard_cut(self):
        _, units = make_units(
            ("Det här behåller vi.", 0.0),
            ("Det här är ett misslyckat försök.", 3.0),
            ("Det här behåller vi också.", 6.0),
        )
        dropped = {units[1].id}
        ranges = build_ranges(units, dropped, PACE["balanced"], media_duration=20)
        self.assertEqual(len(ranges), 2)
        self.assertLessEqual(ranges[0].end, units[1].start + 0.01)
        self.assertGreaterEqual(ranges[1].start, units[1].end - 0.01)

    def test_subset_of_units_forces_cut_even_without_dropped_ids(self):
        _, units = make_units(("Ett.", 0.0), ("Två.", 2.0), ("Tre.", 4.0))
        ranges = build_ranges([units[0], units[2]], set(), PACE["balanced"], media_duration=20)
        self.assertEqual(len(ranges), 2)

    def test_fillers_removed_only_when_enabled(self):
        words = [Word("Nu", 0.0, 0.3), Word("öhm", 0.4, 0.9), Word("tar", 1.0, 1.3), Word("vi", 1.35, 1.6)]
        units = build_units(words)
        fast = build_ranges(units, set(), resolve_pace("fast"), media_duration=10)
        calm = build_ranges(units, set(), resolve_pace("calm"), media_duration=10)
        self.assertEqual(len(fast), 2)   # filler cut out => split
        self.assertEqual(len(calm), 1)   # calm keeps it

    def test_cut_snaps_into_detected_silence(self):
        w1, _ = sentence("första delen", 0.0)                # ends ~0.67 s
        w2, _ = sentence("andra delen kommer senare", 5.0)
        units = build_units(w1 + w2)
        sil = [(0.8, 4.9)]
        ranges = build_ranges(units, set(), PACE["balanced"], media_duration=20, silences=sil)
        # both cut points must sit inside the silence (never inside speech)
        self.assertTrue(0.8 <= ranges[0].end <= 4.9, ranges[0])
        self.assertTrue(0.8 <= ranges[1].start <= 4.9, ranges[1])

    def test_ranges_sorted_non_overlapping_and_clamped(self):
        _, units = make_units(("A b c d e f.", 0.0), ("G h i j k l.", 9.0), ("M n o p q r.", 20.0))
        ranges = build_ranges(units, set(), PACE["fast"], media_duration=24.0)
        for a, b in zip(ranges, ranges[1:]):
            self.assertLess(a.end, b.start)
        self.assertGreaterEqual(ranges[0].start, 0.0)
        self.assertLessEqual(ranges[-1].end, 24.0)

    def test_merge_ranges(self):
        merged = merge_ranges([Range(0, 1), Range(1.02, 2), Range(3, 4)])
        self.assertEqual(merged, [Range(0, 2), Range(3, 4)])


class TimelineTests(unittest.TestCase):
    def test_source_to_output_mapping(self):
        tl = Timeline([Range(2.0, 4.0), Range(10.0, 13.0)])
        self.assertEqual(tl.duration, 5.0)
        self.assertEqual(tl.to_output(2.5), 0.5)
        self.assertEqual(tl.to_output(11.0), 3.0)
        self.assertIsNone(tl.to_output(6.0))     # cut away
        self.assertIsNone(tl.to_output(1.0))     # before first range

    def test_remap_words_drops_cut_words_and_retimes(self):
        tl = Timeline([Range(2.0, 4.0), Range(10.0, 13.0)])
        words = [Word("a", 2.2, 2.6), Word("b", 6.0, 6.5), Word("c", 10.5, 11.0)]
        out = tl.remap_words(words)
        self.assertEqual([w.text for w in out], ["a", "c"])
        self.assertAlmostEqual(out[0].start, 0.2)
        self.assertAlmostEqual(out[1].start, 2.5)


if __name__ == "__main__":
    unittest.main()
