/**
 * Inference prompt template and response parser.
 *
 * The prompt is designed to elicit a strict JSON array from LFM2.5-VL
 * (or any capable VLM) with no surrounding prose.
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

/**
 * Parse the VLM's text output into a typed detection array.
 * Tolerates leading/trailing prose by extracting the first JSON array found.
 */
export function parseDetections(text: string): RawDetection[] {
  // Extract the outermost array of objects: starts with [{ and ends with }]
  const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!match) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    // Try a second time after stripping trailing commas (common LLM artefact)
    try {
      parsed = JSON.parse(match[0].replace(/,\s*([\]}])/g, '$1'))
    } catch {
      return []
    }
  }

  if (!Array.isArray(parsed)) return []

  return parsed.filter(isValidDetection)
}

function isValidDetection(item: unknown): item is RawDetection {
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
