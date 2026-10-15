"""Test av stryklängdsberäkningen med en påhittad vik där svaren går att räkna ut för hand.

Viken är 1000 m bred (x = 0..1000) och 2000 m djup (y = 0..2000), öppen mot söder.
Båten ligger i (400, 500). Kustsegmenten är riktade med land till vänster, som i OSM.
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from fetchcalc import CoastIndex, effective_fetch, fetch_profile  # noqa: E402

MAX = 20000.0
# Kusten följs med land till vänster: österut längs y=-3000, norrut längs västra stranden x=0,
# österut längs innersta stranden y=2000, söderut längs östra stranden x=1000 och sedan österut
# igen längs y=-3000. Viken är alltså 5 km lång med mynning mot söder vid y=-3000.
COAST = [
    (-5000, -3000), (0, -3000), (0, 2000), (1000, 2000), (1000, -3000), (6000, -3000),
]
SEGMENTS = [(COAST[i], COAST[i + 1]) for i in range(len(COAST) - 1)]
BOAT = (400.0, 500.0)


class TestFetch(unittest.TestCase):
    def setUp(self):
        self.index = CoastIndex(SEGMENTS, cell=250.0)
        self.profile = fetch_profile(self.index, BOAT, step_deg=10, max_dist=MAX, effective=False)

    def test_axis_directions(self):
        self.assertAlmostEqual(self.profile[0], 1500.0, places=3)   # N: till y=2000
        self.assertAlmostEqual(self.profile[9], 600.0, places=3)    # O: till x=1000
        self.assertAlmostEqual(self.profile[27], 400.0, places=3)   # V: till x=0
        self.assertEqual(self.profile[18], MAX)                     # S: öppet ut ur viken

    def test_diagonal(self):
        # NO (40°, närmaste 10°-steg till 45°): östra stranden nås vid 600 / sin 40°.
        self.assertAlmostEqual(self.profile[4], 600 / math.sin(math.radians(40)), places=3)
        # SV (220°): västra stranden x=0 nås vid 400 / sin 40°, innan y=-3000.
        self.assertAlmostEqual(self.profile[22], 400 / math.sin(math.radians(40)), places=3)

    def test_near_mouth(self):
        # 170°: strålen når östra stranden vid y = 500 - 600/tan(10°) ≈ -2903, strax innanför mynningen.
        expected = 600 / math.sin(math.radians(10))
        self.assertAlmostEqual(self.profile[17], expected, places=3)

    def test_effective_fetch_north(self):
        # Alla strålar inom ±12° träffar innersta stranden y=2000 på 1500/cos α, och
        # Σ(F·cos²α)/Σcos α blir då exakt 1500.
        self.assertAlmostEqual(effective_fetch(self.index, BOAT, 0, MAX), 1500.0, places=3)

    def test_effective_fetch_mouth(self):
        # Mot mynningen (180°): stråle α grader åt sidan når sidoväggen på 400/sin α (väst) eller
        # 600/sin|α| (öst) om det sker innan mynningen (3500/cos α bort); annars är vattnet öppet.
        num = den = 0.0
        for a in range(-12, 13, 3):
            r = math.radians(a)
            to_mouth = 3500 / math.cos(r)
            to_wall = math.inf if a == 0 else (400 / math.sin(r) if a > 0 else 600 / math.sin(-r))
            f = to_wall if to_wall < to_mouth else MAX
            num += f * math.cos(r) ** 2
            den += math.cos(r)
        self.assertAlmostEqual(effective_fetch(self.index, BOAT, 180, MAX), num / den, places=3)

    def test_land_detection(self):
        self.assertFalse(self.index.is_on_land(BOAT))
        self.assertTrue(self.index.is_on_land((-200.0, 500.0)))
        self.assertTrue(self.index.is_on_land((500.0, 2300.0)))

    def test_nudge_from_jetty(self):
        p, moved = self.index.nearest_water((-30.0, 500.0))
        self.assertIsNotNone(p)
        self.assertFalse(self.index.is_on_land(p))
        self.assertLess(moved, 100)


    def test_nudge_from_waterline(self):
        # En badplats som ligger exakt i strandkanten (x=0) flyttas ut minst 15 m från stranden.
        p, moved = self.index.nearest_water((0.0, 500.0))
        self.assertIsNotNone(p)
        self.assertGreaterEqual(min(fetch_profile(self.index, p, 10, MAX, effective=False)), 15.0)


if __name__ == "__main__":
    unittest.main()
