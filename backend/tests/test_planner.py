import unittest

from clipsmith.models import Preferences
from clipsmith.pipeline import planner as pl
from clipsmith.pipeline.units import Word, Unit, annotate_repeats, build_units
from tests.helpers import sentence


def mk_units(n=12, secs=5.0):
    """n units of `secs` seconds each, 1 s gaps."""
    units, t = [], 0.0
    for i in range(n):
        words = [Word(f"ord{i}_{k}", t + k * (secs / 6), t + k * (secs / 6) + secs / 7) for k in range(6)]
        units.append(Unit(id=i, words=words))
        t += secs + 1.0
    return units


class ParseMainPlanTests(unittest.TestCase):
    def setUp(self):
        self.units = mk_units()

    def test_garbage_is_ignored_not_fatal(self):
        raw = {"storyline": "x", "cuts": ["nope", {"from_id": "a"}, {"from_id": 99, "to_id": 120, "reason": "retake", "confidence": 1},
                                           {"from_id": 2, "to_id": 3, "reason": "weird", "confidence": 7}]}
        plan = pl.parse_main_plan(raw, self.units)
        self.assertEqual(len(plan.cuts), 1)                 # only the one that touches real units
        self.assertEqual(plan.cuts[0].reason, "low_value")  # unknown reason normalised
        self.assertEqual(plan.cuts[0].confidence, 1.0)      # clamped
        self.assertEqual(pl.parse_main_plan(None, self.units).cuts, [])

    def test_reversed_range_is_fixed(self):
        plan = pl.parse_main_plan({"cuts": [{"from_id": 5, "to_id": 3, "reason": "retake", "confidence": 0.9}]}, self.units)
        self.assertEqual((plan.cuts[0].from_id, plan.cuts[0].to_id), (3, 5))

    def test_overeager_cutting_reverts_least_confident_first(self):
        raw = {"cuts": [
            {"from_id": 0, "to_id": 5, "reason": "low_value", "confidence": 0.5},   # 50 % of speech
            {"from_id": 6, "to_id": 10, "reason": "retake", "confidence": 0.95},    # ~42 %
        ]}
        plan = pl.parse_main_plan(raw, self.units)
        self.assertEqual([(c.from_id, c.to_id) for c in plan.cuts], [(6, 10)])      # low-confidence one reverted

    def test_expand_only_touches_existing_units(self):
        remaining = [u for u in self.units if u.id not in {3, 4}]
        cut = pl.Cut(2, 5, "retake", 0.9)
        self.assertEqual(pl.expand_cuts([cut], remaining), {2, 5})


class ParseShortsTests(unittest.TestCase):
    def setUp(self):
        self.units = mk_units(n=30)   # 6 s per unit => ~30 s for 5 units

    def test_bounds_and_validation(self):
        raw = {"shorts": [
            {"start_id": 0, "end_id": 1, "score": 90},        # ~11 s: too short
            {"start_id": 0, "end_id": 5, "score": 80, "hook_title": "Bra"},   # ~35 s ok
            {"start_id": 2, "end_id": 99, "score": 70},       # unknown id
            {"start_id": 10, "end_id": 29, "score": 70},      # ~115 s: too long
            {"start_id": 8, "end_id": 8, "score": 70},        # single unit
        ]}
        out = pl.parse_shorts(raw, self.units)
        self.assertEqual([(s.start_id, s.end_id) for s in out], [(0, 5)])

    def test_drop_ids_only_inside_range(self):
        raw = {"shorts": [{"start_id": 0, "end_id": 7, "drop_ids": [0, 3, 7, 50, "x"], "score": 60}]}
        out = pl.parse_shorts(raw, self.units)
        self.assertEqual(out[0].drop_ids, frozenset({3}))

    def test_select_is_non_overlapping_best_first(self):
        c = [pl.ShortPlan(0, 6, frozenset(), "a", 70, ""), pl.ShortPlan(4, 10, frozenset(), "b", 95, ""),
             pl.ShortPlan(12, 18, frozenset(), "c", 60, ""), pl.ShortPlan(20, 26, frozenset(), "d", 50, "")]
        chosen = pl.select_shorts(c, 3)
        self.assertEqual([s.hook_title for s in chosen], ["b", "c", "d"])   # 'a' overlaps higher-scored 'b'


class TranscriptFormatTests(unittest.TestCase):
    def test_format_includes_ids_times_pause_and_retake_hint(self):
        w1, e1 = sentence("Nu byter vi bromsklossarna på framhjulet.", 0.0)
        w2, e2 = sentence("Nu byter vi bromsklossarna på framhjulet.", e1 + 4.0)
        units = build_units(w1 + w2, split_gap_s=0.8)
        annotate_repeats(units)
        text = pl.format_transcript(units)
        self.assertIn("#0 [00:00-", text)
        self.assertIn("(paus 4.0s)", text)
        self.assertIn("(liknar #0)", text)


class FakeLLM:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def call_tool(self, **kw):
        self.calls.append(kw)
        return self.responses.pop(0)


class LLMPlannerTests(unittest.TestCase):
    def test_main_plan_roundtrip_and_prompt_contents(self):
        units = mk_units()
        llm = FakeLLM([{"storyline": "Byte av bromsar", "cuts": [{"from_id": 2, "to_id": 3, "reason": "retake", "confidence": 0.9}]}])
        prefs = Preferences(niche="garage", pace="fast", niche_notes="bil-el, scheman")
        plan = pl.LLMPlanner(llm).plan_main_cuts(units, prefs, current_seconds=60, target_seconds=30)
        self.assertEqual(plan.storyline, "Byte av bromsar")
        self.assertEqual(pl.expand_cuts(plan.cuts, units), {2, 3})
        call = llm.calls[0]
        self.assertIn("Mechanics", call["system"])           # niche guidance injected
        self.assertIn("aggressive", call["system"])          # pace guidance injected
        self.assertIn("bil-el, scheman", call["system"])     # creator notes injected
        self.assertIn("Remove roughly", call["user"])        # over target => asks for extra cuts
        self.assertIn("#0 [", call["user"])

    def test_long_transcripts_are_chunked_with_shared_storyline(self):
        units = mk_units(n=40)
        small = lambda: [{"storyline": "S1", "cuts": []}, {"storyline": "ignored", "cuts": []}]
        llm = FakeLLM(small() * 20)
        plan = pl.LLMPlanner(llm, max_chars=600).plan_main_cuts(
            units, Preferences(), current_seconds=240, target_seconds=120)
        self.assertGreater(len(llm.calls), 1)
        self.assertIn("Red thread established so far: S1", llm.calls[1]["user"])
        self.assertEqual(plan.storyline, "S1")


class HeuristicTests(unittest.TestCase):
    def test_drops_earlier_take_of_a_retake(self):
        units = mk_units(4)
        units[2].repeat_of, units[2].repeat_similarity = 1, 0.9
        plan = pl.HeuristicPlanner().plan_main_cuts(units, Preferences(), current_seconds=1, target_seconds=1)
        self.assertEqual(pl.expand_cuts(plan.cuts, units), {1})

    def test_shorts_are_valid_and_non_overlapping(self):
        units = mk_units(n=40, secs=5)
        shorts = pl.HeuristicPlanner().plan_shorts(units, Preferences(num_shorts=3))
        self.assertTrue(1 <= len(shorts) <= 3)
        for a, b in zip(sorted(shorts, key=lambda s: s.start_id), sorted(shorts, key=lambda s: s.start_id)[1:]):
            self.assertLess(a.end_id, b.start_id)


class PreferencesTests(unittest.TestCase):
    def test_validation(self):
        with self.assertRaises(ValueError):
            Preferences(pace="turbo")
        with self.assertRaises(ValueError):
            Preferences(num_shorts=0)
        p = Preferences.from_dict({"niche": "garage", "unknown_future_field": 1})
        self.assertEqual(p.niche, "garage")


if __name__ == "__main__":
    unittest.main()
