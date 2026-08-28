/**
 * Live tracking quality, as reported by the AR runtime itself.
 *
 * Split from the providers so the rule can be tested without an AR session, and
 * because two callers (point accumulation and, later, keyframe streaming) need
 * to agree on what "good enough to record" means.
 *
 * `ARProvider.isTracking()` cannot answer this: it latches true on the first
 * pose and is never cleared (see its own doc comment). 8th Wall publishes a
 * live `trackingStatus` on every reality frame, which `EighthWallProvider`
 * logged and discarded — so a session that degraded to `LIMITED` kept feeding
 * points into the cloud from a frame that had already drifted.
 *
 * Measured cost of that, 2026-08-27, one gimbal dome of a single room: 80.7% of
 * points landed within 3m of the cloud's median centre (p50 0.80m), but the
 * cloud's full extent was 60.9 x 39.0 x 48.7 m — p95 24m, p99 44m. The room is
 * the compact 80%; the rest is tracking-loss debris. Those outliers are not
 * cosmetic: they set the bounding box that downstream metric fits key off, so
 * splat-align and COLMAP inherit a scale that is wrong by an order of magnitude.
 */

/**
 * The statuses 8th Wall publishes, plus `UNKNOWN` for runtimes that report
 * nothing. Names match the runtime's own strings exactly — they are compared
 * as-is, not normalised.
 */
export type TrackingStatus = 'INITIALIZING' | 'LIMITED' | 'NORMAL' | 'NOT_AVAILABLE' | 'UNKNOWN'

/**
 * Statuses whose poses are NOT trustworthy enough to record geometry against.
 *
 * `INITIALIZING` is included deliberately: before SLAM converges the pose is a
 * guess, and points added then are placed against a frame that is about to move
 * underneath them.
 */
const UNUSABLE: ReadonlySet<string> = new Set<TrackingStatus>(['INITIALIZING', 'LIMITED', 'NOT_AVAILABLE'])

/**
 * Whether geometry captured in this frame should be kept.
 *
 * **Fails open.** Anything not explicitly known-bad — including `UNKNOWN`, and
 * including any status string a future runtime version invents — counts as
 * usable. A closed rule would silently stop `WebXRProvider` (which has no
 * equivalent signal and always reports `UNKNOWN`) from accumulating any points
 * at all, turning a data-quality fix into a total capture regression on that
 * runtime. Dropping some debris is worth far less than dropping every point.
 */
export function trackingIsUsable(status: string | null | undefined): boolean {
  if (!status) return true
  return !UNUSABLE.has(status)
}
