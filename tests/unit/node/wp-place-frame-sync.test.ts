/**
 * The phone's half of the Place frame record: the `pendingFrame` store in `ci-xr-projects`
 * (src/project/project-store.ts) and getting a calibration's frame to the server and keeping it until it is
 * there (src/project/frame-sync.ts).
 *
 * Both run for real here. IndexedDB is a small in-memory stand-in (./support/fake-indexeddb.ts), in the style of
 * wp-store-erase.test.ts: a request takes effect in order and reports afterwards, transactions on one database
 * run one at a time, a failed request aborts its transaction and undoes its writes, a database upgrades by
 * version and refuses to while another connection is open, and a failure can be injected at any request. `fetch`
 * is scripted. Nothing in src/ had to change for either seam: the store reads the global `indexedDB`, and the sync
 * module takes its fetch, clock and online flag as arguments. tests/unit/node/wp-place-frame-contract.test.ts
 * runs the same code against the real server.
 *
 * What it pins, against the failures the work package describes:
 *  - the database goes from v1 or v2 to v3 and keeps every Place, scan and reference photo it had;
 *  - a copy of a Place with a lower frame revision cannot take the frame from the one it replaces, even from
 *    another tab at the same moment, and the server's own answer is the one copy that can;
 *  - a calibration whose storage fails, or never answers, still sends its frame, and one the server did not take
 *    is kept and retried;
 *  - the frame is sent before any photo, and photos are uploaded only once the server holds it: a calibration that
 *    lost to another device uploads none and drops the copies it stored;
 *  - a queued 202 is not delivered, a 409 for the same frame is, a 409 for this very calibration in another form
 *    is sent once more, and a 409 for another is a conflict;
 *  - what a retry learns reaches the page's Place, and a calibration waits for the retry that is running, so it
 *    names the revision the server holds;
 *  - the Place a visit starts on: the mirror stands in only when the list FAILED, never when it succeeded without
 *    the Place; the higher revision wins; a frame waiting to be sent stands while the Place is at the revision it
 *    was made against;
 *  - the answer to creating a Place or an Area that the service worker queued is a refusal, not a Place.
 *
 * main.ts is one DOM module and cannot be imported under Node, so its wiring is read as text at the end, in tests
 * named "source shape:" that claim no behaviour.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs, and `npm run verify` runs it), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-place-frame-sync.test.ts
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectStore, referencePhotoKey, type PendingFrameRecord, type ReferencePhotoRole } from '../../../src/project/project-store.ts'
import {
  AREA_NEEDS_CONNECTION,
  FRAME_CONFLICT_TEXT,
  FRAME_NOT_SYNCED_TEXT,
  PLACE_NEEDS_CONNECTION,
  adoptFrameOutcome,
  browserFrameSyncEnv,
  fetchPlaceList,
  frameSyncStatusText,
  noQueueHeaders,
  onFrameSettled,
  persistProjectSpatialFrame,
  readCreatedPlace,
  resolveInitialPlace,
  retryPendingFrames,
  sendSpatialFrame,
  showFrameSyncNote,
  unsyncedPlaceIds,
  whenFramesSettled,
  withPendingFrame,
  type FrameSettled,
  type FrameStore,
  type FrameSyncEnv,
} from '../../../src/project/frame-sync.ts'
import type { PendingReferencePhoto } from '../../../src/ar/reference-photo.ts'
import { SCAN_SERVER_KEY } from '../../../src/shared/storage-keys.ts'
import { NO_QUEUE_HEADER, QUEUED_OFFLINE_HEADER } from '../../../src/shared/offline-queue.ts'
import { statusIsHeld, writeStatus } from '../../../src/ui/status-line.ts'
import { DB, install, opened, settle, type StoreSpec } from './support/fake-indexeddb.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

function frame(createdAt: string, separationM = 2): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
  }
}

const F0 = frame('2026-11-16T08:00:00.000Z', 2)
const F1 = frame('2026-11-16T09:00:00.000Z', 3)
const F2 = frame('2026-11-16T10:00:00.000Z', 4)

function place(projectId: string, extra: Partial<Project> = {}): Project {
  return {
    projectId,
    name: `Place ${projectId}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    areas: [{ areaId: 'area-1', name: 'Site', kind: 'site', parentAreaId: null }],
    floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }],
    ...extra,
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const queuedReply = () => json({ ok: false, queuedOffline: true, queueId: 'q1', message: 'Saved offline' }, 202, { [QUEUED_OFFLINE_HEADER]: '1' })

interface Wire {
  env: FrameSyncEnv
  /** Every request, in order: "PUT /projects/p1/spatial-frame". */
  calls: string[]
  /** The bodies of the frame PUTs. */
  bodies: Array<{ frame: ProjectSpatialFrame; expectedRevision: number }>
  /** Every photo upload, in order: which marker, its label if it had one, and the bytes that were sent. */
  photos: Array<{ role: string; label?: string; bytes: string }>
  /** The headers of every request, parallel to `calls`. */
  headers: Array<Record<string, string>>
  online: boolean
}

/** A fetch that answers each request with `reply(call, n, body)`, and an environment around it. */
function wire(reply: (call: string, n: number, body: unknown) => Response | Promise<Response>): Wire {
  const calls: string[] = []
  const bodies: Wire['bodies'] = []
  const photos: Wire['photos'] = []
  const headers: Wire['headers'] = []
  const state: Wire = {
    calls,
    bodies,
    photos,
    headers,
    online: true,
    env: {
      url: (path) => path,
      now: () => 1_700_000_001_000,
      online: () => state.online,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const call = `${init?.method ?? 'GET'} ${String(input)}`
        calls.push(call)
        headers.push(Object.fromEntries(new Headers(init?.headers).entries()))
        let body: unknown = undefined
        if (typeof init?.body === 'string') {
          body = JSON.parse(init.body)
          bodies.push(body as Wire['bodies'][number])
        } else if (init?.body instanceof FormData) {
          const meta = JSON.parse(String(init.body.get('meta'))) as { role: string; label?: string }
          const image = init.body.get('image') as Blob
          body = { role: meta.role, label: meta.label, bytes: await image.text() }
          photos.push(body as Wire['photos'][number])
        }
        return await reply(call, calls.length, body)
      }) as typeof fetch,
    },
  }
  return state
}

const FRAME_ROUTE = (id: string) => `PUT /projects/${id}/spatial-frame`
const saved = (revision: number, stored: ProjectSpatialFrame) => json({ revision, frame: stored })
const conflict = (current: { frame: ProjectSpatialFrame | null; revision: number }) => json({ error: 'changed', current }, 409)

/** A store whose every call fails, as a phone with its storage blocked or full gives. */
function brokenStore(): FrameStore {
  const refuse = () => Promise.reject(new Error('QuotaExceededError'))
  return {
    getProject: refuse,
    updateProject: refuse,
    putPendingFrame: refuse,
    getPendingFrame: refuse,
    listPendingFrames: refuse,
    patchPendingFrame: refuse,
    clearPendingFrame: refuse,
    putReferencePhoto: refuse,
    getReferencePhoto: refuse,
    deleteReferencePhoto: refuse,
  }
}

// ── The database: v1 and v2 become v3 without losing anything ─────────────────────────────────────

const PHOTO = (localKey: string, projectId: string, role: string) => ({
  localKey,
  projectId,
  role,
  blob: new Blob([`jpeg bytes for ${localKey}`], { type: 'image/jpeg' }),
  thumbDataUrl: 'data:image/jpeg;base64,AAAA',
  capturedAt: '2026-11-10T08:00:00.000Z',
})

const V1_STORES = (): StoreSpec[] => [
  { name: 'projects', keyPath: 'projectId', rows: [place('proj-1', { spatialFrame: F0 }), place('proj-2')] },
  {
    name: 'scans',
    keyPath: 'scanId',
    indexes: { byProject: 'projectId', bySession: 'sessionId' },
    rows: [
      { scanId: 'scan-1', projectId: 'proj-1', sessionId: 'sess-1', capturedAt: 3, status: 'complete' },
      { scanId: 'scan-2', projectId: 'proj-1', sessionId: 'sess-2', capturedAt: 5, status: 'complete' },
      { scanId: 'scan-3', projectId: null, sessionId: 'sess-3', capturedAt: 7, status: 'complete' },
    ],
  },
]
const V2_STORES = (): StoreSpec[] => [
  ...V1_STORES(),
  {
    name: 'referencePhotos',
    keyPath: 'localKey',
    indexes: { byProject: 'projectId' },
    rows: [PHOTO('proj-1:landmark', 'proj-1', 'landmark'), PHOTO('proj-1:headingMarker', 'proj-1', 'headingMarker')],
  },
]

test('a fresh install makes all four stores at version 3, and the database keeps its name', async () => {
  const { fake } = await opened()
  assert.equal(fake.databases.get(DB)?.version, 3)
  assert.deepEqual(fake.stores(DB), ['pendingFrame', 'projects', 'referencePhotos', 'scans'])
  assert.equal(fake.databases.get(DB)?.stores.get('pendingFrame')?.keyPath, 'projectId')
  assert.equal(fake.databases.size, 1, 'a rename would leave the old database holding every Place')
})

for (const [from, stores] of [[1, V1_STORES], [2, V2_STORES]] as const) {
  test(`a v${from} database upgrades to v3 and keeps every Place, scan and reference photo it had`, async () => {
    const fake = install()
    fake.seed(DB, from, stores())
    const before = {
      projects: fake.rows(DB, 'projects'),
      scans: fake.rows(DB, 'scans'),
      photos: fake.rows(DB, 'referencePhotos'),
    }
    const store = new ProjectStore()
    await store.open()

    assert.equal(fake.databases.get(DB)?.version, 3)
    assert.deepEqual(fake.stores(DB), ['pendingFrame', 'projects', 'referencePhotos', 'scans'])
    // Byte for byte, not merely "the store still exists".
    assert.deepEqual(fake.rows(DB, 'projects'), before.projects)
    assert.deepEqual(fake.rows(DB, 'scans'), before.scans)
    assert.deepEqual(fake.rows(DB, 'referencePhotos').map((row) => row['localKey']), before.photos.map((row) => row['localKey']))

    // And they are reachable the ways the app reaches them.
    assert.equal((await store.getProject('proj-1'))?.spatialFrame?.separationM, 2, 'the Place and its frame')
    assert.equal((await store.listProjects()).length, 2)
    assert.deepEqual((await store.listScans('proj-1')).map((scan) => scan.scanId), ['scan-2', 'scan-1'], 'through the byProject index')
    assert.equal((await store.listScans(null)).length, 1, 'the unassigned scan')
    assert.equal((await store.getScanBySession('sess-2'))?.scanId, 'scan-2', 'through the bySession index')
    if (from === 2) {
      const photo = await store.getReferencePhoto('proj-1:landmark')
      assert.equal(await photo?.blob.text(), 'jpeg bytes for proj-1:landmark', 'the photo bytes')
      assert.equal((await store.listReferencePhotos('proj-1')).length, 2, 'through the byProject index')
    }
    assert.deepEqual(await store.listPendingFrames(), [], 'the new store is there and empty')
    await store.putPendingFrame({ projectId: 'proj-1', frame: F1, expectedRevision: 0, syncState: 'pending', recordedAt: 1, updatedAt: 1, attempts: 0 })
    assert.equal((await store.listPendingFrames()).length, 1, 'and takes a row')
  })
}

test('a database already at v3 opens as it is, with no upgrade', async () => {
  const fake = install()
  fake.seed(DB, 3, [...V2_STORES(), { name: 'pendingFrame', keyPath: 'projectId', rows: [{ projectId: 'proj-1', frame: F1, expectedRevision: 0, syncState: 'failed', recordedAt: 1, updatedAt: 2, attempts: 3 }] }])
  const store = new ProjectStore()
  await store.open()
  assert.equal((await store.getPendingFrame('proj-1'))?.attempts, 3, 'a row a previous visit left is still there')
})

// ── The upgrade another tab can hold up ──────────────────────────────────────────────────────────

test('a tab from before v3 holding the database does not hold the page: the store opens without it, then takes it when the tab lets go', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const fake = install()
    fake.seed(DB, 2, V2_STORES())
    // The older build opens v2 and never closes it, and has no versionchange handler.
    const oldTab = await fake.connect(DB, 2)
    const warn = mock.method(console, 'warn', () => {})

    const store = new ProjectStore()
    const opening = store.open()
    await settle()
    assert.equal(fake.blockedCount, 1, 'the upgrade is blocked, as it would be in a browser')
    mock.timers.tick(3000)
    await opening
    assert.equal(fake.databases.get(DB)?.version, 2, 'still at v2: nothing was upgraded behind the other tab')

    // Without a database: reads find nothing and writes fail, which every caller already copes with.
    assert.equal(await store.getProject('proj-1'), null)
    assert.deepEqual(await store.listPendingFrames(), [])
    await assert.rejects(() => store.putPendingFrame({ projectId: 'proj-1', frame: F1, expectedRevision: 0, syncState: 'pending', recordedAt: 1, updatedAt: 1, attempts: 0 }), /DB not open/)
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /another tab/)
    warn.mock.restore()

    oldTab.close()
    await settle()
    assert.equal(fake.databases.get(DB)?.version, 3, 'the upgrade finishes when the tab lets go')
    assert.equal((await store.getProject('proj-1'))?.name, 'Place proj-1', 'and the store works, with its data')
    assert.equal(fake.rows(DB, 'referencePhotos').length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('a database that cannot be opened, as when a newer build upgraded it past this one, does not end the start: the store opens without it', async () => {
  const fake = install()
  fake.seed(DB, 4, V2_STORES())
  const warn = mock.method(console, 'warn', () => {})
  try {
    const store = new ProjectStore()
    await store.open()
    assert.equal(await store.getProject('proj-1'), null)
    assert.deepEqual(await store.listPendingFrames(), [])
    await assert.rejects(() => store.updateProject(place('proj-1')), /DB not open/)
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /could not be opened/)
    assert.equal(fake.databases.get(DB)?.version, 4, 'and nothing was downgraded')
  } finally {
    warn.mock.restore()
  }
})

test('without a database the scan bookkeeping is skipped, so a scan can still be exported; with one, a failed write is still an error', async () => {
  const fake = install()
  fake.seed(DB, 4, V2_STORES())
  const warn = mock.method(console, 'warn', () => {})
  try {
    const degraded = new ProjectStore()
    await degraded.open()
    const entry = await degraded.addScan({ projectId: 'proj-1', areaId: null, sessionId: 'sess-9', name: 'x', status: 'draft', capturedAt: 1 } as never)
    assert.match(entry.scanId, /^scan-/, 'the entry exists for the export to use')
    await degraded.updateScan({ ...entry, status: 'ready' })
    assert.equal(fake.rows(DB, 'scans').length, 3, 'and nothing was kept')
  } finally {
    warn.mock.restore()
  }
  const { fake: working, store } = await opened()
  const kept = await store.addScan({ projectId: 'proj-1', areaId: null, sessionId: 'sess-9', name: 'x', status: 'draft', capturedAt: 1 } as never)
  assert.equal(working.rows(DB, 'scans').length, 1, 'with a database it is kept')
  working.failNext('scans', 'put')
  await assert.rejects(() => store.updateScan({ ...kept, status: 'ready' }), /QuotaExceededError/)
})

test('the store lets a newer build upgrade the database instead of holding it open', async () => {
  const { fake, store } = await opened()
  const request = fake.open(DB, 4)
  let upgraded = false
  request.onupgradeneeded = () => {
    upgraded = true
  }
  await settle()
  assert.equal(fake.blockedCount, 0, 'this tab closed its connection when asked')
  assert.equal(upgraded, true)
  assert.equal(await store.getProject('proj-1'), null, 'and its own store stops working rather than throw: it runs the older build')
})

// ── The mirror cannot take a frame away ───────────────────────────────────────────────────────────

const frameOf = async (store: ProjectStore, id = 'proj-1') => (await store.getProject(id))?.spatialFrame?.createdAt ?? null
const revisionOf = async (store: ProjectStore, id = 'proj-1') => (await store.getProject(id))?.spatialFrameRevision

test('a mirror write with a lower frame revision cannot take the frame or the revision from the record it replaces', async () => {
  const { store } = await opened()
  await store.updateProject(place('proj-1', { spatialFrame: F2, spatialFrameRevision: 3 }))

  // A stale copy: read before the last two calibrations, written by a tab that has had the page open since.
  await store.updateProject(place('proj-1', { name: 'Renamed in a stale tab', spatialFrame: F0, spatialFrameRevision: 1 }))
  const kept = await store.getProject('proj-1')
  assert.equal(kept?.name, 'Renamed in a stale tab', 'everything else is the incoming copy\'s')
  assert.equal(kept?.spatialFrame?.createdAt, F2.createdAt, 'the frame stays')
  assert.equal(kept?.spatialFrameRevision, 3, 'and so does its revision')

  // A copy that never saw a frame at all: no frame, no revision.
  await store.updateProject(place('proj-1', { name: 'Renamed again' }))
  assert.equal(await frameOf(store), F2.createdAt)
  assert.equal(await revisionOf(store), 3)
  assert.equal((await store.getProject('proj-1'))?.name, 'Renamed again')
})

test('a mirror write takes the frame when its revision is the same or higher, or when the record has no frame', async () => {
  const { store } = await opened()
  await store.updateProject(place('proj-1'))
  await store.updateProject(place('proj-1', { spatialFrame: F0, spatialFrameRevision: 1 }))
  assert.equal(await frameOf(store), F0.createdAt, 'a record with no frame takes one')

  await store.updateProject(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 1 }))
  assert.equal(await frameOf(store), F1.createdAt, 'at the same revision the incoming copy wins: a frame not yet sent is written at the revision it was read at')

  await store.updateProject(place('proj-1', { spatialFrame: F2, spatialFrameRevision: 2 }))
  assert.equal(await frameOf(store), F2.createdAt)
  assert.equal(await revisionOf(store), 2)

  await store.updateProject(place('proj-2'))
  await store.updateProject(place('proj-2', { spatialFrameRevision: 5 }))
  assert.equal(await revisionOf(store, 'proj-2'), 5, 'a revision with no frame to protect is written')
  // And a record that holds no frame has nothing to protect: the copy that comes after it is not held to its revision.
  await store.updateProject(place('proj-2', { name: 'After' }))
  assert.equal(await revisionOf(store, 'proj-2'), undefined, 'a revision is not a frame')
  assert.equal((await store.getProject('proj-2'))?.name, 'After')
})

test('a copy that is the server\'s own answer is written whatever revision it carries, and a stale tab\'s is not', async () => {
  const { store } = await opened()
  await store.updateProject(place('proj-1', { spatialFrame: F2, spatialFrameRevision: 5 }))
  // The server's registry was restored from a backup: it holds revision 3. The phone's guard would keep revision 5 for good.
  await store.updateProject(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 3 }), { authoritative: true })
  assert.equal(await frameOf(store), F1.createdAt, 'the frame is what the server holds')
  assert.equal(await revisionOf(store), 3)
  // The default stays what protects it from another tab.
  await store.updateProject(place('proj-1', { spatialFrame: F0, spatialFrameRevision: 1 }))
  assert.equal(await frameOf(store), F1.createdAt)
  assert.equal(await revisionOf(store), 3)
})

test('two tabs writing the same Place at the same moment cannot lose the frame, in either order', async () => {
  for (const order of ['fresh first', 'stale first'] as const) {
    const fake = install()
    const tabA = new ProjectStore()
    const tabB = new ProjectStore()
    await Promise.all([tabA.open(), tabB.open()])
    await tabA.updateProject(place('proj-1'))

    const fresh = () => tabA.updateProject(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 1 }))
    const stale = () => tabB.updateProject(place('proj-1', { name: 'stale tab save' }))
    await Promise.all(order === 'fresh first' ? [fresh(), stale()] : [stale(), fresh()])

    assert.equal(await frameOf(tabA), F1.createdAt, `${order}: the frame is there`)
    assert.equal(await revisionOf(tabA), 1, order)
    assert.equal(fake.rows(DB, 'projects').length, 1)
  }
})

test('deleting a Place from the mirror takes its waiting frame and its scans with it, and leaves another Place\'s alone', async () => {
  const { store } = await opened()
  await store.updateProject(place('proj-1'))
  await store.updateProject(place('proj-2'))
  await store.putPendingFrame({ projectId: 'proj-1', frame: F1, expectedRevision: 0, syncState: 'failed', recordedAt: 1, updatedAt: 1, attempts: 1 })
  await store.putPendingFrame({ projectId: 'proj-2', frame: F1, expectedRevision: 0, syncState: 'failed', recordedAt: 1, updatedAt: 1, attempts: 1 })
  await store.addScan({ projectId: 'proj-1', areaId: null, sessionId: 'sess-1', name: 'one', status: 'draft', capturedAt: 1 } as never)
  await store.addScan({ projectId: 'proj-2', areaId: null, sessionId: 'sess-2', name: 'two', status: 'draft', capturedAt: 2 } as never)
  await store.deleteProject('proj-1')
  assert.equal(await store.getProject('proj-1'), null)
  assert.deepEqual((await store.listPendingFrames()).map((r) => r.projectId), ['proj-2'])
  assert.deepEqual(await store.listScans('proj-1'), [], 'its scans are not left pointing at a Place that is gone')
  assert.equal((await store.listScans('proj-2')).length, 1)
})

// ── The waiting frame ────────────────────────────────────────────────────────────────────────────

const row = (extra: Partial<PendingFrameRecord> = {}): PendingFrameRecord => ({
  projectId: 'proj-1',
  frame: F1,
  expectedRevision: 0,
  syncState: 'pending',
  recordedAt: 1,
  updatedAt: 1,
  attempts: 0,
  ...extra,
})

test('a Place has one waiting frame, a newer calibration replaces it, and a late answer about the old one cannot touch the new row', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row())
  await store.putPendingFrame(row({ frame: F2 }))
  assert.equal((await store.listPendingFrames()).length, 1)
  assert.equal((await store.getPendingFrame('proj-1'))?.frame.createdAt, F2.createdAt, 'the newest calibration')

  // The send of F1 was still in flight when the person calibrated again: its answer is for a frame that is gone.
  assert.equal(await store.patchPendingFrame('proj-1', F1.createdAt, { syncState: 'failed' }), false)
  assert.equal(await store.clearPendingFrame('proj-1', F1.createdAt), false)
  assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'pending', 'the new row is as it was')

  assert.equal(await store.patchPendingFrame('proj-1', F2.createdAt, (existing) => ({ syncState: 'failed', attempts: existing.attempts + 1 })), true)
  assert.deepEqual((await store.getPendingFrame('proj-1'))?.syncState, 'failed')
  assert.equal((await store.getPendingFrame('proj-1'))?.attempts, 1)
  // A patch cannot move the row: whatever it says about the Place, the row stays under the key it was found by.
  assert.equal(await store.patchPendingFrame('proj-1', F2.createdAt, { projectId: 'proj-9' } as Partial<PendingFrameRecord>), true)
  assert.equal((await store.getPendingFrame('proj-1'))?.projectId, 'proj-1')
  assert.equal(await store.getPendingFrame('proj-9'), null, 'and no row appears under the other key')
  assert.equal(await store.clearPendingFrame('proj-1', F2.createdAt), true)
  assert.equal(await store.getPendingFrame('proj-1'), null)
})

test('a failed write to the waiting frames is an error the caller sees, and leaves the row as it was', async () => {
  const { fake, store } = await opened()
  await store.putPendingFrame(row())
  fake.failNext('pendingFrame', 'put')
  await assert.rejects(() => store.patchPendingFrame('proj-1', F1.createdAt, { syncState: 'failed' }), /QuotaExceededError/)
  assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'pending')
})

test('a transaction the browser aborts with no request error is an error too, not a write that never answers', async () => {
  const { fake, store } = await opened()
  await store.putPendingFrame(row())
  // The quota is hit when the browser tries to commit, so no request failed: the transaction only aborts.
  fake.failNext('pendingFrame', 'put', new Error('QuotaExceededError'), true)
  const outcome = await Promise.race([
    store.patchPendingFrame('proj-1', F1.createdAt, { syncState: 'failed' }).then(() => 'resolved', (error: Error) => error.message),
    new Promise<string>((done) => setTimeout(() => done('never answered'), 500)),
  ])
  assert.equal(outcome, 'QuotaExceededError')
  assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'pending', 'and the row is as it was')
})

// ── Sending a frame: what each answer means ──────────────────────────────────────────────────────

test('a 200 is saved, and the frame it reports is the one the server stored', async () => {
  const stored = { ...F1, pointLabels: ['a', 'b'] as [string, string] }
  const net = wire(() => saved(1, stored))
  const outcome = await sendSpatialFrame(net.env, 'proj-1', F1, 0)
  assert.deepEqual(outcome, { status: 'saved', revision: 1, frame: stored })
  assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')])
  assert.deepEqual(net.bodies, [{ frame: F1, expectedRevision: 0 }])
})

test('a 202 the service worker made is queued, not saved, even though resp.ok is true for it', async () => {
  const reply = queuedReply()
  assert.equal(reply.ok, true, 'the trap the header exists for')
  const outcome = await sendSpatialFrame(wire(() => queuedReply()).env, 'proj-1', F1, 0)
  assert.deepEqual(outcome, { status: 'queued' })
})

test('a 409 for the frame that was sent is saved: the request had already been applied', async () => {
  const outcome = await sendSpatialFrame(wire(() => conflict({ frame: { ...F1 }, revision: 4 })).env, 'proj-1', F1, 3)
  assert.equal(outcome.status, 'saved')
  assert.equal(outcome.status === 'saved' && outcome.revision, 4, 'at the revision the server reports')
})

test('a 409 for another frame is a conflict that carries what the server holds', async () => {
  const outcome = await sendSpatialFrame(wire(() => conflict({ frame: F2, revision: 2 })).env, 'proj-1', F1, 1)
  assert.deepEqual(outcome, { status: 'conflict', current: { frame: F2, revision: 2 } })
  const none = await sendSpatialFrame(wire(() => conflict({ frame: null, revision: 2 })).env, 'proj-1', F1, 0)
  assert.deepEqual(none, { status: 'conflict', current: { frame: null, revision: 2 } })
})

test('anything else is failed: retryable for the network and the server, permanent when the server found the frame itself unacceptable', async () => {
  const cases: Array<[string, () => Response | Promise<Response>, boolean]> = [
    ['500', () => json({ error: 'boom' }, 500), false],
    ['503 with no body', () => new Response('', { status: 503 }), false],
    ['401 (the session ran out)', () => json({ error: 'Sign in' }, 401), false],
    ['408', () => json({}, 408), false],
    ['429', () => json({}, 429), false],
    ['507 (the worker could not queue it)', () => json({ ok: false, error: 'queue-write-failed' }, 507), false],
    ['a 404 with no body: a server without the route yet', () => new Response('404 Not Found', { status: 404 }), false],
    ['a 200 that is not the reply', () => json({ nothing: true }), false],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), false],
    ['400', () => json({ error: 'spatialFrame.separationM must be at least 1 m' }, 400), true],
    ['413', () => json({ error: 'Place is too large' }, 413), true],
    ['404 from the registry: the Place is gone', () => json({ error: 'Not found' }, 404), true],
  ]
  for (const [what, reply, permanent] of cases) {
    const outcome = await sendSpatialFrame(wire(reply).env, 'proj-1', F1, 0)
    assert.equal(outcome.status, 'failed', what)
    assert.equal(outcome.status === 'failed' && outcome.permanent, permanent, `${what}: permanent`)
  }
  const refused = await sendSpatialFrame(wire(() => json({ error: 'spatialFrame.separationM must be at least 1 m' }, 400)).env, 'proj-1', F1, 0)
  assert.equal(refused.status === 'failed' && refused.reason, 'spatialFrame.separationM must be at least 1 m', 'the server\'s reason is kept')
})

test('a Place id with characters that need escaping is escaped in the route', async () => {
  const net = wire(() => saved(1, F1))
  await sendSpatialFrame(net.env, 'proj 1/../x', F1, 0)
  assert.deepEqual(net.calls, ['PUT /projects/proj%201%2F..%2Fx/spatial-frame'])
})

// ── Sending a frame: the request, the opt-out and the time it may take ───────────────────────────

test('the frame write asks the service worker not to queue it, and a page with no worker to ask sends nothing extra', async () => {
  const optOut = wire(() => saved(1, F1))
  optOut.env.noQueue = () => ({ [NO_QUEUE_HEADER]: '1' })
  await sendSpatialFrame(optOut.env, 'proj-1', F1, 0)
  assert.equal(optOut.headers[0]![NO_QUEUE_HEADER.toLowerCase()], '1')
  assert.equal(optOut.headers[0]!['content-type'], 'application/json')

  const plain = wire(() => saved(1, F1))
  await sendSpatialFrame(plain.env, 'proj-1', F1, 0)
  assert.equal(NO_QUEUE_HEADER.toLowerCase() in plain.headers[0]!, false)
  assert.equal(browserFrameSyncEnv().noQueue, noQueueHeaders, 'the page asks wherever noQueueHeaders says a worker could queue')
})

test('a request that never answers is given up on, and is a failure a retry may fix', async () => {
  const hung = wire((_call, _n, _body) => new Promise<Response>(() => {}))
  const original = hung.env.fetchFn
  hung.env.fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolveReply, reject) => {
      void original(input, init)
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      void resolveReply
    })) as typeof fetch
  hung.env.requestTimeoutMs = 20
  const started = Date.now()
  const outcome = await sendSpatialFrame(hung.env, 'proj-1', F1, 0)
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.status === 'failed' && outcome.permanent, false)
  assert.ok(Date.now() - started < 2000, 'it did not wait for the browser\'s own limit')
})

test('a 409 for this very calibration in another form is not a conflict: it is sent once more, at the revision the server holds', async () => {
  // A retry in another tab sent the row before its photo records were attached, so the server holds the same
  // calibration (same createdAt) without them.
  const withPhotos = { ...F1, pointLabels: ['a', 'b'] as [string, string] }
  const net = wire((_call, n) => (n === 1 ? conflict({ frame: F1, revision: 1 }) : saved(2, withPhotos)))
  const outcome = await sendSpatialFrame(net.env, 'proj-1', withPhotos, 0)
  assert.equal(outcome.status, 'conflict', 'sendSpatialFrame reports what the server said')
  assert.equal(net.calls.length, 1)

  const settled = wire((_call, n) => (n === 1 ? conflict({ frame: F1, revision: 1 }) : saved(2, withPhotos)))
  const { store } = await opened()
  const project = place('proj-1')
  const result = await persistProjectSpatialFrame(store, project, withPhotos, {}, settled.env)
  assert.equal(result.status === 'saved' && result.revision, 2)
  assert.deepEqual(settled.bodies.map((body) => body.expectedRevision), [0, 1], 'the second names the revision the 409 reported')
  assert.equal(project.spatialFrameRevision, 2)
})

test('the same calibration is sent a second time once, and another device\'s frame is never sent over', async () => {
  const { store } = await opened()
  const twice = wire(() => conflict({ frame: { ...F1, pointLabels: ['x', 'y'] }, revision: 1 }))
  const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, {}, twice.env)
  assert.equal(outcome.status, 'conflict', 'it does not go round again')
  assert.equal(twice.calls.length, 2)

  const other = wire(() => conflict({ frame: F2, revision: 1 }))
  const lost = await persistProjectSpatialFrame(store, place('proj-2'), F1, {}, other.env)
  assert.equal(lost.status, 'conflict')
  assert.equal(other.calls.length, 1, 'a frame made at another moment is another calibration: the first answer stands')
})

// ── Calibrating: the frame is written down, its photos are stored, it is sent, and only then are the photos uploaded ──

const captured = (role: ReferencePhotoRole): PendingReferencePhoto => ({
  role,
  blob: new Blob([`jpeg ${role}`], { type: 'image/jpeg' }),
  thumbDataUrl: 'data:image/jpeg;base64,AAAA',
  tapPoint: role === 'landmark' ? { x: 0.25, y: 0.5 } : { x: 0.75, y: 0.5 },
  pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T09:59:00.000Z',
  label: null,
})
const BOTH = (): PendingReferencePhoto[] => [captured('landmark'), captured('headingMarker')]
const photoPath = (id: string, role: ReferencePhotoRole) => `/projects/${id}/reference-photos/ref-${role}.jpg`
const POST_PHOTO = (id: string) => `POST /projects/${id}/reference-photos`

/** A server that takes the frame as it is sent and takes photos. */
const takes = (revision = 1) => (call: string, _n: number, body: unknown) =>
  call.startsWith('PUT') ? saved(revision, (body as { frame: ProjectSpatialFrame }).frame) : json({ ok: true })

/** A store that says what it was asked, in order, and does it. */
function spied(store: ProjectStore, log: string[]): FrameStore {
  const spy = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => (...args: A): R => {
    log.push(name)
    return fn.apply(store, args)
  }
  return {
    getProject: spy('getProject', store.getProject),
    updateProject: spy('updateProject', store.updateProject),
    putPendingFrame: spy('putPendingFrame', store.putPendingFrame),
    getPendingFrame: spy('getPendingFrame', store.getPendingFrame),
    listPendingFrames: spy('listPendingFrames', store.listPendingFrames),
    patchPendingFrame: spy('patchPendingFrame', store.patchPendingFrame),
    clearPendingFrame: spy('clearPendingFrame', store.clearPendingFrame),
    putReferencePhoto: spy('putReferencePhoto', store.putReferencePhoto),
    getReferencePhoto: spy('getReferencePhoto', store.getReferencePhoto),
    deleteReferencePhoto: spy('deleteReferencePhoto', store.deleteReferencePhoto),
  }
}

test('a calibration records the frame, stores its photos, sends the frame, and only then uploads the photos', async () => {
  const { fake, store } = await opened()
  const order: string[] = []
  const net = wire((call, n, body) => {
    order.push(call)
    return takes(1)(call, n, body)
  })
  const project = place('proj-1')
  const frameWithLabels = { ...F1, pointLabels: ['north door', '  '] as [string, string] }

  const outcome = await persistProjectSpatialFrame(spied(store, order), project, frameWithLabels, { photos: BOTH() }, net.env)

  assert.deepEqual(order, [
    'putPendingFrame', 'putReferencePhoto', 'putReferencePhoto', 'patchPendingFrame',
    FRAME_ROUTE('proj-1'),
    'patchPendingFrame', 'updateProject',
    'getReferencePhoto', POST_PHOTO('proj-1'), 'getReferencePhoto', POST_PHOTO('proj-1'),
    'clearPendingFrame',
  ])
  assert.equal(outcome.status, 'saved')
  assert.equal(net.bodies[0]!.expectedRevision, 0, 'it names the revision the Place was read at')
  const sent = net.bodies[0]!.frame as { referencePhotos?: Record<string, { url: string; localKey: string; tapPoint: unknown }> }
  assert.equal(sent.referencePhotos?.['landmark']?.url, photoPath('proj-1', 'landmark'), 'the frame carries the path the photo will be served from')
  assert.equal(sent.referencePhotos?.['headingMarker']?.url, photoPath('proj-1', 'headingMarker'))
  assert.equal(sent.referencePhotos?.['landmark']?.localKey, referencePhotoKey('proj-1', 'landmark'))
  assert.deepEqual(sent.referencePhotos?.['landmark']?.tapPoint, { x: 0.25, y: 0.5 })
  assert.deepEqual(net.photos, [
    { role: 'landmark', label: 'north door', bytes: 'jpeg landmark' },
    { role: 'headingMarker', label: undefined, bytes: 'jpeg headingMarker' },
  ])
  assert.deepEqual(fake.rows(DB, 'pendingFrame'), [], 'the row is gone once the server has the frame and the photos')
  assert.equal(fake.rows(DB, 'referencePhotos').length, 2, 'the copies stay on the phone: they are what the aid shows offline')
  assert.equal(project.spatialFrameRevision, 1, 'the Place in memory is at the revision the server answered')
  assert.equal((await store.getProject('proj-1'))?.spatialFrameRevision, 1)
})

test('a calibration that lost to another device uploads none of its photos, and drops the copies it stored', async () => {
  const { fake, store } = await opened()
  // This phone had photos of its own for the Place from an earlier calibration; staging the new ones replaced them.
  await store.putReferencePhoto({ localKey: referencePhotoKey('proj-1', 'landmark'), projectId: 'proj-1', role: 'landmark', blob: new Blob(['old']), thumbDataUrl: '', capturedAt: 'x' })
  const net = wire((call) => (call.startsWith('PUT') ? conflict({ frame: F2, revision: 1 }) : json({ ok: true })))
  const project = place('proj-1')

  const outcome = await persistProjectSpatialFrame(store, project, F1, { photos: BOTH() }, net.env)

  assert.equal(outcome.status, 'conflict')
  assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')], 'no photo was sent: the winner\'s are on the server and stay there')
  assert.deepEqual(fake.rows(DB, 'referencePhotos'), [], 'and the copies of the frame that lost are not kept to be drawn against the winner\'s frame')
  const [kept] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
  assert.equal(kept?.syncState, 'conflict')
  assert.deepEqual(kept?.photos, [], 'nothing is left waiting to upload')
  assert.equal(project.spatialFrame?.createdAt, F2.createdAt)
})

test('a calibration made offline keeps its frame and photos on the phone; the retry that finds the server sends the frame, then the photos', async () => {
  const { fake, store } = await opened()
  let up = false
  const net = wire((call, n, body) => {
    if (!up) throw new TypeError('Failed to fetch')
    return takes(1)(call, n, body)
  })
  const project = place('proj-1')
  const warn = mock.method(console, 'warn', () => {})
  try {
    const offline = await persistProjectSpatialFrame(store, project, F1, { photos: BOTH() }, net.env)
    assert.equal(offline.status, 'failed')
    assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')], 'no photo is sent while the frame is not saved')
    const [waiting] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
    assert.equal(waiting?.syncState, 'failed')
    assert.deepEqual(waiting?.photos, ['landmark', 'headingMarker'])
    assert.equal(fake.rows(DB, 'referencePhotos').length, 2)

    up = true
    assert.deepEqual(await retryPendingFrames(store, net.env), { changed: true })
    assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1'), FRAME_ROUTE('proj-1'), POST_PHOTO('proj-1'), POST_PHOTO('proj-1')])
    assert.deepEqual(net.photos.map((photo) => photo.bytes), ['jpeg landmark', 'jpeg headingMarker'], 'from the copies on the phone')
    assert.equal((net.bodies[1]!.frame as { referencePhotos?: unknown }).referencePhotos !== undefined, true, 'the frame the retry sends carries their records')
    assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
  } finally {
    warn.mock.restore()
  }
})

test('a photo that did not go stays waiting while its frame is saved, is not an unsynced alignment, and goes with the next retry', async () => {
  const { fake, store } = await opened()
  let photoStatus = 500
  const net = wire((call, n, body) => (call.startsWith('PUT') ? takes(1)(call, n, body) : json({ ok: photoStatus === 200 }, photoStatus)))
  const warn = mock.method(console, 'warn', () => {})
  try {
    const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, { photos: BOTH() }, net.env)
    assert.equal(outcome.status, 'saved')
    const [waiting] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
    assert.equal(waiting?.syncState, 'photos', 'the server holds the frame')
    assert.deepEqual(waiting?.photos, ['landmark', 'headingMarker'])
    const rows = await store.listPendingFrames()
    assert.deepEqual([...unsyncedPlaceIds(rows)], [], 'the alignment is synced: only the pictures are late')
    const server = place('proj-1', { spatialFrame: F2, spatialFrameRevision: 3 })
    assert.equal(withPendingFrame(server, rows), server, 'and a row that is only waiting for photos does not stand for the Place\'s frame')

    photoStatus = 200
    net.calls.length = 0
    await retryPendingFrames(store, net.env, 'picker')
    assert.deepEqual(net.calls, [POST_PHOTO('proj-1'), POST_PHOTO('proj-1')], 'the frame is not sent again, the photos are')
    assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
    await retryPendingFrames(store, net.env)
    assert.equal(net.calls.length, 2, 'and then there is nothing to send')
  } finally {
    warn.mock.restore()
  }
})

test('only the photos that did not go are kept; a refused photo is let go; one the worker holds is done; one that cannot be read is kept', async () => {
  const { fake, store } = await opened()
  const warn = mock.method(console, 'warn', () => {})
  try {
    const cases: Array<[string, (role: string) => Response | Promise<Response>, ReferencePhotoRole[]]> = [
      ['landmark ok, heading 500', (role) => (role === 'landmark' ? json({ ok: true }) : json({ error: 'x' }, 500)), ['headingMarker']],
      ['413 for both: the server will say so again', () => json({ error: 'photo exceeds' }, 413), []],
      ['400 for both', () => json({ error: 'meta' }, 400), []],
      ['408 and 429 are worth another go', (role) => json({}, role === 'landmark' ? 408 : 429), ['landmark', 'headingMarker']],
      ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), ['landmark', 'headingMarker']],
      ['a worker that queued it holds it', () => queuedReply(), []],
    ]
    for (const [what, answer, remaining] of cases) {
      await store.clearPendingFrame('proj-1', F1.createdAt)
      const net = wire((call, n, body) => {
        if (call.startsWith('PUT')) return takes(1)(call, n, body)
        return answer((body as { role: string }).role)
      })
      await persistProjectSpatialFrame(store, place('proj-1'), { ...F1 }, { photos: BOTH() }, net.env)
      const left = (await store.getPendingFrame('proj-1'))?.photos ?? []
      assert.deepEqual(left, remaining, what)
      assert.equal(fake.rows(DB, 'pendingFrame').length, remaining.length > 0 ? 1 : 0, what)
    }

    // A copy that is gone has nothing left to send; one that cannot be read right now is not gone.
    await store.putPendingFrame(row({ syncState: 'photos', photos: ['landmark'], frame: { ...F1, referencePhotos: { landmark: { url: photoPath('proj-1', 'landmark'), localKey: 'proj-1:landmark', tapPoint: { x: 0.1, y: 0.1 }, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: 'x' }, headingMarker: { url: photoPath('proj-1', 'headingMarker'), localKey: 'proj-1:headingMarker', tapPoint: { x: 0.1, y: 0.1 }, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: 'x' } } } as ProjectSpatialFrame }))
    const quiet = wire(() => json({ ok: true }))
    fake.failNext('referencePhotos', 'get')
    await retryPendingFrames(store, quiet.env)
    assert.deepEqual(quiet.calls, [], 'a storage error is not a missing photo')
    assert.deepEqual((await store.getPendingFrame('proj-1'))?.photos, ['landmark'], 'so it is still waiting')
    await store.deleteReferencePhoto('proj-1:landmark')
    await retryPendingFrames(store, quiet.env)
    assert.deepEqual(quiet.calls, [], 'the copy is not there: there is nothing to send')
    assert.equal(await store.getPendingFrame('proj-1'), null, 'and the row is let go')
  } finally {
    warn.mock.restore()
  }
})

test('a frame a worker that does not know the opt-out queued waits with its photos, which are not uploaded behind it', async () => {
  const { fake, store } = await opened()
  const net = wire((call, n, body) => (call.startsWith('PUT') && n === 1 ? queuedReply() : takes(1)(call, n, body)))
  const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, { photos: BOTH() }, net.env)
  assert.equal(outcome.status, 'queued')
  assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')], 'no photo goes into the same queue ahead of the answer')
  const [waiting] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
  assert.equal(waiting?.syncState, 'queued')
  assert.deepEqual(waiting?.photos, ['landmark', 'headingMarker'])
  await retryPendingFrames(store, net.env, 'load')
  assert.deepEqual(net.calls.slice(1), [FRAME_ROUTE('proj-1'), POST_PHOTO('proj-1'), POST_PHOTO('proj-1')])
})

test('the frame keeps no photos unless both were stored, and the Place keeps working', async () => {
  const { fake, store } = await opened()
  const net = wire(takes(1))
  const warn = mock.method(console, 'warn', () => {})
  try {
    fake.failNext('referencePhotos', 'put')
    const project = place('proj-1')
    await persistProjectSpatialFrame(store, project, F1, { photos: BOTH() }, net.env)
    assert.equal((net.bodies[0]!.frame as { referencePhotos?: unknown }).referencePhotos, undefined, 'one photo would let half a reference pass for all of it')
    assert.deepEqual(net.photos, [])
    assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
    // A one-point frame has nowhere to hang photos.
    const onePoint = { version: 1, createdAt: '2026-11-16T11:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: null } as ProjectSpatialFrame
    await persistProjectSpatialFrame(store, place('proj-2'), onePoint, { photos: BOTH() }, net.env)
    assert.deepEqual(net.photos, [])
  } finally {
    warn.mock.restore()
  }
})

test('the revision a calibration names is the one the Place carries, not always 0', async () => {
  const { store } = await opened()
  const net = wire(() => saved(8, F2))
  await persistProjectSpatialFrame(store, place('proj-1', { spatialFrameRevision: 7 }), F2, {}, net.env)
  assert.equal(net.bodies[0]!.expectedRevision, 7)
})

test('a calibration does not write the frame into the Place copy before the server has answered: the copy holds what the server said', async () => {
  const { fake, store } = await opened()
  await store.updateProject(place('proj-1', { spatialFrame: F0, spatialFrameRevision: 1 }))
  const net = wire(() => json({ error: 'boom' }, 500))
  const warn = mock.method(console, 'warn', () => {})
  try {
    const outcome = await persistProjectSpatialFrame(store, place('proj-1', { spatialFrame: F0, spatialFrameRevision: 1 }), F1, {}, net.env)
    assert.equal(outcome.status, 'failed')
    const mirrored = await store.getProject('proj-1')
    assert.equal(mirrored?.spatialFrame?.createdAt, F0.createdAt, 'the frame the server never took is in the row, and not here')
    assert.equal((fake.rows(DB, 'pendingFrame')[0] as unknown as PendingFrameRecord).frame.createdAt, F1.createdAt)
  } finally {
    warn.mock.restore()
  }
})

test('a storage error does not skip the server: the frame is still sent, and is saved', async () => {
  const { fake, store } = await opened()
  const net = wire(takes(1))
  const warn = mock.method(console, 'warn', () => {})
  try {
    // Each step in turn: the row, the photos' copies, the row's update, the clearing of it, the mirror.
    for (const [storeName, op] of [['pendingFrame', 'put'], ['referencePhotos', 'put'], ['projects', 'put'], ['pendingFrame', 'delete']] as const) {
      fake.failNext(storeName, op)
      const outcome = await persistProjectSpatialFrame(store, place(`proj-${storeName}-${op}`), { ...F1 }, { photos: BOTH() }, net.env)
      assert.equal(outcome.status, 'saved', `${storeName} ${op}`)
    }
    assert.equal(net.calls.filter((call) => call.startsWith('PUT')).length, 4, 'every request was made')
  } finally {
    warn.mock.restore()
  }
})

test('a phone whose storage fails at every step still sends the frame, and never throws', async () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    const net = wire(takes(1))
    const outcome = await persistProjectSpatialFrame(brokenStore(), place('proj-1'), F1, { photos: BOTH() }, net.env)
    assert.equal(outcome.status, 'saved')
    assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')], 'the frame went; no photo copy could be stored, so none was promised')
    assert.ok(warn.mock.calls.length >= 3, 'each failed step is said, none is silent')
  } finally {
    warn.mock.restore()
  }
})

test('a storage step that never answers costs the row and not the send', async () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    const never = () => new Promise<never>(() => {})
    const hung: FrameStore = { ...brokenStore(), putPendingFrame: never, getProject: async () => null, updateProject: async () => undefined, patchPendingFrame: async () => true, clearPendingFrame: async () => true }
    const net = wire(takes(1))
    net.env.localStepTimeoutMs = 20
    const started = Date.now()
    const outcome = await persistProjectSpatialFrame(hung, place('proj-1'), F1, {}, net.env)
    assert.equal(outcome.status, 'saved')
    assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')])
    assert.ok(Date.now() - started < 2000)
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /Gave up waiting to record the frame to save/)

    // The same stall in the read that starts a retry: the retry ends, and the next one is not held behind it.
    const stalled: FrameStore = { ...hung, listPendingFrames: never }
    assert.deepEqual(await retryPendingFrames(stalled, net.env), { changed: false })
    assert.deepEqual(await retryPendingFrames(stalled, net.env), { changed: false }, 'single-flight does not keep the first one')
  } finally {
    warn.mock.restore()
  }
})

test('a request that never answers does not hold the calibration for ever', async () => {
  const { store } = await opened()
  const net = wire(() => new Promise<Response>(() => {}))
  const original = net.env.fetchFn
  net.env.fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      void original(input, init)
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as typeof fetch
  net.env.requestTimeoutMs = 20
  const warn = mock.method(console, 'warn', () => {})
  try {
    const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, {}, net.env)
    assert.equal(outcome.status, 'failed')
    assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'failed', 'and the frame is kept to be sent again')
  } finally {
    warn.mock.restore()
  }
})

test('another device saving first is a conflict: its frame becomes the Place\'s here, and ours is kept in the row', async () => {
  const { fake, store } = await opened()
  const project = place('proj-1')
  const outcome = await persistProjectSpatialFrame(store, project, F1, {}, wire(() => conflict({ frame: F2, revision: 1 })).env)
  assert.equal(outcome.status, 'conflict')
  const [waiting] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
  assert.equal(waiting?.syncState, 'conflict')
  assert.equal(waiting?.frame.createdAt, F1.createdAt, 'our frame is kept as evidence')
  assert.deepEqual(waiting?.current, { frame: F2, revision: 1 })
  assert.equal(project.spatialFrame?.createdAt, F2.createdAt, 'the Place in memory is the server\'s')
  assert.equal(project.spatialFrameRevision, 1)
  const mirrored = await store.getProject('proj-1')
  assert.equal(mirrored?.spatialFrame?.createdAt, F2.createdAt, 'and so is the copy the next visit starts from')
  assert.equal(mirrored?.spatialFrameRevision, 1)

  // The server holds no frame at all and still refused: the Place has none, at the revision it reports.
  const none = place('proj-2', { spatialFrame: F1 })
  await persistProjectSpatialFrame(store, none, F2, {}, wire(() => conflict({ frame: null, revision: 4 })).env)
  assert.equal('spatialFrame' in none, false)
  assert.equal(none.spatialFrameRevision, 4)
  assert.equal((await store.getProject('proj-2'))?.spatialFrameRevision, 4)
  assert.equal((await store.getProject('proj-2'))?.spatialFrame, undefined)
})

test('the server\'s answer is the mirror\'s, even when its revision is lower than the one the phone remembers', async () => {
  const { store } = await opened()
  // The registry was restored from a backup after this phone had read revision 5.
  await store.updateProject(place('proj-1', { spatialFrame: F2, spatialFrameRevision: 5 }))
  const project = place('proj-1', { spatialFrame: F2, spatialFrameRevision: 5 })
  await persistProjectSpatialFrame(store, project, F1, {}, wire(() => conflict({ frame: F0, revision: 3 })).env)
  const mirrored = await store.getProject('proj-1')
  assert.equal(mirrored?.spatialFrame?.createdAt, F0.createdAt, 'the next visit starts from what the server holds')
  assert.equal(mirrored?.spatialFrameRevision, 3)
})

test('a frame the server refuses as malformed is kept as permanent, and nothing sends it again', async () => {
  const { fake, store } = await opened()
  const net = wire(() => json({ error: 'spatialFrame.separationM must be at least 1 m' }, 400))
  const warn = mock.method(console, 'warn', () => {})
  try {
    const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, {}, net.env)
    assert.equal(outcome.status === 'failed' && outcome.permanent, true)
    const [kept] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
    assert.equal(kept?.permanent, true, 'the row says so')
    assert.equal(kept?.lastError, 'spatialFrame.separationM must be at least 1 m')
    assert.deepEqual([...unsyncedPlaceIds([kept!])], [], 'the picker does not promise a sync that will not come')
    assert.deepEqual(await retryPendingFrames(store, net.env), { changed: false })
    assert.equal(net.calls.length, 1)

    const retryable = wire(() => json({ error: 'boom' }, 500))
    await persistProjectSpatialFrame(store, place('proj-2'), F1, {}, retryable.env)
    assert.equal(((await store.getPendingFrame('proj-2')) as PendingFrameRecord).permanent, false, 'a server error is not permanent')
  } finally {
    warn.mock.restore()
  }
})

test('a 202 the worker made leaves the frame waiting as queued, and does not say it was saved', async () => {
  const { fake, store } = await opened()
  const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, {}, wire(() => queuedReply()).env)
  assert.equal(outcome.status, 'queued')
  const [waiting] = fake.rows(DB, 'pendingFrame') as unknown as PendingFrameRecord[]
  assert.equal(waiting?.syncState, 'queued')
  assert.equal((await store.getProject('proj-1')), null, 'and the Place copy is not made up of a frame the server never took')
})

test('with no store at all the frame is still sent', async () => {
  const net = wire(takes(1))
  assert.equal((await persistProjectSpatialFrame(null, place('proj-1'), F1, { photos: BOTH() }, net.env)).status, 'saved')
  assert.deepEqual(net.calls, [FRAME_ROUTE('proj-1')], 'there is nowhere to keep a photo, so none is promised')
})

// ── One writer per Place, and what the page is told ──────────────────────────────────────────────

test('the answer to a retry reaches the page\'s Place, and a calibration that comes after it names the revision the retry saved', async () => {
  const { store } = await opened()
  const project = place('proj-1')
  // The phone calibrated offline earlier: the frame waits, made against revision 0.
  await store.putPendingFrame(row({ frame: F1, expectedRevision: 0, syncState: 'queued' }))
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const net = wire(async (call, n, body) => {
    if (n === 1) await gate
    return takes(n)(call, n, body)
  })
  const heard: FrameSettled[] = []
  const stop = onFrameSettled((event) => {
    heard.push(event)
    adoptFrameOutcome(project, event.outcome)
  })
  try {
    const retrying = retryPendingFrames(store, net.env, 'load')
    await settle()
    // The person overrides while the retry is still on the wire.
    const calibrating = persistProjectSpatialFrame(store, project, F2, {}, net.env)
    await settle()
    assert.equal(net.calls.length, 1, 'the calibration waits for the retry that holds the Place')
    release()
    await retrying
    const outcome = await calibrating
    assert.deepEqual(net.bodies.map((body) => body.expectedRevision), [0, 1], 'it named revision 1, which the retry had just saved')
    assert.equal(outcome.status, 'saved')
    assert.equal(project.spatialFrame?.createdAt, F2.createdAt)
    assert.equal(project.spatialFrameRevision, 2)
    assert.deepEqual(heard.map((event) => [event.projectId, event.frame.createdAt, event.outcome.status]), [
      ['proj-1', F1.createdAt, 'saved'],
      ['proj-1', F2.createdAt, 'saved'],
    ], 'both answers were heard, the retry\'s as well as the calibration\'s')
  } finally {
    stop()
  }
})

test('a retry that loses to another device tells the page, which has the server\'s frame from then on', async () => {
  const { store } = await opened()
  const project = place('proj-1', { spatialFrame: F2 })
  await store.putPendingFrame(row({ frame: F2, expectedRevision: 0, syncState: 'failed' }))
  const heard: FrameSettled[] = []
  const stop = onFrameSettled((event) => {
    heard.push(event)
    adoptFrameOutcome(project, event.outcome)
  })
  try {
    assert.deepEqual(await retryPendingFrames(store, wire(() => conflict({ frame: F1, revision: 1 })).env), { changed: true })
    assert.equal(heard.length, 1)
    assert.equal(heard[0]!.outcome.status, 'conflict')
    assert.equal(project.spatialFrame?.createdAt, F1.createdAt, 'the page no longer works against the frame the server refused')
    assert.equal(project.spatialFrameRevision, 1)
  } finally {
    stop()
  }
  await retryPendingFrames(store, wire(() => saved(1, F2)).env)
  assert.equal(heard.length, 1, 'a listener that was stopped hears no more')
})

test('adoptFrameOutcome gives a Place what the server said about its frame, and nothing for an answer that is not one', () => {
  const p = (): Project => place('proj-1', { spatialFrame: F0, spatialFrameRevision: 1 })
  const savedPlace = p()
  adoptFrameOutcome(savedPlace, { status: 'saved', revision: 4, frame: F1 })
  assert.deepEqual([savedPlace.spatialFrame?.createdAt, savedPlace.spatialFrameRevision], [F1.createdAt, 4])

  const lost = p()
  adoptFrameOutcome(lost, { status: 'conflict', current: { frame: F2, revision: 6 } })
  assert.deepEqual([lost.spatialFrame?.createdAt, lost.spatialFrameRevision], [F2.createdAt, 6])

  const bare = p()
  adoptFrameOutcome(bare, { status: 'conflict', current: { frame: null, revision: 2 } })
  assert.equal('spatialFrame' in bare, false)
  assert.equal(bare.spatialFrameRevision, 2)

  for (const outcome of [{ status: 'queued' }, { status: 'failed', reason: 'x', permanent: false }] as const) {
    const same = p()
    adoptFrameOutcome(same, outcome)
    assert.deepEqual(same, p(), outcome.status)
  }
})

test('a listener that throws does not stop the others, or the frame', async () => {
  const { store } = await opened()
  const warn = mock.method(console, 'warn', () => {})
  const heard: string[] = []
  const stopBad = onFrameSettled(() => {
    throw new Error('a listener bug')
  })
  const stopGood = onFrameSettled((event) => heard.push(event.outcome.status))
  try {
    const outcome = await persistProjectSpatialFrame(store, place('proj-1'), F1, {}, wire(takes(1)).env)
    assert.equal(outcome.status, 'saved')
    assert.deepEqual(heard, ['saved'])
  } finally {
    stopBad()
    stopGood()
    warn.mock.restore()
  }
})

test('the scanner can wait for a retry that is running, and not for longer than it is willing to', async () => {
  const { store } = await opened()
  await whenFramesSettled(store, 5000)
  await whenFramesSettled(null, 5000)
  await store.putPendingFrame(row())
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const net = wire(async () => {
    await gate
    return saved(1, F1)
  })
  const retrying = retryPendingFrames(store, net.env)
  await settle()
  let waited = false
  const waiting = whenFramesSettled(store, 5000).then(() => {
    waited = true
  })
  await settle()
  assert.equal(waited, false, 'the retry is still running')
  release()
  await retrying
  await waiting
  assert.equal(waited, true)

  // One that is slow is not waited for beyond what the caller is willing to.
  await store.putPendingFrame(row({ projectId: 'proj-slow', frame: F2 }))
  const slow = wire((_call, _n, _body) => new Promise<Response>(() => {}))
  const original = slow.env.fetchFn
  slow.env.fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      void original(input, init)
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as typeof fetch
  slow.env.requestTimeoutMs = 400
  const warn = mock.method(console, 'warn', () => {})
  try {
    const running = retryPendingFrames(store, slow.env)
    await settle()
    const started = Date.now()
    await whenFramesSettled(store, 30)
    assert.ok(Date.now() - started < 300, 'it came back before the request was given up on')
    await running
  } finally {
    warn.mock.restore()
  }
})

// ── Retrying ─────────────────────────────────────────────────────────────────────────────────────

test('a waiting frame is sent again: saved clears it, and the Place copy takes the frame at the new revision', async () => {
  const { fake, store } = await opened()
  await store.updateProject(place('proj-1'))
  await store.putPendingFrame(row({ syncState: 'failed', attempts: 2 }))
  const net = wire(() => saved(1, F1))

  const result = await retryPendingFrames(store, net.env)
  assert.deepEqual(result, { changed: true })
  assert.deepEqual(net.bodies, [{ frame: F1, expectedRevision: 0 }], 'the revision it was calibrated at, not a fresh read')
  assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
  assert.equal((await store.getProject('proj-1'))?.spatialFrame?.createdAt, F1.createdAt)
  assert.equal(await revisionOf(store), 1)
})

test('a failed retry keeps the row and counts the attempt, and a queued one stays queued', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row({ projectId: 'proj-1', syncState: 'pending' }))
  await store.putPendingFrame(row({ projectId: 'proj-2', syncState: 'pending' }))
  const net = wire((call) => (call.includes('proj-1') ? json({ error: 'boom' }, 500) : queuedReply()))
  assert.deepEqual(await retryPendingFrames(store, net.env), { changed: false })
  const one = await store.getPendingFrame('proj-1')
  const two = await store.getPendingFrame('proj-2')
  assert.deepEqual([one?.syncState, one?.attempts, one?.lastError], ['failed', 1, 'boom'])
  assert.deepEqual([two?.syncState, two?.attempts], ['queued', 1])
  await retryPendingFrames(store, net.env)
  assert.equal((await store.getPendingFrame('proj-1'))?.attempts, 2, 'and the next retry sends it again')
})

test('a retry does not send a frame that lost to another device, one the server found malformed, or anything while offline', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row({ projectId: 'proj-1', syncState: 'conflict' }))
  await store.putPendingFrame(row({ projectId: 'proj-2', syncState: 'failed', permanent: true }))
  const net = wire(() => saved(1, F1))
  assert.deepEqual(await retryPendingFrames(store, net.env), { changed: false })
  assert.deepEqual(net.calls, [])

  await store.putPendingFrame(row({ projectId: 'proj-3', syncState: 'queued' }))
  net.online = false
  assert.deepEqual(await retryPendingFrames(store, net.env), { changed: false })
  assert.deepEqual(net.calls, [], 'offline, nothing is sent: it would only fail, or be queued again')
  net.online = true
  await retryPendingFrames(store, net.env)
  assert.deepEqual(net.calls, [FRAME_ROUTE('proj-3')], 'and back online it goes')
})

test('a frame a worker queued is sent again on load and on reconnecting, and not each time the picker opens', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row({ projectId: 'proj-1', syncState: 'queued' }))
  await store.putPendingFrame(row({ projectId: 'proj-2', syncState: 'failed' }))
  const net = wire(() => json({ error: 'boom' }, 500))
  const warn = mock.method(console, 'warn', () => {})
  try {
    await retryPendingFrames(store, net.env, 'picker')
    assert.deepEqual(net.calls, [FRAME_ROUTE('proj-2')], 'the picker: a failed frame, not a queued one: that is one more copy in the worker\'s queue each time')
    net.calls.length = 0
    await retryPendingFrames(store, net.env, 'load')
    assert.deepEqual(net.calls.sort(), [FRAME_ROUTE('proj-1'), FRAME_ROUTE('proj-2')])
    net.calls.length = 0
    await retryPendingFrames(store, net.env, 'online')
    assert.equal(net.calls.length, 2)
  } finally {
    warn.mock.restore()
  }
})

test('a retry that loses to another device is a change the picker should draw, and one that fails or queues is not', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row({ syncState: 'failed' }))
  assert.deepEqual(await retryPendingFrames(store, wire(() => conflict({ frame: F2, revision: 1 })).env), { changed: true })
  assert.equal((await store.getPendingFrame('proj-1'))?.syncState, 'conflict')
})

test('a frame the worker already replayed is saved by the retry, not a conflict', async () => {
  const { fake, store } = await opened()
  await store.putPendingFrame(row({ syncState: 'queued', expectedRevision: 0 }))
  // The server applied the worker's replay (revision 1, this frame). The retry names revision 0, and is answered 409 for the same frame.
  const net = wire(() => conflict({ frame: { ...F1 }, revision: 1 }))
  assert.deepEqual(await retryPendingFrames(store, net.env), { changed: true })
  assert.deepEqual(fake.rows(DB, 'pendingFrame'), [])
})

test('retries from the load, the online event and the picker are one send, not three', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row())
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const net = wire(async () => {
    await gate
    return saved(1, F1)
  })
  const first = retryPendingFrames(store, net.env)
  const second = retryPendingFrames(store, net.env)
  const third = retryPendingFrames(store, net.env)
  assert.equal(first, second, 'the same promise while one is running')
  await settle()
  release()
  await Promise.all([first, second, third])
  assert.equal(net.calls.length, 1)
  // And once it is over the next call runs again.
  await store.putPendingFrame(row({ frame: F2 }))
  await retryPendingFrames(store, wire(() => saved(2, F2)).env)
  assert.deepEqual(await store.listPendingFrames(), [])
})

test('an answer about an old frame does not touch the row of a newer calibration', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row())
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const net = wire(async () => {
    await gate
    return json({ error: 'boom' }, 500)
  })
  const warn = mock.method(console, 'warn', () => {})
  try {
    const retrying = retryPendingFrames(store, net.env)
    await settle()
    // While F1 is in flight the person calibrates again (another tab, which does not share this page's lock).
    await store.putPendingFrame(row({ frame: F2, syncState: 'pending' }))
    release()
    await retrying
    const kept = await store.getPendingFrame('proj-1')
    assert.equal(kept?.frame.createdAt, F2.createdAt)
    assert.equal(kept?.syncState, 'pending', 'F1\'s failure was not written onto it')
  } finally {
    warn.mock.restore()
  }
})

test('a late answer that a frame lost does not delete the photos of a newer calibration made in the meantime', async () => {
  const { store } = await opened()
  const record = (role: ReferencePhotoRole) => ({
    url: photoPath('proj-1', role),
    localKey: referencePhotoKey('proj-1', role),
    tapPoint: { x: 0.5, y: 0.5 },
    pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    capturedAt: '2026-11-16T09:59:00.000Z',
  })
  const withRecords = (f: ProjectSpatialFrame) => ({ ...f, referencePhotos: { landmark: record('landmark'), headingMarker: record('headingMarker') } }) as ProjectSpatialFrame
  const keep = (role: ReferencePhotoRole, bytes: string) =>
    store.putReferencePhoto({ localKey: referencePhotoKey('proj-1', role), projectId: 'proj-1', role, blob: new Blob([bytes]), thumbDataUrl: '', capturedAt: 'x' })

  // F1 is on the wire, with its photos stored under the Place's keys.
  await store.putPendingFrame(row({ frame: withRecords(F1), photos: ['landmark', 'headingMarker'], syncState: 'failed' }))
  await keep('landmark', 'F1 landmark')
  await keep('headingMarker', 'F1 heading')
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const net = wire(async () => {
    await gate
    return conflict({ frame: F0, revision: 1 })
  })
  const retrying = retryPendingFrames(store, net.env)
  await settle()
  // Meanwhile another tab calibrates the same Place: its row, and its photos in place of the stored ones.
  await store.putPendingFrame(row({ frame: withRecords(F2), photos: ['landmark', 'headingMarker'], syncState: 'pending' }))
  await keep('landmark', 'F2 landmark')
  await keep('headingMarker', 'F2 heading')
  release()
  await retrying

  assert.equal(await (await store.getReferencePhoto(referencePhotoKey('proj-1', 'landmark')))?.blob.text(), 'F2 landmark', 'the newer calibration\'s photos are still there')
  assert.equal(await (await store.getReferencePhoto(referencePhotoKey('proj-1', 'headingMarker')))?.blob.text(), 'F2 heading')
  const kept = await store.getPendingFrame('proj-1')
  assert.equal(kept?.frame.createdAt, F2.createdAt)
  assert.equal(kept?.syncState, 'pending', 'and so is its row, as it was')
  assert.deepEqual(kept?.photos, ['landmark', 'headingMarker'])
})

test('a retry with no store, or a store that cannot be read, does nothing and does not throw', async () => {
  assert.deepEqual(await retryPendingFrames(null, wire(() => saved(1, F1)).env), { changed: false })
  const warn = mock.method(console, 'warn', () => {})
  try {
    assert.deepEqual(await retryPendingFrames(brokenStore(), wire(() => saved(1, F1)).env), { changed: false })
  } finally {
    warn.mock.restore()
  }
})

// ── Which Place the scanner starts on ────────────────────────────────────────────────────────────

const selection = (projectId: string | null) => JSON.stringify({ projectId, areaId: null })
const ok = (...places: Project[]) => ({ ok: true, places })
const FAILED_LIST = { ok: false, places: [] }
const resolve_ = async (
  store: FrameStore | null,
  list: { ok: boolean; places: Project[] },
  extra: { queryProject?: string | null; storedSelection?: string | null } = {},
) => {
  const chosen: string[] = []
  const result = await resolveInitialPlace({
    store,
    list,
    queryProject: extra.queryProject ?? null,
    storedSelection: extra.storedSelection ?? null,
    onQueryChoice: (projectId) => chosen.push(projectId),
  })
  return { result, chosen }
}

test('a list that succeeded without the Place does not bring the Place back from the mirror', async () => {
  const { store } = await opened()
  // Merged away or deleted on the server, still in this phone's mirror.
  await store.updateProject(place('proj-gone', { spatialFrame: F1, spatialFrameRevision: 2 }))
  const { result } = await resolve_(store, ok(place('proj-other')), { storedSelection: selection('proj-gone') })
  assert.equal(result, null, 'the person chooses again, rather than scanning into a Place that is not there')
  const empty = await resolve_(store, ok(), { storedSelection: selection('proj-gone') })
  assert.equal(empty.result, null, 'an empty list that succeeded is still a list')
})

test('a list that failed is the one case the mirror stands in for the Place', async () => {
  const { store } = await opened()
  await store.updateProject(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 2 }))
  const { result } = await resolve_(store, FAILED_LIST, { storedSelection: selection('proj-1') })
  assert.equal(result?.projectId, 'proj-1')
  assert.equal(result?.spatialFrame?.createdAt, F1.createdAt)
  assert.equal((await resolve_(store, FAILED_LIST, { storedSelection: selection('proj-unknown') })).result, null, 'a Place the mirror never held is none')
})

test('a failed list is told from a list that succeeded empty', async () => {
  const cases: Array<[string, () => Response | Promise<Response>, boolean]> = [
    ['an empty list', () => json([]), true],
    ['a list', () => json([place('proj-1')]), true],
    ['a 500', () => json({ error: 'x' }, 500), false],
    ['a 401', () => json({ error: 'x' }, 401), false],
    ['not a list', () => json({ projects: [] }), false],
    ['a queued 202', () => queuedReply(), false],
    ['a 202 the worker queued, whatever it carries', () => json([], 202, { [QUEUED_OFFLINE_HEADER]: '1' }), false],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), false],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), false],
  ]
  for (const [what, reply, listed] of cases) {
    assert.equal((await fetchPlaceList(wire(reply).env)).ok, listed, what)
  }
  assert.deepEqual((await fetchPlaceList(wire(() => json([place('proj-1')])).env)).places.map((p) => p.projectId), ['proj-1'])
})

test('the copy with the higher frame revision supplies the frame, and the server\'s copy wins a tie', async () => {
  const { store } = await opened()
  await store.updateProject(place('proj-1', { spatialFrame: F2, spatialFrameRevision: 3 }))

  const behind = await resolve_(store, ok(place('proj-1', { name: 'server name', spatialFrame: F0, spatialFrameRevision: 1 })), { storedSelection: selection('proj-1') })
  assert.equal(behind.result?.name, 'server name', 'the rest of the Place is the server\'s')
  assert.equal(behind.result?.spatialFrame?.createdAt, F2.createdAt, 'the frame is the mirror\'s: it is the newer')
  assert.equal(behind.result?.spatialFrameRevision, 3)

  const tie = await resolve_(store, ok(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 3 })), { storedSelection: selection('proj-1') })
  assert.equal(tie.result?.spatialFrame?.createdAt, F1.createdAt, 'equal revisions: the server')

  const ahead = await resolve_(store, ok(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 5 })), { storedSelection: selection('proj-1') })
  assert.equal(ahead.result?.spatialFrame?.createdAt, F1.createdAt)
  assert.equal(ahead.result?.spatialFrameRevision, 5)

  const bare = await resolve_(store, ok(place('proj-1')), { storedSelection: selection('proj-1') })
  assert.equal(bare.result?.spatialFrame?.createdAt, F2.createdAt, 'a server copy with no frame (a stale list) does not erase the mirror\'s')
})

test('a frame waiting to be sent stands for the Place\'s while the Place is at the revision it was made against', async () => {
  const { store } = await opened()
  await store.putPendingFrame(row({ frame: F1, syncState: 'queued', expectedRevision: 0 }))
  const { result } = await resolve_(store, ok(place('proj-1')), { storedSelection: selection('proj-1') })
  assert.equal(result?.spatialFrame?.createdAt, F1.createdAt, 'so a person who calibrated offline is not asked to again')
  assert.equal(result?.spatialFrameRevision, undefined, 'at the revision the server last gave: none')

  const offline = await resolve_(store, FAILED_LIST, { storedSelection: selection('proj-1') })
  assert.equal(offline.result, null, 'with no mirror and no list there is no Place to stand it on')
  await store.updateProject(place('proj-1'))
  const mirrored = await resolve_(store, FAILED_LIST, { storedSelection: selection('proj-1') })
  assert.equal(mirrored.result?.spatialFrame?.createdAt, F1.createdAt, 'and from the mirror it stands too')

  // Another device saved since: this frame can only lose, and the Place is the server's.
  const past = await resolve_(store, ok(place('proj-1', { spatialFrame: F2, spatialFrameRevision: 2 })), { storedSelection: selection('proj-1') })
  assert.equal(past.result?.spatialFrame?.createdAt, F2.createdAt, 'the person calibrates against the frame the server holds, not one it is about to refuse')
  assert.equal(past.result?.spatialFrameRevision, 2)

  // The server already holds the frame (the worker replayed it): the Place is the server's, which is the same.
  const replayed = await resolve_(store, ok(place('proj-1', { spatialFrame: F1, spatialFrameRevision: 1 })), { storedSelection: selection('proj-1') })
  assert.equal(replayed.result?.spatialFrameRevision, 1)
})

test('a frame that lost to another device, that the server refused, or that the server holds, does not stand for the Place\'s', async () => {
  const { store } = await opened()
  for (const waiting of [row({ syncState: 'conflict' }), row({ syncState: 'failed', permanent: true }), row({ syncState: 'photos', photos: ['landmark'] })]) {
    await store.putPendingFrame(waiting)
    const { result } = await resolve_(store, ok(place('proj-1', { spatialFrame: F0, spatialFrameRevision: 0 })), { storedSelection: selection('proj-1') })
    assert.equal(result?.spatialFrame?.createdAt, F0.createdAt, waiting.syncState)
  }
  assert.deepEqual([...unsyncedPlaceIds(await store.listPendingFrames())], [], 'and the picker does not mark a Place for a frame that is no longer on its way')
})

test('the picker marks a Place for a frame that is waiting, queued, or failed in a way a retry may fix', () => {
  const rows = [
    row({ projectId: 'proj-a', syncState: 'pending' }),
    row({ projectId: 'proj-b', syncState: 'queued' }),
    row({ projectId: 'proj-c', syncState: 'failed' }),
    row({ projectId: 'proj-d', syncState: 'conflict' }),
    row({ projectId: 'proj-e', syncState: 'failed', permanent: true }),
    row({ projectId: 'proj-f', syncState: 'photos' }),
  ]
  assert.deepEqual([...unsyncedPlaceIds(rows)].sort(), ['proj-a', 'proj-b', 'proj-c'])
})

test('the query parameter wins, and is remembered; a null selection and a bad one are no Place', async () => {
  const { store } = await opened()
  const list = ok(place('proj-1'), place('proj-2'))
  const query = await resolve_(store, list, { queryProject: 'proj-2', storedSelection: selection('proj-1') })
  assert.equal(query.result?.projectId, 'proj-2')
  assert.deepEqual(query.chosen, ['proj-2'])
  const unknown = await resolve_(store, list, { queryProject: 'proj-9', storedSelection: selection('proj-1') })
  assert.equal(unknown.result?.projectId, 'proj-1', 'a query that names no listed Place falls through to the stored choice')
  assert.deepEqual(unknown.chosen, [])
  assert.equal((await resolve_(store, list, { storedSelection: selection(null) })).result, null, 'the person chose no Place')
  assert.equal((await resolve_(store, list, { storedSelection: '{not json' })).result, null)
  assert.equal((await resolve_(store, list, { storedSelection: '{}' })).result, null)
  assert.equal((await resolve_(store, list, {})).result, null, 'nothing is inferred from the first Place in the registry')
})

test('a store that cannot be read does not stop a Place being chosen from the list', async () => {
  const warn = mock.method(console, 'warn', () => {})
  try {
    const { result } = await resolve_(brokenStore(), ok(place('proj-1')), { storedSelection: selection('proj-1') })
    assert.equal(result?.projectId, 'proj-1')
    assert.equal((await resolve_(null, ok(place('proj-1')), { storedSelection: selection('proj-1') })).result?.projectId, 'proj-1')
  } finally {
    warn.mock.restore()
  }
})

test('withPendingFrame leaves a Place alone when no row names it', () => {
  const p = place('proj-1')
  assert.equal(withPendingFrame(p, []), p)
  assert.equal(withPendingFrame(p, [row({ projectId: 'proj-2' })]), p)
})

// ── Creating a Place or an Area ──────────────────────────────────────────────────────────────────

test('a queued 202 is not a Place: it is refused, though resp.ok is true for it', async () => {
  const created = await readCreatedPlace(queuedReply())
  assert.deepEqual(created, { ok: false, reason: 'needs-connection' })
})

test('only a body that is a Place with an id and floors is one', async () => {
  const good = place('proj-1')
  assert.deepEqual(await readCreatedPlace(json(good, 201)), { ok: true, place: good })
  const refused: Array<[string, Response]> = [
    ['a 500', json({ error: 'x' }, 500)],
    ['a 400', json({ error: 'name is required' }, 400)],
    ['a 200 with no projectId', json({ ok: true })],
    ['a projectId that is not text', json({ projectId: 5, floors: [] })],
    ['an empty projectId', json({ projectId: '', floors: [] })],
    ['no floors', json({ projectId: 'proj-1' })],
    ['a list', json([good])],
    ['a body that is not JSON', new Response('<html>', { status: 200 })],
  ]
  for (const [what, response] of refused) assert.deepEqual(await readCreatedPlace(response), { ok: false, reason: 'rejected' }, what)
})

test('a page asks the worker not to queue a write only where the worker could queue it', () => {
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const capacitorBefore = Object.getOwnPropertyDescriptor(globalThis, 'Capacitor')
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const withWorker = (controller: unknown) => Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { controller }, onLine: true }, configurable: true })
  try {
    withWorker({})
    assert.deepEqual(noQueueHeaders(), { [NO_QUEUE_HEADER]: '1' }, 'same origin, with a controlling worker')
    withWorker(null)
    assert.deepEqual(noQueueHeaders(), {}, 'no worker controls the page: nothing to opt out of')
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
    assert.deepEqual(noQueueHeaders(), {}, 'no service worker support at all')

    // A native shell talks to another origin, where a custom header needs a preflight, and has no worker to ask.
    withWorker({})
    Object.defineProperty(globalThis, 'Capacitor', { value: { isNativePlatform: () => true }, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => (key === SCAN_SERVER_KEY ? 'https://scan.example.ts.net' : null) }, configurable: true })
    assert.deepEqual(noQueueHeaders(), {}, 'another origin: not sent, even with a controller')
  } finally {
    for (const [name, before] of [['navigator', navigatorBefore], ['Capacitor', capacitorBefore], ['localStorage', storageBefore]] as const) {
      if (before) Object.defineProperty(globalThis, name, before)
      else delete (globalThis as Record<string, unknown>)[name]
    }
  }
})

test('the browser says it is online unless it knows it is not', () => {
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
    assert.equal(browserFrameSyncEnv().online(), false)
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
    assert.equal(browserFrameSyncEnv().online(), true)
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    assert.equal(browserFrameSyncEnv().online(), true, 'a browser that does not say is not offline')
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true })
    assert.equal(browserFrameSyncEnv().online(), true, 'and neither is a page with no navigator')
  } finally {
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore)
  }
})

// ── What the person is told ──────────────────────────────────────────────────────────────────────

test('the status after a calibration adds "Alignment not synced yet" for a frame that is waiting, and replaces itself for one that lost', () => {
  assert.equal(FRAME_NOT_SYNCED_TEXT, 'Alignment not synced yet')
  const outcome = '✓ Points about as far apart as stored\n• 3 cm off, direction not checked'
  for (const waiting of [{ status: 'queued' }, { status: 'failed', reason: 'x', permanent: false }, { status: 'failed', reason: 'x', permanent: true }] as const) {
    const text = frameSyncStatusText(outcome, waiting)
    assert.equal(text, `${outcome}\n• Alignment not synced yet`, waiting.status)
    assert.equal(frameSyncStatusText(text, waiting), text, 'said once')
  }
  assert.equal(frameSyncStatusText(outcome, { status: 'saved', revision: 1, frame: F1 }), outcome, 'a saved frame says nothing')
  assert.equal(frameSyncStatusText(outcome, null), outcome, 'no frame to save says nothing')
  // A lost race is not "not synced yet": it never will be, and the calibration's own outcome describes a frame the Place does not have.
  const lost = frameSyncStatusText(outcome, { status: 'conflict', current: { frame: F2, revision: 1 } })
  assert.equal(lost, FRAME_CONFLICT_TEXT)
  assert.equal(FRAME_CONFLICT_TEXT, '⚠ This Place already has a different alignment\n• Scans from here are not aligned to it')
  assert.doesNotMatch(lost, /not synced/)
  assert.doesNotMatch(lost, /Points about as far apart/)
})

test('the note is written over the calibration\'s own line, holds it as that does, and a saved frame writes nothing', () => {
  const node = () => ({ textContent: '✓ Points about as far apart as stored\n• 3 cm off, direction not checked' as string | null })
  const outcomeText = node().textContent
  for (const waiting of [{ status: 'queued' }, { status: 'failed', reason: 'x', permanent: false }] as const) {
    const el = node()
    showFrameSyncNote(el, waiting)
    assert.equal(el.textContent, `${outcomeText}\n• Alignment not synced yet`, waiting.status)
    assert.equal(statusIsHeld(el), true, 'it holds the line, as the outcome it follows does')
    showFrameSyncNote(el, waiting)
    assert.equal(el.textContent?.split('Alignment not synced yet').length, 2, 'said once')
  }
  const lost = node()
  showFrameSyncNote(lost, { status: 'conflict', current: { frame: F2, revision: 1 } })
  assert.equal(lost.textContent, FRAME_CONFLICT_TEXT, 'a lost race replaces the outcome')
  assert.equal(statusIsHeld(lost), true)
  const saved = node()
  showFrameSyncNote(saved, { status: 'saved', revision: 1, frame: F1 })
  showFrameSyncNote(saved, null)
  showFrameSyncNote(null, { status: 'queued' })
  assert.deepEqual(saved, node(), 'a saved frame says nothing')
  assert.equal(statusIsHeld(saved), false, 'and does not take hold of the line either')
  const el = { textContent: null as string | null }
  writeStatus(el, 'outcome', 'sticky')
  showFrameSyncNote(el, { status: 'queued' })
  assert.equal(el.textContent, 'outcome\n• Alignment not synced yet')
})

// ── The wiring in src/main.ts, read as text ──────────────────────────────────────────────────────

const mainSource = () => readFileSync(join(ROOT, 'src/main.ts'), 'utf8')

test('source shape: the calibration commit hands the frame to the sync module, and its status says when it is not saved', () => {
  const main = mainSource()
  // WP-08: a frame that replaces one the Place holds says which generation it replaces and why, so the call carries `replaces` too.
  assert.match(main, /frameSync = await persistProjectSpatialFrame\(projectStore, selectedProject, calibration\.spatialFrame, \{\n\s+photos: calibration\.referencePhotos,\n(?:\s+\/\/.*\n)*\s+replaces: calibration\.replaces,\n\s+\}\)/)
  assert.doesNotMatch(main, /await projectStore\.updateProject\(selectedProject\)/, 'the unguarded IndexedDB write that skipped the server is gone')
  assert.doesNotMatch(main, /async function persistProjectSpatialFrame/, 'the whole-record PUT of the Place is gone')
  assert.doesNotMatch(main, /async function storeReferencePhotos|async function uploadReferencePhoto/, 'photos are stored and uploaded by the sync module, after the frame is saved')
  const commit = main.indexOf('frameSync = await persistProjectSpatialFrame(')
  const note = main.indexOf('showFrameSyncNote(statusNode, frameSync)')
  // The stamped copy of the calibration (it carries the unit the session ran in), which the status line words (WP-04b).
  const outcomeWrite = main.indexOf("overlay.setStatus(alignmentStatusText(sessionCalibration), 'sticky')")
  assert.ok(commit > 0 && outcomeWrite > commit && note > outcomeWrite, 'the note follows the calibration outcome, which follows the send')
})

test('source shape: a waiting frame is sent when the page loads, when the connection comes back and when the picker opens', () => {
  const main = mainSource()
  assert.match(main, /if \(!readOnlyScanner\) \{\n\s+void retryPendingFrames\(projectStore, undefined, 'load'\)\n\s+globalThis\.addEventListener\('online', \(\) => void retryPendingFrames\(projectStore, undefined, 'online'\)\)/)
  assert.match(main, /void render\(\)\n\s+void retryPendingFrames\(projectStore, undefined, 'picker'\)\.then\(\(\{ changed \}\) => \{/)
})

test('source shape: what the server says about a frame reaches the Place the page works with, and a lost race stops the stamp', () => {
  const main = mainSource()
  assert.match(main, /onFrameSettled\(\(\{ projectId, outcome \}\) => \{\n\s+if \(selectedProject\?\.projectId !== projectId\) return\n\s+adoptFrameOutcome\(selectedProject, outcome\)\n\s+if \(outcome\.status !== 'conflict' \|\| !sessionCalibration\) return\n(?:\s+\/\/.*\n)?\s+sessionCalibration = undefined\n\s+if \(sessionScanEntry\) \{\n\s+sessionScanEntry\.calibration = undefined\n\s+void projectStore\.updateScan\(sessionScanEntry\)\.catch\(\(\) => \{\}\)\n\s+\}\n\s+overlay\.setStatus\(FRAME_CONFLICT_TEXT, 'sticky'\)/)
  const listener = main.indexOf('onFrameSettled(')
  const declared = main.indexOf('let sessionCalibration: ScanCalibration | undefined')
  const calibrationOpens = main.indexOf('const calibration = await runProjectCalibration({')
  const waitsForRetry = main.indexOf('await whenFramesSettled(projectStore)')
  assert.ok(declared > 0 && listener > declared, 'the listener is set up where the calibration it can cancel is declared')
  assert.ok(waitsForRetry > 0 && waitsForRetry < calibrationOpens, 'the calibration opens after the retry that is running has finished, or after the wait')
})

test('source shape: creating a Place or an Area asks not to be queued, reads the answer as a Place, and refuses a queued one in words', () => {
  const main = mainSource()
  assert.match(main, /headers: \{ 'Content-Type': 'application\/json', \.\.\.noQueueHeaders\(\) \},\n\s+body: JSON\.stringify\(\{ name, placeType, address, geoPose \}\),/)
  assert.match(main, /method: 'PUT', headers: \{ 'Content-Type': 'application\/json', \.\.\.noQueueHeaders\(\) \}, body: JSON\.stringify\(update\),/, 'the Area write too')
  assert.match(main, /const created = response \? await readCreatedPlace\(response\)/)
  assert.match(main, /const saved = response \? await readCreatedPlace\(response\)/)
  assert.match(main, /created\.reason === 'needs-connection' \? PLACE_NEEDS_CONNECTION/)
  assert.match(main, /saved\.reason === 'needs-connection' \? AREA_NEEDS_CONNECTION/)
  assert.equal(PLACE_NEEDS_CONNECTION, 'Creating a Place needs a connection')
})

test('source shape: the picker marks a Place whose frame is not saved, in its list and on the one that is selected, and draws the frame that stands for it', () => {
  const main = mainSource()
  assert.match(main, /const waiting = await projectStore\.listPendingFrames\(\)\.catch\(\(\) => \[\]\)/)
  assert.match(main, /const projects = listed\.map\(project => withPendingFrame\(project, waiting\)\)/)
  assert.match(main, /unsynced\.has\(project\.projectId\) \? ` · \$\{FRAME_NOT_SYNCED_TEXT\}` : ''/, 'the list row')
  assert.match(main, /unsynced\.has\(currentSelected\.projectId\) \? ` · \$\{FRAME_NOT_SYNCED_TEXT\}` : ''/, 'the selected Place')
})

test('source shape: the starting Place comes from the resolver, which is told whether the list succeeded, and a choice made by query is remembered', () => {
  const main = mainSource()
  assert.match(main, /return resolveInitialPlace\(\{\n\s+store: projectStore,\n\s+list: await fetchPlaceList\(\),/)
  assert.match(main, /onQueryChoice: \(projectId\) => sessionStorage\.setItem\(PLACE_SELECTION_SESSION_KEY, JSON\.stringify\(\{ projectId \}\)\),/)
})

test('the two refusals read as short sentences', () => {
  assert.equal(PLACE_NEEDS_CONNECTION, 'Creating a Place needs a connection')
  assert.equal(AREA_NEEDS_CONNECTION, 'Adding an Area needs a connection')
})
