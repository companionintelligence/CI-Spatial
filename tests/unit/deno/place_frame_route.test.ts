/**
 * The Place's frame over HTTP: PUT /projects/:id/spatial-frame, and what the whole-record PUT
 * /projects/:id does with the frame (server/wp-a-projects.ts, hooked in server/main.ts).
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so a route cannot be called from a
 * test in-process (tests/unit/deno/export_route_guard.test.ts says the same). Each test here spawns the
 * real server/main.ts on a free port, with every directory it writes in a temp folder, and talks to it
 * over HTTP. That is the route as wired: the middleware, the guard, the handler, the serialised
 * mutation queue and the temp-file-and-rename save, together.
 *
 * What is pinned:
 *  - the heart of it: calibrate, "Add an area", the editor's hierarchy save and a stale tab's
 *    whole-record PUT, in every order and also all at once, never lose or regress the frame (0 lost in N,
 *    N printed);
 *  - what a client built before this change does against this server (whole-record PUTs only);
 *  - the route's answers: 200, 409 with the frame held, 400 for everything the validator refuses, 404, 413;
 *  - persistence: the registry on disk is whole after a burst of writes, and a restart still holds the frame;
 *  - the guard: the route answers each credential exactly as the whole-record PUT does, in every mode.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { signSession } from '../../../server/portal_auth.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

const SESSION_SECRET = 'place-frame-route-test-secret'
const OWNER_EMAIL = 'owner@example.com'
/** Sign-in on, with an issuer on a port Deno blocks, so discovery fails at once and nothing leaves the machine. */
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
}

interface Credential {
  /** A world member token, sent in the query as the editor's share links do. */
  token?: string
  /** A Companion session, sent as a Bearer token as the app does. */
  bearer?: string
}

interface RunningServer {
  root: string
  registryFile: string
  worldsDir: string
  /** One request with a JSON body (or `raw` text), as `who` if a credential is given. */
  send(method: string, path: string, body?: unknown, who?: Credential, raw?: string): Promise<Reply>
  /** The registry file as it is on disk right now, not as the server answers. */
  registry(): Promise<Project[]>
  log(): string
  /** Stops the server and removes its folder, or keeps the folder for a restart on it. */
  stop(keepRoot?: boolean): Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

/**
 * Spawns server/main.ts with `env` on top of a bare environment and resolves once it says where it
 * listens. `seed` is written as the registry first, which is how a test starts from a Place that already
 * has a frame, or from one saved by a build that wrote no revision. `root` reuses a folder, for a restart.
 */
async function startServer(env: Record<string, string>, options: { seed?: unknown[]; root?: string } = {}): Promise<RunningServer> {
  const root = options.root ?? await Deno.makeTempDir({ prefix: 'place-frame-route-' })
  const registryFile = `${root}/projects.json`
  if (options.seed) await Deno.writeTextFile(registryFile, JSON.stringify(options.seed, null, 2))
  const worldsDir = `${root}/worlds`
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(Deno.env.toObject())) {
    if (INHERITED_ENV.test(name)) inherited[name] = value
  }
  let child: Deno.ChildProcess | null = null
  let output = ''
  const pumps: Promise<void>[] = []
  const stop = async (keepRoot = false): Promise<void> => {
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch { /* already gone */ }
      await child.status
      await Promise.all(pumps)
      child = null
    }
    if (!keepRoot) await Deno.remove(root, { recursive: true }).catch(() => undefined)
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
        WORLDS_DIR: worldsDir,
        SUMMARIES_DIR: `${root}/summaries`,
        PROJECTS_FILE: registryFile,
        STATIC_DIR: `${root}/no-static-bundle`,
        INFERENCE_MODE: 'mock',
        TAILSCALE_HOSTNAME: 'scan.test',
        ...env,
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
      registryFile,
      worldsDir,
      send: async (method, path, body, who = {}, raw) => {
        const url = `${base}${path}${who.token ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(who.token)}` : ''}`
        const headers: Record<string, string> = {}
        const hasBody = body !== undefined || raw !== undefined
        if (hasBody) headers['Content-Type'] = 'application/json'
        if (who.bearer) headers['Authorization'] = `Bearer ${who.bearer}`
        const controller = new AbortController()
        const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await fetch(url, {
            method,
            headers,
            body: hasBody ? (raw ?? JSON.stringify(body)) : undefined,
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
      registry: async () => JSON.parse(await Deno.readTextFile(registryFile)) as Project[],
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

function frame(createdAt: string, separationM = 2.5): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    pointLabels: ['north door frame', 'radiator corner'],
  }
}

const F0 = frame('2026-11-16T08:00:00.000Z', 2)
const F1 = frame('2026-11-16T09:00:00.000Z', 3)
const F2 = frame('2026-11-16T10:00:00.000Z', 4)

const FLOORS = [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }]

/** A Place as a build from before this change saved it: a whole record and no revision key. */
function legacyPlace(projectId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId,
    name: `Place ${projectId}`,
    placeType: 'room',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    areas: [{ areaId: 'area-site', name: `Place ${projectId}`, kind: 'site', parentAreaId: null }],
    floors: FLOORS,
    ...extra,
  }
}

async function createPlace(server: RunningServer, who?: Credential): Promise<Project> {
  // Ids are `proj-<epoch ms>`, so two creates in one millisecond would be one Place.
  await new Promise((resolve) => setTimeout(resolve, 3))
  const made = await server.send('POST', '/projects', { name: 'Frame test place', placeType: 'room' }, who)
  assertEquals(made.status, 201, `POST /projects: ${made.text}`)
  return made.json as Project
}

async function getPlace(server: RunningServer, projectId: string, who?: Credential): Promise<Project> {
  const res = await server.send('GET', `/projects/${projectId}`, undefined, who)
  assertEquals(res.status, 200, `GET /projects/${projectId}: ${res.text}`)
  return res.json as Project
}

const putFrame = (server: RunningServer, projectId: string, body: unknown, who?: Credential) =>
  server.send('PUT', `/projects/${projectId}/spatial-frame`, body, who)
const putPlace = (server: RunningServer, projectId: string, body: unknown, who?: Credential) =>
  server.send('PUT', `/projects/${projectId}`, body, who)

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))
}

// ── The heart: no order of writers loses the frame ───────────────────────────────────────────────

type Writer = 'calibrate' | 'addArea' | 'hierarchy' | 'staleTab'
const WRITERS: Writer[] = ['calibrate', 'addArea', 'hierarchy', 'staleTab']

Deno.test('calibrate, add-area, hierarchy-save and a stale tab leave the frame intact in every order, one after another and all at once', async () => {
  const server = await startServer({})
  let scenarios = 0
  const lost: string[] = []
  try {
    for (const start of ['never calibrated', 'already calibrated'] as const) {
      for (const how of ['one after another', 'all at once'] as const) {
        for (const order of permutations(WRITERS)) {
          scenarios += 1
          const label = `${start}, ${how}, ${order.join(' > ')}`

          const place = await createPlace(server)
          let held = 0
          if (start === 'already calibrated') {
            const first = await putFrame(server, place.projectId, { frame: F0, expectedRevision: 0 })
            assertEquals(first.status, 200, `${label}: the first calibration: ${first.text}`)
            held = 1
          }
          // Every whole-record writer holds the copy read before the calibration under test: that is what a stale tab is.
          const snapshot = await getPlace(server, place.projectId)

          const writes: Record<Writer, () => Promise<Reply>> = {
            // The phone's calibration commit, naming the revision it read.
            calibrate: () => putFrame(server, place.projectId, { frame: F1, expectedRevision: held }),
            // "Add an area": the whole record the picker last read, plus an area.
            addArea: () => putPlace(server, place.projectId, {
              ...snapshot,
              areas: [...(snapshot.areas ?? []), { areaId: 'area-new', name: 'Pantry', kind: 'room', parentAreaId: null }],
            }),
            // The editor's hierarchy save: the whole record, renamed and relinked.
            hierarchy: () => putPlace(server, place.projectId, {
              ...snapshot,
              name: 'Renamed',
              placeType: 'room',
              buildingName: 'Block A',
              roomName: 'Renamed',
            }),
            // A tab or a replayed service-worker body that still has the old copy, sent as it is.
            staleTab: () => putPlace(server, place.projectId, snapshot),
          }

          const replies: Array<[Writer, Reply]> = []
          if (how === 'one after another') {
            for (const writer of order) replies.push([writer, await writes[writer]()])
          } else {
            const all = await Promise.all(order.map(async (writer) => [writer, await writes[writer]()] as [Writer, Reply]))
            replies.push(...all)
          }

          for (const [writer, reply] of replies) {
            assertEquals(reply.status, 200, `${label}: ${writer} was refused: ${reply.text}`)
          }
          const after = await getPlace(server, place.projectId)
          const intact = JSON.stringify(after.spatialFrame) === JSON.stringify(F1) && after.spatialFrameRevision === held + 1
          if (!intact) lost.push(`${label}: holds revision ${after.spatialFrameRevision} and ${after.spatialFrame?.createdAt ?? 'no frame'}`)

          // The same on disk, which is what survives a restart.
          const onDisk = (await server.registry()).find((candidate) => candidate.projectId === place.projectId)
          assertEquals(onDisk?.spatialFrame, F1, `${label}: the file holds the frame`)
        }
      }
    }
    console.log(`  frames lost: ${lost.length} of ${scenarios} interleavings`)
    assertEquals(lost, [], `${lost.length} of ${scenarios} interleavings lost or regressed the frame:\n${lost.join('\n')}`)
    assertEquals(scenarios, 96, '2 starting states x 2 ways x 24 orders')
  } finally {
    await server.stop()
  }
})

Deno.test('a client built before this change and a current one, calibrating a Place at the same moment, leave exactly one frame, and each can tell which', async () => {
  const server = await startServer({})
  let scenarios = 0
  try {
    for (const how of ['old first', 'new first', 'at once'] as const) {
      scenarios += 1
      const place = await createPlace(server)
      const snapshot = await getPlace(server, place.projectId)
      // The old client's calibration commit: the whole Place with its new frame in it, and no revision.
      const old = () => putPlace(server, place.projectId, { ...snapshot, spatialFrame: F2 })
      // The current client's: the route, naming the revision it read.
      const current = () => putFrame(server, place.projectId, { frame: F1, expectedRevision: 0 })

      let oldReply: Reply
      let newReply: Reply
      if (how === 'old first') {
        oldReply = await old()
        newReply = await current()
      } else if (how === 'new first') {
        newReply = await current()
        oldReply = await old()
      } else {
        ;[oldReply, newReply] = await Promise.all([old(), current()])
      }

      const after = await getPlace(server, place.projectId)
      assertEquals(after.spatialFrameRevision, 1, `${how}: one frame was counted`)
      assert(
        JSON.stringify(after.spatialFrame) === JSON.stringify(F1) || JSON.stringify(after.spatialFrame) === JSON.stringify(F2),
        `${how}: the frame held is one of the two, whole`,
      )
      assertEquals(oldReply.status, 200, `${how}: the old client is answered, as before`)
      const oldWon = JSON.stringify(after.spatialFrame) === JSON.stringify(F2)
      // The old client's reply is the Place as stored, so a client that looks can see whose frame it holds.
      assertEquals((oldReply.json as Project).spatialFrame, after.spatialFrame, `${how}: the old reply carries the stored frame`)
      if (oldWon) {
        assertEquals(newReply.status, 409, `${how}: the current client lost, and is told`)
        assertEquals((newReply.json as { current: { frame: unknown } }).current.frame, F2)
      } else {
        assertEquals(newReply.status, 200, `${how}: the current client won`)
      }
    }
    assertEquals(scenarios, 3)
  } finally {
    await server.stop()
  }
})

// ── What a client built before this change does against this server ──────────────────────────────

Deno.test('a client built before this change: its whole-record PUTs keep the frame, and only a first calibration can add one', async () => {
  const server = await startServer({}, {
    seed: [
      legacyPlace('proj-bare'),
      legacyPlace('proj-held', { spatialFrame: F0 }),
      // A frame of the retired three-point method, which the validator would not accept today.
      legacyPlace('proj-retired', { spatialFrame: { version: 1, method: 'raycast-reference-triangle', toleranceM: 0.3, createdAt: '2026-07-01T00:00:00.000Z' } }),
    ],
  })
  try {
    // A Place saved before this change reads as revision 0, whether it holds a frame or not.
    for (const id of ['proj-bare', 'proj-held', 'proj-retired']) {
      assertEquals((await getPlace(server, id)).spatialFrameRevision, undefined, `${id}: no key on disk, so none in the reply`)
    }

    // 1. Its first calibration: the whole record with the new frame in it, as persistProjectSpatialFrame sent it.
    const bare = await getPlace(server, 'proj-bare')
    const firstCalibration = await putPlace(server, 'proj-bare', { ...bare, spatialFrame: F1 })
    assertEquals(firstCalibration.status, 200, firstCalibration.text)
    assertEquals((firstCalibration.json as Project).spatialFrame, F1, 'the frame is stored (create-if-absent)')
    assertEquals((firstCalibration.json as Project).spatialFrameRevision, 1, 'and counted')

    // 2. An edit from a copy read before that calibration: no frame in it. The frame stays.
    const rename = await putPlace(server, 'proj-bare', { ...bare, name: 'Renamed from a stale copy' })
    assertEquals(rename.status, 200)
    assertEquals((rename.json as Project).name, 'Renamed from a stale copy', 'the rest of the record is still replaced')
    assertEquals((rename.json as Project).spatialFrame, F1, 'the frame is not')
    assertEquals((rename.json as Project).spatialFrameRevision, 1)

    // 3. "Use anyway" from such a client: a different frame, sent the old way. It does not replace the stored one.
    const override = await putPlace(server, 'proj-bare', { ...bare, spatialFrame: F2 })
    assertEquals(override.status, 200, 'the old client is answered as it always was')
    assertEquals((override.json as Project).spatialFrame, F1, 'but the frame it sent is not the one kept')
    assertEquals((override.json as Project).spatialFrameRevision, 1)

    // 4. A copy with an older frame, sent back whole by a stale tab: the newer frame is not regressed.
    await putFrame(server, 'proj-bare', { frame: F2, expectedRevision: 1 })
    const regress = await putPlace(server, 'proj-bare', { ...bare, spatialFrame: F1, spatialFrameRevision: 1 })
    assertEquals((regress.json as Project).spatialFrame, F2)
    assertEquals((regress.json as Project).spatialFrameRevision, 2, 'and a revision in the body is not believed')

    // 5. A body that claims a revision never raises or lowers what the server counts.
    const claim = await putPlace(server, 'proj-held', { ...(await getPlace(server, 'proj-held')), spatialFrameRevision: 40 })
    assertEquals((claim.json as Project).spatialFrameRevision, undefined, 'a Place that was never written through the route stays at 0')

    // 6. A Place that holds a legacy frame stays editable when the client sends that frame back, which every
    //    client that edits it does. The validator would refuse the frame; the Place never asked for it.
    const retired = await getPlace(server, 'proj-retired')
    const edit = await putPlace(server, 'proj-retired', { ...retired, name: 'Renamed' })
    assertEquals(edit.status, 200, edit.text)
    assertEquals((edit.json as Project).spatialFrame, retired.spatialFrame, 'the legacy frame is kept as it was')

    // 7. And the route is how a legacy frame is replaced, at the revision a Place from before this change reads as.
    const repair = await putFrame(server, 'proj-retired', { frame: F1, expectedRevision: 0 })
    assertEquals(repair.status, 200, repair.text)
    assertEquals((repair.json as { revision: number }).revision, 1)
  } finally {
    await server.stop()
  }
})

Deno.test('a whole-record body whose frame cannot be stored is refused when the Place would have used it, and nothing in it is stored', async () => {
  const server = await startServer({}, { seed: [legacyPlace('proj-bare'), legacyPlace('proj-held', { spatialFrame: F0 })] })
  try {
    const garbage = [
      ['the value the old test pinned', { origin: [0, 0, 0] }],
      ['a frame of an unknown method', { ...F1, method: 'three-point' }],
      ['a frame that is not finite', { ...F1, separationM: 1e999 }],
    ] as const
    for (const [what, spatialFrame] of garbage) {
      const bare = await getPlace(server, 'proj-bare')
      const refused = await putPlace(server, 'proj-bare', { ...bare, name: 'Never stored', spatialFrame })
      assertEquals(refused.status, 400, `${what}: ${refused.text}`)
      const after = await getPlace(server, 'proj-bare')
      assertEquals(after.name, 'Place proj-bare', `${what}: not even the name was stored`)
      assertEquals('spatialFrame' in after, false, what)
    }
    // A string is refused whatever the Place holds, as any other malformed field is.
    for (const id of ['proj-bare', 'proj-held']) {
      const refused = await putPlace(server, id, { ...(await getPlace(server, id)), spatialFrame: 'banana' })
      assertEquals(refused.status, 400, id)
      assertEquals((refused.json as { error: string }).error, 'spatialFrame must be an object')
    }
    // An object that is not a frame is ignored when the Place already has one.
    const held = await getPlace(server, 'proj-held')
    const ignored = await putPlace(server, 'proj-held', { ...held, name: 'Kept', spatialFrame: { origin: [0, 0, 0] } })
    assertEquals(ignored.status, 200)
    assertEquals((ignored.json as Project).spatialFrame, F0)
  } finally {
    await server.stop()
  }
})

// ── The route ────────────────────────────────────────────────────────────────────────────────────

Deno.test('PUT /projects/:id/spatial-frame: 200 with the revision, 409 with the frame held, and the same frame again is not a conflict', async () => {
  const server = await startServer({})
  try {
    const place = await createPlace(server)
    const id = place.projectId
    assertEquals(place.spatialFrameRevision, undefined, 'a new Place has counted nothing')

    const first = await putFrame(server, id, { frame: F0, expectedRevision: 0 })
    assertEquals(first.status, 200, first.text)
    assertEquals(first.json, { revision: 1, frame: F0 })

    const second = await putFrame(server, id, { frame: F1, expectedRevision: 1 })
    assertEquals(second.json, { revision: 2, frame: F1 })

    // Another device that read the Place at revision 1 and calibrated: it is told what it lost to.
    const stale = await putFrame(server, id, { frame: F2, expectedRevision: 1 })
    assertEquals(stale.status, 409)
    assertEquals((stale.json as { current: unknown }).current, { frame: F1, revision: 2 })
    assertEquals((await getPlace(server, id)).spatialFrame, F1, 'and the Place is as it was')

    // A replay of a write the server already applied (the service worker's queue, a retry after a lost reply).
    const replay = await putFrame(server, id, { frame: F1, expectedRevision: 1 })
    assertEquals(replay.status, 200)
    assertEquals(replay.json, { revision: 2, frame: F1, unchanged: true })

    const list = (await server.send('GET', '/projects')).json as Project[]
    const listed = list.find((candidate) => candidate.projectId === id)
    assertEquals(listed?.spatialFrameRevision, 2, 'the list carries the revision every client reads')
    assertEquals(listed?.spatialFrame, F1)
  } finally {
    await server.stop()
  }
})

Deno.test('PUT /projects/:id/spatial-frame refuses a body it could not safely store, and stores nothing', async () => {
  const server = await startServer({})
  try {
    const place = await createPlace(server)
    const id = place.projectId
    const refusals: Array<[string, Reply, number]> = [
      ['no body at all', await server.send('PUT', `/projects/${id}/spatial-frame`), 400],
      ['text that is not JSON', await server.send('PUT', `/projects/${id}/spatial-frame`, undefined, {}, '{nope'), 400],
      ['JSON null', await server.send('PUT', `/projects/${id}/spatial-frame`, undefined, {}, 'null'), 400],
      ['an array', await putFrame(server, id, [F0]), 400],
      ['no revision', await putFrame(server, id, { frame: F0 }), 400],
      ['a revision as text', await putFrame(server, id, { frame: F0, expectedRevision: '0' }), 400],
      ['a negative revision', await putFrame(server, id, { frame: F0, expectedRevision: -1 }), 400],
      ['a frame that is text', await putFrame(server, id, { frame: 'banana', expectedRevision: 0 }), 400],
      ['a frame that is an array', await putFrame(server, id, { frame: [F0], expectedRevision: 0 }), 400],
      ['a frame that is the old pinned value', await putFrame(server, id, { frame: { origin: [0, 0, 0] }, expectedRevision: 0 }), 400],
      ['an unknown method', await putFrame(server, id, { frame: { ...F0, method: 'three-point' }, expectedRevision: 0 }), 400],
      ['a separation below the minimum', await putFrame(server, id, { frame: { ...F0, separationM: 0.5, headingMarker: { x: 0, y: 0, z: 0.5 } }, expectedRevision: 0 }), 400],
      ['a tolerance that is not positive', await putFrame(server, id, { frame: { ...F0, toleranceM: 0 }, expectedRevision: 0 }), 400],
      ['a photo URL that leaves the Place', await putFrame(server, id, { frame: { ...F0, referencePhotos: photos('/projects/proj-other/reference-photos/ref-landmark.jpg') }, expectedRevision: 0 }), 400],
      ['a photo URL that is absolute', await putFrame(server, id, { frame: { ...F0, referencePhotos: photos('https://evil.example/ref-landmark.jpg') }, expectedRevision: 0 }), 400],
      ['a photo URL that is oversize', await putFrame(server, id, { frame: { ...F0, referencePhotos: photos(`/projects/${id}/reference-photos/${'a'.repeat(5000)}`) }, expectedRevision: 0 }), 400],
      ['a __proto__ key', await server.send('PUT', `/projects/${id}/spatial-frame`, undefined, {}, `{"expectedRevision":0,"frame":${JSON.stringify(F0).slice(0, -1)},"__proto__":{"polluted":true}}}`), 400],
      ['a constructor key inside a photo', await server.send('PUT', `/projects/${id}/spatial-frame`, undefined, {}, `{"expectedRevision":0,"frame":${JSON.stringify({ ...F0, referencePhotos: { landmark: JSON.parse('{"constructor":{"x":1}}'), headingMarker: null } })}}`), 400],
    ]
    for (const [what, reply, status] of refusals) {
      assertEquals(reply.status, status, `${what}: ${reply.text}`)
    }
    // What is wrong is said, and told apart: a body that is not JSON at all, one that is JSON but not a write.
    const said = (reply: Reply) => (reply.json as { error?: string } | null)?.error
    assertEquals(said(refusals[1]![1]), 'Invalid JSON', 'text that is not JSON')
    assertEquals(said(refusals[2]![1]), 'Invalid JSON', 'JSON null')
    assertEquals(said(refusals[3]![1]), 'Body must be a JSON object', 'an array')
    assertEquals(said(refusals[4]![1]), 'expectedRevision must be a whole number, 0 or more', 'no revision')
    assertEquals((await getPlace(server, id)).spatialFrame, undefined, 'nothing was stored')
    assertEquals((await server.registry()).find((candidate) => candidate.projectId === id)?.spatialFrame, undefined, 'nor written')

    const missing = await putFrame(server, 'proj-0000000000', { frame: F0, expectedRevision: 0 })
    assertEquals(missing.status, 404, missing.text)

    // The same cap as the whole-record PUT: a Place body over 1,000,000 bytes is refused before it is read.
    const huge = await putFrame(server, id, { frame: { ...F0, notes: 'x'.repeat(10) }, expectedRevision: 0, padding: 'p'.repeat(1_100_000) })
    assertEquals(huge.status, 413, huge.text)
    assertEquals((await getPlace(server, id)).spatialFrame, undefined)
  } finally {
    await server.stop()
  }
})

function photos(url: string) {
  const photo = (u: string | null) => ({
    url: u,
    localKey: 'proj-x:landmark',
    tapPoint: { x: 0.4, y: 0.6 },
    pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    capturedAt: '2026-11-16T09:00:00.000Z',
  })
  return { landmark: photo(url), headingMarker: photo(null) }
}

Deno.test('the frame and its revision are on disk after a burst of writes, the registry is whole, and a restart still holds them', async () => {
  const server = await startServer({})
  const root = server.root
  let projectId = ''
  try {
    const place = await createPlace(server)
    projectId = place.projectId
    // Twenty calibrations queued one behind another: each names the revision the one before it made, which is the
    // order the serialised queue has to keep for any of them to be accepted.
    let revision = 0
    for (let i = 0; i < 20; i++) {
      const reply = await putFrame(server, projectId, { frame: frame(`2026-11-16T09:${String(i).padStart(2, '0')}:00.000Z`, 2 + i / 10), expectedRevision: revision })
      assertEquals(reply.status, 200, `write ${i}: ${reply.text}`)
      revision = (reply.json as { revision: number }).revision
    }
    assertEquals(revision, 20)
    // And a burst at once: with one revision to name, exactly one of them is accepted and the rest are told.
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => putFrame(server, projectId, { frame: frame(`2026-11-16T10:0${i}:00.000Z`), expectedRevision: 20 })))
    assertEquals(burst.filter((reply) => reply.status === 200).length, 1, 'one winner')
    assertEquals(burst.filter((reply) => reply.status === 409).length, 7, 'and the others are told')

    const names = [...Deno.readDirSync(root)].map((entry) => entry.name)
    assert(!names.some((name) => name.endsWith('.tmp')), `no temp file is left behind: ${names.join(', ')}`)
    assert(names.includes('projects.json.bak'), 'the save before the last one is kept as the .bak')
    const onDisk = (await server.registry()).find((candidate) => candidate.projectId === projectId)
    assertEquals(onDisk?.spatialFrameRevision, 21)
    assert(onDisk?.spatialFrame?.createdAt.startsWith('2026-11-16T10:0'), 'the winner of the burst is what is held')
    const held = onDisk?.spatialFrame

    await server.stop(true)
    const restarted = await startServer({}, { root })
    try {
      const again = await getPlace(restarted, projectId)
      assertEquals(again.spatialFrame, held, 'a restart reads what was written')
      assertEquals(again.spatialFrameRevision, 21)
    } finally {
      await restarted.stop()
    }
  } finally {
    await server.stop()
  }
})

// ── The guard ────────────────────────────────────────────────────────────────────────────────────

interface GuardMode {
  name: string
  env: Record<string, string>
  /** The status a credential gets from a route behind the Companion session guard. */
  status: (who: string) => number
  sessions: boolean
}

const GUARD_MODES: GuardMode[] = [
  {
    name: 'sign-in on',
    env: SIGN_IN_ON,
    sessions: true,
    status: (who) => (who === 'an allowlisted session' ? 200 : 401),
  },
  {
    name: 'SCAN_REQUIRE_AUTH=1, sign-in off',
    env: { SCAN_REQUIRE_AUTH: '1' },
    sessions: false,
    status: () => 401,
  },
  {
    name: 'an install open by design',
    env: {},
    sessions: false,
    status: () => 200,
  },
]

for (const mode of GUARD_MODES) {
  Deno.test(`the frame route is behind the guard the whole-record PUT is behind, ${mode.name}`, async () => {
    const server = await startServer(mode.env, { seed: [legacyPlace('proj-guarded', { spatialFrame: F0, spatialFrameRevision: 1 })] })
    try {
      // The world tokens are the roles of the share links: a viewer and an editor of the Place's world. Reading a
      // world is open on every install and makes the server write the world file, so the tokens come from there.
      const read = await server.send('GET', '/worlds/default')
      assertEquals(read.status, 200, `GET /worlds/default should create the world: ${read.text}`)
      const world = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/default.json`)) as { members: Array<{ role: string; token: string }> }
      const tokens = Object.fromEntries(world.members.map((member) => [member.role, member.token]))
      const expiry = Math.floor(Date.now() / 1000) + 3600

      const credentials: Array<[string, Credential]> = [
        ['anonymous', {}],
        ['a viewer token', { token: tokens['viewer'] }],
        ['an editor token', { token: tokens['editor'] }],
        ['an owner token in a header', { bearer: tokens['owner'] }],
        ['a token that is not any world\'s', { token: 'not-a-token-of-any-world' }],
      ]
      if (mode.sessions) {
        credentials.push(
          ['a session for an account off the allowlist', { bearer: await signSession({ sub: 'user-2', email: 'someone-else@example.com', exp: expiry }, SESSION_SECRET) }],
          ['an allowlisted session', { bearer: await signSession({ sub: 'user-1', email: OWNER_EMAIL, exp: expiry }, SESSION_SECRET) }],
        )
      }
      // Refusals first, so every one of them is measured against the same stored frame; the credentials that
      // are let in come last and each one moves the revision on.
      credentials.sort(([a], [b]) => Number(mode.status(a) === 200) - Number(mode.status(b) === 200))

      const why = (what: string) => `${mode.name}: ${what}. Server log:\n${server.log()}`
      const place = async () => (await server.registry()).find((candidate) => candidate.projectId === 'proj-guarded')!
      let attempt = 0
      for (const [who, credential] of credentials) {
        attempt += 1
        const before = await place()
        const record = { ...before, name: `Guard probe ${attempt}` }
        const sibling = await putPlace(server, 'proj-guarded', record, credential)
        const route = await putFrame(server, 'proj-guarded', {
          frame: frame(`2026-11-17T09:${String(attempt).padStart(2, '0')}:00.000Z`),
          expectedRevision: (await place()).spatialFrameRevision,
        }, credential)

        const expected = mode.status(who)
        assertEquals(sibling.status, expected, why(`${who}: the whole-record PUT`))
        assertEquals(route.status, sibling.status, why(`${who}: the frame route answers as the whole-record PUT does`))
        if (expected === 401) {
          const after = await place()
          assertEquals(after.spatialFrame, F0, why(`${who}: the refused call changed the frame`))
          assertEquals(after.spatialFrameRevision, 1, why(`${who}: or its revision`))
          assertEquals(after.name, before.name, why(`${who}: or the Place`))
        } else {
          assertEquals((route.json as { revision: number }).revision, (await place()).spatialFrameRevision, why(`${who}: the write is the one on disk`))
        }
      }
    } finally {
      await server.stop()
    }
  })
}

Deno.test('a stranger cannot reach the route through a path that merely looks like it', async () => {
  const server = await startServer(SIGN_IN_ON, { seed: [legacyPlace('proj-guarded', { spatialFrame: F0, spatialFrameRevision: 1 })] })
  try {
    const anonymous = [
      await server.send('PUT', '/projects/proj-guarded/spatial-frame/', { frame: F1, expectedRevision: 1 }),
      await server.send('PUT', '/projects/proj-guarded/spatial-frame?token=x', { frame: F1, expectedRevision: 1 }),
      await server.send('PUT', '/projects//spatial-frame', { frame: F1, expectedRevision: 1 }),
      await server.send('PUT', '/projects/proj-guarded%2Fspatial-frame', { frame: F1, expectedRevision: 1 }),
    ]
    for (const reply of anonymous) assertNotEquals(reply.status, 200, reply.text)
    assertEquals((await server.registry())[0]?.spatialFrame, F0)
  } finally {
    await server.stop()
  }
})
