/**
 * The fields S0 added to the Place frame (src/world/spatial-frame.ts): `frameId`, `checkPoints`, the frame-scoped
 * photo URL and its roles, and the predicate `isPlaceFrameMethod`.
 *
 * The rule they must keep is the one tests/unit/node/wp-spatial-frame.test.ts and wp-s0-golden.test.ts hold:
 * every frame written so far is accepted and stored as it came. What this file adds is the other half of a
 * validator: each new field is accepted where it is right, and every malformed variant is refused with the field's
 * own name in the reason, at both ends of every bound (the last value inside a bound is kept, the first past it is
 * not). A table of refusals alone cannot tell a bound that moved from one that was never there.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs, and `npm run verify` runs it), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-s0-frame-schema.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FRAME_PHOTO_ROLES,
  MAX_CHECK_POINTS,
  MAX_FRAME_ID_LENGTH,
  MAX_FRAME_LABEL_LENGTH,
  MAX_FRAME_EXTENT_M,
  SPATIAL_FRAME_FIELDS,
  SPATIAL_FRAME_METHODS,
  framePhotoPath,
  isFrameId,
  isPlaceFrameMethod,
  referencePhotoPath,
  sameSpatialFrame,
  validateSpatialFrame,
} from '../../../src/world/spatial-frame.ts'
import type { ProjectSpatialFrame } from '../../../src/world/types.ts'

const PLACE = 'proj-1700000000000'
/** A UUID, what `crypto.randomUUID()` gives. */
const UUID = '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607'
/** What the capture client mints on a page with no `randomUUID`: the time in base 36 and eight random bytes. */
const FALLBACK = 'mfgz5y3k-0123456789abcdef'

const GOOD = (): Record<string, unknown> => ({
  version: 1,
  createdAt: '2026-11-16T09:30:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.15,
  anchorBearingDeg: 10,
})
const ONE_POINT = (): Record<string, unknown> => ({ version: 1, createdAt: '2026-11-16T09:30:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 12 })

/** A photo record, with the URL the slot's role names under `frameId`, or what `url` says. */
const photo = (url: string | null, over: Record<string, unknown> = {}) => ({
  url,
  localKey: `${PLACE}:${UUID}:photo`,
  tapPoint: { x: 0.5, y: 0.5 },
  pose: { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T09:29:00.000Z',
  ...over,
})
const scoped = (role: string, frameId = UUID, place = PLACE) => `/projects/${place}/frames/${frameId}/ref-${role}.jpg`
const legacy = (role: string, place = PLACE) => `/projects/${place}/reference-photos/ref-${role}.jpg`

const accepted = (frame: unknown, options: { projectId?: string } = { projectId: PLACE }): void => {
  const check = validateSpatialFrame(frame, options)
  assert.ok(check.ok, check.ok ? '' : check.error)
  assert.deepEqual(check.frame, JSON.parse(JSON.stringify(frame)), 'accepted as it came: no field dropped, none invented')
}
const refused = (frame: unknown, reason: RegExp, options: { projectId?: string } = { projectId: PLACE }): void => {
  const check = validateSpatialFrame(frame, options)
  assert.ok(!check.ok, 'it must not be accepted')
  assert.match(check.ok ? '' : check.error, reason)
}

// ── frameId ──────────────────────────────────────────────────────────────────────────────────────

test('the frame ids a client mints are accepted: a UUID and the no-randomUUID fallback', () => {
  for (const id of [UUID, FALLBACK]) {
    accepted({ ...GOOD(), frameId: id })
    assert.equal(isFrameId(id), true, id)
  }
})

test('a frame id is 1 to 64 letters, digits, hyphens or underscores, and the bound is where the constant says', () => {
  assert.equal(MAX_FRAME_ID_LENGTH, 64)
  for (const id of ['a', 'A', '0', '-', '_', 'frame-1', 'Frame_2', 'x'.repeat(MAX_FRAME_ID_LENGTH)]) {
    accepted({ ...GOOD(), frameId: id })
  }
  for (const id of ['x'.repeat(MAX_FRAME_ID_LENGTH + 1)]) {
    refused({ ...GOOD(), frameId: id }, /frameId must be 1 to 64/)
  }
})

test('a frame id that could climb out of a path, split a key or break a URL is refused', () => {
  const bad = ['', ' ', 'a b', 'a.b', '..', '../x', 'a/b', '/', 'a:b', 'a\\b', 'a?x=1', 'a#b', 'a%2fb', 'é', 'a\n', '\u0000', '<script>', 'proj-1/frame-1']
  for (const id of bad) refused({ ...GOOD(), frameId: id }, /frameId must be 1 to 64/)
  for (const id of bad) assert.equal(isFrameId(id), false, JSON.stringify(id))
})

test('a frame id that is not text is refused, null included', () => {
  for (const id of [null, 0, 1, true, false, [], ['a'], {}]) {
    refused({ ...GOOD(), frameId: id }, /frameId must be 1 to 64/)
    assert.equal(isFrameId(id), false)
  }
  // Not coerced: an object that would print as an id is not one. (The validator refuses it earlier still, as data that is not plain.)
  assert.equal(isFrameId({ toString: () => 'abc' }), false)
  assert.equal(isFrameId(Object('abc')), false)
})

test('a frame with no id is a frame of unknown generation, and is accepted exactly as before', () => {
  const check = validateSpatialFrame(GOOD())
  assert.ok(check.ok)
  assert.equal('frameId' in (check.ok ? check.frame : {}), false, 'none is invented')
})

test('the id is checked on the one-point frame too, because it ends up in the same URLs and keys', () => {
  accepted({ ...ONE_POINT(), frameId: UUID })
  refused({ ...ONE_POINT(), frameId: 'a/b' }, /frameId must be 1 to 64/)
})

test('two frames that differ only in their id are different records, and the same id twice is the same frame', () => {
  const a = { ...GOOD(), frameId: UUID }
  assert.equal(sameSpatialFrame(a, { ...GOOD(), frameId: FALLBACK }), false)
  assert.equal(sameSpatialFrame(a, { ...GOOD() }), false)
  assert.equal(sameSpatialFrame(a, Object.fromEntries(Object.entries(a).reverse())), true)
})

// ── checkPoints ──────────────────────────────────────────────────────────────────────────────────

const point = (x: number, z: number, over: Record<string, unknown> = {}) => ({ x, y: 0, z, ...over })

test('the schema holds up to three check points, one more is refused, and the constant says so', () => {
  assert.equal(MAX_CHECK_POINTS, 3)
  const points = [point(2, 1.5), point(-1, 2), point(4, 4)]
  for (let n = 0; n <= 3; n++) accepted({ ...GOOD(), frameId: UUID, checkPoints: points.slice(0, n) })
  refused({ ...GOOD(), checkPoints: [...points, point(5, 5)] }, /checkPoints holds at most 3 points/)
})

test('a check point may carry a name, a height and a photo, and its photo is frame-scoped', () => {
  accepted({ ...GOOD(), frameId: UUID, checkPoints: [point(2, 1.5, { y: 0.02, label: 'sink' })] })
  accepted({
    ...GOOD(),
    frameId: UUID,
    checkPoints: [point(2, 1.5, { label: 'sink', photo: photo(scoped('check1')) })],
  })
  accepted({ ...GOOD(), frameId: UUID, checkPoints: [point(2, 1.5, { photo: photo(null) })] })
})

test('check points are kept in the order they were given, and the order is part of the record', () => {
  const a = { ...GOOD(), frameId: UUID, checkPoints: [point(2, 1.5), point(-1, 2)] }
  const b = { ...GOOD(), frameId: UUID, checkPoints: [point(-1, 2), point(2, 1.5)] }
  assert.equal(sameSpatialFrame(a, b), false, 'the first stored point is not the second')
  const check = validateSpatialFrame(a)
  assert.ok(check.ok && (check.frame as Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>).checkPoints?.[0]?.x === 2)
})

const refusedCheckPoints: Array<[string, unknown, RegExp]> = [
  ['an object instead of a list', { 0: point(1, 1) }, /checkPoints must be a list/],
  ['one point instead of a list', point(1, 1), /checkPoints must be a list/],
  ['text', 'a, b', /checkPoints must be a list/],
  ['null', null, /checkPoints must be a list/],
  ['a number', 3, /checkPoints must be a list/],
  ['a point that is a list', [[1, 0, 1]], /checkPoints\[0\] must be an object with x, y and z/],
  ['a point that is null', [point(1, 1), null], /checkPoints\[1\] must be an object with x, y and z/],
  ['a point that is a number', [7], /checkPoints\[0\] must be an object with x, y and z/],
  ['a point with no z', [{ x: 1, y: 0 }], /checkPoints\[0\]\.z must be a number/],
  ['a point whose x is text', [{ x: '1', y: 0, z: 1 }], /checkPoints\[0\]\.x must be a number/],
  ['a point far outside any room', [point(MAX_FRAME_EXTENT_M + 1, 0)], /checkPoints\[0\]\.x is out of range/],
  ['a second point far outside any room', [point(1, 1), point(0, -MAX_FRAME_EXTENT_M - 1)], /checkPoints\[1\]\.z is out of range/],
  ['a point with a number as its name', [point(1, 1, { label: 7 })], /checkPoints\[0\]\.label must be text/],
  ['a point with a null name', [point(1, 1, { label: null })], /checkPoints\[0\]\.label must be text/],
  ['a name past the longest', [point(1, 1, { label: 'x'.repeat(MAX_FRAME_LABEL_LENGTH + 1) })], /checkPoints\[0\]\.label is too long/],
  ['a photo that is text', [point(1, 1, { photo: 'photo.jpg' })], /checkPoints\[0\]\.photo must be an object/],
  ['a photo that is null', [point(1, 1, { photo: null })], /checkPoints\[0\]\.photo must be an object/],
  ['a photo with a tap point outside the picture', [point(1, 1, { photo: photo(null, { tapPoint: { x: 1.5, y: 0.5 } }) })], /checkPoints\[0\]\.photo\.tapPoint\.x must be between 0 and 1/],
  ['a photo with no key', [point(1, 1, { photo: photo(null, { localKey: undefined }) })], /checkPoints\[0\]\.photo\.localKey must be a short key/],
  ['a photo with a pose that is a list', [point(1, 1, { photo: photo(null, { pose: [] }) })], /checkPoints\[0\]\.photo\.pose must be an object/],
]
for (const [name, checkPoints, reason] of refusedCheckPoints) {
  test(`check points are refused: ${name}`, () => refused({ ...GOOD(), frameId: UUID, checkPoints }, reason))
}

test('the last value inside each check point bound is kept', () => {
  accepted({ ...GOOD(), checkPoints: [point(MAX_FRAME_EXTENT_M, -MAX_FRAME_EXTENT_M)] })
  accepted({ ...GOOD(), checkPoints: [point(1, 1, { label: 'x'.repeat(MAX_FRAME_LABEL_LENGTH) })] })
  accepted({ ...GOOD(), checkPoints: [point(1, 1, { label: '' })] })
  accepted({ ...GOOD(), checkPoints: [] })
})

test('a check point cannot reach a prototype, at any depth, as it arrives from JSON', () => {
  const top = validateSpatialFrame({ ...GOOD(), checkPoints: [JSON.parse('{"x":1,"y":0,"z":1,"__proto__":{"polluted":true}}')] })
  assert.ok(!top.ok && /will not store/.test(top.error))
  const nested = validateSpatialFrame({ ...GOOD(), frameId: UUID, checkPoints: [point(1, 1, { photo: JSON.parse('{"constructor":{"x":1}}') })] })
  assert.ok(!nested.ok && /will not store/.test(nested.error))
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
})

test('a check point on a one-point frame is only data: that member has no check points to validate', () => {
  accepted({ ...ONE_POINT(), checkPoints: 'anything plain' })
})

// ── frame-scoped photo URLs, and the roles ───────────────────────────────────────────────────────

test('the roles are the landmark, the heading marker and one per check point, in that order', () => {
  assert.deepEqual([...FRAME_PHOTO_ROLES], ['landmark', 'heading', 'check1', 'check2', 'check3'])
  assert.equal(FRAME_PHOTO_ROLES.length, 2 + MAX_CHECK_POINTS, 'one photo role for each check point the schema holds')
})

test('framePhotoPath builds /projects/:id/frames/:frameId/ref-<role>.jpg and encodes what it is given', () => {
  assert.equal(framePhotoPath(PLACE, UUID, 'check2'), `/projects/${PLACE}/frames/${UUID}/ref-check2.jpg`)
  assert.equal(framePhotoPath('proj a', 'f/1', 'landmark'), '/projects/proj%20a/frames/f%2F1/ref-landmark.jpg')
})

test('every role has a path the validator accepts in the slot that names it, and refuses in every other', () => {
  const place = (slot: string, url: string): Record<string, unknown> => {
    if (slot === 'landmark' || slot === 'headingMarker') {
      const other = slot === 'landmark' ? 'headingMarker' : 'landmark'
      return { ...GOOD(), frameId: UUID, referencePhotos: { [slot]: photo(url), [other]: photo(null) } }
    }
    const index = Number(slot.slice(-1)) - 1
    return {
      ...GOOD(),
      frameId: UUID,
      checkPoints: Array.from({ length: index + 1 }, (_, i) => (i === index ? point(1 + i, 1, { photo: photo(url) }) : point(1 + i, 1))),
    }
  }
  const SLOTS = [['landmark', 'landmark'], ['headingMarker', 'heading'], ['check1', 'check1'], ['check2', 'check2'], ['check3', 'check3']] as const
  for (const [slot, role] of SLOTS) {
    accepted(place(slot, framePhotoPath(PLACE, UUID, role)))
    for (const other of FRAME_PHOTO_ROLES.filter((candidate) => candidate !== role)) {
      refused(place(slot, framePhotoPath(PLACE, UUID, other)), /another point's photo/)
    }
    // The same slot, named in the legacy folder: its own role there is the slot's own name.
    accepted(place(slot, legacy(slot)))
    for (const [otherSlot] of SLOTS.filter(([candidate]) => candidate !== slot)) {
      refused(place(slot, legacy(otherSlot)), /(the other marker's|another point's) photo/)
    }
  }
})

test('the heading marker\'s frame-scoped role is "heading", as the package that defined the URL named it, and not "headingMarker", which every other path and field says', () => {
  const frame = (url: string) => ({ ...GOOD(), frameId: UUID, referencePhotos: { landmark: photo(scoped('landmark')), headingMarker: photo(url) } })
  accepted(frame(scoped('heading')))
  refused(frame(scoped('headingMarker')), /not a reference photo path/)
})

test('a frame-scoped URL must name the frame it is in, the Place it is for, and exist as a path', () => {
  /** `frameId` null is a frame with no id. */
  const frame = (url: string, frameId: string | null = UUID) => ({
    ...GOOD(),
    ...(frameId === null ? {} : { frameId }),
    referencePhotos: { landmark: photo(url), headingMarker: photo(null) },
  })
  accepted(frame(scoped('landmark')))
  refused(frame(scoped('landmark', FALLBACK)), /belongs to another frame/)
  refused(frame(scoped('landmark'), null), /names a frame and this record has no frameId/)
  refused(frame(scoped('landmark', UUID, 'proj-1700000000001')), /belongs to another Place/)
  assert.ok(validateSpatialFrame(frame(scoped('landmark', UUID, 'proj-1700000000001'))).ok, 'with no Place to compare, only the shape is checked')
  for (const url of [
    `/projects/${PLACE}/frames/${UUID}/ref-landmark.png`,
    `/projects/${PLACE}/frames/${UUID}/ref-check4.jpg`,
    `/projects/${PLACE}/frames/${UUID}/ref-landmark.jpg?x=1`,
    `/projects/${PLACE}/frames/${UUID}/extra/ref-landmark.jpg`,
    `/projects/${PLACE}/frames/../frames/${UUID}/ref-landmark.jpg`,
    `/projects/${PLACE}/frames//ref-landmark.jpg`,
    `/projects/${PLACE}/frames/${'f'.repeat(MAX_FRAME_ID_LENGTH + 1)}/ref-landmark.jpg`,
    `/projects/${'p'.repeat(81)}/frames/${UUID}/ref-landmark.jpg`,
    `https://evil.example${scoped('landmark')}`,
    `${scoped('landmark')}/`,
  ]) {
    refused(frame(url), /not a reference photo path/, {})
  }
})

// What keeps a stored photo URL on this server. `resolveApiUrl` (src/shared/api-base.ts) passes an absolute URL through
// unchanged, so a record that carried `https://other.example/projects/...` would have every scanner and every editor
// fetch from another host; and a Place segment with a dot, a percent or a slash in it is a path that climbs, or that a
// server decodes to something else. The two shapes are held to that separately, with the Place to compare and without it,
// because the shape alone is all that is left to hold when no Place is named.
const BOTH_WAYS: Array<{ projectId?: string }> = [{}, { projectId: PLACE }]
const withLandmarkPhoto = (url: string) => ({ ...GOOD(), frameId: UUID, referencePhotos: { landmark: photo(url), headingMarker: photo(null) } })
const SHAPES: Array<[string, (placeSegment: string) => string]> = [
  ['the legacy', (place) => legacy('landmark', place)],
  ['the frame-scoped', (place) => scoped('landmark', UUID, place)],
]

for (const [shape, url] of SHAPES) {
  test(`${shape} photo URL is a path on this server: a host, a scheme or anything before the first slash is refused`, () => {
    const good = url(PLACE)
    for (const prefix of ['https://evil.example', 'http://evil.example', '//evil.example', 'evil.example', 'javascript:', 'file://', ' ', '\n', '\t', 'x', '.', '/']) {
      for (const options of BOTH_WAYS) refused(withLandmarkPhoto(`${prefix}${good}`), /not a reference photo path/, options)
    }
    for (const options of BOTH_WAYS) accepted(withLandmarkPhoto(good), options)
  })

  test(`${shape} photo URL names its Place by letters, digits, hyphens and underscores only, 1 to 80 of them`, () => {
    for (const segment of ['..', '.', '', 'a/b', '/a', 'a/', 'a%2fb', 'a%2Fb', 'a%20b', '%2e%2e', 'a.b', '.hidden', 'a b', 'a\\b', 'a:b', 'a?b', 'a#b', 'a;b', 'é', 'a\u0000b', 'a\nb', 'p'.repeat(81)]) {
      for (const options of BOTH_WAYS) refused(withLandmarkPhoto(url(segment)), /not a reference photo path/, options)
    }
    for (const segment of ['a', 'A', '0', '-', '_', 'proj-1700000000000', 'p'.repeat(80)]) accepted(withLandmarkPhoto(url(segment)), {})
  })

  test(`${shape} photo URL ends at the file: nothing after .jpg, and no other extension`, () => {
    const whole = url(PLACE)
    const stem = whole.slice(0, -'.jpg'.length)
    for (const variant of [`${whole}/`, `${whole}?x=1`, `${whole}#x`, `${whole}%00`, `${whole}\n`, `${whole} `, `${whole}x`, `${whole}.jpg`, `${stem}.png`, `${stem}.jpeg`, `${stem}.JPG`, stem]) {
      for (const options of BOTH_WAYS) refused(withLandmarkPhoto(variant), /not a reference photo path/, options)
    }
  })
}

test('the last frame id and Place id inside the URL bounds are kept', () => {
  const longest = 'f'.repeat(MAX_FRAME_ID_LENGTH)
  accepted({ ...GOOD(), frameId: longest, referencePhotos: { landmark: photo(scoped('landmark', longest)), headingMarker: photo(null) } }, {})
  const place = `proj-${'p'.repeat(75)}`
  assert.equal(place.length, 80)
  accepted({ ...GOOD(), frameId: UUID, referencePhotos: { landmark: photo(scoped('landmark', UUID, place)), headingMarker: photo(null) } }, {})
})

test('the key a frame-scoped photo is kept under on the phone fits the key bound, for the longest id', () => {
  const key = `${PLACE}:${'f'.repeat(MAX_FRAME_ID_LENGTH)}:heading`
  accepted(
    { ...GOOD(), frameId: UUID, referencePhotos: { landmark: photo(scoped('landmark'), { localKey: key }), headingMarker: photo(null) } },
  )
  assert.ok(key.length <= 120, `${key.length} characters`)
})

test('the legacy photo paths stay valid, on a frame with an id and on one without, and are unchanged', () => {
  for (const frameId of [undefined, UUID]) {
    const frame = {
      ...GOOD(),
      ...(frameId === undefined ? {} : { frameId }),
      referencePhotos: { landmark: photo(legacy('landmark')), headingMarker: photo(legacy('headingMarker')) },
    }
    accepted(frame)
  }
  assert.equal(referencePhotoPath(PLACE, 'landmark'), legacy('landmark'))
  assert.equal(referencePhotoPath(PLACE, 'headingMarker'), legacy('headingMarker'))
})

test('a check point\'s photo may name the legacy folder with its own role, and only its own, with or without a frame id', () => {
  for (const frameId of [undefined, UUID]) {
    const withId = frameId === undefined ? {} : { frameId }
    accepted({ ...GOOD(), ...withId, checkPoints: [point(1, 1, { photo: photo(legacy('check1')) })] })
    accepted({ ...GOOD(), ...withId, checkPoints: [point(1, 1), point(2, 2), point(3, 3, { photo: photo(legacy('check3')) })] })
  }
  const second = (url: string) => ({ ...GOOD(), frameId: UUID, checkPoints: [point(1, 1), point(2, 2, { photo: photo(url) })] })
  refused(second(legacy('check1')), /another point's photo/)
  refused(second(legacy('landmark')), /another point's photo/)
  refused(second(legacy('headingMarker')), /another point's photo/)
  refused(second(legacy('check4')), /not a reference photo path/)
  refused(second(legacy('heading')), /not a reference photo path/)
  refused(second(legacy('check2', 'proj-1700000000001')), /another Place/)
  accepted(second(legacy('check2')))
})

test('the markers keep their own legacy words: the other marker\'s legacy path is the other marker\'s, a check point\'s is another point\'s', () => {
  refused(
    { ...GOOD(), referencePhotos: { landmark: photo(legacy('headingMarker')), headingMarker: photo(null) } },
    /the other marker's photo/,
  )
  refused(
    { ...GOOD(), referencePhotos: { landmark: photo(legacy('check1')), headingMarker: photo(null) } },
    /another point's photo/,
  )
  refused(
    { ...GOOD(), referencePhotos: { landmark: photo(legacy('landmark', 'proj-1700000000001')), headingMarker: photo(null) } },
    /another Place/,
  )
})

test('a frame at the schema\'s maximum is accepted whole: an id, both photos, three named check points with photos', () => {
  const frame = {
    ...GOOD(),
    frameId: UUID,
    projectBearingDeg: 123.4,
    bearingConvention: 2,
    pointLabels: ['north door frame', 'radiator corner'],
    referencePhotos: { landmark: photo(scoped('landmark')), headingMarker: photo(scoped('heading')) },
    checkPoints: [1, 2, 3].map((n) => point(n, n + 1, { label: `point ${n}`, photo: photo(scoped(`check${n}`)) })),
  }
  accepted(frame)
  assert.ok(JSON.stringify(frame).length < 4000, 'a full frame is a few kilobytes, nothing a route would refuse')
})

// ── The tables and the predicate ─────────────────────────────────────────────────────────────────

test('SPATIAL_FRAME_FIELDS lists exactly the keys of a frame with every field set, for each method', () => {
  const full = {
    ...GOOD(),
    projectBearingDeg: 123,
    bearingConvention: 2,
    pointLabels: ['a', 'b'],
    referencePhotos: { landmark: photo(scoped('landmark')), headingMarker: photo(scoped('heading')) },
    frameId: UUID,
    checkPoints: [point(1, 1)],
  }
  accepted(full)
  assert.deepEqual(Object.keys(full).sort(), Object.keys(SPATIAL_FRAME_FIELDS['two-point-ground']).sort())
  const one = { ...ONE_POINT(), bearingConvention: 2 }
  accepted(one)
  assert.deepEqual(Object.keys(one).sort(), Object.keys(SPATIAL_FRAME_FIELDS['ground-tap-compass']).sort())
  assert.deepEqual(Object.keys(SPATIAL_FRAME_FIELDS).sort(), [...SPATIAL_FRAME_METHODS].sort(), 'one entry per method')
})

test('isPlaceFrameMethod is true for the methods a frame can have and nothing else', () => {
  // The tiers the app writes a frame with today. A tier added to the frame type joins the list, and every method on it
  // is a frame method: that is the predicate's whole definition, so the list is not pinned to these two.
  for (const method of ['two-point-ground', 'ground-tap-compass']) assert.ok((SPATIAL_FRAME_METHODS as readonly string[]).includes(method), method)
  for (const method of SPATIAL_FRAME_METHODS) assert.equal(isPlaceFrameMethod(method), true, method)
  for (
    const other of [
      'known-distance',
      'three-point',
      'two-point',
      'Two-Point-Ground',
      'two-point-ground ',
      '',
      'constructor',
      '__proto__',
      'toString',
      'length',
      '0',
      undefined,
      null,
      0,
      1,
      true,
      [],
      ['two-point-ground'],
      {},
      { toString: () => 'two-point-ground' },
    ]
  ) {
    assert.equal(isPlaceFrameMethod(other), false, String(other))
  }
})

test('the validator and the predicate agree about what a method is, in both directions', () => {
  for (const method of [...SPATIAL_FRAME_METHODS, 'known-distance', 'three-point', '', 'constructor']) {
    const check = validateSpatialFrame({ ...GOOD(), method })
    const methodRefused = !check.ok && /method must be/.test(check.error)
    assert.equal(methodRefused, !isPlaceFrameMethod(method), `${method}`)
  }
})

test('narrowing: after the predicate, the method is a member of the frame type', () => {
  const method: unknown = 'two-point-ground'
  if (isPlaceFrameMethod(method)) {
    const known: ProjectSpatialFrame['method'] = method
    assert.equal(known, 'two-point-ground')
  } else {
    assert.fail('a frame method must narrow')
  }
})

// ── The import graph of the schema ───────────────────────────────────────────────────────────────
//
// ADR 0002: what the browser imports, even for a type, lives in a file with no Deno reference, and so do the files
// that file imports. `ScanCalibration` stores a tap and a fit, which are built in modules that import the AR provider
// (three.js, the DOM) and in `frame-fit.ts` (which imports `Vec3` from the hub), so the types are declared in a leaf
// below both (src/world/calibration-evidence.ts) and re-exported. These tests hold the graph to that: nothing
// reachable from the hub or from this module is a DOM or Deno module, and no cycle runs through them, type-only
// edges included (`import type` is not erased by the checker, and a cycle through the hub is a cycle everywhere).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The module's source without its comments, so the word "document" in a sentence is not a DOM reference. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The relative modules a file imports or re-exports from, as absolute paths. Extensionless specifiers get `.ts`. */
function importsOf(file: string): string[] {
  const found: string[] = []
  for (const match of code(file).matchAll(/\b(?:import|export)\s+(?:type\s+)?[^'";]*?\bfrom\s+'(\.[^']*)'/g)) {
    const specifier = match[1]!
    found.push(resolve(dirname(file), /\.[a-z]+$/.test(specifier) ? specifier : `${specifier}.ts`))
  }
  return found
}

/** Every module reachable from `start`, `start` included, and whether a cycle runs through any of them. */
function closure(start: string): { files: string[]; cyclic: boolean } {
  const files = new Set<string>()
  let cyclic = false
  const visit = (file: string, path: string[]): void => {
    if (path.includes(file)) {
      cyclic = true
      return
    }
    if (files.has(file)) return
    files.add(file)
    for (const next of importsOf(file)) visit(next, [...path, file])
  }
  visit(start, [])
  return { files: [...files], cyclic }
}

const HOMES = [join(ROOT, 'src/world'), join(ROOT, 'src/shared')]
const RUNTIME_SPECIFIC = /\b(Deno|window|document|navigator|localStorage|sessionStorage|indexedDB|HTMLElement|HTMLCanvasElement)\b/

for (const entry of ['src/world/types.ts', 'src/world/spatial-frame.ts', 'src/world/calibration-evidence.ts']) {
  test(`the modules ${entry} imports, all the way down, are Deno-API-free, in the shared homes, and acyclic`, () => {
    const { files, cyclic } = closure(join(ROOT, entry))
    assert.equal(cyclic, false, `a cycle runs through ${entry}'s imports, type-only edges included`)
    for (const file of files) {
      assert.ok(HOMES.some((home) => file.startsWith(`${home}/`)), `${file} is not in src/world or src/shared (ADR 0002)`)
      assert.equal(RUNTIME_SPECIFIC.test(code(file)), false, `${file} refers to Deno or the DOM`)
    }
  })
}

test('the hub imports the leaf and the unit module, and the leaf imports nothing', () => {
  const hub = importsOf(join(ROOT, 'src/world/types.ts')).map((file) => file.slice(ROOT.length + 1)).sort()
  assert.deepEqual(hub, ['src/world/calibration-evidence.ts', 'src/world/manifests.ts', 'src/world/scale-mode.ts'])
  assert.deepEqual(importsOf(join(ROOT, 'src/world/calibration-evidence.ts')), [])
})

test('source shape: the two modules that build a tap and a fit re-export the leaf\'s types under the names they always had', () => {
  const tap = readFileSync(join(ROOT, 'src/ar/tap-sampling.ts'), 'utf8')
  assert.match(tap, /import type \{ TapEvidence, TapSource \} from '\.\.\/world\/calibration-evidence\.ts'/)
  assert.match(tap, /export type \{ TapEvidence, TapSource \}/)
  assert.doesNotMatch(tap, /export (?:type|interface) (?:TapEvidence|TapSource)\b/, 'declared in tap-sampling.ts again')
  const fit = readFileSync(join(ROOT, 'src/world/frame-fit.ts'), 'utf8')
  // One import statement from the leaf: the fit-point bounds (values, so the server can read them without importing this file) and the types.
  assert.match(fit, /import \{ MAX_FIT_POINTS, MIN_FIT_POINTS, type CheckedBy, type FitMethod, type FitSummary, type PointResidual \} from '\.\/calibration-evidence\.ts'/)
  assert.match(fit, /export type \{ CheckedBy, FitMethod, FitSummary, PointResidual \}/)
  assert.doesNotMatch(fit, /export (?:type|interface) (?:CheckedBy|FitMethod|FitSummary|PointResidual)\b/, 'declared in frame-fit.ts again')
})
