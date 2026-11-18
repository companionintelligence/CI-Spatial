import * as THREE from 'three'
import type { ARProvider, HitResult } from './provider'
import type {
  CalibrationReferencePhoto,
  Project,
  ProjectSpatialFrame,
  ScanCalibration,
  Vec3,
} from '../world/types'
import {
  referenceCrosshairPixels,
  referencePhotoTitle,
  type PendingReferencePhoto,
  type ReferencePhotoCapture,
  type ReferencePhotoRole,
} from './reference-photo'
import {
  bearingConventionFromSearch,
  northYawInSessionDeg,
  sessionFrameBearingDeg,
  twoPointSeparationM,
  MIN_POINT_SEPARATION_M,
  originDecalPlan,
  originHeadingBearingDeg,
  transformPoint,
} from '../world/geo'
import { buildAnchorMarker, ANCHOR_RADIUS_M } from '../world/anchor-marker'
import { invertAffine } from '../world/anchor-placement'
import { buildOriginDecal, COMMITTED_ORIGIN_NAME, STORED_ORIGIN_NAME } from '../world/origin-decal'
import { twoPointToleranceM, type FrameFit } from '../world/frame-fit'
import {
  baselineGuidance,
  checkPointGuidance,
  headingStepCopy,
  landmarkStepCopy,
  type BaselineGuidance,
} from '../world/baseline-guidance'
import {
  assessTwoPoint,
  buildOnePointCommit,
  buildTwoPointCommit,
  mismatchCopy,
  readTap,
  resolveCommitOptions,
} from './calibration-commit'
import { isSameHeightRetry, isTapOnGround, mayWritePlaceFrame, tapHeightAboveGroundCm } from './ground-gate'
import { IMPROVE_REFERENCE_LABEL, KEEP_REFERENCE_LABEL, RECORD_UNVERIFIED_LABEL, REPLACE_REFERENCE_LABEL } from './replace-copy'
import { generationActions, improveShown, isUpgrade, keepShown, type GenerationHooks } from './replace-reference'
import { ONE_POINT_LABEL, onePointOffered } from './one-point-offer'
import { describeTracking } from './frame-epoch'
import { createCalibrationTaps, type CalibrationTapSampler } from './calibration-taps'
import { calibrationEpochField } from './calibration-epoch'
import {
  checkAction,
  checkPointState,
  comparedPoints,
  ghostPlan,
  planCheckPoint,
  previewVisit,
  stepsInVisit,
  stepStates,
  type VisitComparison,
  type VisitPreview,
} from './constellation-flow'
import {
  ADJUST_POINT_LABEL,
  CHECK_BLOCKED_STATUS,
  CHECK_SKIPPED_RETURN,
  CHECK_STEP_LABEL,
  MISMATCH_COPY_POINTS,
  MISMATCH_TITLE_POINTS,
  REVIEW_MISMATCH_STATUS,
  WRONG_PLACE_LABEL,
  checkStageCard,
  fitReadout,
  labelCaption as labelCaptionFor,
  markerName,
  noPhotoNote,
  reviewCopy,
  uncomparedReadout,
} from './constellation-copy'
import { createGhostLayer, drawStoredConstellation, GHOST_GAP_NAME, GHOST_NAME } from './constellation-ghosts'
import { createReferencePhotoFlow, lensOfProvider } from './reference-photo-flow'
import { createReturnVisitAids, returnAidsEnabled, returnVisitMarkup } from './return-visit-aids'

const TRACKING_TIMEOUT_MS = 10_000
/**
 * How long to wait for the ground plane to stabilise before offering to
 * proceed without it. A feature-poor room must stay scannable — the gate
 * improves the common case, it does not get to make the app unusable in the
 * uncommon one.
 */
const GROUND_WAIT_TIMEOUT_MS = 20_000

export interface CalibrationResult {
  calibration: ScanCalibration
  /**
   * Returned whenever the Place's durable frame **changed** and should be
   * persisted — a first calibration, an upgrade from the one-point fallback
   * tier, or a deliberate override that re-establishes the reference.
   *
   * Deliberately absent when a stored two-point frame was merely *verified*:
   * that frame is the reference the measurement was taken against, and
   * rewriting it on every visit would let it drift session by session, which
   * is exactly the failure the separation check exists to catch.
   */
  spatialFrame?: ProjectSpatialFrame
  /**
   * Reference photos captured for the markers (two, or three with a check point),
   * for the host to persist and upload (wave 09 ticket 0007).
   *
   * Present only alongside a changed `spatialFrame`, and for the same reason:
   * the photos describe *that* frame's two points. A merely-verified visit
   * keeps the stored frame, so it keeps the stored photos too — re-shooting
   * them every visit would let the reference drift exactly as rewriting the
   * frame would.
   *
   * Never populated on the `'ground-tap-compass'` fallback tier: that tier has
   * no cross-session verification story at all, and a re-acquisition aid on it
   * would imply one.
   */
  referencePhotos?: PendingReferencePhoto[]
  /**
   * The frame epoch the runtime was in as the flow began (src/ar/frame-epoch.ts): what a discontinuity after it is
   * counted against, and what the re-anchor flow watches the runtime move past. Absent for a provider with no epoch
   * signal. Read as the flow begins, not at the commit, so a shift while the points were being placed counts.
   */
  calibrationEpoch?: number
  /**
   * Compass bearing, clockwise from the compass's (magnetic) north, of the committed origin's heading
   * arrow, for the HUD's frame-heading needle (wave 12, ticket 0001): `originHeadingBearingDeg`
   * (../world/geo.ts), under the sign rule the flow ran under. It is the arrow as drawn, which lies
   * along the baseline that was tapped. On a first calibration, and on a return visit compared by
   * distance, that is the baseline the record's `projectBearingDeg` is the bearing of, so the needle
   * and the record say one number. On a return visit that fitted three points they do not: the record's
   * bearing follows the fit's heading, which is the tapped baseline's turned by the fit's
   * `headingResidualDeg` (on the same record), so there, under the current sign rule, the record's
   * bearing is the needle's plus that residual, and the needle stays with the arrow on the floor
   * (tests/unit/node/origin_heading_bearing.test.ts, "three points fitted"). Under `?bearing=1` a
   * fitted record is not written under the rule the needle follows (`projectBearingDeg` in ../world/geo.ts
   * says how), so that relation does not hold there. Present only when this visit committed a two-point origin with
   * a compass fix. A return-visit commit carries it too, since that commit draws its own origin with a
   * tick; the stored origin drawn beside it has no tick. Absent on the one-point tier, which draws no
   * arrow, and when there is no compass fix. A page that drops the calibration this came with
   * hides the needle again (`dropCalibrationDrawings` in src/main.ts).
   */
  originBearingDeg?: number
}

interface CalibrationOptions {
  provider: ARProvider
  project: Project
  /** The live AR canvas — tap position is read from real touch events on it. */
  canvas: HTMLCanvasElement
  /** Hit-tests a real screen tap (normalised 0-1 coords), not a fixed reticle. */
  hitTest: (x: number, y: number) => Promise<HitResult | null>
  /**
   * Reads a floor tap as a burst of hits, through the tracking and range gates, and keeps what the burst measured
   * (src/ar/calibration-taps.ts builds it). Absent, a tap is one hit from `hitTest` as it always was, and nothing
   * about how a tap was measured reaches the calibration.
   */
  sampleTap?: CalibrationTapSampler
  /**
   * Compass bearing in degrees, clockwise from MAGNETIC north (no declination is
   * applied: src/geo/compass-heading.ts), of the direction the camera faces,
   * sampled fresh at tap time via a getter rather than a snapshot — it can change
   * between when this modal opens and when the user actually taps. Null when the
   * compass has no reading yet, or none that can be paired with the camera's pose.
   *
   * On the two-point tier this is **metadata only** (ADR 0005): it records
   * which way north was, and contributes nothing to the frame's heading.
   */
  bearing: () => number | null
  /**
   * Live ground-plane estimate in session-local metres, plus whether it has
   * stabilised. A getter for the same reason as `bearing` — it changes while
   * the modal is open, which is the entire point of the readiness step.
   * `null` means no estimate yet.
   */
  ground: () => {
    y: number
    locked: boolean
    sampleCount?: number
    inlierCount?: number
    residualM?: number
    fallback?: boolean
  } | null
  /**
   * What the Place's reference needs from the page (WP-08): the confirmation before it is replaced, the way out of the
   * landmark stage that runs the flow again as an upgrade, the upgrade mode and the way back from it. See
   * ./replace-reference.ts. Absent, the modal behaves as it did before: nothing is asked and no extra way out is shown.
   */
  generation?: GenerationHooks
  /**
   * Grabs the live camera frame for a marker's reference photo (ticket 0007).
   *
   * Optional, and allowed to resolve `null` or reject. A denied frame, a
   * pending capture, or a host that supplies no accessor at all degrades
   * re-acquisition on the next visit — it must never fail the calibration.
   * A miss is a missing photo: the commit asks again, says which point is
   * still missing once, and the press after that saves without it
   * (./reference-photo-flow.ts). A host with no accessor, or one that has
   * no frame to give, is not held for.
   */
  capturePhoto?: () => Promise<ReferencePhotoCapture | null>
  /**
   * Resolves a stored reference photo to something an `<img>` can display —
   * the local blob where this device took it, the server copy otherwise.
   * `null` when neither is reachable, which the panel reports rather than
   * showing an empty box.
   */
  loadReferencePhoto?: (photo: CalibrationReferencePhoto) => Promise<string | null>
  /**
   * The "Wrong Place? Choose another" exit on the mismatch screen, for a person who is standing in a different Place from
   * the one they chose, whose stored pair they cannot find because it is not here (WP-07 supplies the hook, WP-08 the
   * behaviour). Optional: the button is on the card only where the host supplies this. Pressed, the modal calls it and
   * closes with no calibration, as "Continue uncalibrated" does; what happens next (the Place picker, another Place's
   * frame) is the host's. It is called once, and it should not throw.
   */
  onWrongPlace?: () => void
}

type Stage = 'ground' | 'landmark' | 'heading' | 'check' | 'review' | 'mismatch'
type MarkerId = 'landmark' | 'heading' | 'check'

const MARKER_IDS: MarkerId[] = ['landmark', 'heading', 'check']

/**
 * How far the heading marker's own measured height may sit from the
 * landmark's before the pair is called into question, in metres.
 *
 * Both markers are floor taps, so their raw heights should agree to within
 * hit-test noise. A larger disagreement is real evidence that one of them
 * landed on something that is not the floor — a step, a rug edge, a chair
 * rail — which the frame would otherwise absorb silently.
 *
 * **Adopted by decision, not by measurement.** Ticket 0006 closed without
 * running its benchmark. Deliberately tighter than GROUND_TAP_TOLERANCE_M:
 * that gate asks "is this roughly floor height?", this one asks "are these two
 * the same floor?".
 *
 * **Revisit when:** the warning fires on pairs the user is confident are both
 * on the floor, which would mean real hit-test noise exceeds the ~3 cm this
 * assumes.
 */
const MARKER_HEIGHT_DISAGREEMENT_M = 0.15

/**
 * Opacity of the floor grid once the origin is committed and it stays up for
 * the scan. Well under the flow's 0.4 "settled" value: during calibration the
 * grid is the thing being judged, and during a scan it is a reference only.
 */
const SCAN_FLOOR_OPACITY = 0.12

/**
 * Floor-plane overlay extent, in metres, and its subdivision count.
 *
 * 10 m at 20 divisions gives 0.5 m cells, which is deliberate on two counts:
 * the grid stays legible at room scale, and the cells double as a distance
 * gauge — two cells is `MIN_POINT_SEPARATION_M`, so a user can see whether
 * they have walked far enough for the heading marker without reading a number.
 */
const FLOOR_GRID_SIZE_M = 10
const FLOOR_GRID_DIVISIONS = 20

/** Scene name of the marker a commit leaves where its check point was tapped. */
const CHECK_MARKER_NAME = 'calibration anchor check'

/** Scene name of the floor grid: the flow's own while the points are placed, and the dimmed one a commit keeps for the scan. */
const FLOOR_PLANE_NAME = 'calibration floor plane'

/**
 * Everything a commit adds to the scene itself and leaves there, except the floor grid: the origin decal, the stored
 * origin a return visit draws beside it, the check point's marker, and the rings and gap lines where the Place's
 * stored points land (./constellation-ghosts.ts).
 *
 * Each of these is a claim about the calibration that drew it, and goes with it. The floor grid is not a claim about
 * a calibration: it is the ground, which the ticket keeps for the scan (owner R10, wave 12 ticket 0001), and the next
 * commit replaces it by name. So it is not in this set, and goes only with the scan it was kept for
 * (`WithdrawOptions.floor`).
 */
const CALIBRATION_DRAWINGS: ReadonlySet<string> = new Set([
  COMMITTED_ORIGIN_NAME,
  STORED_ORIGIN_NAME,
  CHECK_MARKER_NAME,
  GHOST_NAME,
  GHOST_GAP_NAME,
])

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const drawable = child as Partial<THREE.Mesh>
    drawable.geometry?.dispose()
    const material = drawable.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

export interface WithdrawOptions {
  /**
   * Take the kept floor grid down too. It is the ground the scan keeps (owner R10), so a calibration that is dropped
   * with the scan still going, a Place frame that lost a conflict, leaves it where it is. It goes when the scan has no
   * calibration for it to be kept for: a re-anchor begins a scan in another frame, and the grid stands at the old
   * frame's coordinates, which the shift moved; and a flow that ends with no calibration is a skip, which leaves no
   * floor plane (wave 12 ticket 0001, acceptance criteria and definition of done; DEVICE_TESTING O9).
   */
  floor?: boolean
}

/**
 * Takes down what a commit drew into `scene`, and keeps the floor grid unless `options.floor` says it goes too.
 *
 * A commit leaves its drawings in the scene itself, outside the flow's own `placement` group, so that they outlive the
 * flow. That is also why nothing took them down. It is called when a later commit is about to draw its own (a second
 * run of the modal, as a re-anchor makes, replaces everything the first drew and not only what it happens to draw
 * again: a check marker, a stored origin and a set of ghost rings are not drawn by every commit, and the rings are
 * not one object), which leaves the grid for that commit to replace by name, and by the page when the calibration
 * they describe no longer holds: a re-anchor begins a scan that has none, a Place frame lost a conflict, a flow ended
 * with no calibration (src/main.ts, `dropCalibrationDrawings`, which says which of these take the grid with them).
 *
 * Only the scene's direct children are looked at, which is where a commit adds them. A flow that is running keeps
 * its own copies of the ghost rings and the grid under its `placement` group, and they are not touched, whatever
 * `options` says. Safe to call with no scene (the provider's does not exist until its first frame) and when nothing
 * is there.
 */
export function withdrawCalibrationDrawings(scene: THREE.Object3D | null | undefined, options: WithdrawOptions = {}): void {
  if (!scene) return
  for (const child of [...scene.children]) {
    if (!CALIBRATION_DRAWINGS.has(child.name) && !(options.floor === true && child.name === FLOOR_PLANE_NAME)) continue
    scene.remove(child)
    disposeObject(child)
  }
}

/**
 * Staged two-point ground calibration (wave 09 ticket 0004).
 *
 * Ground plane established -> landmark placed and confirmed -> heading marker
 * placed -> adjust -> commit. The frame's origin is the landmark and its
 * heading comes from the landmark->marker geometry, so a scan no longer
 * inherits the AR session's arbitrary startup yaw and no longer depends on an
 * indoor compass reading (ADR 0005).
 *
 * Both markers stay in **session-local** coordinates for the whole placement
 * phase and are converted to project space exactly once, at commit — mixing
 * the two frames incrementally is the subtle bug this ordering forecloses.
 *
 * #141's single tap survives as the explicitly-labelled lower-accuracy
 * fallback tier for rooms where a second point is impractical.
 */
export function runProjectCalibration(options: CalibrationOptions): Promise<CalibrationResult | null> {
  const existingFrame = options.project.spatialFrame
  const isFirstCalibration = !existingFrame
  /** The sign rule for every bearing this flow writes: the current one, or the old one under `?bearing=1`. */
  const bearingConvention = bearingConventionFromSearch(typeof location === 'undefined' ? '' : location.search)
  /** The stored reference this session can actually be measured against. */
  const storedTwoPoint = existingFrame?.method === 'two-point-ground' ? existingFrame : null
  /** What this visit does about a check point: offered on a first calibration, re-tapped where the Place stores one (./constellation-flow.ts). */
  const checkPlan = planCheckPoint(storedTwoPoint)
  /** How many taps the steps' counters count to: 3 when the check point follows the heading marker by itself, else 2. */
  const visitSteps = stepsInVisit(checkPlan)
  /**
   * How a tap is read, and when a commit is turned away (./calibration-commit.ts), through ./calibration-taps.ts: a burst
   * of hits with the host's `sampleTap`, one hit through `options.hitTest` without. Either way the landmark is watched
   * from the tap that placed it to the commit, for a frame shift where the provider counts them, and from its
   * confirmation for the time it has waited.
   */
  const taps = createCalibrationTaps({
    sampler: options.sampleTap,
    provider: options.provider,
    ground: () => options.ground(),
    watching: () => stage === 'heading' || stage === 'check' || stage === 'review' || stage === 'mismatch' || (stage === 'landmark' && points.landmark !== null),
    ring: () => hold,
    note: () => tapNote,
  })
  const commitOptions = resolveCommitOptions({
    hitTest: (x, y) => options.hitTest(x, y), sampleTap: taps.read, isDisturbed: taps.isDisturbed,
  })
  // The one-point tier has no walk to a second point to bound, so the clock does not apply to it: a shift of the map does.
  const onePointOptions = resolveCommitOptions({
    hitTest: (x, y) => options.hitTest(x, y), sampleTap: taps.read, isDisturbed: taps.shifted,
  })
  /** The epoch this flow begins in, for the result (./calibration-epoch.ts). */
  const epochField = calibrationEpochField(options.provider)

  const trackingWaitStartedAt = Date.now()
  let trackingEverEstablished = false
  let tapInFlight = false
  /** When the floor wait began — clocked from tracking, not from modal open. */
  let groundWaitStartedAt = Date.now()
  /** Set when the user chooses to place without a settled floor estimate. */
  let groundWaitOverridden = false
  /**
   * Height of the most recent tap rejected as off-floor, or null. A retry at
   * this height is the confirmation the override asks for; a tap anywhere else
   * is a fresh attempt and is gated normally. Re-place points forgets it: the
   * gate then begins again, and the same height is turned away again.
   */
  let offGroundTapY: number | null = null

  let stage: Stage = 'ground'
  const points: Record<MarkerId, Vec3 | null> = { landmark: null, heading: null, check: null }
  /**
   * Each marker as it was tapped, with the height it was tapped at. `points` holds the heading marker and the check point at
   * the landmark's height, so that the baseline is level; a fit compares heights, so it is given these (./constellation-flow.ts).
   */
  const tappedAt: Partial<Record<MarkerId, Vec3>> = {}
  /**
   * The markers whose placing tap was accepted off the floor by a same-height retry, kept beside the tap each describes (`tappedAt`):
   * set where a tap is applied to a marker (`applyTap`), and gone when that tap is: the marker placed again or moved by a tap that
   * was on the floor, taken away, or Re-place points. A tap that only selected a marker changes nothing here.
   */
  const offFloorMarkers: Partial<Record<MarkerId, true>> = {}
  /**
   * Whether this commit bypassed a floor check. It is recorded on the commit, and a bypassed commit never writes the Place frame
   * (`mayWritePlaceFrame`), so it is about the points the commit holds. "Place anchor without floor check" bypasses it for the whole
   * flow, because no tap after it was judged against a floor that had locked. Otherwise it is a point that is still placed, whose tap
   * was accepted off the floor by a same-height retry. A marker that was on a table, was seen to be wrong and was put on the floor, or
   * was taken away, no longer counts: the pair that is committed was floor-checked.
   */
  const floorCheckBypassed = (): boolean =>
    groundWaitOverridden || MARKER_IDS.some((id) => points[id] !== null && offFloorMarkers[id] === true)
  /**
   * Whether keeping the pair over a mismatch writes the Place's frame, and so replaces the reference the pair was compared with: it does
   * unless the floor check was bypassed (`mayWritePlaceFrame`, the rule `assessTwoPoint` applies to this very press). Then it records the
   * scan and replaces nothing, so the button must not say it replaces and the question that goes before a replacement is not asked.
   * Read when the card is drawn and when the button is pressed, because the flag changes while the card is up.
   */
  const keepingPairReplacesReference = (): boolean =>
    mayWritePlaceFrame({ floorCheckBypassed: floorCheckBypassed(), hasStoredFrame: storedTwoPoint !== null, override: true })
  let selected: MarkerId | null = null
  /** Residual that triggered the mismatch stage, in metres. */
  let mismatchResidualM = 0
  /** The comparison that sent the flow to the mismatch stage: how many points it compared and what it found. */
  let mismatchComparison: VisitComparison | null = null
  /** The live comparison of the markers placed so far with the stored ones, as the last redraw made it (null when there is nothing to compare by position). */
  let livePreview: VisitPreview | null = null
  /**
   * A message that must survive the 200 ms render poll — a hit-test failure, a
   * floor-gate rejection, a selection acknowledgement. `renderStage()` runs on
   * an interval and rewrites the status line every tick, so without somewhere
   * to park these they are erased within a fifth of a second: the user taps,
   * something goes wrong, and the copy silently reverts to "Tap the ground" as
   * though nothing had happened. Cleared when the next tap begins or the stage
   * changes, so it can never outlive the situation that set it.
   */
  let transientStatus: string | null = null

  // ── Reference photos and labels (ticket 0007) ───────────────────────────
  /** Role each marker id maps to in the stored schema. */
  const ROLE_OF: Record<MarkerId, ReferencePhotoRole> = { landmark: 'landmark', heading: 'headingMarker', check: 'check1' }
  /**
   * Where each marker's placing tap landed on the **canvas**, normalised.
   * `placeAt()` already computes this and used to discard it after the
   * hit-test; keeping it costs nothing and is what turns a photo of a wall
   * into a photo of a *spot* on that wall.
   */
  const tapPoints: Record<MarkerId, { x: number; y: number } | null> = { landmark: null, heading: null, check: null }
  /** The user's typed description per marker, e.g. "north door frame". */
  const labels: Record<MarkerId, string> = { landmark: '', heading: '', check: '' }
  /**
   * In-flight or settled photo capture per marker. A promise rather than a
   * value because capture is kicked off at the moment the marker is committed
   * and must not stall the stage transition — the flow reads it once, at
   * commit.
   */
  const photoTasks: Record<MarkerId, Promise<PendingReferencePhoto | null> | null> = { landmark: null, heading: null, check: null }
  /** Object URLs handed out for stored photos, revoked on teardown. */
  const objectUrls: string[] = []
  /** Which stored photo the panel is currently showing, so it reloads only on change. */
  let shownReferenceRole: ReferencePhotoRole | null = null
  /** Which marker the label input currently holds, so typing is not clobbered. */
  let labelFieldFor: MarkerId | null = null
  /**
   * True while a commit is awaiting its reference-photo capture. The commit
   * button stays mounted across that await and the 200 ms render poll keeps
   * running, so without this a second tap would commit the same frame twice —
   * the second one resolving an already-resolved promise and dropping a
   * duplicate anchor into the scene.
   *
   * Nothing that changes the points the commit holds is live while it is true: a tap on the canvas
   * (`placeAt`) and the check-point button, which adds or takes away a point, are inert. The buttons that
   * end the flow or begin it again (Re-place points, Continue uncalibrated) are not, and what the person
   * does with them stands (see `commitTwoPoint`).
   */
  let commitInFlight = false
  /**
   * True once the flow has ended, by a commit or by an exit. What was still under way (a commit awaiting its photos, a tap
   * awaiting its hit test) finishes into nothing: no marker is dropped and nothing is attached to the scene again.
   */
  let closed = false
  /** Where each photo's crosshair goes, when one is taken again, and what the commit says when one is missing (./reference-photo-flow.ts). */
  const photoFlow = createReferencePhotoFlow({
    capturePhoto: options.capturePhoto,
    view: () => options.canvas.getBoundingClientRect(),
    lens: () => lensOfProvider(options.provider),
    pose: () => options.provider.getPose(),
  })

  const overlay = document.createElement('section')
  overlay.id = 'project-calibration'
  overlay.innerHTML = `
    <div class="project-calibration-backdrop"></div>
      <div id="project-calibration-reference" class="project-calibration-reference" hidden>
        <div class="project-calibration-reference-head">
          <span id="project-calibration-reference-title">Last time</span>
          <span id="project-calibration-reference-label" class="project-calibration-reference-label" hidden></span>
        </div>
        <figure id="project-calibration-reference-figure" class="project-calibration-reference-figure" hidden>
          <img id="project-calibration-reference-img" alt="The camera view when this marker was placed, with a crosshair on the exact spot that was tapped" />
          <span id="project-calibration-reference-crosshair" class="project-calibration-crosshair" aria-hidden="true"></span>
        </figure>
        <p id="project-calibration-reference-note" class="project-calibration-reference-note" hidden></p>
      </div>
      ${returnVisitMarkup()}
    <div class="project-calibration-card" role="dialog" aria-modal="true" aria-labelledby="project-calibration-title">
      <div class="project-calibration-eyebrow">Project alignment</div>
      <ol id="project-calibration-steps" class="project-calibration-steps">
        <li data-step="ground">Ground</li>
        <li data-step="landmark">Landmark</li>
        <li data-step="heading">Heading</li>
        <li data-step="check">${CHECK_STEP_LABEL}</li>
      </ol>
      <h2 id="project-calibration-title">${isFirstCalibration ? 'Set this project&apos;s world frame' : 'Align this scan to the project'}</h2>
      <p id="project-calibration-copy">Tap a spot on the ground to mark this project&apos;s origin.</p>
      <div id="project-calibration-status" class="project-calibration-status" role="status">Waiting for AR tracking...</div>
      <div id="project-calibration-hold" class="project-calibration-hold" aria-hidden="true" hidden></div>
      <div id="project-calibration-tapnote" class="project-calibration-ground" data-state="warn" hidden></div>
      <div id="project-calibration-ground" class="project-calibration-ground" hidden></div>
      <div id="project-calibration-tracking" class="project-calibration-ground" hidden></div>
      <div id="project-calibration-separation" class="project-calibration-separation" hidden></div>
      <div id="project-calibration-fit" class="project-calibration-fit" role="status" hidden></div>
      <div id="project-calibration-chip" class="project-calibration-separation" hidden></div>
      <label id="project-calibration-label-field" class="project-calibration-label-field" hidden>
        <span id="project-calibration-label-caption">Name this feature</span>
        <input id="project-calibration-label-input" type="text" maxlength="60" autocomplete="off"
               placeholder="e.g. north door frame" />
      </label>
      <div class="project-calibration-actions">
        <button id="project-calibration-confirm" type="button" class="project-calibration-link project-calibration-link-promoted" hidden>Confirm landmark</button>
        <button id="project-calibration-commit" type="button" class="project-calibration-link project-calibration-link-promoted" hidden>Use this alignment</button>
        <button id="project-calibration-check" type="button" class="project-calibration-link" hidden></button>
        <button id="project-calibration-replace" type="button" class="project-calibration-link" hidden>Re-place points</button>
        <button id="project-calibration-adjust" type="button" class="project-calibration-link" hidden>${ADJUST_POINT_LABEL}</button>
        <button id="project-calibration-override" type="button" class="project-calibration-link" hidden>${REPLACE_REFERENCE_LABEL}</button>
        <button id="project-calibration-improve" type="button" class="project-calibration-link" hidden>${IMPROVE_REFERENCE_LABEL}</button>
        <button id="project-calibration-keep" type="button" class="project-calibration-link" hidden>${KEEP_REFERENCE_LABEL}</button>
        <button id="project-calibration-wrong-place" type="button" class="project-calibration-link" hidden>${WRONG_PLACE_LABEL}</button>
        <button id="project-calibration-skip-ground" type="button" class="project-calibration-link project-calibration-link-promoted" hidden>Place anchor without floor check</button>
        <button id="project-calibration-fallback" type="button" class="project-calibration-link" hidden>${ONE_POINT_LABEL}</button>
        <button id="project-calibration-skip" type="button" class="project-calibration-link">Continue uncalibrated</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const pick = <T extends HTMLElement>(id: string) => overlay.querySelector<T>(`#${id}`)!
  const steps = pick<HTMLElement>('project-calibration-steps')
  const title = pick<HTMLElement>('project-calibration-title')
  const copy = pick<HTMLElement>('project-calibration-copy')
  const status = pick<HTMLElement>('project-calibration-status')
  const hold = pick<HTMLElement>('project-calibration-hold')
  const tapNote = pick<HTMLElement>('project-calibration-tapnote')
  const groundReadout = pick<HTMLElement>('project-calibration-ground')
  const trackingReadout = pick<HTMLElement>('project-calibration-tracking')
  const separationEl = pick<HTMLElement>('project-calibration-separation')
  const fitEl = pick<HTMLElement>('project-calibration-fit')
  const confirmBtn = pick<HTMLButtonElement>('project-calibration-confirm')
  const commitBtn = pick<HTMLButtonElement>('project-calibration-commit')
  const checkBtn = pick<HTMLButtonElement>('project-calibration-check')
  const replaceBtn = pick<HTMLButtonElement>('project-calibration-replace')
  const adjustBtn = pick<HTMLButtonElement>('project-calibration-adjust')
  const overrideBtn = pick<HTMLButtonElement>('project-calibration-override')
  const wrongPlaceBtn = pick<HTMLButtonElement>('project-calibration-wrong-place')
  const skipGround = pick<HTMLButtonElement>('project-calibration-skip-ground')
  const fallbackBtn = pick<HTMLButtonElement>('project-calibration-fallback')
  const skip = pick<HTMLButtonElement>('project-calibration-skip')
  const improveBtn = pick<HTMLButtonElement>('project-calibration-improve')
  const keepBtn = pick<HTMLButtonElement>('project-calibration-keep')
  const referenceEl = pick<HTMLElement>('project-calibration-reference')
  const referenceTitle = pick<HTMLElement>('project-calibration-reference-title')
  const referenceLabel = pick<HTMLElement>('project-calibration-reference-label')
  const referenceFigure = pick<HTMLElement>('project-calibration-reference-figure')
  const referenceImg = pick<HTMLImageElement>('project-calibration-reference-img')
  const referenceCrosshair = pick<HTMLElement>('project-calibration-reference-crosshair')
  const referenceNote = pick<HTMLElement>('project-calibration-reference-note')
  const labelField = pick<HTMLElement>('project-calibration-label-field')
  const labelCaption = pick<HTMLElement>('project-calibration-label-caption')
  const labelInput = pick<HTMLInputElement>('project-calibration-label-input')

  // ── Scene decals ────────────────────────────────────────────────────────
  // Everything placed while the flow is running lives under `placement`, which
  // is torn down on every exit path. The committed origin marker is added to
  // the scene directly so it survives for the rest of the session, matching
  // what #141 already did.
  /**
   * The provider's Three.js scene, resolved **lazily**.
   *
   * It cannot be captured once at flow start. `provider.start()` is `async` but
   * returns as soon as it has called `XR8.run()`; 8th Wall only creates its
   * scene on the first frame, in the pipeline module's `onStart`. So
   * `getScene()` returns `null` for a few frames after start resolves — and
   * calibration opens inside that window.
   *
   * Capturing that `null` disabled **every** visual in the flow for the entire
   * session: no floor grid, so the readiness step gave the user nothing to
   * sweep toward; no marker decals; no baseline; no committed anchors. All of
   * it failed silently, because each draw site simply returned early. The
   * 200 ms render poll now re-asks until the scene exists, and attaches the
   * placement group the moment it does.
   */
  let scene: THREE.Scene | null = null
  let placementAttached = false
  const placement = new THREE.Group()
  placement.name = 'calibration placement'

  function ensureScene(): THREE.Scene | null {
    if (!scene) scene = options.provider.getScene?.() ?? null
    if (scene && !placementAttached) {
      scene.add(placement)
      placementAttached = true
    }
    return scene
  }
  const decals: Record<MarkerId, THREE.Group | null> = { landmark: null, heading: null, check: null }
  /** The stored points drawn where this visit puts them, while the markers are adjusted (./constellation-ghosts.ts). */
  const ghosts = createGhostLayer()
  let baseline: THREE.Line | null = null
  let floorGrid: THREE.GridHelper | null = null
  /** Last height the grid was drawn at, so it is only moved when it changes. */
  let floorGridY: number | null = null

  function detach(object: THREE.Object3D | null): void {
    if (!object) return
    placement.remove(object)
    disposeObject(object)
  }

  function clearPlacement(): void {
    MARKER_IDS.forEach((id) => {
      detach(decals[id])
      decals[id] = null
    })
    detach(baseline)
    baseline = null
    detach(floorGrid)
    floorGrid = null
    floorGridY = null
    ghosts.clear()
    if (scene && placementAttached) {
      scene.remove(placement)
      placementAttached = false
    }
    // Object URLs for stored photos are per-flow; nothing outside this modal
    // renders them, so holding them past teardown only leaks.
    objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url))
  }

  /**
   * What a return visit is shown beside the modal's own copy and reference panel: the ring at the stored distance, the
   * distance chip, and both stored photos while the pair is checked (./return-visit-aids.ts). The chip and the heading step
   * quote the spacing tolerance the commit applies, so the chip says pass exactly when the commit accepts, and the steps
   * count to the taps this visit asks for, as the progress dots do.
   */
  const aids = createReturnVisitAids({
    enabled: returnAidsEnabled(typeof location === 'undefined' ? '' : location.search),
    root: overlay,
    stored: storedTwoPoint,
    toleranceM: twoPointToleranceM(commitOptions.sigmaHatM),
    totalSteps: visitSteps,
    placement,
    ensureScene,
    loadReferencePhoto: options.loadReferencePhoto,
    shownPhoto: () => (referenceFigure.hidden ? null : shownReferenceRole),
  })

  function refreshSelectionVisuals(): void {
    for (const id of MARKER_IDS) {
      const decal = decals[id]
      if (!decal) continue
      const isSelected = selected === id
      decal.scale.setScalar(isSelected ? 1.25 : 1)
      decal.traverse((child) => {
        const material = (child as Partial<THREE.LineSegments>).material
        if (material && !Array.isArray(material)) material.opacity = isSelected ? 1 : 0.55
      })
    }
  }

  function refreshBaseline(): void {
    detach(baseline)
    baseline = null
    const a = points.landmark
    const b = points.heading
    if (!ensureScene() || !a || !b) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3))
    baseline = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x72ddd4, transparent: true, opacity: 0.7 }),
    )
    baseline.name = 'calibration baseline'
    placement.add(baseline)
  }

  /**
   * Draws the plane the app currently believes is the floor.
   *
   * This exists because that belief was previously invisible and could be
   * badly wrong — `estimateFloorY()` is an 8th-percentile of the point cloud,
   * and a capture was observed where it sat 0.84 m up while the real floor was
   * roughly two metres lower. The only symptom a user got was the floor gate
   * rejecting genuine floor taps as "cm above the floor", with no way to see
   * that the app's floor and the real floor had diverged. Now they can.
   *
   * Which height is shown deliberately changes with the stage:
   *  - before a landmark exists, the **estimate**, because that is what
   *    `isTapOnGround()` will judge the next tap against;
   *  - after one, the **landmark's own tap**, because that is the committed
   *    floor the frame is actually built on.
   *
   * Dimmed while the estimate is unsettled and solid once locked, so the
   * readiness gate reads as a visible state rather than an unexplained wait.
   */
  function refreshFloorGrid(): void {
    if (!ensureScene()) return
    const ground = options.ground()
    const landmark = points.landmark
    const height = landmark ? landmark.y : (ground ? ground.y : null)
    if (height === null) {
      detach(floorGrid)
      floorGrid = null
      floorGridY = null
      return
    }

    if (!floorGrid) {
      // THREE's own helper rather than hand-rolled geometry — same line-based
      // visual language as the anchor decals, no new mark to maintain.
      floorGrid = new THREE.GridHelper(FLOOR_GRID_SIZE_M, FLOOR_GRID_DIVISIONS, 0x72ddd4, 0x72ddd4)
      floorGrid.name = FLOOR_PLANE_NAME
      const material = floorGrid.material as THREE.Material
      material.transparent = true
      material.depthWrite = false
      placement.add(floorGrid)
    }

    const settled = landmark !== null || ground?.locked === true
    ;(floorGrid.material as THREE.Material).opacity = settled ? 0.4 : 0.15

    // Centre on the landmark once placed so the grid frames the frame's own
    // origin; before that leave it at the session origin, where the user is.
    const centreX = landmark ? landmark.x : 0
    const centreZ = landmark ? landmark.z : 0
    if (floorGridY !== height || floorGrid.position.x !== centreX || floorGrid.position.z !== centreZ) {
      floorGrid.position.set(centreX, height, centreZ)
      floorGridY = height
    }
  }

  function setMarker(id: MarkerId, position: Vec3): void {
    points[id] = position
    if (ensureScene()) {
      detach(decals[id])
      // `null` bearing renders the dimmed "not a committed frame yet" state the
      // shared decal already provides — no second geometry for in-progress points.
      const decal = buildAnchorMarker(null)
      decal.position.set(position.x, position.y, position.z)
      decals[id] = decal
      placement.add(decal)
    }
    refreshSelectionVisuals()
    refreshBaseline()
  }

  /**
   * Adds an object to the scene **directly**, so it outlives the flow.
   *
   * Everything under `placement` is torn down by `clearPlacement()` on every
   * exit path; anything added here is not. That difference is the whole reason
   * this helper is separate.
   *
   * An object already in the scene under the same name is replaced, not
   * stacked. Without that, a second commit in one session would draw a second
   * origin on the same spot, and the two would drift apart as soon as either
   * was re-placed.
   */
  function replacePersistent(object: THREE.Object3D): void {
    const target = ensureScene()
    if (!target) return
    const previous = target.getObjectByName(object.name)
    if (previous) {
      target.remove(previous)
      disposeObject(previous)
    }
    target.add(object)
  }

  /**
   * Keeps the floor grid for the rest of the scan, at the committed floor height `floorY`.
   *
   * The grid was the only drawing of the ground the flow made, and it lived in
   * `placement`, so `clearPlacement()` removed it the moment the origin was
   * committed. The origin was left floating with no floor under it, and the
   * ground plane the scan depends on disappeared with the flow. It is moved out
   * of `placement` here and dimmed: a reference to glance at, not a surface to
   * read. It is kept for the scan. It stays when the calibration that made it is
   * dropped with the scan still going, since it is the ground and not a claim about
   * the calibration, and it goes with a scan that has no calibration to be kept for:
   * a re-anchor, a skip (`withdrawCalibrationDrawings`, `floor`).
   *
   * `floorY` is the frame's floor DATUM, the height the commit took from the landmark
   * (`landmarkDatum()`, ./ground-gate.ts: the mean of the landmark's tap and the fitted
   * floor when they agree to 5 cm, else the tap). It is the `groundY` the record keeps and
   * the height the origin decal stands at, and it is not the height this grid was drawn at
   * while the points were placed, which is the landmark's own tap (`refreshFloorGrid`) and
   * can be up to 2.5 cm from it (ADR 0005, decision 2: project y = 0 is the room's floor, not
   * wherever the first tap landed). The grid is moved to the datum here so that the ground the
   * scan keeps and the origin on it are one height. On a visit that fitted three points the
   * matrix's own floor is the mean height of all three taps, which is the datum less the
   * landmark's height residual (`fit.perPoint[0].dy`, on the same record). The datum is the
   * landmark's height and does not claim to be that floor.
   */
  function keepFloorPlane(floorY: number): void {
    if (!floorGrid || !ensureScene()) return
    placement.remove(floorGrid)
    floorGrid.name = FLOOR_PLANE_NAME
    floorGrid.position.y = floorY
    ;(floorGrid.material as THREE.Material).opacity = SCAN_FLOOR_OPACITY
    replacePersistent(floorGrid)
    floorGrid = null
    floorGridY = null
  }

  /**
   * Draws the committed origin as **one** decal on the ground: a crosshair at
   * the landmark, an arrow along the heading, and the north tick.
   *
   * This replaces the two separate rings the flow used to leave behind, which
   * showed where each point was but not which way the frame faced. The heading
   * point is no longer a decal of its own. The arrow's tip lands on it, so the
   * arrow is the baseline the user defined and the point they placed stays
   * visible as the arrowhead, and the north tick is the one compass fix on the
   * decal, so the bearing reads once rather than twice.
   *
   * The tick takes the session yaw at which north lies, not the compass bearing,
   * because the decal lives in session space. See `northYawInSession()`.
   *
   * A check point is not on the arrow: it keeps a marker of its own, so the person can see where it went.
   *
   * `landmark.y` is the frame's floor datum (see `keepFloorPlane`): the decal stands on it, and so does the kept grid.
   * A later commit replaces everything an earlier one drew, so the earlier drawings go first
   * (`withdrawCalibrationDrawings`): a commit with no check point must not keep the marker of one, and a commit that is
   * not a return visit must not keep the stored origin and the ghost rings of one.
   *
   * Returns the arrow's compass bearing for the HUD (`originHeadingBearingDeg`, under the sign rule this flow runs
   * under), or null when there is no arrow or no compass fix.
   */
  function dropCommittedOrigin(landmark: Vec3, headingPoint: Vec3 | null, checkPoint: Vec3 | null = null): number | null {
    const plan = originDecalPlan(landmark, headingPoint, northYawInSession())
    const target = ensureScene()
    if (target) {
      withdrawCalibrationDrawings(target)
      keepFloorPlane(landmark.y)
      replacePersistent(buildOriginDecal(plan, 'committed'))
      // The check point (WP-04b) is not part of the origin: it keeps a marker of its own, so the person can see where it went.
      if (checkPoint) {
        const marker = buildAnchorMarker(null)
        marker.name = CHECK_MARKER_NAME
        marker.position.set(checkPoint.x, checkPoint.y, checkPoint.z)
        replacePersistent(marker)
      }
    }
    return originHeadingBearingDeg(plan, bearingConvention)
  }

  /**
   * Draws the Place's **stored** origin into the live scene — step 4 of ticket
   * 0007's return-visit flow, and the only moment at which it is possible.
   *
   * Stored points are project-space and tautological (`landmark` is the origin,
   * `headingMarker` is +Z at `separationM`), so rendering them needs a
   * session→project transform. That transform is what calibration produces, so
   * before this point the overlay would be circular — which is exactly why the
   * flow shows *photos* beforehand and geometry only afterwards.
   *
   * Here the transform exists, and where the stored pair lands depends on which
   * transform it is. It is the same place the ghost rings put the stored landmark
   * and heading point (./constellation-flow.ts, `ghostPlan`), so the two never
   * contradict each other:
   *
   *  - A pair compared by its distance is its own frame (`fit` null): the stored
   *    landmark maps to the landmark the user just placed, and the stored heading
   *    marker to `storedSeparationM` along the baseline they just defined.
   *  - Three points fitted to the stored ones (`fit`) are not: the fit's matrix is
   *    aligned on the mean position of the three taps, not on the landmark, so the
   *    stored landmark lands where the fit puts it, which is the landmark's own
   *    residual away from the landmark tapped, and the stored heading point on the
   *    fit's +Z axis at the stored distance. Reading it off the tapped pair, as the
   *    first case does, would draw the stored landmark twice, in two places.
   *
   * Either way any visible gap between this and the marker they placed is the
   * residual, shown at room scale instead of as a number. Both stand at the
   * landmark's height, the frame's floor datum (see `keepFloorPlane`).
   */
  function drawStoredPair(landmark: Vec3, headingMarker: Vec3, storedSeparationM: number, fit: FrameFit | null): void {
    if (!ensureScene()) return
    const inverse = fit ? invertAffine(fit.matrix) : null
    let origin: Vec3 = landmark
    let storedHeading: Vec3
    if (inverse) {
      // The stored origin and its +Z axis, carried back into this session through the fit.
      const placed = transformPoint(inverse, { x: 0, y: 0, z: 0 })
      const ahead = transformPoint(inverse, { x: 0, y: 0, z: storedSeparationM })
      origin = { x: placed.x, y: landmark.y, z: placed.z }
      storedHeading = { x: ahead.x, y: landmark.y, z: ahead.z }
    } else {
      const dx = headingMarker.x - landmark.x
      const dz = headingMarker.z - landmark.z
      const measured = Math.hypot(dx, dz)
      if (!Number.isFinite(measured) || measured <= 0) return
      // The stored heading point: the stored distance along the baseline the user
      // just defined. Any gap between it and the point they placed is the residual.
      storedHeading = {
        x: landmark.x + (dx / measured) * storedSeparationM,
        y: landmark.y,
        z: landmark.z + (dz / measured) * storedSeparationM,
      }
    }
    // No north tick on the stored decal. The committed origin carries the
    // frame's one compass fix, and a second tick would read as a second reading.
    replacePersistent(buildOriginDecal(originDecalPlan(origin, storedHeading, null), 'stored'))
  }

  // ── Geometry helpers ────────────────────────────────────────────────────

  /**
   * The compass bearing, clockwise from magnetic north, of the **session
   * frame's +Z axis** (ticket 0009).
   *
   * `options.bearing()` reports where the *device* is pointing.
   * `composeYUpTransform` — which both `anchorToProjectTransform` and the
   * server's GPS fallback build on — maps session +Z to the ENU direction at
   * the bearing it is handed, so it needs the frame's heading, not the phone's.
   * Passing the raw reading orients a scan by how the phone happened to be held
   * and, with the camera near its starting orientation, points it exactly
   * backwards.
   *
   * Sampled together with the pose deliberately: the two must describe the same
   * instant, or the correction removes a yaw the device no longer has.
   */
  function frameBearing(): number | null {
    return sessionFrameBearingDeg(options.bearing(), options.provider.getPose().rotation, bearingConvention)
  }

  /**
   * Where north lies in **session** coordinates, as a yaw — what
   * `buildAnchorMarker` needs, since the decals it makes live in the session
   * frame rather than in a north-aligned one. It is the frame's bearing itself,
   * not its negation: north is bearing 0, and a session direction at yaw `y`
   * has bearing `B_Z - y`, so north lies at yaw `B_Z`.
   */
  function northYawInSession(): number | null {
    return northYawInSessionDeg(frameBearing(), bearingConvention)
  }

  function separation(): number | null {
    const a = points.landmark
    const b = points.heading
    return a && b ? twoPointSeparationM(a, b) : null
  }

  function nearestMarker(position: Vec3): MarkerId | null {
    let best: MarkerId | null = null
    let bestDistance = ANCHOR_RADIUS_M
    for (const id of MARKER_IDS) {
      const point = points[id]
      if (!point) continue
      const distance = Math.hypot(position.x - point.x, position.z - point.z)
      if (distance <= bestDistance) {
        bestDistance = distance
        best = id
      }
    }
    return best
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  function show(el: HTMLElement, visible: boolean): void {
    el.hidden = !visible
  }

  /**
   * Writes a live region's text only when it changed. The card redraws five times a second, and a screen reader announces
   * a write to a `role="status"` element whether or not the words differ.
   */
  function setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text
  }

  function renderSteps(): void {
    // Which dot is active, done, to do, or (the check dot, on a visit that takes no check point) hidden: ./constellation-flow.ts.
    const states = stepStates(stage, checkPlan, points.check !== null)
    steps.querySelectorAll<HTMLElement>('li').forEach((li) => {
      const state = states[li.dataset.step as keyof typeof states]
      li.dataset.state = state
      li.hidden = state === 'hidden'
      li.ariaCurrent = state === 'active' ? 'step' : null
    })
  }

  /** The line for a check point once there is one: where it is, whether the fit can use it, and what the three points are worth. */
  function markerGuidance(): BaselineGuidance | null {
    const { landmark, heading, check } = points
    return landmark && heading && check
      ? checkPointGuidance(landmark, heading, check, commitOptions.sigmaHatM, comparedPoints(storedTwoPoint))
      : null
  }

  /** Whether the check marker is placed where the fit cannot use it: the commit is then not offered, and the line says why. */
  function checkBlocked(): boolean {
    const { landmark, heading, check } = points
    return !!landmark && !!heading && !!check && checkPointState(landmark, heading, check).problem !== null
  }

  function renderSeparation(): void {
    const sep = separation()
    if (sep === null) {
      show(separationEl, false)
      return
    }
    // The text and what it is worth live in baselineGuidance (and checkPointGuidance, once there is a check point). On a
    // return visit the stored pair's length goes in too: the estimate is for the stored pair, the line names the pair to
    // match, and it does not advise a longer walk, which the commit would turn away as a mismatch.
    const guidance = markerGuidance()
      ?? baselineGuidance(sep, storedTwoPoint?.separationM, commitOptions.sigmaHatM, stage === 'check' ? comparedPoints(storedTwoPoint) : null)
    separationEl.dataset.state = guidance.state
    separationEl.textContent = guidance.text
    show(separationEl, true)
  }

  /** The marker this stage is asking the user to place, if any. */
  function activeMarker(): MarkerId | null {
    return stage === 'landmark' ? 'landmark' : stage === 'heading' ? 'heading' : stage === 'check' ? 'check' : null
  }

  /**
   * Which marker the label field is naming.
   *
   * Not the same as {@link activeMarker}, and the difference is not cosmetic:
   * placing the heading marker advances at once (to the check-point step, or
   * to `'review'`), so a field bound to the placement stage alone is a field
   * that names point B only before it is placed — the frame would be
   * committable with half its `pointLabels`. Review therefore names the
   * marker that was placed last by default (the check point when there is one,
   * else the heading marker), so that what is typed after tapping a point names
   * the point just tapped, and whichever marker is selected when one is.
   *
   * The check step names nothing until its marker is down, and then it is review:
   * a field there would either name a point that does not exist yet, or name the
   * heading marker beside a card that is asking for the check point. What is
   * typed for a marker is kept, so a name typed at the heading step is still there.
   */
  function labelTarget(): MarkerId | null {
    if (stage === 'check') return null
    const active = activeMarker()
    if (active) return active
    if (stage === 'review') return selected ?? (points.check ? 'check' : 'heading')
    return null
  }

  function storedPhotoFor(id: MarkerId): CalibrationReferencePhoto | null {
    if (id === 'check') return storedTwoPoint?.checkPoints?.[0]?.photo ?? null
    const photos = storedTwoPoint?.referencePhotos
    if (!photos) return null
    return id === 'landmark' ? photos.landmark : photos.headingMarker
  }

  function storedLabelFor(id: MarkerId): string {
    if (id === 'check') return storedTwoPoint?.checkPoints?.[0]?.label ?? ''
    const pair = storedTwoPoint?.pointLabels
    if (!pair) return ''
    return (id === 'landmark' ? pair[0] : pair[1]) ?? ''
  }

  function positionCrosshair(tapPoint: { x: number; y: number }): void {
    const { left, top } = referenceCrosshairPixels(tapPoint, {
      width: referenceImg.clientWidth,
      height: referenceImg.clientHeight,
    })
    referenceCrosshair.style.left = `${left}px`
    referenceCrosshair.style.top = `${top}px`
  }

  /**
   * Shows the stored reference photo for whichever marker is being placed.
   *
   * Deliberately **before** placement rather than as an AR overlay: a photo
   * needs no transform to be recognisable, which is the one property that lets
   * it help at the only moment help is possible. See ticket 0007, "Why a photo
   * and not the stored points themselves".
   *
   * Every failure mode says what happened. An empty panel would read as "there
   * is nothing to match", which on a Place whose photo merely failed to upload
   * is a lie that costs the user the re-acquisition they came for.
   */
  function renderReference(): void {
    const active = activeMarker()
    if (!active || !storedTwoPoint) {
      show(referenceEl, false)
      shownReferenceRole = null
      return
    }
    show(referenceEl, true)
    const role = ROLE_OF[active]
    referenceTitle.textContent = `Last time — ${referencePhotoTitle(role)}`

    const storedLabel = storedLabelFor(active)
    referenceLabel.textContent = storedLabel ? `“${storedLabel}”` : ''
    show(referenceLabel, !!storedLabel)

    if (role === shownReferenceRole) {
      // Already loaded; only the crosshair needs to track layout changes.
      const photo = storedPhotoFor(active)
      if (photo && !referenceFigure.hidden) positionCrosshair(photo.tapPoint)
      return
    }
    shownReferenceRole = role

    const photo = storedPhotoFor(active)
    show(referenceFigure, false)
    if (!photo) {
      referenceNote.textContent = noPhotoNote(active, !!storedLabel)
      show(referenceNote, true)
      return
    }

    referenceNote.textContent = 'Loading the saved photo…'
    show(referenceNote, true)
    const load = options.loadReferencePhoto
    if (!load) {
      referenceNote.textContent = 'Saved photo not available this session.'
      return
    }
    void load(photo)
      .catch(() => null)
      .then((src) => {
        // The stage can move on while a photo is loading; dropping a late
        // result is correct, showing point A's photo during stage B is not.
        if (shownReferenceRole !== role) return
        if (!src) {
          referenceNote.textContent = photo.url === null
            ? 'This point’s photo never finished uploading, so it is not on this device. Place it from memory.'
            : 'The saved photo could not be loaded. Place this marker from memory.'
          return
        }
        // Blob URLs are ours to release; a data URL or a plain path is not.
        if (src.startsWith('blob:')) objectUrls.push(src)
        referenceImg.onload = () => positionCrosshair(photo.tapPoint)
        referenceImg.src = src
        show(referenceFigure, true)
        show(referenceNote, false)
        positionCrosshair(photo.tapPoint)
      })
  }

  /**
   * The `pointLabels` field (ticket 0002's schema, populated for the first
   * time by 0007).
   *
   * A typed description is the cheap half of the mitigation and the half that
   * survives an ambiguous photo: two stretches of skirting board look alike,
   * "north door frame" and "radiator corner" do not. It matters most for the
   * reversed-pair failure — the one that rotates the frame 180° and still
   * reports `'verified'` — because a label is the only artefact that says
   * which of the two points this one was meant to be.
   */
  function renderLabelField(): void {
    const active = labelTarget()
    show(labelField, active !== null)
    if (!active) {
      labelFieldFor = null
      return
    }
    labelCaption.textContent = labelCaptionFor(active)
    if (labelFieldFor !== active) {
      labelFieldFor = active
      // Prefill from the stored label so a re-set frame keeps a description
      // the user already wrote, rather than silently dropping it.
      if (!labels[active]) labels[active] = storedLabelFor(active)
      labelInput.value = labels[active]
    }
  }

  /**
   * The floor fit's own numbers, on screen.
   *
   * The estimate is a statistic over SLAM feature points, not a detected
   * surface, and it can be confidently wrong — `estimateFloorY()` was observed
   * ~0.8 m out before ticket 0008 and the fit that replaced it has a support
   * threshold of its own that a sparse floor can fail. When it is wrong the
   * only person who can tell is the one standing in the room, and until now
   * they had nothing to compare against: the grid rendered at *some* height
   * with no indication of how well the data backed it.
   *
   * `inliers` is how many points actually support the chosen band — a floor
   * with very few is a floor the fit barely saw. `±` is the RMS spread of
   * those points, which reads near hit-test noise for a level floor and much
   * wider for a tilted one. `no supported band` means no band cleared
   * `FLOOR_MIN_BAND_SHARE` at all and the legacy percentile was used.
   */
  function renderGroundReadout(): void {
    const estimate = options.ground()
    if (!estimate) {
      groundReadout.textContent = 'Floor: no estimate yet (under 50 points)'
      show(groundReadout, stage === 'ground')
      return
    }
    const parts = [`Floor ${estimate.y.toFixed(2)} m`]
    if (estimate.fallback) parts.push('no supported band — percentile fallback')
    else {
      if (estimate.inlierCount !== undefined) parts.push(`${estimate.inlierCount} inliers`)
      if (estimate.residualM !== undefined) parts.push(`±${(estimate.residualM * 100).toFixed(1)} cm`)
    }
    if (estimate.sampleCount !== undefined) parts.push(`of ${estimate.sampleCount} pts`)
    parts.push(estimate.locked ? 'locked' : 'settling')
    groundReadout.textContent = parts.join(' · ')
    // Kept visible past the ground stage: the landmark tap is judged against
    // this number, so it stays on screen while there is still a tap to judge.
    show(groundReadout, stage === 'ground' || stage === 'landmark' || stage === 'heading')
  }

  /**
   * Tracking health, and how many times the world frame has moved under us.
   *
   * Both markers and the floor grid are positioned once and never touched
   * again by this module, so if they visibly move, the *session frame* moved —
   * SLAM redefining its origin on recovery or loop closure. That is otherwise
   * undetectable from inside the app: the pose keeps updating and the status
   * can read NORMAL throughout, while every world-locked object shifts
   * together and the accumulated point cloud silently becomes a mixture of two
   * different coordinate frames.
   *
   * Shown during placement because it is the number that says whether anything
   * placed can be trusted.
   */
  function renderTrackingReadout(): void {
    const diagnostics = options.provider.getTrackingDiagnostics?.()
    if (!diagnostics) {
      show(trackingReadout, false)
      return
    }
    // What it says, and how sure, is decided in src/ar/frame-epoch.ts (describeTracking).
    const { text, warn } = describeTracking(diagnostics)
    trackingReadout.textContent = text
    trackingReadout.dataset['state'] = warn ? 'warn' : 'ok'
    show(trackingReadout, stage !== 'review' && stage !== 'mismatch')
  }

  /**
   * Whether the one-point tier is on offer now. The button is shown by it on every redraw, and a click on
   * the button is accepted by it, so the rule is enforced where the commit starts and not only where it
   * is painted. A stored frame whose method is missing or unknown is not a Place with no frame (one-point-offer.ts).
   */
  function onePointOfferNow(): boolean {
    // An upgrade replaces the reference, and a one-point scan would replace it with a weaker one (WP-08).
    if (isUpgrade(options.generation)) return false
    return onePointOffered({
      stage,
      hasLandmark: !!points.landmark,
      storedMethod: existingFrame ? existingFrame.method : null,
    })
  }

  /**
   * The parts of the card that exist for a check point (./constellation-flow.ts): the readout of how the markers sit against the
   * stored ones, the stored points drawn beside them, and the one check-point button. Redrawn with the rest, from the markers, so a
   * point that is moved is a comparison that is redone.
   */
  function renderConstellation(): void {
    const { landmark, heading, check } = points
    const adjusting = stage === 'review' || stage === 'mismatch'
    const preview = adjusting && landmark && heading && check
      ? previewVisit({
        tapped: { landmark, headingMarker: tappedAt.heading ?? heading, checkPoint: tappedAt.check ?? check },
        drawn: { landmark, headingMarker: heading, checkPoint: check },
        stored: storedTwoPoint,
        sigmaHatM: commitOptions.sigmaHatM,
        unitsMode: options.provider.scaleKind?.(),
      })
      : null
    livePreview = preview
    ghosts.sync(preview && ensureScene() ? placement : null, preview?.ghosts ?? null)
    const shown = stage === 'mismatch' ? mismatchComparison : preview?.comparison ?? null
    const readout = !shown
      ? null
      : shown.checkedBy === 'constellation'
        ? fitReadout(shown.verdict, shown.fit)
        : shown.uncompared
          ? uncomparedReadout(shown.uncompared)
          : null
    setText(fitEl, readout?.text ?? '')
    fitEl.dataset.state = readout?.state ?? 'ok'
    show(fitEl, readout !== null)
    // Beside a readout of how the points compare, the placement guidance (where C is, what the shape is worth) is advice for
    // choosing points and these are chosen; it goes, so the card keeps the camera view. A line that says the points are unusable stays.
    if (readout !== null && separationEl.dataset['state'] !== 'short') show(separationEl, false)
    const action = checkAction({ stage, plan: checkPlan, hasCheck: check !== null, pairUsable: (separation() ?? 0) >= MIN_POINT_SEPARATION_M })
    show(checkBtn, action !== null)
    // The commit that waits for its photos holds the points as they were when Commit was pressed: this button changes them.
    checkBtn.disabled = commitInFlight
    if (action) checkBtn.textContent = action.label
    show(adjustBtn, stage === 'mismatch')
  }

  function renderStage(): void {
    if (closed) return
    renderSteps()
    renderGroundReadout()
    renderTrackingReadout()
    renderSeparation()
    renderReference()
    renderLabelField()
    renderConstellation()
    refreshFloorGrid()
    const sep = separation()
    const farEnough = sep !== null && sep >= MIN_POINT_SEPARATION_M
    aids.render({ stage, landmark: points.landmark, separationM: sep, comparedByFit: livePreview?.comparison.checkedBy === 'constellation' })

    show(confirmBtn, stage === 'landmark' && !!points.landmark)
    show(commitBtn, stage === 'review')
    show(replaceBtn, stage === 'review' || stage === 'mismatch')
    show(overrideBtn, stage === 'mismatch')
    // One button for the whole flow, so its words follow the floor check on every draw, in both directions: a tap that was off the floor
    // and is moved onto it, or Re-place points, gives the replacement back.
    const keepLabel = keepingPairReplacesReference() ? REPLACE_REFERENCE_LABEL : RECORD_UNVERIFIED_LABEL
    if (overrideBtn.textContent !== keepLabel) overrideBtn.textContent = keepLabel
    show(wrongPlaceBtn, stage === 'mismatch' && !!options.onWrongPlace)
    show(
      skipGround,
      stage === 'ground'
        && !groundWaitOverridden
        && !options.ground()?.locked
        && trackingEverEstablished
        && Date.now() - groundWaitStartedAt > GROUND_WAIT_TIMEOUT_MS,
    )
    show(improveBtn, improveShown(options.generation, { stage, hasLandmark: !!points.landmark, stored: existingFrame }))
    show(keepBtn, keepShown(options.generation))
    // Not offered on a Place that has a two-point frame: a one-point scan would sit in another frame (one-point-offer.ts).
    show(fallbackBtn, onePointOfferNow())
    commitBtn.disabled = !farEnough || checkBlocked()

    let defaultStatus = ''
    if (stage === 'ground') {
      // Without this the ground stage inherited the landmark stage's copy and
      // told the user to tap the ground before tapping was possible.
      title.textContent = isFirstCalibration ? "Set this project's world frame" : 'Align this scan to the project'
      copy.textContent = 'Sweep the floor slowly. The grid settles onto the real floor, then placement unlocks.'
    } else if (stage === 'landmark') {
      title.textContent = isFirstCalibration ? "Set this project's world frame" : 'Align this scan to the project'
      copy.textContent = aids.landmarkCopy() ?? landmarkStepCopy(visitSteps)
      defaultStatus = points.landmark
        ? 'Landmark placed. Tap it to move it, or confirm to place the heading marker.'
        : 'Tap the ground to place the landmark.'
    } else if (stage === 'heading') {
      title.textContent = 'Place the heading marker'
      copy.textContent = aids.headingCopy() ?? headingStepCopy(storedTwoPoint?.separationM, visitSteps)
      defaultStatus = 'Tap the ground to place the heading marker.'
    } else if (stage === 'check') {
      const card = checkStageCard(checkPlan.stored, visitSteps)
      title.textContent = card.title
      copy.textContent = card.copy
      defaultStatus = card.status
    } else if (stage === 'review') {
      title.textContent = 'Check the alignment'
      copy.textContent = reviewCopy(points.check !== null)
      defaultStatus = !farEnough
        ? 'The markers are too close together to fix a reliable heading.'
        : checkBlocked()
          ? CHECK_BLOCKED_STATUS
          : livePreview?.comparison.verdict.status === 'mismatch'
            ? REVIEW_MISMATCH_STATUS
            : 'Ready to commit.'
    } else if (stage === 'mismatch') {
      // Three points compared by a fit say what they found in the readout under the card; a pair has one sentence, as it always did.
      const ofPoints = mismatchComparison?.checkedBy === 'constellation'
      title.textContent = ofPoints ? MISMATCH_TITLE_POINTS : 'These markers do not match the stored pair'
      copy.textContent = ofPoints ? MISMATCH_COPY_POINTS : mismatchCopy(mismatchResidualM)
      defaultStatus = 'Not committed yet.'
    }
    // The ground stage's copy is owned by update(), which computes it from the
    // tracking/floor timers and writes it before calling here — so this must
    // not clobber it with an empty default. Placement stages are owned here.
    if (stage !== 'ground') setText(status, transientStatus ?? aids.statusLine(defaultStatus))
  }

  const update = () => {
    if (stage !== 'ground') {
      renderStage()
      return
    }

    if (!options.provider.isTracking()) {
      const stalled = !trackingEverEstablished && Date.now() - trackingWaitStartedAt > TRACKING_TIMEOUT_MS
      setText(status, stalled
        ? "Still not tracking — check the camera isn't covered, or Continue uncalibrated."
        : 'Waiting for stable AR tracking. Slowly look around the floor.')
      skip.classList.toggle('project-calibration-link-promoted', stalled)
      renderStage()
      return
    }
    if (!trackingEverEstablished) {
      trackingEverEstablished = true
      // Start the floor clock here, not at modal open: time spent waiting for
      // tracking is not time spent failing to map the floor.
      groundWaitStartedAt = Date.now()
    }

    // Environment-scan step (ticket 0003): tracking being alive is not the same
    // as the floor being mapped, and the ground plane is the reference both
    // markers get projected onto — so it must exist before either is placed.
    if (!groundWaitOverridden && !options.ground()?.locked) {
      const waited = Date.now() - groundWaitStartedAt > GROUND_WAIT_TIMEOUT_MS
      setText(status, waited
        ? 'Still mapping the floor. Keep sweeping, or place the anchor without the floor check.'
        : 'Scanning the environment. Point the device at the floor and move slowly.')
      skip.classList.remove('project-calibration-link-promoted')
      renderStage()
      return
    }

    skip.classList.remove('project-calibration-link-promoted')
    stage = 'landmark'
    transientStatus = null
    renderStage()
  }

  return new Promise((resolve) => {
    const interval = setInterval(update, 200)
    const close = (result: CalibrationResult | null) => {
      closed = true
      clearInterval(interval)
      options.canvas.removeEventListener('touchstart', onTouchStart)
      options.canvas.removeEventListener('pointerdown', onPointerDown)
      aids.dispose()
      clearPlacement()
      overlay.remove()
      resolve(result)
    }

    /**
     * Grabs the camera frame for one marker, at the moment the person is
     * looking at it: Confirm for the landmark, and the tap itself for the
     * heading marker and the check point.
     *
     * **Not at Commit for those two**, as it was before the check point
     * existed. Between the heading marker's tap and Commit the person now walks
     * to the check point and turns to it, so a frame taken at Commit shows
     * another view, and the crosshair (where the marker was tapped on the screen)
     * points at nothing. A tap lands on the live view, so the frame taken with
     * it shows the spot tapped. A marker placed again takes its photo again,
     * because `applyTap` drops the one it had.
     *
     * Deliberately not awaited by its callers. `captureFrame()` waits for the
     * next camera frame and can take a beat, and the flow must not stall on it
     * — the photo is an aid, never a gate. The result is read once, at commit.
     *
     * Where the crosshair goes, and what a photo that does not show the marker
     * comes to, are ./reference-photo-flow.ts. The marker's own position goes
     * in, and not only the tap: the phone has usually moved by the time the
     * frame arrives. Asking again for a marker whose photo is good keeps it.
     */
    function beginPhotoCapture(id: MarkerId): void {
      photoTasks[id] = photoFlow.begin(ROLE_OF[id], points[id], tapPoints[id], photoTasks[id])
    }

    /**
     * Collects the photo of each marker, stamping each with the label as typed
     * at commit time rather than at capture time — the user is free to name a
     * feature after confirming it. A marker whose task came to nothing is
     * photographed again here, and `photoFlow.holdText()` says what is still
     * missing.
     */
    async function collectPhotos(): Promise<PendingReferencePhoto[]> {
      const collected: PendingReferencePhoto[] = []
      for (const id of MARKER_IDS) {
        const photo = await photoFlow.settle({ role: ROLE_OF[id], task: photoTasks[id], marker: points[id], tap: tapPoints[id] })
        if (photo) collected.push({ ...photo, label: labels[id].trim() || null })
      }
      return collected
    }

    /** `pointLabels` for the stored frame, or undefined when neither was named. */
    function committedLabels(): [string, string] | undefined {
      const a = labels.landmark.trim()
      const b = labels.heading.trim()
      return a || b ? [a, b] : undefined
    }

    /**
     * The frame the landmark was placed in has moved, or the landmark has waited too long since it was confirmed (./calibration-taps.ts):
     * sends the person back to the landmark and says why. It is "Re-place points" pressed for them, so what that
     * clears (the markers, their photos, and the floor check a tap of theirs bypassed) stays defined in one place. The stored
     * reference photos show again for the landmark, as they do on any return to that stage.
     */
    function restartAfterDisturbance(): void {
      replaceBtn.click()
      transientStatus = taps.disturbedText()
      renderStage()
    }

    /**
     * A point is fixed in the map at the confirmation and at the commit, and only a map that is steady can hold one: while it
     * is not, the press is turned away and says why, and the person presses again when it is (./calibration-taps.ts).
     */
    function mapIsSteady(): boolean {
      if (taps.stable()) return true
      transientStatus = taps.unstableText
      renderStage()
      return false
    }

    /**
     * Commits the two-point frame. `override` records the pair despite a
     * separation mismatch, which costs the 'verified' status by definition.
     *
     * What the pair comes to, and the records built for it, are
     * ./calibration-commit.ts. This is the shell around that: the stage, the
     * photos, the markers in the scene, and the moment the compass is read.
     */
    async function commitTwoPoint(override: boolean): Promise<void> {
      if (commitInFlight || !mapIsSteady()) return
      // The landmark marker as it is when the button is pressed: what the photo wait is checked against afterwards.
      const pressedLandmark = points.landmark
      // The landmark as the frame is built from it: at the floor height its own tap gave, with how that tap was measured.
      const { landmark, tap } = taps.frameLandmark(points.landmark)
      const headingMarker = points.heading
      if (!landmark || !headingMarker) return
      const separationM = twoPointSeparationM(landmark, headingMarker)
      // The button is disabled under the minimum; this is the guard a script's click meets. The verdict below
      // refuses the same pair for a caller that does not come through here.
      if (separationM < MIN_POINT_SEPARATION_M) {
        renderStage()
        return
      }

      // Whether the points this commit holds bypassed a floor check, read once: the verdict and the record say the same thing.
      const bypassed = floorCheckBypassed()
      // The points as they were tapped (their own heights, which a fit compares), and the units the phone says it is in.
      const verdict = assessTwoPoint(
        {
          landmark,
          headingMarker: tappedAt.heading ?? headingMarker,
          checkPoint: tappedAt.check ?? points.check,
          stored: storedTwoPoint,
          override,
          unitsMode: options.provider.scaleKind?.(),
          floorCheckBypassed: bypassed,
        },
        commitOptions,
      )
      if (verdict.kind === 'mismatch') {
        mismatchResidualM = verdict.residualM
        mismatchComparison = verdict.comparison
        stage = 'mismatch'
        renderStage()
        return
      }
      // Turned away by the verdict: the session moved under the points, or the landmark waited too long (isDisturbed:
      // back to the landmark, with the reason), or the pair is under the minimum (which the guard above has already
      // caught: the card is redrawn as it was), or the check point cannot serve as a reference, and the card says why.
      if (verdict.kind === 'refused') {
        if (verdict.reason === 'disturbed') restartAfterDisturbance()
        else if (verdict.reason === 'check-point') transientStatus = verdict.text
        renderStage()
        return
      }


      // Only a changed frame keeps photos, so only a changed frame is worth a
      // capture. This sits after the mismatch check on purpose: a pair that is
      // about to be sent back for re-placement should not cost a frame. A visit
      // that writes the frame whatever happens took the markers' photos at their
      // taps (`applyTap`); a visit to a stored pair takes them here, for the
      // markers that have none, when "Use anyway" keeps its points.
      let referencePhotos: PendingReferencePhoto[] = []
      if (verdict.frameChanged) {
        const pressedIn = stage
        commitInFlight = true
        for (const id of ['heading', 'check'] as const) if (!photoTasks[id]) beginPhotoCapture(id)
        transientStatus = 'Saving reference photos…'
        renderStage()
        try {
          referencePhotos = await collectPhotos()
        } finally {
          commitInFlight = false
        }
        // The wait lasts as long as the camera takes to answer. The modal can be closed in it, or the points cleared (nothing
        // is left to commit), and the map can shift in it (back to the landmark): the clock is not asked, the press was in time.
        // The person may have pressed Re-place points, or Continue uncalibrated, while the photos were awaited. What they did
        // stands, and the pair they pressed this for is not the pair on the card now, or the flow has ended.
        if (closed || stage !== pressedIn || points.landmark !== pressedLandmark || points.heading !== headingMarker) return
        if (taps.shifted()) return restartAfterDisturbance()
        // A point has no photo that shows it: say which, once, and the press after that saves without (./reference-photo-flow.ts).
        // The sentence names the button that was pressed, which is not "Use this alignment" on the mismatch screen.
        const hold = photoFlow.holdText((override ? overrideBtn : commitBtn).textContent)
        if (hold) {
          transientStatus = hold
          renderStage()
          return
        }
      }

      // The compass and the clock are read here, after the photos, and handed in:
      // what is recorded is what they said when the commit completed.
      const { calibration, spatialFrame } = buildTwoPointCommit(verdict, {
        landmark,
        headingMarker,
        frameBearingDeg: frameBearing(),
        bearingConvention,
        pointLabels: committedLabels(),
        checkPointLabel: labels.check,
        calibratedAt: new Date().toISOString(),
        tap,
        floorCheckBypassed: bypassed,
      })

      // One origin decal: the crosshair on the landmark, the arrow to the heading
      // point, and the north tick. The heading point stays visible as the arrowhead.
      const originBearingDeg = dropCommittedOrigin(landmark, headingMarker, points.check)

      // Step 4 of the return-visit flow. Reachable only here, because only a
      // committed frame makes the stored points renderable at all.
      if (storedTwoPoint && !override && verdict.comparison) {
        const into = ensureScene()
        if (into) {
          drawStoredConstellation(into, ghostPlan({
            drawn: { landmark, headingMarker, checkPoint: points.check },
            stored: storedTwoPoint,
            comparison: verdict.comparison,
          }))
        }
        // The stored origin, drawn like the committed one and beside it: the gap between the two decals is the residual,
        // shown at room scale (wave 12). It is carried through the same transform as the rings above, so its gap at the origin
        // and at the arrowhead are those two points' residuals; the rings carry the stored points one by one, with theirs.
        drawStoredPair(landmark, headingMarker, storedTwoPoint.separationM, verdict.comparison.fit)
      }

      close({
        calibration,
        spatialFrame,
        ...(verdict.frameChanged ? { referencePhotos } : {}),
        ...(originBearingDeg !== null ? { originBearingDeg } : {}),
        ...epochField,
      })
    }

    /** #141's single-tap tier, kept for rooms where a second point is impractical. */
    function commitSinglePoint(): void {
      const landmark = points.landmark
      if (!landmark || !mapIsSteady()) return
      const outcome = buildOnePointCommit(
        {
          landmark,
          // Load-bearing on this tier — it *is* the frame's heading — so the
          // correction in frameBearing() matters far more here than on the
          // two-point tier.
          frameBearingDeg: frameBearing(),
          bearingConvention,
          existingFrame,
          calibratedAt: new Date().toISOString(),
          floorCheckBypassed: floorCheckBypassed(),
        },
        onePointOptions,
      )
      if (outcome.kind === 'refused') {
        if (outcome.text) transientStatus = outcome.text
        else if (outcome.reason === 'disturbed') restartAfterDisturbance()
        renderStage()
        return
      }
      // No reference photos on this tier (ticket 0007's non-goals): it has no
      // cross-session verification story, and a re-acquisition aid would imply
      // one. There is also no second marker to draw.
      dropCommittedOrigin(landmark, null)
      close({ calibration: outcome.calibration, spatialFrame: outcome.spatialFrame, ...epochField })
    }

    /**
     * Routes a raw floor hit to whichever marker it belongs to, and decides its
     * height.
     *
     * **The landmark's own measured `y` is the frame's floor.** Ticket 0004
     * originally specified snapping both markers to `groundEstimate().y`, and
     * following that literally made the estimator a single point of failure for
     * every scan's vertical placement: `estimateFloorY()` is an 8th-percentile
     * of the point cloud's Y values, not a plane fit, and on a real capture it
     * returned +0.84 m while the lowest detected object sat at -0.05 m. Since
     * project y = session y - landmark.y, that put the whole scan 0.89 m below
     * the floor.
     *
     * Using the tapped point instead satisfies the ticket's actual intent
     * ("project-space y = 0 is the floor") more robustly, because the floor
     * gate already ensures the landmark tap is on the floor — and it keeps the
     * baseline horizontal, which is the property the frame math depends on,
     * by snapping the heading marker to the landmark's height rather than to a
     * statistic. The estimator keeps its proper job: sanity-checking taps in
     * `isTapOnGround()`, where being roughly right is enough.
     */
    function applyTap(position: Vec3, tapPoint: { x: number; y: number }, acceptedOffFloor: boolean): void {
      // Select-then-retap, per ticket 0004: a selected marker moves to the next
      // tap wherever it lands; otherwise a tap within ANCHOR_RADIUS_M of an
      // existing marker selects it rather than placing something new.
      let target: MarkerId
      if (selected) {
        target = selected
      } else {
        const near = nearestMarker(position)
        if (near) {
          selected = near
          refreshSelectionVisuals()
          transientStatus = `${markerName(near)} selected — tap where it should go.`
          return
        }
        if (stage === 'landmark') target = 'landmark'
        else if (stage === 'heading') target = 'heading'
        else if (stage === 'check') target = 'check'
        else {
          transientStatus = 'Tap a marker to select it, then tap where it should go.'
          return
        }
      }

      // Where this tap landed on screen, kept for the marker it is placing.
      // Re-placing invalidates any photo already taken for that marker: a photo
      // of the *previous* spot, crosshaired at the previous tap, is worse than
      // no photo — it would send the next visit to the wrong feature. A landmark
      // that was already confirmed is photographed again below.
      tapPoints[target] = tapPoint
      photoTasks[target] = null
      // The height it was tapped at, before it is drawn at the landmark's: a fit compares heights (./constellation-flow.ts).
      tappedAt[target] = position
      // And whether that tap was accepted off the floor, which is a bypass of the floor check for as long as this tap is the marker's.
      if (acceptedOffFloor) offFloorMarkers[target] = true
      else delete offFloorMarkers[target]

      if (target === 'landmark') {
        setMarker('landmark', position)
        // In the landmark stage the map is watched from the tap, so a shift before the confirmation is seen at it.
        if (stage === 'landmark') taps.landmarkPlaced()
        // Re-placing the landmark redefines the floor, so the markers that follow
        // it do too. Leaving them at the old height would tilt the baseline.
        for (const id of ['heading', 'check'] as const) {
          const marker = points[id]
          if (marker) setMarker(id, { x: marker.x, y: position.y, z: marker.z })
        }
      } else {
        // The heading marker and the check point, drawn at the landmark's height.
        const floorY = points.landmark ? points.landmark.y : position.y
        // What the hits measured of each, which is not the height a tap was put at where the floor ray placed it.
        const disagreement = taps.heightAboveLandmarkM(points.landmark, position)
        setMarker(target, { x: position.x, y: floorY, z: position.z })
        // A visit that writes the Place's frame whatever happens photographs the marker now, while the person is looking at
        // the spot they just tapped; a visit to a stored pair photographs only if it keeps its points (see the commit). A pair
        // under the minimum is about to be re-placed and costs no frame: the marker moved takes its own, and the commit takes
        // the photo of one that has none.
        if (!storedTwoPoint && (separation() ?? 0) >= MIN_POINT_SEPARATION_M) beginPhotoCapture(target)
        // A usable heading marker opens the check-point step when this visit takes one by default; otherwise, and once the
        // check point is placed, the person is in review. A pair under the minimum stays in review to be fixed (./constellation-flow.ts).
        // A heading marker moved during the check step is still the step's business: the person has not placed the check point yet.
        if (stage === 'heading') stage = checkPlan.automatic && (separation() ?? 0) >= MIN_POINT_SEPARATION_M ? 'check' : 'review'
        else if (stage === 'check' && (target === 'check' || (separation() ?? 0) < MIN_POINT_SEPARATION_M)) stage = 'review'
        if (Math.abs(disagreement) > MARKER_HEIGHT_DISAGREEMENT_M) {
          const cm = Math.abs(Math.round(disagreement * 100))
          transientStatus =
            `That point measured ${cm} cm ${disagreement > 0 ? 'above' : 'below'} the landmark — one of the two is probably not on the floor.`
        }
      }
      // The landmark was photographed where it was at Confirm, so a move after that needs a new photo, taken now, while
      // the person has just tapped it on the screen. Nothing took one, and the frame was saved with none (./reference-photo-flow.ts).
      if (target === 'landmark' && stage !== 'landmark') beginPhotoCapture('landmark')

      if (selected) {
        selected = null
        refreshSelectionVisuals()
      }
    }

    const placeAt = (x: number, y: number) => {
      // A zero-size canvas (rect.width/height === 0, e.g. mid-layout) turns
      // the caller's division into NaN, which every comparison below would
      // silently let through as "in range" — reject non-finite values first.
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return
      // Stages are strictly ordered: nothing is placed against an
      // unestablished ground plane, and a mismatch must be resolved by an
      // explicit choice rather than by another stray tap. Nor is anything moved
      // while a commit waits for its photos: they are of the markers as they are.
      if (stage === 'ground' || stage === 'mismatch' || commitInFlight) return

      const begunIn = stage
      // Read before the hit test answers: where the camera is now is where this touch was made from.
      const tapPoint = photoFlow.touch(x, y)
      tapInFlight = true
      transientStatus = taps.readingText
      renderStage()

      void (async () => {
        try {
          // A tap on a marker that is already placed only selects it, which takes one hit and no burst, and no limit.
          const early = options.sampleTap && !selected && (points.landmark || points.heading)
            ? await Promise.resolve().then(() => options.hitTest(x, y)).catch(() => null)
            : null
          const hit = early && nearestMarker(early.position) ? { position: early.position } : await readTap(commitOptions, x, y)
          // The flow moved on while the tap was read (closed, cleared, confirmed): it is not applied to what came after.
          if (closed || stage !== begunIn) {
            if (transientStatus === taps.readingText) transientStatus = null
            return
          }
          if (!hit || 'refused' in hit) {
            // A reader that turned the tap away says why (./calibration-taps.ts); one that found nothing has this.
            transientStatus = hit ? hit.refused : 'No stable surface there. Aim at a textured floor and tap again.'
            return
          }

          // Floor gate. Rejected on the first attempt, accepted on a retry at
          // the same height: a hard reject would trap a user whose floor
          // estimate is itself wrong (thick carpet, a mezzanine, a sunken
          // room), and a bare warning would be ignored.
          //
          // The retry must match the rejected height, not merely be the next
          // tap — otherwise a rejected tabletop could be confirmed by a tap on
          // a shelf a metre higher, which is not what the user was asked to
          // confirm.
          const groundY = options.ground()?.y ?? null
          // How high the tap measured, which is not its position's height when the floor ray placed it.
          const tapY = hit.surfaceY ?? hit.position.y
          const offFloor = !isTapOnGround(tapY, groundY)
          const confirmingRejectedHeight = isSameHeightRetry(tapY, offGroundTapY)
          if (!confirmingRejectedHeight && offFloor) {
            offGroundTapY = tapY
            const delta = tapHeightAboveGroundCm(tapY, groundY as number)
            const side = delta >= 0 ? 'above' : 'below'
            transientStatus =
              `That looked about ${Math.abs(delta)} cm ${side} the floor. Aim at the floor, or tap the same height again to use it anyway.`
            return
          }
          // A tap accepted off the floor by a same-height retry is a bypass, for the marker it places (`applyTap`). It is judged by the
          // height the gate judged (`tapY`), which under the floor ray is not the position's: that is the fitted floor's by construction.
          const acceptedOffFloor = confirmingRejectedHeight && offFloor
          offGroundTapY = null

          // Pass the raw hit through. applyTap() decides the height, because
          // only it knows which marker this tap is for — and the landmark's own
          // measured height is what defines the floor.
          transientStatus = null
          applyTap({ x: hit.position.x, y: hit.position.y, z: hit.position.z }, tapPoint, acceptedOffFloor)
          // A tap after the landmark was confirmed is where a shift since then shows: say so now, not at the commit.
          if (taps.isDisturbed()) restartAfterDisturbance()
        } finally {
          tapInFlight = false
          if (!closed) renderStage()
        }
      })()
    }

    labelInput.addEventListener('input', () => {
      if (labelFieldFor) labels[labelFieldFor] = labelInput.value
    })

    skip.addEventListener('click', () => close(null))
    skipGround.addEventListener('click', () => {
      // The floor check is bypassed for the whole flow from here (`floorCheckBypassed()`).
      groundWaitOverridden = true
      update()
    })
    confirmBtn.addEventListener('click', () => {
      if (!points.landmark) return
      // The landmark is fixed in the map as it is now: not if the map has shifted since it was tapped, nor while it is not steady.
      if (taps.isDisturbed()) return restartAfterDisturbance()
      if (!mapIsSteady()) return
      // The landmark is committed at this click and the user is still standing
      // where they tapped it, so this is the only moment the photo can show
      // the view they had. Not awaited — the stage advances immediately.
      beginPhotoCapture('landmark')
      taps.landmarkConfirmed()
      selected = null
      transientStatus = null
      refreshSelectionVisuals()
      stage = 'heading'
      renderStage()
    })
    replaceBtn.addEventListener('click', () => {
      taps.clearNote()
      MARKER_IDS.forEach((id) => {
        detach(decals[id])
        decals[id] = null
        points[id] = null
        // Both points are being re-placed, so both photos describe positions
        // that no longer exist.
        tapPoints[id] = null
        photoTasks[id] = null
        delete tappedAt[id]
        // And so does a tap that was accepted off the floor, and the height the gate last turned away: the gate begins again.
        delete offFloorMarkers[id]
      })
      offGroundTapY = null
      refreshBaseline()
      selected = null
      transientStatus = null
      mismatchComparison = null
      stage = 'landmark'
      renderStage()
    })
    /** Takes the check point away: its marker, its tap and its photo. The visit then takes none. */
    function removeCheckMarker(): void {
      detach(decals.check)
      decals.check = null
      points.check = null
      tapPoints.check = null
      photoTasks.check = null
      delete tappedAt.check
      delete offFloorMarkers.check
      if (selected === 'check') selected = null
    }
    checkBtn.addEventListener('click', () => {
      // A hidden or disabled button is the guard a person meets; this is the one a script meets. A commit that waits for its photos holds
      // the points as they were: adding or taking one away now would be saved as something else, or would abandon the commit.
      if (commitInFlight) return
      const action = checkAction({ stage, plan: checkPlan, hasCheck: points.check !== null, pairUsable: (separation() ?? 0) >= MIN_POINT_SEPARATION_M })
      if (!action) return
      if (action.kind === 'add') {
        stage = 'check'
      } else {
        // Skipped from the step, or a placed check point taken away: this visit takes none, and a visit to a Place that stores
        // one is told what is then checked.
        removeCheckMarker()
        stage = 'review'
        if (checkPlan.stored) transientStatus = CHECK_SKIPPED_RETURN
      }
      renderStage()
    })
    adjustBtn.addEventListener('click', () => {
      // Back to the markers, which can be selected and moved: the readout and the ghosts follow each move.
      mismatchComparison = null
      transientStatus = null
      stage = 'review'
      renderStage()
    })
    commitBtn.addEventListener('click', () => void commitTwoPoint(false))
    // Replacing the Place's reference asks first, and improving it leaves for another run of the flow as an upgrade (WP-08).
    const generation = generationActions(options.generation, {
      overlay,
      stored: existingFrame,
      stage: () => stage,
      hasLandmark: () => !!points.landmark,
      residualM: () => mismatchResidualM,
      replacesReference: keepingPairReplacesReference,
      keepPair: () => commitTwoPoint(true),
      close: () => close(null),
    })
    overrideBtn.addEventListener('click', () => void generation.replace())
    improveBtn.addEventListener('click', () => void generation.improve())
    keepBtn.addEventListener('click', () => generation.keep())
    wrongPlaceBtn.addEventListener('click', () => {
      // Shown only on the mismatch screen and only where the host supplies the hook; a script's click meets the same rule,
      // and the host is told once: a second click on a flow that has ended is not another exit.
      if (closed || stage !== 'mismatch' || !options.onWrongPlace) return
      options.onWrongPlace()
      close(null)
    })
    fallbackBtn.addEventListener('click', () => {
      // A hidden button is the guard a person meets. This is the one a script, or a later caller, meets.
      if (onePointOfferNow()) commitSinglePoint()
    })

    // Matches the placeground reference's own guard: a two-finger touch is a
    // recenter/pinch gesture elsewhere in this app, not a placement tap.
    const onTouchStart = (e: TouchEvent) => {
      if (tapInFlight || e.touches.length !== 1 || !options.provider.isTracking()) return
      const touch = e.touches[0]!
      const rect = options.canvas.getBoundingClientRect()
      placeAt((touch.clientX - rect.left) / rect.width, (touch.clientY - rect.top) / rect.height)
    }
    options.canvas.addEventListener('touchstart', onTouchStart, { passive: true })

    // WebXR's dom-overlay input model (Quest/other controller-driven
    // runtimes) synthesizes pointer/click events from a controller ray +
    // select, not touch events — there's no touchscreen to generate a
    // TouchEvent at all. Real touchscreens fire both touchstart *and*
    // pointerdown for the same tap, so this skips pointerType 'touch' to
    // avoid placing two anchors from one tap; that case is already handled
    // above.
    const onPointerDown = (e: PointerEvent) => {
      if (tapInFlight || e.pointerType === 'touch' || !options.provider.isTracking()) return
      const rect = options.canvas.getBoundingClientRect()
      placeAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height)
    }
    options.canvas.addEventListener('pointerdown', onPointerDown)

    update()
  })
}
