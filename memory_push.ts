/**
 * memory_push.ts — push a finished scan into Companion Memory (CI-Server).
 *
 * A scan is spatial memory: a room, when it was captured, where it is on Earth,
 * and what was found in it. This module ships that to the user's Companion
 * Memory appliance so it is recallable alongside the rest of their digital life.
 *
 * Wiring (CI-Hub marketplace install): the app declares
 *   "hub_integration": { "memory": { "url_env": "CI_SERVER_URL",
 *                                    "token_env": "CI_SERVER_TOKEN",
 *                                    "url_style": "api_base" } }
 * and the Hub injects the resolved Companion Memory API base plus a minted,
 * memory-scoped API key once the user connects the app. Inert until both are
 * present, so a stock install (and every existing deployment) is unaffected.
 *
 * Why an API key and not our Portal token: CI-Server's PORTAL_OIDC_AUDIENCE
 * allowlist is `ci-server,ci-hub,ci-import-tools,ci-browser-extension` — a
 * Portal JWT minted for `aud: ci-web-xr-scan` is rejected at jwtVerify. The
 * brokered key (sent as `x-api-key`) is the supported path for a third-party
 * app, matching how CI-Import-Tools pushes.
 *
 * URL shape: CI_SERVER_URL is the **API base** (`http://gateway:8642/api`).
 * The gateway rewrites `^/api/(.*)$ → /$1` and CI-Server sets no global route
 * prefix, so `${base}/v1/events` lands on the events controller. Do not "fix"
 * this by stripping /api — an operator-supplied external URL is passed through
 * verbatim and only the Hub knows whether a value is the brokered address.
 *
 * Wire contract (CI-Server main):
 *   POST {base}/files/upload   multipart field `files` → 200 [{ id }]
 *   POST {base}/v1/events      { events: [CaptureEvent] } → { ingested, duplicate, rejected }
 * Idempotency is (source_system, source_id); re-pushing a scan counts as
 * `duplicate` rather than erroring, so a retried job is safe.
 */
import type { Context, Hono } from 'hono'
import type { GeoPose, ScanManifest } from './src/world/types.ts'

// ── Config ────────────────────────────────────────────────────────────────────

export interface MemoryPushConfig {
  /** True only when both a base URL and a token are present. */
  enabled: boolean
  /** Companion Memory API base, e.g. http://gateway:8642/api (no trailing slash). */
  baseUrl: string
  /** Memory-scoped API key, sent as `x-api-key`. */
  token: string
  /** `source_system` on every ingested event — the idempotency namespace. */
  sourceSystem: string
  /** Per-request timeout in ms. */
  timeoutMs: number
  /** Refuse to upload a GLB larger than this (bytes); the event still goes. */
  maxUploadBytes: number
}

export function configFromEnv(env: (k: string) => string | undefined = Deno.env.get): MemoryPushConfig {
  const baseUrl = (env('CI_SERVER_URL') ?? '').trim().replace(/\/+$/, '')
  const token = (env('CI_SERVER_TOKEN') ?? '').trim()
  const maxRaw = Number(env('MEMORY_PUSH_MAX_UPLOAD_BYTES') ?? '')
  const timeoutRaw = Number(env('MEMORY_PUSH_TIMEOUT_MS') ?? '')
  return {
    enabled: baseUrl.length > 0 && token.length > 0,
    baseUrl,
    token,
    sourceSystem: (env('MEMORY_PUSH_SOURCE_SYSTEM') ?? 'companion-scan').trim() || 'companion-scan',
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 120_000,
    // CI-Server accepts up to 10 GiB; cap far lower by default — a room scan is
    // megabytes, and a runaway file would otherwise stall the job for minutes.
    maxUploadBytes: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 512 * 1024 * 1024,
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** One detected object from the `<base>.interactions.json` sidecar. */
interface DetectedObject {
  label?: string
  position?: { x: number; y: number; z: number }
}

export interface MemoryPushResult {
  /** CI-Server file id for the uploaded GLB, or null when it was skipped. */
  glbFileId: string | null
  /** Why the GLB upload was skipped, when it was. */
  glbSkippedReason?: string
  eventIngested: number
  eventDuplicate: number
  detectionCount: number
  /** The `source_id` used — stable per scan, so re-pushes dedupe. */
  sourceId: string
}

export interface PushDeps {
  scansDir: string
  readFile?: (path: string) => Promise<Uint8Array>
  readTextFile?: (path: string) => Promise<string>
  fetch?: typeof fetch
}

// ── Core push ─────────────────────────────────────────────────────────────────

function authHeaders(cfg: MemoryPushConfig): Record<string, string> {
  return { 'x-api-key': cfg.token }
}

/** Strip the token out of anything we log or return to a client. */
function redact(text: string, cfg: MemoryPushConfig): string {
  if (!cfg.token) return text
  return text.split(cfg.token).join('«redacted»')
}

/** Human-readable one-liner for the memory event title. */
function scanTitle(scan: Pick<ScanManifest, 'name' | 'scanId'>, geo: GeoPose | null | undefined): string {
  const place = geo?.address ?? geo?.displayAddress
  const base = scan.name?.trim() || scan.scanId
  return place ? `Scanned ${base} — ${place}` : `Scanned ${base}`
}

/**
 * Upload the scan's GLB, then record a `capture.scan` event describing the room.
 *
 * Failure policy: the event is the memory; the mesh is an attachment. If the
 * upload fails or the file is missing/oversized we still record the event (with
 * a skip reason) rather than losing the capture entirely.
 */
export async function pushScanToMemory(
  cfg: MemoryPushConfig,
  scan: ScanManifest,
  deps: PushDeps,
): Promise<MemoryPushResult> {
  if (!cfg.enabled) throw new Error('Companion Memory is not configured (CI_SERVER_URL / CI_SERVER_TOKEN)')

  const doFetch = deps.fetch ?? fetch
  const readFile = deps.readFile ?? Deno.readFile
  const readTextFile = deps.readTextFile ?? Deno.readTextFile
  const sourceId = scan.scanId

  // 1. GLB → POST {base}/files/upload (multipart field `files`).
  let glbFileId: string | null = null
  let glbSkippedReason: string | undefined
  const glbPath = `${deps.scansDir}/${scan.filename}`
  try {
    const bytes = await readFile(glbPath)
    if (bytes.byteLength > cfg.maxUploadBytes) {
      glbSkippedReason = `glb is ${bytes.byteLength} bytes, over the ${cfg.maxUploadBytes} limit`
    } else {
      const form = new FormData()
      // Deno.readFile hands back an ArrayBuffer-backed view, but its type is
      // widened to ArrayBufferLike (which BlobPart rejects). Cast rather than
      // copy — a re-alloc would double peak memory on a large mesh.
      const part = bytes as unknown as BlobPart
      form.append('files', new File([part], scan.filename, { type: 'model/gltf-binary' }))
      // The mesh has no text for the vision model to describe; skip that work.
      form.append('skipDescription', 'true')
      const resp = await doFetch(`${cfg.baseUrl}/files/upload`, {
        method: 'POST',
        headers: authHeaders(cfg),
        body: form,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
      if (!resp.ok) {
        glbSkippedReason = `upload failed (HTTP ${resp.status})`
        console.error(`[memory-push] GLB upload failed: ${resp.status} ${redact(await resp.text().catch(() => ''), cfg).slice(0, 300)}`)
      } else {
        const uploaded = await resp.json().catch(() => null) as Array<{ id?: string }> | null
        glbFileId = uploaded?.[0]?.id ?? null
        if (!glbFileId) glbSkippedReason = 'upload returned no file id'
      }
    }
  } catch (err) {
    glbSkippedReason = err instanceof Error && err.name === 'NotFound'
      ? 'glb not found on disk'
      : `upload error: ${redact(String(err), cfg).slice(0, 200)}`
    console.warn(`[memory-push] ${glbSkippedReason} (${glbPath})`)
  }

  // 2. Detections sidecar (written by the splat-detect job) — optional.
  let detections: DetectedObject[] = []
  const base = scan.filename.replace(/\.glb$/i, '')
  try {
    const raw = await readTextFile(`${deps.scansDir}/${base}.interactions.json`)
    const parsed = JSON.parse(raw) as { objects?: DetectedObject[] }
    if (Array.isArray(parsed.objects)) detections = parsed.objects
  } catch { /* no detections yet — a scan is still a memory without them */ }

  const labels = [...new Set(
    detections.map((d) => (d.label ?? '').trim()).filter(Boolean),
  )].sort()

  // 3. The event. CaptureEvent has no top-level geo column on this endpoint —
  // the controller folds `payload` into event.metadata — so location travels in
  // the payload and is queryable as metadata JSON.
  const geo = scan.geoPose ?? null
  const occurredAt = scan.capturedAt ?? new Date().toISOString()
  const descriptionParts = [
    geo?.address ? `Location: ${geo.address}.` : null,
    typeof scan.pointCount === 'number' ? `${scan.pointCount.toLocaleString()} points.` : null,
    labels.length ? `Detected: ${labels.join(', ')}.` : null,
  ].filter(Boolean)

  const event = {
    source_system: cfg.sourceSystem,
    source_id: sourceId,
    kind: 'capture.scan',
    occurred_at: occurredAt,
    title: scanTitle(scan, geo),
    description: descriptionParts.join(' ') || 'A 3D room scan.',
    payload: {
      scan_id: scan.scanId,
      session_id: scan.sessionId ?? null,
      glb_filename: scan.filename,
      glb_file_id: glbFileId,
      file_ids: glbFileId ? [glbFileId] : [],
      point_count: scan.pointCount ?? null,
      detection_count: detections.length || scan.detectionCount || 0,
      detected_labels: labels,
      objects: detections
        .filter((d) => d.label && d.position)
        .map((d) => ({ label: d.label, position: d.position })),
      // Flat lat/lon mirrors the shape the (draft) unified capture spec uses,
      // so this payload can be promoted to real geo columns without a migration.
      location: geo
        ? {
          lat: geo.lat ?? null,
          lon: geo.lng ?? null,
          address: geo.address ?? null,
          display_address: geo.displayAddress ?? null,
          bearing: geo.bearing ?? null,
          accuracy_m: geo.accuracyM ?? null,
        }
        : null,
      ...(glbSkippedReason ? { glb_skipped_reason: glbSkippedReason } : {}),
    },
  }

  const evResp = await doFetch(`${cfg.baseUrl}/v1/events`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  if (!evResp.ok) {
    const body = redact(await evResp.text().catch(() => ''), cfg).slice(0, 300)
    throw new Error(`Companion Memory rejected the scan event (HTTP ${evResp.status}): ${body}`)
  }
  const ingest = await evResp.json().catch(() => null) as
    | { ingested?: number; duplicate?: number; rejected?: Array<{ reason?: string }> }
    | null
  if (ingest?.rejected?.length) {
    throw new Error(`Companion Memory rejected the scan event: ${ingest.rejected[0]?.reason ?? 'unknown reason'}`)
  }

  return {
    glbFileId,
    ...(glbSkippedReason ? { glbSkippedReason } : {}),
    eventIngested: ingest?.ingested ?? 0,
    eventDuplicate: ingest?.duplicate ?? 0,
    detectionCount: detections.length,
    sourceId,
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export interface MemoryPushDeps {
  /** Reachability probe against the configured Companion Memory. */
  probe?: (cfg: MemoryPushConfig) => Promise<boolean>
}

/**
 * Registers `GET /memory/status` so the editor (and a human debugging an
 * install) can tell whether Companion Memory is wired up, without exposing the
 * token. Always registered — a disabled install must be able to say so.
 */
export function registerMemoryPush(app: Hono, cfg: MemoryPushConfig, deps: MemoryPushDeps = {}) {
  if (cfg.enabled) {
    console.log(`[memory-push] Companion Memory push enabled (${cfg.baseUrl}, source_system=${cfg.sourceSystem})`)
  }

  app.get('/memory/status', async (c: Context) => {
    if (!cfg.enabled) {
      return c.json({
        enabled: false,
        reason: 'Set CI_SERVER_URL and CI_SERVER_TOKEN, or connect Companion Memory from the Hub.',
      })
    }
    let reachable: boolean | null = null
    if (deps.probe) reachable = await deps.probe(cfg).catch(() => false)
    return c.json({
      enabled: true,
      baseUrl: cfg.baseUrl,
      sourceSystem: cfg.sourceSystem,
      ...(reachable === null ? {} : { reachable }),
    })
  })
}
