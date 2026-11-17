/**
 * WP-05a: the providers' hit-test bursts, and the window, watchdog and cleanup
 * they share (src/ar/hit-burst.ts).
 *
 * `EighthWallProvider` and `WebXRProvider` are the real classes, driven by a fake
 * XR8 and a fake XRSession, as wp-c-camera-verdict and wp-c-webxr-teardown drive
 * them. What is under test is what must be true of any burst: one hit per frame,
 * every frame reported with the status the runtime gave it, and nothing left open
 * (a pipeline module, a hit-test source, an 'end' listener) however the window
 * closes. The repo's own XR8 mock runs the same burst in tap_burst_mock.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tap_burst_providers.test.ts
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { collectBurst, type BurstRun } from '../../../src/ar/hit-burst.ts'
import { EighthWallProvider, hitTypesFromSearch } from '../../../src/ar/eighthwall.ts'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import { sampleTap, type TapSample } from '../../../src/ar/tap-sampling.ts'
import type { HitBurstFrame } from '../../../src/ar/provider.ts'

// ─── Browser globals the providers touch ───────────────────────────────────

;(globalThis as { window?: unknown }).window = {
  location: { search: '' },
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
}
;(globalThis as { document?: unknown }).document = {
  body: {},
  visibilityState: 'visible',
  querySelector: () => null,
  addEventListener(): void {},
  createElement: () => ({}),
}

class FakeXRRay {
  origin: unknown
  direction: unknown
  constructor(origin: unknown, direction: unknown) {
    this.origin = origin
    this.direction = direction
  }
}
;(globalThis as { XRRay?: unknown }).XRRay = FakeXRRay

/** Lets promise callbacks that are already queued run. Timers are not involved. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

const frameOf = (n: number): HitBurstFrame => ({ hit: null, status: 'NORMAL', poseJumps: n })

/**
 * Whether a burst has settled without any time passing. Every burst has a watchdog, so a test that awaits one
 * proves nothing about the road it was meant to take unless the watchdog cannot rescue it: use this with mock
 * timers, so a path that forgot to close the burst shows as pending instead of as slow.
 */
async function settledAtOnce(burst: Promise<unknown>): Promise<boolean> {
  return Promise.race([burst.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))])
}

// ═══ collectBurst: the window, the watchdog and the release ═════════════════

interface Harness {
  releases: number
  run: BurstRun | null
}

function start(h: Harness, behaviour: (run: BurstRun) => void = () => {}): (run: BurstRun) => () => void {
  return (run) => {
    h.run = run
    behaviour(run)
    return () => {
      h.releases++
    }
  }
}

test('collectBurst: the window runs from the first frame, and the burst closes on the frame that ends it', async () => {
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(300, 1000, start(h))
  // The first frame arrives long after the call (a hit-test source took a while to open); it still gets 300 ms.
  for (const t of [5000, 5100, 5200, 5299, 5300, 5400]) h.run!.frame(frameOf(t), t)
  const result = await burst
  assert.deepEqual(result.frames.map((f) => f.poseJumps), [5000, 5100, 5200, 5299, 5300])
  assert.equal(h.releases, 1)
  assert.equal(h.run!.done, true)
})

test('collectBurst: a window of nothing, or of nonsense, closes on the first frame', async () => {
  for (const windowMs of [0, -5, Number.NaN]) {
    const h: Harness = { releases: 0, run: null }
    const burst = collectBurst(windowMs, 1000, start(h))
    h.run!.frame(frameOf(1), 10)
    h.run!.frame(frameOf(2), 20)
    assert.equal((await burst).frames.length, 1, `window ${windowMs}`)
    assert.equal(h.releases, 1)
  }
})

test('collectBurst: frames that arrive after the burst closed are ignored', async () => {
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(0, 1000, start(h))
  h.run!.frame(frameOf(1), 0)
  const result = await burst
  h.run!.frame(frameOf(2), 1)
  assert.equal(result.frames.length, 1)
})

test('collectBurst: the watchdog settles a burst whose frames never come, with the frames it had, and releases', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(450, 1000, start(h))
  h.run!.frame(frameOf(1), 0)
  t.mock.timers.tick(1449)
  assert.equal(h.run!.done, false, 'one millisecond early')
  t.mock.timers.tick(1)
  const result = await burst
  assert.equal(result.frames.length, 1)
  assert.equal(h.releases, 1)
})

test('collectBurst: a watchdog with no frame at all resolves with none', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(450, 1000, start(h))
  t.mock.timers.tick(1450)
  assert.deepEqual(await burst, { frames: [] })
  assert.equal(h.releases, 1)
})

test('collectBurst: finishing from outside (the session ended) settles with the frames so far and releases once', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(450, 1000, start(h))
  h.run!.frame(frameOf(1), 0)
  h.run!.frame(frameOf(2), 40)
  h.run!.finish()
  h.run!.finish()
  assert.equal((await burst).frames.length, 2)
  // The watchdog was cleared: letting its time pass releases nothing again.
  t.mock.timers.tick(5000)
  assert.equal(h.releases, 1)
})

test('collectBurst: a window that ended cancels its watchdog, so nothing is released twice', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(100, 1000, start(h))
  h.run!.frame(frameOf(1), 0)
  h.run!.frame(frameOf(2), 100)
  await burst
  t.mock.timers.tick(10_000)
  assert.equal(h.releases, 1)
})

test('collectBurst: a start that throws settles with no frames, never rejects, and leaves no timer running', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = t.mock.method(globalThis, 'setTimeout')
  const cleared = t.mock.method(globalThis, 'clearTimeout')
  const result = await collectBurst(450, 1000, () => {
    throw new Error('could not register')
  }, { firstFrameMs: 300 })
  assert.deepEqual(result, { frames: [] })
  assert.equal(started.mock.callCount(), 2, 'the watchdog and the first-frame deadline were both started')
  const handles = cleared.mock.calls.map((c) => c.arguments[0]).filter((h) => h !== undefined)
  assert.equal(handles.length, 2, 'and both were cleared')
  assert.notEqual(handles[0], handles[1])
})

test('collectBurst: a burst finished inside start is released as soon as start has returned the release', async () => {
  const h: Harness = { releases: 0, run: null }
  const result = await collectBurst(450, 1000, start(h, (run) => run.finish()))
  assert.deepEqual(result, { frames: [] })
  assert.equal(h.releases, 1)
})

test('collectBurst: a release that throws is swallowed, because what it held is already gone', async () => {
  const result = await collectBurst(0, 1000, (run) => {
    queueMicrotask(() => run.frame(frameOf(1), 0))
    return () => {
      throw new Error('the session is gone')
    }
  })
  assert.equal(result.frames.length, 1)
})

test('collectBurst: a grace that is not a number does not make the watchdog fire at once', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(450, Number.NaN, start(h))
  t.mock.timers.tick(449)
  assert.equal(h.run!.done, false)
  t.mock.timers.tick(1)
  await burst
  assert.equal(h.releases, 1)
})

test('collectBurst: no frame by the first-frame deadline closes the burst empty and releases it, long before the watchdog', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(450, 1000, start(h), { firstFrameMs: 300 })
  t.mock.timers.tick(299)
  assert.equal(h.run!.done, false, 'one millisecond early')
  t.mock.timers.tick(1)
  assert.equal(await settledAtOnce(burst), true)
  assert.deepEqual(await burst, { frames: [] })
  assert.equal(h.releases, 1)
  t.mock.timers.tick(5000)
  assert.equal(h.releases, 1, 'and the watchdog it replaced does not release it again')
})

test('collectBurst: a frame inside the first-frame deadline cancels it, so the window and the watchdog decide alone', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(450, 1000, start(h), { firstFrameMs: 300 })
  t.mock.timers.tick(299)
  h.run!.frame(frameOf(1), 0)
  t.mock.timers.tick(1)
  assert.equal(h.run!.done, false, 'the deadline did not fire')
  t.mock.timers.tick(1149)
  assert.equal(h.run!.done, false, 'one millisecond before the watchdog')
  t.mock.timers.tick(1)
  assert.equal((await burst).frames.length, 1)
  assert.equal(h.releases, 1)
})

test('collectBurst: a deadline that is not given, or not a number, is no deadline', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const options of [{}, { firstFrameMs: Number.NaN }, { firstFrameMs: undefined }]) {
    const h: Harness = { releases: 0, run: null }
    const burst = collectBurst(450, 1000, start(h), options)
    t.mock.timers.tick(1449)
    assert.equal(h.run!.done, false, JSON.stringify(options))
    t.mock.timers.tick(1)
    await burst
  }
})

test('collectBurst: a deadline of nothing closes an empty burst at once, and a negative one is the same', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const firstFrameMs of [0, -5]) {
    const h: Harness = { releases: 0, run: null }
    const burst = collectBurst(450, 1000, start(h), { firstFrameMs })
    t.mock.timers.tick(0)
    assert.deepEqual(await burst, { frames: [] }, `${firstFrameMs}`)
  }
})

test('collectBurst: the listener hears each frame with the time since the first, and nothing after the burst closed', async () => {
  const heard: Array<[number, number]> = []
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(100, 1000, start(h), { onFrame: (frame, elapsedMs) => heard.push([frame.poseJumps as number, elapsedMs]) })
  h.run!.frame(frameOf(1), 5000)
  h.run!.frame(frameOf(2), 5040)
  h.run!.frame(frameOf(3), 5100)
  h.run!.frame(frameOf(4), 5140)
  await burst
  assert.deepEqual(heard, [[1, 0], [2, 40], [3, 100]], 'the frame that closed the window is heard; the one after it is not')
})

test('collectBurst: a listener that throws is ignored, and its frame still counts and can still close the burst', async () => {
  const h: Harness = { releases: 0, run: null }
  const burst = collectBurst(50, 1000, start(h), {
    onFrame: () => {
      throw new Error('the ring could not be drawn')
    },
  })
  h.run!.frame(frameOf(1), 0)
  h.run!.frame(frameOf(2), 60)
  assert.equal((await burst).frames.length, 2)
  assert.equal(h.releases, 1)
})

// ═══ EighthWallProvider.hitTestBurstAsync ═══════════════════════════════════

interface FakeModule {
  name: string
  onUpdate: (args: unknown) => void
}

interface FakeEngine {
  modules: Map<string, FakeModule>
  removed: string[]
  hitCalls: Array<{ x: number; y: number; types: string[] }>
  hits: () => unknown[]
  hitThrows: boolean
  addThrows: boolean
}

const engine: FakeEngine = {
  modules: new Map(),
  removed: [],
  hitCalls: [],
  hits: () => [{ type: 'FEATURE_POINT', position: { x: 0.1, y: -1.2, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2.003 }],
  hitThrows: false,
  addThrows: false,
}

function installEngine(): void {
  engine.modules.clear()
  engine.removed = []
  engine.hitCalls = []
  engine.hitThrows = false
  engine.addThrows = false
  engine.hits = () => [{ type: 'FEATURE_POINT', position: { x: 0.1, y: -1.2, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2.003 }]
  ;(globalThis as { XR8?: unknown }).XR8 = {
    addCameraPipelineModule(mod: FakeModule): void {
      if (engine.addThrows) throw new Error('the engine would not take the module')
      if (!engine.modules.has(mod.name)) engine.modules.set(mod.name, mod)
    },
    removeCameraPipelineModule(name: string): void {
      engine.removed.push(name)
      engine.modules.delete(name)
    },
    XrController: {
      hitTest(x: number, y: number, types: string[]): unknown[] {
        engine.hitCalls.push({ x, y, types })
        if (engine.hitThrows) throw new Error('map miss')
        return engine.hits()
      },
    },
  }
}

// The running count of frame shifts lives in the provider's frame-epoch tracker (src/ar/frame-epoch.ts), not on the provider.
type EighthWallInternals = { _slamReady: boolean; _epochs: { _poseJumps: number }; latestPose: unknown }
const wall = (p: EighthWallProvider): EighthWallInternals => p as unknown as EighthWallInternals

function readyEighthWall(): EighthWallProvider {
  installEngine()
  const provider = new EighthWallProvider()
  wall(provider)._slamReady = true
  return provider
}

/** What the engine hands a pipeline module's onUpdate: this frame's reality inside processCpuResult. */
function realityUpdate(status = 'NORMAL', reason: string | null = 'UNSPECIFIED', at = { x: 0, y: 0, z: 0 }): unknown {
  return {
    processCpuResult: {
      reality: {
        position: at,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        trackingStatus: status,
        ...(reason === null ? {} : { trackingReason: reason }),
      },
    },
  }
}

/** A clock `performance.now()` reads, advanced by the test. */
function clockAt(t: TestContext, start = 1000): { now: number } {
  const clock = { now: start }
  t.mock.method(globalThis.performance, 'now', () => clock.now)
  return clock
}

test('8th Wall burst: one module for the window, one FEATURE_POINT hit test per frame, removed when the window closes', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 450)

  assert.equal(engine.modules.size, 1, 'one module is registered for the window')
  const [name] = [...engine.modules.keys()]
  assert.match(name, /^ci-tap-burst-\d+$/)
  const module = engine.modules.get(name)!

  let frames = 0
  while (engine.modules.has(name)) {
    module.onUpdate(realityUpdate())
    frames++
    clock.now += 33
    assert.ok(frames < 100, 'the window never closed')
  }
  const result = await burst

  assert.equal(frames, 15, 'frames at 0, 33 ... 462 ms: the window closes on the first at or past 450')
  assert.equal(result.frames.length, 15)
  assert.deepEqual(engine.removed, [name], 'the module is removed exactly once')
  assert.equal(engine.hitCalls.length, 15, 'one hit test per frame')
  for (const call of engine.hitCalls) assert.deepEqual(call, { x: 0.5, y: 0.6, types: ['FEATURE_POINT'] })
  for (const f of result.frames) {
    assert.deepEqual(f.hit?.position, { x: 0.1, y: -1.2, z: -2 })
    assert.equal(f.hit?.distance, 2.003)
    assert.equal(f.status, 'NORMAL')
    assert.equal(f.reason, 'UNSPECIFIED')
    assert.deepEqual(f.pose, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
    assert.equal(f.poseJumps, 0)
  }

  // A frame the engine delivers after the window is ignored: no hit test, nothing recorded.
  module.onUpdate(realityUpdate())
  assert.equal(engine.hitCalls.length, 15)
})

test('8th Wall burst: the status and reason the engine published for each frame are reported verbatim', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 100)
  const module = [...engine.modules.values()][0]
  const script: Array<[string, string | null]> = [['NORMAL', 'UNSPECIFIED'], ['LIMITED', 'RELOCALIZING'], ['NORMAL', null], ['UNSPECIFIED', 'INITIALIZING'], ['NORMAL', null]]
  for (const [status, reason] of script) {
    module.onUpdate(realityUpdate(status, reason))
    clock.now += 40
  }
  const result = await burst
  // Frames at 0, 40, 80 and 120 ms: the fourth is the one that closes a 100 ms window, and is kept. The fifth is
  // after the window and is not.
  assert.deepEqual(result.frames.map((f) => [f.status, f.reason]), [
    ['NORMAL', 'UNSPECIFIED'],
    ['LIMITED', 'RELOCALIZING'],
    ['NORMAL', undefined],
    ['UNSPECIFIED', 'INITIALIZING'],
  ])
})

test('8th Wall burst: a reality that carries no status says UNKNOWN, and a frame with no reality says NOT_AVAILABLE and has no pose', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 50)
  const module = engine.modules.values().next().value!
  const noStatus = realityUpdate()
  delete (noStatus as { processCpuResult: { reality: Record<string, unknown> } }).processCpuResult.reality['trackingStatus']
  module.onUpdate(noStatus)
  clock.now += 60
  module.onUpdate({ processCpuResult: {} })
  const [withReality, without] = (await burst).frames
  assert.equal(withReality.status, 'UNKNOWN')
  assert.ok(withReality.pose)
  assert.equal(without.status, 'NOT_AVAILABLE', 'the engine had no reality for the frame: it could not say where the phone was')
  assert.equal(without.pose, undefined)
  assert.equal(without.reason, undefined)
})

test('8th Wall burst: the provider\'s running count of frame shifts rides on every frame', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 100)
  const module = [...engine.modules.values()][0]
  module.onUpdate(realityUpdate())
  clock.now += 50
  wall(provider)._epochs._poseJumps = 1
  module.onUpdate(realityUpdate())
  clock.now += 60
  module.onUpdate(realityUpdate())
  assert.deepEqual((await burst).frames.map((f) => f.poseJumps), [0, 1, 1])
})

test('8th Wall burst: before SLAM is ready there is no hit test to call, and the frame has no hit', async (t: TestContext) => {
  clockAt(t)
  const provider = readyEighthWall()
  wall(provider)._slamReady = false
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 0)
  engine.modules.values().next().value!.onUpdate(realityUpdate())
  const [only] = (await burst).frames
  assert.equal(only.hit, null)
  assert.equal(engine.hitCalls.length, 0)
})

test('8th Wall burst: a hit test that throws costs that frame its hit and nothing else', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 60)
  const module = [...engine.modules.values()][0]
  engine.hitThrows = true
  module.onUpdate(realityUpdate())
  clock.now += 30
  engine.hitThrows = false
  module.onUpdate(realityUpdate())
  clock.now += 40
  module.onUpdate(realityUpdate())
  const frames = (await burst).frames
  assert.deepEqual(frames.map((f) => f.hit !== null), [false, true, true])
})

test('8th Wall burst: if the engine stops delivering frames the watchdog settles the burst and removes the module', async (t: TestContext) => {
  clockAt(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 450)
  const [name] = [...engine.modules.keys()]
  engine.modules.get(name)!.onUpdate(realityUpdate())
  t.mock.timers.tick(1449)
  assert.equal(engine.modules.has(name), true, 'a frame came, so the first-frame deadline is over and only the watchdog is left')
  t.mock.timers.tick(1)
  assert.equal((await burst).frames.length, 1)
  assert.deepEqual(engine.removed, [name])
})

test('8th Wall burst: a module the engine never calls settles empty after 300 ms, not after the whole watchdog, and is removed', async (t: TestContext) => {
  clockAt(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 450)
  const [name] = [...engine.modules.keys()]
  t.mock.timers.tick(299)
  assert.equal(engine.modules.has(name), true, 'one millisecond early')
  t.mock.timers.tick(1)
  assert.deepEqual(await burst, { frames: [] })
  assert.deepEqual(engine.removed, [name])
})

test('8th Wall burst: a module the engine will not take settles with no frames, and removes nothing', async () => {
  const provider = readyEighthWall()
  engine.addThrows = true
  assert.deepEqual(await provider.hitTestBurstAsync(0.5, 0.6, 450), { frames: [] })
  assert.deepEqual(engine.removed, [])
})

test('8th Wall burst: with no engine loaded there is nothing to burst, and it says so at once', async () => {
  const provider = new EighthWallProvider()
  delete (globalThis as { XR8?: unknown }).XR8
  assert.deepEqual(await provider.hitTestBurstAsync(0.5, 0.6, 450), { frames: [] })
})

test('8th Wall burst: two bursts at once get two modules with two names, and each removes its own', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const first = provider.hitTestBurstAsync(0.2, 0.2, 50)
  const second = provider.hitTestBurstAsync(0.8, 0.8, 50)
  const names = [...engine.modules.keys()]
  assert.equal(names.length, 2)
  assert.notEqual(names[0], names[1])
  for (const m of [...engine.modules.values()]) m.onUpdate(realityUpdate())
  clock.now += 60
  for (const m of [...engine.modules.values()]) m.onUpdate(realityUpdate())
  await Promise.all([first, second])
  assert.deepEqual([...engine.removed].sort(), [...names].sort())
  assert.equal(engine.modules.size, 0)
})

/** The same update the engine makes on a frame the display refreshed but the camera did not: same reality, flagged. */
function repeatUpdate(): unknown {
  return { ...(realityUpdate() as object), frameStartResult: { repeatFrame: true } }
}

/** And on a frame the camera delivered, which carries the flag too, false. */
function freshUpdate(): unknown {
  return { ...(realityUpdate() as object), frameStartResult: { repeatFrame: false } }
}

test('8th Wall burst: a call the engine makes for a repeat of the same camera frame is no frame of the burst', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 100)
  const module = [...engine.modules.values()][0]
  module.onUpdate(freshUpdate())
  clock.now += 20
  module.onUpdate(repeatUpdate())
  assert.equal(engine.hitCalls.length, 1, 'the repeat did not ask the engine for another hit')
  clock.now += 20
  module.onUpdate(repeatUpdate())
  clock.now += 40
  module.onUpdate(freshUpdate())
  clock.now += 60
  module.onUpdate(freshUpdate())
  const result = await burst
  assert.equal(result.frames.length, 3, 'three camera frames, five calls')
  assert.equal(engine.hitCalls.length, 3)
})

test('8th Wall burst: only a repeat flag that is true makes a call a repeat', async (t: TestContext) => {
  clockAt(t)
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 0)
  const module = [...engine.modules.values()][0]
  module.onUpdate({ ...(realityUpdate() as object), frameStartResult: { repeatFrame: 'yes' } })
  assert.equal((await burst).frames.length, 1, 'a flag that is not the boolean is not a repeat')
})

test('8th Wall burst: a display at twice the camera\'s rate gives the frames of the camera, not twice as many', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const pending = sampleTap(provider, 0.5, 0.6)
  await settle()
  const module = [...engine.modules.values()][0]
  let calls = 0
  for (; engine.modules.has(module.name); calls++) {
    assert.ok(calls < 200, 'the window never closed')
    engine.hits = () => [{ type: 'FEATURE_POINT', position: { x: 0.1 + 0.002 * (calls % 3), y: -1.2, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2.003 }]
    module.onUpdate(calls % 2 === 0 ? freshUpdate() : repeatUpdate())
    clock.now += 1000 / 60
  }
  const tap = (await pending) as TapSample
  assert.equal(tap.ok, true)
  assert.equal(tap.n + tap.rejected, 15, 'fifteen camera frames in 450 ms at 30 a second')
  assert.equal(engine.hitCalls.length, 15)
  assert.ok(calls >= 29, `${calls} calls from the engine`)
})

test('8th Wall burst: a feed that only ever repeats gives no frame, and the burst closes empty after 300 ms', async (t: TestContext) => {
  clockAt(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 450)
  const [name] = [...engine.modules.keys()]
  for (let i = 0; i < 20; i++) engine.modules.get(name)!.onUpdate(repeatUpdate())
  t.mock.timers.tick(300)
  assert.deepEqual(await burst, { frames: [] })
  assert.deepEqual(engine.removed, [name])
})

test('8th Wall burst: a burst that sees no reality at all is refused by sampleTap, not read as a steady one', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const pending = sampleTap(provider, 0.5, 0.6)
  await settle()
  const module = [...engine.modules.values()][0]
  for (let i = 0; engine.modules.has(module.name); i++) {
    assert.ok(i < 100, 'the window never closed')
    module.onUpdate({ processCpuResult: {} })
    clock.now += 33
  }
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal((result as { reason: string }).reason, 'tracking')
})

test('8th Wall burst: the tap writes no log line per frame, where hitTest() writes its one', async (t: TestContext) => {
  const clock = clockAt(t)
  const log = t.mock.method(console, 'log', () => {})
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 450)
  const module = [...engine.modules.values()][0]
  for (let i = 0; engine.modules.has(module.name); i++) {
    assert.ok(i < 100, 'the window never closed')
    module.onUpdate(realityUpdate())
    clock.now += 33
  }
  assert.equal((await burst).frames.length, 15)
  assert.equal(log.mock.callCount(), 0, 'fifteen frames, and nothing in the log')

  provider.hitTest(0.5, 0.6)
  assert.equal(log.mock.callCount(), 1, 'the single hit test still says what the engine answered')
  assert.equal(log.mock.calls[0].arguments[0], '[8thwall-hitTest] input:')
})

test('8th Wall burst: every frame\'s hit is the same one hitTest() would have taken, range gate included', async (t: TestContext) => {
  const clock = clockAt(t)
  t.mock.method(console, 'log', () => {})
  const provider = readyEighthWall()
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 60)
  const module = [...engine.modules.values()][0]
  // A hit 30 m away is not a point worth trusting (MAX_POINT_DISTANCE_M), and a reported distance of 0 is measured.
  engine.hits = () => [{ type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -30 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 30 }]
  module.onUpdate(realityUpdate())
  clock.now += 30
  engine.hits = () => [{ type: 'FEATURE_POINT', position: { x: 0, y: 0, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 0 }]
  module.onUpdate(realityUpdate())
  clock.now += 40
  engine.hits = () => []
  module.onUpdate(realityUpdate())
  const frames = (await burst).frames
  assert.deepEqual(frames.map((f) => f.hit === null), [true, false, true])
  assert.equal(frames[1].hit?.distance, 2)
  assert.deepEqual(frames.map((f) => f.hit), [null, frames[1].hit, null])
  const single = provider.hitTest(0.5, 0.6)
  assert.equal(single, null)
})

test('8th Wall burst: the frames are told to a listener as they come', async (t: TestContext) => {
  const clock = clockAt(t)
  const provider = readyEighthWall()
  const heard: Array<[string, number]> = []
  const burst = provider.hitTestBurstAsync(0.5, 0.6, 60, (frame, elapsedMs) => heard.push([frame.status, elapsedMs]))
  const module = [...engine.modules.values()][0]
  module.onUpdate(realityUpdate('NORMAL'))
  clock.now += 30
  module.onUpdate(realityUpdate('LIMITED'))
  clock.now += 40
  module.onUpdate(realityUpdate('NORMAL'))
  await burst
  assert.deepEqual(heard, [['NORMAL', 0], ['LIMITED', 30], ['NORMAL', 70]])
})

test('8th Wall: a session asks for the hit types the page had when it first asked, whatever the address becomes after', async (t: TestContext) => {
  const win = (globalThis as { window: { location: { search: string } } }).window
  const saved = win.location.search
  t.mock.method(console, 'log', () => {})
  try {
    win.location.search = '?hittypes=DETECTED_SURFACE'
    const provider = readyEighthWall()
    provider.hitTest(0.5, 0.6)
    win.location.search = '?hittypes=ESTIMATED_SURFACE'
    provider.hitTest(0.5, 0.6)
    assert.deepEqual(engine.hitCalls.map((c) => c.types), [['DETECTED_SURFACE'], ['DETECTED_SURFACE']])
  } finally {
    win.location.search = saved
  }
})

test('hitTypesFromSearch: feature points, as ever, unless the page asks for others, in its order, by names from the three the documentation lists', () => {
  assert.deepEqual(hitTypesFromSearch(''), ['FEATURE_POINT'])
  assert.deepEqual(hitTypesFromSearch('?debug=remote'), ['FEATURE_POINT'])
  assert.deepEqual(hitTypesFromSearch('?hittypes=ESTIMATED_SURFACE,FEATURE_POINT'), ['ESTIMATED_SURFACE', 'FEATURE_POINT'])
  assert.deepEqual(hitTypesFromSearch('?hittypes=DETECTED_SURFACE'), ['DETECTED_SURFACE'])
  assert.deepEqual(hitTypesFromSearch('?hittypes=detected_surface, estimated_surface ,Feature_Point'), ['DETECTED_SURFACE', 'ESTIMATED_SURFACE', 'FEATURE_POINT'])
  assert.deepEqual(hitTypesFromSearch('?hittypes=FEATURE_POINT,FEATURE_POINT,ESTIMATED_SURFACE'), ['FEATURE_POINT', 'ESTIMATED_SURFACE'])
  assert.deepEqual(hitTypesFromSearch('?hittypes=PLANE,ESTIMATED_SURFACE,'), ['ESTIMATED_SURFACE'], 'names outside the three are dropped')
  assert.deepEqual(hitTypesFromSearch('?hittypes=PLANE'), ['FEATURE_POINT'], 'and a list with none left is the default')
  assert.deepEqual(hitTypesFromSearch('?hittypes='), ['FEATURE_POINT'])
})

test('8th Wall: the hit types the page asked for reach hitTest() and every frame of a burst, and default to feature points', async (t: TestContext) => {
  const win = (globalThis as { window: { location: { search: string } } }).window
  const saved = win.location.search
  t.mock.method(console, 'log', () => {})
  const clock = clockAt(t)
  try {
    win.location.search = '?hittypes=ESTIMATED_SURFACE,FEATURE_POINT'
    const provider = readyEighthWall()
    provider.hitTest(0.5, 0.6)
    const burst = provider.hitTestBurstAsync(0.5, 0.6, 30)
    const module = [...engine.modules.values()][0]
    module.onUpdate(realityUpdate())
    clock.now += 40
    module.onUpdate(realityUpdate())
    await burst
    assert.equal(engine.hitCalls.length, 3)
    for (const call of engine.hitCalls) assert.deepEqual(call.types, ['ESTIMATED_SURFACE', 'FEATURE_POINT'])

    win.location.search = ''
    const plain = readyEighthWall()
    plain.hitTest(0.5, 0.6)
    assert.deepEqual(engine.hitCalls[0].types, ['FEATURE_POINT'])
  } finally {
    win.location.search = saved
  }
})

// ═══ WebXRProvider.hitTestBurstAsync ════════════════════════════════════════

interface FakeSource {
  cancelled: number
  cancel(): void
}

interface FakeXrSession {
  sources: FakeSource[]
  requestCalls: Array<{ space: unknown; offsetRay: FakeXRRay }>
  listeners: Map<string, Set<() => void>>
  frameCallbacks: Array<(time: number, frame: unknown) => void>
  rafThrows: boolean
  /** Each call to requestHitTestSource returns what this returns. Default: a source now. */
  next: () => Promise<FakeSource> | undefined
  requestHitTestSource?: (options: { space: unknown; offsetRay: FakeXRRay }) => Promise<FakeSource> | undefined
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string, fn: () => void): void
  requestAnimationFrame(cb: (time: number, frame: unknown) => void): number
  emitEnd(): void
  pump(time: number, frame: unknown): void
  endListeners(): number
}

function fakeXrSession(): FakeXrSession {
  const s: FakeXrSession = {
    sources: [],
    requestCalls: [],
    listeners: new Map(),
    frameCallbacks: [],
    rafThrows: false,
    next: () => {
      const source: FakeSource = { cancelled: 0, cancel() { this.cancelled++ } }
      s.sources.push(source)
      return Promise.resolve(source)
    },
    requestHitTestSource(options) {
      s.requestCalls.push(options)
      return s.next()
    },
    addEventListener(type, fn) {
      if (!s.listeners.has(type)) s.listeners.set(type, new Set())
      s.listeners.get(type)!.add(fn)
    },
    removeEventListener(type, fn) {
      s.listeners.get(type)?.delete(fn)
    },
    requestAnimationFrame(cb) {
      if (s.rafThrows) throw new Error('InvalidStateError: the session has ended')
      s.frameCallbacks.push(cb)
      return s.frameCallbacks.length
    },
    emitEnd() {
      for (const fn of [...(s.listeners.get('end') ?? [])]) fn()
    },
    pump(time, frame) {
      for (const cb of s.frameCallbacks.splice(0)) cb(time, frame)
    },
    endListeners: () => s.listeners.get('end')?.size ?? 0,
  }
  return s
}

interface XrFrameOptions {
  camera?: { x: number; y: number; z: number } | null
  hit?: { x: number; y: number; z: number } | null
}

function xrFrame(o: XrFrameOptions = {}): unknown {
  const camera = o.camera === undefined ? { x: 0, y: 0, z: 0 } : o.camera
  const hit = o.hit === undefined ? { x: 0, y: -1.2, z: -2 } : o.hit
  const pose = (p: { x: number; y: number; z: number }) => ({ transform: { position: p, orientation: { x: 0, y: 0, z: 0, w: 1 } } })
  return {
    getViewerPose: () => (camera ? pose(camera) : undefined),
    getHitTestResults: () => (hit ? [{ getPose: () => pose(hit) }] : []),
  }
}

type WebXrInternals = { session: unknown; viewerSpace: unknown; refSpace: unknown; viewportRay(x: number, y: number): FakeXRRay }
const xr = (p: WebXRProvider): WebXrInternals => p as unknown as WebXrInternals

function liveWebXr(session = fakeXrSession()): { provider: WebXRProvider; session: FakeXrSession; viewer: object; ref: object } {
  const provider = new WebXRProvider()
  const viewer = { name: 'viewer' }
  const ref = { name: 'local-floor' }
  xr(provider).session = session
  xr(provider).viewerSpace = viewer
  xr(provider).refSpace = ref
  return { provider, session, viewer, ref }
}

test('WebXR burst: ONE hit-test source serves the whole window, and it is cancelled when the window closes', async () => {
  const { provider, session, viewer } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.3, 0.7, 450)
  await settle()

  assert.equal(session.requestCalls.length, 1, 'one source, not one per frame')
  assert.equal(session.requestCalls[0].space, viewer)
  assert.deepEqual(session.requestCalls[0].offsetRay.direction, xr(provider).viewportRay(0.3, 0.7).direction, 'aimed through the tapped pixel')
  assert.equal(session.endListeners(), 1)

  let frames = 0
  for (let time = 5000; session.frameCallbacks.length > 0; time += 50) {
    session.pump(time, xrFrame())
    frames++
    assert.ok(frames < 100, 'the window never closed')
  }
  const result = await burst

  assert.equal(frames, 10, 'frames at 0, 50 ... 450 ms from the first')
  assert.equal(result.frames.length, 10)
  assert.equal(session.requestCalls.length, 1, 'still one source')
  assert.equal(session.sources.length, 1)
  assert.equal(session.sources[0].cancelled, 1, 'cancelled once, at the end')
  assert.equal(session.endListeners(), 0, 'and the end listener is gone')
})

test('WebXR burst: each frame reports its hit, the camera pose it was read at, the distance from it, and UNKNOWN status', async () => {
  const { provider, session } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 0)
  await settle()
  session.pump(100, xrFrame({ camera: { x: 1, y: 1.5, z: 2 }, hit: { x: 1, y: -0.4, z: -1 } }))
  const [f] = (await burst).frames
  assert.deepEqual(f.hit?.position, { x: 1, y: -0.4, z: -1 })
  assert.deepEqual(f.hit?.rotation, { x: 0, y: 0, z: 0, w: 1 })
  assert.ok(Math.abs((f.hit?.distance ?? 0) - Math.hypot(0, 1.9, 3)) < 1e-12, 'measured from this frame\'s own viewer pose')
  assert.deepEqual(f.pose, { position: { x: 1, y: 1.5, z: 2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
  assert.equal(f.status, 'UNKNOWN')
  assert.equal(f.reason, undefined)
  assert.equal(f.poseJumps, undefined)
})

test('WebXR burst: a frame with no hit result has no hit, and one with no viewer pose has neither hit nor pose and is NOT_AVAILABLE', async () => {
  const { provider, session } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 100)
  await settle()
  session.pump(0, xrFrame({ hit: null }))
  session.pump(50, xrFrame({ camera: null }))
  session.pump(100, xrFrame())
  const frames = (await burst).frames
  assert.equal(frames[0].hit, null)
  assert.ok(frames[0].pose)
  assert.equal(frames[1].hit, null)
  assert.equal(frames[1].pose, undefined)
  assert.ok(frames[2].hit)
  assert.deepEqual(frames.map((f) => f.status), ['UNKNOWN', 'NOT_AVAILABLE', 'UNKNOWN'], 'the runtime had no pose for the middle frame: it could not locate the device')
})

/**
 * A frame whose poses are answered the way the real API answers them: relative to the space asked for. Asked in
 * any other space than the session's reference space, a viewer pose or a hit pose is the identity, which is not
 * where anything is. `hits` are in order, nearest first.
 */
function strictXrFrame(ref: object, camera: { x: number; y: number; z: number } | null, hits: Array<{ x: number; y: number; z: number }>): unknown {
  const pose = (p: { x: number; y: number; z: number }) => ({ transform: { position: p, orientation: { x: 0, y: 0, z: 0, w: 1 } } })
  const identity = pose({ x: 0, y: 0, z: 0 })
  return {
    getViewerPose: (space: unknown) => (space === ref ? (camera ? pose(camera) : undefined) : identity),
    getHitTestResults: () => hits.map((h) => ({ getPose: (space: unknown) => (space === ref ? pose(h) : identity) })),
  }
}

test('WebXR burst: the camera and the hit are read in the session\'s reference space, and the nearest hit result is the hit', async () => {
  const { provider, session, ref } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 0)
  await settle()
  session.pump(100, strictXrFrame(ref, { x: 1, y: 1.5, z: 2 }, [{ x: 1, y: -0.4, z: -1 }, { x: 5, y: -0.4, z: -9 }]))
  const [f] = (await burst).frames
  assert.deepEqual(f.pose?.position, { x: 1, y: 1.5, z: 2 })
  assert.deepEqual(f.hit?.position, { x: 1, y: -0.4, z: -1 }, 'the first result, not the last')
  assert.ok(Math.abs((f.hit?.distance ?? 0) - Math.hypot(0, 1.9, 3)) < 1e-12)
})

test('WebXR burst: the frames are told to a listener as they come', async () => {
  const { provider, session } = liveWebXr()
  const heard: Array<[string, number]> = []
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 100, (frame, elapsedMs) => heard.push([frame.status, elapsedMs]))
  await settle()
  session.pump(1000, xrFrame())
  session.pump(1050, xrFrame({ camera: null }))
  session.pump(1100, xrFrame())
  await burst
  assert.deepEqual(heard, [['UNKNOWN', 0], ['NOT_AVAILABLE', 50], ['UNKNOWN', 100]])
})

test('WebXR burst: the session ending mid-window settles the burst, cancels the source, and later frames do nothing', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { provider, session } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 450)
  await settle()
  session.pump(0, xrFrame())
  session.pump(40, xrFrame())
  const stale = session.frameCallbacks[0]
  session.emitEnd()
  assert.equal(await settledAtOnce(burst), true, 'the end event must close the burst, not the watchdog')
  const result = await burst
  assert.equal(result.frames.length, 2)
  assert.equal(session.sources[0].cancelled, 1)
  assert.equal(session.endListeners(), 0)
  stale(80, xrFrame())
  assert.equal(result.frames.length, 2, 'a frame after the end is ignored')
})

test('WebXR burst: a source that arrives after the burst was closed is cancelled on arrival', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const session = fakeXrSession()
  let deliver: (s: FakeSource) => void = () => {}
  session.next = () => new Promise<FakeSource>((resolve) => { deliver = resolve })
  const { provider } = liveWebXr(session)
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 450)
  await settle()
  session.emitEnd()
  assert.equal(await settledAtOnce(burst), true)
  assert.deepEqual(await burst, { frames: [] })
  const late: FakeSource = { cancelled: 0, cancel() { this.cancelled++ } }
  deliver(late)
  await settle()
  assert.equal(late.cancelled, 1, 'a source nobody is reading must not stay open')
  assert.equal(session.frameCallbacks.length, 0, 'and no frame is requested for it')
})

test('WebXR burst: if frames stop coming the watchdog settles it, cancels the source, and removes the listener', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { provider, session } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 450)
  await settle()
  session.pump(0, xrFrame())
  t.mock.timers.tick(1449)
  assert.equal(session.sources[0].cancelled, 0)
  t.mock.timers.tick(1)
  const result = await burst
  assert.equal(result.frames.length, 1)
  assert.equal(session.sources[0].cancelled, 1)
  assert.equal(session.endListeners(), 0)
})

test('WebXR burst: a source request that is rejected settles with no frames and leaves no listener behind', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const session = fakeXrSession()
  session.next = () => Promise.reject(new Error('hit-test not granted'))
  const { provider } = liveWebXr(session)
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 450)
  assert.equal(await settledAtOnce(burst), true, 'a refused source must close the burst, not the watchdog')
  assert.deepEqual(await burst, { frames: [] })
  assert.equal(session.endListeners(), 0)
})

test('WebXR burst: a request that returns nothing settles with no frames and never listens', async () => {
  const session = fakeXrSession()
  session.next = () => undefined
  const { provider } = liveWebXr(session)
  assert.deepEqual(await provider.hitTestBurstAsync(0.5, 0.5, 450), { frames: [] })
  assert.equal(session.endListeners(), 0)
})

test('WebXR burst: a session that cannot run hit tests, or is not running, answers at once and opens nothing', async () => {
  const noHitTest = fakeXrSession()
  noHitTest.requestHitTestSource = undefined
  const { provider } = liveWebXr(noHitTest)
  assert.deepEqual(await provider.hitTestBurstAsync(0.5, 0.5, 450), { frames: [] })
  assert.equal(noHitTest.endListeners(), 0)

  assert.deepEqual(await new WebXRProvider().hitTestBurstAsync(0.5, 0.5, 450), { frames: [] })
})

test('WebXR burst: a session that ended before the next frame could be requested settles and cancels', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { provider, session } = liveWebXr()
  const burst = provider.hitTestBurstAsync(0.5, 0.5, 450)
  await settle()
  session.pump(0, xrFrame())
  session.rafThrows = true
  session.pump(40, xrFrame())
  assert.equal(await settledAtOnce(burst), true, 'a frame request that throws must close the burst, not the watchdog')
  const result = await burst
  assert.equal(result.frames.length, 2)
  assert.equal(session.sources[0].cancelled, 1)
  assert.equal(session.endListeners(), 0)
})

test('WebXR burst: a ray that cannot be built opens nothing', async () => {
  const { provider, session } = liveWebXr()
  const saved = (globalThis as { XRRay?: unknown }).XRRay
  ;(globalThis as { XRRay?: unknown }).XRRay = class { constructor() { throw new Error('no XRRay') } }
  try {
    assert.deepEqual(await provider.hitTestBurstAsync(0.5, 0.5, 450), { frames: [] })
  } finally {
    ;(globalThis as { XRRay?: unknown }).XRRay = saved
  }
  assert.equal(session.requestCalls.length, 0)
  assert.equal(session.endListeners(), 0)
})

// ═══ A burst read by sampleTap ══════════════════════════════════════════════

test('end to end on 8th Wall: steady NORMAL frames become a tap, and one LIMITED frame refuses it', async (t: TestContext) => {
  for (const [label, limitedAt] of [['steady', -1], ['limited', 6]] as const) {
    const clock = clockAt(t)
    const provider = readyEighthWall()
    const pending = sampleTap(provider, 0.5, 0.6)
    await settle()
    const module = [...engine.modules.values()][0]
    for (let i = 0; engine.modules.has(module.name); i++) {
      assert.ok(i < 100, `${label}: the window never closed`)
      engine.hits = () => [{ type: 'FEATURE_POINT', position: { x: 0.1 + 0.002 * (i % 3), y: -1.2, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2.003 }]
      module.onUpdate(realityUpdate(i === limitedAt ? 'LIMITED' : 'NORMAL', i === limitedAt ? 'RELOCALIZING' : 'UNSPECIFIED'))
      clock.now += 33
    }
    const result = await pending
    if (limitedAt < 0) {
      assert.equal(result.ok, true, label)
      const tap = result as TapSample
      assert.equal(tap.source, 'burst')
      assert.equal(tap.n, 15)
      assert.ok(Math.abs(tap.position.x - 0.102) < 0.003)
    } else {
      assert.equal(result.ok, false, label)
      assert.equal((result as { reason: string }).reason, 'tracking')
    }
    t.mock.restoreAll()
  }
})

test('end to end on WebXR: a steady source becomes a tap with no tracking claim in either direction', async () => {
  const { provider, session } = liveWebXr()
  const pending = sampleTap(provider, 0.5, 0.5)
  await settle()
  for (let time = 0; session.frameCallbacks.length > 0; time += 40) {
    assert.ok(time < 4000, 'the window never closed')
    session.pump(time, xrFrame({ hit: { x: 0.2 + 0.001 * (time % 3), y: -1.2, z: -2 } }))
  }
  const tap = (await pending) as TapSample
  assert.equal(tap.ok, true)
  assert.equal(tap.source, 'burst')
  assert.equal(session.sources[0].cancelled, 1)
  assert.ok(tap.n >= 9)
})

/** Pumps a WebXR session's frames until the burst closes, calling `frameAt(i)` for the i-th frame. */
async function pumpWebXr(session: FakeXrSession, frameAt: (i: number) => unknown): Promise<void> {
  for (let i = 0; session.frameCallbacks.length > 0; i++) {
    assert.ok(i < 200, 'the window never closed')
    session.pump(i * 40, frameAt(i))
  }
}

test('end to end on WebXR: a burst that lost the device for a stretch and came back in a map that moved is refused', async () => {
  const { provider, session } = liveWebXr()
  const pending = sampleTap(provider, 0.5, 0.5)
  await settle()
  await pumpWebXr(session, (i) => {
    const lost = i >= 4 && i < 9
    const shifted = i >= 9
    return xrFrame({
      camera: lost ? null : { x: shifted ? 0.4 : 0.1, y: 1.5, z: 0 },
      hit: lost ? null : { x: shifted ? 0.5 : 0.2, y: -0.2, z: -2 },
    })
  })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal((result as { reason: string }).reason, 'tracking')
})

test('end to end on WebXR: a viewer pose that steps 0.5 m between two frames is refused although every frame had a pose', async () => {
  const { provider, session } = liveWebXr()
  const pending = sampleTap(provider, 0.5, 0.5)
  await settle()
  await pumpWebXr(session, (i) => xrFrame({ camera: { x: i < 5 ? 0 : 0.5, y: 1.5, z: 0 }, hit: { x: 0.2, y: -0.2, z: -2 } }))
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal((result as { reason: string }).reason, 'tracking')
})

test('end to end: a provider whose burst never delivers a frame is read with one hit, as before', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = readyEighthWall()
  const pending = sampleTap(provider, 0.5, 0.6, {
    singleHit: async () => ({ position: { x: 0, y: -1.2, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2 }),
  })
  await settle()
  t.mock.timers.tick(1450)
  const tap = (await pending) as TapSample
  assert.equal(tap.ok, true)
  assert.equal(tap.source, 'single-hit')
  assert.equal(engine.modules.size, 0, 'the module that never ticked is gone')
})
