/**
 * scripts/lib/detection-gate.mjs — the comparison and path-filter logic
 * behind the detection regression gate
 * (docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md).
 *
 * Ticket 0003's own acceptance test asks for a *live* run — set
 * OLLAMA_MODEL=moondream:latest and confirm the gate catches the wave 04
 * defect on the real corpus. That corpus (test-data/real/) has 0
 * photographs as of this writing (0001's manual/physical step — a real
 * camera, real staged objects, a human writing ground truth — is not done),
 * so no live run of the real corpus is possible from a repo checkout. See
 * this ticket's "Manual step remaining" for what's outstanding and why.
 *
 * What CAN be verified without a model or photographs is the gate's own
 * comparison logic: given report.json-shaped numbers matching the actual
 * wave 04 shape (a working model's baseline vs. moondream's measured
 * near-zero scores, both cited in the wave 06 README), does
 * compareToBaseline() flag it? That is what this file checks. It is a
 * mechanism-level substitute for the live test, not the live test itself —
 * re-run the real acceptance test once the corpus is populated.
 *
 * Run: npm run test:detection-gate
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASELINE_TOLERANCE, compareToBaseline, triggeredFiles, TRIGGER_FILES } from '../../../scripts/lib/detection-gate.mjs'

// Representative, not measured: a plausible working-model baseline. The
// wave 06 README's own measurement (a driver correctly naming five objects
// on a real photograph) establishes that a working model scores well above
// the near-zero floor documented for moondream below — this baseline is
// shaped like that outcome without claiming to be the eventual real number.
const GOOD_BASELINE = {
  corpus: 'real',
  engine: 'ollama/qwen3-vl:4b',
  evaluatedAt: '2026-08-24T00:00:00.000Z',
  images: 40,
  precision: 0.86,
  recall: 0.81,
  meanIoU: 0.68,
  labelAccuracy: 0.9,
}

test('compareToBaseline catches the wave 04 shape: a fabricating model scoring near zero', () => {
  // moondream:latest's measured behavior per the wave 06 README and wave 04
  // ticket 0001: it scores ~0% against a corpus a working model handles —
  // the exact "both score 0%, the harness cannot tell them apart" failure
  // this wave exists to fix. Modeled here, not re-measured, because the
  // corpus that would produce this number for real is unpopulated.
  const moondreamRun = { precision: 0.02, recall: 0.01, meanIoU: 0.03 }
  const regressions = compareToBaseline(moondreamRun, GOOD_BASELINE)
  assert.ok(regressions.length > 0, 'expected the moondream-shaped run to be flagged')
  const metrics = regressions.map((r) => r.metric).sort()
  assert.deepEqual(metrics, ['meanIoU', 'precision', 'recall'])
  for (const r of regressions) {
    assert.ok(r.drop > BASELINE_TOLERANCE[r.metric], `${r.metric} drop should exceed tolerance`)
  }
})

test('compareToBaseline passes a run within tolerance of the baseline', () => {
  const withinTolerance = {
    precision: GOOD_BASELINE.precision - 0.02,
    recall: GOOD_BASELINE.recall - 0.01,
    meanIoU: GOOD_BASELINE.meanIoU,
  }
  assert.deepEqual(compareToBaseline(withinTolerance, GOOD_BASELINE), [])
})

test('compareToBaseline does not flag an improvement', () => {
  const better = { precision: 0.95, recall: 0.9, meanIoU: 0.8 }
  assert.deepEqual(compareToBaseline(better, GOOD_BASELINE), [])
})

test('compareToBaseline flags exactly the metrics that regress beyond tolerance, not all three', () => {
  const partial = {
    precision: GOOD_BASELINE.precision, // unchanged
    recall: GOOD_BASELINE.recall - 0.5, // regressed hard
    meanIoU: GOOD_BASELINE.meanIoU, // unchanged
  }
  const regressions = compareToBaseline(partial, GOOD_BASELINE)
  assert.deepEqual(regressions.map((r) => r.metric), ['recall'])
})

test('compareToBaseline ignores non-numeric fields rather than throwing', () => {
  assert.deepEqual(compareToBaseline({}, GOOD_BASELINE), [])
  assert.deepEqual(compareToBaseline(GOOD_BASELINE, {}), [])
})

test('triggeredFiles matches only the files in TRIGGER_FILES', () => {
  const changed = ['README.md', 'server/inference.ts', 'src/world/types.ts', 'src/shared/model-catalog.ts']
  assert.deepEqual(triggeredFiles(changed).sort(), ['server/inference.ts', 'src/shared/model-catalog.ts'])
})

test('triggeredFiles returns empty for an unrelated change', () => {
  assert.deepEqual(triggeredFiles(['README.md', 'src/world/types.ts', 'docs/adr/0001-reuse-existing-domain-model.md']), [])
})

test('every TRIGGER_FILES entry names a file that exists in the repo', async () => {
  const { existsSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  for (const f of TRIGGER_FILES) {
    assert.ok(existsSync(join(root, f)), `${f} should exist — a stale path here silently disables the gate for that input`)
  }
})
