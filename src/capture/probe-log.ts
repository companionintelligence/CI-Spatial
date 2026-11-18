/**
 * `?debug=probe`: one `[probe]` JSON line per tap, after calibration.
 *
 * ## Why this exists
 *
 * Every tolerance and rule in the calibration system (the 0.15 m separation gate, the 1 m
 * baseline, the 0.25 m floor gate, what a tap is worth) rests on how repeatably this app
 * places a point in a room, and nobody has measured that: `DEFAULT_SEPARATION_TOLERANCE_M`
 * says so in src/world/geo.ts. The one statistic the old procedure recorded, the spread of
 * `separationM` between two taps, is blind to a shifted or rotated frame, because distance
 * is the same for every rigid motion of the pair. What does see those is a point that was
 * not used to build the frame. So after calibration this logs,
 * for each tap, where that tap landed in the Place frame, together with what else a later
 * analysis needs to say why (how far away it was, how the phone was held, what tracking
 * reported, which way the compass and the camera each thought they faced).
 * docs/testing/DEVICE_TESTING.md, Procedures 2 to 4, is how to collect and read it.
 *
 * ## What a line contains
 *
 * Numbers and short enum words, nothing else: the key table is {@link PROBE_KEYS}, one entry
 * per key, and tests/unit/node/probe_log.test.ts pins it. In words: the tap's count; the
 * runtime and, when the provider names one, its scale mode; the calibration this session
 * used (tier, status, `separationM`, `residualM`, the check its status rests on and, when three or more points
 * were fitted, the fit's size, its rms and each point's residual); the tapped point in the Place frame and in
 * the session frame (metres, relative to the landmark and to where AR started); the range
 * the runtime gave the hit; the camera's height, pitch and yaw; where on the canvas the tap
 * landed; the tracking status and reason, and the frame shifts counted so far; the compass
 * bearing the calibration is given (the direction the camera faces, paired with this tap's pose), and that
 * bearing with the camera yaw added and subtracted; the screen angle; the camera's height at the first pose
 * the scanner recorded; and the raw orientation sample the compass bearing was taken from (`alpha`, `beta`,
 * `gamma`, the `absolute` flag, `webkitCompassHeading` and `webkitCompassAccuracy`) with the axis of the
 * phone the reading follows and the turn between the browser's frame and the AR pose's, so that the device
 * test of the compass (DX3) can compare the candidates afterwards, from the numbers the phone had, and not
 * only from the one it chose.
 * When the tap was read through the
 * calibration's own sampler (`ProbeLogDeps.sample`, src/ar/calibration-taps.ts), what that read found out about
 * it: how many hits the median is of, how far they scattered, where the position came from (a burst of hits, one
 * hit, the floor ray), how far the floor ray lay from the hits, and why the calibration would have refused the tap: the
 * limit a tap beyond it was over, or the reason the sampler could place no point at all.
 *
 * It never contains a GPS position, a photo, a name, a street address, a Place id, a scan id, a
 * session id or any text a person typed. A tap with no calibration still logs: the
 * Place-frame fields are null. A tap the hit test found nothing for logs `hit: 0` with null
 * coordinates, because the miss rate is a measurement too.
 *
 * `null` means "not available" and is never a stand-in for zero: a provider with no frame-shift
 * counter logs `jumps: null`, not a `jumps: 0` that reads as "no frame shifts". All three providers the line
 * is written for (the native ARKit / ARCore session, 8th Wall and WebXR) keep one
 * (`getTrackingDiagnostics().poseJumps`, src/ar/frame-epoch.ts), so on any of them a 0 means none counted.
 * A number the line cannot carry (not finite, or beyond {@link MAX_ABS_VALUE} or {@link MAX_COUNT}) is null
 * too, which is what keeps the longest possible line inside the relay's cap below.
 *
 * `n` counts the taps that were measured, from 1. A tap that is not a probe tap (a pinch, one outside the
 * canvas, one before the runtime has a pose, one that arrives while the last is still being measured) is not
 * counted; a tap that was counted and whose line could not be written leaves a gap in `n`, which is how the
 * person reading the log sees that a line is missing.
 *
 * ## Where it goes
 *
 * Through the existing `?debug=remote` relay (src/debug/remote-log.ts): no new endpoint,
 * nothing stored by this module. That is how the line leaves the phone, so a run that wants
 * the numbers arms both, `?debug=remote,probe`. With `probe` alone it is a console line on the
 * phone and goes nowhere. The relay adds its own timestamp, page path and user agent, and the
 * server adds the connection's network address; those belong to the channel, not to this line, and
 * the server keeps what it receives in scans/client-logs.jsonl as it does for any remote log.
 *
 * It is written with `console.warn` because the relay mirrors `warn` and `error` and mirrors
 * `log` only under `?debug=remote,verbose`, which also floods its 50-entry buffer with the
 * scanner's own ticks. The relay cuts a message at its `MAX_MSG_CHARS`, which would leave invalid
 * JSON, so the line is kept inside that by construction (numbers are bounded and words are cut), and
 * the test builds the longest line the bounds allow and measures it against the relay's own constant.
 * The orientation sample and the sampler's columns would not fit the relay's first cut of 500 characters (the
 * longest line the bounds allow was 484 characters without them), so the relay's cut was raised to 740, which is
 * above the longest line with both in it and below what the server keeps of a message (`CLIENT_LOG_MSG_MAX_CHARS`,
 * server/wp-a-client-logs.ts); a test holds the three together.
 *
 * Inert unless armed: the listeners are only added when the page was loaded with `probe` in
 * its `?debug=` list.
 *
 * `provider.scaleMode?.()`, and failing that `provider.scaleKind?.()`, is read by duck typing, so this
 * compiles and behaves with a provider that has neither, and logs `scale: null`, meaning not known.
 * All three providers the line is written for have `scaleMode()` (see `scaleModeOf`).
 */
import { hasDebugFlag } from '../shared/debug-flags.ts'
import { cameraYawInSessionDeg, normaliseBearingDeg, transformPoint } from '../world/geo.ts'
import { screenTurnDeg, type CompassSample } from '../geo/compass-heading.ts'
import type { HitResult, Pose } from '../ar/provider'
import type { CheckedBy } from '../world/calibration-evidence'
import type { ScanCalibration } from '../world/types'

/** The prefix of every line, so a log can be filtered with `grep '\[probe\]'`. */
export const PROBE_LINE_PREFIX = '[probe] '

/**
 * Every key of a line, in the order it is written. The meaning of each is in
 * docs/testing/DEVICE_TESTING.md (the field table in "The probe line"), which a test
 * compares with this list so the document cannot name a key the line lacks or omit one it has.
 */
export const PROBE_KEYS = [
  'v',
  'n',
  'rt',
  'scale',
  'method',
  'status',
  'sepM',
  'resM',
  'hit',
  'px',
  'py',
  'pz',
  'hx',
  'hy',
  'hz',
  'rng',
  'camY',
  'pitch',
  'tx',
  'ty',
  'trk',
  'why',
  'jumps',
  'B',
  'yaw',
  'Bplus',
  'Bminus',
  'scr',
  'y0',
  'ax',
  'alpha',
  'beta',
  'gamma',
  'abs',
  'wkHead',
  'wkAcc',
  'turn',
  'kept',
  'sprM',
  'src',
  'flrM',
  'rej',
  'chk',
  'fitN',
  'fitRms',
  'fitRes',
] as const

/** One line, as an object. Every key is always present; a reading that does not exist is `null`. */
export interface ProbeRecord {
  /** Line format version. */
  v: 1
  /** Which tap this is since the page loaded, from 1. */
  n: number
  /** The AR runtime: `native` (the ARKit / ARCore session of the mobile shell), `8thwall` or `webxr`. */
  rt: string
  /** The provider's scale mode (`scaleMode()`, else `scaleKind()`), or null when it does not name one. */
  scale: string | null
  /** The calibration tier this session used, or null when it continued without one. */
  method: ScanCalibration['method'] | null
  status: ScanCalibration['status'] | null
  /** `separationM` of this session's two taps. Null on the one-point tier and without a calibration. */
  sepM: number | null
  /** `residualM` of that calibration. */
  resM: number | null
  /**
   * Which check the calibration's status rests on (`ScanCalibration.checkedBy`): `constellation` for a fit of three or
   * more points, `separation` for the distance between two. Null on a Place's first calibration (nothing was compared), on
   * the one-point tier, without a calibration, and on a record written before the field existed.
   */
  chk: CheckedBy | null
  /** How many points the calibration's fit used (`fit.pointsUsed`). Null without a fit. */
  fitN: number | null
  /** The fit's root-mean-square horizontal residual, metres (`fit.rmsResidualM`): how far this session's points were from the Place's stored ones. */
  fitRms: number | null
  /**
   * Each point's horizontal residual after the fit, metres, in the order the points were tapped: the landmark, the heading
   * marker, then the check points. A residual that is not a number is null in its place. Null without a fit.
   */
  fitRes: Array<number | null> | null
  /** 1 when the hit test returned a point; 0 when it found nothing (the coordinates below are then null). */
  hit: 0 | 1
  /** The tapped point in the Place frame (`sessionToProject` applied), metres. Null without a calibration. */
  px: number | null
  py: number | null
  pz: number | null
  /** The tapped point in the session frame, metres. */
  hx: number | null
  hy: number | null
  hz: number | null
  /** The distance from the camera the runtime reported for the hit, metres. */
  rng: number | null
  /** The camera's height in the session frame at the tap, metres. */
  camY: number | null
  /** The camera's pitch at the tap, degrees: negative looks down, 0 is level. */
  pitch: number | null
  /** Where on the canvas the tap landed, 0 to 1 from the left and from the top. */
  tx: number | null
  ty: number | null
  /** The tracking status the runtime reported at the tap. */
  trk: string
  /** The runtime's tracking reason, when it gives one (8th Wall does). */
  why: string | null
  /** Frame shifts the provider has counted so far (`poseJumps`). Null only when the provider keeps no such count. */
  jumps: number | null
  /**
   * The compass bearing the calibration is given, degrees clockwise from magnetic north (no declination is
   * applied): the direction the camera faces. On Android it is the camera's own bearing, or, while the camera
   * points steeply, the one worked out from the top edge's through the AR pose; on an iPhone it is the
   * platform's heading, whose axis is not known. Null without a compass reading, and when the reading is the top
   * edge's and cannot be paired with this pose (the camera points within about 17 degrees of straight up or
   * down, or the two sources disagree). `ax` says which axis of the phone the reading follows.
   */
  B: number | null
  /** The camera's yaw in the session frame, degrees: 0 is session +Z, 90 is session +X. */
  yaw: number | null
  /**
   * `B + yaw` folded into 0 to 360. Constant while turning on the spot if the sign convention holds, and what
   * `sessionFrameBearingDeg` in src/world/geo.ts computes under the current rule (`bearingConvention` 2).
   */
  Bplus: number | null
  /** `B - yaw` folded into 0 to 360: what `sessionFrameBearingDeg` computed under the earlier rule, which `?bearing=1` still selects. */
  Bminus: number | null
  /** `screen.orientation.angle`: 0 portrait, 90 or 270 landscape. */
  scr: number | null
  /** The camera's height in the session frame at the first pose the scanner recorded (`poseHistory[0]`), metres. */
  y0: number | null
  /**
   * Which axis of the phone the compass reading follows: `camera`, `top` (the top edge) or `unknown` (an
   * iPhone's own heading, or any heading under `?compass=alpha`). When it is `top`, `B` is derived from it
   * through the AR pose, and null if that could not be done. Null when there is no compass sample, or the
   * sample was refused.
   */
  ax: string | null
  /**
   * The raw orientation angles of the last event that said something about the compass, degrees, as the browser
   * delivered them: Euler angles of type Z-X'-Y'' (W3C Device Orientation), `alpha` 0 to 360, `beta` -180 to 180,
   * `gamma` -90 to 90. Null without such an event, or where the event had no such field.
   */
  alpha: number | null
  beta: number | null
  gamma: number | null
  /**
   * That event's `absolute` flag: 1 when its angles are measured from the earth's frame, 0 when from an
   * arbitrary one, null when the event has no such property, which is every event on an iPhone (Safari on iOS
   * does not implement `DeviceOrientationEvent.absolute`).
   */
  abs: 0 | 1 | null
  /** That event's `webkitCompassHeading` (iOS), degrees from magnetic north: the heading iOS reports for itself. */
  wkHead: number | null
  /** That event's `webkitCompassAccuracy` (iOS), degrees: the error the platform claims, and negative when it says the heading is invalid. */
  wkAcc: number | null
  /**
   * The turn between the browser's orientation frame and the AR pose's camera frame about the screen's normal,
   * degrees from -180 to 180, read off the direction of gravity each sees in the plane of the screen
   * (`screenTurnDeg` in src/geo/compass-heading.ts): 0 when they agree, about 90 or -90 when one follows the
   * screen into landscape and the other does not. Null when it cannot be read: no orientation sample with a
   * `beta` and a `gamma`, or the phone lies too flat for gravity to show in the screen's plane.
   */
  turn: number | null
  /** The hits the tap's median is of (1 for one hit, 0 for a tap the floor ray placed alone). For a refused tap, the usable hits the sampler had counted when it refused it (none are counted for `tracking`). Null when the tap was not read through the sampler. */
  kept: number | null
  /** How far the kept hits scattered, metres: the root-mean-square distance from their median. For a tap refused for scatter, the scatter that refused it. Null for one hit, and when nothing measured it. */
  sprM: number | null
  /** Where the tapped point came from: `burst` (the median of a burst), `single-hit` or `floor-ray`. Null for a refused tap and when the tap was not read through the sampler. */
  src: string | null
  /** How far the floor ray through the pixel lay from the hits' median, metres. Null without a reliable fitted floor, and when the ray could not be cast. */
  flrM: number | null
  /** Why the calibration would have refused the tap. A tap read with the limits lifted keeps its point and names the limit it was over (`too-far`, `unsteady`); one the sampler could place no point for names why (`tracking`, `no-hit`, `too-few-hits`, or `unsteady` for too many strays). Null for a tap inside the limits, and when the tap was not read through the sampler. */
  rej: string | null
}

/**
 * What reading a tap through the calibration's sampler found out about it, beyond where it landed
 * (`probeAnswerOf` in src/ar/calibration-taps.ts builds it from the sampler's answer). Declared here, and not
 * imported, so that this file stays a leaf the sampler's module imports and not the other way about.
 */
export interface ProbeSample {
  /** Hits the tap rests on; for a refused tap, the usable hits the sampler had counted when it refused it. */
  kept: number
  /** Scatter of the kept hits, metres, where it was measured. */
  spreadM: number | null
  /** `burst`, `single-hit` or `floor-ray`; null for a refused tap. */
  source: string | null
  /** The floor ray's distance from the hits' median, metres, where a reliable fitted floor let one be cast. */
  floorRayDeltaM: number | null
  /** Why the calibration would have refused the tap (see `ProbeRecord.rej`); null for a tap inside the limits. */
  refused: string | null
  /** The range that refused a tap for being too far, metres. Only read for a tap with no hit. */
  rangeM: number | null
}

/** What a tap read through the sampler answers: the hit as the line has always had it, and what else was found out. */
export interface ProbeTapAnswer {
  /** The tapped point and its range; null for a refused tap. */
  hit: Pick<HitResult, 'position' | 'distance'> | null
  sample: ProbeSample
}

/** What one tap read, before it is turned into a line. */
export interface ProbeReading {
  n: number
  runtime: string
  scaleMode: string | null
  calibration: ScanCalibration | null | undefined
  /** The hit test's answer; null when it found nothing. */
  hit: Pick<HitResult, 'position' | 'distance'> | null
  /** The camera pose at the moment of the tap. */
  pose: Pose
  /** The tap on the canvas, normalised 0 to 1. */
  tap: { x: number; y: number }
  trackingStatus: string
  trackingReason: string | null
  /** The provider's frame-shift count, or null when it has no counter to read. */
  poseJumps: number | null
  /** The compass bearing in degrees, or null. */
  bearing: number | null
  screenAngle: number | null
  /** The session's first tracked pose, or null before there is one. */
  firstPose: Pick<Pose, 'position'> | null | undefined
  /**
   * The last orientation event that said something about the compass and what was made of it
   * (`GeoTracker.lastCompassSample`). Absent or null: the raw and axis columns are null.
   */
  compassSample?: CompassSample | null
  /** What the sampler found out about the tap. Absent or null when the tap was read another way (one hit from `hitTest`). */
  sample?: ProbeSample | null
}

/** A reading before the hit test has answered: everything {@link ProbeReading} holds except the hit and the sample. */
export type ProbeTapReading = Omit<ProbeReading, 'hit' | 'sample'>

/**
 * The longest an enum word from a provider is kept, so a runaway string cannot push a line past
 * the relay's cap (`MAX_MSG_CHARS`). The longest word this build writes is 18 characters (`ground-tap-compass`,
 * and `NOT_ENOUGH_TEXTURE`, the longest of the tracking reasons it handles). Adopted, not measured (ADR
 * 0005 rule 5): a bound that keeps a line valid, not a threshold anything is judged by.
 */
const MAX_WORD_CHARS = 24

/**
 * A length or angle at or beyond this, in metres or degrees, is not a measurement of a room and is logged as null.
 * Together with {@link MAX_COUNT} and the word cut it bounds the longest line by construction: a number the runtime
 * got wrong (1e21 prints as 22 characters) could otherwise push a line past the relay's cut, which
 * leaves invalid JSON. Adopted, not measured (ADR 0005 rule 5): a bound far beyond any room (the editor's own
 * outlier radius for a GPS fix is 250 m), not a threshold anything is judged by.
 */
export const MAX_ABS_VALUE = 1_000

/**
 * The largest count a line carries: the tap number `n` is held to it, and a frame-shift count beyond it is null.
 * Adopted, not measured (ADR 0005 rule 5): no session taps, or shifts, a hundred thousand times; the bound keeps a
 * line inside the relay's cap.
 */
export const MAX_COUNT = 99_999

/**
 * Decimals kept on a length, in metres (a millimetre), and on an angle, in degrees (a tenth).
 * Adopted, not measured (ADR 0005 rule 5): finer than the 3 cm tap noise `DEFAULT_SEPARATION_TOLERANCE_M`
 * assumes, so rounding adds nothing to what is being measured, and coarse enough to keep the
 * line inside the relay's cap.
 */
const METRE_DECIMALS = 3
const DEGREE_DECIMALS = 1

/**
 * The most per-point residuals a line carries: the schema's five points (the landmark, the heading marker and up to three
 * check points). Adopted, not measured (ADR 0005 rule 5): a bound that keeps a line inside the relay's cap, as the others do.
 */
const MAX_LOGGED_POINTS = 5

/**
 * How long one tap's hit test may run before the tap is logged as a miss and the next tap is
 * accepted. The WebXR provider already gives up after a second (`HIT_TEST_TIMEOUT_MS`) and the
 * 8th Wall one answers synchronously, and a read through the sampler is a burst of at most
 * `TAP_BURST_WINDOW_MS` (src/ar/tap-sampling.ts) with a watchdog of a second past it, so this only
 * matters if a runtime's promise never settles, which would otherwise stop the log for the rest of
 * the session. Adopted, not measured (ADR 0005 rule 5): a failsafe longer than any provider's own bound.
 */
export const HIT_TEST_GUARD_MS = 3_000

function finite(value: number | null | undefined, decimals: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const scale = 10 ** decimals
  const rounded = Math.round(value * scale) / scale
  if (Math.abs(rounded) >= MAX_ABS_VALUE) return null
  // `-0` prints as 0 in JSON already, but a value that rounds to it should be a plain zero.
  return rounded === 0 ? 0 : rounded
}

/** A count as a whole number, or null for one that does not exist or that a line cannot carry. */
function wholeCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const whole = Math.trunc(value)
  return whole > MAX_COUNT ? null : whole
}

/** A bearing rounded to a tenth of a degree and folded into [0, 360), so 359.96 reads 0 and not 360. */
function bearingOut(value: number | null): number | null {
  const folded = finite(value === null ? null : normaliseBearingDeg(value), DEGREE_DECIMALS)
  return folded === null ? null : folded >= 360 ? 0 : folded
}

function word(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_WORD_CHARS) : null
}

/** A calibration's `sessionToProject`, when it is a usable 4x4. */
function matrixOf(calibration: ScanCalibration | null | undefined): number[] | null {
  const matrix = calibration?.sessionToProject
  return Array.isArray(matrix) && matrix.length === 16 && matrix.every((item) => Number.isFinite(item)) ? matrix : null
}

/**
 * The camera's pitch from its rotation, in degrees: negative looks down, positive looks up.
 *
 * The camera looks along its own -Z, so its forward vector is the negated third column of
 * the rotation matrix, and its vertical component is `2(wx - yz)`. (`cameraYawInSessionDeg`
 * in src/world/geo.ts reads the other two components of the same vector.)
 */
export function cameraPitchDeg(rotation: Pose['rotation']): number | null {
  const { x, y, z, w } = rotation
  const up = 2 * (w * x - y * z)
  if (!Number.isFinite(up)) return null
  return Math.asin(Math.max(-1, Math.min(1, up))) * (180 / Math.PI)
}

/** One tap's reading as the line's object. Pure: the same reading is always the same line. */
export function buildProbeRecord(reading: ProbeReading): ProbeRecord {
  const { calibration, hit, pose } = reading
  const matrix = matrixOf(calibration)
  const hitPosition = hit && [hit.position.x, hit.position.y, hit.position.z].every(Number.isFinite) ? hit.position : null
  const inPlace = hitPosition && matrix ? transformPoint(matrix, hitPosition) : null
  const withDistance = calibration && (calibration.method === 'two-point-ground' || calibration.method === 'known-distance')
    ? calibration
    : null
  // The check and the fit exist on the two-point tier only (ADR 0005 rule 3: no other tier carries one).
  const twoPoint = calibration?.method === 'two-point-ground' ? calibration : null
  const fit = twoPoint?.fit
  const yaw = cameraYawInSessionDeg(pose.rotation)
  const bearing = typeof reading.bearing === 'number' && Number.isFinite(reading.bearing) ? reading.bearing : null
  const raw = reading.compassSample?.raw
  const sample = reading.sample ?? null

  return {
    v: 1,
    // Never null: `n` is how a person reading the log sees a missing line. The runtime cannot make it unusual; the bound is for the cap.
    n: Math.min(Math.max(0, Math.trunc(reading.n) || 0), MAX_COUNT),
    rt: reading.runtime.slice(0, MAX_WORD_CHARS),
    scale: word(reading.scaleMode),
    method: calibration?.method ?? null,
    status: calibration?.status ?? null,
    sepM: finite(withDistance?.separationM, METRE_DECIMALS),
    resM: finite(withDistance?.residualM, METRE_DECIMALS),
    chk: twoPoint?.checkedBy === 'constellation' || twoPoint?.checkedBy === 'separation' ? twoPoint.checkedBy : null,
    fitN: wholeCount(fit?.pointsUsed),
    fitRms: finite(fit?.rmsResidualM, METRE_DECIMALS),
    fitRes: Array.isArray(fit?.perPoint)
      ? fit.perPoint.slice(0, MAX_LOGGED_POINTS).map((point) => finite(point?.residualM, METRE_DECIMALS))
      : null,
    hit: hitPosition ? 1 : 0,
    px: finite(inPlace?.x, METRE_DECIMALS),
    py: finite(inPlace?.y, METRE_DECIMALS),
    pz: finite(inPlace?.z, METRE_DECIMALS),
    hx: finite(hitPosition?.x, METRE_DECIMALS),
    hy: finite(hitPosition?.y, METRE_DECIMALS),
    hz: finite(hitPosition?.z, METRE_DECIMALS),
    // A tap with no hit has no range of the runtime's, but one the sampler refused for being too far knows how far.
    rng: finite(hitPosition ? hit?.distance : sample?.rangeM, METRE_DECIMALS),
    camY: finite(pose.position.y, METRE_DECIMALS),
    pitch: finite(cameraPitchDeg(pose.rotation), DEGREE_DECIMALS),
    tx: finite(reading.tap.x, METRE_DECIMALS),
    ty: finite(reading.tap.y, METRE_DECIMALS),
    trk: word(reading.trackingStatus) ?? 'UNKNOWN',
    why: word(reading.trackingReason),
    jumps: wholeCount(reading.poseJumps),
    B: bearingOut(bearing),
    yaw: finite(yaw, DEGREE_DECIMALS),
    Bplus: bearingOut(bearing === null ? null : bearing + yaw),
    Bminus: bearingOut(bearing === null ? null : bearing - yaw),
    scr: finite(reading.screenAngle, 0),
    y0: finite(reading.firstPose?.position.y, METRE_DECIMALS),
    ax: word(reading.compassSample?.reading?.axis),
    alpha: finite(raw?.alpha, DEGREE_DECIMALS),
    beta: finite(raw?.beta, DEGREE_DECIMALS),
    gamma: finite(raw?.gamma, DEGREE_DECIMALS),
    abs: raw?.absolute === true ? 1 : raw?.absolute === false ? 0 : null,
    wkHead: finite(raw?.webkitCompassHeading, DEGREE_DECIMALS),
    wkAcc: finite(raw?.webkitCompassAccuracy, DEGREE_DECIMALS),
    turn: finite(screenTurnDeg(raw, pose.rotation), DEGREE_DECIMALS),
    kept: wholeCount(sample?.kept),
    sprM: finite(sample?.spreadM, METRE_DECIMALS),
    src: word(sample?.source),
    flrM: finite(sample?.floorRayDeltaM, METRE_DECIMALS),
    rej: word(sample?.refused),
  }
}

/** The line a record is logged as: the prefix, then the record as JSON in the order of {@link PROBE_KEYS}. */
export function formatProbeLine(record: ProbeRecord): string {
  const ordered: Record<string, unknown> = {}
  for (const key of PROBE_KEYS) ordered[key] = record[key]
  return PROBE_LINE_PREFIX + JSON.stringify(ordered)
}

/**
 * The provider's scale mode, when it names one.
 *
 * `scaleMode()` is the full answer (the engine configuration the session ran in, for example `responsive-originY:1.4`
 * or `absolute-notready`, src/ar/engine-config.ts), so the device test DX1 can tell its arms apart from the line.
 * A provider that only has `scaleKind()` (what the unit is worth) reports that. Both are read by duck typing, so
 * this module works with a provider that has neither: no method is "not known", and so is a method that throws or
 * answers with something that is not a word.
 */
export function scaleModeOf(provider: object): string | null {
  for (const name of ['scaleMode', 'scaleKind'] as const) {
    const read = (provider as Record<string, unknown>)[name]
    if (typeof read !== 'function') continue
    try {
      const answer = word(read.call(provider) as string | null | undefined)
      if (answer !== null) return answer
    } catch {
      // A method that throws names nothing: try the next, then say "not known".
    }
  }
  return null
}

/** The part of an AR provider the probe reads. `ARProvider` satisfies it, and so does a test double. */
export interface ProbeProvider {
  getPose(): Pose
  isTracking(): boolean
  trackingStatus(): string
  getTrackingDiagnostics?(): { status: string; poseJumps: number; lastJumpM: number; reason?: string }
}

/** The canvas the taps land on: the part of an `HTMLElement` the probe uses. */
export type ProbeCanvas = Pick<HTMLElement, 'addEventListener' | 'removeEventListener' | 'getBoundingClientRect'>

export interface ProbeLogDeps {
  canvas: ProbeCanvas
  provider: ProbeProvider
  /** `native` (the ARKit / ARCore session of the mobile shell), `8thwall` or `webxr`: the runtime that gives the taps their hits. */
  runtime: string
  /** The same hit test the calibration used, so a probe is judged by the tap that built the frame. */
  hitTest: (x: number, y: number) => Promise<HitResult | null> | HitResult | null
  /**
   * The same read the calibration's taps went through, when it has one: a burst of hits read as one measurement (or one
   * hit under `?tap=single`), through the same gates. Given, a probe tap is read with it and not with `hitTest`, so
   * that a probe is judged by the tap that built the frame in this respect too, and the line says what the read found
   * out. The host reads probe taps with the limits lifted (`probeTapReader`), so a tap beyond them still logs its point, with
   * `rej` saying which limit it was over; a tap the sampler can place no point for logs `hit: 0` and why.
   */
  sample?: (x: number, y: number) => Promise<ProbeTapAnswer>
  /** This session's calibration, read at each tap. Undefined or null when the session continued without one. */
  calibration: () => ScanCalibration | null | undefined
  /**
   * The compass bearing the calibration is given, in degrees clockwise from magnetic north, with or without a
   * position fix: the direction the camera faces, paired with the camera's pose
   * (`GeoTracker.pairedCompass(provider.getPose().rotation)`, the very getter the calibration reads, so a line
   * measures what a calibration made at that moment would have used).
   */
  bearing: () => number | null
  /**
   * The last orientation event that said something about the compass, with the reading taken from it
   * (`GeoTracker.lastCompassSample`). Optional, so a caller that has no sensor to offer logs null columns.
   */
  compassSample?: () => CompassSample | null | undefined
  /** The first pose the scanner recorded once the runtime reported tracking, for `y0`. */
  firstPose: () => Pick<Pose, 'position'> | null | undefined
  /** Where a line goes. Defaults to `console.warn`; see the header for why. */
  emit?: (line: string) => void
  /** The screen's rotation in degrees. Defaults to the live screen. */
  screenAngle?: () => number | null
}

function liveScreenAngle(): number | null {
  const fromOrientation = typeof screen !== 'undefined' ? screen.orientation?.angle : undefined
  if (typeof fromOrientation === 'number') return fromOrientation
  // Older iOS Safari has no screen.orientation and keeps the angle on window.
  const legacy = typeof window !== 'undefined' ? (window as { orientation?: unknown }).orientation : undefined
  return typeof legacy === 'number' ? legacy : null
}

/**
 * Starts logging a line per tap when the page was loaded with `?debug=probe`.
 *
 * Returns a function that stops it, or null when it is not armed (nothing was added to the
 * page). `search` is injectable so a test can arm it without a location.
 *
 * The hit test is the one calibration used, called with the same canvas-normalised
 * coordinates, so a probe is a tap like the ones the frame was built from. A tap that
 * arrives while the previous tap's hit test is still running is dropped, as calibration's
 * own placement does, so one tap is one line. Taps before the runtime has produced a pose
 * are ignored, as calibration's are.
 */
export function installProbeLog(deps: ProbeLogDeps, search?: string): (() => void) | null {
  if (!hasDebugFlag('probe', search)) return null

  const emit = deps.emit ?? ((line: string) => console.warn(line))
  const screenAngle = deps.screenAngle ?? liveScreenAngle
  let taps = 0
  let busy = false

  /** Everything that changes while the hit test runs, read now, at the tap. Null for a tap that is not a probe tap. */
  const readAtTap = (clientX: number, clientY: number): ProbeTapReading | null => {
    const rect = deps.canvas.getBoundingClientRect()
    const x = (clientX - rect.left) / rect.width
    const y = (clientY - rect.top) / rect.height
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null
    if (!deps.provider.isTracking()) return null
    // Counted before the reads that can fail, so a tap whose line is lost leaves a gap in `n`.
    const n = ++taps
    const diagnostics = deps.provider.getTrackingDiagnostics?.()
    return {
      n,
      runtime: deps.runtime,
      scaleMode: scaleModeOf(deps.provider),
      calibration: deps.calibration(),
      pose: deps.provider.getPose(),
      tap: { x, y },
      trackingStatus: diagnostics?.status ?? deps.provider.trackingStatus(),
      trackingReason: diagnostics?.reason ?? null,
      // A provider with no diagnostics has no counter: null, which is not "no frame shifts".
      poseJumps: diagnostics ? diagnostics.poseJumps : null,
      bearing: deps.bearing(),
      screenAngle: screenAngle(),
      firstPose: deps.firstPose(),
      compassSample: deps.compassSample?.(),
    }
  }

  const measure = async (base: ProbeTapReading): Promise<void> => {
    let hit: Pick<HitResult, 'position' | 'distance'> | null = null
    let sample: ProbeSample | null = null
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const guarded = new Promise<null>((resolve) => { guard = setTimeout(() => resolve(null), HIT_TEST_GUARD_MS) })
      if (deps.sample) {
        const answer = (await Promise.race([deps.sample(base.tap.x, base.tap.y), guarded])) ?? null
        hit = answer?.hit ?? null
        sample = answer?.sample ?? null
      } else {
        hit = (await Promise.race([deps.hitTest(base.tap.x, base.tap.y), guarded])) ?? null
      }
    } catch {
      // A hit test that throws is a tap that found nothing: the line says so.
    } finally {
      clearTimeout(guard)
    }
    try {
      emit(formatProbeLine(buildProbeRecord({ ...base, hit, sample })))
    } catch {
      // A diagnostic does not break the page: a line that cannot be written is a gap in `n`.
    } finally {
      busy = false
    }
  }

  const tap = (clientX: number, clientY: number): void => {
    if (busy) return
    busy = true
    let base: ProbeTapReading | null = null
    try {
      base = readAtTap(clientX, clientY)
    } catch {
      // A read that throws costs this tap's line, not the page, and not the next tap: `busy` is released below.
    }
    if (base === null) {
      busy = false
      return
    }
    void measure(base)
  }

  const onTouchStart = (event: TouchEvent): void => {
    // A two-finger touch is a pinch, not a tap.
    if (event.touches.length !== 1) return
    const touch = event.touches[0]!
    tap(touch.clientX, touch.clientY)
  }
  // Real touchscreens fire touchstart and pointerdown for one tap; this takes the touch one
  // and skips the pointer one. Controller-driven runtimes (Quest) have no touches and only
  // synthesize pointer events.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    tap(event.clientX, event.clientY)
  }

  deps.canvas.addEventListener('touchstart', onTouchStart, { passive: true })
  deps.canvas.addEventListener('pointerdown', onPointerDown)
  return () => {
    deps.canvas.removeEventListener('touchstart', onTouchStart)
    deps.canvas.removeEventListener('pointerdown', onPointerDown)
  }
}
