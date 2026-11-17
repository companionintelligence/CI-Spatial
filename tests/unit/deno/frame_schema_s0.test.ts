/**
 * frame_schema_s0.test.ts — the S0 schema step as the server and the type checker see it.
 * Run: deno test --allow-read tests/unit/deno/frame_schema_s0.test.ts
 *
 * Four things, none of which a Node test can check:
 *
 *  1. The types. `deno test` type-checks this file, so a line here that must compile and does not, or a line marked
 *     `@ts-expect-error` that does compile, fails the run. That is how the shapes the work packages after S0 build on
 *     (`frameId`, `checkPoints`, `frameHistory`, `georeference`, the manifest's placement fields) are pinned: they
 *     are written out as typed values, and the ways they must NOT be writable are written out as errors.
 *  2. The tables. `SPATIAL_FRAME_FIELDS` and `SPATIAL_FRAME_METHODS` are held to the frame type at compile time
 *     (src/world/spatial-frame.ts); the checks here repeat that from outside, so that a change to the guard itself
 *     is noticed too.
 *  3. `calibrationFromMeta` (server/calibration_fields.ts) reading the five new manifest fields, each one only when
 *     the sidecar has it and only for a record that can have it, never saying a measurement was made that the record
 *     does not hold (a fit of fewer than three points, a "constellation" with no fit), and never changing what an
 *     older sidecar yields; and `calibrationEvidenceFromMeta`, the same five as keys, which is what lets a world
 *     refresh clear a value the sidecar no longer gives.
 *  4. The server's hooks: `isPlaceCalibrated` asks the shared predicate and names no tier of its own, and
 *     `placeFromBody` carries the three Place fields only the server writes through a whole-record PUT.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import {
  asCalibrationCheckedBy,
  asCalibrationFitMaxM,
  asCalibrationFitPointsUsed,
  asCalibrationFitRmsM,
  asCalibrationFrameId,
  calibrationEvidenceFromMeta,
  calibrationFromMeta,
  type CalibrationEvidenceFields,
  type ManifestCalibrationFields,
} from '../../../server/calibration_fields.ts'
import { isPlaceCalibrated } from '../../../server/register/place_register.ts'
import { applySpatialFrameWrite, placeFromBody } from '../../../server/wp-a-projects.ts'
import {
  SPATIAL_FRAME_FIELDS,
  SPATIAL_FRAME_METHODS,
  isPlaceFrameMethod,
  validateSpatialFrame,
  type SpatialFrameMethod,
} from '../../../src/world/spatial-frame.ts'
import type { CheckedBy, FitSummary as FitSummaryOfCalibration, TapEvidence } from '../../../src/world/calibration-evidence.ts'
import { MAX_FIT_POINTS, type FitSummary } from '../../../src/world/frame-fit.ts'
import type {
  FrameCheckPoint,
  FrameHistoryEntry,
  FrameReplaceReason,
  Project,
  ProjectGeoreference,
  ProjectSpatialFrame,
  ScanCalibration,
  ScanManifest,
  ScanPlacementSource,
} from '../../../src/world/types.ts'

type TwoPointFrame = Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
type OnePointFrame = Extract<ProjectSpatialFrame, { method: 'ground-tap-compass' }>
type TwoPointCalibration = Extract<ScanCalibration, { method: 'two-point-ground' }>
type OnePointCalibration = Extract<ScanCalibration, { method: 'ground-tap-compass' }>

// ── 1 and 2. Compile-time checks ─────────────────────────────────────────────────────────────────
//
// `Equal` is true only for identical types; `MustBe` is a compile error for anything else. Each alias below is an
// error at its own line when the two sides drift apart, and costs nothing at run time.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type MustBe<T extends true> = T

/** The methods the list names are the methods the type declares, and every one is also a calibration method. */
type _MethodsMatchTheType = MustBe<Equal<SpatialFrameMethod, ProjectSpatialFrame['method']>>
type _EveryFrameMethodIsACalibrationMethod = MustBe<Equal<Extract<ScanCalibration['method'], SpatialFrameMethod>, SpatialFrameMethod>>
/** The tables list the keys of each member, no more and no fewer. */
type _TwoPointFieldsAreTheType = MustBe<Equal<keyof (typeof SPATIAL_FRAME_FIELDS)['two-point-ground'], keyof TwoPointFrame>>
type _OnePointFieldsAreTheType = MustBe<Equal<keyof (typeof SPATIAL_FRAME_FIELDS)['ground-tap-compass'], keyof OnePointFrame>>
type _OneEntryPerMethod = MustBe<Equal<keyof typeof SPATIAL_FRAME_FIELDS, ProjectSpatialFrame['method']>>

/** The fit and the tap are stored as the module that builds them declares them: one type, not a copy. */
type _FitIsTheFitModulesType = MustBe<Equal<NonNullable<TwoPointCalibration['fit']>, FitSummary>>
type _FitIsTheLeafsType = MustBe<Equal<FitSummary, FitSummaryOfCalibration>>
type _TapIsTheEvidence = MustBe<Equal<NonNullable<TwoPointCalibration['tap']>, TapEvidence>>
type _CheckedByIsTheVerdictsType = MustBe<Equal<NonNullable<TwoPointCalibration['checkedBy']>, CheckedBy>>
type _CheckedByHasTwoValues = MustBe<Equal<CheckedBy, 'separation' | 'constellation'>>
type _ManifestFrameIdIsOptionalText = MustBe<Equal<ScanManifest['calibrationFrameId'], string | undefined>>
/** What `calibrationFromMeta` fills: the six it always did and the five S0 added. */
type _ManifestFieldsFilled = MustBe<
  Equal<
    keyof ManifestCalibrationFields,
    | 'calibrationMethod'
    | 'calibrationStatus'
    | 'calibrationSeparationM'
    | 'calibrationResidualM'
    | 'calibrationToleranceM'
    | 'calibratedAt'
    | 'calibrationFrameId'
    | 'calibrationCheckedBy'
    | 'calibrationFitPointsUsed'
    | 'calibrationFitRmsM'
    | 'calibrationFitMaxM'
  >
>
/** The Place's new fields are all optional: a Place saved before them is still a Place. */
type _PlaceFieldsAreOptional = MustBe<
  Equal<
    Pick<Project, 'frameHistory' | 'georeference' | 'georefVersion'>,
    { frameHistory?: FrameHistoryEntry[]; georeference?: ProjectGeoreference; georefVersion?: number }
  >
>
type _ReasonsAreTheThreeWritersStates = MustBe<Equal<FrameReplaceReason, 'override' | 'upgrade' | 'merge'>>
type _PlacementSources = MustBe<Equal<ScanPlacementSource, 'place-frame' | 'georeference' | 'gps-compass' | 'grid'>>

// The shapes the packages after S0 build on, written out as values. They must compile, and the ways they must not be
// writable are errors below.

const UUID = '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607'

const checkPoint: FrameCheckPoint = {
  x: 2,
  y: 0,
  z: 1.5,
  label: 'sink',
  photo: {
    url: `/projects/proj-1700000000000/frames/${UUID}/ref-check1.jpg`,
    localKey: `proj-1700000000000:${UUID}:check1`,
    tapPoint: { x: 0.5, y: 0.5 },
    pose: { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    capturedAt: '2026-11-16T09:29:00.000Z',
  },
}

const frame: ProjectSpatialFrame = {
  version: 1,
  createdAt: '2026-11-16T09:30:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.15,
  anchorBearingDeg: 10,
  frameId: UUID,
  checkPoints: [checkPoint],
}

const fit: FitSummary = {
  fitMethod: 'rigid',
  pointsUsed: 3,
  rmsResidualM: 0.021,
  maxResidualM: 0.034,
  perPoint: [{ residualM: 0.02, dx: 0.01, dy: 0, dz: 0.02 }],
  headingResidualDeg: 0.4,
  scaleRatio: 1.003,
}

const calibration: ScanCalibration = {
  method: 'two-point-ground',
  sessionToProject: new Array(16).fill(0),
  separationM: 3.01,
  residualM: 0.01,
  toleranceM: 0.15,
  anchorBearingDeg: 10,
  calibratedAt: '2026-11-17T10:00:00.000Z',
  status: 'verified',
  frameId: UUID,
  fit,
  checkedBy: 'constellation',
  tap: { tapSpreadM: 0.012, tapRangeM: 1.8, tapSource: 'burst', landmarkAboveFloorM: 0.01 },
}

const georeference: ProjectGeoreference = {
  origin: { lat: 51.5007, lng: -0.1246, altitudeM: 11, accuracyM: 3.5 },
  heightDatum: 'ellipsoid',
  bearingDeg: 30,
  bearingAccuracyDeg: 1,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  declination: { deg: 0.5, model: 'WMM2025', year: 2026.87 },
  seed: { fixAccuracyM: 4.2 },
  registeredAt: '2026-11-16T09:30:00.000Z',
  confirmedAt: '2026-11-16T09:31:00.000Z',
  anchorRef: UUID,
}

const history: FrameHistoryEntry = {
  frameId: null,
  createdAt: '2026-11-01T09:30:00.000Z',
  method: 'ground-tap-compass',
  separationM: null,
  supersededAt: '2026-11-16T09:30:00.000Z',
  reason: 'upgrade',
}

const place: Project = {
  projectId: 'proj-1700000000000',
  name: 'Room',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  floors: [],
  spatialFrame: frame,
  spatialFrameRevision: 2,
  frameHistory: [history],
  georeference,
  georefVersion: 1,
}

Deno.test('compile time: the shapes the next packages build on are writable as written, and the unsafe ones are not', () => {
  // A seed has no confirmation; an origin may have no height; a legacy frame has no id.
  const seed: ProjectGeoreference = { ...georeference, source: 'gps-compass', heightDatum: 'unknown', origin: { ...georeference.origin, altitudeM: null } }
  delete seed.confirmedAt
  const manifest: Pick<ScanManifest, 'calibrationFrameId' | 'placementSource' | 'placementUncertaintyM' | 'placementStale'> = {
    calibrationFrameId: UUID,
    placementSource: 'georeference',
    placementUncertaintyM: 3.6,
    placementStale: true,
  }
  assertEquals(manifest.placementSource, 'georeference')
  assertEquals(seed.confirmedAt, undefined)

  // @ts-expect-error: the corrected sign rule is the only one a georeference records
  const wrongConvention: ProjectGeoreference = { ...georeference, convention: 1 }
  // @ts-expect-error: the datum is WGS84
  const wrongDatum: ProjectGeoreference = { ...georeference, datum: 'NAD83' }
  // @ts-expect-error: a source the record does not know
  const wrongSource: ProjectGeoreference = { ...georeference, source: 'guess' }
  // @ts-expect-error: the height datum is the ellipsoid or unknown, never mean sea level by accident
  const wrongHeightDatum: ProjectGeoreference = { ...georeference, heightDatum: 'geoid' }
  // @ts-expect-error: no registration without an origin position
  const noOrigin: ProjectGeoreference = { ...georeference, origin: { lat: 51.5, lng: -0.12, accuracyM: 3.5 } }
  // @ts-expect-error: `reset` is deferred: a frame is replaced as an override, an upgrade or a merge
  const resetReason: FrameHistoryEntry = { ...history, reason: 'reset' }
  // @ts-expect-error: a one-point scan is not in a Place frame generation, so it carries no frame id
  const onePointWithId: OnePointCalibration = { method: 'ground-tap-compass', sessionToProject: [], anchorBearingDeg: 0, calibratedAt: 'x', status: 'provisional', frameId: UUID }
  // @ts-expect-error: nor a fit: a single anchor measures nothing against itself (ADR 0005 rule 3)
  const onePointWithFit: OnePointCalibration = { method: 'ground-tap-compass', sessionToProject: [], anchorBearingDeg: 0, calibratedAt: 'x', status: 'provisional', fit }
  // @ts-expect-error: a source the placement does not know
  const wrongPlacement: Pick<ScanManifest, 'placementSource'> = { placementSource: 'phone' }
  // @ts-expect-error: a check is by separation or by constellation
  const wrongCheck: Pick<TwoPointCalibration, 'checkedBy'> = { checkedBy: 'photo' }
  void [wrongConvention, wrongDatum, wrongSource, wrongHeightDatum, noOrigin, resetReason, onePointWithId, onePointWithFit, wrongPlacement, wrongCheck]
})

Deno.test('the typed values are what the validator and the readers accept: the frame validates, the record reads', () => {
  const check = validateSpatialFrame(JSON.parse(JSON.stringify(frame)), { projectId: place.projectId })
  assert(check.ok, check.ok ? '' : check.error)
  assertEquals(check.frame, frame)
  const fields = calibrationFromMeta({ calibrationMethod: 'two-point-ground', calibrationStatus: 'verified', calibration })
  assertEquals(fields.calibrationFrameId, UUID)
  assertEquals(fields.calibrationCheckedBy, 'constellation')
  assertEquals(fields.calibrationFitPointsUsed, 3)
  assertEquals(fields.calibrationFitRmsM, 0.021)
  assertEquals(fields.calibrationFitMaxM, 0.034)
})

Deno.test('the tables and the predicate agree with the type at run time as well', () => {
  assertEquals([...SPATIAL_FRAME_METHODS].sort(), ['ground-tap-compass', 'two-point-ground'])
  assertEquals(Object.keys(SPATIAL_FRAME_FIELDS).sort(), [...SPATIAL_FRAME_METHODS].sort())
  const calibrationMethods: Record<ScanCalibration['method'], boolean> = {
    'two-point-ground': true,
    'ground-tap-compass': true,
    'known-distance': false,
  }
  for (const [method, defines] of Object.entries(calibrationMethods)) assertEquals(isPlaceFrameMethod(method), defines, method)
})

// ── 3. calibrationFromMeta ───────────────────────────────────────────────────────────────────────

const LEGACY_KEYS = ['calibratedAt', 'calibrationMethod', 'calibrationResidualM', 'calibrationSeparationM', 'calibrationStatus', 'calibrationToleranceM']
const NEW_KEYS = ['calibrationCheckedBy', 'calibrationFitMaxM', 'calibrationFitPointsUsed', 'calibrationFitRmsM', 'calibrationFrameId']

/** A record as a two-point scan's sidecar carries it. */
const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'two-point-ground',
  sessionToProject: [],
  separationM: 3.01,
  residualM: 0.01,
  toleranceM: 0.15,
  anchorBearingDeg: 10,
  calibratedAt: '2026-11-17T10:00:00.000Z',
  status: 'verified',
  ...over,
})
const twoPointSidecar = (calibration: unknown, flat: Record<string, unknown> = {}): Record<string, unknown> => ({
  calibrationMethod: 'two-point-ground',
  calibrationStatus: 'verified',
  calibration,
  ...flat,
})
const keysOf = (fields: object) => Object.keys(fields).sort()

Deno.test('a sidecar written before S0 yields the six fields it always did and none of the five new ones', () => {
  const fields = calibrationFromMeta(twoPointSidecar(record()))
  assertEquals(keysOf(fields), LEGACY_KEYS)
  assertEquals(keysOf(calibrationFromMeta({})), LEGACY_KEYS)
  assertEquals(keysOf(calibrationFromMeta({ calibrationMethod: 'ground-tap-compass', calibration: { method: 'ground-tap-compass' } })), LEGACY_KEYS)
})

Deno.test('a record that carries its frame generation, its check and its fit has them on the manifest', () => {
  const fields = calibrationFromMeta(twoPointSidecar(record({ frameId: UUID, checkedBy: 'constellation', fit })))
  assertEquals(keysOf(fields), [...LEGACY_KEYS, ...NEW_KEYS].sort())
  assertEquals(
    [fields.calibrationFrameId, fields.calibrationCheckedBy, fields.calibrationFitPointsUsed, fields.calibrationFitRmsM, fields.calibrationFitMaxM],
    [UUID, 'constellation', 3, 0.021, 0.034],
  )
  // Over the wire as the editor receives it.
  assertEquals(JSON.parse(JSON.stringify(fields)), { ...fields })
})

/** The new keys a two-point sidecar whose record has `over` on top of `record()` yields. */
const only = (over: Record<string, unknown>) => keysOf(calibrationFromMeta(twoPointSidecar(record(over)))).filter((key) => NEW_KEYS.includes(key))

Deno.test('each is read on its own where it can be: a frame id, a separation check, and a fit with the figure it has', () => {
  assertEquals(only({ frameId: UUID }), ['calibrationFrameId'])
  assertEquals(only({ checkedBy: 'separation' }), ['calibrationCheckedBy'])
  assertEquals(only({ fit: { pointsUsed: 4 } }), ['calibrationFitPointsUsed'])
  assertEquals(only({ fit: { pointsUsed: 3, rmsResidualM: 0.02 } }), ['calibrationFitPointsUsed', 'calibrationFitRmsM'])
  assertEquals(only({ fit: { pointsUsed: 3, maxResidualM: 0.04 } }), ['calibrationFitMaxM', 'calibrationFitPointsUsed'])
})

Deno.test('the fit\'s figures are read only from a fit that says how many points it used, and a fit of fewer than three measures nothing', () => {
  // No count: the figures have nothing to say they were measured by.
  assertEquals(only({ fit: { rmsResidualM: 0.02, maxResidualM: 0.04 } }), [])
  // One and two points are exact: an rms of 0 from them is not a measurement (ADR 0005 rule 3), and is not passed on as one.
  for (const pointsUsed of [1, 2]) {
    assertEquals(only({ fit: { pointsUsed, rmsResidualM: 0, maxResidualM: 0 } }), [], `${pointsUsed} points`)
    assertEquals([asCalibrationFitPointsUsed({ fit: { pointsUsed } }), asCalibrationFitRmsM({ fit: { pointsUsed, rmsResidualM: 0 } })], [undefined, undefined])
  }
  // Three is the fewest a fit accepts and eight the most (MIN_FIT_POINTS, MAX_FIT_POINTS in src/world/frame-fit.ts).
  for (const pointsUsed of [3, 4, 5, 8]) {
    assertEquals(only({ fit: { pointsUsed, rmsResidualM: 0.02, maxResidualM: 0.04 } }), ['calibrationFitMaxM', 'calibrationFitPointsUsed', 'calibrationFitRmsM'], `${pointsUsed} points`)
  }
  for (const pointsUsed of [9, 12, 1e21]) {
    assertEquals(only({ fit: { pointsUsed, rmsResidualM: 0.02, maxResidualM: 0.04 } }), [], `${pointsUsed} points is past what a fit accepts`)
  }
})

Deno.test('"constellation" is read only when a fit of three or more points backs it, and "separation" never needs one', () => {
  const checked = (over: Record<string, unknown>) => calibrationFromMeta(twoPointSidecar(record(over))).calibrationCheckedBy
  assertEquals(checked({ checkedBy: 'constellation', fit }), 'constellation')
  assertEquals(checked({ checkedBy: 'constellation' }), undefined, 'no fit at all')
  assertEquals(checked({ checkedBy: 'constellation', fit: { pointsUsed: 2, rmsResidualM: 0, maxResidualM: 0 } }), undefined, 'a fit of two')
  assertEquals(checked({ checkedBy: 'constellation', fit: { rmsResidualM: 0.02, maxResidualM: 0.04 } }), undefined, 'a fit with no count')
  assertEquals(checked({ checkedBy: 'constellation', fit: { ...fit, pointsUsed: 9 } }), undefined, 'a fit past the most')
  assertEquals(checked({ checkedBy: 'separation' }), 'separation')
  assertEquals(checked({ checkedBy: 'separation', fit: { pointsUsed: 2, rmsResidualM: 0, maxResidualM: 0 } }), 'separation')
  assertEquals(asCalibrationCheckedBy({ checkedBy: 'constellation' }), undefined)
  assertEquals(asCalibrationCheckedBy({ checkedBy: 'constellation', fit }), 'constellation')
})

Deno.test('a two-point visit that compared only the separation says so, and has no fit to show', () => {
  const fields = calibrationFromMeta(twoPointSidecar(record({ checkedBy: 'separation' })))
  assertEquals(fields.calibrationCheckedBy, 'separation')
  assertFalse('calibrationFitRmsM' in fields)
  assertFalse('calibrationFitPointsUsed' in fields)
})

const NOT_FRAME_IDS: unknown[] = ['', 'a b', 'a.b', 'a/b', 'a:b', '..', 'x'.repeat(65), 7, null, true, [], ['a'], {}, undefined]
const NOT_CHECKS: unknown[] = ['', 'photo', 'Constellation', 'constellation ', 'separation\n', 'both', 7, null, true, [], ['separation'], {}, undefined, 'constructor', '__proto__']
const NOT_MAGNITUDES: unknown[] = [-0.01, -1, NaN, Infinity, -Infinity, '0.02', '', null, true, [0.02], {}, undefined]
const NOT_COUNTS: unknown[] = [0, -3, 2.5, 3.5, NaN, Infinity, '3', '', null, true, [3], {}, undefined]

Deno.test('a value that is not what its field says is left off, never coerced and never nulled', () => {
  for (const frameId of NOT_FRAME_IDS) {
    assertFalse('calibrationFrameId' in calibrationFromMeta(twoPointSidecar(record({ frameId }))), `frameId ${Deno.inspect(frameId)}`)
    assertEquals(asCalibrationFrameId({ frameId }), undefined)
  }
  for (const checkedBy of NOT_CHECKS) {
    assertFalse('calibrationCheckedBy' in calibrationFromMeta(twoPointSidecar(record({ checkedBy }))), `checkedBy ${Deno.inspect(checkedBy)}`)
    assertEquals(asCalibrationCheckedBy({ checkedBy }), undefined)
  }
  // The figures are held to what they are on a fit that did measure something (3 points), so a bad figure is the only
  // reason each is left off here, and the count stays.
  for (const value of NOT_MAGNITUDES) {
    const fields = calibrationFromMeta(twoPointSidecar(record({ fit: { pointsUsed: 3, rmsResidualM: value, maxResidualM: value } })))
    assertFalse('calibrationFitRmsM' in fields, `rms ${Deno.inspect(value)}`)
    assertFalse('calibrationFitMaxM' in fields, `max ${Deno.inspect(value)}`)
    assertEquals(fields.calibrationFitPointsUsed, 3)
    assertEquals(
      [asCalibrationFitRmsM({ fit: { pointsUsed: 3, rmsResidualM: value } }), asCalibrationFitMaxM({ fit: { pointsUsed: 3, maxResidualM: value } })],
      [undefined, undefined],
    )
  }
  for (const value of NOT_COUNTS) {
    assertFalse('calibrationFitPointsUsed' in calibrationFromMeta(twoPointSidecar(record({ fit: { pointsUsed: value } }))), `points ${Deno.inspect(value)}`)
    assertEquals(asCalibrationFitPointsUsed({ fit: { pointsUsed: value } }), undefined)
  }
  // A fit that is not an object, and a record that is not one.
  for (const bad of [null, 7, 'fit', true, [], [fit]]) {
    assertEquals(keysOf(calibrationFromMeta(twoPointSidecar(record({ fit: bad })))), LEGACY_KEYS, `fit ${Deno.inspect(bad)}`)
  }
  for (const bad of [null, undefined, 7, 'x', true, [], () => 1]) {
    assertEquals(keysOf(calibrationFromMeta(twoPointSidecar(bad))), LEGACY_KEYS, `record ${Deno.inspect(bad)}`)
  }
})

Deno.test('the last value inside each bound is read: a zero residual, a frame id of 64 characters, a fit of three points', () => {
  const fields = calibrationFromMeta(twoPointSidecar(record({ frameId: 'f'.repeat(64), fit: { rmsResidualM: 0, maxResidualM: 0, pointsUsed: 3 } })))
  assertEquals(fields.calibrationFrameId, 'f'.repeat(64))
  assertEquals([fields.calibrationFitRmsM, fields.calibrationFitMaxM, fields.calibrationFitPointsUsed], [0, 0, 3])
  assertEquals(calibrationFromMeta(twoPointSidecar(record({ fit: { rmsResidualM: 0.02, maxResidualM: 0.03, pointsUsed: MAX_FIT_POINTS } }))).calibrationFitPointsUsed, MAX_FIT_POINTS)
})

Deno.test('only a two-point scan has them: a one-point or known-distance sidecar that claims a fit or an id is not read', () => {
  const claims = { frameId: UUID, checkedBy: 'constellation', fit }
  for (const tier of ['ground-tap-compass', 'known-distance']) {
    const fields = calibrationFromMeta({ calibrationMethod: tier, calibrationStatus: 'provisional', calibrationFrameId: UUID, calibration: { method: tier, ...claims } })
    assertEquals(keysOf(fields), LEGACY_KEYS, `${tier}: a one-point record never carries a fit (ADR 0005 rule 3), and a known-distance one is not a frame generation`)
  }
  // No summary at all: the scan was placed by GPS or the grid, so nothing about a Place frame is claimed for it.
  assertEquals(keysOf(calibrationFromMeta({ calibration: record(claims) })), LEGACY_KEYS)
  assertEquals(keysOf(calibrationFromMeta({ calibrationMethod: null, calibrationStatus: 'uncalibrated', calibration: record(claims) })), LEGACY_KEYS)
})

Deno.test('a record that is another tier\'s lends nothing, as for the measurements, but the frame id in the flat key still stands', () => {
  // `splat-align` overwrites the nested record with a known-distance one and leaves the flat summaries alone.
  const overwritten = { method: 'known-distance', sessionToProject: [], separationM: 3, residualM: 0.004, toleranceM: 0.15, gravityAligned: true, frameId: 'x'.repeat(5), fit, checkedBy: 'constellation' }
  assertEquals(keysOf(calibrationFromMeta(twoPointSidecar(overwritten))), LEGACY_KEYS, 'neither the id, the check nor the fit of a record that describes another frame')
  const flat = calibrationFromMeta(twoPointSidecar(overwritten, { calibrationFrameId: UUID }))
  assertEquals(keysOf(flat), [...LEGACY_KEYS, 'calibrationFrameId'].sort())
  assertEquals(flat.calibrationFrameId, UUID, 'the flat key names the frame the scan was placed by, as the flat tier does')
})

Deno.test('the flat frame id is read before the record\'s, and a flat key that is not an id (null, or text that cannot be one) falls back', () => {
  assertEquals(calibrationFromMeta(twoPointSidecar(record({ frameId: 'record-id' }), { calibrationFrameId: UUID })).calibrationFrameId, UUID)
  assertEquals(calibrationFromMeta(twoPointSidecar(record({ frameId: 'record-id' }), { calibrationFrameId: null })).calibrationFrameId, 'record-id')
  assertEquals(calibrationFromMeta(twoPointSidecar(record({ frameId: 'record-id' }), { calibrationFrameId: 'a b' })).calibrationFrameId, 'record-id')
  assertFalse('calibrationFrameId' in calibrationFromMeta(twoPointSidecar(record(), { calibrationFrameId: null })))
})

Deno.test('the existing readers are unchanged: the legacy fields read as they did beside the new ones', () => {
  const fields = calibrationFromMeta(twoPointSidecar(record({ frameId: UUID, checkedBy: 'constellation', fit })))
  assertEquals(
    [fields.calibrationMethod, fields.calibrationStatus, fields.calibrationSeparationM, fields.calibrationResidualM, fields.calibrationToleranceM, fields.calibratedAt],
    ['two-point-ground', 'verified', 3.01, 0.01, 0.15, '2026-11-17T10:00:00.000Z'],
  )
})

// ── 3b. calibrationEvidenceFromMeta: the same five, always as keys ───────────────────────────────

const EVIDENCE_KEYS = ['calibrationFrameId', 'calibrationCheckedBy', 'calibrationFitPointsUsed', 'calibrationFitRmsM', 'calibrationFitMaxM'] as const
/** The five as the editor receives them: what JSON keeps of an object whose absent fields are `undefined` keys. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

Deno.test('calibrationEvidenceFromMeta always has the five keys, with the value calibrationFromMeta reads or undefined', () => {
  type _EveryKeyRequired = MustBe<Equal<keyof CalibrationEvidenceFields, (typeof EVIDENCE_KEYS)[number]>>
  const sidecars: Record<string, Record<string, unknown>> = {
    'a record with all five': twoPointSidecar(record({ frameId: UUID, checkedBy: 'constellation', fit })),
    'a record with a frame id only': twoPointSidecar(record({ frameId: UUID })),
    'a two-point record with none': twoPointSidecar(record()),
    'a frame id in the flat key only': twoPointSidecar(record(), { calibrationFrameId: UUID }),
    'a one-point sidecar that claims them': { calibrationMethod: 'ground-tap-compass', calibration: { method: 'ground-tap-compass', frameId: UUID, fit } },
    'a record another tier overwrote': twoPointSidecar({ method: 'known-distance', frameId: UUID, fit }),
    'a scan that never calibrated': { calibrationMethod: null, calibrationStatus: 'uncalibrated', calibration: null },
    'nothing': {},
  }
  for (const [name, sidecar] of Object.entries(sidecars)) {
    const evidence = calibrationEvidenceFromMeta(sidecar)
    assertEquals(Object.keys(evidence).sort(), [...EVIDENCE_KEYS].sort(), `${name}: every one is a key`)
    const read = calibrationFromMeta(sidecar)
    for (const key of EVIDENCE_KEYS) assertEquals(evidence[key], read[key], `${name}: ${key} is what calibrationFromMeta reads`)
  }
  assertEquals(calibrationEvidenceFromMeta(sidecars['a record with all five']!), {
    calibrationFrameId: UUID,
    calibrationCheckedBy: 'constellation',
    calibrationFitPointsUsed: 3,
    calibrationFitRmsM: 0.021,
    calibrationFitMaxM: 0.034,
  })
  assertEquals(
    calibrationEvidenceFromMeta(sidecars['nothing']!),
    { calibrationFrameId: undefined, calibrationCheckedBy: undefined, calibrationFitPointsUsed: undefined, calibrationFitRmsM: undefined, calibrationFitMaxM: undefined },
  )
})

Deno.test('a manifest built with it from a sidecar before S0 is the manifest it always was, as JSON', () => {
  for (const sidecar of [twoPointSidecar(record()), twoPointSidecar(record({ pointLabels: ['a', 'b'] })), { calibrationMethod: 'ground-tap-compass', calibration: { method: 'ground-tap-compass' } }, {}]) {
    assertEquals(overTheWire({ ...calibrationFromMeta(sidecar), ...calibrationEvidenceFromMeta(sidecar) }), overTheWire(calibrationFromMeta(sidecar)))
    assertEquals(Object.keys(overTheWire(calibrationEvidenceFromMeta(sidecar))), [], 'no evidence key reaches the editor or the world file')
  }
})

Deno.test('laid over the row it was read into, a sidecar that no longer holds the evidence clears it, as it clears the measurements', () => {
  // What refreshWorldScans does: `{ ...stored row, ...manifest built from the sidecar now }`.
  const manifestOf = (sidecar: Record<string, unknown>) => ({ ...calibrationFromMeta(sidecar), ...calibrationEvidenceFromMeta(sidecar) })
  const row = manifestOf(twoPointSidecar(record({ frameId: UUID, checkedBy: 'constellation', fit })))
  assertEquals([row.calibrationFrameId, row.calibrationCheckedBy, row.calibrationFitPointsUsed], [UUID, 'constellation', 3])

  // The `splat-align` job replaces the nested record with a known-distance one and leaves the flat summaries alone.
  const afterJob = twoPointSidecar({ method: 'known-distance', sessionToProject: [], separationM: 3.2, residualM: 0.001, toleranceM: 0.5, status: 'provisional' })
  const refreshed = { ...row, ...manifestOf(afterJob) }
  assertEquals(refreshed.calibrationResidualM, null, 'the measurements the contract already cleared')
  for (const key of EVIDENCE_KEYS) assertEquals(refreshed[key], undefined, `${key} stood on the row after the record it was read from was gone`)
  assertEquals(overTheWire(refreshed), overTheWire(manifestOf(afterJob)), 'and the editor and the world file get the same row as from a fresh read')

  // `calibrationFromMeta` alone is the answer that cannot do this, and is why the manifest builder adds the five as keys.
  const stale = { ...row, ...calibrationFromMeta(afterJob) }
  assertEquals(stale.calibrationFrameId, UUID)

  // The frame id the flat key holds is the one value that survives the job, as the flat tier does.
  const flat = { ...row, ...manifestOf({ ...afterJob, calibrationFrameId: UUID }) }
  assertEquals([flat.calibrationFrameId, flat.calibrationCheckedBy, flat.calibrationFitPointsUsed], [UUID, undefined, undefined])
})

Deno.test('source shape: the manifest builder in server/main.ts adds the five as keys beside the readers it already used', async () => {
  const main = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))
  const start = main.indexOf('function scanManifestFromStored(')
  assert(start !== -1, 'scanManifestFromStored moved')
  const build = main.slice(start, main.indexOf('\n}\n', start))
  assert(build.includes('...calibrationFromMeta(scan.meta)'), 'the builder no longer reads the calibration fields with calibrationFromMeta')
  assert(build.includes('...calibrationEvidenceFromMeta(scan.meta)'), 'the builder does not add the five evidence fields as keys: a refresh would leave stale values on a row')
  assert(/import\s*\{[^}]*\bcalibrationEvidenceFromMeta\b[^}]*\}\s*from\s*'\.\/calibration_fields\.ts'/.test(main), 'server/main.ts does not import calibrationEvidenceFromMeta')
})

// ── 4. The server's hooks ────────────────────────────────────────────────────────────────────────

Deno.test('isPlaceCalibrated is the predicate, for every calibration tier and for no tier at all', () => {
  const expected: Record<ScanCalibration['method'], boolean> = { 'two-point-ground': true, 'ground-tap-compass': true, 'known-distance': false }
  for (const [method, answer] of Object.entries(expected)) {
    assertEquals(isPlaceCalibrated({ calibrationMethod: method as ScanCalibration['method'] }), answer, method)
    assertEquals(isPlaceCalibrated({ calibrationMethod: method as ScanCalibration['method'] }), isPlaceFrameMethod(method))
  }
  assertEquals(isPlaceCalibrated({}), false, 'a scan with no calibration')
  assertEquals(isPlaceCalibrated({ calibrationMethod: 'three-point' as never }), false, 'and a tier this build does not know')
})

Deno.test('source shape: isPlaceCalibrated names no tier of its own, so a tier added to the frame type is compared with no edit here', async () => {
  const source = await Deno.readTextFile(new URL('../../../server/register/place_register.ts', import.meta.url))
  const start = source.indexOf('export function isPlaceCalibrated(')
  assert(start !== -1, 'isPlaceCalibrated moved')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  assert(/isPlaceFrameMethod\(scan\.calibrationMethod\)/.test(body), 'it no longer asks the shared predicate')
  assertFalse(/two-point-ground|ground-tap-compass|known-distance/.test(body), 'it names a tier again')
})

const stored = (over: Partial<Project> = {}): Project => ({ ...place, ...over })
const bodyFor = (project: Project, over: Record<string, unknown> = {}): Record<string, unknown> =>
  JSON.parse(JSON.stringify({ ...project, name: 'Renamed', ...over }))

Deno.test('a whole-record PUT keeps the frame history, the georeference and its version, as it keeps the frame', () => {
  const before = stored()
  const after = placeFromBody(bodyFor(before), before.projectId, 1_700_000_003_000, before)
  assertEquals(after.name, 'Renamed')
  assertEquals(after.frameHistory, [history])
  assertEquals(after.georeference, georeference)
  assertEquals(after.georefVersion, 1)
  assertEquals(after.spatialFrame, frame)
  assertEquals(after.spatialFrameRevision, 2)
})

Deno.test('a whole-record PUT never takes those three from the body, whatever it says', () => {
  const before = stored()
  const forged = { frameHistory: [], georeference: { ...georeference, bearingDeg: 200 }, georefVersion: 99 }
  const after = placeFromBody(bodyFor(before, forged), before.projectId, 1_700_000_003_000, before)
  assertEquals(after.frameHistory, [history])
  assertEquals(after.georeference, georeference)
  assertEquals(after.georefVersion, 1)
  // And a Place that has none is not given any by a body that carries them.
  const bare = stored({ frameHistory: undefined, georeference: undefined, georefVersion: undefined })
  const stillBare = placeFromBody(bodyFor(bare, forged), bare.projectId, 1_700_000_003_000, bare)
  for (const key of ['frameHistory', 'georeference', 'georefVersion']) assertFalse(key in stillBare, `${key} was invented from the body`)
})

Deno.test('a Place saved before S0 is rebuilt exactly as before: no key of the three appears', () => {
  const legacy: Project = { projectId: 'proj-1', name: 'Room', createdAt: 1, updatedAt: 2, floors: [] }
  const after = placeFromBody(JSON.parse(JSON.stringify({ ...legacy, name: 'Renamed' })), 'proj-1', 3, legacy)
  assertEquals(Object.keys(after).sort(), ['createdAt', 'floors', 'name', 'projectId', 'updatedAt'])
})

Deno.test('a frame write leaves the three alone, and a Place saved with them reads them back through JSON', () => {
  const projects = [stored({ spatialFrame: undefined, spatialFrameRevision: undefined })]
  const written = applySpatialFrameWrite(projects, projects[0]!.projectId, { frame: JSON.parse(JSON.stringify(frame)), expectedRevision: 0 }, 1_700_000_004_000)
  assertEquals(written.result.status, 200)
  assertEquals(projects[0]!.frameHistory, [history])
  assertEquals(projects[0]!.georeference, georeference)
  assertEquals(projects[0]!.georefVersion, 1)
  const roundTrip = JSON.parse(JSON.stringify(projects[0])) as Project
  assertEquals([roundTrip.frameHistory, roundTrip.georeference, roundTrip.georefVersion], [[history], georeference, 1])
  assertEquals(roundTrip.spatialFrame, frame)
})
