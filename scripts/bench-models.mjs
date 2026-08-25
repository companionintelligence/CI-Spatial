#!/usr/bin/env node
/**
 * bench-models.mjs — pick the best Ollama vision model for this box by
 * scoring each candidate against the discriminating corpus via
 * scripts/eval-cv.mjs.
 *
 *   npm run bench:models
 *   BENCH_MODELS=moondream:latest,gemma4:31b npm run bench:models
 *   BENCH_MODELS=mock npm run bench:models     # mock engine baseline (~1.0)
 *   BENCH_PULL=1 npm run bench:models          # ollama-pull missing models
 *   CV_CORPUS=synthetic npm run bench:models   # force one corpus for every candidate
 *
 * Corpus selection (scripts/lib/cv-corpus.mjs), per candidate: the `mock`
 * candidate always scores against the *synthetic* corpus (test-data/cv/,
 * where it scores ~1.0 as a pipeline regression check); every other
 * candidate scores against the *real* corpus (test-data/real/, human-
 * verified photographs — the only fixture that discriminates a working
 * model from a fabricating one). Set CV_CORPUS to override this for every
 * candidate at once, e.g. to compare all of them on the synthetic corpus
 * on purpose (eval-cv.mjs will warn that a non-mock score there isn't
 * meaningful). A candidate whose corpus has no images yet (the real corpus
 * ships empty until docs/factory/06-detection-ground-truth/
 * 0001-real-photograph-corpus.md's manual step lands) is reported as a
 * skipped failure, not a crash.
 *
 * OLLAMA_MODEL is baked into the engine at Deno-server start, so each
 * candidate gets a fresh isolated server on :8095 (data under
 * .test-run/bench/, never the real scans/ and worlds/ dirs). Per model:
 * wait for /health engineLoadState==='ready', warm up with one discarded
 * /infer (the first Ollama call loads weights into VRAM — must not pollute
 * latency numbers), run eval-cv, collect <corpus dir>/report.json.
 *
 * Output: <corpus dir>/report-<model-slug>.json per model, plus
 * test-data/bench-summary.json and a markdown table on stdout, sorted
 * quality-first (precision+recall desc, then mean latency asc). A model
 * that fails to load or score is reported in the table, not fatal.
 *
 * Env knobs: BENCH_MODELS, BENCH_PULL, BENCH_PORT (8095), OLLAMA_HOST,
 * BENCH_WARMUP_MS (300000), CV_CORPUS.
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstPerTier } from '../src/shared/model-catalog.ts'
import { normalizeOllamaHost } from '../src/shared/ollama-host.ts'
import { resolveCorpus } from './lib/cv-corpus.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.BENCH_PORT ?? 8095)
const SERVER_URL = `http://localhost:${PORT}`
const OLLAMA = normalizeOllamaHost(process.env.OLLAMA_HOST)
const MODELS = (process.env.BENCH_MODELS ?? firstPerTier().join(','))
  .split(',').map((m) => m.trim()).filter(Boolean)
const READY_TIMEOUT_MS = 120_000
const WARMUP_MS = Number(process.env.BENCH_WARMUP_MS ?? 300_000)
const RUN_DIR = join(root, '.test-run', 'bench')
const CV_CORPUS_OVERRIDE = process.env.CV_CORPUS

const denoBin = (() => {
  try { return execSync('command -v deno', { shell: '/bin/sh' }).toString().trim() } catch { /* not on PATH */ }
  return join(homedir(), '.deno', 'bin', 'deno')
})()

// Fresh isolated data dirs each run
rmSync(RUN_DIR, { recursive: true, force: true })
for (const d of ['scans', 'worlds', 'summaries']) mkdirSync(join(RUN_DIR, d), { recursive: true })

/** Which corpus a candidate scores against — see header comment. */
function corpusForModel(model) {
  return resolveCorpus(root, CV_CORPUS_OVERRIDE ?? (model === 'mock' ? 'synthetic' : 'real'))
}

// Auto-generate the synthetic corpus (idempotent, ~seconds) if any candidate needs it.
// The real corpus is never auto-generated — populating it is a physical/human step
// (docs/factory/06-detection-ground-truth/0001-real-photograph-corpus.md).
const neededLabels = new Set(MODELS.map((m) => corpusForModel(m).label))
if (neededLabels.has('synthetic')) {
  const synthetic = resolveCorpus(root, 'synthetic')
  if (!existsSync(join(synthetic.dir, 'expected.json'))) {
    console.log('[bench] generating synthetic test corpus…')
    execSync('npm run gen:test-data', { cwd: root, stdio: 'inherit' })
  }
}

const corpusDataCache = new Map()
/** Loaded expected.json for a corpus, or null if missing/unreadable. Cached per dir. */
function loadCorpusData(corpus) {
  if (corpusDataCache.has(corpus.dir)) return corpusDataCache.get(corpus.dir)
  const file = join(corpus.dir, 'expected.json')
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  corpusDataCache.set(corpus.dir, data)
  return data
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let currentServer = null
const killServer = (child) => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ } }
process.on('SIGINT', () => { if (currentServer) killServer(currentServer); process.exit(130) })
process.on('SIGTERM', () => { if (currentServer) killServer(currentServer); process.exit(143) })

/** Preflight: is the model in the local Ollama store (pull it if BENCH_PULL=1)? */
async function ensureModel(model) {
  if (model === 'mock') return true // built-in mock engine, no Ollama involved
  let tags
  try {
    const resp = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    tags = (await resp.json()).models?.map((m) => m.name) ?? []
  } catch (err) {
    throw new Error(`Ollama unreachable at ${OLLAMA} (${err.message})`)
  }
  // Ollama treats a bare name as :latest — accept either form
  if (tags.includes(model) || tags.includes(`${model}:latest`)) return true
  if (process.env.BENCH_PULL !== '1') {
    console.warn(`[bench] ${model} not in local Ollama store — skipping (set BENCH_PULL=1 to pull)`)
    return false
  }
  console.log(`[bench] pulling ${model} (this can take minutes)…`)
  const pull = spawnSync('ollama', ['pull', model], { stdio: 'inherit' })
  if (pull.status !== 0) {
    console.warn(`[bench] ollama pull ${model} exited ${pull.status ?? pull.error?.message} — skipping`)
    return false
  }
  return true
}

async function waitForReady(server) {
  const started = Date.now()
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})`)
    let health = null
    try {
      const resp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (resp.ok) health = await resp.json()
    } catch { /* not up yet */ }
    if (health?.engineLoadState === 'ready') return
    if (health?.engineLoadState === 'failed') throw new Error('engine load failed (see server log above)')
    await sleep(500)
  }
  throw new Error(`server not ready after ${READY_TIMEOUT_MS / 1000}s`)
}

/** One discarded /infer so weight-loading time never pollutes latency stats. */
async function warmup(model, warmupImage) {
  console.log(`[bench] warming up ${model} (first inference loads the model)…`)
  const deadline = Date.now() + WARMUP_MS
  while (Date.now() < deadline) {
    const form = new FormData()
    form.append('image', new Blob([warmupImage], { type: 'image/jpeg' }), 'warmup.jpg')
    try {
      const resp = await fetch(`${SERVER_URL}/infer`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
      if (resp.ok) { await resp.arrayBuffer(); return } // discard
      const body = await resp.json().catch(() => ({}))
      if (resp.status === 503 || resp.status === 504) { await sleep(3000); continue } // still loading
      throw new Error(`warmup /infer → HTTP ${resp.status} (${body.code ?? body.error ?? 'no detail'})`)
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') continue
      throw err
    }
  }
  throw new Error(`warmup did not succeed within ${WARMUP_MS / 1000}s`)
}

async function benchModel(model) {
  console.log(`\n━━━ ${model} ━━━`)
  const corpus = corpusForModel(model)
  const row = { model, corpus: corpus.label, precision: null, recall: null, meanIoU: null, labelAccuracy: null, meanLatencyMs: null, p95LatencyMs: null, images: null, failures: null }

  const corpusData = loadCorpusData(corpus)
  if (!corpusData) {
    const reason = corpus.missingHelp(corpus.rel)
    console.warn(`[bench] ${model}: skipping — ${reason}`)
    return { ...row, failures: reason }
  }
  if (corpusData.length === 0) {
    const reason = corpus.emptyHelp(corpus.rel)
    console.warn(`[bench] ${model}: skipping — ${reason}`)
    return { ...row, failures: reason }
  }
  console.log(`[bench] ${model} → corpus: ${corpus.rel} (${corpusData.length} images)`)
  const warmupImage = readFileSync(join(corpus.dir, corpusData[0].file))

  try {
    if (!(await ensureModel(model))) return { ...row, failures: 'not available locally (BENCH_PULL=1 to pull)' }
  } catch (err) {
    return { ...row, failures: err.message }
  }

  const server = spawn(denoBin, ['run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', '--allow-ffi', 'server/main.ts'], {
    cwd: root,
    env: {
      ...process.env,
      ...(model === 'mock' ? { INFERENCE_MODE: 'mock' } : { INFERENCE_MODE: 'ollama', OLLAMA_MODEL: model, OLLAMA_HOST: OLLAMA }),
      PORT: String(PORT),
      SCANS_DIR: join(RUN_DIR, 'scans'),
      WORLDS_DIR: join(RUN_DIR, 'worlds'),
      SUMMARIES_DIR: join(RUN_DIR, 'summaries'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so teardown kills grandchildren too
  })
  currentServer = server
  server.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`))
  server.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`))

  try {
    await waitForReady(server)
    await warmup(model, warmupImage)

    // Async spawn, not execSync: a blocked parent stops draining the server's
    // stdout pipe and a full 64KB buffer wedges the Deno API mid-request.
    const evalStart = Date.now()
    await new Promise((resolve, reject) => {
      const ev = spawn('node', ['scripts/eval-cv.mjs'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, SERVER_URL, STRICT: '0', CV_CORPUS: corpus.label },
      })
      ev.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`eval-cv exited ${code}`)))
      ev.on('error', reject)
    })
    const totalEvalMs = Date.now() - evalStart

    const report = JSON.parse(readFileSync(join(corpus.dir, 'report.json'), 'utf8'))
    const slug = model.replace(/[^a-z0-9._-]+/gi, '_')
    copyFileSync(join(corpus.dir, 'report.json'), join(corpus.dir, `report-${slug}.json`))

    const times = report.perImage.filter((p) => typeof p.ms === 'number').map((p) => p.ms).sort((a, b) => a - b)
    const imageErrors = report.perImage.filter((p) => p.error).length
    return {
      ...row,
      precision: report.precision,
      recall: report.recall,
      meanIoU: report.meanIoU,
      labelAccuracy: report.labelAccuracy,
      meanLatencyMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      p95LatencyMs: times.length ? times[Math.min(times.length - 1, Math.ceil(0.95 * times.length) - 1)] : null,
      images: report.images,
      failures: imageErrors ? `${imageErrors}/${report.images} images errored` : null,
      totalEvalMs,
    }
  } catch (err) {
    console.error(`[bench] ${model} failed: ${err.message}`)
    return { ...row, failures: err.message }
  } finally {
    killServer(server)
    currentServer = null
    await sleep(1500) // let :8095 free before the next model's server binds
  }
}

const results = []
for (const model of MODELS) results.push(await benchModel(model))

// Quality-first ordering: precision+recall desc, then mean latency asc; unscored last
results.sort((a, b) =>
  ((b.precision ?? -1) + (b.recall ?? -1)) - ((a.precision ?? -1) + (a.recall ?? -1)) ||
  (a.meanLatencyMs ?? Infinity) - (b.meanLatencyMs ?? Infinity))
writeFileSync(join(root, 'test-data', 'bench-summary.json'), JSON.stringify(results, null, 2))

const pct = (v) => v === null ? '—' : `${(v * 100).toFixed(1)}%`
const ms = (v) => v === null ? '—' : `${v}ms`
const corporaUsed = [...neededLabels].map((label) => {
  const data = corpusDataCache.get(resolveCorpus(root, label).dir)
  return `${label} (${data?.length ?? 0} images)`
}).join(', ')
const md = [
  `\nCorpora: ${corporaUsed}, greedy IoU≥0.5 matching (scripts/eval-cv.mjs) via ${OLLAMA}`,
  '',
  '| model | corpus | precision | recall | meanIoU | label acc | mean | p95 | images | failures |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...results.map((r) =>
    `| ${r.model} | ${r.corpus} | ${pct(r.precision)} | ${pct(r.recall)} | ${r.meanIoU === null ? '—' : r.meanIoU.toFixed(3)} | ` +
    `${pct(r.labelAccuracy)} | ${ms(r.meanLatencyMs)} | ${ms(r.p95LatencyMs)} | ${r.images ?? '—'} | ${r.failures ?? '—'} |`),
  '',
].join('\n')
console.log(md)
console.log(`[bench] summary → test-data/bench-summary.json`)
