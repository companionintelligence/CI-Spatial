/**
 * WP-17b: an anchor the runtime stops locating is lost at once and kept for a while (src/ar/anchors.ts, ANCHOR_RETURN_WINDOW_MS).
 *
 * On Chrome an empty `trackedAnchors` during a tracking loss does not mean the anchor was deleted for ever, and a null pose is what a
 * paused anchor reads as (r3-anchors-notes.md section 4, read in Chromium's sources). So a loss is reported when it happens; the handle
 * stays valid; the anchor coming back, as the same object, is reported; and one that does not come back in the window is given up, and
 * whoever depended on it places a new one. The window does not run while the session is hidden, and a rebase for the start of an epoch
 * leaves an anchor that is away alone. Whether a loss is an epoch is the tracker's to say (wp-17b-anchor-epoch-tracker.test.ts). This is
 * the capability on its own, over the Chrome stand-in (support/chrome-xr-session.ts) with no provider in the way;
 * wp-17b-chrome-anchors.test.ts runs it through the provider.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-17b-anchor-return-window.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_RETURN_WINDOW_MS,
  WebXRAnchors,
  type AnchorExpiredEvent,
  type AnchorHandle,
  type AnchorLostEvent,
  type AnchorMovedEvent,
  type AnchorReturnedEvent,
} from '../../../src/ar/anchors.ts'
import { ChromeWorld, installBrowserGlobals, poseAt, type ChromeAnchor, type FrameOptions, type PoseData } from './support/chrome-xr-session.ts'

installBrowserGlobals()

const near = (actual: number, expected: number, within = 1e-9): boolean => Math.abs(actual - expected) <= within

/** The capability over a Chrome stand-in, driven one frame at a time with no provider or three.js in the way. */
function setUp(world: ChromeWorld, options: ConstructorParameters<typeof WebXRAnchors>[1] = {}) {
  const anchors = new WebXRAnchors(world.session(), options)
  const log: string[] = []
  const lost: AnchorLostEvent[] = []
  const returned: AnchorReturnedEvent[] = []
  const expired: AnchorExpiredEvent[] = []
  const moved: AnchorMovedEvent[] = []
  anchors.onLost((e) => {
    lost.push(e)
    log.push('lost')
  })
  anchors.onReturned((e) => {
    returned.push(e)
    log.push('returned')
  })
  anchors.onExpired((e) => {
    expired.push(e)
    log.push('expired')
  })
  anchors.onMoved((e) => {
    moved.push(e)
    log.push('moved')
  })
  return {
    anchors,
    log,
    lost,
    returned,
    expired,
    moved,
    frame(frameOptions: FrameOptions = {}): void {
      world.time += frameOptions.dtMs ?? 16
      const frame = world.frame(frameOptions)
      anchors.onFrame(frame, world.floor as unknown as XRSpace, world.time)
      frame.active = false
    },
  }
}

/** Makes one anchor and reads it once. An anchor takes three frames to be usable: one to ask, one for the runtime to settle it, one to read it. */
async function anchorAt(world: ChromeWorld, s: ReturnType<typeof setUp>, pose: PoseData): Promise<{ handle: AnchorHandle; anchor: ChromeAnchor }> {
  const asking = s.anchors.createAnchor(pose)
  s.frame()
  s.frame()
  const handle = await asking
  assert.ok(handle, 'the runtime made no anchor')
  s.frame()
  return { handle, anchor: world.everMade[world.everMade.length - 1] }
}

// ─── The window ────────────────────────────────────────────────────────────

test('the window is 15 s unless the options say otherwise: a handle is valid at 14 s and given up at 15', async () => {
  assert.equal(ANCHOR_RETURN_WINDOW_MS, 15_000)
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(1, 0, 2))

  world.loseTracking(1_000, 'same')
  s.frame()
  assert.equal(s.lost.length, 1)
  const lostAt = world.time
  s.frame({ dtMs: 14_000 })
  assert.equal(s.expired.length, 0, 'still inside the window')
  assert.equal(anchor.deleted, false)
  s.frame({ dtMs: 999 })
  assert.equal(world.time - lostAt, 14_999)
  assert.equal(s.expired.length, 0, 'a millisecond short')
  s.frame({ dtMs: 1 })
  assert.equal(s.expired.length, 1, 'a window of 15 s is over at 15 s')
  assert.equal(s.expired[0].handle, handle)
  assert.equal(s.expired[0].awayMs, 15_000)
})

test('a window given in the options replaces the default', async () => {
  const world = new ChromeWorld()
  const s = setUp(world, { returnWindowMs: 200 })
  const { anchor } = await anchorAt(world, s, poseAt(0, 0, 0))
  world.loseTracking(1_000, 'same')
  s.frame()
  s.frame({ dtMs: 150 })
  assert.equal(s.expired.length, 0)
  s.frame({ dtMs: 60 })
  assert.equal(s.expired.length, 1)
  assert.equal(anchor.deleted, true)
})

// ─── The tracked set is emptied ────────────────────────────────────────────

test('an empty tracked set is a loss at once, the handle stays, and the same object coming back is reported with how long it was away', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(1, 0, 2))
  assert.deepEqual(s.anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 })

  world.loseTracking(3, 'same')
  s.frame()
  assert.equal(s.lost.length, 1, 'reported in the first frame it is missing')
  assert.equal(s.lost[0].handle, handle)
  assert.equal(s.lost[0].how, 'left-set')
  assert.equal(s.lost[0].atMs, world.time)
  assert.equal(s.anchors.anchorPose(handle), null, 'not located: no pose, and the stale one is not kept')
  assert.equal(s.anchors.anchorDisplacement(handle), null)
  s.frame()
  s.frame()
  assert.equal(s.lost.length, 1, 'reported once')
  assert.equal(anchor.deleted, false, 'the runtime is not told to drop it: it may come back')

  s.frame()
  assert.equal(s.returned.length, 1)
  assert.equal(s.returned[0].handle, handle)
  assert.equal(s.returned[0].awayMs, 48, 'three empty frames and the one that brought it back, at 16 ms')
  assert.deepEqual(s.anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 }, 'the same handle reads again, where it was')
  assert.equal(s.moved.length, 0, 'it is back where it was, so it did not move')
  assert.equal(s.expired.length, 0)
  for (let i = 0; i < 4; i++) s.frame()
  assert.equal(s.lost.length, 1)
  assert.equal(s.returned.length, 1)
})

test('the same object back in a different place is a move first and a return second, and the move is measured from where it was before the loss', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(1, 0, 2))
  world.loseTracking(2, 'same')
  s.frame()
  s.frame()
  anchor.moveTo(poseAt(1.4, 0, 2))
  s.frame()
  assert.deepEqual(s.log, ['lost', 'moved', 'returned'], 'whoever hears both sees the move before the return')
  assert.ok(near(s.moved[0].step.translationM, 0.4))
  assert.ok(near(s.moved[0].total.translationM, 0.4))
  assert.deepEqual(s.anchors.anchorPose(handle)?.position, { x: 1.4, y: 0, z: 2 })
})

test('new objects come back instead: the old handle is given up after the window, the new objects are not adopted, and the stale pose of the old one is never read', async () => {
  const world = new ChromeWorld()
  const s = setUp(world, { returnWindowMs: 500 })
  const { handle, anchor } = await anchorAt(world, s, poseAt(1, 0, 2))
  world.loseTracking(2, 'new')
  s.frame()
  s.frame()
  s.frame()
  const fresh = world.successors.get(anchor)
  assert.ok(fresh && fresh !== anchor, 'the runtime made a new object for the anchor')
  assert.equal(anchor.orphan, true)
  assert.deepEqual(anchor.native.position, { x: 1, y: 0, z: 2 }, 'the old object would still answer, with the pose it last had')
  assert.equal(s.anchors.anchorPose(handle), null, 'but it is not in the tracked set, so that answer is not where the anchor is')
  assert.equal(s.returned.length, 0, 'nothing says the new object is the old anchor')
  assert.equal(s.lost.length, 1)

  s.frame({ dtMs: 600 })
  assert.equal(s.expired.length, 1)
  assert.equal(s.expired[0].handle, handle)
  assert.equal(world.deleteCalls.includes(anchor), true, 'the object the app held is let go')
  assert.equal(world.deleteCalls.includes(fresh), false, 'an object the app cannot tell from any other is left alone')
  assert.equal(s.anchors.anchorPose(handle), null)
  s.frame()
  assert.equal(s.returned.length, 0)
  assert.equal(s.lost.length, 1)
})

test('after a handle is given up the Place can be given a new anchor: the request is made, answered, and read', async () => {
  const world = new ChromeWorld()
  const s = setUp(world, { returnWindowMs: 100 })
  const first = await anchorAt(world, s, poseAt(1, 0, 2))
  world.loseTracking(1, 'new')
  s.frame()
  s.frame({ dtMs: 200 })
  assert.equal(s.expired.length, 1)

  const second = await anchorAt(world, s, poseAt(1, 0, 2))
  assert.notEqual(second.handle, first.handle)
  assert.notEqual(second.handle.id, first.handle.id)
  assert.deepEqual(s.anchors.anchorPose(second.handle)?.position, { x: 1, y: 0, z: 2 })
  assert.equal(s.expired.length, 1)
})

// ─── A paused anchor ───────────────────────────────────────────────────────

test('a listed anchor with no pose is lost as "no-pose", its handle stays, and it is reported when it can be placed again', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(0.5, 0, -1))

  anchor.state = 'paused'
  s.frame()
  assert.equal(s.lost.length, 1)
  assert.equal(s.lost[0].how, 'no-pose')
  assert.equal(s.anchors.anchorPose(handle), null)
  s.frame()
  assert.equal(s.lost.length, 1, 'once')

  anchor.state = 'tracking'
  s.frame()
  assert.equal(s.returned.length, 1)
  assert.deepEqual(s.anchors.anchorPose(handle)?.position, { x: 0.5, y: 0, z: -1 })
  assert.equal(s.moved.length, 0)
})

test('a paused anchor that is not placed again in the window is given up, and then the runtime is told to drop it', async () => {
  const world = new ChromeWorld()
  const s = setUp(world, { returnWindowMs: 300 })
  const { handle, anchor } = await anchorAt(world, s, poseAt(0, 0, 0))
  anchor.state = 'paused'
  s.frame()
  s.frame({ dtMs: 250 })
  assert.equal(s.expired.length, 0)
  assert.equal(anchor.deleted, false)
  s.frame({ dtMs: 60 })
  assert.equal(s.expired.length, 1)
  assert.equal(anchor.deleted, true)
  anchor.state = 'tracking'
  s.frame()
  assert.equal(s.returned.length, 0, 'it was given up first')
  assert.equal(s.anchors.anchorPose(handle), null)
})

test('an anchor that has not been placed yet is not lost: a null pose before the first sighting is "not yet"', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const asking = s.anchors.createAnchor(poseAt(0, 0, 0))
  s.frame()
  s.frame()
  const made = world.live[0]
  assert.ok(made, 'the runtime made the anchor in the second frame')
  made.state = 'paused'
  const handle = await asking
  assert.ok(handle)
  s.frame()
  s.frame()
  assert.deepEqual(s.lost, [], 'it never had a place to lose')
  made.state = 'tracking'
  s.frame()
  assert.deepEqual(s.anchors.anchorPose(handle)?.position, { x: 0, y: 0, z: 0 })
  assert.deepEqual(s.returned, [], 'and so it did not come back from anywhere')
  assert.deepEqual(s.moved, [])
})

test('an anchor that goes away one way and comes back another is one loss, reported by the way it first went', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(0, 0, 0))
  world.loseTracking(1, 'same')
  anchor.state = 'paused'
  s.frame()
  assert.equal(s.lost[0].how, 'left-set')
  s.frame()
  s.frame()
  assert.equal(s.lost.length, 1, 'listed again with no pose: still the same absence')
  anchor.state = 'tracking'
  s.frame()
  assert.equal(s.returned.length, 1)
  assert.ok(s.anchors.anchorPose(handle))
})

// ─── Several anchors, and the ways out ─────────────────────────────────────

test('each anchor is lost, returned and given up on its own account', async () => {
  const world = new ChromeWorld()
  const s = setUp(world, { returnWindowMs: 500 })
  const first = await anchorAt(world, s, poseAt(0, 0, 0))
  const second = await anchorAt(world, s, poseAt(3, 0, 0))
  first.anchor.state = 'paused'
  second.anchor.state = 'paused'
  s.frame()
  assert.deepEqual(s.lost.map((e) => e.handle), [first.handle, second.handle])

  first.anchor.state = 'tracking'
  s.frame({ dtMs: 100 })
  assert.deepEqual(s.returned.map((e) => e.handle), [first.handle])
  s.frame({ dtMs: 450 })
  assert.deepEqual(s.expired.map((e) => e.handle), [second.handle])
  assert.ok(s.anchors.anchorPose(first.handle), 'the one that came back is untouched')
  assert.equal(first.anchor.deleted, false)
})

test('giving a lost anchor back, or ending the session, while it is away is silent', async () => {
  const world = new ChromeWorld()
  const s = setUp(world, { returnWindowMs: 100 })
  const first = await anchorAt(world, s, poseAt(0, 0, 0))
  const second = await anchorAt(world, s, poseAt(2, 0, 0))
  first.anchor.state = 'paused'
  second.anchor.state = 'paused'
  s.frame()
  assert.equal(s.lost.length, 2)

  s.anchors.release(first.handle)
  assert.equal(first.anchor.deleted, true)
  s.anchors.dispose()
  assert.equal(second.anchor.deleted, true)
  s.frame({ dtMs: 500 })
  assert.deepEqual([s.returned.length, s.expired.length], [0, 0], 'nothing is said about what the app gave back or what ended with its session')
})

test('rebasing an anchor that is away makes its return the new start, so a return that moved is not reported as a move', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(1, 0, 1))
  anchor.state = 'paused'
  s.frame()
  s.anchors.rebase(handle)
  anchor.moveTo(poseAt(1.5, 0, 1))
  anchor.state = 'tracking'
  s.frame()
  assert.deepEqual(s.moved, [])
  assert.equal(s.returned.length, 1)
  assert.equal(s.anchors.anchorDisplacement(handle)?.translationM, 0)
})

test('a frame that comes while the anchor is away costs no more than reading the set, and a runtime with no tracked set still turns the capability off', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { anchor } = await anchorAt(world, s, poseAt(0, 0, 0))
  anchor.state = 'paused'
  s.frame()
  const reads = world.trackedReads
  s.frame()
  assert.equal(world.trackedReads, reads + 1, 'one read of the set per frame, while an anchor is away and has to be watched')
  const frame = world.frame()
  delete (frame as { trackedAnchors?: unknown }).trackedAnchors
  Object.defineProperty(frame, 'trackedAnchors', { get: () => undefined })
  s.anchors.onFrame(frame, world.floor as unknown as XRSpace, world.time + 16)
  assert.equal(s.anchors.usable, false)
})

// ─── Hidden time is not lost time ──────────────────────────────────────────

test('time the session spends hidden does not count against the window: an anchor lost before an app switch is still valid on the first frame back, and the whole of its absence is what it reports', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { handle, anchor } = await anchorAt(world, s, poseAt(1, 0, 2))
  anchor.state = 'paused'
  s.frame()
  const lostAt = world.time

  world.time += 30_000
  s.anchors.noteResumed()
  s.frame()
  assert.equal(s.expired.length, 0, 'no frame could have located it while the session was hidden')
  assert.equal(s.anchors.anchorPose(handle), null, 'still not located, and still its handle')

  anchor.state = 'tracking'
  s.frame({ dtMs: 50 })
  assert.equal(s.returned.length, 1)
  assert.equal(s.returned[0].awayMs, world.time - lostAt, 'what it reports is how long it was not located, hidden time included')
  assert.ok(s.returned[0].awayMs > 30_000)
  assert.deepEqual(s.anchors.anchorPose(handle)?.position, { x: 1, y: 0, z: 2 })
})

test('the window runs again once the session is shown: an anchor still away after 15 s of frames is given up, with the whole of its absence reported', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { anchor } = await anchorAt(world, s, poseAt(1, 0, 2))
  anchor.state = 'paused'
  s.frame()
  const lostAt = world.time
  world.time += 30_000
  s.anchors.noteResumed()
  s.frame()
  s.frame({ dtMs: 14_000 })
  assert.equal(s.expired.length, 0, 'a millisecond short of the window, in frames')
  s.frame({ dtMs: 1_000 })
  assert.equal(s.expired.length, 1)
  assert.equal(s.expired[0].awayMs, world.time - lostAt, 'truthful: hidden time included')
  assert.ok(s.expired[0].awayMs > 45_000)
})

test('only a gap that a hidden session explains is excused: a long frame with no resume in front of it counts in full, and the excuse is spent by one frame', async () => {
  const late = new ChromeWorld()
  const a = setUp(late)
  const first = await anchorAt(late, a, poseAt(1, 0, 2))
  first.anchor.state = 'paused'
  a.frame()
  a.frame({ dtMs: 15_000 })
  assert.equal(a.expired.length, 1, 'a late frame is not an explanation')

  const resumed = new ChromeWorld()
  const b = setUp(resumed, { returnWindowMs: 1_000 })
  const second = await anchorAt(resumed, b, poseAt(1, 0, 2))
  second.anchor.state = 'paused'
  b.frame()
  resumed.time += 30_000
  b.anchors.noteResumed()
  b.frame()
  assert.equal(b.expired.length, 0)
  b.frame({ dtMs: 30_000 })
  assert.equal(b.expired.length, 1, 'one resume excuses one gap: the next long frame is a late one')
})

test('an anchor that goes missing in the first frame after the session is shown again gets a whole window', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { anchor } = await anchorAt(world, s, poseAt(1, 0, 2))
  world.time += 60_000
  s.anchors.noteResumed()
  anchor.state = 'paused'
  s.frame()
  assert.equal(s.lost.length, 1)
  s.frame({ dtMs: 14_000 })
  assert.equal(s.expired.length, 0, 'the 60 s it was hidden are nothing to it')
  s.frame({ dtMs: 1_000 })
  assert.equal(s.expired.length, 1)
})

// ─── Rebasing for the start of an epoch ────────────────────────────────────

test('rebaseLocated starts every located anchor\'s count from where it is, and leaves an anchor that is away alone, so its return is still seen as the move it made', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const here = await anchorAt(world, s, poseAt(1, 0, 1))
  const gone = await anchorAt(world, s, poseAt(3, 0, 1))
  here.anchor.moveTo(poseAt(1.03, 0, 1))
  s.frame()
  assert.ok(near(s.anchors.anchorDisplacement(here.handle)?.translationM ?? 0, 0.03), 'drifted three centimetres')
  gone.anchor.state = 'paused'
  s.frame()
  assert.equal(s.lost.length, 1)

  s.anchors.rebaseLocated()
  assert.equal(s.anchors.anchorDisplacement(here.handle)?.translationM, 0, 'counted from here now')
  const moves = s.moved.length
  gone.anchor.moveTo(poseAt(3.4, 0, 1))
  gone.anchor.state = 'tracking'
  s.frame()
  assert.equal(s.moved.length, moves + 1, 'the anchor that was away still reports where it came back')
  assert.ok(near(s.moved[moves].step.translationM, 0.4))
  assert.ok(near(s.moved[moves].total.translationM, 0.4), 'from where it was before it went')
})

test('rebaseLocated restarts the report threshold as well: a creep that was under it before is under it again from here', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  const { anchor, handle } = await anchorAt(world, s, poseAt(1, 0, 1))
  anchor.moveTo(poseAt(1.006, 0, 1))
  s.frame()
  assert.equal(s.moved.length, 0, '6 mm is under the centimetre that is reported')
  s.anchors.rebaseLocated()
  anchor.moveTo(poseAt(1.012, 0, 1))
  s.frame()
  assert.equal(s.moved.length, 0, '6 mm more, counted from where it was when the epoch began: still under it')
  assert.ok(near(s.anchors.anchorDisplacement(handle)?.translationM ?? 0, 0.006))
})

test('rebaseLocated with nothing held, or only anchors that have not been placed yet, does nothing', async () => {
  const world = new ChromeWorld()
  const s = setUp(world)
  s.anchors.rebaseLocated()
  const asking = s.anchors.createAnchor(poseAt(0, 0, 0))
  s.frame()
  s.frame()
  const handle = await asking
  assert.ok(handle)
  s.anchors.rebaseLocated()
  s.frame()
  assert.equal(s.anchors.anchorDisplacement(handle)?.translationM, 0)
  assert.deepEqual(s.lost, [])
})
