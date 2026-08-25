import type { GeoPose, Quat, Vec3 } from './types'

const EARTH_RADIUS_M = 6_378_137
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * Spatial-frame capture parameters for the `'two-point-ground'` calibration
 * tier. They live here rather than in `src/world/types.ts` because that file is
 * types-only (zero runtime exports) and this module already owns the frame math
 * these values parameterise — `anchorToProjectTransform` below.
 *
 * Both are **adopted defaults, not measured values** — ticket 0006 shipped its
 * benchmark instrument but was closed without anyone running it, so nothing is
 * pending. Each carries its own rationale and a revisit trigger below; pinned
 * here so ticket 0004's capture flow does not invent its own.
 */

/**
 * Max acceptable deviation, in metres, between a stored landmark→marker
 * separation and the one a later session re-measures.
 *
 * Tighter than the retired 3-point method's one-foot (0.3048 m) default,
 * because a single distance between two deliberately-chosen features is a
 * cleaner measurement than three interdependent ones.
 *
 * **Adopted by decision, not by measurement.** Ticket 0006 was closed without
 * running its benchmark, so no device-measured repeatability figure backs this
 * number and none is pending. Recorded plainly so nobody reads 0.15 as an
 * empirical result.
 *
 * The known counter-evidence stands: the only empirical spatial-repeatability
 * figure in this repo is `DEDUP_RADIUS_M = 0.4` (`src/spatial/resolver.ts`),
 * widened from 0.3 because same-object captures land 0.3–0.4 m apart. That
 * measures detection placement rather than a direct floor tap, so it is an
 * upper bound rather than a refutation — but it is more than twice this value.
 *
 * **Revisit when:** users report mismatch warnings after re-tapping what they
 * believe are the same two features. That symptom means the real spread
 * exceeds this tolerance and the check is firing on correct calibrations,
 * which is the failure mode this value risks. Widen it before concluding the
 * user mis-tapped. `public/compass-bench.html` and the `?debug=pose` readout
 * are the instruments if it needs settling empirically.
 */
export const DEFAULT_SEPARATION_TOLERANCE_M = 0.15

/**
 * Minimum landmark→marker baseline, in metres. Enforced by the capture flow
 * (ticket 0004), not by the type.
 *
 * Heading error is roughly hit-test noise divided by separation, so short
 * baselines amplify angular error: two points 20 cm apart with ~3 cm noise give
 * ~8° of heading uncertainty — worse than a decent compass, which defeats the
 * point of the tier. One metre keeps it near 2°.
 *
 * **Adopted by decision, not by measurement.** The ~3 cm hit-test noise figure
 * is an assumption that was never verified: ticket 0006 was closed without
 * running the benchmark that would have set it. If real noise is materially
 * worse, this must rise proportionally to hold the same angular error — the
 * relationship is linear, so 6 cm noise needs a 2 m baseline for the same 2°.
 *
 * This is a floor, not a target. Longer baselines are strictly better for
 * heading precision, which is why the capture copy encourages walking further
 * rather than stopping at the minimum.
 *
 * **Revisit when:** two sessions of one room disagree in heading by more than
 * a couple of degrees despite both pairs passing the separation check.
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

/**
 * Yaw of the camera's forward direction **within the AR session's own frame**,
 * in degrees.
 *
 * Uses the same `atan2(x, z)` convention as {@link composeYUpTransform} and
 * {@link twoPointHeadingDeg}: 0° is session +Z, 90° is session +X.
 *
 * A camera at identity rotation returns **180°**, not 0 — the camera looks down
 * its own −Z, so at identity its forward is session −Z. That is not a quirk to
 * work around; it is the measurement that makes
 * {@link sessionFrameBearingDeg} correct without assuming anything about how a
 * provider initialises its world frame.
 */
export function cameraYawInSessionDeg(rotation: Quat): number {
  // Third column of the rotation matrix is R·(0,0,1); the camera's forward is
  // R·(0,0,-1), so both components are negated.
  const { x, y, z, w } = rotation
  const forwardX = -2 * (x * z + y * w)
  const forwardZ = 2 * (x * x + y * y) - 1
  return Math.atan2(forwardX, forwardZ) * RAD_TO_DEG
}

/** Fold any angle into [0, 360). */
export function normaliseBearingDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * The true-north bearing of the **session frame's +Z axis**, given the device's
 * compass heading and the camera pose at the moment that heading was read.
 *
 * ## Why the raw compass heading is the wrong number
 *
 * A compass reports where the **device** is pointing. Every consumer of
 * `anchorBearingDeg` needs where the **session frame** is pointing, and the two
 * differ by however the camera happens to be held. `composeYUpTransform` maps
 * session +Z to the ENU direction at the bearing it is given
 * (`geoToEnu` defines `x = east, y = up, z = north`), so handing it a device
 * heading orients a scan by the phone's attitude rather than the room's.
 *
 * Two errors were folded into that, and this one function removes both:
 *
 * 1. **A 180° flip.** The camera looks down its own −Z. With the session frame
 *    established at the camera's starting orientation — which is the usual
 *    case — session +Z points *behind* the initial view, so a scan built from
 *    the raw heading faces exactly backwards.
 * 2. **The camera's yaw within the session.** The heading is sampled when the
 *    user taps, not at session start, so any turning done in between is
 *    included in the reading and none of it belongs to the frame.
 *
 * ## Why this needs no assumption about the provider
 *
 * It would be tempting to subtract a literal 180. That would encode a guess
 * about how WebXR and 8th Wall each initialise their world frame, and it would
 * still leave error 2 in place. Measuring
 * {@link cameraYawInSessionDeg} instead makes the correction self-evident: the
 * camera's forward is one direction expressed in both frames at once — session
 * yaw on one side, compass bearing on the other — so their difference *is* the
 * offset between the frames. The 180° falls out on its own whenever the camera
 * happens to sit at the session's starting orientation.
 *
 * Returns `null` for a null heading, which stays the honest "no compass fix"
 * value rather than a silent 0.
 */
export function sessionFrameBearingDeg(
  deviceBearingDeg: number | null | undefined,
  cameraRotation: Quat,
): number | null {
  if (deviceBearingDeg === null || deviceBearingDeg === undefined) return null
  if (!Number.isFinite(deviceBearingDeg)) return null
  return normaliseBearingDeg(deviceBearingDeg - cameraYawInSessionDeg(cameraRotation))
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
