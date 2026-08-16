/**
 * Shared prompt + parser for the Deno inference server.
 * Must stay in sync with src/inference/prompt.ts (same logic, Deno pathing).
 */

export const SPATIAL_DETECTION_PROMPT = `Look at this image and list up to 8 distinct visible objects as a JSON array, most prominent object first. Output ONLY the JSON array, no other text.
Each item must have exactly these four keys: "label", "bbox", "confidence", "description".
WRONG: {"box_2d": [239, 221, 675, 781], ...} - never output the key "box_2d" or 0-1000 coordinates.
RIGHT: {"label": "potted plant", "bbox": [0.22, 0.24, 0.78, 0.68], "confidence": 0.92, "description": "small fern, white pot"}
"bbox" is [x_min, y_min, x_max, y_max] as decimal fractions 0-1 of image width and height.
"label" is the single most specific singular noun for the object (sofa, chair, table, desk, tv, monitor, lamp, plant, bed, shelf, cabinet, door, window, rug, sink, counter, picture, pillow, tree, bush, ...). Repeat a label only for separate objects of the same kind. Keep "description" under 7 words.`

export interface RawDetection {
  label: string
  /** Normalised [x1,y1,x2,y2] bounding box from VLM inference */
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
  // Drop boxes that are degenerate (zero width/height) after clamping —
  // they would produce useless or NaN placements downstream.
  const clamped = normalizeAllBboxes(prepared).filter(hasPositiveArea)
  return dedupeDetections(clamped).slice(0, MAX_DETECTIONS)
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

/** True when the (already clamped) bbox has x2 > x1 and y2 > y1. */
function hasPositiveArea(det: RawDetection): boolean {
  const [x1, y1, x2, y2] = det.bbox
  return x2 > x1 && y2 > y1
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
