/**
 * SceneEditor — semantic tagging and view-mode management for the 3D viewer.
 *
 * Features:
 *   - View modes: points | solid | wireframe | semantic
 *   - Raycast object selection with highlight
 *   - Semantic tag assignment (written back to node.userData)
 *   - Object rename and notes
 *   - Inspector data extraction from GLTF node.userData
 */

import * as THREE from 'three'

// ── Semantic tag catalogue ─────────────────────────────────────────────────────

export const SEMANTIC_TAGS = [
  // Architecture
  'wall', 'floor', 'ceiling', 'window', 'door', 'stair', 'column', 'ramp',
  // Kitchen / bath fixtures
  'countertop', 'cabinet', 'appliance', 'sink', 'toilet', 'tub', 'shower',
  // Electrical / mechanical
  'outlet', 'switch', 'light-fixture', 'vent', 'radiator',
  // Furniture
  'chair', 'table', 'sofa', 'bed', 'desk', 'shelf', 'wardrobe', 'lamp', 'plant',
  // Electronics
  'monitor', 'tv', 'laptop',
  // Meta
  'structural', 'clutter', 'unknown',
] as const

export type SemanticTag = typeof SEMANTIC_TAGS[number] | string

export type ViewMode = 'points' | 'solid' | 'wireframe' | 'semantic'

// Colour palette for semantic view mode
const SEMANTIC_COLORS: Partial<Record<SemanticTag, number>> = {
  wall:       0x78909c,
  floor:      0x546e7a,
  ceiling:    0x90a4ae,
  window:     0x80deea,
  door:       0xffcc80,
  chair:      0x4fc3f7,
  table:      0x81c784,
  sofa:       0xff8a65,
  bed:        0xce93d8,
  desk:       0xa5d6a7,
  monitor:    0x80cbc4,
  tv:         0x80cbc4,
  shelf:      0xc5e1a5,
  lamp:       0xfff176,
  plant:      0x66bb6a,
  countertop: 0xffab91,
  cabinet:    0xffccbc,
  appliance:  0xb0bec5,
  sink:       0x80deea,
  toilet:     0xf8bbd0,
  structural: 0xef9a9a,
  clutter:    0xbdbdbd,
  unknown:    0x757575,
}
const DEFAULT_SEMANTIC_COLOR = 0x9e9e9e

export interface TagInfo {
  tag: SemanticTag
  name: string
  notes: string
  roomName: string
  floorName: string
  /** Manual override flag — user-set tag takes precedence over AI suggestion */
  manualOverride: boolean
}

export interface InspectorData {
  objectId: string
  name: string
  tag?: SemanticTag
  aiLabel?: string
  confidence?: number
  description?: string
  worldPos?: { x: number; y: number; z: number }
  dimensions?: { w: number; h: number; d: number }
  sourceScan?: string
  notes?: string
  roomName?: string
  floorName?: string
  bbox?: number[]
}

// ── SceneEditor class ──────────────────────────────────────────────────────────

export class SceneEditor {
  private _mode: ViewMode = 'solid'
  private _scene: THREE.Scene | null = null
  private _selected: THREE.Object3D | null = null
  private _tags = new Map<string, TagInfo>()
  /** Cloned materials saved before wireframe/semantic mode changes them */
  private _origMaterials = new Map<string, THREE.Material | THREE.Material[]>()
  /** Raycaster for click picking */
  private _raycaster = new THREE.Raycaster()

  get mode(): ViewMode { return this._mode }
  get selectedObject(): THREE.Object3D | null { return this._selected }

  /** Called when a new GLB scene is loaded */
  setScene(scene: THREE.Scene): void {
    this._scene = scene
    this._selected = null
    this._origMaterials.clear()
    this._tags.clear()

    // Pre-populate tags from node.userData (written by a previous edit session)
    scene.traverse((obj) => {
      const ud = obj.userData as Record<string, unknown>
      if (ud['tag'] && typeof ud['tag'] === 'string') {
        this._tags.set(obj.uuid, {
          tag: ud['tag'] as SemanticTag,
          name: (ud['label'] as string | undefined) ?? obj.name,
          notes: (ud['notes'] as string | undefined) ?? '',
          roomName: (ud['roomName'] as string | undefined) ?? '',
          floorName: (ud['floorName'] as string | undefined) ?? '',
          manualOverride: !!(ud['manualOverride']),
        })
      }
    })
  }

  /** Switch between view modes. Respects `scene`. */
  setMode(mode: ViewMode): void {
    this._mode = mode
    if (!this._scene) return

    this._scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      if (mode === 'solid' || mode === 'wireframe') {
        this._restoreOriginalMaterial(obj)
        if (mode === 'wireframe') {
          const wf = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, wireframe: true })
          this._setMaterial(obj, wf)
        }
      } else if (mode === 'semantic') {
        this._applySemanticMaterial(obj)
      } else if (mode === 'points') {
        // hide meshes, keep point cloud visible (handled by outside caller)
        this._restoreOriginalMaterial(obj)
      }
    })

    if (!this._scene) return
    // In points mode hide all Mesh children except the Points cloud
    this._scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      obj.visible = mode !== 'points'
    })
    this._scene.traverse((obj) => {
      if (obj instanceof THREE.Points) obj.visible = true
    })
  }

  /** Perform a raycast pick at normalised device coordinates.
   *  @param ndx  -1…1 horizontal
   *  @param ndy  -1…1 vertical (top = +1)
   */
  pick(ndx: number, ndy: number, camera: THREE.Camera): THREE.Object3D | null {
    if (!this._scene) return null
    this._raycaster.setFromCamera(new THREE.Vector2(ndx, ndy), camera)
    const hits = this._raycaster.intersectObjects(this._scene.children, true)
      .filter(h => h.object instanceof THREE.Mesh || h.object instanceof THREE.Points)
    if (hits.length === 0) { this._clearSelection(); return null }

    const obj = hits[0].object
    this._selectObject(obj)
    return obj
  }

  /** Assign a semantic tag to an object */
  tagObject(obj: THREE.Object3D, tag: SemanticTag, opts: Partial<Omit<TagInfo, 'tag'>> = {}): void {
    const existing = this._tags.get(obj.uuid)
    const info: TagInfo = {
      tag,
      name: opts.name ?? existing?.name ?? obj.name,
      notes: opts.notes ?? existing?.notes ?? '',
      roomName: opts.roomName ?? existing?.roomName ?? '',
      floorName: opts.floorName ?? existing?.floorName ?? '',
      manualOverride: true,
    }
    this._tags.set(obj.uuid, info)
    // Update userData so it gets persisted in the next GLB export
    const ud = obj.userData as Record<string, unknown>
    ud['tag'] = tag
    ud['label'] = info.name
    ud['notes'] = info.notes
    ud['roomName'] = info.roomName
    ud['floorName'] = info.floorName
    ud['manualOverride'] = true

    // Refresh material in semantic mode
    if (this._mode === 'semantic' && obj instanceof THREE.Mesh) {
      this._applySemanticMaterial(obj)
    }
  }

  getTagInfo(obj: THREE.Object3D): TagInfo | undefined {
    return this._tags.get(obj.uuid)
  }

  getInspectorData(obj: THREE.Object3D): InspectorData {
    const ud = obj.userData as Record<string, unknown>
    const tagInfo = this._tags.get(obj.uuid)
    const wp = new THREE.Vector3()
    obj.getWorldPosition(wp)
    const dims = new THREE.Box3()
      .setFromObject(obj)
      .getSize(new THREE.Vector3())

    return {
      objectId: obj.uuid,
      name: tagInfo?.name ?? (ud['label'] as string | undefined) ?? obj.name,
      tag: tagInfo?.tag ?? (ud['tag'] as SemanticTag | undefined),
      aiLabel: ud['label'] as string | undefined,
      confidence: ud['confidence'] as number | undefined,
      description: ud['description'] as string | undefined,
      worldPos: { x: +wp.x.toFixed(3), y: +wp.y.toFixed(3), z: +wp.z.toFixed(3) },
      dimensions: { w: +dims.x.toFixed(2), h: +dims.y.toFixed(2), d: +dims.z.toFixed(2) },
      sourceScan: ud['sourceScan'] as string | undefined,
      notes: tagInfo?.notes ?? ud['notes'] as string | undefined,
      roomName: tagInfo?.roomName ?? ud['roomName'] as string | undefined,
      floorName: tagInfo?.floorName ?? ud['floorName'] as string | undefined,
      bbox: ud['bbox'] as number[] | undefined,
    }
  }

  /** Write all tag info back to userData on every tagged node (call before re-export) */
  flushTags(): void {
    if (!this._scene) return
    this._scene.traverse((obj) => {
      const info = this._tags.get(obj.uuid)
      if (!info) return
      const ud = obj.userData as Record<string, unknown>
      ud['tag'] = info.tag
      ud['label'] = info.name
      ud['notes'] = info.notes
      ud['roomName'] = info.roomName
      ud['floorName'] = info.floorName
      ud['manualOverride'] = info.manualOverride
    })
  }

  /** Return all tags as a serialisable map */
  exportTagMap(): Record<string, TagInfo> {
    this.flushTags()
    return Object.fromEntries(this._tags.entries())
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private _selectObject(obj: THREE.Object3D): void {
    this._clearSelection()
    this._selected = obj
    if (obj instanceof THREE.Mesh) {
      const mat = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const m of mat) {
        if ('emissive' in m) {
          (m as THREE.MeshBasicMaterial & { emissive: THREE.Color }).emissive?.set(0x334466)
        }
      }
    }
  }

  private _clearSelection(): void {
    if (this._selected instanceof THREE.Mesh) {
      const mat = Array.isArray(this._selected.material)
        ? this._selected.material
        : [this._selected.material]
      for (const m of mat) {
        if ('emissive' in m) {
          (m as THREE.MeshBasicMaterial & { emissive: THREE.Color }).emissive?.set(0x000000)
        }
      }
    }
    this._selected = null
  }

  private _saveOriginalMaterial(obj: THREE.Mesh): void {
    if (!this._origMaterials.has(obj.uuid)) {
      this._origMaterials.set(obj.uuid,
        Array.isArray(obj.material) ? [...obj.material] : obj.material)
    }
  }

  private _restoreOriginalMaterial(obj: THREE.Mesh): void {
    const orig = this._origMaterials.get(obj.uuid)
    if (orig !== undefined) obj.material = orig as typeof obj.material
  }

  private _setMaterial(obj: THREE.Mesh, mat: THREE.Material): void {
    this._saveOriginalMaterial(obj)
    obj.material = mat
  }

  private _applySemanticMaterial(obj: THREE.Mesh): void {
    const ud = obj.userData as Record<string, unknown>
    const tagInfo = this._tags.get(obj.uuid)
    const tag = tagInfo?.tag ?? (ud['tag'] as SemanticTag | undefined)
    const color = tag ? (SEMANTIC_COLORS[tag] ?? DEFAULT_SEMANTIC_COLOR) : DEFAULT_SEMANTIC_COLOR
    const mat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.72,
      roughness: 0.9,
      metalness: 0.0,
    })
    this._saveOriginalMaterial(obj)
    obj.material = mat
  }
}
