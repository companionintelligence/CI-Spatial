/**
 * The native AR provider (src/ar/native-provider.ts) over a fake ArSession plugin: what it asks the native side
 * to do, what the native pushes become, and what it answers when there is no native side. The native sources
 * are read as well, so the plugin's name, methods, events and registration cannot drift from what the web side uses.
 *
 * Run: npm run test:native-provider
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeARProvider, parsePosePush } from '../../../src/ar/native-provider.ts'
import { trackingIsUsable } from '../../../src/ar/tracking-quality.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** Replaces one global for the duration of a test. Returns the function that puts the original back. */
function stubGlobal(name: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  return () => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  }
}

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    release = () => done()
  })
  return { promise, resolve: () => release() }
}

interface FakeOptions {
  supported?: boolean
  supportedError?: Error
  startError?: Error
  /** The native start waits for this before it resolves, so a test can stop() while the start is in flight. */
  gateStart?: Promise<void>
  /** Each attachment waits for this after its listener is registered, so a test can stop() while it attaches. */
  gateListeners?: Promise<void>
  /** Attaching this event's listener fails. */
  failListener?: 'pose' | 'state'
  /** When true, removing a listener does nothing, so a stale listener keeps receiving pushes. */
  keepListeners?: boolean
}

/**
 * A fake ArSession plugin. It records each call in `calls`, delivers pushes with `emit`, and counts the
 * listeners still attached with `listenerCount`.
 */
function fakeArSession(options: FakeOptions = {}) {
  const calls: string[] = []
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const plugin = {
    async isSupported() {
      calls.push('isSupported')
      if (options.supportedError) throw options.supportedError
      return { supported: options.supported ?? true, availability: 'SUPPORTED_INSTALLED' }
    },
    async start() {
      calls.push('start')
      if (options.startError) throw options.startError
      if (options.gateStart) await options.gateStart
    },
    async stop() {
      calls.push('stop')
    },
    async addListener(event: 'pose' | 'state', listener: (data: unknown) => void) {
      calls.push(`listen:${event}`)
      if (options.failListener === event) throw new Error(`cannot attach ${event}`)
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      if (options.gateListeners) await options.gateListeners
      return {
        remove: async () => {
          calls.push(`unlisten:${event}`)
          if (!options.keepListeners) listeners.get(event)?.delete(listener)
        },
      }
    },
  }
  return {
    plugin,
    calls,
    emit(event: string, data: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(data)
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    },
  }
}

/** The shell's global: Capacitor.Plugins.ArSession is the fake. Returns the restore function. */
function nativeShell(fake: ReturnType<typeof fakeArSession>): () => void {
  return stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: { ArSession: fake.plugin } })
}

function canvas(width = 390, height = 844): HTMLCanvasElement {
  return { clientWidth: width, clientHeight: height } as unknown as HTMLCanvasElement
}

const IDENTITY = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
const NORMAL_POSE = {
  position: { x: 1, y: 1.5, z: -2 },
  rotation: { x: 0, y: 0.7071, z: 0, w: 0.7071 },
  trackingStatus: 'NORMAL',
}

/** Lets the background native calls and their promise callbacks run. */
const settle = () => new Promise((done) => setImmediate(done))

test('outside the native shell the provider is unsupported, refuses to start, and is not tracking', async () => {
  const provider = new NativeARProvider()
  assert.equal(await provider.isSupported(), false)
  await assert.rejects(provider.start(canvas()), /not in this build/)
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.deepEqual(provider.getPose(), IDENTITY)
})

test('isSupported reads the native flag, and a failed check reads as unsupported', async () => {
  const yes = fakeArSession({ supported: true })
  let restore = nativeShell(yes)
  try {
    assert.equal(await new NativeARProvider().isSupported(), true)
  } finally {
    restore()
  }

  const no = fakeArSession({ supported: false })
  restore = nativeShell(no)
  try {
    assert.equal(await new NativeARProvider().isSupported(), false)
  } finally {
    restore()
  }

  const broken = fakeArSession({ supportedError: new Error('availability check failed') })
  restore = nativeShell(broken)
  try {
    assert.equal(await new NativeARProvider().isSupported(), false)
  } finally {
    restore()
  }
})

test('start attaches the listeners before the native start, and nothing tracks until a pose arrives', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas(390, 844))

  assert.deepEqual(fake.calls, ['listen:pose', 'listen:state', 'start'])
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'INITIALIZING', 'running, but no pose yet')
  assert.equal(provider.getCameraAspect(), 390 / 844, 'aspect is the canvas at the time of start')
  assert.deepEqual(provider.getPose(), IDENTITY)

  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.isTracking(), true)
  assert.equal(provider.trackingStatus(), 'NORMAL')
  assert.equal(trackingIsUsable(provider.trackingStatus()), true)
  assert.deepEqual(provider.getPose(), { position: { x: 1, y: 1.5, z: -2 }, rotation: { x: 0, y: 0.7071, z: 0, w: 0.7071 } })
  provider.stop()
})

test('a start made while one is in flight gets that same start, and the native start runs once', async () => {
  const gate = deferred()
  const fake = fakeArSession({ gateStart: gate.promise })
  const provider = new NativeARProvider(() => fake.plugin)
  const first = provider.start(canvas())
  const second = provider.start(canvas())
  assert.equal(first, second)
  gate.resolve()
  await first
  assert.equal(fake.calls.filter((call) => call === 'start').length, 1)
  assert.equal(provider.trackingStatus(), 'INITIALIZING')
  provider.stop()
})

test('stop during the native start cancels it: the start rejects, nothing stays attached, and the native side is stopped again', async () => {
  const gate = deferred()
  const fake = fakeArSession({ gateStart: gate.promise })
  const provider = new NativeARProvider(() => fake.plugin)
  const starting = provider.start(canvas())
  await settle()
  provider.stop()
  gate.resolve()
  await assert.rejects(starting, /stopped before it started/)
  await settle()
  assert.equal(fake.listenerCount('pose'), 0)
  assert.equal(fake.listenerCount('state'), 0)
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.equal(fake.calls.filter((call) => call === 'stop').length, 2, 'once for stop(), and once for the native start that finished after it')
})

test('stop while a listener is attaching takes that listener back at once, and the native start never runs', async () => {
  const gate = deferred()
  const fake = fakeArSession({ gateListeners: gate.promise })
  const provider = new NativeARProvider(() => fake.plugin)
  const starting = provider.start(canvas())
  await settle()
  provider.stop()
  gate.resolve()
  await assert.rejects(starting, /stopped before it started/)
  await settle()
  assert.equal(fake.listenerCount('pose'), 0)
  assert.equal(fake.listenerCount('state'), 0)
  assert.ok(!fake.calls.includes('listen:state'), 'the second listener is never attached')
  assert.ok(!fake.calls.includes('start'), 'the native start is never called')
})

test('a listener that cannot be attached takes back the one already attached, and the start rejects', async () => {
  const fake = fakeArSession({ failListener: 'state' })
  const provider = new NativeARProvider(() => fake.plugin)
  await assert.rejects(provider.start(canvas()), /cannot attach state/)
  assert.equal(fake.listenerCount('pose'), 0)
  assert.ok(!fake.calls.includes('start'), 'the native start is never called')
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
})

test('after the native side ends the session, stop and then start begins it again', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('state', { running: false, reason: 'camera lost' })
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  provider.stop()
  await provider.start(canvas())
  assert.equal(fake.calls.filter((call) => call === 'start').length, 2)
  assert.equal(provider.trackingStatus(), 'INITIALIZING')
  provider.stop()
})

test('the tracking status follows the pose push, and only NORMAL counts as usable', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  for (const status of ['INITIALIZING', 'LIMITED', 'NORMAL', 'NOT_AVAILABLE']) {
    fake.emit('pose', { ...NORMAL_POSE, trackingStatus: status })
    assert.equal(provider.trackingStatus(), status)
    assert.equal(trackingIsUsable(status), status === 'NORMAL')
  }
  provider.stop()
})

test('a status this build does not know is not trusted: it reads as NOT_AVAILABLE', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, trackingStatus: 'SOME_FUTURE_STATUS' })
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.equal(trackingIsUsable(provider.trackingStatus()), false)
  provider.stop()
})

test('a malformed pose push is ignored, and the last good pose stays', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)
  const good = provider.getPose()

  const malformed: unknown[] = [
    undefined,
    'not an object',
    { ...NORMAL_POSE, position: { x: null, y: 0, z: 0 } },
    { ...NORMAL_POSE, position: { x: Number.NaN, y: 0, z: 0 } },
    { ...NORMAL_POSE, rotation: undefined },
    { ...NORMAL_POSE, rotation: { x: 0, y: 0, z: 0, w: 0 } },
  ]
  for (const push of malformed) fake.emit('pose', push)

  assert.deepEqual(provider.getPose(), good)
  assert.equal(provider.trackingStatus(), 'NORMAL')
  provider.stop()
})

test('parsePosePush keeps only finite, non-zero poses', () => {
  assert.equal(parsePosePush(null), null)
  assert.equal(parsePosePush({ ...NORMAL_POSE, position: { x: 0, y: 0 } }), null, 'z missing')
  assert.deepEqual(parsePosePush(NORMAL_POSE)?.status, 'NORMAL')
  assert.deepEqual(parsePosePush({ ...NORMAL_POSE, trackingStatus: undefined })?.status, 'NOT_AVAILABLE')
})

test('a state push that stops the session drops the pose, and a pose while stopped is not read', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.isTracking(), true)

  fake.emit('state', { running: false, reason: 'paused' })
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.deepEqual(provider.getPose(), IDENTITY)

  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.isTracking(), false, 'a pose while the session is stopped is not cached')

  fake.emit('state', { running: true })
  assert.equal(provider.isTracking(), false, 'resumed, but no pose yet')
  assert.equal(provider.trackingStatus(), 'INITIALIZING')

  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.isTracking(), true)
  provider.stop()
})

test('stop calls the native stop, clears the cache, and ignores pushes that arrive afterwards', async () => {
  const fake = fakeArSession({ keepListeners: true })
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)

  provider.stop()
  await settle()
  assert.ok(fake.calls.includes('stop'))
  assert.ok(fake.calls.includes('unlisten:pose'))
  assert.ok(fake.calls.includes('unlisten:state'))
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  assert.deepEqual(provider.getPose(), IDENTITY)

  fake.emit('pose', NORMAL_POSE)
  fake.emit('state', { running: true })
  assert.equal(provider.isTracking(), false, 'a stale listener is not read once the provider has stopped')
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
})

test('a refused native start rejects, takes the listeners back, and a later start can succeed', async () => {
  const refusing = fakeArSession({ startError: new Error('camera permission refused') })
  const provider = new NativeARProvider(() => refusing.plugin)
  await assert.rejects(provider.start(canvas()), /camera permission refused/)
  assert.equal(refusing.listenerCount('pose'), 0)
  assert.equal(refusing.listenerCount('state'), 0)
  assert.equal(provider.isTracking(), false)
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')

  const accepting = fakeArSession()
  const retry = new NativeARProvider(() => accepting.plugin)
  await retry.start(canvas())
  assert.equal(retry.trackingStatus(), 'INITIALIZING')
  retry.stop()
})

test('frames, hit tests and feature points are not in this milestone; the field of view is unknown', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  await assert.rejects(provider.captureFrame(), /not in this build/)
  assert.equal(provider.hitTest(0.5, 0.5), null)
  assert.deepEqual(provider.featurePoints(), [])
  assert.ok(Number.isNaN(provider.getCameraFovY()), 'NaN marks an unmeasured field of view, not a guessed one')
  provider.stop()
})

test('a canvas with no size gives an unknown aspect rather than a guessed one', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas(0, 0))
  assert.ok(Number.isNaN(provider.getCameraAspect()))
  provider.stop()
})

test('getPose returns a copy, so a caller cannot change the cached pose', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)
  const pose = provider.getPose()
  pose.position.x = 99
  pose.rotation.w = 0
  assert.equal(provider.getPose().position.x, 1)
  assert.equal(provider.getPose().rotation.w, 0.7071)
  provider.stop()
})

test('the native sources declare the plugin, methods and events that the web side uses', () => {
  const swift = read('mobile/ios/App/App/ArSessionPlugin.swift')
  const java = read('mobile/android/app/src/main/java/com/companionintelligence/scan/ArSessionPlugin.java')
  assert.match(swift, /jsName = "ArSession"/)
  assert.match(java, /@CapacitorPlugin\(\s*name = "ArSession"/)
  for (const method of ['isSupported', 'start', 'stop']) {
    assert.match(swift, new RegExp(`CAPPluginMethod\\(name: "${method}"`), `iOS declares ${method}`)
    assert.match(swift, new RegExp(`@objc public func ${method}\\(_ call: CAPPluginCall\\)`), `iOS implements ${method}`)
    assert.match(java, new RegExp(`@PluginMethod\\s+public void ${method}\\(PluginCall call\\)`), `Android implements ${method}`)
  }
  // Poses come from iOS only: the Android side runs no frame loop in this milestone (see ArSessionPlugin.java).
  assert.match(swift, /notifyListeners\("pose"/, 'iOS pushes pose')
  assert.match(swift, /notifyListeners\("state"/, 'iOS pushes state')
  assert.match(java, /notifyListeners\("state"/, 'Android pushes state')
})

test('both native plugins are registered on their bridge and compiled into the app', () => {
  const bridgeController = read('mobile/ios/App/App/ScanBridgeViewController.swift')
  const storyboard = read('mobile/ios/App/App/Base.lproj/Main.storyboard')
  const pbxproj = read('mobile/ios/App/App.xcodeproj/project.pbxproj')
  assert.match(bridgeController, /bridge\?\.registerPluginInstance\(ArSessionPlugin\(\)\)/)
  assert.match(storyboard, /customClass="ScanBridgeViewController" customModule="App"/)
  assert.match(pbxproj, /ArSessionPlugin\.swift in Sources \*\//)
  assert.match(pbxproj, /ScanBridgeViewController\.swift in Sources \*\//)

  const activity = read('mobile/android/app/src/main/java/com/companionintelligence/scan/MainActivity.java')
  const registerAt = activity.indexOf('registerPlugin(ArSessionPlugin.class)')
  assert.ok(registerAt > 0, 'MainActivity registers the plugin')
  assert.ok(registerAt < activity.indexOf('super.onCreate(savedInstanceState)'), 'registered before the bridge is created')
})

test('the Android build takes ARCore from its pinned version, and the manifest keeps AR optional', () => {
  const variables = read('mobile/android/variables.gradle')
  const app = read('mobile/android/app/build.gradle')
  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml')
  assert.match(variables, /arcoreVersion = '\d+\.\d+\.\d+'/)
  assert.match(app, /implementation "com\.google\.ar:core:\$arcoreVersion"/)
  // Optional, so the app installs on a device without ARCore. ArCoreApk.requestInstall installs it when the session starts.
  assert.match(manifest, /<meta-data\s+android:name="com\.google\.ar\.core"\s+android:value="optional"\s*\/>/)
  assert.match(manifest, /<uses-feature\s+android:name="android\.hardware\.camera\.ar"\s+android:required="false"\s*\/>/)
})
