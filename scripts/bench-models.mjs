#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const models = (process.env.BENCH_MODELS ?? 'moondream:latest,gemma4:31b,qwen3-vl:8b,qwen3-vl:32b')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const port = Number(process.env.BENCH_PORT ?? 8095)
const serverUrl = `http://127.0.0.1:${port}`
const outDir = join(root, 'test-data', 'cv')
const summaryPath = join(outDir, 'bench-summary.json')

if (!existsSync(join(outDir, 'expected.json'))) {
  console.error('[bench-models] Missing test data. Run: npm run gen:test-data')
  process.exit(1)
}

const available = listOllamaModels()
const rows = []

for (const model of models) {
  if (!available.has(model) && process.env.BENCH_PULL === '1') {
    console.log(`[bench-models] pulling ${model}`)
    spawnSync('ollama', ['pull', model], { stdio: 'inherit' })
  }
  if (!listOllamaModels().has(model)) {
    console.warn(`[bench-models] skipping ${model}; not available locally`)
    rows.push({ model, skipped: true, reason: 'not available locally' })
    continue
  }

  const server = spawn('deno', [
    'run',
    '--allow-net',
    '--allow-read',
    '--allow-write',
    '--allow-env',
    '--allow-ffi',
    'main.ts',
  ], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PORT: String(port),
      DENO_NO_PACKAGE_JSON: '1',
      INFERENCE_MODE: 'ollama',
      OLLAMA_MODEL: model,
      SCANS_DIR: '.test-run/bench-scans',
      SUMMARIES_DIR: '.test-run/bench-summaries',
      WORLDS_DIR: '.test-run/bench-worlds',
      PROJECTS_FILE: '.test-run/bench-projects.json',
    },
  })

  try {
    await waitForHealth(serverUrl, 120_000)
    const gpuBefore = rocmSnapshot()
    const started = Date.now()
    const evalRun = spawnSync('node', ['scripts/eval-cv.mjs'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, SERVER_URL: serverUrl },
    })
    const elapsedMs = Date.now() - started
    const gpuAfter = rocmSnapshot()
    if (evalRun.status !== 0) {
      rows.push({ model, failed: true, elapsedMs, gpuBefore, gpuAfter })
      continue
    }
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'))
    const reportPath = join(outDir, `report-${safeName(model)}.json`)
    copyFileSync(join(outDir, 'report.json'), reportPath)
    rows.push({ model, elapsedMs, reportPath, gpuBefore, gpuAfter, ...report })
  } finally {
    server.kill('SIGTERM')
    await new Promise((resolve) => server.once('exit', resolve))
  }
}

mkdirSync(outDir, { recursive: true })
writeFileSync(summaryPath, JSON.stringify({ evaluatedAt: new Date().toISOString(), rows }, null, 2))
writeFileSync(join(outDir, 'bench-summary.md'), markdown(rows))
console.log(`[bench-models] wrote ${summaryPath}`)

function listOllamaModels() {
  const run = spawnSync('ollama', ['list'], { encoding: 'utf8' })
  if (run.status !== 0) return new Set()
  return new Set(run.stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean))
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/health`)
      if (resp.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error(`Timed out waiting for ${url}/health`)
}

function rocmSnapshot() {
  const run = spawnSync('rocm-smi', ['--showuse'], { encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : null
}

function safeName(model) {
  return model.replace(/[^a-z0-9._-]+/gi, '_')
}

function markdown(items) {
  const lines = [
    '| Model | Precision | Recall | Mean IoU | Label Acc | Mean Latency | Notes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const row of items) {
    if (row.skipped || row.failed) {
      lines.push(`| ${row.model} |  |  |  |  |  | ${row.reason ?? 'failed'} |`)
      continue
    }
    const meanLatency = row.perImage?.length
      ? Math.round(row.perImage.reduce((sum, item) => sum + (item.ms ?? 0), 0) / row.perImage.length)
      : ''
    lines.push(`| ${row.model} | ${pct(row.precision)} | ${pct(row.recall)} | ${row.meanIoU ?? ''} | ${pct(row.labelAccuracy)} | ${meanLatency} ms | ${row.engine ?? ''} |`)
  }
  return `${lines.join('\n')}\n`
}

function pct(value) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : ''
}
