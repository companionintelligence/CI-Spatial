/**
 * AR overlay — 3D-projected label pins + capture button + status bar.
 *
 * Each detected object gets a pin that:
 *  - Builds a live Three.js PerspectiveCamera from the SLAM pose + camera intrinsics
 *    (since XR8.Threejs pipeline module is not loaded, we reconstruct the camera ourselves)
 *  - Projects world position → screen via frustum raycasting every render frame
 *  - Shows a coloured category dot + label + confidence + live distance
 *  - Scales with distance, hides when behind camera or >15 m away
 *  - Pulses briefly when newly added
 */
import * as THREE from 'three'
import type { ARProvider } from '../ar/provider'
import type { DetectionStore } from '../scene/store'

declare const XR8: {
  addCameraPipelineModule(mod: object): void
}

export type CaptureButtonCallback = () => Promise<void>

const CATEGORY_COLORS: Record<string, string> = {
  chair:    '#80ffe1',
  table:    '#81c784',
  sofa:     '#ff8a65',
  couch:    '#ff8a65',
  bed:      '#ce93d8',
  desk:     '#a5d6a7',
  monitor:  '#80cbc4',
  tv:       '#80cbc4',
  door:     '#ffcc80',
  window:   '#80deea',
  shelf:    '#c5e1a5',
  bookcase: '#c5e1a5',
  lamp:     '#fff176',
  plant:    '#66bb6a',
}
function categoryColor(label: string): string {
  const l = label.toLowerCase()
  for (const [k, c] of Object.entries(CATEGORY_COLORS)) {
    if (l.includes(k)) return c
  }
  return '#b0bec5'
}

export class AROverlay {
  private container: HTMLElement
  private statusText: HTMLElement
  private progressWrap: HTMLElement
  private progressFill: HTMLElement
  private captureBtn: HTMLButtonElement
  private pinMap = new Map<string, HTMLDivElement>()
  /** Reused Three.js camera — updated every frame from the SLAM pose */
  private _projCam: THREE.PerspectiveCamera | null = null

  constructor(
    private readonly store: DetectionStore,
    private readonly use8thWall: boolean,
    private readonly provider: ARProvider,
  ) {
    this.container = document.getElementById('ar-overlay')!
    this.statusText = document.getElementById('status-text')!
    this.progressWrap = document.getElementById('progress-bar-wrap')!
    this.progressFill = document.getElementById('progress-bar-fill')!
    this.captureBtn = document.getElementById('capture-btn') as HTMLButtonElement

    store.subscribe(() => this.syncPins())
  }

  mount(onCapture: CaptureButtonCallback): void {
    this.captureBtn.addEventListener('click', async () => {
      if (this.captureBtn.classList.contains('busy')) return
      try {
        await onCapture()
      } catch (error) {
        console.warn('[overlay] capture handler failed:', error)
      }
    })

    if (this.use8thWall) {
      // Hook into the 8th Wall pipeline instead of relying on XR8.Threejs.xrScene()
      // (the Threejs module is not loaded). We build the projection camera from
      // the SLAM pose captured in EighthWallProvider.
      const self = this
      XR8.addCameraPipelineModule({
        name: 'ci-scan-overlay-tick',
        onRender: () => {
          const cam = self._buildCameraFromProvider()
          if (cam) self.tickPins(cam)
        },
      })
    }
  }

  /** For WebXR — call every XR frame with the viewer's Three.js camera */
  tick(camera: THREE.Camera): void {
    this.tickPins(camera)
  }

  setStatus(text: string): void {
    this.statusText.textContent = text
  }

  setProgress(pct: number | null, label?: string): void {
    if (pct === null) {
      this.progressWrap.classList.remove('visible')
    } else {
      this.progressWrap.classList.add('visible')
      this.progressFill.style.width = `${Math.round(pct * 100)}%`
      if (label) this.statusText.textContent = label
    }
  }

  /**
   * Builds (or updates) a Three.js PerspectiveCamera from the current SLAM pose.
   * Uses the camera intrinsics (FOV + aspect) read from processGpuResult.reality.
   */
  private _buildCameraFromProvider(): THREE.PerspectiveCamera | null {
    if (!this.provider.isTracking()) return null

    const pose   = this.provider.getPose()
    const fovY   = this.provider.getCameraFovY()
    const aspect = this.provider.getCameraAspect()

    if (!this._projCam) {
      this._projCam = new THREE.PerspectiveCamera(fovY, aspect, 0.01, 1000)
    } else {
      this._projCam.fov    = fovY
      this._projCam.aspect = aspect
      this._projCam.updateProjectionMatrix()
    }

    this._projCam.position.set(pose.position.x, pose.position.y, pose.position.z)
    this._projCam.quaternion.set(
      pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w,
    )
    this._projCam.updateMatrixWorld(true)
    return this._projCam
  }

  private syncPins(): void {
    const dets = this.store.detections

    for (const [key, el] of this.pinMap) {
      if (!dets.has(key)) {
        el.remove()
        this.pinMap.delete(key)
      }
    }

    for (const [key, det] of dets) {
      if (this.pinMap.has(key)) continue

      const color = categoryColor(det.label)

      const wrap = document.createElement('div')
      wrap.className = 'ar-pin-wrap'
      wrap.dataset['key'] = key
      wrap.style.cssText = 'position:absolute;pointer-events:none;display:none;transform-origin:bottom center;'

      // Pill label
      const pill = document.createElement('div')
      pill.style.cssText = `
        background:rgba(0,0,0,0.82);
        backdrop-filter:blur(10px);
        border:1.5px solid ${color};
        border-radius:20px;
        padding:6px 11px 6px 8px;
        display:flex;align-items:center;gap:6px;
        font-size:13px;white-space:nowrap;
        box-shadow:0 2px 16px rgba(0,0,0,0.55);
        transform:translateX(-50%) translateY(-100%);
        position:relative;
      `

      const dot = document.createElement('span')
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;box-shadow:0 0 8px ${color};`

      const labelSpan = document.createElement('span')
      labelSpan.style.cssText = 'color:#fff;font-weight:700;letter-spacing:0.01em;'
      labelSpan.textContent = det.label

      const confSpan = document.createElement('span')
      confSpan.style.cssText = 'color:rgba(255,255,255,0.45);font-size:11px;'
      confSpan.textContent = `${Math.round(det.confidence * 100)}%`

      const distSpan = document.createElement('span')
      distSpan.className = 'ar-pin-dist'
      distSpan.style.cssText = `color:${color};font-size:11px;margin-left:1px;`

      pill.append(dot, labelSpan, confSpan, distSpan)

      // Anchor dot at the world-point location on screen
      const anchor = document.createElement('div')
      anchor.style.cssText = `
        position:absolute;
        top:0;left:0;
        width:10px;height:10px;border-radius:50%;
        background:${color};
        box-shadow:0 0 10px ${color};
        transform:translate(-50%,-50%);
      `

      // Connector line between anchor and pill
      const line = document.createElement('div')
      line.className = 'ar-pin-line'
      line.style.cssText = `
        position:absolute;
        top:0;left:0;
        width:1px;
        transform-origin:top left;
        background:linear-gradient(to bottom,${color},rgba(0,0,0,0));
        opacity:0.7;
        pointer-events:none;
      `

      wrap.append(anchor, line, pill)
      wrap.classList.add('entering')
      this.container.appendChild(wrap)
      this.pinMap.set(key, wrap)
      // Remove entrance class after animation completes
      setTimeout(() => wrap.classList.remove('entering'), 400)
    }
  }

  private tickPins(camera: THREE.Camera): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)
    const proj = new THREE.Vector3()

    for (const [key, wrap] of this.pinMap) {
      const det = this.store.detections.get(key)
      if (!det) { wrap.style.display = 'none'; continue }

      const { x, y, z } = det.worldPos
      proj.set(x, y, z).project(camera)

      // Behind camera (NDC z > 1)
      if (proj.z > 1) { wrap.style.display = 'none'; continue }

      const sx = ((proj.x + 1) / 2) * w
      const sy = ((-proj.y + 1) / 2) * h
      const dist = camPos.distanceTo(new THREE.Vector3(x, y, z))

      if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100 || dist > 20) {
        wrap.style.display = 'none'
        continue
      }

      // Scale: full size at 1m, smallest at 8m
      const scale = Math.max(0.45, Math.min(1, 1.2 - dist / 10))
      const PILL_H = 32 // approximate pill height in px

      wrap.style.display = 'block'
      wrap.style.left = `${sx}px`
      wrap.style.top  = `${sy}px`
      wrap.style.transform = `scale(${scale.toFixed(2)})`

      // Connector line from anchor (0,0) up to pill bottom
      const lineEl = wrap.querySelector<HTMLElement>('.ar-pin-line')
      if (lineEl) {
        const lineH = PILL_H * scale + 8
        lineEl.style.height = `${lineH}px`
        lineEl.style.transform = `translateX(-0.5px) translateY(-${lineH}px)`
      }

      // Live distance in pill
      const distEl = wrap.querySelector<HTMLElement>('.ar-pin-dist')
      if (distEl) {
        distEl.textContent = dist < 1
          ? `${Math.round(dist * 100)} cm`
          : `${dist.toFixed(1)} m`
      }
    }
  }
}
