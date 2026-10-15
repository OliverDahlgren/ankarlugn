"""Oberoende kontroll av vågmodellen mot SMHI:s vågboj i Hårsfjärden.

Bojen låg i en skyddad del av skärgården (april–maj 2015), alltså samma slags vatten som sidan
bedömer. För varje timme räknas våghöjden ut med exakt samma metod som sidan (effektiv stryklängd
från OSM-kustlinjen och Hs = 0,0016 · U · √(F/g)) ur uppmätt vind, och jämförs med bojens mätning.

Kör efter build_profiles.py (kustlinjen återanvänds från cache/):
    python3 scripts/validate_waves.py
Data: SMHI öppna data (CC BY 4.0). Resultat: data/validation.json.
"""
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from build_profiles import CACHE, COAST_BBOXES, ROOT, fetch_coastline  # noqa: E402
from fetchcalc import CoastIndex, Projector, fetch_profile  # noqa: E402

BUOY = {"id": 33031, "name": "Hårsfjärden Vågboj", "lat": 59.0363, "lon": 18.1205}
# Vindstationer: Berga ligger 3,5 km från bojen men på land; Landsort A ligger ute till havs 35 km bort.
WIND_STATIONS = {98040: "Berga", 87440: "Landsort A"}
OCOBS = "https://opendata-download-ocobs.smhi.se/api/version/latest/parameter/{p}/station/{s}/period/corrected-archive/data.csv"
METOBS = "https://opendata-download-metobs.smhi.se/api/version/latest/parameter/{p}/station/{s}/period/corrected-archive/data.csv"
P_DIR, P_SPEED = 3, 4
STEP_DEG = 10
MAX_FETCH = 20000.0
SPREAD_DEG = 10          # samma som sidan använder det första dygnet
THRESHOLDS = (0.2, 0.4)  # gult/rött för mellanstor båt, samma som sidan
LINE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ ;](\d{2}:\d{2}):\d{2};([-\d.]+);([A-Z])")


def download(url, name):
    path = os.path.join(CACHE, "validation", name)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        subprocess.run(["curl", "-sf", "--max-time", "300", "-o", path, url], check=True)
    with open(path, encoding="utf-8-sig") as f:
        return f.read()


def parse(text):
    """{"YYYY-MM-DDTHH": värde} för godkända (G) och kontrollerade (Y) värden på hela timmar."""
    out = {}
    for line in text.splitlines():
        m = LINE.match(line)
        if m and m.group(4) in "GY" and m.group(2).endswith(":00"):
            out[f"{m.group(1)}T{m.group(2)[:2]}"] = float(m.group(3))
    return out


def fetch_at(profile, direction, spread):
    """Som sidan: största effektiva stryklängden inom ±spread grader från vindriktningen."""
    n = len(profile)
    step = 360 / n
    worst = 0.0
    d = direction - spread
    while d <= direction + spread:
        worst = max(worst, profile[int(round((d % 360) / step)) % n])
        d += step / 2
    return worst


def hs_model(wind, fetch):
    return 0.0016 * wind * math.sqrt(fetch / 9.81)


def cls(hs):
    return 0 if hs < THRESHOLDS[0] else 1 if hs < THRESHOLDS[1] else 2


def stats(pairs):
    obs = [o for o, _ in pairs]
    pred = [p for _, p in pairs]
    n = len(pairs)
    bias = sum(p - o for o, p in pairs) / n
    rmse = math.sqrt(sum((p - o) ** 2 for o, p in pairs) / n)
    mo, mp = sum(obs) / n, sum(pred) / n
    cov = sum((o - mo) * (p - mp) for o, p in pairs)
    so = math.sqrt(sum((o - mo) ** 2 for o in obs))
    sp = math.sqrt(sum((p - mp) ** 2 for p in pred))
    confusion = [[0] * 3 for _ in range(3)]
    for o, p in pairs:
        confusion[cls(o)][cls(p)] += 1
    agree = sum(confusion[i][i] for i in range(3))
    under = sum(confusion[i][j] for i in range(3) for j in range(3) if j < i)
    obs_rough = sum(confusion[1]) + sum(confusion[2])          # timmar som faktiskt var gula/röda
    caught = sum(confusion[i][j] for i in (1, 2) for j in (1, 2))
    obs_calm = sum(confusion[0])
    false_alarm = confusion[0][1] + confusion[0][2]
    return {
        "n": n, "bias_m": round(bias, 3), "rmse_m": round(rmse, 3),
        "r": round(cov / (so * sp), 3) if so and sp else None,
        "mean_obs_m": round(mo, 3), "mean_pred_m": round(mp, 3),
        "class_agreement": round(agree / n, 3), "class_underestimated": round(under / n, 3),
        # Jämförelse: att alltid svara grönt ger rätt färg lika ofta som andelen lugna timmar.
        "baseline_always_green": round(obs_calm / n, 3),
        "rough_hours": obs_rough,
        "rough_caught": round(caught / obs_rough, 3) if obs_rough else None,
        "calm_false_alarm": round(false_alarm / obs_calm, 3) if obs_calm else None,
        "confusion_obs_rows_pred_cols": confusion,
    }


def main():
    hs = parse(download(OCOBS.format(p=1, s=BUOY["id"]), f"hs_{BUOY['id']}.csv"))
    print(f"{len(hs)} timvärden från {BUOY['name']} ({min(hs)} – {max(hs)})")

    proj = Projector(BUOY["lat"], BUOY["lon"])
    ways = {}
    for bbox in COAST_BBOXES:
        ways.update(fetch_coastline(*bbox))
    segments = []
    for geom in ways.values():
        pts = [proj.to_xy(g["lat"], g["lon"]) for g in geom]
        segments.extend(zip(pts, pts[1:]))
    index = CoastIndex(segments, cell=250.0)
    p, moved = index.nearest_water(proj.to_xy(BUOY["lat"], BUOY["lon"]))
    profile = fetch_profile(index, p, STEP_DEG, MAX_FETCH)
    print(f"Bojens position flyttad {moved:.0f} m; effektiv stryklängd {min(profile):.0f}–{max(profile):.0f} m")

    result = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "buoy": BUOY, "period": [min(hs), max(hs)], "thresholds_m": THRESHOLDS,
        "fetch_m": [round(x) for x in profile], "stations": [],
        "attribution": "Våg- och vinddata: SMHI öppna data (CC BY 4.0). Kustlinje: © OpenStreetMap-bidragsgivare (ODbL).",
    }
    for sid, sname in WIND_STATIONS.items():
        wdir = parse(download(METOBS.format(p=P_DIR, s=sid), f"dir_{sid}.csv"))
        wspd = parse(download(METOBS.format(p=P_SPEED, s=sid), f"speed_{sid}.csv"))
        pairs, points = [], []
        for t, o in sorted(hs.items()):
            if t in wdir and t in wspd:
                f = fetch_at(profile, wdir[t], SPREAD_DEG)
                pred = hs_model(wspd[t], f)
                pairs.append((o, pred))
                points.append([t, round(o, 2), round(pred, 3), round(wspd[t], 1), round(wdir[t])])
        if not pairs:
            print(f"  {sname}: inga samtidiga värden")
            continue
        st = stats(pairs)
        print(f"  {sname}: n={st['n']} bias={st['bias_m']:+.3f} m RMSE={st['rmse_m']:.3f} m r={st['r']} "
              f"klass rätt {st['class_agreement']:.0%}, underskattad {st['class_underestimated']:.0%}")
        result["stations"].append({"id": sid, "name": sname, "stats": st, "points": points})

    path = os.path.join(ROOT, "data", "validation.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Skrev {path}")


if __name__ == "__main__":
    main()
