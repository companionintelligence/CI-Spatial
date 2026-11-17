/**
 * The origin's persisted records (wave 12, ticket 0001): the scan's
 * `ScanCalibration` with its `groundY`, and the Place's two-point
 * `ProjectSpatialFrame`.
 *
 * The round trip is the real path, not a field-by-field copy. The scan's
 * calibration goes into the GLB sidecar as JSON (src/export/gltf.ts writes the
 * whole `calibration` object), and the server reads it back with the same
 * `readCalibrationGroundY()` that fills `ScanManifest.calibrationGroundY`.
 *
 * Run: npm run test:origin
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readCalibrationGroundY,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import type { ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'

type TwoPointFrame = Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
/** `separationM` and `residualM` exist only on the two-point scan calibration, so narrow to it. */
type TwoPointScan = Extract<ScanCalibration, { method: 'two-point-ground' }>

/** The JSON a record becomes in a sidecar or a Place write, and back. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Column-major 4x4 applied to a point, as `sessionToProject` is stored and
 * consumed (`number[]`, 16 entries, translation in 12..14).
 */
function applyColumnMajor(m: number[], p: { x: number; y: number; z: number }) {
  return {
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
  }
}

const LANDMARK = { x: 1.25, y: -0.4, z: -2 }
const HEADING = { x: 1.25, y: -0.4, z: 0.5 }
const SEPARATION = twoPointSeparationM(LANDMARK, HEADING)

function committedScan(): TwoPointScan {
  return {
    method: 'two-point-ground',
    sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING),
    separationM: SEPARATION,
    residualM: 0.02,
    toleranceM: 0.15,
    anchorBearingDeg: 212,
    calibratedAt: '2026-11-16T10:00:00.000Z',
    status: 'verified',
    groundY: LANDMARK.y,
  }
}

test('origin persistence: a scan\'s origin survives the sidecar with its ground height', () => {
  const scan = committedScan()
  const sidecar = roundTrip({ calibration: scan })

  // Normalised through JSON on both sides, so -0 and 0 in the matrix cannot make
  // a correct round trip look different.
  assert.deepStrictEqual(sidecar.calibration, roundTrip(scan))
  assert.equal(readCalibrationGroundY(sidecar.calibration), LANDMARK.y)
})

test('origin persistence: the recorded groundY is the floor the project frame\'s y = 0 sits on', () => {
  const scan = committedScan()
  const m = scan.sessionToProject

  // The landmark maps to the project origin, so the frame's origin is where the user put it.
  const origin = applyColumnMajor(m, LANDMARK)
  assert.ok(Math.abs(origin.x) < 1e-9 && Math.abs(origin.y) < 1e-9 && Math.abs(origin.z) < 1e-9)

  // Any point on the same floor, at the recorded groundY, lands on project y = 0.
  const onFloor = applyColumnMajor(m, { x: 6, y: readCalibrationGroundY(scan) ?? Number.NaN, z: 3 })
  assert.ok(Math.abs(onFloor.y) < 1e-9, `floor point mapped to y=${onFloor.y}, expected 0`)

  // The heading point lands on project +Z at the recorded separation.
  const heading = applyColumnMajor(m, HEADING)
  assert.ok(Math.abs(heading.x) < 1e-9 && Math.abs(heading.y) < 1e-9)
  assert.ok(Math.abs(heading.z - scan.separationM) < 1e-9, `heading z ${heading.z} vs ${scan.separationM}`)
})

test('origin persistence: a record written before groundY existed still reads, and says the floor is unknown', () => {
  const legacy: TwoPointScan = {
    method: 'two-point-ground',
    sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING),
    separationM: SEPARATION,
    residualM: 0,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    calibratedAt: '2026-08-20T09:00:00.000Z',
    status: 'provisional',
  }
  const parsed = roundTrip({ calibration: legacy })

  assert.equal('groundY' in parsed.calibration, false, 'a legacy record must not gain a field it never had')
  assert.equal(readCalibrationGroundY(parsed.calibration), null)
  assert.equal(parsed.calibration.separationM, SEPARATION, 'the rest of the record is untouched')
})

test('origin persistence: a non-finite groundY comes back as null, never as a number', () => {
  // JSON has no NaN: it serialises as null, and the reader must treat that as unknown.
  const broken = roundTrip({ calibration: { ...committedScan(), groundY: Number.NaN } })
  assert.equal(readCalibrationGroundY(broken.calibration), null)
})

test('origin persistence: the Place\'s two-point frame keeps its origin, heading and separation', () => {
  const frame: TwoPointFrame = {
    version: 1,
    createdAt: '2026-11-16T10:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: SEPARATION },
    separationM: SEPARATION,
    toleranceM: 0.15,
    anchorBearingDeg: 212,
    pointLabels: ['north door frame', 'radiator'],
  }
  const back = roundTrip(frame)

  assert.deepStrictEqual(back, frame)
  // Project-space by construction: the origin is 0, and the heading sits on +Z at the separation.
  assert.equal(twoPointSeparationM(back.landmark, back.headingMarker), back.separationM)
  assert.equal(back.landmark.y, back.headingMarker.y, 'the baseline is horizontal')
})

test('origin persistence: the Place frame carries no per-scan ground height of its own', () => {
  // The floor is y = 0 in project space by construction, so the Place-level record
  // needs no groundY. The field lives on the scan, which is where the session height exists.
  const frame: TwoPointFrame = {
    version: 1,
    createdAt: '2026-11-16T10:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: SEPARATION },
    separationM: SEPARATION,
    toleranceM: 0.15,
    anchorBearingDeg: null,
  }
  assert.equal('groundY' in roundTrip(frame), false)
})
