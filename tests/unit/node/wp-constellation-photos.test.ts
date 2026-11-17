/**
 * A check point's photo on its way to the server (src/project/frame-sync.ts, WP-04b): staged on the phone beside the two
 * markers', carried on the point in the frame that is sent, uploaded after the frame with the name the person gave the point,
 * and kept waiting, or dropped, with the rest.
 *
 * It runs the real sync module against the in-memory IndexedDB of ./support/fake-indexeddb.ts and a scripted fetch, as
 * wp-place-frame-sync.test.ts does for the two-marker case, which still holds for every record written before check points.
 * What is pinned here is only what a third photo adds:
 *
 *  1. THE FRAME CARRIES IT ON THE POINT. `checkPoints[0].photo` is the record of `check1` (the first point's), with the path the
 *     server will serve it from; `referencePhotos` still has the two markers and nothing else, because the schema pairs those.
 *  2. IT IS UPLOADED AFTER THE FRAME, LAST, WITH ITS NAME. The point's `label` travels as the photo's, as a marker's does.
 *  3. IT IS OPTIONAL. A check photo that cannot be stored leaves the point without one and holds nothing back; the markers'
 *     photos are still both or none, and a check photo does not stand in for a missing marker's.
 *  4. IT IS KEPT AND LET GO WITH THE REST. A calibration made offline waits with all three roles and sends them from the
 *     copies on the phone; one that lost to another device drops all three copies.
 *  5. A frame from before check points is exactly as it was: two roles, no `checkPoints`.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-constellation-photos.test.ts
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { persistProjectSpatialFrame, retryPendingFrames, type FrameSyncEnv } from '../../../src/project/frame-sync.ts'
import { referencePhotoKey, type PendingFrameRecord, type ReferencePhotoRole } from '../../../src/project/project-store.ts'
import type { PendingReferencePhoto } from '../../../src/ar/reference-photo.ts'
import { DB, opened } from './support/fake-indexeddb.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

const WITH_CHECK = (label?: string): ProjectSpatialFrame => ({
  version: 1,
  createdAt: '2026-11-16T09:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3.5 },
  separationM: 3.5,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  pointLabels: ['north door', 'radiator'],
  checkPoints: [{ x: -2.6, y: 0, z: 1, ...(label ? { label } : {}) }],
})

const WITHOUT_CHECK: ProjectSpatialFrame = (() => {
  const { checkPoints: _dropped, ...rest } = WITH_CHECK() as ProjectSpatialFrame & { checkPoints?: unknown }
  return rest as ProjectSpatialFrame
})()

const place = (projectId: string): Project => ({
  projectId,
  name: `Place ${projectId}`,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  areas: [{ areaId: 'area-1', name: 'Site', kind: 'site', parentAreaId: null }],
  floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }],
})

const captured = (role: ReferencePhotoRole): PendingReferencePhoto => ({
  role,
  blob: new Blob([`jpeg ${role}`], { type: 'image/jpeg' }),
  thumbDataUrl: 'data:image/jpeg;base64,AAAA',
  tapPoint: { x: 0.25, y: 0.5 },
  pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T08:59:00.000Z',
  label: null,
})
const ALL = (): PendingReferencePhoto[] => [captured('landmark'), captured('headingMarker'), captured('check1')]

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const FRAME_ROUTE = 'PUT /projects/proj-1/spatial-frame'
const POST_PHOTO = 'POST /projects/proj-1/reference-photos'
const photoPath = (role: ReferencePhotoRole) => `/projects/proj-1/reference-photos/ref-${role}.jpg`

interface Wire {
  env: FrameSyncEnv
  calls: string[]
  /** The frame of every PUT. */
  frames: ProjectSpatialFrame[]
  /** Every photo upload, in order. */
  photos: Array<{ role: string; label?: string; bytes: string }>
}

/** A server that saves the frame as it is sent and takes photos, unless `up()` says it is unreachable. */
function wire(up: () => boolean = () => true): Wire {
  const state: Wire = {
    calls: [],
    frames: [],
    photos: [],
    env: {
      url: (path) => path,
      now: () => 1_700_000_001_000,
      online: () => true,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const call = `${init?.method ?? 'GET'} ${String(input)}`
        state.calls.push(call)
        if (!up()) throw new TypeError('Failed to fetch')
        if (typeof init?.body === 'string') {
          const body = JSON.parse(init.body) as { frame: ProjectSpatialFrame }
          state.frames.push(body.frame)
          return json({ revision: 1, frame: body.frame })
        }
        if (init?.body instanceof FormData) {
          const meta = JSON.parse(String(init.body.get('meta'))) as { role: string; label?: string }
          state.photos.push({ role: meta.role, label: meta.label, bytes: await (init.body.get('image') as Blob).text() })
        }
        return json({ ok: true })
      }) as typeof fetch,
    },
  }
  return state
}

type SentFrame = { referencePhotos?: Record<string, { url: string; localKey: string; tapPoint: unknown }>; checkPoints?: Array<{ photo?: { url: string; localKey: string; tapPoint: unknown } }> }

// ── 1 and 2. The frame carries it on the point; it is uploaded last, with its name ─────────────────────

test('a check point\'s photo is carried on the point, with the path the server will serve it from, and the markers\' stay in referencePhotos', async () => {
  const { fake, store } = await opened()
  const net = wire()
  const outcome = await persistProjectSpatialFrame(store, place('proj-1'), WITH_CHECK('the radiator'), { photos: ALL() }, net.env)
  assert.equal(outcome.status, 'saved')
  const sent = net.frames[0] as unknown as SentFrame
  assert.equal(sent.checkPoints?.[0]?.photo?.url, photoPath('check1'))
  assert.equal(sent.checkPoints?.[0]?.photo?.localKey, referencePhotoKey('proj-1', 'check1'))
  assert.deepEqual(sent.checkPoints?.[0]?.photo?.tapPoint, { x: 0.25, y: 0.5 })
  assert.deepEqual(Object.keys(sent.referencePhotos ?? {}).sort(), ['headingMarker', 'landmark'], 'the schema pairs the two markers\' photos; a check point\'s is on the point')
  assert.equal(sent.referencePhotos?.['landmark']?.url, photoPath('landmark'))
  assert.deepEqual(net.photos, [
    { role: 'landmark', label: 'north door', bytes: 'jpeg landmark' },
    { role: 'headingMarker', label: 'radiator', bytes: 'jpeg headingMarker' },
    { role: 'check1', label: 'the radiator', bytes: 'jpeg check1' },
  ], 'the frame first, then the markers\' photos, then the check point\'s, each with the name the person gave its point')
  assert.deepEqual(fake.rows(DB, 'pendingFrame'), [], 'nothing is waiting once the server has them all')
  assert.equal(fake.rows(DB, 'referencePhotos').length, 3, 'the copies stay on the phone for the aid to show offline')
  assert.deepEqual(net.calls, [FRAME_ROUTE, POST_PHOTO, POST_PHOTO, POST_PHOTO])
})

test('a check point that was not named uploads its photo without a label, as a marker that was not named does', async () => {
  const { store } = await opened()
  const net = wire()
  await persistProjectSpatialFrame(store, place('proj-1'), WITH_CHECK(), { photos: ALL() }, net.env)
  assert.deepEqual(net.photos.map((photo) => [photo.role, photo.label]), [['landmark', 'north door'], ['headingMarker', 'radiator'], ['check1', undefined]])
})

// ── 3. It is optional ────────────────────────────────────────────────────────────────────────────────

test('a check photo that cannot be stored leaves its point without one and holds nothing else back', async () => {
  const { fake, store } = await opened()
  const net = wire()
  const warn = mock.method(console, 'warn', () => {})
  try {
    // The third put is the check point's: the markers' two went in first.
    let puts = 0
    const original = store.putReferencePhoto.bind(store)
    store.putReferencePhoto = async (record) => {
      puts += 1
      if (puts === 3) throw new Error('QuotaExceededError')
      return original(record)
    }
    const outcome = await persistProjectSpatialFrame(store, place('proj-1'), WITH_CHECK('the radiator'), { photos: ALL() }, net.env)
    assert.equal(outcome.status, 'saved')
    const sent = net.frames[0] as unknown as SentFrame
    assert.equal(sent.checkPoints?.[0]?.photo, undefined, 'the point has no photo')
    assert.deepEqual(Object.keys(sent.referencePhotos ?? {}).sort(), ['headingMarker', 'landmark'], 'both markers keep theirs')
    assert.deepEqual(net.photos.map((photo) => photo.role), ['landmark', 'headingMarker'])
    assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
  } finally {
    warn.mock.restore()
  }
})

test('a check photo does not stand in for a marker\'s: the markers\' photos are both or none, and then the frame keeps no photo at all', async () => {
  const { fake, store } = await opened()
  const net = wire()
  const warn = mock.method(console, 'warn', () => {})
  try {
    fake.failNext('referencePhotos', 'put')
    await persistProjectSpatialFrame(store, place('proj-1'), WITH_CHECK('the radiator'), { photos: ALL() }, net.env)
    const sent = net.frames[0] as unknown as SentFrame
    assert.equal(sent.referencePhotos, undefined, 'one marker\'s photo would let half a reference pass for all of it')
    assert.equal(sent.checkPoints?.[0]?.photo, undefined, 'and the check point\'s is not kept on a frame whose markers have none')
    assert.deepEqual(net.photos, [])
  } finally {
    warn.mock.restore()
  }
})

// ── 4. It is kept and let go with the rest ───────────────────────────────────────────────────────────

test('a calibration made offline waits with all three roles, and the retry sends them from the copies on the phone', async () => {
  const { fake, store } = await opened()
  let up = false
  const net = wire(() => up)
  const warn = mock.method(console, 'warn', () => {})
  try {
    const offline = await persistProjectSpatialFrame(store, place('proj-1'), WITH_CHECK('the radiator'), { photos: ALL() }, net.env)
    assert.equal(offline.status, 'failed')
    const [waiting] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
    assert.deepEqual(waiting?.photos, ['landmark', 'headingMarker', 'check1'])
    assert.equal(fake.rows(DB, 'referencePhotos').length, 3)

    up = true
    assert.deepEqual(await retryPendingFrames(store, net.env), { changed: true })
    assert.deepEqual(net.photos.map((photo) => [photo.role, photo.bytes]), [
      ['landmark', 'jpeg landmark'],
      ['headingMarker', 'jpeg headingMarker'],
      ['check1', 'jpeg check1'],
    ])
    assert.equal(net.photos[2]!.label, 'the radiator', 'the name is read from the frame the row kept')
    assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
  } finally {
    warn.mock.restore()
  }
})

test('a calibration that lost to another device drops the check point\'s copy with the markers\'', async () => {
  const { fake, store } = await opened()
  const winner = { ...WITHOUT_CHECK, createdAt: '2026-11-16T10:00:00.000Z' }
  const net = wire()
  net.env.fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    net.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return json({ error: 'changed', current: { frame: winner, revision: 1 } }, 409)
  }) as typeof fetch
  const outcome = await persistProjectSpatialFrame(store, place('proj-1'), WITH_CHECK('the radiator'), { photos: ALL() }, net.env)
  assert.equal(outcome.status, 'conflict')
  assert.deepEqual(net.calls, [FRAME_ROUTE], 'no photo was sent')
  assert.deepEqual(fake.rows(DB, 'referencePhotos'), [], 'none of the three copies is kept to be drawn against the winner\'s frame')
})

// ── 5. A frame from before check points is as it was ──────────────────────────────────────────────────

test('a frame with no check point stages and sends its two photos exactly as before', async () => {
  const { fake, store } = await opened()
  const net = wire()
  await persistProjectSpatialFrame(store, place('proj-1'), WITHOUT_CHECK, { photos: [captured('landmark'), captured('headingMarker')] }, net.env)
  const sent = net.frames[0] as unknown as SentFrame
  assert.equal('checkPoints' in sent, false)
  assert.deepEqual(Object.keys(sent.referencePhotos ?? {}).sort(), ['headingMarker', 'landmark'])
  assert.deepEqual(net.photos.map((photo) => photo.role), ['landmark', 'headingMarker'])
  assert.deepEqual(net.calls, [FRAME_ROUTE, POST_PHOTO, POST_PHOTO])
  assert.equal(fake.rows(DB, 'referencePhotos').length, 2)
})

test('a photo of a check point the frame does not have is not staged: the roles follow the points the frame stores', async () => {
  const { fake, store } = await opened()
  const net = wire()
  await persistProjectSpatialFrame(store, place('proj-1'), WITHOUT_CHECK, { photos: ALL() }, net.env)
  const sent = net.frames[0] as unknown as SentFrame
  assert.equal('checkPoints' in sent, false)
  assert.deepEqual(net.photos.map((photo) => photo.role), ['landmark', 'headingMarker'], 'nothing is sent for a point that is not there')
  assert.equal(fake.rows(DB, 'referencePhotos').length, 2, 'and no copy is kept under a key no point owns')
})
