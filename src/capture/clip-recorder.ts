/**
 * Person-clip recorder — the first video recording in this app.
 *
 * Records a raw camera stream to a single Blob, alongside a pose track sampled
 * from the AR session (`pose-track.ts`).
 *
 * ## Why not the AR canvas
 *
 * `src/rtc/broadcaster.ts` captures the AR canvas with `captureStream()`,
 * correctly — a human watching a live preview wants the HUD, the labels and the
 * detection pins composited in. A reconstruction input must have none of them.
 * So this opens its own `getUserMedia` stream at portrait 1080p and records
 * that, and the AR session (where one is running) contributes pose only.
 *
 * ## The acquisition-order hazard
 *
 * `src/ar/webxr.ts` records that `requestSession()` must run before
 * `getUserMedia()` or the user-activation window is burned. The same class of
 * bug is available here, which is why this never acquires a camera as part of
 * starting AR — by the time a recording starts, the AR session already exists.
 *
 * ## Camera contention
 *
 * On the 8th Wall path the camera is owned by `XR8`, and iOS Safari has
 * historically permitted only one active capture per page. Whether a second
 * `getUserMedia` can coexist is an open device question (Checklist C1). This
 * module therefore treats acquisition failure as a first-class, reportable
 * outcome rather than an exception: `start()` resolves with an error state
 * naming the cause, so the UI can say person capture is unavailable on this
 * path instead of failing obscurely.
 *
 * See docs/factory/10-4d-person-capture/0003-person-clip-recorder.md.
 */
import type { ARProvider } from '../ar/provider'
import { extensionForMime, pickClipMimeType } from './clip-validation'
import { PoseTrack, type PoseTrackFile } from './pose-track'

export interface ClipRecorderStatus {
  state: 'idle' | 'starting' | 'recording' | 'stopping' | 'error'
  message: string
  /** ms elapsed, while recording. */
  elapsedMs?: number
}

export type ClipStatusCallback = (status: ClipRecorderStatus) => void

export interface RecordedClip {
  blob: Blob
  mimeType: string
  fileName: string
  durationMs: number
  width: number
  height: number
  nominalFps: number
  poseTrack: PoseTrackFile
  recordedAt: string
}

/** Portrait 1080p. Ordering is deliberate — this is a 9:16 request, not 16:9. */
export const CLIP_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1080 },
    height: { ideal: 1920 },
    frameRate: { ideal: 30 },
  },
  // Matches every other capture path in this repo. Audio is a deferred
  // wave-level decision, not an oversight — nothing downstream (storage,
  // manifest, viewer) has an audio concept to extend.
  audio: false,
}

/** Nominal rate assumed when the track will not report one. Advisory: ffprobe is authoritative. */
const FALLBACK_FPS = 30

export class ClipRecorder {
  private _stream: MediaStream | null = null
  private _recorder: MediaRecorder | null = null
  private _chunks: Blob[] = []
  private _poseTrack: PoseTrack | null = null
  private _startedAt = 0
  private _onStatus: ClipStatusCallback | null = null
  private _tickHandle: ReturnType<typeof setInterval> | null = null
  private _provider: ARProvider | null
  private _meta: { clientId: string | null; takeId: string | null }

  constructor(provider: ARProvider | null, meta: { clientId?: string | null; takeId?: string | null } = {}) {
    this._provider = provider
    this._meta = { clientId: meta.clientId ?? null, takeId: meta.takeId ?? null }
  }

  set onStatus(fn: ClipStatusCallback) { this._onStatus = fn }
  get isRecording(): boolean { return this._recorder?.state === 'recording' }

  /**
   * Begin recording.
   *
   * Resolves `true` once recording has actually started. Resolves `false` — it
   * does not throw — when the camera or a codec is unavailable, having already
   * reported why through `onStatus`.
   */
  async start(): Promise<boolean> {
    if (this.isRecording) return true
    this._status('starting', 'Opening the camera…')

    if (typeof MediaRecorder === 'undefined') {
      this._status('error', 'This browser cannot record video.')
      return false
    }

    const mimeType = pickClipMimeType(t => MediaRecorder.isTypeSupported(t))
    if (!mimeType) {
      // A real outcome on some browsers. Say so rather than half-starting.
      this._status('error', 'This browser has no video format we can record. Try Safari or Chrome.')
      return false
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia(CLIP_CONSTRAINTS)
    } catch (e) {
      // The Checklist C1 case lands here on iOS if XR8 holds the camera.
      const detail = e instanceof Error ? e.message : String(e)
      this._status('error', `Could not open the camera: ${detail}`)
      this._cleanup()
      return false
    }

    try {
      this._recorder = new MediaRecorder(this._stream, { mimeType })
    } catch (e) {
      this._status('error', `Could not start recording: ${e instanceof Error ? e.message : String(e)}`)
      this._cleanup()
      return false
    }

    this._chunks = []
    this._recorder.addEventListener('dataavailable', ev => {
      if (ev.data && ev.data.size > 0) this._chunks.push(ev.data)
    })

    this._startedAt = Date.now()
    this._poseTrack = new PoseTrack(this._provider)
    this._poseTrack.start(this._startedAt)

    // One Blob at stop rather than a timeslice: chunking exists to stream an
    // upload mid-recording, which this path deliberately does not do, and it
    // complicates the container for no gain here.
    this._recorder.start()

    this._tickHandle = setInterval(() => {
      if (this.isRecording) this._status('recording', 'Recording…', Date.now() - this._startedAt)
    }, 250)

    this._status('recording', 'Recording…', 0)
    return true
  }

  /**
   * Stop and resolve the finished clip.
   *
   * Resolves `null` when nothing was recorded. Always releases the camera —
   * a recorder that leaves the capture light on is its own kind of bug.
   */
  stop(): Promise<RecordedClip | null> {
    const recorder = this._recorder
    if (!recorder || recorder.state === 'inactive') {
      this._cleanup()
      return Promise.resolve(null)
    }
    this._status('stopping', 'Finishing the recording…')

    return new Promise<RecordedClip | null>(resolve => {
      recorder.addEventListener('stop', () => {
        const durationMs = Date.now() - this._startedAt
        this._poseTrack?.stop()

        const settings = this._stream?.getVideoTracks()[0]?.getSettings() ?? {}
        const width = typeof settings.width === 'number' ? settings.width : 0
        const height = typeof settings.height === 'number' ? settings.height : 0
        const nominalFps = typeof settings.frameRate === 'number' && settings.frameRate > 0
          ? settings.frameRate
          : FALLBACK_FPS

        const mimeType = recorder.mimeType || 'video/mp4'
        const blob = new Blob(this._chunks, { type: mimeType })
        const recordedAt = new Date(this._startedAt).toISOString()

        const clip: RecordedClip | null = blob.size === 0 ? null : {
          blob,
          mimeType,
          fileName: `clip.${extensionForMime(mimeType)}`,
          durationMs,
          width,
          height,
          nominalFps,
          recordedAt,
          poseTrack: this._poseTrack!.toFile({
            clientId: this._meta.clientId,
            takeId: this._meta.takeId,
            mimeType,
            recordedAt,
            durationMs,
            nominalFps,
            width,
            height,
          }),
        }

        this._cleanup()
        this._status('idle', clip ? 'Recording finished' : 'That recording came out empty.')
        resolve(clip)
      }, { once: true })

      recorder.stop()
    })
  }

  /** The pose samples gathered so far, for a motion advisory at validation time. */
  get poseSamples() { return this._poseTrack?.samples ?? [] }

  /** Release the camera and every timer. Safe to call repeatedly. */
  dispose(): void {
    try { this._recorder?.stop() } catch { /* already stopped */ }
    this._cleanup()
  }

  private _cleanup(): void {
    if (this._tickHandle !== null) {
      clearInterval(this._tickHandle)
      this._tickHandle = null
    }
    this._poseTrack?.stop()
    // Stop every track, not just video: a stream left running keeps the
    // camera indicator lit and holds the device the next recording needs.
    this._stream?.getTracks().forEach(t => t.stop())
    this._stream = null
    this._recorder = null
  }

  private _status(state: ClipRecorderStatus['state'], message: string, elapsedMs?: number): void {
    this._onStatus?.({ state, message, ...(elapsedMs === undefined ? {} : { elapsedMs }) })
  }
}
