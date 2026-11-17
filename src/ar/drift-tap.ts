/**
 * How the drift check reads a tap: through `sampleTap` (./tap-sampling.ts), the one reader that judges a tap by a burst
 * of hits and refuses an unsteady one, and not one hit snapped to a feature.
 *
 * A closure compares a re-tap with a point set by an earlier tap, so the re-tap's own jitter is what the check cannot
 * tell from drift (src/ar/closure.ts keeps its limits above it). The burst's median is the smallest that jitter can be
 * made. The reader is built here, in one place, so that the way a tap is read for the check is changed in one place:
 * the calibration flow reads its own taps through the same function once WP-05b wires it in, and a build that has not
 * merged that has this one only. `hitTest` is the host's single-hit test, which `sampleTap` falls back to when the
 * provider has no burst or its burst saw no frame, and which WebXR needs because its synchronous hit test answers null.
 *
 * The fitted floor is read at each tap, not once: the floor estimate settles as the scan goes on. It takes part as a
 * cross-check (`floorRay: 'cross-check'`), as the calibration flow's does, so it can disagree with the hits and say so
 * without moving the point: nothing has measured the floor ray against a taped point yet (device experiment DX5).
 */
import type { HitResult } from './provider.ts'
import type { GroundReading } from './ground-gate.ts'
import { sampleTap, type TapProvider, type TapResult } from './tap-sampling.ts'

export interface DriftTapSources {
  provider: TapProvider
  /** The host's own hit test: one hit at normalised canvas coordinates. */
  hitTest: (x: number, y: number) => Promise<HitResult | null>
  /** The point cloud's current floor estimate, or null before there is one. */
  ground: () => GroundReading | null
}

/** A function that reads one tap at normalised canvas coordinates, as `ReanchorHost.readTap` wants. */
export function driftTapReader(sources: DriftTapSources): (x: number, y: number) => Promise<TapResult> {
  return (x, y) =>
    sampleTap(sources.provider, x, y, {
      singleHit: sources.hitTest,
      floor: sources.ground(),
      floorRay: 'cross-check',
    })
}
