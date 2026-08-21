import type { ARProvider, HitResult } from './provider'
import type { Project, ProjectSpatialFrame, ScanCalibration, Vec3 } from '../world/types'

const MIN_REFERENCE_DISTANCE_M = 0.75
const DEFAULT_TOLERANCE_M = 0.3048 // One foot.
const TRACKING_TIMEOUT_MS = 10_000

export interface CalibrationResult {
  calibration: ScanCalibration
  spatialFrame?: ProjectSpatialFrame
}

interface CalibrationOptions {
  provider: ARProvider
  project: Project
  hitTest: () => Promise<HitResult | null>
}

const REFERENCE_LABELS: [string, string, string] = [
  'Origin corner',
  'X-axis floor point',
  'Third floor point',
]

const STEP_COPY = [
  'Aim at a permanent floor or wall corner. This is the project origin.',
  'Aim at a second permanent floor point at least 0.75 m away. This sets the X axis.',
  'Aim at a third floor point away from the same line. This locks rotation and scale.',
]

/**
 * Collect a repeatable three-point reference triangle after AR tracking starts.
 * The resulting matrix maps this session's AR coordinates into project space.
 */
export function runProjectCalibration(options: CalibrationOptions): Promise<CalibrationResult | null> {
  const existingFrame = options.project.spatialFrame
  const isFirstCalibration = !existingFrame
  const points: Vec3[] = []
  const trackingWaitStartedAt = Date.now()
  let trackingEverEstablished = false

  const overlay = document.createElement('section')
  overlay.id = 'project-calibration'
  overlay.innerHTML = `
    <div class="project-calibration-backdrop"></div>
    <div class="project-calibration-reticle" aria-hidden="true"><span></span></div>
    <div class="project-calibration-card" role="dialog" aria-modal="true" aria-labelledby="project-calibration-title">
      <div class="project-calibration-eyebrow">Project alignment</div>
      <h2 id="project-calibration-title">${isFirstCalibration ? 'Set this project\'s world frame' : 'Align this scan to the project'}</h2>
      <p id="project-calibration-copy"></p>
      <div class="project-calibration-progress" aria-label="Calibration progress">
        <span class="active"></span><span></span><span></span>
      </div>
      <div id="project-calibration-status" class="project-calibration-status">Waiting for AR tracking...</div>
      <div id="project-calibration-measure" class="project-calibration-measure">Keep the reticle on a stable architectural point.</div>
      <div class="project-calibration-actions">
        <button id="project-calibration-lock" type="button" disabled>Lock reference point</button>
        <button id="project-calibration-reset" type="button" disabled>Start over</button>
        <button id="project-calibration-skip" type="button" class="project-calibration-link">Continue uncalibrated</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const copy = overlay.querySelector<HTMLElement>('#project-calibration-copy')!
  const status = overlay.querySelector<HTMLElement>('#project-calibration-status')!
  const measure = overlay.querySelector<HTMLElement>('#project-calibration-measure')!
  const lock = overlay.querySelector<HTMLButtonElement>('#project-calibration-lock')!
  const reset = overlay.querySelector<HTMLButtonElement>('#project-calibration-reset')!
  const skip = overlay.querySelector<HTMLButtonElement>('#project-calibration-skip')!
  const indicators = [...overlay.querySelectorAll<HTMLElement>('.project-calibration-progress span')]

  const update = () => {
    const step = Math.min(points.length, 2)
    copy.textContent = STEP_COPY[step]!
    indicators.forEach((indicator, index) => indicator.classList.toggle('active', index <= step))
    reset.disabled = points.length === 0
    if (!options.provider.isTracking()) {
      const stalled = !trackingEverEstablished && Date.now() - trackingWaitStartedAt > TRACKING_TIMEOUT_MS
      status.textContent = stalled
        ? "Still not tracking — check the camera isn't covered, or Continue uncalibrated."
        : 'Waiting for stable AR tracking. Slowly look around the floor.'
      skip.classList.toggle('project-calibration-link-promoted', stalled)
      lock.disabled = true
      return
    }
    trackingEverEstablished = true
    skip.classList.remove('project-calibration-link-promoted')
    status.textContent = `Tracking ready. Reference ${points.length + 1} of 3: ${REFERENCE_LABELS[step]}.`
    lock.disabled = false
    if (points.length === 0) {
      measure.textContent = 'Keep the reticle on a stable architectural point.'
    } else {
      const originDistance = distance(points[0]!, options.provider.getPose().position)
      measure.textContent = `Current camera is ${originDistance.toFixed(2)} m from the origin reference.`
    }
  }

  return new Promise((resolve) => {
    const interval = setInterval(update, 200)
    const close = (result: CalibrationResult | null) => {
      clearInterval(interval)
      overlay.remove()
      resolve(result)
    }

    reset.addEventListener('click', () => {
      points.length = 0
      update()
    })
    skip.addEventListener('click', () => close(null))
    lock.addEventListener('click', async () => {
      lock.disabled = true
      const hit = await options.hitTest().catch(() => null)
      if (!hit) {
        status.textContent = 'No stable surface at the reticle. Aim at a textured floor or corner and try again.'
        update()
        return
      }
      const point = hit.position
      if (points.length > 0 && distance(points[0]!, point) < MIN_REFERENCE_DISTANCE_M) {
        status.textContent = `Move at least ${MIN_REFERENCE_DISTANCE_M} m from the origin reference.`
        update()
        return
      }
      if (points.length === 2 && triangleArea(points[0]!, points[1]!, point) < 0.12) {
        status.textContent = 'Choose a third point farther off the reference line to lock a reliable frame.'
        update()
        return
      }

      points.push({ ...point })
      if (points.length < 3) {
        update()
        return
      }

      const distances = referenceDistances(points)
      const residualM = existingFrame ? distanceResidual(existingFrame.referenceDistancesM, distances) : 0
      const toleranceM = existingFrame?.toleranceM ?? DEFAULT_TOLERANCE_M
      if (existingFrame && residualM > toleranceM) {
        status.textContent = `References differ by ${(residualM * 100).toFixed(0)} cm. Re-aim at the same three physical points.`
        points.length = 0
        update()
        return
      }

      const calibration: ScanCalibration = {
        method: 'raycast-reference-triangle',
        sessionToProject: sessionToProjectMatrix(points),
        referenceDistancesM: distances,
        residualM,
        toleranceM,
        calibratedAt: new Date().toISOString(),
        status: existingFrame ? 'verified' : 'provisional',
      }
      const spatialFrame: ProjectSpatialFrame | undefined = existingFrame ? undefined : {
        version: 1,
        method: 'raycast-reference-triangle',
        referenceDistancesM: distances,
        referenceLabels: REFERENCE_LABELS,
        toleranceM,
        createdAt: calibration.calibratedAt,
      }
      close({ calibration, spatialFrame })
    })
    update()
  })
}

function referenceDistances(points: Vec3[]): [number, number, number] {
  return [distance(points[0]!, points[1]!), distance(points[0]!, points[2]!), distance(points[1]!, points[2]!)]
}

function distanceResidual(expected: [number, number, number], actual: [number, number, number]): number {
  return Math.sqrt(expected.reduce((sum, value, index) => sum + (value - actual[index]!) ** 2, 0) / expected.length)
}

function sessionToProjectMatrix([origin, xPoint, planePoint]: Vec3[]): number[] {
  const xAxis = normalize(subtract(xPoint, origin))
  let yAxis = normalize(cross(xAxis, subtract(planePoint, origin)))
  if (yAxis.y < 0) yAxis = scale(yAxis, -1)
  const zAxis = normalize(cross(yAxis, xAxis))
  return [
    xAxis.x, yAxis.x, zAxis.x, 0,
    xAxis.y, yAxis.y, zAxis.y, 0,
    xAxis.z, yAxis.z, zAxis.z, 0,
    -dot(xAxis, origin), -dot(yAxis, origin), -dot(zAxis, origin), 1,
  ]
}

function subtract(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function scale(v: Vec3, factor: number): Vec3 { return { x: v.x * factor, y: v.y * factor, z: v.z * factor } }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function cross(a: Vec3, b: Vec3): Vec3 { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x } }
function distance(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }
function triangleArea(a: Vec3, b: Vec3, c: Vec3): number { return Math.hypot(...Object.values(cross(subtract(b, a), subtract(c, a)))) * 0.5 }
function normalize(v: Vec3): Vec3 { const length = Math.hypot(v.x, v.y, v.z); return scale(v, 1 / Math.max(length, Number.EPSILON)) }
