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
 * GET  /capabilities       → CapabilityReport (external tools, GPU/Vulkan, pipeline readiness)
 * GET  /jobs               → Job[]   (processing queue state)
 * GET  /jobs/:id           → Job
 * POST /sessions                       → { sessionId } — begin keyframe capture session
 * POST /sessions/:id/keyframes         multipart { image, meta } → { ok, index }
 * POST /sessions/:id/finalize          JSON { glbFilename?, … } → session record
 * GET  /sessions/:id                   → session record
 * POST /ingest-video      multipart { video: File, name?, fps?, projectId?, areaId? } → 202 { sessionId, scanId, jobId, frameCount }
 * POST /ingest-photos     multipart { files: File[], name?, projectId?, areaId? } → 202 { sessionId, scanId, jobId, frameCount, droppedBlurry }
 * POST /upload-summary     multipart { file: File(.md) } → { filename }
 * POST /process-scan       JSON { filename, action, sessionId? } → { action, result }
 * POST /client-logs        JSON { entries: [{ ts, level, msg, stack?, url? }], ua? } → 204
 * GET  /projects           → Project[]
 * POST /projects           JSON { name, address?, notes? } → Project
 * GET  /projects/:id       → Project
 * PUT  /projects/:id       JSON (Project) → Project
 * DELETE /projects/:id     → { ok: true }
 * POST /projects/:id/reference-photos        multipart { image, meta } → { ok, role, url }
 * GET  /projects/:id/reference-photos/:file  → image/jpeg
 * GET  /takes/:takeId     member sessions of one take (derived from session.json)
 * POST /takes/:takeId/sync a member reports its measured clock offset
 * GET  /sessions/:id/clip/:file   the durable person clip (ranged)
 * GET  /sessions/:id/pose-track.json  camera track recorded beside a person clip
 * GET  /scans/:base.4d/:frame     one timestep of a 4D person sequence
 * GET  /rtc-signal         WebSocket upgrade — signalling relay (preview pair + take rooms)
 * GET  /events             WebSocket upgrade — server event broadcast (scans/jobs)
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi main.ts
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { fromFileUrl } from '@std/path'
import { REPO_ROOT } from './repo-root.ts'
import { InferenceEngine } from './inference.ts'
import { type CapabilityReport, formatCapabilityReport, probeCapabilities } from './capabilities.ts'
import type { Job, JobStatus, OptimizeScanManifest } from './jobs.ts'
import { optimizeScan } from './pipeline.ts'
import {
  findDuplicateWorldJob,
  recoverStuckWorldJobs,
  trimWorldJobHistory,
  worldJobTarget,
  WorldJobPump,
} from './world/world_job_pump.ts'
import { withWorldLock } from './world/world_lock.ts'
import { legacyScanId, safeSlug, scanIdFor } from './scan_id.ts'
import { newServerSessionId, resolveSessionDir, sessionDirPath } from './session_id.ts'
import {
  parseReferencePhotoMeta,
  projectMediaDirPath,
  referencePhotoFileName,
  referencePhotoUrl,
  roleForReferencePhotoFile,
} from './project_media.ts'
import { loadSessionIndex, sessionForScan, sessionsForTake, type SessionIndex } from './scan_index.ts'
import { isClientId, isTakeId } from './take_id.ts'
import { buildTakeSync, exchangeFailed } from './world/take_sync.ts'
import { rangedResponse, readFileRange } from './http_range.ts'
import { type Person4DClip, runPerson4D } from './person4d/person_4d.ts'
import {
  joinRoom,
  leaveRoom,
  previewPairReady,
  relayTargets,
  roster,
  type RtcRole,
  type RtcRoom,
  sendAll,
  WS_OPEN,
} from './world/rtc_rooms.ts'
import { pruneScansMissingFromDisk } from './world/world_prune.ts'
import { runLingBotMapReconstruction } from './lingbot-map/lingbot_map.ts'
import { runColmapPoses } from './colmap/colmap_poses.ts'
import { runSplatAlign } from './splat/splat_align.ts'
import { runSplatTrain } from './splat/splat_train.ts'
import { runSpirulaTrain } from './splat/spirula_train.ts'
import { runSplatDetect } from './splat/splat_detect.ts'
import { runSplatFinish } from './splat/splat_finish.ts'
import { runSenseNovaVision, senseNovaTask } from './sensenova_vision.ts'
import { runPanopticScan } from './panoptic/panoptic_scan.ts'
import { runPanopticLift } from './panoptic/panoptic_lift.ts'
import { configFromEnv as portalAuthConfig, registerPortalAuth } from './portal_auth.ts'
import {
  configFromEnv as memoryPushConfig,
  pushScanToMemory,
  registerMemoryPush,
} from './memory_push.ts'
import { composeYUpTransform, geoToEnu, hasGeoPose } from '../src/world/geo.ts'
import { defaultLayerIndex } from '../src/world/layers.ts'
import { EVENT, type EventPayload } from '../src/shared/events.ts'
import { formatSetupBanner } from '../src/shared/model-catalog.ts'
import {
  ensureWorldProjectCollections,
  placeScanTransform,
  scanProjectId,
  shouldIncludeStoredScanInWorld,
} from './world/world_membership.ts'
import { runThingCorrespondence, type DetectionLike } from './thing_match.ts'
import type {
  EditPatch,
  Floor,
  FrameObservation,
  GeoPose,
  MemberRole,
  Project,
  ScanCalibration,
  ScanManifest,
  ScanManifestStatus,
  ScanQualitySummary,
  Thing,
  ThingObservation,
  Vec3,
  WorldJob,
  WorldJobStatus,
  WorldJobType,
  WorldMember,
  WorldProject,
  ReviewComment,
} from '../src/world/types.ts'

// An unguarded async callback anywhere below (there is no lint/type check that
// catches this) throws an unhandled rejection, and Deno's default is to
// terminate the whole process on that — silently as far as this server is
// concerned, since nothing here was logging it. Every client this server
// serves loses their connection to fix one caller's edge case. Log loudly and
// keep running instead; a caller-scoped failure should stay caller-scoped.
globalThis.addEventListener('unhandledrejection', (event) => {
  console.error('[fatal] unhandled rejection — server would otherwise have exited on this:', event.reason)
  event.preventDefault()
})

const PORT = Number(Deno.env.get('PORT') ?? 8000)
// Vite dev-server port. Same variable name and default as vite.config.ts's read of
// process.env.VITE_PORT — deliberately parallel one-liners (see docs/foundation-updates/0002
// for the hostname precedent this follows), not a shared module.
const VITE_PORT = Deno.env.get('VITE_PORT') ?? '5173'
const SERVER_STARTED_AT = Date.now()

// Hostname phones use to reach this box. Auto-detected with the same precedence order
// as vite.config.ts's resolveHostname() — env var → `tailscale status --json` → a
// *.ts.net.crt file in cwd → historical default — ported to Deno's subprocess/fs APIs
// since Vite runs under Node. The two are genuinely parallel implementations of one
// algorithm, not a shared module (see docs/foundation-updates/0002).
const FALLBACK_HOSTNAME = 'liambook.capybara-ulmer.ts.net'

async function resolveHostname(): Promise<{ hostname: string; source: string }> {
  const fromEnv = Deno.env.get('TAILSCALE_HOSTNAME') ?? Deno.env.get('VITE_HOSTNAME')
  if (fromEnv) return { hostname: fromEnv, source: 'env' }

  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const { success, stdout } = await new Deno.Command(bin, {
        args: ['status', '--json'],
        stdout: 'piped',
        stderr: 'null',
        stdin: 'null',
        signal: controller.signal,
      }).output()
      clearTimeout(timer)
      if (!success) continue
      const dns = JSON.parse(new TextDecoder().decode(stdout))?.Self?.DNSName
      if (typeof dns === 'string' && dns.length > 0) {
        return { hostname: dns.replace(/\.$/, ''), source: 'tailscale cli' }
      }
    } catch { /* not installed / not running / timed out — try next */ }
  }

  try {
    for await (const entry of Deno.readDir(Deno.cwd())) {
      if (entry.isFile && entry.name.endsWith('.ts.net.crt')) {
        return { hostname: entry.name.replace(/\.crt$/, ''), source: 'cert file' }
      }
    }
  } catch { /* unreadable cwd — fall through */ }

  return { hostname: FALLBACK_HOSTNAME, source: 'default' }
}

const { hostname: TAILSCALE_HOSTNAME, source: HOSTNAME_SOURCE } = await resolveHostname()
console.log(`[server] Hostname: ${TAILSCALE_HOSTNAME} (via ${HOSTNAME_SOURCE})`)
const ALLOWED_ORIGIN_PREFIX = Deno.env.get('ALLOWED_ORIGIN_PREFIX') ?? `https://${TAILSCALE_HOSTNAME}`

const SCANS_DIR    = Deno.env.get('SCANS_DIR')    ?? './scans'
// Companion Memory (CI-Server) target. Read once at boot so the job guard and
// the status route agree on whether the integration is wired.
const memoryPushCfg = memoryPushConfig()
const SUMMARIES_DIR = Deno.env.get('SUMMARIES_DIR') ?? './summaries'
const SESSIONS_DIR = Deno.env.get('SESSIONS_DIR') ?? `${SCANS_DIR}/sessions`
const WORLDS_DIR = Deno.env.get('WORLDS_DIR') ?? './worlds'
const MAX_KEYFRAMES_PER_SESSION = 2000
const WORLD_STRICT_AUTH = Deno.env.get('WORLD_STRICT_AUTH') === '1'
// /infer hardening knobs
const INFER_MAX_IMAGE_BYTES = Number(Deno.env.get('INFER_MAX_IMAGE_BYTES') ?? '') || 12_000_000
// Thumbnail sample rate for a person clip. Low because the clip itself is the
// artifact — these frames exist only for the editor's preview, not to feed a
// reconstruction.
const PERSON_THUMBNAIL_FPS = 1
// /ingest-video guard: reject an upload whose Content-Length exceeds this (bytes).
const INGEST_MAX_VIDEO_BYTES = Number(Deno.env.get('INGEST_MAX_VIDEO_BYTES') ?? '') || 1_500_000_000
// /ingest-photos guard: reject an upload whose Content-Length exceeds this (bytes).
const INGEST_MAX_PHOTOS_BYTES = Number(Deno.env.get('INGEST_MAX_PHOTOS_BYTES') ?? '') || 500_000_000
// Auto-enqueue a splat-finish job when splat-train completes ok (kill switch: SPLAT_FINISH_AUTO=0).
const SPLAT_FINISH_AUTO = Deno.env.get('SPLAT_FINISH_AUTO') !== '0'
/**
 * Which trainer a `splat-train` job spawns. 'brush' (the default, and every
 * deployment that predates this variable) or 'spirula'.
 *
 * One job type, two interchangeable drivers — not a second job type, because
 * nothing downstream differs: both land <base>.splat.ply and a
 * <base>.splat-train.manifest.json, and splat-finish / splat-detect consume
 * those by name. A `splat-train-spirula` job would have duplicated the whole
 * chain to change one argv (ADR 0001).
 *
 * Anything unrecognised falls back to Brush rather than failing the job: a
 * typo'd env var must not silently stop a fleet from reconstructing.
 */
const SPLAT_BACKEND: 'brush' | 'spirula' = Deno.env.get('SPLAT_BACKEND')?.trim().toLowerCase() === 'spirula'
  ? 'spirula'
  : 'brush'
const ENGINE_LOAD_WAIT_MS = 15_000 // max time /infer waits for the model to finish loading
const INFER_TIMEOUT_MS = 60_000    // hard cap on a single engine.infer() call

/**
 * Path to a repo script (scripts/…), as a native OS path.
 *
 * `new URL(rel, import.meta.url).pathname` is *not* that: on Windows it yields
 * `/C:/devel/…`, which `Deno.Command` then resolves against the drive root as
 * `C:\C:\devel\…` and the spawned process fails with "Cannot find module".
 * `fromFileUrl` is the conversion that respects the platform.
 */
function localScriptPath(relative: string): string {
  return fromFileUrl(new URL(relative, REPO_ROOT))
}

const LINGBOT_MAP_SCRIPT = Deno.env.get('LINGBOT_MAP_SCRIPT') ??
  localScriptPath('./scripts/lingbot_map_worker.py')

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

function broadcast(event: EventPayload): void {
  const msg = JSON.stringify({ ...event, at: Date.now() })
  for (const ws of eventSockets) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    } catch { /* client gone — close handler will clean up */ }
  }
}

// Module-level single-flight WorldJob pump (ADR 0003 "Single-flight
// execution") — mirrors the retired JobQueue's _jobs/_pump()/_working
// pattern (docs/factory/01-merge-jobs/0005 retired the class itself; see
// jobs.ts's header). Dispatch itself (`_dispatchWorldJob`, defined further
// down) stays in main.ts since it needs loadWorld/updateWorld/broadcast and
// the per-type _run*Job functions; only the queue + pump primitive lives in
// world_job_pump.ts, so it's unit-testable in isolation.
const worldJobPump = new WorldJobPump((slug, jobId) => _dispatchWorldJob(slug, jobId))

// Boot-time crash recovery (ADR 0003 "Crash recovery") runs at the bottom of
// this file, right before `Deno.serve(...)` — NOT here. Recovery seeds the
// pump synchronously (`worldJobPump.enqueue`), and dispatch for a recovered
// job can reach the generic placeholder-completion path (`sleep`, defined
// below) or any `_run*Job` helper's module-level `const` dependencies
// (`WORLD_JOB_TYPES`, `LINGBOT_MAP_ARTIFACTS`, the ingest script path
// consts, …) while those top-level statements haven't executed yet —
// calling it this early raced ahead of their initializers and threw
// "Cannot access '<name>' before initialization" (TDZ), silently swallowed
// by `_dispatchWorldJob`'s own try/catch, permanently stranding the
// recovered job in `processing` (verified with a standalone repro: the
// first pump dispatch reliably hit the TDZ before the later `const`
// initializer ran). Running recovery only once every other top-level
// statement has executed — immediately before `Deno.serve` — removes the
// race while still satisfying ADR 0003's actual requirement: recovery
// completes before the server starts accepting requests.

let modelLoaded = false
let engineLoadSettled = false
const engine = new InferenceEngine()
if (engine.mode === 'ollama' && Deno.env.get('OLLAMA_MODEL') === undefined) {
  console.log(formatSetupBanner())
}
const engineLoadPromise = engine.load().then(() => {
  console.log('[server] Model sessions ready')
  modelLoaded = true
}).catch((e) => {
  console.error('[server] Model load failed:', e.message)
  console.error('[server] Running in server-only mode (VLM inference will be unavailable/fallback to WebGPU)')
}).finally(() => {
  engineLoadSettled = true
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const app = new Hono()
const WEBRTC_LIVE_ENABLED = Deno.env.get('VITE_ENABLE_WEBRTC_LIVE') === 'true'

app.onError((err, c) => {
  console.error('[server-error]', err)
  return c.json({ error: err.message }, 500)
})

app.use(logger())
app.use(
  cors({
    origin: (origin) => {
      if (Deno.env.get('DEBUG_CORS') === '1') {
        console.log(`[server] CORS check: origin=${origin}, prefix=${ALLOWED_ORIGIN_PREFIX}`)
      }
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

app.get('/health', (c) => c.json({
  status: 'ok',
  model: engine.modelId,
  modelReady: modelLoaded,
  mode: engine.mode,
  engineLoadState: !engineLoadSettled ? 'loading' : modelLoaded ? 'ready' : 'failed',
  uptimeMs: Date.now() - SERVER_STARTED_AT,
  lastInferMs: engine.lastInferMs,
  lastInferAt: engine.lastInferAt,
}))

/**
 * GET /capabilities — "what can this machine actually do?" over HTTP.
 *
 * Same posture as /health directly above: unauthenticated, and covered by the
 * global CORS policy. Deliberately not stricter — the report was previously
 * only reachable by SSHing in and running `deno run server/capabilities.ts`,
 * which is precisely why a missing ffmpeg showed up as an HTTP 500 instead of
 * a fact anyone could read, and an auth gate on the one route that explains a
 * broken box would recreate that. Deliberately not looser either: it names
 * absolute install paths and versions, which is the same class of host detail
 * /health already returns (model id, mode, uptime), on a server whose reachable
 * surface is Tailscale/LAN (see `isAllowedOrigin`).
 *
 * Cost is where it differs from /health, and it is not a small difference:
 * a full probe spawns one subprocess per tool and the torch one-liner alone
 * measured 1.07s on this box's panoptic venv (capabilities.ts's
 * TORCH_PROBE_SOURCE note). /health is polled by the editor; this must never
 * be. So:
 *   - the answer is cached for CAPABILITY_TTL_MS and the response says so in
 *     Cache-Control and X-Capability-Cache, and `generatedAt` in the body is
 *     the probe time, not the request time;
 *   - concurrent misses share one probe (single-flight), so a page that fires
 *     three of these at load does not spawn three sets of subprocesses;
 *   - `?versions=0` is the cheap mode — pure filesystem lookups, no
 *     subprocesses, every `found` still correct, only version/torch/GPU detail
 *     missing;
 *   - `?fresh=1` bypasses the cache, for the "I just installed it" case.
 */
const CAPABILITY_TTL_MS = 30_000
type CapabilityCacheEntry = { at: number; report: CapabilityReport }
const capabilityCache = new Map<string, CapabilityCacheEntry>()
const capabilityInFlight = new Map<string, Promise<CapabilityReport>>()

app.get('/capabilities', async (c) => {
  const versions = c.req.query('versions') !== '0'
  const fresh = c.req.query('fresh') === '1'
  // Keyed by mode: the fast and full reports are different documents, and
  // serving a cached fast one to a caller that asked for versions would be a
  // silently wrong answer rather than a slow one.
  const key = versions ? 'full' : 'fast'

  const cached = capabilityCache.get(key)
  let hit: 'hit' | 'miss' | 'coalesced' = 'miss'
  let report: CapabilityReport
  if (!fresh && cached && Date.now() - cached.at < CAPABILITY_TTL_MS) {
    report = cached.report
    hit = 'hit'
  } else {
    const running = capabilityInFlight.get(key)
    if (running) {
      hit = 'coalesced'
      report = await running
    } else {
      const probe = probeCapabilities({ versions }).then((r) => {
        capabilityCache.set(key, { at: Date.now(), report: r })
        return r
      }).finally(() => capabilityInFlight.delete(key))
      capabilityInFlight.set(key, probe)
      report = await probe
    }
  }

  c.header('Cache-Control', `private, max-age=${Math.floor(CAPABILITY_TTL_MS / 1000)}`)
  c.header('X-Capability-Cache', hit)
  // The text rendering is the same one the CLI prints, so a curl from a phone
  // and a shell on the box read identically.
  if (c.req.query('format') === 'text') return c.text(formatCapabilityReport(report))
  return c.json(report)
})

app.post('/infer', async (c) => {
  // Reject oversized uploads before buffering them (header check first, then
  // the real byte count for chunked bodies).
  const contentLength = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > INFER_MAX_IMAGE_BYTES) {
    return c.json({ error: `Image too large (${contentLength} bytes; max ${INFER_MAX_IMAGE_BYTES})`, code: 'too-large' }, 413)
  }

  const form = await c.req.formData()
  const imageFile = form.get('image')
  if (!imageFile || !(imageFile instanceof File)) {
    return c.json({ error: 'Missing image field' }, 400)
  }

  // Bounded wait for model load — never park phone requests indefinitely.
  await Promise.race([engineLoadPromise, sleep(ENGINE_LOAD_WAIT_MS)])
  if (!modelLoaded) {
    return engineLoadSettled
      ? c.json({ error: 'Model failed to load on server — install local models or use WebGPU fallback.', code: 'model-failed' }, 503)
      : c.json({ error: `Model still loading after ${ENGINE_LOAD_WAIT_MS / 1000}s — retry shortly.`, code: 'model-loading' }, 503)
  }

  try {
    const buffer = await imageFile.arrayBuffer()
    if (buffer.byteLength > INFER_MAX_IMAGE_BYTES) {
      return c.json({ error: `Image too large (${buffer.byteLength} bytes; max ${INFER_MAX_IMAGE_BYTES})`, code: 'too-large' }, 413)
    }
    console.log(`[infer] Received image: ${buffer.byteLength} bytes`)
    if (!looksLikeImage(new Uint8Array(buffer))) {
      // Not an image at all — most often a proxy or dev-server fallback page that
      // answered 200 with HTML. That is the caller's problem, not a server fault,
      // so it gets a 400 like every other malformed upload rather than a 500.
      return c.json({ error: 'Uploaded file is not a recognised image (expected JPEG, PNG or WebP)', code: 'bad-image' }, 400)
    }
    const started = Date.now()
    const detections = await Promise.race([
      engine.infer(new Uint8Array(buffer)),
      sleep(INFER_TIMEOUT_MS).then(() => 'timeout' as const),
    ])
    if (detections === 'timeout') {
      console.error(`[infer error] inference exceeded ${INFER_TIMEOUT_MS}ms`)
      return c.json({ error: `Inference timed out after ${INFER_TIMEOUT_MS / 1000}s`, code: 'timeout' }, 504)
    }
    const elapsed = Date.now() - started
    console.log(`[infer] Returning ${detections.length} detections in ${elapsed}ms:`, JSON.stringify(detections))
    c.header('Server-Timing', `infer;dur=${elapsed}`)
    c.header('X-Inference-Ms', String(elapsed))
    return c.json(detections)
  } catch (err) {
    // A decoder throwing on truncated or corrupt pixel data is bad input, not a
    // server fault — a phone uploading a half-written frame must not read as a
    // 500, or the client retries a request that can never succeed.
    if (isDecodeError(err)) {
      console.warn('[infer] undecodable image:', String(err))
      return c.json({ error: `Image could not be decoded: ${String(err)}`, code: 'bad-image' }, 400)
    }
    console.error('[infer error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

/** Container sniff — JPEG (SOI), PNG, WebP (RIFF….WEBP). */
function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true
  const ascii = (i: number, s: string) => [...s].every((ch, k) => bytes[i + k] === ch.charCodeAt(0))
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return true
  return false
}

/**
 * Distinguishes "these bytes are not decodable" from a genuine server fault.
 *
 * Matches the vocabulary the image decoders below us actually throw in — jpeg-js
 * ("unknown JPEG marker 0x..", "marker was not found", "Invalid JPEG"), Jimp
 * ("Could not find MIME for Buffer", "Unsupported MIME type"), and the PNG/WebP
 * paths. It is deliberately broad: a frame the decoder rejects is the caller's
 * problem, and calling it 500 tells the client to retry a request that can never
 * succeed. The cost of the opposite mistake — reporting a real fault as 400, so
 * the client gives up — is bounded here because these words do not appear in the
 * I/O and resource errors this route can otherwise raise.
 */
function isDecodeError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase()
  return /marker|jpeg|jpg|png|webp|bitmap|mime|decode|corrupt|invalid|malformed|unsupported|unexpected end|truncat|huffman|scan data/.test(msg)
}

// ── Phone-side console relay (?debug=remote pages POST here) ─────────────────
const clientLogHits = new Map<string, number[]>()

app.post('/client-logs', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const now = Date.now()
  const hits = (clientLogHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= 60) return c.json({ error: 'Rate limit exceeded' }, 429)
  hits.push(now)
  clientLogHits.set(ip, hits)

  const raw = await c.req.text()
  if (raw.length > 16_384) return c.json({ error: 'Log payload too large' }, 413)

  let body: { entries?: Array<{ ts?: number; level?: string; msg?: string; stack?: string; url?: string }>; ua?: string }
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!Array.isArray(body.entries)) return c.json({ error: 'Missing entries array' }, 400)

  const ipTag = ip.includes('.') ? ip.split('.').pop()! : ip
  for (const entry of body.entries) {
    const record = {
      ts: entry.ts ?? now,
      level: String(entry.level ?? 'log'),
      msg: String(entry.msg ?? '').slice(0, 1000),
      stack: entry.stack?.slice(0, 2000),
      url: entry.url,
      ua: body.ua,
      ip: ipTag,
    }
    console.log(`[client ${ipTag}] ${record.level} ${record.msg}`)
    try {
      await Deno.writeTextFile(`${SCANS_DIR}/client-logs.jsonl`, JSON.stringify(record) + '\n', { append: true })
    } catch (e) {
      console.warn('[client-logs] append failed:', e)
    }
    broadcast({ type: EVENT.CLIENT_LOG, ...record })
  }
  return c.body(null, 204)
})

// ── Scan file storage ─────────────────────────────────────────────────────────

/**
 * Creates the scan file with `createNew`, so the name is claimed atomically by the
 * filesystem rather than by a check-then-write that two concurrent uploads can both
 * win. Returns the open handle and the name that was actually taken.
 */
async function createScanFileExclusive(
  dir: string,
  ts: number,
  safeName: string,
): Promise<{ file: Deno.FsFile; filename: string }> {
  const stem = safeName.replace(/\.glb$/, '')
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = attempt === 0 ? '' : `-${crypto.randomUUID().slice(0, 8)}`
    const filename = `${ts}_${stem}${suffix}.glb`
    try {
      const file = await Deno.open(`${dir}/${filename}`, { write: true, createNew: true })
      return { file, filename }
    } catch (err) {
      if (err instanceof Deno.errors.AlreadyExists) continue
      throw err
    }
  }
  throw new Error(`could not allocate a unique filename for ${safeName} after 8 attempts`)
}

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

  try {
    const buffer = await file.arrayBuffer()
    // A millisecond timestamp does NOT guarantee uniqueness: two uploads landing in
    // the same millisecond with the same name produced identical paths, so the
    // second silently overwrote the first and both callers were told they had
    // stored a scan. Claim the name atomically instead and disambiguate on a real
    // collision — the common case keeps the plain `<ts>_<name>` form.
    const { file: handle, filename } = await createScanFileExclusive(SCANS_DIR, Date.now(), safeName)
    const filePath = `${SCANS_DIR}/${filename}`
    try {
      await handle.write(new Uint8Array(buffer))
    } finally {
      handle.close()
    }
    console.log(`[scan] Saved ${filename} (${(buffer.byteLength / 1024).toFixed(0)} KB)`)

    // Optional metadata JSON alongside the .glb
    const metaRaw = form.get('metadata')
    if (metaRaw && typeof metaRaw === 'string') {
      const metaPath = filePath.replace(/\.glb$/, '.json')
      await Deno.writeTextFile(metaPath, metaRaw)
      console.log(`[scan] Saved metadata for ${filename}`)
    }

    // Every uploaded scan is optimized automatically (quantize/Draco/LODs)
    const job = await enqueueOptimizeScanJob(filename)
    broadcast({ type: EVENT.SCAN_ADDED, filename, size: buffer.byteLength })

    return c.json({ filename, size: buffer.byteLength, job: job.jobId })
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
    // Shim (ADR 0003 / ticket 0004): per-file job status used to come from
    // jobQueue.jobForTarget(); optimize-scan jobs now live as WorldJobs
    // parked under the 'default' world (enqueueOptimizeScanJob) — load once
    // outside the loop and translate through worldJobToLegacyJob.
    const jobWorld = await loadWorld('default')
    const optimizeScanJobs = jobWorld.jobs.filter(j => j.type === 'optimize-scan')
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.glb')) continue
      if (isDerivedScanFile(entry.name)) continue
      const stat = await Deno.stat(`${SCANS_DIR}/${entry.name}`)
      let optimized = false
      try {
        await Deno.stat(`${SCANS_DIR}/${entry.name.replace(/\.glb$/, '.manifest.json')}`)
        optimized = true
      } catch { /* not optimized yet */ }
      // world.jobs is newest-first (createWorldJob unshifts), so the first
      // match is the latest job for this target — mirrors jobForTarget()'s
      // "scan from the end" semantics on JobQueue's oldest-first array.
      const wj = optimizeScanJobs.find(j => worldJobTarget(j) === entry.name)
      const job = wj ? worldJobToLegacyJob(wj) : undefined
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
  const job = await enqueueOptimizeScanJob(filename)
  return c.json(job, 202)
})

// ── Job queue state ───────────────────────────────────────────────────────────
// Shim (ADR 0003 / ticket 0004): both routes used to read `jobQueue` directly.
// optimize-scan jobs now run as WorldJobs under the 'default' world — filter
// to that type (the only type JobQueue ever held) and translate through
// worldJobToLegacyJob so the response shape and job population are
// byte-identical to before ticket 0003.

app.get('/jobs', async (c) => {
  const world = await loadWorld('default')
  // world.jobs is already newest-first (createWorldJob unshifts), matching
  // what `[...jobQueue.jobs].reverse()` produced from JobQueue's
  // oldest-first array — no extra reverse needed here.
  const jobs = world.jobs.filter(j => j.type === 'optimize-scan').map(worldJobToLegacyJob)
  return c.json(jobs)
})

app.get('/jobs/:id', async (c) => {
  const world = await loadWorld('default')
  const wj = world.jobs.find(j => j.type === 'optimize-scan' && j.jobId === c.req.param('id'))
  return wj ? c.json(worldJobToLegacyJob(wj)) : c.json({ error: 'Not found' }, 404)
})

// ── Splat-train + splat-detect + splat-finish artifacts ──────────────────────
// Trained Gaussian-splat + detection sidecars land in SCANS_DIR next to the scan:
//   <base>.splat.ply                    INRIA 3DGS point cloud (Brush output)
//   <base>.sog                          super-compressed SOG bundle (single ZIP:
//                                       meta.json + WebP textures — splat-finish)
//   <base>.compressed.ply               SuperSplat compressed PLY (splat-finish)
//   <base>.splat-train.manifest.json    train run index (status/gaussianCount/params)
//   <base>.splat-finish.manifest.json   finish run index (status/sizes/timing)
//   <base>.interactions.json            splat-analyzer 3D object boxes + interactions
//   <base>.splat-detect.manifest.json   detect run index (status/objectCount/prompt)
// Gated by an allowlisted suffix + the same traversal guard as /scans/:filename.
// Registered before the .glb-only /scans/:filename route so these suffixes win.
// NOTE: order matters — `.splat-*.manifest.json` suffixes are checked before the
// plainer `.interactions.json`/`.json` suffixes so the more specific one wins.
const SPLAT_ARTIFACT_MIME: Array<{ suffix: string; mime: string }> = [
  { suffix: '.splat-train.manifest.json', mime: 'application/json' },
  { suffix: '.splat-detect.manifest.json', mime: 'application/json' },
  { suffix: '.splat-finish.manifest.json', mime: 'application/json' },
  { suffix: '.splat-align.manifest.json', mime: 'application/json' },
  { suffix: '.interactions.json', mime: 'application/json' },
  { suffix: '.4d-capture.manifest.json', mime: 'application/json' },
  { suffix: '.compressed.ply', mime: 'application/octet-stream' },
  { suffix: '.splat.ply', mime: 'application/octet-stream' },
  // Bundled SOG is a ZIP container; served as a binary download/asset.
  { suffix: '.sog', mime: 'application/octet-stream' },
]

app.get('/scans/:filename{.+\\.(splat\\.ply|compressed\\.ply|sog|splat-train\\.manifest\\.json|splat-detect\\.manifest\\.json|splat-finish\\.manifest\\.json|splat-align\\.manifest\\.json|4d-capture\\.manifest\\.json|interactions\\.json)}', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
    return c.json({ error: 'Invalid filename' }, 400)
  }
  const entry = SPLAT_ARTIFACT_MIME.find(e => filename.endsWith(e.suffix))
  if (!entry) return c.json({ error: 'Invalid splat artifact path' }, 400)
  try {
    const data = await Deno.readFile(`${SCANS_DIR}/${filename}`)
    return new Response(data, {
      headers: {
        'Content-Type': entry.mime,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch {
    return c.json({ error: 'Splat artifact not found' }, 404)
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
    broadcast({ type: EVENT.SCAN_DELETED, filename })
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
    broadcast({ type: EVENT.SCANS_CLEARED, deleted })
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

const KEYFRAME_FILE_RE = /^kf-\d{5}\.jpg$/

/**
 * Shape-only resolution, bound to this server's SESSIONS_DIR. Says nothing
 * about existence — use `resolveSessionDirFor` where that matters.
 */
function sessionDir(id: string | null | undefined): string | null {
  return sessionDirPath(SESSIONS_DIR, id)
}

/** Shape *and* existence. See session_id.ts for why both resolvers exist. */
function resolveSessionDirFor(id: string | null | undefined): Promise<string | null> {
  return resolveSessionDir(SESSIONS_DIR, id)
}

app.post('/sessions', async (c) => {
  // The single minting site for a capture-session id, and the only place that
  // creates the directory one names. Both halves living here is what makes the
  // id trustworthy downstream.
  const sessionId = newServerSessionId()

  // Optional take membership. A take is N simultaneous captures of one subject,
  // and it is the *derived* set of sessions sharing a takeId rather than a
  // stored aggregate — so there is nothing to create here beyond recording the
  // key. Absent takeId keeps meaning exactly what it always has: an ordinary
  // solo capture. Both fields are validated rather than trusted; takeId is
  // echoed into a signalling room name, so a malformed one must not survive.
  const body = await c.req.json().catch(() => ({})) as { takeId?: unknown; clientId?: unknown }
  const takeId = isTakeId(body.takeId) ? body.takeId : null
  const clientId = takeId && isClientId(body.clientId) ? body.clientId : null

  await Deno.mkdir(`${SESSIONS_DIR}/${sessionId}`, { recursive: true })
  const record = {
    sessionId,
    startedAt: new Date().toISOString(),
    keyframeCount: 0,
    ...(takeId ? { takeId } : {}),
    ...(clientId ? { clientId } : {}),
  }
  await Deno.writeTextFile(`${SESSIONS_DIR}/${sessionId}/session.json`, JSON.stringify(record, null, 2))
  console.log(`[session] opened ${sessionId}${takeId ? ` (take ${takeId})` : ''}`)
  broadcast({ type: EVENT.SESSION_STARTED, sessionId })
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

const LINGBOT_MAP_ARTIFACTS: Record<string, string> = {
  'lingbot-map.point-cloud.ply': 'application/octet-stream',
  'lingbot-map.poses.json': 'application/json',
  'lingbot-map.manifest.json': 'application/json',
}

// GET /sessions/:id/clip/:file — the durable person clip.
//
// The only ranged route in this codebase. A clip is orders of magnitude larger
// than the JPEG keyframes this directory layout was sized for, so it is served
// with a seeking read rather than buffered whole like every other artifact —
// both so the editor can scrub it and so a few concurrent requests cannot
// exhaust the box.
const CLIP_FILE_MIME: Record<string, string> = {
  'clip.mp4': 'video/mp4',
  'clip.webm': 'video/webm',
}

// GET /scans/:base.4d/:frame — one timestep of a 4D person sequence.
//
// The only artifact route with a path segment beyond the flat SCANS_DIR. A
// sequence is hundreds of files, and the flat suffix-allowlist route this repo
// otherwise uses would need a per-frame regex; a directory also keeps
// `GET /scans`'s sweep from walking them. Same traversal guard as every other
// artifact route, applied to both segments.
app.get('/scans/:base/:frame', async (c) => {
  const base = c.req.param('base')
  const frame = c.req.param('frame')
  if (!base.endsWith('.4d')) return c.json({ error: 'Not found' }, 404)
  for (const part of [base, frame]) {
    if (part.includes('/') || part.includes('\\') || part.startsWith('.') || part.includes('..')) {
      return c.json({ error: 'Invalid path' }, 400)
    }
  }
  // Allowlist the frame shape rather than sanitising it — the writer is the
  // subsystem and the names are fully determined.
  if (!/^frame-\d{5}\.(sog|ply)$/.test(frame)) return c.json({ error: 'Invalid frame path' }, 400)

  try {
    const bytes = await Deno.readFile(`${SCANS_DIR}/${base}/${frame}`)
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/octet-stream',
        // A sequence frame is immutable once written — a rebuild lands under a
        // new job rather than editing in place.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

app.get('/sessions/:id/pose-track.json', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  try {
    const bytes = await Deno.readFile(`${dir}/pose-track.json`)
    return new Response(bytes, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

app.get('/sessions/:id/clip/:file', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  // An allowlist, not a sanitiser — clip filenames are server-chosen, so only
  // the two names the ingest route can write resolve at all.
  const file = c.req.param('file')
  const mime = CLIP_FILE_MIME[file]
  if (!mime) return c.json({ error: 'Invalid clip path' }, 400)

  const path = `${dir}/${file}`
  let size: number
  try {
    const stat = await Deno.stat(path)
    if (!stat.isFile) return c.json({ error: 'Not found' }, 404)
    size = stat.size
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }

  return await rangedResponse({
    rangeHeader: c.req.header('range'),
    size,
    contentType: mime,
    cacheControl: 'private, max-age=300',
    readRange: (start, length) => readFileRange(path, start, length),
    readAll: () => Deno.readFile(path),
  })
})

app.get('/sessions/:id/:artifact{lingbot-map\\..+}', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  const artifact = c.req.param('artifact')
  const mime = dir ? LINGBOT_MAP_ARTIFACTS[artifact] : undefined
  if (!mime) return c.json({ error: 'Invalid artifact path' }, 400)
  try {
    const data = await Deno.readFile(`${dir}/${artifact}`)
    return new Response(data, {
      headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=300' },
    })
  } catch {
    return c.json({ error: 'Artifact not found' }, 404)
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
        await enqueueOptimizeScanJob(glbFilename)
      }
    } catch { /* glb not uploaded yet — upload-scan enqueues on arrival */ }
  }
  // `record` is `Record<string, unknown>` (read back from session.json), but
  // `sessionId` is always the string minted by `POST /sessions` — narrowing
  // cast per src/shared/events.ts's EventPayload doc comment, not a type change.
  broadcast({ type: EVENT.SESSION_FINALIZED, sessionId: record['sessionId'] as string, keyframeCount, glbFilename })
  return c.json(record)
})

// ── Video ingest — "walk the house shooting normal video" ────────────────────
//
// POST /ingest-video   multipart { video: File, name?, fps? }
// `fps` is optional and omitting it is meaningful: the extractor then picks the
// rate adaptively from the clip's duration (see the `fps` const below).
// Extracts keyframes with scripts/ingest-video.mjs into a capture session, then
// registers a session-backed scan in the selected Place (or the legacy default
// workspace when none is supplied) and auto-enqueues a
// lingbot-map-reconstruct job (which estimates the per-frame poses splat-train +
// splat-detect later consume). Returns 202 { sessionId, scanId, jobId, frameCount }.
const INGEST_VIDEO_SCRIPT = localScriptPath('./scripts/ingest-video.mjs')

app.post('/ingest-video', async (c) => {
  // Guard oversized uploads up front via Content-Length (before buffering).
  const contentLength = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > INGEST_MAX_VIDEO_BYTES) {
    return c.json({ error: `video exceeds ${INGEST_MAX_VIDEO_BYTES} bytes`, maxBytes: INGEST_MAX_VIDEO_BYTES }, 413)
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'expected multipart/form-data with a video field', code: 'bad-request' }, 400)
  }
  const video = form.get('video')
  if (!video || !(video instanceof File)) {
    return c.json({ error: 'Missing video field (expected a video File)' }, 400)
  }
  if (Number.isFinite(video.size) && video.size > INGEST_MAX_VIDEO_BYTES) {
    return c.json({ error: `video exceeds ${INGEST_MAX_VIDEO_BYTES} bytes`, maxBytes: INGEST_MAX_VIDEO_BYTES }, 413)
  }

  const nameRaw = form.get('name')
  const scanName = typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim() : null
  const projectIdRaw = form.get('projectId')
  const projectId = typeof projectIdRaw === 'string' && projectIdRaw.trim().length > 0 ? projectIdRaw.trim() : null
  const areaIdRaw = form.get('areaId')
  const areaId = typeof areaIdRaw === 'string' && areaIdRaw.trim().length > 0 ? areaIdRaw.trim() : null
  const selectedProject = projectId ? (await loadProjects()).find(project => project.projectId === projectId) : null
  if (projectId && !selectedProject) return c.json({ error: 'Selected Place was not found' }, 404)
  if (areaId && !selectedProject?.areas?.some(area => area.areaId === areaId)) {
    return c.json({ error: 'Selected Area was not found in this Place' }, 404)
  }
  const fpsRaw = form.get('fps')

  // Ingest has two modes, and they differ on one load-bearing point: what the
  // durable artifact is.
  //
  //  - 'walkthrough' (the default, and every pre-existing caller) extracts
  //    keyframes and deletes the video. The keyframe session is the artifact.
  //  - 'person' KEEPS the clip, because 4DAnyone consumes the video itself
  //    rather than frames, and extracts only a few thumbnails for the editor.
  //
  // Both statements are true; neither generalises. Absent mode is walkthrough,
  // so every existing client is unaffected.
  const modeRaw = form.get('mode')
  const personMode = modeRaw === 'person'

  // `null` means "pass no --fps at all", which is NOT the same as passing the
  // script's documented 2fps default: without the flag, ingest-video.mjs runs
  // its adaptive policy (scripts/ingest-video.mjs `resolveFps`) and raises the
  // sample rate on short clips so they still reach TARGET_MIN_FRAMES = 40.
  // This route used to hardcode '2', which meant that policy could never fire
  // from the server — measured: the 16s walkthrough behind
  // scans/sessions/sess-video-20260830-033839 yielded 32 keyframes, below the
  // script's own floor, from a route that looked like it was accepting the
  // default. A caller that supplies fps still wins outright.
  const fps = typeof fpsRaw === 'string' && Number.isFinite(Number(fpsRaw)) && Number(fpsRaw) > 0
    ? String(Number(fpsRaw))
    // A person clip needs thumbnails, not a reconstruction dataset — the clip
    // is what gets reconstructed, off-box. Sampling it at walkthrough rates
    // would write hundreds of frames nothing reads, so person mode keeps its
    // fixed low rate and opts out of the adaptive policy on purpose.
    : personMode
    ? String(PERSON_THUMBNAIL_FPS)
    : null

  const takeIdRaw = form.get('takeId')
  const takeId = isTakeId(takeIdRaw) ? takeIdRaw : null
  const clientIdRaw = form.get('clientId')
  const clientId = isClientId(clientIdRaw) ? clientIdRaw : null
  const mimeRaw = form.get('mimeType')
  // The negotiated container differs per device and the extension cannot be
  // trusted to imply it — Safari and Chrome disagree on both.
  const clipMime = typeof mimeRaw === 'string' && /^video\/(mp4|webm)(;|$)/.test(mimeRaw)
    ? mimeRaw
    : null
  const poseTrack = form.get('poseTrack')

  // Save the upload to a temp file the ingest script reads, then delete it.
  const tmpDir = `${SCANS_DIR}/tmp`
  await Deno.mkdir(tmpDir, { recursive: true })
  const safeExt = (video.name.match(/\.(mp4|mov|m4v|webm|avi|mkv)$/i)?.[0] ?? '.mp4').toLowerCase()
  const tmpVideo = `${tmpDir}/ingest-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${safeExt}`
  try {
    await Deno.writeFile(tmpVideo, new Uint8Array(await video.arrayBuffer()))
  } catch (err) {
    return c.json({ error: `could not buffer video: ${err}` }, 500)
  }

  try {
    // Run the ingest script; the LAST stdout line is JSON { sessionId, frameCount, sessionDir }.
    const cmd = new Deno.Command('node', {
      args: [
        INGEST_VIDEO_SCRIPT,
        tmpVideo,
        '--scans-dir',
        SCANS_DIR,
        '--sessions-dir',
        SESSIONS_DIR,
        ...(fps === null ? [] : ['--fps', fps]),
      ],
      stdout: 'piped',
      stderr: 'piped',
    })
    const output = await cmd.output()
    const stdout = new TextDecoder().decode(output.stdout).trim()
    const stderr = new TextDecoder().decode(output.stderr).trim()

    const lastLine = stdout.split('\n').filter(Boolean).pop() ?? ''
    let parsed: { sessionId?: string; frameCount?: number; sessionDir?: string } = {}
    try {
      parsed = JSON.parse(lastLine)
    } catch { /* handled per-mode below */ }

    // The two modes disagree about how bad a failed extraction is, and the
    // difference is exactly which artifact is durable.
    //
    //  - walkthrough: the keyframes ARE the artifact, so a failure is total.
    //  - person: the CLIP is the artifact and the frames are thumbnails for the
    //    editor's preview. Losing them costs a preview; failing the request
    //    would lose a recording the user cannot re-shoot. So person mode
    //    degrades — it still opens a session and still keeps the clip.
    const extractionFailed = output.code !== 0 || !parsed.sessionId || !sessionDir(parsed.sessionId)
    if (extractionFailed && !personMode) {
      console.error('[ingest-video] script failed:', stderr)
      return c.json({ error: `ingest failed (exit ${output.code})`, detail: stderr.slice(-500) }, 500)
    }

    let sessionId = parsed.sessionId
    let frameCount = parsed.frameCount ?? 0
    if (extractionFailed) {
      console.warn(`[ingest-video] thumbnail extraction failed (exit ${output.code}); keeping the clip anyway:`, stderr.slice(-300))
      frameCount = 0
      // Mint a session directly. The clip still needs somewhere durable to live,
      // and the id is what everything downstream keys off.
      sessionId = newServerSessionId()
      await Deno.mkdir(`${SESSIONS_DIR}/${sessionId}`, { recursive: true })
      await Deno.writeTextFile(
        `${SESSIONS_DIR}/${sessionId}/session.json`,
        JSON.stringify({ sessionId, startedAt: new Date().toISOString(), keyframeCount: 0 }, null, 2),
      )
    }
    if (!sessionId || !sessionDir(sessionId)) {
      return c.json({ error: `ingest returned an invalid session id: ${sessionId}` }, 500)
    }

    // Register in the Place-specific world when selected. This keeps uploads
    // from silently leaking into the default workspace.
    const targetSlug = projectId ? projectWorldSlug(projectId) : 'default'
    if (projectId) await loadProjectWorld(projectId)

    if (personMode) {
      // Keep the clip. This is the one place the two modes genuinely diverge:
      // the video IS the artifact here, so it is moved into the session
      // directory instead of being dropped by the `finally` below.
      const clipExt = clipMime?.startsWith('video/webm') ? 'webm' : 'mp4'
      const clipName = `clip.${clipExt}`
      const sessionPath = `${SESSIONS_DIR}/${sessionId}`
      await Deno.copyFile(tmpVideo, `${sessionPath}/${clipName}`)

      if (poseTrack instanceof File) {
        await Deno.writeFile(`${sessionPath}/pose-track.json`, new Uint8Array(await poseTrack.arrayBuffer()))
      }

      // Record take membership and the real container on the session record, so
      // the processing subsystem never has to guess either.
      try {
        const recordPath = `${sessionPath}/session.json`
        const record = JSON.parse(await Deno.readTextFile(recordPath)) as Record<string, unknown>
        record['captureKind'] = 'person'
        // Visible rather than silent: a preview-less clip is still fully
        // reconstructable, but the editor should be able to say why it has no
        // thumbnail instead of appearing broken.
        if (extractionFailed) record['thumbnailsUnavailable'] = true
        record['clipFile'] = clipName
        record['clipMimeType'] = clipMime ?? `video/${clipExt}`
        record['clipBytes'] = video.size
        if (takeId) record['takeId'] = takeId
        if (clientId) record['clientId'] = clientId
        if (poseTrack instanceof File) record['poseTrackFile'] = 'pose-track.json'
        await Deno.writeTextFile(recordPath, JSON.stringify(record, null, 2))
      } catch (err) {
        console.error('[ingest-video] could not record person clip metadata:', err)
      }

      // Deliberately NO lingbot-map-reconstruct: that job reconstructs a
      // *place* from a walkthrough and has nothing to say about a person. The
      // person-4d-reconstruct job is enqueued explicitly, once the take is
      // complete — a take may still be gaining members at this point.
      const { value: personScan } = await updateWorld(targetSlug, (world) =>
        registerSessionScan(world, sessionId, scanName ?? undefined, frameCount, 'person-capture', projectId, areaId))

      broadcast({ type: EVENT.VIDEO_INGESTED, sessionId, scanId: personScan.scanId, jobId: '', frameCount })
      return c.json({
        sessionId,
        scanId: personScan.scanId,
        jobId: null,
        frameCount,
        takeId,
        clipUrl: `/sessions/${sessionId}/clip/${clipName}`,
      }, 202)
    }

    const { world, value: { scan, job } } = await updateWorld(targetSlug, (world) => {
      const scan = registerSessionScan(world, sessionId, scanName ?? undefined, frameCount, 'video-ingest', projectId, areaId)
      const job = createWorldJob(world, 'lingbot-map-reconstruct', scan.scanId, {
        source: 'video-ingest', projectId, areaId,
        sessionId,
        frameCount,
      })
      return { scan, job }
    })
    await completeJobSoon(world.shareSlug, job.jobId)

    broadcast({ type: EVENT.VIDEO_INGESTED, sessionId, scanId: scan.scanId, jobId: job.jobId, frameCount })
    return c.json({ sessionId, scanId: scan.scanId, jobId: job.jobId, frameCount }, 202)
  } finally {
    // Always drop the TEMP video. In person mode the clip has already been
    // copied into the session directory above — that copy is the durable
    // artifact, and this only removes the upload scratch file.
    await removeIfExists(tmpVideo)
  }
})

// ── Photo ingest — "a set of photos instead of a walkthrough video" ──────────
//
// POST /ingest-photos   multipart { files: File[], name? }
// Saves the photos to a temp dir, runs scripts/ingest-photos.mjs (EXIF time
// ordering + blur filter) in --single-session mode (one upload = one session),
// then registers a session-backed scan in the selected Place and auto-enqueues lingbot-map-reconstruct
// exactly like /ingest-video. Returns 202 { sessionId, scanId, jobId, frameCount,
// droppedBlurry }.
const INGEST_PHOTOS_SCRIPT = localScriptPath('./scripts/ingest-photos.mjs')

app.post('/ingest-photos', async (c) => {
  // Guard oversized uploads up front via Content-Length (before buffering).
  const contentLength = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > INGEST_MAX_PHOTOS_BYTES) {
    return c.json({ error: `photos exceed ${INGEST_MAX_PHOTOS_BYTES} bytes`, maxBytes: INGEST_MAX_PHOTOS_BYTES }, 413)
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'expected multipart/form-data with a files field', code: 'bad-request' }, 400)
  }
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return c.json({ error: 'Missing files field (expected one or more photo Files)' }, 400)
  }

  const nameRaw = form.get('name')
  const scanName = typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim() : null
  const projectIdRaw = form.get('projectId')
  const projectId = typeof projectIdRaw === 'string' && projectIdRaw.trim().length > 0 ? projectIdRaw.trim() : null
  const areaIdRaw = form.get('areaId')
  const areaId = typeof areaIdRaw === 'string' && areaIdRaw.trim().length > 0 ? areaIdRaw.trim() : null
  const selectedProject = projectId ? (await loadProjects()).find(project => project.projectId === projectId) : null
  if (projectId && !selectedProject) return c.json({ error: 'Selected Place was not found' }, 404)
  if (areaId && !selectedProject?.areas?.some(area => area.areaId === areaId)) {
    return c.json({ error: 'Selected Area was not found in this Place' }, 404)
  }

  // Save the upload to a temp dir the ingest script reads, then delete it.
  // The index prefix keeps upload order stable for photos without EXIF.
  const tmpDir = `${SCANS_DIR}/tmp/ingest-photos-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  await Deno.mkdir(tmpDir, { recursive: true })
  try {
    let index = 0
    for (const file of files) {
      const ext = (file.name.match(/\.(jpe?g|png)$/i)?.[0] ?? '.jpg').toLowerCase()
      const safeStem = (file.name.replace(/\.[^.]*$/, '') || 'photo')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.\./g, '__')
        .replace(/^[._-]+/, '') || 'photo'
      const dest = `${tmpDir}/${String(index).padStart(4, '0')}-${safeStem}${ext}`
      await Deno.writeFile(dest, new Uint8Array(await file.arrayBuffer()))
      index += 1
    }

    // Run the ingest script; the LAST stdout line is JSON
    // { sessionId, frameCount, sessionDir, droppedBlurry, … }.
    const cmd = new Deno.Command('node', {
      args: [INGEST_PHOTOS_SCRIPT, tmpDir, '--scans-dir', SCANS_DIR, '--sessions-dir', SESSIONS_DIR, '--single-session', 'true'],
      stdout: 'piped',
      stderr: 'piped',
    })
    const output = await cmd.output()
    const stdout = new TextDecoder().decode(output.stdout).trim()
    const stderr = new TextDecoder().decode(output.stderr).trim()
    if (output.code !== 0) {
      console.error('[ingest-photos] script failed:', stderr)
      return c.json({ error: `ingest failed (exit ${output.code})`, detail: stderr.slice(-500) }, 500)
    }

    const lastLine = stdout.split('\n').filter(Boolean).pop() ?? ''
    let parsed: { sessionId?: string; frameCount?: number; sessionDir?: string; droppedBlurry?: number }
    try {
      parsed = JSON.parse(lastLine)
    } catch {
      console.error('[ingest-photos] could not parse script output:', stdout)
      return c.json({ error: 'ingest produced no parseable summary' }, 500)
    }
    const sessionId = parsed.sessionId
    const frameCount = parsed.frameCount ?? 0
    if (!sessionId || !sessionDir(sessionId)) {
      return c.json({ error: `ingest returned an invalid session id: ${sessionId}` }, 500)
    }

    // Mirrors video ingest while retaining the user-selected Place/Area.
    const targetSlug = projectId ? projectWorldSlug(projectId) : 'default'
    if (projectId) await loadProjectWorld(projectId)
    const { world, value: { scan, job } } = await updateWorld(targetSlug, (world) => {
      const scan = registerSessionScan(world, sessionId, scanName ?? undefined, frameCount, 'photo-ingest', projectId, areaId)
      const job = createWorldJob(world, 'lingbot-map-reconstruct', scan.scanId, {
        source: 'photo-ingest', projectId, areaId,
        sessionId,
        frameCount,
      })
      return { scan, job }
    })
    await completeJobSoon(world.shareSlug, job.jobId)

    broadcast({ type: EVENT.PHOTOS_INGESTED, sessionId, scanId: scan.scanId, jobId: job.jobId, frameCount })
    return c.json({
      sessionId,
      scanId: scan.scanId,
      jobId: job.jobId,
      frameCount,
      droppedBlurry: parsed.droppedBlurry ?? 0,
    }, 202)
  } finally {
    // Always drop the temp photos — the keyframe session is the durable artifact.
    try {
      await Deno.remove(tmpDir, { recursive: true })
    } catch { /* already gone */ }
  }
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
  // Same sweep the scan listing needs, so it exists once (scan_index.ts) rather than
  // twice. bySessionId preserves Deno.readDir order, so this response is unchanged.
  const index = await loadSessionIndex(SESSIONS_DIR)
  return c.json([...index.bySessionId.values()])
})

// GET /takes/:takeId — the member sessions of one take.
//
// A take has no directory and no record of its own: it is the set of sessions
// sharing a takeId, resolved from the sweep loadSessionIndex already performs.
// A well-formed id with no members is 200 + an empty array rather than 404 —
// the take may simply not have been recorded yet, and the two are not worth
// distinguishing to a caller that is about to poll anyway.
app.get('/takes/:takeId', async (c) => {
  const takeId = c.req.param('takeId')
  if (!isTakeId(takeId)) return c.json({ error: 'Invalid take id' }, 400)
  const index = await loadSessionIndex(SESSIONS_DIR)
  const sessions = sessionsForTake(index, takeId)
  return c.json({ takeId, memberCount: sessions.length, sessions })
})

// POST /takes/:takeId/sync — a member reports its measured clock offset.
//
// Each device measures its own offset from server time and posts it here; the
// server is the only place that can compute the number that actually matters,
// the inter-member residual, because only it sees every member's estimate.
//
// Idempotent and order-independent: members report whenever their burst
// finishes, and every report recomputes the residual across everyone who has
// reported so far and rewrites all their records. So a take that starts as one
// member ('unsynced', 'solo-take') becomes 'measured' for both the moment a
// second member reports, without anything needing to re-post.
app.post('/takes/:takeId/sync', async (c) => {
  const takeId = c.req.param('takeId')
  if (!isTakeId(takeId)) return c.json({ error: 'Invalid take id' }, 400)

  const body = await c.req.json().catch(() => ({})) as {
    clientId?: unknown; offsetMs?: unknown; sampleCount?: unknown; expectedMembers?: unknown
  }
  if (!isClientId(body.clientId)) return c.json({ error: 'Missing or malformed clientId' }, 400)
  // A null estimate is a legitimate outcome — every probe in the burst was
  // dropped — and it must be recorded as exchange-failed rather than coerced to
  // a zero offset that would read as a perfect measurement.
  const failed = body.offsetMs === null
  if (!failed && typeof body.offsetMs !== 'number') {
    return c.json({ error: 'offsetMs must be a number, or null for a failed exchange' }, 400)
  }

  const index = await loadSessionIndex(SESSIONS_DIR)
  const memberIds = index.byTakeId.get(takeId) ?? []
  if (memberIds.length === 0) return c.json({ error: 'Take has no member sessions' }, 404)

  const measuredAt = new Date().toISOString()

  // Stash this member's raw estimate first, then aggregate over everyone who
  // has one. The raw offset is kept alongside the derived record so a later
  // report can recompute the residual without asking anyone to re-measure.
  const reported = new Map<string, { offsetMs: number; sampleCount: number }>()
  const sessionByClient = new Map<string, string>()
  for (const sessionId of memberIds) {
    const record = index.bySessionId.get(sessionId)
    const clientId = record ? asString(record['clientId']) : null
    if (!clientId) continue
    sessionByClient.set(clientId, sessionId)
    if (clientId === body.clientId) {
      if (!failed) {
        reported.set(clientId, {
          offsetMs: body.offsetMs as number,
          sampleCount: typeof body.sampleCount === 'number' ? body.sampleCount : 0,
        })
      }
      continue
    }
    const prior = record?.['syncOffset'] as { offsetMs?: unknown; sampleCount?: unknown } | undefined
    if (prior && typeof prior.offsetMs === 'number') {
      reported.set(clientId, {
        offsetMs: prior.offsetMs,
        sampleCount: typeof prior.sampleCount === 'number' ? prior.sampleCount : 0,
      })
    }
  }

  const expectedMembers = typeof body.expectedMembers === 'number' ? body.expectedMembers : sessionByClient.size
  const records = buildTakeSync(
    [...reported.entries()].map(([clientId, v]) => ({ clientId, ...v })),
    measuredAt,
    { expectedMembers },
  )

  for (const [clientId, sessionId] of sessionByClient) {
    const dir = `${SESSIONS_DIR}/${sessionId}`
    try {
      const record = JSON.parse(await Deno.readTextFile(`${dir}/session.json`)) as Record<string, unknown>
      const raw = reported.get(clientId)
      if (raw) record['syncOffset'] = raw
      record['sync'] = records.get(clientId)
        ?? (clientId === body.clientId && failed ? exchangeFailed(measuredAt) : record['sync'] ?? exchangeFailed(measuredAt))
      await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
    } catch (err) {
      console.error(`[take-sync] could not update ${sessionId}:`, err)
    }
  }

  const mine = records.get(body.clientId) ?? exchangeFailed(measuredAt)
  return c.json({ takeId, memberCount: sessionByClient.size, reportedCount: reported.size, sync: mine })
})

// ── Upload session summary (.md) ──────────────────────────────────────────────

// ── GET /scan-locations — geo metadata for all scans ─────────────────────────
// Reads the companion .json files saved alongside each .glb
app.get('/scan-locations', async (c) => {
  try {
    const locations: Record<string, unknown>[] = []
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.glb')) continue
      if (isDerivedScanFile(entry.name)) continue // .opt/.lodN artifacts have no companion .json
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

// ── GET /project-locations — one map marker per saved project ───────────────
// A project keeps its confirmed geoPose. Older projects can inherit the newest
// geotagged scan assigned to them, so the desktop map remains useful while
// existing data migrates to project-level locations.
app.get('/project-locations', async (c) => {
  try {
    const [projects, scans] = await Promise.all([loadProjects(), listStoredScans()])
    return c.json(projects.map((project) => {
      const projectScans = scans.filter((scan) => (scanProjectId(scan.meta) ?? 'proj-default') === project.projectId)
      const newestLocatedScan = projectScans.find((scan) => hasGeoPose(geoPoseFromMeta(scan.meta)))
      const geo = hasGeoPose(project.geoPose)
        ? project.geoPose
        : newestLocatedScan ? geoPoseFromMeta(newestLocatedScan.meta) : null
      const capturedAt = projectScans
        .map((scan) => asString(scan.meta['capturedAt']) ?? asString(scan.meta['exportedAt']) ?? scan.uploadedAt)
        .sort()
        .at(-1) ?? null
      return {
        projectId: project.projectId,
        name: project.name,
        address: project.address ?? geo?.address ?? null,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        scanCount: projectScans.length,
        capturedAt,
      }
    }))
  } catch (err) {
    console.error('[project-locations error]', err)
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
  'thing-correspondence',
  'lingbot-map-reconstruct',
  'colmap-poses',
  'splat-train',
  'splat-align',
  'splat-detect',
  'splat-finish',
  'sensenova-vision',
  'panoptic-scan',
  'panoptic-lift',
  'person-4d-reconstruct',
  'memory-push',
  'export-world',
])

const DEFAULT_WORKER_CAPABILITIES = ['cpu', 'onnx', 'ollama', 'open3d', 'splat', 'vggt', 'lingbot-map', 'sensenova-vision', 'panoptic', '4d-capture']

interface StoredScanInfo {
  filename: string
  size: number
  uploadedAt: string
  meta: Record<string, unknown>
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

function asCalibrationMethod(value: unknown): ScanManifest['calibrationMethod'] {
  return value === 'ground-tap-compass' ? value : undefined
}

function asCalibrationStatus(value: unknown): ScanManifest['calibrationStatus'] {
  return value === 'verified' || value === 'provisional' || value === 'uncalibrated' ? value : undefined
}

function matrixFromMeta(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 16 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    return null
  }
  return [...value] as number[]
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

async function readScanMeta(
  filename: string,
  index: SessionIndex,
): Promise<Record<string, unknown>> {
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(await Deno.readTextFile(scanMetaPath(filename))) as Record<string, unknown>
  } catch {
    meta = {}
  }
  const session = await sessionForScan(index, SESSIONS_DIR, filename, meta)
  if (!session) return meta
  return {
    ...session,
    ...meta,
    keyframeCount: asNumber(meta['keyframeCount']) ?? asNumber(session['keyframeCount']) ?? 0,
    qualitySummary: meta['qualitySummary'] ?? session['qualitySummary'] ?? null,
  }
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

/** Bounded so a large scans directory cannot exhaust file descriptors. */
const SCAN_LIST_CONCURRENCY = 64

async function listStoredScans(): Promise<StoredScanInfo[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(SCANS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.glb')) continue
    if (isDerivedScanFile(entry.name)) continue // .opt/.lodN artifacts aren't standalone scans
    names.push(entry.name)
  }

  // Once per call, not once per scan: this is what makes the listing linear.
  const index = await loadSessionIndex(SESSIONS_DIR)

  const scans: StoredScanInfo[] = []
  for (let i = 0; i < names.length; i += SCAN_LIST_CONCURRENCY) {
    const batch = await Promise.all(
      names.slice(i, i + SCAN_LIST_CONCURRENCY).map(async (filename) => {
        // A scan deleted between readDir and stat is simply gone from the
        // listing — it is not a reason to fail the whole call, and callers
        // like `readWorldUnlocked` treat a throw here as a world-load error.
        let stat: Deno.FileInfo
        try {
          stat = await Deno.stat(`${SCANS_DIR}/${filename}`)
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) return null
          throw err
        }
        return {
          filename,
          size: stat.size,
          uploadedAt: (stat.mtime ?? new Date()).toISOString(),
          meta: await readScanMeta(filename, index),
        }
      }),
    )
    // Batches are appended in order, so `scans` keeps Deno.readDir order and the
    // stable sort below breaks uploadedAt ties exactly as it did before.
    scans.push(...batch.filter((scan): scan is StoredScanInfo => scan !== null))
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
  const scanId = scanIdFor(scan.filename)
  const qualitySummary = qualitySummaryFromMeta(scan.meta)
  const placement = placeScanTransform(origin, geoPose, index)
  const translation = placement.translation
  // Project calibration is an indoor transform derived from persistent AR
  // references. It takes precedence over metre-scale-inaccurate GPS/compass.
  const localToWorld = matrixFromMeta(scan.meta['projectTransform'])
    ?? composeYUpTransform(translation, geoPose.bearing, 1)

  return {
    scanId,
    projectId: scanProjectId(scan.meta),
    areaId: asString(scan.meta['areaId']),
    sessionId: asString(scan.meta['sessionId']),
    filename: scan.filename,
    name: scanNameFor(scan.filename, scan.meta),
    glbUrl: `/scans/${encodeURIComponent(scan.filename)}`,
    metadataUrl: `/scans/${encodeURIComponent(scan.filename.replace(/\.glb$/, '.json'))}`,
    geoPose,
    localToWorld,
    accuracyM: geoPose.accuracyM,
    geoDistanceM: placement.geoDistanceM,
    ...(placement.geoOutlier ? { geoOutlier: true } : {}),
    // Already written into the upload sidecar (src/export/gltf.ts); surfaced here so
    // the editor can tell whether this scan's local origin is a real marked physical
    // point worth rendering an anchor for, vs. just wherever AR tracking booted.
    calibrationMethod: asCalibrationMethod(scan.meta['calibrationMethod']),
    calibrationStatus: asCalibrationStatus(scan.meta['calibrationStatus']),
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

/**
 * Register (or reuse) a session-backed scan in `world` for a capture session
 * that has no uploaded .glb — the video-ingest path. The synthetic filename
 * `<sessionId>.glb` never lands on disk; `refreshWorldScans` preserves scans
 * whose filename isn't among the stored .glb files (see the `if (!storedScan)
 * return scan` guard), so this entry persists across world reloads. Downstream
 * job runners derive `base = filename.replace(/\.glb$/, '')` = the sessionId,
 * so all sidecars (.splat.ply, .interactions.json, …) key off the session.
 */
function registerSessionScan(
  world: WorldProject,
  sessionId: string,
  scanName: string | undefined,
  frameCount: number,
  // 'person-capture' is a scan whose subject is a person rather than a place.
  // It shares the session-backed scan shape — a capture is still a capture —
  // but carries no place geometry, so the editor can tell the two apart.
  source: 'video-ingest' | 'photo-ingest' | 'person-capture' = 'video-ingest',
  projectId: string | null = null,
  areaId: string | null = null,
): ScanManifest {
  const filename = `${sessionId}.glb`
  const existing = world.scans.find(s => s.filename === filename || s.sessionId === sessionId)
  if (existing) return existing

  const meta: Record<string, unknown> = {
    sessionId,
    source,
    keyframeCount: frameCount,
    projectId,
    areaId,
    ...(scanName ? { scanName } : {}),
  }
  const stored: StoredScanInfo = {
    filename,
    size: 0,
    uploadedAt: new Date().toISOString(),
    meta,
  }
  // `${sessionId}.glb` is a synthetic filename that never lands on disk (see
  // scan_id.ts) — refreshWorldScans() only reconciles against `stored.meta`
  // for scans it finds on disk, so nothing else ever persists this Place
  // assignment anywhere durable. Write it directly so any later reader of
  // scanMetaPath(filename) for this session (e.g. thing-correspondence) sees
  // the Place the user actually picked instead of defaulting to none. Best
  // effort: this metadata is supplementary, not required for the response.
  void Deno.writeTextFile(scanMetaPath(filename), JSON.stringify(meta, null, 2)).catch((err) => {
    console.error(`[worlds] failed to persist ingest metadata for ${filename}:`, err)
  })
  const manifest = scanManifestFromStored(stored, world.originGeoPose, world.scans.length, world.shareSlug)
  // A session-backed scan has no geometry yet: `<sessionId>.glb` is synthetic and only
  // becomes a real file if a reconstruction job later writes one. Saying `ready` here
  // claims something that has not happened — and when reconstruction is skipped (no
  // lingbot_map worker installed, the common local case) it never happens at all, so the
  // editor fetches the advertised glbUrl and shows the user a raw
  // `responded with 404: Not Found` per scan. Observed 2026-08-24 with three photo-ingest
  // sessions. `processing` is the honest state: ingested, awaiting geometry.
  manifest.status = 'processing'
  world.scans.push(manifest)
  return manifest
}

function createWorldMembers(): WorldMember[] {
  const now = new Date().toISOString()
  return (['owner', 'editor', 'commenter', 'viewer', 'scanner'] as const).map((role) => ({
    memberId: `${role}-${crypto.randomUUID()}`,
    role,
    token: `${role}-${crypto.randomUUID()}`,
    createdAt: now,
    expiresAt: null,
  }))
}

/**
 * Atomic single write of a world file. Atomic is not the same as isolated —
 * this must only be called from inside a `withWorldLock(slug, …)` critical
 * section (i.e. from `loadWorld`/`updateWorld`/`mutateWorldFiles`), or a
 * concurrent cycle holding an older snapshot can overwrite what it saves.
 * See `world_lock.ts`.
 */
async function writeWorldUnlocked(world: WorldProject): Promise<void> {
  world.updatedAt = new Date().toISOString()
  const tmp = `${worldPath(world.shareSlug)}.${crypto.randomUUID()}.tmp`
  await Deno.writeTextFile(tmp, JSON.stringify(world, null, 2))
  await Deno.rename(tmp, worldPath(world.shareSlug))
}

async function synthesizeWorld(slug: string, projectId: string | null = null): Promise<WorldProject> {
  const stored = await listStoredScans()
  const included = stored
    .filter(scan => shouldIncludeStoredScanInWorld(projectId, scan, shouldIncludeInWorld))
    .slice(0, 24)
  // The legacy default world can offer a few stored scans before any project
  // exists. A named project must never borrow scans from another project.
  const source = included.length > 0 || projectId !== null ? included : stored.slice(0, 8)
  const originGeoPose = inferWorldOrigin(source)
  const now = new Date().toISOString()
  const projectName = projectId === null
    ? null
    : (await loadProjects()).find(project => project.projectId === projectId)?.name ?? null
  const world: WorldProject = {
    worldId: `world-${safeSlug(slug)}`,
    name: projectName ?? (slug === 'default' ? 'Default World Scan' : slug.replace(/-/g, ' ')),
    shareSlug: safeSlug(slug),
    projectId,
    originGeoPose,
    localFrame: {
      type: 'ENU_Y_UP',
      origin: originGeoPose,
      units: 'meters',
      axes: { x: 'east', y: 'up', z: 'north' },
    },
    scans: source.map((scan, i) => scanManifestFromStored(scan, originGeoPose, i, slug)),
    things: [],
    thingObservations: [],
    members: createWorldMembers(),
    comments: [],
    jobs: [],
    editPatches: [],
    createdAt: now,
    updatedAt: now,
  }
  await writeWorldUnlocked(world)
  return world
}

/**
 * Apply a mutator to every stored world file; returns how many were updated.
 * Each file's read-modify-write runs inside that slug's lock, so it can't
 * clobber (or be clobbered by) a concurrent `updateWorld` on the same world.
 * The lock key comes from the filename — the same name the read below uses —
 * which is `world.shareSlug` for every world this server writes.
 */
async function mutateWorldFiles(mutator: (world: WorldProject) => boolean | Promise<boolean>): Promise<number> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(WORLDS_DIR)) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name)
    }
  } catch { /* worlds directory may be empty */ }

  let updated = 0
  for (const name of names) {
    try {
      const changed = await withWorldLock(safeSlug(name.replace(/\.json$/, '')), async () => {
        const world = JSON.parse(await Deno.readTextFile(`${WORLDS_DIR}/${name}`)) as WorldProject
        if (!await mutator(world)) return false
        await writeWorldUnlocked(world)
        return true
      })
      if (changed) updated += 1
    } catch (error) {
      console.warn(`[world] Could not mutate ${name}:`, error)
    }
  }
  return updated
}

async function removeScanFromWorlds(filename: string): Promise<number> {
  // Derived, not looked up from a single shared value: the scan row is about
  // to be filtered out, and this must also work for a world whose entry was
  // already pruned. `patch.scanId` used to be compared against `filename`
  // here — a scanId is never a filename, so that arm never matched and
  // scan-scoped patches outlived the scan they described.
  const removedScanId = scanIdFor(filename)
  return mutateWorldFiles((world) => {
    // mutateWorldFiles reads the world raw — no refreshWorldScans pass — so a
    // job/patch here can still name the LEGACY id if this scan's row was
    // renamed by a GET that ran before this delete (refreshWorldScans's own
    // self-heal) but this particular reference was part of a collision that
    // self-heal correctly left alone (see the count guard there). Matching
    // only `removedScanId` would leave such a reference behind — recompute
    // the legacy id from the row still in `world.scans`, before it's filtered
    // out below, and match either.
    const removedRow = world.scans.find(scan => scan.filename === filename)
    const removedLegacyScanId = removedRow ? legacyScanId(removedRow) : null
    const isRemovedScanId = (scanId: string | undefined): boolean =>
      scanId === removedScanId || (removedLegacyScanId !== null && scanId === removedLegacyScanId)

    const beforeScans = world.scans.length
    world.scans = world.scans.filter(scan => scan.filename !== filename)
    world.editPatches = world.editPatches.filter(
      patch => patch.targetId !== filename && !isRemovedScanId(patch.scanId),
    )
    world.comments = (world.comments ?? []).filter(comment => !isRemovedScanId(comment.scanId ?? undefined))
    world.jobs = world.jobs.filter(job => {
      if (!job.scanId) return true
      // Explicit, rather than relying on the survivor scan below: while ids
      // collided, a sibling sharing the removed scan's id kept its jobs alive.
      if (isRemovedScanId(job.scanId)) return false
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
    world.comments = []
    world.originGeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
    world.localFrame.origin = world.originGeoPose
    return hadScans
  })
}

/**
 * Read (or synthesize) a world. Unlocked, and it can itself write — via
 * `refreshWorldScans` — so callers must hold that slug's lock: use
 * `loadWorld` to read, `updateWorld` to read-modify-write.
 */
async function readWorldUnlocked(slug: string): Promise<WorldProject> {
  const safe = safeSlug(slug)
  try {
    const world = JSON.parse(await Deno.readTextFile(worldPath(safe))) as WorldProject
    ensureWorldProjectCollections(world)
    await refreshWorldScans(world)
    return world
  } catch (err) {
    // Only "there is no world file yet" may synthesize. A bare catch also
    // swallowed transient I/O errors from `refreshWorldScans` (which touches
    // disk on every read), and since `updateWorld` writes whatever this
    // returns back over the real file, one such error permanently replaced
    // every thing, observation and comment with synthesizeWorld's empty
    // collections. Anything else rethrows and surfaces as a 500.
    if (!(err instanceof Deno.errors.NotFound)) throw err
    return synthesizeWorld(safe)
  }
}

/** Read a world under its lock — a snapshot no in-flight cycle is mid-write on. */
function loadWorld(slug: string): Promise<WorldProject> {
  return withWorldLock(safeSlug(slug), () => readWorldUnlocked(slug))
}

function projectWorldSlug(projectId: string): string {
  return safeSlug(`project-${projectId}`)
}

/**
 * Each project receives an independent world manifest. This prevents the
 * desktop viewer from blending scans, patches, and jobs across places.
 */
function loadProjectWorld(projectId: string): Promise<WorldProject> {
  const slug = projectWorldSlug(projectId)
  return withWorldLock(slug, async () => {
    try {
      const world = JSON.parse(await Deno.readTextFile(worldPath(slug))) as WorldProject
      ensureWorldProjectCollections(world)
      if (world.projectId !== projectId) return await synthesizeWorld(slug, projectId)
      await refreshWorldScans(world)
      return world
    } catch (err) {
      // Same narrowing as `readWorldUnlocked`, for the same reason: only a
      // missing file may synthesize over a project's stored world.
      if (!(err instanceof Deno.errors.NotFound)) throw err
      return synthesizeWorld(slug, projectId)
    }
  })
}

/**
 * The one way to change a world on disk: load, mutate, save, all inside that
 * slug's lock, so two concurrent cycles serialize instead of one silently
 * overwriting the other (`world_lock.ts` explains what that cost us).
 *
 * The write is unconditional — a mutator can't forget to persist what it
 * changed, which is the failure mode this whole helper exists to remove. Do
 * only world-file work inside `mutate`: broadcasts, pump enqueues, and any
 * long-running worker call belong outside it, after the lock is released.
 * `mutate` must not call `loadWorld`/`updateWorld` for the same slug (the
 * lock is not reentrant); it gets the live `world` object already.
 *
 * Returns the saved world alongside whatever `mutate` returned, so a caller
 * that needs both (a created job plus `world.shareSlug`, say) gets them from
 * one cycle.
 */
async function updateWorld<T>(
  slug: string,
  mutate: (world: WorldProject) => T | Promise<T>,
): Promise<{ world: WorldProject; value: T }> {
  return await withWorldLock(safeSlug(slug), async () => {
    const world = await readWorldUnlocked(slug)
    const value = await mutate(world)
    await writeWorldUnlocked(world)
    return { world, value }
  })
}

/** Per-slug memo of the last logged stale-entry count, so the warn does not repeat. */
const lastPruneSkipLogged = new Map<string, number>()

async function refreshWorldScans(world: WorldProject): Promise<void> {
  ensureWorldProjectCollections(world)
  const stored = await listStoredScans()
  const storedByFilename = new Map(stored.map(scan => [scan.filename, scan]))
  const existingScanFilenames = new Set(world.scans.map(scan => scan.filename))
  let changed = false

  // Reconcile against disk: a scan whose .glb has gone (deleted out of band, or a
  // storage reset that never reached this manifest) must not survive here — the
  // editor would keep fetching it and render a 404 row per stale entry, and the
  // manifest would grow without bound. Deletions through DELETE /scans do prune
  // via removeScanFromWorlds(); this is the self-heal for everything else.
  //
  // Guarded by pruneScansMissingFromDisk(): the manifest is the durable record
  // and scans/ is the volatile side, so a listing thinner than the manifest is
  // read as a stale directory rather than as 250-odd deletions. world_prune.ts
  // documents the incident this guard exists for.
  const prune = pruneScansMissingFromDisk(
    world.scans,
    new Set(storedByFilename.keys()),
    stored.filter(shouldIncludeInWorld).length,
  )
  if (prune.pruned > 0) {
    world.scans = prune.scans
    changed = true
    console.log(`[worlds] pruned ${prune.pruned} scan entr${prune.pruned === 1 ? 'y' : 'ies'} with no .glb on disk`)
  } else if (prune.skipped && prune.missing > 0 && lastPruneSkipLogged.get(world.worldId) !== prune.missing) {
    // Not an error — the manifest is intact and the editor shows these as stale
    // rows. Logged because it is also how a lost scans/ dir announces itself,
    // but only when the count changes: refreshWorldScans() runs on every
    // GET /worlds/:slug and the editor polls, so an unconditional warn floods
    // the log with the same line and buries real errors.
    lastPruneSkipLogged.set(world.worldId, prune.missing)
    console.warn(
      `[worlds] kept ${prune.missing} scan entr${prune.missing === 1 ? 'y' : 'ies'} with no .glb on disk `
      + `(${prune.skipped}) — refusing to prune against a listing of ${stored.length}`,
    )
  }

  // Ids currently on disk, counted before any renames below touch them — the
  // only way to tell an unambiguous rename from one still tangled in a
  // not-yet-migrated collision. A count of 1 means no sibling scan shares
  // this id, so any job/patch naming it can only have meant this scan; a
  // count > 1 is exactly the collision `deno task migrate-scan-ids` exists to
  // resolve; a guess made here, live, on every GET, could differ request to
  // request and is not this function's call to make.
  const scansByCurrentId = new Map<string, number>()
  for (const scan of world.scans) {
    scansByCurrentId.set(scan.scanId, (scansByCurrentId.get(scan.scanId) ?? 0) + 1)
  }

  // Filled by the map below with every scan evicted this pass for no longer
  // belonging to this world's Place, so their patches/jobs/comments can be
  // pruned alongside them — otherwise those references outlive the scan row
  // they describe, exactly like removeScanFromWorlds() prunes for an explicit
  // delete, just triggered by a Place reassignment instead.
  const removedForProjectMismatch: Array<{ scanId: string; filename: string }> = []

  world.scans = world.scans.map((scan, index) => {
    const storedScan = storedByFilename.get(scan.filename)
    if (!storedScan) return scan
    if (!belongsToCurrentWorld(world, storedScan, existingScanFilenames)) {
      changed = true
      removedForProjectMismatch.push({ scanId: scan.scanId, filename: scan.filename })
      return null
    }
    const next = scanManifestFromStored(storedScan, world.originGeoPose, index, world.shareSlug)
    if (next.scanId !== scan.scanId && scansByCurrentId.get(scan.scanId) === 1) {
      // Repoint references live, the same self-heal this function already
      // does for the scan row itself (below) — otherwise the id moves out
      // from under a still-pending job's exact-match lookup the moment this
      // GET persists it, well before an operator gets a chance to run the
      // offline migration. Safe here specifically because the id is unique:
      // see the collision-count guard above.
      for (const patch of world.editPatches) {
        if (patch.scanId === scan.scanId) patch.scanId = next.scanId
      }
      for (const job of world.jobs) {
        if (job.scanId === scan.scanId) job.scanId = next.scanId
      }
    }
    changed = changed
      || scan.scanId !== next.scanId
      || scan.projectId !== next.projectId
      || scan.status !== next.status
      || scan.geoDistanceM !== next.geoDistanceM
      || !!scan.geoOutlier !== !!next.geoOutlier
      || scan.frameSetUrl !== next.frameSetUrl
      || JSON.stringify(scan.qualitySummary ?? null) !== JSON.stringify(next.qualitySummary ?? null)
      || JSON.stringify(scan.layerIndex) !== JSON.stringify(next.layerIndex)
    return { ...scan, ...next, localToWorld: scan.localToWorld, name: scan.name || next.name }
  }).filter((scan): scan is ScanManifest => scan !== null)

  if (removedForProjectMismatch.length > 0) {
    const removedScanIds = new Set(removedForProjectMismatch.map(entry => entry.scanId))
    const removedFilenames = new Set(removedForProjectMismatch.map(entry => entry.filename))
    world.editPatches = world.editPatches.filter(patch =>
      !(patch.scanId && removedScanIds.has(patch.scanId)) && !removedFilenames.has(patch.targetId))
    world.comments = (world.comments ?? []).filter(comment =>
      !(comment.scanId && removedScanIds.has(comment.scanId)))
    world.jobs = world.jobs.filter(job => !(job.scanId && removedScanIds.has(job.scanId)))
  }

  const existing = new Set(world.scans.map(scan => scan.filename))
  const additions = stored
    .filter(scan => shouldIncludeStoredScanInWorld(world.projectId, scan, shouldIncludeInWorld, existingScanFilenames))
    .filter(scan => !existing.has(scan.filename))
    .slice(0, 12)

  if (additions.length > 0) {
    const origin = world.originGeoPose
    const nextIndex = world.scans.length
    world.scans.push(...additions.map((scan, i) => scanManifestFromStored(scan, origin, nextIndex + i, world.shareSlug)))
  }

  warnOnScanIdCollision(world)

  if (changed || additions.length > 0) await writeWorldUnlocked(world)
}

function belongsToCurrentWorld(
  world: WorldProject,
  scan: StoredScanInfo,
  existingScanFilenames: Set<string>,
): boolean {
  return shouldIncludeStoredScanInWorld(world.projectId ?? null, scan, shouldIncludeInWorld, existingScanFilenames)
}


/** Per-slug memo of the last logged colliding-id set, so the warn does not repeat every GET. */
const lastScanIdCollisionLogged = new Map<string, string>()

/**
 * `scanIdFor()` is lossy — `safeSlug()` collapses every character outside
 * `[a-z0-9_-]`, so two distinct filenames can in principle derive the same
 * id (`a.b.glb` and `a-b.glb` both become `scan-a-b`). `migrate_scan_ids.ts`
 * refuses to run over a world with this collision; it throws, which is the
 * right call for a one-shot, human-attended script. It is NOT the right call
 * here: `refreshWorldScans` runs inside `readWorldUnlocked`, so throwing
 * would turn a lossy id into a 500 on every read of that world — the failure
 * mode would be worse, not better.
 *
 * So this only warns, throttled per-slug so it doesn't repeat on every GET.
 * It does not attempt to resolve the collision (there is no safe automatic
 * choice — see the migration's own reasoning), only to make it visible
 * rather than let the viewer silently discard one of the colliding scans the
 * way it did before ticket 0001. An operator sees the log and renames the
 * offending file, the same fix the migration's own error message asks for.
 */
function warnOnScanIdCollision(world: WorldProject): void {
  const byId = new Map<string, string[]>()
  for (const scan of world.scans) {
    const bucket = byId.get(scan.scanId)
    if (bucket) bucket.push(scan.filename)
    else byId.set(scan.scanId, [scan.filename])
  }
  const collisions = [...byId.entries()].filter(([, filenames]) => filenames.length > 1)
  if (collisions.length === 0) {
    lastScanIdCollisionLogged.delete(world.worldId)
    return
  }
  const detail = collisions.map(([id, filenames]) => `${id} <- ${filenames.join(', ')}`).join('; ')
  if (lastScanIdCollisionLogged.get(world.worldId) === detail) return
  lastScanIdCollisionLogged.set(world.worldId, detail)
  console.warn(
    `[worlds] '${world.shareSlug}': ${collisions.length} scanId(s) are shared by more than one scan — ` +
    `safeSlug() is lossy, so distinct filenames can derive the same id. The viewer will only show one ` +
    `of each colliding set. Rename the offending file(s) to resolve: ${detail}`,
  )
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

/**
 * The base URL the 4d-capture subsystem fetches clips from.
 *
 * It runs on another machine, so a relative path is useless to it and
 * `localhost` is actively wrong. This is the API origin — port 8000, not Vite's
 * 5173 — reachable over the tailnet. `FDANYONE_CALLBACK_BASE` overrides it for
 * deployments where the subsystem reaches this server by a different name than
 * the browser does.
 */
function person4dCallbackBase(): string {
  const override = Deno.env.get('FDANYONE_CALLBACK_BASE')
  if (override) return override.replace(/\/+$/, '')
  return TAILSCALE_HOSTNAME ? `https://${TAILSCALE_HOSTNAME}:${PORT}` : `http://localhost:${PORT}`
}

function viteBaseUrlFromEnv(): string {
  try {
    const url = new URL(ALLOWED_ORIGIN_PREFIX)
    if (!url.port) url.port = VITE_PORT
    return url.toString().replace(/\/$/, '')
  } catch {
    return TAILSCALE_HOSTNAME
      ? `https://${TAILSCALE_HOSTNAME}:${VITE_PORT}`
      : `https://liambook.capybara-ulmer.ts.net:${VITE_PORT}`
  }
}

function shareLinks(c: { req: { url: string; header: (name: string) => string | undefined } }, world: WorldProject): Record<string, string> {
  const base = clientBaseUrl(c)
  const byRole = new Map(world.members.filter(m => !m.revokedAt).map(m => [m.role, m.token]))
  return {
    owner: `${base}/editor?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('owner') ?? '')}`,
    editor: `${base}/editor?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('editor') ?? '')}`,
    commenter: `${base}/editor?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('commenter') ?? '')}`,
    viewer: `${base}/editor?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('viewer') ?? '')}`,
    scanner: `${base}/scanner.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('scanner') ?? '')}`,
  }
}

const ROLE_RANK: Record<MemberRole, number> = {
  scanner: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
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

/**
 * Creates (or reuses) a WorldJob and appends it to `world.jobs`. Per ADR 0003
 * "Dedupe" and "Bounded history": every call site routes through this single
 * function, so both guarantees apply uniformly — no call site pushes onto
 * `world.jobs` directly anymore.
 *
 * Also fires the legacy `'job-update'` broadcast (via
 * `broadcastLegacyJobUpdate`, which no-ops for every type but
 * `optimize-scan`) immediately on creation, mirroring `JobQueue.enqueue()`
 * (`jobs.ts:88-111`), which calls `this._emit(job)` right after construction
 * — before the job ever runs — so a client polling/listening the way it did
 * against `JobQueue` still observes a `status: 'queued'` event, not just the
 * later `processing`/`completed` ones from `_dispatchWorldJob`. Only fires
 * for a genuinely new job: the dedupe early-return above skips it, exactly
 * like `jobs.ts:88-93`'s own `if (existing) return existing` never re-emits
 * for a reused job.
 */
function createWorldJob(world: WorldProject, type: WorldJobType, scanId?: string, payload?: Record<string, unknown>): WorldJob {
  // Dedupe (ADR 0003 "Dedupe"): reuse an existing queued/processing job for
  // the same type+target in this world instead of creating a duplicate —
  // jobs.ts:88-93's exact predicate, applied per-world.
  const existing = findDuplicateWorldJob(world.jobs, type, worldJobTarget({ scanId, payload }))
  if (existing) return existing

  const now = new Date().toISOString()
  const job: WorldJob = {
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
  world.jobs.unshift(job)
  // Bounded history (ADR 0003 "Bounded history"): cap at 200, trimming
  // completed/failed jobs to the most recent 100 once exceeded.
  world.jobs = trimWorldJobHistory(world.jobs)
  broadcastLegacyJobUpdate(job)
  return job
}

// ── Legacy /jobs, /jobs/:id, GET /scans job-status shim ──────────────────────
// (ADR 0003 / ticket docs/factory/01-merge-jobs/0004)
//
// `GET /jobs`, `GET /jobs/:id`, and GET /scans's per-file job-status field
// used to read `JobQueue` directly. Real optimize-scan work now happens as a
// `WorldJob` (ticket 0003), so those three surfaces — plus the 'job-update'
// event below — are re-pointed to read/derive from `WorldJob` data instead,
// translated through this one function (ADR 0001: one conversion, reused)
// so nothing external (the viewer, a script, a future integration) has to
// change to keep working.

const WORLD_JOB_STATUS_TO_LEGACY: Record<WorldJobStatus, JobStatus> = {
  queued: 'queued',
  processing: 'running',
  completed: 'done',
  failed: 'error',
}

/**
 * Translates an `optimize-scan` `WorldJob` into the legacy `Job` shape
 * (jobs.ts), per ADR 0003's field-mapping table: `id`←`jobId`,
 * `type`←`'optimize-scan'`, `target`←`payload.filename` (via the shared
 * `worldJobTarget` helper, mirroring `Job.target`), `status`← mapped through
 * the table above, `createdAt`←`createdAt`, `error`←`error`, `note`←`result`.
 * `startedAt`/`finishedAt` have no dedicated `WorldJob` field (no second
 * timestamp was added — the ADR reuses `updatedAt` for both); populated only
 * once the job has actually reached that transition, matching `Job`'s
 * optional fields staying unset while still `queued`.
 */
function worldJobToLegacyJob(wj: WorldJob): Job {
  const job: Job = {
    id: wj.jobId,
    type: 'optimize-scan',
    target: worldJobTarget(wj) ?? '',
    status: WORLD_JOB_STATUS_TO_LEGACY[wj.status],
    createdAt: wj.createdAt,
  }
  if (wj.status !== 'queued') job.startedAt = wj.updatedAt
  if (wj.status === 'completed' || wj.status === 'failed') job.finishedAt = wj.updatedAt
  if (wj.error !== undefined) job.error = wj.error
  if (wj.result !== undefined) job.note = wj.result
  return job
}

/**
 * Fires the legacy `'job-update'` event (`EVENT.JOB_UPDATE`) for
 * `optimize-scan` `WorldJob` transitions, alongside the `'world-job-update'`
 * broadcast every caller already sends — matching `JobQueue`'s old
 * `_emit()` payload shape exactly (`jobs.ts:212-224`:
 * `{ id, jobType, target, status, error, note }`, `error`/`note` `null`
 * rather than absent). Scoped to `optimize-scan` only, matching its old
 * scope (ticket 0004 Pinned conventions) — a no-op for every other
 * `WorldJobType`, so it's safe to call from the shared dispatch path.
 */
function broadcastLegacyJobUpdate(wj: WorldJob): void {
  if (wj.type !== 'optimize-scan') return
  const legacy = worldJobToLegacyJob(wj)
  broadcast({
    type: EVENT.JOB_UPDATE,
    job: {
      id: legacy.id,
      jobType: legacy.type,
      target: legacy.target,
      status: legacy.status,
      error: legacy.error ?? null,
      note: legacy.note ?? null,
    },
  })
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
  const { world, value: job } = await updateWorld('default', (world) => {
    const scan = world.scans.find(s => s.filename === filename)
    return createWorldJob(world, type, scan?.scanId, { legacyAction: action, filename })
  })
  await completeJobSoon(world.shareSlug, job.jobId)
  return job.jobId
}

/**
 * Creates (or reuses) an `optimize-scan` `WorldJob` and kicks the pump — the
 * shared implementation for all three call sites that used to do
 * `jobQueue.enqueue('optimize-scan', filename)` (`POST /upload-scan`,
 * `POST /scans/:filename/optimize`, `POST /sessions/:id/finalize`).
 *
 * Per ADR 0003 "Which world does an optimize-scan WorldJob belong to?": these
 * routes operate on raw `SCANS_DIR` filenames with no `WorldProject`
 * association, so the job is parked under the `'default'` world — exactly
 * `enqueueLegacyProcessJob`'s existing pattern (`loadWorld('default')`,
 * `scanId` left `undefined`, target carried in `payload.filename`) — reused
 * here rather than inventing a second "raw scan job" shape (ADR 0001).
 */
async function enqueueOptimizeScanJob(filename: string): Promise<WorldJob> {
  const { world, value: job } = await updateWorld(
    'default',
    (world) => createWorldJob(world, 'optimize-scan', undefined, { filename }),
  )
  await completeJobSoon(world.shareSlug, job.jobId)
  return job
}

/**
 * Enqueues a WorldJob for execution and kicks the single-flight pump — does
 * not itself wait for the job to run (matches the previous behaviour: the
 * old `setTimeout(..., 25)` body also returned long before its callback
 * fired). ADR 0003 "Single-flight execution": actual dispatch happens in
 * `_dispatchWorldJob`, called one-at-a-time by `worldJobPump`.
 */
async function completeJobSoon(slug: string, jobId: string): Promise<void> {
  worldJobPump.enqueue(slug, jobId)
}

/**
 * Pump dispatch callback — runs exactly one WorldJob to a terminal state.
 * This is `completeJobSoon`'s old inline body, unchanged in what it does
 * (set `processing` + `workerId` + progress, broadcast, dispatch to the
 * per-type `_run*Job` function, or the generic placeholder-completion path)
 * — only how it's invoked changed: `worldJobPump` now awaits this call to
 * fully settle before dequeuing the next pending job (ADR 0003
 * "Single-flight execution"), instead of each call scheduling its own
 * independent, concurrent `setTimeout`.
 */
async function _dispatchWorldJob(slug: string, jobId: string): Promise<void> {
  try {
    const { world, value: job } = await updateWorld(slug, (world) => {
      const job = world.jobs.find(j => j.jobId === jobId)
      if (!job || job.status !== 'queued') return null
      job.status = 'processing'
      job.workerId = job.type === 'lingbot-map-reconstruct'
        ? 'lingbot-map'
        : job.type === 'splat-train'
          ? 'brush'
          : job.type === 'splat-detect'
            ? 'splat-analyzer'
            : job.type === 'splat-finish'
              ? 'splat-transform'
              : job.type === 'person-4d-reconstruct'
                ? '4d-capture'
                : job.type === 'sensenova-vision'
                ? 'sensenova-vision'
              : job.type === 'memory-push'
                ? 'companion-memory'
                : 'local-coordinator'
      job.progress = 0.35
      job.updatedAt = new Date().toISOString()
      return job
    })
    if (!job) return
    broadcast({ type: EVENT.WORLD_JOB_UPDATE, worldId: world.worldId, job })
    broadcastLegacyJobUpdate(job)

    if (job.type === 'lingbot-map-reconstruct') {
      await _runLingBotMapJob(slug, jobId)
      return
    }

    if (job.type === 'colmap-poses') {
      await _runColmapPosesJob(slug, jobId)
      return
    }

    if (job.type === 'splat-train') {
      await _runSplatTrainJob(slug, jobId)
      return
    }

    if (job.type === 'splat-align') {
      await _runSplatAlignJob(slug, jobId)
      return
    }

    if (job.type === 'splat-detect') {
      await _runSplatDetectJob(slug, jobId)
      return
    }

    if (job.type === 'splat-finish') {
      await _runSplatFinishJob(slug, jobId)
      return
    }

    if (job.type === 'sensenova-vision') {
      await _runSenseNovaVisionJob(slug, jobId)
      return
    }

    if (job.type === 'panoptic-scan') {
      await _runPanopticScanJob(slug, jobId)
      return
    }

    if (job.type === 'panoptic-lift') {
      await _runPanopticLiftJob(slug, jobId)
      return
    }

    if (job.type === 'person-4d-reconstruct') {
      await _runPerson4DJob(slug, jobId)
      return
    }

    if (job.type === 'memory-push') {
      await _runMemoryPushJob(slug, jobId)
      return
    }

    if (job.type === 'thing-correspondence') {
      await _runThingCorrespondenceJob(slug, jobId)
      return
    }

    if (job.type === 'optimize-scan') {
      await _runOptimizeScanJob(slug, jobId)
      return
    }

    // Generic placeholder-type completion path (the seven WorldJobTypes with
    // no dedicated runner — ADR 0003 "Placeholder WorldJobTypes"). Was its
    // own detached `setTimeout(..., 650)`; now `await sleep(650)` so the pump
    // waits for it to settle before dequeuing the next entry, per ADR 0003
    // "Single-flight execution".
    await sleep(650)
    try {
      const placeholderPreflight = await keyframePreflight(slug, jobId)
      const { world: current, value: currentJob } = await updateWorld(slug, (current) => {
        const currentJob = current.jobs.find(j => j.jobId === jobId)
        if (!currentJob || currentJob.status === 'failed') return null
        const failure = jobFailureReason(currentJob, current, placeholderPreflight)
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
        return currentJob
      })
      if (!currentJob) return
      broadcast({ type: EVENT.WORLD_JOB_UPDATE, worldId: current.worldId, job: currentJob })
    } catch (err) {
      console.error('[world-job complete error]', err)
    }
  } catch (err) {
    console.error('[world-job start error]', err)
  }
}

/**
 * Boot-time crash recovery (ADR 0003 "Crash recovery"). Requeues every
 * WorldJob left `'processing'` or `'queued'` by a previous process — both
 * are unreachable otherwise: a `'processing'` job's process died mid-run,
 * and a `'queued'` job has no poller once it's off the in-memory pending
 * queue that died with the old process (nothing scans for queued WorldJobs
 * the way jobs.ts's `_pump()` does). Reuses `mutateWorldFiles()` (the same
 * "iterate every world file, apply logic, save only if changed" helper
 * `removeScanFromWorlds` already uses) instead of a second `WORLDS_DIR`
 * directory-scan implementation — ADR 0001, and this ticket's own Open
 * Questions answer. Called once, at boot, right before `Deno.serve(...)`
 * (see the call site's comment for why not earlier — TDZ on later
 * module-level consts the seeded pump dispatch can reach).
 */
async function recoverWorldJobsOnBoot(): Promise<void> {
  // Broadcasting/enqueueing happens after the mutateWorldFiles() pass below
  // (not inside the mutator) so every recovered job is persisted via
  // mutateWorldFiles' locked write before anything is broadcast or handed to the pump —
  // mirrors the save-before-broadcast ordering every other job transition
  // in this file follows (e.g. _runLingBotMapJob).
  const recoveredByWorld: Array<{ worldId: string; shareSlug: string; jobs: WorldJob[] }> = []
  await mutateWorldFiles((world) => {
    const recovered = recoverStuckWorldJobs(world.jobs)
    if (recovered.length === 0) return false
    recoveredByWorld.push({ worldId: world.worldId, shareSlug: world.shareSlug, jobs: recovered })
    return true
  })
  for (const { worldId, shareSlug, jobs } of recoveredByWorld) {
    for (const job of jobs) {
      broadcast({ type: EVENT.WORLD_JOB_UPDATE, worldId, job })
      // Requeue is a real status transition, so it fires the legacy
      // 'job-update' event too (no-op for every type but optimize-scan) —
      // same pairing every other optimize-scan transition uses, per ticket
      // 0004. Nothing is listening this early at boot, but keeping the two
      // events paired means the rule holds wherever recovery is called from.
      broadcastLegacyJobUpdate(job)
      // Recovery doesn't get its own execution path — it just seeds the
      // normal pump (ADR 0003 "Crash recovery", step 4).
      worldJobPump.enqueue(shareSlug, job.jobId)
    }
    console.log(`[world-jobs] recovered ${jobs.length} stuck job(s) in world '${shareSlug}'`)
  }
}

async function _runThingCorrespondenceJob(slug: string, jobId: string): Promise<void> {
  try {
    const world = await loadWorld(slug)
    const detections = await detectionLikesForWorld(world)
    const result = runThingCorrespondence(world, detections)

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      current.things = result.things
      current.thingObservations = result.observations
      currentJob.progress = 1
      currentJob.status = 'completed'
      currentJob.result = jobResultFor(currentJob)
      currentJob.artifacts = [
        {
          type: 'thing-correspondence-summary',
          label: 'Thing correspondence summary',
          metadata: {
            things: result.things.length,
            observations: result.observations.length,
          },
        },
        ...result.artifacts,
      ]
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[thing-correspondence] job failed:', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

interface StoredDetectionMeta {
  label: string
  confidence: number | null
  worldPos: Vec3
}

/** Parses the `detections` array gltf.ts writes alongside the plain `labels` list. */
function detectionsFromMeta(value: unknown): StoredDetectionMeta[] {
  if (!Array.isArray(value)) return []
  const result: StoredDetectionMeta[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = typeof record['label'] === 'string' ? record['label'] : null
    const pos = record['worldPos']
    if (!label || !pos || typeof pos !== 'object') continue
    const posRecord = pos as Record<string, unknown>
    const x = posRecord['x']
    const y = posRecord['y']
    const z = posRecord['z']
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue
    result.push({
      label,
      confidence: typeof record['confidence'] === 'number' ? record['confidence'] : null,
      worldPos: { x, y, z },
    })
  }
  return result
}

/**
 * Deterministic small hash so a scan without real detection positions (an
 * export from before gltf.ts started recording them) still gets a fallback
 * grid that never overlaps another scan's fallback grid — see
 * detectionLikesForWorld below.
 */
function fnv1aMod(value: string, mod: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash % mod
}

async function detectionLikesForWorld(world: WorldProject): Promise<DetectionLike[]> {
  const detections: DetectionLike[] = []
  for (const scan of world.scans) {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(await Deno.readTextFile(scanMetaPath(scan.filename))) as Record<string, unknown>
    } catch { /* no metadata sidecar */ }

    const withPositions = detectionsFromMeta(meta['detections'])
    if (withPositions.length > 0) {
      withPositions.forEach((detection, index) => {
        const safeName = detection.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'
        const name = `${safeName}_${String(index + 1).padStart(3, '0')}`
        detections.push({
          scanId: scan.scanId,
          sessionId: scan.sessionId,
          targetId: `${scan.scanId}:${name}:lod`,
          label: detection.label,
          confidence: detection.confidence,
          worldPos: detection.worldPos,
          observedAt: scan.capturedAt,
        })
      })
      continue
    }

    // Older scans exported before gltf.ts recorded real positions: labels
    // survive, positions do not. A fabricated position keyed only on
    // within-scan index would put the Nth label of every scan at the same
    // point, so two different scans (different rooms) that both list "chair"
    // first would spuriously merge into one Thing at runThingCorrespondence's
    // 0.75 m match radius. Offset each scan's fallback grid by a hash of its
    // own scanId — far past that radius — so distinct scans can never collide.
    const labels = asStringArray(meta['labels'])
    const scanOffset = fnv1aMod(scan.scanId, 97) * 20
    labels.forEach((label, index) => {
      const safeName = label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'
      const name = `${safeName}_${String(index + 1).padStart(3, '0')}`
      detections.push({
        scanId: scan.scanId,
        sessionId: scan.sessionId,
        targetId: `${scan.scanId}:${name}:lod`,
        label,
        confidence: null,
        worldPos: {
          x: (index % 12) + scanOffset,
          y: 0,
          z: Math.floor(index / 12),
        },
        observedAt: scan.capturedAt,
      })
    })
  }
  return detections
}

/**
 * `colmap-poses` runner — solves camera poses for a session with COLMAP.
 *
 * This is the CPU counterpart to `_runLingBotMapJob`. Both write the same two
 * artifacts (a poses.json and a sparse seed cloud) into the session dir, which
 * is what lets `buildBrushDataset` consume either through one path
 * (ADR 0001). A missing COLMAP binary is reported as a *skip* with a
 * remediation, never a failure, matching every other optional-tool stage here.
 */
/**
 * `splat-align` runner — fits the similarity transform that carries a trained splat out of
 * structure-from-motion's arbitrary units and into the Place's metric frame.
 *
 * The driver deliberately does not read the world file (it takes `calibration` as an argument),
 * so this runner is the piece that knows where calibration lives: on the scan entry. That
 * separation is why the driver stayed unit-testable without a world fixture.
 *
 * A scan with no calibration is a *skip*, not a failure — with no calibrated metres to fit
 * against, the only "scale" available would be the AR runtime's unverified units, and claiming
 * a metric result from those is precisely the unbacked claim ADR 0005 rule 3 forbids.
 */
async function _runSplatAlignJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionId, sessionPath } = start

    const base = scan.filename.replace(/\.glb$/, '')

    // Calibration reaches the server through the scan's meta sidecar, not through
    // ScanManifest: `ScanCalibration` lives on the client-side `ScanEntry` (the project
    // store) and is written into `<base>.json` by the GLB exporter alongside the scan.
    // ScanManifest only surfaces the flattened `calibrationMethod`/`calibrationStatus`
    // summary fields, which are not enough to fit against — the fit needs the full
    // `sessionToProject` matrix. Reading the sidecar directly is therefore the honest
    // path, and an absent/unparseable sidecar simply yields no calibration, which
    // runSplatAlign already treats as a skip.
    let calibration: ScanCalibration | null = null
    try {
      const raw = JSON.parse(await Deno.readTextFile(scanMetaPath(scan.filename))) as Record<string, unknown>
      const candidate = raw['calibration']
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        calibration = candidate as ScanCalibration
      }
    } catch {
      // No sidecar, or malformed JSON — indistinguishable from "not calibrated" here,
      // and both lead to the same skip with the same remediation.
    }

    const result = await runSplatAlign({
      sessionDir: sessionPath,
      calibration,
      plyPath: `${SCANS_DIR}/${base}.splat.ply`,
      provenance: { sessionId, scanId: scan.scanId },
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        const scaleText = result.scale ? `1 SfM unit = ${result.scale.toFixed(4)} m` : 'scale unavailable'
        currentJob.result =
          `Splat aligned to the Place metric frame — ${scaleText}, ` +
          `residual ${((result.residualM ?? 0) * 100).toFixed(1)} cm over ${result.correspondenceCount ?? 0} cameras.`
        currentJob.artifacts = [{
          type: 'splat-align',
          label: `${scan.name} metric alignment`,
          url: `/scans/${encodeURIComponent(`${base}.splat-align.manifest.json`)}`,
          metadata: {
            scale: result.scale ?? null,
            residualM: result.residualM ?? null,
            correspondenceCount: result.correspondenceCount ?? null,
            calibrationMethod: result.manifest.calibrationMethod ?? null,
          },
        }]
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `Splat alignment skipped: ${result.manifest.skippedReason ?? 'unknown reason'}`
        currentJob.artifacts = [{
          type: 'splat-align-skip',
          label: 'Splat alignment skipped',
          url: `/scans/${encodeURIComponent(`${base}.splat-align.manifest.json`)}`,
          metadata: { skippedReason: result.manifest.skippedReason ?? null, remediation: result.manifest.remediation ?? null },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.manifest.error ?? 'splat alignment failed'
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[splat-align job error]', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

async function _runColmapPosesJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionId, sessionPath } = start

    const result = await runColmapPoses({ sessionDir: sessionPath })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result =
          `COLMAP registered ${result.registeredImages ?? 0} image(s), ` +
          `${result.pointCount ?? 0} point(s)`
        currentJob.artifacts = [{
          type: 'colmap-poses',
          label: `${scan.name} camera poses`,
          url: `/sessions/${encodeURIComponent(sessionId)}/colmap.poses.json`,
          metadata: {
            sessionId,
            registeredImages: result.registeredImages ?? null,
            pointCount: result.pointCount ?? null,
          },
        }]
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `COLMAP skipped: ${result.manifest.skippedReason ?? 'unknown reason'}`
        currentJob.artifacts = [{
          type: 'colmap-poses-skip',
          label: 'COLMAP run skipped',
          url: `/sessions/${encodeURIComponent(sessionId)}/colmap-poses.manifest.json`,
          metadata: { sessionId, skippedReason: result.manifest.skippedReason ?? null },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.manifest.error ?? `colmap exit ${result.exitCode}`
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[colmap-poses job error]', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

async function _runLingBotMapJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionId, sessionPath } = start

    const base = scan.filename.replace(/\.glb$/, '')
    const glbSidecarPath = `${SCANS_DIR}/${base}.lingbot.glb`
    const result = await runLingBotMapReconstruction({
      sessionDir: sessionPath,
      scriptPath: LINGBOT_MAP_SCRIPT,
      glbSidecarPath,
      glbExtras: { sessionId, scanId: scan.scanId },
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result = jobResultFor(currentJob)
        currentJob.artifacts = jobArtifactsFor(currentJob, current)
        if (result.glbSidecarPath) {
          const glbName = result.glbSidecarPath.split('/').pop()!
          currentJob.artifacts ??= []
          currentJob.artifacts.push({
            type: 'lingbot-map-glb',
            label: `${scan.name} LingBot-Map GLB`,
            url: `/scans/${encodeURIComponent(glbName)}`,
            metadata: { points: result.glbPointCount ?? null },
          })
          const targetScan = current.scans.find(s => s.scanId === scan.scanId)
          if (targetScan && !targetScan.layerIndex.some(l => l.id === 'lingbot-map')) {
            targetScan.layerIndex.push({
              id: 'lingbot-map',
              type: 'points',
              label: 'LingBot-Map reconstruction',
              visibleByDefault: false,
              encodedInGlb: true,
              source: 'derived',
              count: result.glbPointCount ?? null,
            })
          }
        }
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `LingBot-Map skipped: ${result.skippedReason ?? 'unknown reason'}`
        currentJob.artifacts = [{
          type: 'lingbot-map-skip',
          label: 'LingBot-Map run skipped',
          url: `/sessions/${encodeURIComponent(sessionId)}/lingbot-map.manifest.json`,
          metadata: { sessionId, skippedReason: result.skippedReason ?? null },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.error ?? `worker exit ${result.exitCode}`
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[lingbot-map job error]', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

async function _runSenseNovaVisionJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionPath, payload } = start
    const task = senseNovaTask(payload?.['task'])
    const query = asString(payload?.['query']) ?? undefined
    const outputDir = `${SCANS_DIR}/.sensenova/${safeSlug(jobId)}`
    const result = await runSenseNovaVision({ sessionDir: sessionPath, outputDir, task, query })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result = `SenseNova ${task} completed with ${result.files.length} artifact${result.files.length === 1 ? '' : 's'}.`
        currentJob.artifacts = [{
          type: 'sensenova-output',
          label: `${scan.name} SenseNova ${task}`,
          metadata: { task, files: result.files, outputDir: result.outputDir },
        }]
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `SenseNova ${task} skipped: ${result.remediation ?? 'runtime unavailable'}`
        currentJob.artifacts = [{
          type: 'sensenova-skip',
          label: 'SenseNova runtime setup required',
          metadata: { task, remediation: result.remediation ?? null },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.error ?? 'SenseNova worker failed'
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (error) {
    console.error('[sensenova] job failed:', error)
    await failWorldJob(slug, jobId, errorMessage(error))
  }
}

/**
 * Reconstruct a 4D person from a take.
 *
 * Unlike every other runner here, the work happens on another machine — see
 * `server/person4d/person_4d.ts` for why (43.3 GiB of CUDA against a 24 GiB
 * ROCm fleet). This function assembles the take, delegates, and ingests.
 *
 * Two behaviours worth knowing:
 *
 *  - **Progress is committed in throttled steps.** Each commit takes the
 *    per-slug world lock and rewrites the whole world JSON (ADR 0004), so a
 *    per-frame update on a 24-frame sequence would be 24 full rewrites under
 *    lock. 5% steps keep the editor's progress bar honest without that cost.
 *  - **A missing subsystem is a green job.** `skipped` maps to 'completed' with
 *    a remediation string, matching BRUSH_BIN and LINGBOT_MAP_* — the appliance
 *    must not break because no GPU host is attached.
 */
/**
 * Panoptic segmentation over a session's streamed keyframes.
 *
 * Shaped like _runSenseNovaVisionJob: an optional GPU tool whose absence is a
 * COMPLETED job carrying a remediation, not a failure — the appliance keeps
 * working and the UI can tell the operator what to install. The `thingCount` /
 * `stuffCount` split is surfaced in the artifact because they are handled
 * differently downstream (see server/panoptic/panoptic_segments.ts).
 */
async function _runPanopticScanJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionPath, payload } = start
    const result = await runPanopticScan({
      sessionDir: sessionPath,
      model: asString(payload?.['model']) ?? undefined,
      maxFrames: typeof payload?.['maxFrames'] === 'number' ? payload['maxFrames'] as number : undefined,
      sessionId: scan.sessionId ?? undefined,
      scanId: scan.scanId ?? undefined,
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result =
          `Panoptic scan segmented ${result.framesSegmented ?? 0} frame(s): ` +
          `${result.thingCount ?? 0} object segment(s), ${result.stuffCount ?? 0} surface segment(s).`
        currentJob.artifacts = [{
          type: 'panoptic-output',
          label: `${scan.name} panoptic segments`,
          metadata: {
            model: result.model ?? null,
            framesSegmented: result.framesSegmented ?? 0,
            thingCount: result.thingCount ?? 0,
            stuffCount: result.stuffCount ?? 0,
            segmentsPath: result.segmentsPath ?? null,
          },
        }]
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `Panoptic scan skipped: ${result.remediation ?? result.skippedReason ?? 'runtime unavailable'}`
        currentJob.artifacts = [{
          type: 'panoptic-skip',
          label: 'Panoptic runtime setup required',
          metadata: { remediation: result.remediation ?? null, reason: result.skippedReason ?? null },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.error ?? 'panoptic worker failed'
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (error) {
    console.error('[panoptic] job failed:', error)
    await failWorldJob(slug, jobId, errorMessage(error))
  }
}

/**
 * Lift `panoptic-scan`'s 2D segments into world space.
 *
 * Reports `completed` for a skip, exactly as the scan stage does — a session
 * with no segments file has not failed, it has not been segmented yet, and the
 * remediation says which job to run first.
 *
 * The interesting case is a run that succeeds while placing nothing. That is
 * not a failure either: a gimbal dome rotates in place, so parallax is near
 * zero (measured 0.881 m max baseline across 17 cameras), and refusing to
 * invent depths is the designed behaviour. The result string therefore always
 * carries the undetermined count alongside the confident one — "44 seen, 0
 * placed" has to read as an honest outcome, not as silence.
 */
async function _runPanopticLiftJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionPath, payload } = start

    const result = await runPanopticLift({
      sessionDir: sessionPath,
      scanGlbPath: `${SCANS_DIR}/${scan.filename}`,
      minSegmentPixels: typeof payload?.['minSegmentPixels'] === 'number'
        ? payload['minSegmentPixels'] as number
        : undefined,
      sessionId: scan.sessionId ?? undefined,
      scanId: scan.scanId ?? undefined,
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        const placed = result.confidentCount ?? 0
        const seen = result.segmentCount ?? 0
        currentJob.result = placed > 0
          ? `Placed ${placed} of ${seen} object segment(s) in the room` +
            `${result.medianConfidence != null ? ` (median confidence ${result.medianConfidence.toFixed(2)})` : ''}.` +
            `${(result.undeterminedCount ?? 0) > 0 ? ` ${result.undeterminedCount} could not be placed.` : ''}`
          : `Saw ${seen} object segment(s) but could not place any of them. ` +
            `A capture that rotates in place has almost no parallax, so depth is not recoverable from it — ` +
            `walk the room to give the scan a baseline.`
        currentJob.artifacts = [{
          type: 'panoptic-lift-output',
          label: `${scan.name} placed objects`,
          metadata: {
            segmentCount: seen,
            confidentCount: placed,
            lowConfidenceCount: result.lowConfidenceCount ?? 0,
            undeterminedCount: result.undeterminedCount ?? 0,
            medianConfidence: result.medianConfidence ?? null,
            pointCount: result.pointCount ?? 0,
            reasons: result.reasons ?? {},
            detectionsPath: result.detectionsPath ?? null,
          },
        }]
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `Object placement skipped: ${result.remediation ?? result.skippedReason ?? 'inputs unavailable'}`
        currentJob.artifacts = [{
          type: 'panoptic-lift-skip',
          label: 'Object placement needs a panoptic scan first',
          metadata: { remediation: result.remediation ?? null, reason: result.skippedReason ?? null },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.error ?? 'panoptic lift failed'
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (error) {
    console.error('[panoptic-lift] job failed:', error)
    await failWorldJob(slug, jobId, errorMessage(error))
  }
}

async function _runPerson4DJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimJobScan(slug, jobId)
    if (!start) return
    const { scan } = start

    const base = scan.filename.replace(/\.glb$/, '')
    const sequenceDir = `${SCANS_DIR}/${base}.4d`
    const manifestPath = `${SCANS_DIR}/${base}.4d-capture.manifest.json`

    // Assemble the take. A solo capture is a first-class input, not a
    // degenerate take — it is the ordinary single-phone case, and it is the one
    // the densify path exists for.
    const index = await loadSessionIndex(SESSIONS_DIR)
    const ownRecord = scan.sessionId ? index.bySessionId.get(scan.sessionId) : undefined
    const takeId = ownRecord ? asString(ownRecord['takeId']) : null
    const memberRecords = takeId
      ? sessionsForTake(index, takeId)
      : (ownRecord ? [ownRecord] : [])

    const callbackBase = person4dCallbackBase()
    const clips: Person4DClip[] = []
    let worstResidual: number | undefined
    for (const record of memberRecords) {
      const sessionId = asString(record['sessionId'])
      const clipFile = asString(record['clipFile'])
      if (!sessionId || !clipFile) continue
      clips.push({
        clientId: asString(record['clientId']),
        url: `${callbackBase}/sessions/${sessionId}/clip/${clipFile}`,
        mimeType: asString(record['clipMimeType']) ?? 'video/mp4',
        poseTrackUrl: record['poseTrackFile'] ? `${callbackBase}/sessions/${sessionId}/pose-track.json` : null,
        sync: record['sync'] ?? null,
      })
      const sync = record['sync'] as { method?: unknown; residualMs?: unknown } | undefined
      if (sync?.method === 'measured' && typeof sync.residualMs === 'number') {
        worstResidual = worstResidual === undefined ? sync.residualMs : Math.max(worstResidual, sync.residualMs)
      }
    }

    // Throttle progress to ~5% steps — each commit rewrites the world JSON.
    let lastCommitted = 0
    const result = await runPerson4D({
      takeId: takeId ?? `take-solo-${scan.scanId}`,
      clips,
      sequenceDir,
      manifestPath,
      syncResidualMs: worstResidual,
      provenance: { sessionId: scan.sessionId ?? undefined, scanId: scan.scanId },
      onProgress: (fraction) => {
        if (fraction - lastCommitted < 0.05) return
        lastCommitted = fraction
        void commitWorldJob(slug, jobId, (currentJob) => {
          currentJob.progress = Math.min(0.99, fraction)
          currentJob.updatedAt = new Date().toISOString()
        })
      },
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result = jobResultFor(currentJob)
        currentJob.artifacts = jobArtifactsFor(currentJob, current)
        currentJob.artifacts ??= []
        currentJob.artifacts.push({
          type: 'splat4d-sequence',
          label: `${scan.name} 4D sequence`,
          url: `/scans/${encodeURIComponent(`${base}.4d-capture.manifest.json`)}`,
          metadata: {
            frameCount: result.manifest.frameCount ?? null,
            fps: result.manifest.fps ?? null,
            viewSource: result.manifest.viewSource ?? null,
            clipCount: result.manifest.clipCount,
          },
        })
        // Promote the scan's splat4d layer to a real sidecar layer.
        const targetScan = current.scans.find(s => s.scanId === scan.scanId)
        if (targetScan) {
          const existing = targetScan.layerIndex.find(l => l.type === 'splat4d')
          if (existing) {
            existing.source = 'sidecar'
            existing.count = result.manifest.frameCount ?? null
          } else {
            targetScan.layerIndex.push({
              id: `${scan.scanId}-splat4d`,
              type: 'splat4d',
              label: '4D person',
              visibleByDefault: false,
              encodedInGlb: false,
              count: result.manifest.frameCount ?? null,
              source: 'sidecar',
            })
          }
        }
      } else if (result.status === 'skipped') {
        // Green, with a hint. No GPU host attached is a configuration state,
        // not a failure of the scan.
        currentJob.status = 'completed'
        currentJob.result = `4D reconstruction skipped: ${result.manifest.skippedReason ?? 'unavailable'}${result.manifest.remediation ? ` — ${result.manifest.remediation}` : ''}`
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.manifest.error ?? 'person-4d reconstruction failed'
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (error) {
    console.error('[person-4d] job failed:', error)
    await failWorldJob(slug, jobId, errorMessage(error))
  }
}

async function _runSplatTrainJob(slug: string, jobId: string): Promise<void> {
  try {
    const start = await claimSessionJob(slug, jobId)
    if (!start) return
    const { scan, sessionId, sessionPath } = start

    const base = scan.filename.replace(/\.glb$/, '')
    const outputPlyPath = `${SCANS_DIR}/${base}.splat.ply`
    const outputCompressedPlyPath = `${SCANS_DIR}/${base}.compressed.ply`
    const manifestPath = `${SCANS_DIR}/${base}.splat-train.manifest.json`
    // Both drivers take the same options and return the same shape — that is
    // the whole point of spirula_train.ts mirroring splat_train.ts's contract,
    // and it is what keeps the ~100 lines of world bookkeeping below
    // backend-agnostic.
    const trainOpts = {
      sessionDir: sessionPath,
      outputPlyPath,
      outputCompressedPlyPath,
      manifestPath,
      provenance: { sessionId, scanId: scan.scanId },
    }
    const result = SPLAT_BACKEND === 'spirula'
      ? await runSpirulaTrain(trainOpts)
      : await runSplatTrain(trainOpts)

    const chainedFinishJobId = await commitWorldJob(slug, jobId, (currentJob, current) => {
      let chained: string | null = null
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result = jobResultFor(currentJob)
        currentJob.artifacts = jobArtifactsFor(currentJob, current)
        const plyName = `${base}.splat.ply`
        currentJob.artifacts ??= []
        currentJob.artifacts.push({
          type: 'splat-ply',
          label: `${scan.name} Gaussian splat`,
          url: `/scans/${encodeURIComponent(plyName)}`,
          metadata: {
            gaussianCount: result.gaussianCount ?? null,
            compressedUrl: result.compressedPlyPath
              ? `/scans/${encodeURIComponent(`${base}.compressed.ply`)}`
              : null,
            manifestUrl: `/scans/${encodeURIComponent(`${base}.splat-train.manifest.json`)}`,
          },
        })
        // Auto-chain Stage 4: enqueue splat-finish (sog + compressed.ply) for the
        // same scan, mirroring how /ingest-video auto-enqueues reconstruction.
        // Kill switch: SPLAT_FINISH_AUTO=0. The pump is kicked after the world
        // is saved and the lock released, below.
        if (SPLAT_FINISH_AUTO) {
          const finishJob = createWorldJob(current, 'splat-finish', scan.scanId, {
            source: 'auto-chain',
            trainJobId: jobId,
            sessionId,
          })
          chained = finishJob.jobId
        }
        // Promote the scan's reserved 'splat' layer from 'future' to a real
        // 'sidecar' layer carrying the trained gaussian count. Falls back to a
        // fresh entry if the default index somehow lacked one.
        const targetScan = current.scans.find(s => s.scanId === scan.scanId)
        if (targetScan) {
          const existing = targetScan.layerIndex.find(l => l.type === 'splat')
          if (existing) {
            existing.source = 'sidecar'
            existing.count = result.gaussianCount ?? existing.count ?? null
          } else {
            targetScan.layerIndex.push({
              id: 'layer-splat',
              type: 'splat',
              label: 'Gaussian splat',
              visibleByDefault: false,
              encodedInGlb: false,
              source: 'sidecar',
              count: result.gaussianCount ?? null,
            })
          }
        }
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `Splat train skipped: ${result.manifest.skippedReason ?? 'unknown reason'}`
        currentJob.artifacts = [{
          type: 'splat-skip',
          label: 'Splat training skipped',
          url: `/scans/${encodeURIComponent(`${base}.splat-train.manifest.json`)}`,
          metadata: {
            sessionId,
            skippedReason: result.manifest.skippedReason ?? null,
            remediation: result.manifest.remediation ?? null,
          },
        }]
      } else {
        currentJob.status = 'failed'
        // Name the backend that actually ran, from the manifest's own `tool`
        // rather than a hardcoded "brush" — with two backends the exit code
        // alone no longer says which binary produced it.
        currentJob.error = result.manifest.error ?? `${result.manifest.tool} exit ${result.exitCode}`
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
      return chained
    })
    if (chainedFinishJobId) await completeJobSoon(slug, chainedFinishJobId)
  } catch (err) {
    console.error('[splat-train job error]', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

async function _runSplatDetectJob(slug: string, jobId: string): Promise<void> {
  try {
    const claimed = await claimJobScan(slug, jobId)
    if (!claimed) return
    const { scan, payload } = claimed

    const base = scan.filename.replace(/\.glb$/, '')
    const splatPlyPath = `${SCANS_DIR}/${base}.splat.ply`
    const sessionId = scan.sessionId ?? undefined
    const sessionPath = sessionId ? sessionDir(sessionId) ?? undefined : undefined
    const outputInteractionsPath = `${SCANS_DIR}/${base}.interactions.json`
    const manifestPath = `${SCANS_DIR}/${base}.splat-detect.manifest.json`
    // Prompt: explicit job param wins; the driver defaults the env prompt otherwise.
    const prompt = typeof payload?.['prompt'] === 'string' && (payload['prompt'] as string).trim().length > 0
      ? (payload['prompt'] as string).trim()
      : undefined
    // Tuning knobs: forwarded from the job payload as strings; unset lets the
    // driver fall back to its env defaults / run_local.py's own defaults.
    const payloadStr = (key: string): string | undefined => {
      const v = payload?.[key]
      if (typeof v === 'number') return String(v)
      return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
    }

    const result = await runSplatDetect({
      splatPlyPath,
      sessionDir: sessionPath,
      outputInteractionsPath,
      manifestPath,
      prompt,
      quality: payloadStr('quality'),
      scoreThreshold: payloadStr('scoreThreshold'),
      minVotes: payloadStr('minVotes'),
      minPeakScore: payloadStr('minPeakScore'),
      provenance: { sessionId, scanId: scan.scanId },
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result = jobResultFor(currentJob)
        currentJob.artifacts = jobArtifactsFor(currentJob, current)
        const interactionsName = `${base}.interactions.json`
        currentJob.artifacts ??= []
        currentJob.artifacts.push({
          type: 'splat-detections',
          label: `${scan.name} splat detections`,
          url: `/scans/${encodeURIComponent(interactionsName)}`,
          metadata: {
            objectCount: result.objectCount ?? null,
            prompt: result.manifest.prompt,
            manifestUrl: `/scans/${encodeURIComponent(`${base}.splat-detect.manifest.json`)}`,
          },
        })
        // Promote a 'detections' layer carrying the detected object count.
        const targetScan = current.scans.find(s => s.scanId === scan.scanId)
        if (targetScan) {
          const existing = targetScan.layerIndex.find(l => l.type === 'detections')
          if (existing) {
            existing.source = 'sidecar'
            existing.count = result.objectCount ?? existing.count ?? null
          } else {
            targetScan.layerIndex.push({
              id: 'layer-splat-detections',
              type: 'detections',
              label: 'Splat detections',
              visibleByDefault: false,
              encodedInGlb: false,
              source: 'sidecar',
              count: result.objectCount ?? null,
            })
          }
          if (typeof result.objectCount === 'number') targetScan.detectionCount = result.objectCount
        }
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `Splat detect skipped: ${result.manifest.skippedReason ?? 'unknown reason'}`
        currentJob.artifacts = [{
          type: 'splat-detect-skip',
          label: 'Splat detection skipped',
          url: `/scans/${encodeURIComponent(`${base}.splat-detect.manifest.json`)}`,
          metadata: {
            sessionId: sessionId ?? null,
            skippedReason: result.manifest.skippedReason ?? null,
            remediation: result.manifest.remediation ?? null,
          },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.manifest.error ?? `splat-analyzer exit ${result.exitCode}`
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[splat-detect job error]', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

/**
 * memory-push — ship a finished scan to the user's Companion Memory appliance.
 *
 * The push is idempotent on (source_system, scanId), so re-running this job on
 * the same scan updates nothing and reports a duplicate rather than failing.
 */
async function _runMemoryPushJob(slug: string, jobId: string): Promise<void> {
  try {
    const claimed = await claimJobScan(slug, jobId)
    if (!claimed) return
    const { scan } = claimed

    const pushed = await pushScanToMemory(memoryPushCfg, scan, { scansDir: SCANS_DIR })

    await commitWorldJob(slug, jobId, (currentJob) => {
      currentJob.progress = 1
      currentJob.status = 'completed'
      currentJob.result = pushed.eventDuplicate > 0
        ? 'Scan was already in Companion Memory — nothing to add.'
        : jobResultFor(currentJob)
      currentJob.artifacts = [{
        type: 'memory-event',
        label: `${scan.name} in Companion Memory`,
        metadata: {
          sourceSystem: memoryPushCfg.sourceSystem,
          sourceId: pushed.sourceId,
          glbFileId: pushed.glbFileId,
          glbSkippedReason: pushed.glbSkippedReason ?? null,
          detectionCount: pushed.detectionCount,
          extentCount: pushed.extentCount,
          ingested: pushed.eventIngested,
          duplicate: pushed.eventDuplicate,
        },
      }]
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[memory-push] job failed:', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

async function _runSplatFinishJob(slug: string, jobId: string): Promise<void> {
  try {
    const claimed = await claimJobScan(slug, jobId)
    if (!claimed) return
    const { scan } = claimed

    const base = scan.filename.replace(/\.glb$/, '')
    const splatPlyPath = `${SCANS_DIR}/${base}.splat.ply`
    const outputSogPath = `${SCANS_DIR}/${base}.sog`
    const outputCompressedPlyPath = `${SCANS_DIR}/${base}.compressed.ply`
    const manifestPath = `${SCANS_DIR}/${base}.splat-finish.manifest.json`
    const result = await runSplatFinish({
      splatPlyPath,
      outputSogPath,
      outputCompressedPlyPath,
      manifestPath,
      provenance: { sessionId: scan.sessionId ?? undefined, scanId: scan.scanId },
    })

    await commitWorldJob(slug, jobId, (currentJob, current) => {
      currentJob.progress = 1
      if (result.status === 'ok') {
        currentJob.status = 'completed'
        currentJob.result = jobResultFor(currentJob)
        currentJob.artifacts = jobArtifactsFor(currentJob, current)
        currentJob.artifacts ??= []
        currentJob.artifacts.push({
          type: 'splat-sog',
          label: `${scan.name} web-optimized splat (.sog)`,
          url: `/scans/${encodeURIComponent(`${base}.sog`)}`,
          metadata: {
            inputBytes: result.sizes?.inputBytes ?? null,
            sogBytes: result.sizes?.sogBytes ?? null,
            compressedBytes: result.sizes?.compressedBytes ?? null,
            compressedPlyUrl: `/scans/${encodeURIComponent(`${base}.compressed.ply`)}`,
            manifestUrl: `/scans/${encodeURIComponent(`${base}.splat-finish.manifest.json`)}`,
          },
        })
        applyCompletedJobToWorld(currentJob, current)
      } else if (result.status === 'skipped') {
        currentJob.status = 'completed'
        currentJob.result = `Splat finish skipped: ${result.manifest.skippedReason ?? 'unknown reason'}`
        currentJob.artifacts = [{
          type: 'splat-finish-skip',
          label: 'Splat finish skipped',
          url: `/scans/${encodeURIComponent(`${base}.splat-finish.manifest.json`)}`,
          metadata: {
            skippedReason: result.manifest.skippedReason ?? null,
            remediation: result.manifest.remediation ?? null,
          },
        }]
      } else {
        currentJob.status = 'failed'
        currentJob.error = result.manifest.error ?? `splat-transform exit ${result.exitCode}`
        currentJob.result = currentJob.error
      }
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[splat-finish job error]', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

/**
 * Runs `pipeline.ts`'s `optimizeScan()` on a stored .glb and writes the same
 * three artifact files `jobs.ts`'s `JobQueue._runOptimize()` always has:
 *   <base>.opt.glb            quantized (+Draco) full-quality scan
 *   <base>.lodN.glb           voxel-downsampled point-cloud previews
 *   <base>.manifest.json      artifact index + stats + per-stage log
 * Ported near-verbatim from `_runOptimize()` (jobs.ts) — same filenames, same
 * manifest shape, same content — only the caller changed (ADR 0003
 * "optimize-scan", ticket 01-merge-jobs/0003). Unlike every other `_run*Job`,
 * this type has no associated scan: `optimize-scan` `WorldJob`s carry their
 * target in `payload.filename` (mirroring `Job.target`), not `scanId` — see
 * `enqueueOptimizeScanJob` — so this function doesn't use `scanForJob`/
 * `jobFailureReason`, which are keyed on `job.scanId`.
 */
async function _runOptimizeScanJob(slug: string, jobId: string): Promise<void> {
  try {
    // Read-only: this job's target. `failWorldJob` no-ops if the job is gone.
    const world = await loadWorld(slug)
    const filename = objectKey(world.jobs.find(j => j.jobId === jobId)?.payload?.['filename'])
    if (!filename) {
      await failWorldJob(slug, jobId, 'optimize-scan requires payload.filename.')
      return
    }

    // ── Ported near-verbatim from jobs.ts's JobQueue._runOptimize() ──────────
    const sourcePath = `${SCANS_DIR}/${filename}`
    const glb = await Deno.readFile(sourcePath)
    console.log(`[world-jobs] optimizing ${filename} (${(glb.byteLength / 1024).toFixed(0)} KB)`)

    // Stamp the one provenance field the client cannot know. Derived from the
    // filename rather than looked up in world.scans: since 07-scan-identity/0001
    // `scanManifestFromStored` sets `scanId = scanIdFor(filename)`, so the two
    // are identical by construction — and deriving also works in the window
    // between an upload and `refreshWorldScans` adding the entry, where a
    // lookup would find nothing and silently stamp nothing.
    const result = await optimizeScan(glb, { provenance: { scanId: scanIdFor(filename) } })
    const base = filename.replace(/\.glb$/, '')

    const optimizedName = `${base}.opt.glb`
    await Deno.writeFile(`${SCANS_DIR}/${optimizedName}`, result.optimized.bytes)

    // pipeline returns coarsest-first; name finest as lod1, coarser as lod2…
    const lodEntries: OptimizeScanManifest['artifacts']['lods'] = []
    const finestFirst = [...result.lods].sort((a, b) => (a.voxelM ?? 0) - (b.voxelM ?? 0))
    for (let i = 0; i < finestFirst.length; i++) {
      const lod = finestFirst[i]
      const lodFilename = `${base}.lod${i + 1}.glb`
      await Deno.writeFile(`${SCANS_DIR}/${lodFilename}`, lod.bytes)
      lodEntries.push({
        filename: lodFilename,
        bytes: lod.bytes.byteLength,
        points: lod.points ?? 0,
        voxelM: lod.voxelM ?? 0,
      })
    }
    lodEntries.sort((a, b) => b.voxelM - a.voxelM) // coarsest first for the manifest

    const manifest: OptimizeScanManifest = {
      source: filename,
      createdAt: new Date().toISOString(),
      stats: result.stats as unknown as Record<string, number>,
      stages: result.stages,
      artifacts: {
        optimized: {
          filename: optimizedName,
          bytes: result.optimized.bytes.byteLength,
          draco: result.optimized.draco,
          quantized: result.optimized.quantized,
        },
        lods: lodEntries,
      },
    }
    await Deno.writeTextFile(
      `${SCANS_DIR}/${base}.manifest.json`,
      JSON.stringify(manifest, null, 2),
    )

    const ratio = result.optimized.bytes.byteLength / glb.byteLength
    const note = `${(glb.byteLength / 1024).toFixed(0)} KB → ${(result.optimized.bytes.byteLength / 1024).toFixed(0)} KB (${Math.round(ratio * 100)}%)` +
      (lodEntries.length ? ` + ${lodEntries.length} LODs` : '')
    console.log(`[world-jobs] ${filename}: ${note}`)
    // ── End ported section ────────────────────────────────────────────────

    await commitWorldJob(slug, jobId, (currentJob) => {
      currentJob.status = 'completed'
      currentJob.result = note // Job.note → WorldJob.result, per ADR 0003's field mapping
      currentJob.artifacts = [
        {
          type: 'optimized-glb',
          label: `${filename} optimized (.opt.glb)`,
          url: `/scans/${encodeURIComponent(optimizedName)}`,
          metadata: {
            bytes: result.optimized.bytes.byteLength,
            draco: result.optimized.draco,
            quantized: result.optimized.quantized,
          },
        },
        ...lodEntries.map(lod => ({
          type: 'optimized-lod',
          label: `${filename} LOD (${lod.filename})`,
          url: `/scans/${encodeURIComponent(lod.filename)}`,
          metadata: { bytes: lod.bytes, points: lod.points, voxelM: lod.voxelM },
        })),
        {
          type: 'optimize-manifest',
          label: `${filename} optimization manifest`,
          url: `/scans/${encodeURIComponent(`${base}.manifest.json`)}`,
        },
      ]
      currentJob.progress = 1
      currentJob.updatedAt = new Date().toISOString()
    })
  } catch (err) {
    console.error('[optimize-scan] job failed:', err)
    await failWorldJob(slug, jobId, errorMessage(err))
  }
}

/** Mark a job failed in place — the status/error/result/progress/updatedAt set every runner writes. */
function markJobFailed(job: WorldJob, reason: string): WorldJob {
  job.status = 'failed'
  job.error = reason
  job.result = reason
  job.progress = 1
  job.updatedAt = new Date().toISOString()
  return job
}

/**
 * The opening move every scan-backed `_run*Job` makes, as one mutation:
 * find the job, and either hand back its scan or mark it failed in place.
 * Returns `null` when the job is gone (nothing to broadcast), `ok: false`
 * when it was just failed (caller broadcasts and returns). Must be called
 * from inside an `updateWorld` mutator — it mutates `world`.
 */
function claimScanJob(
  world: WorldProject,
  jobId: string,
  preflight: JobPreflight = {},
): { ok: true; job: WorldJob; scan: ScanManifest } | { ok: false; job: WorldJob } | null {
  const job = world.jobs.find(j => j.jobId === jobId)
  if (!job) return null
  const failure = jobFailureReason(job, world, preflight)
  if (failure) return { ok: false, job: markJobFailed(job, failure) }
  // jobFailureReason already rejected every scan-backed type without a scan.
  return { ok: true, job, scan: scanForJob(job, world)! }
}

/**
 * Locked start step for the scan-backed runners that don't need a session
 * directory (splat-detect, splat-finish, memory-push): claim the job and hand
 * back its scan (plus its payload, which splat-detect reads its tuning knobs
 * from), or mark it failed and broadcast. `null` means "stop here".
 */
async function claimJobScan(
  slug: string,
  jobId: string,
): Promise<{ scan: ScanManifest; payload: WorldJob['payload'] } | null> {
  const preflight = await keyframePreflight(slug, jobId)
  const { world, value: claimed } = await updateWorld(slug, (world) => claimScanJob(world, jobId, preflight))
  if (!claimed) return null
  if (!claimed.ok) {
    broadcast({ type: EVENT.WORLD_JOB_UPDATE, worldId: world.worldId, job: claimed.job })
    return null
  }
  return { scan: claimed.scan, payload: claimed.job.payload }
}

/**
 * Locked start step for the session-backed runners (lingbot-map-reconstruct,
 * splat-train): the above plus resolving the scan's keyframe session
 * directory, which is its own failure the two shared verbatim.
 */
async function claimSessionJob(
  slug: string,
  jobId: string,
): Promise<{ scan: ScanManifest; sessionId: string; sessionPath: string; payload: WorldJob['payload'] } | null> {
  const preflight = await keyframePreflight(slug, jobId)
  const { world, value: start } = await updateWorld(slug, (world) => {
    const claimed = claimScanJob(world, jobId, preflight)
    if (!claimed?.ok) return claimed
    // Reached only when preflight already proved the directory exists, so this
    // is the shape resolver: it builds the path rather than re-proving it.
    const sessionPath = claimed.scan.sessionId ? sessionDir(claimed.scan.sessionId) : null
    if (!sessionPath) {
      return {
        ok: false as const,
        job: markJobFailed(claimed.job, `Invalid session id: ${claimed.scan.sessionId}`),
      }
    }
    return { ok: true as const, job: claimed.job, scan: claimed.scan, sessionPath }
  })
  if (!start) return null
  if (!start.ok) {
    broadcast({ type: EVENT.WORLD_JOB_UPDATE, worldId: world.worldId, job: start.job })
    return null
  }
  return { scan: start.scan, sessionId: start.scan.sessionId!, sessionPath: start.sessionPath, payload: start.job.payload }
}

/**
 * How every `_run*Job` records a job transition: re-find the job in a fresh,
 * locked snapshot (the one the runner loaded before the worker ran is stale
 * by now), apply `mutate`, persist, then broadcast. Returns false when the
 * job has vanished — nothing was written or broadcast.
 *
 * Broadcasting after the lock is released, never inside `mutate`, keeps the
 * save-before-broadcast ordering every transition in this file follows.
 *
 * Returns whatever `mutate` returned (`null` if the job was gone), which is
 * how a runner gets a follow-on job id back out of the critical section
 * without capturing a `let` across it.
 */
async function commitWorldJob<T>(
  slug: string,
  jobId: string,
  mutate: (job: WorldJob, world: WorldProject) => T,
): Promise<T | null> {
  const { world, value } = await updateWorld(slug, (world) => {
    const job = world.jobs.find(j => j.jobId === jobId)
    if (!job) return null
    return { job, out: mutate(job, world) }
  })
  if (!value) return null
  broadcast({ type: EVENT.WORLD_JOB_UPDATE, worldId: world.worldId, job: value.job })
  // No-op for every type but optimize-scan (ticket 0004's paired events).
  broadcastLegacyJobUpdate(value.job)
  return value.out
}

/**
 * Terminal failure path shared by every `_run*Job`'s catch block. Swallows
 * its own errors — it is already the error path, and the original failure has
 * been logged by the caller.
 */
async function failWorldJob(slug: string, jobId: string, reason: string): Promise<void> {
  try {
    await commitWorldJob(slug, jobId, (job) => { markJobFailed(job, reason) })
  } catch { /* nothing more we can do */ }
}

/** The message `failWorldJob` records for a thrown error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function scanForJob(job: WorldJob, world: WorldProject): ScanManifest | null {
  if (!job.scanId) return null
  return world.scans.find(scan => scan.scanId === job.scanId || scan.filename === job.scanId) ?? null
}

/** The job types that cannot run without RGB keyframe observations. */
const KEYFRAME_JOB_TYPES = ['depth-reconstruct', 'lingbot-map-reconstruct', 'colmap-poses', 'splat-train', 'splat-align']

/**
 * Filesystem facts `jobFailureReason` needs but must not look up itself.
 *
 * It runs inside `updateWorld` mutators, and ADR 0004 keeps I/O out of that
 * critical section — so existence is resolved by `keyframePreflight()` before
 * the lock is taken and passed in. Absent means "not resolved", which falls
 * back to the shape-only check rather than inventing a verdict.
 */
interface JobPreflight {
  /** Whether the scan's keyframe session directory is present on disk. */
  keyframeDirExists?: boolean
}

/**
 * Resolve the filesystem half of a job's preflight, outside the world lock.
 *
 * Reads one locked snapshot, then stats — so the answer is a snapshot older
 * than the write that consumes it. That staleness is benign: it can only make
 * preflight miss a directory that vanished in the last instant, and the runner
 * still fails on it. What it buys is the failure landing at preflight, with
 * the actionable message, for the case that actually happens — an id that was
 * never a server session at all.
 */
async function keyframePreflight(slug: string, jobId: string): Promise<JobPreflight> {
  try {
    const world = await loadWorld(slug)
    const job = world.jobs.find(j => j.jobId === jobId)
    if (!job || !KEYFRAME_JOB_TYPES.includes(job.type)) return {}
    const scan = scanForJob(job, world)
    if (!scan?.sessionId) return {}
    return { keyframeDirExists: await resolveSessionDirFor(scan.sessionId) !== null }
  } catch {
    // A preflight hint is never worth failing a dispatch over.
    return {}
  }
}

function jobFailureReason(job: WorldJob, world: WorldProject, preflight: JobPreflight = {}): string | null {
  const scan = scanForJob(job, world)
  if (['align-scan', 'extract-layers', 'semantic-pass', 'depth-reconstruct', 'lingbot-map-reconstruct', 'colmap-poses', 'splat-train', 'splat-align', 'splat-detect', 'splat-finish', 'memory-push', 'person-4d-reconstruct'].includes(job.type) && !scan) {
    return `${job.type} requires a selected scan.`
  }
  if (job.type === 'memory-push' && !memoryPushCfg.enabled) {
    return 'Companion Memory is not connected. Connect it from the Hub, or set CI_SERVER_URL and CI_SERVER_TOKEN.'
  }
  // A sessionId that names no directory is not a session. Until this checked
  // existence, the guard was defeated by its own truthiness: the id was a
  // non-empty string, so preflight passed and the job failed later inside the
  // runner, where the message is about a missing path instead of about the
  // thing the user can actually do something about.
  if (KEYFRAME_JOB_TYPES.includes(job.type) && scan && (!scan.sessionId || preflight.keyframeDirExists === false)) {
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
  else if (job.type === 'lingbot-map-reconstruct') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
  else if (job.type === 'splat-train') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
  else if (job.type === 'splat-detect') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
  else if (job.type === 'splat-finish') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
  else if (job.type === 'sensenova-vision') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
  else if (job.type === 'panoptic-scan') {
    scan.status = scan.qualitySummary?.status ?? 'ready'
  }
  else if (job.type === 'person-4d-reconstruct') {
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
    case 'thing-correspondence':
      return 'Thing correspondence resolved scan observations into durable cross-session objects.'
    case 'lingbot-map-reconstruct':
      return 'LingBot-Map streaming reconstruction complete. Point cloud + per-frame poses written to the session.'
    case 'colmap-poses':
      return 'COLMAP structure-from-motion solved per-frame camera poses. colmap.poses.json + sparse seed cloud written to the session.'
    case 'splat-align':
      return 'Splat aligned to the Place metric frame. The stored similarity transform gives the splat real-world scale and position.'
    case 'splat-train':
      return 'Gaussian splat trained with Brush. The .splat.ply sidecar is available as a splat layer on the scan.'
    case 'splat-detect':
      return 'Splat scene detected with splat-analyzer. The .interactions.json sidecar carries 3D object boxes.'
    case 'splat-finish':
      return 'Splat finished with splat-transform. The web-optimized .sog and .compressed.ply sidecars are ready for delivery.'
    case 'sensenova-vision':
      return 'SenseNova-Vision processed the scan keyframes and wrote task-specific visual geometry artifacts.'
    case 'panoptic-scan':
      return 'Panoptic segmentation labelled every pixel of the scan keyframes, separating discrete objects from room surfaces.'
    case 'panoptic-lift':
      return 'Panoptic object segments were placed in the room by casting each one against the scan point cloud. A segment whose depth could not be recovered is recorded as unplaced rather than guessed.'
    case 'person-4d-reconstruct':
      return 'Person reconstructed in 4D. The .4d/ sequence is available as a splat4d layer on the scan.'
    case 'memory-push':
      return 'Scan pushed to Companion Memory as a capture.scan event with the GLB attached.'
    case 'export-world':
      return 'World export manifest is ready for a combined GLB and semantic JSON worker.'
    case 'optimize-scan':
      // Dead branch at runtime: _runOptimizeScanJob always sets
      // currentJob.result itself (the size-reduction note, ADR 0003's
      // Job.note → WorldJob.result mapping) and never calls jobResultFor —
      // present only so this switch stays exhaustive under `deno check`
      // now that WorldJobType includes 'optimize-scan'.
      return 'Scan optimized: quantized (+Draco) GLB and coarse-to-fine LOD previews written.'
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
    case 'thing-correspondence':
      return [{
        type: 'thing-correspondence-plan',
        label: `${world.name} thing correspondence inputs`,
        metadata: { scans: world.scans.length, observations: world.thingObservations?.length ?? 0 },
      }]
    case 'lingbot-map-reconstruct': {
      if (!scan || !scan.sessionId) return []
      const sessionId = scan.sessionId
      return [{
        type: 'lingbot-map-reconstruction',
        label: `${scan.name} LingBot-Map reconstruction`,
        url: `/sessions/${encodeURIComponent(sessionId)}/lingbot-map.manifest.json`,
        metadata: {
          sessionId,
          pointCloudUrl: `/sessions/${encodeURIComponent(sessionId)}/lingbot-map.point-cloud.ply`,
          posesUrl: `/sessions/${encodeURIComponent(sessionId)}/lingbot-map.poses.json`,
          keyframes: scan.qualitySummary?.keyframeCount ?? null,
        },
      }]
    }
    case 'splat-train':
      // The real .splat.ply artifact is appended by _runSplatTrainJob once the
      // Brush run lands; this base entry records the training inputs.
      return scan ? [{
        type: 'splat-plan',
        label: `${scan.name} splat training inputs`,
        url: scan.frameSetUrl,
        metadata: { sessionId: scan.sessionId, canonicalLayer: 'splat' },
      }] : []
    case 'splat-detect':
      // The real .interactions.json artifact is appended by _runSplatDetectJob
      // once the analyzer run lands; this base entry records the detection plan.
      return scan ? [{
        type: 'splat-detect-plan',
        label: `${scan.name} splat detection inputs`,
        metadata: { sessionId: scan.sessionId, canonicalLayer: 'detections' },
      }] : []
    case 'splat-finish':
      // The real .sog artifact is appended by _runSplatFinishJob once the
      // splat-transform run lands; this base entry records the finish inputs.
      return scan ? [{
        type: 'splat-finish-plan',
        label: `${scan.name} splat finish inputs`,
        metadata: { sessionId: scan.sessionId, canonicalLayer: 'splat' },
      }] : []
    case 'sensenova-vision':
      return scan ? [{
        type: 'sensenova-plan',
        label: `${scan.name} SenseNova inputs`,
        metadata: { sessionId: scan.sessionId, task: job.payload?.['task'] ?? 'recon3d' },
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
    case 'memory-push':
    case 'optimize-scan':
      return scan ? [{
        type: `${job.type}-report`,
        label: `${scan.name} ${job.type} report`,
        metadata: { points: scan.pointCount ?? 0 },
      }] : []
  }
}

async function frameObservationsForScan(scan: ScanManifest, limit = 500): Promise<FrameObservation[]> {
  if (!scan.sessionId) return []

  // "No such session" and "a session that streamed nothing" both used to
  // return [] silently, which is how four scans pointing at a directory that
  // was never created looked exactly like four scans with no keyframes. They
  // are different failures and only one of them is a bug, so say which.
  const dir = await resolveSessionDirFor(scan.sessionId)
  if (!dir) {
    console.warn(
      `[frames] scan ${scan.scanId} names session '${scan.sessionId}', which has no directory under ` +
      `${SESSIONS_DIR}. Its keyframes are unreachable — the id is stale or was never a server session.`,
    )
    return []
  }

  let raw = ''
  try {
    raw = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
  } catch {
    // The session exists and simply streamed nothing. Not an error.
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
  const stored = await listStoredScans().catch(() => [])
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
    projectId: w.projectId ?? null,
    scanCount: w.scans.length,
    scanCountTotal: stored.filter(scan => shouldIncludeStoredScanInWorld(w.projectId ?? null, scan, shouldIncludeInWorld, new Set(w.scans.map(s => s.filename)))).length,
    jobCount: w.jobs.length,
    updatedAt: w.updatedAt,
  })))
})

app.post('/worlds', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: string; shareSlug?: string; projectId?: string | null }
  const slug = safeSlug(body.shareSlug ?? body.name ?? `world-${Date.now()}`)
  const existingPath = worldPath(slug)
  try {
    await Deno.stat(existingPath)
    return c.json({ error: 'World already exists', shareSlug: slug }, 409)
  } catch { /* create */ }
  const { world } = await updateWorld(slug, (world) => {
    // synthesizeWorld already wrote the file; renaming it is a second cycle,
    // so it goes through the lock like every other world mutation.
    if (body.name?.trim()) world.name = body.name.trim()
    if (body.projectId !== undefined) world.projectId = body.projectId
  })
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
  const slug = c.req.param('slug')
  const authWorld = await loadWorld(slug)
  const denied = denyUnlessWorldRole(c, authWorld, 'editor')
  if (denied) return denied
  const actor = activeMemberForToken(authWorld, requestToken(c))
  const body = await c.req.json().catch(() => ({})) as Partial<EditPatch>
  const targetId = objectKey(body.targetId)
  if (!targetId) return c.json({ error: 'targetId is required' }, 400)
  const scope = body.scope ?? 'object'
  if (!['scan', 'object', 'point-selection', 'layer', 'world', 'thing'].includes(scope)) {
    return c.json({ error: 'Invalid patch scope' }, 400)
  }
  const { world, value: patch } = await updateWorld(slug, (world) => {
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
      actorId: actor?.memberId ?? 'local-editor',
      originTargetId: objectKey(body.originTargetId) ?? undefined,
      createdAt: new Date().toISOString(),
    }
    world.editPatches.push(patch)
    applyPatchToWorld(world, patch)
    return patch
  })
  return c.json({ ok: true, patch, world })
})

// ── Place review comments ───────────────────────────────────────────────────
// Comments intentionally have their own immutable collection rather than being
// overloaded into EditPatch notes. A commenter may review a scan without being
// able to alter geometry, processing, or semantic source data.
app.get('/worlds/:slug/comments', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  return c.json([...(world.comments ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
})

app.post('/worlds/:slug/comments', async (c) => {
  const slug = c.req.param('slug')
  const authWorld = await loadWorld(slug)
  const denied = denyUnlessWorldRole(c, authWorld, 'commenter')
  if (denied) return denied
  const actor = activeMemberForToken(authWorld, requestToken(c))
  const body = await c.req.json().catch(() => ({})) as Partial<ReviewComment>
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) return c.json({ error: 'Comment text is required' }, 400)
  if (text.length > 4_000) return c.json({ error: 'Comment must be 4,000 characters or fewer' }, 400)
  const scanId = objectKey(body.scanId) ?? null
  const thingId = objectKey(body.thingId) ?? null
  const areaId = objectKey(body.areaId) ?? null
  if (scanId && !authWorld.scans.some(scan => scan.scanId === scanId)) {
    return c.json({ error: 'Scan not found in this Place' }, 404)
  }
  if (thingId && !authWorld.things.some(thing => thing.thingId === thingId)) {
    return c.json({ error: 'Thing not found in this Place' }, 404)
  }
  const { value: comment } = await updateWorld(slug, (world) => {
    const comment: ReviewComment = {
      commentId: `comment-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      worldId: world.worldId,
      body: text,
      scanId,
      thingId,
      areaId,
      actorId: actor?.memberId ?? 'local-commenter',
      actorRole: actor?.role ?? 'local',
      createdAt: new Date().toISOString(),
    }
    ;(world.comments ??= []).push(comment)
    return comment
  })
  return c.json(comment, 201)
})

app.get('/worlds/:slug/jobs', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  return c.json(world.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
})

app.post('/worlds/:slug/jobs', async (c) => {
  const slug = c.req.param('slug')
  const denied = denyUnlessWorldRole(c, await loadWorld(slug), 'editor')
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
  const { value: job } = await updateWorld(slug, (world) => createWorldJob(world, type, body.scanId, body.payload))
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

type ProjectRecord = Project

function isPlaceType(value: unknown): value is NonNullable<ProjectRecord['placeType']> {
  return value === 'building' || value === 'floor' || value === 'room' || value === 'other'
}

const DEFAULT_PROJECT: ProjectRecord = {
  projectId: 'proj-default',
  name: 'Unassigned',
  createdAt: 0,
  updatedAt: 0,
  floors: [{ floorId: 'floor-default', name: 'Ground Floor', level: 0, rooms: [] }],
  areas: [{ areaId: 'area-default', name: 'Unassigned', kind: 'site', parentAreaId: null }],
}

const PROJECTS_FILE = Deno.env.get('PROJECTS_FILE') ?? './projects.json'
let projectMutationQueue: Promise<void> = Promise.resolve()

/**
 * Existing records stored only floors and rooms. Surface them as a stable Area
 * graph at the API boundary, keeping old captures usable while new UI writes
 * use the more flexible place-area vocabulary.
 */
function withDerivedAreas(project: ProjectRecord): ProjectRecord {
  if (project.areas && project.areas.length > 0) return project
  const rootAreaId = `area-${project.projectId}`
  const areas: NonNullable<ProjectRecord['areas']> = [{
    areaId: rootAreaId,
    name: project.name,
    kind: 'site',
    parentAreaId: null,
  }]
  for (const floor of project.floors) {
    const floorAreaId = `area-${floor.floorId}`
    areas.push({
      areaId: floorAreaId,
      name: floor.name,
      kind: 'floor',
      parentAreaId: rootAreaId,
      floorId: floor.floorId,
    })
    for (const room of floor.rooms) {
      areas.push({
        areaId: `area-${room.roomId}`,
        name: room.name,
        kind: 'room',
        parentAreaId: floorAreaId,
        floorId: floor.floorId,
        roomId: room.roomId,
      })
    }
  }
  return { ...project, areas }
}

/** Reject missing parents and loops before persisting the cross-Place tree. */
function projectHierarchyError(
  projects: ProjectRecord[],
  projectId: string,
  parentProjectId: string | null | undefined,
): string | null {
  if (!parentProjectId) return null
  if (parentProjectId === projectId) return 'A Place cannot contain itself.'

  const byId = new Map(projects.map(project => [project.projectId, project]))
  let cursor = parentProjectId
  const visited = new Set<string>()
  while (cursor) {
    if (cursor === projectId) return 'A Place cannot be linked below one of its descendants.'
    if (visited.has(cursor)) return 'The selected parent hierarchy contains a cycle.'
    visited.add(cursor)
    const parent = byId.get(cursor)
    if (!parent) return 'The selected upper-level Place no longer exists.'
    cursor = parent.parentProjectId ?? ''
  }
  return null
}

async function loadProjects(): Promise<ProjectRecord[]> {
  let projects: ProjectRecord[] = []
  try {
    projects = JSON.parse(await Deno.readTextFile(PROJECTS_FILE)) as ProjectRecord[]
  } catch { /* no registry yet */ }
  if (!projects.some(project => project.projectId === DEFAULT_PROJECT.projectId)) {
    projects.unshift({ ...DEFAULT_PROJECT, floors: DEFAULT_PROJECT.floors.map(floor => ({ ...floor, rooms: [...floor.rooms] })) })
  }
  return projects.map(withDerivedAreas)
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
    placeType?: ProjectRecord['placeType']
    parentProjectId?: string | null
    address?: string
    notes?: string
    geoPose?: ProjectRecord['geoPose']
  }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  if (body.placeType !== undefined && !isPlaceType(body.placeType)) {
    return c.json({ error: 'placeType must be building, floor, room, or other' }, 400)
  }
  const name = body.name.trim()
  const created = await mutateProjects<{ project: ProjectRecord | null; error?: string }>((projects) => {
    const hierarchyError = projectHierarchyError(projects, '', body.parentProjectId)
    if (hierarchyError) return { result: { project: null, error: hierarchyError }, save: false }
    const now = Date.now()
    const project: ProjectRecord = {
      projectId: `proj-${now}`,
      name,
      placeType: body.placeType,
      parentProjectId: body.parentProjectId ?? null,
      address: body.address,
      notes: body.notes,
      geoPose: body.geoPose,
      createdAt: now,
      updatedAt: now,
      areas: [{ areaId: `area-${now}`, name, kind: 'site', parentAreaId: null }],
      floors: [{ floorId: `floor-${now}`, name: 'Ground Floor', level: 0, rooms: [] }],
    }
    projects.push(project)
    return { result: { project }, save: true }
  })
  if (created.error) return c.json({ error: created.error }, 400)
  return c.json(created.project, 201)
})

app.get('/projects/:id/world', async (c) => {
  const projectId = c.req.param('id')
  const project = (await loadProjects()).find(item => item.projectId === projectId)
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const world = await loadProjectWorld(projectId)
  const denied = denyUnlessWorldRole(c, world, 'viewer', { allowAnonymous: true })
  if (denied) return denied
  return c.json(redactWorldForClient(world, requestToken(c)))
})

app.get('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const projects = await loadProjects()
  const project = projects.find(p => p.projectId === id)
  if (!project) return c.json({ error: 'Not found' }, 404)
  return c.json(project)
})

app.patch('/projects/:id/scans/:scanId', async (c) => {
  const projectId = c.req.param('id')
  const scanId = c.req.param('scanId')
  const body = await c.req.json().catch(() => ({})) as { floorId?: string | null; roomId?: string | null; areaId?: string | null }
  const projects = await loadProjects()
  const project = projects.find(p => p.projectId === projectId)
  if (!project) return c.json({ error: 'Project not found' }, 404)
  if (body.floorId && !project.floors.some(floor => floor.floorId === body.floorId)) {
    return c.json({ error: 'Floor not found' }, 404)
  }
  if (body.roomId && !project.floors.some(floor => floor.rooms.some(room => room.roomId === body.roomId))) {
    return c.json({ error: 'Room not found' }, 404)
  }
  if (body.areaId && !(project.areas ?? []).some(area => area.areaId === body.areaId)) {
    return c.json({ error: 'Area not found' }, 404)
  }
  const updated = await rewriteScanProject(scanId, projectId, body.floorId ?? null, body.roomId ?? null, body.areaId ?? null)
  if (!updated) return c.json({ error: 'Scan not found' }, 404)
  return c.json({ ok: true })
})

app.put('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null) as ProjectRecord | null
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)
  if (body.placeType !== undefined && !isPlaceType(body.placeType)) {
    return c.json({ error: 'placeType must be building, floor, room, or other' }, 400)
  }
  const updated = await mutateProjects<{ project: ProjectRecord | null; error?: string }>((projects) => {
    const idx = projects.findIndex(p => p.projectId === id)
    if (idx === -1) return { result: { project: null }, save: false }
    const hierarchyError = projectHierarchyError(projects, id, body.parentProjectId)
    if (hierarchyError) return { result: { project: null, error: hierarchyError }, save: false }
    projects[idx] = { ...body, projectId: id, updatedAt: Date.now() }
    return { result: { project: projects[idx] }, save: true }
  })
  if (updated.error) return c.json({ error: updated.error }, 400)
  if (!updated.project) return c.json({ error: 'Not found' }, 404)
  return c.json(updated.project)
})

/**
 * A Place's calibration reference photos (wave 09 ticket 0007).
 *
 * Bytes live on disk beside the scans rather than inside the Place record:
 * `PUT /projects/:id` round-trips the whole record, so base64 photos would
 * bloat every project read and write. The record keeps only the URL.
 *
 * Multipart shape and validation order are copied from
 * `POST /sessions/:id/keyframes` deliberately — same request shape, same
 * failure vocabulary. Path safety follows `sessionDir()`: shape-check the id
 * first, and derive the filename from the validated role rather than trusting
 * anything in the request.
 */
const PROJECT_MEDIA_DIR = Deno.env.get('PROJECT_MEDIA_DIR') ?? `${SCANS_DIR}/projects`

app.post('/projects/:id/reference-photos', async (c) => {
  const projectId = c.req.param('id')
  const dir = projectMediaDirPath(PROJECT_MEDIA_DIR, projectId)
  if (!dir) return c.json({ error: 'Invalid project id' }, 400)

  const projects = await loadProjects()
  if (!projects.some(p => p.projectId === projectId)) return c.json({ error: 'Project not found' }, 404)

  const form = await c.req.formData()
  const image = form.get('image')
  if (!image || !(image instanceof File)) return c.json({ error: 'Missing image field' }, 400)

  const parsed = parseReferencePhotoMeta(form.get('meta'))
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const meta = parsed.meta

  try {
    const bytes = new Uint8Array(await image.arrayBuffer())
    await Deno.mkdir(dir, { recursive: true })
    const name = referencePhotoFileName(meta.role)
    // One filename per role, so re-calibrating a Place replaces its photos
    // rather than accumulating superseded ones nothing references.
    await Deno.writeFile(`${dir}/${name}`, bytes)
    await Deno.writeTextFile(
      `${dir}/reference-photos.json`,
      JSON.stringify(
        {
          ...(await readReferencePhotoIndex(dir)),
          [meta.role]: { ...meta, file: name, bytes: bytes.byteLength, receivedAt: Date.now() },
        },
        null,
        2,
      ),
    )
    return c.json({ ok: true, role: meta.role, url: referencePhotoUrl(projectId, meta.role) })
  } catch (err) {
    console.error('[project reference-photo error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

async function readReferencePhotoIndex(dir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/reference-photos.json`)) as Record<string, unknown>
  } catch {
    return {}
  }
}

app.get('/projects/:id/reference-photos/:file', async (c) => {
  const dir = projectMediaDirPath(PROJECT_MEDIA_DIR, c.req.param('id'))
  // An allowlist, not a sanitiser: only the two names the POST route can have
  // written resolve at all, so traversal fails by not being on the list.
  const role = roleForReferencePhotoFile(c.req.param('file'))
  if (!dir || !role) return c.json({ error: 'Invalid reference photo path' }, 400)
  try {
    const data = await Deno.readFile(`${dir}/${referencePhotoFileName(role)}`)
    return new Response(data, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return c.json({ error: 'Reference photo not found' }, 404)
  }
})

app.delete('/projects/:id', async (c) => {
  const id = c.req.param('id')
  const scanCount = await countScansForProject(id)
  if (scanCount > 0) return c.json({ error: 'project has scans', scanCount }, 409)
  const deleted = await mutateProjects<{ deleted: boolean; childCount: number }>((projects) => {
    const idx = projects.findIndex(p => p.projectId === id)
    if (idx === -1) return { result: { deleted: false, childCount: 0 }, save: false }
    const childCount = projects.filter(project => project.parentProjectId === id).length
    if (childCount > 0) return { result: { deleted: false, childCount }, save: false }
    projects.splice(idx, 1)
    return { result: { deleted: true, childCount: 0 }, save: true }
  })
  if (deleted.childCount > 0) {
    return c.json({ error: 'project has linked child Places', childCount: deleted.childCount }, 409)
  }
  if (!deleted.deleted) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

app.post('/projects/:id/merge', async (c) => {
  const targetProjectId = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as { sourceProjectId?: string }
  const sourceProjectId = body.sourceProjectId
  if (!sourceProjectId) return c.json({ error: 'sourceProjectId is required' }, 400)
  if (sourceProjectId === targetProjectId) return c.json({ error: 'cannot merge a project into itself' }, 400)

  const merged = await mutateProjects<{ target: ProjectRecord | null; alreadyMerged?: boolean }>((projects) => {
    const target = projects.find(p => p.projectId === targetProjectId) ?? null
    const source = projects.find(p => p.projectId === sourceProjectId) ?? null
    if (!target) return { result: { target: null }, save: false }
    if (!source) return { result: { target, alreadyMerged: true }, save: false }

    const floorIds = new Set(target.floors.map(floor => floor.floorId))
    const roomIds = new Set(target.floors.flatMap(floor => floor.rooms.map(room => room.roomId)))
    const areaIds = new Set((target.areas ?? []).map(area => area.areaId))
    const floorIdMap = new Map<string, string>()
    const roomIdMap = new Map<string, string>()
    const areaIdMap = new Map<string, string>()
    for (const sourceFloor of source.floors) {
      const floorId = floorIds.has(sourceFloor.floorId) ? `floor-${crypto.randomUUID()}` : sourceFloor.floorId
      floorIds.add(floorId)
      floorIdMap.set(sourceFloor.floorId, floorId)
      const rooms = sourceFloor.rooms.map((room) => {
        const roomId = roomIds.has(room.roomId) ? `room-${crypto.randomUUID()}` : room.roomId
        roomIds.add(roomId)
        roomIdMap.set(room.roomId, roomId)
        return { ...room, roomId }
      })
      target.floors.push({ ...sourceFloor, floorId, rooms })
    }

    // Areas were dropped entirely by the original merge — any scan whose
    // areaId pointed into the source Place would reference an area that
    // exists nowhere afterward. Renumber ids on collision first (so
    // parentAreaId remapping below has the final id for every area, source
    // and target alike), then remap each copied area's own references.
    for (const sourceArea of source.areas ?? []) {
      const areaId = areaIds.has(sourceArea.areaId) ? `area-${crypto.randomUUID()}` : sourceArea.areaId
      areaIds.add(areaId)
      areaIdMap.set(sourceArea.areaId, areaId)
    }
    for (const sourceArea of source.areas ?? []) {
      target.areas = [
        ...(target.areas ?? []),
        {
          ...sourceArea,
          areaId: areaIdMap.get(sourceArea.areaId)!,
          parentAreaId: sourceArea.parentAreaId ? (areaIdMap.get(sourceArea.parentAreaId) ?? null) : null,
          floorId: sourceArea.floorId ? (floorIdMap.get(sourceArea.floorId) ?? sourceArea.floorId) : sourceArea.floorId,
          roomId: sourceArea.roomId ? (roomIdMap.get(sourceArea.roomId) ?? sourceArea.roomId) : sourceArea.roomId,
        },
      ]
    }

    // `source` is about to be deleted: any Place that named it as a parent —
    // including `target` itself, if target was a direct child of source —
    // must be repointed, or projectHierarchyError() rejects every later PUT
    // to that Place with "upper-level Place no longer exists".
    for (const project of projects) {
      if (project.projectId === sourceProjectId || project.parentProjectId !== sourceProjectId) continue
      project.parentProjectId = project.projectId === targetProjectId
        ? (source.parentProjectId ?? null) // target adopts source's own parent, not itself
        : targetProjectId
      project.updatedAt = Date.now()
    }

    target.updatedAt = Date.now()
    projects.splice(projects.indexOf(source), 1)
    return { result: { target }, save: true }
  })

  if (!merged.target) return c.json({ error: 'Target project not found' }, 404)
  if (!merged.alreadyMerged) {
    await rewriteProjectReferences(sourceProjectId, targetProjectId)
  }
  return c.json({ ok: true, project: merged.target, alreadyMerged: merged.alreadyMerged ?? false })
})

async function countScansForProject(projectId: string): Promise<number> {
  const scans = await listStoredScans()
  return scans.filter(scan => scanProjectId(scan.meta) === projectId).length
}

async function rewriteScanProject(
  scanId: string,
  projectId: string | null,
  floorId: string | null,
  roomId: string | null,
  areaId: string | null,
): Promise<boolean> {
  let updated = false
  for await (const entry of Deno.readDir(SCANS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.json')) continue
    const path = `${SCANS_DIR}/${entry.name}`
    try {
      const meta = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>
      const filename = entry.name.replace(/\.json$/, '.glb')
      if (scanIdFor(filename) !== scanId && filename !== scanId && asString(meta['sessionId']) !== scanId) continue
      meta['projectId'] = projectId
      meta['floorId'] = floorId
      meta['roomId'] = roomId
      meta['areaId'] = areaId
      await Deno.writeTextFile(path, JSON.stringify(meta, null, 2))
      updated = true
    } catch { /* ignore one malformed sidecar */ }
  }
  if (updated) {
    await mutateWorldFiles((world) => {
      let changed = false
      for (const scan of world.scans) {
        if (scan.scanId !== scanId && scan.filename !== scanId && scan.sessionId !== scanId) continue
        scan.projectId = projectId
        scan.areaId = areaId
        changed = true
      }
      return changed
    })
  }
  return updated
}

async function rewriteProjectReferences(sourceProjectId: string, targetProjectId: string): Promise<void> {
  for await (const entry of Deno.readDir(SCANS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.json')) continue
    const path = `${SCANS_DIR}/${entry.name}`
    try {
      const meta = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>
      if (meta['projectId'] !== sourceProjectId) continue
      meta['projectId'] = targetProjectId
      await Deno.writeTextFile(path, JSON.stringify(meta, null, 2))
    } catch { /* ignore */ }
  }
  await mutateWorldFiles((world) => {
    let changed = false
    if (world.projectId === sourceProjectId) {
      world.projectId = targetProjectId
      changed = true
    }
    for (const scan of world.scans) {
      if (scan.projectId === sourceProjectId) {
        scan.projectId = targetProjectId
        changed = true
      }
    }
    return changed
  })
}

console.log(`[server] CORS origin prefix: ${ALLOWED_ORIGIN_PREFIX}`)

/**
 * WebSocket upgrades bypass CORS entirely — the browser sends the request and
 * hands the socket to the page without a preflight — so without this any page
 * on the internet could open /events or /rtc-signal against the user's machine
 * and watch them scan. Same allowlist as the CORS middleware, deliberately:
 * a non-browser client (no Origin header at all) keeps working as before.
 */
function rejectDisallowedWsOrigin(
  c: { req: { header: (name: string) => string | undefined } },
): Response | null {
  const origin = c.req.header('origin')
  if (!origin || isAllowedOrigin(origin)) return null
  console.warn(`[server] WebSocket upgrade rejected for origin: ${origin}`)
  return new Response('Forbidden origin', { status: 403 })
}

// ── Server event stream — /events ─────────────────────────────────────────────
// Broadcast-only WebSocket: scan uploads, job transitions, session lifecycle.
// The desktop viewer subscribes to refresh its scan list live.

app.get('/events', (c) => {
  const rejected = rejectDisallowedWsOrigin(c)
  if (rejected) return rejected
  const { socket, response } = Deno.upgradeWebSocket(c.req.raw)
  socket.addEventListener('open', () => {
    eventSockets.add(socket)
    // Shim (ADR 0003 / ticket 0004): this "pending jobs" count used to read
    // jobQueue.jobs directly — a fifth JobQueue consumer beyond the four
    // named surfaces, found via this ticket's closing grep and folded into
    // scope here. Same translate-then-count as the other surfaces so the
    // legacy queued|running vocabulary is preserved.
    // Guarded: an unhandled rejection here would terminate the Deno process,
    // so a client that disconnects between 'open' and this send (or a
    // transiently unreadable world file) must not be able to take the server
    // down. The handshake is best-effort — no in-repo listener branches on
    // 'hello', so dropping it degrades nothing.
    void (async () => {
      try {
        const world = await loadWorld('default')
        if (socket.readyState !== WebSocket.OPEN) return
        const pending = world.jobs
          .filter(j => j.type === 'optimize-scan')
          .map(worldJobToLegacyJob)
          .filter(j => j.status === 'queued' || j.status === 'running').length
        socket.send(JSON.stringify({ type: 'hello', jobs: pending }))
      } catch (err) {
        console.error('[events] hello handshake failed:', err)
      }
    })()
  })
  socket.addEventListener('close', () => eventSockets.delete(socket))
  socket.addEventListener('error', () => eventSockets.delete(socket))
  return response
})

// ── Signalling relay — /rtc-signal?room=<id>&role=phone|viewer|capture ───────
//
// One relay, two room shapes (see server/world/rtc_rooms.ts for the rules):
//
//  - `phone` + `viewer` are reserved singleton roles carrying the original 1:1
//    live-preview semantics. Payloads (SDP/ICE) are never inspected.
//  - `capture` is an N-member role used to coordinate a take: several phones
//    recording one subject, exchanging roster/arm/start/stop and the clock-sync
//    probes that ticket 0002 measures an offset from.
//
// Gating is per-role and deliberately split. Live preview stays behind
// VITE_ENABLE_WEBRTC_LIVE because its device-to-editor path is unreliable;
// coordinated capture is the point of the 4D person wave, so it is ungated.
const rtcRooms = new Map<string, RtcRoom>()

app.get('/rtc-signal', (c) => {
  const rejected = rejectDisallowedWsOrigin(c)
  if (rejected) return rejected
  const url = new URL(c.req.url)
  const roleParam = url.searchParams.get('role')
  const role: RtcRole = roleParam === 'phone' ? 'phone' : roleParam === 'capture' ? 'capture' : 'viewer'

  // Per-role gate: the preview pair is experimental, capture is not.
  if (role !== 'capture' && !WEBRTC_LIVE_ENABLED) {
    return c.json({ error: 'WebRTC live streaming is disabled.' }, 404)
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw)
  const roomId = (url.searchParams.get('room') ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '')
  const clientId = url.searchParams.get('clientId')
  const label = url.searchParams.get('label') ?? undefined

  if (!rtcRooms.has(roomId)) rtcRooms.set(roomId, { members: new Map() })
  const room = rtcRooms.get(roomId)!

  const joined = joinRoom(room, role, clientId, socket, label)
  if (!joined.ok) {
    // Refuse explicitly rather than dropping the socket, so the device can say
    // why it could not join instead of showing an unexplained failure.
    socket.addEventListener('open', () => {
      try { socket.send(JSON.stringify({ type: 'join-rejected', reason: joined.reason, message: joined.message })) } catch { /* closed */ }
      try { socket.close() } catch { /* already gone */ }
    })
    return response
  }
  const peer = joined.peer

  // A role has exactly one live socket. Reconnects (and a second editor tab)
  // arrive while the previous socket is still half-open, so the incumbent is
  // closed here rather than silently dropped — otherwise its later close event
  // would delete the peer that replaced it and wedge the room for both sides.
  if (joined.superseded) {
    console.log(`[rtc] ${peer.peerId} reconnected to room "${roomId}" — closing the superseded socket`)
    try { joined.superseded.ws.close() } catch { /* already gone */ }
  }
  console.log(`[rtc] ${role} (${peer.peerId}) joined room "${roomId}"`)

  const announce = () => {
    // The preview handshake is FIRST and is sent only to the preview pair,
    // byte-for-byte as before this endpoint gained take rooms.
    //
    // This ordering is load-bearing, not cosmetic: `mock-rtc-room.spec.ts`
    // asserts on the *first* frame a joining viewer receives, and a roster sent
    // ahead of `peer-ready` silently broke the live feed's rendezvous. The
    // roster is a take concept — a phone/viewer preview pair has no use for one
    // — so it goes only to capture members.
    if (previewPairReady(room)) {
      sendAll(
        [...room.members.values()].filter(p => p.role === 'phone' || p.role === 'viewer'),
        { type: 'peer-ready' },
      )
    }
    const capture = [...room.members.values()].filter(p => p.role === 'capture')
    if (capture.length > 0) {
      sendAll(capture, { type: 'roster', room: roomId, members: roster(room) })
    }
  }

  socket.addEventListener('open', () => announce())
  if (socket.readyState === WS_OPEN) announce()

  socket.addEventListener('message', (ev) => {
    const raw = ev.data as string

    // Clock-sync probes are answered here rather than relayed: the server's
    // clock is the shared reference every member estimates an offset against,
    // and a peer-relayed reply would measure the wrong path. Everything else is
    // forwarded without inspection, exactly as before.
    if (typeof raw === 'string' && raw.includes('"sync-ping"')) {
      try {
        const msg = JSON.parse(raw) as Record<string, unknown>
        if (msg['type'] === 'sync-ping') {
          const serverTime = Date.now()
          try {
            socket.send(JSON.stringify({ type: 'sync-pong', id: msg['id'] ?? null, t1: serverTime, t2: Date.now() }))
          } catch { /* closing */ }
          return
        }
      } catch { /* fall through to relay */ }
    }

    for (const other of relayTargets(room, peer)) {
      try { other.ws.send(raw) } catch { /* other peer closed */ }
    }
  })

  socket.addEventListener('close', () => {
    // Only the socket that currently holds the slot may clear it. A superseded
    // socket closing after its replacement registered must not evict the live
    // peer, nor tell the others that this member has left when it has not.
    if (!leaveRoom(room, peer)) {
      console.log(`[rtc] superseded ${role} socket closed in room "${roomId}" — live peer kept`)
      return
    }
    console.log(`[rtc] ${role} (${peer.peerId}) left room "${roomId}"`)
    if (room.members.size === 0) {
      rtcRooms.delete(roomId)
      return
    }
    // Same rule on departure: roster to capture members only, so the preview
    // pair's message stream is exactly what it was.
    const capture = [...room.members.values()].filter(p => p.role === 'capture')
    if (capture.length > 0) {
      sendAll(capture, { type: 'roster', room: roomId, members: roster(room) })
    }
    if (role === 'phone' || role === 'viewer') {
      sendAll(
        [...room.members.values()].filter(p => p.role === 'phone' || p.role === 'viewer'),
        { type: 'peer-left', role },
      )
    }
  })

  return response
})

// ── "Sign in with Companion Account" (CI-Portal OIDC) ────────────────────────
// Inert unless PORTAL_OIDC_ENABLED=1 — see portal_auth.ts for the flow and env.
// A successful, allowlisted sign-in lands on the default world's owner link,
// so the existing member-token authz stays the single authorization mechanism.
registerPortalAuth(app, portalAuthConfig(), {
  ownerDestination: async () => {
    const world = await loadWorld('default')
    const owner = world.members.find((m) => m.role === 'owner' && !m.revokedAt)
    if (!owner) return '/editor?world=default'
    return `/editor?world=${world.shareSlug}&token=${encodeURIComponent(owner.token)}`
  },
})

// ── Companion Memory (CI-Server) ────────────────────────────────────────────
// Exposes GET /memory/status. The push itself runs as the 'memory-push' world
// job; inert until the Hub connects Companion Memory (or CI_SERVER_URL +
// CI_SERVER_TOKEN are set by hand). See memory_push.ts.
registerMemoryPush(app, memoryPushCfg, {
  probe: async (cfg) => {
    try {
      const resp = await fetch(`${cfg.baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'x-api-key': cfg.token, 'Content-Type': 'application/json' },
        // An empty batch is rejected by the schema (min 1) without writing
        // anything — a 4xx that is not 401/403 proves creds reach the API.
        body: JSON.stringify({ events: [] }),
        signal: AbortSignal.timeout(5_000),
      })
      return resp.status !== 401 && resp.status !== 403 && resp.status < 500
    } catch {
      return false
    }
  },
})

// ── Static viewer bundle (production) ────────────────────────────────────────
// In dev, the viewer is served by Vite. In production (Docker / Hub install)
// the pre-built static bundle is copied to STATIC_DIR; serve it as a
// fall-through so a single container port hosts both UI and API. When
// STATIC_DIR is unset/absent the route stays a 404, which is the dev behaviour.
const STATIC_DIR = Deno.env.get('STATIC_DIR') ?? './dist'
let staticAvailable = false
try {
  const s = await Deno.stat(STATIC_DIR)
  staticAvailable = s.isDirectory
} catch { /* no dist — fine in dev */ }

if (staticAvailable) {
  const STATIC_MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wasm': 'application/wasm',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
  }
  console.log(`[server] serving static bundle from ${STATIC_DIR}`)
  app.get('*', async (c) => {
    let p = new URL(c.req.url).pathname
    if (p === '/') p = '/index.html'
    if (p === '/editor' || p === '/editor/') p = '/viewer.html'
    if (p.includes('..')) return c.notFound()
    const file = `${STATIC_DIR}${p}`
    try {
      const bytes = await Deno.readFile(file)
      const ext = p.slice(p.lastIndexOf('.'))
      return new Response(bytes, {
        headers: {
          'Content-Type': STATIC_MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        },
      })
    } catch {
      return c.notFound()
    }
  })
}

// Boot-time crash recovery (ADR 0003 "Crash recovery") — called once, after
// every module-level const/function this module's job dispatch chain
// depends on has been initialized (see the comment where `worldJobPump` is
// constructed, above, for why this can't run any earlier), and before the
// server starts accepting requests.
await recoverWorldJobsOnBoot()

Deno.serve({ hostname: '0.0.0.0', port: PORT }, app.fetch)
