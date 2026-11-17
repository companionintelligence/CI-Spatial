/**
 * What the scanner says when the Place calibration finishes, and whether anyone gets to read it.
 *
 * Five defects, in the lines of src/main.ts that follow `runProjectCalibration()` and in the copy they print:
 *
 *  1. The outcome (the two-point result, the single-point warning, the no-alignment warning) was written
 *     at the default 'normal' priority, and the line after it wrote "Move the camera to start tracking…"
 *     in the same synchronous run. A normal write replaces whatever is there, so the outcome was gone
 *     before the browser painted once. The status line (src/ui/status-line.ts) already holds the cure:
 *     a 'sticky' write owns the line for STATUS_HOLD_MS, and a later normal write is dropped while it holds.
 *  2. The two-point copy said "Alignment verified" for a check that compares ONE number: the distance
 *     between the two points tapped now and the distance between the Place's stored pair
 *     (`commitTwoPoint`'s `residualM` in src/ar/project-calibration.ts). Nothing compares direction, so
 *     the right pair tapped in the other order, or a different pair at the same spacing, passes as well.
 *     The copy now says what was matched, by how much, and that direction was not checked.
 *  3. The reworded headline, "Distance matches the stored pair", could still be read as the tapped points
 *     landing within some distance of the stored points. What is compared is the SPACING between the two
 *     tapped points and the stored spacing, so the headline now says the points are as far apart as stored.
 *  4. A mismatch the person chose to keep ("Use anyway") got the neutral first-calibration line. The check
 *     ran and failed, and `commitTwoPoint` then REPLACES the Place's stored frame with the new pair (main.ts
 *     persists `spatialFrame`) while earlier scans keep their calibration against the old pair. That result is
 *     'provisional' with |residualM| > toleranceM, and it now says so: the gap, that it was kept as chosen,
 *     and that earlier scans may not line up.
 *  5. A 'verified' result whose residual is not a finite number printed "NaN cm off". No figure is printed
 *     that does not exist.
 *
 * A compass heading check is NOT the fix and must not be added here. docs/audits/2026-11-13-goal-readiness.md
 * (W4-5, F53) parks it on purpose: the compass handedness is unsettled and a sign error would mirror east
 * and west, the stored `anchorBearingDeg` is the session +Z bearing and not the pair's, and the tolerance
 * needs a device run.
 *
 * What runs for real and what is read as text:
 *  - The copy is a pure function and is run. So is the hold: the real `writeStatus` is driven on a fake
 *    node, which is all it touches.
 *  - main.ts is one DOM module and cannot be imported under node, so its wiring is read as source, the way
 *    wp-b-scanner-flow.test.ts reads it. Those tests are named "source shape:" and claim no behaviour. That
 *    the line then paints on a phone is for a device or the browser specs, not for this file.
 *
 * The copy module is loaded inside each test that needs it, not at the top of the file, so that a missing
 * module fails exactly those tests and the "source shape:" tests still report on main.ts by themselves.
 *
 * Run: npm run test:alignment-status
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statusIsHeld, writeStatus, type StatusNode } from '../../../src/ui/status-line.ts'
import { NOT_CHECKED_METRES, NOT_CHECKED_SPOTS, twoPointToleranceM } from '../../../src/world/frame-fit.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const alignmentStatusText = async () => (await import('../../../src/ar/alignment-status.ts')).alignmentStatusText

/** What main.ts writes on the line after the outcome, at the default priority. */
const TRACKING_PROMPT = 'Move the camera to start tracking…'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const CALIBRATED_AT = '2026-11-16T09:00:00.000Z'

/**
 * A committed two-point calibration, in the shape `commitTwoPoint` returns. `toleranceM` is the stored frame's own
 * (0.15 m, `DEFAULT_SEPARATION_TOLERANCE_M`, unless the stored frame names another).
 */
const twoPoint = (
  status: ScanCalibration['status'],
  residualM: number,
  anchorBearingDeg: number | null = null,
  toleranceM = 0.15,
): ScanCalibration => ({
  method: 'two-point-ground',
  status,
  sessionToProject: IDENTITY,
  calibratedAt: CALIBRATED_AT,
  separationM: 2,
  residualM,
  toleranceM,
  anchorBearingDeg,
})

/** A committed single-point calibration, in the shape `commitSinglePoint` returns. */
const SINGLE_POINT: ScanCalibration = {
  method: 'ground-tap-compass',
  status: 'provisional',
  sessionToProject: IDENTITY,
  calibratedAt: CALIBRATED_AT,
  anchorBearingDeg: 90,
}

/**
 * The outcomes main.ts reports. `null` is a calibration the person continued without. The mismatch the person
 * kept is `commitTwoPoint(true)` against a stored pair 0.4 m off: outside the 0.15 m tolerance, so the check ran
 * and failed, and the new pair replaces the stored one.
 */
const OUTCOMES: Array<[string, ScanCalibration | null]> = [
  ['two-point, verified', twoPoint('verified', 0.031)],
  ['two-point, provisional', twoPoint('provisional', 0)],
  ['two-point, mismatch kept anyway', twoPoint('provisional', 0.4)],
  ['single point', SINGLE_POINT],
  ['no calibration', null],
]

/**
 * A residual that is not a finite number: NaN (a stored frame with no usable separation passes `commitTwoPoint`'s
 * gate, because every comparison with NaN is false), missing (a record written before the field existed), or
 * unbounded.
 */
const NOT_A_FIGURE: Array<[string, number]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['missing', undefined as unknown as number],
]

/** A stand-in for `#status-text`: the only member writeStatus touches. */
const node = (): StatusNode => ({ textContent: 'Calibrate the project frame…' })

// ── The copy ────────────────────────────────────────────────────────────────

test('two-point verified: says which distance matched what, by how many centimetres, and that direction was not checked', async () => {
  const text = (await alignmentStatusText())(twoPoint('verified', 0.031))
  assert.match(text, /as far apart as/i, 'what was compared is how far apart the two points are')
  assert.match(text, /\bstored\b/i, 'and it was compared with what the Place has stored')
  assert.match(text, /\b3 cm\b/, 'with the centimetre difference the calibration already computes')
  assert.match(text, /direction not checked/i, 'and the person is told the direction was not')
  assert.equal(text, '✓ Points about as far apart as stored\n• 3 cm off, direction not checked', 'the copy is pinned: change it on purpose')
})

test('two-point verified: the headline names the spacing between the two points, so it cannot be read as the points landing near the stored ones', async () => {
  const headline = (await alignmentStatusText())(twoPoint('verified', 0.031)).split('\n')[0]!
  // What `commitTwoPoint` compares is `separationM - storedTwoPoint.separationM`: the spacing between the two
  // points tapped now against the stored spacing. "Distance matches the stored pair" left the subject out, and
  // read as a distance between the tapped points and the stored ones, which nothing measures.
  assert.match(headline, /^✓ Points\b/, 'the subject is the two tapped points')
  assert.match(headline, /\bapart\b/, 'and the quantity is how far apart they are from each other')
  assert.doesNotMatch(headline, /^✓ Distance\b/i, 'not a bare "distance", which could be from anything to anything')
})

test('two-point verified: never claims the alignment, the frame or the Place was verified', async () => {
  const copy = await alignmentStatusText()
  // Across the range a 'verified' result can have: `commitTwoPoint` only labels it so inside the tolerance
  // (0.15 m unless the stored frame names another).
  for (const residualM of [0, 0.004, 0.031, -0.031, 0.149, -0.149]) {
    const text = copy(twoPoint('verified', residualM))
    assert.doesNotMatch(text, /verif/i, `residual ${residualM}: "verified" is the word that overstated the check`)
    assert.doesNotMatch(text, /align/i, `residual ${residualM}: nothing here was aligned or checked for alignment`)
  }
})

test('no two-point text, however the calibration came about, claims alignment or verification', async () => {
  const copy = await alignmentStatusText()
  const results: Array<[string, ScanCalibration]> = [
    ['a first calibration', twoPoint('provisional', 0)],
    ['an uncalibrated record', twoPoint('uncalibrated', 0)],
    ['a mismatch kept anyway, longer', twoPoint('provisional', 0.4)],
    ['a mismatch kept anyway, shorter', twoPoint('provisional', -0.4)],
    ['a mismatch with no figure', twoPoint('provisional', Number.POSITIVE_INFINITY)],
    ...NOT_A_FIGURE.map(([name, residualM]): [string, ScanCalibration] => [`a verified result with a ${name} residual`, twoPoint('verified', residualM)]),
  ]
  for (const [name, calibration] of results) {
    const text = copy(calibration)
    assert.doesNotMatch(text, /verif/i, `${name}: nothing was verified beyond a distance`)
    assert.doesNotMatch(text, /align/i, `${name}: nothing here says or implies the alignment was checked`)
  }
})

test('two-point verified: two short lines, in the glyph and bullet style of the messages around it', async () => {
  const text = (await alignmentStatusText())(twoPoint('verified', 0.031))
  const lines = text.split('\n')
  assert.ok(lines.length <= 2, `at most two lines, got ${lines.length}`)
  assert.match(lines[0]!, /^✓ /, 'the headline carries the same glyph as "✓ Scan exported and synced"')
  assert.match(lines[1]!, /^• /, 'the detail is a bullet, as in "⚠ Single-point anchor\\n• Aligns only at the same spot"')
  // #status-row is about 211 px wide on a 375 px phone, and the verdict chip shares it. 40 is the ceiling this
  // copy keeps: all but two of the 26 distinct bullets already written in main.ts fit it.
  for (const line of lines) assert.ok(line.length <= 40, `short: ${JSON.stringify(line)} is ${line.length} characters`)
})

test('two-point verified without a figure: still two short lines, but no tick for a comparison that never happened', async () => {
  const copy = await alignmentStatusText()
  for (const [name, residualM] of NOT_A_FIGURE) {
    const lines = copy(twoPoint('verified', residualM)).split('\n')
    assert.equal(lines.length, 2, `${name}: two lines`)
    assert.doesNotMatch(lines[0]!, /^✓ /, `${name}: the tick is for a match that was measured`)
    assert.match(lines[1]!, /^• /, `${name}: the detail is still a bullet`)
    for (const line of lines) assert.ok(line.length <= 40, `${name}: short: ${JSON.stringify(line)} is ${line.length} characters`)
  }
})

test('two-point verified: the figure is the size of the gap in whole centimetres, whichever way it went', async () => {
  const copy = await alignmentStatusText()
  // Anchored to the bullet, so a stray minus sign ("• -3 cm off") is not read past.
  const figure = (residualM: number) => copy(twoPoint('verified', residualM)).match(/^• (\d+) cm off,/m)?.[1]
  assert.equal(figure(0.031), '3')
  assert.equal(figure(-0.031), '3', 'closer together reads the same as further apart, with no sign')
  assert.equal(figure(0.026), '3', 'rounded to the nearest centimetre')
  assert.equal(figure(0.012), '1')
  assert.equal(figure(0), '0')
  assert.equal(figure(0.149), '15', 'two digits, at the edge of the 0.15 m tolerance')
})

test('two-point verified: the text cannot depend on direction, because direction was not compared', async () => {
  const copy = await alignmentStatusText()
  const north = copy(twoPoint('verified', 0.02, 0))
  const south = copy(twoPoint('verified', 0.02, 180))
  const unknown = copy(twoPoint('verified', 0.02, null))
  assert.equal(north, south)
  // What a compass reading adds is the note that the tick it drew is session-local, whichever way it read: no figure of it is in the text.
  assert.equal(north, `${unknown}\n• North tick is session-local`)
})

test('a kept mismatch cannot depend on direction either: the check that failed was a distance', async () => {
  const copy = await alignmentStatusText()
  const north = copy(twoPoint('provisional', 0.4, 0))
  assert.equal(north, copy(twoPoint('provisional', 0.4, 180)))
  assert.equal(north, `${copy(twoPoint('provisional', 0.4, null))}\n• North tick is session-local`)
})

test('two-point provisional keeps the meaning of the old text: the frame was set, start scanning', async () => {
  const copy = await alignmentStatusText()
  assert.equal(copy(twoPoint('provisional', 0)), 'Project frame set from two points. Start scanning.')
  assert.equal(copy(twoPoint('uncalibrated', 0)), 'Project frame set from two points. Start scanning.', 'only a verified result gets the matched-distance copy')
})

test('a mismatch the person chose to record anyway is provisional, and never reports a match', async () => {
  const copy = await alignmentStatusText()
  // `commitTwoPoint(true)`: the stored pair was 0.4 m off, outside the tolerance, and the person overrode it.
  const text = copy(twoPoint('provisional', 0.4))
  assert.doesNotMatch(text, /match/i)
  assert.doesNotMatch(text, /✓/, 'no tick: the check ran and failed')
  assert.notEqual(text, 'Project frame set from two points. Start scanning.', 'and it is not the first-calibration line, which says nothing was compared')
  // Whichever way it missed, by however much: nothing that reads as a pass.
  for (const residualM of [-0.4, 0.1501, -0.1501, 1.2, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const kept = copy(twoPoint('provisional', residualM))
    assert.doesNotMatch(kept, /match/i, `residual ${residualM}`)
    assert.doesNotMatch(kept, /✓/, `residual ${residualM}`)
  }
})

test('a mismatch kept anyway says plainly: how far off, that it was kept as chosen, and that earlier scans may not line up', async () => {
  // The new pair REPLACES the Place's stored frame (`frameChanged = !storedTwoPoint || override`; main.ts persists
  // `spatialFrame` to the Place), while every earlier scan keeps the calibration it made against the old pair.
  const text = (await alignmentStatusText())(twoPoint('provisional', 0.4))
  assert.match(text, /\bspacing\b/i, 'what was off is the spacing of the pair, the one number that is compared')
  assert.match(text, /\b40 cm\b/, 'the gap, in centimetres: 0.4 m')
  assert.match(text, /the stored one/i, 'measured against what the Place had stored')
  assert.match(text, /kept as you chose/i, 'kept because the person chose it')
  assert.match(text, /earlier scans may not line up/i, 'and what that costs')
  assert.equal(
    text,
    '⚠ Pair spacing is 40 cm off the stored one\n• Kept as you chose; earlier scans may not line up',
    'the copy is pinned: change it on purpose',
  )
})

test('a kept mismatch: two lines in the warning style of the messages around it, none longer than the line it replaces', async () => {
  const copy = await alignmentStatusText()
  for (const residualM of [0.4, -0.4, 1.2, -1.2, 0.151, Number.POSITIVE_INFINITY]) {
    const lines = copy(twoPoint('provisional', residualM)).split('\n')
    assert.equal(lines.length, 2, `residual ${residualM}: two lines`)
    assert.match(lines[0]!, /^⚠ /, `residual ${residualM}: the headline carries the warning glyph, as "⚠ Single-point anchor" does`)
    assert.match(lines[1]!, /^• /, `residual ${residualM}: the detail is a bullet`)
    // Three facts (the gap, the choice, the cost) do not fit the 40 characters the verified copy keeps. 50 is the
    // length of the one-line first-calibration text this replaces, which the same HUD already shows.
    for (const line of lines) assert.ok(line.length <= 50, `residual ${residualM}: short: ${JSON.stringify(line)} is ${line.length} characters`)
  }
})

test('a kept mismatch: the figure is the size of the gap in whole centimetres, whichever way it went', async () => {
  const copy = await alignmentStatusText()
  // Anchored to the headline, so a stray minus sign ("is -40 cm off") is not read past.
  const figure = (residualM: number) => copy(twoPoint('provisional', residualM)).match(/^⚠ Pair spacing is (\d+) cm off the stored one$/m)?.[1]
  // The sign of `residualM` is re-measured minus stored. Further apart and closer together are the same size of
  // gap, and the mismatch screen the person has just been through says it with the same rounding.
  assert.equal(figure(0.4), '40')
  assert.equal(figure(-0.4), '40', 'no minus sign')
  assert.equal(figure(0.2), '20')
  assert.equal(figure(-0.263), '26', 'rounded to the nearest centimetre')
  assert.equal(figure(1.2), '120', 'three digits')
})

test('a kept mismatch is told from a first calibration by the calibration\'s own fields: provisional, with |residualM| over toleranceM', async () => {
  const copy = await alignmentStatusText()
  const NEUTRAL = 'Project frame set from two points. Start scanning.'
  const kept = (text: string) => /kept as you chose/i.test(text)

  // A first calibration has no stored pair to compare with: residual 0.
  assert.equal(copy(twoPoint('provisional', 0)), NEUTRAL)
  // The comparison is `commitTwoPoint`'s own gate, strictly greater: exactly on the tolerance is still inside it.
  assert.equal(copy(twoPoint('provisional', 0.15)), NEUTRAL, 'on the tolerance')
  assert.equal(copy(twoPoint('provisional', -0.15)), NEUTRAL, 'on the tolerance, the other way')
  assert.ok(kept(copy(twoPoint('provisional', 0.1501))), 'just over')
  assert.ok(kept(copy(twoPoint('provisional', -0.1501))), 'just over, the other way')
  // The tolerance is the stored frame's own, not always 0.15.
  assert.ok(kept(copy(twoPoint('provisional', 0.06, null, 0.05))), '6 cm is a mismatch for a stored frame that allows 5')
  assert.equal(copy(twoPoint('provisional', 0.04, null, 0.05)), NEUTRAL, '4 cm is inside it')
  // Nobody chose to keep anything on a record that was never calibrated.
  assert.equal(copy(twoPoint('uncalibrated', 0.4)), NEUTRAL)
  // A verified result is inside the tolerance by definition, so it is the matched-distance copy.
  assert.doesNotMatch(copy(twoPoint('verified', 0.1)), /kept as you chose/i)
})

test('a kept mismatch needs no figure it does not have: the warning stands without one, and nothing is claimed from a residual that is not a number', async () => {
  const copy = await alignmentStatusText()
  // An unbounded gap is still a gap that failed the check, so it is still reported, minus the centimetres.
  for (const residualM of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      copy(twoPoint('provisional', residualM)),
      '⚠ Pair spacing is far off the stored one\n• Kept as you chose; earlier scans may not line up',
      `residual ${residualM}`,
    )
  }
  // NaN or a missing residual is no comparison at all: neither a failed check to report nor a passed one.
  assert.equal(copy(twoPoint('provisional', Number.NaN)), 'Project frame set from two points. Start scanning.')
  assert.equal(copy(twoPoint('provisional', undefined as unknown as number)), 'Project frame set from two points. Start scanning.')
  for (const residualM of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, undefined as unknown as number]) {
    assert.doesNotMatch(copy(twoPoint('provisional', residualM)), /\d|NaN|Infinity|undefined/, `residual ${residualM}: no figure`)
  }
})

test('two-point verified: a residual that is not a number prints no figure and claims no match', async () => {
  const copy = await alignmentStatusText()
  for (const [name, residualM] of NOT_A_FIGURE) {
    const text = copy(twoPoint('verified', residualM))
    // Never "NaN cm off" or "Infinity cm off": a number that does not exist is not printed. And nothing was
    // compared, so there is no tick and no "as far apart as stored" either.
    assert.doesNotMatch(text, /\d|NaN|Infinity|undefined|\bcm\b/, `${name}: no figure`)
    assert.doesNotMatch(text, /✓|as far apart|match/i, `${name}: no match is claimed for a comparison that never happened`)
    assert.equal(text, 'Project frame set from two points.\n• Spacing and direction not checked', `${name}: the frame is set, nothing more is claimed`)
    assert.match(text, /direction not checked/i, `${name}: and the direction caveat is still there`)
  }
})

test('single point keeps its warning', async () => {
  assert.equal((await alignmentStatusText())(SINGLE_POINT), '⚠ Single-point anchor\n• Aligns only at the same spot')
})

test('no calibration keeps its warning, for null and undefined alike', async () => {
  const copy = await alignmentStatusText()
  assert.equal(copy(null), '⚠ No project alignment\n• Scanning without it. This scan does not set the Place frame')
  assert.equal(copy(undefined), '⚠ No project alignment\n• Scanning without it. This scan does not set the Place frame')
})

test('the five outcomes are five different messages', async () => {
  const copy = await alignmentStatusText()
  const texts = OUTCOMES.map(([, calibration]) => copy(calibration))
  assert.equal(OUTCOMES.length, 5)
  assert.equal(new Set(texts).size, 5, 'in particular a mismatch kept anyway no longer reads like a first calibration')
  for (const text of texts) assert.ok(text.length > 0)
})

// ── The line, driven through the real status-line hold ───────────────────────

for (const [name, calibration] of OUTCOMES) {
  test(`${name}: written sticky, the outcome is still on the line after the tracking prompt`, async () => {
    const text = (await alignmentStatusText())(calibration)
    const el = node()
    writeStatus(el, text, 'sticky')
    writeStatus(el, TRACKING_PROMPT) // what main.ts writes next, at the default priority
    assert.equal(el.textContent, text)
    assert.equal(statusIsHeld(el), true, 'the outcome owns the line')
  })
}

test('the defect, demonstrated: written at the default priority, every outcome is replaced by the tracking prompt', async () => {
  const copy = await alignmentStatusText()
  for (const [name, calibration] of OUTCOMES) {
    const el = node()
    writeStatus(el, copy(calibration))
    writeStatus(el, TRACKING_PROMPT)
    // Both writes are one synchronous run in main.ts, so the first was never painted: only the prompt was seen.
    assert.equal(el.textContent, TRACKING_PROMPT, `${name}: the outcome is lost`)
    assert.equal(statusIsHeld(el), false)
  }
})

// ── The wiring in src/main.ts, read as text ──────────────────────────────────

test('source shape: main.ts no longer says "Alignment verified", and the outcome copy is written in one place', () => {
  const main = read('src/main.ts')
  // Message-only assertions: doesNotMatch/match would print all of main.ts as the failure's input.
  assert.ok(!main.includes('Alignment verified'), 'the overstated claim is gone from main.ts')
  for (const inline of ['Single-point anchor', 'No project alignment', 'Project frame set from two points']) {
    assert.ok(!main.includes(inline), `"${inline}" is in src/ar/alignment-status.ts, not repeated in main.ts`)
  }
  assert.ok(
    /import \{ alignmentStatusText \} from '\.\/ar\/alignment-status(?:\.ts)?'/.test(main),
    'main.ts imports the copy from ./ar/alignment-status',
  )
})

test('source shape: both outcome writes are sticky and precede the tracking prompt, which stays an ordinary write', () => {
  const main = read('src/main.ts')
  const calibrate = main.indexOf('await runProjectCalibration({')
  assert.ok(calibrate > 0, 'the calibration is awaited in main')
  // The prompt is matched with its closing parenthesis and newline, so it is the one-argument, normal-priority call.
  const prompt = main.indexOf("overlay.setStatus('Move the camera to start tracking…')\n", calibrate)
  assert.ok(prompt > calibrate, 'the tracking prompt follows the calibration and is still written at the default priority')

  const between = main.slice(calibrate, prompt)
  const writes = between.split('\n').filter((line) => line.includes('overlay.setStatus('))
  assert.equal(writes.length, 2, 'the only status writes between them are the committed outcome and the continued-without one')
  // The stamped copy (src/ar/engine-config.ts, `stampScale`), not the modal's own: the unit the session ran in is on it, and the line
  // that quotes centimetres must be able to say when they are not metres.
  assert.match(between, /sessionCalibration = stampScale\(calibration\.calibration, provider, calibrationStartedAt\)/, 'the unit this session ran in is written onto the calibration first')
  assert.match(between, /overlay\.setStatus\(alignmentStatusText\(sessionCalibration\), 'sticky'\)/, 'the committed calibration, with its unit, is reported through the copy')
  assert.match(between, /overlay\.setStatus\(alignmentStatusText\(null\), 'sticky'\)/, 'so is a calibration the person continued without')
  for (const line of writes) assert.match(line, /, 'sticky'\)\s*$/, `sticky, or the prompt replaces it: ${line.trim()}`)
})

// ── Three or more points fitted, and a pair checked by spacing (WP-04b) ──────────────────────────────

/** The spacing tolerance a verdict applies at the adopted tap noise, which a scan records as its `toleranceM`. */
const TOLERANCE_M = twoPointToleranceM(0.03)

type TwoPointCalibration = Extract<ScanCalibration, { method: 'two-point-ground' }>

/**
 * A two-point calibration that a fit of `pointsUsed` points checked: what `buildTwoPointCommit` records. These two fixtures read no
 * compass, so no north tick was drawn and the text is the verdict's alone; the note about the tick has its own test, at the end.
 */
const fitted = (status: ScanCalibration['status'], rmsM: number, maxM = rmsM, pointsUsed = 3): TwoPointCalibration => ({
  ...(twoPoint(status, 0.012, null, TOLERANCE_M) as TwoPointCalibration),
  checkedBy: 'constellation',
  fit: {
    fitMethod: 'rigid',
    pointsUsed,
    rmsResidualM: rmsM,
    maxResidualM: maxM,
    perPoint: Array.from({ length: pointsUsed }, () => ({ residualM: rmsM, dx: rmsM, dy: 0, dz: 0 })),
    headingResidualDeg: 0.4,
    scaleRatio: 1,
  },
})

/** A two-point calibration that compared only the spacing of the pair with the stored one. */
const bySpacing = (residualM: number): TwoPointCalibration => ({
  ...(twoPoint('provisional', residualM, null, TOLERANCE_M) as TwoPointCalibration),
  checkedBy: 'separation',
})

test('a fit that was verified: how many points and how far off, in the verdict\'s words, and the one thing taps cannot see', async () => {
  const text = (await alignmentStatusText())(fitted('verified', 0.032))
  assert.equal(text, `✓ 3 points are 3.2 cm off the stored ones\n• ${NOT_CHECKED_SPOTS}`)
  assert.equal(NOT_CHECKED_SPOTS, 'Not checked: that these are the same physical spots. Compare with the photos.')
})

test('a fit that was verified never says the alignment, the frame or the Place was verified', async () => {
  const text = (await alignmentStatusText())(fitted('verified', 0.032))
  assert.doesNotMatch(text, /align|frame|Place|verified|same spot\b/i)
  assert.doesNotMatch(text, /NaN|Infinity|undefined/)
})

test('a fit that agreed but could not be relied on is a frame set, not verified, and says so', async () => {
  const text = (await alignmentStatusText())(fitted('provisional', 0.041))
  assert.equal(text, 'Frame set. 3 points are 4.1 cm off the stored ones\n• Not verified: the points agreed, but the check could not be relied on')
  assert.doesNotMatch(text, /✓|⚠/, 'neither a tick nor a warning: it passed the limits and it is not verified')
})

test('a fit that failed and was kept anyway is a warning that earlier scans may not line up, as a kept pair always was', async () => {
  const copy = await alignmentStatusText()
  // The rms gate is half the tolerance: 8.4 cm at 3 cm of tap noise.
  const text = copy(fitted('provisional', 0.25, 0.31))
  assert.equal(text, '⚠ Points are 25.0 cm off the stored ones\n• Kept as you chose; earlier scans may not line up')
  // Past the gate by the worst point alone is past the gate too (the worst-point limit is 2.5 times the rms one).
  assert.match(copy(fitted('provisional', 0.05, 0.4)), /^⚠ Points are 5\.0 cm off the stored ones/)
  // Just inside both gates is not a failure.
  assert.doesNotMatch(copy(fitted('provisional', TOLERANCE_M / 2, 2.5 * (TOLERANCE_M / 2))), /Kept as you chose/)
})

test('on a phone whose units are not metres the lines that quote centimetres say so, as the card beside them did', async () => {
  const copy = await alignmentStatusText()
  for (const kind of ['arbitrary', 'estimated-metric'] as const) {
    const sizes = NOT_CHECKED_METRES[kind]
    const verified = copy({ ...fitted('verified', 0.032), scaleKind: kind })
    assert.equal(verified, `✓ 3 points are 3.2 cm off the stored ones\n• ${NOT_CHECKED_SPOTS}\n• ${sizes}`, kind)
    assert.equal(
      copy({ ...fitted('provisional', 0.041), scaleKind: kind }),
      `Frame set. 3 points are 4.1 cm off the stored ones\n• Not verified: the points agreed, but the check could not be relied on\n• ${sizes}`,
      kind,
    )
    assert.equal(
      copy({ ...fitted('provisional', 0.25, 0.31), scaleKind: kind }),
      `⚠ Points are 25.0 cm off the stored ones\n• Kept as you chose; earlier scans may not line up\n• ${sizes}`,
      kind,
    )
  }
  // Metres from the runtime, and a record that says nothing about its units, add nothing: the line is what it was.
  assert.equal(copy({ ...fitted('verified', 0.032), scaleKind: 'metric' }), `✓ 3 points are 3.2 cm off the stored ones\n• ${NOT_CHECKED_SPOTS}`)
  assert.equal(copy(fitted('verified', 0.032)), `✓ 3 points are 3.2 cm off the stored ones\n• ${NOT_CHECKED_SPOTS}`)
  // Points that did not fit at all quote no figure, so there is no centimetre for the units to qualify.
  const unfitted: TwoPointCalibration = { ...(twoPoint('provisional', 0) as TwoPointCalibration), checkedBy: 'constellation', scaleKind: 'arbitrary' }
  assert.doesNotMatch(copy(unfitted), /metres/)
})

test('a visit that tapped two points reports the distance check and what it did not check, and is never ticked', async () => {
  const copy = await alignmentStatusText()
  const text = copy(bySpacing(0.03))
  assert.equal(text, 'Frame set. Distance checked, direction not checked\n• 3 cm off the stored distance')
  assert.doesNotMatch(text, /✓|verified/i)
  // The same words whichever side the spacing was off.
  assert.equal(copy(bySpacing(-0.03)), text)
})

test('a spacing that is not a figure compared nothing, and says so rather than "distance checked"', async () => {
  const copy = await alignmentStatusText()
  assert.equal(copy(bySpacing(Number.NaN)), 'Project frame set from two points.\n• Spacing and direction not checked')
  // An unbounded gap is a gap that failed, as it always was: it is the kept-mismatch line, without a number.
  assert.equal(copy(bySpacing(Number.POSITIVE_INFINITY)), '⚠ Pair spacing is far off the stored one\n• Kept as you chose; earlier scans may not line up')
})

test('points kept over a spacing that failed are still the warning, with the gap, not "distance checked"', async () => {
  const text = (await alignmentStatusText())(bySpacing(0.4))
  assert.equal(text, '⚠ Pair spacing is 40 cm off the stored one\n• Kept as you chose; earlier scans may not line up')
})

test('points that could not be fitted at all and were kept are the warning, not a frame that was merely set (a mirrored check point, the pair in the other order)', async () => {
  const copy = await alignmentStatusText()
  // What the flow writes for them: checked by the constellation, provisional, and no fit, because `fitRigid2D` gives a reason and no figures.
  const kept: TwoPointCalibration = { ...(twoPoint('provisional', 0) as TwoPointCalibration), checkedBy: 'constellation' }
  assert.equal(copy(kept), '⚠ Points did not match the stored ones\n• Kept as you chose; earlier scans may not line up')
  assert.doesNotMatch(copy(kept), /NaN|undefined|Start scanning|\d cm/, 'no figure exists, and none is made up')
  // Only that combination: a verified record that names a constellation and carries no fit is not a kept mismatch, and a pair checked by spacing is not either.
  assert.doesNotMatch(copy({ ...kept, status: 'verified' } as TwoPointCalibration), /Kept as you chose/)
  assert.doesNotMatch(copy({ ...kept, checkedBy: 'separation' } as TwoPointCalibration), /Points did not match/)
  assert.doesNotMatch(copy({ ...kept, checkedBy: undefined } as TwoPointCalibration), /Points did not match/)
})

test('a record that names a fit and carries none, or a fit of too few points, is otherwise read as any other, and prints no figure it does not have', async () => {
  const copy = await alignmentStatusText()
  const broken = fitted('verified', Number.NaN)
  assert.doesNotMatch(copy(broken), /NaN/)
  const tooFew = fitted('verified', 0.02, 0.02, 2)
  assert.doesNotMatch(copy(tooFew), /2 points/, 'two points are not a fit: nothing is claimed of one')
})

test('every outcome the flow can now produce is worded, and the words differ where the checks differ', async () => {
  const copy = await alignmentStatusText()
  const texts = new Map<string, string>([
    ['first calibration', copy(twoPoint('provisional', 0, null, TOLERANCE_M))],
    ['two points matched', copy(bySpacing(0.03))],
    ['two points kept', copy(bySpacing(0.4))],
    ['fit verified', copy(fitted('verified', 0.03))],
    ['fit not verified', copy(fitted('provisional', 0.03))],
    ['fit kept', copy(fitted('provisional', 0.4))],
    ['points that did not fit, kept', copy({ ...(twoPoint('provisional', 0) as TwoPointCalibration), checkedBy: 'constellation' })],
  ])
  assert.equal(new Set(texts.values()).size, texts.size, [...texts].map(([name, text]) => `${name}: ${text}`).join('\n'))
})

// ── What the origin decal's wave (#269) said that the copy module must still say ────────────────────────────────────

test('a bypassed floor check is said first, on either tier and whatever the separation was: provisional, and no Place frame is set', async () => {
  const copy = await alignmentStatusText()
  const expected = 'Floor check bypassed — provisional, and this scan does not set the Place frame.'
  assert.equal(copy({ ...twoPoint('provisional', 0), floorCheckBypassed: true }), expected)
  assert.equal(copy({ ...twoPoint('provisional', 0.4), floorCheckBypassed: true }), expected, 'a gap that would have said "kept as you chose" says this first')
  assert.equal(copy({ ...twoPoint('provisional', 0, 125), floorCheckBypassed: true }), expected, 'and no tick note on it: the line is about the frame')
  assert.equal(copy({ ...SINGLE_POINT, floorCheckBypassed: true }), expected, 'the one-point tier too')
  assert.notEqual(copy({ ...twoPoint('provisional', 0), floorCheckBypassed: false }), expected, 'a floor-checked commit does not say it')
  assert.notEqual(copy({ ...SINGLE_POINT, floorCheckBypassed: false }), expected)
})

test('a scan continued without a calibration says it does not set the Place frame', async () => {
  const copy = await alignmentStatusText()
  assert.match(copy(null), /This scan does not set the Place frame/)
  assert.match(copy(null), /^⚠ No project alignment\n/, 'under the headline it always had')
})

test('the north tick is said to be session-local where a compass reading drew it, and only there', async () => {
  const copy = await alignmentStatusText()
  const note = '\n• North tick is session-local'
  for (const [name, calibration] of OUTCOMES) {
    if (calibration === null || calibration.method !== 'two-point-ground') continue
    assert.ok(!copy(calibration).includes('session-local'), `${name}: no compass reading, so no tick was drawn and none is mentioned`)
    const withCompass = { ...calibration, anchorBearingDeg: 125 }
    assert.equal(copy(withCompass), copy(calibration) + note, `${name}: the same line, and then the note`)
  }
  // The fit's verdict and the spacing's keep their own words, and the note comes after them.
  assert.equal(copy({ ...fitted('verified', 0.032), anchorBearingDeg: 317 }), `${copy(fitted('verified', 0.032))}${note}`)
  assert.equal(copy({ ...bySpacing(0.03), anchorBearingDeg: 317 }), `${copy(bySpacing(0.03))}${note}`)
  assert.ok(!copy({ ...twoPoint('provisional', 0), anchorBearingDeg: Number.NaN }).includes('session-local'), 'a bearing that is not a number drew no tick')
  assert.ok(!copy(SINGLE_POINT).includes('session-local'), 'the one-point tier draws a tick but has its own warning, which says it aligns only at the same spot')
})
