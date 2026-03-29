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
// Allow the Tailscale origin (HTTPS because Vite uses self-signed SSL)
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://liam-mbp.capybara-ulmer.ts.net:5173'

const engine = new InferenceEngine()
let engineReady = false
engine.load().then(() => { engineReady = true }).catch((e) => {
  console.error('[server] Model load failed — /infer will return 503 until models are present:', e.message)
})

const app = new Hono()

app.use(logger())
app.use(
  cors({
    origin: [ALLOWED_ORIGIN, 'https://localhost:5173'],
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
    const detections = await engine.infer(new Uint8Array(buffer))
    return c.json(detections)
  } catch (err) {
    console.error('[infer error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

console.log(`[server] listening on :${PORT}`)
console.log(`[server] CORS origin: ${ALLOWED_ORIGIN}`)

Deno.serve({ port: PORT }, app.fetch)
