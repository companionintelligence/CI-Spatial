#!/usr/bin/env python3
"""Floor-plan extraction worker (stdlib + numpy only).

Reads a LingBot-Map point cloud (binary_little_endian PLY, xyz float32 +
optional rgb uchar — the exact layout lingbot_map_ply.ts documents), estimates
floor/ceiling heights from a height histogram, rasterises the wall band into a
2D occupancy grid, fits dominant wall segments with a seeded RANSAC, snaps
near-rectilinear walls to the dominant frame, closes a room polygon where
possible, and emits a JSON plan + a dimensioned SVG.

Everything is deterministic (fixed RNG seed, no timestamps in outputs) so the
driver tests can re-run it and diff. Output is derived, not survey-grade.

Usage:
  floor_plan_worker.py --ply cloud.ply --out-json plan.json --out-svg plan.svg
                       [--min-wall-m 0.5] [--grid-cell-m 0.02] [--up-axis auto]
"""
import argparse
import json
import math
import sys

import numpy as np

DISCLAIMER = "derived, not survey-grade"
RNG_SEED = 12345
AXES = ("x", "y", "z")


# ── PLY parsing ───────────────────────────────────────────────────────────────

def read_lingbot_ply(path):
    """Parse the LingBot-Map binary-LE PLY layout: float x/y/z (+ uchar rgb)."""
    with open(path, "rb") as f:
        data = f.read()
    marker = b"end_header\n"
    end = data.find(marker)
    if end < 0:
        raise ValueError("PLY: missing end_header")
    header = data[:end].decode("ascii", "replace").splitlines()
    if not header or header[0].strip() != "ply":
        raise ValueError("PLY: missing magic")
    if not any(l.strip().startswith("format binary_little_endian") for l in header):
        raise ValueError("PLY: only binary_little_endian is supported")
    count = 0
    props = []
    for line in header:
        line = line.strip()
        if line.startswith("element vertex "):
            count = int(line.split()[-1])
        elif line.startswith("property "):
            parts = line.split()
            if len(parts) == 3:
                props.append((parts[1], parts[2]))
    if props[:3] != [("float", "x"), ("float", "y"), ("float", "z")]:
        raise ValueError("PLY: expected float x/y/z as the leading properties")
    has_rgb = props[3:6] == [("uchar", "red"), ("uchar", "green"), ("uchar", "blue")]
    stride = 15 if has_rgb else 12
    body = data[end + len(marker):]
    if len(body) < count * stride:
        raise ValueError(f"PLY: truncated body ({len(body)} bytes for {count} vertices)")
    raw = np.frombuffer(body[: count * stride], dtype=np.uint8).reshape(count, stride)
    xyz = raw[:, :12].copy().view("<f4").reshape(count, 3).astype(np.float64)
    finite = np.isfinite(xyz).all(axis=1)
    return xyz[finite]


# ── Geometry helpers ──────────────────────────────────────────────────────────

def pick_up_axis(xyz, requested):
    """The vertical axis of an indoor scan has the smallest robust span."""
    if requested in AXES:
        return AXES.index(requested)
    spans = [np.percentile(xyz[:, i], 98) - np.percentile(xyz[:, i], 2) for i in range(3)]
    return int(np.argmin(spans))


def estimate_floor_ceiling(heights, bin_m=0.02):
    """Peak bins of the height histogram in the lower/upper thirds."""
    lo, hi = np.percentile(heights, 0.5), np.percentile(heights, 99.5)
    if hi - lo < 0.2:
        return float(lo), float(hi)
    bins = max(8, int(math.ceil((hi - lo) / bin_m)))
    counts, edges = np.histogram(heights, bins=bins, range=(lo, hi))
    centers = (edges[:-1] + edges[1:]) / 2
    third = max(1, len(counts) // 3)
    floor_z = float(centers[np.argmax(counts[:third])])
    ceil_z = float(centers[2 * third + np.argmax(counts[2 * third:])])
    if ceil_z - floor_z < 0.5:
        return float(lo), float(hi)
    return floor_z, ceil_z


def occupancy_grid(uv, cell):
    """2cm occupancy grid over the wall band, outlier-trimmed at p1/p99."""
    u0, u1 = np.percentile(uv[:, 0], 1), np.percentile(uv[:, 0], 99)
    v0, v1 = np.percentile(uv[:, 1], 1), np.percentile(uv[:, 1], 99)
    # Cap grid dims: widen the cell if the trimmed extent is enormous.
    max_cells = 4096
    span = max(u1 - u0, v1 - v0, cell)
    if span / cell > max_cells:
        cell = span / max_cells
    nu = max(4, int(math.ceil((u1 - u0) / cell)) + 1)
    nv = max(4, int(math.ceil((v1 - v0) / cell)) + 1)
    inside = (uv[:, 0] >= u0) & (uv[:, 0] <= u1) & (uv[:, 1] >= v0) & (uv[:, 1] <= v1)
    pts = uv[inside]
    iu = np.clip(((pts[:, 0] - u0) / cell).astype(np.int64), 0, nu - 1)
    iv = np.clip(((pts[:, 1] - v0) / cell).astype(np.int64), 0, nv - 1)
    counts = np.zeros((nu, nv), dtype=np.int32)
    np.add.at(counts, (iu, iv), 1)
    nonzero = counts[counts > 0]
    if nonzero.size == 0:
        return np.zeros((nu, nv), dtype=bool), (u0, v0), cell
    thr = max(2, int(round(0.25 * np.percentile(nonzero, 95))))
    return counts >= thr, (u0, v0), cell


def _shift_or(mask):
    """3x3 dilation via shifted ORs."""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    out[1:, 1:] |= mask[:-1, :-1]
    out[:-1, :-1] |= mask[1:, 1:]
    out[1:, :-1] |= mask[:-1, 1:]
    out[:-1, 1:] |= mask[1:, :-1]
    return out


def _neighbor_count(mask):
    m = mask.astype(np.int8)
    n = np.zeros_like(m, dtype=np.int16)
    n[1:, :] += m[:-1, :]
    n[:-1, :] += m[1:, :]
    n[:, 1:] += m[:, :-1]
    n[:, :-1] += m[:, 1:]
    n[1:, 1:] += m[:-1, :-1]
    n[:-1, :-1] += m[1:, 1:]
    n[1:, :-1] += m[:-1, 1:]
    n[:-1, 1:] += m[1:, :-1]
    return n


def morph_cleanup(mask):
    """Binary closing (dilate→erode via neighbor counts) + prune isolated cells."""
    dilated = _shift_or(mask)
    closed = dilated & (_neighbor_count(dilated) >= 5)
    return closed & (_neighbor_count(closed) >= 2)


def extract_walls(cells_m, min_wall_m, tol=0.05, max_walls=32):
    """Greedy RANSAC line fits on occupied-cell centers (meters). Deterministic."""
    rng = np.random.default_rng(RNG_SEED)
    remaining = cells_m
    walls = []
    while len(walls) < max_walls and remaining.shape[0] >= 30:
        best_inliers = None
        for _ in range(400):
            i, j = rng.integers(0, remaining.shape[0], size=2)
            if i == j:
                continue
            p, q = remaining[i], remaining[j]
            d = q - p
            norm = np.hypot(d[0], d[1])
            if norm < min_wall_m * 0.5:
                continue
            d = d / norm
            normal = np.array([-d[1], d[0]])
            dist = np.abs((remaining - p) @ normal)
            inliers = dist < tol
            if best_inliers is None or inliers.sum() > best_inliers.sum():
                best_inliers = inliers
        if best_inliers is None or best_inliers.sum() < 30:
            break
        pts = remaining[best_inliers]
        # PCA refine: direction = principal eigenvector of the inlier scatter.
        center = pts.mean(axis=0)
        cov = np.cov((pts - center).T)
        eigval, eigvec = np.linalg.eigh(cov)
        direction = eigvec[:, np.argmax(eigval)]
        t = (pts - center) @ direction
        order = np.argsort(t)
        t_sorted = t[order]
        # Longest contiguous run: a line fit must not bridge >0.3m gaps.
        gaps = np.where(np.diff(t_sorted) > 0.3)[0]
        starts = np.concatenate(([0], gaps + 1))
        ends = np.concatenate((gaps, [len(t_sorted) - 1]))
        run = np.argmax(t_sorted[ends] - t_sorted[starts])
        t_lo, t_hi = t_sorted[starts[run]], t_sorted[ends[run]]
        length = float(t_hi - t_lo)
        # Consume the run's inliers whether or not the segment qualifies, so a
        # rejected short blob cannot stall the loop.
        run_mask = best_inliers.copy()
        run_mask[best_inliers] = (t >= t_lo - 0.1) & (t <= t_hi + 0.1)
        remaining = remaining[~run_mask]
        if length >= min_wall_m:
            a = center + direction * t_lo
            b = center + direction * t_hi
            walls.append({"a": a, "b": b, "length": length})
    walls.sort(key=lambda w: -w["length"])
    return walls


def snap_rectilinear(walls, snap_deg=7.0):
    """Snap walls within snap_deg of the dominant frame to exact 0/90."""
    if not walls:
        return walls, 0.0
    # Dominant orientation: length-weighted circular mean over angle*4 (mod 90°).
    ang4 = []
    weights = []
    for w in walls:
        d = w["b"] - w["a"]
        ang4.append(4.0 * math.atan2(d[1], d[0]))
        weights.append(w["length"])
    weights = np.array(weights)
    theta0 = math.atan2(
        float(np.sum(weights * np.sin(ang4))),
        float(np.sum(weights * np.cos(ang4))),
    ) / 4.0
    snap_rad = math.radians(snap_deg)
    for w in walls:
        d = w["b"] - w["a"]
        ang = math.atan2(d[1], d[0])
        # Angular distance to the nearest member of the θ0 + k·90° family.
        delta = (ang - theta0) % (math.pi / 2)
        if min(delta, math.pi / 2 - delta) <= snap_rad:
            k = round((ang - theta0) / (math.pi / 2))
            snapped = theta0 + k * (math.pi / 2)
            mid = (w["a"] + w["b"]) / 2
            half = w["length"] / 2
            dir_s = np.array([math.cos(snapped), math.sin(snapped)])
            w["a"] = mid - dir_s * half
            w["b"] = mid + dir_s * half
            w["snapped"] = True
        else:
            w["snapped"] = False
    return walls, theta0


def convex_hull(points):
    """Andrew monotone chain on an (N,2) array; returns hull vertices CCW."""
    pts = sorted({(round(float(p[0]), 4), round(float(p[1]), 4)) for p in points})
    if len(pts) < 3:
        return [list(p) for p in pts]
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(p) for p in lower[:-1] + upper[:-1]]


def polygon_area(poly):
    if len(poly) < 3:
        return 0.0
    a = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def polygon_perimeter(poly):
    if len(poly) < 2:
        return 0.0
    return float(sum(
        math.hypot(poly[(i + 1) % len(poly)][0] - poly[i][0],
                   poly[(i + 1) % len(poly)][1] - poly[i][1])
        for i in range(len(poly))
    ))


def close_room(walls, theta0, cells_m):
    """Rectilinear rectangle from the wall extremes; convex hull fallback."""
    rot = np.array([
        [math.cos(-theta0), -math.sin(-theta0)],
        [math.sin(-theta0), math.cos(-theta0)],
    ])
    along, across = [], []  # offsets of walls parallel to each frame axis
    for w in walls:
        if not w.get("snapped"):
            continue
        a, b = rot @ w["a"], rot @ w["b"]
        d = b - a
        if abs(d[0]) >= abs(d[1]):
            along.append(((a[1] + b[1]) / 2, w["length"]))
        else:
            across.append(((a[0] + b[0]) / 2, w["length"]))
    def extremes(offsets):
        if len(offsets) < 2:
            return None
        vals = [o for o, _ in offsets]
        if max(vals) - min(vals) < 1.0:
            return None
        return min(vals), max(vals)
    ys = extremes(along)
    xs = extremes(across)
    if xs and ys:
        inv = rot.T
        corners = [
            inv @ np.array([xs[0], ys[0]]),
            inv @ np.array([xs[1], ys[0]]),
            inv @ np.array([xs[1], ys[1]]),
            inv @ np.array([xs[0], ys[1]]),
        ]
        poly = [[float(c[0]), float(c[1])] for c in corners]
        return poly, "rectilinear"
    if cells_m.shape[0] >= 3:
        step = max(1, cells_m.shape[0] // 5000)
        hull = convex_hull(cells_m[::step])
        if polygon_area(hull) > 2.0:
            return hull, "convex-hull"
    return None, None


# ── SVG rendering ─────────────────────────────────────────────────────────────

def render_svg(walls, rooms, bounds):
    scale = 100.0  # px per meter
    pad = 60.0
    (u0, v0), (u1, v1) = bounds
    w_px = (u1 - u0) * scale + 2 * pad
    h_px = (v1 - v0) * scale + 2 * pad

    def X(u):
        return (u - u0) * scale + pad

    def Y(v):
        return (v1 - v) * scale + pad  # flip: plan v grows up, SVG y grows down

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w_px:.0f} {h_px:.0f}" '
        f'font-family="Helvetica, Arial, sans-serif">',
        f'<rect width="{w_px:.0f}" height="{h_px:.0f}" fill="#fbfbf8"/>',
    ]
    # 1m grid
    gu = math.floor(u0)
    while gu <= math.ceil(u1):
        parts.append(f'<line x1="{X(gu):.1f}" y1="{Y(v0):.1f}" x2="{X(gu):.1f}" y2="{Y(v1):.1f}" '
                     f'stroke="#e2e6e2" stroke-width="1"/>')
        gu += 1
    gv = math.floor(v0)
    while gv <= math.ceil(v1):
        parts.append(f'<line x1="{X(u0):.1f}" y1="{Y(gv):.1f}" x2="{X(u1):.1f}" y2="{Y(gv):.1f}" '
                     f'stroke="#e2e6e2" stroke-width="1"/>')
        gv += 1
    # Rooms: translucent mint fill
    for room in rooms:
        pts = " ".join(f"{X(x):.1f},{Y(y):.1f}" for x, y in room["polygon"])
        parts.append(f'<polygon points="{pts}" fill="#8fe3bd" fill-opacity="0.35" '
                     f'stroke="#2f8f6b" stroke-width="1.5"/>')
    # Walls: dark strokes
    for w in walls:
        parts.append(f'<line x1="{X(w["x1"]):.1f}" y1="{Y(w["y1"]):.1f}" '
                     f'x2="{X(w["x2"]):.1f}" y2="{Y(w["y2"]):.1f}" '
                     f'stroke="#23262b" stroke-width="6" stroke-linecap="round"/>')
    # Dimension labels on the longest walls
    for w in sorted(walls, key=lambda w: -w["lengthM"])[:4]:
        mx = (X(w["x1"]) + X(w["x2"])) / 2
        my = (Y(w["y1"]) + Y(w["y2"])) / 2
        ang = math.degrees(math.atan2(Y(w["y2"]) - Y(w["y1"]), X(w["x2"]) - X(w["x1"])))
        if ang > 90 or ang < -90:
            ang += 180
        parts.append(f'<text x="{mx:.1f}" y="{my - 10:.1f}" font-size="15" fill="#37414b" '
                     f'text-anchor="middle" transform="rotate({ang:.1f} {mx:.1f} {my:.1f})">'
                     f'{w["lengthM"]:.2f} m</text>')
    # North arrow placeholder (orientation is unreferenced until geo-aligned)
    nx, ny = w_px - 34, 44
    parts.append(f'<g stroke="#37414b" fill="#37414b">'
                 f'<line x1="{nx}" y1="{ny + 16}" x2="{nx}" y2="{ny - 10}" stroke-width="2"/>'
                 f'<polygon points="{nx - 5},{ny - 8} {nx + 5},{ny - 8} {nx},{ny - 20}"/>'
                 f'<text x="{nx}" y="{ny + 32}" font-size="13" text-anchor="middle" stroke="none">N</text></g>')
    # Scale bar: 1 m
    sx, sy = pad, h_px - 24
    parts.append(f'<line x1="{sx}" y1="{sy}" x2="{sx + scale}" y2="{sy}" stroke="#23262b" stroke-width="3"/>')
    parts.append(f'<line x1="{sx}" y1="{sy - 5}" x2="{sx}" y2="{sy + 5}" stroke="#23262b" stroke-width="2"/>')
    parts.append(f'<line x1="{sx + scale}" y1="{sy - 5}" x2="{sx + scale}" y2="{sy + 5}" stroke="#23262b" stroke-width="2"/>')
    parts.append(f'<text x="{sx + scale / 2:.1f}" y="{sy - 8}" font-size="13" fill="#37414b" text-anchor="middle">1 m</text>')
    parts.append(f'<text x="{w_px - 12:.1f}" y="{h_px - 12:.1f}" font-size="11" fill="#9aa3ab" '
                 f'text-anchor="end">{DISCLAIMER}</text>')
    parts.append("</svg>")
    return "\n".join(parts)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Floor-plan extraction from a LingBot-Map point cloud")
    ap.add_argument("--ply", required=True, help="binary-LE PLY (xyz float32 + optional rgb uchar)")
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--out-svg", required=True)
    ap.add_argument("--min-wall-m", type=float, default=0.5)
    ap.add_argument("--grid-cell-m", type=float, default=0.02)
    ap.add_argument("--up-axis", choices=["auto", "x", "y", "z"], default="auto")
    args = ap.parse_args()

    xyz = read_lingbot_ply(args.ply)
    if xyz.shape[0] < 100:
        print(f"floor-plan: too few points ({xyz.shape[0]})", file=sys.stderr)
        sys.exit(2)

    up = pick_up_axis(xyz, args.up_axis)
    horiz = [i for i in range(3) if i != up]
    heights = xyz[:, up]
    floor_z, ceil_z = estimate_floor_ceiling(heights)
    band_lo, band_hi = floor_z + 0.4, ceil_z - 0.3
    if band_hi <= band_lo:  # low-ceiling / degenerate scan: use the middle half
        band_lo = floor_z + 0.25 * (ceil_z - floor_z)
        band_hi = floor_z + 0.75 * (ceil_z - floor_z)
    band = xyz[(heights >= band_lo) & (heights <= band_hi)]

    walls_out, rooms_out = [], []
    grid_cell = args.grid_cell_m
    if band.shape[0] >= 100:
        occ, origin, grid_cell = occupancy_grid(band[:, horiz], args.grid_cell_m)
        occ = morph_cleanup(occ)
        cells = np.argwhere(occ)
        if cells.shape[0] >= 30:
            cells_m = cells.astype(np.float64) * grid_cell + np.array(origin) + grid_cell / 2
            # Bound the RANSAC cost on huge (outdoor/degenerate) scans: a 2cm
            # grid keeps a deterministic stride subsample line-accurate.
            fit_cells = cells_m
            if fit_cells.shape[0] > 60000:
                fit_cells = fit_cells[::int(math.ceil(fit_cells.shape[0] / 60000))]
            walls, theta0 = snap_rectilinear(extract_walls(fit_cells, args.min_wall_m))
            for w in walls:
                walls_out.append({
                    "x1": round(float(w["a"][0]), 3),
                    "y1": round(float(w["a"][1]), 3),
                    "x2": round(float(w["b"][0]), 3),
                    "y2": round(float(w["b"][1]), 3),
                    "lengthM": round(w["length"], 3),
                })
            poly, method = close_room(walls, theta0, cells_m)
            if poly:
                rooms_out.append({
                    "polygon": [[round(x, 3), round(y, 3)] for x, y in poly],
                    "areaM2": round(polygon_area(poly), 2),
                    "method": method,
                })

    area = round(sum(r["areaM2"] for r in rooms_out), 2)
    perimeter = round(sum(polygon_perimeter(r["polygon"]) for r in rooms_out), 2)
    plan = {
        "schemaVersion": 1,
        "tool": "floor-plan-worker",
        "disclaimer": DISCLAIMER,
        "upAxis": AXES[up],
        "gridCellM": round(grid_cell, 4),
        "floorZ": round(floor_z, 3),
        "ceilingZ": round(ceil_z, 3),
        "ceilingHeightM": round(ceil_z - floor_z, 3),
        "areaM2": area,
        "perimeterM": perimeter,
        "wallCount": len(walls_out),
        "walls": walls_out,
        "rooms": rooms_out,
        "pointCount": int(xyz.shape[0]),
        "bandPointCount": int(band.shape[0]),
        "params": {"minWallM": args.min_wall_m},
    }

    # SVG bounds: everything drawable, else a 1m placeholder square.
    xs = [w["x1"] for w in walls_out] + [w["x2"] for w in walls_out] + \
        [p[0] for r in rooms_out for p in r["polygon"]]
    ys = [w["y1"] for w in walls_out] + [w["y2"] for w in walls_out] + \
        [p[1] for r in rooms_out for p in r["polygon"]]
    if xs and ys:
        bounds = ((min(xs) - 0.3, min(ys) - 0.3), (max(xs) + 0.3, max(ys) + 0.3))
    else:
        bounds = ((0.0, 0.0), (1.0, 1.0))
    svg = render_svg(walls_out, rooms_out, bounds)

    with open(args.out_json, "w") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")
    with open(args.out_svg, "w") as f:
        f.write(svg)
        f.write("\n")
    print(f"floor-plan: {len(walls_out)} walls, {area} m2, ceiling {plan['ceilingHeightM']} m")


if __name__ == "__main__":
    main()
