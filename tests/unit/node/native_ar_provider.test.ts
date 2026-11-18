/**
 * The native AR provider (src/ar/native.ts) driven by a fake ScanAR plugin: the session
 * lifecycle, events into the ARProvider shapes, capture and hit tests, the verdicts, and the
 * fallback to the web runtime. No WebGL, no device, and no real timers.
 *
 * Run: npm run test:native-ar
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeARProvider, worldMapNameFor } from '../../../src/ar/native.ts'
import type { ARProvider, RawFrame } from '../../../src/ar/provider.ts'
import type { NativeFrame, NativeHitSample } from '../../../src/ar/native-bridge.ts'
import { startFailureVerdict } from '../../../src/ar/preflight.ts'
import { imagePointToViewportPoint, resolveDetections } from '../../../src/spatial/resolver.ts'
import type { RawDetection } from '../../../src/inference/prompt.ts'
import * as THREE from 'three'
import {
  FRAME_S,
  IDENTITY,
  fakeCanvas,
  fakePlugin,
  fakeRenderer,
  perspective,
  providerOptions as options,
  translation,
} from './support/fake-scan-ar.ts'

// The provider logs its tracking status when it changes (a device run reads that); not output of these tests.
console.log = () => undefined

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

test('a pose that steps further than a hand can between two frames is counted as a jump', async () => {
  // Frames 33 ms apart, the rate both plugins send poses at. The camera moved 5 cm a frame, so a smooth continuation puts the
  // third pose 10 cm from the first, and it is at 1 m: 0.90 m that nothing explains, which is what `lastJumpM` reports (the
  // unexplained part of the step, src/ar/frame-epoch.ts, and not the 0.95 m step itself).
  // This test used to emit its poses a second apart and expect the 0.95 m step: the flat 0.30 m per-event rule, which the
  // epoch tracker retired because it read a held-back bridge as the map moving. A step of 0.95 m in one second is a walk, and
  // wp-09b-native-provider.test.ts holds that case.
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  const at = (n: number) => 1 + n * FRAME_S
  plugin.emit('pose', { timestamp: at(0), transform: translation(0, 0, 0), projection: perspective(60, 0.75), tracking: 'normal' })
  plugin.emit('pose', { timestamp: at(1), transform: translation(0, 0, 0.05), projection: perspective(60, 0.75), tracking: 'normal' })
  assert.equal(provider.getTrackingDiagnostics().poseJumps, 0)
  plugin.emit('pose', { timestamp: at(2), transform: translation(0, 0, 1), projection: perspective(60, 0.75), tracking: 'normal' })
  const diagnostics = provider.getTrackingDiagnostics()
  assert.equal(diagnostics.poseJumps, 1)
  assert.ok(Math.abs(diagnostics.lastJumpM - 0.9) < 1e-9, `lastJumpM ${diagnostics.lastJumpM}`)
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

test('start sends the saved world map name and reports whether the map was found', async () => {
  const plugin = fakePlugin()
  plugin.worldMapResult = 'loaded'
  const provider = new NativeARProvider(options(plugin, { worldMap: 'room-7' }))
  await provider.start(fakeCanvas())
  assert.deepEqual(plugin.startOptions, [{ depth: false, hitGrid: 20, worldMap: 'room-7' }])
  assert.equal(provider.worldMapState(), 'loaded')
  provider.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(provider.worldMapState(), null, 'the state is forgotten once the session stops')
})

test('a saved world map that is not on the phone starts a fresh session, and the state says so', async () => {
  const plugin = fakePlugin()
  plugin.worldMapResult = 'missing'
  const provider = new NativeARProvider(options(plugin, { worldMap: 'room-9' }))
  await provider.start(fakeCanvas())
  assert.equal(provider.activeRuntime(), 'native', 'a missing map is not a failed start, so the web runtime stays out')
  assert.equal(provider.worldMapState(), 'missing')
})

test('without a world map name, start asks for none and reports none', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  assert.deepEqual(plugin.startOptions, [{ depth: false, hitGrid: 20 }])
  assert.equal(provider.worldMapState(), null)
})

test('saveWorldMap saves through the native session, and refuses when it is not running', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await assert.rejects(provider.saveWorldMap('room-7'), /not running/)
  await provider.start(fakeCanvas())
  assert.deepEqual(await provider.saveWorldMap('room-7'), { name: 'room-7', bytes: 123 })
  assert.deepEqual(plugin.saves, ['room-7'])
})

test('saveWorldMap is refused on a platform without world maps', async () => {
  const plugin = fakePlugin()
  delete plugin.saveWorldMap
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  await assert.rejects(provider.saveWorldMap('room-7'), /not available on this platform/)
})

test('an ARKit interruption reads as not available, and the next pose restores the tracking state', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  plugin.emit('pose', { timestamp: 1, transform: IDENTITY, projection: perspective(60, 0.75), tracking: 'normal' })
  assert.equal(provider.trackingStatus(), 'NORMAL')
  plugin.emit('tracking', { state: 'notAvailable' })
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  plugin.emit('pose', { timestamp: 2, transform: IDENTITY, projection: perspective(60, 0.75), tracking: 'limited.relocalizing' })
  assert.equal(provider.trackingStatus(), 'LIMITED')
})

test('a platform without world maps gets no map, and the state says unsupported', async () => {
  const plugin = fakePlugin()
  plugin.capabilities = async () => ({ platform: 'android', engine: 'arcore', supported: true, depth: false, worldMap: false })
  const provider = new NativeARProvider(options(plugin, { worldMap: 'room-7' }))
  await provider.start(fakeCanvas())
  assert.deepEqual(plugin.startOptions, [{ depth: false, hitGrid: 20 }], 'the native side is not asked for a map it cannot keep')
  assert.equal(provider.worldMapState(), 'unsupported')
  await assert.rejects(provider.saveWorldMap('room-7'), /not available on this platform/)
})

test('a saved map that will not decode is reported as unreadable, and the session still runs', async () => {
  const plugin = fakePlugin()
  plugin.worldMapResult = 'unreadable'
  const provider = new NativeARProvider(options(plugin, { worldMap: 'room-9' }))
  await provider.start(fakeCanvas())
  assert.equal(provider.activeRuntime(), 'native')
  assert.equal(provider.worldMapState(), 'unreadable')
})

test('worldMapNameFor sends only names the native side can use as a file name', () => {
  assert.equal(worldMapNameFor('room-7'), 'room-7')
  assert.equal(worldMapNameFor('Room_7'), 'Room_7')
  assert.equal(worldMapNameFor('default'), undefined, 'the default world is shared, so it never gets a map')
  assert.equal(worldMapNameFor(null), undefined)
  assert.equal(worldMapNameFor(''), undefined)
  assert.equal(worldMapNameFor('../etc'), undefined)
  assert.equal(worldMapNameFor('room 7'), undefined)
  assert.equal(worldMapNameFor('x'.repeat(64))?.length, 64)
  assert.equal(worldMapNameFor('x'.repeat(65)), undefined)
})

test('a Place in the page address names its map', async () => {
  const scope = globalThis as { location?: unknown }
  const before = scope.location
  scope.location = { search: '?world=room-7' }
  try {
    const plugin = fakePlugin()
    plugin.worldMapResult = 'loaded'
    const provider = new NativeARProvider(options(plugin))
    await provider.start(fakeCanvas())
    assert.deepEqual(plugin.startOptions, [{ depth: false, hitGrid: 20, worldMap: 'room-7' }])
  } finally {
    scope.location = before
  }
})

test('a hit keeps the surface rotation the native layer reports', async () => {
  const plugin = fakePlugin()
  plugin.nextHit = { hit: true, position: [1, 2, 3], rotation: [0, 0.7071068, 0, 0.7071068], distance: 2 }
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  const hit = await provider.hitTestAsync(0.5, 0.5)
  assert.deepEqual(hit?.rotation, { x: 0, y: 0.7071068, z: 0, w: 0.7071068 })
})

// ── When the web runtime cannot start either ─────────────────────────────────────────────────────────

/** A native start that fails with `nativeMessage`, a fallback that fails with `fallbackError`: what the page's catch ladder is handed. */
async function startFailureOf(nativeMessage: string, fallbackError: Error): Promise<{ thrown: Error; provider: NativeARProvider }> {
  const plugin = fakePlugin()
  plugin.startFails = nativeMessage
  const provider = new NativeARProvider(options(plugin, { fallback: async () => { throw fallbackError } }))
  const warn = console.warn
  console.warn = () => undefined
  try {
    const thrown = await provider.start(fakeCanvas()).then(() => null, (e: unknown) => e as Error)
    assert.ok(thrown, 'the start rejects: nothing runs')
    return { thrown, provider }
  } finally {
    console.warn = warn
  }
}

test('when the web runtime cannot start either, a refused camera is what the person is told, whichever runtime refused it', async () => {
  // The Android plugin's own message for a refused permission (ScanARPlugin.java, cameraPermissionCallback) and the one the
  // WebXR provider rejects with in a WebView, which has nothing to do with the camera.
  const nativeRefused = 'Camera permission was not granted, so AR cannot start.'
  const webUnsupported = new Error('WebXR not supported on this device')
  const verdictOf = (e: unknown) => startFailureVerdict(e).headline
  assert.notEqual(verdictOf(new Error(nativeRefused)), verdictOf(webUnsupported), 'the two failures read differently, so which one is reported matters')

  const native = await startFailureOf(nativeRefused, webUnsupported)
  assert.equal(verdictOf(native.thrown), verdictOf(new Error(nativeRefused)), 'native refused the camera, the web runtime merely has no WebXR here')
  assert.equal(native.thrown.message, nativeRefused)
  assert.equal(native.thrown.cause, webUnsupported, 'the web runtime\'s failure is kept, as the cause')
  assert.equal(native.provider.nativeFailure(), nativeRefused)

  // The other order: native fails for a reason the person cannot fix, and the web runtime is refused the camera. The refusal is
  // the one thing they can do something about, so it is the one reported.
  const nativeBroken = 'ARCore could not create a session: the session could not be created'
  const webRefused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  assert.notEqual(verdictOf(new Error(nativeBroken)), verdictOf(webRefused))
  const web = await startFailureOf(nativeBroken, webRefused)
  assert.equal(verdictOf(web.thrown), verdictOf(webRefused))
  assert.equal(web.thrown.name, 'NotAllowedError', 'the name carries, because that is what the verdict reads for a refusal that has no word for it in its message')
  assert.equal(web.thrown.cause instanceof Error && web.thrown.cause.message, nativeBroken, 'and the native failure is the cause')
  assert.equal(web.provider.nativeFailure(), nativeBroken)
})

test('when neither runtime failed on the camera, the native runtime\'s failure is the one reported: it is the runtime this shell is built for', async () => {
  const { thrown } = await startFailureOf('ARCore could not create a session: the session could not be created', new Error('WebXR not supported on this device'))
  assert.match(thrown.message, /ARCore could not create a session/)
})

// ── The web runtime that took over is nameable ───────────────────────────────────────────────────────

test('webRuntime() is null while the native session runs and the runtime itself once it has taken over', async () => {
  const plugin = fakePlugin()
  const web = webProvider({ pose: 1 })
  const provider = new NativeARProvider(options(plugin, { fallback: async () => web }))
  assert.equal(provider.webRuntime(), null)
  await provider.start(fakeCanvas())
  assert.equal(provider.webRuntime(), null, 'native runs')
  const failing = fakePlugin()
  failing.startFails = 'no'
  const handedOver = new NativeARProvider(options(failing, { fallback: async () => web }))
  await handedOver.start(fakeCanvas())
  assert.equal(handedOver.webRuntime(), web)
})

// ── Where an image point is hit-tested ───────────────────────────────────────────────────────────────

const DETECTION: RawDetection = { label: 'chair', bbox: [0.1, 0.2, 0.3, 0.4], confidence: 0.9, description: 'a chair' }
/** The frame the native layer captures (the whole camera image, portrait) and the window of a phone around its overlay rect. */
const FRAME = { width: 3024, height: 4032 }
const WINDOW = { width: 390, height: 844 }

test('the native layer fits the whole camera image, so an image point is the same point of its overlay rect, whatever window surrounds it', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  // The contract: image (0.2, 0.3) is the overlay rect's (0.2, 0.3), because the rect IS the image (native-bridge.ts, NativeStartResult.rect).
  assert.deepEqual(provider.imagePointToHitTestPoint(0.2, 0.3, FRAME, WINDOW), { x: 0.2, y: 0.3 })
  assert.deepEqual(provider.imagePointToHitTestPoint(0.9, 0.7, FRAME, WINDOW), { x: 0.9, y: 0.7 }, 'an edge the window cover-crop would push past 1')
  // And what the cover-crop it used to be given does to it, worked by hand: the image is 3024 x 4032 and the window 390 x 844, so
  // scale = max(390 / 3024, 844 / 4032) = 0.2093, the image is shown 633 px wide and 121.5 px of each side is cropped.
  // x = (0.2 * 633.0 - 121.5) / 390 = 0.013.
  const cropped = imagePointToViewportPoint(0.2, 0.3, FRAME, WINDOW)
  assert.ok(Math.abs(cropped.x - 0.0131) < 1e-3, 'the window mapping moves a point at a fifth of the width to 1.3% of it')
})

test('a detection is hit-tested, by every tier of the resolver, at the point of the native overlay rect it is at in the image', async () => {
  const plugin = fakePlugin()
  plugin.nextHit = { hit: false }
  const provider = new NativeARProvider(options(plugin))
  await provider.start(fakeCanvas())
  const camera = new THREE.PerspectiveCamera(60, 0.75, 0.01, 1000)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  const results = await resolveDetections([DETECTION], 1000, {
    provider,
    asyncHitTest: (x, y) => provider.hitTestAsync(x, y),
    imageSize: FRAME,
    viewportSize: WINDOW,
    captureCamera: camera,
  })
  // The bbox centre is (0.2, 0.3). The exact hit test is asked there, and nowhere else.
  assert.equal(plugin.hitCalls.length, 1)
  assert.ok(Math.abs(plugin.hitCalls[0]!.x - 0.2) < 1e-9 && Math.abs(plugin.hitCalls[0]!.y - 0.3) < 1e-9, JSON.stringify(plugin.hitCalls[0]))
  // Nothing was hit, so the bbox ray runs: the capture camera is built for the whole image (main.ts builds it from
  // getCameraAspect(), the overlay rect's aspect), so the ray goes through NDC (2 * 0.2 - 1, -(2 * 0.3 - 1)) = (-0.6, 0.4), 2 m out.
  const t = Math.tan(THREE.MathUtils.degToRad(60) / 2)
  const dirX = -0.6 * 0.75 * t
  const dirY = 0.4 * t
  const norm = Math.hypot(dirX, dirY, 1)
  assert.equal(results.length, 1)
  assert.ok(Math.abs(results[0]!.worldPos.x - (2 * dirX) / norm) < 1e-6, `x was ${results[0]!.worldPos.x}`)
  assert.ok(Math.abs(results[0]!.worldPos.y - (2 * dirY) / norm) < 1e-6, `y was ${results[0]!.worldPos.y}`)
})

test('after a hand-over the web runtime\'s own mapping is the wrapper\'s; one with none gets the window cover-crop, as the resolver gives any provider', async () => {
  const failing = () => {
    const plugin = fakePlugin()
    plugin.startFails = 'no native session'
    return plugin
  }
  const covering = webProvider({ pose: 1 }) as ARProvider & { imagePointToHitTestPoint?: unknown }
  covering.imagePointToHitTestPoint = (x: number, y: number) => ({ x: x / 2, y: y / 2 })
  const withContract = new NativeARProvider(options(failing(), { fallback: async () => covering }))
  await withContract.start(fakeCanvas())
  assert.deepEqual(withContract.imagePointToHitTestPoint(0.2, 0.3, FRAME, WINDOW), { x: 0.1, y: 0.15 }, 'its mapping, not the native identity')

  const bare = new NativeARProvider(options(failing(), { fallback: async () => webProvider({ pose: 1 }) }))
  await bare.start(fakeCanvas())
  const mapped = bare.imagePointToHitTestPoint(0.2, 0.3, FRAME, WINDOW)
  assert.ok(Math.abs(mapped.x - 0.0131) < 1e-3 && Math.abs(mapped.y - 0.3) < 1e-9, `no contract, so the window cover-crop: ${JSON.stringify(mapped)}`)
})
