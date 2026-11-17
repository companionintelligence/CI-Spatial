/**
 * The phone's copy of a Place (the `projects` store of `ci-xr-projects`, src/project/project-store.ts) and the three
 * fields S0 declared that only the server writes: `frameHistory`, `georeference` and `georefVersion`.
 *
 * `updateProject` has always refused to let a copy with a lower frame revision take the frame from the record it
 * replaces, because any copy of a Place may be written over the mirror and a copy read before a calibration is a
 * stale one (tests/unit/node/wp-place-frame-sync.test.ts holds that). The frame has companions the server writes in
 * the same step or counts on its own: the history of the frames it replaced, and the georeference with its version. A
 * guard that kept the frame and let the stale copy take the rest left the mirror with the newer frame beside the older
 * history, and a georeference moved back to a version the server had already passed. A later package that names
 * `georefVersion` in a write, or lists the history, reads it from this mirror.
 *
 * It runs the real store on the in-memory IndexedDB the sibling test uses.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs, and `npm run verify` runs it), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-s0-mirror-guard.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opened } from './support/fake-indexeddb.ts'
import type { FrameHistoryEntry, Project, ProjectGeoreference, ProjectSpatialFrame } from '../../../src/world/types.ts'

const frame = (createdAt: string): ProjectSpatialFrame => ({
  version: 1,
  createdAt,
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 2 },
  separationM: 2,
  toleranceM: 0.15,
  anchorBearingDeg: null,
})
const F1 = frame('2026-11-17T08:00:00.000Z')
const F2 = frame('2026-11-17T09:00:00.000Z')
const F3 = frame('2026-11-17T10:00:00.000Z')

const entry = (frameId: string | null, createdAt: string, reason: FrameHistoryEntry['reason']): FrameHistoryEntry => ({
  frameId,
  createdAt,
  method: 'two-point-ground',
  separationM: 2,
  supersededAt: '2026-11-17T09:00:00.000Z',
  reason,
})
const H1 = entry(null, '2026-11-17T08:00:00.000Z', 'override')
const H2 = entry('gen-2', '2026-11-17T09:00:00.000Z', 'upgrade')

const georef = (bearingDeg: number): ProjectGeoreference => ({
  origin: { lat: 51.5, lng: -0.12, altitudeM: null, accuracyM: 3.5 },
  heightDatum: 'unknown',
  bearingDeg,
  bearingAccuracyDeg: 1,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  registeredAt: '2026-11-17T08:00:00.000Z',
  anchorRef: null,
})

const place = (extra: Partial<Project> = {}): Project => ({ projectId: 'proj-1', name: 'Room', createdAt: 1, updatedAt: 2, floors: [], ...extra })

/** The Place the server answered, as the phone mirrors it: its own answer, which the guard takes whole. */
const SERVER_ANSWER = (): Project =>
  place({ spatialFrame: F2, spatialFrameRevision: 2, frameHistory: [H1], georeference: georef(90), georefVersion: 2 })

test('a stale copy cannot take the frame history away from the frame it leaves in place', async () => {
  const { store } = await opened()
  await store.updateProject(SERVER_ANSWER(), { authoritative: true })

  // Read before the second calibration, written by a tab that has had the page open since.
  await store.updateProject(place({ name: 'Renamed in a stale tab', spatialFrame: F1, spatialFrameRevision: 1 }))
  const kept = (await store.getProject('proj-1'))!
  assert.equal(kept.name, 'Renamed in a stale tab', 'everything else is the incoming copy\'s')
  assert.equal(kept.spatialFrameRevision, 2, 'the frame guard holds, as it always did')
  assert.deepEqual(kept.frameHistory, [H1], 'and the history of the frames it replaced stays with it')
})

test('a copy that is behind on the history because it never saw a frame does not erase it either', async () => {
  const { store } = await opened()
  await store.updateProject(SERVER_ANSWER(), { authoritative: true })
  await store.updateProject(place({ name: 'A copy that never saw a frame', frameHistory: [] }))
  const kept = (await store.getProject('proj-1'))!
  assert.deepEqual(kept.frameHistory, [H1])
  assert.equal(kept.spatialFrame?.createdAt, F2.createdAt)
})

test('a stale copy cannot move the georeference back to a version the server has passed', async () => {
  const { store } = await opened()
  await store.updateProject(SERVER_ANSWER(), { authoritative: true })

  await store.updateProject(place({ name: 'stale', spatialFrame: F2, spatialFrameRevision: 2, frameHistory: [H1], georeference: georef(45), georefVersion: 1 }))
  const kept = (await store.getProject('proj-1'))!
  assert.equal(kept.georefVersion, 2)
  assert.equal(kept.georeference?.bearingDeg, 90, 'the newer registration stays')
  assert.equal(kept.name, 'stale', 'and the rest is the incoming copy\'s')

  // A copy that never saw a registration at all.
  await store.updateProject(place({ name: 'never saw one', spatialFrame: F2, spatialFrameRevision: 2, frameHistory: [H1] }))
  const still = (await store.getProject('proj-1'))!
  assert.equal(still.georefVersion, 2)
  assert.equal(still.georeference?.bearingDeg, 90)
})

test('the frame and the georeference are counted apart: a copy behind on one is not held to the other', async () => {
  const { store } = await opened()
  await store.updateProject(SERVER_ANSWER(), { authoritative: true })

  // Newer georeference (3), older frame (1): the georeference is taken, the frame and its history are kept.
  await store.updateProject(place({ spatialFrame: F1, spatialFrameRevision: 1, georeference: georef(120), georefVersion: 3 }))
  const a = (await store.getProject('proj-1'))!
  assert.equal(a.georefVersion, 3)
  assert.equal(a.georeference?.bearingDeg, 120)
  assert.equal(a.spatialFrameRevision, 2)
  assert.deepEqual(a.frameHistory, [H1])

  // Newer frame (3), older georeference (1): the frame and its history are taken, the georeference is kept.
  await store.updateProject(place({ spatialFrame: F3, spatialFrameRevision: 3, frameHistory: [H1, H2], georeference: georef(10), georefVersion: 1 }))
  const b = (await store.getProject('proj-1'))!
  assert.equal(b.spatialFrameRevision, 3)
  assert.equal(b.spatialFrame?.createdAt, F3.createdAt)
  assert.deepEqual(b.frameHistory, [H1, H2])
  assert.equal(b.georefVersion, 3)
  assert.equal(b.georeference?.bearingDeg, 120)
})

test('a copy at the same revision and version is the incoming one, history and georeference included', async () => {
  const { store } = await opened()
  await store.updateProject(SERVER_ANSWER(), { authoritative: true })
  await store.updateProject(place({ spatialFrame: F2, spatialFrameRevision: 2, frameHistory: [H1, H2], georeference: georef(91), georefVersion: 2 }))
  const kept = (await store.getProject('proj-1'))!
  assert.deepEqual(kept.frameHistory, [H1, H2])
  assert.equal(kept.georeference?.bearingDeg, 91)
})

test('the server\'s own answer is written whatever it carries, lower versions and a lost history included', async () => {
  const { store } = await opened()
  await store.updateProject(
    place({ spatialFrame: F3, spatialFrameRevision: 5, frameHistory: [H1, H2], georeference: georef(200), georefVersion: 4 }),
    { authoritative: true },
  )
  // The registry was restored from a backup: it holds an earlier frame, no history, and an earlier registration.
  await store.updateProject(
    place({ spatialFrame: F1, spatialFrameRevision: 1, georeference: georef(15), georefVersion: 1 }),
    { authoritative: true },
  )
  const written = (await store.getProject('proj-1'))!
  assert.equal(written.spatialFrameRevision, 1)
  assert.equal('frameHistory' in written, false, 'the server holds none, so the phone holds none')
  assert.equal(written.georefVersion, 1)
  assert.equal(written.georeference?.bearingDeg, 15)
  // And the default guard protects that record again from the next stale copy.
  await store.updateProject(place({ name: 'stale', georefVersion: 0 }))
  assert.equal((await store.getProject('proj-1'))?.georefVersion, 1)
})

test('a Place with none of the three fields is written exactly as it was before S0: no key appears', async () => {
  const { store } = await opened()
  await store.updateProject(place({ spatialFrame: F2, spatialFrameRevision: 2 }), { authoritative: true })
  await store.updateProject(place({ name: 'Renamed in a stale tab', spatialFrame: F1, spatialFrameRevision: 1 }))
  const kept = (await store.getProject('proj-1'))!
  assert.deepEqual(
    Object.keys(kept).sort(),
    ['createdAt', 'floors', 'name', 'projectId', 'spatialFrame', 'spatialFrameRevision', 'updatedAt'],
  )
  assert.equal(kept.spatialFrameRevision, 2)

  await store.updateProject(place({ projectId: 'proj-2' }))
  await store.updateProject(place({ projectId: 'proj-2', name: 'again' }))
  assert.deepEqual(Object.keys((await store.getProject('proj-2'))!).sort(), ['createdAt', 'floors', 'name', 'projectId', 'updatedAt'])
})

test('a version that is not a whole number of at least 1 reads as none, so it cannot hold a registration in place', async () => {
  const { store } = await opened()
  await store.updateProject(place({ georeference: georef(30), georefVersion: Number.NaN }), { authoritative: true })
  await store.updateProject(place({ name: 'next', georeference: georef(40), georefVersion: 1 }))
  const kept = (await store.getProject('proj-1'))!
  assert.equal(kept.georefVersion, 1, 'a version of NaN is no version: the copy with version 1 is newer')
  assert.equal(kept.georeference?.bearingDeg, 40)

  await store.updateProject(place({ georeference: georef(50), georefVersion: 2.5 }), { authoritative: true })
  await store.updateProject(place({ name: 'after a fraction', georeference: georef(60), georefVersion: 1 }))
  assert.equal((await store.getProject('proj-1'))?.georeference?.bearingDeg, 60, 'nor does 2.5 hold anything against version 1')

  // And the other way round: a copy whose version is not a count is behind a record that has one, and is not newer for it.
  await store.updateProject(place({ georeference: georef(70), georefVersion: 3 }), { authoritative: true })
  await store.updateProject(place({ name: 'a copy with a broken version', georeference: georef(99), georefVersion: Number.NaN }))
  const behind = (await store.getProject('proj-1'))!
  assert.equal(behind.georefVersion, 3)
  assert.equal(behind.georeference?.bearingDeg, 70)
  assert.equal(behind.name, 'a copy with a broken version')
})
