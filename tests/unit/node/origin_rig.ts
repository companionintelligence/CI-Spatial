/**
 * A rig for the origin tests that run the real calibration modal (`runProjectCalibration`,
 * src/ar/project-calibration.ts) against the physical model in tests/unit/deno/physical_oracle.ts: a session that
 * starts facing some bearing, a camera that turns, a perfect compass, and physical floor features the person taps.
 *
 * Not a test file (no `.test.ts` name, so no runner collects it). It exists because the three origin test files that
 * need it (origin_heading_bearing, origin_lifecycle, origin_decal_truth) all need the one thing the older rigs in
 * calibration_bearing_flow.test.ts and the support driver could not give them: SEVERAL flows run into ONE scene, the
 * way a re-anchor runs the modal again on the provider's scene that the first run drew into.
 *
 * There is no DOM. The modal builds its card with `innerHTML` and finds its parts by id, so the document below is a
 * stand-in that registers every `id="..."` of that markup and records writes and clicks. What it cannot tell is how
 * the card looks or whether a thumb can reach a button: that is for the browser specs.
 */
import { registerHooks } from 'node:module'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import type { CalibrationResult } from '../../../src/ar/project-calibration.ts'
import type { CalibrationTapSampler } from '../../../src/ar/calibration-taps.ts'
import type { Project, Quat, Vec3 } from '../../../src/world/types.ts'
import { cameraRotation, enuToSession, perfectCompassBearing } from '../deno/physical_oracle.ts'

// The modal's imports are written for the bundler and carry no `.ts` extension, which Node's loader does not resolve.
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

const modal = await import('../../../src/ar/project-calibration.ts')
export const runProjectCalibration = modal.runProjectCalibration
/** What takes a calibration's drawings out of a scene, as the page calls it (src/main.ts, `dropCalibrationDrawings`). */
export const withdrawCalibrationDrawings = modal.withdrawCalibrationDrawings

// ── A stand-in for the part of the DOM the modal touches ───────────────────

export class FakeElement {
  hidden = false
  disabled = false
  textContent = ''
  value = ''
  src = ''
  clientWidth = 100
  clientHeight = 100
  onload: (() => void) | null = null
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  classList = { toggle: () => false, add: () => {}, remove: () => {} }
  parts = new Map<string, FakeElement>()
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  set innerHTML(html: string) {
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) this.parts.set(match[1]!, new FakeElement())
    // A button is what its markup says it is called.
    for (const match of html.matchAll(/<button\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)<\/button>/g)) this.parts.get(match[1]!)!.textContent = match[2]!.trim()
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== fn))
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  click(): void {
    this.fire('click')
  }
  querySelector(selector: string): FakeElement | null {
    return this.parts.get(selector.replace(/^#/, '')) ?? null
  }
  querySelectorAll(): FakeElement[] {
    return []
  }
  appendChild(): void {}
  remove(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 }
  }
}

/** What each global was before the first stand-in went over it, so every test leaves the process as it found it. */
const ORIGINAL_GLOBALS = new Map<string, PropertyDescriptor | undefined>()

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  if (!ORIGINAL_GLOBALS.has(name)) ORIGINAL_GLOBALS.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    const had = ORIGINAL_GLOBALS.get(name)
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

// ── One flow, wired to the oracle ──────────────────────────────────────────

/** Where the floor is in the session, metres. The taps land on it unless a flow says otherwise. */
export const FLOOR_Y = -1.2

export interface FlowSetup {
  /** Bearing the session started facing. */
  psi: number
  /** Degrees turned LEFT since the session started. */
  turn?: number
  /** Degrees the camera is tilted below the horizon. */
  down?: number
  /** The camera's pose, when it is not simply `turn` and `down`. */
  rotation?: Quat
  /** `?bearing=1`, or nothing. */
  search?: string
  /** What the compass says. Defaults to a perfect one. */
  compass?: (perfect: number) => number | null
  /** The Place the flow calibrates: a stored frame makes it a return visit. */
  project?: Partial<Project>
  /** The scene the flow draws into. Pass one scene to several flows to see what they leave for each other. */
  scene?: THREE.Scene
  /** The floor estimate the host reports. Default: locked at `FLOOR_Y`, with no fit statistics (so not reliable). */
  ground?: () => { y: number; locked: boolean; residualM?: number; inlierCount?: number; fallback?: boolean } | null
  /**
   * Read every tap through a host sampler (src/ar/calibration-taps.ts), whose hits measure `aboveM` metres higher than the
   * floor the taps were aimed at. The landmark's floor height is then a datum (`landmarkDatum`, src/ar/ground-gate.ts): the
   * mean of that tap and a reliable fitted floor, when they agree to 5 cm, and not the tap's own height.
   */
  sampledTaps?: { aboveM: number }
}

export type Flow = Awaited<ReturnType<typeof startFlow>>

/** A host sampler that reads the tap's point `aboveM` metres up from where the runtime's hit test put it. */
function sampler(aboveM: number, hitNow: () => Vec3): CalibrationTapSampler {
  const read = async () => {
    const at = hitNow()
    const position = { x: at.x, y: at.y + aboveM, z: at.z }
    return { ok: true as const, position, rangeM: 1.5, spreadM: 0.004, n: 5, rejected: 0, source: 'burst' as const, hitPosition: position }
  }
  return Object.assign(read, { holdsStill: false })
}

export async function startFlow(t: TestContext, setup: FlowSetup) {
  const card = new FakeElement()
  stubGlobal(t, 'document', { createElement: () => card, body: { appendChild: () => {} } })
  stubGlobal(t, 'location', { search: setup.search ?? '' })
  const scene = setup.scene ?? new THREE.Scene()
  const rotation: Quat = setup.rotation ?? cameraRotation(setup.turn ?? 0, setup.down ?? 0)
  const canvas = new FakeElement()
  let hit: Vec3 = { x: 0, y: FLOOR_Y, z: 0 }
  const perfect = () => perfectCompassBearing(setup.psi, rotation)
  const project = { projectId: 'p1', name: 'Room', createdAt: 0, updatedAt: 0, floors: [], ...setup.project } as Project

  const result = runProjectCalibration({
    provider: {
      getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation }),
      isTracking: () => true,
      getScene: () => scene,
    } as never,
    project,
    canvas: canvas as never,
    hitTest: async () => ({ position: hit, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 1.5 }),
    ...(setup.sampledTaps ? { sampleTap: sampler(setup.sampledTaps.aboveM, () => hit) } : {}),
    bearing: () => (setup.compass ? setup.compass(perfect()) : perfect()),
    ground: setup.ground ?? (() => ({ y: FLOOR_Y, locked: true })),
  })
  let closed = false
  void result.then(() => { closed = true })
  t.after(() => { if (!closed) card.parts.get('project-calibration-skip')?.click() })

  const part = (id: string) => card.parts.get(id)!
  /** Press a button the way a thumb can: it has to be showing and enabled. */
  const press = (id: string) => {
    const button = part(id)
    assert.equal(button.hidden, false, `${id} is hidden`)
    assert.equal(button.disabled, false, `${id} is disabled`)
    button.click()
  }
  let taps = 0
  const tap = async (session: Vec3) => {
    hit = session
    const x = 0.25 + 0.07 * (taps++ % 8)
    canvas.fire('touchstart', { touches: [{ clientX: x * 100, clientY: 50 }] })
    await settle()
  }
  return {
    result,
    scene,
    part,
    press,
    tap,
    status: () => part('project-calibration-status').textContent,
    isClosed: () => closed,
    perfect,
    rotation,
    /** The session point a physical ENU point is at, for the session this flow runs in. */
    physical: (enu: { east: number; north: number; up: number }): Vec3 => enuToSession(setup.psi, enu),
    /** Places the landmark and confirms it. */
    async placeLandmark(point: Vec3) {
      await tap(point)
      press('project-calibration-confirm')
    },
    /** The check-point button, when the card is showing it: it skips the step, as a person who wants two points does. */
    skipCheckPoint() {
      if (!part('project-calibration-check').hidden) press('project-calibration-check')
    },
    /** What the flow resolved to. */
    async finish(): Promise<CalibrationResult | null> {
      return await result
    },
  }
}

// ── Physical scenes ────────────────────────────────────────────────────────

export interface Enu { east: number; north: number; up: number }

/** The ENU point `along` metres from `from` on true bearing `bearingDeg`, and `across` metres to the left of that line. */
export function walk(from: Enu, bearingDeg: number, along: number, across = 0): Enu {
  const b = (bearingDeg * Math.PI) / 180
  // Left of a line on bearing b is the direction at bearing b - 90.
  return {
    east: from.east + along * Math.sin(b) - across * Math.cos(b),
    north: from.north + along * Math.cos(b) + across * Math.sin(b),
    up: from.up,
  }
}

/** An ENU point nudged by `eastM` and `northM` metres: how a person's tap misses the spot it was aimed at. */
export function nudge(point: Enu, eastM: number, northM: number): Enu {
  return { east: point.east + eastM, north: point.north + northM, up: point.up }
}

/** The physical spots of a three-point constellation: the landmark, the heading marker `baselineM` along `bearingDeg`, and a check point off the line. */
export function constellation(landmark: Enu, bearingDeg: number, baselineM = 2.4): { landmark: Enu; marker: Enu; check: Enu } {
  return {
    landmark,
    marker: walk(landmark, bearingDeg, baselineM),
    check: walk(landmark, bearingDeg, 0.9 * baselineM, 1.1),
  }
}

/** The angle, in degrees, folded into [0, 360). */
export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360

/** Whether two bearings are within `tolerance` degrees of each other round the circle. */
export function bearingsAgree(a: number, b: number, tolerance = 1e-6): boolean {
  const gap = Math.abs(norm360(a - b))
  return Math.min(gap, 360 - gap) <= tolerance
}

// ── Whole flows ────────────────────────────────────────────────────────────

/** The physical spots a flow taps: where the landmark, the heading marker and the check point are on the floor. */
export interface Spots { landmark: Enu; marker: Enu; check: Enu }

/** A first calibration of a Place, with a check point, committed. Returns the flow and what it came to. */
export async function calibrateFirst(t: TestContext, setup: FlowSetup, spots: Spots) {
  const flow = await startFlow(t, setup)
  await flow.placeLandmark(flow.physical(spots.landmark))
  await flow.tap(flow.physical(spots.marker))
  await flow.tap(flow.physical(spots.check))
  flow.press('project-calibration-commit')
  const result = await flow.finish()
  assert.ok(result, 'the first calibration committed')
  assert.ok(result.spatialFrame, 'and wrote the Place frame, with its check point')
  return { flow, result, frame: result.spatialFrame }
}

/**
 * A return visit to a Place whose frame is `frame`, committed: all three points, or two when `skipCheck` says the person
 * skipped the check point the visit asked for. `setup.project` is replaced by the Place with that frame.
 */
export async function revisit(t: TestContext, setup: FlowSetup, frame: unknown, spots: Spots, options: { skipCheck?: boolean } = {}) {
  const flow = await startFlow(t, { ...setup, project: { spatialFrame: frame as never } })
  await flow.placeLandmark(flow.physical(spots.landmark))
  await flow.tap(flow.physical(spots.marker))
  if (options.skipCheck) flow.press('project-calibration-check')
  else await flow.tap(flow.physical(spots.check))
  flow.press('project-calibration-commit')
  const result = await flow.finish()
  assert.ok(result, 'the return visit committed')
  return { flow, result }
}

/** The names of what a scene holds at its top level, in order. */
export const namesIn = (scene: THREE.Object3D): string[] => scene.children.map((child) => child.name)

/** How many direct children of a scene carry a name. */
export const countNamed = (scene: THREE.Object3D, name: string): number => scene.children.filter((child) => child.name === name).length

/**
 * How many objects carry a name anywhere in a scene, the groups inside it included. A flow that is running keeps its own
 * copies of the grid and the ghost rings under its `placement` group, which `countNamed` and `namesIn` do not look into.
 */
export function countAnywhere(scene: THREE.Object3D, name: string): number {
  let found = 0
  scene.traverse((object) => {
    if (object.name === name) found++
  })
  return found
}
