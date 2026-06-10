/**
 * Deno inference server — Hono HTTP server on :8000
 *
 * POST /infer              multipart { image: File }   → RawDetection[]
 * POST /upload-scan        multipart { file: File(.glb), metadata?: JSON } → { filename }
 * GET  /scans              → [{ filename, size, uploadedAt }]
 * GET  /scans/:filename    → model/gltf-binary
 * POST /upload-summary     multipart { file: File(.md) } → { filename }
 * POST /process-scan       JSON { filename, action, sessionId? } → { action, result }
 * GET  /projects           → Project[]
 * POST /projects           JSON { name, address?, notes? } → Project
 * GET  /projects/:id       → Project
 * PUT  /projects/:id       JSON (Project) → Project
 * DELETE /projects/:id     → { ok: true }
 * GET  /rtc-signal         WebSocket upgrade — WebRTC signaling relay
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi main.ts
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { InferenceEngine } from './inference.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8000)
const ALLOWED_ORIGIN_PREFIX = Deno.env.get('ALLOWED_ORIGIN_PREFIX') ?? 'https://liambook.capybara-ulmer.ts.net'

const SCANS_DIR    = Deno.env.get('SCANS_DIR')    ?? './scans'
const SUMMARIES_DIR = Deno.env.get('SUMMARIES_DIR') ?? './summaries'

for (const dir of [SCANS_DIR, SUMMARIES_DIR]) {
  try { await Deno.mkdir(dir, { recursive: true }) } catch { /* already exists */ }
}

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
  await engineLoadPromise
  if (!modelLoaded) {
    return c.json({ error: 'Model failed to load on server — running in server-only mode. Install local models or use WebGPU fallback.' }, 503)
  }
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

app.post('/upload-summary', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Missing file field (expected .md)' }, 400)
  }
  const rawName = (file.name || 'summary').replace(/[^a-zA-Z0-9._-]/g, '_')
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

app.post('/process-scan', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    filename?: string
    action?: string
    sessionId?: string
  }
  const { filename = '', action = '', sessionId = '' } = body

  if (!action) return c.json({ error: 'Missing action' }, 400)

  // Prevent path traversal
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
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
  return c.json({ action, result, processedAt: new Date().toISOString() })
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

async function loadProjects(): Promise<ProjectRecord[]> {
  try {
    return JSON.parse(await Deno.readTextFile(PROJECTS_FILE)) as ProjectRecord[]
  } catch { return [] }
}

async function saveProjects(projects: ProjectRecord[]): Promise<void> {
  await Deno.writeTextFile(PROJECTS_FILE, JSON.stringify(projects, null, 2))
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
  const projects = await loadProjects()
  const now = Date.now()
  const project: ProjectRecord = {
    projectId: `proj-${now}`,
    name: body.name.trim(),
    address: body.address,
    notes: body.notes,
    createdAt: now,
    updatedAt: now,
    floors: [{ floorId: `floor-${now}`, name: 'Ground Floor', level: 0, rooms: [] }],
  }
  projects.push(project)
  await saveProjects(projects)
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
  const projects = await loadProjects()
  const idx = projects.findIndex(p => p.projectId === id)
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  projects[idx] = { ...body, projectId: id, updatedAt: Date.now() }
  await saveProjects(projects)
  return c.json(projects[idx])
})

app.delete('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const projects = await loadProjects()
  const filtered = projects.filter(p => p.projectId !== id)
  if (filtered.length === projects.length) return c.json({ error: 'Not found' }, 404)
  await saveProjects(filtered)
  return c.json({ ok: true })
})

console.log(`[server] CORS origin prefix: ${ALLOWED_ORIGIN_PREFIX}`)

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
      try { room.phone.ws.send(msg) } catch { /* closed */ }
      try { room.viewer.ws.send(msg) } catch { /* closed */ }
    }
  }
  notifyReady()

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

Deno.serve({ port: PORT }, app.fetch)
