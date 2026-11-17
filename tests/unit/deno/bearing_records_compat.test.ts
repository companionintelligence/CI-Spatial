/**
 * Records the previous build wrote keep loading, and the ones this build writes keep what they carry.
 *
 * This package adds `bearingConvention` (which sign rule a stored bearing was written under) and
 * `projectBearingDeg` to the Place frame and to a scan's calibration record, and `?bearing=1` can stamp `1`.
 * Every one is optional, so nothing is migrated. What is checked here is the part that is easy to break by
 * accident and invisible until a Place is read back: that the server stores a frame whole, in the shape the
 * previous build sent as well as in the new one, and does not add, drop or rewrite a key; that the readers it
 * runs over a scan's sidecar see the same method, status and separation whichever build wrote it; and that
 * the one rule for reading a stored bearing says "unreadable" for what the previous build wrote and for what
 * a `?bearing=1` page wrote, and reads what the current rule wrote.
 *
 * The client side of the same promise (a visit against a stored frame in the previous shape still verifies,
 * and leaves that frame byte-identical) is in tests/unit/node/calibration_bearing_flow.test.ts.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { placeBodyError, placeFromBody } from '../../../server/wp-a-projects.ts'
import { asCalibrationMethod, asCalibrationSeparationM, asCalibrationStatus } from '../../../server/calibration_fields.ts'
import { BEARING_CONVENTION, LEGACY_BEARING_CONVENTION, readableAnchorBearingDeg, readableProjectBearingDeg } from '../../../src/world/geo.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const CREATED_AT = '2026-05-01T00:00:00.000Z'

/** A two-point frame as the previous build wrote it: a bearing, and neither the stamp nor the project bearing. */
const PREVIOUS_TWO_POINT = {
  version: 1,
  createdAt: CREATED_AT,
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 2.4 },
  separationM: 2.4,
  toleranceM: 0.15,
  anchorBearingDeg: 123.4,
  pointLabels: ['north door frame', 'radiator corner'],
}
const PREVIOUS_ONE_POINT = { version: 1, createdAt: CREATED_AT, method: 'ground-tap-compass', anchorBearingDeg: 41 }
const PREVIOUS_ONE_POINT_NO_COMPASS = { version: 1, createdAt: CREATED_AT, method: 'ground-tap-compass', anchorBearingDeg: null }

/** The same frames as this build writes them. */
const CURRENT_TWO_POINT = { ...PREVIOUS_TWO_POINT, projectBearingDeg: 40.25, bearingConvention: BEARING_CONVENTION }
const CURRENT_TWO_POINT_NO_COMPASS = { ...PREVIOUS_TWO_POINT, anchorBearingDeg: null, projectBearingDeg: null, bearingConvention: BEARING_CONVENTION }
const CURRENT_ONE_POINT = { ...PREVIOUS_ONE_POINT, bearingConvention: BEARING_CONVENTION }
const LEGACY_RULE_TWO_POINT = { ...PREVIOUS_TWO_POINT, projectBearingDeg: 77, bearingConvention: LEGACY_BEARING_CONVENTION }

/** What a PUT /projects/:id stores for a Place with this frame, through the server's own validation and builder. */
function storedPlace(frame: unknown): Project {
  const body = { projectId: 'proj-1', name: 'Room', createdAt: 1, floors: [], spatialFrame: frame }
  assertEquals(placeBodyError(body, 'replace'), null, 'the server accepts the body')
  // Over the wire and back, as the registry file does.
  const stored: Project = { projectId: 'proj-1', name: 'Room', createdAt: 1, updatedAt: 1, floors: [] }
  return JSON.parse(JSON.stringify(placeFromBody(body, 'proj-1', 2, stored))) as Project
}

const FRAMES: Array<[string, unknown]> = [
  ['two-point, previous build', PREVIOUS_TWO_POINT],
  ['one-point, previous build', PREVIOUS_ONE_POINT],
  ['one-point with no compass, previous build', PREVIOUS_ONE_POINT_NO_COMPASS],
  ['two-point, this build', CURRENT_TWO_POINT],
  ['two-point with no compass, this build', CURRENT_TWO_POINT_NO_COMPASS],
  ['one-point, this build', CURRENT_ONE_POINT],
  ['two-point written by a ?bearing=1 page', LEGACY_RULE_TWO_POINT],
]

for (const [name, frame] of FRAMES) {
  Deno.test(`the server stores a Place frame whole: ${name}`, () => {
    assertEquals(storedPlace(frame).spatialFrame, frame as ProjectSpatialFrame, 'no key added, dropped or rewritten')
  })
}

Deno.test('a Place frame the previous build wrote, or a ?bearing=1 page wrote, has no readable bearing; this build\'s has', () => {
  for (const frame of [PREVIOUS_TWO_POINT, PREVIOUS_ONE_POINT, LEGACY_RULE_TWO_POINT]) {
    const stored = storedPlace(frame).spatialFrame as { anchorBearingDeg: number | null; projectBearingDeg?: number | null; bearingConvention?: 1 | 2 }
    assertEquals(readableAnchorBearingDeg(stored), null, JSON.stringify(frame))
    assertEquals(readableProjectBearingDeg(stored), null, JSON.stringify(frame))
  }
  const current = storedPlace(CURRENT_TWO_POINT).spatialFrame as { anchorBearingDeg: number | null; projectBearingDeg?: number | null; bearingConvention?: 1 | 2 }
  assertEquals(readableAnchorBearingDeg(current), 123.4)
  assertEquals(readableProjectBearingDeg(current), 40.25)
  const oneCurrent = storedPlace(CURRENT_ONE_POINT).spatialFrame as { anchorBearingDeg: number | null; bearingConvention?: 1 | 2 }
  assertEquals(readableAnchorBearingDeg(oneCurrent), 41)
  // A current-rule frame recorded with no compass reading has nothing to read, and says so.
  const noCompass = storedPlace(CURRENT_TWO_POINT_NO_COMPASS).spatialFrame as { anchorBearingDeg: number | null; projectBearingDeg?: number | null; bearingConvention?: 1 | 2 }
  assertEquals(readableAnchorBearingDeg(noCompass), null)
  assertEquals(readableProjectBearingDeg(noCompass), null)
})

Deno.test('a scan\'s calibration record reads the same to the server whichever build wrote it', () => {
  const previous = {
    method: 'two-point-ground',
    sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    separationM: 2.4,
    residualM: 0,
    toleranceM: 0.15,
    anchorBearingDeg: 123.4,
    calibratedAt: CREATED_AT,
    status: 'provisional',
  }
  const current = { ...previous, projectBearingDeg: 40.25, bearingConvention: BEARING_CONVENTION }
  const legacyRule = { ...previous, projectBearingDeg: 77, bearingConvention: LEGACY_BEARING_CONVENTION }
  for (const calibration of [previous, current, legacyRule]) {
    // The sidecar `src/export/gltf.ts` uploads: the flat summaries and the whole record.
    const sidecar = JSON.parse(JSON.stringify({
      calibrationMethod: calibration.method,
      calibrationStatus: calibration.status,
      calibration,
    })) as { calibrationMethod: unknown; calibrationStatus: unknown; calibration: unknown }
    assertEquals(asCalibrationMethod(sidecar.calibrationMethod), 'two-point-ground')
    assertEquals(asCalibrationStatus(sidecar.calibrationStatus), 'provisional')
    assertEquals(asCalibrationSeparationM(sidecar.calibration), 2.4)
  }
})
