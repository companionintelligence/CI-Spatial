/**
 * `?mockJumpAt=<tick>` on the mock engine (public/test-fixtures/xr8-mock.js, WP-09).
 *
 * The browser specs run against the mock instead of a phone. A frame shift is not something a
 * script of poses can show unless the script has one in it: from the named tick on, the
 * scripted camera is 1 m further along Z, tracking still NORMAL, the walk otherwise unchanged.
 * That is a relocalization as the app sees it, and what tests/mock-frame-epoch.spec.ts
 * (a Playwright smoke, not run here) leans on.
 *
 * The mock is a classic script that installs `window.XR8`; this loads it into a fresh context
 * with just enough of a page around it, and runs its own ticks on a mocked clock.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/xr8_mock_jump.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FrameEpochTracker } from '../../../src/ar/frame-epoch.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SOURCE = readFileSync(join(ROOT, 'public/test-fixtures/xr8-mock.js'), 'utf8')
const TICK_MS = 33

interface Reality {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  trackingStatus: string
}

interface Mock {
  addCameraPipelineModules(mods: Array<{ name: string; onUpdate?: (a: { processCpuResult: { reality: Reality } }) => void }>): void
  run(opts: { canvas: null }): void
  stop(): void
  jumpAt(tick: number | null): number | null
}

/** The mock, loaded as a page would, with `search` as the URL's query. Returns it and the realities it emits. */
function load(t: { mock: { method: (o: object, m: string, i: () => void) => unknown } }, search: string): { xr8: Mock; realities: Reality[]; advance(ticks: number): void } {
  t.mock.method(console, 'log', () => {})
  // Its own clock: the mock asks for one setInterval, and each tick is one call of it.
  const intervals = new Map<number, () => void>()
  const window: { XR8?: Mock; dispatchEvent(): void } = { dispatchEvent() {} }
  const sandbox = {
    window,
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    location: { search },
    console,
    setInterval: (fn: () => void) => {
      intervals.set(intervals.size + 1, fn)
      return intervals.size
    },
    clearInterval: (id: number) => {
      intervals.delete(id)
    },
    CustomEvent: class {},
    URLSearchParams,
    Math,
    Number,
    isFinite,
    Error,
    Uint8Array,
  }
  vm.runInNewContext(SOURCE, sandbox)
  const xr8 = window.XR8
  assert.ok(xr8, 'the mock did not install window.XR8')
  const realities: Reality[] = []
  xr8.addCameraPipelineModules([{ name: 'probe', onUpdate: (a) => realities.push(a.processCpuResult.reality) }])
  xr8.run({ canvas: null })
  return {
    xr8,
    realities,
    advance(ticks) {
      for (let i = 0; i < ticks; i++) for (const tick of [...intervals.values()]) tick()
    },
  }
}

test('without the option, the scripted camera never steps', (t) => {
  const { realities, advance } = load(t, '?mock=xr8')
  advance(200)
  assert.equal(realities.length, 200)
  assert.ok(realities.every((r) => r.position.z === 2.4))
})

test('with ?mockJumpAt=<tick>, the camera is a metre further along Z from that tick on, and the status does not change', (t) => {
  const { realities, advance } = load(t, '?mock=xr8&mockJumpAt=60')
  advance(120)
  // The mock counts ticks from 1: the frame emitted for tick 60 is the 60th.
  assert.equal(realities[58].position.z, 2.4)
  assert.equal(realities[59].position.z, 3.4)
  assert.equal(realities[119].position.z, 3.4)
  assert.deepEqual(realities.slice(12).map((r) => r.trackingStatus).filter((s) => s !== 'NORMAL'), [], 'a relocalization the engine does not announce')
  // The rest of the walk is the same walk: x and y match an unshifted run, tick for tick.
  const plain = load(t, '?mock=xr8')
  plain.advance(120)
  assert.deepEqual(realities.map((r) => [r.position.x, r.position.y]), plain.realities.map((r) => [r.position.x, r.position.y]))
})

test('values that are not a tick are ignored, as a URL is not a call', (t) => {
  for (const search of ['?mockJumpAt=', '?mockJumpAt=soon', '?mockJumpAt=-3', '?mockJumpAt=NaN']) {
    const { realities, advance } = load(t, `?mock=xr8&${search.slice(1)}`)
    advance(40)
    assert.ok(realities.every((r) => r.position.z === 2.4), search)
  }
})

test('jumpAt() sets and clears it from a script, and refuses what is not a tick', (t) => {
  const { xr8, realities, advance } = load(t, '?mock=xr8')
  assert.equal(xr8.jumpAt(30), 30)
  advance(40)
  assert.equal(realities[39].position.z, 3.4)
  assert.equal(xr8.jumpAt(null), null)
  advance(1)
  assert.equal(realities[40].position.z, 2.4, 'taken away')
  assert.throws(() => xr8.jumpAt(-1), /non-negative/)
  assert.throws(() => xr8.jumpAt(Number.NaN), /non-negative/)
})

test('the app\'s frame-epoch detector reads the mock\'s jump as one frame shift, and the walk before it as none', (t) => {
  const { realities, advance } = load(t, '?mock=xr8&mockJumpAt=90')
  advance(180)
  const tracker = new FrameEpochTracker()
  const events = []
  realities.forEach((r, i) => {
    const event = tracker.observe({ tMs: i * TICK_MS, pose: { position: r.position, rotation: r.rotation }, status: r.trackingStatus })
    if (event) events.push(event)
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].cause, 'jump')
  assert.equal(events[0].atMs, 89 * TICK_MS, 'at the frame emitted for tick 90')
  assert.ok(Math.abs((events[0].unexplainedM ?? 0) - 1) < 0.02)
})
