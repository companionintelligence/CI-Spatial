/**
 * 4D person reconstruction driver — the appliance's half.
 *
 * Every other pipeline driver in this repo spawns a local binary. This one does
 * not, and the reason is measured rather than stylistic: 4DAnyone needs **43.3
 * GiB of peak CUDA allocation** and 8–26 minutes per clip. The largest device on
 * this fleet is a 23.98 GiB ROCm card, diffusion inference does not shard across
 * two of them, and the stack is CUDA. So the work happens in
 * `subsystems/4d-capture/` on a machine that can host it, and this module
 * submits, polls, and ingests.
 *
 * The house contract is otherwise unchanged, and is deliberately copied from
 * `server/splat/splat_train.ts`:
 *
 *  - every knob resolves `opts.x ?? Deno.env.get('X') ?? DEFAULT`, once
 *  - `buildSubmitRequest()` is pure, so it unit-tests without a network
 *  - a `_fetch` injection point for tests
 *  - a manifest is written on **every** path, including skip and error
 *  - an unconfigured or unreachable subsystem is `'skipped'` with a
 *    `remediation` string, never `'error'` — the appliance must not break
 *    because no GPU host is attached, exactly as `BRUSH_BIN` and
 *    `LINGBOT_MAP_*` already behave
 *  - it never throws into the server
 *
 * ## Idempotence is mandatory here
 *
 * `recoverStuckWorldJobs` requeues every in-flight job unconditionally on boot —
 * requeue-always is type-agnostic by design (ADR 0003). For a local job that
 * only costs time. For a remote GPU job it costs money, twice. So submission is
 * keyed on `takeId` and re-attaches to an existing remote job rather than
 * starting a second one.
 *
 * See docs/factory/10-4d-person-capture/0005-frame-set-contract-and-job.md.
 */
import type { Person4DManifest } from '../../src/world/manifests.ts'

export interface Person4DClip {
  clientId: string | null
  /** URL the subsystem fetches the clip from — reachable on the tailnet. */
  url: string
  mimeType: string
  poseTrackUrl: string | null
  /** The member's TakeSync record, passed through verbatim. Never defaulted. */
  sync: unknown
}

export interface Person4DParams {
  host: string
  token: string | null
  viewsPerLayer: number
  timestepFps: number
  pollIntervalMs: number
  /** Hard stop on polling, so a wedged subsystem cannot hold the pump forever. */
  maxWaitMs: number
}

export interface Person4DOptions {
  takeId: string
  clips: Person4DClip[]
  /** Where frame-NNNNN.sog files land, and where the manifest is written. */
  sequenceDir: string
  manifestPath: string
  host?: string
  token?: string | null
  viewsPerLayer?: number
  timestepFps?: number
  pollIntervalMs?: number
  maxWaitMs?: number
  syncResidualMs?: number
  provenance?: { sessionId?: string; scanId?: string }
  /** Progress callback. Throttled by the caller, not here. */
  onProgress?: (fraction: number, stage: string) => void
  /** Injected for tests. */
  _fetch?: typeof fetch
  /** Injected for tests, so polling does not actually sleep. */
  _sleep?: (ms: number) => Promise<void>
}

export interface Person4DResult {
  status: 'ok' | 'skipped' | 'error'
  manifest: Person4DManifest
  /** Trailing log text, for the job's error field. */
  log: string
}

const DEFAULT_VIEWS_PER_LAYER = 6
const DEFAULT_TIMESTEP_FPS = 5
const DEFAULT_POLL_MS = 15_000
/** 45 min: comfortably past the slowest documented single-clip run. */
const DEFAULT_MAX_WAIT_MS = 45 * 60 * 1000

/** Resolve every knob in one place, `opts ?? env ?? default`. */
export function resolveParams(opts: Person4DOptions): Person4DParams {
  return {
    host: (opts.host ?? Deno.env.get('FDANYONE_HOST') ?? '').replace(/\/+$/, ''),
    token: opts.token ?? Deno.env.get('FDANYONE_TOKEN') ?? null,
    viewsPerLayer: opts.viewsPerLayer ?? intFromEnv('FDANYONE_VIEWS_PER_LAYER', DEFAULT_VIEWS_PER_LAYER),
    timestepFps: opts.timestepFps ?? intFromEnv('FDANYONE_TIMESTEP_FPS', DEFAULT_TIMESTEP_FPS),
    pollIntervalMs: opts.pollIntervalMs ?? intFromEnv('FDANYONE_POLL_MS', DEFAULT_POLL_MS),
    maxWaitMs: opts.maxWaitMs ?? intFromEnv('FDANYONE_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS),
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 4DAnyone requires `views_per_layer` to be divisible by 4 or 6. Validated
 * here rather than upstream because a bad value fails deep inside the model,
 * minutes into a run, with an error that does not name the cause.
 */
export function isValidViewsPerLayer(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n % 4 === 0 || n % 6 === 0)
}

/** The submit payload. Pure, so it is testable without a subsystem. */
export function buildSubmitRequest(opts: Person4DOptions, params: Person4DParams) {
  return {
    takeId: opts.takeId,
    clips: opts.clips.map(c => ({
      clientId: c.clientId,
      url: c.url,
      mimeType: c.mimeType,
      poseTrackUrl: c.poseTrackUrl,
      // Passed through exactly as recorded. A take whose members never measured
      // each other must not arrive looking synchronised.
      sync: c.sync ?? null,
    })),
    params: {
      viewsPerLayer: params.viewsPerLayer,
      timestepFps: params.timestepFps,
    },
  }
}

function baseManifest(opts: Person4DOptions, params: Person4DParams): Person4DManifest {
  return {
    schemaVersion: 1,
    tool: '4d-capture',
    status: 'skipped',
    createdAt: new Date().toISOString(),
    takeId: opts.takeId,
    clipCount: opts.clips.length,
    ...(opts.syncResidualMs === undefined ? {} : { syncResidualMs: opts.syncResidualMs }),
    ...(opts.provenance?.sessionId ? { sessionId: opts.provenance.sessionId } : {}),
    ...(opts.provenance?.scanId ? { scanId: opts.provenance.scanId } : {}),
    params: {
      host: params.host || '(unset)',
      viewsPerLayer: params.viewsPerLayer,
      timestepFps: params.timestepFps,
    },
  }
}

async function writeManifest(path: string, manifest: Person4DManifest): Promise<void> {
  try {
    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2))
  } catch (err) {
    // A manifest we could not write is not a reason to fail the job — the
    // in-memory result still reaches the coordinator.
    console.error('[person-4d] could not write manifest:', err)
  }
}

/**
 * Run a 4D person reconstruction for one take.
 *
 * Never throws. Every failure mode is a `Person4DResult`.
 */
export async function runPerson4D(opts: Person4DOptions): Promise<Person4DResult> {
  const params = resolveParams(opts)
  const manifest = baseManifest(opts, params)
  const doFetch = opts._fetch ?? fetch
  const sleep = opts._sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  if (opts.clips.length === 0) {
    manifest.status = 'error'
    manifest.error = 'take has no clips'
    await writeManifest(opts.manifestPath, manifest)
    return { status: 'error', manifest, log: 'take has no clips' }
  }

  if (!params.host) {
    manifest.skippedReason = 'FDANYONE_HOST is not set'
    manifest.remediation =
      'Set FDANYONE_HOST to a 4d-capture subsystem (needs a CUDA GPU with ~44 GiB) — see docs/pipelines/4d-person.md'
    await writeManifest(opts.manifestPath, manifest)
    return { status: 'skipped', manifest, log: manifest.skippedReason }
  }

  if (!isValidViewsPerLayer(params.viewsPerLayer)) {
    manifest.status = 'error'
    manifest.error = `viewsPerLayer must be divisible by 4 or 6 (got ${params.viewsPerLayer})`
    await writeManifest(opts.manifestPath, manifest)
    return { status: 'error', manifest, log: manifest.error }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (params.token) headers['Authorization'] = `Bearer ${params.token}`

  // ── Submit (idempotent on takeId) ────────────────────────────────────────
  let attached = false
  try {
    const res = await doFetch(`${params.host}/takes`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildSubmitRequest(opts, params)),
    })
    if (!res.ok) {
      manifest.status = 'error'
      manifest.error = `subsystem rejected the take (HTTP ${res.status})`
      await writeManifest(opts.manifestPath, manifest)
      return { status: 'error', manifest, log: manifest.error }
    }
    const body = await res.json() as { attached?: boolean }
    attached = body.attached === true
  } catch (err) {
    // Unreachable is a skip, not an error: the same contract as a missing
    // binary. The appliance keeps working without a GPU host attached.
    manifest.skippedReason = `4d-capture subsystem unreachable at ${params.host}`
    manifest.remediation = `Check FDANYONE_HOST and that the subsystem is running: ${err instanceof Error ? err.message : String(err)}`
    await writeManifest(opts.manifestPath, manifest)
    return { status: 'skipped', manifest, log: manifest.skippedReason }
  }

  opts.onProgress?.(0.1, attached ? 're-attached to a running job' : 'submitted')

  // ── Poll ─────────────────────────────────────────────────────────────────
  const deadline = Date.now() + params.maxWaitMs
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    await sleep(params.pollIntervalMs)
    let status: Record<string, unknown>
    try {
      const res = await doFetch(`${params.host}/takes/${encodeURIComponent(opts.takeId)}`, { headers })
      if (!res.ok) {
        manifest.status = 'error'
        manifest.error = `subsystem status check failed (HTTP ${res.status})`
        await writeManifest(opts.manifestPath, manifest)
        return { status: 'error', manifest, log: manifest.error }
      }
      status = await res.json() as Record<string, unknown>
    } catch (err) {
      manifest.status = 'error'
      manifest.error = `lost contact with the subsystem mid-run: ${err instanceof Error ? err.message : String(err)}`
      await writeManifest(opts.manifestPath, manifest)
      return { status: 'error', manifest, log: manifest.error }
    }

    last = status
    const state = String(status['status'] ?? '')
    const progress = typeof status['progress'] === 'number' ? status['progress'] : 0
    opts.onProgress?.(0.1 + progress * 0.85, String(status['stage'] ?? state))

    if (state === 'ok') {
      // The subsystem holds the frames on its own disk; nothing is playable
      // until they are pulled back to where this server serves from. Without
      // this the manifest resolves and every frame 404s — which looks like a
      // working reconstruction right up until the viewer tries to play it.
      let landed: number
      try {
        landed = await fetchSequence(params, opts, doFetch, headers)
      } catch (err) {
        manifest.status = 'error'
        manifest.error = `sequence transfer failed: ${err instanceof Error ? err.message : String(err)}`
        await writeManifest(opts.manifestPath, manifest)
        return { status: 'error', manifest, log: manifest.error }
      }

      const claimed = numberOr(status['frameCount']) ?? landed
      manifest.status = 'ok'
      manifest.viewSource = status['viewSource'] === 'multi-camera' ? 'multi-camera' : 'densified'
      manifest.viewCount = numberOr(status['viewCount'])
      // Report what actually landed, not what was promised. A partial transfer
      // that claimed the full count would loop the viewer over frames that are
      // not there.
      manifest.frameCount = landed
      manifest.fps = numberOr(status['fps']) ?? params.timestepFps
      manifest.durationMs = numberOr(status['durationMs'])
      manifest.sequenceDir = opts.sequenceDir
      await writeManifest(opts.manifestPath, manifest)
      const short = landed < claimed ? ` (${claimed - landed} frame(s) did not transfer)` : ''
      return { status: 'ok', manifest, log: `sequence of ${landed} frames${short}` }
    }
    if (state === 'skipped') {
      manifest.skippedReason = String(status['remediation'] ?? 'subsystem skipped the take')
      manifest.remediation = String(status['remediation'] ?? '')
      await writeManifest(opts.manifestPath, manifest)
      return { status: 'skipped', manifest, log: manifest.skippedReason }
    }
    if (state === 'error') {
      manifest.status = 'error'
      manifest.error = String(status['error'] ?? 'subsystem reported an error')
      await writeManifest(opts.manifestPath, manifest)
      return { status: 'error', manifest, log: manifest.error }
    }
  }

  manifest.status = 'error'
  manifest.error = `subsystem did not finish within ${Math.round(params.maxWaitMs / 60000)} min (last stage: ${String(last['stage'] ?? 'unknown')})`
  await writeManifest(opts.manifestPath, manifest)
  return { status: 'error', manifest, log: manifest.error }
}


/**
 * Pull the finished sequence back from the subsystem.
 *
 * Returns how many frames actually landed. Frames are written as
 * `frame-NNNNN.<ext>` into `opts.sequenceDir`, which is the directory the
 * `/scans/:base.4d/:frame` route serves from.
 *
 * A frame that fails to transfer is skipped rather than aborting the whole
 * sequence: a 23-of-24 sequence is still worth playing, and the caller reports
 * the shortfall rather than silently claiming the full count.
 */
async function fetchSequence(
  params: Person4DParams,
  opts: Person4DOptions,
  doFetch: typeof fetch,
  headers: Record<string, string>,
): Promise<number> {
  const res = await doFetch(`${params.host}/takes/${encodeURIComponent(opts.takeId)}/sequence`, { headers })
  if (!res.ok) throw new Error(`sequence listing failed (HTTP ${res.status})`)
  const body = await res.json() as { frames?: unknown }
  const frames = Array.isArray(body.frames) ? body.frames.filter((f): f is string => typeof f === 'string') : []
  if (frames.length === 0) throw new Error('subsystem reported no frames')

  await Deno.mkdir(opts.sequenceDir, { recursive: true })
  let landed = 0
  for (const frame of frames) {
    // The names come from another machine, so they are validated rather than
    // trusted — this path is written to disk.
    if (!/^frame-\d{5}\.(sog|ply)$/.test(frame)) continue
    try {
      const fr = await doFetch(`${params.host}/takes/${encodeURIComponent(opts.takeId)}/frames/${frame}`, { headers })
      if (!fr.ok) continue
      await Deno.writeFile(`${opts.sequenceDir}/${frame}`, new Uint8Array(await fr.arrayBuffer()))
      landed++
    } catch { /* skip this frame; the shortfall is reported */ }
  }
  if (landed === 0) throw new Error('no frames could be transferred')
  return landed
}

function numberOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
