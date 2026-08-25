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
import { PointCloud } from '../../../src/scene/pointcloud.ts'
import { isSameHeightRetry, isTapOnGround, tapHeightAboveGroundCm } from '../../../src/ar/ground-gate.ts'

/** A controllable clock, so the recompute throttle is testable without sleeping. */
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

/**
 * `n` points scattered on a horizontal plane at height `y`, spread over `spanM`.
 *
 * `yJitterM` adds symmetric vertical noise, for the ticket-0008 cases that care
 * how tightly a surface's points cluster. It defaults to 0 so every pre-existing
 * call site keeps producing a perfectly flat layer.
 */
function floorPoints(
  n: number,
  y: number,
  spanM = 4,
  seed = 1,
  yJitterM = 0,
): Array<{ x: number; y: number; z: number }> {
  const out: Array<{ x: number; y: number; z: number }> = []
  // Deterministic pseudo-random placement — a fixed lattice would collide with
  // the 5 cm voxel dedupe and silently insert far fewer points than requested.
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < n; i++) {
    out.push({
      x: (rand() - 0.5) * spanM,
      y: yJitterM === 0 ? y : y + (rand() - 0.5) * 2 * yJitterM,
      z: (rand() - 0.5) * spanM,
    })
  }
  return out
}

/** Points scattered through a height *range*, i.e. with no horizontal structure. */
function scatter(n: number, loY: number, hiY: number, spanM = 4, seed = 1) {
  const out: Array<{ x: number; y: number; z: number }> = []
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < n; i++) {
    out.push({ x: (rand() - 0.5) * spanM, y: loY + rand() * (hiY - loY), z: (rand() - 0.5) * spanM })
  }
  return out
}

/**
 * A room swept at eye level: a real floor cluster, but under 8 % of the cloud.
 *
 * This is the shape that broke the pre-0008 estimator, and it is not contrived
 * — the capture flow encourages sweeping walls and furniture, because that is
 * where the scanner's features are.
 */
function eyeLevelSweep() {
  return [
    ...floorPoints(30, 0.0, 4, 1, 0.01),
    ...floorPoints(180, 0.8, 5, 7, 0.01),
    ...floorPoints(180, 1.3, 5, 13, 0.01),
    ...floorPoints(180, 1.8, 5, 19, 0.01),
  ]
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

Deno.test('tapHeightAboveGroundCm: is signed, so below-floor is not reported as above', () => {
  // A hit can land below the estimate — a gap in the mesh, a reflective floor,
  // or an over-high estimate. Reporting that as "above the floor" would send
  // the user looking in the wrong direction.
  assertEquals(tapHeightAboveGroundCm(0.75, 0), 75)
  assertEquals(tapHeightAboveGroundCm(-0.4, 0), -40)
  assertEquals(tapHeightAboveGroundCm(-1.1, -1.5), 40)
  assertEquals(tapHeightAboveGroundCm(0, 0), 0)
})

Deno.test('isSameHeightRetry: only a retry at the rejected height confirms the override', () => {
  // The copy asks the user to "tap the same height again". Honouring any
  // second tap would let a rejected tabletop be confirmed by a tap on a shelf
  // a metre higher — the copy would be claiming a constraint nothing applied.
  assertEquals(isSameHeightRetry(0.75, 0.75), true, 'the same height confirms')
  assertEquals(isSameHeightRetry(0.80, 0.75), true, 'aim wobble still confirms')
  assertEquals(isSameHeightRetry(1.80, 0.75), false, 'a shelf a metre up does not')
  assertEquals(isSameHeightRetry(0.0, 0.75), false, 'nor does the floor itself')
})

Deno.test('isSameHeightRetry: no pending rejection means nothing to confirm', () => {
  assertEquals(isSameHeightRetry(0.75, null), false)
  assertEquals(isSameHeightRetry(0.0, null), false)
})

// ── Floor fit (wave 09 ticket 0008) ─────────────────────────────────────────
//
// The estimator these cover replaced an 8th-percentile of the sorted Y values.
// A percentile is a position in the *ordering*, not a property of the room, and
// it is correct only while the floor supplies at least ~8 % of the points.

Deno.test('estimateFloorY: an under-sampled floor is found, not the surface 8 % lands on', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feed(cloud, clock, eyeLevelSweep())

  // The regression. Against the old estimator this returned +0.792 m — the
  // constructed twin of a real capture that reported +0.84 m while the lowest
  // detected object sat at -0.05 m. The floor is ~5 % of this cloud, so index
  // 0.08 x n lands above it entirely.
  const y = cloud.estimateFloorY()
  assertAlmostEquals(y, 0, 0.05, `expected the floor, got ${y}`)

  const estimate = cloud.groundEstimate()!
  assertEquals(estimate.fallback, false, 'a real floor was fitted, not fallen back to')
  assert(estimate.inlierCount! >= 20, `expected the floor cluster as inliers, got ${estimate.inlierCount}`)
})

Deno.test('estimateFloorY: a better-sampled tabletop does not out-vote the floor', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  // The tabletop has over three times the floor's points. "Densest band" would
  // return it; "lowest band with real support" is what a floor actually is.
  feed(cloud, clock, [
    ...floorPoints(60, 0.0, 4, 3, 0.01),
    ...floorPoints(200, 0.75, 2, 5, 0.01),
  ])
  const y = cloud.estimateFloorY()
  assertAlmostEquals(y, 0, 0.05, `expected the floor, got ${y}`)
})

Deno.test('estimateFloorY: a cloud with no horizontal structure reports fallback rather than inventing a floor', () => {
  // Evenly scattered through 3 m of height: no band holds a meaningful share,
  // so there is nothing to fit and the estimator must say so.
  //
  // 1000 points, not 400, and that is a real property of the check rather than
  // a tuned fixture. Structure-vs-scatter is a statistical test, and in a
  // sparse cloud Poisson noise alone throws up a band above the share: at 400
  // points, 2 of 3 seeds tried produced a false positive. At 1000 and above it
  // was stable across every seed. The limitation is documented on
  // FLOOR_MIN_BAND_SHARE, and the case below pins what a caller should read
  // instead when the cloud is that sparse.
  for (const seed of [23, 41, 67]) {
    const clock = fakeClock()
    const cloud = new PointCloud(0.05, clock.now)
    feed(cloud, clock, scatter(1000, 0.0, 3.0, 8, seed))
    const estimate = cloud.groundEstimate()!
    assertEquals(estimate.fallback, true, `no band should qualify in pure scatter (seed ${seed})`)
    assertEquals(estimate.inlierCount, 0)
  }
})

Deno.test('a chance band in a sparse cloud is visibly unconfident, even when it is not flagged', () => {
  // The honest boundary of the check above. On a sparse structureless cloud the
  // share test can be fooled, so `fallback` is not a sufficient confidence
  // signal on its own — the diagnostics are. A chance band holds few points and
  // spreads to near the band width; a real floor holds many and sits at
  // hit-test noise. A caller that trusts `fallback` alone will believe a floor
  // that is not there, which is the failure this whole ticket is about.
  const clock = fakeClock()
  const noise = new PointCloud(0.05, clock.now)
  feed(noise, clock, scatter(400, 0.0, 3.0, 6, 23))
  const chance = noise.groundEstimate()!

  const clock2 = fakeClock()
  const real = new PointCloud(0.05, clock2.now)
  feed(real, clock2, floorPoints(400, 0, 4, 23, 0.005))
  const floor = real.groundEstimate()!

  assert(
    floor.inlierCount! > chance.inlierCount! * 5,
    `a real floor should have far more support: real ${floor.inlierCount}, chance ${chance.inlierCount}`,
  )
  assert(
    chance.residualM! > floor.residualM! * 3,
    `a chance band should spread far wider: real ${floor.residualM}, chance ${chance.residualM}`,
  )
})

Deno.test('estimateFloorY: the result is not quantised to the histogram grid', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  // A floor deliberately off any multiple of the 5 cm band width. Returning the
  // band centre would snap this to -0.05 or 0.00 and show up as a 5 cm floor on
  // every estimate the app makes.
  feed(cloud, clock, floorPoints(300, -0.037, 4, 29, 0.004))
  const y = cloud.estimateFloorY()
  assertAlmostEquals(y, -0.037, 0.006, `expected the real height, got ${y}`)
})

Deno.test('residualM: small for a level floor, large for a tilted one', () => {
  const clock = fakeClock()
  const level = new PointCloud(0.05, clock.now)
  feed(level, clock, floorPoints(300, 0, 4, 31, 0.005))
  const levelResidual = level.groundEstimate()!.residualM!

  const clock2 = fakeClock()
  const tilted = new PointCloud(0.05, clock2.now)
  // A gravity-estimate error leaves the floor sloping in the session frame.
  // No horizontal fit can correct that; the point is that it stops being silent.
  const sloped = floorPoints(300, 0, 4, 31, 0).map((p) => ({ ...p, y: p.x * 0.05 }))
  feed(tilted, clock2, sloped)
  const tiltedResidual = tilted.groundEstimate()!.residualM!

  assert(levelResidual < 0.005, `level floor should sit near hit-test noise, got ${levelResidual}`)
  assert(
    tiltedResidual > levelResidual * 3,
    `a tilted floor should spread far wider: level ${levelResidual}, tilted ${tiltedResidual}`,
  )
})

Deno.test('groundEstimate: diagnostics are absent before any fit and present after', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  assertEquals(cloud.groundEstimate(), null)
  feed(cloud, clock, floorPoints(200, 0, 4, 37, 0.01))
  const estimate = cloud.groundEstimate()!
  assert(estimate.inlierCount !== undefined, 'inlierCount should be reported once a fit has run')
  assert(estimate.residualM !== undefined, 'residualM should be reported once a fit has run')
  assertEquals(estimate.fallback, false)
})
