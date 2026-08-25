/**
 * CV model evaluation harness — scores /infer against ground truth for a
 * chosen corpus (scripts/lib/cv-corpus.mjs resolves CV_CORPUS).
 *
 *   node scripts/eval-cv.mjs                       # server :8000, CV_CORPUS=real (default)
 *   CV_CORPUS=synthetic node scripts/eval-cv.mjs    # mock-engine regression fixture
 *   SERVER_URL=http://localhost:8098 node scripts/eval-cv.mjs
 *   STRICT=1 node scripts/eval-cv.mjs               # exit 1 below thresholds
 *
 * Two corpora, two different jobs — see docs/factory/06-detection-ground-truth/:
 *   - CV_CORPUS=real (default) -> test-data/real/ — real photographs with
 *     human-verified ground truth (0001-real-photograph-corpus.md). The only
 *     corpus that can tell a working vision model from a fabricating one;
 *     this is what model selection (npm run bench:models) should use.
 *   - CV_CORPUS=synthetic -> test-data/cv/ — furniture drawn as palette-
 *     coloured rectangles (generate-cv-images.mjs / npm run gen:test-data).
 *     A deterministic pipeline-regression fixture for the *mock* engine
 *     only — the mock engine matches colour to label and scores ~1.0 here.
 *     A real vision model is out of distribution against this corpus and is
 *     expected to score ~0%; this script warns loudly when that happens so
 *     the number isn't mistaken for a verdict on the model.
 *
 * Metrics: greedy IoU matching per image (same-label first), then
 *   precision, recall, mean IoU of matches, label accuracy.
 * Writes <corpus dir>/report.json, beside whichever corpus ran.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCorpus } from './lib/cv-corpus.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = process.env.SERVER_URL ?? 'http://localhost:8000'
const STRICT = process.env.STRICT === '1'
const MATCH_IOU = 0.5
const STRICT_THRESHOLDS = { precision: 0.9, recall: 0.9, meanIoU: 0.75 }

const corpus = resolveCorpus(root, process.env.CV_CORPUS ?? 'real')
const cvDir = corpus.dir
const tag = `[eval-cv:${corpus.label}]`

if (!existsSync(join(cvDir, 'expected.json'))) {
  console.error(`${tag} ${corpus.missingHelp(corpus.rel)}`)
  process.exit(1)
}
const expected = JSON.parse(readFileSync(join(cvDir, 'expected.json'), 'utf8'))
if (expected.length === 0) {
  console.error(`${tag} ${corpus.emptyHelp(corpus.rel)}`)
  process.exit(1)
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return inter / (areaA + areaB - inter || 1)
}

const health = await fetch(`${SERVER}/health`).then((r) => r.json()).catch(() => null)
if (!health) {
  console.error(`${tag} server unreachable at ${SERVER} — start it with npm run server`)
  process.exit(1)
}
console.log(`${tag} engine: ${health.model} @ ${SERVER}`)
console.log(`${tag} corpus: ${corpus.rel} (${expected.length} images)`)

// The synthetic corpus is colour rectangles, not photographs — a real vision
// model is out of distribution against it and expected to score ~0%. Warn
// loudly rather than let that number pass as a verdict on the model.
const isMockEngine = health.model.startsWith('mock/')
const outOfDistribution = corpus.label === 'synthetic' && !isMockEngine
if (outOfDistribution) {
  console.warn(`${tag} ⚠ scoring a real vision model (${health.model}) against the SYNTHETIC corpus.`)
  console.warn(`${tag} ⚠ That corpus is palette-coloured rectangles, not photographs — a working model`)
  console.warn(`${tag} ⚠ is expected to score near 0% here. This is NOT a verdict on the model.`)
  console.warn(`${tag} ⚠ Use CV_CORPUS=real (the default) to actually rank vision models.`)
}
console.log('')

let tp = 0
let fp = 0
let fn = 0
let labelHits = 0
let iouSum = 0
const perImage = []

for (const entry of expected) {
  const bytes = readFileSync(join(cvDir, entry.file))
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), entry.file)
  const t0 = Date.now()
  const resp = await fetch(`${SERVER}/infer`, { method: 'POST', body: form })
  const ms = Date.now() - t0
  if (!resp.ok) {
    console.error(`  ✗ ${entry.file}: /infer → HTTP ${resp.status}`)
    fn += entry.detections.length
    perImage.push({ file: entry.file, error: `HTTP ${resp.status}` })
    continue
  }
  const predicted = await resp.json()

  // Greedy matching: highest IoU pair first; same-label pairs win ties
  const pairs = []
  predicted.forEach((p, pi) => {
    entry.detections.forEach((g, gi) => {
      const overlap = iou(p.bbox, g.bbox)
      if (overlap >= MATCH_IOU) pairs.push({ pi, gi, overlap, labelMatch: p.label === g.label })
    })
  })
  pairs.sort((a, b) => (b.labelMatch - a.labelMatch) || (b.overlap - a.overlap))
  const usedP = new Set()
  const usedG = new Set()
  let matched = 0
  let labelsOk = 0
  let imgIoU = 0
  for (const pair of pairs) {
    if (usedP.has(pair.pi) || usedG.has(pair.gi)) continue
    usedP.add(pair.pi)
    usedG.add(pair.gi)
    matched++
    imgIoU += pair.overlap
    if (pair.labelMatch) labelsOk++
  }

  tp += matched
  fp += predicted.length - matched
  fn += entry.detections.length - matched
  labelHits += labelsOk
  iouSum += imgIoU

  const flag = matched === entry.detections.length && predicted.length === matched ? '✓' : '~'
  console.log(`  ${flag} ${entry.file}: ${matched}/${entry.detections.length} matched, ${predicted.length} predicted (${ms}ms)`)
  perImage.push({
    file: entry.file,
    groundTruth: entry.detections.length,
    predicted: predicted.length,
    matched,
    labelsCorrect: labelsOk,
    meanIoU: matched ? +(imgIoU / matched).toFixed(4) : 0,
    ms,
  })
}

const precision = tp / (tp + fp || 1)
const recall = tp / (tp + fn || 1)
const meanIoU = tp ? iouSum / tp : 0
const labelAccuracy = tp ? labelHits / tp : 0

const report = {
  corpus: corpus.label,
  corpusDir: corpus.rel,
  engine: health.model,
  evaluatedAt: new Date().toISOString(),
  images: expected.length,
  matchIoUThreshold: MATCH_IOU,
  precision: +precision.toFixed(4),
  recall: +recall.toFixed(4),
  meanIoU: +meanIoU.toFixed(4),
  labelAccuracy: +labelAccuracy.toFixed(4),
  ...(outOfDistribution && {
    outOfDistributionWarning:
      'Scored against the synthetic corpus with a non-mock engine. That corpus is palette-' +
      'coloured rectangles, not photographs — a real vision model is expected to score near ' +
      '0% here. This result is NOT a verdict on the model; use CV_CORPUS=real to rank models.',
  }),
  perImage,
}
writeFileSync(join(cvDir, 'report.json'), JSON.stringify(report, null, 2))

console.log(`\n${tag} precision ${(precision * 100).toFixed(1)}%  recall ${(recall * 100).toFixed(1)}%  ` +
  `meanIoU ${meanIoU.toFixed(3)}  labelAcc ${(labelAccuracy * 100).toFixed(1)}%`)
console.log(`${tag} report → ${corpus.rel}/report.json`)
if (outOfDistribution) {
  console.warn(`${tag} ⚠ the result above is NOT meaningful — see the warning above. It does not ` +
    `reflect ${health.model}'s real quality. Use CV_CORPUS=real to rank vision models.`)
}

if (STRICT && (precision < STRICT_THRESHOLDS.precision || recall < STRICT_THRESHOLDS.recall || meanIoU < STRICT_THRESHOLDS.meanIoU)) {
  console.error(`${tag} FAIL — below strict thresholds ${JSON.stringify(STRICT_THRESHOLDS)}`)
  process.exit(1)
}
