/**
 * WP-17b: runtime anchors as frame discontinuities, the pure part. FrameEpochTracker.noteAnchor() (src/ar/frame-epoch.ts), the glue
 * that feeds it from an anchor capability (src/ar/anchor-epochs.ts), and what a scan's log and sidecar make of an 'anchor' epoch.
 *
 * What the rules are, from the anchor research (docs/operations/AR_DEVICE_SUPPORT.md): a step of an anchor of at least 5 cm, or of
 * 1 degree about the vertical, starts an epoch; an anchor the runtime stops locating starts none by itself (a loss that comes back
 * where it was is a blip, as it is for the viewer), but a handle that is given up does when nothing accounts for it; drift of an anchor
 * from where it was first located past 10 cm or 2 degrees is a quality flag, and not an epoch. One disturbance is one epoch, whoever sees
 * it first: an anchor's step joins the epoch of a resume, a reset or a stretch of bad tracking that has one, and gives it its size when
 * it has none. Every number is adopted, not measured (ADR 0005 rule 5); device experiment DX6 sets them, and these tests pin the
 * adopted values so a change is a decision and not an accident.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-17b-anchor-epoch-tracker.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANCHOR_DRIFT_TRANSLATION_M,
  ANCHOR_DRIFT_YAW_DEG,
  ANCHOR_STEP_TRANSLATION_M,
  ANCHOR_STEP_YAW_DEG,
  FRAME_EPOCH_ADOPTED,
  FRAME_JUMP_REFRACTORY_MS,
  FrameEpochTracker,
  ScanFrameEpochLog,
  describeTracking,
  type AnchorEvent,
  type FrameDiscontinuity,
  type FrameEpochSource,
} from '../../../src/ar/frame-epoch.ts'
import { ANCHOR_MOVED_ROTATION_DEG, ANCHOR_MOVED_TRANSLATION_M, ANCHOR_RETURN_WINDOW_MS, type AnchorCapability, type AnchorMovement } from '../../../src/ar/anchors.ts'
import { forwardAnchorEvents } from '../../../src/ar/anchor-epochs.ts'
import type { Pose } from '../../../src/ar/provider.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
const pose = (x: number): Pose => ({ position: { x, y: 1.4, z: 0 }, rotation: IDENTITY })

/** A tracker that has seen its first good pose, so it has a frame to lose. */
function established(options: ConstructorParameters<typeof FrameEpochTracker>[0] = {}, deferNotify = false): FrameEpochTracker {
  const tracker = new FrameEpochTracker(options, { deferNotify })
  tracker.observe({ tMs: 0, pose: pose(0), status: 'NORMAL' })
  return tracker
}

const motion = (translationM: number, yawDeg = 0, rotationDeg = Math.abs(yawDeg)): AnchorMovement => ({ translationM, rotationDeg, yawDeg })
const moved = (step: AnchorMovement, total: AnchorMovement = step, anchorId = 'anchor-1'): AnchorEvent => ({ kind: 'moved', anchorId, step, total })
const lost = (how: 'left-set' | 'no-pose' = 'left-set', anchorId = 'anchor-1'): AnchorEvent => ({ kind: 'lost', anchorId, how })
const returned = (anchorId = 'anchor-1', awayMs = 1_000): AnchorEvent => ({ kind: 'returned', anchorId, awayMs })
const expired = (anchorId = 'anchor-1', awayMs = 15_000): AnchorEvent => ({ kind: 'expired', anchorId, awayMs })

/** A time on the tracker's clock, well clear of its first pose and of any refractory window. */
const T = 100_000

// ─── The adopted numbers ───────────────────────────────────────────────────

test('the adopted anchor numbers are the ones the design names', () => {
  assert.equal(ANCHOR_STEP_TRANSLATION_M, 0.05)
  assert.equal(ANCHOR_STEP_YAW_DEG, 1)
  assert.equal(ANCHOR_DRIFT_TRANSLATION_M, 0.1)
  assert.equal(ANCHOR_DRIFT_YAW_DEG, 2)
  assert.equal(ANCHOR_RETURN_WINDOW_MS, 15_000)
  assert.ok(ANCHOR_MOVED_TRANSLATION_M < ANCHOR_STEP_TRANSLATION_M, 'the capability reports moves below the size that starts an epoch, or none would be seen')
  assert.ok(ANCHOR_MOVED_ROTATION_DEG < ANCHOR_STEP_YAW_DEG)
  assert.ok(ANCHOR_STEP_TRANSLATION_M < ANCHOR_DRIFT_TRANSLATION_M && ANCHOR_STEP_YAW_DEG < ANCHOR_DRIFT_YAW_DEG, 'a drift flag is a bigger thing than one step')
})

test('every adopted anchor number says so beside its definition (ADR 0005 rule 5), and the tracker\'s are written into a record', () => {
  const epoch = readFileSync(join(ROOT, 'src/ar/frame-epoch.ts'), 'utf8')
  const anchors = readFileSync(join(ROOT, 'src/ar/anchors.ts'), 'utf8')
  const named: Array<[string, string]> = [
    ['ANCHOR_STEP_TRANSLATION_M', epoch],
    ['ANCHOR_STEP_YAW_DEG', epoch],
    ['ANCHOR_DRIFT_TRANSLATION_M', epoch],
    ['ANCHOR_DRIFT_YAW_DEG', epoch],
    ['ANCHOR_RETURN_WINDOW_MS', anchors],
  ]
  for (const [name, source] of named) {
    const at = source.indexOf(`export const ${name} =`)
    assert.ok(at > 0, `${name} is a named constant`)
    const comment = source.slice(source.lastIndexOf('/**', at), at)
    assert.match(comment, /Adopted, not measured \(ADR 0005 rule 5\)/, `${name} is named as adopted`)
    assert.match(comment, /Revisit when DX6/, `${name} says what replaces it`)
  }
  assert.equal(FRAME_EPOCH_ADOPTED.anchorStepTranslationM, 0.05)
  assert.equal(FRAME_EPOCH_ADOPTED.anchorStepYawDeg, 1)
  assert.equal(FRAME_EPOCH_ADOPTED.anchorDriftTranslationM, 0.1)
  assert.equal(FRAME_EPOCH_ADOPTED.anchorDriftYawDeg, 2)
})

test('the anchor thresholds can be changed for one tracker, and the default tracker is unaffected', () => {
  const strict = established({ anchorStepTranslationM: 0.02, anchorStepYawDeg: 0.5, anchorDriftTranslationM: 0.04, anchorDriftYawDeg: 1 })
  assert.equal(strict.noteAnchor(T, moved(motion(0.03)))?.cause, 'anchor')
  assert.equal(established().noteAnchor(T, moved(motion(0.03))), null)
  const drifting = established({ anchorDriftTranslationM: 0.04 })
  drifting.noteAnchor(T, moved(motion(0.03), motion(0.05)))
  assert.equal(drifting.diagnostics().anchors?.driftFlagged, true)
})

// ─── A step ────────────────────────────────────────────────────────────────

test('a step of 5 cm starts an epoch, and a step just under it does not', () => {
  const at = established()
  const event = at.noteAnchor(T, moved(motion(0.05)))
  assert.equal(event?.cause, 'anchor')
  assert.equal(event?.epoch, 1)
  assert.equal(at.epoch, 1)

  const under = established()
  assert.equal(under.noteAnchor(T, moved(motion(0.0499))), null)
  assert.equal(under.epoch, 0)
})

test('a step of 1 degree about the vertical starts an epoch, whichever way it turns, and just under does not', () => {
  for (const yawDeg of [1, -1, 1.7, -179]) {
    const tracker = established()
    const event = tracker.noteAnchor(T, moved(motion(0, yawDeg)))
    assert.equal(event?.cause, 'anchor', `${yawDeg} degrees`)
    assert.equal(event?.yawDeg, Math.abs(yawDeg), 'the size of the turn, as every yaw in an event is')
  }
  for (const yawDeg of [0.99, -0.99, 0]) {
    const tracker = established()
    assert.equal(tracker.noteAnchor(T, moved(motion(0, yawDeg))), null, `${yawDeg} degrees`)
  }
})

test('a turn about a horizontal axis is not a shift: the rule reads the turn about the vertical, as the jump rule does', () => {
  const tilted = established()
  assert.equal(tilted.noteAnchor(T, moved(motion(0, 0, 25))), null)
  assert.equal(tilted.epoch, 0)
})

test('an anchor epoch says which anchor and what it did, with the numbers it measured and no others', () => {
  const tracker = established()
  const event = tracker.noteAnchor(T, moved(motion(0.07, -2.5, 4), motion(0.2, -6), 'anchor-3'))
  assert.deepEqual(
    { ...event },
    {
      epoch: 1,
      cause: 'anchor',
      atMs: T,
      translationM: 0.07,
      yawDeg: 2.5,
      anchor: { id: 'anchor-3', what: 'moved', stepRotationDeg: 4, totalM: 0.2, totalYawDeg: 6 },
    },
  )
})

test('a step is a measured frame shift: it is counted as one and the readout says so', () => {
  const tracker = established()
  tracker.noteAnchor(T, moved(motion(0.06, 2)))
  const d = tracker.diagnostics()
  assert.equal(d.epoch, 1)
  assert.equal(d.poseJumps, 1)
  assert.equal(d.lastJumpM, 0.06)
  assert.equal(d.lastJumpDeg, 2)
  assert.deepEqual(describeTracking(d), { text: 'Tracking NORMAL · ⚠ 1 frame shift · last 0.06 m, 2°', warn: true })
})

test('a step that is not a number is not a shift, and an event never carries a number that is not one', () => {
  const tracker = established()
  assert.equal(tracker.isAnchorShift(motion(Number.NaN, 0)), false)
  assert.equal(tracker.noteAnchor(T, moved(motion(Number.NaN, 0))), null)
  const event = tracker.noteAnchor(T + 1_000, moved(motion(Number.NaN, 3, Number.NaN), motion(Number.NaN, Number.NaN)))
  assert.equal(event?.cause, 'anchor', 'the turn alone is enough')
  assert.deepEqual(JSON.parse(JSON.stringify(event)), { ...event }, 'nothing in it is NaN, which JSON would turn into null')
  assert.equal(event?.translationM, undefined)
  assert.equal(event?.anchor?.totalM, undefined)
})

// ─── A loss ────────────────────────────────────────────────────────────────

test('an anchor the runtime stops locating starts no epoch, however it goes: a loss that comes back where it was is a blip, counted and nothing more', () => {
  for (const how of ['left-set', 'no-pose'] as const) {
    for (const awayMs of [16, 400, 14_000]) {
      const tracker = established()
      assert.equal(tracker.noteAnchor(T, lost(how, 'anchor-2')), null, `${how}: going`)
      assert.equal(tracker.noteAnchor(T + awayMs, returned('anchor-2', awayMs)), null, `${how}: back after ${awayMs} ms`)
      const d = tracker.diagnostics()
      assert.equal(d.epoch, 0, `${how} ${awayMs}`)
      assert.equal(d.poseJumps, 0)
      assert.deepEqual(d.anchors, { lost: 1, returned: 1, expired: 0, folded: 0, maxDriftM: 0, maxDriftYawDeg: 0, driftFlagged: false })
      assert.deepEqual(describeTracking(d), { text: 'Tracking NORMAL · no frame shifts', warn: false })
    }
  }
})

test('an anchor that comes back displaced is a step, and a step is an epoch: the loss before it measured nothing and added nothing', () => {
  const tracker = established()
  assert.equal(tracker.noteAnchor(T, lost('no-pose', 'anchor-1')), null)
  const event = tracker.noteAnchor(T + 3_000, moved(motion(0.4), motion(0.4), 'anchor-1'))
  assert.equal(event?.cause, 'anchor')
  assert.equal(event?.epoch, 1)
  assert.deepEqual({ ...event?.anchor }, { id: 'anchor-1', what: 'moved', stepRotationDeg: 0, totalM: 0.4, totalYawDeg: 0 })
  assert.equal(tracker.noteAnchor(T + 3_000, returned('anchor-1', 3_000)), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.diagnostics().poseJumps, 1)
})

test('a handle given up is an epoch when nothing accounts for the loss: suspect, with how it went and for how long, and no size', () => {
  for (const how of ['left-set', 'no-pose'] as const) {
    const tracker = established()
    tracker.noteAnchor(T, lost(how, 'anchor-2'))
    const event = tracker.noteAnchor(T + 15_000, expired('anchor-2', 15_000))
    assert.equal(event?.cause, 'anchor', how)
    assert.equal(event?.epoch, 1)
    assert.equal(event?.atMs, T + 15_000, 'when it was given up')
    assert.deepEqual({ ...event?.anchor }, { id: 'anchor-2', what: 'expired', how, awayMs: 15_000 })
    assert.equal(event?.translationM, undefined, 'a loss has no step')
    assert.equal(event?.yawDeg, undefined)
    const d = tracker.diagnostics()
    assert.equal(d.epoch, 1)
    assert.equal(d.poseJumps, 0, 'nothing was measured, so it is not a frame shift')
    assert.equal(d.lastJumpM, 0)
    assert.deepEqual(describeTracking(d), { text: 'Tracking NORMAL · ⚠ tracking interrupted 1 time', warn: true })
    assert.deepEqual([d.anchors?.lost, d.anchors?.expired, d.anchors?.folded], [1, 1, 0])
  }
})

test('a handle given up that the tracker never saw go is still an epoch, and says no more than it knows; a time that is not a number is left out', () => {
  const tracker = established()
  const event = tracker.noteAnchor(T, expired('anchor-9', Number.NaN))
  assert.equal(event?.epoch, 1)
  assert.deepEqual({ ...event?.anchor }, { id: 'anchor-9', what: 'expired' })
  assert.deepEqual(JSON.parse(JSON.stringify(event)), { ...event }, 'nothing in it is NaN')
  const rounded = established().noteAnchor(T, expired('anchor-9', 15_000.6))
  assert.equal(rounded?.anchor?.awayMs, 15_001)
})

test('a loss is accounted for by an epoch that was going when the anchor went, that began while it was away, or that began just before: the handle given up then starts none', () => {
  // A resume is being settled when the anchor goes. A good pose closes the trip long before the handle is given up.
  const trip = established()
  trip.noteResume(T)
  trip.noteAnchor(T + 100, lost('no-pose'))
  trip.observe({ tMs: T + 2_000, pose: pose(0), status: 'NORMAL' })
  assert.equal(trip.noteAnchor(T + 15_100, expired()), null, 'a trip was open when it went')
  assert.equal(trip.epoch, 1)
  assert.equal(trip.diagnostics().anchors?.folded, 1)

  // The same anchor, gone after the trip and the half second behind it: nothing accounts for it.
  const after = established()
  after.noteResume(T)
  after.observe({ tMs: T + 2_000, pose: pose(0), status: 'NORMAL' })
  after.noteAnchor(T + 2_000 + FRAME_JUMP_REFRACTORY_MS, lost('no-pose'))
  assert.equal(after.noteAnchor(T + 17_000, expired())?.epoch, 2, 'its own epoch')

  // Another anchor's step begins an epoch while this one is away.
  const during = established()
  during.noteAnchor(T, lost('no-pose', 'anchor-1'))
  assert.equal(during.noteAnchor(T + 5_000, moved(motion(0.4), motion(0.4), 'anchor-2'))?.epoch, 1)
  assert.equal(during.noteAnchor(T + 15_000, expired('anchor-1')), null, 'an epoch began while it was away')
  assert.equal(during.epoch, 1)

  // The viewer's own jump begins one while it is away.
  const jumped = established()
  jumped.noteAnchor(T, lost('no-pose'))
  jumped.observe({ tMs: T + 5_000, pose: pose(0.01), status: 'NORMAL' })
  jumped.observe({ tMs: T + 5_014, pose: pose(0.02), status: 'NORMAL' })
  assert.equal(jumped.observe({ tMs: T + 5_028, pose: pose(1.2), status: 'NORMAL' })?.cause, 'jump')
  assert.equal(jumped.noteAnchor(T + 15_000, expired()), null)
  assert.equal(jumped.epoch, 1)

  // One that began just before it went, inside the refractory window, and one just outside it.
  const before = established()
  before.noteAnchor(T, moved(motion(0.4), motion(0.4), 'anchor-2'))
  before.noteAnchor(T + FRAME_JUMP_REFRACTORY_MS - 1, lost('no-pose', 'anchor-1'))
  assert.equal(before.noteAnchor(T + 15_000, expired('anchor-1')), null)
  assert.equal(before.epoch, 1)
  const outside = established()
  outside.noteAnchor(T, moved(motion(0.4), motion(0.4), 'anchor-2'))
  outside.noteAnchor(T + FRAME_JUMP_REFRACTORY_MS, lost('no-pose', 'anchor-1'))
  assert.equal(outside.noteAnchor(T + 15_000, expired('anchor-1'))?.epoch, 2)
})

test('an epoch that begins in the very frame the anchor went accounts for it, and a handle given up during a trip nobody has closed yet adds nothing to it', () => {
  const sameFrame = established()
  sameFrame.noteAnchor(T, lost('no-pose', 'anchor-1'))
  assert.equal(sameFrame.noteAnchor(T, moved(motion(0.4), motion(0.4), 'anchor-2'))?.epoch, 1)
  assert.equal(sameFrame.noteAnchor(T + 15_000, expired('anchor-1')), null, 'it began at the same time, and that is while it was away')

  // A trip that no good pose has closed: the handle given up is folded in, and a resume has no size for it to give.
  const open = established()
  open.noteResume(T)
  open.noteAnchor(T + 10, lost('no-pose'))
  assert.equal(open.noteAnchor(T + 15_010, expired()), null)
  assert.equal(open.log[0].anchor, undefined, 'a handle given up measured nothing, so it gives the epoch no size')
  assert.equal(open.log[0].translationM, undefined)
  assert.deepEqual([open.epoch, open.diagnostics().poseJumps, open.diagnostics().anchors?.folded], [1, 0, 1])
})

test('a second report of the same absence keeps the first: it is when the anchor went that decides what accounts for it', () => {
  const tracker = established()
  tracker.noteAnchor(T, lost('no-pose', 'anchor-1'))
  assert.equal(tracker.noteAnchor(T + 5_000, moved(motion(0.4), motion(0.4), 'anchor-2'))?.epoch, 1, 'an epoch while it was away')
  tracker.noteAnchor(T + 10_000, lost('left-set', 'anchor-1'))
  assert.equal(tracker.noteAnchor(T + 15_000, expired('anchor-1')), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.diagnostics().anchors?.lost, 2, 'both reports are counted')
})

test('anchors given up in one disturbance are one epoch, and ones that went apart are two', () => {
  const together = established()
  together.noteAnchor(T, lost('no-pose', 'anchor-1'))
  together.noteAnchor(T, lost('no-pose', 'anchor-2'))
  assert.equal(together.noteAnchor(T + 15_000, expired('anchor-1'))?.epoch, 1)
  assert.equal(together.noteAnchor(T + 15_016, expired('anchor-2')), null)
  assert.equal(together.epoch, 1)
  assert.equal(together.diagnostics().anchors?.folded, 1)

  const apart = established()
  apart.noteAnchor(T, lost('no-pose', 'anchor-1'))
  assert.equal(apart.noteAnchor(T + 15_000, expired('anchor-1'))?.epoch, 1)
  apart.noteAnchor(T + 20_000, lost('no-pose', 'anchor-2'))
  assert.equal(apart.noteAnchor(T + 35_000, expired('anchor-2'))?.epoch, 2)
})

test('what the tracker remembers of an anchor that went does not outlast its session: the next one\'s ids start again', () => {
  const tracker = established()
  tracker.noteResume(T)
  tracker.noteAnchor(T + 10, lost('no-pose', 'anchor-1'))
  tracker.noteSessionEnd()
  // The next session: its first good frame is an epoch of its own, and its anchor-1 is a new anchor that goes on its own account.
  tracker.observe({ tMs: 2 * T, pose: pose(0), status: 'NORMAL' })
  assert.equal(tracker.epoch, 2)
  tracker.noteAnchor(3 * T, lost('left-set', 'anchor-1'))
  assert.equal(tracker.noteAnchor(3 * T + 15_000, expired('anchor-1'))?.epoch, 3)
})

test('an anchor that came back is judged afresh: what accounted for its loss does not account for a later step', () => {
  const tracker = established()
  tracker.noteResume(T)
  tracker.noteAnchor(T + 10, lost('no-pose'))
  tracker.noteAnchor(T + 400, returned('anchor-1', 390))
  tracker.observe({ tMs: T + 2_000, pose: pose(0), status: 'NORMAL' })
  assert.equal(tracker.noteAnchor(T + 12_000, moved(motion(0.4), motion(0.4)))?.epoch, 2, 'ten seconds later, on its own account')
  assert.equal(tracker.noteAnchor(T + 40_000, lost('no-pose')), null)
  assert.equal(tracker.noteAnchor(T + 40_000 + 15_000, expired())?.epoch, 3, 'and its next loss is judged by its own time too')
})

// ─── One disturbance is one epoch ──────────────────────────────────────────

test('every anchor moves with the frame: the others\' steps close behind an epoch are part of it, and counted as folded, not as suppressed jumps', () => {
  const tracker = established()
  assert.equal(tracker.noteAnchor(T, moved(motion(0.3), motion(0.3), 'anchor-1'))?.epoch, 1)
  assert.equal(tracker.noteAnchor(T + 5, moved(motion(0.31), motion(0.31), 'anchor-2')), null)
  assert.equal(tracker.noteAnchor(T + FRAME_JUMP_REFRACTORY_MS - 1, moved(motion(0.3), motion(0.3), 'anchor-4')), null)
  assert.equal(tracker.noteAnchor(T + 10, moved(motion(0.02), motion(0.02), 'anchor-5')), null, 'a step too small to be one is not folded: it is nothing')
  assert.equal(tracker.epoch, 1)
  const d = tracker.diagnostics()
  assert.equal(d.anchors?.folded, 2)
  assert.equal(d.suppressedJumps, 0, 'what the viewer\'s own jumps folded together, and nothing else')
  assert.equal(d.poseJumps, 1, 'one shift')
})

test('past the refractory window the next step is a new epoch', () => {
  const tracker = established()
  tracker.noteAnchor(T, moved(motion(0.3)))
  const second = tracker.noteAnchor(T + FRAME_JUMP_REFRACTORY_MS, moved(motion(0.2)))
  assert.equal(second?.epoch, 2)
  assert.equal(tracker.diagnostics().anchors?.folded, 0)
})

test('an anchor close behind a jump of the viewer is part of that epoch, and so is a jump close behind an anchor', () => {
  const jumped = established()
  jumped.observe({ tMs: 1_000, pose: pose(0.01), status: 'NORMAL' })
  jumped.observe({ tMs: 1_014, pose: pose(0.02), status: 'NORMAL' })
  assert.equal(jumped.observe({ tMs: 1_028, pose: pose(1.2), status: 'NORMAL' })?.cause, 'jump')
  assert.equal(jumped.noteAnchor(1_040, moved(motion(1.18))), null)
  assert.equal(jumped.epoch, 1)
  assert.equal(jumped.diagnostics().anchors?.folded, 1)
  assert.equal(jumped.diagnostics().suppressedJumps, 0)

  const anchorFirst = established()
  anchorFirst.noteAnchor(3_000, moved(motion(0.4)))
  anchorFirst.observe({ tMs: 3_016, pose: pose(0.01), status: 'NORMAL' })
  anchorFirst.observe({ tMs: 3_030, pose: pose(0.02), status: 'NORMAL' })
  assert.equal(anchorFirst.observe({ tMs: 3_044, pose: pose(1.2), status: 'NORMAL' }), null, 'the viewer\'s own jump inside the window is folded the same way')
  assert.equal(anchorFirst.epoch, 1)
  assert.equal(anchorFirst.diagnostics().suppressedJumps, 1, 'and it is the viewer\'s jump that is counted as one')
})

test('a tracking loss is one epoch with an anchor held and one without: the anchor that went with it and came back displaced is part of the viewer\'s recovery', () => {
  const run = (withAnchor: boolean, relocalizesBy: number): FrameEpochTracker => {
    const tracker = established()
    if (withAnchor) tracker.noteAnchor(1_000, lost('no-pose'))
    for (let ms = 1_016; ms < 2_600; ms += 50) tracker.observe({ tMs: ms, pose: pose(0), status: 'LIMITED' })
    tracker.observe({ tMs: 2_600, pose: pose(relocalizesBy), status: 'NORMAL' })
    if (withAnchor) {
      if (relocalizesBy > 0) tracker.noteAnchor(2_600, moved(motion(relocalizesBy), motion(relocalizesBy)))
      tracker.noteAnchor(2_600, returned('anchor-1', 1_600))
    }
    return tracker
  }
  for (const by of [0, 0.4]) {
    const without = run(false, by)
    const withOne = run(true, by)
    assert.equal(without.epoch, 1, `${by} m without an anchor`)
    assert.equal(withOne.epoch, without.epoch, `${by} m with one`)
    assert.deepEqual(withOne.log.map((e) => e.cause), ['recovered'], 'the viewer\'s recovery is the one epoch')
  }

  const blip = (withAnchor: boolean): number => {
    const tracker = established()
    if (withAnchor) tracker.noteAnchor(1_000, lost('no-pose'))
    for (let ms = 1_016; ms < 1_100; ms += 16) tracker.observe({ tMs: ms, pose: pose(0), status: 'LIMITED' })
    tracker.observe({ tMs: 1_116, pose: pose(0), status: 'NORMAL' })
    if (withAnchor) tracker.noteAnchor(1_116, returned())
    return tracker.epoch
  }
  assert.equal(blip(false), 0)
  assert.equal(blip(true), 0, 'a blip the viewer\'s own rule does not count is not one because an anchor is held')
})

test('an anchor that is displaced when the trip a resume or a reset began ends is that trip: one epoch, and the step is its size, counted once as the frame shift it is', () => {
  const resumed = established()
  const began = resumed.noteResume(1_000, 5_000)
  assert.equal(began?.translationM, undefined, 'a resume cannot say how far the frame moved')
  resumed.noteAnchor(1_010, lost('no-pose'))
  for (let ms = 1_050; ms < 2_500; ms += 50) resumed.observe({ tMs: ms, pose: pose(0), status: 'LIMITED' })
  resumed.observe({ tMs: 2_500, pose: pose(0), status: 'NORMAL' })
  const sized = resumed.noteAnchor(2_500, moved(motion(0.4, 2), motion(0.4, 2), 'anchor-1'))
  assert.equal(resumed.noteAnchor(2_500, returned('anchor-1', 1_490)), null)

  assert.equal(sized?.epoch, 1, 'the same epoch, with more in it')
  assert.equal(sized?.cause, 'resumed', 'what began it is still what began it')
  assert.equal(sized?.hiddenMs, 5_000, 'and what it knew is kept')
  assert.equal(sized?.translationM, 0.4)
  assert.equal(sized?.yawDeg, 2)
  assert.deepEqual({ ...sized?.anchor }, { id: 'anchor-1', what: 'moved', stepRotationDeg: 2, totalM: 0.4, totalYawDeg: 2 })
  assert.ok(Object.isFrozen(sized) && Object.isFrozen(sized?.anchor), 'a listener cannot change what was recorded')
  assert.equal(resumed.epoch, 1)
  assert.equal(resumed.log.length, 1)
  assert.equal(resumed.log[0], sized, 'the log holds it as it now reads')
  const d = resumed.diagnostics()
  assert.deepEqual([d.poseJumps, d.lastJumpM, d.lastJumpDeg, d.suppressedJumps, d.anchors?.folded], [1, 0.4, 2, 0, 1])
  assert.deepEqual(describeTracking(d), { text: 'Tracking NORMAL · ⚠ 1 frame shift · last 0.40 m, 2°', warn: true })

  // A reset that came with a transform has its size already: the runtime's own description is kept, and nothing is counted twice.
  const described = established()
  described.noteReset(1_000, { position: { x: 0.5, y: 0, z: 0 }, orientation: IDENTITY })
  described.observe({ tMs: 2_500, pose: pose(0), status: 'NORMAL' })
  assert.equal(described.noteAnchor(2_500, moved(motion(0.4), motion(0.4))), null)
  assert.equal(described.log[0].translationM, 0.5)
  assert.equal(described.log[0].anchor, undefined)
  assert.deepEqual([described.epoch, described.diagnostics().poseJumps, described.diagnostics().anchors?.folded], [1, 1, 1])

  // A reset the runtime could not describe has none, and the anchor's step is the first measurement of it. It was already counted as a shift.
  const bare = established()
  bare.noteReset(1_000, null)
  bare.observe({ tMs: 2_500, pose: pose(0), status: 'NORMAL' })
  const given = bare.noteAnchor(2_500, moved(motion(0.4), motion(0.4)))
  assert.equal(given?.cause, 'reset')
  assert.equal(given?.transform, null, 'the runtime still did not say')
  assert.equal(given?.translationM, 0.4)
  assert.deepEqual([bare.epoch, bare.diagnostics().poseJumps, bare.diagnostics().lastJumpM], [1, 1, 0.4])

  // The first step is the size. The others, however far they went, are folded in and change nothing.
  assert.equal(resumed.noteAnchor(2_510, moved(motion(0.9), motion(0.9), 'anchor-2')), null)
  assert.equal(resumed.log[0].translationM, 0.4)
  assert.deepEqual([resumed.diagnostics().poseJumps, resumed.diagnostics().anchors?.folded], [1, 2])
})

test('an anchor measured during the trip, and then a reset that describes it: one epoch, one shift, and the runtime\'s own numbers are the ones it carries', () => {
  const tracker = established()
  tracker.noteResume(1_000)
  assert.equal(tracker.noteAnchor(1_500, moved(motion(0.4), motion(0.4)))?.translationM, 0.4, 'an anchor that is displaced before a good pose has arrived gives the trip its size')
  const described = tracker.noteReset(1_600, { position: { x: 0.45, y: 0, z: 0 }, orientation: IDENTITY })
  assert.equal(described?.epoch, 1)
  assert.equal(described?.cause, 'reset')
  assert.equal(described?.translationM, 0.45, 'the runtime\'s description replaces the step')
  assert.equal(described?.anchor?.id, 'anchor-1', 'and what the anchor measured is still on it')
  assert.deepEqual([tracker.epoch, tracker.diagnostics().poseJumps], [1, 1], 'the reset does not count the same shift again')
})

test('an anchor that sized a trip does not swallow a reset that comes after it: the runtime\'s report is still counted and announced, as it is with no anchor held', () => {
  const run = (withAnchor: boolean) => {
    const tracker = established()
    tracker.noteResume(1_000)
    if (withAnchor) tracker.noteAnchor(1_500, moved(motion(0.4), motion(0.4)))
    return { tracker, reset: tracker.noteReset(1_600, null) }
  }
  const without = run(false)
  const withOne = run(true)
  assert.equal(without.reset?.cause, 'reset')
  assert.equal(withOne.reset?.cause, 'reset', 'a reset is announced whether or not an anchor sized the trip')
  assert.equal(withOne.reset?.transform, null, 'the runtime could not say what it was')
  assert.equal(withOne.reset?.translationM, 0.4, 'and the anchor\'s size is still on it')
  assert.equal(withOne.reset?.anchor?.id, 'anchor-1')
  assert.deepEqual([without.tracker.epoch, without.tracker.diagnostics().poseJumps], [1, 1])
  assert.deepEqual([withOne.tracker.epoch, withOne.tracker.diagnostics().poseJumps], [1, 1], 'one epoch, and the one shift counted once')
  assert.equal(withOne.tracker.noteReset(1_700, null), null, 'a second reset with nothing more to say adds nothing')
})

test('the half second after a trip ends is part of it: an anchor displaced a few frames late joins it, and from the window on it is judged again', () => {
  const closed = (): FrameEpochTracker => {
    const tracker = established()
    tracker.noteResume(1_000)
    tracker.observe({ tMs: 2_500, pose: pose(0), status: 'NORMAL' })
    return tracker
  }
  const late = closed()
  const joined = late.noteAnchor(2_500 + FRAME_JUMP_REFRACTORY_MS - 1, moved(motion(0.4), motion(0.4)))
  assert.equal(joined?.epoch, 1)
  assert.equal(joined?.cause, 'resumed')
  assert.equal(joined?.translationM, 0.4)
  assert.equal(late.epoch, 1)

  const past = closed()
  const own = past.noteAnchor(2_500 + FRAME_JUMP_REFRACTORY_MS, moved(motion(0.4), motion(0.4)))
  assert.equal(own?.epoch, 2)
  assert.equal(own?.cause, 'anchor')
  assert.equal(past.log[0].translationM, undefined, 'and the trip\'s own epoch was not touched')
})

test('a trip is only added to while it began the latest epoch: once another epoch has begun, the anchor is folded into that one and the earlier trip is left as it was', () => {
  const tracker = established()
  tracker.noteResume(1_000)
  tracker.observe({ tMs: 2_000, pose: pose(0), status: 'NORMAL' })
  for (let ms = 2_014; ms < 2_600; ms += 14) tracker.observe({ tMs: ms, pose: pose(0.00001 * ms), status: 'NORMAL' })
  // A jump of the viewer, well past the resume's window: the latest epoch is the jump, and a jump is not a trip.
  assert.equal(tracker.observe({ tMs: 2_614, pose: pose(1.2), status: 'NORMAL' })?.cause, 'jump')
  assert.equal(tracker.noteAnchor(2_700, moved(motion(1.18), motion(1.18))), null)
  assert.equal(tracker.log[0].translationM, undefined, 'the resume\'s epoch is not given a size that belongs to the jump')
  assert.equal(tracker.log[0].anchor, undefined)
  assert.equal(tracker.diagnostics().poseJumps, 1, 'the jump, counted once')
})

test('an anchor that comes back displaced while a resume or a reset is still being settled is part of that trip, however late; once a good pose has closed the trip, and the half second behind it, it is judged again', () => {
  for (const begin of ['resume', 'reset'] as const) {
    const tracker = established()
    const trip = begin === 'resume' ? tracker.noteResume(1_000) : tracker.noteReset(1_000, null)
    assert.equal(trip?.epoch, 1, begin)
    // Three seconds on, well past the refractory window, and no good pose yet: the anchors come back displaced.
    assert.equal(tracker.noteAnchor(4_000, moved(motion(0.4), motion(0.4), 'anchor-1'))?.epoch, 1, `${begin}: the first gives the trip its size`)
    assert.equal(tracker.noteAnchor(4_010, moved(motion(0.5), motion(0.5), 'anchor-2')), null, `${begin}: the second is folded in`)
    // A pose the engine is unsure of does not close the trip: the next good one does.
    tracker.observe({ tMs: 4_500, pose: pose(0), status: 'LIMITED' })
    assert.equal(tracker.noteAnchor(4_600, moved(motion(0.4), motion(0.4), 'anchor-3')), null, `${begin}: after a pose that was not good`)
    assert.equal(tracker.epoch, 1, begin)
    assert.equal(tracker.diagnostics().anchors?.folded, 3, begin)
    assert.equal(tracker.diagnostics().poseJumps, 1, `${begin}: one shift`)

    tracker.observe({ tMs: 5_000, pose: pose(0), status: 'NORMAL' })
    const after = tracker.noteAnchor(7_000, moved(motion(0.4), motion(0.4), 'anchor-1'))
    assert.equal(after?.epoch, 2, `${begin}: a step after the trip is judged again`)
    assert.equal(after?.cause, 'anchor')
  }
})

test('a stretch of degraded tracking that has not had its epoch yet is not one: an anchor that steps in it is evidence that it was not a blip, and its epoch is the stretch\'s', () => {
  const tracker = established()
  tracker.observe({ tMs: 10, pose: pose(0), status: 'NORMAL' })
  tracker.observe({ tMs: 1_000, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(tracker.noteAnchor(1_100, moved(motion(0.4), motion(0.4), 'anchor-1'))?.cause, 'anchor', 'nothing had begun an epoch yet')
  // The stretch has its epoch now, and goes on: what else is said in it is part of it, however long it lasts.
  assert.equal(tracker.noteAnchor(2_500, moved(motion(0.4), motion(0.4), 'anchor-2')), null)
  tracker.noteAnchor(2_600, lost('no-pose', 'anchor-3'))
  assert.equal(tracker.noteAnchor(3_100, expired('anchor-3', 500)), null, 'a handle given up in it is part of it too')
  assert.equal(tracker.observe({ tMs: 4_000, pose: pose(0.4), status: 'NORMAL' }), null, 'the relocalization that ends it adds nothing')
  assert.equal(tracker.epoch, 1)
  assert.deepEqual(tracker.diagnostics().anchors?.folded, 2)
  // The anchors are read after the viewer in the frame that ends the stretch, and a few frames later: still part of it.
  assert.equal(tracker.noteAnchor(4_000, moved(motion(0.4), motion(0.4), 'anchor-4')), null)
  assert.equal(tracker.noteAnchor(4_000 + FRAME_JUMP_REFRACTORY_MS - 1, moved(motion(0.4), motion(0.4), 'anchor-5')), null)
  assert.equal(tracker.epoch, 1)
  assert.equal(tracker.noteAnchor(4_000 + FRAME_JUMP_REFRACTORY_MS, moved(motion(0.4), motion(0.4), 'anchor-6'))?.epoch, 2, 'and then it is over')

  const alone = established()
  alone.observe({ tMs: 10, pose: pose(0), status: 'NORMAL' })
  alone.observe({ tMs: 1_000, pose: pose(0), status: 'LIMITED', reason: 'RELOCALIZING' })
  assert.equal(alone.observe({ tMs: 4_000, pose: pose(0.4), status: 'NORMAL' })?.cause, 'recovered', 'without an anchor it is an epoch of its own')
})

// ─── Drift is a flag ───────────────────────────────────────────────────────

test('a slow correction is a flag and not an epoch: the sum passes 10 cm without any step reaching 5 cm', () => {
  const tracker = established()
  let total = 0
  for (let i = 1; i <= 3; i++) {
    total += 0.04
    assert.equal(tracker.noteAnchor(T + i * 1_000, moved(motion(0.04), motion(total))), null, `step ${i}`)
  }
  assert.equal(tracker.epoch, 0)
  const anchors = tracker.diagnostics().anchors
  assert.ok(Math.abs((anchors?.maxDriftM ?? 0) - 0.12) < 1e-12)
  assert.equal(anchors?.driftFlagged, true)
  assert.equal(tracker.diagnostics().poseJumps, 0, 'not a frame shift')
})

test('the drift flag is raised at 10 cm, or at 2 degrees, exactly, and not below', () => {
  const edge = (total: AnchorMovement): boolean | undefined => {
    const tracker = established()
    tracker.noteAnchor(T, moved(motion(0.01), total))
    return tracker.diagnostics().anchors?.driftFlagged
  }
  assert.equal(edge(motion(0.0999)), false)
  assert.equal(edge(motion(0.1)), true)
  assert.equal(edge(motion(0, 1.99)), false)
  assert.equal(edge(motion(0, 2)), true)
  assert.equal(edge(motion(0, -2.5)), true, 'whichever way it has turned')
})

test('the flag stays up while the epoch lasts, even if the anchor drifts back, and a new epoch begins the count again', () => {
  const tracker = established()
  tracker.noteAnchor(T, moved(motion(0.02), motion(0.12)))
  tracker.noteAnchor(T + 1_000, moved(motion(0.02), motion(0.03)))
  const flagged = tracker.diagnostics().anchors
  assert.equal(flagged?.driftFlagged, true)
  assert.ok(Math.abs((flagged?.maxDriftM ?? 0) - 0.12) < 1e-12, 'the farthest it got, not where it is now')

  tracker.observe({ tMs: 5_000, pose: pose(0.01), status: 'NORMAL' })
  tracker.observe({ tMs: 5_014, pose: pose(0.02), status: 'NORMAL' })
  assert.equal(tracker.observe({ tMs: 5_028, pose: pose(1.2), status: 'NORMAL' })?.cause, 'jump')
  const after = tracker.diagnostics().anchors
  assert.deepEqual([after?.driftFlagged, after?.maxDriftM, after?.maxDriftYawDeg], [false, 0, 0])
})

test('the flag stays up while the epoch lasts when it was a turn that raised it, and a new epoch begins the turn count again too', () => {
  const tracker = established()
  tracker.noteAnchor(T, moved(motion(0, 0.5), motion(0, 2.5)))
  tracker.noteAnchor(T + 1_000, moved(motion(0, 0.5), motion(0, -0.5)))
  const flagged = tracker.diagnostics().anchors
  assert.equal(flagged?.driftFlagged, true)
  assert.equal(flagged?.maxDriftYawDeg, 2.5, 'the farthest it turned, not where it is now')
  assert.equal(flagged?.maxDriftM, 0)

  tracker.noteAnchor(T + 2_000, moved(motion(0, 0.5), motion(0, 1.5)))
  assert.equal(tracker.diagnostics().anchors?.maxDriftYawDeg, 2.5, 'a smaller turn does not lower it')

  tracker.observe({ tMs: 5_000, pose: pose(0.01), status: 'NORMAL' })
  tracker.observe({ tMs: 5_014, pose: pose(0.02), status: 'NORMAL' })
  assert.equal(tracker.observe({ tMs: 5_028, pose: pose(1.2), status: 'NORMAL' })?.cause, 'jump')
  const after = tracker.diagnostics().anchors
  assert.deepEqual([after?.driftFlagged, after?.maxDriftM, after?.maxDriftYawDeg], [false, 0, 0])
})

test('the flag is the farthest of any anchor, and a step that starts an epoch is not drift', () => {
  const tracker = established()
  tracker.noteAnchor(T, moved(motion(0.02), motion(0.06), 'anchor-1'))
  tracker.noteAnchor(T + 1_000, moved(motion(0.02), motion(0.11), 'anchor-2'))
  assert.equal(tracker.diagnostics().anchors?.driftFlagged, true)

  const stepped = established()
  stepped.noteAnchor(T, moved(motion(0.3), motion(0.3)))
  assert.equal(stepped.diagnostics().anchors?.driftFlagged, false, 'the epoch took that distance')
})

// ─── What the tracker ignores ──────────────────────────────────────────────

test('before tracking is established, after the session ended, or with a clock that is not a number, an anchor starts nothing and is not counted', () => {
  const fresh = new FrameEpochTracker()
  assert.equal(fresh.noteAnchor(T, moved(motion(1))), null)
  assert.equal(fresh.noteAnchor(T, lost()), null)
  assert.equal(fresh.epoch, 0)
  assert.equal(fresh.diagnostics().anchors, undefined)

  const tracker = established()
  assert.equal(tracker.noteAnchor(Number.NaN, moved(motion(1))), null)
  assert.equal(tracker.noteAnchor(Number.POSITIVE_INFINITY, lost()), null)
  tracker.noteSessionEnd()
  assert.equal(tracker.noteAnchor(T, moved(motion(1))), null)
  assert.equal(tracker.epoch, 0)
  assert.equal(tracker.diagnostics().anchors, undefined)
})

test('a provider that is never told about an anchor reports none, and the diagnostics are what they were', () => {
  const tracker = established()
  tracker.observe({ tMs: 10, pose: pose(0), status: 'NORMAL' })
  assert.equal(tracker.diagnostics().anchors, undefined)
  assert.equal('anchors' in tracker.diagnostics(), false)
})

test('a session that ends takes its anchors\' drift with it', () => {
  const tracker = established()
  tracker.noteAnchor(T, moved(motion(0.02), motion(0.5)))
  assert.equal(tracker.diagnostics().anchors?.driftFlagged, true)
  tracker.noteSessionEnd()
  const d = tracker.diagnostics().anchors
  assert.deepEqual([d?.driftFlagged, d?.maxDriftM], [false, 0])
})

// ─── Who hears about it ────────────────────────────────────────────────────

test('listeners hear the epoch an anchor started, frozen, and a deferred tracker holds it until flush()', () => {
  const tracker = established({}, true)
  const heard: FrameDiscontinuity[] = []
  tracker.subscribe((e) => heard.push(e))
  const event = tracker.noteAnchor(T, moved(motion(0.2), motion(0.2), 'anchor-9'))
  assert.deepEqual(heard, [], 'held until the provider has finished reading the frame')
  tracker.flush()
  assert.deepEqual(heard, [event])
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event?.anchor), 'a listener cannot change what was recorded')
  assert.equal(tracker.log[0], event)
})

// ─── The seam: an anchor capability to the tracker ─────────────────────────

/** An anchor capability that does only what the seam uses: it holds the listeners, and says what was rebased. */
function fakeAnchors() {
  type Listener = (event: never) => void
  const listeners = { moved: new Set<Listener>(), lost: new Set<Listener>(), returned: new Set<Listener>(), expired: new Set<Listener>() }
  const rebased: string[] = []
  const subscribe = (set: Set<Listener>) => (listener: Listener) => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
  const capability = {
    onMoved: subscribe(listeners.moved),
    onLost: subscribe(listeners.lost),
    onReturned: subscribe(listeners.returned),
    onExpired: subscribe(listeners.expired),
    rebase: (handle: { id: string }) => {
      rebased.push(handle.id)
    },
  } as unknown as AnchorCapability
  const emit = (kind: keyof typeof listeners, event: object): void => {
    for (const listener of [...listeners[kind]]) listener(event as never)
  }
  return { capability, rebased, emit, count: () => Object.values(listeners).reduce((n, set) => n + set.size, 0) }
}

const handle = (id: string) => Object.freeze({ id })

test('the seam tells the tracker what an anchor reports, and tells whoever listens about each epoch it starts', () => {
  const { capability, emit } = fakeAnchors()
  const tracker = established()
  const started: FrameDiscontinuity[] = []
  forwardAnchorEvents(capability, tracker, { onShift: (shift) => started.push(shift) })

  emit('moved', { handle: handle('anchor-1'), step: motion(0.01), total: motion(0.12), pose: {}, atMs: T })
  assert.equal(tracker.epoch, 0)
  assert.equal(tracker.diagnostics().anchors?.driftFlagged, true, 'the total went to the tracker as drift')
  assert.equal(started.length, 0, 'a small move starts nothing')

  emit('moved', { handle: handle('anchor-1'), step: motion(0.4, 2), total: motion(0.5), pose: {}, atMs: T + 1_000 })
  emit('lost', { handle: handle('anchor-2'), atMs: T + 5_000, how: 'no-pose' })
  assert.deepEqual(started.map((e) => [e.epoch, e.cause, e.anchor?.id, e.anchor?.what]), [[1, 'anchor', 'anchor-1', 'moved']], 'a loss starts nothing')

  emit('returned', { handle: handle('anchor-2'), atMs: T + 6_000, awayMs: 1_000 })
  assert.equal(tracker.epoch, 1, 'and neither does the anchor coming back where it was')
  emit('lost', { handle: handle('anchor-3'), atMs: T + 8_000, how: 'left-set' })
  emit('expired', { handle: handle('anchor-3'), atMs: T + 23_000, awayMs: 15_000 })
  assert.deepEqual(
    started.map((e) => [e.epoch, e.cause, e.anchor?.id, e.anchor?.what, e.anchor?.how]),
    [[1, 'anchor', 'anchor-1', 'moved', undefined], [2, 'anchor', 'anchor-3', 'expired', 'left-set']],
    'a handle given up does, when nothing accounts for it',
  )
  const anchors = tracker.diagnostics().anchors
  assert.deepEqual([anchors?.lost, anchors?.returned, anchors?.expired], [2, 1, 1])
})

test('the seam tells whoever listens about the epoch a step gave a size to, as the same epoch with more in it', () => {
  const { capability, emit } = fakeAnchors()
  const tracker = established()
  const started: FrameDiscontinuity[] = []
  forwardAnchorEvents(capability, tracker, { onShift: (shift) => started.push(shift) })
  tracker.noteResume(1_000)
  tracker.observe({ tMs: 2_500, pose: pose(0), status: 'NORMAL' })
  emit('moved', { handle: handle('anchor-1'), step: motion(0.4), total: motion(0.4), pose: {}, atMs: 2_500 })
  assert.deepEqual(started.map((e) => [e.epoch, e.cause, e.translationM]), [[1, 'resumed', 0.4]])
})

test('a step that is a shift is rebased, so the step is not drift and the next frame\'s drift counts from here; a small one is not', () => {
  const { capability, emit, rebased } = fakeAnchors()
  const tracker = established()
  forwardAnchorEvents(capability, tracker)

  emit('moved', { handle: handle('anchor-1'), step: motion(0.04), total: motion(0.04), pose: {}, atMs: T })
  assert.deepEqual(rebased, [], 'a small move is drift, which is measured from where the anchor began')
  emit('moved', { handle: handle('anchor-1'), step: motion(0.3), total: motion(0.34), pose: {}, atMs: T + 1_000 })
  assert.deepEqual(rebased, ['anchor-1'])
  emit('moved', { handle: handle('anchor-2'), step: motion(0.31), total: motion(0.31), pose: {}, atMs: T + 1_010 })
  assert.deepEqual(rebased, ['anchor-1', 'anchor-2'], 'a step folded into the epoch is a shift too: it is rebased, and it is not counted as an epoch')
  assert.equal(tracker.epoch, 1)
})

test('the seam\'s stop function takes all four listeners away', () => {
  const { capability, emit, count } = fakeAnchors()
  const tracker = established()
  const stop = forwardAnchorEvents(capability, tracker)
  assert.equal(count(), 4)
  stop()
  assert.equal(count(), 0)
  emit('moved', { handle: handle('anchor-1'), step: motion(1), total: motion(1), pose: {}, atMs: T })
  emit('lost', { handle: handle('anchor-1'), atMs: T, how: 'left-set' })
  assert.equal(tracker.epoch, 0)
})

test('the seam logs what an anchor did that is not itself an epoch, so a device run can read it from the console: a loss no longer leaves a line of its own', () => {
  const { capability, emit } = fakeAnchors()
  const logged: string[] = []
  forwardAnchorEvents(capability, established(), { log: (...args) => logged.push(args.join(' ')) })
  emit('lost', { handle: handle('anchor-4'), atMs: T, how: 'no-pose' })
  emit('returned', { handle: handle('anchor-4'), atMs: T, awayMs: 2_345.6 })
  emit('lost', { handle: handle('anchor-5'), atMs: T, how: 'left-set' })
  emit('expired', { handle: handle('anchor-5'), atMs: T, awayMs: 15_000 })
  assert.deepEqual(logged, [
    'anchor anchor-4 not located (no-pose)',
    'anchor anchor-4 located again after 2346 ms',
    'anchor anchor-5 not located (left-set)',
    'anchor anchor-5 not located again in 15000 ms: given up',
  ])
})

// ─── What a scan makes of it ───────────────────────────────────────────────

/** A scan's log over a tracker, the way a provider's signal reaches it. */
function logOver(tracker: FrameEpochTracker): ScanFrameEpochLog {
  const source: FrameEpochSource = {
    getFrameEpoch: () => tracker.epoch,
    onFrameDiscontinuity: (cb) => tracker.subscribe(cb),
    getTrackingDiagnostics: () => tracker.diagnostics(),
  }
  const log = new ScanFrameEpochLog()
  log.attach(source)
  return log
}

test('a scan whose anchor stepped has a frame shift, and its sidecar says which anchor and what it measured', () => {
  const tracker = established()
  const log = logOver(tracker)
  log.noteCalibrated(0)
  assert.equal(log.frameShifts, 0)
  tracker.noteAnchor(T, moved(motion(0.08, 1.5), motion(0.08, 1.5), 'anchor-1'))
  assert.equal(log.frameShifts, 1)
  assert.equal(log.hasDiscontinuitySince(0), true)
  assert.equal(log.discontinuitiesSince(0)[0].cause, 'anchor')

  const record = log.snapshot()
  assert.equal(record.currentEpoch, 1)
  assert.equal(record.jumpCount, 1)
  assert.equal(record.jumps[0].cause, 'anchor')
  assert.deepEqual({ ...record.jumps[0].anchor }, { id: 'anchor-1', what: 'moved', stepRotationDeg: 1.5, totalM: 0.08, totalYawDeg: 1.5 })
  assert.equal(record.epochs.find((e) => e.epoch === 1)?.cause, 'anchor')
  assert.equal(record.thresholds.anchorStepTranslationM, 0.05, 'the numbers that decided it are written beside it')
  assert.equal(record.thresholds.anchorDriftYawDeg, 2)
})

test('an epoch a step gave a size to is one jump in the scan\'s record, with the size and the anchor that measured it', () => {
  const tracker = established()
  const log = logOver(tracker)
  log.noteCalibrated(0)
  tracker.noteResume(1_000, 3_000)
  tracker.observe({ tMs: 2_500, pose: pose(0), status: 'NORMAL' })
  assert.equal(log.snapshot().jumps[0].translationM, undefined)
  tracker.noteAnchor(2_500, moved(motion(0.4), motion(0.4), 'anchor-1'))

  assert.equal(log.frameShifts, 1)
  const record = log.snapshot()
  assert.equal(record.jumpCount, 1, 'the same epoch again replaces its record and is not counted')
  assert.equal(record.jumps.length, 1)
  assert.equal(record.jumps[0].cause, 'resumed')
  assert.equal(record.jumps[0].hiddenMs, 3_000)
  assert.equal(record.jumps[0].translationM, 0.4)
  assert.equal(record.jumps[0].anchor?.id, 'anchor-1')
  assert.equal(record.epochs.find((e) => e.epoch === 1)?.cause, 'resumed')
})

test('the sidecar\'s copy of an anchor fact is its own: changing it changes neither the log nor the next record', () => {
  const tracker = established()
  const log = logOver(tracker)
  tracker.noteAnchor(T, moved(motion(0.08), motion(0.08), 'anchor-1'))
  const first = log.snapshot()
  assert.ok(first.jumps[0].anchor)
  ;(first.jumps[0].anchor as { id: string }).id = 'changed'
  assert.equal(log.snapshot().jumps[0].anchor?.id, 'anchor-1')
  assert.equal(tracker.log[0].anchor?.id, 'anchor-1')
})

test('the log\'s record of an anchor epoch shares nothing with the event a provider handed over, frozen or not', () => {
  let deliver: (event: FrameDiscontinuity) => void = () => undefined
  const source: FrameEpochSource = {
    getFrameEpoch: () => 1,
    onFrameDiscontinuity: (cb) => {
      deliver = cb
      return () => undefined
    },
  }
  const log = new ScanFrameEpochLog()
  log.attach(source)
  // A provider that is not this package's tracker need not freeze what it hands over, and may go on using the object.
  const own = { id: 'anchor-1', what: 'moved' as const, totalM: 0.2 }
  deliver({ epoch: 1, cause: 'anchor', atMs: 5, translationM: 0.07, anchor: own })
  own.totalM = 9
  const record = log.snapshot()
  assert.equal(record.jumps[0].anchor?.totalM, 0.2, 'what the log kept is what was said when it was said')
  assert.notEqual(record.jumps[0].anchor, own)
})

test('a record written before anchors existed reads as it did: the shape has no new top-level key, and an old epoch has no anchor fact', () => {
  const tracker = established()
  const log = logOver(tracker)
  tracker.observe({ tMs: 1_000, pose: pose(0.01), status: 'NORMAL' })
  tracker.observe({ tMs: 1_014, pose: pose(0.02), status: 'NORMAL' })
  tracker.observe({ tMs: 1_028, pose: pose(1.2), status: 'NORMAL' })
  const record = log.snapshot()
  assert.deepEqual(Object.keys(record).sort(), [
    'baseEpoch', 'calibrationEpoch', 'currentEpoch', 'epochCount', 'epochs', 'epochsOmitted', 'floorBasis', 'floorEpoch', 'jumpCount',
    'jumps', 'limitedMs', 'mixedEpochs', 'motion', 'suppressedJumps', 'thresholds', 'version',
  ])
  assert.equal(record.version, 1)
  assert.equal(record.jumps[0].cause, 'jump')
  assert.equal('anchor' in record.jumps[0], false, 'absent, not null: an older reader that lists the keys of an epoch finds the keys it knew')
  for (const key of ['jumpTranslationM', 'jumpYawDeg', 'maxAccelerationMps2', 'maxTurnAccelerationDps2', 'maxComparableStepRatio', 'refractoryMs', 'recoverySuspectMs', 'maxCapturePoseAgeMs', 'maxAccountedIntervalMs']) {
    assert.ok(key in record.thresholds, `${key} is still written`)
  }
})
