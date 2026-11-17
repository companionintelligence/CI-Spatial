/**
 * Drives the calibration modal (`runProjectCalibration`, src/ar/project-calibration.ts) the way a person does, against
 * a stand-in for the part of the DOM it touches, and reports what came out of it: the records it returned, what it
 * wrote on its card, and what it left in the scene.
 *
 * Shared by tests/unit/node/wp-calibration-characterisation.test.ts, which holds the modal to goldens recorded from
 * the build before the commit logic moved to src/ar/calibration-commit.ts (WP-04b step 0). The modal is passed in,
 * not imported here, so the same scenarios can be run against any build of it.
 *
 * The stand-in registers every `id="..."` in the markup the modal builds with `innerHTML`, and records writes and
 * clicks. It cannot say how the card looks or whether a thumb can reach a button: the browser specs do that. The
 * modal's imports carry no `.ts` extension (the bundler's habit) and Node wants one, so `loadModal()` registers a
 * resolve hook that supplies it before the modal is loaded.
 *
 * The stand-in for the DOM is the third of its kind: tests/unit/node/calibration_bearing_flow.test.ts and
 * tests/unit/node/wp-calibration-modal.test.ts each hold one of their own, left as they were because step 0 leaves
 * existing tests unchanged. Fold the three into one helper when those files are next touched.
 *
 * Retire or regenerate the goldens this drives when WP-04b step 2 replaces the separation verdict with the fit: they
 * say what the modal did BEFORE that, and from then on a changed golden is the point of the change, not a regression.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import { registerHooks } from 'node:module'
import { mock } from 'node:test'
import * as THREE from 'three'
import type { HitResult } from '../../../../src/ar/provider.ts'
import type { runProjectCalibration } from '../../../../src/ar/project-calibration.ts'
import type { Quat, Vec3 } from '../../../../src/world/types.ts'

export type RunModal = typeof runProjectCalibration

let hooked = false

/** Loads the modal from `moduleUrl` (this build's, unless a test points at another), with extensionless imports resolved. */
export async function loadModal(
  moduleUrl: string = new URL('../../../../src/ar/project-calibration.ts', import.meta.url).href,
): Promise<RunModal> {
  if (!hooked) {
    hooked = true
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
  }
  const loaded = (await import(moduleUrl)) as { runProjectCalibration: RunModal }
  return loaded.runProjectCalibration
}

// ── A stand-in for the part of the DOM the modal touches ─────────────────────────────────────────────

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
    // A button is what its markup says it is called: the card's own sentences name buttons by what the card calls them.
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

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────────

/** The buttons on the card, by the name the scenarios use. */
export const BUTTON_IDS = {
  confirm: 'project-calibration-confirm',
  commit: 'project-calibration-commit',
  /** The one check-point button: it skips the step, adds the point back from review, or takes a placed one away (WP-04b). */
  check: 'project-calibration-check',
  replace: 'project-calibration-replace',
  /** The mismatch screen's way back to the markers (WP-04b). */
  adjust: 'project-calibration-adjust',
  override: 'project-calibration-override',
  /** The mismatch screen's way out to another Place: shown only when the host supplies `onWrongPlace` (WP-04b). */
  'wrong-place': 'project-calibration-wrong-place',
  'skip-ground': 'project-calibration-skip-ground',
  fallback: 'project-calibration-fallback',
  skip: 'project-calibration-skip',
} as const

export type ButtonName = keyof typeof BUTTON_IDS

export type Step =
  /** A floor tap: the runtime's hit test answers `tap`, and the touch lands at `at` on the canvas (normalised). */
  | { tap: Vec3; at?: { x: number; y: number } }
  /**
   * A touch the runtime cannot read: its hit test finds nothing there (`'nothing'`: it answers null) or fails on it
   * (`'error'`: it rejects). Either way the modal is asked for a hit and gets none.
   */
  | { miss: 'nothing' | 'error'; at?: { x: number; y: number } }
  /** A click on a button. Made whether or not the card is showing it: a hidden or disabled button is what a script reaches. */
  | { press: ButtonName }
  /** Text typed into the label field the card is showing. */
  | { type: string }
  /** The device compass changes to this reading (null: no fix). */
  | { compass: number | null }
  /** Every camera frame the modal asked for, and was left waiting on, arrives, and so does each it asks for next (one at a time). */
  | { release: true }
  /** The clock moves on by this many milliseconds, and the modal's 200 ms poll runs as often as that allows. */
  | { advance: number }
  /** Record the card as it stands now, under this name. */
  | { look: string }
  /**
   * Run a function with a look at the card's elements by id (WP-08): for the buttons and fields the goldens do not
   * cover. It may press one, which is a click like any other, and it may assert. Nothing is recorded.
   */
  | { run: (card: CardElements) => void | Promise<void> }

/** The card's elements by id: what a `{ run }` step can read and press. */
export interface CardElements {
  el(id: string): { hidden: boolean; disabled: boolean; textContent: string; click(): void }
}

export interface Scenario {
  name: string
  /** What this pins, and why it is worth pinning. */
  about: string
  /** The Place's stored frame, as the project record holds it. */
  stored?: unknown
  /** The device compass at the start (default 100). `null`: no compass fix. */
  compass?: number | null
  /** The page's query string (`?bearing=1` selects the old sign rule). */
  search?: string
  /** Members to give the provider beside the three it always has (a frame epoch, say). Default: none. */
  provider?: Record<string, unknown>
  /** Extra options for the modal, laid over the driver's own (WP-08: the Place-reference hooks). */
  options?: Partial<Parameters<RunModal>[0]>
  /** `'immediate'`: the host answers every camera-frame request at once. `'deferred'`: it answers on `{ release: true }`. Default: no accessor. */
  capture?: 'immediate' | 'deferred'
  steps: Step[]
}

/** What the card showed at one moment. */
export interface Card {
  title: string
  copy: string
  status: string
  separation: { hidden: boolean; state: string | undefined; text: string }
  /** The readout of how three or more points sit against the stored ones (WP-04b). Left out of a look while it is hidden. */
  fit?: { state: string | undefined; text: string }
  label: { hidden: boolean; caption: string; value: string }
  /** The buttons the card is showing, in the order of `BUTTON_IDS`. */
  shown: ButtonName[]
  /** The buttons that are disabled, whether or not they are showing. */
  disabled: ButtonName[]
}

export interface Outcome {
  /** Whether the modal resolved. */
  closed: boolean
  /** What it resolved to: the records, with each photo's bytes reduced to their length. `undefined` while open. */
  result: unknown
  looks: Record<string, Card>
  /** What the modal left in the scene, top level only. */
  scene: Array<{ name: string; position: [number, number, number] }>
  /** How often it asked the host for each thing. */
  counts: { hitTests: number; compass: number; pose: number; captures: number }
}

/** Where the floor is in the session, metres. The taps land on it. */
export const FLOOR_Y = -1.2

/** A camera turned 45 degrees about the vertical, so the bearing the frame records is not the compass reading. */
export const SCENARIO_CAMERA: Quat = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) }

/** The moment every scenario runs at, so a record's `calibratedAt` is the same on every machine. */
export const SCENARIO_NOW = Date.UTC(2026, 10, 16, 9, 30, 0)

/**
 * The floor grid a commit hands to the scene so that it stays for the whole scan (WP-07, owner R10). It is on the scene
 * after every commit, in the same place and for the same reason, so these scenarios do not list it with what a commit
 * drops: tests/unit/node/wp-return-visit-aids.test.ts holds the grid to what it should do, kept after a commit and gone
 * after a skip.
 */
const KEPT_FLOOR_GRID = 'calibration floor plane'

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const OVERRIDDEN_GLOBALS = ['document', 'location'] as const

/** Runs one scenario through `runModal` and reports what happened. Leaves the process as it found it. */
export async function runScenario(runModal: RunModal, scenario: Scenario): Promise<Outcome> {
  const card = new FakeElement()
  const canvas = new FakeElement()
  const scene = new THREE.Scene()
  const counts = { hitTests: 0, compass: 0, pose: 0, captures: 0 }
  const looks: Record<string, Card> = {}
  let hit: Vec3 = { x: 0, y: FLOOR_Y, z: 0 }
  let answer: 'hit' | 'nothing' | 'error' = 'hit'
  let detachedHitTests = 0
  let compass: number | null = scenario.compass === undefined ? 100 : scenario.compass
  const waiting: Array<() => void> = []

  const saved = new Map(OVERRIDDEN_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const))
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => card, body: { appendChild: () => {} } },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'location', { value: { search: scenario.search ?? '' }, configurable: true, writable: true })
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: SCENARIO_NOW })

  const frame = () => ({
    blob: new Blob(['frame']),
    thumbDataUrl: 'data:image/jpeg;base64,AAAA',
    pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: SCENARIO_CAMERA },
    frameSize: { width: 400, height: 400 },
  })
  const capturePhoto = scenario.capture === undefined
    ? undefined
    : () => {
        counts.captures += 1
        if (scenario.capture === 'immediate') return Promise.resolve(frame())
        return new Promise<ReturnType<typeof frame>>((resolve) => waiting.push(() => resolve(frame())))
      }

  const project = { projectId: 'p1', name: 'Room', createdAt: 0, updatedAt: 0, floors: [], ...(scenario.stored === undefined ? {} : { spatialFrame: scenario.stored }) }
  const options: Parameters<RunModal>[0] = {
    provider: {
      getPose: () => {
        counts.pose += 1
        return { position: { x: 0, y: 1.5, z: 0 }, rotation: SCENARIO_CAMERA }
      },
      isTracking: () => true,
      getScene: () => scene,
      ...scenario.provider,
    } as never,
    project: project as never,
    canvas: canvas as never,
    // A method, and one that notices when it is called without its options object: a host's hit test may be a method
    // of an object, and the modal has always called it as one (`options.hitTest(x, y)`).
    async hitTest(this: unknown): Promise<HitResult | null> {
      counts.hitTests += 1
      if (this !== options) detachedHitTests += 1
      if (answer === 'nothing') return null
      if (answer === 'error') throw new Error('no surface')
      return { position: hit, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 1.5 }
    },
    bearing: () => {
      counts.compass += 1
      return compass
    },
    ground: () => ({ y: FLOOR_Y, locked: true }),
    ...(capturePhoto ? { capturePhoto } : {}),
    ...(scenario.options ?? {}),
  }
  const result = runModal(options)
  let closed = false
  let resolved: unknown
  void result.then((value) => {
    closed = true
    resolved = value
  })

  const part = (id: string) => card.parts.get(id)!
  const read = (): Card => {
    const names = Object.keys(BUTTON_IDS) as ButtonName[]
    const separation = part('project-calibration-separation')
    const fit = part('project-calibration-fit')
    const label = part('project-calibration-label-field')
    return {
      title: part('project-calibration-title').textContent,
      copy: part('project-calibration-copy').textContent,
      status: part('project-calibration-status').textContent,
      separation: { hidden: separation.hidden, state: separation.dataset['state'], text: separation.textContent },
      ...(fit.hidden ? {} : { fit: { state: fit.dataset['state'], text: fit.textContent } }),
      label: { hidden: label.hidden, caption: part('project-calibration-label-caption').textContent, value: part('project-calibration-label-input').value },
      shown: names.filter((name) => !part(BUTTON_IDS[name]).hidden),
      disabled: names.filter((name) => part(BUTTON_IDS[name]).disabled),
    }
  }

  let taps = 0
  try {
    for (const step of scenario.steps) {
      if ('tap' in step || 'miss' in step) {
        if ('tap' in step) hit = step.tap
        answer = 'miss' in step ? step.miss : 'hit'
        const at = step.at ?? { x: 0.25 + 0.1 * taps, y: 0.5 }
        taps += 1
        canvas.fire('touchstart', { touches: [{ clientX: at.x * 100, clientY: at.y * 100 }] })
      } else if ('press' in step) {
        part(BUTTON_IDS[step.press]).click()
      } else if ('type' in step) {
        const input = part('project-calibration-label-input')
        input.value = step.type
        input.fire('input')
      } else if ('compass' in step) {
        compass = step.compass
      } else if ('run' in step) {
        await step.run({ el: (id) => part(id) })
      } else if ('release' in step) {
        // Every request, and the ones an answer makes the modal ask for next: it asks for one frame at a time.
        for (let round = 0; round < 8 && waiting.length > 0; round++) {
          waiting.splice(0).forEach((arrive) => arrive())
          await settle()
        }
      } else if ('advance' in step) {
        mock.timers.tick(step.advance)
      } else {
        looks[step.look] = read()
      }
      await settle()
    }
    if (detachedHitTests > 0) {
      throw new Error(`the modal called the host's hit test ${detachedHitTests} time(s) without its options object as \`this\``)
    }
    return {
      closed,
      result: closed ? plain(resolved) : undefined,
      looks,
      scene: scene.children
        .filter((child) => child.name !== 'calibration placement' && child.name !== KEPT_FLOOR_GRID)
        .map((child) => ({ name: child.name, position: [child.position.x, child.position.y, child.position.z] as [number, number, number] })),
      counts,
    }
  } finally {
    if (!closed) {
      part(BUTTON_IDS.skip).click()
      await settle()
    }
    mock.timers.reset()
    for (const name of OVERRIDDEN_GLOBALS) {
      const had = saved.get(name)
      if (had) Object.defineProperty(globalThis, name, had)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

/** The modal's result as plain data: each photo's bytes are reduced to their length, nothing else is touched. */
function plain(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result
  const record = result as { referencePhotos?: Array<{ blob: Blob }> }
  if (!Array.isArray(record.referencePhotos)) return result
  return { ...record, referencePhotos: record.referencePhotos.map((photo) => ({ ...photo, blob: photo.blob.size })) }
}
