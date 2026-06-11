/**
 * CV model system tests — runs the generated test images through /infer and
 * scores the result against ground truth.  Designed for the mock colour-blob
 * engine (deterministic), so this is a hard regression gate on the whole
 * image → detection path: multipart handling, JPEG decode, bbox
 * normalisation, response shape.
 *
 *   npm run gen:test-data                              # once
 *   INFERENCE_MODE=mock npm run server                 # test server
 *   API_URL=http://localhost:8000 npx playwright test --project=api
 *
 * Against a real VLM (ollama/onnx) the IoU assertions are relaxed — use
 * scripts/eval-cv.mjs for the full scored report instead.
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const API = process.env['API_URL'] ?? 'http://localhost:8000'
const CV_DIR = join(process.cwd(), 'test-data', 'cv')

interface GroundTruth {
  file: string
  detections: Array<{ label: string; bbox: [number, number, number, number] }>
}

const cvAvailable = existsSync(join(CV_DIR, 'expected.json'))

function iou(a: number[], b: number[]): number {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return inter / (areaA + areaB - inter || 1)
}

test.describe('CV inference against generated ground truth', () => {
  test.skip(!cvAvailable, 'test-data missing — run: npm run gen:test-data')
  test.setTimeout(120_000)

  let isMockEngine = false

  test.beforeAll(async ({ request }) => {
    const health = await (await request.get(`${API}/health`)).json() as { model: string }
    isMockEngine = health.model.startsWith('mock/')
  })

  test('detections are returned with valid shape for every image', async ({ request }) => {
    const expected = JSON.parse(readFileSync(join(CV_DIR, 'expected.json'), 'utf8')) as GroundTruth[]
    expect(expected.length).toBeGreaterThanOrEqual(12)

    for (const entry of expected.slice(0, 6)) {
      const resp = await request.post(`${API}/infer`, {
        multipart: {
          image: { name: entry.file, mimeType: 'image/jpeg', buffer: readFileSync(join(CV_DIR, entry.file)) },
        },
      })
      expect(resp.ok(), `/infer for ${entry.file}`).toBeTruthy()
      const detections = await resp.json() as Array<{ label: string; confidence: number; bbox: number[] }>
      expect(Array.isArray(detections)).toBe(true)
      for (const det of detections) {
        expect(typeof det.label).toBe('string')
        expect(det.confidence).toBeGreaterThan(0)
        expect(det.confidence).toBeLessThanOrEqual(1)
        expect(det.bbox).toHaveLength(4)
        const [x1, y1, x2, y2] = det.bbox
        expect(x1).toBeGreaterThanOrEqual(0)
        expect(y2).toBeLessThanOrEqual(1.0001)
        expect(x2).toBeGreaterThan(x1)
        expect(y2).toBeGreaterThan(y1)
      }
    }
  })

  test('mock engine matches ground truth (IoU ≥ 0.8, exact labels)', async ({ request }) => {
    test.skip(!isMockEngine, 'requires INFERENCE_MODE=mock')
    const expected = JSON.parse(readFileSync(join(CV_DIR, 'expected.json'), 'utf8')) as GroundTruth[]

    for (const entry of expected) {
      const resp = await request.post(`${API}/infer`, {
        multipart: {
          image: { name: entry.file, mimeType: 'image/jpeg', buffer: readFileSync(join(CV_DIR, entry.file)) },
        },
      })
      const detections = await resp.json() as Array<{ label: string; bbox: number[] }>
      expect(detections.length, `${entry.file}: detection count`).toBe(entry.detections.length)

      for (const truth of entry.detections) {
        const match = detections.find((d) => d.label === truth.label && iou(d.bbox, truth.bbox) >= 0.8)
        expect(match, `${entry.file}: ${truth.label} @ IoU≥0.8`).toBeTruthy()
      }
    }
  })

  test('inference is deterministic on the mock engine', async ({ request }) => {
    test.skip(!isMockEngine, 'requires INFERENCE_MODE=mock')
    const expected = JSON.parse(readFileSync(join(CV_DIR, 'expected.json'), 'utf8')) as GroundTruth[]
    const image = readFileSync(join(CV_DIR, expected[0].file))

    const results: string[] = []
    for (let i = 0; i < 3; i++) {
      const resp = await request.post(`${API}/infer`, {
        multipart: { image: { name: 'same.jpg', mimeType: 'image/jpeg', buffer: image } },
      })
      results.push(JSON.stringify(await resp.json()))
    }
    expect(results[1]).toBe(results[0])
    expect(results[2]).toBe(results[0])
  })
})
