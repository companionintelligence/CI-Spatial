/**
 * Backend API tests — exercises the Deno/Hono server directly via the Vite proxy.
 *
 * All requests go through:
 *   Playwright → Vite dev server (port 5173) → Deno server (port 8000)
 *
 * Tests are project-agnostic (no browser) and run under the webkit-desktop
 * project so they execute once per CI run.
 */
import { test, expect } from '@playwright/test'
import { createHash } from 'crypto'

const BASE = process.env['VITE_URL'] ?? 'https://liam-mbp.capybara-ulmer.ts.net:5173'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal valid GLB buffer (~50 bytes) */
function makeMinimalGlb(): Buffer {
  const jsonStr = JSON.stringify({ asset: { version: '2.0' } })
  const jsonBytes = Buffer.from(jsonStr, 'utf8')
  const padded = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20)
  jsonBytes.copy(padded)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)  // magic 'glTF'
  header.writeUInt32LE(2, 4)            // version 2
  header.writeUInt32LE(12 + 8 + padded.length, 8) // total length
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(padded.length, 0)
  chunkHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  return Buffer.concat([header, chunkHeader, padded])
}

/** Upload a GLB and return the stored filename */
async function uploadGlb(request: Parameters<typeof test>[1] extends { request: infer R } ? R : never, label = 'test') {
  const buf = makeMinimalGlb()
  const resp = await (request as any).post(`${BASE}/upload-scan`, {
    multipart: {
      file: { name: `${label}.glb`, mimeType: 'model/gltf-binary', buffer: buf },
      metadata: JSON.stringify({ detectionCount: 1, labels: [label], exportedAt: new Date().toISOString() }),
    },
  })
  return { resp, buf }
}

// ── /health ──────────────────────────────────────────────────────────────────

test.describe('/health', () => {
  test('returns 200 with status ok', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`)
    expect(resp.status()).toBe(200)
    const body = await resp.json() as Record<string, string>
    expect(body['status']).toBe('ok')
  })

  test('includes model name field', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`)
    const body = await resp.json() as Record<string, string>
    expect(typeof body['model']).toBe('string')
    expect(body['model'].length).toBeGreaterThan(0)
  })

  test('includes model containing LFM2.5', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`)
    const body = await resp.json() as Record<string, string>
    expect(body['model']).toContain('LFM2.5')
  })

  test('responds in under 2 seconds', async ({ request }) => {
    const start = Date.now()
    await request.get(`${BASE}/health`)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

// ── GET /scans ────────────────────────────────────────────────────────────────

test.describe('GET /scans', () => {
  test('returns 200', async ({ request }) => {
    const resp = await request.get(`${BASE}/scans`)
    expect(resp.status()).toBe(200)
  })

  test('returns JSON array', async ({ request }) => {
    const resp = await request.get(`${BASE}/scans`)
    const body = await resp.json() as unknown[]
    expect(Array.isArray(body)).toBeTruthy()
  })

  test('each entry has filename, size, uploadedAt', async ({ request }) => {
    // Upload one so the list is non-empty
    const { resp: upResp } = await uploadGlb(request as any, 'list-test')
    expect(upResp.status()).toBe(200)

    const resp = await request.get(`${BASE}/scans`)
    const list = await resp.json() as Array<Record<string, unknown>>
    expect(list.length).toBeGreaterThan(0)

    const first = list[0]!
    expect(typeof first['filename']).toBe('string')
    expect(typeof first['size']).toBe('number')
    expect(typeof first['uploadedAt']).toBe('string')
  })

  test('newest entry is first', async ({ request }) => {
    // Upload two with a small gap
    const { resp: r1 } = await uploadGlb(request as any, 'order-a')
    expect(r1.status()).toBe(200)
    await new Promise(r => setTimeout(r, 50))
    const { resp: r2 } = await uploadGlb(request as any, 'order-b')
    expect(r2.status()).toBe(200)

    const list = await (await request.get(`${BASE}/scans`)).json() as Array<{ uploadedAt: string }>
    if (list.length >= 2) {
      const t0 = new Date(list[0]!.uploadedAt).getTime()
      const t1 = new Date(list[1]!.uploadedAt).getTime()
      expect(t0).toBeGreaterThanOrEqual(t1)
    }
  })

  test('response has correct CORS header', async ({ request }) => {
    const resp = await request.get(`${BASE}/scans`)
    const cors = resp.headers()['access-control-allow-origin']
    expect(cors).toBeTruthy()
  })
})

// ── POST /upload-scan ─────────────────────────────────────────────────────────

test.describe('POST /upload-scan', () => {
  test('returns 200 with filename and size', async ({ request }) => {
    const { resp } = await uploadGlb(request as any, 'upload-basic')
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { filename: string; size: number }
    expect(body.filename.endsWith('.glb')).toBeTruthy()
    expect(body.size).toBeGreaterThan(0)
  })

  test('stored filename appears in /scans list', async ({ request }) => {
    const { resp: upResp } = await uploadGlb(request as any, 'upload-appears')
    expect(upResp.status()).toBe(200)
    const { filename } = await upResp.json() as { filename: string }

    const list = await (await request.get(`${BASE}/scans`)).json() as Array<{ filename: string }>
    expect(list.some(s => s.filename === filename)).toBeTruthy()
  })

  test('upload without file returns 400', async ({ request }) => {
    const resp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        metadata: JSON.stringify({ detectionCount: 0, labels: [] }),
      },
    })
    expect(resp.status()).toBe(400)
  })

  test('stored size matches uploaded byte count', async ({ request }) => {
    const buf = makeMinimalGlb()
    const resp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        file: { name: 'size-check.glb', mimeType: 'model/gltf-binary', buffer: buf },
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { filename: string; size: number }
    expect(body.size).toBe(buf.length)
  })

  test('filename is sanitised — no path separators', async ({ request }) => {
    const buf = makeMinimalGlb()
    const resp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        file: { name: '../evil/../path.glb', mimeType: 'model/gltf-binary', buffer: buf },
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { filename: string }
    expect(body.filename).not.toContain('/')
    expect(body.filename).not.toContain('..')
  })

  test('duplicate uploads both succeed with unique filenames', async ({ request }) => {
    const [{ resp: r1 }, { resp: r2 }] = await Promise.all([
      uploadGlb(request as any, 'dup'),
      uploadGlb(request as any, 'dup'),
    ])
    const b1 = await r1.json() as { filename: string }
    const b2 = await r2.json() as { filename: string }
    expect(b1.filename).not.toBe(b2.filename)
  })
})

// ── GET /scans/:filename ──────────────────────────────────────────────────────

test.describe('GET /scans/:filename', () => {
  test('returns 200 and correct content-type for a stored file', async ({ request }) => {
    const { resp: upResp } = await uploadGlb(request as any, 'dl-basic')
    expect(upResp.status()).toBe(200)
    const { filename } = await upResp.json() as { filename: string }

    const dlResp = await request.get(`${BASE}/scans/${encodeURIComponent(filename)}`)
    expect(dlResp.status()).toBe(200)
    expect(dlResp.headers()['content-type']).toContain('gltf-binary')
  })

  test('returned bytes match uploaded bytes', async ({ request }) => {
    const buf = makeMinimalGlb()
    const upResp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        file: { name: 'roundtrip.glb', mimeType: 'model/gltf-binary', buffer: buf },
      },
    })
    const { filename } = await upResp.json() as { filename: string }

    const dlResp = await request.get(`${BASE}/scans/${encodeURIComponent(filename)}`)
    const dlBytes = Buffer.from(await dlResp.body())
    expect(dlBytes.length).toBe(buf.length)
    // Compare SHA-256 to verify bit-for-bit equality
    const hashUp = createHash('sha256').update(buf).digest('hex')
    const hashDl = createHash('sha256').update(dlBytes).digest('hex')
    expect(hashDl).toBe(hashUp)
  })

  test('returns 404 for a non-existent file', async ({ request }) => {
    const resp = await request.get(`${BASE}/scans/definitely-not-there-xyz.glb`)
    expect(resp.status()).toBe(404)
  })

  test('rejects path traversal (../)', async ({ request }) => {
    const resp = await request.get(`${BASE}/scans/..%2F..%2Fetc%2Fpasswd`)
    expect(resp.status()).toBeGreaterThanOrEqual(400)
    expect(resp.status()).not.toBe(200)
  })

  test('rejects double-encoded traversal', async ({ request }) => {
    const resp = await request.get(`${BASE}/scans/..%252F..%252Fetc%252Fpasswd`)
    expect(resp.status()).toBeGreaterThanOrEqual(400)
    expect(resp.status()).not.toBe(200)
  })

  test('sets cache-control header', async ({ request }) => {
    const { resp: upResp } = await uploadGlb(request as any, 'cache-check')
    const { filename } = await upResp.json() as { filename: string }

    const dlResp = await request.get(`${BASE}/scans/${encodeURIComponent(filename)}`)
    const cc = dlResp.headers()['cache-control']
    expect(cc).toBeTruthy()
  })

  test('includes CORS allow-origin header', async ({ request }) => {
    const { resp: upResp } = await uploadGlb(request as any, 'cors-check')
    const { filename } = await upResp.json() as { filename: string }

    const dlResp = await request.get(`${BASE}/scans/${encodeURIComponent(filename)}`)
    const cors = dlResp.headers()['access-control-allow-origin']
    expect(cors).toBeTruthy()
  })
})
