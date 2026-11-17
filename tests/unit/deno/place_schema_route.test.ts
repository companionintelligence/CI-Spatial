/**
 * place_schema_route.test.ts — the S0 schema over HTTP, against the real server.
 * Run: deno task test (needs run, net, read, write, env), or
 *      deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi tests/unit/deno/place_schema_route.test.ts
 *
 * What the pure functions in tests/unit/deno/frame_schema_s0.test.ts claim, held to the route that uses them:
 *
 *  - a frame with a `frameId` and check points, photos included, goes through `PUT /projects/:id/spatial-frame`
 *    and is stored exactly as it was sent; one that breaks a new rule is refused with 400 and changes nothing;
 *  - the three Place fields only the server writes (`frameHistory`, `georeference`, `georefVersion`) survive a
 *    whole-record `PUT /projects/:id`, which rebuilds the Place from its body and used to be able to erase any
 *    field it did not name, and a body that carries them does not set them;
 *  - a Place saved before S0 stays exactly as it was through both routes: no key of the new ones appears.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so, as in place_frame_route.test.ts, the real
 * server is spawned on a free port with every directory it writes in a temp folder.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import type { Project, ProjectGeoreference } from '../../../src/world/types.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  json: unknown
  text: string
}

interface RunningServer {
  send(method: string, path: string, body?: unknown): Promise<Reply>
  /** The registry file as it is on disk now, not as the server answers. */
  registry(): Promise<Array<Record<string, unknown>>>
  stop(): Promise<void>
}

/** Spawns server/main.ts on port 0 with `seed` as the Places registry, and resolves once it says where it listens. */
async function startServer(seed: unknown[]): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'place-schema-route-' })
  const registryFile = `${root}/projects.json`
  await Deno.writeTextFile(registryFile, JSON.stringify(seed, null, 2))
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(Deno.env.toObject())) {
    if (INHERITED_ENV.test(name)) inherited[name] = value
  }
  let output = ''
  const pumps: Promise<void>[] = []
  const child = new Deno.Command(Deno.execPath(), {
    args: ['run', '--no-prompt', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run', SERVER_ENTRY],
    cwd: fromFileUrl(REPO_ROOT),
    clearEnv: true,
    env: {
      ...inherited,
      PORT: '0',
      SCANS_DIR: `${root}/scans`,
      WORLDS_DIR: `${root}/worlds`,
      SUMMARIES_DIR: `${root}/summaries`,
      PROJECTS_FILE: registryFile,
      STATIC_DIR: `${root}/no-static-bundle`,
      INFERENCE_MODE: 'mock',
      TAILSCALE_HOSTNAME: 'scan.test',
    },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()

  const stop = async (): Promise<void> => {
    try {
      child.kill('SIGTERM')
    } catch { /* already gone */ }
    await child.status
    await Promise.all(pumps)
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }

  let announce!: (port: number) => void
  const listening = new Promise<number>((resolve) => {
    announce = resolve
  })
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true })
      const match = /Listening on https?:\/\/[^:\s/]+:(\d+)/.exec(output)
      if (match) announce(Number(match[1]))
    }
  }
  pumps.push(pump(child.stdout), pump(child.stderr))

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
    await stop()
    throw new Error(`the server did not start (${JSON.stringify(outcome)}). Its output:\n${output.slice(-4000)}`)
  }

  const base = `http://127.0.0.1:${outcome.port}`
  return {
    send: async (method, path, body) => {
      const controller = new AbortController()
      const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await res.text()
        let json: unknown = null
        try {
          json = JSON.parse(text)
        } catch { /* not JSON */ }
        return { status: res.status, json, text }
      } finally {
        clearTimeout(abort)
      }
    },
    registry: async () => JSON.parse(await Deno.readTextFile(registryFile)) as Array<Record<string, unknown>>,
    stop,
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const UUID = '0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607'
const WITH_FIELDS = 'proj-1700000000001'
const LEGACY = 'proj-1700000000002'
const FLOORS = [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }]

const georeference: ProjectGeoreference = {
  origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 },
  heightDatum: 'unknown',
  bearingDeg: 30,
  bearingAccuracyDeg: 1,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  registeredAt: '2026-11-16T09:30:00.000Z',
  confirmedAt: '2026-11-16T09:31:00.000Z',
  anchorRef: null,
}
const history = [{
  frameId: null,
  createdAt: '2026-11-01T09:30:00.000Z',
  method: 'ground-tap-compass',
  separationM: null,
  supersededAt: '2026-11-16T09:30:00.000Z',
  reason: 'upgrade',
}]

const place = (projectId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId,
  name: `Place ${projectId}`,
  placeType: 'room',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  areas: [{ areaId: 'area-site', name: `Place ${projectId}`, kind: 'site', parentAreaId: null }],
  floors: FLOORS,
  ...extra,
})

const photo = (role: string) => ({
  url: `/projects/${WITH_FIELDS}/frames/${UUID}/ref-${role}.jpg`,
  localKey: `${WITH_FIELDS}:${UUID}:${role}`,
  tapPoint: { x: 0.5, y: 0.5 },
  pose: { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-11-16T09:29:00.000Z',
})

/** A frame as the capture flow of the next packages will write it: an id, a named check point with a photo. */
const NEW_FRAME = {
  version: 1,
  createdAt: '2026-11-17T09:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 3 },
  separationM: 3,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  frameId: UUID,
  referencePhotos: { landmark: photo('landmark'), headingMarker: photo('heading') },
  checkPoints: [{ x: 2, y: 0, z: 1.5, label: 'sink', photo: photo('check1') }],
}

const NEW_KEYS = ['frameHistory', 'georeference', 'georefVersion']

Deno.test('a frame with an id and a check point goes through the revision route as sent, and one that breaks a new rule is refused', async () => {
  const server = await startServer([place(WITH_FIELDS, { frameHistory: history, georeference, georefVersion: 1 }), place(LEGACY)])
  try {
    const refused = [
      { ...NEW_FRAME, frameId: 'a/b' },
      { ...NEW_FRAME, checkPoints: [...NEW_FRAME.checkPoints, ...NEW_FRAME.checkPoints, ...NEW_FRAME.checkPoints, ...NEW_FRAME.checkPoints] },
      { ...NEW_FRAME, checkPoints: [{ ...NEW_FRAME.checkPoints[0], photo: photo('landmark') }] },
      { ...NEW_FRAME, frameId: 'another-frame-id' },
    ]
    for (const frame of refused) {
      const res = await server.send('PUT', `/projects/${WITH_FIELDS}/spatial-frame`, { frame, expectedRevision: 0 })
      assertEquals(res.status, 400, res.text)
    }
    const before = (await server.registry()).find((each) => each['projectId'] === WITH_FIELDS)!
    assertFalse('spatialFrame' in before, 'a refused frame left no trace')

    const written = await server.send('PUT', `/projects/${WITH_FIELDS}/spatial-frame`, { frame: NEW_FRAME, expectedRevision: 0 })
    assertEquals(written.status, 200, written.text)
    assertEquals((written.json as { revision: number }).revision, 1)
    const stored = (await server.registry()).find((each) => each['projectId'] === WITH_FIELDS)!
    assertEquals(stored['spatialFrame'], NEW_FRAME, 'stored exactly as sent: no field dropped, none invented')
    // The frame write is not what the three fields are for, and does not touch them.
    assertEquals([stored['frameHistory'], stored['georeference'], stored['georefVersion']], [history, georeference, 1])
  } finally {
    await server.stop()
  }
})

Deno.test('a whole-record PUT keeps the frame history, the georeference and its version, and takes none of them from the body', async () => {
  const server = await startServer([place(WITH_FIELDS, { frameHistory: history, georeference, georefVersion: 1 })])
  try {
    const read = await server.send('GET', `/projects/${WITH_FIELDS}`)
    assertEquals(read.status, 200, read.text)
    const held = read.json as Project
    assertEquals([held.frameHistory, held.georeference, held.georefVersion], [history, georeference, 1], 'a client is shown them')

    // A client that holds the Place as it read it and renames it: the fields come back in its body, and are not what keeps them.
    const renamed = await server.send('PUT', `/projects/${WITH_FIELDS}`, { ...held, name: 'Renamed' })
    assertEquals(renamed.status, 200, renamed.text)
    // A client built before S0 does not have them at all.
    const { frameHistory: _a, georeference: _b, georefVersion: _c, ...withoutThem } = held
    const old = await server.send('PUT', `/projects/${WITH_FIELDS}`, { ...withoutThem, name: 'Renamed by an old client' })
    assertEquals(old.status, 200, old.text)
    // And one that tries to set them.
    const forged = await server.send('PUT', `/projects/${WITH_FIELDS}`, {
      ...withoutThem,
      name: 'Renamed by a forger',
      frameHistory: [],
      georeference: { ...georeference, bearingDeg: 200 },
      georefVersion: 99,
    })
    assertEquals(forged.status, 200, forged.text)

    const stored = (await server.registry()).find((each) => each['projectId'] === WITH_FIELDS)!
    assertEquals(stored['name'], 'Renamed by a forger', 'the three writes were all applied')
    assertEquals([stored['frameHistory'], stored['georeference'], stored['georefVersion']], [history, georeference, 1])
    assertEquals((forged.json as Project).georeference, georeference, 'and the reply is the Place as stored')
  } finally {
    await server.stop()
  }
})

Deno.test('a Place saved before S0 stays as it was through both routes: no key of the new ones appears', async () => {
  const server = await startServer([place(LEGACY)])
  try {
    const renamed = await server.send('PUT', `/projects/${LEGACY}`, { ...place(LEGACY), name: 'Renamed' })
    assertEquals(renamed.status, 200, renamed.text)
    const framed = await server.send('PUT', `/projects/${LEGACY}/spatial-frame`, { frame: { ...NEW_FRAME, frameId: undefined, checkPoints: undefined, referencePhotos: undefined }, expectedRevision: 0 })
    assertEquals(framed.status, 200, framed.text)
    const stored = (await server.registry()).find((each) => each['projectId'] === LEGACY)!
    for (const key of NEW_KEYS) assertFalse(key in stored, `${key} appeared on a Place that never had it`)
    const frame = stored['spatialFrame'] as Record<string, unknown>
    assert(frame && !('frameId' in frame) && !('checkPoints' in frame), 'and the frame has neither')
  } finally {
    await server.stop()
  }
})
