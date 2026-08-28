/**
 * Lift a 2D panoptic segment to a 3D world position against a point cloud.
 *
 * Pure geometry + a confidence policy. No `Deno.*`, no DOM, no `three` — this
 * file is imported by the Deno driver (`server/panoptic/panoptic_lift.ts`) and
 * must stay importable by the browser too, per ADR 0002. Vectors are plain
 * `{x,y,z}` objects and the cloud is a `Float32Array` + count, which is the
 * shape both runtimes already have (`PointCloud.toFloat32Array()` in the
 * browser, a glTF POSITION accessor array on the server).
 *
 * ── Why this is not `src/spatial/resolver.ts`'s `raycastPointCloud` ──────────
 *
 * That function (resolver.ts:134-182, the live resolver's tier-3 fallback)
 * collects every cloud point within a FIXED 0.25 m perpendicular cylinder of
 * the ray between 0.5 m and 5.0 m, and returns whichever is most nearly
 * collinear with the ray. Both halves of that policy were measured against
 * this repo's own data and both are wrong for a panoptic segment:
 *
 *   Measured on session sess-a7e2f642 (5330-point cloud from
 *   1787816555017_autosave-room-scan-2026-08-27T07-42-36.glb, 50 thing
 *   segments across 8 keyframes):
 *
 *   - It returned a confident position for 50 of 50 segments. A scan whose own
 *     session.json reports coverageScore 0.0027 and status 'needs-rescan' does
 *     not contain 50 answerable questions; a policy that never abstains is not
 *     measuring anything.
 *   - A 0.25 m cylinder is a 28-degree cone at 0.5 m and a 2.9-degree cone at
 *     5 m — it over-collects near the camera and under-collects far from it,
 *     with no relation to how big the segment actually is on screen.
 *   - Min-perpendicular-wins picks the most collinear point inside a 4.5 m-deep
 *     tube, which is noise, not depth. Against a first-supported-surface depth
 *     it disagreed by more than 1.0 m in 12 of 28 comparable segments
 *     (median 0.50 m, p90 4.63 m, max 4.85 m). e.g. kf-00002 'bag': 173
 *     candidates spanning 0.50-3.68 m, winner at 0.74 m, first supported
 *     surface at 5.52 m.
 *
 * So this module replaces both halves:
 *
 *   - the cylinder becomes the segment's OWN angular footprint, derived from
 *     `areaPx` — information a panoptic mask has and a VLM bounding box never
 *     did; and
 *   - min-perpendicular becomes "the nearest depth cluster with enough
 *     support", i.e. the first opaque surface, with an explicit abstention when
 *     no cluster qualifies or two of them disagree.
 *
 * `resolver.ts`'s copy is deliberately left in place for now: that file is the
 * live browser resolver and is owned by other work. Once it is free, its tier 3
 * should call `liftSegment` here rather than keeping a second depth policy —
 * two policies for "which point is this" is exactly the duplication ADR 0001
 * exists to stop.
 *
 * ── Why abstention is the point, not a shortcoming ───────────────────────────
 *
 * A gimbal dome capture rotates in place. `server/panoptic/panoptic_lift.ts`
 * measured this session's real translation: max pairwise camera baseline
 * 0.881 m over 17 keyframes, most of it vertical. A true in-place dome gives
 * zero baseline and therefore zero parallax, and a single-view ray through an
 * empty cloud has no depth in it at all. Returning a number anyway would be
 * fabrication. Every undetermined result here carries a `reason`, and the
 * driver writes it to the sidecar with `worldPos: null` — which
 * `detectionsFromMeta` (server/main.ts) already drops, so it can never become
 * a Thing by an existing rule rather than a new one.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A camera to cast from: pose plus the lens the centroid pixels are in. */
export interface LiftCamera {
  /**
   * Row-major 4x4 camera-to-world, OpenGL/Blender convention (+X right,
   * +Y up, camera looks down -Z). This is exactly what
   * `poseToMatrix()` in server/splat/splat_train_dataset.ts produces, so the
   * driver reuses that rather than re-deriving a rotation here.
   */
  cameraToWorld: readonly (readonly number[])[]
  /** Focal length in pixels, in the SAME pixel frame as `centroidPx`. */
  flX: number
  flY: number
  /** Principal point in that same pixel frame. */
  cx: number
  cy: number
}

export interface LiftSegmentInput {
  camera: LiftCamera
  /** Mask centroid, source-frame pixels, +x right and +y DOWN (image order). */
  centroidPx: readonly [number, number]
  /** Mask area in those same pixels — the segment's angular footprint. */
  areaPx: number
  /** The model's own mean softmax for the segment, 0..1. */
  segScore: number
  /**
   * Mask extent `[x0, y0, x1, y1]` inclusive, when the worker reported one.
   * Optional: a segments file written before the worker emitted it still lifts,
   * on the `areaPx` fallback described at `coneHalfAngle`.
   */
  bboxPx?: readonly [number, number, number, number]
  /**
   * Whether the centroid pixel is actually inside the mask. Optional for the
   * same back-compat reason; `undefined` is treated as "not reported", never as
   * false.
   */
  centroidOnMask?: boolean
}

/**
 * Why a lift produced no position. Every one of these is a real, observed
 * state rather than an error: a sparse scan is *expected* to yield mostly
 * 'no-geometry' and 'unsupported'.
 */
export type LiftReason =
  /**
   * The frame carried no capture pose, so no ray could be cast.
   *
   * Never produced by `liftSegment` — a segment only reaches it once a camera
   * exists. The driver raises it when the segment's frame has no
   * `keyframes.jsonl` record with a pose, and it lives in this union so a
   * reader of the sidecar has ONE list of reasons rather than two.
   */
  | 'no-pose'
  /** The camera matrix was missing or not a usable rigid transform. */
  | 'degenerate-camera'
  /**
   * The centroid pixel is not on the mask, so the ray misses the object.
   *
   * A mean of the mask's pixel coordinates is not a point of the mask when the
   * mask is concave or in two parts. Measured on sess-a7e2f642: 2 of 50 thing
   * segments, both 'bed', whose masks are U-shaped around a foreground
   * occluder — the centroid lands in the notch and the ray goes past the bed
   * entirely.
   */
  | 'centroid-off-mask'
  /** No cloud point fell inside the segment's cone at all. */
  | 'no-geometry'
  /** Points were there, but no depth cluster reached MIN_CLUSTER_POINTS. */
  | 'unsupported'
  /** The nearest supported cluster is smeared wider than MAX_CLUSTER_SPREAD_M. */
  | 'depth-ambiguous'
  /** Two comparably-supported surfaces more than MULTI_SURFACE_GAP_M apart. */
  | 'multi-surface'
  /** Determinate, but the confidence product fell under MIN_CONFIDENCE. */
  | 'low-confidence'

export interface LiftDebug {
  /** The cone this segment subtends, degrees. Derived from areaPx. */
  coneHalfAngleDeg: number
  /** Cloud points inside the cone within the depth window. */
  conePoints: number
  /** Points in the winning cluster (0 when none qualified). */
  clusterPoints: number
  /** Depth of the winning cluster along the ray, metres. */
  depthM: number | null
  /** Standard deviation of that cluster's depths, metres. */
  spreadM: number | null
  /** Confidence as computed, even when the gate rejected it. */
  rawConfidence: number | null
}

export interface LiftResult {
  /** World-space position, or null when the lift is undetermined. */
  worldPos: Vec3 | null
  /** 0..1. Null exactly when `worldPos` is null. */
  confidence: number | null
  /** Present exactly when `worldPos` is null. */
  reason?: LiftReason
  debug: LiftDebug
}

/**
 * Depth window, metres. Both bounds are lifted verbatim from
 * `raycastPointCloud`'s `minDepth`/`maxDepth` and `MAX_HIT_DISTANCE_M`
 * (src/spatial/resolver.ts:28-57), because the failures that set them are the
 * same failures at a different stage: an unbounded hit put a sofa 23 m away and
 * a monitor 4.7 m in the air on a sparsely-tracked room scan.
 *
 * Independently supported by this cloud: nearest-camera distance across its
 * 5330 points is p50 4.24 m, p90 14.19 m, max 49.47 m — only 61% of the cloud
 * is inside 5 m of any camera at all. Points beyond that are drift and stray
 * far-field returns, not room surfaces.
 */
export const MIN_DEPTH_M = 0.5
export const MAX_DEPTH_M = 5.0

/**
 * Ceiling on the cone a segment may subtend, radians (~14 degrees).
 *
 * Measured on the 50 thing segments of sess-a7e2f642, the footprint half-angle
 * `atan(sqrt(areaPx/pi) / flY)` spans 2.1-7.7 degrees, so this bound is inert
 * for ordinary objects. It exists for the pathological case the same formula
 * allows: a segment covering a third of the frame implies a 19-degree cone,
 * which at 5 m is a 1.7 m-radius disc — that is not a ray through an object any
 * more, it is a search of the whole room, and every point it swept up would be
 * called "support". Clamping keeps a huge mask from manufacturing a cluster.
 */
export const MAX_CONE_HALF_ANGLE_RAD = 0.25

/**
 * Depth gap that separates two surfaces, metres.
 *
 * Cluster boundaries, not a smoothing radius: consecutive depths further apart
 * than this are treated as different surfaces. 0.30 m is deliberately below
 * `THING_MATCH_RADIUS_M` (0.75 m, server/thing_match.ts) — two surfaces closer
 * together than the fusion radius would land as one Thing anyway, so splitting
 * them finer buys nothing.
 */
export const CLUSTER_GAP_M = 0.3

/**
 * Minimum points before a depth cluster counts as a surface.
 *
 * On this cloud a genuine surface hit brings tens of points: the four segments
 * that lift cleanly carry 13, 24, 27 and 29, at 0.59-1.00 of their cone. A run
 * of 2-3 points inside a narrow cone is indistinguishable from SLAM noise, and
 * the whole point of this module is not to dress noise up as a position.
 *
 * This bound is what a sparse cloud runs out of first, by construction, and
 * that is the intended behaviour: a 3-degree cone at 4 m subtends about
 * 0.14 m², so needing 12 points in it asks for roughly 90 points/m² of surface.
 * sess-a7e2f642's 5330 points over a 5.9 x 2.5 x 5.9 m room is well under
 * that — which is the same fact its own session.json reports as
 * coverageScore 0.0027 / 'needs-rescan'.
 */
export const MIN_CLUSTER_POINTS = 12

/** A cluster with this many points gets full marks for support. */
export const GOOD_CLUSTER_POINTS = 24

/**
 * Widest a cluster may be spread in depth and still be one surface, metres.
 *
 * Half of CLUSTER_GAP_M plus a little: a run whose points are individually
 * within 0.30 m of a neighbour can still span metres end-to-end (a ray grazing
 * a wall along its length does exactly that), and such a run has a mean depth
 * that describes nothing. This is the gate that catches it.
 */
export const MAX_CLUSTER_SPREAD_M = 0.35

/** Share of the cone's points the winning cluster must hold. */
export const MIN_CLUSTER_FRACTION = 0.3

/**
 * Two supported surfaces further apart than this make the lift ambiguous,
 * metres.
 *
 * Set at 1.0 m because that is the disagreement threshold the old
 * min-perpendicular policy failed at: 12 of 28 comparable segments moved by
 * more than 1.0 m depending on which surface you believed, and the old policy
 * resolved every one of them silently. Here the same situation abstains.
 */
export const MULTI_SURFACE_GAP_M = 1.0

/** A rival cluster this large relative to the winner counts as "comparable". */
export const MULTI_SURFACE_SUPPORT_RATIO = 0.5

/**
 * Confidence floor for a position to be reported at all.
 *
 * The four structural gates above do the real filtering; this is a backstop for
 * combinations that pass each gate individually and are still not worth
 * believing (a low-scoring segment on a barely-supported far cluster).
 *
 * Confidence here is a product of four sub-unit factors, so even a good lift
 * lands well below 1 and this threshold has to be read against the actual
 * population rather than against intuition. Measured: the 11 thing segments of
 * sess-a7e2f642 that clear every structural gate score
 *   0.073 0.074 0.120 0.142 0.154 0.156 0.157 | 0.243 0.312 0.464 0.539
 * — a dense band of seven up to 0.157, then a gap to 0.243. 0.20 sits in it, so
 * any threshold in (0.157, 0.243) gives the identical 4/7 split and the exact
 * value is not load-bearing.
 *
 * There is a wider gap higher up (0.312 -> 0.464), and it is NOT used: chasing
 * the largest gap in 11 samples would set the floor at 0.40 and return two
 * positions from a 50-segment scan, which is overfitting a threshold to noise
 * rather than measuring anything.
 *
 * Stated honestly: n=11 from one sparse session is a weak basis for a
 * threshold, and this is a policy choice placed at a visible break, not a
 * fitted error rate. **Revisit when** a dense scan produces a population big
 * enough to argue with — the driver writes every rejected segment's confidence
 * to the sidecar, so the data to re-fit it is always on disk.
 */
export const MIN_CONFIDENCE = 0.2

/**
 * How much distance alone costs confidence.
 *
 * Not a gate — MAX_DEPTH_M is the gate. This encodes the parallax geometry:
 * with a max pairwise camera baseline of 0.881 m across this session's 17
 * keyframes (mean 0.452 m, and most of that vertical), a surface at 4.5 m is
 * pinned by far less triangulation than one at 1.0 m. 0.5 means "a hit at
 * MAX_DEPTH_M is worth half what the same hit at zero range would be".
 *
 * A prior from the geometry, NOT a measured error curve — and the one
 * cross-frame check this session allows argues mildly against it: the same
 * swivel chairs land at 4.31-4.49 m from kf-00006 and kf-00007, which is
 * consistent, not scattered. Those two rays hit the same cloud points, so that
 * agreement is not independent evidence, but it is the reason this is a soft
 * penalty and not another gate.
 */
export const RANGE_PENALTY = 0.5

/**
 * Floor under the spread factor, so MAX_CLUSTER_SPREAD_M stays the only gate
 * on spread.
 *
 * Without it the factor falls linearly to zero exactly at the gate, which makes
 * `MIN_CONFIDENCE` a second, undocumented spread gate biting well before the
 * documented one: measured, a kf-00007 'swivel chair' with 13 of 17 cone points
 * in a 0.32 m cluster — inside the 0.35 m gate — scored 0.021 purely because
 * the spread factor had collapsed to 0.086. Two gates on one
 * quantity, only one of them written down, is how a threshold stops meaning
 * what its comment says. With the floor that segment scores 0.097 and is still
 * rejected — but now for the reason the numbers actually give (thin support at
 * 4.3 m) rather than a spread cutoff nobody wrote down.
 */
export const SPREAD_FACTOR_FLOOR = 0.3

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Extract the rotation basis and camera centre from a row-major 4x4
 * camera-to-world. Returns null when the matrix is malformed or its basis has
 * collapsed (a zero-scale row makes every ray direction NaN, which would
 * otherwise surface as a silent "no points in cone").
 */
function decomposeCamera(m: LiftCamera['cameraToWorld']): { r: number[][]; origin: Vec3 } | null {
  if (!Array.isArray(m) || m.length < 3) return null
  const rows: number[][] = []
  for (let i = 0; i < 3; i++) {
    const row = m[i]
    if (!Array.isArray(row) || row.length < 4) return null
    const vals = [row[0], row[1], row[2], row[3]]
    if (!vals.every(isFiniteNum)) return null
    rows.push(vals as number[])
  }
  // Basis columns must be unit-ish. A capture quaternion is normalised by
  // poseToMatrix, and a solved pose comes out of an orthonormal inverse, so
  // anything far off 1 here is corruption rather than a legitimate scale.
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(rows[0][c], rows[1][c], rows[2][c])
    if (!(len > 0.5 && len < 2.0)) return null
  }
  return {
    r: [
      [rows[0][0], rows[0][1], rows[0][2]],
      [rows[1][0], rows[1][1], rows[1][2]],
      [rows[2][0], rows[2][1], rows[2][2]],
    ],
    origin: { x: rows[0][3], y: rows[1][3], z: rows[2][3] },
  }
}

export interface CameraRay {
  origin: Vec3
  /** Unit length. */
  direction: Vec3
}

/**
 * Build the world-space ray through a source-frame pixel.
 *
 * Pixel y grows DOWN (image order, which is what the worker's `centroidPx`
 * reports — scripts/panoptic_worker.py takes `ys.mean()` of a numpy mask) while
 * the camera's +Y is UP, hence the sign flip. The -1 on Z is the OpenGL
 * convention the rest of this repo already uses end to end: the exporter, the
 * WebXR poses, and `poseToMatrix`'s "no coordinate flip" note all assume the
 * camera looks down -Z.
 */
export function cameraRay(camera: LiftCamera, px: number, py: number): CameraRay | null {
  if (!isFiniteNum(px) || !isFiniteNum(py)) return null
  if (!(isFiniteNum(camera?.flX) && camera.flX > 0)) return null
  if (!(isFiniteNum(camera?.flY) && camera.flY > 0)) return null
  if (!isFiniteNum(camera?.cx) || !isFiniteNum(camera?.cy)) return null
  const basis = decomposeCamera(camera.cameraToWorld)
  if (!basis) return null

  const xn = (px - camera.cx) / camera.flX
  const yn = -(py - camera.cy) / camera.flY
  const zn = -1

  const dx = basis.r[0][0] * xn + basis.r[0][1] * yn + basis.r[0][2] * zn
  const dy = basis.r[1][0] * xn + basis.r[1][1] * yn + basis.r[1][2] * zn
  const dz = basis.r[2][0] * xn + basis.r[2][1] * yn + basis.r[2][2] * zn
  const len = Math.hypot(dx, dy, dz)
  if (!(len > 0)) return null
  return { origin: basis.origin, direction: { x: dx / len, y: dy / len, z: dz / len } }
}

/**
 * Half-angle of the cone a segment subtends, radians.
 *
 * A cone is circular, so the question is which circle. Two candidates, and the
 * choice between them was measured rather than argued:
 *
 *   - `sqrt(areaPx / pi)` — the radius of the disc with the mask's area. Shape
 *     free, and the only option when the worker reported no bbox.
 *   - `min(w, h) / 2` — the circle inscribed in the mask's bounding box.
 *
 * They agree for a compact object (median ratio 0.90 across sess-a7e2f642's 50
 * thing segments) and disagree badly for an elongated one, where the area disc
 * is far wider than the object is narrow. 10 of those 50 segments have a bbox
 * aspect over 2.5, and the worst cases are the ones that MATTER most here:
 * all three 'curtain' segments — the segments that lifted most confidently —
 * are about 95 x 435 px, giving an area radius of 92 px against an inscribed
 * radius of 46 px. The cone used for them was twice as wide as the curtain, so
 * it was collecting depth from either side of it.
 *
 * So the inscribed radius wins when a bbox is available: it can under-collect
 * on a compact object, which costs support and shows up honestly as
 * 'unsupported', while over-collecting silently mixes background into the
 * cluster and produces a confident wrong depth. Prefer the recoverable error,
 * the same reasoning `splitPanopticSegments` uses for an unknown `isThing`.
 */
export function coneHalfAngle(
  areaPx: number,
  flY: number,
  bboxPx?: readonly [number, number, number, number],
): number {
  if (!isFiniteNum(flY) || flY <= 0) return 0
  let radiusPx: number | null = null
  if (bboxPx && bboxPx.length === 4 && bboxPx.every(isFiniteNum)) {
    const w = bboxPx[2] - bboxPx[0] + 1
    const h = bboxPx[3] - bboxPx[1] + 1
    if (w > 0 && h > 0) radiusPx = Math.min(w, h) / 2
  }
  if (radiusPx === null) {
    if (!isFiniteNum(areaPx) || areaPx <= 0) return 0
    radiusPx = Math.sqrt(areaPx / Math.PI)
  }
  if (!(radiusPx > 0)) return 0
  return Math.min(Math.atan(radiusPx / flY), MAX_CONE_HALF_ANGLE_RAD)
}

interface ConePoint {
  depth: number
  x: number
  y: number
  z: number
}

/**
 * Collect cloud points inside the cone, within the depth window, ordered near
 * to far. `positions` is a flat xyz triple array; `count` is the number of
 * points (not the array length).
 */
export function gatherCone(
  ray: CameraRay,
  positions: Float32Array | readonly number[],
  count: number,
  halfAngleRad: number,
): ConePoint[] {
  const out: ConePoint[] = []
  if (!(count > 0) || !(halfAngleRad > 0)) return out
  const tan = Math.tan(halfAngleRad)
  const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z
  const rx = ray.direction.x, ry = ray.direction.y, rz = ray.direction.z

  for (let i = 0; i < count; i++) {
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]
    if (!isFiniteNum(px) || !isFiniteNum(py) || !isFiniteNum(pz)) continue

    const vx = px - ox, vy = py - oy, vz = pz - oz
    const depth = vx * rx + vy * ry + vz * rz
    if (depth < MIN_DEPTH_M || depth > MAX_DEPTH_M) continue

    const ex = vx - depth * rx, ey = vy - depth * ry, ez = vz - depth * rz
    // Radius of the cone at this depth. Comparing against a depth-scaled radius
    // rather than a constant is the entire difference from the cylinder policy.
    const perp = Math.hypot(ex, ey, ez)
    if (perp > depth * tan) continue

    out.push({ depth, x: px, y: py, z: pz })
  }
  out.sort((a, b) => a.depth - b.depth)
  return out
}

interface DepthCluster {
  points: ConePoint[]
  /** Mean depth along the ray. */
  depth: number
  /** Standard deviation of depths — how much of a "surface" this really is. */
  spread: number
  /** Centroid in world space; the position actually reported. */
  centroid: Vec3
}

/** Split depth-sorted cone points into runs separated by more than CLUSTER_GAP_M. */
export function clusterByDepth(points: readonly ConePoint[]): DepthCluster[] {
  const clusters: DepthCluster[] = []
  let run: ConePoint[] = []
  const flush = () => {
    if (run.length === 0) return
    let sum = 0, sx = 0, sy = 0, sz = 0
    for (const p of run) {
      sum += p.depth
      sx += p.x
      sy += p.y
      sz += p.z
    }
    const mean = sum / run.length
    let varSum = 0
    for (const p of run) varSum += (p.depth - mean) * (p.depth - mean)
    clusters.push({
      points: run,
      depth: mean,
      spread: Math.sqrt(varSum / run.length),
      centroid: { x: sx / run.length, y: sy / run.length, z: sz / run.length },
    })
    run = []
  }
  for (const p of points) {
    if (run.length > 0 && p.depth - run[run.length - 1].depth > CLUSTER_GAP_M) flush()
    run.push(p)
  }
  flush()
  return clusters
}

/**
 * Confidence that the returned position is where the object actually is, 0..1.
 *
 * A product, not an average, and deliberately readable as "probability this is
 * right": four independent things all have to hold. The structural gates in
 * `liftSegment` already removed the outright unusable cases, so these factors
 * grade what survived rather than filtering it.
 */
export function liftConfidence(args: {
  segScore: number
  clusterPoints: number
  conePoints: number
  spreadM: number
  depthM: number
}): number {
  const score = Math.max(0, Math.min(1, args.segScore))
  // Support: how much geometry backs the surface, and how much of the cone it
  // accounts for. The fraction is floored at 0.5 rather than used raw — a
  // cluster holding the gate-minimum 30% of a cone is thinner evidence than one
  // holding all of it, but it is not half-as-likely-again to be wrong.
  const density = Math.min(1, args.clusterPoints / GOOD_CLUSTER_POINTS)
  const fraction = args.conePoints > 0 ? args.clusterPoints / args.conePoints : 0
  const support = density * (0.5 + 0.5 * Math.max(0, Math.min(1, fraction)))
  // Sharpness: a surface 0.35 m thick tells you much less than one 0.05 m
  // thick. Floored at SPREAD_FACTOR_FLOOR rather than run to zero — see there.
  const spreadRatio = Math.max(0, Math.min(1, args.spreadM / MAX_CLUSTER_SPREAD_M))
  const sharpness = 1 - (1 - SPREAD_FACTOR_FLOOR) * spreadRatio
  // Range: see RANGE_PENALTY — the parallax available at 4.5 m on a 0.88 m
  // baseline is not the parallax available at 1 m.
  const range = Math.max(0, Math.min(1, 1 - RANGE_PENALTY * (args.depthM / MAX_DEPTH_M)))
  const c = score * support * sharpness * range
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0
}

/**
 * Lift one segment. Never throws, and never returns a position without a
 * confidence: `worldPos` and `confidence` are null together, and `reason` is
 * present exactly when they are.
 */
export function liftSegment(
  input: LiftSegmentInput,
  positions: Float32Array | readonly number[],
  count: number,
): LiftResult {
  const halfAngle = coneHalfAngle(input.areaPx, input.camera?.flY ?? 0, input.bboxPx)
  const debug: LiftDebug = {
    coneHalfAngleDeg: (halfAngle * 180) / Math.PI,
    conePoints: 0,
    clusterPoints: 0,
    depthM: null,
    spreadM: null,
    rawConfidence: null,
  }

  const ray = cameraRay(input.camera, input.centroidPx?.[0], input.centroidPx?.[1])
  if (!ray || halfAngle <= 0) {
    return { worldPos: null, confidence: null, reason: 'degenerate-camera', debug }
  }

  // Checked before any geometry: if the ray does not pass through the object
  // there is nothing to measure, and the cluster it would find is a real
  // surface at a confidently wrong place. Strict `=== false` so an older
  // segments file, which reports nothing here, is not treated as a failure.
  if (input.centroidOnMask === false) {
    return { worldPos: null, confidence: null, reason: 'centroid-off-mask', debug }
  }

  const cone = gatherCone(ray, positions, count, halfAngle)
  debug.conePoints = cone.length
  if (cone.length === 0) {
    return { worldPos: null, confidence: null, reason: 'no-geometry', debug }
  }

  const clusters = clusterByDepth(cone)
  // Nearest first: the first opaque surface along the ray is the one the camera
  // actually saw. Min-perpendicular had no such notion, which is why it could
  // return a 0.74 m stray for a bag whose surface was at 5.52 m.
  const supported = clusters.filter((c) => c.points.length >= MIN_CLUSTER_POINTS)
  if (supported.length === 0) {
    const best = clusters.reduce((a, b) => (b.points.length > a.points.length ? b : a))
    debug.clusterPoints = best.points.length
    debug.depthM = best.depth
    debug.spreadM = best.spread
    return { worldPos: null, confidence: null, reason: 'unsupported', debug }
  }

  const winner = supported[0]
  debug.clusterPoints = winner.points.length
  debug.depthM = winner.depth
  debug.spreadM = winner.spread

  if (winner.points.length / cone.length < MIN_CLUSTER_FRACTION) {
    // The cone is mostly points that are NOT on this surface — the segment is
    // looking through clutter, and the nearest run is not the answer.
    return { worldPos: null, confidence: null, reason: 'unsupported', debug }
  }
  if (winner.spread > MAX_CLUSTER_SPREAD_M) {
    return { worldPos: null, confidence: null, reason: 'depth-ambiguous', debug }
  }

  const rivalThreshold = winner.points.length * MULTI_SURFACE_SUPPORT_RATIO
  for (const c of supported) {
    if (c === winner) continue
    if (c.points.length >= rivalThreshold && Math.abs(c.depth - winner.depth) > MULTI_SURFACE_GAP_M) {
      return { worldPos: null, confidence: null, reason: 'multi-surface', debug }
    }
  }

  const confidence = liftConfidence({
    segScore: input.segScore,
    clusterPoints: winner.points.length,
    conePoints: cone.length,
    spreadM: winner.spread,
    depthM: winner.depth,
  })
  debug.rawConfidence = confidence
  if (confidence < MIN_CONFIDENCE) {
    return { worldPos: null, confidence: null, reason: 'low-confidence', debug }
  }

  return { worldPos: winner.centroid, confidence, debug }
}
