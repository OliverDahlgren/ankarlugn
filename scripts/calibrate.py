"""Kalibrering av vågmodellen mot vågbojen i Hårsfjärden, med skydd mot överanpassning.

Bojen mäter våghöjd, inte komfort. Därför kalibreras bara EN sak: en faktor k som multipliceras
med modellens beräknade våghöjd. Gränserna för gult och rött (komfort) ändras inte.

Regeln nedan bestämdes innan resultatet var känt och tillämpas automatiskt:

1. För varje vindkälla väljs k (0,40–2,00) så att kostnaden blir så låg som möjligt, där en missad
   timme (uppmätt gul/röd men beräknad grön) kostar MISS_WEIGHT gånger mer än ett falsklarm.
2. Korsvalidering i FOLDS sammanhängande tidsblock (hela dagar, eftersom närliggande timmar nästan
   är kopior av varandra): k anpassas på övriga block och prövas på blocket som lämnats utanför.
   Faktorn "hjälper" om den ger lägre kostnad än k = 1 i minst MIN_FOLDS_BETTER av blocken.
3. k används bara om den hjälper för ALLA vindkällor och alla pekar åt samma håll (alla > 1 eller
   alla < 1). Då väljs den som ligger närmast 1, alltså den minsta ändringen. Annars blir k = 1.

Kör efter validate_waves.py:  python3 scripts/calibrate.py   →  data/calibration.json
"""
import json
import os
import random
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(__file__), "..")
THRESHOLD = 0.2          # gräns för gult (mellanstor båt), där nästan alla mätta skillnader finns
MISS_WEIGHT = 3          # en missad grov timme kostar 3 falsklarm
SENSITIVITY_WEIGHTS = (1, 3, 5)
K_GRID = [k / 100 for k in range(40, 201)]
FOLDS = 4
MIN_FOLDS_BETTER = 3
BOOTSTRAP = int(os.environ.get("CALIBRATE_BOOTSTRAP", "1000"))
SEED = 1


def counts(points, k):
    miss = sum(1 for o, p in points if o >= THRESHOLD and k * p < THRESHOLD)
    false_alarm = sum(1 for o, p in points if o < THRESHOLD and k * p >= THRESHOLD)
    return miss, false_alarm


def cost(points, k, w=MISS_WEIGHT):
    miss, fa = counts(points, k)
    return w * miss + fa


def best_k(points, w=MISS_WEIGHT):
    """Lägsta kostnad; vid lika kostnad väljs k närmast 1 (minsta ändring)."""
    return min(K_GRID, key=lambda k: (cost(points, k, w), abs(k - 1)))


def least_squares_k(points):
    den = sum(p * p for _, p in points)
    return sum(o * p for o, p in points) / den if den else 1.0


def blocks_by_day(rows, n):
    days = sorted({r[0][:10] for r in rows})
    size = len(days) / n
    return [set(days[round(i * size):round((i + 1) * size)]) for i in range(n)]


def interval(values, lo=0.05, hi=0.95):
    v = sorted(values)
    return [round(v[int(lo * (len(v) - 1))], 2), round(v[int(hi * (len(v) - 1))], 2)]


def analyse(rows):
    """rows: [tid, uppmätt, beräknad, ...] för en vindkälla."""
    points = [(r[1], r[2]) for r in rows]
    folds = []
    for test_days in blocks_by_day(rows, FOLDS):
        train = [(r[1], r[2]) for r in rows if r[0][:10] not in test_days]
        test = [(r[1], r[2]) for r in rows if r[0][:10] in test_days]
        k = best_k(train)
        m_k, fa_k = counts(test, k)
        m_1, fa_1 = counts(test, 1.0)
        folds.append({
            "days": [min(test_days), max(test_days)], "hours": len(test), "k_train": k,
            "cost_k": cost(test, k), "cost_1": cost(test, 1.0),
            "miss_k": m_k, "false_alarm_k": fa_k, "miss_1": m_1, "false_alarm_1": fa_1,
        })
    rng = random.Random(SEED)
    by_day = {}
    for r in rows:
        by_day.setdefault(r[0][:10], []).append((r[1], r[2]))
    days = sorted(by_day)
    boot_cost, boot_ls = [], []
    for _ in range(BOOTSTRAP):
        sample = [pt for d in (rng.choice(days) for _ in days) for pt in by_day[d]]
        boot_cost.append(best_k(sample))
        boot_ls.append(least_squares_k(sample))
    k_all = best_k(points)
    return {
        "k_least_squares": round(least_squares_k(points), 2), "k_least_squares_90": interval(boot_ls),
        "k": k_all, "k_90": interval(boot_cost),
        "k_by_weight": {str(w): best_k(points, w) for w in SENSITIVITY_WEIGHTS},
        "full_period": dict(zip(("miss_k", "false_alarm_k"), counts(points, k_all)))
        | dict(zip(("miss_1", "false_alarm_1"), counts(points, 1.0))),
        "folds": folds,
        "folds_better": sum(f["cost_k"] < f["cost_1"] for f in folds),
    }


def sv(x):
    return f"{x:.2f}".replace(".", ",")


def decide(per_source):
    """Regel 3: returnerar (faktor, motivering)."""
    helps = {name: a["folds_better"] >= MIN_FOLDS_BETTER for name, a in per_source.items()}
    ks = {name: a["k"] for name, a in per_source.items()}
    if not all(helps.values()):
        failing = ", ".join(n for n, h in helps.items() if not h)
        return 1.0, (f"Ingen korrektion: faktorn slog inte k = 1 i minst {MIN_FOLDS_BETTER} av {FOLDS} "
                     f"testblock för {failing}.")
    if not (all(k > 1 for k in ks.values()) or all(k < 1 for k in ks.values())):
        return 1.0, "Ingen korrektion: vindkällorna pekar åt olika håll (" + \
            ", ".join(f"{n} ×{sv(k)}" for n, k in ks.items()) + ")."
    k = min(ks.values(), key=lambda x: abs(x - 1))
    return k, f"Korrektion ×{sv(k)}: alla vindkällor hjälper i testblocken och pekar åt samma håll."


def main():
    with open(os.path.join(ROOT, "data", "validation.json"), encoding="utf-8") as f:
        v = json.load(f)
    per_source = {st["name"]: analyse(st["points"]) for st in v["stations"]}
    factor, reason = decide(per_source)
    for name, a in per_source.items():
        print(f"{name}: k={a['k']} (90 % {a['k_90']}), minsta kvadrat {a['k_least_squares']}, "
              f"bättre i {a['folds_better']}/{FOLDS} block, per vikt {a['k_by_weight']}")
    print(reason)
    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "wave_factor": factor, "decision": reason,
        "settings": {"threshold_m": THRESHOLD, "miss_weight": MISS_WEIGHT, "folds": FOLDS,
                     "min_folds_better": MIN_FOLDS_BETTER, "bootstrap": BOOTSTRAP, "seed": SEED,
                     "k_range": [K_GRID[0], K_GRID[-1]]},
        "sources": per_source,
        "buoy": v["buoy"]["name"], "period": v["period"],
    }
    with open(os.path.join(ROOT, "data", "calibration.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("Skrev data/calibration.json")


if __name__ == "__main__":
    main()
