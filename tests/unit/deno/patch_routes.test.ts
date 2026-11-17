/**
 * The placement routes of the real server: what POST /worlds/:slug/patches will store, what
 * POST /upload-scan does with a transform it cannot use, the undo route, and the first placement a
 * scan keeps.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so a route cannot be called from a
 * test in-process (the same constraint export_route_guard.test.ts documents). The server is spawned on a
 * free port with every directory it writes in a temp folder and the mock inference engine, and
 * these tests talk to it over HTTP, so each answer is the route as wired: the middleware, the guard,
 * the validation and the world file together. The rules behind them are in patch_validate.test.ts.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { composeYUpTransform, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { rotatedBy } from './placement_fixtures.ts'
import { MAX_CHECKED_METADATA_CHARS } from '../../../server/world/patch_validate.ts'
import { checkPlacementMatrix, normaliseZeros } from '../../../src/world/scan-placement.ts'
import type { EditPatch, ScanManifest, WorldProject } from '../../../src/world/types.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 40_000

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  text: string
  json<T = Record<string, unknown>>(): T
}

interface RunningServer {
  root: string
  scansDir: string
  worldsDir: string
  get(path: string, token?: string): Promise<Reply>
  post(path: string, body: unknown, token?: string): Promise<Reply>
  /** `text` as the body, exactly: for a body that is not what `post` would make of a value. */
  postRaw(path: string, text: string, token?: string): Promise<Reply>
  upload(name: string, metadata: string, size?: number): Promise<Reply>
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

const withToken = (path: string, token?: string): string =>
  token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path

async function startServer(): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'patch-routes-' })
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
      root,
      scansDir: `${root}/scans`,
      worldsDir: `${root}/worlds`,
      get: (path, token) => send(base, withToken(path, token), {}),
      post: (path, body, token) =>
        send(base, withToken(path, token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      postRaw: (path, text, token) =>
        send(base, withToken(path, token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text,
        }),
      upload: (name, metadata, size = 600) => {
        const form = new FormData()
        // The route stores the bytes and queues an optimize job; it does not read the geometry.
        form.append('file', new Blob([new Uint8Array(size).fill(7)], { type: 'model/gltf-binary' }), name)
        form.append('metadata', metadata)
        return send(base, '/upload-scan', { method: 'POST', body: form })
      },
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SLUG = 'default'

const calibrated = (): number[] => twoPointToProjectTransform({ x: 1.5, y: 0, z: -0.4 }, { x: 3.1, y: 0, z: 1.9 })

/** `calibrated()` with its translation shifted, still a rigid placement. */
function moved(dx: number, dz = 0): number[] {
  const matrix = calibrated()
  matrix[12] += dx
  matrix[14] += dz
  return matrix
}

/** The second axis leaned toward the first by `theta`: unit length, no longer at a right angle. */
function skewedBy(matrix: number[], theta: number): number[] {
  const out = [...matrix]
  for (let i = 0; i < 3; i++) out[4 + i] = Math.cos(theta) * matrix[4 + i]! + Math.sin(theta) * matrix[i]!
  return out
}

const scaled = (matrix: number[], k: number): number[] => matrix.map((entry, i) => ([0, 1, 2, 4, 5, 6, 8, 9, 10].includes(i) ? entry * k : entry))

/** What the phone writes beside a calibrated scan (src/export/gltf.ts uploadToServer). */
function phoneMetadata(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    detectionCount: 3,
    sessionId: `session-${crypto.randomUUID().slice(0, 8)}`,
    pointCount: 120,
    projectId: null,
    projectTransform: calibrated(),
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'provisional',
    calibration: { method: 'two-point-ground', status: 'provisional', separationM: 1.9, sessionToProject: calibrated() },
    ...extra,
  })
}

async function readWorld(server: RunningServer): Promise<WorldProject> {
  const reply = await server.get(`/worlds/${SLUG}`)
  assertEquals(reply.status, 200, reply.text)
  return reply.json<WorldProject>()
}

async function uploaded(server: RunningServer, name: string, metadata: string, size?: number): Promise<{ filename: string; reply: Reply }> {
  const reply = await server.upload(name, metadata, size)
  assertEquals(reply.status, 200, `upload of ${name}: ${reply.text}\n${server.log()}`)
  return { filename: reply.json<{ filename: string }>().filename, reply }
}

function rowOf(world: WorldProject, filename: string): ScanManifest {
  const row = world.scans.find((scan) => scan.filename === filename)
  assert(row, `the world has a row for ${filename}`)
  return row
}

/** Every optimize-scan job the uploads queued has finished, so the server is no longer writing the world on its own. */
async function untilJobsSettle(server: RunningServer): Promise<void> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const world = await readWorld(server)
    if (world.jobs.every((job) => job.status === 'completed' || job.status === 'failed')) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`the optimize jobs did not settle. Server log:\n${server.log()}`)
}

const patchBody = (row: ScanManifest, matrix: unknown): Record<string, unknown> => ({
  scope: 'scan',
  scanId: row.scanId,
  targetId: row.filename,
  transform: { matrix },
})

const sameBits = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((entry, i) => Object.is(entry, b[i]))

/** The member tokens of the world, read from its file (reading the world makes the server write it). */
async function tokensOf(server: RunningServer): Promise<Record<string, string>> {
  await readWorld(server)
  const world = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/${SLUG}.json`)) as WorldProject
  return Object.fromEntries(world.members.map((member) => [member.role, member.token]))
}

/** The member ids of the world, by role, read from its file. */
async function memberIdsOf(server: RunningServer): Promise<Record<string, string>> {
  const world = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/${SLUG}.json`)) as WorldProject
  return Object.fromEntries(world.members.map((member) => [member.role, member.memberId]))
}

// ─── The tests ───────────────────────────────────────────────────────────────

Deno.test('a scan is stored at the placement it was uploaded with, and that first placement is kept for good', async (t) => {
  const server = await startServer()
  try {
    const { filename, reply } = await uploaded(server, 'calibrated.glb', phoneMetadata())
    assertEquals(reply.json().projectTransformRejected, undefined, 'a good transform is not flagged')

    await t.step('the file is named for the moment it arrived, which is how a later upload of the same name is told apart and ordered', async () => {
      const before = Date.now()
      const stamped = await uploaded(server, 'stamped.glb', phoneMetadata({ sessionId: 'session-stamped' }))
      const prefix = /^(\d+)_stamped\.glb$/.exec(stamped.filename)
      assert(prefix, `the name is <time>_stamped.glb, and is ${stamped.filename}`)
      assert(Number(prefix[1]) >= before && Number(prefix[1]) <= Date.now(), `the time is when it arrived: ${prefix[1]}`)
    })

    await t.step('the sidecar on disk is the phone\'s own text, byte for byte', async () => {
      const raw = phoneMetadata({ sessionId: 'session-bytes' })
      const second = await uploaded(server, 'bytes.glb', raw)
      assertEquals(await Deno.readTextFile(`${server.scansDir}/${second.filename.replace(/\.glb$/, '.json')}`), raw)
    })

    await t.step('the row has the calibrated placement as localToWorld and as calibratedLocalToWorld', async () => {
      const row = rowOf(await readWorld(server), filename)
      assertEquals(row.localToWorld, calibrated())
      assertEquals(row.calibratedLocalToWorld, calibrated())
      assertEquals(row.projectTransformRejected, undefined)
      assertEquals(row.calibrationStatus, 'provisional')
    })

    await t.step('the very first read of a world that did not exist yet already carries it', async () => {
      // A world is built from the scans on disk on its first read and answered as built, not read back, so it is stamped as it is built.
      const reply = await server.get('/worlds/a-world-nobody-has-read')
      assertEquals(reply.status, 200, reply.text)
      assertEquals(rowOf(reply.json<WorldProject>(), filename).calibratedLocalToWorld, calibrated())
    })

    await t.step('a move changes localToWorld and leaves calibratedLocalToWorld alone, across reads and a later upload', async () => {
      const before = rowOf(await readWorld(server), filename)
      const post = await server.post(`/worlds/${SLUG}/patches`, patchBody(before, moved(0.37, -0.12)))
      assertEquals(post.status, 200, post.text)
      assertEquals(post.json<{ world: WorldProject }>().world.scans.find((s) => s.filename === filename)!.localToWorld, moved(0.37, -0.12))

      await uploaded(server, 'another.glb', phoneMetadata({ sessionId: 'session-another' }))
      for (let read = 0; read < 3; read++) {
        const row = rowOf(await readWorld(server), filename)
        assertEquals(row.localToWorld, moved(0.37, -0.12))
        assertEquals(row.calibratedLocalToWorld, calibrated(), `read ${read}: written once, never overwritten`)
      }
      const onDisk = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/${SLUG}.json`)) as WorldProject
      assertEquals(rowOf(onDisk, filename).calibratedLocalToWorld, calibrated(), 'and the world file holds it')
    })
  } finally {
    await server.stop()
  }
})

Deno.test('an upload whose transform is not valid is stored and flagged, never answered with a 4xx the offline queue would delete it on', async (t) => {
  const server = await startServer()
  try {
    const withNull = calibrated() as Array<number | null>
    withNull[12] = null
    const bad: Array<[string, unknown]> = [
      ['skewed', skewedBy(calibrated(), 0.05)],
      ['a NaN (null in JSON)', withNull],
      ['short', calibrated().slice(0, 15)],
      ['scaled out of range', scaled(calibrated(), 9)],
      ['not a list', 'matrix'],
    ]
    for (const [label, transform] of bad) {
      await t.step(label, async () => {
        const { filename, reply } = await uploaded(server, `bad-${label.replace(/\W+/g, '-')}.glb`, phoneMetadata({ projectTransform: transform }))
        // 200, with the reason in the answer: public/sw.js would drop a queued upload on a 400, 404 or 409.
        assert(typeof reply.json().projectTransformRejected === 'string' && reply.json<{ projectTransformRejected: string }>().projectTransformRejected.length > 0)

        // The scan file is on disk and the sidecar is valid JSON that says what happened.
        await Deno.stat(`${server.scansDir}/${filename}`)
        const sidecar = JSON.parse(await Deno.readTextFile(`${server.scansDir}/${filename.replace(/\.glb$/, '.json')}`)) as Record<string, unknown>
        assertEquals(sidecar['projectTransform'], null)
        assertEquals(sidecar['calibrationStatus'], 'uncalibrated')
        assertEquals(sidecar['detectionCount'], 3, 'the rest of what the phone said is kept')
        assertNotEquals(sidecar['projectTransformRejected'], undefined)

        // The world shows the scan, places it by GPS or the grid, and says why.
        const row = rowOf(await readWorld(server), filename)
        assertEquals(typeof row.projectTransformRejected, 'string')
        assertEquals(row.calibrationStatus, 'uncalibrated')
        assertEquals(row.calibrationMethod, undefined, 'it does not claim a calibration that was not used')
        assert(checkPlacementMatrix(row.localToWorld).ok, 'the placement it has is a valid one')
        assertNotEquals(row.localToWorld, transform)
        assertEquals(row.calibratedLocalToWorld, row.localToWorld, 'its first placement is the one it was given')
      })
    }

    await t.step('metadata that is not JSON is stored as it arrived and not refused', async () => {
      const { filename } = await uploaded(server, 'garbled.glb', '{"projectTransform": [1, 2')
      assertEquals(await Deno.readTextFile(`${server.scansDir}/${filename.replace(/\.glb$/, '.json')}`), '{"projectTransform": [1, 2')
    })
  } finally {
    await server.stop()
  }
})

Deno.test('POST /worlds/:slug/patches refuses a scan matrix that is NaN, short or not rigid with a 400 and a message, and takes a rigid one', async (t) => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'target.glb', phoneMetadata())
    const row = rowOf(await readWorld(server), filename)
    const log = async (): Promise<EditPatch[]> => (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>()

    const refused: Array<[string, unknown, RegExp]> = [
      ['a NaN (null in JSON)', (() => { const m = calibrated() as Array<number | null>; m[14] = null; return m })(), /real numbers/],
      ['15 numbers', calibrated().slice(0, 15), /16 numbers, not 15/],
      ['17 numbers', [...calibrated(), 0], /16 numbers, not 17/],
      ['skewed', skewedBy(calibrated(), 0.02), /skewed/],
      ['stretched along one axis', (() => { const m = calibrated(); m[0] *= 1.3; m[1] *= 1.3; m[2] *= 1.3; return m })(), /stretched/],
      ['mirrored', (() => { const m = calibrated(); for (const i of [8, 9, 10]) m[i] = -m[i]!; return m })(), /mirrored/],
      ['scaled up 3 times', scaled(calibrated(), 3), /between 0\.5 and 2 times/],
      ['scaled down to a quarter', scaled(calibrated(), 0.25), /between 0\.5 and 2 times/],
      ['a projective last row', (() => { const m = calibrated(); m[3] = 0.01; return m })(), /last row/],
      ['not a list', { matrix: true }, /list of 16 numbers/],
    ]
    const before = (await log()).length
    for (const [label, matrix, message] of refused) {
      await t.step(`refuses ${label}`, async () => {
        const reply = await server.post(`/worlds/${SLUG}/patches`, patchBody(row, matrix))
        assertEquals(reply.status, 400, reply.text)
        assertEquals(typeof reply.json<{ error: string }>().error, 'string')
        assert(message.test(reply.json<{ error: string }>().error), reply.json<{ error: string }>().error)
      })
    }
    assertEquals((await log()).length, before, 'nothing refused reached the patch log')
    assertEquals(rowOf(await readWorld(server), filename).localToWorld, calibrated(), 'and no scan moved')

    await t.step('takes a rigid placement, a turned one, and every size from 0.5 to 2', async () => {
      for (const matrix of [moved(0.2), composeYUpTransform({ x: 4, y: 0.1, z: -2 }, 17.5), scaled(moved(0.1), 0.5), scaled(moved(0.1), 2), scaled(moved(0.1), 1.25)]) {
        const reply = await server.post(`/worlds/${SLUG}/patches`, patchBody(row, matrix))
        assertEquals(reply.status, 200, reply.text)
        assertEquals(rowOf(reply.json<{ world: WorldProject }>().world, filename).localToWorld, matrix.map((entry) => entry + 0))
      }
      assertEquals((await log()).length, before + 5)
    })

    await t.step('what it always took still goes through: labels, object moves with uneven size, things, and bad object matrices are refused', async () => {
      const label = await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', scanId: row.scanId, targetId: `${row.scanId}/chair`, label: 'armchair' })
      assertEquals(label.status, 200, label.text)
      const uneven = calibrated()
      uneven[0] *= 2.5
      uneven[1] *= 2.5
      uneven[2] *= 2.5
      const resized = await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', scanId: row.scanId, targetId: `${row.scanId}/chair`, transform: { matrix: uneven } })
      assertEquals(resized.status, 200, resized.text)
      const thing = await server.post(`/worlds/${SLUG}/patches`, { scope: 'thing', scanId: row.scanId, targetId: 'thing-1', transform: { position: { x: 1, y: 0, z: 2 } } })
      assertEquals(thing.status, 200, thing.text)

      const flat = calibrated()
      for (const i of [4, 5, 6]) flat[i] = 0
      assertEquals((await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', targetId: 'x', transform: { matrix: flat } })).status, 400)
      assertEquals((await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', targetId: 'x', transform: { matrix: calibrated().slice(0, 15) } })).status, 400)
      assertEquals((await server.post(`/worlds/${SLUG}/patches`, { scope: 'thing', targetId: 'x', transform: { position: { x: null, y: 0, z: 0 } } })).status, 400)
    })
  } finally {
    await server.stop()
  }
})

Deno.test('Reset to calibrated is an ordinary patch carrying the stored matrix, and the scan comes back to it bit for bit', async () => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'reset.glb', phoneMetadata())
    const first = rowOf(await readWorld(server), filename)
    const stored = first.calibratedLocalToWorld!
    assertEquals(stored, calibrated())

    assertEquals((await server.post(`/worlds/${SLUG}/patches`, patchBody(first, moved(0.9, 0.4)))).status, 200)
    assertEquals((await server.post(`/worlds/${SLUG}/patches`, patchBody(first, composeYUpTransform({ x: -1, y: 0, z: 2 }, 31)))).status, 200)

    const reset = await server.post(`/worlds/${SLUG}/patches`, patchBody(first, stored))
    assertEquals(reset.status, 200, reset.text)
    const after = rowOf(reset.json<{ world: WorldProject }>().world, filename)
    assert(sameBits(after.localToWorld, stored), 'localToWorld is the stored matrix, bit for bit')
    assert(sameBits(after.calibratedLocalToWorld!, stored), 'and the stored matrix itself did not change')
    const patch = reset.json<{ patch: EditPatch }>().patch
    assertEquals(patch.scope, 'scan')
    assertEquals(patch.revertsPatchId, undefined, 'a reset is an ordinary patch, not an undo record')
    assert(sameBits(patch.transform!.matrix!, stored))

    const reread = rowOf(await readWorld(server), filename)
    assert(sameBits(reread.localToWorld, stored), 'and it is the same after a read from disk')
  } finally {
    await server.stop()
  }
})

Deno.test('the undo route takes back the last move, records itself, and steps back past an earlier undo', async (t) => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'undo.glb', phoneMetadata())
    const row = rowOf(await readWorld(server), filename)
    const tokens = await tokensOf(server)
    const revert = (body: unknown, token?: string) => server.post(`/worlds/${SLUG}/patches/revert`, body, token)

    const one = (await server.post(`/worlds/${SLUG}/patches`, patchBody(row, moved(0.1)))).json<{ patch: EditPatch }>().patch
    const two = (await server.post(`/worlds/${SLUG}/patches`, patchBody(row, moved(0.2)))).json<{ patch: EditPatch }>().patch

    await t.step('a stale view is refused with a 409 and changes nothing', async () => {
      const stale = await revert({ scanId: row.scanId, patchId: one.patchId })
      assertEquals(stale.status, 409, stale.text)
      assertStringIncludes(stale.json<{ error: string }>().error, 'changed after you opened it')
      assertEquals(rowOf(await readWorld(server), filename).localToWorld, moved(0.2))
    })

    await t.step('a viewer cannot undo, and an unknown scan is a 404', async () => {
      assertEquals((await revert({ scanId: row.scanId }, tokens.viewer)).status, 403)
      assertEquals((await revert({ scanId: row.scanId }, tokens.commenter)).status, 403)
      assertEquals((await revert({ scanId: 'scan-not-there' }, tokens.editor)).status, 404)
      assertEquals(rowOf(await readWorld(server), filename).localToWorld, moved(0.2))
    })

    await t.step('the undo removes the last move and is itself in the log', async () => {
      const reply = await revert({ scanId: row.scanId, patchId: two.patchId }, tokens.editor)
      assertEquals(reply.status, 200, reply.text)
      const body = reply.json<{ patch: EditPatch; reverted: string; restoredTo: string; world: WorldProject }>()
      assertEquals(body.reverted, two.patchId)
      assertEquals(body.restoredTo, 'earlier-move')
      assertEquals(rowOf(body.world, filename).localToWorld, moved(0.1))
      assertEquals(body.patch.revertsPatchId, two.patchId)
      assertEquals(body.patch.scope, 'scan')
      assertEquals(body.patch.transform!.matrix, moved(0.1))
      // The world it answers with is a client view: other members' tokens are not in it.
      assertEquals(body.world.members.filter((member) => member.role !== 'editor' && member.token !== '').length, 0)

      const log = (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>()
      assertEquals(log.at(-1)!.patchId, body.patch.patchId, 'the undo is the newest entry')
      assert(log.some((entry) => entry.patchId === two.patchId), 'the move it undid is still in the log')
      assertEquals(rowOf(await readWorld(server), filename).localToWorld, moved(0.1), 'and a fresh read agrees')
    })

    await t.step('a second undo goes back past the first, to the placement the scan arrived with', async () => {
      const reply = await revert({ scanId: row.scanId }, tokens.editor)
      assertEquals(reply.status, 200, reply.text)
      assertEquals(reply.json<{ reverted: string }>().reverted, one.patchId)
      assertEquals(reply.json<{ restoredTo: string }>().restoredTo, 'first-placement')
      // The calibration builder leaves -0 in some entries; the stored copy is JSON, where they are 0, and the undo restores the stored copy.
      assert(sameBits(rowOf(reply.json<{ world: WorldProject }>().world, filename).localToWorld, normaliseZeros(calibrated())))
    })

    await t.step('with nothing left to undo it says so', async () => {
      const reply = await revert({ scanId: row.scanId }, tokens.editor)
      assertEquals(reply.status, 409, reply.text)
      assertStringIncludes(reply.json<{ error: string }>().error, 'no saved move')
      const log = (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>()
      assertEquals(log.length, 4, 'two moves and two undo records; the refusal wrote nothing')
    })

    await t.step('a reset is a move like any other: undoing it brings back what it reset', async () => {
      await server.post(`/worlds/${SLUG}/patches`, patchBody(row, moved(0.6, 0.6)))
      const resetPatch = (await server.post(`/worlds/${SLUG}/patches`, patchBody(row, row.calibratedLocalToWorld))).json<{ patch: EditPatch }>().patch
      const reply = await revert({ scanId: row.scanId, patchId: resetPatch.patchId }, tokens.editor)
      assertEquals(reply.status, 200, reply.text)
      assertEquals(rowOf(reply.json<{ world: WorldProject }>().world, filename).localToWorld, moved(0.6, 0.6))
    })
  } finally {
    await server.stop()
  }
})

Deno.test('a scan moved before the first placement was stored gets it back from its upload, or none, and an undo that needs it says so', async () => {
  const server = await startServer()
  try {
    const withTransform = await uploaded(server, 'legacy-calibrated.glb', phoneMetadata())
    const byGps = await uploaded(server, 'legacy-gps.glb', JSON.stringify({ sessionId: `session-${crypto.randomUUID().slice(0, 8)}`, pointCount: 10 }))
    await untilJobsSettle(server)
    const tokens = await tokensOf(server)
    const world = await readWorld(server)

    // Two moves each, then rewrite the world file the way an older build left it: a patched row with no stored first placement.
    for (const name of [withTransform.filename, byGps.filename]) {
      const row = rowOf(world, name)
      assertEquals((await server.post(`/worlds/${SLUG}/patches`, patchBody(row, moved(0.3)))).status, 200)
    }
    await untilJobsSettle(server)
    const file = `${server.worldsDir}/${SLUG}.json`
    const legacy = JSON.parse(await Deno.readTextFile(file)) as WorldProject
    for (const scan of legacy.scans) delete scan.calibratedLocalToWorld
    await Deno.writeTextFile(file, JSON.stringify(legacy))

    const read = await readWorld(server)
    assertEquals(rowOf(read, withTransform.filename).calibratedLocalToWorld, calibrated(), 'recovered from the calibrated upload')
    assertEquals(rowOf(read, withTransform.filename).localToWorld, moved(0.3), 'and the move is untouched')
    assertEquals(rowOf(read, byGps.filename).calibratedLocalToWorld, undefined, 'a GPS placement that was moved has no first placement to recover')

    // Undoing the only move of the scan with no first placement cannot be honest, so it says why and changes nothing.
    const refused = await server.post(`/worlds/${SLUG}/patches/revert`, { scanId: rowOf(read, byGps.filename).scanId }, tokens.editor)
    assertEquals(refused.status, 409, refused.text)
    assertStringIncludes(refused.json<{ error: string }>().error, 'was not stored')
    assertEquals(rowOf(await readWorld(server), byGps.filename).localToWorld, moved(0.3))

    // The one with a first placement undoes to it.
    const undone = await server.post(`/worlds/${SLUG}/patches/revert`, { scanId: rowOf(read, withTransform.filename).scanId }, tokens.editor)
    assertEquals(undone.status, 200, undone.text)
    assertEquals(rowOf(undone.json<{ world: WorldProject }>().world, withTransform.filename).localToWorld, calibrated())
  } finally {
    await server.stop()
  }
})

// ─── A read of the world while a scan is being uploaded ─────────────────────

interface Sighting {
  filename: string
  stamp: number[] | undefined
  placement: number[]
  method: string | undefined
}

Deno.test('a read of the world that lands while a scan is being uploaded never finds it without its calibration', async () => {
  const server = await startServer()
  try {
    await readWorld(server)
    const sightings: Sighting[] = []
    let finished = false
    let reads = 0
    // Four readers asking for the world as fast as they can, as an open editor and the job pump do, while scans go up.
    const readers = Array.from({ length: 4 }, async () => {
      while (!finished) {
        const rows = (await readWorld(server)).scans
        reads++
        for (const row of rows) sightings.push({ filename: row.filename, stamp: row.calibratedLocalToWorld, placement: row.localToWorld, method: row.calibrationMethod })
      }
    })
    try {
      for (let i = 0; i < 6; i++) await uploaded(server, `race-${i}.glb`, phoneMetadata({ sessionId: `session-race-${i}` }), 16_000_000)
    } finally {
      finished = true
      await Promise.all(readers)
    }
    assert(reads > 30, `the readers read the world ${reads} times while the scans went up`)
    assert(sightings.length > 0)
    for (const sighting of sightings) {
      // Whenever a scan was seen it had its calibration: it sat at the calibrated placement, and that was its stamp.
      assertEquals(sighting.method, 'two-point-ground', `${sighting.filename} seen without its sidecar`)
      assertEquals(sighting.placement, calibrated(), `${sighting.filename} seen at a placement that is not its calibration`)
      assertEquals(sighting.stamp, normaliseZeros(calibrated()), `${sighting.filename} stamped with a placement that is not its calibration`)
    }
    const final = await readWorld(server)
    assertEquals(final.scans.length, 6)
    for (const row of final.scans) assertEquals(row.calibratedLocalToWorld, normaliseZeros(calibrated()))
  } finally {
    await server.stop()
  }
})

// ─── A sidecar that is JSON but not an object ────────────────────────────────

Deno.test('an upload whose metadata is the JSON null is stored, and no read of any world fails because of it', async () => {
  const server = await startServer()
  try {
    const { filename, reply } = await uploaded(server, 'nulled.glb', 'null')
    assertEquals(reply.json().projectTransformRejected, undefined)
    assertEquals(await Deno.readTextFile(`${server.scansDir}/${filename.replace(/\.glb$/, '.json')}`), '{}', 'stored as an object that says nothing')

    const read = await server.get(`/worlds/${SLUG}`)
    assertEquals(read.status, 200, read.text)
    assertEquals(rowOf(read.json<WorldProject>(), filename).filename, filename, 'and the scan is in the world')
    const next = await server.upload('after.glb', phoneMetadata())
    assertEquals(next.status, 200, next.text)

    // A sidecar that is `null` on disk, whoever wrote it, is read as one with nothing in it.
    const byHand = `${Date.now()}_by-hand.glb`
    await Deno.writeFile(`${server.scansDir}/${byHand}`, new Uint8Array(700).fill(1))
    await Deno.writeTextFile(`${server.scansDir}/${byHand.replace(/\.glb$/, '.json')}`, 'null')
    const again = await server.get(`/worlds/${SLUG}`)
    assertEquals(again.status, 200, again.text)
    assertEquals(rowOf(again.json<WorldProject>(), byHand).filename, byHand)
  } finally {
    await server.stop()
  }
})

// ─── The first placement of a scan whose sidecar was not there at first sight ────

Deno.test('a scan frozen at its GPS or grid placement gets its calibration as its first placement when the sidecar is read, and Reset brings it there', async () => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'late-sidecar.glb', '')
    // The upload queues an optimize-scan job that reads and writes this same world: let it finish before the
    // test rewrites the world file by hand, or its edit is overwritten (the race behind an intermittent failure).
    await untilJobsSettle(server)
    const first = rowOf(await readWorld(server), filename)
    assertEquals(first.calibratedLocalToWorld, first.localToWorld, 'no sidecar yet: the placement it has')
    assertNotEquals(first.localToWorld, calibrated())

    // The state an older build left behind: the row frozen where it first landed, no stamp, and a sidecar that holds the calibration.
    const file = `${server.worldsDir}/${SLUG}.json`
    const legacy = JSON.parse(await Deno.readTextFile(file)) as WorldProject
    for (const scan of legacy.scans) delete scan.calibratedLocalToWorld
    await Deno.writeTextFile(file, JSON.stringify(legacy))
    await Deno.writeTextFile(`${server.scansDir}/${filename.replace(/\.glb$/, '.json')}`, phoneMetadata())

    const repaired = rowOf(await readWorld(server), filename)
    assertEquals(repaired.calibratedLocalToWorld, normaliseZeros(calibrated()), 'the calibration is the first placement')
    assertEquals(repaired.localToWorld, first.localToWorld, 'the row itself is not moved behind anyone\'s back')
    assertEquals(repaired.calibrationStatus, 'provisional')

    // Reset to calibrated: an ordinary patch carrying the stamp.
    const reset = await server.post(`/worlds/${SLUG}/patches`, patchBody(repaired, repaired.calibratedLocalToWorld))
    assertEquals(reset.status, 200, reset.text)
    assert(sameBits(rowOf(reset.json<{ world: WorldProject }>().world, filename).localToWorld, normaliseZeros(calibrated())))
  } finally {
    await server.stop()
  }
})

Deno.test('a .glb copied in by hand ahead of its sidecar keeps the placement it was first given: a stamp, once written, does not change', async () => {
  const server = await startServer()
  try {
    const name = `${Date.now()}_copied.glb`
    await Deno.mkdir(server.scansDir, { recursive: true })
    await Deno.writeFile(`${server.scansDir}/${name}`, new Uint8Array(700).fill(1))
    const first = rowOf(await readWorld(server), name)
    await Deno.writeTextFile(`${server.scansDir}/${name.replace(/\.glb$/, '.json')}`, phoneMetadata())
    const later = rowOf(await readWorld(server), name)
    assertEquals(later.calibratedLocalToWorld, first.calibratedLocalToWorld, 'written once, never overwritten')
    assertEquals(later.localToWorld, first.localToWorld)
  } finally {
    await server.stop()
  }
})

// ─── The patches and undo routes: what a request may carry ─────────────────────

Deno.test('POST /worlds/:slug/patches stores only the parts of a transform it knows, answers a client view, and takes a body of a sane size', async (t) => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'bounds.glb', phoneMetadata({ scanName: 'Kitchen' }))
    const row = rowOf(await readWorld(server), filename)
    const tokens = await tokensOf(server)
    const members = await memberIdsOf(server)

    await t.step('a transform carrying more than its four parts is stored as those four', async () => {
      const reply = await server.post(`/worlds/${SLUG}/patches`, {
        ...patchBody(row, moved(0.3)),
        transform: {
          matrix: moved(0.3),
          position: { x: 1, y: 2, z: 3, note: 'x'.repeat(50_000) },
          stowaway: 'y'.repeat(50_000),
        },
      }, tokens.editor)
      assertEquals(reply.status, 200, reply.text)
      const stored = reply.json<{ patch: EditPatch }>().patch
      assertEquals(Object.keys(stored.transform!).sort(), ['matrix', 'position'])
      assertEquals(stored.transform!.position, { x: 1, y: 2, z: 3 })
      const log = (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>()
      assert(JSON.stringify(log.at(-1)).length < 2000, 'the stored patch is small')
      assertEquals(stored.actorId, members.editor, 'and it names the member who made it')
    })

    await t.step('the answer is a client view: the other members\' tokens are not in it', async () => {
      const reply = await server.post(`/worlds/${SLUG}/patches`, patchBody(row, moved(0.31)), tokens.editor)
      assertEquals(reply.status, 200, reply.text)
      const world = reply.json<{ world: WorldProject }>().world
      assertEquals(world.members.filter((member) => member.role !== 'editor' && member.token !== '').length, 0)
      assertEquals(world.members.find((member) => member.role === 'editor')!.token, tokens.editor, 'its own token is still its own')
      assert(!reply.text.includes(tokens.owner!), 'the owner\'s token is nowhere in the reply')
    })

    await t.step('a body over a megabyte is refused with 413 and nothing is stored', async () => {
      const before = (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>().length
      const big = await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', targetId: `${row.scanId}/chair`, notes: 'n'.repeat(1_100_000) }, tokens.editor)
      assertEquals(big.status, 413, big.text.slice(0, 200))
      const bigUndo = await server.post(`/worlds/${SLUG}/patches/revert`, { scanId: row.scanId, junk: 'j'.repeat(1_100_000) }, tokens.editor)
      assertEquals(bigUndo.status, 413)
      assertEquals((await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>().length, before)
      const ordinary = await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', targetId: `${row.scanId}/chair`, notes: 'n'.repeat(5_000) }, tokens.editor)
      assertEquals(ordinary.status, 200, 'a real note is nowhere near the cap')
    })

    await t.step('a patch that moves a node named like a whole scan is refused, whichever name it uses, and a label for the scan is not', async () => {
      const before = (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>().length
      const mirrored = calibrated()
      for (const i of [8, 9, 10]) mirrored[i] = -mirrored[i]!
      for (const targetId of [row.scanId, row.filename, row.name]) {
        for (const scope of ['object', 'point-selection', 'layer'] as const) {
          const reply = await server.post(`/worlds/${SLUG}/patches`, { scope, targetId, scanId: row.scanId, transform: { matrix: mirrored } }, tokens.editor)
          assertEquals(reply.status, 400, `${scope} patch for ${targetId}: ${reply.text}`)
          assertStringIncludes(reply.json<{ error: string }>().error, 'scan patch')
        }
      }
      assertEquals((await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>().length, before, 'none was stored')
      assertEquals(row.name, 'Kitchen', 'the name the editor calls the scan root by is the scan\'s name')
      const label = await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', targetId: row.scanId, scanId: row.scanId, label: 'Kitchen, west wall' }, tokens.editor)
      assertEquals(label.status, 200, 'a label for the scan root needs no matrix')
      const chair = await server.post(`/worlds/${SLUG}/patches`, { scope: 'object', targetId: `${row.scanId}:chair`, scanId: row.scanId, transform: { matrix: mirrored } }, tokens.editor)
      assertEquals(chair.status, 200, 'an object inside the scan keeps its freedom')
    })

    await t.step('a body that is not JSON, or not an object, is a missing target, as it always was', async () => {
      for (const body of ['', 'not json', '[]', 'null', '42', '{"targetId": ']) {
        const reply = await server.postRaw(`/worlds/${SLUG}/patches`, body, tokens.editor)
        assertEquals(reply.status, 400, JSON.stringify(body))
        assertEquals(reply.json<{ error: string }>().error, 'targetId is required')
      }
    })
  } finally {
    await server.stop()
  }
})

Deno.test('the undo route refuses a request it cannot read as one, instead of undoing the newest move with no guard', async (t) => {
  const server = await startServer()
  try {
    const a = await uploaded(server, 'undo-a.glb', phoneMetadata({ sessionId: 'session-a' }))
    const b = await uploaded(server, 'undo-b.glb', phoneMetadata({ sessionId: 'session-b' }))
    const world = await readWorld(server)
    const rowA = rowOf(world, a.filename)
    const rowB = rowOf(world, b.filename)
    const tokens = await tokensOf(server)
    const members = await memberIdsOf(server)
    const moveA = (await server.post(`/worlds/${SLUG}/patches`, patchBody(rowA, moved(0.1)), tokens.editor)).json<{ patch: EditPatch }>().patch
    const moveB = (await server.post(`/worlds/${SLUG}/patches`, patchBody(rowB, moved(0.2)), tokens.editor)).json<{ patch: EditPatch }>().patch
    const log = async (): Promise<EditPatch[]> => (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>()
    const placements = async (): Promise<number[][]> => {
      const now = await readWorld(server)
      return [rowOf(now, a.filename).localToWorld, rowOf(now, b.filename).localToWorld]
    }
    const before = (await log()).length
    const untouched = await placements()

    // Raw bodies: server.post() would encode them, and the point is what arrives.
    const raw = (body: string): Promise<Reply> => server.postRaw(`/worlds/${SLUG}/patches/revert`, body, tokens.editor)
    for (const [label, body] of [
      ['an empty body', ''],
      ['a body cut off in the middle', '{"scanId": "scan-'],
      ['a list', '[]'],
      ['null', 'null'],
      ['a number for the scan', JSON.stringify({ scanId: 12345 })],
      ['a number for the patch', JSON.stringify({ scanId: rowA.scanId, patchId: 42 })],
      ['a list for the patch', JSON.stringify({ patchId: ['x'] })],
      ['an empty scan id', JSON.stringify({ scanId: '' })],
    ] as const) {
      await t.step(`${label} is a 400 and undoes nothing`, async () => {
        const reply = await raw(body)
        assertEquals(reply.status, 400, reply.text)
        assertEquals((await log()).length, before)
        assertEquals(await placements(), untouched)
      })
    }

    await t.step('an empty object asks for the newest move in the world, on purpose, and the undo is made by the member who asked', async () => {
      const reply = await server.post(`/worlds/${SLUG}/patches/revert`, {}, tokens.editor)
      assertEquals(reply.status, 200, reply.text)
      assertEquals(reply.json<{ reverted: string }>().reverted, moveB.patchId, 'scan B was moved last')
      assertEquals(reply.json<{ patch: EditPatch }>().patch.actorId, members.editor)
      assertEquals((await placements())[0], moved(0.1), 'scan A is where its move put it')
      assert(moveA.patchId !== moveB.patchId)
    })
  } finally {
    await server.stop()
  }
})

Deno.test('a scan turned and set to exactly twice or half its size is taken, however it was turned', async () => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'ends.glb', phoneMetadata())
    const row = rowOf(await readWorld(server), filename)
    let seed = 11
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (const size of [2, 0.5]) {
      for (let i = 0; i < 25; i++) {
        const matrix = rotatedBy(next, size)
        const reply = await server.post(`/worlds/${SLUG}/patches`, patchBody(row, matrix))
        assertEquals(reply.status, 200, `size ${size}, rotation ${i}: ${reply.text}`)
      }
    }
  } finally {
    await server.stop()
  }
})

// ─── What the previous build left behind ─────────────────────────────────────

Deno.test('a world file the previous build wrote still loads, replays and undoes: patches with extra keys, a skewed matrix, and no first placement', async () => {
  const server = await startServer()
  try {
    const { filename } = await uploaded(server, 'older.glb', phoneMetadata())
    // As above: the upload's optimize-scan job must finish before the world file is rewritten by hand.
    await untilJobsSettle(server)
    const first = rowOf(await readWorld(server), filename)
    const tokens = await tokensOf(server)

    // The old route stored whatever it was sent: a skewed matrix, keys no reader knows, a null matrix.
    const old = (patchId: string, over: Partial<EditPatch>): EditPatch => ({
      patchId, worldId: 'world-default', scanId: first.scanId, targetId: first.filename, scope: 'scan', createdAt: '2026-01-01T00:00:00.000Z', ...over,
    })
    const skewed = skewedBy(calibrated(), 0.3)
    const legacyPatches: EditPatch[] = [
      old('patch-old-1', { transform: { matrix: skewed, junk: 'x'.repeat(2000) } as EditPatch['transform'] }),
      old('patch-old-2', { transform: { matrix: moved(0.25), position: { x: 1, y: 2, z: 3, extra: true } } as EditPatch['transform'] }),
      old('patch-old-3', { scope: 'object', targetId: `${first.scanId}:chair`, transform: { matrix: moved(0.5), stowaway: [1, 2, 3] } as EditPatch['transform'] }),
    ]
    const file = `${server.worldsDir}/${SLUG}.json`
    const legacy = JSON.parse(await Deno.readTextFile(file)) as WorldProject
    legacy.editPatches = legacyPatches
    for (const scan of legacy.scans) {
      delete scan.calibratedLocalToWorld
      scan.localToWorld = moved(0.25)
    }
    await Deno.writeTextFile(file, JSON.stringify(legacy))

    const read = await server.get(`/worlds/${SLUG}`)
    assertEquals(read.status, 200, read.text)
    assertEquals(rowOf(read.json<WorldProject>(), filename).localToWorld, moved(0.25), 'the row is where the old build left it')
    assertEquals(rowOf(read.json<WorldProject>(), filename).calibratedLocalToWorld, normaliseZeros(calibrated()), 'and its first placement is recovered from its sidecar')
    const log = (await server.get(`/worlds/${SLUG}/patches`)).json<EditPatch[]>()
    assertEquals(log.slice(0, 3), legacyPatches, 'the old patches are served exactly as they were stored')

    // Undoing the newest move of the scan steps over the skewed one and goes back to where the scan arrived.
    const undone = await server.post(`/worlds/${SLUG}/patches/revert`, { scanId: first.scanId, patchId: 'patch-old-2' }, tokens.editor)
    assertEquals(undone.status, 200, undone.text)
    assertEquals(undone.json<{ restoredTo: string }>().restoredTo, 'first-placement')
    assert(sameBits(rowOf(undone.json<{ world: WorldProject }>().world, filename).localToWorld, normaliseZeros(calibrated())))
  } finally {
    await server.stop()
  }
})

Deno.test('metadata too long to read is not read: the scan is stored, flagged, and placed by GPS or the grid, and the server stays quick', async () => {
  const server = await startServer()
  try {
    const head = '{"detectionCount":9,"pad":"'
    const huge = head + 'x'.repeat(MAX_CHECKED_METADATA_CHARS + 1 - head.length - 2) + '"}'
    assertEquals(huge.length, MAX_CHECKED_METADATA_CHARS + 1)
    const { filename, reply } = await uploaded(server, 'huge-notes.glb', huge)
    assertStringIncludes(reply.json<{ projectTransformRejected: string }>().projectTransformRejected, 'too long')
    const sidecarText = await Deno.readTextFile(`${server.scansDir}/${filename.replace(/\.glb$/, '.json')}`)
    assert(sidecarText.length < 2000, 'the phone\'s text is not copied into the sidecar')
    const row = rowOf(await readWorld(server), filename)
    assertStringIncludes(row.projectTransformRejected ?? '', 'too long')
    assertEquals(row.calibrationStatus, 'uncalibrated')
    assert(checkPlacementMatrix(row.localToWorld).ok)
  } finally {
    await server.stop()
  }
})
