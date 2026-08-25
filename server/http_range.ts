/**
 * HTTP range requests — the first ranged serving in this codebase.
 *
 * Every artifact route here reads a whole file into memory and returns it
 * (`Deno.readFile` → `new Response(bytes)`). That is fine for a manifest and
 * tolerable for a GLB; it is not fine for video. A person clip is the durable
 * artifact of a capture, the editor will want to scrub it, and a handful of
 * concurrent full-buffer reads of a 1080p clip is a straightforward way to
 * exhaust the box.
 *
 * Deliberately its own module, unit-tested, rather than inlined into one route:
 * range parsing is easy to get subtly wrong (inclusive ends, suffix ranges, the
 * unsatisfiable case) and those mistakes are invisible until a player behaves
 * strangely. Existing full-buffer routes are intentionally left alone — this is
 * for the routes that need it, not an opportunistic migration.
 *
 * Multi-range requests are answered with the whole body rather than a
 * `multipart/byteranges` response. Real players do not use them, and a wrong
 * multipart implementation is worse than not offering one.
 *
 * See docs/factory/10-4d-person-capture/0004-durable-clip-storage.md.
 */

export interface ParsedRange {
  /** First byte, inclusive. */
  start: number
  /** Last byte, **inclusive** — as HTTP specifies, not an exclusive end. */
  end: number
}

export type RangeParse =
  | { kind: 'none' }
  | { kind: 'ok'; range: ParsedRange }
  /** Syntactically valid but unsatisfiable against this size ⇒ 416. */
  | { kind: 'unsatisfiable' }

/**
 * Parse a `Range` header against a known content size.
 *
 * A malformed or non-`bytes` header is `'none'`, not an error: the spec says an
 * unparseable Range must be ignored and the full representation served. Only a
 * *well-formed but unsatisfiable* range earns a 416.
 */
export function parseRange(header: string | null | undefined, size: number): RangeParse {
  if (!header || typeof header !== 'string') return { kind: 'none' }
  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (!match) return { kind: 'none' }

  const specs = match[1].split(',').map(s => s.trim()).filter(s => s.length > 0)
  if (specs.length === 0) return { kind: 'none' }
  // Multi-range: serve the whole body instead (see the module header).
  if (specs.length > 1) return { kind: 'none' }

  const spec = specs[0]
  const dash = spec.indexOf('-')
  if (dash < 0) return { kind: 'none' }

  const rawStart = spec.slice(0, dash).trim()
  const rawEnd = spec.slice(dash + 1).trim()

  // An empty file cannot satisfy any range.
  if (size <= 0) return { kind: 'unsatisfiable' }

  if (rawStart === '') {
    // Suffix range: `bytes=-N` means the LAST N bytes, not "from 0 to N".
    if (rawEnd === '') return { kind: 'none' }
    const n = Number(rawEnd)
    if (!Number.isInteger(n) || n < 0) return { kind: 'none' }
    if (n === 0) return { kind: 'unsatisfiable' }
    // A suffix longer than the file is satisfied by the whole file, not refused.
    const start = Math.max(0, size - n)
    return { kind: 'ok', range: { start, end: size - 1 } }
  }

  const start = Number(rawStart)
  if (!Number.isInteger(start) || start < 0) return { kind: 'none' }
  if (start >= size) return { kind: 'unsatisfiable' }

  if (rawEnd === '') return { kind: 'ok', range: { start, end: size - 1 } }

  const end = Number(rawEnd)
  if (!Number.isInteger(end) || end < 0) return { kind: 'none' }
  if (end < start) return { kind: 'unsatisfiable' }
  // An end past the file is clamped, per spec — not an error.
  return { kind: 'ok', range: { start, end: Math.min(end, size - 1) } }
}

/** Bytes covered by a parsed range. */
export function rangeLength(range: ParsedRange): number {
  return range.end - range.start + 1
}

/** `Content-Range` value for a satisfied range. */
export function contentRangeHeader(range: ParsedRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}

/** `Content-Range` value for a 416, which reports only the size. */
export function unsatisfiedRangeHeader(size: number): string {
  return `bytes */${size}`
}

/**
 * Build a response for a possibly-ranged read.
 *
 * `readRange` is injected so this stays testable without a filesystem, and so
 * the caller decides how to read — a seeking read for a large clip, a slice of
 * an already-buffered file for a small one.
 */
export async function rangedResponse(opts: {
  rangeHeader: string | null | undefined
  size: number
  contentType: string
  readRange: (start: number, length: number) => Promise<Uint8Array<ArrayBuffer>>
  readAll: () => Promise<Uint8Array<ArrayBuffer>>
  cacheControl?: string
}): Promise<Response> {
  const baseHeaders: Record<string, string> = {
    'Content-Type': opts.contentType,
    // Advertised on every response, including the unranged one — a player asks
    // for a range only if it knows ranges are available.
    'Accept-Ranges': 'bytes',
    ...(opts.cacheControl ? { 'Cache-Control': opts.cacheControl } : {}),
  }

  const parsed = parseRange(opts.rangeHeader, opts.size)

  if (parsed.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': unsatisfiedRangeHeader(opts.size) },
    })
  }

  if (parsed.kind === 'none') {
    const bytes = await opts.readAll()
    return new Response(bytes, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(bytes.byteLength) },
    })
  }

  const length = rangeLength(parsed.range)
  const bytes = await opts.readRange(parsed.range.start, length)
  return new Response(bytes, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(bytes.byteLength),
      'Content-Range': contentRangeHeader(parsed.range, opts.size),
    },
  })
}

/**
 * Read `length` bytes from `path` starting at `start`, without buffering the
 * whole file — the point of the exercise.
 */
export async function readFileRange(path: string, start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const file = await Deno.open(path, { read: true })
  try {
    await file.seek(start, Deno.SeekMode.Start)
    const buf = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      const n = await file.read(buf.subarray(filled))
      // Short read: the file ended early. Return what exists rather than
      // padding with zeros, which would silently corrupt the response body.
      if (n === null) break
      filled += n
    }
    return filled === length ? buf : buf.subarray(0, filled)
  } finally {
    file.close()
  }
}
