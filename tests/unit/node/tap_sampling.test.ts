/**
 * WP-05a: a tap is a burst of hits read as one measurement, and the fitted floor
 * is a second opinion on where it landed.
 *
 * Covers `sampleTap()` (src/ar/tap-sampling.ts) against a fake provider that
 * returns noisy hits frame by frame, the floor-ray, the vertical datum and the
 * floor-fit reliability rule (src/ar/ground-gate.ts), and the evidence and copy
 * a refused tap produces. Nothing here touches an AR runtime: the providers'
 * own bursts are in tap_burst_providers.test.ts.
 *
 * The ray maths is checked two ways that do not share code with it: numbers
 * worked out by hand, and three.js's own Raycaster on a PerspectiveCamera built
 * the way src/main.ts builds a capture camera.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tap_sampling.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  TAP_BURST_WINDOW_MS,
  TAP_MIN_HITS,
  TAP_MIN_INLIER_FRACTION,
  TAP_OUTLIER_K,
  TAP_OUTLIER_SCALE_FLOOR_M,
  TAP_RANGE_MAX_M,
  TAP_SPREAD_MAX_M,
  sampleTap,
  tapEvidence,
  tapLandmarkDatum,
  tapRefusalText,
  tapSurfaceY,
  type TapProgress,
  type TapProvider,
  type TapSample,
} from '../../../src/ar/tap-sampling.ts'
import {
  FLOOR_DATUM_AGREE_M,
  FLOOR_DATUM_FIT_ONLY_FLAG,
  FLOOR_DATUM_SINGLE_TAP_FLAG,
  FLOOR_FIT_MAX_RESIDUAL_M,
  FLOOR_FIT_MIN_INLIERS,
  FLOOR_RAY_AGREE_M,
  floorFitIsReliable,
  floorRayAgrees,
  floorRayPoint,
  landmarkDatum,
  type GroundReading,
} from '../../../src/ar/ground-gate.ts'
import { BURST_POSE_JUMP_M } from '../../../src/ar/tracking-quality.ts'
import type { HitBurstFrame, HitResult, Pose } from '../../../src/ar/provider.ts'
import type { Vec3 } from '../../../src/world/types.ts'

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ORIGIN_POSE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

function hit(position: Vec3, distance = 2): HitResult {
  return { position, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance }
}

function frame(h: HitResult | null, extra: Partial<HitBurstFrame> = {}): HitBurstFrame {
  return { hit: h, status: 'NORMAL', ...extra }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** mulberry32: a seeded generator, so every number below is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
}

function noisy(truth: Vec3, sigma: number, rand: () => number): Vec3 {
  return { x: truth.x + sigma * gaussian(rand), y: truth.y + sigma * gaussian(rand), z: truth.z + sigma * gaussian(rand) }
}

interface FakeOptions {
  /** When set the provider has a burst that returns these frames. Without it, it has none. */
  frames?: HitBurstFrame[]
  /** What the provider's own synchronous hit test answers. */
  single?: HitResult | null
  pose?: Pose
  fovY?: number
  aspect?: number
  status?: string
  /** A burst that throws. */
  burstThrows?: boolean
}

function fake(o: FakeOptions = {}): { provider: TapProvider; windows: number[] } {
  const windows: number[] = []
  const provider: TapProvider = {
    hitTest: () => o.single ?? null,
    getPose: () => o.pose ?? ORIGIN_POSE,
    getCameraFovY: () => o.fovY ?? 60,
    getCameraAspect: () => o.aspect ?? 0.5625,
    trackingStatus: () => (o.status ?? 'NORMAL') as ReturnType<TapProvider['trackingStatus']>,
  }
  if (o.frames || o.burstThrows) {
    provider.hitTestBurstAsync = async (_x, _y, windowMs) => {
      windows.push(windowMs)
      if (o.burstThrows) throw new Error('the burst failed')
      return { frames: o.frames ?? [] }
    }
  }
  return { provider, windows }
}

function ok(result: Awaited<ReturnType<typeof sampleTap>>): TapSample {
  assert.equal(result.ok, true, `expected a tap, got ${JSON.stringify(result)}`)
  return result as TapSample
}

function refused(result: Awaited<ReturnType<typeof sampleTap>>) {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`)
  return result as Extract<Awaited<ReturnType<typeof sampleTap>>, { ok: false }>
}

const TRUTH: Vec3 = { x: 0.4, y: -1.2, z: -1.6 }

// ─── The limits are the ones the work package names ────────────────────────

test('the adopted limits are the work package starting values', () => {
  assert.equal(TAP_BURST_WINDOW_MS, 450)
  assert.equal(TAP_SPREAD_MAX_M, 0.04)
  assert.equal(TAP_RANGE_MAX_M, 3)
  assert.equal(TAP_MIN_HITS, 3)
  assert.equal(TAP_MIN_INLIER_FRACTION, 0.6)
})

// ─── The median ────────────────────────────────────────────────────────────

test('a burst of noisy hits gives a median within 1 cm of the truth', async () => {
  const rand = rng(11)
  const frames = Array.from({ length: 12 }, () => frame(hit(noisy(TRUTH, 0.008, rand))))
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.ok(dist(tap.position, TRUTH) < 0.01, `${dist(tap.position, TRUTH)} m off`)
  assert.equal(tap.source, 'burst')
  assert.equal(tap.n, 12)
  assert.equal(tap.rejected, 0)
})

test('over many seeded bursts the median cuts a single hit\'s error by more than half', async () => {
  const trials = 300
  let sampledSq = 0
  let singleSq = 0
  let taken = 0
  for (let seed = 1; seed <= trials; seed++) {
    const rand = rng(seed)
    const frames = Array.from({ length: 12 }, () => frame(hit(noisy(TRUTH, 0.008, rand))))
    const result = await sampleTap(fake({ frames }).provider, 0.5, 0.6)
    if (!result.ok) continue
    taken++
    sampledSq += dist(result.position, TRUTH) ** 2
    singleSq += dist(frames[0].hit!.position, TRUTH) ** 2
  }
  assert.ok(taken >= trials - 3, `${trials - taken} of ${trials} clean bursts were refused`)
  const sampled = Math.sqrt(sampledSq / taken)
  const single = Math.sqrt(singleSq / taken)
  assert.ok(sampled < 0.5 * single, `sampled ${sampled} m rms against a single hit's ${single} m`)
  assert.ok(sampled < 0.01, `${sampled} m rms`)
})

test('the position is the per-axis median, not the mean and not the first hit', async () => {
  // Three of five hits agree on every axis; the other two are 0.8 cm either side on x and z. The median of
  // each axis is the agreeing value, while the mean of x would be pulled to 0.0.
  const base = { x: 1, y: 0, z: -1 }
  const frames = [
    frame(hit({ x: 1.008, y: 0, z: -1.008 })),
    frame(hit(base)),
    frame(hit(base)),
    frame(hit({ x: 1, y: 0.004, z: -1 })),
    frame(hit(base)),
  ]
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.5))
  assert.deepEqual(tap.position, base)
})

// ─── Outliers ──────────────────────────────────────────────────────────────

test('clean bursts are hardly ever thinned or refused: the cutoff is not so tight that noise looks like strays', async () => {
  // 12 hits at 1 cm per axis, the case the cutoff was chosen on. A cutoff of 3 robust deviations loses about 6 % of
  // the genuine hits and refuses about 1 burst in 480; 3.5 loses about 3 % and refuses about 1 in 4,500.
  const trials = 4000
  let refusals = 0
  let rejected = 0
  let accepted = 0
  for (let seed = 1000; seed < 1000 + trials; seed++) {
    const rand = rng(seed)
    const frames = Array.from({ length: 12 }, () => frame(hit(noisy(TRUTH, 0.01, rand))))
    const result = await sampleTap(fake({ frames }).provider, 0.5, 0.6)
    if (!result.ok) {
      refusals++
      continue
    }
    accepted++
    rejected += result.rejected
  }
  const lost = rejected / (accepted * 12)
  assert.ok(lost < 0.045, `${(lost * 100).toFixed(2)} % of the genuine hits were thrown away`)
  assert.ok(lost > 0.01, `${(lost * 100).toFixed(2)} %: the rule is not rejecting anything at all`)
  assert.ok(refusals <= 4, `${refusals} of ${trials} clean bursts were refused`)
})

test('hits that disagree with the rest are rejected, and the tap is not refused for them', async () => {
  const rand = rng(5)
  const hits = Array.from({ length: 12 }, () => noisy(TRUTH, 0.005, rand))
  hits[3] = { x: TRUTH.x + 0.4, y: TRUTH.y + 0.02, z: TRUTH.z }
  hits[8] = { x: TRUTH.x - 0.05, y: TRUTH.y + 0.25, z: TRUTH.z - 0.3 }
  const frames = hits.map((p) => frame(hit(p)))

  const mean = {
    x: hits.reduce((s, p) => s + p.x, 0) / 12,
    y: hits.reduce((s, p) => s + p.y, 0) / 12,
    z: hits.reduce((s, p) => s + p.z, 0) / 12,
  }
  assert.ok(dist(mean, TRUTH) > 0.03, 'the fixture must be one a plain average gets wrong')

  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(tap.n + tap.rejected, 12)
  assert.ok(tap.rejected >= 2 && tap.rejected <= 3, `${tap.rejected} rejected: the two strays, and at most one genuine hit`)
  assert.ok(dist(tap.position, TRUTH) < 0.01, `${dist(tap.position, TRUTH)} m off`)
  assert.ok((tap.spreadM as number) < 0.02, `the kept hits scatter ${tap.spreadM} m`)

  // Without the rejection the strays alone would have refused this burst.
  const unrejected = Math.sqrt(hits.reduce((s, p) => s + dist(p, tap.position) ** 2, 0) / hits.length)
  assert.ok(unrejected > TAP_SPREAD_MAX_M, `${unrejected} m would have been the scatter`)
})

test('a burst where more than 40 percent of the hits had to go is refused as unsteady', async () => {
  // 7 identical hits and 5 that sit 6 cm away: the 7 are a bare majority, not an answer.
  const at = { x: 0, y: -1.2, z: -2 }
  const frames = [
    ...Array.from({ length: 7 }, () => frame(hit(at))),
    ...Array.from({ length: 5 }, () => frame(hit({ x: 0.06, y: -1.2, z: -2 }))),
  ]
  assert.ok(7 / 12 < TAP_MIN_INLIER_FRACTION)
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'unsteady')
  assert.equal(refusal.n, 7)
})

test('8 of 12 agreeing hits are enough, and the 4 that disagreed are counted', async () => {
  const at = { x: 0, y: -1.2, z: -2 }
  const frames = [
    ...Array.from({ length: 8 }, () => frame(hit(at))),
    ...Array.from({ length: 4 }, () => frame(hit({ x: 0.06, y: -1.2, z: -2 }))),
  ]
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(tap.n, 8)
  assert.equal(tap.rejected, 4)
  assert.deepEqual(tap.position, at)
})

// ─── Spread ────────────────────────────────────────────────────────────────

/** Four hits at x = -d, -d, d, d: the median is the middle and every hit is exactly d from it. */
function symmetric(d: number): HitBurstFrame[] {
  return [-d, -d, d, d].map((x) => frame(hit({ x, y: -1.2, z: -2 })))
}

test('a burst that scatters just inside the limit is accepted, and reports its scatter', async () => {
  const tap = ok(await sampleTap(fake({ frames: symmetric(0.0399) }).provider, 0.5, 0.6))
  assert.ok(Math.abs((tap.spreadM as number) - 0.0399) < 1e-9, `${tap.spreadM}`)
})

test('a burst that scatters just past the limit is refused, naming the scatter', async () => {
  const refusal = refused(await sampleTap(fake({ frames: symmetric(0.0401) }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'unsteady')
  assert.ok(Math.abs((refusal.spreadM as number) - 0.0401) < 1e-9, `${refusal.spreadM}`)
})

test('a scatter exactly at the limit is accepted (the limit is the most allowed, not the least refused)', async () => {
  // Hits at +-0.25 m: every one is exactly 0.25 m from the median, and 0.25 is exact in binary.
  const tap = ok(await sampleTap(fake({ frames: symmetric(0.25) }).provider, 0.5, 0.6, { spreadMaxM: 0.25 }))
  assert.equal(tap.spreadM, 0.25)
})

test('the scatter limit can be tightened or loosened for a device run', async () => {
  const frames = symmetric(0.03)
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6, { spreadMaxM: 0.02 })).reason, 'unsteady')
  assert.equal(ok(await sampleTap(fake({ frames: symmetric(0.06) }).provider, 0.5, 0.6, { spreadMaxM: 0.08 })).n, 4)
})

// ─── Range ─────────────────────────────────────────────────────────────────

function burstAtRange(distance: number): HitBurstFrame[] {
  return Array.from({ length: 6 }, () => frame(hit({ x: 0, y: -1.2, z: -distance }, distance)))
}

test('a spot exactly at the range limit is accepted', async () => {
  const tap = ok(await sampleTap(fake({ frames: burstAtRange(TAP_RANGE_MAX_M) }).provider, 0.5, 0.6))
  assert.equal(tap.rangeM, TAP_RANGE_MAX_M)
})

test('a spot beyond the range limit is refused, with the range it read', async () => {
  const refusal = refused(await sampleTap(fake({ frames: burstAtRange(3.2) }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'too-far')
  assert.equal(refusal.rangeM, 3.2)
  assert.equal(tapRefusalText(refusal), 'That spot is 3.2 m away. Move closer and tap again.')
})

test('a far tap is told to move closer, whatever else is wrong with it', async () => {
  // Far taps are noisy because they are far: the actionable word is the range.
  const wide = [-0.2, -0.2, 0.2, 0.2].map((x) => frame(hit({ x, y: -1.2, z: -4 }, 4)))
  assert.equal(refused(await sampleTap(fake({ frames: wide }).provider, 0.5, 0.6)).reason, 'too-far')
})

test('the range limit can be overridden', async () => {
  assert.equal(ok(await sampleTap(fake({ frames: burstAtRange(3.2) }).provider, 0.5, 0.6, { rangeMaxM: 4 })).rangeM, 3.2)
})

test('where the runtime gave no distance the range is measured from the frame\'s own pose', async () => {
  const pose: Pose = { position: { x: 0, y: -0.2, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  const frames = Array.from({ length: 6 }, () => frame(hit({ x: 0, y: -1.2, z: -4 }, Number.NaN), { pose }))
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'too-far')
  assert.ok(Math.abs((refusal.rangeM as number) - Math.hypot(1, 4)) < 1e-9, `${refusal.rangeM}`)
})

test('with neither a distance nor a frame pose the range is measured from the provider\'s current pose', async () => {
  const frames = Array.from({ length: 6 }, () => frame(hit({ x: 0, y: -1.2, z: -1 }, Number.NaN)))
  const tap = ok(await sampleTap(fake({ frames, pose: ORIGIN_POSE }).provider, 0.5, 0.6))
  assert.ok(Math.abs(tap.rangeM - Math.hypot(1.2, 1)) < 1e-9, `${tap.rangeM}`)
})

test('a range that cannot be measured at all is refused, with no number invented', async () => {
  const frames = Array.from({ length: 6 }, () => frame(hit({ x: 0, y: -1.2, z: -1 }, Number.NaN)))
  const provider = fake({ frames }).provider
  provider.getPose = () => {
    throw new Error('no pose yet')
  }
  const refusal = refused(await sampleTap(provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'too-far')
  assert.equal(refusal.rangeM, undefined)
  assert.equal(tapRefusalText(refusal), 'Move closer to that spot and tap again.')
})

// ─── Degenerate bursts are results, not crashes ────────────────────────────

test('a burst with no hit in any frame is refused as no-hit', async () => {
  const frames = Array.from({ length: 10 }, () => frame(null))
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'no-hit')
  assert.equal(refusal.n, 0)
})

test('fewer than three hits are refused, not averaged', async () => {
  const at = { x: 0, y: -1.2, z: -2 }
  const frames = [frame(hit(at)), frame(null), frame(hit(at)), frame(null)]
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'too-few-hits')
  assert.equal(refusal.n, 2)
  assert.equal(TAP_MIN_HITS, 3)
})

test('three hits are enough', async () => {
  const at = { x: 0, y: -1.2, z: -2 }
  const tap = ok(await sampleTap(fake({ frames: [frame(hit(at)), frame(null), frame(hit(at)), frame(hit(at))] }).provider, 0.5, 0.6))
  assert.equal(tap.n, 3)
})

test('identical hits are a valid burst with a scatter of zero, and no NaN anywhere', async () => {
  const at = { x: 0.25, y: -1.2, z: -2 }
  const tap = ok(await sampleTap(fake({ frames: Array.from({ length: 12 }, () => frame(hit(at))) }).provider, 0.5, 0.6))
  assert.deepEqual(tap.position, at)
  assert.equal(tap.spreadM, 0)
  assert.equal(tap.n, 12)
  assert.equal(tap.rejected, 0)
  assert.ok(Number.isFinite(tap.rangeM))
})

test('hits that are not finite numbers are dropped and counted, never averaged in', async () => {
  const rand = rng(21)
  const good = Array.from({ length: 9 }, () => frame(hit(noisy(TRUTH, 0.004, rand))))
  const bad = [
    frame(hit({ x: Number.NaN, y: -1.2, z: -2 })),
    frame(hit({ x: 0, y: Number.POSITIVE_INFINITY, z: -2 })),
    frame(hit({ x: 0, y: -1.2, z: Number.NEGATIVE_INFINITY })),
  ]
  const tap = ok(await sampleTap(fake({ frames: [...bad, ...good] }).provider, 0.5, 0.6))
  assert.equal(tap.n, 9)
  assert.equal(tap.rejected, 3)
  for (const axis of ['x', 'y', 'z'] as const) assert.ok(Number.isFinite(tap.position[axis]))
  assert.ok(dist(tap.position, TRUTH) < 0.01)
})

test('a burst of nothing but non-finite hits is refused as no-hit', async () => {
  const frames = Array.from({ length: 8 }, () => frame(hit({ x: Number.NaN, y: Number.NaN, z: Number.NaN })))
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'no-hit')
})

// ─── Tracking ──────────────────────────────────────────────────────────────

function steadyFrames(n = 8): HitBurstFrame[] {
  return Array.from({ length: n }, () => frame(hit({ x: 0, y: -1.2, z: -2 })))
}

test('a burst in which tracking was LIMITED at any frame is refused, whatever the hits say', async () => {
  const frames = steadyFrames()
  frames[5] = { ...frames[5], status: 'LIMITED' }
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'tracking')
  assert.equal(tapRefusalText(refusal), 'Hold still, tracking is recovering')
})

test('a frame whose reason reads RELOCALIZING is refused although its status reads NORMAL', async () => {
  const frames = steadyFrames()
  frames[2] = { ...frames[2], reason: 'RELOCALIZING' }
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'tracking')
})

test('a frame shift inside the burst is refused, even with every status NORMAL', async () => {
  const frames = steadyFrames().map((f, i) => ({ ...f, poseJumps: i < 4 ? 0 : 1 }))
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'tracking')
})

test('a count of frame shifts that did not move during the burst is not a disturbance', async () => {
  const frames = steadyFrames().map((f) => ({ ...f, poseJumps: 3 }))
  assert.equal(ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).n, 8)
})

test('a runtime that publishes no status (WebXR) is not refused for it', async () => {
  const frames = steadyFrames().map((f) => ({ ...f, status: 'UNKNOWN' }))
  assert.equal(ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).n, 8)
})

test('an UNSPECIFIED status is refused as tracking, not read as healthy', async () => {
  const frames = steadyFrames().map((f) => ({ ...f, status: 'UNSPECIFIED' }))
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'tracking')
})

test('a provider with no burst is held to the same rule through its own status', async () => {
  const single = hit({ x: 0, y: -1.2, z: -2 })
  assert.equal(refused(await sampleTap(fake({ single, status: 'LIMITED' }).provider, 0.5, 0.6)).reason, 'tracking')
  assert.equal(ok(await sampleTap(fake({ single, status: 'NORMAL' }).provider, 0.5, 0.6)).source, 'single-hit')
})

// ─── A provider without a burst ────────────────────────────────────────────

test('a provider with no burst is read with one hit, through the host\'s hit test when it is given one', async () => {
  const viaHost = hit({ x: 1, y: -1.2, z: -2 })
  const viaProvider = hit({ x: 9, y: 9, z: 9 })
  const tap = ok(await sampleTap(fake({ single: viaProvider }).provider, 0.5, 0.6, { singleHit: async () => viaHost }))
  assert.deepEqual(tap.position, viaHost.position)
  assert.equal(tap.source, 'single-hit')
  assert.equal(tap.n, 1)
  assert.equal(tap.rejected, 0)
  assert.equal(tap.spreadM, null)
  assert.equal(tap.rangeM, 2)
})

test('without a host hit test the provider\'s own is used', async () => {
  const tap = ok(await sampleTap(fake({ single: hit({ x: 1, y: -1.2, z: -2 }) }).provider, 0.5, 0.6))
  assert.equal(tap.position.x, 1)
})

test('one hit that finds nothing, or throws, is a refusal, not an exception', async () => {
  assert.equal(refused(await sampleTap(fake({ single: null }).provider, 0.5, 0.6)).reason, 'no-hit')
  const throwing = await sampleTap(fake().provider, 0.5, 0.6, {
    singleHit: async () => {
      throw new Error('the engine fell over')
    },
  })
  assert.equal(refused(throwing).reason, 'no-hit')
})

test('one far hit is refused for its range, as a burst would be', async () => {
  const refusal = refused(await sampleTap(fake({ single: hit({ x: 0, y: -1.2, z: -5 }, 5) }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'too-far')
})

test('a burst that saw no frame at all falls back to one hit, and says so in the source', async () => {
  const single = hit({ x: 0.5, y: -1.2, z: -2 })
  const empty = await sampleTap(fake({ frames: [], single }).provider, 0.5, 0.6)
  assert.equal(ok(empty).source, 'single-hit')
  const thrown = await sampleTap(fake({ burstThrows: true, single }).provider, 0.5, 0.6)
  assert.equal(ok(thrown).source, 'single-hit')
})

test('a burst that saw frames but no hit is no-hit, not a retry with one hit', async () => {
  const frames = Array.from({ length: 6 }, () => frame(null))
  const result = await sampleTap(fake({ frames, single: hit({ x: 0, y: -1.2, z: -2 }) }).provider, 0.5, 0.6)
  assert.equal(refused(result).reason, 'no-hit')
})

// ─── The window ────────────────────────────────────────────────────────────

test('the burst is asked for 450 ms by default, and never for longer', async () => {
  const a = fake({ frames: steadyFrames() })
  await sampleTap(a.provider, 0.5, 0.6)
  await sampleTap(a.provider, 0.5, 0.6, { windowMs: 5000 })
  await sampleTap(a.provider, 0.5, 0.6, { windowMs: 200 })
  await sampleTap(a.provider, 0.5, 0.6, { windowMs: -10 })
  assert.deepEqual(a.windows, [450, 450, 200, 0])
})

test('the coordinates reach the provider untouched', async () => {
  const seen: Array<[number, number]> = []
  const provider = fake({ frames: steadyFrames() }).provider
  provider.hitTestBurstAsync = async (x, y) => {
    seen.push([x, y])
    return { frames: steadyFrames() }
  }
  await sampleTap(provider, 0.31, 0.77)
  assert.deepEqual(seen, [[0.31, 0.77]])
})

// ─── The floor ray ─────────────────────────────────────────────────────────

/** A three.js camera built the way src/main.ts builds a capture camera, and its ray to the plane y = floorY. */
function threeFloorPoint(pose: Pose, fovY: number, aspect: number, x: number, y: number, floorY: number): Vec3 | null {
  const camera = new THREE.PerspectiveCamera(fovY, aspect, 0.01, 1000)
  camera.position.set(pose.position.x, pose.position.y, pose.position.z)
  camera.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
  camera.updateMatrixWorld(true)
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), camera)
  const out = new THREE.Vector3()
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY), out)
    ? { x: out.x, y: out.y, z: out.z }
    : null
}

function poseFromEuler(position: Vec3, pitchDeg: number, yawDeg: number, rollDeg = 0): Pose {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler((pitchDeg * Math.PI) / 180, (yawDeg * Math.PI) / 180, (rollDeg * Math.PI) / 180, 'YXZ'),
  )
  return { position, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

test('floor ray: the centre pixel of a camera pitched 45 degrees down at 1.5 m meets the floor 1.5 m ahead', () => {
  // Worked by hand: forward is (0, -sin 45, -cos 45); t = 1.5 / sin 45; the point is (0, 0, -1.5).
  const half = Math.sin(Math.PI / 8)
  const camera = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: -half, y: 0, z: 0, w: Math.cos(Math.PI / 8) }, fovYDeg: 60, aspect: 0.5 }
  const point = floorRayPoint(camera, 0.5, 0.5, 0)!
  assert.ok(Math.abs(point.position.x) < 1e-12)
  assert.equal(point.position.y, 0)
  assert.ok(Math.abs(point.position.z + 1.5) < 1e-12, `${point.position.z}`)
  assert.ok(Math.abs(point.rangeM - 2.121320343559643) < 1e-12, `${point.rangeM}`)
})

test('floor ray: an off-centre pixel of a level camera matches the hand-worked point', () => {
  // Camera at (1, 1.2, -2) looking down -Z, fovY 60, aspect 0.5625, pixel (0.75, 0.8): the ray's direction is
  // (0.5 * 0.5625 * tan 30, -0.6 * tan 30, -1) = (0.16238, -0.34641, -1), t = 1.2 / 0.34641 = 3.4641.
  const camera = { position: { x: 1, y: 1.2, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, fovYDeg: 60, aspect: 0.5625 }
  const point = floorRayPoint(camera, 0.75, 0.8, 0)!
  assert.ok(Math.abs(point.position.x - 1.5625) < 1e-9, `${point.position.x}`)
  assert.ok(Math.abs(point.position.z + 5.464101615137754) < 1e-9, `${point.position.z}`)
  assert.ok(Math.abs(point.rangeM - 3.7089629615298123) < 1e-9, `${point.rangeM}`)
})

test('floor ray: a yawed, pitched camera matches the hand-worked points', () => {
  // Yaw 90 degrees about +Y after a 33 degree pitch down; camera (0.4, 1.5, 0.2); fovY 62, aspect 0.75.
  const q = { x: -0.20082917620117852, y: 0.6779879364607868, z: 0.2008291762011785, w: 0.6779879364607869 }
  const camera = { position: { x: 0.4, y: 1.5, z: 0.2 }, rotation: q, fovYDeg: 62, aspect: 0.75 }
  const centre = floorRayPoint(camera, 0.5, 0.5, 0)!
  assert.ok(Math.abs(centre.position.x + 1.9097974457218738) < 1e-9)
  assert.ok(Math.abs(centre.position.z - 0.2) < 1e-9)
  assert.ok(Math.abs(centre.rangeM - 2.7541176881649942) < 1e-9)
  const off = floorRayPoint(camera, 0.3, 0.65, 0)!
  assert.ok(Math.abs(off.position.x + 1.1963156271725315) < 1e-9)
  assert.ok(Math.abs(off.position.z - 0.58859004915548) < 1e-9)
  assert.ok(Math.abs(off.rangeM - 2.224685552579935) < 1e-9)
})

test('floor ray: agrees with three.js on two hundred random poses, pixels and floors', () => {
  const rand = rng(99)
  let checked = 0
  for (let i = 0; i < 200; i++) {
    const pose = poseFromEuler(
      { x: (rand() - 0.5) * 4, y: 0.8 + rand() * 1.2, z: (rand() - 0.5) * 4 },
      -10 - rand() * 70,
      rand() * 360,
      (rand() - 0.5) * 20,
    )
    const fovY = 45 + rand() * 40
    const aspect = 0.45 + rand() * 1.2
    const x = rand()
    const y = rand()
    const floorY = (rand() - 0.5) * 0.3
    const expected = threeFloorPoint(pose, fovY, aspect, x, y, floorY)
    const actual = floorRayPoint({ ...pose, fovYDeg: fovY, aspect }, x, y, floorY)
    if (!expected) {
      assert.equal(actual, null, 'three.js sees no floor point, so neither may we')
      continue
    }
    assert.ok(actual, 'three.js sees a floor point')
    assert.ok(dist(actual.position, expected) < 1e-9, `${dist(actual.position, expected)} m apart`)
    const camera = new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z)
    assert.ok(Math.abs(actual.rangeM - camera.distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z))) < 1e-9)
    checked++
  }
  assert.ok(checked > 100, `only ${checked} of 200 poses saw the floor`)
})

test('floor ray: a quaternion that is not unit length gives the same answer as one that is', () => {
  const pose = poseFromEuler({ x: 0, y: 1.5, z: 0 }, -40, 30)
  const exact = floorRayPoint({ ...pose, fovYDeg: 60, aspect: 0.6 }, 0.4, 0.7, 0)!
  const scaled = floorRayPoint(
    { ...pose, rotation: { x: pose.rotation.x * 3, y: pose.rotation.y * 3, z: pose.rotation.z * 3, w: pose.rotation.w * 3 }, fovYDeg: 60, aspect: 0.6 },
    0.4, 0.7, 0,
  )!
  assert.ok(dist(exact.position, scaled.position) < 1e-12)
})

test('floor ray: no point where there is none to find', () => {
  const down = poseFromEuler({ x: 0, y: 1.5, z: 0 }, -45, 0)
  const cam = { ...down, fovYDeg: 60, aspect: 0.6 }
  assert.ok(floorRayPoint(cam, 0.5, 0.5, 0), 'the control case sees the floor')
  // Looking up.
  assert.equal(floorRayPoint({ ...poseFromEuler({ x: 0, y: 1.5, z: 0 }, 30, 0), fovYDeg: 60, aspect: 0.6 }, 0.5, 0.5, 0), null)
  // Level: the ray never descends.
  assert.equal(floorRayPoint({ ...poseFromEuler({ x: 0, y: 1.5, z: 0 }, 0, 0), fovYDeg: 60, aspect: 0.6 }, 0.5, 0.5, 0), null)
  // At or below the floor.
  assert.equal(floorRayPoint({ ...cam, position: { x: 0, y: 0, z: 0 } }, 0.5, 0.5, 0), null)
  assert.equal(floorRayPoint({ ...cam, position: { x: 0, y: -0.2, z: 0 } }, 0.5, 0.5, 0), null)
  // Not numbers, not a lens, not a rotation.
  assert.equal(floorRayPoint(cam, Number.NaN, 0.5, 0), null)
  assert.equal(floorRayPoint(cam, 0.5, 0.5, Number.POSITIVE_INFINITY), null)
  assert.equal(floorRayPoint({ ...cam, fovYDeg: 0 }, 0.5, 0.5, 0), null)
  assert.equal(floorRayPoint({ ...cam, fovYDeg: 180 }, 0.5, 0.5, 0), null)
  assert.equal(floorRayPoint({ ...cam, aspect: 0 }, 0.5, 0.5, 0), null)
  assert.equal(floorRayPoint({ ...cam, rotation: { x: 0, y: 0, z: 0, w: 0 } }, 0.5, 0.5, 0), null)
  assert.equal(floorRayPoint({ ...cam, position: { x: Number.NaN, y: 1.5, z: 0 } }, 0.5, 0.5, 0), null)
})

// ─── The floor fit: when it can be trusted ─────────────────────────────────

const GOOD_FLOOR: GroundReading = { y: 0, locked: true, inlierCount: 400, residualM: 0.012, fallback: false }

test('a locked, well-supported, level fit is reliable', () => {
  assert.equal(floorFitIsReliable(GOOD_FLOOR), true)
})

test('a fit is not reliable when it is unlocked, a fallback, thin, tilted, or missing its diagnostics', () => {
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, locked: false }), false)
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, fallback: true }), false)
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, inlierCount: FLOOR_FIT_MIN_INLIERS - 1 }), false)
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, residualM: FLOOR_FIT_MAX_RESIDUAL_M + 0.001 }), false)
  assert.equal(floorFitIsReliable({ y: 0, locked: true }), false)
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, residualM: Number.NaN }), false)
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, y: Number.NaN }), false)
  assert.equal(floorFitIsReliable(null), false)
  assert.equal(floorFitIsReliable(undefined), false)
})

test('the edges of reliability are inclusive', () => {
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, residualM: FLOOR_FIT_MAX_RESIDUAL_M }), true)
  assert.equal(floorFitIsReliable({ ...GOOD_FLOOR, inlierCount: FLOOR_FIT_MIN_INLIERS }), true)
  assert.equal(FLOOR_FIT_MAX_RESIDUAL_M, 0.02)
})

// ─── A tap on the floor whose feature hit slid along the ray ───────────────

/**
 * The scene the work package describes. The camera is 1.5 m up, 33 degrees below the horizon, yawed 25 degrees.
 * The tap's pixel has a true floor point; the feature hits are on the same ray but `slide` metres short of it, as
 * a feature snapped to something above the skirting would be.
 */
const CAM_POSE = poseFromEuler({ x: 0.3, y: 1.5, z: 0.1 }, -33, 25)
const FOV = 62
const ASPECT = 0.75
const PIXEL = { x: 0.5, y: 0.62 }
const FLOOR_TRUTH = threeFloorPoint(CAM_POSE, FOV, ASPECT, PIXEL.x, PIXEL.y, 0)!

function alongRay(slideM: number): Vec3 {
  const toTruth = {
    x: FLOOR_TRUTH.x - CAM_POSE.position.x,
    y: FLOOR_TRUTH.y - CAM_POSE.position.y,
    z: FLOOR_TRUTH.z - CAM_POSE.position.z,
  }
  const length = Math.hypot(toTruth.x, toTruth.y, toTruth.z)
  const k = (length - slideM) / length
  return { x: CAM_POSE.position.x + toTruth.x * k, y: CAM_POSE.position.y + toTruth.y * k, z: CAM_POSE.position.z + toTruth.z * k }
}

function slidFrames(slideM: number, n = 12, seed = 3): HitBurstFrame[] {
  const rand = rng(seed)
  return Array.from({ length: n }, () => {
    const p = noisy(alongRay(slideM), 0.003, rand)
    return frame(hit(p, dist(p, CAM_POSE.position)), { pose: CAM_POSE })
  })
}

function sceneProvider(frames: HitBurstFrame[]): TapProvider {
  return fake({ frames, pose: CAM_POSE, fovY: FOV, aspect: ASPECT }).provider
}

test('the scene is as steep as the work package assumes, and the fixture\'s snap is a real one', () => {
  assert.ok(FLOOR_TRUTH.y === 0)
  const snapped = alongRay(0.35)
  assert.ok(dist(snapped, FLOOR_TRUTH) > 0.3, 'the snapped hit must be far from the floor point')
  // The snap is along the ray: the floor ray through the same pixel does not move.
  assert.ok(floorRayPoint({ ...CAM_POSE, fovYDeg: FOV, aspect: ASPECT }, PIXEL.x, PIXEL.y, 0)!.position.x - FLOOR_TRUTH.x < 1e-9)
})

test('floor ray: an along-ray snap of 35 cm is recovered to under 1 cm', () => {
  const point = floorRayPoint({ ...CAM_POSE, fovYDeg: FOV, aspect: ASPECT }, PIXEL.x, PIXEL.y, 0)!
  assert.ok(dist(point.position, FLOOR_TRUTH) < 0.01, `${dist(point.position, FLOOR_TRUTH)} m off`)
  for (const slide of [-0.3, 0.1, 0.35, 0.6]) {
    assert.ok(dist(alongRay(slide), FLOOR_TRUTH) > 0.09, `a ${slide} m slide is not a snap worth testing`)
  }
})

test('cross-check (the default): the feature hits set the position and the floor ray says they slid', async () => {
  const tap = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR }))
  assert.equal(tap.source, 'burst')
  assert.ok(dist(tap.position, FLOOR_TRUTH) > 0.25, 'the position is still the snapped hits\'')
  assert.ok(tap.floorRay, 'a reliable floor gives a floor ray')
  assert.ok(dist(tap.floorRay.position, FLOOR_TRUTH) < 0.01, `${dist(tap.floorRay.position, FLOOR_TRUTH)} m off`)
  assert.ok(tap.floorRay.deltaM > 0.25, `${tap.floorRay.deltaM}`)
  assert.equal(tap.floorRay.agrees, false)
})

test('cross-check: hits that did not slide agree with the floor ray', async () => {
  const tap = ok(await sampleTap(sceneProvider(slidFrames(0.0)), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR }))
  assert.ok(tap.floorRay!.deltaM < FLOOR_RAY_AGREE_M, `${tap.floorRay!.deltaM}`)
  assert.equal(tap.floorRay!.agrees, true)
})

test('prefer: the floor ray sets the position to under 1 cm of the truth, and the hits only gate it', async () => {
  const tap = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer' }))
  assert.equal(tap.source, 'floor-ray')
  assert.ok(dist(tap.position, FLOOR_TRUTH) < 0.01, `${dist(tap.position, FLOOR_TRUTH)} m off`)
  assert.ok(Math.abs(tap.rangeM - CAM_POSE.position.y / Math.sin((33 * Math.PI) / 180)) < 0.6, 'range is the floor ray\'s')
  assert.equal(tap.n, 12, 'the hits are still counted')
  assert.ok((tap.spreadM as number) < 0.02, 'and still measure the surface\'s steadiness')
  assert.equal(tap.floorRay!.agrees, false, 'and the disagreement is still reported')
})

test('prefer with a fit that cannot be trusted leaves the hits in charge', async () => {
  const hitsOnly = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y))
  for (const floor of [null, { ...GOOD_FLOOR, locked: false }, { ...GOOD_FLOOR, residualM: 0.04 }, { ...GOOD_FLOOR, fallback: true }]) {
    const tap = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor, floorRay: 'prefer' }))
    assert.equal(tap.source, 'burst')
    assert.equal(tap.floorRay, undefined)
    assert.deepEqual(tap.position, hitsOnly.position)
  }
})

test('prefer: a floor point beyond the range limit is refused even when the hits were near', async () => {
  // The hits slid 0.7 m short, so their own range passes while the floor point is farther than the limit.
  const farPose = poseFromEuler({ x: 0.3, y: 1.5, z: 0.1 }, -19, 25)
  const truth = threeFloorPoint(farPose, FOV, ASPECT, PIXEL.x, PIXEL.y, 0)!
  const length = dist(truth, farPose.position)
  assert.ok(length > TAP_RANGE_MAX_M && length - 0.7 < TAP_RANGE_MAX_M, `fixture range ${length}`)
  const k = (length - 0.7) / length
  const near = {
    x: farPose.position.x + (truth.x - farPose.position.x) * k,
    y: farPose.position.y + (truth.y - farPose.position.y) * k,
    z: farPose.position.z + (truth.z - farPose.position.z) * k,
  }
  const frames = Array.from({ length: 8 }, () => frame(hit(near, dist(near, farPose.position)), { pose: farPose }))
  const provider = fake({ frames, pose: farPose, fovY: FOV, aspect: ASPECT }).provider
  assert.equal(ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR })).source, 'burst')
  const refusal = refused(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer' }))
  assert.equal(refusal.reason, 'too-far')
  assert.ok((refusal.rangeM as number) > TAP_RANGE_MAX_M)
})

test('a reliable floor whose ray does not reach the floor leaves the hits in charge, with no floor ray reported', async () => {
  const lookingUp = poseFromEuler({ x: 0.3, y: 1.5, z: 0.1 }, 20, 25)
  const frames = Array.from({ length: 8 }, () => frame(hit({ x: 0, y: -1.2, z: -2 }), { pose: lookingUp }))
  const provider = fake({ frames, pose: lookingUp, fovY: FOV, aspect: ASPECT }).provider
  for (const floorRay of ['cross-check', 'fallback', 'prefer'] as const) {
    const tap = ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay }))
    assert.equal(tap.source, 'burst', floorRay)
    assert.equal(tap.floorRay, undefined, floorRay)
  }
})

test('fallback: a tap that found no hit is placed by the floor ray and flagged as such', async () => {
  const frames = Array.from({ length: 10 }, () => frame(null, { pose: CAM_POSE }))
  const tap = ok(await sampleTap(sceneProvider(frames), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.equal(tap.source, 'floor-ray')
  assert.equal(tap.n, 0)
  assert.equal(tap.spreadM, null)
  assert.ok(dist(tap.position, FLOOR_TRUTH) < 0.01, `${dist(tap.position, FLOOR_TRUTH)} m off`)
  assert.equal(tap.floorRay, undefined, 'there are no hits to compare it with')
})

test('fallback: two hits are too few, and the floor ray stands in', async () => {
  const frames = [frame(hit(alongRay(0)), { pose: CAM_POSE }), frame(null, { pose: CAM_POSE }), frame(hit(alongRay(0)), { pose: CAM_POSE })]
  const tap = ok(await sampleTap(sceneProvider(frames), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.equal(tap.source, 'floor-ray')
  assert.equal(tap.rejected, 2)
  assert.deepEqual(tap.firstHit, alongRay(0), 'the first hit of the burst is kept even though it was too few to place the tap')
  assert.equal(tap.hitPosition, undefined)
})

test('fallback: with enough hits the hits are used and the floor ray only cross-checks', async () => {
  const tap = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.equal(tap.source, 'burst')
  assert.ok(tap.floorRay)
})

test('the default never places a tap that found nothing', async () => {
  const frames = Array.from({ length: 10 }, () => frame(null, { pose: CAM_POSE }))
  const refusal = refused(await sampleTap(sceneProvider(frames), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR }))
  assert.equal(refusal.reason, 'no-hit')
})

test('fallback needs a floor it can trust, and never overrides a tracking refusal', async () => {
  const none = Array.from({ length: 10 }, () => frame(null, { pose: CAM_POSE }))
  assert.equal(refused(await sampleTap(sceneProvider(none), PIXEL.x, PIXEL.y, { floor: { ...GOOD_FLOOR, locked: false }, floorRay: 'fallback' })).reason, 'no-hit')
  assert.equal(refused(await sampleTap(sceneProvider(none), PIXEL.x, PIXEL.y, { floorRay: 'fallback' })).reason, 'no-hit')
  const limited = none.map((f) => ({ ...f, status: 'LIMITED' }))
  assert.equal(refused(await sampleTap(sceneProvider(limited), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' })).reason, 'tracking')
})

test('fallback: a floor point beyond the range limit is refused', async () => {
  const farPose = poseFromEuler({ x: 0.3, y: 2.4, z: 0.1 }, -25, 25)
  const frames = Array.from({ length: 6 }, () => frame(null, { pose: farPose }))
  const provider = fake({ frames, pose: farPose, fovY: FOV, aspect: ASPECT }).provider
  const refusal = refused(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.equal(refusal.reason, 'too-far')
})

test('the floor ray is cast from every frame\'s own pose, so hand tremor is medianed out, not baked in', async () => {
  const base = poseFromEuler({ x: 0.3, y: 1.5, z: 0.1 }, -33, 25)
  const up = poseFromEuler({ x: 0.3, y: 1.5, z: 0.1 }, -33 + 0.5, 25)
  const down = poseFromEuler({ x: 0.3, y: 1.5, z: 0.1 }, -33 - 0.5, 25)
  const frames = [up, base, down].map((pose) => frame(null, { pose }))
  // The provider's current pose is the worst of them, so reading only that one would be about 3 cm out.
  const provider = fake({ frames, pose: up, fovY: FOV, aspect: ASPECT }).provider
  const tap = ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  const centre = threeFloorPoint(base, FOV, ASPECT, PIXEL.x, PIXEL.y, 0)!
  const worst = threeFloorPoint(up, FOV, ASPECT, PIXEL.x, PIXEL.y, 0)!
  assert.ok(dist(worst, centre) > 0.02, 'the fixture must make the last pose matter')
  assert.ok(dist(tap.position, centre) < 0.001, `${dist(tap.position, centre)} m from the centre pose's point`)
})

test('frames with no pose fall back to the provider\'s current one for the floor ray', async () => {
  const frames = Array.from({ length: 6 }, () => frame(null))
  const tap = ok(await sampleTap(sceneProvider(frames), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.ok(dist(tap.position, FLOOR_TRUTH) < 0.01)
})

// ─── The vertical datum ────────────────────────────────────────────────────

test('the datum is the median of the tap and a reliable fit when they agree within 5 cm', () => {
  const datum = landmarkDatum(-1.18, { ...GOOD_FLOOR, y: -1.2 })
  assert.equal(datum.source, 'tap-and-fit')
  assert.ok(Math.abs(datum.y - -1.19) < 1e-12, `${datum.y}`)
  assert.ok(Math.abs((datum.landmarkAboveFloorM as number) - 0.02) < 1e-12)
  assert.equal(datum.flag, null)
})

test('the agreement window is 5 cm and inclusive of it', () => {
  assert.equal(FLOOR_DATUM_AGREE_M, 0.05)
  const floor = { ...GOOD_FLOOR, y: 0 }
  assert.equal(landmarkDatum(0.05, floor).source, 'tap-and-fit')
  assert.equal(landmarkDatum(-0.05, floor).source, 'tap-and-fit')
  assert.equal(landmarkDatum(0.0501, floor).source, 'single-tap')
  assert.equal(landmarkDatum(-0.0501, floor).source, 'single-tap')
})

test('a tap that disagrees with a reliable fit stays the datum, flagged, and the gap is recorded', () => {
  const datum = landmarkDatum(0.2, { ...GOOD_FLOOR, y: 0 })
  assert.equal(datum.y, 0.2)
  assert.equal(datum.source, 'single-tap')
  assert.equal(datum.flag, 'floor datum from a single tap')
  assert.ok(Math.abs((datum.landmarkAboveFloorM as number) - 0.2) < 1e-12)
  assert.equal(landmarkDatum(-0.2, { ...GOOD_FLOOR, y: 0 }).landmarkAboveFloorM, -0.2)
})

test('with no reliable fit the tap is the datum, flagged, and nothing is claimed about its height', () => {
  for (const floor of [null, undefined, { ...GOOD_FLOOR, locked: false }, { ...GOOD_FLOOR, residualM: 0.05 }, { ...GOOD_FLOOR, fallback: true }]) {
    const datum = landmarkDatum(-1.1, floor)
    assert.equal(datum.y, -1.1)
    assert.equal(datum.source, 'single-tap')
    assert.equal(datum.landmarkAboveFloorM, null)
    assert.equal(datum.flag, FLOOR_DATUM_SINGLE_TAP_FLAG)
  }
})

// ─── What a scan keeps ─────────────────────────────────────────────────────

test('the evidence carries the four fields the work package names', async () => {
  const frames = symmetric(0.01).map((f) => ({ ...f, hit: hit(f.hit!.position, 2.5) }))
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  const datum = landmarkDatum(tap.position.y, { ...GOOD_FLOOR, y: tap.position.y - 0.03 })
  assert.deepEqual(tapEvidence(tap, datum), {
    tapSpreadM: tap.spreadM,
    tapRangeM: 2.5,
    tapSource: 'burst',
    landmarkAboveFloorM: datum.landmarkAboveFloorM,
  })
  assert.ok(Math.abs((tap.spreadM as number) - 0.01) < 1e-9)
  assert.ok(Math.abs((datum.landmarkAboveFloorM as number) - 0.03) < 1e-12)
})

test('evidence without a datum, or for a single hit, says what was not measured with null', async () => {
  const tap = ok(await sampleTap(fake({ single: hit({ x: 0, y: -1.2, z: -2 }, 1.8) }).provider, 0.5, 0.6))
  assert.deepEqual(tapEvidence(tap), { tapSpreadM: null, tapRangeM: 1.8, tapSource: 'single-hit', landmarkAboveFloorM: null })
  assert.deepEqual(JSON.parse(JSON.stringify(tapEvidence(tap))), tapEvidence(tap), 'it survives a JSON round trip unchanged')
})

// ─── A map that shifts inside the window ───────────────────────────────────

function poseAt(x: number, y = 1.5, z = 0): Pose {
  return { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

test('a camera that steps farther than a hand can between two frames refuses the burst, with every status NORMAL', async () => {
  // A runtime with no status and no count (WebXR) shows a map shift only as the viewer pose stepping.
  const frames = steadyFrames(10).map((f, i) => ({ ...f, pose: poseAt(i < 5 ? 0 : 0.5) }))
  assert.ok(frames.every((f) => f.status === 'NORMAL' && f.poseJumps === undefined))
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'tracking')
  assert.equal(tapRefusalText(refusal), 'Hold still, tracking is recovering')
})

test('the step is read across frames that had no pose, so a gap does not hide a shift', async () => {
  const frames = steadyFrames(10).map((f, i) => ({ ...f, pose: i < 4 ? poseAt(0) : i < 7 ? undefined : poseAt(0.5) }))
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'tracking')
})

test('a camera that moves fast but smoothly, or steps exactly the limit, is not a shift', async () => {
  const fast = steadyFrames(10).map((f, i) => ({ ...f, pose: poseAt(i * 0.2) }))
  assert.equal(ok(await sampleTap(fake({ frames: fast }).provider, 0.5, 0.6)).n, 10, '0.2 m a frame is 6 m/s and still a hand')
  const exact = steadyFrames(10).map((f, i) => ({ ...f, pose: poseAt(i < 5 ? 0 : BURST_POSE_JUMP_M) }))
  assert.equal(ok(await sampleTap(fake({ frames: exact }).provider, 0.5, 0.6)).n, 10)
})

test('frames whose camera position is not a number say nothing about a shift', async () => {
  const frames = steadyFrames(10).map((f, i) => ({ ...f, pose: i === 4 ? poseAt(Number.NaN) : poseAt(0) }))
  assert.equal(ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).n, 10)
})

test('a frame the runtime had no pose for is NOT_AVAILABLE, and refuses the tap whatever the hits say', async () => {
  const frames = steadyFrames(10).map((f, i) => (i === 6 ? { ...f, hit: null, pose: undefined, status: 'NOT_AVAILABLE' } : f))
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'tracking')
})

// ─── A burst that did not run, read late ───────────────────────────────────

/** A provider whose burst comes back empty, and whose camera is at `then` until it has and at `now` after. */
function movedDuringBurst(then: Pose, now: Pose, single: HitResult | null) {
  let late = false
  const provider = fake({ frames: [], single }).provider
  provider.getPose = () => (late ? now : then)
  provider.hitTestBurstAsync = async () => {
    late = true
    return { frames: [] }
  }
  return provider
}

function turnedAbout(position: Vec3, degrees: number): Pose {
  const half = (degrees * Math.PI) / 360
  return { position, rotation: { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) } }
}

const LATE_HIT = hit({ x: 0, y: -1.2, z: -2 }, 2)
const AT_REST = poseAt(0)

test('a hit read after a burst that never ran is accepted when the camera has not moved', async () => {
  const tap = ok(await sampleTap(movedDuringBurst(AT_REST, poseAt(0), LATE_HIT), 0.5, 0.6))
  assert.equal(tap.source, 'single-hit')
})

test('a hit read after a burst that never ran is refused as unsteady when the camera has moved on', async () => {
  const refusal = refused(await sampleTap(movedDuringBurst(AT_REST, poseAt(0.2), LATE_HIT), 0.5, 0.6))
  assert.equal(refusal.reason, 'unsteady')
  assert.equal(refusal.n, 0)
  assert.equal(tapRefusalText(refusal), 'That spot did not read steadily. Hold still, or aim at a more textured spot.')
})

test('how far the camera may have moved is how far the tapped point may have slid: the move, plus the turn times the range', async () => {
  const slide = async (now: Pose, distanceM = 2) =>
    (await sampleTap(movedDuringBurst(AT_REST, now, hit({ x: 0, y: -1.2, z: -distanceM }, distanceM)), 0.5, 0.6)).ok
  // Moving alone: 4 cm is the limit.
  assert.equal(await slide(poseAt(0.039)), true)
  assert.equal(await slide(poseAt(0.041)), false)
  // Turning alone, at 2 m: 1 degree swings the point 3.5 cm, 1.2 degrees 4.2 cm.
  assert.equal(await slide(turnedAbout(AT_REST.position, 1.0)), true)
  assert.equal(await slide(turnedAbout(AT_REST.position, 1.2)), false)
  // The same turn is a smaller slide at 1 m and a larger one at 3 m.
  assert.equal(await slide(turnedAbout(AT_REST.position, 1.2), 1), true)
  assert.equal(await slide(turnedAbout(AT_REST.position, 1.2), 3), false)
  // Both at once add: 2 cm and 0.5 degree (1.7 cm) are inside, 2 cm and 1.2 degrees (4.2 cm) are not.
  assert.equal(await slide(turnedAbout({ x: 0.02, y: 1.5, z: 0 }, 0.5)), true)
  assert.equal(await slide(turnedAbout({ x: 0.02, y: 1.5, z: 0 }, 1.2)), false)
})

test('the late-read limit is the scatter limit, and goes where it goes', async () => {
  const moved = poseAt(0.2)
  assert.equal((await sampleTap(movedDuringBurst(AT_REST, moved, LATE_HIT), 0.5, 0.6, { spreadMaxM: Number.POSITIVE_INFINITY })).ok, true)
  assert.equal((await sampleTap(movedDuringBurst(AT_REST, poseAt(0.03), LATE_HIT), 0.5, 0.6, { spreadMaxM: 0.02 })).ok, false)
})

test('a camera that moved is no reason to refuse a hit read at once, by a provider with no burst', async () => {
  const provider = fake({ single: LATE_HIT }).provider
  let calls = 0
  provider.getPose = () => poseAt(calls++ * 0.2)
  assert.equal(ok(await sampleTap(provider, 0.5, 0.6)).source, 'single-hit')
})

test('without a pose at the tap, or now, or a hit, there is nothing to say the camera moved', async () => {
  const noPoseAtTap = movedDuringBurst(AT_REST, poseAt(0.5), LATE_HIT)
  let late = false
  noPoseAtTap.getPose = () => {
    if (!late) throw new Error('no pose yet')
    return poseAt(0.5)
  }
  noPoseAtTap.hitTestBurstAsync = async () => {
    late = true
    return { frames: [] }
  }
  assert.equal((await sampleTap(noPoseAtTap, 0.5, 0.6)).ok, true)

  const noHit = refused(await sampleTap(movedDuringBurst(AT_REST, poseAt(0.5), null), 0.5, 0.6))
  assert.equal(noHit.reason, 'no-hit', 'a read that found nothing is no-hit, not unsteady')

  const unmeasurable = movedDuringBurst(AT_REST, { position: { x: Number.NaN, y: 1.5, z: 0 }, rotation: AT_REST.rotation }, LATE_HIT)
  assert.equal((await sampleTap(unmeasurable, 0.5, 0.6)).ok, true)
  const noRotation = movedDuringBurst(AT_REST, { position: AT_REST.position, rotation: { x: 0, y: 0, z: 0, w: 0 } }, LATE_HIT)
  assert.equal((await sampleTap(noRotation, 0.5, 0.6)).ok, true)
})

test('where the runtime gave the late hit no distance, the range of the slide is measured from the camera now', async () => {
  // 1.2 degrees at 3 m is past the limit; at 1 m it is not. Only the hit's position says which.
  const far = hit({ x: 0, y: 1.5, z: -3 }, Number.NaN)
  const near = hit({ x: 0, y: 1.5, z: -1 }, Number.NaN)
  assert.equal((await sampleTap(movedDuringBurst(AT_REST, turnedAbout(AT_REST.position, 1.2), far), 0.5, 0.6, { rangeMaxM: 9 })).ok, false)
  assert.equal((await sampleTap(movedDuringBurst(AT_REST, turnedAbout(AT_REST.position, 1.2), near), 0.5, 0.6)).ok, true)
})

test('a late hit with a distance of zero has no distance: its range is measured, so the turn is weighed at that range', async () => {
  // 1.2 degrees at 3 m is a 6 cm slide, past the limit. Read as a range of nought it would be none at all.
  const far = hit({ x: 0, y: 1.5, z: -3 }, 0)
  assert.equal((await sampleTap(movedDuringBurst(AT_REST, turnedAbout(AT_REST.position, 1.2), far), 0.5, 0.6, { rangeMaxM: 9 })).ok, false)
})

test('the same orientation written as the negated quaternion is no turn at all', async () => {
  // q and -q are one rotation, and a pose may arrive as either.
  const turned = turnedAbout(AT_REST.position, 40)
  const negated: Pose = { position: turned.position, rotation: { x: -turned.rotation.x, y: -turned.rotation.y, z: -turned.rotation.z, w: -turned.rotation.w } }
  assert.equal((await sampleTap(movedDuringBurst(turned, negated, LATE_HIT), 0.5, 0.6)).ok, true)
  assert.equal((await sampleTap(movedDuringBurst(turned, turnedAbout(AT_REST.position, 41.2), LATE_HIT), 0.5, 0.6)).ok, false, 'while 1.2 degrees of it still is')
})

test('a tracking refusal outranks a late read that moved', async () => {
  const provider = movedDuringBurst(AT_REST, poseAt(0.5), LATE_HIT)
  provider.trackingStatus = () => 'LIMITED'
  assert.equal(refused(await sampleTap(provider, 0.5, 0.6)).reason, 'tracking')
})

// ─── Where the tap's height comes from ─────────────────────────────────────

test('a tap placed by the floor ray keeps the hits\' own median, and says so', async () => {
  const tap = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer' }))
  assert.equal(tap.source, 'floor-ray')
  assert.ok(tap.hitPosition, 'the hits that gated it are still there')
  assert.ok(dist(tap.hitPosition, tap.position) > 0.25, 'and they are not the position')
  assert.equal(tap.position.y, 0)
  assert.ok(tap.hitPosition.y > 0.15, `the hits' height is ${tap.hitPosition.y}: they slid up the ray`)
  const plain = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR }))
  assert.deepEqual(plain.position, plain.hitPosition, 'otherwise the two are the same point')
})

test('the datum of a floor-ray tap is read from the hits, not from the floor the ray was cast to', async () => {
  // The hits sit 12 cm above a reliable floor. By position the floor-ray tap is exactly on the floor.
  const frames = Array.from({ length: 10 }, () => frame(hit({ x: 0.1, y: 0.12, z: -2 }, 2.2), { pose: CAM_POSE }))
  const provider = fake({ frames, pose: CAM_POSE, fovY: FOV, aspect: ASPECT }).provider
  const viaPosition = (tap: TapSample) => landmarkDatum(tap.position.y, GOOD_FLOOR)

  const cross = ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR }))
  const prefer = ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer' }))
  assert.equal(prefer.source, 'floor-ray')
  assert.equal(viaPosition(prefer).source, 'tap-and-fit', 'the trap: read from position it claims agreement')
  assert.equal(viaPosition(prefer).flag, null)

  for (const tap of [cross, prefer]) {
    const datum = tapLandmarkDatum(tap, GOOD_FLOOR)
    assert.equal(datum.source, 'single-tap')
    assert.equal(datum.flag, FLOOR_DATUM_SINGLE_TAP_FLAG)
    assert.ok(Math.abs((datum.landmarkAboveFloorM as number) - 0.12) < 1e-9, `${datum.landmarkAboveFloorM}`)
    assert.ok(Math.abs(datum.y - 0.12) < 1e-9)
    assert.equal(tapEvidence(tap, datum).landmarkAboveFloorM, datum.landmarkAboveFloorM)
  }
})

test('how high the person tapped is what the hits measured, so a tap on a tabletop is not on the floor because a ray was', async () => {
  // Hits 75 cm up (a tabletop) on the tapped pixel's line, and a reliable floor at 0.
  const frames = Array.from({ length: 10 }, () => frame(hit({ x: 0.1, y: 0.75, z: -1.2 }, 1.5), { pose: CAM_POSE }))
  const provider = fake({ frames, pose: CAM_POSE, fovY: FOV, aspect: ASPECT }).provider
  const prefer = ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer' }))
  assert.equal(prefer.source, 'floor-ray')
  assert.equal(prefer.position.y, 0, 'by position the tap is on the floor')
  assert.equal(tapSurfaceY(prefer), 0.75, 'by what was measured it is on the table')
  assert.ok(Math.abs(tapSurfaceY(prefer) - GOOD_FLOOR.y) > 0.25, 'and the floor gate would see it')

  const cross = ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR }))
  assert.equal(tapSurfaceY(cross), cross.position.y, 'where the hits set the position the two are the same height')

  const none = Array.from({ length: 10 }, () => frame(null, { pose: CAM_POSE }))
  const placed = ok(await sampleTap(sceneProvider(none), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.equal(tapSurfaceY(placed), 0, 'a tap that measured nothing has only the floor to say')
})

test('the datum of a tap whose hits agreed with the floor is the median of the two, however the tap was placed', async () => {
  const frames = Array.from({ length: 10 }, () => frame(hit({ x: 0.1, y: 0.03, z: -2 }, 2.2), { pose: CAM_POSE }))
  const provider = fake({ frames, pose: CAM_POSE, fovY: FOV, aspect: ASPECT }).provider
  for (const floorRay of ['cross-check', 'prefer'] as const) {
    const datum = tapLandmarkDatum(ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay })), GOOD_FLOOR)
    assert.equal(datum.source, 'tap-and-fit', floorRay)
    assert.ok(Math.abs(datum.y - 0.015) < 1e-9, `${datum.y}`)
    assert.equal(datum.flag, null)
  }
})

test('a tap the floor ray placed with no hit at all has no height of its own: the fitted floor\'s, flagged as such', async () => {
  const frames = Array.from({ length: 10 }, () => frame(null, { pose: CAM_POSE }))
  const tap = ok(await sampleTap(sceneProvider(frames), PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback' }))
  assert.equal(tap.source, 'floor-ray')
  assert.equal(tap.hitPosition, undefined)
  const datum = tapLandmarkDatum(tap, GOOD_FLOOR)
  assert.deepEqual(datum, { y: GOOD_FLOOR.y, source: 'fit-only', landmarkAboveFloorM: null, flag: FLOOR_DATUM_FIT_ONLY_FLAG })
  assert.equal(FLOOR_DATUM_FIT_ONLY_FLAG, 'floor datum from the fitted floor, no tap height')
  assert.equal(tapEvidence(tap, datum).landmarkAboveFloorM, null)
  assert.equal(tapEvidence(tap, datum).tapSource, 'floor-ray')
})

test('with no reliable fit the datum is the hits\' own height, flagged, whatever way the tap was asked for', async () => {
  const tap = ok(await sampleTap(sceneProvider(slidFrames(0.35)), PIXEL.x, PIXEL.y, { floor: { ...GOOD_FLOOR, locked: false }, floorRay: 'prefer' }))
  assert.equal(tap.source, 'burst', 'no reliable fit, so no floor ray to prefer')
  const datum = tapLandmarkDatum(tap, { ...GOOD_FLOOR, locked: false })
  assert.equal(datum.y, tap.position.y)
  assert.equal(datum.flag, FLOOR_DATUM_SINGLE_TAP_FLAG)
})

test('the floor ray and the hits agree up to exactly the agreement limit, and no further', () => {
  assert.equal(floorRayAgrees(FLOOR_RAY_AGREE_M), true)
  assert.equal(floorRayAgrees(FLOOR_RAY_AGREE_M + 1e-9), false)
  assert.equal(floorRayAgrees(0), true)
  assert.equal(floorRayAgrees(Number.NaN), false)
})

test('what one hit at the moment of the tap would have been rides on the tap, beside the median', async () => {
  const frames = [
    frame(hit({ x: 0.3, y: -1.2, z: -2 })),
    ...Array.from({ length: 8 }, () => frame(hit({ x: 0.31, y: -1.2, z: -2 }))),
  ]
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.deepEqual(tap.firstHit, { x: 0.3, y: -1.2, z: -2 })
  assert.deepEqual(tap.position, { x: 0.31, y: -1.2, z: -2 })
  const first = frames[0].hit!.position
  assert.notEqual(tap.firstHit, first, 'a copy, so nothing the caller does to it reaches the provider\'s frame')

  const single = ok(await sampleTap(fake({ single: hit({ x: 1, y: -1.2, z: -2 }) }).provider, 0.5, 0.6))
  assert.deepEqual(single.firstHit, { x: 1, y: -1.2, z: -2 })
})

test('no first hit is reported where the first frame had none, or none that was a number', async () => {
  const late = [frame(null), ...Array.from({ length: 8 }, () => frame(hit({ x: 0.31, y: -1.2, z: -2 })))]
  assert.equal(ok(await sampleTap(fake({ frames: late }).provider, 0.5, 0.6)).firstHit, undefined)
  const nan = [frame(hit({ x: Number.NaN, y: 0, z: 0 })), ...late.slice(1)]
  assert.equal(ok(await sampleTap(fake({ frames: nan }).provider, 0.5, 0.6)).firstHit, undefined)
})

// ─── The edges the first suite did not pin ─────────────────────────────────

test('an outlier on the height axis alone is thrown out, as one on the floor plane is', async () => {
  const base = { x: 0.2, y: -1.2, z: -2 }
  const frames = [
    ...Array.from({ length: 9 }, (_, i) => frame(hit({ x: base.x, y: base.y + 0.001 * (i % 3), z: base.z }))),
    frame(hit({ x: base.x, y: base.y + 0.06, z: base.z })),
  ]
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(tap.rejected, 1, 'the one hit that is 6 cm too high')
  assert.equal(tap.n, 9)
})

test('the robust scale is the larger of the measured deviation and its floor, not their sum', async () => {
  // Nine hits within 2 mm of the median and one 22 mm out: the deviation is 2 mm, so 1.4826 x 2 mm = 3 mm sits under
  // the 5 mm floor and the limit is 3.5 x 5 mm = 17.5 mm. Added, the scale would be 8 mm and the limit 28 mm.
  const xs = [-0.002, -0.002, -0.002, 0, 0, 0, 0.002, 0.002, 0.002, 0.022]
  assert.ok(1.4826 * 0.002 < TAP_OUTLIER_SCALE_FLOOR_M)
  const frames = xs.map((x) => frame(hit({ x, y: -1.2, z: -2 })))
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(tap.rejected, 1)
  assert.equal(tap.n, 9)
})

test('a hit exactly at the outlier limit is kept, and one a hair past it is thrown out', async () => {
  // Nine identical hits have no deviation, so the scale is its floor and the limit is the cutoff times that floor.
  const limit = TAP_OUTLIER_K * TAP_OUTLIER_SCALE_FLOOR_M
  const burst = (x: number) => [...Array.from({ length: 9 }, () => frame(hit({ x: 0, y: -1.2, z: -2 }))), frame(hit({ x, y: -1.2, z: -2 }))]
  assert.equal(ok(await sampleTap(fake({ frames: burst(limit) }).provider, 0.5, 0.6)).rejected, 0)
  assert.equal(ok(await sampleTap(fake({ frames: burst(limit + 1e-9) }).provider, 0.5, 0.6)).rejected, 1)
})

test('exactly 60 percent of the hits surviving is enough, and the four that went are counted', async () => {
  const at = { x: 0, y: -1.2, z: -2 }
  const frames = [
    ...Array.from({ length: 6 }, () => frame(hit(at))),
    ...Array.from({ length: 4 }, () => frame(hit({ x: 0.06, y: -1.2, z: -2 }))),
  ]
  assert.equal(6 / 10, TAP_MIN_INLIER_FRACTION)
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(tap.n, 6)
  assert.equal(tap.rejected, 4)
})

test('the range reported is that of the hits that were kept, not of the strays', async () => {
  // Six kept hits at 1.90 to 2.15 m (median 2.025) and four strays 6 cm to one side at 2.9 m. Over all ten the
  // median would be 2.125.
  const kept = [1.9, 1.95, 2.0, 2.05, 2.1, 2.15].map((d) => frame(hit({ x: 0, y: -1.2, z: -2 }, d)))
  const strays = Array.from({ length: 4 }, () => frame(hit({ x: 0.06, y: -1.2, z: -2 }, 2.9)))
  const tap = ok(await sampleTap(fake({ frames: [...kept, ...strays] }).provider, 0.5, 0.6))
  assert.equal(tap.n, 6)
  assert.ok(Math.abs(tap.rangeM - 2.025) < 1e-12, `${tap.rangeM}`)
})

test('a hit with a distance of zero has no distance: the range is measured from the pose, never read as nought', async () => {
  const pose: Pose = { position: { x: 0, y: -0.2, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  const frames = Array.from({ length: 6 }, () => frame(hit({ x: 0, y: -1.2, z: -4 }, 0), { pose }))
  const refusal = refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6))
  assert.equal(refusal.reason, 'too-far')
  assert.ok(Math.abs((refusal.rangeM as number) - Math.hypot(1, 4)) < 1e-9)
})

test('prefer: a floor point exactly at the range limit is accepted, one a hair past it is refused', async () => {
  const camera = { ...CAM_POSE, fovYDeg: FOV, aspect: ASPECT }
  const exact = floorRayPoint(camera, PIXEL.x, PIXEL.y, 0)!.rangeM
  const frames = Array.from({ length: 8 }, () => frame(hit(alongRay(0), 1.5), { pose: CAM_POSE }))
  const provider = fake({ frames, pose: CAM_POSE, fovY: FOV, aspect: ASPECT }).provider
  assert.equal(ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer', rangeMaxM: exact })).source, 'floor-ray')
  assert.equal(refused(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'prefer', rangeMaxM: exact - 1e-9 })).reason, 'too-far')
})

test('fallback: a floor point exactly at the range limit places the tap', async () => {
  const camera = { ...CAM_POSE, fovYDeg: FOV, aspect: ASPECT }
  const exact = floorRayPoint(camera, PIXEL.x, PIXEL.y, 0)!.rangeM
  const frames = Array.from({ length: 6 }, () => frame(null, { pose: CAM_POSE }))
  const provider = sceneProvider(frames)
  assert.equal(ok(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback', rangeMaxM: exact })).source, 'floor-ray')
  assert.equal(refused(await sampleTap(provider, PIXEL.x, PIXEL.y, { floor: GOOD_FLOOR, floorRay: 'fallback', rangeMaxM: exact - 1e-9 })).reason, 'too-far')
})

test('a count of frame shifts that went down inside the burst is a disturbance too (the provider restarted)', async () => {
  const frames = steadyFrames().map((f, i) => ({ ...f, poseJumps: i < 4 ? 3 : 0 }))
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'tracking')
})

// ─── How often a clean burst is believed ───────────────────────────────────

test('the scatter limit is about 2.3 cm per axis: clean bursts of 14 hits are accepted at 1.5 cm, mostly not at 3 cm', async () => {
  // The simulation TAP_SPREAD_MAX_M's documentation quotes. 14 hits is a 450 ms window at about 30 frames a second.
  const rate = async (sigma: number, seed0: number) => {
    let accepted = 0
    const trials = 600
    for (let seed = seed0; seed < seed0 + trials; seed++) {
      const rand = rng(seed)
      const frames = Array.from({ length: 14 }, () => frame(hit(noisy(TRUTH, sigma, rand))))
      if ((await sampleTap(fake({ frames }).provider, 0.5, 0.6)).ok) accepted++
    }
    return accepted / trials
  }
  assert.ok((await rate(0.01, 7000)) > 0.99, 'at 1 cm per axis')
  assert.ok((await rate(0.015, 8000)) > 0.98, 'at 1.5 cm per axis')
  const two = await rate(0.02, 9000)
  assert.ok(two > 0.9 && two < 0.99, `${two} at 2 cm per axis`)
  const twoAndAHalf = await rate(0.025, 10000)
  assert.ok(twoAndAHalf > 0.3 && twoAndAHalf < 0.6, `${twoAndAHalf} at 2.5 cm per axis`)
  assert.ok((await rate(0.03, 11000)) < 0.2, 'at 3 cm per axis')
  assert.ok((await rate(0.04, 12000)) < 0.02, 'at 4 cm per axis')
})

test('a person who insists is let through: a confirming tap with no scatter limit takes the median of a burst that scattered', async () => {
  const frames = symmetric(0.06)
  assert.equal(refused(await sampleTap(fake({ frames }).provider, 0.5, 0.6)).reason, 'unsteady')
  const tap = ok(await sampleTap(fake({ frames }).provider, 0.5, 0.6, { spreadMaxM: Number.POSITIVE_INFINITY }))
  assert.ok(Math.abs((tap.spreadM as number) - 0.06) < 1e-12, 'and the scatter it was accepted at is on the tap')
  const farFrames = burstAtRange(3.5)
  assert.equal(refused(await sampleTap(fake({ frames: farFrames }).provider, 0.5, 0.6)).reason, 'too-far')
  assert.equal(ok(await sampleTap(fake({ frames: farFrames }).provider, 0.5, 0.6, { rangeMaxM: Number.POSITIVE_INFINITY })).rangeM, 3.5)
})

// ─── Showing the person the tap is being read ──────────────────────────────

/** A provider whose burst reports each of its frames to the listener it is given, 33 ms apart, as the real ones do. */
function reporting(frames: HitBurstFrame[], received: { listener: unknown }) {
  const provider = fake({ frames }).provider
  provider.hitTestBurstAsync = async (_x, _y, _w, onFrame) => {
    received.listener = onFrame
    frames.forEach((f, i) => onFrame?.(f, i * 33))
    return { frames }
  }
  return provider
}

test('progress: each frame of the burst is reported, with the time, the hits so far and the scatter once there are three', async () => {
  const calm = { x: 0, y: -1.2, z: -2 }
  const frames = [frame(hit(calm)), frame(null), frame(hit(calm)), frame(hit({ x: 0.01, y: -1.2, z: -2 })), frame(hit(calm))]
  const seen: TapProgress[] = []
  const received = { listener: undefined as unknown }
  const result = await sampleTap(reporting(frames, received), 0.5, 0.6, { onProgress: (p) => seen.push(p) })
  assert.equal(result.ok, true)
  assert.deepEqual(seen.map((p) => [p.frames, p.hits, p.elapsedMs]), [[1, 1, 0], [2, 1, 33], [3, 2, 66], [4, 3, 99], [5, 4, 132]])
  assert.ok(seen.every((p) => p.windowMs === TAP_BURST_WINDOW_MS))
  assert.deepEqual(seen.slice(0, 3).map((p) => p.spreadM), [null, null, null], 'under three hits there is no scatter to show')
  assert.ok(seen[3].spreadM !== null && seen[3].spreadM > 0 && seen[3].spreadM < 0.01)
  const last = seen[4].spreadM as number
  assert.ok(Math.abs(last - (result as TapSample).spreadM!) < 1e-12, 'what the ring last showed is what the tap reports')
})

test('progress: the window it reports is the one that was asked for, clamped as the burst is', async () => {
  const seen: TapProgress[] = []
  const received = { listener: undefined as unknown }
  await sampleTap(reporting(steadyFrames(3), received), 0.5, 0.6, { windowMs: 200, onProgress: (p) => seen.push(p) })
  await sampleTap(reporting(steadyFrames(3), received), 0.5, 0.6, { windowMs: 9000, onProgress: (p) => seen.push(p) })
  assert.deepEqual([...new Set(seen.map((p) => p.windowMs))], [200, 450])
})

test('progress: the scatter shown leaves the strays out, as the tap will', async () => {
  const calm = { x: 0, y: -1.2, z: -2 }
  const frames = [...Array.from({ length: 9 }, () => frame(hit(calm))), frame(hit({ x: 0.5, y: -1.2, z: -2 }))]
  const seen: TapProgress[] = []
  await sampleTap(reporting(frames, { listener: undefined }), 0.5, 0.6, { onProgress: (p) => seen.push(p) })
  assert.equal(seen[9].spreadM, 0)
})

test('progress: a listener that throws costs the tap nothing', async () => {
  const result = await sampleTap(reporting(steadyFrames(8), { listener: undefined }), 0.5, 0.6, {
    onProgress: () => {
      throw new Error('the ring could not be drawn')
    },
  })
  assert.equal(result.ok, true)
})

test('progress: with nobody listening the provider is given no listener to call', async () => {
  const received = { listener: 'unset' as unknown }
  await sampleTap(reporting(steadyFrames(8), received), 0.5, 0.6)
  assert.equal(received.listener, undefined)
})

test('progress: a tap read with one hit has no burst to report', async () => {
  const seen: TapProgress[] = []
  const result = await sampleTap(fake({ single: hit({ x: 0, y: -1.2, z: -2 }) }).provider, 0.5, 0.6, { onProgress: (p) => seen.push(p) })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [])
})

// ─── What the person is told ───────────────────────────────────────────────

test('every refusal has a short line, and none of them prints a number that does not exist', () => {
  const lines = [
    tapRefusalText({ ok: false, reason: 'tracking', n: 0 }),
    tapRefusalText({ ok: false, reason: 'no-hit', n: 0 }),
    tapRefusalText({ ok: false, reason: 'too-few-hits', n: 2 }),
    tapRefusalText({ ok: false, reason: 'too-far', n: 6, rangeM: 4.26 }),
    tapRefusalText({ ok: false, reason: 'too-far', n: 6, rangeM: Number.NaN }),
    tapRefusalText({ ok: false, reason: 'too-far', n: 6 }),
    tapRefusalText({ ok: false, reason: 'unsteady', n: 8, spreadM: 0.07 }),
  ]
  assert.deepEqual(lines, [
    'Hold still, tracking is recovering',
    'No stable surface there. Aim at a textured floor and tap again.',
    'Too few readings of that spot. Hold still and tap again.',
    'That spot is 4.3 m away. Move closer and tap again.',
    'Move closer to that spot and tap again.',
    'Move closer to that spot and tap again.',
    'That spot did not read steadily. Hold still, or aim at a more textured spot.',
  ])
  for (const line of lines) assert.doesNotMatch(line, /NaN|undefined|Infinity/)
})
