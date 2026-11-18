/**
 * The real server, end to end: the evidence a two-point scan's record carries (its frame generation, the check its
 * status rests on and the fit's size and disagreement) and what happens to it on the row the world file stores.
 *
 * `refreshWorldScans` (server/main.ts) lays the manifest it builds from a scan's sidecar over the row the world file
 * stored (`{ ...scan, ...next }`), so a key the new manifest does not have leaves the old row's value standing for
 * good. The measurements `calibrationFromMeta` always sets are cleared that way when the sidecar stops holding them;
 * the five evidence fields are keys of the manifest for the same reason (`calibrationEvidenceFromMeta`), and
 * tests/unit/deno/frame_schema_s0.test.ts holds the function. This holds the route: the `splat-align` job replaces the
 * nested calibration record with a known-distance one and leaves the flat summaries alone, and a scan row that went on
 * saying "verified by a 3-point fit, 3 cm off" after that, beside a residual that had been cleared, was a measurement
 * attached to a record that no longer holds it.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so, as in scan_manifest_calibration_server.test.ts,
 * the real server is spawned on a free port with every directory it writes in a temp folder and the mock inference
 * engine, and spoken to over HTTP. Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
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
  const root = await Deno.makeTempDir({ prefix: 'scan-manifest-evidence-' })
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
const FRAME_ID = 'frame-0b1c2d3e'

const FIT = {
  fitMethod: 'rigid',
  pointsUsed: 3,
  rmsResidualM: 0.031,
  maxResidualM: 0.05,
  perPoint: [],
  headingResidualDeg: 0.4,
  scaleRatio: 1,
}

/** A two-point calibration record as the capture client will write it with the S0 fields, over what it writes today. */
function twoPointRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'two-point-ground',
    sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
    separationM: twoPointSeparationM(LANDMARK, HEADING_MARKER),
    residualM: 0.022,
    toleranceM: 0.15,
    anchorBearingDeg: 81.5,
    calibratedAt: '2026-11-01T10:00:00.000Z',
    status: 'verified',
    ...over,
  }
}

/**
 * The text `uploadToServer` in src/export/gltf.ts posts as the `metadata` field, which the server stores verbatim as
 * `<scan>.json`: the flat tier and status, the whole record, and whatever flat keys a writer adds beside them.
 */
function sidecar(scanName: string, calibration: Record<string, unknown>, flat: Record<string, unknown> = {}): string {
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
    projectTransform: calibration['sessionToProject'] ?? null,
    calibrationMethod: calibration['method'] ?? null,
    calibrationStatus: calibration['status'] ?? 'uncalibrated',
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
    ...flat,
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
 * Waits until the server has nothing queued or running. An upload queues an optimize-scan job, and the pump updates
 * the world file as it works, so a test that reads or rewrites a file itself waits for quiet first.
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
 * The world FILE as it is the moment the job is done. The file is what the last write saw: a read answers from the
 * sidecars and writes only when something the refresh counts has changed, so the file is read for itself, and only after a
 * write (a job finishing is one) has laid the manifests over the rows. A torn read of a file mid-write is tried again.
 */
async function worldFileOnceDone(server: RunningServer, jobId: string): Promise<WorldProject> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const world = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/default.json`)) as WorldProject
      const job = world.jobs.find((candidate) => candidate.jobId === jobId)
      if (job && (job.status === 'completed' || job.status === 'failed')) return world
    } catch { /* being written */ }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`job ${jobId} was not done in the world file after ${JOB_TIMEOUT_MS} ms\n${server.log()}`)
}

function sidecarPathOf(server: RunningServer, scan: ScanManifest): string {
  return `${server.scansDir}/${scan.filename.replace(/\.glb$/, '.json')}`
}

const EVIDENCE_KEYS = ['calibrationFrameId', 'calibrationCheckedBy', 'calibrationFitPointsUsed', 'calibrationFitRmsM', 'calibrationFitMaxM'] as const
const evidenceOf = (scan: ScanManifest) => Object.fromEntries(EVIDENCE_KEYS.filter((key) => key in scan).map((key) => [key, scan[key]]))

/** What the `splat-align` job does to a sidecar (server/main.ts `_runSplatAlignJob`): replaces the nested record, leaves the rest. */
async function rewriteLikeSplatAlign(server: RunningServer, scan: ScanManifest, flat: Record<string, unknown> = {}): Promise<void> {
  const path = sidecarPathOf(server, scan)
  const meta = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>
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
  await Deno.writeTextFile(path, JSON.stringify({ ...meta, ...flat }))
}

Deno.test({
  name: 'real server: the evidence reaches the editor, and a record the splat-align job replaced takes its evidence off the row',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer()
    try {
      await upload(server, 'fitted', sidecar('fitted', twoPointRecord({ frameId: FRAME_ID, checkedBy: 'constellation', fit: FIT })))
      await upload(server, 'flat-id', sidecar('flat-id', twoPointRecord({ frameId: FRAME_ID, checkedBy: 'constellation', fit: FIT }), { calibrationFrameId: FRAME_ID }))
      await upload(server, 'legacy', sidecar('legacy', twoPointRecord()))
      await upload(server, 'two-points-claiming-a-fit', sidecar('two-points-claiming-a-fit', twoPointRecord({
        checkedBy: 'constellation',
        fit: { ...FIT, pointsUsed: 2, rmsResidualM: 0, maxResidualM: 0 },
      })))
      await idle(server)

      // ── What the editor receives ────────────────────────────────────────────────────────────
      const first = await readWorld(server)
      assertEquals(
        evidenceOf(byName(first, 'fitted')),
        { calibrationFrameId: FRAME_ID, calibrationCheckedBy: 'constellation', calibrationFitPointsUsed: 3, calibrationFitRmsM: 0.031, calibrationFitMaxM: 0.05 },
        'the evidence in the record is on the manifest',
      )
      assertEquals(evidenceOf(byName(first, 'legacy')), {}, 'a record without it gets no key of it: over the wire the manifest is what it always was')
      assertEquals(
        evidenceOf(byName(first, 'two-points-claiming-a-fit')),
        {},
        'a "constellation" with a fit of two points behind it is a claim nothing supports, and is not passed on, nor is the fit',
      )

      // ── A job replaces the nested record and leaves the flat summaries alone ──────────────────
      await idle(server)
      const fitted = byName(first, 'fitted')
      await rewriteLikeSplatAlign(server, fitted)
      await rewriteLikeSplatAlign(server, byName(first, 'flat-id'))
      const after = await readWorld(server)
      const refreshed = byName(after, 'fitted')
      assertEquals(refreshed.calibrationMethod, 'two-point-ground', 'the scan is still placed by the two-point matrix')
      assertEquals(refreshed.calibrationResidualM, null, "the other record's 0.001 is not printed under that name: the contract the measurements already had")
      assertEquals(evidenceOf(refreshed), {}, 'and neither is a fit, a check or a generation the record no longer holds')
      assertEquals(
        evidenceOf(byName(after, 'flat-id')),
        { calibrationFrameId: FRAME_ID },
        'the frame id the flat key holds is the one value that survives the job: the flat key is the job\'s to leave alone',
      )

      // ── And the world file, once something writes it, has no key for what is gone ─────────────
      // A read answers from the sidecars and rewrites the file only for the changes the refresh counts, so the stale row can
      // still be in the file until a write. A job finishing is one: it lays the manifests over the rows it stored.
      await idle(server)
      const queued = await server.post('/worlds/default/jobs', JSON.stringify({ type: 'extract-layers', scanId: fitted.scanId }), { 'Content-Type': 'application/json' })
      assertEquals(queued.status, 202, queued.text)
      const file = await worldFileOnceDone(server, (JSON.parse(queued.text) as WorldJob).jobId)
      assertEquals(evidenceOf(byName(file, 'fitted')), {})
      assertFalse(JSON.stringify(byName(file, 'fitted')).includes('calibrationFit'), 'no fit key is written for a scan that has none')
      assertEquals(evidenceOf(byName(file, 'legacy')), {})
      assertEquals(evidenceOf(byName(file, 'flat-id')), { calibrationFrameId: FRAME_ID })
    } finally {
      await server.stop()
    }
  },
})

Deno.test({
  name: 'real server: the origin\'s floor height reaches the editor from the nested record, and from the flat key the splat-align job keeps once it has replaced that record',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer()
    try {
      // The capture writes the floor height only inside the nested record (`groundY`, wave 12). -1.2 m is the session height the
      // landmark was tapped at in this fixture, so the editor can draw the origin decal on the floor.
      await upload(server, 'kept', sidecar('kept', twoPointRecord({ groundY: LANDMARK.y })))
      await upload(server, 'unkept', sidecar('unkept', twoPointRecord({ groundY: LANDMARK.y })))
      await upload(server, 'untouched', sidecar('untouched', twoPointRecord({ groundY: LANDMARK.y })))
      await upload(server, 'legacy', sidecar('legacy', twoPointRecord()))
      await idle(server)

      const first = await readWorld(server)
      for (const name of ['kept', 'unkept', 'untouched']) assertEquals(byName(first, name).calibrationGroundY, LANDMARK.y, `${name}: the record's floor height`)
      assertEquals(byName(first, 'legacy').calibrationGroundY, null, 'a record from before the field says none, and none is made up')

      // The job replaces the nested record with its known-distance one. `kept` is what the job leaves now: the floor height beside
      // the record it replaced (server/calibration_fields.ts withReplacedCalibration). `unkept` is a sidecar an earlier build's job
      // replaced the record of, which kept nothing. `untouched` is a scan the job never ran on.
      await idle(server)
      await rewriteLikeSplatAlign(server, byName(first, 'kept'), { calibrationGroundY: LANDMARK.y })
      await rewriteLikeSplatAlign(server, byName(first, 'unkept'))
      const after = await readWorld(server)
      assertEquals(byName(after, 'kept').calibrationGroundY, LANDMARK.y, 'the floor height survives the job, as the frame generation does through its flat key')
      assertEquals(byName(after, 'kept').calibrationMethod, 'two-point-ground', 'the scan is still placed by the two-point matrix')
      assertEquals(byName(after, 'kept').calibrationResidualM, null, 'and the other record\'s measurements are still not printed under that name')
      assertEquals(byName(after, 'unkept').calibrationGroundY, null, 'a record replaced without the floor height kept says none: the row does not go on saying what the sidecar does not')
      assertEquals(byName(after, 'untouched').calibrationGroundY, LANDMARK.y)

      // The world file keeps it once something writes it, so a read that does not rewrite the file serves it too.
      await idle(server)
      const queued = await server.post('/worlds/default/jobs', JSON.stringify({ type: 'extract-layers', scanId: byName(first, 'kept').scanId }), { 'Content-Type': 'application/json' })
      assertEquals(queued.status, 202, queued.text)
      const file = await worldFileOnceDone(server, (JSON.parse(queued.text) as WorldJob).jobId)
      assertEquals(byName(file, 'kept').calibrationGroundY, LANDMARK.y)
      assertEquals(byName(file, 'unkept').calibrationGroundY, null)
    } finally {
      await server.stop()
    }
  },
})
