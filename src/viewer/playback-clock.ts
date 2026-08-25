/**
 * A wall-clock playhead.
 *
 * The viewer's render loop has never had a delta-time clock — every layer in it
 * is static, and `AnimationMixer`, `gltf.animations` and `THREE.VideoTexture`
 * appear zero times in the codebase. A 4D person is the first thing here that
 * moves, so this is the app's first playback clock.
 *
 * Deliberately tiny, and deliberately *separable*. The general timeline
 * scrubber is tracked as `docs/factory/08-places-and-things/0008-timeline-scrubber.md`
 * and spans scans and edit history, not one asset. Rather than become a rival
 * time system — the parallel-systems duplication ADR 0001 exists to prevent —
 * the layer exposes `setPlayhead(seconds)` and this class is only the thing
 * that drives it. When the shared scrubber lands, this is deleted and the
 * scrubber drives the same seam; the layer does not change.
 *
 * Driven by wall time rather than frame count, so playback rate is independent
 * of render rate.
 */
export interface PlaybackClockOptions {
  /** Sequence length in seconds. */
  durationSec: number
  loop?: boolean
  onTick: (seconds: number) => void
  /** Injected for tests. */
  now?: () => number
}

export class PlaybackClock {
  private _opts: PlaybackClockOptions
  private _now: () => number
  private _playing = false
  private _playhead = 0
  private _lastAt = 0
  private _raf: number | null = null

  constructor(opts: PlaybackClockOptions) {
    this._opts = opts
    this._now = opts.now ?? (() => performance.now())
  }

  get playing(): boolean { return this._playing }
  get playhead(): number { return this._playhead }
  get duration(): number { return this._opts.durationSec }

  play(): void {
    if (this._playing || this._opts.durationSec <= 0) return
    this._playing = true
    this._lastAt = this._now()
    this._schedule()
  }

  pause(): void {
    this._playing = false
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf)
      this._raf = null
    }
  }

  /** Jump to a time. Clamped, and emits immediately so a scrub feels direct. */
  seek(seconds: number): void {
    this._playhead = Math.max(0, Math.min(seconds, this._opts.durationSec))
    this._lastAt = this._now()
    this._opts.onTick(this._playhead)
  }

  /**
   * Advance by real elapsed time.
   *
   * Exposed so tests can step the clock deterministically without a
   * `requestAnimationFrame` loop or a real timer.
   */
  advance(nowMs: number): void {
    if (!this._playing) return
    const dt = (nowMs - this._lastAt) / 1000
    this._lastAt = nowMs
    if (dt <= 0) return

    let next = this._playhead + dt
    if (next >= this._opts.durationSec) {
      if (this._opts.loop !== false) {
        // Modulo rather than reset to 0: a 5s clip at 60fps would otherwise
        // drop the remainder every lap and drift slow.
        next = this._opts.durationSec > 0 ? next % this._opts.durationSec : 0
      } else {
        next = this._opts.durationSec
        this._playing = false
      }
    }
    this._playhead = next
    this._opts.onTick(next)
  }

  dispose(): void {
    this.pause()
  }

  private _schedule(): void {
    if (typeof requestAnimationFrame !== 'function') return
    this._raf = requestAnimationFrame(() => {
      this._raf = null
      if (!this._playing) return
      this.advance(this._now())
      this._schedule()
    })
  }
}

/**
 * Frame index for a playhead.
 *
 * Floor rather than round: frame N covers [N/fps, (N+1)/fps), so a playhead
 * exactly on a boundary belongs to the frame that starts there.
 */
export function frameIndexAt(seconds: number, fps: number, frameCount: number): number {
  if (frameCount <= 0 || fps <= 0) return 0
  const idx = Math.floor(seconds * fps)
  return Math.max(0, Math.min(idx, frameCount - 1))
}

/**
 * Frames that should be resident for a playhead.
 *
 * A windowed loader, because a `SplatMesh` per timestep holds real GPU memory
 * and a full sequence of a detailed person will not fit. Wraps around the end so
 * looping playback does not stall on the seam.
 */
export function windowAround(index: number, radius: number, frameCount: number): number[] {
  if (frameCount <= 0) return []
  const span = Math.min(frameCount, radius * 2 + 1)
  const out: number[] = []
  for (let i = 0; i < span; i++) {
    out.push(((index - radius + i) % frameCount + frameCount) % frameCount)
  }
  return [...new Set(out)]
}
