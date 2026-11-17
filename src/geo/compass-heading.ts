/**
 * The compass heading a phone's orientation events describe, and what is known about it.
 *
 * Pure: nothing here reads the DOM, the clock or a Deno API (ADR 0002), so the browser and the node tests
 * import it alike. `GeoTracker` (./geo-tracker.ts) listens to the events and keeps the result; this file
 * turns one event into a {@link CompassReading}, and a reading with the AR camera's pose into the bearing
 * the calibration pairs with that pose ({@link pairCompassWithPose}).
 *
 * ## Every web compass heading is MAGNETIC north
 *
 * Apple documents `webkitCompassHeading` as a direction relative to magnetic north, and a negative value
 * as invalid
 * (https://developer.apple.com/documentation/webkitjs/deviceorientationevent/1804777-webkitcompassheading).
 * An absolute `alpha` on Android is measured in the sensor frame whose Y axis "points towards magnetic
 * north" (https://developer.android.com/reference/android/hardware/SensorEvent, the rotation vector), and
 * Chrome's `deviceorientationabsolute` is the magnetometer-based behaviour it split out of
 * `deviceorientation` (https://developer.chrome.com/blog/device-orientation-changes). Nothing here applies a
 * declination, so a reading is {@link NorthReference} `'magnetic'` and says so. A bearing from true north
 * needs the local declination added, and nothing in the app supplies one yet: a compass bearing is not a
 * true bearing.
 *
 * ## Android: the direction the camera points, from the full rotation
 *
 * The event's `alpha`, `beta` and `gamma` are intrinsic Tait-Bryan angles of type Z-X'-Y'' (W3C Device
 * Orientation and Motion, https://www.w3.org/TR/orientation-event/, section 3.1). The device frame is
 * right-handed with `x` to the right of the screen, `y` up the screen and `z` out of the screen, fixed to
 * the device in its natural orientation: turning the screen does not change it. The earth frame is `x` east,
 * `y` north, `z` up. The rotation that takes device vectors to earth vectors is
 *
 *     R = Rz(alpha) Rx(beta) Ry(gamma)
 *
 * and its columns are what the angles mean. Writing `cA` for cos(alpha), `sA` for sin(alpha), and the same
 * for beta (`B`) and gamma (`G`):
 *
 *     camera (device -Z)  =  R (0, 0, -1)  =  (-cA sG - sA sB cG,  -sA sG + cA sB cG,  -cB cG)
 *     top edge (device +Y) =  R (0, 1,  0)  =  (-sA cB,              cA cB,              sB)
 *     up (earth up, in device axes)        =  (-cB sG,             sB,                cB cG)
 *
 * in (east, north, up) for the first two. The camera line is the specification's own `compassHeading()`
 * example (appendix A.1), which flattens it and takes the bearing, `atan2(east, north)`.
 *
 * `360 - alpha` is the bearing of the TOP EDGE, not of the camera. The top edge's horizontal part is
 * `cB (-sA, cA)`, so for `|beta| < 90` its bearing is exactly `-alpha` whatever `gamma` is. The camera's
 * bearing is the same when the phone is not rolled (`gamma` 0 and `beta` between 0 and 180: upright or tipped
 * back, at any tilt). Roll it into landscape (`gamma` near +-90) and `360 - alpha` is a quarter turn from
 * where the camera looks; upright and leaning 10 degrees to one side (`beta` 90, `gamma` 10) it is 10
 * degrees out. {@link headingFromAttitude} takes the bearing of the camera's own axis instead, and
 * `GeoTracker` publishes that on Android.
 *
 * ## Which axis, and when there is none
 *
 * A direction that is nearly vertical has no reliable bearing: its horizontal part is short, so a small
 * error in the attitude is a large one in the heading (to first order the heading error is the attitude
 * error divided by the horizontal part: twice as large at 0.5, ten times at 0.1). So the camera axis is
 * used while at least {@link MIN_AXIS_HORIZONTAL} of it is horizontal, which is a camera within 60 degrees
 * of the horizon;
 * past that the top edge is used, which is then within 30 degrees of the horizon, and the reading says
 * which it was ({@link HeadingAxis}). Both cannot be near vertical at once: they are at right angles, so
 * when the camera axis is steeper than 60 degrees the top edge's horizontal part is at least sqrt(3)/2.
 * Every finite attitude therefore has a heading; the sample is discarded (`null`) only when an angle is not a
 * finite number, which the tests check over a dense grid.
 *
 * ## Pairing a heading with the AR camera
 *
 * The calibration does not use a heading on its own. It adds the yaw of the SAME direction in the AR
 * session's frame to it, which gives the bearing of the session's +Z axis (`sessionFrameBearingDeg` in
 * ../world/geo.ts: a direction at session yaw `y` has the bearing `B_Z - y`).
 *
 * The camera's forward direction is the one axis the browser's frame and the AR runtime's agree on without
 * knowing how either turns about the screen's normal when the screen is rotated: it is device -Z in one and
 * the pose's -Z in the other. A heading of the camera axis is therefore paired with the camera's forward yaw
 * as it stands, and so is an iPhone's heading, as it always was (which axis that follows is not established).
 *
 * A heading of the TOP EDGE is not. It has to be paired with the yaw of the same edge, and which axis of the
 * pose's frame that is depends on how the two frames are turned against each other about the screen's
 * normal, which nobody has measured on these phones (DX3). That turn can be read, though, from the one
 * direction both frames see without a compass: gravity. A phone held at an angle sees gravity as an arrow
 * lying in the plane of its screen, and the browser's frame and the AR pose's frame see that arrow at angles
 * that differ by the turn between them. {@link pairCompassWithPose} measures that turn and carries a top-edge
 * heading to the camera's forward direction through it, but only when the turn is a quarter turn or none
 * (within {@link MAX_SCREEN_TURN_RESIDUAL_DEG}), the arrow is long enough to read
 * ({@link MIN_GRAVITY_IN_SCREEN_PLANE}), and the two sources agree on how far the phone is tipped
 * ({@link MAX_GRAVITY_DISAGREEMENT_DEG}). Otherwise it returns `null`: no compass bearing, which the
 * calibration treats as no compass, rather than one that may be a quarter turn out. The arrow is too short
 * when the camera points within about 17 degrees of straight up or down (the phone lies nearly flat), a
 * posture in which the camera has no bearing to speak of.
 *
 * ## What an iPhone follows is not known
 *
 * Apple says the heading is "relative to magnetic north" and nothing about which axis of a tilted phone it
 * follows, so an iOS reading says `axis: 'unknown'` and carries a floor on its uncertainty
 * ({@link IOS_COMPASS_SIGMA_FLOOR_DEG}) until the device test (docs/testing/DEVICE_TESTING.md, Procedure 4,
 * DX3) has compared it with the other axes. The raw sample ({@link CompassSample}) keeps `alpha`, `beta` and
 * `gamma` of the same event for that comparison.
 *
 * ## The earlier rule, `?compass=alpha`
 *
 * Until this module the app took `360 - alpha` on Android, whatever the tilt. `?compass=alpha`
 * ({@link compassRuleFromSearch}) selects it again, so that one phone can run both rules, and so that a
 * device whose angles turn out not to follow the W3C frame is not stuck with the new rule while DX3 is
 * being read. Its readings say `axis: 'unknown'`: that number is the top edge's bearing for a phone lying
 * flat and the camera's only while the phone is not rolled, so no axis is claimed for it, and it is paired
 * with the camera's forward yaw as it always was.
 */
import { cameraYawInSessionDeg, normaliseBearingDeg } from '../world/geo.ts'
import type { Quat } from '../world/types.ts'

/**
 * What a compass heading counts from. Only magnetic north exists on the web today, so the type has one member
 * and a reader can see that the field is deliberate: a platform that starts delivering true north would add
 * `'true'` here, and everything that adds a declination would then have to look at it.
 */
export type NorthReference = 'magnetic'

/**
 * The axis of the phone a heading is the bearing of.
 *
 *  - `'camera'`: where the back camera points (device -Z), flattened onto the horizontal plane.
 *  - `'top'`: where the top edge of the screen points (device +Y), flattened. Used when the camera points
 *    too steeply up or down for its own bearing to be reliable, and for a sample that reports no tilt.
 *  - `'unknown'`: the platform worked it out and does not say. Every iPhone heading, and every heading under
 *    the earlier rule (`?compass=alpha`).
 */
export type HeadingAxis = 'camera' | 'top' | 'unknown'

/**
 * Where a reading came from: `webkitCompassHeading` on iOS, the angles of an absolute orientation event
 * elsewhere. `HeadingSource` in ../capture/phone-telemetry-sender.ts names the same two sensor paths for that
 * sender's own rule, which takes `alpha` alone (`'absolute-alpha'`). The spellings differ because the rules
 * do: this module reads all three angles, and `'absolute-alpha'` would say it does not.
 */
export type CompassSource = 'ios-compass' | 'android-absolute'

/** One compass reading, with the bookkeeping a later step needs to use it: which north, which axis, how sure. */
export interface CompassReading {
  /** Degrees clockwise from {@link CompassReading.northReference}, in [0, 360). */
  headingDeg: number
  northReference: NorthReference
  axis: HeadingAxis
  source: CompassSource
  /**
   * The platform's own accuracy figure in degrees (iOS `webkitCompassAccuracy`, plus or minus), or null when
   * it gives none. Null is unknown, never perfect.
   */
  accuracyDeg: number | null
  /**
   * The uncertainty in degrees a bearing seeded from this reading has to carry, or null when none has been
   * adopted: the platform's figure, but no less than {@link IOS_COMPASS_SIGMA_FLOOR_DEG}, on iOS. Null on
   * Android: no figure exists there and none is invented.
   */
  sigmaDeg: number | null
}

/** The fields of one orientation event, as the browser delivered them: `null` where the event had no such field. */
export interface OrientationRaw {
  alpha: number | null
  beta: number | null
  gamma: number | null
  /**
   * `DeviceOrientationEvent.absolute`: whether the angles are measured from the earth's frame or from an
   * arbitrary one. `null` when the event has no such property, which is every event on an iPhone: Safari on
   * iOS does not implement it (MDN browser-compat-data, api.DeviceOrientationEvent.absolute, safari_ios:
   * false), so a missing flag is "the browser did not say", never `false`.
   */
  absolute: boolean | null
  webkitCompassHeading: number | null
  webkitCompassAccuracy: number | null
}

/** The last event that said something about the compass, and what was made of it (null: nothing, it was refused). */
export interface CompassSample {
  raw: OrientationRaw
  reading: CompassReading | null
}

/**
 * Which rule turns an Android event into a heading: `'attitude'`, the camera's (or the top edge's) bearing
 * from all three angles, or `'alpha'`, the earlier `360 - alpha`. The default is `'attitude'`.
 */
export type CompassRule = 'attitude' | 'alpha'

/**
 * The rule a page runs under. `?compass=alpha` selects the earlier `360 - alpha` heading, so one phone can
 * compare the two and a device whose angles do not follow the W3C frame has a way back while it is being
 * read. Anything else, or no parameter, is the default. `search` is a parameter and not `location.search` so
 * this stays pure.
 */
export function compassRuleFromSearch(search: string): CompassRule {
  return new URLSearchParams(search).get('compass') === 'alpha' ? 'alpha' : 'attitude'
}

/**
 * How much of an axis has to lie in the horizontal plane for its bearing to be trusted: 1 is level, 0 is
 * vertical, and 0.5 is within 60 degrees of the horizon. Adopted, not measured (ADR 0005 rule 5): it keeps
 * the heading error to at most twice the attitude error (see above), and nobody has measured how the
 * compass error grows with tilt on these phones. Revisit when DX3 has logged tilted readings.
 */
export const MIN_AXIS_HORIZONTAL = 0.5

/**
 * Slack, in the same unit, so that an axis exactly on the line (a camera pitched 60 degrees, which is the
 * posture of a tap on the floor) is on the camera's side whatever the last bit of the arithmetic does:
 * cos(60 degrees) is 0.5000000000000001 and a few orderings of the same sum give 0.49999999999999994. Far
 * below anything a sensor resolves: a numerical guard and not a threshold. Adopted, not measured (ADR 0005 rule 5).
 */
const ROUNDING_GUARD = 1e-9

/**
 * The least uncertainty, in degrees, an iPhone compass reading is given. Adopted, not measured (ADR 0005 rule 5):
 * nothing has measured an iPhone's heading against a known bearing, or told whether it follows the camera or the
 * top edge of a tilted phone (a quarter turn apart in landscape). Replace it with the spread Procedure 4 of
 * docs/testing/DEVICE_TESTING.md (DX3) gives.
 */
export const IOS_COMPASS_SIGMA_FLOOR_DEG = 25

/**
 * How much of the gravity direction has to lie in the plane of the screen, on each side, for the turn between
 * the browser's frame and the AR pose's frame to be read from it: 1 when the phone stands upright, 0 when it
 * lies flat, so it is also the horizontal part of the camera axis (0.3 is a camera 72.5 degrees from the
 * horizon). An attitude error of a degree or two moves the arrow's direction by that error divided by its
 * length, so a short arrow is read with a large error and the quarter turn being told from none is lost: at 0.3
 * a degree and a half is about 5 degrees, at 0.1 it is 15. Adopted, not measured (ADR 0005 rule 5): the
 * tilt error of these phones' sensors and the AR runtimes' poses is not known. Revisit with the `turn`
 * column of the probe line (`screenTurnDeg`), which DX3 reads off a phone in every posture.
 */
export const MIN_GRAVITY_IN_SCREEN_PLANE = 0.3

/**
 * How far, in degrees, the measured turn between the two frames may be from the nearest quarter turn (0, 90,
 * 180 or 270) and still be taken for it. The two frames are expected to differ by a multiple of a quarter turn
 * (a screen has four ways up). A turn further from one than this says the two sources do not describe one attitude
 * (a stale compass event, a frame that was reset, a phone moving fast), and the pairing is refused. 20 degrees
 * leaves room for sensor latency at the shortest arrow allowed (a phone turning at 60 degrees a second, read
 * 100 ms apart by the two sources, is 6 degrees of tilt apart, which turns an arrow 0.3 long by 6 / 0.3 = 20
 * degrees) and is well inside the 45 at which the nearest quarter turn would be the wrong one.
 * Adopted, not measured (ADR 0005 rule 5); revisit with the `turn` column of the probe line.
 */
export const MAX_SCREEN_TURN_RESIDUAL_DEG = 20

/**
 * How far apart, in degrees, the two sources' gravity directions may be once the turn between their frames is
 * taken out: how far they disagree about how the phone is tipped. The direction check above reads the turn
 * about the screen's normal and cannot see a disagreement about the tilt itself (a compass event from before the
 * phone was raised, a pose from after), which would pair a top edge from one posture with a pose from another.
 * 15 degrees is the ordinary error of the two (a few degrees each) and the latency skew above (6 degrees),
 * with room. Adopted, not measured (ADR 0005 rule 5); revisit with the `turn` column of the probe line.
 */
export const MAX_GRAVITY_DISAGREEMENT_DEG = 15

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/** The heading of one axis of the phone, and which axis it was. */
export interface AttitudeHeading {
  /** Degrees clockwise from the sensor's north, in [0, 360). */
  headingDeg: number
  axis: 'camera' | 'top'
}

/**
 * The horizontal parts of the camera axis and the cosine of beta, for angles in degrees, from the closed forms
 * in the header. `east` and `north` are the camera axis's; `cB` scales the top edge's horizontal part.
 */
function attitudeParts(alphaDeg: number, betaDeg: number, gammaDeg: number): { east: number, north: number, cB: number } {
  const a = alphaDeg * DEG_TO_RAD
  const b = betaDeg * DEG_TO_RAD
  const g = gammaDeg * DEG_TO_RAD
  const cA = Math.cos(a)
  const sA = Math.sin(a)
  const cB = Math.cos(b)
  const sB = Math.sin(b)
  const cG = Math.cos(g)
  const sG = Math.sin(g)
  return { east: -cA * sG - sA * sB * cG, north: -sA * sG + cA * sB * cG, cB }
}

/**
 * The top edge's bearing from alpha and the sign of `cB`: a direction at bearing `-alpha`, or the opposite one
 * for a phone turned over (`cB < 0`). Written out, not through atan2, so that the flat phone's `360 - alpha`
 * stays that number to the last digit.
 */
function topEdgeHeadingDeg(alphaDeg: number, cB: number): number {
  return normaliseBearingDeg(cB > 0 ? -alphaDeg : 180 - alphaDeg)
}

/**
 * The compass heading of a phone whose attitude is `alpha`, `beta`, `gamma` degrees (the W3C Euler angles,
 * see the header): the bearing of the camera axis when it is within 60 degrees of the horizon, else of the
 * top edge, else `null`. `null` is the discard: an angle that is not a finite number has no rotation behind
 * it. (No finite attitude is discarded for its shape: see the header.)
 *
 * Any finite angles are a rotation, so values outside the specification's ranges (`beta` -180 to 180, `gamma`
 * -90 to 90) are not refused: the same attitude has a second set of angles inside them, and both give the same
 * heading.
 */
export function headingFromAttitude(alphaDeg: number, betaDeg: number, gammaDeg: number): AttitudeHeading | null {
  if (!Number.isFinite(alphaDeg) || !Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) return null
  // The camera axis, flattened: R (0, 0, -1) without its vertical part.
  const { east, north, cB } = attitudeParts(alphaDeg, betaDeg, gammaDeg)
  if (Math.hypot(east, north) >= MIN_AXIS_HORIZONTAL - ROUNDING_GUARD) {
    return { headingDeg: normaliseBearingDeg(Math.atan2(east, north) * RAD_TO_DEG), axis: 'camera' }
  }

  // The top edge, flattened: R (0, 1, 0) without its vertical part is cB (-sA, cA).
  if (Math.abs(cB) >= MIN_AXIS_HORIZONTAL - ROUNDING_GUARD) {
    return { headingDeg: topEdgeHeadingDeg(alphaDeg, cB), axis: 'top' }
  }
  return null
}

/** One axis of the phone, flattened onto the horizontal plane. */
export interface AxisHeading {
  /** Degrees clockwise from the sensor's north, in [0, 360). `null` for an axis that is vertical: it has no bearing. */
  headingDeg: number | null
  /** How much of the axis lies in the horizontal plane: 1 is level, 0 is vertical. */
  horizontal: number
}

/** Both axes of the phone, each with its own bearing, whether or not it is the one {@link headingFromAttitude} would use. */
export interface AxisHeadings {
  camera: AxisHeading
  top: AxisHeading
}

/**
 * The bearing of the camera axis and of the top edge for one attitude, with how much of each is horizontal,
 * with none of the choosing {@link headingFromAttitude} does. It is for working out, afterwards, which axis a
 * heading followed (an iPhone's, Procedure 4 of docs/testing/DEVICE_TESTING.md): the candidate to compare
 * with has to be the axis itself, and not whichever axis the rule would have picked, which past 60 degrees
 * is the other one. An axis that is exactly vertical has no bearing (`headingDeg` null). `null` for an angle
 * that is not a finite number.
 */
export function axisHeadingsFromAttitude(alphaDeg: number, betaDeg: number, gammaDeg: number): AxisHeadings | null {
  if (!Number.isFinite(alphaDeg) || !Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) return null
  const { east, north, cB } = attitudeParts(alphaDeg, betaDeg, gammaDeg)
  const cameraHorizontal = Math.hypot(east, north)
  const topHorizontal = Math.abs(cB)
  return {
    camera: {
      headingDeg: cameraHorizontal > ROUNDING_GUARD ? normaliseBearingDeg(Math.atan2(east, north) * RAD_TO_DEG) : null,
      horizontal: cameraHorizontal,
    },
    top: {
      headingDeg: topHorizontal > ROUNDING_GUARD ? topEdgeHeadingDeg(alphaDeg, cB) : null,
      horizontal: topHorizontal,
    },
  }
}

/** An angle the event may not carry: it reads as 0, as the specification's own `compassHeading()` example reads a null one. */
function tiltOf(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

type EventWithWebkitCompass = DeviceOrientationEvent & { webkitCompassHeading?: number, webkitCompassAccuracy?: number }

/**
 * What one orientation event says about the compass: a {@link CompassReading}, `null` when the event says the
 * compass cannot be trusted right now, or `undefined` when it says nothing about it (a relative-alpha event,
 * which counts from an arbitrary direction fixed at page load).
 *
 * iOS: `webkitCompassHeading`, degrees clockwise from magnetic north. A negative heading is invalid, as Apple
 * documents, and so is a negative `webkitCompassAccuracy` (-1 means the compass is not calibrated:
 * https://developer.apple.com/documentation/webkitjs/deviceorientationevent/1804769-webkitcompassaccuracy);
 * neither is published as a bearing. A heading that is not a finite number is no bearing either (it would
 * otherwise ride into the stored fix and the editor as `NaN`).
 *
 * Android: an event that declares itself absolute, read through {@link headingFromAttitude}. An `alpha` that is
 * not a number says nothing; one that is a number but not a finite one, or a `beta` or `gamma` that is, is a
 * discarded sample (`null`). A `beta` or `gamma` the event does not carry reads as 0, so an event that
 * reports no tilt is a flat phone and gives its top edge's heading, `360 - alpha`, named as the top edge. Under
 * `rule` `'alpha'` it is `360 - alpha` whatever the tilt, with no axis claimed.
 */
export function compassReadingFromEvent(e: DeviceOrientationEvent, rule: CompassRule = 'attitude'): CompassReading | null | undefined {
  const ios = e as EventWithWebkitCompass
  if (typeof ios.webkitCompassHeading === 'number') {
    const heading = ios.webkitCompassHeading
    const accuracy = ios.webkitCompassAccuracy
    if (!Number.isFinite(heading) || heading < 0) return null
    if (typeof accuracy === 'number' && accuracy < 0) return null
    const accuracyDeg = typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null
    return {
      headingDeg: heading >= 360 ? heading % 360 : heading,
      northReference: 'magnetic',
      axis: 'unknown',
      source: 'ios-compass',
      accuracyDeg,
      sigmaDeg: Math.max(IOS_COMPASS_SIGMA_FLOOR_DEG, accuracyDeg ?? 0),
    }
  }
  if (e.absolute && typeof e.alpha === 'number') {
    if (rule === 'alpha') {
      if (!Number.isFinite(e.alpha)) return null
      return {
        headingDeg: normaliseBearingDeg(360 - e.alpha),
        northReference: 'magnetic',
        axis: 'unknown',
        source: 'android-absolute',
        accuracyDeg: null,
        sigmaDeg: null,
      }
    }
    const attitude = headingFromAttitude(e.alpha, tiltOf(e.beta), tiltOf(e.gamma))
    if (attitude === null) return null
    return {
      headingDeg: attitude.headingDeg,
      northReference: 'magnetic',
      axis: attitude.axis,
      source: 'android-absolute',
      accuracyDeg: null,
      sigmaDeg: null,
    }
  }
  return undefined
}

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null)

/** The fields of one orientation event that bear on the compass, exactly as delivered (a field that is not a number is `null`). */
export function rawOrientationOf(e: DeviceOrientationEvent): OrientationRaw {
  const ios = e as EventWithWebkitCompass
  return {
    alpha: numberOrNull(e.alpha),
    beta: numberOrNull(e.beta),
    gamma: numberOrNull(e.gamma),
    absolute: typeof e.absolute === 'boolean' ? e.absolute : null,
    webkitCompassHeading: numberOrNull(ios.webkitCompassHeading),
    webkitCompassAccuracy: numberOrNull(ios.webkitCompassAccuracy),
  }
}

/** Earth up as each source sees it, in that source's own axes. */
interface GravityPair {
  /** In the browser's device frame: the third row of R = Rz(alpha) Rx(beta) Ry(gamma), which alpha does not enter. */
  device: { x: number, y: number, z: number }
  /** In the AR pose's camera frame: the second row of the pose's rotation matrix, the session's +Y in camera axes. */
  camera: { x: number, y: number, z: number }
}

/** The two gravity directions of a sample and a pose, or `null` when the sample has no `beta` or no `gamma` (a missing tilt reads as flat for a heading, which is no measurement of gravity). */
function gravityPair(raw: OrientationRaw | null | undefined, cameraRotation: Quat): GravityPair | null {
  if (!raw || typeof raw.beta !== 'number' || typeof raw.gamma !== 'number') return null
  const b = raw.beta * DEG_TO_RAD
  const g = raw.gamma * DEG_TO_RAD
  const { x, y, z, w } = cameraRotation
  return {
    device: { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) },
    camera: { x: 2 * (x * y + z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z - x * w) },
  }
}

/** The turn between the two frames from a pair of gravity directions, or `null` when either arrow is too short to read it from or the numbers are not finite. */
function turnOf(gravity: GravityPair): number | null {
  const { device, camera } = gravity
  if (!(Math.hypot(device.x, device.y) >= MIN_GRAVITY_IN_SCREEN_PLANE) || !(Math.hypot(camera.x, camera.y) >= MIN_GRAVITY_IN_SCREEN_PLANE)) return null
  const turn = normaliseBearingDeg((Math.atan2(device.y, device.x) - Math.atan2(camera.y, camera.x)) * RAD_TO_DEG + 180) - 180
  return Number.isFinite(turn) ? turn : null
}

/**
 * The turn, in degrees in [-180, 180), between the browser's frame and the AR pose's frame about the screen's
 * normal, read from the direction of gravity each sees in the plane of the screen. The angle of any direction
 * in that plane (from the screen's x axis towards its y axis, counter-clockwise seen from the front of the
 * screen) is this much greater in the browser's device frame than in the pose's camera frame. 0 when the two
 * frames are the same, 90 or -90 when one of them follows the screen into landscape and the other does not.
 * The sample's `beta` and `gamma` give gravity in the device frame (`up` in the header), and the pose's
 * rotation gives it in the camera frame (the second row of the rotation matrix: the session's +Y, in camera
 * axes).
 *
 * `null` when it cannot be read: the sample has no `beta` or no `gamma` (a missing tilt reads as flat for a
 * heading, which is no measurement of gravity), either side's arrow has less than
 * {@link MIN_GRAVITY_IN_SCREEN_PLANE} of gravity in the screen's plane, or a number is not finite. The value is
 * not rounded to a quarter turn: it is what the probe line logs (`turn`), so a device test sees the residual.
 */
export function screenTurnDeg(raw: OrientationRaw | null | undefined, cameraRotation: Quat): number | null {
  const gravity = gravityPair(raw, cameraRotation)
  return gravity === null ? null : turnOf(gravity)
}

/**
 * How a compass heading was paired with the camera's pose.
 *
 *  - `'camera'`: the heading is the camera axis's own, and is used as it is.
 *  - `'top'`: the heading is the top edge's, carried to the camera's forward direction through the measured
 *    turn between the two frames (see the header).
 *  - `'platform'`: the heading's axis is not established (an iPhone's own heading, or any heading under the
 *    earlier rule), and it is used as the camera's, as it always was.
 */
export type CompassPairing = 'camera' | 'top' | 'platform'

/** A compass bearing in the form the calibration needs, and how it was got. */
export interface PairedCompass {
  /**
   * Degrees clockwise from magnetic north, in [0, 360): the bearing the camera's forward direction has, so that
   * adding the camera's forward yaw in the session (`sessionFrameBearingDeg`) gives the bearing of the
   * session's +Z axis. For `via` `'top'` it is not a measurement of the camera's own axis: it is what that
   * axis's bearing would have to be for the sum to be the session's true bearing, worked out from the top edge.
   */
  bearingDeg: number
  via: CompassPairing
}

/**
 * The compass bearing to hand the calibration, from the last orientation sample and the AR camera's pose
 * (`rotation`, camera to session, read at the same instant), or `null` when there is none that can be paired
 * with that pose.
 *
 * A camera-axis heading, and an iPhone's own, stand as they are. A top-edge heading is carried to the camera's
 * forward direction: the session's +Z bearing is the top edge's bearing plus the session yaw of the top edge,
 * which is the pose's rotation applied to where the top edge is in the camera's frame (its turn from the
 * frames' own `y` axes, {@link screenTurnDeg} rounded to a quarter turn), and the bearing returned is that
 * sum less the camera's forward yaw. `null` when the turn cannot be read, is not within
 * {@link MAX_SCREEN_TURN_RESIDUAL_DEG} of a quarter turn, or the two sources disagree about the tilt by more
 * than {@link MAX_GRAVITY_DISAGREEMENT_DEG}: see the header.
 */
export function pairCompassWithPose(sample: CompassSample | null | undefined, cameraRotation: Quat): PairedCompass | null {
  const reading = sample?.reading
  if (!sample || !reading) return null
  if (reading.axis === 'camera') return { bearingDeg: reading.headingDeg, via: 'camera' }
  if (reading.axis === 'unknown') return { bearingDeg: reading.headingDeg, via: 'platform' }

  const gravity = gravityPair(sample.raw, cameraRotation)
  const turn = gravity === null ? null : turnOf(gravity)
  if (gravity === null || turn === null) return null
  const quarters = Math.round(turn / 90)
  if (Math.abs(turn - quarters * 90) > MAX_SCREEN_TURN_RESIDUAL_DEG) return null
  // The top edge in the camera's frame is (0, 1, 0) turned back by `turn`: (sin, cos, 0) of a quarter turn, exactly.
  const slot = ((quarters % 4) + 4) % 4
  const edgeX = [0, 1, 0, -1][slot]!
  const edgeY = [1, 0, -1, 0][slot]!
  if (!(tiltGapDeg(gravity, edgeX, edgeY) <= MAX_GRAVITY_DISAGREEMENT_DEG)) return null
  // That direction in the session: the pose's rotation applied to it, which is a combination of the matrix's first two columns.
  const { x, y, z, w } = cameraRotation
  const sessionX = edgeX * (1 - 2 * (y * y + z * z)) + edgeY * 2 * (x * y - z * w)
  const sessionZ = edgeX * 2 * (x * z - y * w) + edgeY * 2 * (y * z + x * w)
  const edgeYaw = Math.atan2(sessionX, sessionZ) * RAD_TO_DEG
  const forwardYaw = cameraYawInSessionDeg(cameraRotation)
  const bearingDeg = normaliseBearingDeg(reading.headingDeg + edgeYaw - forwardYaw)
  return Number.isFinite(bearingDeg) ? { bearingDeg, via: 'top' } : null
}

/**
 * The angle in degrees between the two sources' gravity directions once the browser's is turned into the
 * camera's frame by the turn `(edgeX, edgeY)` = (sin, cos): zero when they describe the same tilt, and the
 * tilt error or the skew between them otherwise.
 */
function tiltGapDeg(gravity: GravityPair, edgeX: number, edgeY: number): number {
  const { device, camera } = gravity
  const turned = { x: edgeY * device.x + edgeX * device.y, y: -edgeX * device.x + edgeY * device.y, z: device.z }
  const dot = turned.x * camera.x + turned.y * camera.y + turned.z * camera.z
  const lengths = Math.hypot(turned.x, turned.y, turned.z) * Math.hypot(camera.x, camera.y, camera.z)
  return Math.acos(Math.max(-1, Math.min(1, dot / lengths))) * RAD_TO_DEG
}
