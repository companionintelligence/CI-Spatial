/**
 * Deno unit tests for HTTP range parsing.
 *
 * Nothing in this repo served ranges before, so every one of these cases is a
 * first. The subtle ones are the inclusive end, the suffix form (`bytes=-N`
 * means the LAST N bytes), and the difference between a header that must be
 * ignored (malformed ⇒ 200 full body) and one that must be refused
 * (well-formed but unsatisfiable ⇒ 416).
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  contentRangeHeader,
  parseRange,
  rangedResponse,
  rangeLength,
  unsatisfiedRangeHeader,
} from '../../../server/http_range.ts'

const SIZE = 1000

Deno.test('bytes=0- covers the whole file', () => {
  const r = parseRange('bytes=0-', SIZE)
  assertEquals(r, { kind: 'ok', range: { start: 0, end: 999 } })
})

Deno.test('an explicit range keeps its INCLUSIVE end', () => {
  const r = parseRange('bytes=100-199', SIZE)
  assertEquals(r, { kind: 'ok', range: { start: 100, end: 199 } })
  if (r.kind === 'ok') assertEquals(rangeLength(r.range), 100)
})

Deno.test('bytes=-500 is the LAST 500 bytes, not the first', () => {
  const r = parseRange('bytes=-500', SIZE)
  assertEquals(r, { kind: 'ok', range: { start: 500, end: 999 } })
})

Deno.test('a suffix longer than the file is satisfied by the whole file', () => {
  const r = parseRange('bytes=-99999', SIZE)
  assertEquals(r, { kind: 'ok', range: { start: 0, end: 999 } })
})

Deno.test('an end past the file is clamped rather than refused', () => {
  const r = parseRange('bytes=900-99999', SIZE)
  assertEquals(r, { kind: 'ok', range: { start: 900, end: 999 } })
})

Deno.test('a start at or past the end is unsatisfiable', () => {
  assertEquals(parseRange('bytes=1000-', SIZE).kind, 'unsatisfiable')
  assertEquals(parseRange('bytes=99999-', SIZE).kind, 'unsatisfiable')
})

Deno.test('an inverted range is unsatisfiable', () => {
  assertEquals(parseRange('bytes=500-100', SIZE).kind, 'unsatisfiable')
})

Deno.test('a malformed header is ignored, not refused', () => {
  // Per spec: an unparseable Range must be ignored and the full body served.
  for (const bad of ['', 'items=0-10', 'bytes', 'bytes=', 'bytes=abc-def', 'bytes=-', null, undefined]) {
    assertEquals(parseRange(bad, SIZE).kind, 'none', `${bad} should be ignored`)
  }
})

Deno.test('a multi-range request falls back to the whole body', () => {
  // Real players do not use these, and a wrong multipart/byteranges response is
  // worse than not offering one.
  assertEquals(parseRange('bytes=0-99,200-299', SIZE).kind, 'none')
})

Deno.test('an empty file cannot satisfy any range', () => {
  assertEquals(parseRange('bytes=0-', 0).kind, 'unsatisfiable')
})

Deno.test('header builders match the wire format', () => {
  assertEquals(contentRangeHeader({ start: 0, end: 1023 }, 4096), 'bytes 0-1023/4096')
  assertEquals(unsatisfiedRangeHeader(4096), 'bytes */4096')
})

// ── rangedResponse ──────────────────────────────────────────────────────────

const body = new Uint8Array(SIZE).map((_, i) => i % 256)
const readAll = () => Promise.resolve(body)
const readRange = (start: number, length: number) => Promise.resolve(body.slice(start, start + length))

Deno.test('no Range header returns 200 and still advertises range support', async () => {
  const res = await rangedResponse({
    rangeHeader: null, size: SIZE, contentType: 'video/mp4', readRange, readAll,
  })
  assertEquals(res.status, 200)
  // A player only asks for a range if it knows ranges are available.
  assertEquals(res.headers.get('Accept-Ranges'), 'bytes')
  assertEquals(res.headers.get('Content-Length'), String(SIZE))
  assertEquals((await res.arrayBuffer()).byteLength, SIZE)
})

Deno.test('a satisfied range returns 206 with exactly the requested bytes', async () => {
  const res = await rangedResponse({
    rangeHeader: 'bytes=0-1023', size: SIZE, contentType: 'video/mp4', readRange, readAll,
  })
  assertEquals(res.status, 206)
  assertEquals(res.headers.get('Content-Range'), `bytes 0-999/${SIZE}`)
  assertEquals((await res.arrayBuffer()).byteLength, SIZE)
})

Deno.test('a mid-file range returns exactly its length', async () => {
  const res = await rangedResponse({
    rangeHeader: 'bytes=100-199', size: SIZE, contentType: 'video/mp4', readRange, readAll,
  })
  assertEquals(res.status, 206)
  assertEquals(res.headers.get('Content-Range'), `bytes 100-199/${SIZE}`)
  assertEquals((await res.arrayBuffer()).byteLength, 100)
})

Deno.test('an unsatisfiable range returns 416 with a size-only Content-Range', async () => {
  const res = await rangedResponse({
    rangeHeader: 'bytes=99999-', size: SIZE, contentType: 'video/mp4', readRange, readAll,
  })
  assertEquals(res.status, 416)
  assertEquals(res.headers.get('Content-Range'), `bytes */${SIZE}`)
})
