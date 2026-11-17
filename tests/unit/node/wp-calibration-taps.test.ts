/**
 * WP-05b: how the calibration flow reads a tap and watches the landmark (src/ar/calibration-taps.ts).
 *
 * The sampler that turns a burst of hits into one measurement is WP-05a's and has its own tests
 * (tap_sampling.test.ts, tracking_quality.test.ts). What is held here is what the flow does with it, against a fake
 * provider that returns noisy hits frame by frame:
 *
 *  - the tap mode a page asks for (`?tap=single` and `?tap=floor`), and that each one reaches the sampler as what it
 *    says: one hit with no burst, or the floor ray in charge;
 *  - the reader the modal calls: a point with how high it measured, or the sentence for a refusal, with the
 *    median within a centimetre and a stray rejected, every refusal's exact words, a tap not started in a map that is
 *    not stable, and the person's way through a limit: tapping the spot that was refused again, judged by where the
 *    hits land in the map and not where the finger was, with a note on the card that says so;
 *  - the hold-still ring: what the burst's progress turns into, and what is painted;
 *  - what is kept of an accepted tap and handed back for the landmark: the floor height the frame takes and the
 *    evidence `ScanCalibration.tap` stores;
 *  - the watch on the landmark: a frame shift, a new epoch or the 90 seconds between its confirmation and the commit,
 *    on a fake clock, with the shifts watched from the tap that placed it and the clock from its confirmation;
 *  - whether the map is steady now, and how high a point measured against the landmark;
 *  - the probe's view of a tap, read with the limits lifted.
 *
 * The modal itself, driven through a stand-in document, is wp-calibration-taps-modal.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-taps.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOLD_STILL_READING_TEXT,
  READING_TEXT,
  TAP_USE_ANYWAY_TEXT,
  calibrationTapSampler,
  createCalibrationTaps,
  holdRingFor,
  limitRefusal,
  paintHoldRing,
  probeAnswerOf,
  probeTapReader,
  tapModeFromSearch,
  usedAnywayText,
  withoutBurst,
  type CalibrationTapSampler,
  type HoldRingTarget,
  type NoteTarget,
  type TapFlowProvider,
} from '../../../src/ar/calibration-taps.ts'
import {
  TAP_BURST_WINDOW_MS,
  TAP_RANGE_MAX_M,
  TAP_SAME_SPOT_M,
  TAP_SPREAD_MAX_M,
  sampleTap,
  tapRefusalText,
  type TapProgress,
  type TapProvider,
  type TapResult,
  type TapSample,
} from '../../../src/ar/tap-sampling.ts'
import { FLOOR_DATUM_AGREE_M, floorRayPoint, type GroundReading } from '../../../src/ar/ground-gate.ts'
import {
  LANDMARK_TO_COMMIT_BUDGET_MS,
  TRACKING_RECOVERING_TEXT,
  placementDisturbedText,
} from '../../../src/ar/tracking-quality.ts'
import type { HitBurstFrame, HitResult, Pose } from '../../../src/ar/provider.ts'
import type { Vec3 } from '../../../src/world/types.ts'

// ─── Fixtures ──────────────────────────────────────────────────────────────

const POSE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
/** Where the tapped spot truly is: 2.04 m from the camera, on a floor 1.2 m below it. */
const TRUTH: Vec3 = { x: 0.4, y: -1.2, z: -1.6 }
const TRUTH_RANGE_M = Math.hypot(TRUTH.x, TRUTH.y, TRUTH.z)

function hit(position: Vec3, distance = TRUTH_RANGE_M): HitResult {
  return { position, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance }
}

function frame(h: HitResult | null, extra: Partial<HitBurstFrame> = {}): HitBurstFrame {
  return { hit: h, pose: POSE, status: 'NORMAL', ...extra }
}

/** mulberry32: a seeded generator, so every number below is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
}

function noisy(truth: Vec3, sigma: number, rand: () => number): Vec3 {
  return { x: truth.x + sigma * gaussian(rand), y: truth.y + sigma * gaussian(rand), z: truth.z + sigma * gaussian(rand) }
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Twelve hits that scatter by `sigma` per axis about `truth`, from a seeded generator. */
function burstAt(truth: Vec3, sigma: number, seed: number, n = 12): HitBurstFrame[] {
  const rand = rng(seed)
  return Array.from({ length: n }, () => frame(hit(noisy(truth, sigma, rand))))
}

interface Fake {
  provider: TapProvider
  /** The windows the burst was asked for, and how many times the provider's own hit test was called. */
  windows: number[]
  singleCalls: number
  burstCalls: number
}

/**
 * A provider whose burst returns `frames` one by one through the listener (33 ms apart, as a camera would), or none at
 * all with `burst: false`. `single` is what its own synchronous hit test answers.
 */
function fakeProvider(o: { frames?: HitBurstFrame[]; burst?: boolean; single?: HitResult | null; status?: string; pose?: Pose } = {}): Fake {
  const fake: Fake = { windows: [], singleCalls: 0, burstCalls: 0, provider: undefined as unknown as TapProvider }
  const provider: TapProvider = {
    hitTest: () => {
      fake.singleCalls += 1
      return o.single ?? null
    },
    getPose: () => o.pose ?? POSE,
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.5625,
    trackingStatus: () => (o.status ?? 'NORMAL') as ReturnType<TapProvider['trackingStatus']>,
  }
  if (o.burst !== false) {
    provider.hitTestBurstAsync = async (_x, _y, windowMs, onFrame) => {
      fake.burstCalls += 1
      fake.windows.push(windowMs)
      const frames = o.frames ?? []
      frames.forEach((f, i) => onFrame?.(f, i * 33))
      return { frames }
    }
  }
  fake.provider = provider
  return fake
}

const noFloor = (): GroundReading | null => null

/** A fitted floor the tap's floor ray and datum may rely on: locked, well supported, level. */
const floorAt = (y: number): GroundReading => ({ y, locked: true, inlierCount: 400, residualM: 0.01 })

/** One thing the ring was told: the element hidden or shown, its state set, its fill set. */
interface RingEvent {
  key: 'hidden' | 'state' | 'background'
  value: unknown
}

/** An element's three members the ring is drawn on, recording each thing it was told, in order. */
function ringTarget(): HoldRingTarget & { events: RingEvent[] } {
  const events: RingEvent[] = []
  const dataset = new Proxy({} as Record<string, string | undefined>, {
    set(object, key, value) {
      object[key as string] = value
      if (key === 'state') events.push({ key: 'state', value })
      return true
    },
  })
  const style = new Proxy({ background: '' }, {
    set(object, key, value) {
      ;(object as Record<string | symbol, unknown>)[key] = value
      if (key === 'background') events.push({ key: 'background', value })
      return true
    },
  })
  const target = { hidden: true as boolean | string, dataset, style, events }
  return new Proxy(target, {
    set(object, key, value) {
      ;(object as Record<string | symbol, unknown>)[key] = value
      if (key === 'hidden') events.push({ key: 'hidden', value })
      return true
    },
  })
}

/** The element the note is written on, and what it was told, in order. */
function noteTarget(): NoteTarget & { writes: Array<{ text: string | null; hidden: boolean | string }> } {
  const writes: Array<{ text: string | null; hidden: boolean | string }> = []
  const target = { hidden: true as boolean | string, textContent: '' as string | null, writes }
  return new Proxy(target, {
    set(object, key, value) {
      ;(object as Record<string | symbol, unknown>)[key] = value
      if (key === 'hidden') writes.push({ text: object.textContent, hidden: value })
      return true
    },
  })
}

interface Flow {
  taps: ReturnType<typeof createCalibrationTaps>
  ring: ReturnType<typeof ringTarget>
  note: ReturnType<typeof noteTarget>
  /** How many times the sampler was called, and with what. */
  calls: Array<Parameters<CalibrationTapSampler>>
  setWatching(on: boolean): void
  clock: { now: number }
}

function flowOver(
  sampler: CalibrationTapSampler | undefined,
  o: { provider?: TapFlowProvider; ground?: () => GroundReading | null; watching?: boolean } = {},
): Flow {
  const ring = ringTarget()
  const note = noteTarget()
  const calls: Flow['calls'] = []
  const clock = { now: 1_000_000 }
  let watching = o.watching ?? true
  const taps = createCalibrationTaps({
    sampler: sampler && Object.assign(((...args: Parameters<CalibrationTapSampler>) => {
      calls.push(args)
      return sampler(...args)
    }) as CalibrationTapSampler, { holdsStill: sampler.holdsStill }),
    provider: o.provider ?? { trackingStatus: () => 'NORMAL' },
    ground: o.ground ?? noFloor,
    watching: () => watching,
    ring: () => ring,
    note: () => note,
    now: () => clock.now,
  })
  return { taps, ring, note, calls, setWatching: (on) => { watching = on }, clock }
}

/** The flow's reader over a fake provider, sampled as the host builds it. */
function sampledFlow(fake: Fake, o: { ground?: () => GroundReading | null; search?: string; provider?: TapFlowProvider } = {}): Flow {
  const ground = o.ground ?? noFloor
  return flowOver(calibrationTapSampler({ provider: fake.provider, ground, search: o.search }), { ...o, ground })
}

async function read(flow: Flow, x = 0.5, y = 0.6) {
  assert.ok(flow.taps.read, 'the flow has a reader')
  return flow.taps.read(x, y)
}

function accepted(answer: Awaited<ReturnType<typeof read>>) {
  assert.ok(answer && !('refused' in answer), `expected a point, got ${JSON.stringify(answer)}`)
  return answer
}

function refusedWith(answer: Awaited<ReturnType<typeof read>>): string {
  assert.ok(answer && 'refused' in answer, `expected a refusal, got ${JSON.stringify(answer)}`)
  return answer.refused
}

// ─── The tap mode ──────────────────────────────────────────────────────────

test('tap mode: sampled unless the page asks for single or floor, in any case, among other parameters', () => {
  assert.equal(tapModeFromSearch(''), 'sampled')
  assert.equal(tapModeFromSearch('?debug=remote,probe'), 'sampled')
  assert.equal(tapModeFromSearch('?tap=single'), 'single')
  assert.equal(tapModeFromSearch('?tap=floor'), 'floor')
  assert.equal(tapModeFromSearch('?debug=probe&tap=SINGLE&x=1'), 'single')
  assert.equal(tapModeFromSearch('?tap=%20Floor%20'), 'floor')
})

test('tap mode: a value the page has no such mode for is the default, not an error', () => {
  for (const search of ['?tap=', '?tap=burst', '?tap=sampled', '?tap=single,floor', '?tap=1', '?tapx=single', '?tap', '%', 'tap=single']) {
    const expected = search === 'tap=single' ? 'single' : 'sampled'
    assert.equal(tapModeFromSearch(search), expected, JSON.stringify(search))
  }
})

// ─── The sampler the host builds ───────────────────────────────────────────

test('without burst: the same camera and status, and no burst to run', () => {
  const calls: string[] = []
  const inner = fakeProvider({ single: hit(TRUTH) }).provider
  const wrapped: TapProvider = {
    ...inner,
    hitTest: (x, y) => { calls.push(`hit ${x} ${y}`); return inner.hitTest(x, y) },
    getPose: () => { calls.push('pose'); return inner.getPose() },
    getCameraFovY: () => { calls.push('fov'); return 61 },
    getCameraAspect: () => { calls.push('aspect'); return 0.75 },
    trackingStatus: () => { calls.push('status'); return 'LIMITED' },
  }
  const view = withoutBurst(wrapped)
  assert.equal('hitTestBurstAsync' in view, false)
  assert.equal(view.hitTest(0.3, 0.4)?.position.y, TRUTH.y)
  assert.deepEqual([view.getCameraFovY(), view.getCameraAspect(), view.trackingStatus(), view.getPose()], [61, 0.75, 'LIMITED', POSE])
  assert.deepEqual(calls, ['hit 0.3 0.4', 'fov', 'aspect', 'status', 'pose'])
})

test('sampled (the default): a burst for the whole window, whose median is within a centimetre of the truth', async () => {
  const fake = fakeProvider({ frames: burstAt(TRUTH, 0.008, 11) })
  const sampler = calibrationTapSampler({ provider: fake.provider, ground: noFloor, search: '' })
  const tap = await sampler(0.5, 0.6)
  assert.equal(tap.ok, true)
  assert.ok(tap.ok && dist(tap.position, TRUTH) < 0.01, `${tap.ok && dist(tap.position, TRUTH)} m off`)
  assert.ok(tap.ok && tap.source === 'burst' && tap.n === 12)
  assert.deepEqual(fake.windows, [TAP_BURST_WINDOW_MS])
})

test('?tap=single: one hit through the host\'s hit test, the burst never run, and the same gates', async () => {
  const fake = fakeProvider({ frames: burstAt(TRUTH, 0.008, 12) })
  const asked: Array<[number, number]> = []
  const sampler = calibrationTapSampler({
    provider: fake.provider,
    singleHit: async (x, y) => { asked.push([x, y]); return hit({ ...TRUTH, x: TRUTH.x + 0.02 }) },
    ground: noFloor,
    search: '?tap=single',
  })
  const tap = await sampler(0.25, 0.75)
  assert.ok(tap.ok && tap.source === 'single-hit' && tap.n === 1 && tap.spreadM === null)
  assert.ok(tap.ok && Math.abs(tap.position.x - (TRUTH.x + 0.02)) < 1e-12, 'the one hit, not a median')
  assert.deepEqual(asked, [[0.25, 0.75]])
  assert.equal(fake.burstCalls, 0, 'no burst was run')
  // The range gate is the same: a hit 4 m away is refused as it would be in a burst.
  const far = await calibrationTapSampler({
    provider: fake.provider,
    singleHit: async () => hit(TRUTH, 4),
    ground: noFloor,
    search: '?tap=single',
  })(0.5, 0.5)
  assert.deepEqual(far.ok === false && far.reason, 'too-far')
  // And the tracking gate: one hit read while the map is limited is refused.
  const limited = fakeProvider({ single: hit(TRUTH), status: 'LIMITED' })
  const refused = await calibrationTapSampler({ provider: limited.provider, ground: noFloor, search: '?tap=single' })(0.5, 0.5)
  assert.deepEqual(refused.ok === false && refused.reason, 'tracking')
})

test('?tap=single without a host hit test reads the provider\'s own', async () => {
  const fake = fakeProvider({ frames: burstAt(TRUTH, 0.008, 13), single: hit(TRUTH) })
  const tap = await calibrationTapSampler({ provider: fake.provider, ground: noFloor, search: '?tap=single' })(0.5, 0.5)
  assert.ok(tap.ok && tap.source === 'single-hit')
  assert.equal(fake.singleCalls, 1)
  assert.equal(fake.burstCalls, 0)
})

/** A camera 1.5 m up, pitched 45 degrees down, and the point on a floor at y = 0 that its centre pixel meets. */
const DOWN_POSE: Pose = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: -Math.sin(Math.PI / 8), y: 0, z: 0, w: Math.cos(Math.PI / 8) } }
const RAY_POINT = floorRayPoint({ position: DOWN_POSE.position, rotation: DOWN_POSE.rotation, fovYDeg: 60, aspect: 0.5625 }, 0.5, 0.5, 0)!

test('the floor ray is a cross-check by default: the hits set the position and the ray\'s distance from them is reported', async () => {
  // Hits that slid 0.3 m along the ray from the true floor point, as a feature point near the ray can.
  const slid: Vec3 = { ...RAY_POINT.position, z: RAY_POINT.position.z - 0.3, y: 0.1 }
  const fake = fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(slid, 2.2), { pose: DOWN_POSE })), pose: DOWN_POSE })
  const sampler = calibrationTapSampler({ provider: fake.provider, ground: () => floorAt(0), search: '' })
  const tap = await sampler(0.5, 0.5)
  assert.ok(tap.ok)
  assert.ok(dist(tap.position, slid) < 1e-9, 'the hits are in charge')
  assert.equal(tap.source, 'burst')
  assert.ok(tap.floorRay && tap.floorRay.deltaM > 0.3 && tap.floorRay.agrees === false, `delta ${tap.floorRay?.deltaM}`)
  assert.ok(dist(tap.floorRay!.position, RAY_POINT.position) < 1e-9)
})

test('?tap=floor lets the floor ray set the position where the fit is reliable, and falls back to the hits where it is not', async () => {
  const slid: Vec3 = { ...RAY_POINT.position, z: RAY_POINT.position.z - 0.3, y: 0.1 }
  const fake = fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(slid, 2.2), { pose: DOWN_POSE })), pose: DOWN_POSE })
  const prefer = await calibrationTapSampler({ provider: fake.provider, ground: () => floorAt(0), search: '?tap=floor' })(0.5, 0.5)
  assert.ok(prefer.ok && prefer.source === 'floor-ray' && dist(prefer.position, RAY_POINT.position) < 1e-9)
  assert.ok(prefer.ok && prefer.hitPosition && Math.abs(prefer.hitPosition.y - 0.1) < 1e-9, 'what the hits measured is kept beside it')
  const unreliable = await calibrationTapSampler({
    provider: fake.provider,
    ground: () => ({ y: 0, locked: false, inlierCount: 400, residualM: 0.01 }),
    search: '?tap=floor',
  })(0.5, 0.5)
  assert.ok(unreliable.ok && unreliable.source === 'burst' && dist(unreliable.position, slid) < 1e-9)
})

test('the fitted floor is read fresh for every tap, unless the flow hands in the reading it took', async () => {
  const fake = fakeProvider({ frames: burstAt(TRUTH, 0.005, 14) })
  let reads = 0
  const sampler = calibrationTapSampler({ provider: fake.provider, ground: () => { reads += 1; return noFloor() }, search: '' })
  await sampler(0.5, 0.5)
  await sampler(0.5, 0.5)
  assert.equal(reads, 2)
  await sampler(0.5, 0.5, { floor: floorAt(-1.2) })
  await sampler(0.5, 0.5, { floor: null })
  assert.equal(reads, 2, 'a floor handed in, even a null one, is the floor: the sampler does not read another')
})

test('what the flow adds to a tap reaches the sampler: the spot a person insists on, the limits a probe lifts, and the listener for the ring', async () => {
  const scattered = burstAt(TRUTH, 0.05, 15)
  const sampler = calibrationTapSampler({ provider: fakeProvider({ frames: scattered }).provider, ground: noFloor, search: '' })
  const refused = await sampler(0.5, 0.5)
  assert.ok(!refused.ok && refused.reason === 'unsteady' && refused.position, 'refused for scatter, and says where')
  const insisted = await sampler(0.5, 0.5, { insist: { position: refused.position, spread: true } })
  assert.ok(insisted.ok && insisted.spreadM! > TAP_SPREAD_MAX_M && insisted.insisted?.[0] === 'spread', 'taken, with the scatter it really had, and said to have been let past')
  const seen: TapProgress[] = []
  const lifted = await sampler(0.5, 0.5, { spreadMaxM: Number.POSITIVE_INFINITY, onProgress: (p) => seen.push(p) })
  assert.ok(lifted.ok && lifted.spreadM! > TAP_SPREAD_MAX_M && lifted.insisted === undefined, 'a probe\'s lifted limit is not a person insisting')
  assert.equal(seen.length, 12, 'one progress report per frame of the burst')

  const far = fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(TRUTH, TAP_RANGE_MAX_M + 1))) })
  const farSampler = calibrationTapSampler({ provider: far.provider, ground: noFloor, search: '' })
  assert.deepEqual((await farSampler(0.5, 0.5)).ok === false, true)
  const nearEnough = await farSampler(0.5, 0.5, { rangeMaxM: Number.POSITIVE_INFINITY })
  assert.ok(nearEnough.ok && Math.abs(nearEnough.rangeM - (TAP_RANGE_MAX_M + 1)) < 1e-9)
})

// ─── The hold-still ring ───────────────────────────────────────────────────

const progress = (o: Partial<TapProgress> = {}): TapProgress => ({ elapsedMs: 0, windowMs: 450, frames: 0, hits: 0, spreadM: null, ...o })

test('ring: the fraction is how much of the window has passed, kept between 0 and 1', () => {
  assert.equal(holdRingFor(progress({ elapsedMs: 0 })).fraction, 0)
  assert.equal(holdRingFor(progress({ elapsedMs: 225 })).fraction, 0.5)
  assert.equal(holdRingFor(progress({ elapsedMs: 450 })).fraction, 1)
  assert.equal(holdRingFor(progress({ elapsedMs: 467 })).fraction, 1, 'a burst runs up to a frame past its window')
  assert.equal(holdRingFor(progress({ elapsedMs: -5 })).fraction, 0)
  assert.equal(holdRingFor(progress({ elapsedMs: 100, windowMs: 0 })).fraction, 1, 'a window of nothing is over')
  assert.equal(holdRingFor(progress({ elapsedMs: Number.NaN })).fraction, 0, 'no NaN reaches a stylesheet')
})

test('ring: steady until three hits scatter past the limit, and exactly the limit is still steady', () => {
  assert.equal(holdRingFor(progress({ hits: 2, spreadM: 0.5 })).steady, true, 'two hits say nothing about scatter')
  assert.equal(holdRingFor(progress({ hits: 3, spreadM: null })).steady, true, 'no scatter measured is not scatter')
  assert.equal(holdRingFor(progress({ hits: 3, spreadM: TAP_SPREAD_MAX_M })).steady, true)
  assert.equal(holdRingFor(progress({ hits: 3, spreadM: TAP_SPREAD_MAX_M + 1e-9 })).steady, false)
  assert.equal(holdRingFor(progress({ hits: 9, spreadM: Number.NaN })).steady, true)
})

test('ring: judged by the sampler\'s scatter limit unless a caller gives another', () => {
  assert.equal(holdRingFor(progress({ hits: 9, spreadM: 0.2 })).steady, false)
  assert.equal(holdRingFor(progress({ hits: 9, spreadM: 0.2 }), Number.POSITIVE_INFINITY).steady, true)
  assert.equal(holdRingFor(progress({ hits: 9, spreadM: 0.2 }), 0.1).steady, false)
})

test('ring: painted as a conic gradient filled to the fraction, with its state; hidden for null', () => {
  const target = ringTarget()
  paintHoldRing(target, { fraction: 0.5, steady: true })
  assert.equal(target.hidden, false)
  assert.equal(target.dataset['state'], 'steady')
  assert.match(target.style.background, /^conic-gradient\(var\(--hold-ring, #72ddd4\) 180deg, rgba\(114, 221, 212, 0\.18\) 0\)$/)
  paintHoldRing(target, { fraction: 1, steady: false })
  assert.equal(target.dataset['state'], 'unsteady')
  assert.match(target.style.background, / 360deg, /)
  paintHoldRing(target, null)
  assert.equal(target.hidden, true)
})

// ─── The reader ────────────────────────────────────────────────────────────

test('a tap is a point, and how high it measured, with nothing refused', async () => {
  const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.008, 21) }))
  const tapped = accepted(await read(flow))
  assert.ok(dist(tapped.position, TRUTH) < 0.01, `${dist(tapped.position, TRUTH)} m off`)
  assert.equal(tapped.surfaceY, tapped.position.y, 'under the default the hits set the position, so the position is how high it measured')
})

test('a stray hit is rejected and does not move the point', async () => {
  const frames = burstAt(TRUTH, 0.005, 22)
  frames[4] = frame(hit({ x: TRUTH.x + 0.4, y: TRUTH.y + 0.3, z: TRUTH.z - 0.5 }))
  const tapped = accepted(await read(sampledFlow(fakeProvider({ frames }))))
  assert.ok(dist(tapped.position, TRUTH) < 0.01)
})

test('the reading text is the old words without a sampler and asks for stillness with a burst', () => {
  assert.equal(flowOver(undefined).taps.readingText, READING_TEXT)
  assert.equal(READING_TEXT, 'Reading the surface…')
  assert.equal(sampledFlow(fakeProvider({ frames: [] })).taps.readingText, HOLD_STILL_READING_TEXT)
  assert.equal(flowOver(async () => ({ ok: false, reason: 'no-hit', n: 0 }) satisfies TapResult).taps.readingText, HOLD_STILL_READING_TEXT, 'a sampler that does not say is asked to be held still for')
})

test('one hit is not a burst, so nobody is asked to hold still for it: ?tap=single, and a provider with no burst', () => {
  const single = sampledFlow(fakeProvider({ frames: [] }), { search: '?tap=single' })
  assert.equal(single.taps.readingText, READING_TEXT)
  const noBurst = sampledFlow(fakeProvider({ burst: false, single: hit(TRUTH) }))
  assert.equal(noBurst.taps.readingText, READING_TEXT)
  assert.equal(calibrationTapSampler({ provider: fakeProvider({ frames: [] }).provider, ground: noFloor }).holdsStill, true)
  assert.equal(calibrationTapSampler({ provider: fakeProvider({ frames: [] }).provider, ground: noFloor, search: '?tap=floor' }).holdsStill, true)
})

test('with no sampler there is no reader, so the flow keeps reading a tap as it always did', () => {
  const flow = flowOver(undefined)
  assert.equal(flow.taps.read, undefined)
  assert.deepEqual(flow.taps.frameLandmark({ x: 1, y: 2, z: 3 }), { landmark: { x: 1, y: 2, z: 3 } })
})

const REFUSALS: Array<{ name: string; frames: HitBurstFrame[]; status?: string; text: string }> = [
  {
    name: 'tracking not stable at a frame of the burst',
    frames: burstAt(TRUTH, 0.005, 31).map((f, i) => (i === 6 ? { ...f, status: 'LIMITED' } : f)),
    text: TRACKING_RECOVERING_TEXT,
  },
  {
    name: 'no hit at all',
    frames: Array.from({ length: 12 }, () => frame(null)),
    text: 'No stable surface there. Aim at a textured floor and tap again.',
  },
  {
    name: 'fewer than three hits',
    frames: [frame(hit(TRUTH)), frame(hit(TRUTH)), ...Array.from({ length: 10 }, () => frame(null))],
    text: 'Too few readings of that spot. Hold still and tap again.',
  },
  {
    name: 'too far',
    frames: Array.from({ length: 12 }, () => frame(hit(TRUTH, 4.2))),
    text: `That spot is 4.2 m away. Move closer and tap again. ${TAP_USE_ANYWAY_TEXT}`,
  },
  {
    name: 'hits that scatter past the limit',
    frames: burstAt(TRUTH, 0.05, 32),
    text: `That spot did not read steadily. Hold still, or aim at a more textured spot. ${TAP_USE_ANYWAY_TEXT}`,
  },
  {
    // Seven identical hits and five 6 cm away: the seven are a bare majority, which the sampler refuses with no scatter to name.
    name: 'too many strays, with no scatter to name',
    frames: [
      ...Array.from({ length: 7 }, () => frame(hit(TRUTH))),
      ...Array.from({ length: 5 }, () => frame(hit({ ...TRUTH, x: TRUTH.x + 0.06 }))),
    ],
    text: 'That spot did not read steadily. Hold still, or aim at a more textured spot.',
  },
]

for (const refusal of REFUSALS) {
  test(`a refused tap says why, in the sampler's own words: ${refusal.name}`, async () => {
    const flow = sampledFlow(fakeProvider({ frames: refusal.frames }))
    assert.equal(refusedWith(await read(flow)), refusal.text)
    assert.equal(flow.taps.frameLandmark(TRUTH).tap, undefined, 'a refused tap is remembered as nothing')
  })
}

test('the words of a refusal are the sampler\'s, so a copy change there is a change here', () => {
  assert.equal(tapRefusalText({ ok: false, reason: 'no-hit', n: 0 }), 'No stable surface there. Aim at a textured floor and tap again.')
  assert.equal(TAP_USE_ANYWAY_TEXT, 'Or tap the same spot again to use it anyway.')
})

test('a tap is not started in a map that is not stable: the sentence at once, and the sampler is never asked', async () => {
  for (const [status, reason] of [['LIMITED', undefined], ['NOT_AVAILABLE', undefined], ['INITIALIZING', undefined], ['UNSPECIFIED', undefined], ['NORMAL', 'RELOCALIZING']] as const) {
    const flow = sampledFlow(
      fakeProvider({ frames: burstAt(TRUTH, 0.005, 33) }),
      { provider: { trackingStatus: () => status, getTrackingDiagnostics: () => ({ poseJumps: 0, reason }) } },
    )
    assert.equal(refusedWith(await read(flow)), TRACKING_RECOVERING_TEXT, `${status} / ${reason}`)
    assert.equal(flow.calls.length, 0, `${status} / ${reason}: no burst was started`)
    assert.equal(flow.ring.events.length, 0, 'and no ring was drawn')
  }
})

test('a runtime that publishes no status is not refused for it, and neither is one whose accessors throw', async () => {
  for (const provider of [
    {},
    { trackingStatus: () => 'UNKNOWN' },
    { trackingStatus: () => { throw new Error('no status') }, getTrackingDiagnostics: () => { throw new Error('no diagnostics') } },
  ] as TapFlowProvider[]) {
    const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.005, 34) }), { provider })
    accepted(await read(flow))
  }
})

test('a sampler that rejects rejects the read, which the flow turns into a tap that found nothing', async () => {
  const flow = flowOver(async () => { throw new Error('the burst failed') })
  await assert.rejects(read(flow), /the burst failed/)
  assert.equal(flow.ring.hidden, true, 'and the ring is not left on screen')
})

test('a floor that cannot be read is no floor, not a failed tap', async () => {
  const fake = fakeProvider({ frames: burstAt(TRUTH, 0.005, 35) })
  const flow = sampledFlow(fake, { ground: () => { throw new Error('no cloud yet') } })
  accepted(await read(flow))
})

// ─── Insisting on a spot ───────────────────────────────────────────────────

const FAR_FRAMES = Array.from({ length: 12 }, () => frame(hit(TRUTH, TAP_RANGE_MAX_M + 0.9)))

/** Twelve identical hits at `at`, `rangeM` away. */
const stillAt = (at: Vec3, rangeM: number): HitBurstFrame[] => Array.from({ length: 12 }, () => frame(hit(at, rangeM)))

/** A flow over a sampler whose frames the test changes between taps: the same spot, or another one, wherever the camera is. */
function steppedFlow(first: HitBurstFrame[], o: { provider?: TapFlowProvider } = {}) {
  let frames = first
  const sampler: CalibrationTapSampler = (x, y, extra) => sampleTap(fakeProvider({ frames }).provider, x, y, extra)
  const flow = flowOver(sampler, o)
  return { flow, set: (next: HitBurstFrame[]) => { frames = next } }
}

test('a spot refused for being too far is taken when the person taps it again, with the real range kept and the note on the card', async () => {
  const flow = sampledFlow(fakeProvider({ frames: FAR_FRAMES }))
  assert.match(refusedWith(await read(flow, 0.5, 0.6)), /That spot is 3\.9 m away\./)
  assert.equal(flow.note.hidden, true, 'nothing was used anyway yet')
  const again = accepted(await read(flow, 0.5, 0.6))
  assert.deepEqual(again.position, TRUTH)
  const kept = flow.taps.frameLandmark(TRUTH)
  assert.ok(kept.tap && Math.abs(kept.tap.tapRangeM - (TAP_RANGE_MAX_M + 0.9)) < 1e-9, 'the evidence says how far it really was')
  assert.equal(flow.note.hidden, false)
  assert.equal(flow.note.textContent, 'Used anyway: that spot is 3.90 m away, over the 3 m limit.')
  // It was one tap insisted on, not a new rule: the next tap at that spot is judged by the limit again, and the note is gone.
  assert.match(refusedWith(await read(flow, 0.5, 0.6)), /m away/)
  assert.equal(flow.note.hidden, true)
})

test('a spot refused for scatter is taken when the person taps it again, with the real scatter kept and said', async () => {
  const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.05, 41) }))
  assert.match(refusedWith(await read(flow, 0.4, 0.7)), /did not read steadily/)
  const again = accepted(await read(flow, 0.4, 0.7))
  assert.ok(dist(again.position, TRUTH) < 0.1)
  const kept = flow.taps.frameLandmark(again.position)
  assert.ok(kept.tap && kept.tap.tapSpreadM !== null && kept.tap.tapSpreadM > TAP_SPREAD_MAX_M, 'the evidence says it scattered')
  assert.match(flow.note.textContent!, /^Used anyway: its readings scattered \d+\.\d cm, over the 4 cm limit\.$/)
})

test('a second tap that is inside the limits is an ordinary one: nothing is lifted for it, and nothing is said to have been used anyway', async () => {
  const stepped = steppedFlow(burstAt(TRUTH, 0.05, 43))
  assert.match(refusedWith(await read(stepped.flow)), /did not read steadily/)
  stepped.set(burstAt(TRUTH, 0.003, 44))
  const again = accepted(await read(stepped.flow))
  assert.ok(dist(again.position, TRUTH) < 0.01)
  assert.equal(stepped.flow.note.hidden, true)
  const asked = stepped.flow.calls[1]![2]!
  assert.equal(asked.spreadMaxM, undefined, 'the flow lifts no limit itself')
  assert.equal(asked.rangeMaxM, undefined)
  assert.deepEqual(asked.insist?.spread, true, 'it says which spot it may let past, and the sampler does the judging')
  assert.ok(stepped.flow.taps.frameLandmark(again.position).tap!.tapSpreadM! < TAP_SPREAD_MAX_M, 'recorded as the tap it was')
})

test('the same spot is where the hits land, not where the finger was: another spot at the same pixel is refused, the same spot at another pixel is taken', async () => {
  // Another spot, as far away, aimed at the very pixel the refused tap was.
  const elsewhere = steppedFlow(FAR_FRAMES)
  assert.match(refusedWith(await read(elsewhere.flow, 0.5, 0.5)), /m away/)
  elsewhere.set(stillAt({ ...TRUTH, x: TRUTH.x + 1, z: TRUTH.z - 1 }, TAP_RANGE_MAX_M + 2))
  assert.match(refusedWith(await read(elsewhere.flow, 0.5, 0.5)), /That spot is 5\.0 m away\./, 'judged by the limit, with the numbers it had')
  assert.equal(elsewhere.flow.note.hidden, true)
  // The same spot, the camera now somewhere else, so the pixel is far from where it was.
  const same = steppedFlow(FAR_FRAMES)
  await read(same.flow, 0.2, 0.3)
  accepted(await read(same.flow, 0.85, 0.9))
  assert.match(same.flow.note.textContent!, /^Used anyway/)
})

test('how near is the same spot: within TAP_SAME_SPOT_M of where the refused tap landed in the map', async () => {
  assert.equal(TAP_SAME_SPOT_M, 0.1)
  const near = steppedFlow(FAR_FRAMES)
  await read(near.flow)
  near.set(stillAt({ ...TRUTH, x: TRUTH.x + TAP_SAME_SPOT_M - 0.01 }, TAP_RANGE_MAX_M + 0.9))
  accepted(await read(near.flow))
  const apart = steppedFlow(FAR_FRAMES)
  await read(apart.flow)
  apart.set(stillAt({ ...TRUTH, x: TRUTH.x + TAP_SAME_SPOT_M + 0.01 }, TAP_RANGE_MAX_M + 0.9))
  assert.match(refusedWith(await read(apart.flow)), /m away/)
})

test('a spot that is both too far and scattered takes two more taps: each limit is let past when it is the one that refused', async () => {
  const frames = burstAt({ x: 0.4, y: -1.2, z: -2.6 }, 0.05, 42).map((f) => ({ ...f, hit: f.hit && { ...f.hit, distance: 3.5 } }))
  const flow = sampledFlow(fakeProvider({ frames }))
  assert.match(refusedWith(await read(flow)), /m away/)
  assert.match(refusedWith(await read(flow)), /did not read steadily/, 'the range is let past, the scatter is next')
  accepted(await read(flow))
  assert.match(flow.note.textContent!, /^Used anyway: that spot is 3\.50 m away, over the 3 m limit, and its readings scattered \d+\.\d cm, over the 4 cm limit\.$/)
})

test('a limit refused at one spot is not carried to another: the second spot is refused for what it is', async () => {
  // Scattered and near at the first spot; far and scattered at a different one. What was refused at the first lifts nothing at the second.
  const stepped = steppedFlow(burstAt(TRUTH, 0.05, 45))
  assert.match(refusedWith(await read(stepped.flow)), /did not read steadily/)
  const second = { x: 1.4, y: -1.2, z: -2.6 }
  stepped.set(burstAt(second, 0.05, 46).map((f) => ({ ...f, hit: f.hit && { ...f.hit, distance: 3.6 } })))
  assert.match(refusedWith(await read(stepped.flow)), /m away/, 'refused for the range, at the other spot')
  // The scatter at the second spot has not been refused yet: the range is let past, and the scatter is judged.
  assert.match(refusedWith(await read(stepped.flow)), /did not read steadily/, 'the first spot\'s scatter was not insisted on here')
  accepted(await read(stepped.flow))
  // And back at the first spot it is refused for its range as it was the first time: only the last spot is remembered.
  const back = steppedFlow(FAR_FRAMES)
  await read(back.flow)
  back.set(burstAt({ x: 1.4, y: -1.2, z: -1.6 }, 0.05, 47))
  assert.match(refusedWith(await read(back.flow)), /did not read steadily/)
  back.set(FAR_FRAMES)
  assert.match(refusedWith(await read(back.flow)), /m away/)
})

test('a refusal that cannot be insisted on offers nothing and forgets any insisting', async () => {
  const stepped = steppedFlow(FAR_FRAMES)
  assert.match(refusedWith(await read(stepped.flow)), /m away/)
  // The map becomes unstable at a frame of the burst: refused for tracking, and the spot is no longer one a person may insist on.
  stepped.set(burstAt(TRUTH, 0.005, 43).map((f, i) => (i === 3 ? { ...f, status: 'LIMITED' } : f)))
  assert.equal(refusedWith(await read(stepped.flow)), TRACKING_RECOVERING_TEXT)
  stepped.set(FAR_FRAMES)
  assert.match(refusedWith(await read(stepped.flow)), /m away/, 'judged by the limit again')
})

test('a tap turned away at once for an unstable map forgets the spot too: a map that was not steady is not the same spot', async () => {
  let status = 'NORMAL'
  const stepped = steppedFlow(FAR_FRAMES, { provider: { trackingStatus: () => status } })
  await read(stepped.flow)
  status = 'LIMITED'
  assert.equal(refusedWith(await read(stepped.flow)), TRACKING_RECOVERING_TEXT)
  status = 'NORMAL'
  assert.match(refusedWith(await read(stepped.flow)), /m away/, 'not insisted on: the refusal before the map moved is forgotten')
})

test('the ring says what the hits show, for the tap that insists as for any: it warns while they scatter, and the tap is still taken', async () => {
  const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.05, 44) }))
  await read(flow)
  assert.ok(flow.ring.events.some((e) => e.key === 'state' && e.value === 'unsteady'), 'the first read warned, as it should')
  flow.ring.events.length = 0
  accepted(await read(flow))
  assert.ok(flow.ring.events.some((e) => e.key === 'state' && e.value === 'unsteady'), 'and so did the read that insists: the hits scattered')
  assert.equal(flow.ring.hidden, true)
})

test('the note is written for a tap used anyway, cleared when the next tap begins, and never for a tap inside the limits', async () => {
  const flow = sampledFlow(fakeProvider({ frames: FAR_FRAMES }))
  await read(flow)
  accepted(await read(flow))
  assert.equal(flow.note.hidden, false)
  flow.note.writes.length = 0
  await read(flow) // a new tap begins: the note goes before the tap is read
  assert.equal(flow.note.writes[0]!.hidden, true)
  assert.equal(flow.note.textContent, '')
  const plain = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.004, 46) }))
  accepted(await read(plain))
  assert.equal(plain.note.hidden, true)
  assert.equal(plain.note.textContent, '')
})

test('a note that cannot be written costs the tap nothing', async () => {
  for (const note of [() => null, () => { throw new Error('no element') }, () => ({ hidden: true, set textContent(_: string | null) { throw new Error('read only') }, get textContent() { return '' } })]) {
    const taps = createCalibrationTaps({
      sampler: calibrationTapSampler({ provider: fakeProvider({ frames: FAR_FRAMES }).provider, ground: noFloor }),
      provider: {},
      ground: noFloor,
      watching: () => true,
      note: note as () => NoteTarget | null,
    })
    await taps.read!(0.5, 0.5)
    assert.ok(!('refused' in (await taps.read!(0.5, 0.5))!), 'the tap used anyway is taken')
  }
})

test('the words of a tap used anyway: the range and the scatter it was let past, as they were measured, and nothing for a tap inside them', () => {
  const tap = (o: Partial<TapSample>): TapSample => ({ ok: true, position: TRUTH, rangeM: 2, spreadM: 0.01, n: 12, rejected: 0, source: 'burst', ...o })
  assert.equal(usedAnywayText(tap({})), null)
  assert.equal(usedAnywayText(tap({ rangeM: 3.04, insisted: ['range'] })), 'Used anyway: that spot is 3.04 m away, over the 3 m limit.')
  assert.equal(usedAnywayText(tap({ spreadM: 0.0512, insisted: ['spread'] })), 'Used anyway: its readings scattered 5.1 cm, over the 4 cm limit.')
  assert.equal(
    usedAnywayText(tap({ rangeM: 4.1, spreadM: 0.06, insisted: ['range', 'spread'] })),
    'Used anyway: that spot is 4.10 m away, over the 3 m limit, and its readings scattered 6.0 cm, over the 4 cm limit.',
  )
  assert.equal(usedAnywayText(tap({ spreadM: null, insisted: ['spread'] })), null, 'no scatter to name, so none is named')
  assert.equal(usedAnywayText(tap({ rangeM: 3.5 })), null, 'a range over the limit that nobody insisted on is not this note\'s to say')
})

// ─── The ring while a tap is read ──────────────────────────────────────────

test('the ring fills as frames arrive, warns when they scatter, and is hidden when the tap is done, taken or refused', async () => {
  const steady = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.003, 51) }))
  accepted(await read(steady))
  const fills = steady.ring.events.filter((e) => e.key === 'background').map((e) => e.value)
  assert.equal(fills.length, 12, 'painted for each frame')
  assert.ok(new Set(fills).size > 5, 'and it advanced')
  assert.ok(steady.ring.events.every((e) => !(e.key === 'state' && e.value === 'unsteady')))
  assert.equal(steady.ring.hidden, true)

  const shaky = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.05, 52) }))
  refusedWith(await read(shaky))
  assert.ok(shaky.ring.events.some((e) => e.key === 'state' && e.value === 'unsteady'), 'the ring took the warning state')
  assert.equal(shaky.ring.hidden, true, 'and is gone after a refusal')
})

test('a ring that cannot be drawn costs the tap nothing', async () => {
  for (const ring of [() => null, () => { throw new Error('no element') }, () => ({ get hidden() { return true }, set hidden(_: boolean | string) { throw new Error('read only') }, dataset: {}, style: { background: '' } })]) {
    const taps = createCalibrationTaps({
      sampler: calibrationTapSampler({ provider: fakeProvider({ frames: burstAt(TRUTH, 0.005, 53) }).provider, ground: noFloor }),
      provider: {},
      ground: noFloor,
      watching: () => true,
      ring: ring as () => HoldRingTarget | null,
    })
    accepted(await taps.read!(0.5, 0.5))
  }
})

// ─── What is kept of a tap, and handed back for the landmark ───────────────

test('the landmark comes back at the height its tap gave, with the evidence of how it was measured', async () => {
  const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.006, 61) }))
  const tapped = accepted(await read(flow))
  const { landmark, tap } = flow.taps.frameLandmark(tapped.position)
  assert.ok(landmark && tap)
  assert.equal(landmark.x, tapped.position.x)
  assert.equal(landmark.z, tapped.position.z)
  assert.equal(landmark.y, tapped.position.y, 'no reliable fitted floor: the tap alone is the datum')
  assert.equal(tap.tapSource, 'burst')
  assert.ok(tap.tapSpreadM !== null && tap.tapSpreadM > 0 && tap.tapSpreadM < TAP_SPREAD_MAX_M)
  assert.ok(Math.abs(tap.tapRangeM - TRUTH_RANGE_M) < 1e-9)
  assert.equal(tap.landmarkAboveFloorM, null, 'with no reliable fit nothing is claimed about its height above the floor')
})

test('a reliable fitted floor that agrees within 5 cm sets the floor height with the tap, and the gap is recorded', async () => {
  const tapped = { ...TRUTH, y: -1.17 }
  const flow = sampledFlow(fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(tapped))) }), { ground: () => floorAt(-1.2) })
  const point = accepted(await read(flow))
  const { landmark, tap } = flow.taps.frameLandmark(point.position)
  assert.ok(Math.abs(landmark!.y - -1.185) < 1e-12, 'the mean of the tap and the fit')
  assert.ok(Math.abs(tap!.landmarkAboveFloorM! - 0.03) < 1e-12)
})

test('a tap that disagrees with a reliable floor by more than 5 cm stands alone, and the gap is still recorded', async () => {
  const tapped = { ...TRUTH, y: -1.2 + FLOOR_DATUM_AGREE_M + 0.07 }
  const flow = sampledFlow(fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(tapped))) }), { ground: () => floorAt(-1.2) })
  const point = accepted(await read(flow))
  const { landmark, tap } = flow.taps.frameLandmark(point.position)
  assert.equal(landmark!.y, tapped.y)
  assert.ok(Math.abs(tap!.landmarkAboveFloorM! - (FLOOR_DATUM_AGREE_M + 0.07)) < 1e-12)
})

test('the floor reading of the datum is the one the floor ray used, taken once before the burst', async () => {
  let reads = 0
  const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.003, 62) }), { ground: () => { reads += 1; return floorAt(-1.2) } })
  accepted(await read(flow))
  assert.equal(reads, 1)
  assert.equal(flow.calls[0]![2]?.floor?.y, -1.2)
})

test('a tap the floor ray placed gives its datum from what the hits measured, never from the floor the ray was cast to', async () => {
  const slid: Vec3 = { ...RAY_POINT.position, z: RAY_POINT.position.z - 0.3, y: 0.12 }
  const fake = fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(slid, 2.2), { pose: DOWN_POSE })), pose: DOWN_POSE })
  const flow = sampledFlow(fake, { ground: () => floorAt(0), search: '?tap=floor' })
  const point = accepted(await read(flow, 0.5, 0.5))
  assert.ok(dist(point.position, RAY_POINT.position) < 1e-9, 'the ray set the position')
  assert.ok(Math.abs(point.surfaceY! - 0.12) < 1e-9, 'the floor gate is told what the hits measured')
  const { landmark, tap } = flow.taps.frameLandmark(point.position)
  assert.ok(Math.abs(landmark!.y - 0.12) < 1e-9, 'the landmark is 12 cm up, not on the floor the ray was cast to')
  assert.equal(tap!.tapSource, 'floor-ray')
  assert.ok(Math.abs(tap!.landmarkAboveFloorM! - 0.12) < 1e-9)
})

test('a landmark no accepted tap placed, or none at all, comes back as it is', async () => {
  const flow = sampledFlow(fakeProvider({ frames: burstAt(TRUTH, 0.004, 63) }))
  accepted(await read(flow))
  assert.deepEqual(flow.taps.frameLandmark({ x: 9, y: 9, z: 9 }), { landmark: { x: 9, y: 9, z: 9 } })
  assert.deepEqual(flow.taps.frameLandmark(null), { landmark: null })
})

test('a landmark that was moved is the point of the last tap that placed it, and its evidence is that tap\'s', async () => {
  let at: Vec3 = TRUTH
  let sigma = 0.002
  const sampler: CalibrationTapSampler = (x, y, extra) => sampleTap(fakeProvider({ frames: burstAt(at, sigma, Math.round(at.x * 1000) + 7) }).provider, x, y, extra)
  const flow = flowOver(sampler)
  const first = accepted(await read(flow))
  at = { x: TRUTH.x + 0.5, y: TRUTH.y, z: TRUTH.z }
  sigma = 0.02
  const second = accepted(await read(flow))
  const one = flow.taps.frameLandmark(first.position).tap!
  const two = flow.taps.frameLandmark(second.position).tap!
  assert.ok(one.tapSpreadM! < 0.01 && two.tapSpreadM! > 0.01, 'each point has the scatter of its own tap')
})

test('only the last few taps are remembered, and the newest are the ones kept', async () => {
  let n = 0
  const sampler: CalibrationTapSampler = (x, y, extra) =>
    sampleTap(fakeProvider({ frames: burstAt({ x: n, y: TRUTH.y, z: TRUTH.z }, 0.002, 70 + n++) }).provider, x, y, extra)
  const flow = flowOver(sampler)
  const points: Vec3[] = []
  for (let i = 0; i < 40; i++) points.push(accepted(await read(flow)).position)
  assert.equal(flow.taps.frameLandmark(points[0]!).tap, undefined, 'the first of forty is forgotten')
  assert.ok(flow.taps.frameLandmark(points[39]!).tap, 'the last is not')
  assert.ok(flow.taps.frameLandmark(points[8]!).tap, 'the thirty-second from the end is')
})

// ─── Watching the landmark ─────────────────────────────────────────────────

/** A provider whose counters the test moves, as 8th Wall's and WebXR's diagnostics do. */
function movingProvider() {
  const counters = { poseJumps: 0, epoch: 0 }
  return { counters, provider: { trackingStatus: () => 'NORMAL', getTrackingDiagnostics: () => ({ ...counters }) } satisfies TapFlowProvider }
}

test('nothing is disturbed before a landmark is confirmed, whatever the counters do', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  m.counters.poseJumps += 3
  assert.equal(flow.taps.isDisturbed(), false)
})

test('a frame shift between the landmark and the commit disturbs it, and says so in the words the flow has for it', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkConfirmed()
  assert.equal(flow.taps.isDisturbed(), false, 'a calm walk')
  m.counters.poseJumps += 1
  assert.equal(flow.taps.isDisturbed(), true)
  assert.equal(flow.taps.disturbedText(), 'Tracking was disturbed, tap the landmark again')
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('pose-jump'))
})

test('a new frame epoch disturbs it too', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkConfirmed()
  m.counters.epoch += 1
  assert.equal(flow.taps.isDisturbed(), true)
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('epoch-changed'))
})

test('a shift that happened before the landmark was confirmed does not', () => {
  const m = movingProvider()
  m.counters.poseJumps = 4
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkConfirmed()
  assert.equal(flow.taps.isDisturbed(), false)
})

test('the 90 seconds are counted from the confirmation on the flow\'s clock: exactly 90 is inside, a millisecond more is not', () => {
  assert.equal(LANDMARK_TO_COMMIT_BUDGET_MS, 90_000)
  const flow = flowOver(undefined, { provider: {} })
  flow.taps.landmarkConfirmed()
  flow.clock.now += 89_999
  assert.equal(flow.taps.isDisturbed(), false)
  flow.clock.now += 1
  assert.equal(flow.taps.isDisturbed(), false, 'exactly the budget')
  flow.clock.now += 1
  assert.equal(flow.taps.isDisturbed(), true)
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('too-long'))
  assert.match(flow.taps.disturbedText(), /90 seconds/)
})

test('a provider that keeps no counters is watched by the clock alone, and one whose diagnostics throw is no evidence', () => {
  for (const provider of [{}, { getTrackingDiagnostics: () => { throw new Error('boom') } }, { getTrackingDiagnostics: () => undefined }] as TapFlowProvider[]) {
    const flow = flowOver(undefined, { provider })
    flow.taps.landmarkConfirmed()
    assert.equal(flow.taps.isDisturbed(), false)
    flow.clock.now += LANDMARK_TO_COMMIT_BUDGET_MS + 1
    assert.equal(flow.taps.isDisturbed(), true)
  }
})

test('it is only asked about while a commit is waiting: the landmark stage, and a flow that went back to it, are not watched', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider, watching: true })
  flow.taps.landmarkConfirmed()
  m.counters.poseJumps += 1
  flow.setWatching(false)
  assert.equal(flow.taps.isDisturbed(), false, 'back at the landmark stage the old watch says nothing')
  flow.setWatching(true)
  assert.equal(flow.taps.isDisturbed(), true)
})

test('confirming the landmark again starts a new watch: the counters and the clock are taken afresh', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkConfirmed()
  m.counters.poseJumps += 2
  flow.clock.now += LANDMARK_TO_COMMIT_BUDGET_MS + 5_000
  assert.equal(flow.taps.isDisturbed(), true)
  flow.taps.landmarkConfirmed()
  assert.equal(flow.taps.isDisturbed(), false, 'a new frame and a new 90 seconds')
  m.counters.epoch += 1
  assert.equal(flow.taps.isDisturbed(), true)
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('epoch-changed'), 'and the reason is the new one')
})

test('the clock the flow uses by default is Date.now, read when it is asked, so a fake clock is the one used', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 })
  const taps = createCalibrationTaps({ provider: {}, ground: noFloor, watching: () => true })
  taps.landmarkConfirmed()
  t.mock.timers.tick(LANDMARK_TO_COMMIT_BUDGET_MS)
  assert.equal(taps.isDisturbed(), false)
  t.mock.timers.tick(1)
  assert.equal(taps.isDisturbed(), true)
})

test('the text before any check has run is the shift sentence, not a crash', () => {
  const flow = flowOver(undefined)
  assert.equal(flow.taps.disturbedText(), 'Tracking was disturbed, tap the landmark again')
})

test('the shifts are watched from the tap that placed the landmark, and the clock only from its confirmation', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkPlaced()
  flow.clock.now += LANDMARK_TO_COMMIT_BUDGET_MS * 5 // a long wait over a label: nobody has begun the walk
  assert.equal(flow.taps.isDisturbed(), false, 'the clock has not started')
  m.counters.poseJumps += 1
  assert.equal(flow.taps.isDisturbed(), true, 'a shift since the tap is seen')
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('pose-jump'))
  // Placing it again is a new frame to watch: what happened before is the old landmark's.
  flow.taps.landmarkPlaced()
  assert.equal(flow.taps.isDisturbed(), false)
  m.counters.epoch += 1
  assert.equal(flow.taps.isDisturbed(), true)
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('epoch-changed'))
})

test('confirming starts the clock and the counters over: what happened between the tap and the confirmation is not the walk\'s', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkPlaced()
  flow.clock.now += 200_000
  assert.equal(flow.taps.isDisturbed(), false)
  flow.taps.landmarkConfirmed()
  flow.clock.now += LANDMARK_TO_COMMIT_BUDGET_MS
  assert.equal(flow.taps.isDisturbed(), false, 'a full 90 seconds from the confirmation')
  flow.clock.now += 1
  assert.equal(flow.taps.isDisturbed(), true)
})

test('shifted() is isDisturbed() without the clock: a late commit is not a shifted one, a moved map is', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  flow.taps.landmarkConfirmed()
  flow.clock.now += LANDMARK_TO_COMMIT_BUDGET_MS + 1
  assert.equal(flow.taps.isDisturbed(), true)
  assert.equal(flow.taps.shifted(), false, 'too long is not a shift')
  m.counters.poseJumps += 1
  assert.equal(flow.taps.shifted(), true)
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('pose-jump'), 'and says what it is')
  m.counters.epoch += 1
  assert.equal(flow.taps.shifted(), true)
  assert.equal(flow.taps.disturbedText(), placementDisturbedText('epoch-changed'))
})

test('shifted() is as quiet as isDisturbed() where nothing is being watched: before a landmark, and outside the stages that wait', () => {
  const m = movingProvider()
  const flow = flowOver(undefined, { provider: m.provider })
  m.counters.poseJumps += 1
  assert.equal(flow.taps.shifted(), false, 'no landmark yet')
  flow.taps.landmarkConfirmed()
  m.counters.poseJumps += 1
  flow.setWatching(false)
  assert.equal(flow.taps.shifted(), false)
  flow.setWatching(true)
  assert.equal(flow.taps.shifted(), true)
})

// ─── Whether the map is steady now ─────────────────────────────────────────

test('the map is steady only for a positive NORMAL, or a runtime that publishes nothing, and a bad reason spoils either', () => {
  const steady = (provider: TapFlowProvider) => flowOver(undefined, { provider }).taps.stable()
  assert.equal(steady({ trackingStatus: () => 'NORMAL' }), true)
  assert.equal(steady({}), true)
  assert.equal(steady({ trackingStatus: () => 'UNKNOWN' }), true)
  for (const status of ['LIMITED', 'NOT_AVAILABLE', 'INITIALIZING', 'UNSPECIFIED']) {
    assert.equal(steady({ trackingStatus: () => status }), false, status)
  }
  assert.equal(steady({ trackingStatus: () => 'NORMAL', getTrackingDiagnostics: () => ({ poseJumps: 0, reason: 'RELOCALIZING' }) }), false)
  assert.equal(steady({ trackingStatus: () => { throw new Error('no status') } }), true, 'an accessor that throws says nothing')
  assert.equal(flowOver(undefined).taps.unstableText, TRACKING_RECOVERING_TEXT)
})

test('the steadiness is read at the moment it is asked, so a map that settles is steady at the next press', () => {
  let status = 'LIMITED'
  const flow = flowOver(undefined, { provider: { trackingStatus: () => status } })
  assert.equal(flow.taps.stable(), false)
  status = 'NORMAL'
  assert.equal(flow.taps.stable(), true)
})

// ─── How high a point measured, against the landmark ───────────────────────

test('the heights of two points are what the hits measured where taps are remembered, and the points\' own where they are not', async () => {
  const heights = [-0.02, 0.2]
  let n = 0
  const sampler: CalibrationTapSampler = async (x) => {
    const hitY = heights[n++]!
    return { ok: true, source: 'floor-ray', n: 12, rejected: 0, spreadM: 0.004, rangeM: 2, position: { x, y: 0, z: -1 }, hitPosition: { x, y: hitY, z: -1 } } satisfies TapSample
  }
  const flow = flowOver(sampler)
  const landmark = accepted(await read(flow, 0.1, 0.5))
  const heading = accepted(await read(flow, 0.9, 0.5))
  assert.equal(landmark.position.y, heading.position.y, 'the floor ray put both on the fitted floor')
  assert.ok(Math.abs(flow.taps.heightAboveLandmarkM(landmark.position, heading.position) - 0.22) < 1e-12, 'but the hits say 22 cm')
  // A point no tap placed is its own height, as it always was.
  assert.equal(flow.taps.heightAboveLandmarkM({ x: 5, y: 1, z: 5 }, { x: 6, y: 1.4, z: 6 }), 1.4 - 1)
  assert.ok(Math.abs(flow.taps.heightAboveLandmarkM({ x: 5, y: 1, z: 5 }, heading.position) - (0.2 - 1)) < 1e-12, 'one of each')
  assert.equal(flow.taps.heightAboveLandmarkM(null, heading.position), 0, 'with no landmark there is nothing to disagree with')
})

test('with no sampler the heights are the points\' own, so the warning between the markers is the number it always was', () => {
  const flow = flowOver(undefined)
  assert.ok(Math.abs(flow.taps.heightAboveLandmarkM({ x: 0, y: -0.03, z: 0 }, { x: 1, y: 0.2, z: 1 }) - 0.23) < 1e-12)
})

// ─── The probe's view of a tap ─────────────────────────────────────────────

function ok(result: TapResult) {
  assert.ok(result.ok, JSON.stringify(result))
  return result
}

test('a tap the probe read is a hit at the range the sampler measured, with what was found out about it', async () => {
  const fake = fakeProvider({ frames: burstAt(TRUTH, 0.006, 81) })
  const answer = probeAnswerOf(ok(await calibrationTapSampler({ provider: fake.provider, ground: noFloor })(0.5, 0.5)))
  assert.ok(answer.hit && dist(answer.hit.position, TRUTH) < 0.01)
  assert.ok(Math.abs(answer.hit!.distance - TRUTH_RANGE_M) < 1e-9)
  assert.equal(answer.sample.kept, 12)
  assert.equal(answer.sample.source, 'burst')
  assert.ok(answer.sample.spreadM !== null && answer.sample.spreadM > 0)
  assert.equal(answer.sample.floorRayDeltaM, null, 'no reliable floor, no ray')
  assert.equal(answer.sample.refused, null)
})

test('a tap read with one hit has one kept and no scatter; a tap the floor ray placed alone has none kept', async () => {
  const single = await calibrationTapSampler({ provider: fakeProvider({ single: hit(TRUTH) }).provider, ground: noFloor, search: '?tap=single' })(0.5, 0.5)
  assert.deepEqual([probeAnswerOf(single).sample.kept, probeAnswerOf(single).sample.source, probeAnswerOf(single).sample.spreadM], [1, 'single-hit', null])
  const rayOnly = await sampleTap(
    fakeProvider({ frames: Array.from({ length: 12 }, () => frame(null, { pose: DOWN_POSE })), pose: DOWN_POSE }).provider,
    0.5,
    0.5,
    { floor: floorAt(0), floorRay: 'fallback' },
  )
  const answer = probeAnswerOf(ok(rayOnly))
  assert.deepEqual([answer.sample.kept, answer.sample.source], [0, 'floor-ray'])
})

test('the floor ray\'s distance from the hits is passed on when there was one', async () => {
  const slid: Vec3 = { ...RAY_POINT.position, z: RAY_POINT.position.z - 0.3, y: 0.1 }
  const fake = fakeProvider({ frames: Array.from({ length: 12 }, () => frame(hit(slid, 2.2), { pose: DOWN_POSE })), pose: DOWN_POSE })
  const answer = probeAnswerOf(ok(await calibrationTapSampler({ provider: fake.provider, ground: () => floorAt(0) })(0.5, 0.5)))
  assert.ok(answer.sample.floorRayDeltaM !== null && answer.sample.floorRayDeltaM > 0.3)
})

test('a tap the sampler could place no point for has no hit, and says why, with the range or the scatter where there was one', async () => {
  const far = probeAnswerOf(await calibrationTapSampler({ provider: fakeProvider({ frames: FAR_FRAMES }).provider, ground: noFloor })(0.5, 0.5))
  assert.equal(far.hit, null)
  assert.deepEqual([far.sample.refused, far.sample.kept, far.sample.source], ['too-far', 12, null])
  assert.ok(Math.abs(far.sample.rangeM! - (TAP_RANGE_MAX_M + 0.9)) < 1e-9)
  const shaky = probeAnswerOf(await calibrationTapSampler({ provider: fakeProvider({ frames: burstAt(TRUTH, 0.05, 82) }).provider, ground: noFloor })(0.5, 0.5))
  assert.equal(shaky.sample.refused, 'unsteady')
  assert.ok(shaky.sample.spreadM! > TAP_SPREAD_MAX_M)
  const none = probeAnswerOf(await calibrationTapSampler({ provider: fakeProvider({ frames: [frame(null), frame(null)] }).provider, ground: noFloor })(0.5, 0.5))
  assert.deepEqual([none.hit, none.sample.refused, none.sample.kept, none.sample.spreadM, none.sample.rangeM], [null, 'no-hit', 0, null, null])
})

// ─── The probe reads with the limits lifted ────────────────────────────────

/** The sampler the host builds, recording what each read was asked. */
function recorded(frames: HitBurstFrame[], search = '') {
  const asked: Array<Parameters<CalibrationTapSampler>[2]> = []
  const inner = calibrationTapSampler({ provider: fakeProvider({ frames, single: hit(TRUTH, frames[0]?.hit?.distance ?? 2) }).provider, ground: noFloor, search })
  const sampler: CalibrationTapSampler = (x, y, extra) => {
    asked.push(extra)
    return inner(x, y, extra)
  }
  return { sampler, asked }
}

test('a probe tap beyond the range keeps its point and its range, and says the calibration would have refused it for being too far', async () => {
  const { sampler, asked } = recorded(FAR_FRAMES)
  const answer = await probeTapReader(sampler)(0.5, 0.5)
  assert.ok(answer.hit && dist(answer.hit.position, TRUTH) < 1e-9, 'where it landed is logged')
  assert.ok(Math.abs(answer.hit!.distance - (TAP_RANGE_MAX_M + 0.9)) < 1e-9, 'and how far away')
  assert.equal(answer.sample.refused, 'too-far')
  assert.equal(answer.sample.source, 'burst')
  assert.deepEqual([asked[0]?.spreadMaxM, asked[0]?.rangeMaxM], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])
  assert.equal(asked[0]?.insist, undefined, 'a probe is not a person insisting')
})

test('a probe tap that scatters keeps its point and its scatter, and says it was unsteady; one that does both says the range first', async () => {
  const shaky = await probeTapReader(recorded(burstAt(TRUTH, 0.05, 91).map((f) => f)).sampler)(0.5, 0.5)
  assert.ok(shaky.hit && dist(shaky.hit.position, TRUTH) < 0.1)
  assert.equal(shaky.sample.refused, 'unsteady')
  assert.ok(shaky.sample.spreadM! > TAP_SPREAD_MAX_M)
  const both = await probeTapReader(recorded(burstAt(TRUTH, 0.05, 92).map((f) => ({ ...f, hit: f.hit && { ...f.hit, distance: 5 } }))).sampler)(0.5, 0.5)
  assert.equal(both.sample.refused, 'too-far')
  assert.ok(both.hit && both.sample.spreadM! > TAP_SPREAD_MAX_M)
})

test('a probe tap inside both limits says nothing was wrong with it', async () => {
  const answer = await probeTapReader(recorded(burstAt(TRUTH, 0.004, 93)).sampler)(0.5, 0.5)
  assert.ok(answer.hit)
  assert.equal(answer.sample.refused, null)
})

test('a probe tap the sampler can place no point for is still refused with the reason, whatever is lifted', async () => {
  const limited = await probeTapReader(recorded(burstAt(TRUTH, 0.004, 94).map((f, i) => (i === 5 ? { ...f, status: 'LIMITED' } : f))).sampler)(0.5, 0.5)
  assert.equal(limited.hit, null)
  assert.equal(limited.sample.refused, 'tracking')
  const none = await probeTapReader(recorded(Array.from({ length: 12 }, () => frame(null))).sampler)(0.5, 0.5)
  assert.deepEqual([none.hit, none.sample.refused], [null, 'no-hit'])
})

test('the single-hit arm reads far taps too: one hit beyond the range keeps its point, flagged', async () => {
  const { sampler } = recorded(FAR_FRAMES, '?tap=single')
  const answer = await probeTapReader(sampler)(0.5, 0.5)
  assert.ok(answer.hit && answer.hit.distance > TAP_RANGE_MAX_M)
  assert.deepEqual([answer.sample.refused, answer.sample.source, answer.sample.kept, answer.sample.spreadM], ['too-far', 'single-hit', 1, null])
})

test('which limit a tap that was read with them lifted would have been refused for, the limits themselves still inside', () => {
  const tap = (o: Partial<TapSample>): TapSample => ({ ok: true, position: TRUTH, rangeM: 2, spreadM: 0.01, n: 12, rejected: 0, source: 'burst', ...o })
  assert.equal(limitRefusal(tap({})), null)
  assert.equal(limitRefusal(tap({ rangeM: TAP_RANGE_MAX_M })), null, 'exactly the range')
  assert.equal(limitRefusal(tap({ rangeM: TAP_RANGE_MAX_M + 1e-9 })), 'too-far')
  assert.equal(limitRefusal(tap({ spreadM: TAP_SPREAD_MAX_M })), null, 'exactly the scatter')
  assert.equal(limitRefusal(tap({ spreadM: TAP_SPREAD_MAX_M + 1e-9 })), 'unsteady')
  assert.equal(limitRefusal(tap({ spreadM: null })), null, 'one hit has no scatter to refuse')
  assert.equal(limitRefusal(tap({ rangeM: 4, spreadM: 0.09 })), 'too-far', 'the range first, as the sampler checks it')
})
