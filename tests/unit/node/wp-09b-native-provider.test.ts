/**
 * One scan, one frame, with the native provider under it (merge-integrity review of ebad94e, package native): the
 * provider both shells run (src/ar/native.ts, over the ScanAR plugin) against the flows that read ARProvider's optional
 * members, the way wp-09b-real-provider.test.ts runs them against the 8th Wall provider.
 *
 * The runtime is the real NativeARProvider over a fake plugin (./support/fake-scan-ar.ts); the consumers are the real
 * ones: the scan's epoch log, the re-anchor flow, the unit stamp, the tap reader. NOTHING HERE HAS RUN ON A DEVICE: the
 * plugin's behaviour is what native-bridge.ts documents and the two native sources show, and every number is a scenario
 * written from physical reasoning, not read off a phone.
 *
 * The expected values come from the rules the repo writes down, never from a second detector fed the same stream:
 *   - a person walks at about 1.4 m/s, so a pose that steps 1 m sideways between two frames 33 ms apart (30 m/s) is the
 *     map moving, and a pose that has covered 1.4 m in the one second a stalled bridge held back is a person walking;
 *   - tracking that is missing for at least RECOVERY_SUSPECT_MS and returns is suspect, a shorter blip is not, and a
 *     relocalization counts whatever its length (src/ar/frame-epoch.ts, the rules at the top of the file);
 *   - ARCore reports no relocalization (ScanARRenderer.trackingName), ARKit does (ScanARPlugin.describe), so the same short
 *     stretch of limited tracking is an epoch on iOS and not on Android: a signal the runtime does not give is not invented.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-native-provider.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeARProvider } from '../../../src/ar/native.ts'
import type { ARProvider, HitBurst, RawFrame } from '../../../src/ar/provider.ts'
import { RECOVERY_SUSPECT_MS, ScanFrameEpochLog, describeTracking, type FrameDiscontinuity } from '../../../src/ar/frame-epoch.ts'
import { calibrationEpochField } from '../../../src/ar/calibration-epoch.ts'
import { stampScale } from '../../../src/ar/engine-config.ts'
import { calibrationTapSampler } from '../../../src/ar/calibration-taps.ts'
import { sampleTap } from '../../../src/ar/tap-sampling.ts'
import { ReanchorFlow, type ReanchorHost } from '../../../src/ar/reanchor-flow.ts'
import { scaleKindOfMode } from '../../../src/world/scale-mode.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'
import { FakeView, settle, twoPointCalibration, twoPointFrame } from './support/reanchor-rig.ts'
import {
  FRAME_S,
  ScriptedPhone,
  fakeCanvas,
  fakeJpegFrame,
  fakePlugin,
  providerOptions,
  type FakePlugin,
} from './support/fake-scan-ar.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// The provider writes each status change and each discontinuity to the console, as the web providers do (a device run reads them
// there). Not output of these tests; the one that pins the lines captures them.
console.log = () => undefined
console.warn = () => undefined

/** Starts a native provider over a fresh fake plugin, with a phone to drive it. */
async function native(extra: Record<string, unknown> = {}) {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(providerOptions(plugin, extra))
  const events: FrameDiscontinuity[] = []
  provider.onFrameDiscontinuity((event) => events.push(event))
  await provider.start(fakeCanvas())
  return { plugin, provider, phone: new ScriptedPhone(plugin), events }
}

/** A web runtime stand-in with every required member, for the fallback. `extra` adds the optional ones a test wants. */
function webRuntime(extra: Record<string, unknown> = {}): ARProvider {
  return {
    start: async () => undefined,
    stop: () => undefined,
    captureFrame: async () => ({ pixels: new Uint8ClampedArray(4), width: 1, height: 1, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, timestamp: 0 }),
    hitTest: () => null,
    featurePoints: () => [],
    getPose: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    isTracking: () => true,
    trackingStatus: () => 'NORMAL',
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.75,
    ...extra,
  } as ARProvider
}

/** A native provider whose session cannot start, handing over to `delegate`. The listeners attached first are the page's. */
function handingOverTo(delegate: ARProvider) {
  const plugin = fakePlugin()
  plugin.startFails = 'ARCore session could not be created'
  const provider = new NativeARProvider(providerOptions(plugin, { fallback: async () => delegate }))
  return { plugin, provider }
}

// ── The members the flows read ───────────────────────────────────────────────────────────────────────

/** The optional members of ARProvider, read from the interface itself, so a member added to it is a member this file has to decide about. */
function optionalMembers(): string[] {
  const source = read('src/ar/provider.ts')
  const from = source.indexOf('export interface ARProvider {')
  assert.notEqual(from, -1, 'provider.ts declares ARProvider')
  const body = source.slice(from, source.indexOf('\n}\n', from))
  return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\?[(:]/gm)].map((m) => m[1]!)
}

/**
 * What a native session cannot give, and why. Every other optional member must be there while native runs. Absence is
 * the contract's way of saying "no signal" (a flow that reads it works without it), so a member listed here is a decision
 * written down, not an omission.
 */
const ABSENT_WHILE_NATIVE_RUNS: Record<string, string> = {
  hitTestBurstAsync: 'a hit test over the bridge comes back with no frame to pair it with (its pose, status and time), so a native tap is one hit',
  anchors: "the runtime anchors of src/ar/anchors.ts (AnchorCapability: handles, moved and lost events, release) are the WebXR Anchors Module's, and neither plugin offers them: the iOS plugin has no anchor method, and the Android plugin's setOriginAnchor and getOriginAnchor (native-bridge.ts) are one saved origin that this provider does not use",
}

test('every optional member of ARProvider is either given by a running native session or listed as absent by design', async () => {
  const members = optionalMembers()
  for (const known of ['getFrameEpoch', 'onFrameDiscontinuity', 'hitTestBurstAsync', 'scaleKind', 'scaleMode', 'scaleReady', 'anchors']) {
    assert.ok(members.includes(known), `provider.ts declares ${known}: the parse of the interface is reading it`)
  }
  for (const listed of Object.keys(ABSENT_WHILE_NATIVE_RUNS)) assert.ok(members.includes(listed), `${listed} is still an optional member`)
  const { provider } = await native()
  const bag = provider as unknown as Record<string, unknown>
  const missing = members.filter((name) => !(name in ABSENT_WHILE_NATIVE_RUNS) && typeof bag[name] === 'undefined')
  assert.deepEqual(missing, [], 'the native provider answers these, and the flows that read them are inert on a phone without them')
  for (const name of Object.keys(ABSENT_WHILE_NATIVE_RUNS)) {
    assert.equal(typeof bag[name], 'undefined', `${name} is absent while native runs, not a stub that answers for a runtime that cannot`)
  }
})

/** The methods a plugin source gives the page: iOS lists each by name for Capacitor, Android marks each with @PluginMethod. */
function pluginMethods(platform: 'ios' | 'android'): string[] {
  const names = platform === 'ios'
    ? read('mobile/ios/App/App/ScanARPlugin.swift').matchAll(/CAPPluginMethod\(name: "(\w+)"/g)
    : read('mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java').matchAll(/@PluginMethod\s+public void (\w+)\(/g)
  return [...names].map((m) => m[1]!)
}

/** A TypeScript source without its comments, for a question about what the code calls and not about what it says. */
const withoutComments = (source: string) => source.replace(/\/\*[^]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

test('what the provider says of anchors is what the plugins have: no anchor method on iOS, one origin anchor on Android that this provider does not call', () => {
  // The header and the reason above once said "neither plugin has an anchor API". The Android plugin has setOriginAnchor and
  // getOriginAnchor (native-bridge.ts: "the Android plugin has it, and the iOS plugin does not yet"). What neither plugin offers is
  // the ARProvider's `anchors`, the runtime anchors of src/ar/anchors.ts, and the words have to say that and no more.
  const anchorMethods = (platform: 'ios' | 'android') => pluginMethods(platform).filter((name) => /anchor/i.test(name)).sort()
  for (const platform of ['ios', 'android'] as const) {
    assert.ok(pluginMethods(platform).includes('hitTest'), `the parse of the ${platform} plugin reads its methods`)
  }
  assert.deepEqual(anchorMethods('ios'), [], 'the iOS plugin has no anchor method')
  assert.deepEqual(anchorMethods('android'), ['getOriginAnchor', 'setOriginAnchor'])
  const source = read('src/ar/native.ts')
  assert.doesNotMatch(withoutComments(source), /OriginAnchor/, 'this provider does not call the origin anchor')
  const header = source.slice(0, source.indexOf('import * as THREE')).replace(/\s*\n\s*\*\s*/g, ' ')
  const reason = ABSENT_WHILE_NATIVE_RUNS['anchors']!
  for (const words of [header, reason]) assert.doesNotMatch(words, /neither plugin has an anchor API/)
  for (const name of anchorMethods('android')) {
    assert.ok(header.includes(name), `the header says nothing of ${name}, which the Android plugin has`)
    assert.ok(reason.includes(name), `the reason says nothing of ${name}, which the Android plugin has`)
  }
  assert.match(header, /The iOS plugin has no anchor method/)
  assert.match(reason, /the iOS plugin has no anchor method/)
  assert.match(header, /src\/ar\/anchors\.ts \(AnchorCapability/, 'what is absent is named: the capability of src/ar/anchors.ts')
})

test('every optional member a web runtime has, the wrapper has after a hand-over, and a call to it reaches the runtime', async () => {
  const members = optionalMembers()
  const calls: string[] = []
  const answers = new Map<string, unknown>()
  const anchors = { tag: 'the delegate anchors' }
  const delegate: Record<string, unknown> = {
    ...webRuntime(),
    tag: 'delegate',
    // A method that reads `this`: a forwarder that hands out the method unbound answers for the wrong object.
    marker() { return (this as { tag?: string }).tag },
  }
  for (const name of members) {
    if (name === 'anchors') {
      delegate[name] = anchors
      continue
    }
    const answer = { from: name }
    answers.set(name, answer)
    delegate[name] = function (this: { tag?: string }) {
      assert.equal(this.tag, 'delegate', `${name} was called on the runtime itself`)
      calls.push(name)
      return name === 'onFrameDiscontinuity' ? () => undefined : answer
    }
  }
  const { provider } = handingOverTo(delegate as unknown as ARProvider)
  await provider.start(fakeCanvas())
  const wrapper = provider as unknown as Record<string, unknown>
  for (const name of members) {
    if (name === 'anchors') {
      assert.equal(wrapper[name], anchors, 'the runtime\'s anchors are the wrapper\'s')
      continue
    }
    assert.equal(typeof wrapper[name], 'function', `${name} is forwarded`)
    // Awaited: the wrapper's exact hit test is async, and its answer is the runtime's all the same.
    const answer = await (wrapper[name] as (...args: unknown[]) => unknown)(0.5, 0.5, 100)
    // The one an ARProvider hands back to its caller as its own, and the one that returns nothing: not the runtime's object.
    if (name !== 'onFrameDiscontinuity' && name !== 'onPreflightVerdict') {
      assert.equal(answer, answers.get(name), `${name} answers what the runtime answered`)
    }
  }
  assert.deepEqual(calls.sort(), members.filter((name) => name !== 'anchors').sort(), 'each call reached the web runtime, once')
})

test('a member the web runtime does not have reads as absent through the wrapper, so the flows that decide by presence still decide', async () => {
  const { provider } = handingOverTo(webRuntime())
  await provider.start(fakeCanvas())
  const bag = provider as unknown as Record<string, unknown>
  for (const name of ['getFrameEpoch', 'hitTestBurstAsync', 'scaleKind', 'scaleMode', 'scaleReady', 'anchors']) {
    assert.equal(typeof bag[name], 'undefined', `${name}: the runtime gives none, so the wrapper gives none`)
  }
  // calibrationEpochField keys on the member being there: absent, never 0, "a record that says calibrated in epoch 0 makes a claim the runtime never made".
  assert.deepEqual(calibrationEpochField(provider), {})
  const calibration = twoPointCalibration()
  assert.equal(stampScale(calibration, provider), calibration, 'nothing to stamp: the calibration is the same object, the unit "not recorded"')
})

// ── Frame epochs while the native session runs ───────────────────────────────────────────────────────

test('a person walking steadily is no frame shift: epoch 0, nothing told, no jumps counted', async () => {
  const { provider, phone, events } = await native()
  phone.walk(120, 1.4)
  assert.equal(provider.getFrameEpoch!(), 0)
  assert.deepEqual(events, [])
  assert.equal(provider.getTrackingDiagnostics().poseJumps, 0)
})

test('start-up is not a loss: a session that spends its first seconds limited while it initialises, as both natives do, starts no epoch when it reaches normal', async () => {
  // ARKit begins limited.initializing, ARCore's PAUSED with no reason reads the same (ScanARRenderer.trackingName): every native
  // scan begins this way, so a first NORMAL that counted as a recovery would begin every scan with a frame shift.
  const { provider, phone, events } = await native()
  phone.track('notAvailable')
  phone.walk(90, 0.5, 'limited.initializing')
  phone.walk(60, 0.5, 'normal')
  assert.equal(provider.getFrameEpoch!(), 0)
  assert.deepEqual(events, [])
  assert.equal(provider.getTrackingDiagnostics().epoch, 0)
})

test('start-up from a saved world map is not a loss either: ARKit reports limited.relocalizing until it is back in the map, and that is before the first normal', async () => {
  // Checklist D row 6 (docs/testing/DEVICE_TESTING.md): `tracking` events go limited.relocalizing, then normal. Relocalizing is a
  // discontinuity by itself once tracking has been normal; before that there is no frame yet to have been discontinuous with.
  const { provider, phone, events } = await native()
  phone.walk(45, 0.3, 'limited.relocalizing')
  phone.walk(60, 0.3, 'normal')
  assert.equal(provider.getFrameEpoch!(), 0)
  assert.deepEqual(events, [])
})

test('a pose that steps 1 m sideways between two frames 33 ms apart is the map moving: one epoch, a jump, the size of it', async () => {
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  phone.frameAfter(FRAME_S, 0, 0, 1.0)
  assert.equal(provider.getFrameEpoch!(), 1)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.cause, 'jump')
  assert.equal(events[0]!.epoch, 1)
  const d = provider.getTrackingDiagnostics()
  assert.equal(d.poseJumps, 1)
  assert.equal(d.epoch, 1)
  // The walk predicted a step of 4.7 cm along x, so what the 1 m step along z has that nothing explains is the 1 m.
  assert.ok(Math.abs(d.lastJumpM - 1.0) < 0.05, `lastJumpM ${d.lastJumpM}`)
  assert.equal(describeTracking(d).warn, true, 'what the calibration card shows says a frame shift happened')
})

test('1.4 m covered in the one second a stalled bridge held back is a person walking, not a frame shift', async () => {
  // The retired rule counted any pose event more than 0.30 m from the one before as a jump, so a stall in the bridge or a
  // busy page counted as the map moving. A person who walked at the same speed for the second the events were held back
  // has done nothing the map did (src/ar/frame-epoch.ts, "How a jump is told from motion").
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  phone.frameAfter(1.0, 1.4)
  phone.walk(30, 1.4)
  assert.equal(provider.getFrameEpoch!(), 0)
  assert.deepEqual(events, [])
  assert.equal(provider.getTrackingDiagnostics().poseJumps, 0)
})

test('a pause of five seconds that ends with the phone elsewhere is one suspect epoch, "recovered", that says how long it was away', async () => {
  // ARCore, backgrounded: the plugin reports notAvailable and sends no pose; on return it reports PAUSED with no reason as
  // limited.initializing until it is tracking again (ScanARRenderer.pauseSession, trackingName).
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  phone.track('notAvailable')
  phone.t += 5
  phone.frameAfter(FRAME_S, 0.4, 0, 0, 'limited.initializing')
  for (let i = 0; i < 9; i++) phone.frameAfter(FRAME_S, 0, 0, 0, 'limited.initializing')
  assert.equal(provider.getFrameEpoch!(), 0, 'nothing is decided while tracking is still limited')
  phone.frameAfter(FRAME_S, 0, 0, 0, 'normal')
  assert.equal(provider.getFrameEpoch!(), 1)
  assert.equal(events.length, 1)
  const event = events[0]!
  assert.equal(event.cause, 'recovered')
  assert.ok((event.degradedMs ?? 0) >= 5000 && (event.degradedMs ?? 0) < 6000, `away ${event.degradedMs} ms: the five seconds, and the third of a second after`)
  assert.ok(Math.abs((event.translationM ?? 0) - 0.4) < 1e-6, `the move across the pause is recorded, what a person carried included: ${event.translationM}`)
  assert.equal(provider.getTrackingDiagnostics().poseJumps, 0, 'and nothing was measured as a jump: suspect, not measured')
})

test('the same loss, delivered late (the page held back the notAvailable until the app was back), is still the five seconds', async () => {
  // The WebView is paused with the app, so the plugin's notAvailable and the first resumed poses can reach the page together.
  // Arrival time says almost no time was lost; the native frame times say five seconds were.
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  const before = phone.t
  phone.t += 5
  phone.track('notAvailable')
  phone.frameAfter(FRAME_S, 0.2, 0, 0, 'limited.initializing')
  phone.frameAfter(FRAME_S, 0, 0, 0, 'normal')
  assert.equal(provider.getFrameEpoch!(), 1)
  assert.ok((events[0]!.degradedMs ?? 0) >= 5000, `degradedMs ${events[0]!.degradedMs}, the pause began at ${before}`)
})

test('tracking that blinks for a fifth of a second is not an epoch', async () => {
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  phone.track('notAvailable')
  phone.frameAfter(0.2, 0.01, 0, 0, 'limited.initializing')
  phone.frameAfter(FRAME_S, 0.01, 0, 0, 'normal')
  assert.ok(0.2 * 1000 < RECOVERY_SUSPECT_MS, 'the blink is shorter than the rule that makes a return suspect')
  assert.equal(provider.getFrameEpoch!(), 0)
  assert.deepEqual(events, [])
})

test('ARKit reporting limited.relocalizing is a relocalization, which counts whatever its length: an epoch with that reason', async () => {
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  for (let i = 0; i < 5; i++) phone.frameAfter(FRAME_S, i === 0 ? 0.1 : 0, 0, 0, 'limited.relocalizing')
  phone.frameAfter(FRAME_S, 0, 0, 0, 'normal')
  assert.ok(6 * FRAME_S * 1000 < RECOVERY_SUSPECT_MS, 'the stretch is far shorter than the rule for a plain loss')
  assert.equal(provider.getFrameEpoch!(), 1)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.cause, 'recovered')
  assert.equal(events[0]!.reason, 'RELOCALIZING')
})

test('the same short stretch of limited tracking on ARCore, which reports no relocalization, is not an epoch: no signal is invented', async () => {
  const { provider, phone, events } = await native()
  phone.walk(60, 1.4)
  for (let i = 0; i < 5; i++) phone.frameAfter(FRAME_S, i === 0 ? 0.1 : 0, 0, 0, 'limited.initializing')
  phone.frameAfter(FRAME_S, 0, 0, 0, 'normal')
  assert.equal(provider.getFrameEpoch!(), 0)
  assert.deepEqual(events, [])
})

test('what was gathered before a shift is not handed over in the new epoch: pending points and the hit grid are dropped, what follows is kept', async () => {
  const { plugin, provider, phone } = await native()
  phone.walk(30, 1.4)
  const ahead = (dz: number) => [phone.x, 0.4, phone.z + dz]
  plugin.emit('points', { timestamp: phone.t, points: ahead(-2) })
  plugin.emit('hits', { timestamp: phone.t, cols: 1, rows: 1, samples: [{ hit: true, position: [1, 0, -2], rotation: [0, 0, 0, 1], distance: 2.2 }] })
  assert.notEqual(provider.hitTest(0.5, 0.5), null, 'the grid answers before the shift')
  phone.frameAfter(FRAME_S, 0, 0, 1.0)
  assert.equal(provider.getFrameEpoch!(), 1)
  assert.deepEqual(provider.featurePoints(), [], 'points recorded in the old frame would be stamped with the new epoch by the drain')
  assert.equal(provider.hitTest(0.5, 0.5), null, 'and so would a hit read from the old frame')
  plugin.emit('points', { timestamp: phone.t, points: ahead(-2) })
  assert.equal(provider.featurePoints().length, 1, 'a point of the new frame is kept')
})

test('a capture carries the epoch of the frame it was taken in, not the one the provider has reached by the time the plugin answers', async () => {
  const { plugin, provider, phone } = await native()
  phone.walk(30, 1.4)
  const takenAt = phone.t
  let release!: (frame: ReturnType<typeof fakeJpegFrame>) => void
  plugin.nextFrame = () => new Promise((resolve) => { release = resolve })
  const pending = provider.captureFrame(1000)
  await settle()
  // The map moves in the 33 ms after the frame that is being encoded, and the provider hears of it before the encode ends.
  phone.frameAfter(FRAME_S, 0, 0, 1.0)
  assert.equal(provider.getFrameEpoch!(), 1)
  release(fakeJpegFrame(takenAt))
  const old: RawFrame = await pending
  assert.equal(old.epoch, 0, 'taken before the shift, so in the frame the earlier points are in')
  plugin.nextFrame = async () => fakeJpegFrame(phone.t + FRAME_S)
  const fresh: RawFrame = await provider.captureFrame(1000)
  assert.equal(fresh.epoch, 1, 'taken after it')
})

test('a session that ends and another that starts is a new map: its first trustworthy frame starts the next epoch', async () => {
  const { plugin, provider, phone, events } = await native()
  phone.walk(30, 1.4)
  assert.equal(provider.getFrameEpoch!(), 0)
  provider.stop()
  await new Promise((resolve) => setImmediate(resolve))
  await provider.start(fakeCanvas())
  assert.equal(plugin.started, 2)
  phone.walk(30, 1.4)
  assert.equal(provider.getFrameEpoch!(), 1)
  assert.equal(events.at(-1)!.cause, 'resumed')
})

test('a frame the camera has not renewed (the same frame time again) is not another frame: it adds no step to the motion record', async () => {
  // ARCore's update() can hand back the frame it gave last time when the camera has not delivered a new one. The tracker must not be
  // fed it (src/ar/frame-epoch.ts, `observe`): ten distinct frames are nine steps, however often each was reported.
  const { provider, phone, events } = await native()
  for (let i = 0; i < 10; i++) {
    phone.t += FRAME_S
    phone.x += 0.04
    phone.send()
    phone.send()
  }
  assert.equal(provider.getTrackingDiagnostics().motion?.steps, 9)
  assert.deepEqual(events, [])
})

test('a pose with no frame time is still a pose, and the page says once that frame shifts cannot be watched', async () => {
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  try {
    const { plugin, provider } = await native()
    const send = () => plugin.emit('pose', { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -1, 0], tracking: 'normal' })
    send()
    send()
    assert.equal(provider.isTracking(), true)
    assert.deepEqual(provider.getPose().position, { x: 1, y: 2, z: 3 })
    assert.equal(warnings.filter((line) => /frame time/.test(line)).length, 1, 'said once, not on every event')
  } finally {
    console.warn = warn
  }
})

test('the console says what a device run reads: each status change once, and each discontinuity as it begins, in the web providers\' form', async () => {
  // `[8thwall] trackingStatus: NORMAL (reason)` and `[webxr] frame discontinuity <n>: <cause>` are what DEVICE_TESTING.md tells a
  // person to grep for (DX4); the native lines are the same with this provider's tag.
  const logged: string[] = []
  const warned: string[] = []
  const { log, warn } = console
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')) }
  try {
    const { phone } = await native()
    phone.walk(30, 1.4)
    phone.walk(5, 1.4)
    phone.track('notAvailable')
    phone.frameAfter(FRAME_S, 0.1, 0, 0, 'limited.relocalizing')
    phone.frameAfter(FRAME_S, 0, 0, 0, 'normal')
  } finally {
    console.log = log
    console.warn = warn
  }
  assert.deepEqual(logged, [
    '[native-ar] trackingStatus: NORMAL',
    '[native-ar] trackingStatus: NOT_AVAILABLE',
    '[native-ar] trackingStatus: LIMITED (RELOCALIZING)',
    '[native-ar] trackingStatus: NORMAL',
  ])
  const discontinuities = warned.filter((line) => line.startsWith('[native-ar] frame discontinuity'))
  assert.equal(discontinuities.length, 1)
  assert.match(discontinuities[0]!, /^\[native-ar\] frame discontinuity 1: recovered \{.*"cause":"recovered".*\}$/)
})

// ── The consumers, real ──────────────────────────────────────────────────────────────────────────────

test('the scan\'s epoch log, attached before the session starts as src/main.ts attaches it, reads a native shift', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(providerOptions(plugin))
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  await provider.start(fakeCanvas())
  const phone = new ScriptedPhone(plugin)
  phone.walk(60, 1.4)
  assert.deepEqual(calibrationEpochField(provider), { calibrationEpoch: 0 }, 'a native session has an epoch to report, so the calibration says which')
  log.noteCalibrated(log.currentEpoch)
  phone.frameAfter(FRAME_S, 0, 0, 1.0)
  assert.equal(log.currentEpoch, 1)
  assert.equal(log.frameShifts, 1)
  assert.equal(log.hasDiscontinuitySince(0), true)
  assert.equal(log.snapshot().jumpCount, 1, 'the sidecar says so, where it used to say one frame and no shifts')
})

test('the re-anchor flow offers the choice when a native shift follows the calibration, and holds recording while it is open', async () => {
  const plugin = fakePlugin()
  const provider = new NativeARProvider(providerOptions(plugin))
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  const view = new FakeView()
  let calibration: ScanCalibration | undefined = twoPointCalibration()
  const host: ReanchorHost = {
    storedFrame: () => twoPointFrame(),
    calibration: () => calibration,
    poses: () => [],
    readTap: async () => { throw new Error('not used') },
    finishScan: async () => 'uploaded',
    beginScan: async () => undefined,
    calibrate: async () => false,
    say: () => undefined,
  }
  const flow = new ReanchorFlow({ view, host, epochs: log, arRunId: () => 'run-a', now: () => new Date('2026-11-17T09:30:00.000Z') })
  flow.attach(provider)
  await provider.start(fakeCanvas())
  const phone = new ScriptedPhone(plugin)
  phone.walk(60, 1.4)
  log.noteCalibrated(log.currentEpoch)
  flow.arm()
  assert.equal(flow.phase, 'watching')
  assert.equal(flow.recordingHeld, false)
  phone.frameAfter(FRAME_S, 0, 0, 1.0)
  await settle()
  assert.equal(flow.phase, 'prompting', 'the person is asked, and was never asked on a phone before')
  assert.equal(view.kind, 'interruption')
  assert.equal(flow.recordingHeld, true, 'nothing is added to the scan while the choice is open')
  calibration = undefined
})

// ── The unit ─────────────────────────────────────────────────────────────────────────────────────────

test('a native session is metric by the platform contract, and says which mode: what stampScale writes onto the calibration', async () => {
  const { provider } = await native()
  const mode = provider.scaleMode!()
  assert.equal(mode, 'native-metric')
  assert.equal(provider.scaleKind!(), scaleKindOfMode(mode), 'ScaleKind is always the kind of the mode (src/world/scale-mode.ts)')
  assert.equal(provider.scaleKind!(), 'metric')
  assert.equal(provider.scaleReady!(), true, 'there is no estimate to wait for')
  const stamped = stampScale(twoPointCalibration(), provider)
  assert.equal(stamped.scaleMode, 'native-metric')
  assert.equal(stamped.scaleKind, 'metric')
})

test('after a hand-over the unit is the web runtime\'s, which for 8th Wall in its default scale is not metres', async () => {
  const eighthWall = webRuntime({
    scaleKind: () => 'arbitrary',
    scaleMode: () => 'responsive-unconfigured',
    scaleReady: () => false,
  })
  const { provider } = handingOverTo(eighthWall)
  await provider.start(fakeCanvas())
  assert.equal(provider.scaleKind!(), 'arbitrary')
  assert.equal(provider.scaleReady!(), false)
  const stamped = stampScale(twoPointCalibration(), provider)
  assert.equal(stamped.scaleMode, 'responsive-unconfigured', 'a scan made on the fallback is not stamped metric because the shell is native')
  assert.equal(stamped.scaleKind, 'arbitrary')
})

// ── Taps ─────────────────────────────────────────────────────────────────────────────────────────────

test('a native tap is read with one hit, and the record says so: source single-hit, scatter not measured, no hold-still asked for', async () => {
  const { plugin, provider, phone } = await native()
  phone.walk(10, 0)
  assert.equal(typeof provider.hitTestBurstAsync, 'undefined')
  const sampler = calibrationTapSampler({ provider, singleHit: (x, y) => provider.hitTestAsync(x, y), ground: () => null })
  assert.equal(sampler.holdsStill, false, 'a person is not told to hold still for a read that is one hit')
  const tap = await sampleTap(provider, 0.5, 0.5, { singleHit: (x, y) => provider.hitTestAsync(x, y) })
  assert.equal(tap.ok, true)
  if (tap.ok) {
    assert.equal(tap.source, 'single-hit')
    assert.equal(tap.spreadM, null)
  }
  assert.equal(plugin.hitCalls.length, 1, 'one hit over the bridge')
})

test('after a hand-over to a runtime with a burst, the tap is read as a burst through the wrapper', async () => {
  let asked = 0
  const frame = (y: number) => ({
    hit: { position: { x: 1, y, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2.2 },
    pose: { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    status: 'NORMAL',
  })
  const burst = async (): Promise<HitBurst> => {
    asked++
    return { frames: [frame(0), frame(0.001), frame(-0.001), frame(0.0005)] }
  }
  const { provider } = handingOverTo(webRuntime({ hitTestBurstAsync: burst }))
  await provider.start(fakeCanvas())
  const tap = await sampleTap(provider, 0.5, 0.5, {})
  assert.equal(asked, 1)
  assert.equal(tap.ok, true)
  if (tap.ok) assert.equal(tap.source, 'burst')
})

// ── Discontinuities across a hand-over ───────────────────────────────────────────────────────────────

test('a listener attached before the session starts hears the web runtime after a hand-over, and an unsubscribe reaches it too', async () => {
  const subscribed = new Set<(event: FrameDiscontinuity) => void>()
  let epoch = 0
  const delegate = webRuntime({
    getFrameEpoch: () => epoch,
    onFrameDiscontinuity: (cb: (event: FrameDiscontinuity) => void) => {
      subscribed.add(cb)
      return () => { subscribed.delete(cb) }
    },
  })
  const { provider } = handingOverTo(delegate)
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  assert.equal(subscribed.size, 0, 'there is no web runtime yet')
  await provider.start(fakeCanvas())
  assert.equal(subscribed.size, 1, 'the log is subscribed to the runtime that took over')
  epoch = 1
  for (const cb of [...subscribed]) cb({ epoch: 1, cause: 'jump', atMs: 5, translationM: 1 })
  assert.equal(log.currentEpoch, 1, 'the epoch the runtime is in is the wrapper\'s')
  assert.equal(log.frameShifts, 1, 'and the shift reached the scan\'s log, which it did not before')
  log.detach()
  assert.equal(subscribed.size, 0, 'detaching from the wrapper detaches from the runtime')
})

// ── Where the numbers come from ──────────────────────────────────────────────────────────────────────

test('the jump threshold lives in one place: the native provider reads frame-epoch\'s detector and keeps no rule or constant of its own', () => {
  const source = read('src/ar/native.ts')
  assert.match(source, /FrameEpochTracker/)
  assert.doesNotMatch(source, /POSE_JUMP_THRESHOLD_M/, 'the flat 0.30 m per-event rule was retired in frame-epoch.ts')
  assert.doesNotMatch(source, /trackJump/)
})

test('the flat 0.30 m jump rule has no second home: no source of src/ar declares it, and point-filter.ts, which kept it for the native provider, claims no shift rule', () => {
  // It was point-filter.ts's POSE_JUMP_THRESHOLD_M, read only by the native provider. Once that provider moved to frame-epoch's
  // detector the constant had no reader, and a number nobody reads is one somebody tunes to no effect (DX4 sizes the rules that are read).
  const files = readdirSync(join(ROOT, 'src/ar')).filter((name) => name.endsWith('.ts'))
  assert.ok(files.includes('point-filter.ts') && files.includes('frame-epoch.ts'), 'the scan reads the files that matter')
  const declaring = files.filter((name) => /\b(?:const|let|var)\s+POSE_JUMP_THRESHOLD_M\b/.test(read(`src/ar/${name}`)))
  assert.deepEqual(declaring, [], 'POSE_JUMP_THRESHOLD_M is declared again')
  const pointFilter = read('src/ar/point-filter.ts')
  const exported = [...pointFilter.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]!)
  assert.ok(exported.includes('MAX_POINT_DISTANCE_M'), 'the point rules are what this module exports')
  assert.deepEqual(exported.filter((name) => /JUMP|SHIFT/i.test(name)), [], 'point-filter.ts exports no shift rule')
  assert.doesNotMatch(pointFilter.slice(0, pointFilter.indexOf('*/')), /frame shift/i, 'so its header does not claim to decide one')
})

test('both plugins stamp their events in seconds on one monotonic clock, which is what the provider multiplies by 1000 for the tracker', () => {
  const swift = read('mobile/ios/App/App/ScanARPlugin.swift')
  const java = read('mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARRenderer.java')
  // iOS: ARFrame.timestamp, seconds. Android: Frame.getTimestamp(), nanoseconds, divided to seconds.
  assert.match(swift, /let now = frame\.timestamp/)
  assert.match(swift, /"timestamp": now,\s*\n\s*"transform"/, 'the pose event carries the frame\'s timestamp')
  assert.match(swift, /"timestamp": frame\.timestamp/, 'and so does a captured frame')
  const poseEvent = java.slice(java.indexOf('private JSObject poseEvent('), java.indexOf('private JSObject pointsEvent('))
  assert.match(poseEvent, /event\.put\("timestamp", frame\.getTimestamp\(\) \/ 1e9\)/)
  assert.match(java, /result\.put\("timestamp", frame\.getTimestamp\(\) \/ 1e9\)/, 'a captured frame is stamped on the same clock')
})

test('a comment in the AR files this package owns that names a constant and the file it lives in names the file that declares it', () => {
  // MAX_POINT_DISTANCE_M and the other point rules moved from eighthwall.ts to point-filter.ts when the native provider began
  // to share them, and a comment that still said eighthwall.ts sent a reader to a file with no such constant. Read from every
  // file of src/ar, so a pointer to a file that does not declare the name cannot be written again in these.
  // Scoped to the files of this package: frame-epoch.ts and tracking-quality.ts carry the same stale pointer
  // (POSE_JUMP_THRESHOLD_M, "in eighthwall.ts") and are another package's; widen this to every file of src once they are fixed.
  const owned = ['tap-sampling.ts', 'eighthwall.ts', 'native.ts', 'native-bridge.ts', 'native-codec.ts', 'native-provider.ts', 'provider.ts', 'runtime-select.ts']
  const declares = (file: string, name: string) => new RegExp(`(?:const|let|function|class|type|interface|enum)\\s+${name}\\b`).test(read(file))
  const named = (text: string): Array<[file: string, name: string]> => [
    ...[...text.matchAll(/((?:[\w-]+\/)*[\w-]+\.ts)[ \t]+`([A-Z][A-Z0-9_]{3,})`/g)].map((m): [string, string] => [m[1]!, m[2]!]),
    ...[...text.matchAll(/`([A-Z][A-Z0-9_]{3,})`[ \t]+(?:in|of|from)[ \t]+((?:[\w-]+\/)*[\w-]+\.ts)/g)].map((m): [string, string] => [m[2]!, m[1]!]),
  ]
  const wrong: string[] = []
  for (const owner of owned) {
    for (const [file, name] of named(read(`src/ar/${owner}`))) {
      const path = file.includes('/') ? file : `src/ar/${file}`
      if (!declares(path, name)) wrong.push(`${owner} says ${name} is in ${file}`)
    }
  }
  assert.deepEqual(wrong, [])
})
