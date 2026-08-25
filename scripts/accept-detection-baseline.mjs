#!/usr/bin/env node
/**
 * Promotes a fresh scripts/eval-cv.mjs run's report.json to the committed
 * baseline the detection regression gate compares against — see
 * docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md.
 *
 * Only ever operates on the *real* corpus. The synthetic corpus is
 * gitignored (npm run gen:test-data regenerates it) and gates on
 * eval-cv.mjs's fixed STRICT_THRESHOLDS against the deterministic mock
 * engine, not a committed baseline — there is nothing to promote there.
 *
 *   CV_CORPUS=real STRICT=1 npm run eval:cv   # produces test-data/real/report.json
 *   npm run accept:detection-baseline         # promotes it to baseline.json
 *
 * report.json already carries provenance (`engine`, `evaluatedAt`, `corpus`,
 * `images`) — baseline.json is a verbatim copy, so no new schema is needed
 * (ADR 0001: reuse the shape).
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCorpus } from './lib/cv-corpus.mjs'
import { BASELINE_FILENAME } from './lib/detection-gate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tag = '[accept-baseline]'
const real = resolveCorpus(root, 'real')
const reportPath = join(real.dir, 'report.json')
const baselinePath = join(real.dir, BASELINE_FILENAME)

if (!existsSync(reportPath)) {
  console.error(`${tag} ${real.rel}/report.json missing — run: CV_CORPUS=real npm run eval:cv first`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
if (report.corpus !== 'real') {
  console.error(`${tag} ${real.rel}/report.json was scored against corpus "${report.corpus}", not "real" —`)
  console.error(`${tag} refusing to promote it as the real-corpus baseline. Run with CV_CORPUS=real.`)
  process.exit(1)
}

const previous = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
copyFileSync(reportPath, baselinePath)

console.log(`${tag} ${real.rel}/${BASELINE_FILENAME} <- ${report.engine} @ ${report.evaluatedAt} (${report.images} images)`)
if (previous) {
  console.log(`${tag} previous baseline: ${previous.engine} @ ${previous.evaluatedAt}`)
  for (const m of ['precision', 'recall', 'meanIoU', 'labelAccuracy']) {
    const before = previous[m]
    const after = report[m]
    if (typeof before !== 'number' || typeof after !== 'number') continue
    const delta = after - before
    console.log(`${tag}   ${m}: ${before} -> ${after} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})`)
  }
  console.log(`${tag} review that diff before committing — a lower score here is exactly what the gate exists to surface.`)
} else {
  console.log(`${tag} no previous baseline — this is the first committed real-corpus score.`)
}
console.log(`${tag} commit ${real.rel}/${BASELINE_FILENAME} alongside your change.`)
