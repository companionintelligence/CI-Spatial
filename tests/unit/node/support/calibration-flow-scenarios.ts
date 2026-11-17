/**
 * The scenarios the calibration modal is held to (tests/unit/node/wp-calibration-characterisation.test.ts), one per way
 * a commit can go: a first two-point calibration, a return visit inside and outside the spacing tolerance, "Use anyway",
 * the one-point tier with and without a compass reading, and a pair too close together. Two more are about the tap
 * before the commit, when the runtime cannot read it, and two about the order of things around the camera frame.
 *
 * WP-04b added the check point. A first calibration is now offered a third point after the heading marker, and every
 * scenario that goes on to commit says what it does about it (`SKIP_CHECK` presses the one check-point button, which skips
 * the step), as a person does; the scenarios of the constellation flow (a check point taken, re-tapped, off, swapped, skipped,
 * unusable) are at the end.
 *
 * Each is a list of what a person does (taps, a typed label, a button) and what the host does (a compass change, a
 * camera frame arriving), driven by ./calibration-flow-driver.ts. The outputs recorded for them are in
 * ./calibration-flow-goldens.ts.
 *
 * The geometry is chosen so a boundary can be hit exactly. Points on one axis have a separation the arithmetic
 * cannot round (`hypot(2.25, 0)` is 2.25), so "exactly at the tolerance" is exactly that and not a guess about the
 * last bit. The pairs that are not on an axis stand for the ordinary case.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import { FLOOR_Y, type Scenario, type Step } from './calibration-flow-driver.ts'
import { twoPointToleranceM } from '../../../../src/world/frame-fit.ts'

/** A floor point: `x` and `z` in session metres, on the floor. */
const floor = (x: number, z: number) => ({ x, y: FLOOR_Y, z })

/** The one check-point button, pressed in the step that follows the heading marker: it skips the step. */
const SKIP_CHECK: Step = { press: 'check' }

/** A stored two-point frame, as a Place written by the previous build holds it. */
const twoPointFrame = (separationM: number, extra: Record<string, unknown> = {}) => ({
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

/**
 * A stored two-point frame with a check point, as a Place calibrated with the check-point step holds it. In the Place frame the
 * landmark is the origin, the heading marker 3.5 m along +Z and the check point 2.6 m to one side and a metre along: sides of
 * 3.5, 2.8 and 3.6 m, so no other order of the points fits as well, and the predicted accuracy is inside the product's target.
 */
const threePointFrame = (extra: Record<string, unknown> = {}) =>
  twoPointFrame(3.5, { toleranceM: twoPointToleranceM(0.03), checkPoints: [{ x: -2.6, y: 0, z: 1, label: 'by the radiator' }], ...extra })

/**
 * Where a Place-frame point is in a later session that is the Place frame turned a quarter way round and shifted: a visit's
 * tap for it. `lift` is how high above the floor the tap lands.
 */
const inVisit = (p: { x: number; z: number }, lift = 0) => ({ x: p.z + 4, y: FLOOR_Y + lift, z: -p.x + 1 })
const PLACE_L = { x: 0, z: 0 }
const PLACE_H = { x: 0, z: 3.5 }
const PLACE_C = { x: -2.6, z: 1 }

const onePointFrame = { version: 1, createdAt: '2026-11-01T00:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 12 }

/**
 * A return visit: the landmark at (1, 2) and the heading marker `apart` metres from it along +x, so the separation
 * is the difference of two sums and nothing a square root could round. `after` is what happens once both are placed.
 */
const returnVisit = (name: string, about: string, stored: unknown, apart: number, after: Step[] = [{ press: 'commit' }]): Scenario => ({
  name,
  about,
  stored,
  capture: 'immediate',
  steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(1 + apart, 2) }, ...after],
})

export const SCENARIOS: Scenario[] = [
  // ── A first calibration: nothing stored, so nothing to verify against ─────────────────────────────────
  {
    name: 'first two-point calibration, labels, photos',
    about: 'The ordinary first calibration: 3 m apart off an axis, a compass reading, both points named, both photos taken. Pins the calibration, the Place frame, the photos and the order the bearing is read in.',
    capture: 'immediate',
    steps: [
      { tap: floor(1.5, -2) },
      { type: 'north door frame' },
      { press: 'confirm' },
      { tap: floor(3.3, 0.4) },
      SKIP_CHECK,
      { type: 'radiator corner' },
      { look: 'ready to commit' },
      { press: 'commit' },
    ],
  },
  {
    name: 'first two-point calibration, no compass, no photo accessor',
    about: 'A null compass is metadata only on this tier: the frame is built, its bearings are null, and no photo is attempted.',
    compass: null,
    steps: [{ tap: floor(1.5, -2) }, { press: 'confirm' }, { tap: floor(3.3, 0.4) }, SKIP_CHECK, { press: 'commit' }],
  },
  {
    name: 'first calibration, pair exactly the minimum apart',
    about: 'The hard minimum is inclusive: 1.0 m apart commits.',
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(2, 2) }, SKIP_CHECK, { press: 'commit' }],
  },
  {
    name: 'first calibration, pair just under the minimum',
    about: 'A hair under 1.0 m is refused: the modal stays open, nothing is dropped, and no photo is taken for it.',
    capture: 'immediate',
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(1.9999999, 2) }, { press: 'commit' }, { look: 'after the refusal' }],
  },
  {
    name: 'first calibration, pair 0.6 m apart',
    about: 'Too close to fix a heading: the card says so, the commit button is off, and a scripted click on it commits nothing.',
    capture: 'immediate',
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(1.6, 2) }, { look: 'before the click' }, { press: 'commit' }, { look: 'after the click' }],
  },
  {
    name: 'first calibration, Use anyway clicked with no mismatch',
    about: 'The override button is hidden outside the mismatch screen, but a script can click it: with nothing stored it is a first calibration, provisional, as ever.',
    capture: 'immediate',
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(4, 2) }, SKIP_CHECK, { press: 'override' }],
  },

  // ── A return visit: the stored pair is the reference ─────────────────────────────────────────────────
  returnVisit('return visit, same separation', 'The stored pair tapped again: provisional, checked by distance (a distance check is never verified), residual 0, the Place frame kept, and the stored pair drawn beside what was tapped.', twoPointFrame(3), 3),
  returnVisit('return visit, 10 cm further apart', 'Inside the 16.8 cm spacing tolerance (twice the rms gate at 3 cm of tap noise): provisional, with the residual as measured.', twoPointFrame(3), 3.1),
  returnVisit('return visit, 12 cm closer together', 'Inside the tolerance on the other side: the residual is negative.', twoPointFrame(3), 2.88),
  returnVisit('return visit, exactly at the tolerance', 'The stored frame\'s own tolerance (0.25 here) is no longer read: a gap of 0.25 m is past the 16.8 cm the tap noise allows, so this is the mismatch screen.', twoPointFrame(2, { toleranceM: 0.25 }), 2.25, [
    { press: 'commit' },
    { look: 'mismatch' },
  ]),
  returnVisit(
    'return visit, just over the tolerance',
    'A hair past the stored tolerance is the mismatch screen too, as it is for any gap past the spacing tolerance.',
    twoPointFrame(2, { toleranceM: 0.25 }),
    2.2500001,
    [{ press: 'commit' }, { look: 'mismatch' }],
  ),
  returnVisit('return visit, a hair inside the spacing tolerance', 'The comparison is strict: a gap of 16.5 cm, a little inside the 16.8 cm the tap noise allows, commits.', twoPointFrame(2), 2.165),
  returnVisit(
    'return visit, a hair past the spacing tolerance',
    'And one of 17 cm, a little past it, is the mismatch screen.',
    twoPointFrame(2),
    2.17,
    [{ press: 'commit' }, { look: 'mismatch' }],
  ),
  returnVisit(
    'return visit, 40 cm further apart',
    'Outside the tolerance: the mismatch screen, what it says, and which buttons it offers. Nothing is committed and no photo is taken for the heading marker.',
    twoPointFrame(3),
    3.4,
    [{ press: 'commit' }, { look: 'mismatch' }],
  ),
  returnVisit(
    'return visit, 30 cm closer together',
    'The same screen the other way: "closer together".',
    twoPointFrame(3),
    2.7,
    [{ press: 'commit' }, { look: 'mismatch' }],
  ),
  {
    name: 'return visit, mismatch, then Use anyway',
    about: 'The way out of a mismatch replaces the Place frame: a new frame, provisional, the residual that failed, the stored tolerance carried over, photos taken, and no stored pair drawn.',
    stored: twoPointFrame(3),
    capture: 'immediate',
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(4.4, 2) }, { press: 'commit' }, { press: 'override' }],
  },
  {
    name: 'return visit, mismatch, then Re-place points',
    about: 'The other way out: back to the landmark, nothing committed.',
    stored: twoPointFrame(3),
    steps: [{ tap: floor(1, 2) }, { press: 'confirm' }, { tap: floor(4.4, 2) }, { press: 'commit' }, { press: 'replace' }, { look: 'after re-place' }],
  },
  returnVisit('return visit, stored tolerance 0.05, 6 cm off', 'The stored tolerance is no longer read: 6 cm is inside the spacing tolerance the tap noise gives, so it commits, and the record carries that tolerance.', twoPointFrame(3, { toleranceM: 0.05 }), 3.06),
  returnVisit('return visit, stored tolerance 0.4, 30 cm off', 'And 30 cm is past it whatever a stored 0.4 says: the mismatch screen.', twoPointFrame(3, { toleranceM: 0.4 }), 3.3, [
    { press: 'commit' },
    { look: 'mismatch' },
  ]),
  returnVisit('return visit, stored frame without a tolerance, 14 cm off', 'A frame with no tolerance is judged as every other is, and the record carries the spacing tolerance.', twoPointFrame(3, { toleranceM: undefined }), 3.14),
  returnVisit('return visit, stored tolerance null, 16 cm off', 'A null tolerance is the same, and 16 cm is inside the 16.8 cm the tap noise allows (it was past the 15 cm of the build before).', twoPointFrame(3, { toleranceM: null }), 3.16),
  returnVisit('return visit, stored frame with no usable separation', 'A stored separation that is not a number compares nothing: the visit is provisional, never verified, with a residual that is not a figure (the status line prints no figure for it).', twoPointFrame(3, { separationM: Number.NaN }), 3.4),
  returnVisit('return visit, Use anyway clicked with no mismatch', 'A scripted click on the hidden override button: provisional, the Place frame replaced, the residual as measured.', twoPointFrame(3), 3.05, [
    { press: 'override' },
  ]),

  // ── The one-point tier ───────────────────────────────────────────────────────────────────────────────
  {
    name: 'one point, compass reading',
    about: 'A compass reading is the frame\'s whole heading: a one-point calibration, a one-point Place frame, only the landmark drawn.',
    steps: [{ tap: floor(1.5, -2) }, { press: 'fallback' }],
  },
  {
    name: 'one point, no compass reading',
    about: 'The WP-10a refusal: without a compass there is no heading, so it does not commit, says why, and drops nothing; two points are still on offer.',
    compass: null,
    steps: [{ tap: floor(1.5, -2) }, { press: 'fallback' }, { look: 'refused' }, { press: 'confirm' }, { look: 'heading step' }],
  },
  {
    name: 'one point on a Place with a one-point frame',
    about: 'A frame the Place already holds is never replaced by the one-point tier: the calibration comes back and no Place frame does.',
    stored: onePointFrame,
    steps: [{ tap: floor(1.5, -2) }, { press: 'fallback' }],
  },
  {
    name: 'one point on a Place with a two-point frame',
    about: 'The button is not offered there, and a click that reaches it anyway is refused: the modal stays open.',
    stored: twoPointFrame(3),
    steps: [{ tap: floor(1.5, -2) }, { look: 'landmark placed' }, { press: 'fallback' }],
  },

  // ── A tap the runtime cannot read ────────────────────────────────────────────────────────────────────
  {
    name: 'a tap with no surface under it, then good ones',
    about: 'The runtime answers a tap with nothing: the card says so and keeps saying it through the render poll (the one message the poll must not erase), nothing is placed, and the next tap is read as any other.',
    steps: [
      { miss: 'nothing' },
      { look: 'no surface' },
      { advance: 400 },
      { look: 'after the poll' },
      { tap: floor(1.5, -2) },
      { look: 'landmark placed' },
      { press: 'confirm' },
      { tap: floor(3.3, 0.4) },
      SKIP_CHECK,
      { press: 'commit' },
    ],
  },
  {
    name: 'a tap the runtime fails on, then good ones',
    about: 'A hit test that fails is a tap with no surface under it, not an error: the same card, nothing placed, no failure left unhandled, and the next tap is read as any other.',
    steps: [
      { miss: 'error' },
      { look: 'no surface' },
      { advance: 400 },
      { look: 'after the poll' },
      { tap: floor(1.5, -2) },
      { look: 'landmark placed' },
      { press: 'confirm' },
      { tap: floor(3.3, 0.4) },
      SKIP_CHECK,
      { press: 'commit' },
    ],
  },

  // ── The order of things around the camera frame ──────────────────────────────────────────────────────
  {
    name: 'commit pressed twice while the photos are pending',
    about: 'The commit waits for the camera frames, and a second press in that time is ignored: one result, one pair of markers.',
    capture: 'deferred',
    steps: [{ tap: floor(1.5, -2) }, { press: 'confirm' }, { tap: floor(3.3, 0.4) }, SKIP_CHECK, { press: 'commit' }, { look: 'waiting' }, { press: 'commit' }, { release: true }],
  },
  {
    name: 'compass, clock and labels settle after the photo wait',
    about: 'What a commit records is read when it completes, not when the button was pressed: a compass that changes, a clock that moves on and a label typed while the camera frames are pending are the ones recorded.',
    capture: 'deferred',
    steps: [
      { tap: floor(1.5, -2) },
      { press: 'confirm' },
      { tap: floor(3.3, 0.4) },
      SKIP_CHECK,
      { press: 'commit' },
      { compass: 200 },
      { advance: 5000 },
      { type: 'typed during the wait' },
      { release: true },
    ],
  },

  // ── The check point (WP-04b) ─────────────────────────────────────────────────────────────────────────
  {
    name: 'first calibration with a check point, named and photographed',
    about: 'The step after the heading marker: the card says what is asked, and has no label field until the check point is down; the field then names the check point, the frame stores it in the Place frame with its name, and a third photo is taken.',
    capture: 'immediate',
    steps: [
      { tap: floor(1, 2) },
      { type: 'north door frame' },
      { press: 'confirm' },
      { tap: floor(4.5, 2) },
      { look: 'check step' },
      { tap: floor(2, 4.6) },
      { type: 'by the radiator' },
      { look: 'review with the check point' },
      { press: 'commit' },
    ],
  },
  {
    name: 'first calibration, check point taken and then removed',
    about: 'The one check-point button takes a placed check point away: the frame is the pair, as ever, and nothing about the third point is kept.',
    capture: 'immediate',
    steps: [
      { tap: floor(1, 2) },
      { press: 'confirm' },
      { tap: floor(4.5, 2) },
      { tap: floor(2, 4.6) },
      { press: 'check' },
      { look: 'after removing' },
      { press: 'commit' },
    ],
  },
  {
    name: 'first calibration, check point skipped and added back from review',
    about: 'Skipping the step is not final: review offers the check point again, and placing it there is the same as placing it in the step.',
    steps: [
      { tap: floor(1, 2) },
      { press: 'confirm' },
      { tap: floor(4.5, 2) },
      SKIP_CHECK,
      { look: 'skipped' },
      { press: 'check' },
      { look: 'asked again' },
      { tap: floor(2, 4.6) },
      { press: 'commit' },
    ],
  },
  {
    name: 'first calibration, check point almost on the line',
    about: 'A check point 5 cm off the line between the pair cannot serve as a reference: the line under the markers says so in red, the commit is off, and a script that presses it anyway is turned away with the same sentence.',
    steps: [
      { tap: floor(1, 2) },
      { press: 'confirm' },
      { tap: floor(4.5, 2) },
      { tap: floor(2.75, 2.05) },
      { look: 'on the line' },
      { press: 'commit' },
      { look: 'refused' },
    ],
  },
  {
    name: 'return visit with a check point, all three re-tapped',
    about: 'Three points tapped against a stored check point are fitted: verified, the fit and its residuals recorded, the Place frame kept, the stored points drawn where this visit puts them with a line from each marker to its ghost.',
    stored: threePointFrame(),
    steps: [
      { tap: inVisit(PLACE_L) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_H) },
      { look: 'check step' },
      { tap: inVisit(PLACE_C) },
      { look: 'review' },
      { press: 'commit' },
    ],
  },
  {
    name: 'return visit with a check point, one metre off, then adjusted',
    about: 'A check point a metre along the baseline from where it was stored, with the pair exactly right, is a mismatch the distance check could not have seen: the screen lists what the verdict found and the points one by one, "Adjust a point" goes back to the markers, and moving the point redoes the comparison until it is verified.',
    stored: threePointFrame(),
    steps: [
      { tap: inVisit(PLACE_L) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_H) },
      { tap: inVisit({ x: PLACE_C.x, z: PLACE_C.z + 1 }) },
      { look: 'review, off' },
      { press: 'commit' },
      { look: 'mismatch' },
      { press: 'adjust' },
      { look: 'adjusting' },
      { tap: inVisit({ x: PLACE_C.x, z: PLACE_C.z + 1 }) },
      { tap: inVisit(PLACE_C) },
      { look: 'after the re-tap' },
      { press: 'commit' },
    ],
  },
  {
    name: 'return visit with a check point, pair swapped',
    about: 'The right three points tapped with the first two the wrong way round: a mismatch, and the verdict says the first two may be swapped.',
    stored: threePointFrame(),
    steps: [
      { tap: inVisit(PLACE_H) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_L) },
      { tap: inVisit(PLACE_C) },
      { press: 'commit' },
      { look: 'mismatch' },
    ],
  },
  {
    name: 'return visit with a check point, check point skipped',
    about: 'A visit that cannot reach the check point skips it: provisional, checked by distance, and the card says only the distance between the two points will be checked.',
    stored: threePointFrame(),
    steps: [
      { tap: inVisit(PLACE_L) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_H) },
      SKIP_CHECK,
      { look: 'skipped' },
      { press: 'commit' },
    ],
  },
  {
    name: 'return visit with a check point, mismatch, then Use anyway',
    about: 'Keeping points that did not match replaces the Place frame with this visit\'s own, check point included, with its photo; the record keeps the fit that failed.',
    stored: threePointFrame(),
    capture: 'immediate',
    steps: [
      { tap: inVisit(PLACE_L) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_H) },
      { tap: inVisit({ x: PLACE_C.x, z: PLACE_C.z + 1 }) },
      { press: 'commit' },
      { press: 'override' },
    ],
  },
  {
    name: 'return visit with a check point, check point tapped on a table',
    about: 'A check point tapped 30 cm up (a second tap at that height confirms it, as the floor gate asks) agrees in position and not in height: the readout says why it is not verified, and the visit is provisional, never a mismatch.',
    stored: threePointFrame(),
    steps: [
      { tap: inVisit(PLACE_L) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_H) },
      { tap: inVisit(PLACE_C, 0.3) },
      { tap: inVisit(PLACE_C, 0.3) },
      { look: 'review' },
      { press: 'commit' },
    ],
  },
  {
    name: 'return visit, stored check point on the line',
    about: 'A stored check point on the line between the pair cannot serve as a reference: the visit is compared by distance, and the readout says why the check point was not compared.',
    stored: threePointFrame({ checkPoints: [{ x: 0, y: 0, z: 1.75 }] }),
    steps: [
      { tap: inVisit(PLACE_L) },
      { press: 'confirm' },
      { tap: inVisit(PLACE_H) },
      { tap: inVisit({ x: -2, z: 1 }) },
      { look: 'review' },
      { press: 'commit' },
    ],
  },
]
