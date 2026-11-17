/**
 * The native AR provider (src/ar/native-provider.ts) over a fake ArSession plugin: what it asks the native side
 * to do, what the native pushes become, and what it answers when there is no native side. The native sources
 * are read as well, so the plugin's name, methods, events and registration cannot drift from what the web side uses.
 *
 * Run: npm run test:native-provider
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeARProvider, parsePosePush, type NativeSessionEvent } from '../../../src/ar/native-provider.ts'
import { ScanFrameEpochLog, describeTracking, type FrameDiscontinuity } from '../../../src/ar/frame-epoch.ts'
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

/** Every session event the provider announces, without the clock: the time is when the test ran, not what it asserts. */
function recordSessionEvents(provider: NativeARProvider): Array<Omit<NativeSessionEvent, 'atMs'>> {
  const events: Array<Omit<NativeSessionEvent, 'atMs'>> = []
  provider.onSessionEvent((event) => {
    const { atMs, ...rest } = event
    assert.ok(Number.isFinite(atMs), 'every event says when it happened')
    events.push(rest)
  })
  return events
}

test('parsePosePush reads the tracking reason and the epoch, and trusts neither when it does not know them', () => {
  assert.equal(parsePosePush(NORMAL_POSE)?.reason, 'UNKNOWN', 'a native that sends no reason is not one that says there is none')
  assert.equal(parsePosePush(NORMAL_POSE)?.epoch, null)
  for (const reason of ['NONE', 'INITIALIZING', 'RELOCALIZING', 'EXCESSIVE_MOTION', 'INSUFFICIENT_FEATURES', 'INSUFFICIENT_LIGHT', 'CAMERA_UNAVAILABLE', 'BAD_STATE']) {
    assert.equal(parsePosePush({ ...NORMAL_POSE, trackingReason: reason })?.reason, reason)
  }
  for (const reason of ['SOME_FUTURE_REASON', 'relocalizing', '', 7, null]) {
    assert.equal(parsePosePush({ ...NORMAL_POSE, trackingReason: reason })?.reason, 'UNKNOWN', `not trusted: ${String(reason)}`)
  }
  assert.equal(parsePosePush({ ...NORMAL_POSE, epoch: 0 })?.epoch, 0)
  assert.equal(parsePosePush({ ...NORMAL_POSE, epoch: 12 })?.epoch, 12)
  for (const epoch of [-1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    assert.equal(parsePosePush({ ...NORMAL_POSE, epoch })?.epoch, null, `not an epoch: ${String(epoch)}`)
  }
})

test('the tracking reason follows the latest pose push, and is unknown again when the session stops or is interrupted', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  assert.equal(provider.getTrackingReason(), 'UNKNOWN')
  await provider.start(canvas())
  assert.equal(provider.getTrackingReason(), 'UNKNOWN', 'running, but no pose yet')

  fake.emit('pose', { ...NORMAL_POSE, trackingStatus: 'LIMITED', trackingReason: 'RELOCALIZING' })
  assert.equal(provider.getTrackingReason(), 'RELOCALIZING')
  assert.equal(trackingIsUsable(provider.trackingStatus()), false)
  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'NONE' })
  assert.equal(provider.getTrackingReason(), 'NONE')
  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.getTrackingReason(), 'UNKNOWN', 'a push with no reason does not keep the last one')

  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'EXCESSIVE_MOTION', trackingStatus: 'LIMITED' })
  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.equal(provider.getTrackingReason(), 'UNKNOWN')
  provider.stop()
})

test('an interruption is announced once, tracking stops at once, and the epoch has not moved yet', async () => {
  for (const push of [
    { running: false, reason: 'interrupted' },
    { running: false, reason: 'paused' },
    { running: false, interrupted: true },
    { running: false, interrupted: true, reason: 'a reason this build has never seen' },
  ]) {
    const fake = fakeArSession()
    const provider = new NativeARProvider(() => fake.plugin)
    const events = recordSessionEvents(provider)
    await provider.start(canvas())
    fake.emit('pose', NORMAL_POSE)
    assert.equal(provider.getFrameEpoch(), 0)

    fake.emit('state', push)
    assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }], JSON.stringify(push))
    assert.equal(provider.isTracking(), false)
    assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
    assert.deepEqual(provider.getPose(), IDENTITY)
    assert.equal(provider.getFrameEpoch(), 0, 'whether the frame changed is only known when tracking returns')

    fake.emit('state', push)
    assert.equal(events.length, 1, 'a second interruption push is not a second interruption')
    provider.stop()
  }
})

test('a state push that ends the session for any other reason is not an interruption, and what follows it is not a resume', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)

  fake.emit('state', { running: false, reason: 'The camera is not available for AR: busy' })
  assert.equal(provider.trackingStatus(), 'NOT_AVAILABLE')
  fake.emit('state', { running: false, reason: 'paused', interrupted: false })
  fake.emit('state', { running: true })
  fake.emit('pose', NORMAL_POSE)
  assert.deepEqual(events, [], 'nothing was interrupted, so nothing resumed')
  assert.equal(provider.getFrameEpoch(), 0)
  provider.stop()
})

test('a resume with no epoch from the native side is a new epoch as soon as the OS hands the session back, and nothing reads as usable until a pose', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)
  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.equal(provider.getFrameEpoch(), 0)

  let seenByListener = ''
  provider.onSessionEvent((event) => {
    if (event.type === 'resumed') seenByListener = `${provider.trackingStatus()} epoch ${provider.getFrameEpoch()} tracking ${provider.isTracking()}`
  })
  fake.emit('state', { running: true })
  assert.equal(provider.getFrameEpoch(), 1, 'a native side that cannot promise its frame survived is assumed to have lost it')
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }, { type: 'resumed', epoch: 1, frameChanged: true }])
  assert.equal(seenByListener, 'INITIALIZING epoch 1 tracking false', 'announced before any pose, and not yet usable')
  assert.equal(trackingIsUsable(provider.trackingStatus()), false, 'running again is not tracking again')
  assert.equal(provider.isTracking(), false)

  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.trackingStatus(), 'NORMAL')
  assert.equal(provider.isTracking(), true)
  assert.equal(provider.getFrameEpoch(), 1, 'one resume is one new epoch, and the pose after it adds nothing')
  assert.equal(events.length, 2)
  provider.stop()
})

test('the Android plugin as it is today (state pushes, never a pose): every interruption and every resume is announced, each a new epoch', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('state', { running: true })
  assert.deepEqual(events, [], 'the start itself is not a resume')

  for (const round of [1, 2, 3]) {
    fake.emit('state', { running: false, reason: 'paused' })
    assert.equal(provider.getFrameEpoch(), round - 1, `round ${round}: backgrounded, the epoch has not moved yet`)
    fake.emit('state', { running: true })
    assert.equal(provider.getFrameEpoch(), round, `round ${round}: foregrounded, a new epoch`)
    assert.equal(provider.trackingStatus(), 'INITIALIZING')
    assert.equal(provider.isTracking(), false, 'there is still no pose')
  }
  assert.deepEqual(events, [
    { type: 'interrupted', epoch: 0 },
    { type: 'resumed', epoch: 1, frameChanged: true },
    { type: 'interrupted', epoch: 1 },
    { type: 'resumed', epoch: 2, frameChanged: true },
    { type: 'interrupted', epoch: 2 },
    { type: 'resumed', epoch: 3, frameChanged: true },
  ])
  provider.stop()
})

test('a native side that reported an epoch and sends none after an interruption is assumed to have lost its frame', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  fake.emit('state', { running: false, interrupted: true })
  fake.emit('state', { running: true })
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }], 'a native that sends epochs is waited for')
  assert.equal(provider.getFrameEpoch(), 0)

  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.getFrameEpoch(), 1, 'no epoch on the pose that follows is not a promise that the frame survived')
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }, { type: 'resumed', epoch: 1, frameChanged: true }])
  provider.stop()
})

test('once a resume is settled, the next interruption is announced as a new one, whichever way the resume was settled', async () => {
  const withEpochs = fakeArSession()
  const waits = new NativeARProvider(() => withEpochs.plugin)
  const heard = recordSessionEvents(waits)
  await waits.start(canvas())
  withEpochs.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  withEpochs.emit('state', { running: false, interrupted: true })
  withEpochs.emit('state', { running: true })
  withEpochs.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  withEpochs.emit('state', { running: false, interrupted: true })
  assert.deepEqual(
    heard,
    [{ type: 'interrupted', epoch: 0 }, { type: 'resumed', epoch: 0, frameChanged: false }, { type: 'interrupted', epoch: 0 }],
    'a pose settled the first resume, so the second interruption is news',
  )
  waits.stop()

  const noEpochs = fakeArSession()
  const acts = new NativeARProvider(() => noEpochs.plugin)
  const seen = recordSessionEvents(acts)
  await acts.start(canvas())
  noEpochs.emit('state', { running: false, reason: 'interrupted' })
  noEpochs.emit('state', { running: true })
  noEpochs.emit('state', { running: false, reason: 'interrupted' })
  assert.deepEqual(seen.map((e) => e.type), ['interrupted', 'resumed', 'interrupted'], 'the same when the resume was settled at once')
  acts.stop()
})

test('a state push that ends the session for another reason clears an unresolved interruption: what follows is a new one, and no resume', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('state', { running: false, reason: 'interrupted' })
  fake.emit('state', { running: false, reason: 'The camera is not available for AR: busy' })
  fake.emit('state', { running: true })
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }], 'the session had ended, so running again resumed nothing')
  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }, { type: 'interrupted', epoch: 0 }], 'and the next interruption is announced')
  provider.stop()
})

test('a second interruption before the pose that settles the first is not announced again, and one resume settles both', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  fake.emit('state', { running: false, reason: 'interrupted' })
  fake.emit('state', { running: true })
  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }], 'still the same unresolved interruption')
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }, { type: 'resumed', epoch: 0, frameChanged: false }])
  provider.stop()
})

test('a resume where the native side keeps its epoch keeps the frame, and says so', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  fake.emit('state', { running: false, interrupted: true })
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, trackingStatus: 'LIMITED', trackingReason: 'RELOCALIZING', epoch: 5 })

  assert.equal(provider.getFrameEpoch(), 0, 'relocalizing against the old map is the same frame')
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }, { type: 'resumed', epoch: 0, frameChanged: false }])
  assert.equal(trackingIsUsable(provider.trackingStatus()), false, 'the same frame, but still not usable while it relocalizes')
  assert.equal(provider.getTrackingReason(), 'RELOCALIZING')
  provider.stop()
})

test('a resume where the native side reports a newer epoch is a new frame, counted once', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  fake.emit('state', { running: false, interrupted: true })
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, epoch: 6 })
  fake.emit('pose', { ...NORMAL_POSE, epoch: 6 })

  assert.equal(provider.getFrameEpoch(), 1)
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 0 }, { type: 'resumed', epoch: 1, frameChanged: true }])
  provider.stop()
})

test('a newer native epoch while the session runs is a relocalization; the same epoch again is not', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 3 })
  fake.emit('pose', { ...NORMAL_POSE, epoch: 3 })
  assert.deepEqual(events, [], 'the first epoch it sees is only learned')
  assert.equal(provider.getFrameEpoch(), 0)

  fake.emit('pose', { ...NORMAL_POSE, position: { x: 9, y: 9, z: 9 }, epoch: 4 })
  assert.equal(provider.getFrameEpoch(), 1)
  assert.deepEqual(events, [{ type: 'relocalized', epoch: 1 }])
  assert.deepEqual(provider.getPose().position, { x: 9, y: 9, z: 9 }, 'the pose that carries the new epoch is in the new frame')
  fake.emit('pose', { ...NORMAL_POSE, epoch: 4 })
  assert.equal(events.length, 1)
  provider.stop()
})

test('a pose from an older native epoch than the one already seen is in a frame that is gone, and is ignored', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  const good = provider.getPose()

  fake.emit('pose', { ...NORMAL_POSE, position: { x: 7, y: 7, z: 7 }, epoch: 4, trackingReason: 'NONE' })
  assert.deepEqual(provider.getPose(), good)
  assert.equal(provider.getTrackingReason(), 'UNKNOWN')
  assert.equal(provider.getFrameEpoch(), 0)
  provider.stop()
})

test('the first start is the first frame and every later start is a new epoch, the native epoch is learned afresh, and a listener stays subscribed across restarts', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordSessionEvents(provider)
  assert.equal(provider.getFrameEpoch(), 0, 'no session yet')
  await provider.start(canvas())
  assert.equal(provider.getFrameEpoch(), 0)
  fake.emit('pose', { ...NORMAL_POSE, epoch: 50 })
  provider.stop()

  await provider.start(canvas())
  assert.equal(provider.getFrameEpoch(), 1, 'a new session is a new frame')
  fake.emit('pose', { ...NORMAL_POSE, epoch: 1 })
  assert.equal(provider.getFrameEpoch(), 1, 'a native epoch lower than the last session is not stale, because the native side restarted')
  assert.equal(provider.isTracking(), true, 'and its pose is read')
  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.deepEqual(events, [{ type: 'interrupted', epoch: 1 }])
  provider.stop()
})

test('a listener that throws does not stop the others or the provider, and one that has unsubscribed hears nothing', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  provider.onSessionEvent(() => {
    throw new Error('a listener bug')
  })
  const heard: string[] = []
  const stop = provider.onSessionEvent((event) => heard.push(`first:${event.type}`))
  provider.onSessionEvent((event) => heard.push(`second:${event.type}`))
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)

  fake.emit('state', { running: false, reason: 'interrupted' })
  stop()
  fake.emit('state', { running: true })
  fake.emit('pose', NORMAL_POSE)
  assert.deepEqual(heard, ['first:interrupted', 'second:interrupted', 'second:resumed'])
  assert.equal(provider.trackingStatus(), 'NORMAL')
  provider.stop()
})

// ─── The same epochs, in the shapes every provider uses (WP-17b) ────────────

/** Every discontinuity the provider announces, without the clock. */
function recordDiscontinuities(provider: NativeARProvider): Array<Omit<FrameDiscontinuity, 'atMs'>> {
  const events: Array<Omit<FrameDiscontinuity, 'atMs'>> = []
  provider.onFrameDiscontinuity((event) => {
    const { atMs, ...rest } = event
    assert.ok(Number.isFinite(atMs), 'every discontinuity says when it happened')
    events.push(rest)
  })
  return events
}

test('a resume that changed the frame is a discontinuity that says how long the session was away; a start, an interruption and a resume that kept the frame are not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordDiscontinuities(provider)
  await provider.start(canvas())
  assert.deepEqual(events, [], 'a start is a new map, not a discontinuity within one')
  fake.emit('pose', NORMAL_POSE)
  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.deepEqual(events, [], 'an interruption has changed nothing yet')

  t.mock.timers.tick(2_500)
  fake.emit('state', { running: true })
  assert.deepEqual(events, [{ epoch: 1, cause: 'resumed', hiddenMs: 2_500 }], 'the epoch the provider now reports, and how long the OS had the session')
  assert.equal(provider.getFrameEpoch(), 1)

  // A native side that sends epochs and keeps its own across the interruption promises the frame survived: nothing to report.
  const kept = fakeArSession()
  const steady = new NativeARProvider(() => kept.plugin)
  const quiet = recordDiscontinuities(steady)
  await steady.start(canvas())
  kept.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  kept.emit('state', { running: false, interrupted: true })
  kept.emit('state', { running: true })
  kept.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  assert.deepEqual(quiet, [])
  assert.equal(steady.getFrameEpoch(), 0)
  provider.stop()
  steady.stop()
})

test('the reason the pose that settles a resume carries rides along, and a reason that is none or unknown does not', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordDiscontinuities(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  fake.emit('state', { running: false, interrupted: true })
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, trackingStatus: 'LIMITED', trackingReason: 'RELOCALIZING', epoch: 6 })
  assert.equal(events.length, 1)
  assert.equal(events[0].reason, 'RELOCALIZING')
  assert.equal(events[0].cause, 'resumed')

  fake.emit('state', { running: false, interrupted: true })
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'NONE', epoch: 7 })
  fake.emit('state', { running: false, interrupted: true })
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, epoch: 8 })
  assert.equal(events.length, 3)
  assert.equal('reason' in events[1], false, 'the native side said there is none')
  assert.equal('reason' in events[2], false, 'and this one said nothing')
  provider.stop()
})

test('a native epoch that moves while the session runs is a reset the runtime reported, with no transform, and it is counted as a pose jump', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const events = recordDiscontinuities(provider)
  await provider.start(canvas())
  fake.emit('pose', { ...NORMAL_POSE, epoch: 3 })
  assert.equal(provider.getTrackingDiagnostics().poseJumps, 0)
  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'RELOCALIZING', epoch: 4 })
  assert.deepEqual(events, [{ epoch: 1, cause: 'reset', transform: null, reason: 'RELOCALIZING' }])
  const d = provider.getTrackingDiagnostics()
  assert.equal(d.poseJumps, 1)
  assert.equal(d.epoch, 1)
  fake.emit('pose', { ...NORMAL_POSE, epoch: 4 })
  assert.equal(events.length, 1, 'the same epoch again is not a second one')
  provider.stop()
})

test('the diagnostics say what the provider knows: status, the reason when there is one, the epoch, and the moves the native side reported', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  assert.deepEqual(provider.getTrackingDiagnostics(), { status: 'NOT_AVAILABLE', poseJumps: 0, lastJumpM: 0, epoch: 0 })
  await provider.start(canvas())
  assert.deepEqual(provider.getTrackingDiagnostics(), { status: 'INITIALIZING', poseJumps: 0, lastJumpM: 0, epoch: 0 })

  fake.emit('pose', { ...NORMAL_POSE, trackingStatus: 'LIMITED', trackingReason: 'EXCESSIVE_MOTION' })
  assert.deepEqual(provider.getTrackingDiagnostics(), { status: 'LIMITED', reason: 'EXCESSIVE_MOTION', poseJumps: 0, lastJumpM: 0, epoch: 0 })
  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'NONE' })
  assert.equal('reason' in provider.getTrackingDiagnostics(), false, 'none is not a reason')
  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'SOMETHING_NEW' })
  assert.equal('reason' in provider.getTrackingDiagnostics(), false, 'and one this build does not know is not trusted')

  fake.emit('state', { running: false, reason: 'interrupted' })
  assert.deepEqual(provider.getTrackingDiagnostics(), { status: 'NOT_AVAILABLE', poseJumps: 0, lastJumpM: 0, epoch: 0 })
  provider.stop()
})

test('a listener of discontinuities that throws does not stop the others or the provider, one that has unsubscribed hears nothing, and it stays subscribed across a restart', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  provider.onFrameDiscontinuity(() => {
    throw new Error('a listener bug')
  })
  const heard: string[] = []
  const stop = provider.onFrameDiscontinuity((event) => heard.push(`first:${event.cause}`))
  provider.onFrameDiscontinuity((event) => heard.push(`second:${event.cause}:${event.epoch}`))
  await provider.start(canvas())
  fake.emit('state', { running: false, reason: 'interrupted' })
  fake.emit('state', { running: true })
  stop()
  fake.emit('state', { running: false, reason: 'interrupted' })
  fake.emit('state', { running: true })
  assert.deepEqual(heard, ['first:resumed', 'second:resumed:1', 'second:resumed:2'])

  provider.stop()
  await provider.start(canvas())
  fake.emit('state', { running: false, reason: 'interrupted' })
  fake.emit('state', { running: true })
  assert.equal(heard[heard.length - 1], 'second:resumed:4', 'a restart is epoch 3, and the listener is still there')
  assert.equal(provider.trackingStatus(), 'INITIALIZING')
  provider.stop()
})

test('a scan\'s epoch log reads a native provider as it reads the others: an interruption that changes the frame is one frame shift, with its cause and how long', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000 })
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  await provider.start(canvas())
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  log.noteCalibrated()
  assert.equal(log.frameShifts, 0)

  fake.emit('pose', { ...NORMAL_POSE, epoch: 5 })
  fake.emit('state', { running: false, interrupted: true })
  assert.equal(log.frameShifts, 0, 'interrupted is not a shift')
  t.mock.timers.tick(4_000)
  fake.emit('state', { running: true })
  fake.emit('pose', { ...NORMAL_POSE, trackingReason: 'RELOCALIZING', trackingStatus: 'LIMITED', epoch: 6 })
  assert.equal(log.frameShifts, 1)
  assert.equal(log.hasDiscontinuitySince(0), true)
  assert.equal(log.discontinuitiesSince(0)[0].cause, 'resumed')

  fake.emit('pose', { ...NORMAL_POSE, epoch: 7 })
  const record = log.snapshot()
  assert.equal(record.currentEpoch, 2)
  assert.equal(record.jumpCount, 2)
  assert.deepEqual(record.jumps.map((j) => [j.epoch, j.cause]), [[1, 'resumed'], [2, 'reset']])
  assert.equal(record.jumps[0].hiddenMs, 4_000)
  assert.equal(record.jumps[0].reason, 'RELOCALIZING')
  assert.equal(record.jumps[1].transform, null, 'the runtime reported the move and could not say what it was')
  provider.stop()
})

test('the first session is epoch 0, as in the WebXR provider: a log attached before the first start reads no frame shift from a healthy one, and a second start is one', async () => {
  const fake = fakeArSession()
  const provider = new NativeARProvider(() => fake.plugin)
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.getFrameEpoch(), 0)
  assert.equal(log.frameShifts, 0, 'a healthy first session is not an interruption')
  assert.equal(describeTracking(provider.getTrackingDiagnostics()).warn, false, describeTracking(provider.getTrackingDiagnostics()).text)
  assert.equal(describeTracking(provider.getTrackingDiagnostics()).text, 'Tracking NORMAL · no frame shifts')

  provider.stop()
  await provider.start(canvas())
  assert.equal(provider.getFrameEpoch(), 1, 'a new session is a new map')
  assert.equal(log.frameShifts, 1)
  provider.stop()
})

test('a start the native side refused is not a session: the next start is still the first frame, so a healthy first session after a refusal reads no shift', async () => {
  const options: { startError?: Error } = { startError: new Error('camera permission refused') }
  const fake = fakeArSession(options)
  const provider = new NativeARProvider(() => fake.plugin)
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  await assert.rejects(provider.start(canvas()), /camera permission refused/)
  assert.equal(provider.getFrameEpoch(), 0)

  options.startError = undefined
  await provider.start(canvas())
  fake.emit('pose', NORMAL_POSE)
  assert.equal(provider.getFrameEpoch(), 0, 'nothing was recorded in the session that never started')
  assert.equal(log.frameShifts, 0)

  provider.stop()
  await provider.start(canvas())
  assert.equal(provider.getFrameEpoch(), 1, 'a start after a session that ran is a new map')
  provider.stop()
})

test('tracking is never usable across a change of frame: from the interruption until a pose of the new frame arrives, whichever way the native side is built', async () => {
  type Push = [event: 'pose' | 'state', data: unknown]
  const sequences: Record<string, { pushes: Push[]; usable: boolean[]; epochs: number[] }> = {
    'iOS with epochs, the frame kept': {
      pushes: [['pose', { ...NORMAL_POSE, epoch: 5 }], ['state', { running: false, reason: 'interrupted' }], ['state', { running: true }], ['pose', { ...NORMAL_POSE, epoch: 5 }]],
      usable: [true, false, false, true],
      epochs: [0, 0, 0, 0],
    },
    'iOS with epochs, a newer frame': {
      pushes: [['pose', { ...NORMAL_POSE, epoch: 5 }], ['state', { running: false, reason: 'interrupted' }], ['state', { running: true }], ['pose', { ...NORMAL_POSE, epoch: 6 }]],
      usable: [true, false, false, true],
      epochs: [0, 0, 0, 1],
    },
    'iOS as it is today (no epoch)': {
      pushes: [['pose', NORMAL_POSE], ['state', { running: false, reason: 'interrupted' }], ['state', { running: true }], ['pose', NORMAL_POSE]],
      usable: [true, false, false, true],
      epochs: [0, 0, 1, 1],
    },
    'Android as it is today (state only, no pose)': {
      pushes: [['state', { running: true }], ['state', { running: false, reason: 'paused' }], ['state', { running: true }]],
      usable: [false, false, false],
      epochs: [0, 0, 1],
    },
  }
  for (const [name, { pushes, usable, epochs }] of Object.entries(sequences)) {
    const fake = fakeArSession()
    const provider = new NativeARProvider(() => fake.plugin)
    await provider.start(canvas())
    pushes.forEach(([event, data], i) => {
      fake.emit(event, data)
      assert.equal(trackingIsUsable(provider.trackingStatus()), usable[i], `${name}, push ${i + 1}: usable`)
      assert.equal(provider.getFrameEpoch(), epochs[i], `${name}, push ${i + 1}: epoch`)
    })
    provider.stop()
  }
})

test('every reason the contract names is one the provider trusts, and the two native vocabularies agree where they overlap', () => {
  // ARKit's ARCamera.TrackingState.Reason cases, in the contract's words (WWDC18 session 610 names them).
  const arkit: Record<string, string> = {
    initializing: 'INITIALIZING',
    relocalizing: 'RELOCALIZING',
    excessiveMotion: 'EXCESSIVE_MOTION',
    insufficientFeatures: 'INSUFFICIENT_FEATURES',
  }
  // ARCore's TrackingFailureReason (developers.google.com/ar/reference/java/com/google/ar/core/TrackingFailureReason).
  const arcore = ['NONE', 'BAD_STATE', 'CAMERA_UNAVAILABLE', 'EXCESSIVE_MOTION', 'INSUFFICIENT_FEATURES', 'INSUFFICIENT_LIGHT']
  for (const name of [...Object.values(arkit), ...arcore]) {
    assert.equal(parsePosePush({ ...NORMAL_POSE, trackingReason: name })?.reason, name, `${name} is trusted`)
  }
  assert.equal(arkit.excessiveMotion, arcore[3], 'the two agree on excessive motion')
  assert.equal(arkit.insufficientFeatures, arcore[4], 'and on insufficient features')
})

/** Source with its comments removed. String literals are kept whole and skipped, so a `//` inside one is not a comment. */
function withoutComments(source: string): string {
  return source.replace(/"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (found) => (found.startsWith('"') ? found : ''))
}

/**
 * The code between the braces of the function whose declaration `declaration` matches (the pattern ends before the opening
 * brace). Braces inside string literals do not count. A string is pinned to the function that sends it this way: a lazy
 * `[\s\S]*?` from the function's name to the string is satisfied by the same text in any later function of the file.
 */
function bodyOf(source: string, declaration: RegExp): string {
  const code = withoutComments(source)
  const found = declaration.exec(code)
  assert.ok(found, `the source declares ${declaration}`)
  const open = code.indexOf('{', found.index + found[0].length)
  assert.ok(open >= 0, `${declaration} has a body`)
  let depth = 0
  for (let at = open; at < code.length; at++) {
    const ch = code[at]
    if (ch === '"') {
      at++
      while (at < code.length && code[at] !== '"') at += code[at] === '\\' ? 2 : 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return code.slice(open + 1, at)
  }
  return assert.fail(`the braces of ${declaration} do not balance`)
}

/** The top-level string keys of the Swift dictionary literal that opens at the first `[` after `anchor`. */
function swiftLiteralKeys(code: string, anchor: string): string[] {
  const from = code.indexOf(anchor)
  assert.ok(from >= 0, `the source has ${anchor}`)
  const keys: string[] = []
  let depth = 0
  for (let at = code.indexOf('[', from); at < code.length; at++) {
    const ch = code[at]
    if (ch === '"') {
      const close = code.indexOf('"', at + 1)
      if (depth === 1 && /^\s*:/.test(code.slice(close + 1, close + 8))) keys.push(code.slice(at + 1, close))
      at = close
      continue
    }
    if (ch === '[' || ch === '(') depth++
    else if ((ch === ']' || ch === ')') && --depth === 0) break
  }
  return keys
}

test('each string and key the provider reads is sent by the function it assumes sends it, in both native sources', () => {
  const swift = read('mobile/ios/App/App/ArSessionPlugin.swift')
  const java = read('mobile/android/app/src/main/java/com/companionintelligence/scan/ArSessionPlugin.java')

  // The events: the web side listens to `pose` and `state` and to nothing else.
  const eventNames = (source: string) => [...new Set([...withoutComments(source).matchAll(/notifyListeners\("([^"]+)"/g)].map((m) => m[1]))].sort()
  assert.deepEqual(eventNames(swift), ['pose', 'state'], 'iOS pushes pose and state')
  assert.deepEqual(eventNames(java), ['state'], 'Android runs no frame loop, so it pushes state only: if it starts to push poses, pin their keys here')

  // iOS: an ARKit interruption is `reason: "interrupted"`, its end is running with no reason, and a pose carries three keys.
  assert.match(
    bodyOf(swift, /func sessionWasInterrupted\(_ session: ARSession\)\s*/),
    /notifyListeners\("state", data: \["running": false, "reason": "interrupted"\]\)/,
    'iOS reports an ARKit interruption as running false with reason interrupted',
  )
  assert.match(
    bodyOf(swift, /func sessionInterruptionEnded\(_ session: ARSession\)\s*/),
    /notifyListeners\("state", data: \["running": true\]\)/,
    'iOS reports the interruption ending as running true with no reason',
  )
  assert.match(bodyOf(swift, /func start\(_ call: CAPPluginCall\)\s*/), /notifyListeners\("state", data: \["running": true\]\)/, 'iOS reports a started session')
  const endSession = bodyOf(swift, /func endSession\(reason: String\?\)\s*/)
  assert.match(endSession, /var data: \[String: Any\] = \["running": false\]/, 'iOS reports an ended session as running false')
  assert.match(endSession, /data\["reason"\] = reason/, 'with the failure text as its reason')
  assert.match(endSession, /notifyListeners\("state", data: data\)/)
  assert.deepEqual(
    swiftLiteralKeys(bodyOf(swift, /func session\(_ session: ARSession, didUpdate frame: ARFrame\)\s*/), 'notifyListeners("pose"'),
    ['position', 'rotation', 'trackingStatus'],
    'the pose push has the keys parsePosePush reads and no others. If iOS starts to send trackingReason or epoch, use exactly those names, and change the sentence "Neither native side sends them yet" in src/ar/native-provider.ts',
  )

  // Android: the app going to the background is reason "paused", coming back is running with no reason, and pushState writes two keys.
  assert.match(bodyOf(java, /protected void handleOnPause\(\)\s*/), /pushState\(false, "paused"\)/, 'Android reports the app going to the background as reason paused')
  assert.match(bodyOf(java, /protected void handleOnResume\(\)\s*/), /pushState\(true, null\)/, 'and reports it coming back as running with no reason')
  const pushState = bodyOf(java, /private void pushState\(boolean running, String reason\)\s*/)
  assert.deepEqual([...pushState.matchAll(/data\.put\("([^"]+)"/g)].map((m) => m[1]), ['running', 'reason'], 'a state push has the keys the provider reads and no others')
  assert.match(pushState, /data\.put\("running", running\)/)
  assert.match(pushState, /data\.put\("reason", reason\)/)
  assert.match(pushState, /notifyListeners\("state", data\)/)

  // Neither side sends `interrupted`, `trackingReason` or `epoch` yet, as the header of native-provider.ts says.
  assert.doesNotMatch(withoutComments(swift), /(?:[\[,]\s*|data\[)"(?:trackingReason|epoch|interrupted)"\s*(?::|\]\s*=)/, 'iOS now sends a field the header says no native side sends')
  assert.doesNotMatch(withoutComments(java), /\.put\("(?:trackingReason|epoch|interrupted)"/, 'Android now sends a field the header says no native side sends')
})

test('every status the iOS plugin can send is one the provider trusts, and the collapse of ARKit\'s limited reasons is pinned until iOS sends the reason', () => {
  const swift = read('mobile/ios/App/App/ArSessionPlugin.swift')
  const body = bodyOf(swift, /private func trackingStatus\(_ state: ARCamera\.TrackingState\) -> String\s*/)
  const sent = [...new Set([...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]))].sort()
  assert.deepEqual(sent, ['INITIALIZING', 'LIMITED', 'NORMAL', 'NOT_AVAILABLE'])
  for (const status of sent) {
    assert.equal(parsePosePush({ ...NORMAL_POSE, trackingStatus: status })?.status, status, `${status} is read as it is sent, not as NOT_AVAILABLE`)
  }
  // Today every limited reason but "initializing" reads LIMITED, so relocalizing, excessive motion and insufficient features are the same
  // to the web side. When iOS sends `trackingReason` (the names are NativeTrackingReason's), this is the line to change, together with the
  // sentence "Neither native side sends them yet" in src/ar/native-provider.ts and the pose-push keys pinned above.
  assert.match(body, /case \.limited\(let reason\):\s*return reason == \.initializing \? "INITIALIZING" : "LIMITED"/, 'iOS still collapses the limited reasons')
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

/**
 * Swift source with its comments removed and its string literals emptied, so text that only names a class is not read as
 * code that uses it. The literals are matched first, so a `//` inside one (a URL) does not start a comment.
 */
function swiftCode(source: string): string {
  return source.replace(/"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (found) => (found.startsWith('"') ? '""' : ''))
}

/** Every Swift file under mobile/ios, as [path from the repo root, its code]. Package checkouts and build output are not the app's. */
function iosSwiftSources(dir = 'mobile/ios'): Array<[string, string]> {
  const notTheApps = new Set(['Pods', 'build', 'DerivedData', '.build', 'node_modules'])
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return notTheApps.has(entry.name) ? [] : iosSwiftSources(path)
    return entry.name.endsWith('.swift') ? [[path, swiftCode(read(path))]] : []
  })
}

/** A property list as plain values: a dict is an object, an array an array, <true/> and <false/> booleans, anything else its text. */
function parsePlist(xml: string): Record<string, unknown> {
  const token = /<(dict|array)>|<\/(dict|array)>|<(true|false)\s*\/>|<(key|string|integer|real|date|data)>([^<]*)<\/\4>/g
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const tokens = [...body.matchAll(token)].map((m) => ({ open: m[1], close: m[2], flag: m[3], tag: m[4], text: m[5] }))
  const unread = body.replace(token, '').replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<\/?plist[^>]*>/g, '').trim()
  assert.equal(unread, '', 'the whole property list is read')
  let at = 0
  const value = (): unknown => {
    const next = tokens[at++]!
    if (next.open === 'dict') {
      const dict: Record<string, unknown> = {}
      while (tokens[at]!.close !== 'dict') {
        const key = tokens[at++]!
        assert.equal(key.tag, 'key', 'a dict holds keys, each with a value')
        dict[key.text!] = value()
      }
      at++
      return dict
    }
    if (next.open === 'array') {
      const items: unknown[] = []
      while (tokens[at]!.close !== 'array') items.push(value())
      at++
      return items
    }
    return next.flag ? next.flag === 'true' : next.text
  }
  return value() as Record<string, unknown>
}

// Skipped while the shells are main's (ADR 0009, the ScanAR plugin): they register no ArSessionPlugin. The goal-integration
// plugin's sources and this provider stay in the tree, unregistered, until the owner decides whether the two native designs both
// stay. If they do, the shells register both and this test is the check that they do. If not, it goes with the plugin.
test('both native plugins are registered on their bridge and compiled into the app', { skip: "the shells carry main's ScanAR plugin only (ADR 0009); this one is for goal-integration's ArSession plugin, which is not registered until the owner decides" }, () => {
  const bridgeController = read('mobile/ios/App/App/ScanBridgeViewController.swift')
  const storyboard = read('mobile/ios/App/App/Base.lproj/Main.storyboard')
  const pbxproj = read('mobile/ios/App/App.xcodeproj/project.pbxproj')
  assert.match(bridgeController, /bridge\?\.registerPluginInstance\(ArSessionPlugin\(\)\)/)
  assert.match(storyboard, /customClass="ScanBridgeViewController" customModule="App"/)
  assert.match(pbxproj, /ArSessionPlugin\.swift in Sources \*\//)
  assert.match(pbxproj, /ScanBridgeViewController\.swift in Sources \*\//)

  // The registration only counts on the bridge the person sees, which is the one SceneDelegate puts in the window. So it
  // must build the app's own controller: a stock CAPBridgeViewController registers no ArSessionPlugin, and the web side's
  // isSupported() would read false on a phone that has ARKit. And nothing else may build a bridge. That includes a scene
  // storyboard: UIKit makes a window and an initial controller from the storyboard a scene configuration names (Main, which
  // names ScanBridgeViewController), beside the one SceneDelegate makes. With none named, SceneDelegate is the one place.
  const problems: string[] = []
  const sceneDelegate = swiftCode(read('mobile/ios/App/App/SceneDelegate.swift'))
  if (!/\bclass SceneDelegate\b/.test(sceneDelegate)) problems.push('SceneDelegate.swift no longer declares SceneDelegate')
  if (!/\brootViewController\s*=\s*ScanBridgeViewController\(\)/.test(sceneDelegate)) {
    problems.push('SceneDelegate.swift does not make ScanBridgeViewController() the window root')
  }
  for (const [path, code] of iosSwiftSources()) {
    if (/\bCAPBridgeViewController\s*(?:\.init\s*)?\(/.test(code)) {
      problems.push(`${path} makes a stock CAPBridgeViewController, which registers no ArSessionPlugin`)
    }
  }
  const manifest = parsePlist(read('mobile/ios/App/App/Info.plist')).UIApplicationSceneManifest as {
    UISceneConfigurations: Record<string, Array<Record<string, string>>>
  }
  const scenes = Object.values(manifest.UISceneConfigurations).flat()
  assert.ok(scenes.length > 0, 'Info.plist configures a scene')
  for (const scene of scenes) {
    if (scene.UISceneDelegateClassName !== '$(PRODUCT_MODULE_NAME).SceneDelegate') {
      problems.push(`Info.plist: scene "${scene.UISceneConfigurationName}" runs ${scene.UISceneDelegateClassName}, not SceneDelegate`)
    }
    if ('UISceneStoryboardFile' in scene) {
      problems.push(`Info.plist: scene "${scene.UISceneConfigurationName}" names the storyboard ${scene.UISceneStoryboardFile}, so UIKit builds a controller from it beside the one SceneDelegate makes`)
    }
  }
  assert.deepEqual(problems, [])

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
