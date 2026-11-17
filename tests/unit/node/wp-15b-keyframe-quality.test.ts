/**
 * WP-15b: a scan is not a poorer scan for having sent no camera frames (src/capture/quality-monitor.ts).
 *
 * The verdict used to add "Stream RGB keyframes for reconstruction" whenever a scan had no frames, which made it
 * 'needs-review' and put "Review" on the chip of every scan made on a phone that had not agreed to send frames. That is a
 * feature held back for saying no, which Apple 5.1.1(ii) forbids, and a nudge toward a yes. Now the advice is given only
 * while frames are being sent and none has reached the server, which the code has seen and the person can act on. A phone
 * that is not sending says nothing about it, and the verdict is the one it would give for the same scan if it were.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b-keyframe-quality.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScanQualityMonitor } from '../../../src/capture/quality-monitor.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

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

/** A monitor that has seen one good tick, so its summary describes a full, steady scan. */
function steady(): ScanQualityMonitor {
  const monitor = new ScanQualityMonitor()
  const provider = {
    isTracking: () => true,
    trackingStatus: () => 'NORMAL',
    getPose: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  } as unknown as ARProvider
  monitor.tick(provider, cloud)
  return monitor
}

const SCAN = { pointCount: 1600, detectionCount: 3, poseCount: 40 }

test('a good scan with no camera frames is ready when the phone is not sending them, and says nothing about them', () => {
  const monitor = steady()
  for (const input of [{ ...SCAN, keyframeCount: 0 }, { ...SCAN, keyframeCount: 0, keyframesOn: false }, { ...SCAN }]) {
    const summary = monitor.summary(input)
    assert.equal(summary.status, 'ready', JSON.stringify(input))
    assert.deepEqual(summary.recommendations, [], 'no advice to start sending, and no "Review" for not having')
  }
})

test('the same scan reads the same whether or not frames are being sent, as long as some arrive', () => {
  const monitor = steady()
  const notSending = monitor.summary({ ...SCAN, keyframeCount: 0 })
  const sending = monitor.summary({ ...SCAN, keyframeCount: 12, keyframesOn: true })
  const sent = monitor.summary({ ...SCAN, keyframeCount: 12 })
  for (const summary of [notSending, sending, sent]) {
    assert.equal(summary.status, 'ready')
    assert.deepEqual(summary.recommendations, [])
  }
})

test('while frames are being sent and none has reached the server, the scan is told so, in words that say only what was seen', () => {
  const summary = steady().summary({ ...SCAN, keyframeCount: 0, keyframesOn: true })
  assert.deepEqual(summary.recommendations, ['No camera frame has reached your server yet'])
  assert.equal(summary.status, 'needs-review', 'there is something to look at: frames are on and none arrive')
  assert.doesNotMatch(summary.recommendations[0]!, /stream|start|turn on|allow|enable/i, 'it does not tell anyone to send frames')
})

test('once a frame has arrived the advice goes, and a scan with a real problem still reads as one', () => {
  const monitor = steady()
  assert.deepEqual(monitor.summary({ ...SCAN, keyframeCount: 1, keyframesOn: true }).recommendations, [])
  const sparse = monitor.summary({ pointCount: 10, detectionCount: 0, poseCount: 0, keyframeCount: 0 })
  assert.equal(sparse.status, 'needs-rescan', 'the verdict is still about the scan')
  assert.ok(sparse.recommendations.includes('Collect more tracking points before export'))
})

test('source shape: the scanner passes "frames are going out", read from the streamer, and nothing reads the consent for it', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  const summary = main.slice(main.indexOf('function currentQualitySummary('), main.indexOf('async function ensureSessionScanEntry'))
  assert.match(summary, /keyframesOn: keyframes\?\.active === true/, 'what is passed is whether the stream is active')
  assert.doesNotMatch(summary, /consent/i, 'the verdict does not look at whether this device agreed')
  const monitor = readFileSync(join(ROOT, 'src/capture/quality-monitor.ts'), 'utf8')
  assert.doesNotMatch(monitor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /consent/i)
  assert.doesNotMatch(monitor, /Stream RGB keyframes/, 'the old advice, which nudged toward a yes, is gone')
})
