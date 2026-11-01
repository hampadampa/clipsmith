import importlib.util
import unittest
from pathlib import Path

from clipsmith import models
from clipsmith.pipeline.prompts import LANGUAGE_NAMES

ROOT = Path(__file__).resolve().parents[2]


def load_generator():
    spec = importlib.util.spec_from_file_location("gen_contract", ROOT / "scripts" / "gen_contract.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ContractTests(unittest.TestCase):
    def test_generated_files_are_up_to_date(self):
        gen = load_generator()
        for path, expected in gen.expected_files().items():
            self.assertTrue(path.exists(), f"{path} missing: run scripts/gen_contract.py")
            self.assertEqual(path.read_text(), expected, f"{path.name} is stale: run scripts/gen_contract.py")

    def test_defaults_are_valid_preferences(self):
        d = load_generator().build_contract()["defaults"]
        self.assertEqual(models.Preferences.from_dict(d).to_dict(), d)

    def test_every_offered_language_has_a_prompt_name(self):
        self.assertEqual(set(models.LANGUAGES), set(LANGUAGE_NAMES))

    def test_limits_are_enforced_by_the_model(self):
        lo, hi = models.TARGET_MINUTES_RANGE
        models.Preferences(target_minutes=lo)
        models.Preferences(target_minutes=hi)
        with self.assertRaises(ValueError):
            models.Preferences(target_minutes=hi + 1)
        with self.assertRaises(ValueError):
            models.Preferences(niche_notes="x" * (models.NOTES_MAX_CHARS + 1))


if __name__ == "__main__":
    unittest.main()
