"""Test att loggningen inte sparar samma mätvärde två gånger, även när värden läses tillbaka som text."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from log_observations import OBS_FIELDS, append_rows  # noqa: E402


def key(r):
    return (r["station"], r["param"], r["time"])


class TestAppendRows(unittest.TestCase):
    def test_no_duplicates_across_runs(self):
        rows = [
            {"point": "berga", "station": 98040, "param": "wind_speed", "time": "2026-10-15T18:00:00Z", "value": "4.1", "quality": "G"},
            {"point": "berga", "station": 98040, "param": "wind_speed", "time": "2026-10-15T19:00:00Z", "value": "4.4", "quality": "G"},
        ]
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "obs", "2026-10.csv")
            self.assertEqual(append_rows(path, OBS_FIELDS, rows, key=key), 2)
            # Andra körningen: samma två timmar plus en ny; stationsnumret är tal här men text i filen.
            more = rows + [{**rows[1], "time": "2026-10-15T20:00:00Z"}]
            self.assertEqual(append_rows(path, OBS_FIELDS, more, key=key), 1)
            with open(path, encoding="utf-8") as f:
                self.assertEqual(len(f.read().strip().splitlines()), 1 + 3)

    def test_duplicates_within_one_batch(self):
        row = {"point": "berga", "station": 98040, "param": "wind_dir", "time": "2026-10-15T18:00:00Z", "value": "200", "quality": "G"}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "obs.csv")
            self.assertEqual(append_rows(path, OBS_FIELDS, [row, dict(row)], key=key), 1)


if __name__ == "__main__":
    unittest.main()
