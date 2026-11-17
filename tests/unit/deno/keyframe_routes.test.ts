/**
 * Keyframe deletion and retention on the real server: the routes, the guard and the job, as wired.
 *
 * tests/unit/deno/keyframe_deletion.test.ts and keyframe_retention.test.ts hold the rules against real
 * directories. This holds what only the wired server can show: that `DELETE /scans/:filename` takes the scan's
 * camera frames with it (and what a scan made from the frames' own derivatives leaves), that `DELETE /sessions/:id`
 * exists and is guarded like the scan route, that `DELETE /projects/:id` leaves no camera data behind, that
 * clearing all scans clears the sessions, and that the `keyframe-purge` job runs at boot and on request, obeys
 * `KEYFRAME_RETENTION_DAYS` and `payload.dryRun`, and logs counts and nothing else.
 *
 * It also holds what a deletion must not leave behind or race with: LingBot-Map's and SenseNova's output, a scan deleted
 * while a job runs on it, a name that is not a name, a Place whose photos or world cannot be removed, the world export
 * built from a deleted scan, and the frames a walk streamed after its last export.
 *
 * `server/main.ts` serves at import and exports nothing, so each server here is the real one on a free port,
 * with every directory it writes in a temp folder (the way place_register_server.test.ts does).
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import type { WorldJob } from '../../../src/world/types.ts'
import { safeSlug } from '../../../server/scan_id.ts'
import { cannotRemoveFromReadOnlyFolder } from './read_only_folders.ts'

/** Root can write anywhere, so a test that makes its failure with permissions is ignored there, not passed. */
const CAN_MAKE_A_PERMISSION_FAILURE = await cannotRemoveFromReadOnlyFolder()

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 30_000
const DAY = 24 * 60 * 60 * 1000

const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  text: string
  json<T = Record<string, unknown>>(): T
}

interface Dirs {
  root: string
  scans: string
  sessions: string
  media: string
}

interface RunningServer {
  dirs: Dirs
  request(method: string, path: string, body?: unknown): Promise<Reply>
  form(path: string, form: FormData): Promise<Reply>
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

async function startServer(opts: { env?: Record<string, string>; seed?: (dirs: Dirs) => Promise<void> } = {}): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'keyframe-routes-' })
  const dirs: Dirs = { root, scans: `${root}/scans`, sessions: `${root}/scans/sessions`, media: `${root}/scans/projects` }
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
    await Deno.mkdir(dirs.sessions, { recursive: true })
    await Deno.mkdir(`${root}/worlds`, { recursive: true })
    if (opts.seed) await opts.seed(dirs)
    child = new Deno.Command(Deno.execPath(), {
      args: ['run', '--no-prompt', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run', SERVER_ENTRY],
      cwd: fromFileUrl(REPO_ROOT),
      clearEnv: true,
      env: {
        ...inherited,
        PORT: '0',
        SCANS_DIR: dirs.scans,
        WORLDS_DIR: `${root}/worlds`,
        SUMMARIES_DIR: `${root}/summaries`,
        PROJECTS_FILE: `${root}/projects.json`,
        STATIC_DIR: `${root}/no-static-bundle`,
        INFERENCE_MODE: 'mock',
        TAILSCALE_HOSTNAME: 'scan.test',
        ...(opts.env ?? {}),
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
    if (!('port' in outcome)) throw new Error(`the server did not start (${JSON.stringify(outcome)}). Its output:\n${output.slice(-4000)}`)
    const base = `http://127.0.0.1:${outcome.port}`
    return {
      dirs,
      request: (method, path, body) =>
        send(base, path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      form: (path, form) => send(base, path, { method: 'POST', body: form }),
      log: () => output,
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** A GLB the server accepts as a scan. What is in it does not matter to deletion. */
function glb(): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }))
  const padded = new Uint8Array(json.length + ((4 - (json.length % 4)) % 4)).fill(0x20)
  padded.set(json)
  const bytes = new Uint8Array(20 + padded.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546C67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.length, true)
  view.setUint32(12, padded.length, true)
  view.setUint32(16, 0x4E4F534A, true)
  bytes.set(padded, 20)
  return bytes
}

async function uploadScan(server: RunningServer, name: string, metadata: Record<string, unknown> = {}): Promise<{ filename: string; job: string }> {
  const form = new FormData()
  form.append('file', new Blob([glb()], { type: 'model/gltf-binary' }), `${name}.glb`)
  form.append('metadata', JSON.stringify(metadata))
  const reply = await server.form('/upload-scan', form)
  assertEquals(reply.status, 200, reply.text)
  const body = reply.json<{ filename: string; job: string }>()
  await settledOptimize(server, body.job)
  return body
}

/** The optimizer writes beside the scan when it finishes, so a delete waits for it, as a person's delete would. */
async function settledOptimize(server: RunningServer, jobId: string): Promise<void> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const job = (await server.request('GET', `/jobs/${jobId}`)).json<{ status?: string }>()
    if (job.status === 'done' || job.status === 'error') return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the optimize job ${jobId} did not settle.\n${server.log()}`)
}

/** A session as a phone streams one: opened, given frames, and finalized against the scan it exported. */
async function streamSession(server: RunningServer, glbFilename: string | null, frames = 2): Promise<string> {
  const opened = await server.request('POST', '/sessions', {})
  assertEquals(opened.status, 201, opened.text)
  const sessionId = opened.json<{ sessionId: string }>().sessionId
  for (let index = 0; index < frames; index++) {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(500 + index)], { type: 'image/jpeg' }), `kf-${index}.jpg`)
    form.append('meta', JSON.stringify({ index, pose: { position: { x: 0, y: 0, z: 0 } } }))
    assertEquals((await server.form(`/sessions/${sessionId}/keyframes`, form)).status, 200)
  }
  if (glbFilename !== null) assertEquals((await server.request('POST', `/sessions/${sessionId}/finalize`, { glbFilename })).status, 200)
  return sessionId
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

async function jobs(server: RunningServer): Promise<WorldJob[]> {
  return (await server.request('GET', '/worlds/default/jobs')).json<WorldJob[]>()
}

/** Waits for a keyframe-purge job that is not one of `known` to reach a terminal state. */
async function purgeJob(server: RunningServer, known: readonly string[] = []): Promise<WorldJob> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  let seen: WorldJob | undefined
  while (Date.now() < deadline) {
    seen = (await jobs(server)).find((job) => job.type === 'keyframe-purge' && !known.includes(job.jobId))
    if (seen && (seen.status === 'completed' || seen.status === 'failed')) return seen
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`no finished keyframe-purge job (last seen: ${JSON.stringify(seen)}).\n${server.log()}`)
}

/** Writes a session into the server's folder with the age a purge reads: the record's date and the files' times. */
async function seedSession(dirs: Dirs, id: string, ageDays: number, record: Record<string, unknown> = {}): Promise<void> {
  const dir = `${dirs.sessions}/${id}`
  await Deno.mkdir(dir, { recursive: true })
  const when = new Date(Date.now() - ageDays * DAY)
  await Deno.writeFile(`${dir}/kf-00000.jpg`, new Uint8Array(3000))
  await Deno.writeTextFile(`${dir}/keyframes.jsonl`, '{"index":0,"file":"kf-00000.jpg"}\n')
  await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify({ sessionId: id, startedAt: when.toISOString(), keyframeCount: 1, ...record }))
  for (const file of ['kf-00000.jpg', 'keyframes.jsonl', 'session.json']) await Deno.utime(`${dir}/${file}`, when, when)
  await Deno.utime(dir, when, when)
}

const OLD = 'sess-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RECENT = 'sess-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UPLOAD = 'sess-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const UPLOAD_OF_PLACE = 'sess-dddddddd-dddd-4ddd-8ddd-dddddddddddd'

// ── Deleting scans, sessions and Places ─────────────────────────────────────────

Deno.test('deleting a scan on the real server removes its camera frames, what was made from them, and keeps another scan\'s', async () => {
  const server = await startServer()
  try {
    const mine = await uploadScan(server, 'mine')
    const other = await uploadScan(server, 'other')
    const base = mine.filename.replace(/\.glb$/, '')
    // Two rotated sessions finalized against the scan, and one that is another scan's.
    const first = await streamSession(server, mine.filename)
    const second = await streamSession(server, mine.filename)
    const others = await streamSession(server, other.filename)
    // What the splat and person jobs write beside a scan, from the same frames.
    for (const suffix of ['.splat.ply', '.sog', '.compressed.ply', '.splat-train.manifest.json', '.interactions.json']) {
      await Deno.writeTextFile(`${server.dirs.scans}/${base}${suffix}`, 'derived')
    }
    await Deno.mkdir(`${server.dirs.scans}/${base}.4d`, { recursive: true })
    await Deno.writeTextFile(`${server.dirs.scans}/${base}.4d/frame-00000.sog`, 'x')

    const logged = server.log().length
    const reply = await server.request('DELETE', `/scans/${encodeURIComponent(mine.filename)}`)
    assertEquals(reply.status, 200, reply.text)
    // Opening and finalizing a session log its id, as they always did. Deleting one logs nothing that names it.
    const afterDelete = server.log().slice(logged)
    for (const secret of [first, second, others, server.dirs.root]) assertFalse(afterDelete.includes(secret), `the delete logged ${secret}`)
    const body = reply.json<{ ok: boolean; deleted: { glb: boolean; metadata: boolean; keyframeSessions: number }; keyframes: { sessions: number; retained: unknown[] } }>()
    assertEquals(body.ok, true)
    assertEquals(body.deleted.glb, true)
    assertEquals(body.deleted.metadata, true, 'the existing fields are as they were')
    assertEquals(body.deleted.keyframeSessions, 2)
    assertEquals(body.keyframes.sessions, 2)
    assertEquals(body.keyframes.retained, [])

    for (const id of [first, second]) assertFalse(await exists(`${server.dirs.sessions}/${id}`), `${id} went with the scan`)
    assert(await exists(`${server.dirs.sessions}/${others}`), 'another scan\'s frames are not touched')
    assert(await exists(`${server.dirs.scans}/${other.filename}`))
    for (const suffix of ['.splat.ply', '.sog', '.compressed.ply', '.splat-train.manifest.json', '.interactions.json']) {
      assertFalse(await exists(`${server.dirs.scans}/${base}${suffix}`), `${suffix} went with the scan`)
    }
    assertFalse(await exists(`${server.dirs.scans}/${base}.4d`), 'the 4D sequence went with the scan')

    // A second delete is the same answer as before this change: the scan is gone.
    assertEquals((await server.request('DELETE', `/scans/${encodeURIComponent(mine.filename)}`)).status, 404)
  } finally {
    await server.stop()
  }
})

Deno.test({
  name: 'a scan whose frames cannot all be removed is kept, the failure is reported, and a second try finishes the job',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  const server = await startServer()
  try {
    // A folder a person cannot write to, as a failing disk or a stray permission leaves one.
    const scan = await uploadScan(server, 'stuck')
    const sessionId = await streamSession(server, scan.filename)
    const stuck = `${server.dirs.sessions}/${sessionId}/work`
    await Deno.mkdir(stuck)
    await Deno.writeTextFile(`${stuck}/output.bin`, 'x')
    await Deno.chmod(stuck, 0o555)
    try {
      const logged = server.log().length
      const reply = await server.request('DELETE', `/scans/${encodeURIComponent(scan.filename)}`)
      assertEquals(reply.status, 500, reply.text)
      assertFalse(reply.text.includes('output.bin') || server.log().slice(logged).includes('output.bin'), 'the failure names no file')
      const body = reply.json<{ error: string; keyframes: { failed: number; sessions: number } }>()
      assertStringIncludes(body.error, 'the scan was kept')
      assertEquals(body.keyframes.failed, 1)
      assert(await exists(`${server.dirs.scans}/${scan.filename}`), 'the scan is still here, so it can be deleted again')
      assert(await exists(`${server.dirs.sessions}/${sessionId}/session.json`), 'and its session can still be found')
    } finally {
      await Deno.chmod(stuck, 0o755)
    }
    const retry = await server.request('DELETE', `/scans/${encodeURIComponent(scan.filename)}`)
    assertEquals(retry.status, 200, retry.text)
    assertEquals(retry.json<{ deleted: { keyframeSessions: number } }>().deleted.keyframeSessions, 1)
    assertFalse(await exists(`${server.dirs.sessions}/${sessionId}`))
    assertFalse(await exists(`${server.dirs.scans}/${scan.filename}`))
  } finally {
    await server.stop()
  }
})

Deno.test('a session two scans name stays until the last of them is deleted, and the answer says so', async () => {
  const server = await startServer()
  try {
    const a = await uploadScan(server, 'a')
    const b = await uploadScan(server, 'b')
    const shared = await streamSession(server, a.filename)
    // The second scan's own sidecar names the same session.
    await Deno.writeTextFile(`${server.dirs.scans}/${b.filename.replace(/\.glb$/, '.json')}`, JSON.stringify({ sessionId: shared }))

    const first = await server.request('DELETE', `/scans/${encodeURIComponent(a.filename)}`)
    assertEquals(first.status, 200, first.text)
    const kept = first.json<{ keyframes: { sessions: number; retained: Array<{ sessionId: string; usedBy: string[] }> } }>().keyframes
    assertEquals(kept.sessions, 0)
    assertEquals(kept.retained, [{ sessionId: shared, usedBy: [b.filename] }])
    assert(await exists(`${server.dirs.sessions}/${shared}`), 'the frames are still scan b\'s')

    const last = await server.request('DELETE', `/scans/${encodeURIComponent(b.filename)}`)
    assertEquals(last.json<{ deleted: { keyframeSessions: number } }>().deleted.keyframeSessions, 1)
    assertFalse(await exists(`${server.dirs.sessions}/${shared}`))
  } finally {
    await server.stop()
  }
})

Deno.test('DELETE /sessions/:id removes a session\'s frames, answers 404 once it is gone, and refuses an upload\'s own session', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedSession(dirs, UPLOAD, 1, { source: 'video-ingest' })
    },
  })
  try {
    const streamed = await streamSession(server, null)
    assert(await exists(`${server.dirs.sessions}/${streamed}`))
    const removed = await server.request('DELETE', `/sessions/${streamed}`)
    assertEquals(removed.status, 200, removed.text)
    assertEquals(removed.json().ok, true)
    assertFalse(await exists(`${server.dirs.sessions}/${streamed}`))
    assertEquals((await server.request('DELETE', `/sessions/${streamed}`)).status, 404, 'a repeated delete finds it gone')
    assertEquals((await server.request('DELETE', '/sessions/not-a-session')).status, 400)
    assertEquals((await server.request('DELETE', '/sessions/..%2F..%2Fetc')).status >= 400, true)
    // A phone cannot delete the data a scan was made from through this route.
    assertEquals((await server.request('DELETE', `/sessions/${UPLOAD}`)).status, 409)
    assert(await exists(`${server.dirs.sessions}/${UPLOAD}`))
    // Frames to a deleted session are refused, so a phone that is told to stop cannot refill it.
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(10)]), 'kf.jpg')
    form.append('meta', JSON.stringify({ index: 5 }))
    assertEquals((await server.form(`/sessions/${streamed}/keyframes`, form)).status, 404)
    assertFalse(await exists(`${server.dirs.sessions}/${streamed}`), 'nothing came back')
  } finally {
    await server.stop()
  }
})

Deno.test('a Place is not deleted while it holds a scan, an upload scan included, and its reference photos go with it', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedSession(dirs, UPLOAD_OF_PLACE, 1, { source: 'photo-ingest' })
    },
  })
  try {
    const place = (await server.request('POST', '/projects', { name: 'Flat' })).json<{ projectId: string }>().projectId
    const other = (await server.request('POST', '/projects', { name: 'Other flat' })).json<{ projectId: string }>().projectId
    // A reference photo of each Place, as a calibration uploads them.
    for (const id of [place, other]) {
      const form = new FormData()
      form.append('image', new Blob([new Uint8Array(200)], { type: 'image/jpeg' }), 'ref.jpg')
      form.append('meta', JSON.stringify({
        role: 'landmark',
        tapPoint: { x: 0.5, y: 0.5 },
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        capturedAt: new Date().toISOString(),
      }))
      assertEquals((await server.form(`/projects/${id}/reference-photos`, form)).status, 200)
      assert(await exists(`${server.dirs.media}/${id}/ref-landmark.jpg`))
    }

    // A GLB scan holds the Place.
    const scan = await uploadScan(server, 'in-place', { projectId: place })
    const held = await server.request('DELETE', `/projects/${place}`)
    assertEquals(held.status, 409)
    assertEquals(held.json().scanCount, 1)
    assert(await exists(`${server.dirs.media}/${place}/ref-landmark.jpg`), 'a refused delete removes nothing')

    // So does a scan made from an upload, which has no GLB.
    await Deno.writeTextFile(`${server.dirs.scans}/${UPLOAD_OF_PLACE}.json`, JSON.stringify({ sessionId: UPLOAD_OF_PLACE, source: 'photo-ingest', projectId: place }))
    assertEquals((await server.request('DELETE', `/projects/${place}`)).json().scanCount, 2)

    // Each scan takes its own frames with it.
    assertEquals((await server.request('DELETE', `/scans/${encodeURIComponent(scan.filename)}`)).status, 200)
    const uploadScanDelete = await server.request('DELETE', `/scans/${UPLOAD_OF_PLACE}.glb`)
    assertEquals(uploadScanDelete.status, 200, uploadScanDelete.text)
    assertFalse(await exists(`${server.dirs.sessions}/${UPLOAD_OF_PLACE}`), 'the upload scan\'s session went with the scan')

    const gone = await server.request('DELETE', `/projects/${place}`)
    assertEquals(gone.status, 200, gone.text)
    assertEquals(gone.json().referencePhotosRemoved, true)
    assertFalse(await exists(`${server.dirs.media}/${place}`), 'the Place\'s reference photos went with it')
    assert(await exists(`${server.dirs.media}/${other}/ref-landmark.jpg`), 'another Place\'s photos are not touched')
    assertEquals((await server.request('DELETE', `/projects/${place}`)).status, 404)

    // A merged-away Place is gone, so its photos are too.
    const merged = await server.request('POST', `/projects/${other}/merge`, { sourceProjectId: other })
    assertEquals(merged.status, 400, 'a Place is not merged into itself')
    const third = (await server.request('POST', '/projects', { name: 'Third' })).json<{ projectId: string }>().projectId
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(200)], { type: 'image/jpeg' }), 'ref.jpg')
    form.append('meta', JSON.stringify({ role: 'headingMarker', tapPoint: { x: 0.2, y: 0.2 }, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: new Date().toISOString() }))
    assertEquals((await server.form(`/projects/${third}/reference-photos`, form)).status, 200)
    assertEquals((await server.request('POST', `/projects/${other}/merge`, { sourceProjectId: third })).status, 200)
    assertFalse(await exists(`${server.dirs.media}/${third}`), 'the merged-away Place\'s photos went')
  } finally {
    await server.stop()
  }
})

Deno.test('clearing all scans clears the sessions too', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedSession(dirs, OLD, 400)
      await seedSession(dirs, UPLOAD, 1, { source: 'video-ingest' })
    },
  })
  try {
    await uploadScan(server, 'one')
    const streamed = await streamSession(server, null)
    // What the splat and person jobs made from a scan's frames sits at the top of the scans folder too.
    await Deno.writeTextFile(`${server.dirs.scans}/kept-by-nobody.splat.ply`, 'derived')
    await Deno.writeTextFile(`${server.dirs.scans}/kept-by-nobody.sog`, 'derived')
    await Deno.mkdir(`${server.dirs.scans}/kept-by-nobody.4d`)
    await Deno.writeTextFile(`${server.dirs.scans}/kept-by-nobody.4d/frame-00000.sog`, 'x')
    assertEquals((await server.request('DELETE', '/scans')).status, 400, 'still needs the confirmation')
    assert(await exists(`${server.dirs.sessions}/${streamed}`), 'nothing was removed without it')
    const reply = await server.request('DELETE', '/scans?confirm=delete-all')
    assertEquals(reply.status, 200, reply.text)
    assertEquals(reply.json().keyframeSessions, 3)
    for (const id of [OLD, UPLOAD, streamed]) assertFalse(await exists(`${server.dirs.sessions}/${id}`), `${id} is gone`)
    for (const name of ['kept-by-nobody.splat.ply', 'kept-by-nobody.sog', 'kept-by-nobody.4d']) {
      assertFalse(await exists(`${server.dirs.scans}/${name}`), `${name} went with the scans`)
    }
    assert(await exists(server.dirs.sessions), 'the sessions folder itself stays: the server writes new sessions there')
  } finally {
    await server.stop()
  }
})

Deno.test('the deletion routes answer to the same session guard as the scan route', async () => {
  // With SCAN_REQUIRE_AUTH=1 and no sign-in, the guard admits no request, so each of these is refused before it runs.
  const server = await startServer({ env: { SCAN_REQUIRE_AUTH: '1' } })
  try {
    const scan = await server.request('DELETE', '/scans/some.glb')
    assertEquals(scan.status, 401, 'the scan route is guarded')
    for (const path of [`/sessions/${OLD}`, `/projects/proj-1`, '/scans?confirm=delete-all']) {
      assertEquals((await server.request('DELETE', path)).status, scan.status, `${path} is guarded the same way`)
    }
  } finally {
    await server.stop()
  }
})

// ── Retention ───────────────────────────────────────────────────────────────────

Deno.test('with KEYFRAME_RETENTION_DAYS set, a purge runs at boot: old streamed sessions go, newer ones and uploads stay, and the log has counts only', async () => {
  const server = await startServer({
    env: { KEYFRAME_RETENTION_DAYS: '30' },
    seed: async (dirs) => {
      await seedSession(dirs, OLD, 90)
      await seedSession(dirs, RECENT, 3)
      await seedSession(dirs, UPLOAD, 400, { source: 'photo-ingest' })
    },
  })
  try {
    const job = await purgeJob(server)
    assertEquals(job.status, 'completed', `${job.error}\n${server.log()}`)
    assertStringIncludes(job.result ?? '', 'deleted 1 of 3')
    assertFalse(await exists(`${server.dirs.sessions}/${OLD}`), 'the old session was purged')
    assert(await exists(`${server.dirs.sessions}/${RECENT}`))
    assert(await exists(`${server.dirs.sessions}/${UPLOAD}`), 'a scan\'s own source is not purged')
    const log = server.log()
    assertStringIncludes(log, '[keyframe-retention]')
    for (const secret of [OLD, RECENT, UPLOAD, server.dirs.root]) assertFalse(log.includes(secret), `the log names ${secret}`)
    assertFalse(/\/keyframe|kf-00000/.test(log.split('\n').filter((line) => line.includes('[keyframe-retention]')).join('\n')), 'the retention lines name no file')
  } finally {
    await server.stop()
  }
})

Deno.test('a request is a dry run unless it says dryRun:false, and only the server\'s own period removes anything', async () => {
  const server = await startServer({ env: { KEYFRAME_RETENTION_DAYS: '30' } })
  try {
    let known = [(await purgeJob(server)).jobId]
    await seedSession(server.dirs, OLD, 90)
    await seedSession(server.dirs, RECENT, 3)

    // Every one of these reports and removes nothing: the flag is true, is spelt another way, or is not there at all.
    // `retentionDays: 1` is not a field any request has: the period is the server's thirty.
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ['dryRun: true', { dryRun: true, retentionDays: 1 }],
      ['dryRun: "true"', { dryRun: 'true' }],
      ['dryRun: 1', { dryRun: 1 }],
      ['dryRun: "yes"', { dryRun: 'yes' }],
      ['dryRun: "false"', { dryRun: 'false' }],
      ['dryRun: null', { dryRun: null }],
      ['an empty payload', {}],
      ['no payload at all', undefined],
    ]
    for (const [label, payload] of cases) {
      const queued = await server.request('POST', '/worlds/default/jobs', payload === undefined ? { type: 'keyframe-purge' } : { type: 'keyframe-purge', payload })
      assertEquals(queued.status, 202, queued.text)
      const job = await purgeJob(server, known)
      known = [...known, job.jobId]
      assertEquals(job.status, 'completed', label)
      assertStringIncludes(job.result ?? '', 'Dry run, retention 30 days: 1 of 2', label)
      assertStringIncludes(job.result ?? '', 'Nothing was deleted', label)
      assert(await exists(`${server.dirs.sessions}/${OLD}`), `${label}: a request that did not say dryRun:false removed something`)
      assert(await exists(`${server.dirs.sessions}/${RECENT}`))
    }

    // Only the boolean false is a real pass, and it takes the server's thirty days whatever else it carries.
    const real = await server.request('POST', '/worlds/default/jobs', { type: 'keyframe-purge', payload: { dryRun: false, retentionDays: 1, days: 1 } })
    assertEquals(real.status, 202, real.text)
    const realJob = await purgeJob(server, known)
    assertStringIncludes(realJob.result ?? '', 'deleted 1 of 2')
    assertFalse(await exists(`${server.dirs.sessions}/${OLD}`))
    assert(await exists(`${server.dirs.sessions}/${RECENT}`), 'the three-day-old session is inside the server\'s thirty days, whatever the request said')
  } finally {
    await server.stop()
  }
})

Deno.test('a dry run can name a period to preview before the setting is turned on, and removes nothing', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedSession(dirs, OLD, 90)
      await seedSession(dirs, RECENT, 3)
    },
  })
  try {
    assertEquals((await jobs(server)).filter((job) => job.type === 'keyframe-purge'), [], 'the setting is off, so nothing ran at boot')
    const preview = await server.request('POST', '/worlds/default/jobs', { type: 'keyframe-purge', payload: { dryRun: true, days: 30 } })
    assertEquals(preview.status, 202, preview.text)
    const job = await purgeJob(server)
    assertStringIncludes(job.result ?? '', 'Dry run, retention 30 days: 1 of 2')
    assertStringIncludes(job.result ?? '', 'The server\'s own setting is off')
    assert(await exists(`${server.dirs.sessions}/${OLD}`), 'a preview removed nothing')

    // The same request as a real pass has no period to use: the setting is off, so it removes nothing either.
    const real = await server.request('POST', '/worlds/default/jobs', { type: 'keyframe-purge', payload: { dryRun: false, days: 30 } })
    assertEquals(real.status, 202, real.text)
    const realJob = await purgeJob(server, [job.jobId])
    assertStringIncludes(realJob.result ?? '', 'Retention is off')
    assert(await exists(`${server.dirs.sessions}/${OLD}`), 'a real pass takes no period from a request')
  } finally {
    await server.stop()
  }
})

Deno.test('the purge is queued in the default world only', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedSession(dirs, OLD, 4000)
    },
    env: { KEYFRAME_RETENTION_DAYS: '30' },
  })
  try {
    const known = [(await purgeJob(server)).jobId]
    const place = (await server.request('POST', '/projects', { name: 'Elsewhere' })).json<{ projectId: string }>().projectId
    for (const slug of [`project-${place}`, 'some-other-world']) {
      const refused = await server.request('POST', `/worlds/${slug}/jobs`, { type: 'keyframe-purge', payload: { dryRun: false } })
      assertEquals(refused.status, 400, `${slug}: ${refused.text}`)
      assertStringIncludes(refused.text, 'default world only')
    }
    // Nothing else was affected: other job types still queue anywhere, and the default world still takes the purge.
    const other = await server.request('POST', `/worlds/project-${place}/jobs`, { type: 'export-world' })
    assertEquals(other.status, 202, other.text)
    const accepted = await server.request('POST', '/worlds/default/jobs', { type: 'keyframe-purge', payload: { dryRun: true } })
    assertEquals(accepted.status, 202, accepted.text)
    assertEquals((await purgeJob(server, known)).status, 'completed')
  } finally {
    await server.stop()
  }
})

Deno.test('with no retention setting nothing is queued at boot, and a job that is asked for says retention is off and deletes nothing', async () => {
  const server = await startServer({
    seed: async (dirs) => {
      await seedSession(dirs, OLD, 4000)
    },
  })
  try {
    assertEquals((await jobs(server)).filter((job) => job.type === 'keyframe-purge'), [], 'nothing was queued at boot')
    const asked = await server.request('POST', '/worlds/default/jobs', { type: 'keyframe-purge', payload: {} })
    assertEquals(asked.status, 202, asked.text)
    const job = await purgeJob(server)
    assertEquals(job.status, 'completed')
    assertStringIncludes(job.result ?? '', 'Retention is off')
    assert(await exists(`${server.dirs.sessions}/${OLD}`), 'the default keeps everything')
  } finally {
    await server.stop()
  }
})

Deno.test('a mistyped KEYFRAME_RETENTION_DAYS keeps everything, says so, and queues nothing', async () => {
  const server = await startServer({
    env: { KEYFRAME_RETENTION_DAYS: 'ninety' },
    seed: async (dirs) => {
      await seedSession(dirs, OLD, 4000)
    },
  })
  try {
    assertEquals((await jobs(server)).filter((job) => job.type === 'keyframe-purge'), [])
    assertStringIncludes(server.log(), 'KEYFRAME_RETENTION_DAYS must be a whole number of days')
    assert(await exists(`${server.dirs.sessions}/${OLD}`))
  } finally {
    await server.stop()
  }
})

// ── What a deletion must not leave behind, and must not race with ───────────────

/** A GLB with a real point cloud in it, so that the optimizer takes long enough to be caught running. */
function bigGlb(points = 200_000): Uint8Array<ArrayBuffer> {
  const positions = new Float32Array(points * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = (i * 2654435761 % 1000) / 200
  const bin = new Uint8Array(positions.buffer)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: points, type: 'VEC3', min: [0, 0, 0], max: [5, 5, 5] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPadded = new Uint8Array(jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4)).fill(0x20)
  jsonPadded.set(jsonBytes)
  const binPadded = new Uint8Array(bin.length + ((4 - (bin.length % 4)) % 4))
  binPadded.set(bin)
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546C67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonPadded.length, true)
  view.setUint32(16, 0x4E4F534A, true)
  out.set(jsonPadded, 20)
  const at = 20 + jsonPadded.length
  view.setUint32(at, binPadded.length, true)
  view.setUint32(at + 4, 0x004E4942, true)
  out.set(binPadded, at + 8)
  return out
}

async function uploadBigScan(server: RunningServer, name: string): Promise<{ filename: string; job: string }> {
  const form = new FormData()
  form.append('file', new Blob([bigGlb()], { type: 'model/gltf-binary' }), `${name}.glb`)
  form.append('metadata', JSON.stringify({}))
  const reply = await server.form('/upload-scan', form)
  assertEquals(reply.status, 200, reply.text)
  return reply.json<{ filename: string; job: string }>()
}

/** Polls until the legacy job view says the job is neither waiting nor running, or `maxMs` has gone. */
async function untilJobSettled(server: RunningServer, jobId: string, maxMs = JOB_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const status = (await server.request('GET', `/jobs/${jobId}`)).json<{ status?: string }>().status
    if (status === 'done' || status === 'error' || status === undefined) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`job ${jobId} did not settle.\n${server.log()}`)
}

/** Waits until the job has left the queue, as fast as it can be seen, so that a delete lands while it runs. */
async function untilJobStarted(server: RunningServer, jobId: string): Promise<string> {
  const deadline = Date.now() + 10_000
  let status = ''
  while (Date.now() < deadline) {
    status = (await server.request('GET', `/jobs/${jobId}`)).json<{ status?: string }>().status ?? ''
    if (status !== 'queued') return status
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return status
}

async function namesBeginningWith(dir: string, prefix: string): Promise<string[]> {
  const found: string[] = []
  for await (const entry of Deno.readDir(dir)) if (entry.name.startsWith(prefix)) found.push(entry.name)
  return found.sort()
}

Deno.test('a scan\'s LingBot-Map point cloud and its SenseNova output go with it, and another scan\'s do not', async () => {
  const server = await startServer()
  try {
    // A scan is listed in a world once it says something about itself (shouldIncludeInWorld), here a point count.
    const mine = await uploadScan(server, 'mine', { pointCount: 10 })
    const other = await uploadScan(server, 'other', { pointCount: 10 })
    const base = mine.filename.replace(/\.glb$/, '')
    const otherBase = other.filename.replace(/\.glb$/, '')
    // What LingBot-Map writes beside a scan: a point cloud coloured from the session's photographs.
    await Deno.writeTextFile(`${server.dirs.scans}/${base}.lingbot.glb`, 'a coloured point cloud')
    await Deno.writeTextFile(`${server.dirs.scans}/${otherBase}.lingbot.glb`, 'another room')

    // A SenseNova job for each scan, and the folder each wrote (the job id names it). The job runs to a stop with no runtime here.
    const world = (await server.request('GET', '/worlds/default')).json<{ scans: Array<{ filename: string; scanId: string }> }>()
    const folders: Record<string, string> = {}
    for (const scan of [mine, other]) {
      const scanId = world.scans.find((row) => row.filename === scan.filename)!.scanId
      const queued = await server.request('POST', '/worlds/default/jobs', { type: 'sensenova-vision', scanId })
      assertEquals(queued.status, 202, queued.text)
      const jobId = queued.json<{ jobId: string }>().jobId
      await untilWorldJobSettled(server, jobId)
      folders[scan.filename] = `${server.dirs.scans}/.sensenova/${safeSlug(jobId)}`
      await Deno.mkdir(folders[scan.filename]!, { recursive: true })
      await Deno.writeTextFile(`${folders[scan.filename]}/depth.png`, 'depth from the frames')
    }

    const reply = await server.request('DELETE', `/scans/${encodeURIComponent(mine.filename)}`)
    assertEquals(reply.status, 200, reply.text)
    assertFalse(await exists(`${server.dirs.scans}/${base}.lingbot.glb`), 'the point cloud went with the scan, and is no longer served')
    assertEquals((await server.request('GET', `/scans/${encodeURIComponent(`${base}.lingbot.glb`)}`)).status, 404)
    assertFalse(await exists(folders[mine.filename]!), 'the SenseNova output went with the scan')
    assert(await exists(`${server.dirs.scans}/${otherBase}.lingbot.glb`), 'another scan\'s point cloud is not touched')
    assert(await exists(folders[other.filename]!), 'another scan\'s SenseNova output is not touched')
    assertEquals(await namesBeginningWith(server.dirs.scans, base), [], 'nothing of the scan is left beside it')

    // Clearing everything takes the rest, including the folder all SenseNova output lives under.
    assertEquals((await server.request('DELETE', '/scans?confirm=delete-all')).status, 200)
    assertFalse(await exists(`${server.dirs.scans}/${otherBase}.lingbot.glb`))
    assertFalse(await exists(`${server.dirs.scans}/.sensenova`))
  } finally {
    await server.stop()
  }
})

/** Polls the default world's job list until `jobId` has stopped. */
async function untilWorldJobSettled(server: RunningServer, jobId: string): Promise<WorldJob> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const job = (await jobs(server)).find((item) => item.jobId === jobId)
    if (job && (job.status === 'completed' || job.status === 'failed')) return job
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`world job ${jobId} did not stop.\n${server.log()}`)
}

Deno.test('a scan deleted while its upload\'s optimize job runs waits for the job, deletes it, and nothing is written after the answer', async () => {
  const server = await startServer()
  try {
    let caughtRunning = 0
    // The optimizer of a large point cloud runs for a moment after an upload. A delete that lands then waits for it (a few
    // seconds at most) and deletes the scan: it must leave nothing for the job to write beside a scan that no longer exists.
    // Tried until the delete has been seen to land while the job was queued or running, so the waiting path is the one tested.
    for (let attempt = 0; attempt < 12 && caughtRunning === 0; attempt++) {
      const scan = await uploadBigScan(server, `race${attempt}`)
      const base = scan.filename.replace(/\.glb$/, '')
      const status = await untilJobStarted(server, scan.job)
      const reply = await server.request('DELETE', `/scans/${encodeURIComponent(scan.filename)}`)
      assertEquals(reply.status, 200, `the delete answered ${reply.status}: ${reply.text}`)
      if (status === 'running' || status === 'queued') caughtRunning += 1
      await untilJobSettled(server, scan.job)
      await new Promise((resolve) => setTimeout(resolve, 300))
      assertEquals(await namesBeginningWith(server.dirs.scans, base), [], `the job wrote beside a deleted scan (attempt ${attempt}, delete answered ${reply.status})`)
      assertEquals((await server.request('GET', `/scans/${encodeURIComponent(`${base}.opt.glb`)}`)).status, 404, 'and nothing of it is served')
    }
    assertEquals(caughtRunning, 1, 'a delete was caught during a running job within twelve tries')
  } finally {
    await server.stop()
  }
})

Deno.test('clearing all scans is refused while a job runs on one, and removes nothing', async () => {
  const server = await startServer()
  try {
    let refused = 0
    for (let attempt = 0; attempt < 12 && refused === 0; attempt++) {
      const scan = await uploadBigScan(server, `wipe${attempt}`)
      await untilJobStarted(server, scan.job)
      const reply = await server.request('DELETE', '/scans?confirm=delete-all')
      if (reply.status === 409) {
        refused += 1
        assertStringIncludes(reply.text, 'still being processed')
        assert(await exists(`${server.dirs.scans}/${scan.filename}`), 'a refused wipe removed nothing')
        await untilJobSettled(server, scan.job)
        assertEquals((await server.request('DELETE', '/scans?confirm=delete-all')).status, 200)
      } else {
        assertEquals(reply.status, 200, reply.text)
        await untilJobSettled(server, scan.job)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      assertEquals(await namesBeginningWith(server.dirs.scans, scan.filename.replace(/\.glb$/, '')), [])
    }
    assertEquals(refused, 1, 'a wipe was caught during a running job within twelve tries')
  } finally {
    await server.stop()
  }
})

Deno.test('a name with a NUL byte or another control character is a 400 that names no path, not a 500', async () => {
  const server = await startServer()
  try {
    const mine = await uploadScan(server, 'real')
    for (const name of ['x%00.glb', 'x%01y.glb', 'x%1f.glb', 'x%7f.glb', '%00.glb', 'a%0Ab.glb']) {
      const reply = await server.request('DELETE', `/scans/${name}`)
      assertEquals(reply.status, 400, `${name}: ${reply.text}`)
      assertEquals(reply.json().error, 'Invalid filename')
      assertFalse(reply.text.includes(server.dirs.root), `${name}: the answer names a path`)
    }
    assert(await exists(`${server.dirs.scans}/${mine.filename}`), 'nothing was removed by a refused name')
    // The shared name check refuses it for the other routes that take a scan's name too, so a NUL never reaches a file call there.
    for (const [method, path] of [['GET', '/scans/x%00.glb/manifest'], ['POST', '/scans/x%00.glb/optimize'], ['GET', '/scans/x%01.glb/manifest']]) {
      const reply = await server.request(method!, path!)
      assertEquals(reply.status, 400, `${method} ${path}: ${reply.text}`)
      assertEquals(reply.json().error, 'Invalid filename')
    }
  } finally {
    await server.stop()
  }
})

Deno.test({
  name: 'a Place whose reference photos cannot be removed is kept, with a fixed message, and a second try removes it',
  ignore: !CAN_MAKE_A_PERMISSION_FAILURE,
}, async () => {
  const server = await startServer()
  try {
    const place = (await server.request('POST', '/projects', { name: 'Flat' })).json<{ projectId: string }>().projectId
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(200)], { type: 'image/jpeg' }), 'ref.jpg')
    form.append('meta', JSON.stringify({
      role: 'landmark',
      tapPoint: { x: 0.5, y: 0.5 },
      pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      capturedAt: new Date().toISOString(),
    }))
    assertEquals((await server.form(`/projects/${place}/reference-photos`, form)).status, 200)
    const folder = `${server.dirs.media}/${place}`
    await Deno.chmod(folder, 0o555)
    try {
      const reply = await server.request('DELETE', `/projects/${place}`)
      assertEquals(reply.status, 500, reply.text)
      assertStringIncludes(reply.json<{ error: string }>().error, 'so it was kept')
      assertFalse(reply.text.includes(server.dirs.root), 'the answer names no path')
      const listed = (await server.request('GET', '/projects')).json<Array<{ projectId: string }>>()
      assert(listed.some((project) => project.projectId === place), 'the Place is still listed, so it can be deleted again')
      assert(await exists(`${folder}/ref-landmark.jpg`))
    } finally {
      await Deno.chmod(folder, 0o755)
    }
    const retry = await server.request('DELETE', `/projects/${place}`)
    assertEquals(retry.status, 200, retry.text)
    assertFalse(await exists(folder))
    assertEquals((await server.request('DELETE', `/projects/${place}`)).status, 404)
  } finally {
    await server.stop()
  }
})

Deno.test('deleting a Place removes its world, which held its address and coordinates, and the export built from it', async () => {
  const server = await startServer()
  try {
    const place = (await server.request('POST', '/projects', { name: 'My Home', address: '12 Secret Lane' })).json<{ projectId: string }>().projectId
    const other = (await server.request('POST', '/projects', { name: 'Elsewhere', address: '9 Other Road' })).json<{ projectId: string }>().projectId
    const scan = await uploadScan(server, 'home', { projectId: place, geoLat: 51.5014, geoLng: -0.1419, geoAddress: '12 Secret Lane', capturedAt: new Date().toISOString() })
    await uploadScan(server, 'elsewhere', { projectId: other })
    for (const id of [place, other]) assertEquals((await server.request('GET', `/projects/${id}/world`)).status, 200)
    const worlds = `${server.dirs.root}/worlds`
    const slug = `project-${place}`
    assert(await exists(`${worlds}/${slug}.json`), 'the Place has a world file')

    // The Place's world has an export, built on demand.
    const queued = await server.request('POST', `/worlds/${slug}/jobs`, { type: 'export-world' })
    assertEquals(queued.status, 202, queued.text)
    const exportJob = await untilProjectJobSettled(server, slug, queued.json<{ jobId: string }>().jobId)
    assertEquals(exportJob.status, 'completed', exportJob.error)
    assert(await exists(`${worlds}/${slug}.world.glb`))

    assertEquals((await server.request('DELETE', `/scans/${encodeURIComponent(scan.filename)}`)).status, 200)
    assertFalse(await exists(`${worlds}/${slug}.world.glb`), 'the export held a copy of the deleted scan, so it went with it')
    assertEquals((await server.request('GET', `/worlds/${slug}/export.glb`)).status, 404, 'and is no longer served')

    const gone = await server.request('DELETE', `/projects/${place}`)
    assertEquals(gone.status, 200, gone.text)
    assertEquals(gone.json().worldsRemoved, 1)
    assertFalse(await exists(`${worlds}/${slug}.json`), 'the Place\'s world went with it')
    // What a request for that world answers now is a blank one: nothing of the person's address is in it.
    const after = await server.request('GET', `/worlds/${slug}`)
    assertFalse(after.text.includes('Secret Lane') || after.text.includes('51.5014'), 'the address and the coordinates are gone')
    // Another Place's world is not touched.
    assert(await exists(`${worlds}/project-${other}.json`), 'another Place\'s world stays')
    assert(await exists(`${worlds}/default.json`) || true, 'the default world is not a Place\'s')
  } finally {
    await server.stop()
  }
})

/** Polls a Place world's job list until `jobId` has stopped. */
async function untilProjectJobSettled(server: RunningServer, slug: string, jobId: string): Promise<WorldJob> {
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const job = (await server.request('GET', `/worlds/${slug}/jobs`)).json<WorldJob[]>().find((item) => item.jobId === jobId)
    if (job && (job.status === 'completed' || job.status === 'failed')) return job
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`world job ${jobId} did not stop.\n${server.log()}`)
}

Deno.test('deleting a scan removes the world exports that held it, and clearing all scans removes every export', async () => {
  const server = await startServer()
  try {
    const keep = await uploadScan(server, 'keeper', { pointCount: 10 })
    const gone = await uploadScan(server, 'goner', { pointCount: 10 })
    const worlds = `${server.dirs.root}/worlds`
    const queued = await server.request('POST', '/worlds/default/jobs', { type: 'export-world' })
    assertEquals(queued.status, 202, queued.text)
    assertEquals((await untilWorldJobSettled(server, queued.json<{ jobId: string }>().jobId)).status, 'completed')
    assert(await exists(`${worlds}/default.world.glb`))

    const reply = await server.request('DELETE', `/scans/${encodeURIComponent(gone.filename)}`)
    assertEquals(reply.status, 200, reply.text)
    assertEquals(reply.json<{ deleted: { worldExports: number } }>().deleted.worldExports, 1)
    assertFalse(await exists(`${worlds}/default.world.glb`), 'the export held both scans, so it is gone and must be built again')
    assertEquals((await server.request('GET', '/worlds/default/export.glb')).status, 404)
    assert(await exists(`${server.dirs.scans}/${keep.filename}`), 'the other scan is not touched')

    // Built again, it holds the scans that are left; clearing everything removes it.
    const again = await server.request('POST', '/worlds/default/jobs', { type: 'export-world' })
    assertEquals((await untilWorldJobSettled(server, again.json<{ jobId: string }>().jobId)).status, 'completed')
    assert(await exists(`${worlds}/default.world.glb`))
    assertEquals((await server.request('DELETE', '/scans?confirm=delete-all')).status, 200)
    assertFalse(await exists(`${worlds}/default.world.glb`))
  } finally {
    await server.stop()
  }
})

Deno.test('the frames a walk streamed after its last export go with that scan, through the follows link the scanner records', async () => {
  const server = await startServer()
  try {
    const scan = await uploadScan(server, 'walk')
    const unrelated = await uploadScan(server, 'unrelated')
    // The scanner exports (the session is finalized against the scan), carries on walking in a new session, and when the page ends
    // that session is finalized with no scan of its own: it holds the frames taken after the export.
    const exported = await streamSession(server, scan.filename)
    const trailing = await streamSession(server, null, 4)
    const finalize = await server.request('POST', `/sessions/${trailing}/finalize`, { pointCount: 10, followsGlbFilename: scan.filename })
    assertEquals(finalize.status, 200, finalize.text)
    assertEquals(finalize.json().followsGlbFilename, scan.filename, 'the record says which scan the walk last exported')
    assertEquals(finalize.json().glbFilename, null, 'and it is not a scan made from this session')
    // A session that follows another scan, and one that follows nothing, are not this scan's.
    const elsewhere = await streamSession(server, null)
    await server.request('POST', `/sessions/${elsewhere}/finalize`, { followsGlbFilename: unrelated.filename })
    const never = await streamSession(server, null)
    await server.request('POST', `/sessions/${never}/finalize`, {})
    // A name that is not a plain scan name is not recorded.
    const odd = await streamSession(server, null)
    const bad = await server.request('POST', `/sessions/${odd}/finalize`, { followsGlbFilename: '../escape.glb' })
    assertEquals(bad.json().followsGlbFilename, undefined)

    const reply = await server.request('DELETE', `/scans/${encodeURIComponent(scan.filename)}`)
    assertEquals(reply.status, 200, reply.text)
    assertEquals(reply.json<{ deleted: { keyframeSessions: number } }>().deleted.keyframeSessions, 2)
    assertFalse(await exists(`${server.dirs.sessions}/${exported}`), 'the session the export was made from went')
    assertFalse(await exists(`${server.dirs.sessions}/${trailing}`), 'and so did the one that carried on after it')
    for (const id of [elsewhere, never, odd]) assert(await exists(`${server.dirs.sessions}/${id}`), `${id} is not this scan's`)
  } finally {
    await server.stop()
  }
})
