/**
 * calibration_fields.test.ts — what a scan's upload sidecar says about its calibration, read
 * as the `ScanManifest` fields the World Editor and the Companion Memory push consume.
 * Run: deno test --allow-read tests/unit/deno/calibration_fields.test.ts
 *
 * The defect these pin. `asCalibrationMethod` passed `'ground-tap-compass'` and nothing else.
 * A real two-point capture's sidecar says `'two-point-ground'`, but the manifest the server
 * built from it came back with `calibrationMethod` absent, beside a `calibrationStatus` and a
 * `calibrationSeparationM` that were there. The editor draws its red "actual" pins only for
 * `'two-point-ground'` (`addAnchorMarker` in src/viewer/viewer.ts), so against a real server
 * they could never appear. A sidecar naming `'known-distance'`, the union's third member, was
 * dropped the same way. `server/main.ts` exports nothing and cannot be imported, so the
 * readers live in `server/calibration_fields.ts`; the sidecar fixtures below have the shape
 * `src/export/gltf.ts` writes. `calibrationFromMeta` is what `scanManifestFromStored` calls; the
 * round trips here go through it, and tests/unit/deno/scan_manifest_calibration.test.ts covers what it
 * adds (the residual, the tolerance and the time, and a record that is another tier's).
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  asCalibrationMethod,
  asCalibrationSeparationM,
  asCalibrationStatus,
  asOutsidePlaceFrame,
  calibrationFromMeta,
  calibrationGroundYFromMeta,
  withReplacedCalibration,
} from '../../../server/calibration_fields.ts'
import { anchorToProjectTransform, twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { ScanCalibration, ScanManifest } from '../../../src/world/types.ts'

// ── Every member of the unions, listed so that a new one cannot be forgotten ───────────────
//
// These are Records keyed by the manifest's own unions, so adding a tier or a status to
// `ScanCalibration` is a compile error in this file until it is listed here, and listing it
// makes the loops below fail until the reader passes it through. That is the step that was
// missed when the two-point and known-distance tiers were added.

const EVERY_METHOD: Record<ScanCalibration['method'], true> = {
  'two-point-ground': true,
  'ground-tap-compass': true,
  'known-distance': true,
}
const EVERY_STATUS: Record<ScanCalibration['status'], true> = {
  verified: true,
  provisional: true,
  uncalibrated: true,
}
const METHODS = Object.keys(EVERY_METHOD) as ScanCalibration['method'][]
const STATUSES = Object.keys(EVERY_STATUS) as ScanCalibration['status'][]

// ── Calibration records, as the capture produces them ────────────────────────────────────────

const CALIBRATED_AT = '2026-11-01T10:00:00.000Z'
const LANDMARK = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER = { x: 3.1, y: -1.2, z: 1.9 }

/** A return visit to a Place with a stored two-point frame: the re-measured separation agreed, so 'verified'. */
const TWO_POINT: Extract<ScanCalibration, { method: 'two-point-ground' }> = {
  method: 'two-point-ground',
  sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
  separationM: twoPointSeparationM(LANDMARK, HEADING_MARKER),
  residualM: 0.022,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: CALIBRATED_AT,
  status: 'verified',
}

/** The one-point fallback: a single ground tap and the compass, nothing to verify it against. */
const ONE_POINT: Extract<ScanCalibration, { method: 'ground-tap-compass' }> = {
  method: 'ground-tap-compass',
  sessionToProject: anchorToProjectTransform({ x: -2.2, y: -0.9, z: 1.6 }, 40),
  anchorBearingDeg: 40,
  calibratedAt: CALIBRATED_AT,
  status: 'provisional',
}

/** A tripod capture scaled by one tape reading: a uniform 0.5 about the first station. */
const KNOWN_DISTANCE: Extract<ScanCalibration, { method: 'known-distance' }> = {
  method: 'known-distance',
  sessionToProject: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, -0.5, -1, -1.5, 1],
  separationM: 3.2,
  residualM: 0.02,
  toleranceM: 0.15,
  gravityAligned: true,
  calibratedAt: CALIBRATED_AT,
  status: 'provisional',
}

// ── Inputs the readers must refuse ───────────────────────────────────────────────────────────

/** Everything JSON can hold that is not a string, plus what a careless reader would coerce into one. */
const NOT_STRINGS: unknown[] = [
  undefined,
  null,
  0,
  1,
  NaN,
  true,
  false,
  {},
  [],
  ['two-point-ground'],
  ['verified'],
  { method: 'two-point-ground' },
  { toString: () => 'two-point-ground' },
  { toString: () => 'verified' },
  Object('two-point-ground'),
  Object('verified'),
  Symbol.for('two-point-ground'),
]

/** Names every object inherits: a reader that looks the value up in a table must not pass these. */
const INHERITED_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']

// ── asCalibrationMethod ──────────────────────────────────────────────────────────────────────

Deno.test('asCalibrationMethod: every tier a sidecar can carry passes through unchanged', () => {
  assertEquals(
    [...METHODS].sort(),
    ['ground-tap-compass', 'known-distance', 'two-point-ground'],
    'the manifest names exactly these three tiers',
  )
  for (const tier of METHODS) {
    assertEquals(asCalibrationMethod(tier), tier, `${tier} must reach the manifest`)
  }
  // Spelled out as well, because these are the two the reader used to drop.
  assertEquals(asCalibrationMethod('two-point-ground'), 'two-point-ground')
  assertEquals(asCalibrationMethod('known-distance'), 'known-distance')
  assertEquals(asCalibrationMethod('ground-tap-compass'), 'ground-tap-compass')
})

Deno.test('asCalibrationMethod: a string that is not a tier stays undefined', () => {
  const unknown = [
    '',
    ' ',
    'two-point-ground ',
    ' known-distance',
    'Two-Point-Ground',
    'GROUND-TAP-COMPASS',
    'two-point',
    'ground-tap',
    'known_distance',
    'twopointground',
    // Not a tier of a scan: the splat-align manifest's own label for a fit that used the solver's gravity.
    'known-distance+solver-gravity',
    // A neighbouring field's values and common placeholders.
    'uncalibrated',
    'verified',
    'provisional',
    'gps-fused',
    'none',
    'null',
    'undefined',
    ...INHERITED_KEYS,
  ]
  for (const value of unknown) {
    assertEquals(asCalibrationMethod(value), undefined, `${JSON.stringify(value)} is not a calibration tier`)
  }
})

Deno.test('asCalibrationMethod: a value that is not a string stays undefined, including the null gltf.ts writes', () => {
  for (const value of NOT_STRINGS) {
    assertEquals(asCalibrationMethod(value), undefined, `${Deno.inspect(value)} is not a calibration tier`)
  }
})

// ── asCalibrationStatus ──────────────────────────────────────────────────────────────────────

Deno.test('asCalibrationStatus: every status passes through unchanged', () => {
  assertEquals([...STATUSES].sort(), ['provisional', 'uncalibrated', 'verified'])
  for (const status of STATUSES) {
    assertEquals(asCalibrationStatus(status), status, `${status} must reach the manifest`)
  }
})

Deno.test('asCalibrationStatus: a string that is not a status stays undefined', () => {
  const unknown = [
    '',
    ' ',
    'Verified',
    'VERIFIED',
    'verified ',
    'unverified',
    'ready',
    'ok',
    'null',
    'two-point-ground',
    ...INHERITED_KEYS,
  ]
  for (const value of unknown) {
    assertEquals(asCalibrationStatus(value), undefined, `${JSON.stringify(value)} is not a calibration status`)
  }
})

Deno.test('asCalibrationStatus: a value that is not a string stays undefined, including a missing key', () => {
  for (const value of NOT_STRINGS) {
    assertEquals(asCalibrationStatus(value), undefined, `${Deno.inspect(value)} is not a calibration status`)
  }
})

// ── asCalibrationSeparationM ─────────────────────────────────────────────────────────────────

Deno.test('asCalibrationSeparationM: reads the separation off a calibration record', () => {
  assertEquals(asCalibrationSeparationM({ separationM: 2.8 }), 2.8)
  assertEquals(asCalibrationSeparationM({ separationM: 0.5, other: 'ignored' }), 0.5)
  // A finite number is a number: this reader types the field, the viewer decides what is plausible
  // (sessionAnchorPositions ignores a separation that is not above zero). Zero must not read as absent.
  assertEquals(asCalibrationSeparationM({ separationM: 0 }), 0)
  // Whichever tier wrote it, because the record carries separationM on two of the three.
  assertEquals(asCalibrationSeparationM(TWO_POINT), TWO_POINT.separationM)
  assertEquals(asCalibrationSeparationM(KNOWN_DISTANCE), 3.2)
})

Deno.test('asCalibrationSeparationM: no separation in the record is null', () => {
  // The one-point tier has none, and neither does anything that never calibrated.
  assertEquals(asCalibrationSeparationM(ONE_POINT), null)
  for (const value of [{}, { separationM: undefined }, { separation: 2.8 }, { separationm: 2.8 }, null, undefined]) {
    assertEquals(asCalibrationSeparationM(value), null, `${Deno.inspect(value)} carries no separation`)
  }
})

Deno.test('asCalibrationSeparationM: a number that is not finite is null', () => {
  for (const separationM of [NaN, Infinity, -Infinity]) {
    assertEquals(asCalibrationSeparationM({ separationM }), null, `${separationM} is not a length`)
  }
})

Deno.test('asCalibrationSeparationM: a wrongly typed separation or record is null', () => {
  for (const separationM of ['2.8', '', 'NaN', null, true, false, [2.8], [], {}, { value: 2.8 }, Object(2.8)]) {
    assertEquals(asCalibrationSeparationM({ separationM }), null, `separationM ${Deno.inspect(separationM)} is not a number`)
  }
  // The calibration itself may be anything a hand-edited sidecar holds.
  for (const record of [2.8, '2.8', 'separationM', true, false, 0, [], [2.8], () => 2.8]) {
    assertEquals(asCalibrationSeparationM(record), null, `${Deno.inspect(record)} is not a calibration record`)
  }
})

// ── The sidecar src/export/gltf.ts writes, through to the manifest fields ────────────────────

/**
 * The text POST /upload-scan writes to `<scan>.json`: the `metadata` form field, verbatim, which is
 * what `uploadToServer` in src/export/gltf.ts builds. Same keys and the same three calibration
 * expressions; `calibration` is the whole record, and a scan that never calibrated carries
 * `calibrationMethod: null`, `calibrationStatus: 'uncalibrated'` and `calibration: null`.
 */
function sidecarAsGltfWritesIt(scanName: string, calibration: ScanCalibration | null): string {
  return JSON.stringify({
    detectionCount: 0,
    labels: [],
    detections: [],
    exportedAt: '2026-11-01T10:05:00.000Z',
    capturedAt: '2026-11-01T10:04:30.000Z',
    sessionId: null,
    scanName,
    projectId: null,
    areaId: null,
    floorId: null,
    roomId: null,
    projectTransform: calibration?.sessionToProject ?? null,
    calibrationMethod: calibration?.method ?? null,
    calibrationStatus: calibration?.status ?? 'uncalibrated',
    calibration: calibration ?? null,
    autoSaved: false,
    pointCount: 1303,
    poseCount: 412,
    qualityStatus: null,
    qualityCoverageScore: null,
    qualityMissingAreas: null,
    qualityLowLightFrames: null,
    qualityDriftEvents: null,
    qualityReflectiveWarnings: null,
    qualityRecommendations: [],
    qualitySummary: null,
    geoLat: null,
    geoLng: null,
    geoAltitudeM: null,
    geoAccuracy: null,
    geoBearing: null,
    geoAddress: null,
    geoDisplayAddress: null,
    geoFixedAt: null,
  })
}

type ManifestCalibration = Pick<ScanManifest, 'calibrationMethod' | 'calibrationStatus' | 'calibrationSeparationM'>

/**
 * What `scanManifestFromStored` in server/main.ts does with a stored sidecar: `calibrationFromMeta`,
 * of which these three fields are the part this file is about (its other three, and what it does
 * when the flat and nested records disagree, are in scan_manifest_calibration.test.ts). The last
 * test in this file reads main.ts and fails if it stops doing exactly this.
 */
function manifestCalibrationFrom(sidecarText: string): ManifestCalibration {
  const { calibrationMethod, calibrationSeparationM, calibrationStatus } = calibrationFromMeta(
    JSON.parse(sidecarText) as Record<string, unknown>,
  )
  return { calibrationMethod, calibrationSeparationM, calibrationStatus }
}

/** What the editor receives: GET /worlds/:slug is JSON, and JSON drops a field that is undefined. */
function overTheWire(fields: ManifestCalibration): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fields))
}

Deno.test('round trip: a two-point sidecar keeps the method, status and separation the editor draws red pins from', () => {
  const sidecar = sidecarAsGltfWritesIt('two-point', TWO_POINT)
  // The sidecar says what the manifest must repeat.
  assertEquals((JSON.parse(sidecar) as Record<string, unknown>)['calibrationMethod'], 'two-point-ground')

  const fields = manifestCalibrationFrom(sidecar)
  assertEquals(fields.calibrationMethod, 'two-point-ground', 'this was undefined, so the red pins never appeared')
  assertEquals(fields.calibrationStatus, 'verified')
  assertEquals(fields.calibrationSeparationM, TWO_POINT.separationM)
  // And not only by agreeing with the record: the separation is the ground-plane distance between the taps.
  assert(
    Math.abs((fields.calibrationSeparationM ?? 0) - Math.sqrt(1.6 ** 2 + 2.3 ** 2)) < 1e-9,
    `got ${fields.calibrationSeparationM}`,
  )

  // Over the wire as the editor sees it.
  assertEquals(overTheWire(fields), {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibrationSeparationM: TWO_POINT.separationM,
  })
})

Deno.test("round trip: a Place's first two-point scan is provisional and still a two-point scan", () => {
  const fields = manifestCalibrationFrom(
    sidecarAsGltfWritesIt('first-visit', { ...TWO_POINT, status: 'provisional', residualM: 0 }),
  )
  assertEquals(fields.calibrationMethod, 'two-point-ground')
  assertEquals(fields.calibrationStatus, 'provisional')
  assertEquals(fields.calibrationSeparationM, TWO_POINT.separationM)
})

Deno.test('round trip: a known-distance sidecar keeps its tier next to the separation it already carried', () => {
  // No current writer puts this tier in the flat key: the server's splat-align job persists a
  // known-distance record into the nested `calibration` only. This pins what the reader does the
  // day one does, because the tier is in the manifest's union and dropping it is the defect.
  const fields = manifestCalibrationFrom(sidecarAsGltfWritesIt('known-distance', KNOWN_DISTANCE))
  assertEquals(fields.calibrationMethod, 'known-distance')
  assertEquals(fields.calibrationStatus, 'provisional')
  assertEquals(fields.calibrationSeparationM, 3.2)
})

Deno.test('round trip: a one-point sidecar still reads as it always did, with no separation', () => {
  const fields = manifestCalibrationFrom(sidecarAsGltfWritesIt('one-point', ONE_POINT))
  assertEquals(fields.calibrationMethod, 'ground-tap-compass')
  assertEquals(fields.calibrationStatus, 'provisional')
  assertEquals(fields.calibrationSeparationM, null)
})

Deno.test('round trip: a scan that never calibrated has no method, and says so in its status', () => {
  const fields = manifestCalibrationFrom(sidecarAsGltfWritesIt('uncalibrated', null))
  assertEquals(fields.calibrationMethod, undefined, 'the null gltf.ts writes is not a tier')
  assertEquals(fields.calibrationStatus, 'uncalibrated')
  assertEquals(fields.calibrationSeparationM, null)
  assertEquals('calibrationMethod' in overTheWire(fields), false, 'and the key is left off the manifest, as before')
})

Deno.test('round trip: every tier the manifest names survives, whatever else the record holds', () => {
  // The table-driven form of the cases above. If a tier is added to ScanCalibration, EVERY_METHOD
  // stops compiling until it is listed and this switch stops compiling until it has a record, and
  // then this fails until the reader passes the tier through.
  const calibrationFor = (method: ScanCalibration['method']): ScanCalibration => {
    switch (method) {
      case 'two-point-ground':
        return TWO_POINT
      case 'ground-tap-compass':
        return ONE_POINT
      case 'known-distance':
        return KNOWN_DISTANCE
    }
  }
  for (const method of METHODS) {
    const fields = manifestCalibrationFrom(sidecarAsGltfWritesIt(method, calibrationFor(method)))
    assertEquals(fields.calibrationMethod, method, `${method} must survive the sidecar`)
  }
})

Deno.test('round trip: a sidecar with wrongly typed calibration fields yields no calibration, not an error', () => {
  for (
    const [method, status, calibration] of [
      [42, 7, 'two-point'],
      [{ name: 'two-point-ground' }, ['verified'], [2.8]],
      [['two-point-ground'], { status: 'verified' }, { separationM: '2.8' }],
      [true, false, true],
    ]
  ) {
    const fields = manifestCalibrationFrom(
      JSON.stringify({ calibrationMethod: method, calibrationStatus: status, calibration }),
    )
    assertEquals(fields.calibrationMethod, undefined)
    assertEquals(fields.calibrationStatus, undefined)
    assertEquals(fields.calibrationSeparationM, null)
  }
  // A sidecar with none of the keys at all (a scan uploaded before calibration existed).
  const bare = manifestCalibrationFrom('{}')
  assertEquals(bare.calibrationMethod, undefined)
  assertEquals(bare.calibrationStatus, undefined)
  assertEquals(bare.calibrationSeparationM, null)
})

// ── server/main.ts still does what the round trips above do ─────────────────────────────────
//
// main.ts cannot be imported, so what these tests run is `calibrationFromMeta` and not the manifest
// builder around it. Like the source anchors in tests/unit/node/wp-car4-lod-ids.test.ts, this reads
// the source that call comes from and fails when it changes, so the tests above cannot stay green
// while the server does something else.

/** One top-level function's text: from its header to the first closing brace in column zero. */
function functionSource(source: string, header: string): string {
  const start = source.indexOf(header)
  assert(start !== -1, `server/main.ts has no function with this header: ${header}`)
  const end = source.indexOf('\n}\n', start)
  assert(end !== -1, `the function with this header does not close in server/main.ts: ${header}`)
  return source.slice(start, end)
}

Deno.test("server/main.ts builds the manifest's calibration fields with calibrationFromMeta, and reads no sidecar key by hand", async () => {
  const main = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))

  // `assert(pattern.test(text), …)` and not assertMatch: on a miss assertMatch prints the whole
  // 300 KB of main.ts, which buries the one line that says what changed.
  assert(
    /import\s*\{[^}]*\bcalibrationFromMeta\b[^}]*\}\s*from\s*'\.\/calibration_fields\.ts'/.test(main),
    'server/main.ts no longer imports calibrationFromMeta from ./calibration_fields.ts',
  )
  // The readers are what calibrationFromMeta is built from. main.ts must not grow its own again, nor
  // read a sidecar's calibration keys by hand, or the manifest would stop using the tested ones.
  for (
    const reader of [
      'asCalibrationMethod',
      'asCalibrationSeparationM',
      'asCalibrationStatus',
      'asCalibrationResidualM',
      'asCalibrationToleranceM',
      'asCalibratedAt',
      'calibrationFromMeta',
    ]
  ) {
    assert(
      !new RegExp(`function\\s+${reader}\\b`).test(main),
      `server/main.ts defines its own ${reader} again; the manifest would stop using the tested one`,
    )
  }

  const build = functionSource(main, 'function scanManifestFromStored(')
  assert(
    /\.\.\.calibrationFromMeta\(\s*scan\.meta\s*\)/.test(build),
    "scanManifestFromStored no longer builds the manifest's calibration fields with calibrationFromMeta(scan.meta)",
  )
  // The origin's floor height is read through `calibrationGroundYFromMeta`, which reads the flat key the `splat-align` job
  // keeps first and the nested record, through `readCalibrationGroundY` (src/world/geo.ts, held by
  // tests/unit/node/origin_decal.test.ts and origin_persistence.test.ts), second. It used to be one hand-read of the nested
  // record, `readCalibrationGroundY(scan.meta['calibration'])`, which read null once that job had replaced the record. The check
  // looks at the rest of the function, so a hand-read of any other calibration key still fails it.
  const groundYRead = 'calibrationGroundYFromMeta(scan.meta)'
  assert(build.includes(groundYRead), 'scanManifestFromStored no longer reads the origin\'s floor height with calibrationGroundYFromMeta')
  assert(
    !/scan\.meta\['(calibrationMethod|calibrationStatus|calibration|calibrationGroundY)'\]/.test(build.replace(groundYRead, '')),
    'scanManifestFromStored reads a calibration key of the sidecar by hand again, beside calibrationFromMeta',
  )
})

Deno.test('server/main.ts replaces the nested calibration record through withReplacedCalibration, so the floor height outlives it', async () => {
  const main = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))
  const job = functionSource(main, 'async function _runSplatAlignJob(')
  assert(
    /writeJsonAtomic\(\s*metaPath\s*,\s*withReplacedCalibration\(\s*meta\s*,\s*result\.calibration\s*\)\s*\)/.test(job),
    "_runSplatAlignJob no longer writes the sidecar it replaces the record in with withReplacedCalibration(meta, result.calibration)",
  )
  assert(
    !/meta\['calibration'\]\s*=/.test(job),
    "_runSplatAlignJob assigns the nested calibration record by hand again, and the floor height it held is lost with it",
  )
  assert(
    /import\s*\{[^}]*\bwithReplacedCalibration\b[^}]*\}\s*from\s*'\.\/calibration_fields\.ts'/.test(main),
    'server/main.ts no longer imports withReplacedCalibration from ./calibration_fields.ts',
  )
})

// ── The origin's floor height outlives the splat-align job ─────────────────────────────────────
//
// The capture writes the floor height the origin sat on only inside the nested `calibration` record (`groundY`, wave 12). The
// `splat-align` job replaces that record with its own known-distance one and leaves the flat summaries and `projectTransform`
// alone, so the scan is still placed by the transform the floor height belongs to, and the manifest read null. The expected
// values here are the figures put in the fixtures, not anything the readers compute.

const GROUND_Y = -1.2

/** A sidecar as src/export/gltf.ts writes it for a two-point capture on a floor at session height -1.2 m. */
function twoPointSidecar(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectTransform: TWO_POINT.sessionToProject,
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibration: { ...TWO_POINT, groundY: GROUND_Y },
    ...extra,
  }
}

Deno.test('calibrationGroundYFromMeta: the nested record answers on a scan no job has touched, a flat key answers first, and anything that is not a number is no floor height', () => {
  assertEquals(calibrationGroundYFromMeta(twoPointSidecar()), GROUND_Y)
  assertEquals(calibrationGroundYFromMeta(twoPointSidecar({ calibrationGroundY: 0.37 })), 0.37, 'the flat key is read first')
  assertEquals(calibrationGroundYFromMeta(twoPointSidecar({ calibrationGroundY: 0 })), 0, 'a floor at session height 0 is a floor height')
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '0.37', {}, [], true]) {
    assertEquals(calibrationGroundYFromMeta(twoPointSidecar({ calibrationGroundY: bad })), GROUND_Y, `${String(bad)} in the flat key is not a floor height: the record answers`)
  }
  assertEquals(calibrationGroundYFromMeta({ calibrationMethod: 'two-point-ground', calibration: { ...TWO_POINT, groundY: 'high' } }), null)
  assertEquals(calibrationGroundYFromMeta({ calibrationMethod: 'two-point-ground', calibration: TWO_POINT }), null, 'a record from before the field says nothing')
  assertEquals(calibrationGroundYFromMeta({}), null)
  assertEquals(calibrationGroundYFromMeta({ calibration: null }), null)
})

Deno.test('calibrationGroundYFromMeta: a nested record that is another tier\'s is not the one the scan was placed by, so its floor height is not read', () => {
  // The record the job wrote, with a figure of its own that is not the origin's floor.
  const replaced = { ...twoPointSidecar(), calibration: { ...KNOWN_DISTANCE, groundY: 9 } }
  assertEquals(calibrationGroundYFromMeta(replaced), null)
  assertEquals(calibrationGroundYFromMeta({ ...replaced, calibrationGroundY: GROUND_Y }), GROUND_Y, 'the flat key is the one that stays')
  // A record that names no tier cannot be shown to be another one, and is read as it always was.
  assertEquals(calibrationGroundYFromMeta({ calibrationMethod: 'two-point-ground', calibration: { groundY: GROUND_Y } }), GROUND_Y)
})

Deno.test('withReplacedCalibration: the record is replaced, the floor height it held is kept flat beside it, and nothing else of the sidecar changes', () => {
  const before = twoPointSidecar({ scanName: 'kitchen', calibrationFrameId: 'frame-0b1c2d3e', pointCount: 1303 })
  const snapshot = JSON.stringify(before)
  const after = withReplacedCalibration(before, KNOWN_DISTANCE)
  assertEquals(JSON.stringify(before), snapshot, 'the sidecar read is not changed')
  assertEquals(after['calibration'], KNOWN_DISTANCE, 'the job\'s record is the nested record now')
  assertEquals(after['calibrationGroundY'], GROUND_Y, 'and the floor height of the record it replaced is kept')
  const { calibration: _record, calibrationGroundY: _kept, ...rest } = after
  const { calibration: _was, ...restBefore } = before
  assertEquals(rest, restBefore, 'every other key is as it was, the flat tier, the transform and the frame id included')
  // What the manifest says of it: the floor height survives, and the other record's measurements are still not printed.
  assertEquals(calibrationGroundYFromMeta(after), GROUND_Y)
  assertEquals(calibrationFromMeta(after).calibrationMethod, 'two-point-ground')
  assertEquals(calibrationFromMeta(after).calibrationResidualM, null)
})

Deno.test('withReplacedCalibration: a flat floor height that is already there is kept, a record without one adds none, and a second run loses nothing', () => {
  // A second run finds the record the first one wrote, which has no floor height, and the flat key the first one kept.
  const first = withReplacedCalibration(twoPointSidecar(), KNOWN_DISTANCE)
  const second = withReplacedCalibration(first, { ...KNOWN_DISTANCE, residualM: 0.002 })
  assertEquals(second['calibrationGroundY'], GROUND_Y)
  assertEquals((second['calibration'] as { residualM: number }).residualM, 0.002)
  // A flat value beats the record's, as it does when read.
  assertEquals(withReplacedCalibration(twoPointSidecar({ calibrationGroundY: 0.37 }), KNOWN_DISTANCE)['calibrationGroundY'], 0.37)
  // No floor height anywhere: no key is made, so a sidecar that never had one reads as it did.
  const bare = withReplacedCalibration({ calibrationMethod: 'two-point-ground', calibration: TWO_POINT }, KNOWN_DISTANCE)
  assertEquals('calibrationGroundY' in bare, false)
  assertEquals(calibrationGroundYFromMeta(bare), null)
  // A record whose floor height is not a number keeps none, and an absent record is no error.
  assertEquals('calibrationGroundY' in withReplacedCalibration({ calibration: { groundY: NaN } }, KNOWN_DISTANCE), false)
  assertEquals(withReplacedCalibration({}, KNOWN_DISTANCE), { calibration: KNOWN_DISTANCE })
})

Deno.test('withReplacedCalibration: the statement that a scan is in no Place frame outlives the record that made it, and is never invented', () => {
  const outside = twoPointSidecar({ calibration: { ...TWO_POINT, outsidePlaceFrame: true } })
  const replaced = withReplacedCalibration(outside, KNOWN_DISTANCE)
  assertEquals(replaced['calibrationOutsidePlaceFrame'], true, 'kept flat beside the job\'s record')
  assertEquals(asOutsidePlaceFrame(replaced['calibration'], replaced['calibrationOutsidePlaceFrame']), true, 'and read through the same reader as before')
  assertEquals(calibrationFromMeta(replaced).calibrationOutsidePlaceFrame, true, 'so the manifest still says it after the job')
  // A second run finds the flat key and no marker in the record the first one wrote: it stays.
  assertEquals(withReplacedCalibration(replaced, { ...KNOWN_DISTANCE, residualM: 0.002 })['calibrationOutsidePlaceFrame'], true)
  // A flat statement with no nested one is kept too (an exporter may write it flat).
  assertEquals(withReplacedCalibration(twoPointSidecar({ calibrationOutsidePlaceFrame: true }), KNOWN_DISTANCE)['calibrationOutsidePlaceFrame'], true)
  // A scan in its Place's frame says nothing, and the job does not make it say so; nor does a value that is not the boolean true.
  assertEquals('calibrationOutsidePlaceFrame' in withReplacedCalibration(twoPointSidecar(), KNOWN_DISTANCE), false)
  assertEquals('calibrationOutsidePlaceFrame' in withReplacedCalibration(twoPointSidecar({ calibration: { ...TWO_POINT, outsidePlaceFrame: 'true' } }), KNOWN_DISTANCE), false)
  const junk = withReplacedCalibration(twoPointSidecar({ calibrationOutsidePlaceFrame: 1 }), KNOWN_DISTANCE)
  assertEquals(junk['calibrationOutsidePlaceFrame'], 1, 'a flat value that is not the boolean true is left as it was, not turned into the statement')
  assertEquals(asOutsidePlaceFrame(junk['calibration'], junk['calibrationOutsidePlaceFrame']), undefined, 'and is still not the statement')
})
