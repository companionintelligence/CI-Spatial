/**
 * Frame epochs: which stretch of tracking a point, a pose or a keyframe was recorded in.
 *
 * An AR runtime promises one rigid coordinate frame only for as long as its tracking
 * holds. After a loss and a relocalization, a resume, or a recentre, the runtime may
 * have redefined its origin, and everything recorded afterwards sits in a frame that
 * is not the one the earlier geometry, and the Place calibration, were made in. Nothing
 * in the app could tell: the pose kept updating, the status read NORMAL again, and the
 * scan still read ready. An EPOCH is one such stretch. The number goes up by one at each
 * discontinuity, never down, and a provider with no signal stays at epoch 0.
 *
 * This file holds three things, all pure (no DOM, no AR runtime) so they can be tested
 * without a device:
 *
 *   - FrameEpochTracker: fed one sample per frame by a provider, it decides what counts
 *     as a discontinuity and keeps the epoch number, the jump log and the counters.
 *   - The shapes a provider exposes (`getFrameEpoch`, `onFrameDiscontinuity`,
 *     `TrackingDiagnostics`; see ARProvider in ./provider.ts).
 *   - ScanFrameEpochLog: what ONE SCAN has seen of them, and the record written into the
 *     upload sidecar (src/export/gltf.ts).
 *
 * ## What a discontinuity is, and how sure each kind is
 *
 *   'jump'       the pose moved or turned between two frames by more than smooth motion
 *                explains. MEASURED: the numbers are in the event.
 *   'reset'      the runtime said so (WebXR's reference-space `reset` event). REPORTED by
 *                the runtime; its transform is in the event when the runtime gave one.
 *   'recovered'  tracking came back after a relocalization, or after at least
 *                RECOVERY_SUSPECT_MS without it. SUSPECT: the pose may be in a new frame
 *                and nothing here can tell. The size of the move is recorded.
 *   'resumed'    the page or the engine was paused and resumed. SUSPECT, for the same reason.
 *   'anchor'     a runtime anchor (src/ar/anchors.ts) stepped by at least ANCHOR_STEP_TRANSLATION_M or
 *                ANCHOR_STEP_YAW_DEG between two of its reports, or the runtime did not locate one again in time
 *                and nothing else accounts for it. A step is MEASURED, at the anchor: it says the anchor and the
 *                session frame disagree by that much now, and not which of the two moved. A handle given up is
 *                SUSPECT: nothing was measured, and the anchor that could have said is gone.
 *
 * "Suspect" is deliberate. The audit's own words for a frame shift are "otherwise
 * undetectable from inside the app", so a suspect event starts a new epoch (which costs a
 * ground refit and a review flag) instead of being trusted not to matter. How often each
 * kind really moves the frame is not known (device experiment DX4).
 *
 * One trip away is one epoch. A resume, the reset the runtime reports with it, and the
 * seconds a runtime may then spend re-establishing tracking are one disturbance: the epoch
 * the resume began is kept, and the later reports add to its record (`noteReset`,
 * the `recovered` branch of `observe`) instead of starting more.
 *
 * Start-up is not a loss. Tracking cannot be lost before the runtime has called it NORMAL
 * once: a runtime that begins short of NORMAL while it initialises (LIMITED, or a status this
 * build does not know) has not lost anything yet, so its first NORMAL starts nothing. (A
 * runtime that reports no status at all has no recoveries to count; its pose jumps are seen
 * from its first pose.) A session that ends and another that starts is a new map, and its
 * first trustworthy frame starts an epoch.
 *
 * ## How a jump is told from motion
 *
 * A person aims a phone in sweeps. A fixed cap on how fast a pose may move (240 degrees per
 * second and 5 m/s, say) cannot tell a quick re-aim from the map moving: an ordinary 90 degree
 * re-aim in 0.4 s peaks near 420 degrees per second, and at 30 fps that cap read nearly every
 * frame of it as a shift, and none at 120 fps. A frame shift is a step in the pose that smooth
 * motion does not predict. So each step (the move from one frame to the next) is compared with
 * the step before it:
 *
 *   unexplained move = the step, minus what the previous step predicts for this interval
 *
 * The prediction is the better of two: the same RATE over this interval (right when the
 * frame times are exact and a late frame is simply longer) and the same STEP as last time
 * (right when the frame times are only as exact as the page's animation frame, as they are
 * when a runtime gives no frame time of its own). A step is a jump when its unexplained part is at
 * least the floor (FRAME_JUMP_TRANSLATION_M, FRAME_JUMP_YAW_DEG) and at least what the
 * fastest hand could have changed the motion by in that time (MAX_HAND_ACCELERATION_MPS2,
 * MAX_TURN_ACCELERATION_DPS2). A pose that stops dead after a stall, or a turn that
 * speeds up, is inside that; a pose that steps sideways is not.
 *
 * What it cannot see (stated so nobody reads "no shifts" as more than it is). The numbers
 * are what the constants give, measured on the real tracker (tests in frame_epoch.test.ts pin
 * them); DX4 sets the constants:
 *
 *   - steady frames at 30 fps, and anything faster: a shift of 0.30 m, or of 8 degrees, is seen.
 *     At 5 m, 8 degrees moves content by 0.70 m, which is more than twice the 0.305 m the
 *     product targets, so there are shifts under the floor that matter. Two under-floor
 *     shifts at once (0.29 m and 7.9 degrees) are not seen either.
 *   - steady frames at a lower rate: a hand can change a turn by more in a longer frame, so a
 *     turn has to be 12.5 degrees at 20 fps and 22 degrees at 15 fps (0.30 m at both).
 *   - late frames: the same allowance grows with the square of the gap. After one dropped
 *     frame (67 ms) a turn must be 17 degrees to be seen, after a 100 ms stall 33, after a
 *     200 ms stall 117; a move, 0.30 m up to 100 ms and 0.70 m at 200 ms. A shift inside a gap
 *     that long is not seen; the same shift on steady frames is.
 *   - slow correction: a map corrected over seconds moves like a person does, and is not a
 *     jump. Nothing in this slice measures drift (no closure check yet).
 *   - the first step after a reset, a resume, a jump or a recovery has no step before it to be
 *     compared with, and is not judged. A shift in the step right after another is part of it.
 *   - NOT_AVAILABLE is this app's word for a frame with no pose (WebXR's null viewer pose, or a
 *     runtime that reports the status; 8th Wall's documentation lists only LIMITED and NORMAL),
 *     and whatever such a frame carries is not read as a pose. The step from the last pose
 *     before it to the first after it is the late frames case above, over the whole gap. What
 *     moved while there was none shows only if the recovery is suspect (a relocalization, or
 *     RECOVERY_SUSPECT_MS), and then as a recovery, whose size is the whole displacement and so
 *     includes what a person walked.
 *
 * The steps between frames the runtime is unsure of (LIMITED, INITIALIZING) are judged like any
 * other, as the detector this replaced (in src/ar/eighthwall.ts) counted every step whatever
 * the status. The step to the first NORMAL frame is measured from the last frame that had a
 * pose, not from before the loss: what a person walked during the loss is not a shift, and
 * what the pose did at the moment it came back is.
 *
 * ## What a runtime anchor adds
 *
 * Where the browser grants it, a WebXR session can hold anchors: points the runtime itself keeps pinned to the room
 * (src/ar/anchors.ts). `noteAnchor()` is how a provider tells the tracker what they did. An anchor is a measuring stick
 * and never a frame: nothing here moves a stored point or the Place calibration to follow one (a scan carries one matrix,
 * and the points recorded before a correction sit in the old frame), so what an anchor reports is an epoch like any other
 * and the one-scan-one-frame rule answers it.
 *
 * An anchor sees the same disturbances the viewer's own signals do, from a second place, so it starts an epoch only for
 * what nothing else accounts for:
 *
 *   - A step of at least ANCHOR_STEP_TRANSLATION_M, or turning by at least ANCHOR_STEP_YAW_DEG about the vertical, is an
 *     epoch. The capability reports a move once it passes its own, smaller, threshold (a centimetre and half a degree),
 *     so a "step" is the movement since the last report: at most that threshold plus what the last frame moved it. A slow
 *     correction never reaches it, and is what the drift flag is for.
 *   - An anchor the runtime stops locating (it left the set of tracked anchors, or is listed with no pose) is not an epoch
 *     when it goes. ARCore pauses every anchor whenever camera tracking pauses, so a loss is what every blip looks like, and
 *     the viewer's own rule does not count a blip either (RECOVERY_SUSPECT_MS). An anchor that comes back where it was has
 *     measured that the frame did not move against it, and that is more than a recovery can say. It is counted
 *     (`diagnostics().anchors.lost`), and the capability keeps its handle for ANCHOR_RETURN_WINDOW_MS. It becomes an epoch in
 *     two cases: it comes back displaced, which is a step, or the handle is given up, which is suspect (nothing was
 *     measured, and the anchor that could have said whether the frame moved is gone). Whether Chrome gives the same anchor
 *     object back after a loss, and after how long, is not confirmed (device experiment DX6).
 *   - One disturbance is one epoch, whoever sees it first. A step, or a handle given up, joins an epoch that something else
 *     began, and starts none, when it comes while a resume, a reset or a stretch of bad tracking that has its epoch is
 *     still going, or within FRAME_JUMP_REFRACTORY_MS of the moment one ended or began; or when the anchor went while such
 *     an epoch was going, or any epoch began while it was away. These are counted in `diagnostics().anchors.folded`. The
 *     epoch a resume, or a reset that came with no transform, began has no size of its own: the first step an anchor measures
 *     in it becomes its size and counts as the frame shift it is. That is what a runtime anchor is for: the resume cannot
 *     say how far the frame moved, and an anchor that comes back displaced can.
 *   - How far an anchor is from where it was first located (or last rebased) is kept as the epoch's drift. Past
 *     ANCHOR_DRIFT_TRANSLATION_M or ANCHOR_DRIFT_YAW_DEG it is a quality flag (`diagnostics().anchors.driftFlagged`), not
 *     an epoch: it is what a "Check drift" prompt reads. A new epoch starts the count again, and the provider rebases the
 *     anchors it can locate at every epoch so that what they report next is measured from the new frame.
 *
 * ## Numbers that were not measured
 *
 * Every threshold below is ADOPTED, not measured (ADR 0005 rule 5). DX4 (a ten-minute
 * perimeter walk, five runs per device, logging every status and reason transition and
 * every pose jump) is what sets them, and DX6 (anchor drift over 60 s and 10 min, losses of
 * 3, 10 and 30 s, on a Chrome ARCore phone and a Quest) sets the anchor ones. They are the one
 * place to change when it reports.
 * `motion` in the diagnostics and the sidecar keeps the distribution of step sizes, step
 * times and unexplained moves, so a scan's own record says where the benign p99 sits.
 */
import type { Pose } from './provider'
import type { AnchorLossKind, AnchorMovement } from './anchors'
import type { GroundEstimate } from '../scene/pointcloud'
import type { FrameClosureRecord } from './closure'

// ── Adopted constants ───────────────────────────────────────────────────────

/**
 * Smallest unexplained translation in one step that reads as a jump, in metres.
 *
 * Carried over unchanged from `POSE_JUMP_THRESHOLD_M` in src/ar/eighthwall.ts, where it
 * was already "adopted by decision, not by measurement" (ticket 0006 closed unrun). It is
 * now a floor under the motion a step could contain by acceleration, not a fixed
 * per-frame distance, so a late frame no longer reads as a shift for being late.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const FRAME_JUMP_TRANSLATION_M = 0.30

/**
 * Smallest unexplained turn about the vertical in one step that reads as a jump, in degrees.
 * The old detector looked at translation only, so a map that turned under a camera that
 * did not move (a relocalization) counted nothing.
 *
 * 8 degrees: it sits above the 6 degrees one frame of a hard 180 degrees-per-second turn
 * adds and below the 10 degrees an in-place shift has to be seen at. At 5 m, 8 degrees
 * moves content by 0.70 m.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const FRAME_JUMP_YAW_DEG = 8

/**
 * The fastest a hand can change the velocity of the phone, in m/s squared. It sets how
 * much of a step the previous step may fail to predict. 30 m/s squared is about 3 g: a
 * fast flick of the arm (0.5 m in 0.3 s peaks near 30).
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const MAX_HAND_ACCELERATION_MPS2 = 30

/**
 * The fastest a person can change the turn rate of the phone, in degrees per second
 * squared. A smooth re-aim of 120 degrees in 0.35 s, which is fast, peaks near 5 600; an
 * ordinary 90 degrees in 0.4 s near 3 200. This sits above the ordinary and below the
 * violent: a flick of 150 degrees in 0.2 s (21 600) will still read as a shift, at some
 * frame rates. Whether a runtime has reported LIMITED by then is not known (DX4).
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const MAX_TURN_ACCELERATION_DPS2 = 5_000

/**
 * The largest ratio between two consecutive frame intervals at which "the same step as
 * last time" still counts as a prediction of this one. It exists for frame times that are
 * only as exact as the page's animation frame: a 30 fps camera on a 60 Hz page reads as
 * intervals of 17, 33 and 50 ms for what is one steady 33 ms, a ratio of up to 3. Past it
 * the two intervals are not the same kind of thing (a stall, a dropped frame), and the only
 * prediction is the same rate: otherwise a step that is the size of the stalled one, right
 * after it, would read as no change.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const MAX_COMPARABLE_STEP_RATIO = 4

/**
 * After a jump, further jumps within this many milliseconds are one disturbance with it,
 * not new ones. An engine that corrects its map over a few frames, or a threshold that is
 * too tight for a quick sweep, would otherwise start an epoch per frame: each costs the
 * undrained points and the ground lock, and a scan of dozens of epochs says nothing
 * a scan of two does not. The suppressed ones are counted (`suppressedJumps`), so a run
 * that hits this often shows that the thresholds are too tight.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const FRAME_JUMP_REFRACTORY_MS = 500

/**
 * How long tracking has to be missing, in milliseconds, before its return counts as a
 * 'recovered' discontinuity. A relocalization always counts, whatever its length.
 *
 * A map that stays in place survives a blink; a second without tracking is long enough
 * for the camera to have been carried somewhere the map cannot place it, and for the
 * runtime to have started over. Counting every LIMITED blip instead would flag nearly
 * every handheld scan (a quick turn is enough), and a flag on every scan is read as no
 * flag. The time spent degraded is counted separately (`limitedMs`), so a scan with many
 * short blips still shows it.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const RECOVERY_SUSPECT_MS = 1_000

/**
 * The oldest a pose may be, in milliseconds, and still be stamped onto a capture. It is
 * applied only to a pose the provider is HOLDING because the runtime has stopped giving a
 * new one (NOT_AVAILABLE here: no pose at all, WebXR's null viewer pose, or an emulated one):
 * a pose that is being read every frame is current however long the gap between two frames was.
 *
 * An XR frame is 8 to 14 ms at 120 to 72 Hz, so this is some fifteen frames of nothing:
 * longer than a dropped frame or two, short enough that a capture is not stamped with a
 * pose from before a tracking loss. It is also 0.30 m of walking at 1.5 m/s, which is the
 * whole 0.305 m scan-to-scan target of the product, so it is not a bound to raise.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const MAX_CAPTURE_POSE_AGE_MS = 200

/**
 * What a capture is refused with when the pose it would carry is older than
 * MAX_CAPTURE_POSE_AGE_MS. src/main.ts matches on "Tracking lost" to say it plainly.
 */
export const TRACKING_LOST_MESSAGE = 'Tracking lost — hold still, then tap again'

/**
 * The longest gap between two samples that is counted as time spent degraded, in
 * milliseconds. A longer gap is a pause (a backgrounded page), not tracking time.
 *
 * Adopted, not measured (ADR 0005 rule 5).
 */
export const MAX_ACCOUNTED_INTERVAL_MS = 1_000

/**
 * Smallest step of a runtime anchor that starts an epoch, in metres: how far the anchor moved in the session
 * frame between two of its reports (AnchorMovedEvent.step). It is five times the capability's own report
 * threshold (ANCHOR_MOVED_TRANSLATION_M, a centimetre) and a sixth of the 0.305 m scan-to-scan target of the
 * product. The figure comes from the design guidance written down in docs/operations/AR_DEVICE_SUPPORT.md, which
 * chose it and did not measure it.
 *
 * Adopted, not measured (ADR 0005 rule 5). Revisit when DX6 has logged anchor drift over 60 s and 10 min.
 */
export const ANCHOR_STEP_TRANSLATION_M = 0.05

/**
 * Smallest turn of a runtime anchor about the vertical that starts an epoch, in degrees, between two of its
 * reports. At 5 m, one degree moves content by 8.7 cm. Read as the turn about the vertical and not the full
 * angle, as the jump threshold is (see yawTwistDeg): an anchor made on a wall that the runtime tilts by a
 * degree has not moved the frame.
 *
 * Adopted, not measured (ADR 0005 rule 5). Revisit when DX6 has logged anchor drift.
 */
export const ANCHOR_STEP_YAW_DEG = 1

/**
 * How far a runtime anchor may be from where it was first located (or last rebased), in metres, before the epoch
 * carries a drift flag. A flag and not an epoch: a slow correction is many steps below ANCHOR_STEP_TRANSLATION_M,
 * and only their sum says the stored frame and the anchor have parted.
 *
 * Adopted, not measured (ADR 0005 rule 5). Revisit when DX6 has logged anchor drift over 60 s and 10 min.
 */
export const ANCHOR_DRIFT_TRANSLATION_M = 0.10

/**
 * The turn about the vertical, in degrees, past which a runtime anchor's drift is flagged. See
 * ANCHOR_DRIFT_TRANSLATION_M.
 *
 * Adopted, not measured (ADR 0005 rule 5). Revisit when DX6 has logged anchor drift over 60 s and 10 min.
 */
export const ANCHOR_DRIFT_YAW_DEG = 2

/**
 * How many discontinuities (and how many epochs) are kept in a log or written to a
 * sidecar. The total is always kept; only the entries older than this are dropped, so a
 * pathological device cannot grow a sidecar without limit.
 */
export const FRAME_LOG_MAX = 64

export interface FrameEpochThresholds {
  jumpTranslationM: number
  jumpYawDeg: number
  maxAccelerationMps2: number
  maxTurnAccelerationDps2: number
  maxComparableStepRatio: number
  refractoryMs: number
  recoverySuspectMs: number
  anchorStepTranslationM: number
  anchorStepYawDeg: number
  anchorDriftTranslationM: number
  anchorDriftYawDeg: number
}

export const FRAME_EPOCH_THRESHOLDS: Readonly<FrameEpochThresholds> = Object.freeze({
  jumpTranslationM: FRAME_JUMP_TRANSLATION_M,
  jumpYawDeg: FRAME_JUMP_YAW_DEG,
  maxAccelerationMps2: MAX_HAND_ACCELERATION_MPS2,
  maxTurnAccelerationDps2: MAX_TURN_ACCELERATION_DPS2,
  maxComparableStepRatio: MAX_COMPARABLE_STEP_RATIO,
  refractoryMs: FRAME_JUMP_REFRACTORY_MS,
  recoverySuspectMs: RECOVERY_SUSPECT_MS,
  anchorStepTranslationM: ANCHOR_STEP_TRANSLATION_M,
  anchorStepYawDeg: ANCHOR_STEP_YAW_DEG,
  anchorDriftTranslationM: ANCHOR_DRIFT_TRANSLATION_M,
  anchorDriftYawDeg: ANCHOR_DRIFT_YAW_DEG,
})

/**
 * Every adopted number that shapes what a record says, as the sidecar writes them: the
 * tracker's thresholds and the two bounds the providers apply.
 */
export const FRAME_EPOCH_ADOPTED = Object.freeze({
  ...FRAME_EPOCH_THRESHOLDS,
  maxCapturePoseAgeMs: MAX_CAPTURE_POSE_AGE_MS,
  maxAccountedIntervalMs: MAX_ACCOUNTED_INTERVAL_MS,
})

// ── What a provider tells the app ───────────────────────────────────────────

export type FrameDiscontinuityCause = 'jump' | 'recovered' | 'resumed' | 'reset' | 'anchor'

/** A rigid transform, in the shape WebXR's `XRRigidTransform` has. */
export interface FrameTransform {
  position: { x: number; y: number; z: number }
  orientation: { x: number; y: number; z: number; w: number }
}

/**
 * What an anchor did, as a discontinuity records it: the anchor that began an 'anchor' epoch, or the first one whose step gave
 * an epoch of a resume or a reset its size. A number that is absent was not measured.
 */
export interface AnchorFact {
  /** The anchor's id within its session (`AnchorHandle.id`: 'anchor-1', ...). The ids repeat from one session to the next. */
  id: string
  /** 'moved': it stepped by what the thresholds call a shift. 'expired': the runtime did not locate it again in time. */
  what: 'moved' | 'expired'
  /** For 'expired': how it stopped being located (src/ar/anchors.ts, `AnchorLossKind`). */
  how?: AnchorLossKind
  /** For 'expired': how long it was not located, in milliseconds. */
  awayMs?: number
  /** For 'moved': the turn of the step about any axis, degrees (the event's own `yawDeg` is the part about the vertical). */
  stepRotationDeg?: number
  /** For 'moved': how far the anchor was then from where it was first located, or last rebased, in metres. */
  totalM?: number
  /** For 'moved': and how far it had turned about the vertical, in degrees. */
  totalYawDeg?: number
}

/**
 * What a runtime anchor did, as a provider hands it to `noteAnchor()`. `anchorId` is the anchor's id within its session. The
 * shapes of the numbers are the capability's own (`AnchorMovement` and `AnchorLossKind`, src/ar/anchors.ts), imported here as
 * types so that there is one definition of each (ADR 0001).
 *
 *   moved     it moved: `step` since the last report, `total` since it was first located (or last rebased). An epoch when
 *             `step` is a shift (`isAnchorShift`), unless something else accounts for it.
 *   lost      the runtime stopped locating it. It may come back. Counted, and it starts nothing: see "What a runtime anchor adds".
 *   returned  the runtime locates it again after `awayMs`. Counted, and no epoch: whether it has moved is a `moved`.
 *   expired   it did not come back in time: the provider has given it up, and whatever held it needs a new one. An epoch,
 *             unless something else accounts for the loss.
 */
export type AnchorEvent =
  | { kind: 'moved'; anchorId: string; step: AnchorMovement; total: AnchorMovement }
  | { kind: 'lost'; anchorId: string; how: AnchorLossKind }
  | { kind: 'returned'; anchorId: string; awayMs: number }
  | { kind: 'expired'; anchorId: string; awayMs: number }

/**
 * One discontinuity: an epoch begins. A measurement that is absent was not measured; it
 * is never a zero.
 */
export interface FrameDiscontinuity {
  /** The epoch this event starts. */
  epoch: number
  cause: FrameDiscontinuityCause
  /** The tracker's clock, in milliseconds (the frame time the provider fed it). */
  atMs: number
  /**
   * How far the pose moved between the two frames compared: the step for a jump, the whole
   * stretch since tracking was last good for a 'recovered' event.
   */
  translationM?: number
  /** How far it turned about the vertical. For a WebXR reset: the turn the runtime reported. */
  yawDeg?: number
  /** The speed that displacement implies, when it was measured between two frames. */
  speedMps?: number
  /** The time between the two frames compared, for a jump, in milliseconds. */
  dtMs?: number
  /**
   * The part of the step that the step before it did not predict, in metres: what moved
   * that was not motion. Equal to `translationM` for a camera that was still. Present when
   * a step was judged.
   */
  unexplainedM?: number
  /** The same for the turn, in degrees. */
  unexplainedYawDeg?: number
  /** How long tracking had been missing, for 'recovered'. */
  degradedMs?: number
  /** How long the page or session was hidden, for 'resumed', when the provider saw both ends. */
  hiddenMs?: number
  /** The runtime's tracking reason, when it gave one (8th Wall documents INITIALIZING and UNSPECIFIED; see DEGRADED_REASONS). */
  reason?: string
  /**
   * For 'reset': the runtime's own description of the move, the new origin in the old
   * coordinate system (WebXR XRReferenceSpaceEvent.transform). `null` means the runtime
   * could not say; the spec allows that. Absent for the other causes.
   */
  transform?: FrameTransform | null
  /**
   * Which anchor, and what it did. On an 'anchor' epoch it is the anchor that began it, and `translationM` and `yawDeg` above are
   * its step (absent for a handle given up, which measured nothing). On an epoch that a resume or a reset began and gave no
   * size, it is the first anchor whose step did, and `translationM` and `yawDeg` are that step.
   */
  anchor?: AnchorFact
}

/** Counts of values by size: `counts[i]` is the number in `[edges[i - 1], edges[i])`, the last one `>= edges[last]`. */
export interface MotionHistogram {
  edges: number[]
  counts: number[]
}

/**
 * How the camera moved between frames while tracking was good, since the AR session began.
 * It is what DX4 needs to set the thresholds ("above the benign p99 of frame-to-frame
 * motion"): the step times, the speeds and turn rates, and the unexplained part of each
 * step, which is what the thresholds are compared with. Counted over every judged step,
 * the few jumps among them included.
 */
export interface MotionStats {
  /** Steps counted. */
  steps: number
  peakSpeedMps: number
  peakYawRateDps: number
  dtMs: MotionHistogram
  speedMps: MotionHistogram
  yawRateDps: MotionHistogram
  /** Of the steps that had a step before them to be compared with. */
  unexplainedM: MotionHistogram
  unexplainedYawDeg: MotionHistogram
}

/**
 * The live tracking health a provider can report, for on-screen diagnostics and for the
 * quality verdict. `status`, `poseJumps` and `lastJumpM` are what this has always held;
 * the rest is additive, and a provider with no epoch signal omits it.
 *
 * `poseJumps` counts MEASURED pose jumps, as it always has (the calibration readout prints
 * it as "frame shifts"), the resets a runtime reports, a recovery that came with a
 * measured jump at the step where tracking returned, and a runtime anchor's step that the
 * thresholds call a shift, once for each epoch. `epoch` is the broader number: it
 * also counts the suspect recoveries and resumes and the anchors the runtime gave up on,
 * so a caller that wants "did anything possibly move" reads `epoch`.
 */
export interface TrackingDiagnostics {
  status: string
  poseJumps: number
  /** The unexplained translation of the last measured jump, or the runtime's reported move. 0 when none was measured. */
  lastJumpM: number
  /** The runtime's tracking reason, when it has one. */
  reason?: string
  epoch?: number
  /** The unexplained turn of the last measured jump, in degrees. */
  lastJumpDeg?: number
  /** Total time spent with degraded tracking since tracking was first normal, in milliseconds. */
  limitedMs?: number
  /** Total time spent with no pose at all since tracking was first normal, in milliseconds. */
  notAvailableMs?: number
  /** Jumps that fell inside FRAME_JUMP_REFRACTORY_MS of an earlier one and were folded into it. */
  suppressedJumps?: number
  /** The age of the pose the provider would stamp onto a capture now, in milliseconds. */
  poseAgeMs?: number
  /** How the camera moved while tracking was good; see MotionStats. */
  motion?: MotionStats
  /** What the runtime's anchors have done. Absent until the provider has told the tracker about one. */
  anchors?: AnchorDiagnostics
}

/**
 * What a provider's runtime anchors have reported, as `noteAnchor()` counted it: the four counts go on across sessions, as the
 * epoch does, and the drift is that of the current epoch. Nothing here says the room is pinned: "anchors granted" means the API
 * exists (src/ar/anchors.ts).
 */
export interface AnchorDiagnostics {
  /** How many times the runtime stopped locating an anchor. A loss starts no epoch by itself. */
  lost: number
  /** How many of them it located again, so the same anchor object came back. */
  returned: number
  /** How many it did not give back in time: their handles are dead and whatever held them needs new ones. */
  expired: number
  /**
   * How many steps and given-up handles came while an epoch that something else began was going, or just after it, or for an
   * anchor that had gone while one was, and were counted in that epoch instead of starting another. One move of the frame is
   * one for every anchor that sees it, so this is the number of anchors, not of disturbances: `suppressedJumps` stays the
   * count of the viewer's own jumps folded together.
   */
  folded: number
  /** The farthest any anchor has been from where it was first located (or last rebased) since the current epoch began, in metres. */
  maxDriftM: number
  /** The most any anchor has turned about the vertical from there since the current epoch began, in degrees. */
  maxDriftYawDeg: number
  /**
   * Whether either passed ANCHOR_DRIFT_TRANSLATION_M or ANCHOR_DRIFT_YAW_DEG in the current epoch: a quality flag for a "Check
   * drift" prompt, not an epoch. It stays set until the next epoch begins.
   */
  driftFlagged: boolean
}

// ── Reading a tracking status ───────────────────────────────────────────────

/**
 * What a status and reason say about the pose that came with them.
 *
 * `good`      NORMAL: the pose can be trusted.
 * `degraded`  LIMITED, INITIALIZING, or any status carrying a degraded reason: the engine
 *             is still producing poses but is not sure of them.
 * `absent`    NOT_AVAILABLE: there is no pose to trust.
 * `unknown`   the runtime says nothing usable (UNKNOWN, UNSPECIFIED, or a status this
 *             code does not know). Treated like `good` for comparing poses and never
 *             starts an episode: a rule that failed closed here would stop a runtime with
 *             no signal from ever being recorded (see trackingIsUsable()).
 */
export type TrackingClass = 'good' | 'degraded' | 'absent' | 'unknown'

/**
 * The reason that names a relocalization. The only reason that is a discontinuity by itself.
 * Not in 8th Wall's documented set (see DEGRADED_REASONS): it is acted on in case the engine reports it.
 */
export const REASON_RELOCALIZING = 'RELOCALIZING'

/**
 * The reasons that make a frame degraded when they come beside a status that reads NORMAL.
 * What 8th Wall documents for `trackingReason` is INITIALIZING and UNSPECIFIED, and for
 * `trackingStatus` LIMITED and NORMAL (https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule).
 * RELOCALIZING, TOO_MUCH_MOTION and NOT_ENOUGH_TEXTURE are not in that documentation. They are
 * listed so that an engine which reports them is treated as unsure of its poses, not because one is
 * known to. DX4 logs every status and reason transition on a phone, and that log is what keeps
 * or removes each name. INITIALIZING is a reason here, and the native shell's status word.
 */
const DEGRADED_REASONS: ReadonlySet<string> = new Set([
  'INITIALIZING',
  REASON_RELOCALIZING,
  'TOO_MUCH_MOTION',
  'NOT_ENOUGH_TEXTURE',
])

export function classifyTracking(
  status: string | null | undefined,
  reason?: string | null,
): TrackingClass {
  if (status === 'NOT_AVAILABLE') return 'absent'
  if (status === 'LIMITED' || status === 'INITIALIZING') return 'degraded'
  if (reason && DEGRADED_REASONS.has(reason)) return 'degraded'
  if (status === 'NORMAL') return 'good'
  return 'unknown'
}

// ── Pose arithmetic ─────────────────────────────────────────────────────────

type Vec3 = { x: number; y: number; z: number }
type Quat = { x: number; y: number; z: number; w: number }

function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function finiteQuat(q: Quat): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
}

function usablePose(pose: Pose | null | undefined): pose is Pose {
  return !!pose && finiteVec(pose.position) && finiteQuat(pose.rotation)
}

/**
 * The turn between two orientations about the world's vertical axis, in degrees, signed:
 * positive when the turn is counter-clockwise seen from above (a rotation about +Y), from
 * -180 to 180.
 *
 * Both are camera orientations in the session frame, which is gravity-aligned, so a frame
 * that was redefined turns the world about the vertical and this is the heading change.
 * It is the twist of the relative rotation about +Y, not its full angle: a quick tilt of
 * the phone changes the full angle and does not change the heading, and a tilt is what a
 * person does when tapping. `NaN` when either orientation is not a rotation.
 */
export function yawTwistDeg(a: Quat, b: Quat): number {
  const na = Math.hypot(a.x, a.y, a.z, a.w)
  const nb = Math.hypot(b.x, b.y, b.z, b.w)
  if (!(na > 0) || !(nb > 0)) return Number.NaN
  const ax = a.x / na, ay = a.y / na, az = a.z / na, aw = a.w / na
  const bx = b.x / nb, by = b.y / nb, bz = b.z / nb, bw = b.w / nb
  // The rotation that takes a to b, expressed in the world frame: b * conjugate(a).
  let w = bw * aw + bx * ax + by * ay + bz * az
  let y = aw * by - bw * ay + az * bx - ax * bz
  // A rotation and its negation are the same rotation; take the short way round.
  if (w < 0) { w = -w; y = -y }
  return 2 * Math.atan2(y, w) * (180 / Math.PI)
}

/** The size of {@link yawTwistDeg}, 0 to 180. */
export function yawDeltaDeg(a: Quat, b: Quat): number {
  return Math.abs(yawTwistDeg(a, b))
}

function distanceM(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// ── The tracker ─────────────────────────────────────────────────────────────

/** One frame as a provider sees it. */
export interface TrackingSample {
  /** A monotonic clock in milliseconds. The runtime's frame time where it gives one. */
  tMs: number
  /** The pose of this frame. Absent or null when the runtime gave none. */
  pose?: Pose | null
  /** The runtime's tracking status: NORMAL, LIMITED, NOT_AVAILABLE, or anything else. */
  status?: string | null
  /** The runtime's tracking reason, when it has one. */
  reason?: string | null
}

export type FrameDiscontinuityListener = (event: FrameDiscontinuity) => void

export interface FrameEpochTrackerOptions {
  /**
   * Hold the events a call starts until `flush()` instead of telling the listeners inside
   * the call. A provider sets it, so that a listener that reads the provider (its epoch, its
   * pose, the points it has not handed over) finds all of it in the new epoch: the tracker
   * decides while the provider is still halfway through reading a frame.
   */
  deferNotify?: boolean
}

/** The move from one frame to the next. `yaw` is null when an orientation was not a rotation. */
interface Step {
  dtS: number
  dx: number
  dy: number
  dz: number
  yaw: number | null
}

/** How much of a step the step before it did not predict. */
interface Unexplained {
  translationM: number
  /** Null when either orientation was not a rotation. */
  yawDeg: number | null
  /** Whether either is at least what a jump needs. */
  jump: boolean
}

/** A pose and when it was read. */
interface Stamped {
  pose: Pose
  tMs: number
}

/** A stretch of degraded or absent tracking that began after tracking had been good. */
interface Episode {
  startMs: number
  /** The last pose that was read while tracking was good, to measure the stretch from. Null after a resume. */
  from: Stamped | null
  sawRelocalizing: boolean
  reason?: string
  /** Whether an epoch has already begun while it lasted (a jump between two of its frames): its end is not a second one. */
  bumped: boolean
}

/**
 * The disturbance a resume or a reset began, until tracking is good again. Later reports
 * of it add to the epoch it began and do not start another.
 */
interface Trip {
  /** The event that began the epoch, as it is now (an amended copy replaces it). */
  event: FrameDiscontinuity
  /** Whether a pose has arrived since. A runtime's `reset` comes before the first one. */
  poseSeen: boolean
  /** Whether the runtime has reported the move itself (a `reset`), so it is already counted as one. */
  reported: boolean
  /** Whether an anchor has measured the move, so it is already counted as one. A reset that comes later is still the runtime's report. */
  sized: boolean
}

/** An anchor the runtime is not locating: since when, how it went, and whether an epoch already accounts for it. */
interface AnchorAbsence {
  sinceMs: number
  how: AnchorLossKind
  /** A disturbance that had its epoch was going when it went (see `_inDisturbance`), so that epoch is why it went. */
  accounted: boolean
}

const HISTOGRAM_EDGES = {
  dtMs: [8, 12, 17, 25, 34, 50, 67, 100, 150, 250, 500, 1_000],
  speedMps: [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 15],
  yawRateDps: [10, 30, 60, 120, 180, 240, 360, 480, 720, 1_080],
  unexplainedM: [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2],
  unexplainedYawDeg: [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 20, 45],
} as const

class Histogram {
  readonly counts: number[]
  private readonly edges: readonly number[]
  constructor(edges: readonly number[]) {
    this.edges = edges
    this.counts = new Array<number>(edges.length + 1).fill(0)
  }
  add(value: number): void {
    if (!Number.isFinite(value)) return
    let i = 0
    while (i < this.edges.length && value >= this.edges[i]) i++
    this.counts[i]++
  }
  snapshot(): MotionHistogram {
    return { edges: [...this.edges], counts: [...this.counts] }
  }
}

class MotionRecorder {
  steps = 0
  peakSpeedMps = 0
  peakYawRateDps = 0
  private _dtMs = new Histogram(HISTOGRAM_EDGES.dtMs)
  private _speedMps = new Histogram(HISTOGRAM_EDGES.speedMps)
  private _yawRateDps = new Histogram(HISTOGRAM_EDGES.yawRateDps)
  private _unexplainedM = new Histogram(HISTOGRAM_EDGES.unexplainedM)
  private _unexplainedYawDeg = new Histogram(HISTOGRAM_EDGES.unexplainedYawDeg)

  step(step: Step): void {
    this.steps++
    const speed = Math.hypot(step.dx, step.dy, step.dz) / step.dtS
    this.peakSpeedMps = Math.max(this.peakSpeedMps, speed)
    this._dtMs.add(step.dtS * 1000)
    this._speedMps.add(speed)
    if (step.yaw !== null) {
      const rate = Math.abs(step.yaw) / step.dtS
      this.peakYawRateDps = Math.max(this.peakYawRateDps, rate)
      this._yawRateDps.add(rate)
    }
  }

  unexplained(u: Unexplained): void {
    this._unexplainedM.add(u.translationM)
    if (u.yawDeg !== null) this._unexplainedYawDeg.add(u.yawDeg)
  }

  snapshot(): MotionStats {
    return {
      steps: this.steps,
      peakSpeedMps: this.peakSpeedMps,
      peakYawRateDps: this.peakYawRateDps,
      dtMs: this._dtMs.snapshot(),
      speedMps: this._speedMps.snapshot(),
      yawRateDps: this._yawRateDps.snapshot(),
      unexplainedM: this._unexplainedM.snapshot(),
      unexplainedYawDeg: this._unexplainedYawDeg.snapshot(),
    }
  }
}

/** An event no listener can change: the event, its transform and the transform's parts, and the anchor fact. */
function frozenEvent(event: FrameDiscontinuity): FrameDiscontinuity {
  const transform = event.transform
  if (transform) {
    Object.freeze(transform.position)
    Object.freeze(transform.orientation)
    Object.freeze(transform)
  }
  if (event.anchor) Object.freeze(event.anchor)
  return Object.freeze(event)
}

/** A copy of a transform that shares nothing with the runtime's own object. */
function copyTransform(t: FrameTransform): FrameTransform {
  return {
    position: { x: t.position.x, y: t.position.y, z: t.position.z },
    orientation: { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w },
  }
}

export class FrameEpochTracker {
  private _thresholds: FrameEpochThresholds
  private _deferNotify: boolean
  private _epoch = 0
  /** True from the first frame with a pose to trust. Until then nothing is discontinuous. */
  private _established = false
  /**
   * True from the first frame the runtime itself called NORMAL. A runtime can start out saying
   * nothing (an UNSPECIFIED or missing status) and then spend its first seconds LIMITED while it
   * initialises; that is start-up, and only after a NORMAL can tracking be lost.
   */
  private _everGood = false
  /** True once a session has been established, so the next one after an end starts a new epoch. */
  private _hadSession = false
  /**
   * The last frame the runtime gave a pose for, whatever its status short of NOT_AVAILABLE:
   * what the next step is measured from. Null until one is, and after a reset or a resume,
   * when the old frame's poses are not comparable with the next.
   */
  private _last: Stamped | null = null
  /** The last pose read while tracking was good. A recovery is measured from it. */
  private _good: Stamped | null = null
  /** The step before the one being judged. Null when there is none to compare with. */
  private _prevStep: Step | null = null
  private _episode: Episode | null = null
  private _trip: Trip | null = null
  /**
   * The trip that began the latest epoch, open or settled, so an anchor that measures its size can say so. Null when the latest
   * epoch was not begun by one, and from the moment another epoch begins.
   */
  private _lastTrip: Trip | null = null
  /** When the last epoch began, on the clock the samples carry. Jumps close behind it are folded into it. */
  private _lastBumpMs = Number.NEGATIVE_INFINITY
  /**
   * The last moment a disturbance that has its epoch was going: when it began, and the frame in which the trip or the stretch of bad
   * tracking it was part of ended. An anchor's report close behind it is part of it (see `_inDisturbance`).
   */
  private _lastActiveMs = Number.NEGATIVE_INFINITY
  private _status = 'UNKNOWN'
  private _reason: string | undefined
  private _poseJumps = 0
  private _lastJumpM = 0
  private _lastJumpDeg = 0
  private _suppressedJumps = 0
  private _limitedMs = 0
  private _notAvailableMs = 0
  private _lastSampleMs: number | null = null
  private _lastClass: TrackingClass = 'unknown'
  private _log: FrameDiscontinuity[] = []
  private _logTotal = 0
  private _listeners = new Set<FrameDiscontinuityListener>()
  private _pending: FrameDiscontinuity[] = []
  private _motion = new MotionRecorder()
  /** True once `noteAnchor()` has been told something, so a provider with no anchors reports none. */
  private _anchorsSeen = false
  private _anchorsLost = 0
  private _anchorsReturned = 0
  private _anchorsExpired = 0
  private _anchorsFolded = 0
  /** The anchors the runtime is not locating now, by id. Ids repeat from one session to the next, so a session's end clears it. */
  private _absences = new Map<string, AnchorAbsence>()
  /** The farthest any anchor has been from its baseline since the current epoch began, in metres. */
  private _driftM = 0
  /** The most any anchor has turned about the vertical from its baseline since the current epoch began, in degrees. */
  private _driftYawDeg = 0

  constructor(thresholds: Partial<FrameEpochThresholds> = {}, options: FrameEpochTrackerOptions = {}) {
    this._thresholds = { ...FRAME_EPOCH_THRESHOLDS, ...thresholds }
    this._deferNotify = options.deferNotify === true
  }

  /** The current epoch. 0 until the first discontinuity. */
  get epoch(): number {
    return this._epoch
  }

  /** The discontinuities seen, oldest first, the most recent FRAME_LOG_MAX of them. */
  get log(): ReadonlyArray<FrameDiscontinuity> {
    return this._log
  }

  /** How many discontinuities there have been, including any dropped from `log`. */
  get logTotal(): number {
    return this._logTotal
  }

  /** Call `cb` at each discontinuity. Returns the function that stops it. */
  subscribe(cb: FrameDiscontinuityListener): () => void {
    this._listeners.add(cb)
    return () => {
      this._listeners.delete(cb)
    }
  }

  /**
   * Tell the listeners about the events held back since the last call. Does nothing for a
   * tracker that was not made with `deferNotify`, which tells them as each event begins.
   */
  flush(): void {
    const events = this._pending.splice(0)
    for (const event of events) this._dispatch(event)
  }

  /**
   * Feed one frame. Returns the discontinuity this frame started, if it started one.
   *
   * Safe to call twice for one frame (the 8th Wall provider reads the reality in two of its
   * hooks): the second call sees the same pose a moment later and finds nothing. Not safe for
   * a frame that repeats the last one's pose with a later time (`repeatFrame`: the camera feed
   * has not updated since the last call, https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu;
   * that the pose such a frame carries is the last one's again is assumed here, not documented):
   * the step to it is zero over an interval that was no interval, and the step after it is a
   * whole camera frame over a rendering frame. The provider must not feed those.
   */
  observe(sample: TrackingSample): FrameDiscontinuity | null {
    const tMs = sample.tMs
    if (!Number.isFinite(tMs)) return null
    const klass = classifyTracking(sample.status, sample.reason)
    this._status = sample.status || 'UNKNOWN'
    this._reason = sample.reason || undefined
    this._account(tMs, klass)

    if (klass === 'absent') {
      // No pose that can be trusted: whatever such a frame carries is not read as a pose.
      this._noteLoss(tMs, sample)
      return null
    }
    const pose = usablePose(sample.pose) ? sample.pose : null

    if (klass === 'degraded') {
      this._noteLoss(tMs, sample)
      // Poses may keep coming while a runtime is unsure of them, and a pose that steps is a
      // pose that steps, whatever the runtime thinks of it (the detector this replaced counted
      // every step whatever the status; so does this). What a person walked during the loss is not a
      // step: it is smooth, and predicted.
      if (pose && this._established && this._everGood) return this._followDegraded(pose, tMs)
      return null
    }

    if (klass === 'good') this._everGood = true
    if (!pose) return null

    if (!this._established) {
      this._established = true
      this._last = { pose, tMs }
      this._good = { pose, tMs }
      this._prevStep = null
      if (this._hadSession) return this._bump('resumed', tMs, {})
      this._hadSession = true
      return null
    }

    // A good frame, with a pose, in a session that has one.
    const step = this._last ? this._stepFrom(this._last, pose, tMs) : null
    const verdict = step ? this._judge(step) : null
    if (step) {
      this._motion.step(step)
      if (verdict) this._motion.unexplained(verdict)
    }
    this._last = { pose, tMs }
    this._good = { pose, tMs }
    const episode = this._episode
    this._episode = null
    const trip = this._trip
    this._trip = null
    // The trip, or the stretch of bad tracking, that has its epoch ends in this frame. The anchors are read after it, in this
    // frame or the next, and what they say about it is part of it (see `_inDisturbance`).
    if (trip || episode?.bumped) this._lastActiveMs = tMs

    let event: FrameDiscontinuity | null = null
    if (episode && !trip && !episode.bumped) {
      const degradedMs = Math.max(0, tMs - episode.startMs)
      if (episode.sawRelocalizing || degradedMs >= this._thresholds.recoverySuspectMs) {
        // The stretch is measured from the last good pose, so what a person walked while
        // tracking was missing shows as the displacement it is. That it moved is not the
        // measurement: the step to this frame is, and is judged on its own.
        const across = episode.from ? this._acrossFrom(episode.from, pose, tMs) : {}
        const measured = verdict?.jump && step ? this._jumpNumbers(step, verdict) : {}
        event = this._bump('recovered', tMs, {
          ...across,
          ...measured,
          degradedMs,
          ...(episode.sawRelocalizing
            ? { reason: REASON_RELOCALIZING }
            : episode.reason ? { reason: episode.reason } : {}),
        })
        if (verdict?.jump) this._countJump(verdict)
        this._prevStep = null
        return event
      }
      // A short blip that did not relocalize is not a discontinuity by itself; the step to
      // this frame is still judged below.
    }
    if (trip) {
      // The first good pose of a trip: nothing is judged from before it, and the next step
      // starts the history again.
      this._prevStep = step
      return null
    }

    if (verdict?.jump && step) return this._jumpAt(step, verdict, tMs)
    this._prevStep = step
    return null
  }

  /**
   * A jump, unless it is close behind another: then it is part of that one, and is counted
   * as folded in. Either way the next step has no step before it to be compared with.
   */
  private _jumpAt(step: Step, verdict: Unexplained, tMs: number): FrameDiscontinuity | null {
    this._prevStep = null
    if (tMs - this._lastBumpMs < this._thresholds.refractoryMs) {
      this._suppressedJumps++
      return null
    }
    this._countJump(verdict)
    const event = this._bump('jump', tMs, this._jumpNumbers(step, verdict))
    if (this._episode) this._episode.bumped = true
    return event
  }

  /**
   * The runtime said the origin moved (WebXR `reset`). `transform` is the runtime's own
   * description of the move, or null when it could not give one.
   *
   * Ignored before tracking was established (nothing had been recorded in the old frame).
   * A reset that comes before the first pose after a resume, or after another reset, is
   * the same move: it adds the runtime's description to the epoch already begun, and is
   * counted once. Returns that epoch's event as it now reads, or null when it had nothing
   * to add.
   */
  noteReset(tMs: number, transform: FrameTransform | null): FrameDiscontinuity | null {
    if (!this._established || !Number.isFinite(tMs)) return null
    const given = transform && finiteVec(transform.position) && finiteQuat(transform.orientation)
      ? copyTransform(transform)
      : null
    const numbers: Partial<FrameDiscontinuity> = {}
    if (given) {
      numbers.translationM = Math.hypot(given.position.x, given.position.y, given.position.z)
      const yaw = yawDeltaDeg({ x: 0, y: 0, z: 0, w: 1 }, given.orientation)
      if (Number.isFinite(yaw)) numbers.yawDeg = yaw
    }

    const trip = this._trip
    if (trip && !trip.poseSeen) {
      const had = trip.event.transform
      if (trip.reported && (had || !given)) return null
      if (!trip.reported) {
        if (!trip.sized) this._poseJumps++
        trip.reported = true
      }
      if (given) {
        if (numbers.translationM !== undefined) this._lastJumpM = numbers.translationM
        if (numbers.yawDeg !== undefined) this._lastJumpDeg = numbers.yawDeg
      }
      return this._amend(trip, { ...numbers, transform: given, cause: 'reset' })
    }

    this._poseJumps++
    if (numbers.translationM !== undefined) this._lastJumpM = numbers.translationM
    if (numbers.yawDeg !== undefined) this._lastJumpDeg = numbers.yawDeg
    // The origin moved, so the next pose is in new coordinates and must not be compared
    // with the old one: that difference is the move, which has just been counted.
    this._forgetOldFrame()
    const event = this._bump('reset', tMs, { ...numbers, transform: given })
    this._trip = this._lastTrip = { event, poseSeen: false, reported: true, sized: false }
    return event
  }

  /**
   * The page or the engine was paused and has resumed. A second call before a pose has
   * arrived is the same resume reported twice (a pipeline module's `onResume` and a visibility
   * event for one return to the page), so it starts nothing. `hiddenMs` is how long it was away, when
   * the caller saw both ends: recorded, because how short a trip can be and still matter is
   * for DX4 to say, and nothing here assumes it.
   */
  noteResume(tMs: number, hiddenMs?: number): FrameDiscontinuity | null {
    if (!this._established || !Number.isFinite(tMs)) return null
    if (this._trip && !this._trip.poseSeen) return null
    this._forgetOldFrame()
    const away = hiddenMs !== undefined && Number.isFinite(hiddenMs) ? { hiddenMs: Math.max(0, Math.round(hiddenMs)) } : {}
    const event = this._bump('resumed', tMs, away)
    this._trip = this._lastTrip = { event, poseSeen: false, reported: false, sized: false }
    return event
  }

  /**
   * Whether a step of a runtime anchor is one that starts an epoch: it moved at least `anchorStepTranslationM`, or turned
   * at least `anchorStepYawDeg` about the vertical. A step that is not a number is not a shift.
   */
  isAnchorShift(step: AnchorMovement): boolean {
    const t = this._thresholds
    return step.translationM >= t.anchorStepTranslationM || Math.abs(step.yawDeg) >= t.anchorStepYawDeg
  }

  /**
   * A runtime anchor did something (see `AnchorEvent`). `tMs` is the XR frame time the report was made in, on the clock the
   * samples carry. Returns the discontinuity it started, or the epoch it gave a size to, or null.
   *
   * What each report is, in short (the reasons are under "What a runtime anchor adds" at the top of this file):
   *
   *   moved     a step below the shift thresholds only adds to the drift. A step that is a shift is an epoch, unless it joins one
   *             that something else began: that is so while a resume, a reset or a stretch of bad tracking that has its epoch is
   *             going, within `refractoryMs` of the moment one ended or began, and for an anchor that was away while one was (an
   *             epoch began while it was gone, or one was going when it went). Joined, it is counted in `anchors.folded`, and an
   *             epoch that a resume or a reset began and gave no size takes this step as its size (and is returned, as `noteReset`
   *             returns the epoch it adds to).
   *   lost      counted, and remembered with the time it went, which a step and a handle given up read. It starts nothing.
   *   returned  counted, and forgotten: a loss that comes back where it was is a blip, and not an epoch.
   *   expired   the handle was given up, which says nothing was measured and the anchor that could have said is gone: an epoch,
   *             unless it is accounted for in the same way as a step.
   *
   * Reports that arrive before tracking was established, after the session ended, or with a clock that is not a number are
   * not counted: there is no frame to be discontinuous with.
   *
   * This is the whole of what the tracker does with an anchor: the anchor's pose is never a matrix to follow (src/ar/anchors.ts).
   * A step that starts an epoch also counts as a measured jump, which a given-up handle does not (it measured nothing), and either
   * one ends the drift count of the epoch before it.
   */
  noteAnchor(tMs: number, event: AnchorEvent): FrameDiscontinuity | null {
    if (!this._established || !Number.isFinite(tMs)) return null
    this._anchorsSeen = true
    switch (event.kind) {
      case 'lost':
        this._anchorsLost++
        // Once for each time it goes: a second report of the same absence keeps the first, which is when it went.
        if (!this._absences.has(event.anchorId)) {
          this._absences.set(event.anchorId, { sinceMs: tMs, how: event.how, accounted: this._inDisturbance(tMs) })
        }
        return null
      case 'returned':
        this._anchorsReturned++
        this._absences.delete(event.anchorId)
        return null
      case 'expired': {
        this._anchorsExpired++
        const absence = this._absences.get(event.anchorId)
        this._absences.delete(event.anchorId)
        const fact: AnchorFact = {
          id: event.anchorId,
          what: 'expired',
          ...(absence ? { how: absence.how } : {}),
          ...(Number.isFinite(event.awayMs) ? { awayMs: Math.max(0, Math.round(event.awayMs)) } : {}),
        }
        return this._anchorSays(tMs, fact, {}, absence)
      }
      case 'moved': {
        const { step, total } = event
        if (!this.isAnchorShift(step)) {
          this._addDrift(total)
          return null
        }
        const yaw = Math.abs(step.yawDeg)
        return this._anchorSays(
          tMs,
          {
            id: event.anchorId,
            what: 'moved',
            ...(Number.isFinite(step.rotationDeg) ? { stepRotationDeg: step.rotationDeg } : {}),
            ...(Number.isFinite(total.translationM) ? { totalM: total.translationM } : {}),
            ...(Number.isFinite(total.yawDeg) ? { totalYawDeg: Math.abs(total.yawDeg) } : {}),
          },
          {
            ...(Number.isFinite(step.translationM) ? { translationM: step.translationM } : {}),
            ...(Number.isFinite(yaw) ? { yawDeg: yaw } : {}),
          },
          this._absences.get(event.anchorId),
        )
      }
    }
  }

  /**
   * The session ended. The next one is a new map, so the next trustworthy frame starts a
   * new epoch instead of being compared with a pose from the old session.
   */
  noteSessionEnd(): void {
    this._established = false
    this._everGood = false
    this._last = null
    this._good = null
    this._prevStep = null
    this._episode = null
    this._trip = null
    this._lastTrip = null
    this._lastBumpMs = Number.NEGATIVE_INFINITY
    this._lastActiveMs = Number.NEGATIVE_INFINITY
    this._lastSampleMs = null
    this._lastClass = 'unknown'
    this._status = 'UNKNOWN'
    this._reason = undefined
    // The anchors of that session are gone, and the next session's are new ones, whose ids start again.
    this._absences.clear()
    this._driftM = 0
    this._driftYawDeg = 0
    this.flush()
  }

  diagnostics(): TrackingDiagnostics {
    return {
      status: this._status,
      ...(this._reason ? { reason: this._reason } : {}),
      poseJumps: this._poseJumps,
      lastJumpM: this._lastJumpM,
      epoch: this._epoch,
      lastJumpDeg: this._lastJumpDeg,
      limitedMs: Math.round(this._limitedMs),
      notAvailableMs: Math.round(this._notAvailableMs),
      suppressedJumps: this._suppressedJumps,
      motion: this._motion.snapshot(),
      ...(this._anchorsSeen ? { anchors: this._anchorDiagnostics() } : {}),
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Add the time since the last sample to whichever state that sample was in. */
  private _account(tMs: number, klass: TrackingClass): void {
    if (this._lastSampleMs !== null && this._everGood) {
      const gap = Math.min(Math.max(tMs - this._lastSampleMs, 0), MAX_ACCOUNTED_INTERVAL_MS)
      if (this._lastClass === 'degraded') this._limitedMs += gap
      else if (this._lastClass === 'absent') this._notAvailableMs += gap
    }
    this._lastSampleMs = tMs
    this._lastClass = klass
  }

  /** A frame with no pose to trust: the start of an episode if tracking had been good, or more of one. */
  private _noteLoss(tMs: number, sample: TrackingSample): void {
    // A tracker that has never seen good tracking is still starting up, and that is not a
    // loss; one that has, is now in an episode.
    if (!this._established || !this._everGood) return
    const episode = this._episode ?? (this._episode = { startMs: tMs, from: this._good, sawRelocalizing: false, bumped: false })
    if (sample.reason === REASON_RELOCALIZING) episode.sawRelocalizing = true
    if (sample.reason && sample.reason !== 'UNSPECIFIED') episode.reason ??= sample.reason
  }

  /**
   * A pose given while the runtime was unsure of it. It is judged like any other (not recorded in the
   * motion statistics, which are of tracking while it was good), unless a trip is open: what
   * follows a resume or a reset is one disturbance, and is not judged against a pose from before it.
   */
  private _followDegraded(pose: Pose, tMs: number): FrameDiscontinuity | null {
    const trip = this._trip
    if (trip) trip.poseSeen = true
    const step = this._last ? this._stepFrom(this._last, pose, tMs) : null
    const verdict = step && !trip ? this._judge(step) : null
    this._last = { pose, tMs }
    if (verdict?.jump && step) return this._jumpAt(step, verdict, tMs)
    this._prevStep = step
    return null
  }

  /** The step from `from` to a pose read at `tMs`. At least a millisecond long, so two frames stamped alike cannot divide by zero. */
  private _stepFrom(from: Stamped, pose: Pose, tMs: number): Step {
    const yaw = yawTwistDeg(from.pose.rotation, pose.rotation)
    return {
      dtS: Math.max(tMs - from.tMs, 1) / 1000,
      dx: pose.position.x - from.pose.position.x,
      dy: pose.position.y - from.pose.position.y,
      dz: pose.position.z - from.pose.position.z,
      yaw: Number.isFinite(yaw) ? yaw : null,
    }
  }

  /** How far a pose moved and turned from `from`, over the whole time between: for a recovery's record. */
  private _acrossFrom(from: Stamped, pose: Pose, tMs: number): Partial<FrameDiscontinuity> {
    const translationM = distanceM(pose.position, from.pose.position)
    const yawDeg = yawDeltaDeg(from.pose.rotation, pose.rotation)
    const dtS = Math.max(tMs - from.tMs, 1) / 1000
    return {
      translationM,
      ...(Number.isFinite(yawDeg) ? { yawDeg } : {}),
      speedMps: translationM / dtS,
    }
  }

  /**
   * How much of `step` the step before it does not predict. Null when there is no step
   * before it, or it was not a comparable one.
   *
   * The prediction is the better of two (see the top of this file): the same rate over this
   * interval, or the same step as last time.
   */
  private _judge(step: Step): Unexplained | null {
    const prev = this._prevStep
    if (!prev) return null
    const t = this._thresholds
    const ratio = step.dtS / prev.dtS
    const sameKind = ratio <= t.maxComparableStepRatio && ratio >= 1 / t.maxComparableStepRatio
    const byRate = Math.hypot(step.dx - prev.dx * ratio, step.dy - prev.dy * ratio, step.dz - prev.dz * ratio)
    const bySame = Math.hypot(step.dx - prev.dx, step.dy - prev.dy, step.dz - prev.dz)
    const translationM = sameKind ? Math.min(byRate, bySame) : byRate
    let yawDeg: number | null = null
    if (step.yaw !== null && prev.yaw !== null) {
      const yawByRate = Math.abs(step.yaw - prev.yaw * ratio)
      yawDeg = sameKind ? Math.min(yawByRate, Math.abs(step.yaw - prev.yaw)) : yawByRate
    }
    // What the fastest hand could have changed the motion by: acceleration over this
    // interval and the one before it, as 0.5 * dt * (dt + dtPrev) of it.
    const reach = 0.5 * step.dtS * (step.dtS + prev.dtS)
    const jump = translationM >= Math.max(t.jumpTranslationM, t.maxAccelerationMps2 * reach) ||
      (yawDeg !== null && yawDeg >= Math.max(t.jumpYawDeg, t.maxTurnAccelerationDps2 * reach))
    return { translationM, yawDeg, jump }
  }

  /** The numbers a jump's event carries: the step, how fast it was, and the part motion did not explain. */
  private _jumpNumbers(step: Step, verdict: Unexplained): Partial<FrameDiscontinuity> {
    const translationM = Math.hypot(step.dx, step.dy, step.dz)
    return {
      translationM,
      ...(step.yaw !== null ? { yawDeg: Math.abs(step.yaw) } : {}),
      speedMps: translationM / step.dtS,
      dtMs: step.dtS * 1000,
      unexplainedM: verdict.translationM,
      ...(verdict.yawDeg !== null ? { unexplainedYawDeg: verdict.yawDeg } : {}),
    }
  }

  /** A measured jump is counted, and what it was is what the readout shows. */
  private _countJump(verdict: Unexplained): void {
    this._poseJumps++
    this._lastJumpM = verdict.translationM
    if (verdict.yawDeg !== null) this._lastJumpDeg = verdict.yawDeg
  }

  /**
   * An anchor's step, or a handle given up, that would begin an epoch: it does, unless an epoch that something else began accounts
   * for it, and then it joins that one (`_foldAnchor`). `absence` is the record of the time the anchor was gone, when it was.
   */
  private _anchorSays(
    tMs: number,
    fact: AnchorFact,
    numbers: Partial<FrameDiscontinuity>,
    absence: AnchorAbsence | undefined,
  ): FrameDiscontinuity | null {
    if (this._inDisturbance(tMs) || (absence && this._accountsFor(absence))) return this._foldAnchor(tMs, fact, numbers)
    if (fact.what === 'moved') {
      this._poseJumps++
      this._lastJumpM = numbers.translationM ?? 0
      if (numbers.yawDeg !== undefined) this._lastJumpDeg = numbers.yawDeg
    }
    const event = this._bump('anchor', tMs, { ...numbers, anchor: fact })
    // A stretch of degraded tracking that is still open has had its epoch: its end is not a second one.
    if (this._episode) this._episode.bumped = true
    return event
  }

  /**
   * Whether a disturbance that has its epoch is going on at `tMs`, or only just ended or began: a resume or a reset that no good
   * pose has closed, a stretch of bad tracking in which an epoch has begun, or `refractoryMs` since the later of the last epoch's
   * beginning and the end of the trip or stretch it was part of. What an anchor says then is part of that epoch. A stretch of bad
   * tracking that has not had an epoch is not one: how it ends is still to be decided (it may be a blip), and an anchor that steps
   * in it is evidence that it was not.
   */
  private _inDisturbance(tMs: number): boolean {
    return this._trip !== null || this._episode?.bumped === true || tMs - this._lastActiveMs < this._thresholds.refractoryMs
  }

  /** Whether an epoch accounts for an anchor having been away: one was going when it went, or one began while it was gone. */
  private _accountsFor(absence: AnchorAbsence): boolean {
    return absence.accounted || this._lastBumpMs >= absence.sinceMs
  }

  /**
   * The trip whose epoch an anchor's report joins, when there is one it can give a size to: the one that is open, or the one that
   * ended no more than `refractoryMs` ago, if it began the latest epoch.
   */
  private _tripFor(tMs: number): Trip | null {
    if (this._trip) return this._trip
    return this._lastTrip && tMs - this._lastActiveMs < this._thresholds.refractoryMs ? this._lastTrip : null
  }

  /**
   * An anchor's step, or a handle given up, that joins an epoch: counted as folded. A step that finds the epoch of a resume, or of a
   * reset that came with no transform, without a size gives it this one, and the epoch counts as the measured frame shift it was.
   */
  private _foldAnchor(tMs: number, fact: AnchorFact, numbers: Partial<FrameDiscontinuity>): FrameDiscontinuity | null {
    this._anchorsFolded++
    const trip = this._tripFor(tMs)
    if (!trip || fact.what !== 'moved') return null
    if (trip.event.translationM !== undefined || trip.event.yawDeg !== undefined) return null
    // Counted once for the trip: a reset the runtime reported has counted it already, and a reset that comes after this one has not
    // been swallowed (see `noteReset`).
    if (!trip.reported && !trip.sized) this._poseJumps++
    trip.sized = true
    this._lastJumpM = numbers.translationM ?? 0
    if (numbers.yawDeg !== undefined) this._lastJumpDeg = numbers.yawDeg
    return this._amend(trip, { ...numbers, anchor: fact })
  }

  /** Keeps the farthest an anchor has been from its baseline in this epoch, for the drift flag. */
  private _addDrift(total: AnchorMovement): void {
    if (Number.isFinite(total.translationM)) this._driftM = Math.max(this._driftM, total.translationM)
    const yaw = Math.abs(total.yawDeg)
    if (Number.isFinite(yaw)) this._driftYawDeg = Math.max(this._driftYawDeg, yaw)
  }

  private _anchorDiagnostics(): AnchorDiagnostics {
    const t = this._thresholds
    return {
      lost: this._anchorsLost,
      returned: this._anchorsReturned,
      expired: this._anchorsExpired,
      folded: this._anchorsFolded,
      maxDriftM: this._driftM,
      maxDriftYawDeg: this._driftYawDeg,
      driftFlagged: this._driftM >= t.anchorDriftTranslationM || this._driftYawDeg >= t.anchorDriftYawDeg,
    }
  }

  /** A resume or a reset begins a trip (the caller opens it): nothing is compared with a pose from before it. */
  private _forgetOldFrame(): void {
    this._last = null
    this._good = null
    this._prevStep = null
    this._episode = null
  }

  private _bump(
    cause: FrameDiscontinuityCause,
    tMs: number,
    extra: Partial<FrameDiscontinuity>,
  ): FrameDiscontinuity {
    this._epoch++
    this._lastBumpMs = tMs
    this._lastActiveMs = tMs
    // Whatever began the epoch before this one cannot be added to now: this is the latest.
    this._lastTrip = null
    // The anchors' baselines are for the frame that has just ended: drift is counted afresh in the new one.
    this._driftM = 0
    this._driftYawDeg = 0
    const event = frozenEvent({ ...extra, epoch: this._epoch, cause, atMs: tMs })
    this._logTotal++
    this._log.push(event)
    if (this._log.length > FRAME_LOG_MAX) this._log.splice(0, this._log.length - FRAME_LOG_MAX)
    this._announce(event)
    return event
  }

  /**
   * Add what a later report says to the epoch a trip began. The epoch number does not change
   * and the event is replaced, in the log and for the listeners, which see the same epoch
   * again with more in it.
   */
  private _amend(trip: Trip, extra: Partial<FrameDiscontinuity>): FrameDiscontinuity {
    const was = trip.event
    const event = frozenEvent({ ...was, ...extra })
    trip.event = event
    const at = this._log.lastIndexOf(was)
    if (at >= 0) this._log[at] = event
    this._announce(event)
    return event
  }

  private _announce(event: FrameDiscontinuity): void {
    if (this._deferNotify) this._pending.push(event)
    else this._dispatch(event)
  }

  private _dispatch(event: FrameDiscontinuity): void {
    for (const listener of [...this._listeners]) {
      try {
        listener(event)
      } catch (e) {
        // A listener is somebody else's code; one that throws must not stop the others, or
        // the frame loop that called us.
        console.warn('[frame-epoch] a discontinuity listener threw:', e)
      }
    }
  }
}

// ── The calibration readout ─────────────────────────────────────────────────

/**
 * The line the calibration modal shows about tracking (src/ar/project-calibration.ts),
 * from what a provider reports. Says what the code knows: how many times the frame was
 * measured or reported to have moved, how far the last one was when that is known, and how
 * many more times tracking was interrupted with nothing measured.
 *
 * Before this, the modal counted measured jumps only, so a relocalization with the pose
 * unchanged read "no frame shifts", and a reset the runtime could not describe read
 * "last 0.00 m", which is a measurement it did not make.
 */
export function describeTracking(d: TrackingDiagnostics): { text: string; warn: boolean } {
  const parts = [`Tracking ${d.status}`]
  const shifts = d.poseJumps
  const interruptions = Math.max(0, (d.epoch ?? 0) - shifts)
  if (shifts > 0) {
    parts.push(`⚠ ${shifts} frame shift${shifts === 1 ? '' : 's'}`)
    const sizes: string[] = []
    if (d.lastJumpM > 0) sizes.push(`${d.lastJumpM.toFixed(2)} m`)
    if ((d.lastJumpDeg ?? 0) > 0) sizes.push(`${(d.lastJumpDeg ?? 0).toFixed(0)}°`)
    if (sizes.length > 0) parts.push(`last ${sizes.join(', ')}`)
  }
  if (interruptions > 0) {
    parts.push(`⚠ tracking interrupted ${interruptions} time${interruptions === 1 ? '' : 's'}`)
  }
  if (shifts === 0 && interruptions === 0) parts.push('no frame shifts')
  return { text: parts.join(' · '), warn: shifts > 0 || interruptions > 0 }
}

// ── What one scan has seen ──────────────────────────────────────────────────

/**
 * The part of an AR provider the scan log reads. Every member is optional on purpose: a
 * provider with no signal stays at epoch 0 and never fires.
 */
export interface FrameEpochSource {
  getFrameEpoch?(): number
  onFrameDiscontinuity?(cb: FrameDiscontinuityListener): () => void
  getTrackingDiagnostics?(): TrackingDiagnostics
}

/** The epoch a provider is in; 0 for one with no signal, or one that answers with nonsense. */
export function epochOf(source: FrameEpochSource | null | undefined): number {
  const epoch = source?.getFrameEpoch?.()
  return typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : 0
}

/** The part of the point cloud (src/scene/pointcloud.ts) the sidecar record reads. */
export interface FrameEpochCloud {
  /** How many points each epoch holds, lowest epoch first. Epochs with none are absent. */
  epochCounts(): Array<{ epoch: number; count: number }>
  /** The last floor fitted in each epoch the scan has seen. */
  groundObjects(): GroundEstimate[]
}

/** One epoch of the scan, as the sidecar lists it. */
export interface FrameEpochEntry {
  epoch: number
  /** What began it: 'start' for the epoch the scan began in. Absent when this log did not see it begin. */
  cause?: 'start' | FrameDiscontinuityCause
  /** When it began, as a wall-clock time. Absent with `cause`. */
  startedAt?: string
  /** How many points of the cloud are in it. */
  pointCount: number
  /** The floor fitted in it, or null when too few of its points were seen to fit one. */
  ground: GroundEstimate | null
}

/** One discontinuity in the scan's log: the event, and when it was seen as a wall-clock time. */
export interface FrameJumpRecord extends FrameDiscontinuity {
  at: string
}

/** Why the floor of one epoch was the one the exporter drew. */
export type FloorBasis = 'locked' | 'fitted' | 'refit'

/**
 * What a scan's sidecar says about the frames it was recorded in (`frameEpochs` in the
 * upload metadata and in the GLB's scene extras).
 *
 * What this does and does not claim. It says that tracking was interrupted or the runtime
 * reported a move, how often, and which points were recorded after each. It does not say
 * that a frame moved: a 'recovered' or 'resumed' epoch, or an 'anchor' epoch that began
 * with the runtime giving an anchor up, is a suspect one (see the top of
 * this file), and `mixedEpochs` means the cloud holds points from more than one stretch
 * of tracking, not that the stretches disagree. Nothing here is a registration, and no
 * epoch is "verified".
 *
 * Old sidecars have no `frameEpochs`, and a reader treats that as "not recorded", never
 * as "no shifts".
 */
export interface FrameEpochsSidecar {
  /** The shape of this record. */
  version: 1
  /** The epoch the scan began in. */
  baseEpoch: number
  /**
   * The epoch the Place calibration was made in (the epoch the calibration flow began in,
   * so a shift during it counts), or null when the scan was not calibrated. A scan whose
   * points are in another epoch than this one is not in the Place's frame as far as anything
   * here can say: that is the case a Clear after a shift makes, and `baseEpoch` alone hides.
   */
  calibrationEpoch: number | null
  /** The epoch the runtime was in when the record was written. */
  currentEpoch: number
  /**
   * The epoch whose floor the exporter drew, or null for an empty cloud: the calibration's
   * epoch (else the scan's first) when its floor settled, else the epoch with the most points
   * whose floor did, else (see `floorBasis`) the best of what was fitted or, with nothing
   * fitted, the epoch with the most points.
   */
  floorEpoch: number | null
  /**
   * 'locked' when that epoch's kept floor had settled (six estimates agreeing), 'fitted' when
   * a floor was fitted and had not, 'refit' when no floor was kept for any epoch and the
   * exporter fits one over that epoch's points. Null with no points.
   */
  floorBasis: FloorBasis | null
  /** True when the cloud holds points of more than one epoch. */
  mixedEpochs: boolean
  /** How many epochs there were, including any dropped from `epochs`. */
  epochCount: number
  /**
   * The epochs, lowest first: the scan's first, the calibration's, the floor's and the
   * current one always, and the most recent of the rest up to FRAME_LOG_MAX in all.
   */
  epochs: FrameEpochEntry[]
  /** How many epochs `epochs` leaves out. */
  epochsOmitted: number
  /** How many discontinuities there were since the scan began, including any dropped from `jumps`. */
  jumpCount: number
  /** The discontinuities, oldest first; the most recent FRAME_LOG_MAX of them. */
  jumps: FrameJumpRecord[]
  /** Time spent with degraded tracking since the scan began, in milliseconds. */
  limitedMs: number
  /** Jumps folded into an earlier one since the AR session began; a run that has many has thresholds that are too tight. */
  suppressedJumps: number
  /**
   * How the camera moved while tracking was good since the AR session began (not the scan:
   * the distributions cannot be cut at a Clear). Null from a provider that keeps none.
   */
  motion: MotionStats | null
  /**
   * The drift checks made while this scan was recorded (src/ar/closure.ts): the person tapped the landmark again and
   * the record says where it landed against where the calibration put it, how far the camera had walked, and which
   * limits it was judged by. The most recent FRAME_LOG_MAX of them. Absent when none was made, which does not mean the
   * frame did not move: nothing was asked.
   */
  closures?: FrameClosureRecord[]
  /** The detector's numbers when this was written, so a later run can re-read the record. */
  thresholds: typeof FRAME_EPOCH_ADOPTED & { basis: 'adopted, not measured' }
}

/**
 * Which epoch's floor a scan's exporter should draw, and on what basis.
 *
 * A cloud that spans a shift has a floor in each frame and the lowest of all of them is the
 * floor of none. The anchor epoch (the calibration's, else the scan's first) is preferred,
 * because it is the frame the Place was measured in, but only when its floor was well
 * supported: an epoch of a few wall points that happened to come first draws a floor at head
 * height. Among epochs whose floor was fitted and had not settled, the same rule; among
 * epochs with no fitted floor, the one with the most points, which has the best percentile.
 */
export function chooseFloorEpoch(
  counts: ReadonlyArray<{ epoch: number; count: number }>,
  grounds: ReadonlyArray<GroundEstimate>,
  anchorEpoch: number,
): { epoch: number | null; basis: FloorBasis | null } {
  if (counts.length === 0) return { epoch: null, basis: null }
  const groundOf = (epoch: number): GroundEstimate | undefined => grounds.find((g) => g.epoch === epoch)
  const largest = (pool: ReadonlyArray<{ epoch: number; count: number }>): number =>
    [...pool].sort((a, b) => b.count - a.count || a.epoch - b.epoch)[0].epoch
  const preferAnchor = (pool: ReadonlyArray<{ epoch: number; count: number }>): number =>
    pool.some((c) => c.epoch === anchorEpoch) ? anchorEpoch : largest(pool)
  // A floor that was fitted on horizontal structure; a percentile of a cloud with none is not one.
  const fitted = counts.filter((c) => {
    const g = groundOf(c.epoch)
    return !!g && !g.fallback
  })
  const settled = fitted.filter((c) => groundOf(c.epoch)?.locked)
  if (settled.length > 0) return { epoch: preferAnchor(settled), basis: 'locked' }
  if (fitted.length > 0) return { epoch: preferAnchor(fitted), basis: 'fitted' }
  // Nothing to go on but the points themselves: the epoch with the most of them has the best percentile.
  return { epoch: largest(counts), basis: 'refit' }
}

/**
 * What one scan has seen of its provider's epochs: how many discontinuities since it began,
 * and the record the sidecar carries. One per page, made before the AR session starts.
 *
 * It exists apart from the provider because the provider's counters belong to the AR
 * session, and a scan can end and another begin inside one session (Clear, or loading
 * another). `reset()` is the beginning of a scan.
 *
 * The Place calibration does not end with the scan, though: a Clear keeps it, and the next
 * scan is placed by it. So the shifts that matter to a scan are those since the earlier of
 * its own start and the frame its calibration was made in (`noteCalibrated`): a shift after
 * the scan began leaves its points in more than one frame, and a shift between the
 * calibration and the scan leaves all of them in a frame the Place was not measured in.
 *
 * `hasDiscontinuitySince()` and `discontinuitiesSince()` are what the post-commit re-anchor
 * flow reads: calibrate at epoch N, and ask whether the provider has moved on from N.
 */
export class ScanFrameEpochLog {
  private _source: FrameEpochSource | null = null
  private _unsubscribe: (() => void) | null = null
  private _baseEpoch = 0
  private _calibrationEpoch: number | null = null
  private _startedAt = new Date().toISOString()
  private _limitedBase = 0
  private _jumps: FrameJumpRecord[] = []
  private _jumpCount = 0
  private _closures: FrameClosureRecord[] = []

  /** Start listening to a provider. Call before its session starts, so no event is missed. */
  attach(source: FrameEpochSource): void {
    this._unsubscribe?.()
    this._source = source
    this._calibrationEpoch = null
    this._begin()
    this._unsubscribe = source.onFrameDiscontinuity?.((event) => this._record(event)) ?? null
  }

  /** A new scan begins: forget the old one's discontinuities and count from here. The calibration stays. */
  reset(): void {
    this._begin()
  }

  /**
   * The Place calibration was made, in `epoch` (the one the provider was in when the flow
   * began, by default the one it is in now). Shifts are counted from there until another
   * calibration replaces it, so a scan begun after a Clear is not 'ready' in a frame the
   * calibration was not made in.
   */
  noteCalibrated(epoch: number = this.currentEpoch): void {
    this._calibrationEpoch = Number.isFinite(epoch) && epoch > 0 ? Math.min(Math.floor(epoch), this.currentEpoch) : 0
  }

  /**
   * The scan has no Place calibration any more: a scan begun after a re-anchor is in no frame until it is calibrated,
   * and the old calibration's epoch must not be counted against it. Shifts are counted from the scan's own start again.
   */
  forgetCalibration(): void {
    this._calibrationEpoch = null
  }

  /**
   * A drift check was made (src/ar/closure.ts). Kept with the scan and written into the sidecar, the most recent
   * FRAME_LOG_MAX of them. A new scan (`reset()`) starts with none.
   */
  noteClosure(record: FrameClosureRecord): void {
    this._closures.push({ ...record, limits: { ...record.limits }, taps: record.taps.map((tap) => ({ ...tap })) })
    if (this._closures.length > FRAME_LOG_MAX) this._closures.splice(0, this._closures.length - FRAME_LOG_MAX)
  }

  /** The drift checks this scan has had, oldest first. */
  get closures(): ReadonlyArray<FrameClosureRecord> {
    return this._closures
  }

  /** Whether any drift check of this scan was over its limits: a gap the quality verdict has to account for. */
  get closureExceeded(): boolean {
    return this._closures.some((closure) => closure.exceeded)
  }

  /** Stop listening. */
  detach(): void {
    this._unsubscribe?.()
    this._unsubscribe = null
    this._source = null
  }

  /** The epoch the provider is in now. */
  get currentEpoch(): number {
    return epochOf(this._source)
  }

  /** The epoch the provider was in when this scan began. */
  get baseEpoch(): number {
    return this._baseEpoch
  }

  /** The epoch the scan's geometry is placed in: the calibration's when there is one, else the scan's first. */
  get anchorEpoch(): number {
    return this._calibrationEpoch ?? this._baseEpoch
  }

  /** The epoch the Place calibration was made in, or null when the scan has none. */
  get calibrationEpoch(): number | null {
    return this._calibrationEpoch
  }

  /**
   * How many discontinuities there have been since the earlier of the scan's start and its
   * calibration's frame: a shift after the calibration was made, or after the scan began,
   * leaves the scan's points in more than one frame, and a Clear after a shift leaves the whole
   * scan in a frame the calibration was not made in. Read from the provider's epoch, which only
   * goes up by one at a discontinuity, so it counts for a provider that has an epoch and no
   * event to listen to; an event count is the floor for one that has events and no epoch.
   */
  get frameShifts(): number {
    const from = Math.min(this._baseEpoch, this._calibrationEpoch ?? this._baseEpoch)
    return Math.max(0, this.currentEpoch - from, this._jumpCount)
  }

  /** Time spent with degraded tracking since this scan began, in milliseconds. */
  get limitedMs(): number {
    const now = this._source?.getTrackingDiagnostics?.()?.limitedMs ?? 0
    return Math.max(0, now - this._limitedBase)
  }

  /** Whether the provider has moved on from `epoch`. */
  hasDiscontinuitySince(epoch: number): boolean {
    return this.currentEpoch > epoch
  }

  /** The discontinuities that began an epoch after `epoch`, oldest first. */
  discontinuitiesSince(epoch: number): FrameJumpRecord[] {
    return this._jumps.filter((jump) => jump.epoch > epoch)
  }

  /** The record the sidecar carries. `cloud` is the scan's point cloud, for the per-epoch counts and floors. */
  snapshot(cloud?: FrameEpochCloud | null): FrameEpochsSidecar {
    const counts = cloud ? cloud.epochCounts() : []
    const grounds = cloud ? cloud.groundObjects() : []
    const currentEpoch = this.currentEpoch
    const diagnostics = this._source?.getTrackingDiagnostics?.()
    const beganBy = new Map<number, FrameJumpRecord>()
    for (const jump of this._jumps) beganBy.set(jump.epoch, jump)
    const floor = chooseFloorEpoch(counts, grounds, this.anchorEpoch)
    const jumpCount = Math.max(this._jumpCount, currentEpoch - this._baseEpoch)

    const seen = new Set<number>([this._baseEpoch, currentEpoch])
    if (this._calibrationEpoch !== null) seen.add(this._calibrationEpoch)
    if (floor.epoch !== null) seen.add(floor.epoch)
    for (const { epoch } of counts) seen.add(epoch)
    for (const jump of this._jumps) seen.add(jump.epoch)
    const ordered = [...seen].sort((a, b) => a - b)

    const entries: FrameEpochEntry[] = ordered.map((epoch) => {
      const jump = beganBy.get(epoch)
      const origin: Pick<FrameEpochEntry, 'cause' | 'startedAt'> = epoch === this._baseEpoch
        ? { cause: 'start', startedAt: this._startedAt }
        : jump ? { cause: jump.cause, startedAt: jump.at } : {}
      return {
        epoch,
        ...origin,
        pointCount: counts.find((c) => c.epoch === epoch)?.count ?? 0,
        ground: grounds.find((g) => g.epoch === epoch) ?? null,
      }
    })

    // Past FRAME_LOG_MAX epochs the record keeps the ones nothing else can be read without
    // (the first, the calibration's, the floor's, the current one) and the newest of the rest.
    const must = new Set<number>([this._baseEpoch, currentEpoch])
    if (this._calibrationEpoch !== null) must.add(this._calibrationEpoch)
    if (floor.epoch !== null) must.add(floor.epoch)
    let kept = entries
    if (entries.length > FRAME_LOG_MAX) {
      const room = Math.max(0, FRAME_LOG_MAX - must.size)
      const others = entries.filter((e) => !must.has(e.epoch)).slice(-room)
      const keep = new Set<number>([...must, ...others.map((e) => e.epoch)])
      kept = entries.filter((e) => keep.has(e.epoch))
    }

    return {
      version: 1,
      baseEpoch: this._baseEpoch,
      calibrationEpoch: this._calibrationEpoch,
      currentEpoch,
      floorEpoch: floor.epoch,
      floorBasis: floor.basis,
      mixedEpochs: counts.length > 1,
      // One epoch for the base, and one for every discontinuity: the log can have dropped the
      // entries for the early ones, and the count must still say they happened.
      epochCount: Math.max(entries.length, jumpCount + 1),
      epochs: kept,
      epochsOmitted: Math.max(entries.length, jumpCount + 1) - kept.length,
      jumpCount,
      jumps: this._jumps.map((jump) => ({
        ...jump,
        ...(jump.transform ? { transform: copyTransform(jump.transform) } : {}),
        ...(jump.anchor ? { anchor: { ...jump.anchor } } : {}),
      })),
      limitedMs: Math.round(this.limitedMs),
      suppressedJumps: diagnostics?.suppressedJumps ?? 0,
      motion: diagnostics?.motion ? cloneData(diagnostics.motion) : null,
      ...(this._closures.length > 0 ? { closures: cloneData(this._closures) } : {}),
      thresholds: { ...FRAME_EPOCH_ADOPTED, basis: 'adopted, not measured' },
    }
  }

  private _begin(): void {
    this._baseEpoch = epochOf(this._source)
    this._startedAt = new Date().toISOString()
    this._limitedBase = this._source?.getTrackingDiagnostics?.()?.limitedMs ?? 0
    this._jumps = []
    this._jumpCount = 0
    this._closures = []
  }

  private _record(event: FrameDiscontinuity): void {
    const copy: FrameJumpRecord = {
      ...event,
      ...(event.transform ? { transform: copyTransform(event.transform) } : {}),
      ...(event.anchor ? { anchor: { ...event.anchor } } : {}),
      at: new Date().toISOString(),
    }
    // The same epoch again is the tracker adding to it (a reset reported after a resume), not
    // a second discontinuity: it replaces the record and is not counted.
    const last = this._jumps[this._jumps.length - 1]
    if (last && last.epoch === event.epoch) {
      this._jumps[this._jumps.length - 1] = { ...copy, at: last.at }
      return
    }
    this._jumpCount++
    this._jumps.push(copy)
    if (this._jumps.length > FRAME_LOG_MAX) this._jumps.splice(0, this._jumps.length - FRAME_LOG_MAX)
  }
}

/** A deep copy of plain data (numbers, arrays and objects of them), so a record shares nothing with a live counter. */
function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
