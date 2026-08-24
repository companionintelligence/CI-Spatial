/**
 * Unit tests for PointCloud's ground-plane estimate (wave 09 ticket 0003) and
 * for the calibration flow's floor gate.
 *
 * The estimate is what the calibration readiness step waits on and what the
 * tap gate checks against, so its lock/unlock behaviour is load-bearing: a
 * false lock lets a tabletop tap through, and a lock that never fires makes
 * the gate a 20-second wait users learn to skip.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { PointCloud } from './src/scene/pointcloud.ts'
import { isTapOnGround } from './src/ar/ground-gate.ts'

/** A controllable clock, so the recompute throttle is testable without sleeping. */
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

/** `n` points scattered on a horizontal plane at height `y`, spread over `spanM`. */
function floorPoints(n: number, y: number, spanM = 4, seed = 1): Array<{ x: number; y: number; z: number }> {
  const out: Array<{ x: number; y: number; z: number }> = []
  // Deterministic pseudo-random placement — a fixed lattice would collide with
  // the 5 cm voxel dedupe and silently insert far fewer points than requested.
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < n; i++) {
    out.push({ x: (rand() - 0.5) * spanM, y, z: (rand() - 0.5) * spanM })
  }
  return out
}

/** Feed one batch and let the throttle elapse, so each call yields one recompute. */
function feed(cloud: PointCloud, clock: ReturnType<typeof fakeClock>, pts: Array<{ x: number; y: number; z: number }>) {
  cloud.add(pts)
  clock.advance(600) // > GROUND_RECOMPUTE_INTERVAL_MS
}

Deno.test('groundEstimate: null before any points', () => {
  assertEquals(new PointCloud(0.05, fakeClock().now).groundEstimate(), null)
})

Deno.test('groundEstimate: null below the minimum sample count', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feed(cloud, clock, floorPoints(20, 0))
  assertEquals(cloud.groundEstimate(), null, '20 points is not enough to claim a floor')
})

Deno.test('groundEstimate: converges on the floor cluster, not the furniture above it', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  // A real room: mostly floor, plus a table top and a wall's worth of points
  // well above it. The 8th-percentile estimator must not be dragged upward.
  feed(cloud, clock, [
    ...floorPoints(200, 0.0),
    ...floorPoints(60, 0.75, 1.5, 7),
    ...floorPoints(60, 1.6, 3, 11),
  ])
  const estimate = cloud.groundEstimate()
  assert(estimate, 'expected an estimate')
  assertAlmostEquals(estimate.y, 0, 0.05, `got ${estimate.y}`)
})

Deno.test('groundEstimate: locks once consecutive candidates agree', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feed(cloud, clock, floorPoints(200, 0))
  assert(cloud.groundEstimate(), 'expected an estimate after the first batch')
  assertEquals(cloud.groundEstimate()!.locked, false, 'one sample must not be enough to lock')

  // Six consecutive stable candidates is the documented lock condition.
  for (let i = 0; i < 6; i++) feed(cloud, clock, floorPoints(40, 0, 4, 100 + i))
  assertEquals(cloud.groundEstimate()!.locked, true)
  assertAlmostEquals(cloud.groundEstimate()!.y, 0, 0.05)
})

Deno.test('groundEstimate: a real level change unlocks it', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  for (let i = 0; i < 8; i++) feed(cloud, clock, floorPoints(60, 0, 4, 200 + i))
  assertEquals(cloud.groundEstimate()!.locked, true, 'precondition: locked')

  // Walk down a step. The new floor dominates the low percentile, and the
  // shift exceeds the unlock tolerance, so the old lock must be abandoned
  // outright rather than averaged with the new level.
  for (let i = 0; i < 6; i++) feed(cloud, clock, floorPoints(400, -0.9, 4, 300 + i))
  const after = cloud.groundEstimate()!
  assert(after.y < -0.3, `estimate should follow the new floor, got ${after.y}`)
})

Deno.test('groundEstimate: recompute is throttled', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  cloud.add(floorPoints(200, 0))
  const first = cloud.groundEstimate()
  assert(first, 'expected an estimate from the first batch')

  // A second batch inside the throttle window must not advance sampleCount:
  // the points are stored, but the O(n log n) estimate is not recomputed.
  cloud.add(floorPoints(200, 0, 4, 55))
  clock.advance(100)
  cloud.add(floorPoints(200, 0, 4, 56))
  assertEquals(cloud.groundEstimate()!.sampleCount, first.sampleCount, 'recomputed inside the throttle window')

  clock.advance(600)
  cloud.add(floorPoints(50, 0, 4, 57))
  assert(cloud.groundEstimate()!.sampleCount > first.sampleCount, 'should recompute once the window elapses')
})

Deno.test('groundEstimate: a tick that inserts nothing does not recompute', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  const batch = floorPoints(200, 0)
  feed(cloud, clock, batch)
  const before = cloud.groundEstimate()!.sampleCount
  // Same points again — every one is a voxel duplicate, so nothing is inserted.
  cloud.add(batch)
  clock.advance(600)
  cloud.add(batch)
  assertEquals(cloud.groundEstimate()!.sampleCount, before)
})

Deno.test('groundEstimate: clear() resets the estimate', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  for (let i = 0; i < 8; i++) feed(cloud, clock, floorPoints(60, 0, 4, 400 + i))
  assert(cloud.groundEstimate()!.locked)
  cloud.clear()
  assertEquals(cloud.groundEstimate(), null, 'a cleared cloud must not report a stale floor')
})

Deno.test('estimateFloorY and boundingBox are unchanged by the ground tracking', () => {
  // Regression guard: src/export/gltf.ts depends on estimateFloorY() as a
  // stateless snapshot, and this ticket must not have altered it.
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 3 },
    { x: -1, y: -2, z: -3 },
  ]
  cloud.add(pts)
  assertEquals(cloud.count, 3)
  const bb = cloud.boundingBox()
  assertEquals(bb.min, { x: -1, y: -2, z: -3 })
  assertEquals(bb.max, { x: 1, y: 2, z: 3 })
  assertEquals(cloud.estimateFloorY(), -2)
})

// ── the calibration floor gate ──────────────────────────────────────────────

Deno.test('isTapOnGround: accepts a tap at floor height', () => {
  assertEquals(isTapOnGround(0.0, 0.0), true)
  assertEquals(isTapOnGround(0.05, 0.0), true, 'a few cm of hit-test noise is fine')
  assertEquals(isTapOnGround(-0.2, 0.0), true, 'thick carpet / slope stays inside tolerance')
})

Deno.test('isTapOnGround: rejects furniture heights', () => {
  assertEquals(isTapOnGround(0.75, 0.0), false, 'tabletop')
  assertEquals(isTapOnGround(0.45, 0.0), false, 'chair seat')
})

Deno.test('isTapOnGround: no estimate means no opinion', () => {
  // The gate must never block when it cannot see — a feature-poor room has to
  // stay calibratable.
  assertEquals(isTapOnGround(0.75, null), true)
  assertEquals(isTapOnGround(-5, null), true)
})

Deno.test('isTapOnGround: works against a non-zero floor height', () => {
  // The estimate is in session-local metres, where the floor is rarely at 0.
  assertEquals(isTapOnGround(-1.5, -1.5), true)
  assertEquals(isTapOnGround(-0.75, -1.5), false)
})
