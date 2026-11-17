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

// ── Frame epochs (WP-09, src/ar/frame-epoch.ts) ─────────────────────────────
//
// A point is recorded in one stretch of tracking, an epoch, and points of different epochs
// are not in one coordinate frame. The cloud keeps each point's epoch, never lets two
// epochs' points vouch for each other, and fits the live floor from the current epoch's
// points only. The case that motivated it: a locked floor never followed a floor that
// appeared higher after a frame shift, because the old points stayed the lowest band.

/** {@link feed} for a given epoch. */
function feedAt(
  cloud: PointCloud,
  clock: ReturnType<typeof fakeClock>,
  pts: Array<{ x: number; y: number; z: number }>,
  epoch: number,
) {
  cloud.add(pts, epoch)
  clock.advance(600) // > GROUND_RECOMPUTE_INTERVAL_MS
}

/** A cloud with a locked floor at y = 0 in epoch 0. */
function lockedAtZero() {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  for (let i = 0; i < 8; i++) feedAt(cloud, clock, floorPoints(60, 0, 4, 700 + i, 0.004), 0)
  assert(cloud.groundEstimate()!.locked, 'precondition: the floor is locked')
  assertAlmostEquals(cloud.groundEstimate()!.y, 0, 0.01)
  return { clock, cloud }
}

Deno.test('epochs: every point keeps the epoch it was added in, in the same order as its position', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  cloud.add([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], 0)
  cloud.add([{ x: 2, y: 0, z: 0 }], 1)
  cloud.add([{ x: 3, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], 2)
  const positions = cloud.toFloat32Array()
  const epochs = cloud.toEpochArray()
  assertEquals(epochs.length, cloud.count)
  assertEquals([...epochs], [0, 0, 1, 2, 2])
  assertEquals([...positions].filter((_, i) => i % 3 === 0), [0, 1, 2, 3, 4])
  assertEquals(cloud.currentEpoch, 2)
  assertEquals(cloud.epochCounts(), [{ epoch: 0, count: 2 }, { epoch: 1, count: 1 }, { epoch: 2, count: 2 }])
})

Deno.test('epochs: with no epoch given every point is epoch 0, and the cloud behaves as it did', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feed(cloud, clock, floorPoints(200, 0))
  assertEquals(cloud.currentEpoch, 0)
  assertEquals(cloud.epochCounts(), [{ epoch: 0, count: cloud.count }])
  assertEquals(cloud.groundEstimate()!.epoch, 0)
  assertEquals(cloud.groundObjects().length, 1)
})

Deno.test('epochs: the same voxel in two epochs is two points, in one epoch it is one', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  const p = [{ x: 1, y: 0.5, z: 1 }]
  assertEquals(cloud.add(p, 0).length, 1)
  assertEquals(cloud.add(p, 0).length, 0, 'a duplicate in the same epoch')
  assertEquals(cloud.add(p, 1).length, 1, 'the same coordinates in another frame are another place')
  assertEquals(cloud.add(p, 1).length, 0)
  assertEquals(cloud.count, 2)
})

Deno.test('epochs: a floor that appears 0.10 m higher in a new epoch is followed, and locks there', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(60, 0.10, 4, 800, 0.004), 1)
  const first = cloud.groundEstimate()!
  assertEquals(first.epoch, 1)
  assertAlmostEquals(first.y, 0.10, 0.02, `the live floor stayed at the old frame's: ${first.y}`)
  assertEquals(first.locked, false, 'one fit in a new frame is not a lock')
  for (let i = 1; i < 8; i++) feedAt(cloud, clock, floorPoints(60, 0.10, 4, 800 + i, 0.004), 1)
  const after = cloud.groundEstimate()!
  assertEquals(after.locked, true)
  assertAlmostEquals(after.y, 0.10, 0.01)
})

Deno.test('epochs: a floor that appears 0.30 m higher in a new epoch is followed', () => {
  const { clock, cloud } = lockedAtZero()
  for (let i = 0; i < 8; i++) feedAt(cloud, clock, floorPoints(60, 0.30, 4, 900 + i, 0.004), 1)
  const after = cloud.groundEstimate()!
  assertEquals(after.epoch, 1)
  assertAlmostEquals(after.y, 0.30, 0.01, `got ${after.y}`)
  assertEquals(after.locked, true)
})

Deno.test('epochs: a floor that appears 0.10 m lower is followed too (inside the old unlock tolerance)', () => {
  const { clock, cloud } = lockedAtZero()
  for (let i = 0; i < 8; i++) feedAt(cloud, clock, floorPoints(60, -0.10, 4, 1000 + i, 0.004), 1)
  assertAlmostEquals(cloud.groundEstimate()!.y, -0.10, 0.01)
})

Deno.test('epochs: inside one epoch a floor that appears higher is still not followed: only an epoch says the frame moved', () => {
  // The control. Points are never removed, so with nothing to say the frame moved, the old
  // floor is still the lowest band. This is the behaviour the epochs exist to override.
  const { clock, cloud } = lockedAtZero()
  for (let i = 0; i < 12; i++) feedAt(cloud, clock, floorPoints(60, 0.30, 4, 1100 + i, 0.004), 0)
  assertAlmostEquals(cloud.groundEstimate()!.y, 0, 0.01)
  assertEquals(cloud.groundEstimate()!.epoch, 0)
})

Deno.test('epochs: the new epoch starts with no estimate until it has enough points of its own', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(30, 0.2, 4, 1200, 0.004), 1)
  assertEquals(cloud.groundEstimate(), null, '30 points of a new frame are not enough to claim a floor, and the old frame\'s floor is not it')
  feedAt(cloud, clock, floorPoints(30, 0.2, 4, 1201, 0.004), 1)
  assert(cloud.groundEstimate(), 'sixty are')
})

Deno.test('epochs: a mixed-epoch cloud is fitted per epoch, not as one cloud', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(300, 0.0, 4, 31, 0.004), 0)
  feedAt(cloud, clock, floorPoints(300, 0.30, 4, 32, 0.004), 1)
  // Every point together: the lowest supported band, which is epoch 0's floor.
  assertAlmostEquals(cloud.estimateFloorY(), 0, 0.02)
  assertAlmostEquals(cloud.estimateFloorY(0), 0, 0.02)
  assertAlmostEquals(cloud.estimateFloorY(1), 0.30, 0.02)
  // The live floor is the current epoch's.
  assertAlmostEquals(cloud.groundEstimate()!.y, 0.30, 0.02)
  // And the floor of the epoch left behind is kept.
  const objects = cloud.groundObjects()
  assertEquals(objects.map((o) => o.epoch), [0, 1])
  assertAlmostEquals(objects[0].y, 0, 0.02)
  assertAlmostEquals(objects[1].y, 0.30, 0.02)
})

Deno.test('epochs: the floor of an epoch that has been left stays on record, locked as it was', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(80, 0.5, 4, 1300, 0.004), 1)
  const [old, live] = cloud.groundObjects()
  assertEquals(old.epoch, 0)
  assertEquals(old.locked, true)
  assertAlmostEquals(old.y, 0, 0.01)
  assertEquals(live.epoch, 1)
  assertEquals(live.locked, false)
})

Deno.test('epochs: an epoch with too few points to fit has no ground object', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(200, 0, 4, 41, 0.004), 0)
  feedAt(cloud, clock, floorPoints(10, 0.3, 4, 42, 0.004), 1)
  assertEquals(cloud.groundObjects().map((o) => o.epoch), [0])
  assertEquals(cloud.epochCounts().map((c) => c.epoch), [0, 1])
})

Deno.test('epochs: the ground object says it is level, and what frame it is in', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(200, -0.04, 4, 51, 0.004), 3)
  const ground = cloud.groundEstimate()!
  assertEquals(ground.normal, { x: 0, y: 1, z: 0 })
  assertEquals(ground.epoch, 3, 'a scan that begins in a later epoch fits its floor there')
  assertAlmostEquals(ground.y, -0.04, 0.01)
  // It is a copy: changing it does not change what the cloud reports next.
  ground.normal.y = 0 as never
  assertEquals(cloud.groundEstimate()!.normal, { x: 0, y: 1, z: 0 })
})

Deno.test('epochs: a late point of an earlier epoch is kept under its own epoch and does not move the live floor', () => {
  const { clock, cloud } = lockedAtZero()
  for (let i = 0; i < 8; i++) feedAt(cloud, clock, floorPoints(60, 0.2, 4, 1400 + i, 0.004), 1)
  const live = cloud.groundEstimate()!
  const countBefore = cloud.count
  // A straggler harvested in epoch 0, delivered after epoch 1 began.
  cloud.add(floorPoints(40, -3, 4, 1500), 0)
  clock.advance(600)
  assertEquals(cloud.currentEpoch, 1)
  assertEquals(cloud.count, countBefore + 40)
  assertEquals(cloud.epochCounts().find((c) => c.epoch === 0)!.count > 0, true)
  assertEquals(cloud.groundEstimate()!.y, live.y)
  assertEquals(cloud.groundEstimate()!.epoch, 1)
})

Deno.test('epochs: an epoch past what the per-point array holds is stored as its largest, never wrapped to a small one', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  cloud.add([{ x: 0, y: 0, z: 0 }], 65_535)
  cloud.add([{ x: 1, y: 0, z: 0 }], 65_536)
  cloud.add([{ x: 2, y: 0, z: 0 }], 70_000)
  assertEquals([...cloud.toEpochArray()], [65_535, 65_535, 65_535], 'wrapping would have filed these under epoch 0, 1 and 4464')
  assertEquals(cloud.currentEpoch, 65_535)
})

Deno.test('epochs: an epoch that is not a whole number counts as 0, or its integer part', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  cloud.add([{ x: 0, y: 0, z: 0 }], Number.NaN)
  cloud.add([{ x: 1, y: 0, z: 0 }], -2)
  cloud.add([{ x: 2, y: 0, z: 0 }], Number.POSITIVE_INFINITY)
  cloud.add([{ x: 3, y: 0, z: 0 }], 2.9)
  assertEquals([...cloud.toEpochArray()], [0, 0, 0, 2])
})

Deno.test('epochs: thinning the cloud to stay under its cap keeps every surviving point\'s own epoch', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  // Each point's x says which epoch it was added in (x = 0.1 * i, epoch = i % 3), so after the
  // thinning a survivor's epoch can be checked against its own position, not against its index.
  const batch: Array<{ x: number; y: number; z: number; }> = []
  const epochOfIndex = (i: number) => i % 3
  for (let i = 0; cloud.decimations === 0 && i < 140_000; i++) {
    batch.push({ x: i * 0.1, y: 0, z: 0 })
    if (batch.length === 500) {
      // One epoch per batch would not mix them; add each point under its own epoch.
      for (const p of batch) cloud.add([p], epochOfIndex(Math.round(p.x / 0.1)))
      batch.length = 0
    }
  }
  for (const p of batch) cloud.add([p], epochOfIndex(Math.round(p.x / 0.1)))
  assert(cloud.decimations >= 1, 'the cloud was never thinned, so this proves nothing')
  const positions = cloud.toFloat32Array()
  const epochs = cloud.toEpochArray()
  assertEquals(epochs.length, cloud.count)
  let wrong = 0
  for (let k = 0; k < cloud.count; k++) {
    if (epochs[k] !== epochOfIndex(Math.round(positions[k * 3] / 0.1))) wrong++
  }
  assertEquals(wrong, 0, `${wrong} of ${cloud.count} points carry another point's epoch`)
  assertEquals(cloud.epochCounts().reduce((n, c) => n + c.count, 0), cloud.count, 'the per-epoch counts still add up')
})

Deno.test('epochs: clear() forgets the epochs and the floors with the points', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(80, 0.5, 4, 1600, 0.004), 1)
  cloud.clear()
  assertEquals(cloud.currentEpoch, 0)
  assertEquals(cloud.epochCounts(), [])
  assertEquals(cloud.groundObjects(), [])
  assertEquals(cloud.groundEstimate(), null)
  assertEquals(cloud.toEpochArray().length, 0)
  // And the next scan, in epoch 0 again, starts clean.
  feedAt(cloud, clock, floorPoints(80, 0.2, 4, 1700, 0.004), 0)
  assertEquals(cloud.groundEstimate()!.epoch, 0)
})

Deno.test('epochs: a floor in an epoch with no points is 0 with fallback, not another epoch\'s', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(200, 0.7, 4, 61, 0.004), 0)
  assertEquals(cloud.estimateFloorY(5), 0)
})

// ── What each epoch's fit may and may not look at ───────────────────────────
//
// The fit reads the cloud four times (the height range, the band counts, the mean of the points
// round the chosen band, their spread) and once more for the fallback percentile. Each read has
// to leave the other epochs' points out, and a mixed cloud in which only one of them would show is
// a different cloud for each: these are those clouds.

/** `n` points up a wall, evenly spread in height from `from` to `to`, so no 5 cm band holds a share of them. */
function wallPoints(n: number, from: number, to: number) {
  return Array.from({ length: n }, (_, i) => ({ x: (i % 30) * 0.1, y: from + (i / (n - 1)) * (to - from), z: -2 }))
}

Deno.test('epochs: a large epoch does not raise the bar for a small one: a band must hold a share of its own epoch\'s points', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(3_000, 0, 4, 71, 0.004), 0)
  // 300 points: 90 on a floor at 0.30 (30 percent of them) and the rest up a wall.
  feedAt(cloud, clock, [...floorPoints(90, 0.30, 4, 72, 0.004), ...wallPoints(210, 0.6, 2.6)], 1)
  const live = cloud.groundEstimate()!
  assertEquals(live.epoch, 1)
  assertEquals(live.fallback, false, 'the share was measured against all 3 300 points: 132, and the floor holds 90')
  assertAlmostEquals(live.y, 0.30, 0.01)
  assert((live.inlierCount ?? 0) >= 85)
})

Deno.test('epochs: another epoch\'s dense layer below this epoch\'s stray points is not this epoch\'s floor', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(300, -0.5, 4, 73, 0.004), 0)
  // Epoch 1: a floor at 0 and four stray points at -0.5 (1.3 percent: not a surface).
  const strays = [0.1, 0.9, 1.7, 2.5].map((x) => ({ x, y: -0.5, z: 1 }))
  feedAt(cloud, clock, [...floorPoints(300, 0, 4, 74, 0.004), ...strays], 1)
  assertAlmostEquals(cloud.estimateFloorY(1), 0, 0.02, 'epoch 0\'s floor sat in the same band as the strays and made it one')
  assertAlmostEquals(cloud.groundEstimate()!.y, 0, 0.02)
})

Deno.test('epochs: a floor a few centimetres from the last epoch\'s is its own height, and its own spread, not their average', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(300, 0.02, 4, 75, 0.004), 0)
  feedAt(cloud, clock, floorPoints(300, 0.045, 4, 76, 0.004), 1)
  assertAlmostEquals(cloud.estimateFloorY(1), 0.045, 0.005, 'the old frame\'s points within 5 cm were averaged in')
  const live = cloud.groundEstimate()!
  assert((live.inlierCount ?? 0) <= 300, `${live.inlierCount} inliers from an epoch of 300 points`)
  assert((live.residualM ?? 1) < 0.01, `the spread was ${live.residualM}: the old frame's points were counted in it`)
})

Deno.test('epochs: with no structure to fit, the fallback is the percentile of the epoch\'s own points', () => {
  const clock = fakeClock()
  const cloud = new PointCloud(0.05, clock.now)
  feedAt(cloud, clock, floorPoints(300, 0, 4, 77, 0.004), 0)
  // 300 points at every height from 0.2 to 3.2 m: 60 bands of five, nothing near 4 percent.
  feedAt(cloud, clock, Array.from({ length: 300 }, (_, i) => ({ x: (i % 30) * 0.1, y: 0.2 + (i / 299) * 3.0, z: -1 })), 1)
  const live = cloud.groundEstimate()!
  assertEquals(live.fallback, true)
  assertAlmostEquals(cloud.estimateFloorY(1), 0.2 + 0.08 * 3.0, 0.1, 'the percentile of all 600 points is epoch 0\'s floor')
})

Deno.test('epochs: a new epoch\'s floor is judged on its own candidates: one 2 cm higher is not locked on the old frame\'s, and locks at its own height', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(60, 0.02, 4, 1800, 0.002), 1)
  assertEquals(cloud.groundEstimate()!.locked, false, 'one candidate of its own, on top of the old frame\'s five, is not a lock')
  for (let i = 1; i < 5; i++) feedAt(cloud, clock, floorPoints(60, 0.02, 4, 1800 + i, 0.002), 1)
  assertEquals(cloud.groundEstimate()!.locked, false, 'five are not six')
  feedAt(cloud, clock, floorPoints(60, 0.02, 4, 1806, 0.002), 1)
  const locked = cloud.groundEstimate()!
  assertEquals(locked.locked, true)
  assertAlmostEquals(locked.y, 0.02, 0.004, `the old frame's candidates were averaged into the lock: ${locked.y}`)
})

Deno.test('epochs: the sample count is the live epoch\'s points, not the cloud\'s', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(80, 0.4, 4, 1810, 0.002), 1)
  const inEpoch = cloud.epochCounts().find((c) => c.epoch === 1)!.count
  assert(cloud.count > inEpoch, 'precondition: the cloud holds more than the epoch does')
  assertEquals(cloud.groundEstimate()!.sampleCount, inEpoch)
})

Deno.test('epochs: stragglers of an earlier epoch are not new evidence for the live floor, however often they arrive', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(60, 0.3, 4, 1900, 0.004), 1)
  const first = cloud.groundEstimate()!
  assertEquals(first.locked, false)
  // Ten ticks of points from the epoch before, delivered late. Each used to be a recompute of the live floor,
  // which agrees with itself, and six agreeing estimates is a lock.
  for (let i = 0; i < 10; i++) feedAt(cloud, clock, floorPoints(30, -3 + i * 0.05, 4, 2000 + i), 0)
  const after = cloud.groundEstimate()!
  assertEquals(after.locked, false)
  assertEquals(after.sampleCount, first.sampleCount)
})

Deno.test('epochs: the ground objects handed out are copies, so a caller cannot change what the cloud keeps', () => {
  const { clock, cloud } = lockedAtZero()
  feedAt(cloud, clock, floorPoints(80, 0.5, 4, 1950, 0.004), 1)
  const [old] = cloud.groundObjects()
  old.y = 99
  old.normal.y = 0 as never
  const again = cloud.groundObjects()
  assertAlmostEquals(again[0].y, 0, 0.01)
  assertEquals(again[0].normal, { x: 0, y: 1, z: 0 })
})
