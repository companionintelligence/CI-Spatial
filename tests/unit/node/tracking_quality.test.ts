/**
 * Live tracking-quality gate.
 *
 * The status strings below follow the runtimes' own. 8th Wall documents a `trackingStatus` of
 * LIMITED / NORMAL and a separate `trackingReason` of INITIALIZING / UNSPECIFIED
 * (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule). The other names used here
 * (a status of UNSPECIFIED or NOT_AVAILABLE, a reason of RELOCALIZING / TOO_MUCH_MOTION /
 * NOT_ENOUGH_TEXTURE) are not in that documentation: they are inputs standing for what the engine
 * might report, handled defensively, and DX4 logs which ones a phone does. The native shell
 * reports INITIALIZING as a status (src/ar/native-provider.ts); WebXR reports nothing before its
 * first frame, which the provider calls UNKNOWN.
 *
 * Two gates are tested here. `trackingIsUsable()` decides whether geometry may be
 * recorded and fails open. `trackingIsStableForPlacement()` decides whether a
 * calibration tap may be taken and fails closed, with the one open case a runtime
 * that publishes no status.
 *
 * Run: npm run test:tracking:quality
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BURST_POSE_JUMP_M,
  LANDMARK_TO_COMMIT_BUDGET_MS,
  TRACKING_RECOVERING_TEXT,
  cameraJumped,
  placementDisturbed,
  placementDisturbedText,
  trackingIsStableForPlacement,
  trackingIsUsable,
  watchLandmark,
  type ShiftCounters,
} from '../../../src/ar/tracking-quality.ts'

test('NORMAL records geometry', () => {
  assert.equal(trackingIsUsable('NORMAL'), true)
})

test('degraded states do not record geometry', () => {
  // These are the states that produced the 60m debris cloud: the runtime is
  // still emitting points, but against a frame it no longer trusts itself.
  assert.equal(trackingIsUsable('LIMITED'), false)
  assert.equal(trackingIsUsable('NOT_AVAILABLE'), false)
})

test('INITIALIZING does not record — the pose is still a guess', () => {
  // Before SLAM converges the frame is about to move underneath any point
  // placed against it, so those points are wrong even though nothing errored.
  assert.equal(trackingIsUsable('INITIALIZING'), false)
})

test('fails open on UNKNOWN so WebXR is not silently disabled', () => {
  // WebXRProvider has no equivalent signal and always reports UNKNOWN. A closed
  // rule would stop it accumulating ANY points — a total capture regression
  // dressed up as a data-quality fix.
  assert.equal(trackingIsUsable('UNKNOWN'), true)
})

test('fails open on absent/empty status', () => {
  assert.equal(trackingIsUsable(null), true)
  assert.equal(trackingIsUsable(undefined), true)
  assert.equal(trackingIsUsable(''), true)
})

test('fails open on an unrecognised status from a future runtime version', () => {
  // A new 8th Wall build inventing a status must not silently stop capture.
  assert.equal(trackingIsUsable('SOME_NEW_STATE'), true)
})

test('matching is exact — no case folding or trimming', () => {
  // The provider returns the runtime's string verbatim; if a runtime ever
  // changes case this must fail open rather than quietly half-work.
  assert.equal(trackingIsUsable('limited'), true)
  assert.equal(trackingIsUsable(' LIMITED'), true)
})

// ── Placing a calibration marker ───────────────────────────────────────────

/** [status, reason, stable, why] — the whole truth table in one place. */
const PLACEMENT_TABLE: Array<[string | null | undefined, string | null | undefined, boolean, string]> = [
  ['NORMAL', undefined, true, 'NORMAL with no reason is the one healthy state'],
  ['NORMAL', null, true, 'a null reason is no reason'],
  ['NORMAL', '', true, 'an empty reason is no reason'],
  ['NORMAL', 'UNSPECIFIED', true, 'UNSPECIFIED, a documented reason that says nothing, beside a healthy status'],
  ['NORMAL', 'SOMETHING_NEW', true, 'a reason this build does not know explains nothing, so it cannot condemn'],
  ['NORMAL', 'INITIALIZING', false, 'still initialising'],
  ['NORMAL', 'RELOCALIZING', false, 'relocalizing: the map may be about to move'],
  ['NORMAL', 'TOO_MUCH_MOTION', false, 'the phone is moving too fast'],
  ['NORMAL', 'NOT_ENOUGH_TEXTURE', false, 'nothing to track'],
  ['LIMITED', undefined, false, 'LIMITED'],
  ['LIMITED', 'RELOCALIZING', false, 'LIMITED and relocalizing'],
  ['NOT_AVAILABLE', undefined, false, 'NOT_AVAILABLE'],
  ['INITIALIZING', undefined, false, 'INITIALIZING as a status (the native shell)'],
  ['UNSPECIFIED', undefined, false, 'no status that says it is tracking'],
  ['UNSPECIFIED', 'UNSPECIFIED', false, 'UNSPECIFIED on both counts'],
  ['SOME_NEW_STATE', undefined, false, 'a status this build does not know is not evidence of tracking'],
  ['normal', undefined, false, 'matching is exact, so a different case is not NORMAL'],
  [' NORMAL', undefined, false, 'matching is exact, so a padded NORMAL is not NORMAL'],
  ['UNKNOWN', undefined, true, 'WebXR publishes no status: nothing to refuse on'],
  ['UNKNOWN', 'UNSPECIFIED', true, 'no status and no reason'],
  ['UNKNOWN', 'RELOCALIZING', false, 'no status, but a reason that says relocalizing'],
  [undefined, undefined, true, 'a frame with no status at all'],
  [null, undefined, true, 'a null status'],
  ['', undefined, true, 'an empty status'],
  [undefined, 'TOO_MUCH_MOTION', false, 'no status, but a reason that says too much motion'],
]

for (const [status, reason, stable, why] of PLACEMENT_TABLE) {
  test(`placement: ${JSON.stringify(status)} / ${JSON.stringify(reason)} is ${stable ? 'stable' : 'not stable'} (${why})`, () => {
    assert.equal(trackingIsStableForPlacement(status, reason), stable)
  })
}

test('placement: UNSPECIFIED is explicitly not stable, although trackingIsUsable lets it through', () => {
  // The two gates differ on purpose. Recording a stray point from a frame the runtime has not
  // classified costs little; placing the Place's reference frame in one costs a wrong frame.
  assert.equal(trackingIsStableForPlacement('UNSPECIFIED'), false)
  assert.equal(trackingIsUsable('UNSPECIFIED'), true)
})

test('placement: the reason argument is optional', () => {
  assert.equal(trackingIsStableForPlacement('NORMAL'), true)
  assert.equal(trackingIsStableForPlacement('LIMITED'), false)
})

test('placement: nothing the recording gate refuses is stable for placement', () => {
  for (const status of ['INITIALIZING', 'LIMITED', 'NOT_AVAILABLE']) {
    assert.equal(trackingIsUsable(status), false)
    assert.equal(trackingIsStableForPlacement(status), false, status)
  }
})

test('placement: the text a refused tap shows is the one the brief names', () => {
  assert.equal(TRACKING_RECOVERING_TEXT, 'Hold still, tracking is recovering')
})

// ── Whether the frame survived the walk from landmark to commit ────────────

const CALM = { poseJumpsAtConfirm: 0, poseJumpsNow: 0, epochAtConfirm: 3, epochNow: 3, elapsedMs: 20_000 }

test('placementDisturbed: the budget is 90 seconds', () => {
  assert.equal(LANDMARK_TO_COMMIT_BUDGET_MS, 90_000)
})

test('placementDisturbed: a calm walk within the budget is not disturbed', () => {
  assert.deepEqual(placementDisturbed(CALM), { disturbed: false })
})

test('placementDisturbed: a frame shift between confirm and commit disturbs it', () => {
  assert.deepEqual(placementDisturbed({ ...CALM, poseJumpsNow: 1 }), { disturbed: true, reason: 'pose-jump' })
})

test('placementDisturbed: a shift that happened before the landmark was confirmed does not', () => {
  assert.deepEqual(placementDisturbed({ ...CALM, poseJumpsAtConfirm: 2, poseJumpsNow: 2 }), { disturbed: false })
})

test('placementDisturbed: a new frame epoch disturbs it', () => {
  assert.deepEqual(placementDisturbed({ ...CALM, epochNow: 4 }), { disturbed: true, reason: 'epoch-changed' })
})

test('placementDisturbed: a counter that went down is a change too (the provider restarted)', () => {
  assert.deepEqual(placementDisturbed({ ...CALM, poseJumpsAtConfirm: 5, poseJumpsNow: 0 }), { disturbed: true, reason: 'pose-jump' })
  assert.deepEqual(placementDisturbed({ ...CALM, epochAtConfirm: 5, epochNow: 0 }), { disturbed: true, reason: 'epoch-changed' })
})

test('placementDisturbed: exactly the budget is inside it, one millisecond more is not', () => {
  assert.deepEqual(placementDisturbed({ ...CALM, elapsedMs: LANDMARK_TO_COMMIT_BUDGET_MS }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ ...CALM, elapsedMs: LANDMARK_TO_COMMIT_BUDGET_MS + 1 }), { disturbed: true, reason: 'too-long' })
})

test('placementDisturbed: a provider that keeps no counters cannot disturb on them', () => {
  // WebXR has neither a pose-jump count nor an epoch. Only the clock can speak for it.
  assert.deepEqual(placementDisturbed({ elapsedMs: 5_000 }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ elapsedMs: 5_000, poseJumpsNow: 3 }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ elapsedMs: 5_000, epochAtConfirm: 1 }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ elapsedMs: LANDMARK_TO_COMMIT_BUDGET_MS + 1 }), { disturbed: true, reason: 'too-long' })
})

test('placementDisturbed: a counter or a clock that is not a finite number is no evidence', () => {
  assert.deepEqual(placementDisturbed({ ...CALM, poseJumpsNow: Number.NaN }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ ...CALM, poseJumpsAtConfirm: Number.POSITIVE_INFINITY, poseJumpsNow: 0 }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ ...CALM, epochNow: Number.NaN }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ ...CALM, elapsedMs: Number.NaN }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ ...CALM, elapsedMs: Number.POSITIVE_INFINITY }), { disturbed: false })
  assert.deepEqual(placementDisturbed({ ...CALM, elapsedMs: -5 }), { disturbed: false })
})

test('placementDisturbed: when several things are wrong the epoch is named first, then the jump, then the time', () => {
  const everything = { poseJumpsAtConfirm: 0, poseJumpsNow: 2, epochAtConfirm: 1, epochNow: 2, elapsedMs: 200_000 }
  assert.deepEqual(placementDisturbed(everything), { disturbed: true, reason: 'epoch-changed' })
  assert.deepEqual(placementDisturbed({ ...everything, epochNow: 1 }), { disturbed: true, reason: 'pose-jump' })
  assert.deepEqual(placementDisturbed({ ...everything, epochNow: 1, poseJumpsNow: 0 }), { disturbed: true, reason: 'too-long' })
})

test('placementDisturbedText: says what the flow is about to do, in the budget the code uses', () => {
  assert.equal(placementDisturbedText('pose-jump'), 'Tracking was disturbed, tap the landmark again')
  assert.equal(placementDisturbedText('epoch-changed'), 'Tracking was disturbed, tap the landmark again')
  assert.equal(placementDisturbedText('too-long'), 'That took over 90 seconds, tap the landmark again')
})

// ─── The camera stepping between two frames of one burst ────────────────────

test('cameraJumped: the step is the one 8th Wall counts as a pose jump, and exactly that far is not past it', () => {
  assert.equal(BURST_POSE_JUMP_M, 0.3)
  const origin = { x: 0, y: 0, z: 0 }
  assert.equal(cameraJumped(origin, { x: BURST_POSE_JUMP_M, y: 0, z: 0 }), false, 'exactly the limit is not past it')
  assert.equal(cameraJumped(origin, { x: 0.3001, y: 0, z: 0 }), true)
  assert.equal(cameraJumped(origin, { x: 0, y: -0.3001, z: 0 }), true, 'a step in height counts')
  assert.equal(cameraJumped(origin, { x: 0, y: 0, z: 0.3001 }), true, 'so does one in depth')
  assert.equal(cameraJumped({ x: 1, y: 1.5, z: -2 }, { x: 1, y: 1.5, z: -2 }), false)
  // 0.2 m on two axes is 0.283 m, inside the limit; 0.22 m on two is 0.311 m, past it.
  assert.equal(cameraJumped(origin, { x: 0.2, y: 0.2, z: 0 }), false)
  assert.equal(cameraJumped(origin, { x: 0.22, y: 0.22, z: 0 }), true)
})

test('cameraJumped: a position that is not a number says nothing, so it is not a jump', () => {
  const here = { x: 0, y: 1.5, z: 0 }
  assert.equal(cameraJumped(here, { x: Number.NaN, y: 1.5, z: 0 }), false)
  assert.equal(cameraJumped(here, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }), false)
  assert.equal(cameraJumped({ x: Number.NaN, y: 0, z: 0 }, here), false)
})

// ─── Watching a landmark from confirm to commit ─────────────────────────────

/** A provider's counters and a clock, both moved by the test. */
function watched(counters: ShiftCounters | null | undefined) {
  const state = { counters, now: 1_000_000, reads: 0 }
  const watch = watchLandmark(() => {
    state.reads++
    return state.counters
  }, () => state.now)
  return { state, watch }
}

test('watchLandmark: nothing happened between confirm and commit', () => {
  const { state, watch } = watched({ poseJumps: 2, epoch: 1 })
  state.now += 20_000
  assert.deepEqual(watch.check(), { disturbed: false })
})

test('watchLandmark: a fake provider whose poseJumps changes between confirm and commit refuses the commit', () => {
  const { state, watch } = watched({ poseJumps: 2 })
  state.counters = { poseJumps: 3 }
  assert.deepEqual(watch.check(), { disturbed: true, reason: 'pose-jump' })
  assert.equal(placementDisturbedText('pose-jump'), 'Tracking was disturbed, tap the landmark again')
})

test('watchLandmark: a frame epoch that changes between confirm and commit refuses it too, and is named first', () => {
  const { state, watch } = watched({ poseJumps: 0, epoch: 4 })
  state.counters = { poseJumps: 1, epoch: 5 }
  assert.deepEqual(watch.check(), { disturbed: true, reason: 'epoch-changed' })
})

test('watchLandmark: the time is counted from the confirm, and the 90 seconds are the most it may take', () => {
  const { state, watch } = watched({ poseJumps: 0 })
  state.now += LANDMARK_TO_COMMIT_BUDGET_MS
  assert.deepEqual(watch.check(), { disturbed: false })
  state.now += 1
  assert.deepEqual(watch.check(), { disturbed: true, reason: 'too-long' })
})

test('watchLandmark: the counters are taken once, at the confirm, and read afresh at every check', () => {
  const { state, watch } = watched({ poseJumps: 7 })
  assert.equal(state.reads, 1, 'one read when the watch starts')
  assert.deepEqual(watch.check(), { disturbed: false })
  assert.deepEqual(watch.check(), { disturbed: false })
  assert.equal(state.reads, 3)
  state.counters = { poseJumps: 8 }
  assert.equal(watch.check().disturbed, true)
  state.counters = { poseJumps: 7 }
  assert.equal(watch.check().disturbed, false, 'it is a comparison with the confirm, not a latch')
})

test('watchLandmark: a provider that keeps no counters is watched by the clock alone', () => {
  for (const counters of [undefined, null, {}]) {
    const { state, watch } = watched(counters)
    state.counters = { poseJumps: 9, epoch: 3 }
    assert.deepEqual(watch.check(), { disturbed: false }, `a provider that had nothing at the confirm: ${JSON.stringify(counters)}`)
  }
})

test('watchLandmark: a provider whose diagnostics throw is no evidence, not a disturbance and not a crash', () => {
  let throwing = false
  let now = 0
  const watch = watchLandmark(() => {
    if (throwing) throw new Error('the engine is gone')
    return { poseJumps: 1 }
  }, () => now)
  throwing = true
  assert.deepEqual(watch.check(), { disturbed: false })
  now += LANDMARK_TO_COMMIT_BUDGET_MS + 1
  assert.deepEqual(watch.check(), { disturbed: true, reason: 'too-long' }, 'the clock still speaks')
  const failedAtConfirm = watchLandmark(() => {
    throw new Error('no diagnostics yet')
  }, () => 0)
  assert.deepEqual(failedAtConfirm.check(), { disturbed: false })
})

test('watchLandmark: the real ARProvider shape (status, poseJumps, lastJumpM) is read for its counter', () => {
  const diagnostics = { status: 'NORMAL', poseJumps: 0, lastJumpM: 0 }
  const watch = watchLandmark(() => diagnostics, () => 0)
  diagnostics.poseJumps = 1
  diagnostics.lastJumpM = 0.42
  assert.deepEqual(watch.check(), { disturbed: true, reason: 'pose-jump' })
})
