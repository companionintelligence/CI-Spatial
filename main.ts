/**
 * Deno inference server — Hono HTTP server on :8000
 *
 * POST /infer            multipart/form-data  { image: File }
 *   → 200 JSON  RawDetection[]
 *
 * POST /upload-scan      multipart/form-data  { file: File (.glb), metadata?: string (JSON) }
 *   → 200 JSON  { filename: string }
 *
 * GET  /scans            → 200 JSON  [{ filename, size, uploadedAt }]
 * GET  /scans/:filename  → 200  model/gltf-binary  (serves .glb)
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi main.ts
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { InferenceEngine } from './inference.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8000)
// Allow any port on the Tailscale hostname + localhost (dev flexibility)
const ALLOWED_ORIGIN_PREFIX = Deno.env.get('ALLOWED_ORIGIN_PREFIX') ?? 'https://liam-mbp.capybara-ulmer.ts.net'

const SCANS_DIR = Deno.env.get('SCANS_DIR') ?? './scans'
// Ensure scans directory exists
try { await Deno.mkdir(SCANS_DIR, { recursive: true }) } catch { /* already exists */ }

const engine = new InferenceEngine()
const engineLoadPromise = engine.load().then(() => {
  console.log('[server] Model sessions ready')
}).catch((e) => {
  console.error('[server] Model load failed:', e.message)
  throw e
})

const app = new Hono()

app.use(logger())
app.use(
  cors({
    // Accept any port on the tailscale hostname OR any localhost port.
    // This handles Vite starting on :5173, :5174, etc.
    origin: (origin) => {
      if (!origin) return origin  // same-origin / curl tests
      if (origin.startsWith(ALLOWED_ORIGIN_PREFIX)) return origin
      if (origin.startsWith('https://localhost:') || origin === 'https://localhost') return origin
      return ''
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
)

app.get('/health', (c) => c.json({ status: 'ok', model: engine.modelId }))

app.post('/infer', async (c) => {
  // Wait for ONNX sessions to finish loading (large models take several seconds on first start)
  try { await engineLoadPromise } catch { return c.json({ error: 'Model failed to load — check server/logs' }, 503) }
  const form = await c.req.formData()
  const imageFile = form.get('image')
  if (!imageFile || !(imageFile instanceof File)) {
    return c.json({ error: 'Missing image field' }, 400)
  }

  try {
    const buffer = await imageFile.arrayBuffer()
    console.log(`[infer] Received image: ${buffer.byteLength} bytes`)
    const detections = await engine.infer(new Uint8Array(buffer))
    console.log(`[infer] Returning ${detections.length} detections:`, JSON.stringify(detections))
    return c.json(detections)
  } catch (err) {
    console.error('[infer error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

// ── Scan file storage ─────────────────────────────────────────────────────────

app.post('/upload-scan', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Missing file field (expected .glb)' }, 400)
  }

  // Sanitise filename: strip path components, allow only safe chars.
  const rawName = (file.name || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._-]+/, '') || 'scan'
  const safeName = rawName.endsWith('.glb') ? rawName : `${rawName}.glb`
  const ts = Date.now()
  // Prefix with timestamp to guarantee uniqueness
  const filename = `${ts}_${safeName}`
  const filePath = `${SCANS_DIR}/${filename}`

  try {
    const buffer = await file.arrayBuffer()
    await Deno.writeFile(filePath, new Uint8Array(buffer))
    console.log(`[scan] Saved ${filename} (${(buffer.byteLength / 1024).toFixed(0)} KB)`)

    // Optional metadata JSON alongside the .glb
    const metaRaw = form.get('metadata')
    if (metaRaw && typeof metaRaw === 'string') {
      const metaPath = filePath.replace(/\.glb$/, '.json')
      await Deno.writeTextFile(metaPath, metaRaw)
    }

    return c.json({ filename, size: buffer.byteLength })
  } catch (err) {
    console.error('[scan upload error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/scans', async (c) => {
  try {
    const entries: Array<{ filename: string; size: number; uploadedAt: string }> = []
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.glb')) continue
      const stat = await Deno.stat(`${SCANS_DIR}/${entry.name}`)
      entries.push({
        filename: entry.name,
        size: stat.size,
        uploadedAt: (stat.mtime ?? new Date()).toISOString(),
      })
    }
    entries.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    return c.json(entries)
  } catch (err) {
    console.error('[scans list error]', err)
    return c.json([], 200)
  }
})

app.get('/scans/:filename', async (c) => {
  const filename = c.req.param('filename')
  // Prevent path traversal
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
    return c.json({ error: 'Invalid filename' }, 400)
  }
  if (!filename.endsWith('.glb')) {
    return c.json({ error: 'Only .glb files are served' }, 400)
  }

  const filePath = `${SCANS_DIR}/${filename}`
  try {
    const data = await Deno.readFile(filePath)
    return new Response(data, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return c.json({ error: 'Scan not found' }, 404)
  }
})
console.log(`[server] CORS origin prefix: ${ALLOWED_ORIGIN_PREFIX}`)

Deno.serve({ port: PORT }, app.fetch)
