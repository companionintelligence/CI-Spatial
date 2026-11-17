/**
 * The place-register matcher (server/register/scan_match.ts): given two scans of
 * a room, each already in the Place frame, does it find the move that lines them
 * up, and does it say no when it should?
 *
 * Every room here is synthetic and seeded (tests/fixtures/place-register), so what
 * is asserted is known: the second scan of a room is the first sampled again, with
 * its own noise and furniture, carried through a placement error that is injected
 * on purpose. "Recovered" means the correction the matcher returns undoes that
 * error to under 5 cm at the room's corners and under 1 degree, the bar the package
 * set.
 *
 * What the tests do NOT claim: that real scans behave like these. Every threshold
 * the matcher uses is adopted, not measured (ADR 0005 rule 5), because the repo
 * holds no real two-scan captures; DX9 is the run that tunes them. These tests pin
 * the behaviour the thresholds were chosen for, not their values.
 *
 * Run: deno task test
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'

import { composeYUpTransform } from '../../../src/world/geo.ts'
import { multiplyMat4 } from '../../../src/world/register-proposal.ts'
import {
  AMBIGUOUS_REACH_M,
  estimateFloor,
  extractWallCells,
  FLOOR_HINT_TOLERANCE_M,
  floorSourceOf,
  invertYawTranslation,
  MAX_CORRECTION_DY_M,
  MAX_CORRECTION_TRANSLATION_M,
  MAX_CORRECTION_YAW_DEG,
  MAX_INLIER_RESIDUAL_M,
  matchParams,
  matchScans,
  MIN_ACCEPT_SCORE,
  MIN_OVERLAP_FRACTION,
  transformPositions,
  UNIQUE_REACH_M,
  yawTranslationMatrix,
} from '../../../server/register/scan_match.ts'
import {
  type Box,
  concatClouds,
  corners,
  makePolygonRoom,
  makeRoom,
  type Misplacement,
  misplace,
  recoveryError,
  rng,
  type RoomSpec,
} from '../../fixtures/place-register/synthetic-room.ts'

const ROOM = { width: 6, depth: 4, centre: { x: 3, z: 2 } } as const

const FURNITURE: Box[] = [
  { x: 1.2, z: 1.0, w: 0.8, d: 0.6, h: 0.9 },
  { x: 4.5, z: 3.0, w: 1.2, d: 0.5, h: 0.5 },
  { x: 2.5, z: 0.4, w: 0.5, d: 0.5, h: 1.6 },
]
/** The same room on another day: one piece moved across the room, one gone, one new. */
const FURNITURE_MOVED: Box[] = [
  { x: 1.9, z: 2.2, w: 0.8, d: 0.6, h: 0.9 },
  { x: 4.5, z: 3.0, w: 1.2, d: 0.5, h: 0.5 },
  { x: 5.0, z: 1.0, w: 0.7, d: 0.4, h: 1.2 },
]

function room(seed: number, extra: Partial<RoomSpec> = {}): Float32Array {
  return makeRoom({ ...ROOM, noiseM: 0.02, boxes: FURNITURE, seed, ...extra })
}

/** How far the injected error moves the middle of the room: what the correction bound is measured on. */
function centreShiftM(error: Misplacement): number {
  const yaw = (error.yawDeg * Math.PI) / 180
  const { x, z } = ROOM.centre
  return Math.hypot(Math.cos(yaw) * x + Math.sin(yaw) * z + error.dx - x, -Math.sin(yaw) * x + Math.cos(yaw) * z + error.dz - z)
}

/** The matcher, run the way the job runs it: the reference as it is, the new scan carried through an error. */
function match(error: Misplacement, moving: Float32Array, reference: Float32Array = room(1)) {
  return matchScans({ positions: reference }, { positions: misplace(moving, error) })
}

function assertRecovered(result: ReturnType<typeof matchScans>, error: Misplacement, label: string): void {
  assertEquals(result.status, 'proposed', `${label}: ${result.reason}`)
  assert(result.transform, `${label}: a proposal carries its transform`)
  const recovered = recoveryError(result.transform, error, corners(ROOM))
  assert(recovered.positionM < 0.05, `${label}: corners are ${(recovered.positionM * 100).toFixed(1)} cm out`)
  assert(Math.abs(recovered.yawDeg) < 1, `${label}: ${recovered.yawDeg.toFixed(2)} degrees out`)
}

// ─── Recovery ────────────────────────────────────────────────────────────────

const INJECTED: Misplacement[] = [
  { yawDeg: 3, dx: 0.3, dz: -0.2 },
  { yawDeg: -5, dx: -0.55, dz: 0.4 },
  { yawDeg: 8, dx: -0.3, dz: -0.2 },
  { yawDeg: 0.4, dx: 0.04, dz: 0.03 },
  { yawDeg: -2, dx: 0, dz: 0.85 },
]

for (const error of INJECTED) {
  Deno.test(`matchScans: recovers an injected placement error of ${error.yawDeg} deg and (${error.dx}, ${error.dz}) m to under 5 cm and 1 deg`, () => {
    assert(centreShiftM(error) <= MAX_CORRECTION_TRANSLATION_M, 'the case itself must lie inside the bound')
    const result = match(error, room(2))
    assertRecovered(result, error, 'clean room')
    // The numbers a person reads are the measurement, not decoration.
    assert(result.overlapFraction > 0.9, `overlap ${result.overlapFraction}`)
    assert(result.inlierResidualM !== null && result.inlierResidualM < 0.05, `residual ${result.inlierResidualM}`)
    assert(result.score > 0.9, `score ${result.score}`)
    assertEquals(result.reason, null)
    assertEquals(result.boundedCorrection?.withinBound, true)
    // The reported size of the move is the size of the move: the error undone.
    assertAlmostEquals(result.boundedCorrection!.yawDeg, -error.yawDeg, 1)
    assertAlmostEquals(result.boundedCorrection!.translationM, centreShiftM(error), 0.06)
  })
}

Deno.test('matchScans: an exact match asks for no move at all', () => {
  const result = match({ yawDeg: 0, dx: 0, dz: 0 }, room(2))
  assertEquals(result.status, 'proposed')
  assert(result.boundedCorrection!.translationM < 0.03)
  assert(Math.abs(result.boundedCorrection!.yawDeg) < 0.3)
})

Deno.test('matchScans: recovers through scan noise of 3 cm and through a sparse sampling', () => {
  const error: Misplacement = { yawDeg: 3, dx: 0.35, dz: -0.25 }
  assertRecovered(
    matchScans({ positions: room(1, { noiseM: 0.03 }) }, { positions: misplace(room(2, { noiseM: 0.03 }), error) }),
    error,
    '3 cm noise',
  )
  assertRecovered(
    matchScans({ positions: room(1, { density: 25 }) }, { positions: misplace(room(2, { density: 25 }), error) }),
    error,
    'sparse cloud',
  )
})

Deno.test('matchScans: recovers across many random placement errors inside the bound', () => {
  const random = rng(2026)
  let tried = 0
  while (tried < 12) {
    const error: Misplacement = {
      yawDeg: (random() * 2 - 1) * 9,
      dx: (random() * 2 - 1) * 0.6,
      dz: (random() * 2 - 1) * 0.6,
    }
    if (centreShiftM(error) > 0.95) continue
    assertRecovered(match(error, room(300 + tried), room(100 + tried)), error, `random case ${tried}`)
    tried++
  }
})

Deno.test('matchScans: a room that is mostly furniture-free in one scan and furnished in the other still lines up', () => {
  const error: Misplacement = { yawDeg: -3, dx: 0.4, dz: 0.3 }
  assertRecovered(match(error, room(2, { boxes: [] })), error, 'unfurnished against furnished')
})

Deno.test('matchScans: moved furniture lowers the overlap it reports but not the answer', () => {
  const error: Misplacement = { yawDeg: 3, dx: 0.35, dz: -0.25 }
  const same = match(error, room(2))
  const moved = match(error, room(2, { boxes: FURNITURE_MOVED }))
  assertRecovered(moved, error, 'furniture moved')
  assert(moved.overlapFraction < same.overlapFraction, 'it noticed that part of the room changed')
  assert(moved.overlapFraction >= MIN_OVERLAP_FRACTION)
  assert(moved.score >= MIN_ACCEPT_SCORE)
})

Deno.test('matchScans: a doorway and an unscanned wall in one scan do not move the answer', () => {
  const error: Misplacement = { yawDeg: 2, dx: -0.3, dz: 0.25 }
  const reference = room(1, { gaps: [{ wall: 'north', from: 2, to: 3 }] })
  const moving = room(2, { boxes: FURNITURE_MOVED })
  const result = match(error, moving, reference)
  assertRecovered(result, error, 'doorway')
})

// ─── Height ──────────────────────────────────────────────────────────────────

Deno.test('matchScans: the height change comes from the two floors, not from the search', () => {
  const error: Misplacement = { yawDeg: 1, dx: 0.2, dz: 0.1, dy: 0.04 }
  const result = match(error, room(2))
  assertRecovered(result, error, 'floors 4 cm apart')
  assertAlmostEquals(result.transform![13]!, -0.04, 0.006)
  assertEquals(result.details.verticalChecked, true)
  assertAlmostEquals(result.boundedCorrection!.dyM, -0.04, 0.006)
})

Deno.test('matchScans: floors a level apart are refused, with the gap named and no transform', () => {
  const result = match({ yawDeg: 0, dx: 0.1, dz: 0.1, dy: 0.5 }, room(2))
  assertEquals(result.status, 'refused')
  assertEquals(result.reason, 'floor-mismatch')
  assertEquals(result.transform, null)
  assertEquals(result.boundedCorrection?.withinBound, false)
  assertAlmostEquals(Math.abs(result.boundedCorrection!.dyM), 0.5, 0.02)
  assert(0.5 > MAX_CORRECTION_DY_M)
})

Deno.test('matchScans: a cloud with no floor of its own needs the caller to say where the floor is, and then claims no height', () => {
  // Walls and nothing horizontal: no layer for a floor, and no tabletop or ceiling to be taken for one.
  const noHorizontals = room(2, { noFloor: true, noCeiling: true, boxes: [] })
  const error: Misplacement = { yawDeg: 2, dx: 0.2, dz: -0.1 }
  const bare = matchScans({ positions: room(1) }, { positions: misplace(noHorizontals, error) })
  assertEquals(bare.reason, 'no-floor')
  assertEquals(bare.transform, null)

  const hinted = matchScans({ positions: room(1) }, { positions: misplace(noHorizontals, error), floorHintY: 0 })
  assertEquals(hinted.status, 'proposed')
  assertEquals(hinted.details.verticalChecked, false)
  assertEquals(hinted.transform![13], 0, 'a hinted floor places the height band and never moves the scan')
})

Deno.test('matchScans: a scan whose only horizontal layer is its ceiling is refused for its floor, not matched at the wrong height', () => {
  // The floor estimate is the lowest well-supported layer. With the floor unseen that is the ceiling, 2.6 m up,
  // and the two floors then disagree by far more than the bound allows.
  const noFloor = room(2, { noFloor: true, boxes: [] })
  const result = matchScans({ positions: room(1) }, { positions: misplace(noFloor, { yawDeg: 1, dx: 0.2, dz: 0.1 }) })
  assertEquals(result.reason, 'floor-mismatch')
  assertEquals(result.transform, null)
})

// ─── Saying no ───────────────────────────────────────────────────────────────

/**
 * A refusal never carries a transform. It also carries a low score, except for one reason: a match that is
 * excellent and simply bigger than the bound allows is refused for its size, and its score is the match's own.
 */
function assertRefused(result: ReturnType<typeof matchScans>, reason: string, label: string): void {
  assertEquals(result.status, 'refused', `${label}: was ${result.status}`)
  assertEquals(result.reason, reason, label)
  assertEquals(result.transform, null, `${label}: a refusal carries no transform`)
  if (reason !== 'correction-too-large') assert(result.score < MIN_ACCEPT_SCORE, `${label}: score ${result.score}`)
}

Deno.test('matchScans: two different rooms return a low score and no transform', () => {
  const elsewhere = makeRoom({ width: 5, depth: 3, centre: { x: 9, z: 7 }, noiseM: 0.02, seed: 5 })
  const result = matchScans({ positions: room(1) }, { positions: elsewhere })
  assertRefused(result, 'low-overlap', 'different room')
  assert(result.overlapFraction < MIN_OVERLAP_FRACTION)
})

Deno.test('matchScans: the same room scanned from the far end, sharing a sliver, is low overlap', () => {
  const shifted = makeRoom({ ...ROOM, centre: { x: 3 + 4.5, z: 2 }, noiseM: 0.02, seed: 7 })
  assertRefused(matchScans({ positions: room(1) }, { positions: shifted }), 'low-overlap', 'shifted by 4.5 m')
})

Deno.test('matchScans: a corridor, whose walls fix the sideways position and not the position along it, is ambiguous', () => {
  const corridor = { width: 2, depth: 18, centre: { x: 1, z: 9 }, noiseM: 0.02 }
  const error: Misplacement = { yawDeg: 1, dx: 0.1, dz: 0.5 }
  for (const unscanned of [['north', 'south'], []] as const) {
    const reference = makeRoom({ ...corridor, seed: 11, unscanned: [...unscanned] })
    const moving = misplace(makeRoom({ ...corridor, seed: 12, unscanned: [...unscanned] }), error)
    const result = matchScans({ positions: reference }, { positions: moving })
    assertRefused(result, 'ambiguous', `corridor with ${unscanned.length === 0 ? '' : 'no '}end walls`)
    assert(result.details.distinctiveness < 0.3)
  }
})

Deno.test('matchScans: two parallel walls, and a single wall, are ambiguous however well they line up', () => {
  const error: Misplacement = { yawDeg: 3, dx: 0.3, dz: -0.2 }
  // No furniture in the new scan: with it, the boxes would pin the position and the match would be a fair one.
  assertRefused(match(error, room(2, { unscanned: ['east', 'west'], boxes: [] })), 'ambiguous', 'two parallel walls')
  assertRefused(match(error, room(2, { unscanned: ['east', 'west', 'south'], boxes: [] })), 'ambiguous', 'one wall')
})

Deno.test('matchScans: a square room, searched through a full turn, fits at four turns and is ambiguous', () => {
  const square = { width: 4, depth: 4, centre: { x: 2, z: 2 }, noiseM: 0.01 }
  const reference = makeRoom({ ...square, seed: 1 })
  const moving = misplace(makeRoom({ ...square, seed: 2 }), { yawDeg: 0, dx: 0.1, dz: 0.1 })
  // Inside the usual 10 degree bound the quarter-turn fits are out of reach, and the room has one right place.
  const bounded = matchScans({ positions: reference }, { positions: moving })
  assertEquals(bounded.status, 'proposed')
  // What it proposes is the small move there is, never the quarter turn the square also fits.
  assert(Math.abs(bounded.boundedCorrection!.yawDeg) < 1 && bounded.boundedCorrection!.translationM < 0.3, JSON.stringify(bounded.boundedCorrection))
  // Allowed to turn any amount, the four fits are as good as each other and none can be preferred.
  const open = matchScans({ positions: reference }, { positions: moving }, { maxYawDeg: 180 })
  assertRefused(open, 'ambiguous', 'square room, full turn')
  assert(open.details.peakRatio > 0.9, `a second place fits ${open.details.peakRatio} as well`)
})

Deno.test('matchScans: walls that agree only to within a hand\'s width are a loose fit, not a proposal', () => {
  // The same room, but every wall sits 7.5 cm further out than in the reference: a difference in size, which no
  // move of the whole scan can take away. Everything still lines up within the gate; none of it lines up closely.
  const reference = makeRoom({ ...ROOM, noiseM: 0.01, seed: 1 })
  const larger = makeRoom({ width: ROOM.width + 0.15, depth: ROOM.depth + 0.15, centre: ROOM.centre, noiseM: 0.01, seed: 2 })
  const result = matchScans({ positions: reference }, { positions: misplace(larger, { yawDeg: 1, dx: 0.2, dz: 0.1 }) })
  assertRefused(result, 'loose-fit', 'a room 15 cm bigger')
  assert(result.overlapFraction >= MIN_OVERLAP_FRACTION, 'it overlaps; it is the closeness that fails')
  assert(result.inlierResidualM! > MAX_INLIER_RESIDUAL_M)
})

Deno.test('matchScans: a correction beyond the bound is refused with its size, never offered', () => {
  const far: Misplacement = { yawDeg: 0, dx: 1.35, dz: 0 }
  assert(centreShiftM(far) > MAX_CORRECTION_TRANSLATION_M)
  const result = match(far, room(2))
  assertRefused(result, 'correction-too-large', 'metre and a third')
  // It matched perfectly; it is the size that is refused, and the size is reported.
  assert(result.overlapFraction > 0.9)
  assertEquals(result.boundedCorrection?.withinBound, false)
  assertAlmostEquals(result.boundedCorrection!.translationM, 1.35, 0.06)
  assertEquals(result.boundedCorrection!.bound.translationM, MAX_CORRECTION_TRANSLATION_M)

  const turned = match({ yawDeg: 14, dx: 0, dz: 0 }, room(2))
  assertEquals(turned.reason, 'correction-too-large')
  assertEquals(turned.transform, null)
  assertAlmostEquals(turned.boundedCorrection!.yawDeg, -14, 1)
  assertEquals(turned.boundedCorrection!.bound.yawDeg, MAX_CORRECTION_YAW_DEG)
})

Deno.test('matchScans: the bound is the gate, so a caller that widens it gets the same match proposed', () => {
  const far: Misplacement = { yawDeg: 0, dx: 1.35, dz: 0 }
  const refused = match(far, room(2))
  const widened = matchScans(
    { positions: room(1) },
    { positions: misplace(room(2), far) },
    { maxTranslationM: 2 },
  )
  assertEquals(refused.status, 'refused')
  assertEquals(widened.status, 'proposed')
  assertRecovered(widened, far, 'widened bound')
})

// ─── Second fits that are not the answer ─────────────────────────────────────

/** A long room of identical pilasters every `period` metres on both walls, the ends not scanned: the position along it repeats. */
function colonnade(period: number, seed: number): Float32Array {
  const boxes: Box[] = []
  for (let x = 0.5; x < 14; x += period) {
    boxes.push({ x, z: 0.25, w: 0.4, d: 0.4, h: 2.0 }, { x, z: 2.75, w: 0.4, d: 0.4, h: 2.0 })
  }
  return makeRoom({ width: 14, depth: 3, centre: { x: 7, z: 1.5 }, noiseM: 0.01, seed, boxes, unscanned: ['east', 'west'] })
}

Deno.test('matchScans: pilasters that repeat inside the bound make the position ambiguous, and ones that repeat beyond it do not', () => {
  const error: Misplacement = { yawDeg: 1, dx: 0.1, dz: 0.05 }
  // Every 0.8 m: the scan fits as well one pilaster along, inside the one metre the correction may move.
  const close = matchScans({ positions: colonnade(0.8, 1) }, { positions: misplace(colonnade(0.8, 2), error) })
  assertRefused(close, 'ambiguous', 'pilasters every 0.8 m')
  assert(close.details.peakRatio > 0.9, `a second place fits ${close.details.peakRatio} as well`)

  // Every 1.6 m: the repeat is inside the search window and beyond the bound. A move that long would be refused as
  // too large, so it cannot be what the right answer is mistaken for, and the right answer stands.
  const far = matchScans({ positions: colonnade(1.6, 1) }, { positions: misplace(colonnade(1.6, 2), error) })
  assertEquals(far.status, 'proposed', String(far.reason))
  assert(far.details.searchedTranslationM > 1.6, 'the repeat was inside the window')
  assert(far.details.peakRatio < 0.3, `nothing inside the bound competes: ${far.details.peakRatio}`)
  assertAlmostEquals(far.boundedCorrection!.translationM, Math.hypot(error.dx, error.dz), 0.06)
})

Deno.test('matchScans: a turn that fits as well beyond the bound, though inside the search window, does not make the answer ambiguous', () => {
  // Twelve teeth: the plan fits itself at every 30 degrees and pins the turn to a few degrees at each.
  const star = (seed: number) => makePolygonRoom({ points: 12, radius: 3.2, innerRadius: 2.2, centre: { x: 3, z: 3 }, noiseM: 0.01, seed })
  const error: Misplacement = { yawDeg: 2, dx: 0.1, dz: -0.1 }
  const bounded = matchScans({ positions: star(1) }, { positions: misplace(star(2), error) })
  assertEquals(bounded.status, 'proposed', String(bounded.reason))
  assert(bounded.details.searchedYawDeg > 30, 'the 30 degree repeat was inside the window')
  assert(bounded.details.peakRatio < 0.3, `${bounded.details.peakRatio}`)
  assertAlmostEquals(bounded.boundedCorrection!.yawDeg, -2, 0.6)
  // Let the bound reach that far and the repeat is a real competitor.
  const open = matchScans({ positions: star(1) }, { positions: misplace(star(2), error) }, { maxYawDeg: 40 })
  assertRefused(open, 'ambiguous', 'the same star with a 40 degree bound')
  assert(open.details.peakRatio > 0.9)
})

// ─── Specks ──────────────────────────────────────────────────────────────────

/** `count` single points one metre up, `gapCells` 5 cm cells apart along x, each in a cell of its own. */
function chainOfSinglePoints(count: number, gapCells: number): Float32Array {
  const points: number[] = []
  for (let i = 0; i < count; i++) points.push((i * gapCells + 0.5) * 0.05, 1.0, 0.525)
  return new Float32Array(points)
}

Deno.test('extractWallCells: a cell with a neighbour within two cells stays, however few points it holds, and an isolated one goes', () => {
  assertEquals(extractWallCells(chainOfSinglePoints(20, 1), 0).n, 20, 'touching cells: a wall sampled sparsely is a chain')
  assertEquals(extractWallCells(chainOfSinglePoints(10, 2), 0).n, 10, 'one empty cell between them is still a chain')
  assertEquals(extractWallCells(chainOfSinglePoints(10, 3), 0).n, 0, 'two empty cells between them is a scatter of specks')
})

Deno.test('extractWallCells: an isolated cell that holds two points is kept, and one that holds one is not', () => {
  assertEquals(extractWallCells(new Float32Array([40.01, 1, 40.01, 40.02, 1.1, 40.02]), 0).n, 1)
  assertEquals(extractWallCells(new Float32Array([40.01, 1, 40.01]), 0).n, 0)
})

// ─── What counts as lined up ─────────────────────────────────────────────────

Deno.test('matchScans: walls a quarter of a metre apart do not line up, so a room half a metre bigger overlaps little and is refused for it', () => {
  // Every wall of the bigger room sits 25 cm outside the smaller one's at the best position. The gate is 15 cm.
  const reference = makeRoom({ ...ROOM, noiseM: 0.01, seed: 1 })
  const bigger = makeRoom({ width: ROOM.width + 0.5, depth: ROOM.depth + 0.5, centre: ROOM.centre, noiseM: 0.01, seed: 2 })
  const result = matchScans({ positions: reference }, { positions: misplace(bigger, { yawDeg: 1, dx: 0.2, dz: 0.1 }) })
  assertRefused(result, 'low-overlap', 'a room 50 cm bigger')
  assert(result.overlapFraction < MIN_OVERLAP_FRACTION, `${result.overlapFraction}`)
})

Deno.test('matchScans: the gap it reports is the smaller scan\'s walls against the other\'s, so a shelf in front of a wall in one scan is not a gap', () => {
  // The earlier scan has a bookcase 12 cm in front of a wall; the new scan, bare, sees only the wall. The shelf's
  // face is a hand's width from a wall that is there, but it is nothing the bare scan's walls fail to line up with.
  const shelved = makeRoom({ ...ROOM, noiseM: 0.01, seed: 1, boxes: [{ x: 3, z: 0.06 + 0.12, w: 5, d: 0.12, h: 1.8 }] })
  const bare = makeRoom({ ...ROOM, noiseM: 0.01, seed: 2 })
  const error: Misplacement = { yawDeg: 2, dx: 0.2, dz: -0.1 }
  const there = matchScans({ positions: shelved }, { positions: misplace(bare, error) })
  const back = matchScans({ positions: misplace(bare, error) }, { positions: shelved })
  for (const [label, result] of [['bare is new', there], ['bare is earlier', back]] as const) {
    assertEquals(result.status, 'proposed', `${label}: ${result.reason}`)
    assert(result.inlierResidualM !== null && result.inlierResidualM < 0.025, `${label}: gap ${result.inlierResidualM}`)
  }
  assertAlmostEquals(there.inlierResidualM!, back.inlierResidualM!, 0.003)
})

// ─── Which refusal comes first ───────────────────────────────────────────────

Deno.test('matchScans: a position that is both unpinned and beyond the bound is refused for its size', () => {
  // Two parallel walls fit anywhere along their length. Slid 1.35 m along it, the best fit is 1.35 m from where the
  // scan is: "a bigger move than this check allows" is the useful thing to say, not "more than one position fits".
  const reference = room(1)
  const walls = room(2, { unscanned: ['east', 'west'], boxes: [] })
  const result = matchScans({ positions: reference }, { positions: misplace(walls, { yawDeg: 0, dx: 1.35, dz: 0 }) })
  assertEquals(result.reason, 'correction-too-large')
  assertEquals(result.transform, null)
  assertEquals(result.details.distinctiveness, 0, 'it was unpinned as well')
  assertAlmostEquals(result.boundedCorrection!.translationM, 1.35, 0.1)
})

// ─── Honest numbers, honest inputs ───────────────────────────────────────────

Deno.test('matchScans: the same two scans give the same answer every time, whatever order their points arrive in', () => {
  const error: Misplacement = { yawDeg: -4, dx: 0.4, dz: 0.2 }
  const reference = room(1)
  const moving = misplace(room(2, { boxes: FURNITURE_MOVED }), error)
  const first = matchScans({ positions: reference }, { positions: moving })
  assertEquals(matchScans({ positions: reference }, { positions: moving }), first)

  // The same points, shuffled: a cloud has no order, so the answer must not have one.
  const shuffled = (points: Float32Array, seed: number): Float32Array => {
    const count = points.length / 3
    const order = Array.from({ length: count }, (_, i) => i)
    const random = rng(seed)
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    const out = new Float32Array(points.length)
    order.forEach((from, to) => out.set(points.subarray(from * 3, from * 3 + 3), to * 3))
    return out
  }
  const again = matchScans({ positions: shuffled(reference, 1) }, { positions: shuffled(moving, 2) })
  assertEquals(again, first)
})

Deno.test('matchScans: empty, tiny and non-finite clouds are refusals, not crashes', () => {
  const good = room(1)
  const empty = new Float32Array(0)
  assertRefused(matchScans({ positions: empty }, { positions: good }), 'no-floor', 'empty reference')
  assertRefused(matchScans({ positions: good }, { positions: empty }), 'no-floor', 'empty new scan')

  const bad = new Float32Array(good)
  for (let i = 0; i < bad.length; i += 7) bad[i] = Number.NaN
  assert(['proposed', 'refused'].includes(matchScans({ positions: good }, { positions: bad }).status))

  // Fifty points on a floor and a wall too short to matter: a floor, and no shape to match.
  const sliver = makeRoom({ width: 1, depth: 1, noiseM: 0, density: 8, noCeiling: true, seed: 3 })
  assertRefused(matchScans({ positions: good }, { positions: sliver }), 'too-few-points', 'a sliver of a scan')
})

Deno.test('matchScans: stray points far from anything do not stretch the search or stop the match', () => {
  const random = rng(77)
  const withStrays = (points: Float32Array): Float32Array => {
    const strays: number[] = []
    for (let i = 0; i < 60; i++) strays.push((random() * 2 - 1) * 60, 0.3 + random() * 1.5, (random() * 2 - 1) * 60)
    const out = new Float32Array(points.length + strays.length)
    out.set(points)
    out.set(strays, points.length)
    return out
  }
  const error: Misplacement = { yawDeg: 2, dx: 0.3, dz: 0.2 }
  const result = matchScans({ positions: withStrays(room(1)) }, { positions: withStrays(misplace(room(2), error)) })
  assertRecovered(result, error, 'with strays')
})

Deno.test('matchScans: a large dense scan is matched in seconds, and just as accurately', () => {
  // 14 x 10 m at 400 points per square metre is about 160 000 points, the order of a long walkthrough's cloud.
  const hall = { width: 14, depth: 10, centre: { x: 7, z: 5 } } as const
  const reference = makeRoom({ ...hall, noiseM: 0.02, density: 400, seed: 21, boxes: FURNITURE })
  const error: Misplacement = { yawDeg: -2, dx: 0.3, dz: 0.25 }
  const moving = misplace(makeRoom({ ...hall, noiseM: 0.02, density: 400, seed: 22, boxes: FURNITURE_MOVED }), error)
  assert(reference.length / 3 > 100_000, `${reference.length / 3} points`)

  const started = performance.now()
  const result = matchScans({ positions: reference }, { positions: moving })
  const elapsedMs = performance.now() - started

  assertEquals(result.status, 'proposed', String(result.reason))
  const recovered = recoveryError(result.transform!, error, corners(hall))
  assert(recovered.positionM < 0.05 && Math.abs(recovered.yawDeg) < 1, `${recovered.positionM} m, ${recovered.yawDeg} deg`)
  // The matcher shares one thread with the upload routes. A second or so is expected here; this only catches a
  // search that has gone quadratic in the points, with a wide margin for a slow machine.
  assert(elapsedMs < 20_000, `took ${Math.round(elapsedMs)} ms`)
})

Deno.test('matchScans: reports the thresholds it used, and they are the named constants', () => {
  const params = matchParams()
  assertEquals(params['maxCorrectionTranslationM'], MAX_CORRECTION_TRANSLATION_M)
  assertEquals(params['maxCorrectionYawDeg'], MAX_CORRECTION_YAW_DEG)
  assertEquals(params['minOverlapFraction'], MIN_OVERLAP_FRACTION)
  assertEquals(params['minAcceptScore'], MIN_ACCEPT_SCORE)
  assertEquals(params['floorHintToleranceM'], FLOOR_HINT_TOLERANCE_M)
  assertEquals(params['roleSpreadRatio'], 1.25)
  assertEquals(matchParams({ maxTranslationM: 3 })['maxCorrectionTranslationM'], 3)
  assert(UNIQUE_REACH_M < AMBIGUOUS_REACH_M)
})

// ─── Which scan is which ─────────────────────────────────────────────────────

/** A walk through three rooms eight metres apart or more, with no wall shared or in line. The first is `room(seed)`. */
function walkThroughThreeRooms(seed: number): Float32Array {
  return concatClouds(
    room(seed),
    makeRoom({ width: 5, depth: 5, centre: { x: 15, z: 3 }, noiseM: 0.02, seed: seed + 100, boxes: [{ x: 14, z: 2, w: 0.9, d: 0.7, h: 1.1 }] }),
    makeRoom({ width: 4, depth: 6, centre: { x: 25, z: -3 }, noiseM: 0.02, seed: seed + 200 }),
  )
}

Deno.test('matchScans: a walk through three rooms against a scan of one of them is proposed, whichever scan is the new one', () => {
  const error: Misplacement = { yawDeg: 3, dx: 0.35, dz: -0.25 }
  const earlier = room(9)
  const walk = misplace(walkThroughThreeRooms(2), error)

  // The job's way round: the walk is the new scan and the earlier scan is one room of it. Judged by the far side of
  // the house, a perfect match of that one room is "ambiguous" or "too large"; judged by the room it shares, it is
  // as clear as two scans of one room.
  const asNew = matchScans({ positions: earlier }, { positions: walk })
  assertRecovered(asNew, error, 'the walk is the new scan')
  assert(asNew.overlapFraction > 0.9, `the one room is fully explained by the walk: ${asNew.overlapFraction}`)
  // Each share is reported against its own scan, though the search turned the earlier scan: most of the walk is
  // rooms the earlier scan never saw, and the one room is wholly there.
  assert(asNew.details.movingMatchedFraction < 0.5, `the walk's share: ${asNew.details.movingMatchedFraction}`)
  assert(asNew.details.referenceMatchedFraction > 0.9, `the room's share: ${asNew.details.referenceMatchedFraction}`)

  // The other way round: the walk is the earlier scan and the one-room scan is the new one.
  const asEarlier = matchScans({ positions: walk }, { positions: earlier })
  assertEquals(asEarlier.status, 'proposed', String(asEarlier.reason))
  // The two answers are the same move seen from either side: one undoes the other over the room they share.
  const there = recoveryError(multiplyMat4(asEarlier.transform!, asNew.transform!), { yawDeg: 0, dx: 0, dz: 0 }, corners(ROOM))
  assert(there.positionM < 0.05 && Math.abs(there.yawDeg) < 1, `${there.positionM} m, ${there.yawDeg} deg`)
  // And they report the same measurements: how far the shared part moves, and how closely it lines up.
  assertAlmostEquals(asEarlier.boundedCorrection!.translationM, asNew.boundedCorrection!.translationM, 0.03)
  assertAlmostEquals(asEarlier.boundedCorrection!.yawDeg, -asNew.boundedCorrection!.yawDeg, 0.3)
  assertAlmostEquals(asEarlier.overlapFraction, asNew.overlapFraction, 0.03)
  assertAlmostEquals(asEarlier.inlierResidualM!, asNew.inlierResidualM!, 0.005)
  // The shares follow the scans, not the roles of the search.
  assertAlmostEquals(asEarlier.details.movingMatchedFraction, asNew.details.referenceMatchedFraction, 0.03)
  assertAlmostEquals(asEarlier.details.referenceMatchedFraction, asNew.details.movingMatchedFraction, 0.03)
})

Deno.test('matchScans: the share of each scan that lines up is counted over that scan\'s own cells, however thick the other scan\'s walls are', () => {
  // The earlier scan is one room scanned noisily, so its walls are several cells thick. The new scan is a walk through
  // three rooms scanned cleanly. The room is about a third of the walk's walls, whatever its noisy twin's cell count.
  const error: Misplacement = { yawDeg: 2, dx: 0.3, dz: -0.2 }
  const noisy = room(9, { noiseM: 0.05 })
  const result = matchScans({ positions: noisy }, { positions: misplace(walkThroughThreeRooms(2), error) })
  assertRecovered(result, error, 'a noisy earlier scan')
  assert(result.details.movingMatchedFraction > 0.3 && result.details.movingMatchedFraction < 0.45, `the walk's share: ${result.details.movingMatchedFraction}`)
  assert(result.details.referenceMatchedFraction > 0.95, `the room's share: ${result.details.referenceMatchedFraction}`)
  assert(result.overlapFraction <= 1)
})

Deno.test('matchScans: a scan that reaches too far to search is refused as too large, unless the other scan is the narrow one that turns', () => {
  // Two rooms 55 m apart in one cloud: the farthest cells are about 30 m from its centre, past the 25 m a scan may
  // reach, though not so far that the grid the search needs would be refused for its size instead.
  const twoFarRooms = (seed: number) =>
    concatClouds(room(seed), makeRoom({ ...ROOM, centre: { x: 3 + 55, z: 2 }, noiseM: 0.02, seed: seed + 50 }))
  const error: Misplacement = { yawDeg: 2, dx: 0.3, dz: -0.2 }
  const both = matchScans({ positions: twoFarRooms(1) }, { positions: misplace(twoFarRooms(2), error) })
  assertRefused(both, 'too-large', 'two scans that both reach 30 m')

  // Against a scan of one room, the one room is what turns, and its reach is that of a room.
  const asNew = matchScans({ positions: room(9) }, { positions: misplace(twoFarRooms(2), error) })
  assertRecovered(asNew, error, 'a 55 m walk against one room')
})

Deno.test('matchScans: the same pair of one-room scans gives the same verdict and the inverse move in either order', () => {
  const random = rng(515)
  for (let i = 0; i < 6; i++) {
    const error: Misplacement = { yawDeg: (random() * 2 - 1) * 8, dx: (random() * 2 - 1) * 0.5, dz: (random() * 2 - 1) * 0.5 }
    const first = room(40 + i)
    const second = misplace(room(60 + i, { boxes: FURNITURE_MOVED }), error)
    const forward = matchScans({ positions: first }, { positions: second })
    const backward = matchScans({ positions: second }, { positions: first })
    assertEquals(backward.status, forward.status, `case ${i}`)
    assertEquals(backward.reason, forward.reason, `case ${i}`)
    assertEquals(forward.status, 'proposed', `case ${i}: ${forward.reason}`)
    const undone = recoveryError(multiplyMat4(backward.transform!, forward.transform!), { yawDeg: 0, dx: 0, dz: 0 }, corners(ROOM))
    assert(undone.positionM < 0.04 && Math.abs(undone.yawDeg) < 0.6, `case ${i}: ${undone.positionM} m, ${undone.yawDeg} deg`)
    assertAlmostEquals(backward.score, forward.score, 0.05, `case ${i}`)
  }
})

Deno.test('matchScans: two scans that reach about as far leave the turning to the one with fewer cells, so a partial scan is judged the same either way', () => {
  // Two parallel walls against the full furnished room: nearly the same reach, very different cell counts.
  const error: Misplacement = { yawDeg: 3, dx: 0.3, dz: -0.2 }
  const partial = room(2, { unscanned: ['east', 'west'], boxes: [] })
  const full = room(1)
  const there = matchScans({ positions: full }, { positions: misplace(partial, error) })
  const back = matchScans({ positions: misplace(partial, error) }, { positions: full })
  assertRefused(there, 'ambiguous', 'partial as the new scan')
  assertRefused(back, 'ambiguous', 'partial as the earlier scan')
  assertAlmostEquals(there.details.distinctiveness, back.details.distinctiveness, 0.05)
})

Deno.test('matchScans: a scan that reaches far but holds little wall still leaves the narrow scan to turn, whichever scan is new', () => {
  // The earlier scan is the whole furnished room. The other is a corner of it (two walls) and two stubs of wall more
  // than 20 m away, seen down a corridor and through a doorway: it reaches 25 m, and it has fewer cells than the room.
  // The cell count alone would have it turn; the reach is what makes the room the one that does.
  const error: Misplacement = { yawDeg: 3, dx: 0.3, dz: -0.2 }
  const stub = (x: number, z: number, seed: number) =>
    makeRoom({ width: 2, depth: 6, centre: { x, z }, noiseM: 0.02, seed, unscanned: ['south', 'east', 'west'], noFloor: true, noCeiling: true })
  const wide = concatClouds(
    room(2, { unscanned: ['east', 'south'], boxes: [] }),
    stub(23, -17, 71),
    stub(-17, 25, 72),
  )
  const full = room(1)
  assert(extractWallCells(wide, 0).n < extractWallCells(full, 0).n, 'the wide scan has fewer cells')

  const asNew = matchScans({ positions: full }, { positions: misplace(wide, error) })
  assertRecovered(asNew, error, 'the wide scan is the new one')
  const asEarlier = matchScans({ positions: misplace(wide, error) }, { positions: full })
  assertEquals(asEarlier.status, 'proposed', String(asEarlier.reason))
  const undone = recoveryError(multiplyMat4(asEarlier.transform!, asNew.transform!), { yawDeg: 0, dx: 0, dz: 0 }, corners(ROOM))
  assert(undone.positionM < 0.05 && Math.abs(undone.yawDeg) < 1, `${undone.positionM} m, ${undone.yawDeg} deg`)
})

Deno.test('invertYawTranslation: undoes what yawTranslationMatrix did, height included', () => {
  const m = yawTranslationMatrix(0.4, 1.5, -0.2, 3)
  const identity = multiplyMat4(invertYawTranslation(m), m)
  const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  identity.forEach((value, i) => assertAlmostEquals(value, expected[i]!, 1e-12))
})

// ─── Floors ──────────────────────────────────────────────────────────────────

/** A big low platform (a dais, a stage, a deck) in a room whose own floor was barely seen. */
const PLATFORM = (height: number): Box[] => [{ x: 2.6, z: 1.6, w: 4, d: 2.5, h: height }]

Deno.test('estimateFloor: the calibration\'s promise is the check on a layer, not only the fallback', () => {
  // Only a 20 cm platform and the ceiling are horizontal layers: the lowest well-supported one is the platform.
  const points = makeRoom({ ...ROOM, noiseM: 0.01, seed: 4, noFloor: true, boxes: PLATFORM(0.2) })
  const alone = estimateFloor(points)
  assert(alone && alone.fromCloud)
  assertAlmostEquals(alone.y, 0.2, 0.01)

  // The calibration says the floor is at 0: a layer 20 cm above it is not one, and the promise stands in.
  const checked = estimateFloor(points, 0)
  assert(checked && !checked.fromCloud)
  assertEquals(checked.y, 0)
  assertAlmostEquals(checked.cloudLayerY!, 0.2, 0.01)
  assertEquals(floorSourceOf(checked), 'hint-over-cloud')

  // A layer within the tolerance of the promise is the floor, as measured, and the promise changes nothing.
  const near = estimateFloor(points, 0.2 - FLOOR_HINT_TOLERANCE_M + 0.02)
  assert(near && near.fromCloud)
  assertAlmostEquals(near.y, 0.2, 0.01)
  assertEquals(floorSourceOf(near), 'cloud')
  // Just past the tolerance it is not.
  assertEquals(estimateFloor(points, 0.2 - FLOOR_HINT_TOLERANCE_M - 0.02)!.fromCloud, false)

  // No layer at all is the plain fallback, and says so.
  const bare = estimateFloor(new Float32Array(30), 0.3)
  assertEquals(bare, { y: 0.3, fromCloud: false })
  assertEquals(floorSourceOf(bare!), 'hint')
})

Deno.test('matchScans: a platform standing in for a barely seen floor moves nothing vertically when the calibration says where the floor is', () => {
  const error: Misplacement = { yawDeg: 2, dx: 0.25, dz: -0.2 }
  // The new scan saw its floor at 3 points a square metre and the 20 cm platform well: the lowest layer with enough
  // points is the platform. The true height error is nothing.
  const sparse = (extra: Partial<RoomSpec> = {}) =>
    room(2, { density: 40, floorDensity: 3, boxes: [...FURNITURE, ...PLATFORM(0.2)], ...extra })
  const moving = misplace(sparse(), error)

  // Without the promise, the platform is believed and the scan is told to sink 20 cm. That was the defect.
  const believed = matchScans({ positions: room(1) }, { positions: moving })
  assertEquals(believed.details.floors?.moving, 'cloud')
  assertAlmostEquals(believed.boundedCorrection!.dyM, -0.2, 0.03)

  // With it, the platform is not a floor. The horizontal answer is as good as ever and no height claim is made.
  const result = matchScans({ positions: room(1), floorHintY: 0 }, { positions: moving, floorHintY: 0 })
  assertRecovered(result, error, 'platform for a floor')
  assertEquals(result.transform![13], 0)
  assertEquals(result.details.verticalChecked, false)
  assertEquals(result.details.floors, { reference: 'cloud', moving: 'hint-over-cloud' })
  assertEquals(result.boundedCorrection!.dyM, 0)
})

Deno.test('matchScans: with the calibration\'s promise, a ceiling taken for a missing floor does not refuse the pair', () => {
  const error: Misplacement = { yawDeg: 1, dx: 0.2, dz: 0.1 }
  const noFloor = misplace(room(2, { noFloor: true, boxes: [] }), error)
  // Alone, the only horizontal layer is the ceiling, 2.6 m up, and the floors disagree by far more than the bound.
  assertEquals(matchScans({ positions: room(1) }, { positions: noFloor }).reason, 'floor-mismatch')
  // The calibration says the floor is at 0, and the ceiling is nowhere near it.
  const hinted = matchScans({ positions: room(1), floorHintY: 0 }, { positions: noFloor, floorHintY: 0 })
  assertRecovered(hinted, error, 'ceiling for a floor')
  assertEquals(hinted.details.floors?.moving, 'hint-over-cloud')
  assertEquals(hinted.details.verticalChecked, false)
})

Deno.test('matchScans: floors both seen and both near the promise still give a height change, measured', () => {
  const error: Misplacement = { yawDeg: 1, dx: 0.2, dz: 0.1, dy: 0.05 }
  const result = matchScans({ positions: room(1), floorHintY: 0 }, { positions: misplace(room(2), error), floorHintY: 0 })
  assertRecovered(result, error, 'floors 5 cm apart, promise 0')
  assertEquals(result.details.floors, { reference: 'cloud', moving: 'cloud' })
  assertEquals(result.details.verticalChecked, true)
  assertAlmostEquals(result.transform![13]!, -0.05, 0.006)
})

// ─── Rooms that cannot touch ─────────────────────────────────────────────────

Deno.test('matchScans: scans whose footprints cannot meet anywhere in the search are turned away without a search', () => {
  const far = makeRoom({ width: 6, depth: 4, centre: { x: 63, z: 42 }, noiseM: 0.02, seed: 8 })
  const started = performance.now()
  const result = matchScans({ positions: room(1) }, { positions: far })
  const elapsedMs = performance.now() - started
  assertRefused(result, 'low-overlap', 'rooms 60 m apart')
  assertEquals(result.overlapFraction, 0)
  assertEquals(result.details.searchedTranslationM, 0, 'no search ran')
  assertEquals(result.details.movingCells > 100 && result.details.referenceCells > 100, true, 'it still says how many cells it saw')
  assert(elapsedMs < 5_000, `took ${Math.round(elapsedMs)} ms`)
})

Deno.test('matchScans: footprints four metres apart are still searched, because the far cells of a turned scan travel that far', () => {
  const apart = makeRoom({ ...ROOM, centre: { x: 3 + 6 + 4, z: 2 }, noiseM: 0.02, seed: 10 })
  const result = matchScans({ positions: room(1) }, { positions: apart })
  assertRefused(result, 'low-overlap', 'footprints 4 m apart')
  assert(result.details.searchedTranslationM > 0, 'the search ran')
})

Deno.test('matchScans: scans near enough for the search to reach one another are searched, and refused on what the search found', () => {
  // Footprints 0.8 m apart: more than the bound, less than the window plus a turn, so the search runs.
  const near = makeRoom({ ...ROOM, centre: { x: 3 + 6.8, z: 2 }, noiseM: 0.02, seed: 9 })
  const result = matchScans({ positions: room(1) }, { positions: near })
  assertRefused(result, 'low-overlap', 'footprints 0.8 m apart')
  assert(result.details.searchedTranslationM > 0, 'the search ran')
})

// ─── The parts ───────────────────────────────────────────────────────────────

Deno.test('estimateFloor: finds the lowest well-supported layer, not a tabletop and not a stray', () => {
  const points = makeRoom({ ...ROOM, noiseM: 0.01, seed: 4, floorY: 0.12, boxes: [{ x: 3, z: 2, w: 3, d: 2, h: 0.75 }] })
  const floor = estimateFloor(points)
  assert(floor && floor.fromCloud)
  assertAlmostEquals(floor.y, 0.12, 0.01)

  assertEquals(estimateFloor(new Float32Array(30), undefined), null, 'too few points to say')
  assertEquals(estimateFloor(new Float32Array(30), 0.5), { y: 0.5, fromCloud: false })
})

Deno.test('extractWallCells: keeps the band between 0.3 and 2.0 m above the floor, drops specks, and ignores point order', () => {
  const points = makeRoom({ ...ROOM, noiseM: 0, seed: 6 })
  const cells = extractWallCells(points, 0)
  assert(cells.n > 200)
  // Ceiling (2.6 m) and floor (0 m) never reach the grid, so every cell sits on or inside a wall line.
  for (let i = 0; i < cells.n; i++) {
    assert(cells.x[i]! >= 0 - 0.06 && cells.x[i]! <= 6 + 0.06 && cells.z[i]! >= 0 - 0.06 && cells.z[i]! <= 4 + 0.06)
  }
  // The band is the walls and what stands against them: a floor on its own, and a ceiling on its own, are nothing.
  const bare = { ...ROOM, noiseM: 0, seed: 6, unscanned: ['north', 'south', 'east', 'west'] as RoomSpec['unscanned'] }
  assertEquals(extractWallCells(makeRoom({ ...bare, noCeiling: true }), 0).n, 0, 'floor only')
  assertEquals(extractWallCells(makeRoom({ ...bare, noFloor: true }), 0).n, 0, 'ceiling only')
  // One lone point is a speck, and a wall of points is not.
  const lone = new Float32Array([40, 1, 40])
  assertEquals(extractWallCells(lone, 0).n, 0)
  // Raising the floor to 1.0 m moves the band up with it.
  assertNotEquals(extractWallCells(points, 1.0).n, cells.n)
})

Deno.test('yawTranslationMatrix: is the layout composeYUpTransform uses, and transformPositions applies it the way the editor does', () => {
  const yaw = 0.37
  const mine = yawTranslationMatrix(yaw, 1, 2, 3)
  const theirs = composeYUpTransform({ x: 1, y: 2, z: 3 }, (yaw * 180) / Math.PI, 1)
  mine.forEach((value, i) => assertAlmostEquals(value, theirs[i]!, 1e-12))

  // A point on +Z, turned by 90 degrees about +Y, lands on +X: the right-hand rule about up.
  const turned = transformPositions([0, 0, 1], yawTranslationMatrix(Math.PI / 2, 0, 0, 0))
  assertAlmostEquals(turned[0]!, 1, 1e-6)
  assertAlmostEquals(turned[2]!, 0, 1e-6)
})
