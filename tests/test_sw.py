"""Kontroll att allt som sidorna laddar från den egna webbplatsen finns i service workerns offline-lista.

Annars fungerar sidan inte utan täckning efter en uppdatering där ett versionsnummer ändrats.
"""
import os
import re
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


def local_refs(html):
    refs = re.findall(r'(?:href|src)="([^"]+)"', html)
    return {r for r in refs if not r.startswith(("http:", "https:", "#", "mailto:"))}


class TestServiceWorker(unittest.TestCase):
    def setUp(self):
        sw = read("sw.js")
        block = sw[sw.index("const PRECACHE = ["):sw.index("];", sw.index("const PRECACHE = ["))]
        self.precache = set(re.findall(r"'([^']+)'", block))

    def test_pages_assets_are_precached(self):
        for page in ("index.html", "method.html"):
            missing = local_refs(read(page)) - self.precache
            self.assertEqual(missing, set(), f"{page} laddar filer som saknas i sw.js PRECACHE")

    def test_data_files_are_precached(self):
        for name in ("data/profiles.json", "data/calibration.json", "data/validation.json"):
            self.assertIn(name, self.precache)

    def test_precached_files_exist(self):
        for ref in self.precache - {"./"}:
            self.assertTrue(os.path.exists(os.path.join(ROOT, ref.split("?")[0])), ref)


if __name__ == "__main__":
    unittest.main()
