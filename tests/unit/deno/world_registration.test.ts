/**
 * Which way is north, in an AR session? Checked against a physical model
 * (./physical_oracle.ts) that shares no code with the app.
 *
 * The bearing code used to be tested by deriving "truth" through the app's own
 * `composeYUpTransform`, which assumes the same direction of yaw as the code it
 * was checking. `sessionFrameBearingDeg` subtracted the camera's yaw where a
 * right-handed session needs it added, was wrong by twice the turn since the
 * session started, and every test still passed (audit F53).
 *
 * The oracle: a session starts facing true bearing `psi`; the camera then turns
 * LEFT by `phi` (negative is a right turn) and tilts down by some pitch; the
 * compass is perfect. Every property below is asserted over a grid of those, to
 * 1e-6 degrees or tighter:
 *
 *   - the frame bearing recovered from the compass and the pose is the true
 *     bearing of session +Z;
 *   - the AR north tick, drawn as a real `buildAnchorMarker` group, points at
 *     true north;
 *   - the one-point frame has project +Z at true north;
 *   - a two-point frame's `projectBearingDeg` is the true bearing of its
 *     baseline;
 *   - placed in the right-handed scene by a rotation alone, a session lands
 *     exactly where the oracle says, and placed in (east, up, north) by a
 *     rotation alone it cannot (the mirror).
 *
 * The old rule is kept as a regression guard: assertions that it DISAGREES with
 * the oracle, by exactly twice the turn, so the oracle can never quietly lose
 * its ability to tell the two apart.
 *
 * What this does not settle: what a phone's compass reports (which axis of the
 * phone, true or magnetic north, the screen's rotation). That needs the spin
 * test on a device: `?debug=pose` shows the numbers, `compassSpinTerms()`.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import * as THREE from 'three'
import ts from 'typescript'
import {
  BEARING_CONVENTION,
  bearingConventionFromSearch,
  cameraYawInSessionDeg,
  compassSpinTerms,
  composeYUpTransform,
  formatCompassSpin,
  LEGACY_BEARING_CONVENTION,
  northYawInSessionDeg,
  oneTapToProjectTransform,
  projectBearingDeg,
  readableAnchorBearingDeg,
  readableProjectBearingDeg,
  sessionFrameBearingDeg,
  twoPointBearingFields,
  twoPointHeadingDeg,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import { sceneFromEnu, sceneYawForBearingDeg } from '../../../src/world/enu.ts'
import { ANCHOR_RADIUS_M, buildAnchorMarker } from '../../../src/world/anchor-marker.ts'
import {
  angDiff,
  applyColumnMajor,
  bearingOfEnu,
  bearingOfSessionVector,
  cameraRotation,
  cross,
  D2R,
  type Enu,
  enuToSession,
  norm360,
  perfectCompassBearing,
  rotateByQuat,
  rotationDeterminant,
  sessionToEnu,
  trueSessionZBearing,
  type V3,
} from './physical_oracle.ts'

/** Start headings, every 15 degrees. */
const PSI = Array.from({ length: 24 }, (_, i) => i * 15)
/** Degrees turned LEFT since the session started; negative is a right turn. Includes the no-turn and about-face cases. */
const TURNS = [-180, -135, -90, -60, -45, -30, 0, 30, 45, 60, 90, 135, 180]
/**
 * Camera tilt below the horizon: level, a casual hold, the posture used to tap the floor, and two that are nearly
 * straight down. The arithmetic stays exact there (the camera's yaw is read from the horizontal part of its
 * forward vector, which shrinks as the tilt grows); what does not is the pose a phone reports, which is noisy,
 * and what the compass reports for a phone held that way, which no unit test can say.
 */
const DOWN = [0, 25, 60, 80, 85]

interface Case {
  psi: number
  turn: number
  down: number
  /** What a perfect compass reads at the tap. */
  compass: number
  rotation: ReturnType<typeof cameraRotation>
  /** True bearing of session +Z. */
  truth: number
}

const CASES: Case[] = []
for (const psi of PSI) {
  for (const turn of TURNS) {
    for (const down of DOWN) {
      const rotation = cameraRotation(turn, down)
      CASES.push({ psi, turn, down, compass: perfectCompassBearing(psi, rotation), rotation, truth: trueSessionZBearing(psi) })
    }
  }
}

const label = (c: Case) => `psi ${c.psi}, turn ${c.turn}, down ${c.down}`

/** A bearing as it is stored and shown: in [0, 360), never a negative number or a full turn. */
const inBearingRange = (deg: number) => deg >= 0 && deg < 360

/** The rule the app used before it was corrected, written out here so the guard does not depend on a flag. */
function legacySessionFrameBearing(compass: number, rotation: Case['rotation']): number {
  return norm360(compass - cameraYawInSessionDeg(rotation))
}

// ── The oracle itself ───────────────────────────────────────────────────────

Deno.test('oracle: a camera facing north, turned left 90 degrees, faces west; turned right, east', () => {
  assertAlmostEquals(perfectCompassBearing(0, cameraRotation(0)), 0, 1e-9)
  assertAlmostEquals(perfectCompassBearing(0, cameraRotation(90)), 270, 1e-9)
  assertAlmostEquals(perfectCompassBearing(0, cameraRotation(-90)), 90, 1e-9)
  assertAlmostEquals(perfectCompassBearing(90, cameraRotation(0)), 90, 1e-9)
  // Tilting down does not change which way the camera faces.
  assertAlmostEquals(perfectCompassBearing(40, cameraRotation(25, 60)), 15, 1e-9)
})

Deno.test('oracle: a camera tilted down looks at the floor, and tilting changes nothing about which way it faces', () => {
  // "Down" is what the grid's tilt column means (the posture used to tap the floor), so the oracle has to mean it.
  for (const down of [0, 25, 60, 85]) {
    const forward = rotateByQuat(cameraRotation(0, down), { x: 0, y: 0, z: -1 })
    assertAlmostEquals(forward.y, -Math.sin(down * D2R), 1e-12, `down ${down}`)
    assertAlmostEquals(Math.hypot(forward.x, forward.z), Math.cos(down * D2R), 1e-12, `down ${down}`)
  }
})

Deno.test('oracle: session +Z points behind the first view, and the session is right-handed', () => {
  for (const psi of PSI) {
    assertAlmostEquals(angDiff(trueSessionZBearing(psi), psi + 180), 0, 1e-9, `psi ${psi}`)
    // Facing north, the right hand is east: session +X is east at psi 0.
    const x = sessionToEnu(psi, { x: 1, y: 0, z: 0 })
    const y = sessionToEnu(psi, { x: 0, y: 1, z: 0 })
    const z = sessionToEnu(psi, { x: 0, y: 0, z: 1 })
    // (east, north, up) is right-handed (east x north = up), so cross() in those components is the physical cross product.
    const v = (e: Enu): V3 => ({ x: e.east, y: e.north, z: e.up })
    const xy = cross(v(x), v(y))
    assertAlmostEquals(xy.x, z.east, 1e-12, `psi ${psi}: X x Y east`)
    assertAlmostEquals(xy.y, z.north, 1e-12, `psi ${psi}: X x Y north`)
    assertAlmostEquals(xy.z, z.up, 1e-12, `psi ${psi}: X x Y up`)
  }
  assertAlmostEquals(sessionToEnu(0, { x: 1, y: 0, z: 0 }).east, 1, 1e-12)
})

Deno.test('oracle: enuToSession inverts sessionToEnu', () => {
  for (const psi of PSI) {
    const s = { x: 0.7, y: -0.2, z: 1.9 }
    const back = enuToSession(psi, sessionToEnu(psi, s))
    assertAlmostEquals(back.x, s.x, 1e-12)
    assertAlmostEquals(back.y, s.y, 1e-12)
    assertAlmostEquals(back.z, s.z, 1e-12)
  }
})

// ── sessionFrameBearingDeg ──────────────────────────────────────────────────

Deno.test('sessionFrameBearingDeg: recovers the true bearing of session +Z for every start heading, turn and tilt', () => {
  let worst = 0
  for (const c of CASES) {
    const got = sessionFrameBearingDeg(c.compass, c.rotation)!
    const err = Math.abs(angDiff(got, c.truth))
    worst = Math.max(worst, err)
    assert(err < 1e-6, `${label(c)}: got ${got}, truth ${c.truth}`)
    assert(inBearingRange(got), `${label(c)}: ${got} is not a bearing in [0, 360)`)
  }
  assert(worst < 1e-6, `worst error ${worst}`)
  assertEquals(CASES.length, PSI.length * TURNS.length * DOWN.length)
})

Deno.test('regression guard: the old rule (compass minus camera yaw) disagrees with the oracle by exactly twice the turn', () => {
  let disagreeing = 0
  for (const c of CASES) {
    const legacy = legacySessionFrameBearing(c.compass, c.rotation)
    const err = angDiff(legacy, c.truth)
    // Turning left by `turn` lowers the compass by `turn` and raises the camera's session yaw by `turn`, so
    // subtracting the yaw doubles the movement instead of cancelling it.
    assertAlmostEquals(angDiff(err, -2 * c.turn), 0, 1e-6, `${label(c)}: error ${err}`)
    if (Math.abs(err) > 1) disagreeing++
  }
  // It is right only at turn 0 and 180: 2 of the 13 turns in the grid.
  assertEquals(disagreeing, CASES.filter((c) => c.turn !== 0 && Math.abs(c.turn) !== 180).length)
  assert(disagreeing > 500, `the guard must have teeth, only ${disagreeing} cases disagree`)
})

Deno.test('regression guard: ?bearing=1 selects exactly the old rule, and the default does not', () => {
  for (const c of CASES) {
    assertEquals(
      sessionFrameBearingDeg(c.compass, c.rotation, LEGACY_BEARING_CONVENTION),
      legacySessionFrameBearing(c.compass, c.rotation),
      label(c),
    )
    const current = sessionFrameBearingDeg(c.compass, c.rotation, BEARING_CONVENTION)!
    const legacy = sessionFrameBearingDeg(c.compass, c.rotation, LEGACY_BEARING_CONVENTION)!
    if (c.turn !== 0 && Math.abs(c.turn) !== 180) assert(Math.abs(angDiff(current, legacy)) > 1, label(c))
  }
  assertEquals(sessionFrameBearingDeg(100, cameraRotation(0)), sessionFrameBearingDeg(100, cameraRotation(0), BEARING_CONVENTION))
})

Deno.test('sessionFrameBearingDeg: turning on the spot leaves B + yaw where it was and moves B - yaw by twice the turn', () => {
  // The spin test, run on the oracle: the pass criterion for a phone.
  for (const psi of [0, 77, 200]) {
    const start = compassSpinTerms(perfectCompassBearing(psi, cameraRotation(0)), cameraRotation(0))!
    for (const turn of [-90, -30, 45, 90, 180]) {
      const q = cameraRotation(turn)
      const now = compassSpinTerms(perfectCompassBearing(psi, q), q)!
      assertAlmostEquals(angDiff(now.sumDeg, start.sumDeg), 0, 1e-9, `psi ${psi} turn ${turn}: B+yaw`)
      assertAlmostEquals(angDiff(now.differenceDeg, start.differenceDeg), angDiff(-2 * turn, 0), 1e-9, `psi ${psi} turn ${turn}: B-yaw`)
    }
  }
})

Deno.test('sessionFrameBearingDeg: no compass reading, or a pose with no yaw, is null and never a bearing', () => {
  const q = cameraRotation(30)
  assertEquals(sessionFrameBearingDeg(null, q), null)
  assertEquals(sessionFrameBearingDeg(undefined, q), null)
  assertEquals(sessionFrameBearingDeg(Number.NaN, q), null)
  assertEquals(sessionFrameBearingDeg(Number.POSITIVE_INFINITY, q), null)
  assertEquals(sessionFrameBearingDeg(90, { x: Number.NaN, y: 0, z: 0, w: 1 }), null)
  assertEquals(compassSpinTerms(null, q), null)
  assertEquals(compassSpinTerms(undefined, q), null)
  assertEquals(compassSpinTerms(Number.NaN, q), null)
  assertEquals(compassSpinTerms(Number.POSITIVE_INFINITY, q), null)
  assertEquals(compassSpinTerms(90, { x: 0, y: Number.NaN, z: 0, w: 1 }), null)
})

Deno.test('compassSpinTerms and formatCompassSpin: plain numbers, with the rule in force', () => {
  const q = cameraRotation(-90)
  const terms = compassSpinTerms(perfectCompassBearing(0, q), q)!
  assertAlmostEquals(terms.deviceBearingDeg, 90, 1e-9)
  assertAlmostEquals(terms.sumDeg, 180, 1e-9)
  // Every term is a bearing in [0, 360), whatever the compass and the pose add up to: a raw 359 + 90 is 89, a raw
  // 10 - 200 is 170, and a compass reading of -20 is 340.
  for (const [compass, turn] of [[359, -90], [10, 200], [-20, 30], [725, -170], [0, 0]] as const) {
    const t = compassSpinTerms(compass, cameraRotation(turn))!
    for (const [name, value] of Object.entries({ device: t.deviceBearingDeg, sum: t.sumDeg, difference: t.differenceDeg })) {
      assert(inBearingRange(value), `compass ${compass}, turn ${turn}: ${name} ${value} is not in [0, 360)`)
    }
  }
  assertEquals(formatCompassSpin(terms), 'compass 90 · yaw 90 · B+yaw 180 · B-yaw 0 · rule 2')
  // Whole degrees only: bearings that round up to 360 read 0, and a yaw of -0.2 reads 0, never -0.
  const nearNorth = cameraRotation(179.8)
  assertAlmostEquals(cameraYawInSessionDeg(nearNorth), -0.2, 1e-9)
  assertEquals(formatCompassSpin(compassSpinTerms(359.7, nearNorth)), 'compass 0 · yaw 0 · B+yaw 0 · B-yaw 0 · rule 2')
  assertEquals(formatCompassSpin(null), 'compass none · rule 2')
  assertEquals(formatCompassSpin(null, LEGACY_BEARING_CONVENTION), 'compass none · rule 1')
})

Deno.test('formatCompassSpin says how the compass was paired with the camera when it is told, and reads exactly as before when it is not', () => {
  const q = cameraRotation(-90)
  const terms = compassSpinTerms(perfectCompassBearing(0, q), q)!
  const before = formatCompassSpin(terms)
  // Told nothing, null or an empty word: the line is the one it always was.
  for (const via of [undefined, null, '']) assertEquals(formatCompassSpin(terms, 2, via), before)
  for (const via of ['camera', 'top', 'platform']) {
    assertEquals(formatCompassSpin(terms, 2, via), `${before} · via ${via}`)
  }
  // A reading that is withheld has no terms: the line says there is no compass, and why.
  assertEquals(formatCompassSpin(null, 2, 'withheld'), 'compass none · rule 2 · via withheld')
  assertEquals(formatCompassSpin(null, LEGACY_BEARING_CONVENTION, 'withheld'), 'compass none · rule 1 · via withheld')
})

// ── The north tick ──────────────────────────────────────────────────────────

/** The session-space direction a marker's north tick points along, read from the three.js group the app builds. */
function tickDirectionInSession(northYawDeg: number | null): V3 {
  const group = buildAnchorMarker(northYawDeg)
  group.updateMatrixWorld(true)
  const tick = group.children.find((child) => child.name === 'anchor north tick') as THREE.LineSegments
  const pos = tick.geometry.getAttribute('position')
  const base = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(group.matrixWorld)
  const tip = new THREE.Vector3(pos.getX(1), pos.getY(1), pos.getZ(1)).applyMatrix4(group.matrixWorld)
  return { x: tip.x - base.x, y: tip.y - base.y, z: tip.z - base.z }
}

Deno.test('the AR north tick, as drawn, points at true north for every start heading, turn and tilt', () => {
  assert(ANCHOR_RADIUS_M > 0)
  for (const c of CASES) {
    const frameBearing = sessionFrameBearingDeg(c.compass, c.rotation)
    const northYaw = northYawInSessionDeg(frameBearing)!
    assert(inBearingRange(northYaw), `${label(c)}: the tick yaw ${northYaw} is not in [0, 360)`)
    const tick = tickDirectionInSession(northYaw)
    const bearing = bearingOfSessionVector(c.psi, tick)
    assertAlmostEquals(angDiff(bearing, 0), 0, 1e-4, `${label(c)}: tick points at ${bearing}`)
  }
})

Deno.test('regression guard: the old tick (at the negated bearing) points at twice the compass bearing', () => {
  for (const c of CASES) {
    const legacyFrame = sessionFrameBearingDeg(c.compass, c.rotation, LEGACY_BEARING_CONVENTION)
    const tick = tickDirectionInSession(northYawInSessionDeg(legacyFrame, LEGACY_BEARING_CONVENTION))
    const bearing = bearingOfSessionVector(c.psi, tick)
    assertAlmostEquals(angDiff(bearing, 2 * c.compass), 0, 1e-4, `${label(c)}: tick points at ${bearing}`)
  }
  // So it is right only when the camera faced north or south at the tap.
  assertEquals(northYawInSessionDeg(null), null)
  assertEquals(northYawInSessionDeg(null, LEGACY_BEARING_CONVENTION), null)
})

Deno.test('northYawInSessionDeg: a yaw in [0, 360) under either rule, +bearing now and -bearing under ?bearing=1', () => {
  for (const frameBearing of [0, 1, 45, 90, 180, 270, 359.5]) {
    const current = northYawInSessionDeg(frameBearing)!
    const legacy = northYawInSessionDeg(frameBearing, LEGACY_BEARING_CONVENTION)!
    assertEquals(current, frameBearing, 'north lies at yaw +B_Z')
    assertAlmostEquals(legacy, norm360(-frameBearing), 1e-12, 'the old rule drew it at -B_Z')
    for (const yaw of [current, legacy]) {
      assert(inBearingRange(yaw), `${frameBearing}: ${yaw} is not in [0, 360)`)
      assert(!Object.is(yaw, -0), `${frameBearing}: a yaw of -0`)
    }
  }
})

// ── The one-point tier ──────────────────────────────────────────────────────

const TAP: V3 = { x: 0.3, y: -0.4, z: -1.2 }

Deno.test('one point: project +Z is true north, +Y up and +X west, for every start heading, turn and tilt', () => {
  for (const c of CASES) {
    const frameBearing = sessionFrameBearingDeg(c.compass, c.rotation)
    const m = oneTapToProjectTransform(TAP, frameBearing)!
    // A direction through the matrix: subtract where the session origin goes.
    const dir = (enu: Enu): V3 => {
      const p = applyColumnMajor(m, enuToSession(c.psi, enu))
      const o = applyColumnMajor(m, enuToSession(c.psi, { east: 0, north: 0, up: 0 }))
      return { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }
    }
    const tap = applyColumnMajor(m, TAP)
    assertAlmostEquals(Math.hypot(tap.x, tap.y, tap.z), 0, 1e-9, `${label(c)}: the tap is the origin`)
    const north = dir({ east: 0, north: 1, up: 0 })
    const east = dir({ east: 1, north: 0, up: 0 })
    const up = dir({ east: 0, north: 0, up: 1 })
    assertAlmostEquals(north.x, 0, 1e-9, label(c))
    assertAlmostEquals(north.z, 1, 1e-9, `${label(c)}: north is project +Z`)
    assertAlmostEquals(up.y, 1, 1e-9, label(c))
    // A right-handed frame with +Y up and +Z north has no choice but +X west: east is project -X.
    assertAlmostEquals(east.x, -1, 1e-9, `${label(c)}: east is project -X`)
    assertAlmostEquals(east.z, 0, 1e-9, label(c))
    assertAlmostEquals(rotationDeterminant(m), 1, 1e-12, label(c))
  }
})

Deno.test('regression guard: the old one-point frame put project +Z at twice the compass bearing', () => {
  for (const c of CASES) {
    const legacyFrame = sessionFrameBearingDeg(c.compass, c.rotation, LEGACY_BEARING_CONVENTION)
    const m = oneTapToProjectTransform(TAP, legacyFrame, LEGACY_BEARING_CONVENTION)!
    // The session direction that lands on project +Z is the third row of the rotation block.
    const intoProjectZ: V3 = { x: m[2]!, y: m[6]!, z: m[10]! }
    const bearing = bearingOfSessionVector(c.psi, intoProjectZ)
    assertAlmostEquals(angDiff(bearing, 2 * c.compass), 0, 1e-6, `${label(c)}: project +Z at ${bearing}`)
  }
})

Deno.test('one point: no compass reading builds no frame', () => {
  assertEquals(oneTapToProjectTransform(TAP, null), null)
  assertEquals(oneTapToProjectTransform(TAP, null, LEGACY_BEARING_CONVENTION), null)
})

// ── The two-point tier: the project's own bearing ───────────────────────────

Deno.test('two points: projectBearingDeg is the true bearing of the landmark-to-marker baseline', () => {
  const landmarkAt: Enu = { east: 1.5, north: -2, up: 0 }
  for (const baselineBearing of [0, 30, 90, 135, 180, 225, 300, 359]) {
    const b = baselineBearing * (Math.PI / 180)
    const markerAt: Enu = { east: landmarkAt.east + 2.4 * Math.sin(b), north: landmarkAt.north + 2.4 * Math.cos(b), up: 0 }
    for (const c of CASES) {
      const landmark = enuToSession(c.psi, landmarkAt)
      const marker = enuToSession(c.psi, markerAt)
      const frameBearing = sessionFrameBearingDeg(c.compass, c.rotation)
      const got = projectBearingDeg(frameBearing, twoPointHeadingDeg(landmark, marker))!
      assertAlmostEquals(angDiff(got, baselineBearing), 0, 1e-6, `${label(c)}, baseline ${baselineBearing}`)
      assert(inBearingRange(got), `${label(c)}, baseline ${baselineBearing}: ${got} is not a bearing in [0, 360)`)
      const stored = twoPointBearingFields(frameBearing, landmark, marker).projectBearingDeg!
      assertAlmostEquals(angDiff(stored, baselineBearing), 0, 1e-6)
      assert(inBearingRange(stored), `${label(c)}, baseline ${baselineBearing}: stored ${stored} is not a bearing in [0, 360)`)
    }
  }
})

Deno.test('two points: the project +Z axis really points along that bearing', () => {
  // Through the frame the app builds, not through the formula: the session direction that
  // `twoPointToProjectTransform` sends to project +Z has the physical bearing of the baseline.
  const landmarkAt: Enu = { east: -3, north: 4, up: 0 }
  const markerAt: Enu = { east: -1, north: 7, up: 0 }
  const baselineBearing = bearingOfEnu({ east: markerAt.east - landmarkAt.east, north: markerAt.north - landmarkAt.north })
  for (const psi of PSI) {
    const m = twoPointToProjectTransform(enuToSession(psi, landmarkAt), enuToSession(psi, markerAt))
    const intoProjectZ: V3 = { x: m[2]!, y: m[6]!, z: m[10]! }
    assertAlmostEquals(angDiff(bearingOfSessionVector(psi, intoProjectZ), baselineBearing), 0, 1e-9, `psi ${psi}`)
  }
})

Deno.test('two points: no compass reading leaves the bearing null and the frame intact', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  const marker = { x: 0, y: 0, z: 2 }
  assertEquals(projectBearingDeg(null, 10), null)
  assertEquals(projectBearingDeg(90, Number.NaN), null)
  assertEquals(twoPointBearingFields(null, landmark, marker).projectBearingDeg, null)
  assertEquals(twoPointBearingFields(null, landmark, marker).bearingConvention, BEARING_CONVENTION)
  assertEquals(twoPointBearingFields(10, landmark, marker, LEGACY_BEARING_CONVENTION).bearingConvention, LEGACY_BEARING_CONVENTION)
})

// ── Legacy records are unreadable ───────────────────────────────────────────

Deno.test('readable bearings: only a record stamped with the current rule can be read', () => {
  // A record as the previous build wrote it: a bearing and no rule.
  const legacy = { anchorBearingDeg: 123.4 }
  assertEquals(readableAnchorBearingDeg(legacy), null)
  assertEquals(readableAnchorBearingDeg({ anchorBearingDeg: 123.4, bearingConvention: LEGACY_BEARING_CONVENTION }), null)
  assertEquals(readableAnchorBearingDeg({ anchorBearingDeg: 123.4, bearingConvention: BEARING_CONVENTION }), 123.4)
  assertEquals(readableAnchorBearingDeg({ anchorBearingDeg: null, bearingConvention: BEARING_CONVENTION }), null)
  assertEquals(readableAnchorBearingDeg({ anchorBearingDeg: Number.NaN, bearingConvention: BEARING_CONVENTION }), null)

  assertEquals(readableProjectBearingDeg({ bearingConvention: BEARING_CONVENTION }), null)
  assertEquals(readableProjectBearingDeg({ projectBearingDeg: 12, bearingConvention: undefined }), null)
  assertEquals(readableProjectBearingDeg({ projectBearingDeg: 12, bearingConvention: BEARING_CONVENTION }), 12)
  // A JSON round trip of an old Place frame, and of a new one.
  assertEquals(readableAnchorBearingDeg(JSON.parse('{"version":1,"method":"ground-tap-compass","anchorBearingDeg":41}')), null)
  assertEquals(
    readableAnchorBearingDeg(JSON.parse('{"version":1,"method":"ground-tap-compass","anchorBearingDeg":41,"bearingConvention":2}')),
    41,
  )
})

// ── Nothing reads a stored bearing except through the readable helpers ──────

/** The stored fields whose meaning depends on the sign rule they were written under. */
const STORED_BEARING_FIELDS = new Set(['anchorBearingDeg', 'projectBearingDeg'])

/**
 * The functions that may read a stored bearing field, by file. They are the one place that decides whether a
 * stored value may be used (it may only if it was written under the current sign rule), so everything else
 * goes through them. Only these functions: another read in the same file is found like any other.
 */
const MAY_READ_STORED_BEARINGS: Record<string, readonly string[]> = {
  'src/world/geo.ts': ['readableAnchorBearingDeg', 'readableProjectBearingDeg'],
  // The server's check that a stored bearing is an angle before it keeps the frame (WP-03). It never uses the value as a bearing.
  'src/world/spatial-frame.ts': ['validateSpatialFrame'],
}

/**
 * Where `code` reads a stored bearing field, as `line:column` strings. A read is:
 *
 *  - `x.anchorBearingDeg` and `x?.anchorBearingDeg`, and `x['anchorBearingDeg']` (any quoting);
 *  - destructuring it, with or without a rename or a default: `{ anchorBearingDeg }`, `{ anchorBearingDeg: b }`;
 *  - the name as a string on its own (`'anchorBearingDeg'`), which is how a key list or `record[key]` reads it
 *    without writing the name at the access.
 *
 * Not reads: a key in an object literal or a type, a shorthand `{ anchorBearingDeg }` in an object literal,
 * the left side of an assignment, a string type, a comment, and a longer string that merely mentions the name.
 * It is syntax, so a ternary or a `case` or a call argument is found the same as a plain statement; the
 * regular expression this replaced took any occurrence followed by a colon for an object key, which a
 * `cond ? x.anchorBearingDeg : y` is.
 *
 * Reads inside a function declaration named in `allowedIn` are not reported.
 */
function storedBearingReads(code: string, fileName: string, allowedIn: readonly string[] = []): string[] {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.(ts|mts|cts)$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind)
  const found = new Set<string>()
  const insideAllowedFunction = (node: ts.Node) => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) && n.name && allowedIn.includes(n.name.text)) return true
    }
    return false
  }
  const report = (node: ts.Node) => {
    if (insideAllowedFunction(node)) return
    const at = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.add(`${at.line + 1}:${at.character + 1}`)
  }
  const isAssignmentTarget = (node: ts.Node) =>
    ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  const isStringKey = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (STORED_BEARING_FIELDS.has(node.name.text) && !isAssignmentTarget(node)) report(node.name)
    } else if (ts.isElementAccessExpression(node)) {
      if (isStringKey(node.argumentExpression) && STORED_BEARING_FIELDS.has(node.argumentExpression.text) && !isAssignmentTarget(node)) {
        report(node.argumentExpression)
      }
    } else if (ts.isBindingElement(node)) {
      // `{ a }` names the property in `name`; `{ a: b }` and `{ 'a': b }` name it in `propertyName`.
      const key = node.propertyName ?? node.name
      if ((ts.isIdentifier(key) || isStringKey(key)) && STORED_BEARING_FIELDS.has(key.text) && ts.isObjectBindingPattern(node.parent)) report(key)
    } else if (isStringKey(node) && STORED_BEARING_FIELDS.has(node.text)) {
      const parent = node.parent
      const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node
      if (!isKey && !ts.isLiteralTypeNode(parent) && !ts.isElementAccessExpression(parent)) report(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...found].sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]) || Number(a.split(':')[1]) - Number(b.split(':')[1]))
}

Deno.test('the stored-bearing scan finds every shape of read, and none of the writes', () => {
  const reads: Record<string, string> = {
    'a plain read': 'const b = cal.anchorBearingDeg',
    'an optional chain': 'const b = cal?.anchorBearingDeg ?? 0',
    'a bracket read': "const b = cal['anchorBearingDeg']",
    'a template bracket read': 'const b = cal[`projectBearingDeg`]',
    'a destructure': 'const { anchorBearingDeg } = cal',
    'a destructure with a rename': 'const { anchorBearingDeg: b } = cal',
    'a destructure with a default': 'const { projectBearingDeg = 0 } = cal',
    'a destructure of a quoted key': "const { 'anchorBearingDeg': b } = cal",
    'a destructured parameter': 'function f({ anchorBearingDeg }: Rec) { return anchorBearingDeg }',
    'the middle operand of a ternary': 'const b = ok ? cal.anchorBearingDeg : null',
    'the last operand of a ternary': 'const b = ok ? 0 : frame.projectBearingDeg',
    'a projectBearingDeg ternary': 'const b = ok ? frame.projectBearingDeg : 0',
    'a case': 'switch (x) { case cal.anchorBearingDeg: break }',
    'an argument': 'foo(cal.anchorBearingDeg)',
    'an object value': 'foo({ bearing: cal.anchorBearingDeg })',
    'a compound assignment': 'cal.anchorBearingDeg += 1',
    'the name as a key to look up': "const keys = ['version', 'anchorBearingDeg']",
    'the name as a call argument': "pick(cal, 'projectBearingDeg')",
  }
  for (const [what, code] of Object.entries(reads)) {
    assertEquals(storedBearingReads(code, 'x.ts').length, 1, `${what}: ${code}`)
  }
  const notReads: Record<string, string> = {
    'an object literal key': 'const c = { anchorBearingDeg: b }',
    'a quoted object literal key': "const c = { 'projectBearingDeg': b }",
    'a shorthand object literal': 'const c = { anchorBearingDeg }',
    'a spread beside the keys': 'const c = { ...cal, anchorBearingDeg: b, projectBearingDeg: null }',
    'an interface member': 'interface R { anchorBearingDeg: number | null; projectBearingDeg?: number | null }',
    'a type literal member': 'type R = { anchorBearingDeg?: number }',
    'a string type': "type K = Pick<R, 'anchorBearingDeg'>",
    'an assignment': 'cal.anchorBearingDeg = 12',
    'an assignment to a bracket': "cal['projectBearingDeg'] = 12",
    'a line comment': '// reads cal.anchorBearingDeg\nconst a = 1',
    'a block comment': '/* const { anchorBearingDeg } = cal */ const a = 1',
    'a longer string': "const m = 'spatialFrame.anchorBearingDeg must be a bearing'",
    'a template with the name inside': 'const m = `the anchorBearingDeg is ${x}`',
    'another property': 'const b = cal.anchorBearing + cal.projectBearing + cal.bearingDeg',
  }
  for (const [what, code] of Object.entries(notReads)) {
    assertEquals(storedBearingReads(code, 'x.ts'), [], `${what}: ${code}`)
  }
  // The line and column are of the name, so a finding can be found.
  assertEquals(storedBearingReads('const a = 1\nconst b = ok ? cal.anchorBearingDeg : null', 'x.ts'), ['2:20'])
  // JavaScript, as the public scripts are.
  assertEquals(storedBearingReads('const { anchorBearingDeg: b } = cal', 'x.js'), ['1:9'])
  // A named function may read it, and only that function: the same read beside it is found.
  const twoFunctions = [
    'function readableAnchorBearingDeg(r) { return r.anchorBearingDeg }',
    'function other(r) { return r.anchorBearingDeg }',
    'const leak = (r) => r.projectBearingDeg',
  ].join('\n')
  assertEquals(storedBearingReads(twoFunctions, 'x.ts'), ['1:49', '2:30', '3:23'])
  assertEquals(storedBearingReads(twoFunctions, 'x.ts', ['readableAnchorBearingDeg']), ['2:30', '3:23'])
  assertEquals(storedBearingReads(twoFunctions, 'x.ts', ['readableAnchorBearingDeg', 'other']), ['3:23'])
})

/** The directories whose files the browser or the server runs. Pages at the root carry inline scripts of their own. */
const SCANNED_DIRS = ['src/', 'server/', 'public/', 'scripts/']

/**
 * The reads of a stored bearing field in the source under `root`, as `path:line:column`. Every file the browser
 * or the server runs is parsed: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, and the inline scripts of `.html` pages
 * (the markup of a page is not code). Tests and docs are not scanned: they write fixtures and say what is wrong.
 */
function storedBearingReadsUnder(root: URL): string[] {
  const offenders: string[] = []
  const scanText = (path: string, code: string) => {
    for (const at of storedBearingReads(code, path, MAY_READ_STORED_BEARINGS[path])) offenders.push(`${path}:${at}`)
  }
  const scanFile = (path: string, url: URL) => {
    const code = Deno.readTextFileSync(url)
    if (!path.endsWith('.html')) {
      scanText(path, code)
      return
    }
    for (const script of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scanText(path + '#script.js', script[1]!)
  }
  const visit = (dir: URL) => {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir)
      if (entry.isDirectory) {
        visit(child)
        continue
      }
      if (!/\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name)) continue
      scanFile(child.pathname.slice(root.pathname.length), child)
    }
  }
  for (const dir of SCANNED_DIRS) {
    try {
      visit(new URL(dir, root))
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  for (const entry of Deno.readDirSync(root)) {
    if (entry.isFile && entry.name.endsWith('.html')) scanFile(entry.name, new URL(entry.name, root))
  }
  return offenders
}

Deno.test('the stored-bearing scan walks every place source lives, and skips what is not source', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'stored-bearing-scan-' })
  try {
    const put = (path: string, text: string) => {
      const file = `${dir}/${path}`
      Deno.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
      Deno.writeTextFileSync(file, text)
    }
    const read = 'const b = ok ? cal.anchorBearingDeg : null\n'
    put('src/deep/in/a.ts', read)
    put('server/b.ts', 'const { anchorBearingDeg: b } = cal\n')
    put('public/c.js', "const b = cal['projectBearingDeg']\n")
    put('scripts/d.mjs', 'const b = cal.anchorBearingDeg\n')
    put('scripts/e.cjs', 'const b = cal?.projectBearingDeg\n')
    put('page.html', '<p>cal.anchorBearingDeg</p>\n<script type="module">\n' + read + '</script>\n')
    put('src/page.html', '<script>const b = cal.anchorBearingDeg</script><script src="x.js"></script>\n')
    // Not source, or not the app's: nothing here may be reported.
    put('only-markup.html', '<h1>anchorBearingDeg</h1><script>const k = 1</script>\n')
    put('docs/notes.md', 'cal.anchorBearingDeg\n')
    put('tests/unit/t.ts', read)
    put('node_modules/pkg/index.js', read)
    put('scripts/node_modules/pkg/index.js', read)
    put('src/.hidden/x.ts', read)
    put('src/data.json', '{"anchorBearingDeg": 1}\n')
    // geo.ts may read inside its two helpers, and only there.
    put('src/world/geo.ts', [
      'export function readableAnchorBearingDeg(r) { return r.anchorBearingDeg }',
      'export function readableProjectBearingDeg(r) { return r.projectBearingDeg }',
      'export function sneaky(r) { return r.anchorBearingDeg }',
    ].join('\n'))
    assertEquals(storedBearingReadsUnder(new URL(`file://${dir}/`)).sort(), [
      'page.html#script.js:2:20',
      'public/c.js:1:15',
      'scripts/d.mjs:1:15',
      'scripts/e.cjs:1:16',
      'server/b.ts:1:9',
      'src/deep/in/a.ts:1:20',
      'src/page.html#script.js:1:15',
      'src/world/geo.ts:3:38',
    ])
  } finally {
    Deno.removeSync(dir, { recursive: true })
  }
})

Deno.test('source shape: nothing reads a stored bearing except through the readable helpers', () => {
  // The values written before the sign was corrected are unreadable, and "nothing reads them today" is
  // only true until someone does. The one place allowed to read them is the one that decides whether they
  // may be used (MAY_READ_STORED_BEARINGS), so a read written as a ternary, a destructure or a key lookup is
  // found as well as a plain `.anchorBearingDeg`.
  const root = new URL('../../../', import.meta.url)
  assertEquals(
    storedBearingReadsUnder(root),
    [],
    'read a stored bearing through readableAnchorBearingDeg() / readableProjectBearingDeg()',
  )
  // The allowed functions do read them, and only they do: the scan is looking at the right thing.
  const geo = Deno.readTextFileSync(new URL('src/world/geo.ts', root))
  assertEquals(storedBearingReads(geo, 'src/world/geo.ts').length, 2, 'geo.ts reads each field once, in its own helper')
  assertEquals(storedBearingReads(geo, 'src/world/geo.ts', MAY_READ_STORED_BEARINGS['src/world/geo.ts']), [])
})

Deno.test('?bearing=1 is the only way to the old rule', () => {
  assertEquals(bearingConventionFromSearch('?bearing=1'), LEGACY_BEARING_CONVENTION)
  assertEquals(bearingConventionFromSearch('?world=default&bearing=1&debug=pose'), LEGACY_BEARING_CONVENTION)
  for (const search of ['', '?', '?bearing=', '?bearing=2', '?bearing=0', '?bearing=true', '?bearings=1', '?world=default', '?debug=bearing']) {
    assertEquals(bearingConventionFromSearch(search), BEARING_CONVENTION, JSON.stringify(search))
  }
})

// ── Placing a session in a scene ────────────────────────────────────────────

/** Physical features of a small room, in metres east, north and up of the session origin's own site. */
const FEATURES: Enu[] = [
  { east: 3, north: 0, up: 0.5 },
  { east: 0, north: 4, up: 1 },
  { east: -2, north: -3, up: 0 },
  { east: 2, north: 2, up: 2 },
]
/** Where this session's origin physically is, relative to the scene's own origin. */
const SITE: Enu = { east: 12, north: -7, up: 0.3 }

const sum = (a: Enu, b: Enu): Enu => ({ east: a.east + b.east, north: a.north + b.north, up: a.up + b.up })

Deno.test('right-handed scene (x east, y up, z south): a rotation alone places a session exactly where the oracle says', () => {
  for (const psi of PSI) {
    const trueBearing = trueSessionZBearing(psi)
    const m = composeYUpTransform(sceneFromEnu(SITE), sceneYawForBearingDeg(trueBearing), 1)
    assertAlmostEquals(rotationDeterminant(m), 1, 1e-12)
    for (const f of FEATURES) {
      const placed = applyColumnMajor(m, enuToSession(psi, f))
      const want = sceneFromEnu(sum(SITE, f))
      assertAlmostEquals(placed.x, want.x, 1e-12, `psi ${psi}: x`)
      assertAlmostEquals(placed.y, want.y, 1e-12, `psi ${psi}: y`)
      assertAlmostEquals(placed.z, want.z, 1e-12, `psi ${psi}: z`)
    }
    // Still right-handed afterwards: the placed x axis crossed with the placed y axis is the placed z axis.
    const o = applyColumnMajor(m, { x: 0, y: 0, z: 0 })
    const axis = (p: V3): V3 => {
      const q = applyColumnMajor(m, p)
      return { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z }
    }
    const xyz = cross(axis({ x: 1, y: 0, z: 0 }), axis({ x: 0, y: 1, z: 0 }))
    const z = axis({ x: 0, y: 0, z: 1 })
    assertAlmostEquals(xyz.x, z.x, 1e-12)
    assertAlmostEquals(xyz.y, z.y, 1e-12)
    assertAlmostEquals(xyz.z, z.z, 1e-12)
  }
})

Deno.test('regression guard: in (east, up, north) a rotation cannot place a right-handed session, and a mirror is the whole defect', () => {
  let worst = 0
  for (const psi of PSI) {
    const trueBearing = trueSessionZBearing(psi)
    // The legacy placement: translation in (east, up, north), yaw = the session's +Z bearing.
    const m = composeYUpTransform({ x: SITE.east, y: SITE.up, z: SITE.north }, trueBearing, 1)
    let sessionWorst = 0
    for (const f of FEATURES) {
      const placed = applyColumnMajor(m, enuToSession(psi, f))
      const want = { x: SITE.east + f.east, y: SITE.up + f.up, z: SITE.north + f.north }
      sessionWorst = Math.max(sessionWorst, Math.hypot(placed.x - want.x, placed.y - want.y, placed.z - want.z))
      // Reflect the session's x axis first and the same rotation is exact: east and west were swapped, nothing else.
      const s = enuToSession(psi, f)
      const mirrored = applyColumnMajor(m, { x: -s.x, y: s.y, z: s.z })
      assertAlmostEquals(mirrored.x, want.x, 1e-9, `psi ${psi}: reflected x`)
      assertAlmostEquals(mirrored.y, want.y, 1e-9, `psi ${psi}: reflected y`)
      assertAlmostEquals(mirrored.z, want.z, 1e-9, `psi ${psi}: reflected z`)
    }
    // A rotation has determinant +1, so it cannot undo a mirror.
    assertAlmostEquals(rotationDeterminant(m), 1, 1e-12)
    assert(sessionWorst > 1, `psi ${psi}: the legacy placement was off by only ${sessionWorst} m`)
    worst = Math.max(worst, sessionWorst)
  }
  // Features 4 m from the origin land up to 8 m from where they are.
  assertAlmostEquals(worst, 8, 1e-9)
})

/** Column-major 4x4 product `a * b`. */
function mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!
    }
  }
  return out
}

Deno.test('a calibrated two-point scan, georeferenced from its own compass, lands where the oracle says', () => {
  // Two sessions of one room start facing different ways from different spots and tap the same two physical
  // features. Each builds its own sessionToProject, takes the Place's bearing from its own compass, and is
  // carried into the scene by a rotation. Both must put every feature where the oracle does, with the scene
  // origin at the landmark.
  const landmarkAt: Enu = { east: 4, north: 2, up: 0 }
  const markerAt: Enu = { east: 6.4, north: 3.8, up: 0 }
  const baselineBearing = bearingOfEnu({ east: markerAt.east - landmarkAt.east, north: markerAt.north - landmarkAt.north })
  const sessions: Array<{ psi: number; origin: Enu; turn: number; down: number }> = [
    { psi: 10, origin: { east: 0.5, north: -1, up: 0 }, turn: 0, down: 0 },
    { psi: 137, origin: { east: 7, north: 3.5, up: 0 }, turn: -75, down: 60 },
    { psi: 290, origin: { east: -2, north: 8, up: 0 }, turn: 120, down: 25 },
  ]
  for (const s of sessions) {
    const rel = (p: Enu): V3 => enuToSession(s.psi, { east: p.east - s.origin.east, north: p.north - s.origin.north, up: p.up - s.origin.up })
    const landmark = rel(landmarkAt)
    const marker = { ...rel(markerAt), y: landmark.y }
    const sessionToProject = twoPointToProjectTransform(landmark, marker)
    const rotation = cameraRotation(s.turn, s.down)
    const frameBearing = sessionFrameBearingDeg(perfectCompassBearing(s.psi, rotation), rotation)
    const beta = projectBearingDeg(frameBearing, twoPointHeadingDeg(landmark, marker))!
    assertAlmostEquals(angDiff(beta, baselineBearing), 0, 1e-9, `session at ${s.psi}: the Place bearing`)
    const toScene = mul(composeYUpTransform({ x: 0, y: 0, z: 0 }, sceneYawForBearingDeg(beta), 1), sessionToProject)
    for (const f of FEATURES) {
      const feature = sum(landmarkAt, f)
      const placed = applyColumnMajor(toScene, rel(feature))
      const want = sceneFromEnu(f)
      assertAlmostEquals(placed.x, want.x, 1e-9, `session at ${s.psi}: x`)
      assertAlmostEquals(placed.y, want.y, 1e-9, `session at ${s.psi}: y`)
      assertAlmostEquals(placed.z, want.z, 1e-9, `session at ${s.psi}: z`)
    }
  }
})
