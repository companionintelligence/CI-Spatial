/**
 * One scan, one frame (WP-09b, src/ar/reanchor-flow.ts): what the scanner does when the runtime's frame may have moved
 * under a scan that was calibrated against a Place, and the Check drift measurement.
 *
 * The runtime is a fake provider that goes through frame epochs and says so; the epoch log over it is the real one, and
 * so is the flow. What the person sees is a recording view and what the page does is a recording host
 * (./support/reanchor-rig.ts), so each claim here is about the decision, which is the part that can be wrong without a
 * phone. The words are held to what the code knows in wp-09b-copy.test.ts, the screen in wp-09b-banner.test.ts, the
 * sequence against the real store in wp-09b-reanchor-host.test.ts.
 *
 * The rules under test are the work package's, with owner decision D13: a discontinuity after the calibration, with a
 * stored two-point frame, stops recording and offers Re-anchor here and Keep going; Keep going leaves the scan marked for
 * review; with no frame to re-anchor against the person is only told; nothing splits a scan on its own unless the page
 * was opened with ?autosplit=1.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-reanchor-flow.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ScanQualityMonitor } from '../../../src/capture/quality-monitor.ts'
import { CLOSURE_TRANSLATION_LIMIT_M } from '../../../src/ar/closure.ts'
import { autosplitRequested, canReanchor, FINISH_LIMIT_MS, ReanchorFlow, type ReanchorHost } from '../../../src/ar/reanchor-flow.ts'
import { buildOnePointCommit, buildTwoPointCommit, type AcceptedTwoPoint } from '../../../src/ar/calibration-commit.ts'
import * as copy from '../../../src/ar/reanchor-copy.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'
import {
  FakeProvider,
  FakeView,
  onePointCalibration,
  onePointFrame,
  rig,
  settle,
  tapAt,
  twoPointCalibration,
  twoPointFrame,
  type Rig,
} from './support/reanchor-rig.ts'

/** A check whose two taps land where the calibration put the spots, taken through to its result, which is left on screen. */
async function runCleanCheck(r: Rig): Promise<void> {
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0, y: 0, z: 0 }), tapAt({ x: 0, y: 0, z: 3 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
}

// ── The choice ──────────────────────────────────────────────────────────────────────────────────────

test('a discontinuity after the calibration opens the choice, with Re-anchor here the default and Keep going beside it', () => {
  const r = rig()
  r.calibrateAndArm()
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.shown.length, 0, 'nothing is asked while nothing has happened')
  assert.equal(r.flow.recordingHeld, false)

  r.provider.discontinuity('jump')
  assert.equal(r.flow.phase, 'prompting')
  assert.equal(r.view.kind, 'interruption')
  assert.deepEqual(r.view.labels, ['Re-anchor here', 'Keep going'])
  assert.equal(r.view.current?.actions[0]?.primary, true, 'Re-anchor here is the default')
  assert.notEqual(r.view.current?.actions[1]?.primary, true)
  assert.equal(r.flow.recordingHeld, true, 'nothing is added to the scan while the choice is open')
})

test('the prompt says tracking was interrupted and parts MAY be shifted, and that re-anchoring inherits the Place frame\'s own error', () => {
  const r = rig({ frame: twoPointFrame({ separationM: 1 }) })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const { text, detail } = r.view.current!
  assert.equal(text, 'Tracking was interrupted. Parts of this scan may be shifted.')
  // The work package's own example is a pair 1 m apart. The figure is the one the calibration card gives for the same pair.
  assert.match(detail ?? '', /inherits their error\. Estimate: two scans would place a spot 5 m away up to about 59\.2 cm apart \(95 of 100 times\)/)
  assert.match(detail ?? '', /Keep going leaves this scan marked for review/)
})

test('the prompt says that recording is paused until the person chooses, and what each choice leads to', () => {
  const r = rig({ frame: twoPointFrame({ separationM: 1 }) })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const detail = r.view.current?.detail ?? ''
  assert.ok(detail.startsWith(copy.RECORDING_PAUSED_TEXT), 'the first thing it says after what happened')
  assert.match(detail, /Re-anchor saves this scan, then asks you to tap the saved points again/, 'what Re-anchor asks of the person next')
  assert.match(detail, /Skip that and the new scan is not set against the Place's frame/, 'what skipping that leaves')
  assert.equal(detail, copy.interruptionDetail(twoPointFrame({ separationM: 1 })), 'the words are the copy module\'s')
})

test('the HUD is told that recording is held while the choice is open and while the scan is saved, and not otherwise', async () => {
  const r = rig()
  assert.equal(r.flow.heldHint, null, 'off')
  r.calibrateAndArm()
  assert.equal(r.flow.heldHint, null, 'watching')
  r.provider.discontinuity()
  assert.equal(r.flow.heldHint, copy.RECORDING_HELD_HINT, 'the choice is open')
  assert.equal(r.flow.recordingHeld, true)
  let hintWhileSaving: string | null = null
  r.host.finishScan = async () => {
    hintWhileSaving = r.flow.heldHint
    return 'uploaded'
  }
  let hintWhileCalibrating: string | null = 'unset'
  const calibrate = r.host.calibrate
  r.host.calibrate = async () => {
    hintWhileCalibrating = r.flow.heldHint
    return calibrate()
  }
  await r.flow.reanchor()
  assert.equal(hintWhileSaving, copy.RECORDING_SAVING_HINT, 'while it is saved')
  assert.equal(hintWhileCalibrating, null, 'recording is on for the new scan while it is calibrated')
  assert.equal(r.flow.heldHint, null, 'and once it is armed')
})

test('the HUD hint goes with the hold: Keep going and a failed save change it as they change the hold', () => {
  const r = rig({ state: { finishes: ['failed'] } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.view.press('keep')
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.flow.heldHint, null)
  r.provider.discontinuity('recovered')
  assert.equal(r.flow.heldHint, copy.RECORDING_HELD_HINT)
})

test('while a check is open the scan is recording and the HUD says nothing about it being held', () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  assert.equal(r.flow.phase, 'checking')
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.flow.heldHint, null)
})

test('a discontinuity before the scan has a calibration asks nothing: there is no frame to have moved from', () => {
  const r = rig()
  r.provider.discontinuity()
  assert.equal(r.flow.phase, 'off')
  assert.equal(r.view.shown.length, 0)
  assert.equal(r.flow.recordingHeld, false)
  assert.deepEqual(r.state.said, [])
})

test('a scan calibrated after an earlier shift is watched from the epoch it was calibrated in, not from the start', () => {
  const r = rig()
  r.provider.discontinuity()
  r.provider.discontinuity()
  assert.equal(r.provider.epoch, 2)
  r.calibrateAndArm()
  assert.equal(r.view.current, null, 'both shifts came before the calibration')
  r.provider.discontinuity()
  assert.equal(r.view.kind, 'interruption', 'the third came after it')
})

test('a shift that came while the calibration was running is put to the person as soon as the flow is armed', () => {
  const r = rig()
  // The calibration began in epoch 0 and the runtime moved to 1 before the person committed: the log keeps epoch 0 for it.
  r.state.calibration = twoPointCalibration()
  r.log.noteCalibrated(0)
  r.provider.discontinuity()
  r.flow.arm()
  assert.equal(r.view.kind, 'interruption')
  assert.equal(r.flow.recordingHeld, true)
  assert.equal(r.flow.heldShifts, 0, 'recording was on while it came, so none of it is held back from the count')
})

test('a flow that is armed with no calibration, or none the log holds an epoch for, stays off', () => {
  const none = rig()
  none.flow.arm()
  assert.equal(none.flow.phase, 'off')
  const unlogged = rig()
  unlogged.state.calibration = twoPointCalibration()
  unlogged.flow.arm()
  assert.equal(unlogged.flow.phase, 'off', 'the log holds no epoch for it')
  assert.equal(unlogged.view.checkVisible, false)
})

// ── A frame that this very calibration set, across an interruption ──────────────────────────────────

/** A scan whose calibration began in epoch 0, was interrupted before it committed, and set the Place's frame itself. */
function frameSetAcrossShift(): Rig {
  const calibratedAt = '2026-11-17T09:00:00.000Z'
  const r = rig({ frame: twoPointFrame({ createdAt: calibratedAt, separationM: 1 }) })
  r.state.calibration = twoPointCalibration({ calibratedAt, separationM: 1 })
  r.log.noteCalibrated(0)
  r.provider.discontinuity('recovered')
  r.flow.arm()
  return r
}

test('when the Place\'s saved points are the ones this calibration set across an interruption, no re-anchor is offered against them', () => {
  const r = frameSetAcrossShift()
  assert.equal(r.view.shown.length, 0, 'no banner: re-anchoring would be measured against the thing being warned of')
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.flow.heldHint, null)
  assert.deepEqual(r.state.said, [copy.FRAME_SET_ACROSS_SHIFT_WARNING])
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.checkVisible, true, 'a check can still be made')
  assert.doesNotMatch(r.state.said[0]!, /about \d+ cm/, 'no figure that the code knows to be too small')
})

test('the interruption a calibration was set across is told once, and the scan is still marked for review', () => {
  const r = frameSetAcrossShift()
  r.provider.amend()
  assert.equal(r.state.said.length, 1)
  assert.equal(r.log.frameShifts, 1, 'the log still counts it, so the quality verdict says needs-review')
  assert.equal(r.flow.heldShifts, 0)
  assert.equal(verdictWith(r.log.frameShifts - r.flow.heldShifts).status, 'needs-review')
})

test('a check that closes does not put the interruption a calibration was set across to the person again', async () => {
  const r = frameSetAcrossShift()
  await runCleanCheck(r)
  r.view.press('done')
  assert.equal(r.view.shown.some((prompt) => prompt.kind === 'interruption'), false, 'it was told of already, and no re-anchor is on offer against that frame')
  assert.equal(r.state.said.length, 1)
  assert.equal(r.flow.recordingHeld, false)
})

test('a frame the calibration was only verified against is still re-anchored to: it was not set across the interruption', () => {
  const r = rig({ frame: twoPointFrame({ createdAt: '2026-11-01T00:00:00.000Z', separationM: 1 }) })
  r.state.calibration = twoPointCalibration({ calibratedAt: '2026-11-17T09:00:00.000Z', separationM: 1 })
  r.log.noteCalibrated(0)
  r.provider.discontinuity('recovered')
  r.flow.arm()
  assert.equal(r.view.kind, 'interruption', 'the frame is older than this calibration')
  assert.equal(r.flow.recordingHeld, true)
  assert.deepEqual(r.state.said, [])
})

test('a frame the calibration set, in a scan whose calibration was not interrupted, is re-anchored to when it is later', () => {
  const calibratedAt = '2026-11-17T09:00:00.000Z'
  const r = rig({ frame: twoPointFrame({ createdAt: calibratedAt, separationM: 1 }) })
  r.calibrateAndArm(twoPointCalibration({ calibratedAt, separationM: 1 }))
  assert.equal(r.view.shown.length, 0)
  r.provider.discontinuity()
  assert.equal(r.view.kind, 'interruption', 'both taps were in one epoch, so the frame is sound')
  assert.deepEqual(r.state.said, [])
})

test('what the flow reads to tell the two apart is what a calibration commit writes: the frame and the calibration share one time', () => {
  const verdict: AcceptedTwoPoint = { kind: 'accepted', separationM: 1, residualM: 0, toleranceM: 0.15, status: 'provisional', frameChanged: true }
  const input = {
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 1 },
    frameBearingDeg: null,
    bearingConvention: 2 as const,
    pointLabels: undefined,
    calibratedAt: '2026-11-17T09:00:00.000Z',
  }
  const two = buildTwoPointCommit(verdict, input)
  assert.equal(two.spatialFrame?.createdAt, two.calibration.calibratedAt)
  const one = buildOnePointCommit({ landmark: input.landmark, frameBearingDeg: 90, bearingConvention: 2, existingFrame: null, calibratedAt: input.calibratedAt }, { isDisturbed: () => false } as never)
  assert.equal(one.kind, 'committed')
  if (one.kind === 'committed') assert.equal(one.spatialFrame?.createdAt, one.calibration.calibratedAt)
})

test('the tracker amending an epoch it already reported is not a second discontinuity', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity('resumed')
  const shown = r.view.shown.length
  r.provider.amend({ translationM: 0.4 })
  assert.equal(r.view.shown.length, shown, 'no new prompt')
  assert.equal(r.flow.heldShifts, 1)
})

test('a second interruption while the choice is open is counted, and said', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  assert.match(r.view.current!.text, /^Tracking was interrupted\. Parts/)
  r.provider.discontinuity('recovered')
  assert.equal(r.flow.phase, 'prompting')
  assert.equal(r.flow.heldShifts, 2)
  assert.match(r.view.current!.text, /^Tracking was interrupted 2 times\. Parts of this scan may be shifted\.$/)
})

// ── Nothing to re-anchor against: warn only ─────────────────────────────────────────────────────────

test('with no stored frame the person is told and recording goes on: there is no choice to make', () => {
  for (const [frame, warning] of [[null, copy.NO_FRAME_WARNING], [onePointFrame(), copy.ONE_POINT_FRAME_WARNING]] as const) {
    const r = rig({ frame })
    r.calibrateAndArm()
    r.provider.discontinuity()
    assert.equal(r.view.shown.length, 0, `no banner for ${frame ? 'a one-point frame' : 'no frame'}`)
    assert.equal(r.flow.recordingHeld, false, 'the scan keeps recording')
    assert.equal(r.flow.heldHint, null, 'and the HUD does not say it is held')
    assert.deepEqual(r.state.said, [warning])
    assert.equal(r.flow.phase, 'watching')
  }
})

test('a Place that has a frame of one point is not told it has no frame: the two warnings say what is true of each', () => {
  const none = rig({ frame: null })
  none.calibrateAndArm()
  none.provider.discontinuity()
  assert.match(none.state.said[0]!, /No saved frame to re-anchor to/)
  const onePoint = rig({ frame: onePointFrame() })
  onePoint.calibrateAndArm()
  onePoint.provider.discontinuity()
  assert.match(onePoint.state.said[0]!, /Saved frame is one point: nothing to re-anchor to/)
  assert.doesNotMatch(onePoint.state.said[0]!, /No saved frame/)
})

test('a warning is given once for each interruption, not again for the same ones', () => {
  const r = rig({ frame: null })
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.provider.amend()
  assert.equal(r.state.said.length, 1)
  r.provider.discontinuity('recovered')
  assert.equal(r.state.said.length, 2, 'a new interruption is a new warning')
})

test('a check that closes does not warn again of an interruption the person was already told of', async () => {
  const r = rig({ frame: null })
  r.calibrateAndArm()
  r.provider.discontinuity()
  assert.equal(r.state.said.length, 1)
  await runCleanCheck(r)
  r.view.press('done')
  assert.equal(r.state.said.length, 1, 'once, as when it happened')
  assert.equal(r.flow.phase, 'watching')
})

test('only a two-point frame can be re-anchored against', () => {
  assert.equal(canReanchor(twoPointFrame()), true)
  assert.equal(canReanchor(onePointFrame()), false)
  assert.equal(canReanchor(null), false)
  assert.equal(canReanchor(undefined), false)
})

// ── Keep going ──────────────────────────────────────────────────────────────────────────────────────

/** The verdict a steady scan of 1 600 points would get with `frameShifts` interruptions counted against it. */
function verdictWith(frameShifts: number, closureExceeded = false): { status: string; recommendations: string[] } {
  const positions = new Float32Array(1600 * 3)
  for (let i = 0; i < 1600; i++) {
    positions[i * 3] = ((i % 40) + 0.5) / 40
    positions[i * 3 + 2] = (Math.floor(i / 40) + 0.5) / 40
  }
  const cloud = {
    count: 1600,
    boundingBox: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } }),
    toFloat32Array: () => positions,
  } as unknown as PointCloud
  const monitor = new ScanQualityMonitor()
  monitor.tick({ isTracking: () => true, trackingStatus: () => 'NORMAL', getPose: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }) } as unknown as ARProvider, cloud)
  const summary = monitor.summary({ pointCount: 1600, detectionCount: 3, poseCount: 40, keyframeCount: 10, frameShifts, closureExceeded })
  return { status: summary.status, recommendations: summary.recommendations }
}

test('Keep going closes the choice, resumes recording, and leaves the scan marked for review', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  assert.equal(r.flow.recordingHeld, true)
  // While the choice is open nothing was recorded after the interruption, so the verdict does not count it.
  assert.equal(verdictWith(r.log.frameShifts - r.flow.heldShifts).status, 'ready')

  r.view.press('keep')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.flow.recordingHeld, false, 'recording is back on')
  assert.equal(r.view.current, null)
  assert.equal(r.flow.heldShifts, 0, 'from here on the scan does hold geometry from both sides of it')
  assert.equal(r.log.frameShifts, 1)
  const verdict = verdictWith(r.log.frameShifts - r.flow.heldShifts)
  assert.equal(verdict.status, 'needs-review', 'Keep going leaves the scan needs-review')
  assert.deepEqual(verdict.recommendations, ['Tracking was interrupted: parts may be shifted'])
  assert.deepEqual(r.state.calls, [], 'nothing was ended, saved or begun')
})

test('after Keep going the same epochs are not asked about again, and a new interruption is', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.view.press('keep')
  r.provider.amend()
  assert.equal(r.view.current, null, 'the epoch already kept through')
  r.provider.discontinuity('recovered')
  assert.equal(r.view.kind, 'interruption', 'a new one')
  assert.match(r.view.current!.text, /^Tracking was interrupted 2 times\./, 'counted since the scan began, kept-through ones included')
  assert.equal(r.flow.heldShifts, 1, 'only the new one is held back')
})

test('a check that closes after Keep going does not put the interruption that was kept through to the person again', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.view.press('keep')
  await runCleanCheck(r)
  assert.equal(r.view.kind, 'closure')
  r.view.press('done')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.current, null, 'it was kept through already')
  assert.equal(r.flow.recordingHeld, false)
})

test('Keep going does nothing when no choice is open', () => {
  const r = rig()
  r.calibrateAndArm()
  r.flow.keepGoing()
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.hides, 1, 'only the hide that arming made')
})

// ── Re-anchor ───────────────────────────────────────────────────────────────────────────────────────

test('Re-anchor saves the scan, begins the next one in the epoch the runtime is in, calibrates it, and watches from the new epoch', async () => {
  const r = rig({ runId: 'run-a' })
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.provider.discontinuity('recovered')
  assert.equal(r.provider.epoch, 2)

  r.view.press('reanchor')
  assert.equal(r.view.kind, 'saving', 'the person sees that the scan is being saved')
  assert.equal(r.flow.recordingHeld, true, 'held while it is saved')
  await settle()

  assert.deepEqual(r.state.calls, ['finishScan', 'beginScan:2', 'calibrate'], 'saved first, then begun, then calibrated')
  assert.deepEqual(r.state.runIds, ['run-a.2'], 'the next scan is stamped with the run and the epoch it began in')
  assert.deepEqual(r.state.heldAt, { finishScan: true, beginScan: true, calibrate: false }, 'recording is back on for the new scan, and the calibration is of the new scan')
  assert.equal(r.flow.phase, 'watching', 'armed for the new scan')
  assert.equal(r.log.calibrationEpoch, 2, 'the new scan was calibrated in the epoch it began in')
  assert.equal(r.log.frameShifts, 0, 'and has seen no interruption of its own')
  assert.equal(r.flow.heldShifts, 0)
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.view.current, null)
  assert.equal(r.view.checkVisible, true, 'Check drift is on offer for the new scan')
})

test('the saving banner is down and the held interruptions are let go before the new scan is calibrated', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.provider.discontinuity('recovered')
  await r.flow.reanchor()
  assert.deepEqual(r.state.shownAt, { finishScan: 'saving', beginScan: 'saving', calibrate: null }, 'the calibration card is the only thing on screen')
  assert.deepEqual(r.state.heldShiftsAt, { finishScan: 2, beginScan: 2, calibrate: 0 }, 'the new scan is counted from nothing as soon as it begins')
})

test('a Re-anchor after an earlier Keep going arms the new scan cleanly: neither interruption is put to the person again', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.view.press('keep')
  r.provider.discontinuity('recovered')
  assert.equal(r.view.kind, 'interruption')
  r.view.press('reanchor')
  await settle()
  assert.equal(r.log.calibrationEpoch, 2)
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.current, null, 'the new scan was calibrated after both of them')
  assert.equal(r.flow.recordingHeld, false)
})

test('the outcome says whether the new scan was calibrated and which epoch it began in', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  assert.deepEqual(await r.flow.reanchor(), { ok: true, calibrated: true, epoch: 1 })
})

test('the new scan is calibrated by a flow of its own, and a second shift after it is put to the person again', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  await r.flow.reanchor()
  assert.equal(r.view.current, null)
  r.provider.discontinuity('resumed')
  assert.equal(r.view.kind, 'interruption', 'the new scan is watched as the first was')
  await r.flow.reanchor()
  assert.deepEqual(r.state.runIds, ['run-a.1', 'run-a.2'], 'the epoch is replaced, not appended to')
})

test('an epoch of 0 gives no suffix and a run that has not started gives no id', async () => {
  const noRun = rig({ runId: null })
  noRun.calibrateAndArm()
  noRun.provider.discontinuity()
  await noRun.flow.reanchor()
  assert.deepEqual(noRun.state.runIds, [undefined], 'the host takes a fresh id')
})

test('when saving the scan fails nothing is ended: the choice stays open, recording stays held, and Re-anchor can be tried again', async () => {
  const r = rig({ state: { finishes: ['failed', 'uploaded'] } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const outcome = await r.flow.reanchor()
  assert.deepEqual(outcome, { ok: false, reason: 'save-failed' })
  assert.deepEqual(r.state.calls, ['finishScan'], 'the next scan was not begun: the point cloud exists nowhere else')
  assert.equal(r.flow.phase, 'prompting')
  assert.equal(r.flow.recordingHeld, true)
  assert.equal(r.view.kind, 'save-failed')
  assert.equal(r.view.current?.text, copy.SAVE_FAILED_TEXT)
  assert.deepEqual(r.view.labels, ['Re-anchor here', 'Keep going'])

  r.view.press('reanchor')
  await settle()
  assert.deepEqual(r.state.calls, ['finishScan', 'finishScan', 'beginScan:1', 'calibrate'])
  assert.equal(r.flow.phase, 'watching')
})

test('a save that throws is a failed save', async () => {
  const r = rig({ state: { finishes: ['throw'] } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await r.flow.reanchor(), { ok: false, reason: 'save-failed' })
  } finally {
    console.error = error
  }
  assert.equal(r.flow.recordingHeld, true)
})

// ── A save that does not answer ─────────────────────────────────────────────────────────────────────

test('the save may take a minute, which is adopted and not measured', () => {
  assert.equal(FINISH_LIMIT_MS, 60_000)
})

test('a save that does not answer in time gives the choice back with its own words, and nothing is ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.host.finishScan = () => new Promise(() => {}) // an upload that never answers: the request has no limit of its own
  const { error } = console
  console.error = () => {}
  try {
    const done = r.flow.reanchor()
    await settle()
    assert.equal(r.flow.phase, 'finishing')
    assert.equal(r.view.kind, 'saving')
    assert.deepEqual(r.view.labels, [], 'no button while it is being saved')
    assert.equal(r.flow.heldHint, copy.RECORDING_SAVING_HINT)

    t.mock.timers.tick(FINISH_LIMIT_MS - 1)
    await settle()
    assert.equal(r.flow.phase, 'finishing', 'not yet')
    t.mock.timers.tick(1)
    assert.deepEqual(await done, { ok: false, reason: 'save-timed-out' })
  } finally {
    console.error = error
  }
  assert.equal(r.flow.phase, 'prompting')
  assert.equal(r.flow.recordingHeld, true, 'the choice is open again, so the scan is still held')
  assert.equal(r.view.kind, 'save-failed')
  assert.equal(r.view.current?.text, copy.SAVE_SLOW_TEXT)
  assert.deepEqual(r.view.labels, ['Re-anchor here', 'Keep going'], 'a way out')
  assert.equal(r.flow.heldHint, copy.RECORDING_HELD_HINT)
  assert.deepEqual(r.state.calls, [], 'nothing was begun: the point cloud exists nowhere else')
})

test('after a save timed out Keep going puts recording back on, and the save answering late changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  let answer: (outcome: 'uploaded') => void = () => {}
  r.host.finishScan = () => new Promise((resolve) => {
    answer = resolve
  })
  const { error } = console
  console.error = () => {}
  try {
    const done = r.flow.reanchor()
    await settle()
    t.mock.timers.tick(FINISH_LIMIT_MS)
    await done
  } finally {
    console.error = error
  }
  r.view.press('keep')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.flow.recordingHeld, false)

  answer('uploaded') // the upload gets there in the end
  await settle()
  assert.equal(r.flow.phase, 'watching', 'the flow had already put the choice back and moved on')
  assert.equal(r.flow.recordingHeld, false)
  assert.deepEqual(r.state.calls, [], 'the late answer began nothing')
})

test('after a save timed out Re-anchor can be tried again, and the next answer is the one that counts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  let calls = 0
  r.host.finishScan = () => {
    calls++
    return calls === 1 ? new Promise(() => {}) : Promise.resolve('uploaded' as const)
  }
  const { error } = console
  console.error = () => {}
  try {
    const first = r.flow.reanchor()
    await settle()
    t.mock.timers.tick(FINISH_LIMIT_MS)
    assert.deepEqual(await first, { ok: false, reason: 'save-timed-out' })
  } finally {
    console.error = error
  }
  r.view.press('reanchor')
  await settle()
  assert.equal(calls, 2)
  assert.deepEqual(r.state.calls, ['beginScan:1', 'calibrate'], 'the second save answered, so the next scan began')
  assert.equal(r.flow.phase, 'watching')
})

test('a save that answers in time leaves no timer behind to call it slow later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  const outcome = await r.flow.reanchor()
  assert.deepEqual(outcome, { ok: true, calibrated: true, epoch: 1 })
  const logged: unknown[][] = []
  const { error } = console
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    t.mock.timers.tick(FINISH_LIMIT_MS * 3)
    await settle()
  } finally {
    console.error = error
  }
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.current, null, 'no choice came back over the new scan')
  assert.deepEqual(logged, [], 'and nothing was said about a save that had answered')
})

test('a save that throws answers at once, without waiting out the limit, and leaves no timer behind to call it slow later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig({ state: { finishes: ['throw'] } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const logged: string[] = []
  const { error } = console
  console.error = (...args: unknown[]) => {
    logged.push(String(args[0]))
  }
  try {
    assert.deepEqual(await r.flow.reanchor(), { ok: false, reason: 'save-failed' })
    assert.equal(r.view.current?.text, copy.SAVE_FAILED_TEXT, 'a throw is a failure, which is not what a slow save is')
    const before = logged.length
    t.mock.timers.tick(FINISH_LIMIT_MS * 3)
    await settle()
    assert.equal(logged.length, before, 'nothing was said about a save that had answered')
  } finally {
    console.error = error
  }
  assert.equal(r.view.current?.text, copy.SAVE_FAILED_TEXT, 'and the choice is not replaced by one for a slow save')
})

test('a host whose save throws before it returns a promise is a failed save too', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.host.finishScan = () => {
    throw new Error('thrown at once')
  }
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await r.flow.reanchor(), { ok: false, reason: 'save-failed' })
  } finally {
    console.error = error
  }
  assert.equal(r.flow.phase, 'prompting')
})

test('interruptions that arrive while the save is stalled are held, and still held when the choice comes back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const r = rig({ finishLimitMs: 1_000 })
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.host.finishScan = () => new Promise(() => {})
  const { error } = console
  console.error = () => {}
  try {
    const done = r.flow.reanchor()
    await settle()
    r.provider.discontinuity('recovered')
    assert.equal(r.flow.heldShifts, 2)
    t.mock.timers.tick(1_000)
    await done
  } finally {
    console.error = error
  }
  assert.equal(r.view.current?.text, copy.SAVE_SLOW_TEXT)
  assert.equal(r.flow.heldShifts, 2, 'nothing was recorded after either, and nothing was ended, so they stay held back from the verdict')
  r.view.press('keep')
  assert.equal(r.flow.heldShifts, 0, 'until the person chooses to keep going')
})

test('a scan with nothing in it, and one the service worker holds for later, are both ended', async () => {
  for (const outcome of ['empty', 'queued'] as const) {
    const r = rig({ state: { finishes: [outcome] } })
    r.calibrateAndArm()
    r.provider.discontinuity()
    assert.equal((await r.flow.reanchor()).ok, true, outcome)
    assert.deepEqual(r.state.calls, ['finishScan', 'beginScan:1', 'calibrate'], outcome)
  }
})

test('a next scan that could not be begun leaves the flow off and recording back on, never stuck held', async () => {
  const r = rig({ state: { beginThrows: true } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await r.flow.reanchor(), { ok: false, reason: 'error' })
  } finally {
    console.error = error
  }
  assert.equal(r.flow.phase, 'off')
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.view.current, null)
  assert.equal(r.view.checkVisible, false)
})

test('a person who continues without calibrating the new scan leaves it with no calibration, and the flow off for it', async () => {
  const r = rig({ state: { calibrations: [null] } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  assert.deepEqual(await r.flow.reanchor(), { ok: true, calibrated: false, epoch: 1 })
  assert.equal(r.state.calibration, undefined, 'the old scan\'s calibration did not carry over')
  assert.equal(r.log.calibrationEpoch, null)
  assert.equal(r.flow.phase, 'off')
  assert.equal(r.view.checkVisible, false)
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.log.frameShifts, 0, 'the new scan is not counted as shifted for the old one\'s interruption')
})

test('a calibration that throws leaves the new scan uncalibrated and recording', async () => {
  const r = rig({ state: { calibrations: ['throw'] } })
  r.calibrateAndArm()
  r.provider.discontinuity()
  const { error } = console
  console.error = () => {}
  try {
    assert.deepEqual(await r.flow.reanchor(), { ok: true, calibrated: false, epoch: 1 })
  } finally {
    console.error = error
  }
  assert.equal(r.flow.phase, 'off')
  assert.equal(r.flow.recordingHeld, false)
})

test('the scan Re-anchor ends reads ready: nothing was recorded after the interruption, so none is counted against it', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  // The verdict the page writes into the sidecar of the scan being saved, at the moment it is saved.
  let verdictWhenSaved = ''
  r.host.finishScan = async () => {
    verdictWhenSaved = verdictWith(r.log.frameShifts - r.flow.heldShifts).status
    return 'uploaded'
  }
  assert.equal(r.log.frameShifts, 1, 'the log still says it happened')
  await r.flow.reanchor()
  assert.equal(verdictWhenSaved, 'ready')
})

test('interruptions that arrive while the scan is being saved are held too, and the next scan starts with none', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  let held = -1
  r.host.finishScan = async () => {
    r.provider.discontinuity('recovered')
    held = r.flow.heldShifts
    return 'uploaded'
  }
  await r.flow.reanchor()
  assert.equal(held, 2)
  assert.equal(r.flow.heldShifts, 0)
  assert.equal(r.log.frameShifts, 0)
})

test('a Re-anchor started while one is running does nothing', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  const first = r.flow.reanchor()
  assert.deepEqual(await r.flow.reanchor(), { ok: false, reason: 'busy' })
  await first
  assert.deepEqual(r.state.calls, ['finishScan', 'beginScan:1', 'calibrate'], 'one sequence')
})

test('a Clear while the choice is open closes it and asks again, because the next scan is in a frame the calibration was not made in', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.flow.noteScanReset()
  assert.equal(r.flow.phase, 'prompting')
  assert.equal(r.view.kind, 'interruption')
  assert.equal(r.flow.heldShifts, 0, 'the new scan has no recorded geometry to have held back')
})

test('a Clear after Keep going asks again; a Clear with nothing to ask about does not', () => {
  const r = rig()
  r.calibrateAndArm()
  r.flow.noteScanReset()
  assert.equal(r.view.current, null)
  r.provider.discontinuity()
  r.view.press('keep')
  r.flow.noteScanReset()
  assert.equal(r.view.kind, 'interruption')
})

test('a reset in the middle of a Re-anchor is the sequence\'s own and does not disturb it', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  let phaseAfterReset = ''
  const beginScan = r.host.beginScan
  r.host.beginScan = async (id, epoch) => {
    await beginScan(id, epoch)
    r.flow.noteScanReset()
    phaseAfterReset = r.flow.phase
  }
  await r.flow.reanchor()
  assert.equal(phaseAfterReset, 'finishing')
  assert.deepEqual(r.state.calls, ['finishScan', 'beginScan:1', 'calibrate'])
})

// ── ?autosplit=1 ────────────────────────────────────────────────────────────────────────────────────

test('?autosplit=1 ends the scan at once without asking, and nothing else does', async () => {
  const r = rig({ autosplit: true })
  r.calibrateAndArm()
  r.provider.discontinuity()
  await settle()
  assert.equal(r.view.shown.some((prompt) => prompt.kind === 'interruption'), false, 'the choice was never put')
  assert.deepEqual(r.state.calls, ['finishScan', 'beginScan:1', 'calibrate'])
  assert.deepEqual(r.state.said, [copy.AUTOSPLIT_NOTICE])
  assert.equal(r.flow.phase, 'watching')

  const asks = rig()
  asks.calibrateAndArm()
  asks.provider.discontinuity()
  await settle()
  assert.deepEqual(asks.state.calls, [], 'without the flag the scan is never split on its own (owner decision D13)')
})

test('?autosplit=1 is read from the page address, and only the value 1 turns it on', () => {
  assert.equal(autosplitRequested('?autosplit=1'), true)
  assert.equal(autosplitRequested('?mock=xr8&autosplit=1&debug=pose'), true)
  for (const search of ['', '?autosplit', '?autosplit=0', '?autosplit=true', '?autosplit=', '?debug=autosplit', '?Autosplit=1']) {
    assert.equal(autosplitRequested(search), false, search)
  }
})

test('with ?autosplit=1 and no frame to re-anchor against the scan is still not split: there is nothing to split into', async () => {
  const r = rig({ autosplit: true, frame: null })
  r.calibrateAndArm()
  r.provider.discontinuity()
  await settle()
  assert.deepEqual(r.state.calls, [])
  assert.deepEqual(r.state.said, [copy.NO_FRAME_WARNING])
})

// ── Listening ───────────────────────────────────────────────────────────────────────────────────────

test('attaching again replaces the subscription, and disposing stops it and takes the prompt down', () => {
  const r = rig()
  assert.equal(r.provider.listenerCount, 2, 'the epoch log and the flow')
  r.flow.attach(r.provider)
  assert.equal(r.provider.listenerCount, 2, 'still one each')
  r.calibrateAndArm()
  r.provider.discontinuity()
  assert.equal(r.view.kind, 'interruption')
  r.flow.dispose()
  assert.equal(r.provider.listenerCount, 1, 'only the epoch log')
  assert.equal(r.view.current, null)
  assert.equal(r.view.checkVisible, false)
})

test('a provider with no epoch signal never opens the choice, and a check still works', () => {
  const r = rig()
  const quiet = {}
  r.flow.attach(quiet)
  r.calibrateAndArm()
  assert.equal(r.view.checkVisible, true)
  assert.equal(r.view.current, null)
})

// ── Check drift ─────────────────────────────────────────────────────────────────────────────────────

test('the Check drift control is on offer only while a calibrated scan is recording and nothing else is open', () => {
  const r = rig()
  assert.equal(r.view.checkVisible, false, 'no calibration')
  r.calibrateAndArm()
  assert.equal(r.view.checkVisible, true)
  r.provider.discontinuity()
  assert.equal(r.view.checkVisible, false, 'while the choice is open')
  r.view.press('keep')
  assert.equal(r.view.checkVisible, true)
  r.view.handlers!.check()
  assert.equal(r.view.checkVisible, false, 'while a check is under way')
})

test('a check asks for the landmark, then the heading marker, with the labels the Place saved', () => {
  const r = rig({ frame: twoPointFrame({ pointLabels: ['north door frame', 'radiator corner'], separationM: 3.2 }) })
  r.calibrateAndArm()
  r.view.handlers!.check()
  assert.equal(r.flow.phase, 'checking')
  assert.equal(r.view.kind, 'tap-landmark')
  assert.equal(r.view.current?.text, 'Tap the landmark again “north door frame”')
  assert.deepEqual(r.view.labels, ['Cancel'])
  assert.equal(r.flow.recordingHeld, false, 'a check does not stop the scan')
})

test('the landmark tap is read through the host at the canvas coordinates the person tapped', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.05, y: 0, z: 0.02 }))
  r.view.handlers!.tap(0.31, 0.77)
  await settle()
  assert.deepEqual(r.state.readTaps, [[0.31, 0.77]])
  assert.equal(r.view.kind, 'tap-heading')
  assert.match(r.view.current?.detail ?? '', /Point B, about 3\.0 m from the landmark\./)
  assert.deepEqual(r.view.labels, ['Skip heading', 'Cancel'])
})

test('both taps give a closure: measured against the calibration, kept in the scan\'s log with its epoch and path, and shown', async () => {
  const r = rig({ state: { poses: [{ position: { x: 0, y: 1.5, z: 0 } }, { position: { x: 0, y: 1.5, z: 5 } }] } })
  r.calibrateAndArm()
  // The walk since the calibration: 3-4-5 twice. The first two poses came before it.
  r.state.poses.push({ position: { x: 3, y: 1.5, z: 9 } }, { position: { x: 0, y: 1.5, z: 5 } })
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.1, y: 0, z: 0.0 }, { source: 'burst', spreadM: 0.01, rangeM: 2.1 }), tapAt({ x: 0.1, y: 0, z: 3.0 }, { source: 'single-hit', spreadM: null, rangeM: 2.8 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()

  assert.equal(r.log.closures.length, 1)
  const record = r.log.closures[0]!
  assert.equal(record.at, '2026-11-17T09:30:00.000Z')
  assert.equal(record.epoch, 0)
  assert.ok(Math.abs(record.translationM - 0.1) < 1e-9, `translation ${record.translationM}`)
  assert.ok(Math.abs(record.yawDeg! - 0) < 1e-9)
  assert.equal(record.points, 2)
  assert.equal(record.pathLengthM, 10, 'only what was walked after the calibration: two steps of 5 m')
  assert.deepEqual(record.taps, [
    { source: 'burst', spreadM: 0.01, rangeM: 2.1 },
    { source: 'single-hit', spreadM: null, rangeM: 2.8 },
  ])
  assert.equal(record.exceeded, false)
  // And it is in what the sidecar carries.
  assert.deepEqual(r.log.snapshot().closures, [record])
  assert.equal(r.view.kind, 'closure')
  assert.equal(r.view.current?.text, 'Re-tap landed 10 cm from the stored landmark, heading turned 0.0°, after about 10 m of walking.')
  assert.equal(
    r.view.current?.detail,
    "Within the check's limit (17 cm and 4.7°). A turn that small can still move something 5 m from the landmark by about 41 cm.",
    'a limit wider than the product\'s accuracy says what a turn as large as it would do',
  )
  assert.deepEqual(r.view.labels, ['OK'])
})

test('a closure inside the limits is closed with OK, and the scan goes on being watched', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.02, y: 0, z: 0.01 }), tapAt({ x: 0.02, y: 0, z: 3.01 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
  r.view.press('done')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.current, null)
  assert.equal(r.view.checkVisible, true)
  assert.equal(r.log.closureExceeded, false)
  assert.equal(verdictWith(r.log.frameShifts, r.log.closureExceeded).status, 'ready')
})

test('a closure past a limit proposes the re-anchor, says what it measured and that it depends on the same spots being tapped, and marks the scan', async () => {
  const r = rig({ frame: twoPointFrame({ separationM: 3 }) })
  r.calibrateAndArm()
  r.view.handlers!.check()
  // The landmark re-tap lands 0.4 m off and the marker 8 degrees round: both past their limits.
  const yaw = 8 * Math.PI / 180
  r.state.taps.push(tapAt({ x: 0.4, y: 0.02, z: 0 }), tapAt({ x: 0.4 + 3 * Math.sin(yaw), y: 0.02, z: 3 * Math.cos(yaw) }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()

  const record = r.log.closures[0]!
  assert.equal(record.exceeded, true)
  assert.ok(record.translationM > CLOSURE_TRANSLATION_LIMIT_M)
  assert.equal(r.view.current?.text, 'Re-tap landed 40 cm from the stored landmark, 2 cm higher, heading turned 8.0°, after less than 1 m of walking.')
  assert.match(r.view.current?.detail ?? '', /^Past the check's limit \(17 cm and 4\.7°\)\. If you tapped the same spots, the frame has moved since you set it\./)
  assert.deepEqual(r.view.labels, ['Re-anchor here', 'Keep going'])
  assert.equal(r.log.closureExceeded, true)
  // The scan is marked for review: a gap that was measured does not leave it reading ready.
  const verdict = verdictWith(r.log.frameShifts, r.log.closureExceeded)
  assert.equal(verdict.status, 'needs-review')
  assert.deepEqual(verdict.recommendations, ['A drift check found a gap: parts may be shifted'])
})

test('Re-anchor here on a closure that proposed it runs the same sequence', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.5, y: 0, z: 0 }), tapAt({ x: 0.5, y: 0, z: 3 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
  r.view.press('reanchor')
  await settle()
  assert.deepEqual(r.state.calls.filter((call) => call !== 'readTap'), ['finishScan', 'beginScan:0', 'calibrate'])
  assert.equal(r.log.closures.length, 0, 'the new scan starts with no checks of its own')
  assert.equal(r.flow.phase, 'watching')
})

test('Keep going on a closure that proposed a re-anchor closes it and leaves recording on', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.5, y: 0, z: 0 }), tapAt({ x: 0.5, y: 0, z: 3 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
  r.view.press('keep')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.flow.recordingHeld, false)
  assert.deepEqual(r.state.calls.filter((call) => call !== 'readTap'), [])
  assert.equal(r.log.closureExceeded, true, 'the check is still on the record')
})

test('with no two-point frame to re-anchor against, a closure past its limit is shown and offers only OK', async () => {
  const r = rig({ frame: null })
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.5, y: 0, z: 0 }), tapAt({ x: 0.5, y: 0, z: 3 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
  assert.equal(r.log.closures[0]!.exceeded, true)
  assert.deepEqual(r.view.labels, ['OK'])
  assert.doesNotMatch(r.view.current?.detail ?? '', /Re-anchor/)
})

test('the one-point tier has only the landmark to tap: the check ends there, with no heading', async () => {
  const r = rig({ frame: onePointFrame() })
  r.calibrateAndArm(onePointCalibration())
  r.view.handlers!.check()
  assert.equal(r.view.kind, 'tap-landmark')
  r.state.taps.push(tapAt({ x: 0.03, y: 0, z: 0.04 }))
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.view.kind, 'closure')
  const record = r.log.closures[0]!
  assert.equal(record.points, 1)
  assert.equal(record.yawDeg, null)
  assert.ok(Math.abs(record.translationM - 0.05) < 1e-9)
  assert.doesNotMatch(r.view.current?.text ?? '', /heading/)
})

test('skipping the heading checks the landmark alone', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.03, y: 0, z: 0.04 }))
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.view.kind, 'tap-heading')
  r.view.press('skip')
  assert.equal(r.log.closures[0]!.points, 1)
  assert.equal(r.log.closures[0]!.yawDeg, null)
  assert.equal(r.view.kind, 'closure')
})

test('a refused tap says why in the words sampleTap gave, and the check waits for another', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push({ ok: false, reason: 'unsteady', n: 4, spreadM: 0.07 }, tapAt({ x: 0, y: 0, z: 0 }))
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.view.kind, 'tap-landmark')
  assert.equal(r.view.current?.detail, 'That spot did not read steadily. Hold still, or aim at a more textured spot.')
  assert.equal(r.log.closures.length, 0)
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.view.kind, 'tap-heading', 'the second try was taken')
})

test('a tap that is being read, and a tap when no check is waiting, are ignored', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.deepEqual(r.state.readTaps, [], 'no check is open')
  r.view.handlers!.check()
  let release: (tap: ReturnType<typeof tapAt>) => void = () => {}
  r.host.readTap = (x, y) => {
    r.state.readTaps.push([x, y])
    return new Promise((resolve) => {
      release = resolve
    })
  }
  r.view.handlers!.tap(0.4, 0.4)
  assert.equal(r.view.current?.busy, true, 'the prompt says it is reading')
  assert.equal(r.view.current?.detail, copy.READING_TAP_TEXT)
  r.view.handlers!.tap(0.6, 0.6)
  assert.equal(r.state.readTaps.length, 1, 'a second tap is not read over the first')
  release(tapAt({ x: 0, y: 0, z: 0 }))
  await settle()
  assert.equal(r.view.kind, 'tap-heading')
})

test('a read that throws is a refusal, and the check goes on waiting', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.host.readTap = async () => {
    throw new Error('the hit test failed')
  }
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.view.kind, 'tap-landmark')
  assert.match(r.view.current?.detail ?? '', /No stable surface/)
})

test('Cancel closes a check and a tap that was being read when it was cancelled is dropped', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  let release: (tap: ReturnType<typeof tapAt>) => void = () => {}
  r.host.readTap = () => new Promise((resolve) => {
    release = resolve
  })
  r.view.handlers!.tap(0.4, 0.4)
  r.view.press('cancel')
  assert.equal(r.flow.phase, 'watching')
  release(tapAt({ x: 0.5, y: 0, z: 0 }))
  await settle()
  assert.equal(r.log.closures.length, 0, 'nothing was recorded for a check that was cancelled')
  assert.equal(r.view.current, null)
})

test('a heading tap that was still being read when the check was cancelled is dropped: nothing is put up for a check that is over', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0, y: 0, z: 0 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  assert.equal(r.view.kind, 'tap-heading')
  let release: (tap: ReturnType<typeof tapAt>) => void = () => {}
  r.host.readTap = () => new Promise((resolve) => {
    release = resolve
  })
  r.view.handlers!.tap(0.7, 0.8)
  r.view.press('cancel')
  release(tapAt({ x: 0, y: 0, z: 3 }))
  await settle()
  assert.equal(r.view.current, null, 'neither a result nor a "could not be worked out" for a check that was cancelled')
  assert.equal(r.log.closures.length, 0)
})

test('a shift that comes while a check is open ends the check and holds recording: its taps would be in two frames', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  assert.equal(r.flow.recordingHeld, false)
  r.provider.discontinuity()
  assert.equal(r.flow.phase, 'prompting', 'the person is asked what to do about the interruption, as at any other time')
  assert.equal(r.view.kind, 'interruption')
  assert.deepEqual(r.view.labels, ['Re-anchor here', 'Keep going'])
  assert.equal(r.flow.recordingHeld, true, 'nothing more is added to the scan: it must not hold geometry from two epochs')
  assert.equal(r.flow.heldShifts, 1, 'recording was held as it arrived, so none of the scan came after it')
  assert.equal(r.view.checkVisible, false)
  assert.equal(r.log.closures.length, 0, 'no check was made')
})

test('a shift that comes between the two taps of a check drops the check, and the first tap is not used', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0, y: 0, z: 0 }), tapAt({ x: 0, y: 0, z: 3 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  assert.equal(r.view.kind, 'tap-heading')
  r.provider.discontinuity()
  assert.equal(r.view.kind, 'interruption')
  assert.equal(r.flow.recordingHeld, true)
  // The person taps the canvas anyway: no check is waiting for it.
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
  assert.equal(r.log.closures.length, 0, 'a closure with one tap in each epoch is the thing the check measures')
  assert.equal(r.view.kind, 'interruption')
  assert.equal(r.state.readTaps.length, 1, 'the second tap was not read')
})

test('a tap that was being read when the shift came is dropped: neither a result nor an error is put over the choice', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  let release: (tap: ReturnType<typeof tapAt>) => void = () => {}
  r.host.readTap = () => new Promise((resolve) => {
    release = resolve
  })
  r.view.handlers!.tap(0.4, 0.4)
  assert.equal(r.view.current?.busy, true)
  r.provider.discontinuity()
  assert.equal(r.view.kind, 'interruption')
  release(tapAt({ x: 0, y: 0, z: 0 }))
  await settle()
  assert.equal(r.view.kind, 'interruption', 'the choice is still what is on screen')
  assert.equal(r.log.closures.length, 0)
  assert.equal(r.flow.phase, 'prompting')
})

test('a shift that comes while a result is on screen ends the check too; the result it showed is already on the record', async () => {
  const r = rig()
  r.calibrateAndArm()
  await runCleanCheck(r)
  assert.equal(r.view.kind, 'closure')
  assert.equal(r.log.closures.length, 1)
  r.provider.discontinuity()
  assert.equal(r.view.kind, 'interruption')
  assert.equal(r.flow.recordingHeld, true)
  assert.equal(r.log.closures.length, 1, 'the check that was made is kept')
})

test('after a shift in a check Keep going puts recording back on and the shift is not asked about again', () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.provider.discontinuity()
  r.view.press('keep')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.flow.recordingHeld, false)
  assert.equal(r.flow.heldShifts, 0, 'from here on the scan holds geometry from both sides')
  assert.equal(r.view.checkVisible, true)
  r.view.handlers!.check()
  assert.equal(r.view.kind, 'tap-landmark', 'a new check can be made in the epoch the runtime is in')
})

test('Re-anchor after a shift in a check saves the scan, which holds geometry from one epoch only', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.provider.discontinuity()
  await r.flow.reanchor()
  assert.deepEqual(r.state.calls, ['finishScan', 'beginScan:1', 'calibrate'])
  assert.equal(r.state.heldAt['finishScan'], true)
})

test('a shift in a check with no frame to re-anchor against is a status line, and the check button comes back', () => {
  const r = rig({ frame: null })
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.provider.discontinuity()
  assert.deepEqual(r.state.said, [copy.NO_FRAME_WARNING])
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.flow.recordingHeld, false, 'nothing to choose between, so the scan goes on')
  assert.equal(r.view.current, null, 'the check that was open is closed')
  assert.equal(r.view.checkVisible, true)
})

/**
 * A flow over an epoch port that answers as it is told, for what the flow does with the answer and not for how the log works
 * it out: whether the runtime has moved past the epoch the scan is judged from is the log's to say.
 */
function flowOverPort() {
  const answers = { movedOn: false }
  const provider = new FakeProvider()
  const view = new FakeView()
  const port = {
    currentEpoch: 0,
    calibrationEpoch: 0 as number | null,
    frameShifts: 0,
    hasDiscontinuitySince: () => answers.movedOn,
    noteClosure: () => {},
  }
  const host: ReanchorHost = {
    storedFrame: () => twoPointFrame(),
    calibration: () => twoPointCalibration(),
    poses: () => [],
    readTap: async () => {
      throw new Error('not used here')
    },
    finishScan: async () => 'uploaded',
    beginScan: async () => {},
    calibrate: async () => false,
    say: () => {},
  }
  const flow = new ReanchorFlow({ view, host, epochs: port, arRunId: () => 'run-a' })
  flow.attach(provider)
  flow.arm()
  return { provider, view, flow, answers }
}

test('an interruption the epoch log does not count past the scan\'s epoch asks nothing, and the log\'s answer is what puts it to the person', () => {
  const quiet = flowOverPort()
  quiet.provider.discontinuity()
  assert.equal(quiet.view.shown.length, 0)
  assert.equal(quiet.flow.phase, 'watching')
  assert.equal(quiet.flow.recordingHeld, false)

  const moved = flowOverPort()
  moved.answers.movedOn = true
  moved.provider.discontinuity()
  assert.equal(moved.view.kind, 'interruption')
  assert.equal(moved.flow.recordingHeld, true)
})

test('an interruption the epoch log does not count past the scan\'s epoch does not close a check that is open either', () => {
  const r = flowOverPort()
  r.flow.startCheck()
  assert.equal(r.flow.phase, 'checking')
  r.provider.discontinuity()
  assert.equal(r.flow.phase, 'checking')
  assert.equal(r.view.kind, 'tap-landmark')
  assert.equal(r.flow.recordingHeld, false)
})

test('a tracker amending the epoch it already reported does not close a check that is open', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.view.press('keep')
  r.view.handlers!.check()
  r.provider.amend({ translationM: 0.4 })
  assert.equal(r.flow.phase, 'checking')
  assert.equal(r.view.kind, 'tap-landmark')
})

test('a check that closes puts to the person an interruption the flow was not told of while it was open', () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  // The flow was not listening (a provider that was swapped, a listener that was dropped); the log was.
  r.flow.dispose()
  r.provider.discontinuity()
  assert.equal(r.flow.phase, 'checking')
  r.flow.keepGoing() // what closing a check is, as far as the flow goes; disposing took the prompt down with its buttons
  assert.equal(r.view.kind, 'interruption', 'put as soon as the check closes')
  assert.equal(r.flow.heldShifts, 0, 'geometry was recorded after it, so none of it is held back')
})

test('a check that cannot be worked out says so and does not record one', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: Number.NaN, y: 0, z: 0 }), tapAt({ x: 0, y: 0, z: 3 }))
  r.view.handlers!.tap(0.2, 0.8)
  await settle()
  r.view.handlers!.tap(0.7, 0.8)
  await settle()
  assert.equal(r.log.closures.length, 0)
  assert.equal(r.view.current?.text, copy.CHECK_FAILED_TEXT)
  assert.deepEqual(r.view.labels, ['OK'])
})

test('the path walked is counted from the calibration, and from the start of an emptied trail after a Clear', async () => {
  const r = rig({ state: { poses: [{ position: { x: 0, y: 0, z: 0 } }, { position: { x: 100, y: 0, z: 0 } }] } })
  r.calibrateAndArm()
  r.state.poses.length = 0
  r.flow.noteScanReset()
  r.state.poses.push({ position: { x: 0, y: 0, z: 0 } }, { position: { x: 0, y: 0, z: 2 } })
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0, y: 0, z: 0 }))
  r.host.calibration = () => onePointCalibration()
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.log.closures[0]!.pathLengthM, 2)
})

test('a check pressed after the scan lost its calibration says the scan needs one, and OK closes it', () => {
  const r = rig()
  r.calibrateAndArm()
  r.state.calibration = undefined
  r.view.handlers!.check()
  assert.equal(r.view.current?.text, copy.CHECK_UNAVAILABLE_TEXT)
  assert.deepEqual(r.view.labels, ['OK'])
  assert.equal(r.flow.phase, 'checking')
  r.view.press('done')
  assert.equal(r.flow.phase, 'watching')
  assert.equal(r.view.current, null)
})

test('a calibration whose matrix is not sixteen numbers cannot be checked against', () => {
  const r = rig()
  r.calibrateAndArm(twoPointCalibration({ sessionToProject: [1, 0, 0, 0] }))
  assert.equal(r.view.checkVisible, false, 'the control is not offered')
  r.view.handlers!.check()
  assert.equal(r.view.current?.text, copy.CHECK_UNAVAILABLE_TEXT)
})

test('a check cannot be started when the scan is not watching', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.flow.startCheck()
  assert.equal(r.flow.phase, 'prompting', 'the choice about the interruption comes first')
  const off = rig()
  off.flow.startCheck()
  assert.equal(off.flow.phase, 'off')
})

test('a caller with cause to think the frame moved can offer a check, and the offer starts one', () => {
  const r = rig()
  r.calibrateAndArm()
  r.flow.suggestCheck('The anchor moved 12 cm.')
  assert.equal(r.view.kind, 'suggest')
  assert.equal(r.view.current?.text, 'The anchor moved 12 cm.')
  assert.deepEqual(r.view.labels, ['Check drift', 'Cancel'])
  r.view.press('check')
  assert.equal(r.view.kind, 'tap-landmark')
  assert.equal(r.flow.phase, 'checking')

  const off = rig()
  off.flow.suggestCheck('Nothing to check')
  assert.equal(off.view.shown.length, 0, 'an uncalibrated scan has nothing to check')

  const later = rig()
  later.calibrateAndArm()
  later.flow.suggestCheck('The anchor moved 12 cm.')
  later.view.press('later')
  assert.equal(later.view.current, null, 'Cancel puts the offer away')
  assert.equal(later.flow.phase, 'watching')
})

test('a closure is recorded in the epoch the runtime was in when it was made', async () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.view.press('keep')
  r.view.handlers!.check()
  r.state.taps.push(tapAt({ x: 0.4, y: 0, z: 0 }))
  r.host.calibration = () => onePointCalibration()
  r.view.handlers!.tap(0.5, 0.5)
  await settle()
  assert.equal(r.log.closures[0]!.epoch, 1)
})

// ── What the scan log keeps ─────────────────────────────────────────────────────────────────────────

test('a new scan starts with no checks, and a forgotten calibration is no longer counted against the scan', () => {
  const r = rig()
  r.calibrateAndArm()
  r.provider.discontinuity()
  r.log.noteClosure({
    at: '2026-11-17T09:30:00.000Z', epoch: 1, translationM: 0.3, dyM: 0, yawDeg: null, baselineM: null, points: 1, pathLengthM: 4,
    exceeded: true, limits: { translationM: 0.17, yawDeg: null, basis: 'adopted, not measured' }, taps: [],
  })
  assert.equal(r.log.frameShifts, 1)
  assert.equal(r.log.closureExceeded, true)
  r.log.reset()
  assert.equal(r.log.closures.length, 0)
  assert.equal(r.log.closureExceeded, false)
  assert.equal(r.log.frameShifts, 1, 'the calibration the epoch is counted from is kept by a reset')
  r.log.forgetCalibration()
  assert.equal(r.log.frameShifts, 0)
  assert.equal(r.log.snapshot().calibrationEpoch, null)
  assert.equal(r.log.snapshot().closures, undefined, 'no checks, no key')
})
