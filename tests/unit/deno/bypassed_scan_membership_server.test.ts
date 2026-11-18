/**
 * The real server, end to end: a scan that is in no Place frame is counted, listed, matched and moved as one that is not
 * (ADR 0011 decision 3; the marker a commit with a bypassed floor check writes, `outsidePlaceFrame`).
 *
 * tests/unit/deno/bypassed_scan_membership.test.ts holds the readers over hand-written sidecars, and
 * tests/unit/node/wp-bypass-membership.test.ts runs the real writer and exporter into them. What neither can say is whether the
 * marker survives the server's own path from a sidecar to the rows the world file stores and the filters read, which is where
 * Thing matching and the move guard take their facts from: `scanManifestFromStored` builds a row, `refreshWorldScans` lays it over
 * the stored one, the world is saved and loaded again. This spawns the real server (server/main.ts starts `Deno.serve` at import and
 * exports nothing, so, as in frame_generations_route.test.ts, it runs on a free port with every directory it writes in a temp
 * folder and the mock inference engine) over a Place that holds a frame and five scans, and speaks to it over HTTP:
 *
 *  - `GET /projects/:id/frame-status` counts the two scans that are in no frame with the scans that are not in one, never under the
 *    Place's generation, and `scansOnCurrentFrame` (what the replace dialog says a replacement strands) is only the scan that was
 *    measured against it;
 *  - the world's rows carry the marker for those two and for no other, and still do once a job has saved the world file;
 *  - a Thing-matching job leaves their detections out, and says how many scans it left out;
 *  - the guard on moving a scan to a Place that holds another frame refuses the scan that is in a frame and lets the others go.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import type { FrameStatus } from '../../../src/world/frame-generations.ts'
import type { ProjectSpatialFrame, ScanManifest, Thing, WorldJob, WorldProject } from '../../../src/world/types.ts'

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
}

interface Dirs {
  root: string
  scans: string
  worlds: string
  projects: string
}

interface RunningServer {
  dirs: Dirs
  send(method: string, path: string, body?: unknown): Promise<Reply>
  log(): string
  stop(): Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

async function startServer(seed: (dirs: Dirs) => Promise<void>): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'bypassed-membership-' })
  const dirs: Dirs = { root, scans: `${root}/scans`, worlds: `${root}/worlds`, projects: `${root}/projects.json` }
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
    await seed(dirs)
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
        PROJECT_MEDIA_DIR: `${root}/media`,
        STATIC_DIR: `${root}/no-static-bundle`,
        INFERENCE_MODE: 'mock',
        TAILSCALE_HOSTNAME: 'scan.test',
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
          return { status: res.status, text, json }
        } finally {
          clearTimeout(abort)
        }
      },
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

// ── What a phone uploaded, and what the Places hold ──────────────────────────────────────────────

const AT = '2026-11-16T08:00:00.000Z'
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const frame = (frameId: string, separationM: number): ProjectSpatialFrame => ({
  version: 1,
  createdAt: AT,
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: separationM },
  separationM,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  frameId,
}) as ProjectSpatialFrame

const placeRecord = (projectId: string, name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  projectId,
  name,
  placeType: 'building',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  areas: [{ areaId: `area-${projectId}`, name, kind: 'site', parentAreaId: null }],
  floors: [{ floorId: `floor-${projectId}`, name: 'Ground Floor', level: 0, rooms: [] }],
  ...extra,
})

/** A valid binary glTF whose scene has no nodes: enough for the server to hold a scan of. */
function emptyGlb(): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }))
  const padded = new Uint8Array(new ArrayBuffer(Math.ceil(json.length / 4) * 4)).fill(0x20)
  padded.set(json)
  const out = new Uint8Array(new ArrayBuffer(12 + 8 + padded.length))
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(padded, 20)
  return out
}

const twoPoint = (extra: Record<string, unknown>): Record<string, unknown> => ({
  method: 'two-point-ground',
  sessionToProject: IDENTITY,
  separationM: 3,
  residualM: 0,
  toleranceM: 0.168,
  anchorBearingDeg: null,
  calibratedAt: AT,
  status: 'provisional',
  groundY: -1.2,
  ...extra,
})

const onePoint: Record<string, unknown> = {
  method: 'ground-tap-compass',
  sessionToProject: IDENTITY,
  anchorBearingDeg: 0,
  calibratedAt: AT,
  status: 'provisional',
}

/** The sidecar `src/export/gltf.ts` uploads: the flat summaries, the generation it names, the whole record, and what the scan saw. */
function sidecar(name: string, calibration: Record<string, unknown>, label: string, at: { x: number; z: number }, flat: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-a',
    areaId: null,
    sessionId: null,
    scanName: name,
    capturedAt: AT,
    exportedAt: AT,
    projectTransform: IDENTITY,
    calibrationMethod: calibration['method'],
    calibrationStatus: calibration['status'],
    calibration,
    pointCount: 5000,
    detectionCount: 1,
    labels: [label],
    detections: [{ label, confidence: 0.9, worldPos: { x: at.x, y: 0, z: at.z } }],
    ...flat,
  }
}

/** Each scan sees one thing of its own, so which scans a Thing-matching job read can be told from the Things it made. */
const SCANS = {
  // Two first visits that bypassed the floor check: each placed its own pair and wrote no frame.
  '1700000000001_outside_a.glb': sidecar('outside_a', twoPoint({ floorCheckBypassed: true, outsidePlaceFrame: true }), 'lamp', { x: 1, z: 1 }),
  '1700000000002_outside_b.glb': sidecar('outside_b', twoPoint({ floorCheckBypassed: true, outsidePlaceFrame: true, separationM: 3.7 }), 'plant', { x: 4, z: 2 }),
  // A bypassed visit that matched the frame the Place holds: provisional, and in it.
  '1700000000003_matched.glb': sidecar('matched', twoPoint({ floorCheckBypassed: true, frameId: 'gen-b', checkedBy: 'separation' }), 'chair', { x: 2, z: 2 }, { calibrationFrameId: 'gen-b' }),
  // A scan from a build before ids: an unknown generation, neutral, in the frame.
  '1700000000004_unknown.glb': sidecar('unknown', twoPoint({ checkedBy: 'separation' }), 'table', { x: 3, z: 3 }),
  '1700000000005_onepoint.glb': sidecar('onepoint', onePoint, 'sofa', { x: 5, z: 5 }),
} as const

const scanIdOf = (filename: string) => `scan-${filename.replace(/\.glb$/, '')}`

async function seed(dirs: Dirs): Promise<void> {
  await Deno.writeTextFile(dirs.projects, JSON.stringify([
    placeRecord('proj-a', 'House', { spatialFrame: frame('gen-b', 3), spatialFrameRevision: 2 }),
    placeRecord('proj-b', 'Annexe', { spatialFrame: frame('gen-c', 4), spatialFrameRevision: 1 }),
  ], null, 2))
  for (const [filename, meta] of Object.entries(SCANS)) {
    await Deno.writeFile(`${dirs.scans}/${filename}`, emptyGlb())
    await Deno.writeTextFile(`${dirs.scans}/${filename.replace(/\.glb$/, '.json')}`, JSON.stringify(meta))
  }
}

const byName = (world: WorldProject, name: string): ScanManifest => {
  const scan = world.scans.find((candidate) => candidate.name === name)
  assert(scan, `the world has no scan named ${name}: ${world.scans.map((s) => s.name).join(', ')}`)
  return scan
}

/** The world FILE as it is once the job is done: what the last write saw, read for itself. A torn read is tried again. */
async function worldFileOnceDone(dirs: Dirs, slug: string, jobId: string, server: RunningServer): Promise<WorldProject> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const world = JSON.parse(await Deno.readTextFile(`${dirs.worlds}/${slug}.json`)) as WorldProject
      const job = world.jobs.find((candidate) => candidate.jobId === jobId)
      if (job && (job.status === 'completed' || job.status === 'failed')) return world
    } catch { /* being written */ }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`job ${jobId} was not done in the world file after ${JOB_TIMEOUT_MS} ms\n${server.log()}`)
}

Deno.test({
  name: 'real server: a scan that is in no Place frame is counted, listed, matched and moved as one that is not',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer(seed)
    try {
      // ── The counts: what the replace dialog says a replacement strands ───────────────────────
      const reply = await server.send('GET', '/projects/proj-a/frame-status')
      assertEquals(reply.status, 200, `${reply.text}\n${server.log()}`)
      const status = reply.json as FrameStatus
      assertEquals(status.frameId, 'gen-b')
      assertEquals(status.scanCount, 5)
      assertEquals(status.scansByFrame, { 'gen-b': 1 }, 'only the visit that matched the frame is measured against it')
      assertEquals(status.unrecordedScans, 1, 'the scan from before ids is in the frame and cannot say which')
      assertEquals(status.notInFrameScans, 3, 'the two bypassed first visits are counted with the one-point scan')
      assertEquals(status.scansOnCurrentFrame, 1, 'a replacement strands the scan that was measured against the frame, and not the two that never were')

      // ── The rows the editor and the filters read ─────────────────────────────────────────────
      const world = (await server.send('GET', '/projects/proj-a/world')).json as WorldProject
      assertEquals(world.scans.length, 5)
      for (const name of ['outside_a', 'outside_b']) {
        assertEquals(byName(world, name).calibrationMethod, 'two-point-ground', `${name} keeps its tier: the scan is still placed by its own two points`)
        assertEquals((byName(world, name) as ScanManifest & { calibrationOutsidePlaceFrame?: true }).calibrationOutsidePlaceFrame, true, `${name}'s row says it is in no frame`)
      }
      for (const name of ['matched', 'unknown', 'onepoint']) {
        assertFalse('calibrationOutsidePlaceFrame' in byName(world, name), `${name}'s row says nothing of the kind`)
      }

      // ── Thing matching leaves them out, and says how many ────────────────────────────────────
      const queued = await server.send('POST', '/worlds/project-proj-a/jobs', { type: 'thing-correspondence' })
      assertEquals(queued.status, 202, queued.text)
      const file = await worldFileOnceDone(server.dirs, 'project-proj-a', (queued.json as WorldJob).jobId, server)
      const job = file.jobs.find((candidate) => candidate.jobId === (queued.json as WorldJob).jobId)!
      assertEquals(job.status, 'completed', `${job.error ?? ''}\n${server.log()}`)
      assertEquals(
        file.things.map((thing: Thing) => thing.canonicalLabel).sort(),
        ['chair', 'table'],
        'the Things come from the visit that matched and the scan of an unknown generation: not from the scans that are in no frame, nor the one-point scan',
      )
      assert(String(job.result).endsWith(' 3 scans were left out: they are not in the Place frame.'), `the job says so: ${job.result}`)
      // The marker is on the rows the world file stored, after the job saved it, and is read again from there.
      assertEquals((byName(file, 'outside_a') as ScanManifest & { calibrationOutsidePlaceFrame?: true }).calibrationOutsidePlaceFrame, true)
      assertFalse('calibrationOutsidePlaceFrame' in byName(file, 'matched'))
      const again = (await server.send('GET', '/projects/proj-a/world')).json as WorldProject
      assertEquals((byName(again, 'outside_b') as ScanManifest & { calibrationOutsidePlaceFrame?: true }).calibrationOutsidePlaceFrame, true)

      // ── Moving a scan into a Place that holds another frame ──────────────────────────────────
      const refused = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf('1700000000003_matched.glb')}`, {})
      assertEquals(refused.status, 409, 'a scan of the frame the House holds is held to it')
      assertEquals((refused.json as { code?: string }).code, 'frame-mismatch')
      const free = await server.send('PATCH', `/projects/proj-b/scans/${scanIdOf('1700000000001_outside_a.glb')}`, {})
      assertEquals(free.status, 200, `a scan that is in no frame has none to disagree about: ${free.text}`)
    } finally {
      await server.stop()
    }
  },
})
