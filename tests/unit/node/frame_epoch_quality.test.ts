/**
 * The quality verdict and frame epochs (WP-09): `trackingLost` follows the runtime's live
 * status, any frame shift stops a scan reading 'ready', and the speed counter is named for
 * what it counts.
 *
 * Before this, `trackingLost` was `!provider.isTracking()`, a latch that goes true on the
 * first pose and never back, so it was true only before the first pose and the verdict could
 * not see a tracking loss. And a scan whose frame moved partway read 'ready', because
 * nothing counted the move.
 *
 * The HUD follows the live status tick by tick. The verdict that is saved with a scan waits
 * for the loss to last (TRACKING_LOST_HOLD_MS): it is read at one instant, by an autosave or an
 * export, and one blink of LIMITED at that instant used to stamp 'needs-rescan', with no
 * advice, on a scan that was fine.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_quality.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScanQualityMonitor, TRACKING_LOST_HOLD_MS } from '../../../src/capture/quality-monitor.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'

/** 1 600 points spread evenly over one square metre: full coverage, nothing missing. */
const cloud = (() => {
  const positions = new Float32Array(1600 * 3)
  for (let i = 0; i < 1600; i++) {
    positions[i * 3] = ((i % 40) + 0.5) / 40
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = (Math.floor(i / 40) + 0.5) / 40
  }
  return {
    count: 1600,
    boundingBox: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 1 } }),
    toFloat32Array: () => positions,
  } as unknown as PointCloud
})()

function provider(state: { tracking: boolean; status: string }): ARProvider {
  return {
    isTracking: () => state.tracking,
    trackingStatus: () => state.status,
    getPose: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  } as unknown as ARProvider
}

/** A monitor that has seen one good tick, so its summary describes a full, steady scan. */
function steady(): { monitor: ScanQualityMonitor; state: { tracking: boolean; status: string }; p: ARProvider } {
  const monitor = new ScanQualityMonitor()
  const state = { tracking: true, status: 'NORMAL' }
  const p = provider(state)
  monitor.tick(p, cloud)
  return { monitor, state, p }
}

const SUMMARY_INPUT = { pointCount: 1600, detectionCount: 3, poseCount: 40, keyframeCount: 10 }

// ─── trackingLost follows the live status ──────────────────────────────────

test('trackingLost is false for a runtime whose status is NORMAL, or that reports none', () => {
  for (const status of ['NORMAL', 'UNKNOWN']) {
    const monitor = new ScanQualityMonitor()
    const snap = monitor.tick(provider({ tracking: true, status }), cloud)
    assert.equal(snap.trackingLost, false, status)
  }
})

test('trackingLost is true while the runtime\'s own status says tracking is degraded or gone', () => {
  for (const status of ['LIMITED', 'NOT_AVAILABLE', 'INITIALIZING']) {
    const monitor = new ScanQualityMonitor()
    // isTracking() has latched true, as it does after the first pose and stays.
    const snap = monitor.tick(provider({ tracking: true, status }), cloud)
    assert.equal(snap.trackingLost, true, status)
  }
})

test('trackingLost clears when the status recovers', () => {
  const { monitor, state, p } = steady()
  state.status = 'LIMITED'
  assert.equal(monitor.tick(p, cloud).trackingLost, true)
  state.status = 'NORMAL'
  assert.equal(monitor.tick(p, cloud).trackingLost, false)
})

test('before the first pose tracking is lost, whatever the status says', () => {
  const monitor = new ScanQualityMonitor()
  assert.equal(monitor.tick(provider({ tracking: false, status: 'NORMAL' }), cloud).trackingLost, true)
})

/**
 * A monitor on a clock the test sets (the scanner's ticks are 750 ms apart), and the provider
 * state it reads. `tick(status)` is one scanner tick at the clock's time.
 */
function clocked(t: { mock: { method: (o: object, m: string, i: () => number) => unknown } }) {
  const clock = { ms: 100_000 }
  t.mock.method(performance, 'now', () => clock.ms)
  const monitor = new ScanQualityMonitor()
  const state = { tracking: true, status: 'NORMAL' }
  const p = provider(state)
  return {
    monitor,
    state,
    tick(status: string, advanceMs = 750) {
      clock.ms += advanceMs
      state.status = status
      return monitor.tick(p, cloud)
    },
  }
}

// ─── The verdict waits for a loss to last ──────────────────────────────────

test('one tick of LIMITED is a blink: the HUD says tracking is lost, and the saved verdict does not', (t) => {
  const c = clocked(t)
  c.tick('NORMAL')
  c.tick('NORMAL')
  const blink = c.tick('LIMITED')
  assert.equal(blink.trackingLost, true, 'the hint on screen follows the status')
  assert.equal(blink.trackingLostSustained, false)
  assert.equal(blink.trackingLostForMs, 0)
  const summary = c.monitor.summary(SUMMARY_INPUT)
  assert.equal(summary.trackingLost, false)
  assert.equal(summary.status, 'ready', 'a good scan is not stamped needs-rescan for a blink of its last tick')
  assert.deepEqual(summary.recommendations, [])
})

test('tracking that stays unusable for the hold is lost: needs-rescan, and the advice says what to do', (t) => {
  const c = clocked(t)
  c.tick('NORMAL')
  for (let i = 0; i < 4; i++) c.tick('LIMITED')
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, false, 'four ticks, 2.25 s of it: not yet')
  const held = c.tick('LIMITED')
  assert.equal(held.trackingLostForMs, 3_000)
  assert.equal(held.trackingLostSustained, true)
  const summary = c.monitor.summary(SUMMARY_INPUT)
  assert.equal(summary.trackingLost, true)
  assert.equal(summary.status, 'needs-rescan')
  assert.deepEqual(summary.recommendations, ['Tracking is lost: hold still until it returns'])
})

test('the hold is TRACKING_LOST_HOLD_MS to the millisecond, counted from the first unusable tick', (t) => {
  assert.equal(TRACKING_LOST_HOLD_MS, 3_000)
  const c = clocked(t)
  c.tick('NORMAL')
  c.tick('NOT_AVAILABLE')
  const almost = c.tick('NOT_AVAILABLE', TRACKING_LOST_HOLD_MS - 1)
  assert.equal(almost.trackingLostSustained, false)
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, false)
  const there = c.tick('NOT_AVAILABLE', 1)
  assert.equal(there.trackingLostSustained, true)
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, true)
})

test('a loss that ends clears the verdict, and blinks with good ticks between never add up to one', (t) => {
  const c = clocked(t)
  c.tick('NORMAL')
  for (let i = 0; i < 20; i++) c.tick(i % 2 === 0 ? 'LIMITED' : 'NORMAL')
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, false, 'a blink every other tick for fifteen seconds is a handheld scan, not a loss')

  for (let i = 0; i < 5; i++) c.tick('LIMITED')
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, true)
  c.tick('NORMAL')
  const after = c.monitor.summary(SUMMARY_INPUT)
  assert.equal(after.trackingLost, false)
  assert.equal(after.status, 'ready')
})

test('before the first pose tracking has not started, and that is not held: it says so at once, in its own words', (t) => {
  const c = clocked(t)
  c.state.tracking = false
  const snap = c.tick('NORMAL')
  assert.equal(snap.trackingLost, true)
  assert.equal(snap.trackingNotStarted, true)
  assert.equal(snap.trackingLostSustained, true)
  const summary = c.monitor.summary(SUMMARY_INPUT)
  assert.equal(summary.trackingLost, true)
  assert.equal(summary.status, 'needs-rescan')
  assert.deepEqual(summary.recommendations, ['Tracking has not started: wait for it, then scan'])
})

test('a scan that has never been ticked has not lost tracking', () => {
  const summary = new ScanQualityMonitor().summary(SUMMARY_INPUT)
  assert.equal(summary.trackingLost, false)
})

test('a new scan forgets a loss in progress, so it does not begin already lost', (t) => {
  const c = clocked(t)
  c.tick('NORMAL')
  c.tick('LIMITED')
  c.tick('LIMITED', 4_000)
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, true)
  c.monitor.reset()
  c.tick('LIMITED')
  assert.equal(c.monitor.summary(SUMMARY_INPUT).trackingLost, false, 'the loss that began before the reset is not this scan\'s')
})

test('the advice about a lost track comes after the one about a shifted frame, and before the rest', (t) => {
  const c = clocked(t)
  c.tick('NORMAL')
  for (let i = 0; i < 5; i++) c.tick('LIMITED')
  const summary = c.monitor.summary({ ...SUMMARY_INPUT, frameShifts: 1, keyframeCount: 0, keyframesOn: true })
  assert.deepEqual(summary.recommendations.slice(0, 2), ['Tracking was interrupted: parts may be shifted', 'Tracking is lost: hold still until it returns'])
  assert.ok(summary.recommendations.includes('No camera frame has reached your server yet'))
  assert.equal(summary.status, 'needs-rescan')
})

// ─── Frame shifts ──────────────────────────────────────────────────────────

test('a scan with no frame shift, or a caller that does not count them, is unchanged', () => {
  const { monitor } = steady()
  for (const input of [SUMMARY_INPUT, { ...SUMMARY_INPUT, frameShifts: 0 }]) {
    const summary = monitor.summary(input)
    assert.equal(summary.status, 'ready')
    assert.equal(summary.frameShifts, 0)
    assert.deepEqual(summary.recommendations, [])
  }
})

test('any frame shift stops a scan reading ready, and says why first', () => {
  const { monitor } = steady()
  const summary = monitor.summary({ ...SUMMARY_INPUT, frameShifts: 1 })
  assert.equal(summary.status, 'needs-review')
  assert.equal(summary.frameShifts, 1)
  assert.deepEqual(summary.recommendations, ['Tracking was interrupted: parts may be shifted'])
})

test('the line about it comes before the other advice, because it is the one that qualifies the rest', () => {
  const monitor = new ScanQualityMonitor()
  monitor.tick(provider({ tracking: true, status: 'NORMAL' }), cloud)
  const summary = monitor.summary({ pointCount: 100, detectionCount: 0, poseCount: 0, keyframeCount: 0, frameShifts: 3 })
  assert.equal(summary.recommendations[0], 'Tracking was interrupted: parts may be shifted')
  assert.ok(summary.recommendations.length > 1, 'the other advice is still there')
  assert.equal(summary.frameShifts, 3)
})

test('a frame shift does not soften a scan that is already too sparse to keep', () => {
  const monitor = new ScanQualityMonitor()
  monitor.tick(provider({ tracking: true, status: 'NORMAL' }), { count: 0 } as unknown as PointCloud)
  const summary = monitor.summary({ pointCount: 20, detectionCount: 0, poseCount: 0, frameShifts: 2 })
  assert.equal(summary.status, 'needs-rescan')
})

test('a count that is not a whole number of shifts is read as the whole number it is, or as none', () => {
  const { monitor } = steady()
  assert.equal(monitor.summary({ ...SUMMARY_INPUT, frameShifts: 2.9 }).frameShifts, 2)
  for (const bad of [-4, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const summary = monitor.summary({ ...SUMMARY_INPUT, frameShifts: bad })
    assert.equal(summary.frameShifts, 0, String(bad))
    assert.equal(summary.status, 'ready', String(bad))
  }
})

test('time spent with degraded tracking is carried when it was measured, and left out when it was not', () => {
  const { monitor } = steady()
  assert.equal(monitor.summary({ ...SUMMARY_INPUT, limitedMs: 1234.6 }).limitedMs, 1235)
  assert.equal(monitor.summary({ ...SUMMARY_INPUT, limitedMs: 0 }).limitedMs, 0)
  assert.equal(monitor.summary({ ...SUMMARY_INPUT, limitedMs: -50 }).limitedMs, 0)
  assert.equal('limitedMs' in monitor.summary(SUMMARY_INPUT), false, 'not measured is absent, not zero')
  assert.equal('limitedMs' in monitor.summary({ ...SUMMARY_INPUT, limitedMs: Number.NaN }), false)
  // Time degraded does not by itself change the verdict: a blink is not a shift.
  assert.equal(monitor.summary({ ...SUMMARY_INPUT, limitedMs: 4000 }).status, 'ready')
})

// ─── The speed counter has its own name ────────────────────────────────────

test('the count of fast camera moves is fastMotionEvents, and driftEvents is the same number kept for readers of old summaries', () => {
  const monitor = new ScanQualityMonitor()
  const at = { x: 0 }
  const p = {
    isTracking: () => true,
    trackingStatus: () => 'NORMAL',
    getPose: () => ({ position: { x: at.x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  } as unknown as ARProvider
  monitor.tick(p, cloud)
  at.x = 1
  monitor.tick(p, cloud)
  at.x = 2
  monitor.tick(p, cloud)
  assert.equal(monitor.counts.fastMotionEvents, 2)
  assert.equal('driftEvents' in monitor.counts, false, 'the counter is not kept under two names inside the monitor')
  const summary = monitor.summary(SUMMARY_INPUT)
  assert.equal(summary.fastMotionEvents, 2)
  assert.equal(summary.driftEvents, 2)
  assert.ok(summary.recommendations.includes('Move slower to reduce drift'))
})
