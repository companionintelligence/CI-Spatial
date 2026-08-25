/**
 * Clock-offset estimation for a multi-device take.
 *
 * The estimator's one interesting property is that it must survive a delayed
 * packet. On a phone over Wi-Fi a slow round-trip is routine rather than
 * exceptional, and a mean over all samples would let one of them drag the
 * estimate far enough to smear a per-timestep reconstruction. These assert that
 * the low-RTT median does not move.
 *
 * Lives in the node suite rather than the Deno one only because the module sits
 * under src/ with the browser code it ships alongside.
 *
 * Run: npm run test:clock-sync
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateOffset,
  measureOffset,
  median,
  offsetOf,
  rttOf,
  type SyncSample,
} from '../../../src/capture/clock-sync.ts'

/** A round-trip with a known offset and a known, symmetric latency. */
function sample(deviceStart: number, offset: number, oneWay: number, serverGap = 0): SyncSample {
  const t1 = deviceStart + oneWay + offset
  return { t0: deviceStart, t1, t2: t1 + serverGap, t3: deviceStart + 2 * oneWay + serverGap }
}

test('offsetOf recovers a known offset from a symmetric round-trip', () => {
  assert.equal(offsetOf(sample(1000, 250, 10)), 250)
  assert.equal(offsetOf(sample(1000, -80, 25)), -80)
})

test('rttOf excludes the server processing gap', () => {
  assert.equal(rttOf(sample(1000, 250, 10)), 20)
  assert.equal(rttOf(sample(1000, 250, 10, 500)), 20)
})

test('median averages the middle pair on an even-length list', () => {
  assert.equal(median([1, 2, 3]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([]), 0)
})

test('estimateOffset recovers a known injected offset', () => {
  const samples = Array.from({ length: 11 }, (_, i) => sample(1000 + i * 100, 250, 10))
  const est = estimateOffset(samples)
  assert.ok(est)
  assert.equal(est.offsetMs, 250)
  assert.equal(est.sampleCount, 11)
})

test('a single delayed outlier does not move the estimate', () => {
  const good = Array.from({ length: 10 }, (_, i) => sample(1000 + i * 100, 250, 10))
  // One badly asymmetric exchange: a 900ms stall on the return leg alone would
  // pull a mean by hundreds of ms.
  const outlier: SyncSample = { t0: 5000, t1: 5010 + 250, t2: 5010 + 250, t3: 5920 }
  const withOutlier = estimateOffset([...good, outlier])
  const without = estimateOffset(good)
  assert.ok(withOutlier && without)
  assert.equal(withOutlier.offsetMs, without.offsetMs)
})

test('estimateOffset returns null for no samples rather than a zero offset', () => {
  // "No measurement" and "measured zero" are different claims; conflating them
  // is what ADR 0005 rule 3 exists to prevent.
  assert.equal(estimateOffset([]), null)
})

test('measureOffset tolerates dropped probes and still estimates', () => {
  let i = 0
  let now = 0
  const est = measureOffset({
    now: () => now,
    probe: async () => {
      const n = i++
      now += 10
      // Every third probe is dropped.
      if (n % 3 === 0) throw new Error('dropped')
      const t1 = now + 100
      now += 10
      return { t1, t2: t1 }
    },
  }, 9)
  return est.then(result => {
    assert.ok(result, 'a burst with some drops must still produce an estimate')
    assert.equal(result.sampleCount, 6)
  })
})

test('measureOffset returns null when every probe fails', () => {
  return measureOffset({
    now: () => 0,
    probe: async () => { throw new Error('offline') },
  }, 5).then(result => {
    // The caller records this as 'exchange-failed' — never as a zero offset.
    assert.equal(result, null)
  })
})
