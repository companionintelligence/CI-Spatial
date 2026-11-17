/**
 * WP-05a: the repo's own XR8 mock (public/test-fixtures/xr8-mock.js, loaded by `?mock=xr8`) runs the 8th Wall
 * tap burst the way the engine does.
 *
 * Every `mock-*.spec.ts` calibrates against that mock, so a provider hook the mock cannot run is a Playwright
 * suite that breaks the day the calibration flow starts using it. The mock file is read as the browser would
 * read it and run against the real `EighthWallProvider` and `sampleTap()`, with real timers: the mock ticks at
 * 30 frames a second, and a burst takes about half a second of them.
 *
 * What the mock must do, because the burst depends on it: call a pipeline module that was added while the session
 * runs (the documentation has `onAttach` called on modules added before or after the pipeline runs,
 * https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule) from the next frame, which is the mock's choice
 * (which frame a real engine starts from is not documented), and stop calling it when it is removed. A mock with no
 * `removeCameraPipelineModule` leaves every tap's module behind, called on every frame for the rest of the session.
 *
 * What the mock cannot be: still. Its scripted camera glides, so a burst taken while it moves reads a few
 * centimetres of scatter and is refused as unsteady about half the time; the calibration spec freezes the
 * session (`XR8.freezeAt`) before it taps, and so does this.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tap_burst_mock.test.ts
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { sampleTap, type TapSample } from '../../../src/ar/tap-sampling.ts'

// ─── The page the mock is loaded into ──────────────────────────────────────

const location = { search: '' }
const page = {
  location,
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
  dispatchEvent: () => true,
} as Record<string, unknown>
const g = globalThis as Record<string, unknown>
g['window'] = page
g['location'] = location
g['document'] = {
  body: {},
  visibilityState: 'visible',
  querySelector: () => null,
  addEventListener(): void {},
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
}

const MOCK = fileURLToPath(new URL('../../../public/test-fixtures/xr8-mock.js', import.meta.url))
vm.runInThisContext(readFileSync(MOCK, 'utf8'), { filename: MOCK })
// In a browser `window` is the global object, so the mock's `window.XR8 = ...` is the `XR8` the provider reads.
g['XR8'] = page['XR8']

interface MockedEngine {
  addCameraPipelineModule(mod: unknown): void
  addCameraPipelineModules(mods: unknown[]): void
  removeCameraPipelineModule?: (name: string) => void
  run(opts: { canvas: null }): void
  stop(): void
  freezeAt(tick: number): number
}
const XR8 = g['XR8'] as MockedEngine

/** What `provider.start()` would have wired: the capture module that feeds each frame's reality to the provider. */
const provider = new EighthWallProvider()
XR8.addCameraPipelineModules([
  {
    name: 'ci-test-sync',
    onUpdate: (args: { processCpuResult: unknown }) => {
      ;(provider as unknown as { _syncReality(source: unknown, label: string, canvas: object): void })
        ._syncReality(args.processCpuResult, 'onUpdate', { width: 480, height: 360 })
    },
  },
])

// Watch what the provider does to the engine, without changing it.
const added: string[] = []
const removed: string[] = []
const removalErrors: unknown[] = []
const calls = new Map<string, number>()
const realAdd = XR8.addCameraPipelineModule.bind(XR8)
XR8.addCameraPipelineModule = (mod: unknown) => {
  const m = mod as { name: string; onUpdate?: (args: unknown) => void }
  added.push(m.name)
  const onUpdate = m.onUpdate
  if (onUpdate) {
    m.onUpdate = (args: unknown) => {
      calls.set(m.name, (calls.get(m.name) ?? 0) + 1)
      onUpdate(args)
    }
  }
  realAdd(mod)
}
const realRemove = XR8.removeCameraPipelineModule?.bind(XR8)
XR8.removeCameraPipelineModule = (name: string) => {
  removed.push(name)
  try {
    if (!realRemove) throw new TypeError('XR8.removeCameraPipelineModule is not a function')
    realRemove(name)
  } catch (error) {
    removalErrors.push(error)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

XR8.run({ canvas: null })
after(() => XR8.stop())

/** Waits until the mock's session has had its first ticks (LIMITED for twelve of them, then NORMAL) and the provider has a pose. */
async function untilTracking(): Promise<void> {
  for (let i = 0; i < 100 && !(provider.isTracking() && provider.trackingStatus() === 'NORMAL'); i++) await sleep(20)
  assert.equal(provider.trackingStatus(), 'NORMAL', 'the mock never reached NORMAL')
}

test('the mock has the engine call a module added mid-session, and stop calling it once it is removed', async () => {
  await untilTracking()
  assert.equal(typeof (page['XR8'] as MockedEngine).removeCameraPipelineModule, 'function')
  await sampleTap(provider, 0.5, 0.6)
  const [name] = added
  assert.match(name, /^ci-tap-burst-\d+$/)
  assert.ok((calls.get(name) ?? 0) >= 3, `the engine called the module ${calls.get(name) ?? 0} times`)
  assert.deepEqual(removed, [name], 'the provider removed it, once')
  assert.deepEqual(removalErrors, [], 'and the engine accepted the removal')

  const calledAtClose = calls.get(name)
  await sleep(150)
  assert.equal(calls.get(name), calledAtClose, 'a removed module is not called on the frames after it')
})

test('with the session frozen, as the calibration spec leaves it, a tap on the mock\'s room is a steady burst', async () => {
  XR8.freezeAt(300)
  await sleep(100)
  const tap = await sampleTap(provider, 0.5, 0.6)
  assert.equal(tap.ok, true, JSON.stringify(tap))
  const sample = tap as TapSample
  assert.equal(sample.source, 'burst')
  assert.equal(sample.spreadM, 0, 'every frame of a frozen session answers the same hit')
  assert.ok(sample.n >= 3 && sample.n <= 20, `${sample.n} hits in a 450 ms window at the mock's 30 frames a second`)
  assert.ok(sample.rangeM > 2 && sample.rangeM < 3, `${sample.rangeM} m`)
  assert.deepEqual(removalErrors, [])
})

test('removing a module leaves the others running', async () => {
  let probeCalls = 0
  XR8.addCameraPipelineModule({ name: 'ci-test-probe', onUpdate: () => { probeCalls++ } })
  await sampleTap(provider, 0.5, 0.6)
  const atClose = probeCalls
  assert.ok(atClose >= 3, 'the probe ran through the burst')
  await sleep(150)
  assert.ok(probeCalls > atClose, `the probe was called ${probeCalls - atClose} times after the burst's module was removed`)
  XR8.removeCameraPipelineModule?.('ci-test-probe')
})

test('a module added while a frame is being delivered is first called on the next frame, as in the engine', async () => {
  let aCalls = 0
  const firstSeenAt: number[] = []
  let added = false
  XR8.addCameraPipelineModule({
    name: 'ci-test-adder',
    onUpdate: () => {
      aCalls++
      if (added) return
      added = true
      XR8.addCameraPipelineModule({ name: 'ci-test-added', onUpdate: () => { if (firstSeenAt.length === 0) firstSeenAt.push(aCalls) } })
    },
  })
  for (let i = 0; i < 60 && firstSeenAt.length === 0; i++) await sleep(20)
  assert.deepEqual(firstSeenAt, [2], 'the adder had been called twice, so the module it added was not called in the frame it was added in')
})

test('every tap leaves exactly the modules it found: nothing it added is still in the mock afterwards', async () => {
  const before = added.length
  for (let i = 0; i < 3; i++) await sampleTap(provider, 0.4 + 0.05 * i, 0.6)
  const names = added.slice(before)
  assert.equal(names.length, 3)
  assert.equal(new Set(names).size, 3, 'a new name for each burst')
  assert.deepEqual(removed.slice(-3), names)
  const settled = names.map((n) => calls.get(n))
  await sleep(150)
  assert.deepEqual(names.map((n) => calls.get(n)), settled, 'none of the three is called any more')
})
