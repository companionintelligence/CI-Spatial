import type { GeoPose, Vec3 } from './types'

const EARTH_RADIUS_M = 6_378_137
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * Spatial-frame capture parameters for the `'two-point-ground'` calibration
 * tier. They live here rather than in `src/world/types.ts` because that file is
 * types-only (zero runtime exports) and this module already owns the frame math
 * these values parameterise — `anchorToProjectTransform` below.
 *
 * Both are **placeholders pending measurement by wave 09 ticket 0006**, pinned
 * here so ticket 0004's capture flow does not invent its own.
 */

/**
 * Max acceptable deviation, in metres, between a stored landmark→marker
 * separation and the one a later session re-measures.
 *
 * Tighter than the retired 3-point method's one-foot (0.3048 m) default,
 * because a single distance between two deliberately-chosen features is a
 * cleaner measurement than three interdependent ones. But it is a guess: the
 * only empirical spatial-repeatability figure in this repo is
 * `DEDUP_RADIUS_M = 0.4` (`src/spatial/resolver.ts`), widened from 0.3 because
 * same-object captures land 0.3–0.4 m apart. That measures detection placement
 * rather than a direct floor tap, so it is an upper bound rather than a
 * refutation — but it is more than twice this value, so if the real spread
 * exceeds this tolerance the check will fire on correct calibrations.
 */
export const DEFAULT_SEPARATION_TOLERANCE_M = 0.15

/**
 * Minimum landmark→marker baseline, in metres. Enforced by the capture flow
 * (ticket 0004), not by the type.
 *
 * Heading error is roughly hit-test noise divided by separation, so short
 * baselines amplify angular error: two points 20 cm apart with ~3 cm noise give
 * ~8° of heading uncertainty — worse than a decent compass, which defeats the
 * point of the tier. One metre keeps it near 2°. The ~3 cm noise figure is
 * itself assumed; if ticket 0006 measures materially worse hit-test
 * repeatability, this must rise proportionally to hold the same angular error.
 */
export const MIN_POINT_SEPARATION_M = 1.0

export function identityMatrix(): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]
}

export function hasGeoPose(pose: GeoPose | null | undefined): pose is GeoPose & { lat: number; lng: number } {
  return typeof pose?.lat === 'number'
    && typeof pose.lng === 'number'
    && !(pose.lat === 0 && pose.lng === 0)
}

export function geoToEnu(origin: GeoPose, pose: GeoPose): Vec3 {
  if (!hasGeoPose(origin) || !hasGeoPose(pose)) {
    return { x: 0, y: 0, z: 0 }
  }

  const lat0 = origin.lat * DEG_TO_RAD
  const lat = pose.lat * DEG_TO_RAD
  const dLat = lat - lat0
  const dLng = (pose.lng - origin.lng) * DEG_TO_RAD
  const east = dLng * Math.cos((lat + lat0) * 0.5) * EARTH_RADIUS_M
  const north = dLat * EARTH_RADIUS_M
  const up = (pose.altitudeM ?? 0) - (origin.altitudeM ?? 0)

  return { x: east, y: up, z: north }
}

export function distanceM(a: GeoPose, b: GeoPose): number | null {
  if (!hasGeoPose(a) || !hasGeoPose(b)) return null
  const delta = geoToEnu(a, b)
  return Math.sqrt(delta.x ** 2 + delta.z ** 2)
}

export function enuToGeo(origin: GeoPose, local: Vec3): GeoPose {
  if (!hasGeoPose(origin)) {
    return { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
  }

  const lat0 = origin.lat * DEG_TO_RAD
  const lat = origin.lat + (local.z / EARTH_RADIUS_M) * RAD_TO_DEG
  const lng = origin.lng + (local.x / (EARTH_RADIUS_M * Math.cos(lat0))) * RAD_TO_DEG
  return {
    ...origin,
    lat,
    lng,
    altitudeM: (origin.altitudeM ?? 0) + local.y,
  }
}

export function composeYUpTransform(translation: Vec3, bearingDeg: number | null | undefined, scale = 1): number[] {
  const yaw = ((bearingDeg ?? 0) * DEG_TO_RAD)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)

  return [
    c * scale, 0, -s * scale, 0,
    0, scale, 0, 0,
    s * scale, 0, c * scale, 0,
    translation.x, translation.y, translation.z, 1,
  ]
}

/**
 * Builds a `ScanCalibration.sessionToProject` matrix for the one-tap
 * ground-plus-compass calibration: `tapPos` (a hit-tested point in the AR
 * session's local coordinates) must map to project-space origin (0,0,0) —
 * the same invariant the old 3-point reference-triangle system already
 * established (its first tapped point always zeroed out by construction).
 *
 * Reuses composeYUpTransform's own rotation construction so the yaw
 * convention can't drift between the GPS-fallback placement path and this
 * one — but inverts the translation: composeYUpTransform positions a scan's
 * local origin AT `translation`; this instead solves for the translation
 * that puts `tapPos` itself at zero, i.e. T = -R(bearing)·tapPos.
 */
export function anchorToProjectTransform(tapPos: Vec3, bearingDeg: number | null): number[] {
  const rotation = composeYUpTransform({ x: 0, y: 0, z: 0 }, bearingDeg, 1)
  // Column-major (THREE.Matrix4.fromArray convention, matching composeYUpTransform's
  // own return layout): column 0 = indices [0,1,2], column 1 = [4,5,6], column 2 = [8,9,10].
  const r00 = rotation[0]!, r01 = rotation[4]!, r02 = rotation[8]!
  const r10 = rotation[1]!, r11 = rotation[5]!, r12 = rotation[9]!
  const r20 = rotation[2]!, r21 = rotation[6]!, r22 = rotation[10]!

  rotation[12] = -(r00 * tapPos.x + r01 * tapPos.y + r02 * tapPos.z)
  rotation[13] = -(r10 * tapPos.x + r11 * tapPos.y + r12 * tapPos.z)
  rotation[14] = -(r20 * tapPos.x + r21 * tapPos.y + r22 * tapPos.z)
  return rotation
}

/**
 * Builds a `ScanCalibration.sessionToProject` matrix for the two-point
 * ground calibration (wave 09 ticket 0004): the **landmark** becomes
 * project-space origin (0,0,0) and the **heading marker** lands on the
 * frame's forward (+Z) axis at `separationM` from it.
 *
 * The heading comes entirely from the landmark→marker geometry — the compass
 * contributes nothing (ADR 0005). That is the whole point of the tier: a
 * frame built this way is reproducible across sessions that started at
 * different device yaws, which a compass-derived heading is not.
 *
 * `atan2(x, z)` is the Y-up convention already used by `composeYUpTransform`
 * above and by `viewer.ts`'s `updateWorldHud()`, so all three agree on
 * handedness. Delegates the matrix construction to
 * {@link anchorToProjectTransform} rather than repeating its column-major
 * translation arithmetic — the yaw is the only thing that differs.
 *
 * Both points are expected to be coplanar already (the caller projects them
 * onto the established ground plane before calling); only x and z are read,
 * so a stray `y` cannot tilt the frame even if that projection is skipped.
 */
export function twoPointToProjectTransform(landmark: Vec3, headingMarker: Vec3): number[] {
  // The negation is load-bearing, not a fudge. `anchorToProjectTransform`
  // reuses `composeYUpTransform`'s rotation *as-is* rather than inverting it,
  // and that matrix maps a world direction into project space by rotating it
  // by MINUS its `bearingDeg` argument — solving `R(b)·d = +Z` gives
  // `d = (-sin b, 0, cos b)`, i.e. project +Z corresponds to the world
  // direction at bearing `-b`.
  //
  // So to make the landmark→marker baseline (whose compass bearing is
  // `twoPointHeadingDeg`) come out along project +Z, the value handed to that
  // builder must be the baseline's bearing negated. Verified by
  // `twoPointToProjectTransform: the heading marker lands on +Z at the
  // recorded separation` in tests/unit/deno/anchor_calibration.test.ts, which
  // fails by exactly this sign if the negation is dropped.
  return anchorToProjectTransform(landmark, -twoPointHeadingDeg(landmark, headingMarker))
}

/** Compass-convention bearing, in degrees, of the landmark→marker baseline. */
export function twoPointHeadingDeg(landmark: Vec3, headingMarker: Vec3): number {
  return Math.atan2(headingMarker.x - landmark.x, headingMarker.z - landmark.z) * RAD_TO_DEG
}

/**
 * Landmark→marker distance in metres, measured in the ground plane.
 *
 * Deliberately 2D: the two points are coplanar by construction, so folding in
 * `dy` would be harmless arithmetic that implies a vertical component the
 * ground projection has already removed.
 */
export function twoPointSeparationM(landmark: Vec3, headingMarker: Vec3): number {
  return Math.hypot(headingMarker.x - landmark.x, headingMarker.z - landmark.z)
}

export function matrixTranslation(matrix: number[]): Vec3 {
  return {
    x: Number(matrix[12] ?? 0),
    y: Number(matrix[13] ?? 0),
    z: Number(matrix[14] ?? 0),
  }
}
