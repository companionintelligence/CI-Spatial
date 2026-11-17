/**
 * A rigid body in a right-handed (east, north, up) world, for the compass tests: a phone turned, tilted and rolled
 * the way a person holds it, the angles a browser would report for it, and the pose an AR runtime would report
 * for it in a session of known orientation. Written to share no code with src/, so a test measured against it
 * is measured against something that was not derived from the code it checks.
 *
 *   - the body's three axes are CARRIED through the rotations one at a time with Rodrigues' formula (an
 *     intrinsic rotation is a rotation about the axis as it is now, so the pivot is the carried axis, not a fixed
 *     one). No matrix product, no closed form;
 *   - a phone is placed by what a person does with it: turned to face a heading, tilted down by a pitch, rolled
 *     about the camera axis into portrait or landscape. Its camera heading is the heading it was turned to, by
 *     construction, whatever the roll;
 *   - the angles the browser would report for that pose are found by an inverse of its own (read off the carried
 *     axes), and checked by carrying a body through them again. Where two sets of angles describe one pose (the
 *     specification's ranges leave a second one), both are offered;
 *   - the AR pose is the phone's own frame turned by `turnDeg` about the screen's normal (a runtime whose camera
 *     frame follows the screen into landscape, or does not), written into a session whose +Y is up and whose +Z
 *     points at a chosen true bearing.
 *
 * What a device's sensors report is not modelled: that is what the DX3 spin test is for.
 */
import assert from 'node:assert/strict'

/** (east, north, up): right-handed, east x north = up. */
export type V = [number, number, number]
export interface Axes { x: V, y: V, z: V }
export interface Quaternion { x: number, y: number, z: number, w: number }

export const D2R = Math.PI / 180
export const R2D = 180 / Math.PI
export const UP: V = [0, 0, 1]
export const EAST: V = [1, 0, 0]

export const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s]
export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** `v` turned by `deg` about the unit vector `axis`, counter-clockwise looking from the axis's tip back at the origin (the right-hand rule). */
export function rotate(v: V, axis: V, deg: number): V {
  const t = deg * D2R
  return add(add(scale(v, Math.cos(t)), scale(cross(axis, v), Math.sin(t))), scale(axis, dot(axis, v) * (1 - Math.cos(t))))
}

export const mapAxes = (a: Axes, f: (v: V) => V): Axes => ({ x: f(a.x), y: f(a.y), z: f(a.z) })

/**
 * A body whose axes start on east, north and up (a phone lying flat, screen up, top edge north) and is
 * rotated INTRINSICALLY: about earth up by alpha, then about its own carried x axis by beta, then about its own
 * carried y axis by gamma. The returned axes are the device's x (right of the screen), y (up the screen) and z
 * (out of the screen), in earth coordinates.
 */
export function axesFromEuler(alpha: number, beta: number, gamma: number): Axes {
  let a: Axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  a = mapAxes(a, (v) => rotate(v, UP, alpha))
  const pivotX = a.x
  a = mapAxes(a, (v) => rotate(v, pivotX, beta))
  const pivotY = a.y
  a = mapAxes(a, (v) => rotate(v, pivotY, gamma))
  return a
}

export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360
/** `a - b` folded into (-180, 180]. */
export function angDiff(a: number, b: number): number {
  const d = norm360(a - b)
  return d > 180 ? d - 360 : d
}
/** The compass bearing, clockwise from north, of the horizontal part of a vector. */
export const bearingOf = (v: V): number => norm360(Math.atan2(v[0], v[1]) * R2D)
export const horizontalPart = (v: V): number => Math.hypot(v[0], v[1])

/**
 * A phone placed by what a person does: held upright in portrait with the camera facing north, then rolled
 * about the camera axis by `rollDeg` (0 portrait, 90 and 270 the two landscapes, 180 upside down), tilted down
 * by `pitchDownDeg` (negative looks up) about the east-west axis, and turned to face `headingDeg`.
 */
export function phoneAt(headingDeg: number, pitchDownDeg: number, rollDeg: number): Axes {
  // Portrait, camera north, level: the screen faces south (the viewer), its top edge is up, its right edge east.
  let a: Axes = { x: EAST, y: UP, z: [0, -1, 0] }
  const camera = scale(a.z, -1)
  a = mapAxes(a, (v) => rotate(v, camera, rollDeg))
  a = mapAxes(a, (v) => rotate(v, EAST, -pitchDownDeg))
  a = mapAxes(a, (v) => rotate(v, UP, -headingDeg))
  return a
}

/**
 * The angles a browser reports for a pose, inside the specification's ranges (alpha 0 to 360, beta -180 to
 * 180, gamma -90 to 90), read off the carried axes, and a second set that describes the same pose. Each is
 * checked by carrying a body through it again, so the inverse is not taken on trust.
 */
export function eulerAnglesFor(axes: Axes): Array<[number, number, number]> {
  // |cos beta| is the length of the (x, z) components of the device's up-down row; atan2 of it and sin beta is
  // well conditioned at +-90 degrees where asin of sin beta is not (it loses six digits there).
  const cosBeta = Math.hypot(axes.x[2], axes.z[2])
  const beta1 = Math.atan2(axes.y[2], cosBeta) * R2D
  let first: [number, number, number]
  if (cosBeta > 1e-9) {
    first = [Math.atan2(-axes.y[0], axes.y[1]) * R2D, beta1, Math.atan2(-axes.x[2], axes.z[2]) * R2D]
  } else {
    // beta +-90: the phone is upright or hanging, alpha and gamma turn the same way and only their sum or difference is fixed. Take gamma 0.
    first = [Math.atan2(axes.x[1], axes.x[0]) * R2D, beta1, 0]
  }
  // The same rotation again: Rz(alpha + 180) Rx(180 - beta) Ry(gamma + 180).
  const second: [number, number, number] = [first[0] + 180, 180 - first[1], first[2] + 180]
  const folded = (t: [number, number, number]): [number, number, number] => {
    const alpha = norm360(t[0])
    const beta = ((t[1] + 540) % 360) - 180
    const gamma = angDiff(t[2], 0)
    return [alpha, beta, gamma]
  }
  const both = [folded(first), folded(second)]
  for (const triple of both) {
    const back = axesFromEuler(...triple)
    for (const key of ['x', 'y', 'z'] as const) {
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[key][i]! - axes[key][i]!) < 1e-9, `the angles ${triple} do not give the pose back`)
    }
  }
  // Inside the specification's ranges first: gamma between -90 and 90.
  return both.sort((a, b) => Math.abs(a[2]) - Math.abs(b[2]))
}

// ── The AR session ───────────────────────────────────────────────────────────────────────────

/**
 * The axes of an AR session in earth coordinates: +Y is up, +Z is horizontal at true bearing `sessionZBearing`
 * (clockwise from north), and +X is Y cross Z, which makes the session right-handed.
 */
export function sessionAxes(sessionZBearing: number): Axes {
  const b = sessionZBearing * D2R
  const z: V = [Math.sin(b), Math.cos(b), 0]
  return { x: cross(UP, z), y: UP, z }
}

/** The unit quaternion of the rotation whose matrix has the three given columns (Shepperd's method: the largest of the four terms is the divisor). */
export function quaternionFromColumns(c0: V, c1: V, c2: V): Quaternion {
  const m = [[c0[0], c1[0], c2[0]], [c0[1], c1[1], c2[1]], [c0[2], c1[2], c2[2]]] as const
  const trace = m[0][0] + m[1][1] + m[2][2]
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return { w: s / 4, x: (m[2][1] - m[1][2]) / s, y: (m[0][2] - m[2][0]) / s, z: (m[1][0] - m[0][1]) / s }
  }
  if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2
    return { w: (m[2][1] - m[1][2]) / s, x: s / 4, y: (m[0][1] + m[1][0]) / s, z: (m[0][2] + m[2][0]) / s }
  }
  if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2
    return { w: (m[0][2] - m[2][0]) / s, x: (m[0][1] + m[1][0]) / s, y: s / 4, z: (m[1][2] + m[2][1]) / s }
  }
  const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2
  return { w: (m[1][0] - m[0][1]) / s, x: (m[0][2] + m[2][0]) / s, y: (m[1][2] + m[2][1]) / s, z: s / 4 }
}

/**
 * The camera pose (camera to session, x right, y up, z back) an AR runtime reports for a phone with these axes,
 * in a session whose +Z points at true bearing `sessionZBearing`. The runtime's camera frame is the phone's own
 * turned by `turnDeg` about the screen's normal: 0 is the phone's frame, 90 and -90 one that has followed the
 * screen into a landscape the browser's angles did not, 180 a screen the right way up the other way round.
 * `x_camera = cos x_device + sin y_device`, `y_camera = -sin x_device + cos y_device`, `z_camera = z_device`.
 */
export function arPoseFor(axes: Axes, sessionZBearing: number, turnDeg: number): Quaternion {
  const t = turnDeg * D2R
  const session = sessionAxes(sessionZBearing)
  const inSession = (v: V): V => [dot(v, session.x), dot(v, session.y), dot(v, session.z)]
  const xCamera = add(scale(axes.x, Math.cos(t)), scale(axes.y, Math.sin(t)))
  const yCamera = add(scale(axes.x, -Math.sin(t)), scale(axes.y, Math.cos(t)))
  return quaternionFromColumns(inSession(xCamera), inSession(yCamera), inSession(axes.z))
}
