#!/usr/bin/env node
/**
 * setup-models.mjs — show the recommended Ollama vision-model catalog
 * (src/shared/model-catalog.ts) and let the user pull the ones they want.
 *
 *   npm run setup:models
 *   SETUP_MODELS=qwen3-vl:8b,gemma4:26b npm run setup:models   # non-interactive
 *   SETUP_MODELS=all npm run setup:models                       # every catalog tag not yet local
 *   SETUP_MODELS_DRY_RUN=1 npm run setup:models                 # print the plan, pull nothing
 *
 * Reuses bench-models.mjs's /api/tags + `ollama pull` pattern rather than a
 * second implementation — this script's job is picking + installing, not
 * benchmarking (see `npm run bench:models` for that).
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { DEFAULT_MODEL_TAG, formatCatalogTable, MODEL_CATALOG } from '../src/shared/model-catalog.ts'
import { normalizeOllamaHost } from '../src/shared/ollama-host.ts'

const OLLAMA = normalizeOllamaHost(process.env.OLLAMA_HOST)
const DRY_RUN = process.env.SETUP_MODELS_DRY_RUN === '1'

/** Live check against the Ollama store — same :latest-equivalence rule as bench-models.mjs:78. */
async function fetchInstalled() {
  let tags
  try {
    const resp = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    tags = (await resp.json()).models?.map((m) => m.name) ?? []
  } catch (err) {
    console.error(`[setup-models] Ollama unreachable at ${OLLAMA} (${err.message})`)
    console.error('[setup-models] Start Ollama first, then re-run this script.')
    process.exit(1)
  }
  return new Set(
    MODEL_CATALOG
      .filter((m) => tags.includes(m.tag) || tags.includes(`${m.tag}:latest`))
      .map((m) => m.tag),
  )
}

/** Accepts catalog numbers, exact tags, or 'all' — comma-separated. */
function parseSelection(input) {
  const trimmed = input.trim()
  if (!trimmed) return []
  if (trimmed.toLowerCase() === 'all') return MODEL_CATALOG.map((m) => m.tag)

  const byIndex = new Map(MODEL_CATALOG.map((m, i) => [String(i + 1), m.tag]))
  const tags = new Set()
  for (const token of trimmed.split(',').map((t) => t.trim()).filter(Boolean)) {
    if (byIndex.has(token)) { tags.add(byIndex.get(token)); continue }
    const match = MODEL_CATALOG.find((m) => m.tag === token)
    if (match) { tags.add(match.tag); continue }
    console.warn(`[setup-models] "${token}" doesn't match a catalog number or tag — skipping`)
  }
  return [...tags]
}

async function main() {
  const installed = await fetchInstalled()
  console.log(formatCatalogTable({ installed }))
  console.log('')
  console.log(`Default (used when OLLAMA_MODEL is unset): ${DEFAULT_MODEL_TAG}`)
  console.log('')

  let selection
  if (process.env.SETUP_MODELS !== undefined) {
    selection = parseSelection(process.env.SETUP_MODELS)
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(
      'Enter numbers to install (comma-separated), "all", or press Enter to skip: ',
    )
    rl.close()
    selection = parseSelection(answer)
  }

  const toPull = selection.filter((tag) => !installed.has(tag))
  const alreadyHad = selection.filter((tag) => installed.has(tag))
  if (alreadyHad.length) {
    console.log(`[setup-models] already installed, skipping: ${alreadyHad.join(', ')}`)
  }

  if (!toPull.length) {
    console.log('[setup-models] nothing to install.')
  } else {
    for (const tag of toPull) {
      if (DRY_RUN) {
        console.log(`[setup-models] [dry-run] would pull ${tag}`)
        continue
      }
      console.log(`[setup-models] pulling ${tag} (this can take minutes)…`)
      const pull = spawnSync('ollama', ['pull', tag], { stdio: 'inherit' })
      if (pull.status !== 0) {
        console.warn(`[setup-models] ollama pull ${tag} exited ${pull.status ?? pull.error?.message} — continuing`)
      }
    }
  }

  const nowAvailable = DRY_RUN ? [...installed] : [...installed, ...toPull]
  console.log('')
  console.log('To use one of these models, set it before starting the server:')
  console.log('')
  console.log(`  export OLLAMA_MODEL=<tag>   # e.g. export OLLAMA_MODEL=${nowAvailable[0] ?? DEFAULT_MODEL_TAG}`)
  console.log('')
  console.log("This repo doesn't auto-load .env — persist it in your shell profile, or for a")
  console.log('deployed box, in ~/.config/cscan/env (see ../docs/operations/DEPLOY.md).')
}

await main()
