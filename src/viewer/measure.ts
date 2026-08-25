/**
 * MeasureTool — two-click distance measurement for the World Scan Editor.
 *
 * Click two points on any scan geometry (meshes or point clouds) and a line is
 * drawn between them, labelled with the straight-line distance in the scene's
 * *world* units.
 *
 * **The "m" suffix is only earned by geometry that arrived metric.** The label
 * (`_draw` below) writes `m` unconditionally, and the raycast accepts any
 * visible `THREE.Mesh`/`THREE.Points` in the scene — it does not ask where the
 * geometry's scale came from. Today that splits three ways:
 *
 *  - **GLB scan geometry — metres.** Exported from an AR session whose poses are
 *    already metric (subject to SLAM drift, but in real units). This is the case
 *    the test-home corpus exercises, and the only one where a reading is a
 *    real-world dimension.
 *  - **LingBot-Map point clouds — NOT metres.** `src/viewer/lingbot-map.ts`
 *    attaches `lingbot-map.point-cloud.ply` under the scan root with no scale
 *    recovery, and `scripts/lingbot_map_worker.py` writes the model's
 *    `world_points` verbatim. Monocular reconstruction is scale-blind (see
 *    `server/splat/splat_align.ts`'s header), so measuring across those points
 *    yields an arbitrary-unit number wearing a metre suffix.
 *  - **Trained splats — not measurable at all.** SparkJS's `SplatMesh` extends
 *    `SplatGenerator extends THREE.Object3D`, so the filter in `handleClick`
 *    never returns one. Note the inversion this leaves: `SparkRenderer` *does*
 *    extend `THREE.Mesh` (a 2x2 double-sided quad at the scene origin, added
 *    unconditionally by `attachSparkRenderer`) and is NOT excluded here, so a
 *    ray through the origin can snap to it instead of to real geometry.
 *
 * Making the readout state its own frame — the way `splat-layer.ts`'s
 * `formatAlignmentStatus` does for a splat — is unfinished work, not a decision.
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

  /**
   * Distance of the last completed measurement, in the scene's world units
   * (null when none). Metres only when both clicked points landed on geometry
   * that arrived metric — see the unit caveat in this file's header; the name
   * is kept because `window.__measureTool.lastDistanceM` is a published test
   * hook (tests/mock-editor-homes.spec.ts).
   */
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
