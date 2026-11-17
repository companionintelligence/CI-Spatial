/**
 * scan_manifest_calibration.test.ts — what a stored scan's sidecar hands the editor about HOW WELL it was
 * calibrated, not only which tier and status it has.
 * Run: deno test --allow-read tests/unit/deno/scan_manifest_calibration.test.ts
 *
 * The gap these pin. `scanManifestFromStored` (server/main.ts) turned a sidecar into the tier, the
 * status and the separation. The residual (the re-measured separation minus the Place's stored one),
 * the tolerance it was judged against and the time of the calibration sat in the same sidecar,
 * inside the nested `calibration` record `src/export/gltf.ts` writes, and were dropped. So the editor
 * could say a scan was "two-point, verified" and could not say by how much, and its scan list showed the phone's
 * GPS accuracy instead (src/viewer/scan-calibration-chip.ts is what prints it now).
 *
 * Two things the tests hold fixed:
 *   1. It works on scans already on disk. SIDECAR_AS_WRITTEN_BEFORE is a frozen copy of what the build
 *      before this change uploaded, written out as text and not built by a helper that might move with the
 *      code: every number it needs is in it already, in the record it has always carried.
 *   2. A measurement is never attached to a tier it does not belong to. The `splat-align` job overwrites the
 *      nested record with a known-distance one and leaves the flat summaries alone; reading that record's
 *      residual under the summary's "two-point" would print a number from another frame.
 *
 * `server/main.ts` cannot be imported, so the manifest builder is read as source in
 * calibration_fields.test.ts, which fails if main.ts stops calling `calibrationFromMeta`.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { calibrationFromMeta } from '../../../server/calibration_fields.ts'
import type { ScanManifest } from '../../../src/world/types.ts'

/**
 * The sidecar of a two-point scan on a return visit, in the shape `uploadToServer` in src/export/gltf.ts wrote
 * before this change: the three calibration expressions and nothing else that matters here. The record is
 * invented, not a measurement: a 2.80 m baseline, a residual of 2.2 cm, a 15 cm tolerance.
 */
const SIDECAR_AS_WRITTEN_BEFORE = `{
  "detectionCount": 0,
  "projectTransform": [0.5702, 0, 0.8215, 0, 0, 1, 0, 0, -0.8215, 0, 0.5702, 0, 0.7226, 1.2, -1.2519, 1],
  "calibrationMethod": "two-point-ground",
  "calibrationStatus": "verified",
  "calibration": {
    "method": "two-point-ground",
    "sessionToProject": [0.5702, 0, 0.8215, 0, 0, 1, 0, 0, -0.8215, 0, 0.5702, 0, 0.7226, 1.2, -1.2519, 1],
    "separationM": 2.80178514522438,
    "residualM": 0.022,
    "toleranceM": 0.15,
    "anchorBearingDeg": 81.5,
    "calibratedAt": "2026-11-01T10:00:00.000Z",
    "status": "verified"
  },
  "pointCount": 1303
}`

const meta = (text: string): Record<string, unknown> => JSON.parse(text)

// ── What reaches the manifest ────────────────────────────────────────────────────────────────

Deno.test('a sidecar written before this change yields the residual, the tolerance and the time, with no new key', () => {
  const fields = calibrationFromMeta(meta(SIDECAR_AS_WRITTEN_BEFORE))
  assertEquals(fields, {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibrationSeparationM: 2.80178514522438,
    calibrationResidualM: 0.022,
    calibrationToleranceM: 0.15,
    calibratedAt: '2026-11-01T10:00:00.000Z',
  })
  // The sidecar has none of the manifest's new field names: it is the nested record that is read.
  for (const key of ['calibrationResidualM', 'calibrationToleranceM', 'calibratedAt']) {
    assert(!(key in meta(SIDECAR_AS_WRITTEN_BEFORE)), `${key} is not a sidecar key`)
  }
})

Deno.test('the editor receives them: every field survives the JSON the server sends', () => {
  const overTheWire = JSON.parse(JSON.stringify(calibrationFromMeta(meta(SIDECAR_AS_WRITTEN_BEFORE))))
  const received: Pick<
    ScanManifest,
    | 'calibrationMethod'
    | 'calibrationStatus'
    | 'calibrationSeparationM'
    | 'calibrationResidualM'
    | 'calibrationToleranceM'
    | 'calibratedAt'
  > = overTheWire
  assertEquals(received.calibrationResidualM, 0.022)
  assertEquals(received.calibrationToleranceM, 0.15)
  assertEquals(received.calibratedAt, '2026-11-01T10:00:00.000Z')
})

Deno.test('a first two-point calibration reports a residual of 0 and keeps it: nothing was compared, and 0 is what the record says', () => {
  const sidecar = meta(SIDECAR_AS_WRITTEN_BEFORE)
  sidecar['calibrationStatus'] = 'provisional'
  ;(sidecar['calibration'] as Record<string, unknown>)['status'] = 'provisional'
  ;(sidecar['calibration'] as Record<string, unknown>)['residualM'] = 0
  const fields = calibrationFromMeta(sidecar)
  assertEquals(fields.calibrationStatus, 'provisional')
  assertEquals(fields.calibrationResidualM, 0, '0 is a number the record holds, not an absent one')
})

Deno.test('a pair kept past a failed check keeps its residual and tolerance, which is how the editor knows it failed', () => {
  const sidecar = meta(SIDECAR_AS_WRITTEN_BEFORE)
  sidecar['calibrationStatus'] = 'provisional'
  Object.assign(sidecar['calibration'] as Record<string, unknown>, { status: 'provisional', residualM: -0.2 })
  const fields = calibrationFromMeta(sidecar)
  assertEquals(fields.calibrationResidualM, -0.2)
  assertEquals(fields.calibrationToleranceM, 0.15)
})

Deno.test('a one-point sidecar has a time and no separation, residual or tolerance: none is invented', () => {
  const fields = calibrationFromMeta(
    meta(`{
      "calibrationMethod": "ground-tap-compass",
      "calibrationStatus": "provisional",
      "calibration": { "method": "ground-tap-compass", "sessionToProject": [], "anchorBearingDeg": 40, "calibratedAt": "2026-11-02T08:30:00.000Z", "status": "provisional" }
    }`),
  )
  assertEquals(fields, {
    calibrationMethod: 'ground-tap-compass',
    calibrationStatus: 'provisional',
    calibrationSeparationM: null,
    calibrationResidualM: null,
    calibrationToleranceM: null,
    calibratedAt: '2026-11-02T08:30:00.000Z',
  })
})

Deno.test('a flat known-distance summary, which the type allows and no writer produces today, maps its own measurements', () => {
  // `calibrationMethod: 'known-distance'` in the flat summary is a shape no build writes: the phone's calibration makes
  // the two other tiers, and the splat-align job (the server's own known-distance tier, server/capture/known_distance.ts)
  // writes its record into the nested `calibration` key only. The reader still maps it, because the tier is in the union
  // and a writer may start to; the next test is the sidecar the server really writes.
  const fields = calibrationFromMeta(
    meta(`{
      "calibrationMethod": "known-distance",
      "calibrationStatus": "provisional",
      "calibration": { "method": "known-distance", "sessionToProject": [], "separationM": 3.2, "residualM": 0.02, "toleranceM": 0.15, "gravityAligned": true, "calibratedAt": "2026-11-03T09:00:00.000Z", "status": "provisional" }
    }`),
  )
  assertEquals(fields.calibrationMethod, 'known-distance')
  assertEquals(fields.calibrationSeparationM, 3.2)
  assertEquals(fields.calibrationResidualM, 0.02)
  assertEquals(fields.calibrationToleranceM, 0.15)
  assertEquals(fields.calibratedAt, '2026-11-03T09:00:00.000Z')
})

Deno.test("the sidecar splat-align really writes for a scan with no calibration of its own reaches the editor as no calibration at all", () => {
  // `_runSplatAlignJob` (server/main.ts) writes only `meta['calibration'] = result.calibration`, a known-distance record,
  // into the sidecar of a scan that never calibrated on a phone (a tripod or video capture): the flat summaries stay
  // null and 'uncalibrated'. That scan is placed by GPS or the grid, not by this record, and the record's separation,
  // residual and tolerance describe a camera solve, not the frame the scan sits in. So the manifest carries no tier,
  // no measurements and no time for it, and the scan list keeps the GPS text it always had for such a scan.
  // (Whether to show that the splat was sized is a product decision that needs a manifest field saying what it applies
  // to: promoting the tier into calibrationMethod would change what server/memory_push.ts ships.)
  const fields = calibrationFromMeta(
    meta(`{
      "sessionId": "sess-video-20260830-163024",
      "calibrationMethod": null,
      "calibrationStatus": "uncalibrated",
      "calibration": { "method": "known-distance", "sessionToProject": [], "separationM": 3, "residualM": 0.004, "toleranceM": 0.15, "gravityAligned": true, "calibratedAt": "2026-11-03T09:00:00.000Z", "status": "provisional" }
    }`),
  )
  assertEquals(fields, {
    calibrationMethod: undefined,
    calibrationStatus: 'uncalibrated',
    calibrationSeparationM: null,
    calibrationResidualM: null,
    calibrationToleranceM: null,
    calibratedAt: null,
  })
  // And with no flat summary key at all, as for a sidecar written by a session registration rather than gltf.ts.
  assertEquals(
    calibrationFromMeta(meta(`{ "sessionId": "s", "calibration": { "method": "known-distance", "separationM": 3, "residualM": 0.004, "toleranceM": 0.15, "status": "provisional", "calibratedAt": "2026-11-03T09:00:00.000Z" } }`)),
    {
      calibrationMethod: undefined,
      calibrationStatus: undefined,
      calibrationSeparationM: null,
      calibrationResidualM: null,
      calibrationToleranceM: null,
      calibratedAt: null,
    },
  )
})

Deno.test('a scan that never calibrated has no tier and no measurements, and says "uncalibrated"', () => {
  // What gltf.ts writes for a scan with no calibration: null, 'uncalibrated', null.
  const fields = calibrationFromMeta(
    meta('{ "calibrationMethod": null, "calibrationStatus": "uncalibrated", "calibration": null }'),
  )
  assertEquals(fields, {
    calibrationMethod: undefined,
    calibrationStatus: 'uncalibrated',
    calibrationSeparationM: null,
    calibrationResidualM: null,
    calibrationToleranceM: null,
    calibratedAt: null,
  })
  assertEquals('calibrationMethod' in JSON.parse(JSON.stringify(fields)), false, 'the key stays off the manifest, as before')
})

Deno.test('a sidecar with none of the keys at all (a scan uploaded before calibration existed) yields nothing, not an error', () => {
  assertEquals(calibrationFromMeta({}), {
    calibrationMethod: undefined,
    calibrationStatus: undefined,
    calibrationSeparationM: null,
    calibrationResidualM: null,
    calibrationToleranceM: null,
    calibratedAt: null,
  })
})

Deno.test('the tier and the status are the flat summaries, as they always were, whatever the nested record says', () => {
  // gltf.ts writes both from one record, so they agree in every sidecar it wrote; where they do not, the flat
  // summary is what the scan was placed by (projectTransform is written beside it), so it is what is reported.
  const fields = calibrationFromMeta({
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibration: { method: 'two-point-ground', status: 'provisional', separationM: 2.8, residualM: 0.01, toleranceM: 0.15 },
  })
  assertEquals(fields.calibrationStatus, 'verified')
  assertEquals(fields.calibrationMethod, 'two-point-ground')
  // And a record with no flat summary at all does not make a calibrated scan of it: the scan was placed by GPS or the
  // grid, so an anchor decal drawn for a "calibration" would mislead (addAnchorMarker in src/viewer/viewer.ts).
  const nestedOnly = calibrationFromMeta({
    calibration: { method: 'two-point-ground', status: 'verified', separationM: 2.8, residualM: 0.01, toleranceM: 0.15 },
  })
  assertEquals(nestedOnly.calibrationMethod, undefined)
  assertEquals(nestedOnly.calibrationStatus, undefined)
})

// ── A record that is another tier's ──────────────────────────────────────────────────────────

Deno.test("the splat-align job's known-distance record does not lend its measurements to the scan's two-point tier", () => {
  // `_runSplatAlignJob` writes `meta['calibration'] = result.calibration` (known-distance) into the sidecar and
  // leaves `calibrationMethod: 'two-point-ground'` and `projectTransform` alone. The scan is still placed by the
  // two-point matrix, so it is still two-point; the residual in the record now belongs to a camera-solve fit.
  const sidecar = meta(SIDECAR_AS_WRITTEN_BEFORE)
  sidecar['calibration'] = {
    method: 'known-distance',
    sessionToProject: [],
    separationM: 3.2,
    residualM: 0.001,
    toleranceM: 0.5,
    gravityAligned: true,
    calibratedAt: '2026-11-09T12:00:00.000Z',
    status: 'provisional',
  }
  const fields = calibrationFromMeta(sidecar)
  assertEquals(fields.calibrationMethod, 'two-point-ground', 'the tier the scan is placed by')
  assertEquals(fields.calibrationStatus, 'verified')
  assertEquals(fields.calibrationSeparationM, null, 'a known-distance separation is not this scan two-point baseline')
  assertEquals(fields.calibrationResidualM, null)
  assertEquals(fields.calibrationToleranceM, null)
  assertEquals(fields.calibratedAt, null)
})

Deno.test('a record for a tier the flat summary does not report is left out, in both directions', () => {
  // Summary says nothing (uncalibrated at upload), record names a tier: it describes something the manifest does not claim.
  const summaryless = calibrationFromMeta(
    meta(`{ "calibrationMethod": null, "calibrationStatus": "uncalibrated",
            "calibration": { "method": "known-distance", "separationM": 3.2, "residualM": 0.02, "toleranceM": 0.15, "calibratedAt": "2026-11-03T09:00:00.000Z" } }`),
  )
  assertEquals(summaryless.calibrationMethod, undefined)
  assertEquals(summaryless.calibrationSeparationM, null)
  assertEquals(summaryless.calibrationResidualM, null)
  // Summary says one-point, record says two-point.
  const other = calibrationFromMeta(
    meta(`{ "calibrationMethod": "ground-tap-compass", "calibrationStatus": "provisional",
            "calibration": { "method": "two-point-ground", "separationM": 2.8, "residualM": 0.02, "toleranceM": 0.15 } }`),
  )
  assertEquals(other.calibrationMethod, 'ground-tap-compass')
  assertEquals(other.calibrationSeparationM, null)
  assertEquals(other.calibrationResidualM, null)
})

Deno.test('a nested record that names no tier of its own is read as it always was', () => {
  // Cannot be shown to be another tier's, and a sidecar like this was read this way before this change.
  const fields = calibrationFromMeta(
    meta(`{ "calibrationMethod": "two-point-ground", "calibrationStatus": "verified", "calibration": { "separationM": 2.8, "residualM": 0.03, "toleranceM": 0.15 } }`),
  )
  assertEquals(fields.calibrationSeparationM, 2.8)
  assertEquals(fields.calibrationResidualM, 0.03)
  assertEquals(fields.calibrationToleranceM, 0.15)
})

// ── Inputs the readers must refuse ───────────────────────────────────────────────────────────

Deno.test('a measurement that is not a finite number is absent, never a coerced one', () => {
  const bad: unknown[] = ['0.022', '', 'NaN', null, true, false, [0.022], [], {}, { value: 0.022 }, Object(0.022), undefined]
  for (const value of bad) {
    const fields = calibrationFromMeta({
      calibrationMethod: 'two-point-ground',
      calibrationStatus: 'verified',
      calibration: { method: 'two-point-ground', separationM: value, residualM: value, toleranceM: value },
    })
    assertEquals(fields.calibrationSeparationM, null, `separationM ${Deno.inspect(value)}`)
    assertEquals(fields.calibrationResidualM, null, `residualM ${Deno.inspect(value)}`)
    assertEquals(fields.calibrationToleranceM, null, `toleranceM ${Deno.inspect(value)}`)
  }
  // JSON cannot carry these, but a hand-built meta can, and NaN would print "NaN cm off".
  for (const value of [NaN, Infinity, -Infinity]) {
    const fields = calibrationFromMeta({
      calibrationMethod: 'two-point-ground',
      calibration: { method: 'two-point-ground', residualM: value, toleranceM: value },
    })
    assertEquals(fields.calibrationResidualM, null, `${value} is not a length`)
    assertEquals(fields.calibrationToleranceM, null)
  }
})

Deno.test('a calibration time that is not an ISO date-time is absent, including a string that only happens to parse', () => {
  const notIso: unknown[] = [
    '', 'not a date', 'yesterday', null, 0, 1730455200000, true, {}, [], ['2026-11-01T10:00:00.000Z'],
    // These parse as dates in V8 ("1" is the year 2001) and as other dates, or none, elsewhere; the record promises an ISO time.
    '1', '2001', '2026-11-01', 'Nov 1 2026', '2026-11-01 10:00:00Z', '2026-11-01T10:00Z', '2026-11-01T10:00:00',
    // The right shape and no such month.
    '2026-13-01T10:00:00.000Z',
  ]
  for (const calibratedAt of notIso) {
    const fields = calibrationFromMeta({
      calibrationMethod: 'two-point-ground',
      calibration: { method: 'two-point-ground', calibratedAt },
    })
    assertEquals(fields.calibratedAt, null, `calibratedAt ${Deno.inspect(calibratedAt)}`)
  }
})

Deno.test('a calibration time as toISOString writes it, with or without milliseconds or with an offset, is kept as written', () => {
  for (const calibratedAt of ['2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00.5+01:00', '2026-11-01T10:00:00-05:30']) {
    const fields = calibrationFromMeta({
      calibrationMethod: 'two-point-ground',
      calibration: { method: 'two-point-ground', calibratedAt },
    })
    assertEquals(fields.calibratedAt, calibratedAt)
  }
})

Deno.test('a calibration record that is not an object yields no measurements, whatever it is', () => {
  for (const record of [null, undefined, 2.8, '2.8', 'two-point-ground', true, false, 0, [], [2.8], () => 2.8]) {
    const fields = calibrationFromMeta({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', calibration: record })
    assertEquals(fields.calibrationMethod, 'two-point-ground', 'the summary still stands')
    assertEquals(fields.calibrationSeparationM, null)
    assertEquals(fields.calibrationResidualM, null)
    assertEquals(fields.calibrationToleranceM, null)
    assertEquals(fields.calibratedAt, null)
  }
})

Deno.test('the residual and tolerance are read as stored, never recomputed from the separation', () => {
  // A record whose residual does not equal anything derivable from its numbers is passed on as it is: the
  // editor prints what the capture measured, not what a formula says it should have.
  const fields = calibrationFromMeta({
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibration: { method: 'two-point-ground', separationM: 2.8, residualM: 0.123, toleranceM: 0.15 },
  })
  assertEquals(fields.calibrationResidualM, 0.123)
})
