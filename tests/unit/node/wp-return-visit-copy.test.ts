/**
 * What the calibration card says on a return visit (WP-07): the two steps' copy, the distance chip, the status line that
 * must not contradict it, and the sentence the commit holds on when a photo is missing. src/ar/return-visit-copy.ts.
 *
 * The chip is the one claim here that must not drift from something else. Its "pass" and "fail" are the commit's own
 * verdict shown early (`assessTwoPoint`, src/ar/calibration-commit.ts), and a chip that said pass for a pair the commit
 * then turned away to the mismatch screen would be the card contradicting itself. So it is held to `assessTwoPoint` over
 * a sweep of separations, tap noises and stored lengths, the boundary included, and is not checked against a second copy
 * of the rule written in this file. The tolerance it judges by is the commit's (`twoPointToleranceM` at the tap noise the
 * commit uses), handed in by the caller: the commit does not read the stored record's own `toleranceM`, so neither may the
 * chip, and the sweep gives the record every tolerance there is to show that neither does.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-return-visit-copy.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessTwoPoint, resolveCommitOptions, type TwoPointFrame } from '../../../src/ar/calibration-commit.ts'
import {
  COMPARE_HEAD,
  NOT_STORED_DISTANCE_STATUS,
  WRONG_PLACE_LABEL,
  compareNote,
  distanceChip,
  photoHoldText,
  returnHeadingCopy,
  returnLandmarkCopy,
  returnVisitOf,
} from '../../../src/ar/return-visit-copy.ts'
import { twoPointToleranceM } from '../../../src/world/frame-fit.ts'
import { MIN_POINT_SEPARATION_M } from '../../../src/world/geo.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const frame = (separationM: number, toleranceM?: number | null): TwoPointFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: separationM },
  separationM,
  ...(toleranceM === undefined ? {} : { toleranceM: toleranceM as number }),
  anchorBearingDeg: null,
}) as TwoPointFrame

/**
 * The spacing tolerance the commit applies at the tap noise it uses by default (16.8 cm at the adopted 3 cm). The cases below that
 * print an allowance are written for this number, so they say what the person is told on the card; the sentences that only
 * show how an allowance is printed name a round 15 cm of their own (`visitOf`).
 */
const COMMIT_TOLERANCE_M = twoPointToleranceM(resolveCommitOptions({ hitTest: async () => null }).sigmaHatM)
assert.ok(Math.abs(COMMIT_TOLERANCE_M - 0.168) < 1e-12, 'the cases written for the commit\'s tolerance below are for 16.8 cm: move them with it')

/** A stored pair `separationM` long, seen with an allowance of `toleranceM` named by the caller, as the modal names it. */
const visitOf = (separationM: number, toleranceM: number) => returnVisitOf(frame(separationM), toleranceM)!

// ── The stored pair as a return visit sees it ─────────────────────────────────────────────────────

test('no two-point frame is not a return visit', () => {
  assert.equal(returnVisitOf(null), null)
  assert.equal(returnVisitOf(undefined), null)
})

test('a stored pair carries its length, and the tolerance the commit applies: the number the caller names, never the record\'s own', () => {
  assert.deepEqual(returnVisitOf(frame(3.2, 0.25), COMMIT_TOLERANCE_M), { separationM: 3.2, toleranceM: COMMIT_TOLERANCE_M })
  assert.deepEqual(returnVisitOf(frame(3.2), 0.4), { separationM: 3.2, toleranceM: 0.4 })
  // A caller that names none gets what a commit at the adopted tap noise applies (`assessTwoPoint` no longer reads the record's tolerance).
  for (const recorded of [undefined, null, 0.15, 0.25, Number.NaN, -1]) {
    assert.deepEqual(returnVisitOf(frame(3.2, recorded)), { separationM: 3.2, toleranceM: COMMIT_TOLERANCE_M }, `record ${recorded}`)
    assert.deepEqual(returnVisitOf(frame(3.2, recorded), null), { separationM: 3.2, toleranceM: COMMIT_TOLERANCE_M }, `record ${recorded}, none named`)
  }
})

test('a stored length that is not a length is no length: nothing is quoted', () => {
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(returnVisitOf(frame(bad))?.separationM, null, String(bad))
  }
})

// ── The steps ─────────────────────────────────────────────────────────────────────────────────────

test('Point A is asked for again, the same spot as the photo only while the photo is on screen', () => {
  assert.equal(returnLandmarkCopy(true), "Step 1 of 2 — tap Point A again, the same spot as the photo. Point A is the project's origin.")
  assert.equal(returnLandmarkCopy(false), "Step 1 of 2 — tap Point A again, the same spot as last time. Point A is the project's origin.")
})

test('Point B is asked for again, with how far it was from A and what is allowed, to the centimetre', () => {
  const visit = visitOf(3.2, 0.15)
  assert.equal(
    returnHeadingCopy(visit, true),
    'Step 2 of 2 — tap Point B again, the same spot as the photo. Point B was 3.20 m from A (allowed ±0.15 m).',
  )
  assert.equal(
    returnHeadingCopy(visit, false),
    'Step 2 of 2 — tap Point B again, the same spot as last time. Point B was 3.20 m from A (allowed ±0.15 m).',
  )
  assert.match(returnHeadingCopy(returnVisitOf(frame(1.5))!, false), /Point B was 1\.50 m from A/)
  // The allowance quoted is the commit's, as the modal passes it: 16.8 cm is 0.17 m.
  assert.equal(
    returnHeadingCopy(returnVisitOf(frame(3.2, 0.15), COMMIT_TOLERANCE_M)!, false),
    'Step 2 of 2 — tap Point B again, the same spot as last time. Point B was 3.20 m from A (allowed ±0.17 m).',
    'the record\'s 15 cm is not what is quoted',
  )
})

test('the steps count to the taps the visit asks for: "of 3" where a check point follows the heading marker, "of 2" where it does not', () => {
  const visit = visitOf(3.2, 0.15)
  assert.equal(returnLandmarkCopy(false, 3), "Step 1 of 3 — tap Point A again, the same spot as last time. Point A is the project's origin.")
  assert.equal(returnLandmarkCopy(true, 3), "Step 1 of 3 — tap Point A again, the same spot as the photo. Point A is the project's origin.")
  assert.equal(
    returnHeadingCopy(visit, true, true, 3),
    'Step 2 of 3 — tap Point B again, the same spot as the photo. Point B was 3.20 m from A (allowed ±0.15 m). The ring on the floor marks that distance.',
  )
  assert.equal(returnHeadingCopy(returnVisitOf(frame(Number.NaN))!, false, false, 3), 'Step 2 of 3 — tap Point B again, the same spot as last time.')
  // No count is a visit that takes no check point: two, as the card said before it had a third step.
  assert.equal(returnLandmarkCopy(true), returnLandmarkCopy(true, 2))
  assert.equal(returnHeadingCopy(visit, false), returnHeadingCopy(visit, false, false, 2))
})

test('Point B\'s step points at the ring only when the ring is drawn, and says what it marks', () => {
  const visit = visitOf(3.2, 0.15)
  assert.equal(
    returnHeadingCopy(visit, true, true),
    'Step 2 of 2 — tap Point B again, the same spot as the photo. Point B was 3.20 m from A (allowed ±0.15 m). The ring on the floor marks that distance.',
  )
  assert.equal(returnHeadingCopy(visit, true, false), returnHeadingCopy(visit, true), 'no ring: no sentence about it')
  assert.doesNotMatch(returnHeadingCopy(visit, true), /ring/)
  // With no stored length there is no distance for a ring to mark: the step names the spot and stops.
  assert.doesNotMatch(returnHeadingCopy(returnVisitOf(frame(Number.NaN))!, false, true), /ring/)
})

test('without a stored length the step names the spot and quotes no number; a tolerance that is not a figure is not quoted', () => {
  assert.equal(
    returnHeadingCopy(returnVisitOf(frame(Number.NaN))!, false),
    'Step 2 of 2 — tap Point B again, the same spot as last time.',
  )
  const copy = returnHeadingCopy({ separationM: 3, toleranceM: Number.NaN }, false)
  assert.equal(copy, 'Step 2 of 2 — tap Point B again, the same spot as last time. Point B was 3.00 m from A.')
  assert.doesNotMatch(copy, /NaN|allowed/)
})

test('a return visit is never told to walk: a longer pair is a mismatch with the stored one', () => {
  for (const text of [returnLandmarkCopy(false), returnHeadingCopy(returnVisitOf(frame(3))!, true)]) {
    assert.doesNotMatch(text, /walk|permanent feature|recognise next visit/i, text)
  }
})

// ── The chip ──────────────────────────────────────────────────────────────────────────────────────

test('inside the tolerance the chip passes, says how far off, and says direction is not checked', () => {
  const visit = visitOf(3.2, 0.15)
  assert.deepEqual(distanceChip(visit, 3.25), { state: 'pass', text: '✓ About as far apart as stored: 5\u00A0cm off. Direction is not checked.' })
  assert.deepEqual(distanceChip(visit, 3.2), { state: 'pass', text: '✓ About as far apart as stored: 0\u00A0cm off. Direction is not checked.' })
})

test('outside it the chip fails, names the direction and the amount, and says what was allowed', () => {
  const visit = visitOf(3.2, 0.15)
  assert.deepEqual(distanceChip(visit, 3.6), { state: 'fail', text: '⚠ 40\u00A0cm further apart than stored. Allowed: ±15\u00A0cm.' })
  assert.deepEqual(distanceChip(visit, 2.9), { state: 'fail', text: '⚠ 30\u00A0cm closer together than stored. Allowed: ±15\u00A0cm.' })
})

test('a gap that rounds to the allowance says it is just over, and never prints a gap equal to the allowance it failed', () => {
  const visit = visitOf(3.2, 0.15)
  // 3.2 m stored, 15 cm allowed: from 3.35 m (exactly 15 cm over, a pass) the chip fails above it, and prints whole centimetres.
  for (const separation of [3.3504, 3.351, 3.3549, 3.0496, 3.0451]) {
    const chip = distanceChip(visit, separation)!
    assert.equal(chip.state, 'fail', String(separation))
    assert.match(chip.text, /^⚠ (Further apart|Closer together) than stored by just over the allowed ±15\u00A0cm\.$/, `${separation}: ${chip.text}`)
    assert.doesNotMatch(chip.text, /\d+[ \u00A0]cm (further|closer)/, 'no gap is printed that reads as inside the allowance')
  }
  assert.equal(distanceChip(visit, 3.3504)!.text, '⚠ Further apart than stored by just over the allowed ±15\u00A0cm.')
  assert.equal(distanceChip(visit, 3.0496)!.text, '⚠ Closer together than stored by just over the allowed ±15\u00A0cm.')
  // Once the gap rounds to more than the allowance it is printed, beside the allowance.
  assert.equal(distanceChip(visit, 3.3560)!.text, '⚠ 16\u00A0cm further apart than stored. Allowed: ±15\u00A0cm.')
  // A pass at the same edge is a pass: it prints no allowance for the figure to contradict.
  assert.equal(distanceChip(visit, 3.3496)!.text, '✓ About as far apart as stored: 15\u00A0cm off. Direction is not checked.')
})

test('the same words at the allowance the commit applies (16.8 cm, which reads 17): every gap the chip calls just over, or prints, fails in the commit too', () => {
  const options = resolveCommitOptions({ hitTest: async () => null })
  const visit = visitOf(3.2, twoPointToleranceM(options.sigmaHatM))
  const commits = (separation: number) =>
    assessTwoPoint({ landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: separation, y: 0, z: 0 }, stored: frame(3.2), override: false }, options).kind
  // Further apart: a gap a few millimetres over 16.8 cm rounds to 17, the allowance as printed, and is called just over.
  for (const over of [0.0004, 0.001, 0.0069]) {
    const separation = 3.2 + COMMIT_TOLERANCE_M + over
    assert.equal(distanceChip(visit, separation)!.text, '⚠ Further apart than stored by just over the allowed ±17\u00A0cm.', String(over))
    assert.equal(commits(separation), 'mismatch', `${over} over: the commit fails it too`)
  }
  // Closer together, the same.
  for (const over of [0.0004, 0.001, 0.0069]) {
    const separation = 3.2 - COMMIT_TOLERANCE_M - over
    assert.equal(distanceChip(visit, separation)!.text, '⚠ Closer together than stored by just over the allowed ±17\u00A0cm.', String(over))
    assert.equal(commits(separation), 'mismatch', `${over} over, closer: the commit fails it too`)
  }
  // Once the gap rounds to more than the allowance it is printed beside it, and the commit fails that too.
  assert.equal(distanceChip(visit, 3.2 + COMMIT_TOLERANCE_M + 0.0081)!.text, '⚠ 18\u00A0cm further apart than stored. Allowed: ±17\u00A0cm.')
  assert.equal(commits(3.2 + COMMIT_TOLERANCE_M + 0.0081), 'mismatch')
  // Inside it is a pass, and the commit accepts: the 15 cm the record says is not the limit (it is not read), 16 cm off is fine.
  for (const separation of [3.2 + 0.16, 3.2 - 0.16, 3.2 + COMMIT_TOLERANCE_M - 0.0004]) {
    assert.equal(distanceChip(visit, separation)!.state, 'pass', String(separation))
    assert.equal(commits(separation), 'accepted', `${separation}: the commit accepts it`)
  }
})

test('a figure is never parted from its unit by a line break: every "cm" the chip prints follows a no-break space', () => {
  const visit = visitOf(3.2, 0.15)
  for (const separation of [3.2, 3.25, 3.6, 2.9, 3.3504, 3.3560, 3.0496]) {
    const { text } = distanceChip(visit, separation)!
    assert.ok(/\d\u00A0cm/.test(text), text)
    assert.doesNotMatch(text, /\d cm/, `${text}: an ordinary space before cm may break the line there`)
  }
})

test('a tolerance that is no allowance is not printed as one: a number that is not a number passes everything, and a negative one fails and says no limit', () => {
  assert.equal(distanceChip({ separationM: 3.2, toleranceM: Number.NaN }, 9)!.state, 'pass')
  const negative = distanceChip({ separationM: 3.2, toleranceM: -1 }, 3.2)!
  assert.equal(negative.state, 'fail')
  assert.doesNotMatch(negative.text, /Allowed|just over|±/, negative.text)
})

test('the commit cannot be given a tolerance that is no allowance: it reads none from the record, and its own is a positive number at any tap noise', () => {
  const options = resolveCommitOptions({ hitTest: async () => null })
  const commits = (stored: TwoPointFrame, separation: number) =>
    assessTwoPoint({ landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: separation, y: 0, z: 0 }, stored, override: false }, options)
  // A record that says the tolerance is -1, or not a number, or 0, neither fails the stored distance itself nor changes the commit's own.
  for (const recorded of [-1, Number.NaN, 0]) {
    const same = commits(frame(3.2, recorded), 3.2)
    assert.equal(same.kind, 'accepted', `the stored distance again, record ${recorded}`)
    if (same.kind === 'accepted') assert.equal(same.toleranceM, COMMIT_TOLERANCE_M)
  }
  // And a generous record does not widen it: 25 cm off is a mismatch whatever the record allows.
  assert.equal(commits(frame(3.2, 0.4), 3.45).kind, 'mismatch')
  for (const noise of [undefined, Number.NaN, 0, -1, 0.001, 0.03, 0.2, Number.POSITIVE_INFINITY]) {
    const tolerance = twoPointToleranceM(resolveCommitOptions({ hitTest: async () => null, sigmaHatM: noise }).sigmaHatM)
    assert.ok(Number.isFinite(tolerance) && tolerance > 0, `noise ${noise}: ${tolerance}`)
  }
})

test('while the chip fails the status line says so too: it never says "Ready to commit." under a warning', () => {
  assert.equal(NOT_STORED_DISTANCE_STATUS, 'Not the stored distance yet.')
  assert.doesNotMatch(NOT_STORED_DISTANCE_STATUS, /ready|commit|verified|aligned/i)
})

test('the chip never claims more than the distance: a pass is not called verified, aligned, the same place or the same pair', () => {
  const pass = distanceChip(returnVisitOf(frame(3.2), COMMIT_TOLERANCE_M)!, 3.2)!
  assert.match(pass.text, /Direction is not checked/)
  assert.doesNotMatch(pass.text, /verified|aligned|same place|same spot|same pair|matches the/i)
})

test('there is no chip with nothing to compare: no stored length, no separation yet, or a pair under the minimum', () => {
  const visit = returnVisitOf(frame(3.2))!
  assert.equal(distanceChip(returnVisitOf(frame(Number.NaN))!, 3.2), null)
  assert.equal(distanceChip(visit, null), null)
  assert.equal(distanceChip(visit, Number.NaN), null)
  // The separation line above the chip already says "need at least 1.0 m" for these.
  assert.equal(distanceChip(returnVisitOf(frame(1.2))!, MIN_POINT_SEPARATION_M - 0.001), null)
  assert.notEqual(distanceChip(returnVisitOf(frame(1.2))!, MIN_POINT_SEPARATION_M), null, 'the minimum itself is inside')
})

test('the chip says pass exactly when the commit would accept, and fail exactly when it would send the pair to the mismatch screen', () => {
  // The commit's tolerance is `twoPointToleranceM` of the tap noise it uses: the adopted 3 cm is its floor, 10 cm its cap, and a
  // noise that is not a positive number is the adopted one. The modal passes the chip that number, from the commit's own options.
  const noises: Array<number | undefined> = [undefined, 0.01, 0.03, 0.05, 0.08, 0.1, 0.2, Number.NaN, 0, -1]
  // What the stored record says its tolerance is: neither the commit nor the chip reads it, so every value gives the same answer.
  const recorded: Array<number | null | undefined> = [undefined, null, 0, 0.15, 0.4, Number.NaN, -1]
  const storedLengths = [1, 1.5, 3, 3.2, 5.25, 12]
  const fixed = [1, 1.0000001, 1.4, 2.0, 2.9, 2.95, 3.0, 3.05, 3.2, 3.35, 3.6, 4.5, 8.1, 20]
  let checked = 0
  let fails = 0
  for (const noise of noises) {
    const options = resolveCommitOptions({ hitTest: async () => null, sigmaHatM: noise })
    const tolerance = twoPointToleranceM(options.sigmaHatM)
    for (const stored of storedLengths) {
      // The edges of this tolerance, on both sides of the stored length: exactly at it, and a hair either way.
      const edges = [stored + tolerance, stored + tolerance + 1e-9, stored + tolerance - 1e-9, stored - tolerance, stored - tolerance - 1e-9, stored - tolerance + 1e-9]
      // Under the minimum there is no chip (the test above holds that), and the commit refuses the pair as too close, which is not a mismatch.
      for (const separation of [...fixed, ...edges].filter((each) => each >= MIN_POINT_SEPARATION_M)) {
        for (const recordedTolerance of recorded) {
          const storedFrame = frame(stored, recordedTolerance)
          const verdict = assessTwoPoint(
            { landmark: { x: 0, y: 0, z: 0 }, headingMarker: { x: separation, y: 0, z: 0 }, stored: storedFrame, override: false },
            options,
          )
          const chip = distanceChip(returnVisitOf(storedFrame, tolerance)!, separation)
          assert.ok(chip, `a chip for ${separation} against ${stored} (tap noise ${noise}, record ${recordedTolerance})`)
          assert.equal(
            chip.state === 'fail',
            verdict.kind === 'mismatch',
            `${separation} m against a stored ${stored} m, tap noise ${noise}, record ${recordedTolerance}: the commit says ${verdict.kind}, the chip says ${chip.state}`,
          )
          checked++
          if (chip.state === 'fail') fails++
        }
      }
    }
  }
  assert.ok(checked > 3000 && fails > 500 && fails < checked - 500, `the sweep reaches both answers: ${fails} fails in ${checked}`)
})

test('the boundary is strict, as the commit\'s is (the sweep above holds the two together): a residual exactly the tolerance passes, one hair more fails (binary-exact numbers)', () => {
  const visit = { separationM: 2, toleranceM: 0.25 }
  assert.equal(distanceChip(visit, 2.25)!.state, 'pass')
  assert.equal(distanceChip(visit, 2.2500001)!.state, 'fail')
  assert.equal(distanceChip(visit, 1.75)!.state, 'pass')
  assert.equal(distanceChip(visit, 1.7499999)!.state, 'fail')
})

// ── The photo hold ────────────────────────────────────────────────────────────────────────────────

test('a point that is not in the camera view is named, with what to do and what happens if it stays out', () => {
  assert.equal(
    photoHoldText([{ role: 'headingMarker', kind: 'out-of-view' }], 'Use this alignment'),
    'Point B is not in the camera view. Aim at it, then press Use this alignment again. If a photo is still missing, the alignment is saved without reference photos.',
  )
  assert.equal(
    photoHoldText([{ role: 'landmark', kind: 'out-of-view' }, { role: 'headingMarker', kind: 'out-of-view' }], 'Use this alignment'),
    'Points A and B are not in the camera view. Aim at them, then press Use this alignment again. If a photo is still missing, the alignment is saved without reference photos.',
  )
})

test('a camera that gave no frame is said, separately, and is told to try once more', () => {
  assert.equal(
    photoHoldText([{ role: 'landmark', kind: 'failed' }], 'Use this alignment'),
    'The camera gave no photo of Point A. Press Use this alignment again to try once more. If a photo is still missing, the alignment is saved without reference photos.',
  )
  const mixed = photoHoldText([{ role: 'landmark', kind: 'out-of-view' }, { role: 'headingMarker', kind: 'failed' }], 'Use this alignment')
  assert.match(mixed, /^Point A is not in the camera view\. Aim at it, then press Use this alignment again\. The camera gave no photo of Point B\./)
})

test('the hold tells the person to press the button they pressed, by the name the card gives it, and never writes a name of its own', () => {
  // Review's commit is "Use this alignment"; the mismatch screen's is "Use anyway", and "Use this alignment" is not on that card.
  for (const label of ['Use this alignment', 'Use anyway', "Replace this Place's reference"]) {
    const out = photoHoldText([{ role: 'headingMarker', kind: 'out-of-view' }], label)
    assert.ok(out.includes(`then press ${label} again.`), `${label}: ${out}`)
    assert.equal(out.includes('Use this alignment'), label === 'Use this alignment', `${label}: no other button's name in the sentence`)
    const failed = photoHoldText([{ role: 'headingMarker', kind: 'failed' }], label)
    assert.ok(failed.includes(`Press ${label} again to try once more.`), `${label}: ${failed}`)
  }
  // Space round the name on the card is not part of it.
  assert.match(photoHoldText([{ role: 'landmark', kind: 'failed' }], '  Use anyway \n'), /Press Use anyway again to try once more\./)
})

test('with no name for the button the hold says "the same button", which is true of whichever was pressed', () => {
  for (const none of [undefined, null, '', '   ']) {
    const out = photoHoldText([{ role: 'landmark', kind: 'out-of-view' }, { role: 'headingMarker', kind: 'failed' }], none)
    assert.match(out, /then press the same button again\./)
    assert.match(out, /Press the same button again to try once more\./)
    assert.doesNotMatch(out, /Use this alignment|Use anyway/)
  }
})

// ── The rest of the card's words ──────────────────────────────────────────────────────────────────

test('the way out of the mismatch screen and the photo panel say what they are', () => {
  assert.equal(WRONG_PLACE_LABEL, 'Wrong Place? Choose another')
  assert.equal(COMPARE_HEAD, 'Last time')
  assert.equal(compareNote('none', false), 'No photo saved')
  assert.equal(compareNote('loading', true), 'Loading…')
  assert.equal(compareNote('failed', true), 'Photo could not be loaded')
  assert.equal(compareNote('failed', false), 'Photo never finished uploading')
})

test('the card carries the wrong-place button under the label this file names', () => {
  const source = readFileSync(join(root, 'src/ar/project-calibration.ts'), 'utf8')
  assert.match(source, /<button id="project-calibration-wrong-place" type="button" class="project-calibration-link" hidden>\$\{WRONG_PLACE_LABEL\}<\/button>/)
})
