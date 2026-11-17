/**
 * WP-09b: how the drift check reads a tap (src/ar/drift-tap.ts).
 *
 * `driftTapReader` is the one place the check's way of reading a tap is decided, so what it hands `sampleTap` is held
 * here against a fake provider: the burst the provider gives, the host's own hit test for a provider without one, and the
 * fitted floor as it is at each tap, taking part as a cross-check and never moving the point. `sampleTap`'s own rules
 * (outliers, range, spread, the floor ray's arithmetic) are tests/unit/node/tap_sampling.test.ts's; nothing here repeats
 * them.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-drift-tap.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driftTapReader } from '../../../src/ar/drift-tap.ts'
import type { GroundReading } from '../../../src/ar/ground-gate.ts'
import type { HitBurstFrame, HitResult, Pose } from '../../../src/ar/provider.ts'
import type { TapProvider, TapResult, TapSample } from '../../../src/ar/tap-sampling.ts'
import type { Vec3 } from '../../../src/world/types.ts'

/** A camera 0.6 m up, looking along -Z with its roll and pitch level: its ray through a pixel low on the screen meets the floor ahead. */
const CAMERA: Pose = { position: { x: 0, y: 0.6, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

const GOOD_FLOOR: GroundReading = { y: 0, locked: true, inlierCount: 400, residualM: 0.012, fallback: false }

function hit(position: Vec3): HitResult {
  return { position, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: Math.hypot(position.x - CAMERA.position.x, position.y - CAMERA.position.y, position.z - CAMERA.position.z) }
}

function burstOf(position: Vec3, n = 10): HitBurstFrame[] {
  return Array.from({ length: n }, () => ({ hit: hit(position), status: 'NORMAL' as const, pose: CAMERA }))
}

interface Calls {
  burst: Array<[number, number]>
  hitTest: Array<[number, number]>
}

/** A provider that has a burst (when given frames) and the members `sampleTap` reads; what it was asked is kept. */
function provider(frames: HitBurstFrame[] | null, calls: Calls): TapProvider {
  const base: TapProvider = {
    hitTest: () => null,
    getPose: () => CAMERA,
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.5625,
    trackingStatus: () => 'NORMAL',
  }
  if (frames) {
    base.hitTestBurstAsync = async (x, y) => {
      calls.burst.push([x, y])
      return { frames }
    }
  }
  return base
}

function sampleOf(result: TapResult): TapSample {
  assert.equal(result.ok, true, `the tap was refused: ${JSON.stringify(result)}`)
  return result as TapSample
}

const calls = (): Calls => ({ burst: [], hitTest: [] })

test('a tap is the burst the provider gave, read at the pixel the person tapped, and the host\'s hit test is not asked', async () => {
  const seen = calls()
  const spot: Vec3 = { x: 0.2, y: 0.02, z: -1.9 }
  const read = driftTapReader({
    provider: provider(burstOf(spot), seen),
    hitTest: async (x, y) => {
      seen.hitTest.push([x, y])
      return null
    },
    ground: () => null,
  })
  const tap = sampleOf(await read(0.25, 0.75))
  assert.equal(tap.source, 'burst')
  assert.deepEqual(seen.burst, [[0.25, 0.75]], 'the pixel is passed through as it came')
  assert.deepEqual(seen.hitTest, [], 'a provider with a burst is read by its burst')
  assert.deepEqual(tap.position, spot)
  assert.equal(tap.n, 10)
})

test('a provider with no burst is read through the host\'s own hit test, which is how WebXR is read', async () => {
  const seen = calls()
  const spot: Vec3 = { x: -0.3, y: 0.01, z: -1.7 }
  const read = driftTapReader({
    provider: provider(null, seen),
    hitTest: async (x, y) => {
      seen.hitTest.push([x, y])
      return hit(spot)
    },
    ground: () => null,
  })
  const tap = sampleOf(await read(0.75, 0.8))
  assert.equal(tap.source, 'single-hit')
  assert.deepEqual(seen.hitTest, [[0.75, 0.8]], 'the host\'s test is asked at the pixel the person tapped')
  assert.deepEqual(tap.position, spot)
})

test('the fitted floor is read when each tap is made, not once when the reader was built', async () => {
  const seen = calls()
  let reads = 0
  const read = driftTapReader({
    provider: provider(burstOf({ x: 0, y: 0, z: -1.8 }), seen),
    hitTest: async () => null,
    ground: () => {
      reads++
      return GOOD_FLOOR
    },
  })
  assert.equal(reads, 0, 'building the reader reads nothing')
  await read(0.5, 0.75)
  assert.equal(reads, 1)
  await read(0.5, 0.75)
  assert.equal(reads, 2, 'a floor that has settled since the last tap is the one the next tap is checked against')
})

test('a reliable floor is a cross-check: it reports that the hits slid and does not move the point', async () => {
  const seen = calls()
  // The hits sit 12 cm above where the floor fit says the floor is: a feature snapped to something on the floor.
  const spot: Vec3 = { x: 0, y: 0.12, z: -1.8 }
  const read = driftTapReader({ provider: provider(burstOf(spot), seen), hitTest: async () => null, ground: () => GOOD_FLOOR })
  const tap = sampleOf(await read(0.5, 0.75))
  assert.equal(tap.source, 'burst', 'the hits set the position, not the floor ray')
  assert.deepEqual(tap.position, spot, 'the point is where the hits were, as the calibration\'s own taps were')
  assert.ok(tap.floorRay, 'the floor ray is reported beside it')
  assert.equal(tap.floorRay.agrees, false, 'and says the hits and the floor disagree')
  assert.ok(Math.abs(tap.floorRay.position.y) < 1e-9, 'the ray met the floor the fit gave')
})

test('with no floor fit yet there is no floor ray, and the tap is still read', async () => {
  const seen = calls()
  const read = driftTapReader({ provider: provider(burstOf({ x: 0, y: 0, z: -1.8 }), seen), hitTest: async () => null, ground: () => null })
  const tap = sampleOf(await read(0.5, 0.75))
  assert.equal(tap.floorRay, undefined)
  assert.equal(tap.source, 'burst')
})

test('a spot that is too far is refused, in the result, not thrown', async () => {
  const seen = calls()
  const read = driftTapReader({ provider: provider(burstOf({ x: 0, y: 0, z: -6 }), seen), hitTest: async () => null, ground: () => null })
  const result = await read(0.5, 0.75)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'too-far')
})
