/**
 * Resolves which CV eval fixture ("corpus") a run should score against.
 * Shared by scripts/eval-cv.mjs and scripts/bench-models.mjs so CV_CORPUS is
 * interpreted identically by both — see
 * docs/factory/06-detection-ground-truth/0002-retarget-eval-and-bench.md.
 *
 * Two named corpora, two different jobs:
 *   - "real"      -> test-data/real/ — human-verified real photographs
 *                    (0001-real-photograph-corpus.md). The only corpus that
 *                    can tell a working vision model from a fabricating one.
 *   - "synthetic" -> test-data/cv/ — palette-coloured rectangles generated
 *                    by generate-cv-images.mjs (npm run gen:test-data). A
 *                    deterministic regression fixture for the *mock* engine
 *                    only; no photo-trained model can score meaningfully
 *                    here.
 * Anything else is treated as a literal directory path relative to the repo
 * root, so a one-off or future corpus can be pointed at without a code
 * change — same shape (expected.json + images), no new config format.
 */
import { join, relative } from 'node:path'

export const NAMED_CORPORA = {
  real: {
    parts: ['test-data', 'real'],
    missingHelp: (rel) =>
      `${rel}/expected.json missing — see docs/factory/06-detection-ground-truth/` +
      `0001-real-photograph-corpus.md to build the real corpus, or set CV_CORPUS=synthetic ` +
      `for the mock-engine regression fixture.`,
    emptyHelp: (rel) =>
      `${rel}/expected.json has 0 images — the real-photograph corpus is scaffolded but no ` +
      `photographs have been taken yet (a physical/human step). See ${rel}/README.md's ` +
      `"Manual step remaining" and docs/factory/06-detection-ground-truth/` +
      `0001-real-photograph-corpus.md. Set CV_CORPUS=synthetic for the mock-engine ` +
      `regression fixture in the meantime.`,
  },
  synthetic: {
    parts: ['test-data', 'cv'],
    missingHelp: () => `expected.json missing — run: npm run gen:test-data`,
    emptyHelp: () => `expected.json has 0 images — regenerate: npm run gen:test-data`,
  },
}

/**
 * @param {string} root repo root (absolute)
 * @param {string} name CV_CORPUS value: "real", "synthetic", or a path
 */
export function resolveCorpus(root, name) {
  const named = NAMED_CORPORA[name]
  const dir = named ? join(root, ...named.parts) : join(root, name)
  return {
    label: name,
    dir,
    rel: relative(root, dir) || '.',
    missingHelp: named ? named.missingHelp : (rel) => `${rel}/expected.json missing`,
    emptyHelp: named ? named.emptyHelp : (rel) => `${rel}/expected.json has 0 images`,
  }
}
