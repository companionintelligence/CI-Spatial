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
  tapPointWithinPhoto,
  type PendingReferencePhoto,
  type ReferencePhotoCapture,
  type ReferencePhotoRole,
} from './reference-photo'
import {
  anchorToProjectTransform,
  normaliseBearingDeg,
  sessionFrameBearingDeg,
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
  /**
   * Reference photos captured for the two markers, for the host to persist and
   * upload (wave 09 ticket 0007).
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
  /**
   * Grabs the live camera frame for a marker's reference photo (ticket 0007).
   *
   * Optional, and allowed to resolve `null` or reject. A denied frame, a
   * pending capture, or a host that supplies no accessor at all degrades
   * re-acquisition on the next visit — it must never fail the calibration,
   * which is why every call site here treats a miss as a missing photo and
   * carries on.
   */
  capturePhoto?: () => Promise<ReferencePhotoCapture | null>
  /**
   * Resolves a stored reference photo to something an `<img>` can display —
   * the local blob where this device took it, the server copy otherwise.
   * `null` when neither is reachable, which the panel reports rather than
   * showing an empty box.
   */
  loadReferencePhoto?: (photo: CalibrationReferencePhoto) => Promise<string | null>
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

  // ── Reference photos and labels (ticket 0007) ───────────────────────────
  /** Role each marker id maps to in the stored schema. */
  const ROLE_OF: Record<MarkerId, ReferencePhotoRole> = { landmark: 'landmark', heading: 'headingMarker' }
  /**
   * Where each marker's placing tap landed on the **canvas**, normalised.
   * `placeAt()` already computes this and used to discard it after the
   * hit-test; keeping it costs nothing and is what turns a photo of a wall
   * into a photo of a *spot* on that wall.
   */
  const tapPoints: Record<MarkerId, { x: number; y: number } | null> = { landmark: null, heading: null }
  /** The user's typed description per marker, e.g. "north door frame". */
  const labels: Record<MarkerId, string> = { landmark: '', heading: '' }
  /**
   * In-flight or settled photo capture per marker. A promise rather than a
   * value because capture is kicked off at the moment the marker is committed
   * and must not stall the stage transition — the flow reads it once, at
   * commit.
   */
  const photoTasks: Record<MarkerId, Promise<PendingReferencePhoto | null> | null> = { landmark: null, heading: null }
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
   */
  let commitInFlight = false

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
      <label id="project-calibration-label-field" class="project-calibration-label-field" hidden>
        <span id="project-calibration-label-caption">Name this feature</span>
        <input id="project-calibration-label-input" type="text" maxlength="60" autocomplete="off"
               placeholder="e.g. north door frame" />
      </label>
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
    // Object URLs for stored photos are per-flow; nothing outside this modal
    // renders them, so holding them past teardown only leaks.
    objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url))
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

  /**
   * Adds a marker to the scene **directly**, so it outlives the flow.
   *
   * Everything under `placement` is torn down by `clearPlacement()` on every
   * exit path; anything added here is not. That difference is the whole reason
   * this helper is separate.
   */
  function dropPersistentMarker(position: Vec3, northYawDeg: number | null, name: string): THREE.Group | null {
    if (!scene) return null
    const marker = buildAnchorMarker(northYawDeg)
    marker.name = name
    marker.position.set(position.x, position.y, position.z)
    scene.add(marker)
    return marker
  }

  /**
   * Keeps **both** committed markers in the scene for the rest of the session.
   *
   * Ticket 0004 as shipped kept only the landmark: `clearPlacement()` tore the
   * heading marker's decal down at commit, so point B vanished the moment the
   * user committed — leaving the one thing that fixes the frame's rotation
   * invisible for the entire scan that followed. Ticket 0007 requires both,
   * because the pair *is* the reference: a user who cannot see where B went
   * cannot notice they placed it on the wrong feature.
   *
   * Only the landmark carries the north tick — the bearing describes one
   * orientation for the frame, not a property of each marker, and drawing it
   * twice would read as two independent compass fixes.
   */
  function dropCommittedPair(landmark: Vec3, headingMarker: Vec3 | null): void {
    // The marker lives in session space, so its tick takes the session yaw at
    // which north lies — not the compass bearing. See buildAnchorMarker.
    dropPersistentMarker(landmark, northYawInSession(), 'calibration anchor landmark')
    if (headingMarker) dropPersistentMarker(headingMarker, null, 'calibration anchor heading')
  }

  /**
   * Draws the Place's **stored** pair into the live scene — step 4 of ticket
   * 0007's return-visit flow, and the only moment at which it is possible.
   *
   * Stored points are project-space and tautological (`landmark` is the origin,
   * `headingMarker` is +Z at `separationM`), so rendering them needs a
   * session→project transform. That transform is what calibration produces, so
   * before this point the overlay would be circular — which is exactly why the
   * flow shows *photos* beforehand and geometry only afterwards.
   *
   * Here the transform exists, and its inverse is available without matrix
   * work: the stored landmark maps to the landmark the user just placed, and
   * the stored heading marker maps to `storedSeparationM` along the baseline
   * they just defined. Any visible gap between this and the marker they placed
   * is the residual, shown at room scale instead of as a number.
   */
  function drawStoredPair(landmark: Vec3, headingMarker: Vec3, storedSeparationM: number): void {
    const dx = headingMarker.x - landmark.x
    const dz = headingMarker.z - landmark.z
    const measured = Math.hypot(dx, dz)
    if (!Number.isFinite(measured) || measured <= 0) return
    dropPersistentMarker(landmark, null, 'calibration stored reference')
    dropPersistentMarker(
      {
        x: landmark.x + (dx / measured) * storedSeparationM,
        y: landmark.y,
        z: landmark.z + (dz / measured) * storedSeparationM,
      },
      null,
      'calibration stored reference',
    )
  }

  // ── Geometry helpers ────────────────────────────────────────────────────

  /**
   * The true-north bearing of the **session frame's +Z axis** (ticket 0009).
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
    return sessionFrameBearingDeg(options.bearing(), options.provider.getPose().rotation)
  }

  /**
   * Where north lies in **session** coordinates, as a yaw — what
   * `buildAnchorMarker` needs, since the decals it makes live in the session
   * frame rather than in a north-aligned one.
   */
  function northYawInSession(): number | null {
    const bearing = frameBearing()
    return bearing === null ? null : normaliseBearingDeg(-bearing)
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

  /** The marker this stage is asking the user to place, if any. */
  function activeMarker(): MarkerId | null {
    return stage === 'landmark' ? 'landmark' : stage === 'heading' ? 'heading' : null
  }

  /**
   * Which marker the label field is naming.
   *
   * Not the same as {@link activeMarker}, and the difference is not cosmetic:
   * placing the heading marker advances straight to `'review'` in the same
   * tick, so a field bound to the placement stage alone can never be reached
   * for point B — the frame would be committable with only half its
   * `pointLabels`. Review therefore names the heading marker by default, and
   * whichever marker is selected when one is.
   */
  function labelTarget(): MarkerId | null {
    const active = activeMarker()
    if (active) return active
    if (stage === 'review') return selected ?? 'heading'
    return null
  }

  function storedPhotoFor(id: MarkerId): CalibrationReferencePhoto | null {
    const photos = storedTwoPoint?.referencePhotos
    if (!photos) return null
    return id === 'landmark' ? photos.landmark : photos.headingMarker
  }

  function storedLabelFor(id: MarkerId): string {
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
      referenceNote.textContent = storedLabel
        ? 'No photo was saved for this point — go by the description above.'
        : 'This Place was aligned before reference photos existed, so there is nothing to match against. Place this marker on the same physical feature as last time.'
      show(referenceNote, true)
      return
    }

    referenceNote.textContent = 'Loading the saved photo…'
    show(referenceNote, true)
    const load = options.loadReferencePhoto
    if (!load) {
      referenceNote.textContent = 'The saved photo is not available in this session.'
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
    labelCaption.textContent = active === 'landmark'
      ? 'Name point A (optional, helps you find it next time)'
      : 'Name point B (optional)'
    if (labelFieldFor !== active) {
      labelFieldFor = active
      // Prefill from the stored label so a re-set frame keeps a description
      // the user already wrote, rather than silently dropping it.
      if (!labels[active]) labels[active] = storedLabelFor(active)
      labelInput.value = labels[active]
    }
  }

  function renderStage(): void {
    renderSteps()
    renderSeparation()
    renderReference()
    renderLabelField()
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
     * Grabs the camera frame for one marker, at the moment that marker is
     * committed — Confirm for the landmark, Commit for the heading marker.
     *
     * **Commit, not provisional placement**, for two reasons that point the
     * same way: adjustment during the tap-near flow would otherwise burn a
     * frame per correction, and a photo that does not match the *committed*
     * position actively misleads on the next visit.
     *
     * Deliberately not awaited by its callers. `captureFrame()` waits for the
     * next camera frame and can take a beat, and the flow must not stall on it
     * — the photo is an aid, never a gate. The result is read once, at commit.
     *
     * The tap is normalised against the **canvas**; the photo is the camera
     * frame, which is cover-cropped to fill that canvas and so contains more
     * than the user saw. `tapPointWithinPhoto` reconciles the two. When it
     * cannot, the photo is dropped rather than stored with a crosshair that
     * would point confidently at the wrong feature.
     */
    function beginPhotoCapture(id: MarkerId): void {
      const capturePhoto = options.capturePhoto
      const tapPoint = tapPoints[id]
      photoTasks[id] = null
      if (!capturePhoto || !tapPoint) return
      const role = ROLE_OF[id]
      photoTasks[id] = (async () => {
        try {
          const frame = await capturePhoto()
          if (!frame) return null
          const rect = options.canvas.getBoundingClientRect()
          const within = tapPointWithinPhoto(tapPoint, frame.frameSize, {
            width: rect.width,
            height: rect.height,
          })
          if (!within) return null
          return {
            role,
            blob: frame.blob,
            thumbDataUrl: frame.thumbDataUrl,
            tapPoint: within,
            pose: frame.pose,
            capturedAt: new Date().toISOString(),
            label: null,
          }
        } catch {
          // "Capture already pending", a denied frame, a timeout — every one of
          // these is a failed photo, never a failed calibration.
          return null
        }
      })()
    }

    /**
     * Collects whatever the capture tasks produced, stamping each with the
     * label as typed at commit time rather than at capture time — the user is
     * free to name a feature after confirming it.
     */
    async function collectPhotos(): Promise<PendingReferencePhoto[]> {
      const collected: PendingReferencePhoto[] = []
      for (const id of MARKER_IDS) {
        const task = photoTasks[id]
        if (!task) continue
        const photo = await task.catch(() => null)
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
     * Commits the two-point frame. `override` records the pair despite a
     * separation mismatch, which costs the 'verified' status by definition.
     */
    async function commitTwoPoint(override: boolean): Promise<void> {
      if (commitInFlight) return
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

      const frameChanged = !storedTwoPoint || override
      // Only a changed frame keeps photos, so only a changed frame is worth a
      // capture. This sits after the mismatch check on purpose: a pair that is
      // about to be sent back for re-placement should not cost a frame.
      let referencePhotos: PendingReferencePhoto[] = []
      if (frameChanged) {
        commitInFlight = true
        beginPhotoCapture('heading')
        transientStatus = 'Saving reference photos…'
        renderStage()
        try {
          referencePhotos = await collectPhotos()
        } finally {
          commitInFlight = false
        }
      }

      // Metadata only on this tier: recorded so absolute orientation is
      // available for GPS placement, never read to build the frame (ADR 0005).
      const bearingDeg = frameBearing()
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
            ...(committedLabels() ? { pointLabels: committedLabels() } : {}),
            // `referencePhotos` is intentionally absent here. The URLs and
            // local keys do not exist until the host has stored and uploaded
            // the bytes, so the host attaches them to this frame before it is
            // persisted — see `referencePhotos` on CalibrationResult.
          }
        : undefined

      // Both markers, not just the landmark: the pair is the reference, and a
      // heading marker the user cannot see is one they cannot check.
      dropCommittedPair(landmark, headingMarker)

      // Step 4 of the return-visit flow. Reachable only here, because only a
      // committed frame makes the stored points renderable at all.
      if (storedTwoPoint && !override) {
        drawStoredPair(landmark, headingMarker, storedTwoPoint.separationM)
      }

      close({ calibration, spatialFrame, ...(frameChanged ? { referencePhotos } : {}) })
    }

    /** #141's single-tap tier, kept for rooms where a second point is impractical. */
    function commitSinglePoint(): void {
      const landmark = points.landmark
      if (!landmark) return
      // Load-bearing on this tier — it *is* the frame's heading — so the
      // correction below matters far more here than on the two-point tier.
      const bearingDeg = frameBearing()
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
      // No reference photos on this tier (ticket 0007's non-goals): it has no
      // cross-session verification story, and a re-acquisition aid would imply
      // one. There is also no second marker to draw.
      dropCommittedPair(landmark, null)
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
    function applyTap(position: Vec3, tapPoint: { x: number; y: number }): void {
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

      // Where this tap landed on screen, kept for the marker it is placing.
      // Re-placing invalidates any photo already taken for that marker: a photo
      // of the *previous* spot, crosshaired at the previous tap, is worse than
      // no photo — it would send the next visit to the wrong feature.
      tapPoints[target] = tapPoint
      photoTasks[target] = null

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
          applyTap({ x: hit.position.x, y: hit.position.y, z: hit.position.z }, { x, y })
        } finally {
          tapInFlight = false
          renderStage()
        }
      })()
    }

    labelInput.addEventListener('input', () => {
      if (labelFieldFor) labels[labelFieldFor] = labelInput.value
    })

    skip.addEventListener('click', () => close(null))
    skipGround.addEventListener('click', () => {
      groundWaitOverridden = true
      update()
    })
    confirmBtn.addEventListener('click', () => {
      if (!points.landmark) return
      // The landmark is committed at this click and the user is still standing
      // where they tapped it, so this is the only moment the photo can show
      // the view they had. Not awaited — the stage advances immediately.
      beginPhotoCapture('landmark')
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
        // Both points are being re-placed, so both photos describe positions
        // that no longer exist.
        tapPoints[id] = null
        photoTasks[id] = null
      })
      refreshBaseline()
      selected = null
      transientStatus = null
      stage = 'landmark'
      renderStage()
    })
    commitBtn.addEventListener('click', () => void commitTwoPoint(false))
    overrideBtn.addEventListener('click', () => void commitTwoPoint(true))
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
