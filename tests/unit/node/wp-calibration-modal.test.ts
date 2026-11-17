/**
 * The calibration modal, run for real against a stand-in document (WP-02).
 *
 * `runProjectCalibration` is the part of the app where a person decides which frame a scan goes into, and
 * these claims about it are only true if the modal draws them: the one-point button is not there on a Place
 * that already has a two-point frame (a one-point scan would sit in another frame, rotated by the baseline's
 * bearing) or on one whose frame it does not recognise, and a click that reaches it anyway is refused; it
 * carries the honest label where it is offered; a first visit is told to walk 3 m or more and what the walk is
 * worth; and a return visit is told to tap last time's marker and is never told to walk farther, because a pair
 * of another length is a mismatch with the stored one. `wp-one-point-offer.test.ts` and `baseline_guidance.test.ts`
 * hold the decisions and the sentences. This file holds the modal to them.
 *
 * The modal is a DOM module whose imports carry no `.ts` extension, which Node's loader does not resolve, so
 * the file registers a resolve hook that supplies it, and loads the modal after that. The document is a small
 * stand-in with only what the modal uses: it reads the modal's own markup for the elements that have an id.
 * Time is the mock timer's, so the 200 ms poll runs when the test says and not before.
 *
 * What it does not do: place a pair on a real camera, draw anything (the provider has no scene), or exercise
 * the commit's persistence. The Playwright spec tests/mock-two-point-calibration.spec.ts drives those.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-calibration-modal.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { transformPoint, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

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

// ── A stand-in for the document ────────────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void

class FakeElement {
  readonly tag: string
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
  innerWidth = 0
  readonly classList = {
    names: new Set<string>(),
    add: (...names: string[]) => { for (const name of names) this.classList.names.add(name) },
    remove: (...names: string[]) => { for (const name of names) this.classList.names.delete(name) },
    toggle: (name: string, on?: boolean) => { if (on ?? !this.classList.names.has(name)) this.classList.names.add(name); else this.classList.names.delete(name) },
    contains: (name: string) => this.classList.names.has(name),
  }
  constructor(tag: string) { this.tag = tag }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  removeEventListener(type: string, fn: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((each) => each !== fn)) }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({}) }
  appendChild(node: FakeElement): FakeElement { return node }
  remove(): void {}
  /** Only the one query the modal makes of an element: the steps' `li` items. */
  querySelectorAll(_selector: string): FakeElement[] { return this.items }
}

/** The section the modal builds. Its `innerHTML` is read once, for the elements that carry an id. */
class FakeSection extends FakeElement {
  byId = new Map<string, FakeElement>()
  steps: FakeElement[] = []
  set innerHTML(markup: string) {
    this.byId.clear()
    this.steps = []
    // Each tag, its attributes, and the text up to the next tag. Enough for this markup, which has no nesting that matters.
    for (const [, tag, attributes, text] of markup.matchAll(/<(\w+)([^>]*)>([^<]*)/g)) {
      const element = new FakeElement(tag!)
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

// ── A Place, a provider and a canvas ───────────────────────────────────────────────────────────────

const stored = (frame: Record<string, unknown>): ProjectSpatialFrame =>
  ({ version: 1, createdAt: '2026-11-01T00:00:00.000Z', ...frame }) as ProjectSpatialFrame

const TWO_POINT = stored({
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 1.0 },
  separationM: 1.0,
  toleranceM: 0.15,
  anchorBearingDeg: 12,
})
const ONE_POINT = stored({ method: 'ground-tap-compass', anchorBearingDeg: 12 })
/** A Place whose stored pair is 1.5 m long: what a visit under the old "walk 1.0 m" copy typically left behind. */
const TWO_POINT_1_5 = stored({
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 1.5 },
  separationM: 1.5,
  toleranceM: 0.15,
  anchorBearingDeg: 12,
})

function placeWith(spatialFrame: ProjectSpatialFrame | undefined): Project {
  return { projectId: 'place-1', name: 'Kitchen', ...(spatialFrame ? { spatialFrame } : {}) } as unknown as Project
}

interface Session {
  section: FakeSection
  /** A tap at a floor point, `across` metres along x and `ahead` along -z from where the session began. */
  tapAt(across: number, ahead: number): Promise<void>
  /** Run the 200 ms poll once, so the modal redraws and leaves the ground stage. */
  poll(): Promise<void>
  /** An element of the modal by id. */
  el(id: string): FakeElement
  /** Press a modal button by id. */
  press(id: string): Promise<void>
  /** Whether the modal is still waiting: it has not resolved with a calibration or without one. */
  isOpen(): boolean
  result: Promise<unknown>
}

/** Where the phone is pointing, as a turn about the vertical in degrees: a test turns it to walk to another point. */
let cameraYawDeg = 0
const cameraRotation = () => ({ x: 0, y: Math.sin((cameraYawDeg * Math.PI) / 360), z: 0, w: Math.cos((cameraYawDeg * Math.PI) / 360) })

/** Settles every promise the modal has started: a tap's hit-test, and the redraw after it. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }

async function openModal(project: Project, extra: Record<string, unknown> = {}): Promise<Session> {
  const section = new FakeSection('section')
  const canvas = new FakeElement('canvas') as FakeElement & { getBoundingClientRect(): unknown }
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { createElement: () => section, body: { appendChild: () => {} } },
  })
  const provider = {
    isTracking: () => true,
    getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation: cameraRotation() }),
    getScene: () => null,
  }
  const result = runProjectCalibration({
    provider: provider as never,
    project,
    canvas: canvas as never,
    // A floor tap at normalised (x, y): the mock's own map, 4 m across and 3 m deep.
    hitTest: async (x: number, y: number) => ({
      position: { x: (x - 0.5) * 4, y: 0, z: -y * 3 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      distance: 2,
    }) as never,
    bearing: () => 12,
    ground: () => ({ y: 0, locked: true }),
    ...extra,
  })
  let open = true
  void result.then(() => { open = false })
  const session: Session = {
    section,
    result,
    isOpen: () => open,
    el: (id) => {
      const found = section.byId.get(id)
      assert.ok(found, `the modal has #${id}`)
      return found
    },
    poll: async () => { mock.timers.tick(200); await settle() },
    async tapAt(across, ahead) {
      const touch = { clientX: (across / 4 + 0.5) * 400, clientY: (ahead / 3) * 800 }
      for (const fn of canvas.listeners.get('touchstart') ?? []) fn({ touches: [touch] })
      await settle()
      mock.timers.tick(200)
      await settle()
    },
    async press(id) { session.el(id).click(); await settle(); mock.timers.tick(200); await settle() },
  }
  await session.poll()
  return session
}

const FALLBACK = 'project-calibration-fallback'
const ONE_POINT_LABEL = 'Continue with one point (this scan will not line up with other scans)'

test.beforeEach(() => { cameraYawDeg = 0; mock.timers.enable({ apis: ['setInterval', 'Date'] }) })
test.afterEach(() => { mock.timers.reset(); Reflect.deleteProperty(globalThis, 'document') })

test('a first visit is offered the one-point tier from the landmark on, under the label that says what it costs', async () => {
  const { el, tapAt, press } = await openModal(placeWith(undefined))
  assert.equal(el(FALLBACK).textContent, ONE_POINT_LABEL, 'the markup carries the label')
  assert.equal(el(FALLBACK).hidden, true, 'nothing to continue with before a landmark')

  await tapAt(-1.2, 1)
  assert.equal(el('project-calibration-confirm').hidden, false, 'the landmark is placed')
  assert.equal(el(FALLBACK).hidden, false, 'now the one-point tier is offered')

  await press('project-calibration-confirm')
  assert.equal(el(FALLBACK).hidden, false, 'and it stays offered while the heading marker is placed')
  assert.match(el('project-calibration-copy').textContent, /^Step 2 of 3 — walk 3 m or more from the landmark/, 'the check point follows the heading marker by itself: three taps')
})

test('a Place with a two-point frame is never offered it, at the landmark, the heading step or the review', async () => {
  const { el, tapAt, press } = await openModal(placeWith(TWO_POINT))
  await tapAt(-1.2, 1)
  assert.equal(el('project-calibration-confirm').hidden, false, 'the landmark is placed, so the button would have shown')
  assert.equal(el(FALLBACK).hidden, true, 'landmark step')

  await press('project-calibration-confirm')
  assert.equal(el(FALLBACK).hidden, true, 'heading step')

  await tapAt(1.2, 1)
  assert.equal(el('project-calibration-commit').hidden, false, 'both markers are placed: the review')
  assert.equal(el(FALLBACK).hidden, true, 'review step')
  assert.equal(el('project-calibration-skip').hidden, false, 'a person with no second point can still continue uncalibrated')
})

test('a Place whose frame is itself one-point is offered it as a first visit is', async () => {
  const { el, tapAt } = await openModal(placeWith(ONE_POINT))
  await tapAt(-1.2, 1)
  assert.equal(el(FALLBACK).hidden, false)
  assert.equal(el(FALLBACK).textContent, ONE_POINT_LABEL)
})

test('the separation line under the pair says estimate, and tells a short walk to walk 3 m or more', async () => {
  const { el, tapAt, press } = await openModal(placeWith(undefined))
  await tapAt(-1.2, 1)
  await press('project-calibration-confirm')
  await tapAt(0.0, 1)                       // 1.2 m from the landmark: enough to commit, and short of 3 m
  const line = el('project-calibration-separation')
  assert.equal(line.hidden, false)
  assert.equal(line.dataset['state'], 'ok')
  assert.match(line.textContent, /^1\.20 m apart\. Estimate: two scans would place a spot 5 m away up to about \d+\.\d cm apart \(95 of 100 times\)\. 3 m or more is better\.$/)
  assert.equal(el('project-calibration-commit').disabled, false)
})

test('a walk of 3 m or more is not told to walk further, and still gets its estimate', async () => {
  const { el, tapAt, press } = await openModal(placeWith(undefined))
  await tapAt(-1.8, 1)
  await press('project-calibration-confirm')
  await tapAt(1.8, 1)                       // 3.6 m
  const line = el('project-calibration-separation')
  assert.equal(line.dataset['state'], 'ok')
  assert.match(line.textContent, /^3\.60 m apart\. Estimate: two scans would place a spot 5 m away up to about \d+\.\d cm apart \(95 of 100 times\)\.$/)
  assert.doesNotMatch(line.textContent, /better/)
})

test('under the hard minimum the pair cannot be committed, and the line says why', async () => {
  const { el, tapAt, press } = await openModal(placeWith(undefined))
  await tapAt(-1.2, 1)
  await press('project-calibration-confirm')
  await tapAt(-0.6, 1)                      // 0.6 m from the landmark
  const line = el('project-calibration-separation')
  assert.equal(line.dataset['state'], 'short')
  assert.match(line.textContent, /^0\.60 m apart — need at least 1\.0 m\. Walk further and tap again\.$/)
  assert.equal(el('project-calibration-commit').disabled, true)
})

test('on a return visit the estimate is for the stored pair: a short stored pair is not hidden behind a long walk', async () => {
  const { el, tapAt, press } = await openModal(placeWith(TWO_POINT))   // stored baseline 1.0 m
  await tapAt(-1.8, 1)
  await press('project-calibration-confirm')
  await tapAt(1.2, 1)                       // 3.0 m this visit
  assert.equal(
    el('project-calibration-separation').textContent,
    '3.00 m apart. Stored pair: 1.00 m. Estimate: two scans would place a spot 5 m away up to about 59.2 cm apart (95 of 100 times).',
  )
})

// ── A return visit is not told to walk farther ─────────────────────────────────────────────────────
//
// The commit compares this visit's pair with the stored one and turns away a length more than the tolerance off
// (the mismatch screen), whose way out, "Use anyway", replaces the Place's frame. So on a Place with a stored pair
// the copy has to ask for that pair. These tests run the modal as a person would on a return visit, both ways.

test('a return visit is told to tap Point B again and how far it was from Point A, not to walk 3 m', async () => {
  const { el, tapAt, press } = await openModal(placeWith(TWO_POINT_1_5))
  await tapAt(-0.75, 1)
  await press('project-calibration-confirm')
  // WP-07: the step names the point, the spot ("last time": this Place stores no photo) and the distance it was. The
  // wording is src/ar/return-visit-copy.ts's, and the line it replaced is what `?returnaids=off` still says. The allowance is the
  // one the commit applies (16.8 cm, 0.17 m), and not this record's own 15 cm, which the commit no longer reads.
  assert.equal(
    el('project-calibration-copy').textContent,
    'Step 2 of 2 — tap Point B again, the same spot as last time. Point B was 1.50 m from A (allowed ±0.17 m).',
  )
  await tapAt(0.75, 1)                      // 1.50 m: the stored pair again
  const line = el('project-calibration-separation')
  assert.equal(line.dataset['state'], 'ok')
  assert.equal(line.textContent, '1.50 m apart. Stored pair: 1.50 m. Estimate: two scans would place a spot 5 m away up to about 39.8 cm apart (95 of 100 times).')
  assert.doesNotMatch(line.textContent, /better|or more|walk/i)
})

test('a return visit that taps the stored pair again commits, provisional by distance, with no mismatch screen on the way', async () => {
  const { el, tapAt, press, result, isOpen } = await openModal(placeWith(TWO_POINT_1_5))
  await tapAt(-0.75, 1)
  await press('project-calibration-confirm')
  await tapAt(0.75, 1)
  assert.equal(el('project-calibration-commit').disabled, false)
  await press('project-calibration-commit')
  assert.equal(isOpen(), false, 'the modal resolved')
  const outcome = await result as { calibration: { status: string, method: string, residualM: number, checkedBy?: string }, spatialFrame?: unknown }
  assert.equal(outcome.calibration.status, 'provisional', 'two points compare a distance and nothing else: never verified')
  assert.equal(outcome.calibration.checkedBy, 'separation')
  assert.equal(outcome.calibration.method, 'two-point-ground')
  assert.ok(Math.abs(outcome.calibration.residualM) < 1e-9, 'the pair is the stored length')
  assert.equal(outcome.spatialFrame, undefined, 'the Place\'s stored frame is kept, not rewritten')
})

test('what the first-visit copy asks for, a walk of 3 m, is a mismatch on a return visit: the reason the copy differs', async () => {
  const { el, tapAt, press, isOpen } = await openModal(placeWith(TWO_POINT_1_5))
  await tapAt(-1.5, 1)
  await press('project-calibration-confirm')
  await tapAt(1.5, 1)                       // 3.0 m against a stored 1.5 m
  await press('project-calibration-commit')
  assert.equal(isOpen(), true, 'not committed')
  assert.equal(el('project-calibration-title').textContent, 'These markers do not match the stored pair')
  assert.equal(el('project-calibration-override').hidden, false, '"Use anyway" would replace the stored frame')
})

test('a Place whose frame is not two-point is told to walk 3 m or more, as a first visit is', async () => {
  const { el, tapAt, press } = await openModal(placeWith(ONE_POINT))
  await tapAt(-1.2, 1)
  await press('project-calibration-confirm')
  assert.match(el('project-calibration-copy').textContent, /^Step 2 of 3 — walk 3 m or more from the landmark/)
  await tapAt(0.0, 1)                       // 1.2 m
  assert.doesNotMatch(el('project-calibration-separation').textContent, /Stored pair/)
  assert.match(el('project-calibration-separation').textContent, /3 m or more is better\.$/)
})

// ── The one-point button: hidden, and refused when clicked ─────────────────────────────────────────

test('a click that reaches the hidden one-point button on a Place with a two-point frame commits nothing', async () => {
  const { el, tapAt, isOpen } = await openModal(placeWith(TWO_POINT))
  await tapAt(-1.2, 1)
  assert.equal(el(FALLBACK).hidden, true)
  el(FALLBACK).click()                      // what a script can do and a person cannot
  await settle()
  assert.equal(isOpen(), true, 'the modal is still waiting for a second point: no one-point frame was made')
})

test('the same click on a first visit with a landmark placed does commit the one-point tier, and before the landmark it does not', async () => {
  const early = await openModal(placeWith(undefined))
  early.el(FALLBACK).click()
  await settle()
  assert.equal(early.isOpen(), true, 'no landmark, nothing to continue with')

  const { el, tapAt, result, isOpen } = await openModal(placeWith(undefined))
  await tapAt(-1.2, 1)
  assert.equal(el(FALLBACK).hidden, false)
  el(FALLBACK).click()
  await settle()
  assert.equal(isOpen(), false)
  const outcome = await result as { calibration: { method: string, status: string } }
  assert.deepEqual([outcome.calibration.method, outcome.calibration.status], ['ground-tap-compass', 'provisional'])
})

// A stored frame of a kind this build does not know is not a Place with no frame: it is not offered the one-point tier.
for (const [name, method] of [['an unknown method', 'three-point-ground'], ['a made-up method', 'banana'], ['no method at all', undefined]] as const) {
  test(`a stored frame with ${name} is not offered the one-point tier, and a click on it is refused`, async () => {
    const frame = stored(method === undefined ? {} : { method })
    const { el, tapAt, isOpen } = await openModal(placeWith(frame))
    await tapAt(-1.2, 1)
    assert.equal(el('project-calibration-confirm').hidden, false, 'the landmark is placed, so the button would have shown')
    assert.equal(el(FALLBACK).hidden, true)
    el(FALLBACK).click()
    await settle()
    assert.equal(isOpen(), true)
  })
}

// ── The check-point step (WP-04b) ──────────────────────────────────────────────────────────────────

/** The state of each progress dot, by step. */
const dots = (session: Session): Record<string, string | undefined> =>
  Object.fromEntries(session.section.steps.map((li) => [li.dataset['step']!, li.dataset['state']]))
const dotsHidden = (session: Session): Record<string, boolean> =>
  Object.fromEntries(session.section.steps.map((li) => [li.dataset['step']!, li.hidden]))

test('a first visit has four dots, and the check dot is the one that is lit once the heading marker is down', async () => {
  const session = await openModal(placeWith(undefined))
  assert.deepEqual(Object.keys(dots(session)), ['ground', 'landmark', 'heading', 'check'])
  assert.equal(dotsHidden(session)['check'], false)
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  assert.deepEqual(dots(session), { ground: 'done', landmark: 'done', heading: 'active', check: 'todo' })
  await session.tapAt(1.8, 1)                              // 3.6 m: the check-point step opens by itself
  assert.deepEqual(dots(session), { ground: 'done', landmark: 'done', heading: 'done', check: 'active' })
  assert.equal(session.el('project-calibration-title').textContent, 'Add a check point (recommended)')
  assert.equal(session.el('project-calibration-commit').hidden, true, 'the step is answered first: skip it, or place the point')
  assert.equal(session.el('project-calibration-check').hidden, false)
  assert.equal(session.el('project-calibration-check').textContent, 'Skip the check point')
})

test('a Place whose pair is stored with no check point is never offered one: no step, no dot, no button, and a click on the button does nothing', async () => {
  const session = await openModal(placeWith(TWO_POINT_1_5))
  assert.equal(dotsHidden(session)['check'], true, 'the check dot is not shown')
  await session.tapAt(-0.75, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(0.75, 1)                             // the stored 1.5 m pair again
  assert.equal(session.el('project-calibration-commit').hidden, false, 'straight to review: nothing is added to an existing frame')
  assert.equal(session.el('project-calibration-check').hidden, true)
  session.el('project-calibration-check').click()          // what a script can do
  await settle()
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  assert.equal(session.isOpen(), true)
})

test('skipping the check point goes to review with the commit on offer, and the button then offers to add it back', async () => {
  const session = await openModal(placeWith(undefined))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.press('project-calibration-check')
  assert.equal(session.el('project-calibration-commit').hidden, false)
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  assert.equal(session.el('project-calibration-check').textContent, 'Add a check point (recommended)')
  assert.deepEqual(dots(session), { ground: 'done', landmark: 'done', heading: 'active', check: 'skipped' }, 'the step is not coming: not "to do"')
})

test('the check point can be added back from review and taken away again, and the frame stores it only while it is there', async () => {
  // Skipped, then added back from review.
  const added = await openModal(placeWith(undefined))
  await added.tapAt(-1.8, 1)
  await added.press('project-calibration-confirm')
  await added.tapAt(1.8, 1)
  await added.press('project-calibration-check')           // skip
  assert.equal(added.el('project-calibration-check').textContent, 'Add a check point (recommended)')
  await added.press('project-calibration-check')           // add it back
  assert.equal(added.el('project-calibration-title').textContent, 'Add a check point (recommended)')
  assert.equal(added.el('project-calibration-commit').hidden, true, 'the step is answered first')
  assert.equal(added.el('project-calibration-check').textContent, 'Skip the check point')
  await added.tapAt(0, 3)
  assert.equal(added.el('project-calibration-title').textContent, 'Check the alignment')
  assert.match(added.el('project-calibration-separation').textContent, /^Point C: \d+\.\d m from A, 2\.0 m off the A–B line\./)
  assert.equal(added.el('project-calibration-check').textContent, 'Remove the check point')
  await added.press('project-calibration-commit')
  const withCheck = await added.result as { spatialFrame?: { checkPoints?: unknown[] } }
  assert.equal(withCheck.spatialFrame?.checkPoints?.length, 1)

  // Placed, then taken away.
  const removed = await openModal(placeWith(undefined))
  await removed.tapAt(-1.8, 1)
  await removed.press('project-calibration-confirm')
  await removed.tapAt(1.8, 1)
  await removed.tapAt(0, 3)
  assert.equal(removed.el('project-calibration-check').textContent, 'Remove the check point')
  await removed.press('project-calibration-check')
  assert.equal(removed.el('project-calibration-check').textContent, 'Add a check point (recommended)')
  assert.doesNotMatch(removed.el('project-calibration-separation').textContent, /Point C/, 'the line is the pair\'s again')
  assert.equal(dots(removed)['check'], 'skipped')
  await removed.press('project-calibration-commit')
  const without = await removed.result as { spatialFrame?: Record<string, unknown> }
  assert.ok(without.spatialFrame)
  assert.equal('checkPoints' in without.spatialFrame!, false)
})

test('a pair under the minimum does not open the step, and does not offer the check point from review either', async () => {
  const session = await openModal(placeWith(undefined))
  await session.tapAt(-1.2, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(-0.6, 1)                             // 0.6 m: review, to be fixed
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  assert.equal(session.el('project-calibration-check').hidden, true)
})

test('the camera is asked for one frame at a time: each marker\'s photo waits for the one asked for before it, however fast the person taps', async () => {
  // A host that is slow to answer: every request waits until the test answers it. A second request while one is pending is refused by
  // the provider ("Capture already pending"), which would cost the photo.
  const pending: Array<() => void> = []
  let asked = 0
  let inFlight = 0
  let most = 0
  const capturePhoto = () => {
    asked += 1
    inFlight += 1
    most = Math.max(most, inFlight)
    return new Promise<null>((resolve) => pending.push(() => { inFlight -= 1; resolve(null) }))
  }
  const answer = async () => { pending.shift()!(); await settle() }
  const session = await openModal(placeWith(undefined), { capturePhoto })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')       // the landmark's photo is asked for
  assert.equal(asked, 1)
  await session.tapAt(1.8, 1)                              // the heading marker is tapped while the landmark's is still pending
  assert.equal(asked, 1, 'and its photo waits')
  await answer()
  assert.equal(asked, 2, 'asked for as soon as the one before it is back')
  await session.tapAt(0, 3)                                // the check point likewise
  assert.equal(asked, 2)
  await answer()
  assert.equal(asked, 3)
  await session.press('project-calibration-commit')        // waits for the last photo, and asks for no other
  assert.equal(session.isOpen(), true, 'the commit waits for the photo that is pending')
  await answer()
  await session.result
  assert.equal(asked, 3, 'one frame for each of the three markers')
  assert.equal(most, 1, 'never two at once')
})

/** A frame as the host answers a request for one: the pose it was taken at is where the phone was pointing then. */
const frameNow = () => ({
  blob: new Blob(['frame']),
  thumbDataUrl: 'data:image/jpeg;base64,AAAA',
  pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: cameraRotation() },
  frameSize: { width: 400, height: 800 },
})
/** The turn about the vertical, in whole degrees, a photo's pose records. */
const yawOf = (rotation: { y: number; w: number }) => Math.round((2 * Math.atan2(rotation.y, rotation.w) * 180) / Math.PI)

test('a marker is photographed while the person is looking at it: the heading marker at its tap, the check point at its own, and nothing is taken again at Commit', async () => {
  // The person taps B facing it, then walks to the check point 3 m away and turns to it before tapping it. A frame taken for B at
  // Commit would show the view from there, and B's crosshair (where it was tapped on the screen) would point at nothing.
  const takenAt: number[] = []
  const capturePhoto = async () => { takenAt.push(cameraYawDeg); return frameNow() }
  const session = await openModal(placeWith(undefined), { capturePhoto })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  assert.deepEqual(takenAt, [0], 'the landmark, at Confirm')
  await session.tapAt(1.8, 1)                              // B, facing it
  assert.deepEqual(takenAt, [0, 0], 'the heading marker, at its tap')
  cameraYawDeg = 55                                        // turned toward where the check point is
  await session.tapAt(0, 3)
  assert.deepEqual(takenAt, [0, 0, 55], 'the check point, at its own')
  await session.press('project-calibration-commit')
  const result = await session.result as { referencePhotos?: Array<{ role: string; pose: { rotation: { y: number; w: number } } }> }
  assert.deepEqual(takenAt, [0, 0, 55], 'Commit asks for no frame: each marker has the one it was tapped in front of')
  assert.deepEqual(result.referencePhotos?.map((photo) => [photo.role, yawOf(photo.pose.rotation)]), [['landmark', 0], ['headingMarker', 0], ['check1', 55]])
})

test('a marker placed again is photographed again, at the tap that moved it, and the one it had is not kept', async () => {
  const takenAt: number[] = []
  const capturePhoto = async () => { takenAt.push(cameraYawDeg); return frameNow() }
  const session = await openModal(placeWith(undefined), { capturePhoto })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 3)                                // review, the three placed: frames at 0, 0, 0
  assert.deepEqual(takenAt, [0, 0, 0])
  cameraYawDeg = 30
  await session.tapAt(1.8, 1)                              // select the heading marker...
  await session.tapAt(1.4, 1)                              // ...and move it, turned to it
  assert.deepEqual(takenAt, [0, 0, 0, 30], 'a new frame for the marker that moved, and none for the others')
  await session.press('project-calibration-commit')
  const result = await session.result as { referencePhotos?: Array<{ role: string; pose: { rotation: { y: number; w: number } } }> }
  assert.deepEqual(takenAt, [0, 0, 0, 30])
  assert.deepEqual(result.referencePhotos?.map((photo) => [photo.role, yawOf(photo.pose.rotation)]), [['landmark', 0], ['headingMarker', 30], ['check1', 0]])
})

test('a visit to a stored pair photographs nothing at its taps but the landmark, and photographs the markers it keeps when "Use anyway" keeps them', async () => {
  // The stored frame is the reference and keeps its photos, so a visit that matches it needs none: the heading marker is not
  // photographed at its tap. A visit that overrides the frame writes new ones, and takes them then.
  const takenAt: number[] = []
  const capturePhoto = async () => { takenAt.push(cameraYawDeg); return frameNow() }
  const matched = await openModal(placeWith(TWO_POINT_1_5), { capturePhoto })
  await matched.tapAt(-0.75, 1)
  await matched.press('project-calibration-confirm')
  assert.equal(takenAt.length, 1, 'the landmark, at Confirm, as it always was')
  await matched.tapAt(0.75, 1)                             // the stored 1.5 m pair again
  await matched.press('project-calibration-commit')
  const kept = await matched.result as { referencePhotos?: unknown; spatialFrame?: unknown }
  assert.equal(takenAt.length, 1, 'no frame for a heading marker whose photo would not be stored')
  assert.equal(kept.spatialFrame, undefined)
  assert.equal(kept.referencePhotos, undefined)

  takenAt.length = 0
  const overridden = await openModal(placeWith(TWO_POINT_1_5), { capturePhoto })
  await overridden.tapAt(-1.5, 1)
  await overridden.press('project-calibration-confirm')
  await overridden.tapAt(1.5, 1)                           // 3.0 m against a stored 1.5 m: the mismatch screen
  await overridden.press('project-calibration-commit')
  assert.equal(takenAt.length, 1, 'turned back for re-placement: it costs no frame')
  cameraYawDeg = 20
  await overridden.press('project-calibration-override')
  const replaced = await overridden.result as { referencePhotos?: Array<{ role: string }> }
  assert.deepEqual(takenAt, [0, 20], 'the heading marker is photographed when its points are kept')
  assert.deepEqual(replaced.referencePhotos?.map((photo) => photo.role), ['landmark', 'headingMarker'])
})

/** Types into the label field, as a person does. */
function typeLabel(session: Session, text: string): void {
  const input = session.el('project-calibration-label-input')
  input.value = text
  for (const fn of input.listeners.get('input') ?? []) fn({})
}

test('the check step has no label field until its marker is down, and a name typed at the heading step is still there at review', async () => {
  const session = await openModal(placeWith(undefined))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  assert.equal(session.el('project-calibration-label-field').hidden, false)
  assert.equal(session.el('project-calibration-label-caption').textContent, 'Name point B (optional)')
  typeLabel(session, 'radiator corner')
  await session.tapAt(1.8, 1)                              // the check step opens
  assert.equal(session.el('project-calibration-title').textContent, 'Add a check point (recommended)')
  assert.equal(session.el('project-calibration-label-field').hidden, true, 'a field here would name a point that is not there, or the one the card is not asking for')
  await session.tapAt(0, 3)                                // review, the check point just placed
  assert.equal(session.el('project-calibration-label-field').hidden, false)
  assert.equal(session.el('project-calibration-label-caption').textContent, 'Name point C (optional)', 'what is typed now names the point just tapped')
  assert.equal(session.el('project-calibration-label-input').value, '')
  await session.tapAt(1.8, 1)                              // select the heading marker
  assert.equal(session.el('project-calibration-label-caption').textContent, 'Name point B (optional)')
  assert.equal(session.el('project-calibration-label-input').value, 'radiator corner', 'kept from the heading step')
})

test('a heading marker moved during the check step leaves the step open: only the check point, or a pair under the minimum, ends it', async () => {
  const session = await openModal(placeWith(undefined))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  assert.equal(session.el('project-calibration-title').textContent, 'Add a check point (recommended)')
  await session.tapAt(1.8, 1)                              // select the heading marker...
  await session.tapAt(1.4, 1)                              // ...and move it: 3.2 m, still a pair
  assert.equal(session.el('project-calibration-title').textContent, 'Add a check point (recommended)', 'the person has not placed the check point yet')
  assert.deepEqual(dots(session), { ground: 'done', landmark: 'done', heading: 'done', check: 'active' })
  assert.equal(session.el('project-calibration-check').textContent, 'Skip the check point', 'and can still skip it')
  await session.tapAt(1.4, 1)                              // select it again...
  await session.tapAt(-1.2, 1)                             // ...and bring it to 0.6 m from the landmark: under the minimum
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment', 'a pair under the minimum is fixed in review')
  await session.tapAt(-1.2, 1)                             // select it, and move it out to a pair again
  await session.tapAt(1.8, 1)
  assert.equal(session.el('project-calibration-check').textContent, 'Add a check point (recommended)', 'review offers the step it did not open')
  await session.press('project-calibration-check')
  await session.tapAt(0, 3)                                // the check point: review, with it
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  assert.equal(session.el('project-calibration-check').textContent, 'Remove the check point')
})

test('the progress dots mark the step the person is on, for assistive technology: aria-current on one dot, and on none that is done, to do or skipped', async () => {
  const session = await openModal(placeWith(undefined))
  const current = () => session.section.steps.filter((li) => (li as unknown as { ariaCurrent: string | null }).ariaCurrent === 'step').map((li) => li.dataset['step'])
  assert.deepEqual(current(), ['landmark'], 'the floor is settled: the first marker is the step')
  await session.tapAt(-1.8, 1)
  assert.deepEqual(current(), ['landmark'])
  await session.press('project-calibration-confirm')
  assert.deepEqual(current(), ['heading'])
  await session.tapAt(1.8, 1)
  assert.deepEqual(current(), ['check'])
  await session.press('project-calibration-check')         // skipped: review is on the heading marker's step, and the check dot is skipped
  assert.deepEqual(dots(session), { ground: 'done', landmark: 'done', heading: 'active', check: 'skipped' })
  assert.deepEqual(current(), ['heading'])
})

test('the card\'s status and readout are live regions, and a region is written only when its words change: the card redraws five times a second', async () => {
  const markup = readFileSync(join(ROOT, 'src/ar/project-calibration.ts'), 'utf8')
  assert.match(markup, /<div id="project-calibration-status" class="project-calibration-status" role="status">/)
  assert.match(markup, /<div id="project-calibration-fit" class="project-calibration-fit" role="status" hidden>/)

  const session = await openModal(placeWith(undefined))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  const writes: Record<string, number> = { status: 0, fit: 0 }
  for (const [name, id] of [['status', 'project-calibration-status'], ['fit', 'project-calibration-fit']] as const) {
    const element = session.el(id)
    let text = element.textContent
    Object.defineProperty(element, 'textContent', { get: () => text, set: (value: string) => { writes[name]! += 1; text = value }, configurable: true })
  }
  for (let i = 0; i < 5; i++) await session.poll()          // a second of redraws with nothing changed
  assert.deepEqual(writes, { status: 0, fit: 0 }, 'the same words are not written again')
  await session.tapAt(1.8, 1)                              // the card moves on: its words change, and are written
  assert.ok(writes['status']! >= 1)
})

/**
 * A stored constellation made the way a first visit makes it: the pair 3.6 m apart at one metre ahead, and a check point 2 m
 * off the line between them, carried into the frame the pair defines. The same taps re-made are a visit that agrees exactly.
 */
function constellationFrame(): ProjectSpatialFrame {
  const L = { x: -1.8, y: 0, z: -1 }
  const H = { x: 1.8, y: 0, z: -1 }
  const C = { x: 0, y: 0, z: -3 }
  const into = twoPointToProjectTransform(L, H)
  const c = transformPoint(into, C)
  return stored({
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 3.6 },
    separationM: 3.6,
    toleranceM: 0.168,
    anchorBearingDeg: null,
    checkPoints: [{ x: c.x, y: c.y, z: c.z }],
  })
}

/** Re-taps the three points of `constellationFrame()` on a phone whose units the provider names, and returns the readout under them. */
async function readoutOfRetap(scaleKind: (() => string) | undefined): Promise<string> {
  const provider = {
    isTracking: () => true,
    getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    getScene: () => null,
    ...(scaleKind ? { scaleKind } : {}),
  }
  const session = await openModal(placeWith(constellationFrame()), { provider })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)                              // the Place stores a check point: the step opens to re-tap it
  assert.equal(session.el('project-calibration-title').textContent, 'Tap the check point from last time')
  await session.tapAt(0, 3)
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  return session.el('project-calibration-fit').textContent
}

test('the steps count the taps the visit asks for: three where the check point follows the heading marker, two where it is not asked for', async () => {
  const first = await openModal(placeWith(undefined))
  assert.match(first.el('project-calibration-copy').textContent, /^Step 1 of 3 — tap the ground at a permanent feature/)
  await first.tapAt(-1.8, 1)
  await first.press('project-calibration-confirm')
  assert.match(first.el('project-calibration-copy').textContent, /^Step 2 of 3 — walk 3 m or more/)
  await first.tapAt(1.8, 1)
  assert.match(first.el('project-calibration-copy').textContent, /^Step 3 of 3 \(optional\) — tap a third ground feature at least 3 m from point A/)

  // A return visit to a Place that stores a check point asks for three taps, and every step says so: Point A's and Point B's are the
  // return-visit aids' words (WP-07), counted to the visit's three, and the check point's are the constellation flow's.
  const returning = await openModal(placeWith(constellationFrame()))
  assert.match(returning.el('project-calibration-copy').textContent, /^Step 1 of 3 — tap Point A again, the same spot as last time\./)
  await returning.tapAt(-1.8, 1)
  await returning.press('project-calibration-confirm')
  assert.match(returning.el('project-calibration-copy').textContent, /^Step 2 of 3 — tap Point B again, the same spot as last time\. Point B was 3\.60 m from A \(allowed ±0\.17 m\)\./)
  await returning.tapAt(1.8, 1)
  assert.match(returning.el('project-calibration-copy').textContent, /^Step 3 of 3 — tap point C, the check point from last time, about 2\.\d m from the landmark\. It lets this visit compare the shape the three points make/)

  // With the aids off (`?returnaids=off`) the modal's own words stand, and count the same way.
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { search: '?returnaids=off' } })
  try {
    const plain = await openModal(placeWith(constellationFrame()))
    assert.match(plain.el('project-calibration-copy').textContent, /^Step 1 of 3 — tap the ground at a permanent feature/)
    await plain.tapAt(-1.8, 1)
    await plain.press('project-calibration-confirm')
    assert.match(plain.el('project-calibration-copy').textContent, /^Step 2 of 3 — tap the heading marker from last time, about 3\.6 m from the landmark/)
  } finally {
    Reflect.deleteProperty(globalThis, 'location')
  }

  // A Place whose pair has no check point is never asked for one: two taps, and the steps say so.
  const pair = await openModal(placeWith(TWO_POINT_1_5))
  assert.match(pair.el('project-calibration-copy').textContent, /^Step 1 of 2 — /)
  await pair.tapAt(-0.75, 1)
  await pair.press('project-calibration-confirm')
  assert.match(pair.el('project-calibration-copy').textContent, /^Step 2 of 2 — tap Point B again, the same spot as last time\./)
})

test('a return visit is never advised to move the check point it re-taps: the line keeps where it is and the estimate for the stored shape, and the readout takes the placement advice\'s place', async () => {
  // A small room stores a check point nearer than the advice asks for: this one is 1.6 m from the landmark and 1.2 m off the line.
  // The advice ("at least 3 m from A and 2 m off the line is better") is for choosing a point, and this visit is re-tapping one:
  // following it would send the re-tap to the mismatch screen.
  const near = stored({
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 2 },
    separationM: 2,
    toleranceM: 0.168,
    anchorBearingDeg: null,
    checkPoints: [{ x: 1.2, y: 0, z: 1.1 }],
  })
  const session = await openModal(placeWith(near))
  await session.tapAt(-1, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1, 1)                                // the stored 2 m pair
  assert.doesNotMatch(session.el('project-calibration-separation').textContent, /is better|Move point C|another order/, 'the step before the check point')
  await session.tapAt(-0.2, 2.2)                           // roughly the stored point, in this session
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  assert.equal(session.el('project-calibration-fit').hidden, false, 'the readout of how the points sit is what the card shows now')
  assert.equal(session.el('project-calibration-separation').hidden, true, 'and the placement advice is not shown beside it')
})

test('a line that says the points cannot be used stays beside the readout: the commit is not on offer, and the person is told why', async () => {
  const session = await openModal(placeWith(constellationFrame()))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 1)                                // on the line between the pair: the fit cannot use three points on one line
  assert.equal(session.el('project-calibration-fit').hidden, false)
  assert.equal(session.el('project-calibration-separation').hidden, false)
  assert.equal(session.el('project-calibration-separation').dataset['state'], 'short')
  assert.match(session.el('project-calibration-separation').textContent, /almost on one line/)
  assert.equal(session.el('project-calibration-commit').disabled, true)
  assert.equal(session.el('project-calibration-status').textContent, 'The check point cannot be used where it is. Move it or remove it.')
})

test('points that could not be fitted at all (a check point on the wrong side) still draw the check point\'s ghost, across the line from where it was tapped', async () => {
  const scene = new THREE.Scene()
  const provider = {
    isTracking: () => true,
    getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    getScene: () => scene,
  }
  const session = await openModal(placeWith(constellationFrame()), { provider })
  await session.tapAt(-1.8, 2)                             // the pair 1 m further from the camera than the stored frame was made...
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 2)
  await session.tapAt(0, 0)                                // ...and the check point on the other side of the line from where it is stored
  assert.equal(session.el('project-calibration-fit').dataset['state'], 'mismatch')
  assert.doesNotMatch(session.el('project-calibration-fit').textContent, /A \d+\.\d cm/, 'no fit exists, so there are no points to list one by one')
  const rings: THREE.Object3D[] = []
  scene.traverse((object) => { if (object.name === 'calibration stored reference') rings.push(object) })
  assert.deepEqual(rings.map((ring) => ring.userData['role']), ['landmark', 'heading', 'check'], 'the check point has a ghost too')
  const check = rings[2]!
  // The stored check point is on the side of the line away from the camera (z = -3 for a line at z = -1); the tap is on the near side.
  assert.ok(check.position.z < -2.5 && check.position.z > -4.5, `on the far side of the line (z = ${check.position.z})`)
  const gaps: THREE.Object3D[] = []
  scene.traverse((object) => { if (object.name === 'calibration stored reference gap') gaps.push(object) })
  assert.deepEqual(gaps.map((gap) => gap.userData['role']), ['check'], 'a line from the tapped check point to its ghost, and none for the pair')
})

test('a return visit that re-taps all three points reads how far off each is, and ends with what taps cannot check', async () => {
  const text = await readoutOfRetap(undefined)
  const lines = text.split('\n')
  assert.match(lines[0]!, /^3 points are 0\.0 cm off the stored ones on average \(limit 8\.4 cm\)\.$/)
  assert.equal(lines[1], 'A 0.0 cm · B 0.0 cm · C 0.0 cm')
  assert.equal(lines.at(-1), 'Not checked: that these are the same physical spots. Compare with the photos.')
  assert.ok(!/sizes in metres/.test(text), 'a phone that does not say what its units are gets nothing said of them')
})

test('the phone\'s units reach the verdict: where they are not metres, the readout says sizes in metres were not checked', async () => {
  const arbitrary = await readoutOfRetap(() => 'arbitrary')
  assert.equal(arbitrary.split('\n').at(-1), "Not checked: sizes in metres. This phone's units are not metres.")
  const estimated = await readoutOfRetap(() => 'estimated-metric')
  assert.equal(estimated.split('\n').at(-1), 'Not checked: sizes in metres. The phone estimates them.')
  const metric = await readoutOfRetap(() => 'metric')
  assert.ok(!/sizes in metres/.test(metric))
})

test('the stored points drawn while the markers are adjusted are released when the flow ends, and are not left in the scene', async () => {
  const scene = new THREE.Scene()
  const provider = {
    isTracking: () => true,
    getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    getScene: () => scene,
  }
  const session = await openModal(placeWith(constellationFrame()), { provider })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 3)
  const rings: THREE.Object3D[] = []
  scene.traverse((object) => { if (object.name === 'calibration stored reference') rings.push(object) })
  assert.equal(rings.length, 3, 'a ring where each stored point is, drawn once the three points are down')
  assert.deepEqual(rings.map((ring) => ring.userData['role']), ['landmark', 'heading', 'check'])
  const gaps: THREE.Object3D[] = []
  scene.traverse((object) => { if (object.name === 'calibration stored reference gap') gaps.push(object) })
  assert.equal(gaps.length, 0, 'points that agree to the millimetre have no line to their ring')

  await session.press('project-calibration-skip')
  assert.equal(session.isOpen(), false, 'the flow ended')
  assert.equal(scene.getObjectByName('calibration stored reference'), undefined, 'none is left in the scene')
  assert.ok(rings.every((ring) => ring.parent === null), 'and each was taken out of the group that held it, so what it drew can be freed')
})

test('a committed return visit leaves the stored points in the scene for the rest of the session, beside the markers it kept', async () => {
  const scene = new THREE.Scene()
  const provider = {
    isTracking: () => true,
    getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    getScene: () => scene,
  }
  const session = await openModal(placeWith(constellationFrame()), { provider })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 3)
  await session.press('project-calibration-commit')
  assert.equal(session.isOpen(), false)
  const result = await session.result as { calibration: { status: string; checkedBy?: string }; spatialFrame?: unknown }
  assert.equal(result.calibration.status, 'verified')
  assert.equal(result.calibration.checkedBy, 'constellation')
  assert.equal(result.spatialFrame, undefined, 'the stored frame was matched and is kept as it is')
  const names: string[] = []
  scene.traverse((object) => { if (object.name) names.push(object.name) })
  assert.equal(names.filter((name) => name === 'calibration stored reference').length, 3, 'the Place\'s three points, where this session puts them')
  for (const marker of ['calibration anchor landmark', 'calibration anchor heading', 'calibration anchor check']) {
    assert.equal(names.filter((name) => name === marker).length, 1, `${marker} stays`)
  }
})

test('re-placing the points forgets the check point that was tapped: a visit whose second try opens no check step commits none', async () => {
  const session = await openModal(placeWith(undefined))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 3)                                // a check point, 2 m off the line
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  await session.press('project-calibration-replace')
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(-1.2, 1)                             // a pair of 0.6 m: under the minimum, so no check step opens, and it stays in review
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  await session.tapAt(-1.2, 1)                             // select that marker...
  await session.tapAt(1.8, 1)                              // ...and move it out to 3.6 m
  assert.equal(session.el('project-calibration-commit').disabled, false)
  await session.press('project-calibration-commit')
  const result = await session.result as { spatialFrame?: { checkPoints?: unknown } }
  assert.ok(result.spatialFrame, 'a first visit writes the Place frame')
  assert.equal('checkPoints' in result.spatialFrame!, false, 'the tap that was thrown away does not come back')
})

test('a check point tapped on a table is not verified: the markers are drawn level, but the fit is given the heights that were tapped', async () => {
  // The same re-tap as before, with the third tap landing 30 cm above the floor (a table top beside the feature).
  const hitTest = async (x: number, y: number) => ({
    position: { x: (x - 0.5) * 4, y: y > 0.99 ? 0.3 : 0, z: -y * 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    distance: 2,
  }) as never
  const session = await openModal(placeWith(constellationFrame()), { hitTest })
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 3)
  assert.match(session.el('project-calibration-status').textContent, /about 30 cm above the floor/, 'the floor gate asks first')
  await session.tapAt(0, 3)                                // the same height again: "use it anyway"
  const lines = session.el('project-calibration-fit').textContent.split('\n')
  assert.match(lines[0]!, /^3 points are 0\.0 cm off the stored ones on average/, 'the positions agree')
  assert.match(lines.find((line) => line.startsWith('Not verified:')) ?? '', /^Not verified: Heights are \d+\.\d cm off on average \(limit 8\.4 cm\)\.$/)
  assert.equal(session.el('project-calibration-fit').dataset['state'], 'warn')
  await session.press('project-calibration-commit')
  const result = await session.result as { calibration: { status: string; checkedBy?: string } }
  assert.equal(result.calibration.status, 'provisional', 'positions that agree and heights that do not are not verified')
  assert.equal(result.calibration.checkedBy, 'constellation')
})

test('a check point a metre off is a mismatch the card explains in the verdict\'s words, and moving it until the points agree lets the visit commit', async () => {
  const session = await openModal(placeWith(constellationFrame()))
  await session.tapAt(-1.8, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.8, 1)
  await session.tapAt(0, 2)                                // 1 m from the line, where the stored point is 2 m
  // The readout is live: it is already saying so in review, before anything is committed.
  assert.equal(session.el('project-calibration-fit').dataset['state'], 'mismatch')
  assert.match(session.el('project-calibration-fit').textContent, /^3 points are \d+\.\d cm off the stored ones on average \(limit 8\.4 cm\)\./)
  // And the card does not say "Ready to commit." beside it: committing would turn the points back to the mismatch screen.
  assert.equal(session.el('project-calibration-status').textContent, 'These points do not match the stored ones yet.')

  await session.press('project-calibration-commit')
  assert.equal(session.el('project-calibration-title').textContent, 'These points do not match the stored ones')
  assert.equal(session.el('project-calibration-copy').textContent, 'They do not line up with the stored points. Adjust a point, re-place them, or record these points as unverified.')
  const lines = session.el('project-calibration-fit').textContent.split('\n')
  assert.ok(lines.length >= 3 && /^A \d+\.\d cm · B \d+\.\d cm · C \d+\.\d cm$/.test(lines.at(-1)!), `the points one by one close the list: ${lines.join(' | ')}`)
  assert.ok(!lines.includes('Not checked: that these are the same physical spots. Compare with the photos.'), 'a mismatch claims no limit it did not test')
  assert.equal(session.el('project-calibration-adjust').hidden, false)
  assert.equal(session.el('project-calibration-override').hidden, false, '"Use anyway" is still there, unchanged')
  assert.equal(session.el('project-calibration-commit').hidden, true)
  assert.equal(session.isOpen(), true)

  await session.press('project-calibration-adjust')
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  await session.tapAt(0, 2)                                // select the check point...
  await session.tapAt(0, 3)                                // ...and move it onto the stored spot
  assert.equal(session.el('project-calibration-fit').dataset['state'], 'ok', 'the readout followed the move')
  assert.match(session.el('project-calibration-fit').textContent, /^3 points are 0\.0 cm off/)
  assert.equal(session.el('project-calibration-status').textContent, 'Ready to commit.', 'and so did the status: the points match now')
  await session.press('project-calibration-commit')
  const result = await session.result as { calibration: { status: string } }
  assert.equal(result.calibration.status, 'verified')
})

test('"Wrong Place? Choose another" is a hook: not shown unless the host gives the flow something to call, and then it ends the flow', async () => {
  const without = await openModal(placeWith(TWO_POINT_1_5))
  await without.tapAt(-1.5, 1)
  await without.press('project-calibration-confirm')
  await without.tapAt(1.5, 1)                              // 3.0 m against a stored 1.5 m: the mismatch screen
  await without.press('project-calibration-commit')
  assert.equal(without.el('project-calibration-title').textContent, 'These markers do not match the stored pair')
  assert.equal(without.el('project-calibration-wrong-place').hidden, true)
  assert.equal(without.el('project-calibration-adjust').hidden, false)
  without.el('project-calibration-wrong-place').click()    // a script's click: nothing to call, nothing happens
  await settle()
  assert.equal(without.isOpen(), true)

  let called = 0
  const withHost = await openModal(placeWith(TWO_POINT_1_5), { onWrongPlace: () => { called += 1 } })
  await withHost.tapAt(-1.5, 1)
  await withHost.press('project-calibration-confirm')
  await withHost.tapAt(1.5, 1)
  withHost.el('project-calibration-wrong-place').click()   // review is not the mismatch screen: a script's click is refused as a person's is
  await settle()
  assert.equal(called, 0)
  assert.equal(withHost.isOpen(), true)
  await withHost.press('project-calibration-commit')
  assert.equal(withHost.el('project-calibration-wrong-place').hidden, false)
  assert.equal(withHost.el('project-calibration-wrong-place').textContent, 'Wrong Place? Choose another')
  await withHost.press('project-calibration-wrong-place')
  assert.equal(called, 1)
  assert.equal(withHost.isOpen(), false, 'the flow ends, with no calibration')
  assert.equal(await withHost.result, null)
})

test('"Adjust a point" goes back to the markers from the mismatch screen and does not commit', async () => {
  const session = await openModal(placeWith(TWO_POINT_1_5))
  await session.tapAt(-1.5, 1)
  await session.press('project-calibration-confirm')
  await session.tapAt(1.5, 1)
  await session.press('project-calibration-commit')
  await session.press('project-calibration-adjust')
  assert.equal(session.el('project-calibration-title').textContent, 'Check the alignment')
  assert.equal(session.el('project-calibration-commit').hidden, false)
  assert.equal(session.el('project-calibration-adjust').hidden, true)
  assert.equal(session.isOpen(), true)
})
