/**
 * calibration_tap_evidence.test.ts — a sidecar whose calibration carries the evidence of how the landmark's tap was
 * measured (`ScanCalibration.tap`, WP-05b) is read by the server exactly as one without it.
 * Run: deno test --allow-read tests/unit/deno/calibration_tap_evidence.test.ts
 *
 * The capture client now writes `tap` into the calibration record that `src/export/gltf.ts` puts in a scan's sidecar,
 * and the service worker may hold an upload queued by the build before it, which has none. Both reach
 * `calibrationFromMeta`, which builds the `ScanManifest` fields the editor and the memory push read. The evidence is
 * data for the DX2 and DX5 analyses and is read by nothing on the server yet, so it must change nothing the server
 * says: not a field, not a value, not the absence of one. A record with it, and the same record without it, give the
 * same manifest fields, on every tier and status.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { calibrationFromMeta } from '../../../server/calibration_fields.ts'
import { twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { TapEvidence } from '../../../src/world/calibration-evidence.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

const LANDMARK = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER = { x: 3.1, y: -1.2, z: 1.9 }

const EVIDENCE: TapEvidence = { tapSpreadM: 0.0114, tapRangeM: 2.31, tapSource: 'burst', landmarkAboveFloorM: -0.02 }

const TWO_POINT: Extract<ScanCalibration, { method: 'two-point-ground' }> = {
  method: 'two-point-ground',
  sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
  separationM: twoPointSeparationM(LANDMARK, HEADING_MARKER),
  residualM: 0.022,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'verified',
}

/** The sidecar `src/export/gltf.ts` writes: the flat summaries and the whole record. */
function sidecar(calibration: ScanCalibration): Record<string, unknown> {
  return {
    projectTransform: calibration.sessionToProject,
    calibrationMethod: calibration.method,
    calibrationStatus: calibration.status,
    calibration,
  }
}

Deno.test('a sidecar whose calibration has tap evidence gives the same manifest fields as one without it', () => {
  const without = calibrationFromMeta(sidecar(TWO_POINT))
  const withTap = calibrationFromMeta(sidecar({ ...TWO_POINT, tap: EVIDENCE }))
  assertEquals(withTap, without)
  assertEquals(Object.keys(withTap).sort(), Object.keys(without).sort(), 'no key appears or goes missing')
})

Deno.test('every status reads the same with tap evidence on the record', () => {
  for (const status of ['verified', 'provisional'] as const) {
    const record = { ...TWO_POINT, status }
    assertEquals(calibrationFromMeta(sidecar({ ...record, tap: EVIDENCE })), calibrationFromMeta(sidecar(record)), status)
  }
})

Deno.test('evidence of every source, with nothing measured or with the floor ray alone, is read past the same way', () => {
  const kinds: TapEvidence[] = [
    { tapSpreadM: null, tapRangeM: 1.9, tapSource: 'single-hit', landmarkAboveFloorM: null },
    { tapSpreadM: null, tapRangeM: 2.4, tapSource: 'floor-ray', landmarkAboveFloorM: 0.12 },
    { tapSpreadM: 0.039, tapRangeM: 2.99, tapSource: 'burst', landmarkAboveFloorM: null },
  ]
  const without = calibrationFromMeta(sidecar(TWO_POINT))
  for (const tap of kinds) assertEquals(calibrationFromMeta(sidecar({ ...TWO_POINT, tap })), without, tap.tapSource)
})

Deno.test('a record that is not shaped as evidence is ignored too: the server reads what it reads and nothing else', () => {
  const without = calibrationFromMeta(sidecar(TWO_POINT))
  for (const tap of [null, 'burst', 12, [], { tapSource: 'telepathy' }]) {
    assertEquals(calibrationFromMeta(sidecar({ ...TWO_POINT, tap } as unknown as ScanCalibration)), without, JSON.stringify(tap))
  }
})
