/**
 * ScanQualityMonitor.reset() — the scanner reset (publish-readiness WP-B, F71).
 *
 * Clear, deleting the active session and loading another session all empty the
 * live point cloud. The monitor's counts describe the scan that was just left,
 * so they must go with it, or the next summary carries the previous scan's
 * drift and its advice.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-b-quality-reset.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ScanQualityMonitor } from '../../../src/capture/quality-monitor.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'

// tick() reads only the count of the cloud, so an empty stand-in is enough here.
const emptyCloud = { count: 0 } as unknown as PointCloud

/** A tracking provider whose camera stands at `state.x` metres along the floor. */
function providerAt(state: { x: number }): ARProvider {
  return {
    isTracking: () => true,
    trackingStatus: () => 'NORMAL',
    getPose: () => ({ position: { x: state.x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  } as unknown as ARProvider
}

test('reset clears the drift the last scan counted, and the advice that came from it', () => {
  const monitor = new ScanQualityMonitor()
  const at = { x: 0 }
  const provider = providerAt(at)
  monitor.tick(provider, emptyCloud)
  // A metre within the same instant is far faster than walking, so it counts as drift.
  at.x = 1
  monitor.tick(provider, emptyCloud)
  assert.equal(monitor.counts.fastMotionEvents, 1, 'the fast move is counted before the reset')
  // The summary writes the count under both names: the honest one, and the one stored
  // summaries, the upload sidecar and the server read.
  const counted = monitor.summary({ pointCount: 0, detectionCount: 0, poseCount: 0 })
  assert.equal(counted.fastMotionEvents, 1)
  assert.equal(counted.driftEvents, 1)
  // The advice is there before the reset, so its absence afterwards proves something.
  const before = monitor.summary({ pointCount: 0, detectionCount: 0, poseCount: 0 })
  assert.ok(before.recommendations.includes('Move slower to reduce drift'), 'the drift advice is present before the reset')

  monitor.reset()
  assert.equal(monitor.counts.fastMotionEvents, 0, 'the count goes with the scan that produced it')
  const summary = monitor.summary({ pointCount: 0, detectionCount: 0, poseCount: 0 })
  assert.ok(
    !summary.recommendations.includes('Move slower to reduce drift'),
    'the advice that came from the count is gone too',
  )
})

test('a pose from before the reset does not read as motion after it', () => {
  const monitor = new ScanQualityMonitor()
  const at = { x: 0 }
  const provider = providerAt(at)
  monitor.tick(provider, emptyCloud)
  monitor.reset()
  // Five metres from the last pose seen before the reset. With no earlier
  // sample after the reset there is nothing to measure a speed against.
  at.x = 5
  monitor.tick(provider, emptyCloud)
  assert.equal(monitor.counts.fastMotionEvents, 0, 'the first sample after a reset has nothing to measure against')
})

test('reset leaves the monitor usable for the next scan', () => {
  const monitor = new ScanQualityMonitor()
  const at = { x: 0 }
  const provider = providerAt(at)
  monitor.tick(provider, emptyCloud)
  monitor.reset()
  at.x = 1
  monitor.tick(provider, emptyCloud)
  at.x = 2
  monitor.tick(provider, emptyCloud)
  assert.equal(monitor.counts.fastMotionEvents, 1, 'a new scan counts its own drift from the reset onward')
})
