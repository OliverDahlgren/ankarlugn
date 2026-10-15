"""Räknar ut skyddsprofiler (stryklängd per 10°) för platserna i places.tsv.

Kör:  python3 scripts/build_profiles.py
Data: © OpenStreetMap-bidragsgivare, ODbL. Rådata cachas i cache/ (ingår inte i repot).
"""
import json
import math
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from fetchcalc import CoastIndex, Projector, fetch_profile  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
CACHE = os.path.join(ROOT, "cache")
STEP_DEG = 10
MAX_FETCH = 20000.0
ENDPOINTS = ["https://overpass-api.de/api/interpreter"]
USER_AGENT = "ankarlugn/1.0 (+https://github.com/OliverDahlgren/ankarlugn)"


def _post(url, query):
    try:
        req = urllib.request.Request(
            url,
            data=urllib.parse.urlencode({"data": query}).encode(),
            headers={"User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.read()
    except urllib.error.URLError as e:
        if not isinstance(e.reason, ssl.SSLError):
            raise
        # Äldre Python (t.ex. macOS inbyggda med LibreSSL) klarar inte serverns TLS; använd curl.
        return subprocess.run(
            ["curl", "-sf", "--max-time", "300", "-A", USER_AGENT, "--data-urlencode", f"data={query}", url],
            check=True, capture_output=True,
        ).stdout


def overpass(query, attempts=6):
    last = None
    for attempt in range(attempts):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            data = json.loads(_post(url, query))
            if "remark" in data:  # Overpass svarar 200 med en anmärkning vid timeout; svaret är då ofullständigt
                raise RuntimeError(data["remark"])
            return data
        except Exception as e:  # serverfel, timeout eller HTML-felsida
            last = e
            wait = 15 * (attempt + 1)
            print(f"  Overpass misslyckades ({e}); försöker igen om {wait} s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"Overpass gick inte att nå: {last}")


def cached(name, fn):
    path = os.path.join(CACHE, name)
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    data = fn()
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)
    return data


def read_places():
    rows = []
    with open(os.path.join(os.path.dirname(__file__), "places.tsv"), encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            ref, name = line.split("\t")
            rows.append((ref, name))
    return rows


def fetch_places(rows):
    kinds = {"n": "node", "w": "way", "r": "relation"}
    parts = "".join(f"{kinds[ref[0]]}({ref[1:]});" for ref, _ in rows)
    data = cached("places.json", lambda: overpass(f"[out:json][timeout:120];({parts});out center tags;"))
    by_ref = {f"{e['type'][0]}{e['id']}": e for e in data["elements"]}
    places = []
    for ref, name in rows:
        e = by_ref[ref]
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lon = e.get("lon", e.get("center", {}).get("lon"))
        tags = e.get("tags", {})
        kind = "naturhamn" if tags.get("seamark:type") == "anchorage" else "gästhamn"
        places.append({
            "id": ref, "name": name, "osm_name": tags.get("name", ""), "kind": kind,
            "osm_lat": lat, "osm_lon": lon,
        })
    return places


def fetch_coast_tile(bbox, ways, depth=0):
    """Hämtar en ruta; delar den i fyra om servern inte klarar den (täta skärgårdsområden)."""
    s, w, n, e = bbox
    name = "coast_{}_{}_{}_{}.json".format(*bbox)
    q = '[out:json][timeout:180];way["natural"="coastline"]({},{},{},{});out skel geom qt;'.format(*bbox)
    print(f"  kustlinje {bbox}")
    try:
        data = cached(name, lambda: overpass(q, attempts=2 if depth < 3 else 6))
    except RuntimeError:
        if depth >= 3:
            raise
        ml, mo = round((s + n) / 2, 4), round((w + e) / 2, 4)
        for sub in ((s, w, ml, mo), (s, mo, ml, e), (ml, w, n, mo), (ml, mo, n, e)):
            fetch_coast_tile(sub, ways, depth + 1)
        return
    for way in data["elements"]:
        ways[way["id"]] = way["geometry"]


def fetch_coastline(south, west, north, east, tile=0.25):
    """Hämtar natural=coastline i rutor så att Overpass inte överbelastas."""
    ways = {}
    lat = south
    while lat < north:
        lon = west
        while lon < east:
            bbox = (round(lat, 3), round(lon, 3), round(min(lat + tile, north), 3), round(min(lon + 2 * tile, east), 3))
            fetch_coast_tile(bbox, ways)
            lon += 2 * tile
        lat += tile
    return ways


def main():
    rows = read_places()
    print(f"Hämtar {len(rows)} platser från OpenStreetMap")
    places = fetch_places(rows)

    lats = [p["osm_lat"] for p in places]
    lons = [p["osm_lon"] for p in places]
    proj = Projector(sum(lats) / len(lats), sum(lons) / len(lons))
    pad_lat = MAX_FETCH / 111000 + 0.02
    pad_lon = pad_lat / math.cos(math.radians(proj.lat0))
    print("Hämtar kustlinje")
    ways = fetch_coastline(min(lats) - pad_lat, min(lons) - pad_lon, max(lats) + pad_lat, max(lons) + pad_lon)

    segments = []
    for geom in ways.values():
        pts = [proj.to_xy(g["lat"], g["lon"]) for g in geom]
        segments.extend(zip(pts, pts[1:]))
    print(f"{len(ways)} kustlinjer, {len(segments)} segment")
    index = CoastIndex(segments, cell=250.0)

    out = []
    for p in places:
        q, moved = index.nearest_water(proj.to_xy(p["osm_lat"], p["osm_lon"]))
        if q is None:
            print(f"  VARNING: hittar inget vatten nära {p['name']}, hoppar över", file=sys.stderr)
            continue
        lat, lon = proj.to_latlon(*q)
        prof = fetch_profile(index, q, STEP_DEG, MAX_FETCH)
        rays = fetch_profile(index, q, STEP_DEG, MAX_FETCH, effective=False)
        print(f"  {p['name']:32s} flyttad {moved:4.0f} m  min {min(prof):6.0f} m  max {max(prof):6.0f} m")
        out.append({
            "id": p["id"], "name": p["name"], "osm_name": p["osm_name"], "kind": p["kind"],
            "lat": round(lat, 6), "lon": round(lon, 6), "moved_m": round(moved),
            "fetch_m": [round(d) for d in prof],
            "ray_m": [round(d) for d in rays],
        })

    result = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "step_deg": STEP_DEG,
        "max_fetch_m": MAX_FETCH,
        "note": ("fetch_m[i] = effektiv stryklängd (m, SPM 1984: strålar inom ±12° vägda med cos²) i riktningen "
                 "i*step_deg grader, varifrån vinden kommer. ray_m[i] = en enda stråle i samma riktning."),
        "attribution": "Platser och kustlinje © OpenStreetMap-bidragsgivare, ODbL",
        "places": out,
    }
    path = os.path.join(ROOT, "data", "profiles.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"Skrev {path}")


if __name__ == "__main__":
    main()
