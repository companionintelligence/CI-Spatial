/**
 * main.ts — application entry point.
 *
 * Boot sequence:
 *   1. Open IndexedDB store
 *   2. Mount UI (overlay + panel)
 *   3. Detect AR runtime (native ARKit / ARCore in the shell → 8th Wall → WebXR)
 *   4. Init inference router (WebGPU worker or Deno server path)
 *   5. Start AR session
 *   6. Wire capture button → infer → resolve → store → UI update loop
 *   7. Wire auto-capture toggle → pose-delta-based automated capture
 */
import { createEighthWallProvider } from './ar/eighthwall'
import { createNativeARProvider, NativeARProvider } from './ar/native'
import { probeNativeAR } from './ar/native-bridge'
import { preferNativeRuntime } from './ar/runtime-select'
import { createWebXRProvider, WebXRProvider, isImmersiveARSupported } from './ar/webxr'
import { ScanFrameEpochLog } from './ar/frame-epoch'
import { ReanchorFlow, autosplitRequested } from './ar/reanchor-flow'
import { createReanchorView } from './ar/reanchor-banner'
import { carryCalibration, createScanHost } from './ar/reanchor-host'
import { driftTapReader } from './ar/drift-tap'
import { CAPTURE_HELD_TEXT, displayedStatus } from './ar/reanchor-copy'
import type { ARProvider, Pose } from './ar/provider'
import { trackingIsUsable } from './ar/tracking-quality'
import { RoomScanner } from './ar/scanner'
import { runProjectCalibration } from './ar/calibration-run'
import { withdrawCalibrationDrawings } from './ar/project-calibration'
import { openPlacePickerAndWait } from './ar/calibration-exits'
import { calibrationTapSampler, probeTapReader } from './ar/calibration-taps'
import { stampScale } from './ar/engine-config'
import { alignmentStatusText } from './ar/alignment-status'
import { PointCloud } from './scene/pointcloud'
import { CaptureModule } from './capture/capture'
import { AutoCapture } from './capture/auto-capture'
import { KeyframeStreamer } from './capture/keyframes'
import { mountKeyframeFrames } from './ui/keyframe-consent-ui'
import { createScreenWakeLock } from './capture/wake-lock'

/**
 * Holds the screen awake for as long as AR is running. Acquired only after
 * provider.start() resolves — a lock taken before that would outlive a failed
 * start and keep a dead page lit.
 */
const screenWakeLock = createScreenWakeLock()
import { ScanQualityMonitor, isFrameUnusable, motionHintText } from './capture/quality-monitor'
import type { FrameQuality } from './capture/quality-monitor'
import { probeVerdict, startFailureVerdict, type PreflightVerdict } from './ar/preflight'
import { engineExpected, type XR8Load } from './ar/engine-state'
import { InferenceRouter, WebGpuInferenceError } from './inference/router'
import { InferServerError } from './inference/server'
import { getProvisioningStatus, provisionModel, removeProvisionedModel, estimateModelCacheBytes } from './inference/model-provisioning'
import { bucket, resolveDetections, mergeDetections } from './spatial/resolver'
import {
  DetectionStore,
  type CaptureRecord,
  clearTripodCapture,
  deleteTripodSpot,
  loadTripodCapture,
  saveTripodCapture,
} from './scene/store'
import {
  ProjectStore,
  type Project,
  type ScanCalibration,
  type ScanEntry,
} from './project/project-store'
import {
  AREA_NEEDS_CONNECTION,
  FRAME_CONFLICT_TEXT,
  FRAME_NOT_SYNCED_TEXT,
  PLACE_NEEDS_CONNECTION,
  adoptFrameOutcome,
  fetchPlaceList,
  noQueueHeaders,
  onFrameSettled,
  persistProjectSpatialFrame,
  readCreatedPlace,
  resolveInitialPlace,
  retryPendingFrames,
  showFrameSyncNote,
  unsyncedPlaceIds,
  whenFramesSettled,
  withPendingFrame,
  type FrameSyncOutcome,
} from './project/frame-sync.ts'
import { newPlaceTypeOptionsHtml } from './project/new-place-type.ts'
import type { AreaKind, PlaceArea, PlaceType } from './world/types'
import { AROverlay } from './ui/overlay'
import { writeStatus, type StatusPriority } from './ui/status-line'
import { SidePanel, type ExportOutcome } from './ui/panel'
import { SessionHistory } from './ui/history'
import { previousRunNotice } from './ui/previous-run'
import { hideWithoutServer, renderFtueStatus, SIGN_IN_FAILED } from './ui/ftue-status'
import { initShellSignIn } from './shared/shell-sign-in'
import { apiUrl, editorPath, isDesktopShell, isNativeShell, SCAN_SERVER_CHANGE_EVENT, shellSessionToken, withSessionToken } from './shared/api-base.ts'
import { exportToGLB } from './export/gltf'
import { isServerSessionId } from './shared/session-id.ts'
import { acquireScannerRole } from './shared/scanner-lock.ts'
import { captureCountFor, highestCaptureIndex, isSameCapture, isSameRecord } from './shared/capture-index.ts'
import { exportSessionSummary } from './export/summary'
import { GeoTracker, type GeoFix } from './geo/geo-tracker'
import { compassRuleFromSearch } from './geo/compass-heading'
import { bearingConventionFromSearch, compassSpinTerms, distanceM, formatCompassSpin } from './world/geo'
import type { RtcBroadcaster } from './rtc/broadcaster'
import { WEBRTC_LIVE_ENABLED } from './rtc/feature'
import { registerPWA } from './pwa'
import { installRemoteLog } from './debug/remote-log'
import { iconLabel } from './ui/icons'
import { installKeyboardAvoidance } from './ui/keyboard'
import { ONBOARDING_KEY, PLACE_SELECTION_SESSION_KEY } from './shared/storage-keys'
import { hasDebugFlag } from './shared/debug-flags'
import { formatPoseDelta, poseDelta } from './capture/pose-delta'
import { installProbeLog } from './capture/probe-log'
import {
  UPLOAD_RESULT_NOTE,
  uploadExpectation,
  uploadExpectationLine,
  type ScanCapability,
} from './capture/upload-expectation'
import {
  DISTANCE_PROMPT,
  DROP_SPOT_CANCEL_LABEL,
  DROP_SPOT_CONFIRM_LABEL,
  DROP_SPOT_LABEL,
  TRIPOD_PATH_SUMMARY,
  WHY_SEVERAL_SPOTS,
  addPhotos,
  beginSweep,
  canDropSpots,
  clearDistance,
  createStationCapture,
  currentSpot,
  dropSpot,
  dropSpotConfirm,
  endSweep,
  finishCapture,
  finishVerdict,
  nextSpot,
  recordDistance,
  shouldAskDistance,
  sizeVerdict,
  skipDistance,
  spotSummary,
  stationGuidance,
  totalPhotos,
  type StationCaptureState,
} from './capture/station-capture'
import { readSpotDistance, spotDistanceEcho } from './capture/spot-distance'
import { SweepCamera } from './capture/sweep-camera'
import { CAMERA_ON_LABEL, sweepCountLine, sweepEndNotice, sweepMotionNotice } from './capture/sweep-cadence'
import {
  RECOVERY_DISCARD_LABEL,
  RECOVERY_KEEP_LABEL,
  RECOVERY_LOST_SWEEP,
  newSpotKey,
  recoveryHeadline,
  restoreTripodCapture,
  tripodMetaOf,
} from './capture/tripod-persistence'
import {
  filesFor,
  knownDistancesFor,
  planStationFrames,
  stationsFor,
  type KnownDistance,
} from './capture/station-upload'
import {
  deviceFromProbe,
  resolveCapture,
  withoutLiveCapture,
  type CaptureControlId,
  type CaptureSubject,
  type DeviceCapture,
  type MethodPlan,
} from './capture/capture-intent'
import * as THREE from 'three'

const CAPTURE_FRAME_TIMEOUT_MS = 8000
const TRACKING_WAIT_MS = 2500
/**
 * What a capture says when tracking never started: the photo is saved and nothing is
 * placed. Inference is skipped for such a frame, because its labels could only be
 * shown, never put anywhere, so no labels appear. The line says what to do next.
 */
const UNPLACED_STATUS = '⚠ Tracking not ready. Photo saved, not placed. Move slowly, then capture again.'
/** See `lightSampleTick` — one luminance sample every fourth 750 ms scanner tick. */
const LIGHT_SAMPLE_EVERY_TICKS = 4
let requestPlaceSelection:
  | ((afterSelection?: () => void, purpose?: PlaceSelectionPurpose, onDismiss?: () => void) => void)
  | null = null
// Upload selection is wired before IndexedDB and Place data finish loading, so
// retain its current target in module state for the upload handler.
let uploadPlaceTarget: { projectId: string | null; areaId: string | null } = { projectId: null, areaId: null }
/**
 * A claim on the shared file input, held while Tripod Scan is collecting one
 * spot's photos.
 *
 * There is exactly one `#upload-video-input` and one `uploadPlaceTarget`, and
 * both paths want the same two things — pick photos, send them to this Place —
 * so the tripod path borrows the input rather than adding a second one beside
 * it. The consumer is what tells the change handler which of the two asked:
 * set, the files go to the station loop and nothing is uploaded yet; unset,
 * the handler behaves exactly as it always has.
 */
let pendingPhotoIntake: ((files: File[]) => void) | null = null
/**
 * What a tripod capture adds to the one upload, held for the single send that
 * claims it.
 *
 * The same borrowing as `pendingPhotoIntake`, at the other end of the flow.
 * Tripod Scan's photos go out through `wireContentUpload()`'s handler like any
 * other photo set — same endpoint, same Place target, same progress line — and
 * these are the two fields that make them a capture of a room rather than a
 * pile of pictures: which spot each photo came from, and the one measured
 * length. Without them the server cannot refuse a capture taken from a single
 * spot and cannot size the result, which is what used to happen to every
 * capture the app made itself.
 *
 * `settle` is how the tripod sheet learns what became of them, so the two
 * screens reporting the same upload cannot disagree.
 */
let pendingUploadExtras:
  | {
      stations: number[]
      knownDistances: KnownDistance[]
      /** Replaces the generic success line with one worded for this capture. */
      successLine: (frameCount: number) => string
      settle: (ok: boolean, message: string) => void
    }
  | null = null
/**
 * Whether recommending a live scan is honest advice on this device.
 *
 * Read by the upload path, which has to name an alternative to an upload's one
 * real limitation (it builds the room but places nothing in it) and must not
 * say "walk the room instead" to someone holding a phone that has already been
 * found unable to. Starts 'unknown' because wireContentUpload() runs at the top
 * of main(), before the secure-context check and long before an AR runtime
 * exists — a tap can genuinely arrive before there is an answer.
 *
 * Written from the preflight verdict rather than re-derived here, so there is
 * one notion of "can this device scan" (src/ar/preflight.ts) and not a second.
 */
let scanCapability: ScanCapability = 'unknown'

/**
 * What the person said they are capturing. The start screen's only question.
 *
 * 'room' rather than null: a screen that shows nothing until it is answered has
 * added a tap for everyone to spare the few whose answer is different, and the
 * three-tap path to the camera (tests/mock-scanner-startup-budget.spec.ts) is
 * budgeted, same as the words are.
 */
let captureSubject: CaptureSubject = 'room'

/**
 * What this device has actually been found able to do — the other half of the
 * recommendation.
 *
 * Both live rungs start `'unknown'`, which is the honest state before anything
 * has been probed and is deliberately NOT `'no'`: `resolveCapture()` still
 * recommends an unproven live capture (hedged in words), for the same reason
 * `probeVerdict()` answers 'warming-up' — routing a phone away from a session
 * that was about to work is as wrong as promising one that never will.
 * `secureContext` is knowable synchronously and never changes.
 */
let captureDevice: DeviceCapture = {
  secureContext: window.isSecureContext,
  nativeAr: 'unknown',
  browserAr: 'unknown',
}

/**
 * Whether the methods that were not recommended are on screen.
 *
 * Starts closed. The screen's whole premise is that the person names the
 * subject and the app names the method, and three cards open re-poses exactly
 * the question it exists to stop asking — so the alternatives are one tap
 * away rather than in front of everyone. Measured: the two un-recommended
 * cards were 50 of the 140 words shown before the camera
 * (tests/support/startup-budget.ts).
 *
 * Survives a re-render, because `setCaptureDevice()` can fire while a finger
 * is on the list and a list that slams shut mid-read is worse than one that
 * was never opened. It is reset only where the question itself changed — see
 * `mountCaptureIntent()`.
 */
let altsExpanded = false

function poseIsFinite(pose: Pose): boolean {
  return Number.isFinite(pose.position.x)
    && Number.isFinite(pose.position.y)
    && Number.isFinite(pose.position.z)
    && Number.isFinite(pose.rotation.x)
    && Number.isFinite(pose.rotation.y)
    && Number.isFinite(pose.rotation.z)
    && Number.isFinite(pose.rotation.w)
}

// One-time HUD notices — module-level so repeated triggers stay quiet
let quotaWarningShown = false
let decimationNoticeShown = false
/**
 * True while degraded tracking is suppressing point recording. Live state, not
 * a one-shot: it is read by updateVerdictUI() on every scanner tick, so it has
 * to clear the moment tracking recovers or the HUD would keep telling someone
 * who is now recording fine that they are not.
 */
let recordingPaused = false

/**
 * True while #permission-error-banner is showing a PREFLIGHT verdict, as
 * opposed to the motion-permission denial that beginArSession() writes into the
 * same element. Only the former may be cleared by a later 'ready' verdict —
 * see applyPreflightVerdict().
 */
let preflightBannerShown = false

// Last verdict state written to the HUD, so the 750 ms scanner tick only
// touches the DOM when the verdict or its recommendation actually changes.
let lastVerdictKey: string | null = null
/** Last text written to #quality-motion-hint — see updateQualityOverlay(). */
let lastMotionHint: string | null = null

async function main() {
  // Which page may write the scan store is settled first, before anything is wired (MAIN10-1; see
  // src/shared/scanner-lock.ts). The lock decision needs no store, so it runs here. Each write path
  // below is wired after it, and a read-only page wires its path to refuse (see wireContentUpload()
  // and mountTripodCapture()).
  const scannerRole = await acquireScannerRole(navigator)
  const readOnlyScanner = scannerRole === 'readOnly'
  const searchParams = new URLSearchParams(location.search)
  // Onboarding is skipped under mocks (so scan-flow tests don't stall on it) and
  // when explicitly disabled with ?onboarding=0. ?onboarding=1 forces it on even
  // under a mock runtime, so the FTUE overlay can be exercised in tests.
  const skipOnboarding = searchParams.get('onboarding') === '1'
    ? false
    : searchParams.has('mock') || searchParams.get('onboarding') === '0'

  // A native shell serves its bundle as plain files, so the markup's `/editor` (a server and
  // Pages rewrite) would fall back to this scanner page. Point the editor links at the file
  // before anything below can return early; pointEditorLinksAtPlace() adds the Place later.
  if (isNativeShell()) {
    for (const id of ['start-editor-card', 'upload-video-open']) {
      const link = document.getElementById(id)
      if (link instanceof HTMLAnchorElement) link.href = editorPath()
    }
  }

  // Remote log mirror — inert unless armed via ?debug=remote or localStorage
  installRemoteLog()
  // Fields under the on-screen keyboard: publish the visible height and bring
  // the focused field back on screen (src/ui/keyboard.ts).
  installKeyboardAvoidance()

  // Walkthrough-video upload — a server-side path that needs no AR runtime or
  // secure context, so wire it before the isSecureContext bail-out below.
  wireContentUpload(readOnlyScanner)
  // Tripod Scan, for the same reason: no AR runtime is involved in it at all,
  // and the phones this path exists for are the ones where the boot below
  // gives up. It borrows the input wireContentUpload() just wired, so it
  // follows it.
  mountTripodCapture(readOnlyScanner)
  // The question that decides which of the three above is put in front of the
  // person. Wired here for the same reason they are: it has to work on the
  // devices where the boot below returns early, which is precisely where
  // choosing the wrong path costs the most.
  mountCaptureIntent()

  // Camera, WebXR, and IndexedDB all need a secure context; fail fast with
  // actionable guidance instead of a cascade of cryptic permission errors.
  if (!window.isSecureContext) {
    console.warn(`[main] Secure context (HTTPS) required. To test locally: tailscale cert ${location.hostname}`)
    const statusEl = document.getElementById('status-text')
    if (statusEl) statusEl.textContent = `✕ Needs a secure link\n• Ask for the https:// link`
    setStartButtonState('unavailable', 'Needs a secure (HTTPS) link')
    return
  }

  registerPWA({ flushQueue: !readOnlyScanner })

  const canvas = document.getElementById('camerafeed') as HTMLCanvasElement
  const overlay = setupStatusOverlay()

  // ── 0. Start-AR gesture gate ────────────────────────────────────────────────
  // Wired here, at the top of the boot, even though AR itself only starts in
  // section 5. #start-ar-btn is in the static markup and paints in ~250ms,
  // while everything between here and section 5 is awaited work the button
  // does not need — IndexedDB stores, and above all the inference router's
  // model load. Registering the listener down there meant a tap in that
  // window (~6.5s, measured on a mobile-emulated run) reached no listener at
  // all: no feedback, start screen still up, nothing started.
  //
  // The handler is still the user gesture itself — a tap is never replayed or
  // synthesized later, only allowed to arrive earlier — so iOS Safari's rule
  // that DeviceOrientation/DeviceMotion requestPermission() be called
  // synchronously inside a real click handler still holds.
  //
  // A first-run visitor can't tap through the onboarding overlay to get here:
  // it covers the start screen and is dismissed before section 4b returns.
  const startBtn = document.getElementById('start-ar-btn') as HTMLButtonElement | null
  let startPressed = false
  let selectedProject: Project | null = null
  let selectedAreaId: string | null = null
  let projectSelectionReady = false
  let resolveStartAr: () => void = () => {}
  /**
   * Set by section 3 when no AR runtime could be created — the one path where
   * main() `return`s while `startArPressed` is still pending.
   *
   * Without it that return is a silent dead end for anyone already inside the
   * Place picker: the modal (#place-sheet, z-index 80) covers the start screen
   * (z-index 20), so `showArHelp()`'s #ar-help line and the disabled Start
   * button are both written where nothing can see them — and then the confirm
   * tap runs beginArSession(), which overwrites that Start button line with
   * "Starting AR…" and resolves a gate that nothing is awaiting any more.
   * Observed as: tap "Scan This Place", AR never starts, no error anywhere.
   */
  let arRuntimeError: string | null = null
  const beginArSession = async () => {
    if (startPressed) return
    // Nothing downstream is left to honour this tap once section 3 has given
    // up, so report the real reason and leave the start screen (and the
    // still-usable Upload path) standing rather than tearing it down for an
    // AR session that cannot happen. The banner lives inside #ar-overlay, not
    // #start-screen, so it survives whichever of the two is torn down first.
    if (arRuntimeError) {
      showPermissionBanner(arRuntimeError, 'AR did not start')
      overlay.setStatus(arRuntimeError)
      return
    }
    startPressed = true
    // This runs from the place-choice tap, which is still a real user gesture.
    // That keeps Safari's motion permission request eligible after the modal.
    type PermAPI = { requestPermission?(): Promise<string> }
    const p1 = (DeviceOrientationEvent as unknown as PermAPI).requestPermission?.()
    const p2 = (DeviceMotionEvent as unknown as PermAPI).requestPermission?.()

    // The start screen is torn down only once `provider.start()` has actually
    // resolved (section 5), not here. Removing it up front meant a device with
    // no working AR runtime landed on a dark screen holding a raw exception,
    // with no retry and no route back to the paths that need no AR runtime —
    // the ones that phone can still take, and they had just been deleted. Report progress on
    // the button that was tapped, since #status-text sits behind this screen.
    const startStatus = document.querySelector<HTMLElement>('#start-ar-btn .start-path-status')
    if (startStatus) startStatus.textContent = 'Starting AR…'
    overlay.setStatus('Starting AR…')

    const permissionChecks = [p1, p2].filter((p): p is Promise<string> => p !== undefined)
    const denialNotice = 'Enable motion & orientation access in Settings → Safari → Motion & Orientation Access.'
    try {
      const outcomes = await Promise.all(permissionChecks)
      const refused = outcomes.filter((outcome) => outcome !== 'granted')
      if (refused.length > 0) {
        console.warn(`[main] Motion/orientation permission ${refused.join('/')} — SLAM will not track`)
        showPermissionBanner(denialNotice)
      }
    } catch (err) {
      console.warn('[main] Motion/orientation permission request failed — SLAM may not track', err)
      showPermissionBanner(denialNotice)
    }
    resolveStartAr()
  }

  const startArPressed = new Promise<void>((resolve) => {
    resolveStartAr = resolve
    startBtn?.addEventListener('click', () => {
      if (startPressed) return
      if (!projectSelectionReady) {
        overlay.setStatus('Preparing projects…')
        return
      }
      // Every new capture starts by confirming its place, even when a project
      // was used previously. The selection defines this scan's shared frame.
      requestPlaceSelection?.(() => { void beginArSession() }, 'scan')
      overlay.setStatus('⚠ No project selected\n• Choose or create one to calibrate')
    })
  })
  // The button ships `disabled aria-busy="true"` with a "Preparing…" line in
  // index.html, so it never advertises itself as pressable before this point —
  // the gap is now only the ~50ms until this line runs, plus the case where
  // the bundle never loads at all, where staying disabled is the honest state.
  // Enabling here rather than at section 5 is the whole fix: the handler above
  // is live, so the tap has somewhere to land.
  setStartButtonState('ready')

  // ── 1. Store + scan accumulators ────────────────────────────────────────────
  // The role was settled at the top of main(), before anything was wired (MAIN9-1, MAIN10-1). A
  // read-only page opens the same store with readOnly, and starts no scan, stream, upload, export or
  // capture (see READ_ONLY_NOTICE below).
  const store = readOnlyScanner ? new DetectionStore({ readOnly: true }) : new DetectionStore()
  // Another tab has taken this scan over, so nothing this page writes is saved. Said in the
  // status line when the store reports it (see DetectionStore.onSuperseded), and kept there.
  const SUPERSEDED_NOTICE = 'This scan is open in another tab. Changes here are not saved. Reload this page to continue.'
  const showSuperseded = () => overlay.setStatus(SUPERSEDED_NOTICE, 'sticky')
  store.onSuperseded(showSuperseded)
  // The status line holds a sticky write for STATUS_HOLD_MS only, and any later write (a scanner
  // tick, a capture result) replaces the notice. So while the store stays superseded, the notice
  // is put back after every write to the node. The observer runs before the browser paints, so
  // the replaced text is never shown.
  const statusNode = document.getElementById('status-text')
  const keepSupersededNotice = () => {
    if (store.isSuperseded && statusNode?.textContent !== SUPERSEDED_NOTICE) showSuperseded()
  }
  if (statusNode) new MutationObserver(keepSupersededNotice).observe(statusNode, { childList: true, characterData: true, subtree: true })
  // Another scanner page on this origin holds the writer lock, so this page writes nothing. Capture,
  // stream and person are disabled with this notice as their reason. The place picker is not opened,
  // because scan, upload and tripod all start there, and a manual export is not run, because it uploads.
  const READ_ONLY_NOTICE = 'Scanner is open in another tab. Close it, or reload this page, to capture here.'
  const showReadOnlyNotice = () => overlay.setStatus(READ_ONLY_NOTICE, 'sticky')
  if (readOnlyScanner) {
    // Put back after every write to the node, as the superseded notice is. Later boot writes (the AR
    // engine load, for one) would otherwise replace a notice that is held for STATUS_HOLD_MS only.
    // It yields to the superseded notice when both apply.
    const keepReadOnlyNotice = () => {
      if (!store.isSuperseded && statusNode?.textContent !== READ_ONLY_NOTICE) showReadOnlyNotice()
    }
    if (statusNode) new MutationObserver(keepReadOnlyNotice).observe(statusNode, { childList: true, characterData: true, subtree: true })
    showReadOnlyNotice()
    disableCaptureControls(READ_ONLY_NOTICE)
  }
  await store.open()
  // Continue the last scan rather than silently starting empty. Without this a
  // reload lost every pin — the restore method existed but nothing called it,
  // so the only way back to a scan was the history drawer. Announced rather
  // than silent, so a resumed scan is never mistaken for a fresh one; "Clear
  // session" in the panel is the way to start over.
  const resumed = await store.resumeLatestSession()
  if (resumed > 0) {
    // The record is back, the objects in it are not in this page's frame. See DetectionStore.currentRunDetections.
    overlay.setStatus(previousRunNotice(store.previousRunCount()))
  }
  void checkStorageQuota(store, overlay)
  const projectStore = new ProjectStore()
  await projectStore.open()
  selectedProject = await resolveInitialProject(projectStore)
  projectSelectionReady = true
  let sessionScanEntry: ScanEntry | null = null
  let sessionCalibration: ScanCalibration | undefined
  // A frame a calibration made and the server does not hold yet is sent again when the page loads, when the
  // connection comes back and when the Place picker opens. A read-only page sends nothing. What the server
  // answers reaches the Place this page works with, whoever asked: a later calibration then names the revision
  // the server holds, and a frame that lost to another device's is not stamped on the scans that follow.
  if (!readOnlyScanner) {
    void retryPendingFrames(projectStore, undefined, 'load')
    globalThis.addEventListener('online', () => void retryPendingFrames(projectStore, undefined, 'online'))
    onFrameSettled(({ projectId, outcome }) => {
      if (selectedProject?.projectId !== projectId) return
      adoptFrameOutcome(selectedProject, outcome)
      if (outcome.status !== 'conflict' || !sessionCalibration) return
      // Exports take the calibration from the session's scan entry once there is one, so it goes from there too.
      sessionCalibration = undefined
      if (sessionScanEntry) {
        sessionScanEntry.calibration = undefined
        void projectStore.updateScan(sessionScanEntry).catch(() => {})
      }
      overlay.setStatus(FRAME_CONFLICT_TEXT, 'sticky')
      // What the calibration drew is a claim about a frame this Place no longer has: the needle and the scene's drawings go too.
      // The scan is the same one, in the session frame it was, so the floor grid it keeps stays.
      dropCalibrationDrawings({ floor: false })
    })
  }
  const qualityMonitor = new ScanQualityMonitor()
  /**
   * What this scan has seen of the provider's frame epochs (src/ar/frame-epoch.ts): how many
   * times tracking was interrupted or the runtime's origin moved since the scan began, and the
   * record the upload sidecar carries. Attached to the provider before AR starts.
   */
  const scanFrameEpochs = new ScanFrameEpochLog()
  /**
   * Scanner ticks since the last luminance sample. Sampling every tick would
   * mean a 64x64 drawImage + getImageData off the camera video every 750 ms for
   * a number that changes on the timescale of someone turning a lamp on; every
   * fourth tick (~3 s) is fast enough to catch a dark room before the person
   * has walked anywhere, and cheap enough not to compete with SLAM.
   */
  let lightSampleTick = 0
  const geoTracker = new GeoTracker({ compassRule: compassRuleFromSearch(location.search) })
  const placePicker = mountPlacePicker(projectStore, geoTracker, selectedProject, (project, areaId) => {
    selectedProject = project
    selectedAreaId = areaId
    uploadPlaceTarget = { projectId: project?.projectId ?? null, areaId }
    sessionScanEntry = null
    pointEditorLinksAtPlace(project?.projectId ?? null)
  })

  /**
   * Point every "open the editor / viewer" link at the Place being scanned.
   *
   * Without this they open a bare `/viewer.html`, which loads the `default` world — and that
   * world admits only scans with no projectId, so a scan captured into a Place is invisible
   * there by construction. The user finishes a scan, taps through, and sees an empty editor
   * with their work apparently gone. It is not gone; it is in `project-<id>`.
   */
  function pointEditorLinksAtPlace(projectId: string | null): void {
    const suffix = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
    // editorPath() is /editor on a server and the public site, which rewrite it, and
    // /viewer.html in a native shell, which has no rewrite and would show the scanner.
    for (const [id, base] of [['start-editor-card', editorPath()], ['viewer-link', '/viewer.html']] as const) {
      const link = document.getElementById(id)
      if (link instanceof HTMLAnchorElement) link.href = `${base}${suffix}`
    }
  }
  pointEditorLinksAtPlace(selectedProject?.projectId ?? null)
  // The editor reads places from the Scan server, so its card only leads to an error without one.
  void hideWithoutServer(document.getElementById('start-editor-card'))
  // A native shell's server can be changed on the first-run screen. The card follows it.
  globalThis.addEventListener(SCAN_SERVER_CHANGE_EVENT, () => {
    void hideWithoutServer(document.getElementById('start-editor-card'))
  })
  // A read-only page opens no place picker. Scan, upload and tripod sweep all start there, and each one writes.
  requestPlaceSelection = readOnlyScanner ? showReadOnlyNotice : placePicker.open
  const pointCloud = new PointCloud(0.05)   // 5 cm voxel deduplication grid
  const poseHistory: Pose[] = []
  const scanner = new RoomScanner()
  // Room-loop drift readout (wave 09/0006). Inert unless ?debug=pose; the
  // reference pose is the first tracked pose of the session, which is what the
  // benchmark's "walk back to the tape" step measures against.
  const poseReadoutArmed = hasDebugFlag('pose')
  let poseReference: Pose | null = null
  // The numbering counter for this session's captures, inferred or not. It starts at the highest
  // index the resumed session already stores, so the next capture is numbered above it and cannot
  // replace a stored record. It numbers captures and nothing else: a Clear keeps it, so it is not a
  // count of what the store holds (the summary reads store.captureCounts()).
  let captureCount = highestCaptureIndex(store.captures.values(), store.sessionId)
  // The session captureCount counts for. A Clear keeps it; a load, a delete or an adoption moves the store on.
  let captureCountSession = store.sessionId
  // The count each session this page has moved on from was at. A session loaded back resumes from it.
  const leftCaptureCount = new Map<string, number>()
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
  let autoSaveInFlight = false
  let autoSaveQueued = false
  let captureInFlight = false
  let latestKeyframeCount = 0
  // Set by a scan reset, which closes the keyframe stream whose count this is. Its
  // late status (uploads still draining) must not write the count back; an open
  // stream clears it again.
  let keyframeCountClosed = false

  // Start geo tracker early (GPS needs time to acquire a fix)
  // Wire geo indicator chip immediately when first fix arrives
  geoTracker.onUpdate = (fix) => updateGeoIndicator(fix)
  void geoTracker.start().then((fix) => {
    if (fix) updateGeoIndicator(fix)
    if (fix?.address) overlay.setStatus(fix.address)
  })

  // ── 2. Inference router & early UI mounting (prevents test timeouts) ───────
  const router = new InferenceRouter()

  // Assigned once the AR provider exists; the export callback below runs on
  // user action, long after assignment.
  let keyframes: KeyframeStreamer | null = null

  // The most recent GLB this tab has EVER uploaded, across session
  // boundaries — never reset. Lets requestServerProcessing identify "my
  // scan" without depending on sessionId resolution.
  let lastUploadedFilename: string | undefined

  // The GLB uploaded since the CURRENTLY OPEN keyframe session started —
  // undefined whenever this session hasn't produced one yet. This is what the
  // session-exit paths that don't have a fresh filename in hand (the stream
  // toggle, pagehide) send as the backlink `session.json.glbFilename`, which
  // scan_index.ts's `byGlb` map resolves a scan through when its sessionId is
  // null. Cleared every time a new session opens (kfStreamer.onSessionId
  // below) — reusing `lastUploadedFilename` here instead would attach a
  // PREVIOUS session's filename to a session that produced no scan of its
  // own, since that variable is deliberately never reset. The export/autosave
  // handlers don't read this for their OWN rotate() calls — they already have
  // the fresh filename in hand locally — only for the two paths that don't.
  let currentSessionGlbFilename: string | undefined

  // One scan, one frame (src/ar/reanchor-flow.ts). The scan half of the flow's host: how this page saves a scan and begins
  // the next one (src/ar/reanchor-host.ts), on the export, the store and the reset it already has.
  const scanHost = createScanHost({
    store,
    exclusive: withoutAutosave,
    hasContent: () => pointCloud.count > 0 || store.currentRunDetections().size > 0 || poseHistory.length > 0,
    exportScan: async () => exportToGLB(
      { store, pointCloud, poseHistory, scanEntry: await ensureSessionScanEntry(), geoFix: geoTracker.snapshot() ?? undefined, qualitySummary: currentQualitySummary(), frameEpochs: scanFrameEpochs.snapshot(pointCloud) },
      { download: false, upload: true, filenamePrefix: 'room-scan', autoSaved: false },
    ),
    recordUploaded: async (filename) => {
      await updateSessionScanFilename(filename)
      lastUploadedFilename = filename
      currentSessionGlbFilename = filename
      revealDownloadLink(filename)
      setAutosaveStatus(`Scan saved ✓ ${shortName(filename)}`)
    },
    resetScan: resetScanner,
    clearCalibration: () => {
      sessionCalibration = undefined
      scanFrameEpochs.forgetCalibration()
      // The next scan is in another frame and has no calibration yet: nothing drawn for the old one is its own, the floor grid included.
      dropCalibrationDrawings({ floor: true })
    },
    get keyframes() { return keyframes },
    calibrate: calibrateScan,
    ensureEntry: ensureSessionScanEntry,
    capturing: () => captureInFlight,
  })
  // When the runtime's frame may have moved under a calibrated scan the person chooses to re-anchor (this scan is saved
  // and the next one begins, calibrated again) or to keep going; Check drift taps the landmark again to measure it.
  const reanchor = new ReanchorFlow({
    view: createReanchorView({ canvas }),
    epochs: scanFrameEpochs,
    arRunId: () => store.arRunId,
    autosplit: autosplitRequested(location.search),
    host: {
      ...scanHost,
      storedFrame: () => selectedProject?.spatialFrame ?? null,
      calibration: () => sessionCalibration,
      poses: () => poseHistory,
      readTap: (x, y) => driftTapReader({
        provider,
        hitTest: async (hx, hy) => (asyncHitTest ? await asyncHitTest(hx, hy) : provider.hitTest(hx, hy)),
        ground: () => pointCloud.groundEstimate(),
      })(x, y),
      say: (text) => overlay.setStatus(text, 'sticky'),
    },
  })

  /**
   * Point the capture counter at the live session. The counter belongs to the session it
   * was last counted for, and captureCountFor works out its value for the session now live.
   * A Clear keeps the session, so the count only rises. Any other change of session moves
   * the count to that session's own history.
   */
  function followCaptureSession(): void {
    const live = store.sessionId
    if (live !== captureCountSession) leftCaptureCount.set(captureCountSession, captureCount)
    captureCount = captureCountFor(live, captureCountSession, captureCount, store.captures.values(), leftCaptureCount)
    captureCountSession = live
  }

  /**
   * Empty the live scan: the point cloud, the pose trail, the Place entry it was
   * going into, and its keyframe session. Run after Clear, after deleting the
   * session being scanned, and after loading another one, so the next Export or
   * autosave cannot upload geometry from a session that is no longer shown. The capture
   * count follows the session now live (see followCaptureSession), so the next capture
   * cannot reuse an index that a capture still holds.
   *
   * `detectionCount` is the detections the scan being left had. The caller reads it
   * before it changes the store, since a load or delete has already replaced them by
   * the time this runs. The point count and pose trail are read here, before the clear.
   */
  function resetScanner(detectionCount: number): void {
    if (keyframes?.active) {
      // The stream was feeding the scan being left, so it ends with it. A rotation
      // would open a new session at once, and the store adopts that id for whatever
      // session is open now, which for a load is the one just loaded.
      void keyframes.stop({
        glbFilename: currentSessionGlbFilename,
        pointCount: pointCloud.count,
        detectionCount,
        poseCount: poseHistory.length,
        qualitySummary: currentQualitySummary(detectionCount),
      })
    }
    pointCloud.clear()
    poseHistory.length = 0
    sessionScanEntry = null
    latestKeyframeCount = 0
    keyframeCountClosed = true
    currentSessionGlbFilename = undefined
    qualityMonitor.reset()
    scanFrameEpochs.reset()
    reanchor.noteScanReset()
    // A Clear keeps the live session, so the count only rises. A load or a delete may have
    // moved the store to another session, or to none, and that one counts from its own history.
    followCaptureSession()
  }

  // The On-device toggle and its model row read hasWebGPU when the panel is built,
  // so the adapter probe runs first. It is bounded (2 s), and router.init() below
  // reuses its answer rather than asking the browser again.
  await router.probeWebGPU()
  const panel = new SidePanel(
    store,
    async () => {
      const { outcome, uploadedFilename } = await exportManualScan()
      if (uploadedFilename) {
        lastUploadedFilename = uploadedFilename
        currentSessionGlbFilename = uploadedFilename
      }
      // Nothing was written on a cancel or a failure, so there is no scan for
      // a fresh keyframe session to be linked against.
      if (outcome !== 'cancelled' && outcome !== 'failed' && keyframes?.active) {
        void keyframes.rotate({
          glbFilename: uploadedFilename,
          pointCount: pointCloud.count,
          detectionCount: store.currentRunDetections().size,
          poseCount: poseHistory.length,
          qualitySummary: currentQualitySummary(),
        })
      }
      return outcome
    },
    // The Captures figure is what the store holds for this session, so a Clear is reflected in it.
    // captureCount is only the numbering counter, and a Clear leaves it where it was.
    () => exportSessionSummary({ store, pointCloud, poseHistory, captureCount: store.captureCounts('run').total, geoFix: geoTracker.snapshot() ?? undefined }),
    (action) => requestServerProcessing(action, store, lastUploadedFilename),
    (mode) => {
      router.setMode(mode)
      overlay.setStatus(`AI: ${mode === 'server' ? 'Server' : 'WebGPU'}`)
    },
    router.path,
    // Wave 05 ticket 0004 — undefined (no row shown) on a device that cannot
    // run the on-device path at all (router.hasWebGPU false). Provisioning
    // 2.2 GB of weights a browser can never load them into buys nothing.
    router.hasWebGPU
      ? () => provisionModel((stage, pct) => overlay.setProgress(pct, stage)).finally(() => {
        overlay.setProgress(null)
        void checkStorageQuota(store, overlay)
      })
      : undefined,
    router.hasWebGPU
      ? async () => { await removeProvisionedModel(); return getProvisioningStatus() }
      : undefined,
    // Wave 05 ticket 0004 — the toggle is always offered, but a device
    // without WebGPU gets told specifically why it's disabled instead of
    // just failing on use (this ticket's Acceptance Criteria).
    router.hasWebGPU ? null : 'This browser has no WebGPU support',
    resetScanner,
  )
  panel.mount()
  if (readOnlyScanner) panel.setReadOnly()
  // WebRTC live view is an experimental feature and must not appear in normal
  // scanning until its device connection path is reliable.
  if (!WEBRTC_LIVE_ENABLED) panel.streamButton?.remove()
  // Seed the "On-device model" row with real on-disk state (and, best-effort,
  // the download's total size) rather than leaving it on its mount-time
  // "checking…" placeholder indefinitely.
  if (router.hasWebGPU) {
    void getProvisioningStatus({ probe: true }).then((status) => panel.setModelStatus(status))
  }

  const history = new SessionHistory(store, resetScanner)
  if (readOnlyScanner) history.setReadOnly()
  history.mount()

  // Deliberately no saveSnapshot() here. Persisting at boot wrote an empty
  // record on every page load, so the history drawer filled with "0 objects"
  // rows that buried the real scans. The first capture persists; until then
  // there is nothing worth storing.
  void checkStorageQuota(store, overlay)

  document.getElementById('history-btn')?.addEventListener('click', () => {
    void initDrawerGeoMap(geoTracker.snapshot())
  })

  await router.init(
    (stage, pct) => { overlay.setProgress(pct, stage) },
    (mode) => {
      overlay.setStatus(`AI: ${mode === 'server' ? 'Server' : 'WebGPU'}`)
      panel.updateInferMode(mode)
    },
  )
  overlay.setStatus(`AI: ${router.path === 'server' ? 'Server' : 'WebGPU'}`)
  // SidePanel was built before init, when the router had not read its saved mode
  // yet, and init() never calls onModeChange for it. Without this the panel says Server.
  panel.updateInferMode(router.path)

  // ── 3. AR runtime detection ────────────────────────────────────────────────
  let provider: ARProvider
  let use8thWall = false
  let nativeActive = false

  // Forced runtime: /webxr.html redirects here with ?ar=webxr — used in
  // WebXR-capable iOS browsers (e.g. HelloXR) where the native WebXR session
  // beats the 8th Wall SLAM fallback.  ?ar=8thwall forces the inverse.
  const forcedMode = searchParams.get('ar')

  // Test hook: ?mock=webxr installs the iwer emulation runtime (Meta's
  // immersive-web-emulator engine) so WebXR flows run in headless browsers.
  if (searchParams.get('mock') === 'webxr') {
    const emulation = await import('./test/webxr-emulation')
    await emulation.installWebXREmulation()
  }

  // XR8 global is set by xr.js (the 8th Wall / Niantic Spatial XR Engine
  // binary in public/xr.js — free and key-less, but proprietary; see the
  // licence note at the top of src/ar/eighthwall.ts).
  // Native first, where the shell's ScanAR plugin reports that ARKit or ARCore can run. Native
  // being available also skips the wait for the 8th Wall engine: a native phone never needs it
  // unless the native session fails to start, and then createWebRuntimeProvider loads it.
  const nativeProbe = await probeNativeAR()
  nativeActive = nativeProbe !== null && preferNativeRuntime({ forced: forcedMode, nativeSupported: nativeProbe.supported })
  // If the engine never arrives we fall back to WebXR. index.html skips loading
  // xr.js entirely when ?ar=webxr is set. The wait follows xr.js's own state, not
  // a short timer: the page preloads a 5.5 MB `slam` chunk (data-preload-chunks), and
  // a slow phone link can outlast any short timer (see waitForXR8).
  // The desktop app never loads the engine (index.html skips it there, and the desktop
  // bundle leaves it out), so waiting for it would only delay the start screen's upload path.
  // A page that never loads the engine starts, and stays, 'absent'. It is not 'failed': the
  // reason below blames the download for 'failed' and 'timeout' only, and no reload can add
  // an engine the page never requested (see engineExpected). A native phone does not wait either.
  let xr8Load: XR8Load = 'absent'
  if (!nativeActive && engineExpected(forcedMode, isDesktopShell())) {
    overlay.setStatus('Loading AR engine…')
    xr8Load = await waitForXR8(XR8_LOAD_TIMEOUT_MS)
  }
  const xr8Available = xr8Load === 'ready'

  if (nativeActive && nativeProbe) {
    provider = createNativeARProvider({ fallback: createWebRuntimeProvider })
    overlay.setStatus(nativeProbe.engine === 'arcore' ? 'ARCore ready' : 'ARKit ready')
  } else if (xr8Available) {
    try {
      provider = await createEighthWallProvider()
      use8thWall = true
      overlay.setStatus('8th Wall ready')
    } catch (e) {
      console.warn('[main] 8th Wall init failed, falling back to WebXR:', e)
      provider = await createWebXRProvider()
    }
  } else {
    try {
      provider = await createWebXRProvider()
      overlay.setStatus(forcedMode === 'webxr' ? '✓ WebXR ready\n• Native AR session' : '✓ WebXR ready')
    } catch (e) {
      // A load that failed or stalled is not a device that cannot do AR, so it gets
      // its own line with the reload hint. Only "not available" means the device. A page
      // that never loads the engine ('absent': the desktop app, a page forced into WebXR)
      // has no download to blame, so it falls to the WebXR line or the device line, and
      // never to a reload hint.
      const reason = forcedMode === 'webxr'
        ? 'WebXR is not available here'
        : xr8Load === 'timeout'
          ? 'The AR engine did not load in time\n• Reload the page to try again'
          : xr8Load === 'failed'
            ? 'The AR engine did not load\n• Reload the page. If it keeps failing, the server may be down'
            : 'AR not available on this device'
      overlay.setStatus(reason)
      // The reason goes on the start screen too, where the reader is looking. The
      // overlay above sits under it. See showArHelp().
      showArHelp(reason)
      // Arms the section-0 gate to report this instead of dead-ending — see
      // arRuntimeError. Must be set BEFORE the return, because the tap that
      // needs it may still be sitting behind the open Place picker.
      arRuntimeError = reason
      console.error('[main] No AR runtime available:', e)
      return
    }
  }
  // Only offer the WebXR toggle when it would actually work — no point
  // sending desktop/unsupported-browser users to a dead-end landing page.
  //
  // One call, two readers. The preflight probe below wants the same answer, and
  // it wants it for its LIMITS as much as its value: isSessionSupported() is
  // only trustworthy in the negative (see probeVerdict), so asking twice would
  // buy two chances to read it as a green light.
  const immersiveArAdvertised = nativeActive ? false : await isImmersiveARSupported()
  const webxrSupported = use8thWall ? immersiveArAdvertised : true
  if (nativeActive) {
    // The WebXR / 8th Wall switch is a web-only choice. The native runtime has no such switch.
    const modeLink = document.getElementById('xr-mode-link')
    if (modeLink) modeLink.style.display = 'none'
  } else {
    updateXrModeLink(use8thWall, webxrSupported)
  }

  // ── 3b. Preflight — what can this device honestly do, said before the tap ───
  // Section 5 does not run until the user commits to a scan, and the two
  // failures worth naming (no AR service behind the API; an 8th Wall pipeline
  // that reports ready and emits nothing) are only visible after that. What IS
  // knowable now goes on the start screen, beside the cards that are the
  // alternative — including the honest caveat when the only evidence we have
  // is a browser saying "yes" that a Beam Pro also says.
  if (nativeActive) {
    // The native layer answers for AR on this device. The browser probe below would
    // describe the web runtimes, which are only the fallback here.
    setCaptureDevice({ secureContext: window.isSecureContext, nativeAr: 'yes', browserAr: 'no' })
  } else {
    const probeEnv = {
      secureContext: window.isSecureContext,
      xr8Loaded: xr8Available,
      webxrApi: typeof navigator.xr !== 'undefined',
      immersiveArAdvertised,
    }
    const probe = probeVerdict(probeEnv)
    applyPreflightToStartScreen(probe)
    // The same probe, read a second way: the verdict says whether to warn, this
    // says which method to put in front of the person. One `ProbeEnv`, two
    // readers — deviceFromProbe() is where the reading happens, so the rule that
    // an advertised AR session is not a proven one lives in one tested place.
    setCaptureDevice(deviceFromProbe(probeEnv))
  }

  // ── 4. AR Overlay & Capture setup ──────────────────────────────────────────
  keyframes = new KeyframeStreamer(provider, { hold: () => reanchor.recordingHeld, runId: () => store.arRunId })
  const arOverlay = new AROverlay(store, use8thWall, provider)
  const capture = new CaptureModule(provider)
  // The asynchronous hit test serves calibration exactly: WebXR asks its session, and native asks
  // the ARKit / ARCore session (or, after a fallback, the web runtime it handed over to).
  const asyncHitTest = !use8thWall && (provider instanceof WebXRProvider || provider instanceof NativeARProvider)
    ? (x: number, y: number) => (provider as WebXRProvider | NativeARProvider).hitTestAsync(x, y)
    : undefined
  // How a floor tap is read, by the calibration and by the probe taps after it: a burst of hits read as one measurement
  // (src/ar/calibration-taps.ts). `?tap=single` is the one-hit arm DX2 compares it with.
  const tapSampler = calibrationTapSampler({
    provider,
    singleHit: asyncHitTest,
    ground: () => pointCloud.groundEstimate(),
    search: location.search,
  })

  // Shared capture handler used by both the manual button and auto-capture
  async function doCapture() {
    if (captureInFlight) {
      overlay.setStatus('Still processing last capture', 'sticky')
      return
    }
    // Nothing is added to a scan while the choice about its frame is open (src/ar/reanchor-flow.ts).
    if (reanchor.recordingHeld) {
      overlay.setStatus(CAPTURE_HELD_TEXT, 'sticky')
      return
    }

    captureInFlight = true
    setCaptureBusy(true)

    // Read before the frame is requested. Until tracking has started, the pose a
    // frame carries is the identity default, not a position.
    let poseValid = provider.isTracking()
    if (!poseValid) {
      overlay.setStatus('Tracking starting…', 'sticky')
      poseValid = await waitForTracking(provider, TRACKING_WAIT_MS)
    }
    // Neutral until the capture has run. "Saved, not placed" is only true once the frame
    // is stored, so it is set below, after the capture succeeds.
    overlay.setStatus('Capturing…', 'sticky')
    // Named before the try so the catch can reach them: the frame is stored by
    // then, and the failure path's job is to mark that record and decide whether
    // its image is worth holding — not to mourn it.
    let pendingCaptureId: string | null = null
    let frameQuality: Promise<FrameQuality> | null = null
    // The record the frame was stored as. A write made after an analysis await goes ahead
    // only while its id still holds this same record (see isSameRecord). The live session is
    // not checked here: a load of another session leaves this record in the store, and its
    // analysis still has to settle it.
    let storedCapture: CaptureRecord | undefined
    const stillThisCapture = (captureId: string) => isSameRecord(store.getCapture(captureId), storedCapture)
    try {
      const { blob, pose, timestamp, frameWidth, frameHeight } = await capture.capture(CAPTURE_FRAME_TIMEOUT_MS)
      console.log(`[main] Captured blob: ${blob.size} bytes, type=${blob.type}, pose=`, pose)

      // The frustum the photo was taken through. Built here, before inference, from the
      // pose the frame was captured at. The phone keeps moving while the model answers
      // (3–7 s), so a camera built after the answer projects the boxes through the wrong
      // viewpoint, and the markers land off the object they describe.
      let captureCamera: THREE.PerspectiveCamera | undefined
      if (provider.isTracking()) {
        captureCamera = new THREE.PerspectiveCamera(
          provider.getCameraFovY(), provider.getCameraAspect(), 0.01, 1000,
        )
        captureCamera.position.set(pose.position.x, pose.position.y, pose.position.z)
        captureCamera.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
        captureCamera.updateMatrixWorld(true)
      }
      const captureViewport = { width: window.innerWidth, height: window.innerHeight }

      // Store the frame BEFORE anything is asked of it. The photograph is the
      // unrepeatable half of a capture — the user had to be standing there — and
      // inference is the cheap, retryable half. Ordered the other way round, a
      // failed detection took the frame, the pose and the timestamp down with it.
      // See docs/factory/04-capture-path-truthfulness/0003.
      //
      // captureCount advances here rather than after a successful inference, so a
      // capture whose detection fails still owns its index and the next capture
      // cannot collide with it. The count is first brought onto the live session, since
      // an erase leaves none and the capture below starts a new one.
      followCaptureSession()
      const captureIndex = ++captureCount
      pendingCaptureId = store.captureIdFor(captureIndex)
      captureCountSession = store.sessionId
      // Not awaited: the write stays off the shutter's critical path, which
      // already has no flash, haptic or sound to cover latency
      // (../docs/product/UI_MANUAL.md:169-176). It is reconciled before the detections land.
      // `engine: router.path` records which path this capture was actually
      // sent to — wave 05 ticket 0004 provenance — read here rather than
      // after router.infer() resolves so a captured-but-failed-on-device
      // record still says "webgpu" (what was attempted), not "server".
      const capturePersisted = store.putCapture({ captureIndex, timestamp, pose, blob, engine: router.path })
      // putCapture stores the record before its first await, so it is already held here.
      storedCapture = store.getCapture(pendingCaptureId)

      // No live pose, so nothing can be placed. The photo is kept and recorded as
      // not placed, and inference is skipped: its labels could only be shown, never
      // put anywhere. The record says why it has no detections.
      if (!poseValid) {
        await capturePersisted
        if (stillThisCapture(pendingCaptureId)) await store.markCaptureFailed(pendingCaptureId, 'Tracking was not ready, so the photo was not placed')
        overlay.setStatus(UNPLACED_STATUS, 'sticky')
        return
      }

      overlay.setStatus('Analysing…', 'sticky')

      // Show indeterminate analysis progress bar
      const progFill = document.getElementById('progress-bar-fill')
      const progWrap = document.getElementById('progress-bar-wrap')
      if (progFill) progFill.classList.add('analyzing')
      if (progWrap) progWrap.classList.add('visible')

      // Async frame quality analysis (non-blocking — updates overlay on next
      // tick). The promise is kept, not discarded, because the failure path below
      // needs its verdict to decide whether this frame is worth retaining.
      frameQuality = qualityMonitor.analyseFrame(blob)
      const quality = await frameQuality
      updateQualityOverlay(qualityMonitor.tick(provider, pointCloud))
      if (quality.uniformFrame) {
        overlay.setStatus('✕ Camera unavailable\n• Reopen the app, then retry', 'sticky')
        throw new Error('Camera frame is uniform; the live camera feed is not available')
      }
      if (quality.lowLight)   overlay.setStatus('⚠ Low light\n• Add lighting', 'sticky')
      if (quality.reflective) overlay.setStatus('⚠ Reflective surface\n• Shift the angle', 'sticky')

      const rawDets = await router.infer(blob)

      // Hide analysis bar once inference completes
      if (progFill) progFill.classList.remove('analyzing')
      if (progWrap) progWrap.classList.remove('visible')

      overlay.setStatus(`✓ ${rawDets.length} object${rawDets.length === 1 ? '' : 's'} detected`, 'sticky')

      const worldDets = await resolveDetections(rawDets, timestamp, {
        provider,
        asyncHitTest,
        cameraPose: pose,
        captureCamera,
        imageSize: { width: frameWidth, height: frameHeight },
        viewportSize: captureViewport,
        pointCloud,
        sessionId: store.sessionId,
      })
      console.log(`[main] World detections (${worldDets.length}):`, JSON.stringify(worldDets))

      // Tag each resolved detection with the index its frame was stored under
      for (const wd of worldDets) wd.captureIndex = captureIndex

      // Build thumbnail map keyed by label (best-effort). Each object gets the
      // frame cropped to ITS OWN box — handing every row the same whole-frame
      // thumbnail (which is what this did) made the review panel look like a
      // list of duplicate images rather than a list of objects.
      const thumbMap = new Map<string, string>()
      const captureKeys = new Set<string>()
      for (const wd of worldDets) {
        const key = `${wd.label}:${bucket(wd.worldPos)}`
        captureKeys.add(key)
        if (thumbMap.has(key)) continue
        thumbMap.set(key, await capture.captureDetectionThumbnail(blob, wd.bbox))
      }

      // A capture erased while it was being analysed has no record left in the store,
      // and its detections belong to the scan that was erased. A capture from another
      // session (a load happened meanwhile) is not this scan's either. A record that only
      // took its id, since a Clear dropped this one, is not this capture. Do not write any
      // of them into whichever scan is live now.
      const pendingRecord = store.getCapture(pendingCaptureId)
      if (isSameCapture(pendingRecord, storedCapture, store.sessionId)) {
        const merged = mergeDetections(store.currentRunDetections(), worldDets)
        await store.upsert(merged, thumbMap)
      }

      showInferDialog(worldDets)

      // Attach the detections to the record that already holds the frame, so the
      // success path ends with exactly one record per capture rather than two.
      await capturePersisted
      if (stillThisCapture(pendingCaptureId)) await store.attachDetections(pendingCaptureId, [...captureKeys])

      await store.saveSnapshot()
      void checkStorageQuota(store, overlay)
      queueAutoSave()
      const liveCount = store.currentRunDetections().size
      overlay.setStatus(
        `${liveCount} object${liveCount === 1 ? '' : 's'} · ${pointCloud.count} pts`,
        'sticky',
      )
    } catch (e) {
      clearAnalysisProgress()
      // The frame is already stored. Record why its inference failed and keep
      // it — that is what makes a failure cost a label instead of the
      // photograph. Null only when capture.capture() itself threw, in which
      // case there is no frame to keep. Status is set synchronously, so the
      // record is correct before the HUD copy below runs.
      if (pendingCaptureId) {
        const id = pendingCaptureId
        if (stillThisCapture(id)) void store.markCaptureFailed(id, e instanceof Error ? e.message : String(e))
        // Retaining the frame is only worth it when the frame is the good half of
        // the capture. A server or engine error leaves a perfectly readable
        // photograph that re-inference can still use; a frame the quality monitor
        // flagged will read no better on a second pass, so its image goes and only
        // the record stays. This is correlation, not proven cause — a dark frame
        // captured during a server outage is discarded too. That is the intended
        // trade: an unreadable frame is not worth 140 KB of a user's quota.
        if (frameQuality) {
          void frameQuality
            .then((q) => (isFrameUnusable(q) && stillThisCapture(id) ? store.discardFrame(id, 'quality') : undefined))
            .catch(() => { /* frame could not be analysed — doubt keeps the photograph */ })
        }
      }
      if (e instanceof InferServerError) {
        // Server-path inference failures carry a typed code — map each to
        // actionable HUD guidance instead of a generic "failed" message.
        switch (e.code) {
          case 'timeout':
            overlay.setStatus('✕ Server timed out\n• Try again, or move closer', 'sticky')
            break
          case 'network':
            overlay.setStatus(navigator.onLine ? '✕ Server unreachable\n• Check Tailscale is on' : '✕ You are offline\n• Reconnect to continue', 'sticky')
            break
          case 'model-loading':
            overlay.setStatus('⚠ Model warming up\n• Retry in a few seconds', 'sticky')
            break
          case 'model-failed':
          case 'unavailable':
            overlay.setStatus(`✕ Inference unavailable${router.hasWebGPU ? '\n• Try WebGPU in the panel' : ''}`, 'sticky')
            break
          default:
            overlay.setStatus('✕ Capture failed\n• Try again', 'sticky')
        }
      } else if (e instanceof WebGpuInferenceError) {
        // On-device failed. The image was never sent anywhere — see
        // src/inference/router.ts's fallback policy
        // (docs/factory/05-on-device-inference/0004-ungate-toggle-and-fallback-policy.md).
        // This branch exists so the user learns exactly that, instead of a
        // generic "Capture failed" leaving them to guess whether their photo
        // left the device.
        switch (e.code) {
          case 'timeout':
            overlay.setStatus('✕ On-device timed out\n• Try again, or switch to Server', 'sticky')
            break
          case 'not-provisioned':
            overlay.setStatus('✕ Model not downloaded\n• Download it in the panel, or use Server', 'sticky')
            break
          default:
            overlay.setStatus('✕ On-device failed\n• Try again, or switch to Server', 'sticky')
        }
      } else {
        const message = e instanceof Error ? e.message : String(e)
        const name = e instanceof Error ? e.name : ''

        if (name === 'NotAllowedError' || message.includes('NotAllowedError')) {
          overlay.setStatus('✕ Camera access denied\n• Allow it in browser settings', 'sticky')
        } else if (message.includes('Camera frame is uniform')) {
          // Keep the recovery instruction from the frame-validity guard visible;
          // this is a camera lifecycle problem, not an inference failure.
          overlay.setStatus('✕ Camera unavailable\n• Reopen the app, then retry', 'sticky')
        } else if (message.includes('Camera stream stalled')) {
          // WebXRProvider detected the companion getUserMedia stream had frozen
          // (see docs/factory/04-capture-path-truthfulness/0005) and refused to
          // return the stale frame it would otherwise have re-encoded forever.
          // A background re-acquire may already have fixed it by the time this
          // renders — if so the next capture just works — but this message
          // must stay honest for the case where it didn't.
          overlay.setStatus('✕ Camera frozen\n• Restart the scan', 'sticky')
        } else if (message.includes('Tracking lost')) {
          // The provider refused a frame whose pose was too old to say where the camera was
          // (MAX_CAPTURE_POSE_AGE_MS in src/ar/frame-epoch.ts). Nothing was stored.
          overlay.setStatus('✕ Tracking lost\n• Hold still, then tap again', 'sticky')
        } else if (message.includes('Timed out')) {
          // Check if the timeout is actually due to denied camera permission
          let denied = false
          try {
            if (navigator.permissions) {
              const camPerm = await navigator.permissions.query({ name: 'camera' as PermissionName })
              if (camPerm.state === 'denied') denied = true
            }
          } catch { /* permissions API may not support camera query */ }
          overlay.setStatus(denied
            ? '✕ Camera access denied\n• Allow it in browser settings'
            : 'Camera frame timed out — tap once more', 'sticky')
        } else if (name === 'TypeError' || message.includes('NetworkError') || message.includes('Failed to fetch') || message.includes('network')) {
          overlay.setStatus('✕ Needs network\n• Switch to WebGPU in settings', 'sticky')
        } else {
          overlay.setStatus('✕ Capture failed\n• Try again', 'sticky')
        }
      }
      console.error('[capture]', e)
    } finally {
      clearAnalysisProgress()
      overlay.setProgress(null)
      captureInFlight = false
      setCaptureBusy(false)
    }
  }

  /**
   * Export on the user's command, reporting what actually happened.
   *
   * Returns the outcome instead of swallowing it. This used to catch its own
   * errors and return undefined, so SidePanel's `await this.onExport()` never
   * threw and the button read "Exported" for every path through here —
   * cancelled, upload-failed, and export-threw included. Its "Export failed"
   * branch was unreachable code.
   */
  async function exportManualScan(): Promise<{ outcome: ExportOutcome; uploadedFilename?: string }> {
    // A read-only page does not export: the export uploads the scan and records it against its Place,
    // and the writer tab owns both.
    if (readOnlyScanner) {
      showReadOnlyNotice()
      return { outcome: 'cancelled' }
    }
    const summary = currentQualitySummary()
    if (summary.status === 'needs-rescan') {
      const ok = confirm('Scan quality is low. Review recommendations before exporting. Export anyway?')
      if (!ok) {
        overlay.setStatus('⚠ Export cancelled', 'sticky')
        setAutosaveStatus('Export cancelled')
        return { outcome: 'cancelled' }
      }
    }

    setAutosaveStatus('Exporting scan…')
    overlay.setStatus('Exporting scan…')
    try {
      const scanEntry = await ensureSessionScanEntry()
      const result = await exportToGLB(
        { store, pointCloud, poseHistory, scanEntry, geoFix: geoTracker.snapshot() ?? undefined, qualitySummary: currentQualitySummary(), frameEpochs: scanFrameEpochs.snapshot(pointCloud) },
        { download: true, upload: true, filenamePrefix: 'room-scan', autoSaved: false },
      )
      if (result.upload === 'uploaded' && result.uploadedFilename) {
        try {
          await updateSessionScanFilename(result.uploadedFilename)
        } catch (error) {
          // Best-effort Places bookkeeping — must not suppress the
          // export-succeeded outcome below, or a scan that really did upload
          // reports 'failed' and callers skip keyframes.rotate() for it.
          console.error('[export] updateSessionScanFilename failed (non-fatal)', error)
        }
        overlay.setStatus('✓ Scan exported and synced', 'sticky')
        setAutosaveStatus(`Scan exported & synced ✓ ${shortName(result.uploadedFilename)}`)

        // Reveal the "View in 3D" link next to status — only now is there
        // something on the server for that link to open.
        // A Place scan lives in its Place's world. The default world admits only
        // scans with no projectId, so a link to it would show the work as missing.
        const link = document.getElementById('export-view-link') as HTMLAnchorElement | null
        if (link) {
          link.href = scanEntry.projectId
            ? `/viewer.html?project=${encodeURIComponent(scanEntry.projectId)}`
            : '/viewer.html?world=default'
          link.style.display = 'inline-block'
        }
        revealDownloadLink(result.uploadedFilename)
        return { outcome: 'exported', uploadedFilename: result.uploadedFilename }
      }

      if (result.upload === 'queued-offline') {
        // Not a failure: the service worker holds it and replays on reconnect.
        // Calling this "server sync failed" sent people hunting for a problem
        // that did not exist.
        overlay.setStatus('⚠ Saved on this phone\n• Syncs when you are back online', 'sticky')
        setAutosaveStatus('Scan saved — will sync when back online')
        return { outcome: 'queued' }
      }

      // The server refused it. Whether the device kept a copy depends on
      // whether the local download could still run — on a phone it usually
      // could not, and telling someone their scan is "saved locally" when no
      // file exists is worse than telling them it failed.
      const msg = result.savedLocally
        ? 'Scan saved locally — server sync failed'
        : 'Export failed — server rejected it and no local copy was saved'
      overlay.setStatus(msg, 'sticky')
      setAutosaveStatus(msg)
      return { outcome: 'local-only' }
    } catch (error) {
      overlay.setStatus('✕ Export failed\n• Try again', 'sticky')
      setAutosaveStatus('Export failed — try again')
      console.error('[export]', error)
      return { outcome: 'failed' }
    }
  }

  function queueAutoSave(): void {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    setAutosaveStatus('Autosave queued')
    autoSaveTimer = setTimeout(() => {
      void runAutoSave()
    }, 1200)
  }

  /**
   * Runs `fn` while no autosave runs and none starts, then lets one that was asked for meanwhile go. A re-anchor ends the
   * scan through the autosave's own export (src/ar/reanchor-host.ts), and a timer that fired in the middle of it would
   * export the same scan twice, or the next one half-begun.
   */
  async function withoutAutosave<T>(fn: () => Promise<T>): Promise<T> {
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
    autoSaveQueued = false
    while (autoSaveInFlight) await new Promise((resolve) => setTimeout(resolve, 100))
    autoSaveInFlight = true
    try {
      return await fn()
    } finally {
      autoSaveInFlight = false
      if (autoSaveQueued) queueAutoSave()
    }
  }

  async function runAutoSave(): Promise<void> {
    // A scan whose calibration is still running is not saved yet: it would go up with none (src/ar/reanchor-flow.ts).
    if (reanchor.phase === 'calibrating') {
      queueAutoSave()
      return
    }
    if (autoSaveInFlight) {
      autoSaveQueued = true
      return
    }
    autoSaveInFlight = true
    autoSaveQueued = false
    setAutosaveStatus('Saving scan...')
    try {
      await store.saveSnapshot()
      void checkStorageQuota(store, overlay)
      if (pointCloud.count === 0 && store.currentRunDetections().size === 0 && poseHistory.length === 0) {
        setAutosaveStatus('Autosaved locally')
        return
      }
      const result = await exportToGLB(
        { store, pointCloud, poseHistory, scanEntry: await ensureSessionScanEntry(), geoFix: geoTracker.snapshot() ?? undefined, qualitySummary: currentQualitySummary(), frameEpochs: scanFrameEpochs.snapshot(pointCloud) },
        { download: false, upload: true, filenamePrefix: 'autosave-room-scan', autoSaved: true },
      )
      const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      setAutosaveStatus(result.uploadedFilename ? `Autosaved ${shortName(result.uploadedFilename)} · ${time}` : `Autosaved locally · ${time}`)

      // Rotate the keyframe session, exactly as manual export does. Autosave
      // used to neither rotate nor finalize, so one server session accumulated
      // keyframes across every autosaved GLB in the walkthrough and its
      // glbFilename stayed null — leaving `byGlb` nothing to match on and the
      // one-scan-to-one-session assumption false.
      if (result.uploadedFilename) {
        try {
          await updateSessionScanFilename(result.uploadedFilename)
        } catch (error) {
          // Best-effort Places bookkeeping — must not suppress the rotate
          // below, or the exact "glbFilename stayed null" bug this block
          // exists to fix comes back, now gated on an unrelated IndexedDB write.
          console.error('[autosave] updateSessionScanFilename failed (non-fatal)', error)
        }
        lastUploadedFilename = result.uploadedFilename
        currentSessionGlbFilename = result.uploadedFilename
        // Autosaves never trigger a local download, so the server copy is the
        // only copy the user can get at — surface it as soon as one exists.
        revealDownloadLink(result.uploadedFilename)
        if (keyframes?.active) {
          await keyframes.rotate({
            glbFilename: result.uploadedFilename,
            pointCount: pointCloud.count,
            detectionCount: store.currentRunDetections().size,
            poseCount: poseHistory.length,
            qualitySummary: currentQualitySummary(),
          })
        }
      }
    } catch (error) {
      setAutosaveStatus('Autosave failed')
      console.error('[autosave]', error)
    } finally {
      autoSaveInFlight = false
      if (autoSaveQueued) queueAutoSave()
    }
  }

  arOverlay.mount(doCapture)

  // ── Auto-capture ───────────────────────────────────────────────────────────
  const autoCapture = new AutoCapture(provider, doCapture, { hold: () => reanchor.recordingHeld })
  autoCapture.onStatusChange = (status) => {
    const btn = document.getElementById('auto-capture-btn') as HTMLButtonElement | null
    if (!btn) return
    btn.classList.toggle('active', status.enabled)
    btn.title = status.enabled
      ? `Auto-capture ON · ${status.captureCount} captures`
      : 'Enable auto-capture'
    const countEl = document.getElementById('auto-capture-count')
    if (countEl) countEl.textContent = status.enabled ? `${status.captureCount}` : ''
    // Visual: pulse the capture button ring when in-flight
    const captureBtn = document.getElementById('capture-btn')
    if (captureBtn) captureBtn.classList.toggle('auto-busy', status.inFlight)
  }

  const autoCaptureBtn = document.getElementById('auto-capture-btn')
  autoCaptureBtn?.addEventListener('click', () => {
    autoCapture.toggle()
    if (autoCapture.enabled) {
      overlay.setStatus('Auto-capture on\n• Move the camera to scan')
    } else {
      overlay.setStatus(`Auto-capture off\n• ${autoCapture.captureCount} auto captures`)
    }
  })

  // ── Person capture — record a clip of a person for 4D reconstruction ──────
  //
  // A capture *mode*, so it lives on the action rail beside the other toggles
  // rather than in the side panel where server-job triggers live.
  //
  // Deliberately records a raw camera stream rather than the AR canvas: the
  // canvas has the HUD composited into it and is unusable as a reconstruction
  // input. The AR session contributes pose only. See src/capture/clip-recorder.ts.
  let clipRecorder: import('./capture/clip-recorder').ClipRecorder | null = null

  const setPersonCaptureUI = (recording: boolean, label: string) => {
    const btn = document.getElementById('person-capture-btn') as HTMLButtonElement | null
    if (btn) {
      btn.classList.toggle('active', recording)
      btn.title = recording ? `Recording a person · ${label}` : 'Record a person (4D capture)'
    }
    const countEl = document.getElementById('person-capture-count')
    if (countEl) countEl.textContent = recording ? label : ''
  }

  const stopPersonCapture = async () => {
    if (!clipRecorder) return
    const recorder = clipRecorder
    clipRecorder = null
    const clip = await recorder.stop()
    setPersonCaptureUI(false, '')
    if (!clip) {
      overlay.setStatus('✕ Recording was empty\n• Try again')
      return
    }

    const { validateClip } = await import('./capture/clip-validation')
    const { medianSpeedMps } = await import('./capture/pose-track')
    const speed = medianSpeedMps(recorder.poseSamples)
    const verdict = validateClip({
      width: clip.width,
      height: clip.height,
      durationMs: clip.durationMs,
      fps: clip.nominalFps,
      hasArSession: clip.poseTrack.hasArSession,
    }, speed === null ? undefined : { medianSpeedMps: speed })

    if (!verdict.ok) {
      // Say what is actually wrong with this clip, not what the rule is.
      overlay.setStatus(verdict.problems[0].message)
      return
    }

    overlay.setStatus(`Uploading clip · ${(clip.blob.size / 1_000_000).toFixed(1)} MB…`)
    try {
      const { uploadPersonClip } = await import('./capture/clip-upload')
      const result = await uploadPersonClip(clip, {
        projectId: selectedProject?.projectId ?? null,
        areaId: selectedAreaId,
        onProgress: pct => overlay.setStatus(`Uploading clip · ${pct}%`),
      })
      const advisory = verdict.advisories[0]
      overlay.setStatus(
        `Person clip uploaded${result.jobId ? ' — reconstruction queued' : ''}` +
        (advisory ? ` · ${advisory.message}` : ''),
      )
    } catch (err) {
      overlay.setStatus(`✕ Clip upload failed\n• ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // True from the first tap until the camera has opened or failed to. A tap in
  // that window asks for a stop, honoured once it opens. It must not start a
  // second recorder, which is what the null check alone allowed.
  let clipStarting = false
  let clipStopAsked = false
  document.getElementById('person-capture-btn')?.addEventListener('click', () => {
    if (clipStarting) {
      clipStopAsked = true
      return
    }
    if (clipRecorder) {
      void stopPersonCapture()
      return
    }
    clipStarting = true
    clipStopAsked = false
    void (async () => {
      let started = false
      try {
        const { ClipRecorder } = await import('./capture/clip-recorder')
        const recorder = new ClipRecorder(provider)
        recorder.onStatus = (status) => {
          if (status.state === 'starting') {
            overlay.setStatus(status.message)
          } else if (status.state === 'recording') {
            setPersonCaptureUI(true, `${Math.round((status.elapsedMs ?? 0) / 1000)}s`)
          } else if (status.state === 'error') {
            setPersonCaptureUI(false, '')
            overlay.setStatus(status.message)
          }
        }
        // Assigned before the await, so a stop tap can reach it.
        clipRecorder = recorder
        started = await recorder.start()
      } catch (err) {
        console.error('[clip] start failed', err)
      } finally {
        if (!started) clipRecorder = null
        clipStarting = false
      }
      if (!started) return
      if (clipStopAsked) {
        await stopPersonCapture()
        return
      }
      overlay.setStatus('Recording a person\n• Keep the phone upright, move gently')
    })()
  })

  // ── Keyframe streaming — pose-tagged frames to the server during the scan ──
  const kfStreamer = keyframes
  // Sending camera frames needs this device's yes, and nothing else in the scanner does (src/capture/keyframe-consent.ts).
  // A scan in a Place streams by default only once it has been given. It also owns the panel's "Camera frames" row.
  const cameraFrames = mountKeyframeFrames({
    streamer: kfStreamer,
    footer: document.getElementById('panel-footer'),
    readOnly: readOnlyScanner,
    finalizePayload: () => ({
      glbFilename: currentSessionGlbFilename,
      pointCount: pointCloud.count,
      detectionCount: store.currentRunDetections().size,
      poseCount: poseHistory.length,
      qualitySummary: currentQualitySummary(),
    }),
    canStreamNow: () => !document.getElementById('start-screen'),
  })
  kfStreamer.onStatus = (s) => {
    cameraFrames.onStatus(s)
    if (s.active) keyframeCountClosed = false
    if (!keyframeCountClosed) latestKeyframeCount = s.sent
    const btn = document.getElementById('stream-btn') as HTMLButtonElement | null
    if (!btn) return
    btn.classList.toggle('active', s.active)
    btn.title = s.active
      ? `Streaming keyframes · ${s.sent} sent${s.offline ? ' · OFFLINE' : ''}`
      : 'Stream keyframes to server'
    const countEl = document.getElementById('stream-count')
    if (countEl) countEl.textContent = s.active ? `${s.sent}` : ''
  }

  // The server session is the only id that names a real keyframe directory, so
  // the store adopts it the moment one is opened; everything exported from here
  // on records that id rather than a local one.
  //
  // `null` (the session closed) is deliberately a no-op: the captures already
  // in the store came from that session, and its directory still holds their
  // keyframes, so reverting to a local id would strand the association. See
  // KeyframeStreamer.onSessionId.
  kfStreamer.onSessionId = (sessionId) => {
    if (sessionId) {
      cameraFrames.noteSession(sessionId)
      void store.adoptServerSession(sessionId).then((adopted) => {
        // A refused adoption leaves the store on its old id, so the count and the session stay as they were.
        if (!adopted) return
        // The scan so far now belongs to this session. The count only rises here, to what
        // the session holds, so it never drops below the captures already taken.
        captureCount = Math.max(captureCount, highestCaptureIndex(store.captures.values(), store.sessionId))
        captureCountSession = store.sessionId
      }, (err: unknown) => {
        // The store has already taken the server id, so the scan carries on under it. The
        // failure is logged, and nothing else waits on the adoption.
        console.error('[main] could not finish adopting the server session; the scan carries on under it:', err)
      })
      // A fresh session has produced no GLB of its own yet. Clearing this
      // here — rather than leaving the previous session's value in place —
      // is what stops a later stream-toggle-off or pagehide on THIS session
      // from misattributing a scan it had nothing to do with.
      currentSessionGlbFilename = undefined
    }
  }

  // A tap during a start or stop is ignored until that settles. `active` reads false while
  // a stop is still closing the session, so on its own it let a tap open a second session.
  // The busy flag covers this toggle's own transitions. isTransitioning covers the ones
  // started elsewhere (export rotate, scan reset) too. The button's disabled state is not
  // touched here: disableCaptureControls() owns it when AR fails.
  let streamToggleBusy = false
  const settleStreamToggle = () => {
    streamToggleBusy = false
  }
  document.getElementById('stream-btn')?.addEventListener('click', () => {
    if (streamToggleBusy || kfStreamer.isTransitioning) return
    streamToggleBusy = true
    // settleStreamToggle() clears the flag once a transition is running. Until one is,
    // nothing else does, so a throw on the way in (from currentQualitySummary(), say)
    // must clear it here, or every later tap is ignored.
    let transitionStarted = false
    try {
      if (kfStreamer.active) {
        void kfStreamer.stop({
          glbFilename: currentSessionGlbFilename,
          pointCount: pointCloud.count,
          detectionCount: store.currentRunDetections().size,
          poseCount: poseHistory.length,
          qualitySummary: currentQualitySummary(),
        }).finally(settleStreamToggle)
        transitionStarted = true
        overlay.setStatus('Streaming off')
      } else {
        // A tap that would start sending asks first when this device has not agreed. A tap that stops never does.
        cameraFrames.requestStart(() => kfStreamer.start())
          .then((started) => { if (started) overlay.setStatus('✓ Streaming on\n• Walk the room') })
          .catch((e) => {
            overlay.setStatus('✕ Streaming failed\n• Is the server up?')
            console.warn('[keyframes]', e)
          })
          .finally(settleStreamToggle)
        transitionStarted = true
      }
    } finally {
      if (!transitionStarted) settleStreamToggle()
    }
  })

  // ── 4b. Onboarding overlay — show once on first visit ────────────────────────
  const ONBOARD_KEY = ONBOARDING_KEY

  // Shell sign-in: the browser sheet hands the app back here. Outside a shell this does nothing.
  void initShellSignIn((signedIn) => {
    void renderFtueStatus(document.getElementById('ftue-status'), fetch, signedIn ? undefined : SIGN_IN_FAILED)
  })

  function runOnboarding(_isReplay = false): Promise<void> {
    return new Promise<void>((resolve) => {
      const ob = document.getElementById('onboarding-overlay')
      if (!ob) { resolve(); return }
      ob.classList.add('visible')
      // Setup rows for the second step. Not awaited: the overlay never waits on the
      // server. A failed read says so in the rows.
      void renderFtueStatus(document.getElementById('ftue-status'))

      const steps = ob.querySelectorAll<HTMLElement>('.onboard-step')
      const dots = ob.querySelectorAll<HTMLElement>('.onboard-dot')
      const nextBtn = document.getElementById('onboard-next-btn') as HTMLButtonElement
      const skipBtn = document.getElementById('onboard-skip') as HTMLButtonElement
      let current = 0

      function goToStep(n: number) {
        steps.forEach((s, i) => s.classList.toggle('active', i === n))
        dots.forEach((d, i) => d.classList.toggle('active', i === n))
        nextBtn.textContent = n === steps.length - 1 ? 'Get Started' : 'Next'
        current = n
      }

      goToStep(0)
      // The overlay is modal: move focus into it, so a keyboard or screen-reader
      // user starts on its button rather than wherever focus was before it opened.
      nextBtn.focus()

      function cleanupAndFinish() {
        localStorage.setItem(ONBOARD_KEY, '1')
        ob!.classList.remove('visible')
        // Clean up listeners by cloning the buttons to discard dynamic event listeners
        const newNextBtn = nextBtn.cloneNode(true)
        const newSkipBtn = skipBtn.cloneNode(true)
        nextBtn.parentNode?.replaceChild(newNextBtn, nextBtn)
        skipBtn.parentNode?.replaceChild(newSkipBtn, skipBtn)
        resolve()
      }

      nextBtn.addEventListener('click', () => {
        if (current < steps.length - 1) {
          goToStep(current + 1)
        } else {
          cleanupAndFinish()
        }
      })
      skipBtn.addEventListener('click', cleanupAndFinish)
    })
  }

  if (!skipOnboarding && !localStorage.getItem(ONBOARD_KEY)) {
    await runOnboarding(false)
  }

  // Show help button during scanning; re-show onboarding on tap
  const helpBtn = document.getElementById('help-btn')
  if (helpBtn) {
    helpBtn.classList.add('visible')
    helpBtn.addEventListener('click', () => {
      void runOnboarding(true)
    })
  }

  // Details button opens side panel and scrolls to export section
  const finishScanBtn = document.getElementById('finish-scan-btn')
  if (finishScanBtn) {
    finishScanBtn.addEventListener('click', () => {
      panel.setOpen(true)
      const footer = document.getElementById('panel-footer')
      if (footer) {
        footer.scrollIntoView({ behavior: 'smooth' })
      }
    })
  }

  // Best-effort teardown when the tab goes away. pagehide is the only
  // teardown event that fires reliably on iOS Safari (beforeunload does not) —
  // stop streams and finalize the keyframe session, fire-and-forget.
  //
  // The broadcaster is only constructed further down (after the AR provider has
  // started), so it is reached through this nullable ref rather than the `const`
  // binding: the handler is armed here, but a pagehide during onboarding or while
  // the camera permission prompt is up would otherwise hit the const's temporal
  // dead zone and abort the whole teardown — losing the keyframe-session finalize.
  let rtc: RtcBroadcaster | null = null

  // Each step is isolated: a teardown is best-effort, so one failing resource
  // must not skip the ones after it (finalizing the session matters most).
  window.addEventListener('pagehide', () => {
    try { if (rtc?.isRunning) rtc.stop() } catch (e) { console.warn('[teardown] rtc', e) }
    try { if (autoCapture.enabled) autoCapture.disable() } catch (e) { console.warn('[teardown] autoCapture', e) }
    try {
      if (kfStreamer.active) {
        void kfStreamer.stop({
          glbFilename: currentSessionGlbFilename,
          pointCount: pointCloud.count,
          detectionCount: store.currentRunDetections().size,
          poseCount: poseHistory.length,
          qualitySummary: currentQualitySummary(),
        })
      }
    } catch (e) { console.warn('[teardown] keyframes', e) }
  })

  // Confirmation guards when navigating away from an active scan session
  function hasUnsavedData(): boolean {
    return pointCloud.count > 0 || store.currentRunDetections().size > 0 || poseHistory.length > 0
  }

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedData()) {
      e.preventDefault()
      e.returnValue = 'Leave scan? Unsaved progress will be lost.'
      return 'Leave scan? Unsaved progress will be lost.'
    }
  })

  // Guard action rail navigation links
  const navLinks = ['xr-mode-link', 'viewer-link']
  navLinks.forEach((id) => {
    const link = document.getElementById(id)
    if (link) {
      link.addEventListener('click', (e) => {
        if (hasUnsavedData()) {
          const ok = confirm('Leave scan? Unsaved progress will be lost.')
          if (!ok) {
            e.preventDefault()
          }
        }
      })
    }
  })

  // Expose test hooks for E2E validation
  if (typeof (window as any).__playwright_hooks === 'undefined') {
    (window as any).__playwright_hooks = {
      simulateScanData: () => {
        poseHistory.push({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
      },
      clearScanData: () => {
        poseHistory.length = 0
      }
    }
  }

  // ── 5. Start AR — the section-0 gesture gate resolves when the user taps ─────
  // The listener lives at the top of main() (see there for why); all that is
  // left here is to prompt, if they haven't already tapped, and wait.
  if (!startPressed) overlay.setStatus('Press Start AR to begin')
  await startArPressed

  overlay.setStatus('Starting AR…')
  // Registered BEFORE start(), because start() is what arms the timer that
  // produces the verdict. Optional on the interface: only 8th Wall has the
  // signal (a WebXR runtime with no backing AR service rejects requestSession()
  // instead, which the catch below classifies).
  provider.onPreflightVerdict?.((verdict) => applyPreflightVerdict(verdict, overlay))
  // Also before start(): the log must hear every discontinuity from the first frame on.
  scanFrameEpochs.attach(provider)
  reanchor.attach(provider)
  try {
    await provider.start(canvas)
  } catch (e) {
    console.error('[main] AR provider start failed:', e)
    // Report what actually failed. This used to blame camera permission for
    // *every* start() rejection, which sent users to check settings that were
    // already correct — a `window.THREE does not exist` regression in the 8th
    // Wall provider was reported for weeks as "Camera access denied", and the
    // real error was only visible in the console. A permission claim has to be
    // backed by a permission error (ADR 0005 rule 3, applied to failure copy).
    // Echoing `message` handed the reader the runtime's own sentence — "The
    // specified session configuration is not supported" — which names no
    // consequence and no next step. The raw string stays in the console.error
    // above, where it is still the thing worth reporting a bug with.
    //
    // The classification lives in startFailureVerdict() (src/ar/preflight.ts)
    // so it is testable, and so the NotSupportedError case — a device whose AR
    // API is present with no service behind it, which no amount of retrying or
    // permission-checking will fix — gets its own sentence instead of the
    // generic one it used to share.
    const verdict = startFailureVerdict(e)
    // The start screen is still standing on this path, and it is what the
    // reader is looking at: #permission-error-banner lives inside #ar-overlay
    // (z-index 10), which paints *under* #start-screen (z-index 20). So say it
    // on the start screen — on the button that was tapped, and in #ar-help,
    // the line already reserved there for "why AR isn't happening" — right
    // beside the cards the verdict's next step describes. It describes them
    // rather than naming them, because renderCaptureChoice() writes those
    // labels per subject and preflight.ts has no subject. The banner is still
    // written for the case where the start screen is already gone.
    setStartButtonState('unavailable', verdict.headline)
    const arHelp = document.getElementById('ar-help')
    if (arHelp) {
      arHelp.textContent = verdict.detail
      arHelp.hidden = false
    }
    showPermissionBanner(verdict.detail, verdict.headline)
    // Caught live 2026-08-26 on an XREAL companion device: navigator.xr
    // reported immersive-ar supported, but requestSession() rejected with
    // "The specified session configuration is not supported" because the
    // device has no ARCore installed — isSessionSupported() answers whether
    // the API exists, not whether a backing AR service does. The banner above
    // was already correct and visible, but capture-btn/stream-btn/
    // auto-capture-btn/person-capture-btn are wired in section 4, before this
    // catch can run, and stayed fully interactive. Tapping "Stream keyframes"
    // called kfStreamer.start(), which opens a real server session and flips
    // the status to "Streaming keyframes — walk the room" — a confident,
    // active-looking UI backed by a scanner.start() that section 6 below never
    // reaches, so the session sits open forever with keyframeCount: 0. No
    // frame will ever arrive to correct that status text.
    disableCaptureControls('AR did not start — live capture is unavailable')
    overlay.setStatus(verdict.headline)
    return
  }
  // This page's SLAM frame begins here. Everything the store saves from now on carries this run's id, and
  // what it held before (a resumed session, a loaded one) is another run's: stored, not shown, not exported.
  store.startArRun()
  // Only now is the start screen no longer the user's way out: AR is running,
  // so the live camera behind it is the thing to look at. A spec asserts this
  // (tests/mock-ftue.spec.ts expects #start-screen gone once scanning begins).
  document.getElementById('start-screen')?.remove()
  // AR is live, so keep the screen up. Without this an unattended capture —
  // the gimbal-driven dome scan is the whole reason this exists — dies at the
  // phone's screen timeout: Chrome backgrounds, visibilityState flips to
  // 'hidden', and KeyframeStreamer._tick() bails, leaving the session open and
  // the HUD still claiming it is streaming. Measured: 0 frames across 10
  // converged gimbal positions.
  void screenWakeLock.start()
  // ── 6. Continuous SLAM point-cloud accumulation ──────────────────────────────
  // Started BEFORE calibration, not after. The calibration flow's
  // environment-scan step gates anchor placement on a settled ground-plane
  // estimate, and that estimate is derived from the points this loop feeds into
  // PointCloud — the only caller of pointCloud.add() in the app. With the
  // scanner starting afterwards, groundEstimate() was null for the whole of
  // calibration and the gate could never fire. Sweeping the floor during the
  // readiness step is real scanning, in the same AR session frame, so the
  // points it collects belong in the scan anyway.
  scanner.start(provider, (frame) => {
    // Only record geometry while the runtime says its own tracking is good.
    //
    // This used to be unconditional, while the pose history one line below was
    // already gated — so a session that degraded to LIMITED stopped recording
    // poses but kept pouring points into the cloud from a frame that had
    // drifted. Measured on one gimbal dome of a single room: 80.7% of points
    // within 3m of the median centre, yet a total extent of 60.9 x 39.0 x 48.7m.
    // The debris is what sets the bounding box, so every downstream metric fit
    // inherits a scale that is wrong by an order of magnitude.
    //
    // `provider.isTracking()` cannot express this (it latches on first pose);
    // `trackingStatus()` is the runtime's own live signal. Fails open, so a
    // runtime that reports UNKNOWN (WebXR does, until its first frame) is unaffected.
    const trackingUsable = trackingIsUsable(provider.trackingStatus())
    // Each point goes in under the epoch it was read in, so a point from before a frame
    // shift and one from after it are never taken for one frame's geometry.
    // Nothing is recorded while the choice about the scan's frame is open (src/ar/reanchor-flow.ts).
    const held = reanchor.recordingHeld
    const inserted = trackingUsable && !held ? pointCloud.add(frame.points, frame.epoch) : []
    const added = inserted.length
    // A console warning is invisible to someone walking their kitchen. The only
    // on-screen tell that recording had stopped was the #scan-stats counter no
    // longer climbing, in 11px type, while #status-text still read "Tracking".
    // updateVerdictUI() below turns this into the #verdict-hint line, on this
    // same tick — and clears it again on the tick tracking recovers.
    if (recordingPaused !== !trackingUsable) {
      recordingPaused = !trackingUsable
      console.warn(recordingPaused
        ? `[scan] tracking degraded (${provider.trackingStatus()}) — not recording points until it recovers`
        : '[scan] tracking recovered — recording points again')
    }
    if (provider.isTracking() && poseIsFinite(frame.pose) && !held) poseHistory.push(frame.pose)

    // Live geometry is available only when the experimental flag is enabled.
    rtc?.sendPoints(inserted)
    rtc?.sendJson({
      t: 'pose',
      p: [frame.pose.position.x, frame.pose.position.y, frame.pose.position.z],
      q: [frame.pose.rotation.x, frame.pose.rotation.y, frame.pose.rotation.z, frame.pose.rotation.w],
    })

    if (added > 0) {
      const statsEl = document.getElementById('scan-stats')
      if (statsEl) statsEl.textContent = `${pointCloud.count} pts`
      // First points arriving means SLAM has locked — update status once
      if (pointCloud.count === added) {
        // Just "Tracking". #status-row is ~211px on a 375px viewport, which
        // fits about 25 characters — "Tracking — tap to capture" wrapped to a
        // second line with "capture" dangling under the SPARSE chip. The
        // instruction was redundant anyway: the capture button is on screen,
        // 78px across, directly below this panel.
        overlay.setStatus('Tracking')
      }
    }
    // One-time notice when the voxel grid starts dropping points to cap memory
    if (!decimationNoticeShown && pointCloud.decimations > 0) {
      decimationNoticeShown = true
      overlay.setStatus('⚠ Point cloud thinned\n• To save memory')
    }
    updatePoseReadout(frame.pose, provider.isTracking())

    // Update quality overlay on every scanner tick.
    //
    // The tracking-lost / moving-too-fast sentences used to be written to
    // #status-text from right here, on every one of these 750 ms ticks, which
    // erased whatever the capture path had just reported. They are motion
    // state, not events, so they now render beside the drift badge that
    // already summarises them — see updateQualityOverlay().
    const snap = qualityMonitor.tick(provider, pointCloud)
    updateQualityOverlay(snap)
    updateVerdictUI()

    // Sample how much light the camera is getting, on a live frame rather than
    // a captured one. This is the whole fix for the 19:40 dark-room session:
    // qualityMonitor.analyseFrame() only ever runs on a CAPTURED frame, and in
    // a room too dark to track, tracking never acquires, so nothing is captured
    // and luminance is never measured — the one number that explained the black
    // screen was the one nothing computed. The result lands in _lastLighting
    // and is read by the NEXT tick's snapshot; nothing here awaits it.
    if (++lightSampleTick % LIGHT_SAMPLE_EVERY_TICKS === 0) {
      void qualityMonitor.sampleLighting(cameraLightSource())
    }
  })
  console.log('[main] Room scanner started')

  overlay.setStatus('Calibrate the project frame…')

  /**
   * A calibration the page no longer holds takes down what it showed: the frame-heading needle and label, and what the
   * modal drew into the scene for it (the origin, the stored origin, the check point's marker, the stored points' rings).
   * Called wherever `sessionCalibration` is dropped (a Place frame that lost a conflict, a re-anchor beginning a scan
   * that has none) and by a calibration flow that ends with none.
   *
   * The floor grid is the ground the scan keeps (owner R10), and a commit replaces it by name, so it goes with the scan
   * and not with the calibration. `floor: true` where there is no scan for it to be kept for: a re-anchor begins one in
   * another frame, and the old grid stands at coordinates the shift moved; a flow that ends with no calibration is a skip,
   * and ticket 0001 says a skip leaves no floor plane (DEVICE_TESTING O9). `floor: false` where the scan is the same one,
   * in the frame it was: a Place frame that lost a conflict.
   */
  function dropCalibrationDrawings(options: { floor: boolean }): void {
    setFrameHeadingNeedle(null)
    withdrawCalibrationDrawings(provider.getScene?.() ?? null, options)
  }

  // The Place calibration: for this scan now, and for the one a re-anchor begins after a frame shift
  // (src/ar/reanchor-flow.ts). Resolves true when it made a calibration.
  async function calibrateScan(): Promise<boolean> {
    if (!selectedProject) return false
    // Read before the calibration flow, so the unit stamped on it can say whether a point was measured
    // before the scale was ready (see engine-config.ts). Read for each flow, not once.
    const calibrationStartedAt = performance.now()
    // A frame this phone saved offline is being sent as the page starts: the Place is calibrated against what the server holds.
    await whenFramesSettled(projectStore)
    // The frame the Place is calibrated in is the one the provider is in as the flow begins,
    // so a shift while it runs counts against it. A Clear keeps the calibration, and the log
    // keeps this epoch with it (ScanFrameEpochLog.noteCalibrated).
    const calibrationEpoch = scanFrameEpochs.currentEpoch
    const calibration = await runProjectCalibration({
      provider,
      canvas,
      hitTest: async (x, y) => asyncHitTest
        ? await asyncHitTest(x, y)
        : provider.hitTest(x, y),
      sampleTap: tapSampler,
      // The compass alone: reading it through snapshot() lost it whenever the GPS fix was missing. Paired with the
      // camera's pose: the bearing the camera faces (see GeoTracker.pairedCompass), or null when there is none to give.
      bearing: () => geoTracker.pairedCompass(provider.getPose().rotation)?.bearingDeg ?? null,
      // Read fresh each poll — the scanner is accumulating points concurrently,
      // so this is exactly the value that changes while the modal is open.
      // Passed through whole, not narrowed to { y, locked }: 0008 added
      // inlierCount / residualM / fallback precisely so a wrong floor could be
      // diagnosed instead of guessed at, and narrowing here is what kept them
      // off the screen where the only person who can see the real floor is
      // standing.
      ground: () => pointCloud.groundEstimate(),
      // Reference photos (ticket 0007) reuse the existing capture path rather
      // than adding a second encoder: same RGBA -> ImageBitmap -> OffscreenCanvas
      // -> JPEG chain, same size caps. A rejection here ("Capture already
      // pending", a timeout, a denied frame) is a failed photo, never a failed
      // calibration - the flow treats a null the same way.
      capturePhoto: async () => {
        const frame = await capture.capture(CAPTURE_FRAME_TIMEOUT_MS)
        const thumbDataUrl = await capture.captureThumbnail(frame.blob).catch(() => '')
        return {
          blob: frame.blob,
          thumbDataUrl,
          pose: frame.pose,
          frameSize: { width: frame.frameWidth, height: frame.frameHeight },
        }
      },
      // Local blob first, server copy second. That order is what makes the aid
      // work offline on the device that took it, while still working at all on
      // a second device - which is the scenario the server copy exists for.
      loadReferencePhoto: async (photo) => {
        const local = await projectStore.getReferencePhoto(photo.localKey).catch(() => null)
        if (local?.blob) return URL.createObjectURL(local.blob)
        if (!photo.url) return null
        const res = await fetch(apiUrl(photo.url)).catch(() => null)
        if (!res?.ok) return null
        return URL.createObjectURL(await res.blob())
      },
      // The Place's reference (WP-08): which Place is selected now, how to open the picker for "Wrong Place? Choose
      // another", and what to wait for before the modal runs again. See ./ar/calibration-run.
      exits: {
        selected: () => selectedProject,
        choosePlace: () => openPlacePickerAndWait(requestPlaceSelection),
        settle: () => whenFramesSettled(projectStore),
      },
    })
    if (calibration) {
      // The unit this session ran in is written onto the calibration here, once, so the scan record, the
      // upload sidecar and the manifest all carry it. See engine-config.ts.
      sessionCalibration = stampScale(calibration.calibration, provider, calibrationStartedAt)
      scanFrameEpochs.noteCalibrated(calibrationEpoch)
      setFrameHeadingNeedle(calibration.originBearingDeg ?? null)
      // `spatialFrame` means "the Place's durable frame CHANGED and must be
      // persisted" — a first calibration, an upgrade from the one-point tier,
      // or a deliberate override after a mismatch. Ticket 0004 widened this
      // from #141's narrower "first calibration ever", so do not read its
      // presence as a first-visit signal. A commit whose floor check was
      // bypassed returns none, whichever of those it is (`mayWritePlaceFrame`).
      //
      // It is deliberately absent when a stored two-point frame was merely
      // *verified*: that frame is the reference the measurement was taken
      // against, and rewriting it every visit would let it drift session by
      // session — the exact failure the separation check exists to catch.
      let frameSync: FrameSyncOutcome | null = null
      if (calibration.spatialFrame) {
        // The frame is written down first and then sent, and no step stops the ones after it
        // (src/project/frame-sync.ts). Photos accompany a *changed* frame only: their records are on the
        // frame as it is sent, and the photos themselves are uploaded once the server holds it.
        frameSync = await persistProjectSpatialFrame(projectStore, selectedProject, calibration.spatialFrame, {
          photos: calibration.referencePhotos,
          // A frame that replaces one the Place holds says which, and why (WP-08).
          replaces: calibration.replaces,
        })
      }
      // The outcome is what the person needs once the modal closes, and the
      // tracking prompt below is written in this same synchronous run. At the
      // default priority that write replaced this one before it was painted, so
      // the outcome is 'sticky': it holds the line for STATUS_HOLD_MS and the
      // prompt is dropped inside that window. What each outcome says, and why the
      // two-point one reports a distance and not an alignment, is in
      // ./ar/alignment-status.ts.
      overlay.setStatus(alignmentStatusText(sessionCalibration), 'sticky')
      showFrameSyncNote(statusNode, frameSync)
    } else {
      // Continued without a frame: the same reason to hold it. And no frame, so nothing drawn for one: what an earlier
      // calibration of this page left in the scene and on the HUD is not this scan's, the floor grid included.
      overlay.setStatus(alignmentStatusText(null), 'sticky')
      dropCalibrationDrawings({ floor: true })
    }
    return !!calibration
  }
  await calibrateScan()
  reanchor.arm()

  // ?debug=probe: one '[probe]' line per tap from here on, over the ?debug=remote relay. Armed after the calibration
  // step, so a tap logged here is a point the frame was not built from. Inert without the flag (./capture/probe-log).
  installProbeLog({
    canvas,
    provider,
    runtime: probeRuntimeLabel(provider, use8thWall),
    hitTest: async (x, y) => asyncHitTest ? await asyncHitTest(x, y) : provider.hitTest(x, y),
    calibration: () => sessionCalibration,
    bearing: () => geoTracker.pairedCompass(provider.getPose().rotation)?.bearingDeg ?? null,
    compassSample: () => geoTracker.lastCompassSample,
    firstPose: () => poseHistory[0],
    // Read the way the calibration's taps were, so a probe is judged by the tap that built the frame (and says how it was read),
    // with the two limits lifted: the line keeps a tap beyond them and says what they would have said.
    sample: probeTapReader(tapSampler),
  })

  overlay.setStatus('Move the camera to start tracking…')

  // A scan in a Place streams camera frames by default (D15), but only on a device that has agreed to it.
  cameraFrames.autoStart(selectedProject !== null)

  // ── WebRTC live-feed broadcaster (experimental, opt-in) ──────────────────
  // The live-feed room is a rendezvous key, and both halves have to name it
  // the same way or they never meet. The editor uses the world it is viewing
  // (viewer.ts: `query.get('world') || 'default'`) while this side was
  // hardcoded to 'default', so opening any share link for a non-default world
  // left the editor on "Waiting for phone…" forever with no error.
  //
  // Not the same thing as where scans land: uploads are parked in the default
  // world on purpose (ADR 0003, "these have no world association"), which is
  // why the "View in 3D" links still point there.
  if (WEBRTC_LIVE_ENABLED) {
    const { RtcBroadcaster } = await import('./rtc/broadcaster')
    const liveFeedRoom = searchParams.get('world') || 'default'
    const broadcaster = new RtcBroadcaster(liveFeedRoom)
    rtc = broadcaster   // hand it to the pagehide teardown armed above
    broadcaster.onStatus = ({ state, message }) => {
      const btn = document.getElementById('rtc-stream-btn') as HTMLButtonElement | null
      if (btn) {
        // Only show the badge while actively streaming
        btn.style.display = state === 'streaming' ? 'flex' : 'none'
      }
      if (state === 'error') overlay.setStatus(`✕ Live sharing error\n• ${message}`)
    }
    const streamBtn = document.getElementById('rtc-stream-btn') as HTMLButtonElement | null
    streamBtn?.addEventListener('click', () => {
      // Clicking the LIVE badge stops the stream
      broadcaster.stop()
    })

    // Wire the panel "Start Live Stream" button.
    panel.streamButton?.addEventListener('click', () => {
      if (broadcaster.isRunning) {
        broadcaster.stop()
        panel.streamButton!.innerHTML = iconLabel('broadcast', 'Start Live Stream', { size: '15px' })
      } else {
        void broadcaster.start(canvas)
        panel.streamButton!.innerHTML = iconLabel('broadcast', 'Stop Stream', { size: '15px' })
      }
    })

    // Mirror detection updates to the desktop viewer over the RTC data channel.
    // Snapshots are small (<= 50 objects), so a throttled full sync is simpler
    // and more robust than per-mutation deltas.
    let detSyncTimer: ReturnType<typeof setTimeout> | null = null
    store.subscribe(() => {
      if (detSyncTimer) return
      detSyncTimer = setTimeout(() => {
        detSyncTimer = null
        broadcaster.sendJson({
          t: 'dets',
          items: [...store.currentRunDetections().values()].map((d) => ({
            label: d.label,
            confidence: d.confidence,
            pos: [d.worldPos.x, d.worldPos.y, d.worldPos.z],
          })),
        })
      }, 1000)
    })
  }

  overlay.setProgress(null)


  /**
   * Live camera pose plus drift from the session's first tracked pose, for the
   * room-loop benchmark in ../docs/testing/DEVICE_TESTING.md.
   *
   * No-op unless armed with ?debug=pose, so ordinary sessions are untouched.
   * The reference is captured from the first *tracked, finite* pose rather than
   * whatever the provider reports at t=0 — before SLAM locks, the pose is
   * typically origin-or-garbage, and anchoring the reference there would make
   * every subsequent reading an offset from a fiction.
   */
  function updatePoseReadout(pose: Pose, tracking: boolean): void {
    if (!poseReadoutArmed) return
    const el = document.getElementById('pose-readout')
    if (!el) return

    if (!tracking || !poseIsFinite(pose)) {
      el.style.display = 'block'
      el.textContent = 'pose: waiting for tracking'
      return
    }
    if (!poseReference) poseReference = { position: { ...pose.position }, rotation: { ...pose.rotation } }

    const delta = poseDelta(poseReference, pose)
    const { x, y, z } = pose.position
    el.style.display = 'block'
    el.textContent =
      `pos ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)}\n${formatPoseDelta(delta)}`
    // The compass spin test: turn on the spot and read which of B+yaw and B-yaw holds still. The compass is the
    // bearing the calibration is given, and `via` says how it was paired with this pose.
    const paired = geoTracker.pairedCompass(pose.rotation)
    const via = paired?.via ?? (geoTracker.compassReading ? 'withheld' : null)
    el.textContent +=
      `\n${formatCompassSpin(compassSpinTerms(paired?.bearingDeg ?? null, pose.rotation), bearingConventionFromSearch(location.search), via)}`
  }

  /**
   * `detectionCount` defaults to the live store. A scan reset passes the count it read
   * before the store was emptied, because by then the store no longer holds that scan.
   */
  function currentQualitySummary(detectionCount: number = store.currentRunDetections().size) {
    return qualityMonitor.summary({
      pointCount: pointCloud.count,
      detectionCount,
      poseCount: poseHistory.length,
      keyframeCount: latestKeyframeCount,
      // Said only while frames are going out. A scan on a phone that is not sending them is not a poorer scan.
      keyframesOn: keyframes?.active === true,
      // Less the interruptions after which nothing was recorded: a scan ended at one holds no geometry from after it.
      frameShifts: scanFrameEpochs.frameShifts - reanchor.heldShifts,
      limitedMs: scanFrameEpochs.limitedMs,
      closureExceeded: scanFrameEpochs.closureExceeded,
    })
  }

  async function ensureSessionScanEntry(): Promise<ScanEntry> {
    if (sessionScanEntry) {
      // An entry made before the calibration finished (an export under its card) takes the calibration now (src/ar/reanchor-host.ts).
      if (carryCalibration(sessionScanEntry, sessionCalibration)) {
        await projectStore.updateScan(sessionScanEntry).catch((error: unknown) => {
          console.warn('[scan] the Place entry could not be saved with the calibration (the export still carries it):', error)
        })
      }
      return sessionScanEntry
    }
    sessionScanEntry = await projectStore.addScan({
      projectId: selectedProject?.projectId ?? null,
      areaId: selectedAreaId,
      sessionId: store.sessionId,
      name: selectedProject ? `${selectedProject.name} scan` : 'Unassigned scan',
      status: 'draft',
      capturedAt: Date.now(),
      qualitySummary: entryQualitySummary(),
      calibration: sessionCalibration,
    })
    return sessionScanEntry
  }

  async function updateSessionScanFilename(filename: string): Promise<void> {
    if (!sessionScanEntry) return
    sessionScanEntry.scanFilename = filename
    sessionScanEntry.qualitySummary = entryQualitySummary()
    sessionScanEntry.status = 'ready'
    await projectStore.updateScan(sessionScanEntry)
  }

  function entryQualitySummary(): ScanEntry['qualitySummary'] {
    const summary = currentQualitySummary()
    return {
      coverageScore: summary.coverageScore,
      lowLightFrames: summary.lowLightFrames,
      driftEvents: summary.driftEvents,
      reflectiveWarnings: summary.reflectiveWarnings,
      pointCount: summary.pointCount,
    }
  }

  function updateVerdictUI(): void {
    // A scan whose recording is held (src/ar/reanchor-flow.ts) is not ready whatever it holds so far, and the hint says why.
    const heldHint = reanchor.heldHint
    const base = currentQualitySummary()
    const summary = { ...base, status: displayedStatus(base.status, heldHint !== null) }
    // Suppressed recording outranks any quality recommendation: the
    // recommendations advise on a scan that is still being captured, and this
    // says it is not being captured at all. Named in what the person can act on
    // — not the tracking enum, which means nothing to someone in their kitchen.
    const hintText = heldHint ?? (recordingPaused
      ? '⚠ Not recording\n• Move slowly, aim at detail'
      : summary.status !== 'ready' && summary.recommendations.length > 0
        ? `⚠ ${summary.recommendations[0]}`
        : '')

    // Runs on every 750 ms scanner tick, and both targets are announced to
    // screen readers — rewriting them unchanged re-announces the same sentence
    // twice a second. Bail unless something actually moved.
    const key = `${summary.status}|${hintText}`
    if (key === lastVerdictKey) return
    lastVerdictKey = key

    const chip = document.getElementById('verdict-chip')
    if (chip) {
      chip.textContent = summary.status === 'ready'
        ? '✓ Ready'
        : summary.status === 'needs-review'
          ? '⚠ Review'
          : 'Sparse'

      // Style details dynamically
      chip.style.background = summary.status === 'ready'
        ? 'rgba(74,222,128,0.25)'
        : summary.status === 'needs-review'
          ? 'rgba(255,152,0,0.25)'
          : 'rgba(239,112,112,0.25)'
      chip.style.color = summary.status === 'ready'
        ? '#4ade80'
        : summary.status === 'needs-review'
          ? '#ffb74d'
          : '#ef7070'
    }

    // The recommendation belongs beside the verdict, not in #status-text.
    // Written there, this tick overwrote every transient message within 750 ms:
    // the typed inference-error ladder, "Camera access denied", "Export failed",
    // "Scan exported & synced ✓", the low-light and reflection warnings. Every
    // carefully-worded failure string in this file was unreadable in practice,
    // because scan quality is persistent state and was competing for a line
    // that reports events.
    const hint = document.getElementById('verdict-hint')
    if (hint) {
      hint.textContent = hintText
      hint.style.display = hintText ? 'block' : 'none'
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupStatusOverlay() {
  return {
    /**
     * Pass `'sticky'` for a message the user must be able to read — see
     * ./ui/status-line.ts. Shares its hold with `AROverlay.setStatus`, because
     * both write the same `#status-text` node.
     */
    setStatus(text: string, priority: StatusPriority = 'normal') {
      writeStatus(document.getElementById('status-text'), text, priority)
    },
    setProgress(pct: number | null, label?: string) {
      const wrap = document.getElementById('progress-bar-wrap')
      const fill = document.getElementById('progress-bar-fill')
      if (!wrap || !fill) return
      if (pct === null) {
        wrap.classList.remove('visible')
      } else {
        wrap.classList.add('visible')
        fill.style.width = `${Math.round(pct * 100)}%`
        // Normal priority: a progress stage is state, and must not displace a
        // held message reporting what just happened.
        if (label) writeStatus(document.getElementById('status-text'), label)
      }
    },
  }
}

function setAutosaveStatus(text: string): void {
  const el = document.getElementById('autosave-status')
  if (el) el.textContent = text
}

/**
 * Point the "Download .glb" link at the server's saved copy and reveal it.
 *
 * Called only once a scan is genuinely on the server, because that URL is what
 * makes the link work: `/scans/:filename` serves the GLB with
 * `Content-Disposition: attachment`, so tapping it saves the file even where
 * the in-page blob download cannot run (see `triggerDownload` in
 * `src/export/gltf.ts` — mobile Chrome drops downloads that have lost user
 * activation, which the exporter's awaits guarantee).
 */
function revealDownloadLink(uploadedFilename: string): void {
  const link = document.getElementById('export-download-link') as HTMLAnchorElement | null
  if (!link) return
  // A shell cannot send the session header on a link, so its token rides in the URL there.
  link.href = withSessionToken(apiUrl(`/scans/${encodeURIComponent(uploadedFilename)}`), shellSessionToken())
  // Hint the save-as name; same-origin, so the browser honours it.
  link.download = uploadedFilename
  link.style.display = 'inline-block'
}

async function resolveInitialProject(projectStore: ProjectStore): Promise<Project | null> {
  return resolveInitialPlace({
    store: projectStore,
    list: await fetchPlaceList(),
    queryProject: new URLSearchParams(location.search).get('project'),
    storedSelection: sessionStorage.getItem(PLACE_SELECTION_SESSION_KEY) || localStorage.getItem(PLACE_SELECTION_SESSION_KEY),
    onQueryChoice: (projectId) => sessionStorage.setItem(PLACE_SELECTION_SESSION_KEY, JSON.stringify({ projectId })),
  })
}

/**
 * What the caller will do once a Place is confirmed.
 *
 * The picker is opened from two places with different consequences — starting
 * an AR capture, and uploading existing media — and its copy was written for
 * the first. "Scanner location" and a "Use selected place" button are wrong,
 * or at best vague, on the upload path.
 *
 * A union rather than a free-form label string so a caller cannot invent a
 * third wording that drifts from these two, and so adding a caller is a
 * compile error here rather than a silently mislabelled dialog. Same reasoning
 * as `DebugFlag` in src/shared/debug-flags.ts.
 */
export type PlaceSelectionPurpose = 'scan' | 'upload' | 'tripod'

const PLACE_MODAL_COPY: Record<PlaceSelectionPurpose, { title: string; confirm: string; verb: string }> = {
  // `verb` completes the sentence "<verb> the whole place" / "<verb> Kitchen"
  // in the selected-project field and the areas hint. Without it those read
  // "Scanning…" on the upload path — the same wrong-caller wording as the
  // button, one level down, where it is easier to miss.
  scan: { title: 'Scanner location', confirm: 'Scan This Place', verb: 'Scanning' },
  upload: { title: 'Upload location', confirm: 'Upload to This Place', verb: 'Uploading to' },
  // Tripod Scan ends in the same upload as the second card and lands in the
  // same Place, so it asks the same question — but "Uploading to" is the wrong
  // verb for someone who has not captured anything yet, and this is the screen
  // where they choose the room they are about to walk a tripod around.
  tripod: { title: 'Tripod scan location', confirm: 'Sweep This Place', verb: 'Sweeping' },
}

/**
 * Inline SVG for the picker's affordance rows. Inline rather than sprited or
 * fetched because index.html ships no icon system and the picker must render
 * with no network — it is the first thing shown on a capture that may be
 * offline.
 */
const PLACE_ICON_PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>'
const PLACE_ICON_PIN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 14.5s5-4.2 5-8a5 5 0 0 0-10 0c0 3.8 5 8 5 8Z"/><circle cx="8" cy="6.4" r="1.9"/></svg>'
const PLACE_ICON_AREA = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3z"/><path d="M8 8.5v5M2.5 5.5 8 8.5l5.5-3"/></svg>'

function mountPlacePicker(
  projectStore: ProjectStore,
  geoTracker: GeoTracker,
  selected: Project | null,
  onSelect: (project: Project | null, areaId: string | null) => void,
): { open: (afterSelection?: () => void, purpose?: PlaceSelectionPurpose, onDismiss?: () => void) => void } {
  const startScreen = document.getElementById('start-screen')
  if (!startScreen) return { open: () => {} }
  let currentSelected = selected
  let currentAreaId: string | null = null
  let pendingSelectionAction: (() => void) | null = null
  // Run when the sheet is left without a choice (Back, or a tap outside it): whoever opened it is waiting (WP-08).
  let pendingDismissAction: (() => void) | null = null
  // Survives render()'s full innerHTML rebuild, which every selection triggers.
  let areaSectionOpen = false
  // Set by open(); defaults to 'scan' so a caller that forgets still gets the
  // path this modal was originally written for rather than blank copy.
  let currentPurpose: PlaceSelectionPurpose = 'scan'

  const sheet = document.createElement('div')
  sheet.id = 'place-sheet'
  sheet.className = 'place-sheet'
  sheet.hidden = true
  document.body.appendChild(sheet)
  const dismissSheet = (): void => {
    pendingSelectionAction = null
    sheet.hidden = true
    const dismissed = pendingDismissAction
    pendingDismissAction = null
    dismissed?.()
  }

  const render = async () => {
    let listFailed = false
    const listed = await fetchProjects().catch(() => {
      listFailed = true
      return []
    })
    // A frame this phone calibrated and the server does not hold yet stands for the Place's frame, and its row says so.
    const waiting = await projectStore.listPendingFrames().catch(() => [])
    const unsynced = unsyncedPlaceIds(waiting)
    const projects = listed.map(project => withPendingFrame(project, waiting))
    const fix = geoTracker.snapshot()
    const distanced = projects.map(project => ({
      project,
      distance: fix && project.geoPose ? distanceM(fixToGeoPose(fix), project.geoPose) : null,
    }))
    const nearby = distanced
      .filter(item => item.distance !== null && item.distance <= 100)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    // Every saved place must stay reachable even with no GPS fix (indoors, or
    // permission denied) — without this, "nearby" is always empty and there is
    // no way to pick an existing place at all, only to create a new one.
    const nearbyIds = new Set(nearby.map(item => item.project.projectId))
    const others = distanced
      .filter(item => !nearbyIds.has(item.project.projectId))
      .sort((a, b) => a.project.name.localeCompare(b.project.name))

    // The selected Area's name, for the "Selected project" row. `null` means
    // the whole place, which is a real choice and is labelled as one.
    const selectedAreaName = currentSelected && currentAreaId
      ? currentSelected.areas?.find(area => area.areaId === currentAreaId)?.name ?? null
      : null

    // Sub-labels for the two rows that open something. They say what is behind
    // the row *and how much of it*, so the user can tell an empty list from a
    // full one without opening it — a chevron alone reports neither.
    const nearbyHint = !fix
      ? 'No location fix — distances unknown'
      : nearby.length === 0
      ? 'Nothing within 100 m · opens the full list'
      : `${nearby.length} place${nearby.length === 1 ? '' : 's'} within 100 m · nearest first`
    const copy = PLACE_MODAL_COPY[currentPurpose]
    // The last screen before the native file picker opens, and the only one on
    // the upload path that can hold more than a line — so the full version of
    // what an upload builds goes here, where it is still a choice rather than
    // an explanation for a result that already came back empty. Built fresh on
    // every render because `scanCapability` can settle after this sheet was
    // first constructed.
    const expectation = currentPurpose === 'upload' ? uploadExpectation(scanCapability) : null
    const areaCount = currentSelected?.areas?.length ?? 0
    const areaHint = !currentSelected
      ? 'Pick a place first'
      : areaCount === 0
      ? 'No areas yet · tap to add one'
      : `${areaCount} area${areaCount === 1 ? '' : 's'} · ${copy.verb.toLowerCase()} ${selectedAreaName ?? 'the whole place'}`

    sheet.innerHTML = `
      <div class="place-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="place-title">
        <div class="place-sheet-title" id="place-title">${escapeHtml(copy.title)}</div>
        ${expectation ? `
        <div id="place-upload-note" class="place-upload-note">
          <b>${escapeHtml(expectation.title)}</b>
          ${escapeHtml(expectation.builds)} ${escapeHtml(expectation.limit)}
          <span>${escapeHtml(expectation.alternative)}</span>
        </div>` : ''}
        <div id="place-location-status" class="place-location-status"></div>
        <div class="place-selected-status${currentSelected ? '' : ' is-empty'}">
          <span class="place-selected-label">Selected project</span>
          <span class="place-selected-value${currentSelected ? '' : ' is-empty'}">${
            currentSelected
              ? `${escapeHtml(currentSelected.name)}<small>${copy.verb} ${selectedAreaName ? escapeHtml(selectedAreaName) : 'the whole place'}${unsynced.has(currentSelected.projectId) ? ` · ${FRAME_NOT_SYNCED_TEXT}` : ''}</small>`
              : 'None yet — choose one below'
          }</span>
        </div>
        <div class="place-nav">
          <button id="place-new-btn" type="button" class="place-nav-row">
            <span class="place-nav-icon" aria-hidden="true">${PLACE_ICON_PLUS}</span>
            <span class="place-nav-label">
              <b>Create New Place Project</b>
              <span>Opens a form — name, type and this location's coordinates</span>
            </span>
            <span class="place-nav-arrow" aria-hidden="true">&rsaquo;</span>
          </button>
          <button id="place-nearby-btn" type="button" class="place-nav-row">
            <span class="place-nav-icon" aria-hidden="true">${PLACE_ICON_PIN}</span>
            <span class="place-nav-label">
              <b>Suggested Places Nearby</b>
              <span>${nearbyHint}</span>
            </span>
            <span class="place-nav-arrow" aria-hidden="true">&rsaquo;</span>
          </button>
        </div>
        <details class="place-areas" id="place-areas"${currentSelected ? '' : ' aria-disabled="true"'}${areaSectionOpen && currentSelected ? ' open' : ''}>
          <summary>
            <span class="place-nav-icon" aria-hidden="true">${PLACE_ICON_AREA}</span>
            <span class="place-nav-label">
              <b>Add New Area to Selected Place</b>
              <span>${escapeHtml(areaHint)}</span>
            </span>
            <span class="place-areas-chevron" aria-hidden="true">&rsaquo;</span>
          </summary>
          <div class="place-areas-body">
            ${currentSelected ? `
              <div id="place-area-list"></div>
              <button id="place-area-new-btn" type="button" class="place-area-new">Add an area</button>
              <div id="place-area-new-form" hidden>
                <label>Area name<input id="place-area-name" type="text" maxlength="80" placeholder="e.g. Living room" /></label>
                <label>Area type
                  <select id="place-area-kind" class="ci-select"><option value="room">Room</option><option value="floor">Floor</option><option value="zone">Zone</option><option value="building">Building</option><option value="outdoor">Outdoor</option></select>
                </label>
                <button id="place-area-save" type="button">Save area</button>
              </div>` : '<p class="place-empty">Select a place first.</p>'}
          </div>
        </details>
        <div class="place-sheet-actions">
          ${currentSelected ? `<button id="place-continue-btn" type="button" class="place-confirm">${escapeHtml(copy.confirm)}</button>` : ''}
          <!-- Not "Cancel": this button proceeds without a Place (see the
               handler below), and "Cancel" universally reads as "abandon what
               I just tapped". A first-run visitor with no saved Places and no
               GPS fix saw only "Create New Place Project" and "Cancel", so the
               one button that leads to the camera looked like the one that
               gives up on it. -->
          <button id="place-back-btn" type="button">Back</button>
          <button id="place-skip-btn" type="button">Skip for now</button>
        </div>
      </div>
      <div id="place-nearby-popup" class="place-popup" hidden>
        <div class="place-popup-panel" role="dialog" aria-modal="true" aria-labelledby="place-nearby-title">
          <div class="place-popup-head">
            <span class="place-popup-title" id="place-nearby-title">Places nearby</span>
            <button id="place-nearby-close" type="button" class="place-popup-close">Close</button>
          </div>
          <div id="place-nearby-list" class="place-popup-scroll"></div>
        </div>
      </div>
      <div id="place-new-popup" class="place-popup" hidden>
        <div class="place-popup-panel" role="dialog" aria-modal="true" aria-labelledby="place-new-title">
          <div class="place-popup-head">
            <span class="place-popup-title" id="place-new-title">New place project</span>
            <button id="place-new-close" type="button" class="place-popup-close">Close</button>
          </div>
          <div id="place-new-form">
            <div class="place-new-fields">
              <label>Address<input id="place-new-address" type="text" maxlength="160" placeholder="Detected from device location" /></label>
              <div class="place-coordinate-grid">
                <label>Latitude<input id="place-new-lat" type="number" step="any" /></label>
                <label>Longitude<input id="place-new-lng" type="number" step="any" /></label>
              </div>
              <label>Project type
                <select id="place-new-type" class="ci-select">
                  ${newPlaceTypeOptionsHtml()}
                </select>
              </label>
              <label>Project name<input id="place-new-name" type="text" maxlength="80" placeholder="e.g. Our house" /></label>
              <div id="place-new-name-preview" class="place-new-name-preview"></div>
            </div>
            <div class="place-new-footer">
              <button id="place-new-save" type="button">Save new place</button>
              <p id="place-new-status" class="place-new-name-preview" role="status" aria-live="polite"></p>
            </div>
          </div>
        </div>
      </div>`

    const status = sheet.querySelector<HTMLElement>('#place-location-status')!
    // Coordinates are the part of a fix that is never ambiguous, so they lead;
    // 5 decimal places is ~1 m, finer than any accuracy figure this ever
    // carries. Accuracy rides the same line because a position without it
    // invites more confidence than it has earned.
    if (fix) {
      status.innerHTML = `
        <span class="place-location-coords">
          <b>${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}</b>
          <span class="place-location-accuracy">±${Math.round(fix.accuracy)} m</span>
        </span>
        ${fix.address ? `<span class="place-location-address">${escapeHtml(fix.address)}</span>` : ''}`
    } else {
      status.innerHTML = '<span class="place-location-address">Location unavailable. You can still create a place by entering coordinates.</span>'
    }

    // Save errors and validation for the new-place form. They go under the
    // form's own Save button: the location card they used to land in is covered
    // by the popup, so the person saw nothing happen.
    const formStatus = sheet.querySelector<HTMLElement>('#place-new-status')!
    const setFormStatus = (message: string) => {
      formStatus.textContent = message
    }
    // Area errors still land in the location card: the Areas section is not covered by a popup.
    const setStatusMessage = (message: string) => {
      status.innerHTML = `<span class="place-location-address">${escapeHtml(message)}</span>`
    }

    // Popup list: places within 100 m, nearest first.
    //
    // Scoped to 100 m by request. That cutoff has a failure mode worth keeping
    // visible rather than designing around: with no GPS fix, or standing away
    // from every saved place, it is empty — and a user who cannot reach an
    // existing place creates a duplicate instead. So the empty state says why
    // it is empty and offers the remaining places behind an explicit control,
    // rather than being a blank list that reads as "you have no places".
    const nearbyList = sheet.querySelector<HTMLElement>('#place-nearby-list')!
    const appendOption = (
      target: HTMLElement,
      project: Project,
      detail: string,
    ) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `place-option${currentSelected?.projectId === project.projectId ? ' place-option-selected' : ''}`
      const note = unsynced.has(project.projectId) ? ` · ${FRAME_NOT_SYNCED_TEXT}` : ''
      btn.innerHTML = `<strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(detail + note)}</span>`
      btn.addEventListener('click', () => chooseProject(project))
      target.appendChild(btn)
    }

    for (const item of nearby) {
      appendOption(
        nearbyList,
        item.project,
        `${Math.round(item.distance ?? 0)} m away${item.project.address ? ` · ${item.project.address}` : ''}`,
      )
    }
    if (nearby.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'place-empty'
      empty.textContent = listFailed
        ? 'Couldn\'t load your places. Try again.'
        : fix
          ? 'No saved places within 100 m of this fix.'
          : 'No location fix, so distance to your saved places is unknown.'
      nearbyList.appendChild(empty)
      if (others.length > 0) {
        const showAll = document.createElement('button')
        showAll.type = 'button'
        showAll.className = 'place-area-new'
        showAll.textContent = `Show all ${others.length} saved place${others.length === 1 ? '' : 's'}`
        showAll.addEventListener('click', () => {
          showAll.remove()
          for (const item of others) {
            appendOption(nearbyList, item.project, item.project.address || 'No location saved')
          }
        })
        nearbyList.appendChild(showAll)
      }
    }

    // Popups. Opening one is a view change, not a selection change, so they
    // toggle `hidden` directly instead of going through render().
    const nearbyPopup = sheet.querySelector<HTMLElement>('#place-nearby-popup')!
    const newPopup = sheet.querySelector<HTMLElement>('#place-new-popup')!
    const bindPopup = (popup: HTMLElement, openBtnId: string, closeBtnId: string, onOpen?: () => void) => {
      sheet.querySelector<HTMLButtonElement>(openBtnId)?.addEventListener('click', () => {
        popup.hidden = false
        onOpen?.()
      })
      sheet.querySelector<HTMLButtonElement>(closeBtnId)?.addEventListener('click', () => { popup.hidden = true })
      popup.addEventListener('click', (event) => {
        if (event.target === popup) popup.hidden = true
      })
    }
    bindPopup(nearbyPopup, '#place-nearby-btn', '#place-nearby-close')

    // Remember whether the areas section was open, so choosing an area — which
    // re-renders the whole sheet — does not collapse the section the user is
    // working in.
    sheet.querySelector<HTMLDetailsElement>('#place-areas')?.addEventListener('toggle', (event) => {
      areaSectionOpen = (event.currentTarget as HTMLDetailsElement).open
    })

    const lat = sheet.querySelector<HTMLInputElement>('#place-new-lat')!
    const lng = sheet.querySelector<HTMLInputElement>('#place-new-lng')!
    const newAddress = sheet.querySelector<HTMLInputElement>('#place-new-address')!
    const newName = sheet.querySelector<HTMLInputElement>('#place-new-name')!
    const namePreview = sheet.querySelector<HTMLElement>('#place-new-name-preview')!
    if (fix) {
      lat.value = String(fix.lat)
      lng.value = String(fix.lng)
      newAddress.value = fix.address ?? ''
    }
    const updateNamePreview = () => {
      const composed = composeProjectName(newAddress.value, newName.value)
      namePreview.textContent = composed ? `Saved as: ${composed}` : ''
    }
    newAddress.addEventListener('input', updateNamePreview)
    newName.addEventListener('input', updateNamePreview)
    updateNamePreview()
    bindPopup(newPopup, '#place-new-btn', '#place-new-close', () => newName.focus())
    sheet.querySelector<HTMLButtonElement>('#place-new-save')?.addEventListener('click', () => {
      void createPlace()
    })
    sheet.querySelector<HTMLButtonElement>('#place-continue-btn')?.addEventListener('click', () => {
      if (currentSelected) confirmSelection()
    })
    sheet.querySelector<HTMLButtonElement>('#place-skip-btn')?.addEventListener('click', () => {
      currentSelected = null
      currentAreaId = null
      onSelect(null, null)
      sessionStorage.setItem(PLACE_SELECTION_SESSION_KEY, JSON.stringify({ projectId: null }))
      sheet.hidden = true
      // Cancel means "proceed without a Place", not "abandon the action that
      // opened this sheet" — confirmSelection() below already treats an
      // explicit Place pick this way; unassigned (null) is supported
      // end-to-end (ensureSessionScanEntry, upload's projectId: null), so
      // Cancel should resume the same way instead of leaving the caller (AR
      // start or the upload card) as a dead click.
      const action = pendingSelectionAction
      pendingSelectionAction = null
      pendingDismissAction = null
      action?.()
    })
    // Back closes the sheet without a Place and without resuming the action that opened it.
    sheet.querySelector<HTMLButtonElement>('#place-back-btn')?.addEventListener('click', dismissSheet)

    async function createPlace(): Promise<void> {
      const projectName = newName.value.trim()
      const address = newAddress.value.trim()
      const placeType = sheet.querySelector<HTMLSelectElement>('#place-new-type')?.value as PlaceType | undefined
      const latitude = Number(lat.value)
      const longitude = Number(lng.value)
      const name = composeProjectName(address, projectName)
      if (!name || !placeType || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        setFormStatus('Enter a project name and valid latitude/longitude.')
        return
      }
      const geoPose = { ...fixToGeoPose(fix), lat: latitude, lng: longitude, address: address || fix?.address || null, displayAddress: address || fix?.displayAddress || null }
      // Creating a Place is never queued for later: a queued request would make the Place after the person was told it was not made.
      const response = await fetch(apiUrl('/projects'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...noQueueHeaders() },
        body: JSON.stringify({ name, placeType, address, geoPose }),
      }).catch(() => null)
      const created = response ? await readCreatedPlace(response) : { ok: false as const, reason: 'needs-connection' as const }
      if (!created.ok) {
        setFormStatus(created.reason === 'needs-connection' ? PLACE_NEEDS_CONNECTION : 'Could not save this place. Try again.')
        return
      }
      const project = created.place
      await projectStore.updateProject(project).catch(() => {})
      newPopup.hidden = true
      chooseProject(project)
    }

    function chooseProject(project: Project): void {
      currentSelected = project
      currentAreaId = null
      void render()
    }

    const areaList = sheet.querySelector<HTMLElement>('#place-area-list')
    if (areaList && currentSelected) {
      const areas = currentSelected.areas ?? []
      const makeAreaButton = (label: string, areaId: string | null, detail: string) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `place-option${currentAreaId === areaId ? ' place-option-selected' : ''}`
        button.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span>`
        button.addEventListener('click', () => {
          currentAreaId = areaId
          void render()
        })
        areaList.appendChild(button)
      }
      makeAreaButton('Whole place', null, 'No Area assignment')
      for (const area of areas) {
        // The server seeds every new project with a 'site' area named after
        // the place itself (main.ts's POST /projects). Listing it verbatim put
        // the place name in the list twice, once as "Whole place" and once as
        // itself, meaning two different things. Label it for what it is.
        makeAreaButton(area.name, area.areaId, area.kind === 'site' ? 'Whole site' : area.kind)
      }
      const newAreaForm = sheet.querySelector<HTMLElement>('#place-area-new-form')!
      sheet.querySelector<HTMLButtonElement>('#place-area-new-btn')?.addEventListener('click', () => {
        newAreaForm.hidden = !newAreaForm.hidden
        if (!newAreaForm.hidden) sheet.querySelector<HTMLInputElement>('#place-area-name')?.focus()
      })
      sheet.querySelector<HTMLButtonElement>('#place-area-save')?.addEventListener('click', () => {
        void createArea()
      })
    }

    async function createArea(): Promise<void> {
      if (!currentSelected) return
      const name = sheet.querySelector<HTMLInputElement>('#place-area-name')?.value.trim() ?? ''
      const kind = sheet.querySelector<HTMLSelectElement>('#place-area-kind')?.value as AreaKind | undefined
      if (!name || !kind) {
        setStatusMessage('Enter an Area name and type.')
        return
      }
      const area: PlaceArea = {
        areaId: `area-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        kind,
        parentAreaId: currentSelected.areas?.find(candidate => candidate.kind === 'site')?.areaId ?? null,
      }
      const update = { ...currentSelected, areas: [...(currentSelected.areas ?? []), area] }
      const response = await fetch(apiUrl(`/projects/${encodeURIComponent(currentSelected.projectId)}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...noQueueHeaders() }, body: JSON.stringify(update),
      }).catch(() => null)
      const saved = response ? await readCreatedPlace(response) : { ok: false as const, reason: 'needs-connection' as const }
      if (!saved.ok) {
        setStatusMessage(saved.reason === 'needs-connection' ? AREA_NEEDS_CONNECTION : 'Could not save the Area. Try again.')
        return
      }
      currentSelected = saved.place
      currentAreaId = area.areaId
      void projectStore.updateProject(currentSelected).catch(() => {})
      void render()
    }

    function confirmSelection(): void {
      if (!currentSelected) return
      onSelect(currentSelected, currentAreaId)
      sheet.hidden = true
      sessionStorage.setItem(PLACE_SELECTION_SESSION_KEY, JSON.stringify({ projectId: currentSelected.projectId, areaId: currentAreaId }))
      void projectStore.updateProject(currentSelected).catch(() => {})
      const action = pendingSelectionAction
      pendingSelectionAction = null
      pendingDismissAction = null
      action?.()
    }
  }

  const open = (afterSelection?: () => void, purpose: PlaceSelectionPurpose = 'scan', onDismiss?: () => void) => {
    pendingSelectionAction = afterSelection ?? null
    pendingDismissAction = onDismiss ?? null
    currentPurpose = purpose
    sheet.hidden = false
    void render()
    void retryPendingFrames(projectStore, undefined, 'picker').then(({ changed }) => {
      if (changed && !sheet.hidden) void render()
    })
  }
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) dismissSheet()
  })
  return { open }
}

function fixToGeoPose(fix: GeoFix | null): NonNullable<Project['geoPose']> {
  return {
    lat: fix?.lat ?? null,
    lng: fix?.lng ?? null,
    altitudeM: fix?.altitudeM ?? null,
    bearing: fix?.bearing ?? null,
    accuracyM: fix?.accuracy ?? null,
    fixedAt: fix?.fixedAt ?? null,
    address: fix?.address ?? null,
    displayAddress: fix?.displayAddress ?? null,
  }
}

/** The stored project name is always address-qualified, so two same-named rooms in different buildings read as distinct places. */
function composeProjectName(address: string, projectName: string): string {
  const name = projectName.trim()
  if (!name) return ''
  const trimmedAddress = address.trim()
  return trimmedAddress ? `${trimmedAddress}-${name}` : name
}

function escapeHtml(value: string): string {
  const el = document.createElement('span')
  el.textContent = value
  return el.innerHTML
}

async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(apiUrl('/projects'))
  if (!response.ok) return []
  return await response.json() as Project[]
}

/**
 * One-time HUD warning when IndexedDB usage crosses 80 % of the browser quota.
 *
 * Wave 05 ticket 0002 (docs/factory/05-on-device-inference/0002-browser-model-provisioning.md)
 * extends this to know about the on-device model cache: weights and scan
 * data draw on the same origin quota, and weights are re-downloadable while
 * scans are not, so when the model is a meaningful share of usage the
 * warning names it as the thing to remove — never scan data. This never
 * deletes anything itself; DoD is "not silently evicted," not "auto-evict
 * weights."
 */
async function checkStorageQuota(store: DetectionStore, overlay: ReturnType<typeof setupStatusOverlay>): Promise<void> {
  if (quotaWarningShown) return
  const q = await store.quotaStatus()
  if (!q || q.quota <= 0 || q.usage / q.quota <= 0.8) return
  quotaWarningShown = true

  const modelBytes = await estimateModelCacheBytes().catch(() => 0)
  overlay.setStatus(
    modelBytes > 0 && modelBytes / q.usage > 0.3
      ? 'Storage nearly full — remove the on-device model to free space'
      : 'Storage nearly full — old sessions may not save',
  )
}

/**
 * Move #start-ar-btn out of its initial "preparing" state.
 *
 * The button paints from index.html's static markup within ~250 ms, and its
 * click handler is attached at the top of main() (section 0) — so 'ready'
 * follows almost immediately, and a tap from then on is honoured even though
 * AR itself only starts in section 5. The markup ships
 * `disabled aria-busy="true"` with a "Preparing…" line to cover the gap that
 * remains: the ~50 ms until section 0 runs, and the case where the bundle
 * never loads at all, where staying disabled is the honest state. This is the
 * only thing that clears it.
 *
 * The handler can't move any later than a real gesture — the iOS
 * motion-permission request must run synchronously inside the click, so an
 * early tap can never be buffered and replayed. Attaching early is what makes
 * the tap land somewhere instead of vanishing with no feedback.
 *
 * 'unavailable' is terminal: the boot paths that give up (insecure context, no
 * AR runtime, a crash in main()) call it so the card stops advertising a wait
 * that will never end.
 */
function setStartButtonState(state: 'ready' | 'unavailable', label?: string): void {
  const btn = document.getElementById('start-ar-btn') as HTMLButtonElement | null
  if (!btn) return
  btn.disabled = state !== 'ready'
  btn.removeAttribute('aria-busy')   // no longer booting, either way

  // Every dead end funnels through here — insecure context, no AR runtime, a
  // failed start — so this is the one place that catches them all, including
  // the ones that return before the preflight probe ever runs. Only the
  // negative is taken: 'ready' fires in section 0, before an AR runtime has
  // been created, and would be claiming a scan is possible on evidence that
  // is only "the button's click handler is attached".
  if (state === 'unavailable') scanCapability = 'unavailable'

  // Close the live rungs and let the resolver pick again, so the screen ends up
  // recommending something that can still run rather than a dead card with an
  // apology under it. Done here rather than at each call site for the reason
  // above: this is where every dead end ends up, including the ones that return
  // before the preflight probe runs.
  if (state === 'unavailable') setCaptureDevice(withoutLiveCapture(captureDevice))

  const status = btn.querySelector<HTMLElement>('.start-path-status')
  if (status && state === 'unavailable') {
    status.textContent = label ?? 'Not available on this device'
  }
}

/**
 * Fills and reveals the #ar-help hint on the start screen when no AR runtime
 * is available: how to get a live capture working on THIS platform, if the
 * person wants one.
 *
 * It used to carry a second sentence naming the path that still works here.
 * That is now `renderCaptureChoice()`'s job, and it does it better — it names
 * the method for the subject the person actually chose, and it puts it on a
 * card they can press rather than in prose. Two lines saying it was not
 * redundancy on a screen with a word budget
 * (tests/mock-scanner-startup-budget.spec.ts); it was the second one arguing
 * with the first.
 *
 * What is left is the device advice: this is remediation, not a route — a trip
 * to Safari or an app store, which on some phones ends with a phone that still
 * cannot do it (the Beam Pro has no AR service to install). So it is short, and
 * it is not the primary thing on the screen.
 *
 * The boot path's reason says more than that. Its headline is the Start button's
 * label, as the verdict path does it. When it has a next step (an engine that did
 * not load: reload the page), the step replaces the device advice, because "open
 * this in Safari" is the wrong remedy there.
 */
function showArHelp(reason: string): void {
  const [headline, ...steps] = reason.split('\n')
  setStartButtonState('unavailable', headline)
  const nextStep = steps.map((line) => line.replace(/^•\s*/, '')).join(' ')
  const ua = navigator.userAgent
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  // The desktop app is the editor and viewer and never captures. Its origin (tauri://localhost) is no address a phone
  // can open, so it must not be offered as one: the browser line below is for a page someone reached by URL.
  const plain = isDesktopShell()
    ? 'The desktop app cannot capture. Scan on a phone.'
    : isIOS
      ? 'To capture live in Safari, use the main scanner, or install HelloXR.'
      : /Android/i.test(ua)
        ? 'Live capture needs Chrome with Play Services for AR.'
        : `To capture live, open this on a phone: ${location.origin}`

  const el = document.getElementById('ar-help')
  if (!el) {
    // #ar-help lives inside #start-screen, and a Start AR tap removes that
    // screen — which, now that a tap is honoured during boot (section 0), can
    // happen before AR runtime detection has failed. Fall back to the
    // permission banner, a sibling of the start screen that survives it, so
    // "no AR runtime" can never end as a blank screen with no explanation.
    showPermissionBanner(nextStep || plain, headline)
    return
  }

  if (nextStep) {
    el.textContent = nextStep
  } else if (isIOS) {
    el.innerHTML = 'To capture live in Safari, use the main scanner, or install '
      + '<a href="https://apps.apple.com/us/app/helloxr/id6757726359" style="color:var(--ci-accent);">HelloXR</a>.'
  } else {
    el.textContent = plain
  }
  el.hidden = false
}

/**
 * Wire the Place-scoped media upload path. One video is ingested as a
 * walkthrough; one or more images become a photo-ingest session.
 * Deliberately isolated from the AR start flow: it neither removes the start
 * screen nor touches the onboarding/insecure-context paths.
 *
 * A read-only page (MAIN10-1) opens no picker, not even while it boots, and has no change handler
 * on the input, so a file handed to the input is not sent.
 */
function wireContentUpload(readOnly: boolean): void {
  const input = document.getElementById('upload-video-input') as HTMLInputElement | null
  const progress = document.getElementById('upload-video-progress')
  const openLink = document.getElementById('upload-video-open') as HTMLAnchorElement | null
  const btn = document.getElementById('upload-video-btn')
  const uploadCard = document.getElementById('start-upload-card')
  if (!input) return

  // The file picker opens after the user confirms a project in the modal —
  // but the picker (requestPlaceSelection) isn't wired until deep in main(),
  // after the isSecureContext check this function is deliberately called
  // before. On an insecure context main() returns before ever reaching it, so
  // requestPlaceSelection stays null forever; on a secure context there is
  // also a brief window before it's assigned. Fall back to opening the file
  // picker directly (an unassigned upload) rather than a dead click with no
  // feedback — this is the same "no Place" path Cancel already allows.
  uploadCard?.addEventListener('click', () => {
    if (requestPlaceSelection) {
      // The sheet carries the expectation itself (see the upload branch in
      // mountPlacePicker's render), so nothing is written here — the status
      // line under the card would be behind the sheet anyway.
      requestPlaceSelection(() => input.click(), 'upload')
      return
    }
    // A read-only page opens no picker, not even while it boots (MAIN10-1).
    if (readOnly) return
    // No sheet on this path — it is the insecure-context / still-booting
    // fallback — so the picker opens over a start screen that has said only
    // the card's one-line version. Put the full version in the status line
    // first: it is what the user comes back to once the picker closes, and it
    // is still before a byte has been uploaded.
    if (progress) progress.textContent = uploadExpectationLine(scanCapability)
    input.click()
  })

  // A read-only page sends nothing, so the input gets no change handler (MAIN10-1).
  if (readOnly) return
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])]
    if (files.length === 0) return
    // Tripod Scan is collecting one spot's photos through this same input (see
    // pendingPhotoIntake). Hand them over and upload nothing: that capture is
    // sent as one set at the end, and a per-spot upload would produce three to
    // five unrelated captures of the same room.
    if (pendingPhotoIntake) {
      const consume = pendingPhotoIntake
      // Cleared before the value is reset, so the reset cannot re-enter here.
      pendingPhotoIntake = null
      input.value = ''
      consume(files)
      return
    }
    const allPhotos = files.every(file => file.type.startsWith('image/'))
    const oneVideo = files.length === 1 && files[0]!.type.startsWith('video/')
    if (!allPhotos && !oneVideo) {
      if (progress) progress.textContent = '• Choose one video, or several photos from one Place'
      input.value = ''
      return
    }
    // Claimed for exactly one send, and cleared before anything can go wrong:
    // a tripod capture's spot numbers must never be attached to the next,
    // unrelated, upload of a few photos.
    const extras = pendingUploadExtras
    pendingUploadExtras = null

    if (btn) btn.setAttribute('aria-disabled', 'true')
    if (openLink) openLink.hidden = true
    if (progress) progress.textContent = 'Uploading… 0%'

    const form = new FormData()
    if (oneVideo) form.append('video', files[0]!, files[0]!.name)
    else for (const file of files) form.append('files', file, file.name)
    form.append('name', oneVideo ? files[0]!.name.replace(/\.[^.]+$/, '') : `Photo set ${new Date().toLocaleDateString()}`)
    if (uploadPlaceTarget.projectId) form.append('projectId', uploadPlaceTarget.projectId)
    if (uploadPlaceTarget.areaId) form.append('areaId', uploadPlaceTarget.areaId)
    if (extras && !oneVideo) {
      // The two fields that make this a capture of a room rather than a pile of
      // photos: which spot each one was taken from, positionally against
      // `files`, and the one measured length. Sent on the same request as the
      // photos so they cannot arrive without each other.
      form.append('stations', JSON.stringify(extras.stations))
      if (extras.knownDistances.length > 0) form.append('knownDistances', JSON.stringify(extras.knownDistances))
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(oneVideo ? '/ingest-video' : '/ingest-photos'))
    xhr.upload.addEventListener('progress', (e) => {
      if (!progress || !e.lengthComputable) return
      progress.textContent = `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`
    })
    xhr.addEventListener('load', () => {
      if (btn) btn.removeAttribute('aria-disabled')
      if (xhr.status >= 200 && xhr.status < 300) {
        let result: { frameCount?: number; droppedBlurry?: number } = {}
        try { result = JSON.parse(xhr.responseText) as typeof result } catch { /* ignore */ }
        const dropNote = result.droppedBlurry ? ` ${result.droppedBlurry} blurry photo${result.droppedBlurry === 1 ? '' : 's'} skipped.` : ''
        // A tripod capture words its own result, because the thing worth
        // saying about it is whether it came back with a real size — and
        // UPLOAD_RESULT_NOTE's promise ("nothing catalogued") is about an
        // upload of someone else's pictures, not about this.
        const line = extras
          ? `${extras.successLine(result.frameCount ?? 0)}${dropNote}`
          : result.frameCount
            ? `Uploaded — ${result.frameCount} keyframes extracted.${dropNote} ${UPLOAD_RESULT_NOTE}`
            : `Uploaded — processing started. ${UPLOAD_RESULT_NOTE}`
        if (progress) progress.textContent = line
        extras?.settle(true, line)
        if (openLink) {
          // A free upload (no Place) is in the default world, so the link says so.
          openLink.href = editorPath(uploadPlaceTarget.projectId
            ? `?project=${encodeURIComponent(uploadPlaceTarget.projectId)}`
            : '?world=default')
          openLink.hidden = false
        }
      } else {
        let message = xhr.status >= 500
          ? 'Upload failed: server unreachable, try again later'
          : `Upload failed (${xhr.status})`
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string; maxBytes?: number }
          if (body.error) message = `Upload failed: ${body.error}`
          if (xhr.status === 413 && body.maxBytes) message += ` (max ${(body.maxBytes / 1e6).toFixed(0)} MB)`
        } catch { /* keep default */ }
        if (progress) progress.textContent = message
        extras?.settle(false, message)
      }
      input.value = ''
    })
    xhr.addEventListener('error', () => {
      if (btn) btn.removeAttribute('aria-disabled')
      const message = 'Upload failed — check your connection.'
      if (progress) progress.textContent = message
      extras?.settle(false, message)
      input.value = ''
    })
    xhr.send(form)
  })
}

/** The three start-screen controls a method can be run from. */
const CAPTURE_CONTROLS: readonly CaptureControlId[] = [
  'start-ar-btn', 'start-tripod-card', 'start-upload-card',
]

/**
 * Draw the start screen from the answer to "what are you capturing?" and what
 * this device has been found able to do.
 *
 * Everything decided here comes out of `resolveCapture()`
 * (src/capture/capture-intent.ts), which is pure and unit-tested — including
 * the invariant this screen used to break: some method is always recommended.
 * A phone that failed the AR probe used to be left looking at a disabled
 * primary card and a line of prose pointing at the weakest path on the screen.
 *
 * The cards themselves are the ones that were already there, under the same
 * ids: one method per control, its words rewritten for the subject, because
 * "film as you walk round the room" and "take 20 photos right around it" are
 * the same button and not the same instruction.
 */
function renderCaptureChoice(): void {
  // The start screen is removed once AR is actually running (section 5), and
  // the preflight/verdict paths that call this can fire after that.
  const paths = document.getElementById('start-paths')
  if (!paths) return

  const rec = resolveCapture(captureSubject, captureDevice)

  for (const chip of document.querySelectorAll<HTMLButtonElement>('.capture-subject')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.subject === captureSubject))
  }

  // A video and a photo set are the same tap, so the first plan to claim a
  // control keeps it — otherwise the second would overwrite the words of the
  // recommendation itself.
  //
  // Filled best-first, so the key order is the resolver's ranking and stays
  // usable as one: a building ranks a walkthrough video above a tripod carried
  // from room to room, and the list below is laid out in that order rather
  // than in whatever order the controls happen to appear in the markup.
  const byControl = new Map<CaptureControlId, MethodPlan>()
  for (const plan of [rec.best, ...rec.alternatives]) {
    if (!byControl.has(plan.control)) byControl.set(plan.control, plan)
  }

  // How many runnable methods are not the recommendation — which is exactly
  // how many cards sit behind the disclosure, because `byControl` holds one
  // entry per control that has something to run and always holds the
  // recommendation's own. Counted before the loop rather than in it, so the
  // "nothing behind it" case below can settle the state the loop then reads.
  const altControls = [...byControl.keys()].filter(id => id !== rec.best.control)
  const alternatives = altControls.length
  // A control that reveals nothing is worse than no control, and so is a
  // remembered "open" for a list that is now empty: a later render must not
  // spring open on the strength of a tap the person made about a different
  // screen.
  if (alternatives === 0) altsExpanded = false

  for (const id of CAPTURE_CONTROLS) {
    const el = document.getElementById(id)
    if (!el) continue
    const plan = byControl.get(id)
    if (!plan) {
      // Not merely un-recommended: this one cannot run here at all, so it is
      // not merely un-recommended, so it is not shown at all. An alternative
      // that dead-ends is worse than no alternative.
      el.hidden = true
      el.dataset.recommended = 'false'
      continue
    }
    const isBest = id === rec.best.control
    const title = el.querySelector<HTMLElement>('.start-path-title')
    const sub = el.querySelector<HTMLElement>('.start-path-sub')
    // textContent, not innerHTML: #upload-video-btn is the title span itself,
    // and replacing the element would take its id with it.
    if (title) title.textContent = plan.title
    if (sub) sub.textContent = `${plan.action} ${plan.result}`
    el.setAttribute('aria-label', `${plan.title} — ${plan.action} ${plan.result}`)
    el.dataset.recommended = String(isBest)
    // The recommendation is never behind the disclosure, and neither is the
    // editor card below it — this hides only the methods that were ranked and
    // not chosen.
    el.hidden = !isBest && !altsExpanded
  }

  const toggle = document.getElementById('start-alt-toggle')
  if (toggle) {
    toggle.hidden = alternatives === 0
    toggle.setAttribute('aria-expanded', String(altsExpanded))
    // Rewritten per render because which cards these are is not a property of
    // the markup: it moves with the subject and with what the device has been
    // found able to do.
    toggle.setAttribute('aria-controls', altControls.join(' '))
  }

  layoutStartPaths(paths, rec.best.control, altControls, toggle)

  const note = document.getElementById('capture-note')
  if (note) {
    note.textContent = rec.note ?? ''
    note.hidden = rec.note === null
  }
}

/**
 * Put the cards in the order the resolver ranked them: recommendation, the
 * control that reveals the rest, then the rest, then the editor card.
 *
 * The markup cannot ship this order, because which card is the recommendation
 * is not known until a device has been probed — a phone with no live capture
 * is recommended the tripod card, which sits third in the source. Left alone,
 * the mint "start here" fill landed in the middle of the stack, and the
 * disclosure would have sat either above the recommendation or below the cards
 * it reveals.
 *
 * Reordering the DOM rather than setting `order` on the flex container is the
 * point: `order` moves the pixels and leaves Tab and the screen reader walking
 * the source, so a keyboard user would have reached the revealed cards by
 * tabbing BACKWARDS past the control that revealed them.
 *
 * Only ever moves nodes when the order actually differs. Opening or closing
 * the list does not change it — that is `hidden`, not position — and moving a
 * node that currently has focus drops the focus to the body, which would take
 * the focus off the toggle on the very tap that used it.
 */
function layoutStartPaths(
  paths: HTMLElement,
  best: CaptureControlId,
  altControls: readonly CaptureControlId[],
  toggle: HTMLElement | null,
): void {
  const wanted = [
    document.getElementById(best),
    toggle,
    ...altControls.map(id => document.getElementById(id)),
    document.getElementById('start-editor-card'),
  ].filter((el): el is HTMLElement => el !== null)

  const managed = new Set<Element>(wanted)
  const current = Array.from(paths.children).filter(el => managed.has(el))
  if (current.length === wanted.length && current.every((el, i) => el === wanted[i])) return
  for (const el of wanted) paths.appendChild(el)
}

/**
 * Record what has been learned about the device, and redraw.
 *
 * Merged rather than replaced because the two facts arrive from different
 * places at different times — the probe (section 3b) and a runtime verdict
 * (the `provider.start()` catch, and every other dead end via
 * `setStartButtonState`) — and neither knows the other's answer.
 */
function setCaptureDevice(next: Partial<DeviceCapture>): void {
  captureDevice = { ...captureDevice, ...next }
  renderCaptureChoice()
}

/**
 * Wire the subject question and the capture-method list.
 *
 * Called at the top of main(), beside the two paths that need no AR runtime,
 * so the screen is answerable on the devices where the boot below gives up —
 * on an insecure context main() returns before an AR runtime is ever created,
 * and this screen still has to recommend something.
 */
function mountCaptureIntent(): void {
  for (const chip of document.querySelectorAll<HTMLButtonElement>('.capture-subject')) {
    chip.addEventListener('click', () => {
      const subject = chip.dataset.subject as CaptureSubject | undefined
      if (!subject || subject === captureSubject) return
      captureSubject = subject
      // The list was opened about the previous subject; leaving it open would
      // show a set of methods answering a question that has changed.
      altsExpanded = false
      renderCaptureChoice()
    })
  }

  // The disclosure. A real <button>, so Enter and Space work and it takes a
  // Tab stop without anything here adding one — and `renderCaptureChoice()`
  // only flips `hidden` on other elements, so the focus stays where the
  // person put it and the next Tab walks into what they just revealed.
  document.getElementById('start-alt-toggle')?.addEventListener('click', () => {
    altsExpanded = !altsExpanded
    renderCaptureChoice()
  })

  renderCaptureChoice()
}

/**
 * Tripod Scan — the third capture path, and the station loop that guides it.
 *
 * The operator sweeps the room from one spot, carries the tripod, and sweeps
 * again, three to five times. All four questions that loop raises are on this
 * screen at all times: which spot they are on, whether the sweep is running,
 * whether they may move yet, and whether the capture is finished. The rules
 * behind it — a sweep that produced nothing is not a spot, and fewer than
 * three spots is not a room — live in src/capture/station-capture.ts, where
 * they are testable without a browser.
 *
 * It borrows rather than builds: the Place picker chooses where this capture
 * belongs (`'tripod'` purpose), `#upload-video-input` collects the photos, and
 * the finished set goes out through the existing upload handler by dispatching
 * a `change` on that same input — so the tripod path adds no second uploader,
 * no second Place target, and no second progress line.
 *
 * On a read-only page (MAIN10-2) nothing here writes. The sheet cannot be opened, because the card
 * only shows the read-only notice. restore() reads and renders the capture another tab left behind,
 * but clears nothing: that record may be the writer's, and clearTripodCapture() has no gate of its own.
 */
function mountTripodCapture(readOnly: boolean): void {
  const card = document.getElementById('start-tripod-card')
  const input = document.getElementById('upload-video-input') as HTMLInputElement | null
  if (!card || !input) return

  let state: StationCaptureState = createStationCapture()
  /**
   * The photos, kept BY SPOT rather than in one pile.
   *
   * This is the whole difference between a tripod capture and a bag of photos.
   * The server can refuse a capture taken from a single spot, group the frames
   * into viewpoints, and size the room from one measured length — and every one
   * of those needs to know which spot each photo came from. A flat File[] threw
   * that away before anything left the phone.
   *
   * It mirrors `state.spots` exactly: `spotFiles[i]` is the photos behind
   * `state.spots[i]`, and `pendingFiles` is the sweep in progress, committed
   * only where `endSweep` commits its count.
   */
  let spotFiles: File[][] = []
  /**
   * The storage key each entry of `spotFiles` is written under, kept beside it
   * rather than inside it.
   *
   * Two arrays because `spotFiles` is what `planStationFrames` consumes and
   * `filesFor` flattens, and threading a key through the uploader would be a
   * new shape in four modules for the benefit of one. They are only ever
   * changed together — a spot commits, a spot is discarded, the capture is
   * reset or restored — and each of those four places does both lines.
   *
   * The key never moves once minted, so discarding spot 2 deletes one record
   * instead of rewriting spots 3, 4 and 5.
   */
  let spotKeys: string[] = []
  let spotSeq = 0
  let pendingFiles: File[] = []
  /**
   * A capture that came back from storage and has not been acknowledged.
   *
   * Set only by the restore, cleared by the first thing the operator does with
   * it. It exists so that restoring is LOUD: the alternative is someone
   * reopening the app, finding themselves at spot 3 of 5, and having no way to
   * know whether those photos are of this room.
   */
  let recovered: { spots: number, photos: number, savedAt: number } | null = null
  /** Which spot a Discard has been asked about, and is waiting to be confirmed. */
  let confirmDrop: number | null = null
  /**
   * Whether the last write to storage worked.
   *
   * Storage is optional, exactly like the camera, and a tab that will not give
   * the page a database must still be able to run a whole capture — but it must
   * not be told the capture is safe to leave. Null until anything has been
   * written.
   */
  let persisted: boolean | null = null
  /**
   * A one-off message that outranks the finish refusal in the same slot —
   * "those were not photos", "this browser cannot hand them over". Cleared by
   * the next action, so it never outlives the thing it is about.
   */
  let notice: string | null = null
  /** True while the capture is on the wire, so a second tap cannot send it twice. */
  let sending = false
  /**
   * True once the camera is actually open and banking frames for this sweep.
   *
   * Separate from `state.phase === 'sweeping'`, because they genuinely come
   * apart: a sweep whose camera was refused is still a sweep — the tripod is
   * down, the gimbal is turning, and the photos can still be added by hand —
   * and showing a preview frame for it would be the screen claiming a camera
   * it does not have.
   */
  let cameraLive = false

  const sheet = document.createElement('div')
  sheet.id = 'tripod-sheet'
  sheet.className = 'place-sheet'
  sheet.hidden = true
  sheet.innerHTML = `
    <div class="place-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="tripod-headline">
      <div class="place-sheet-title" tabindex="-1">Tripod Scan · <span id="tripod-step"></span></div>
      <!-- What came back after the app was closed or the tab was thrown away.
           Above everything, because it is the first thing that has to be true
           before any other number on this screen means anything. -->
      <div id="tripod-recovered" class="tripod-recovered" hidden>
        <b id="tripod-recovered-headline"></b>
        <span>${escapeHtml(RECOVERY_LOST_SWEEP)}</span>
        <button id="tripod-recovered-keep" type="button" class="tripod-wide-btn">${escapeHtml(RECOVERY_KEEP_LABEL)}</button>
        <button id="tripod-recovered-drop" type="button" class="tripod-plain-btn">${escapeHtml(RECOVERY_DISCARD_LABEL)}</button>
      </div>
      <div id="tripod-intro" class="place-upload-note">
        <b>What this path is for</b>
        ${escapeHtml(TRIPOD_PATH_SUMMARY)}
        <span>${escapeHtml(WHY_SEVERAL_SPOTS)}</span>
      </div>
      <ol id="tripod-dots" class="project-calibration-steps"></ol>
      <div id="tripod-headline" class="tripod-headline" aria-live="polite"></div>
      <p id="tripod-detail" class="tripod-detail"></p>
      <!-- What the phone can see, while it is looking. Hidden the rest of the
           time so a dead black rectangle never sits in the sheet implying a
           camera that is not open. The muted + playsinline pair is what lets
           it show at all on Android Chrome without going full-screen. -->
      <div id="tripod-camera" class="tripod-camera" hidden>
        <video id="tripod-preview" playsinline muted aria-label="What the camera can see"></video>
        <p id="tripod-camera-line" class="tripod-camera-line" aria-live="polite"></p>
        <!-- The shape of the sweep, not just its size. A jammed gimbal keeps
             the tally climbing and every photo is of the same wall; this is the
             only thing on the screen that can say so. -->
        <p id="tripod-camera-still" class="tripod-camera-still" aria-live="polite" hidden></p>
      </div>
      <div class="tripod-tally">
        <span id="tripod-tally-spots"></span>
        <span id="tripod-tally-photos"></span>
      </div>
      <!-- Every spot in hand, and the way to throw one away. A sweep that
           photographed a cupboard used to cost the whole capture to fix. -->
      <ul id="tripod-spot-list" class="tripod-spot-list" hidden></ul>
      <!-- Only ever shown when saving FAILED. A capture that is safely stored
           says nothing, because "your work is saved" is the claim this repo
           keeps making without earning it. -->
      <p id="tripod-storage" class="tripod-blocked" hidden></p>
      <div id="tripod-measure" class="tripod-measure" hidden>
        <div class="tripod-measure-q">${escapeHtml(DISTANCE_PROMPT.question)}</div>
        <p class="tripod-detail">${escapeHtml(DISTANCE_PROMPT.why)} ${escapeHtml(DISTANCE_PROMPT.how)}</p>
        <div class="tripod-measure-row">
          <label class="tripod-unit" for="tripod-metres">
            <input id="tripod-metres" type="number" inputmode="numeric" min="0" max="25" step="1" autocomplete="off">
            <span>metres</span>
          </label>
          <label class="tripod-unit" for="tripod-centimetres">
            <input id="tripod-centimetres" type="number" inputmode="numeric" min="0" max="99" step="1" autocomplete="off">
            <span>centimetres</span>
          </label>
        </div>
        <p id="tripod-measure-echo" class="tripod-measure-echo" aria-live="polite"></p>
        <p class="tripod-measure-unit">${escapeHtml(DISTANCE_PROMPT.unitNote)}</p>
        <button id="tripod-measure-save" type="button" class="tripod-wide-btn">${escapeHtml(DISTANCE_PROMPT.save)}</button>
        <button id="tripod-measure-skip" type="button" class="tripod-plain-btn">${escapeHtml(DISTANCE_PROMPT.skip)}</button>
      </div>
      <div id="tripod-size" class="tripod-size" hidden>
        <b id="tripod-size-headline"></b>
        <span id="tripod-size-detail"></span>
      </div>
      <button id="tripod-measure-open" type="button" class="tripod-plain-btn" hidden>${escapeHtml(DISTANCE_PROMPT.reopen)}</button>
      <button id="tripod-camera-on" type="button" class="tripod-wide-btn" hidden>${escapeHtml(CAMERA_ON_LABEL)}</button>
      <button id="tripod-add" type="button" class="tripod-plain-btn" hidden></button>
      <button id="tripod-send" type="button" class="tripod-wide-btn" hidden></button>
      <p id="tripod-blocked" class="tripod-blocked" hidden></p>
      <div class="place-sheet-actions">
        <button id="tripod-primary" type="button" class="place-confirm"></button>
        <button id="tripod-close" type="button">Close</button>
      </div>
    </div>`
  document.body.appendChild(sheet)

  const introEl = sheet.querySelector<HTMLElement>('#tripod-intro')!
  const stepEl = sheet.querySelector<HTMLElement>('#tripod-step')!
  const dotsEl = sheet.querySelector<HTMLElement>('#tripod-dots')!
  const headlineEl = sheet.querySelector<HTMLElement>('#tripod-headline')!
  const detailEl = sheet.querySelector<HTMLElement>('#tripod-detail')!
  const cameraEl = sheet.querySelector<HTMLElement>('#tripod-camera')!
  const previewEl = sheet.querySelector<HTMLVideoElement>('#tripod-preview')!
  const cameraLineEl = sheet.querySelector<HTMLElement>('#tripod-camera-line')!
  const cameraStillEl = sheet.querySelector<HTMLElement>('#tripod-camera-still')!
  const spotListEl = sheet.querySelector<HTMLElement>('#tripod-spot-list')!
  const storageEl = sheet.querySelector<HTMLElement>('#tripod-storage')!
  const recoveredEl = sheet.querySelector<HTMLElement>('#tripod-recovered')!
  const recoveredHeadlineEl = sheet.querySelector<HTMLElement>('#tripod-recovered-headline')!
  const recoveredKeepBtn = sheet.querySelector<HTMLButtonElement>('#tripod-recovered-keep')!
  const recoveredDropBtn = sheet.querySelector<HTMLButtonElement>('#tripod-recovered-drop')!
  const tallySpotsEl = sheet.querySelector<HTMLElement>('#tripod-tally-spots')!
  const tallyPhotosEl = sheet.querySelector<HTMLElement>('#tripod-tally-photos')!
  const measureEl = sheet.querySelector<HTMLElement>('#tripod-measure')!
  const metresInput = sheet.querySelector<HTMLInputElement>('#tripod-metres')!
  const cmInput = sheet.querySelector<HTMLInputElement>('#tripod-centimetres')!
  const echoEl = sheet.querySelector<HTMLElement>('#tripod-measure-echo')!
  const saveBtn = sheet.querySelector<HTMLButtonElement>('#tripod-measure-save')!
  const skipBtn = sheet.querySelector<HTMLButtonElement>('#tripod-measure-skip')!
  const reopenBtn = sheet.querySelector<HTMLButtonElement>('#tripod-measure-open')!
  const sizeEl = sheet.querySelector<HTMLElement>('#tripod-size')!
  const sizeHeadlineEl = sheet.querySelector<HTMLElement>('#tripod-size-headline')!
  const sizeDetailEl = sheet.querySelector<HTMLElement>('#tripod-size-detail')!
  const cameraOnBtn = sheet.querySelector<HTMLButtonElement>('#tripod-camera-on')!
  const addBtn = sheet.querySelector<HTMLButtonElement>('#tripod-add')!
  const sendBtn = sheet.querySelector<HTMLButtonElement>('#tripod-send')!
  const blockedEl = sheet.querySelector<HTMLElement>('#tripod-blocked')!
  const primaryBtn = sheet.querySelector<HTMLButtonElement>('#tripod-primary')!
  const closeBtn = sheet.querySelector<HTMLButtonElement>('#tripod-close')!

  /**
   * The echo under the two boxes: the reading restated, and the same length in
   * feet.
   *
   * The feet half is the only check that catches the failure this whole entry
   * is shaped around. A distance given in feet is arithmetically indetectable
   * downstream — a room 3.28x too big is a perfectly self-consistent room — so
   * the number is read back in the unit that would be wrong, where the person
   * holding the tape can see it disagree.
   */
  const renderEcho = () => {
    const reading = readSpotDistance(metresInput.value, cmInput.value)
    if (reading.ok) {
      echoEl.textContent = spotDistanceEcho(reading)
      echoEl.dataset.tone = 'ok'
      saveBtn.disabled = false
      return
    }
    echoEl.textContent = reading.empty ? '' : reading.reason
    echoEl.dataset.tone = reading.empty ? '' : 'warn'
    saveBtn.disabled = true
  }

  const render = () => {
    const guidance = stationGuidance(state)
    const verdict = finishVerdict(state)
    const done = state.spots.length
    // The measurement is asked once, at the first pause after the second spot,
    // and it takes the screen while it is being asked: both answers are one
    // tap, and leaving "carry on" visible beside them is how a question gets
    // answered by accident.
    const asking = shouldAskDistance(state)

    // The "why more than one spot" note is worth the whole top of the sheet
    // before the first spot exists, and is in the way after: from spot two on,
    // the operator is standing in a room holding a tripod and needs the step,
    // not the rationale they have already acted on. It comes back if the
    // capture is reset, which is the only time it is unread again.
    introEl.hidden = done > 0
    stepEl.textContent = guidance.step
    headlineEl.textContent = guidance.headline
    headlineEl.dataset.tone = guidance.tone
    detailEl.textContent = guidance.detail

    // One marker per planned spot, filled in as they are captured. The count
    // is the plan, not the photos: this is the row that answers "how much of
    // this is left to carry the tripod through".
    dotsEl.replaceChildren(...Array.from({ length: state.target }, (_, i) => {
      const li = document.createElement('li')
      li.textContent = String(i + 1)
      // Nothing is marked active while the tripod is being carried: no spot is
      // being worked then, and lighting up the next one contradicts the title
      // above it, which is still reporting the spot that just finished.
      const working = state.phase === 'ready' || state.phase === 'sweeping'
      li.dataset.state = i < done ? 'done' : i === done && working ? 'active' : ''
      return li
    }))

    tallySpotsEl.textContent = `${done} of ${state.target} spots`
    const photos = totalPhotos(state)
    tallyPhotosEl.innerHTML = `<b>${photos}</b> photo${photos === 1 ? '' : 's'}`

    measureEl.hidden = !asking || recovered !== null
    if (asking && recovered === null) renderEcho()

    // What this capture will know about its own size, said the moment the
    // answer exists and again on the screen that sends it — the last point at
    // which "nothing measured this" can still be acted on.
    const size = sizeVerdict(state)
    const showSize = state.measurement !== null && (state.phase === 'move' || state.phase === 'done')
    sizeEl.hidden = !showSize
    sizeEl.dataset.tone = size.trueToSize ? 'ok' : 'plain'
    sizeHeadlineEl.textContent = size.headline
    sizeDetailEl.textContent = size.detail

    // The way back from a skip. Offered rather than nagged: the question has
    // been answered, and this is the door left open beside the answer.
    reopenBtn.hidden = asking || state.phase === 'done' || state.measurement?.kind !== 'skipped'

    // The recovery banner outranks the measurement question: someone who has
    // just been handed back two spots has to know what they are before they are
    // asked to measure between them.
    recoveredEl.hidden = recovered === null
    if (recovered) {
      recoveredHeadlineEl.textContent =
        recoveryHeadline(recovered.spots, recovered.photos, recovered.savedAt, Date.now())
    }

    // The spots in hand, each with the way to throw it away. Hidden during a
    // sweep — photos are landing, and `state.spots` is not what is changing.
    const listable = canDropSpots(state) && !asking && recovered === null
    spotListEl.hidden = !listable
    // Emptied rather than left in place when it goes away: a hidden list still
    // has its rows, and the next thing to reveal it — or anything reading the
    // page aloud — would find a spot that has just been thrown away.
    if (!listable) spotListEl.replaceChildren()
    if (listable) {
      spotListEl.replaceChildren(...state.spots.map((spot, i) => {
        const li = document.createElement('li')
        const label = document.createElement('span')
        label.textContent = spotSummary(i, spot.photos)
        li.append(label)
        if (confirmDrop === i) {
          // The count that is about to be lost, then the two answers. A single
          // tap must not be able to destroy a sweep somebody walked to.
          const q = document.createElement('span')
          q.className = 'tripod-drop-q'
          q.textContent = dropSpotConfirm(i, spot.photos)
          const yes = document.createElement('button')
          yes.type = 'button'
          yes.className = 'tripod-drop-yes'
          yes.textContent = DROP_SPOT_CONFIRM_LABEL
          yes.addEventListener('click', () => discardSpot(i))
          const no = document.createElement('button')
          no.type = 'button'
          no.className = 'tripod-drop-no'
          no.textContent = DROP_SPOT_CANCEL_LABEL
          no.addEventListener('click', () => { confirmDrop = null; render() })
          li.append(q, yes, no)
        } else {
          const drop = document.createElement('button')
          drop.type = 'button'
          drop.className = 'tripod-drop-btn'
          drop.textContent = DROP_SPOT_LABEL
          drop.setAttribute('aria-label', `${DROP_SPOT_LABEL} ${spotSummary(i, spot.photos)}`)
          drop.addEventListener('click', () => { confirmDrop = i; render() })
          li.append(drop)
        }
        return li
      }))
    }

    // Said only when it is false. A capture that cannot be written down is
    // still a capture — it is just one that a locked screen can end.
    const unsaved = persisted === false && state.spots.length > 0 && state.phase !== 'done'
    storageEl.hidden = !unsaved
    storageEl.textContent = unsaved
      ? 'This capture is only in this tab — it could not be saved on this phone, so closing the app or reloading would lose it. Send it before you stop.'
      : ''

    const sweeping = state.phase === 'sweeping'

    // The preview is the honest half of the tally: it is on screen exactly
    // while a camera is open, and the line under it counts photos that have
    // been encoded and banked, not shutter clicks.
    cameraEl.hidden = !(sweeping && cameraLive)
    if (sweeping && cameraLive) paintCameraLine()

    // Offered exactly when a sweep is running and nothing is photographing it:
    // after a refusal, after a stall, and on a sheet re-opened mid-sweep. Never
    // beside a live camera, where it would read as a second shutter.
    cameraOnBtn.hidden = asking || !sweeping || cameraLive || recovered !== null

    // Still the import path, and still available during every sweep. It is the
    // way back from a refused camera and the way to finish a capture whose
    // photos were taken on something else, so it is never the camera's
    // replacement and never hidden by it — only its wording changes, so that
    // during a live sweep it does not read as the thing to press.
    addBtn.hidden = asking || !sweeping || recovered !== null
    addBtn.textContent = state.pending === 0
      ? "Add this spot's photos"
      : cameraLive
        ? `Add photos from the gallery too — ${state.pending} so far`
        : `Add more — ${state.pending} from this spot`

    sendBtn.hidden = asking || sending || state.phase === 'done' || !verdict.ok || recovered !== null
    sendBtn.textContent = `Send ${done} spots as one capture`

    primaryBtn.hidden = asking || sending || guidance.primary === null || recovered !== null
    primaryBtn.textContent = guidance.primary ?? ''
    closeBtn.textContent = state.phase === 'done' ? 'Close' : 'Continue later'

    // The refusal belongs on the screen where stopping is the live question —
    // the tripod is down, the sweep is finished, and "can I call it a day?" is
    // exactly what is being asked. Elsewhere it is stale advice, and it is the
    // short form because the long one is already on screen, four lines up.
    const blocked = notice ?? (!verdict.ok && state.phase === 'move' ? verdict.short : null)
    blockedEl.textContent = blocked ?? ''
    blockedEl.hidden = blocked === null
  }

  /**
   * The two lines under the preview: how many photos, and whether the view is
   * still moving.
   *
   * Repainted on its own timer as well as on every banked frame, because the
   * thing it has to be able to say is that NOTHING is happening — and a screen
   * that only redraws when a photo arrives cannot say that. The count is read
   * off the camera, which counts encodes that produced bytes.
   */
  const paintCameraLine = () => {
    cameraLineEl.textContent = sweepCountLine(camera.captured)
    const still = sweepMotionNotice(camera.viewStillMs)
    cameraStillEl.textContent = still ?? ''
    cameraStillEl.hidden = still === null
  }

  /**
   * A once-a-second repaint while the camera is open, and only then.
   *
   * Cleared in releaseCamera, so it cannot outlive the stream it reports on.
   */
  let cameraTicker: ReturnType<typeof setInterval> | null = null

  /**
   * Write the capture down.
   *
   * Called at every point the set of finished spots or the measurement changes,
   * and never during a sweep: the photos landing in `pendingFiles` belong to a
   * sweep nobody has watched finish, and storing them would let a restore bank
   * a spot the operator never accepted (see tripod-persistence.ts).
   *
   * `spot` is the one record that is new, if any — passing it is what keeps a
   * save O(1) instead of rewriting every spot's photos each time.
   */
  const persist = (spot?: { id: string, files: File[] }) => {
    // Nothing is written on a read-only page (MAIN10-2).
    if (readOnly) return
    const meta = tripodMetaOf(state, spotKeys, Date.now())
    void saveTripodCapture(meta, spot).then(ok => {
      // Only ever downgrades within a capture: one failed write means the
      // stored copy is already behind, whatever the next one does.
      if (persisted !== false) persisted = ok
      if (!ok) render()
    })
  }

  /**
   * Give the shared file input back.
   *
   * The claim is taken when "Add this spot's photos" is tapped and used to be
   * given up only when a pick actually came back — so a CANCELLED picker left
   * it held, and the next thing to open that same input had its files
   * swallowed by a sweep that was already over. Measured 2026-08-30: with the
   * sheet closed, choosing a video on the upload card uploaded nothing, and
   * the explanation was written onto a sheet nobody could see.
   *
   * Called wherever the sweep that took the claim stops being the thing on
   * screen. Never while a picker is genuinely open — the sheet is behind it,
   * so none of these can be reached until it closes.
   */
  const releaseIntake = () => { pendingPhotoIntake = null }

  /** Forget the capture, in memory and on disk. Every ending goes through here. */
  const resetCapture = () => {
    releaseIntake()
    state = createStationCapture()
    spotFiles = []
    spotKeys = []
    pendingFiles = []
    recovered = null
    confirmDrop = null
    persisted = null
    metresInput.value = ''
    cmInput.value = ''
    notice = null
    if (!readOnly) void clearTripodCapture()
  }

  /**
   * Throw one spot away — the photos with it, in memory and on disk.
   *
   * The gates are not touched, which is the point: `dropSpot` puts the state
   * back to what it would have been if that sweep had never happened, so a
   * capture that falls under three spots goes back to refusing to send, and a
   * measurement that was about a spot which no longer exists is asked for
   * again. Nothing here has to remember to keep them honest.
   */
  const discardSpot = (index: number) => {
    if (index < 0 || index >= state.spots.length) return
    const key = spotKeys[index]
    const before = state.spots.length
    state = dropSpot(state, index)
    if (state.spots.length === before) return   // refused; change nothing else
    spotFiles = spotFiles.filter((_, i) => i !== index)
    spotKeys = spotKeys.filter((_, i) => i !== index)
    confirmDrop = null
    notice = null
    if (key && !readOnly) void deleteTripodSpot(key)
    if (state.spots.length === 0) {
      // Nothing left to store, and an empty meta record would be recovered as
      // a capture on the next open.
      if (!readOnly) void clearTripodCapture()
      persisted = null
    } else {
      persist()
    }
    render()
  }

  /**
   * Put back whatever the last session left behind.
   *
   * Runs once, at mount, before the sheet has ever been opened, so the card is
   * already carrying a real capture the first time it is tapped. The state is
   * built from the FILES that came back rather than from the numbers in the
   * record — see restoreTripodCapture — so a partial write cannot produce a
   * sheet that counts spots it cannot upload.
   */
  const restore = async () => {
    const stored = await loadTripodCapture()
    if (!stored) return
    const back = restoreTripodCapture(stored.meta, stored.banks)
    if (!back) {
      // Meta with no usable photos behind it. Nothing to offer, and leaving it
      // there would make every future open try again. A read-only page leaves it
      // alone: the record may be the writer's capture, and this page only reads (MAIN10-2).
      if (!readOnly) void clearTripodCapture()
      return
    }
    // A capture in progress in THIS tab outranks anything on disk: the operator
    // is standing in a room with a tripod, and replacing what they are doing
    // with something from an hour ago would be the worst possible moment.
    if (state.spots.length > 0 || state.phase !== 'ready' || pendingFiles.length > 0) return
    state = back.state
    spotFiles = back.spotFiles
    spotKeys = back.spotKeys
    spotSeq = spotKeys.length
    persisted = true
    recovered = {
      spots: back.spotFiles.length,
      photos: back.spotFiles.reduce((n, files) => n + files.length, 0),
      savedAt: back.savedAt,
    }
    render()
  }

  /**
   * The sheet's camera. One instance for the whole capture, re-opened per
   * sweep — a second one could hold the device against the first.
   *
   * Its frames go exactly where the gallery picker's do: onto `pendingFiles`,
   * through `addPhotos`, committed by `endSweep`. Nothing downstream of this
   * closure can tell which of the two took a photo, which is why the uploader,
   * the spot labelling and the refusals all still work untouched.
   */
  const camera = new SweepCamera({
    onFrame: (file) => {
      pendingFiles = [...pendingFiles, file]
      state = addPhotos(state, 1)
      render()
    },
    onEnded: (reason, captured) => {
      cameraLive = false
      // The sweep itself is NOT ended here. The camera stopping is not the
      // operator deciding this spot is done, and ending the spot for them
      // would bank a sweep they never watched finish — so the phase stays
      // 'sweeping', the photos stay pending, and the line says what happened.
      notice = sweepEndNotice(reason, captured)
      render()
    },
  })

  /**
   * Close the camera. Every exit from a sweep goes through here.
   *
   * It redraws, because two of the four ways in here are not followed by a
   * render of their own — `pagehide` above all. Without it the sheet kept the
   * preview box and its "N photos taken from this spot" line on screen after
   * the stream was stopped, AND kept the button that reopens the camera
   * hidden: a page restored from the back/forward cache came back showing a
   * live camera that was not running, with no way to restart it. Measured
   * 2026-08-30 in headless Chromium — after a pagehide, both tracks read
   * 'ended' and `video.srcObject` was null while `#tripod-camera` was still
   * visible and `#tripod-camera-on` still hidden.
   *
   * The screen lock goes with it. See openCamera().
   */
  const releaseCamera = () => {
    camera.stop()
    cameraLive = false
    if (cameraTicker !== null) {
      clearInterval(cameraTicker)
      cameraTicker = null
    }
    void screenWakeLock.stop()
    render()
  }

  /**
   * Open the camera for the spot being swept.
   *
   * Always called straight out of a tap, because the permission prompt needs
   * that gesture, and it resolves long after the screen has redrawn — so the
   * only thing it does on the way back is report what happened.
   */
  const openCamera = () => {
    void camera.start(previewEl, currentSpot(state)).then(refusal => {
      cameraLive = refusal === null && camera.isRunning
      // Keep the screen up while the camera is banking frames, and only then.
      //
      // This is the most unattended capture in the app — the screen one step
      // back says "step out of the way", and nobody touches the phone again
      // until the sweep is over. The AR path already holds this lock for the
      // same reason, after a gimbal dome scan produced 0 keyframes across 10
      // converged positions because the screen locked partway through
      // (src/capture/wake-lock.ts). The same thing ends a sweep here: Android
      // backgrounds Chrome on lock, and a hidden page banks nothing
      // (sweep-cadence.ts's `hidden` branch). Measured 2026-08-30: a live
      // sweep with the camera open and six photos banked had requested zero
      // screen locks.
      //
      // The one lock is shared with the AR session, which is safe because the
      // two cannot run together — the tripod card lives on the start screen,
      // and starting AR removes it. `start()` is idempotent and `stop()` is a
      // no-op when nothing was acquired.
      if (cameraLive) void screenWakeLock.start()
      // The stillness line has to be able to appear while nothing else is
      // happening — that is the whole case it reports on.
      if (cameraLive && cameraTicker === null) {
        cameraTicker = setInterval(() => {
          if (cameraLive && state.phase === 'sweeping') paintCameraLine()
        }, 1000)
      }
      if (refusal) notice = refusal
      render()
    })
  }

  primaryBtn.addEventListener('click', () => {
    notice = null
    confirmDrop = null
    if (state.phase === 'ready') {
      state = beginSweep(state)
      // Opened from inside the tap, so the permission prompt is attributed to
      // a gesture. It resolves after the sheet has already redrawn as
      // 'sweeping': a refused camera leaves that screen exactly as it was
      // before this feature existed, with the import button and a sentence
      // saying why.
      openCamera()
    } else if (state.phase === 'sweeping') {
      // Before endSweep, so the count the sweep is judged on is final and no
      // frame can land in a spot that has already closed. The gallery's claim
      // on the shared input goes at the same moment and for the same reason:
      // a pick that comes back after this belongs to no sweep.
      releaseCamera()
      releaseIntake()
      const before = state.spots.length
      state = endSweep(state)
      // The files commit exactly where the count does. An empty sweep advances
      // nothing, so its (empty) pile is dropped and the spot stays open —
      // anything else would leave photos filed under a spot that does not
      // exist, which is the same lie in a different place.
      if (state.spots.length > before) {
        const key = newSpotKey(Date.now(), spotSeq++)
        spotFiles = [...spotFiles, pendingFiles]
        spotKeys = [...spotKeys, key]
        // Written the moment the count moves, and with exactly the photos the
        // count is of. This is the write the discarded tab cost: a spot that
        // exists only in a `let` is a spot Chrome may take at any moment.
        persist({ id: key, files: pendingFiles })
      }
      pendingFiles = []
    } else if (state.phase === 'move') state = nextSpot(state)
    render()
  })

  // Carrying on is an acknowledgement, not a change: the capture is already
  // restored, and this only takes the banner off the screen.
  recoveredKeepBtn.addEventListener('click', () => {
    recovered = null
    notice = null
    render()
  })

  // The other half of "obvious rather than silent". Someone who does not want
  // yesterday's half-capture must be able to say so in one tap, from the same
  // panel that told them about it.
  recoveredDropBtn.addEventListener('click', () => {
    resetCapture()
    render()
  })

  for (const box of [metresInput, cmInput]) box.addEventListener('input', renderEcho)

  saveBtn.addEventListener('click', () => {
    const reading = readSpotDistance(metresInput.value, cmInput.value)
    // Belt and braces: the button is disabled while the reading is not
    // acceptable, and a saved number that was never accepted would travel with
    // the capture as if it had been measured.
    if (!reading.ok) {
      renderEcho()
      return
    }
    notice = null
    state = recordDistance(state, reading.metres)
    if (state.spots.length > 0) persist()
    render()
  })

  skipBtn.addEventListener('click', () => {
    notice = null
    state = skipDistance(state)
    if (state.spots.length > 0) persist()
    render()
  })

  reopenBtn.addEventListener('click', () => {
    notice = null
    metresInput.value = ''
    cmInput.value = ''
    state = clearDistance(state)
    if (state.spots.length > 0) persist()
    render()
  })

  cameraOnBtn.addEventListener('click', () => {
    notice = null
    if (state.phase !== 'sweeping' || cameraLive) return
    openCamera()
    render()
  })

  addBtn.addEventListener('click', () => {
    notice = null
    // Claims the shared input for one pick. wireContentUpload()'s change
    // handler routes here instead of uploading while this is set.
    pendingPhotoIntake = (files) => {
      // The sweep this pick was opened for may be over by the time the picker
      // hands anything back — the picker was cancelled and the spot marked
      // finished, or the sheet was closed and something else opened the same
      // input. `addPhotos` already refuses outside a sweep; without the same
      // test HERE the two halves came apart, because `pendingFiles` was
      // appended to unconditionally while the count was not. The extra photos
      // then rode into whichever spot closed next, uncounted.
      //
      // Measured 2026-08-30 on this build: a sheet reading "12 photos from 3
      // spots" against a POST body carrying 15 files and a 15-entry `stations`
      // list. The tally, the stored spot and the upload have to be the same
      // number or none of them is worth anything.
      if (state.phase !== 'sweeping') {
        notice = 'That sweep had already finished, so those photos were not added to it. '
          + 'Start the sweep at this spot and add them again.'
        render()
        return
      }
      const photos = files.filter(file => file.type.startsWith('image/'))
      if (photos.length === 0) {
        // Nothing was added, so nothing may look as if it was: the tally and
        // the sweep both stay exactly where they were.
        notice = 'Those were not photos, so this spot is unchanged. Pick the images the sweep took.'
      } else {
        pendingFiles = [...pendingFiles, ...photos]
        state = addPhotos(state, photos.length)
        if (photos.length < files.length) {
          notice = `${files.length - photos.length} file(s) were not photos and were left out.`
        }
      }
      render()
    }
    input.click()
  })

  sendBtn.addEventListener('click', () => {
    notice = null
    const verdict = finishVerdict(state)
    if (!verdict.ok) {
      notice = `${verdict.headline}. ${verdict.detail}`
      render()
      return
    }
    if (sending) return

    // Handing the files back to the one uploader, rather than posting them
    // here: that handler already knows the Place target, the endpoint, the
    // progress percentage and every failure message. DataTransfer is how a
    // File[] becomes an input's FileList; if it is missing, say so instead of
    // pretending the capture went anywhere.
    if (typeof DataTransfer === 'undefined') {
      notice = 'This browser will not let the app hand the photos to the uploader. Use the upload card on the start screen and pick all of the spots’ photos together.'
      render()
      return
    }

    // What is new is what goes WITH them. The photos used to leave as one flat
    // set with no record of which spot each came from, so a capture the app
    // made itself was indistinguishable from a bag of holiday snaps: the
    // server could not refuse one taken from a single spot, and had nothing to
    // size the room with. Both ride on the same request as the photos.
    const frames = planStationFrames(spotFiles)
    const spots = spotFiles.length
    const size = sizeVerdict(state)
    sending = true
    pendingUploadExtras = {
      stations: stationsFor(frames),
      knownDistances: knownDistancesFor(state.measurement, spots),
      successLine: frameCount =>
        `Sent — ${frameCount || frames.length} photos from ${spots} spots. ${size.headline}.`,
      settle: (ok, message) => {
        sending = false
        // The capture has landed, so the copy on this phone is no longer the
        // only one — and keeping it would mean every sent capture's photos
        // stayed on the device forever. A failed send keeps everything.
        if (ok && !readOnly) void clearTripodCapture()
        // A refused or failed upload registered nothing, so nothing may look
        // as though it did: the capture stays exactly where it was, with the
        // same Send button and the same photos still in hand.
        notice = ok ? null : message
        if (ok) state = finishCapture(state)
        render()
      },
    }
    // The sheet is over the progress line under the cards, so it says the same
    // thing itself rather than leaving a screen with every button gone.
    notice = `Sending ${frames.length} photos from ${spots} spots…`
    const transfer = new DataTransfer()
    for (const file of filesFor(frames)) transfer.items.add(file)
    input.files = transfer.files
    render()
    input.dispatchEvent(new Event('change'))
  })

  closeBtn.addEventListener('click', () => {
    sheet.hidden = true
    // Focus goes back to the card that opened the sheet, not to the page top.
    card.focus()
    // The sheet is gone, so nothing is showing what the camera sees — leaving
    // it open would be a phone quietly filming a room with its preview closed,
    // and it is also what makes the next open fail.
    releaseCamera()
    releaseIntake()
    confirmDrop = null
    if (state.phase !== 'done') {
      // Closing part-way through is "continue later", and it now means it: the
      // finished spots are on disk, so this is the one path that got worse when
      // a tab was discarded and is now the same as any other pause.
      render()
      return
    }
    // Only a sent capture resets.
    resetCapture()
    render()
  })

  // The last way out. A page being discarded or navigated away from still
  // holds the camera until something stops it, and on Android that is the
  // state that makes the next open time out.
  addEventListener('pagehide', releaseCamera)

  const open = () => {
    notice = null
    render()
    sheet.hidden = false
    // Into the dialog, so a screen reader announces it. Close returns focus to the card.
    sheet.querySelector<HTMLElement>('.place-sheet-title')?.focus()
  }

  card.addEventListener('click', () => {
    // The picker is only wired deep inside main(), after the secure-context check, so an early
    // tap (or an insecure page) must still reach the loop rather than dying silently. A read-only
    // page is the exception: it opens no sweep, not even then (MAIN10-1, MAIN10-2).
    if (requestPlaceSelection) requestPlaceSelection(open, 'tripod')
    else if (!readOnly) open()
  })

  render()
  // After the first render, so a phone with slow storage shows the sheet's
  // start screen rather than nothing, and the recovered capture replaces it a
  // moment later with the banner saying where it came from.
  void restore()
}

function setCaptureBusy(busy: boolean): void {
  const btn = document.getElementById('capture-btn') as HTMLButtonElement | null
  if (!btn) return
  btn.classList.toggle('busy', busy)
  btn.disabled = busy
  btn.style.pointerEvents = busy ? 'none' : ''
  btn.setAttribute('aria-busy', String(busy))
  btn.setAttribute('aria-disabled', String(busy))
}

function clearAnalysisProgress(): void {
  document.getElementById('progress-bar-fill')?.classList.remove('analyzing')
  document.getElementById('progress-bar-wrap')?.classList.remove('visible')
}

function waitForTracking(provider: ARProvider, timeoutMs: number): Promise<boolean> {
  if (provider.isTracking()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = () => {
      if (provider.isTracking()) {
        resolve(true)
        return
      }
      if (performance.now() - started >= timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * The camera's own <video> element, when it has a frame worth measuring.
 *
 * The 8th Wall engine renders the getUserMedia stream into a <video>, which is
 * the same element the aspect diagnostic in `eighthwall.ts` reads. A
 * getUserMedia stream does not taint a canvas, so drawing it into an
 * OffscreenCanvas and reading the pixels back is allowed.
 *
 * Deliberately NOT the AR canvas. That is a WebGL surface without
 * `preserveDrawingBuffer`, so reading it outside a rAF callback — and this is
 * called from a 750 ms setInterval — returns a cleared buffer. It would report
 * black on a perfectly lit room, which is the precise false alarm this feature
 * must never raise. A native WebXR session has no accessible passthrough video
 * at all, so this simply returns null there and no lighting claim is made.
 */
function cameraLightSource(): HTMLVideoElement | null {
  const video = document.querySelector('video')
  if (!video) return null
  // HAVE_CURRENT_DATA. Before that, drawImage paints nothing and the frame
  // measures as pure black — indistinguishable from a dark room.
  if (video.readyState < 2 || video.videoWidth === 0) return null
  return video
}

/**
 * Show a pre-tap preflight verdict on the start screen.
 *
 * Reuses the two lines that screen already has for this — the Start button's
 * `.start-path-status` sub-label and `#ar-help` — rather than introducing an
 * overlay. `#ar-help` sits directly beside the cards that need no AR runtime,
 * which is where `routeToUpload` is pointing. It says what those paths ARE
 * rather than naming one: renderCaptureChoice() writes their labels per
 * subject, so preflight.ts, which has no subject, names none.
 */
function applyPreflightToStartScreen(verdict: PreflightVerdict): void {
  if (verdict.outcome === 'unavailable') {
    setStartButtonState('unavailable', verdict.headline)
  } else if (verdict.canScan) {
    // Reached only after an AR runtime was actually created (section 3), so
    // this is a good deal more than the API answering yes — enough to offer
    // "walk the room instead" to someone about to upload. Still not a promise:
    // if the session then fails, the start-failure path downgrades it above.
    scanCapability = 'available'
  }
  // `caveat` and not `canScan`: the case worth showing is a verdict that says
  // yes and should still be read — a browser advertising AR support on a device
  // with no AR service behind it. A phone that is simply going to work gets a
  // clean start screen.
  if (!verdict.caveat) return
  const help = document.getElementById('ar-help')
  if (help) {
    help.textContent = verdict.detail
    help.hidden = false
  }
}

/**
 * The headline of the pending verdict for a camera prompt nobody has answered
 * (cameraPendingVerdict() in src/ar/eighthwall.ts). PreflightVerdict has no field
 * that names the wait, so it is matched by headline. Keep the two in step.
 */
const CAMERA_WAIT_HEADLINE = 'Waiting for camera permission'

/**
 * Act on a verdict from the runtime's own first-frame watchdog.
 *
 * Capture controls are NOT disabled here, even on `'unavailable'`. The start()
 * catch disables them because AR provably failed; this verdict is inferred from
 * an absence on a timer, and a false positive there would tear down a working
 * session. Saying the true thing loudly, and leaving the controls alone, is the
 * asymmetry worth taking — and a late pose re-fires this with `'ready'`, which
 * is why the banner is cleared rather than left standing.
 */
function applyPreflightVerdict(
  verdict: PreflightVerdict,
  overlay: { setStatus(text: string, priority?: StatusPriority): void },
): void {
  // The camera prompt may still be open, so an earlier refusal on the overlay is
  // stale: say what is awaited. The first-frame wait has a different headline and
  // leaves the overlay alone.
  if (verdict.outcome === 'warming-up' && verdict.headline === CAMERA_WAIT_HEADLINE) {
    overlay.setStatus(CAMERA_WAIT_HEADLINE, 'sticky')
  }
  // A pending verdict says nothing either way, so the banner stays as it is.
  if (verdict.outcome === 'warming-up') return
  if (verdict.outcome === 'ready') {
    // Only take back a banner this function put up. The healthy path emits
    // 'ready' at the 5 s mark on every good session, and #permission-error-banner
    // is shared — beginArSession() writes the motion/orientation denial notice
    // into it, which is still true and still worth reading after a pose arrives.
    if (preflightBannerShown) {
      const banner = document.getElementById('permission-error-banner')
      if (banner) banner.style.display = 'none'
      preflightBannerShown = false
    }
    return
  }
  // 'sticky' because this is the answer to "why is nothing happening" and it
  // must survive the next 750 ms of scanner-tick chatter.
  overlay.setStatus(verdict.headline, 'sticky')
  if (verdict.routeToUpload) {
    showPermissionBanner(verdict.detail, verdict.headline)
    preflightBannerShown = true
  }
}

function shortName(filename: string): string {
  return filename.replace(/^\d+_/, '').replace(/\.glb$/, '')
}

function updateQualityOverlay(snap: import('./capture/quality-monitor').QualitySnapshot): void {
  const overlay = document.getElementById('quality-overlay')
  if (!overlay) return

  const coverageFill = overlay.querySelector<HTMLElement>('#quality-coverage-fill')
  const coverageText = overlay.querySelector<HTMLElement>('#quality-coverage-text')
  const driftBadge   = overlay.querySelector<HTMLElement>('#quality-drift-badge')
  const lightBadge   = overlay.querySelector<HTMLElement>('#quality-light-badge')
  const reflBadge    = overlay.querySelector<HTMLElement>('#quality-refl-badge')
  const missingText  = overlay.querySelector<HTMLElement>('#quality-missing')
  const motionHint   = overlay.querySelector<HTMLElement>('#quality-motion-hint')

  if (coverageFill) {
    const pct = Math.round(snap.coverageScore * 100)
    coverageFill.style.width = `${pct}%`
    coverageFill.style.background = pct >= 80 ? '#4ade80' : pct >= 50 ? '#ffa726' : '#ef7070'
  }
  if (coverageText) coverageText.textContent = snap.coverageText

  if (driftBadge) {
    driftBadge.style.display = snap.driftRisk !== 'low' ? 'flex' : 'none'
    driftBadge.textContent = snap.driftRisk === 'high' ? '⚡ Fast' : '↗ Speed'
  }

  // The long form of what the drift badge abbreviates, plus the tracking-lost
  // case the badge has no glyph for. Lives here rather than in #status-text
  // because it is refreshed on every 750 ms scanner tick — exactly the
  // property that made it erase every capture result and error message.
  if (motionHint) {
    // One function picks this line (quality-monitor.ts `motionHintText`), so
    // the signals cannot fight over the element. They used to: a dark room
    // where tracking never acquired printed "Tracking lost — move slowly",
    // advice that was not merely unhelpful but wrong — moving slowly in the
    // dark was never going to produce a pose.
    const motionText = motionHintText({
      lighting: snap.lighting,
      trackingLost: snap.trackingLost,
      driftRisk: snap.driftRisk,
    })
    // aria-live, so an unconditional per-tick write would re-announce the same
    // sentence twice a second. Same reasoning as updateVerdictUI().
    if (motionText !== lastMotionHint) {
      lastMotionHint = motionText
      motionHint.textContent = motionText
      motionHint.style.display = motionText ? 'block' : 'none'
    }
  }
  if (lightBadge) lightBadge.style.display = snap.lowLight ? 'flex' : 'none'
  if (reflBadge)  reflBadge.style.display  = snap.reflectiveSurface ? 'flex' : 'none'
  if (missingText) {
    missingText.style.display = snap.missingAreas > 0 ? 'block' : 'none'
    missingText.textContent = `${snap.missingAreas} area${snap.missingAreas === 1 ? '' : 's'} missing`
  }

  overlay.style.display = 'flex'
}

/**
 * How long the 8th Wall engine gets to set `window.XR8` once xr.js has arrived.
 *
 * Generous on purpose. The `slam` chunk the page preloads (public/xr-slam.js) is
 * ~5.5 MB, and a slow phone link can take far longer than a short timer allows
 * to fetch it and for the engine to set XR8. The cost of
 * waiting too long is a slower fallback on a device that genuinely lacks the
 * engine; the cost of waiting too little is a scanner that refuses to start.
 */
const XR8_LOAD_TIMEOUT_MS = 90_000

/**
 * Ceiling on the whole 8th Wall wait, download included, on the page's own clock.
 * performance.now() starts with the page, and index.html requests xr.js during that
 * page load, so this is counted from the request to within the HTML parse. The
 * XR8_LOAD_TIMEOUT_MS window only starts once xr.js has arrived, so a request that
 * stalls without an error would otherwise never settle and the scanner would sit on
 * "Loading AR engine…". 150 s: about a minute for the 5.5 MB download on a slow link,
 * then the engine window. A stalled request settles as 'timeout' by then, which shows
 * the reload message.
 */
const XR8_OVERALL_TIMEOUT_MS = 150_000

/**
 * Wait for the 8th Wall engine, driven by xr.js's own state rather than a timer
 * started at the request. index.html marks the script `dataset.state`: 'loading',
 * then 'loaded' or 'error'. So:
 *  - while xr.js is still downloading, only the overall ceiling can end the wait;
 *  - an xr.js that fails to load is a real error, and falls back at once;
 *  - once it has arrived, the engine gets `timeoutMs` to set XR8;
 *  - and nothing waits past XR8_OVERALL_TIMEOUT_MS on the page clock.
 * It ends 'ready', 'failed' or 'timeout', never 'absent' (see XR8Load): that state is for a
 * page that does not wait at all.
 */
function waitForXR8(timeoutMs: number): Promise<XR8Load> {
  return new Promise((resolve) => {
    const engineReady = () => typeof (window as unknown as Record<string, unknown>)['XR8'] !== 'undefined'
    if (engineReady()) {
      resolve('ready')
      return
    }
    const script = document.querySelector<HTMLScriptElement>('script[src="/xr.js"]')
    // Armed when xr.js stops loading. A page with no xr.js script (the mock) has
    // nothing to wait for, so its ceiling starts now.
    let armedAt: number | null = script?.dataset['state'] === 'loading' ? null : Date.now()
    // Poll as well as listen. `xrloaded` is a one-shot event, so a listener
    // attached after it fired never hears it — and the engine's own bootstrap
    // is async, which makes that race real rather than theoretical. The poll
    // makes arrival detectable however it happened.
    const poll = setInterval(() => {
      if (engineReady()) {
        settle('ready')
        return
      }
      const state = script?.dataset['state']
      if (state === 'error') {
        console.warn('[main] xr.js failed to load — falling back')
        settle('failed')
        return
      }
      // The overall ceiling. It covers a download that is still 'loading' as well as an
      // engine that arrived and never set XR8, so a stalled request cannot hold the scanner.
      if (performance.now() >= XR8_OVERALL_TIMEOUT_MS) {
        console.warn(
          `[main] 8th Wall engine not ready ${XR8_OVERALL_TIMEOUT_MS} ms after page load — falling back.`,
        )
        settle('timeout')
        return
      }
      if (armedAt === null && state !== 'loading') armedAt = Date.now()
      if (armedAt !== null && Date.now() - armedAt >= timeoutMs) {
        console.warn(
          `[main] 8th Wall engine did not set XR8 within ${timeoutMs} ms of xr.js arriving — falling back.`,
        )
        settle('timeout')
      }
    }, 250)

    function settle(result: XR8Load) {
      clearInterval(poll)
      window.removeEventListener('xrloaded', onLoaded)
      resolve(result)
    }
    function onLoaded() {
      settle('ready')
    }
    window.addEventListener('xrloaded', onLoaded, { once: true })
  })
}

/**
 * The web runtime a native session falls back to: 8th Wall when its engine loads, otherwise
 * WebXR. The same order the scanner uses when there is no native layer. The 8th Wall configuration
 * (xr.js, its load timeout, its provider) is unchanged; native only chooses to wait for it later.
 *
 * "Loads" is `ready` and nothing else: waitForXR8 answers a state, and `failed` and `timeout` are strings, so a test for
 * truth lets them through. createEighthWallProvider waits for the engine's `xrloaded` with no bound of its own, so asked
 * for an engine that is not coming it never settles, and neither does the start that is waiting for this.
 */
async function createWebRuntimeProvider(): Promise<ARProvider> {
  if ((await waitForXR8(XR8_LOAD_TIMEOUT_MS)) === 'ready') {
    try {
      return await createEighthWallProvider()
    } catch (e) {
      console.warn('[main] 8th Wall init failed, falling back to WebXR:', e)
    }
  }
  return createWebXRProvider()
}

/**
 * The runtime that is giving a session its poses and hits, in the words the `?debug=probe` line records as `rt`
 * (src/capture/probe-log.ts): `native` while the ARKit / ARCore session runs, and the web runtime that took over after a native
 * session failed to start, which createWebRuntimeProvider chooses between: `webxr` or `8thwall`. A page with no native layer is
 * whichever web runtime it chose at the start. `use8thWall` is set where 8th Wall is chosen at the start, so it says nothing about
 * a hand-over, and it used to be all this line asked, which called every native run `webxr`.
 */
function probeRuntimeLabel(provider: ARProvider, use8thWall: boolean): 'native' | '8thwall' | 'webxr' {
  if (provider instanceof NativeARProvider) {
    const web = provider.webRuntime()
    if (!web) return 'native'
    return web instanceof WebXRProvider ? 'webxr' : '8thwall'
  }
  return use8thWall ? '8thwall' : 'webxr'
}

/**
 * Points the runtime-switch nav button at the other AR engine. 8th Wall is
 * the default; the WebXR toggle is only shown when this browser can actually
 * run an `immersive-ar` session (`webxrSupported`) — otherwise it's hidden
 * rather than sending the user to a dead-end landing page. A WebXR session
 * always links back to the 8th Wall scanner.
 */
function updateXrModeLink(use8thWall: boolean, webxrSupported: boolean): void {
  const link = document.getElementById('xr-mode-link') as HTMLAnchorElement | null
  if (!link) return
  if (use8thWall) {
    if (!webxrSupported) {
      link.style.display = 'none'
      return
    }
    link.style.display = ''
    link.href = '/?ar=webxr'
    link.title = 'Switch to WebXR scanner'
    link.setAttribute('aria-label', 'Switch to WebXR scanner')
    link.classList.remove('active')
  } else {
    link.style.display = ''
    link.href = '/'
    link.title = 'WebXR mode active — switch back to 8th Wall scanner'
    link.setAttribute('aria-label', 'Switch to 8th Wall scanner')
    link.classList.add('active')
  }
}

let _inferDialogTimer: ReturnType<typeof setTimeout> | null = null

function showInferDialog(dets: Array<{ label: string; description: string; confidence: number; worldPos: { x: number; y: number; z: number } }>): void {
  const dialog = document.getElementById('infer-dialog')
  const body   = document.getElementById('infer-dialog-body')
  const close  = document.getElementById('infer-dialog-close')
  if (!dialog || !body) return

  if (!close?.dataset['bound']) {
    close?.addEventListener('click', () => hideInferDialog())
    if (close) close.dataset['bound'] = '1'
  }

  // Tap-to-dismiss: clicking anywhere on the dialog dismisses it
  if (!dialog.dataset['tapBound']) {
    dialog.addEventListener('click', (e) => {
      // Don't dismiss if user is scrolling the body content
      if (e.target === body || body.contains(e.target as Node)) return
      hideInferDialog()
    })
    dialog.dataset['tapBound'] = '1'
  }

  if (dets.length === 0) return

  // `label` and `description` come straight from the inference engine. A real VLM
  // (ollama/onnx) can emit angle brackets or stray markup, so they are set as text
  // nodes rather than interpolated into innerHTML — otherwise a reply containing
  // markup renders as a broken/blank row instead of the text the model returned.
  body.replaceChildren()
  for (const d of dets) {
    const p = d.worldPos

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);'

    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;'
    const label = document.createElement('span')
    label.style.cssText = 'color:#fff;font-size:13px;font-weight:700;'
    label.textContent = d.label
    const conf = document.createElement('span')
    conf.style.cssText = 'color:rgba(255,255,255,0.4);font-size:11px;font-family:monospace;'
    conf.textContent = `${Math.round(d.confidence * 100)}%`
    head.append(label, conf)

    const desc = document.createElement('p')
    desc.style.cssText = 'color:rgba(255,255,255,0.55);font-size:12px;line-height:1.4;margin:0;'
    desc.textContent = d.description

    const pos = document.createElement('span')
    pos.style.cssText = 'color:rgba(255,255,255,0.25);font-size:10px;font-family:monospace;'
    pos.textContent = `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`

    row.append(head, desc, pos)
    body.appendChild(row)
  }

  // Add a "tap to dismiss" hint at the bottom
  const hint = document.createElement('div')
  hint.style.cssText = 'text-align:center;padding:6px 0 2px;color:rgba(255,255,255,0.25);font-size:10px;'
  hint.textContent = 'tap to dismiss'
  body.appendChild(hint)

  dialog.classList.add('visible')

  if (_inferDialogTimer) clearTimeout(_inferDialogTimer)
  _inferDialogTimer = setTimeout(() => hideInferDialog(), 4000)
}

function hideInferDialog(): void {
  document.getElementById('infer-dialog')?.classList.remove('visible')
  if (_inferDialogTimer) { clearTimeout(_inferDialogTimer); _inferDialogTimer = null }
}

/**
 * Send a request to the server's /process-scan endpoint.
 *
 * Passes `filename` explicitly when this tab has one — the GLB it most
 * recently uploaded — rather than relying on `sessionId` alone to resolve it.
 * `store.sessionId` may be a `local-…` placeholder (no keyframe session was
 * ever opened, the common case for a plain export), and since
 * src/export/gltf.ts now writes `null` server-side for exactly that case, a
 * raw local id sent here could never match anything: `findFilenameBySessionId`
 * does a plain string comparison against the stored value, so a `local-…`
 * string sent by the client can never equal a stored `null`, and the request
 * would silently fall through to the server's "most recently uploaded by
 * anyone" fallback — reopening the cross-session misattribution this
 * function's `filename`-avoidance was originally written to prevent.
 * `filename` is an unambiguous identifier the server already accepts and
 * prefers over the `sessionId` lookup, so use it when we have it; `sessionId`
 * is still sent, filtered to the shape the server would actually recognize,
 * as a fallback for the case this tab has no filename yet.
 */
async function requestServerProcessing(action: string, store: DetectionStore, filename: string | undefined): Promise<void> {
  const overlay = setupStatusOverlay()
  overlay.setStatus(`Processing: ${action}…`)
  try {
    const resp = await fetch(apiUrl('/process-scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        filename,
        sessionId: isServerSessionId(store.sessionId) ? store.sessionId : undefined,
      }),
    })
    if (!resp.ok) throw new Error(`/process-scan returned ${resp.status}`)
    const result = await resp.json() as { action: string; result: string }
    overlay.setStatus(`✓ Done\n• ${result.action}`)
    console.log('[process]', result)
    showProcessingResult(result)
  } catch (err) {
    overlay.setStatus('✕ Processing failed')
    console.error('[process]', err)
  }
}

function showProcessingResult(result: { action: string; result: string }): void {
  const dialog = document.getElementById('infer-dialog')
  const body   = document.getElementById('infer-dialog-body')
  const title  = document.getElementById('infer-dialog-title')
  if (!dialog || !body || !title) return

  title.textContent = `Server: ${result.action}`
  // textContent: the text is built from scan labels, which are model output and may carry markup.
  const text = document.createElement('div')
  text.style.cssText = 'color:rgba(255,255,255,0.8);font-size:13px;line-height:1.6;white-space:pre-wrap;'
  text.textContent = result.result
  body.replaceChildren(text)
  dialog.classList.add('visible')
  if (_inferDialogTimer) clearTimeout(_inferDialogTimer)
  _inferDialogTimer = setTimeout(() => hideInferDialog(), 15_000)
}

main().catch((e: unknown) => {
  console.error('[main]', e)
  const el = document.getElementById('status-text')
  if (el) el.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`
  // Boot died. If it got as far as section 0 the button is enabled but its
  // handler leads nowhere; if it died before that it is still pulsing
  // "Preparing…" for a boot that will never finish. Either way, say so.
  setStartButtonState('unavailable', 'Start failed — reload the page')
})

// ─── Geo indicator (inside the unified top-left HUD) ─────────────────────────

function updateGeoIndicator(fix: GeoFix): void {
  const chip    = document.getElementById('geo-chip') as HTMLElement | null
  const address = document.getElementById('geo-address')
  const coords  = document.getElementById('geo-coords')
  const needle  = document.getElementById('compass-needle') as SVGGElement | null
  if (!chip) return

  chip.style.display = 'flex'
  if (address) address.textContent = fix.address ?? `${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}`
  if (coords) {
    coords.textContent = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} ±${Math.round(fix.accuracy)}m`
    // Kept in the DOM and up to date either way — armed, it is a live readout;
    // unarmed, it costs no height. See the #geo-coords rule in index.html for
    // why the height matters.
    coords.classList.toggle('debug-armed', new URLSearchParams(location.search).get('debug') === 'geo')
  }

  if (needle && fix.bearing !== null) {
    needle.style.transform = `rotate(${fix.bearing}deg)`
  }
}

/**
 * The origin's heading as a compass bearing (wave 12, ticket 0001): a second,
 * hollow needle beside the device's, so the two readings can be told apart. It
 * shows only after this scan commits an origin with a compass fix, and is hidden
 * otherwise, including when the calibration it describes is dropped
 * (`dropCalibrationDrawings`). The device needle in `updateGeoIndicator` is untouched.
 */
function setFrameHeadingNeedle(bearingDeg: number | null): void {
  const needle = document.getElementById('compass-frame-needle') as SVGGElement | null
  const label = document.getElementById('geo-frame')
  if (bearingDeg === null) {
    if (needle) needle.style.display = 'none'
    if (label) label.style.display = 'none'
    return
  }
  if (needle) {
    needle.style.display = ''
    needle.style.transform = `rotate(${bearingDeg}deg)`
  }
  if (label) {
    label.style.display = ''
    // A bearing that rounds up to 360 reads 0, as the compass readout does (`formatCompassSpin`).
    label.textContent = `frame heading ${Math.round(bearingDeg) % 360}°`
  }
}

// ─── Drawer geo-map (Leaflet, lazy init on first open) ─────────────────────────

// Types come from the already-vendored @types/leaflet rather than hand-rolled
// structural subsets (ADR 0001 — the same collapse foundation-updates/0005 and /0007 did).
let _geoMap: import('leaflet').Map | null = null
let _geoMapReady = false
let _currentMarker: import('leaflet').Marker | null = null

/**
 * Called by SessionHistory when the drawer opens.
 * Lazy-creates a Leaflet map, shows the current GPS fix, and plots
 * all server-side scan locations as markers.
 */
async function initDrawerGeoMap(fix: GeoFix | null): Promise<void> {
  // Dynamic import: Leaflet is bundled, but only fetched when the drawer first opens.
  let L: typeof import('leaflet')
  try {
    const [lib] = await Promise.all([
      import('leaflet'),
      import('leaflet/dist/leaflet.css'),
    ])
    L = lib
  } catch (e) {
    console.error('[geo-map] Leaflet load failed:', e)
    return
  }

  const container = document.getElementById('geo-map')
  const placeholder = document.getElementById('geo-map-placeholder')

  if (!container) return

  if (!_geoMapReady) {
    // Determine initial view center
    const center: [number, number] = fix ? [fix.lat, fix.lng] : [51.505, -0.09]
    const zoom = fix ? 16 : 3

    // The tiles are whatever the Scan server names, and none by default: pins on a blank canvas,
    // with a line saying so (src/geo/tile-source.ts, src/geo/basemap-layer.ts).
    const map = L.map(container, { zoomControl: false, attributionControl: true })
    map.setView(center, zoom)
    void import('./geo/basemap-layer')
      .then(({ attachBasemap }) => attachBasemap({ L, map }))
      .catch((e: unknown) => console.error('[geo-map] basemap load failed:', e))

    // Current location marker — custom pulsing dot
    if (fix) {
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:12px;height:12px;background:#80ffe1;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 4px rgba(128,255,225,0.3)"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      })
      _currentMarker = L.marker([fix.lat, fix.lng], { icon }).addTo(map)
    }

    _geoMap = map
    _geoMapReady = true

    if (placeholder) placeholder.style.display = 'none'

    // Fetch + plot all stored scan locations
    void fetch(apiUrl('/scan-locations'), { signal: AbortSignal.timeout(5000) }).then(async (r) => {
      if (!r.ok) return
      const locations = await r.json() as Array<{ lat: number; lng: number; filename: string; address: string | null }>
      for (const loc of locations) {
        const scanIcon = L.divIcon({
          className: '',
          html: '<div style="width:8px;height:8px;background:#ef7070;border-radius:50%;border:1.5px solid #fff;"></div>',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        })
        const marker = L.marker([loc.lat, loc.lng], { icon: scanIcon })
        // A text node, not markup: the address is whatever a scan was labelled with.
        const popupText = document.createElement('b')
        popupText.textContent = loc.address ?? loc.filename
        marker.bindPopup(popupText, { maxWidth: 200 })
        marker.addTo(map)
      }
    }).catch(() => {/* server may be off */})
  } else if (_geoMap) {
    // Already created — just update current position if we have a fresh fix
    _geoMap.invalidateSize()
    if (fix && _currentMarker) {
      _currentMarker.setLatLng([fix.lat, fix.lng])
    }
    if (fix) _geoMap.setView([fix.lat, fix.lng], 16)
  }
}

/**
 * @param title Heading. Defaults to the permission wording because the original
 *   callers ARE permission denials — but this banner is also the surface for
 *   preflight verdicts, and a device that granted the camera and then produced
 *   no frame was being told "Permission Access Required". That sends someone to
 *   Settings to fix something that is not broken: `Camera status: hasStream`
 *   succeeded on every one of those runs.
 *
 *   A runtime failure passes its own title (beginArSession: "AR did not start").
 *   Each line of `message` is shown on its own line, and a leading bullet marker
 *   is dropped: this banner is plain text, and a raw bullet in it reads as a typo.
 */
function showPermissionBanner(message: string, title = 'Permission Access Required'): void {
  const banner = document.getElementById('permission-error-banner')
  const msgEl = document.getElementById('permission-error-msg')
  const titleEl = document.getElementById('permission-error-title')
  if (banner && msgEl) {
    msgEl.textContent = ''
    message.split('\n').forEach((line, i) => {
      if (i > 0) msgEl.append(document.createElement('br'))
      msgEl.append(line.replace(/^•\s*/, ''))
    })
    if (titleEl) titleEl.textContent = title
    banner.style.display = 'block'
  }
}

/**
 * Disables the buttons that start or extend a capture — the only ones whose
 * static markup implies a live AR session is actually feeding them. Their
 * click handlers are wired in section 4, unconditionally, before `provider
 * .start()` runs — so without this a failed start left them fully
 * interactive and able to open a server session that no frame would ever
 * reach. `disabled` is enough on its own: browsers suppress click events,
 * including scripted ones, on a disabled <button>.
 *
 * Navigation-only controls (viewer-link, gimbal-link, panel-toggle,
 * finish-scan-btn/"Details") are deliberately left alone — they don't imply a
 * running session and Export/History stay useful for whatever was captured
 * before the failure, if anything was.
 */
function disableCaptureControls(reason: string): void {
  for (const id of ['capture-btn', 'stream-btn', 'auto-capture-btn', 'person-capture-btn']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null
    if (!btn) continue
    btn.disabled = true
    btn.title = reason
  }
}
