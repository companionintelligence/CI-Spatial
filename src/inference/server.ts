/**
 * Server inference client — POST to the Deno inference server.
 *
 * Used on iOS and older Android where navigator.gpu is unavailable.
 * In development Vite proxies same-origin /infer and /health to the Deno
 * server. Persistent installs keep the same HTTPS proxy shape via vite preview.
 */
import { normalizeDetections, parseDetections } from './prompt'
import type { RawDetection } from './prompt'

// Empty string = same origin, proxied through Vite dev server (no mixed content).
// Vite forwards /infer and /health to http://localhost:8000.
const SERVER_URL = ''
const MAX_ATTEMPTS = 3
const INFER_TIMEOUT_MS = 70_000

export type InferServerErrorCode =
  | 'offline'
  | 'timeout'
  | 'model-loading'
  | 'model-failed'
  | 'payload-too-large'
  | 'http'
  | 'bad-response'

export class InferServerError extends Error {
  constructor(
    readonly code: InferServerErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'InferServerError'
  }
}

export async function inferViaServer(imageBlob: Blob): Promise<RawDetection[]> {
  let lastError: InferServerError | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await inferOnce(imageBlob)
    } catch (error) {
      const err = toInferServerError(error)
      lastError = err
      if (!shouldRetry(err) || attempt === MAX_ATTEMPTS - 1) throw err
      await delay(350 * 2 ** attempt + Math.random() * 150)
    }
  }
  throw lastError ?? new InferServerError('offline', 'Inference server unavailable')
}

async function inferOnce(imageBlob: Blob): Promise<RawDetection[]> {
  const form = new FormData()
  form.append('image', imageBlob, 'capture.jpg')

  const response = await fetch(`${SERVER_URL}/infer`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
  })

  if (!response.ok) {
    const body = await response.text()
    const parsed = parseErrorBody(body)
    const code = codeForStatus(response.status, parsed?.code)
    throw new InferServerError(code, parsed?.error ?? `Inference server returned ${response.status}: ${body}`, response.status)
  }

  const json = await response.json().catch((error) => {
    throw new InferServerError('bad-response', `Inference server returned invalid JSON: ${String(error)}`, response.status)
  }) as unknown
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

function parseErrorBody(body: string): { error?: string; code?: string } | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' ? parsed as { error?: string; code?: string } : null
  } catch {
    return null
  }
}

function codeForStatus(status: number, serverCode: string | undefined): InferServerErrorCode {
  if (serverCode === 'model-loading') return 'model-loading'
  if (serverCode === 'model-failed') return 'model-failed'
  if (serverCode === 'payload-too-large') return 'payload-too-large'
  if (serverCode === 'inference-timeout') return 'timeout'
  if (status === 503) return 'model-loading'
  if (status === 504) return 'timeout'
  if (status === 413) return 'payload-too-large'
  return 'http'
}

function toInferServerError(error: unknown): InferServerError {
  if (error instanceof InferServerError) return error
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new InferServerError('timeout', 'Inference timed out')
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new InferServerError('timeout', 'Inference timed out')
  }
  if (error instanceof TypeError) {
    return new InferServerError('offline', 'Inference server is unreachable')
  }
  return new InferServerError('http', error instanceof Error ? error.message : String(error))
}

function shouldRetry(error: InferServerError): boolean {
  return error.code === 'offline' || error.code === 'model-loading'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
