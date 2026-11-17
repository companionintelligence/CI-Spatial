/**
 * Frame epochs (WP-09): what counts as a discontinuity, and what one scan keeps of them.
 *
 * Pure: the tracker takes a frame at a time with its own clock, so every case here is a
 * script of frames, with no AR runtime and no wall clock. The provider wiring is tested in
 * frame_epoch_eighthwall.test.ts and frame_epoch_webxr.test.ts; the cloud in
 * tests/unit/deno/pointcloud.test.ts.
 *
 * The thresholds are adopted, not measured (ADR 0005 rule 5; device experiment DX4 sets
 * them). These tests pin what each does at the numbers the brief names (a 0.31 m jump, a
 * 10 degree in-place yaw, a walk at 1.5 m/s with 180 degrees-per-second turns) and that
 * the walk never reads as a shift.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_DRIFT_TRANSLATION_M,
  ANCHOR_DRIFT_YAW_DEG,
  ANCHOR_STEP_TRANSLATION_M,
  ANCHOR_STEP_YAW_DEG,
  FRAME_EPOCH_ADOPTED,
  FRAME_EPOCH_THRESHOLDS,
  FRAME_JUMP_REFRACTORY_MS,
  FRAME_JUMP_TRANSLATION_M,
  FRAME_JUMP_YAW_DEG,
  FRAME_LOG_MAX,
  FrameEpochTracker,
  MAX_ACCOUNTED_INTERVAL_MS,
  MAX_CAPTURE_POSE_AGE_MS,
  MAX_COMPARABLE_STEP_RATIO,
  MAX_HAND_ACCELERATION_MPS2,
  MAX_TURN_ACCELERATION_DPS2,
  RECOVERY_SUSPECT_MS,
  ScanFrameEpochLog,
  chooseFloorEpoch,
  classifyTracking,
  describeTracking,
  epochOf,
  yawDeltaDeg,
  yawTwistDeg,
  type FrameDiscontinuity,
  type FrameEpochCloud,
  type FrameEpochSource,
  type TrackingDiagnostics,
} from '../../../src/ar/frame-epoch.ts'
import type { Pose } from '../../../src/ar/provider.ts'

// ─── Poses ─────────────────────────────────────────────────────────────────

type Quat = { x: number; y: number; z: number; w: number }
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

const rad = (deg: number): number => (deg * Math.PI) / 180

/** A rotation of `deg` about +Y: a turn of the camera's heading. */
const aboutY = (deg: number): Quat => ({ x: 0, y: Math.sin(rad(deg) / 2), z: 0, w: Math.cos(rad(deg) / 2) })
/** A rotation of `deg` about +X: a nod of the camera. */
const aboutX = (deg: number): Quat => ({ x: Math.sin(rad(deg) / 2), y: 0, z: 0, w: Math.cos(rad(deg) / 2) })
const aboutZ = (deg: number): Quat => ({ x: 0, y: 0, z: Math.sin(rad(deg) / 2), w: Math.cos(rad(deg) / 2) })

function mul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

function pose(x: number, y = 1.5, z = 0, rotation: Quat = IDENTITY): Pose {
  return { position: { x, y, z }, rotation }
}

/** The frame period at 30 fps, in milliseconds. */
const FRAME_MS = 1000 / 30

/**
 * A tracker that has seen good tracking at the origin for three frames, the last at t = 0, so
 * what follows can be a discontinuity. Three, because a step is judged against the step before
 * it: the first frame is where it starts, the second gives the first step, and the third is the
 * first step that has one to be compared with.
 */
function established(): FrameEpochTracker {
  const tracker = new FrameEpochTracker()
  for (const tMs of [-2 * FRAME_MS, -FRAME_MS, 0]) {
    assert.equal(tracker.observe({ tMs, pose: pose(0), status: 'NORMAL' }), null)
  }
  return tracker
}

// ─── Reading a status ──────────────────────────────────────────────────────

test('classifyTracking: the documented 8th Wall statuses and reasons, and the names this build also handles', () => {
  // Documented (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule): a status of LIMITED or NORMAL and a
  // reason of INITIALIZING or UNSPECIFIED. NOT_AVAILABLE, RELOCALIZING, TOO_MUCH_MOTION and NOT_ENOUGH_TEXTURE are not
  // documented: this build handles them in case a runtime reports them, and DX4 logs which ones a phone does.
  assert.equal(classifyTracking('NORMAL', 'UNSPECIFIED'), 'good')
  assert.equal(classifyTracking('NORMAL'), 'good')
  assert.equal(classifyTracking('LIMITED', 'TOO_MUCH_MOTION'), 'degraded')
  assert.equal(classifyTracking('LIMITED', 'NOT_ENOUGH_TEXTURE'), 'degraded')
  assert.equal(classifyTracking('LIMITED', 'RELOCALIZING'), 'degraded')
  assert.equal(classifyTracking('LIMITED', 'INITIALIZING'), 'degraded')
  assert.equal(classifyTracking('NOT_AVAILABLE'), 'absent')
  // INITIALIZING is a documented reason, and a status in the native provider's own words.
  assert.equal(classifyTracking('INITIALIZING'), 'degraded')
})

test('classifyTracking: a degraded reason makes a NORMAL status degraded; nothing known stays unknown', () => {
  assert.equal(classifyTracking('NORMAL', 'RELOCALIZING'), 'degraded')
  // UNSPECIFIED status and UNKNOWN say nothing: they compare poses and never start an episode.
  assert.equal(classifyTracking('UNSPECIFIED'), 'unknown')
  assert.equal(classifyTracking('UNKNOWN'), 'unknown')
  assert.equal(classifyTracking(undefined), 'unknown')
  assert.equal(classifyTracking(null, null), 'unknown')
  assert.equal(classifyTracking('SOME_FUTURE_STATUS', 'SOME_FUTURE_REASON'), 'unknown')
})

test('classifyTracking: the native runtimes\' reason names are not in the web provider\'s set', () => {
  // EXCESSIVE_MOTION and INSUFFICIENT_FEATURES are native reasons (src/ar/native-provider.ts). They are not in 8th Wall's
  // documentation and not in the set this build treats as degraded for the web runtime, so a NORMAL web frame carrying one
  // stays good. If a phone log (DX4) shows a web build reporting them, they join the set.
  assert.equal(classifyTracking('NORMAL', 'EXCESSIVE_MOTION'), 'good')
  assert.equal(classifyTracking('NORMAL', 'INSUFFICIENT_FEATURES'), 'good')
})

// ─── Heading arithmetic ────────────────────────────────────────────────────

test('yawDeltaDeg: the turn about the vertical, whatever the camera was doing', () => {
  assert.ok(Math.abs(yawDeltaDeg(IDENTITY, aboutY(10)) - 10) < 1e-9)
  assert.ok(Math.abs(yawDeltaDeg(aboutY(10), IDENTITY) - 10) < 1e-9, 'a turn the other way is the same size')
  assert.ok(Math.abs(yawDeltaDeg(aboutY(170), aboutY(-170)) - 20) < 1e-9, 'the short way round')
  // The same 10 degree turn made while the phone is nodded down 60 degrees is still 10.
  const nodded = aboutX(-60)
  assert.ok(Math.abs(yawDeltaDeg(nodded, mul(aboutY(10), nodded)) - 10) < 1e-9)
})

test('yawDeltaDeg: a nod is not a turn', () => {
  assert.ok(yawDeltaDeg(IDENTITY, aboutX(25)) < 1e-9)
  assert.ok(yawDeltaDeg(IDENTITY, aboutZ(25)) < 1e-9)
})

test('yawDeltaDeg: unnormalised input is read as the rotation it points at, and nonsense is NaN', () => {
  const doubled: Quat = { x: 0, y: 2 * Math.sin(rad(5)), z: 0, w: 2 * Math.cos(rad(5)) }
  assert.ok(Math.abs(yawDeltaDeg(IDENTITY, doubled) - 10) < 1e-9)
  assert.ok(Number.isNaN(yawDeltaDeg({ x: 0, y: 0, z: 0, w: 0 }, IDENTITY)))
  assert.ok(Number.isNaN(yawDeltaDeg(IDENTITY, { x: Number.NaN, y: 0, z: 0, w: 1 })))
})

// ─── Jumps ─────────────────────────────────────────────────────────────────

test('a 0.31 m jump in one 30 fps frame starts an epoch, and 0.29 m does not', () => {
  const small = established()
  assert.equal(small.observe({ tMs: FRAME_MS, pose: pose(0.29), status: 'NORMAL' }), null)
  assert.equal(small.epoch, 0)

  const big = established()
  const event = big.observe({ tMs: FRAME_MS, pose: pose(0.31), status: 'NORMAL' })
  assert.ok(event)
  assert.equal(event.epoch, 1)
  assert.equal(event.cause, 'jump')
  assert.ok(Math.abs((event.translationM ?? 0) - 0.31) < 1e-9)
  assert.ok(Math.abs((event.speedMps ?? 0) - 0.31 / (FRAME_MS / 1000)) < 1e-9, 'the speed that displacement implies is in the event')
  assert.ok(Math.abs((event.dtMs ?? 0) - FRAME_MS) < 1e-9, 'and the time it was measured over')
  assert.ok(Math.abs((event.unexplainedM ?? 0) - 0.31) < 1e-9, 'a camera that was still: all of the step is unexplained')
  assert.equal(big.epoch, 1)
  assert.equal(big.diagnostics().poseJumps, 1)
  assert.ok(Math.abs(big.diagnostics().lastJumpM - 0.31) < 1e-9)
})

test('an in-place 10 degree yaw starts an epoch, and 5 degrees does not', () => {
  const small = established()
  assert.equal(small.observe({ tMs: FRAME_MS, pose: pose(0, 1.5, 0, aboutY(5)), status: 'NORMAL' }), null)
  assert.equal(small.epoch, 0)

  const big = established()
  const event = big.observe({ tMs: FRAME_MS, pose: pose(0, 1.5, 0, aboutY(10)), status: 'NORMAL' })
  assert.ok(event)
  assert.equal(event.epoch, 1)
  assert.equal(event.cause, 'jump')
  assert.ok(Math.abs((event.yawDeg ?? 0) - 10) < 1e-9)
  assert.equal(event.translationM, 0, 'the camera did not move, and that is in the event')
  assert.equal(big.diagnostics().lastJumpDeg, event.yawDeg)
})

test('a tilt of the phone is not a shift of the frame', () => {
  const tracker = established()
  // 40 degrees of nod in one frame is a hand tapping, not the map turning.
  assert.equal(tracker.observe({ tMs: FRAME_MS, pose: pose(0, 1.5, 0, aboutX(40)), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 0)
})

test('the jump test does not depend on the frame rate: a walk with a turn, at 8 to 120 frames a second, is never a jump', () => {
  // The same 1.5 m/s walk with a steady 150 degree-per-second turn, seen at 8, 15, 30, 60 and
  // 120 frames a second. At 8 fps one frame moves 0.19 m and turns 19 degrees, past what a
  // fixed per-frame floor of 0.30 m or 8 degrees allows for, and the old test called it a shift.
  for (const fps of [8, 15, 30, 60, 120]) {
    const tracker = new FrameEpochTracker()
    const dt = 1000 / fps
    for (let i = 0; i <= fps * 10; i++) {
      const s = (i * dt) / 1000
      tracker.observe({ tMs: i * dt, pose: pose(1.5 * s, 1.5, 0, mul(aboutY(150 * s), aboutX(-25))), status: 'NORMAL' })
    }
    assert.equal(tracker.epoch, 0, `a walk with a turn at ${fps} fps read as a shift`)
  }
})

test('a stall that delivers two frames 400 ms apart is not a jump, because a person walks that far in that time', () => {
  const tracker = established()
  // 0.6 m in 0.4 s is 1.5 m/s. The old test compared 0.6 m with a fixed 0.30 m and called it a shift.
  assert.equal(tracker.observe({ tMs: 400, pose: pose(0.6), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 0)
  // The same 0.6 m in one 30 fps frame is not walking.
  const jump = tracker.observe({ tMs: 400 + FRAME_MS, pose: pose(1.2), status: 'NORMAL' })
  assert.equal(jump?.cause, 'jump')
})

test('a turn that a person could make in the time that passed is not a jump', () => {
  const tracker = established()
  // 20 degrees in 150 ms is 133 degrees a second.
  assert.equal(tracker.observe({ tMs: 150, pose: pose(0, 1.5, 0, aboutY(20)), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 0)
})

test('a jump is read between the two frames, so the same frame twice finds nothing', () => {
  // 8th Wall hands one reality frame to two hooks. The second sees the same pose.
  const tracker = established()
  const first = tracker.observe({ tMs: FRAME_MS, pose: pose(0.4), status: 'NORMAL' })
  assert.equal(first?.cause, 'jump')
  assert.equal(tracker.observe({ tMs: FRAME_MS + 0.2, pose: pose(0.4), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.diagnostics().poseJumps, 1)
})

test('after a jump the next frame is compared with the new pose, so one shift is one epoch', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(2), status: 'NORMAL' })
  assert.equal(tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(2.04), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
})

test('thresholds can be tightened, and the defaults are the named constants', () => {
  assert.deepEqual(FRAME_EPOCH_THRESHOLDS, {
    jumpTranslationM: FRAME_JUMP_TRANSLATION_M,
    jumpYawDeg: FRAME_JUMP_YAW_DEG,
    maxAccelerationMps2: MAX_HAND_ACCELERATION_MPS2,
    maxTurnAccelerationDps2: MAX_TURN_ACCELERATION_DPS2,
    maxComparableStepRatio: MAX_COMPARABLE_STEP_RATIO,
    refractoryMs: FRAME_JUMP_REFRACTORY_MS,
    recoverySuspectMs: RECOVERY_SUSPECT_MS,
    anchorStepTranslationM: ANCHOR_STEP_TRANSLATION_M,
    anchorStepYawDeg: ANCHOR_STEP_YAW_DEG,
    anchorDriftTranslationM: ANCHOR_DRIFT_TRANSLATION_M,
    anchorDriftYawDeg: ANCHOR_DRIFT_YAW_DEG,
  })
  const strict = new FrameEpochTracker({ jumpTranslationM: 0.1 })
  for (const tMs of [-2 * FRAME_MS, -FRAME_MS, 0]) strict.observe({ tMs, pose: pose(0), status: 'NORMAL' })
  assert.equal(strict.observe({ tMs: FRAME_MS, pose: pose(0.2), status: 'NORMAL' })?.cause, 'jump')
  // The same 0.2 m is under the default floor.
  assert.equal(established().observe({ tMs: FRAME_MS, pose: pose(0.2), status: 'NORMAL' }), null)
})

test('every adopted number is written into a record, named, so a later reader can re-read it', () => {
  assert.deepEqual(FRAME_EPOCH_ADOPTED, {
    ...FRAME_EPOCH_THRESHOLDS,
    maxCapturePoseAgeMs: MAX_CAPTURE_POSE_AGE_MS,
    maxAccountedIntervalMs: MAX_ACCOUNTED_INTERVAL_MS,
  })
})

// ─── Statuses ──────────────────────────────────────────────────────────────

test('a pose published while tracking is NOT_AVAILABLE is ignored, and does not read as a jump back', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.03), status: 'NORMAL' })
  // A default pose (the identity), ten metres from where the camera is: whatever such a frame carries is not a pose.
  tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(0, 0, 0), status: 'NOT_AVAILABLE' })
  tracker.observe({ tMs: 3 * FRAME_MS, pose: pose(0, 0, 0), status: 'NOT_AVAILABLE' })
  // Tracking returns where the camera really is, a little further on. Short of a second, no relocalization.
  const back = tracker.observe({ tMs: 4 * FRAME_MS, pose: pose(0.1), status: 'NORMAL' })
  assert.equal(back, null)
  assert.equal(tracker.epoch, 0)
  assert.equal(tracker.diagnostics().poseJumps, 0)
})

test('tracking that is LIMITED and RELOCALIZING, back to NORMAL, starts an epoch even with the pose unchanged', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  const event = tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(0), status: 'NORMAL' })
  assert.ok(event)
  assert.equal(event.epoch, 1)
  assert.equal(event.cause, 'recovered')
  assert.equal(event.reason, 'RELOCALIZING')
  assert.ok(Math.abs((event.degradedMs ?? -1) - FRAME_MS) < 1e-9, 'how long it was missing is in the event')
  assert.equal(event.translationM, 0, 'the pose did not move, which is exactly the case the jump test cannot see')
  assert.equal(tracker.diagnostics().poseJumps, 0, 'a suspect recovery is not a measured jump')
  assert.equal(tracker.diagnostics().epoch, 1)
})

test('tracking that is missing for a second or more starts an epoch when it returns, whatever the reason', () => {
  for (const [status, reason] of [['LIMITED', 'NOT_ENOUGH_TEXTURE'], ['LIMITED', undefined], ['NOT_AVAILABLE', undefined]] as const) {
    const tracker = established()
    tracker.observe({ tMs: 100, pose: pose(0), status, reason })
    const event = tracker.observe({ tMs: 100 + RECOVERY_SUSPECT_MS, pose: pose(0.5), status: 'NORMAL' })
    assert.equal(event?.cause, 'recovered', `${status} ${reason} for ${RECOVERY_SUSPECT_MS} ms`)
    assert.equal(event?.reason, reason, 'the reason it was degraded, when the runtime gave one')
  }
})

test('a blip shorter than that, with no relocalization, is not an epoch, but is counted as time', () => {
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0.1), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  tracker.observe({ tMs: 400, pose: pose(0.2), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  const back = tracker.observe({ tMs: 700, pose: pose(0.3), status: 'NORMAL' })
  assert.equal(back, null)
  assert.equal(tracker.epoch, 0)
  // 600 ms between the first degraded frame and the first good one.
  assert.equal(tracker.diagnostics().limitedMs, 600)
})

test('a pose that jumped across a short blip is still a jump', () => {
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  // 6 m in 0.2 s is 30 m/s; no person did that, and no relocalization was reported.
  const back = tracker.observe({ tMs: 200, pose: pose(6), status: 'NORMAL' })
  assert.equal(back?.cause, 'jump')
})

test('starting up is not a loss: LIMITED and INITIALIZING before the first NORMAL start no epoch', () => {
  const tracker = new FrameEpochTracker()
  tracker.observe({ tMs: 0, pose: pose(0), status: 'LIMITED', reason: 'INITIALIZING' })
  tracker.observe({ tMs: 2_000, pose: pose(0.5), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(tracker.observe({ tMs: 5_000, pose: pose(3), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 0)
  // And the first good pose is the baseline, not a jump from the guesses before it.
  assert.equal(tracker.observe({ tMs: 5_033, pose: pose(3.03), status: 'NORMAL' }), null)
  assert.equal(tracker.diagnostics().limitedMs, 0, 'start-up time is not time lost')
})

test('a runtime that starts out saying nothing and then initialises is still starting up, not recovering', () => {
  // A runtime may say UNSPECIFIED (or nothing) until it decides; if its first frames are that and
  // then LIMITED for the seconds it takes to initialise, the first NORMAL is the start of
  // tracking and not the end of a loss.
  const tracker = new FrameEpochTracker()
  tracker.observe({ tMs: 0, pose: pose(0), status: 'UNSPECIFIED' })
  tracker.observe({ tMs: 33, pose: pose(0), status: 'LIMITED', reason: 'INITIALIZING' })
  tracker.observe({ tMs: 3_000, pose: pose(0.1), status: 'LIMITED', reason: 'INITIALIZING' })
  assert.equal(tracker.observe({ tMs: 3_033, pose: pose(0.12), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 0)
  assert.equal(tracker.diagnostics().limitedMs, 0, 'start-up is not time lost')
  // Once it has been NORMAL, losing and regaining it is a loss.
  tracker.observe({ tMs: 4_000, pose: pose(0.12), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(tracker.observe({ tMs: 4_033, pose: pose(0.12), status: 'NORMAL' })?.cause, 'recovered')
})

test('a second session that starts out saying nothing is starting up too', () => {
  const tracker = established()
  tracker.noteSessionEnd()
  // The new session's first frame is the new map: one epoch. Its initialising is not a second.
  assert.equal(tracker.observe({ tMs: 90_000, pose: pose(7), status: 'UNSPECIFIED' })?.cause, 'resumed')
  tracker.observe({ tMs: 90_033, pose: pose(7), status: 'LIMITED', reason: 'INITIALIZING' })
  assert.equal(tracker.observe({ tMs: 93_000, pose: pose(7.1), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
})

test('a runtime that reports no status still has its jumps seen, and never has a recovery', () => {
  const tracker = new FrameEpochTracker()
  tracker.observe({ tMs: 0, pose: pose(0), status: 'UNKNOWN' })
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.02) })
  assert.equal(tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(0.5), status: 'UNSPECIFIED' })?.cause, 'jump')
  assert.equal(tracker.epoch, 1)
})

test('a frame with no usable pose, or a clock that is not a number, changes nothing', () => {
  const tracker = established()
  assert.equal(tracker.observe({ tMs: FRAME_MS, pose: null, status: 'NORMAL' }), null)
  assert.equal(tracker.observe({ tMs: FRAME_MS, pose: pose(Number.NaN), status: 'NORMAL' }), null)
  assert.equal(tracker.observe({ tMs: Number.NaN, pose: pose(5), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 0)
  // The baseline is still the first pose, so a real jump is still measured from it.
  assert.equal(tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(0.5), status: 'NORMAL' })?.cause, 'jump')
})

test('time degraded and time without a pose are counted apart, and a pause is not counted as tracking time', () => {
  const tracker = established()
  tracker.observe({ tMs: 1_000, pose: pose(0), status: 'LIMITED' })
  tracker.observe({ tMs: 1_500, pose: pose(0), status: 'NOT_AVAILABLE' })
  tracker.observe({ tMs: 1_800, pose: pose(0), status: 'NORMAL' })
  const d = tracker.diagnostics()
  assert.equal(d.limitedMs, 500)
  assert.equal(d.notAvailableMs, 300)
  // A minute with the page hidden, then one frame: counted as a second at most.
  tracker.observe({ tMs: 2_000, pose: pose(0), status: 'LIMITED' })
  tracker.observe({ tMs: 62_000, pose: pose(0), status: 'LIMITED' })
  assert.equal(tracker.diagnostics().limitedMs, 500 + 1_000)
})

test('the diagnostics carry the status, the reason, the epoch and the last jump', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.5, 1.5, 0, aboutY(12)), status: 'NORMAL' })
  tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(0.5, 1.5, 0, aboutY(12)), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  const d = tracker.diagnostics()
  assert.equal(d.status, 'LIMITED')
  assert.equal(d.reason, 'TOO_MUCH_MOTION')
  assert.equal(d.epoch, 1)
  assert.equal(d.poseJumps, 1)
  assert.ok(Math.abs(d.lastJumpM - 0.5) < 1e-9)
  assert.ok(Math.abs((d.lastJumpDeg ?? 0) - 12) < 1e-9)
  assert.equal(new FrameEpochTracker().diagnostics().status, 'UNKNOWN')
  assert.equal(new FrameEpochTracker().diagnostics().reason, undefined)
})

// ─── Resume, reset, session end ────────────────────────────────────────────

test('a resume starts an epoch, and the next pose is not compared with the pose from before the pause', () => {
  const tracker = established()
  const event = tracker.noteResume(60_000)
  assert.equal(event?.cause, 'resumed')
  assert.equal(event?.epoch, 1)
  // Five metres away, a minute later: the camera was carried. That is not a second discontinuity.
  assert.equal(tracker.observe({ tMs: 60_033, pose: pose(5), status: 'NORMAL' }), null)
  assert.equal(tracker.observe({ tMs: 60_066, pose: pose(5.03), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
})

test('a resume reported twice before a pose arrives is one resume', () => {
  // A pipeline module's onResume and the page's visibilitychange are two reports of one return.
  const tracker = established()
  assert.ok(tracker.noteResume(1_000))
  assert.equal(tracker.noteResume(1_001), null)
  assert.equal(tracker.epoch, 1)
  tracker.observe({ tMs: 1_033, pose: pose(0), status: 'NORMAL' })
  assert.ok(tracker.noteResume(9_000), 'a later resume, after a pose, is a new one')
  assert.equal(tracker.epoch, 2)
})

test('a resume before tracking was ever established starts nothing', () => {
  const tracker = new FrameEpochTracker()
  assert.equal(tracker.noteResume(10), null)
  assert.equal(tracker.epoch, 0)
})

test('a resume ends an episode of lost tracking instead of adding a second epoch for it', () => {
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.ok(tracker.noteResume(5_000))
  assert.equal(tracker.observe({ tMs: 5_100, pose: pose(1), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
})

test('a reset the runtime reports starts an epoch and carries the runtime\'s own transform', () => {
  const tracker = established()
  const transform = { position: { x: 0.2, y: 0, z: -0.1 }, orientation: aboutY(15) }
  const event = tracker.noteReset(500, transform)
  assert.equal(event?.cause, 'reset')
  assert.equal(event?.epoch, 1)
  assert.deepEqual(event?.transform, transform)
  assert.ok(Math.abs((event?.translationM ?? 0) - Math.hypot(0.2, 0.1)) < 1e-9)
  assert.ok(Math.abs((event?.yawDeg ?? 0) - 15) < 1e-9)
  assert.equal(tracker.diagnostics().poseJumps, 1, 'a reset is a reported move, counted with the measured ones')
  assert.ok(Math.abs(tracker.diagnostics().lastJumpM - Math.hypot(0.2, 0.1)) < 1e-9)
})

test('a reset with no transform (the spec allows the runtime to give none) is an epoch with no numbers', () => {
  const tracker = established()
  const event = tracker.noteReset(500, null)
  assert.equal(event?.cause, 'reset')
  assert.equal(event?.transform, null)
  assert.equal(event?.translationM, undefined, 'not measured, so not zero')
  assert.equal(event?.yawDeg, undefined)
})

test('the pose after a reset is in the new origin and is not compared with the old one', () => {
  const tracker = established()
  tracker.noteReset(500, { position: { x: 3, y: 0, z: 0 }, orientation: IDENTITY })
  // The camera did not move, and its coordinates changed by the reset: 3 m. Counted already.
  assert.equal(tracker.observe({ tMs: 533, pose: pose(-3), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.diagnostics().poseJumps, 1)
})

test('a reset reported twice, or before any pose, is counted once or not at all', () => {
  const tracker = new FrameEpochTracker()
  assert.equal(tracker.noteReset(1, null), null, 'nothing had been recorded in the old frame')
  tracker.observe({ tMs: 2, pose: pose(0), status: 'NORMAL' })
  assert.ok(tracker.noteReset(10, null))
  assert.equal(tracker.noteReset(10.5, null), null, 'the viewer space and the floor space can both say so')
  assert.equal(tracker.epoch, 1)
})

test('a session that ends and starts again is a new map: its first good frame starts an epoch', () => {
  const tracker = established()
  tracker.noteSessionEnd()
  assert.equal(tracker.diagnostics().status, 'UNKNOWN')
  const event = tracker.observe({ tMs: 90_000, pose: pose(7), status: 'NORMAL' })
  assert.equal(event?.cause, 'resumed')
  assert.equal(tracker.epoch, 1)
  // A session that was never established, ended, and started: nothing to be discontinuous from.
  const fresh = new FrameEpochTracker()
  fresh.noteSessionEnd()
  assert.equal(fresh.observe({ tMs: 0, pose: pose(0), status: 'NORMAL' }), null)
  assert.equal(fresh.epoch, 0)
})

// ─── Listeners and the log ─────────────────────────────────────────────────

test('subscribers hear each epoch as it begins, and stop hearing when they unsubscribe', () => {
  const tracker = established()
  const heard: FrameDiscontinuity[] = []
  const stop = tracker.subscribe((e) => heard.push(e))
  tracker.observe({ tMs: FRAME_MS, pose: pose(1), status: 'NORMAL' })
  tracker.noteResume(500)
  assert.deepEqual(heard.map((e) => [e.epoch, e.cause]), [[1, 'jump'], [2, 'resumed']])
  stop()
  tracker.observe({ tMs: 600, pose: pose(1.0), status: 'NORMAL' })
  tracker.noteResume(9_000)
  assert.equal(heard.length, 2)
})

test('a listener that throws is logged and does not stop the others or the tracker', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const tracker = established()
  const heard: number[] = []
  tracker.subscribe(() => {
    throw new Error('a bad listener')
  })
  tracker.subscribe((e) => heard.push(e.epoch))
  const event = tracker.observe({ tMs: FRAME_MS, pose: pose(1), status: 'NORMAL' })
  assert.equal(event?.epoch, 1)
  assert.deepEqual(heard, [1])
  assert.equal(warn.mock.calls.length, 1)
})

test('an event cannot be changed by whoever receives it', () => {
  const tracker = established()
  const event = tracker.observe({ tMs: FRAME_MS, pose: pose(1), status: 'NORMAL' })
  assert.ok(event)
  assert.throws(() => {
    ;(event as { epoch: number }).epoch = 99
  }, TypeError)
  assert.equal(tracker.log[0].epoch, 1)
})

test('the log keeps the most recent entries and the count of all of them', () => {
  const tracker = established()
  for (let i = 1; i <= FRAME_LOG_MAX + 10; i++) {
    tracker.noteResume(i * 1000)
    tracker.observe({ tMs: i * 1000 + 1, pose: pose(0), status: 'NORMAL' })
  }
  assert.equal(tracker.logTotal, FRAME_LOG_MAX + 10)
  assert.equal(tracker.log.length, FRAME_LOG_MAX)
  assert.equal(tracker.log[0].epoch, 11, 'the oldest ten were dropped')
  assert.equal(tracker.log[FRAME_LOG_MAX - 1].epoch, FRAME_LOG_MAX + 10)
  assert.equal(tracker.epoch, FRAME_LOG_MAX + 10)
})

test('the epoch never goes down', () => {
  const tracker = established()
  let last = tracker.epoch
  for (let i = 1; i <= 50; i++) {
    tracker.observe({ tMs: i * 100, pose: pose(i % 2 === 0 ? 0 : 3), status: i % 7 === 0 ? 'LIMITED' : 'NORMAL', reason: i % 7 === 0 ? 'RELOCALIZING' : undefined })
    if (i % 11 === 0) tracker.noteResume(i * 100 + 1)
    assert.ok(tracker.epoch >= last)
    last = tracker.epoch
  }
  assert.ok(last > 0)
})

// ─── A normal walk is not a shift ──────────────────────────────────────────

/** A seeded generator, so a failure is the same failure every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Walk {
  /** Poses with their frame times, as a provider would see them. */
  frames: Array<{ tMs: number; pose: Pose }>
}

/**
 * A person walking and scanning: 1.5 m/s along a path that weaves, the phone bobbing with
 * each step, nodding as it is aimed, and turning at 180 degrees a second for a second in
 * every five. Frames at 30 fps with timing jitter (a few ms either way), and one frame in a
 * hundred late by 100 to 250 ms, as a busy main thread delivers them. The poses carry a
 * few millimetres and a tenth of a degree of noise.
 */
function walk(seed: number, seconds: number, opts: { spin?: boolean } = {}): Walk {
  const rand = rng(seed)
  const frames: Walk['frames'] = []
  let t = 0
  while (t < seconds * 1000) {
    const s = t / 1000
    // Heading: 180 degrees a second for the first second of every five (so 180 degrees
    // more at the end of each), with a slow wander of a few degrees between. With `spin`,
    // 180 degrees a second throughout.
    const turned = 180 * Math.floor(s / 5) + 180 * Math.min(s % 5, 1)
    const heading = opts.spin ? 180 * s : turned + 6 * Math.sin(s)
    const x = 1.5 * s + 0.3 * Math.sin(s * 0.7)
    const z = 0.4 * Math.sin(s * 0.5)
    const y = 1.5 + 0.03 * Math.sin(2 * Math.PI * 1.8 * s)
    const nod = -25 + 12 * Math.sin(s * 0.9)
    const roll = 3 * Math.sin(s * 1.3)
    const q = mul(mul(aboutY(heading), aboutX(nod)), aboutZ(roll))
    const noise = () => (rand() - 0.5) * 0.004
    frames.push({
      tMs: t,
      pose: pose(x + noise(), y + noise(), z + noise(), mul(aboutY((rand() - 0.5) * 0.2), q)),
    })
    const stall = rand() < 0.01
    t += stall ? 100 + rand() * 150 : Math.max(16, FRAME_MS + (rand() - 0.5) * 20)
  }
  return { frames }
}

test('a walk at 1.5 m/s with 180 degree-per-second turns at 30 fps with jitter and stalls is never a shift', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const tracker = new FrameEpochTracker()
    const { frames } = walk(seed, 120)
    for (const f of frames) {
      const event = tracker.observe({ tMs: f.tMs, pose: f.pose, status: 'NORMAL' })
      assert.equal(event, null, `seed ${seed}: read as a shift at ${f.tMs.toFixed(0)} ms: ${JSON.stringify(event)}`)
    }
    assert.equal(tracker.epoch, 0, `seed ${seed}`)
    assert.equal(tracker.diagnostics().poseJumps, 0, `seed ${seed}`)
  }
})

test('the walk does contain frames the old fixed 0.30 m per-frame test would have called shifts', () => {
  // Without this the test above could pass because the walk was gentle. A stalled frame
  // delivers the next pose 100 to 250 ms late, and a person walks 0.15 to 0.38 m in that.
  let over = 0
  let maxTurnDeg = 0
  for (let seed = 1; seed <= 25; seed++) {
    const { frames } = walk(seed, 120)
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].pose
      const b = frames[i].pose
      if (Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z) > FRAME_JUMP_TRANSLATION_M) over++
      maxTurnDeg = Math.max(maxTurnDeg, yawDeltaDeg(a.rotation, b.rotation))
    }
  }
  assert.ok(over > 0, 'no frame of the walk moved more than 0.30 m, so it does not test the frame-rate independence')
  assert.ok(maxTurnDeg > FRAME_JUMP_YAW_DEG, `no frame of the walk turned more than ${FRAME_JUMP_YAW_DEG} degrees (largest ${maxTurnDeg.toFixed(1)})`)
})

test('turning on the spot at 180 degrees a second for a minute is never a shift either', () => {
  for (let seed = 100; seed < 110; seed++) {
    const tracker = new FrameEpochTracker()
    for (const f of walk(seed, 60, { spin: true }).frames) {
      assert.equal(tracker.observe({ tMs: f.tMs, pose: f.pose, status: 'NORMAL' }), null, `seed ${seed} at ${f.tMs.toFixed(0)} ms`)
    }
    assert.equal(tracker.epoch, 0)
  }
})

test('the walk is not vacuous: a 0.31 m shift dropped into it is seen once', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const tracker = new FrameEpochTracker()
    const { frames } = walk(seed, 30)
    // A shift is only visible against what a person could have walked since the last frame,
    // so put it on a frame that followed its predecessor on time.
    let at = 150
    while (frames[at].tMs - frames[at - 1].tMs > 40) at++
    const events: FrameDiscontinuity[] = []
    frames.forEach((f, i) => {
      // From frame `at` on, the whole map is 0.31 m to one side, as after a relocalization.
      const z = f.pose.position.z + (i >= at ? 0.31 : 0)
      const event = tracker.observe({ tMs: f.tMs, pose: pose(f.pose.position.x, f.pose.position.y, z, f.pose.rotation), status: 'NORMAL' })
      if (event) events.push(event)
    })
    assert.equal(events.length, 1, `seed ${seed}: the shift was read ${events.length} times`)
    assert.equal(events[0].cause, 'jump')
    assert.equal(tracker.epoch, 1)
  }
})

// ─── What one scan keeps ───────────────────────────────────────────────────

/** A provider-shaped source whose epoch and diagnostics a test sets, and whose events it fires. */
function fakeSource(): FrameEpochSource & {
  epoch: number
  limitedMs: number
  fire(event: Omit<FrameDiscontinuity, 'epoch'>): void
  refire(event: FrameDiscontinuity): void
  subscribers: number
} {
  const listeners = new Set<(e: FrameDiscontinuity) => void>()
  const source = {
    epoch: 0,
    limitedMs: 0,
    get subscribers() {
      return listeners.size
    },
    getFrameEpoch() {
      return source.epoch
    },
    getTrackingDiagnostics(): TrackingDiagnostics {
      return { status: 'NORMAL', poseJumps: 0, lastJumpM: 0, epoch: source.epoch, limitedMs: source.limitedMs }
    },
    onFrameDiscontinuity(cb: (e: FrameDiscontinuity) => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    fire(event: Omit<FrameDiscontinuity, 'epoch'>) {
      source.epoch++
      for (const l of [...listeners]) l({ ...event, epoch: source.epoch })
    },
    /** What the tracker does when a reset adds to the epoch a resume began: the same epoch, said again with more in it. */
    refire(event: FrameDiscontinuity) {
      for (const l of [...listeners]) l(event)
    },
  }
  return source
}

test('epochOf: a provider with no signal is epoch 0, and nonsense is 0 too', () => {
  assert.equal(epochOf(undefined), 0)
  assert.equal(epochOf(null), 0)
  assert.equal(epochOf({}), 0)
  assert.equal(epochOf({ getFrameEpoch: () => 7 }), 7)
  assert.equal(epochOf({ getFrameEpoch: () => -3 }), 0)
  assert.equal(epochOf({ getFrameEpoch: () => Number.NaN }), 0)
  assert.equal(epochOf({ getFrameEpoch: () => 2.9 }), 2)
})

test('a scan counts the discontinuities since it began, not since the session did', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'jump', atMs: 1, translationM: 0.4 })
  source.fire({ cause: 'resumed', atMs: 2 })
  assert.equal(log.frameShifts, 2)
  assert.equal(log.currentEpoch, 2)
  assert.equal(log.baseEpoch, 0)

  // A new scan inside the same AR session: the count starts again, the epoch does not.
  log.reset()
  assert.equal(log.frameShifts, 0)
  assert.equal(log.baseEpoch, 2)
  assert.equal(log.currentEpoch, 2)
  source.fire({ cause: 'recovered', atMs: 3 })
  assert.equal(log.frameShifts, 1)
  assert.equal(log.hasDiscontinuitySince(2), true)
  assert.equal(log.hasDiscontinuitySince(3), false)
  assert.deepEqual(log.discontinuitiesSince(2).map((j) => [j.epoch, j.cause]), [[3, 'recovered']])
  assert.deepEqual(log.discontinuitiesSince(3), [])
})

test('a scan log on a provider with no signal reports nothing, and its snapshot says epoch 0', () => {
  const log = new ScanFrameEpochLog()
  log.attach({})
  assert.equal(log.frameShifts, 0)
  assert.equal(log.currentEpoch, 0)
  const record = log.snapshot()
  assert.equal(record.version, 1)
  assert.equal(record.baseEpoch, 0)
  assert.equal(record.currentEpoch, 0)
  assert.equal(record.jumpCount, 0)
  assert.equal(record.mixedEpochs, false)
  assert.equal(record.floorEpoch, null)
  assert.deepEqual(record.epochs.map((e) => e.epoch), [0])
  assert.equal(record.epochs[0].cause, 'start')
})

test('the scan log measures time degraded from the start of the scan', () => {
  const source = fakeSource()
  source.limitedMs = 4_000
  const log = new ScanFrameEpochLog()
  log.attach(source)
  assert.equal(log.limitedMs, 0, 'what the session spent before this scan is not this scan\'s')
  source.limitedMs = 6_500
  assert.equal(log.limitedMs, 2_500)
  log.reset()
  assert.equal(log.limitedMs, 0)
})

test('attaching again stops listening to the first provider', () => {
  const a = fakeSource()
  const b = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(a)
  log.attach(b)
  assert.equal(a.subscribers, 0)
  a.fire({ cause: 'jump', atMs: 1 })
  assert.equal(log.frameShifts, 0)
  b.fire({ cause: 'jump', atMs: 1 })
  assert.equal(log.frameShifts, 1)
  log.detach()
  assert.equal(b.subscribers, 0)
})

/** A point cloud's epoch summary, as the sidecar reads it. */
function fakeCloud(counts: Array<[number, number]>, grounds: Record<number, number>): FrameEpochCloud {
  return {
    epochCounts: () => counts.map(([epoch, count]) => ({ epoch, count })),
    groundObjects: () =>
      Object.entries(grounds).map(([epoch, y]) => ({
        y,
        epoch: Number(epoch),
        normal: { x: 0, y: 1, z: 0 },
        locked: true,
        sampleCount: 300,
        inlierCount: 280,
        residualM: 0.004,
        fallback: false,
      })),
  }
}

test('the sidecar record lists each epoch with its cause, its points and its floor, and the jump log', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'jump', atMs: 1_000, translationM: 0.4, yawDeg: 3, speedMps: 12 })
  source.fire({ cause: 'recovered', atMs: 9_000, degradedMs: 2_000, reason: 'RELOCALIZING' })
  const record = log.snapshot(fakeCloud([[0, 400], [1, 250], [2, 60]], { 0: 0, 1: 0.3 }))

  assert.equal(record.baseEpoch, 0)
  assert.equal(record.currentEpoch, 2)
  assert.equal(record.floorEpoch, 0)
  assert.equal(record.mixedEpochs, true)
  assert.equal(record.jumpCount, 2)
  assert.equal(record.epochCount, 3)
  assert.deepEqual(record.epochs.map((e) => [e.epoch, e.cause, e.pointCount, e.ground?.y ?? null]), [
    [0, 'start', 400, 0],
    [1, 'jump', 250, 0.3],
    [2, 'recovered', 60, null],
  ])
  assert.ok(record.epochs.every((e) => typeof e.startedAt === 'string' && !Number.isNaN(Date.parse(e.startedAt))))
  assert.deepEqual(record.jumps.map((j) => [j.epoch, j.cause]), [[1, 'jump'], [2, 'recovered']])
  assert.equal(record.jumps[0].translationM, 0.4)
  assert.equal(record.jumps[1].reason, 'RELOCALIZING')
  assert.ok(record.jumps.every((j) => typeof j.at === 'string' && !Number.isNaN(Date.parse(j.at))))
  assert.deepEqual(record.thresholds, { ...FRAME_EPOCH_ADOPTED, basis: 'adopted, not measured' })
  assert.equal(record.floorBasis, 'locked')
  assert.equal(record.calibrationEpoch, null, 'the scan was not calibrated')
  assert.equal(record.epochsOmitted, 0)
  assert.equal(record.suppressedJumps, 0)
  assert.equal(record.motion, null, 'this source keeps no motion statistics')
  // It is what goes into a JSON sidecar, so it has to survive one.
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record)
})

test('an epoch the scan holds no points in is still listed, so the current frame is never missing', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'resumed', atMs: 5 })
  const record = log.snapshot(fakeCloud([[0, 100]], { 0: 0 }))
  assert.deepEqual(record.epochs.map((e) => [e.epoch, e.pointCount]), [[0, 100], [1, 0]])
  assert.equal(record.mixedEpochs, false, 'one epoch holds points')
  assert.equal(record.floorEpoch, 0)
})

test('the record keeps the most recent entries and counts all of them', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  for (let i = 0; i < FRAME_LOG_MAX + 20; i++) source.fire({ cause: 'resumed', atMs: i })
  const record = log.snapshot()
  assert.equal(record.jumpCount, FRAME_LOG_MAX + 20)
  assert.equal(record.jumps.length, FRAME_LOG_MAX)
  assert.equal(record.jumps[0].epoch, 21)
  assert.equal(record.epochCount, FRAME_LOG_MAX + 21, 'the epochs the log dropped still happened')
  assert.equal(record.epochs.length, FRAME_LOG_MAX)
  assert.equal(record.epochs[FRAME_LOG_MAX - 1].epoch, FRAME_LOG_MAX + 20)
})

// ─── Quick re-aims, late frames, and what a page's clock does to frame times ──

const minJerk = (u: number): number => {
  const x = Math.min(1, Math.max(0, u))
  return 10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5
}

/**
 * The heading, in degrees, of a person who holds still, then sweeps `amplitudeDeg` in
 * `durationS` (a smooth, minimum-jerk re-aim, the way a hand moves), and holds again, once
 * every `everyS` seconds, always the same way round.
 */
function sweeps(amplitudeDeg: number, durationS: number, everyS: number): (s: number) => number {
  return (s) => {
    const n = Math.floor(s / everyS)
    return amplitudeDeg * n + amplitudeDeg * minJerk((s - n * everyS) / durationS)
  }
}

/** Frame times in ms for `seconds` at `fps`, each up to `jitter` of a period early or late. */
function frameTimes(seconds: number, fps: number, seed: number, jitter = 0.2): number[] {
  const rand = rng(seed)
  const out: number[] = []
  let t = 0
  while (t < seconds * 1000) {
    out.push(t)
    t += (1000 / fps) * (1 + (rand() * 2 - 1) * jitter)
  }
  return out
}

/**
 * What the engine delivers on a page that renders at `hz`: of the camera frames that arrived
 * since the last rendering tick, the newest, stamped with the tick's time (the pose is the
 * camera frame's own: `at`). `hz` 0 is an exact clock. A 30 fps camera on a 60 Hz page reads
 * as intervals of 17, 33 and 50 ms for what is one steady 33 ms.
 */
function delivered(times: number[], hz: number): Array<{ at: number; clock: number }> {
  if (hz === 0) return times.map((t) => ({ at: t, clock: t }))
  const period = 1000 / hz
  const out: Array<{ at: number; clock: number }> = []
  let i = 0
  for (let tick = period; tick <= times[times.length - 1] + period; tick += period) {
    let pick = -1
    while (i < times.length && times[i] <= tick) pick = i++
    if (pick >= 0) out.push({ at: times[pick], clock: tick })
  }
  return out
}

/** A walk along +x at 1.2 m/s, the phone nodded 25 degrees down, heading `heading(s)` degrees. */
function walkingAt(s: number, heading: (s: number) => number): Pose {
  return pose(1.2 * s, 1.5, 0, mul(aboutY(heading(s)), aboutX(-25)))
}

test('a quick re-aim is not a shift, at any frame rate, on an exact clock or on the page\'s', () => {
  // 120 degrees in 0.5 s every 4 s, while walking. It peaks near 450 degrees a second, which
  // is the quick end of an ordinary re-aim. With a fixed cap on the turn rate (240 degrees
  // a second, say) this read nearly every frame of the sweep as a shift at 30 fps,
  // about 28 a minute, and none at 120 fps.
  //
  // The page's clock is tried at 60 and 120 Hz for the cameras it can follow: a page that
  // renders slower than twice the camera's rate delivers one frame in two or three, with
  // intervals that are 100 percent clock, and there is no motion model for that.
  const heading = sweeps(120, 0.5, 4)
  for (const fps of [15, 20, 24, 30, 45, 60, 90, 120]) {
    for (const hz of [0, 60, 120]) {
      if (hz !== 0 && hz < 2 * fps) continue
      for (let seed = 1; seed <= 5; seed++) {
        const tracker = new FrameEpochTracker()
        for (const { at, clock } of delivered(frameTimes(40, fps, seed), hz)) {
          tracker.observe({ tMs: clock, pose: walkingAt(at / 1000, heading), status: 'NORMAL' })
        }
        assert.equal(tracker.epoch, 0, `${fps} fps on ${hz === 0 ? 'an exact' : `a ${hz} Hz page`} clock, seed ${seed}: read as a shift`)
      }
    }
  }
})

test('the re-aim test is not vacuous: a cap on the turn rate of 240 degrees a second would have called it a shift', () => {
  const heading = sweeps(120, 0.5, 4)
  let capped = 0
  let prev: { at: number; pose: Pose } | null = null
  for (const { at } of delivered(frameTimes(40, 30, 1), 0)) {
    const here = walkingAt(at / 1000, heading)
    if (prev) {
      const turn = yawDeltaDeg(prev.pose.rotation, here.rotation)
      if (turn >= 8 && turn / ((at - prev.at) / 1000) >= 240) capped++
    }
    prev = { at, pose: here }
  }
  assert.ok(capped >= 20, `a cap of 240 degrees a second reads ${capped} steps of this as shifts, so the cases above are a real test`)
})

test('a steady turn, at any rate a person can sustain and any frame rate, is never a shift', () => {
  for (const fps of [5, 8, 10, 15, 20, 24, 30, 45, 60, 120]) {
    for (const rate of [90, 180, 240, 360, 600, 900]) {
      // A turn of more than a third of a circle between two frames cannot be told from its
      // opposite: the heading change is only known modulo a turn. No camera does that.
      if (rate / fps > 120) continue
      const tracker = new FrameEpochTracker()
      const dt = 1000 / fps
      for (let i = 0; i <= (2 * 1000) / dt; i++) {
        tracker.observe({ tMs: i * dt, pose: pose(0, 1.5, 0, mul(aboutY((rate * i * dt) / 1000), aboutX(-25))), status: 'NORMAL' })
      }
      assert.equal(tracker.epoch, 0, `${rate} degrees a second at ${fps} fps`)
    }
  }
})

test('frame times only as exact as the page\'s animation frame do not turn a steady sweep into a shift', () => {
  // A 30 fps camera on a 60 Hz page: intervals of 17, 33 and 50 ms for one steady 33 ms. A
  // rate taken from the last interval and applied to the next is wrong by up to three times
  // here; the step before it is not.
  for (const rate of [200, 400, 600]) {
    for (const hz of [60, 120]) {
      const tracker = new FrameEpochTracker()
      for (const { at, clock } of delivered(frameTimes(3, 30, 7, 0.1), hz)) {
        tracker.observe({ tMs: clock, pose: pose(0, 1.5, 0, mul(aboutY((rate * at) / 1000), aboutX(-25))), status: 'NORMAL' })
      }
      assert.equal(tracker.epoch, 0, `${rate} degrees a second, 30 fps camera on a ${hz} Hz page`)
    }
  }
})

test('a shift in the middle of a quick sweep is still seen, once, and is sized by what the sweep did not explain', () => {
  const heading = sweeps(90, 0.4, 4)
  const tracker = new FrameEpochTracker()
  const events: FrameDiscontinuity[] = []
  for (const { at, clock } of delivered(frameTimes(8, 30, 3, 0), 0)) {
    // The map turns 14 degrees under the camera partway through the second sweep.
    const shifted = at >= 4_200 ? 14 : 0
    const event = tracker.observe({ tMs: clock, pose: walkingAt(at / 1000, (s) => heading(s) + shifted), status: 'NORMAL' })
    if (event) events.push(event)
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].cause, 'jump')
  // The turn in the step is the sweep's and the shift's; what was not explained is the shift, less what the sweep was changing by.
  assert.ok((events[0].yawDeg ?? 0) > (events[0].unexplainedYawDeg ?? 99), 'the step is bigger than the part of it that is the shift')
  assert.ok(Math.abs((events[0].unexplainedYawDeg ?? 0) - 14) < 4, `unexplained ${events[0].unexplainedYawDeg}`)
})

test('a sideways shift while walking is seen once, and the size shown is the shift, not the walk\'s share of the step', () => {
  const tracker = new FrameEpochTracker()
  let event: FrameDiscontinuity | null = null
  const times = frameTimes(6, 30, 5, 0)
  for (const at of times) {
    const z = at >= 3_000 ? 0.4 : 0
    const e = tracker.observe({ tMs: at, pose: pose(1.5 * (at / 1000), 1.5, z), status: 'NORMAL' })
    if (e) event = e
  }
  assert.ok(event)
  assert.ok(Math.abs((event.translationM ?? 0) - Math.hypot(0.05, 0.4)) < 0.005, 'the step: a frame of walking and the shift')
  assert.ok(Math.abs((event.unexplainedM ?? 0) - 0.4) < 0.005, 'the shift')
  assert.ok(Math.abs(tracker.diagnostics().lastJumpM - 0.4) < 0.005, 'and the readout shows the shift')
  assert.equal(tracker.epoch, 1)
})

/**
 * Whether one isolated step of `size` (metres of translation, or degrees about the vertical)
 * arriving `dtMs` after the frame before is read as a shift, after ten steady 30 fps frames
 * of a camera that is otherwise still.
 */
function seen(kind: 'translation' | 'yaw', size: number, dtMs: number): boolean {
  const tracker = new FrameEpochTracker()
  let t = 0
  for (let i = 0; i < 10; i++, t += 1000 / 30) tracker.observe({ tMs: t, pose: pose(0), status: 'NORMAL' })
  t += dtMs - 1000 / 30
  const shifted = kind === 'translation' ? pose(size) : pose(0, 1.5, 0, aboutY(size))
  return tracker.observe({ tMs: t, pose: shifted, status: 'NORMAL' }) !== null
}

test('what a step has to be to be seen, steady and late: the numbers the header of frame-epoch.ts states', () => {
  // Steady 30 fps: the floors. 0.30 m, and 8 degrees.
  assert.equal(seen('translation', 0.29, 1000 / 30), false)
  assert.equal(seen('translation', 0.31, 1000 / 30), true)
  assert.equal(seen('yaw', 7.9, 1000 / 30), false)
  assert.equal(seen('yaw', 8.1, 1000 / 30), true)
  // After one dropped frame (67 ms) a turn has to be 16.7 degrees, since a hand can change
  // the turn by that much in the time; a translation is still the floor.
  assert.equal(seen('yaw', 15, 2000 / 30), false)
  assert.equal(seen('yaw', 18, 2000 / 30), true)
  assert.equal(seen('translation', 0.31, 2000 / 30), true, 'a 0.31 m shift after one dropped frame, which a fixed 5 m/s bound missed')
  // After a 200 ms stall, 0.70 m, and 117 degrees.
  assert.equal(seen('translation', 0.65, 200), false)
  assert.equal(seen('translation', 0.75, 200), true)
  assert.equal(seen('yaw', 110, 200), false)
  assert.equal(seen('yaw', 125, 200), true)
})

test('a turn the camera makes between two frames 50 ms apart has to be 10 degrees, not 8', () => {
  assert.equal(seen('yaw', 10.0, 50), false)
  assert.equal(seen('yaw', 10.8, 50), true)
})

test('the floors are the least a step can be: nothing smaller is ever a shift, however late the frame', () => {
  for (const dtMs of [8, 16, 33, 50]) {
    assert.equal(seen('translation', 0.29, dtMs), false, `0.29 m after ${dtMs} ms`)
    assert.equal(seen('yaw', 7.9, dtMs), false, `7.9 degrees after ${dtMs} ms`)
  }
})

test('a step the size of a stalled one, right after it, is a shift, not the same step again', () => {
  // After a stall that moved the camera 0.6 m in 400 ms (walking), one 33 ms frame that moves
  // it 0.6 m is not walking. The step before it is the wrong thing to compare it with: they
  // are not intervals of the same kind.
  const tracker = established()
  tracker.observe({ tMs: 400, pose: pose(0.6), status: 'NORMAL' })
  assert.equal(tracker.observe({ tMs: 400 + FRAME_MS, pose: pose(1.2), status: 'NORMAL' })?.cause, 'jump')
})

// ─── Jumps that come close behind one another ──────────────────────────────

/** Three steady frames at `x` (so a step after them is judged), ending at `t`. */
function steadyUntil(tracker: FrameEpochTracker, t: number, x: number): void {
  for (const dt of [2, 1, 0]) tracker.observe({ tMs: t - dt * FRAME_MS, pose: pose(x), status: 'NORMAL' })
}

test('a second jump close behind the first is one disturbance: no new epoch, and it is counted', () => {
  const tracker = established()
  assert.equal(tracker.observe({ tMs: FRAME_MS, pose: pose(0.4), status: 'NORMAL' })?.cause, 'jump')
  // The map corrects again 330 ms later, after a few steady frames.
  steadyUntil(tracker, 300, 0.4)
  assert.equal(tracker.observe({ tMs: 300 + FRAME_MS, pose: pose(0.9), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
  const d = tracker.diagnostics()
  assert.equal(d.poseJumps, 1)
  assert.equal(d.suppressedJumps, 1, 'what was folded in is counted, so a threshold that is too tight shows')
})

test('a jump after the refractory window is a new epoch', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.4), status: 'NORMAL' })
  const later = FRAME_JUMP_REFRACTORY_MS + FRAME_MS + 1
  steadyUntil(tracker, later, 0.4)
  assert.equal(tracker.observe({ tMs: later + FRAME_MS, pose: pose(0.9), status: 'NORMAL' })?.cause, 'jump')
  assert.equal(tracker.epoch, 2)
  assert.equal(tracker.diagnostics().suppressedJumps, 0)
})

test('a pose that flips between two places every frame is one epoch, and the flips are counted as folded in', () => {
  const tracker = established()
  for (let i = 1; i <= 12; i++) tracker.observe({ tMs: i * FRAME_MS, pose: pose(i % 2 === 1 ? 0.5 : 0), status: 'NORMAL' })
  assert.equal(tracker.epoch, 1, 'an engine that cannot settle is one disturbance, not twelve epochs')
  const d = tracker.diagnostics()
  assert.equal(d.poseJumps, 1)
  assert.ok((d.suppressedJumps ?? 0) >= 4, `${d.suppressedJumps} folded in`)
})

test('a correction that goes on at a constant rate is one jump, at the step it began, and then a velocity', () => {
  const tracker = established()
  for (let i = 1; i <= 12; i++) tracker.observe({ tMs: i * FRAME_MS, pose: pose(i * 0.5), status: 'NORMAL' })
  // The camera was still, and the first 0.5 m step is not predicted by that. The eleven that
  // follow are: 15 m/s sustained is not a person, and it is not a discontinuity either.
  assert.equal(tracker.epoch, 1)
  const d = tracker.diagnostics()
  assert.equal(d.poseJumps, 1)
  assert.equal(d.suppressedJumps, 0)
})

test('after a jump the next step has nothing before it to be judged against, and the one after it does', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.4), status: 'NORMAL' })
  // Outside the refractory window, so a jump here would be a new epoch if it were judged.
  const t = FRAME_JUMP_REFRACTORY_MS + 100
  assert.equal(tracker.observe({ tMs: t, pose: pose(5), status: 'NORMAL' }), null, 'the first step after a jump is not judged')
  assert.equal(tracker.observe({ tMs: t + FRAME_MS, pose: pose(5), status: 'NORMAL' }), null)
  assert.equal(tracker.observe({ tMs: t + 2 * FRAME_MS, pose: pose(9), status: 'NORMAL' })?.cause, 'jump')
})

// ─── A recovery that comes with a measured move ────────────────────────────

test('a relocalization that snaps the map is counted as a measured jump as well as a recovery', () => {
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  // The map snaps 2 m and 40 degrees at the frame tracking returns.
  const event = tracker.observe({ tMs: 200, pose: pose(2, 1.5, 0, aboutY(40)), status: 'NORMAL' })
  assert.equal(event?.cause, 'recovered')
  assert.equal(event?.reason, 'RELOCALIZING')
  assert.ok(Math.abs((event?.translationM ?? 0) - 2) < 1e-9)
  assert.ok(Math.abs((event?.unexplainedM ?? 0) - 2) < 1e-9, 'it is a measured jump, so the unexplained part is there too')
  const d = tracker.diagnostics()
  assert.equal(d.epoch, 1, 'one epoch for it, not a recovery and a jump')
  assert.equal(d.poseJumps, 1, 'before this the readout said "no frame shifts" after a 2 m snap')
  assert.ok(Math.abs(d.lastJumpM - 2) < 1e-9)
  assert.ok(Math.abs((d.lastJumpDeg ?? 0) - 40) < 1e-9)
})

test('a long loss with the pose carried a long way is suspect, and is not called a measured jump', () => {
  // 3.2 m over 1.5 s is 2.1 m/s: a brisk walk, and what the code cannot tell from a shift.
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'NOT_ENOUGH_TEXTURE' })
  const event = tracker.observe({ tMs: 1_600, pose: pose(3.2), status: 'NORMAL' })
  assert.equal(event?.cause, 'recovered')
  assert.ok(Math.abs((event?.translationM ?? 0) - 3.2) < 1e-9, 'how far the pose moved is recorded')
  assert.equal(event?.unexplainedM, undefined, 'and not claimed to be a measurement of a shift')
  assert.equal(tracker.diagnostics().poseJumps, 0)
})

test('a walk through a long loss with the poses continuing is a recovery by duration, and no measured jump', () => {
  const tracker = established()
  // LIMITED for 1.2 s, the pose still arriving each frame, the person walking 1.5 m/s.
  let t = 0
  for (let i = 1; i <= 36; i++) {
    t = i * FRAME_MS
    tracker.observe({ tMs: t, pose: pose(1.5 * (t / 1000)), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  }
  t += FRAME_MS
  const event = tracker.observe({ tMs: t, pose: pose(1.5 * (t / 1000)), status: 'NORMAL' })
  assert.equal(event?.cause, 'recovered')
  assert.equal(tracker.diagnostics().poseJumps, 0, 'the walk is not a shift')
})

test('a shift between two frames the engine is unsure of is seen where the pose steps, as it was before epochs', () => {
  // Followed but not judged, a map that moved 1 m inside a 600 ms blip (no relocalization, under a
  // second) would read as nothing. The detector this replaced counted every step whatever the
  // status, and this does too.
  const tracker = established()
  const events: FrameDiscontinuity[] = []
  let t = 0
  for (let i = 1; i <= 18; i++) {
    t = i * FRAME_MS
    // LIMITED from frame 1 to 18; the map moves 1 m at frame 9.
    const e = tracker.observe({ tMs: t, pose: pose(i >= 9 ? 1 : 0), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
    if (e) events.push(e)
  }
  t += FRAME_MS
  const back = tracker.observe({ tMs: t, pose: pose(1), status: 'NORMAL' })
  if (back) events.push(back)
  assert.deepEqual(events.map((e) => e.cause), ['jump'], 'one epoch, at the step, and the return of tracking is not a second')
  assert.ok(Math.abs((events[0].unexplainedM ?? 0) - 1) < 1e-9)
  assert.equal(events[0].atMs, 9 * FRAME_MS)
  assert.equal(tracker.diagnostics().poseJumps, 1)
})

test('a relocalization that already had its epoch from a jump inside it does not get a second at its end', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  tracker.observe({ tMs: 2 * FRAME_MS, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(tracker.observe({ tMs: 3 * FRAME_MS, pose: pose(2), status: 'LIMITED', reason: 'RELOCALIZING' })?.cause, 'jump')
  assert.equal(tracker.observe({ tMs: 4 * FRAME_MS, pose: pose(2), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
})

test('a snap at the step where tracking returns, after a short blip, is seen once', () => {
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  tracker.observe({ tMs: 133, pose: pose(0), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  tracker.observe({ tMs: 166, pose: pose(0), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
  const back = tracker.observe({ tMs: 199, pose: pose(1), status: 'NORMAL' })
  assert.equal(back?.cause, 'jump')
  assert.equal(tracker.epoch, 1)
})

test('a pose the engine is unsure of does not make a jump of what a person walked, or turned, while it was unsure', () => {
  const tracker = established()
  const heading = sweeps(120, 0.5, 4)
  let t = 0
  for (let i = 0; i < 120; i++) {
    t = i * FRAME_MS
    const status = i % 40 < 10 ? 'LIMITED' : 'NORMAL'
    tracker.observe({ tMs: t, pose: walkingAt(t / 1000, heading), status, reason: status === 'LIMITED' ? 'TOO_MUCH_MOTION' : undefined })
  }
  assert.equal(tracker.epoch, 0)
})

// ─── One trip away is one epoch ────────────────────────────────────────────

test('a resume, the seconds the engine then spends re-establishing tracking, and its return, are one epoch', () => {
  const tracker = established()
  assert.equal(tracker.noteResume(10_000)?.cause, 'resumed')
  // Back from another app: 2.5 s of LIMITED while the engine starts over, then NORMAL. A second
  // epoch here, 'recovered', would be the same trip counted twice.
  tracker.observe({ tMs: 10_033, pose: pose(3), status: 'LIMITED', reason: 'INITIALIZING' })
  tracker.observe({ tMs: 11_000, pose: pose(3), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(tracker.observe({ tMs: 12_533, pose: pose(3.1), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.logTotal, 1)
  // And the trip is over: the next loss is a loss of its own.
  tracker.observe({ tMs: 13_000, pose: pose(3.1), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(tracker.observe({ tMs: 13_100, pose: pose(3.1), status: 'NORMAL' })?.cause, 'recovered')
  assert.equal(tracker.epoch, 2)
})

test('a reset that comes after a resume, before the first pose, is the same trip: it adds the runtime\'s transform and is counted once', () => {
  const tracker = established()
  const heard: FrameDiscontinuity[] = []
  tracker.subscribe((e) => heard.push(e))
  assert.equal(tracker.noteResume(10_000, 4_200.4)?.hiddenMs, 4_200)
  const transform = { position: { x: 0.8, y: 0, z: -0.5 }, orientation: aboutY(23) }
  const amended = tracker.noteReset(10_001, transform)
  assert.equal(amended?.epoch, 1, 'the same epoch')
  assert.equal(amended?.cause, 'reset', 'the runtime reporting the move is the stronger statement')
  assert.equal(amended?.hiddenMs, 4_200, 'and what the resume knew is kept')
  assert.deepEqual(amended?.transform, transform)
  assert.ok(Math.abs((amended?.translationM ?? 0) - Math.hypot(0.8, 0.5)) < 1e-9)
  assert.ok(Math.abs((amended?.yawDeg ?? 0) - 23) < 1e-9)
  assert.equal(tracker.epoch, 1, 'no second epoch')
  assert.equal(tracker.logTotal, 1)
  assert.equal(tracker.log[0].cause, 'reset', 'the log holds the event as it now reads')
  const d = tracker.diagnostics()
  assert.equal(d.poseJumps, 1, 'before this a reset that followed a resume was dropped, with the runtime\'s own measurement')
  assert.ok(Math.abs(d.lastJumpM - Math.hypot(0.8, 0.5)) < 1e-9)
  // The listeners were told twice about epoch 1: the resume, and then what the reset added.
  assert.deepEqual(heard.map((e) => [e.epoch, e.cause]), [[1, 'resumed'], [1, 'reset']])
})

test('a second reset on the other space, with nothing to add, changes nothing; one with a transform fills in a null one', () => {
  const tracker = established()
  tracker.noteResume(10_000)
  assert.equal(tracker.noteReset(10_001, null)?.cause, 'reset', 'the first report')
  assert.equal(tracker.noteReset(10_002, null), null, 'the second, with nothing in it')
  const transform = { position: { x: 0.3, y: 0, z: 0 }, orientation: IDENTITY }
  const filled = tracker.noteReset(10_003, transform)
  assert.deepEqual(filled?.transform, transform)
  assert.equal(tracker.diagnostics().poseJumps, 1, 'one move')
  assert.equal(tracker.noteReset(10_004, { position: { x: 9, y: 0, z: 0 }, orientation: IDENTITY }), null, 'the first description stands')
  assert.equal(tracker.epoch, 1)
})

test('a reset after the first pose of the new stretch is a new move', () => {
  const tracker = established()
  tracker.noteResume(10_000)
  tracker.observe({ tMs: 10_033, pose: pose(3), status: 'NORMAL' })
  assert.equal(tracker.noteReset(10_100, null)?.epoch, 2)
})

test('a reset that comes after a degraded pose, still in the trip, is a new move: the runtime reports resets before the frames that use the new origin', () => {
  const tracker = established()
  tracker.noteResume(10_000)
  tracker.observe({ tMs: 10_033, pose: pose(3), status: 'LIMITED', reason: 'INITIALIZING' })
  assert.equal(tracker.noteReset(10_100, null)?.epoch, 2)
})

test('how long the page was away is recorded when the caller saw both ends, and left out when it did not', () => {
  const seen = established()
  assert.equal(seen.noteResume(10_000, 80)?.hiddenMs, 80, 'a peek is an epoch too: how short a trip can be and still matter is for DX4 to say')
  const unseen = established()
  assert.equal(unseen.noteResume(10_000)?.hiddenMs, undefined)
  const nonsense = established()
  assert.equal(nonsense.noteResume(10_000, Number.NaN)?.hiddenMs, undefined)
  assert.equal(established().noteResume(10_000, -5)?.hiddenMs, 0)
})

// ─── Telling the listeners when the provider is consistent ─────────────────

test('a tracker made to defer tells its listeners at flush(), in order, and not before', () => {
  const tracker = new FrameEpochTracker({}, { deferNotify: true })
  for (const tMs of [-2 * FRAME_MS, -FRAME_MS, 0]) tracker.observe({ tMs, pose: pose(0), status: 'NORMAL' })
  const heard: Array<[number, string]> = []
  tracker.subscribe((e) => heard.push([e.epoch, e.cause]))
  assert.equal(tracker.observe({ tMs: FRAME_MS, pose: pose(0.5), status: 'NORMAL' })?.epoch, 1, 'it decides at once')
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.log.length, 1)
  assert.deepEqual(heard, [], 'but the listeners wait for the provider to finish reading the frame')
  tracker.noteResume(1_000)
  tracker.flush()
  assert.deepEqual(heard, [[1, 'jump'], [2, 'resumed']])
  tracker.flush()
  assert.equal(heard.length, 2, 'once each')
})

test('a tracker that was not made to defer tells its listeners as each event begins', () => {
  const tracker = established()
  const heard: number[] = []
  tracker.subscribe((e) => heard.push(e.epoch))
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.5), status: 'NORMAL' })
  assert.deepEqual(heard, [1])
})

test('ending a session tells the listeners what was held for them', () => {
  const tracker = new FrameEpochTracker({}, { deferNotify: true })
  tracker.observe({ tMs: 0, pose: pose(0), status: 'NORMAL' })
  const heard: number[] = []
  tracker.subscribe((e) => heard.push(e.epoch))
  tracker.noteResume(10)
  tracker.noteSessionEnd()
  assert.deepEqual(heard, [1])
})

// ─── An event is what the runtime said, and nobody can change it ───────────

test('the transform in an event, and its parts, cannot be changed by a listener, and is not the runtime\'s own object', () => {
  const tracker = established()
  const given = { position: { x: 0.1, y: 0, z: 0 }, orientation: IDENTITY }
  tracker.subscribe((e) => {
    assert.throws(() => {
      ;(e.transform as { position: { x: number } }).position.x = 99
    }, TypeError)
    assert.throws(() => {
      ;(e.transform as { orientation: { w: number } }).orientation.w = 99
    }, TypeError)
  })
  const event = tracker.noteReset(500, given)
  assert.ok(event)
  assert.equal(tracker.log[0].transform?.position.x, 0.1)
  // The runtime's own object is not frozen by being given to us, and changing it later does not change the record.
  given.position.x = 7
  assert.equal(tracker.log[0].transform?.position.x, 0.1)
})

// ─── How the camera moved: what DX4 needs to set the thresholds ────────────

test('the motion statistics say how fast, how often and how steadily the camera moved while tracking was good', () => {
  const tracker = new FrameEpochTracker()
  const fps = 30
  for (let i = 0; i <= fps * 4; i++) {
    const s = i / fps
    tracker.observe({ tMs: s * 1000, pose: pose(1.5 * s, 1.5, 0, mul(aboutY(150 * s), aboutX(-25))), status: 'NORMAL' })
  }
  const motion = tracker.diagnostics().motion
  assert.ok(motion)
  assert.equal(motion.steps, fps * 4)
  assert.ok(Math.abs(motion.peakSpeedMps - 1.5) < 0.01)
  assert.ok(Math.abs(motion.peakYawRateDps - 150) < 0.5)
  for (const h of [motion.dtMs, motion.speedMps, motion.yawRateDps, motion.unexplainedM, motion.unexplainedYawDeg]) {
    assert.equal(h.counts.length, h.edges.length + 1, 'one bin for each gap between edges, and one past the last')
  }
  const total = (h: { counts: number[] }): number => h.counts.reduce((a, b) => a + b, 0)
  assert.equal(total(motion.dtMs), motion.steps)
  assert.equal(total(motion.speedMps), motion.steps)
  assert.equal(total(motion.yawRateDps), motion.steps)
  // The first step has nothing before it to be compared with: one fewer.
  assert.equal(total(motion.unexplainedM), motion.steps - 1)
  // 33 ms is in the bin [25, 34); the walk is in [1, 1.5) or [1.5, 2) m/s; the turn in [120, 180) or [180, 240) deg/s.
  const dtBin = motion.dtMs.edges.findIndex((e) => e > 1000 / fps)
  assert.equal(motion.dtMs.counts[dtBin], motion.steps)
  // A steady walk and turn leave next to nothing unexplained: everything is in the lowest bins.
  assert.equal(motion.unexplainedM.counts[motion.unexplainedM.counts.length - 1], 0)
  assert.ok(motion.unexplainedYawDeg.counts.slice(5).every((n) => n === 0), 'no step was off its prediction by 4 degrees or more')
  // It is what goes into a sidecar.
  assert.deepEqual(JSON.parse(JSON.stringify(motion)), motion)
})

test('a jump lands in the top bins of the unexplained counts, and a runtime with no pose adds none', () => {
  const tracker = established()
  tracker.observe({ tMs: FRAME_MS, pose: pose(0.9, 1.5, 0, aboutY(30)), status: 'NORMAL' })
  const m = tracker.diagnostics().motion
  assert.ok(m)
  assert.equal(m.unexplainedM.counts[m.unexplainedM.edges.findIndex((e) => e > 0.9)], 1)
  assert.equal(m.unexplainedYawDeg.counts[m.unexplainedYawDeg.edges.findIndex((e) => e > 30)], 1)
  const none = new FrameEpochTracker().diagnostics().motion
  assert.equal(none?.steps, 0)
  assert.equal(none?.peakSpeedMps, 0)
})

// ─── Heading arithmetic, signed ────────────────────────────────────────────

test('yawTwistDeg is the signed turn, and yawDeltaDeg its size', () => {
  assert.ok(Math.abs(yawTwistDeg(IDENTITY, aboutY(10)) - 10) < 1e-9)
  assert.ok(Math.abs(yawTwistDeg(aboutY(10), IDENTITY) + 10) < 1e-9, 'the other way is negative')
  assert.ok(Math.abs(yawTwistDeg(aboutY(170), aboutY(-170)) - 20) < 1e-9, 'across the seam, the short way: positive')
  assert.ok(Math.abs(yawTwistDeg(aboutY(-170), aboutY(170)) + 20) < 1e-9)
  assert.ok(Number.isNaN(yawTwistDeg(IDENTITY, { x: 0, y: 0, z: 0, w: 0 })))
})

// ─── The calibration readout ───────────────────────────────────────────────

test('the readout says how many times the frame was measured or reported to move, how far, and how many more interruptions there were', () => {
  const base: TrackingDiagnostics = { status: 'NORMAL', poseJumps: 0, lastJumpM: 0, lastJumpDeg: 0, epoch: 0 }
  assert.deepEqual(describeTracking(base), { text: 'Tracking NORMAL · no frame shifts', warn: false })
  assert.deepEqual(
    describeTracking({ ...base, poseJumps: 1, epoch: 1, lastJumpM: 0.34, lastJumpDeg: 12 }),
    { text: 'Tracking NORMAL · ⚠ 1 frame shift · last 0.34 m, 12°', warn: true },
  )
  assert.equal(
    describeTracking({ ...base, poseJumps: 2, epoch: 2, lastJumpM: 0, lastJumpDeg: 40 }).text,
    'Tracking NORMAL · ⚠ 2 frame shifts · last 40°',
    'a turn in place has no distance to show',
  )
  assert.equal(
    describeTracking({ ...base, status: 'LIMITED', poseJumps: 1, epoch: 3, lastJumpM: 1.2 }).text,
    'Tracking LIMITED · ⚠ 1 frame shift · last 1.20 m · ⚠ tracking interrupted 2 times',
  )
})

test('a relocalization with the pose unchanged is an interruption, not "no frame shifts"; and a reset with no transform shows no size', () => {
  const tracker = established()
  tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  tracker.observe({ tMs: 200, pose: pose(0), status: 'NORMAL' })
  assert.deepEqual(describeTracking(tracker.diagnostics()), { text: 'Tracking NORMAL · ⚠ tracking interrupted 1 time', warn: true })

  const reset = established()
  reset.noteReset(500, null)
  // Before this the readout printed "last 0.00 m", a measurement the runtime did not give.
  assert.equal(describeTracking(reset.diagnostics()).text, 'Tracking NORMAL · ⚠ 1 frame shift')
})

test('a provider with no epoch is read by its jumps alone, as before', () => {
  assert.deepEqual(
    describeTracking({ status: 'NORMAL', poseJumps: 1, lastJumpM: 0.5 }),
    { text: 'Tracking NORMAL · ⚠ 1 frame shift · last 0.50 m', warn: true },
  )
  assert.equal(describeTracking({ status: 'NORMAL', poseJumps: 0, lastJumpM: 0 }).warn, false)
})

// ─── A scan keeps the calibration's frame across a Clear ───────────────────

test('a Clear does not move the frame the calibration was made in: shifts are counted from the calibration, not from the Clear', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  // The Place is calibrated at epoch 0, then tracking is lost and regained (epoch 1), then the scan is cleared.
  log.noteCalibrated(0)
  source.fire({ cause: 'recovered', atMs: 1_000, reason: 'RELOCALIZING' })
  assert.equal(log.frameShifts, 1)
  log.reset()
  // The next scan begins in epoch 1, but it is placed by a calibration made in epoch 0. Before this,
  // a Clear forgot the shift and the new scan read 'ready' in a frame the calibration was not made in.
  assert.equal(log.baseEpoch, 1)
  assert.equal(log.anchorEpoch, 0)
  assert.equal(log.frameShifts, 1)
  const record = log.snapshot(fakeCloud([[1, 900]], { 1: 0.02 }))
  assert.equal(record.calibrationEpoch, 0)
  assert.equal(record.baseEpoch, 1)
  assert.equal(record.mixedEpochs, false)
  assert.deepEqual(record.epochs.map((e) => e.epoch), [0, 1], 'the calibration\'s epoch is listed although it holds no points')
  // A new calibration, in the new frame, is what makes the scan whole again.
  log.noteCalibrated()
  assert.equal(log.frameShifts, 0)
  assert.equal(log.snapshot().calibrationEpoch, 1)
})

test('a shift before the calibration, in the same scan, still counts: the scan holds points from the frame before it', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'recovered', atMs: 1_000 })
  // The Place is calibrated in the frame the engine is in now. The cloud already holds points from the one before.
  log.noteCalibrated()
  assert.equal(log.calibrationEpoch, 1)
  assert.equal(log.baseEpoch, 0)
  assert.equal(log.frameShifts, 1)
  const record = log.snapshot(fakeCloud([[0, 300], [1, 100]], { 0: 0, 1: 0 }))
  assert.equal(record.mixedEpochs, true)
  assert.equal(record.jumpCount, 1)
})

test('a scan that was not calibrated is counted from its own start, and says so', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'jump', atMs: 1 })
  log.reset()
  assert.equal(log.anchorEpoch, 1)
  assert.equal(log.frameShifts, 0)
  assert.equal(log.snapshot().calibrationEpoch, null)
})

test('attaching to a provider forgets a calibration made against the one before', () => {
  const a = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(a)
  a.fire({ cause: 'jump', atMs: 1 })
  log.noteCalibrated(1)
  log.attach(fakeSource())
  assert.equal(log.snapshot().calibrationEpoch, null)
})

test('the epoch a calibration is made in cannot be one the provider has not reached, or a negative or fractional one', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'jump', atMs: 1 })
  log.noteCalibrated(9)
  assert.equal(log.anchorEpoch, 1)
  log.noteCalibrated(-3)
  assert.equal(log.anchorEpoch, 0)
  log.noteCalibrated(Number.NaN)
  assert.equal(log.anchorEpoch, 0)
  log.noteCalibrated(0.9)
  assert.equal(log.anchorEpoch, 0)
})

test('a provider that has an epoch and no event to listen to is still counted: the epoch is what moved', () => {
  let epoch = 3
  const log = new ScanFrameEpochLog()
  log.attach({ getFrameEpoch: () => epoch })
  epoch = 7
  assert.equal(log.currentEpoch, 7)
  assert.equal(log.frameShifts, 4)
  const record = log.snapshot()
  assert.equal(record.jumpCount, 4)
  assert.equal(record.jumps.length, 0, 'there were no events to record')
  assert.equal(record.epochCount, 5)
})

test('a provider that fires events and has no epoch is counted by its events', () => {
  const listeners = new Set<(e: FrameDiscontinuity) => void>()
  const log = new ScanFrameEpochLog()
  log.attach({
    onFrameDiscontinuity(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  })
  for (const l of listeners) l({ epoch: 1, cause: 'jump', atMs: 1 })
  for (const l of listeners) l({ epoch: 2, cause: 'resumed', atMs: 2 })
  assert.equal(log.frameShifts, 2)
})

test('an event for the epoch the log already holds, with more in it, replaces its record and is not counted twice', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'resumed', atMs: 10, hiddenMs: 4_000 })
  const first = log.snapshot().jumps[0]
  // The tracker amends the epoch: the same epoch number, now a reset with the runtime's transform.
  const transform = { position: { x: 0.2, y: 0, z: 0 }, orientation: IDENTITY }
  source.refire({ epoch: 1, cause: 'reset', atMs: 10, hiddenMs: 4_000, transform })
  const record = log.snapshot()
  assert.equal(record.jumps.length, 1)
  assert.equal(record.jumpCount, 1)
  assert.equal(record.jumps[0].cause, 'reset')
  assert.deepEqual(record.jumps[0].transform, transform)
  assert.equal(record.jumps[0].at, first.at, 'it is the same moment')
  assert.equal(log.frameShifts, 1)
})

test('the record holds its own copy of a transform: neither the event\'s object nor the record\'s can change the other', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  const transform = { position: { x: 0.2, y: 0, z: 0 }, orientation: IDENTITY }
  source.fire({ cause: 'reset', atMs: 1, transform })
  transform.position.x = 99
  const record = log.snapshot()
  assert.equal(record.jumps[0].transform?.position.x, 0.2)
  record.jumps[0].transform!.position.x = -1
  assert.equal(log.snapshot().jumps[0].transform?.position.x, 0.2)
})

// ─── Which epoch's floor a scan draws ──────────────────────────────────────

const ground = (epoch: number, y: number, over: { locked?: boolean; fallback?: boolean } = {}) => ({
  y,
  epoch,
  normal: { x: 0 as const, y: 1 as const, z: 0 as const },
  locked: over.locked ?? true,
  sampleCount: 300,
  fallback: over.fallback ?? false,
})

test('the floor drawn is the anchor epoch\'s when its floor was settled, and the epoch with the most points when it was not', () => {
  // The anchor epoch (the calibration's, else the scan's first) holds the Place's frame.
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 400 }, { epoch: 1, count: 5_000 }], [ground(0, 0), ground(1, 0.3)], 0), { epoch: 0, basis: 'locked' })
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 400 }, { epoch: 1, count: 5_000 }], [ground(0, 0), ground(1, 0.3)], 1), { epoch: 1, basis: 'locked' })
  // An epoch of a handful of wall points that happened to come first has no settled floor: the one that has does.
  assert.deepEqual(
    chooseFloorEpoch([{ epoch: 0, count: 120 }, { epoch: 1, count: 5_700 }], [ground(0, 0.47, { locked: false }), ground(1, 0.002)], 0),
    { epoch: 1, basis: 'locked' },
  )
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 14 }, { epoch: 1, count: 5_115 }], [ground(1, 0.002)], 0), { epoch: 1, basis: 'locked' }, 'too few points to have a floor at all')
  // A floor that was fitted but never settled, or settled on nothing (the percentile fallback), is not a settled one.
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 90 }, { epoch: 1, count: 80 }], [ground(0, 0.1, { locked: false }), ground(1, 0.2, { locked: false })], 1), { epoch: 1, basis: 'fitted' })
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 90 }, { epoch: 1, count: 80 }], [ground(0, 0.1, { fallback: true }), ground(1, 0.2, { locked: false })], 0), { epoch: 1, basis: 'fitted' })
  // Of equally supported epochs that are not the anchor, the one with more points; with equal points, the earlier.
  assert.deepEqual(chooseFloorEpoch([{ epoch: 2, count: 100 }, { epoch: 3, count: 300 }], [ground(2, 0), ground(3, 0)], 0), { epoch: 3, basis: 'locked' })
  assert.deepEqual(chooseFloorEpoch([{ epoch: 2, count: 100 }, { epoch: 3, count: 100 }], [ground(2, 0), ground(3, 0)], 0), { epoch: 2, basis: 'locked' })
})

test('with no kept floor for any epoch the largest is fitted afresh, and an empty cloud has no floor epoch', () => {
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 30 }, { epoch: 1, count: 40 }], [], 0), { epoch: 1, basis: 'refit' })
  assert.deepEqual(chooseFloorEpoch([{ epoch: 0, count: 30 }], [], 0), { epoch: 0, basis: 'refit' })
  assert.deepEqual(chooseFloorEpoch([], [ground(0, 0)], 0), { epoch: null, basis: null })
})

test('a scan whose first epoch is a few points of wall draws the floor of the epoch that holds the room', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'recovered', atMs: 2_000 })
  const record = log.snapshot(fakeCloud([[0, 14], [1, 5_115]], { 1: 0.002 }))
  assert.equal(record.floorEpoch, 1)
  assert.equal(record.floorBasis, 'locked')
  assert.equal(record.baseEpoch, 0)
})

// ─── A record that is too long keeps what it cannot be read without ────────

test('past the entry limit the record keeps the first, the calibration\'s, the floor\'s and the current epoch, and the newest of the rest', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  log.noteCalibrated(0)
  for (let i = 0; i < 199; i++) source.fire({ cause: 'resumed', atMs: i })
  // The points are in the first epoch and the last, and the floor was fitted in the first.
  const record = log.snapshot(fakeCloud([[0, 4_000], [199, 300]], { 0: 0.01, 199: 0.4 }))
  assert.equal(record.epochCount, 200)
  assert.equal(record.epochs.length, FRAME_LOG_MAX)
  assert.equal(record.epochsOmitted, 200 - FRAME_LOG_MAX)
  const kept = record.epochs.map((e) => e.epoch)
  assert.equal(kept[0], 0, 'the epoch the scan began and was calibrated in is not the one dropped')
  assert.equal(record.floorEpoch, 0)
  assert.ok(kept.includes(record.floorEpoch!), 'the entry the floor is read from is there')
  assert.equal(kept[kept.length - 1], 199, 'and the current one')
  assert.deepEqual(kept.slice(1), Array.from({ length: FRAME_LOG_MAX - 1 }, (_, i) => 199 - (FRAME_LOG_MAX - 2) + i), 'then the newest, in order')
  assert.equal(record.epochs[0].ground?.y, 0.01)
  assert.equal(record.jumpCount, 199)
  assert.equal(record.jumps.length, FRAME_LOG_MAX)
})

// ─── The adopted numbers, pinned where they are read ───────────────────────

test('a second jump 499 ms behind the first is folded in, and one 501 ms behind it is a new epoch', () => {
  for (const [gapMs, epochs, folded] of [[499, 1, 1], [501, 2, 0]] as const) {
    const tracker = established()
    tracker.observe({ tMs: FRAME_MS, pose: pose(0.4), status: 'NORMAL' })
    const second = FRAME_MS + gapMs
    steadyUntil(tracker, second - FRAME_MS, 0.4)
    tracker.observe({ tMs: second, pose: pose(1.0), status: 'NORMAL' })
    assert.equal(tracker.epoch, epochs, `${gapMs} ms behind`)
    assert.equal(tracker.diagnostics().suppressedJumps, folded, `${gapMs} ms behind`)
  }
})

test('tracking missing for 990 ms is not an epoch when it returns, and for 1010 ms is', () => {
  for (const [missingMs, epochs] of [[990, 0], [1_010, 1]] as const) {
    const tracker = established()
    tracker.observe({ tMs: 100, pose: pose(0), status: 'LIMITED', reason: 'TOO_MUCH_MOTION' })
    tracker.observe({ tMs: 100 + missingMs, pose: pose(0.05), status: 'NORMAL' })
    assert.equal(tracker.epoch, epochs, `${missingMs} ms`)
  }
})

test('the entry limit of a log and a record is 64', () => {
  assert.equal(FRAME_LOG_MAX, 64)
  const tracker = established()
  for (let i = 1; i <= 80; i++) {
    tracker.noteResume(i * 1_000)
    tracker.observe({ tMs: i * 1_000 + 1, pose: pose(0), status: 'NORMAL' })
  }
  assert.equal(tracker.log.length, 64)
})

test('a reading of 1.5 s of degraded time stops at a second per gap: a pause is not tracking time', () => {
  const tracker = established()
  tracker.observe({ tMs: 1_000, pose: pose(0), status: 'LIMITED' })
  tracker.observe({ tMs: 1_999, pose: pose(0), status: 'LIMITED' })
  assert.equal(tracker.diagnostics().limitedMs, 999)
  tracker.observe({ tMs: 4_000, pose: pose(0), status: 'LIMITED' })
  assert.equal(tracker.diagnostics().limitedMs, 999 + 1_000, 'a gap of 2 s counts as 1 s')
})

test('a shift the other way is seen as readily as one in the direction of the sweep: the sign does not matter', () => {
  assert.equal(seen('yaw', -7.9, 1000 / 30), false)
  assert.equal(seen('yaw', -8.1, 1000 / 30), true)
  assert.equal(seen('translation', -0.29, 1000 / 30), false)
  assert.equal(seen('translation', -0.31, 1000 / 30), true)
  // And against a sweep that is going the same way as the shift, or the other: the shift is what the sweep did not predict.
  for (const direction of [1, -1]) {
    const tracker = new FrameEpochTracker()
    let heading = 0
    for (let i = 0; i < 12; i++, heading += direction * 3) tracker.observe({ tMs: i * FRAME_MS, pose: pose(0, 1.5, 0, aboutY(heading)), status: 'NORMAL' })
    const event = tracker.observe({ tMs: 12 * FRAME_MS, pose: pose(0, 1.5, 0, aboutY(heading + 12 * direction)), status: 'NORMAL' })
    assert.equal(event?.cause, 'jump', `a 12 degree shift in the direction ${direction} of a 3 degree-per-frame sweep`)
    assert.ok(Math.abs((event?.unexplainedYawDeg ?? 0) - 12) < 1e-6)
  }
})

test('a step lands in the histogram bin whose lower edge it is on: 25 ms in [25, 34)', () => {
  const tracker = new FrameEpochTracker()
  tracker.observe({ tMs: 0, pose: pose(0), status: 'NORMAL' })
  tracker.observe({ tMs: 25, pose: pose(0), status: 'NORMAL' })
  const motion = tracker.diagnostics().motion
  assert.ok(motion)
  const edges = motion.dtMs.edges
  const bin = edges.indexOf(25) + 1
  assert.equal(motion.dtMs.counts[bin], 1, `bin ${bin}, [${edges[bin - 1]}, ${edges[bin]})`)
  assert.equal(motion.dtMs.counts[bin - 1], 0)
})

// ─── Gaps the mutation run found ───────────────────────────────────────────

test('frame times only as exact as the page\'s animation frame do not turn a fast steady move into a shift', () => {
  // A hand swinging, or a vehicle: 7.5 m/s, steady, a 30 fps camera on a 60 or 120 Hz page. The
  // same rate applied to the next interval is wrong by up to three times; the same step is not.
  for (const hz of [60, 120]) {
    const tracker = new FrameEpochTracker()
    for (const { at, clock } of delivered(frameTimes(3, 30, 7, 0.1), hz)) {
      tracker.observe({ tMs: clock, pose: pose((7.5 * at) / 1000), status: 'NORMAL' })
    }
    assert.equal(tracker.epoch, 0, `a ${hz} Hz page`)
  }
})

test('a step of exactly the floor is a shift: the floors are "at least"', () => {
  assert.equal(established().observe({ tMs: FRAME_MS, pose: pose(0.3), status: 'NORMAL' })?.cause, 'jump')
  const ten = yawDeltaDeg(IDENTITY, aboutY(10))
  const tracker = new FrameEpochTracker({ jumpYawDeg: ten })
  for (const tMs of [-2 * FRAME_MS, -FRAME_MS, 0]) tracker.observe({ tMs, pose: pose(0), status: 'NORMAL' })
  assert.equal(tracker.observe({ tMs: FRAME_MS, pose: pose(0, 1.5, 0, aboutY(10)), status: 'NORMAL' })?.cause, 'jump')
})

test('two frames stamped alike are a millisecond apart, so a step between them is a step and not a division by zero', () => {
  const tracker = established()
  const event = tracker.observe({ tMs: 0, pose: pose(2), status: 'NORMAL' })
  assert.equal(event?.cause, 'jump')
  assert.equal(event?.dtMs, 1)
  assert.ok(Number.isFinite(event?.speedMps), 'the speed that implies is finite')
})

test('a step between frames the engine is unsure of, in the stretch after a resume, is part of the trip and not a second shift', () => {
  const tracker = established()
  tracker.noteResume(10_000)
  // The engine takes its time to start over (past the refractory window, so a step judged here would be
  // an epoch of its own): poses arrive LIMITED, steady, and then one steps 3 m.
  for (const [tMs, x] of [[10_600, 3], [10_633, 3], [10_667, 3], [10_700, 3], [10_733, 6]] as const) {
    tracker.observe({ tMs, pose: pose(x), status: 'LIMITED', reason: 'INITIALIZING' })
  }
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.diagnostics().suppressedJumps, 0, 'not judged at all, rather than judged and folded in')
})

test('the first good pose of a trip is not judged against the degraded poses before it', () => {
  const tracker = established()
  tracker.noteResume(10_000)
  for (const tMs of [10_600, 10_633, 10_667, 10_700]) tracker.observe({ tMs, pose: pose(3), status: 'LIMITED', reason: 'INITIALIZING' })
  assert.equal(tracker.observe({ tMs: 10_733, pose: pose(6), status: 'NORMAL' }), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.diagnostics().suppressedJumps, 0)
})

test('the peak speed and the peak turn rate are the largest seen, not the last', () => {
  const tracker = established()
  const heading = [1, 6, 0.5]
  const dx = [1 / 30, 3 / 30, 0.5 / 30]
  let x = 0
  let h = 0
  heading.forEach((deg, i) => {
    x += dx[i]
    h += deg
    tracker.observe({ tMs: (i + 1) * FRAME_MS, pose: pose(x, 1.5, 0, aboutY(h)), status: 'NORMAL' })
  })
  const motion = tracker.diagnostics().motion
  assert.ok(motion)
  assert.ok(Math.abs(motion.peakSpeedMps - 3) < 1e-6, `peak speed ${motion.peakSpeedMps}`)
  assert.ok(Math.abs(motion.peakYawRateDps - 180) < 1e-6, `peak turn rate ${motion.peakYawRateDps}`)
})

test('an amended record keeps the time its epoch began', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00.000Z') })
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  source.fire({ cause: 'resumed', atMs: 10 })
  const began = log.snapshot().jumps[0].at
  t.mock.timers.tick(5_000)
  source.refire({ epoch: 1, cause: 'reset', atMs: 10, transform: { position: { x: 0.2, y: 0, z: 0 }, orientation: IDENTITY } })
  assert.equal(log.snapshot().jumps[0].cause, 'reset')
  assert.equal(log.snapshot().jumps[0].at, began, 'the amendment came five seconds later; the epoch began when it did')
})

test('a record past the entry limit keeps the first epoch, the calibration\'s, the floor\'s and the current one, when they are four different ones', () => {
  const source = fakeSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  for (let i = 0; i < 30; i++) source.fire({ cause: 'resumed', atMs: i })
  log.noteCalibrated(10)
  for (let i = 0; i < 20; i++) source.fire({ cause: 'resumed', atMs: 100 + i })
  log.reset()
  assert.equal(log.baseEpoch, 50)
  for (let i = 0; i < 149; i++) source.fire({ cause: 'resumed', atMs: 200 + i })
  // The floor was fitted in epoch 30 (locked), and the cloud holds points there and now.
  const record = log.snapshot(fakeCloud([[30, 500], [199, 100]], { 30: 0.02 }))
  const kept = record.epochs.map((e) => e.epoch)
  assert.equal(record.calibrationEpoch, 10)
  assert.equal(record.floorEpoch, 30)
  assert.equal(record.baseEpoch, 50)
  assert.equal(record.currentEpoch, 199)
  for (const epoch of [10, 30, 50, 199]) assert.ok(kept.includes(epoch), `epoch ${epoch} was dropped`)
  assert.equal(record.epochs.length, FRAME_LOG_MAX)
  assert.equal(record.epochs.find((e) => e.epoch === 30)?.pointCount, 500)
})

test('the record carries the provider\'s suppressed-jump count and a copy of its motion statistics', () => {
  const motion = {
    steps: 3,
    peakSpeedMps: 1.5,
    peakYawRateDps: 90,
    dtMs: { edges: [10], counts: [0, 3] },
    speedMps: { edges: [1], counts: [1, 2] },
    yawRateDps: { edges: [60], counts: [1, 2] },
    unexplainedM: { edges: [0.1], counts: [3, 0] },
    unexplainedYawDeg: { edges: [1], counts: [3, 0] },
  }
  const source = {
    ...fakeSource(),
    getTrackingDiagnostics: (): TrackingDiagnostics => ({ status: 'NORMAL', poseJumps: 0, lastJumpM: 0, limitedMs: 0, suppressedJumps: 3, motion }),
  }
  const log = new ScanFrameEpochLog()
  log.attach(source)
  const record = log.snapshot()
  assert.equal(record.suppressedJumps, 3)
  assert.deepEqual(record.motion, motion)
  motion.steps = 99
  motion.dtMs.counts[1] = 99
  assert.equal(record.motion?.steps, 3, 'the record shares nothing with the live counters')
  assert.equal(record.motion?.dtMs.counts[1], 3)
})

test('what a step has to be when the frames are steady at a low rate: a turn of 12.5 degrees at 20 fps and 22 at 15, 0.30 m at both', () => {
  const steadySeen = (kind: 'translation' | 'yaw', size: number, fps: number): boolean => {
    const tracker = new FrameEpochTracker()
    const dt = 1000 / fps
    for (let i = 0; i < 10; i++) tracker.observe({ tMs: i * dt, pose: pose(0), status: 'NORMAL' })
    const shifted = kind === 'translation' ? pose(size) : pose(0, 1.5, 0, aboutY(size))
    return tracker.observe({ tMs: 10 * dt, pose: shifted, status: 'NORMAL' }) !== null
  }
  assert.equal(steadySeen('yaw', 12, 20), false)
  assert.equal(steadySeen('yaw', 13, 20), true)
  assert.equal(steadySeen('yaw', 21, 15), false)
  assert.equal(steadySeen('yaw', 23, 15), true)
  assert.equal(steadySeen('translation', 0.29, 15), false)
  assert.equal(steadySeen('translation', 0.31, 15), true)
  assert.equal(steadySeen('yaw', 8.1, 60), true, 'and a faster camera is no less sensitive than 30 fps')
  assert.equal(steadySeen('yaw', 7.9, 60), false)
})

test('a provider with an epoch and no events, calibrated after a shift in the same scan, still counts that shift', () => {
  let epoch = 0
  const log = new ScanFrameEpochLog()
  log.attach({ getFrameEpoch: () => epoch })
  epoch = 1
  log.noteCalibrated()
  assert.equal(log.calibrationEpoch, 1)
  assert.equal(log.baseEpoch, 0)
  assert.equal(log.frameShifts, 1, 'the cloud holds points from the frame before the calibration')
})
