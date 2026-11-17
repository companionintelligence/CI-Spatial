/**
 * calibration_scale.test.ts — the unit a scan's AR session ran in, from the upload sidecar to the manifest.
 * Run: deno test --allow-read tests/unit/deno/calibration_scale.test.ts
 *
 * The scanner stamps `scaleMode` (which engine configuration produced the unit) and `scaleKind` (what the
 * unit is worth) onto a calibration (`stampScale`, src/ar/engine-config.ts, tested in
 * tests/unit/node/engine_config.test.ts). `src/export/gltf.ts` writes both into the upload sidecar, flat and
 * inside the whole `calibration` record. `scanManifestFromStored` in server/main.ts turns them into
 * `ScanManifest.scaleMode` and `.scaleKind` with `calibrationScaleFromMeta` (server/calibration_fields.ts).
 *
 * The readers must pass exactly the strings the writer produces and nothing else, and a scan stored before
 * units were recorded must come out with no new keys at all. `server/main.ts` exports nothing and cannot be
 * imported, so the sidecar fixture below has the shape `src/export/gltf.ts` writes and the last tests read
 * the sources to fail if either end stops doing what this file models.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { calibrationScaleFromMeta } from '../../../server/calibration_fields.ts'
import { asScaleKind, asScaleMode, scaleKindOfMode } from '../../../src/world/scale-mode.ts'
import type { FixedScaleMode, ScaleKind, ScaleMode } from '../../../src/world/scale-mode.ts'
import type { ScanCalibration, ScanManifest } from '../../../src/world/types.ts'

// ── Every kind and every fixed mode, listed so that a new one cannot be forgotten ───────────
//
// Records keyed by the unions: a member added to `ScaleKind` or `ScaleMode` is a compile error here until it
// is listed, and listing it makes the loops below fail until the readers pass it through.

const EVERY_KIND: Record<ScaleKind, true> = { metric: true, 'estimated-metric': true, arbitrary: true }
const KINDS = Object.keys(EVERY_KIND) as ScaleKind[]

const EVERY_FIXED_MODE: Record<FixedScaleMode, ScaleKind> = {
  'responsive-unconfigured': 'arbitrary',
  'absolute-notapplied': 'arbitrary',
  'absolute-notready': 'arbitrary',
  'absolute-ready': 'estimated-metric',
  'webxr-metric': 'metric',
  'native-metric': 'metric',
}
const FIXED_MODES = Object.keys(EVERY_FIXED_MODE) as FixedScaleMode[]

/** The origin heights the writer produces: `String(n)` of a number rounded to the millimetre. */
const ORIGIN_Y_MODES: ScaleMode[] = [
  'responsive-originY:1.4',
  'responsive-originY:2',
  'responsive-originY:0.3',
  'responsive-originY:3',
  'responsive-originY:1.235',
]

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
  ['absolute-ready'],
  ['metric'],
  { scaleMode: 'absolute-ready' },
  { toString: () => 'absolute-ready' },
  { toString: () => 'metric' },
  Object('absolute-ready'),
  Object('metric'),
  Symbol.for('absolute-ready'),
]

/** Names every object inherits: a reader that looks the value up in a table must not pass these. */
const INHERITED_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']

// ── asScaleKind ──────────────────────────────────────────────────────────────────────────────

Deno.test('asScaleKind: every kind passes through unchanged', () => {
  assertEquals([...KINDS].sort(), ['arbitrary', 'estimated-metric', 'metric'])
  for (const kind of KINDS) assertEquals(asScaleKind(kind), kind, `${kind} must reach the manifest`)
})

Deno.test('asScaleKind: a string that is not a kind stays undefined', () => {
  const unknown = [
    '',
    ' ',
    'Metric',
    'METRIC',
    'metric ',
    ' arbitrary',
    'estimated',
    'estimated_metric',
    'metres',
    'responsive',
    'absolute-ready',
    'verified',
    'null',
    ...INHERITED_KEYS,
  ]
  for (const value of unknown) assertEquals(asScaleKind(value), undefined, `${JSON.stringify(value)} is not a kind`)
})

Deno.test('asScaleKind: a value that is not a string stays undefined, including the null gltf.ts writes', () => {
  for (const value of NOT_STRINGS) assertEquals(asScaleKind(value), undefined, `${Deno.inspect(value)} is not a kind`)
})

// ── asScaleMode ──────────────────────────────────────────────────────────────────────────────

Deno.test('asScaleMode: every fixed mode and every origin height the writer produces passes through unchanged', () => {
  assertEquals(
    [...FIXED_MODES].sort(),
    ['absolute-notapplied', 'absolute-notready', 'absolute-ready', 'native-metric', 'responsive-unconfigured', 'webxr-metric'],
  )
  for (const mode of [...FIXED_MODES, ...ORIGIN_Y_MODES]) assertEquals(asScaleMode(mode), mode, `${mode} must reach the manifest`)
})

Deno.test('asScaleMode: a string the writer never produces stays undefined', () => {
  const unknown = [
    '',
    ' ',
    'absolute',
    'responsive',
    'metric',
    'arbitrary',
    'webxr',
    'native',
    'Absolute-Ready',
    'absolute-ready ',
    ' webxr-metric',
    'absolute_ready',
    'responsive-configured',
    'absolute-estimated',
    'absolute-not-applied',
    'absolute-failed',
    // Origin heights that are not what String(n) writes for a positive number.
    'responsive-originY:',
    'responsive-originY:0',
    'responsive-originY:-1',
    'responsive-originY:1.40',
    'responsive-originY:01.4',
    'responsive-originY:1e0',
    'responsive-originY:1e-1',
    'responsive-originY:abc',
    'responsive-originY:NaN',
    'responsive-originY:Infinity',
    'responsive-originY: 1.4',
    'responsive-originY:1.4 ',
    'responsive-originY:1,4',
    'responsive-originY:0x10',
    'responsive-originy:1.4',
    'responsive-originY',
    'responsive-origin:1.4',
    ...INHERITED_KEYS,
  ]
  for (const value of unknown) assertEquals(asScaleMode(value), undefined, `${JSON.stringify(value)} is not a mode`)
})

Deno.test('asScaleMode: a value that is not a string stays undefined, including the null gltf.ts writes', () => {
  for (const value of NOT_STRINGS) assertEquals(asScaleMode(value), undefined, `${Deno.inspect(value)} is not a mode`)
})

// ── scaleKindOfMode ──────────────────────────────────────────────────────────────────────────

Deno.test('scaleKindOfMode: only absolute-ready is an estimate of metres, and only WebXR and native are metric', () => {
  for (const mode of FIXED_MODES) assertEquals(scaleKindOfMode(mode), EVERY_FIXED_MODE[mode], mode)
  for (const mode of ORIGIN_Y_MODES) assertEquals(scaleKindOfMode(mode), 'arbitrary', `${mode}: a typed height is not a measured metre`)
  // Every mode maps to a kind the readers accept, so a stamp is always one the manifest keeps.
  for (const mode of [...FIXED_MODES, ...ORIGIN_Y_MODES]) assertEquals(asScaleKind(scaleKindOfMode(mode)), scaleKindOfMode(mode))
})

// ── calibrationScaleFromMeta ─────────────────────────────────────────────────────────────────

Deno.test('calibrationScaleFromMeta: reads the flat keys the exporter writes', () => {
  assertEquals(calibrationScaleFromMeta({ scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' }), {
    scaleMode: 'absolute-ready',
    scaleKind: 'estimated-metric',
  })
  assertEquals(calibrationScaleFromMeta({ scaleMode: 'responsive-originY:1.4', scaleKind: 'arbitrary' }), {
    scaleMode: 'responsive-originY:1.4',
    scaleKind: 'arbitrary',
  })
})

Deno.test('calibrationScaleFromMeta: falls back to the whole calibration record when a flat key is missing', () => {
  const nested = { method: 'two-point-ground', scaleMode: 'webxr-metric', scaleKind: 'metric' }
  assertEquals(calibrationScaleFromMeta({ calibration: nested }), { scaleMode: 'webxr-metric', scaleKind: 'metric' })
  // The flat summary the new exporter writes for a record that has none is null, which does not hide the record.
  assertEquals(calibrationScaleFromMeta({ scaleMode: null, scaleKind: null, calibration: nested }), {
    scaleMode: 'webxr-metric',
    scaleKind: 'metric',
  })
})

Deno.test('calibrationScaleFromMeta: the flat key wins over the record, and an invalid flat key does not', () => {
  const nested = { scaleMode: 'native-metric', scaleKind: 'metric' }
  assertEquals(calibrationScaleFromMeta({ scaleMode: 'absolute-notready', scaleKind: 'arbitrary', calibration: nested }), {
    scaleMode: 'absolute-notready',
    scaleKind: 'arbitrary',
  })
  assertEquals(calibrationScaleFromMeta({ scaleMode: 'garbage', scaleKind: 42, calibration: nested }), {
    scaleMode: 'native-metric',
    scaleKind: 'metric',
  })
})

Deno.test('calibrationScaleFromMeta: the two fields are read independently', () => {
  assertEquals(calibrationScaleFromMeta({ scaleMode: 'absolute-ready' }), { scaleMode: 'absolute-ready' })
  assertEquals(calibrationScaleFromMeta({ scaleKind: 'metric' }), { scaleKind: 'metric' })
  assertEquals(calibrationScaleFromMeta({ scaleMode: 'absolute-ready', scaleKind: 'nonsense' }), { scaleMode: 'absolute-ready' })
})

Deno.test('calibrationScaleFromMeta: a sidecar with no unit gives no keys at all, so an old manifest stays as it was', () => {
  const none = calibrationScaleFromMeta({})
  assertEquals(Object.keys(none), [])
  assertEquals(JSON.stringify(none), '{}')
  // The sidecar the previous exporter wrote: a calibration record with no unit in it.
  const previous = {
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibration: { method: 'two-point-ground', status: 'verified', separationM: 1.6 },
  }
  assertEquals(Object.keys(calibrationScaleFromMeta(previous)), [])
  // And the one the new exporter writes for a scan that never calibrated.
  assertEquals(Object.keys(calibrationScaleFromMeta({ scaleMode: null, scaleKind: null, calibration: null })), [])
})

Deno.test('calibrationScaleFromMeta: wrongly typed values, in the flat keys or the record, yield no unit and no error', () => {
  for (const value of NOT_STRINGS) {
    assertEquals(Object.keys(calibrationScaleFromMeta({ scaleMode: value, scaleKind: value })), [], Deno.inspect(value))
    assertEquals(
      Object.keys(calibrationScaleFromMeta({ calibration: { scaleMode: value, scaleKind: value } })),
      [],
      Deno.inspect(value),
    )
  }
  // The record itself may be anything a hand-edited sidecar holds.
  for (const record of ['absolute-ready', 7, true, [], ['metric'], () => 'metric', null, undefined]) {
    assertEquals(Object.keys(calibrationScaleFromMeta({ calibration: record })), [], Deno.inspect(record))
  }
  for (const key of INHERITED_KEYS) {
    assertEquals(Object.keys(calibrationScaleFromMeta({ scaleMode: key, scaleKind: key })), [], key)
  }
})

// ── The sidecar src/export/gltf.ts writes, through to the manifest fields ────────────────────

const CALIBRATED_AT = '2026-11-01T10:00:00.000Z'

const TWO_POINT: Extract<ScanCalibration, { method: 'two-point-ground' }> = {
  method: 'two-point-ground',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  separationM: 1.6,
  residualM: 0.02,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: CALIBRATED_AT,
  status: 'verified',
}

const ONE_POINT: Extract<ScanCalibration, { method: 'ground-tap-compass' }> = {
  method: 'ground-tap-compass',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  anchorBearingDeg: 40,
  calibratedAt: CALIBRATED_AT,
  status: 'provisional',
}

/**
 * The text POST /upload-scan writes to `<scan>.json`: the keys `uploadToServer` in src/export/gltf.ts builds,
 * with the same expressions for the calibration and the unit. `calibration` is the whole record.
 */
function sidecarAsGltfWritesIt(calibration: ScanCalibration | null): string {
  return JSON.stringify({
    detectionCount: 0,
    projectTransform: calibration?.sessionToProject ?? null,
    calibrationMethod: calibration?.method ?? null,
    calibrationStatus: calibration?.status ?? 'uncalibrated',
    scaleMode: calibration?.scaleMode ?? null,
    scaleKind: calibration?.scaleKind ?? null,
    calibration: calibration ?? null,
    pointCount: 1303,
  })
}

type ManifestScale = Pick<ScanManifest, 'scaleMode' | 'scaleKind'>

/** What `scanManifestFromStored` in server/main.ts does with a stored sidecar. The last tests read main.ts. */
function manifestScaleFrom(sidecarText: string): ManifestScale {
  return calibrationScaleFromMeta(JSON.parse(sidecarText) as Record<string, unknown>)
}

/** What the editor receives: GET /worlds/:slug is JSON, and JSON drops a field that is undefined. */
function overTheWire(fields: ManifestScale): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fields))
}

Deno.test('round trip: an absolute-scale two-point sidecar reaches the manifest with its mode and kind', () => {
  const calibration: ScanCalibration = { ...TWO_POINT, scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' }
  const fields = manifestScaleFrom(sidecarAsGltfWritesIt(calibration))
  assertEquals(fields.scaleMode, 'absolute-ready')
  assertEquals(fields.scaleKind, 'estimated-metric')
  assertEquals(overTheWire(fields), { scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' })
})

Deno.test('round trip: an origin-height one-point sidecar keeps the height in its mode and stays arbitrary', () => {
  const calibration: ScanCalibration = { ...ONE_POINT, scaleMode: 'responsive-originY:1.4', scaleKind: 'arbitrary' }
  const fields = manifestScaleFrom(sidecarAsGltfWritesIt(calibration))
  assertEquals(fields.scaleMode, 'responsive-originY:1.4')
  assertEquals(fields.scaleKind, 'arbitrary')
})

Deno.test('round trip: every mode the scanner can stamp survives the sidecar, with the kind it is worth', () => {
  for (const mode of [...FIXED_MODES, ...ORIGIN_Y_MODES]) {
    const kind = scaleKindOfMode(mode)
    const fields = manifestScaleFrom(sidecarAsGltfWritesIt({ ...TWO_POINT, scaleMode: mode, scaleKind: kind }))
    assertEquals(fields, { scaleMode: mode, scaleKind: kind }, mode)
  }
})

Deno.test('round trip: a scan stored before units were recorded comes out with no scale keys, as it always did', () => {
  // The previous exporter's sidecar: no flat keys, and a record with no unit.
  const previous = JSON.stringify({
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'verified',
    calibration: TWO_POINT,
  })
  assertEquals(overTheWire(manifestScaleFrom(previous)), {})
  // The new exporter's sidecar for a calibration that has no unit, and for a scan that never calibrated.
  assertEquals(overTheWire(manifestScaleFrom(sidecarAsGltfWritesIt(TWO_POINT))), {})
  assertEquals(overTheWire(manifestScaleFrom(sidecarAsGltfWritesIt(null))), {})
  assertEquals(overTheWire(manifestScaleFrom('{}')), {})
})

// ── The two ends still do what the round trips above model ───────────────────────────────────

/** One top-level function's text: from its header to the first closing brace in column zero. */
function functionSource(source: string, header: string): string {
  const start = source.indexOf(header)
  assert(start !== -1, `server/main.ts has no function with this header: ${header}`)
  const end = source.indexOf('\n}\n', start)
  assert(end !== -1, `the function with this header does not close in server/main.ts: ${header}`)
  return source.slice(start, end)
}

Deno.test('server/main.ts builds the manifest scale fields with calibrationScaleFromMeta, from the sidecar meta', async () => {
  const main = await Deno.readTextFile(new URL('../../../server/main.ts', import.meta.url))
  // `assert(pattern.test(text), …)` and not assertMatch: on a miss assertMatch prints the whole of main.ts.
  assert(
    /import\s*\{[^}]*\bcalibrationScaleFromMeta\b[^}]*\}\s*from\s*'\.\/calibration_fields\.ts'/.test(main),
    'server/main.ts no longer imports calibrationScaleFromMeta from ./calibration_fields.ts',
  )
  assert(
    !/function\s+calibrationScaleFromMeta\b/.test(main),
    'server/main.ts defines its own calibrationScaleFromMeta again; the manifest would stop using the tested one',
  )
  const build = functionSource(main, 'function scanManifestFromStored(')
  assert(
    /\.\.\.calibrationScaleFromMeta\(\s*scan\.meta\s*\)/.test(build),
    'scanManifestFromStored no longer spreads calibrationScaleFromMeta(scan.meta) into the manifest',
  )
})

Deno.test('src/export/gltf.ts still writes the unit flat beside the tier, from the calibration record', async () => {
  const gltf = await Deno.readTextFile(new URL('../../../src/export/gltf.ts', import.meta.url))
  assert(
    /scaleMode:\s*scanEntry\?\.calibration\?\.scaleMode\s*\?\?\s*null/.test(gltf),
    'the upload sidecar no longer carries scaleMode from scanEntry.calibration',
  )
  assert(
    /scaleKind:\s*scanEntry\?\.calibration\?\.scaleKind\s*\?\?\s*null/.test(gltf),
    'the upload sidecar no longer carries scaleKind from scanEntry.calibration',
  )
  assert(
    /calibration:\s*scanEntry\?\.calibration\s*\?\?\s*null/.test(gltf),
    'the upload sidecar no longer carries the whole calibration record',
  )
})
