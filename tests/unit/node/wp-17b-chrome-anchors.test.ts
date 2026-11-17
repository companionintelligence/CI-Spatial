/**
 * WP-17b: what the WebXR provider does with a runtime that behaves as Chrome with ARCore may, through the provider's own frame loop.
 *
 * The runtime is the Chrome stand-in in support/chrome-xr-session.ts. Every state in it was read in Chromium's sources and the
 * specs and has not been seen on a device (device experiment DX6 does that): the provider is asked for anchors, makes one, and is then
 * given the states Chrome can be in, one at a time. What the tests pin is the provider's answer to each. What an anchor says is a
 * frame discontinuity and never a matrix to follow: an anchor that stepped is an epoch in the same tracker the viewer pose and `reset`
 * feed, and nothing here moves a stored point. An anchor the runtime stops locating is not an epoch when it goes, because ARCore pauses
 * every anchor whenever camera tracking pauses and the viewer's own rule does not count a blip either; one disturbance is one epoch
 * whether or not an anchor is held, and an anchor that comes back displaced after a trip gives that trip its size.
 *
 * The cases: no feature (NotSupportedError, an empty set), creation that waits for the next frame and one that is postponed and fails,
 * a step, slow drift, `trackedAnchors` emptied for some frames with the same object coming back or new ones, a null pose, `reset`
 * with and without a transform, a session hidden and shown again (and the time it takes not counted against an anchor), a tracking
 * loss with and without an anchor held, and a session stopped and started again.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-17b-chrome-anchors.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import { ANCHOR_RETURN_WINDOW_MS, ANCHORS_FEATURE, tryCreateAnchor, type AnchorHandle } from '../../../src/ar/anchors.ts'
import type { FrameDiscontinuity } from '../../../src/ar/frame-epoch.ts'
import { ChromeWorld, FakeRigidTransform, IDENTITY, canvasWithGl, installBrowserGlobals, installNavigator, poseAt, video, xr, type ChromeAnchor, type PoseData } from './support/chrome-xr-session.ts'

installBrowserGlobals()

const near = (actual: number | undefined, expected: number, within = 1e-9): boolean => actual !== undefined && Math.abs(actual - expected) <= within

/** Lets the promise callbacks queued by the last frame run. */
const settle = () => new Promise<void>((done) => setImmediate(done))

/** What a promise has settled with by the end of this turn, or 'pending' if it is still waiting. No timer is ticked. */
async function byNow<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, settle().then((): 'pending' => 'pending')])
}

interface Internals {
  pushHitPoint(x: number, y: number, z: number): void
}
const internals = (p: WebXRProvider): Internals => p as unknown as Internals

interface Run {
  provider: WebXRProvider
  world: ChromeWorld
  /** Every epoch the provider announced. */
  events: FrameDiscontinuity[]
  /** What the provider logged with console.log, one line per call: the lines a device run reads from the remote console. */
  logs: string[]
  /** What it warned with console.warn: one `frame discontinuity` line for each epoch announced, which is how a device run counts resets. */
  warnings: string[]
}

type Context = { mock: { method: (o: object, m: string, i: (...args: never[]) => void) => unknown } }

/** Starts a provider on the stand-in. Its console output (warnings about the camera and the hit test, the logs a device run reads) is not what these tests are about. */
async function started(t: Context, world = new ChromeWorld(), session: unknown = world.session()): Promise<Run> {
  const logs: string[] = []
  const warnings: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => {
    logs.push(args.join(' '))
  })
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args.join(' '))
  })
  t.mock.method(console, 'info', () => {})
  // The provider's own timestamps (a `reset`, a return to view) are performance.now(); the frames carry the XR clock, which is the same one.
  world.syncClockToPage()
  video.currentTime = 0
  installNavigator(session)
  const provider = new WebXRProvider()
  await provider.start(canvasWithGl())
  const events: FrameDiscontinuity[] = []
  provider.onFrameDiscontinuity((e) => events.push(e))
  return { provider, world, events, logs, warnings }
}

/**
 * Puts the page's clock on the frame clock for the rest of the test. The provider stamps a `reset` or a return to view with
 * performance.now(), and the frames carry the XR time, which is the same clock on a device; here it is the stand-in's.
 */
function onFrameClock(t: Context, run: Run): void {
  t.mock.method(performance, 'now', () => run.world.time)
}

/** The same session with no anchors granted, for the run to compare with. */
const noAnchors = (): ChromeWorld => new ChromeWorld({ features: ['local-floor'], granted: false })

/** The distinct epochs the provider announced, in order: an epoch that was added to is announced again with the same number. */
const epochsHeard = (run: Run): number[] => [...new Set(run.events.map((e) => e.epoch))]

/** Makes one anchor and reads it once: one frame to ask, one for the runtime to settle the request, one to read it. */
async function place(run: Run, at: PoseData): Promise<{ handle: AnchorHandle; anchor: ChromeAnchor }> {
  const anchors = run.provider.anchors
  assert.ok(anchors, 'the browser granted anchors')
  const asking = anchors.createAnchor(at)
  run.world.tick()
  run.world.tick()
  const handle = await asking
  assert.ok(handle, 'the runtime made no anchor')
  run.world.tick()
  return { handle, anchor: run.world.everMade[run.world.everMade.length - 1] }
}

// ─── Without the feature ───────────────────────────────────────────────────

test('a session that was not granted anchors starts and tracks, has no anchor capability, and a calibration that asks gets null at once', async (t) => {
  const world = new ChromeWorld({ features: ['local-floor'], granted: false })
  const run = await started(t, world)
  assert.equal(xr.requests[0].mode, 'immersive-ar')
  assert.deepEqual(xr.requests[0].options.optionalFeatures, ['dom-overlay', 'local-floor', ANCHORS_FEATURE], 'asked for, as optional, every time')
  assert.deepEqual(xr.requests[0].options.requiredFeatures, ['hit-test'], 'and never required')
  assert.equal(run.provider.anchors, undefined)
  assert.equal(await byNow(tryCreateAnchor(run.provider, poseAt(0, 0, 0))), null)
  world.tick()
  world.tick()
  assert.equal(run.provider.trackingStatus(), 'NORMAL')
  assert.equal(run.provider.getFrameEpoch(), 0)
  assert.equal(run.provider.getTrackingDiagnostics().anchors, undefined, 'a provider with no anchors reports none')
  run.provider.stop()
})

test('the stand-in refuses as Blink does: NotSupportedError from createAnchor without the feature, an empty set and no throw from trackedAnchors, InvalidStateError outside a frame', async () => {
  const none = new ChromeWorld({ features: ['local-floor'], granted: false })
  none.session()
  const frame = none.frame()
  await assert.rejects(frame.createAnchor(new FakeRigidTransform({ x: 0, y: 0, z: 0, w: 1 }, IDENTITY), none.floor), { name: 'NotSupportedError', message: 'Anchors feature is not supported by the session.' })
  assert.equal(frame.trackedAnchors.size, 0)

  const granted = new ChromeWorld()
  granted.session()
  const active = granted.frame()
  await assert.rejects(active.createAnchor(null, granted.floor), { name: 'InvalidStateError', message: 'No XRRigidTransform specified.' })
  await assert.rejects(active.createAnchor(new FakeRigidTransform({ x: 0, y: 0, z: 0, w: 1 }, IDENTITY), null), { name: 'InvalidStateError', message: 'No XRSpace specified.' })
  active.active = false
  await assert.rejects(active.createAnchor(new FakeRigidTransform({ x: 0, y: 0, z: 0, w: 1 }, IDENTITY), granted.floor), { name: 'InvalidStateError' })
})

test('a Chrome that cannot say what it granted (no enabledFeatures) offers the capability, the first request is refused with NotSupportedError, and the answer is null, not a throw or a hang', async (t) => {
  const world = new ChromeWorld({ features: null, granted: false })
  const run = await started(t, world)
  const anchors = run.provider.anchors
  assert.ok(anchors, 'nothing says anchors are absent')
  const asking = anchors.createAnchor(poseAt(0, 0, 0))
  world.tick()
  assert.deepEqual(world.refused, [{ name: 'NotSupportedError', message: 'Anchors feature is not supported by the session.' }])
  assert.equal(world.created.length, 0, 'the runtime refused before it kept anything')
  assert.equal(await byNow(asking), null, 'answered in the next turn, without waiting for a timeout')
  world.tick()
  assert.equal(run.provider.getFrameEpoch(), 0, 'a refused request is not a loss')
  assert.equal(run.provider.trackingStatus(), 'NORMAL')
  run.provider.stop()
})

// ─── Creation ──────────────────────────────────────────────────────────────

test('creation is pending in the frame it was made, answered by the next one, and readable the frame after: nothing about it is an epoch', async (t) => {
  const run = await started(t)
  const anchors = run.provider.anchors
  assert.ok(anchors)
  const asking = anchors.createAnchor(poseAt(1, 0, 2))
  assert.equal(run.world.created.length, 0, 'an anchor cannot be made between frames')
  run.world.tick()
  assert.equal(run.world.created.length, 1)
  assert.equal(run.world.created[0].space, run.world.floor, 'made in the reference space the pose was read in')
  assert.equal(await byNow(asking), 'pending', 'the runtime settles a new anchor in the next frame')
  run.world.tick()
  const handle = await asking
  assert.ok(handle)
  assert.equal(anchors.anchorPose(handle), null, 'not read yet')
  run.world.tick()
  assert.deepEqual(anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 })
  assert.equal(run.provider.getFrameEpoch(), 0)
  assert.deepEqual(run.events, [])
  assert.equal(run.provider.getTrackingDiagnostics().anchors?.lost, undefined, 'no anchor has reported anything yet')
  run.provider.stop()
})

test('creation that the runtime postpones (it cannot locate the origin) fails after 3 s with OperationError, and is null, not a hang; a later request is made once it can', async (t) => {
  // A page clock with a fraction in it, as a real one has. This start time makes three sums of 1000 ms come out under 3000 in doubles,
  // which is the run that failed one time in thirty before the stand-in's clock was kept in whole milliseconds.
  t.mock.method(performance, 'now', () => 204.47402409079254)
  const run = await started(t)
  run.world.tick()
  run.world.localizable = false
  const asking = run.provider.anchors?.createAnchor(poseAt(1, 0, 2))
  assert.ok(asking)
  run.world.tick()
  assert.equal(run.world.created.length, 1, 'the request reached the runtime')
  run.world.tick({ dtMs: 1_000 })
  run.world.tick({ dtMs: 1_000 })
  assert.equal(await byNow(asking), 'pending', 'still waiting at 2 s')
  assert.deepEqual(run.world.refused, [])
  run.world.tick({ dtMs: 1_000 })
  assert.deepEqual(run.world.refused, [{ name: 'OperationError', message: 'Anchor creation failed.' }], 'refused at 3 s')
  assert.equal(await byNow(asking), null)

  run.world.localizable = true
  const handle = await place(run, poseAt(1, 0, 2))
  assert.ok(handle.handle)
  assert.equal(run.provider.getFrameEpoch(), 0)
  run.provider.stop()
})

// ─── A step ────────────────────────────────────────────────────────────────

test('an anchor that steps is an epoch in the frame it steps in: a capture taken in that frame carries it, the probe hits not yet handed over are dropped, and the step is rebased', async (t) => {
  const run = await started(t)
  const { handle } = await place(run, poseAt(1, 0, 2))
  const anchors = run.provider.anchors
  assert.ok(anchors)
  internals(run.provider).pushHitPoint(1, 0, -2)
  const capture = run.provider.captureFrame(60_000)

  run.world.shiftFrame({ x: -0.25, y: 0, z: 0 })
  run.world.tick()
  const frame = await capture
  assert.equal(frame.epoch, 1, 'the anchor was read before the capture was stamped')
  assert.equal(run.events.length, 1, 'told to the provider\'s listeners in the same frame')
  const [event] = run.events
  assert.equal(event.cause, 'anchor')
  assert.equal(event.epoch, 1)
  assert.equal(event.anchor?.what, 'moved')
  assert.equal(event.anchor?.id, handle.id)
  assert.ok(near(event.translationM, 0.25))
  assert.deepEqual(run.provider.featurePoints(), [], 'the hits taken before it belong to the epoch before')
  const d = run.provider.getTrackingDiagnostics()
  assert.equal(d.epoch, 1)
  assert.equal(d.poseJumps, 1, 'a step is a measured shift')
  assert.ok(near(d.lastJumpM, 0.25))
  assert.equal(d.anchors?.driftFlagged, false, 'the step is an epoch, not drift')
  assert.equal(anchors.anchorDisplacement(handle)?.translationM, 0, 'and the anchor is measured from where it is now')
  run.provider.stop()
})

test('a step is not an epoch until it is 5 cm: a smaller correction is drift, and the drift is a flag that rises with the sum', async (t) => {
  const run = await started(t)
  await place(run, poseAt(1, 0, 2))
  for (let i = 1; i <= 3; i++) {
    run.world.shiftFrame({ x: -0.04, y: 0, z: 0 })
    run.world.tick()
    assert.equal(run.provider.getFrameEpoch(), 0, `correction ${i} of 4 cm`)
  }
  const anchors = run.provider.getTrackingDiagnostics().anchors
  assert.ok(near(anchors?.maxDriftM, 0.12, 1e-9))
  assert.equal(anchors?.driftFlagged, true)
  assert.equal(run.provider.getTrackingDiagnostics().poseJumps, 0)
  run.provider.stop()
})

test('after a step the drift is counted from the new frame: the same creep that would have read as 29 cm reads as 4', async (t) => {
  const run = await started(t)
  await place(run, poseAt(1, 0, 2))
  run.world.shiftFrame({ x: -0.25, y: 0, z: 0 })
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 1)
  // Past the half second in which a second step is part of the first.
  for (let i = 0; i < 40; i++) run.world.tick()
  run.world.shiftFrame({ x: -0.04, y: 0, z: 0 })
  run.world.tick()
  const anchors = run.provider.getTrackingDiagnostics().anchors
  assert.ok(near(anchors?.maxDriftM, 0.04, 1e-9), `drift is ${anchors?.maxDriftM}`)
  assert.equal(anchors?.driftFlagged, false)
  assert.equal(run.provider.getFrameEpoch(), 1)
  run.provider.stop()
})

test('a shift that Chrome never announces with a reset is still an epoch, because the anchor sees it; and a viewer jump with the anchor moving with it is one epoch, not two', async (t) => {
  const quiet = await started(t)
  await place(quiet, poseAt(1, 0, 2))
  quiet.world.shiftFrame({ x: -0.25, y: 0, z: 0 })
  quiet.world.tick()
  assert.equal(quiet.provider.getFrameEpoch(), 1, 'no reset event, no viewer jump (25 cm is under the 30 cm floor), and still an epoch')
  assert.equal(quiet.events[0].cause, 'anchor')
  quiet.provider.stop()

  const both = await started(t)
  await place(both, poseAt(1, 0, 2))
  both.world.tick()
  both.world.shiftFrame({ x: -0.6, y: 0, z: 0 })
  both.world.tick()
  assert.equal(both.provider.getFrameEpoch(), 1, 'the viewer pose jumped and so did the anchor: one move of the frame')
  assert.equal(both.events[0].cause, 'jump', 'the viewer pose is read first, so it is the one that began it')
  const d = both.provider.getTrackingDiagnostics()
  assert.equal(d.anchors?.folded, 1, 'and the anchor\'s step is the one folded into it')
  assert.equal(d.suppressedJumps, 0, 'which is not a viewer jump folded into another')
  both.provider.stop()
})

test('one move of the frame seen by twenty anchors is one epoch: nineteen of them are folded in, and the viewer\'s own count of jumps folded together stays what it was', async (t) => {
  const run = await started(t)
  for (let i = 0; i < 20; i++) await place(run, poseAt(i * 0.3, 0, 2))
  run.world.tick()
  run.world.shiftFrame({ x: -0.25, y: 0, z: 0 })
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 1)
  const d = run.provider.getTrackingDiagnostics()
  assert.equal(d.anchors?.folded, 19)
  assert.equal(d.suppressedJumps, 0, 'a high count here would mean the viewer\'s thresholds are too tight, and they are not')
  assert.equal(d.poseJumps, 1)
  run.provider.stop()
})

// ─── The tracked set is emptied ────────────────────────────────────────────

test('trackedAnchors emptied while the viewer pose stays good is a blip when the same object comes back where it was: counted and logged, and no epoch', async (t) => {
  const run = await started(t)
  const { handle } = await place(run, poseAt(1, 0, 2))
  const anchors = run.provider.anchors
  assert.ok(anchors)

  run.world.loseTracking(3, 'same')
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 0, 'the first frame it is missing: not an epoch, because it may only be a blip')
  assert.equal(run.provider.trackingStatus(), 'NORMAL', 'the viewer pose never said anything was wrong: only the anchor did')
  assert.equal(anchors.anchorPose(handle), null)
  assert.equal(run.provider.getTrackingDiagnostics().anchors?.lost, 1)
  assert.ok(run.logs.includes(`[webxr] anchor ${handle.id} not located (left-set)`), `a device run can read the loss from the console: ${run.logs.join(' | ')}`)
  run.world.tick()
  run.world.tick()
  run.world.tick()
  assert.deepEqual(anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 }, 'the same handle reads again')

  assert.equal(run.provider.getFrameEpoch(), 0, 'it came back where it was, which measured that the frame did not move against it')
  assert.deepEqual(run.events, [])
  const d = run.provider.getTrackingDiagnostics()
  assert.equal(d.poseJumps, 0)
  assert.deepEqual([d.anchors?.lost, d.anchors?.returned, d.anchors?.expired, d.anchors?.folded], [1, 1, 0, 0])
  assert.ok(run.logs.includes(`[webxr] anchor ${handle.id} located again after 48 ms`), `and so is the return: ${run.logs.join(' | ')}`)
  run.provider.stop()
})

test('a loss that lasts well past a second, and comes back where it was, is still no epoch: the anchor measured that the frame held', async (t) => {
  const run = await started(t)
  const { handle } = await place(run, poseAt(1, 0, 2))
  run.world.loseTracking(2, 'same')
  run.world.tick({ dtMs: 4_000 })
  run.world.tick({ dtMs: 4_000 })
  run.world.tick({ dtMs: 4_000 })
  assert.deepEqual(run.provider.anchors?.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 })
  assert.equal(run.provider.getFrameEpoch(), 0)
  assert.equal(run.provider.getTrackingDiagnostics().anchors?.returned, 1)
  run.provider.stop()
})

test('the same anchor object coming back displaced after a loss is a step, short loss or long: one epoch, the step\'s, and the anchor is rebased', async (t) => {
  for (const frameMs of [16, 600]) {
    const run = await started(t)
    const placed = await place(run, poseAt(1, 0, 2))
    run.world.loseTracking(2, 'same')
    run.world.tick({ dtMs: frameMs })
    run.world.tick({ dtMs: frameMs })
    assert.equal(run.provider.getFrameEpoch(), 0, `${frameMs} ms frames: the loss is not an epoch`)
    placed.anchor.moveTo(poseAt(1.4, 0, 2))
    run.world.tick({ dtMs: frameMs })
    assert.deepEqual(run.events.map((e) => [e.epoch, e.cause, e.anchor?.what]), [[1, 'anchor', 'moved']], `${frameMs} ms frames: it came back 40 cm from where it was`)
    assert.ok(near(run.events[0].translationM, 0.4))
    const d = run.provider.getTrackingDiagnostics()
    assert.deepEqual([d.poseJumps, d.anchors?.returned, d.anchors?.folded], [1, 1, 0], 'only the step was measured, and the return after it adds nothing')
    assert.equal(run.provider.anchors?.anchorDisplacement(placed.handle)?.translationM, 0, 'rebased: counted from where it came back')
    run.provider.stop()
  }
})

test('new objects come back instead of the old ones: the handle is given up after the window and that is one epoch, suspect; and the Place can be given a new anchor', async (t) => {
  const run = await started(t)
  const { handle, anchor } = await place(run, poseAt(1, 0, 2))
  const anchors = run.provider.anchors
  assert.ok(anchors)

  run.world.loseTracking(2, 'new')
  run.world.tick()
  run.world.tick()
  run.world.tick()
  assert.equal(anchor.orphan, true)
  assert.equal(anchors.anchorPose(handle), null, 'the old object is not in the set, and its stale pose is not where the anchor is')
  assert.equal(run.provider.getFrameEpoch(), 0, 'not yet: it may still come back')

  for (let i = 0; i < 3; i++) run.world.tick({ dtMs: ANCHOR_RETURN_WINDOW_MS / 3 })
  const counts = run.provider.getTrackingDiagnostics().anchors
  assert.deepEqual([counts?.lost, counts?.returned, counts?.expired], [1, 0, 1], 'not back in time: re-place')
  assert.ok(run.logs.some((line) => line.startsWith(`[webxr] anchor ${handle.id} not located again in `) && line.endsWith(' ms: given up')), `the handle is given up: ${run.logs.join(' | ')}`)
  assert.equal(anchors.anchorPose(handle), null)
  assert.equal(run.provider.getFrameEpoch(), 1, 'and with nothing else to account for the loss, that is an epoch')
  assert.equal(run.events[0].cause, 'anchor')
  assert.equal(run.events[0].anchor?.what, 'expired')
  assert.equal(run.events[0].anchor?.how, 'left-set')
  assert.equal(run.events[0].translationM, undefined, 'nothing was measured')
  assert.equal(run.provider.getTrackingDiagnostics().poseJumps, 0)

  const again = await place(run, poseAt(1, 0, 2))
  assert.notEqual(again.handle.id, handle.id)
  assert.deepEqual(anchors.anchorPose(again.handle)?.position, { x: 1, y: 0, z: 2 })
  assert.equal(run.provider.getFrameEpoch(), 1)
  run.provider.stop()
})

test('the same loss with no anchors says nothing: it is the anchor that tells the provider, because nothing else did', async (t) => {
  const run = await started(t, noAnchors())
  run.world.tick()
  run.world.loseTracking(3, 'same')
  for (let i = 0; i < 5; i++) run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 0)
  run.provider.stop()
})

// ─── A null pose ───────────────────────────────────────────────────────────

test('an anchor listed with no pose is a blip, and one that is not placed again in the window is given up with that as how it went', async (t) => {
  const run = await started(t)
  const { handle, anchor } = await place(run, poseAt(1, 0, 2))
  anchor.state = 'paused'
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 0)
  assert.equal(run.provider.anchors?.anchorPose(handle), null)
  assert.ok(run.logs.includes(`[webxr] anchor ${handle.id} not located (no-pose)`))
  run.world.tick()
  anchor.state = 'tracking'
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 0, 'placed again where it was')
  assert.deepEqual(run.provider.anchors?.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 })
  assert.equal(run.provider.getTrackingDiagnostics().anchors?.returned, 1)

  anchor.state = 'paused'
  run.world.tick()
  for (let i = 0; i < 3; i++) run.world.tick({ dtMs: ANCHOR_RETURN_WINDOW_MS / 3 })
  assert.equal(run.provider.getFrameEpoch(), 1)
  assert.equal(run.events[0].anchor?.how, 'no-pose')
  assert.equal(run.events[0].anchor?.what, 'expired')
  run.provider.stop()
})

test('a viewer pose that goes emulated for 1.5 s and an anchor that goes null with it are one epoch, the viewer\'s recovery, and the anchor that comes back adds none', async (t) => {
  const run = await started(t)
  const { anchor } = await place(run, poseAt(1, 0, 2))
  run.world.tick()
  anchor.state = 'paused'
  run.world.tick({ viewerPose: 'emulated' })
  run.world.tick({ viewerPose: 'emulated' })
  anchor.state = 'tracking'
  run.world.tick({ dtMs: 1_500 })
  assert.equal(run.provider.getFrameEpoch(), 1)
  assert.equal(run.events[0].cause, 'recovered', 'the viewer\'s own rule began it: a stretch of 1.5 s is no blip')
  assert.equal(run.provider.getTrackingDiagnostics().anchors?.returned, 1)
  run.provider.stop()
})

// ─── One tracking loss is the same number of epochs with an anchor as without ─

/** One tracking loss, played on a world with an anchor held (it goes null when tracking goes) or with none. Returns the epochs the provider announced. */
async function trackingLoss(t: Context, withAnchor: boolean, kind: 'relocalised' | 'reset' | 'anchor-first' | 'blip'): Promise<{ epochs: number; causes: string[] }> {
  const run = await started(t, withAnchor ? new ChromeWorld() : noAnchors())
  onFrameClock(t, run)
  const anchor = withAnchor ? (await place(run, poseAt(1, 0, 2))).anchor : null
  const away = (state: 'tracking' | 'paused'): void => {
    if (anchor) anchor.state = state
  }
  run.world.tick()
  const lostFrames = kind === 'blip' ? 3 : 30
  if (kind === 'anchor-first') {
    away('paused')
    run.world.tick()
  }
  if (kind !== 'anchor-first') away('paused')
  for (let i = 0; i < lostFrames; i++) run.world.tick({ viewerPose: 'emulated', dtMs: kind === 'blip' ? 16 : 50 })
  if (kind === 'reset') run.world.reset({ position: { x: 0.4, y: 0, z: 0 }, orientation: IDENTITY })
  away('tracking')
  if (kind === 'relocalised' || kind === 'reset') run.world.shiftFrame({ x: -0.4, y: 0, z: 0 })
  run.world.tick({ dtMs: 16 })
  run.world.tick({ dtMs: 16 })
  const result = { epochs: run.provider.getFrameEpoch(), causes: run.events.map((e) => e.cause) }
  run.provider.stop()
  return result
}

test('one tracking loss is the same number of epochs with an anchor held and without: a plain relocalisation, a relocalisation the runtime announces with a reset, an anchor that went a frame before the viewer, and a blip', async (t) => {
  for (const kind of ['relocalised', 'reset', 'anchor-first', 'blip'] as const) {
    const without = await trackingLoss(t, false, kind)
    const withOne = await trackingLoss(t, true, kind)
    assert.equal(withOne.epochs, without.epochs, `${kind}: without an anchor ${JSON.stringify(without)}, with one ${JSON.stringify(withOne)}`)
    assert.equal(without.epochs, kind === 'blip' ? 0 : 1, kind)
  }
})

test('twelve tracking blips in two minutes are no epoch with an anchor held, as they are none without one', async (t) => {
  for (const withAnchor of [false, true]) {
    const run = await started(t, withAnchor ? new ChromeWorld() : noAnchors())
    const anchor = withAnchor ? (await place(run, poseAt(1, 0, 2))).anchor : null
    for (let i = 0; i < 30 * 120; i++) {
      const blip = i % (10 * 30) < 3
      if (anchor) anchor.state = blip ? 'paused' : 'tracking'
      run.world.tick({ dtMs: i % 3 === 0 ? 34 : 33, viewerPose: blip ? 'emulated' : 'tracked' })
    }
    assert.equal(run.provider.getFrameEpoch(), 0, withAnchor ? 'with an anchor' : 'without')
    if (withAnchor) assert.equal(run.provider.getTrackingDiagnostics().anchors?.lost, 12, 'each blip was a loss, and was counted')
    run.provider.stop()
  }
})

test('an anchor that is null for one frame and back in place the next is a blip', async (t) => {
  const run = await started(t)
  const { anchor } = await place(run, poseAt(1, 0, 2))
  run.world.tick()
  anchor.state = 'paused'
  run.world.tick()
  anchor.state = 'tracking'
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 0)
  const d = run.provider.getTrackingDiagnostics()
  assert.deepEqual([d.anchors?.lost, d.anchors?.returned], [1, 1])
  run.provider.stop()
})

// ─── reset, hidden and a second session ────────────────────────────────────

test('a reset with no transform is one epoch with no numbers, and a reset with one carries it; the anchors that move with the new origin are part of it', async (t) => {
  const bare = await started(t)
  await place(bare, poseAt(1, 0, 2))
  bare.world.reset(null)
  assert.equal(bare.provider.getFrameEpoch(), 1)
  assert.equal(bare.events[0].cause, 'reset')
  assert.equal(bare.events[0].transform, null)
  bare.world.tick()
  assert.equal(bare.provider.getFrameEpoch(), 1, 'the anchor did not move, and nothing else began one')
  bare.provider.stop()

  const given = await started(t)
  const { handle } = await place(given, poseAt(1, 0, 2))
  const transform = { position: { x: 0.4, y: 0, z: 0 }, orientation: IDENTITY }
  given.world.reset(transform)
  given.world.shiftFrame({ x: -0.4, y: 0, z: 0 })
  given.world.tick()
  assert.equal(given.provider.getFrameEpoch(), 1, 'the runtime said the origin moved, and then the anchor said it did: one move')
  assert.equal(given.events[0].cause, 'reset')
  assert.deepEqual(given.events[0].transform, transform)
  assert.deepEqual(epochsHeard(given), [1])
  const d = given.provider.getTrackingDiagnostics()
  assert.equal(d.anchors?.folded, 1)
  assert.equal(d.suppressedJumps, 0)
  assert.equal(d.poseJumps, 1, 'the runtime reported it, and the anchor saw the same move')
  assert.equal(given.provider.anchors?.anchorDisplacement(handle)?.translationM, 0, 'and the anchor was rebased to the new origin')
  given.provider.stop()
})

test('a session hidden and shown again is a resume, an anchor that comes back displaced in its first frame gives the resume its size, and nothing is read while it is hidden', async (t) => {
  const run = await started(t)
  onFrameClock(t, run)
  const { anchor } = await place(run, poseAt(1, 0, 2))
  run.world.setVisibility('hidden')
  assert.throws(() => run.world.tick(), /a hidden session gets no frames/)
  assert.equal(run.provider.getFrameEpoch(), 0)
  run.world.setVisibility('visible')
  assert.equal(run.provider.getFrameEpoch(), 1)
  assert.equal(run.events[0].cause, 'resumed')
  assert.equal(run.events[0].translationM, undefined, 'a resume cannot say how far the frame moved')
  anchor.moveTo(poseAt(1.3, 0, 2))
  run.world.tick()
  assert.equal(run.provider.getFrameEpoch(), 1, 'it came back displaced, in the first frame after the resume')
  assert.deepEqual(epochsHeard(run), [1])
  const sized = run.events[run.events.length - 1]
  assert.equal(sized.cause, 'resumed')
  assert.ok(near(sized.translationM, 0.3), `the step is the size of the resume: ${sized.translationM}`)
  assert.equal(sized.anchor?.what, 'moved')
  const d = run.provider.getTrackingDiagnostics()
  assert.equal(d.poseJumps, 1, 'and it counts as the frame shift it is')
  assert.ok(near(d.lastJumpM, 0.3))
  assert.deepEqual([d.anchors?.folded, d.suppressedJumps], [1, 0])
  run.provider.stop()
})

// ─── One trip away is one epoch ────────────────────────────────────────────

test('one trip away is one epoch: a resume, 1.5 s of relocalising with the anchor not located, and the anchor back 40 cm off in the first good frame, where its step is the resume\'s size', async (t) => {
  const run = await started(t)
  onFrameClock(t, run)
  const { anchor, handle } = await place(run, poseAt(1, 0, 2))
  run.world.setVisibility('hidden')
  run.world.setVisibility('visible')
  anchor.state = 'paused'
  for (let i = 0; i < 30; i++) run.world.tick({ viewerPose: 'emulated', dtMs: 50 })
  assert.equal(run.provider.getFrameEpoch(), 1, 'the resume is the epoch, and the anchor that went during it adds none')
  anchor.state = 'tracking'
  anchor.moveTo(poseAt(1.4, 0, 2))
  run.world.tick({ dtMs: 50 })

  assert.equal(run.provider.getFrameEpoch(), 1)
  assert.deepEqual(epochsHeard(run), [1], 'one epoch, announced again with its size')
  const sized = run.events[run.events.length - 1]
  assert.equal(sized.cause, 'resumed')
  assert.ok(near(sized.translationM, 0.4))
  assert.equal(sized.anchor?.what, 'moved')
  const d = run.provider.getTrackingDiagnostics()
  assert.deepEqual([d.epoch, d.poseJumps, d.suppressedJumps, d.anchors?.lost, d.anchors?.returned, d.anchors?.folded], [1, 1, 0, 1, 1, 1])
  assert.equal(run.provider.anchors?.anchorDisplacement(handle)?.translationM, 0, 'and the anchor is rebased to where it came back')
  run.provider.stop()
})

test('the same trip with a reset the runtime announces when it begins: one epoch, the runtime\'s own numbers, and the anchor\'s step joins it', async (t) => {
  const run = await started(t)
  onFrameClock(t, run)
  const { anchor } = await place(run, poseAt(1, 0, 2))
  run.world.tick({ viewerPose: 'emulated' })
  const transform = { position: { x: 0.45, y: 0, z: 0 }, orientation: IDENTITY }
  run.world.reset(transform)
  anchor.state = 'paused'
  for (let i = 0; i < 30; i++) run.world.tick({ viewerPose: 'emulated', dtMs: 50 })
  anchor.state = 'tracking'
  run.world.shiftFrame({ x: -0.4, y: 0, z: 0 })
  run.world.tick({ dtMs: 50 })
  assert.equal(run.provider.getFrameEpoch(), 1)
  assert.deepEqual(epochsHeard(run), [1])
  const last = run.events[run.events.length - 1]
  assert.equal(last.cause, 'reset')
  assert.deepEqual(last.transform, transform)
  assert.ok(near(last.translationM, 0.45), 'the runtime\'s own description is the size, not the anchor\'s')
  assert.equal(last.anchor, undefined)
  const d = run.provider.getTrackingDiagnostics()
  assert.deepEqual([d.poseJumps, d.anchors?.folded, d.suppressedJumps], [1, 1, 0])
  run.provider.stop()
})

test('an anchor that is back a few frames after the first good pose is still that trip\'s, and its size; one that is back long after is counted in it and gives it none', async (t) => {
  const late = await started(t)
  onFrameClock(t, late)
  const first = await place(late, poseAt(1, 0, 2))
  late.world.setVisibility('hidden')
  late.world.setVisibility('visible')
  first.anchor.state = 'paused'
  for (let i = 0; i < 30; i++) late.world.tick({ viewerPose: 'emulated', dtMs: 50 })
  late.world.tick({ dtMs: 16 })
  late.world.tick({ dtMs: 16 })
  first.anchor.state = 'tracking'
  first.anchor.moveTo(poseAt(1.4, 0, 2))
  late.world.tick({ dtMs: 16 })
  assert.equal(late.provider.getFrameEpoch(), 1)
  assert.ok(near(late.events[late.events.length - 1].translationM, 0.4), 'three frames after the first good one, inside the half second')
  late.provider.stop()

  const slow = await started(t)
  onFrameClock(t, slow)
  const second = await place(slow, poseAt(1, 0, 2))
  slow.world.setVisibility('hidden')
  slow.world.setVisibility('visible')
  second.anchor.state = 'paused'
  for (let i = 0; i < 30; i++) slow.world.tick({ viewerPose: 'emulated', dtMs: 50 })
  // The first good pose closes the trip, and the anchor is still not located two seconds later.
  for (let i = 0; i < 40; i++) slow.world.tick({ dtMs: 50 })
  second.anchor.state = 'tracking'
  second.anchor.moveTo(poseAt(1.4, 0, 2))
  slow.world.tick({ dtMs: 16 })
  assert.equal(slow.provider.getFrameEpoch(), 1, 'it went during the trip, so the trip accounts for it however long it was away')
  const d = slow.provider.getTrackingDiagnostics()
  assert.deepEqual([d.poseJumps, d.anchors?.folded], [0, 1], 'but the half second was over, so the trip is left as it was')
  assert.equal(slow.events[slow.events.length - 1].translationM, undefined)
  slow.provider.stop()
})

test('a reset after an anchor has sized the trip is still counted, logged and announced: it is the runtime\'s report, and an anchor does not change what a disturbance looks like', async (t) => {
  const run = await started(t)
  onFrameClock(t, run)
  const { anchor } = await place(run, poseAt(1, 0, 2))
  run.world.setVisibility('hidden')
  run.world.setVisibility('visible')
  anchor.moveTo(poseAt(1.4, 0, 2))
  // The viewer has no pose yet (the spec lets getViewerPose answer null while tracking is being established), and the anchor is read.
  run.world.tick({ viewerPose: 'none' })
  assert.equal(run.events[run.events.length - 1].cause, 'resumed')
  assert.ok(near(run.events[run.events.length - 1].translationM, 0.4), 'the anchor gave the resume its size')

  run.world.reset(null)
  const last = run.events[run.events.length - 1]
  assert.equal(last.epoch, 1)
  assert.equal(last.cause, 'reset')
  assert.equal(last.transform, null)
  assert.ok(near(last.translationM, 0.4))
  assert.ok(run.warnings.some((line) => line.startsWith('[webxr] frame discontinuity 1: reset')), `a device run counts resets from this line: ${run.warnings.join(' | ')}`)
  assert.deepEqual([run.provider.getFrameEpoch(), run.provider.getTrackingDiagnostics().poseJumps], [1, 1])
  run.provider.stop()
})

// ─── Drift, counted afresh by every epoch ──────────────────────────────────

test('an epoch the anchors did not share starts their drift count again too: the viewer relocalises, the room did not move, and the next centimetre is not read from the old baseline', async (t) => {
  const run = await started(t)
  await place(run, poseAt(1, 0, 2))
  for (let i = 0; i < 12; i++) {
    run.world.shiftFrame({ x: -0.01, y: 0, z: 0 })
    run.world.viewer.origin = { ...run.world.viewer.origin, x: run.world.viewer.origin.x - 0.01 }
    run.world.tick({ dtMs: 200 })
  }
  const before = run.provider.getTrackingDiagnostics().anchors
  assert.equal(before?.driftFlagged, true, '12 cm of creep, a centimetre a step')
  assert.equal(run.provider.getFrameEpoch(), 0)

  // The camera relocalises 1.2 m: an epoch the anchors did not see, since the room did not move.
  run.world.viewer.origin = { ...run.world.viewer.origin, x: run.world.viewer.origin.x - 1.2 }
  for (let i = 0; i < 40; i++) run.world.tick({ dtMs: 16 })
  assert.equal(run.provider.getFrameEpoch(), 1)
  assert.equal(run.events[0].cause, 'jump')
  const after = run.provider.getTrackingDiagnostics().anchors
  assert.deepEqual([after?.driftFlagged, after?.maxDriftM], [false, 0], 'a new epoch starts the count again')

  run.world.shiftFrame({ x: -0.01, y: 0, z: 0 })
  run.world.tick({ dtMs: 16 })
  const next = run.provider.getTrackingDiagnostics().anchors
  assert.ok(near(next?.maxDriftM, 0.01, 1e-9), `drift is counted from the epoch, not from where the anchor was first located: ${next?.maxDriftM}`)
  assert.equal(next?.driftFlagged, false)
  run.provider.stop()
})

// ─── Hidden time is not lost time ──────────────────────────────────────────

test('time the session spends hidden does not count against an anchor that was already away: it is given up only if it is still away after the window, in frames', async (t) => {
  const run = await started(t)
  onFrameClock(t, run)
  const { anchor, handle } = await place(run, poseAt(1, 0, 2))
  run.world.tick()
  anchor.state = 'paused'
  run.world.tick()
  run.world.setVisibility('hidden')
  run.world.time += 30_000
  run.world.setVisibility('visible')
  run.world.tick({ viewerPose: 'emulated', dtMs: 16 })
  anchor.state = 'tracking'
  run.world.tick({ dtMs: 50 })
  assert.deepEqual(run.provider.anchors?.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 }, 'located again 50 ms after the first frame back: the same handle')
  const d = run.provider.getTrackingDiagnostics().anchors
  assert.deepEqual([d?.returned, d?.expired], [1, 0])
  assert.ok(run.logs.some((line) => line.startsWith(`[webxr] anchor ${handle.id} located again after 3`)), `what it reports it was away for is the whole of it: ${run.logs.join(' | ')}`)
  run.provider.stop()
})

test('a session that was blurred and not hidden is not excused: only a return from hidden says that no frame could have located the anchor', async (t) => {
  const run = await started(t)
  onFrameClock(t, run)
  const { anchor, handle } = await place(run, poseAt(1, 0, 2))
  run.world.tick()
  anchor.state = 'paused'
  run.world.tick()
  run.world.setVisibility('visible-blurred')
  run.world.time += 30_000
  run.world.setVisibility('visible')
  run.world.tick({ viewerPose: 'emulated', dtMs: 16 })
  assert.equal(run.provider.getTrackingDiagnostics().anchors?.expired, 1)
  assert.equal(run.provider.anchors?.anchorPose(handle), null)
  run.provider.stop()
})

// ─── A second session ──────────────────────────────────────────────────────

test('a session that is stopped and started again has new anchors and its own first epoch; what the old one held does not speak for the new', async (t) => {
  const run = await started(t)
  const first = await place(run, poseAt(1, 0, 2))
  const old = run.provider.anchors
  assert.ok(old)
  run.provider.stop()
  assert.equal(run.provider.anchors, undefined)
  assert.equal(first.anchor.deleted, true, 'the first session\'s anchors were let go')

  const world = run.world
  world.syncClockToPage()
  installNavigator(world.session())
  await run.provider.start(canvasWithGl())
  assert.ok(run.provider.anchors && run.provider.anchors !== old)
  world.tick()
  assert.equal(run.provider.getFrameEpoch(), 1, 'a new session is a new map: its first frame starts an epoch')
  const second = await place({ ...run, world }, poseAt(1, 0, 2))
  assert.equal(second.handle.id, first.handle.id, 'ids start again in a new session')
  assert.notEqual(second.handle, first.handle)
  world.shiftFrame({ x: -0.25, y: 0, z: 0 })
  world.tick({ dtMs: 1_000 })
  assert.equal(run.provider.getFrameEpoch(), 2)
  assert.equal(run.events[run.events.length - 1].anchor?.what, 'moved')
  run.provider.stop()
})
