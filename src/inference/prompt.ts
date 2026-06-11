/**
 * Inference prompt template and response parser.
 *
 * The prompt is designed to elicit a strict JSON array from LFM2.5-VL
 * (or any capable VLM) with no surrounding prose.
 */

export const SPATIAL_DETECTION_PROMPT = `You are a spatial object detector. Analyze this image and respond with ONLY a JSON array. No other text. Format:
[{"label": "chair", "bbox": [x1,y1,x2,y2], "confidence": 0.92, "description": "wooden dining chair, brown"}]
Where bbox values are 0–1 normalised fractions of image width/height. List every distinct object you can see. Maximum 8 objects.`

export interface RawDetection {
  label: string
  bbox: [number, number, number, number]
  confidence: number
  description: string
}

const MAX_DETECTIONS = 8

export function parseDetections(text: string): RawDetection[] {
  // 1. Try to parse a well-formed JSON array
  const full = tryParseArray(text)
  if (full !== null && full.length > 0) {
    return normalizeDetections(full)
  }

  // 2. Salvage: model output may be truncated before the closing ']'
  //    Find the first '[' and the last complete '}', close the array there.
  const open = text.indexOf('[')
  const lastBrace = text.lastIndexOf('}')
  if (open !== -1 && lastBrace > open) {
    const truncated = text.slice(open, lastBrace + 1) + ']'
    const salvaged = tryParseArray(truncated)
    if (salvaged !== null && salvaged.length > 0) {
      return normalizeDetections(salvaged)
    }
  }

  return []
}

export function normalizeDetections(arr: unknown[]): RawDetection[] {
  const prepared = arr
    .map(coerceDetection)
    .filter((det): det is RawDetection => det !== null)
  return dedupeDetections(normalizeAllBboxes(prepared)).slice(0, MAX_DETECTIONS)
}

function tryParseArray(text: string): unknown[] | null {
  const match = text.match(/\[\s*\{[\s\S]*\}[\s,]*\]/)
  if (!match) return null
  try {
    const p = JSON.parse(match[0])
    if (Array.isArray(p)) return p
  } catch { /* fall through */ }
  try {
    const p = JSON.parse(match[0].replace(/,\s*([\]}])/g, '$1'))
    if (Array.isArray(p)) return p
  } catch { /* fall through */ }
  return null
}

/** Normalize bboxes that are in pixel-space (any value > 1) to 0–1. */
function normalizeAllBboxes(dets: RawDetection[]): RawDetection[] {
  if (dets.every((d) => d.bbox.every((v) => v <= 1.001))) {
    return dets.map((d) => ({ ...d, bbox: clampBbox(d.bbox) }))
  }
  const maxVal = dets.reduce((m, d) => Math.max(m, ...d.bbox), 0)
  if (maxVal <= 1) return dets.map((d) => ({ ...d, bbox: clampBbox(d.bbox) }))
  return dets.map((d) => ({
    ...d,
    bbox: clampBbox(d.bbox.map((v) => v / maxVal) as [number, number, number, number]),
  }))
}

function coerceDetection(item: unknown): RawDetection | null {
  if (typeof item !== 'object' || item === null) return null
  const d = item as Record<string, unknown>
  const label = typeof d['label'] === 'string' ? d['label'].trim().toLowerCase() : ''
  const bbox = Array.isArray(d['bbox']) ? d['bbox'].map((v) => Number(v)) : []
  if (!label || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) return null

  const parsedConfidence = Number(d['confidence'])
  let confidence = Number.isFinite(parsedConfidence) ? parsedConfidence : 0.8
  if (confidence > 1 && confidence <= 100) confidence /= 100
  confidence = Math.min(1, Math.max(0, confidence))

  const description = typeof d['description'] === 'string' && d['description'].trim()
    ? d['description'].trim()
    : `A ${label}`

  return {
    label,
    bbox: bbox as [number, number, number, number],
    confidence,
    description,
  }
}

function dedupeDetections(dets: RawDetection[]): RawDetection[] {
  const result: RawDetection[] = []
  for (const det of dets) {
    const existingIdx = result.findIndex((item) => isDuplicateDetection(item, det))
    if (existingIdx === -1) {
      result.push(det)
      continue
    }
    const existing = result[existingIdx]
    if (det.confidence > existing.confidence) {
      result[existingIdx] = det
    }
  }
  return result
}

function isDuplicateDetection(a: RawDetection, b: RawDetection): boolean {
  if (a.label !== b.label) return false
  if (bboxIou(a.bbox, b.bbox) >= 0.82) return true

  const ac = bboxCenter(a.bbox)
  const bc = bboxCenter(b.bbox)
  const centerDist = Math.hypot(ac.x - bc.x, ac.y - bc.y)
  const sizeDelta = Math.abs(bboxArea(a.bbox) - bboxArea(b.bbox))
  return centerDist <= 0.035 && sizeDelta <= 0.08
}

function bboxIou(a: RawDetection['bbox'], b: RawDetection['bbox']): number {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = bboxArea(a) + bboxArea(b) - intersection
  return union > 0 ? intersection / union : 0
}

function bboxArea(b: RawDetection['bbox']): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
}

function bboxCenter(b: RawDetection['bbox']): { x: number; y: number } {
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 }
}

function clampBbox(b: RawDetection['bbox']): RawDetection['bbox'] {
  const clamped = b.map((v) => Math.min(1, Math.max(0, v))) as RawDetection['bbox']
  const [x1, y1, x2, y2] = clamped
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ]
}
