/**
 * The calibration floor gate — is a tapped point plausibly on the tracked
 * ground plane? (Wave 09 ticket 0003.)
 *
 * Its own module rather than a private helper inside project-calibration.ts
 * because that file references `TouchEvent`, `PointerEvent` and
 * `HTMLCanvasElement`; importing it into a Deno test drags DOM lib types in
 * and fails type-checking (ADR 0002). Keeping the decision pure and separate
 * is what makes the threshold testable at all — and this threshold is the one
 * most likely to need retuning against real device data.
 */
import type { GroundEstimate } from '../scene/pointcloud.ts'
import type { Vec3 } from '../world/types.ts'

/**
 * How far a tap may sit from the tracked floor before it is questioned.
 *
 * Comfortably clears a real floor tap including carpet, floor slope and
 * hit-test noise; comfortably rejects a tabletop (~0.75 m) or a chair seat
 * (~0.45 m).
 *
 * **Adopted by decision, not by measurement.** Ticket 0006 was closed without
 * running the room-loop benchmark that was to set this, so no device data
 * backs 0.25 and none is pending.
 *
 * The margin to a chair seat is not large, so a worse-than-assumed hit-test
 * noise figure narrows the usable window quickly — which is why the caller
 * offers an override rather than treating a rejection as final, and why that
 * override must stay.
 *
 * **Revisit when:** users are told a genuine floor tap is "cm above the
 * floor".
 *
 * That symptom used to have a likelier cause than this constant:
 * `estimateFloorY()` was an 8th-percentile of the point cloud and had been
 * observed ~0.8 m out on a real capture. Wave 09 ticket 0008 replaced it with a
 * supported fit, so a false rejection now points here more directly than it
 * did — but check first anyway, because the estimator can still be wrong in two
 * ways it now reports rather than hides: read
 * `groundEstimate().residualM` (a tilted floor, from a bad gravity estimate,
 * which no horizontal fit can correct) and `inlierCount` (a floor barely seen
 * at all). The floor overlay added in #166 shows the same thing visually. Only
 * widen this once those say the estimate is sound.
 */
export const GROUND_TAP_TOLERANCE_M = 0.25

/**
 * Whether `tapY` is consistent with a floor at `groundY`, both in the AR
 * session's local metres.
 *
 * `groundY === null` (no estimate yet) returns `true`: the gate has no opinion
 * where it has no data, and must never block calibration in a room too
 * feature-poor to map a floor.
 */
export function isTapOnGround(tapY: number, groundY: number | null): boolean {
  if (groundY === null) return true
  return Math.abs(tapY - groundY) <= GROUND_TAP_TOLERANCE_M
}

/**
 * Signed height relative to the floor estimate, in centimetres, for UI copy.
 * Positive is above the floor, negative below — a below-floor hit is real
 * (a gap in the mesh, a reflective surface, or an over-high estimate) and
 * reporting it as "above" would send the user looking in the wrong direction.
 */
export function tapHeightAboveGroundCm(tapY: number, groundY: number): number {
  return Math.round((tapY - groundY) * 100)
}

/**
 * Whether a retry is at the same height as the tap that was just rejected —
 * the confirmation the off-floor override actually asks for.
 *
 * The override exists so a user whose floor estimate is wrong (thick carpet, a
 * mezzanine, a sunken room) can insist on a height. Honouring *any* second tap
 * would let a rejected tabletop tap be confirmed by a tap on a shelf a metre
 * higher, which is not what the user was asked to confirm and not what they
 * would think they had done.
 *
 * Reuses GROUND_TAP_TOLERANCE_M: "the same height" and "close enough to the
 * floor" are the same order of judgement, and a second constant here would be
 * one more thing to retune with no independent meaning.
 */
export function isSameHeightRetry(tapY: number, rejectedTapY: number | null): boolean {
  if (rejectedTapY === null) return false
  return Math.abs(tapY - rejectedTapY) <= GROUND_TAP_TOLERANCE_M
}

// ── The fitted floor as a second opinion on a tap (WP-05a) ──────────────────
//
// The gate above asks whether a tap is roughly on the floor. What follows asks
// whether the fitted floor can be trusted to do more: to cross-check where a
// tap landed, to set the frame's floor height, and to stand in for a tap that
// found nothing. The first thing to settle is whether the fit deserves it.

/**
 * The part of `PointCloud.groundEstimate()` these helpers read. Structural, so
 * the `ground` getter `runProjectCalibration` takes passes straight in.
 */
export type GroundReading = Pick<GroundEstimate, 'y' | 'locked' | 'inlierCount' | 'residualM' | 'fallback'>

/**
 * Largest RMS height scatter, in metres, a floor fit may show and still be
 * trusted as the floor. `residualM` is measured over the points within 5 cm
 * (pointcloud.ts, `FLOOR_BAND_M`) either side of the chosen band's centre, so it
 * cannot read above about 2.9 cm (5 cm / sqrt 3, for points spread evenly across
 * the band). A floor whose points hug the fit reads well under 2 cm, and one that
 * fills its band, as a tilted or smeared floor does, reads near that ceiling.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** The figure is the work package's
 * (2 cm). DX5 logs `residualM` and tilt across a 6 m room and sets it.
 */
export const FLOOR_FIT_MAX_RESIDUAL_M = 0.02

/**
 * Fewest points a fit must rest on to be trusted as the floor.
 *
 * Derived from two numbers pointcloud.ts documents, not measured: a band needs
 * 4 % of the cloud (`FLOOR_MIN_BAND_SHARE`), and below about 1000 points a
 * structureless cloud can still produce a chance band. 4 % of 1000 is 40.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** DX5 sets it.
 */
export const FLOOR_FIT_MIN_INLIERS = 40

/**
 * Whether a floor reading can be used as more than a gate: locked, a real band
 * and not the percentile fallback, enough support, and a small residual. A
 * reading missing its residual or support is not trusted, it is not assumed
 * good.
 */
export function floorFitIsReliable(ground: GroundReading | null | undefined): ground is GroundReading {
  if (!ground || !ground.locked || ground.fallback === true) return false
  if (!Number.isFinite(ground.y)) return false
  const { residualM, inlierCount } = ground
  return (
    typeof residualM === 'number' && Number.isFinite(residualM) && residualM <= FLOOR_FIT_MAX_RESIDUAL_M &&
    typeof inlierCount === 'number' && inlierCount >= FLOOR_FIT_MIN_INLIERS
  )
}

/**
 * How far a landmark tap and the fitted floor may sit apart, in metres, and
 * still be read as two measurements of one floor (5 cm, the work package's).
 *
 * **Adopted, not measured (ADR 0005 rule 5).** DX5's tap-height spread on
 * carpet and hard floor sets it.
 */
export const FLOOR_DATUM_AGREE_M = 0.05

/** What a landmark whose floor height rests on its own tap alone is called. */
export const FLOOR_DATUM_SINGLE_TAP_FLAG = 'floor datum from a single tap'

/**
 * What a landmark whose floor height is the fitted floor's, because no hit measured a height of its own, is
 * called: the tap was placed by the floor ray (./tap-sampling.ts), so it is on the fit by construction and says
 * nothing about it.
 */
export const FLOOR_DATUM_FIT_ONLY_FLAG = 'floor datum from the fitted floor, no tap height'

/** The floor height a landmark gives the frame, and what backed it. */
export interface LandmarkDatum {
  /** Session-space height the frame takes as the floor, metres. */
  y: number
  /**
   * `'tap-and-fit'` when a reliable fit agreed with the tap, `'single-tap'` when the tap stood alone, and
   * `'fit-only'` when the floor ray placed the tap and no hit measured its height.
   */
  source: 'tap-and-fit' | 'single-tap' | 'fit-only'
  /** The landmark's height above the fitted floor, signed, when a reliable fit existed and a hit measured it. Null otherwise. */
  landmarkAboveFloorM: number | null
  /** `FLOOR_DATUM_SINGLE_TAP_FLAG` or `FLOOR_DATUM_FIT_ONLY_FLAG` when one tap or the fit stood alone, null when each backed the other. */
  flag: string | null
}

/**
 * The floor height for the frame: the landmark tap alone is one sample, so where
 * a reliable fit agrees with it the datum is the two heights' median (for two
 * numbers, their mean), and where they do not, or no reliable fit exists, it is
 * the tap, flagged. `tapY` is a finite height; `sampleTap()` only returns those.
 *
 * `landmarkAboveFloorM` is recorded whenever the fit was reliable, including
 * when it disagreed, because a landmark 20 cm off a trusted floor is what a
 * later visit most needs to know.
 */
export function landmarkDatum(tapY: number, ground: GroundReading | null | undefined): LandmarkDatum {
  if (!floorFitIsReliable(ground)) {
    return { y: tapY, source: 'single-tap', landmarkAboveFloorM: null, flag: FLOOR_DATUM_SINGLE_TAP_FLAG }
  }
  const above = tapY - ground.y
  if (Math.abs(above) > FLOOR_DATUM_AGREE_M) {
    return { y: tapY, source: 'single-tap', landmarkAboveFloorM: above, flag: FLOOR_DATUM_SINGLE_TAP_FLAG }
  }
  return { y: (tapY + ground.y) / 2, source: 'tap-and-fit', landmarkAboveFloorM: above, flag: null }
}

/**
 * How far, in metres, a tap on the floor and the floor ray through the same
 * pixel may sit apart before they are called two different places (10 cm).
 *
 * **Adopted, not measured (ADR 0005 rule 5).** A feature-point hit snaps to
 * the nearest mapped feature, and the floor gate admits one up to
 * `GROUND_TAP_TOLERANCE_M` (0.25 m) off the floor. Along a ray 33 degrees below
 * the horizon that is 0.25 / tan(33 degrees), about 0.38 m, of ground between
 * the hit and the pixel's true floor point (the investigation's geometry, not a
 * measurement). 10 cm sits above the noise assumed for a tap and well below
 * that. DX5 sets it.
 */
export const FLOOR_RAY_AGREE_M = 0.1

/** Whether a tap and the floor ray through its pixel sit within `FLOOR_RAY_AGREE_M` of each other, the limit included. */
export function floorRayAgrees(deltaM: number): boolean {
  return deltaM <= FLOOR_RAY_AGREE_M
}

/** The camera the AR providers publish: a pose, a vertical field of view in degrees, and width over height. */
export interface RayCamera {
  position: Vec3
  /** Unit quaternion taking camera axes (looking down -Z, +Y up) to session axes, as `main.ts` builds a capture camera. */
  rotation: { x: number; y: number; z: number; w: number }
  fovYDeg: number
  aspect: number
}

/** A point on the fitted floor, and how far from the camera it is. */
export interface FloorRayPoint {
  position: Vec3
  rangeM: number
}

/**
 * Where the camera ray through a screen point meets the floor plane `y = floorY`.
 *
 * `x` and `y` are the normalised canvas coordinates `hitTest()` takes (0,0 at
 * the top left). The ray is the three.js one the rest of the app already uses
 * for a capture camera (`main.ts`, `resolver.ts`): NDC `(2x - 1, 1 - 2y)`, a
 * horizontal half-extent of `aspect * tan(fovY / 2)`, looking down -Z.
 *
 * Nothing snaps: the answer depends on the pose and the intrinsics alone, so a
 * feature-point hit that slid along the ray cannot move it. Its error is then
 * the pose's own: at a camera height h and depression angle a, an orientation
 * error of one degree moves the point by about 0.0175 h / sin^2(a) metres. That
 * is why callers limit the range, and why this is a second opinion until DX5
 * says it can be more.
 *
 * Null when there is no such point: a camera at or below the floor, a ray that
 * does not descend, or an input that is not a number or not a camera.
 */
export function floorRayPoint(camera: RayCamera, x: number, y: number, floorY: number): FloorRayPoint | null {
  const { position: p, rotation: q, fovYDeg, aspect } = camera
  const finite = [x, y, floorY, p.x, p.y, p.z, q.x, q.y, q.z, q.w, fovYDeg, aspect].every(Number.isFinite)
  if (!finite || !(fovYDeg > 0 && fovYDeg < 180) || !(aspect > 0) || !(p.y > floorY)) return null
  const norm = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(norm > 1e-9)) return null

  const tanHalf = Math.tan((fovYDeg * Math.PI) / 360)
  const d = { x: (2 * x - 1) * aspect * tanHalf, y: (1 - 2 * y) * tanHalf, z: -1 }
  const [qx, qy, qz, qw] = [q.x / norm, q.y / norm, q.z / norm, q.w / norm]
  // v' = v + w t + q x t, with t = 2 q x v, q the vector part.
  const tx = 2 * (qy * d.z - qz * d.y)
  const ty = 2 * (qz * d.x - qx * d.z)
  const tz = 2 * (qx * d.y - qy * d.x)
  const dir = {
    x: d.x + qw * tx + (qy * tz - qz * ty),
    y: d.y + qw * ty + (qz * tx - qx * tz),
    z: d.z + qw * tz + (qx * ty - qy * tx),
  }
  if (!(dir.y < -1e-9)) return null

  const t = (floorY - p.y) / dir.y
  return {
    position: { x: p.x + t * dir.x, y: floorY, z: p.z + t * dir.z },
    rangeM: t * Math.hypot(dir.x, dir.y, dir.z),
  }
}
