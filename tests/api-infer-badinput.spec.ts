/**
 * /infer input classification — a frame the decoder cannot read is the caller's
 * problem, not a server fault.
 *
 * Every other failure on this route is already classified precisely (413 too-large,
 * 504 timeout, 503 model-loading), but an undecodable image used to fall through to
 * a generic 500. That matters on the phone path: clients retry 5xx, and a corrupt
 * frame will never decode no matter how many times it is resent. The repo already
 * holds itself to this standard for /ingest-video ("a clean 400, not a 500" in
 * api-house-readiness.spec.ts).
 *
 * These cases are deliberately varied. The first version of the fix matched decoder
 * error strings too narrowly and still 500'd on a JPEG that failed with a different
 * message ("unknown JPEG marker 0"), so each entry below fails in its own way.
 *
 * Run: npx playwright test --project=api api-infer-badinput
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const API = process.env['API_URL'] ?? 'http://localhost:8000'

/** A JPEG SOI + JFIF header with no scan data — valid container, nothing to decode. */
function headerOnlyJpeg(): Buffer {
  return Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ])
}

const CASES: Array<{ name: string; bytes: Buffer; mime: string }> = [
  { name: 'header-only JPEG', bytes: headerOnlyJpeg(), mime: 'image/jpeg' },
  {
    name: 'JPEG header then garbage',
    bytes: Buffer.concat([headerOnlyJpeg(), Buffer.alloc(64, 0x00)]),
    mime: 'image/jpeg',
  },
  {
    name: 'JPEG truncated mid-stream',
    bytes: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(200, 0xAB)]),
    mime: 'image/jpeg',
  },
  {
    name: 'HTML claiming to be a JPEG (dev-server fallback page)',
    bytes: Buffer.from('<!doctype html><html><body>not found</body></html>'),
    mime: 'image/jpeg',
  },
  {
    name: 'PNG magic with no IHDR',
    bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32, 0x00)]),
    mime: 'image/png',
  },
  { name: 'empty body', bytes: Buffer.alloc(0), mime: 'image/jpeg' },
]

test.describe('POST /infer rejects undecodable input cleanly', () => {
  test.setTimeout(120_000)

  for (const { name, bytes, mime } of CASES) {
    test(`${name} → 4xx, never 5xx`, async ({ request }) => {
      const resp = await request.post(`${API}/infer`, {
        multipart: { image: { name: 'frame', mimeType: mime, buffer: bytes } },
      })
      expect(resp.status(), `${name} must not read as a server fault`).toBeLessThan(500)
      expect(resp.status()).toBeGreaterThanOrEqual(400)
      const body = await resp.json() as { code?: string; error?: string }
      expect(body.code, `${name} should carry a machine-readable code`).toBeTruthy()
    })
  }

  // The guard must reject bad bytes without also rejecting good ones.
  test('a real room JPEG still infers normally', async ({ request }) => {
    const fixture = join(process.cwd(), 'public', 'test-fixtures', 'room.jpg')
    test.skip(!existsSync(fixture), 'room.jpg fixture missing')
    const resp = await request.post(`${API}/infer`, {
      multipart: {
        image: { name: 'room.jpg', mimeType: 'image/jpeg', buffer: readFileSync(fixture) },
      },
    })
    expect(resp.status()).toBe(200)
    expect(Array.isArray(await resp.json())).toBeTruthy()
  })
})
