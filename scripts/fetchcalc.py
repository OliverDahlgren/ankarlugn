"""Stryklängd: avstånd över öppet vatten från en punkt till närmaste land i en viss riktning.

Koordinater är lokala meter (x österut, y norrut). Kustlinjen är en lista av segment
((ax, ay), (bx, by)) riktade som i OpenStreetMap: land till vänster, vatten till höger.
"""
import math

EARTH_R = 6371000.0


class Projector:
    """Enkel ekvirektangulär projektion, tillräckligt noggrann inom några mil."""

    def __init__(self, lat0, lon0):
        self.lat0 = lat0
        self.lon0 = lon0
        self.kx = math.radians(1) * EARTH_R * math.cos(math.radians(lat0))
        self.ky = math.radians(1) * EARTH_R

    def to_xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def to_latlon(self, x, y):
        return (self.lat0 + y / self.ky, self.lon0 + x / self.kx)


def _cross(ax, ay, bx, by):
    return ax * by - ay * bx


class CoastIndex:
    """Rutnätsindex över kustsegment så att strålar bara testar närliggande segment."""

    def __init__(self, segments, cell=500.0):
        self.segments = segments
        self.cell = cell
        self.grid = {}
        for i, ((ax, ay), (bx, by)) in enumerate(segments):
            x0, x1 = sorted((ax, bx))
            y0, y1 = sorted((ay, by))
            for cx in range(int(math.floor(x0 / cell)), int(math.floor(x1 / cell)) + 1):
                for cy in range(int(math.floor(y0 / cell)), int(math.floor(y1 / cell)) + 1):
                    self.grid.setdefault((cx, cy), []).append(i)

    def first_hit(self, p, bearing_deg, max_dist):
        """Första kustsegment som strålen från p i kompassriktningen bearing_deg träffar.

        Returnerar (avstånd, segmentindex) eller (None, None) om inget land finns inom max_dist.
        """
        px, py = p
        dx = math.sin(math.radians(bearing_deg))
        dy = math.cos(math.radians(bearing_deg))
        step = self.cell / 4
        tested = set()
        best_t, best_i = None, None
        s = 0.0
        while s <= max_dist + self.cell:
            cx = int(math.floor((px + dx * s) / self.cell))
            cy = int(math.floor((py + dy * s) / self.cell))
            for ox in (-1, 0, 1):
                for oy in (-1, 0, 1):
                    for i in self.grid.get((cx + ox, cy + oy), ()):
                        if i in tested:
                            continue
                        tested.add(i)
                        t = _ray_segment(px, py, dx, dy, self.segments[i])
                        if t is not None and (best_t is None or t < best_t):
                            best_t, best_i = t, i
            # Alla celler inom en cells avstånd från strålen fram till s är testade.
            if best_t is not None and best_t <= s - self.cell:
                break
            s += step
        if best_t is None or best_t > max_dist:
            return None, None
        return best_t, best_i

    def is_on_land(self, p, max_dist=20000.0, n_rays=36):
        """Majoritetsröstning: ligger p till vänster (landsidan) om de kustsegment strålarna träffar?"""
        land = water = 0
        for k in range(n_rays):
            t, i = self.first_hit(p, k * 360.0 / n_rays, max_dist)
            if i is None:
                continue
            (ax, ay), (bx, by) = self.segments[i]
            if _cross(bx - ax, by - ay, p[0] - ax, p[1] - ay) > 0:
                land += 1
            else:
                water += 1
        return land > water

    def nearest_water(self, p, max_radius=500.0, margin=15.0):
        """Flytta en punkt som ligger på land (t.ex. en brygga) till närmaste vatten.

        Returnerar (punkt, flyttat avstånd i meter) eller (None, None) om inget vatten hittas.
        """
        if not self.is_on_land(p):
            return p, 0.0
        r = 10.0
        while r <= max_radius:
            for k in range(24):
                b = math.radians(k * 15)
                q = (p[0] + math.sin(b) * (r + margin), p[1] + math.cos(b) * (r + margin))
                if not self.is_on_land(q):
                    return q, r + margin
            r += 10.0
        return None, None


def _ray_segment(px, py, dx, dy, seg):
    (ax, ay), (bx, by) = seg
    ex, ey = bx - ax, by - ay
    denom = _cross(dx, dy, ex, ey)
    if abs(denom) < 1e-12:
        return None
    wx, wy = ax - px, ay - py
    t = _cross(wx, wy, ex, ey) / denom
    u = _cross(wx, wy, dx, dy) / denom
    if t >= 0 and 0 <= u <= 1:
        return t
    return None


def ray_fetch(index, p, bearing_deg, max_dist=20000.0):
    t, _ = index.first_hit(p, bearing_deg, max_dist)
    return max_dist if t is None else t


def effective_fetch(index, p, bearing_deg, max_dist=20000.0, half_width=12, step=3):
    """Effektiv stryklängd enligt Shore Protection Manual (1984): strålar inom ±12° vägda med cos².

    Jämnar ut både smala sund mellan öar och enstaka små skär som en ensam stråle annars
    skulle över- respektive underskatta.
    """
    num = den = 0.0
    for a in range(-half_width, half_width + 1, step):
        c = math.cos(math.radians(a))
        num += ray_fetch(index, p, bearing_deg + a, max_dist) * c * c
        den += c
    return num / den


def fetch_profile(index, p, step_deg=10, max_dist=20000.0, effective=True):
    """Stryklängd i meter för varje riktning 0, step_deg, ... (kompassgrader, riktningen vinden kommer från)."""
    fn = effective_fetch if effective else ray_fetch
    return [fn(index, p, k * step_deg, max_dist) for k in range(int(360 / step_deg))]
