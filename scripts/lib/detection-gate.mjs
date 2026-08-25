/**
 * Shared constants and pure logic for the detection regression gate — see
 * docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md.
 *
 * Two things live here, reused by more than one script (scripts/eval-cv.mjs,
 * scripts/check-detection-gate.mjs, scripts/accept-detection-baseline.mjs,
 * and tests/unit/node/detection_gate.test.ts), per ADR 0001 — one definition,
 * not a copy in each caller:
 *
 *   - TRIGGER_FILES: the inputs that determine detection quality, and
 *     nothing else. A change to one of these requires a fresh real-corpus
 *     run before merge — see the ticket's "What triggers the gate" table.
 *     Deliberately narrow: gating everything would get the gate disabled
 *     within a week (the ticket's central risk).
 *   - compareToBaseline(): "not worse than the committed baseline, within
 *     tolerance" — never an absolute bar (ticket Non-goals: "Do not gate on
 *     an absolute score").
 */

/**
 * Repo-root-relative paths (forward-slash, matching `git diff --name-only`)
 * whose change requires a fresh real-corpus run. Source-mapped against
 * current file locations post the server/ reorg (#155/#156/#158/#160) — the
 * ticket cites pre-reorg line numbers in root-level inference.ts.
 */
export const TRIGGER_FILES = [
  'server/inference.ts', // default model resolution, Ollama request options (num_ctx, temperature)
  'server/prompt.ts', // detection prompt + parser — the Deno server's copy
  'src/inference/prompt.ts', // detection prompt + parser — the browser copy; sync.test.ts keeps the two identical
  'src/shared/model-catalog.ts', // DEFAULT_MODEL_TAG — the production default model
  'src/shared/ollama-model.ts', // KNOWN_VISION_MODELS — the silent-fallback list a missing model resolves through
  'src/capture/capture.ts', // capture encoding (long-edge px, JPEG quality) the corpus images must match
]

/** Committed score artefact the real corpus is judged against — same shape as report.json, checked into git. */
export const BASELINE_FILENAME = 'baseline.json'

/**
 * Regression tolerance for comparing a fresh real-corpus run against the
 * committed baseline. Provisional — see
 * docs/factory/06-detection-ground-truth/0003-detection-regression-gate.md,
 * Subtask 2 and "Manual step remaining". A real number needs several runs of
 * the same model against a *populated* test-data/real/ corpus; that corpus
 * has 0 photographs as of this writing (0001's manual step is not done), so
 * no such measurement exists yet. This value is a deliberately tight
 * placeholder: tight means it produces false positives (a good change flagged
 * for a rerun) before it produces false negatives (a real regression missed),
 * and a false positive here costs a rerun, not a silent miss. Replace it,
 * citing the measurement, once the corpus is populated.
 */
export const BASELINE_TOLERANCE = { precision: 0.05, recall: 0.05, meanIoU: 0.05 }

/**
 * Which of a fresh run's metrics fell below the committed baseline by more
 * than `tolerance` allows. Returns an empty array on pass. Compares
 * precision/recall/meanIoU only — the same three metrics eval-cv.mjs's
 * pre-existing STRICT_THRESHOLDS gates on; labelAccuracy and per-image detail
 * remain informative, not gated.
 *
 * @param {{precision:number, recall:number, meanIoU:number}} current
 * @param {{precision:number, recall:number, meanIoU:number}} baseline
 * @param {{precision:number, recall:number, meanIoU:number}} [tolerance]
 */
export function compareToBaseline(current, baseline, tolerance = BASELINE_TOLERANCE) {
  const regressions = []
  for (const metric of /** @type {const} */ (['precision', 'recall', 'meanIoU'])) {
    const b = baseline?.[metric]
    const c = current?.[metric]
    if (typeof b !== 'number' || typeof c !== 'number') continue
    const drop = b - c
    if (drop > (tolerance[metric] ?? 0)) {
      regressions.push({ metric, baseline: b, current: c, drop: +drop.toFixed(4) })
    }
  }
  return regressions
}

/** Subset of `changedFiles` (as from `git diff --name-only`) that are detection inputs. */
export function triggeredFiles(changedFiles) {
  const set = new Set(TRIGGER_FILES)
  return changedFiles.filter((f) => set.has(f))
}
