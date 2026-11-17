/**
 * The window, the watchdog and the cleanup of a hit-test burst.
 *
 * Both providers answer `hitTestBurstAsync()` the same way: open something that
 * delivers one frame at a time (8th Wall: a pipeline module; WebXR: a hit-test
 * source), record each frame, and close it when the window is over. What has to
 * be right is not that, it is everything around it: the burst must settle once,
 * never later than the watchdog, and release what it opened on every road out
 * (the window ended, the engine stopped delivering frames, the session ended,
 * registering it threw). That lives here once, pure, so a test can walk every
 * road without an AR session.
 */
import type { BurstFrameListener, HitBurst, HitBurstFrame } from './provider.ts'

/** What a provider drives while its burst runs. */
export interface BurstRun {
  /**
   * Record one frame. `nowMs` is the runtime's own clock for this frame (rAF time, `performance.now()`): the
   * window runs from the first frame's, not from the call, so the time spent opening a hit-test source is not
   * taken out of it. Closes the burst once the window is over. Ignored after the burst is closed.
   */
  frame(frame: HitBurstFrame, nowMs: number): void
  /** Close the burst now: the session ended, or the thing that delivers frames failed. Safe to call twice. */
  finish(): void
  /** True once the burst is closed. A frame callback that arrives after it must do nothing. */
  readonly done: boolean
}

export interface BurstOptions {
  /**
   * Close the burst, empty, if no frame has come this long after the call: the thing that should deliver
   * frames never did, and a tap should not be held for the whole watchdog to learn it. A frame inside it
   * cancels it. Unset, there is no such deadline and the watchdog alone applies.
   */
  firstFrameMs?: number
  /** Told about each frame as it is recorded. See `BurstFrameListener`. */
  onFrame?: BurstFrameListener
}

/**
 * Run one burst. `start` opens whatever delivers the frames, feeds them to the `BurstRun`, and returns the
 * function that releases it. That function runs exactly once however the burst ends, including when `start`
 * itself closed the burst before returning, and a throw from it is swallowed: what it held is gone.
 *
 * Resolves with every frame recorded, in order. Never rejects. If `start` throws, resolves with the frames so far,
 * and releases nothing: `start` must open its thing last, so that a throw leaves nothing open. `graceMs` is how
 * long past the window the watchdog waits for a frame that never comes.
 */
export function collectBurst(
  windowMs: number,
  graceMs: number,
  start: (run: BurstRun) => () => void,
  options: BurstOptions = {},
): Promise<HitBurst> {
  const windowLength = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0
  return new Promise((resolve) => {
    const frames: HitBurstFrame[] = []
    let done = false
    let firstMs: number | null = null
    let release: (() => void) | null = null
    let released = false

    const releaseOnce = (): void => {
      if (released || !release) return
      released = true
      try {
        release()
      } catch {
        // Whatever it was releasing is already gone with its session.
      }
    }

    const run: BurstRun = {
      get done() {
        return done
      },
      frame(frame, nowMs) {
        if (done) return
        frames.push(frame)
        firstMs ??= nowMs
        if (frames.length === 1) clearTimeout(firstFrameDeadline)
        try {
          options.onFrame?.(frame, nowMs - firstMs)
        } catch {
          // A screen that fails to draw a ring must not cost the tap its reading.
        }
        if (nowMs - firstMs >= windowLength) run.finish()
      },
      finish() {
        if (done) return
        done = true
        clearTimeout(watchdog)
        clearTimeout(firstFrameDeadline)
        releaseOnce()
        resolve({ frames })
      },
    }

    const watchdog = setTimeout(() => run.finish(), windowLength + (Number.isFinite(graceMs) ? Math.max(0, graceMs) : 0))
    const firstFrameDeadline = options.firstFrameMs !== undefined && Number.isFinite(options.firstFrameMs)
      ? setTimeout(() => run.finish(), options.firstFrameMs)
      : undefined
    try {
      release = start(run)
    } catch {
      run.finish()
      return
    }
    // `start` may have closed the burst before it returned the function that releases it.
    if (done) releaseOnce()
  })
}
