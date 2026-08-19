/**
 * resolveDetections() — a non-finite hit-test/fallback position must never reach
 * a persisted WorldDetection.
 *
 * Rotation went through ensureValidRotation() on every tier; position did not — a
 * NaN/Infinity worldPos (a bogus SLAM pose, a degenerate ray) got pushed straight
 * into results and from there into dedup bucketing. bucket()/dist() both go quietly
 * wrong on non-finite input: `NaN.toFixed(1)` buckets every bad detection under the
 * same "NaN,NaN,NaN" key, and `dist(a, b) < DEDUP_RADIUS_M` is always false for NaN
 * operands, so those NaN-bucketed entries can never merge with each other either —
 * an ever-growing pile of unmergeable ghosts, plus NaN leaking into any downstream
 * Box3 built over the scan.
 *
 * isFiniteVec3() now gates every tier's acceptance: an invalid candidate is treated
 * as "this tier found nothing" and the cascade falls through to the next one, same
 * as a real miss. If every tier is exhausted with nothing finite, the detection is
 * dropped — same as the pre-existing "no camera pose at all" skip.
 *
 * Run: npm run test:resolver
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { resolveDetections } from './src/spatial/resolver.ts'
import type { ARProvider, Pose, HitResult } from './src/ar/provider.ts'
import type { RawDetection } from './src/inference/prompt.ts'

const NAN_HIT: HitResult = {
  position: { x: NaN, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  distance: 1.0,
}

const FINITE_HIT: HitResult = {
  position: { x: 1, y: 2, z: -3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  distance: 1.0,
}

const FINITE_POSE: Pose = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
}

/** Only hitTest varies per test; everything else is an unused stub. */
function providerReturning(hit: HitResult | null): ARProvider {
  return {
    start: () => Promise.resolve(),
    stop: () => {},
    captureFrame: () => Promise.reject(new Error('not used in this test')),
    hitTest: () => hit,
    featurePoints: () => [],
    getPose: () => FINITE_POSE,
    isTracking: () => true,
    getCameraFovY: () => 60,
    getCameraAspect: () => 1,
  }
}

const detection: RawDetection = {
  label: 'chair',
  bbox: [0.4, 0.4, 0.6, 0.6],
  confidence: 0.9,
  description: 'a chair',
}

test('resolveDetections: a finite hitTest position resolves normally', async () => {
  const results = await resolveDetections([detection], 1000, {
    provider: providerReturning(FINITE_HIT),
  })

  assert.equal(results.length, 1)
  assert.deepEqual(results[0].worldPos, FINITE_HIT.position)
})

test('resolveDetections: a non-finite hitTest position falls through to the camera-pose fallback', async () => {
  const results = await resolveDetections([detection], 1000, {
    provider: providerReturning(NAN_HIT),
    cameraPose: FINITE_POSE,
  })

  assert.equal(results.length, 1, 'the fallback tier must still produce a detection')
  const { x, y, z } = results[0].worldPos
  assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'worldPos must be finite')
  assert.ok(Number.isNaN(NAN_HIT.position.x), 'sanity: the rejected candidate really was NaN')
})

test('resolveDetections: a non-finite hitTest position with no fallback available is dropped, not persisted as NaN', async () => {
  const results = await resolveDetections([detection], 1000, {
    provider: providerReturning(NAN_HIT),
    // No cameraPose, captureCamera, asyncHitTest, or pointCloud — every tier is exhausted.
  })

  assert.equal(results.length, 0, 'a detection with no usable position must be skipped, never pushed with NaN')
})

test('resolveDetections: a non-finite captureCamera bbox-ray fallback is also rejected, not persisted', async () => {
  // A camera built from a bad SLAM pose can itself produce a degenerate ray. The bbox-ray
  // fallback (tier 4) must be validated exactly like every other tier.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(NaN, 0, 0)
  camera.updateMatrixWorld(true)

  const results = await resolveDetections([detection], 1000, {
    provider: providerReturning(null),
    captureCamera: camera,
  })

  assert.equal(results.length, 0, 'a non-finite bbox-ray fallback must not be persisted')
})

test('resolveDetections: a non-finite captureCamera bbox-ray falls through to a finite cameraPose fallback', async () => {
  // Regression for a review comment on this same fix: 4a (bbox-ray) and 4b (cameraPose)
  // used to be an if/else-if keyed on which inputs were present, not two independent
  // attempts — so a non-finite 4a candidate never got a chance to try 4b even when a
  // perfectly good cameraPose was sitting right there. Both being available at once,
  // with only the camera producing a degenerate ray, must still resolve via cameraPose.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(NaN, 0, 0)
  camera.updateMatrixWorld(true)

  const results = await resolveDetections([detection], 1000, {
    provider: providerReturning(null),
    captureCamera: camera,
    cameraPose: FINITE_POSE,
  })

  assert.equal(results.length, 1, 'the cameraPose fallback must still run after the bbox-ray candidate is rejected')
  const { x, y, z } = results[0].worldPos
  assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'worldPos must be finite')
})
