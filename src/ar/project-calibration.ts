import type { ARProvider, HitResult } from './provider'
import type { Project, ProjectSpatialFrame, ScanCalibration } from '../world/types'
import { anchorToProjectTransform } from '../world/geo'
import { buildAnchorMarker } from '../world/anchor-marker'

const TRACKING_TIMEOUT_MS = 10_000

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
        <button id="project-calibration-skip" type="button" class="project-calibration-link">Continue uncalibrated</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const status = overlay.querySelector<HTMLElement>('#project-calibration-status')!
  const skip = overlay.querySelector<HTMLButtonElement>('#project-calibration-skip')!

  const update = () => {
    if (!options.provider.isTracking()) {
      const stalled = !trackingEverEstablished && Date.now() - trackingWaitStartedAt > TRACKING_TIMEOUT_MS
      status.textContent = stalled
        ? "Still not tracking — check the camera isn't covered, or Continue uncalibrated."
        : 'Waiting for stable AR tracking. Slowly look around the floor.'
      skip.classList.toggle('project-calibration-link-promoted', stalled)
      return
    }
    trackingEverEstablished = true
    skip.classList.remove('project-calibration-link-promoted')
    if (!tapInFlight) status.textContent = 'Tracking ready. Tap the ground to place the anchor.'
  }

  return new Promise((resolve) => {
    const interval = setInterval(update, 200)
    const close = (result: CalibrationResult | null) => {
      clearInterval(interval)
      options.canvas.removeEventListener('touchstart', onTouchStart)
      overlay.remove()
      resolve(result)
    }

    skip.addEventListener('click', () => close(null))

    // Matches the placeground reference's own guard: a two-finger touch is a
    // recenter/pinch gesture elsewhere in this app, not a placement tap.
    const onTouchStart = (e: TouchEvent) => {
      if (tapInFlight || e.touches.length !== 1 || !options.provider.isTracking()) return
      const touch = e.touches[0]!
      const rect = options.canvas.getBoundingClientRect()
      const x = (touch.clientX - rect.left) / rect.width
      const y = (touch.clientY - rect.top) / rect.height
      if (x < 0 || x > 1 || y < 0 || y > 1) return

      tapInFlight = true
      status.textContent = 'Placing anchor…'

      void (async () => {
        const hit = await options.hitTest(x, y).catch(() => null)
        if (!hit) {
          tapInFlight = false
          status.textContent = 'No stable surface there. Aim at a textured floor and tap again.'
          return
        }

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
          status: existingFrame ? 'verified' : 'provisional',
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
    options.canvas.addEventListener('touchstart', onTouchStart, { passive: true })

    update()
  })
}
