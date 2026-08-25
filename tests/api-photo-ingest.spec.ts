/**
 * Photo-ingest smoke — covers both halves of the photo arm:
 *
 *   1. scripts/ingest-photos.mjs (script-level, no server): EXIF/mtime time
 *      ordering, the blur gate (a deliberately-blurred JPEG — a tiny gradient
 *      upscaled 80x — is dropped and counted), contiguous re-indexing, and the
 *      session.json `source: 'photo-ingest'` contract.
 *   2. POST /ingest-photos (route-level): 3 tiny sharp JPEGs → 202 with a
 *      registered scan + auto-enqueued lingbot-map-reconstruct job, mirroring
 *      /ingest-video. Skips when no server is reachable at API_URL.
 *
 * Fixture photos are synthesized with sharp (a transitive dependency of
 * @huggingface/transformers, so always present in this repo's node_modules):
 * noise images score ~47k on the variance-of-Laplacian sharpness metric,
 * upscaled gradients ~1.5 — comfortably astride the default threshold of 60.
 *
 * Writes into isolated temp dirs OUTSIDE the repo tree (the box's inotify
 * watches choke on churn inside the checkout).
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = process.env['API_URL'] ?? 'http://localhost:8000'
const INGEST = join(process.cwd(), 'scripts', 'ingest-photos.mjs')

/** Sharp 96x96 noise JPEG (variance-of-Laplacian ≫ 60). */
async function makeSharpJpeg(seed: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const raw = Buffer.alloc(96 * 96 * 3)
  let s = seed >>> 0
  for (let i = 0; i < raw.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    raw[i] = s & 0xff
  }
  return sharp(raw, { raw: { width: 96, height: 96, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
}

/** Deliberately blurred JPEG: an 8x8 gradient upscaled to 640 (variance ≈ 1.5). */
async function makeBlurryJpeg(): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const raw = Buffer.alloc(8 * 8 * 3)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 3
      raw[i] = x * 30
      raw[i + 1] = y * 30
      raw[i + 2] = 128
    }
  }
  return sharp(raw, { raw: { width: 8, height: 8, channels: 3 } }).resize(640, 640).jpeg({ quality: 85 }).toBuffer()
}

test.describe('photo ingest → capture session (script)', () => {
  test.setTimeout(120_000)

  test('blur gate drops the upscaled-blurry photo, keeps the sharp ones, and re-indexes', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'cscan-photos-src-'))
    const scansDir = mkdtempSync(join(tmpdir(), 'cscan-photos-out-'))
    try {
      await writeFile(join(srcDir, 'a.jpg'), await makeSharpJpeg(1))
      await writeFile(join(srcDir, 'b.jpg'), await makeBlurryJpeg())
      await writeFile(join(srcDir, 'c.jpg'), await makeSharpJpeg(2))

      const out = execFileSync('node', [
        INGEST, srcDir,
        '--session-id', 'sess-photo-blur-test',
        '--scans-dir', scansDir,
        '--single-session', 'true',
      ], { encoding: 'utf8' })

      // Contract: last stdout line is JSON { sessionId, frameCount, sessionDir, droppedBlurry }.
      const summary = JSON.parse(out.trim().split('\n').at(-1)!) as {
        sessionId: string; frameCount: number; sessionDir: string; droppedBlurry: number
      }
      expect(summary.sessionId).toBe('sess-photo-blur-test')
      expect(summary.droppedBlurry, 'exactly the blurry photo is dropped').toBe(1)
      expect(summary.frameCount).toBe(2)

      // Survivors are contiguous kf-00000/kf-00001 and the jsonl matches, no pose.
      const jpgs = readdirSync(summary.sessionDir).filter((f) => /^kf-\d{5}\.jpg$/.test(f)).sort()
      expect(jpgs).toEqual(['kf-00000.jpg', 'kf-00001.jpg'])
      const jsonl = readFileSync(join(summary.sessionDir, 'keyframes.jsonl'), 'utf8').trim().split('\n')
      expect(jsonl.length).toBe(2)
      const first = JSON.parse(jsonl[0]) as Record<string, unknown>
      expect(first).toMatchObject({ index: 0, file: 'kf-00000.jpg' })
      expect('pose' in first, 'photo-ingest records carry no pose').toBe(false)

      // session.json marks the source + the drop count.
      const session = JSON.parse(readFileSync(join(summary.sessionDir, 'session.json'), 'utf8')) as {
        source: string; frameCount: number; droppedBlurry: number; photoCount: number
      }
      expect(session.source).toBe('photo-ingest')
      expect(session.frameCount).toBe(2)
      expect(session.photoCount).toBe(3)
      expect(session.droppedBlurry).toBe(1)
    } finally {
      rmSync(srcDir, { recursive: true, force: true })
      rmSync(scansDir, { recursive: true, force: true })
    }
  })

  test('min-sharpness 0 disables the gate', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'cscan-photos-nofilter-'))
    const scansDir = mkdtempSync(join(tmpdir(), 'cscan-photos-nofilter-out-'))
    try {
      await writeFile(join(srcDir, 'a.jpg'), await makeSharpJpeg(3))
      await writeFile(join(srcDir, 'b.jpg'), await makeBlurryJpeg())
      const out = execFileSync('node', [
        INGEST, srcDir,
        '--session-id', 'sess-photo-nofilter',
        '--scans-dir', scansDir,
        '--min-sharpness', '0',
        '--single-session', 'true',
      ], { encoding: 'utf8' })
      const summary = JSON.parse(out.trim().split('\n').at(-1)!) as { frameCount: number; droppedBlurry: number }
      expect(summary.droppedBlurry).toBe(0)
      expect(summary.frameCount).toBe(2)
    } finally {
      rmSync(srcDir, { recursive: true, force: true })
      rmSync(scansDir, { recursive: true, force: true })
    }
  })
})

test.describe.serial('POST /ingest-photos (route)', () => {
  test.setTimeout(120_000)

  let serverUp = false

  test('preflight: server reachable', async ({ request }) => {
    try {
      const resp = await request.get(`${API}/health`)
      serverUp = resp.ok()
    } catch {
      serverUp = false
    }
    test.skip(!serverUp, `no server at ${API} — start one (isolated dirs) to run the route tests`)
  })

  test('3 tiny JPEGs → 202 with a registered scan + auto-enqueued reconstruct job', async ({ request }) => {
    test.skip(!serverUp, 'server unreachable')

    // Playwright's object-form multipart can't repeat a field name, so build a
    // real FormData with three entries under the same `files` field.
    const form = new FormData()
    form.append('name', 'Photo smoke')
    form.append('files', new File([new Uint8Array(await makeSharpJpeg(10))], 'p0.jpg', { type: 'image/jpeg' }))
    form.append('files', new File([new Uint8Array(await makeSharpJpeg(11))], 'p1.jpg', { type: 'image/jpeg' }))
    form.append('files', new File([new Uint8Array(await makeSharpJpeg(12))], 'p2.jpg', { type: 'image/jpeg' }))
    const resp = await request.post(`${API}/ingest-photos`, { multipart: form })
    expect(resp.status(), 'POST /ingest-photos').toBe(202)
    const body = await resp.json() as {
      sessionId: string; scanId: string; jobId: string; frameCount: number; droppedBlurry: number
    }
    expect(body.sessionId).toMatch(/^sess-photo-/)
    expect(body.scanId).toBeTruthy()
    expect(body.jobId, 'a lingbot-map-reconstruct job is auto-enqueued').toBeTruthy()
    expect(body.frameCount).toBe(3)
    expect(body.droppedBlurry).toBe(0)

    // The session is readable back and marked as photo-ingest.
    const session = await request.get(`${API}/sessions/${encodeURIComponent(body.sessionId)}`)
    expect(session.ok(), 'GET /sessions/:id').toBeTruthy()
    const sessionBody = await session.json() as { source: string; frameCount: number }
    expect(sessionBody.source).toBe('photo-ingest')
    expect(sessionBody.frameCount).toBe(3)

    // The auto-enqueued job exists on the default world.
    const jobs = await request.get(`${API}/worlds/default/jobs`)
    expect(jobs.ok()).toBeTruthy()
    const jobList = await jobs.json() as Array<{ jobId: string; type: string }>
    const job = jobList.find((j) => j.jobId === body.jobId)
    expect(job, 'enqueued job visible on the world').toBeTruthy()
    expect(job!.type).toBe('lingbot-map-reconstruct')
  })

  test('rejects a body with no files field', async ({ request }) => {
    test.skip(!serverUp, 'server unreachable')
    const form = new FormData()
    form.append('name', 'no files')
    const resp = await request.post(`${API}/ingest-photos`, { multipart: form })
    expect(resp.status()).toBe(400)
  })
})
