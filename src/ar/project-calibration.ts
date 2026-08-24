import type { ARProvider, HitResult } from './provider'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../world/types'
import { anchorToProjectTransform } from '../world/geo'
import { buildAnchorMarker } from '../world/anchor-marker'
import { isTapOnGround, tapHeightAboveGroundCm } from './ground-gate'

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

/**
 * Drops a single world-anchored compass+crosshair decal at a tapped ground
 * point — this project's calibration origin. Replaces the old 3-point
 * reference-triangle sequence: no minimum-spacing/degenerate-triangle
 * checks, and no capture-time residual/tolerance reject-and-retry gate — a
 * single point has no second point left to diff a residual against.
 * Precision assurance moves to the World Editor's anchor layer and, for
 * repeat visits, a live "previous anchors" overlay (both visual aids to
 * align against, not an automated gate) rather than being enforced here.
 */
export function runProjectCalibration(options: CalibrationOptions): Promise<CalibrationResult | null> {
  const existingFrame = options.project.spatialFrame
  const isFirstCalibration = !existingFrame
  const trackingWaitStartedAt = Date.now()
  let trackingEverEstablished = false
  let tapInFlight = false
  /** When the floor wait began — clocked from tracking, not from modal open. */
  let groundWaitStartedAt = Date.now()
  /** Set when the user chooses to place without a settled floor estimate. */
  let groundWaitOverridden = false
  /** A tap rejected as off-floor arms a one-shot override on the next attempt. */
  let offGroundTapPending = false

  const overlay = document.createElement('section')
  overlay.id = 'project-calibration'
  overlay.innerHTML = `
    <div class="project-calibration-backdrop"></div>
    <div class="project-calibration-card" role="dialog" aria-modal="true" aria-labelledby="project-calibration-title">
      <div class="project-calibration-eyebrow">Project alignment</div>
      <h2 id="project-calibration-title">${isFirstCalibration ? 'Set this project\'s world frame' : 'Align this scan to the project'}</h2>
      <p id="project-calibration-copy">Tap a spot on the ground to mark this project's origin.</p>
      <div id="project-calibration-status" class="project-calibration-status">Waiting for AR tracking...</div>
      <div class="project-calibration-actions">
        <button id="project-calibration-skip-ground" type="button" class="project-calibration-link project-calibration-link-promoted" style="display:none;">Place anchor without floor check</button>
        <button id="project-calibration-skip" type="button" class="project-calibration-link">Continue uncalibrated</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const status = overlay.querySelector<HTMLElement>('#project-calibration-status')!
  const skip = overlay.querySelector<HTMLButtonElement>('#project-calibration-skip')!
  const skipGround = overlay.querySelector<HTMLButtonElement>('#project-calibration-skip-ground')!

  const update = () => {
    if (!options.provider.isTracking()) {
      const stalled = !trackingEverEstablished && Date.now() - trackingWaitStartedAt > TRACKING_TIMEOUT_MS
      status.textContent = stalled
        ? "Still not tracking — check the camera isn't covered, or Continue uncalibrated."
        : 'Waiting for stable AR tracking. Slowly look around the floor.'
      skip.classList.toggle('project-calibration-link-promoted', stalled)
      return
    }
    if (!trackingEverEstablished) {
      trackingEverEstablished = true
      // Start the floor clock here, not at modal open: time spent waiting for
      // tracking is not time spent failing to map the floor.
      groundWaitStartedAt = Date.now()
    }

    // Environment-scan step: tracking being alive is not the same as the floor
    // being mapped. Without this the tap can be taken in the first second of a
    // session — exactly when the point cloud is emptiest and the gate below has
    // nothing to check against.
    if (!groundWaitOverridden && !options.ground()?.locked) {
      const waited = Date.now() - groundWaitStartedAt > GROUND_WAIT_TIMEOUT_MS
      status.textContent = waited
        ? 'Still mapping the floor. Keep sweeping, or place the anchor without the floor check.'
        : 'Scanning the environment. Point the device at the floor and move slowly.'
      // A distinct action rather than retargeting the skip link: "give up on
      // the floor check" and "give up on calibration" are different decisions,
      // and a user who wants the second must not have it silently become the
      // first.
      skipGround.style.display = waited ? '' : 'none'
      skip.classList.remove('project-calibration-link-promoted')
      return
    }

    skipGround.style.display = 'none'
    skip.classList.remove('project-calibration-link-promoted')
    if (!tapInFlight) {
      status.textContent = options.ground()
        ? 'Floor found. Tap the ground to place the anchor.'
        : 'Tracking ready. Tap the ground to place the anchor (floor not confirmed).'
    }
  }

  return new Promise((resolve) => {
    const interval = setInterval(update, 200)
    const close = (result: CalibrationResult | null) => {
      clearInterval(interval)
      options.canvas.removeEventListener('touchstart', onTouchStart)
      options.canvas.removeEventListener('pointerdown', onPointerDown)
      overlay.remove()
      resolve(result)
    }

    skip.addEventListener('click', () => close(null))
    skipGround.addEventListener('click', () => {
      groundWaitOverridden = true
      update()
    })

    const placeAt = (x: number, y: number) => {
      // A zero-size canvas (rect.width/height === 0, e.g. mid-layout) turns
      // the caller's division into NaN, which every comparison below would
      // silently let through as "in range" — reject non-finite values first.
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return

      tapInFlight = true
      status.textContent = 'Placing anchor…'

      void (async () => {
        const hit = await options.hitTest(x, y).catch(() => null)
        if (!hit) {
          tapInFlight = false
          status.textContent = 'No stable surface there. Aim at a textured floor and tap again.'
          return
        }

        // Floor gate. The copy has always told the user to tap the ground
        // ("Aim at a textured floor"), but nothing enforced it — a tabletop tap
        // silently became a project origin ~0.75 m above the floor, and every
        // scan aligned through that frame inherited the offset.
        //
        // Rejected on the first attempt, accepted on an immediate retry: a hard
        // reject would trap a user whose floor estimate is itself wrong (thick
        // carpet, a mezzanine, a sunken room), and a bare warning would be
        // ignored. Two steps keeps the default safe and the override explicit.
        const groundY = options.ground()?.y ?? null
        if (!offGroundTapPending && !isTapOnGround(hit.position.y, groundY)) {
          offGroundTapPending = true
          tapInFlight = false
          const deltaCm = Math.abs(tapHeightAboveGroundCm(hit.position.y, groundY as number))
          status.textContent =
            `That looked about ${deltaCm} cm above the floor. Tap the floor, or tap the same spot again to use it anyway.`
          return
        }
        offGroundTapPending = false

        const bearingDeg = options.bearing()
        const sessionToProject = anchorToProjectTransform(hit.position, bearingDeg)

        // Drop the decal into the live AR scene, if this provider has one, so
        // the user sees where the anchor landed for the rest of the session.
        const scene = options.provider.getScene?.()
        if (scene) {
          const marker = buildAnchorMarker(bearingDeg)
          marker.position.set(hit.position.x, hit.position.y, hit.position.z)
          scene.add(marker)
        }

        const calibratedAt = new Date().toISOString()
        const calibration: ScanCalibration = {
          method: 'ground-tap-compass',
          sessionToProject,
          anchorBearingDeg: bearingDeg,
          calibratedAt,
          // Always 'provisional', including on a return visit. A single anchor
          // maps to project-space (0,0,0) by construction, so it always agrees
          // with itself — there is nothing here to compare against and no
          // residual to compute. Reporting 'verified' because a spatialFrame
          // record happened to exist claimed a check that never ran: a user
          // tapping three metres from last visit's spot got a three-metre
          // misalignment labelled verified. Wave 09 ticket 0004 restores a
          // real producer by measuring a two-point separation against the
          // stored one.
          status: 'provisional',
        }
        const spatialFrame: ProjectSpatialFrame | undefined = existingFrame ? undefined : {
          version: 1,
          method: 'ground-tap-compass',
          anchorBearingDeg: bearingDeg,
          createdAt: calibratedAt,
        }
        close({ calibration, spatialFrame })
      })()
    }

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
