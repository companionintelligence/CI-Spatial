/**
 * A timestamped camera-pose track recorded alongside a person clip.
 *
 * This is what makes the multi-camera path possible without 4DAnyone. A clip on
 * its own can only be *densified* — the model has to infer where the camera was.
 * A clip with a pose track, from a device calibrated to a Place's two ground
 * markers (ADR 0005), is already in the same world frame as every other device
 * in the take, so N of them are a calibrated rig and their real views can be fed
 * straight to the splat trainer.
 *
 * Samples `provider.getPose()`, which is synchronous and non-blocking —
 * deliberately **not** `captureFrame()`. That method has a single-in-flight
 * contract (`'Capture already pending'`) shared with the keyframe streamer, and
 * a sampler competing for it would starve one or the other. The pose track
 * needs pose, not pixels, so it never enters that queue.
 *
 * Serialises into `FrameObservation`'s field names (`src/world/types.ts`) so
 * nothing downstream needs a second pose vocabulary. `frameId`/`scanId`/`rgbUrl`
 * are omitted: there is no per-frame image here, and minting ids for frames
 * with no files would be fabricating identity.
 *
 * See docs/factory/10-4d-person-capture/0003-person-clip-recorder.md.
 */
import type { ARProvider, Pose } from '../ar/provider'

/** One sampled pose, timestamped against the same clock the clip is stamped with. */
export interface PoseSample {
  /** ms since recording started. */
  timestamp: number
  pose: Pose
}

export interface PoseTrackIntrinsics {
  width: number
  height: number
  fovYDeg: number
  aspect: number
}

export interface PoseTrackFile {
  version: 1
  clientId: string | null
  takeId: string | null
  mimeType: string
  recordedAt: string
  durationMs: number
  nominalFps: number
  hasArSession: boolean
  intrinsics: PoseTrackIntrinsics | null
  frames: Array<{ timestamp: number; pose: Pose; intrinsics?: PoseTrackIntrinsics }>
}

/**
 * Pose sampling interval, in ms.
 *
 * **Adopted.** 50ms (20Hz) is well above the 5fps timestep rate the sequence is
 * sliced at, so every timestep lands between two real samples rather than being
 * extrapolated, and it is cheap next to an AR session already running at 30–60Hz.
 */
export const POSE_SAMPLE_INTERVAL_MS = 50

export class PoseTrack {
  private _samples: PoseSample[] = []
  private _handle: ReturnType<typeof setInterval> | null = null
  private _startedAt = 0
  private _provider: ARProvider | null

  constructor(provider: ARProvider | null) {
    this._provider = provider
  }

  /** Whether a pose track is actually being recorded, as opposed to hoped for. */
  get hasArSession(): boolean { return this._provider !== null }

  get sampleCount(): number { return this._samples.length }

  get samples(): readonly PoseSample[] { return this._samples }

  start(now: number = Date.now()): void {
    if (this._handle !== null) return
    this._startedAt = now
    this._samples = []
    if (!this._provider) return
    this.sampleOnce(now)
    this._handle = setInterval(() => this.sampleOnce(), POSE_SAMPLE_INTERVAL_MS)
  }

  stop(): void {
    if (this._handle !== null) {
      clearInterval(this._handle)
      this._handle = null
    }
  }

  /**
   * Take one sample.
   *
   * A provider that throws mid-recording (tracking lost, session torn down) is
   * skipped rather than allowed to kill the interval — losing part of a track
   * degrades to the densify path, while an exception here would take the
   * recording down with it.
   */
  sampleOnce(now: number = Date.now()): void {
    if (!this._provider) return
    try {
      this._samples.push({ timestamp: now - this._startedAt, pose: this._provider.getPose() })
    } catch { /* tracking unavailable this tick */ }
  }

  /** Camera intrinsics, or null when there is no AR session to ask. */
  intrinsics(width: number, height: number): PoseTrackIntrinsics | null {
    if (!this._provider) return null
    try {
      return {
        width,
        height,
        fovYDeg: this._provider.getCameraFovY(),
        aspect: this._provider.getCameraAspect(),
      }
    } catch {
      return null
    }
  }

  /** The sidecar uploaded beside the clip. */
  toFile(meta: {
    clientId: string | null
    takeId: string | null
    mimeType: string
    recordedAt: string
    durationMs: number
    nominalFps: number
    width: number
    height: number
  }): PoseTrackFile {
    return {
      version: 1,
      clientId: meta.clientId,
      takeId: meta.takeId,
      mimeType: meta.mimeType,
      recordedAt: meta.recordedAt,
      durationMs: meta.durationMs,
      nominalFps: meta.nominalFps,
      hasArSession: this.hasArSession,
      intrinsics: this.intrinsics(meta.width, meta.height),
      frames: this._samples.map(s => ({ timestamp: s.timestamp, pose: s.pose })),
    }
  }
}

/**
 * Median camera speed across a pose track, in m/s.
 *
 * Median rather than mean because a single tracking glitch produces an enormous
 * apparent jump, and one such sample would dominate a mean and report violent
 * motion for a steady capture.
 *
 * Returns `null` for fewer than two samples — with nothing to difference there
 * is no speed, and reporting 0 would claim a measurement that was never made.
 */
export function medianSpeedMps(samples: readonly PoseSample[]): number | null {
  if (samples.length < 2) return null
  const speeds: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].timestamp - samples[i - 1].timestamp) / 1000
    if (dt <= 0) continue
    const a = samples[i - 1].pose.position
    const b = samples[i].pose.position
    const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    if (!Number.isFinite(dist)) continue
    speeds.push(dist / dt)
  }
  if (speeds.length === 0) return null
  speeds.sort((x, y) => x - y)
  const mid = speeds.length >> 1
  return speeds.length % 2 === 1 ? speeds[mid] : (speeds[mid - 1] + speeds[mid]) / 2
}
