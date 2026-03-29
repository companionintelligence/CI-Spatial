/**
 * Deno inference server — Hono HTTP server on :8000
 *
 * POST /infer   multipart/form-data  { image: File }
 *   → 200 JSON  RawDetection[]
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-env server/main.ts
 *
 * Or with hot-reload:
 *   deno run --watch --allow-net --allow-read --allow-env server/main.ts
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { InferenceEngine } from './inference.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8000)
// Allow any port on the Tailscale hostname + localhost (dev flexibility)
const ALLOWED_ORIGIN_PREFIX = Deno.env.get('ALLOWED_ORIGIN_PREFIX') ?? 'https://liam-mbp.capybara-ulmer.ts.net'

const engine = new InferenceEngine()
let engineReady = false
engine.load().then(() => { engineReady = true }).catch((e) => {
  console.error('[server] Model load failed — /infer will return 503 until models are present:', e.message)
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
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
)

app.get('/health', (c) => c.json({ status: 'ok', model: engine.modelId }))

app.post('/infer', async (c) => {
  if (!engineReady) return c.json({ error: 'Model not loaded — place model files in server/models/ and restart' }, 503)
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

console.log(`[server] listening on :${PORT}`)
console.log(`[server] CORS origin prefix: ${ALLOWED_ORIGIN_PREFIX}`)

Deno.serve({ port: PORT }, app.fetch)
