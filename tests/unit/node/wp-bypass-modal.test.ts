/**
 * The calibration modal's floor-check bypass, and the commit that waits for its photos (src/ar/project-calibration.ts), driven
 * as a person drives it (./support/calibration-flow-driver.ts).
 *
 * A commit whose floor check was bypassed is provisional and never writes the Place's frame (#269, `mayWritePlaceFrame` in
 * src/ar/ground-gate.ts; docs/factory/12-origin-calibration-v1/0001-origin-decal-and-persisted-ground-height.md). "Bypassed"
 * means something happened to a point that is in the commit: the person pressed "Place anchor without floor check", or an
 * off-floor tap was accepted by a second tap at the same height, and the point it placed is still there. What these tests hold:
 *
 *  1. The flag is about the points it concerns. A tap that was off the floor and is no longer in the commit (the marker was
 *     placed again, moved onto the floor, or taken away, or the person pressed Re-place points, or the flow went back to the
 *     landmark by itself because the map shifted or the walk took too long) does not make the commit bypassed. A point that is
 *     still there and was accepted off the floor does, a check point included, as it did. The skip button stands for the whole
 *     flow, whatever is done after it, because no tap after it was judged against a locked floor. Re-place points also forgets
 *     which height was last turned away, so the same tap is turned away again and is not accepted outright.
 *  2. The flag is judged by how high the tap measured, which is what the gate judges: a tap the floor ray placed on the fitted
 *     floor but whose hits sat 40 cm up (`?tap=floor`) is as off the floor as the same tap read the default way.
 *  3. A bypassed commit that wrote no frame says so on the record (`outsidePlaceFrame`) and does not name the frame the Place
 *     holds, for a pair kept over a mismatch and for "Improve this Place's reference" (the writer's half of
 *     ./wp-bypass-membership.test.ts, through the real modal).
 *  4. While a commit waits for its reference photos the check-point button is off and a press that reaches it anyway does
 *     nothing: the frame that is saved holds the points the person saw when they pressed Commit, with a photo of each, and a
 *     commit that is waiting is not abandoned and does not go on saying it is saving.
 *  5. The mismatch screen's way to keep the pair says what it does. Keeping a pair over a mismatch replaces the Place's reference
 *     (and asks first, in words that promise the scans made against it stay as "previous reference") unless the floor check was
 *     bypassed: then no frame is written (`mayWritePlaceFrame`), nothing is replaced, and the button, and the question that goes
 *     before it, must not say it is. The button's label and the question are the same rule, read when the card is drawn and when
 *     the button is pressed.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-bypass-modal.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FLOOR_Y, loadModal, runScenario, type Outcome, type Scenario, type Step } from './support/calibration-flow-driver.ts'
import { planFrameGeneration, calibrationFrameIdOf } from '../../../src/world/frame-replacement.ts'
import { generationActions, type GenerationHooks, type ReplaceAsk } from '../../../src/ar/replace-reference.ts'
import type { CalibrationTapSampler } from '../../../src/ar/calibration-taps.ts'
import type { ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'

const runModal = await loadModal()

const floor = (x: number, z: number) => ({ x, y: FLOOR_Y, z })
/** A tap that lands `lift` metres above the floor: a table, a chair seat. The gate turns it away, and a second tap at that height accepts it. */
const raised = (x: number, z: number, lift: number) => ({ x, y: FLOOR_Y + lift, z })

/** The one check-point button, pressed in the step that follows the heading marker: it skips the step. */
const SKIP_CHECK: Step = { press: 'check' }

const TABLE_WARNING = 'That looked about 40 cm above the floor. Aim at the floor, or tap the same height again to use it anyway.'

interface Committed {
  calibration: Record<string, unknown>
  spatialFrame?: Record<string, unknown> & { checkPoints?: unknown[] }
  referencePhotos?: Array<{ role: string }>
}

function committed(outcome: Outcome): Committed {
  assert.equal(outcome.closed, true, 'the modal resolved')
  assert.ok(outcome.result, 'with a calibration')
  return outcome.result as Committed
}

const scenario = (name: string, steps: Step[], extra: Partial<Scenario> = {}): Scenario => ({ name, about: name, steps, ...extra })

// ── 1. The flag is about the points it concerns ──────────────────────────────────────────────────────

test('Re-place points forgets a landmark that was accepted off the floor: the pair re-tapped on the floor is floor-checked and writes the frame', async () => {
  const outcome = await runScenario(runModal, scenario('replace after a table landmark', [
    { tap: raised(1, 2, 0.4) },
    { look: 'turned away' },
    { tap: raised(1, 2, 0.4) },
    { look: 'accepted' },
    { press: 'replace' },
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    SKIP_CHECK,
    { press: 'commit' },
  ]))
  assert.equal(outcome.looks['turned away']!.status, TABLE_WARNING, 'the first tap at 40 cm was turned away by the gate')
  assert.ok(outcome.looks['accepted']!.shown.includes('confirm'), 'and the same height again was accepted: this is a retry that bypassed the gate, until Re-place')
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(calibration['floorCheckBypassed'], false, 'every point that is in the commit is on the floor: nothing it holds was bypassed')
  assert.equal(calibration['groundY'], FLOOR_Y, 'the floor the origin sits on is the floor')
  assert.ok(spatialFrame, 'so the first visit writes the Place frame, as a floor-checked first visit does')
  assert.equal('outsidePlaceFrame' in calibration, false)
})

test('the flow that goes back to the landmark by itself (the walk took too long) forgets it too', async () => {
  const outcome = await runScenario(runModal, scenario('restart after the walk budget', [
    { tap: raised(1, 2, 0.4) },
    { tap: raised(1, 2, 0.4) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    SKIP_CHECK,
    { advance: 91_000 },
    { press: 'commit' },
    { look: 'sent back' },
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    SKIP_CHECK,
    { press: 'commit' },
  ]))
  assert.equal(outcome.looks['sent back']!.status, 'That took over 90 seconds, tap the landmark again', 'the commit was turned away and the person is back at the landmark')
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(calibration['floorCheckBypassed'], false)
  assert.ok(spatialFrame)
})

test('a check point that was accepted off the floor and then taken away no longer vetoes the frame', async () => {
  const outcome = await runScenario(runModal, scenario('remove the table check point', [
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    { tap: raised(2, 4.6, 0.3) },
    { tap: raised(2, 4.6, 0.3) },
    { look: 'with the check point' },
    { press: 'check' },
    { press: 'commit' },
  ], { capture: 'immediate' }))
  assert.match(outcome.looks['with the check point']!.status, /^That point measured 30 cm above the landmark/, 'the second tap at that height was accepted: the check point is placed')
  const { calibration, spatialFrame, referencePhotos } = committed(outcome)
  assert.equal(calibration['floorCheckBypassed'], false, 'the only point that was off the floor is gone')
  assert.ok(spatialFrame, 'so the pair writes the frame')
  assert.equal(spatialFrame!['checkPoints'], undefined, 'without the check point that was taken away')
  assert.deepEqual(referencePhotos!.map((photo) => photo.role), ['landmark', 'headingMarker'])
})

test('a check point that is still there, accepted off the floor, still makes the commit bypassed: the rule of #269 for a genuine bypass', async () => {
  const outcome = await runScenario(runModal, scenario('keep the table check point', [
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    { tap: raised(2, 4.6, 0.3) },
    { tap: raised(2, 4.6, 0.3) },
    { press: 'commit' },
  ]))
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(calibration['floorCheckBypassed'], true)
  assert.equal(calibration['status'], 'provisional')
  assert.equal(spatialFrame, undefined, 'and no Place frame is written')
  assert.equal(calibration['outsidePlaceFrame'], true, 'a first visit that wrote no frame is in none')
})

test('a heading marker accepted off the floor and then moved onto it is floor-checked: a tap that selects a marker changes nothing, and the one that moves it decides', async () => {
  const outcome = await runScenario(runModal, scenario('move the table heading marker', [
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: raised(4.5, 2, 0.4) },
    { tap: raised(4.5, 2, 0.4) },
    { tap: floor(4.5, 2) },
    { tap: floor(4.2, 2.1) },
    SKIP_CHECK,
    { press: 'commit' },
  ]))
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(calibration['floorCheckBypassed'], false, 'the marker is on the floor now')
  assert.ok(spatialFrame)
})

test('"Place anchor without floor check" stands for the whole flow: Re-place points does not undo it', async () => {
  const outcome = await runScenario(runModal, scenario('skip the floor check, then re-place', [
    { press: 'skip-ground' },
    { tap: floor(1, 2) },
    { press: 'replace' },
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    SKIP_CHECK,
    { press: 'commit' },
  ]))
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(calibration['floorCheckBypassed'], true)
  assert.equal(spatialFrame, undefined)
})

test('Re-place points starts the floor gate afresh: the height that was turned away is turned away again, not accepted outright', async () => {
  const outcome = await runScenario(runModal, scenario('the same table tap after Re-place', [
    { tap: raised(1, 2, 0.4) },
    { press: 'replace' },
    { tap: raised(1, 2, 0.4) },
    { look: 'after Re-place' },
  ]))
  assert.equal(outcome.looks['after Re-place']!.status, TABLE_WARNING, 'the gate says what it said the first time')
  assert.equal(outcome.looks['after Re-place']!.shown.includes('confirm'), false, 'and places nothing: a retry confirms a tap that was just turned away, and Re-place ended that')
})

test('the one-point tier reads the same flag: a table landmark put on the floor by Re-place is floor-checked, and "Place anchor without floor check" is not forgotten', async () => {
  // The one-point button commits the landmark alone, and its record says whether the floor check was bypassed, as the pair's does.
  const replaced = await runScenario(runModal, scenario('one point after Re-place', [
    { tap: raised(1, 2, 0.4) },
    { tap: raised(1, 2, 0.4) },
    { press: 'replace' },
    { tap: floor(1, 2) },
    { press: 'fallback' },
  ]))
  const floorChecked = committed(replaced)
  assert.equal(floorChecked.calibration['method'], 'ground-tap-compass')
  assert.equal(floorChecked.calibration['floorCheckBypassed'], false, 'the landmark that is committed is on the floor')
  assert.ok(floorChecked.spatialFrame, 'so a Place with no frame is given its one-point frame')

  const skipped = await runScenario(runModal, scenario('one point after skipping the floor check', [
    { press: 'skip-ground' },
    { tap: floor(1, 2) },
    { press: 'fallback' },
  ]))
  const bypassed = committed(skipped)
  assert.equal(bypassed.calibration['floorCheckBypassed'], true)
  assert.equal(bypassed.spatialFrame, undefined, 'and it writes no Place frame, as it never did')
})

// ── 2. The flag is judged by how high the tap measured ───────────────────────────────────────────────

/**
 * The reader the floor-ray arm (`?tap=floor`) gives the modal: the position is on the fitted floor by construction, and the hits
 * say how high the person tapped. Which tap is meant is read from where on the canvas it landed.
 */
function floorRaySampler(table: Record<string, { at: { x: number; z: number }; lift: number }>): CalibrationTapSampler {
  return async (x) => {
    const mean = table[x.toFixed(2)]
    if (!mean) throw new Error(`no tap was scripted at canvas x = ${x}`)
    return {
      ok: true,
      position: floor(mean.at.x, mean.at.z),
      hitPosition: raised(mean.at.x, mean.at.z, mean.lift),
      rangeM: 2,
      spreadM: 0.002,
      n: 12,
      rejected: 0,
      source: 'floor-ray',
    }
  }
}

test('a tabletop landmark accepted by a retry under the floor ray is bypassed, as the same taps read the default way are, and writes no frame', async () => {
  const withRay = await runScenario(runModal, scenario('table landmark, floor ray', [
    { tap: floor(1, 2), at: { x: 0.1, y: 0.5 } },
    { look: 'turned away' },
    { tap: floor(1, 2), at: { x: 0.1, y: 0.5 } },
    { press: 'confirm' },
    { tap: floor(4.5, 2), at: { x: 0.2, y: 0.5 } },
    SKIP_CHECK,
    { press: 'commit' },
  ], {
    options: {
      sampleTap: floorRaySampler({
        '0.10': { at: { x: 1, z: 2 }, lift: 0.4 },
        '0.20': { at: { x: 4.5, z: 2 }, lift: 0 },
      }),
    },
  }))
  const byDefault = await runScenario(runModal, scenario('table landmark, the default reader', [
    { tap: raised(1, 2, 0.4) },
    { tap: raised(1, 2, 0.4) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    SKIP_CHECK,
    { press: 'commit' },
  ]))
  assert.equal(withRay.looks['turned away']!.status, TABLE_WARNING, 'the gate judged what the hits measured')
  const ray = committed(withRay)
  const plain = committed(byDefault)
  assert.equal(plain.calibration['floorCheckBypassed'], true, 'the default reader: the retry was a bypass')
  assert.equal(plain.spatialFrame, undefined)
  assert.equal(ray.calibration['floorCheckBypassed'], true, 'the floor ray: the same retry is the same bypass, though its position was on the fitted floor')
  assert.equal(ray.spatialFrame, undefined, 'so it does not author the Place\'s floor at the tabletop')
  assert.equal(ray.calibration['outsidePlaceFrame'], true)
})

// ── 3. What a commit that wrote no frame says about itself, through the real modal ───────────────────

const HELD = {
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.15,
  anchorBearingDeg: 77,
  frameId: 'frame-held',
} as unknown as ProjectSpatialFrame

/** The page's hooks, answering the typed-word question with yes. */
const yes: GenerationHooks = { confirmReplace: async () => true }

test('a pair kept over a mismatch with the floor check bypassed writes no frame, says it is in none, and names no generation', async () => {
  const outcome = await runScenario(runModal, scenario('kept mismatch, bypassed', [
    { press: 'skip-ground' },
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.4, 2) },
    { press: 'commit' },
    { run: (card) => card.el('project-calibration-override').click() },
  ], { stored: HELD, options: { generation: yes } }))
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(spatialFrame, undefined, 'the Place frame is not written: the floor was not checked')
  assert.equal(calibration['floorCheckBypassed'], true)
  assert.ok(Math.abs((calibration['residualM'] as number) - 0.4) < 1e-9, 'the pair was 40 cm over the stored 3 m, and the record keeps what failed')
  assert.equal(calibration['outsidePlaceFrame'], true)

  const plan = planFrameGeneration({ held: HELD, calibration: calibration as unknown as ScanCalibration, spatialFrame: spatialFrame as ProjectSpatialFrame | undefined })
  assert.equal(calibrationFrameIdOf(plan.calibration), null, 'it was compared with the held frame and did not match, so it was not measured against it')
  assert.equal(plan.replaces, undefined, 'and replaces nothing')
})

test('"Improve this Place\'s reference" with the floor check bypassed improves nothing, and the scan does not name the frame it was to improve', async () => {
  const outcome = await runScenario(runModal, scenario('improve, bypassed', [
    { press: 'skip-ground' },
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.4, 2) },
    SKIP_CHECK,
    { press: 'commit' },
  ], { options: { generation: { mode: 'upgrade' } } }))
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(spatialFrame, undefined)
  const plan = planFrameGeneration({ held: HELD, calibration: calibration as unknown as ScanCalibration, spatialFrame: spatialFrame as ProjectSpatialFrame | undefined, mode: 'upgrade' })
  assert.equal(calibrationFrameIdOf(plan.calibration), null)
  assert.equal(plan.replaces, undefined)
  assert.equal(calibration['outsidePlaceFrame'], true)
})

test('a return visit that matched with the floor check bypassed is still in the frame it matched, and names it', async () => {
  const outcome = await runScenario(runModal, scenario('matched, bypassed', [
    { press: 'skip-ground' },
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.05, 2) },
    { press: 'commit' },
  ], { stored: HELD }))
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(spatialFrame, undefined)
  assert.equal(calibration['floorCheckBypassed'], true)
  assert.equal('outsidePlaceFrame' in calibration, false, 'it was compared with the held frame and kept no mismatch')
  const plan = planFrameGeneration({ held: HELD, calibration: calibration as unknown as ScanCalibration, spatialFrame: undefined })
  assert.equal(calibrationFrameIdOf(plan.calibration), 'frame-held')
})

// ── 3b. The mismatch screen's way to keep the pair ───────────────────────────────────────────────────

const OVERRIDE = 'project-calibration-override'
const REPLACE_LABEL = "Replace this Place's reference"
const UNVERIFIED_LABEL = 'Record as unverified'

/** The page's hooks, recording what the page would ask the person, and answering yes. */
function askingHooks(): { hooks: GenerationHooks; asked: ReplaceAsk[] } {
  const asked: ReplaceAsk[] = []
  return {
    asked,
    hooks: {
      confirmReplace: async (_host, ask) => {
        asked.push(ask)
        return true
      },
    },
  }
}

/** The mismatch screen's way to keep the pair as the card shows it now, and then the press. */
function pressOverride(seen: Array<{ shown: boolean; label: string }>): Step {
  return {
    run: (card) => {
      const button = card.el(OVERRIDE)
      seen.push({ shown: !button.hidden, label: button.textContent })
      button.click()
    },
  }
}

/** A return visit to the held 3 m pair whose two points are 3.4 m apart: the mismatch screen, after `before`. */
const toMismatch = (before: Step[]): Step[] => [...before, { tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(4.4, 2) }, { press: 'commit' }]

test('a pair kept over a mismatch with the floor check bypassed asks nothing about replacing the reference, and the button says what it does', async () => {
  const { hooks, asked } = askingHooks()
  const seen: Array<{ shown: boolean; label: string }> = []
  const outcome = await runScenario(runModal, scenario('bypassed mismatch, the question', [
    ...toMismatch([{ press: 'skip-ground' }]),
    { look: 'mismatch' },
    pressOverride(seen),
  ], { stored: HELD, capture: 'deferred', options: { generation: hooks } }))
  assert.ok(outcome.looks['mismatch']!.shown.includes('override'), 'the way to keep the pair is on the card: a room whose floor never locks has no other way to')
  assert.deepEqual(seen, [{ shown: true, label: UNVERIFIED_LABEL }], 'and it says it records the scan as unverified, not that it replaces the reference')
  assert.deepEqual(asked, [], 'nothing is replaced, so nothing is asked: the typed word and "stay in the Place, listed as previous reference" would promise what cannot happen')
  // Nothing in this scenario releases the camera: a commit that waited for photos (the hold a replacement may make) would still be open.
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(spatialFrame, undefined, 'no frame is saved, so no photo is kept or waited for: the commit is the press')
  assert.equal(calibration['floorCheckBypassed'], true)
  assert.equal(calibration['status'], 'provisional')
  assert.equal(calibration['outsidePlaceFrame'], true)
})

test('a pair kept over a mismatch with the floor checked is the replacement it always was: asked first, in the same words, and the frame is written', async () => {
  const { hooks, asked } = askingHooks()
  const seen: Array<{ shown: boolean; label: string }> = []
  const outcome = await runScenario(runModal, scenario('checked mismatch, the question', [
    ...toMismatch([]),
    pressOverride(seen),
  ], { stored: HELD, capture: 'immediate', options: { generation: hooks } }))
  assert.deepEqual(seen, [{ shown: true, label: REPLACE_LABEL }])
  assert.equal(asked.length, 1, 'asked once')
  assert.equal(asked[0]!.reason, 'override')
  assert.ok(Math.abs(asked[0]!.residualM! - 0.4) < 1e-9, 'with the residual the card showed')
  const { calibration, spatialFrame } = committed(outcome)
  assert.ok(spatialFrame, 'the pair replaces the reference')
  assert.equal(calibration['floorCheckBypassed'], false)
  assert.equal('outsidePlaceFrame' in calibration, false)
})

test('an off-floor tap accepted by a retry, and still in the pair, makes the same card: the button records as unverified and nothing is asked', async () => {
  const { hooks, asked } = askingHooks()
  const seen: Array<{ shown: boolean; label: string }> = []
  const outcome = await runScenario(runModal, scenario('table landmark, mismatch', [
    { tap: raised(1, 2, 0.4) },
    { tap: raised(1, 2, 0.4) },
    { press: 'confirm' },
    { tap: floor(4.4, 2) },
    { press: 'commit' },
    pressOverride(seen),
  ], { stored: HELD, options: { generation: hooks } }))
  assert.deepEqual(seen, [{ shown: true, label: UNVERIFIED_LABEL }])
  assert.deepEqual(asked, [])
  const { calibration, spatialFrame } = committed(outcome)
  assert.equal(spatialFrame, undefined)
  assert.equal(calibration['floorCheckBypassed'], true)
  assert.equal(calibration['outsidePlaceFrame'], true)
})

test('the button is redrawn with the flag: a table tap that is moved onto the floor, or discarded by Re-place points, gives the replacement back, asked as before', async () => {
  // The button is one element for the whole flow, so a label set only while the floor check is bypassed would stay on it.
  const moved = askingHooks()
  const seenMoved: Array<{ shown: boolean; label: string }> = []
  const afterMove = await runScenario(runModal, scenario('table landmark, moved onto the floor', [
    { tap: raised(1, 2, 0.4) },
    { tap: raised(1, 2, 0.4) },
    { press: 'confirm' },
    { tap: floor(4.4, 2) },
    { press: 'commit' },
    { run: (card) => { seenMoved.push({ shown: !card.el(OVERRIDE).hidden, label: card.el(OVERRIDE).textContent }) } },
    { press: 'adjust' },
    { tap: floor(1, 2) },
    { tap: floor(1.05, 2) },
    { press: 'commit' },
    pressOverride(seenMoved),
  ], { stored: HELD, options: { generation: moved.hooks } }))
  assert.deepEqual(seenMoved, [{ shown: true, label: UNVERIFIED_LABEL }, { shown: true, label: REPLACE_LABEL }], 'bypassed, then floor-checked once the marker is on the floor')
  assert.equal(moved.asked.length, 1, 'and the replacement it now is asks, as it does')
  assert.ok(committed(afterMove).spatialFrame, 'and writes the frame')

  const replaced = askingHooks()
  const seenReplaced: Array<{ shown: boolean; label: string }> = []
  const afterReplace = await runScenario(runModal, scenario('table landmark, Re-place points', [
    { tap: raised(1, 2, 0.4) },
    { tap: raised(1, 2, 0.4) },
    { press: 'confirm' },
    { tap: floor(4.4, 2) },
    { press: 'commit' },
    { run: (card) => { seenReplaced.push({ shown: !card.el(OVERRIDE).hidden, label: card.el(OVERRIDE).textContent }) } },
    { press: 'replace' },
    ...toMismatch([]),
    pressOverride(seenReplaced),
  ], { stored: HELD, options: { generation: replaced.hooks } }))
  assert.deepEqual(seenReplaced, [{ shown: true, label: UNVERIFIED_LABEL }, { shown: true, label: REPLACE_LABEL }])
  assert.equal(replaced.asked.length, 1)
  assert.ok(committed(afterReplace).spatialFrame)

  // "Place anchor without floor check" is the flow's own and stands, so the label does too after Re-place points.
  const skipped = askingHooks()
  const seenSkipped: Array<{ shown: boolean; label: string }> = []
  await runScenario(runModal, scenario('skipped floor check, Re-place points', [
    { press: 'skip-ground' },
    ...toMismatch([]),
    { press: 'replace' },
    ...toMismatch([]),
    pressOverride(seenSkipped),
  ], { stored: HELD, options: { generation: skipped.hooks } }))
  assert.deepEqual(seenSkipped, [{ shown: true, label: UNVERIFIED_LABEL }])
  assert.deepEqual(skipped.asked, [])
})

test('the rule that decides the question is the one that decides the label, and a page that says nothing about it asks as it always did', async () => {
  const stored = HELD
  const run = async (replacesReference: (() => boolean) | undefined, answer: boolean) => {
    const asked: ReplaceAsk[] = []
    let kept = 0
    const actions = generationActions(
      { confirmReplace: async (_host, ask) => { asked.push(ask); return answer } },
      {
        overlay: {} as HTMLElement,
        stored,
        stage: () => 'mismatch',
        hasLandmark: () => true,
        residualM: () => 0.4,
        keepPair: async () => { kept += 1 },
        close: () => {},
        ...(replacesReference ? { replacesReference } : {}),
      },
    )
    await actions.replace()
    return { asked: asked.length, kept }
  }
  assert.deepEqual(await run(() => false, true), { asked: 0, kept: 1 }, 'keeping the pair replaces nothing: the pair is kept, with no question')
  assert.deepEqual(await run(() => false, false), { asked: 0, kept: 1 }, 'and there is no answer to be no: it is not a replacement to refuse')
  assert.deepEqual(await run(() => true, true), { asked: 1, kept: 1 }, 'a replacement asks, and a yes keeps the pair')
  assert.deepEqual(await run(() => true, false), { asked: 1, kept: 0 }, 'and a no does not')
  assert.deepEqual(await run(undefined, true), { asked: 1, kept: 1 }, 'a seam that does not say replaces, as every caller before did')
})

// ── 4. A commit that waits for its photos ────────────────────────────────────────────────────────────

test('the check-point button is off while a commit waits for its photos, and Remove pressed anyway does not change what is saved', async () => {
  const outcome = await runScenario(runModal, scenario('remove while saving', [
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    { tap: floor(2, 4.6) },
    { press: 'commit' },
    { look: 'waiting' },
    { press: 'check' },
    { look: 'after the press' },
    { release: true },
  ], { capture: 'deferred' }))
  const waiting = outcome.looks['waiting']!
  assert.equal(waiting.status, 'Saving reference photos…')
  assert.ok(waiting.disabled.includes('check'), 'the button that changes the points is off while the points are being saved')
  assert.equal(outcome.looks['after the press']!.status, 'Saving reference photos…', 'and the press changed nothing')
  const { spatialFrame, referencePhotos } = committed(outcome)
  assert.equal(spatialFrame!.checkPoints!.length, 1, 'the frame holds the check point the person saw when they pressed Commit')
  assert.deepEqual(referencePhotos!.map((photo) => photo.role), ['landmark', 'headingMarker', 'check1'], 'with a photo of each of the three points')
})

test('Add a check point pressed while a commit waits does not abandon it: the card stays in review, saving, and the commit finishes', async () => {
  const outcome = await runScenario(runModal, scenario('add while saving', [
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    SKIP_CHECK,
    { press: 'commit' },
    { press: 'check' },
    { look: 'after the press' },
    { release: true },
  ], { capture: 'deferred' }))
  assert.equal(outcome.looks['after the press']!.status, 'Saving reference photos…', 'the card is not sent to the check-point step, and does not stop saying what is happening')
  assert.equal(outcome.looks['after the press']!.title, 'Check the alignment')
  assert.equal(outcome.closed, true, 'the commit that was waiting is the one that finishes')
  const { spatialFrame, referencePhotos } = committed(outcome)
  assert.equal(spatialFrame!.checkPoints, undefined, 'the pair the person committed')
  assert.deepEqual(referencePhotos!.map((photo) => photo.role), ['landmark', 'headingMarker'])
})

test('once the commit is over the check-point button is what it was: pressed in review it removes a point and adds one back', async () => {
  const outcome = await runScenario(runModal, scenario('the button outside a commit', [
    { tap: floor(1, 2) },
    { press: 'confirm' },
    { tap: floor(4.5, 2) },
    { tap: floor(2, 4.6) },
    { look: 'with the point' },
    { press: 'check' },
    { look: 'removed' },
    { press: 'check' },
    { look: 'asked again' },
  ]))
  assert.equal(outcome.looks['with the point']!.disabled.includes('check'), false)
  assert.equal(outcome.looks['removed']!.disabled.includes('check'), false)
  assert.equal(outcome.looks['asked again']!.disabled.includes('check'), false)
  assert.ok(outcome.looks['asked again']!.shown.includes('check'))
})
