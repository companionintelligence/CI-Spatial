/**
 * Runtime anchors as frame discontinuities: the seam between a provider's anchors (src/ar/anchors.ts) and its frame epochs
 * (src/ar/frame-epoch.ts). An anchor that moves, or that the runtime gives up on, says the session frame and the room have
 * parted company, which is what an epoch records. The pose of an anchor is never used to correct a stored point or the Place
 * calibration: this file hears what an anchor reports (onMoved, onLost, onReturned, onExpired) and tells the tracker, and
 * reads no pose (tests/unit/node/wp-17a-anchor-guard.test.ts keeps it so).
 *
 * What is an epoch and what only counts is the tracker's to say (frame-epoch.ts, "What a runtime anchor adds"): a step is, a
 * handle given up is, and a loss that comes back where it was is not. Nothing is decided here.
 *
 * Nothing here is verification. An anchor granted by the browser means the API exists, not that the room is pinned
 * (docs/operations/AR_DEVICE_SUPPORT.md), and no epoch an anchor starts says a frame moved. Pure: no DOM and no AR runtime, so it
 * can be tested without a device.
 */
import type { AnchorCapability } from './anchors.ts'
import type { FrameDiscontinuity, FrameEpochTracker } from './frame-epoch.ts'

export interface AnchorEpochOptions {
  /**
   * Told about each epoch an anchor started, or gave a size to, after the tracker has numbered it. The provider uses it for what it does
   * at any discontinuity (WebXRProvider drops the probe hits not yet handed over, which belong to the epoch before).
   */
  onShift?: (shift: FrameDiscontinuity) => void
  /**
   * Told about what an anchor did that is not itself an epoch (not located, located again, given up), so a device run can read it in the
   * console: a loss no longer begins an epoch, and so no longer leaves a line of its own.
   */
  log?: (...args: unknown[]) => void
}

/**
 * Forwards what `anchors` reports to `tracker`, and returns the function that stops it. The capability drops its listeners
 * when its session ends, so a provider need not call that.
 *
 * A move whose step is a shift (it started an epoch, or joined one) is also rebased: the anchor's drift is counted from where it is
 * now, so the step is not counted again as drift. Without it every anchor that moved with the frame would carry the old frame's
 * distance for the rest of the session. The anchors that did not move are rebased by the provider at every epoch.
 */
export function forwardAnchorEvents(
  anchors: AnchorCapability,
  tracker: FrameEpochTracker,
  options: AnchorEpochOptions = {},
): () => void {
  const started = (shift: FrameDiscontinuity | null): void => {
    if (shift) options.onShift?.(shift)
  }
  const stops = [
    anchors.onMoved((event) => {
      const isShift = tracker.isAnchorShift(event.step)
      started(tracker.noteAnchor(event.atMs, { kind: 'moved', anchorId: event.handle.id, step: event.step, total: event.total }))
      if (isShift) anchors.rebase(event.handle)
    }),
    anchors.onLost((event) => {
      tracker.noteAnchor(event.atMs, { kind: 'lost', anchorId: event.handle.id, how: event.how })
      options.log?.(`anchor ${event.handle.id} not located (${event.how})`)
    }),
    anchors.onReturned((event) => {
      tracker.noteAnchor(event.atMs, { kind: 'returned', anchorId: event.handle.id, awayMs: event.awayMs })
      options.log?.(`anchor ${event.handle.id} located again after ${Math.round(event.awayMs)} ms`)
    }),
    anchors.onExpired((event) => {
      started(tracker.noteAnchor(event.atMs, { kind: 'expired', anchorId: event.handle.id, awayMs: event.awayMs }))
      options.log?.(`anchor ${event.handle.id} not located again in ${Math.round(event.awayMs)} ms: given up`)
    }),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
