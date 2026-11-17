/**
 * The words the constellation flow adds to the calibration card (src/ar/constellation-copy.ts, WP-04b), written out in full.
 *
 * The owner approves these sentences (owner decision 7a-1), so each is pinned here exactly, where the owner can read the list
 * in one place. What the file holds the copy to besides that:
 *
 *  - it says only what the code measured (ADR 0005 rule 3). The sentences about a comparison are the verdict's own
 *    (`verifyFit`, src/world/frame-fit.ts): the readout prints them and adds none, and a comparison that passed still ends by
 *    naming what taps cannot see. Nothing says the Place, the frame or the alignment is verified;
 *  - the sentences the two markers have always had (the reference panel's notes, the review step's instruction) are word for
 *    word what they were, so that nothing already on a phone reads differently;
 *  - a figure is written as the verdict writes it, so the card and the status line cannot disagree by a rounding.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-constellation-copy.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADD_CHECK_LABEL,
  ADJUST_POINT_LABEL,
  CHECK_BLOCKED_STATUS,
  CHECK_RETURN_TITLE,
  CHECK_SKIPPED_RETURN,
  CHECK_STAGE_TITLE,
  CHECK_STATUS,
  CHECK_STEP_LABEL,
  MISMATCH_COPY_POINTS,
  MISMATCH_TITLE_POINTS,
  REMOVE_CHECK_LABEL,
  REVIEW_COPY,
  REVIEW_MISMATCH_STATUS,
  REVIEW_COPY_WITH_CHECK,
  SKIP_CHECK_LABEL,
  WRONG_PLACE_LABEL,
  checkStageCard,
  checkStageCopy,
  fitReadout,
  labelCaption,
  markerName,
  noPhotoNote,
  perPointLine,
  reviewCopy,
  uncomparedReadout,
  type Readout,
} from '../../../src/ar/constellation-copy.ts'
import { NOT_CHECKED_SPOTS, fitRigid2D, verifyFit, verifyTwoPoint } from '../../../src/world/frame-fit.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('the check-point step, in full: title, what it asks for, status and the three states of its one button', () => {
  assert.equal(CHECK_STEP_LABEL, 'Point C')
  assert.equal(CHECK_STAGE_TITLE, 'Add a check point (recommended)')
  assert.equal(
    checkStageCopy(null),
    'Optional. Tap a third ground feature at least 3 m from point A and 2 m off the line from A to B. ' +
      'Later visits can then compare the shape the three points make, not only the distance between two.',
  )
  assert.equal(CHECK_STATUS, 'Tap the ground to place the check point.')
  assert.equal(SKIP_CHECK_LABEL, 'Skip the check point')
  assert.equal(ADD_CHECK_LABEL, 'Add a check point (recommended)')
  assert.equal(REMOVE_CHECK_LABEL, 'Remove the check point')
  assert.deepEqual(checkStageCard(null), { title: CHECK_STAGE_TITLE, copy: checkStageCopy(null), status: CHECK_STATUS })
})

test('the step is numbered as the third when the steps before it count to three, and says only what a fit of three does with it', () => {
  assert.equal(
    checkStageCopy(null, 3),
    'Step 3 of 3 (optional) — tap a third ground feature at least 3 m from point A and 2 m off the line from A to B. ' +
      'Later visits can then compare the shape the three points make, not only the distance between two.',
  )
  assert.equal(
    checkStageCopy(4.2, 3),
    'Step 3 of 3 — tap point C, the check point from last time, about 4.2 m from the landmark. ' +
      'It lets this visit compare the shape the three points make, not only the distance between two.',
  )
  // A count of two (or none) leaves the step unnumbered, because the steps before it say "of 2".
  assert.equal(checkStageCopy(null, 2), checkStageCopy(null))
  assert.doesNotMatch(checkStageCopy(null, 2), /Step/)
  assert.deepEqual(checkStageCard({ x: 0, z: 4 }, 3), { title: CHECK_RETURN_TITLE, copy: checkStageCopy(4, 3), status: CHECK_STATUS })
  // What the fit compares is the shape the points make. It does not say where the points are or which way they face: a shift or
  // a turn of all three together is the one thing the fit cannot see (the readout names it), and the step must not promise it.
  for (const text of [checkStageCopy(null), checkStageCopy(null, 3), checkStageCopy(4.2), checkStageCopy(4.2, 3)]) {
    assert.doesNotMatch(text, /where the points are|which way they face|line up|aligned?\b|verified|same spot/i, text)
  }
})

test('on a return visit the step asks for last time\'s check point and how far it was, and says what it compares', () => {
  assert.equal(CHECK_RETURN_TITLE, 'Tap the check point from last time')
  assert.equal(
    checkStageCopy(4.2),
    'Tap point C, the check point from last time, about 4.2 m from the landmark. ' +
      'It lets this visit compare the shape the three points make, not only the distance between two.',
  )
  // The stored point is in the Place frame, whose origin is the landmark: its distance is its length.
  assert.deepEqual(checkStageCard({ x: -2.4, z: 3.2 }), { title: CHECK_RETURN_TITLE, copy: checkStageCopy(4), status: CHECK_STATUS })
  assert.equal(CHECK_SKIPPED_RETURN, 'Skipped. Only the distance between the two points will be checked.')
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(checkStageCopy(bad), checkStageCopy(null), `a stored distance of ${String(bad)} is not a distance to name`)
  }
})

test('the distances the step asks for are the guidance\'s constants, so the words and the line beside them cannot differ', () => {
  const source = readFileSync(join(ROOT, 'src/ar/constellation-copy.ts'), 'utf8')
  assert.match(source, /RECOMMENDED_CHECK_DISTANCE_M, RECOMMENDED_CHECK_OFFSET_M, stepPrefix \} from '\.\.\/world\/baseline-guidance\.ts'/)
  assert.doesNotMatch(checkStageCopy(null), /\b(1|2\.5|4) m\b/)
})

test('the review step\'s instruction is what it always was for two markers, and counts three when there is a check point', () => {
  assert.equal(REVIEW_COPY, 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.')
  assert.equal(REVIEW_COPY_WITH_CHECK, 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.')
  assert.equal(reviewCopy(false), REVIEW_COPY)
  assert.equal(reviewCopy(true), REVIEW_COPY_WITH_CHECK)
  assert.equal(CHECK_BLOCKED_STATUS, 'The check point cannot be used where it is. Move it or remove it.')
  // While the markers placed so far do not match the stored ones, the card is not "ready to commit": committing would turn them back.
  assert.equal(REVIEW_MISMATCH_STATUS, 'These points do not match the stored ones yet.')
})

test('the markers are named the same way everywhere: a selection message and a label caption (the photo titles are in tests/unit/deno/reference_photos.test.ts)', () => {
  assert.deepEqual((['landmark', 'heading', 'check'] as const).map(markerName), ['Landmark', 'Heading marker', 'Check point'])
  assert.deepEqual(
    (['landmark', 'heading', 'check'] as const).map(labelCaption),
    ['Name point A (optional)', 'Name point B (optional)', 'Name point C (optional)'],
  )
})

test('the reference panel\'s notes for the two markers are word for word what they were, and a check point does not claim the Place predates photos', () => {
  const predates = 'This Place was aligned before reference photos existed, so there is nothing to match against. Place this marker on the same physical feature as last time.'
  const described = 'No photo was saved for this point — go by the description above.'
  assert.equal(noPhotoNote('landmark', false), predates)
  assert.equal(noPhotoNote('heading', false), predates)
  assert.equal(noPhotoNote('landmark', true), described)
  assert.equal(noPhotoNote('heading', true), described)
  assert.equal(noPhotoNote('check', true), described)
  assert.equal(noPhotoNote('check', false), 'No photo was saved for this point. Place it on the same physical feature as last time.')
  assert.doesNotMatch(noPhotoNote('check', false), /before reference photos existed/)
})

// ── The readout ──────────────────────────────────────────────────────────────────────────────────────

const L = { x: 0, y: 0, z: 0 }
const H = { x: 0, y: 0, z: 3.5 }
const C = { x: -2.6, y: 0, z: 1 }
const outcome = (moved: { x: number; z: number } = { x: 0, z: 0 }) => {
  const fit = fitRigid2D([L, H, { ...C, x: C.x + moved.x, z: C.z + moved.z }], [L, H, C])
  assert.ok(fit.ok)
  return { fit: fit.fit, verdict: verifyFit(fit, { sigmaHatM: 0.03 }) }
}

test('the points one by one, in cm to a tenth, lettered as the card letters them', () => {
  const { fit } = outcome({ x: 0.02, z: 0.01 })
  assert.equal(perPointLine(fit), `A ${(fit.perPoint[0]!.residualM * 100).toFixed(1)} cm · B ${(fit.perPoint[1]!.residualM * 100).toFixed(1)} cm · C ${(fit.perPoint[2]!.residualM * 100).toFixed(1)} cm`)
  assert.equal(perPointLine({ perPoint: [{ residualM: 0.021 }, { residualM: 0.0345 }, { residualM: 1.234 }] }), 'A 2.1 cm · B 3.5 cm · C 123 cm')
  assert.equal(perPointLine(null), '')
  assert.equal(perPointLine(undefined), '')
})

test('a fit within the limits reads: the verdict\'s first sentence, the points, and the limit every comparison of taps has', () => {
  const { fit, verdict } = outcome({ x: 0.01, z: 0.02 })
  assert.equal(verdict.status, 'verified')
  const readout = fitReadout(verdict, fit)!
  assert.equal(readout.state, 'ok')
  assert.deepEqual(readout.text.split('\n'), [verdict.reasons[0], perPointLine(fit), NOT_CHECKED_SPOTS])
  assert.match(readout.text, /^3 points are \d+\.\d cm off the stored ones on average \(limit 8\.4 cm\)\./)
})

test('on a phone whose units are not metres the readout ends with the verdict\'s own sentence that sizes in metres were not checked', () => {
  const stored = [L, H, C]
  const fit = fitRigid2D(stored, stored)
  assert.ok(fit.ok)
  const sentences = {
    arbitrary: "Not checked: sizes in metres. This phone's units are not metres.",
    'estimated-metric': 'Not checked: sizes in metres. The phone estimates them.',
  } as const
  for (const [unitsMode, sentence] of Object.entries(sentences) as Array<[keyof typeof sentences, string]>) {
    const verdict = verifyFit(fit, { sigmaHatM: 0.03, unitsMode })
    assert.ok(verdict.reasons.includes(sentence), 'the verdict says it')
    const readout: Readout = fitReadout(verdict, fit.fit)!
    assert.deepEqual(readout.text.split('\n').slice(-2), [NOT_CHECKED_SPOTS, sentence], unitsMode)
    assert.equal(readout.state, 'ok', 'a limit is not a reason to withhold: the status is the verdict\'s')
  }
  for (const unitsMode of ['metric', undefined] as const) {
    const readout: Readout = fitReadout(verifyFit(fit, { sigmaHatM: 0.03, unitsMode }), fit.fit)!
    assert.ok(!/sizes in metres/.test(readout.text), `${unitsMode}: nothing is said of a unit that is metres or not known`)
    assert.equal(readout.text.split('\n').at(-1), NOT_CHECKED_SPOTS)
  }
})

test('a check that passed but could not be relied on says why, in the verdict\'s own sentences', () => {
  // A check point tapped 30 cm high: the positions agree and the heights do not.
  const tapped = [L, H, { ...C, y: 0.3 }]
  const fit = fitRigid2D(tapped, [L, H, C])
  const verdict = verifyFit(fit, { sigmaHatM: 0.03 })
  assert.ok(fit.ok && verdict.status === 'provisional' && verdict.withheld && verdict.withheld.length > 0)
  const readout = fitReadout(verdict, fit.fit)!
  assert.equal(readout.state, 'warn')
  const lines = readout.text.split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines[2], `Not verified: ${verdict.withheld.join(' ')}`)
  assert.match(lines[2]!, /^Not verified: Heights are \d+\.\d cm off on average \(limit 8\.4 cm\)\.$/)
  assert.equal(lines[3], NOT_CHECKED_SPOTS)
})

test('a mismatch lists every sentence the verdict gave, then the points one by one, and no "not checked" line', () => {
  const { fit, verdict } = outcome({ x: 0, z: 1 })
  assert.equal(verdict.status, 'mismatch')
  const readout = fitReadout(verdict, fit)!
  assert.equal(readout.state, 'mismatch')
  assert.deepEqual(readout.text.split('\n'), [...verdict.reasons, perPointLine(fit)])
  assert.ok(!readout.text.includes(NOT_CHECKED_SPOTS))
})

test('a mismatch with no fit to its points (a mirrored visit) is just the verdict\'s sentences', () => {
  const mirrored = fitRigid2D([L, H, { x: 2.6, y: 0, z: 1 }], [L, H, C])
  assert.ok(!mirrored.ok)
  const verdict = verifyFit(mirrored, { sigmaHatM: 0.03 })
  assert.equal(verdict.status, 'mismatch')
  assert.equal(fitReadout(verdict, null)!.text, verdict.reasons.join('\n'))
})

test('a mismatch lists at most six reasons: the card is not a report', () => {
  const many = { status: 'mismatch' as const, reasons: ['1', '2', '3', '4', '5', '6', '7', '8'] }
  assert.deepEqual(fitReadout(many, { perPoint: [{ residualM: 0.5 }] })!.text.split('\n'), ['1', '2', '3', '4', '5', '6', 'A 50.0 cm'])
})

test('there is no readout without a verdict to read', () => {
  assert.equal(fitReadout(null, null), null)
  assert.equal(fitReadout(undefined, undefined), null)
  assert.equal(fitReadout({ status: 'verified', reasons: [] }, null), null)
})

test('a check point that could not be compared says why, and what is compared instead', () => {
  const reason = 'The stored points lie almost on one line, so which side of it the points are on cannot be checked.'
  assert.deepEqual(uncomparedReadout(reason), {
    text: `${reason}\nOnly the distance between the two points is compared.`,
    state: 'warn',
  })
})

test('a comparison of distance is never worded as a fit, and the copy about a pair is the verdict\'s', () => {
  const verdict = verifyTwoPoint({ separationM: 3.05, storedSeparationM: 3, sigmaHatM: 0.03 })
  assert.equal(verdict.status, 'provisional')
  assert.ok(verdict.reasons.includes('Direction was not checked: a third point is needed.'))
})

// ── The mismatch screen ──────────────────────────────────────────────────────────────────────────────

test('the mismatch screen for points, in full: its title, its sentence, and the way back to the markers', () => {
  assert.equal(MISMATCH_TITLE_POINTS, 'These points do not match the stored ones')
  assert.equal(MISMATCH_COPY_POINTS, 'They do not line up with the stored points. Adjust a point, re-place them, or record these points as unverified.')
  assert.equal(ADJUST_POINT_LABEL, 'Adjust a point')
  assert.equal(WRONG_PLACE_LABEL, 'Wrong Place? Choose another')
})

test('nothing the flow adds says verified, aligned or accurate, or a number the code did not measure', () => {
  const sentences = [
    CHECK_STEP_LABEL, CHECK_STAGE_TITLE, CHECK_RETURN_TITLE, checkStageCopy(null), checkStageCopy(4.2), checkStageCopy(null, 3), checkStageCopy(4.2, 3), CHECK_STATUS, CHECK_SKIPPED_RETURN, REVIEW_MISMATCH_STATUS,
    SKIP_CHECK_LABEL, ADD_CHECK_LABEL, REMOVE_CHECK_LABEL, REVIEW_COPY_WITH_CHECK, CHECK_BLOCKED_STATUS,
    MISMATCH_TITLE_POINTS, MISMATCH_COPY_POINTS, ADJUST_POINT_LABEL, WRONG_PLACE_LABEL,
    noPhotoNote('check', false), labelCaption('check'), markerName('check'),
  ]
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence, /\bverified\b|\baligned\b|accurate|guarantee|exactly|NaN|undefined/i, sentence)
  }
  // The one place the word is used, the review step's "unverified", says the points are not.
  assert.match(MISMATCH_COPY_POINTS, /\bunverified\b/)
})
