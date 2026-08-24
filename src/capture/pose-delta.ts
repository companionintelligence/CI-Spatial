/**
 * Pose delta — how far the device has moved and turned since a reference pose.
 *
 * Exists for the room-loop drift benchmark (wave 09 ticket 0006): walk a
 * perimeter, return to a taped floor marker, and read the accumulated SLAM
 * drift straight off the HUD. Sits alongside quality-monitor.ts's metrics
 * rather than inside them — `driftEvents` there counts how often camera
 * *speed* exceeded a threshold, a proxy for drift *risk*; this measures the
 * positional error that actually accumulated.
 *
 * Pure and side-effect free so it is unit-testable without a DOM or an AR
 * runtime (see pose_delta.test.ts).
 *
 * Types come from world/types.ts rather than ar/provider.ts even though
 * `ARProvider.Pose` is the structurally identical shape this is fed at runtime:
 * provider.ts references `HTMLCanvasElement`, so importing from it drags DOM
 * lib types into the Deno test run and fails type-checking (ADR 0002).
 * `PoseLike` is structurally compatible with `Pose`, so callers pass one
 * without a cast.
 */
import type { Quat, Vec3 } from '../world/types'

const RAD_TO_DEG = 180 / Math.PI

/** The pose shape this module needs — structurally `ARProvider`'s `Pose`. */
export interface PoseLike {
  position: Vec3
  rotation: Quat
}

export interface PoseDelta {
  /** Straight-line distance from the reference position, in metres. */
  distanceM: number
  /** Per-axis offset, in metres — useful for telling vertical drift from horizontal. */
  offsetM: { x: number; y: number; z: number }
  /** Signed yaw difference, wrapped to (-180, 180]. Positive is counter-clockwise about +Y. */
  yawDeg: number
}

/**
 * Compass-style heading about the vertical axis, in degrees, from a rotation
 * quaternion — the device's forward axis projected onto the horizontal plane.
 *
 * This is the convention `src/viewer/viewer.ts`'s `updateWorldHud()` already
 * uses (`atan2` of `camera.getWorldDirection()`), and it agrees with
 * `src/world/geo.ts`'s `composeYUpTransform()` and `world/anchor-marker.ts`.
 * Keeping them in agreement matters: a yaw printed by this readout has to mean
 * the same thing as a yaw fed into a calibration transform, or the benchmark
 * measures one convention while the wave tunes another.
 *
 * **Not** the standard Y-Euler extraction, which an earlier version of this
 * used. That formula agrees with the projected-forward heading only when pitch
 * is zero, and the benchmark protocol explicitly has the operator point the
 * device at the floor: at a 50-degree downward hold it reported 20.4 degrees
 * for a true heading of 30, a 9.6-degree error against a benchmark whose
 * rotational drift target is 5. The instrument's own error was nearly twice
 * the threshold it exists to measure.
 *
 * Near-vertical pitch degrades the forward axis's horizontal projection toward
 * zero length, where its direction is noise. The device's up axis is exactly
 * horizontal in that pose and carries the same heading, so whichever of the two
 * has the longer horizontal projection is used. For a yaw-then-pitch rotation
 * both yield the identical angle, so the switch is seamless rather than a step.
 *
 * The up axis must be flipped when the device is tilted back rather than
 * forward: pointing straight down its up axis lies along the heading, but
 * pointing straight up it lies against it, and using it unflipped puts the
 * readout 180 degrees out for exactly half of the poses it exists to rescue.
 *
 * Identity rotation returns 0. Roll is not modelled; a handheld scanning device
 * has little, and "heading" is not well defined under large roll anyway.
 */
export function yawDegFromQuat(q: Quat): number {
  const { x, y, z, w } = q

  // Body +Z (forward) and +Y (up) rotated into world space — the third and
  // second columns of the quaternion's rotation matrix.
  const fx = 2 * (x * z + w * y)
  const fy = 2 * (y * z - w * x)
  const fz = 1 - 2 * (x * x + y * y)
  const ux = 2 * (x * y - w * z)
  const uz = 2 * (y * z + w * x)

  if (Math.hypot(fx, fz) >= Math.hypot(ux, uz)) {
    return Math.atan2(fx, fz) * RAD_TO_DEG
  }
  // Tilted back (forward axis rising) means the up axis points behind the
  // heading, not along it.
  const flip = fy < 0 ? 1 : -1
  return Math.atan2(flip * ux, flip * uz) * RAD_TO_DEG
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180
  // ((-180 + 180) % 360) maps exactly -180 onto -180; normalise to +180 so the
  // range is half-open and a 180-degree turn reads the same whichever way the
  // operator walked around the loop.
  return wrapped === -180 ? 180 : wrapped
}

/**
 * Displacement and turn of `current` relative to `reference`.
 *
 * Returns zeros when the two are the same pose, which is what the readout
 * shows immediately after a session starts.
 */
export function poseDelta(reference: PoseLike, current: PoseLike): PoseDelta {
  const dx = current.position.x - reference.position.x
  const dy = current.position.y - reference.position.y
  const dz = current.position.z - reference.position.z
  return {
    distanceM: Math.hypot(dx, dy, dz),
    offsetM: { x: dx, y: dy, z: dz },
    yawDeg: wrapDeg(yawDegFromQuat(current.rotation) - yawDegFromQuat(reference.rotation)),
  }
}

/**
 * One-line HUD rendering of a delta, e.g. `Δ 6cm · 2.4° · x0.03 y-0.01 z0.05`.
 *
 * Sub-metre distances render in centimetres because the benchmark's whole
 * range of interest is a few centimetres to a few tens of centimetres, where
 * "0.06 m" is harder to read at a glance than "6cm".
 */
export function formatPoseDelta(delta: PoseDelta): string {
  const dist = delta.distanceM < 1
    ? `${Math.round(delta.distanceM * 100)}cm`
    : `${delta.distanceM.toFixed(2)}m`
  const axes = `x${delta.offsetM.x.toFixed(2)} y${delta.offsetM.y.toFixed(2)} z${delta.offsetM.z.toFixed(2)}`
  return `Δ ${dist} · ${delta.yawDeg.toFixed(1)}° · ${axes}`
}
