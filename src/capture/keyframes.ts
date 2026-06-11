/**
 * KeyframeStreamer — streams pose-tagged camera keyframes to the server
 * while the user scans, instead of holding everything in mobile memory.
 *
 * A keyframe fires when the camera has moved ≥ minDistanceM or rotated
 * ≥ minRotationDeg since the previous keyframe (and at most once per
 * minIntervalMs).  Each frame is downscaled to maxLongEdgePx, encoded as
 * JPEG, and uploaded with its SLAM pose + camera intrinsics + timestamp —
 * the inputs a dense-reconstruction backend (photogrammetry / splats) needs.
 *
 * Mobile-budget guardrails:
 *   - bounded queue: capture is SKIPPED (not buffered) when uploads lag,
 *     so memory stays flat and the JPEG encode cost is never paid for
 *     frames that would be dropped anyway
 *   - single upload in flight, retry with backoff, offline pause
 *   - streaming pauses while the page is hidden (battery)
 */
import type { ARProvider, Pose } from '../ar/provider'

export interface KeyframeStreamerOptions {
  /** Min time between keyframes (default 1200 ms) */
  minIntervalMs?: number
  /** Translation that triggers a keyframe (default 0.30 m) */
  minDistanceM?: number
  /** Rotation that triggers a keyframe (default 20°) */
  minRotationDeg?: number
  /** Max keyframes awaiting upload before new captures are skipped (default 3) */
  maxQueue?: number
  /** Frames are downscaled so the long edge is at most this (default 1280 px) */
  maxLongEdgePx?: number
  /** JPEG quality (default 0.8) */
  jpegQuality?: number
  /** Pose poll cadence (default 350 ms) */
  pollIntervalMs?: number
}

export interface StreamerStatus {
  active: boolean
  sessionId: string | null
  sent: number
  queued: number
  skipped: number
  failed: number
  offline: boolean
}

interface QueuedKeyframe {
  blob: Blob
  meta: Record<string, unknown>
}

const DEFAULTS: Required<KeyframeStreamerOptions> = {
  minIntervalMs: 1200,
  minDistanceM: 0.3,
  minRotationDeg: 20,
  maxQueue: 3,
  maxLongEdgePx: 1280,
  jpegQuality: 0.8,
  pollIntervalMs: 350,
}

const OFFLINE_RETRY_MS = 10_000
const UPLOAD_RETRIES = 3

export class KeyframeStreamer {
  private _opts: Required<KeyframeStreamerOptions>
  private _active = false
  private _sessionId: string | null = null
  private _index = 0
  private _sent = 0
  private _skipped = 0
  private _failed = 0
  private _offlineUntil = 0
  private _lastKeyframeMs = 0
  private _lastPose: Pose | null = null
  private _pollHandle: ReturnType<typeof setInterval> | null = null
  private _queue: QueuedKeyframe[] = []
  private _uploading = false
  private _capturing = false
  private _hidden = false

  onStatus: ((s: StreamerStatus) => void) | null = null

  constructor(
    private readonly provider: ARProvider,
    opts: KeyframeStreamerOptions = {},
  ) {
    this._opts = { ...DEFAULTS, ...opts }
    document.addEventListener('visibilitychange', () => {
      this._hidden = document.visibilityState === 'hidden'
    })
  }

  get active(): boolean { return this._active }
  get sessionId(): string | null { return this._sessionId }

  /** Open a server session and begin pose-delta keyframing. */
  async start(): Promise<void> {
    if (this._active) return
    const resp = await fetch('/sessions', { method: 'POST' })
    if (!resp.ok) throw new Error(`POST /sessions → ${resp.status}`)
    const { sessionId } = await resp.json() as { sessionId: string }

    this._sessionId = sessionId
    this._index = 0
    this._sent = 0
    this._skipped = 0
    this._failed = 0
    this._lastPose = null
    this._lastKeyframeMs = 0
    this._active = true
    this._pollHandle = setInterval(() => void this._tick(), this._opts.pollIntervalMs)
    this._emit()
    console.log(`[keyframes] streaming to ${sessionId}`)
  }

  /**
   * Stop keyframing.  Drains pending uploads (best effort, bounded) and
   * finalizes the session, linking it to the exported scan when known.
   */
  async stop(finalize?: {
    glbFilename?: string
    pointCount?: number
    detectionCount?: number
    poseCount?: number
  }): Promise<void> {
    if (!this._active && !this._sessionId) return
    this._active = false
    if (this._pollHandle !== null) {
      clearInterval(this._pollHandle)
      this._pollHandle = null
    }

    // Bounded drain — don't trap the user on a stuck network
    const deadline = Date.now() + 5000
    while ((this._queue.length > 0 || this._uploading) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
    }

    const sessionId = this._sessionId
    this._sessionId = null
    this._emit()
    if (!sessionId) return

    try {
      await fetch(`/sessions/${sessionId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalize ?? {}),
      })
      console.log(`[keyframes] finalized ${sessionId} (${this._sent} keyframes)`)
    } catch (e) {
      console.warn('[keyframes] finalize failed:', e)
    }
  }

  /** Finalize the current session against an uploaded scan, keep streaming into a fresh one. */
  async rotate(finalize: Parameters<KeyframeStreamer['stop']>[0]): Promise<void> {
    if (!this._active) return
    await this.stop(finalize)
    await this.start().catch((e) => console.warn('[keyframes] restart failed:', e))
  }

  // ── Keyframe trigger ────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    if (!this._active || this._capturing || this._hidden) return
    if (!this.provider.isTracking()) return
    if (performance.now() - this._lastKeyframeMs < this._opts.minIntervalMs) return
    if (Date.now() < this._offlineUntil) return

    const pose = this.provider.getPose()
    if (this._lastPose && !this._exceedsDelta(this._lastPose, pose)) return

    // Backpressure: skip the keyframe entirely when uploads are behind.
    if (this._queue.length >= this._opts.maxQueue) {
      this._skipped++
      this._emit()
      return
    }

    this._capturing = true
    this._lastKeyframeMs = performance.now()
    this._lastPose = pose
    try {
      const kf = await this._captureKeyframe()
      this._queue.push(kf)
      this._emit()
      void this._pump()
    } catch (e) {
      console.warn('[keyframes] capture failed:', e)
    } finally {
      this._capturing = false
    }
  }

  private _exceedsDelta(a: Pose, b: Pose): boolean {
    const dx = b.position.x - a.position.x
    const dy = b.position.y - a.position.y
    const dz = b.position.z - a.position.z
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) >= this._opts.minDistanceM) return true

    // Quaternion angle: θ = 2·acos(|q1·q2|)
    const dot = Math.abs(
      a.rotation.x * b.rotation.x + a.rotation.y * b.rotation.y +
      a.rotation.z * b.rotation.z + a.rotation.w * b.rotation.w,
    )
    const angleDeg = 2 * Math.acos(Math.min(1, dot)) * (180 / Math.PI)
    return angleDeg >= this._opts.minRotationDeg
  }

  // ── Capture + encode ────────────────────────────────────────────────────────

  private async _captureKeyframe(): Promise<QueuedKeyframe> {
    const frame = await this.provider.captureFrame()
    const { pixels, width, height, pose, timestamp } = frame

    const scale = Math.min(1, this._opts.maxLongEdgePx / Math.max(width, height))
    const w = Math.round(width * scale)
    const h = Math.round(height * scale)

    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height)
    const bitmap = await createImageBitmap(imageData)
    const oc = new OffscreenCanvas(w, h)
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: this._opts.jpegQuality })

    const meta = {
      index: this._index++,
      timestamp,
      capturedAt: Date.now(),
      pose,
      intrinsics: {
        fovYDeg: this.provider.getCameraFovY(),
        aspect: this.provider.getCameraAspect(),
        width: w,
        height: h,
        sourceWidth: width,
        sourceHeight: height,
      },
    }
    return { blob, meta }
  }

  // ── Upload worker (single in-flight) ────────────────────────────────────────

  private async _pump(): Promise<void> {
    if (this._uploading) return
    this._uploading = true
    try {
      while (this._queue.length > 0) {
        if (!this._sessionId) {
          this._queue = []
          break
        }
        const kf = this._queue[0]
        const ok = await this._uploadWithRetry(kf)
        this._queue.shift()
        if (ok) {
          this._sent++
        } else {
          this._failed++
          this._offlineUntil = Date.now() + OFFLINE_RETRY_MS
        }
        this._emit()
      }
    } finally {
      this._uploading = false
    }
  }

  private async _uploadWithRetry(kf: QueuedKeyframe): Promise<boolean> {
    for (let attempt = 0; attempt < UPLOAD_RETRIES; attempt++) {
      try {
        const form = new FormData()
        form.append('image', kf.blob, `kf-${kf.meta['index']}.jpg`)
        form.append('meta', JSON.stringify(kf.meta))
        const resp = await fetch(`/sessions/${this._sessionId}/keyframes`, {
          method: 'POST',
          body: form,
        })
        if (resp.ok) return true
        if (resp.status >= 400 && resp.status < 500) return false // not retryable
      } catch { /* network error — retry */ }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
    return false
  }

  private _emit(): void {
    this.onStatus?.({
      active: this._active,
      sessionId: this._sessionId,
      sent: this._sent,
      queued: this._queue.length,
      skipped: this._skipped,
      failed: this._failed,
      offline: Date.now() < this._offlineUntil,
    })
  }
}
