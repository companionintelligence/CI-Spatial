/**
 * bypassed_scan_membership.test.ts — the server counts a scan that is in no Place frame as one that is not (ADR 0011 decision 3).
 * Run: deno test --allow-read tests/unit/deno/bypassed_scan_membership.test.ts
 *
 * A commit whose floor check was bypassed ("Place anchor without floor check", or an off-floor tap accepted by a retry) writes no
 * Place frame (#269). When it was not compared with the frame the Place holds either, or was and was kept over a mismatch, the scan
 * is placed by its own pair alone, and its calibration says so (`outsidePlaceFrame: true`, written by src/ar/calibration-commit.ts).
 * Before this was read, `isInPlaceFrame` was a test of the tier alone: such a scan was counted under the Place's generation or as an
 * unknown one, taken into Thing matching with positions that are in no frame the Things' are in, and counted in what a replacement of
 * the frame would strand.
 *
 * The sidecars below are written out by hand, as a phone uploads them, so that the reader is held to the contract and not to the code
 * that writes it. tests/unit/node/wp-bypass-membership.test.ts runs the other direction: the real writer and the real exporter into
 * these same readers, so a writer and a reader that disagree cannot both pass.
 *
 * Four things: the one predicate every counter asks; what `calibrationFromMeta` reads and does not (it is the one reader the scan
 * list, the status counts and the moves all go through); the counts, the Thing-matching filter and the move guard built on them; and
 * that nothing a sidecar written before the marker said has changed.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import {
  asOutsidePlaceFrame,
  calibrationEvidenceFromMeta,
  calibrationFromMeta,
} from '../../../server/calibration_fields.ts'
import { decideReassignFrames, frameStatusOf, tallyScansByFrame } from '../../../server/place_frames.ts'
import { scansLeftOutNote, scanTakesPartInThingMatching } from '../../../server/thing_match.ts'
import { isInPlaceFrame, outsidePlaceFrameOf } from '../../../src/world/frame-generations.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** The nested record a two-point commit writes, with what a test overrides. */
const twoPointRecord = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'two-point-ground',
  sessionToProject: IDENTITY,
  separationM: 3,
  residualM: 0,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  calibratedAt: '2026-11-17T09:00:00.000Z',
  status: 'provisional',
  groundY: -1.2,
  floorCheckBypassed: true,
  ...extra,
})

/** The sidecar of a two-point scan: the flat summaries, the generation it names when it names one, and the record. */
const sidecar = (record: Record<string, unknown>, flat: Record<string, unknown> = {}): Record<string, unknown> => ({
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'provisional',
  projectTransform: IDENTITY,
  calibration: record,
  ...flat,
})

const OUTSIDE = sidecar(twoPointRecord({ outsidePlaceFrame: true }))
const MATCHED_G1 = sidecar(twoPointRecord({ frameId: 'g1', checkedBy: 'separation' }), { calibrationFrameId: 'g1' })
const UNKNOWN_GENERATION = sidecar(twoPointRecord({ checkedBy: 'separation' }))
const ONE_POINT = { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional', calibration: { method: 'ground-tap-compass', status: 'provisional', sessionToProject: IDENTITY, anchorBearingDeg: 12, calibratedAt: '2026-11-17T09:00:00.000Z' } }
const UNCALIBRATED = { calibrationMethod: null, calibrationStatus: 'uncalibrated', calibration: null }

// ── 1. The one predicate ─────────────────────────────────────────────────────────────────────────

Deno.test('a scan is in the Place frame when it is two-point, calibrated, and not recorded as in no frame', () => {
  const table: Array<[unknown, unknown, unknown, boolean]> = [
    ['two-point-ground', 'verified', undefined, true],
    ['two-point-ground', 'provisional', undefined, true],
    ['two-point-ground', 'provisional', true, false],
    ['two-point-ground', 'verified', true, false],
    ['two-point-ground', 'uncalibrated', undefined, false],
    ['ground-tap-compass', 'provisional', undefined, false],
    ['ground-tap-compass', 'provisional', true, false],
    ['known-distance', 'provisional', undefined, false],
    [undefined, undefined, undefined, false],
    [undefined, 'uncalibrated', undefined, false],
    // The statement is the boolean true and nothing that merely looks like it; anything else says nothing and the scan reads as before.
    ['two-point-ground', 'provisional', false, true],
    ['two-point-ground', 'provisional', 'true', true],
    ['two-point-ground', 'provisional', 1, true],
    ['two-point-ground', 'provisional', null, true],
  ]
  for (const [calibrationMethod, calibrationStatus, calibrationOutsidePlaceFrame, expected] of table) {
    assertEquals(
      isInPlaceFrame({ calibrationMethod, calibrationStatus, calibrationOutsidePlaceFrame }),
      expected,
      `${calibrationMethod} ${calibrationStatus} outside=${String(calibrationOutsidePlaceFrame)}`,
    )
  }
})

Deno.test('Thing matching takes the scans the predicate does, and says how many it left out', () => {
  const manifests = [OUTSIDE, MATCHED_G1, UNKNOWN_GENERATION, ONE_POINT, UNCALIBRATED].map(calibrationFromMeta)
  assertEquals(manifests.map(scanTakesPartInThingMatching), [false, true, true, false, false])
  const left = manifests.filter((scan) => !scanTakesPartInThingMatching(scan)).length
  assertEquals(scansLeftOutNote(left), ' 3 scans were left out: they are not in the Place frame.')
})

// ── 2. What the reader takes from a sidecar ──────────────────────────────────────────────────────

Deno.test('a two-point record that says it is in no frame is read, from the record and from the flat key, and only as the boolean true', () => {
  assertEquals(calibrationFromMeta(OUTSIDE).calibrationOutsidePlaceFrame, true)
  // The flat key, as the frame id's is, outlives the job that replaces the nested record.
  const afterJob = { ...sidecar({ method: 'known-distance', separationM: 3.2, residualM: 0.02, toleranceM: 0.1 }, { calibrationOutsidePlaceFrame: true }) }
  assertEquals(calibrationFromMeta(afterJob).calibrationOutsidePlaceFrame, true)
  assertEquals(asOutsidePlaceFrame(undefined, true), true)
  assertEquals(asOutsidePlaceFrame(twoPointRecord({ outsidePlaceFrame: true })), true)
  for (const value of [false, 'true', 1, null, {}, [], 'yes']) {
    assertEquals(asOutsidePlaceFrame(twoPointRecord({ outsidePlaceFrame: value })), undefined, `${JSON.stringify(value)} in the record`)
    assertEquals(asOutsidePlaceFrame(undefined, value), undefined, `${JSON.stringify(value)} in the flat key`)
    assertEquals(outsidePlaceFrameOf({ outsidePlaceFrame: value }), false)
  }
  assertEquals(outsidePlaceFrameOf(null), false)
  assertEquals(outsidePlaceFrameOf(undefined), false)
})

Deno.test('the statement is read for a two-point scan only, and for the record that backs the tier', () => {
  // Another tier has no Place frame generation to be in or out of, and says what it always said.
  const onePointClaims = { ...ONE_POINT, calibration: { ...ONE_POINT.calibration, outsidePlaceFrame: true } }
  assertFalse('calibrationOutsidePlaceFrame' in calibrationFromMeta(onePointClaims))
  // A record of another tier under a two-point summary is the job's replacement, and its statements are not this scan's.
  const replaced = sidecar({ method: 'known-distance', separationM: 3.2, residualM: 0.02, toleranceM: 0.1, outsidePlaceFrame: true })
  assertFalse('calibrationOutsidePlaceFrame' in calibrationFromMeta(replaced))
  // The limit, in its own words: with the statement only in the nested record, a job that replaces that record loses it, which is
  // what the flat key is for (src/export/gltf.ts writes the generation flat for the same reason).
  assertFalse('calibrationOutsidePlaceFrame' in calibrationFromMeta({ ...OUTSIDE, calibration: replaced['calibration'] }))
})

Deno.test('a sidecar that does not say it is in no frame reads exactly as it did: no key, and the five evidence keys are the five', () => {
  for (const meta of [MATCHED_G1, UNKNOWN_GENERATION, ONE_POINT, UNCALIBRATED, sidecar(twoPointRecord({ outsidePlaceFrame: false }))]) {
    assertFalse('calibrationOutsidePlaceFrame' in calibrationFromMeta(meta))
  }
  assertEquals(Object.keys(calibrationEvidenceFromMeta(OUTSIDE)).sort(), [
    'calibrationCheckedBy',
    'calibrationFitMaxM',
    'calibrationFitPointsUsed',
    'calibrationFitRmsM',
    'calibrationFrameId',
  ])
  // What it says of the rest of the record is unchanged by the marker beside it.
  const { calibrationOutsidePlaceFrame: _marker, ...rest } = calibrationFromMeta(OUTSIDE)
  assertEquals(rest, calibrationFromMeta(sidecar(twoPointRecord())))
})

// ── 3. The counts, and the guard on a moved scan ─────────────────────────────────────────────────

const frame = (frameId?: string): ProjectSpatialFrame => ({
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  ...(frameId ? { frameId } : {}),
}) as ProjectSpatialFrame

const place = (spatialFrame?: ProjectSpatialFrame): Project =>
  ({ projectId: 'place-1', name: 'Kitchen', createdAt: 0, updatedAt: 0, floors: [], spatialFrame, spatialFrameRevision: 2 }) as unknown as Project

Deno.test('the Place\'s counts put a scan that is in no frame with the scans that are not in one, never under a generation', () => {
  const counts = tallyScansByFrame([MATCHED_G1, OUTSIDE, OUTSIDE, UNKNOWN_GENERATION, ONE_POINT, UNCALIBRATED])
  assertEquals(counts, {
    scanCount: 6,
    scansByFrame: { g1: 1 },
    unrecordedScans: 1,
    notInFrameScans: 4,
  })
  // What a replacement of the frame the Place holds would strand: the scans measured against it.
  assertEquals(frameStatusOf(place(frame('g1')), counts).scansOnCurrentFrame, 1)
  // A Place whose frame has no id counts the scans that name none, which are the ones that were in it: a scan that is in no frame is not one.
  assertEquals(frameStatusOf(place(frame()), counts).scansOnCurrentFrame, 1)
  // A Place with no frame has nothing to replace, and the first visit that wrote none leaves it with none.
  assertEquals(frameStatusOf(place(undefined), tallyScansByFrame([OUTSIDE, OUTSIDE])).scansOnCurrentFrame, 0)
})

Deno.test('two first visits that bypassed the floor check are two scans in no frame, not two comparable scans of an unknown generation', () => {
  const second = sidecar(twoPointRecord({ outsidePlaceFrame: true, separationM: 3.7 }))
  assertEquals(tallyScansByFrame([OUTSIDE, second]), { scanCount: 2, scansByFrame: {}, unrecordedScans: 0, notInFrameScans: 2 })
})

Deno.test('a scan that is in no frame moves between Places freely; one that is in a frame is held to it, named or not', () => {
  const held = place(frame('g1'))
  const elsewhere = { ...place(frame('g-other')), projectId: 'place-2' } as Project
  const move = (meta: Record<string, unknown>) => decideReassignFrames(calibrationFromMeta(meta), held, elsewhere).kind
  assertEquals(move(OUTSIDE), 'agree', 'it has no frame to disagree about')
  assertEquals(move(MATCHED_G1), 'mismatch', 'a scan of the frame the Place holds is refused a Place that holds another, unless the person says so')
  assertEquals(decideReassignFrames(calibrationFromMeta(OUTSIDE), held, { ...place(undefined), projectId: 'place-3' } as Project).kind, 'agree', 'and into a Place with no frame, which takes no frame for it')
})

// ── 4. The wiring, read as text ──────────────────────────────────────────────────────────────────

Deno.test('source shape: Thing matching asks the predicate before it reads a scan, and the manifest carries what it reads', async () => {
  const main = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))
  const count = main.indexOf('const scansLeftOut = world.scans.filter(scan => !scanTakesPartInThingMatching(scan)).length')
  assert(count !== -1, 'the job no longer counts the scans it leaves out with scanTakesPartInThingMatching')
  const start = main.indexOf('async function detectionLikesForWorld(')
  assert(start !== -1, 'detectionLikesForWorld moved')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  assert(body.indexOf('if (!scanTakesPartInThingMatching(scan)) continue') !== -1, 'a scan that is not in the Place frame is no longer left out of the detections')
  assert(body.indexOf('if (!scanTakesPartInThingMatching(scan)) continue') < body.indexOf('readTextFile'), 'and it is left out before its sidecar is read')
  const builder = main.slice(main.indexOf('function scanManifestFromStored('), main.indexOf('\n}\n', main.indexOf('function scanManifestFromStored(')))
  assert(builder.includes('...calibrationFromMeta(scan.meta)'), 'the manifest the filter reads is built by the reader that projects the statement')
})
