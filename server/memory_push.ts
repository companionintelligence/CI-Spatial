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
 *
 * Each detected object travels as a full oriented box — centre, orientation,
 * 3D extent (metres and whole millimetres), detector confidence and vote count
 * — qualified by a sibling `object_extents` block naming its frame of
 * reference and the detector's parameters. See "Detected objects" below for why
 * both halves are mandatory.
 *
 * What a scan ships as, in one place — a Place with Things in it:
 *   glb_file_id / glb_filename   the mesh, uploaded as an attachment
 *   splat                        the trained Gaussian splat: one uploaded
 *                                artifact plus a reference to every encoding
 *                                that exists on disk (see "Splat artifacts")
 *   spatial_frame                what makes any of the above metric — the
 *                                Umeyama fit out of SfM space into the Place's
 *                                project frame (see "Spatial frame")
 *   objects / object_extents     splat_analyzer's oriented boxes, in the splat
 *                                frame, plus that same box's pose and size in
 *                                the project frame when the frame above says a
 *                                length can be converted at all
 *   mesh_objects                 the VLM detections gltf.ts recorded during
 *                                capture: label, world position, confidence
 *   location                     where on Earth the whole thing sits
 */
import type { Context, Hono } from 'hono'
import type {
  GeoPose,
  Quat,
  ScanManifest,
  SplatAlignManifest,
  SplatDetectManifest,
  SplatFinishManifest,
  SplatTrainManifest,
  Vec3,
} from '../src/world/types.ts'
import { type DetectObjectRecord, parseDetectRecords } from '../src/world/detect-objects.ts'

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
  /**
   * Refuse to upload any attachment larger than this (bytes) — the GLB and the
   * splat artifacts share the one cap. The event still goes, carrying the
   * filename and size of whatever was too big to send.
   */
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

export interface MemoryPushResult {
  /** CI-Server file id for the uploaded GLB, or null when it was skipped. */
  glbFileId: string | null
  /** Why the GLB upload was skipped, when it was. */
  glbSkippedReason?: string
  eventIngested: number
  eventDuplicate: number
  detectionCount: number
  /** How many of those detections shipped a 3D extent (the rest are label + position only). */
  extentCount: number
  /** Splat artifacts referenced in the payload (found on disk), uploaded or not. */
  splatArtifactCount: number
  /** CI-Server file ids for the splat artifacts that were uploaded — at most one per push. */
  splatFileIds: string[]
  /** True only when a splat→project fit shipped that is trustworthy enough to convert lengths. */
  spatialFrameMetric: boolean
  /** Capture-time VLM detections shipped with a real world position. */
  meshObjectCount: number
  /** The `source_id` used — stable per scan, so re-pushes dedupe. */
  sourceId: string
}

export interface PushDeps {
  scansDir: string
  readFile?: (path: string) => Promise<Uint8Array>
  readTextFile?: (path: string) => Promise<string>
  /**
   * Size of a file without reading it. Splat artifacts run to hundreds of
   * megabytes and most of them are only ever *referenced*, so the size that
   * decides upload-or-reference must not cost a full read first.
   */
  statFile?: (path: string) => Promise<{ size: number }>
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

// ── Uploads ───────────────────────────────────────────────────────────────────
//
// Every attachment — the GLB, and the splat artifact below it — goes through
// this one function against POST {base}/files/upload. One mechanism on purpose
// (ADR 0001): a second would carry its own size cap, its own auth header, and
// its own way of being wrong, and MEMORY_PUSH_MAX_UPLOAD_BYTES would then mean
// two different things depending on which artifact you asked about.

interface UploadOutcome {
  /** CI-Server file id, or null when the upload did not happen or produced none. */
  id: string | null
  /** Why there is no id. Never thrown: an attachment must not cost the memory. */
  skippedReason?: string
}

/** One wording for "too big", whichever artifact hit the cap. */
function overLimitReason(label: string, bytes: number, cfg: MemoryPushConfig): string {
  return `${label} is ${bytes} bytes, over the ${cfg.maxUploadBytes} limit`
}

async function uploadFile(
  cfg: MemoryPushConfig,
  doFetch: typeof fetch,
  file: { name: string; label: string; bytes: Uint8Array; mime: string },
): Promise<UploadOutcome> {
  if (file.bytes.byteLength > cfg.maxUploadBytes) {
    return { id: null, skippedReason: overLimitReason(file.label, file.bytes.byteLength, cfg) }
  }
  const form = new FormData()
  // Deno.readFile hands back an ArrayBuffer-backed view, but its type is
  // widened to ArrayBufferLike (which BlobPart rejects). Cast rather than
  // copy — a re-alloc would double peak memory on a large mesh or splat.
  const part = file.bytes as unknown as BlobPart
  form.append('files', new File([part], file.name, { type: file.mime }))
  // Binary geometry has no text for the vision model to describe; skip that work.
  form.append('skipDescription', 'true')
  const resp = await doFetch(`${cfg.baseUrl}/files/upload`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: form,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  if (!resp.ok) {
    const body = redact(await resp.text().catch(() => ''), cfg).slice(0, 300)
    console.error(`[memory-push] ${file.label} upload failed: ${resp.status} ${body}`)
    return { id: null, skippedReason: `upload failed (HTTP ${resp.status})` }
  }
  const uploaded = await resp.json().catch(() => null) as Array<{ id?: string }> | null
  const id = uploaded?.[0]?.id ?? null
  return id ? { id } : { id: null, skippedReason: 'upload returned no file id' }
}

/** Read a pipeline-stage manifest sidecar, or null when it is absent or unreadable. */
async function readManifest<T>(
  readTextFile: (path: string) => Promise<string>,
  path: string,
): Promise<T | null> {
  try {
    const parsed = JSON.parse(await readTextFile(path)) as T | null
    // `typeof [] === 'object'`, so an array would sail through and be read as a
    // manifest whose every field is undefined — indistinguishable downstream
    // from a stage that ran and recorded nothing. A sidecar holding `[]` is a
    // sidecar this module cannot read, which is what `null` means here.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    // No such stage ran, or the sidecar predates/postdates this shape. Either
    // way the scan is still a memory — nothing here is required.
    return null
  }
}

// ── Splat artifacts ───────────────────────────────────────────────────────────
//
// A trained splat is the richest thing a scan produces — the mesh is a
// simplification of it — and it lands beside the scan in three encodings of the
// *same* radiance field:
//
//   <base>.splat.ply        raw INRIA 3DGS export from Brush (hundreds of MB)
//   <base>.compressed.ply   SuperSplat compressed PLY   (splat-finish)
//   <base>.sog              web-deliverable SOG bundle  (splat-finish, smallest)
//
// So exactly one is uploaded — the first that fits the cap in that reverse
// order, smallest first — and the others travel as filename + size, still
// served by the appliance from /scans/<filename>. Uploading all three would
// triple the transfer to say the same thing three times, and the raw PLY can
// outrun the request timeout on its own.

type SplatArtifactKind = 'sog' | 'compressed_ply' | 'splat_ply'

interface SplatArtifact {
  kind: SplatArtifactKind
  filename: string
  /** Size on disk, from stat. Null only if stat reported something non-numeric. */
  bytes: number | null
  fileId: string | null
  skippedReason?: string
}

/** Splats are opaque binaries to CI-Server's uploader, same as every non-glTF blob. */
const SPLAT_MIME = 'application/octet-stream'

/**
 * Which splat artifacts actually exist for this scan, in delivery-preference
 * order.
 *
 * Names come from the train/finish manifests when those ran, and from the
 * conventional `<base>.<suffix>` names when they did not (a hand-placed splat,
 * or a manifest written before this module existed) — but an artifact is only
 * referenced once `stat` says the file is there. A manifest records what a run
 * *produced*; only the filesystem knows what survived, and shipping a filename
 * the disk does not have hands the consumer a 404 dressed as a reference.
 */
async function discoverSplatArtifacts(
  base: string,
  scansDir: string,
  statFile: (path: string) => Promise<{ size: number }>,
  train: SplatTrainManifest | null,
  finish: SplatFinishManifest | null,
): Promise<SplatArtifact[]> {
  const candidates: Array<{ kind: SplatArtifactKind; filename: string }> = []
  const add = (kind: SplatArtifactKind, value: string | null | undefined) => {
    if (!value) return
    // Manifests store basenames relative to SCANS_DIR; take the last segment
    // anyway so a manifest that recorded a path cannot walk out of the dir.
    const filename = value.split('/').pop() ?? ''
    if (!filename || filename.startsWith('.') || candidates.some((c) => c.filename === filename)) return
    candidates.push({ kind, filename })
  }
  add('sog', finish?.sogPath)
  add('sog', `${base}.sog`)
  add('compressed_ply', finish?.compressedPlyPath)
  add('compressed_ply', train?.compressedPlyPath)
  add('compressed_ply', `${base}.compressed.ply`)
  add('splat_ply', train?.plyPath)
  add('splat_ply', `${base}.splat.ply`)

  const found: SplatArtifact[] = []
  for (const c of candidates) {
    let bytes: number | null = null
    try {
      const info = await statFile(`${scansDir}/${c.filename}`)
      bytes = typeof info?.size === 'number' ? info.size : null
    } catch {
      continue // not on disk
    }
    found.push({ kind: c.kind, filename: c.filename, bytes, fileId: null })
  }
  return found
}

/**
 * Attach the best splat we have, mutating the chosen artifact in place with its
 * file id or the reason there isn't one.
 *
 * Best-effort exactly like the GLB: an oversized, missing or rejected splat
 * leaves a reason on the reference and nothing else — the event still records
 * the capture.
 */
async function attachSplatArtifact(
  cfg: MemoryPushConfig,
  doFetch: typeof fetch,
  readFile: (path: string) => Promise<Uint8Array>,
  scansDir: string,
  artifacts: SplatArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.bytes !== null && artifact.bytes > cfg.maxUploadBytes) {
      // Too big to send, but still worth naming — try the next encoding, which
      // is the reason the preference order runs smallest-first.
      artifact.skippedReason = overLimitReason(artifact.filename, artifact.bytes, cfg)
      continue
    }
    try {
      const bytes = await readFile(`${scansDir}/${artifact.filename}`)
      const out = await uploadFile(cfg, doFetch, {
        name: artifact.filename,
        label: artifact.filename,
        bytes,
        mime: SPLAT_MIME,
      })
      artifact.fileId = out.id
      if (out.skippedReason) artifact.skippedReason = out.skippedReason
    } catch (err) {
      artifact.skippedReason = `upload error: ${redact(String(err), cfg).slice(0, 200)}`
      console.warn(`[memory-push] splat ${artifact.filename}: ${artifact.skippedReason}`)
    }
    // One attempt, whatever came of it. A server that refused the smallest
    // encoding will not be talked into the 400 MB one.
    return
  }
}

/** One artifact on the wire. A null `file_id` means "on the appliance, not attached here". */
function splatArtifactWire(a: SplatArtifact) {
  return {
    kind: a.kind,
    filename: a.filename,
    ...(a.bytes !== null ? { bytes: a.bytes } : {}),
    file_id: a.fileId,
    ...(a.skippedReason ? { skipped_reason: a.skippedReason } : {}),
  }
}

/**
 * The splat block: what was trained, what it was finished into, and where each
 * encoding is. Counts come off the manifests rather than being recomputed —
 * nothing here opens a PLY.
 */
function splatBlock(
  train: SplatTrainManifest | null,
  finish: SplatFinishManifest | null,
  artifacts: SplatArtifact[],
) {
  return {
    artifacts: artifacts.map(splatArtifactWire),
    /** Gaussians in the trained PLY — the splat's own "point count". */
    gaussian_count: train?.gaussianCount ?? null,
    /** Keyframes the trainer was fed. */
    frame_count: train?.frameCount ?? null,
    train_tool: train?.tool ?? null,
    train_status: train?.status ?? null,
    trained_at: train?.createdAt ?? null,
    finish_tool: finish?.tool ?? null,
    finish_status: finish?.status ?? null,
    finished_at: finish?.createdAt ?? null,
  }
}

// ── Spatial frame ─────────────────────────────────────────────────────────────
//
// Structure-from-motion reconstructs only up to an unknown scale: the splat's
// own numbers have no metres in them, sit at an arbitrary origin, and point an
// arbitrary way. The `splat-align` job's Umeyama fit (SplatAlignManifest) is
// what supplies the missing seven degrees of freedom, and its `scale` is the
// single field that makes any downstream distance real.
//
// Per ADR 0005 rule 3 a status claiming verification must be backed by a
// measurement, so nothing here is converted into metres unless the fit reports
// a residual *and* that residual is inside the tolerance the fit itself was run
// with. A fit that converged badly is a wrong answer, not a rounded one.

interface MetricFit {
  scale: number
  /**
   * Row-major 4x4 splat→project, or null when the manifest carried none — or
   * carried one whose 3x3 block is not a uniform scale times a *proper*
   * rotation. A sheared, non-uniform or reflected block can still move a point,
   * but it has no single rotation to hand an orientation, and a position that
   * made the trip beside a quaternion that did not is one pose in two frames.
   * So the whole transform is dropped rather than half-applied.
   */
  transform: number[] | null
  /**
   * That transform's rotation as an xyzw quaternion. Non-null exactly when
   * `transform` is — they are extracted together or not at all.
   */
  rotationQuat: Quat | null
  residualM: number
}

/** A 16-number row-major matrix, or null. Anything else is not a transform. */
function matrix16(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 16) return null
  return value.every((n) => typeof n === 'number' && Number.isFinite(n)) ? value as number[] : null
}

/**
 * The fit, only if it may be trusted to convert a length. Every gate here is a
 * number the aligner itself recorded — none of them is a default standing in
 * for a measurement that was never made.
 */
function metricFit(align: SplatAlignManifest | null): MetricFit | null {
  if (!align || align.status !== 'ok') return null
  const params = align.params ?? ({} as SplatAlignManifest['params'])
  const scale = align.scale
  const residualM = align.residualM
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return null
  // No residual means the fit never reported how wrong it is; that is not a
  // pass, so it does not become metres.
  if (typeof residualM !== 'number' || !Number.isFinite(residualM)) return null
  if (typeof params.maxResidualM === 'number' && residualM > params.maxResidualM) return null
  if (typeof params.minCorrespondences === 'number' && (align.correspondenceCount ?? 0) < params.minCorrespondences) {
    return null
  }
  const transform = matrix16(align.projectTransform)
  const rotationQuat = transform ? similarityRotationQuat(transform) : null
  return { scale, transform: rotationQuat ? transform : null, rotationQuat, residualM }
}

/**
 * The rotation inside a similarity's 3x3 block, as an xyzw quaternion, or null
 * when the block is not one.
 *
 * `projectTransform` is s·R — splat-align folds the Umeyama scale into the
 * rotation — so each row has length s and R is the block with its rows
 * normalised. Every step of that is checked rather than assumed, because this
 * matrix arrives as sixteen numbers from a sidecar on disk: the row lengths
 * must agree (a non-uniform scale has no single s), the rows must be mutually
 * orthogonal (a shear has no rotation to extract), and the determinant must be
 * positive (no quaternion represents a reflection). Failing any of them the
 * caller ships no project-frame pose at all, which is the honest answer;
 * shipping a quaternion derived from a matrix that is not a rotation would be
 * a plausible-looking wrong orientation.
 */
function similarityRotationQuat(m: number[]): Quat | null {
  const rows: Vec3[] = [
    { x: m[0], y: m[1], z: m[2] },
    { x: m[4], y: m[5], z: m[6] },
    { x: m[8], y: m[9], z: m[10] },
  ]
  const lengths = rows.map((r) => Math.hypot(r.x, r.y, r.z))
  const min = Math.min(...lengths)
  const max = Math.max(...lengths)
  // 1e-6 relative: far tighter than any non-uniform scale worth the name, far
  // looser than the rounding in a matrix that was built as s·R.
  if (!(min > 0) || (max - min) / max > 1e-6) return null

  const [a, b, c] = rows.map((r, i) => ({ x: r.x / lengths[i], y: r.y / lengths[i], z: r.z / lengths[i] }))
  const dot = (p: Vec3, q: Vec3) => p.x * q.x + p.y * q.y + p.z * q.z
  if (Math.abs(dot(a, b)) > 1e-6 || Math.abs(dot(a, c)) > 1e-6 || Math.abs(dot(b, c)) > 1e-6) return null
  // det = a · (b × c) for a row-major matrix with these rows.
  const det = a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)
  if (!(det > 0)) return null

  // Shepperd's method: pick the branch whose denominator is largest, so the
  // division never happens near zero.
  const trace = a.x + b.y + c.z
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return { x: (c.y - b.z) / s, y: (a.z - c.x) / s, z: (b.x - a.y) / s, w: 0.25 * s }
  }
  if (a.x > b.y && a.x > c.z) {
    const s = Math.sqrt(1 + a.x - b.y - c.z) * 2
    return { x: 0.25 * s, y: (a.y + b.x) / s, z: (a.z + c.x) / s, w: (c.y - b.z) / s }
  }
  if (b.y > c.z) {
    const s = Math.sqrt(1 + b.y - a.x - c.z) * 2
    return { x: (a.y + b.x) / s, y: 0.25 * s, z: (b.z + c.y) / s, w: (a.z - c.x) / s }
  }
  const s = Math.sqrt(1 + c.z - a.x - b.y) * 2
  return { x: (a.z + c.x) / s, y: (b.z + c.y) / s, z: 0.25 * s, w: (b.x - a.y) / s }
}

/** Hamilton product (xyzw): rotation `a` applied on top of rotation `b`. */
function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/**
 * A unit quaternion, or null when there is no orientation in there to
 * normalise. The sidecar's quaternions are the analyzer's own and are not
 * guaranteed normalised; composing an unnormalised one would scale the result.
 */
function unitQuat(q: Quat): Quat | null {
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  return n > 0 ? { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n } : null
}

/** Uniform scale: a side length in SfM units × scale is that side length in metres. */
function scaleVec(v: Vec3, scale: number): Vec3 {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale }
}

/**
 * Row-major 4x4 × point. Row-major because SplatAlignManifest.projectTransform
 * pins that convention — reading it column-major silently transposes, which
 * looks like a plausible pose rather than an error.
 */
function applyTransform(m: number[], p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  }
}

/**
 * How this scan sits in metres, and how much that claim is worth.
 *
 * `metric` is the field to branch on: false means nothing in this event
 * converts a splat-space length into a real one, whatever `scale` happens to
 * say. The project frame is the Place's own metric frame — *not* the ENU frame
 * `location` is expressed in; relating the two is the geo-anchoring work, not
 * this fit.
 */
function spatialFrame(align: SplatAlignManifest | null, scan: ScanManifest, fit: MetricFit | null) {
  const params = align?.params ?? ({} as SplatAlignManifest['params'])
  return {
    units: 'm',
    frame: 'project',
    /** Only true when the fit converged, scaled positively, and measured itself inside tolerance. */
    metric: fit !== null,
    /** Multiply a splat/SfM-space length by this to get metres. */
    scale: align?.scale ?? null,
    /** RMS of the fitted correspondence, in metres. Large = the fit is wrong, not imprecise. */
    residual_m: align?.residualM ?? null,
    max_residual_m: params.maxResidualM ?? null,
    correspondence_count: align?.correspondenceCount ?? null,
    min_correspondences: params.minCorrespondences ?? null,
    project_transform: matrix16(align?.projectTransform),
    transform_convention:
      'row-major 4x4 mapping the splat/SfM frame into the Place project frame, scale already folded in',
    /** Which calibration tier supplied the metric side of the fit. */
    calibration_method: align?.calibrationMethod ?? null,
    /** The scan's own calibration, which is what that tier refers to. */
    scan_calibration_method: scan.calibrationMethod ?? null,
    scan_calibration_status: scan.calibrationStatus ?? null,
    fit_tool: align?.tool ?? null,
    fit_status: align?.status ?? null,
    fit_at: align?.createdAt ?? null,
    splat_path: align?.plyPath ?? null,
    caveat:
      'The project frame is the Place metric frame, not the ENU frame `location` uses — this fit '
      + 'does not place the splat on Earth. When `metric` is false nothing in this event converts a '
      + 'splat-space length to metres, and `scale` must not be used to try.',
  }
}

// ── Capture-time detections (the mesh side) ───────────────────────────────────
//
// A second, older population of Things: the VLM detections the capture session
// resolved into world space, which src/export/gltf.ts writes into the upload
// sidecar `<base>.json` as `detections: [{ label, confidence, worldPos }]`.
// They are deliberately NOT merged into `objects` above — that is
// splat_analyzer's output in the splat frame, a different producer with a
// different contract (see src/world/detect-objects.ts), and fusing the two
// would produce one list whose entries mean two different things.
//
// Those three fields are all the sidecar carries. The GLB's per-detection
// `dimensions` is not read here and must not be: gltf.ts derives it from a 2D
// bbox fraction times hard-coded constants, so it would arrive
// indistinguishable from splat_analyzer's measured extents while being invented.
//
// The parse is a few lines rather than an import because main.ts's sibling
// reader (`detectionsFromMeta`, for thing-correspondence) lives in the module
// that imports *this* one — importing it back would be a cycle. Both read the
// same producer's shape; gltf.ts is where that shape is defined.

interface MeshDetectionRecord {
  label: string
  worldPos: Vec3
  confidence: number | null
}

function parseMeshDetections(value: unknown): MeshDetectionRecord[] {
  if (!Array.isArray(value)) return []
  const out: MeshDetectionRecord[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = typeof record['label'] === 'string' ? record['label'].trim() : ''
    const pos = record['worldPos']
    if (!label || !pos || typeof pos !== 'object') continue
    const p = pos as Record<string, unknown>
    if (typeof p['x'] !== 'number' || typeof p['y'] !== 'number' || typeof p['z'] !== 'number') continue
    out.push({
      label,
      worldPos: { x: p['x'], y: p['y'], z: p['z'] },
      confidence: typeof record['confidence'] === 'number' ? record['confidence'] : null,
    })
  }
  return out
}

/** One capture-time detection on the wire. */
function meshObjectWire(d: MeshDetectionRecord) {
  return {
    label: d.label,
    world_pos: d.worldPos,
    ...(d.confidence !== null ? { confidence: d.confidence } : {}),
  }
}

/** Frame of reference for `mesh_objects`, on the same terms as `object_extents`. */
function meshObjectProvenance(scan: ScanManifest) {
  return {
    source: 'capture sidecar <base>.json (VLM detections resolved to world space during the walkthrough)',
    frame: 'scan_world',
    units: 'm',
    convention:
      'world_pos is the detection centroid in the scan world frame — the same frame localToWorld '
      + 'places on Earth. These are points, not volumes: the sidecar carries no extent, and the '
      + "GLB's per-detection `dimensions` is derived from a 2D bounding-box fraction times "
      + 'hard-coded constants, so it is not forwarded here. confidence is the detector score.',
    has_extents: false,
    calibration_method: scan.calibrationMethod ?? null,
    calibration_status: scan.calibrationStatus ?? null,
  }
}

// ── Detected objects ──────────────────────────────────────────────────────────
//
// The `<base>.interactions.json` sidecar carries an oriented 3D box per object,
// not just a point: centre, orientation, and full extent, plus the per-view
// scores the analyzer clustered. All of it ships, because CI-Server's
// `ci.inventory` has canonical SI columns (length_mm/width_mm/height_mm, CHECK
// > 0) that a real extent maps onto — and nothing can populate them from a scan
// if the wire drops the numbers.
//
// The one place these numbers may NOT come from is the GLB exporter:
// src/export/gltf.ts derives its `dimensions` from a 2D bbox fraction times
// hard-coded constants (bw = max((x2-x1)*3.5, 0.25), and friends). Those are
// invented, and they look exactly as plausible as a measurement. Only
// interactions.json extents are the detector's own 3D output.

/** Non-negative, non-degenerate extent, or null. `ci.inventory` CHECKs > 0. */
function positiveExtent(scale: Vec3 | undefined): Vec3 | null {
  if (!scale) return null
  const x = Math.abs(scale.x), y = Math.abs(scale.y), z = Math.abs(scale.z)
  return x > 0 && y > 0 && z > 0 ? { x, y, z } : null
}

/** The same extent in whole millimetres, or null when an axis is sub-millimetre. */
function wholeMillimetres(extent: Vec3): Vec3 | null {
  const x = Math.round(extent.x * 1000)
  const y = Math.round(extent.y * 1000)
  const z = Math.round(extent.z * 1000)
  return x >= 1 && y >= 1 && z >= 1 ? { x, y, z } : null
}

/**
 * One object as it goes on the wire. Fields the sidecar did not carry are
 * omitted rather than defaulted — an absent extent means "the detector did not
 * give us one", which is not the same as a zero.
 *
 * `extent_metric_m`, `position_project` and `rotation_project` appear only when
 * `spatial_frame` reports a trustworthy fit: they are this same box carried
 * into the Place's metric frame by that fit, not a second measurement. Without
 * the fit the splat's units are SfM units of unknown size, so there is nothing
 * to convert and the fields stay absent rather than repeating `extent_m` under
 * a name that would promise metres.
 *
 * `position`/`rotation` stay exactly as the sidecar wrote them, in the splat
 * frame (`object_extents.frame`), and the `_project` pair is emitted *together*
 * — the orientation makes the same trip as the position or neither goes. A
 * transformed position beside an untransformed quaternion reads as one pose
 * while being two, and nothing in the payload would say so.
 */
function eventObject(d: DetectObjectRecord, fit: MetricFit | null) {
  const extentM = positiveExtent(d.scale)
  const extentMm = extentM ? wholeMillimetres(extentM) : null
  const extentMetric = fit && extentM ? scaleVec(extentM, fit.scale) : null
  const positionProject = fit?.transform ? applyTransform(fit.transform, d.position) : null
  // A box with no rotation has no orientation in either frame, so
  // `position_project` alone is unambiguous there; `fit.rotationQuat` is
  // non-null whenever `fit.transform` is, so the two never disagree.
  const boxQuat = d.rotation ? unitQuat(d.rotation) : null
  const rotationProject = fit?.rotationQuat && boxQuat ? quatMul(fit.rotationQuat, boxQuat) : null
  return {
    label: d.label,
    position: d.position,
    ...(d.rotation ? { rotation: d.rotation } : {}),
    ...(extentM ? { extent_m: extentM } : {}),
    ...(extentMm ? { extent_mm: extentMm } : {}),
    ...(extentMetric ? { extent_metric_m: extentMetric } : {}),
    ...(positionProject ? { position_project: positionProject } : {}),
    ...(rotationProject ? { rotation_project: rotationProject } : {}),
    ...(d.score !== undefined ? { confidence: d.score } : {}),
    ...(d.frameVotes !== undefined ? { frame_votes: d.frameVotes } : {}),
  }
}

/**
 * What the detector was actually told to do, read off the `splat-detect`
 * manifest that sits beside the sidecar. A null threshold means the run used
 * splat_analyzer's own default — that number belongs to the tool, so we record
 * the absence rather than guessing it here.
 *
 * `params.python` / `params.detectDir` are deliberately not forwarded: they are
 * appliance filesystem paths, not detector semantics.
 */
function detectorProvenance(manifest: SplatDetectManifest | null) {
  if (!manifest) return null
  const p = manifest.params ?? ({} as SplatDetectManifest['params'])
  return {
    tool: manifest.tool ?? null,
    prompt: manifest.prompt ?? null,
    run_at: manifest.createdAt ?? null,
    object_count: manifest.objectCount ?? null,
    quality: p.quality ?? null,
    renderer: p.renderer ?? null,
    point_splat_size: p.pointSplatSize ?? null,
    score_threshold: p.scoreThreshold ?? null,
    min_votes: p.minVotes ?? null,
    min_peak_score: p.minPeakScore ?? null,
  }
}

/**
 * Frame of reference + provenance for the per-object geometry. This travels
 * with the numbers because the numbers are not measured truth: splat-detect has
 * never been validated on a furnished room, and the splat frame's alignment to
 * the world frame is unvalidated (docs/pipelines/SPLAT_DETECT_ROADMAP.md, phases 1 and 3).
 * A consumer that reads an extent without reading this block would be treating
 * an uncalibrated detector's bounding box as a tape-measure reading.
 */
function extentProvenance(manifest: SplatDetectManifest | null, fit: MetricFit | null) {
  return {
    source: 'splat-analyzer interactions.json (oriented 3D bounding boxes)',
    frame: 'splat_local',
    units: 'm',
    convention:
      'position = box centre; rotation = xyzw quaternion; extent_m = full side lengths '
      + "along the box's own axes, so x/y/z carry no length/width/height meaning. "
      + 'extent_mm is extent_m × 1000 rounded to whole millimetres — the same measurement '
      + 'in SI units, not a second one. confidence is the peak per-view detector score '
      + '(what min_peak_score gates on); frame_votes is how many rendered views the object '
      + 'appeared in (what min_votes gates on). extent_metric_m, position_project and '
      + 'rotation_project are this same box carried into the Place project frame by '
      + 'spatial_frame — size, centre and orientation, all three in that frame — and are '
      + 'present only when spatial_frame.metric is true. rotation_project additionally '
      + 'requires the box to have carried a rotation at all; position and rotation without '
      + 'the suffix are always the splat-frame originals.',
    world_frame_aligned: false,
    calibrated: false,
    /** Whether spatial_frame's fit was good enough to express these boxes in metres. */
    project_frame_aligned: fit !== null,
    metric: fit
      ? {
        source: 'splat-align (Umeyama fit; see the event payload spatial_frame block)',
        scale: fit.scale,
        residual_m: fit.residualM,
        // The pose fields are all-or-nothing: `fit.transform` is only non-null
        // when a rotation could be extracted from it too, so a consumer never
        // has to wonder whether an object's orientation made the same trip its
        // centre did.
        applied_to: fit.transform
          ? ['extent_metric_m', 'position_project', 'rotation_project']
          : ['extent_metric_m'],
      }
      : null,
    caveat:
      'Detector output under the parameters below, not measured dimensions. The splat '
      + "frame's alignment to the world/ENU frame this event's `location` uses is "
      + 'unvalidated, and splat-detect has never been validated on a furnished room '
      + '(docs/pipelines/SPLAT_DETECT_ROADMAP.md, phases 1 and 3). An extent is a bounding volume, '
      + "not the object's own volume.",
    detector: detectorProvenance(manifest),
  }
}

/** Human-readable one-liner for the memory event title. */
function scanTitle(scan: Pick<ScanManifest, 'name' | 'scanId'>, geo: GeoPose | null | undefined): string {
  const place = geo?.address ?? geo?.displayAddress
  const base = scan.name?.trim() || scan.scanId
  return place ? `Scanned ${base} — ${place}` : `Scanned ${base}`
}

/**
 * Upload the scan's GLB and its best splat encoding, then record a
 * `capture.scan` event describing the room, what it measures in, and what was
 * found in it.
 *
 * Failure policy, unchanged as attachments were added: the event is the memory;
 * every file is an attachment. A missing, oversized or rejected GLB *or splat*
 * still records the event, carrying the reason it was skipped, rather than
 * losing the capture entirely. Only the event POST itself may fail the push.
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
  const statFile = deps.statFile ?? Deno.stat
  const sourceId = scan.scanId
  const base = scan.filename.replace(/\.glb$/i, '')

  // 1. GLB → POST {base}/files/upload (multipart field `files`).
  let glbFileId: string | null = null
  let glbSkippedReason: string | undefined
  const glbPath = `${deps.scansDir}/${scan.filename}`
  try {
    const bytes = await readFile(glbPath)
    const uploaded = await uploadFile(cfg, doFetch, {
      name: scan.filename,
      label: 'glb',
      bytes,
      mime: 'model/gltf-binary',
    })
    glbFileId = uploaded.id
    glbSkippedReason = uploaded.skippedReason
  } catch (err) {
    glbSkippedReason = err instanceof Error && err.name === 'NotFound'
      ? 'glb not found on disk'
      : `upload error: ${redact(String(err), cfg).slice(0, 200)}`
    console.warn(`[memory-push] ${glbSkippedReason} (${glbPath})`)
  }

  // 2. Splat artifacts (written by splat-train / splat-finish) — the richest
  //    representation of the space. One is attached, all are referenced; a scan
  //    that never trained a splat simply has none of this.
  const trainManifest = await readManifest<SplatTrainManifest>(
    readTextFile,
    `${deps.scansDir}/${base}.splat-train.manifest.json`,
  )
  const finishManifest = await readManifest<SplatFinishManifest>(
    readTextFile,
    `${deps.scansDir}/${base}.splat-finish.manifest.json`,
  )
  const splatArtifacts = await discoverSplatArtifacts(base, deps.scansDir, statFile, trainManifest, finishManifest)
  if (splatArtifacts.length) {
    await attachSplatArtifact(cfg, doFetch, readFile, deps.scansDir, splatArtifacts)
  }
  const splatFileIds = splatArtifacts.map((a) => a.fileId).filter((id): id is string => !!id)

  // 3. The metric frame (written by splat-align). Everything spatial in this
  //    event is either expressed in it or explicitly not; read before the
  //    objects because it decides whether their lengths can be converted.
  const alignManifest = await readManifest<SplatAlignManifest>(
    readTextFile,
    `${deps.scansDir}/${base}.splat-align.manifest.json`,
  )
  const fit = metricFit(alignManifest)

  // 4. Detections sidecar (written by the splat-detect job) — optional, and its
  //    manifest alongside it, which records how the detector was parameterised.
  let detections: DetectObjectRecord[] = []
  try {
    const raw = await readTextFile(`${deps.scansDir}/${base}.interactions.json`)
    detections = parseDetectRecords(JSON.parse(raw))
  } catch { /* no detections yet — a scan is still a memory without them */ }

  let detectManifest: SplatDetectManifest | null = null
  if (detections.length) {
    detectManifest = await readManifest<SplatDetectManifest>(
      readTextFile,
      `${deps.scansDir}/${base}.splat-detect.manifest.json`,
    )
  }

  const labels = [...new Set(
    detections.map((d) => (d.label ?? '').trim()).filter(Boolean),
  )].sort()

  const objects = detections.filter((d) => d.label).map((d) => eventObject(d, fit))
  const extentCount = objects.filter((o) => 'extent_m' in o).length

  // 5. The capture-time VLM detections from the upload sidecar — the other
  //    population of Things, each with a real world position and its own
  //    confidence, which until now reached Memory only as a count.
  let meshDetections: MeshDetectionRecord[] = []
  try {
    const meta = JSON.parse(await readTextFile(`${deps.scansDir}/${base}.json`)) as Record<string, unknown>
    meshDetections = parseMeshDetections(meta?.['detections'])
  } catch { /* no upload sidecar (or an older one without positions) */ }

  // 6. The event. CaptureEvent has no top-level geo column on this endpoint —
  // the controller folds `payload` into event.metadata — so location travels in
  // the payload and is queryable as metadata JSON.
  const geo = scan.geoPose ?? null
  const occurredAt = scan.capturedAt ?? new Date().toISOString()
  const descriptionParts = [
    geo?.address ? `Location: ${geo.address}.` : null,
    typeof scan.pointCount === 'number' ? `${scan.pointCount.toLocaleString()} points.` : null,
    labels.length ? `Detected: ${labels.join(', ')}.` : null,
    // Only claim a splat, or metres, when there is one — the description is the
    // line a human reads back, so it must not describe a scan that never trained.
    typeof trainManifest?.gaussianCount === 'number'
      ? `Gaussian splat: ${trainManifest.gaussianCount.toLocaleString()} gaussians.`
      : null,
    fit ? `Metric scale solved (RMS ${fit.residualM.toFixed(3)} m).` : null,
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
      // Every attachment on this event, in one list a consumer can walk without
      // knowing which pipeline produced which file.
      file_ids: [glbFileId, ...splatFileIds].filter((id): id is string => !!id),
      point_count: scan.pointCount ?? null,
      detection_count: detections.length || scan.detectionCount || 0,
      detected_labels: labels,
      objects,
      // Only when there is geometry to qualify — a label-and-position-only
      // sidecar ships exactly as it did before.
      ...(extentCount ? { object_extents: extentProvenance(detectManifest, fit) } : {}),
      // The trained splat. Omitted entirely when neither pipeline stage ran, so
      // a mesh-only scan's payload is byte-for-byte what it always was.
      ...(splatArtifacts.length || trainManifest || finishManifest
        ? { splat: splatBlock(trainManifest, finishManifest, splatArtifacts) }
        : {}),
      // What this scan measures in. Present whenever there is something real to
      // say about scale — an alignment fit, or the scan's own calibration tier.
      ...(alignManifest || scan.calibrationMethod
        ? { spatial_frame: spatialFrame(alignManifest, scan, fit) }
        : {}),
      // Capture-time detections: label + world position + confidence per Thing,
      // qualified by their own frame block for the same reason the splat boxes are.
      ...(meshDetections.length
        ? {
          mesh_objects: meshDetections.map(meshObjectWire),
          mesh_object_frame: meshObjectProvenance(scan),
        }
        : {}),
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
    extentCount,
    splatArtifactCount: splatArtifacts.length,
    splatFileIds,
    spatialFrameMetric: fit !== null,
    meshObjectCount: meshDetections.length,
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
