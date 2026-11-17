/**
 * WP-05b: a person's way past a limit, as the sampler judges it (src/ar/tap-sampling.ts, `SampleTapOptions.insist`).
 *
 * "Tap the same spot again to use it anyway" has to mean the same spot. A first version of it compared where the
 * finger was on the screen, so a second tap aimed at a different place, or after the camera had moved, was let past
 * the range limit or the scatter limit with nothing said. It is now judged by what the hits measured: a refusal for
 * the range or the scatter says where the spot was in the map (`TapRefusal.position`), and a second tap is let past
 * that limit only where it exceeds it again, within `TAP_SAME_SPOT_M` of that spot. Everything else about the tap is
 * judged as it always was.
 *
 * The flow that remembers the refusal and says so on the card is wp-calibration-taps.test.ts and
 * wp-calibration-taps-modal.test.ts. What is held here is the sampler's half: the position a refusal carries, the
 * limits a second tap passes, the ones it does not, and the words for a distance that rounds to the limit.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-tap-insist.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TAP_RANGE_MAX_M,
  TAP_SAME_SPOT_M,
  TAP_SPREAD_MAX_M,
  sampleTap,
  tapRefusalText,
  type TapProvider,
  type TapRefusal,
  type TapResult,
  type TapSample,
} from '../../../src/ar/tap-sampling.ts'
import { floorRayPoint, type GroundReading } from '../../../src/ar/ground-gate.ts'
import type { HitBurstFrame, HitResult, Pose } from '../../../src/ar/provider.ts'
import type { Vec3 } from '../../../src/world/types.ts'

// ─── Fixtures ──────────────────────────────────────────────────────────────

const POSE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
/** A spot on the floor of a room, 1.6 m ahead and 1.2 m down: the x of zero keeps a distance of a tenth exact. */
const SPOT: Vec3 = { x: 0, y: -1.2, z: -1.6 }

const hit = (position: Vec3, distance: number): HitResult => ({ position, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance })
const frame = (h: HitResult | null, extra: Partial<HitBurstFrame> = {}): HitBurstFrame => ({ hit: h, pose: POSE, status: 'NORMAL', ...extra })

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const moved = (p: Vec3, dx: number): Vec3 => ({ ...p, x: p.x + dx })

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
const gaussian = (rand: () => number): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

/** Twelve identical hits at `at`, the runtime saying they are `rangeM` away: a burst whose median is exactly `at`. */
const still = (at: Vec3, rangeM: number): HitBurstFrame[] => Array.from({ length: 12 }, () => frame(hit(at, rangeM)))

/** Twelve hits that scatter by `sigma` per axis about `at`. */
function scattered(at: Vec3, sigma: number, rangeM: number, seed: number): HitBurstFrame[] {
  const rand = rng(seed)
  return Array.from({ length: 12 }, () =>
    frame(hit({ x: at.x + sigma * gaussian(rand), y: at.y + sigma * gaussian(rand), z: at.z + sigma * gaussian(rand) }, rangeM)))
}

function providerOf(frames: HitBurstFrame[], o: { pose?: Pose } = {}): TapProvider {
  return {
    hitTest: () => null,
    getPose: () => o.pose ?? POSE,
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.5625,
    trackingStatus: () => 'NORMAL',
    hitTestBurstAsync: async (_x, _y, _windowMs, onFrame) => {
      frames.forEach((f, i) => onFrame?.(f, i * 33))
      return { frames }
    },
  }
}

const FAR_M = TAP_RANGE_MAX_M + 1.2

function refusal(result: TapResult): TapRefusal {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`)
  return result as TapRefusal
}

function taken(result: TapResult): TapSample {
  assert.equal(result.ok, true, `expected a tap, got ${JSON.stringify(result)}`)
  return result as TapSample
}

// ─── A refusal says where the spot was ─────────────────────────────────────

test('a refusal for range carries where the hits put the spot: the per-axis median of the usable hits', async () => {
  const frames = scattered(SPOT, 0.01, FAR_M, 1)
  const refused = refusal(await sampleTap(providerOf(frames), 0.5, 0.5))
  assert.equal(refused.reason, 'too-far')
  assert.ok(Math.abs(refused.rangeM! - FAR_M) < 1e-9)
  assert.ok(refused.position && dist(refused.position, SPOT) < 0.02, `${refused.position && dist(refused.position, SPOT)} m off`)
})

test('a refusal for scatter carries it too, with the scatter that refused it', async () => {
  const refused = refusal(await sampleTap(providerOf(scattered(SPOT, 0.05, 2, 2)), 0.5, 0.5))
  assert.equal(refused.reason, 'unsteady')
  assert.ok(refused.spreadM! > TAP_SPREAD_MAX_M)
  assert.ok(refused.position && dist(refused.position, SPOT) < 0.06, `${refused.position && dist(refused.position, SPOT)} m off`)
})

test('a refusal with no spot to confirm carries none: a map that moved, no hit, too few hits, a burst that mostly strayed', async () => {
  const limited = refusal(await sampleTap(providerOf(still(SPOT, 2).map((f, i) => (i === 6 ? { ...f, status: 'LIMITED' } : f))), 0.5, 0.5))
  const none = refusal(await sampleTap(providerOf(Array.from({ length: 12 }, () => frame(null))), 0.5, 0.5))
  const few = refusal(await sampleTap(providerOf([frame(hit(SPOT, 2)), frame(hit(SPOT, 2)), ...Array.from({ length: 10 }, () => frame(null))]), 0.5, 0.5))
  // Seven identical hits and five 6 cm away: the seven are a bare majority, which is refused with no scatter to name.
  const strays = refusal(await sampleTap(providerOf([...still(SPOT, 2).slice(0, 7), ...still(moved(SPOT, 0.06), 2).slice(0, 5)]), 0.5, 0.5))
  assert.deepEqual([limited.reason, none.reason, few.reason, strays.reason], ['tracking', 'no-hit', 'too-few-hits', 'unsteady'])
  for (const each of [limited, none, few, strays]) assert.equal(each.position, undefined, each.reason)
})

// ─── A second tap at the same spot is let past the limit that refused the first ──

test('a tap too far away is let past when it lands where the refused one did, and says which limit it passed', async () => {
  const first = refusal(await sampleTap(providerOf(still(SPOT, FAR_M)), 0.5, 0.5))
  const again = taken(await sampleTap(providerOf(still(SPOT, FAR_M)), 0.5, 0.5, { insist: { position: first.position!, range: true } }))
  assert.deepEqual(again.insisted, ['range'])
  assert.equal(again.rangeM, FAR_M, 'taken as it measured, not as the limit would have it')
  assert.deepEqual(again.position, SPOT)
})

test('a tap that scatters too much is let past the same way', async () => {
  const first = refusal(await sampleTap(providerOf(scattered(SPOT, 0.05, 2, 3)), 0.5, 0.5))
  const again = taken(await sampleTap(providerOf(scattered(SPOT, 0.05, 2, 4)), 0.5, 0.5, { insist: { position: first.position!, spread: true } }))
  assert.deepEqual(again.insisted, ['spread'])
  assert.ok(again.spreadM! > TAP_SPREAD_MAX_M, 'with the scatter it really had')
})

test('the same spot is within TAP_SAME_SPOT_M of the refused one, the distance included and a little more not', async () => {
  assert.equal(TAP_SAME_SPOT_M, 0.1)
  const refused = { position: SPOT, range: true }
  const at = (dx: number) => sampleTap(providerOf(still(moved(SPOT, dx), FAR_M)), 0.5, 0.5, { insist: refused })
  assert.equal(taken(await at(TAP_SAME_SPOT_M)).insisted?.[0], 'range', 'exactly the distance')
  assert.equal(taken(await at(-TAP_SAME_SPOT_M)).insisted?.[0], 'range', 'in either direction')
  const over = refusal(await at(TAP_SAME_SPOT_M + 1e-6))
  assert.equal(over.reason, 'too-far', 'a hair beyond is another spot')
  assert.ok(over.position && Math.abs(over.position.x - (SPOT.x + TAP_SAME_SPOT_M + 1e-6)) < 1e-12, 'and says where that one was')
})

test('the distance is in the map, in three dimensions: a spot straight above the refused one is not the same', async () => {
  const refused = { position: SPOT, range: true }
  const above = { ...SPOT, y: SPOT.y + 0.11 }
  assert.equal(refusal(await sampleTap(providerOf(still(above, FAR_M)), 0.5, 0.5, { insist: refused })).reason, 'too-far')
  const lower = { ...SPOT, y: SPOT.y + 0.09 }
  assert.equal(taken(await sampleTap(providerOf(still(lower, FAR_M)), 0.5, 0.5, { insist: refused })).insisted?.[0], 'range')
})

test('a person insisting on one limit is not let past another: the range passed, the scatter still refuses', async () => {
  const frames = scattered(SPOT, 0.05, FAR_M, 5)
  const first = refusal(await sampleTap(providerOf(frames), 0.5, 0.5))
  assert.equal(first.reason, 'too-far')
  const second = refusal(await sampleTap(providerOf(frames), 0.5, 0.5, { insist: { position: first.position!, range: true } }))
  assert.equal(second.reason, 'unsteady', 'the range was let past, and then the scatter was judged')
  assert.ok(second.spreadM! > TAP_SPREAD_MAX_M)
  const third = taken(await sampleTap(providerOf(frames), 0.5, 0.5, { insist: { position: second.position!, range: true, spread: true } }))
  assert.deepEqual(third.insisted, ['range', 'spread'])
  const wrong = refusal(await sampleTap(providerOf(frames), 0.5, 0.5, { insist: { position: first.position!, spread: true } }))
  assert.equal(wrong.reason, 'too-far', 'insisting on the scatter does not lift the range')
})

test('a tap inside the limits is taken as an ordinary one, however it was asked for: nothing is said to have been passed', async () => {
  const insist = { position: SPOT, range: true, spread: true }
  const plain = taken(await sampleTap(providerOf(still(SPOT, 2)), 0.5, 0.5, { insist }))
  assert.equal('insisted' in plain, false)
  assert.equal(plain.rangeM, 2)
  const alone = taken(await sampleTap(providerOf(still(SPOT, 2)), 0.5, 0.5))
  assert.deepEqual(plain, alone, 'the same tap as one with no insisting at all')
})

test('a tap that exceeds a limit somewhere else is refused as it would have been, with the numbers it had', async () => {
  const elsewhere = moved(SPOT, 1)
  const far = refusal(await sampleTap(providerOf(still(elsewhere, FAR_M)), 0.5, 0.5, { insist: { position: SPOT, range: true, spread: true } }))
  assert.equal(far.reason, 'too-far')
  assert.equal(far.rangeM, FAR_M)
  assert.deepEqual(far.position, elsewhere)
  const shaky = refusal(await sampleTap(providerOf(scattered(elsewhere, 0.05, 2, 6)), 0.5, 0.5, { insist: { position: SPOT, range: true, spread: true } }))
  assert.equal(shaky.reason, 'unsteady')
})

test('a range nobody could measure is not one anybody is let past', async () => {
  const blind: TapProvider = {
    ...providerOf(Array.from({ length: 12 }, () => ({ hit: hit(SPOT, Number.NaN), status: 'NORMAL' }) as HitBurstFrame)),
    getPose: () => { throw new Error('no pose') },
  }
  const first = refusal(await sampleTap(blind, 0.5, 0.5))
  assert.equal(first.reason, 'too-far')
  assert.equal(first.rangeM, undefined)
  const again = refusal(await sampleTap(blind, 0.5, 0.5, { insist: { position: first.position!, range: true } }))
  assert.equal(again.reason, 'too-far', 'a limit with no number over it is not passed')
})

test('a non-finite spot to confirm confirms nothing', async () => {
  for (const position of [{ x: Number.NaN, y: 0, z: 0 }, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }]) {
    assert.equal(refusal(await sampleTap(providerOf(still(SPOT, FAR_M)), 0.5, 0.5, { insist: { position, range: true } })).reason, 'too-far')
  }
})

test('insisting does not lift the guard on a hit read late: a camera that moved on is refused whatever was insisted on', async () => {
  let late = false
  const then = POSE
  const now: Pose = { position: { x: 0.2, y: 0, z: 0 }, rotation: POSE.rotation }
  const provider: TapProvider = {
    ...providerOf([]),
    hitTest: () => hit({ x: 0, y: -1.2, z: -2 }, 2),
    getPose: () => (late ? now : then),
    hitTestBurstAsync: async () => {
      late = true
      return { frames: [] }
    },
  }
  const refused = refusal(await sampleTap(provider, 0.5, 0.5, { insist: { position: { x: 0, y: -1.2, z: -2 }, range: true, spread: true } }))
  assert.equal(refused.reason, 'unsteady')
  assert.equal(refused.position, undefined, 'a read that was not the spot has no spot to confirm')
})

// ─── The floor ray's range is a limit too ──────────────────────────────────

/** A camera 1.5 m up, 25 degrees below the horizon: its centre pixel meets the floor 3.55 m away, past the limit. */
const SHALLOW: Pose = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: -Math.sin((25 * Math.PI) / 360), y: 0, z: 0, w: Math.cos((25 * Math.PI) / 360) } }
const FLOOR: GroundReading = { y: 0, locked: true, inlierCount: 300, residualM: 0.01 }
const RAY = floorRayPoint({ ...SHALLOW, fovYDeg: 60, aspect: 0.5625 }, 0.5, 0.5, 0)!

test('under prefer, a floor point beyond the range is refused with where the hits were, and let past where they land again', async () => {
  assert.ok(RAY.rangeM > TAP_RANGE_MAX_M, `fixture: the ray is ${RAY.rangeM} m`)
  // The hits sit on the ray 2 m from the camera, near enough, and well short of the floor.
  const dir = { x: (RAY.position.x - SHALLOW.position.x) / RAY.rangeM, y: (RAY.position.y - SHALLOW.position.y) / RAY.rangeM, z: (RAY.position.z - SHALLOW.position.z) / RAY.rangeM }
  const near = { x: dir.x * 2, y: SHALLOW.position.y + dir.y * 2, z: dir.z * 2 }
  const frames = Array.from({ length: 10 }, () => frame(hit(near, 2), { pose: SHALLOW }))
  const provider = providerOf(frames, { pose: SHALLOW })
  const first = refusal(await sampleTap(provider, 0.5, 0.5, { floor: FLOOR, floorRay: 'prefer' }))
  assert.equal(first.reason, 'too-far')
  assert.ok(Math.abs(first.rangeM! - RAY.rangeM) < 1e-9, 'the ray\'s range is the one told')
  assert.deepEqual(first.position, near, 'and the spot is where the hits were')
  const again = taken(await sampleTap(provider, 0.5, 0.5, { floor: FLOOR, floorRay: 'prefer', insist: { position: first.position!, range: true } }))
  assert.equal(again.source, 'floor-ray')
  assert.deepEqual(again.insisted, ['range'])
  assert.ok(Math.abs(again.rangeM - RAY.rangeM) < 1e-9, 'with the range it measured')
})

test('a tap the floor ray alone places, beyond the range, says where the ray put it, and is let past there', async () => {
  const frames = Array.from({ length: 10 }, () => frame(null, { pose: SHALLOW }))
  const provider = providerOf(frames, { pose: SHALLOW })
  const first = refusal(await sampleTap(provider, 0.5, 0.5, { floor: FLOOR, floorRay: 'fallback' }))
  assert.equal(first.reason, 'too-far')
  assert.deepEqual(first.position, RAY.position)
  const again = taken(await sampleTap(provider, 0.5, 0.5, { floor: FLOOR, floorRay: 'fallback', insist: { position: first.position!, range: true } }))
  assert.equal(again.source, 'floor-ray')
  assert.deepEqual(again.insisted, ['range'])
  const elsewhere = refusal(await sampleTap(provider, 0.5, 0.5, { floor: FLOOR, floorRay: 'fallback', insist: { position: moved(first.position!, 0.2), range: true } }))
  assert.equal(elsewhere.reason, 'too-far')
})

// ─── The words for a distance that rounds to the limit ──────────────────────

test('a refusal for range never prints a distance that reads as inside the limit', () => {
  const line = (rangeM: number) => tapRefusalText({ ok: false, reason: 'too-far', n: 12, rangeM })
  for (const rangeM of [TAP_RANGE_MAX_M + 0.001, 3.004, 3.04, 3.049, 3.05]) {
    assert.equal(line(rangeM), 'That spot is just over 3 m away. Move closer and tap again.', String(rangeM))
  }
  assert.equal(line(3.06), 'That spot is 3.1 m away. Move closer and tap again.')
  assert.equal(line(3.2), 'That spot is 3.2 m away. Move closer and tap again.')
  assert.equal(line(4.26), 'That spot is 4.3 m away. Move closer and tap again.')
  assert.equal(line(Number.NaN), 'Move closer to that spot and tap again.')
})
