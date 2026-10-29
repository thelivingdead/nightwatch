"""Precompute the Insights panel from the same month as js/data/london.js.

Reads window.NW_LONDON and window.NW_BOROUGHS, then writes js/data/insights.js
as window.NW_INSIGHTS. Numpy is used for the grid, Gi*, PCA and k-means.
No numbers are hardcoded: month, categories and totals come from the data.

Grid rule
  200 m cells in an equirectangular metre plane at latitude 51.5072°
  (central London), matching js/map.js: kx = 111320 * cos(lat0), ky = 110540.
  Grid origin is NW_LONDON.origin (south, west).

Cell universe
  Keep a cell if its centre lies inside any borough polygon (empty water
  drops out). Also keep any cell that contains at least one crime, so
  river-edge snap points are not discarded. Ranking for concentration,
  Gini, Lorenz and Gi* uses this same universe. Empty land cells are
  included and sit at the bottom of the violent-crime ranking.

Neighbours for Gi*
  Distance-weighted, centres within 400 m: the 8 queen-adjacent cells
  plus the 4 cells 400 m north/south/east/west. Self weight = 1.
  Weight for a neighbour is 1/d with d in metres. Off-universe cells
  are skipped. Benjamini–Hochberg FDR at 0.05 on two-tailed p-values;
  the map layer keeps significant cells with z > 0 (hot, not cold).
"""
from __future__ import annotations

import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "js" / "data"

LAT0 = 51.5072
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110540.0
CELL_M = 200.0
NEIGHBOUR_M = 400.0
FDR_ALPHA = 0.05
RNG_SEED = 42

# Queen (200 m / ~283 m) plus rook at exactly 400 m.
NEIGHBOUR_OFFSETS = []
for di in range(-2, 3):
    for dj in range(-2, 3):
        if di == 0 and dj == 0:
            continue
        dist = math.hypot(di * CELL_M, dj * CELL_M)
        if dist <= NEIGHBOUR_M + 1e-6:
            NEIGHBOUR_OFFSETS.append((di, dj, dist))


def load_js(path: Path, prefix: str):
    text = path.read_text()
    if not text.startswith(prefix):
        raise RuntimeError(f"{path.name} does not start with {prefix!r}")
    body = text[len(prefix):].strip()
    if body.endswith(";"):
        body = body[:-1]
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
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polys(x, y, polys):
    for poly in polys:
        if point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def bin_key(x, y, step=0.02):
    return (int(math.floor(x / step)), int(math.floor(y / step)))


def build_borough_index(features):
    boroughs = []
    bins = defaultdict(list)
    step = 0.02
    for f in features:
        name = f["properties"]["name"]
        code = f["properties"]["code"]
        polys = rings_of(f["geometry"])
        xs = [p[0] for poly in polys for p in poly[0]]
        ys = [p[1] for poly in polys for p in poly[0]]
        bbox = (min(xs), min(ys), max(xs), max(ys))
        rec = {"name": name, "code": code, "polys": polys, "bbox": bbox}
        bi = len(boroughs)
        boroughs.append(rec)
        x0, y0, x1, y1 = bbox
        gx0, gx1 = int(math.floor(x0 / step)) - 1, int(math.floor(x1 / step)) + 1
        gy0, gy1 = int(math.floor(y0 / step)) - 1, int(math.floor(y1 / step)) + 1
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                bins[(gx, gy)].append(bi)
    return boroughs, bins, step


def borough_at(lng, lat, boroughs, bins, step):
    candidates = bins.get(bin_key(lng, lat, step), ())
    for bi in candidates:
        b = boroughs[bi]
        x0, y0, x1, y1 = b["bbox"]
        if x0 <= lng <= x1 and y0 <= lat <= y1 and point_in_polys(lng, lat, b["polys"]):
            return bi
    for bi, b in enumerate(boroughs):
        x0, y0, x1, y1 = b["bbox"]
        if x0 <= lng <= x1 and y0 <= lat <= y1 and point_in_polys(lng, lat, b["polys"]):
            return bi
    return None


def cell_bounds(i, j, south, west):
    x0, x1 = i * CELL_M, (i + 1) * CELL_M
    y0, y1 = j * CELL_M, (j + 1) * CELL_M
    return [
        round(south + y0 / KY, 5),
        round(west + x0 / KX, 5),
        round(south + y1 / KY, 5),
        round(west + x1 / KX, 5),
    ]


def gini_coefficient(values):
    x = np.sort(values.astype(np.float64))
    n = x.size
    total = x.sum()
    if n == 0 or total <= 0:
        return 0.0
    # G = 2 * sum(i * x_i) / (n * sum x) - (n + 1) / n  with i = 1..n on sorted x
    idx = np.arange(1, n + 1, dtype=np.float64)
    return float((2.0 * np.dot(idx, x)) / (n * total) - (n + 1.0) / n)


def lorenz_points(sorted_asc, n_points=41):
    total = float(sorted_asc.sum())
    n = sorted_asc.size
    if n == 0 or total <= 0:
        return [[0.0, 0.0], [1.0, 1.0]]
    cum = np.concatenate(([0.0], np.cumsum(sorted_asc, dtype=np.float64)))
    xs = np.linspace(0.0, 1.0, n_points)
    out = []
    for f in xs:
        k = int(round(f * n))
        out.append([round(float(f), 4), round(float(cum[k] / total), 4)])
    if out[-1] != [1.0, 1.0]:
        out[-1] = [1.0, 1.0]
    out[0] = [0.0, 0.0]
    return out


def share_top(sorted_desc, fraction):
    total = float(sorted_desc.sum())
    if total <= 0:
        return 0.0
    n = sorted_desc.size
    k = max(1, int(math.ceil(fraction * n)))
    return float(sorted_desc[:k].sum() / total)


def bh_mask(p, alpha=FDR_ALPHA):
    n = p.size
    if n == 0:
        return np.zeros(0, dtype=bool)
    order = np.argsort(p)
    ranked = p[order]
    thresh = alpha * (np.arange(1, n + 1, dtype=np.float64) / n)
    below = ranked <= thresh
    accepted = np.zeros(n, dtype=bool)
    if not np.any(below):
        return accepted
    cutoff = ranked[int(np.where(below)[0].max())]
    return p <= cutoff


def two_tailed_p(z):
    # 2 * (1 - Phi(|z|)) = erfc(|z| / sqrt(2)). numpy 2.0 has no np.erfc.
    scale = math.sqrt(2.0)
    out = np.empty(z.size, dtype=np.float64)
    for i, v in enumerate(z):
        out[i] = math.erfc(abs(float(v)) / scale)
    return out


def gi_star(values, neighbours):
    """Getis-Ord Gi* z-scores. neighbours[i] is a list of (j, weight) excluding self."""
    x = values.astype(np.float64)
    n = x.size
    xbar = x.mean()
    s = math.sqrt(max(x.dot(x) / n - xbar * xbar, 0.0))
    z = np.zeros(n, dtype=np.float64)
    if s <= 0 or n < 2:
        return z
    for i in range(n):
        wsum = 1.0
        w2 = 1.0
        wx = x[i]
        for j, w in neighbours[i]:
            wsum += w
            w2 += w * w
            wx += w * x[j]
        numer = wx - xbar * wsum
        denom = s * math.sqrt(max((n * w2 - wsum * wsum) / (n - 1), 0.0))
        z[i] = numer / denom if denom else 0.0
    return z


def kmeans(X, k, rng, n_init=30, max_iter=40):
    n, d = X.shape
    best_inertia = None
    best_labels = None
    for _ in range(n_init):
        centres = np.empty((k, d), dtype=np.float64)
        centres[0] = X[rng.integers(n)]
        closest = np.full(n, np.inf)
        for c in range(1, k):
            dist = ((X - centres[c - 1]) ** 2).sum(axis=1)
            closest = np.minimum(closest, dist)
            tot = float(closest.sum())
            if tot <= 0:
                centres[c] = X[rng.integers(n)]
            else:
                centres[c] = X[rng.choice(n, p=closest / tot)]
        labels = np.zeros(n, dtype=np.int32)
        for _ in range(max_iter):
            dist = ((X[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
            new_labels = dist.argmin(axis=1).astype(np.int32)
            if np.array_equal(new_labels, labels):
                labels = new_labels
                break
            labels = new_labels
            for c in range(k):
                members = X[labels == c]
                if len(members):
                    centres[c] = members.mean(axis=0)
                else:
                    centres[c] = X[rng.integers(n)]
        dist = ((X[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
        inertia = float(dist[np.arange(n), labels].sum())
        if best_inertia is None or inertia < best_inertia:
            best_inertia = inertia
            best_labels = labels.copy()
    return best_labels


def silhouette(X, labels):
    n = len(X)
    k = int(labels.max()) + 1
    if k < 2 or n < k + 1:
        return 0.0
    diff = X[:, None, :] - X[None, :, :]
    dist = np.sqrt((diff ** 2).sum(axis=2))
    np.fill_diagonal(dist, 0.0)
    scores = []
    for i in range(n):
        same = labels == labels[i]
        others = ~same
        same[i] = False
        if not np.any(same) or not np.any(others):
            continue
        a = float(dist[i, same].mean())
        b = min(float(dist[i, labels == c].mean()) for c in range(k) if c != labels[i] and np.any(labels == c))
        denom = max(a, b)
        scores.append(0.0 if denom == 0 else (b - a) / denom)
    return float(np.mean(scores)) if scores else 0.0


def pca_2(X):
    xc = X - X.mean(axis=0, keepdims=True)
    u, s, _vt = np.linalg.svd(xc, full_matrices=False)
    coords = u[:, :2] * s[:2]
    var = (s ** 2)
    total = float(var.sum()) or 1.0
    explained = [float(var[0] / total), float(var[1] / total)]
    return coords, explained


def cosine_sim(a, b):
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def main():
    t0 = time.time()
    london = load_js(DATA / "london.js", "window.NW_LONDON = ")
    outlines = load_js(DATA / "boroughs.js", "window.NW_BOROUGHS = ")
    month = london["month"]
    categories = list(london["categories"])
    streets = london["streets"]
    origin = london["origin"]
    south, west = float(origin[0]), float(origin[1])
    points = london["points"]
    ld_boroughs = london["boroughs"]

    violent_name = "violent-crime"
    if violent_name not in categories:
        match = next((c for c in categories if "violent" in c), None)
        if not match:
            raise RuntimeError(f"No violent category in {categories}")
        print(f"NOTE: violent-crime not found; using {match!r}")
        violent_name = match
    violent_ci = categories.index(violent_name)

    point_total = sum(p[3] for p in points)
    borough_total = sum(sum(b["byCat"]) for b in ld_boroughs)
    if point_total != borough_total:
        raise RuntimeError(f"Point total {point_total} != borough total {borough_total}")

    cat_totals = [0] * len(categories)
    for p in points:
        cat_totals[p[2]] += p[3]
    borough_cat = [0] * len(categories)
    for b in ld_boroughs:
        for i, n in enumerate(b["byCat"]):
            borough_cat[i] += n
    if borough_cat != cat_totals:
        raise RuntimeError("Category totals from points and boroughs do not match")

    violent_total = cat_totals[violent_ci]
    ranked_types = sorted(range(len(categories)), key=lambda i: cat_totals[i], reverse=True)
    top5 = [
        {
            "category": categories[i],
            "n": int(cat_totals[i]),
            "pct": round(100.0 * cat_totals[i] / point_total, 2),
        }
        for i in ranked_types[:5]
    ]

    boroughs, bins, step = build_borough_index(outlines["features"])
    if len(boroughs) != 33:
        print(f"NOTE: expected 33 areas, found {len(boroughs)}")

    # Metre bbox from borough vertices and crime points.
    max_i = max_j = 0
    for b in boroughs:
        x0, y0, x1, y1 = b["bbox"]
        max_i = max(max_i, int(math.floor((x1 - west) * KX / CELL_M)) + 1)
        max_j = max(max_j, int(math.floor((y1 - south) * KY / CELL_M)) + 1)

    violent_of = defaultdict(int)
    any_of = defaultdict(int)
    street_of = defaultdict(Counter)
    extra_keys = set()

    for dy, dx, ci, n, si in points:
        lat = south + dy / 1e5
        lng = west + dx / 1e5
        i = int(math.floor((lng - west) * KX / CELL_M))
        j = int(math.floor((lat - south) * KY / CELL_M))
        key = (i, j)
        any_of[key] += n
        extra_keys.add(key)
        if ci == violent_ci:
            violent_of[key] += n
            street_of[key][si] += n
        if i >= 0:
            max_i = max(max_i, i + 1)
        if j >= 0:
            max_j = max(max_j, j + 1)

    land = []
    land_set = set()
    cell_borough = {}
    t_land = time.time()
    for bi, b in enumerate(boroughs):
        x0, y0, x1, y1 = b["bbox"]
        i0 = max(0, int(math.floor((x0 - west) * KX / CELL_M)))
        i1 = int(math.floor((x1 - west) * KX / CELL_M)) + 1
        j0 = max(0, int(math.floor((y0 - south) * KY / CELL_M)))
        j1 = int(math.floor((y1 - south) * KY / CELL_M)) + 1
        for j in range(j0, j1 + 1):
            cy = south + ((j + 0.5) * CELL_M) / KY
            for i in range(i0, i1 + 1):
                key = (i, j)
                if key in land_set:
                    continue
                cx = west + ((i + 0.5) * CELL_M) / KX
                if not (x0 <= cx <= x1 and y0 <= cy <= y1):
                    continue
                if point_in_polys(cx, cy, b["polys"]):
                    land.append(key)
                    land_set.add(key)
                    cell_borough[key] = b["name"]
    print(f"land cells: {len(land):,} in {time.time() - t_land:.1f}s", flush=True)

    universe = list(land)
    for key in extra_keys:
        if key not in land_set and key[0] >= 0 and key[1] >= 0:
            universe.append(key)
            i, j = key
            cx = west + ((i + 0.5) * CELL_M) / KX
            cy = south + ((j + 0.5) * CELL_M) / KY
            bi = borough_at(cx, cy, boroughs, bins, step)
            if bi is None:
                # Fall back to a crime point inside this cell, if any.
                cell_borough[key] = ""
            else:
                cell_borough[key] = boroughs[bi]["name"]

    n_cells = len(universe)
    index_of = {key: idx for idx, key in enumerate(universe)}
    violent = np.zeros(n_cells, dtype=np.int32)
    any_crime = np.zeros(n_cells, dtype=np.int32)
    for key, n in violent_of.items():
        idx = index_of.get(key)
        if idx is not None:
            violent[idx] = n
    for key, n in any_of.items():
        idx = index_of.get(key)
        if idx is not None:
            any_crime[idx] = n

    grid_violent = int(violent.sum())
    dropped_violent = violent_total - grid_violent
    if dropped_violent:
        print(f"NOTE: {dropped_violent} violent crimes fell outside the grid universe")

    sorted_desc = np.sort(violent)[::-1]
    sorted_asc = np.sort(violent)
    top1 = share_top(sorted_desc, 0.01)
    top5_share = share_top(sorted_desc, 0.05)
    top10_share = share_top(sorted_desc, 0.10)
    gini = gini_coefficient(violent)
    lorenz = lorenz_points(sorted_asc)

    neighbours = [[] for _ in range(n_cells)]
    for idx, (i, j) in enumerate(universe):
        for di, dj, dist in NEIGHBOUR_OFFSETS:
            other = index_of.get((i + di, j + dj))
            if other is None:
                continue
            neighbours[idx].append((other, 1.0 / dist))

    z = gi_star(violent, neighbours)
    p = two_tailed_p(z)
    raw_hot = (z > 0) & (p < FDR_ALPHA)
    sig = bh_mask(p, FDR_ALPHA) & (z > 0)
    n_before = int(raw_hot.sum())
    n_after = int(sig.sum())

    hot_idx = np.where(sig)[0]
    order_hot = hot_idx[np.argsort(-z[hot_idx])] if n_after else np.array([], dtype=int)
    packed = []
    for idx in order_hot:
        i, j = universe[int(idx)]
        packed.append(int(i))
        packed.append(int(j))

    top_hot = []
    for idx in order_hot[:10]:
        key = universe[int(idx)]
        i, j = key
        street_idx, _count = (street_of[key].most_common(1)[0] if street_of[key] else (None, 0))
        s, w, n, e = cell_bounds(i, j, south, west)
        name = streets[street_idx] if street_idx is not None else "Unknown"
        bname = cell_borough.get(key) or ""
        if not bname:
            cx = west + ((i + 0.5) * CELL_M) / KX
            cy = south + ((j + 0.5) * CELL_M) / KY
            bi = borough_at(cx, cy, boroughs, bins, step)
            bname = boroughs[bi]["name"] if bi is not None else "London"
        top_hot.append({
            "z": round(float(z[idx]), 2),
            "count": int(violent[idx]),
            "street": name,
            "borough": bname,
            "b": [s, w, n, e],
        })

    # Borough profiles from the published byCat totals (same month).
    london_share = np.array([n / point_total for n in cat_totals], dtype=np.float64)
    profiles = []
    densities = []
    prop = np.zeros((len(ld_boroughs), len(categories)), dtype=np.float64)
    for bi, b in enumerate(ld_boroughs):
        total = int(sum(b["byCat"]))
        area = float(b["areaKm2"])
        dens = total / area if area else 0.0
        densities.append(dens)
        counts = np.array(b["byCat"], dtype=np.float64)
        prop[bi] = counts / counts.sum() if total else 0.0
        bshare = counts / total if total else np.zeros(len(categories))
        lq = np.divide(bshare, london_share, out=np.zeros_like(bshare), where=london_share > 0)
        profiles.append({
            "name": b["name"],
            "code": b["code"],
            "total": total,
            "areaKm2": area,
            "perKm2": round(dens, 1),
            "small": b["name"] == "City of London",
            "lq": [round(float(v), 2) for v in lq],
        })
    dens_rank = np.argsort(np.argsort(-np.array(densities))) + 1
    for bi, row in enumerate(profiles):
        row["densityRank"] = int(dens_rank[bi])

    coords, pca_var = pca_2(prop)
    rng = np.random.default_rng(RNG_SEED)
    sil_scores = {}
    labels_by_k = {}
    for k in range(3, 7):
        labels = kmeans(prop, k, rng)
        sil_scores[k] = round(silhouette(prop, labels), 4)
        labels_by_k[k] = labels
    chosen_k = max(sil_scores, key=sil_scores.get)
    labels = labels_by_k[chosen_k]

    for bi, row in enumerate(profiles):
        row["pca"] = [round(float(coords[bi, 0]), 4), round(float(coords[bi, 1]), 4)]
        row["cluster"] = int(labels[bi])
        sims = []
        for other in range(len(profiles)):
            if other == bi:
                continue
            sims.append((cosine_sim(prop[bi], prop[other]), other))
        sims.sort(reverse=True)
        row["similar"] = [{"i": int(j), "cos": round(float(c), 3)} for c, j in sims[:3]]

    payload = {
        "month": month,
        "violentCategory": violent_name,
        "total": int(point_total),
        "violent": int(violent_total),
        "violentShare": round(100.0 * violent_total / point_total, 2),
        "top5": top5,
        "categories": categories,
        "concentration": {
            "top1": round(100.0 * top1, 2),
            "top5": round(100.0 * top5_share, 2),
            "top10": round(100.0 * top10_share, 2),
            "gini": round(gini, 4),
            "nCells": n_cells,
            "nCellsWithCrime": int((any_crime > 0).sum()),
            "nLand": len(land),
            "universe": (
                "All 200 m cells whose centre is inside a London borough polygon, "
                "plus any cell that contains at least one crime. Empty land is "
                "included; empty water is not. Ranked by violent-crime count."
            ),
            "lorenz": lorenz,
        },
        "grid": {
            "origin": [round(south, 5), round(west, 5)],
            "lat0": LAT0,
            "cellM": CELL_M,
            "kx": round(KX, 4),
            "ky": round(KY, 4),
        },
        "hotCells": packed,
        "topHot": top_hot,
        "boroughs": profiles,
        "k": chosen_k,
        "silhouette": {str(k): sil_scores[k] for k in range(3, 7)},
        "pcaVar": [round(pca_var[0], 4), round(pca_var[1], 4)],
        "neighbours": (
            "Distance-weighted centres within 400 m (8 queen-adjacent plus "
            "4 cells 400 m N/S/E/W). Self weight 1; neighbour weight 1/d metres."
        ),
        "fdr": {"alpha": FDR_ALPHA, "before": n_before, "after": n_after},
    }

    out_path = DATA / "insights.js"
    text = "window.NW_INSIGHTS = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    out_path.write_text(text)
    size = out_path.stat().st_size

    print(f"month: {month}")
    print(f"violent category: {violent_name}")
    print(f"London total crimes: {point_total:,} (points) = {borough_total:,} (boroughs)")
    print(f"violent: {violent_total:,} ({100.0 * violent_total / point_total:.2f}%)")
    print(f"grid cells used: {n_cells:,} (land centres {len(land):,}; with any crime {(any_crime > 0).sum():,})")
    print(f"violent in grid: {grid_violent:,}")
    print(f"top 1/5/10% cells: {100*top1:.2f}% / {100*top5_share:.2f}% / {100*top10_share:.2f}% of violent crime")
    print(f"Gini: {gini:.4f}")
    print(f"Gi* significant hot (z>0): before FDR {n_before}, after FDR {n_after}")
    print(f"neighbour definition: {payload['neighbours']}")
    print(f"chosen k={chosen_k}; silhouette {sil_scores}")
    print(f"PCA explained variance: {pca_var[0]:.4f}, {pca_var[1]:.4f}")
    print(f"wrote {out_path} ({size:,} bytes) in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
