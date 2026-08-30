/**
 * The tripod sheet's own camera.
 *
 * Tripod Scan could not take a photograph. The sheet's "Add this spot's
 * photos" opened the phone's gallery, so every image had to already exist on
 * the device, put there by something that was not this app — a capture path
 * whose capture step happened somewhere else. This is that step, in the page.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a plain camera stream drawn into a canvas on a timer
 * (`sweep-cadence.ts` owns the timing and the refusals). It involves no AR
 * runtime of any kind, which is the entire reason the tripod path exists: the
 * test phone has no ARCore at all, and the SLAM engine cannot initialise ON A
 * TRIPOD even when it starts, because it needs the operator to walk and a
 * tripod is the one thing that guarantees they do not. Anything here that
 * reached for tracking would break the path it is part of.
 *
 * It also talks to nothing off the phone. The gimbal sweeps in its
 * movement-only mode — its own driver's words for that mode are that the
 * scanner app owns the frames — and the two run on the same wall clock and
 * nothing else.
 *
 * ## Releasing the camera
 *
 * Measured on this device: starting AR earlier in a session made a later
 * camera open time out. A stream left running holds the device and lights the
 * capture indicator, so {@link SweepCamera.stop} is called from all four ways a
 * sweep can be over — finished, sheet closed, ended by the cadence, or the page
 * going away — and is safe to call when nothing is open. This mirrors
 * `clip-recorder.ts`'s `_cleanup()`, which stops every track for the same
 * reason.
 */
import {
  type CadenceState,
  type SweepEndReason,
  FRAME_QUALITY,
  cameraRefusal,
  endCadence,
  frameFileName,
  frameSize,
  noteCaptured,
  startCadence,
  tickCadence,
} from './sweep-cadence'

/**
 * What the sweep asks the camera for.
 *
 * Landscape 1080p, because that is the shape and size the reconstruction has
 * been fed all along, and `ideal` rather than `exact` so a camera that cannot
 * do it hands over what it can rather than refusing outright — `frameSize()`
 * then works from whatever actually arrived.
 *
 * `environment` for the obvious reason: the phone is clamped to a gimbal
 * pointing at the room, and the front camera is pointing at the wall behind it.
 */
export const SWEEP_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
}

/** How often the loop looks at the camera. Well under the sample period. */
const TICK_MS = 120

export interface SweepCameraHooks {
  /** A photo was banked. `captured` is the running count, and it is the truth. */
  onFrame(file: File, captured: number): void
  /** The cadence called the sweep off. Not fired when {@link SweepCamera.stop} is. */
  onEnded(reason: SweepEndReason, captured: number): void
}

/**
 * The reason a camera could not be opened, in the four shapes worth different
 * advice. Anything else is 'failed' — a message nobody can act on differently.
 */
function classifyOpenFailure(error: unknown): 'denied' | 'busy' | 'failed' {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as Error).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy'
  return 'failed'
}

export class SweepCamera {
  private _stream: MediaStream | null = null
  private _video: HTMLVideoElement | null = null
  private _canvas: HTMLCanvasElement | null = null
  private _timer: ReturnType<typeof setInterval> | null = null
  private _cadence: CadenceState | null = null
  private _hooks: SweepCameraHooks
  private _spot = 1
  /** One encode at a time: `toBlob` is async and the timer is not. */
  private _encoding = false
  /**
   * A stop was asked for.
   *
   * The window that matters is the permission prompt: `getUserMedia` can sit
   * pending for as long as it takes someone to tap Allow, and the sheet can be
   * closed in the meantime. Without this, that stream opens into a sweep that
   * no longer exists and stays open — the same hazard `src/ar/webxr.ts` guards
   * after its own re-acquire.
   */
  private _stopRequested = false

  constructor(hooks: SweepCameraHooks) {
    this._hooks = hooks
  }

  get isRunning(): boolean { return this._timer !== null }
  get captured(): number { return this._cadence?.captured ?? 0 }

  /**
   * Open the camera and start banking frames into `spot`.
   *
   * Resolves with `null` once frames are being taken, or with a sentence
   * explaining why not — it does not throw. A refused camera is an ordinary
   * outcome on a browser or a phone that will not give one out, and the sheet's
   * job then is to keep the import path in front of the operator, not to
   * surface an exception.
   */
  async start(preview: HTMLVideoElement, spot: number): Promise<string | null> {
    if (this.isRunning) return null
    this._stopRequested = false
    this._spot = spot

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return cameraRefusal('unsupported')
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(SWEEP_CONSTRAINTS)
    } catch (e) {
      return cameraRefusal(classifyOpenFailure(e))
    }

    // stop() may have run while the permission prompt was up — the operator
    // closed the sheet, or marked the sweep finished. Do not leave a stream
    // open that nothing is going to read.
    if (this._stopRequested) {
      stream.getTracks().forEach(t => t.stop())
      return null
    }

    this._stream = stream
    this._video = preview
    preview.srcObject = stream
    preview.playsInline = true
    preview.muted = true
    try {
      await preview.play()
    } catch {
      // Autoplay refusals happen; the element still decodes into the canvas,
      // and the cadence's own readiness check is what actually gates capture.
    }

    this._canvas = document.createElement('canvas')
    this._cadence = startCadence(Date.now())
    this._timer = setInterval(() => this._tick(), TICK_MS)
    return null
  }

  /**
   * Release the camera. Idempotent, and the only way the stream is ever closed.
   *
   * Does not fire `onEnded`: the caller asked, so telling them is noise, and
   * the count is on `captured` either way.
   */
  stop(): void {
    this._stopRequested = true
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
    // Every track, not just video — the same reason clip-recorder.ts does:
    // anything left running holds the device the NEXT open needs.
    this._stream?.getTracks().forEach(t => t.stop())
    this._stream = null
    if (this._video) {
      this._video.srcObject = null
      this._video = null
    }
    this._canvas = null
    if (this._cadence) this._cadence = endCadence(this._cadence, 'stopped')
  }

  private _tick(): void {
    const video = this._video
    const cadence = this._cadence
    if (!video || !cadence) return

    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const { state, action } = tickCadence(cadence, {
      nowMs: Date.now(),
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      currentTime: video.currentTime,
      hidden,
    })
    this._cadence = state

    if (action === 'end') {
      const reason = state.ended ?? 'stopped'
      const captured = state.captured
      this.stop()
      this._hooks.onEnded(reason, captured)
      return
    }
    if (action !== 'capture' || this._encoding) return
    void this._bank(video)
  }

  /**
   * Draw the current picture and hand it over as a real JPEG File.
   *
   * A File and not a Blob or a data URL, because that is what the uploader and
   * `planStationFrames` already consume — the frames this produces are
   * indistinguishable downstream from the ones the gallery picker used to
   * hand over, which is the whole point: nothing after this line changes.
   *
   * The tally moves only once a Blob with bytes in it exists. An encode that
   * came back empty is a photo that was never taken, and counting it is the
   * exact failure this feature is most able to commit.
   */
  private async _bank(video: HTMLVideoElement): Promise<void> {
    const canvas = this._canvas
    if (!canvas) return
    const size = frameSize(video.videoWidth, video.videoHeight)
    if (!size) return

    this._encoding = true
    try {
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width
        canvas.height = size.height
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, size.width, size.height)

      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', FRAME_QUALITY)
      })
      // stop() may have run during the encode. A frame from a sweep that is
      // over must not land in the next spot's pile.
      if (!blob || blob.size === 0 || !this._cadence || this._cadence.ended) return

      this._cadence = noteCaptured(this._cadence)
      const name = frameFileName(this._spot, this._cadence.captured)
      this._hooks.onFrame(new File([blob], name, { type: 'image/jpeg' }), this._cadence.captured)
    } finally {
      this._encoding = false
    }
  }
}
