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
 * The statuses the runtimes publish, plus `UNKNOWN` for runtimes that report
 * nothing. Names match the runtime's own strings exactly — they are compared
 * as-is, not normalised.
 *
 * What 8th Wall documents is a `trackingStatus` of LIMITED or NORMAL and a
 * `trackingReason` of INITIALIZING or UNSPECIFIED
 * (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule; the same page
 * writes UNDEFINED for the reason in its event section). The sets in this file are
 * wider than that on purpose, and the names beyond the documented ones are handled
 * in case a runtime reports them, not because one is known to: NOT_AVAILABLE is what
 * this app calls a frame with no pose (WebXR with no viewer pose, a burst frame
 * with no reality), INITIALIZING as a *status* is the native shell's word
 * (native-provider.ts), and UNSPECIFIED, which reaches `trackingStatus()` through a
 * cast, is not in the union below. All of them are judged by
 * `trackingIsStableForPlacement()`. Which names a phone actually reports has to be
 * logged on a phone: device experiment DX4 (frame shifts and drift) records every
 * status and reason transition, and the sets keep or lose a name by what that log
 * shows. The `[8thwall] trackingStatus:` and `[webxr] trackingStatus:` lines
 * (`?debug=remote,verbose`) are where the transitions are written.
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
 * usable. A closed rule would silently stop a runtime that reports no status
 * (`WebXRProvider` says `UNKNOWN` until its first frame has been read) from
 * accumulating any points at all, turning a data-quality fix into a total
 * capture regression on that runtime. Dropping some debris is worth far less
 * than dropping every point.
 */
export function trackingIsUsable(status: string | null | undefined): boolean {
  if (!status) return true
  return !UNUSABLE.has(status)
}

// ── Placing a calibration marker (WP-05a) ───────────────────────────────────
//
// `trackingIsUsable()` above decides whether geometry may be RECORDED, and fails
// open so a runtime with no signal keeps working. A calibration tap asks more of
// the same signal: it becomes the Place's reference frame, stored and compared
// against on every later visit, so a tap taken while the map is shifting is
// worth far more to refuse than a stray point is to drop.

/**
 * Reasons that make a frame unfit for placement even beside a status that reads
 * NORMAL. They are read from the runtime's `trackingReason`. INITIALIZING is the one
 * 8th Wall documents (see `TrackingStatus` above); RELOCALIZING, TOO_MUCH_MOTION and
 * NOT_ENOUGH_TEXTURE are not in its documentation and are refused in case the engine
 * reports them (DX4 logs which reasons occur). A reason only ever makes the verdict
 * worse: one that is on this list refuses a frame, and none turns a refused status into a
 * passing one. A reason that is not on this list changes nothing, the status decides.
 */
const UNSTABLE_REASONS: ReadonlySet<string> = new Set([
  'INITIALIZING',
  'RELOCALIZING',
  'TOO_MUCH_MOTION',
  'NOT_ENOUGH_TEXTURE',
])

/**
 * Whether a calibration marker may be placed in a frame the runtime reports as
 * `status` / `reason`.
 *
 * Only a positive NORMAL passes, with one deliberate exception. The truth table:
 *
 * | status                                           | reason                       | stable |
 * | ------------------------------------------------ | ---------------------------- | ------ |
 * | NORMAL                                           | none, UNSPECIFIED, or unknown| yes    |
 * | NORMAL                                           | INITIALIZING, RELOCALIZING, TOO_MUCH_MOTION, NOT_ENOUGH_TEXTURE | no |
 * | LIMITED, NOT_AVAILABLE, INITIALIZING             | any                          | no     |
 * | UNSPECIFIED (no status said yet)                 | any                          | no     |
 * | any other string, including a different case     | any                          | no     |
 * | UNKNOWN, empty or absent (the runtime has no signal: WebXR) | none or UNSPECIFIED | yes |
 * | UNKNOWN, empty or absent                         | a bad reason                 | no     |
 *
 * **Closed, unlike `trackingIsUsable()`.** A status this build does not know, or
 * UNSPECIFIED, is not evidence of tracking, so it does not pass:
 * the cost is a tap that has to wait, and it shows. The one open case is a
 * runtime that publishes no status at all. Refusing there would stop WebXR from
 * ever calibrating, and nothing here could tell it from a healthy session, so
 * its only guards are the ones that read the poses: a burst frame with no
 * viewer pose is reported as NOT_AVAILABLE (refused above), a camera that steps
 * farther than `BURST_POSE_JUMP_M` between two frames of a burst, and the time
 * check in `placementDisturbed()`.
 *
 * **Needs a device.** That an iPhone reaches NORMAL, and what the runtime reports
 * while it does not, has not been seen on a phone: only the documented LIMITED and
 * NORMAL are known (see `TrackingStatus`), and DX4 logs every status and reason
 * transition. If a runtime never left UNSPECIFIED this would refuse every tap.
 */
export function trackingIsStableForPlacement(
  status: string | null | undefined,
  reason?: string | null,
): boolean {
  if (reason && UNSTABLE_REASONS.has(reason)) return false
  if (!status || status === 'UNKNOWN') return true
  return status === 'NORMAL'
}

/** What a tap is told while `trackingIsStableForPlacement()` says no. The wording is the brief's. */
export const TRACKING_RECOVERING_TEXT = 'Hold still, tracking is recovering'

/**
 * Farthest the camera may move between two consecutive frames of one tap's burst, in metres, before the burst is
 * read as straddling a map shift. A hand does not cover thirty centimetres in a thirtieth of a second, a map that
 * redefines its origin does.
 *
 * Inside a burst it is the only shift detector WebXR's frames have: they carry a camera pose, or none, and no count
 * of pose jumps, so a shift shows there only as the viewer pose stepping. Both providers keep a running count between
 * taps (`getTrackingDiagnostics().poseJumps`, src/ar/frame-epoch.ts), and 8th Wall's burst frames carry it.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** The same figure as `POSE_JUMP_THRESHOLD_M` in eighthwall.ts, which
 * counts jumps between every pair of frames; a second constant because that file cannot be imported without the
 * engine. DX4 (frame shifts and drift over a walk) sizes both.
 */
export const BURST_POSE_JUMP_M = 0.30

/**
 * Whether two camera positions, taken in consecutive frames, are farther apart than a hand can move in one frame.
 * A position that is not a finite number says nothing, so it is not a jump.
 */
export function cameraJumped(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): boolean {
  const moved = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  return Number.isFinite(moved) && moved > BURST_POSE_JUMP_M
}

/**
 * Longest the person may take between confirming the landmark and committing
 * the frame, in milliseconds. Past it the landmark is asked for again: the walk
 * to the heading marker is where SLAM drifts or shifts, and the frame is built
 * from a pair of points that must belong to one map.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** 90 s is the figure the work
 * package proposed. DX4 (frame shifts and drift over a walk) sets it.
 */
export const LANDMARK_TO_COMMIT_BUDGET_MS = 90_000

/** What the calibration flow records at the landmark and reads again before it commits. */
export interface PlacementWatch {
  /** `getTrackingDiagnostics().poseJumps` at landmark confirm, and now. Unset where the provider keeps no count. */
  poseJumpsAtConfirm?: number
  poseJumpsNow?: number
  /** The provider's frame epoch at landmark confirm, and now. Unset until a provider has one. */
  epochAtConfirm?: number
  epochNow?: number
  /** Milliseconds since the landmark was confirmed. */
  elapsedMs: number
}

/** Why a placement was disturbed, in the order the checks run. */
export type PlacementDisturbance = 'epoch-changed' | 'pose-jump' | 'too-long'

export type PlacementVerdict = { disturbed: false } | { disturbed: true; reason: PlacementDisturbance }

/** Two readings of one counter differ. A counter that is missing or not a finite number says nothing. */
function counterChanged(then: number | undefined, now: number | undefined): boolean {
  return typeof then === 'number' && Number.isFinite(then) && typeof now === 'number' && Number.isFinite(now) && then !== now
}

/**
 * Whether the frame the landmark was confirmed in can still be trusted at commit.
 *
 * A counter that differs in either direction counts: a pose-jump count that fell
 * means the provider restarted and lost its tally, which is itself a disturbance.
 * A counter or a clock that is missing or not finite is no evidence, so it never
 * disturbs; the budget is `LANDMARK_TO_COMMIT_BUDGET_MS`, and exactly that long
 * is still inside it.
 */
export function placementDisturbed(watch: PlacementWatch): PlacementVerdict {
  if (counterChanged(watch.epochAtConfirm, watch.epochNow)) return { disturbed: true, reason: 'epoch-changed' }
  if (counterChanged(watch.poseJumpsAtConfirm, watch.poseJumpsNow)) return { disturbed: true, reason: 'pose-jump' }
  if (Number.isFinite(watch.elapsedMs) && watch.elapsedMs > LANDMARK_TO_COMMIT_BUDGET_MS) {
    return { disturbed: true, reason: 'too-long' }
  }
  return { disturbed: false }
}

/** What the person is told when a placement was disturbed and the flow goes back to the landmark. */
export function placementDisturbedText(reason: PlacementDisturbance): string {
  return reason === 'too-long'
    ? `That took over ${LANDMARK_TO_COMMIT_BUDGET_MS / 1000} seconds, tap the landmark again`
    : 'Tracking was disturbed, tap the landmark again'
}

/**
 * The counters a provider publishes about frame shifts. `ARProvider.getTrackingDiagnostics()` returns this and
 * more. `epoch` is the frame epoch the provider keeps once it has one (WP-09); until then it is simply absent.
 */
export interface ShiftCounters {
  poseJumps?: number
  epoch?: number
}

/** A confirmed landmark, watched until the frame is committed. */
export interface LandmarkWatch {
  /** Whether the frame the landmark was confirmed in can still be trusted, as of now. */
  check(): PlacementVerdict
}

/**
 * Start watching a landmark at the moment it is confirmed. `read` gives the provider's counters
 * (`() => provider.getTrackingDiagnostics?.()`); a read that returns nothing or throws is no evidence, not a
 * disturbance. The calibration flow calls `check()` at the heading tap and again at commit, and goes back to the
 * landmark stage, keeping the reference photos, when it says `disturbed`.
 *
 * The one place the counters are read at confirm and compared at commit, so that the flow has nothing to get
 * wrong but the two calls.
 */
export function watchLandmark(
  read: () => ShiftCounters | null | undefined,
  now: () => number = Date.now,
): LandmarkWatch {
  // The numbers are copied: a provider may hand back the live object it keeps them in.
  const sample = (): ShiftCounters => {
    try {
      const counters = read()
      return { poseJumps: counters?.poseJumps, epoch: counters?.epoch }
    } catch {
      return {}
    }
  }
  const atConfirm = sample()
  const confirmedAt = now()
  return {
    check: () => {
      const latest = sample()
      return placementDisturbed({
        poseJumpsAtConfirm: atConfirm.poseJumps,
        poseJumpsNow: latest.poseJumps,
        epochAtConfirm: atConfirm.epoch,
        epochNow: latest.epoch,
        elapsedMs: now() - confirmedAt,
      })
    },
  }
}
