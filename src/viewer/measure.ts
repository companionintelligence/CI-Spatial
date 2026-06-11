/**
 * MeasureTool — two-click distance measurement for the World Scan Editor.
 *
 * Click two points on any scan geometry (meshes or point clouds) and a line
 * with a metre readout is drawn between them.  The world is metric ENU, so
 * measurements against the generated test homes can be asserted exactly
 * (e.g. a wall of home-00-studio-a measures its expected.json dims).
 *
 * Exposed as `window.__measureTool` for automated tests.
 */
import * as THREE from 'three'

const MARKER_RADIUS = 0.025
const POINTS_THRESHOLD = 0.06

export class MeasureTool {
  private _active = false
  private _points: THREE.Vector3[] = []
  private _group: THREE.Group | null = null
  private _label: HTMLElement | null = null
  private _lastDistance: number | null = null
  private _raycaster = new THREE.Raycaster()

  constructor(
    private readonly getScene: () => THREE.Scene | null,
    private readonly viewport: HTMLElement,
  ) {
    this._raycaster.params.Points = { threshold: POINTS_THRESHOLD }
  }

  get active(): boolean {
    return this._active
  }

  /** Distance of the last completed measurement, metres (null when none) */
  get lastDistanceM(): number | null {
    return this._lastDistance
  }

  toggle(): boolean {
    this._active = !this._active
    if (!this._active) this.clear()
    return this._active
  }

  clear(): void {
    this._points = []
    this._lastDistance = null
    if (this._group) {
      this._group.removeFromParent()
      this._group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose()
        }
      })
      this._group = null
    }
    this._label?.remove()
    this._label = null
  }

  /**
   * Handle a viewport click at NDC coords.  Returns true when the click was
   * consumed by the tool (measure mode active and geometry was hit).
   */
  handleClick(ndx: number, ndy: number, camera: THREE.Camera): boolean {
    if (!this._active) return false
    const scene = this.getScene()
    if (!scene) return false

    this._raycaster.setFromCamera(new THREE.Vector2(ndx, ndy), camera)
    const hits = this._raycaster.intersectObjects(scene.children, true)
      .filter((h) => (h.object instanceof THREE.Mesh || h.object instanceof THREE.Points)
        && h.object.visible && !h.object.name.startsWith('measure-'))
    if (hits.length === 0) return true // consume the click anyway in measure mode

    const point = hits[0].point.clone()
    if (this._points.length >= 2) this.clear()
    this._points.push(point)
    this._draw(scene)

    if (this._points.length === 2) {
      this._lastDistance = this._points[0].distanceTo(this._points[1])
    }
    return true
  }

  /** Re-project the distance label each frame (call from the render loop) */
  updateLabel(camera: THREE.Camera): void {
    if (!this._label || this._points.length !== 2) return
    const mid = this._points[0].clone().add(this._points[1]).multiplyScalar(0.5)
    mid.project(camera)
    if (mid.z > 1) {
      this._label.style.display = 'none'
      return
    }
    const w = this.viewport.clientWidth
    const h = this.viewport.clientHeight
    this._label.style.display = 'block'
    this._label.style.left = `${(mid.x * 0.5 + 0.5) * w}px`
    this._label.style.top = `${(-mid.y * 0.5 + 0.5) * h}px`
  }

  private _draw(scene: THREE.Scene): void {
    if (!this._group) {
      this._group = new THREE.Group()
      this._group.name = 'measure-overlay'
      scene.add(this._group)
    }

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(MARKER_RADIUS, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd600, depthTest: false }),
    )
    marker.name = 'measure-marker'
    marker.renderOrder = 10
    marker.position.copy(this._points[this._points.length - 1])
    this._group.add(marker)

    if (this._points.length === 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(this._points)
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xffd600, depthTest: false }),
      )
      line.name = 'measure-line'
      line.renderOrder = 10
      this._group.add(line)

      const distance = this._points[0].distanceTo(this._points[1])
      this._label = document.createElement('div')
      this._label.id = 'measure-label'
      this._label.textContent = `${distance.toFixed(2)} m`
      this._label.style.cssText =
        'position:absolute;transform:translate(-50%,-130%);padding:3px 9px;border-radius:6px;' +
        'background:rgba(255,214,0,0.92);color:#1a1500;font-size:12px;font-weight:800;' +
        'pointer-events:none;z-index:60;white-space:nowrap;'
      this.viewport.appendChild(this._label)
    }
  }
}
