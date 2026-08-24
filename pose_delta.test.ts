/**
 * Unit tests for src/capture/pose-delta.ts — the drift measurement behind the
 * room-loop benchmark (wave 09 ticket 0006).
 *
 * These assert against the function's *stated contract* (identity yaw is zero,
 * the yaw convention matches composeYUpTransform's, a returned-to-start pose
 * reads zero drift), not against observed output — so a failure here means the
 * implementation contradicts its documentation rather than that the test needs
 * adjusting.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { formatPoseDelta, poseDelta, wrapDeg, yawDegFromQuat } from './src/capture/pose-delta.ts'
import type { PoseLike } from './src/capture/pose-delta.ts'

/** Quaternion for a rotation of `deg` about +Y. */
function yawQuat(deg: number): PoseLike['rotation'] {
  const half = (deg * Math.PI) / 180 / 2
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
}

function poseAt(x: number, y: number, z: number, yawDeg = 0): PoseLike {
  return { position: { x, y, z }, rotation: yawQuat(yawDeg) }
}

/**
 * Quaternion for a yaw about +Y followed by a pitch about the body X axis,
 * i.e. `qYaw * qPitch`. Positive pitch tips the camera DOWN (a rotation about
 * +X sends body +Z to (0, -sin, cos)) — how a phone is held while scanning a
 * floor.
 */
function yawPitchQuat(yawDeg: number, pitchDeg: number): PoseLike['rotation'] {
  const cy = Math.cos((yawDeg * Math.PI) / 180 / 2)
  const sy = Math.sin((yawDeg * Math.PI) / 180 / 2)
  const cp = Math.cos((pitchDeg * Math.PI) / 180 / 2)
  const sp = Math.sin((pitchDeg * Math.PI) / 180 / 2)
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp }
}

const IDENTITY: PoseLike['rotation'] = { x: 0, y: 0, z: 0, w: 1 }

Deno.test('yawDegFromQuat: identity rotation is zero', () => {
  assertAlmostEquals(yawDegFromQuat(IDENTITY), 0, 1e-9)
})

Deno.test('yawDegFromQuat: recovers the yaw it was built from', () => {
  for (const deg of [-179, -90, -45, 0, 30, 90, 179]) {
    assertAlmostEquals(yawDegFromQuat(yawQuat(deg)), deg, 1e-6, `yaw ${deg}`)
  }
})

Deno.test('yawDegFromQuat: matches atan2(x, z) of the rotated +Z axis', () => {
  // The convention this must agree with — viewer.ts's updateWorldHud() and
  // world/geo.ts's composeYUpTransform() both treat yaw this way. If these two
  // ever disagree, a yaw shown on the HUD means something different from a yaw
  // fed into a calibration transform.
  for (const deg of [-135, -20, 0, 60, 150]) {
    const { x, y, z, w } = yawQuat(deg)
    const fx = 2 * (x * z + w * y)
    const fz = 1 - 2 * (x * x + y * y)
    const viaForwardAxis = (Math.atan2(fx, fz) * 180) / Math.PI
    assertAlmostEquals(yawDegFromQuat(yawQuat(deg)), viaForwardAxis, 1e-9, `yaw ${deg}`)
  }
})

Deno.test('yawDegFromQuat: heading survives the device being pitched at the floor', () => {
  // THE CASE THAT ACTUALLY OCCURS, and the one the original implementation got
  // wrong. The benchmark protocol tells the operator to point the device at the
  // floor, so the pose always carries pitch. A Y-Euler extraction reports a
  // heading that shrinks as pitch grows — at 50 degrees down it read 20.4 for a
  // true 30, against a benchmark whose rotational target is 5 degrees.
  //
  // The earlier tests all used pure-yaw quaternions, so they confirmed the
  // convention exactly where it was guaranteed and never where it mattered.
  for (const yaw of [-120, -30, 0, 30, 120]) {
    for (const pitch of [0, 20, 50, 70]) {
      assertAlmostEquals(
        yawDegFromQuat(yawPitchQuat(yaw, pitch)),
        yaw,
        1e-6,
        `yaw ${yaw} at pitch ${pitch} must still read ${yaw}`,
      )
    }
  }
})

Deno.test('yawDegFromQuat: stays well-conditioned pointing straight down', () => {
  // At vertical pitch the forward axis has no horizontal component at all, so
  // its projected direction is pure noise. The up axis is exactly horizontal
  // there and carries the same heading, which is why the implementation picks
  // whichever projection is longer.
  for (const yaw of [-90, 0, 45]) {
    assertAlmostEquals(yawDegFromQuat(yawPitchQuat(yaw, 90)), yaw, 1e-6, `straight down at yaw ${yaw}`)
    // ...and does not jump as the device tips through the crossover.
    assertAlmostEquals(yawDegFromQuat(yawPitchQuat(yaw, 44)), yaw, 1e-6, `just before crossover, yaw ${yaw}`)
    assertAlmostEquals(yawDegFromQuat(yawPitchQuat(yaw, 46)), yaw, 1e-6, `just after crossover, yaw ${yaw}`)
  }
})

Deno.test('poseDelta: a pitched loop reports the real heading change', () => {
  // End to end: the drift number the operator writes down must be the heading
  // change, not an artefact of how they were holding the phone. Same 10-degree
  // turn, but the return pose is pitched further down than the start.
  const start = { position: { x: 0, y: 0, z: 0 }, rotation: yawPitchQuat(0, 30) }
  const returned = { position: { x: 0, y: 0, z: 0 }, rotation: yawPitchQuat(10, 55) }
  assertAlmostEquals(poseDelta(start, returned).yawDeg, 10, 1e-6)
})

Deno.test('wrapDeg: wraps into (-180, 180]', () => {
  assertEquals(wrapDeg(0), 0)
  assertEquals(wrapDeg(90), 90)
  assertAlmostEquals(wrapDeg(270), -90, 1e-9)
  assertAlmostEquals(wrapDeg(-270), 90, 1e-9)
  assertAlmostEquals(wrapDeg(360), 0, 1e-9)
  // Both half-turns normalise to +180 so a loop walked either way reads alike.
  assertEquals(wrapDeg(180), 180)
  assertEquals(wrapDeg(-180), 180)
})

Deno.test('poseDelta: identical poses read as zero drift', () => {
  const p = poseAt(1.5, 0.2, -3.25, 42)
  const d = poseDelta(p, p)
  assertAlmostEquals(d.distanceM, 0, 1e-9)
  assertAlmostEquals(d.yawDeg, 0, 1e-9)
  assertAlmostEquals(d.offsetM.x, 0, 1e-9)
  assertAlmostEquals(d.offsetM.y, 0, 1e-9)
  assertAlmostEquals(d.offsetM.z, 0, 1e-9)
})

Deno.test('poseDelta: reports straight-line distance and per-axis offset', () => {
  // 3-4-5 triangle in the horizontal plane, plus a little vertical drift.
  const d = poseDelta(poseAt(0, 0, 0), poseAt(3, 0, 4))
  assertAlmostEquals(d.distanceM, 5, 1e-9)
  assertAlmostEquals(d.offsetM.x, 3, 1e-9)
  assertAlmostEquals(d.offsetM.z, 4, 1e-9)

  const vertical = poseDelta(poseAt(0, 0, 0), poseAt(0, 0.12, 0))
  assertAlmostEquals(vertical.distanceM, 0.12, 1e-9)
  assertAlmostEquals(vertical.offsetM.y, 0.12, 1e-9)
})

Deno.test('poseDelta: yaw difference is signed and wrapped, not accumulated', () => {
  assertAlmostEquals(poseDelta(poseAt(0, 0, 0, 10), poseAt(0, 0, 0, 40)).yawDeg, 30, 1e-6)
  assertAlmostEquals(poseDelta(poseAt(0, 0, 0, 40), poseAt(0, 0, 0, 10)).yawDeg, -30, 1e-6)
  // Crossing the ±180 seam the short way round, not 350 degrees the long way —
  // a loop that ends 10 degrees off must read 10, whichever side of the seam.
  assertAlmostEquals(poseDelta(poseAt(0, 0, 0, 175), poseAt(0, 0, 0, -175)).yawDeg, 10, 1e-6)
})

Deno.test('poseDelta: a walked loop returning to the start reads near zero', () => {
  // The benchmark's actual shape: leave the tape, walk a perimeter, come back
  // a few centimetres and a couple of degrees off.
  const start = poseAt(0, 0, 0, 0)
  const returned = poseAt(0.04, -0.01, 0.05, 2.4)
  const d = poseDelta(start, returned)
  assert(d.distanceM < 0.10, `expected sub-10cm drift, got ${d.distanceM}`)
  assert(Math.abs(d.yawDeg) < 5, `expected sub-5-degree drift, got ${d.yawDeg}`)
})

Deno.test('formatPoseDelta: centimetres under a metre, metres above', () => {
  assert(formatPoseDelta(poseDelta(poseAt(0, 0, 0), poseAt(0.06, 0, 0))).includes('6cm'))
  assert(formatPoseDelta(poseDelta(poseAt(0, 0, 0), poseAt(2.5, 0, 0))).includes('2.50m'))
})
