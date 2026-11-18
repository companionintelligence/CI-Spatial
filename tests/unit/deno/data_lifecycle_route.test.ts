/**
 * What a merge, a move and a deletion leave on the server's disk, with the real server (docs/operations/PRIVACY.md,
 * section 5): the world and the export of a Place that a merge took out of the registry, the export of a world a scan
 * was moved out of, the placement a world kept for a scan that is gone, and the registry's own backup.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so a route cannot be called from a test in process.
 * Each test spawns the real server on a free port with every directory it writes in a temp folder (never the real data
 * directory), writes the Places, scans and worlds a previous build would have left there before it boots, and talks to
 * it over HTTP, the way frame_generations_route.test.ts and keyframe_routes.test.ts do.
 *
 * The oracle for "nothing is left" is not a function of the server's: it is a walk over every file under the temp
 * root for text only the Place's own records carried (an address, a coordinate, a Thing's label, a share token, a note
 * on the whole Place). It reads the registry, its backup, the worlds, the exports and the scans, whatever their names.
 *
 * What is pinned:
 *  - a merge takes the merged-away Place's world and its export with it, once nothing of the world is left to hand over,
 *    and nothing that only the two records carried is left anywhere, the registry's backup included; and says how many
 *    hand-set placements went with the world (`placementsRemoved`), counted from the world's own file, so that a repeat of the
 *    merge, which has nothing to hand over, counts them too;
 *  - what ADR 0011 says of that answer and of the address of a world that is gone is what the server does: every key of a
 *    real answer is named in its interface section, no world of the Place is listed, and the address is answered with a world
 *    of no Place that holds none of what the Place's world held;
 *  - a merge does not take it while a scan of that world is waiting to be handed to another world, or while a scan's record still
 *    names the Place, says so, and a repeat of the merge takes it once the scan has been handed over, with what was made of it;
 *  - a world that a merge of an earlier build left behind (its Place is not in the registry) goes with
 *    `DELETE /projects/:id`, which takes the Place's reference photos too, and with a repeat of the merge, after the notes of the
 *    scans it still lists have been handed over, and is kept, with a 409, while they cannot be;
 *  - a world that cannot be removed is a 500 with a fixed message that names no path, and a repeat of the merge finishes it;
 *  - deleting a scan takes the export of a world it was moved out of, and the placement that world kept for it, and no
 *    other Place's export; an export that cannot be read goes with a scan that was there, and a request for a scan that is
 *    not there is a 404 that removes nothing; clearing every scan takes what an emptied world and the world a scan went to
 *    still held; a world that cannot be written is a 500 and not a success over a row that is still there; and a deletion
 *    does not take another scan's job out of a world that holds no row for it;
 *  - deleting a Place takes its record out of the registry's backup, and a registry that cannot be read keeps the last
 *    backup that could be read, with the bytes that could not, through the one delete a write can make;
 *  - what docs/architecture.md says of the GLB route's cache header is the header the route sends, and `/capabilities`
 *    is behind the session guard whenever the guard is on, where a single world's reads are not, as its comment says.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import type { Project, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'
import { cannotRemoveFromReadOnlyFolder } from './read_only_folders.ts'

/** Root can write anywhere, so a test that makes its failure with permissions is ignored there, not passed. */
const CAN_MAKE_A_PERMISSION_FAILURE = await cannotRemoveFromReadOnlyFolder()

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 30_000

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  text: string
  json: unknown
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
  send(method: string, path: string, body?: unknown): Promise<Reply>
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
  const root = await Deno.makeTempDir({ prefix: 'data-lifecycle-' })
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
      args: ['run', '--no-prompt', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run', SERVER_ENTRY],
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
    return {
      dirs,
      send: async (method, path, body) => {
        const controller = new AbortController()
        const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          })
          const text = await res.text()
          let json: unknown = null
          try {
            json = JSON.parse(text)
          } catch { /* not JSON */ }
          return { status: res.status, text, json, headers: res.headers }
        } finally {
          clearTimeout(abort)
        }
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

// ── What the Places, scans and worlds hold ───────────────────────────────────────────────────────

const AT = '2026-11-16T08:00:00.000Z'
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
/** A placement set by hand: moved 2.5 m east and 1 m south. */
const MOVED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, -1, 1]
const EMPTY_GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }

/** Text that only the Place's own records carry. A scan's sidecar and a scan's row never do. */
const SECRET_ADDRESS = '12 Marker Lane'
const SECRET_LAT = 51.50149
const SECRET_LNG = -0.14187
const SECRET_THING = 'marker-vase'
const SECRET_TOKEN = 'tok-marker-owner-7f3a'
const SECRET_NOTE = 'marker-note-on-the-whole-place'
const SECRETS = [SECRET_ADDRESS, String(SECRET_LAT), String(SECRET_LNG), SECRET_THING, SECRET_TOKEN, SECRET_NOTE]

const KITCHEN = '1700000000001_kitchen.glb'
const HALL = '1700000000002_hall.glb'
const ZETA = '1700000000007_zeta.glb'
const STUDY = '1700000000005_study.glb'
/** `scan-<file>`: the id the server derives from the file name (server/scan_id.ts). */
const scanIdOf = (filename: string) => `scan-${filename.replace(/\.glb$/, '')}`

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

/** The Place whose record, world and export carry the secrets. */
function secretPlace(projectId: string): Record<string, unknown> {
  return placeRecord(projectId, 'House A', {
    address: SECRET_ADDRESS,
    geoPose: { lat: SECRET_LAT, lng: SECRET_LNG, altitudeM: null, bearing: null, accuracyM: null },
  })
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

/** The sidecar `src/export/gltf.ts` wrote for a scan: calibrated (placed by its own record) or not (placed by its world's origin). */
function sidecar(projectId: string, name: string, calibrated: boolean): Record<string, unknown> {
  return {
    projectId,
    areaId: null,
    sessionId: null,
    scanName: name,
    capturedAt: AT,
    exportedAt: AT,
    projectTransform: calibrated ? IDENTITY : null,
    calibrationMethod: calibrated ? 'two-point-ground' : null,
    calibrationStatus: calibrated ? 'verified' : 'uncalibrated',
    calibration: calibrated
      ? { method: 'two-point-ground', status: 'verified', sessionToProject: IDENTITY, calibratedAt: AT, separationM: 2, residualM: 0, toleranceM: 0.15, anchorBearingDeg: null }
      : null,
    pointCount: 5000,
    detectionCount: 0,
    labels: [],
    detections: [],
  }
}

async function writeScan(dirs: Dirs, filename: string, meta: Record<string, unknown>): Promise<void> {
  await Deno.writeFile(`${dirs.scans}/${filename}`, emptyGlb())
  await Deno.writeTextFile(`${dirs.scans}/${filename.replace(/\.glb$/, '.json')}`, JSON.stringify(meta))
}

function row(filename: string, projectId: string, calibrated: boolean): ScanManifest {
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
    capturedAt: AT,
    pointCount: 5000,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
    ...(calibrated ? { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' } : {}),
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
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  }
}

/** The world of the Place that carries the secrets: its origin on the map, a Thing, a share token, a note on the whole Place. */
function secretWorld(projectId: string, scans: ScanManifest[], extra: Partial<WorldProject> = {}): WorldProject {
  const worldId = `world-project-${projectId}`
  const origin = { lat: SECRET_LAT, lng: SECRET_LNG, altitudeM: null, bearing: null, accuracyM: null }
  return worldOf(projectId, {
    name: 'House A',
    originGeoPose: origin,
    localFrame: { type: 'ENU_Y_UP', origin, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans,
    things: [{
      thingId: 'thing-1',
      worldId,
      projectId,
      canonicalLabel: SECRET_THING,
      representativeTargetId: 'obj-1',
      position: { x: 1, y: 0, z: 2 },
      firstSeenScanId: scanIdOf(KITCHEN),
      lastSeenScanId: scanIdOf(KITCHEN),
      observationIds: [],
      createdAt: AT,
      updatedAt: AT,
      origin: 'matcher',
    }],
    members: [{ memberId: 'member-1', role: 'owner', token: SECRET_TOKEN, createdAt: AT }],
    comments: [
      { commentId: 'c-whole-place', worldId, body: SECRET_NOTE, actorId: 'local', actorRole: 'local', createdAt: AT },
      { commentId: 'c-hall', worldId, body: 'light switch', scanId: scanIdOf(HALL), actorId: 'local', actorRole: 'local', createdAt: AT },
    ],
    editPatches: [
      { patchId: 'p-move-hall', worldId, scanId: scanIdOf(HALL), targetId: HALL, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT },
      { patchId: 'p-note-hall', worldId, scanId: scanIdOf(HALL), targetId: HALL, scope: 'scan', notes: 'dark corner', createdAt: AT },
    ],
    ...extra,
  })
}

async function writeWorld(dirs: Dirs, world: WorldProject): Promise<void> {
  await Deno.writeTextFile(`${dirs.worlds}/${world.shareSlug}.json`, JSON.stringify(world, null, 2))
}

async function writeRegistry(dirs: Dirs, places: Array<Record<string, unknown>>): Promise<void> {
  await Deno.writeTextFile(dirs.projects, JSON.stringify(places, null, 2))
}

/** House A, whose world holds a calibrated kitchen and a hall placed by the world's origin (its hand-set placement stays in the world), and House B. */
async function seedHouses(dirs: Dirs): Promise<void> {
  await writeRegistry(dirs, [secretPlace('proj-a'), placeRecord('proj-b', 'House B')])
  await writeScan(dirs, KITCHEN, sidecar('proj-a', 'Kitchen', true))
  await writeScan(dirs, HALL, sidecar('proj-a', 'Hall', false))
  await writeWorld(dirs, secretWorld('proj-a', [row(KITCHEN, 'proj-a', true), row(HALL, 'proj-a', false)]))
  await Deno.writeTextFile(`${dirs.worlds}/project-proj-a.world.glb`, 'an export built from the scans of House A')
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Every file under `root`, whatever it is called, that holds one of `needles`, as `<path under root> holds "<needle>"`. Bytes are
 * read as Latin-1, so a text that is ASCII is found wherever it sits in a file, a GLB's JSON chunk included.
 */
async function filesHolding(root: string, needles: readonly string[]): Promise<string[]> {
  const found: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory) await visit(path)
      else if (entry.isFile) {
        const text = new TextDecoder('latin1').decode(await Deno.readFile(path))
        for (const needle of needles) if (text.includes(needle)) found.push(`${path.slice(root.length + 1)} holds ${JSON.stringify(needle)}`)
      }
    }
  }
  await visit(root)
  return found.sort()
}

/** The JSON text of a binary glTF, read here and not by anything of the server's: what the export says it holds. */
async function glbJsonText(path: string): Promise<string> {
  const bytes = await Deno.readFile(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assertEquals(view.getUint32(0, true), 0x46546c67, `${path} is a binary glTF`)
  const length = view.getUint32(12, true)
  assertEquals(view.getUint32(16, true), 0x4e4f534a, `${path} starts with its JSON chunk`)
  return new TextDecoder().decode(bytes.subarray(20, 20 + length))
}

const idsOf = (items: Array<{ patchId?: string; commentId?: string; jobId?: string }>) => items.map((item) => item.patchId ?? item.commentId ?? item.jobId)

const ADR_0011 = fromFileUrl(new URL('docs/adr/0011-frame-generations.md', REPO_ROOT))

/** The lines of `doc` from the first that starts with `from` up to the next that starts with `to`, which is not in it. Both must be there. */
function sectionOf(doc: string, from: string, to: string): string {
  const lines = doc.split('\n')
  const start = lines.findIndex((line) => line.startsWith(from))
  assert(start >= 0, `the document has a line that starts with ${JSON.stringify(from)}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith(to))
  assert(end > start, `and a later one that starts with ${JSON.stringify(to)}`)
  return lines.slice(start, end).join('\n')
}

/** Builds the export of a world with the server's own job and waits for it. */
async function buildExport(server: RunningServer, slug: string): Promise<void> {
  const queued = await server.send('POST', `/worlds/${slug}/jobs`, { type: 'export-world' })
  assertEquals(queued.status, 202, queued.text)
  const jobId = (queued.json as { jobId: string }).jobId
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const job = ((await server.send('GET', `/worlds/${slug}/jobs`)).json as WorldJob[]).find((item) => item.jobId === jobId)
    if (job?.status === 'completed') return
    if (job?.status === 'failed') throw new Error(`the export of ${slug} failed: ${job.error}\n${server.log()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`the export of ${slug} did not finish.\n${server.log()}`)
}

// ── A merge ──────────────────────────────────────────────────────────────────────────────────────

Deno.test('a merge takes the merged-away Place\'s world and its export with it, and nothing only its records carried is left on disk', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    // The premise: the secrets are on disk now, in the registry, the world and the export's neighbours.
    assert((await filesHolding(server.dirs.root, SECRETS)).length >= 4, 'the oracle finds the secrets while they are there')

    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(merged.status, 200, merged.text)
    const body = merged.json as { alreadyMerged: boolean; sourceWorldRemoved?: boolean; placementsRemoved?: number; handOver?: unknown }
    assertEquals(body.alreadyMerged, false)
    assertEquals(body.sourceWorldRemoved, true, 'the answer says the merged-away Place\'s world went with it')
    assertEquals(body.handOver, undefined, 'and does not say that a placement stayed in a world that is gone')
    // The hall is placed by House A's origin and was given a placement by hand, which ADR 0011 keeps in the world it was made in.
    // That world is gone, so the answer says how many went with it: the one, and not the note on the hall, which was handed over.
    assertEquals(body.placementsRemoved, 1, 'and how many hand-set placements went with it, so the person can be told')

    assertFalse(await exists(`${server.dirs.worlds}/project-proj-a.json`), 'the world of the Place that is not in the registry any more')
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-a.world.glb`), 'and the export built from it')
    assertEquals((await server.registry()).some((place) => place.projectId === 'proj-a'), false)

    // What was handed over is where it was meant to go, and what is not a scan's went with the world.
    const target = await server.worldFile('project-proj-b')
    assertEquals(target.scans.map((scan) => scan.filename).sort(), [HALL, KITCHEN].sort())
    assertEquals(idsOf(target.comments ?? []), ['c-hall'], 'the hall\'s note')
    assertEquals(idsOf(target.editPatches), ['p-note-hall'], 'the hall\'s note, not its placement, which is a position in the world that is gone')

    // The oracle: no file under the data root holds the address, the coordinates, the Thing, the token or the note.
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
  } finally {
    await server.stop()
  }
})

Deno.test('a merge whose world held no hand-set placement does not say that any went: `placementsRemoved` is only there when it is above zero', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [secretPlace('proj-a'), placeRecord('proj-b', 'House B')])
      // A calibrated scan is placed by its own record: its placement travels with it, and the world keeps none.
      await writeScan(dirs, KITCHEN, sidecar('proj-a', 'Kitchen', true))
      await writeWorld(dirs, secretWorld('proj-a', [row(KITCHEN, 'proj-a', true)], { editPatches: [] }))
    },
  })
  try {
    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(merged.status, 200, merged.text)
    assertEquals(Object.keys(merged.json as object).sort(), ['alreadyMerged', 'ok', 'project', 'sourceWorldRemoved'])
    assertEquals((merged.json as { sourceWorldRemoved: boolean }).sourceWorldRemoved, true)
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-a.json`))
  } finally {
    await server.stop()
  }
})

/** House A's seed with a scan that is filed under a third Place (the Annexe) whose world is cut short, so A's world is still waiting to hand it over. */
async function seedHousesWithAScanWaiting(dirs: Dirs): Promise<void> {
  await seedHouses(dirs)
  await writeRegistry(dirs, [secretPlace('proj-a'), placeRecord('proj-b', 'House B'), placeRecord('proj-z', 'Annexe')])
  await writeScan(dirs, ZETA, sidecar('proj-z', 'Zeta', false))
  const houseA = JSON.parse(await Deno.readTextFile(`${dirs.worlds}/project-proj-a.json`)) as WorldProject
  const worldId = houseA.worldId
  await writeWorld(dirs, {
    ...houseA,
    scans: [...houseA.scans, row(ZETA, 'proj-a', false)],
    comments: [...(houseA.comments ?? []), { commentId: 'c-zeta', worldId, body: 'the annexe\'s window', scanId: scanIdOf(ZETA), actorId: 'local', actorRole: 'local', createdAt: AT }],
  })
  await Deno.writeTextFile(`${dirs.worlds}/project-proj-z.json`, '{"worldId":"world-project-proj-z","scans":[')
}

Deno.test('a merge keeps the merged-away world while another scan is waiting in it, says so, and a repeat of the merge takes it once that scan has been handed over', async () => {
  const server = await startServer({ seed: seedHousesWithAScanWaiting })
  try {
    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(merged.status, 200, merged.text)
    const body = merged.json as { sourceWorldRemoved?: boolean; placementsRemoved?: number; handOver?: { pending?: number; placementsKept?: number } }
    assertEquals(body.handOver?.pending, undefined, 'what the merge moved has arrived: the Annexe\'s scan is waiting for its own reasons')
    assertEquals(body.sourceWorldRemoved, false, 'but the world still holds a scan whose notes have not reached the world they belong in, so it is not removed')
    assertEquals(body.handOver?.placementsKept, 1, 'the hall\'s placement is kept in a world that is kept')
    assertEquals(body.placementsRemoved, undefined, 'and nothing went with a world that stayed')
    const waiting = await server.worldFile('project-proj-a')
    assertEquals(waiting.scans.map((scan) => scan.filename), [ZETA], 'nothing was taken from the scan that is waiting')
    assertEquals(idsOf(waiting.comments ?? []).includes('c-zeta'), true)

    // The Annexe's world is repaired. The same merge, asked again, hands the scan over and then takes the world.
    await writeWorld(server.dirs, worldOf('proj-z'))
    const again = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(again.status, 200, again.text)
    assertEquals((again.json as { alreadyMerged: boolean; sourceWorldRemoved?: boolean }).alreadyMerged, true)
    assertEquals((again.json as { sourceWorldRemoved?: boolean }).sourceWorldRemoved, true)
    // A repeat has nothing to hand over, so its answer has no `handOver`: the count is of what the world held when it went.
    assertEquals((again.json as { handOver?: unknown }).handOver, undefined)
    assertEquals((again.json as { placementsRemoved?: number }).placementsRemoved, 1, 'the hall\'s placement, which the world had kept, went with it')
    const annexe = await server.worldFile('project-proj-z')
    assertEquals(idsOf(annexe.comments ?? []), ['c-zeta'], 'the scan\'s note was handed over before the world went')
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-a.json`))
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-a.world.glb`))
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
  } finally {
    await server.stop()
  }
})

Deno.test('a world that cannot be removed is a 500 with a fixed message, the Places stay merged, and a repeat of the merge finishes it', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedHouses(dirs)
      // An export that is a folder with something in it cannot be removed as a file.
      await Deno.remove(`${dirs.worlds}/project-proj-a.world.glb`)
      await Deno.mkdir(`${dirs.worlds}/project-proj-a.world.glb`)
      await Deno.writeTextFile(`${dirs.worlds}/project-proj-a.world.glb/inside`, 'x')
    },
  })
  try {
    const failed = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(failed.status, 500, failed.text)
    assertFalse(failed.text.includes(server.dirs.root), 'the answer names no path')
    assertStringIncludes((failed.json as { error: string }).error, 'could not be removed')
    assertEquals((await server.registry()).some((place) => place.projectId === 'proj-a'), false, 'the Places are merged: that is done')
    assert(await exists(`${server.dirs.worlds}/project-proj-a.json`), 'and the world, which still names the Place, is kept to be found again')

    await Deno.remove(`${server.dirs.worlds}/project-proj-a.world.glb`, { recursive: true })
    const again = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
    assertEquals(again.status, 200, again.text)
    assertEquals((again.json as { alreadyMerged: boolean; sourceWorldRemoved?: boolean }).alreadyMerged, true)
    assertEquals((again.json as { sourceWorldRemoved?: boolean }).sourceWorldRemoved, true)
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-a.json`))
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
  } finally {
    await server.stop()
  }
})

Deno.test({
  name: 'a merge that could not file a scan under the target keeps the merged-away world, and says so: that Place still holds the scan, whatever the registry says',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    // The scans' sidecars cannot be replaced, so no scan is filed under House B.
    await Deno.chmod(server.dirs.scans, 0o555)
    try {
      const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a' })
      assertEquals(merged.status, 200, merged.text)
      assertEquals((merged.json as { sourceWorldRemoved?: boolean }).sourceWorldRemoved, false)
      assert(await exists(`${server.dirs.worlds}/project-proj-a.json`), 'the world of the Place that still holds the scans is not removed')
    } finally {
      await Deno.chmod(server.dirs.scans, 0o755)
    }
    // And it is not removed by asking for the Place to be deleted either: the Place holds scans.
    const refused = await server.send('DELETE', '/projects/proj-a')
    assertEquals(refused.status, 409, refused.text)
    assertEquals((refused.json as { scanCount: number }).scanCount, 2)
    assert(await exists(`${server.dirs.worlds}/project-proj-a.json`))
  } finally {
    await server.stop()
  }
})

// ── A world a merge of an earlier build left behind ─────────────────────────────────────────────

/** The world of a Place that is not in the registry (an earlier build's merge took it out and left its world), with its export, beside a live Place's world. */
async function seedLeftBehind(dirs: Dirs): Promise<void> {
  await writeRegistry(dirs, [placeRecord('proj-b', 'House B')])
  await writeWorld(dirs, secretWorld('proj-gone', []))
  await Deno.writeTextFile(`${dirs.worlds}/project-proj-gone.world.glb`, 'an export built from the scans of a Place that is gone')
  await writeWorld(dirs, worldOf('proj-b', { name: 'House B' }))
  await Deno.writeTextFile(`${dirs.worlds}/project-proj-b.world.glb`, 'the export of House B')
  // Reference photos: the gone Place's, which a merge of an earlier build could not have removed, and House B's.
  for (const id of ['proj-gone', 'proj-b']) {
    await Deno.mkdir(`${dirs.media}/${id}`, { recursive: true })
    await Deno.writeTextFile(`${dirs.media}/${id}/ref-landmark.jpg`, `a photo of ${id}`)
  }
}

Deno.test('DELETE /projects/:id for a Place that is not in the registry takes the world it left behind and its export, and nothing else', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedLeftBehind(dirs)
      await Deno.mkdir(`${dirs.root}/victim`, { recursive: true })
      await Deno.writeTextFile(`${dirs.root}/victim/keep.txt`, 'keep')
    },
  })
  try {
    // An id that is not an id of any Place, and a path in the shape of one, remove nothing.
    for (const id of ['proj-nobody', '..%2Fvictim', '..%2F..%2Fvictim']) {
      const nothing = await server.send('DELETE', `/projects/${id}`)
      assertEquals(nothing.status, 404, `${id}: ${nothing.text}`)
    }
    assert(await exists(`${server.dirs.root}/victim/keep.txt`))
    assert(await exists(`${server.dirs.worlds}/project-proj-gone.json`), 'no other id took the world')

    const gone = await server.send('DELETE', '/projects/proj-gone')
    assertEquals(gone.status, 200, gone.text)
    assertEquals((gone.json as { worldsRemoved: number }).worldsRemoved, 1)
    // The world held a hand-set placement (p-move-hall), and a deletion does not count it: that is the merge's answer (ADR 0011, decision 7).
    assertEquals(Object.keys(gone.json as object).sort(), ['ok', 'referencePhotosRemoved', 'worldsRemoved'])
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-gone.json`))
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-gone.world.glb`))
    assert(await exists(`${server.dirs.worlds}/project-proj-b.json`), 'another Place\'s world stays')
    assert(await exists(`${server.dirs.worlds}/project-proj-b.world.glb`), 'and its export')
    assertEquals((gone.json as { referencePhotosRemoved: boolean }).referencePhotosRemoved, true)
    assertFalse(await exists(`${server.dirs.media}/proj-gone`), 'the reference photos of the Place that is gone are removed with it')
    assert(await exists(`${server.dirs.media}/proj-b/ref-landmark.jpg`), 'and another Place\'s are not')
    assertEquals((await server.registry()).map((place) => place.projectId).filter((id) => id !== 'proj-default'), ['proj-b'])
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
    assertEquals((await server.send('DELETE', '/projects/proj-gone')).status, 404, 'a second request finds nothing')
  } finally {
    await server.stop()
  }
})

/** The world left behind still lists a scan that is filed under House B and has a note in it: the note is waiting to be handed over. */
async function seedLeftBehindWithAScan(dirs: Dirs): Promise<void> {
  await seedLeftBehind(dirs)
  await writeScan(dirs, STUDY, sidecar('proj-b', 'Study', false))
  const gone = JSON.parse(await Deno.readTextFile(`${dirs.worlds}/project-proj-gone.json`)) as WorldProject
  await writeWorld(dirs, {
    ...gone,
    scans: [row(STUDY, 'proj-gone', false)],
    comments: [{ commentId: 'c-study', worldId: gone.worldId, body: 'the desk', scanId: scanIdOf(STUDY), actorId: 'local', actorRole: 'local', createdAt: AT }],
  })
}

Deno.test('a world left behind hands the notes of the scans it still lists over to the world they belong in, and then goes', async () => {
  const server = await startServer({ seed: seedLeftBehindWithAScan })
  try {
    const gone = await server.send('DELETE', '/projects/proj-gone')
    assertEquals(gone.status, 200, gone.text)
    assertEquals((gone.json as { worldsRemoved: number }).worldsRemoved, 1)
    assertEquals(idsOf((await server.worldFile('project-proj-b')).comments ?? []), ['c-study'], 'the note of the scan is in the world of the Place the scan is filed under')
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-gone.json`))
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
  } finally {
    await server.stop()
  }
})

Deno.test('a world left behind is kept, with a 409 and what it holds untouched, while the world its scan\'s notes are to go to cannot take them, and goes once it can', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedLeftBehindWithAScan(dirs)
      // House B's world is a file cut short, as a full disk or a crash can leave one.
      await Deno.writeTextFile(`${dirs.worlds}/project-proj-b.json`, '{"worldId":"world-project-proj-b","scans":[')
    },
  })
  try {
    const refused = await server.send('DELETE', '/projects/proj-gone')
    assertEquals(refused.status, 409, refused.text)
    assertFalse(refused.text.includes(server.dirs.root), 'the answer names no path')
    assertStringIncludes((refused.json as { error: string }).error, 'still being moved')
    const kept = await server.worldFile('project-proj-gone')
    assertEquals(kept.scans.map((scan) => scan.filename), [STUDY], 'nothing was taken from the world')
    assertEquals(idsOf(kept.comments ?? []).includes('c-study'), true)
    assert(await exists(`${server.dirs.worlds}/project-proj-gone.world.glb`), 'and its export is still there')

    await writeWorld(server.dirs, worldOf('proj-b', { name: 'House B' }))
    const gone = await server.send('DELETE', '/projects/proj-gone')
    assertEquals(gone.status, 200, gone.text)
    assertEquals(idsOf((await server.worldFile('project-proj-b')).comments ?? []), ['c-study'])
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-gone.json`))
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
  } finally {
    await server.stop()
  }
})

Deno.test('a registry that cannot be read does not say that any Place is gone: a Place in it keeps its world and photos, and nothing is reported removed', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      // A Place that has a world, an export and reference photos, and no scan. The registry holding it is cut short, as a crash can leave it.
      await writeWorld(dirs, secretWorld('proj-real', []))
      await Deno.writeTextFile(`${dirs.worlds}/project-proj-real.world.glb`, 'an export built from the scans of a Place')
      await Deno.mkdir(`${dirs.media}/proj-real`, { recursive: true })
      await Deno.writeTextFile(`${dirs.media}/proj-real/ref-landmark.jpg`, 'a photo of proj-real')
      await Deno.writeTextFile(dirs.projects, '[{"projectId":"proj-real","name":"House A","address":"12 Marker Lane"')
    },
  })
  try {
    // The registry reads as an empty list to a write, so every Place reads as one a merge took out. It cannot say so.
    const deleted = await server.send('DELETE', '/projects/proj-real')
    assertEquals(deleted.status, 500, deleted.text)
    assertFalse(deleted.text.includes(server.dirs.root), 'the answer names no path')
    const merged = await server.send('POST', '/projects/proj-default/merge', { sourceProjectId: 'proj-real' })
    assertEquals(merged.status, 200, merged.text)
    assertEquals((merged.json as { sourceWorldRemoved?: boolean }).sourceWorldRemoved, false)
    for (const path of [`${server.dirs.worlds}/project-proj-real.json`, `${server.dirs.worlds}/project-proj-real.world.glb`, `${server.dirs.media}/proj-real/ref-landmark.jpg`]) {
      assert(await exists(path), `${path.slice(server.dirs.root.length + 1)} is still there`)
    }
    assertEquals(await Deno.readTextFile(server.dirs.projects), '[{"projectId":"proj-real","name":"House A","address":"12 Marker Lane"', 'and the registry file is as it was: nothing saved over it')
  } finally {
    await server.stop()
  }
})

Deno.test('a registry that cannot be read keeps its last readable backup through the delete of the one Place a write can find, and the bytes that could not be read are kept beside it', async () => {
  const cutShort = '[{"projectId":"proj-1","name":"House A","address":"12 Marker Lane"'
  const server = await startServer({
    seed: async (dirs) => {
      // The last registry that could be read is the backup, and the file was cut short after it.
      await writeRegistry(dirs, [secretPlace('proj-1'), placeRecord('proj-2', 'House B')])
      await Deno.copyFile(dirs.projects, `${dirs.projects}.bak`)
      await Deno.writeTextFile(dirs.projects, cutShort)
    },
  })
  try {
    const lastReadable = await Deno.readTextFile(`${server.dirs.projects}.bak`)
    assertEquals((await server.send('GET', '/projects')).status, 500, 'the premise: the registry cannot be read')
    // A write reads the registry as an empty list with the default Place added, and that is the one Place a delete can find: the
    // guard that keeps a Place that is only missing from the list (above) does not apply to it, and the delete is a save.
    const deleted = await server.send('DELETE', '/projects/proj-default')
    assertEquals(deleted.status, 200, deleted.text)
    assertEquals(await Deno.readTextFile(`${server.dirs.projects}.bak`), lastReadable, 'the backup is byte for byte what it was: it still holds the two Places the file held')
    const aside = (await Array.fromAsync(Deno.readDir(server.dirs.root))).map((entry) => entry.name).filter((name) => name.startsWith('projects.json.corrupt-'))
    assertEquals(aside.length, 1, 'a copy of the bytes that could not be read was kept')
    assertEquals(await Deno.readTextFile(`${server.dirs.root}/${aside[0]}`), cutShort)
  } finally {
    await server.stop()
  }
})

Deno.test('a repeat of a merge takes the world an earlier merge left behind, once, and only the world of the Place named', async () => {
  const server = await startServer({ seed: seedLeftBehind })
  try {
    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-gone' })
    assertEquals(merged.status, 200, merged.text)
    assertEquals((merged.json as { alreadyMerged: boolean }).alreadyMerged, true)
    assertEquals((merged.json as { sourceWorldRemoved?: boolean }).sourceWorldRemoved, true)
    assertEquals((merged.json as { placementsRemoved?: number }).placementsRemoved, 1, 'the placement the world that was left behind still held')
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-gone.json`))
    assertFalse(await exists(`${server.dirs.worlds}/project-proj-gone.world.glb`))
    assert(await exists(`${server.dirs.worlds}/project-proj-b.json`), 'the target\'s world is not the source\'s')
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [])
  } finally {
    await server.stop()
  }
})

// ── What ADR 0011 says of a merge ────────────────────────────────────────────────────────────────

Deno.test('ADR 0011 says what a merge answers and what its removed world leaves: every key of a real answer is named in it, and the world list and a stale address are as it says', async () => {
  const server = await startServer({ seed: seedHouses })
  try {
    const adr = await Deno.readTextFile(ADR_0011)
    // The ADR wraps its lines, so a phrase is looked for in the text with its line breaks taken out.
    const flat = (text: string): string => text.replace(/\s+/g, ' ')
    const decision = flat(sectionOf(adr, '**A merge does not keep them.**', 'Queued and running jobs are dropped'))
    const interfaceBullet = flat(sectionOf(adr, '- `POST /projects/:id/merge`, body', '- Photos:'))
    const consequence = flat(sectionOf(adr, '**A merged-away Place\'s world is removed', '**The editor\'s Places panel'))

    const merged = await server.send('POST', '/projects/proj-b/merge', { sourceProjectId: 'proj-a', acceptFrameMismatch: true })
    assertEquals(merged.status, 200, merged.text)
    const answer = merged.json as Record<string, unknown>
    assertEquals(Object.keys(answer).sort(), ['alreadyMerged', 'ok', 'placementsRemoved', 'project', 'sourceWorldRemoved'], 'the premise: the keys of this answer')
    for (const key of Object.keys(answer)) assert(new RegExp(`\\b${key}\\b`).test(interfaceBullet), `the interface names \`${key}\`, a key of the answer`)
    // The new fields are explained, not only named, and so are the fields of an answer this seed does not make (a hand-over that is waiting).
    for (const key of ['sourceWorldRemoved', 'placementsRemoved', 'handOver', 'pending', 'placementsKept']) assertStringIncludes(interfaceBullet, `\`${key}\``)
    assertStringIncludes(decision, '`placementsRemoved`', 'and the decision says what a merge does with the placements a world kept')

    // "Removed, not emptied": the list holds no world that says it is House A's, and none that is House A's, empty.
    const list = async () => (await server.send('GET', '/worlds')).json as Array<{ shareSlug: string; projectId: string | null; scanCount: number }>
    assertEquals((await list()).filter((world) => world.projectId === 'proj-a' || world.shareSlug === 'project-proj-a'), [])
    assertFalse(consequence.includes('emptied world (`scanCount` 0)'), 'the paragraph does not say that an emptied world is listed')

    // A share link or a tab still open on House A's world: a world with no Place is built for the address, and it is not House A's.
    const stale = await server.send('GET', '/worlds/project-proj-a')
    assertEquals(stale.status, 200, stale.text)
    const world = stale.json as WorldProject
    assertEquals(world.projectId, null, 'it is the world of no Place')
    assertEquals(world.name, 'project proj a', 'named from the address')
    assertEquals(world.things, [], 'it holds none of the Place\'s Things')
    assertEquals(await filesHolding(server.dirs.root, SECRETS), [], 'and nothing of what the Place\'s world held (its address, location, Things, share tokens, notes) is on disk for it to hold')
    // Every stored scan is filed under a Place (House B, now), so none is unfiled, and it lists the stored scans of that Place instead.
    assertEquals(world.scans.map((scan) => scan.filename).sort(), [HALL, KITCHEN].sort())
    assertEquals((await server.send('GET', `/scans/${KITCHEN}`)).status, 200, 'the premise: those scans are stored, and filed under House B')
    // It is saved, so the list has it, as it has every world file, and it is a world of no Place that lists the scans it lists.
    assertEquals((await list()).filter((entry) => entry.shareSlug === 'project-proj-a').map((entry) => [entry.projectId, entry.scanCount]), [[null, 2]])
    for (const phrase of ['`projectId` null', 'no Place holds', 'up to eight', 'named from the address']) assertStringIncludes(consequence, phrase)
    assertFalse(consequence.includes('scanCount` 0'), 'and not an emptied world')
  } finally {
    await server.stop()
  }
})

// ── A scan deleted after it was moved ────────────────────────────────────────────────────────────

/** Houses A, B and C: A holds the kitchen and the hall (placed by the world's origin, with a hand-set placement), C holds the study. */
async function seedHousesWithExports(dirs: Dirs): Promise<void> {
  await writeRegistry(dirs, [placeRecord('proj-a', 'House A'), placeRecord('proj-b', 'House B'), placeRecord('proj-c', 'Shed')])
  await writeScan(dirs, KITCHEN, sidecar('proj-a', 'Kitchen', false))
  await writeScan(dirs, HALL, sidecar('proj-a', 'Hall', false))
  await writeScan(dirs, STUDY, sidecar('proj-c', 'Study', false))
  const worldId = 'world-project-proj-a'
  await writeWorld(dirs, worldOf('proj-a', {
    scans: [row(KITCHEN, 'proj-a', false), row(HALL, 'proj-a', false)],
    editPatches: [{ patchId: 'p-move-hall', worldId, scanId: scanIdOf(HALL), targetId: HALL, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT }],
  }))
  await writeWorld(dirs, worldOf('proj-c', { scans: [row(STUDY, 'proj-c', false)] }))
}

Deno.test('deleting a scan takes the export of the world it was moved out of, and the placement that world kept for it, and no other Place\'s export', async () => {
  const server = await startServer({ seed: seedHousesWithExports })
  try {
    await buildExport(server, 'project-proj-a')
    await buildExport(server, 'project-proj-c')
    const exportA = `${server.dirs.worlds}/project-proj-a.world.glb`
    const exportC = `${server.dirs.worlds}/project-proj-c.world.glb`
    assertStringIncludes(await glbJsonText(exportA), HALL, 'the export of House A holds a copy of the hall')
    assertStringIncludes(await glbJsonText(exportC), STUDY)

    // The hall is filed under House B. Its row leaves House A's world, and the placement set against House A's origin stays there.
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(HALL)}`, {})
    assertEquals(moved.status, 200, moved.text)
    const emptied = await server.worldFile('project-proj-a')
    assertEquals(emptied.scans.map((scan) => scan.filename), [KITCHEN], 'the world no longer lists the hall')
    assertEquals(idsOf(emptied.editPatches), ['p-move-hall'], 'and keeps the placement')
    assertStringIncludes(await glbJsonText(exportA), HALL, 'its export is as it was built: it still holds the hall')

    const deleted = await server.send('DELETE', `/scans/${encodeURIComponent(HALL)}`)
    assertEquals(deleted.status, 200, deleted.text)
    assertFalse(await exists(exportA), 'the export that held a copy of the hall went with it, though its world no longer lists the hall')
    assertEquals((await server.send('GET', '/worlds/project-proj-a/export.glb')).status, 404, 'and is not served')
    assert(await exists(exportC), 'the export of a Place that never held the hall is not touched')
    assertStringIncludes(await glbJsonText(exportC), STUDY)
    assertEquals(await filesHolding(server.dirs.worlds, [HALL, scanIdOf(HALL), 'p-move-hall']), [], 'and no world file names the hall any more, the kept placement included')
  } finally {
    await server.stop()
  }
})

Deno.test('deleting a scan that is not there is a 404 that removes nothing, whatever exports are in the worlds folder; deleting one that is there takes the exports that cannot be read', async () => {
  const unreadable = ['old-build.world.glb', 'empty.world.glb']
  const server = await startServer({
    seed: async (dirs) => {
      await seedHousesWithExports(dirs)
      // Exports no build of this server wrote: a text file, and a file with nothing in it.
      await Deno.writeTextFile(`${dirs.worlds}/${unreadable[0]}`, 'not a glTF at all')
      await Deno.writeFile(`${dirs.worlds}/${unreadable[1]}`, new Uint8Array(0))
    },
  })
  try {
    const absent = await server.send('DELETE', '/scans/1700000000099_nothing.glb')
    assertEquals(absent.status, 404, absent.text)
    assertEquals(absent.json, { error: 'Scan not found' })
    for (const name of unreadable) assert(await exists(`${server.dirs.worlds}/${name}`), `${name}: a request for a scan that is not there removed nothing`)

    // A scan that is there: it cannot be shown that an export that cannot be read holds no copy of it, so they go, and are counted.
    const deleted = await server.send('DELETE', `/scans/${encodeURIComponent(HALL)}`)
    assertEquals(deleted.status, 200, deleted.text)
    assertEquals((deleted.json as { deleted: { worldExports: number } }).deleted.worldExports, 2)
    for (const name of unreadable) assertFalse(await exists(`${server.dirs.worlds}/${name}`), `${name} went with the scan that was there`)
    // And the scan is not there any more: the same request is the 404 again.
    assertEquals((await server.send('DELETE', `/scans/${encodeURIComponent(HALL)}`)).status, 404)
  } finally {
    await server.stop()
  }
})

Deno.test('clearing every scan takes what a world emptied by a move still held for them, and what the world they went to was handed', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [placeRecord('proj-a', 'House A'), placeRecord('proj-b', 'House B')])
      await writeScan(dirs, HALL, sidecar('proj-a', 'Hall', false))
      // House B's world exists and has not been read since, so it will be handed the hall's note and build no row for the hall.
      await writeWorld(dirs, worldOf('proj-b', { name: 'House B' }))
      const worldId = 'world-project-proj-a'
      await writeWorld(dirs, worldOf('proj-a', {
        scans: [row(HALL, 'proj-a', false)],
        editPatches: [
          { patchId: 'p-move-hall', worldId, scanId: scanIdOf(HALL), targetId: HALL, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT },
          { patchId: 'p-note-hall', worldId, scanId: scanIdOf(HALL), targetId: HALL, scope: 'scan', notes: 'dark corner', createdAt: AT },
          { patchId: 'p-vase', worldId, targetId: 'thing-1', scope: 'thing', label: 'a vase', createdAt: AT },
        ],
        comments: [{ commentId: 'c-whole-place', worldId, body: 'a note on the whole Place', actorId: 'local', actorRole: 'local', createdAt: AT }],
      }))
    },
  })
  try {
    // The hall is filed under House B. Its note is handed to House B's world, which builds no row for it (a scan placed by its
    // world's origin brings none, and the world is not read again until something asks), and the placement set against House A's
    // origin stays in House A's, which has no row left.
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(HALL)}`, {})
    assertEquals(moved.status, 200, moved.text)
    const emptied = await server.worldFile('project-proj-a')
    assertEquals([emptied.scans.length, idsOf(emptied.editPatches)], [0, ['p-move-hall', 'p-vase']], 'the premise: House A holds no row, the kept placement, and a Thing\'s relabel')
    const handed = await server.worldFile('project-proj-b')
    assertEquals([handed.scans.length, idsOf(handed.editPatches)], [0, ['p-note-hall']], 'and House B holds the hall\'s note and no row')

    const cleared = await server.send('DELETE', '/scans?confirm=delete-all')
    assertEquals(cleared.status, 200, cleared.text)
    assertEquals(await filesHolding(server.dirs.worlds, [HALL, scanIdOf(HALL), 'p-move-hall', 'p-note-hall']), [], 'no world file names a scan that is gone')
    // What these worlds keep of their own is not a scan's, and stays.
    const left = await server.worldFile('project-proj-a')
    assertEquals(idsOf(left.editPatches), ['p-vase'], 'the Thing\'s relabel')
    assertEquals(idsOf(left.comments ?? []), ['c-whole-place'], 'and the note on the whole Place')
  } finally {
    await server.stop()
  }
})

Deno.test({
  name: 'a world that cannot be written makes the deletion of a scan a 500 and not a success over a row that is still there, and a second try finishes it',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  const server = await startServer({ seed: seedHousesWithExports })
  try {
    await Deno.chmod(server.dirs.worlds, 0o555)
    try {
      const refused = await server.send('DELETE', `/scans/${encodeURIComponent(HALL)}`)
      assertEquals(refused.status, 500, refused.text)
      assertFalse(refused.text.includes(server.dirs.root), 'the answer names no path')
      assertEquals((await server.worldFile('project-proj-a')).scans.some((scan) => scan.filename === HALL), true, 'the world does still list the scan, so the answer was right to say so')
    } finally {
      await Deno.chmod(server.dirs.worlds, 0o755)
    }
    const retry = await server.send('DELETE', `/scans/${encodeURIComponent(HALL)}`)
    assertEquals(retry.status, 200, retry.text)
    assertEquals(await filesHolding(server.dirs.worlds, [HALL, 'p-move-hall']), [])
  } finally {
    await server.stop()
  }
})

Deno.test('files in the worlds folder that are not worlds do not make a deletion fail, and are left as they are', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedHousesWithExports(dirs)
      await Deno.writeTextFile(`${dirs.worlds}/broken.json`, '{"worldId":"cut short","scans":[')
      await Deno.writeTextFile(`${dirs.worlds}/list.json`, '[]')
      await Deno.writeTextFile(`${dirs.worlds}/notes.json`, '{"notes":"not a world"}')
    },
  })
  try {
    const deleted = await server.send('DELETE', `/scans/${encodeURIComponent(HALL)}`)
    assertEquals(deleted.status, 200, deleted.text)
    assertEquals(await filesHolding(server.dirs.worlds, [HALL, 'p-move-hall']), [], 'and the world that held the hall is cleaned all the same')
    const cleared = await server.send('DELETE', '/scans?confirm=delete-all')
    assertEquals(cleared.status, 200, cleared.text)
    assertEquals(await Deno.readTextFile(`${server.dirs.worlds}/list.json`), '[]')
    assertEquals(await Deno.readTextFile(`${server.dirs.worlds}/notes.json`), '{"notes":"not a world"}')
    assertEquals(await Deno.readTextFile(`${server.dirs.worlds}/broken.json`), '{"worldId":"cut short","scans":[')
  } finally {
    await server.stop()
  }
})

Deno.test('deleting a scan does not take another scan\'s finished job out of a world that holds no row for it: the job travelled with its scan', async () => {
  // A guard on the deletion's own reach, not a test of a defect on the merge commit: a world is written back whenever the
  // deletion took anything out of it, and the rule that keeps only the jobs of scans a world lists is for the world the row left.
  const server = await startServer({
    seed: async (dirs) => {
      await writeRegistry(dirs, [placeRecord('proj-a', 'House A'), placeRecord('proj-b', 'House B')])
      await writeScan(dirs, KITCHEN, sidecar('proj-a', 'Kitchen', false))
      await writeScan(dirs, HALL, sidecar('proj-a', 'Hall', false))
      const worldId = 'world-project-proj-a'
      await writeWorld(dirs, worldOf('proj-a', {
        scans: [row(KITCHEN, 'proj-a', false), row(HALL, 'proj-a', false)],
        jobs: [{ jobId: 'j-hall', worldId, type: 'splat-train', status: 'completed', scanId: scanIdOf(HALL), capabilities: [], result: 'trained', createdAt: AT, updatedAt: AT }],
      }))
      // House B's world exists, and has not been read since: it will hold the hall's job and no row for the hall.
      await writeWorld(dirs, worldOf('proj-b', { name: 'House B' }))
    },
  })
  try {
    const moved = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf(HALL)}`, {})
    assertEquals(moved.status, 200, moved.text)
    const arrived = await server.worldFile('project-proj-b')
    assertEquals([arrived.scans.length, idsOf(arrived.jobs)], [0, ['j-hall']], 'the premise: House B holds the hall\'s finished job and no row for the hall')
    // The kitchen is another scan. House B's world holds nothing of it, and nothing of House B's is the request's to take.
    const deleted = await server.send('DELETE', `/scans/${encodeURIComponent(KITCHEN)}`)
    assertEquals(deleted.status, 200, deleted.text)
    assertEquals(idsOf((await server.worldFile('project-proj-b')).jobs), ['j-hall'], 'the hall\'s job is where it was handed to')
    assertEquals(idsOf((await server.worldFile('project-proj-a')).jobs), [], 'and nothing is left in House A\'s world for it either')
  } finally {
    await server.stop()
  }
})

// ── The registry's own backup ────────────────────────────────────────────────────────────────────

Deno.test('deleting a Place takes its record out of the registry\'s backup, and an edit of another Place still keeps one', async () => {
  const server = await startServer()
  try {
    const created = await server.send('POST', '/projects', { name: 'My Home', address: SECRET_ADDRESS, geoPose: { lat: SECRET_LAT, lng: SECRET_LNG, altitudeM: null, bearing: null, accuracyM: null } })
    assertEquals(created.status, 201, created.text)
    const home = (created.json as { projectId: string }).projectId
    // The registry's id is minted from the clock, so the second Place waits for the next millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const other = await server.send('POST', '/projects', { name: 'Elsewhere', address: '9 Other Road' })
    assertEquals(other.status, 201, other.text)
    const elsewhere = (other.json as { projectId: string }).projectId
    assertEquals((await filesHolding(server.dirs.root, [SECRET_ADDRESS])).length >= 2, true, 'the premise: the registry and its backup both hold the address')

    const gone = await server.send('DELETE', `/projects/${home}`)
    assertEquals(gone.status, 200, gone.text)
    assertEquals(await filesHolding(server.dirs.root, [SECRET_ADDRESS, String(SECRET_LAT)]), [], 'no file holds what the Place carried, the backup included')

    // The backup is still kept for the saves that do not remove a Place: an edit of the other Place leaves the registry before it.
    const before = await server.registry()
    const edited = await server.send('PUT', `/projects/${elsewhere}`, { ...before.find((place) => place.projectId === elsewhere), name: 'Elsewhere (renamed)' })
    assertEquals(edited.status, 200, edited.text)
    const backup = JSON.parse(await Deno.readTextFile(`${server.dirs.projects}.bak`)) as Project[]
    assertEquals(backup.find((place) => place.projectId === elsewhere)?.name, 'Elsewhere', 'the previous version of the registry')
  } finally {
    await server.stop()
  }
})

// ── Two claims about the server ──────────────────────────────────────────────────────────────────

Deno.test('docs/architecture.md says the cache header the GLB route sends', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await writeScan(dirs, KITCHEN, sidecar('proj-a', 'Kitchen', false))
    },
  })
  try {
    const served = await server.send('GET', `/scans/${KITCHEN}`)
    assertEquals(served.status, 200)
    const header = served.headers.get('cache-control')
    assert(header, 'the route sends a Cache-Control header')
    const doc = await Deno.readTextFile(fromFileUrl(new URL('docs/architecture.md', REPO_ROOT)))
    const rows = doc.split('\n').filter((line) => line.startsWith('| `/scans/:filename` | GET |'))
    assertEquals(rows.length, 1, 'the endpoint table has one row for the route')
    assertStringIncludes(rows[0]!, `\`${header}\``, `the row says the header the route sends (${header})`)
  } finally {
    await server.stop()
  }
})

Deno.test('/capabilities is behind the session guard when the guard is on, /health is not, a single world answers by its own token rules, and the comment over the route says as much', async () => {
  const server = await startServer({ env: { SCAN_REQUIRE_AUTH: '1' } })
  try {
    assertEquals((await server.send('GET', '/capabilities?versions=0')).status, 401)
    assertEquals((await server.send('GET', '/health')).status, 200)
    // The guard does not cover every route: the list of worlds and the data routes answer 401 ...
    for (const path of ['/worlds', '/projects', '/scans']) assertEquals((await server.send('GET', path)).status, 401, `${path} needs a session`)
    // ... and a single world is not behind it. It answers by its own token rules: a request with no token gets some of its reads
    // (not all of them), and none of its writes.
    for (const path of ['/worlds/default', '/worlds/default/patches', '/worlds/default/comments', '/worlds/default/jobs']) {
      assertEquals((await server.send('GET', path)).status, 200, `${path} answers a request that carries no token`)
    }
    for (const path of ['/worlds/default/share', '/worlds/default/export.glb']) assertEquals((await server.send('GET', path)).status, 401, `${path} wants a token`)
    assertEquals((await server.send('POST', '/worlds/default/comments', { body: 'a note' })).status, 401, 'and a write wants one too')
  } finally {
    await server.stop()
  }
  // So the comment over /capabilities must not say that only /health, the sign-in routes and the app stay open, or that every read
  // of a single world does: it says the 401, and that a single world answers by its own token rules.
  const main = await Deno.readTextFile(fromFileUrl(new URL('server/main.ts', REPO_ROOT)))
  const at = main.indexOf('GET /capabilities')
  assert(at > 0, 'the route has its comment')
  const comment = main.slice(main.lastIndexOf('/**', at), main.indexOf('*/', at)).replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ')
  assertStringIncludes(comment, 'SESSION_GUARDED_PATHS')
  assertStringIncludes(comment, '401')
  assertStringIncludes(comment, 'single world')
  assertStringIncludes(comment, 'token rules')
  assertFalse(/only\s+\/health/i.test(comment), 'and it does not say that only /health stays open')
  assertFalse(/single world's reads/i.test(comment), 'or that every read of a single world does')
})
