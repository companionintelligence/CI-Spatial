/**
 * GET /worlds/:slug/export.glb answers to the world's token, like the rest of a world's scan data.
 *
 * The file holds every scan's decoded geometry, each detection's photo crop and every Thing's
 * position. The route once let an anonymous caller read it (`allowAnonymous: true`), on the premise
 * that a scan's geometry is already served without a login at /scans/*.glb. That holds only on an
 * install that is open by design. Once sign-in is on, or SCAN_REQUIRE_AUTH=1, /scans answers 401
 * without a session, and the session guard on /worlds covers only the exact path /worlds, not
 * /worlds/:slug/..., so the export was the one way round the guard.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so the route cannot be called
 * from a test in-process. Each test here spawns the real server/main.ts on a free port instead,
 * with every directory it writes in a temp folder and the mock inference engine, and talks to it
 * over HTTP. That is the route as wired: the middleware, the guard and the handler together.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const JOB_TIMEOUT_MS = 30_000

/** What the export-world job leaves for the route to serve. The route reads bytes; their content is the composer's business. */
const EXPORT_BYTES = new TextEncoder().encode('glTF-export-guard-test: whole-Place geometry and Thing positions')

/** Sign-in on, with an issuer on a port Deno blocks, so discovery fails at once and nothing leaves the machine. */
const SIGN_IN_ON: Record<string, string> = {
  PORTAL_OIDC_ENABLED: '1',
  OIDC_ISSUER_URL: 'http://127.0.0.1:9',
  PORTAL_OIDC_ALLOWED_EMAILS: 'owner@example.com',
  SESSION_SECRET: 'export-route-guard-test-secret',
}

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

interface Reply {
  status: number
  headers: Headers
  body: Uint8Array
  text: string
}

interface RunningServer {
  worldsDir: string
  /** One request. `token` goes in the query, as the editor's share links do; `bearer` goes in the header. */
  get(path: string, opts?: { token?: string; bearer?: string }): Promise<Reply>
  post(path: string, body: unknown, opts?: { token?: string }): Promise<Reply>
  /** What the server printed so far, for a failure message. */
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
    const body = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, headers: res.headers, body, text: new TextDecoder().decode(body) }
  } finally {
    clearTimeout(timer)
  }
}

function withToken(path: string, token: string | undefined): string {
  if (!token) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * Spawns server/main.ts with `env` on top of a bare environment, and resolves once it says where it
 * listens. Port 0 lets Deno pick the port, so nothing can already hold it.
 */
async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'export-route-guard-' })
  const worldsDir = `${root}/worlds`
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
        WORLDS_DIR: worldsDir,
        SUMMARIES_DIR: `${root}/summaries`,
        PROJECTS_FILE: `${root}/projects.json`,
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
      worldsDir,
      get: (path, opts = {}) =>
        send(base, withToken(path, opts.token), opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : {}),
      post: (path, body, opts = {}) =>
        send(base, withToken(path, opts.token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      log: () => output.slice(-4000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/**
 * The member tokens of a world. Reading the world is open on every install, and it makes the
 * server write the world file, with its tokens, so the test reads them from there.
 */
async function worldTokens(server: RunningServer, slug: string): Promise<Record<string, string>> {
  const read = await server.get(`/worlds/${slug}`)
  assertEquals(read.status, 200, `GET /worlds/${slug} should create the world: ${read.text}`)
  const world = JSON.parse(await Deno.readTextFile(`${server.worldsDir}/${slug}.json`)) as {
    members: Array<{ role: string; token: string }>
  }
  return Object.fromEntries(world.members.map((member) => [member.role, member.token]))
}

/** Writes the file the export-world job writes (_runExportWorldJob: <WORLDS_DIR>/<slug>.world.glb). */
async function leaveExport(server: RunningServer, slug: string): Promise<void> {
  await Deno.writeFile(`${server.worldsDir}/${slug}.world.glb`, EXPORT_BYTES)
}

/** A refusal must not carry the file, in its body or in how it is labelled. */
function assertNotTheExport(reply: Reply, what: string): void {
  assertNotEquals(reply.body, EXPORT_BYTES, `${what}: the response must not be the export`)
  assert(!reply.headers.get('content-type')?.startsWith('model/gltf-binary'), `${what}: not served as a glTF`)
}

interface Mode {
  name: string
  env: Record<string, string>
  /** Whether strict world auth is on: a world's scan data needs the world's token. */
  strict: boolean
  /** Whether /scans answers 401 without a Companion session. This is the premise the old comment relied on. */
  scansNeedSession: boolean
}

const MODES: Mode[] = [
  { name: 'sign-in on', env: SIGN_IN_ON, strict: true, scansNeedSession: true },
  { name: 'SCAN_REQUIRE_AUTH=1', env: { SCAN_REQUIRE_AUTH: '1' }, strict: true, scansNeedSession: true },
  { name: 'WORLD_STRICT_AUTH=1', env: { WORLD_STRICT_AUTH: '1' }, strict: true, scansNeedSession: false },
  { name: 'an install open by design', env: {}, strict: false, scansNeedSession: false },
]

for (const mode of MODES) {
  Deno.test(`export.glb, ${mode.name}: ${mode.strict ? 'the world token decides' : 'open, but a token must still be a real one'}`, async () => {
    const server = await startServer(mode.env)
    try {
      const tokens = await worldTokens(server, 'default')
      const route = '/worlds/default/export.glb'
      const why = (what: string) => `${mode.name}: ${what}. Server log:\n${server.log()}`

      // The premise of the old comment, stated per mode: /scans is closed to an anonymous caller exactly
      // where a session is required, and open (a 404 for a file that is not there) where it is not.
      const scans = await server.get('/scans/not-there.glb')
      assertEquals(scans.status, mode.scansNeedSession ? 401 : 404, why('anonymous GET /scans/<file>.glb'))

      // Before any export exists. An anonymous caller learns nothing about whether one does.
      const early = await server.get(route)
      assertEquals(early.status, mode.strict ? 401 : 404, why('anonymous GET, no export built yet'))
      if (mode.strict) {
        assertEquals((await server.get(route, { token: tokens.viewer })).status, 404, why('viewer token, no export built yet'))
      }

      await leaveExport(server, 'default')

      const anonymous = await server.get(route)
      if (mode.strict) {
        assertEquals(anonymous.status, 401, why('anonymous GET of a built export'))
        assertNotTheExport(anonymous, 'anonymous')
        if (mode.scansNeedSession) {
          assertEquals(anonymous.status, scans.status, why('the export is no more open than the scan geometry it contains'))
        }
      } else {
        assertEquals(anonymous.status, 200, why('anonymous GET on an install that is open by design'))
        assertEquals(anonymous.body, EXPORT_BYTES, why('the file the job wrote'))
      }

      const wrong = await server.get(route, { token: 'not-a-token-of-this-world' })
      assertEquals(wrong.status, 403, why('a token that is not a member of this world'))
      assertNotTheExport(wrong, 'wrong token')

      // scanner is below viewer: it uploads captures and does not read the Place back.
      const scanner = await server.get(route, { token: tokens.scanner })
      assertEquals(scanner.status, 403, why('scanner token'))
      assertNotTheExport(scanner, 'scanner token')

      for (const role of ['viewer', 'commenter', 'editor', 'owner']) {
        const reply = await server.get(route, { token: tokens[role] })
        assertEquals(reply.status, 200, why(`${role} token`))
        assertEquals(reply.body, EXPORT_BYTES, why(`${role} token gets the file the job wrote`))
        assertEquals(reply.headers.get('content-type'), 'model/gltf-binary', why(`${role}: content type`))
        assertEquals(
          reply.headers.get('content-disposition'),
          'attachment; filename="default.world.glb"',
          why(`${role}: download name`),
        )
        assertEquals(reply.headers.get('cache-control'), 'private, no-store', why(`${role}: no shared cache may keep it`))
      }

      const bearer = await server.get(route, { bearer: tokens.viewer })
      assertEquals(bearer.status, 200, why('viewer token in an Authorization header'))
      assertEquals(bearer.body, EXPORT_BYTES, why('viewer token in an Authorization header: the file'))
      assertEquals(bearer.headers.get('cache-control'), 'private, no-store', why('bearer: no shared cache may keep it'))

      // The token of one world opens nothing of another's.
      const other = await worldTokens(server, 'other-place')
      await leaveExport(server, 'other-place')
      assertEquals(
        (await server.get('/worlds/other-place/export.glb', { token: tokens.owner })).status,
        403,
        why("another world's owner token"),
      )
      assertEquals((await server.get('/worlds/other-place/export.glb', { token: other.viewer })).status, 200, why("this world's own token"))
    } finally {
      await server.stop()
    }
  })
}

Deno.test('export.glb: the artifact url an export-world job reports is the guarded route', async () => {
  const server = await startServer(SIGN_IN_ON)
  try {
    const tokens = await worldTokens(server, 'default')
    const queued = await server.post('/worlds/default/jobs', { type: 'export-world' }, { token: tokens.editor })
    assertEquals(queued.status, 202, queued.text)
    const jobId = (JSON.parse(queued.text) as { jobId: string }).jobId

    // Wait for the real job runner to write the file.
    type Job = { jobId: string; status: string; result?: string; artifacts?: Array<{ type: string; url?: string }> }
    let job: Job | undefined
    const deadline = Date.now() + JOB_TIMEOUT_MS
    while (Date.now() < deadline) {
      const jobs = await server.get('/worlds/default/jobs', { token: tokens.viewer })
      assertEquals(jobs.status, 200, jobs.text)
      job = (JSON.parse(jobs.text) as Job[]).find((item) => item.jobId === jobId)
      if (job && (job.status === 'completed' || job.status === 'failed')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assertEquals(job?.status, 'completed', `the export-world job: ${job?.result}\n${server.log()}`)
    const url = job?.artifacts?.find((artifact) => artifact.type === 'world-glb')?.url
    assertEquals(url, '/worlds/default/export.glb', 'the job names the route the other tests guard')
    assert(url)

    // The link in the job record carries no credential, so as it stands it is refused. Anyone who
    // follows it needs the world's token, and the Scan's own scan geometry is shut to them too.
    assertEquals((await server.get('/scans/not-there.glb')).status, 401, 'sign-in is on: /scans needs a session')
    const bare = await server.get(url)
    assertEquals(bare.status, 401, 'the link as the job reports it, with no token')
    const wrong = await server.get(url, { token: 'not-a-token-of-this-world' })
    assertEquals(wrong.status, 403, 'a token that is not this world\'s')

    const file = await server.get(url, { token: tokens.viewer })
    assertEquals(file.status, 200, 'the link with the viewer token')
    assertEquals(new TextDecoder().decode(file.body.slice(0, 4)), 'glTF', 'a binary glTF, as the job wrote it')
    assertEquals(file.headers.get('cache-control'), 'private, no-store')
  } finally {
    await server.stop()
  }
})
