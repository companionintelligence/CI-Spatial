/**
 * Server inference client — POST to the Deno inference server.
 *
 * Used on iOS and older Android where navigator.gpu is unavailable.
 * Requests are proxied same-origin through Vite.
 */
// Explicit .ts extension: see src/scene/store.ts's identical note — this
// module is now reachable from tests/unit/node/inference_router.test.ts via
// router.ts's import of inferViaServer, and Node's ESM loader needs the real
// specifier.
import { normalizeDetections, parseDetections } from './prompt.ts'
import type { RawDetection } from './prompt'

// Empty string = same origin, proxied through Vite dev server (no mixed content).
// Vite forwards /infer and /health to http://localhost:8000.
const SERVER_URL = ''

const MAX_ATTEMPTS = 3
// Client deadline exceeds the server's 60s budget so the server 504 arrives first.
const REQUEST_TIMEOUT_MS = 70_000

export type InferServerErrorCode =
  | 'timeout'
  | 'unavailable'
  | 'model-loading'
  | 'model-failed'
  | 'network'
  | 'http'

/** Typed failure from the server inference path, with a stable error code. */
export class InferServerError extends Error {
  code: InferServerErrorCode
  status?: number

  constructor(message: string, code: InferServerErrorCode, status?: number) {
    super(message)
    this.name = 'InferServerError'
    this.code = code
    this.status = status
  }
}

/** Best-effort JSON parse of an error body to read { error, code }. */
function parseErrorBody(text: string): { error?: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) return parsed as { error?: string; code?: string }
  } catch {
    // Not JSON — plain-text error body
  }
  return {}
}

/** Map a non-ok /infer response to a typed error plus whether a retry is worthwhile. */
function classifyHttpError(status: number, bodyText: string): { error: InferServerError; retry: boolean } {
  const body = parseErrorBody(bodyText)
  const message = body.error ?? bodyText
  if (status === 503) {
    if (body.code === 'model-loading') {
      return { error: new InferServerError(`Inference server 503: ${message}`, 'model-loading', status), retry: true }
    }
    if (body.code === 'model-failed') {
      return { error: new InferServerError(`Inference server 503: ${message}`, 'model-failed', status), retry: false }
    }
    return { error: new InferServerError(`Inference server 503: ${message}`, 'unavailable', status), retry: false }
  }
  if (status === 504) {
    return { error: new InferServerError(`Inference server 504: ${message}`, 'timeout', status), retry: false }
  }
  // 502 = transient proxy failure (server restarting behind Vite) — worth retrying.
  return {
    error: new InferServerError(`Inference server returned ${status}: ${message}`, 'http', status),
    retry: status === 502,
  }
}

export async function inferViaServer(imageBlob: Blob): Promise<RawDetection[]> {
  const form = new FormData()
  form.append('image', imageBlob, 'capture.jpg')

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let failure: { error: InferServerError; retry: boolean }

    try {
      const response = await fetch(`${SERVER_URL}/infer`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (response.ok) {
        const json = (await response.json()) as unknown
        console.log('[server-client] Raw /infer response:', JSON.stringify(json).slice(0, 500))
        if (Array.isArray(json)) return normalizeDetections(json)

        // Some responses wrap in { detections: [...] }
        if (typeof json === 'object' && json !== null && 'detections' in json) {
          const { detections } = json as { detections: unknown }
          if (Array.isArray(detections)) return normalizeDetections(detections)
        }

        // Fallback: try parsing as raw text
        if (typeof json === 'string') return parseDetections(json)

        return []
      }

      failure = classifyHttpError(response.status, await response.text())
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        // AbortSignal.timeout fired before the server answered
        failure = { error: new InferServerError('Inference request timed out', 'timeout'), retry: true }
      } else if (err instanceof TypeError) {
        // fetch network failure (server unreachable, connection dropped)
        failure = { error: new InferServerError(`Inference network error: ${err.message}`, 'network'), retry: true }
      } else {
        throw err
      }
    }

    if (!failure.retry || attempt === MAX_ATTEMPTS - 1) throw failure.error

    // Exponential backoff with jitter before the next attempt
    const delay = 800 * 2 ** attempt + Math.random() * 400
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  // Unreachable — the loop always returns or throws
  throw new InferServerError('Inference server unavailable', 'unavailable')
}
