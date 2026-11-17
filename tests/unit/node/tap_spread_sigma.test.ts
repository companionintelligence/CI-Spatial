/**
 * `TapSample.spreadM` is the scatter of the hits inside ONE burst, in three dimensions, and it does not feed sigma-hat.
 *
 * Sigma-hat is the per-axis tap noise the frame fit and its verdict assume (today the adopted `TAP_SIGMA0_M`, 3 cm, in
 * src/world/baseline-guidance.ts). The burst's own scatter looks like a measurement of it and is not one: with the refusal at
 * `TAP_SPREAD_MAX_M` an accepted burst scatters by at most about 2.3 cm per axis, below the 3 cm assumed, and it sees none of what
 * makes two visits disagree (map drift between sessions, the feature the hit test settled on, the person's own re-tap). Wiring it
 * into sigma-hat would make the verdict stricter or looser for a reason that has nothing to do with between-visit noise. DX2
 * (docs/testing/DEVICE_TESTING.md) is what gives a measured figure; until then sigma-hat stays the adopted one.
 *
 * What these tests hold: that `spreadM` is what the comment on it says (a 3-D root mean square, not a per-axis figure), the arithmetic
 * of the "about 2.3 cm per axis" it quotes, that the comment says so and says what it must not be used for, and that no module that
 * defines sigma-hat reads it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tap_spread_sigma.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAP_SPREAD_MAX_M, sampleTap, type TapProvider, type TapSample } from '../../../src/ar/tap-sampling.ts'
import { TAP_SIGMA0_M } from '../../../src/world/baseline-guidance.ts'
import type { HitBurstFrame, Pose } from '../../../src/ar/provider.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const POSE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
const BASE: Vec3 = { x: 0.4, y: -1.2, z: -1.6 }

/** A provider whose burst returns exactly these hits, one per frame. */
function providerOf(offsets: Vec3[]): TapProvider {
  const frames: HitBurstFrame[] = offsets.map((o) => ({
    hit: { position: { x: BASE.x + o.x, y: BASE.y + o.y, z: BASE.z + o.z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2 },
    status: 'NORMAL',
  }))
  return {
    hitTest: () => null,
    hitTestBurstAsync: async () => ({ frames }),
    getPose: () => POSE,
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.5625,
    trackingStatus: () => 'NORMAL',
  }
}

async function tapOf(offsets: Vec3[]): Promise<TapSample> {
  const result = await sampleTap(providerOf(offsets), 0.5, 0.6)
  assert.equal(result.ok, true, `expected a tap, got ${JSON.stringify(result)}`)
  return result as TapSample
}

/** Six hits that sit `a` from the median on every axis, in a pattern that leaves each axis's median at the base. */
const ON_ALL_THREE_AXES = (a: number): Vec3[] => [
  { x: a, y: a, z: a },
  { x: -a, y: -a, z: -a },
  { x: a, y: -a, z: a },
  { x: -a, y: a, z: -a },
  { x: a, y: a, z: -a },
  { x: -a, y: -a, z: a },
]

test('spreadM is the three-dimensional root mean square about the median: sqrt(3) times the per-axis scatter, not the per-axis figure', async () => {
  const a = 0.01
  const tap = await tapOf(ON_ALL_THREE_AXES(a))
  assert.equal(tap.source, 'burst')
  assert.ok(Math.abs(tap.position.x - BASE.x) < 1e-12 && Math.abs(tap.position.y - BASE.y) < 1e-12 && Math.abs(tap.position.z - BASE.z) < 1e-12, 'the median is the base on every axis')
  assert.ok(Math.abs(tap.spreadM! - Math.sqrt(3) * a) < 1e-12, `spreadM is ${tap.spreadM}, the 3-D figure is ${Math.sqrt(3) * a}, the per-axis one ${a}`)
  assert.ok(tap.spreadM! > a * 1.7, 'it is not a per-axis number')
})

test('a scatter on one axis alone is the same number in 3-D as per axis, and vertical scatter counts', async () => {
  const a = 0.015
  const vertical = await tapOf([0, 1, 2, 3, 4, 5].map((i) => ({ x: 0, y: i % 2 === 0 ? a : -a, z: 0 })))
  assert.ok(Math.abs(vertical.spreadM! - a) < 1e-12, 'hits that differ only in height are a scatter')
})

test('the "about 2.3 cm per axis" the comment quotes is the refusal limit over the root of three, and it is below the 3 cm sigma-hat assumes', () => {
  const perAxisAtTheLimit = TAP_SPREAD_MAX_M / Math.sqrt(3)
  assert.ok(Math.abs(perAxisAtTheLimit - 0.0231) < 0.0001, `${perAxisAtTheLimit}`)
  assert.ok(perAxisAtTheLimit < TAP_SIGMA0_M, 'so a burst accepted at the limit reads as a better tap than the assumption: its scatter cannot stand in for it')
  assert.equal(TAP_SIGMA0_M, 0.03, 'sigma-hat is still the adopted figure: the document says so until DX2 measures a between-session one')
})

test('the comment on spreadM says what it is and what it must not be used for', () => {
  const source = readFileSync(join(ROOT, 'src/ar/tap-sampling.ts'), 'utf8')
  const at = source.indexOf('  spreadM: number | null\n  /** Hits kept.')
  assert.ok(at > 0, 'TapSample.spreadM is found')
  const comment = source.slice(source.lastIndexOf('/**', at), at).replace(/\s*\n\s*\*\s*/g, ' ')
  for (const said of ['three dimensions', 'ONE burst', 'must not feed sigma-hat', 'TAP_SIGMA0_M', 'about 2.3 cm per axis', 'map drift between sessions', 'DX2']) {
    assert.ok(comment.includes(said), `the comment on spreadM no longer says "${said}"`)
  }
})

test('no module that defines sigma-hat reads the burst scatter', () => {
  const definers = ['src/world/baseline-guidance.ts', 'src/world/frame-fit.ts', 'src/world/scale-policy.ts']
  let read = 0
  for (const path of definers) {
    if (!existsSync(join(ROOT, path))) continue
    read++
    const text = readFileSync(join(ROOT, path), 'utf8')
    assert.doesNotMatch(text, /\bspreadM\b|\btapSpreadM\b/, `${path} reads the burst's scatter: it must not feed sigma-hat (see TapSample.spreadM)`)
  }
  assert.ok(read >= 1, 'at least the file that holds TAP_SIGMA0_M was read')
})
