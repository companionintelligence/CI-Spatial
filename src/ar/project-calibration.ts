import * as THREE from 'three'
import type { ARProvider, HitResult } from './provider'
import type { Project, ProjectSpatialFrame, ScanCalibration, Vec3 } from '../world/types'
import {
  anchorToProjectTransform,
  twoPointToProjectTransform,
  twoPointSeparationM,
  MIN_POINT_SEPARATION_M,
  DEFAULT_SEPARATION_TOLERANCE_M,
} from '../world/geo'
import { buildAnchorMarker, ANCHOR_RADIUS_M } from '../world/anchor-marker'
import { isSameHeightRetry, isTapOnGround, tapHeightAboveGroundCm } from './ground-gate'

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
}

interface CalibrationOptions {
  provider: ARProvider
  project: Project
  /** The live AR canvas — tap position is read from real touch events on it. */
  canvas: HTMLCanvasElement
  /** Hit-tests a real screen tap (normalised 0-1 coords), not a fixed reticle. */
  hitTest: (x: number, y: number) => Promise<HitResult | null>
  /**
   * True-north bearing in degrees, sampled fresh at tap time via a getter
   * rather than a snapshot — it can change between when this modal opens and
   * when the user actually taps. Null when the compass has no fix yet.
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
  ground: () => { y: number; locked: boolean } | null
}

type Stage = 'ground' | 'landmark' | 'heading' | 'review' | 'mismatch'
type MarkerId = 'landmark' | 'heading'

const MARKER_IDS: MarkerId[] = ['landmark', 'heading']

/**
 * How far the heading marker's own measured height may sit from the
 * landmark's before the pair is called into question, in metres.
 *
 * Both markers are floor taps, so their raw heights should agree to within
 * hit-test noise. A larger disagreement is real evidence that one of them
 * landed on something that is not the floor — a step, a rug edge, a chair
 * rail — which the frame would otherwise absorb silently.
 *
 * **Adopted by decision, not by measurement** — ticket 0006 closed without
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
 * Floor-plane overlay extent, in metres, and its subdivision count.
 *
 * 10 m at 20 divisions gives 0.5 m cells, which is deliberate on two counts:
 * the grid stays legible at room scale, and the cells double as a distance
 * gauge — two cells is `MIN_POINT_SEPARATION_M`, so a user can see whether
 * they have walked far enough for the heading marker without reading a number.
 */
const FLOOR_GRID_SIZE_M = 10
const FLOOR_GRID_DIVISIONS = 20

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
  /** The stored reference this session can actually be measured against. */
  const storedTwoPoint = existingFrame?.method === 'two-point-ground' ? existingFrame : null

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
   * is a fresh attempt and is gated normally.
   */
  let offGroundTapY: number | null = null

  let stage: Stage = 'ground'
  const points: Record<MarkerId, Vec3 | null> = { landmark: null, heading: null }
  let selected: MarkerId | null = null
  /** Residual that triggered the mismatch stage, in metres. */
  let mismatchResidualM = 0
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

  const overlay = document.createElement('section')
  overlay.id = 'project-calibration'
  overlay.innerHTML = `
    <div class="project-calibration-backdrop"></div>
    <div class="project-calibration-card" role="dialog" aria-modal="true" aria-labelledby="project-calibration-title">
      <div class="project-calibration-eyebrow">Project alignment</div>
      <ol id="project-calibration-steps" class="project-calibration-steps">
        <li data-step="ground">Ground</li>
        <li data-step="landmark">Landmark</li>
        <li data-step="heading">Heading</li>
      </ol>
      <h2 id="project-calibration-title">${isFirstCalibration ? 'Set this project&apos;s world frame' : 'Align this scan to the project'}</h2>
      <p id="project-calibration-copy">Tap a spot on the ground to mark this project&apos;s origin.</p>
      <div id="project-calibration-status" class="project-calibration-status">Waiting for AR tracking...</div>
      <div id="project-calibration-separation" class="project-calibration-separation" hidden></div>
      <div class="project-calibration-actions">
        <button id="project-calibration-confirm" type="button" class="project-calibration-link project-calibration-link-promoted" hidden>Confirm landmark</button>
        <button id="project-calibration-commit" type="button" class="project-calibration-link project-calibration-link-promoted" hidden>Use this alignment</button>
        <button id="project-calibration-replace" type="button" class="project-calibration-link" hidden>Re-place points</button>
        <button id="project-calibration-override" type="button" class="project-calibration-link" hidden>Use anyway</button>
        <button id="project-calibration-skip-ground" type="button" class="project-calibration-link project-calibration-link-promoted" hidden>Place anchor without floor check</button>
        <button id="project-calibration-fallback" type="button" class="project-calibration-link" hidden>Use one point instead (less accurate)</button>
        <button id="project-calibration-skip" type="button" class="project-calibration-link">Continue uncalibrated</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const pick = <T extends HTMLElement>(id: string) => overlay.querySelector<T>(`#${id}`)!
  const steps = pick<HTMLElement>('project-calibration-steps')
  const title = pick<HTMLElement>('project-calibration-title')
  const copy = pick<HTMLElement>('project-calibration-copy')
  const status = pick<HTMLElement>('project-calibration-status')
  const separationEl = pick<HTMLElement>('project-calibration-separation')
  const confirmBtn = pick<HTMLButtonElement>('project-calibration-confirm')
  const commitBtn = pick<HTMLButtonElement>('project-calibration-commit')
  const replaceBtn = pick<HTMLButtonElement>('project-calibration-replace')
  const overrideBtn = pick<HTMLButtonElement>('project-calibration-override')
  const skipGround = pick<HTMLButtonElement>('project-calibration-skip-ground')
  const fallbackBtn = pick<HTMLButtonElement>('project-calibration-fallback')
  const skip = pick<HTMLButtonElement>('project-calibration-skip')

  // ── Scene decals ────────────────────────────────────────────────────────
  // Everything placed while the flow is running lives under `placement`, which
  // is torn down on every exit path. The committed origin marker is added to
  // the scene directly so it survives for the rest of the session, matching
  // what #141 already did.
  const scene = options.provider.getScene?.() ?? null
  const placement = new THREE.Group()
  placement.name = 'calibration placement'
  if (scene) scene.add(placement)
  const decals: Record<MarkerId, THREE.Group | null> = { landmark: null, heading: null }
  let baseline: THREE.Line | null = null
  let floorGrid: THREE.GridHelper | null = null
  /** Last height the grid was drawn at, so it is only moved when it changes. */
  let floorGridY: number | null = null

  function disposeObject(root: THREE.Object3D): void {
    root.traverse((child) => {
      const drawable = child as Partial<THREE.Mesh>
      drawable.geometry?.dispose()
      const material = drawable.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    })
  }

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
    if (scene) scene.remove(placement)
  }

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
    if (!scene || !a || !b) return
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
    if (!scene) return
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
      floorGrid.name = 'calibration floor plane'
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
    if (scene) {
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

  function dropCommittedOrigin(position: Vec3, bearingDeg: number | null): void {
    if (!scene) return
    const marker = buildAnchorMarker(bearingDeg)
    marker.position.set(position.x, position.y, position.z)
    scene.add(marker)
  }

  // ── Geometry helpers ────────────────────────────────────────────────────

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

  function renderSteps(): void {
    const active: string = stage === 'ground' ? 'ground' : stage === 'landmark' ? 'landmark' : 'heading'
    steps.querySelectorAll<HTMLElement>('li').forEach((li) => {
      const step = li.dataset.step
      li.dataset.state = step === active
        ? 'active'
        : (step === 'ground' && active !== 'ground') || (step === 'landmark' && active === 'heading')
          ? 'done'
          : 'todo'
    })
  }

  function renderSeparation(): void {
    const sep = separation()
    if (sep === null) {
      show(separationEl, false)
      return
    }
    const enough = sep >= MIN_POINT_SEPARATION_M
    separationEl.dataset.state = enough ? 'ok' : 'short'
    separationEl.textContent = enough
      ? `${sep.toFixed(2)} m apart — a longer baseline is more accurate still.`
      : `${sep.toFixed(2)} m apart — need at least ${MIN_POINT_SEPARATION_M.toFixed(1)} m. Walk further and tap again.`
    show(separationEl, true)
  }

  function renderStage(): void {
    renderSteps()
    renderSeparation()
    refreshFloorGrid()
    const sep = separation()
    const farEnough = sep !== null && sep >= MIN_POINT_SEPARATION_M

    show(confirmBtn, stage === 'landmark' && !!points.landmark)
    show(commitBtn, stage === 'review')
    show(replaceBtn, stage === 'review' || stage === 'mismatch')
    show(overrideBtn, stage === 'mismatch')
    show(
      skipGround,
      stage === 'ground'
        && !groundWaitOverridden
        && !options.ground()?.locked
        && trackingEverEstablished
        && Date.now() - groundWaitStartedAt > GROUND_WAIT_TIMEOUT_MS,
    )
    show(fallbackBtn, stage !== 'ground' && stage !== 'mismatch' && !!points.landmark)
    commitBtn.disabled = !farEnough

    let defaultStatus = ''
    if (stage === 'ground') {
      // Without this the ground stage inherited the landmark stage's copy and
      // told the user to tap the ground before tapping was possible.
      title.textContent = isFirstCalibration ? "Set this project's world frame" : 'Align this scan to the project'
      copy.textContent = 'The grid shows where the floor is being estimated. Sweep the floor slowly until it settles onto the real floor — placement unlocks once it does.'
    } else if (stage === 'landmark') {
      title.textContent = isFirstCalibration ? "Set this project's world frame" : 'Align this scan to the project'
      copy.textContent = "Step 1 of 2 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin."
      defaultStatus = points.landmark
        ? 'Landmark placed. Tap it to move it, or confirm to place the heading marker.'
        : 'Tap the ground to place the landmark.'
    } else if (stage === 'heading') {
      title.textContent = 'Place the heading marker'
      copy.textContent = `Step 2 of 2 — walk at least ${MIN_POINT_SEPARATION_M.toFixed(1)} m from the landmark and tap a second ground feature. The direction between them sets the frame's heading, so the compass is not used.`
      defaultStatus = 'Tap the ground to place the heading marker.'
    } else if (stage === 'review') {
      title.textContent = 'Check the alignment'
      copy.textContent = 'Tap either marker to select it, then tap where it should go. Commit when both sit on features you will find again.'
      defaultStatus = farEnough
        ? 'Ready to commit.'
        : 'The markers are too close together to fix a reliable heading.'
    } else if (stage === 'mismatch') {
      title.textContent = 'These markers do not match the stored pair'
      const off = Math.abs(mismatchResidualM * 100).toFixed(0)
      const direction = mismatchResidualM > 0 ? 'further apart' : 'closer together'
      copy.textContent = `Measured ${off} cm ${direction} than this Place's recorded pair. That usually means one marker is on a different feature. Re-place them, or use this pair anyway and record it as unverified.`
      defaultStatus = 'Not committed yet.'
    }
    // The ground stage's copy is owned by update(), which computes it from the
    // tracking/floor timers and writes it before calling here — so this must
    // not clobber it with an empty default. Placement stages are owned here.
    if (stage !== 'ground') status.textContent = transientStatus ?? defaultStatus
  }

  const update = () => {
    if (stage !== 'ground') {
      renderStage()
      return
    }

    if (!options.provider.isTracking()) {
      const stalled = !trackingEverEstablished && Date.now() - trackingWaitStartedAt > TRACKING_TIMEOUT_MS
      status.textContent = stalled
        ? "Still not tracking — check the camera isn't covered, or Continue uncalibrated."
        : 'Waiting for stable AR tracking. Slowly look around the floor.'
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
      status.textContent = waited
        ? 'Still mapping the floor. Keep sweeping, or place the anchor without the floor check.'
        : 'Scanning the environment. Point the device at the floor and move slowly.'
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
      clearInterval(interval)
      options.canvas.removeEventListener('touchstart', onTouchStart)
      options.canvas.removeEventListener('pointerdown', onPointerDown)
      clearPlacement()
      overlay.remove()
      resolve(result)
    }

    /**
     * Commits the two-point frame. `override` records the pair despite a
     * separation mismatch, which costs the 'verified' status by definition.
     */
    function commitTwoPoint(override: boolean): void {
      const landmark = points.landmark
      const headingMarker = points.heading
      if (!landmark || !headingMarker) return
      const separationM = twoPointSeparationM(landmark, headingMarker)
      if (separationM < MIN_POINT_SEPARATION_M) {
        renderStage()
        return
      }

      const toleranceM = storedTwoPoint?.toleranceM ?? DEFAULT_SEPARATION_TOLERANCE_M
      const residualM = storedTwoPoint ? separationM - storedTwoPoint.separationM : 0
      if (storedTwoPoint && !override && Math.abs(residualM) > toleranceM) {
        mismatchResidualM = residualM
        stage = 'mismatch'
        renderStage()
        return
      }

      // Metadata only on this tier: recorded so absolute orientation is
      // available for GPS placement, never read to build the frame (ADR 0005).
      const bearingDeg = options.bearing()
      const calibratedAt = new Date().toISOString()
      const calibration: ScanCalibration = {
        method: 'two-point-ground',
        sessionToProject: twoPointToProjectTransform(landmark, headingMarker),
        separationM,
        residualM,
        toleranceM,
        anchorBearingDeg: bearingDeg,
        calibratedAt,
        // 'verified' is a measurement here, not a label: it requires a stored
        // reference that this session's re-measured separation actually matched.
        status: storedTwoPoint && !override ? 'verified' : 'provisional',
      }

      const frameChanged = !storedTwoPoint || override
      const spatialFrame: ProjectSpatialFrame | undefined = frameChanged
        ? {
            version: 1,
            createdAt: calibratedAt,
            method: 'two-point-ground',
            // Project-space by construction: the transform above sends the
            // landmark to the origin and the heading marker onto +Z at
            // `separationM`. Stored explicitly so the record is self-describing.
            landmark: { x: 0, y: 0, z: 0 },
            headingMarker: { x: 0, y: 0, z: separationM },
            separationM,
            toleranceM,
            anchorBearingDeg: bearingDeg,
          }
        : undefined

      dropCommittedOrigin(landmark, bearingDeg)
      close({ calibration, spatialFrame })
    }

    /** #141's single-tap tier, kept for rooms where a second point is impractical. */
    function commitSinglePoint(): void {
      const landmark = points.landmark
      if (!landmark) return
      const bearingDeg = options.bearing()
      const calibratedAt = new Date().toISOString()
      const calibration: ScanCalibration = {
        method: 'ground-tap-compass',
        sessionToProject: anchorToProjectTransform(landmark, bearingDeg),
        anchorBearingDeg: bearingDeg,
        calibratedAt,
        // A single anchor is project-space (0,0,0) by construction, so it always
        // agrees with itself — there is nothing here to verify against.
        status: 'provisional',
      }
      // Never downgrade a stored frame to this tier: a Place that already has a
      // reference keeps it, and this session simply aligns provisionally.
      const spatialFrame: ProjectSpatialFrame | undefined = existingFrame
        ? undefined
        : {
            version: 1,
            createdAt: calibratedAt,
            method: 'ground-tap-compass',
            anchorBearingDeg: bearingDeg,
          }
      dropCommittedOrigin(landmark, bearingDeg)
      close({ calibration, spatialFrame })
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
    function applyTap(position: Vec3): void {
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
          transientStatus = `${near === 'landmark' ? 'Landmark' : 'Heading marker'} selected — tap where it should go.`
          return
        }
        if (stage === 'landmark') target = 'landmark'
        else if (stage === 'heading') target = 'heading'
        else {
          transientStatus = 'Tap a marker to select it, then tap where it should go.'
          return
        }
      }

      if (target === 'landmark') {
        setMarker('landmark', position)
        // Re-placing the landmark redefines the floor, so the heading marker
        // follows it. Leaving it at the old height would tilt the baseline.
        const marker = points.heading
        if (marker) setMarker('heading', { x: marker.x, y: position.y, z: marker.z })
      } else {
        const floorY = points.landmark ? points.landmark.y : position.y
        const disagreement = position.y - floorY
        setMarker('heading', { x: position.x, y: floorY, z: position.z })
        if (stage === 'heading') stage = 'review'
        if (Math.abs(disagreement) > MARKER_HEIGHT_DISAGREEMENT_M) {
          const cm = Math.abs(Math.round(disagreement * 100))
          transientStatus =
            `That point measured ${cm} cm ${disagreement > 0 ? 'above' : 'below'} the landmark — one of the two is probably not on the floor.`
        }
      }

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
      // explicit choice rather than by another stray tap.
      if (stage === 'ground' || stage === 'mismatch') return

      tapInFlight = true
      transientStatus = 'Reading the surface…'
      renderStage()

      void (async () => {
        try {
          const hit = await options.hitTest(x, y).catch(() => null)
          if (!hit) {
            transientStatus = 'No stable surface there. Aim at a textured floor and tap again.'
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
          const confirmingRejectedHeight = isSameHeightRetry(hit.position.y, offGroundTapY)
          if (!confirmingRejectedHeight && !isTapOnGround(hit.position.y, groundY)) {
            offGroundTapY = hit.position.y
            const delta = tapHeightAboveGroundCm(hit.position.y, groundY as number)
            const side = delta >= 0 ? 'above' : 'below'
            transientStatus =
              `That looked about ${Math.abs(delta)} cm ${side} the floor. Aim at the floor, or tap the same height again to use it anyway.`
            return
          }
          offGroundTapY = null

          // Pass the raw hit through. applyTap() decides the height, because
          // only it knows which marker this tap is for — and the landmark's own
          // measured height is what defines the floor.
          transientStatus = null
          applyTap({ x: hit.position.x, y: hit.position.y, z: hit.position.z })
        } finally {
          tapInFlight = false
          renderStage()
        }
      })()
    }

    skip.addEventListener('click', () => close(null))
    skipGround.addEventListener('click', () => {
      groundWaitOverridden = true
      update()
    })
    confirmBtn.addEventListener('click', () => {
      if (!points.landmark) return
      selected = null
      transientStatus = null
      refreshSelectionVisuals()
      stage = 'heading'
      renderStage()
    })
    replaceBtn.addEventListener('click', () => {
      MARKER_IDS.forEach((id) => {
        detach(decals[id])
        decals[id] = null
        points[id] = null
      })
      refreshBaseline()
      selected = null
      transientStatus = null
      stage = 'landmark'
      renderStage()
    })
    commitBtn.addEventListener('click', () => commitTwoPoint(false))
    overrideBtn.addEventListener('click', () => commitTwoPoint(true))
    fallbackBtn.addEventListener('click', () => commitSinglePoint())

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
