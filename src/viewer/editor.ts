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
  /**
   * Plural, matching what the exporter has always written. This read used to
   * be `ud['sourceScan']` (singular) while gltf.ts wrote `sourceScanIds`, so
   * the field was unconditionally undefined — and nothing rendered it either,
   * which is how the mismatch survived. See
   * docs/factory/07-scan-identity/0003-node-level-glb-provenance.md.
   */
  sourceScanIds?: string[]
  /**
   * Per-node provenance (src/shared/provenance.ts).
   *
   * Nullable, not merely optional: `ScanProvenance.sessionId` is
   * `string | null`, and the exporter writes an explicit `null` for a capture
   * taken with no server keyframe session. Absent and "there was no session"
   * are different facts, and typing this as a bare `string` would launder the
   * second into the first.
   */
  sessionId?: string | null
  /** Stamped server-side during the optimize pass, so absent on a raw upload. */
  scanId?: string
  capturedAt?: string
  captureIndex?: number
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
    const supportedModes: ViewMode[] = ['points', 'solid', 'wireframe', 'semantic']
    const nextMode: ViewMode = supportedModes.includes(mode) ? mode : 'solid'
    this._mode = nextMode
    if (!this._scene) return

    this._scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      if (nextMode === 'solid' || nextMode === 'wireframe') {
        this._restoreOriginalMaterial(obj)
        if (nextMode === 'wireframe') {
          const wf = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, wireframe: true })
          this._setMaterial(obj, wf)
        }
      } else if (nextMode === 'semantic') {
        this._applySemanticMaterial(obj)
      } else if (nextMode === 'points') {
        // hide meshes, keep point cloud visible (handled by outside caller)
        this._restoreOriginalMaterial(obj)
      }
    })

    if (!this._scene) return
    // In points mode hide all Mesh children except the Points cloud
    this._scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      obj.visible = nextMode !== 'points'
    })
    this._scene.traverse((obj) => {
      if (obj instanceof THREE.Points) obj.visible = true
    })
  }

  /** Perform a raycast pick at normalised device coordinates.
   *  @param ndx  -1…1 horizontal
   *  @param ndy  -1…1 vertical (top = +1)
   *  @param excluded  a subtree the pick ignores, the transform gizmo's helper
   */
  pick(ndx: number, ndy: number, camera: THREE.Camera, excluded: THREE.Object3D | null = null): THREE.Object3D | null {
    if (!this._scene) return null
    this._raycaster.setFromCamera(new THREE.Vector2(ndx, ndy), camera)
    const hits = this._raycaster.intersectObjects(this._scene.children, true)
      .filter(h => h.object instanceof THREE.Mesh || h.object instanceof THREE.Points)

    // Hits arrive nearest first. A point cloud or the gizmo in front must not hide the object
    // behind it, so an unlabelled point is passed through, and so is anything under `excluded`
    // (the gizmo helper). The first hit that resolves to an edit target wins. Any other
    // unlabelled mesh is solid and still stops the pick, as it always has, so a wall never
    // selects an object behind it. The selection clears when nothing resolves. The raycaster
    // ignores `visible`, so a hidden object (or anything under a hidden node) is skipped here:
    // it is not drawn, so it neither resolves nor blocks what is behind it.
    let picked: THREE.Object3D | null = null
    for (const hit of hits) {
      if (!objectRenderable(hit.object)) continue
      if (excluded && isWithin(hit.object, excluded)) continue
      picked = this._editTargetFor(hit.object)
      if (picked) break
      if (!(hit.object instanceof THREE.Points)) break
    }
    if (!picked) { this._clearSelection(); return null }
    this._selectObject(picked)
    return picked
  }

  /**
   * The node an edit is written against for one raycast hit. Null when the walk up from
   * the hit reaches the scene without finding a labelled node or an LOD.
   */
  private _editTargetFor(hit: THREE.Object3D): THREE.Object3D | null {
    let obj: THREE.Object3D | null = hit
    // Walk up the parent chain to the node an edit should be written against: the
    // THREE.LOD for a semantic object, or the nearest labelled node otherwise.
    //
    // The LOD test MUST run before the label test, and the order is load-bearing.
    // In upgradeSemanticMeshes() (viewer.ts) the medium and high proxies are assigned
    // lod.userData *by reference*, and the far level is the original mesh, which keeps
    // its own userData — carrying the label the GLB gave it. So a label can be found on
    // a level whichever one the ray reaches. With the label test first, the walk stopped
    // at that level, and the gizmo moved it while the saved patch was replayed onto the
    // LOD — so the object came back displaced, and rescaled by the medium proxy's
    // normalisation. Testing parent-is-LOD first resolves to the LOD from every shape.
    // Labelled nodes outside an LOD still select as themselves, because their
    // parent is not an LOD and the label test still decides.
    //
    // This comment used to cite splat-detect boxes as that case. It is not one:
    // buildDetectBoxes() (src/viewer/splat-detect-layer.ts) makes each box a
    // THREE.LineSegments, and the filter above admits only Mesh and Points, so a
    // detect box is never a raycast hit and never reachable by the walk. The
    // splat-detect overlay is display-only in the editor today — it cannot be
    // picked, inspected, or moved by the gizmo.
    while (obj && obj !== this._scene) {
      if (obj.parent && obj.parent instanceof THREE.LOD) {
        obj = obj.parent
        break
      }
      if (obj.userData && obj.userData['label']) {
        break
      }
      obj = obj.parent
    }

    return obj && obj !== this._scene ? obj : null
  }

  /**
   * Select an object directly — e.g. re-attaching the gizmo to an object that
   * survived a scene reload, or a test hook that resolves a selection through some
   * other means — without going through a raycast pick(). Callers that already know
   * which object should be selected must go through this (not reach into `_selected`)
   * so the highlight tint and `selectedObject` stay in sync the same way a real
   * pick() keeps them in sync.
   */
  selectObject(obj: THREE.Object3D): void {
    this._selectObject(obj)
  }

  /** Clear the current selection — the public counterpart to selectObject(). */
  clearSelection(): void {
    this._clearSelection()
  }

  /** Assign a semantic tag to an object */
  tagObject(obj: THREE.Object3D, tag: SemanticTag, opts: Partial<Omit<TagInfo, 'tag'>> = {}): void {
    const existing = this._tags.get(obj.uuid)
    const ud = obj.userData as Record<string, unknown>
    const info: TagInfo = {
      tag,
      name: opts.name ?? existing?.name ?? obj.name,
      // A note saved before the object had a tag lives on userData alone (see setNotes).
      notes: opts.notes ?? existing?.notes ?? (ud['notes'] as string | undefined) ?? '',
      roomName: opts.roomName ?? existing?.roomName ?? '',
      floorName: opts.floorName ?? existing?.floorName ?? '',
      manualOverride: true,
    }
    this._tags.set(obj.uuid, info)
    // Update userData so it gets persisted in the next GLB export
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

  /**
   * Save a note. An object without a tag keeps no tag entry, so a note alone never
   * writes a category or marks a manual override.
   */
  setNotes(obj: THREE.Object3D, notes: string): void {
    const existing = this._tags.get(obj.uuid)
    if (existing) this.tagObject(obj, existing.tag, { ...existing, notes })
    else (obj.userData as Record<string, unknown>)['notes'] = notes
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
      sourceScanIds: Array.isArray(ud['sourceScanIds']) ? ud['sourceScanIds'] as string[] : undefined,
      sessionId: ud['sessionId'] as string | null | undefined,
      scanId: ud['scanId'] as string | undefined,
      capturedAt: ud['capturedAt'] as string | undefined,
      captureIndex: ud['captureIndex'] as number | undefined,
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


  // ── Private helpers ───────────────────────────────────────────────────────────

  private _selectObject(obj: THREE.Object3D): void {
    this._clearSelection()
    this._selected = obj
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = Array.isArray(child.material) ? child.material : [child.material]
        for (const m of mat) {
          if ('emissive' in m) {
            const anyM = m as any
            if (anyM._origEmissive === undefined) {
              anyM._origEmissive = anyM.emissive ? anyM.emissive.getHex() : 0
            }
            anyM.emissive?.set(0x334466)
          }
        }
      }
    })
  }

  private _clearSelection(): void {
    if (this._selected) {
      this._selected.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mat = Array.isArray(child.material) ? child.material : [child.material]
          for (const m of mat) {
            if ('emissive' in m) {
              const anyM = m as any
              const orig = anyM._origEmissive !== undefined ? anyM._origEmissive : 0
              anyM.emissive?.setHex(orig)
            }
          }
        }
      })
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

/** What a save run reports to the Edit panel. */
export type EditSaveState = 'saving' | 'saved' | 'failed'

/**
 * True when the server refused an edit for good: a 4xx other than 408 or 429. Sending the
 * same edit again cannot change that. The error carries the HTTP status (httpError() in
 * viewer.ts sets it).
 */
export function isPermanentEditError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * True when the world link refused an edit: a 401 or 403 from the patches route. Those come from
 * the link's own checks (no editor token, an invalid or expired world token, or a role below
 * editor), not from a Companion sign-in. The retry treatment is still isPermanentEditError's.
 * This only picks the copy the Edit panel and Save Tags show.
 */
export function isLinkRefusalError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return status === 401 || status === 403
}

interface PendingEdit {
  readonly edit: () => Promise<void>
  /** The server refused this edit for good. Later saves leave it alone until its own key is saved again. */
  refused: boolean
  /** The world link refused this edit (401, 403). Only meaningful once refused is true. */
  linkRefused: boolean
}

/** A save's own edit and the key it was queued under. */
interface OwnEdit {
  readonly key: string
  readonly entry: PendingEdit
}

/**
 * What one run answers: the save's result, or 'superseded' when a newer save for the same key
 * replaced the edit before this run reached it. The newer save then decides the answer.
 */
type RunResult = boolean | 'superseded'

/**
 * Patch saves for in-memory edits. An edit that fails stays pending, and every later
 * save tries the pending edits again, oldest first, so it reaches the server once a
 * save succeeds. An edit the server refuses for good stays pending too, so it still
 * counts as unsaved, but later saves do not post it again. Runs are serialized, so two
 * saves never post at the same time. A newer save for the same key replaces the older
 * closure, which already reads the latest in-memory state.
 */
export class PendingSaves {
  private readonly _notify: (state: EditSaveState) => void
  private readonly _pending = new Map<string, PendingEdit>()
  /** The run of the newest save for each key. A save that a newer one replaced answers with that run. */
  private readonly _newestRun = new Map<string, Promise<RunResult>>()
  private _chain: Promise<void> = Promise.resolve()
  private _queued = 0
  private _epoch = 0

  constructor(notify: (state: EditSaveState) => void) {
    this._notify = notify
  }

  /** Edits still waiting for the server, including any the server refused. */
  get pendingCount(): number {
    return this._pending.size
  }

  /** Edits the server refused for good. Save Tags does not send these again. */
  get refusedCount(): number {
    let count = 0
    for (const entry of this._pending.values()) {
      if (entry.refused) count++
    }
    return count
  }

  /** Refused edits the world link turned down (401, 403). Only these are named as a link refusal. */
  get linkRefusedCount(): number {
    let count = 0
    for (const entry of this._pending.values()) {
      if (entry.refused && entry.linkRefused) count++
    }
    return count
  }

  /** True while a save is queued or posting, so an edit may still be on its way to the server. */
  get inFlight(): boolean {
    return this._queued > 0
  }

  /**
   * Queue a save. `key` names the edit and `edit` posts its current state. Pass no `edit`
   * to retry only what is pending (Save Tags). Resolves true when the edit this save
   * queued reached the server, in this run or an earlier one. It resolves false when that
   * edit failed, was refused, or was dropped by a Place switch. A newer save for the same
   * key that replaces it first decides the answer. With no edit, it resolves true when
   * every edit the run attempted reached the server and nothing is still pending.
   */
  save(key: string | null, edit?: () => Promise<void>): Promise<boolean> {
    // Taken now, not when the run starts: a Place switch between the two makes this run stale.
    const epoch = this._epoch
    const own: OwnEdit | null = key !== null && edit ? { key, entry: { edit, refused: false, linkRefused: false } } : null
    if (own) this._pending.set(own.key, own.entry)
    this._queued++
    const run = this._chain.then(() => this._run(epoch, own))
    this._chain = run.then(() => undefined, () => undefined)
    if (own) this._newestRun.set(own.key, run)
    return this._answer(run, own?.key ?? null)
  }

  /** Forget every pending edit. Called when the scene they were made in is replaced. */
  clear(): void {
    this._epoch++
    this._pending.clear()
    this._newestRun.clear()
  }

  /** A save that a newer save replaced answers with the newer save's run: its edit is the one that posts. */
  private _answer(run: Promise<RunResult>, key: string | null): Promise<boolean> {
    return run.then((result): boolean | Promise<boolean> => {
      if (result !== 'superseded') return result
      const newest = key === null ? undefined : this._newestRun.get(key)
      return newest ? this._answer(newest, key) : false
    })
  }

  private async _run(epoch: number, own: OwnEdit | null): Promise<RunResult> {
    // A run queued before a Place switch belongs to the scene that was left. It posts
    // nothing and reports nothing.
    const current = (): boolean => epoch === this._epoch
    // Set when this run reaches the save's own edit: true if the server accepted it.
    let ownPosted: boolean | undefined
    let anyFailed = false
    if (current()) {
      this._notify('saving')
      for (const [key, entry] of [...this._pending]) {
        // Skip an edit that was cleared or replaced since this run began. A newer save for
        // it is queued and runs on its own.
        if (this._pending.get(key) !== entry) continue
        // A refused edit is not posted again. It waits for a save of its own key, which replaces it
        // with a fresh entry. A save whose own edit is already refused answers false.
        if (entry.refused) {
          if (entry === own?.entry) ownPosted = false
          continue
        }
        try {
          await entry.edit()
          if (this._pending.get(key) === entry) this._pending.delete(key)
          if (entry === own?.entry) ownPosted = true
        } catch (error) {
          console.error('[viewer] edit not saved:', error)
          anyFailed = true
          if (entry === own?.entry) ownPosted = false
          if (isPermanentEditError(error)) {
            entry.refused = true
            entry.linkRefused = isLinkRefusalError(error)
          }
        }
      }
    }
    this._queued--
    // Report once the queue drains, and only if no Place switch overtook this run. The panel
    // says "Not saved" while any edit is still pending, including one the server refused.
    if (current() && this._queued === 0) this._notify(this._pending.size > 0 ? 'failed' : 'saved')
    if (own === null) return current() && !anyFailed && this._pending.size === 0
    if (ownPosted !== undefined) return ownPosted
    // This run did not reach the save's edit. A Place switch dropped it. Otherwise an earlier
    // run already posted it (it has left the queue), or a newer save for the key replaced it.
    if (!current()) return false
    return this._pending.has(own.key) ? 'superseded' : true
  }
}

/** Pixels a press may travel before its release counts as a drag. */
export const DRAG_TOLERANCE_PX = 4

/**
 * Pixels a touch or pen press may travel before its release counts as a drag. A finger
 * lands wider and drifts more than a mouse pointer, so a tap with a little movement must
 * still count as a click.
 */
export const TOUCH_DRAG_TOLERANCE_PX = 12

/** The drag tolerance for a press made with this pointer type (PointerEvent.pointerType). */
export function dragToleranceFor(pointerType: string): number {
  return pointerType === 'touch' || pointerType === 'pen' ? TOUCH_DRAG_TOLERANCE_PX : DRAG_TOLERANCE_PX
}

/**
 * True when the pointer moved farther than the tolerance between press and release, so
 * the gesture was a drag (an orbit, or a gizmo move). The click that follows a drag must
 * not pick, measure or clear the selection. With no recorded press it counts as a click.
 */
export function isDragRelease(
  press: { x: number; y: number } | null,
  release: { x: number; y: number },
  tolerancePx: number = DRAG_TOLERANCE_PX,
): boolean {
  if (!press) return false
  return Math.hypot(release.x - press.x, release.y - press.y) > tolerancePx
}

/** True when `obj` and every ancestor of it is visible. A hidden object, or one under a hidden node, is not drawn. */
export function objectRenderable(obj: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = obj; node; node = node.parent) {
    if (!node.visible) return false
  }
  return true
}

/** True when `obj` is `root` or sits beneath it. */
function isWithin(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = obj; node; node = node.parent) {
    if (node === root) return true
  }
  return false
}
