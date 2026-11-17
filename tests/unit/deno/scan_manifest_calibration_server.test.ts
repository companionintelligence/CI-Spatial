/**
 * The real server, end to end: what a scan already on disk hands the editor, and what a job that does
 * nothing says it did.
 *
 * Two changes are pinned here through the whole route, not through the functions they live in:
 *
 *  1. A sidecar written by `src/export/gltf.ts` before `calibrationFromMeta` existed reaches GET /worlds/:slug
 *     with its residual, tolerance and time, as well as the tier, status and separation it always had. The
 *     unit tests in scan_manifest_calibration.test.ts hold the reader; this holds that the manifest builder calls
 *     it, that the world refresh keeps what it returns, and that the editor receives it as JSON.
 *  2. A job with no worker completes with a "No-op:" result and no longer stamps the scan `'aligned'`, and a
 *     world file that an older build left a scan marked `'aligned'` in (with no GLB on disk to back any claim
 *     about it) is corrected on the next read.
 *  3. (The second test, which boots its own server.) A sidecar that changes after the world file has stored its
 *     manifest is followed on the next read, including the `splat-align` job's rewrite of the nested record; jobs an
 *     older build completed with a claim about work they never did are given the honest sentence when the world is
 *     read, in the API and in the file; and a job with no worker does not clear a `needs-rescan` verdict.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so, like export_route_guard.test.ts, this
 * spawns the real server on a free port with every directory it writes in a temp folder and the mock inference
 * engine, and talks to it over HTTP. Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { twoPointSeparationM, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 30_000

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  text: string
}

interface RunningServer {
  worldsDir: string
  scansDir: string
  get(path: string): Promise<Reply>
  post(path: string, body: BodyInit, headers?: Record<string, string>): Promise<Reply>
  log(): string
  stop(): Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

async function send(base: string, path: string, init: RequestInit): Promise<Reply> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    return { status: res.status, text: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

async function startServer(): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'scan-manifest-calibration-' })
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
    }
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
  try {
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
        SCANS_DIR: `${root}/scans`,
        WORLDS_DIR: `${root}/worlds`,
        SUMMARIES_DIR: `${root}/summaries`,
        PROJECTS_FILE: `${root}/projects.json`,
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
      worldsDir: `${root}/worlds`,
      scansDir: `${root}/scans`,
      get: (path) => send(base, path, {}),
      post: (path, body, headers = {}) => send(base, path, { method: 'POST', headers, body }),
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

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

const LANDMARK = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER = { x: 3.1, y: -1.2, z: 1.9 }

/**
 * The text `uploadToServer` in src/export/gltf.ts posts as the `metadata` field, which the server stores verbatim
 * as `<scan>.json`: the same keys, in the same shapes, with the calibration written three ways (the flat tier, the
 * flat status and the whole record). This is the file already on disk for every scan captured before the change.
 */
function sidecar(scanName: string, calibration: Record<string, unknown> | null): string {
  return JSON.stringify({
    detectionCount: 0,
    labels: [],
    detections: [],
    exportedAt: '2026-11-01T10:05:00.000Z',
    capturedAt: '2026-11-01T10:04:30.000Z',
    sessionId: null,
    scanName,
    projectId: null,
    areaId: null,
    floorId: null,
    roomId: null,
    projectTransform: (calibration?.['sessionToProject'] as number[] | undefined) ?? null,
    calibrationMethod: (calibration?.['method'] as string | undefined) ?? null,
    calibrationStatus: (calibration?.['status'] as string | undefined) ?? 'uncalibrated',
    calibration,
    autoSaved: false,
    pointCount: 1303,
    poseCount: 412,
    geoLat: null,
    geoLng: null,
    geoAltitudeM: null,
    geoAccuracy: null,
    geoBearing: null,
    geoAddress: null,
    geoDisplayAddress: null,
    geoFixedAt: null,
  })
}

async function upload(server: RunningServer, name: string, metadata: string): Promise<void> {
  const form = new FormData()
  form.append('file', new File([emptyGlb()], `${name}.glb`, { type: 'model/gltf-binary' }))
  form.append('metadata', metadata)
  const reply = await server.post('/upload-scan', form)
  assertEquals(reply.status, 200, `upload ${name}: ${reply.text}\n${server.log()}`)
}

async function readWorld(server: RunningServer): Promise<WorldProject> {
  const reply = await server.get('/worlds/default')
  assertEquals(reply.status, 200, `GET /worlds/default: ${reply.text}\n${server.log()}`)
  return JSON.parse(reply.text) as WorldProject
}

function byName(world: WorldProject, name: string): ScanManifest {
  const scan = world.scans.find((candidate) => candidate.name === name)
  assert(scan, `the world has no scan named ${name}: ${world.scans.map((s) => s.name).join(', ')}`)
  return scan
}

/**
 * Waits until the server has nothing queued or running. An upload queues an optimize-scan job, and the pump updates the
 * world file as it works, so a test that reads or rewrites the file itself waits for quiet first: it would otherwise
 * read a half-written file or lose a write the server makes at the same moment.
 */
async function idle(server: RunningServer): Promise<void> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const jobs = JSON.parse((await server.get('/worlds/default/jobs')).text) as WorldJob[]
    if (jobs.every((job) => job.status === 'completed' || job.status === 'failed')) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`the server still had work queued after ${JOB_TIMEOUT_MS} ms\n${server.log()}`)
}

/**
 * The job and its scan as the world FILE holds them the moment the job is done, found by reading the file and
 * calling nothing. That is the only place a scan status a job wrote is still to be seen: every route that loads the
 * world refreshes it first, and a refresh derives the status again from the scan's quality, so a stamp of
 * `'aligned'` is gone by the first read through the API. A torn read of a file mid-write is tried again.
 */
async function worldFileOnceDone(server: RunningServer, jobId: string, scanId: string): Promise<{ job: WorldJob; scan: ScanManifest }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const world = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/default.json`)) as WorldProject
      const job = world.jobs.find((candidate) => candidate.jobId === jobId)
      const scan = world.scans.find((candidate) => candidate.scanId === scanId)
      if (job && scan && (job.status === 'completed' || job.status === 'failed')) return { job, scan }
    } catch { /* being written */ }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`job ${jobId} was not done in the world file after ${JOB_TIMEOUT_MS} ms\n${server.log()}`)
}

Deno.test({
  name: 'real server: a stored sidecar reaches the editor with its residual, tolerance and time, and align-scan is a visible no-op',
  // The spawned server owns its sockets and timers, which the test's own leak check cannot see.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer()
    try {
      // ── The scans, as the phone uploads them ────────────────────────────────────────────────
      await upload(
        server,
        'two-point',
        sidecar('two-point', {
          method: 'two-point-ground',
          sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
          separationM: twoPointSeparationM(LANDMARK, HEADING_MARKER),
          residualM: 0.022,
          toleranceM: 0.15,
          anchorBearingDeg: 81.5,
          calibratedAt: '2026-11-01T10:00:00.000Z',
          status: 'verified',
        }),
      )
      await upload(
        server,
        'one-point',
        sidecar('one-point', {
          method: 'ground-tap-compass',
          sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
          anchorBearingDeg: 40,
          calibratedAt: '2026-11-02T08:30:00.000Z',
          status: 'provisional',
        }),
      )
      await upload(server, 'uncalibrated', sidecar('uncalibrated', null))

      // ── What the editor receives ────────────────────────────────────────────────────────────
      await idle(server)
      const world = await readWorld(server)
      assertEquals(world.scans.length, 3)

      const two = byName(world, 'two-point')
      assertEquals(two.calibrationMethod, 'two-point-ground', 'the red pins are drawn from this tier')
      assertEquals(two.calibrationStatus, 'verified')
      assertEquals(two.calibrationSeparationM, twoPointSeparationM(LANDMARK, HEADING_MARKER))
      assertEquals(two.calibrationResidualM, 0.022, 'the residual the capture measured')
      assertEquals(two.calibrationToleranceM, 0.15)
      assertEquals(two.calibratedAt, '2026-11-01T10:00:00.000Z')

      const one = byName(world, 'one-point')
      assertEquals(one.calibrationMethod, 'ground-tap-compass')
      assertEquals(one.calibrationSeparationM, null)
      assertEquals(one.calibrationResidualM, null, 'a one-point record has none, and none is invented')
      assertEquals(one.calibrationToleranceM, null)
      assertEquals(one.calibratedAt, '2026-11-02T08:30:00.000Z')

      const none = byName(world, 'uncalibrated')
      assertEquals(none.calibrationMethod, undefined)
      assertEquals(none.calibrationStatus, 'uncalibrated')
      assertEquals(none.calibrationResidualM, null)
      assertEquals(none.calibratedAt, null)

      // And what the server keeps: the world file carries them too, so a read that does not rewrite it still serves them.
      await idle(server)
      const stored = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/default.json`)) as WorldProject
      assertEquals(byName(stored, 'two-point').calibrationResidualM, 0.022)

      // A world file the previous build wrote has none of the three new fields on its scans. It keeps loading, and the
      // next read fills them from the sidecars, which already hold everything they say.
      await idle(server)
      const file = `${server.worldsDir}/default.json`
      const older = JSON.parse(await Deno.readTextFile(file)) as WorldProject
      for (const scan of older.scans) {
        delete scan.calibrationResidualM
        delete scan.calibrationToleranceM
        delete scan.calibratedAt
      }
      await Deno.writeTextFile(file, JSON.stringify(older))
      const refilled = await readWorld(server)
      assertEquals(byName(refilled, 'two-point').calibrationResidualM, 0.022, 'a world file from before this change gains the residual')
      assertEquals(byName(refilled, 'two-point').calibrationToleranceM, 0.15)
      assertEquals(byName(refilled, 'two-point').calibratedAt, '2026-11-01T10:00:00.000Z')
      assertEquals(byName(refilled, 'two-point').calibrationMethod, 'two-point-ground', 'and keeps what it had')

      // ── A job with no worker ────────────────────────────────────────────────────────────────
      await idle(server)
      const queued = await server.post(
        '/worlds/default/jobs',
        JSON.stringify({ type: 'align-scan', scanId: two.scanId }),
        { 'Content-Type': 'application/json' },
      )
      assertEquals(queued.status, 202, queued.text)
      // No call to the API from here until the job is done: see worldFileOnceDone.
      const { job, scan: afterJob } = await worldFileOnceDone(server, (JSON.parse(queued.text) as WorldJob).jobId, two.scanId)
      assertEquals(job.status, 'completed', `the job still completes: ${job.error ?? job.result}`)
      assert(job.result?.startsWith('No-op:'), `a placeholder says so: ${job.result}`)
      assert(/no alignment was computed and no scan was moved/.test(job.result ?? ''), job.result)
      assertEquals(job.artifacts?.[0]?.type, 'alignment-report')
      assert(job.artifacts?.[0]?.label.includes('placeholder'), 'and its report is labelled a placeholder')
      assertNotEquals(afterJob.status, 'aligned', "the job aligned nothing, so it does not leave 'aligned' on the scan it ran for")
      assertEquals(afterJob.localToWorld, two.localToWorld, 'and it moved nothing')

      const after = await readWorld(server)
      assertEquals(byName(after, 'two-point').localToWorld, two.localToWorld, 'still nothing moved when the Place is read')
      assert(after.scans.every((scan) => scan.status !== 'aligned'))

      // ── An older build's claim, left in a world file ───────────────────────────────────────
      // A scan with no GLB on disk (a video-ingest scan) that an older build's align-scan marked 'aligned': there is
      // nothing for any claim about it to rest on, so the next read puts it back where it started, as it does 'ready'.
      await idle(server)
      const edited = JSON.parse(await Deno.readTextFile(file)) as WorldProject
      const ghost: ScanManifest = { ...byName(edited, 'uncalibrated'), scanId: 'scan-ghost', filename: 'ghost.glb', name: 'ghost', status: 'aligned' }
      edited.scans.push(ghost)
      await Deno.writeTextFile(file, JSON.stringify(edited))
      const healed = await readWorld(server)
      assertEquals(byName(healed, 'ghost').status, 'processing')
    } finally {
      await server.stop()
    }
  },
})

/** The sidecar file the server holds for a listed scan. */
function sidecarPathOf(server: RunningServer, scan: ScanManifest): string {
  return `${server.scansDir}/${scan.filename.replace(/\.glb$/, '.json')}`
}

/** A job record as an older build left it in a world file. */
function storedJob(world: WorldProject, type: WorldJob['type'], status: WorldJob['status'], extra: Partial<WorldJob> = {}): WorldJob {
  const at = '2026-10-01T09:00:00.000Z'
  return { jobId: `job-older-${type}-${status}`, worldId: world.worldId, type, status, capabilities: [], progress: 1, createdAt: at, updatedAt: at, ...extra }
}

/** What each of the six wrote as its result before the change, which is what is on disk for every job that ran. */
const OLDER_RESULTS: Array<[WorldJob['type'], string]> = [
  ['ingest', 'Scan ingest indexed GLB metadata, quality summary, layers, and sidecar references.'],
  ['extract-layers', 'Layer index is available from GLB extras, scene graph conventions, and sidecar manifests.'],
  ['align-scan', 'Alignment recorded from current world transform. A GPU/Open3D worker can refine this with registration artifacts.'],
  ['merge-points', 'Point merge plan recorded. A worker should replace this with a merged cloud artifact.'],
  ['semantic-pass', 'Semantic pass queued through the local coordinator. Server masks/detections can attach to this job artifact.'],
  ['depth-reconstruct', 'Depth reconstruction inputs validated. Depth Anything or WebXR depth artifacts can attach here.'],
]

Deno.test({
  name: "real server: a changed sidecar is followed on the next read, older builds' job claims are corrected, and a no-op job leaves a held verdict alone",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer()
    try {
      await upload(
        server,
        'two-point',
        sidecar('two-point', {
          method: 'two-point-ground',
          sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
          separationM: twoPointSeparationM(LANDMARK, HEADING_MARKER),
          residualM: 0.022,
          toleranceM: 0.15,
          anchorBearingDeg: 81.5,
          calibratedAt: '2026-11-01T10:00:00.000Z',
          status: 'verified',
        }),
      )
      await upload(server, 'uncalibrated', sidecar('uncalibrated', null))
      await idle(server)
      const two = byName(await readWorld(server), 'two-point')
      assertEquals(two.calibrationResidualM, 0.022, 'the world file now holds this manifest')

      // ── A sidecar that changes after the world file stored its manifest ─────────────────────
      // What the sidecar says wins over what the world file remembers. If the stored manifest won instead, a scan
      // calibrated again (or one whose record the splat-align job rewrote) would show its first calibration for good.
      await idle(server)
      const path = sidecarPathOf(server, two)
      const meta = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>
      meta['calibrationStatus'] = 'provisional'
      meta['calibration'] = {
        ...(meta['calibration'] as Record<string, unknown>),
        status: 'provisional',
        residualM: -0.2,
        calibratedAt: '2026-11-05T08:00:00.000Z',
      }
      await Deno.writeTextFile(path, JSON.stringify(meta))
      const followed = byName(await readWorld(server), 'two-point')
      assertEquals(followed.calibrationStatus, 'provisional', 'the flat summary the sidecar now holds')
      assertEquals(followed.calibrationResidualM, -0.2, 'the residual the sidecar now holds, not the 0.022 the world file stored')
      assertEquals(followed.calibratedAt, '2026-11-05T08:00:00.000Z')
      assertEquals(followed.calibrationMethod, 'two-point-ground')

      // The job splat-align rewrites the nested record with its own known-distance one and leaves the flat summaries.
      // The scan is still placed by the two-point matrix, so it is still two-point, and the other record's measurements
      // are not printed under that name.
      meta['calibration'] = {
        method: 'known-distance',
        sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
        separationM: 3.2,
        residualM: 0.001,
        toleranceM: 0.5,
        gravityAligned: true,
        calibratedAt: '2026-11-09T12:00:00.000Z',
        status: 'provisional',
      }
      await Deno.writeTextFile(path, JSON.stringify(meta))
      const overwritten = byName(await readWorld(server), 'two-point')
      assertEquals(overwritten.calibrationMethod, 'two-point-ground')
      assertEquals(overwritten.calibrationSeparationM, null)
      assertEquals(overwritten.calibrationResidualM, null, "not the known-distance record's 0.001")
      assertEquals(overwritten.calibrationToleranceM, null)
      assertEquals(overwritten.calibratedAt, null)

      // ── Jobs an older build completed ────────────────────────────────────────────────────────
      await idle(server)
      const file = `${server.worldsDir}/default.json`
      const stored = JSON.parse(await Deno.readTextFile(file)) as WorldProject
      const legacyFailure = 'align-scan needs at least two scans in the world or a manual control-point target.'
      stored.jobs.unshift(
        ...OLDER_RESULTS.map(([type, result]) => storedJob(stored, type, 'completed', { result })),
        storedJob(stored, 'align-scan', 'failed', { result: legacyFailure, error: legacyFailure }),
        storedJob(stored, 'depth-reconstruct', 'failed', {
          result: 'depth-reconstruct requires a selected scan.',
          error: 'depth-reconstruct requires a selected scan.',
        }),
        storedJob(stored, 'splat-train', 'completed', { result: 'Gaussian splat trained with Brush. The .splat.ply sidecar is available as a splat layer on the scan.' }),
      )
      await Deno.writeTextFile(file, JSON.stringify(stored))
      const jobs = JSON.parse((await server.get('/worlds/default/jobs')).text) as WorldJob[]
      const find = (id: string) => jobs.find((candidate) => candidate.jobId === id)!
      for (const [type] of OLDER_RESULTS) {
        const job = find(`job-older-${type}-completed`)
        assert(job.result?.startsWith('No-op: '), `${type}: ${job.result}`)
        assertEquals(job.status, 'completed', 'the status is a fact about the run, and is not touched')
        assertEquals(job.updatedAt, '2026-10-01T09:00:00.000Z', 'so is the time')
      }
      const failed = find('job-older-align-scan-failed')
      assertEquals(failed.result, 'align-scan needs at least two scans in the world.')
      assertEquals(failed.error, 'align-scan needs at least two scans in the world.')
      assertEquals(find('job-older-depth-reconstruct-failed').error, 'depth-reconstruct requires a selected scan.', 'a failure that was true is left as it is')
      assertEquals(
        find('job-older-splat-train-completed').result,
        'Gaussian splat trained with Brush. The .splat.ply sidecar is available as a splat layer on the scan.',
        'a job with a worker keeps what it said',
      )
      // The correction is kept in the file, so the next read has nothing left to correct.
      const rewritten = JSON.parse(await Deno.readTextFile(file)) as WorldProject
      assert(!JSON.stringify(rewritten.jobs).includes('Alignment recorded'), 'the claim is gone from the world file as well')
      assert(!JSON.stringify(rewritten.jobs).includes('manual control-point target'))

      // ── A job with no worker leaves a held verdict alone ───────────────────────────────────────
      // 'needs-rescan' is a verdict on the capture that nothing has re-judged. The three placeholders that used to set the
      // status again from the scan's quality (semantic-pass, extract-layers, merge-points) cleared it: the scan read
      // 'ready' after a job that ran no pass at all.
      await idle(server)
      const withVerdict = JSON.parse(await Deno.readTextFile(file)) as WorldProject
      byName(withVerdict, 'two-point').status = 'needs-rescan'
      await Deno.writeTextFile(file, JSON.stringify(withVerdict))
      assertEquals(byName(await readWorld(server), 'two-point').status, 'needs-rescan', 'the verdict is held by a read')
      for (const type of ['extract-layers', 'semantic-pass', 'merge-points', 'align-scan', 'ingest', 'depth-reconstruct'] as const) {
        await idle(server)
        const queued = await server.post(
          '/worlds/default/jobs',
          JSON.stringify({ type, scanId: two.scanId }),
          { 'Content-Type': 'application/json' },
        )
        assertEquals(queued.status, 202, queued.text)
        const done = await worldFileOnceDone(server, (JSON.parse(queued.text) as WorldJob).jobId, two.scanId)
        assertEquals(done.job.status === 'completed' || done.job.status === 'failed', true)
        assertEquals(done.scan.status, 'needs-rescan', `${type} left the verdict as it found it`)
      }
      await idle(server)
      assertEquals(byName(await readWorld(server), 'two-point').status, 'needs-rescan')
    } finally {
      await server.stop()
    }
  },
})

// ── What the phone says about its frames reaches the scan list (WP-09b) ──────────────────────────────

/** A sidecar with the quality summary and frame-epoch record the current build writes, over the same base as `sidecar`. */
function sidecarWithFrames(scanName: string, frames: { frameShifts: number; mixedEpochs: boolean } | null): string {
  const base = JSON.parse(sidecar(scanName, null)) as Record<string, unknown>
  base['qualitySummary'] = {
    coverageScore: 0.74,
    coverageText: 'Good - review gaps',
    pointCount: 1303,
    detectionCount: 0,
    poseCount: 412,
    keyframeCount: 0,
    lowLightFrames: 0,
    driftEvents: 0,
    reflectiveWarnings: 0,
    missingAreas: 1,
    trackingLost: false,
    status: frames && frames.frameShifts > 0 ? 'needs-review' : 'ready',
    recommendations: frames && frames.frameShifts > 0 ? ['Tracking was interrupted: parts may be shifted'] : [],
    capturedAt: '2026-11-17T09:30:00.000Z',
    ...(frames ? { frameShifts: frames.frameShifts } : {}),
  }
  if (frames) base['frameEpochs'] = { version: 1, baseEpoch: 0, calibrationEpoch: 0, currentEpoch: frames.frameShifts, mixedEpochs: frames.mixedEpochs }
  return JSON.stringify(base)
}

Deno.test({
  name: 'real server: a scan whose tracking was interrupted reaches the editor with the count and whether its cloud is mixed, and one nobody counted with neither',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer()
    try {
      await upload(server, 'interrupted', sidecarWithFrames('interrupted', { frameShifts: 2, mixedEpochs: true }))
      await upload(server, 'ended-at-it', sidecarWithFrames('ended-at-it', { frameShifts: 0, mixedEpochs: false }))
      await upload(server, 'before-epochs', sidecarWithFrames('before-epochs', null))
      await idle(server)
      const world = await readWorld(server)

      const interrupted = byName(world, 'interrupted').qualitySummary
      assertEquals(interrupted?.frameShifts, 2, 'the scan list reads "Tracking interrupted 2 times" from this')
      assertEquals(interrupted?.mixedEpochs, true)
      assertEquals(interrupted?.status, 'needs-review', 'the verdict the phone gave is untouched')

      const ended = byName(world, 'ended-at-it').qualitySummary
      assertEquals(ended?.frameShifts, 0, 'counted, and none: a scan that was ended at the interruption says so')
      assertEquals(ended?.mixedEpochs, false)

      const before = byName(world, 'before-epochs').qualitySummary
      assert(before, 'the scan has a summary')
      assert(!('frameShifts' in before) && !('mixedEpochs' in before), 'a scan nobody counted has neither key')
      assertEquals(before?.coverageScore, 0.74, 'and the rest of its summary is as it was')
    } finally {
      await server.stop()
    }
  },
})
