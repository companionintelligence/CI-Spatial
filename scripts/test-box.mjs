#!/usr/bin/env node
/**
 * test-box.mjs — self-contained automated test loop for a single box.
 *
 *   npm run test:box
 *
 * Boots an isolated Deno API (mock inference, :8100, data under .test-run/)
 * plus a Vite dev server (:5273) proxying to it, generates the test corpus if
 * missing, seeds the world, runs the `api` + `chromium-mock` Playwright
 * projects against them, and tears everything down. Never touches the
 * long-lived :8000/:5173 servers or the real scans/ and worlds/ dirs.
 *
 * Env knobs: TEST_BOX_API_PORT (8100), TEST_BOX_VITE_PORT (5273),
 * CHROMIUM_EXECUTABLE_PATH (forwarded to Playwright).
 */
import { spawn, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = Number(process.env.TEST_BOX_API_PORT ?? 8100)
const VITE_PORT = Number(process.env.TEST_BOX_VITE_PORT ?? 5273)
const API_URL = `http://localhost:${API_PORT}`
const VITE_URL = `https://localhost:${VITE_PORT}`
const RUN_DIR = join(root, '.test-run')

const denoBin = (() => {
  try { return execSync('command -v deno', { shell: '/bin/sh' }).toString().trim() } catch { /* not on PATH */ }
  return join(homedir(), '.deno', 'bin', 'deno')
})()

// Launch the two npm-installed CLIs through node with their own JS entry
// points instead of `npx`. On Windows `npx` is a .cmd shim: bare 'npx' is
// ENOENT (spawn() calls CreateProcess directly and never tries PATHEXT), and
// 'npx.cmd' is EINVAL on Node 18.20+/20.12+/22+ unless spawned with a shell.
// The .js entry points are plain files on every platform, so no shim, no
// shell quoting, and one less process between us and the server.
const VITE_CLI = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const PLAYWRIGHT_CLI = join(root, 'node_modules', '@playwright', 'test', 'cli.js')

const children = []
function shutdown(code) {
  for (const child of children) {
    try {
      // Windows has no process groups: kill(-pid) throws, and swallowing that
      // leaves the API server holding :8100, so the next run dies AddrInUse
      // against its own orphan. taskkill /T is the equivalent tree kill.
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' })
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch { /* already gone */ }
  }
  process.exit(code)
}
process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))

function launch(name, cmd, args, env) {
  // Redirect stdout+stderr to a log file rather than a pipe: draining a child's
  // stdout through the parent event loop stalls under the chromium-mock request
  // burst, and once the pipe buffer fills Deno's blocking console.log wedges the
  // API server mid-request. A file fd never backpressures the child.
  const logPath = join(RUN_DIR, `${name}.log`)
  const logFd = openSync(logPath, 'a')
  console.log(`[test-box] ${name} logs → ${logPath}`)
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', logFd, logFd],
    detached: true, // own process group so shutdown kills grandchildren too
  })
  child.on('exit', (code) => {
    if (!finished) {
      console.error(`[test-box] ${name} exited early (code ${code})`)
      shutdown(1)
    }
  })
  children.push(child)
  return child
}

async function waitFor(url, label, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (resp.ok) { console.log(`[test-box] ${label} up (${Date.now() - started}ms)`); return }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error(`[test-box] timeout waiting for ${label} at ${url}`)
  shutdown(1)
}

let finished = false

// Fresh isolated data dirs each run
rmSync(RUN_DIR, { recursive: true, force: true })
for (const d of ['scans', 'worlds', 'summaries']) mkdirSync(join(RUN_DIR, d), { recursive: true })

// The lingbot-map spec expects its fixture session to be visible through the
// API; mirror it from the repo's scans/ into the isolated store when present.
const lingbotFixture = join(root, 'scans', 'sessions', 'sess-fixture-lingbot')
if (existsSync(join(lingbotFixture, 'lingbot-map.manifest.json'))) {
  cpSync(lingbotFixture, join(RUN_DIR, 'scans', 'sessions', 'sess-fixture-lingbot'), { recursive: true })
  console.log('[test-box] mirrored lingbot-map fixture session')
}

// The splat-train spec needs its .ply + manifest served from SCANS_DIR. Unlike
// the lingbot fixture (which requires ffmpeg + a downloaded video), the splat
// fixture is fully synthetic, so we can generate it straight into the isolated
// store on every run.
try {
  execSync('node scripts/make-splat-fixture.mjs', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SCANS_DIR: join(RUN_DIR, 'scans') },
  })
  console.log('[test-box] generated splat-train fixture')
} catch (e) {
  console.warn('[test-box] splat fixture generation failed (spec will skip):', e.message)
}

// 1. Corpus (idempotent, ~seconds)
if (!existsSync(join(root, 'test-data', 'cv', 'expected.json'))) {
  console.log('[test-box] generating test corpus…')
  execSync('npm run gen:test-data', { cwd: root, stdio: 'inherit' })
}

// 2. Servers
launch('deno', denoBin, ['run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', '--allow-run', 'main.ts'], {
  INFERENCE_MODE: 'mock',
  PORT: String(API_PORT),
  SCANS_DIR: join(RUN_DIR, 'scans'),
  WORLDS_DIR: join(RUN_DIR, 'worlds'),
  SUMMARIES_DIR: join(RUN_DIR, 'summaries'),
  // Without this, the isolated Deno's viteBaseUrlFromEnv() defaults to 5173 even
  // though this run's real Vite is on TEST_BOX_VITE_PORT — its share links/QR
  // output would then leak the wrong port instead of this instance's own.
  VITE_PORT: String(VITE_PORT),
})
// Vite's default recursive file watcher watches every GLB the seed dumps into
// .test-run/scans (plus node_modules) — on this shared box that exhausts the
// system inotify watch limit and crashes vite with ENOSPC mid-seed. This is a
// headless test run, so HMR/watch buys us nothing; disable it via a throwaway
// no-watch config that extends the real vite.config.ts. Cleaned up on exit.
const NOWATCH_CONFIG = join(RUN_DIR, '.vite.nowatch.mjs')
writeFileSync(
  NOWATCH_CONFIG,
  // A file:// URL, not a bare path: on Windows a raw absolute path is a
  // 'c:' URL scheme the ESM loader rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  `import base from '${pathToFileURL(join(root, 'vite.config.ts')).href}'\n` +
    `export default { ...base, server: { ...(base.server || {}), watch: null } }\n`,
)
launch('vite', process.execPath, [VITE_CLI, '--config', NOWATCH_CONFIG, '--host', '--port', String(VITE_PORT), '--strictPort'], {
  API_TARGET: API_URL,
})

// TLS probe against the dev cert (hostname mismatch on localhost is expected)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
await waitFor(`${API_URL}/health`, 'deno api')
await waitFor(`${VITE_URL}/health`, 'vite proxy')

try {
  // 3. Seed the world (api specs also upload their own; editor specs want a populated world).
  // Async spawn, not execSync: a blocked parent loop stops draining the servers'
  // stdout pipes, and once the 64KB pipe buffer fills, Deno's blocking console.log
  // wedges the API server mid-request.
  await new Promise((resolve, reject) => {
    const seed = spawn('node', ['scripts/seed-test-homes.mjs'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, SERVER_URL: API_URL },
    })
    seed.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`seed-test-homes exited ${code}`)))
    seed.on('error', reject)
  })

  // 4. Test suites
  console.log('[test-box] running playwright: api + chromium-mock')
  const pw = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--project=api', '--project=chromium-mock'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      API_URL,
      VITE_URL,
    },
  })
  pw.on('exit', (code) => {
    finished = true
    console.log(`[test-box] playwright exited ${code}`)
    shutdown(code ?? 1)
  })
} catch (err) {
  // A failed step must not leak the detached servers
  console.error(`[test-box] ${err.message}`)
  shutdown(1)
}
