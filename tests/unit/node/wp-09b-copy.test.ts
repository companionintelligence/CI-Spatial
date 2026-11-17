/**
 * What the scanner says about a frame that may have moved, and about a drift check (WP-09b, src/ar/reanchor-copy.ts),
 * held to what the code knows (ADR 0005 rule 3) and to the style of src/ar/alignment-status.ts.
 *
 *  - A discontinuity is the runtime saying tracking was lost or its origin moved, not proof that a frame did: the words
 *    say tracking was interrupted and that parts MAY be shifted, and never that the scan is wrong or aligned or verified.
 *  - Re-anchoring inherits the Place frame's own error, and the figure that says how much is an estimate, worked from
 *    the saved points' shape and the adopted tap noise, so it is labelled one. It is the figure the calibration card
 *    quotes for the same points a moment later, not another one, and says how many taps made them.
 *  - The choice says what the person will be asked next and what skipping it leaves, and that recording is paused.
 *  - A limit that lets a turn through which the product's own accuracy would not is said, with what it lets through.
 *  - A closure result states what was measured, names the limit with its figures, and says that "the frame has moved"
 *    holds only if the same spots were tapped.
 *  - A number that does not exist is never printed.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-copy.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { closureRecord, type ClosureMeasurement, type FrameClosureRecord } from '../../../src/ar/closure.ts'
import * as copy from '../../../src/ar/reanchor-copy.ts'
import { baselineGuidance } from '../../../src/world/baseline-guidance.ts'
import { twoPointFrame, onePointFrame } from './support/reanchor-rig.ts'

const record = (over: Partial<ClosureMeasurement> = {}, context: { path?: number } = {}): FrameClosureRecord =>
  closureRecord(
    { translationM: 0.12, dyM: 0, yawDeg: 3.2, baselineM: 3, points: 2, ...over },
    { at: '2026-11-17T09:30:00.000Z', epoch: 0, pathLengthM: context.path ?? 14.4, taps: [] },
  )

/** Every sentence the module can produce, over a spread of inputs: for the checks that must hold of all of them. */
function everySentence(): string[] {
  const records = [
    record(),
    record({ translationM: 0.5, dyM: 0.08, yawDeg: -9 }),
    record({ translationM: 0.01, dyM: 0, yawDeg: null, baselineM: null, points: 1 }),
    record({ translationM: 1.4, yawDeg: 40 }, { path: 0.4 }),
    record({ translationM: 0.02, yawDeg: 0.4, baselineM: 1 }),
    record({ translationM: 0.02, yawDeg: 0.4, baselineM: 5 }),
  ]
  return [
    copy.REANCHOR_LABEL, copy.KEEP_GOING_LABEL, copy.CHECK_DRIFT_LABEL, copy.CANCEL_LABEL, copy.SKIP_HEADING_LABEL, copy.DONE_LABEL,
    copy.CHECK_DRIFT_TITLE, copy.NO_FRAME_WARNING, copy.ONE_POINT_FRAME_WARNING, copy.FRAME_SET_ACROSS_SHIFT_WARNING, copy.AUTOSPLIT_NOTICE,
    copy.SAVING_TEXT, copy.SAVE_FAILED_TEXT, copy.SAVE_SLOW_TEXT, copy.CAPTURE_HELD_TEXT,
    copy.RECORDING_PAUSED_TEXT, copy.RECORDING_HELD_HINT, copy.RECORDING_SAVING_HINT,
    copy.TAP_LANDMARK_DETAIL, copy.READING_TAP_TEXT, copy.CHECK_UNAVAILABLE_TEXT, copy.CHECK_FAILED_TEXT,
    copy.interruptionText(1), copy.interruptionText(3),
    copy.reanchorDetail(twoPointFrame()), copy.reanchorDetail(twoPointFrame({ separationM: 1 })), copy.reanchorDetail(null), copy.reanchorDetail(onePointFrame()),
    copy.interruptionDetail(twoPointFrame({ separationM: 1 })), copy.interruptionDetail(null),
    copy.cannotReanchorWarning(null), copy.cannotReanchorWarning(onePointFrame()), copy.cannotReanchorWarning(twoPointFrame()),
    copy.tapLandmarkText(), copy.tapLandmarkText('north door frame'), copy.tapHeadingText(), copy.tapHeadingText('radiator corner'),
    copy.tapHeadingDetail(3.2), copy.tapHeadingDetail(null),
    ...records.flatMap((each) => [copy.closureMeasurementText(each), copy.closureVerdictText(each)]),
  ]
}

test('nothing it says claims the frame, the scan or the alignment is verified, aligned, exact or proven', () => {
  for (const sentence of everySentence()) {
    assert.doesNotMatch(sentence, /\bverified\b|\baligned\b|\balignment\b|\bexact(ly)?\b|\bproof\b|\bproven\b|\bperfect/i, sentence)
  }
})

test('nothing it says prints a number that does not exist', () => {
  for (const sentence of everySentence()) assert.doesNotMatch(sentence, /NaN|undefined|null|Infinity/, sentence)
})

test('the interruption line says tracking was interrupted and that parts MAY be shifted, counting the times', () => {
  assert.equal(copy.interruptionText(1), 'Tracking was interrupted. Parts of this scan may be shifted.')
  assert.equal(copy.interruptionText(2), 'Tracking was interrupted 2 times. Parts of this scan may be shifted.')
  assert.equal(copy.interruptionText(11), 'Tracking was interrupted 11 times. Parts of this scan may be shifted.')
  for (const odd of [0, -3, Number.NaN, 2.9]) {
    assert.match(copy.interruptionText(odd), /^Tracking was interrupted( 2 times)?\. Parts of this scan may be shifted\.$/, String(odd))
  }
  assert.equal(copy.interruptionText(Number.NaN), copy.interruptionText(1), 'a count that is not a number is read as one')
  assert.equal(copy.interruptionText(0), copy.interruptionText(1), 'the prompt exists because it happened at least once')
})

test('the figure is the one the calibration card quotes for the same pair: how far two scans set against it may differ', () => {
  // The card the person is sent to next (src/world/baseline-guidance.ts) and this prompt are about the same pair seconds
  // apart, so two figures for it would be read as a disagreement. The card's is the 95th percentile of the difference
  // between two scans, from `frameUncertaintyAt` (src/world/frame-fit.ts).
  const centimetres = (text: string): number => Number(/about ([\d.]+) cm/.exec(text)![1])
  for (const separationM of [1, 1.5, 2, 3, 4.5]) {
    const figure = copy.scanDisagreementM(twoPointFrame({ separationM }))!
    assert.ok(figure > 0 && Number.isFinite(figure), String(separationM))
    assert.equal(centimetres(copy.reanchorDetail(twoPointFrame({ separationM }))), centimetres(baselineGuidance(separationM, separationM).text), `${separationM} m`)
  }
  assert.ok(Math.abs(copy.scanDisagreementM(twoPointFrame({ separationM: 1 }))! - 0.592) < 0.001, 'about 59.2 cm for the work package\'s 1 m pair')
  const at = (metres: number) => copy.scanDisagreementM(twoPointFrame({ separationM: metres }))!
  assert.ok(at(1) > at(2) && at(2) > at(3) && at(3) > at(5), 'a longer pair is a better frame')
})

test('a frame that is not a two-point one, or has no usable pair, has no figure', () => {
  assert.equal(copy.scanDisagreementM(null), null)
  assert.equal(copy.scanDisagreementM(undefined), null)
  assert.equal(copy.scanDisagreementM(onePointFrame()), null)
  for (const separationM of [0, -1, Number.NaN, Infinity]) {
    assert.equal(copy.scanDisagreementM(twoPointFrame({ separationM })), null, String(separationM))
  }
})

test('the re-anchor line says what it does, what it asks next, what skipping that leaves, the inherited error as an estimate, and what Keep going leaves', () => {
  const detail = copy.reanchorDetail(twoPointFrame({ separationM: 1 }))
  assert.match(detail, /^Re-anchor saves this scan, then asks you to tap the saved points again to start a new one\. /)
  assert.match(detail, /Skip that and the new scan is not set against the Place's frame\. /, 'what skipping the taps costs: the old scan is already saved')
  assert.match(detail, /The saved points came from two taps, so the new scan inherits their error\. Estimate: two scans would place a spot 5 m away up to about 59\.2 cm apart \(95 of 100 times\)\. /)
  assert.match(detail, / Keep going leaves this scan marked for review\.$/)
  assert.match(copy.reanchorDetail(twoPointFrame({ separationM: 3 })), /about 20\.7 cm/)
})

test('a Place saved with a check point says three taps and quotes the shape of the three, which is the card\'s figure for them', () => {
  const pair = twoPointFrame({ separationM: 3 })
  const three = { ...pair, checkPoints: [{ x: 2, y: 0, z: 1.5 }] }
  assert.equal(copy.savedPoints(three)?.length, 3)
  const detail = copy.reanchorDetail(three)
  assert.match(detail, /The saved points came from three taps, so the new scan inherits their error\. Estimate: /)
  assert.doesNotMatch(detail, /two taps/)
  // The card quotes this same figure for the same stored shape on a return visit.
  const centimetres = (text: string): number => Number(/about ([\d.]+) cm/.exec(text)![1])
  assert.equal(centimetres(detail), centimetres(baselineGuidance(3, 3, undefined, copy.savedPoints(three)).text))
  assert.ok(copy.scanDisagreementM(three)! < copy.scanDisagreementM(pair)!, 'a third point makes a better frame, and the figure shows it')
  // A damaged check point ends the run: the pair is what is left, and it is said to be two taps.
  const damaged = { ...pair, checkPoints: [{ x: Number.NaN, y: 0, z: 1 }] }
  assert.equal(copy.savedPoints(damaged)?.length, 2)
  assert.match(copy.reanchorDetail(damaged), /came from two taps/)
})

test('with no figure to give it still says the error is inherited, and prints no placeholder', () => {
  for (const frame of [null, onePointFrame(), twoPointFrame({ separationM: Number.NaN })]) {
    const detail = copy.reanchorDetail(frame)
    assert.match(detail, /the new scan inherits their error\. Keep going/)
    assert.doesNotMatch(detail, /about \d|estimate|\d cm/)
  }
})

test('the choice says that recording is paused until it is made, ahead of what each button does', () => {
  const detail = copy.interruptionDetail(twoPointFrame({ separationM: 1 }))
  assert.ok(detail.startsWith(`${copy.RECORDING_PAUSED_TEXT} Re-anchor saves this scan`), detail)
  assert.equal(copy.RECORDING_PAUSED_TEXT, 'Recording is paused until you choose.')
  assert.ok(detail.endsWith(copy.reanchorDetail(twoPointFrame({ separationM: 1 }))), 'the re-anchor words are the same ones the closure proposal uses')
})

test('the HUD says recording is paused, in the shape of its own "Not recording" line, and what the person can do', () => {
  for (const hint of [copy.RECORDING_HELD_HINT, copy.RECORDING_SAVING_HINT]) {
    assert.match(hint, /^⚠ Recording paused\n• [^\n]+$/, 'a headline and one bullet, as ⚠ Not recording is')
  }
  assert.match(copy.RECORDING_HELD_HINT, /Re-anchor or Keep going/)
  assert.match(copy.RECORDING_SAVING_HINT, /Saving this scan/)
})

test('a scan whose recording is held is never shown as ready, and its other verdicts are left as they are', () => {
  assert.equal(copy.displayedStatus('ready', true), 'needs-review')
  assert.equal(copy.displayedStatus('ready', false), 'ready')
  assert.equal(copy.displayedStatus('needs-review', true), 'needs-review')
  assert.equal(copy.displayedStatus('needs-rescan', true), 'needs-rescan', 'a held scan that is also sparse is still sparse')
  assert.equal(copy.displayedStatus('needs-rescan', false), 'needs-rescan')
})

test('the warnings when no re-anchor can be offered are a headline and one bullet, as the alignment status lines are', () => {
  for (const text of [copy.NO_FRAME_WARNING, copy.ONE_POINT_FRAME_WARNING, copy.FRAME_SET_ACROSS_SHIFT_WARNING, copy.AUTOSPLIT_NOTICE]) {
    assert.match(text, /^⚠ Tracking was interrupted[^\n]*\n• [^\n]+$/)
  }
  for (const text of [copy.NO_FRAME_WARNING, copy.ONE_POINT_FRAME_WARNING, copy.FRAME_SET_ACROSS_SHIFT_WARNING]) {
    assert.match(text, /Scan marked for review$/, 'what happens to the scan, which is what the person can act on')
  }
})

test('each warning says why there is nothing to re-anchor to: no frame at all and a frame of one point are different facts', () => {
  assert.equal(copy.cannotReanchorWarning(null), copy.NO_FRAME_WARNING)
  assert.equal(copy.cannotReanchorWarning(undefined), copy.NO_FRAME_WARNING)
  assert.equal(copy.cannotReanchorWarning(onePointFrame()), copy.ONE_POINT_FRAME_WARNING)
  assert.match(copy.NO_FRAME_WARNING, /No saved frame/)
  assert.match(copy.ONE_POINT_FRAME_WARNING, /Saved frame is one point/)
  assert.doesNotMatch(copy.ONE_POINT_FRAME_WARNING, /No saved frame/, 'a Place that has a frame is not said to have none')
})

test('a frame set while tracking was interrupted is said to be possibly shifted, and no re-anchor is offered against it', () => {
  assert.match(copy.FRAME_SET_ACROSS_SHIFT_WARNING, /while the points were set/)
  assert.match(copy.FRAME_SET_ACROSS_SHIFT_WARNING, /may be shifted/, '"may": the interruption is not proof')
  assert.doesNotMatch(copy.FRAME_SET_ACROSS_SHIFT_WARNING, /Re-anchor|about \d+ cm/)
})

test('a save that did not answer is not called a failure, because it may still arrive, and says that nothing was ended', () => {
  assert.match(copy.SAVE_SLOW_TEXT, /taking too long/)
  assert.match(copy.SAVE_SLOW_TEXT, /not ended/)
  assert.doesNotMatch(copy.SAVE_SLOW_TEXT, /fail|could not/i)
  assert.match(copy.SAVE_FAILED_TEXT, /Could not save/)
})

test('distances are whole centimetres below a metre and a metre to one place above, and one that rounds to a metre is a metre', () => {
  assert.equal(copy.describeDistance(0.04), '4 cm')
  assert.equal(copy.describeDistance(-0.04), '4 cm', 'unsigned')
  assert.equal(copy.describeDistance(0.994), '99 cm')
  assert.equal(copy.describeDistance(0.996), '1.0 m', 'never 100 cm beside 1.0 m')
  assert.equal(copy.describeDistance(1), '1.0 m')
  assert.equal(copy.describeDistance(2.345), '2.3 m')
})

test('the tap prompts name the stored point when it has a label, and ignore a label with nothing in it', () => {
  assert.equal(copy.tapLandmarkText(), 'Tap the landmark again')
  assert.equal(copy.tapLandmarkText('  north door frame '), 'Tap the landmark again “north door frame”')
  for (const blank of ['', '   ', null, undefined]) assert.equal(copy.tapLandmarkText(blank), 'Tap the landmark again')
  assert.equal(copy.tapHeadingText('radiator corner'), 'Tap the heading marker “radiator corner”')
  assert.equal(copy.tapHeadingText(), 'Tap the heading marker')
})

test('the heading prompt says how far it is when the pair is known, and that skipping it means the turn is not measured', () => {
  assert.equal(copy.tapHeadingDetail(3.2), 'Point B, about 3.2 m from the landmark. Skip it to check the landmark alone: the turn is then not measured.')
  for (const unknown of [null, undefined, 0, -1, Number.NaN]) {
    assert.match(copy.tapHeadingDetail(unknown), /^Point B, the second spot you chose\./, String(unknown))
  }
})

test('a refused tap is given in the words sampleTap gave', () => {
  assert.equal(copy.refusedTapDetail({ ok: false, reason: 'too-far', n: 5, rangeM: 4.26 }), 'That spot is 4.3 m away. Move closer and tap again.')
  assert.equal(copy.refusedTapDetail({ ok: false, reason: 'no-hit', n: 0 }), 'No stable surface there. Aim at a textured floor and tap again.')
})

test('what the check measured is stated as a measurement, with every figure the record holds and no sign on a distance', () => {
  assert.equal(copy.closureMeasurementText(record()), 'Re-tap landed 12 cm from the stored landmark, heading turned 3.2°, after about 14 m of walking.')
  assert.equal(
    copy.closureMeasurementText(record({ translationM: 0.5, dyM: 0.08, yawDeg: -9 }, { path: 41.6 })),
    'Re-tap landed 50 cm from the stored landmark, 8 cm higher, heading turned 9.0°, after about 42 m of walking.',
    'the heading is a size, not a sign: which way is for the sidecar',
  )
  assert.equal(
    copy.closureMeasurementText(record({ dyM: -0.034 })),
    'Re-tap landed 12 cm from the stored landmark, 3 cm lower, heading turned 3.2°, after about 14 m of walking.',
  )
})

test('with the landmark alone there is no heading to report, and a height that rounds to nothing is left out', () => {
  const text = copy.closureMeasurementText(record({ dyM: 0.004, yawDeg: null, baselineM: null, points: 1 }))
  assert.equal(text, 'Re-tap landed 12 cm from the stored landmark, after about 14 m of walking.')
  assert.doesNotMatch(text, /heading|higher|lower/)
})

test('a short walk is "less than 1 m", and a path that is not a number is too', () => {
  for (const path of [0, 0.4, Number.NaN, -3]) {
    assert.match(copy.closureMeasurementText(record({}, { path })), /after less than 1 m of walking\.$/, String(path))
  }
  assert.match(copy.closureMeasurementText(record({}, { path: 1 })), /after about 1 m of walking\.$/)
})

test('past the limit it names the limit with its figures and says the frame has moved only if the same spots were tapped', () => {
  const past = record({ translationM: 0.5 })
  assert.equal(past.exceeded, true)
  assert.equal(
    copy.closureVerdictText(past),
    'Past the check\'s limit (17 cm and 4.7°). If you tapped the same spots, the frame has moved since you set it.',
  )
})

test('within the limit it says so and claims nothing about the frame', () => {
  // A pair 5 m apart: the limit on the turn is the product's own floor, so there is nothing more to say.
  const within = record({ translationM: 0.03, yawDeg: 0.5, baselineM: 5 })
  assert.equal(within.exceeded, false)
  const text = copy.closureVerdictText(within)
  assert.equal(text, 'Within the check\'s limit (17 cm and 3.5°).')
  assert.doesNotMatch(text, /moved|no drift|did not|stable|fine|good|accurate/i, 'a limit that is the noise of a re-tap is not a clean bill of health')
})

test('with a limit on the turn wider than the product\'s own accuracy it says what a turn as large as the limit would do', () => {
  // 3 m: the limit is 4.7 degrees, which moves something 5 m from the landmark by 41 cm, past the 30 cm the product aims at.
  const three = copy.closureVerdictText(record({ translationM: 0.03, yawDeg: 0.5 }))
  assert.equal(three, 'Within the check\'s limit (17 cm and 4.7°). A turn that small can still move something 5 m from the landmark by about 41 cm.')
  // 1 m: the limit is 14.2 degrees, which is 1.2 m.
  const one = copy.closureVerdictText(record({ translationM: 0.03, yawDeg: 0.5, baselineM: 1 }))
  assert.equal(one, 'Within the check\'s limit (17 cm and 14.2°). A turn that small can still move something 5 m from the landmark by about 1.2 m.')
  assert.ok(copy.turnMovesAtRadiusM(14.17) > 1.2 && copy.turnMovesAtRadiusM(14.17) < 1.3)
  assert.equal(copy.turnMovesAtRadiusM(-14.17), copy.turnMovesAtRadiusM(14.17), 'a size, not a sign')
  assert.equal(copy.turnMovesAtRadiusM(0), 0)
})

test('the note about a wide limit is not said past the limit, with the landmark alone, or when the limit is the floor', () => {
  assert.doesNotMatch(copy.closureVerdictText(record({ translationM: 0.5, baselineM: 1 })), /can still move/, 'past the limit the verdict is the other one')
  assert.doesNotMatch(copy.closureVerdictText(record({ translationM: 0.03, yawDeg: null, baselineM: null, points: 1 })), /can still move/, 'no heading was judged')
  assert.doesNotMatch(copy.closureVerdictText(record({ translationM: 0.03, yawDeg: 0.5, baselineM: 5 })), /can still move/, '5 m: the limit is the floor')
  assert.doesNotMatch(copy.closureVerdictText(record({ translationM: 0.03, yawDeg: 0.5, baselineM: 4.5 })), /can still move/, '4.5 m: the limit is still the floor')
})

test('with no heading the limit is the distance alone', () => {
  const landmarkOnly = record({ translationM: 0.03, yawDeg: null, baselineM: null, points: 1 })
  assert.equal(copy.closureVerdictText(landmarkOnly), 'Within the check\'s limit (17 cm).')
})
