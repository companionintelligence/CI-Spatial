/**
 * Shared prompt + parser for the Deno inference server.
 * Must stay in sync with src/inference/prompt.ts (same logic, Deno pathing).
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

function prepareDetections(arr: unknown[]): unknown[] {
  return arr.map((item) => {
    if (typeof item === 'object' && item !== null) {
      const d = item as Record<string, unknown>
      if (typeof d['description'] !== 'string') {
        d['description'] = typeof d['label'] === 'string' ? `A ${d['label']}` : 'unknown'
      }
      if (typeof d['confidence'] !== 'number') {
        const parsed = parseFloat(String(d['confidence']))
        d['confidence'] = isNaN(parsed) ? 0.8 : parsed
      }
    }
    return item
  })
}

export function parseDetections(text: string): RawDetection[] {
  // 1. Try to parse a well-formed JSON array
  const full = tryParseArray(text)
  if (full !== null && full.length > 0) {
    return normalizeAllBboxes(prepareDetections(full).filter(isValid))
  }

  // 2. Salvage: model output may be truncated before the closing ']'
  //    Find the first '[' and the last complete '}', close the array there.
  const open = text.indexOf('[')
  const lastBrace = text.lastIndexOf('}')
  if (open !== -1 && lastBrace > open) {
    const truncated = text.slice(open, lastBrace + 1) + ']'
    const salvaged = tryParseArray(truncated)
    if (salvaged !== null && salvaged.length > 0) {
      return normalizeAllBboxes(prepareDetections(salvaged).filter(isValid))
    }
  }

  return []
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
  if (dets.every((d) => d.bbox.every((v) => v <= 1.001))) return dets
  const maxVal = dets.reduce((m, d) => Math.max(m, ...d.bbox), 0)
  if (maxVal <= 1) return dets
  return dets.map((d) => ({
    ...d,
    bbox: d.bbox.map((v) => Math.min(1, Math.max(0, v / maxVal))) as [number, number, number, number],
  }))
}

function isValid(item: unknown): item is RawDetection {
  if (typeof item !== 'object' || item === null) return false
  const d = item as Record<string, unknown>
  return (
    typeof d['label'] === 'string' &&
    Array.isArray(d['bbox']) &&
    (d['bbox'] as unknown[]).length === 4 &&
    (d['bbox'] as unknown[]).every((v) => typeof v === 'number') &&
    typeof d['confidence'] === 'number' &&
    typeof d['description'] === 'string'
  )
}
