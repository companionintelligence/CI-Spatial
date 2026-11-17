/**
 * A physical model of an AR session and a compass, written to share **no code**
 * with the app. It is what the bearing and frame tests are measured against.
 *
 * The tests that came before it derived their "truth" through the app's own
 * `composeYUpTransform`, which assumes the same direction of yaw as the code it
 * was checking, so a sign error in `sessionFrameBearingDeg` passed them (audit
 * F53). This file imports nothing from `src/`, and rotates with quaternion
 * arithmetic written out here rather than with the app's yaw reader.
 *
 * ## The world
 *
 * Truth is a right-handed ENU world (east, north, up). A compass bearing is the
 * angle clockwise from north seen from above, and a *perfect* compass reports
 * the true bearing of the direction the camera faces.
 *
 * ## The session
 *
 * An AR session frame is right-handed with +Y up, and its camera looks down its
 * own -Z (the three.js and WebXR convention). The session starts with the
 * camera facing bearing `psi`, so session -Z points at `psi` and session +Z
 * points behind the first view, at `psi + 180`. Right-handedness fixes +X as
 * +Y x +Z, so a session vector `(x, y, z)` is, in ENU:
 *
 *     east  =  x cos(psi) - z sin(psi)
 *     north = -x sin(psi) - z cos(psi)
 *     up    =  y
 *
 * Turning the camera LEFT by `phi` is a rotation of `+phi` about session +Y
 * (counter-clockwise seen from above). Turning right is a negative `phi`.
 *
 * Premises, stated so they can be argued with: the session is right-handed, the
 * camera looks down its own -Z, and bearings grow clockwise. What a phone's
 * compass actually reports is not modelled; that is what the device spin test
 * is for.
 */

export const D2R = Math.PI / 180
export const R2D = 180 / Math.PI

export interface V3 { x: number; y: number; z: number }
export interface Q { x: number; y: number; z: number; w: number }
export interface Enu { east: number; north: number; up: number }

/** Fold into [0, 360). */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360
/** `a - b` folded into (-180, 180]. */
export function angDiff(a: number, b: number): number {
  const d = norm360(a - b)
  return d > 180 ? d - 360 : d
}

/** Rotation by `deg` about +Y: counter-clockwise seen from above, so a LEFT turn for a camera. */
export function yawQuat(deg: number): Q {
  const h = (deg * D2R) / 2
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }
}

/** Rotation by `deg` about +X. A camera tilted DOWN by `d` is `pitchQuat(-d)`: forward (0,0,-1) turns toward -Y. */
export function pitchQuat(deg: number): Q {
  const h = (deg * D2R) / 2
  return { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) }
}

/** Hamilton product `a * b`: apply `b`, then `a`. */
export function mulQuat(a: Q, b: Q): Q {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

/** `q v q^-1` by the cross-product form, written independently of the app's yaw reader. */
export function rotateByQuat(q: Q, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** A camera that has turned left by `leftTurnDeg` and tilted down by `downDeg`, in the session's own frame. */
export function cameraRotation(leftTurnDeg: number, downDeg = 0): Q {
  return mulQuat(yawQuat(leftTurnDeg), pitchQuat(-downDeg))
}

/** A session vector, as the ENU vector it physically is, for a session that started facing bearing `psiDeg`. */
export function sessionToEnu(psiDeg: number, s: V3): Enu {
  const p = psiDeg * D2R
  return {
    east: s.x * Math.cos(p) - s.z * Math.sin(p),
    north: -s.x * Math.sin(p) - s.z * Math.cos(p),
    up: s.y,
  }
}

/** The inverse of {@link sessionToEnu} (the rotation is orthonormal). */
export function enuToSession(psiDeg: number, e: Enu): V3 {
  const p = psiDeg * D2R
  return {
    x: e.east * Math.cos(p) - e.north * Math.sin(p),
    y: e.up,
    z: -e.east * Math.sin(p) - e.north * Math.cos(p),
  }
}

/** Compass bearing, clockwise from north, of the horizontal part of an ENU vector. */
export const bearingOfEnu = (e: { east: number; north: number }): number => norm360(Math.atan2(e.east, e.north) * R2D)

/** True bearing of session +Z for a session that started facing `psiDeg`. */
export const trueSessionZBearing = (psiDeg: number): number => bearingOfEnu(sessionToEnu(psiDeg, { x: 0, y: 0, z: 1 }))

/** The true bearing of the horizontal part of a session vector. */
export const bearingOfSessionVector = (psiDeg: number, v: V3): number =>
  bearingOfEnu(sessionToEnu(psiDeg, { x: v.x, y: 0, z: v.z }))

/** The true bearing of the session direction at session yaw `yawDeg` (`atan2(x, z)`: 0 is +Z, 90 is +X). */
export const bearingOfSessionYaw = (psiDeg: number, yawDeg: number): number =>
  bearingOfSessionVector(psiDeg, { x: Math.sin(yawDeg * D2R), y: 0, z: Math.cos(yawDeg * D2R) })

/**
 * What a PERFECT compass reads for a camera with orientation `q` in a session
 * that started facing `psiDeg`: the true bearing of the camera's forward
 * direction, `q * (0, 0, -1)`, seen from above.
 */
export function perfectCompassBearing(psiDeg: number, q: Q): number {
  return bearingOfSessionVector(psiDeg, rotateByQuat(q, { x: 0, y: 0, z: -1 }))
}

/** The physical position a scene point `offset` metres from the session origin is at, plus the session's own offset. */
export function sceneFeaturePosition(site: Enu, feature: Enu): Enu {
  return { east: site.east + feature.east, north: site.north + feature.north, up: site.up + feature.up }
}

/** A column-major 4x4 applied to a point (three.js `Matrix4.elements` layout). */
export function applyColumnMajor(m: number[], p: V3): V3 {
  return {
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
  }
}

/** Determinant of the 3x3 block of a column-major 4x4. */
export function rotationDeterminant(m: number[]): number {
  return m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!)
    - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!)
    + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
}

export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
