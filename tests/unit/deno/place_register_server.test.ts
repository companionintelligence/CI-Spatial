/**
 * The place-register job on the real server: upload, queue, run, propose, apply once.
 *
 * tests/unit/deno/place_register.test.ts runs the job against an in-memory world.
 * This runs it where it lives. `server/main.ts` serves at import and exports nothing,
 * so each test spawns the real server on a free port with every directory it writes in a
 * temp folder (the way export_route_guard.test.ts does) and talks to it over HTTP. That
 * is the wiring the unit tests cannot reach: the job type in the dispatch and in the
 * route's list of types, the upload hook that queues a proposal when a second scan
 * joins a Place, the shared pump running it after the optimize job, the artifact in the
 * world file, and the patch route that holds provenance to what the job proposed.
 *
 * The scans are synthetic rooms written as real GLBs and uploaded with the metadata the
 * scanner sends (a calibrated scan's `projectTransform`, `calibrationMethod`, `projectId`).
 * The second scan's calibration is wrong by an injected amount, which is what the job is
 * there to find. No browser is involved: Apply is the POST the editor makes, built by the
 * same `buildRegisterPatch` the editor uses.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'

import { REPO_ROOT } from '../../../server/repo-root.ts'
import { scanIdFor } from '../../../server/scan_id.ts'
import type { EditPatch, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'
import { buildRegisterPatch, multiplyMat4, readPlaceRegisterResult } from '../../../src/world/register-proposal.ts'
import { pointCloudGlb } from '../../fixtures/place-register/point-cloud-glb.ts'
import { corners, makeRoom, misplacementMatrix, type Misplacement } from '../../fixtures/place-register/synthetic-room.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 45_000

const ROOM = { width: 6, depth: 4, centre: { x: 3, z: 2 } } as const
const room = (seed: number, extra: object = {}) =>
  makeRoom({ ...ROOM, noiseM: 0.02, seed, boxes: [{ x: 1.2, z: 1, w: 0.8, d: 0.6, h: 0.9 }, { x: 4.5, z: 3, w: 1.2, d: 0.5, h: 0.5 }], ...extra })
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const ERROR: Misplacement = { yawDeg: 3, dx: 0.3, dz: -0.2 }

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  text: string
  json<T = unknown>(): T
}

interface RunningServer {
  get(path: string): Promise<Reply>
  post(path: string, body: unknown): Promise<Reply>
  upload(name: string, glb: Uint8Array, metadata: Record<string, unknown>): Promise<string>
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
    const text = await res.text()
    return { status: res.status, text, json: <T>() => JSON.parse(text) as T }
  } finally {
    clearTimeout(timer)
  }
}

/** Where the spawned server keeps its files, for a test that has to put some there before it boots. */
interface ServerDirs {
  scans: string
  worlds: string
  projects: string
}

async function startServer(seed?: (dirs: ServerDirs) => Promise<void>): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'place-register-' })
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
    if (seed) {
      await Deno.mkdir(`${root}/scans`, { recursive: true })
      await Deno.mkdir(`${root}/worlds`, { recursive: true })
      await seed({ scans: `${root}/scans`, worlds: `${root}/worlds`, projects: `${root}/projects.json` })
    }
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
      get: (path) => send(base, path, {}),
      post: (path, body) =>
        send(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      upload: async (name, glb, metadata) => {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(glb)], { type: 'model/gltf-binary' }), `${name}.glb`)
        form.append('metadata', JSON.stringify(metadata))
        const reply = await send(base, '/upload-scan', { method: 'POST', body: form })
        assertEquals(reply.status, 200, `upload of ${name}: ${reply.text}`)
        return reply.json<{ filename: string }>().filename
      },
      log: () => output.slice(-6000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** The sidecar the scanner uploads with a calibrated scan: the frame the capture measured, which may be wrong. */
function calibratedMetadata(projectId: string, localToWorld: number[], capturedAt: string, name: string): Record<string, unknown> {
  return {
    projectId,
    areaId: null,
    sessionId: null,
    scanName: name,
    capturedAt,
    exportedAt: capturedAt,
    projectTransform: localToWorld,
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'provisional',
    calibration: {
      method: 'two-point-ground',
      status: 'provisional',
      sessionToProject: localToWorld,
      calibratedAt: capturedAt,
      separationM: 2,
      residualM: 0,
      toleranceM: 0.15,
      anchorBearingDeg: null,
    },
    pointCount: 5000,
    detectionCount: 0,
    labels: [],
    detections: [],
  }
}

async function readWorld(server: RunningServer, slug: string): Promise<WorldProject> {
  const reply = await server.get(`/worlds/${slug}`)
  assertEquals(reply.status, 200, reply.text)
  return reply.json<WorldProject>()
}

/** Waits for the newest place-register job of `scanId` to reach a terminal state. */
async function settled(server: RunningServer, slug: string, scanId: string, exceptJobIds: string[] = []): Promise<WorldJob> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  let seen: WorldJob | undefined
  while (Date.now() < deadline) {
    const jobs = (await server.get(`/worlds/${slug}/jobs`)).json<WorldJob[]>()
    seen = jobs.find((job) => job.type === 'place-register' && job.scanId === scanId && !exceptJobIds.includes(job.jobId))
    if (seen && (seen.status === 'completed' || seen.status === 'failed')) return seen
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`no finished place-register job for ${scanId} (last seen: ${JSON.stringify(seen)}).\n${'-'.repeat(20)}\n${server.log()}`)
}

const pointsThrough = (matrix: number[], points: ArrayLike<number>): number[][] => {
  const out: number[][] = []
  for (let i = 0; i < points.length; i += 3) {
    const [x, y, z] = [points[i]!, points[i + 1]!, points[i + 2]!]
    out.push([
      matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
      matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
      matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
    ])
  }
  return out
}

Deno.test('place-register on the real server: a second scan queues a proposal, nothing moves until Apply, and Apply happens once', async () => {
  const server = await startServer()
  try {
    const project = (await server.post('/projects', { name: 'Test flat' })).json<{ projectId: string }>()
    const projectId = project.projectId
    const slug = (await server.get(`/projects/${projectId}/world`)).json<WorldProject>().shareSlug

    // The first scan in a Place has nothing to be compared with, so it queues nothing.
    const refName = await server.upload('reference', await pointCloudGlb(room(1)), calibratedMetadata(projectId, IDENTITY, '2026-11-10T09:00:00.000Z', 'Reference'))
    // The second joins a Place that has one, with a calibration that is wrong by ERROR.
    const wrong = misplacementMatrix(ERROR)
    const movedName = await server.upload('second-visit', await pointCloudGlb(room(2)), calibratedMetadata(projectId, wrong, '2026-11-12T09:00:00.000Z', 'Second visit'))

    const joined = await readWorld(server, slug)
    const reference = joined.scans.find((scan) => scan.filename === refName)!
    const moving = joined.scans.find((scan) => scan.filename === movedName)!
    assert(reference && moving, 'both scans are in the Place')
    assertEquals(moving.localToWorld, wrong, 'the world places the scan by its own calibration')

    // The upload queued it, and the pump ran it after the optimize job.
    const finished = await settled(server, slug, moving.scanId)
    assertEquals(finished.status, 'completed', `${finished.error}\n${server.log()}`)
    assertEquals(finished.payload?.['source'], 'joined-place')
    assertEquals(
      (await server.get(`/worlds/${slug}/jobs`)).json<WorldJob[]>().filter((job) => job.type === 'place-register').length,
      1,
      'one job, for the second scan, and none for the first',
    )

    // Both scans had been through optimize-scan (quantized and Draco-compressed) before the job ran, so what it read
    // was the optimized GLB the editor draws, with its dequantization on the node, not the raw upload.
    for (const name of [refName, movedName]) {
      assertEquals((await server.get(`/scans/${encodeURIComponent(name)}/manifest`)).status, 200, `${name} was optimized`)
    }

    const result = readPlaceRegisterResult(finished)
    assert(result, `an artifact that reads back as a proposal: ${JSON.stringify(finished.artifacts)}`)
    assertEquals(result.proposal.status, 'proposed', JSON.stringify(result.proposal.reason))
    assertEquals(result.reference.scanId, reference.scanId)
    assert(result.proposal.overlapFraction > 0.9)

    // A proposal moves nothing and aligns nothing.
    const afterJob = await readWorld(server, slug)
    const stillMoving = afterJob.scans.find((scan) => scan.scanId === moving.scanId)!
    assertEquals(stillMoving.localToWorld, wrong)
    assertEquals(stillMoving.status, moving.status)
    assert(afterJob.scans.every((scan: ScanManifest) => scan.status !== 'aligned'))
    assertEquals(afterJob.editPatches, [])

    // Apply: the patch the editor builds from the proposal.
    const body = buildRegisterPatch(result, finished.jobId)!
    const applied = await server.post(`/worlds/${slug}/patches`, body)
    assertEquals(applied.status, 200, applied.text)
    const { patch, world: afterApply } = applied.json<{ patch: EditPatch; world: WorldProject; duplicate?: boolean }>()
    assertEquals(patch.provenance, {
      source: 'place-register',
      jobId: finished.jobId,
      score: result.proposal.score,
      residualM: result.proposal.inlierResidualM,
    })
    const nowPlaced = afterApply.scans.find((scan) => scan.scanId === moving.scanId)!
    assertEquals(nowPlaced.localToWorld, multiplyMat4(result.proposal.transform!, wrong))
    assertEquals(nowPlaced.status, moving.status, 'applying a move is not an alignment claim either')

    // The room's corners, carried through the corrected placement, are where they were before the error.
    const truth = corners(ROOM)
    const placed = pointsThrough(nowPlaced.localToWorld, truth.flat())
    for (let i = 0; i < truth.length; i++) {
      const drift = Math.hypot(placed[i]![0]! - truth[i]![0]!, placed[i]![2]! - truth[i]![2]!)
      assert(drift < 0.05, `corner ${i} is ${(drift * 100).toFixed(1)} cm out after applying`)
    }
    // The raw calibration on disk is what the capture measured. The refined placement lives in the patch.
    assertEquals(afterApply.scans.find((scan) => scan.scanId === reference.scanId)!.localToWorld, IDENTITY)

    // A second Apply, from a second tab or a double press, writes nothing.
    const again = await server.post(`/worlds/${slug}/patches`, body)
    assertEquals(again.status, 200, again.text)
    const duplicate = again.json<{ patch: EditPatch; world: WorldProject; duplicate?: boolean }>()
    assertEquals(duplicate.duplicate, true)
    assertEquals(duplicate.patch.patchId, patch.patchId)
    assertEquals(duplicate.world.editPatches.length, 1)

    // A patch that borrows a job's name for a move it did not propose is refused.
    const forged = { ...body, transform: { ...body.transform, matrix: misplacementMatrix({ yawDeg: 0, dx: 2, dz: 0 }) } }
    const lie = await server.post(`/worlds/${slug}/patches`, { ...forged, provenance: { ...body.provenance, jobId: 'job-nope' } })
    assertEquals(lie.status, 400, lie.text)
    assertEquals((await readWorld(server, slug)).editPatches.length, 1)

    // The same job can still be queued by hand through the ordinary route, and the type is one the route knows.
    const manual = await server.post(`/worlds/${slug}/jobs`, { type: 'place-register', scanId: reference.scanId })
    assertEquals(manual.status, 202, manual.text)
    const rerun = await settled(server, slug, reference.scanId)
    assertEquals(rerun.status, 'completed')
    const second = readPlaceRegisterResult(rerun)
    assert(second)
    // The scans now agree, so what is left to propose is almost nothing.
    assertEquals(second.proposal.status, 'proposed')
    assert(second.proposal.boundedCorrection!.translationM < 0.08)

    // An ordinary scan patch, the Edit gizmo's, writes exactly as it did before this job existed: no provenance,
    // and its matrix is the scan's placement. Old patches on disk have no provenance either, and read the same.
    const nudge = misplacementMatrix({ yawDeg: 0, dx: 0.05, dz: 0 })
    const plain = await server.post(`/worlds/${slug}/patches`, { scope: 'scan', scanId: reference.scanId, targetId: reference.filename, transform: { matrix: nudge } })
    assertEquals(plain.status, 200, plain.text)
    const written = plain.json<{ patch: EditPatch; world: WorldProject; duplicate?: boolean }>()
    assertEquals(written.patch.provenance, undefined)
    assertEquals(written.duplicate, undefined)
    assertEquals(written.world.scans.find((candidate) => candidate.scanId === reference.scanId)!.localToWorld, nudge)
    assertEquals(written.world.editPatches.length, 2)
  } finally {
    await server.stop()
  }
})

Deno.test('place-register on the real server: scans it cannot sensibly compare queue nothing, and an unrelated scan is refused honestly', async () => {
  const server = await startServer()
  try {
    const projectId = (await server.post('/projects', { name: 'Test house' })).json<{ projectId: string }>().projectId
    const slug = (await server.get(`/projects/${projectId}/world`)).json<WorldProject>().shareSlug

    await server.upload('reference', await pointCloudGlb(room(1)), calibratedMetadata(projectId, IDENTITY, '2026-11-10T09:00:00.000Z', 'Reference'))

    // No calibration at all: it is placed by GPS or on a grid, so there is nothing to compare against the Place frame.
    const plain = { ...calibratedMetadata(projectId, IDENTITY, '2026-11-11T09:00:00.000Z', 'Uncalibrated') }
    delete plain['projectTransform']
    delete plain['calibration']
    plain['calibrationMethod'] = null
    plain['calibrationStatus'] = 'uncalibrated'
    const uncalibratedName = await server.upload('uncalibrated', await pointCloudGlb(room(3)), plain)

    // Calibrated, but a different room altogether.
    const strangerName = await server.upload(
      'other-room',
      await pointCloudGlb(makeRoom({ width: 5, depth: 3, centre: { x: 9, z: 7 }, noiseM: 0.02, seed: 5 })),
      calibratedMetadata(projectId, IDENTITY, '2026-11-12T09:00:00.000Z', 'Another room'),
    )

    // An upload that names a Place nobody made queues nothing and creates no world for it.
    await server.upload('ghost', await pointCloudGlb(room(4)), calibratedMetadata('proj-never-made', IDENTITY, '2026-11-12T10:00:00.000Z', 'Ghost'))

    const world = await readWorld(server, slug)
    const stranger = world.scans.find((scan) => scan.filename === strangerName)!
    const uncalibrated = world.scans.find((scan) => scan.filename === uncalibratedName)!
    const before = structuredClone(world.scans)

    const finished = await settled(server, slug, stranger.scanId)
    assertEquals(finished.status, 'completed', `${finished.error}\n${server.log()}`)
    assert(finished.result!.startsWith('No move proposed'), finished.result)
    const result = readPlaceRegisterResult(finished)!
    assertEquals(result.proposal.status, 'refused')
    assertEquals(result.proposal.reason, 'low-overlap')
    assertEquals(result.proposal.transform, null)
    assertEquals(buildRegisterPatch(result, finished.jobId), null)

    // The uncalibrated scan never got a job.
    const jobs = (await server.get(`/worlds/${slug}/jobs`)).json<WorldJob[]>().filter((job) => job.type === 'place-register')
    assertEquals(jobs.some((job) => job.scanId === uncalibrated.scanId), false)

    // Asked to by hand, it completes with a reason instead of failing.
    const asked = await server.post(`/worlds/${slug}/jobs`, { type: 'place-register', scanId: uncalibrated.scanId })
    assertEquals(asked.status, 202, asked.text)
    const skipped = await settled(server, slug, uncalibrated.scanId)
    assertEquals(skipped.status, 'completed')
    assertEquals(readPlaceRegisterResult(skipped), null)
    assertEquals(skipped.artifacts![0]!.metadata!['reason'], 'not-calibrated')

    // A job that names no scan has nothing to compare and says so: the shared claim fails it, as it fails every scan-backed type.
    const nameless = await server.post(`/worlds/${slug}/jobs`, { type: 'place-register' })
    assertEquals(nameless.status, 202, nameless.text)
    const namelessId = nameless.json<WorldJob>().jobId
    for (let i = 0; i < 100; i++) {
      const status = (await server.get(`/worlds/${slug}/jobs`)).json<WorldJob[]>().find((job) => job.jobId === namelessId)?.status
      if (status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const failed = (await server.get(`/worlds/${slug}/jobs`)).json<WorldJob[]>().find((job) => job.jobId === namelessId)!
    assertEquals(failed.status, 'failed')
    assertEquals(failed.error, 'place-register requires a selected scan.')

    // A refusal and a skip left every scan as it was.
    const after = (await readWorld(server, slug)).scans
    assertEquals(after.map((scan) => [scan.scanId, scan.localToWorld, scan.status]), before.map((scan: ScanManifest) => [scan.scanId, scan.localToWorld, scan.status]))
    assert(after.every((scan) => scan.status !== 'aligned'))

    // The ghost upload had its chance to create a world by now: the stranger's job, queued after it, has finished.
    const worlds = (await server.get('/worlds')).json<Array<{ shareSlug: string; projectId: string | null }>>()
    assertEquals(worlds.some((candidate) => candidate.projectId === 'proj-never-made' || candidate.shareSlug.includes('never-made')), false)

    // And a patch that names the refused job is not one the server will write.
    const forged = await server.post(`/worlds/${slug}/patches`, {
      scope: 'scan',
      scanId: stranger.scanId,
      targetId: stranger.filename,
      transform: { matrix: misplacementMatrix({ yawDeg: 0, dx: 0.5, dz: 0 }) },
      provenance: { source: 'place-register', jobId: finished.jobId, score: 0.9, residualM: 0.02 },
    })
    assertEquals(forged.status, 400, forged.text)
    assertNotEquals((await readWorld(server, slug)).scans.find((scan) => scan.scanId === stranger.scanId)!.localToWorld, misplacementMatrix({ yawDeg: 0, dx: 0.5, dz: 0 }))
  } finally {
    await server.stop()
  }
})

Deno.test('place-register on the real server: a scan filed under another area is not compared, and one filed under the same area is', async () => {
  const server = await startServer()
  try {
    const projectId = (await server.post('/projects', { name: 'Test two rooms' })).json<{ projectId: string }>().projectId
    const slug = (await server.get(`/projects/${projectId}/world`)).json<WorldProject>().shareSlug
    const filed = (area: string, localToWorld: number[], capturedAt: string, name: string) => ({
      ...calibratedMetadata(projectId, localToWorld, capturedAt, name),
      areaId: area,
    })

    // The kitchen, then the hall, then the kitchen again. The hall has the same plan and the same frame as the
    // kitchen: nothing but its filing says it is another room.
    const kitchenName = await server.upload('kitchen-1', await pointCloudGlb(room(1)), filed('area-kitchen', IDENTITY, '2026-11-10T09:00:00.000Z', 'Kitchen'))
    const hallName = await server.upload('hall', await pointCloudGlb(room(3)), filed('area-hall', IDENTITY, '2026-11-11T09:00:00.000Z', 'Hall'))
    const againName = await server.upload('kitchen-2', await pointCloudGlb(room(2)), filed('area-kitchen', misplacementMatrix(ERROR), '2026-11-12T09:00:00.000Z', 'Kitchen again'))

    const world = await readWorld(server, slug)
    const kitchen = world.scans.find((scan) => scan.filename === kitchenName)!
    const hall = world.scans.find((scan) => scan.filename === hallName)!
    const again = world.scans.find((scan) => scan.filename === againName)!
    assertEquals([kitchen.areaId, hall.areaId, again.areaId], ['area-kitchen', 'area-hall', 'area-kitchen'], 'the filing travels from the sidecar to the scan')

    const finished = await settled(server, slug, again.scanId)
    assertEquals(finished.status, 'completed', `${finished.error}\n${server.log()}`)
    const result = readPlaceRegisterResult(finished)
    assert(result, JSON.stringify(finished.artifacts))
    assertEquals(result.proposal.status, 'proposed', String(result.proposal.reason))
    assertEquals(result.reference.scanId, kitchen.scanId)
    assertEquals(result.comparisons.map((row) => row.referenceScanId), [kitchen.scanId], 'the hall was never a candidate')

    // The hall joined a Place whose only other scan is filed under another area: nothing to compare, so nothing queued.
    const jobs = (await server.get(`/worlds/${slug}/jobs`)).json<WorldJob[]>().filter((job) => job.type === 'place-register')
    assertEquals(jobs.some((job) => job.scanId === hall.scanId), false)
    assertEquals(jobs.length, 1)

    // Asked for by hand, the hall says why there is nothing to compare, and does not fail.
    const asked = await server.post(`/worlds/${slug}/jobs`, { type: 'place-register', scanId: hall.scanId })
    assertEquals(asked.status, 202, asked.text)
    const skipped = await settled(server, slug, hall.scanId)
    assertEquals(skipped.status, 'completed')
    assertEquals(skipped.artifacts![0]!.metadata!['reason'], 'no-other-scan')
    assertEquals(
      skipped.result,
      'No other calibrated scan in this scan\'s area to compare it with. The Place\'s other scans are filed under other areas.',
    )
  } finally {
    await server.stop()
  }
})

Deno.test('place-register on the real server: a job a killed server left processing is requeued at boot and finishes', async () => {
  const projectId = 'proj-boot'
  const referenceFile = '1789000000001_reference.glb'
  const movingFile = '1789000000002_second-visit.glb'
  const wrong = misplacementMatrix(ERROR)
  const movingId = scanIdFor(movingFile)

  // What a server that died mid-job leaves behind: two calibrated scans on disk, and a world whose
  // place-register job is still 'processing'. Nothing else: no upload, so no optimize job, and the job reads the raw GLB.
  const server = await startServer(async (dirs) => {
    await Deno.writeFile(`${dirs.scans}/${referenceFile}`, await pointCloudGlb(room(1)))
    await Deno.writeTextFile(`${dirs.scans}/${referenceFile.replace(/\.glb$/, '.json')}`, JSON.stringify(calibratedMetadata(projectId, IDENTITY, '2026-11-10T09:00:00.000Z', 'Reference')))
    await Deno.writeFile(`${dirs.scans}/${movingFile}`, await pointCloudGlb(room(2)))
    await Deno.writeTextFile(`${dirs.scans}/${movingFile.replace(/\.glb$/, '.json')}`, JSON.stringify(calibratedMetadata(projectId, wrong, '2026-11-12T09:00:00.000Z', 'Second visit')))
    await Deno.writeTextFile(dirs.projects, JSON.stringify([{
      projectId,
      name: 'Boot test',
      createdAt: 1789000000000,
      updatedAt: 1789000000000,
      floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [] }],
    }]))
    const empty = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
    await Deno.writeTextFile(`${dirs.worlds}/project-${projectId}.json`, JSON.stringify({
      worldId: `world-project-${projectId}`,
      name: 'Boot test',
      shareSlug: `project-${projectId}`,
      projectId,
      originGeoPose: empty,
      localFrame: { type: 'ENU_Y_UP', origin: empty, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
      scans: [],
      things: [],
      thingObservations: [],
      members: [],
      comments: [],
      jobs: [{
        jobId: 'job-boot-1',
        worldId: `world-project-${projectId}`,
        type: 'place-register',
        status: 'processing',
        scanId: movingId,
        workerId: 'scan-match',
        capabilities: [],
        progress: 0.35,
        createdAt: '2026-11-16T09:00:00.000Z',
        updatedAt: '2026-11-16T09:00:01.000Z',
      }],
      editPatches: [],
      createdAt: '2026-11-16T09:00:00.000Z',
      updatedAt: '2026-11-16T09:00:01.000Z',
    }))
  })
  try {
    const slug = `project-${projectId}`
    const finished = await settled(server, slug, movingId)
    assertEquals(finished.jobId, 'job-boot-1', 'the job the old process left, not a new one')
    assertEquals(finished.status, 'completed', `${finished.error}\n${server.log()}`)
    assertNotEquals(finished.result, 'requeued after restart', 'it ran again, and said what it found')

    const result = readPlaceRegisterResult(finished)
    assert(result, JSON.stringify(finished.artifacts))
    assertEquals(result.proposal.status, 'proposed', String(result.proposal.reason))
    const world = await readWorld(server, slug)
    assertEquals(world.scans.find((scan) => scan.scanId === movingId)!.localToWorld, wrong, 'recovering a job moves nothing')
    assertEquals(world.jobs.filter((job) => job.type === 'place-register').length, 1)
  } finally {
    await server.stop()
  }
})
