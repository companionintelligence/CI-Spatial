/**
 * Byte caps for request bodies, counted as the body arrives.
 *
 * A Content-Length check on its own is not a cap. A chunked body has no
 * Content-Length, so the check passes and the whole body is buffered before
 * anything looks at its size. These helpers refuse a declared length over the
 * cap before reading, and count bytes while reading so a body without a length
 * is cut off at the same point.
 *
 * A body over the cap comes back as `null`, not as an exception, so each route
 * can answer 413 in its own words. Any other failure is thrown as before.
 */

/** Thrown inside a counted body once the cap is passed. Callers see `null` instead. */
export class BodyTooLargeError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
    this.name = 'BodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

/** True when the Content-Length header declares more than `maxBytes`. A missing or non-numeric header declares nothing. */
export function declaredLengthExceeds(headers: Headers, maxBytes: number): boolean {
  const raw = headers.get('content-length')
  if (raw === null || raw.trim() === '') return false
  const declared = Number(raw)
  return Number.isFinite(declared) && declared > maxBytes
}

/**
 * The body, passed through a counter that errors once more than `maxBytes` have
 * arrived. `onExceeded` runs first, so the caller can tell a cap apart from any
 * other read failure.
 */
function countedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onExceeded: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) return null
  let seen = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > maxBytes) {
        onExceeded()
        controller.error(new BodyTooLargeError(maxBytes))
        return
      }
      controller.enqueue(chunk)
    },
  }))
}

/**
 * Parse a multipart or urlencoded request body under `maxBytes`. Resolves to
 * `null` when the body is over the cap. A body that is not form data throws, as
 * `formData()` does. `Response.formData()` holds the whole upload in memory, so
 * the byte cap is what bounds that memory. The 1.5 GB photo and video defaults
 * are a memory risk to review.
 */
export async function readFormDataCapped(req: Request, maxBytes: number): Promise<FormData | null> {
  if (declaredLengthExceeds(req.headers, maxBytes)) return null
  let exceeded = false
  const body = countedBody(req.body, maxBytes, () => {
    exceeded = true
  })
  const contentType = req.headers.get('content-type')
  try {
    return await new Response(body, contentType ? { headers: { 'Content-Type': contentType } } : undefined).formData()
  } catch (err) {
    if (exceeded) return null
    throw err
  }
}

/** The body as text under `maxBytes`, or `null` when it is over the cap. */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (declaredLengthExceeds(req.headers, maxBytes)) return null
  let exceeded = false
  const body = countedBody(req.body, maxBytes, () => {
    exceeded = true
  })
  try {
    return await new Response(body).text()
  } catch (err) {
    if (exceeded) return null
    throw err
  }
}

/**
 * Why a photo upload is refused before any photo is written, or `null` when it may be written.
 *
 * The total bytes of an upload are capped, but the number of parts is not. A large body of tiny
 * parts would write one file per part, so the count and the size of each part are checked first.
 * Each limit is a whole number: a count above `maxCount` is refused, and so is any part above
 * `maxPartBytes`.
 */
export function photoUploadRefusal(
  parts: readonly { size: number }[],
  limits: { maxCount: number; maxPartBytes: number },
): string | null {
  if (parts.length > limits.maxCount) {
    return `too many photos: ${parts.length} sent, at most ${limits.maxCount} per upload`
  }
  const largest = parts.reduce((max, part) => Math.max(max, part.size), 0)
  if (largest > limits.maxPartBytes) {
    return `a photo is ${largest} bytes; the limit is ${limits.maxPartBytes} bytes per photo`
  }
  return null
}
