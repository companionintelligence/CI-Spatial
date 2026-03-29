/**
 * Shared prompt + parser for the Deno inference server.
 * Must stay in sync with src/inference/prompt.ts (same logic, Deno pathing).
 */

export const SPATIAL_DETECTION_PROMPT = `You are a spatial object detector. Analyze this image and respond with ONLY a JSON array. No other text. Format:
[{"label": "chair", "bbox": [x1,y1,x2,y2], "confidence": 0.92, "description": "wooden dining chair, brown"}]
Where bbox values are 0–1 normalised to image dimensions. List every distinct object you can see. Maximum 20 objects.`

export interface RawDetection {
  label: string
  bbox: [number, number, number, number]
  confidence: number
  description: string
}

export function parseDetections(text: string): RawDetection[] {
  // Match the outermost array containing objects: starts with [{ and ends with }]
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!match) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    try {
      parsed = JSON.parse(match[0].replace(/,\s*([\]}])/g, '$1'))
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isValid)
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
