/**
 * Deno inference server — Hono HTTP server on :8000
 *
 * POST /infer              multipart { image: File }   → RawDetection[]
 * POST /upload-scan        multipart { file: File(.glb), metadata?: JSON } → { filename, job }
 * GET  /scans              → [{ filename, size, uploadedAt, optimized, job }]
 * GET  /scans/:filename    → model/gltf-binary (source or derived artifact)
 * GET  /scans/:filename/manifest     → optimization manifest (artifacts + stats)
 * POST /scans/:filename/optimize     → (re-)enqueue optimization job
 * DELETE /scans/:filename            → delete stored .glb + sidecars + derived artifacts
 * DELETE /scans?confirm=delete-all   → clear scan storage (test reset)
 * GET  /jobs               → Job[]   (processing queue state)
 * GET  /jobs/:id           → Job
 * POST /sessions                       → { sessionId } — begin keyframe capture session
 * POST /sessions/:id/keyframes         multipart { image, meta } → { ok, index }
 * POST /sessions/:id/finalize          JSON { glbFilename?, … } → session record
 * GET  /sessions/:id                   → session record
 * POST /upload-summary     multipart { file: File(.md) } → { filename }
 * POST /process-scan       JSON { filename, action, sessionId? } → { action, result }
 * GET  /projects           → Project[]
 * POST /projects           JSON { name, address?, notes? } → Project
 * GET  /projects/:id       → Project
 * PUT  /projects/:id       JSON (Project) → Project
 * DELETE /projects/:id     → { ok: true }
 * GET  /rtc-signal         WebSocket upgrade — WebRTC signaling relay
 * GET  /events             WebSocket upgrade — server event broadcast (scans/jobs)
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi main.ts
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { InferenceEngine } from './inference.ts'
import { JobQueue } from './jobs.ts'
import { composeYUpTransform, geoToEnu, hasGeoPose } from './src/world/geo.ts'
import { defaultLayerIndex } from './src/world/layers.ts'
import type {
  EditPatch,
  FrameObservation,
  GeoPose,
  MemberRole,
  ScanManifest,
  ScanManifestStatus,
  ScanQualitySummary,
  WorldJob,
  WorldJobType,
  WorldMember,
  WorldProject,
} from './src/world/types.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8000)
const ALLOWED_ORIGIN_PREFIX = Deno.env.get('ALLOWED_ORIGIN_PREFIX') ?? 'https://liambook.capybara-ulmer.ts.net'

const SCANS_DIR    = Deno.env.get('SCANS_DIR')    ?? './scans'
const SUMMARIES_DIR = Deno.env.get('SUMMARIES_DIR') ?? './summaries'
const SESSIONS_DIR = Deno.env.get('SESSIONS_DIR') ?? `${SCANS_DIR}/sessions`
const WORLDS_DIR = Deno.env.get('WORLDS_DIR') ?? './worlds'
const MAX_KEYFRAMES_PER_SESSION = 2000
const WORLD_STRICT_AUTH = Deno.env.get('WORLD_STRICT_AUTH') === '1'

function isAllowedOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true
    if (hostname.endsWith('.ts.net')) return true
    if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true
    if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)) return true
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(hostname)) return true
    return origin.startsWith(ALLOWED_ORIGIN_PREFIX)
  } catch {
    return false
  }
}

for (const dir of [SCANS_DIR, SUMMARIES_DIR, SESSIONS_DIR, WORLDS_DIR]) {
  try { await Deno.mkdir(dir, { recursive: true }) } catch { /* already exists */ }
}

// ── Event broadcast hub (/events WebSocket) ───────────────────────────────────
const eventSockets = new Set<WebSocket>()

function broadcast(event: Record<string, unknown>): void {
  const msg = JSON.stringify({ ...event, at: Date.now() })
  for (const ws of eventSockets) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    } catch { /* client gone — close handler will clean up */ }
  }
}

const jobQueue = new JobQueue(SCANS_DIR, broadcast)
await jobQueue.init()

let modelLoaded = false
const engine = new InferenceEngine()
const engineLoadPromise = engine.load().then(() => {
  console.log('[server] Model sessions ready')
  modelLoaded = true
}).catch((e) => {
  console.error('[server] Model load failed:', e.message)
  console.error('[server] Running in server-only mode (VLM inference will be unavailable/fallback to WebGPU)')
})

const app = new Hono()

app.onError((err, c) => {
  console.error('[server-error]', err)
  return c.json({ error: err.message }, 500)
})

app.use(logger())
app.use(
  cors({
    origin: (origin) => {
      console.log(`[server] CORS check: origin=${origin}, prefix=${ALLOWED_ORIGIN_PREFIX}`)
      if (!origin) return ALLOWED_ORIGIN_PREFIX
      if (isAllowedOrigin(origin)) {
        return origin
      }
      console.warn(`[server] CORS rejected origin: ${origin}`)
      return ''
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
)

app.get('/health', (c) => c.json({ status: 'ok', model: engine.modelId, modelReady: modelLoaded }))

app.post('/infer', async (c) => {
  const form = await c.req.formData()
  const imageFile = form.get('image')
  if (!imageFile || !(imageFile instanceof File)) {
    return c.json({ error: 'Missing image field' }, 400)
  }

  // Wait for ONNX sessions to finish loading (large models take several seconds on first start)
  await engineLoadPromise
  if (!modelLoaded) {
    return c.json({ error: 'Model failed to load on server — running in server-only mode. Install local models or use WebGPU fallback.' }, 503)
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
  console.log('[server] /upload-scan route triggered')
  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    console.warn('[server] /upload-scan: Missing file field')
    return c.json({ error: 'Missing file field (expected .glb)' }, 400)
  }

  // Sanitise filename: strip path components, allow only safe chars, remove double dots.
  const rawName = (file.name || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\./g, '__')
    .replace(/^[._-]+/, '') || 'scan'
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
      console.log(`[scan] Saved metadata for ${filename}`)
    }

    // Every uploaded scan is optimized automatically (quantize/Draco/LODs)
    const job = jobQueue.enqueue('optimize-scan', filename)
    broadcast({ type: 'scan-added', filename, size: buffer.byteLength })

    return c.json({ filename, size: buffer.byteLength, job: job.id })
  } catch (err) {
    console.error('[scan upload error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

/** True for pipeline-derived artifacts that shouldn't appear in the scan list */
function isDerivedScanFile(name: string): boolean {
  return /\.(opt|lod\d+)\.glb$/.test(name)
}

/** Sanitised scan filename or null when the input is unsafe */
function safeScanName(raw: string): string | null {
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.startsWith('.')) return null
  return raw
}

app.get('/scans', async (c) => {
  try {
    const entries: Array<{
      filename: string
      size: number
      uploadedAt: string
      optimized: boolean
      job: { status: string; note: string | null } | null
    }> = []
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.glb')) continue
      if (isDerivedScanFile(entry.name)) continue
      const stat = await Deno.stat(`${SCANS_DIR}/${entry.name}`)
      let optimized = false
      try {
        await Deno.stat(`${SCANS_DIR}/${entry.name.replace(/\.glb$/, '.manifest.json')}`)
        optimized = true
      } catch { /* not optimized yet */ }
      const job = jobQueue.jobForTarget(entry.name)
      entries.push({
        filename: entry.name,
        size: stat.size,
        uploadedAt: (stat.mtime ?? new Date()).toISOString(),
        optimized,
        job: job ? { status: job.status, note: job.note ?? null } : null,
      })
    }
    entries.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    return c.json(entries)
  } catch (err) {
    console.error('[scans list error]', err)
    return c.json([], 200)
  }
})

// ── Scan manifest + manual re-optimize ────────────────────────────────────────
// (Semantic edit persistence lives in the worlds patch system: /worlds/:slug/patches)

app.get('/scans/:filename/manifest', async (c) => {
  const filename = safeScanName(c.req.param('filename'))
  if (!filename || !filename.endsWith('.glb')) return c.json({ error: 'Invalid filename' }, 400)
  try {
    const raw = await Deno.readTextFile(`${SCANS_DIR}/${filename.replace(/\.glb$/, '.manifest.json')}`)
    return c.json(JSON.parse(raw))
  } catch {
    return c.json({ error: 'No manifest — scan not optimized yet' }, 404)
  }
})

app.post('/scans/:filename/optimize', async (c) => {
  const filename = safeScanName(c.req.param('filename'))
  if (!filename || !filename.endsWith('.glb') || isDerivedScanFile(filename)) {
    return c.json({ error: 'Invalid filename' }, 400)
  }
  try {
    await Deno.stat(`${SCANS_DIR}/${filename}`)
  } catch {
    return c.json({ error: 'Scan not found' }, 404)
  }
  const job = jobQueue.enqueue('optimize-scan', filename)
  return c.json(job, 202)
})

// ── Job queue state ───────────────────────────────────────────────────────────

app.get('/jobs', (c) => c.json([...jobQueue.jobs].reverse()))

app.get('/jobs/:id', (c) => {
  const job = jobQueue.job(c.req.param('id'))
  return job ? c.json(job) : c.json({ error: 'Not found' }, 404)
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

// ── Scan deletion ─────────────────────────────────────────────────────────────

async function removeIfExists(path: string): Promise<boolean> {
  try {
    await Deno.remove(path)
    return true
  } catch {
    return false
  }
}

/** All pipeline-derived sidecars for a scan (deleted alongside the source) */
function derivedArtifactPaths(filename: string): string[] {
  const base = filename.replace(/\.glb$/, '')
  return [
    `${SCANS_DIR}/${base}.opt.glb`,
    `${SCANS_DIR}/${base}.lod1.glb`,
    `${SCANS_DIR}/${base}.lod2.glb`,
    `${SCANS_DIR}/${base}.manifest.json`,
  ]
}

app.delete('/scans/:filename', async (c) => {
  const filename = safeScanName(c.req.param('filename'))
  if (!filename || !filename.endsWith('.glb') || isDerivedScanFile(filename)) {
    return c.json({ error: 'Invalid filename' }, 400)
  }
  try {
    const deletedGlb = await removeIfExists(`${SCANS_DIR}/${filename}`)
    const deletedMetadata = await removeIfExists(scanMetaPath(filename))
    let deletedSidecars = 0
    for (const path of derivedArtifactPaths(filename)) {
      if (await removeIfExists(path)) deletedSidecars += 1
    }
    if (!deletedGlb && !deletedMetadata && deletedSidecars === 0) return c.json({ error: 'Scan not found' }, 404)
    await removeScanFromWorlds(filename)
    broadcast({ type: 'scan-deleted', filename })
    return c.json({ ok: true, filename, deleted: { glb: deletedGlb, metadata: deletedMetadata, sidecars: deletedSidecars } })
  } catch (err) {
    console.error('[scan delete error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.delete('/scans', async (c) => {
  const confirm = c.req.query('confirm')
  if (confirm !== 'delete-all') {
    return c.json({ error: 'Add ?confirm=delete-all to clear scan storage' }, 400)
  }
  let deleted = 0
  try {
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile) continue
      if (!entry.name.endsWith('.glb') && !entry.name.endsWith('.json')) continue
      if (await removeIfExists(`${SCANS_DIR}/${entry.name}`)) deleted += 1
    }
    await removeAllScansFromWorlds()
    broadcast({ type: 'scans-cleared', deleted })
    return c.json({ ok: true, deleted })
  } catch (err) {
    console.error('[scans clear error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

// ── Capture sessions — streaming keyframe ingestion ──────────────────────────
//
// The phone opens a session when scanning starts and streams pose-tagged
// keyframes (JPEG + JSON meta) while the user walks the room.  Frames land in
//   scans/sessions/<id>/kf-NNNNN.jpg        image
//   scans/sessions/<id>/keyframes.jsonl     one meta record per frame
// On finalize the session is linked to the exported .glb.  This is the raw
// input a dense-reconstruction stage (photogrammetry / splats) consumes.

const SESSION_ID_RE = /^(sess|session)-[a-z0-9-]+$/
const KEYFRAME_FILE_RE = /^kf-\d{5}\.jpg$/

function sessionDir(id: string): string | null {
  return SESSION_ID_RE.test(id) ? `${SESSIONS_DIR}/${id}` : null
}

app.post('/sessions', async (c) => {
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await Deno.mkdir(`${SESSIONS_DIR}/${sessionId}`, { recursive: true })
  const record = { sessionId, startedAt: new Date().toISOString(), keyframeCount: 0 }
  await Deno.writeTextFile(`${SESSIONS_DIR}/${sessionId}/session.json`, JSON.stringify(record, null, 2))
  console.log(`[session] opened ${sessionId}`)
  broadcast({ type: 'session-started', sessionId })
  return c.json(record, 201)
})

app.post('/sessions/:id/keyframes', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  try {
    await Deno.stat(dir)
  } catch {
    return c.json({ error: 'Session not found' }, 404)
  }

  const form = await c.req.formData()
  const image = form.get('image')
  const metaRaw = form.get('meta')
  if (!image || !(image instanceof File)) return c.json({ error: 'Missing image field' }, 400)
  if (typeof metaRaw !== 'string') return c.json({ error: 'Missing meta field' }, 400)

  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(metaRaw) as Record<string, unknown>
  } catch {
    return c.json({ error: 'meta is not valid JSON' }, 400)
  }
  const index = Number.isInteger(meta['index']) ? meta['index'] as number : -1
  if (index < 0 || index >= MAX_KEYFRAMES_PER_SESSION) {
    return c.json({ error: `index must be 0…${MAX_KEYFRAMES_PER_SESSION - 1}` }, 400)
  }

  try {
    const bytes = new Uint8Array(await image.arrayBuffer())
    const name = `kf-${String(index).padStart(5, '0')}.jpg`
    await Deno.writeFile(`${dir}/${name}`, bytes)
    await Deno.writeTextFile(
      `${dir}/keyframes.jsonl`,
      JSON.stringify({ ...meta, file: name, bytes: bytes.byteLength, receivedAt: Date.now() }) + '\n',
      { append: true },
    )
    return c.json({ ok: true, index })
  } catch (err) {
    console.error('[session keyframe error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/sessions/:id/keyframes/:file', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  const file = c.req.param('file')
  if (!dir || !KEYFRAME_FILE_RE.test(file)) return c.json({ error: 'Invalid keyframe path' }, 400)
  try {
    const data = await Deno.readFile(`${dir}/${file}`)
    return new Response(data, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return c.json({ error: 'Keyframe not found' }, 404)
  }
})

app.post('/sessions/:id/finalize', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  let record: Record<string, unknown>
  try {
    record = JSON.parse(await Deno.readTextFile(`${dir}/session.json`)) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Session not found' }, 404)
  }

  const body = await c.req.json().catch(() => ({})) as {
    glbFilename?: string
    pointCount?: number
    detectionCount?: number
    poseCount?: number
    qualitySummary?: ScanQualitySummary
  }

  let keyframeCount = 0
  try {
    const jsonl = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
    keyframeCount = jsonl.split('\n').filter(Boolean).length
  } catch { /* no keyframes uploaded */ }

  const glbFilename = body.glbFilename ? safeScanName(body.glbFilename) : null
  record = {
    ...record,
    keyframeCount,
    finalizedAt: new Date().toISOString(),
    glbFilename,
    pointCount: body.pointCount ?? null,
    detectionCount: body.detectionCount ?? null,
    poseCount: body.poseCount ?? null,
    qualitySummary: body.qualitySummary ?? null,
  }
  await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
  console.log(`[session] finalized ${record['sessionId']} — ${keyframeCount} keyframes` +
    (glbFilename ? ` → ${glbFilename}` : ''))

  if (glbFilename?.endsWith('.glb')) {
    try {
      await Deno.stat(`${SCANS_DIR}/${glbFilename}`)
      // Skip when upload-scan's job already produced a manifest
      try {
        await Deno.stat(`${SCANS_DIR}/${glbFilename.replace(/\.glb$/, '.manifest.json')}`)
      } catch {
        jobQueue.enqueue('optimize-scan', glbFilename)
      }
    } catch { /* glb not uploaded yet — upload-scan enqueues on arrival */ }
  }
  broadcast({ type: 'session-finalized', sessionId: record['sessionId'], keyframeCount, glbFilename })
  return c.json(record)
})

app.get('/sessions/:id', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  try {
    return c.json(JSON.parse(await Deno.readTextFile(`${dir}/session.json`)))
  } catch {
    return c.json({ error: 'Session not found' }, 404)
  }
})

app.get('/sessions', async (c) => {
  const sessions: unknown[] = []
  try {
    for await (const entry of Deno.readDir(SESSIONS_DIR)) {
      if (!entry.isDirectory) continue
      try {
        sessions.push(JSON.parse(await Deno.readTextFile(`${SESSIONS_DIR}/${entry.name}/session.json`)))
      } catch { /* incomplete session dir */ }
    }
  } catch { /* sessions dir missing */ }
  return c.json(sessions)
})

// ── Upload session summary (.md) ──────────────────────────────────────────────

// ── GET /scan-locations — geo metadata for all scans ─────────────────────────
// Reads the companion .json files saved alongside each .glb
app.get('/scan-locations', async (c) => {
  try {
    const locations: Record<string, unknown>[] = []
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.glb')) continue
      const metaPath = `${SCANS_DIR}/${entry.name.replace(/\.glb$/, '.json')}`
      let meta: Record<string, unknown> = {}
      try {
        meta = JSON.parse(await Deno.readTextFile(metaPath)) as Record<string, unknown>
      } catch { /* no companion metadata */ }

      // Only include scans that have GPS data
      if (typeof meta['geoLat'] !== 'number' || typeof meta['geoLng'] !== 'number') continue
      if (meta['geoLat'] === 0 && meta['geoLng'] === 0) continue

      locations.push({
        filename:       entry.name,
        lat:            meta['geoLat'],
        lng:            meta['geoLng'],
        bearing:        meta['geoBearing']  ?? null,
        address:        meta['geoAddress']  ?? null,
        capturedAt:     meta['capturedAt']  ?? null,
        pointCount:     meta['pointCount']  ?? null,
        detectionCount: meta['detectionCount'] ?? null,
        scanName:       meta['scanName']    ?? null,
      })
    }
    locations.sort((a, b) =>
      ((b['capturedAt'] as string) ?? '').localeCompare((a['capturedAt'] as string) ?? ''))
    return c.json(locations)
  } catch (err) {
    console.error('[scan-locations error]', err)
    return c.json([], 200)
  }
})

// ── World projects, edit patches, and processing jobs ────────────────────────

const WORLD_JOB_TYPES = new Set<WorldJobType>([
  'ingest',
  'extract-layers',
  'align-scan',
  'merge-points',
  'semantic-pass',
  'depth-reconstruct',
  'splat-train',
  'export-world',
])

const DEFAULT_WORKER_CAPABILITIES = ['cpu', 'onnx', 'ollama', 'open3d', 'splat', 'vggt']

interface StoredScanInfo {
  filename: string
  size: number
  uploadedAt: string
  meta: Record<string, unknown>
}

function safeSlug(raw: string | undefined, fallback = 'default'): string {
  const slug = (raw ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || fallback
}

function worldPath(slug: string): string {
  return `${WORLDS_DIR}/${safeSlug(slug)}.json`
}

function scanMetaPath(filename: string): string {
  return `${SCANS_DIR}/${filename.replace(/\.glb$/, '.json')}`
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function geoPoseFromMeta(meta: Record<string, unknown>): GeoPose {
  return {
    lat: asNumber(meta['geoLat']),
    lng: asNumber(meta['geoLng']),
    altitudeM: asNumber(meta['geoAltitudeM']),
    bearing: asNumber(meta['geoBearing']),
    accuracyM: asNumber(meta['geoAccuracy']),
    fixedAt: asString(meta['geoFixedAt']),
    address: asString(meta['geoAddress']),
    displayAddress: asString(meta['geoDisplayAddress']),
  }
}

async function readScanMeta(filename: string): Promise<Record<string, unknown>> {
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(await Deno.readTextFile(scanMetaPath(filename))) as Record<string, unknown>
  } catch {
    meta = {}
  }
  const session = await readSessionRecordForScan(filename, meta)
  if (!session) return meta
  return {
    ...session,
    ...meta,
    keyframeCount: asNumber(meta['keyframeCount']) ?? asNumber(session['keyframeCount']) ?? 0,
    qualitySummary: meta['qualitySummary'] ?? session['qualitySummary'] ?? null,
  }
}

async function readSessionRecordForScan(
  filename: string,
  meta: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const explicit = asString(meta['sessionId'])
  const candidates: string[] = explicit ? [explicit] : []
  try {
    for await (const entry of Deno.readDir(SESSIONS_DIR)) {
      if (!entry.isDirectory) continue
      if (explicit && entry.name !== explicit) continue
      try {
        const record = JSON.parse(await Deno.readTextFile(`${SESSIONS_DIR}/${entry.name}/session.json`)) as Record<string, unknown>
        if (entry.name === explicit || record['glbFilename'] === filename) return record
      } catch { /* incomplete session dir */ }
    }
  } catch { /* sessions dir missing */ }

  for (const sessionId of candidates) {
    try {
      return JSON.parse(await Deno.readTextFile(`${SESSIONS_DIR}/${sessionId}/session.json`)) as Record<string, unknown>
    } catch { /* not found */ }
  }
  return null
}

function qualitySummaryFromMeta(meta: Record<string, unknown>): ScanQualitySummary | null {
  const embedded = meta['qualitySummary']
  if (embedded && typeof embedded === 'object') {
    const summary = embedded as Partial<ScanQualitySummary>
    if (typeof summary.coverageScore === 'number' && typeof summary.status === 'string') {
      return {
        coverageScore: summary.coverageScore,
        coverageText: summary.coverageText ?? coverageLabel(summary.coverageScore),
        pointCount: summary.pointCount ?? asNumber(meta['pointCount']) ?? 0,
        detectionCount: summary.detectionCount ?? asNumber(meta['detectionCount']) ?? 0,
        poseCount: summary.poseCount ?? asNumber(meta['poseCount']) ?? 0,
        keyframeCount: summary.keyframeCount ?? asNumber(meta['keyframeCount']) ?? 0,
        lowLightFrames: summary.lowLightFrames ?? asNumber(meta['qualityLowLightFrames']) ?? 0,
        driftEvents: summary.driftEvents ?? asNumber(meta['qualityDriftEvents']) ?? 0,
        reflectiveWarnings: summary.reflectiveWarnings ?? asNumber(meta['qualityReflectiveWarnings']) ?? 0,
        missingAreas: summary.missingAreas ?? asNumber(meta['qualityMissingAreas']) ?? 0,
        trackingLost: summary.trackingLost ?? false,
        status: summary.status === 'needs-rescan' || summary.status === 'needs-review' ? summary.status : 'ready',
        recommendations: Array.isArray(summary.recommendations)
          ? summary.recommendations.filter((item): item is string => typeof item === 'string')
          : asStringArray(meta['qualityRecommendations']),
        capturedAt: summary.capturedAt ?? asString(meta['capturedAt']) ?? new Date().toISOString(),
      }
    }
  }

  const coverage = asNumber(meta['qualityCoverageScore'])
  if (coverage === null) return null
  const pointCount = asNumber(meta['pointCount']) ?? 0
  const recommendations = asStringArray(meta['qualityRecommendations'])
  const status = asString(meta['qualityStatus'])
  return {
    coverageScore: coverage,
    coverageText: coverageLabel(coverage),
    pointCount,
    detectionCount: asNumber(meta['detectionCount']) ?? 0,
    poseCount: asNumber(meta['poseCount']) ?? 0,
    keyframeCount: asNumber(meta['keyframeCount']) ?? 0,
    lowLightFrames: asNumber(meta['qualityLowLightFrames']) ?? 0,
    driftEvents: asNumber(meta['qualityDriftEvents']) ?? 0,
    reflectiveWarnings: asNumber(meta['qualityReflectiveWarnings']) ?? 0,
    missingAreas: asNumber(meta['qualityMissingAreas']) ?? 0,
    trackingLost: false,
    status: status === 'needs-rescan' || status === 'needs-review'
      ? status
      : pointCount < 75 || coverage < 0.25 ? 'needs-rescan' : recommendations.length > 0 || coverage < 0.8 ? 'needs-review' : 'ready',
    recommendations,
    capturedAt: asString(meta['capturedAt']) ?? new Date().toISOString(),
  }
}

function coverageLabel(score: number): string {
  if (score < 0.25) return 'Low - rescan recommended'
  if (score < 0.55) return 'Partial - scan more surfaces'
  if (score < 0.80) return 'Good - review gaps'
  return 'Excellent'
}

function scanStatusFromQuality(meta: Record<string, unknown>): ScanManifestStatus {
  const quality = qualitySummaryFromMeta(meta)
  if (!quality) return 'ready'
  return quality.status
}

async function listStoredScans(): Promise<StoredScanInfo[]> {
  const scans: StoredScanInfo[] = []
  for await (const entry of Deno.readDir(SCANS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.glb')) continue
    if (isDerivedScanFile(entry.name)) continue // .opt/.lodN artifacts aren't standalone scans
    const stat = await Deno.stat(`${SCANS_DIR}/${entry.name}`)
    scans.push({
      filename: entry.name,
      size: stat.size,
      uploadedAt: (stat.mtime ?? new Date()).toISOString(),
      meta: await readScanMeta(entry.name),
    })
  }
  scans.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
  return scans
}

function shouldIncludeInWorld(scan: StoredScanInfo): boolean {
  const geo = geoPoseFromMeta(scan.meta)
  return scan.size > 512
    || hasGeoPose(geo)
    || qualitySummaryFromMeta(scan.meta) !== null
    || asString(scan.meta['sessionId']) !== null
    || asNumber(scan.meta['pointCount']) !== null
    || asNumber(scan.meta['poseCount']) !== null
    || asNumber(scan.meta['detectionCount']) !== null
}

function inferWorldOrigin(scans: StoredScanInfo[]): GeoPose {
  for (const scan of scans) {
    const geo = geoPoseFromMeta(scan.meta)
    if (hasGeoPose(geo)) return geo
  }
  return { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
}

function scanIdFor(filename: string, meta: Record<string, unknown>): string {
  const sessionId = asString(meta['sessionId'])
  if (sessionId) return `scan-${safeSlug(sessionId)}`
  return `scan-${safeSlug(filename.replace(/\.glb$/, ''))}`
}

function scanNameFor(filename: string, meta: Record<string, unknown>): string {
  return asString(meta['scanName']) ?? filename.replace(/^\d+_/, '').replace(/\.glb$/, '')
}

function scanManifestFromStored(
  scan: StoredScanInfo,
  origin: GeoPose,
  index: number,
  slug: string,
): ScanManifest {
  const geoPose = geoPoseFromMeta(scan.meta)
  const scanId = scanIdFor(scan.filename, scan.meta)
  const qualitySummary = qualitySummaryFromMeta(scan.meta)
  const translation = hasGeoPose(origin) && hasGeoPose(geoPose)
    ? geoToEnu(origin, geoPose)
    : { x: (index % 6) * 3, y: 0, z: Math.floor(index / 6) * 3 }
  const localToWorld = composeYUpTransform(translation, geoPose.bearing, 1)

  return {
    scanId,
    sessionId: asString(scan.meta['sessionId']),
    filename: scan.filename,
    name: scanNameFor(scan.filename, scan.meta),
    glbUrl: `/scans/${encodeURIComponent(scan.filename)}`,
    metadataUrl: `/scans/${encodeURIComponent(scan.filename.replace(/\.glb$/, '.json'))}`,
    geoPose,
    localToWorld,
    accuracyM: geoPose.accuracyM,
    capturedAt: asString(scan.meta['capturedAt']) ?? asString(scan.meta['exportedAt']) ?? scan.uploadedAt,
    pointCount: asNumber(scan.meta['pointCount']),
    detectionCount: asNumber(scan.meta['detectionCount']),
    layerIndex: defaultLayerIndex(scan.meta),
    frameSetUrl: asString(scan.meta['sessionId'])
      ? `/worlds/${encodeURIComponent(safeSlug(slug))}/frames/${encodeURIComponent(scanId)}`
      : undefined,
    qualitySummary,
    status: scanStatusFromQuality(scan.meta),
  }
}

function createWorldMembers(): WorldMember[] {
  const now = new Date().toISOString()
  return (['owner', 'editor', 'viewer', 'scanner'] as const).map((role) => ({
    memberId: `${role}-${crypto.randomUUID()}`,
    role,
    token: `${role}-${crypto.randomUUID()}`,
    createdAt: now,
    expiresAt: null,
  }))
}

async function saveWorld(world: WorldProject): Promise<void> {
  world.updatedAt = new Date().toISOString()
  const tmp = `${worldPath(world.shareSlug)}.${crypto.randomUUID()}.tmp`
  await Deno.writeTextFile(tmp, JSON.stringify(world, null, 2))
  await Deno.rename(tmp, worldPath(world.shareSlug))
}

async function synthesizeWorld(slug: string): Promise<WorldProject> {
  const stored = await listStoredScans()
  const included = stored.filter(shouldIncludeInWorld).slice(0, 24)
  const source = included.length > 0 ? included : stored.slice(0, 8)
  const originGeoPose = inferWorldOrigin(source)
  const now = new Date().toISOString()
  const world: WorldProject = {
    worldId: `world-${safeSlug(slug)}`,
    name: slug === 'default' ? 'Default World Scan' : slug.replace(/-/g, ' '),
    shareSlug: safeSlug(slug),
    originGeoPose,
    localFrame: {
      type: 'ENU_Y_UP',
      origin: originGeoPose,
      units: 'meters',
      axes: { x: 'east', y: 'up', z: 'north' },
    },
    scans: source.map((scan, i) => scanManifestFromStored(scan, originGeoPose, i, slug)),
    members: createWorldMembers(),
    jobs: [],
    editPatches: [],
    createdAt: now,
    updatedAt: now,
  }
  await saveWorld(world)
  return world
}

/** Apply a mutator to every stored world file; returns how many were updated */
async function mutateWorldFiles(mutator: (world: WorldProject) => boolean | Promise<boolean>): Promise<number> {
  let updated = 0
  try {
    for await (const entry of Deno.readDir(WORLDS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        const world = JSON.parse(await Deno.readTextFile(`${WORLDS_DIR}/${entry.name}`)) as WorldProject
        if (await mutator(world)) {
          await saveWorld(world)
          updated += 1
        }
      } catch (error) {
        console.warn(`[world] Could not mutate ${entry.name}:`, error)
      }
    }
  } catch { /* worlds directory may be empty */ }
  return updated
}

async function removeScanFromWorlds(filename: string): Promise<number> {
  return mutateWorldFiles((world) => {
    const beforeScans = world.scans.length
    world.scans = world.scans.filter(scan => scan.filename !== filename)
    world.editPatches = world.editPatches.filter(patch => patch.targetId !== filename && patch.scanId !== filename)
    world.jobs = world.jobs.filter(job => {
      if (!job.scanId) return true
      return world.scans.some(scan => scan.scanId === job.scanId)
    })
    return world.scans.length !== beforeScans
  })
}

async function removeAllScansFromWorlds(): Promise<number> {
  return mutateWorldFiles((world) => {
    const hadScans = world.scans.length > 0
    world.scans = []
    world.editPatches = world.editPatches.filter(patch => patch.scope === 'world')
    world.jobs = world.jobs.filter(job => !job.scanId)
    world.originGeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
    world.localFrame.origin = world.originGeoPose
    return hadScans
  })
}

async function loadWorld(slug: string): Promise<WorldProject> {
  const safe = safeSlug(slug)
  try {
    const world = JSON.parse(await Deno.readTextFile(worldPath(safe))) as WorldProject
    await refreshWorldScans(world)
    return world
  } catch {
    return synthesizeWorld(safe)
  }
}

async function refreshWorldScans(world: WorldProject): Promise<void> {
  const stored = await listStoredScans()
  const storedByFilename = new Map(stored.map(scan => [scan.filename, scan]))
  let changed = false

  world.scans = world.scans.map((scan, index) => {
    const storedScan = storedByFilename.get(scan.filename)
    if (!storedScan) return scan
    const next = scanManifestFromStored(storedScan, world.originGeoPose, index, world.shareSlug)
    changed = changed
      || scan.status !== next.status
      || scan.frameSetUrl !== next.frameSetUrl
      || JSON.stringify(scan.qualitySummary ?? null) !== JSON.stringify(next.qualitySummary ?? null)
      || JSON.stringify(scan.layerIndex) !== JSON.stringify(next.layerIndex)
    return { ...scan, ...next, localToWorld: scan.localToWorld, name: scan.name || next.name }
  })

  const existing = new Set(world.scans.map(scan => scan.filename))
  const additions = stored
    .filter(shouldIncludeInWorld)
    .filter(scan => !existing.has(scan.filename))
    .slice(0, 12)
  if (additions.length === 0) {
    if (changed) await saveWorld(world)
    return
  }

  const origin = world.originGeoPose
  const nextIndex = world.scans.length
  world.scans.push(...additions.map((scan, i) => scanManifestFromStored(scan, origin, nextIndex + i, world.shareSlug)))
  await saveWorld(world)
}

/** Best client-facing base URL: request origin → forwarded host → Vite default */
function clientBaseUrl(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const origin = c.req.header('origin')
  if (origin && isAllowedOrigin(origin)) return origin

  const forwardedHost = c.req.header('x-forwarded-host')
  if (forwardedHost) {
    const forwardedProto = c.req.header('x-forwarded-proto') ?? 'https'
    return `${forwardedProto}://${forwardedHost}`
  }

  const url = new URL(c.req.url)
  if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === String(PORT)) {
    return viteBaseUrlFromEnv()
  }
  return `${url.protocol}//${url.host}`
}

function viteBaseUrlFromEnv(): string {
  try {
    const url = new URL(ALLOWED_ORIGIN_PREFIX)
    if (!url.port) url.port = '5173'
    return url.toString().replace(/\/$/, '')
  } catch {
    return 'https://liambook.capybara-ulmer.ts.net:5173'
  }
}

function shareLinks(c: { req: { url: string; header: (name: string) => string | undefined } }, world: WorldProject): Record<string, string> {
  const base = clientBaseUrl(c)
  const byRole = new Map(world.members.filter(m => !m.revokedAt).map(m => [m.role, m.token]))
  return {
    owner: `${base}/viewer.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('owner') ?? '')}`,
    editor: `${base}/viewer.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('editor') ?? '')}`,
    viewer: `${base}/viewer.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('viewer') ?? '')}`,
    scanner: `${base}/scanner.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('scanner') ?? '')}`,
  }
}

const ROLE_RANK: Record<MemberRole, number> = {
  scanner: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
}

function requestToken(c: { req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined } }): string | null {
  const queryToken = c.req.query('token')
  if (queryToken) return queryToken
  const auth = c.req.header('authorization') ?? c.req.header('Authorization')
  if (!auth) return null
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function activeMemberForToken(world: WorldProject, token: string | null): WorldMember | null {
  if (!token) return null
  const now = Date.now()
  return world.members.find((member) => {
    if (member.token !== token || member.revokedAt) return false
    if (member.expiresAt && Date.parse(member.expiresAt) <= now) return false
    return true
  }) ?? null
}

function denyUnlessWorldRole(
  c: { json: (body: unknown, status?: number) => Response; req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined } },
  world: WorldProject,
  minimumRole: MemberRole,
  opts: { allowAnonymous?: boolean } = {},
): Response | null {
  const token = requestToken(c)
  const member = activeMemberForToken(world, token)
  if (token && !member) return c.json({ error: 'Invalid or expired world token' }, 403)
  if (!member) {
    if (opts.allowAnonymous || !WORLD_STRICT_AUTH) return null
    return c.json({ error: `A ${minimumRole} token is required` }, 401)
  }
  if (ROLE_RANK[member.role] < ROLE_RANK[minimumRole]) {
    return c.json({ error: `${minimumRole} capability required`, role: member.role }, 403)
  }
  return null
}

function redactWorldForClient(world: WorldProject, token: string | null): WorldProject {
  const member = activeMemberForToken(world, token)
  const canSeeTokens = member?.role === 'owner'
  return {
    ...world,
    members: world.members.map((item) => ({
      ...item,
      token: canSeeTokens || item.memberId === member?.memberId ? item.token : '',
    })),
  }
}

function objectKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function applyPatchToWorld(world: WorldProject, patch: EditPatch): void {
  if (patch.scope === 'scan' && patch.scanId && patch.transform?.matrix) {
    const scan = world.scans.find(s => s.scanId === patch.scanId || s.filename === patch.targetId)
    if (scan) scan.localToWorld = patch.transform.matrix
  }
}

function createWorldJob(world: WorldProject, type: WorldJobType, scanId?: string, payload?: Record<string, unknown>): WorldJob {
  const now = new Date().toISOString()
  return {
    jobId: `job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    worldId: world.worldId,
    type,
    status: 'queued',
    scanId,
    capabilities: DEFAULT_WORKER_CAPABILITIES,
    payload,
    progress: 0,
    createdAt: now,
    updatedAt: now,
  }
}

async function enqueueLegacyProcessJob(action: string, filename: string): Promise<string | null> {
  const mapping: Record<string, WorldJobType> = {
    'object-count': 'semantic-pass',
    'scene-description': 'semantic-pass',
    'floor-plan': 'extract-layers',
    'mesh-cleanup': 'merge-points',
    'room-segment': 'align-scan',
  }
  const type = mapping[action]
  if (!type) return null
  const world = await loadWorld('default')
  const scan = world.scans.find(s => s.filename === filename)
  const job = createWorldJob(world, type, scan?.scanId, { legacyAction: action, filename })
  world.jobs.unshift(job)
  await saveWorld(world)
  await completeJobSoon(world.shareSlug, job.jobId)
  return job.jobId
}

async function completeJobSoon(slug: string, jobId: string): Promise<void> {
  setTimeout(async () => {
    try {
      const world = await loadWorld(slug)
      const job = world.jobs.find(j => j.jobId === jobId)
      if (!job || job.status !== 'queued') return
      job.status = 'processing'
      job.workerId = 'local-coordinator'
      job.progress = 0.35
      job.updatedAt = new Date().toISOString()
      await saveWorld(world)
      broadcast({ type: 'world-job-update', worldId: world.worldId, job })
      setTimeout(async () => {
        try {
          const current = await loadWorld(slug)
          const currentJob = current.jobs.find(j => j.jobId === jobId)
          if (!currentJob || currentJob.status === 'failed') return
          const failure = jobFailureReason(currentJob, current)
          if (failure) {
            currentJob.status = 'failed'
            currentJob.error = failure
            currentJob.result = failure
            currentJob.progress = 1
          } else {
            currentJob.status = 'completed'
            currentJob.result = jobResultFor(currentJob)
            currentJob.artifacts = jobArtifactsFor(currentJob, current)
            currentJob.progress = 1
            applyCompletedJobToWorld(currentJob, current)
          }
          currentJob.updatedAt = new Date().toISOString()
          await saveWorld(current)
          broadcast({ type: 'world-job-update', worldId: current.worldId, job: currentJob })
        } catch (err) {
          console.error('[world-job complete error]', err)
        }
      }, 650)
    } catch (err) {
      console.error('[world-job start error]', err)
    }
  }, 25)
}

function scanForJob(job: WorldJob, world: WorldProject): ScanManifest | null {
  if (!job.scanId) return null
  return world.scans.find(scan => scan.scanId === job.scanId || scan.filename === job.scanId) ?? null
}

function jobFailureReason(job: WorldJob, world: WorldProject): string | null {
  const scan = scanForJob(job, world)
  if (['align-scan', 'extract-layers', 'semantic-pass', 'depth-reconstruct', 'splat-train'].includes(job.type) && !scan) {
    return `${job.type} requires a selected scan.`
  }
  if ((job.type === 'depth-reconstruct' || job.type === 'splat-train') && scan && !scan.sessionId) {
    return `${job.type} requires RGB keyframe observations. Start keyframe streaming before export.`
  }
  if (job.type === 'align-scan' && world.scans.length < 2) {
    return 'align-scan needs at least two scans in the world or a manual control-point target.'
  }
  return null
}

function applyCompletedJobToWorld(job: WorldJob, world: WorldProject): void {
  const scan = scanForJob(job, world)
  if (!scan) return
  if (job.type === 'align-scan') scan.status = 'aligned'
  else if (job.type === 'semantic-pass' || job.type === 'extract-layers' || job.type === 'merge-points') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
}

function jobResultFor(job: WorldJob): string {
  switch (job.type) {
    case 'ingest':
      return 'Scan ingest indexed GLB metadata, quality summary, layers, and sidecar references.'
    case 'extract-layers':
      return 'Layer index is available from GLB extras, scene graph conventions, and sidecar manifests.'
    case 'align-scan':
      return 'Alignment recorded from current world transform. A GPU/Open3D worker can refine this with registration artifacts.'
    case 'merge-points':
      return 'Point merge plan recorded. A worker should replace this with a merged cloud artifact.'
    case 'semantic-pass':
      return 'Semantic pass queued through the local coordinator. Server masks/detections can attach to this job artifact.'
    case 'depth-reconstruct':
      return 'Depth reconstruction inputs validated. Depth Anything or WebXR depth artifacts can attach here.'
    case 'splat-train':
      return 'Splat training inputs validated. gsplat/Graphdeco outputs should attach as splat layers.'
    case 'export-world':
      return 'World export manifest is ready for a combined GLB and semantic JSON worker.'
  }
}

function jobArtifactsFor(job: WorldJob, world: WorldProject): WorldJob['artifacts'] {
  const scan = scanForJob(job, world)
  switch (job.type) {
    case 'extract-layers':
      return scan ? [{
        type: 'layer-manifest',
        label: `${scan.name} layer index`,
        url: `/worlds/${encodeURIComponent(world.shareSlug)}`,
        metadata: { scanId: scan.scanId, layers: scan.layerIndex.length },
      }] : []
    case 'align-scan':
      return scan ? [{
        type: 'alignment-report',
        label: `${scan.name} alignment report`,
        metadata: {
          seed: hasGeoPose(scan.geoPose) ? 'gps-compass' : 'manual-local-grid',
          method: 'local-placeholder-open3d-ready',
          matrix: scan.localToWorld,
        },
      }] : []
    case 'semantic-pass':
      return scan ? [{
        type: 'semantic-report',
        label: `${scan.name} semantic review`,
        metadata: { detections: scan.detectionCount ?? 0, ontology: 'companion-scan-v1' },
      }] : []
    case 'depth-reconstruct':
      return scan ? [{
        type: 'depth-plan',
        label: `${scan.name} depth reconstruction inputs`,
        url: scan.frameSetUrl,
        metadata: { sessionId: scan.sessionId, keyframes: scan.qualitySummary?.keyframeCount ?? null },
      }] : []
    case 'splat-train':
      return scan ? [{
        type: 'splat-plan',
        label: `${scan.name} splat training inputs`,
        url: scan.frameSetUrl,
        metadata: { sessionId: scan.sessionId, canonicalLayer: 'splat' },
      }] : []
    case 'export-world':
      return [{
        type: 'world-export-plan',
        label: `${world.name} export manifest`,
        url: `/worlds/${encodeURIComponent(world.shareSlug)}`,
        metadata: { scans: world.scans.length, patches: world.editPatches.length },
      }]
    case 'ingest':
    case 'merge-points':
      return scan ? [{
        type: `${job.type}-report`,
        label: `${scan.name} ${job.type} report`,
        metadata: { points: scan.pointCount ?? 0 },
      }] : []
  }
}

async function frameObservationsForScan(scan: ScanManifest, limit = 500): Promise<FrameObservation[]> {
  if (!scan.sessionId) return []
  const dir = sessionDir(scan.sessionId)
  if (!dir) return []

  let raw = ''
  try {
    raw = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
  } catch {
    return []
  }

  const frames: FrameObservation[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const meta = JSON.parse(line) as Record<string, unknown>
      const file = asString(meta['file'])
      if (!file || !KEYFRAME_FILE_RE.test(file)) continue
      const index = asNumber(meta['index']) ?? frames.length
      const pose = normalisePose(meta['pose'])
      const intrinsics = normaliseIntrinsics(meta['intrinsics'])
      frames.push({
        frameId: `${scan.sessionId}-${String(index).padStart(5, '0')}`,
        scanId: scan.scanId,
        rgbUrl: `/sessions/${encodeURIComponent(scan.sessionId)}/keyframes/${encodeURIComponent(file)}`,
        timestamp: asNumber(meta['timestamp']) ?? asNumber(meta['capturedAt']) ?? asNumber(meta['receivedAt']) ?? 0,
        pose,
        intrinsics,
        frustum: {
          nearM: 0.05,
          farM: 8,
          fovYDeg: intrinsics.fovYDeg ?? 60,
          aspect: intrinsics.width > 0 && intrinsics.height > 0 ? intrinsics.width / intrinsics.height : 1,
        },
      })
      if (frames.length >= limit) break
    } catch {
      // Ignore one malformed keyframe line; the rest of the session is still useful.
    }
  }
  return frames
}

function normalisePose(value: unknown): FrameObservation['pose'] {
  const pose = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const position = pose['position'] && typeof pose['position'] === 'object'
    ? pose['position'] as Record<string, unknown>
    : {}
  const rotation = pose['rotation'] && typeof pose['rotation'] === 'object'
    ? pose['rotation'] as Record<string, unknown>
    : {}
  return {
    position: {
      x: asNumber(position['x']) ?? 0,
      y: asNumber(position['y']) ?? 0,
      z: asNumber(position['z']) ?? 0,
    },
    rotation: {
      x: asNumber(rotation['x']) ?? 0,
      y: asNumber(rotation['y']) ?? 0,
      z: asNumber(rotation['z']) ?? 0,
      w: asNumber(rotation['w']) ?? 1,
    },
  }
}

function normaliseIntrinsics(value: unknown): FrameObservation['intrinsics'] {
  const intrinsics = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const width = Math.max(1, asNumber(intrinsics['width']) ?? asNumber(intrinsics['sourceWidth']) ?? 1)
  const height = Math.max(1, asNumber(intrinsics['height']) ?? asNumber(intrinsics['sourceHeight']) ?? 1)
  return {
    width,
    height,
    fovYDeg: asNumber(intrinsics['fovYDeg']) ?? undefined,
    fx: asNumber(intrinsics['fx']) ?? undefined,
    fy: asNumber(intrinsics['fy']) ?? undefined,
    cx: asNumber(intrinsics['cx']) ?? undefined,
    cy: asNumber(intrinsics['cy']) ?? undefined,
  }
}

app.get('/worlds', async (c) => {
  const worlds: WorldProject[] = []
  try {
    for await (const entry of Deno.readDir(WORLDS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        worlds.push(JSON.parse(await Deno.readTextFile(`${WORLDS_DIR}/${entry.name}`)) as WorldProject)
      } catch { /* ignore one broken world */ }
    }
  } catch { /* directory may not exist yet */ }
  if (worlds.length === 0) worlds.push(await loadWorld('default'))
  worlds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return c.json(worlds.map(w => ({
    worldId: w.worldId,
    name: w.name,
    shareSlug: w.shareSlug,
    scanCount: w.scans.length,
    jobCount: w.jobs.length,
    updatedAt: w.updatedAt,
  })))
})

app.post('/worlds', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: string; shareSlug?: string }
  const slug = safeSlug(body.shareSlug ?? body.name ?? `world-${Date.now()}`)
  const existingPath = worldPath(slug)
  try {
    await Deno.stat(existingPath)
    return c.json({ error: 'World already exists', shareSlug: slug }, 409)
  } catch { /* create */ }
  const world = await synthesizeWorld(slug)
  if (body.name?.trim()) {
    world.name = body.name.trim()
    await saveWorld(world)
  }
  return c.json(world, 201)
})

app.get('/worlds/:slug', async (c) => {
  const slug = c.req.param('slug')
  const world = await loadWorld(slug)
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  return c.json(redactWorldForClient(world, requestToken(c)))
})

app.get('/worlds/:slug/share', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'editor')
  if (denied) return denied
  return c.json({ worldId: world.worldId, shareSlug: world.shareSlug, links: shareLinks(c, world) })
})

app.get('/worlds/:slug/patches', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  return c.json(world.editPatches)
})

app.post('/worlds/:slug/patches', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'editor')
  if (denied) return denied
  const body = await c.req.json().catch(() => ({})) as Partial<EditPatch>
  const targetId = objectKey(body.targetId)
  if (!targetId) return c.json({ error: 'targetId is required' }, 400)
  const scope = body.scope ?? 'object'
  if (!['scan', 'object', 'point-selection', 'layer', 'world'].includes(scope)) {
    return c.json({ error: 'Invalid patch scope' }, 400)
  }
  const patch: EditPatch = {
    patchId: `patch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    worldId: world.worldId,
    scanId: objectKey(body.scanId) ?? undefined,
    targetId,
    scope,
    transform: body.transform,
    label: objectKey(body.label) ?? undefined,
    category: objectKey(body.category) ?? undefined,
    notes: objectKey(body.notes) ?? undefined,
    visible: typeof body.visible === 'boolean' ? body.visible : undefined,
    actorId: objectKey(body.actorId) ?? 'local-editor',
    createdAt: new Date().toISOString(),
  }
  world.editPatches.push(patch)
  applyPatchToWorld(world, patch)
  await saveWorld(world)
  return c.json({ ok: true, patch, world })
})

app.get('/worlds/:slug/jobs', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  return c.json(world.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
})

app.post('/worlds/:slug/jobs', async (c) => {
  const slug = c.req.param('slug')
  const world = await loadWorld(slug)
  const denied = denyUnlessWorldRole(c, world, 'editor')
  if (denied) return denied
  const body = await c.req.json().catch(() => ({})) as {
    type?: WorldJobType
    scanId?: string
    payload?: Record<string, unknown>
  }
  const type = body.type
  if (!type || !WORLD_JOB_TYPES.has(type)) {
    return c.json({ error: `type must be one of ${[...WORLD_JOB_TYPES].join(', ')}` }, 400)
  }
  const job = createWorldJob(world, type, body.scanId, body.payload)
  world.jobs.unshift(job)
  await saveWorld(world)
  await completeJobSoon(slug, job.jobId)
  return c.json(job, 202)
})

app.get('/worlds/:slug/frames/:scanId', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  const scan = world.scans.find(s => s.scanId === c.req.param('scanId'))
  if (!scan) return c.json({ error: 'Scan not found' }, 404)
  const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit') ?? 500)))
  const frames = await frameObservationsForScan(scan, limit)
  return c.json({
    scanId: scan.scanId,
    sessionId: scan.sessionId,
    count: frames.length,
    frames,
  })
})

app.post('/upload-summary', async (c) => {
  console.log('[server] /upload-summary route triggered')
  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    console.warn('[server] /upload-summary: Missing file field')
    return c.json({ error: 'Missing file field (expected .md)' }, 400)
  }
  const rawName = (file.name || 'summary')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\./g, '__')
    .replace(/^[._-]+/, '')
  const safeName = rawName.endsWith('.md') ? rawName : `${rawName}.md`
  const filename = `${Date.now()}_${safeName}`
  try {
    const text = await file.text()
    await Deno.writeTextFile(`${SUMMARIES_DIR}/${filename}`, text)
    console.log(`[summary] Saved ${filename}`)
    return c.json({ filename })
  } catch (err) {
    console.error('[summary upload error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

// ── Scan processing ───────────────────────────────────────────────────────────

async function findFilenameBySessionId(sessionId: string): Promise<string | null> {
  if (!sessionId) return null
  try {
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        const raw = await Deno.readTextFile(`${SCANS_DIR}/${entry.name}`)
        const meta = JSON.parse(raw) as Record<string, unknown>
        if (meta['sessionId'] === sessionId) {
          return entry.name.replace(/\.json$/, '.glb')
        }
      } catch { /* ignore parse error for single file */ }
    }
  } catch (err) {
    console.error('[server] Error scanning directory for sessionId:', err)
  }
  return null
}

app.post('/process-scan', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    filename?: string
    action?: string
    sessionId?: string
  }
  const { filename = '', action = '', sessionId = '' } = body

  if (!action) return c.json({ error: 'Missing action' }, 400)

  let targetFilename = filename
  if (!targetFilename && sessionId) {
    const found = await findFilenameBySessionId(sessionId)
    if (found) {
      targetFilename = found
      console.log(`[process] Found target file by sessionId="${sessionId}": ${targetFilename}`)
    }
  }

  if (!targetFilename) {
    // Fallback: use the newest scan in the directory
    try {
      const scans: Array<{ name: string; mtime: number }> = []
      for await (const entry of Deno.readDir(SCANS_DIR)) {
        if (!entry.isFile || !entry.name.endsWith('.glb')) continue
        const stat = await Deno.stat(`${SCANS_DIR}/${entry.name}`)
        scans.push({ name: entry.name, mtime: (stat.mtime ?? new Date()).getTime() })
      }
      scans.sort((a, b) => b.mtime - a.mtime)
      if (scans.length > 0) {
        targetFilename = scans[0].name
        console.log(`[process] No filename or sessionId match found. Using newest scan globally: ${targetFilename}`)
      }
    } catch { /* ignore */ }
  }

  if (!targetFilename) {
    console.warn(`[process] Rejecting process-scan: No files available for action="${action}"`)
    return c.json({ error: 'No scans available on server. Please export a scan first.' }, 400)
  }

  // Prevent path traversal
  const safeName = targetFilename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const metaPath = `${SCANS_DIR}/${safeName}`.replace(/\.glb$/, '.json')

  // Read stored metadata (.json companion file saved alongside .glb)
  let meta: Record<string, unknown> = {}
  try {
    const raw = await Deno.readTextFile(metaPath)
    meta = JSON.parse(raw) as Record<string, unknown>
  } catch { /* no metadata file — use empty object */ }

  const labels = (meta['labels'] as string[] | undefined) ?? []
  const detCount = (meta['detectionCount'] as number | undefined) ?? labels.length

  let result = ''

  switch (action) {
    case 'object-count': {
      const freq = new Map<string, number>()
      for (const lbl of labels) freq.set(lbl, (freq.get(lbl) ?? 0) + 1)
      const rows = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([lbl, n]) => `  • ${lbl}: ${n}`)
        .join('\n')
      result = detCount > 0
        ? `Found ${detCount} object${detCount === 1 ? '' : 's'}:\n${rows}`
        : 'No objects detected in this scan.'
      break
    }

    case 'scene-description': {
      if (labels.length === 0) {
        result = 'No detected objects. Scan appears empty or was not processed with inference enabled.'
      } else {
        const unique = [...new Set(labels.map(l => l.toLowerCase()))]
        const listStr = unique.slice(0, -1).join(', ') + (unique.length > 1 ? `, and ${unique.at(-1)}` : unique[0])
        result = `This room scan contains ${detCount} detected object${detCount === 1 ? '' : 's'}, including: ${listStr}.\n\nScanned session: ${sessionId || filename || '(unknown)'}.\nExported: ${new Date((meta['exportedAt'] as string | undefined) ?? Date.now()).toLocaleString()}.`
      }
      break
    }

    case 'floor-plan': {
      // Generate a simple ASCII floor plan from detection positions in metadata.
      // For a richer plan the client should pass bounding-box data.
      if (labels.length === 0) {
        result = 'No object positions available for floor-plan generation. Export a scan with detections first.'
      } else {
        const unique = [...new Set(labels)]
        result = `Floor Plan — ${unique.length} object type${unique.length === 1 ? '' : 's'} detected:\n\n`
        result += unique.map((l, i) => `  [${i + 1}] ${l}`).join('\n')
        result += '\n\nNote: Upload a scan with world-position metadata for a spatial floor plan SVG.'
      }
      break
    }

    case 'mesh-cleanup':
      result = `Mesh Cleanup Recommendations:\n\n  • Remove isolated point clusters (< 50 points)\n  • Voxel downsample to 3 cm resolution for file-size reduction\n  • Smooth SLAM feature noise with a 5-pass Laplacian filter\n  • Fill floor-plane gaps using alpha-shape reconstruction\n\nApply these steps server-side with Open3D or CloudCompare, or export the .glb to Blender's "Mesh > Clean Up" tools.`
      break

    case 'room-segment':
      result = `Room Segmentation Suggestions:\n\n  • Dominant floor region detected — single contiguous room likely.\n  • For multi-room isolation: cluster SLAM points by elevation band, then apply 2D connected-component labelling on the XZ projection.\n  • Doorway detection: look for gaps (< 1 m) in vertical SLAM density at floor level.\n\nTip: scan each room separately for best per-room GLB accuracy.`
      break

    default:
      result = `Unknown action: "${action}". Supported actions: object-count, scene-description, floor-plan, mesh-cleanup, room-segment.`
  }

  console.log(`[process] action=${action} file=${filename}`)
  const jobId = await enqueueLegacyProcessJob(action, targetFilename).catch((err) => {
    console.error('[process] queue bridge failed:', err)
    return null
  })
  return c.json({ action, result, jobId, processedAt: new Date().toISOString() })
})

// ── Project management (in-memory, persisted to projects.json) ────────────────

interface ProjectRecord {
  projectId: string
  name: string
  address?: string
  notes?: string
  createdAt: number
  updatedAt: number
  floors: unknown[]
}

const PROJECTS_FILE = Deno.env.get('PROJECTS_FILE') ?? './projects.json'
let projectMutationQueue: Promise<void> = Promise.resolve()

async function loadProjects(): Promise<ProjectRecord[]> {
  try {
    return JSON.parse(await Deno.readTextFile(PROJECTS_FILE)) as ProjectRecord[]
  } catch { return [] }
}

async function saveProjects(projects: ProjectRecord[]): Promise<void> {
  const tmpFile = `${PROJECTS_FILE}.${crypto.randomUUID()}.tmp`
  await Deno.writeTextFile(tmpFile, JSON.stringify(projects, null, 2))
  await Deno.rename(tmpFile, PROJECTS_FILE)
}

async function mutateProjects<T>(
  mutator: (projects: ProjectRecord[]) => { result: T; save: boolean } | Promise<{ result: T; save: boolean }>,
): Promise<T> {
  const mutation = projectMutationQueue.then(async () => {
    const projects = await loadProjects()
    const { result, save } = await mutator(projects)
    if (save) await saveProjects(projects)
    return result
  })
  projectMutationQueue = mutation.then(() => undefined, () => undefined)
  return mutation
}

app.get('/projects', async (c) => {
  const projects = await loadProjects()
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  return c.json(projects)
})

app.post('/projects', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    name?: string
    address?: string
    notes?: string
  }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const name = body.name.trim()
  const project = await mutateProjects((projects) => {
    const now = Date.now()
    const project: ProjectRecord = {
      projectId: `proj-${now}`,
      name,
      address: body.address,
      notes: body.notes,
      createdAt: now,
      updatedAt: now,
      floors: [{ floorId: `floor-${now}`, name: 'Ground Floor', level: 0, rooms: [] }],
    }
    projects.push(project)
    return { result: project, save: true }
  })
  return c.json(project, 201)
})

app.get('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const projects = await loadProjects()
  const project = projects.find(p => p.projectId === id)
  if (!project) return c.json({ error: 'Not found' }, 404)
  return c.json(project)
})

app.put('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null) as ProjectRecord | null
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  const updated = await mutateProjects<ProjectRecord | null>((projects) => {
    const idx = projects.findIndex(p => p.projectId === id)
    if (idx === -1) return { result: null, save: false }
    projects[idx] = { ...body, projectId: id, updatedAt: Date.now() }
    return { result: projects[idx], save: true }
  })
  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json(updated)
})

app.delete('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const deleted = await mutateProjects((projects) => {
    const idx = projects.findIndex(p => p.projectId === id)
    if (idx === -1) return { result: false, save: false }
    projects.splice(idx, 1)
    return { result: true, save: true }
  })
  if (!deleted) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

console.log(`[server] CORS origin prefix: ${ALLOWED_ORIGIN_PREFIX}`)

// ── Server event stream — /events ─────────────────────────────────────────────
// Broadcast-only WebSocket: scan uploads, job transitions, session lifecycle.
// The desktop viewer subscribes to refresh its scan list live.

app.get('/events', (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw)
  socket.addEventListener('open', () => {
    eventSockets.add(socket)
    socket.send(JSON.stringify({ type: 'hello', jobs: jobQueue.jobs.filter(j => j.status === 'queued' || j.status === 'running').length }))
  })
  socket.addEventListener('close', () => eventSockets.delete(socket))
  socket.addEventListener('error', () => eventSockets.delete(socket))
  return response
})

// ── WebRTC signaling — /rtc-signal?room=<id>&role=phone|viewer ───────────────
//
// Simple relay: one "phone" sender + one "viewer" receiver per room.
// Messages are arbitrary JSON (SDP offer/answer, ICE candidates).
// The server never inspects the payload — it only routes by room + role.

interface RtcPeer {
  ws: WebSocket
  role: 'phone' | 'viewer'
}

/** roomId → { phone?, viewer? } */
const rtcRooms = new Map<string, Partial<Record<'phone' | 'viewer', RtcPeer>>>()

app.get('/rtc-signal', (c) => {
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw)
  const url = new URL(c.req.url)
  const roomId = (url.searchParams.get('room') ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '')
  const role   = url.searchParams.get('role') === 'phone' ? 'phone' : 'viewer'

  if (!rtcRooms.has(roomId)) rtcRooms.set(roomId, {})
  const room = rtcRooms.get(roomId)!

  const peer: RtcPeer = { ws: socket, role }
  room[role] = peer
  console.log(`[rtc] ${role} joined room "${roomId}"`)

  // Notify each side when both peers are present
  const notifyReady = () => {
    if (room.phone && room.viewer) {
      const msg = JSON.stringify({ type: 'peer-ready' })
      if (room.phone.ws.readyState === 1) { // WebSocket.OPEN
        try { room.phone.ws.send(msg) } catch { /* closed */ }
      }
      if (room.viewer.ws.readyState === 1) { // WebSocket.OPEN
        try { room.viewer.ws.send(msg) } catch { /* closed */ }
      }
    }
  }

  socket.addEventListener('open', () => {
    notifyReady()
  })
  if (socket.readyState === 1) {
    notifyReady()
  }

  socket.addEventListener('message', (ev) => {
    const other = role === 'phone' ? room.viewer : room.phone
    if (!other) return  // other side not connected yet — drop
    try {
      other.ws.send(ev.data as string)
    } catch { /* other peer closed */ }
  })

  socket.addEventListener('close', () => {
    console.log(`[rtc] ${role} left room "${roomId}"`)
    delete room[role]
    if (!room.phone && !room.viewer) rtcRooms.delete(roomId)
    // Notify remaining peer that the other disconnected
    const remaining = role === 'phone' ? room.viewer : room.phone
    if (remaining) {
      try { remaining.ws.send(JSON.stringify({ type: 'peer-left', role })) } catch { /* closed */ }
    }
  })

  return response
})

Deno.serve({ hostname: '0.0.0.0', port: PORT }, app.fetch)
