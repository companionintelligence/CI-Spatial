#!/usr/bin/env node
/**
 * Detection regression gate — path-filter half. CI-executable with no
 * models: it only reads `git diff --name-only`, so it runs on every PR
 * regardless of Ollama/GPU availability — see the "hard constraint: CI has
 * no model" section of
 * docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md.
 *
 * If this change touches a detection input (scripts/lib/detection-gate.mjs's
 * TRIGGER_FILES) it must also update the committed real-corpus baseline
 * (test-data/real/baseline.json), so the model/prompt/capture change and its
 * measured effect land in the same diff, visible to a reviewer.
 *
 * The real corpus is a manual/physical fixture (0001-real-photograph-corpus)
 * and ships with 0 photographs as of this writing. Blocking every
 * detection-input change on a corpus nobody can populate from a repo
 * checkout would just get this gate disabled — the ticket's own named risk —
 * so until the corpus has at least one verified image, this check WARNS
 * instead of failing. Once it is populated, the same condition becomes a
 * hard failure automatically (no code change needed here).
 *
 *   node scripts/check-detection-gate.mjs
 *   BASE_REF=origin/main node scripts/check-detection-gate.mjs   # override the diff base
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_FILENAME, triggeredFiles } from './lib/detection-gate.mjs'
import { resolveCorpus } from './lib/cv-corpus.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tag = '[detection-gate]'

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function resolveBaseRef() {
  if (process.env.BASE_REF) return process.env.BASE_REF
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`
  return 'origin/main'
}

const baseRef = resolveBaseRef()

let mergeBase
try {
  mergeBase = git(['merge-base', baseRef, 'HEAD'])
} catch (err) {
  console.warn(`${tag} could not resolve a merge-base against ${baseRef} (${err.message.split('\n')[0]}) — skipping.`)
  console.warn(`${tag} This is expected on a push to main itself, or a shallow checkout with no shared history.`)
  process.exit(0)
}

const changed = git(['diff', '--name-only', mergeBase, 'HEAD']).split('\n').filter(Boolean)
const triggered = triggeredFiles(changed)

if (triggered.length === 0) {
  console.log(`${tag} no detection-input files changed vs ${baseRef} — gate not required`)
  process.exit(0)
}

console.log(`${tag} detection input(s) changed vs ${baseRef}: ${triggered.join(', ')}`)

const real = resolveCorpus(root, 'real')
const expected = existsSync(join(real.dir, 'expected.json'))
  ? JSON.parse(readFileSync(join(real.dir, 'expected.json'), 'utf8'))
  : []

if (expected.length === 0) {
  console.warn(`${tag} ⚠ the real corpus (${real.rel}) has 0 photographs — the manual/physical step in`)
  console.warn(`${tag} ⚠ docs/factory/06-detection-ground-truth/0001-real-photograph-corpus.md hasn't landed yet,`)
  console.warn(`${tag} ⚠ so this change's effect on detection quality is UNVERIFIED. Not blocking this PR — see`)
  console.warn(`${tag} ⚠ that ticket. Once the corpus is populated, this same condition becomes a hard failure.`)
  process.exit(0)
}

const baselinePath = join(real.dir, BASELINE_FILENAME)
const baselineChanged = changed.map((f) => resolve(root, f)).includes(resolve(baselinePath))

if (!existsSync(baselinePath) || !baselineChanged) {
  console.error(`${tag} ✗ detection input(s) changed (${triggered.join(', ')}) but ${real.rel}/${BASELINE_FILENAME} was not`)
  console.error(`${tag} ✗ updated in this change. Run locally:`)
  console.error(`${tag} ✗   CV_CORPUS=real STRICT=1 npm run eval:cv`)
  console.error(`${tag} ✗   npm run accept:detection-baseline`)
  console.error(`${tag} ✗ then commit the refreshed ${real.rel}/${BASELINE_FILENAME} alongside this change.`)
  process.exit(1)
}

console.log(`${tag} ✓ ${real.rel}/${BASELINE_FILENAME} was updated alongside the detection-input change — the score`)
console.log(`${tag} ✓ move is visible in this diff for review.`)
