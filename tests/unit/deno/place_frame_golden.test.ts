/**
 * place_frame_golden.test.ts — the records the app wrote before the S0 schema step, held to the server code that reads
 * them now.
 * Run: deno test --allow-read tests/unit/deno/place_frame_golden.test.ts
 *
 * tests/unit/node/wp-s0-golden.test.ts runs the writers (the calibration flow, the phone's frame upload, the scan
 * export) and holds what they write to the schema, and the same file holds the frozen records below as well. It is a
 * Node test, and CI runs the Deno suite (`deno task test`) and no other, so the part of it that must never stop holding
 * is held here as well: tests/fixtures/place-frame/records-before-s0.json is what those writers wrote before S0, on
 * disk, in IndexedDB and in a service worker's queue for every user who has calibrated, and every build that follows
 * has to accept it. A frame the server refuses is a calibration that silently never reaches the Place, and a sidecar the
 * server reads differently changes what the editor says about a scan.
 *
 * Nothing in the fixture is edited by hand and it is not regenerated: a build that writes more than it has more
 * records to keep, which go in a file beside it.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import {
  asCalibrationMethod,
  calibrationEvidenceFromMeta,
  calibrationFromMeta,
  calibrationScaleFromMeta,
} from '../../../server/calibration_fields.ts'
import { adoptedFrameError, applySpatialFrameWrite, placeBodyError, placeFromBody } from '../../../server/wp-a-projects.ts'
import { sameSpatialFrame, validateSpatialFrame } from '../../../src/world/spatial-frame.ts'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'

const PLACE_ID = 'proj-1700000000000'
const NOW = 1_700_000_002_000

interface Frozen {
  calibration?: ScanCalibration
  spatialFrame?: ProjectSpatialFrame
  storedFrame?: ProjectSpatialFrame
  putBody?: { frame: ProjectSpatialFrame; expectedRevision: number }
  sidecar: Record<string, unknown>
}

const FROZEN = JSON.parse(
  await Deno.readTextFile(new URL('../../fixtures/place-frame/records-before-s0.json', import.meta.url)),
) as Record<string, Frozen>
const NAMES = Object.keys(FROZEN).filter((name) => name !== '_about')

const bareProject = (extra: Partial<Project> = {}): Project => ({
  projectId: PLACE_ID,
  name: 'Room',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }],
  ...extra,
})
/** What crosses the wire is JSON: a field that is undefined does not arrive. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The six fields every manifest has: what a sidecar from before S0 yields, and nothing else. */
const SIX = ['calibratedAt', 'calibrationMethod', 'calibrationResidualM', 'calibrationSeparationM', 'calibrationStatus', 'calibrationToleranceM']

Deno.test('the fixture holds every kind of record the writers made, and none of them has a field S0 added', () => {
  assertEquals(NAMES.sort(), [
    'onePointAgainstOnePointPlace',
    'onePointFirst',
    'twoPointFirst',
    'twoPointFirstNamedWithPhotos',
    'twoPointFirstNoCompass',
    'twoPointReturnKeptAfterMismatch',
    'twoPointReturnVerified',
    'twoPointReturnVerifiedAgainstFrameWithPhotos',
    'twoPointScaleStamped',
    'uncalibrated',
  ])
  const added = ['frameId', 'checkPoints', 'checkedBy', 'fit', 'tap', 'calibrationFrameId', 'frameHistory', 'georeference', 'georefVersion']
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      for (const [key, each] of Object.entries(value)) {
        if (added.includes(key)) found.add(key)
        walk(each)
      }
    }
  }
  walk(FROZEN)
  assertEquals([...found], [], 'a record with one of them is not a record from before S0')
})

for (const name of NAMES) {
  const record = FROZEN[name]!

  for (const [where, frame] of [['its frame', record.spatialFrame], ['the frame it was made against', record.storedFrame], ['the frame it sent', record.putBody?.frame]] as const) {
    if (!frame) continue
    Deno.test(`frozen: ${name}: ${where} validates and comes back unchanged`, () => {
      const check = validateSpatialFrame(frame, { projectId: PLACE_ID })
      assert(check.ok, check.ok ? '' : check.error)
      assertEquals(check.frame, frame, 'no field dropped, none invented')
      assert(sameSpatialFrame(check.frame, frame))
    })
  }

  if (record.putBody) {
    const { putBody } = record
    Deno.test(`frozen: ${name}: the body the phone sent to the revision route is kept by the server as it came`, () => {
      const projects = [bareProject()]
      const written = applySpatialFrameWrite(projects, PLACE_ID, overTheWire(putBody), NOW)
      assertEquals(written.result.status, 200)
      assertEquals(projects[0]!.spatialFrame, putBody.frame)
    })

    Deno.test(`frozen: ${name}: the whole Place a client sends with that frame is stored by the whole-record PUT`, () => {
      const body = overTheWire({ ...bareProject(), spatialFrame: putBody.frame })
      assertEquals(placeBodyError(body, 'replace'), null)
      assertEquals(adoptedFrameError(body, bareProject(), PLACE_ID), null)
      assertEquals(placeFromBody(body, PLACE_ID, NOW, bareProject()).spatialFrame, putBody.frame)
    })
  }

  if (record.storedFrame) {
    const stored = bareProject({ spatialFrame: record.storedFrame, spatialFrameRevision: 3 })
    Deno.test(`frozen: ${name}: a Place already holding the frame it was made against keeps it through a whole-record PUT`, () => {
      const place = placeFromBody(overTheWire({ ...stored, name: 'Renamed' }), PLACE_ID, NOW, stored)
      assertEquals(place.spatialFrame, record.storedFrame)
      assertEquals(place.spatialFrameRevision, 3)
      assertEquals(place.name, 'Renamed')
      for (const key of ['frameHistory', 'georeference', 'georefVersion']) assertFalse(key in place, `${key} appeared on a Place that never had it`)
    })
  }

  Deno.test(`frozen: ${name}: its sidecar yields the six fields it always did and no others, and the evidence reads as none`, () => {
    const fields = calibrationFromMeta(record.sidecar)
    assertEquals(Object.keys(fields).sort(), SIX)
    assertEquals(fields.calibrationMethod, asCalibrationMethod(record.sidecar['calibrationMethod']))
    assertEquals(Object.keys(overTheWire(calibrationEvidenceFromMeta(record.sidecar))), [], 'no evidence key reaches the editor or the world file')
    assertEquals(overTheWire({ ...fields, ...calibrationEvidenceFromMeta(record.sidecar) }), overTheWire(fields))
  })
}

Deno.test('frozen: the sidecar of a first two-point calibration reads exactly as before: provisional, spacing 2.4 m, nothing compared', () => {
  const fields = calibrationFromMeta(FROZEN['twoPointFirst']!.sidecar)
  assertEquals(fields.calibrationMethod, 'two-point-ground')
  assertEquals(fields.calibrationStatus, 'provisional')
  assert(Math.abs((fields.calibrationSeparationM ?? 0) - 2.4) < 1e-9)
  assertEquals(fields.calibrationResidualM, 0, 'a first calibration compared nothing, and says 0')
  assertEquals(fields.calibrationToleranceM, 0.15)
})

Deno.test('frozen: a visit kept after a mismatch still reads as the failed check it was, and a verified one with the residual it was verified at', () => {
  const kept = calibrationFromMeta(FROZEN['twoPointReturnKeptAfterMismatch']!.sidecar)
  assertEquals(kept.calibrationStatus, 'provisional')
  assert(Math.abs((kept.calibrationResidualM ?? 0) - 1.2) < 1e-9)
  assert(Math.abs(kept.calibrationResidualM ?? 0) > (kept.calibrationToleranceM ?? 0), 'the editor tells it from a first calibration by this')
  const verified = calibrationFromMeta(FROZEN['twoPointReturnVerified']!.sidecar)
  assertEquals(verified.calibrationStatus, 'verified')
  assert(Math.abs((verified.calibrationResidualM ?? 0) - 0.03) < 1e-9)
})

Deno.test('frozen: the unit a scan was stamped with is read from the sidecar as it always was', () => {
  assertEquals(calibrationScaleFromMeta(FROZEN['twoPointScaleStamped']!.sidecar), { scaleMode: 'responsive-unconfigured', scaleKind: 'arbitrary' })
  assertEquals(calibrationScaleFromMeta(FROZEN['twoPointFirst']!.sidecar), {}, 'an unstamped scan has no unit to report')
})
