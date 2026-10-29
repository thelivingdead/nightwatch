"""Build the London-wide crime dataset the site loads.

Downloads borough boundaries (ONS) and one month of street-level crime for
every London borough (police.uk), then writes:
  js/data/boroughs.js  borough outlines as GeoJSON
  js/data/london.js    crimes grouped by snapped location and category

Usage: python3 scripts/build_london.py [YYYY-MM]
"""
import json
import math
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "data"
ONS = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "Local_Authority_Districts_December_2024_Boundaries_UK_BGC/FeatureServer/0/query"
)
POLICE = "https://data.police.uk/api"
TILE_LNG, TILE_LAT = 0.04, 0.025


def curl(url, timeout=150):
    # curl uses the system trust store, which some macOS Python builds lack.
    r = subprocess.run(
        ["curl", "-sS", "--max-time", str(timeout), "-w", "\n%{http_code}", url],
        capture_output=True, text=True,
    )
    body, _, code = r.stdout.rpartition("\n")
    return int(code or 0), body


def get_json(url):
    code, body = curl(url)
    if code != 200:
        raise RuntimeError(f"HTTP {code} for {url[:100]}")
    return json.loads(body)


def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    return geom["coordinates"]


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polys(x, y, polys):
    for poly in polys:
        if point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def area_km2(polys):
    lat0 = math.radians(51.5)
    kx, ky = 111.32 * math.cos(lat0), 110.54
    total = 0.0
    for poly in polys:
        for k, ring in enumerate(poly):
            s = 0.0
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
            total += abs(s) / 2 * (-1 if k else 1)
    return total


def fetch_tile(box, month, depth=0):
    """Fetch crimes in a lat/lng box, splitting it when police.uk refuses (>10k crimes)."""
    s, w, n, e = box
    poly = f"{s},{w}:{s},{e}:{n},{e}:{n},{w}"
    url = f"{POLICE}/crimes-street/all-crime?date={month}&poly={quote(poly, safe=',:')}"
    for attempt in range(4):
        code, body = curl(url)
        if code == 200:
            return json.loads(body)
        if code == 503 and depth < 4:
            mlat, mlng = (s + n) / 2, (w + e) / 2
            out = []
            for sub in ((s, w, mlat, mlng), (s, mlng, mlat, e), (mlat, w, n, mlng), (mlat, mlng, n, e)):
                out.extend(fetch_tile(sub, month, depth + 1))
            return out
        time.sleep(2 + attempt * 3)
    raise RuntimeError(f"Tile {box} failed with HTTP {code}")


def main():
    month = sys.argv[1] if len(sys.argv) > 1 else get_json(f"{POLICE}/crimes-street-dates")[0]["date"]
    print(f"Month: {month}", flush=True)

    query = (
        "where=" + quote("LAD24CD LIKE 'E09%'")
        + "&outFields=LAD24CD,LAD24NM&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0003&f=geojson"
    )
    gj = get_json(f"{ONS}?{query}")
    boroughs = []
    for f in gj["features"]:
        polys = rings_of(f["geometry"])
        xs = [p[0] for poly in polys for p in poly[0]]
        ys = [p[1] for poly in polys for p in poly[0]]
        boroughs.append({
            "code": f["properties"]["LAD24CD"],
            "name": f["properties"]["LAD24NM"],
            "polys": polys,
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
            "area": area_km2(polys),
        })
    boroughs.sort(key=lambda b: b["name"])
    print(f"{len(boroughs)} boroughs", flush=True)

    west = min(b["bbox"][0] for b in boroughs)
    south = min(b["bbox"][1] for b in boroughs)
    east = max(b["bbox"][2] for b in boroughs)
    north = max(b["bbox"][3] for b in boroughs)

    def in_london(x, y):
        return any(
            b["bbox"][0] <= x <= b["bbox"][2] and b["bbox"][1] <= y <= b["bbox"][3]
            and point_in_polys(x, y, b["polys"])
            for b in boroughs
        )

    tiles = []
    lat = south
    while lat < north:
        lng = west
        while lng < east:
            box = (lat, lng, min(lat + TILE_LAT, north), min(lng + TILE_LNG, east))
            samples = [
                (box[1] + fx * (box[3] - box[1]), box[0] + fy * (box[2] - box[0]))
                for fx in (0, 0.25, 0.5, 0.75, 1) for fy in (0, 0.25, 0.5, 0.75, 1)
            ]
            if any(in_london(x, y) for x, y in samples):
                tiles.append(box)
            lng += TILE_LNG
        lat += TILE_LAT
    print(f"{len(tiles)} tiles to fetch", flush=True)

    crimes = {}
    done = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for result in pool.map(lambda t: fetch_tile(t, month), tiles):
            for c in result:
                crimes[c["id"]] = c
            done += 1
            if done % 20 == 0 or done == len(tiles):
                print(f"  {done}/{len(tiles)} tiles, {len(crimes):,} crimes so far", flush=True)

    categories, streets = [], []
    cat_idx, street_idx = {}, {}
    groups = {}
    totals = [[0] * 0 for _ in boroughs]
    kept = 0
    for c in crimes.values():
        lat = float(c["location"]["latitude"])
        lng = float(c["location"]["longitude"])
        home = None
        for bi, b in enumerate(boroughs):
            x0, y0, x1, y1 = b["bbox"]
            if x0 <= lng <= x1 and y0 <= lat <= y1 and point_in_polys(lng, lat, b["polys"]):
                home = bi
                break
        if home is None:
            continue
        kept += 1
        cat = c["category"]
        if cat not in cat_idx:
            cat_idx[cat] = len(categories)
            categories.append(cat)
            for t in totals:
                t.append(0)
        street = c["location"]["street"]["name"].replace("On or near ", "")
        if street not in street_idx:
            street_idx[street] = len(streets)
            streets.append(street)
        ci = cat_idx[cat]
        totals[home][ci] += 1
        key = (round((lat - south) * 1e5), round((lng - west) * 1e5), ci)
        g = groups.get(key)
        if g:
            g[3] += 1
        else:
            groups[key] = [key[0], key[1], ci, 1, street_idx[street]]

    for t in totals:
        t.extend([0] * (len(categories) - len(t)))

    data = {
        "month": month,
        "origin": [round(south, 5), round(west, 5)],
        "categories": categories,
        "streets": streets,
        "boroughs": [
            {"code": b["code"], "name": b["name"], "areaKm2": round(b["area"], 2), "byCat": totals[i]}
            for i, b in enumerate(boroughs)
        ],
        "points": list(groups.values()),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "london.js").write_text(
        "window.NW_LONDON = " + json.dumps(data, separators=(",", ":")) + ";\n"
    )
    outlines = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"code": b["code"], "name": b["name"]},
                "geometry": {"type": "MultiPolygon", "coordinates": b["polys"]},
            }
            for b in boroughs
        ],
    }
    (OUT / "boroughs.js").write_text(
        "window.NW_BOROUGHS = " + json.dumps(outlines, separators=(",", ":")) + ";\n"
    )
    print(f"Done: {kept:,} London crimes, {len(groups):,} location groups, month {month}", flush=True)


if __name__ == "__main__":
    main()
