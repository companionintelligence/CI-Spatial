/**
 * Closed-loop control law, tested against telemetry captured from real hardware.
 *
 * Every fixture below is a verbatim reading from `gimbal_move_to` on an OM6 during the
 * 2026-08-26 Linux session — the first time this subsystem ran on anything but macOS. That
 * matters for the same reason it does in gimbal_stall.test.ts: these defects only show up on
 * real hardware mid-session, so a synthetic fixture would be testing my idea of the failure
 * rather than the failure.
 *
 * Run: npm run test:gimbal:control
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROPORTIONAL_GAIN,
  MIN_EFFECTIVE_SPEED_DEG_PER_SEC,
  computeCorrection,
  shouldFlipSign,
  poseAlreadyActedOn,
} from '../../../subsystems/osmo-ble/protocol/control.mjs'

const OPTS = { toleranceDeg: 5, speedDegPerSec: 25 }

test('correction: inside tolerance commands nothing', () => {
  assert.equal(computeCorrection(0, OPTS), 0)
  assert.equal(computeCorrection(4.9, OPTS), 0)
  assert.equal(computeCorrection(-4.9, OPTS), 0)
})

test('correction: scales with the error instead of being bang-bang', () => {
  // The whole point: a big error and a small one must NOT command the same speed.
  const far = Math.abs(computeCorrection(90, OPTS))
  const near = Math.abs(computeCorrection(8, OPTS))
  assert.ok(far > near, 'a 90° error must command more than an 8° error')
  assert.equal(far, 25, 'far errors saturate at speedDegPerSec')
})

test('correction: never commands below the motor deadband', () => {
  // Proportional shrinking all the way to zero would stall just short of the target, because
  // the motors ignore very low speeds outright.
  const justOutside = Math.abs(computeCorrection(5.5, OPTS))
  assert.equal(justOutside, MIN_EFFECTIVE_SPEED_DEG_PER_SEC)
  assert.ok(justOutside * PROPORTIONAL_GAIN > 0)
})

test('correction: never commands above the caller ceiling', () => {
  for (const err of [30, 90, 180, 1000]) {
    assert.ok(Math.abs(computeCorrection(err, OPTS)) <= OPTS.speedDegPerSec)
  }
})

test('correction: direction follows the error, and the learned sign inverts it', () => {
  assert.ok(computeCorrection(40, OPTS) > 0)
  assert.ok(computeCorrection(-40, OPTS) < 0)
  assert.ok(computeCorrection(40, { ...OPTS, sign: -1 }) < 0)
})

/**
 * The real limit cycle. Targeting yaw=0, the loop reported this sequence and never settled,
 * running the full 20 ticks at |error| 15-25° the whole way.
 */
const OSCILLATION = [-19.1, -25.1, -11.1, 5.6, -8.6, -25.4, -11.5, 5.2, -8.9]

test('flip-sign: an overshoot is not a wrong mapping', () => {
  // -5.6 -> +8.6 grew AND crossed zero. computeCorrection already reverses on the sign change;
  // flipping the learned sign too would reverse it twice and drive hard the wrong way.
  assert.equal(shouldFlipSign(8.6, -5.6), false)
  assert.equal(shouldFlipSign(-8.9, 5.2), false)
})

test('flip-sign: a growing error on the same side IS a wrong mapping', () => {
  assert.equal(shouldFlipSign(-25.1, -19.1), true)
  assert.equal(shouldFlipSign(25.1, 19.1), true)
})

test('flip-sign: noise inside the epsilon does not thrash the mapping', () => {
  assert.equal(shouldFlipSign(-19.3, -19.1), false)
  assert.equal(shouldFlipSign(-19.1, null), false)
})

test('flip-sign: replaying the real oscillation never flips on a zero crossing', () => {
  // Every flip in this trace must be a same-side growth. Any flip at a crossing is the bug.
  const flipsAtCrossing = OSCILLATION.slice(1).filter((err, i) => {
    const prev = OSCILLATION[i]
    return shouldFlipSign(err, prev) && Math.sign(err) !== Math.sign(prev)
  })
  assert.deepEqual(flipsAtCrossing, [], 'a sign change must never be read as a wrong mapping')
})

/**
 * Real duplicated readings: consecutive ticks 400ms apart reporting bit-identical float64
 * angles, because the gimbal re-sends its last orientation rather than staying quiet.
 */
test('freshness: a bit-identical pose is recognised as already acted on', () => {
  const pose = { yaw: -25.060778368522598, pitch: 1.4259318943035797 }
  assert.equal(poseAlreadyActedOn(pose, { ...pose }), true)
})

test('freshness: the first sample of a move is always fresh', () => {
  assert.equal(poseAlreadyActedOn({ yaw: 1, pitch: 2 }, null), false)
})

test('freshness: genuine IMU noise counts as a new measurement', () => {
  // Real consecutive samples differ in the low bits; only a replayed value is exact.
  const a = { yaw: -61.79714585201963, pitch: 0.4518001197277825 }
  const b = { yaw: -61.783907085070005, pitch: 0.4387669757504664 }
  assert.equal(poseAlreadyActedOn(b, a), false)
})

test('freshness: a change in either axis alone is still fresh', () => {
  const base = { yaw: 10, pitch: 2 }
  assert.equal(poseAlreadyActedOn({ yaw: 10.5, pitch: 2 }, base), false)
  assert.equal(poseAlreadyActedOn({ yaw: 10, pitch: 2.5 }, base), false)
})

/**
 * End-to-end: replay the controller against a simple plant and assert it actually settles.
 *
 * The old bang-bang law could not: its minimum step (~6° per 250ms pulse at 25°/s) was about
 * twice the tolerance half-band, so it limit-cycled at the step size instead of landing.
 */
test('the loop settles into tolerance instead of limit-cycling', () => {
  const TICK_S = 0.25
  let pos = -60
  let sign = 1
  let prevErr: number | null = null
  let ticks = 0
  for (; ticks < 60; ticks++) {
    const err = 0 - pos
    if (Math.abs(err) <= OPTS.toleranceDeg) break
    if (shouldFlipSign(err, prevErr)) sign *= -1
    const speed = computeCorrection(err, { ...OPTS, sign })
    prevErr = err
    pos += speed * TICK_S
  }
  assert.ok(ticks < 60, 'must converge rather than run out of ticks')
  assert.ok(Math.abs(pos) <= OPTS.toleranceDeg, `settled at ${pos}, outside tolerance`)
})
