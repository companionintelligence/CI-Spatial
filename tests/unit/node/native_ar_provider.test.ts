/**
 * The native AR provider (src/ar/native.ts) driven by a fake ScanAR plugin: the session
 * lifecycle, events into the ARProvider shapes, capture and hit tests, the verdicts, and the
 * fallback to the web runtime. No WebGL, no device, and no real timers.
 *
 * Run: npm run test:native-ar
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeARProvider, type NativeRenderer } from '../../../src/ar/native.ts'
import type { ARProvider, RawFrame } from '../../../src/ar/provider.ts'
import type { NativeFrame, NativeHitSample, ScanARPlugin } from '../../../src/ar/native-bridge.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
}

/** A column-major perspective projection for a vertical field of view and an aspect (width / height). */
function perspective(fovYDeg: number, aspect: number): number[] {
  const t = Math.tan((fovYDeg * Math.PI) / 360)
  return [1 / (aspect * t), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0]
}

const RECT = { x: 10, y: 20, width: 300, height: 400 }

interface FakePlugin extends ScanARPlugin {
  emit(event: string, payload: unknown): void
  listenerCount(event: string): number
  removed: number
  started: number
  stopped: number
  captures: number
  hitCalls: Array<{ x: number; y: number }>
  nextFrame: () => Promise<NativeFrame>
  nextHit: NativeHitSample
  startFails: string | null
}

function fakeJpegFrame(): NativeFrame {
  return {
    timestamp: 2,
    width: 4,
    height: 2,
    jpegBase64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
    transform: translation(0, 1.5, 0),
    projection: perspective(60, 2),
  }
}

function fakePlugin(): FakePlugin {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const plugin: FakePlugin = {
    removed: 0,
    started: 0,
    stopped: 0,
    captures: 0,
    hitCalls: [],
    startFails: null,
    nextHit: { hit: true, position: [0, 1, -2], rotation: [0, 0, 0, 1], distance: 2.24 },
    nextFrame: async () => fakeJpegFrame(),
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    listenerCount(event) {
      return listeners.get(event)?.length ?? 0
    },
    async capabilities() {
      return { platform: 'ios', engine: 'arkit', supported: true, depth: false }
    },
    async start() {
      if (plugin.startFails) throw new Error(plugin.startFails)
      plugin.started += 1
      return { rect: RECT, cameraAspect: 0.75 }
    },
    async stop() {
      plugin.stopped += 1
    },
    async captureFrame() {
      plugin.captures += 1
      return plugin.nextFrame()
    },
    async hitTest({ x, y }) {
      plugin.hitCalls.push({ x, y })
      return plugin.nextHit
    },
    addListener(event: string, listener: (e: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return Promise.resolve({
        remove: async () => {
          plugin.removed += 1
          const current = listeners.get(event) ?? []
          listeners.set(event, current.filter((l) => l !== listener))
        },
      })
    },
  } as unknown as FakePlugin
  return plugin
}

function fakeRenderer(): NativeRenderer & { disposed: number; sizes: number[][] } {
  const renderer = {
    disposed: 0,
    sizes: [] as number[][],
    setPixelRatio() {},
    setSize(width: number, height: number) {
      renderer.sizes.push([width, height])
    },
    render() {},
    dispose() {
      renderer.disposed += 1
    },
  }
  return renderer
}

function fakeCanvas(): HTMLCanvasElement {
  return { style: {} } as unknown as HTMLCanvasElement
}

function options(plugin: FakePlugin, extra: Record<string, unknown> = {}) {
  let time = 0
  return {
    plugin,
    createRenderer: () => fakeRenderer(),
    schedule: () => 1,
    cancel: () => undefined,
    now: () => {
      time += 1
      return time
    },
    decodeJpeg: async (_jpeg: Uint8Array, width: number, height: number) =>
      new Uint8ClampedArray(width * height * 4),
    ...extra,
  }
}

test('start subscribes first, starts the native session, and places the canvas over the camera rect', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  const canvas = fakeCanvas()
  await provider.start(canvas)
  assert.equal(provider.activeRuntime(), 'native')
  assert.equal(plugin.started, 1)
  assert.equal(plugin.listenerCount('pose'), 1)
  assert.equal(plugin.listenerCount('hits'), 1)
  assert.equal(canvas.style.left, '10px')
  assert.equal(canvas.style.top, '20px')
  assert.equal(canvas.style.width, '300px')
  assert.equal(canvas.style.height, '400px')
  assert.equal(provider.getCameraAspect(), 0.75)
  assert.equal(provider.nativeFailure(), null)
})

test('pose events feed the ARProvider getters: pose, tracking, field of view, and aspect', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'UNKNOWN')
  plugin.emit('pose', { timestamp: 1, transform: translation(1, 2, 3), projection: perspective(60, 0.75), tracking: 'normal' })
  assert.equal(provider.isTracking(), true)
  assert.deepEqual(provider.getPose().position, { x: 1, y: 2, z: 3 })
  assert.equal(provider.trackingStatus(), 'NORMAL')
  assert.ok(Math.abs(provider.getCameraFovY() - 60) < 1e-9)
  assert.ok(Math.abs(provider.getCameraAspect() - 0.75) < 1e-9)
})

test('a malformed pose event is dropped, not believed', async () => {
  const plugin = fakePlugin()
  const warnings: unknown[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const provider = new NativeARProvider(options(plugin))
    await provider.start(fakeCanvas())
    plugin.emit('pose', { timestamp: 1, transform: [1, 2, 3], projection: IDENTITY, tracking: 'normal' })
    assert.equal(provider.isTracking(), false)
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = warn
  }
})

test('a pose that moves further than the frame-shift threshold is counted as a jump', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  plugin.emit('pose', { timestamp: 1, transform: translation(0, 0, 0), projection: perspective(60, 0.75), tracking: 'normal' })
  plugin.emit('pose', { timestamp: 2, transform: translation(0, 0, 0.05), projection: perspective(60, 0.75), tracking: 'normal' })
  assert.equal(provider.getTrackingDiagnostics().poseJumps, 0)
  plugin.emit('pose', { timestamp: 3, transform: translation(0, 0, 1), projection: perspective(60, 0.75), tracking: 'normal' })
  const diagnostics = provider.getTrackingDiagnostics()
  assert.equal(diagnostics.poseJumps, 1)
  assert.ok(Math.abs(diagnostics.lastJumpM - 0.95) < 1e-9)
})

test('featurePoints returns each point once, kept only inside the distance band', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  plugin.emit('pose', { timestamp: 1, transform: IDENTITY, projection: perspective(60, 0.75), tracking: 'normal' })
  // (0,0,-2) is kept; (0,0,-0.01) is too close to the camera; (0,0,-20) is past the 12 m ceiling.
  plugin.emit('points', { timestamp: 1, points: [0, 0, -2, 0, 0, -0.01, 0, 0, -20, 1, 0, -3] })
  assert.deepEqual(provider.featurePoints(), [{ x: 0, y: 0, z: -2 }, { x: 1, y: 0, z: -3 }])
  assert.deepEqual(provider.featurePoints(), [])
})

test('the synchronous hitTest answers from the latest grid, looking one cell out for a hit', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  assert.equal(provider.hitTest(0.5, 0.5), null)
  // A 2×2 grid. Only the top-right cell (centre 0.75, 0.25) hits.
  const miss: NativeHitSample = { hit: false }
  plugin.emit('hits', {
    timestamp: 1,
    cols: 2,
    rows: 2,
    samples: [miss, { hit: true, position: [0, 1, -2], rotation: [0, 0, 0, 1], distance: 2.24 }, miss, miss],
  })
  const near = provider.hitTest(0.8, 0.2)
  assert.deepEqual(near?.position, { x: 0, y: 1, z: -2 })
  assert.equal(near?.distance, 2.24)
  // The nearest cell (top-left) misses, but its neighbour hits.
  assert.deepEqual(provider.hitTest(0.2, 0.2)?.position, { x: 0, y: 1, z: -2 })
})

test('hitTestAsync asks the native session for an exact hit', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  const hit = await provider.hitTestAsync(0.4, 0.6)
  assert.deepEqual(plugin.hitCalls, [{ x: 0.4, y: 0.6 }])
  assert.deepEqual(hit?.position, { x: 0, y: 1, z: -2 })
  plugin.nextHit = { hit: false }
  assert.equal(await provider.hitTestAsync(0.1, 0.1), null)
})

test('captureFrame returns the full frame as RGBA with the pose it was taken at', async () => {
  const plugin = fakePlugin()
  const seen: Array<{ bytes: number; width: number; height: number }> = []
  const provider = new NativeARProvider(options(plugin, {
    decodeJpeg: async (jpeg: Uint8Array, width: number, height: number) => {
      seen.push({ bytes: jpeg.length, width, height })
      return new Uint8ClampedArray(width * height * 4)
    },
  }))
  await provider.start(fakeCanvas())
  const frame: RawFrame = await provider.captureFrame(1000)
  assert.deepEqual(seen, [{ bytes: 3, width: 4, height: 2 }])
  assert.equal(frame.width, 4)
  assert.equal(frame.height, 2)
  assert.equal(frame.pixels.length, 4 * 2 * 4)
  assert.deepEqual(frame.pose.position, { x: 0, y: 1.5, z: 0 })
})

test('a second captureFrame while one is pending is refused, as the 8th Wall provider refuses it', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  const first = provider.captureFrame(1000)
  await assert.rejects(provider.captureFrame(1000), /Capture already pending/)
  await first
})

test('captureFrame times out when the native layer never answers', async () => {
  const plugin = fakePlugin()
  plugin.nextFrame = () => new Promise<NativeFrame>(() => undefined)
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  await assert.rejects(provider.captureFrame(5), /Timed out waiting for camera frame/)
})

test('a failed start without a fallback rejects, and removes every listener it added', async () => {
  const plugin = fakePlugin()
  plugin.startFails = 'camera permission denied'
  const provider = new NativeARProvider(options(plugin))
  await assert.rejects(provider.start(fakeCanvas()), /camera permission denied/)
  assert.equal(plugin.removed, 5)
  assert.equal(provider.activeRuntime(), 'idle')
  assert.equal(plugin.stopped, 0, 'a session that never started is not stopped')
})

test('with no plugin at all, start rejects and the fallback takes the same canvas', async () => {
  const canvas = fakeCanvas()
  const webStarts: HTMLCanvasElement[] = []
  const web = webProvider({ pose: 7 })
  web.start = async (c) => {
    webStarts.push(c)
  }
  const provider = new NativeARProvider({ plugin: null, fallback: async () => web, createRenderer: () => fakeRenderer(), schedule: () => 1, cancel: () => undefined })
  await provider.start(canvas)
  assert.deepEqual(webStarts, [canvas])
  assert.equal(provider.activeRuntime(), 'fallback')
  assert.match(provider.nativeFailure() ?? '', /ScanAR plugin is not available/)
})

/** A web runtime stand-in for the fallback. */
function webProvider(values: { pose: number }): ARProvider {
  return {
    start: async () => undefined,
    stop: () => undefined,
    captureFrame: async () => ({ pixels: new Uint8ClampedArray(4), width: 1, height: 1, pose: { position: { x: values.pose, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, timestamp: 0 }),
    hitTest: () => null,
    featurePoints: () => [{ x: 9, y: 9, z: 9 }],
    getPose: () => ({ position: { x: values.pose, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    isTracking: () => true,
    trackingStatus: () => 'LIMITED',
    getCameraFovY: () => 42,
    getCameraAspect: () => 0.5,
  }
}

test('when the native session fails to start, the web runtime takes over and answers every call', async () => {
  const plugin = fakePlugin()
  plugin.startFails = 'ARCore session could not be created'
  const web = webProvider({ pose: 4 })
  let fallbackBuilt = 0
  const provider = new NativeARProvider(options(plugin, {
    fallback: async () => {
      fallbackBuilt += 1
      return web
    },
  }))
  const canvas = fakeCanvas()
  await provider.start(canvas)
  assert.equal(fallbackBuilt, 1)
  assert.equal(provider.activeRuntime(), 'fallback')
  assert.equal(provider.nativeFailure(), 'ARCore session could not be created')
  assert.equal(plugin.removed, 5, 'the native listeners are removed before the fallback starts')
  assert.equal(provider.getPose().position.x, 4)
  assert.equal(provider.trackingStatus(), 'LIMITED')
  assert.equal(provider.getCameraFovY(), 42)
  assert.deepEqual(provider.featurePoints(), [{ x: 9, y: 9, z: 9 }])
  assert.equal(provider.hitTest(0.5, 0.5), null)
  assert.equal((await provider.captureFrame(100)).width, 1)
})

test('the preflight callback is told the verdict at start and again on the first pose', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  const verdicts: string[] = []
  provider.onPreflightVerdict((verdict) => verdicts.push(verdict.outcome))
  await provider.start(fakeCanvas())
  assert.equal(verdicts[0], 'warming-up')
  plugin.emit('pose', { timestamp: 1, transform: IDENTITY, projection: perspective(60, 0.75), tracking: 'normal' })
  assert.equal(verdicts.at(-1), 'ready')
})

test('stop ends the native session, removes the listeners, and disposes the renderer', async () => {
  const plugin = fakePlugin()
  const renderer = fakeRenderer()
  const provider = new NativeARProvider(options(plugin, { createRenderer: () => renderer }))
  await provider.start(fakeCanvas())
  provider.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(plugin.stopped, 1)
  assert.equal(plugin.removed, 5)
  assert.equal(renderer.disposed, 1)
  assert.equal(provider.activeRuntime(), 'idle')
})
