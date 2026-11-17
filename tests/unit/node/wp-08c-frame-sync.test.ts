/**
 * The phone's half of a frame replacement (WP-08): what `src/project/frame-sync.ts` sends when a frame replaces one the Place
 * holds, what the waiting row remembers, where a photo is kept and sent, and how the phone asks the server what is tied to a
 * reference (`src/project/frame-status.ts`).
 *
 * Both modules run for real, over the in-memory IndexedDB of ./support/fake-indexeddb.ts and either a scripted `fetch` (as
 * wp-place-frame-sync.test.ts runs them) or the stand-in for the server's routes of ./support/fake-frame-server.ts, which holds the
 * phone to ADR 0009's rules: a replacement has to name the frame the SERVER holds, a photo of a frame goes to that frame's own
 * route, and the Place's own photo route is closed once the frame has an id. What this adds to that file's claims:
 *
 *  - a frame that replaces another is sent with `replaces`, on the first try, on a retry made later from the waiting row, and
 *    on the second send of a calibration the server holds in another form; a first calibration is sent with none, and a
 *    row written before the field existed is sent as it always was; a row whose `replaces` is not well formed is sent without;
 *  - a replacement of a frame the server never received (made offline, or whose request failed) names what the server holds, so
 *    two replacements in a row are not both lost to a refusal no other device caused;
 *  - a frame with an id keeps its reference photos with it: the record names the frame's photo path, the photo goes to the
 *    frame's route with the role the frame knows, and this phone keeps the blob under the id. A frame with none keeps the legacy
 *    path, route and key;
 *  - once the server holds a frame that replaced another, the photos this phone kept for the replaced frames are deleted, and
 *    never before, and never the new frame's own;
 *  - the count of scans tied to a reference is asked of the server with a read, and a count that could not be read is null.
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-frame-sync.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { referencePhotoKey, type PendingFrameRecord, type ReferencePhotoRole } from '../../../src/project/project-store.ts'
import {
  persistProjectSpatialFrame,
  replacesAtServer,
  retryPendingFrames,
  sendSpatialFrame,
  withPendingFrame,
  type FrameSyncEnv,
} from '../../../src/project/frame-sync.ts'
import { fetchFrameStatus } from '../../../src/project/frame-status.ts'
import { QUEUED_OFFLINE_HEADER } from '../../../src/shared/offline-queue.ts'
import type { PendingReferencePhoto } from '../../../src/ar/reference-photo.ts'
import { planFrameGeneration, type FrameReplaces } from '../../../src/world/frame-replacement.ts'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../../../src/world/types.ts'
import { DB, opened } from './support/fake-indexeddb.ts'
import { FakeFrameServer, twoPointScan } from './support/fake-frame-server.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

function frame(createdAt: string, separationM: number, extra: Record<string, unknown> = {}): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...extra,
  } as ProjectSpatialFrame
}

const OLD = frame('2026-11-01T08:00:00.000Z', 2, { frameId: 'frame-old' })
const NEW = frame('2026-11-16T09:00:00.000Z', 3, { frameId: 'frame-new' })
const REPLACES: FrameReplaces = { frameId: 'frame-old', reason: 'override' }

function place(extra: Partial<Project> = {}): Project {
  return { projectId: 'proj-1', name: 'Kitchen', createdAt: 1, updatedAt: 1, floors: [], ...extra }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

interface Wire {
  env: FrameSyncEnv
  /** The JSON bodies of the frame PUTs, in order. */
  bodies: Array<Record<string, unknown>>
  calls: string[]
  /** What the request for each call carried as headers. */
  headers: Array<Record<string, string>>
}

function wire(reply: (call: string, n: number, body: Record<string, unknown> | undefined) => Response | Promise<Response>): Wire {
  const state: Wire = {
    bodies: [],
    calls: [],
    headers: [],
    env: {
      url: (path) => path,
      now: () => 1_700_000_001_000,
      online: () => true,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const call = `${init?.method ?? 'GET'} ${String(input)}`
        state.calls.push(call)
        state.headers.push(Object.fromEntries(new Headers(init?.headers).entries()))
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
        if (body) state.bodies.push(body)
        return await reply(call, state.calls.length, body)
      }) as typeof fetch,
    },
  }
  return state
}

const saved = (revision: number, stored: ProjectSpatialFrame) => json({ revision, frame: stored })
const conflict = (current: { frame: ProjectSpatialFrame | null; revision: number }) => json({ error: 'changed', current }, 409)

const captured = (role: ReferencePhotoRole): PendingReferencePhoto => ({
  role,
  blob: new Blob([`jpeg ${role}`], { type: 'image/jpeg' }),
  thumbDataUrl: 'data:image/jpeg;base64,AAAA',
  tapPoint: { x: 0.5, y: 0.5 },
  pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T09:59:00.000Z',
  label: null,
})
const BOTH = (): PendingReferencePhoto[] => [captured('landmark'), captured('headingMarker')]

// ── The write says what it replaces ──────────────────────────────────────────────────────────────────

test('a frame that replaces another is sent with `replaces`, and a first calibration with none', async () => {
  const replacing = wire(() => saved(4, NEW))
  const outcome = await sendSpatialFrame(replacing.env, 'proj-1', NEW, 3, REPLACES)
  assert.equal(outcome.status, 'saved')
  assert.deepEqual(replacing.bodies, [{ frame: NEW, expectedRevision: 3, replaces: REPLACES }])

  const first = wire(() => saved(1, NEW))
  await sendSpatialFrame(first.env, 'proj-1', NEW, 0)
  assert.deepEqual(Object.keys(first.bodies[0]!).sort(), ['expectedRevision', 'frame'], 'nothing is added to a write that replaces nothing')
})

test('a replacement names a replaced frame that has no id as null, not as a missing key', async () => {
  const net = wire(() => saved(2, NEW))
  await sendSpatialFrame(net.env, 'proj-1', NEW, 1, { frameId: null, reason: 'upgrade' })
  assert.deepEqual(net.bodies[0]!['replaces'], { frameId: null, reason: 'upgrade' })
})

test('a replacement is kept on the waiting row, so the try that follows it says what it replaces', async () => {
  const { store } = await opened()
  const project = place({ spatialFrame: OLD, spatialFrameRevision: 3 })
  let rowAtTheTimeOfTheSend: PendingFrameRecord | null = null
  const net = wire(async () => {
    rowAtTheTimeOfTheSend = await store.getPendingFrame('proj-1')
    return saved(4, NEW)
  })
  const outcome = await persistProjectSpatialFrame(store, project, NEW, { replaces: REPLACES }, net.env)
  assert.equal(outcome.status, 'saved')
  assert.deepEqual(net.bodies, [{ frame: NEW, expectedRevision: 3, replaces: REPLACES }], 'the revision it read, and what it replaces')
  assert.deepEqual((rowAtTheTimeOfTheSend as PendingFrameRecord | null)?.replaces, REPLACES, 'written down before it is sent')
  assert.equal(project.spatialFrameRevision, 4)
})

test('a replacement the network refused is sent again from the row, with `replaces` and the revision it was made against', async () => {
  const { store } = await opened()
  const project = place({ spatialFrame: OLD, spatialFrameRevision: 3 })
  const down = wire(() => Promise.reject(new Error('offline')))
  const first = await persistProjectSpatialFrame(store, project, NEW, { replaces: REPLACES }, down.env)
  assert.equal(first.status, 'failed')
  const waiting = await store.getPendingFrame('proj-1')
  assert.deepEqual(waiting?.replaces, REPLACES, 'it survives in IndexedDB, with the rest of the row')
  assert.equal(waiting?.syncState, 'failed')
  assert.equal(waiting?.expectedRevision, 3)

  const back = wire(() => saved(4, NEW))
  const retried = await retryPendingFrames(store, back.env, 'load')
  assert.equal(retried.changed, true)
  assert.deepEqual(back.bodies, [{ frame: NEW, expectedRevision: 3, replaces: REPLACES }], 'a retry made days later is still the same replacement')
  assert.equal(await store.getPendingFrame('proj-1'), null, 'and it is done')
})

test('the second send of a calibration the server holds in another form still says what it replaces', async () => {
  const { store } = await opened()
  const withLabels = { ...NEW, pointLabels: ['a', 'b'] } as ProjectSpatialFrame
  const net = wire((_call, n) => (n === 1 ? conflict({ frame: NEW, revision: 4 }) : saved(5, withLabels)))
  const outcome = await persistProjectSpatialFrame(store, place({ spatialFrame: OLD, spatialFrameRevision: 3 }), withLabels, { replaces: REPLACES }, net.env)
  assert.equal(outcome.status === 'saved' && outcome.revision, 5)
  assert.deepEqual(net.bodies.map((body) => body['replaces']), [REPLACES, REPLACES])
  assert.deepEqual(net.bodies.map((body) => body['expectedRevision']), [3, 4])
})

test('a replacement that lost to another device is a conflict: theirs is adopted, and the row is not sent again', async () => {
  const { store } = await opened()
  const theirs = frame('2026-11-16T09:30:00.000Z', 4, { frameId: 'frame-theirs' })
  const project = place({ spatialFrame: OLD, spatialFrameRevision: 3 })
  // Another phone replaced the same frame a moment earlier: the server holds theirs, at the next revision.
  const net = wire(() => conflict({ frame: theirs, revision: 4 }))
  const outcome = await persistProjectSpatialFrame(store, project, NEW, { replaces: REPLACES }, net.env)
  assert.equal(outcome.status, 'conflict')
  assert.deepEqual(project.spatialFrame, theirs, 'the Place the page works with is the one the server holds')
  assert.equal(project.spatialFrameRevision, 4)
  assert.equal(net.calls.length, 1, 'another calibration is not sent over the top: one send')
  assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'conflict')

  const later = wire(() => saved(5, NEW))
  const retried = await retryPendingFrames(store, later.env, 'load')
  assert.equal(retried.changed, false)
  assert.deepEqual(later.calls, [], 'a replacement that lost is never sent again')
})

test('a row written before the field existed is sent as it always was', async () => {
  const { store } = await opened()
  await store.putPendingFrame({ projectId: 'proj-1', frame: NEW, expectedRevision: 3, syncState: 'failed', recordedAt: 1, updatedAt: 1, attempts: 1 })
  const net = wire(() => saved(4, NEW))
  await retryPendingFrames(store, net.env, 'load')
  assert.deepEqual(net.bodies, [{ frame: NEW, expectedRevision: 3 }])
})

test('a first calibration writes no `replaces` on its row either', async () => {
  const { store } = await opened()
  let row: PendingFrameRecord | null = null
  const net = wire(async () => {
    row = await store.getPendingFrame('proj-1')
    return saved(1, NEW)
  })
  await persistProjectSpatialFrame(store, place(), NEW, {}, net.env)
  assert.equal('replaces' in ((row as PendingFrameRecord | null) ?? {}), false)
  assert.equal('replaces' in net.bodies[0]!, false)
})

// ── A photo is kept under the generation it was taken for ────────────────────────────────────────────

test('a copy a phone kept for an earlier generation is never found by the record of a later one', async () => {
  const { store } = await opened()
  // This phone calibrated the Place before ids existed, and still has those two photos under the old keys.
  const oldKey = referencePhotoKey('proj-1', 'landmark')
  await store.putReferencePhoto({ localKey: oldKey, projectId: 'proj-1', role: 'landmark', blob: new Blob(['the old kitchen']), thumbDataUrl: '', capturedAt: '2026-10-01T00:00:00.000Z' })
  // Another phone replaced the frame. Its record names a key that includes the generation.
  const recordKey = referencePhotoKey('proj-1', 'landmark', 'frame-new')
  assert.notEqual(recordKey, oldKey)
  assert.equal(await store.getReferencePhoto(recordKey), null, 'so the panel falls through to the server\'s copy, which is the new photo')
  assert.equal(await store.getReferencePhoto(oldKey).then((photo) => photo?.blob.text()), 'the old kitchen', 'and the old record, if one is still shown, still finds its own')
})

test('a frame with no id keeps the key it always had', async () => {
  const { fake, store } = await opened()
  const legacy = frame('2026-11-16T09:00:00.000Z', 3)
  const net = wire(() => saved(1, legacy))
  await persistProjectSpatialFrame(store, place(), legacy, { photos: BOTH() }, net.env)
  assert.deepEqual(fake.rows(DB, 'referencePhotos').map((row) => row['localKey']).sort(), ['proj-1:headingMarker', 'proj-1:landmark'])
  assert.equal(referencePhotoKey('proj-1', 'headingMarker'), 'proj-1:headingMarker')
  assert.equal(referencePhotoKey('proj-1', 'headingMarker', undefined), 'proj-1:headingMarker')
})

// ── Where a frame's photos are kept and sent ────────────────────────────────────────────────────────

const T1 = '2026-11-10T09:00:00.000Z'
const T2 = '2026-11-16T09:00:00.000Z'

const CALIBRATION = {
  method: 'two-point-ground',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  calibratedAt: T2,
  status: 'provisional',
  separationM: 3,
  residualM: 0,
  toleranceM: 0.15,
  anchorBearingDeg: null,
} as ScanCalibration

/**
 * What the scanner does with a finished calibration: the frame the modal made, given its id and the replacement it says it makes
 * (src/ar/calibration-run.ts), then written (src/main.ts). The frame replaces what `project` holds as the phone reads it.
 */
function calibrateAs(
  store: Awaited<ReturnType<typeof opened>>['store'],
  project: Project,
  id: string,
  createdAt: string,
  separationM: number,
  env: FrameSyncEnv,
  photos: PendingReferencePhoto[] = [],
  extra: Record<string, unknown> = {},
) {
  const plan = planFrameGeneration({ held: project.spatialFrame, calibration: CALIBRATION, spatialFrame: frame(createdAt, separationM, extra), mint: () => id })
  return persistProjectSpatialFrame(store, project, plan.spatialFrame!, { photos, replaces: plan.replaces }, env)
}

const storedTwoPoint = (server: FakeFrameServer) => {
  const stored = server.frame
  if (stored?.method !== 'two-point-ground') throw new Error('the server holds no two-point frame')
  return stored
}

const photoUrls = (server: FakeFrameServer) => [...server.photos.keys()].sort()
const localKeys = (fake: Awaited<ReturnType<typeof opened>>['fake']) => fake.rows(DB, 'referencePhotos').map((row) => String(row['localKey'])).sort()

test('a frame with an id keeps its photos with it: the records name its photo path, the photos go to its route, and the Place\'s own route is not used', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const project = place()
  const outcome = await calibrateAs(store, project, 'frame-new', T2, 3, server.env(), BOTH(), { pointLabels: ['north door', 'radiator'] })
  assert.equal(outcome.status, 'saved', 'the server, which checks the frame and its photo paths, took it')

  const photos = storedTwoPoint(server).referencePhotos!
  assert.equal(photos.landmark.url, '/projects/proj-1/frames/frame-new/ref-landmark.jpg')
  assert.equal(photos.headingMarker.url, '/projects/proj-1/frames/frame-new/ref-heading.jpg', 'the frame calls the heading marker\'s photo `heading`')
  assert.equal(photos.landmark.localKey, 'proj-1:frame-new:landmark')
  assert.equal(photos.headingMarker.localKey, 'proj-1:frame-new:headingMarker')
  assert.deepEqual(localKeys(fake), ['proj-1:frame-new:headingMarker', 'proj-1:frame-new:landmark'])
  assert.equal(await store.getReferencePhoto(photos.landmark.localKey).then((photo) => photo?.role), 'landmark', 'and a record finds its own photo here')

  // What was sent, and where: the photo is at the path its record names, with the role that path ends in.
  assert.deepEqual(photoUrls(server), [photos.landmark.url, photos.headingMarker.url].sort())
  assert.equal(server.photos.get(photos.headingMarker.url!)?.role, 'heading')
  assert.equal(server.photos.get(photos.headingMarker.url!)?.label, 'radiator', 'with its label')
  assert.equal(server.photos.get(photos.landmark.url!)?.label, 'north door')
  assert.deepEqual(server.calls.filter((call) => call.startsWith('POST')), [
    'POST /projects/proj-1/frames/frame-new/reference-photos',
    'POST /projects/proj-1/frames/frame-new/reference-photos',
  ], 'the Place\'s own route, which the server closes once the frame has an id, is never asked')
  assert.equal(await store.getPendingFrame('proj-1'), null, 'both photos are there, so nothing is left waiting')
})

test('a replacement keeps its photos with the new frame, and the replaced frame\'s stay where they were', async () => {
  const server = new FakeFrameServer()
  const { store } = await opened()
  const project = place()
  await calibrateAs(store, project, 'frame-old', T1, 2, server.env(), BOTH())
  const second = await calibrateAs(store, project, 'frame-new', T2, 3, server.env(), BOTH())
  assert.equal(second.status, 'saved')
  assert.deepEqual(photoUrls(server), [
    '/projects/proj-1/frames/frame-new/ref-heading.jpg',
    '/projects/proj-1/frames/frame-new/ref-landmark.jpg',
    '/projects/proj-1/frames/frame-old/ref-heading.jpg',
    '/projects/proj-1/frames/frame-old/ref-landmark.jpg',
  ], 'one folder per generation: an old photo is never written over, so it is never shown with a new record')
})

test('a frame with no id is sent as the build before ids sent it: the Place\'s own path, route and key', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const legacy = frame(T2, 3)
  const outcome = await persistProjectSpatialFrame(store, place(), legacy, { photos: BOTH() }, server.env())
  assert.equal(outcome.status, 'saved')
  const photos = storedTwoPoint(server).referencePhotos!
  assert.equal(photos.landmark.url, '/projects/proj-1/reference-photos/ref-landmark.jpg')
  assert.equal(photos.headingMarker.url, '/projects/proj-1/reference-photos/ref-headingMarker.jpg')
  assert.deepEqual(localKeys(fake), ['proj-1:headingMarker', 'proj-1:landmark'])
  assert.deepEqual(photoUrls(server), ['/projects/proj-1/reference-photos/ref-headingMarker.jpg', '/projects/proj-1/reference-photos/ref-landmark.jpg'])
})

test('a photo is sent only once the server holds the frame, and a frame that lost sends none', async () => {
  const theirs = frame('2026-11-16T09:30:00.000Z', 4, { frameId: 'frame-theirs' })
  const server = new FakeFrameServer({ frame: theirs, revision: 4 })
  const { fake, store } = await opened()
  const project = place({ spatialFrame: OLD, spatialFrameRevision: 3 })
  const outcome = await calibrateAs(store, project, 'frame-new', T2, 3, server.env(), BOTH())
  assert.equal(outcome.status, 'conflict', 'another device replaced the frame first')
  assert.deepEqual(server.calls.filter((call) => call.startsWith('POST')), [], 'so nothing of this calibration is uploaded, and it cannot replace the winner\'s photos')
  assert.deepEqual(localKeys(fake), [], 'and it is not kept on the phone either')
})

test('a server that has no route for a frame\'s photos yet is waited for: the photos stay, and go when it has one', async () => {
  const server = new FakeFrameServer()
  server.framePhotoRoute = false
  const { store } = await opened()
  const project = place()
  assert.equal((await calibrateAs(store, project, 'frame-new', T2, 3, server.env(), BOTH())).status, 'saved', 'the frame is saved: the photos are an aid, never a gate')
  const waiting = await store.getPendingFrame('proj-1')
  assert.equal(waiting?.syncState, 'photos')
  assert.deepEqual(waiting?.photos, ['landmark', 'headingMarker'], 'both are still to go')
  assert.equal(server.photos.size, 0)

  server.framePhotoRoute = true
  const retried = await retryPendingFrames(store, server.env(), 'load')
  assert.equal(retried.changed, false, 'the frame was already there: it is the photos that went')
  assert.deepEqual(photoUrls(server), ['/projects/proj-1/frames/frame-new/ref-heading.jpg', '/projects/proj-1/frames/frame-new/ref-landmark.jpg'])
  assert.equal(await store.getPendingFrame('proj-1'), null)
})

test('a server error or a limit is tried again; a refusal that says why is not', async () => {
  const server = new FakeFrameServer()
  const { store } = await opened()
  server.failPhotosWith = 503
  assert.equal((await calibrateAs(store, place(), 'frame-new', T2, 3, server.env(), BOTH())).status, 'saved')
  assert.deepEqual((await store.getPendingFrame('proj-1'))?.photos, ['landmark', 'headingMarker'], 'a 503 is worth another try')

  server.failPhotosWith = 429
  await retryPendingFrames(store, server.env(), 'load')
  assert.deepEqual((await store.getPendingFrame('proj-1'))?.photos, ['landmark', 'headingMarker'], 'and so is a limit')

  server.failPhotosWith = 413
  const callsBefore = server.calls.length
  await retryPendingFrames(store, server.env(), 'load')
  assert.equal(await store.getPendingFrame('proj-1'), null, 'a photo that is too large will be too large again: it is let go')
  assert.equal(server.calls.length - callsBefore, 2, 'after one request each')
})

test('a photo for a reference the server does not have is let go, and the server saying so is not mistaken for a server with no route', async () => {
  const server = new FakeFrameServer()
  server.framePhotoRoute = false
  const { store } = await opened()
  await calibrateAs(store, place(), 'frame-new', T2, 3, server.env(), BOTH())
  // Meanwhile the server's Place has moved on to a frame it never heard this one named (lost, merged away).
  server.framePhotoRoute = true
  server.frame = frame('2026-11-17T09:00:00.000Z', 5, { frameId: 'frame-other' })
  server.revision = 7
  await retryPendingFrames(store, server.env(), 'load')
  assert.equal(await store.getPendingFrame('proj-1'), null, 'a 404 that carries the server\'s own sentence is a refusal of these photos')
  const after = server.calls.length
  await retryPendingFrames(store, server.env(), 'load')
  assert.equal(server.calls.length, after, 'and nothing is sent again')
})

test('a photo of a frame with no id that the Place\'s own route no longer takes is let go and said so, not retried for ever', async (t) => {
  const server = new FakeFrameServer()
  server.failPhotosWith = 503
  const { store } = await opened()
  const project = place()
  const legacy = frame(T1, 3)
  await persistProjectSpatialFrame(store, project, legacy, { photos: BOTH() }, server.env())
  assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'photos', 'saved, its photos waiting')

  // Another device replaced the frame with one that has an id, which closes the Place\'s own photo route.
  server.failPhotosWith = null
  server.frame = frame(T2, 3, { frameId: 'frame-other' })
  server.revision += 1
  const warn = t.mock.method(console, 'warn', () => {})
  await retryPendingFrames(store, server.env(), 'load')
  assert.equal(await store.getPendingFrame('proj-1'), null, 'those photos are of a frame that is no longer the Place\'s: they are let go')
  assert.equal(warn.mock.calls.some((call) => /photos of each reference/.test(String(call.arguments[0]))), true, 'and the log says why')
  const asks = () => server.calls.filter((call) => call === 'POST /projects/proj-1/reference-photos').length
  assert.equal(asks(), 4, 'two photos asked after the frame was saved, and the same two once more by the retry')
  await retryPendingFrames(store, server.env(), 'load')
  assert.equal(asks(), 4, 'and not again')
})

// ── Replacing a frame the server never received ──────────────────────────────────────────────────────

const F1 = frame('2026-11-01T08:00:00.000Z', 2, { frameId: 'frame-f1' })
const heldBy = (server: FakeFrameServer): Project => place({ spatialFrame: server.frame ?? undefined, spatialFrameRevision: server.revision })
const idOf = (candidate: ProjectSpatialFrame | null | undefined): string | null => (candidate as { frameId?: string } | null | undefined)?.frameId ?? null

test('two replacements in a row while the first never reached the server: the second names what the server holds, and both are kept', async () => {
  const server = new FakeFrameServer({ frame: F1, revision: 1 })
  const { store } = await opened()
  const project = heldBy(server)

  server.online = false
  const first = await calibrateAs(store, project, 'frame-n1', T1, 3, server.env())
  assert.equal(first.status, 'failed')
  assert.equal(idOf(project.spatialFrame), 'frame-n1', 'the page works with the frame it made')

  server.online = true
  const second = await calibrateAs(store, project, 'frame-n2', T2, 3.5, server.env())
  assert.equal(second.status, 'saved', `the server's own rule took it: ${JSON.stringify(server.answers)}`)
  assert.deepEqual(server.writes.at(-1)!['replaces'], { frameId: 'frame-f1', reason: 'override' }, 'the frame the SERVER held, which is not the one the phone had made')
  assert.equal(idOf(server.frame), 'frame-n2')
  assert.deepEqual(server.history.map((entry) => [entry.frameId, entry.reason]), [['frame-f1', 'override']], 'the frame that was replaced is in the history, and the one that never arrived is not')
  assert.equal(project.spatialFrameRevision, 2)
})

test('the same after a reload: the Place the scanner starts on holds the frame that was made, and a replacement of it still names the server\'s', async () => {
  const server = new FakeFrameServer({ frame: F1, revision: 1 })
  const { store } = await opened()
  server.online = false
  assert.equal((await calibrateAs(store, heldBy(server), 'frame-n1', T1, 3, server.env())).status, 'failed')

  // resolveInitialPlace: the Place from the server, with the frame this phone has waiting standing in for it.
  server.online = true
  const reloaded = withPendingFrame(heldBy(server), await store.listPendingFrames())
  assert.equal(idOf(reloaded.spatialFrame), 'frame-n1')
  assert.equal((await calibrateAs(store, reloaded, 'frame-n2', T2, 3.5, server.env())).status, 'saved')
  assert.equal(idOf(server.frame), 'frame-n2')
  assert.deepEqual(server.history.map((entry) => entry.frameId), ['frame-f1'])
})

test('a first calibration that never reached the server, replaced by another, replaces nothing: the server holds none', async () => {
  const server = new FakeFrameServer()
  const { store } = await opened()
  const project = place()
  server.online = false
  assert.equal((await calibrateAs(store, project, 'frame-n1', T1, 3, server.env())).status, 'failed')
  server.online = true
  assert.equal((await calibrateAs(store, project, 'frame-n2', T2, 3.5, server.env())).status, 'saved')
  assert.equal('replaces' in server.writes.at(-1)!, false, 'there was nothing at the server to replace, and the write says so by saying nothing')
  assert.equal(idOf(server.frame), 'frame-n2')
  assert.deepEqual(server.history, [])
})

test('the same when the first was refused as malformed: the server never held it either', async () => {
  const server = new FakeFrameServer({ frame: F1, revision: 1 })
  const { store } = await opened()
  const project = heldBy(server)
  // A tolerance of nothing is a frame the server will not keep (400): the phone marks the row permanent and goes on.
  const first = await calibrateAs(store, project, 'frame-n1', T1, 3, server.env(), [], { toleranceM: 0 })
  assert.deepEqual(first.status === 'failed' && first.permanent, true)
  const second = await calibrateAs(store, project, 'frame-n2', T2, 3.5, server.env())
  assert.equal(second.status, 'saved')
  assert.deepEqual(server.writes.at(-1)!['replaces'], { frameId: 'frame-f1', reason: 'override' })
})

test('a frame the server holds is named as it is: after a loss to another device, and while its photos are still to go', async () => {
  // Lost: another device replaced F1 with W. This phone adopts W, and its next replacement names W.
  const winner = frame('2026-11-12T09:00:00.000Z', 4, { frameId: 'frame-w' })
  const server = new FakeFrameServer({ frame: winner, revision: 2, history: [{ frameId: 'frame-f1', createdAt: F1.createdAt, method: 'two-point-ground', separationM: 2, supersededAt: '2026-11-12T09:00:00.000Z', reason: 'override' }] })
  const { store } = await opened()
  const project = place({ spatialFrame: F1, spatialFrameRevision: 1 })
  assert.equal((await calibrateAs(store, project, 'frame-n1', T1, 3, server.env())).status, 'conflict')
  assert.equal(idOf(project.spatialFrame), 'frame-w')
  assert.equal((await calibrateAs(store, project, 'frame-n2', T2, 3.5, server.env())).status, 'saved')
  assert.deepEqual(server.writes.at(-1)!['replaces'], { frameId: 'frame-w', reason: 'override' }, 'the frame that lost is not what this one replaces')

  // Photos still to go: the server holds the frame, so a frame that replaces it names it.
  const second = new FakeFrameServer()
  second.framePhotoRoute = false
  const other = await opened()
  const held = place()
  await calibrateAs(other.store, held, 'frame-p1', T1, 3, second.env(), BOTH())
  assert.equal((await other.store.getPendingFrame('proj-1'))?.syncState, 'photos')
  second.framePhotoRoute = true
  assert.equal((await calibrateAs(other.store, held, 'frame-p2', T2, 3.5, second.env())).status, 'saved')
  assert.deepEqual(second.writes.at(-1)!['replaces'], { frameId: 'frame-p1', reason: 'override' })
})

test('what a frame replaces at the server: its own say, unless the frame the phone held never got there', () => {
  const unsent = (extra: Partial<PendingFrameRecord> = {}): PendingFrameRecord => ({
    projectId: 'proj-1', frame: NEW, expectedRevision: 3, syncState: 'failed', recordedAt: 1, updatedAt: 1, attempts: 1, replaces: REPLACES, ...extra,
  })
  const wanted: FrameReplaces = { frameId: 'frame-new', reason: 'upgrade' }
  assert.equal(replacesAtServer(undefined, NEW, unsent()), undefined, 'a write that replaces nothing')
  assert.deepEqual(replacesAtServer(wanted, OLD, null), wanted, 'no row waiting')
  assert.deepEqual(replacesAtServer(wanted, undefined, unsent()), wanted, 'the phone held nothing')
  assert.deepEqual(replacesAtServer(wanted, OLD, unsent()), wanted, 'the held frame is not the one in the row')
  assert.deepEqual(replacesAtServer(wanted, NEW, unsent()), REPLACES, 'the held frame is the one in the row: what that one replaced')
  for (const syncState of ['pending', 'queued', 'failed'] as const) assert.deepEqual(replacesAtServer(wanted, NEW, unsent({ syncState })), REPLACES, `${syncState}: the server does not have it`)
  assert.deepEqual(replacesAtServer(wanted, NEW, unsent({ syncState: 'photos' })), wanted, 'the server holds a frame whose photos are still to go')
  assert.equal(replacesAtServer(wanted, NEW, unsent({ replaces: undefined })), undefined, 'a row that replaced nothing: nothing to replace')
  assert.equal(replacesAtServer(wanted, NEW, unsent({ replaces: { frameId: 7, reason: 'bored' } as unknown as FrameReplaces })), undefined, 'and a row whose record is not one is not trusted')
})

test('a row whose `replaces` is not a well formed one is sent without it', async () => {
  const { store } = await opened()
  await store.putPendingFrame({ projectId: 'proj-1', frame: NEW, expectedRevision: 3, syncState: 'failed', recordedAt: 1, updatedAt: 1, attempts: 1, replaces: { frameId: 7, reason: 'bored' } as unknown as FrameReplaces })
  const net = wire(() => saved(4, NEW))
  await retryPendingFrames(store, net.env, 'load')
  assert.deepEqual(net.bodies, [{ frame: NEW, expectedRevision: 3 }])
})

// ── The photos of a replaced frame are deleted once nothing refers to them ───────────────────────────

/** A frame the Place holds with the photos this phone took for it, the way a calibration left them (src/project/frame-sync.ts). */
async function holdWithPhotos(store: Awaited<ReturnType<typeof opened>>['store'], server: FakeFrameServer, project: Project, id: string | null, createdAt: string) {
  const raw = frame(createdAt, 2, id ? { frameId: id } : {})
  const outcome = await persistProjectSpatialFrame(store, project, raw, { photos: BOTH() }, server.env())
  assert.equal(outcome.status, 'saved')
}

test('once the server holds a frame that replaced another, the photos this phone kept for the replaced one are deleted, and the new frame\'s are kept', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const project = place()
  // The Place's first calibration was made before ids existed: its photos are under the keys that build used.
  await holdWithPhotos(store, server, project, null, T1)
  assert.deepEqual(localKeys(fake), ['proj-1:headingMarker', 'proj-1:landmark'])

  assert.equal((await calibrateAs(store, project, 'frame-n1', T2, 3, server.env(), BOTH())).status, 'saved')
  assert.deepEqual(localKeys(fake), ['proj-1:frame-n1:headingMarker', 'proj-1:frame-n1:landmark'], 'the legacy pair is gone: nothing refers to it')

  assert.equal((await calibrateAs(store, project, 'frame-n2', '2026-11-17T09:00:00.000Z', 3.5, server.env(), BOTH())).status, 'saved')
  assert.deepEqual(localKeys(fake), ['proj-1:frame-n2:headingMarker', 'proj-1:frame-n2:landmark'], 'and so is the first generation\'s: one pair per Place, as before')
})

test('they are deleted when the replacing frame is saved, and not before: a frame that has not reached the server leaves the held frame its photos', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const project = place()
  await holdWithPhotos(store, server, project, 'frame-f0', T1)

  server.online = false
  assert.equal((await calibrateAs(store, project, 'frame-n1', T2, 3, server.env(), BOTH())).status, 'failed')
  assert.deepEqual(localKeys(fake), ['proj-1:frame-f0:headingMarker', 'proj-1:frame-f0:landmark', 'proj-1:frame-n1:headingMarker', 'proj-1:frame-n1:landmark'], 'both pairs: the server may still hold the old frame')

  server.online = true
  assert.equal((await retryPendingFrames(store, server.env(), 'load')).changed, true)
  assert.deepEqual(localKeys(fake), ['proj-1:frame-n1:headingMarker', 'proj-1:frame-n1:landmark'], 'the retry that saved it cleaned up, from what the row remembered')
})

test('a frame that lost leaves the photos of the frame the Place still has', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const project = place()
  await holdWithPhotos(store, server, project, 'frame-f0', T1)
  // Another device replaced it first.
  server.frame = frame('2026-11-12T09:00:00.000Z', 4, { frameId: 'frame-w' })
  server.revision += 1
  assert.equal((await calibrateAs(store, project, 'frame-n1', T2, 3, server.env(), BOTH())).status, 'conflict')
  assert.deepEqual(localKeys(fake), ['proj-1:frame-f0:headingMarker', 'proj-1:frame-f0:landmark'], 'the lost frame\'s own were dropped, the held frame\'s are not touched')
})

test('two replacements while the server heard of neither: when the second is saved, the photos of the held frame and of the one that never arrived are both deleted', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const project = place()
  await holdWithPhotos(store, server, project, 'frame-f0', T1)

  server.online = false
  await calibrateAs(store, project, 'frame-n1', T2, 3, server.env(), BOTH())
  server.online = true
  assert.equal((await calibrateAs(store, project, 'frame-n2', '2026-11-17T09:00:00.000Z', 3.5, server.env(), BOTH())).status, 'saved')
  assert.deepEqual(localKeys(fake), ['proj-1:frame-n2:headingMarker', 'proj-1:frame-n2:landmark'])
})

test('a frame with no id that replaces one with none shares its keys, and its photos are not deleted with the old ones', async () => {
  const server = new FakeFrameServer()
  const { fake, store } = await opened()
  const project = place()
  await holdWithPhotos(store, server, project, null, T1)
  const outcome = await persistProjectSpatialFrame(store, project, frame(T2, 3), { photos: BOTH(), replaces: { frameId: null, reason: 'override' } }, server.env())
  assert.equal(outcome.status, 'saved')
  assert.deepEqual(localKeys(fake), ['proj-1:headingMarker', 'proj-1:landmark'], 'the pair under the key both frames use is the new one')
})

// ── Asking what is tied to a reference ───────────────────────────────────────────────────────────────

test('the count of scans tied to a reference is a read of the Place\'s frame-status, and is the server\'s answer', async () => {
  const server = new FakeFrameServer({ frame: NEW, revision: 4, scans: [twoPointScan('frame-new'), twoPointScan('frame-new'), twoPointScan('frame-new'), twoPointScan()] })
  const status = await fetchFrameStatus('proj-1', server.env())
  assert.deepEqual(server.calls, ['GET /projects/proj-1/frame-status'])
  assert.deepEqual(server.headers[0], {}, 'a plain read: nothing the service worker could take for a write')
  assert.deepEqual(status, { holdsFrame: true, frameId: 'frame-new', scansOnReference: 3 })

  // A Place whose frame has no id, which is every Place that exists today: the scans that name none are what a replacement leaves.
  const legacy = new FakeFrameServer({ frame: frame('2026-11-16T09:00:00.000Z', 3), revision: 2, scans: [twoPointScan(), twoPointScan(), twoPointScan('frame-aaa')] })
  assert.deepEqual(await fetchFrameStatus('proj-1', legacy.env()), { holdsFrame: true, frameId: null, scansOnReference: 2 })

  const odd = wire(() => json(server.statusBody()))
  await fetchFrameStatus('proj 1/../x', odd.env)
  assert.deepEqual(odd.calls, ['GET /projects/proj%201%2F..%2Fx/frame-status'], 'the id is one path segment')
})

test('a status that could not be had is null, whatever the reason: nothing is read as "no scans"', async () => {
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ['a server error', () => json({ error: 'boom' }, 500)],
    ['a server that has no such route', () => json({ error: 'Not found' }, 404)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body that is not a status', () => json({ revision: 'two' })],
    ['a service worker that queued it', () => json({ ok: false, queuedOffline: true }, 202, { [QUEUED_OFFLINE_HEADER]: '1' })],
    // What came from the offline queue is not the server's answer, whatever its body says: a body that happens to read as a status is
    // still not one, and no count is taken from it.
    ['a queued answer whose body reads as a status', () => json(new FakeFrameServer({ frame: NEW, revision: 4, scans: [twoPointScan('frame-new')] }).statusBody(), 202, { [QUEUED_OFFLINE_HEADER]: '1' })],
    ['a network that is down', () => Promise.reject(new Error('offline'))],
  ]
  for (const [what, reply] of cases) assert.equal(await fetchFrameStatus('proj-1', wire(reply).env), null, what)
})

test('a request that never answers is given up on, and the status is null', async () => {
  const hung = wire(() => new Promise<Response>(() => {}))
  hung.env.fetchFn = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })) as typeof fetch
  hung.env.requestTimeoutMs = 10
  assert.equal(await fetchFrameStatus('proj-1', hung.env), null)
})
