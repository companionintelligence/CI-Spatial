/**
 * Frame generations over HTTP, with the real server (ADR 0011): an override that makes a new generation, the status
 * a client asks before it replaces a reference, a merge or a moved scan that would put scans into a frame they were not
 * measured in, the hand-over of what was made of a scan to the world it moves to, photos kept per frame, and the
 * routes behind the guard their siblings are behind.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so a route cannot be called from a test in
 * process (place_frame_route.test.ts says the same). Each test spawns the real server on a free port with every
 * directory it writes in a temp folder, writes the Places, scans and worlds a previous build would have left there
 * before it boots, and talks to it over HTTP. The pure rules are in frame_generations.test.ts and scan_carry.test.ts.
 *
 * What is pinned:
 *  - an override over HTTP: refused without a reason, with another frame's id, and as a stale writer; accepted with the
 *    id and a reason, which makes a history row on disk, in the Place the next read shows;
 *  - what a build before this change sends still works: a frame with no id, a body queued by the service worker, a
 *    Place, scans and photos written before ids;
 *  - frame-status counts a Place's scans by the frame their sidecars name, and not from any world;
 *  - a merge and a moved scan: 409 `frame-mismatch` with a sentence a person can read, nothing changed; with
 *    `acceptFrameMismatch` the move is done and the patches, comments and finished jobs of the scan are in the world it
 *    moved to and no longer in the one it left (0 manual alignments lost, except that a merge removes the merged-away
 *    Place's world once it has handed everything over, and with it the placement a scan had against that world's origin,
 *    which means nothing in another, and which the answer counts as `placementsRemoved`:
 *    tests/unit/deno/data_lifecycle_route.test.ts); a Place with no frame takes the scans' frame, with its photos;
 *  - photos belong to their frame: a new generation never shows, or overwrites, the previous one's;
 *  - Thing matching leaves out the scans that are not in the Place frame, and the job says how many;
 *  - what the hand-over does when the other world is not free: a world that is busy or cut short never makes the old world
 *    unreadable or loses a record, the answer says `pending`, and a timer finishes it without another read of the old world;
 *    a retry does not make a world that has gone; a scan sent back and forth under reads of both worlds ends once, in one world;
 *  - a scan placed by the origin of its world keeps its hand-set placement in that world, and the answer counts it, while one
 *    placed by its own record (whatever its sidecar says of calibration) takes it along;
 *  - a Place that takes in scans of another frame describes that frame in its history and serves its photos;
 *  - the Place that took the frame of a Place from before ids (no id, photos named by the Place's own folder) is in that
 *    frame: the next scan and a merge of the Place it came from are not refused, and two such Places that were calibrated
 *    separately still are;
 *  - the world a scan is handed to is the Place's own, never a world file of another Place that is at its name;
 *  - an id the Place held before is not given to another frame;
 *  - the new routes are behind the Companion session guard in every mode, as the routes beside them are.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { signSession } from '../../../server/portal_auth.ts'
import type { FrameStatus } from '../../../src/world/frame-generations.ts'
import type { FrameHistoryEntry, Project, ProjectSpatialFrame, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 30_000

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

const SESSION_SECRET = 'frame-generations-route-test-secret'
const OWNER_EMAIL = 'owner@example.com'
const SIGN_IN_ON: Record<string, string> = {
  PORTAL_OIDC_ENABLED: '1',
  OIDC_ISSUER_URL: 'http://127.0.0.1:9',
  PORTAL_OIDC_ALLOWED_EMAILS: OWNER_EMAIL,
  SESSION_SECRET,
}

interface Reply {
  status: number
  text: string
  json: unknown
  bytes: Uint8Array
  headers: Headers
}

interface Dirs {
  root: string
  scans: string
  worlds: string
  projects: string
  media: string
}

interface RunningServer {
  dirs: Dirs
  send(method: string, path: string, body?: unknown, bearer?: string): Promise<Reply>
  /** One photo, as the phone sends it: multipart `image` and `meta`. */
  upload(path: string, bytes: Uint8Array<ArrayBuffer>, meta: unknown, bearer?: string): Promise<Reply>
  /** The registry as it is on disk right now. */
  registry(): Promise<Project[]>
  /** A world file as it is on disk right now: no read of the server, so no refresh. */
  worldFile(slug: string): Promise<WorldProject>
  log(): string
  stop(): Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

async function startServer(options: { env?: Record<string, string>; seed?: (dirs: Dirs) => Promise<void> } = {}): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'frame-generations-' })
  const dirs: Dirs = { root, scans: `${root}/scans`, worlds: `${root}/worlds`, projects: `${root}/projects.json`, media: `${root}/media` }
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(Deno.env.toObject())) {
    if (INHERITED_ENV.test(name)) inherited[name] = value
  }
  let child: Deno.ChildProcess | null = null
  let output = ''
  const pumps: Promise<void>[] = []
  const stop = async (): Promise<void> => {
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch { /* already gone */ }
      await child.status
      await Promise.all(pumps)
      child = null
    }
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
  try {
    await Deno.mkdir(dirs.scans, { recursive: true })
    await Deno.mkdir(dirs.worlds, { recursive: true })
    await Deno.mkdir(dirs.media, { recursive: true })
    if (options.seed) await options.seed(dirs)
    child = new Deno.Command(Deno.execPath(), {
      args: [
        'run', '--no-prompt', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run',
        SERVER_ENTRY,
      ],
      cwd: fromFileUrl(REPO_ROOT),
      clearEnv: true,
      env: {
        ...inherited,
        PORT: '0',
        SCANS_DIR: dirs.scans,
        WORLDS_DIR: dirs.worlds,
        SUMMARIES_DIR: `${root}/summaries`,
        PROJECTS_FILE: dirs.projects,
        PROJECT_MEDIA_DIR: dirs.media,
        STATIC_DIR: `${root}/no-static-bundle`,
        INFERENCE_MODE: 'mock',
        TAILSCALE_HOSTNAME: 'scan.test',
        ...options.env,
      },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn()

    let announce!: (port: number) => void
    const listening = new Promise<number>((resolve) => {
      announce = resolve
    })
    const onText = (text: string) => {
      output += text
      const match = /Listening on https?:\/\/[^:\s/]+:(\d+)/.exec(output)
      if (match) announce(Number(match[1]))
    }
    pumps.push(pump(child.stdout, onText), pump(child.stderr, onText))

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      listening.then((port) => ({ port })),
      child.status.then((status) => ({ exitCode: status.code })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), BOOT_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    if (!('port' in outcome)) {
      throw new Error(`the server did not start (${JSON.stringify(outcome)}). Its output:\n${output.slice(-4000)}`)
    }

    const base = `http://127.0.0.1:${outcome.port}`
    const request = async (path: string, init: RequestInit): Promise<Reply> => {
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
        const bytes = new Uint8Array(await res.arrayBuffer())
        const text = new TextDecoder().decode(bytes)
        let json: unknown = null
        try {
          json = JSON.parse(text)
        } catch { /* not JSON */ }
        return { status: res.status, text, json, bytes, headers: res.headers }
      } finally {
        clearTimeout(abort)
      }
    }
    const authorization = (bearer?: string): Record<string, string> => (bearer ? { Authorization: `Bearer ${bearer}` } : {})
    return {
      dirs,
      send: (method, path, body, bearer) =>
        request(path, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...authorization(bearer) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      upload: (path, bytes, meta, bearer) => {
        const form = new FormData()
        form.append('image', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
        form.append('meta', JSON.stringify(meta))
        return request(path, { method: 'POST', headers: authorization(bearer), body: form })
      },
      registry: async () => JSON.parse(await Deno.readTextFile(dirs.projects)) as Project[],
      worldFile: async (slug) => JSON.parse(await Deno.readTextFile(`${dirs.worlds}/${slug}.json`)) as WorldProject,
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

// ── What a previous build left on disk ───────────────────────────────────────────────────────────

const AT_A = '2026-11-16T08:00:00.000Z'
const AT_B = '2026-11-16T09:00:00.000Z'
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
/** A placement set by hand: the calibrated one moved 2.5 m east and 1 m south. */
const MOVED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, -1, 1]
const EMPTY_GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }

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

const GEN_A = frame(AT_A, 2, { frameId: 'gen-a' })
const GEN_B = frame(AT_B, 3, { frameId: 'gen-b' })
const LEGACY_1 = frame(AT_A, 2)
const LEGACY_2 = frame(AT_B, 3)

function photo(url: string | null, key: string) {
  return {
    url,
    localKey: key,
    tapPoint: { x: 0.4, y: 0.6 },
    pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    capturedAt: AT_A,
  }
}

/** A Place as a registry holds it. */
function placeRecord(projectId: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId,
    name,
    placeType: 'building',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    areas: [{ areaId: `area-${projectId}`, name, kind: 'site', parentAreaId: null }],
    floors: [{ floorId: `floor-${projectId}`, name: 'Ground Floor', level: 0, rooms: [] }],
    ...extra,
  }
}

/** A valid binary glTF whose scene has no nodes: enough for the server to hold a scan of. */
function emptyGlb(): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }))
  const padded = new Uint8Array(new ArrayBuffer(Math.ceil(json.length / 4) * 4)).fill(0x20)
  padded.set(json)
  const out = new Uint8Array(new ArrayBuffer(12 + 8 + padded.length))
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(padded, 20)
  return out
}

type Tier = 'two-point' | 'one-point' | 'none'

/** The sidecar `src/export/gltf.ts` wrote for a scan: the flat summaries and the whole calibration record. */
function sidecar(projectId: string | null, name: string, tier: Tier, frameId?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const calibration = tier === 'two-point'
    ? { method: 'two-point-ground', status: 'verified', sessionToProject: IDENTITY, calibratedAt: AT_A, separationM: 2, residualM: 0, toleranceM: 0.15, anchorBearingDeg: null, ...(frameId ? { frameId } : {}) }
    : tier === 'one-point'
    ? { method: 'ground-tap-compass', status: 'provisional', sessionToProject: IDENTITY, calibratedAt: AT_A, anchorBearingDeg: 0 }
    : null
  return {
    projectId,
    areaId: null,
    sessionId: null,
    scanName: name,
    capturedAt: AT_A,
    exportedAt: AT_A,
    projectTransform: calibration ? IDENTITY : null,
    calibrationMethod: calibration?.method ?? null,
    calibrationStatus: calibration?.status ?? 'uncalibrated',
    calibration,
    pointCount: 5000,
    detectionCount: 0,
    labels: [],
    detections: [],
    ...extra,
  }
}

async function writeScan(dirs: Dirs, filename: string, meta: Record<string, unknown>): Promise<void> {
  await Deno.writeFile(`${dirs.scans}/${filename}`, emptyGlb())
  await Deno.writeTextFile(`${dirs.scans}/${filename.replace(/\.glb$/, '.json')}`, JSON.stringify(meta))
}

/** `scan-<file>`: the id the server derives from the file name (server/scan_id.ts). */
const scanIdOf = (filename: string) => `scan-${filename.replace(/\.glb$/, '')}`

function row(filename: string, projectId: string, tier: Tier, extra: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId: scanIdOf(filename),
    projectId,
    areaId: null,
    sessionId: null,
    filename,
    name: filename,
    glbUrl: `/scans/${filename}`,
    geoPose: EMPTY_GEO,
    localToWorld: IDENTITY,
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: AT_A,
    pointCount: 5000,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
    ...(tier === 'two-point' ? { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' } : {}),
    ...extra,
  } as ScanManifest
}

function worldOf(projectId: string, extra: Partial<WorldProject> = {}): WorldProject {
  return {
    worldId: `world-project-${projectId}`,
    name: projectId,
    shareSlug: `project-${projectId}`,
    projectId,
    originGeoPose: EMPTY_GEO,
    localFrame: { type: 'ENU_Y_UP', origin: EMPTY_GEO, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [],
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: [],
    editPatches: [],
    createdAt: AT_A,
    updatedAt: AT_A,
    ...extra,
  }
}

async function writeWorld(dirs: Dirs, world: WorldProject): Promise<void> {
  await Deno.writeTextFile(`${dirs.worlds}/${world.shareSlug}.json`, JSON.stringify(world, null, 2))
}

async function writeRegistry(dirs: Dirs, places: Array<Record<string, unknown>>): Promise<void> {
  await Deno.writeTextFile(dirs.projects, JSON.stringify(places, null, 2))
}

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const idsOf = (items: Array<{ patchId?: string; commentId?: string; jobId?: string }>) => items.map((item) => item.patchId ?? item.commentId ?? item.jobId)

const putFrame = (server: RunningServer, projectId: string, body: unknown, bearer?: string) =>
  server.send('PUT', `/projects/${projectId}/spatial-frame`, body, bearer)
const getPlace = async (server: RunningServer, projectId: string) => {
  const reply = await server.send('GET', `/projects/${projectId}`)
  assertEquals(reply.status, 200, reply.text)
  return reply.json as Project
}
const photoMeta = (role: string) => ({
  role,
  tapPoint: { x: 0.4, y: 0.6 },
  pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: AT_A,
})

// ── An override ──────────────────────────────────────────────────────────────────────────────────

Deno.test('an override makes a new generation: refused without a reason or with another frame\'s id, accepted with both, and the history is on disk', async () => {
  const server = await startServer({
    seed: (dirs) => writeRegistry(dirs, [placeRecord('proj-a', 'House', { spatialFrame: GEN_A, spatialFrameRevision: 1 })]),
  })
  try {
    // 1. No reason: refused with what the Place holds, as a lost race is, and with a sentence.
    const bare = await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1 })
    assertEquals(bare.status, 409, bare.text)
    const refusal = bare.json as { code: string; error: string; current: { frame: unknown; revision: number } }
    assertEquals(refusal.code, 'replaces-required')
    assertEquals(refusal.current, { frame: GEN_A, revision: 1 })
    assert(refusal.error.length > 0)
    // 2. Another frame's id.
    const wrong = await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-x', reason: 'override' } })
    assertEquals([wrong.status, (wrong.json as { code: string }).code], [409, 'replaces-mismatch'])
    // 3. A reason this build does not know.
    assertEquals((await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'reset' } })).status, 400)
    const untouched = await server.registry()
    assertEquals(untouched[0]!['spatialFrame' as keyof Project], GEN_A, 'nothing was stored by any of them')
    assertEquals(untouched[0]!.frameHistory, undefined)

    // 4. The id and a reason: a new generation.
    const accepted = await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
    assertEquals(accepted.status, 200, accepted.text)
    assertEquals(accepted.json, { revision: 2, frame: GEN_B })
    const held = await getPlace(server, 'proj-a')
    assertEquals(held.spatialFrame, GEN_B)
    assertEquals(held.spatialFrameRevision, 2)
    assertEquals(held.frameHistory?.length, 1)
    assertEquals(held.frameHistory?.[0], {
      frameId: 'gen-a',
      createdAt: AT_A,
      method: 'two-point-ground',
      separationM: 2,
      supersededAt: held.frameHistory![0]!.supersededAt,
      reason: 'override',
    })
    assert(Number.isFinite(Date.parse(held.frameHistory![0]!.supersededAt)), 'an ISO time the server stamped')
    const onDisk = (await server.registry()).find((place) => place.projectId === 'proj-a')!
    assertEquals(onDisk.frameHistory, held.frameHistory, 'in the file, so a restart still lists it')
    assertEquals(onDisk.spatialFrameRevision, 2)

    // 5. A replay (the service worker's queue, a lost reply) is not a conflict and adds no row.
    const replay = await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
    assertEquals([replay.status, (replay.json as { unchanged?: boolean }).unchanged], [200, true])
    assertEquals((await getPlace(server, 'proj-a')).frameHistory?.length, 1)

    // 6. A writer that read the Place before the override is told it lost, not that it left out a reason.
    const stale = await putFrame(server, 'proj-a', { frame: frame('2026-11-16T10:00:00.000Z', 4, { frameId: 'gen-c' }), expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })
    assertEquals(stale.status, 409)
    assertEquals((stale.json as { code?: string }).code, undefined)
    assertEquals((stale.json as { current: { revision: number } }).current.revision, 2)

    // 7. The history survives an edit made from a copy of the Place read before the override.
    const rename = await server.send('PUT', '/projects/proj-a', { ...held, name: 'House (renamed)', frameHistory: [], spatialFrameRevision: 0 })
    assertEquals(rename.status, 200, rename.text)
    assertEquals((rename.json as Project).frameHistory?.length, 1, 'a body\'s history is never believed')
    assertEquals((rename.json as Project).spatialFrame, GEN_B)
  } finally {
    await server.stop()
  }
})

Deno.test('an id names one reference for good: the id of a frame the Place held before is not given to another frame', async () => {
  const server = await startServer({
    seed: (dirs) => writeRegistry(dirs, [placeRecord('proj-a', 'House', { spatialFrame: GEN_A, spatialFrameRevision: 1 })]),
  })
  try {
    assertEquals((await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })).status, 200)
    // Another frame, written with the id the first one had: scans measured against the first would read as scans of this one.
    const other = frame('2026-11-16T10:00:00.000Z', 4, { frameId: 'gen-a' })
    const reused = await putFrame(server, 'proj-a', { frame: other, expectedRevision: 2, replaces: { frameId: 'gen-b', reason: 'override' } })
    assertEquals([reused.status, (reused.json as { code?: string }).code], [409, 'frame-id-reused'], reused.text)
    assert((reused.json as { error: string }).error.length > 0)
    assertEquals((reused.json as { current: { frame: unknown; revision: number } }).current, { frame: GEN_B, revision: 2 })
    const held = await getPlace(server, 'proj-a')
    assertEquals([held.spatialFrame, held.spatialFrameRevision, held.frameHistory?.length], [GEN_B, 2, 1], 'nothing was stored')
    // A new id is what an override takes, and it is accepted as before.
    const fresh = frame('2026-11-16T10:00:00.000Z', 4, { frameId: 'gen-c' })
    assertEquals((await putFrame(server, 'proj-a', { frame: fresh, expectedRevision: 2, replaces: { frameId: 'gen-b', reason: 'override' } })).status, 200)
  } finally {
    await server.stop()
  }
})

Deno.test('a build before ids: frames with no id replace each other as they always did, and an id is not erased by one that has none', async () => {
  const server = await startServer({
    seed: (dirs) => writeRegistry(dirs, [
      placeRecord('proj-legacy', 'Old Place', { spatialFrame: LEGACY_1 }),
      placeRecord('proj-new', 'New Place', { spatialFrame: GEN_A, spatialFrameRevision: 1 }),
    ]),
  })
  try {
    // The body the previous build queued in the service worker: a frame and the revision it read (0, for a Place saved
    // before revisions). Replayed to this server, it is what it always was.
    const queued = { frame: LEGACY_2, expectedRevision: 0 }
    const first = await putFrame(server, 'proj-legacy', queued)
    assertEquals([first.status, first.json], [200, { revision: 1, frame: LEGACY_2 }])
    assertEquals((await getPlace(server, 'proj-legacy')).frameHistory, undefined, 'nothing could name them, so nothing is recorded')
    const replay = await putFrame(server, 'proj-legacy', queued)
    assertEquals([replay.status, (replay.json as { unchanged?: boolean }).unchanged], [200, true])
    // The same write, but it says what it replaces: that is recorded.
    const said = await putFrame(server, 'proj-legacy', { frame: frame('2026-11-16T10:00:00.000Z', 4), expectedRevision: 1, replaces: { frameId: null, reason: 'override' } })
    assertEquals(said.status, 200, said.text)
    assertEquals((await getPlace(server, 'proj-legacy')).frameHistory?.length, 1)

    // A previous build\'s override of a Place that already has an id would erase the generation: refused, and it adopts.
    const erased = await putFrame(server, 'proj-new', { frame: LEGACY_2, expectedRevision: 1 })
    assertEquals([erased.status, (erased.json as { code: string }).code], [409, 'replaces-required'])
    assertEquals((erased.json as { current: { frame: unknown } }).current.frame, GEN_A)
    assertEquals((await getPlace(server, 'proj-new')).spatialFrame, GEN_A)
  } finally {
    await server.stop()
  }
})

// ── frame-status ─────────────────────────────────────────────────────────────────────────────────

Deno.test('frame-status counts a Place\'s scans by the frame their sidecars name, from the sidecars and not from any world', async () => {
  const history: FrameHistoryEntry[] = [{ frameId: 'gen-a', createdAt: AT_A, method: 'two-point-ground', separationM: 2, supersededAt: '2026-11-16T09:00:00.000Z', reason: 'override' }]
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [
        placeRecord('proj-a', 'House', { spatialFrame: GEN_B, spatialFrameRevision: 2, frameHistory: history }),
        placeRecord('proj-bare', 'Shed'),
        placeRecord('proj-old', 'Old', { spatialFrame: LEGACY_1 }),
      ])
      await writeScan(dirs, '1700000000001_a1.glb', sidecar('proj-a', 'a1', 'two-point', 'gen-a'))
      await writeScan(dirs, '1700000000002_b1.glb', sidecar('proj-a', 'b1', 'two-point', 'gen-b'))
      await writeScan(dirs, '1700000000003_b2.glb', sidecar('proj-a', 'b2', 'two-point', 'gen-b'))
      await writeScan(dirs, '1700000000004_u1.glb', sidecar('proj-a', 'u1', 'two-point'))
      await writeScan(dirs, '1700000000005_o1.glb', sidecar('proj-a', 'o1', 'one-point'))
      await writeScan(dirs, '1700000000006_n1.glb', sidecar('proj-a', 'n1', 'none'))
      await writeScan(dirs, '1700000000007_x1.glb', sidecar('proj-bare', 'x1', 'two-point', 'gen-b'))
      await writeScan(dirs, '1700000000008_legacy.glb', sidecar('proj-old', 'legacy', 'two-point'))
      await writeScan(dirs, '1700000000009_loose.glb', sidecar(null, 'loose', 'two-point', 'gen-b'))
      // A world that disagrees with the sidecars: the counts do not read it.
      await writeWorld(dirs, worldOf('proj-a', { scans: [row('1700000000001_a1.glb', 'proj-a', 'two-point')] }))
    },
  })
  try {
    const reply = await server.send('GET', '/projects/proj-a/frame-status')
    assertEquals(reply.status, 200, reply.text)
    const status = reply.json as FrameStatus
    assertEquals(status.projectId, 'proj-a')
    assertEquals(status.frame, GEN_B)
    assertEquals(status.frameId, 'gen-b')
    assertEquals(status.revision, 2)
    assertEquals(status.scanCount, 6, 'the Place\'s own six, not the other Places\' or the one that has none')
    assertEquals(status.scansByFrame, { 'gen-a': 1, 'gen-b': 2 })
    assertEquals(status.unrecordedScans, 1)
    assertEquals(status.notInFrameScans, 2)
    assertEquals(status.scansOnCurrentFrame, 2, 'what a replacement would leave in a previous reference')
    assertEquals(status.history, history)

    const bare = (await server.send('GET', '/projects/proj-bare/frame-status')).json as FrameStatus
    assertEquals([bare.frame, bare.frameId, bare.revision, bare.scanCount, bare.scansOnCurrentFrame, bare.history], [null, null, 0, 1, 0, []])
    // A Place whose frame predates ids: the scans that name no frame are the ones measured against it.
    const old = (await server.send('GET', '/projects/proj-old/frame-status')).json as FrameStatus
    assertEquals([old.frameId, old.unrecordedScans, old.scansOnCurrentFrame, old.revision], [null, 1, 1, 0])

    const missing = await server.send('GET', '/projects/proj-nowhere/frame-status')
    assertEquals([missing.status, (missing.json as { error: string }).error], [404, 'Not found'])
    // The count the DELETE route reads is the same count.
    const refused = await server.send('DELETE', '/projects/proj-a')
    assertEquals([refused.status, (refused.json as { scanCount: number }).scanCount], [409, 6])
  } finally {
    await server.stop()
  }
})

// ── A scan moved to another Place ────────────────────────────────────────────────────────────────

const KITCHEN = '1700000000001_kitchen.glb'
const HALL = '1700000000002_hall.glb'
const LOFT = '1700000000003_loft.glb'
const VISIT = '1700000000004_visit.glb'
const STUDY = '1700000000005_study.glb'

/** Places A (gen-a), B (gen-b) and C (no frame); A holds a calibrated kitchen with a hand-set placement and a hall placed by GPS. */
async function seedHouses(dirs: Dirs): Promise<void> {
  const landmark = photo('/projects/proj-a/frames/gen-a/ref-landmark.jpg', 'proj-a:gen-a:landmark')
  const heading = photo('/projects/proj-a/frames/gen-a/ref-heading.jpg', 'proj-a:gen-a:heading')
  await writeRegistry(dirs, [
    placeRecord('proj-a', 'House A', {
      spatialFrame: { ...GEN_A, referencePhotos: { landmark, headingMarker: heading } },
      spatialFrameRevision: 1,
      frameHistory: [{ frameId: 'gen-0', createdAt: '2026-11-15T08:00:00.000Z', method: 'two-point-ground', separationM: 1.5, supersededAt: AT_A, reason: 'override' }],
      areas: [{ areaId: 'area-a-main', name: 'Main', kind: 'room', parentAreaId: null }],
    }),
    placeRecord('proj-b', 'House B', { spatialFrame: GEN_B, spatialFrameRevision: 1 }),
    placeRecord('proj-c', 'Shed'),
  ])
  await Deno.mkdir(`${dirs.media}/proj-a/frames/gen-a`, { recursive: true })
  await Deno.writeFile(`${dirs.media}/proj-a/frames/gen-a/ref-landmark.jpg`, bytesOf('landmark of generation a'))
  await writeScan(dirs, KITCHEN, sidecar('proj-a', 'Kitchen', 'two-point', 'gen-a'))
  await writeScan(dirs, HALL, sidecar('proj-a', 'Hall', 'none'))
  await writeScan(dirs, LOFT, sidecar('proj-a', 'Loft', 'two-point'))
  await writeScan(dirs, VISIT, sidecar('proj-a', 'Visit', 'two-point', 'gen-b'))
  await writeScan(dirs, STUDY, sidecar('proj-b', 'Study', 'two-point', 'gen-b'))
  const kitchen = scanIdOf(KITCHEN)
  const hall = scanIdOf(HALL)
  const wid = 'world-project-proj-a'
  await writeWorld(dirs, worldOf('proj-a', {
    scans: [
      row(KITCHEN, 'proj-a', 'two-point', { localToWorld: MOVED, calibratedLocalToWorld: IDENTITY }),
      row(HALL, 'proj-a', 'none', { localToWorld: MOVED }),
      row(LOFT, 'proj-a', 'two-point'),
      row(VISIT, 'proj-a', 'two-point'),
    ],
    editPatches: [
      { patchId: 'p-move-kitchen', worldId: wid, scanId: kitchen, targetId: KITCHEN, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT_B },
      { patchId: 'p-note-kitchen', worldId: wid, scanId: kitchen, targetId: KITCHEN, scope: 'scan', notes: 'the table was moved', createdAt: AT_B },
      { patchId: 'p-move-hall', worldId: wid, scanId: hall, targetId: HALL, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT_B },
      { patchId: 'p-note-hall', worldId: wid, scanId: hall, targetId: HALL, scope: 'scan', notes: 'dark corner', createdAt: AT_B },
      { patchId: 'p-loft', worldId: wid, scanId: scanIdOf(LOFT), targetId: LOFT, scope: 'scan', notes: 'the loft stays', createdAt: AT_B },
    ],
    comments: [
      { commentId: 'c-kitchen', worldId: wid, body: 'check the sink', scanId: kitchen, actorId: 'local', actorRole: 'local', createdAt: AT_B },
      { commentId: 'c-hall', worldId: wid, body: 'light switch', scanId: hall, actorId: 'local', actorRole: 'local', createdAt: AT_B },
      { commentId: 'c-loft', worldId: wid, body: 'stays', scanId: scanIdOf(LOFT), actorId: 'local', actorRole: 'local', createdAt: AT_B },
    ],
    jobs: [
      { jobId: 'j-kitchen', worldId: wid, type: 'splat-train', status: 'completed', scanId: kitchen, capabilities: [], result: 'trained', createdAt: AT_B, updatedAt: AT_B },
      { jobId: 'j-hall', worldId: wid, type: 'splat-train', status: 'failed', scanId: hall, capabilities: [], createdAt: AT_B, updatedAt: AT_B },
    ],
  }))
}

Deno.test('a scan moved to a Place with another frame: 409 with a sentence and nothing changed; with the flag it moves and its manual alignment comes with it', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const kitchenId = scanIdOf(KITCHEN)
    const moveTo = (project: string, scanId: string, body: Record<string, unknown> = {}) =>
      server.send('PATCH', `/projects/${project}/scans/${scanId}`, body)

    // Refused: the kitchen was measured against generation a, and House B holds generation b.
    const refused = await moveTo('proj-b', kitchenId)
    assertEquals(refused.status, 409, refused.text)
    const body = refused.json as { code: string; error: string; target: { frameId: string }; source: { frameId: string }; scans: number }
    assertEquals(body.code, 'frame-mismatch')
    assertEquals([body.target.frameId, body.source.frameId, body.scans], ['gen-b', 'gen-a', 1])
    assert(body.error.includes('"House B"') && body.error.length < 260, body.error)
    const sidecarAfter = JSON.parse(await Deno.readTextFile(`${server.dirs.scans}/${KITCHEN.replace('.glb', '.json')}`)) as { projectId: string }
    assertEquals(sidecarAfter.projectId, 'proj-a', 'the scan was not filed anywhere else')
    const stillThere = await server.worldFile('project-proj-a')
    assertEquals(idsOf(stillThere.editPatches).includes('p-move-kitchen'), true)
    assertEquals(await Deno.stat(`${server.dirs.worlds}/project-proj-b.json`).then(() => true, () => false), false, 'House B\'s world was not touched')

    // Accepted: the kitchen moves with everything made of it.
    const moved = await moveTo('proj-b', kitchenId, { acceptFrameMismatch: true })
    assertEquals([moved.status, moved.json], [200, { ok: true }], moved.text)
    const filed = JSON.parse(await Deno.readTextFile(`${server.dirs.scans}/${KITCHEN.replace('.glb', '.json')}`)) as { projectId: string }
    assertEquals(filed.projectId, 'proj-b')

    const left = await server.worldFile('project-proj-a')
    assertEquals(left.scans.map((scan) => scan.filename).sort(), [HALL, LOFT, VISIT].sort(), 'the kitchen is out of the world it left, at once')
    assert(left.scans.every((scan) => scan.projectId === 'proj-a'), 'and the rows that stayed were not filed under House B with it')
    assertEquals(idsOf(left.editPatches), ['p-move-hall', 'p-note-hall', 'p-loft'])
    assertEquals(idsOf(left.comments!), ['c-hall', 'c-loft'])
    assertEquals(idsOf(left.jobs), ['j-hall'])

    const arrived = await server.worldFile('project-proj-b')
    assertEquals(arrived.projectId, 'proj-b')
    const arrivedRow = arrived.scans.find((scan) => scan.filename === KITCHEN)!
    assertEquals(arrivedRow.localToWorld, MOVED, 'the manual alignment is not lost')
    assertEquals(arrivedRow.calibratedLocalToWorld, IDENTITY, 'and the calibrated placement it can be reset to')
    assertEquals(arrivedRow.projectId, 'proj-b')
    assertEquals(idsOf(arrived.editPatches), ['p-move-kitchen', 'p-note-kitchen'])
    assert(arrived.editPatches.every((patch) => patch.worldId === 'world-project-proj-b'))
    assertEquals(idsOf(arrived.comments!), ['c-kitchen'])
    assertEquals(idsOf(arrived.jobs), ['j-kitchen'])
    assert(arrived.scans.some((scan) => scan.filename === STUDY), 'House B\'s own scan is in its world beside it')

    // The API says the same, and the editor has what it needs to call the scan a previous reference.
    const world = (await server.send('GET', '/projects/proj-b/world')).json as WorldProject
    const listed = world.scans.find((scan) => scan.filename === KITCHEN)!
    assertEquals(listed.localToWorld, MOVED)
    assertEquals(listed.calibrationFrameId, 'gen-a')
    const status = (await server.send('GET', '/projects/proj-b/frame-status')).json as FrameStatus
    assertEquals(status.scansByFrame, { 'gen-a': 1, 'gen-b': 1 })
    assertEquals(status.scansOnCurrentFrame, 1)
    assertEquals(status.frameId, 'gen-b', 'House B\'s own frame is the one it was')
    assertEquals(status.revision, 1)
  } finally {
    await server.stop()
  }
})

Deno.test('a scan placed by its world\'s origin moves freely with its notes; the placement set by hand against that origin stays in the old world, and the answer says so', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(HALL)}`, {})
    assertEquals(moved.status, 200, moved.text)
    assertEquals(moved.json, { ok: true, handOver: { placementsKept: 1 } }, 'the person who moved it is told what did not come')
    const arrived = await server.worldFile('project-proj-b')
    const hall = arrived.scans.find((scan) => scan.filename === HALL)
    assert(hall, 'the world builds the row from the scan\'s own record')
    assertNotEquals(hall.localToWorld, MOVED, 'a placement set against another world\'s origin would put the scan in the wrong place here')
    assertEquals(idsOf(arrived.editPatches), ['p-note-hall'], 'the note comes, the matrix does not')
    assertEquals(idsOf(arrived.comments!), ['c-hall'])
    assertEquals(idsOf(arrived.jobs), ['j-hall'])
    // Not destroyed: the placement is still in the world it was made in, where it means what it meant. Nothing else of the hall is.
    const left = await server.worldFile('project-proj-a')
    assertEquals(idsOf(left.editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-move-hall', 'p-loft'])
    assertEquals(idsOf(left.comments!), ['c-kitchen', 'c-loft'])
    assertEquals(idsOf(left.jobs), ['j-kitchen'])
    assertEquals(left.scans.some((scan) => scan.filename === HALL), false, 'the hall is no longer listed in the Place it left')

    // Read again, and nothing is counted twice or moved twice.
    await server.send('GET', '/projects/proj-a/world')
    await server.send('GET', '/projects/proj-b/world')
    assertEquals(idsOf((await server.worldFile('project-proj-a')).editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-move-hall', 'p-loft'])
    assertEquals(idsOf((await server.worldFile('project-proj-b')).editPatches), ['p-note-hall'])
  } finally {
    await server.stop()
  }
})

const MOVER = '1700000000006_mover.glb'

/** `seedHouses`, and House A also holds a scan that is placed by its own record (a `projectTransform`) though it names no calibration. */
async function seedHousesWithMover(dirs: Dirs): Promise<void> {
  await seedHouses(dirs)
  await writeScan(dirs, MOVER, sidecar('proj-a', 'Mover', 'none', undefined, { projectTransform: IDENTITY }))
  const world = JSON.parse(await Deno.readTextFile(`${dirs.worlds}/project-proj-a.json`)) as WorldProject
  const wid = world.worldId
  world.scans.push(row(MOVER, 'proj-a', 'none', { localToWorld: MOVED }))
  world.editPatches.push(
    { patchId: 'p-move-mover', worldId: wid, scanId: scanIdOf(MOVER), targetId: MOVER, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT_B },
    { patchId: 'p-note-mover', worldId: wid, scanId: scanIdOf(MOVER), targetId: MOVER, scope: 'scan', notes: 'by the door', createdAt: AT_B },
  )
  await writeWorld(dirs, world)
}

Deno.test('a scan placed by its own record takes its hand-set placement with it, whether or not its sidecar names a calibration', async () => {
  const server = await startServer({ seed: seedHousesWithMover })
  try {
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(MOVER)}`, {})
    assertEquals([moved.status, moved.json], [200, { ok: true }], 'nothing stays behind, so there is nothing to say')
    const arrived = await server.worldFile('project-proj-b')
    assertEquals(arrived.scans.find((scan) => scan.filename === MOVER)?.localToWorld, MOVED, 'the placement is the same in every world: it came from the scan\'s own record')
    assertEquals(idsOf(arrived.editPatches), ['p-move-mover', 'p-note-mover'])
    const left = await server.worldFile('project-proj-a')
    assertEquals(idsOf(left.editPatches).filter((id) => id!.includes('mover')), [])
  } finally {
    await server.stop()
  }
})

Deno.test('a scan that names the frame the other Place holds, or is moved within its Place, or into a Place with no frame, is not refused', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    // Not even a scan that names another generation than its own Place holds (the visit names b, House A holds a) is refused
    // when it is moved within its Place: it is where it was, and no frame is in question.
    const within = await server.send('PATCH', `/projects/proj-a/scans/${scanIdOf(VISIT)}`, { areaId: 'area-a-main' })
    assertEquals([within.status, within.json], [200, { ok: true }])

    // The visit was measured against generation b, which is House B's frame.
    assertEquals((await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(VISIT)}`, {})).status, 200)
    assertEquals((await server.worldFile('project-proj-b')).scans.some((scan) => scan.filename === VISIT), true)

    // A change of area inside the scan's own Place: no frame is in question, and what was made of the scan stays.
    const area = await server.send('PATCH', `/projects/proj-a/scans/${scanIdOf(LOFT)}`, { areaId: 'area-a-main' })
    assertEquals(area.status, 200, area.text)
    assertEquals(idsOf((await server.worldFile('project-proj-a')).editPatches).includes('p-loft'), true)

    // A Place with no frame takes the frame the kitchen was measured against: the Place's revision goes up, its photos are copied.
    const shed = await server.send('PATCH', `/projects/proj-c/scans/${scanIdOf(KITCHEN)}`, {})
    assertEquals(shed.status, 200, shed.text)
    const held = await getPlace(server, 'proj-c')
    assertEquals(held.spatialFrameRevision, 1)
    assert(held.updatedAt > 1_700_000_000_500, 'the Place was changed, and says when')
    const copy = held.spatialFrame as ProjectSpatialFrame & { frameId: string; referencePhotos: { landmark: { url: string | null }; headingMarker: { url: string | null } } }
    assertEquals(copy.frameId, 'gen-a')
    assertEquals(copy.referencePhotos.landmark.url, '/projects/proj-c/frames/gen-a/ref-landmark.jpg', 'the record names a photo that is the Shed\'s own')
    assertEquals(copy.referencePhotos.headingMarker.url, null, 'a photo that never reached the server is said not to be there')
    const photoReply = await server.send('GET', copy.referencePhotos.landmark.url!)
    assertEquals([photoReply.status, textOf(photoReply.bytes)], [200, 'landmark of generation a'])
    assertEquals(photoReply.headers.get('content-type'), 'image/jpeg')
    const houseA = await getPlace(server, 'proj-a')
    assertEquals([houseA.spatialFrameRevision, (houseA.spatialFrame as { frameId: string }).frameId], [1, 'gen-a'], 'House A is as it was')
    assertEquals(
      (houseA.spatialFrame as { referencePhotos: { landmark: { url: string } } }).referencePhotos.landmark.url,
      '/projects/proj-a/frames/gen-a/ref-landmark.jpg',
      'and its record still names its own photos',
    )
    assertEquals(houseA.frameHistory?.length, 1)
    assertEquals(held.frameHistory, undefined, 'House A\'s earlier generations are not the Shed\'s: one scan came, not the Place')
    // The loft names no frame (it predates ids). House A holds the generation the Shed now holds, so it agrees; House B holds another, so it does not.
    assertEquals((await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(LOFT)}`, {})).status, 409)
    assertEquals((await server.send('PATCH', `/projects/proj-c/scans/${scanIdOf(LOFT)}`, {})).status, 200)
  } finally {
    await server.stop()
  }
})

Deno.test('a scan whose record was filed under another Place by hand is handed over by the next read of the world it left', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    // Not through the routes: the sidecar is edited on disk, as an operator or an older server would have done.
    const path = `${server.dirs.scans}/${KITCHEN.replace('.glb', '.json')}`
    const meta = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>
    await Deno.writeTextFile(path, JSON.stringify({ ...meta, projectId: 'proj-b' }))
    assertEquals(idsOf((await server.worldFile('project-proj-a')).editPatches).includes('p-move-kitchen'), true, 'nothing has read the world yet')

    // Reading House A's world is what evicts the kitchen, and it hands the kitchen over instead of pruning what was made of it.
    const read = (await server.send('GET', '/projects/proj-a/world')).json as WorldProject
    assertEquals(read.scans.some((scan) => scan.filename === KITCHEN), false)
    const left = await server.worldFile('project-proj-a')
    assertEquals(idsOf(left.editPatches), ['p-move-hall', 'p-note-hall', 'p-loft'])
    assertEquals(idsOf(left.comments!), ['c-hall', 'c-loft'])
    const arrived = await server.worldFile('project-proj-b')
    assertEquals(arrived.scans.find((scan) => scan.filename === KITCHEN)!.localToWorld, MOVED)
    assertEquals(idsOf(arrived.editPatches), ['p-move-kitchen', 'p-note-kitchen'])
    assertEquals(idsOf(arrived.comments!), ['c-kitchen'])
    assertEquals(idsOf(arrived.jobs), ['j-kitchen'])

    // A second read of either world changes nothing more.
    await server.send('GET', '/projects/proj-a/world')
    await server.send('GET', '/projects/proj-b/world')
    assertEquals(idsOf((await server.worldFile('project-proj-b')).editPatches), ['p-move-kitchen', 'p-note-kitchen'], 'handed over once')
    assertEquals((await server.worldFile('project-proj-b')).scans.filter((scan) => scan.filename === KITCHEN).length, 1)
  } finally {
    await server.stop()
  }
})

const filedUnder = async (server: RunningServer, filename: string): Promise<string> =>
  (JSON.parse(await Deno.readTextFile(`${server.dirs.scans}/${filename.replace('.glb', '.json')}`)) as { projectId: string }).projectId
const fileUnder = async (server: RunningServer, filename: string, projectId: string): Promise<void> => {
  const path = `${server.dirs.scans}/${filename.replace('.glb', '.json')}`
  await Deno.writeTextFile(path, JSON.stringify({ ...(JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>), projectId }))
}
const kitchenRowIn = async (server: RunningServer, slug: string) => (await server.worldFile(slug)).scans.find((scan) => scan.filename === KITCHEN)

Deno.test('a scan sent back to the world it left keeps the placement and the patches it had there: a row built meanwhile in the other world does not replace them', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    // The kitchen is filed under House B by hand, and House B's world is read before House A's has handed it over:
    // it builds the kitchen's row from the record, at the placement the record gives, which is not the one set by hand.
    await fileUnder(server, KITCHEN, 'proj-b')
    const built = (await server.send('GET', '/projects/proj-b/world')).json as WorldProject
    assertEquals(built.scans.find((scan) => scan.filename === KITCHEN)?.localToWorld, IDENTITY, 'built from the record')
    assertEquals((await kitchenRowIn(server, 'project-proj-a'))?.localToWorld, MOVED, 'House A has not been read: its row and its patches are as they were')

    // It is filed under House A again, and House B's world is read: it hands what it has back.
    await fileUnder(server, KITCHEN, 'proj-a')
    await server.send('GET', '/projects/proj-b/world')
    const home = await server.worldFile('project-proj-a')
    assertEquals(home.scans.filter((scan) => scan.filename === KITCHEN).length, 1, 'one row')
    assertEquals(home.scans.find((scan) => scan.filename === KITCHEN)?.localToWorld, MOVED, 'the placement set by hand is not written over by a row nobody ever moved')
    assertEquals(idsOf(home.editPatches).filter((id) => id!.endsWith('kitchen')), ['p-move-kitchen', 'p-note-kitchen'], 'each patch once, and still the placement the log says')
    assertEquals((await kitchenRowIn(server, 'project-proj-b')), undefined, 'and House B no longer lists it')
  } finally {
    await server.stop()
  }
})

Deno.test('a world that cannot be read does not make the world a scan left unreadable: the scan stays, the answer says it is waiting, and it is handed over once the world is whole', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    // House B's world is a file cut short, as a full disk or a crash can leave one.
    await Deno.writeTextFile(`${server.dirs.worlds}/project-proj-b.json`, '{"worldId":"world-project-proj-b","scans":[')
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { acceptFrameMismatch: true })
    assertEquals(moved.status, 200, 'the scan is filed: the move is done, only the hand-over is not')
    assertEquals(moved.json, { ok: true, handOver: { pending: 1 } })
    assertEquals(await filedUnder(server, KITCHEN), 'proj-b')

    // House A reads as it did: a world is only as unreadable as its own file.
    const read = await server.send('GET', '/projects/proj-a/world')
    assertEquals(read.status, 200, `House A's own world is fine. ${read.text}`)
    const waiting = await server.worldFile('project-proj-a')
    assertEquals(idsOf(waiting.editPatches).includes('p-move-kitchen'), true, 'nothing of the kitchen was dropped')
    assertEquals(idsOf(waiting.comments!).includes('c-kitchen'), true)
    assertEquals(idsOf(waiting.jobs).includes('j-kitchen'), true)

    // House B's world is repaired; the next read of House A completes the hand-over.
    await writeWorld(server.dirs, worldOf('proj-b'))
    assertEquals((await server.send('GET', '/projects/proj-a/world')).status, 200)
    const arrived = await server.worldFile('project-proj-b')
    assertEquals(idsOf(arrived.editPatches), ['p-move-kitchen', 'p-note-kitchen'])
    assertEquals(arrived.scans.find((scan) => scan.filename === KITCHEN)?.localToWorld, MOVED)
    const left = await server.worldFile('project-proj-a')
    assertEquals(idsOf(left.editPatches), ['p-move-hall', 'p-note-hall', 'p-loft'])
  } finally {
    await server.stop()
  }
})

Deno.test('a retry does not make a world that has gone since: the timer reads the old world only if its file is still there', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    await Deno.writeTextFile(`${server.dirs.worlds}/project-proj-b.json`, '{"worldId":"world-project-proj-b","scans":[')
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { acceptFrameMismatch: true })
    assertEquals(moved.json, { ok: true, handOver: { pending: 1 } })
    // House A's world is removed by hand while the first retry (one second after the answer) is waiting to read it: a read of
    // a slug with no file would build a new world there, which is not what a retry is for.
    await Deno.remove(`${server.dirs.worlds}/project-proj-a.json`)
    await new Promise((resolve) => setTimeout(resolve, 1800))
    assertEquals(await Deno.stat(`${server.dirs.worlds}/project-proj-a.json`).then(() => true, () => false), false, server.log())
  } finally {
    await server.stop()
  }
})

Deno.test('the world a scan is handed to is the Place\'s own: a world file at its name that belongs to another Place is not written to, and is built again as the Place\'s', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      // The file at House B's name is another Place's world (the way an older build's merge relabelled worlds left some behind).
      await writeWorld(dirs, worldOf('proj-b', {
        projectId: 'proj-elsewhere',
        editPatches: [{ patchId: 'p-foreign', worldId: 'world-project-proj-b', scanId: 'scan-elsewhere', targetId: 'elsewhere.glb', scope: 'scan', notes: 'not House B\'s', createdAt: AT_B }],
      }))
    },
  })
  try {
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { acceptFrameMismatch: true })
    assertEquals(moved.json, { ok: true })
    const world = await server.worldFile('project-proj-b')
    assertEquals(world.projectId, 'proj-b', 'the world the scan went to is House B\'s')
    assertEquals(idsOf(world.editPatches).includes('p-move-kitchen'), true, 'with what was made of the scan')
    assertEquals(idsOf(world.editPatches).includes('p-foreign'), false, 'and nothing of the other Place\'s')
    assertEquals(world.scans.filter((scan) => scan.filename === KITCHEN).map((scan) => scan.projectId), ['proj-b'])
  } finally {
    await server.stop()
  }
})

Deno.test('a world that is busy while a scan is moved gets what was made of it all the same: nobody reads the old world again', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      // House B's world is a large file, so every read of it holds its lock for a while.
      const wid = 'world-project-proj-b'
      const notes = Array.from({ length: 60_000 }, (_, i) => ({ commentId: `c-bulk-${i}`, worldId: wid, body: 'a note on the Place as a whole, one of very many', scanId: null, actorId: 'local', actorRole: 'local', createdAt: AT_A }))
      await writeWorld(dirs, worldOf('proj-b', { comments: notes as WorldProject['comments'] }))
    },
  })
  try {
    // Readers of House B's world that never stop until told: its lock is held, one read after another, while the move is filed.
    let reading = true
    const crowd = Array.from({ length: 4 }, async () => {
      while (reading) await server.send('GET', '/worlds/project-proj-b/jobs')
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { acceptFrameMismatch: true })
    reading = false
    await Promise.all(crowd)
    assertEquals(moved.status, 200, moved.text)
    const answer = moved.json as { ok: boolean; handOver?: { pending?: number } }
    assertEquals(answer.ok, true)

    // The answer says what it knew; whatever it said, the records arrive without another read of the old world.
    const deadline = Date.now() + 20_000
    let arrived: WorldProject | null = null
    while (Date.now() < deadline) {
      arrived = await server.worldFile('project-proj-b').catch(() => null)
      if (arrived && idsOf(arrived.editPatches).includes('p-move-kitchen')) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert(arrived && idsOf(arrived.editPatches).includes('p-move-kitchen'), `the hand-over was never finished (the answer said ${JSON.stringify(answer)}). ${server.log()}`)
    assertEquals(idsOf(arrived.editPatches).filter((id) => id!.endsWith('kitchen')), ['p-move-kitchen', 'p-note-kitchen'], 'each patch once')
    assertEquals(arrived.scans.filter((scan) => scan.filename === KITCHEN).length, 1)
    const left = await server.worldFile('project-proj-a')
    assertEquals(idsOf(left.editPatches).filter((id) => id!.endsWith('kitchen')), [])
    assertEquals(left.scans.some((scan) => scan.filename === KITCHEN), false)
  } finally {
    await server.stop()
  }
})

Deno.test('a scan sent back and forth between two Places while their worlds are read ends in one world, once: every patch, comment and job exactly once, and the row where the log ends', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const kitchen = scanIdOf(KITCHEN)
    const readers: Array<Promise<unknown>> = []
    // Six moves, to House B and back, with both worlds being read all the time: reads that evict, reads that build, and hand-overs
    // that find the other world busy.
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 12; i++) readers.push(server.send('GET', '/projects/proj-a/world'), server.send('GET', '/projects/proj-b/world'))
      const to = round % 2 === 0 ? 'proj-b' : 'proj-a'
      const moved = await server.send('PATCH', `/projects/${to}/scans/${kitchen}`, { acceptFrameMismatch: true })
      assertEquals(moved.status, 200, moved.text)
    }
    await Promise.all(readers)
    assertEquals(await filedUnder(server, KITCHEN), 'proj-a', 'it ended in House A')

    // Whatever was still waiting finishes on its own: poll for the end of it.
    const ofKitchen = (items: Array<{ patchId?: string; commentId?: string; jobId?: string }>) => idsOf(items).filter((id) => id!.endsWith('kitchen'))
    const settled = async () => {
      const home = await server.worldFile('project-proj-a')
      const away = await server.worldFile('project-proj-b').catch(() => null)
      const clean = away === null || (ofKitchen(away.editPatches).length + ofKitchen(away.comments!).length + ofKitchen(away.jobs).length === 0 && !away.scans.some((scan) => scan.filename === KITCHEN))
      return { home, away, done: clean && ofKitchen(home.editPatches).length === 2 && home.scans.some((scan) => scan.filename === KITCHEN) }
    }
    const deadline = Date.now() + 30_000
    let state = await settled()
    while (!state.done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      state = await settled()
    }
    assert(state.done, `it never settled. House A: ${JSON.stringify(ofKitchen(state.home.editPatches))}, House B: ${JSON.stringify(state.away && ofKitchen(state.away.editPatches))}. ${server.log()}`)
    // A read of each world now changes nothing: no record is carried twice or lost.
    await server.send('GET', '/projects/proj-b/world')
    await server.send('GET', '/projects/proj-a/world')
    const home = await server.worldFile('project-proj-a')
    assertEquals(ofKitchen(home.editPatches), ['p-move-kitchen', 'p-note-kitchen'])
    assertEquals(ofKitchen(home.comments!), ['c-kitchen'])
    assertEquals(ofKitchen(home.jobs), ['j-kitchen'])
    const rows = home.scans.filter((scan) => scan.filename === KITCHEN)
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.localToWorld, MOVED, 'the placement the log ends on, after every row that was built in between')
    assertEquals(rows[0]!.calibratedLocalToWorld, IDENTITY)
    const away = await server.worldFile('project-proj-b')
    assertEquals([ofKitchen(away.editPatches), ofKitchen(away.comments!), ofKitchen(away.jobs), away.scans.some((scan) => scan.filename === KITCHEN)], [[], [], [], false])
  } finally {
    await server.stop()
  }
})

Deno.test('a move touches the worlds that held the scan and no others: another Place\'s world file is not read, relabelled or written', async () => {
  const SHED_SCAN = '1700000000008_shed.glb'
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      await writeScan(dirs, SHED_SCAN, sidecar('proj-c', 'Shed scan', 'none'))
      await writeWorld(dirs, worldOf('proj-c', { scans: [row(SHED_SCAN, 'proj-c', 'none')] }))
    },
  })
  try {
    const shedWorld = () => Deno.readTextFile(`${server.dirs.worlds}/project-proj-c.json`)
    const before = await shedWorld()
    assertEquals((await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { acceptFrameMismatch: true })).status, 200)
    assertEquals((await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a', acceptFrameMismatch: true })).status, 200)
    assertEquals(await shedWorld(), before, 'the Shed\'s world is exactly as it was')
  } finally {
    await server.stop()
  }
})

Deno.test('a scan that does not exist is a 404, and is refused nothing first', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    assertEquals((await server.send('PATCH', '/projects/proj-b/scans/scan-nothing-here', {})).status, 404)
    assertEquals((await server.send('PATCH', '/projects/proj-zzz/scans/scan-nothing-here', {})).status, 404)
    assertEquals((await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { areaId: 'area-nope' })).status, 404, 'an unknown area is judged before frames')
  } finally {
    await server.stop()
  }
})

Deno.test('a scan the session index names, whose own sidecar does not, is judged and filed as the one scan the request names: the Place that needs its frame takes it because the scan was filed', async () => {
  const SESSION_SCAN = '1700000000007_session.glb'
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      const own = sidecar('proj-a', 'Session scan', 'two-point', 'gen-a')
      delete own['sessionId']
      await writeScan(dirs, SESSION_SCAN, own)
      // The scan's session record says which file it made; the sidecar says nothing of the session.
      await Deno.mkdir(`${dirs.scans}/sessions/sess-1`, { recursive: true })
      await Deno.writeTextFile(`${dirs.scans}/sessions/sess-1/session.json`, JSON.stringify({ sessionId: 'sess-1', glbFilename: SESSION_SCAN }))
    },
  })
  try {
    const moved = await server.send('PATCH', '/projects/proj-c/scans/sess-1', {})
    const shed = await getPlace(server, 'proj-c')
    const filed = await filedUnder(server, SESSION_SCAN)
    // The two halves of the move agree on what the request names: the Shed took a frame only because it took the scan.
    assertEquals([moved.status, filed === 'proj-c', shed.spatialFrameRevision === 1], [200, true, true], `${moved.text} filed under ${filed}, Shed frame ${JSON.stringify(shed.spatialFrame)}`)
  } finally {
    await server.stop()
  }
})

// ── A merge ──────────────────────────────────────────────────────────────────────────────────────

Deno.test('a merge across frames is a 409 until the request says it knows, and then everything made of the scans moves into the target\'s world', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const refused = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(refused.status, 409, refused.text)
    const body = refused.json as { code: string; error: string; scans: number; source: { frameId: string }; target: { frameId: string } }
    assertEquals([body.code, body.scans, body.source.frameId, body.target.frameId], ['frame-mismatch', 4, 'gen-a', 'gen-b'])
    assert(body.error.includes('"House A"') && body.error.includes('"House B"'), body.error)
    assertEquals((await server.registry()).map((place) => place.projectId).sort(), ['proj-a', 'proj-b', 'proj-c'], 'both Places are still there')
    assertEquals((await server.worldFile('project-proj-a')).scans.length, 4)

    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a', acceptFrameMismatch: true })
    assertEquals(merged.status, 200, merged.text)
    assertEquals((merged.json as { alreadyMerged: boolean }).alreadyMerged, false)
    // The hall's placement is relative to House A's origin, and House A's world goes with the merge (below), so it is not kept: the
    // answer does not say it stayed in a world that is not there, and says that it went with it, so the person who merged can be
    // told, as the one that said 'kept' did (ADR 0011). (While House A's world stays, because something in it is waiting to be
    // handed over, the answer still says `placementsKept`: 'a merge reports on the scans it moved', below, asserts it.)
    assertEquals((merged.json as { handOver?: unknown }).handOver, undefined, 'and does not say that the hall\'s placement stayed in House A\'s world')
    assertEquals((merged.json as { sourceWorldRemoved?: boolean }).sourceWorldRemoved, true, 'House A\'s world went with the merge')
    assertEquals((merged.json as { placementsRemoved?: number }).placementsRemoved, 1, 'and the hall\'s placement, the one that was kept, went with it: the answer counts it')
    // (The registry always holds the default Place beside the others once it has been saved.)
    assertEquals((await server.registry()).map((place) => place.projectId).filter((id) => id !== 'proj-default').sort(), ['proj-b', 'proj-c'])
    const survivor = await getPlace(server, 'proj-b')
    assertEquals(survivor.spatialFrame, GEN_B, 'the target keeps its own frame')
    assertEquals(survivor.spatialFrameRevision, 1)

    // The source's world handed everything over and then went with the merge: nothing opens the world of a Place that is out of
    // the registry, and it held that Place's name, location and Things (docs/operations/PRIVACY.md, section 5). The placement of
    // the hall that was set against its origin, the one thing the hand-over kept there, means nothing in another world and went
    // with it. It was not relabelled as the target's either: no world but House B's own says it is House B's (it was a second
    // world for it that nothing opened).
    assertEquals(await Deno.stat(`${server.dirs.worlds}/project-proj-a.json`).then(() => true, () => false), false)
    const labelled: Record<string, unknown> = {}
    for await (const entry of Deno.readDir(server.dirs.worlds)) {
      if (entry.isFile && entry.name.endsWith('.json')) labelled[entry.name] = (JSON.parse(await Deno.readTextFile(`${server.dirs.worlds}/${entry.name}`)) as WorldProject).projectId
    }
    assertEquals(Object.entries(labelled).filter(([, projectId]) => projectId === 'proj-b').map(([name]) => name), ['project-proj-b.json'])

    const arrived = await server.worldFile('project-proj-b')
    assertEquals(arrived.scans.map((scan) => scan.filename).sort(), [HALL, KITCHEN, LOFT, STUDY, VISIT].sort())
    assertEquals(arrived.scans.find((scan) => scan.filename === KITCHEN)!.localToWorld, MOVED, 'the kitchen\'s manual alignment')
    assertEquals(idsOf(arrived.editPatches).sort(), ['p-loft', 'p-move-kitchen', 'p-note-hall', 'p-note-kitchen'].sort(), 'the hall\'s matrix is not carried')
    assertEquals(idsOf(arrived.comments!).sort(), ['c-hall', 'c-kitchen', 'c-loft'])
    assertEquals(idsOf(arrived.jobs).sort(), ['j-hall', 'j-kitchen'])

    const status = (await server.send('GET', '/projects/proj-b/frame-status')).json as FrameStatus
    assertEquals(status.scansByFrame, { 'gen-a': 1, 'gen-b': 2 }, 'the kitchen is a previous reference, the visit and the study are on the current one')
    assertEquals(status.unrecordedScans, 1)
    assertEquals(status.notInFrameScans, 1)

    // Asking again is what a retry does: the source is gone, and that is a success that moved nothing.
    const again = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals([again.status, (again.json as { alreadyMerged: boolean }).alreadyMerged], [200, true])
  } finally {
    await server.stop()
  }
})

Deno.test('a merge the request accepts across frames makes the source\'s reference a previous reference of the target: it is in the history, and its photos are the target\'s to serve', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a', acceptFrameMismatch: true })
    assertEquals(merged.status, 200, merged.text)
    const status = (await server.send('GET', '/projects/proj-b/frame-status')).json as FrameStatus
    assertEquals(status.frameId, 'gen-b', 'the target keeps its own frame')
    assertEquals(status.revision, 1, 'and its revision: nothing it holds was written')
    assertEquals(status.history.map((entry) => [entry.frameId, entry.reason]), [['gen-0', 'override'], ['gen-a', 'merge']], 'what House A held before, and what it held when it was merged, oldest first')
    assertEquals(status.history[1], { frameId: 'gen-a', createdAt: AT_A, method: 'two-point-ground', separationM: 2, supersededAt: status.history[1]!.supersededAt, reason: 'merge' })
    assertEquals(status.scansByFrame, { 'gen-a': 1, 'gen-b': 2 }, 'the kitchen is listed against the generation the history now describes')

    // The photos of that generation are in the target's own folder: the Place that held them is gone.
    const photoReply = await server.send('GET', '/projects/proj-b/frames/gen-a/ref-landmark.jpg')
    assertEquals([photoReply.status, textOf(photoReply.bytes)], [200, 'landmark of generation a'])
    assertEquals((await server.upload('/projects/proj-b/frames/gen-a/reference-photos', bytesOf('late heading'), photoMeta('heading'))).status, 200, 'a generation the Place has held may still be sent its photos')
    // The merged-away Place's folder goes with the Place (the privacy rule: nothing names its photos again), after the target
    // took the copies it keeps. So the target's copy, read above, is the one left, and the source's is gone.
    assertEquals((await server.send('GET', '/projects/proj-a/frames/gen-a/ref-landmark.jpg')).status, 404, 'the merged Place\'s own copy is removed with its folder')
  } finally {
    await server.stop()
  }
})

Deno.test('a scan moved across frames with the flag brings the generation it was measured against into the target\'s history, with its photos, and not the generations the other Place held before', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { acceptFrameMismatch: true })
    assertEquals(moved.status, 200, moved.text)
    const status = (await server.send('GET', '/projects/proj-b/frame-status')).json as FrameStatus
    assertEquals(status.history.map((entry) => [entry.frameId, entry.reason]), [['gen-a', 'merge']])
    assertEquals(status.scansByFrame, { 'gen-a': 1, 'gen-b': 1 })
    assertEquals(textOf((await server.send('GET', '/projects/proj-b/frames/gen-a/ref-landmark.jpg')).bytes), 'landmark of generation a')
    // The same scan moved again changes nothing more: the generation is described once.
    assertEquals((await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, { areaId: null })).status, 200)
    assertEquals(((await server.send('GET', '/projects/proj-b/frame-status')).json as FrameStatus).history.length, 1)
    // A scan that names no generation has none to bring.
    assertEquals((await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(LOFT)}`, { acceptFrameMismatch: true })).status, 200)
    assertEquals(((await server.send('GET', '/projects/proj-b/frame-status')).json as FrameStatus).history.length, 1)
  } finally {
    await server.stop()
  }
})

Deno.test('a merge into a Place with no frame gives it the source\'s frame, its photos and its history; a merge of the same generation, or of a source with no frame, needs no flag', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      const registry = JSON.parse(await Deno.readTextFile(dirs.projects)) as Array<Record<string, unknown>>
      registry.push(
        placeRecord('proj-twin', 'House A (copy)', { spatialFrame: GEN_A, spatialFrameRevision: 1 }),
        placeRecord('proj-empty', 'Garage'),
      )
      await writeRegistry(dirs, registry)
    },
  })
  try {
    // The Shed has no frame: it takes House A's, and the generations House A had before it.
    const into = await server.send('POST', '/projects/proj-c/merge', { sourceProjectId: 'proj-a' })
    assertEquals(into.status, 200, into.text)
    const shed = await getPlace(server, 'proj-c')
    assertEquals(shed.spatialFrameRevision, 1)
    const copy = shed.spatialFrame as { frameId: string; referencePhotos: { landmark: { url: string | null } } }
    assertEquals(copy.frameId, 'gen-a')
    assertEquals(copy.referencePhotos.landmark.url, '/projects/proj-c/frames/gen-a/ref-landmark.jpg')
    assertEquals(textOf((await server.send('GET', copy.referencePhotos.landmark.url!)).bytes), 'landmark of generation a')
    assertEquals(shed.frameHistory?.map((entry) => entry.frameId), ['gen-0'], 'so the scans of that generation stay listed')
    assertEquals((await server.worldFile('project-proj-c')).scans.find((scan) => scan.filename === KITCHEN)!.localToWorld, MOVED)

    // A Place that holds the same generation: no flag. A source with no frame: no flag.
    const same = await server.send('POST', '/projects/proj-twin/merge', { sourceProjectId: 'proj-c' })
    assertEquals(same.status, 200, same.text)
    const nothing = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-empty' })
    assertEquals(nothing.status, 200, nothing.text)
    assertEquals((await getPlace(server, 'proj-b')).spatialFrame, GEN_B)
    // The old guards are as they were.
    assertEquals((await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-b' })).status, 400)
    assertEquals((await server.send('POST', '/projects/proj-b/merge', {})).status, 400)
    assertEquals((await server.send('POST', '/projects/proj-zzz/merge', { sourceProjectId: 'proj-twin' })).status, 404)
  } finally {
    await server.stop()
  }
})

Deno.test('every frame stored today has no id and most have photos: the Place that took such a frame is in its frame, so the next scan and a merge of the Place it came from are not refused', async () => {
  const ONE = '1700000000101_one.glb'
  const TWO = '1700000000102_two.glb'
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [
        placeRecord('proj-x', 'Old house', {
          spatialFrame: {
            ...LEGACY_1,
            referencePhotos: {
              landmark: photo('/projects/proj-x/reference-photos/ref-landmark.jpg', 'proj-x:landmark'),
              headingMarker: photo('/projects/proj-x/reference-photos/ref-headingMarker.jpg', 'proj-x:headingMarker'),
            },
          },
          spatialFrameRevision: 1,
        }),
        placeRecord('proj-y', 'New house'),
      ])
      await Deno.mkdir(`${dirs.media}/proj-x`, { recursive: true })
      await Deno.writeFile(`${dirs.media}/proj-x/ref-landmark.jpg`, bytesOf('landmark'))
      await Deno.writeFile(`${dirs.media}/proj-x/ref-headingMarker.jpg`, bytesOf('heading'))
      await writeScan(dirs, ONE, sidecar('proj-x', 'one', 'two-point'))
      await writeScan(dirs, TWO, sidecar('proj-x', 'two', 'two-point'))
    },
  })
  try {
    // The first scan gives the empty Place the frame, and the copy names the Place's own photo files, not the old Place's.
    const first = await server.send('PATCH', `/projects/proj-y/scans/${scanIdOf(ONE)}`, {})
    assertEquals(first.status, 200, first.text)
    const copy = (await getPlace(server, 'proj-y')).spatialFrame as ProjectSpatialFrame & { referencePhotos: { landmark: { url: string | null } } }
    assertEquals(copy.referencePhotos.landmark.url, '/projects/proj-y/reference-photos/ref-landmark.jpg')
    assertEquals(textOf((await server.send('GET', copy.referencePhotos.landmark.url!)).bytes), 'landmark')

    // The copy is the frame, whatever files it names: the second scan of the same Place is in it, and so is the Place itself.
    const second = await server.send('PATCH', `/projects/proj-y/scans/${scanIdOf(TWO)}`, {})
    assertEquals(second.status, 200, second.text)
    const merge = await server.send('POST', '/projects/proj-y/merge', { sourceProjectId: 'proj-x' })
    assertEquals(merge.status, 200, merge.text)
    assertEquals(await filedUnder(server, ONE), 'proj-y')
    assertEquals(await filedUnder(server, TWO), 'proj-y')

    // A frame that is another reference is still told apart: a Place with one calibration does not take scans of another.
    const other = await server.send('PATCH', '/projects/proj-y/scans/none', {})
    assertEquals(other.status, 404, 'a scan nobody has is not found, and not judged')
  } finally {
    await server.stop()
  }
})

Deno.test('two Places from before ids, with different calibrations, are still two frames: a merge across them is a 409, photos or none', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [
        placeRecord('proj-x', 'Old house', {
          spatialFrame: { ...LEGACY_1, referencePhotos: { landmark: photo('/projects/proj-x/reference-photos/ref-landmark.jpg', 'k'), headingMarker: photo(null, 'k2') } },
          spatialFrameRevision: 1,
        }),
        placeRecord('proj-y', 'New house', { spatialFrame: { ...LEGACY_2, referencePhotos: { landmark: photo('/projects/proj-y/reference-photos/ref-landmark.jpg', 'k3'), headingMarker: photo(null, 'k4') } }, spatialFrameRevision: 1 }),
      ])
      await writeScan(dirs, '1700000000101_one.glb', sidecar('proj-x', 'one', 'two-point'))
    },
  })
  try {
    const merge = await server.send('POST', '/projects/proj-y/merge', { sourceProjectId: 'proj-x' })
    assertEquals(merge.status, 409, merge.text)
    assertEquals((merge.json as { code: string }).code, 'frame-mismatch')
    const move = await server.send('PATCH', `/projects/proj-y/scans/${scanIdOf('1700000000101_one.glb')}`, {})
    assertEquals(move.status, 409, move.text)
  } finally {
    await server.stop()
  }
})

Deno.test('a merge reports on the scans it moved: another scan the same world is waiting to hand to a world that cannot be read is not the merge\'s', async () => {
  const ZETA = '1700000000007_zeta.glb'
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      // A scan filed under another Place by hand, which House A's world still lists, and that Place's own world file is cut short.
      const registry = JSON.parse(await Deno.readTextFile(dirs.projects)) as Array<Record<string, unknown>>
      await writeRegistry(dirs, [...registry, placeRecord('proj-z', 'Annexe')])
      await writeScan(dirs, ZETA, sidecar('proj-z', 'Zeta', 'none'))
      const houseA = JSON.parse(await Deno.readTextFile(`${dirs.worlds}/project-proj-a.json`)) as WorldProject
      await writeWorld(dirs, { ...houseA, scans: [...houseA.scans, row(ZETA, 'proj-a', 'none')] })
      await Deno.writeTextFile(`${dirs.worlds}/project-proj-z.json`, '{"worldId":"world-project-proj-z","scans":[')
    },
  })
  try {
    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a', acceptFrameMismatch: true })
    assertEquals(merged.status, 200, merged.text)
    const report = (merged.json as { handOver?: { pending?: number; placementsKept?: number } }).handOver
    assertEquals(report?.pending, undefined, 'what the merge moved has arrived: the Annexe\'s scan is waiting for its own reasons')
    assertEquals(report?.placementsKept, 1, 'and the hall, placed by House A\'s origin, keeps the placement it was given there')
    // The Annexe's scan is still where it was, with nothing taken from it, and the merge's scans are in House B's world.
    assertEquals((await server.worldFile('project-proj-a')).scans.map((scan) => scan.filename), [ZETA])
    assertEquals((await server.worldFile('project-proj-b')).scans.some((scan) => scan.filename === KITCHEN), true)
  } finally {
    await server.stop()
  }
})

// ── Photos ───────────────────────────────────────────────────────────────────────────────────────

Deno.test('photos belong to their frame: a new generation never shows or overwrites the one before, and the legacy route is closed once a Place\'s frame has an id', async () => {
  const server = await startServer({
    seed: (dirs) => writeRegistry(dirs, [placeRecord('proj-a', 'House', { spatialFrame: LEGACY_1 })]),
  })
  try {
    // 1. A Place whose frame predates ids: its photos go to the Place's own folder, as the phone's frame code sends them,
    //    and a role uploaded again replaces its own file, as it always did.
    const legacyUp = await server.upload('/projects/proj-a/reference-photos', bytesOf('legacy landmark'), photoMeta('landmark'))
    assertEquals(legacyUp.status, 200, legacyUp.text)
    assertEquals((legacyUp.json as { url: string }).url, '/projects/proj-a/reference-photos/ref-landmark.jpg')
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/reference-photos/ref-landmark.jpg')).bytes), 'legacy landmark')
    assertEquals((await server.upload('/projects/proj-a/reference-photos', bytesOf('legacy landmark, retaken'), photoMeta('landmark'))).status, 200)
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/reference-photos/ref-landmark.jpg')).bytes), 'legacy landmark, retaken')

    // 2. It becomes generation a: the legacy route stops taking photos, and the frame's own route takes them.
    const upgraded = await putFrame(server, 'proj-a', { frame: GEN_A, expectedRevision: 0, replaces: { frameId: null, reason: 'upgrade' } })
    assertEquals(upgraded.status, 200, upgraded.text)
    const closed = await server.upload('/projects/proj-a/reference-photos', bytesOf('late legacy photo'), photoMeta('landmark'))
    assertEquals(closed.status, 409)
    assertEquals((closed.json as { code: string }).code, 'legacy-photos-closed')
    assert((closed.json as { error: string }).error.length > 0)
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/reference-photos/ref-landmark.jpg')).bytes), 'legacy landmark, retaken', 'the earlier frame\'s photo was not written over')
    assertEquals((await server.upload('/projects/proj-a/reference-photos', bytesOf('new role'), photoMeta('headingMarker'))).status, 409, 'nor does a role it has no photo for take one')

    const landmarkA = await server.upload('/projects/proj-a/frames/gen-a/reference-photos', bytesOf('landmark of a'), photoMeta('landmark'))
    assertEquals(landmarkA.status, 200, landmarkA.text)
    assertEquals(landmarkA.json, { ok: true, role: 'landmark', url: '/projects/proj-a/frames/gen-a/ref-landmark.jpg' })
    // The capture flow calls the heading marker `heading`, and the legacy name for it is accepted and answered as `heading`.
    const headingA = await server.upload('/projects/proj-a/frames/gen-a/reference-photos', bytesOf('heading of a'), photoMeta('headingMarker'))
    assertEquals(headingA.json, { ok: true, role: 'heading', url: '/projects/proj-a/frames/gen-a/ref-heading.jpg' })
    const checkA = await server.upload('/projects/proj-a/frames/gen-a/reference-photos', bytesOf('check of a'), photoMeta('check1'))
    assertEquals((checkA.json as { url: string }).url, '/projects/proj-a/frames/gen-a/ref-check1.jpg')

    const served = await server.send('GET', '/projects/proj-a/frames/gen-a/ref-landmark.jpg')
    assertEquals([served.status, textOf(served.bytes), served.headers.get('content-type')], [200, 'landmark of a', 'image/jpeg'])

    // 3. Generation b replaces a: its photos are its own, and a's are still where they were.
    assertEquals((await putFrame(server, 'proj-a', { frame: GEN_B, expectedRevision: 1, replaces: { frameId: 'gen-a', reason: 'override' } })).status, 200)
    assertEquals((await server.upload('/projects/proj-a/frames/gen-b/reference-photos', bytesOf('landmark of b'), photoMeta('landmark'))).status, 200)
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/frames/gen-b/ref-landmark.jpg')).bytes), 'landmark of b')
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/frames/gen-a/ref-landmark.jpg')).bytes), 'landmark of a', 'an old photo never shows with a new record, nor is overwritten by it')
    assertEquals((await server.send('GET', '/projects/proj-a/frames/gen-b/ref-heading.jpg')).status, 404, 'b has no heading photo, and does not show a\'s')
    // A late upload for the generation that was replaced still lands with that generation.
    assertEquals((await server.upload('/projects/proj-a/frames/gen-a/reference-photos', bytesOf('late heading of a'), photoMeta('heading'))).status, 200)
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/frames/gen-a/ref-heading.jpg')).bytes), 'late heading of a')
    // The same role again, within a generation, replaces its own file (a retry whose reply was lost).
    assertEquals((await server.upload('/projects/proj-a/frames/gen-b/reference-photos', bytesOf('landmark of b, again'), photoMeta('landmark'))).status, 200)
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/frames/gen-b/ref-landmark.jpg')).bytes), 'landmark of b, again')
    assertEquals(textOf((await server.send('GET', '/projects/proj-a/reference-photos/ref-landmark.jpg')).bytes), 'legacy landmark, retaken', 'and the legacy photo was never touched')

    // The folder of a frame keeps the index of what it was sent, beside the photos.
    const index = JSON.parse(await Deno.readTextFile(`${server.dirs.media}/proj-a/frames/gen-a/reference-photos.json`)) as Record<string, { file: string; bytes: number }>
    assertEquals(Object.keys(index).sort(), ['check1', 'heading', 'landmark'])
    assertEquals(index['landmark']!.file, 'ref-landmark.jpg')
  } finally {
    await server.stop()
  }
})

Deno.test('frame photos are refused for a frame the Place never had, a frame or Place id that is not safe, a role that is not one, and a body that is not a photo', async () => {
  const server = await startServer({
    seed: (dirs) => writeRegistry(dirs, [placeRecord('proj-a', 'House', { spatialFrame: GEN_B, spatialFrameRevision: 2, frameHistory: [{ frameId: 'gen-a', createdAt: AT_A, method: 'two-point-ground', separationM: 2, supersededAt: AT_B, reason: 'override' }] })]),
  })
  try {
    const ok = (path: string, role = 'landmark') => server.upload(path, bytesOf('photo'), photoMeta(role))
    assertEquals((await ok('/projects/proj-a/frames/gen-b/reference-photos')).status, 200, 'the frame it holds')
    assertEquals((await ok('/projects/proj-a/frames/gen-a/reference-photos')).status, 200, 'a frame it held')
    // A frame that lost a race to another device's, or never was: the winner's photos cannot be written over.
    assertEquals((await ok('/projects/proj-a/frames/gen-lost/reference-photos')).status, 404)
    assertEquals((await server.send('GET', '/projects/proj-a/frames/gen-lost/ref-landmark.jpg')).status, 404)
    assertEquals(await Deno.stat(`${server.dirs.media}/proj-a/frames/gen-lost`).then(() => true, () => false), false, 'no folder was made for it')
    // Ids that are not safe in a path or a folder name.
    // (A client normalises `..` and `%2e%2e` away before it sends, so those arrive as the Place's own legacy route, which is closed.)
    for (const frameId of ['..', 'a.b', 'a%2Fb', '%2e%2e', 'x'.repeat(65)]) {
      const reply = await ok(`/projects/proj-a/frames/${frameId}/reference-photos`)
      assert([400, 404, 409].includes(reply.status), `${frameId}: ${reply.status}`)
    }
    assertEquals(await Deno.stat(`${server.dirs.media}/proj-a/ref-landmark.jpg`).then(() => true, () => false), false, 'nothing reached the Place\'s own folder')
    assertEquals((await ok('/projects/..%2Fproj-a/frames/gen-b/reference-photos')).status, 400)
    assertEquals((await ok('/projects/proj-nowhere/frames/gen-b/reference-photos')).status, 404)
    // Roles.
    assertEquals((await ok('/projects/proj-a/frames/gen-b/reference-photos', 'check4')).status, 400)
    assertEquals((await ok('/projects/proj-a/frames/gen-b/reference-photos', '../landmark')).status, 400)
    assertEquals((await ok('/projects/proj-a/frames/gen-b/reference-photos', 'check3')).status, 200)
    // Not a photo: no image, no meta, a tap point off the picture.
    const bare = await server.send('POST', '/projects/proj-a/frames/gen-b/reference-photos', {})
    assertEquals(bare.status, 400, bare.text)
    const off = await server.upload('/projects/proj-a/frames/gen-b/reference-photos', bytesOf('photo'), { ...photoMeta('landmark'), tapPoint: { x: 4, y: 0.5 } })
    assertEquals(off.status, 400)
    // Serving is an allowlist of names.
    for (const file of ['ref-landmark.png', '..%2F..%2Fprojects.json', 'reference-photos.json', 'ref-%2e%2e.jpg', 'ref-headingMarker.jpg']) {
      const reply = await server.send('GET', `/projects/proj-a/frames/gen-b/${file}`)
      assert([400, 404].includes(reply.status), `${file}: ${reply.status}`)
      assert(!reply.text.includes('"projectId"'), `${file} served the registry`)
    }
    assertEquals((await server.send('GET', '/projects/proj-a/frames/gen-b/ref-check2.jpg')).status, 404, 'a role with no photo is not found')
  } finally {
    await server.stop()
  }
})

// ── Thing matching ───────────────────────────────────────────────────────────────────────────────

Deno.test('Thing matching leaves out the scans that are not in the Place frame, and says how many', async () => {
  const chair = (x: number) => ({ label: 'chair', confidence: 0.9, worldPos: { x, y: 0, z: 1 } })
  const CALIBRATED = '1700000000011_calibrated.glb'
  const SKIPPED = '1700000000012_skipped.glb'
  const ONE_POINT = '1700000000013_one-point.glb'
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [placeRecord('proj-a', 'House', { spatialFrame: GEN_A, spatialFrameRevision: 1 })])
      await writeScan(dirs, CALIBRATED, sidecar('proj-a', 'calibrated', 'two-point', 'gen-a', { detections: [chair(1)], detectionCount: 1 }))
      await writeScan(dirs, SKIPPED, sidecar('proj-a', 'skipped', 'none', undefined, { detections: [chair(1.1)], detectionCount: 1 }))
      await writeScan(dirs, ONE_POINT, sidecar('proj-a', 'one-point', 'one-point', undefined, { detections: [chair(1.05)], detectionCount: 1 }))
      await writeWorld(dirs, worldOf('proj-a', {
        scans: [row(CALIBRATED, 'proj-a', 'two-point'), row(SKIPPED, 'proj-a', 'none'), row(ONE_POINT, 'proj-a', 'one-point', { calibrationMethod: 'ground-tap-compass', calibrationStatus: 'provisional' })],
      }))
    },
  })
  try {
    const queued = await server.send('POST', '/worlds/project-proj-a/jobs', { type: 'thing-correspondence' })
    assertEquals(queued.status, 202, queued.text)
    const jobId = (queued.json as WorldJob).jobId
    const deadline = Date.now() + JOB_TIMEOUT_MS
    let job: WorldJob | undefined
    while (Date.now() < deadline) {
      job = ((await server.send('GET', '/worlds/project-proj-a/jobs')).json as WorldJob[]).find((candidate) => candidate.jobId === jobId)
      if (job && (job.status === 'completed' || job.status === 'failed')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assertEquals(job?.status, 'completed', server.log())
    assertEquals(job!.artifacts![0]!.metadata, { things: 1, observations: 1, scansLeftOut: 2 })
    // The job list prints a job's result, so the person who sees Things stop appearing is told why there.
    assertEquals(job!.result, 'Thing correspondence resolved scan observations into durable cross-session objects. 2 scans were left out: they are not in the Place frame.')
    const world = (await server.send('GET', '/worlds/project-proj-a')).json as WorldProject
    assertEquals(world.thingObservations.map((observation) => observation.scanId), [scanIdOf(CALIBRATED)], 'only the calibrated scan made a Thing')
  } finally {
    await server.stop()
  }
})

// ── The guard ────────────────────────────────────────────────────────────────────────────────────

interface GuardMode {
  name: string
  env: Record<string, string>
  sessions: boolean
  /** The status a credential gets from a route behind the Companion session guard, past the guard. */
  allowed: (who: string) => boolean
}

const GUARD_MODES: GuardMode[] = [
  { name: 'sign-in on', env: SIGN_IN_ON, sessions: true, allowed: (who) => who === 'an allowlisted session' },
  { name: 'SCAN_REQUIRE_AUTH=1, sign-in off', env: { SCAN_REQUIRE_AUTH: '1' }, sessions: false, allowed: () => false },
  { name: 'an install open by design', env: {}, sessions: false, allowed: () => true },
]

for (const mode of GUARD_MODES) {
  Deno.test(`the frame routes are behind the guard the routes beside them are behind, ${mode.name}`, async () => {
    const server = await startServer({
      env: mode.env,
      seed: async (dirs) => {
        await seedHouses(dirs)
        await Deno.mkdir(`${dirs.media}/proj-b/frames/gen-b`, { recursive: true })
        await Deno.writeFile(`${dirs.media}/proj-b/frames/gen-b/ref-landmark.jpg`, bytesOf('b landmark'))
      },
    })
    try {
      const expiry = Math.floor(Date.now() / 1000) + 3600
      const credentials: Array<[string, string | undefined]> = [
        ['anonymous', undefined],
        ['a bearer that is not any account\'s', 'not-a-session'],
      ]
      if (mode.sessions) {
        credentials.push(
          ['a session for an account off the allowlist', await signSession({ sub: 'user-2', email: 'someone-else@example.com', exp: expiry }, SESSION_SECRET)],
          ['an allowlisted session', await signSession({ sub: 'user-1', email: OWNER_EMAIL, exp: expiry }, SESSION_SECRET)],
        )
      }
      const why = (what: string) => `${mode.name}: ${what}. Server log:\n${server.log()}`
      const marked = async () => JSON.stringify([
        await Deno.stat(`${server.dirs.media}/proj-b/frames/gen-b/ref-heading.jpg`).then(() => 'written', () => 'absent'),
        (await server.registry()).map((place) => place.projectId).sort(),
        JSON.parse(await Deno.readTextFile(`${server.dirs.scans}/${KITCHEN.replace('.glb', '.json')}`)).projectId,
      ])
      for (const [who, bearer] of credentials) {
        const allowed = mode.allowed(who)
        const sibling = await server.send('GET', '/projects/proj-b', undefined, bearer)
        assertEquals(sibling.status, allowed ? 200 : 401, why(`${who}: the Place itself`))

        const status = await server.send('GET', '/projects/proj-b/frame-status', undefined, bearer)
        assertEquals(status.status, sibling.status, why(`${who}: frame-status answers as the Place does`))
        const photo = await server.send('GET', '/projects/proj-b/frames/gen-b/ref-landmark.jpg', undefined, bearer)
        assertEquals(photo.status, allowed ? 200 : 401, why(`${who}: a frame photo`))
        assertEquals(allowed ? textOf(photo.bytes) : '', allowed ? 'b landmark' : '', why(`${who}: and only an allowed caller reads the bytes`))
        const legacy = await server.send('GET', '/projects/proj-b/reference-photos/ref-landmark.jpg', undefined, bearer)
        assertEquals(legacy.status === 401, !allowed, why(`${who}: the legacy photo route is behind the same guard`))

        const before = await marked()
        const upload = await server.upload('/projects/proj-b/frames/gen-b/reference-photos', bytesOf('heading'), photoMeta('heading'), bearer)
        assertEquals(upload.status, allowed ? 200 : 401, why(`${who}: a frame photo upload. ${upload.text}`))
        const merge = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' }, bearer)
        assertEquals(merge.status, allowed ? 409 : 401, why(`${who}: a merge reaches its own refusal only past the guard`))
        const move = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(KITCHEN)}`, {}, bearer)
        assertEquals(move.status, allowed ? 409 : 401, why(`${who}: and so does a moved scan`))
        if (!allowed) assertEquals(await marked(), before, why(`${who}: a refused call changed nothing`))
        else await Deno.remove(`${server.dirs.media}/proj-b/frames/gen-b/ref-heading.jpg`)
      }
    } finally {
      await server.stop()
    }
  })
}

Deno.test('a stranger cannot reach the frame routes through a path that merely looks like them', async () => {
  const server = await startServer({ env: SIGN_IN_ON, seed: seedHouses })
  try {
    const attempts = [
      await server.send('GET', '/projects/proj-a/frame-status/'),
      await server.send('GET', '/projects/proj-a/frame-status?token=x'),
      await server.send('GET', '/projects//frame-status'),
      await server.send('GET', '/projects/proj-a%2Fframe-status'),
      await server.send('GET', '/projects/proj-a/frames/gen-a/ref-landmark.jpg/'),
      await server.send('GET', '/projects/proj-a/frames//ref-landmark.jpg'),
      await server.upload('/projects/proj-a/frames/gen-a/reference-photos/', bytesOf('x'), photoMeta('landmark')),
    ]
    for (const reply of attempts) assertNotEquals(reply.status, 200, reply.text)
    assertEquals(await Deno.stat(`${server.dirs.media}/proj-a/frames/gen-a/ref-heading.jpg`).then(() => true, () => false), false)
  } finally {
    await server.stop()
  }
})
