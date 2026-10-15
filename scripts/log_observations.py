"""Loggar SMHI:s prognosvind och uppmätt vind och vågor, för att senare kunna kalibrera mot prognosvinden.

Körs av GitHub Actions några gånger per dygn (.github/workflows/logg.yml) och sparar till grenen `logg`:
  <ut>/forecast/ÅÅÅÅ-MM.csv  prognos (vindriktning, medelvind, byvind) 48 h framåt för varje punkt
  <ut>/obs/ÅÅÅÅ-MM.csv       uppmätta värden senaste dygnet, utan dubbletter

Lokalt:  python3 scripts/log_observations.py --out /tmp/logs
Data: SMHI öppna data (CC BY 4.0).
"""
import argparse
import csv
import json
import os
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

FORECAST = ("https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/"
            "lon/{lon:.4f}/lat/{lat:.4f}/data.json")
METOBS = "https://opendata-download-metobs.smhi.se/api/version/latest/parameter/{p}/station/{s}/period/latest-day/data.json"
OCOBS = "https://opendata-download-ocobs.smhi.se/api/version/latest/parameter/{p}/station/{s}/period/latest-day/data.json"
USER_AGENT = "ankarlugn-logg/1.0 (+https://github.com/OliverDahlgren/ankarlugn)"
LEAD_HOURS = 48

# Aktiva SMHI-stationer i skärgården. Prognosen hämtas för stationens egen position, så att prognos
# och mätning kan jämföras direkt.
POINTS = [
    {"id": "berga", "name": "Berga", "lat": 59.0680, "lon": 18.1150, "metobs": 98040},
    {"id": "landsort", "name": "Landsort A", "lat": 58.7429, "lon": 17.8684, "metobs": 87440},
    {"id": "skarpo", "name": "Skarpö A", "lat": 59.3446, "lon": 18.7404, "metobs": 98160},
    {"id": "svenska_hogarna", "name": "Svenska Högarna A", "lat": 59.4423, "lon": 19.5022, "metobs": 99280},
    {"id": "soderarm", "name": "Söderarm A", "lat": 59.7531, "lon": 19.4054, "metobs": 99450},
    {"id": "huvudskar_boj", "name": "Huvudskär Ost Boj", "lat": 58.9333, "lon": 19.1667, "ocobs": 33002},
]
METOBS_PARAMS = {3: "wind_dir", 4: "wind_speed", 21: "wind_gust"}   # timvärden
OCOBS_PARAMS = {1: "wave_hs", 9: "wave_tp", 8: "wave_dir"}           # signifikant våghöjd, peakperiod, vågriktning

FORECAST_FIELDS = ["run_utc", "reference_time", "point", "lat", "lon", "valid_time", "lead_h",
                   "wind_dir", "wind_speed", "wind_gust"]
OBS_FIELDS = ["point", "station", "param", "time", "value", "quality"]


def get_json(url):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLError):   # äldre Python med LibreSSL: använd curl
                out = subprocess.run(["curl", "-sf", "--max-time", "60", "-A", USER_AGENT, url],
                                     capture_output=True, check=True).stdout
                return json.loads(out)
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                return None
            time.sleep(10 * (attempt + 1))
    return None


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_rows(path, fields, rows, key=None):
    """Lägger till rader i en CSV-fil; med key hoppas rader som redan finns över."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existing = set()
    exists = os.path.exists(path)

    def k(r):   # jämför som text, eftersom värden som läses tillbaka från CSV alltid är text
        return tuple(str(x) for x in key(r))
    if exists and key:
        with open(path, newline="", encoding="utf-8") as f:
            existing = {k(r) for r in csv.DictReader(f)}
    new = []
    for r in rows:
        if key and k(r) in existing:
            continue
        if key:
            existing.add(k(r))
        new.append(r)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        if not exists:
            w.writeheader()
        w.writerows(new)
    return len(new)


def log_forecasts(out, now):
    rows = []
    run = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    for p in POINTS:
        d = get_json(FORECAST.format(lat=p["lat"], lon=p["lon"]))
        if not d:
            print(f"  prognos saknas för {p['name']}")
            continue
        ref = d.get("referenceTime")
        ref_dt = datetime.strptime(ref, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        for s in d["timeSeries"]:
            valid = datetime.strptime(s["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            lead = (valid - ref_dt).total_seconds() / 3600
            if lead > LEAD_HOURS:
                break
            v = s["data"]
            rows.append({
                "run_utc": run, "reference_time": ref, "point": p["id"], "lat": p["lat"], "lon": p["lon"],
                "valid_time": s["time"], "lead_h": round(lead, 1),
                "wind_dir": v.get("wind_from_direction"), "wind_speed": v.get("wind_speed"),
                "wind_gust": v.get("wind_speed_of_gust"),
            })
    # Samma prognoskörning kan hämtas två gånger om SMHI inte har publicerat en ny; spara den bara en gång.
    path = os.path.join(out, "forecast", now.strftime("%Y-%m") + ".csv")
    return append_rows(path, FORECAST_FIELDS, rows, key=lambda r: (r["reference_time"], r["point"], r["valid_time"]))


def log_observations(out, now):
    rows = []
    for p in POINTS:
        sources = []
        if "metobs" in p:
            sources += [(METOBS, p["metobs"], k, name) for k, name in METOBS_PARAMS.items()]
        if "ocobs" in p:
            sources += [(OCOBS, p["ocobs"], k, name) for k, name in OCOBS_PARAMS.items()]
        for url, station, param, name in sources:
            d = get_json(url.format(p=param, s=station))
            for v in (d or {}).get("value") or []:
                rows.append({"point": p["id"], "station": station, "param": name, "time": iso(v["date"]),
                             "value": v["value"], "quality": v.get("quality", "")})
    added = 0
    by_month = {}
    for r in rows:
        by_month.setdefault(r["time"][:7], []).append(r)
    for month, month_rows in by_month.items():
        path = os.path.join(out, "obs", month + ".csv")
        added += append_rows(path, OBS_FIELDS, month_rows, key=lambda r: (r["station"], r["param"], r["time"]))
    return added, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="mapp där loggfilerna sparas")
    out = ap.parse_args().out
    now = datetime.now(timezone.utc)
    f = log_forecasts(out, now)
    o, seen = log_observations(out, now)
    print(f"{now:%Y-%m-%d %H:%M} UTC: {f} nya prognosrader, {o} nya mätvärden (av {seen} hämtade)")


if __name__ == "__main__":
    main()
