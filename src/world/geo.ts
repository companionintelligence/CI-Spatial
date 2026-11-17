import type { BearingConvention, GeoPose, Quat, Vec3 } from './types'

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
 *
 * In a right-handed Y-up session this yaw grows **counter-clockwise** seen from
 * above (turning left raises it), while a compass bearing grows clockwise. That
 * opposition is the whole reason {@link sessionFrameBearingDeg} adds the yaw.
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
 * The sign rule every new bearing is written under: `deviceBearing + cameraYaw`.
 * See {@link BearingConvention} and {@link sessionFrameBearingDeg}.
 */
export const BEARING_CONVENTION: BearingConvention = 2

/**
 * The rule the app used before it was corrected: `deviceBearing − cameraYaw`.
 * Reachable only through {@link bearingConventionFromSearch}, so a tester can
 * compare the two on one phone. Never a default.
 */
export const LEGACY_BEARING_CONVENTION: BearingConvention = 1

/**
 * The device experiment's switch: `?bearing=1` selects the legacy sign rule, so
 * the compass spin test can run both rules on one phone and read which one holds
 * still while the phone turns (open the page with `?debug=pose` as well, and see
 * {@link compassSpinTerms}). Anything else, or no parameter, is the current rule.
 *
 * `search` is a parameter and not `location.search` so this stays a pure
 * function; the calibration flow passes the live query string.
 *
 * The rule the page ran under is written onto every record it produces
 * (`bearingConvention`), so a record made with the switch on can never be read
 * as a current one. With it on, the whole chain follows the old rule and not
 * only the sign in {@link sessionFrameBearingDeg}: the AR north tick
 * ({@link northYawInSessionDeg}) and the one-point frame
 * ({@link oneTapToProjectTransform}) take their old directions too. A hybrid
 * would compare neither rule.
 */
export function bearingConventionFromSearch(search: string): BearingConvention {
  return new URLSearchParams(search).get('bearing') === '1' ? LEGACY_BEARING_CONVENTION : BEARING_CONVENTION
}

/**
 * The compass bearing of the **session frame's +Z axis**, given the device's
 * compass heading and the camera pose at the moment that heading was read.
 * "North" is the compass's north, which every web platform documents as
 * magnetic north (see `GeoFix.bearing`); no declination is applied, and the spin
 * test below does not measure how far it is from true north.
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
 * ## The sign: add the yaw
 *
 * An AR session frame is right-handed with +Y up and its camera looks down its
 * own −Z: that is how three.js and WebXR define it, and how this file reads a
 * pose (see {@link cameraYawInSessionDeg}). Seen from above, session yaw
 * `atan2(x, z)` then grows **counter-clockwise**, and a compass bearing grows
 * **clockwise**. So a session direction at yaw `y` has bearing `B_Z − y`, where
 * `B_Z` is the bearing of session +Z. The camera's forward is one direction
 * described in both frames at once, as `cameraYaw` and as `deviceBearing`:
 *
 *     deviceBearing = B_Z − cameraYaw        so        B_Z = deviceBearing + cameraYaw
 *
 * Turning right by `t` lowers the session yaw by `t` and raises the compass
 * bearing by `t`, so the sum does not move.
 *
 * The version before this subtracted. That agrees with the truth only while the
 * camera is still at its starting orientation (turn 0 or 180°) and is off by
 * **twice the turn since session start** everywhere else — a 90° turn gave a
 * bearing 180° out. Its tests derived their "truth" through
 * `composeYUpTransform`, which assumes the same yaw direction, so they passed.
 * tests/unit/deno/world_registration.test.ts checks against a physical model
 * that shares no code with this file, and keeps the old rule as a regression
 * guard (an assertion that it disagrees).
 *
 * ## What is settled and what is not
 *
 * Computed, not measured. It rests on three premises: the session is
 * right-handed with the camera looking down −Z; `deviceBearing` is the compass
 * bearing of the camera's forward direction; bearings grow clockwise. On Android
 * the second one is arranged and not assumed: `GeoTracker.pairedCompass`
 * (src/geo/compass-heading.ts) hands over the camera's own bearing, or the one the
 * camera's bearing is worked out to be from the top edge's when the camera points
 * steeply, or nothing. What a phone's compass actually reports needs a device:
 * which axis of a tilted iPhone its heading follows (an iPhone's is used as the
 * camera's, as it always was), how far any reading is from true north (it is
 * magnetic, with no declination applied), what the screen's rotation does to the
 * browser's angles and to the AR pose. Until the spin
 * test has been run on a phone, `?bearing=1` selects the old rule
 * ({@link bearingConventionFromSearch}) so both can be compared on one phone.
 *
 * ## Why this needs no assumption about the provider
 *
 * It would be tempting to subtract a literal 180. That would encode a guess
 * about how WebXR and 8th Wall each initialise their world frame, and it would
 * still leave error 2 in place. Measuring
 * {@link cameraYawInSessionDeg} instead makes the correction self-evident: the
 * camera's forward is one direction expressed in both frames at once — session
 * yaw on one side, compass bearing on the other — so their combination *is* the
 * offset between the frames. The 180° falls out on its own whenever the camera
 * happens to sit at the session's starting orientation.
 *
 * Returns `null` for a null heading, which stays the honest "no compass fix"
 * value rather than a silent 0, and for a pose that gives no finite yaw.
 */
export function sessionFrameBearingDeg(
  deviceBearingDeg: number | null | undefined,
  cameraRotation: Quat,
  convention: BearingConvention = BEARING_CONVENTION,
): number | null {
  if (deviceBearingDeg === null || deviceBearingDeg === undefined) return null
  if (!Number.isFinite(deviceBearingDeg)) return null
  const yaw = cameraYawInSessionDeg(cameraRotation)
  if (!Number.isFinite(yaw)) return null
  return normaliseBearingDeg(convention === LEGACY_BEARING_CONVENTION ? deviceBearingDeg - yaw : deviceBearingDeg + yaw)
}

/**
 * The session yaw at which **north** (the compass's) lies — what the AR north tick needs,
 * because the decal it is drawn on lives in the session frame, where yaw is
 * `atan2(x, z)` and grows counter-clockwise from above.
 *
 * A session direction at yaw `y` has bearing `B_Z − y` (see
 * {@link sessionFrameBearingDeg}). North is bearing 0, so north lies at yaw
 * `B_Z`: the tick is drawn at **+bearing**. The old rule drew it at `−B_Z`,
 * which is right only for `B_Z` of 0 or 180.
 *
 * `null` in, `null` out: no compass reading draws no tick, not a tick at 0.
 */
export function northYawInSessionDeg(
  frameBearingDeg: number | null,
  convention: BearingConvention = BEARING_CONVENTION,
): number | null {
  if (frameBearingDeg === null) return null
  return normaliseBearingDeg(convention === LEGACY_BEARING_CONVENTION ? -frameBearingDeg : frameBearingDeg)
}

/**
 * Compass bearing of the **project frame's +Z axis** on the two-point tier.
 *
 * Project +Z is the landmark→marker baseline, whose session yaw is
 * {@link twoPointHeadingDeg}. A session direction at yaw `y` has bearing
 * `B_Z − y` (see {@link sessionFrameBearingDeg}), so the frame's +Z has bearing
 * `B_Z − baselineYaw`. `anchorBearingDeg` cannot stand in for it: that is the
 * session's +Z, and the baseline is wherever the person walked.
 *
 * `null` when there is no compass reading. Data only for now: nothing places a
 * scan with it.
 */
export function projectBearingDeg(
  frameBearingDeg: number | null,
  baselineYawInSessionDeg: number,
): number | null {
  if (frameBearingDeg === null || !Number.isFinite(baselineYawInSessionDeg)) return null
  return normaliseBearingDeg(frameBearingDeg - baselineYawInSessionDeg)
}

/**
 * The bearing fields a two-point record carries beside `anchorBearingDeg`, so
 * the calibration and the Place frame are written from one place and cannot
 * drift apart.
 */
export function twoPointBearingFields(
  frameBearingDeg: number | null,
  landmark: Vec3,
  headingMarker: Vec3,
  convention: BearingConvention = BEARING_CONVENTION,
): { projectBearingDeg: number | null; bearingConvention: BearingConvention } {
  return {
    projectBearingDeg: projectBearingDeg(frameBearingDeg, twoPointHeadingDeg(landmark, headingMarker)),
    bearingConvention: convention,
  }
}

/** The one rule for reading a stored bearing: only a record written under the current rule is readable. */
function readableBearingDeg(
  value: number | null | undefined,
  convention: BearingConvention | undefined,
): number | null {
  if (convention !== BEARING_CONVENTION) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A stored `anchorBearingDeg`, or `null` when it must not be used.
 *
 * Values written before the sign was corrected carry no `bearingConvention`;
 * values from a `?bearing=1` page carry `1`. Both were computed as
 * `deviceBearing − cameraYaw`, and correcting one needs the camera pose at the
 * instant it was sampled, which was never stored, so they are unreadable rather
 * than approximately right. Nothing in the app reads the field today; whatever
 * starts to must come through here.
 */
export function readableAnchorBearingDeg(
  record: { anchorBearingDeg?: number | null; bearingConvention?: BearingConvention },
): number | null {
  return readableBearingDeg(record.anchorBearingDeg, record.bearingConvention)
}

/** A stored `projectBearingDeg`, or `null` when absent, null or written under the old rule. */
export function readableProjectBearingDeg(
  record: { projectBearingDeg?: number | null; bearingConvention?: BearingConvention },
): number | null {
  return readableBearingDeg(record.projectBearingDeg, record.bearingConvention)
}

/**
 * The four numbers the compass spin test reads off a phone: the compass reading,
 * the camera's yaw in the session, and their sum and difference. Stand still and
 * turn the phone on the spot. A compass that reports the camera's heading gives a
 * sum that holds still (that is the session's +Z bearing) and a difference that
 * moves by twice the turn; a phone that does anything else is telling you about
 * its sensor, not about the sign.
 *
 * `null` when there is no compass reading or the pose gives no finite yaw.
 */
export function compassSpinTerms(
  deviceBearingDeg: number | null | undefined,
  cameraRotation: Quat,
): { deviceBearingDeg: number; cameraYawDeg: number; sumDeg: number; differenceDeg: number } | null {
  if (deviceBearingDeg === null || deviceBearingDeg === undefined || !Number.isFinite(deviceBearingDeg)) return null
  const cameraYawDeg = cameraYawInSessionDeg(cameraRotation)
  if (!Number.isFinite(cameraYawDeg)) return null
  return {
    deviceBearingDeg: normaliseBearingDeg(deviceBearingDeg),
    cameraYawDeg,
    sumDeg: normaliseBearingDeg(deviceBearingDeg + cameraYawDeg),
    differenceDeg: normaliseBearingDeg(deviceBearingDeg - cameraYawDeg),
  }
}

/**
 * The `?debug=pose` line for {@link compassSpinTerms}. Plain numbers only: it
 * claims nothing about which rule is right, which is what the test is for.
 * `rule` is the sign rule this page writes (1 only under `?bearing=1`). `via`,
 * when there is one, says how the compass bearing was paired with the camera
 * (`camera`, `top`, `platform`: see `PairedCompass` in src/geo/compass-heading.ts)
 * or that the reading was withheld (`withheld`), so a tester reading the line
 * can tell which case produced `compass`.
 */
export function formatCompassSpin(
  terms: ReturnType<typeof compassSpinTerms>,
  convention: BearingConvention = BEARING_CONVENTION,
  via?: string | null,
): string {
  const how = via ? ` · via ${via}` : ''
  if (!terms) return `compass none · rule ${convention}${how}`
  // Whole degrees (`String(-0)` is "0", so a yaw of -0.2 reads 0), and a bearing that rounds up to 360 reads 0.
  const whole = (deg: number) => String(Math.round(deg))
  const bearing = (deg: number) => whole(normaliseBearingDeg(Math.round(deg)))
  return `compass ${bearing(terms.deviceBearingDeg)} · yaw ${whole(terms.cameraYawDeg)} · B+yaw ${bearing(terms.sumDeg)} · B-yaw ${bearing(terms.differenceDeg)} · rule ${convention}${how}`
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
 * The one-point tier's `sessionToProject`: the tapped point is the origin and
 * project **+Z is north** (the compass's), from the session frame's own bearing
 * ({@link sessionFrameBearingDeg}).
 *
 * `composeYUpTransform(b)` turns a session direction at yaw `y` to yaw `y + b`.
 * North lies at session yaw `B_Z` ({@link northYawInSessionDeg}), and it has to
 * land on project +Z, yaw 0, so the rotation handed to
 * {@link anchorToProjectTransform} is **−B_Z**. Passing `+B_Z`, as the
 * calibration did before, puts project +Z at twice the compass bearing — right
 * only when the camera faced north or south (audit F53). Under the legacy rule
 * (`?bearing=1`) the old `+B_Z` is kept, so that rule can be compared as a whole.
 *
 * Returns `null` with no compass reading. The caller refuses to commit then:
 * the old fallback to a null bearing left the frame at whatever yaw the AR
 * session happened to boot with, on a frame stored as valid.
 *
 * Project +X on this frame is **west**. A right-handed frame with +Y up and +Z
 * north has no other choice; the scene frame in ./enu.ts is this frame turned
 * half a way round.
 */
export function oneTapToProjectTransform(
  tapPos: Vec3,
  frameBearingDeg: number | null,
  convention: BearingConvention = BEARING_CONVENTION,
): number[] | null {
  if (frameBearingDeg === null) return null
  return anchorToProjectTransform(tapPos, convention === LEGACY_BEARING_CONVENTION ? frameBearingDeg : -frameBearingDeg)
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

/**
 * Everything the committed origin decal needs, as plain numbers. The decal
 * builder (`src/world/origin-decal.ts`) only turns this into geometry, so the
 * origin's placement and orientation are decided here, where they can be tested
 * without a renderer.
 */
export interface OriginDecalPlan {
  /** Crosshair centre: the origin, on the ground at its committed height. */
  origin: Vec3
  /**
   * Arrow yaw in degrees on the compass convention (0 = +Z), the same one
   * `twoPointHeadingDeg` uses. Null when there is no heading point.
   */
  headingDeg: number | null
  /**
   * Arrow length in metres. The tip lands on the heading point, so the arrow
   * is the baseline the user defined. 0 when there is no arrow.
   */
  arrowLengthM: number
  /**
   * Session yaw, in degrees, at which true north lies: the `buildAnchorMarker`
   * convention, where rotating by this yaw turns the north tick toward north.
   * Null when there is no compass fix, which leaves the decal without a tick.
   */
  northYawDeg: number | null
}

/**
 * Plans the origin decal from the committed origin, an optional heading point
 * on the same ground plane, and the session's north yaw.
 *
 * A degenerate heading (the point coincides with the origin) gives no arrow
 * rather than an arrow with an undefined direction.
 */
export function originDecalPlan(
  origin: Vec3,
  headingPoint: Vec3 | null,
  northYawDeg: number | null,
): OriginDecalPlan {
  const plan: OriginDecalPlan = {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    headingDeg: null,
    arrowLengthM: 0,
    northYawDeg,
  }
  if (!headingPoint) return plan
  const length = twoPointSeparationM(origin, headingPoint)
  if (!(length > 0)) return plan
  plan.headingDeg = twoPointHeadingDeg(origin, headingPoint)
  plan.arrowLengthM = length
  return plan
}

/**
 * True-north bearing of the origin's heading arrow, in degrees clockwise from
 * north: what the HUD's frame-heading needle shows.
 *
 * The arrow's yaw is in session space and north lies at `northYawDeg` there, so
 * the arrow's bearing is its yaw measured from north. It comes from the same
 * single compass fix as the north tick, so it is only as good as that tick:
 * indoor compass readings can be well off. Null when there is no arrow or no
 * compass fix, since then there is no bearing to show.
 */
export function originHeadingBearingDeg(plan: OriginDecalPlan): number | null {
  if (plan.headingDeg === null || plan.northYawDeg === null) return null
  return normaliseBearingDeg(plan.headingDeg - plan.northYawDeg)
}

/**
 * The floor height, in session metres, that a scan's origin sat on: the
 * `groundY` a `ScanCalibration` record carries.
 *
 * Null for records written before the field existed, and for any value that is
 * not a finite number. Records that predate it are not an error — they simply
 * do not say where the floor was.
 */
export function readCalibrationGroundY(calibration: unknown): number | null {
  const groundY = (calibration as { groundY?: unknown } | null | undefined)?.groundY
  return typeof groundY === 'number' && Number.isFinite(groundY) ? groundY : null
}

export function matrixTranslation(matrix: number[]): Vec3 {
  return {
    x: Number(matrix[12] ?? 0),
    y: Number(matrix[13] ?? 0),
    z: Number(matrix[14] ?? 0),
  }
}

/**
 * Applies a column-major 4x4 matrix to a point. This is the layout of
 * `scan.localToWorld`, `composeYUpTransform` and three.js `Matrix4.elements`, which is
 * what the viewer applies to a scan root. Maps a session-frame point into the Place frame.
 */
export function transformPoint(matrix: number[], p: Vec3): Vec3 {
  return {
    x: matrix[0] * p.x + matrix[4] * p.y + matrix[8] * p.z + matrix[12],
    y: matrix[1] * p.x + matrix[5] * p.y + matrix[9] * p.z + matrix[13],
    z: matrix[2] * p.x + matrix[6] * p.y + matrix[10] * p.z + matrix[14],
  }
}
