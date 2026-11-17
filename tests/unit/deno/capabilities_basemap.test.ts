/**
 * GET /capabilities carries the basemap: where the two maps get their tiles (src/geo/tile-source.ts).
 *
 * Unset, which is the default, the answer says `kind: 'none'`, and a map that reads it asks no tile
 * host for anything. Set, it says what MAP_TILE_SOURCE names. Set to something that cannot be used,
 * it says `none` with a reason code, and the server logs that it ignored the value without printing
 * it, because the value may hold a key. The machine report the route already served stays as it was.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so the route cannot be called from a
 * test in-process. Each test here spawns the real server/main.ts on a free port instead, with every
 * directory it writes in a temp folder and the mock inference engine, as export_route_guard.test.ts
 * does. That is the route as wired: the import of the shared module under Deno, the environment read,
 * and the handler together.
 *
 * Needs `deno task test`'s permissions (run, net, read, write, env).
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { REPO_ROOT } from '../../../server/repo-root.ts'
import { basemapFromEnv, noBasemap, normalizeBasemap } from '../../../src/geo/tile-source.ts'

const SERVER_ENTRY = fromFileUrl(new URL('server/main.ts', REPO_ROOT))
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000

/** What the spawned server may inherit: enough for Deno to find its caches, nothing that configures the Scan. */
const INHERITED_ENV = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|XDG_.*|DENO_.*|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i

const CREDIT = { text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' }
const SECRET = 'sk_live_do_not_print_me'

interface RunningServer {
  get(path: string): Promise<{ status: number; text: string; json: () => Record<string, unknown> }>
  log(): string
  stop(): Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }))
}

/** Spawns server/main.ts with `env` on top of a bare environment, and resolves once it says where it listens. */
async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const root = await Deno.makeTempDir({ prefix: 'capabilities-basemap-' })
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
      get: async (path) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await fetch(`${base}${path}`, { signal: controller.signal })
          const text = await res.text()
          return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> }
        } finally {
          clearTimeout(timeout)
        }
      },
      log: () => output.slice(-8000),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** The pages read the cheap mode; the machine report it carries must still be there. */
function assertMachineReport(body: Record<string, unknown>): void {
  for (const field of ['generatedAt', 'platform', 'tools', 'gpu', 'pipelines']) {
    assert(field in body, `the report the route always served still has ${field}`)
  }
}

Deno.test('GET /capabilities with MAP_TILE_SOURCE unset says there is no basemap, and names no provider', async () => {
  const server = await startServer({})
  try {
    const reply = await server.get('/capabilities?versions=0')
    assertEquals(reply.status, 200, reply.text.slice(0, 500))
    const body = reply.json()
    assertMachineReport(body)
    assertEquals(body.basemap, noBasemap(), 'the default is no tiles: nothing for a map to request')
    assertFalse(/https?:\/\//.test(JSON.stringify(body.basemap)), 'no address in the default')
    assertFalse(server.log().includes('MAP_TILE_SOURCE'), 'an unset variable is not a warning')
  } finally {
    await server.stop()
  }
})

Deno.test('GET /capabilities reports the basemap MAP_TILE_SOURCE names, in the shape the pages validate', async () => {
  const value = JSON.stringify({
    urlTemplate: `https://tiles.example.com/{z}/{x}/{y}.png?key=${SECRET}`,
    attribution: [CREDIT],
    maxZoom: 19,
  })
  const server = await startServer({ MAP_TILE_SOURCE: value })
  try {
    const reply = await server.get('/capabilities?versions=0')
    assertEquals(reply.status, 200, reply.text.slice(0, 500))
    const body = reply.json()
    assertMachineReport(body)
    assertEquals(body.basemap, basemapFromEnv((name) => (name === 'MAP_TILE_SOURCE' ? value : undefined)), 'the route reports what the shared module reads from the environment')
    assertEquals(
      body.basemap,
      { kind: 'raster', urlTemplate: `https://tiles.example.com/{z}/{x}/{y}.png?key=${SECRET}`, attribution: [CREDIT], maxZoom: 19, requiresKey: true },
    )
    assertEquals(normalizeBasemap(body.basemap), body.basemap, 'the page validates what the route sent to the same thing')
    assertFalse(server.log().includes(SECRET), 'a good value is never printed either')
  } finally {
    await server.stop()
  }
})

Deno.test('a MAP_TILE_SOURCE that cannot be used is no basemap with a reason, and the log does not repeat it', async () => {
  const value = JSON.stringify({ urlTemplate: `http://tiles.example.com/{z}/{x}/{y}.png?key=${SECRET}`, attribution: [CREDIT] })
  const server = await startServer({ MAP_TILE_SOURCE: value })
  try {
    const reply = await server.get('/capabilities?versions=0')
    assertEquals(reply.status, 200, reply.text.slice(0, 500))
    assertEquals(reply.json().basemap, { ...noBasemap(), problem: 'bad-url' })
    assertEquals(normalizeBasemap(reply.json().basemap), reply.json().basemap, 'the page validates the reason to itself, so the map can show it')
    assertFalse(reply.text.includes(SECRET), 'the answer never carries the refused value')
    assertStringIncludes(server.log(), 'MAP_TILE_SOURCE is set but not used')
    assertStringIncludes(server.log(), 'https')
    assertFalse(server.log().includes(SECRET), 'the boot log names the variable and the reason, not the value, which may hold a key')
  } finally {
    await server.stop()
  }
})

Deno.test('a placeholder in the host of MAP_TILE_SOURCE is refused with a reason that says where placeholders go', async () => {
  const value = JSON.stringify({ urlTemplate: `https://{z}.tiles.example.com/{x}/{y}.png?key=${SECRET}`, attribution: [CREDIT] })
  const server = await startServer({ MAP_TILE_SOURCE: value })
  try {
    const reply = await server.get('/capabilities?versions=0')
    assertEquals(reply.status, 200, reply.text.slice(0, 500))
    assertEquals(reply.json().basemap, { ...noBasemap(), problem: 'bad-template' })
    assertStringIncludes(server.log(), 'after the host')
    assertFalse(reply.text.includes(SECRET) || server.log().includes(SECRET), 'neither the answer nor the log repeats the value')
  } finally {
    await server.stop()
  }
})
