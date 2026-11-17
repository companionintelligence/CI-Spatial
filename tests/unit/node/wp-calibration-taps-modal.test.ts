/**
 * WP-05b: the calibration modal reading its taps as bursts, and going back to the landmark when the map moved
 * (src/ar/project-calibration.ts, through src/ar/calibration-taps.ts).
 *
 * wp-calibration-taps.test.ts holds the pieces. This file holds the modal to what it does with them, run for real
 * against a stand-in document and a fake provider that returns noisy hits frame by frame:
 *
 *  - a tap is a burst: the median within a centimetre of where the burst scattered about, one stray rejected, and the
 *    calibration that comes out carries the tap's evidence (`ScanCalibration.tap`) and is built on the floor height
 *    the landmark's tap gave (`landmarkDatum`);
 *  - a refused tap says why on the card, in the sampler's own words, places nothing, and the spot that was refused can
 *    be insisted on by tapping it again (judged by where the hits land, not by the finger, and said on the card when it
 *    is used anyway); a tap in a map that is not stable is turned away at once; a tap on a marker already placed only
 *    selects it, at any range;
 *  - the hold-still ring is shown while a burst runs and gone when it is done;
 *  - the floor gate is judged by how high the hits measured, not by where a floor-ray tap was put;
 *  - a frame shift or a new epoch between tapping the landmark and the commit, or 90 seconds between confirming it and
 *    the commit (read on a fake clock), sends the flow back to the landmark with the reason, on a first visit and on a
 *    return visit (where the stored reference photo shows again), at the confirmation, at the heading tap, at the
 *    commit, during the photo wait, from the mismatch screen and from the one-point button, and a pass made afterwards
 *    commits; the 90 seconds are not counted against a commit pressed in time, nor against the one-point tier;
 *  - a map that is not steady turns the confirmation and every way of committing away with the sentence;
 *  - what a read that is still running does when the flow moves on without it: nothing, wherever the person went (the
 *    modal closed, the points cleared, the landmark confirmed), and no tap is taken while a commit waits for its photos;
 *  - the one-point tier is as it was: the same records with and without the sampler, and no evidence on it.
 *
 * The modal is a DOM module whose imports carry no `.ts` extension, which Node's loader does not resolve, so the file
 * registers a resolve hook that supplies it, and loads the modal after that. Time is the mock timer's, so the 200 ms
 * poll and the clock the 90 seconds are counted on move when the test says and not before.
 *
 * What it does not do: draw anything (the provider has no scene) or run the AR runtime. The Playwright spec
 * tests/mock-two-point-calibration.spec.ts drives the same flow in a browser against the scripted XR8 mock.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-taps-modal.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { CalibrationTapSampler } from '../../../src/ar/calibration-taps.ts'
import { LANDMARK_TO_COMMIT_BUDGET_MS, TRACKING_RECOVERING_TEXT, placementDisturbedText } from '../../../src/ar/tracking-quality.ts'
import { TAP_RANGE_MAX_M, TAP_SPREAD_MAX_M, type TapProgress, type TapProvider, type TapResult, type TapSample } from '../../../src/ar/tap-sampling.ts'
import type { GroundReading } from '../../../src/ar/ground-gate.ts'
import type { HitBurstFrame } from '../../../src/ar/provider.ts'
import { twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { Project, ProjectSpatialFrame, Vec3 } from '../../../src/world/types.ts'

// The modal's imports are written for the bundler (`'../world/geo'`). Node needs the extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
      if (missing && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const { runProjectCalibration } = await import('../../../src/ar/project-calibration.ts')
const { calibrationTapSampler } = await import('../../../src/ar/calibration-taps.ts')

// ── A stand-in for the document ────────────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void

class FakeElement {
  id = ''
  hidden = false
  disabled = false
  textContent = ''
  className = ''
  value = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  listeners = new Map<string, Listener[]>()
  items: FakeElement[] = []
  readonly classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  removeEventListener(type: string, fn: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((each) => each !== fn)) }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({}) }
  appendChild(node: FakeElement): FakeElement { return node }
  remove(): void {}
  querySelectorAll(_selector: string): FakeElement[] { return this.items }
}

/** The section the modal builds. Its `innerHTML` is read once, for the elements that carry an id. */
class FakeSection extends FakeElement {
  byId = new Map<string, FakeElement>()
  steps: FakeElement[] = []
  set innerHTML(markup: string) {
    this.byId.clear()
    this.steps = []
    for (const [, , attributes, text] of markup.matchAll(/<(\w+)([^>]*)>([^<]*)/g)) {
      const element = new FakeElement()
      element.id = /\sid="([^"]+)"/.exec(attributes!)?.[1] ?? ''
      element.hidden = /\shidden(?=\s|$)/.test(attributes!)
      element.textContent = text!.replace(/\s+/g, ' ').trim()
      const step = /data-step="([^"]+)"/.exec(attributes!)?.[1]
      if (step) { element.dataset['step'] = step; this.steps.push(element) }
      if (element.id) this.byId.set(element.id, element)
    }
    const list = this.byId.get('project-calibration-steps')
    if (list) list.items = this.steps
  }
  querySelector(selector: string): FakeElement | null { return this.byId.get(selector.replace(/^#/, '')) ?? null }
}

// ── A Place, a provider that returns noisy hits, and a canvas ──────────────────────────────────────

const stored = (frame: Record<string, unknown>): ProjectSpatialFrame =>
  ({ version: 1, createdAt: '2026-11-01T00:00:00.000Z', ...frame }) as ProjectSpatialFrame

const TWO_POINT_2_4 = stored({
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 2.4 },
  separationM: 2.4,
  toleranceM: 0.15,
  anchorBearingDeg: 12,
  referencePhotos: {
    landmark: { url: '/projects/place-1/reference-photos/ref-landmark.jpg', localKey: 'place-1:landmark', tapPoint: { x: 0.4, y: 0.7 }, capturedAt: '2026-11-01T00:00:00.000Z' },
    headingMarker: { url: '/projects/place-1/reference-photos/ref-headingMarker.jpg', localKey: 'place-1:headingMarker', tapPoint: { x: 0.6, y: 0.7 }, capturedAt: '2026-11-01T00:00:00.000Z' },
  },
})

const placeWith = (spatialFrame: ProjectSpatialFrame | undefined): Project =>
  ({ projectId: 'place-1', name: 'Kitchen', ...(spatialFrame ? { spatialFrame } : {}) }) as unknown as Project

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

const gaussian = (rand: () => number): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

/** The height of the floor the tapped points sit on, metres below where the session began. A tap lands 3 cm under the fit. */
const TAP_Y = -0.03
const POSE = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

/** The point a tap at normalised canvas (x, y) means: 4 m across and 3 m deep, as the other modal tests map it. */
const worldAt = (x: number, y: number): Vec3 => ({ x: (x - 0.5) * 4, y: TAP_Y, z: -y * 3 })

/** A fitted floor the datum may rely on: locked, well supported, level, at the height of the session's floor. */
const RELIABLE_FLOOR: GroundReading = { y: 0, locked: true, inlierCount: 300, residualM: 0.01 }

interface World {
  /** Per-axis scatter of every hit of a burst, metres. */
  sigma: number
  /** The hits' distance from the camera, as the runtime reports it. */
  rangeM: number
  /** Which burst this is, so the noise of one tap is not that of the next. */
  taps: number
  /** One frame in this many has no hit. */
  gap: number
  /** A hit the burst's `index`-th frame carries instead of the scattered one (a stray). */
  strayAt: number | null
  /** Moves where every pixel looks: the camera turned, or the person walked, so a pixel means another spot. */
  shift: Vec3
}

/** The spot a tap at normalised canvas (x, y) means now. */
const truthOf = (world: World, x: number, y: number): Vec3 => {
  const at = worldAt(x, y)
  return { x: at.x + world.shift.x, y: at.y + world.shift.y, z: at.z + world.shift.z }
}

function burstFrames(world: World, x: number, y: number, count = 12): HitBurstFrame[] {
  const rand = rng(1000 + world.taps)
  const truth = truthOf(world, x, y)
  return Array.from({ length: count }, (_, i) => {
    if (world.gap > 0 && i % world.gap === world.gap - 1) return { hit: null, pose: POSE, status: 'NORMAL' }
    const at = i === world.strayAt
      ? { x: truth.x + 0.5, y: truth.y + 0.3, z: truth.z - 0.4 }
      : { x: truth.x + world.sigma * gaussian(rand), y: truth.y + world.sigma * gaussian(rand), z: truth.z + world.sigma * gaussian(rand) }
    return { hit: { position: at, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: world.rangeM }, pose: POSE, status: 'NORMAL' }
  })
}

/** What the modal puts into the live scene, and takes out again: enough of a scene to see whether anything is left in it. */
class FakeScene {
  children: unknown[] = []
  add(object: unknown): void { this.children.push(object) }
  remove(object: unknown): void { this.children = this.children.filter((each) => each !== object) }
  /** As THREE's, for the objects the flow keeps by name (the origin decal, the floor plane): top level is where they go. */
  getObjectByName(name: string): unknown {
    return this.children.find((each) => (each as { name?: string }).name === name)
  }
}

interface Flow {
  section: FakeSection
  el(id: string): FakeElement
  /** A tap at a floor point, `across` metres along x and `ahead` along -z from where the session began. */
  tapAt(across: number, ahead: number): Promise<void>
  /** Begins a tap and returns without waiting for it to be read, which a held burst keeps from finishing. */
  tapStart(across: number, ahead: number): void
  /** While held, a burst that has delivered its frames does not return; released, every held one does. */
  holdBursts(): void
  releaseBursts(): Promise<void>
  /** The live scene, when the flow was opened with one. */
  scene: FakeScene
  press(id: string): Promise<void>
  advance(ms: number): Promise<void>
  isOpen(): boolean
  result: Promise<unknown>
  /** What a person sees: the status line, and which step is active. */
  status(): string
  step(): string
  /** The frame counters the provider publishes, which a test moves to simulate a shift. */
  counters: { poseJumps: number; epoch: number }
  provider: { status: string; reason: string | undefined }
  world: World
  /** What the sampler was asked, in order. */
  asked: Array<{ x: number; y: number; extra: Parameters<CalibrationTapSampler>[2] }>
  /** Hands the host's camera-frame request the frame it is waiting for. */
  release(): void
}

interface FlowOptions {
  stored?: ProjectSpatialFrame
  /** `'burst'` (the default): the host's sampler over a provider that returns noisy hits. `'none'`: no sampler, one hit from the hit test. A function is the sampler itself. */
  sampler?: 'burst' | 'none' | CalibrationTapSampler
  ground?: () => GroundReading | null
  capture?: 'deferred'
  /** Per-axis scatter of the burst's hits. Default 4 mm. */
  sigma?: number
  search?: string
  /** A provider with no tracking accessors at all, as the older stand-ins have. */
  bareProvider?: boolean
  /** Gives the provider a live scene, which the modal draws its floor grid and markers into. */
  withScene?: boolean
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }

async function openFlow(o: FlowOptions = {}): Promise<Flow> {
  const section = new FakeSection()
  const canvas = new FakeElement() as FakeElement & { getBoundingClientRect(): unknown }
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { createElement: () => section, body: { appendChild: () => {} } },
  })
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { search: o.search ?? '' } })

  const world: World = { sigma: o.sigma ?? 0.004, rangeM: 2, taps: 0, gap: 0, strayAt: null, shift: { x: 0, y: 0, z: 0 } }
  const counters = { poseJumps: 0, epoch: 0 }
  const state = { status: 'NORMAL', reason: undefined as string | undefined }
  const asked: Flow['asked'] = []
  const waiting: Array<() => void> = []
  // Once released, every later request is answered at once: a visit photographs each marker at its own tap, one frame after the
  // other (WP-04b), so the request that follows the one released would otherwise wait for a release nobody makes.
  let released = false
  const scene = new FakeScene()
  let burstGate: Promise<void> | null = null
  let openBurstGate: () => void = () => {}

  const arProvider = {
    isTracking: () => true,
    getPose: () => POSE,
    getScene: () => (o.withScene ? scene : null),
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.5,
    hitTest: (x: number, y: number) => ({ position: truthOf(world, x, y), rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: world.rangeM }),
    trackingStatus: () => state.status,
    getTrackingDiagnostics: () => ({ status: state.status, poseJumps: counters.poseJumps, lastJumpM: 0, epoch: counters.epoch, reason: state.reason }),
    hitTestBurstAsync: async (x: number, y: number, _windowMs: number, onFrame?: (frame: HitBurstFrame, elapsedMs: number) => void) => {
      world.taps += 1
      const frames = burstFrames(world, x, y)
      frames.forEach((frame, i) => onFrame?.(frame, i * 33))
      if (burstGate) await burstGate
      return { frames }
    },
  }
  const ground = o.ground ?? (() => RELIABLE_FLOOR)
  const burstSampler = calibrationTapSampler({ provider: arProvider as unknown as TapProvider, ground, search: o.search })
  const sampler: CalibrationTapSampler | undefined = o.sampler === 'none'
    ? undefined
    : typeof o.sampler === 'function'
      ? o.sampler
      : Object.assign((x: number, y: number, extra?: Parameters<CalibrationTapSampler>[2]) => {
          asked.push({ x, y, extra })
          return burstSampler(x, y, extra)
        }, { holdsStill: burstSampler.holdsStill })

  const result = runProjectCalibration({
    provider: (o.bareProvider ? { isTracking: () => true, getPose: () => POSE, getScene: () => null } : arProvider) as never,
    project: placeWith(o.stored),
    canvas: canvas as never,
    // One hit at the point a tap means: what the flow reads when it is given no sampler.
    hitTest: async (x: number, y: number) => ({ position: truthOf(world, x, y), rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: world.rangeM }) as never,
    ...(sampler ? { sampleTap: sampler } : {}),
    bearing: () => 12,
    ground,
    ...(o.capture === 'deferred'
      ? {
          capturePhoto: () => new Promise((resolve) => {
            const arrive = () => resolve({
              blob: new Blob(['frame']),
              thumbDataUrl: 'data:image/jpeg;base64,AAAA',
              pose: POSE,
              frameSize: { width: 400, height: 800 },
            })
            if (released) arrive()
            else waiting.push(arrive)
          }),
        }
      : {}),
    loadReferencePhoto: async () => null,
  })
  let open = true
  void result.then(() => { open = false })
  const flow: Flow = {
    section,
    result,
    counters,
    provider: state,
    world,
    asked,
    scene,
    isOpen: () => open,
    el: (id) => {
      const found = section.byId.get(id)
      assert.ok(found, `the modal has #${id}`)
      return found
    },
    status: () => flow.el('project-calibration-status').textContent,
    step: () => section.steps.find((li) => li.dataset['state'] === 'active')?.dataset['step'] ?? '',
    release: () => { released = true; waiting.splice(0).forEach((arrive) => arrive()) },
    advance: async (ms) => { mock.timers.tick(ms); await settle() },
    tapStart(across, ahead) {
      const touch = { clientX: (across / 4 + 0.5) * 400, clientY: (ahead / 3) * 800 }
      for (const fn of canvas.listeners.get('touchstart') ?? []) fn({ touches: [touch] })
    },
    holdBursts: () => { burstGate = new Promise<void>((resolve) => { openBurstGate = resolve }) },
    async releaseBursts() {
      burstGate = null
      openBurstGate()
      await settle()
      mock.timers.tick(200)
      await settle()
    },
    async tapAt(across, ahead) {
      flow.tapStart(across, ahead)
      await settle()
      mock.timers.tick(200)
      await settle()
    },
    async press(id) { flow.el(id).click(); await settle(); mock.timers.tick(200); await settle() },
  }
  await flow.advance(200) // the poll that leaves the ground stage
  return flow
}

/** Two numbers or two matrices equal to a part in a billion: the canvas maths is not exact in the last bit. */
function assertNear(actual: number | number[], expected: number | number[], message: string): void {
  const a = ([] as number[]).concat(actual)
  const e = ([] as number[]).concat(expected)
  assert.equal(a.length, e.length, `${message}: length`)
  a.forEach((value, i) => assert.ok(Math.abs(value - e[i]!) < 1e-9, `${message}: [${i}] ${value} against ${e[i]}`))
}

const CONFIRM = 'project-calibration-confirm'
const COMMIT = 'project-calibration-commit'
const OVERRIDE = 'project-calibration-override'
const FALLBACK = 'project-calibration-fallback'
const REPLACE = 'project-calibration-replace'
const SKIP = 'project-calibration-skip'
const HOLD = 'project-calibration-hold'
const NOTE = 'project-calibration-tapnote'
const CHECK = 'project-calibration-check'

/**
 * A first calibration is offered a check point once the heading marker is placed (WP-04b). These tests are about how the
 * pair is read and committed, so they leave the step by its own button, which skips it, as a person who wants the pair does.
 */
async function skipCheckPoint(flow: Flow): Promise<void> {
  if (!flow.el(CHECK).hidden) await flow.press(CHECK)
}

/** Places the landmark 1.2 m left and 1 m ahead, confirms it, and places the heading marker 1.2 m right of it. */
async function placePair(flow: Flow): Promise<void> {
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  await flow.tapAt(1.2, 1)
  await skipCheckPoint(flow)
}

async function committed(flow: Flow): Promise<{ calibration: Record<string, unknown> & { tap?: Record<string, unknown>; sessionToProject: number[] }; spatialFrame?: unknown }> {
  assert.equal(flow.isOpen(), false, 'the modal resolved')
  const outcome = await flow.result
  assert.ok(outcome, 'with a calibration')
  return outcome as never
}

test.beforeEach(() => { mock.timers.enable({ apis: ['setInterval', 'Date'] }) })
test.afterEach(() => {
  mock.timers.reset()
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'location')
})

// ── A tap is a burst, and what comes out carries how it was measured ──────────────────────────────────

test('a first calibration from burst taps commits, with the median of each burst, the tap evidence, and the frame on the floor height the landmark gave', async () => {
  const flow = await openFlow({ sigma: 0.004 })
  await placePair(flow)
  assert.equal(flow.step(), 'heading', 'the review shows the heading step as active')
  assert.equal(flow.el(COMMIT).disabled, false)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)

  // The floor: the tap lands 3 cm under the fit, inside the 5 cm that two measurements of one floor may differ by, and
  // the evidence says how far under the fit it was. The next test says what the frame is built on.
  const tap = calibration.tap!
  assert.equal(tap['tapSource'], 'burst')
  assert.ok(Math.abs((tap['landmarkAboveFloorM'] as number) - TAP_Y) < 0.01, `the landmark was ${tap['landmarkAboveFloorM']} m above the fit`)
  assert.ok(Math.abs((tap['tapRangeM'] as number) - 2) < 1e-9)
  assert.ok((tap['tapSpreadM'] as number) > 0 && (tap['tapSpreadM'] as number) < TAP_SPREAD_MAX_M, `scatter ${tap['tapSpreadM']}`)

  // The separation is that of the medians, within a centimetre of the 2.4 m between the two spots.
  assert.ok(Math.abs((calibration['separationM'] as number) - 2.4) < 0.015, `separation ${calibration['separationM']}`)
  assert.equal(calibration['status'], 'provisional')
  assert.equal(calibration['method'], 'two-point-ground')
})

test('the frame is built on the datum exactly: identical hits, a floor 3 cm over the tap', async () => {
  const flow = await openFlow({ sigma: 0 })
  await placePair(flow)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  const expected = twoPointToProjectTransform({ x: -1.2, y: -0.015, z: -1 }, { x: 1.2, y: -0.015, z: -1 })
  assertNear(calibration.sessionToProject, expected, 'built from the datum')
  assert.equal(calibration.tap!['tapSpreadM'], 0)
  assert.ok(Math.abs((calibration.tap!['landmarkAboveFloorM'] as number) - TAP_Y) < 1e-12)
})

test('a stray hit inside a burst is rejected and does not move the point the marker is placed at', async () => {
  const flow = await openFlow({ sigma: 0.003 })
  flow.world.strayAt = 5
  await placePair(flow)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.ok(Math.abs((calibration['separationM'] as number) - 2.4) < 0.015, `separation ${calibration['separationM']}`)
})

test('with no reliable fitted floor the landmark\'s own tap is the datum, and the evidence says nothing of its height above a floor', async () => {
  // Locked, so the flow leaves the ground stage, but thin and smeared: not a floor to take a height from.
  const flow = await openFlow({ sigma: 0, ground: () => ({ y: 0, locked: true, inlierCount: 10, residualM: 0.05 }) })
  await placePair(flow)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assertNear(calibration.sessionToProject, twoPointToProjectTransform({ x: -1.2, y: TAP_Y, z: -1 }, { x: 1.2, y: TAP_Y, z: -1 }), 'the tap alone')
  assert.equal(calibration.tap!['landmarkAboveFloorM'], null)
})

test('with no sampler the calibration is what it always was: one hit per tap, and no tap evidence', async () => {
  const flow = await openFlow({ sampler: 'none' })
  await placePair(flow)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.equal('tap' in calibration, false)
  assertNear(calibration.sessionToProject, twoPointToProjectTransform({ x: -1.2, y: TAP_Y, z: -1 }, { x: 1.2, y: TAP_Y, z: -1 }), 'the landmark\'s own height, as before')
  assert.equal(flow.asked.length, 0)
})

test('a landmark that was moved in the review has the evidence of the tap that moved it', async () => {
  const flow = await openFlow({ sigma: 0.002 })
  await placePair(flow)
  // Select the landmark by tapping it, then tap where it should go, with a burst that scatters more.
  await flow.tapAt(-1.2, 1)
  assert.match(flow.status(), /Landmark selected/)
  flow.world.sigma = 0.02
  await flow.tapAt(-1.4, 1)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.ok((calibration.tap!['tapSpreadM'] as number) > 0.01, `the scatter of the second burst, not the first: ${calibration.tap!['tapSpreadM']}`)
  assert.ok(Math.abs((calibration['separationM'] as number) - 2.6) < 0.05)
})

// ── A refused tap, and insisting on a spot ─────────────────────────────────────────────────────────

test('a tap that scatters past the limit says so on the card and places nothing', async () => {
  const flow = await openFlow({ sigma: 0.05 })
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), 'That spot did not read steadily. Hold still, or aim at a more textured spot. Or tap the same spot again to use it anyway.')
  assert.equal(flow.el(CONFIRM).hidden, true, 'no landmark was placed')
})

test('tapping the same spot again takes it where the scatter refusal repeats, the calibration says how much it scattered, and so does the card', async () => {
  const flow = await openFlow({ sigma: 0.05 })
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(NOTE).hidden, true)
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false, 'the landmark is placed')
  assert.equal(flow.el(NOTE).hidden, false)
  assert.match(flow.el(NOTE).textContent, /^Used anyway: its readings scattered \d+\.\d cm, over the 4 cm limit\.$/)
  const [first, second] = flow.asked.map((call) => call.extra)
  assert.equal(first?.insist, undefined, 'the first tap was judged by the limits alone')
  assert.deepEqual(second?.insist?.spread, true, 'the second was told which spot it may let past')
  assert.equal(second?.spreadMaxM, undefined, 'and no limit was lifted for it by the flow')
  await flow.press(CONFIRM)
  assert.equal(flow.el(NOTE).hidden, true, 'the note is about the tap, and goes when the landmark is confirmed')
  await flow.tapAt(1.2, 1)
  await flow.tapAt(1.2, 1)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.ok((calibration.tap!['tapSpreadM'] as number) > TAP_SPREAD_MAX_M, 'recorded as it was: over the limit')
})

test('a second tap at the same spot that reads steadily is an ordinary one: no note, and the tap evidence is inside the limit', async () => {
  const flow = await openFlow({ sigma: 0.05 })
  await flow.tapAt(-1.2, 1)
  flow.world.sigma = 0.003 // the person held still
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false)
  assert.equal(flow.el(NOTE).hidden, true, 'nothing was used anyway')
  await flow.press(CONFIRM)
  await flow.tapAt(1.2, 1)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.ok((calibration.tap!['tapSpreadM'] as number) < TAP_SPREAD_MAX_M)
})

test('a tap on a spot that is too far is told how far, and tapping it again takes it, with the range kept and said on the card', async () => {
  const flow = await openFlow({ sigma: 0 })
  flow.world.rangeM = TAP_RANGE_MAX_M + 1.1
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), 'That spot is 4.1 m away. Move closer and tap again. Or tap the same spot again to use it anyway.')
  assert.equal(flow.el(CONFIRM).hidden, true)
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false)
  assert.equal(flow.el(NOTE).textContent, 'Used anyway: that spot is 4.10 m away, over the 3 m limit.')
  await flow.press(CONFIRM)
  await flow.tapAt(1.2, 1)
  await flow.tapAt(1.2, 1)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.ok(Math.abs((calibration.tap!['tapRangeM'] as number) - 4.1) < 1e-9)
})

test('a person who steps closer but not close enough, and taps the spot again, has it used anyway, and is told so', async () => {
  const flow = await openFlow({ sigma: 0 })
  flow.world.rangeM = 3.7
  await flow.tapAt(-1.2, 1)
  assert.match(flow.status(), /That spot is 3\.7 m away\./)
  flow.world.rangeM = 3.4 // closer, the same spot, still past the limit
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false)
  assert.equal(flow.el(NOTE).textContent, 'Used anyway: that spot is 3.40 m away, over the 3 m limit.', 'not silent')
})

test('a second tap at the pixel of the refused one is refused when it is another spot: the camera moved, and the same pixel now looks elsewhere', async () => {
  const flow = await openFlow({ sigma: 0 })
  flow.world.rangeM = 3.4
  await flow.tapAt(-1.2, 1)
  assert.match(flow.status(), /That spot is 3\.4 m away\./)
  flow.world.shift = { x: -6, y: 0, z: -6 } // the same pixel, a different place on the floor, much farther
  flow.world.rangeM = 8.5
  await flow.tapAt(-1.2, 1)
  assert.match(flow.status(), /^That spot is 8\.5 m away\. Move closer and tap again\./)
  assert.equal(flow.el(CONFIRM).hidden, true, 'nothing was placed')
  assert.equal(flow.el(NOTE).hidden, true)
  assert.equal(flow.asked.at(-1)!.extra?.rangeMaxM, undefined)
})

test('and the same spot is the same wherever it is on the screen: the person moved, so the pixel is elsewhere, and the spot is taken', async () => {
  const flow = await openFlow({ sigma: 0 })
  flow.world.rangeM = 3.6
  await flow.tapAt(-1.2, 1)
  const refusedAt = worldAt(-1.2 / 4 + 0.5, 1 / 3)
  // Tapped again from somewhere else: the pixel is another, and the hits land on the very spot that was refused.
  const now = worldAt(0.5 + 0.9 / 4, 2 / 3)
  flow.world.shift = { x: refusedAt.x - now.x, y: refusedAt.y - now.y, z: refusedAt.z - now.z }
  await flow.tapAt(0.9, 2)
  assert.equal(flow.el(CONFIRM).hidden, false)
  assert.match(flow.el(NOTE).textContent, /^Used anyway: that spot is 3\.60 m away/)
})

test('every other refusal is said in the sampler\'s words, with no way to insist on it', async () => {
  const noHit = await openFlow({ sigma: 0 })
  noHit.world.gap = 1 // every frame of every burst has no hit
  await noHit.tapAt(-1.2, 1)
  assert.equal(noHit.status(), 'No stable surface there. Aim at a textured floor and tap again.')
  await noHit.tapAt(-1.2, 1)
  assert.equal(noHit.status(), 'No stable surface there. Aim at a textured floor and tap again.', 'tapping it again changes nothing')
  assert.equal(noHit.el(CONFIRM).hidden, true)

  const few = await openFlow({ sampler: async () => ({ ok: false, reason: 'too-few-hits', n: 2 }) satisfies TapResult })
  await few.tapAt(-1.2, 1)
  assert.equal(few.status(), 'Too few readings of that spot. Hold still and tap again.')
})

test('a tap in a map that is not stable is turned away at once, in words, and no burst is started', async () => {
  const flow = await openFlow()
  flow.provider.status = 'LIMITED'
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), TRACKING_RECOVERING_TEXT)
  assert.equal(flow.asked.length, 0, 'the sampler was not asked')
  assert.equal(flow.el(CONFIRM).hidden, true)
  flow.provider.status = 'NORMAL'
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false, 'once the map is stable the same tap places the landmark')
})

test('a map the engine says is relocalizing is not stable, whatever its status reads', async () => {
  const flow = await openFlow()
  flow.provider.reason = 'RELOCALIZING'
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), TRACKING_RECOVERING_TEXT)
})

test('a sampler that fails is a tap that found nothing, said as it always was', async () => {
  const flow = await openFlow({ sampler: () => Promise.reject(new Error('the burst failed')) })
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), 'No stable surface there. Aim at a textured floor and tap again.')
  assert.equal(flow.el(CONFIRM).hidden, true)
})

// ── The hold-still ring ────────────────────────────────────────────────────────────────────────────

test('the ring is shown while a burst runs, warns when its hits scatter, and is gone when the tap is read', async () => {
  let finish: (result: TapResult) => void = () => {}
  let report: (progress: TapProgress) => void = () => {}
  const flow = await openFlow({
    sampler: (_x, _y, extra) => new Promise<TapResult>((resolve) => {
      finish = resolve
      report = extra?.onProgress ?? (() => {})
    }),
  })
  assert.equal(flow.el(HOLD).hidden, true, 'not shown before a tap')
  const tapping = flow.tapAt(-1.2, 1)
  await settle()
  assert.equal(flow.status(), 'Hold still, reading the surface…')
  assert.equal(flow.el(HOLD).hidden, true, 'nothing to show until the first frame')

  report({ elapsedMs: 0, windowMs: 450, frames: 1, hits: 1, spreadM: null })
  assert.equal(flow.el(HOLD).hidden, false)
  assert.equal(flow.el(HOLD).dataset['state'], 'steady')
  report({ elapsedMs: 225, windowMs: 450, frames: 7, hits: 7, spreadM: 0.01 })
  assert.match(flow.el(HOLD).style['background']!, / 180deg, /)
  report({ elapsedMs: 300, windowMs: 450, frames: 9, hits: 9, spreadM: TAP_SPREAD_MAX_M * 2 })
  assert.equal(flow.el(HOLD).dataset['state'], 'unsteady')

  finish({ ok: false, reason: 'no-hit', n: 0 })
  await tapping
  assert.equal(flow.el(HOLD).hidden, true, 'gone when the tap is read, taken or refused')
})

// ── The floor gate is judged by how high the hits measured ────────────────────────────────────────

test('a tap the floor ray placed on the floor is still judged by the hits: 40 cm up is not on the floor', async () => {
  // The ray puts the position on the fitted floor by construction, so a gate that read the position would pass a
  // tabletop. The hits are what say how high the person tapped.
  const sampler: CalibrationTapSampler = async () => ({
    ok: true,
    position: { x: -1.2, y: 0, z: -1 },
    hitPosition: { x: -1.2, y: 0.4, z: -1 },
    rangeM: 2,
    spreadM: 0.002,
    n: 12,
    rejected: 0,
    source: 'floor-ray',
  })
  const flow = await openFlow({ sampler })
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), 'That looked about 40 cm above the floor. Aim at the floor, or tap the same height again to use it anyway.')
  assert.equal(flow.el(CONFIRM).hidden, true)
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false, 'the same height again is the confirmation the gate asks for')
})

// ── The map moved, or the landmark waited too long ────────────────────────────────────────────────

const SHIFT_TEXT = 'Tracking was disturbed, tap the landmark again'

test('a frame shift between the landmark and the commit sends the flow back to the landmark, and nothing is committed', async () => {
  const flow = await openFlow()
  await placePair(flow)
  flow.counters.poseJumps += 1
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true, 'not committed')
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.step(), 'landmark')
  assert.equal(flow.el(CONFIRM).hidden, true, 'the landmark is gone: it was placed in a frame that no longer exists')
  assert.equal(flow.el(COMMIT).hidden, true)
  assert.equal(flow.el(FALLBACK).hidden, true, 'and so is the one-point offer, which needs a landmark')
})

test('a pass made after the shift commits: the new frame is watched from its own confirmation', async () => {
  const flow = await openFlow()
  await placePair(flow)
  flow.counters.poseJumps += 1
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true)
  await placePair(flow)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.equal(calibration['method'], 'two-point-ground')
})

test('a new frame epoch is the same disturbance', async () => {
  const flow = await openFlow()
  await placePair(flow)
  flow.counters.epoch += 1
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), placementDisturbedText('epoch-changed'))
})

test('a shift that happened before the landmark was confirmed is not a disturbance', async () => {
  const flow = await openFlow()
  flow.counters.poseJumps = 7
  await placePair(flow)
  await flow.press(COMMIT)
  await committed(flow)
})

test('a shift between confirming the landmark and tapping the heading marker is caught at that tap, not at the commit', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  flow.counters.poseJumps += 1
  await flow.tapAt(1.2, 1)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.step(), 'landmark', 'back at the landmark without the person having pressed Commit')
  assert.equal(flow.el(COMMIT).hidden, true)
})

/** Confirms the landmark, places the heading marker, and waits until the commit's click lands `afterMs` after the confirming one. */
async function placePairAndWait(flow: Flow, afterMs: number): Promise<void> {
  await flow.tapAt(-1.2, 1)
  const confirmedAt = Date.now() // the clock the watch reads at the click that follows
  await flow.press(CONFIRM)
  await flow.tapAt(1.2, 1)
  await skipCheckPoint(flow)
  await flow.advance(confirmedAt + afterMs - Date.now())
}

test('the 90 seconds are counted from the confirmation: at exactly 90 the commit goes through', async () => {
  const flow = await openFlow()
  await placePairAndWait(flow, LANDMARK_TO_COMMIT_BUDGET_MS)
  await flow.press(COMMIT)
  await committed(flow)
})

test('and a millisecond past them it is turned away, back to the landmark, with the budget in the sentence', async () => {
  const flow = await openFlow()
  await placePairAndWait(flow, LANDMARK_TO_COMMIT_BUDGET_MS + 1)
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), 'That took over 90 seconds, tap the landmark again')
  assert.equal(flow.step(), 'landmark')
  // And a fresh pass is a fresh 90 seconds.
  await placePair(flow)
  await flow.press(COMMIT)
  await committed(flow)
})

test('a return visit goes back to the landmark with the stored photo of the landmark showing again', async () => {
  const flow = await openFlow({ stored: TWO_POINT_2_4 })
  await placePair(flow)
  const reference = flow.el('project-calibration-reference')
  const title = flow.el('project-calibration-reference-title')
  assert.equal(title.textContent, 'Last time — Point B — the heading marker', 'while the heading marker was placed, the heading marker\'s photo')
  flow.counters.poseJumps += 1
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(reference.hidden, false, 'the stored photos are still there to be matched')
  assert.equal(title.textContent, 'Last time — Point A — the landmark', 'now the landmark\'s')
})

test('a shift during the wait for the reference photo is seen when the wait is over, and nothing is committed', async () => {
  const flow = await openFlow({ capture: 'deferred' })
  await placePair(flow)
  void flow.press(COMMIT)
  await settle()
  assert.equal(flow.status(), 'Saving reference photos…', 'the commit is waiting for the camera')
  flow.counters.poseJumps += 1
  flow.release()
  await settle()
  assert.equal(flow.isOpen(), true, 'not committed')
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.step(), 'landmark')
})

test('a return visit that shifted after its mismatch screen does not let "Use anyway" through', async () => {
  const flow = await openFlow({ stored: TWO_POINT_2_4 })
  await flow.tapAt(-1.8, 1)
  await flow.press(CONFIRM)
  await flow.tapAt(1.8, 1) // 3.6 m against a stored 2.4 m
  await flow.press(COMMIT)
  assert.equal(flow.el('project-calibration-title').textContent, 'These markers do not match the stored pair')
  flow.counters.poseJumps += 1
  await flow.press(OVERRIDE)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.step(), 'landmark')
})

test('the one-point button, pressed after a shift since the landmark was confirmed, sends the flow back too', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  flow.counters.poseJumps += 1
  await flow.press(FALLBACK)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.step(), 'landmark')
})

test('a provider with no tracking accessors at all is watched by the clock alone, and reads taps as before', async () => {
  const flow = await openFlow({ sampler: 'none', bareProvider: true })
  await placePair(flow)
  await flow.press(COMMIT)
  await committed(flow)
})

// ── The one-point tier is as it was ───────────────────────────────────────────────────────────────

test('the one-point tier makes the same records from burst taps as from one hit, with no tap evidence and the tap\'s own height', async () => {
  const sampled = await openFlow({ sigma: 0 })
  await sampled.tapAt(-1.2, 1)
  await sampled.press(FALLBACK)
  const a = await committed(sampled)

  const single = await openFlow({ sampler: 'none' })
  await single.tapAt(-1.2, 1)
  await single.press(FALLBACK)
  const b = await committed(single)

  assert.equal(a.calibration['method'], 'ground-tap-compass')
  assertNear(a.calibration.sessionToProject, b.calibration.sessionToProject, 'the same frame: no floor datum on this tier')
  assert.equal('tap' in a.calibration, false)
  assert.equal(a.calibration['status'], 'provisional')
  assert.deepEqual(a.spatialFrame && { ...(a.spatialFrame as object), createdAt: '' }, b.spatialFrame && { ...(b.spatialFrame as object), createdAt: '' })
})

test('the one-point button after the landmark was confirmed, with nothing disturbed, still commits', async () => {
  const flow = await openFlow({ sigma: 0 })
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  await flow.press(FALLBACK)
  const { calibration } = await committed(flow)
  assert.equal(calibration['method'], 'ground-tap-compass')
})

test('the separation of a pair is the pair\'s own: distance is unchanged by the datum', async () => {
  const flow = await openFlow({ sigma: 0 })
  await placePair(flow)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assertNear(calibration['separationM'] as number, twoPointSeparationM({ x: -1.2, y: 0, z: -1 }, { x: 1.2, y: 0, z: -1 }), 'the pair\'s own distance')
})

// ── A tap on a marker that is already placed only selects it ────────────────────────────────────────

test('a marker is selected by tapping it from beyond the range limit: one hit, no burst, nothing refused', async () => {
  const flow = await openFlow({ sigma: 0 })
  await placePair(flow)
  const bursts = flow.asked.length
  flow.world.rangeM = TAP_RANGE_MAX_M + 1.1 // the person stands at the heading marker, and the landmark is far
  await flow.tapAt(-1.2, 1)
  assert.match(flow.status(), /Landmark selected/)
  assert.equal(flow.asked.length, bursts, 'no burst was read to select it')
  assert.equal(flow.el(NOTE).hidden, true)
  // Moving it is a placement: that tap is a burst, judged by the limits as any other.
  await flow.tapAt(-1.4, 1)
  assert.match(flow.status(), /^That spot is 4\.1 m away\./)
  assert.equal(flow.asked.length, bursts + 1)
  flow.world.rangeM = 2
  await flow.tapAt(-1.4, 1)
  await flow.press(COMMIT)
  const { calibration } = await committed(flow)
  assert.ok(Math.abs((calibration['separationM'] as number) - 2.6) < 1e-9, 'the landmark was moved to where the burst read it')
})

test('a tap near no marker still reads a burst, and a tap with a marker selected is a burst wherever it lands', async () => {
  const flow = await openFlow({ sigma: 0 })
  await placePair(flow)
  const bursts = flow.asked.length
  await flow.tapAt(0.3, 2.5) // on no marker
  assert.equal(flow.asked.length, bursts + 1, 'read as a burst')
  assert.equal(flow.status(), 'Tap a marker to select it, then tap where it should go.')
  await flow.tapAt(-1.2, 1) // on the landmark: selects it, without a burst
  assert.match(flow.status(), /Landmark selected/)
  assert.equal(flow.asked.length, bursts + 1)
  await flow.tapAt(1.2, 1) // with it selected, even the heading marker's own spot is where it should go: a burst
  assert.equal(flow.asked.length, bursts + 2)
})

test('with no sampler a tap is one hit as it always was, selecting or placing', async () => {
  const flow = await openFlow({ sampler: 'none', sigma: 0 })
  await placePair(flow)
  await flow.tapAt(-1.2, 1)
  assert.match(flow.status(), /Landmark selected/)
  assert.equal(flow.asked.length, 0)
})

// ── A read that is still running when the flow moves on ─────────────────────────────────────────────

test('"Continue uncalibrated" pressed while a tap is being read closes the modal, and the read, when it ends, puts nothing back in the scene', async () => {
  const flow = await openFlow({ sigma: 0, withScene: true })
  await placePair(flow)
  flow.holdBursts()
  flow.tapStart(0.3, 2)
  await settle()
  await flow.press(SKIP)
  assert.equal(flow.isOpen(), false)
  assert.equal(flow.scene.children.length, 0, 'the modal took its placement out of the scene as it closed')
  await flow.releaseBursts()
  assert.equal(flow.scene.children.length, 0, 'and the read that ended afterwards did not put it back')
})

test('"Continue uncalibrated" pressed while the first tap is being read: the read, when it ends, places no marker in a scene nobody is looking at', async () => {
  const flow = await openFlow({ sigma: 0, withScene: true })
  flow.holdBursts()
  flow.tapStart(-1.2, 1)
  await settle()
  await flow.press(SKIP)
  assert.equal(flow.scene.children.length, 0)
  await flow.releaseBursts()
  assert.equal(flow.scene.children.length, 0, 'the landmark that was being read was not placed after the modal closed')
})

test('"Use this alignment" pressed while a tap is being read commits the pair, and the read, when it ends, draws nothing more', async () => {
  const flow = await openFlow({ sigma: 0, withScene: true })
  await placePair(flow)
  flow.holdBursts()
  flow.tapStart(0.3, 2)
  await settle()
  await flow.press(COMMIT)
  await committed(flow)
  // The floor plane, which stays on the scene for the rest of the scan (WP-07, owner R10), and the committed origin, one decal for
  // the landmark and the arrow to the heading point: not the flow's placement group, which went with it.
  const names = () => flow.scene.children.map((child) => (child as { name?: string }).name)
  assert.deepEqual(names(), ['calibration floor plane', 'calibration origin'])
  await flow.releaseBursts()
  assert.deepEqual(names(), ['calibration floor plane', 'calibration origin'], 'and the read that ended afterwards drew nothing more')
})

test('"Re-place points" pressed while a tap is being read: the read, when it ends, places nothing in the cleared flow', async () => {
  const flow = await openFlow({ sigma: 0 })
  await placePair(flow)
  flow.holdBursts()
  flow.tapStart(0.3, 2)
  await settle()
  await flow.press(REPLACE)
  assert.equal(flow.step(), 'landmark')
  await flow.releaseBursts()
  assert.equal(flow.el(CONFIRM).hidden, true, 'no landmark was placed by a tap begun before the points were cleared')
  assert.equal(flow.step(), 'landmark')
  await placePair(flow)
  await flow.press(COMMIT)
  await committed(flow)
})

test('"Confirm landmark" pressed while a tap is being read: that read does not become the heading marker', async () => {
  const flow = await openFlow({ sigma: 0 })
  await flow.tapAt(-1.2, 1)
  flow.holdBursts()
  flow.tapStart(1.2, 1) // begun in the landmark stage
  await settle()
  await flow.press(CONFIRM)
  assert.equal(flow.step(), 'heading')
  await flow.releaseBursts()
  assert.equal(flow.step(), 'heading', 'still waiting for the heading marker')
  assert.equal(flow.el(COMMIT).hidden, true, 'a tap begun for the landmark is not the heading marker')
  await flow.tapAt(1.2, 1)
  await flow.press(COMMIT)
  await committed(flow)
})

// ── A commit waiting for its photos ─────────────────────────────────────────────────────────────────

test('a tap while a commit waits for its photos is not taken: the pair the commit holds is the pair that was shown', async () => {
  const flow = await openFlow({ sigma: 0, capture: 'deferred' })
  await placePair(flow)
  void flow.press(COMMIT)
  await settle()
  assert.equal(flow.status(), 'Saving reference photos…')
  const bursts = flow.asked.length
  await flow.tapAt(0.3, 2)
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.asked.length, bursts, 'no tap was read')
  assert.equal(flow.status(), 'Saving reference photos…')
  flow.release()
  await settle()
  const { calibration } = await committed(flow)
  assert.ok(Math.abs((calibration['separationM'] as number) - 2.4) < 1e-9, 'committed as it was shown')
})

test('"Re-place points" pressed while a commit waits for its photos: nothing is committed when the camera answers', async () => {
  const flow = await openFlow({ capture: 'deferred' })
  await placePair(flow)
  void flow.press(COMMIT)
  await settle()
  await flow.press(REPLACE)
  assert.equal(flow.step(), 'landmark')
  flow.release()
  await settle()
  assert.equal(flow.isOpen(), true, 'the pair that was cleared is not committed')
  assert.equal(flow.step(), 'landmark')
})

test('"Continue uncalibrated" pressed while a commit waits for its photos: closed with nothing, and the commit that wakes up draws nothing', async () => {
  const flow = await openFlow({ capture: 'deferred', withScene: true })
  await placePair(flow)
  void flow.press(COMMIT)
  await settle()
  await flow.press(SKIP)
  assert.equal(flow.isOpen(), false)
  flow.release()
  await settle()
  assert.equal(await flow.result, null, 'closed without a calibration')
  assert.equal(flow.scene.children.length, 0, 'no marker was dropped into the scene by a commit nobody was waiting for')
})

test('a commit pressed inside the 90 seconds is not turned away because the camera answered after them', async () => {
  const flow = await openFlow({ capture: 'deferred' })
  await flow.tapAt(-1.2, 1)
  const confirmedAt = Date.now()
  await flow.press(CONFIRM)
  await flow.tapAt(1.2, 1)
  await flow.advance(confirmedAt + LANDMARK_TO_COMMIT_BUDGET_MS - 100 - Date.now())
  void flow.press(COMMIT) // in time
  await settle()
  await flow.advance(300) // the camera is slow: its answer is past the 90 seconds
  flow.release()
  await settle()
  await committed(flow)
})

// ── The shift between the tap and the confirmation ──────────────────────────────────────────────────

test('a frame shift between tapping the landmark and confirming it is seen at the confirmation, before the person walks', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  flow.counters.poseJumps += 1 // while a label is typed
  await flow.press(CONFIRM)
  assert.equal(flow.step(), 'landmark')
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.el(CONFIRM).hidden, true, 'the landmark is gone: it was tapped in a frame that no longer exists')
  await placePair(flow)
  await flow.press(COMMIT)
  await committed(flow)
})

test('a new epoch between the tap and the confirmation is the same', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  flow.counters.epoch += 1
  await flow.press(CONFIRM)
  assert.equal(flow.status(), placementDisturbedText('epoch-changed'))
  assert.equal(flow.step(), 'landmark')
})

test('a shift after the landmark was tapped is seen at the next tap too, even one that only selects it', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  flow.counters.poseJumps += 1
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.el(CONFIRM).hidden, true)
})

test('a landmark moved after a shift is the new frame\'s: the watch starts over at the tap that placed it', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  await flow.tapAt(-1.2, 1) // selects it
  assert.match(flow.status(), /Landmark selected/)
  flow.counters.poseJumps += 1 // the map shifts while the person decides where it should go
  await flow.tapAt(-1.5, 1) // placed again, in the frame the map is in now
  assert.equal(flow.status(), 'Landmark placed. Tap it to move it, or confirm to place the heading marker.')
  await flow.press(CONFIRM)
  assert.equal(flow.step(), 'heading')
})

test('the time between tapping the landmark and confirming it is not the walk: three minutes of typing, then the full 90 seconds', async () => {
  const flow = await openFlow()
  await flow.tapAt(-1.2, 1)
  await flow.advance(180_000)
  const confirmedAt = Date.now()
  await flow.press(CONFIRM)
  assert.equal(flow.step(), 'heading', 'the confirmation is not turned away for the time the person took')
  await flow.tapAt(1.2, 1)
  await flow.advance(confirmedAt + LANDMARK_TO_COMMIT_BUDGET_MS - Date.now())
  await flow.press(COMMIT)
  await committed(flow)
})

// ── The one-point tier has no walk to bound ─────────────────────────────────────────────────────────

test('the one-point button is not turned away for time: a late press commits, with the landmark it had', async () => {
  const flow = await openFlow({ sigma: 0 })
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  await flow.advance(LANDMARK_TO_COMMIT_BUDGET_MS + 5_000)
  await flow.press(FALLBACK)
  const { calibration } = await committed(flow)
  assert.equal(calibration['method'], 'ground-tap-compass')
})

test('and the two-point commit at the same moment still is: the clock is for the walk', async () => {
  const flow = await openFlow({ sigma: 0 })
  await placePair(flow)
  await flow.advance(LANDMARK_TO_COMMIT_BUDGET_MS + 5_000)
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), placementDisturbedText('too-long'))
})

// ── A map that is not steady cannot take a point ────────────────────────────────────────────────────

test('"Confirm landmark" pressed while the map is not steady is turned away with the sentence, and goes through when it is', async () => {
  const flow = await openFlow({ sigma: 0 })
  await flow.tapAt(-1.2, 1)
  flow.provider.status = 'LIMITED'
  flow.provider.reason = 'RELOCALIZING'
  await flow.press(CONFIRM)
  assert.equal(flow.step(), 'landmark', 'not confirmed')
  assert.equal(flow.status(), TRACKING_RECOVERING_TEXT)
  assert.equal(flow.el(CONFIRM).hidden, false, 'the landmark is still there to confirm')
  flow.provider.status = 'NORMAL'
  flow.provider.reason = undefined
  await flow.press(CONFIRM)
  assert.equal(flow.step(), 'heading')
})

test('"Use this alignment" pressed while the map is not steady is turned away with the sentence, and commits when it is', async () => {
  const flow = await openFlow({ sigma: 0, capture: 'deferred' })
  await placePair(flow)
  flow.provider.status = 'LIMITED'
  await flow.press(COMMIT)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), TRACKING_RECOVERING_TEXT, 'not "Saving reference photos"')
  flow.provider.status = 'NORMAL'
  void flow.press(COMMIT)
  await settle()
  flow.release()
  await settle()
  await committed(flow)
})

test('"Use anyway" on the mismatch screen is turned away the same way', async () => {
  const flow = await openFlow({ stored: TWO_POINT_2_4 })
  await flow.tapAt(-1.8, 1)
  await flow.press(CONFIRM)
  await flow.tapAt(1.8, 1)
  await flow.press(COMMIT)
  assert.equal(flow.el('project-calibration-title').textContent, 'These markers do not match the stored pair')
  flow.provider.status = 'LIMITED'
  await flow.press(OVERRIDE)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.el('project-calibration-title').textContent, 'These markers do not match the stored pair')
  assert.equal(flow.status(), TRACKING_RECOVERING_TEXT)
  flow.provider.status = 'NORMAL'
  await flow.press(OVERRIDE)
  await committed(flow)
})

test('the one-point button is turned away the same way', async () => {
  const flow = await openFlow({ sigma: 0 })
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  flow.provider.status = 'LIMITED'
  await flow.press(FALLBACK)
  assert.equal(flow.isOpen(), true)
  assert.equal(flow.status(), TRACKING_RECOVERING_TEXT)
  flow.provider.status = 'NORMAL'
  await flow.press(FALLBACK)
  await committed(flow)
})

test('a provider that publishes no status at all confirms and commits as before', async () => {
  const flow = await openFlow({ sampler: 'none', bareProvider: true })
  await placePair(flow)
  await flow.press(COMMIT)
  await committed(flow)
})

// ── The heights the two markers are compared by ─────────────────────────────────────────────────────

test('under the floor ray the warning that one marker is probably not on the floor reads what the hits measured, not where the ray put them', async () => {
  const heights = [-0.02, 0.2]
  let n = 0
  const flow = await openFlow({
    sampler: async (x) => {
      const across = (x - 0.5) * 4
      return {
        ok: true,
        source: 'floor-ray',
        n: 12,
        rejected: 0,
        spreadM: 0.004,
        rangeM: 2,
        position: { x: across, y: 0, z: -1 },
        hitPosition: { x: across, y: heights[Math.min(n++, 1)]!, z: -1 },
      } satisfies TapSample
    },
  })
  await flow.tapAt(-1.2, 1)
  await flow.press(CONFIRM)
  await flow.tapAt(1.2, 1)
  assert.equal(flow.status(), 'That point measured 22 cm above the landmark — one of the two is probably not on the floor.')
})

// ── What the card says while a tap is read ──────────────────────────────────────────────────────────

test('a sampler that reads one hit does not ask the person to hold still for it', async () => {
  let finish: (result: TapResult) => void = () => {}
  const sampler = Object.assign(
    () => new Promise<TapResult>((resolve) => { finish = resolve }),
    { holdsStill: false },
  ) as CalibrationTapSampler
  const flow = await openFlow({ sampler })
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.status(), 'Reading the surface…')
  finish({ ok: false, reason: 'no-hit', n: 0 })
  await settle()
})

test('under ?tap=single a tap is one hit through the same gates: placed, with no burst and no wait for the phone to be held still', async () => {
  const flow = await openFlow({ search: '?tap=single', sigma: 0 })
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(CONFIRM).hidden, false)
  assert.equal(flow.world.taps, 0, 'no burst was run')
  assert.equal(flow.status(), 'Landmark placed. Tap it to move it, or confirm to place the heading marker.')
})

test('a read that is discarded because the flow moved on leaves no "reading" words on the screen it did not belong to', async () => {
  const flow = await openFlow({ stored: TWO_POINT_2_4, sigma: 0 })
  await flow.tapAt(-1.8, 1)
  await flow.press(CONFIRM)
  await flow.tapAt(1.8, 1) // 3.6 m against a stored 2.4 m
  flow.holdBursts()
  flow.tapStart(0.3, 2.5)
  await settle()
  assert.equal(flow.status(), 'Hold still, reading the surface…')
  await flow.press(COMMIT) // the pair does not match: the mismatch screen
  assert.equal(flow.el('project-calibration-title').textContent, 'These markers do not match the stored pair')
  await flow.releaseBursts()
  assert.equal(flow.status(), 'Not committed yet.')
})

test('the note about a tap used anyway goes when the points are cleared: it was about a landmark that is gone', async () => {
  const flow = await openFlow({ sigma: 0 })
  flow.world.rangeM = TAP_RANGE_MAX_M + 1.1
  await flow.tapAt(-1.2, 1)
  await flow.tapAt(-1.2, 1)
  assert.equal(flow.el(NOTE).hidden, false)
  flow.counters.poseJumps += 1
  await flow.tapAt(-1.2, 1) // seen at the next tap: back to the landmark, the points cleared
  assert.equal(flow.status(), SHIFT_TEXT)
  assert.equal(flow.el(NOTE).hidden, true)
})
