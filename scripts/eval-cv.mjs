/**
 * CV model evaluation harness — scores /infer against the generated ground
 * truth (test-data/cv/expected.json).
 *
 *   node scripts/eval-cv.mjs                       # server at :8000
 *   SERVER_URL=http://localhost:8098 node scripts/eval-cv.mjs
 *   STRICT=1 node scripts/eval-cv.mjs              # exit 1 below thresholds
 *
 * Works against any engine (mock / ollama / onnx) — the mock engine should
 * score ≈1.0 and acts as the pipeline regression baseline; real VLMs get an
 * honest precision/recall/IoU report on the same fixed corpus.
 *
 * Metrics: greedy IoU matching per image (same-label first), then
 *   precision, recall, mean IoU of matches, label accuracy.
 * Writes test-data/cv/report.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cvDir = join(root, 'test-data', 'cv')
const SERVER = process.env.SERVER_URL ?? 'http://localhost:8000'
const STRICT = process.env.STRICT === '1'
const MATCH_IOU = 0.5
const STRICT_THRESHOLDS = { precision: 0.9, recall: 0.9, meanIoU: 0.75 }

if (!existsSync(join(cvDir, 'expected.json'))) {
  console.error('[eval-cv] test-data/cv/expected.json missing — run: npm run gen:test-data')
  process.exit(1)
}
const expected = JSON.parse(readFileSync(join(cvDir, 'expected.json'), 'utf8'))

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
  console.error(`[eval-cv] server unreachable at ${SERVER} — start it with npm run server`)
  process.exit(1)
}
console.log(`[eval-cv] engine: ${health.model} @ ${SERVER}\n`)

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
  engine: health.model,
  evaluatedAt: new Date().toISOString(),
  images: expected.length,
  matchIoUThreshold: MATCH_IOU,
  precision: +precision.toFixed(4),
  recall: +recall.toFixed(4),
  meanIoU: +meanIoU.toFixed(4),
  labelAccuracy: +labelAccuracy.toFixed(4),
  perImage,
}
writeFileSync(join(cvDir, 'report.json'), JSON.stringify(report, null, 2))

console.log(`\n[eval-cv] precision ${(precision * 100).toFixed(1)}%  recall ${(recall * 100).toFixed(1)}%  ` +
  `meanIoU ${meanIoU.toFixed(3)}  labelAcc ${(labelAccuracy * 100).toFixed(1)}%`)
console.log(`[eval-cv] report → test-data/cv/report.json`)

if (STRICT && (precision < STRICT_THRESHOLDS.precision || recall < STRICT_THRESHOLDS.recall || meanIoU < STRICT_THRESHOLDS.meanIoU)) {
  console.error(`[eval-cv] FAIL — below strict thresholds ${JSON.stringify(STRICT_THRESHOLDS)}`)
  process.exit(1)
}
