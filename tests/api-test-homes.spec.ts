/**
 * Test-home corpus pipeline tests — uploads the 24 generated home scans and
 * verifies the full server-side processing loop: job queue → optimization
 * artifacts → manifests → scan list flags → world synthesis.
 *
 * Browser-free (request fixture only). Run under the `api` project against a
 * directly reachable Deno server:
 *
 *   npm run gen:test-data                              # once
 *   SCANS_DIR=/tmp/api-scans INFERENCE_MODE=mock npm run server   # test server
 *   API_URL=http://localhost:8000 npx playwright test --project=api
 */
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const API = process.env['API_URL'] ?? 'http://localhost:8000'
const HOMES_DIR = join(process.cwd(), 'test-data', 'homes')

const homesAvailable = existsSync(join(HOMES_DIR, 'index.json'))

test.describe('test-home scan pipeline', () => {
  test.skip(!homesAvailable, 'test-data missing — run: npm run gen:test-data')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  const uploaded: string[] = []

  test('server is reachable', async ({ request }) => {
    const resp = await request.get(`${API}/health`)
    expect(resp.ok()).toBeTruthy()
  })

  test('uploads all 24 generated homes', async ({ request }) => {
    const index = JSON.parse(readFileSync(join(HOMES_DIR, 'index.json'), 'utf8')) as
      Array<{ file: string; meta: string }>
    expect(index.length).toBeGreaterThanOrEqual(24)

    for (const entry of index) {
      const resp = await request.post(`${API}/upload-scan`, {
        multipart: {
          file: {
            name: entry.file,
            mimeType: 'model/gltf-binary',
            buffer: readFileSync(join(HOMES_DIR, entry.file)),
          },
          metadata: readFileSync(join(HOMES_DIR, entry.meta), 'utf8'),
        },
      })
      expect(resp.ok(), `upload ${entry.file}`).toBeTruthy()
      const body = await resp.json() as { filename: string; job: string }
      expect(body.job).toMatch(/^job-/)
      uploaded.push(body.filename)
    }
    expect(uploaded.length).toBe(index.length)
  })

  test('optimization jobs complete for every home', async ({ request }) => {
    const deadline = Date.now() + 150_000
    let pending = new Set(uploaded)
    while (pending.size > 0 && Date.now() < deadline) {
      const jobs = await (await request.get(`${API}/jobs`)).json() as
        Array<{ target: string; status: string; error?: string }>
      for (const file of [...pending]) {
        const job = jobs.find((j) => j.target === file)
        if (job?.status === 'done') pending.delete(file)
        expect(job?.status, `job for ${file}`).not.toBe('error')
      }
      if (pending.size > 0) await new Promise((r) => setTimeout(r, 1000))
    }
    expect(pending.size, `unfinished: ${[...pending].join(', ')}`).toBe(0)
  })

  test('manifests list optimized + LOD artifacts with sane stats', async ({ request }) => {
    const expected = JSON.parse(readFileSync(join(HOMES_DIR, 'expected.json'), 'utf8')) as
      Record<string, { furniture: unknown[] }>

    for (const file of uploaded) {
      const resp = await request.get(`${API}/scans/${encodeURIComponent(file)}/manifest`)
      expect(resp.ok(), `manifest for ${file}`).toBeTruthy()
      const manifest = await resp.json() as {
        stats: { points: number; triangles: number; sourceBytes: number }
        artifacts: {
          optimized: { filename: string; bytes: number; quantized: boolean }
          lods: Array<{ filename: string; bytes: number; points: number; voxelM: number }>
        }
      }

      // Quantization should always shrink the scan
      expect(manifest.artifacts.optimized.bytes).toBeLessThan(manifest.stats.sourceBytes)
      expect(manifest.artifacts.optimized.quantized).toBe(true)
      // Point-rich homes get LODs, coarsest first, strictly decimated
      expect(manifest.artifacts.lods.length).toBeGreaterThanOrEqual(1)
      for (const lod of manifest.artifacts.lods) {
        expect(lod.points).toBeLessThan(manifest.stats.points)
        expect(lod.bytes).toBeLessThan(manifest.artifacts.optimized.bytes)
      }
      // Detection boxes survive as triangles (12 per furniture box)
      const baseName = file.replace(/^\d+_/, '').replace(/\.glb$/, '')
      const truth = expected[baseName]
      if (truth) {
        expect(manifest.stats.triangles).toBeGreaterThanOrEqual(truth.furniture.length * 12)
      }
    }
  })

  test('scan list shows homes as optimized and hides derived artifacts', async ({ request }) => {
    const scans = await (await request.get(`${API}/scans`)).json() as
      Array<{ filename: string; optimized: boolean }>
    for (const file of uploaded) {
      const entry = scans.find((s) => s.filename === file)
      expect(entry, `scan list entry for ${file}`).toBeTruthy()
      expect(entry!.optimized).toBe(true)
    }
    expect(scans.some((s) => /\.(opt|lod\d+)\.glb$/.test(s.filename))).toBe(false)
  })

  test('a finalized session\'s qualitySummary reaches the world manifest', async ({ request }) => {
    // Parity guard for the linear scan listing (wave 03 / ticket 0005). readScanMeta()
    // merges the session record into the scan's meta, and that merge is what surfaces
    // qualitySummary on the world manifest. It has to be asserted against
    // GET /worlds/default: GET /scans returns only {filename, size, uploadedAt}, so
    // asserting there would be vacuous.
    //
    // This exercises the glbFilename path deliberately — the one the old code swept the
    // whole sessions directory to resolve, and so the one this change actually alters.
    // The generated homes all carry a sessionId in their metadata (session-test-home-NN,
    // for which no session directory exists), which pins them to the explicit-id path and
    // resolves to null. So this uploads a scan whose metadata has no sessionId.
    const index = JSON.parse(readFileSync(join(HOMES_DIR, 'index.json'), 'utf8')) as
      Array<{ file: string; meta: string }>
    const parityFile = 'parity-session-merge.glb'

    const upload = await request.post(`${API}/upload-scan`, {
      multipart: {
        file: {
          name: parityFile,
          mimeType: 'model/gltf-binary',
          buffer: readFileSync(join(HOMES_DIR, index[0].file)),
        },
        metadata: JSON.stringify({ scanName: 'ticket-0005 parity', geoLat: 0, geoLng: 0 }),
      },
    })
    expect(upload.ok(), 'upload parity scan').toBeTruthy()
    const stored = (await upload.json() as { filename: string }).filename

    const session = await (await request.post(`${API}/sessions`)).json() as { sessionId: string }
    const finalize = await request.post(`${API}/sessions/${session.sessionId}/finalize`, {
      data: {
        glbFilename: stored,
        keyframeCount: 42,
        qualitySummary: { coverageScore: 0.87, status: 'needs-review', pointCount: 1234 },
      },
    })
    expect(finalize.ok(), 'finalize').toBeTruthy()

    // refreshWorldScans() re-derives each entry from listStoredScans() on every read.
    let scan: { filename: string; qualitySummary?: { coverageScore?: number; status?: string; pointCount?: number } } | undefined
    await expect.poll(async () => {
      const world = await (await request.get(`${API}/worlds/default`)).json() as
        { scans: Array<{ filename: string; qualitySummary?: { coverageScore?: number; status?: string; pointCount?: number } }> }
      scan = world.scans.find((entry) => entry.filename === stored)
      return scan?.qualitySummary?.coverageScore ?? null
    }, { timeout: 20_000 }).toBe(0.87)

    expect(scan!.qualitySummary!.status).toBe('needs-review')
    expect(scan!.qualitySummary!.pointCount).toBe(1234)

    await request.delete(`${API}/scans/${encodeURIComponent(stored)}`)
  })

  test('derived artifacts are downloadable', async ({ request }) => {
    const file = uploaded[0]
    const base = file.replace(/\.glb$/, '')
    for (const suffix of ['.opt.glb', '.lod1.glb']) {
      const resp = await request.get(`${API}/scans/${encodeURIComponent(base + suffix)}`)
      expect(resp.ok(), `${base}${suffix}`).toBeTruthy()
      expect((await resp.body()).length).toBeGreaterThan(100)
    }
  })

  test('world synthesis includes homes, excludes derived files', async ({ request }) => {
    const world = await (await request.get(`${API}/worlds/default`)).json() as
      { scans: Array<{ filename: string }> }
    expect(world.scans.length).toBeGreaterThan(0)
    expect(world.scans.some((s) => /\.(opt|lod\d+)\.glb$/.test(s.filename))).toBe(false)
    const worldFiles = new Set(world.scans.map((s) => s.filename))
    const included = uploaded.filter((f) => worldFiles.has(f))
    expect(included.length).toBeGreaterThan(0)
  })

  test('deleting a home removes its derived artifacts too', async ({ request }) => {
    const file = uploaded[uploaded.length - 1]
    const resp = await request.delete(`${API}/scans/${encodeURIComponent(file)}`)
    expect(resp.ok()).toBeTruthy()
    const body = await resp.json() as { deleted: { glb: boolean; sidecars: number } }
    expect(body.deleted.glb).toBe(true)
    expect(body.deleted.sidecars).toBeGreaterThanOrEqual(3) // opt + lods + manifest

    const manifest = await request.get(`${API}/scans/${encodeURIComponent(file)}/manifest`)
    expect(manifest.status()).toBe(404)
  })

  test('keyframe session lifecycle works alongside the corpus', async ({ request }) => {
    const session = await (await request.post(`${API}/sessions`)).json() as { sessionId: string }
    expect(session.sessionId).toMatch(/^sess-/)

    const kf = await request.post(`${API}/sessions/${session.sessionId}/keyframes`, {
      multipart: {
        image: { name: 'kf.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
        meta: JSON.stringify({
          index: 0, timestamp: 1, pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
          intrinsics: { fovYDeg: 60, aspect: 0.56, width: 64, height: 48 },
        }),
      },
    })
    expect(kf.ok()).toBeTruthy()

    const finalize = await request.post(`${API}/sessions/${session.sessionId}/finalize`, {
      data: { glbFilename: uploaded[0], pointCount: 1000 },
    })
    expect(finalize.ok()).toBeTruthy()
    const record = await finalize.json() as { keyframeCount: number; glbFilename: string }
    expect(record.keyframeCount).toBe(1)
    expect(record.glbFilename).toBe(uploaded[0])
  })
})
