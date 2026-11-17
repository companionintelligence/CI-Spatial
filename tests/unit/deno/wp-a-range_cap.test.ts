/**
 * The 8 MiB cap on one 206 response (server/http_range.ts). A ranged response carries at most
 * 8 MiB, and its Content-Range states exactly the bytes it carries. A client follows Content-Range
 * for the rest.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { MAX_RANGE_BYTES, parseRange, rangedResponse } from '../../../server/http_range.ts'

const CAP = 8 * 1024 * 1024
const BIG = 100 * 1024 * 1024

Deno.test('the cap is 8 MiB', () => {
  assertEquals(MAX_RANGE_BYTES, CAP)
})

Deno.test('bytes=0- on a 100 MB file is capped at 8 MiB, not the whole file', () => {
  assertEquals(parseRange('bytes=0-', BIG), { kind: 'ok', range: { start: 0, end: CAP - 1 } })
})

Deno.test('an open-ended range mid-file is capped from its own start', () => {
  assertEquals(
    parseRange('bytes=50000000-', BIG),
    { kind: 'ok', range: { start: 50_000_000, end: 50_000_000 + CAP - 1 } },
  )
})

Deno.test('an explicit range longer than the cap is shortened, not refused', () => {
  assertEquals(parseRange('bytes=0-99999999', BIG), { kind: 'ok', range: { start: 0, end: CAP - 1 } })
})

Deno.test('an explicit range within the cap is returned unchanged', () => {
  assertEquals(parseRange('bytes=0-1048575', BIG), { kind: 'ok', range: { start: 0, end: 1_048_575 } })
})

Deno.test('a suffix longer than the cap keeps the last 8 MiB of the file', () => {
  assertEquals(parseRange('bytes=-99999999999', BIG), { kind: 'ok', range: { start: BIG - CAP, end: BIG - 1 } })
})

Deno.test('bytes=0- on a 100 MB file reads at most the cap and says so in Content-Range', async () => {
  const requested: number[] = []
  const res = await rangedResponse({
    rangeHeader: 'bytes=0-',
    size: BIG,
    contentType: 'video/mp4',
    readRange: (_start, length) => {
      requested.push(length)
      return Promise.resolve(new Uint8Array(length))
    },
    readAll: () => {
      throw new Error('a ranged request must not read the whole file')
    },
  })
  assertEquals(res.status, 206)
  assertEquals(requested, [CAP])
  assertEquals(res.headers.get('Content-Range'), `bytes 0-${CAP - 1}/${BIG}`)
  assertEquals(res.headers.get('Content-Length'), String(CAP))
  assertEquals((await res.arrayBuffer()).byteLength, CAP)
})
