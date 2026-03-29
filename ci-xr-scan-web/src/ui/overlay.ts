/**
 * AR overlay — label pins + capture button + status bar.
 *
 * Label pins are absolutely-positioned <div>s whose screen position is updated
 * every AR frame by projecting each detection's 3D world position through the
 * current Three.js camera.
 *
 * In 8th Wall the camera is accessible via XR8.Threejs.xrScene().
 * In WebXR the caller must pass the camera matrix via tick().
 */
import * as THREE from 'three'
import type { DetectionStore } from '../scene/store'

declare const XR8: {
  addCameraPipelineModule(mod: object): void
  Threejs: {
    xrScene(): { camera: THREE.Camera } | null
  }
}

export type CaptureButtonCallback = () => Promise<void>

export class AROverlay {
  private container: HTMLElement
  private statusText: HTMLElement
  private progressWrap: HTMLElement
  private progressFill: HTMLElement
  private captureBtn: HTMLButtonElement
  private pinMap = new Map<string, HTMLDivElement>()

  constructor(
    private readonly store: DetectionStore,
    private readonly use8thWall: boolean,
  ) {
    this.container = document.getElementById('ar-overlay')!
    this.statusText = document.getElementById('status-text')!
    this.progressWrap = document.getElementById('progress-bar-wrap')!
    this.progressFill = document.getElementById('progress-bar-fill')!
    this.captureBtn = document.getElementById('capture-btn') as HTMLButtonElement

    // Re-render pins whenever the store changes
    store.subscribe(() => this.syncPins())
  }

  mount(onCapture: CaptureButtonCallback): void {
    this.captureBtn.addEventListener('click', async () => {
      if (this.captureBtn.classList.contains('busy')) return
      this.captureBtn.classList.add('busy')
      try {
        await onCapture()
      } finally {
        this.captureBtn.classList.remove('busy')
      }
    })

    if (this.use8thWall) {
      // Hook into the 8th Wall pipeline so pin positions update every render frame
      XR8.addCameraPipelineModule({
        name: 'ci-scan-overlay-tick',
        onRender: () => {
          const xrScene = XR8.Threejs.xrScene?.()
          if (xrScene?.camera) this.tickPins(xrScene.camera as THREE.Camera)
        },
      })
    }
    // For WebXR, call tick() manually from the XR frame loop in main.ts
  }

  /** Call every frame with the current AR camera to reposition pins */
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

  private syncPins(): void {
    const dets = this.store.detections

    // Remove pins for detections that no longer exist
    for (const [key, el] of this.pinMap) {
      if (!dets.has(key)) {
        el.remove()
        this.pinMap.delete(key)
      }
    }

    // Add pins for new detections
    for (const [key, det] of dets) {
      if (!this.pinMap.has(key)) {
        const pin = document.createElement('div')
        pin.className = 'ar-pin'
        pin.dataset['key'] = key
        pin.textContent = det.label
        pin.style.display = 'none'
        this.container.appendChild(pin)
        this.pinMap.set(key, pin)
      }
    }
  }

  private tickPins(camera: THREE.Camera): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const proj = new THREE.Vector3()

    for (const [key, pin] of this.pinMap) {
      const det = this.store.detections.get(key)
      if (!det) { pin.style.display = 'none'; continue }

      const { x, y, z } = det.worldPos
      proj.set(x, y, z).project(camera)

      // proj.z > 1 means behind the camera
      if (proj.z > 1) { pin.style.display = 'none'; continue }

      const sx = ((proj.x + 1) / 2) * w
      const sy = ((-proj.y + 1) / 2) * h

      // Hide if off-screen
      if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) {
        pin.style.display = 'none'
        continue
      }

      pin.style.display = 'block'
      pin.style.left = `${sx}px`
      pin.style.top = `${sy}px`
    }
  }
}
