/**
 * The calibration flow with a Place's reference in it (WP-08): the modal's hooks, the loop that runs it again when the person
 * leaves it for another Place or to improve the reference, and what comes out of a commit.
 *
 * Four layers, each held to one thing:
 *
 *  1. The real modal (src/ar/project-calibration.ts), driven the way a person drives it (./support/calibration-flow-driver.ts, a
 *     fake provider and a stand-in document), given the hooks. "Replace this Place's reference" asks first and keeps the pair
 *     only on a yes; "Improve this Place's reference" is on the landmark stage before anything is placed and only for a frame the
 *     page says can be improved; an upgrade never offers the one-point tier. A modal given no hooks is held to what it did before
 *     by wp-calibration-characterisation.test.ts, which this package leaves unchanged.
 *  2. The loop (src/ar/calibration-exits.ts) with fakes: which Place the modal runs for after the picker, what happens when
 *     the picker is left without a choice or the person goes on with no Place, and that an improve runs the modal as an
 *     upgrade.
 *  3. The page's run (src/ar/calibration-run.ts) with a scripted modal: the hooks it hands the modal, including the
 *     `onWrongPlace` option of WP-07's "Wrong Place? Choose another" button, which this package answers with the Place picker,
 *     and the records it stamps on what the modal returns: the new frame's id, the calibration naming it, which frame it
 *     replaces and why.
 *  4. A real commit through the real modal into the stamping: the id, the superseded frame and the reason that reach the
 *     frame's write.
 *
 * The button itself is WP-07's, so it is not drawn by the modal in this tree and layer 1 does not press it: layer 3 plays its
 * part, calling `onWrongPlace` as the modal does and then closing with no calibration.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-replace-flow.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLOOR_Y, loadModal, runScenario, type Scenario } from './support/calibration-flow-driver.ts'
import { installDialogDom } from './support/fake-dialog-dom.ts'
import { openPlacePickerAndWait, runWithExits } from '../../../src/ar/calibration-exits.ts'
import {
  frameIdOf,
  planFrameGeneration,
  readFrameStatus,
} from '../../../src/world/frame-replacement.ts'
import { generationActions, type GenerationHooks, type ReplaceAsk } from '../../../src/ar/replace-reference.ts'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const runModal = await loadModal()
const { runProjectCalibration } = await import('../../../src/ar/calibration-run.ts')

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A floor point: `x` and `z` in session metres, on the floor. */
const floor = (x: number, z: number) => ({ x, y: FLOOR_Y, z })

const storedFrame = (separationM: number, extra: Record<string, unknown> = {}) => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: separationM },
  separationM,
  toleranceM: 0.15,
  anchorBearingDeg: 77,
  ...extra,
})

/** Taps the landmark, confirms it, taps a heading marker 3.4 m from it (0.4 m over the stored 3.0) and commits: the mismatch screen. */
const TO_MISMATCH = [{ tap: floor(1, 2) }, { press: 'confirm' as const }, { tap: floor(4.4, 2) }, { press: 'commit' as const }]

/** The hooks a page gives the modal, recording what the modal asked. */
function hooks(answers: boolean[] = []) {
  const asked: Array<{ host: unknown; ask: ReplaceAsk }> = []
  const exits: string[] = []
  const generation: GenerationHooks = {
    canImprove: () => true,
    confirmReplace: (host, ask) => {
      asked.push({ host, ask })
      return Promise.resolve(answers.length > 0 ? answers.shift()! : true)
    },
    onImprove: () => {
      exits.push('improve')
    },
  }
  return { asked, exits, generation }
}

const hiddenOf = (card: { el(id: string): { hidden: boolean } }, id: string) => card.el(id).hidden

// ── 1. The modal with the hooks ──────────────────────────────────────────────────────────────────────

test('on the mismatch screen, "Replace this Place\'s reference" asks first, and the pair is kept only on a yes', async () => {
  const h = hooks([false, true])
  const seen: Record<string, boolean | number> = {}
  const outcome = await runScenario(runModal, {
    name: 'replace asks first',
    about: 'a mismatch, then the button twice: no, then yes',
    stored: storedFrame(3),
    options: { generation: h.generation },
    steps: [
      ...TO_MISMATCH,
      { run: (card) => { seen['shown'] = !hiddenOf(card, 'project-calibration-override'); card.el('project-calibration-override').click() } },
      { run: (card) => { seen['askedAfterNo'] = h.asked.length; seen['stillThere'] = !hiddenOf(card, 'project-calibration-override'); card.el('project-calibration-override').click() } },
    ],
  })
  assert.equal(seen['shown'], true)
  assert.equal(seen['askedAfterNo'], 1, 'the question was asked, and a no kept the person on the mismatch screen with nothing committed')
  assert.equal(seen['stillThere'], true)
  assert.deepEqual(h.asked.map((entry) => entry.ask.reason), ['override', 'override'])
  assert.ok(Math.abs((h.asked[0]!.ask.residualM ?? 0) - 0.4) < 1e-9, 'with the residual the mismatch screen showed')
  assert.equal(h.asked[0]!.host !== undefined, true, 'inside the modal, which is where the question opens')
  assert.equal(outcome.closed, true, 'and the yes kept the pair')
})

test('a yes keeps the pair as the override always did: a new provisional frame with the residual that failed', async () => {
  const h = hooks([true])
  const outcome = await runScenario(runModal, {
    name: 'replace, yes',
    about: 'a mismatch, then the button, answered yes',
    stored: storedFrame(3),
    options: { generation: h.generation },
    steps: [...TO_MISMATCH, { run: (card) => card.el('project-calibration-override').click() }],
  })
  assert.equal(outcome.closed, true)
  const result = outcome.result as { calibration: ScanCalibration; spatialFrame?: ProjectSpatialFrame }
  assert.equal(result.calibration.status, 'provisional')
  assert.equal(result.calibration.method === 'two-point-ground' && Math.abs(result.calibration.residualM - 0.4) < 1e-9, true)
  assert.equal(result.spatialFrame?.method, 'two-point-ground')
  assert.equal(h.asked.length, 1)
  assert.equal(h.exits.length, 0, 'keeping the pair is not leaving the modal')
})

test('with no question to ask, the button keeps the pair at once, as it did before', async () => {
  const outcome = await runScenario(runModal, {
    name: 'replace, no hooks',
    about: 'the same flow with a hooks object that has nothing in it',
    stored: storedFrame(3),
    options: { generation: {} },
    steps: [...TO_MISMATCH, { run: (card) => card.el('project-calibration-override').click() }],
  })
  assert.equal(outcome.closed, true)
})

test('a scripted click on the hidden button on a Place with no reference replaces nothing, so it asks nothing', async () => {
  const h = hooks()
  const outcome = await runScenario(runModal, {
    name: 'replace with nothing to replace',
    about: 'a first calibration: there is no reference, and the click is the old scripted one',
    options: { generation: h.generation },
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(4, 2) }, { run: (card) => card.el('project-calibration-override').click() }],
  })
  assert.equal(outcome.closed, true)
  assert.equal(h.asked.length, 0)
})

test('"Improve this Place\'s reference" is on the landmark stage before anything is placed, asks, and on a yes leaves for another run', async () => {
  const h = hooks([false, true])
  const states: Record<string, boolean> = {}
  const outcome = await runScenario(runModal, {
    name: 'improve',
    about: 'offered at the start, gone once a point is on the floor, asked, then yes',
    stored: storedFrame(3),
    options: { generation: h.generation },
    steps: [
      { run: (card) => { states['atStart'] = hiddenOf(card, 'project-calibration-improve') } },
      { run: (card) => card.el('project-calibration-improve').click() },
      { run: () => { assert.deepEqual(h.exits, [], 'a no keeps the person where they were') } },
      { run: (card) => card.el('project-calibration-improve').click() },
    ],
  })
  assert.equal(states['atStart'], false, 'offered at the start')
  assert.deepEqual(h.asked.map((entry) => entry.ask.reason), ['upgrade', 'upgrade'], 'asked each time, in the improve\'s own words')
  assert.deepEqual(h.exits, ['improve'])
  assert.equal(outcome.closed, true)
  assert.equal(outcome.result, null)

  const later: Record<string, boolean> = {}
  await runScenario(runModal, {
    name: 'improve gone',
    about: 'a landmark on the floor: the visit is under way',
    stored: storedFrame(3),
    options: { generation: hooks().generation },
    steps: [{ tap: floor(1, 2) }, { run: (card) => { later['afterLandmark'] = hiddenOf(card, 'project-calibration-improve') } }],
  })
  assert.deepEqual(later, { afterLandmark: true })
})

test('"Improve this Place\'s reference" is not offered where the page says there is nothing to improve, or says nothing', async () => {
  const states: Record<string, boolean> = {}
  const noImprove = hooks().generation
  noImprove.canImprove = () => false
  await runScenario(runModal, {
    name: 'improve not offered',
    about: 'the page says no, and a page that says nothing',
    stored: storedFrame(3),
    options: { generation: noImprove },
    steps: [{ run: (card) => { states['pageSaysNo'] = hiddenOf(card, 'project-calibration-improve') } }],
  })
  await runScenario(runModal, {
    name: 'improve not mentioned',
    about: 'no hook at all',
    stored: storedFrame(3),
    options: { generation: {} },
    steps: [{ run: (card) => { states['pageSaysNothing'] = hiddenOf(card, 'project-calibration-improve') } }],
  })
  await runScenario(runModal, {
    name: 'improve with no hooks object',
    about: 'a modal that is given no generation at all, as every caller before this package gave it',
    stored: storedFrame(3),
    steps: [{ run: (card) => { states['noGeneration'] = hiddenOf(card, 'project-calibration-improve') } }],
  })
  assert.deepEqual(states, { pageSaysNo: true, pageSaysNothing: true, noGeneration: true })
})

test('a click that reaches the hidden "Improve this Place\'s reference" is refused by the rule that hides it: nothing is asked and nothing is left', async () => {
  // The page says the reference cannot be improved.
  const no = hooks()
  no.generation.canImprove = () => false
  await runScenario(runModal, {
    name: 'improve clicked while hidden, the page says no',
    about: 'the button is hidden because the page says there is nothing to improve, and a script presses it anyway',
    stored: storedFrame(3),
    options: { generation: no.generation },
    steps: [{ run: (card) => card.el('project-calibration-improve').click() }],
  })
  assert.equal(no.asked.length, 0, 'no question')
  assert.deepEqual(no.exits, [], 'and the page is not told to run the flow again')

  // The page says it can, but a landmark is on the floor: the visit is under way, and a stray click does not turn it into a new reference.
  const underWay = hooks()
  const outcome = await runScenario(runModal, {
    name: 'improve clicked while hidden, a visit under way',
    about: 'a landmark is on the floor, so the button is hidden, and a script presses it anyway',
    stored: storedFrame(3),
    options: { generation: underWay.generation },
    steps: [{ tap: floor(1, 2) }, { run: (card) => card.el('project-calibration-improve').click() }],
  })
  assert.equal(underWay.asked.length, 0)
  assert.deepEqual(underWay.exits, [])
  assert.equal(outcome.closed, false, 'the modal is still open: the visit goes on')
})

test('an upgrade never offers the one-point tier, which would replace a two-point reference with a weaker one', async () => {
  const states: Record<string, boolean> = {}
  const upgrade = await runScenario(runModal, {
    name: 'upgrade, one point',
    about: 'a first-calibration flow run as an upgrade: the one-point button is not there, and a click that reaches it does nothing',
    options: { generation: { mode: 'upgrade' } },
    steps: [
      { tap: floor(1.5, -2) },
      { run: (card) => { states['hiddenInUpgrade'] = hiddenOf(card, 'project-calibration-fallback') } },
      { press: 'fallback' },
    ],
  })
  assert.equal(upgrade.closed, false, 'the click commits nothing')

  const ordinary = await runScenario(runModal, {
    name: 'first calibration, one point',
    about: 'the same flow not as an upgrade: the one-point tier is on offer and commits',
    steps: [
      { tap: floor(1.5, -2) },
      { run: (card) => { states['hiddenOtherwise'] = hiddenOf(card, 'project-calibration-fallback') } },
      { press: 'fallback' },
    ],
  })
  assert.equal(ordinary.closed, true)
  assert.deepEqual(states, { hiddenInUpgrade: true, hiddenOtherwise: false })
})

test('inside an upgrade, "Keep the saved reference" is on every stage, tells the page and closes with no calibration; outside one, or with no hook, it is not there', async () => {
  const kept: string[] = []
  const hooksFor = (mode?: 'upgrade', withHook = true): GenerationHooks => ({ ...(mode ? { mode } : {}), ...(withHook ? { onKeepReference: () => { kept.push('keep') } } : {}) })
  const states: Record<string, boolean> = {}
  const outcome = await runScenario(runModal, {
    name: 'keep in an upgrade',
    about: 'an upgrade over a Place with no frame as the modal sees it: the way back is on the floor stage, the landmark stage and the heading stage',
    options: { generation: hooksFor('upgrade') },
    steps: [
      { run: (card) => { states['atStart'] = hiddenOf(card, 'project-calibration-keep') } },
      { tap: floor(1, 2) },
      { run: (card) => { states['afterLandmark'] = hiddenOf(card, 'project-calibration-keep') } },
      { press: 'confirm' },
      { run: (card) => { states['atHeading'] = hiddenOf(card, 'project-calibration-keep') } },
      { run: (card) => card.el('project-calibration-keep').click() },
    ],
  })
  assert.deepEqual(states, { atStart: false, afterLandmark: false, atHeading: false })
  assert.deepEqual(kept, ['keep'])
  assert.equal(outcome.closed, true)
  assert.equal(outcome.result, null, 'closed with no calibration: the page runs the visit again')

  const elsewhere: Record<string, boolean> = {}
  await runScenario(runModal, {
    name: 'keep elsewhere',
    about: 'an ordinary run, and an upgrade whose page gave no hook: nothing to go back to, so no button',
    stored: storedFrame(3),
    options: { generation: hooksFor(undefined) },
    steps: [{ run: (card) => { elsewhere['ordinary'] = hiddenOf(card, 'project-calibration-keep'); card.el('project-calibration-keep').click() } }],
  })
  await runScenario(runModal, {
    name: 'keep without a hook',
    about: 'mode upgrade, no onKeepReference',
    options: { generation: hooksFor('upgrade', false) },
    steps: [{ run: (card) => { elsewhere['noHook'] = hiddenOf(card, 'project-calibration-keep'); card.el('project-calibration-keep').click() } }],
  })
  assert.deepEqual(elsewhere, { ordinary: true, noHook: true })
  assert.deepEqual(kept, ['keep'], 'a click that reaches a hidden button is refused by the same rule that hides it')
})

test('a second click while the question is open, or the pair is being kept, is the same decision and keeps the pair once', async () => {
  let kept = 0
  let release!: (yes: boolean) => void
  const answer = new Promise<boolean>((resolve) => {
    release = resolve
  })
  const actions = generationActions(
    { confirmReplace: () => answer, canImprove: () => true, onImprove: () => {} },
    {
      overlay: {} as HTMLElement,
      stored: storedFrame(3) as ProjectSpatialFrame,
      stage: () => 'mismatch',
      hasLandmark: () => true,
      residualM: () => 0.4,
      keepPair: () => { kept += 1; return Promise.resolve() },
      close: () => {},
    },
  )
  const first = actions.replace()
  const second = actions.replace()
  release(true)
  await Promise.all([first, second])
  assert.equal(kept, 1, 'two clicks, one decision: a second set of markers is not dropped into the scene')
  await actions.replace()
  assert.equal(kept, 2, 'and once it is done, a later click is a new decision')
})

// ── 2. The loop ──────────────────────────────────────────────────────────────────────────────────────

const place = (projectId: string, spatialFrame?: ProjectSpatialFrame): Project => ({ projectId, name: projectId, createdAt: 1, updatedAt: 1, floors: [], ...(spatialFrame ? { spatialFrame } : {}) })

test('a run that ends in a calibration, or without one, is the last', async () => {
  const runs: unknown[] = []
  const done = await runWithExits({
    run: (mode) => { runs.push(mode); return Promise.resolve('result') },
    selected: () => place('a'),
    choosePlace: () => Promise.reject(new Error('the picker must not open')),
  })
  assert.deepEqual(done, { result: 'result', mode: undefined })
  assert.equal(runs.length, 1)

  const skipped = await runWithExits({ run: () => Promise.resolve(null), selected: () => place('a'), choosePlace: () => Promise.reject(new Error('no')) })
  assert.deepEqual(skipped, { result: null, mode: undefined }, '"Continue uncalibrated" ends it')
})

test('"Wrong Place?": the picker opens and the modal runs again for the Place the person chose', async () => {
  let selected: Project | null = place('kitchen')
  const log: string[] = []
  const result = await runWithExits({
    settle: () => { log.push('settle'); return Promise.resolve() },
    run: (mode, onExit) => {
      log.push(`run ${selected?.projectId} ${mode ?? 'normal'}`)
      if (log.filter((line) => line.startsWith('run')).length === 1) {
        onExit('choose-place')
        return Promise.resolve(null)
      }
      return Promise.resolve('calibrated')
    },
    selected: () => selected,
    choosePlace: () => { log.push('picker'); selected = place('garage'); return Promise.resolve() },
  })
  assert.deepEqual(result, { result: 'calibrated', mode: undefined })
  assert.deepEqual(log, ['settle', 'run kitchen normal', 'picker', 'settle', 'run garage normal'], 'it waits for what is pending before each run, and the second run is for the Place now selected')
})

test('leaving the picker without a choice runs the modal again for the Place they had', async () => {
  const selected = place('kitchen')
  const ran: string[] = []
  let first = true
  const result = await runWithExits({
    run: (_mode, onExit) => {
      ran.push(selected.projectId)
      if (first) { first = false; onExit('choose-place'); return Promise.resolve(null) }
      return Promise.resolve('calibrated')
    },
    selected: () => selected,
    choosePlace: () => Promise.resolve(),
  })
  assert.equal(result.result, 'calibrated')
  assert.deepEqual(ran, ['kitchen', 'kitchen'])
})

test('going on with no Place at all gives no calibration, and the modal is not run again', async () => {
  let selected: Project | null = place('kitchen')
  let runs = 0
  const result = await runWithExits({
    run: (_mode, onExit) => { runs += 1; onExit('choose-place'); return Promise.resolve(null) },
    selected: () => selected,
    choosePlace: () => { selected = null; return Promise.resolve() },
  })
  assert.deepEqual(result, { result: null, mode: undefined })
  assert.equal(runs, 1)
})

test('"Improve": the modal runs again as an upgrade, and the result says it was one', async () => {
  const modes: Array<string | undefined> = []
  const result = await runWithExits({
    run: (mode, onExit) => {
      modes.push(mode)
      if (mode === undefined) { onExit('improve'); return Promise.resolve(null) }
      return Promise.resolve('calibrated as upgrade')
    },
    selected: () => place('kitchen', storedFrame(3) as ProjectSpatialFrame),
    choosePlace: () => Promise.reject(new Error('the picker must not open for an improve')),
  })
  assert.deepEqual(modes, [undefined, 'upgrade'])
  assert.deepEqual(result, { result: 'calibrated as upgrade', mode: 'upgrade' })
})

test('"Keep the saved reference": an improve that was given up runs the modal again as an ordinary visit, and the picker does not open', async () => {
  const modes: Array<string | undefined> = []
  const result = await runWithExits({
    run: (mode, onExit) => {
      modes.push(mode)
      if (modes.length === 1) { onExit('improve'); return Promise.resolve(null) }
      if (modes.length === 2) { onExit('keep'); return Promise.resolve(null) }
      return Promise.resolve('verified against the saved reference')
    },
    selected: () => place('kitchen', storedFrame(3) as ProjectSpatialFrame),
    choosePlace: () => Promise.reject(new Error('the picker must not open for a keep')),
  })
  assert.deepEqual(modes, [undefined, 'upgrade', undefined])
  assert.deepEqual(result, { result: 'verified against the saved reference', mode: undefined }, 'and what comes out is stamped as an ordinary visit, not an upgrade')
})

test('a run that produced a calibration is done whatever else it reported', async () => {
  const result = await runWithExits({
    run: (_mode, onExit) => { onExit('choose-place'); return Promise.resolve('calibrated') },
    selected: () => place('a'),
    choosePlace: () => Promise.reject(new Error('no')),
  })
  assert.equal(result.result, 'calibrated')
})

test('the picker is opened for the scan, and the wait ends when a Place is chosen, when it is left, or at once with no picker', async () => {
  const calls: Array<{ purpose: unknown; hasDismiss: boolean }> = []
  let afterSelection: (() => void) | undefined
  let onDismiss: (() => void) | undefined
  const opener = (after?: () => void, purpose?: 'scan', dismiss?: () => void) => {
    calls.push({ purpose, hasDismiss: typeof dismiss === 'function' })
    afterSelection = after
    onDismiss = dismiss
  }
  let waited = openPlacePickerAndWait(opener)
  let ended = false
  void waited.then(() => { ended = true })
  await settle()
  assert.equal(ended, false, 'the picker is open')
  afterSelection!()
  await waited
  assert.deepEqual(calls, [{ purpose: 'scan', hasDismiss: true }])

  waited = openPlacePickerAndWait(opener)
  onDismiss!()
  await waited
  await openPlacePickerAndWait(null)
})

// ── 3. The page's run ────────────────────────────────────────────────────────────────────────────────

const calibrationOf = (extra: Record<string, unknown> = {}): ScanCalibration => ({
  method: 'two-point-ground',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  calibratedAt: '2026-11-16T09:30:00.000Z',
  status: 'provisional',
  separationM: 3.4,
  residualM: 0.4,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  ...extra,
}) as ScanCalibration

/** What a modal run was handed. */
interface Run {
  project: Project
  generation: GenerationHooks
  /** The option WP-07's "Wrong Place? Choose another" button calls: the modal then closes with no calibration. */
  onWrongPlace?: () => void
}

/** A scripted modal: each call answers with the next scripted outcome, and records what it was given. */
function scripted(outcomes: Array<(run: Run) => unknown>) {
  const runs: Run[] = []
  const modal = ((options: Run) => {
    runs.push({ project: options.project, generation: options.generation, onWrongPlace: options.onWrongPlace })
    const next = outcomes.shift()
    return Promise.resolve(next ? next(runs.at(-1)!) : null)
  }) as unknown as NonNullable<Parameters<typeof runProjectCalibration>[0]['modal']>
  return { runs, modal }
}

const baseOptions = {
  provider: {} as never,
  canvas: {} as never,
  hitTest: () => Promise.resolve(null),
  bearing: () => null,
  ground: () => null,
}

test('a first calibration: the new frame has an id, the calibration names it, and nothing is replaced', async () => {
  const kitchen = place('kitchen')
  const m = scripted([() => ({ calibration: calibrationOf({ residualM: 0 }), spatialFrame: storedFrame(3.4) })])
  const result = await runProjectCalibration({ ...baseOptions, modal: m.modal, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.ok(result)
  const id = frameIdOf(result.spatialFrame)
  assert.ok(id, 'the frame has an id')
  assert.equal(result.calibration.method === 'two-point-ground' && result.calibration.frameId, id, 'and the calibration names it')
  assert.equal(result.replaces, undefined)
  assert.equal(result.superseded, undefined)
  assert.equal(m.runs[0]!.project, kitchen, 'the modal was run for the Place that is selected')
  assert.equal(typeof m.runs[0]!.onWrongPlace, 'function', 'and is given the hook of the "Wrong Place?" button')
  assert.equal(m.runs[0]!.generation.mode, undefined)
})

test('a pair kept over a mismatch replaces the held frame: the record says which, and why, and what was replaced', async () => {
  const held = storedFrame(3, { frameId: 'frame-held' }) as ProjectSpatialFrame
  const kitchen = place('kitchen', held)
  const m = scripted([() => ({ calibration: calibrationOf(), spatialFrame: storedFrame(3.4), referencePhotos: [] })])
  const result = await runProjectCalibration({ ...baseOptions, modal: m.modal, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.ok(result)
  assert.notEqual(frameIdOf(result.spatialFrame), 'frame-held', 'a new generation, never the same id')
  assert.deepEqual(result.replaces, { frameId: 'frame-held', reason: 'override' })
  assert.equal(result.superseded, held)
  assert.deepEqual(result.referencePhotos, [], 'what the modal returned goes on to the caller')
})

test('a return visit that matched writes no frame, and its calibration names the frame it matched', async () => {
  const kitchen = place('kitchen', storedFrame(3, { frameId: 'frame-held' }) as ProjectSpatialFrame)
  const m = scripted([() => ({ calibration: calibrationOf({ status: 'verified', residualM: 0.02 }) })])
  const result = await runProjectCalibration({ ...baseOptions, modal: m.modal, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.ok(result)
  assert.equal('spatialFrame' in result, false)
  assert.equal(result.replaces, undefined)
  assert.equal(result.calibration.method === 'two-point-ground' && result.calibration.frameId, 'frame-held')
})

test('improving: the modal is run again as an upgrade over a copy of the Place with no frame, and the frame it makes replaces the real one', async () => {
  const held = storedFrame(3, { frameId: 'frame-held' }) as ProjectSpatialFrame
  const kitchen = place('kitchen', held)
  const m = scripted([
    (run) => { run.generation.onImprove!(); return null },
    () => ({ calibration: calibrationOf({ residualM: 0 }), spatialFrame: storedFrame(3.2) }),
  ])
  const result = await runProjectCalibration({
    ...baseOptions,
    modal: m.modal,
    canImprove: () => true,
    exits: { selected: () => kitchen, choosePlace: () => Promise.reject(new Error('no picker for an improve')) },
  })
  assert.equal(m.runs.length, 2)
  assert.equal(typeof m.runs[0]!.generation.canImprove, 'function', 'offered in the ordinary run')
  assert.equal(m.runs[1]!.generation.mode, 'upgrade')
  assert.equal(m.runs[1]!.generation.canImprove, undefined, 'and not offered inside the upgrade')
  assert.equal('spatialFrame' in m.runs[1]!.project, false, 'the modal sees a Place with no reference, so it runs as a first calibration')
  assert.equal(kitchen.spatialFrame, held, 'the real Place still holds its frame')
  assert.ok(result)
  assert.deepEqual(result.replaces, { frameId: 'frame-held', reason: 'upgrade' })
  assert.equal(result.superseded, held)
})

test('an improve given up goes back to the Place\'s own reference: the third run is an ordinary visit, and it is stamped against that frame', async () => {
  const held = storedFrame(3, { frameId: 'frame-held' }) as ProjectSpatialFrame
  const kitchen = place('kitchen', held)
  const m = scripted([
    (run) => { run.generation.onImprove!(); return null },
    (run) => { run.generation.onKeepReference!(); return null },
    () => ({ calibration: calibrationOf({ status: 'verified', residualM: 0.01 }) }),
  ])
  const result = await runProjectCalibration({ ...baseOptions, modal: m.modal, canImprove: () => true, exits: { selected: () => kitchen, choosePlace: () => Promise.reject(new Error('no picker')) } })
  assert.deepEqual(m.runs.map((run) => run.generation.mode), [undefined, 'upgrade', undefined])
  assert.equal(typeof m.runs[1]!.generation.onKeepReference, 'function', 'the way back is offered inside the upgrade')
  assert.equal(m.runs[2]!.project, kitchen, 'the third run sees the Place with its reference')
  assert.ok(result)
  assert.equal(result.calibration.method === 'two-point-ground' && result.calibration.frameId, 'frame-held')
  assert.equal(result.replaces, undefined, 'nothing is replaced')
})

test('"Improve" is offered by default for a two-point Place without a check point (the flow asks for one), and a page can turn it off', async () => {
  const kitchen = place('kitchen', storedFrame(3) as ProjectSpatialFrame)
  const on = scripted([() => null])
  await runProjectCalibration({ ...baseOptions, modal: on.modal, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.equal(on.runs[0]!.generation.canImprove!(kitchen.spatialFrame), true, 'the first-calibration flow has a check point to give it (WP-04b)')
  const off = scripted([() => null])
  await runProjectCalibration({ ...baseOptions, modal: off.modal, canImprove: () => false, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.equal(off.runs[0]!.generation.canImprove!(kitchen.spatialFrame), false)
})

test('"Wrong Place?": the modal runs again for the Place chosen, and the result is stamped against that Place\'s frame', async () => {
  let selected: Project | null = place('kitchen', storedFrame(3, { frameId: 'frame-kitchen' }) as ProjectSpatialFrame)
  const garage = place('garage', storedFrame(5, { frameId: 'frame-garage' }) as ProjectSpatialFrame)
  const m = scripted([
    (run) => { run.onWrongPlace!(); return null },
    () => ({ calibration: calibrationOf({ status: 'verified', residualM: 0.01, separationM: 5 }) }),
  ])
  const result = await runProjectCalibration({
    ...baseOptions,
    modal: m.modal,
    exits: { selected: () => selected, choosePlace: () => { selected = garage; return Promise.resolve() } },
  })
  assert.deepEqual(m.runs.map((run) => run.project.projectId), ['kitchen', 'garage'])
  assert.ok(result)
  assert.equal(result.calibration.method === 'two-point-ground' && result.calibration.frameId, 'frame-garage')
})

test('with no Place selected after the exit, there is no calibration to stamp and the modal is not run again', async () => {
  let selected: Project | null = place('kitchen')
  const m = scripted([(run) => { run.onWrongPlace!(); return null }])
  const result = await runProjectCalibration({ ...baseOptions, modal: m.modal, exits: { selected: () => selected, choosePlace: () => { selected = null; return Promise.resolve() } } })
  assert.equal(result, null)
  assert.equal(m.runs.length, 1)

  const none = scripted([])
  assert.equal(await runProjectCalibration({ ...baseOptions, modal: none.modal, exits: { selected: () => null, choosePlace: () => Promise.resolve() } }), null)
  assert.equal(none.runs.length, 0, 'with no Place there is nothing to run the modal for')
})

test('what a calibration is stamped against is the frame the modal was given, even when a retry settles while it is open', async () => {
  const original = storedFrame(3, { frameId: 'frame-original' }) as ProjectSpatialFrame
  const winner = storedFrame(5, { frameId: 'frame-winner', createdAt: '2026-11-16T08:00:00.000Z' }) as ProjectSpatialFrame
  const kitchen = place('kitchen', original)
  // What the page does when a frame it had sent settles as a lost race (adoptFrameOutcome): the Place's frame is the server's.
  const meanwhile = () => { kitchen.spatialFrame = winner }

  const verified = scripted([() => { meanwhile(); return { calibration: calibrationOf({ status: 'verified', residualM: 0.01 }) } }])
  const matched = await runProjectCalibration({ ...baseOptions, modal: verified.modal, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.equal(matched?.calibration.method === 'two-point-ground' && matched.calibration.frameId, 'frame-original', 'the scan names the frame its points were compared with, not the one that arrived meanwhile')

  kitchen.spatialFrame = original
  const kept = scripted([() => { meanwhile(); return { calibration: calibrationOf(), spatialFrame: storedFrame(3.4) } }])
  const replaced = await runProjectCalibration({ ...baseOptions, modal: kept.modal, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.deepEqual(replaced?.replaces, { frameId: 'frame-original', reason: 'override' }, 'a replacement names the frame the person was shown')
  assert.equal(replaced?.superseded, original)

  kitchen.spatialFrame = original
  let seenInUpgrade: ProjectSpatialFrame | undefined
  const improved = scripted([
    (run) => { run.generation.onImprove!(); return null },
    (run) => { seenInUpgrade = run.project.spatialFrame; meanwhile(); return { calibration: calibrationOf({ residualM: 0 }), spatialFrame: storedFrame(3.2) } },
  ])
  const upgraded = await runProjectCalibration({ ...baseOptions, modal: improved.modal, canImprove: () => true, exits: { selected: () => kitchen, choosePlace: () => Promise.resolve() } })
  assert.equal(seenInUpgrade, undefined, 'the upgrade runs over a Place with no frame')
  assert.deepEqual(upgraded?.replaces, { frameId: 'frame-original', reason: 'upgrade' }, 'and still replaces the frame the Place held when it began')
})

test('what the confirmation says about a replacement is the server\'s count for the Place that run is about', async () => {
  const dom = installDialogDom()
  try {
    const kitchen = place('kitchen', storedFrame(3, { frameId: 'frame-held' }) as ProjectSpatialFrame)
    const asked: string[] = []
    const status = readFrameStatus({ revision: 4, frame: kitchen.spatialFrame, scansOnCurrentFrame: 2 })
    const m = scripted([() => null])
    await runProjectCalibration({
      ...baseOptions,
      modal: m.modal,
      exits: {
        selected: () => kitchen,
        choosePlace: () => Promise.resolve(),
        fetchStatus: (project) => { asked.push(project.projectId); return Promise.resolve(status) },
      },
    })
    const answer = m.runs[0]!.generation.confirmReplace!(dom.host as unknown as HTMLElement, { reason: 'override', residualM: 0.4 })
    await settle()
    assert.deepEqual(asked, ['kitchen'])
    const dialog = dom.dialogs[0]!
    assert.match(dialog.parts.get('frame-replace-scans')!.textContent, /^2 scans in this Place were made against it\./)
    dialog.parts.get('frame-replace-cancel')!.click()
    assert.equal(await answer, false)
  } finally {
    dom.restore()
  }
})

// ── 4. A real commit ─────────────────────────────────────────────────────────────────────────────────

test('a real commit over a mismatch emits the new frame\'s id and the frame it superseded, through to the write', async () => {
  const held = storedFrame(3, { frameId: 'frame-held' })
  const scenario: Scenario = {
    name: 'real commit',
    about: 'the modal as a person drives it, then the stamping the page applies to what comes out',
    stored: held,
    capture: 'immediate',
    options: { generation: hooks([true]).generation },
    steps: [...TO_MISMATCH, { run: (card) => card.el('project-calibration-override').click() }],
  }
  const outcome = await runScenario(runModal, scenario)
  assert.equal(outcome.closed, true)
  const result = outcome.result as { calibration: ScanCalibration; spatialFrame: ProjectSpatialFrame }
  const plan = planFrameGeneration({ held: held as ProjectSpatialFrame, calibration: result.calibration, spatialFrame: result.spatialFrame })

  const newId = frameIdOf(plan.spatialFrame)
  assert.ok(newId && newId !== 'frame-held', 'a new generation')
  assert.equal(plan.calibration.method === 'two-point-ground' && plan.calibration.frameId, newId, 'the scan names it')
  assert.deepEqual(plan.replaces, { frameId: 'frame-held', reason: 'override' })
  assert.equal(plan.superseded, held, 'and what was replaced is what the Place held')
  assert.equal(plan.spatialFrame?.method === 'two-point-ground' && plan.spatialFrame.separationM > 3.3, true, 'the frame is the pair that was kept')
  assert.equal(plan.calibration.status, 'provisional', 'a kept mismatch is never "verified"')
})

test('a real return visit that matched stamps the held frame\'s id and writes no frame', async () => {
  const held = storedFrame(3, { frameId: 'frame-held' })
  const outcome = await runScenario(runModal, {
    name: 'real return visit',
    about: 'the stored pair tapped again',
    stored: held,
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(4, 2) }, { press: 'commit' }],
  })
  const result = outcome.result as { calibration: ScanCalibration; spatialFrame?: ProjectSpatialFrame }
  assert.equal(result.spatialFrame, undefined)
  const plan = planFrameGeneration({ held: held as ProjectSpatialFrame, calibration: result.calibration, spatialFrame: result.spatialFrame })
  assert.equal(plan.calibration.status, 'provisional', 'a pair checked by distance is never "verified" (owner decision D1)')
  assert.equal(plan.calibration.method === 'two-point-ground' && plan.calibration.frameId, 'frame-held')
  assert.equal(plan.replaces, undefined)
})

// ── The wiring, read as text ─────────────────────────────────────────────────────────────────────────

test('source shape: the page runs the calibration through the Place-reference run, persists with `replaces`, and the modal draws its labels from the copy module', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8')
  assert.match(main, /import \{ runProjectCalibration \} from '\.\/ar\/calibration-run'/)
  assert.match(main, /exits: \{\n\s+selected: \(\) => selectedProject,\n\s+choosePlace: \(\) => openPlacePickerAndWait\(requestPlaceSelection\),\n\s+settle: \(\) => whenFramesSettled\(projectStore\),\n\s+\},/)
  assert.match(main, /replaces: calibration\.replaces,/)
  assert.doesNotMatch(main, /project: selectedProject,\n\s+canvas,/, 'the Place comes from `exits.selected()`, which the picker changes, and not from a value fixed when the page started')
  assert.match(main, /pendingDismissAction = onDismiss \?\? null/, 'the picker tells whoever opened it that it was left without a choice')
  // Every way the sheet closes without a Place reaches the waiting flow, and a Place that is chosen does not leave a stale dismissal behind.
  assert.match(main, /const dismissSheet = \(\): void => \{\n\s+pendingSelectionAction = null\n\s+sheet\.hidden = true\n\s+const dismissed = pendingDismissAction\n\s+pendingDismissAction = null\n\s+dismissed\?\.\(\)\n\s+\}/)
  assert.match(main, /\.querySelector<HTMLButtonElement>\('#place-back-btn'\)\?\.addEventListener\('click', dismissSheet\)/, 'Back')
  assert.match(main, /if \(event\.target === sheet\) dismissSheet\(\)/, 'a tap outside the sheet')
  assert.equal(
    main.match(/pendingSelectionAction = null\n\s+pendingDismissAction = null\n\s+action\?\.\(\)/g)?.length,
    2,
    'Continue, and the Place that is made: a choice is not a dismissal',
  )
  const shell = readFileSync(join(ROOT, 'src/ar/project-calibration.ts'), 'utf8')
  assert.match(shell, /id="project-calibration-override" type="button" class="project-calibration-link" hidden>\$\{REPLACE_REFERENCE_LABEL\}<\/button>/)
  assert.match(shell, /id="project-calibration-improve" type="button" class="project-calibration-link" hidden>\$\{IMPROVE_REFERENCE_LABEL\}<\/button>/)
  assert.doesNotMatch(shell, />Use anyway</, 'the old label is gone from the card')
  const run = readFileSync(join(ROOT, 'src/ar/calibration-run.ts'), 'utf8')
  assert.match(run, /onWrongPlace: \(\) => onExit\('choose-place'\),/, 'the hook of the return-visit flow\'s "Wrong Place?" button opens the picker; the button is that package\'s')
  assert.match(run, /last\.held = project\.spatialFrame/, 'what is stamped is read from the Place as the run began')
  assert.doesNotMatch(run, /exits\.selected\(\)\.spatialFrame|const project = exits\.selected\(\)\n  if \(!result/, 'and not from the Place as it is when the run ends')
})
