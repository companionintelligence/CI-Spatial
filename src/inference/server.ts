/**
 * Server inference client — POST to the Deno inference server.
 *
 * Used on iOS and older Android where navigator.gpu is unavailable.
 * The server runs at http://liam-mbp.capybara-ulmer.ts.net:8000
 * and is accessible over the Tailscale network.
 */
import { parseDetections } from './prompt'
import type { RawDetection } from './prompt'

// Empty string = same origin, proxied through Vite dev server (no mixed content).
// Vite forwards /infer and /health to http://localhost:8000.
const SERVER_URL = ''

export async function inferViaServer(imageBlob: Blob): Promise<RawDetection[]> {
  const form = new FormData()
  form.append('image', imageBlob, 'capture.jpg')

  const response = await fetch(`${SERVER_URL}/infer`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    throw new Error(`Inference server returned ${response.status}: ${await response.text()}`)
  }

  const json = (await response.json()) as unknown
  console.log('[server-client] Raw /infer response:', JSON.stringify(json).slice(0, 500))
  if (Array.isArray(json)) return json.filter((d): d is RawDetection => isDetection(d))

  // Some responses wrap in { detections: [...] }
  if (typeof json === 'object' && json !== null && 'detections' in json) {
    const { detections } = json as { detections: unknown }
    if (Array.isArray(detections)) return detections.filter((d): d is RawDetection => isDetection(d))
  }

  // Fallback: try parsing as raw text
  if (typeof json === 'string') return parseDetections(json)

  return []
}

function isDetection(d: unknown): d is RawDetection {
  if (typeof d !== 'object' || d === null) return false
  const obj = d as Record<string, unknown>
  return typeof obj['label'] === 'string' && Array.isArray(obj['bbox'])
}
