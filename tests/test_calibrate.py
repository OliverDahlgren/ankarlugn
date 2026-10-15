"""Test av kalibreringens beslutsregel med påhittade data där rätt svar är känt."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import calibrate  # noqa: E402


def rows(true_factor, days=16, per_day=24):
    """Modellen räknar ut 0,05–0,40 m, men verkligheten är true_factor gånger det."""
    out = []
    for d in range(days):
        for h in range(per_day):
            pred = 0.05 + 0.35 * ((d * per_day + h) % 50) / 49
            out.append([f"2015-04-{d + 1:02d}T{h:02d}", round(true_factor * pred, 4), pred])
    return out


class TestCalibrate(unittest.TestCase):
    def test_finds_known_factor(self):
        # Verkligheten är 1,5 gånger modellen: minsta kvadrat ska hitta exakt 1,5.
        a = calibrate.analyse(rows(1.5))
        self.assertAlmostEqual(a["k_least_squares"], 1.5, places=2)
        # Gränsen 0,2 m korsas av k · p när p = 0,2 / k; med k ≈ 1,5 ska inga timmar missas.
        self.assertEqual(a["full_period"]["miss_k"], 0)

    def test_no_change_when_model_is_right(self):
        a = calibrate.analyse(rows(1.0))
        self.assertEqual(a["k"], 1.0)
        self.assertEqual(a["folds_better"], 0)

    def test_adopts_when_sources_agree(self):
        per = {"A": calibrate.analyse(rows(1.3)), "B": calibrate.analyse(rows(1.5))}
        factor, _ = calibrate.decide(per)
        # Båda pekar uppåt: den minsta ändringen (närmast 1) väljs.
        self.assertEqual(factor, per["A"]["k"])
        self.assertGreater(factor, 1.0)

    def test_rejects_when_sources_disagree(self):
        per = {"A": calibrate.analyse(rows(1.5)), "B": calibrate.analyse(rows(0.6))}
        factor, reason = calibrate.decide(per)
        self.assertEqual(factor, 1.0)
        self.assertIn("olika håll", reason)

    def test_rejects_when_not_better_out_of_sample(self):
        per = {"A": calibrate.analyse(rows(1.5)), "B": calibrate.analyse(rows(1.0))}
        factor, reason = calibrate.decide(per)
        self.assertEqual(factor, 1.0)
        self.assertIn("testblock", reason)


if __name__ == "__main__":
    unittest.main()
