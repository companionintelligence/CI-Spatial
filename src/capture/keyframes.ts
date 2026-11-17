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
import { trackingIsUsable } from '../ar/tracking-quality.ts'
import { epochOf } from '../ar/frame-epoch.ts'
import { isQueuedOffline } from '../shared/offline-queue.ts'
import { apiUrl } from '../shared/api-base.ts'

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
  /**
   * Whether capturing is held. While it is true no keyframe is taken: the re-anchor flow (src/ar/reanchor-flow.ts) holds
   * recording while it asks what to do about a frame shift, so the scan it ends has no frame from after the shift.
   * Default: never.
   */
  hold?: () => boolean
  /**
   * The AR run id to stamp on each keyframe's meta as `arRunId`, or null for none (src/shared/ar-run-id.ts). It is the
   * run the scan store is in, which carries the epoch a re-anchored scan began in (`<run>.<epoch>`), so a session's
   * frames say which frame they are in beside the `epoch` each already carries. Read as each frame is taken.
   * Default: none.
   */
  runId?: () => string | null
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

/**
 * idle → starting → active → stopping → idle. Only `active` streams. start() and
 * stop() run one at a time (see _serialize), so a second tap or an autosave
 * rotation cannot open a second session while one is still being set up or closed.
 */
type StreamerState = 'idle' | 'starting' | 'active' | 'stopping'

interface QueuedKeyframe {
  blob: Blob
  meta: Record<string, unknown>
  /** The session this frame was captured for. It is uploaded there and nowhere else. */
  sessionId: string
}

interface FinalizeSessionPayload {
  /** The scan exported from this session. */
  glbFilename?: string
  /**
   * The scan this stream last exported before this session opened. Set by the streamer, never by a caller: a session that
   * ends with no export of its own holds the frames taken after the last one, and naming that scan lets the server delete
   * them with it (server/session_deletion.ts). `glbFilename` keeps its one meaning.
   */
  followsGlbFilename?: string
  pointCount?: number
  detectionCount?: number
  poseCount?: number
  qualitySummary?: unknown
}

const DEFAULTS: Required<KeyframeStreamerOptions> = {
  minIntervalMs: 1200,
  minDistanceM: 0.3,
  minRotationDeg: 20,
  maxQueue: 3,
  maxLongEdgePx: 1280,
  jpegQuality: 0.8,
  pollIntervalMs: 350,
  hold: () => false,
  runId: () => null,
}

const OFFLINE_RETRY_MS = 10_000
const UPLOAD_RETRIES = 3
/** Longest one keyframe upload may take before it counts as failed (as the fixed 20 s it was). */
const UPLOAD_TIMEOUT_MS = 20_000

export class KeyframeStreamer {
  private _opts: Required<KeyframeStreamerOptions>
  private _state: StreamerState = 'idle'
  /** The start or stop in flight. Each transition queues behind the one before it. */
  private _transition: Promise<void> | null = null
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
  /** Set by abandon(): nothing more is captured or sent until start() is called again. */
  private _halted = false
  /** The scan this stream last finalized a session against. Cleared when the stream ends, so the next stream follows nothing. */
  private _walkScan: string | null = null
  /** The upload request in flight, so abandon() can cancel it. */
  private _inflight: AbortController | null = null

  onStatus: ((s: StreamerStatus) => void) | null = null

  /**
   * Fires when the server session id changes — the id on `start()`, `null`
   * when `stop()` closes one. The streamer used to hold this privately, which
   * is how the client and the server ended up naming a capture session
   * differently: the only id that names a real directory was never published
   * to anything that writes it into a scan. `src/main.ts` wires this to
   * `DetectionStore`.
   *
   * The `null` is a genuine "the session is closed" signal, not an instruction
   * to forget it. `DetectionStore` deliberately keeps the id it adopted: the
   * captures already in the store really did come from that session, whose
   * directory exists on the server with its keyframes, and re-keying the
   * record back to a local id would strand that association for nothing.
   * `rotate()` is `stop()` + `start()`, so a rotation emits `null` and then
   * the new id.
   */
  onSessionId: ((sessionId: string | null) => void) | null = null

  private readonly provider: ARProvider

  constructor(provider: ARProvider, opts: KeyframeStreamerOptions = {}) {
    this.provider = provider
    this._opts = { ...DEFAULTS, ...opts }
    document.addEventListener('visibilitychange', () => {
      this._hidden = document.visibilityState === 'hidden'
    })
  }

  get active(): boolean { return this._state === 'active' }
  /**
   * True for the whole of a start or a stop. A stop sets the state back to idle before its
   * finalize POST, so the state alone reads false while that POST is pending. The transition
   * promise covers the POST, and any start or stop queued behind a running one. main.ts
   * ignores stream-toggle taps while this is true.
   */
  get isTransitioning(): boolean {
    return this._state === 'starting' || this._state === 'stopping' || this._transition !== null
  }
  get sessionId(): string | null { return this._sessionId }

  /** Open a server session and begin pose-delta keyframing. */
  start(): Promise<void> {
    // A start after an abandon() is a new yes: the halt is lifted when the start is asked for, not when it runs.
    this._halted = false
    return this._serialize(() => this._openSession())
  }

  /**
   * Stop at once, for a person who has withdrawn consent to send camera frames. stop() drains what is queued for up
   * to five seconds first, so frames would still be sent after the person said no; this sends none: the queue is
   * dropped, the upload in flight is cancelled, and nothing is captured or sent from the moment it is called, even if
   * a start is still opening a session. The session is then finalized (counts and a filename, no picture), and it
   * does not reopen: a rotation that was waiting behind it ends here too.
   */
  abandon(finalize?: FinalizeSessionPayload): Promise<void> {
    this._halted = true
    this._queue = []
    this._inflight?.abort()
    return this._serialize(async () => {
      await this._closeSession(finalize, false)
      this._walkScan = null
    })
  }

  /**
   * Stop keyframing.  Drains pending uploads (best effort, bounded) and
   * finalizes the session, linking it to the exported scan when known.
   */
  stop(finalize?: FinalizeSessionPayload): Promise<void> {
    return this._serialize(async () => {
      await this._closeSession(finalize)
      // The stream has ended, so the walk has: the next one follows no scan of this one.
      this._walkScan = null
    })
  }

  /** Finalize the current session against an uploaded scan, keep streaming into a fresh one. */
  rotate(finalize: FinalizeSessionPayload): Promise<void> {
    return this._serialize(async () => {
      if (this._state !== 'active') return
      await this._closeSession(finalize)
      if (this._halted) return
      await this._openSession().catch((e) => console.warn('[keyframes] restart failed:', e))
    })
  }

  /**
   * Runs one transition after the one before it. A transition that finds the
   * streamer already where it is headed does nothing, so a double tap, or an
   * autosave that lands mid-start, cannot open a second session. A transition
   * with nothing ahead of it runs at once. One queued behind a start() waits for
   * that start to settle, which can take up to its 10 s POST timeout, so a stop()
   * during a start sends its finalize only after the start has finished.
   */
  private _serialize(run: () => Promise<void>): Promise<void> {
    const next = this._transition ? this._transition.then(run) : run()
    // Clears the transition in a reaction attached before the caller can see `next`, so it has
    // run by the time a caller that awaits the start or stop resumes. The rejection handler
    // logs a failed transition, and keeps it from surfacing as unhandled. That matters for a
    // caller that drops the promise (void keyframes.stop()), which would otherwise leave no
    // trace of the failure.
    const clear = (): void => {
      if (this._transition === settled) this._transition = null
    }
    const settled: Promise<void> = next.then(clear, (e) => {
      console.warn('[keyframes] transition failed:', e)
      clear()
    })
    this._transition = settled
    return next
  }

  private async _openSession(): Promise<void> {
    if (this._state !== 'idle') return
    this._state = 'starting'
    let sessionId: string
    try {
      const resp = await fetch(apiUrl('/sessions'), {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) throw new Error(`POST /sessions → ${resp.status}`)
      // Offline, the service worker queues this and answers 202 — which is ok,
      // but carries no sessionId. Accepting it started a "session" whose every
      // frame was encoded and then dropped by _pump's `if (!this._sessionId)`
      // guard: battery burned, counter stuck at 0, no error anywhere. There is
      // nothing to stream to until the server actually answers.
      if (isQueuedOffline(resp)) {
        throw new Error('Offline — keyframe streaming needs a live connection to the server')
      }
      const body = await resp.json() as { sessionId: string }
      sessionId = body.sessionId
    } catch (e) {
      // Still before activation, so nothing has been opened and idle is the true state.
      this._state = 'idle'
      throw e
    }

    // Activation. This is outside the try on purpose: once the session is active,
    // a throw from a listener below must not roll the state back to idle while the
    // poll interval and the session id are live.
    this._sessionId = sessionId
    this._index = 0
    this._sent = 0
    this._skipped = 0
    this._failed = 0
    this._lastPose = null
    this._lastKeyframeMs = 0
    this._state = 'active'
    // Clear the old handle before it is overwritten. Overwriting it alone left
    // its interval polling after stop().
    if (this._pollHandle !== null) clearInterval(this._pollHandle)
    this._pollHandle = setInterval(() => void this._tick(), this._opts.pollIntervalMs)
    this._emit()
    this._callListener('onSessionId', () => this.onSessionId?.(sessionId))
    console.log(`[keyframes] streaming to ${sessionId}`)
  }

  private async _closeSession(finalize?: FinalizeSessionPayload, drain = true): Promise<void> {
    if (this._state !== 'active') return
    this._state = 'stopping'
    if (this._pollHandle !== null) {
      clearInterval(this._pollHandle)
      this._pollHandle = null
    }

    // Bounded drain — don't trap the user on a stuck network.  Skipped when
    // the page is hidden (going away); the keepalive finalize still lands.
    // Skipped too when the stop is a withdrawal of consent: nothing more is sent.
    if (drain && document.visibilityState !== 'hidden') {
      const deadline = Date.now() + 5000
      while ((this._queue.length > 0 || this._uploading) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    // Whatever did not drain belongs to the session being closed. It is dropped
    // here, not uploaded into the next session under an index that session also uses.
    this._queue = []

    const sessionId = this._sessionId
    this._sessionId = null
    this._state = 'idle'
    this._emit()
    if (!sessionId) return
    // Announced as soon as the id is cleared, before the finalize round-trip,
    // so a listener's view of "is a session open" never lags the streamer's.
    this._callListener('onSessionId', () => this.onSessionId?.(null))

    // A session that ends with no scan of its own, after the stream exported one, holds the frames taken after that
    // export. It is finalized as following that scan, so that deleting the scan takes them too.
    const body: FinalizeSessionPayload = { ...finalize }
    if (body.glbFilename) this._walkScan = body.glbFilename
    else if (this._walkScan) body.followsGlbFilename = this._walkScan
    try {
      await fetch(apiUrl(`/sessions/${sessionId}/finalize`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true, // payload is small; survives the page unloading
        signal: AbortSignal.timeout(10_000),
      })
      console.log(`[keyframes] finalized ${sessionId} (${this._sent} keyframes)`)
    } catch (e) {
      console.warn('[keyframes] finalize failed:', e)
    }
  }

  // ── Keyframe trigger ────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    if (this._state !== 'active' || this._capturing || this._hidden || this._halted || this._opts.hold()) return
    // isTracking() latches on the first pose, so on its own it cannot say that
    // tracking has degraded. The runtime's live status can. It fails open for
    // UNKNOWN, which WebXR reports until its first frame.
    if (!this.provider.isTracking() || !trackingIsUsable(this.provider.trackingStatus())) return
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

    const sessionId = this._sessionId
    if (!sessionId) return
    this._capturing = true
    this._lastKeyframeMs = performance.now()
    this._lastPose = pose
    try {
      const kf = await this._captureKeyframe(sessionId)
      // The session may have closed, or been replaced, while the frame was encoding. Or consent may have been withdrawn.
      if (this._state !== 'active' || this._sessionId !== sessionId || this._halted) return
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

  private async _captureKeyframe(sessionId: string): Promise<QueuedKeyframe> {
    const frame = await this.provider.captureFrame()
    const { pixels, width, height, pose, timestamp } = frame
    // The epoch the provider stamped on the frame with its pose, not the one it is in by
    // the time the JPEG has been encoded: a discontinuity in between would otherwise label
    // a frame from the old coordinate frame with the new one. Read before any await.
    const epoch = typeof frame.epoch === 'number' && Number.isFinite(frame.epoch) && frame.epoch >= 0
      ? Math.floor(frame.epoch)
      : epochOf(this.provider)
    // The run is read where the epoch is, for the same reason: the frame belongs to the scan that was live when it was taken.
    const arRunId = this._opts.runId()

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
      // Which stretch of tracking the pose is in (src/ar/frame-epoch.ts). Frames of one
      // session with different epochs are not in one coordinate frame, and the session
      // record has no other way to say so. 0 from a provider with no epoch signal.
      epoch,
      // The run the scan store was in, with the epoch a re-anchored scan began in on the end (`<run>.<epoch>`).
      ...(arRunId ? { arRunId } : {}),
      intrinsics: {
        fovYDeg: this.provider.getCameraFovY(),
        aspect: this.provider.getCameraAspect(),
        width: w,
        height: h,
        sourceWidth: width,
        sourceHeight: height,
      },
    }
    return { blob, meta, sessionId }
  }

  // ── Upload worker (single in-flight) ────────────────────────────────────────

  private async _pump(): Promise<void> {
    if (this._uploading) return
    this._uploading = true
    try {
      while (this._queue.length > 0) {
        const kf = this._queue[0]
        // A frame whose session has already closed is dropped, never sent to the one now open.
        if (kf.sessionId !== this._sessionId) {
          this._queue.shift()
          continue
        }
        const ok = await this._uploadWithRetry(kf)
        // Removed by identity: stop() may have replaced the queue while this upload was in flight.
        const at = this._queue.indexOf(kf)
        if (at !== -1) this._queue.splice(at, 1)
        // Counted only against the session the frame belongs to, and not when abandon() cancelled it.
        if (kf.sessionId === this._sessionId && !this._halted) {
          if (ok) {
            this._sent++
          } else {
            this._failed++
            this._offlineUntil = Date.now() + OFFLINE_RETRY_MS
          }
        }
        this._emit()
      }
    } finally {
      this._uploading = false
    }
  }

  private async _uploadWithRetry(kf: QueuedKeyframe): Promise<boolean> {
    for (let attempt = 0; attempt < UPLOAD_RETRIES; attempt++) {
      // Once its session has closed, the frame is not sent to it again. Nor after abandon(): no consent, no frame.
      if (kf.sessionId !== this._sessionId || this._halted) return false
      // One controller per attempt, with its own timeout, so abandon() can cancel the request that is in flight.
      const attemptControl = new AbortController()
      const timeout = setTimeout(() => attemptControl.abort(), UPLOAD_TIMEOUT_MS)
      this._inflight = attemptControl
      try {
        const form = new FormData()
        form.append('image', kf.blob, `kf-${kf.meta['index']}.jpg`)
        form.append('meta', JSON.stringify(kf.meta))
        const resp = await fetch(apiUrl(`/sessions/${kf.sessionId}/keyframes`), {
          method: 'POST',
          body: form,
          signal: attemptControl.signal,
        })
        // A queued-offline response is 2xx, so resp.ok alone counted this frame
        // as sent — which suppressed _offlineUntil and left the phone encoding
        // a full-res JPEG every 1.2s into a growing IndexedDB queue, precisely
        // while the network was down. Report not-sent so the caller backs off;
        // the queued request still replays on reconnect. Returning early also
        // skips the retry loop: re-POSTing only queues another copy.
        if (isQueuedOffline(resp)) return false
        if (resp.ok) return true
        if (resp.status >= 400 && resp.status < 500) return false // not retryable
      } catch { /* network error or timeout — retry */ } finally {
        clearTimeout(timeout)
        if (this._inflight === attemptControl) this._inflight = null
      }
      // A cancelled upload is not retried, and does not wait out a back-off first.
      if (this._halted) return false
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
    return false
  }

  private _emit(): void {
    const status: StreamerStatus = {
      active: this._state === 'active',
      sessionId: this._sessionId,
      sent: this._sent,
      queued: this._queue.length,
      skipped: this._skipped,
      failed: this._failed,
      offline: Date.now() < this._offlineUntil,
    }
    this._callListener('onStatus', () => this.onStatus?.(status))
  }

  /**
   * Runs a listener so that a throw from it is logged and goes no further. The state
   * has already changed when a listener runs, so a bad listener must not turn a live
   * session into a failed start, or stop a finalize from being sent.
   */
  private _callListener(name: string, call: () => void): void {
    try {
      call()
    } catch (e) {
      console.warn('[keyframes] listener threw in', name, e)
    }
  }
}
