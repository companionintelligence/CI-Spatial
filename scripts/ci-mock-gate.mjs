#!/usr/bin/env node
/**
 * CI-executable half of the detection regression gate: starts the Deno
 * server with the deterministic mock engine, runs scripts/eval-cv.mjs
 * against the synthetic corpus with STRICT=1, and tears the server down —
 * no Ollama, no GPU, no model weights, matching the "hard constraint: CI has
 * no model" section of docs/factory/06-detection-ground-truth/
 * 0003-detection-regression-gate.md.
 *
 * This catches pipeline breakage (a scoring/harness/schema regression,
 * or the mock engine itself drifting off its palette) — it cannot catch a
 * *model quality* regression, since the mock engine doesn't run a model.
 * That half is the real-corpus baseline comparison, which needs Ollama and,
 * until 0001's corpus is populated, a human — see check-detection-gate.mjs.
 *
 * Server spawn/wait/teardown mirrors scripts/bench-models.mjs's pattern
 * deliberately (same job, smaller scope) rather than reinventing it.
 *
 *   node scripts/ci-mock-gate.mjs
 */
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tag = '[ci-mock-gate]'
const PORT = Number(process.env.PORT ?? 8098)
const SERVER_URL = `http://localhost:${PORT}`
const RUN_DIR = join(root, '.test-run', 'ci-mock-gate')
const READY_TIMEOUT_MS = 60_000

const denoBin = (() => {
  try { return execSync('command -v deno', { shell: '/bin/sh' }).toString().trim() } catch { /* not on PATH */ }
  return join(homedir(), '.deno', 'bin', 'deno')
})()

rmSync(RUN_DIR, { recursive: true, force: true })
for (const d of ['scans', 'worlds', 'summaries']) mkdirSync(join(RUN_DIR, d), { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn(
  denoBin,
  ['run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', 'server/main.ts'],
  {
    cwd: root,
    env: {
      ...process.env,
      INFERENCE_MODE: 'mock',
      PORT: String(PORT),
      SCANS_DIR: join(RUN_DIR, 'scans'),
      WORLDS_DIR: join(RUN_DIR, 'worlds'),
      SUMMARIES_DIR: join(RUN_DIR, 'summaries'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so teardown kills grandchildren too
  },
)
server.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`))
server.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`))

const killServer = () => { try { process.kill(-server.pid, 'SIGTERM') } catch { /* already gone */ } }
process.on('SIGINT', () => { killServer(); process.exit(130) })
process.on('SIGTERM', () => { killServer(); process.exit(143) })

async function waitForReady() {
  const started = Date.now()
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})`)
    try {
      const resp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (resp.ok && (await resp.json()).engineLoadState === 'ready') return
    } catch { /* not up yet */ }
    await sleep(300)
  }
  throw new Error(`server not ready after ${READY_TIMEOUT_MS / 1000}s`)
}

let exitCode = 1
try {
  console.log(`${tag} waiting for mock engine on ${SERVER_URL}…`)
  await waitForReady()
  console.log(`${tag} generating synthetic corpus…`)
  execSync('npm run gen:test-data', { cwd: root, stdio: 'inherit' })
  console.log(`${tag} scoring mock engine against the synthetic corpus (STRICT=1)…`)
  execSync('node scripts/eval-cv.mjs', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SERVER_URL, STRICT: '1', CV_CORPUS: 'synthetic' },
  })
  exitCode = 0
} catch (err) {
  console.error(`${tag} FAIL — ${err.message}`)
  exitCode = 1
} finally {
  killServer()
  await sleep(500)
}
process.exit(exitCode)
