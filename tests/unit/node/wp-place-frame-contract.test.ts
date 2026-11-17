/**
 * The phone's frame code (src/project/frame-sync.ts, src/project/project-store.ts) against the real server
 * (server/main.ts), over HTTP.
 *
 * tests/unit/node/wp-place-frame-sync.test.ts scripts the server's answers by hand, and
 * tests/unit/deno/place_frame_route.test.ts never runs the client, so neither can say that the two halves agree
 * about what is on the wire. This file runs both for real: the server is spawned on a free port with every
 * directory it writes in a temp folder, the phone's IndexedDB is the in-memory one the unit tests use
 * (./support/fake-indexeddb.ts), and the network is `fetch`.
 *
 * What it pins is what a person can see go wrong when two phones, or one phone and its own earlier calibration,
 * meet at the server:
 *  - a calibration saved offline is sent when the phone is back, and the Place the page is working with then names
 *    the revision the server holds, so a later "Use anyway" is not refused as a conflict with the phone's own frame;
 *  - a frame that was made against a Place another phone has since calibrated is refused, the page is told, and it
 *    works against the frame the server holds;
 *  - the phone that loses a race does not replace the photos of the one that won;
 *  - two calibrations made on one phone while it was offline leave the newer one as the Place's frame;
 *  - a registry the operator restored from a backup does not strand a phone on a frame the server no longer has;
 *  - this phone's own frame, saved a moment earlier in another form, is not a conflict with itself.
 *
 * Needs `deno` on the PATH. Without it the tests are skipped, and the Deno suite (`deno task test`) still runs the
 * server half. No fixed port is bound: the server listens on port 0.
 *
 * Run: npm run test:wave (the `wp-` prefix is what that script globs), or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-place-frame-contract.test.ts
 */
import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectStore, type PendingFrameRecord } from '../../../src/project/project-store.ts'
import {
  adoptFrameOutcome,
  fetchPlaceList,
  onFrameSettled,
  persistProjectSpatialFrame,
  resolveInitialPlace,
  retryPendingFrames,
  unsyncedPlaceIds,
  type FrameSyncEnv,
} from '../../../src/project/frame-sync.ts'
import { install } from './support/fake-indexeddb.ts'
import type { PendingReferencePhoto } from '../../../src/ar/reference-photo.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DENO = process.env['DENO_BIN'] ?? 'deno'
const hasDeno = spawnSync(DENO, ['--version'], { stdio: 'ignore' }).status === 0
const skip = hasDeno ? false : 'deno is not on the PATH'

// ── The real server ──────────────────────────────────────────────────────────────────────────────

let child: ChildProcess | null = null
let root = ''
let base = ''

before(async () => {
  if (!hasDeno) return
  root = mkdtempSync(join(tmpdir(), 'wp-frame-contract-'))
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    PORT: '0',
    SCANS_DIR: `${root}/scans`,
    WORLDS_DIR: `${root}/worlds`,
    SUMMARIES_DIR: `${root}/summaries`,
    PROJECTS_FILE: `${root}/projects.json`,
    STATIC_DIR: `${root}/no-static-bundle`,
    INFERENCE_MODE: 'mock',
    TAILSCALE_HOSTNAME: 'scan.test',
  }
  for (const name of ['DENO_DIR', 'XDG_CACHE_HOME', 'TMPDIR', 'SSL_CERT_FILE']) if (process.env[name]) env[name] = process.env[name]!
  child = spawn(
    DENO,
    ['run', '--no-prompt', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run', join(ROOT, 'server/main.ts')],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  const port = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the server did not start\n${output.slice(-2000)}`)), 90_000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /Listening on https?:\/\/[^:\s/]+:(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        done(Number(match[1]))
      }
    }
    child!.stdout!.on('data', read)
    child!.stderr!.on('data', read)
    child!.on('exit', (code) => fail(new Error(`the server exited with ${code}\n${output.slice(-2000)}`)))
  })
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  if (child) {
    child.kill('SIGTERM')
    await new Promise((done) => child!.once('exit', done))
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The phone's side of the wire: the real `fetch`, the server's address, and a switch for the link. */
interface Link {
  env: FrameSyncEnv
  up: boolean
}

function link(): Link {
  const state: Link = {
    up: true,
    env: {
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        if (!state.up) throw new TypeError('Failed to fetch')
        return await fetch(input, init)
      }) as typeof fetch,
      url: (path) => base + path,
      now: () => Date.now(),
      online: () => state.up,
    },
  }
  return state
}

async function openStore(): Promise<ProjectStore> {
  const store = new ProjectStore()
  await store.open()
  return store
}

async function createPlace(): Promise<Project> {
  // Ids are `proj-<epoch ms>`, so two creates in one millisecond would be one Place.
  await new Promise((done) => setTimeout(done, 3))
  const made = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Contract test place', placeType: 'room' }),
  })
  assert.equal(made.status, 201)
  return await made.json() as Project
}

async function serverPlace(projectId: string): Promise<Project> {
  return await (await fetch(`${base}/projects/${projectId}`)).json() as Project
}

function frame(createdAt: string, separationM: number): ProjectSpatialFrame {
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

const F1 = frame('2026-11-16T09:00:00.000Z', 3)
const F2 = frame('2026-11-16T10:00:00.000Z', 4)
const F3 = frame('2026-11-16T11:00:00.000Z', 5)

const captured = (role: 'landmark' | 'headingMarker', bytes: string, tap: { x: number; y: number }): PendingReferencePhoto => ({
  role,
  blob: new Blob([bytes], { type: 'image/jpeg' }),
  thumbDataUrl: 'data:image/jpeg;base64,AAAA',
  tapPoint: tap,
  pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T09:59:00.000Z',
  label: null,
})
const photosOf = (who: string, tap: { x: number; y: number }) => [captured('landmark', `${who}-landmark`, tap), captured('headingMarker', `${who}-heading`, tap)]

const served = async (projectId: string, role: 'landmark' | 'headingMarker') =>
  await (await fetch(`${base}/projects/${projectId}/reference-photos/ref-${role}.jpg`)).text()

/** The page as main.ts starts it: resolve the Place, then retry in the background, with the listener that gives the page's Place the answers. */
async function startPage(store: ProjectStore, net: Link, projectId: string) {
  const list = await fetchPlaceList(net.env)
  const place = await resolveInitialPlace({
    store,
    list,
    queryProject: projectId,
    storedSelection: null,
    onQueryChoice: () => {},
    env: net.env,
  })
  assert.ok(place, 'the Place is listed')
  const heard: string[] = []
  const stop = onFrameSettled(({ projectId: id, outcome }) => {
    if (place.projectId !== id) return
    heard.push(outcome.status)
    adoptFrameOutcome(place, outcome)
  })
  return { place, heard, stop }
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────────

test('a calibration saved offline reaches the server when the phone is back, and a "Use anyway" after it is not refused as a conflict with the phone\'s own frame', { skip }, async () => {
  install()
  const store = await openStore()
  const net = link()
  const created = await createPlace()

  // Visit 1, in the basement: the calibration cannot be sent, and waits on the phone.
  net.up = false
  const warn = mock.method(console, 'warn', () => {})
  try {
    const offline = await persistProjectSpatialFrame(store, { ...created }, F2, {}, net.env)
    assert.equal(offline.status, 'failed')
  } finally {
    warn.mock.restore()
  }

  // Visit 2, with a connection: the page starts on the frame that waits, and the retry saves it.
  net.up = true
  const page = await startPage(store, net, created.projectId)
  try {
    assert.equal(page.place.spatialFrame?.createdAt, F2.createdAt, 'the person is not asked to calibrate again')
    assert.deepEqual(await retryPendingFrames(store, net.env, 'load'), { changed: true })
    assert.equal((await serverPlace(created.projectId)).spatialFrameRevision, 1)
    assert.equal(page.place.spatialFrameRevision, 1, 'the page\'s Place was told which revision the retry saved')

    // The pair they re-tapped does not match, and they choose "Use anyway".
    const override = await persistProjectSpatialFrame(store, page.place, F3, {}, net.env)
    assert.equal(override.status, 'saved', 'the override replaces the phone\'s own frame')
    const held = await serverPlace(created.projectId)
    assert.equal(held.spatialFrame?.createdAt, F3.createdAt)
    assert.equal(held.spatialFrameRevision, 2)
    assert.deepEqual(page.heard, ['saved', 'saved'])
  } finally {
    page.stop()
  }
})

test('a frame made against a Place another phone has calibrated since is refused, and the page works against the frame the server holds', { skip }, async () => {
  install()
  const store = await openStore()
  const net = link()
  const created = await createPlace()

  net.up = false
  const warn = mock.method(console, 'warn', () => {})
  try {
    await persistProjectSpatialFrame(store, { ...created }, F2, {}, net.env)
  } finally {
    warn.mock.restore()
  }
  net.up = true
  // Phone A saves its frame while this phone is still in the basement.
  const other = await persistProjectSpatialFrame(null, { ...created }, F1, {}, net.env)
  assert.equal(other.status, 'saved')

  const page = await startPage(store, net, created.projectId)
  try {
    assert.equal(page.place.spatialFrame?.createdAt, F1.createdAt, 'the page starts on the frame the server holds: the waiting one can only lose')
    assert.deepEqual(await retryPendingFrames(store, net.env, 'load'), { changed: true })
    assert.deepEqual(page.heard, ['conflict'])
    assert.equal(page.place.spatialFrame?.createdAt, F1.createdAt)
    assert.equal(page.place.spatialFrameRevision, 1)
    const rows = await store.listPendingFrames()
    assert.equal(rows[0]?.syncState, 'conflict')
    assert.deepEqual([...unsyncedPlaceIds(rows)], [], 'a frame that will never sync is not offered as one that has not yet')
    assert.deepEqual(await retryPendingFrames(store, net.env, 'load'), { changed: false }, 'and it is not sent again')
  } finally {
    page.stop()
  }
})

test('the phone that loses a race does not replace the photos of the one that won, and keeps no copy of its own against the winner\'s frame', { skip }, async () => {
  const storeA = await (async () => { install(); return openStore() })()
  const storeB = await (async () => { install(); return openStore() })()
  const net = link()
  const created = await createPlace()
  const id = created.projectId

  // Both phones read the Place with no frame. A calibrates and its photos go up after its frame is saved.
  const a = await persistProjectSpatialFrame(storeA, { ...created }, F1, { photos: photosOf('A', { x: 0.2, y: 0.2 }) }, net.env)
  assert.equal(a.status, 'saved')
  // B calibrates the same Place from the copy it read before A saved.
  const b = await persistProjectSpatialFrame(storeB, { ...created }, F2, { photos: photosOf('B', { x: 0.8, y: 0.8 }) }, net.env)
  assert.equal(b.status, 'conflict')

  assert.equal(await served(id, 'landmark'), 'A-landmark', 'the winner\'s photo is still the one served')
  assert.equal(await served(id, 'headingMarker'), 'A-heading')
  const held = await serverPlace(id)
  assert.equal(held.spatialFrame?.createdAt, F1.createdAt)
  const photo = (held.spatialFrame as { referencePhotos?: { landmark: { tapPoint: { x: number } } } }).referencePhotos?.landmark
  assert.equal(photo?.tapPoint.x, 0.2, 'and the frame still points the crosshair at the spot that photo shows')
  assert.deepEqual(await storeB.listReferencePhotos(id), [], 'B kept no copy that its own picker would draw against A\'s frame')
})

test('a calibration made offline uploads its photos after its frame, once the phone is back', { skip }, async () => {
  install()
  const store = await openStore()
  const net = link()
  const created = await createPlace()
  const id = created.projectId

  net.up = false
  const warn = mock.method(console, 'warn', () => {})
  try {
    const offline = await persistProjectSpatialFrame(store, { ...created }, F1, { photos: photosOf('C', { x: 0.4, y: 0.4 }) }, net.env)
    assert.equal(offline.status, 'failed')
  } finally {
    warn.mock.restore()
  }
  assert.equal((await fetch(`${base}/projects/${id}/reference-photos/ref-landmark.jpg`)).status, 404, 'nothing has gone up')

  net.up = true
  assert.deepEqual(await retryPendingFrames(store, net.env, 'online'), { changed: true })
  assert.equal(await served(id, 'landmark'), 'C-landmark')
  assert.equal(await served(id, 'headingMarker'), 'C-heading')
  const held = await serverPlace(id)
  const photos = (held.spatialFrame as { referencePhotos?: Record<string, { url: string }> }).referencePhotos
  assert.equal(photos?.['landmark']?.url, `/projects/${id}/reference-photos/ref-landmark.jpg`, 'the frame points at the path that now answers')
  assert.deepEqual(await store.listPendingFrames(), [], 'and nothing is left waiting')
})

test('two calibrations made on one phone while it was offline leave the newer one as the Place\'s frame', { skip }, async () => {
  install()
  const store = await openStore()
  const net = link()
  const created = await createPlace()

  net.up = false
  const warn = mock.method(console, 'warn', () => {})
  try {
    const place = { ...created }
    await persistProjectSpatialFrame(store, place, F2, {}, net.env)
    // The page was reloaded offline and the person overrode their own frame: the same Place, a newer calibration.
    await persistProjectSpatialFrame(store, place, F3, {}, net.env)
  } finally {
    warn.mock.restore()
  }
  const rows = await store.listPendingFrames()
  assert.deepEqual(rows.map((row: PendingFrameRecord) => row.frame.createdAt), [F3.createdAt], 'one row: the newest')

  net.up = true
  await retryPendingFrames(store, net.env, 'online')
  const held = await serverPlace(created.projectId)
  assert.equal(held.spatialFrame?.createdAt, F3.createdAt, 'the older one never reached the server, so it cannot win')
  assert.equal(held.spatialFrameRevision, 1)
})

test('this phone\'s own frame, saved a moment earlier in another form, is not a conflict with itself', { skip }, async () => {
  install()
  const store = await openStore()
  const net = link()
  const created = await createPlace()
  const id = created.projectId

  // Another tab's retry sent the row before the photo records were on it.
  const early = await persistProjectSpatialFrame(null, { ...created }, F1, {}, net.env)
  assert.equal(early.status, 'saved')

  // This tab calibrated against the same Place at revision 0, and its frame has photos.
  const page = { ...created }
  const outcome = await persistProjectSpatialFrame(store, page, F1, { photos: photosOf('D', { x: 0.3, y: 0.3 }) }, net.env)
  assert.equal(outcome.status, 'saved')
  const held = await serverPlace(id)
  assert.equal(held.spatialFrameRevision, 2)
  assert.ok((held.spatialFrame as { referencePhotos?: unknown }).referencePhotos, 'the frame the server holds has the photo records')
  assert.equal(await served(id, 'landmark'), 'D-landmark')
  assert.deepEqual(await store.listPendingFrames(), [])
})

test('a registry restored from a backup does not strand the phone on a frame the server no longer has', { skip }, async () => {
  install()
  const store = await openStore()
  const net = link()
  const created = await createPlace()
  const id = created.projectId

  const place = { ...created }
  for (const [n, f] of [F1, F2, F3].entries()) {
    const outcome = await persistProjectSpatialFrame(store, place, f, {}, net.env)
    assert.equal(outcome.status, 'saved', `save ${n + 1}`)
  }
  assert.equal(place.spatialFrameRevision, 3)

  // The operator puts back the file as it was after the first save.
  const file = `${root}/projects.json`
  const registry = JSON.parse(readFileSync(file, 'utf8')) as Project[]
  const held = registry.find((candidate) => candidate.projectId === id)!
  held.spatialFrame = F1
  held.spatialFrameRevision = 1
  writeFileSync(file, JSON.stringify(registry))
  // The server reads the registry on every request, so it now holds revision 1.
  assert.equal((await serverPlace(id)).spatialFrameRevision, 1)

  // The phone's mirror still says revision 3. The person overrides, and is told what the server holds.
  const page = await startPage(store, net, id)
  try {
    const override = await persistProjectSpatialFrame(store, page.place, frame('2026-11-17T08:00:00.000Z', 6), {}, net.env)
    assert.equal(override.status, 'conflict', 'the revision the phone remembers is one the server never reached')
    const next = await startPage(store, net, id)
    try {
      assert.equal(next.place.spatialFrame?.createdAt, F1.createdAt, 'the next visit starts on the frame the server holds')
      assert.equal(next.place.spatialFrameRevision, 1)
    } finally {
      next.stop()
    }
  } finally {
    page.stop()
  }
})
