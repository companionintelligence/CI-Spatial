/**
 * The Place frame record's validator (src/world/spatial-frame.ts), and the one rule it must never
 * break: it accepts every frame the app writes.
 *
 * The server keeps only what `validateSpatialFrame` accepts (server/wp-a-projects.ts), so a writer the
 * validator disagrees with is a calibration that silently never reaches the Place. That is the failure
 * this file guards against, in three ways:
 *
 *  1. Frames from the real writers. `buildTwoPointCommit` and `buildOnePointCommit` in src/ar/calibration-commit.ts
 *     make the frame the calibration modal returns, so they are called here, with inputs from the real geometry
 *     (`sessionFrameBearingDeg`, `twoPointSeparationM`). Until WP-04b step 0 the writers were closures inside the
 *     modal's DOM flow, and this file cut their frame literals out of the source and evaluated them with a fixed
 *     scope: it could not see a writer move, and it broke as soon as a writer gained a field (WP-10's
 *     `...twoPointBearingFields(...)` made six of these tests fail on names the scope did not supply). The one-point
 *     writer now refuses a null compass reading (WP-10a), so the null-bearing frames #141 wrote are covered by the
 *     legacy fixtures below and not by a writer that no longer makes them.
 *  2. Frames from the builds before it. Fixtures written out by hand from the types at each commit that changed
 *     the frame (7b1f906 two-point schema, 96643a6 the two-point flow, 52ed0cb reference photos, e18c28d the
 *     frame's own bearing), and the frames the browser specs store.
 *  3. The type. SPATIAL_FRAME_FIELDS is typed against ProjectSpatialFrame, so a field added to the type stops
 *     the type check until the validator lists it. Here the writers' keys are compared with that list.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs, and `npm run verify` runs it), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-spatial-frame.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FRAME_EXTENT_M,
  MAX_FRAME_LABEL_LENGTH,
  MAX_SEPARATION_TOLERANCE_M,
  SPATIAL_FRAME_FIELDS,
  isFrameRevision,
  placeFrameRevision,
  referencePhotoPath,
  sameSpatialFrame,
  validateSpatialFrame,
} from '../../../src/world/spatial-frame.ts'
import {
  BEARING_CONVENTION,
  DEFAULT_SEPARATION_TOLERANCE_M,
  MIN_POINT_SEPARATION_M,
  anchorToProjectTransform,
  sessionFrameBearingDeg,
  transformPoint,
  twoPointBearingFields,
  twoPointSeparationM,
  twoPointToProjectTransform,
} from '../../../src/world/geo.ts'
import { referencePhotoUrl } from '../../../server/project_media_meta.ts'
import { buildOnePointCommit, buildTwoPointCommit, resolveCommitOptions, type AcceptedTwoPoint } from '../../../src/ar/calibration-commit.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const CALIBRATED_AT = '2026-11-16T09:30:00.000Z'

/** The modal passes no options of its own, so these are the defaults it runs with. */
const COMMIT_OPTIONS = resolveCommitOptions({ hitTest: async () => null })

/**
 * The Place frame `buildTwoPointCommit` makes for a tap pair, as the modal makes it: accepted as a first calibration
 * (nothing stored, so a frame is written), whatever the pair's length, because what the validator does with a pair
 * the modal would turn away is part of what is tested.
 */
function twoPointFrame(landmark: Vec3, headingMarker: Vec3, bearingDeg: number | null, labels?: [string, string], toleranceM = DEFAULT_SEPARATION_TOLERANCE_M) {
  const accepted: AcceptedTwoPoint = {
    kind: 'accepted',
    separationM: twoPointSeparationM(landmark, headingMarker),
    residualM: 0,
    toleranceM,
    frameChanged: true,
    status: 'provisional',
  }
  const { spatialFrame } = buildTwoPointCommit(accepted, {
    landmark,
    headingMarker,
    frameBearingDeg: bearingDeg,
    bearingConvention: BEARING_CONVENTION,
    pointLabels: labels,
    calibratedAt: CALIBRATED_AT,
  })
  if (!spatialFrame) throw new Error('the writer built no frame for a first calibration')
  return spatialFrame
}

/** The one-point Place frame `buildOnePointCommit` makes when the Place has none, for a compass reading. */
function onePointFrame(bearingDeg: number) {
  const outcome = buildOnePointCommit(
    { landmark: { x: 0, y: 0, z: 0 }, frameBearingDeg: bearingDeg, bearingConvention: BEARING_CONVENTION, existingFrame: undefined, calibratedAt: CALIBRATED_AT },
    COMMIT_OPTIONS,
  )
  if (outcome.kind !== 'committed' || !outcome.spatialFrame) throw new Error('the writer built no frame for a first calibration')
  return outcome.spatialFrame
}

/** mulberry32: a seeded generator, so a failure here is a failure on every machine. */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (random: () => number, low: number, high: number) => low + random() * (high - low)
const yawQuat = (deg: number) => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) })

/** The frame as the server sees it: through JSON. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

test('two-point frames from the real writer and the real transform are accepted, over 300 tap pairs', () => {
  const random = seeded(20261116)
  for (let i = 0; i < 300; i++) {
    // Two taps on the floor, in an AR session whose origin and yaw are arbitrary, at least the capture minimum apart.
    const landmark = { x: between(random, -8, 8), y: between(random, -0.4, 0.4), z: between(random, -8, 8) }
    const heading = between(random, 0, 2 * Math.PI)
    const spacing = between(random, MIN_POINT_SEPARATION_M, 14)
    const headingMarker = { x: landmark.x + Math.sin(heading) * spacing, y: landmark.y, z: landmark.z + Math.cos(heading) * spacing }
    const compass = random() < 0.3 ? null : between(random, 0, 360)
    const bearing = sessionFrameBearingDeg(compass, yawQuat(between(random, -180, 180)))
    const labels: [string, string] | undefined = random() < 0.5 ? undefined : ['north door frame', 'radiator corner']

    const frame = twoPointFrame(landmark, headingMarker, bearing, labels)
    for (const sent of [frame, overTheWire(frame)]) {
      const check = validateSpatialFrame(sent)
      assert.ok(check.ok, `pair ${i} was refused: ${check.ok ? '' : check.error}`)
    }

    // The literal's two points are the project-space images of the real taps under the real transform.
    const transform = twoPointToProjectTransform(landmark, headingMarker)
    const l = transformPoint(transform, landmark)
    const h = transformPoint(transform, headingMarker)
    assert.ok(Math.hypot(l.x, l.y, l.z) < 1e-9, `pair ${i}: the landmark maps to the origin`)
    assert.ok(Math.hypot(h.x, h.z - twoPointSeparationM(landmark, headingMarker)) < 1e-9, `pair ${i}: the marker maps to +Z at the separation`)
    if (frame.method !== 'two-point-ground') throw new Error('the writer built another method')
    assert.ok(Math.hypot(frame.landmark.x - l.x, frame.landmark.z - l.z) < 1e-9, `pair ${i}: the stored landmark is where the transform puts it`)
    assert.ok(Math.hypot(frame.headingMarker.x - h.x, frame.headingMarker.z - h.z) < 1e-9, `pair ${i}: the stored marker is where the transform puts it`)
  }
})

test('the shortest baseline the capture flow commits is accepted, and one below it is the validator\'s refusal', () => {
  const landmark = { x: 0, y: 0, z: 0 }
  assert.ok(validateSpatialFrame(twoPointFrame(landmark, { x: MIN_POINT_SEPARATION_M, y: 0, z: 0 }, null)).ok)
  const short = twoPointFrame(landmark, { x: MIN_POINT_SEPARATION_M - 0.01, y: 0, z: 0 }, null)
  const check = validateSpatialFrame(short)
  assert.ok(!check.ok && /at least 1 m/.test(check.error), 'commitTwoPoint never writes this, and the server would not keep it')
})

test('one-point frames from the real writer are accepted, and with no compass fix it writes none', () => {
  const random = seeded(141)
  for (let i = 0; i < 100; i++) {
    const compass = random() < 0.3 ? null : between(random, 0, 360)
    const bearing = sessionFrameBearingDeg(compass, yawQuat(between(random, -180, 180)))
    if (bearing === null) {
      const refused = buildOnePointCommit(
        { landmark: { x: 1, y: 0, z: 2 }, frameBearingDeg: null, bearingConvention: BEARING_CONVENTION, existingFrame: undefined, calibratedAt: CALIBRATED_AT },
        COMMIT_OPTIONS,
      )
      assert.equal(refused.kind, 'refused', 'the frame\'s whole heading is the compass: without it there is nothing to write')
      continue
    }
    const frame = onePointFrame(bearing)
    assert.ok(validateSpatialFrame(overTheWire(frame)).ok, `bearing ${bearing}`)
    // The tier's transform is built from the same bearing the frame records.
    assert.equal(anchorToProjectTransform({ x: 1, y: 0, z: 2 }, bearing).length, 16)
  }
})

test('a frame the host completes with reference photos is accepted, with the URLs the server hands out', () => {
  const frame = twoPointFrame({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }, 90, ['a', 'b'])
  if (frame.method !== 'two-point-ground') throw new Error('expected two-point')
  const photo = (role: 'landmark' | 'headingMarker', url: string | null) => ({
    url,
    localKey: `proj-1700000000000:${role}`,
    tapPoint: { x: 0.42, y: 0.71 },
    pose: { position: { x: 1, y: 1.4, z: -2 }, rotation: { x: 0, y: 0.3, z: 0, w: 0.95 } },
    capturedAt: '2026-11-16T09:29:00.000Z',
  })
  const withUrls = {
    ...frame,
    referencePhotos: {
      landmark: photo('landmark', referencePhotoUrl('proj-1700000000000', 'landmark')),
      headingMarker: photo('headingMarker', referencePhotoUrl('proj-1700000000000', 'headingMarker')),
    },
  }
  assert.ok(validateSpatialFrame(overTheWire(withUrls), { projectId: 'proj-1700000000000' }).ok, 'both uploaded')
  // An upload that was queued or failed leaves the URL null, and the frame keeps its photos' other fields.
  const pending = { ...frame, referencePhotos: { landmark: photo('landmark', null), headingMarker: photo('headingMarker', null) } }
  assert.ok(validateSpatialFrame(overTheWire(pending), { projectId: 'proj-1700000000000' }).ok, 'neither uploaded')
})

test('the path a photo will be served from is the one the server hands out, and the validator accepts it', () => {
  for (const id of ['proj-default', 'proj-1700000000000', 'proj-a_b-C9', `proj-${'x'.repeat(64)}`]) {
    for (const role of ['landmark', 'headingMarker'] as const) {
      assert.equal(referencePhotoPath(id, role), referencePhotoUrl(id, role), `${id} ${role}`)
      const frame = twoPointFrame({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, null)
      if (frame.method !== 'two-point-ground') throw new Error('expected two-point')
      const photo = (r: 'landmark' | 'headingMarker') => ({
        url: referencePhotoPath(id, r),
        localKey: `${id}:${r}`,
        tapPoint: { x: 0.5, y: 0.5 },
        pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        capturedAt: '2026-11-16T09:29:00.000Z',
      })
      const withPhotos = { ...frame, referencePhotos: { landmark: photo('landmark'), headingMarker: photo('headingMarker') } }
      const check = validateSpatialFrame(overTheWire(withPhotos), { projectId: id })
      assert.ok(check.ok, `${id}: ${check.ok ? '' : check.error}`)
    }
  }
})

test('the keys the writers produce are the keys the validator is typed against', () => {
  const two = twoPointFrame({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, 12, ['a', 'b'])
  const one = onePointFrame(12)
  const twoFields = Object.keys(SPATIAL_FRAME_FIELDS['two-point-ground'])
  const oneFields = Object.keys(SPATIAL_FRAME_FIELDS['ground-tap-compass'])
  for (const key of Object.keys(two)) assert.ok(twoFields.includes(key), `the two-point writer sets ${key}, which the validator does not list`)
  for (const key of Object.keys(one)) assert.ok(oneFields.includes(key), `the one-point writer sets ${key}, which the validator does not list`)
  // And everything the validator requires is something a writer sets.
  for (const key of ['version', 'createdAt', 'method', 'landmark', 'headingMarker', 'separationM', 'toleranceM', 'anchorBearingDeg']) {
    assert.ok(key in two, `the two-point writer no longer sets ${key}`)
  }
  for (const key of ['version', 'createdAt', 'method', 'anchorBearingDeg']) assert.ok(key in one, `the one-point writer no longer sets ${key}`)
})

// ── Frames from earlier builds ───────────────────────────────────────────────

const LEGACY_FRAMES: Array<[string, unknown]> = [
  ['one-point, from #141 (compass fix)', { version: 1, method: 'ground-tap-compass', anchorBearingDeg: 212.5, createdAt: '2026-08-02T10:15:00.000Z' }],
  ['one-point, from #141 (no compass fix)', { version: 1, method: 'ground-tap-compass', anchorBearingDeg: null, createdAt: '2026-08-02T10:15:00.000Z' }],
  [
    'two-point from the 0004 flow, before pointLabels and reference photos (96643a6)',
    {
      version: 1, createdAt: '2026-08-20T08:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 },
      headingMarker: { x: 0, y: 0, z: 2.5 }, separationM: 2.5, toleranceM: 0.15, anchorBearingDeg: null,
    },
  ],
  [
    'two-point with pointLabels, before reference photos (52ed0cb)',
    {
      version: 1, createdAt: '2026-08-25T08:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 },
      headingMarker: { x: 0, y: 0, z: 1.8 }, separationM: 1.8, toleranceM: 0.15, anchorBearingDeg: 91, pointLabels: ['', 'sink'],
    },
  ],
  [
    'two-point whose bearing is the device\'s, from before e18c28d',
    {
      version: 1, createdAt: '2026-09-01T08:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 },
      headingMarker: { x: 0, y: 0, z: 4.2 }, separationM: 4.2, toleranceM: 0.15, anchorBearingDeg: 359.9,
    },
  ],
  [
    'the browser spec\'s stored frame (tests/mock-two-point-calibration.spec.ts)',
    {
      version: 1, createdAt: new Date().toISOString(), method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 }, anchorBearingDeg: null,
      headingMarker: { x: 0, y: 0, z: 3.04 }, separationM: 3.04, toleranceM: 25, pointLabels: ['north door frame', 'radiator corner'],
    },
  ],
  [
    'the anchor-layer spec\'s stored frame (tests/mock-anchor-layer.spec.ts)',
    {
      version: 1, createdAt: '2026-11-01T09:00:00.000Z', method: 'two-point-ground', landmark: { x: 0, y: 0, z: 0 },
      headingMarker: { x: 0, y: 0, z: 2.83 }, separationM: 2.83, toleranceM: 0.15, anchorBearingDeg: null,
    },
  ],
]

for (const [name, frame] of LEGACY_FRAMES) {
  test(`a legacy frame is accepted: ${name}`, () => {
    const check = validateSpatialFrame(frame)
    assert.ok(check.ok, check.ok ? '' : check.error)
    assert.ok(sameSpatialFrame(check.ok ? check.frame : null, frame), 'and stored as it came')
  })
}

test('a frame from the retired three-point method is not one the server will store again', () => {
  const check = validateSpatialFrame({ version: 1, method: 'raycast-reference-triangle', toleranceM: 0.3, createdAt: '2026-07-01T00:00:00.000Z' })
  assert.ok(!check.ok && /method must be/.test(check.error))
})

// ── Refusals ─────────────────────────────────────────────────────────────────

const GOOD = (): Record<string, unknown> => ({
  version: 1,
  createdAt: '2026-11-16T09:30:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 2 },
  separationM: 2,
  toleranceM: 0.15,
  anchorBearingDeg: 10,
})

const PHOTO = (role: string, url: unknown = `/projects/proj-1/reference-photos/ref-${role}.jpg`) => ({
  url,
  localKey: `proj-1:${role}`,
  tapPoint: { x: 0.5, y: 0.5 },
  pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T09:29:00.000Z',
})
const PHOTOS = (over: Record<string, unknown> = {}) => ({ landmark: PHOTO('landmark'), headingMarker: PHOTO('headingMarker'), ...over })

const refusals: Array<[string, unknown, RegExp]> = [
  ['a string', 'banana', /must be an object/],
  ['null', null, /must be an object/],
  ['a number', 5, /must be an object/],
  ['an array', [GOOD()], /must be an object/],
  ['an empty object', {}, /version must be 1/],
  ['version 2', { ...GOOD(), version: 2 }, /version must be 1/],
  ['version as text', { ...GOOD(), version: '1' }, /version must be 1/],
  ['an unknown method', { ...GOOD(), method: 'three-point' }, /method must be/],
  ['no method', { ...GOOD(), method: undefined }, /method must be/],
  ['no createdAt', { ...GOOD(), createdAt: undefined }, /createdAt must be an ISO date/],
  ['a createdAt that is not a date', { ...GOOD(), createdAt: 'yesterday' }, /createdAt must be an ISO date/],
  ['a createdAt that is a number', { ...GOOD(), createdAt: 1700000000000 }, /createdAt must be an ISO date/],
  ['a createdAt that is empty', { ...GOOD(), createdAt: '' }, /createdAt must be an ISO date/],
  // The engine's own date parser reads each of these, and not one is what a writer stores.
  ['a createdAt of "1"', { ...GOOD(), createdAt: '1' }, /createdAt must be an ISO date/],
  ['a createdAt of a year', { ...GOOD(), createdAt: '2026' }, /createdAt must be an ISO date/],
  ['a createdAt of "foo 12"', { ...GOOD(), createdAt: 'foo 12' }, /createdAt must be an ISO date/],
  ['a createdAt of "Mon 5"', { ...GOOD(), createdAt: 'Mon 5' }, /createdAt must be an ISO date/],
  ['a createdAt that is a day with no time', { ...GOOD(), createdAt: '2026-11-16' }, /createdAt must be an ISO date/],
  ['a createdAt with no zone', { ...GOOD(), createdAt: '2026-11-16T09:30:00' }, /createdAt must be an ISO date/],
  ['a createdAt written the way people say it', { ...GOOD(), createdAt: 'Nov 16, 2026 09:30' }, /createdAt must be an ISO date/],
  ['a createdAt with a month that does not exist', { ...GOOD(), createdAt: '2026-13-45T99:99:99Z' }, /createdAt must be an ISO date/],
  ['a createdAt with a fraction too long to be one', { ...GOOD(), createdAt: '2026-11-16T09:30:00.1234567890Z' }, /createdAt must be an ISO date/],
  ['a createdAt followed by more text', { ...GOOD(), createdAt: '2026-11-16T09:30:00.000Z and more' }, /createdAt must be an ISO date/],
  ['a separation of NaN', { ...GOOD(), separationM: NaN }, /finite number/],
  ['a separation of Infinity', { ...GOOD(), separationM: Infinity }, /finite number/],
  ['a separation below the capture minimum', { ...GOOD(), separationM: 0.99, headingMarker: { x: 0, y: 0, z: 0.99 } }, /at least 1 m/],
  ['a separation as text', { ...GOOD(), separationM: '2' }, /separationM must be a number/],
  ['no separation', { ...GOOD(), separationM: undefined }, /separationM must be a number/],
  ['a separation beyond any room', { ...GOOD(), separationM: MAX_FRAME_EXTENT_M + 1, headingMarker: { x: 0, y: 0, z: MAX_FRAME_EXTENT_M + 1 } }, /out of range/],
  ['a separation that is not the distance between the points', { ...GOOD(), separationM: 3 }, /does not match the distance/],
  ['a zero tolerance', { ...GOOD(), toleranceM: 0 }, /toleranceM must be above 0/],
  ['a negative tolerance', { ...GOOD(), toleranceM: -0.1 }, /toleranceM must be above 0/],
  ['a tolerance beyond the bound', { ...GOOD(), toleranceM: MAX_SEPARATION_TOLERANCE_M + 1 }, /toleranceM must be above 0/],
  ['no tolerance', { ...GOOD(), toleranceM: undefined }, /toleranceM must be a number/],
  ['a landmark that is an array', { ...GOOD(), landmark: [0, 0, 0] }, /landmark must be an object/],
  ['a landmark without z', { ...GOOD(), landmark: { x: 0, y: 0 } }, /landmark.z must be a number/],
  ['a landmark far outside any room', { ...GOOD(), landmark: { x: 1e9, y: 0, z: 0 } }, /landmark.x is out of range/],
  ['no heading marker', { ...GOOD(), headingMarker: undefined }, /headingMarker must be an object/],
  ['a bearing as text', { ...GOOD(), anchorBearingDeg: 'north' }, /anchorBearingDeg/],
  ['a bearing that is not an angle', { ...GOOD(), anchorBearingDeg: 1000 }, /anchorBearingDeg/],
  ['no bearing field', { ...GOOD(), anchorBearingDeg: undefined }, /anchorBearingDeg/],
  ['point labels as one text', { ...GOOD(), pointLabels: 'a, b' }, /pointLabels must be two texts/],
  ['one point label', { ...GOOD(), pointLabels: ['a'] }, /pointLabels must be two texts/],
  ['point labels that are numbers', { ...GOOD(), pointLabels: [1, 2] }, /pointLabels must be two texts/],
  ['a point label that is too long', { ...GOOD(), pointLabels: ['x'.repeat(201), 'b'] }, /too long/],
  ['reference photos as an array', { ...GOOD(), referencePhotos: [PHOTO('landmark'), PHOTO('headingMarker')] }, /referencePhotos must be an object/],
  ['reference photos with one marker', { ...GOOD(), referencePhotos: { landmark: PHOTO('landmark') } }, /headingMarker is missing/],
  ['a photo that is not an object', { ...GOOD(), referencePhotos: PHOTOS({ landmark: 'photo' }) }, /landmark must be an object/],
  ['an absolute photo URL', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', 'https://evil.example/ref-landmark.jpg') }) }, /not a reference photo path/],
  ['a photo URL that climbs out of the folder', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', '/projects/../etc/reference-photos/ref-landmark.jpg') }) }, /not a reference photo path/],
  ['a photo URL for another file', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', '/projects/proj-1/reference-photos/passwd') }) }, /not a reference photo path/],
  ['a photo URL with a query', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', '/projects/proj-1/reference-photos/ref-landmark.jpg?x=1') }) }, /not a reference photo path/],
  ['the other marker\'s photo URL', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', '/projects/proj-1/reference-photos/ref-headingMarker.jpg') }) }, /other marker/],
  ['a photo URL that is a number', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', 7) }) }, /server path or null/],
  ['a photo URL of 5000 characters', { ...GOOD(), referencePhotos: PHOTOS({ landmark: PHOTO('landmark', `/projects/proj-1/reference-photos/${'a'.repeat(5000)}`) }) }, /too long/],
  ['a photo with no URL key', { ...GOOD(), referencePhotos: PHOTOS({ landmark: { ...PHOTO('landmark'), url: undefined } }) }, /server path or null/],
  ['a photo key with odd characters', { ...GOOD(), referencePhotos: PHOTOS({ landmark: { ...PHOTO('landmark'), localKey: '../../x' } }) }, /localKey/],
  ['a tap point outside the frame', { ...GOOD(), referencePhotos: PHOTOS({ landmark: { ...PHOTO('landmark'), tapPoint: { x: 1.2, y: 0.5 } } }) }, /between 0 and 1/],
  ['a photo pose that is an array', { ...GOOD(), referencePhotos: PHOTOS({ landmark: { ...PHOTO('landmark'), pose: [] } }) }, /pose must be an object/],
  ['a photo pose with NaN in it', { ...GOOD(), referencePhotos: PHOTOS({ landmark: { ...PHOTO('landmark'), pose: { position: { x: NaN, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } } }) }, /finite/],
  ['a one-point frame with a text bearing', { version: 1, createdAt: '2026-11-16T09:30:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: '12' }, /anchorBearingDeg/],
]

for (const [name, frame, reason] of refusals) {
  test(`a frame is refused: ${name}`, () => {
    const check = validateSpatialFrame(frame, { projectId: 'proj-1' })
    assert.ok(!check.ok, 'it must not be accepted')
    assert.match(check.ok ? '' : check.error, reason)
  })
}

// ── Where each bound sits ────────────────────────────────────────────────────
//
// A bound is two claims: the last value on the near side is kept, and the first value past it is not. A table
// of refusals alone cannot tell a bound that moved from one that was never there.

const withPhotos = (over: Record<string, unknown>) => ({ ...GOOD(), referencePhotos: PHOTOS(over) })
const photoWith = (role: string, over: Record<string, unknown>) => ({ ...PHOTO(role), ...over })

const keptAtTheEdge: Array<[string, unknown]> = [
  ['a createdAt with an offset instead of Z', { ...GOOD(), createdAt: '2026-11-16T09:30:00+01:00' }],
  ['a createdAt with no fraction', { ...GOOD(), createdAt: '2026-11-16T09:30:00Z' }],
  ['a createdAt with nine fraction digits', { ...GOOD(), createdAt: '2026-11-16T09:30:00.123456789Z' }],
  ['a bearing of -360', { ...GOOD(), anchorBearingDeg: -360 }],
  ['a bearing of 360', { ...GOOD(), anchorBearingDeg: 360 }],
  ['a separation of exactly the capture minimum', { ...GOOD(), separationM: 1, headingMarker: { x: 0, y: 0, z: 1 } }],
  ['a separation 0.9 mm off the distance between the points', { ...GOOD(), separationM: 2.0009 }],
  ['a separation of exactly the largest extent', {
    ...GOOD(), landmark: { x: -MAX_FRAME_EXTENT_M / 2, y: 0, z: 0 }, headingMarker: { x: MAX_FRAME_EXTENT_M / 2, y: 0, z: 0 }, separationM: MAX_FRAME_EXTENT_M,
  }],
  ['a tolerance of exactly the bound', { ...GOOD(), toleranceM: MAX_SEPARATION_TOLERANCE_M }],
  ['a point exactly at the largest extent', { ...GOOD(), landmark: { x: MAX_FRAME_EXTENT_M, y: 0, z: 0 }, headingMarker: { x: MAX_FRAME_EXTENT_M, y: 0, z: 2 } }],
  ['a point label of exactly the longest length', { ...GOOD(), pointLabels: ['x'.repeat(MAX_FRAME_LABEL_LENGTH), 'b'] }],
  ['a tap point on the edge of the photo', { ...GOOD(), referencePhotos: PHOTOS({ landmark: photoWith('landmark', { tapPoint: { x: 0, y: 1 } }), headingMarker: photoWith('headingMarker', { tapPoint: { x: 1, y: 0 } }) }) }],
  ['a photo key of 120 characters', withPhotos({ landmark: photoWith('landmark', { localKey: 'k'.repeat(120) }) })],
  ['a Place id of 80 characters in a photo URL', withPhotos({ landmark: photoWith('landmark', { url: `/projects/${'p'.repeat(80)}/reference-photos/ref-landmark.jpg` }) })],
  ['a photo not uploaded yet (a null URL)', withPhotos({ landmark: photoWith('landmark', { url: null }) })],
]

for (const [name, frame] of keptAtTheEdge) {
  test(`the last value inside a bound is kept: ${name}`, () => {
    const check = validateSpatialFrame(frame)
    assert.ok(check.ok, check.ok ? '' : check.error)
  })
}

const refusedPastTheEdge: Array<[string, unknown, RegExp]> = [
  ['a bearing of -360.01', { ...GOOD(), anchorBearingDeg: -360.01 }, /anchorBearingDeg/],
  ['a bearing of 360.01', { ...GOOD(), anchorBearingDeg: 360.01 }, /anchorBearingDeg/],
  ['a separation 2 mm off the distance between the points', { ...GOOD(), separationM: 2.002 }, /does not match the distance/],
  ['a separation past the largest extent, with both points inside it', {
    ...GOOD(), landmark: { x: -MAX_FRAME_EXTENT_M * 0.6, y: 0, z: 0 }, headingMarker: { x: MAX_FRAME_EXTENT_M * 0.6, y: 0, z: 0 }, separationM: MAX_FRAME_EXTENT_M * 1.2,
  }, /separationM is out of range/],
  ['a tolerance just past the bound', { ...GOOD(), toleranceM: MAX_SEPARATION_TOLERANCE_M + 0.01 }, /toleranceM must be above 0/],
  ['a point just past the largest extent', { ...GOOD(), landmark: { x: MAX_FRAME_EXTENT_M + 1, y: 0, z: 0 }, headingMarker: { x: MAX_FRAME_EXTENT_M + 1, y: 0, z: 2 } }, /landmark.x is out of range/],
  ['three point labels', { ...GOOD(), pointLabels: ['a', 'b', 'c'] }, /pointLabels must be two texts/],
  ['a point label one character too long', { ...GOOD(), pointLabels: ['x'.repeat(MAX_FRAME_LABEL_LENGTH + 1), 'b'] }, /too long/],
  ['a tap point of -0.01', withPhotos({ landmark: photoWith('landmark', { tapPoint: { x: -0.01, y: 0.5 } }) }), /between 0 and 1/],
  ['a tap point of 1.01', withPhotos({ landmark: photoWith('landmark', { tapPoint: { x: 0.5, y: 1.01 } }) }), /between 0 and 1/],
  ['a photo with no capture time', withPhotos({ landmark: photoWith('landmark', { capturedAt: undefined }) }), /capturedAt must be text/],
  ['a photo with an empty capture time', withPhotos({ landmark: photoWith('landmark', { capturedAt: '' }) }), /capturedAt must be text/],
  ['a photo with a capture time of 65 characters', withPhotos({ landmark: photoWith('landmark', { capturedAt: 't'.repeat(65) }) }), /capturedAt is too long/],
  ['a photo pose whose rotation is a number', withPhotos({ landmark: photoWith('landmark', { pose: { position: { x: 0, y: 0, z: 0 }, rotation: 5 } }) }), /rotation must be an object/],
  ['a photo pose whose rotation is a list', withPhotos({ landmark: photoWith('landmark', { pose: { position: { x: 0, y: 0, z: 0 }, rotation: [0, 0, 0, 1] } }) }), /rotation must be an object/],
  ['a photo pose whose rotation lacks w', withPhotos({ landmark: photoWith('landmark', { pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } }) }), /rotation.w must be a number/],
  ['a photo key of 121 characters', withPhotos({ landmark: photoWith('landmark', { localKey: 'k'.repeat(121) }) }), /localKey must be a short key/],
  ['a Place id of 81 characters in a photo URL', withPhotos({ landmark: photoWith('landmark', { url: `/projects/${'p'.repeat(81)}/reference-photos/ref-landmark.jpg` }) }), /not a reference photo path/],
  ['a Place id with a slash in a photo URL', withPhotos({ landmark: photoWith('landmark', { url: '/projects/a/b/reference-photos/ref-landmark.jpg' }) }), /not a reference photo path/],
]

for (const [name, frame, reason] of refusedPastTheEdge) {
  test(`the first value past a bound is refused: ${name}`, () => {
    const check = validateSpatialFrame(frame)
    assert.ok(!check.ok, 'it must not be accepted')
    assert.match(check.ok ? '' : check.error, reason)
  })
}

test('a photo URL that names another Place is refused when the Place is known', () => {
  const frame = { ...GOOD(), referencePhotos: PHOTOS() }
  assert.ok(validateSpatialFrame(frame, { projectId: 'proj-1' }).ok)
  assert.ok(validateSpatialFrame(frame).ok, 'with no Place to compare, only the shape is checked')
  const other = validateSpatialFrame(frame, { projectId: 'proj-2' })
  assert.ok(!other.ok && /another Place/.test(other.error))
})

test('keys that reach a prototype are refused at any depth, as they arrive from JSON', () => {
  const top = validateSpatialFrame(JSON.parse(`{"version":1,"method":"ground-tap-compass","anchorBearingDeg":null,"createdAt":"2026-11-16T09:30:00.000Z","__proto__":{"polluted":true}}`))
  assert.ok(!top.ok && /will not store/.test(top.error))
  const nested = validateSpatialFrame({ ...GOOD(), referencePhotos: PHOTOS({ landmark: JSON.parse(`{"constructor":{"x":1}}`) }) })
  assert.ok(!nested.ok && /will not store/.test(nested.error))
  const deep = validateSpatialFrame({ ...GOOD(), extra: { a: { b: JSON.parse('{"prototype":1}') } } })
  assert.ok(!deep.ok && /will not store/.test(deep.error))
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'nothing reached Object.prototype')
})

test('data that is not plain JSON is refused, and so is data past the bounds', () => {
  assert.ok(!validateSpatialFrame({ ...GOOD(), when: new Date() }).ok, 'a Date')
  assert.ok(!validateSpatialFrame({ ...GOOD(), fn: () => 1 }).ok, 'a function')
  assert.ok(!validateSpatialFrame({ ...GOOD(), big: 10n }).ok, 'a bigint')
  assert.ok(!validateSpatialFrame({ ...GOOD(), s: Symbol('x') }).ok, 'a symbol')
  assert.ok(!validateSpatialFrame({ ...GOOD(), text: 'x'.repeat(1001) }).ok, 'a long string')
  assert.ok(!validateSpatialFrame({ ...GOOD(), list: new Array(65).fill(0) }).ok, 'a long array')
  assert.ok(!validateSpatialFrame({ ...GOOD(), nested: { a: { b: { c: { d: { e: { f: 1 } } } } } } }).ok, 'nesting past six levels')
  const wide = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]))
  assert.ok(!validateSpatialFrame({ ...GOOD(), wide }).ok, 'too many keys')
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`g${i}`, new Array(30).fill(1)]))
  assert.ok(!validateSpatialFrame({ ...GOOD(), many }).ok, 'too many values in all')
  assert.ok(!validateSpatialFrame({ ...GOOD(), holes: [1, , 3] }).ok, 'a sparse array')
})

test('fields later packages add are kept when they are plain data, and the accepted frame is a copy', () => {
  const input = {
    ...GOOD(),
    referencePoints: [{ id: 'a', role: 'landmark', x: 0, z: 0 }, { id: 'c', role: 'check', x: 2, z: 3, label: 'sink' }],
    scaleMode: 'responsive',
    knownSeparationM: 3.002,
    projectBearingDeg: null,
    bearingConvention: 2,
    dropped: undefined,
  }
  const check = validateSpatialFrame(input)
  assert.ok(check.ok, check.ok ? '' : check.error)
  const frame = check.ok ? check.frame as unknown as Record<string, unknown> : {}
  assert.deepEqual(frame['referencePoints'], input.referencePoints)
  assert.equal(frame['scaleMode'], 'responsive')
  assert.equal(frame['knownSeparationM'], 3.002)
  assert.equal(frame['projectBearingDeg'], null)
  assert.equal('dropped' in frame, false, 'a property that is undefined is absent, as it is once it has been through JSON')

  assert.notEqual(frame, input, 'a new object')
  assert.notEqual(frame['referencePoints'], input.referencePoints, 'and new arrays inside it')
  ;(input.referencePoints[0] as { x: number }).x = 99
  assert.equal((frame['referencePoints'] as Array<{ x: number }>)[0]!.x, 0, 'changing the input afterwards does not change what was accepted')
})

// ── Identity and revision ────────────────────────────────────────────────────

test('two frames are the same record when every field is equal, whatever order the keys came in', () => {
  const a = GOOD()
  const b = Object.fromEntries(Object.entries(a).reverse())
  assert.equal(sameSpatialFrame(a, b), true)
  assert.equal(sameSpatialFrame(a, { ...a, createdAt: '2026-11-16T09:30:00.001Z' }), false, 'createdAt is part of the record')
  assert.equal(sameSpatialFrame(a, { ...a, landmark: { x: 0, y: 0, z: 1e-12 } }), false, 'a nested field differs')
  assert.equal(sameSpatialFrame(a, { ...a, pointLabels: ['a', 'b'] }), false, 'an extra field differs')
  assert.equal(sameSpatialFrame({ ...a, pointLabels: undefined }, a), true, 'an undefined property is absent')
  assert.equal(sameSpatialFrame(a, null), false)
  assert.equal(sameSpatialFrame(undefined, a), false)
  assert.equal(sameSpatialFrame(null, null), false, 'no frame is not a frame to be the same as')
  assert.equal(sameSpatialFrame('x', 'x'), false)
})

test('a Place reads as revision 0 until a frame write is counted, and a bad value reads as 0', () => {
  assert.equal(placeFrameRevision({}), 0, 'a Place saved before the field existed')
  assert.equal(placeFrameRevision(null), 0)
  assert.equal(placeFrameRevision(undefined), 0)
  assert.equal(placeFrameRevision({ spatialFrameRevision: 0 }), 0)
  assert.equal(placeFrameRevision({ spatialFrameRevision: 3 }), 3)
  for (const bad of [-1, 1.5, NaN, Infinity, '2', null, [], {}, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(placeFrameRevision({ spatialFrameRevision: bad }), 0, String(bad))
  }
})

test('an expected revision is a whole number of 0 or more', () => {
  for (const good of [0, 1, 7, Number.MAX_SAFE_INTEGER]) assert.equal(isFrameRevision(good), true, String(good))
  for (const bad of [-1, 0.5, NaN, Infinity, '1', null, undefined, {}, []]) assert.equal(isFrameRevision(bad), false, String(bad))
})
