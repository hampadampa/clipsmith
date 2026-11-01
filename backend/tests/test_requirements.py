import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?\s*(>=|==|~=|<=|<|>)\s*[0-9][A-Za-z0-9.*+!_-]*(\s*,\s*(>=|==|~=|<=|<|>|!=)\s*[0-9][A-Za-z0-9.*+!_-]*)*$")


def requirement_lines():
    out = []
    for raw in (ROOT / "requirements.txt").read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            out.append(line)
    return out


class RequirementsTests(unittest.TestCase):
    def test_pyproject_reads_requirements_txt_and_has_no_second_list(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        self.assertEqual(project["project"]["dynamic"], ["dependencies"])
        self.assertNotIn("dependencies", project["project"])
        self.assertEqual(project["tool"]["setuptools"]["dynamic"]["dependencies"], {"file": ["requirements.txt"]})

    def test_every_line_is_a_plain_pinned_requirement(self):
        lines = requirement_lines()
        self.assertTrue(lines)
        for line in lines:
            self.assertRegex(line, LINE, f"setuptools/pip cannot rely on: {line!r}")

    def test_the_packages_the_engine_imports_are_listed(self):
        names = {re.split(r"[\[<>=~! ]", l, maxsplit=1)[0].lower().replace("_", "-") for l in requirement_lines()}
        self.assertTrue({"fastapi", "uvicorn", "python-multipart", "faster-whisper", "anthropic"} <= names)


if __name__ == "__main__":
    unittest.main()
