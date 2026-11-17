/**
 * The World Editor's repair path for a scan that does not line up: the "Place precisely" and "Compare"
 * sections of the Edit tab, and the gizmo that serves them.
 *
 * Three layers, so each can be tested where it lives:
 *   - transform-tools.ts    the arithmetic, on plain arrays (Node tests)
 *   - stitch-session.ts     the pivot proxy and the unsaved-move record, on THREE objects (Node tests)
 *   - this file             the DOM: fields, buttons, markers, the leave guard (the Playwright spec,
 *                           tests/mock-editor-stitching.spec.ts)
 *
 * viewer.ts calls in through a handful of one-line hooks and hands over what it owns by a {@link StitchHost}.
 * Nothing here touches the DOM until {@link createStitchTools} runs, so the file can be imported by Node.
 *
 * What it adds to the editor:
 *   - the gizmo turns a scan about its calibrated landmark (or the middle of its points), not about the
 *     point where the AR session started, so a 3 degree fix is one gizmo action;
 *   - numeric fields (along X, along Z, height, turn), +-1 and +-5 cm and +-0.5 and +-2 degree buttons, and
 *     a snap for drags;
 *   - the scan's size is locked: the Scale button is off for a scan, and "Fix size" is the one way to change it;
 *   - "Reset to calibrated" (an ordinary patch carrying the stored first placement), "Undo last save"
 *     (the server's revert route) and "Discard changes";
 *   - a marker on each scan with a move that is not saved, and a prompt before the page is left with one;
 *   - a note on a scan whose upload's placement the server set aside (it sits by GPS or the grid), with the reason;
 *   - a tint per scan and a see-through mode to compare two scans while one is moved onto the other.
 *
 * ## Integration point: "Match to neighbour" (WP-15a)
 *
 * The registration proposal for a scan (server/register, src/viewer/register-proposal.ts) is not built
 * yet. When it is, it calls {@link StitchTools.setNeighbourMatch} once with a {@link NeighbourMatchProvider}.
 * That makes the "Match to neighbour" button appear. A click asks the provider for a proposal and puts it
 * on the scan as an unsaved move, with the proposal's own words saying where it came from, so a person sees
 * it, can nudge or discard it, and saves it with Save Transform. A proposal is never applied on its own and
 * never saved by a click that was not on this button. Until a provider is registered the button stays hidden.
 */
import * as THREE from 'three'
import {
  applyCompareStyle,
  isPlainStyle,
  PLAIN_STYLE,
  TINT_PALETTE,
  tintForIndex,
  type CompareStyle,
} from './compare-style.ts'
import {
  PivotSession,
  UnsavedTracker,
  matrixOf,
  pointCentroid,
  type GizmoLike,
} from './stitch-session.ts'
import {
  NUDGE_COARSE_DEG,
  NUDGE_COARSE_M,
  NUDGE_FINE_DEG,
  NUDGE_FINE_M,
  choosePivot,
  describeOffset,
  matricesClose,
  plainServerError,
  resetLabel,
  resetMatrix,
  resetPatchTransform,
  sizeLabel,
  type NudgeAxis,
  type SnapMode,
} from './transform-tools.ts'
import { checkPlacementMatrix, liveScanPlacementPatches } from '../world/scan-placement.ts'
import type { EditPatch, ScanManifest, WorldProject } from '../world/types.ts'

/** What a registration proposal hands back: a placement for the scan, and where it came from in plain words. */
export interface NeighbourProposal {
  matrix: number[]
  /** Shown beside the unsaved move, for example "the overlap with Kitchen". */
  label: string
}

/** The integration point for WP-15a: ask for a placement that matches the scan to a neighbour. */
export interface NeighbourMatchProvider {
  propose(scanId: string): Promise<NeighbourProposal | null>
}

/** What viewer.ts owns and the tools need. Everything is read at the moment it is used. */
export interface StitchHost {
  gizmo: GizmoLike
  scene(): THREE.Scene | null
  world(): WorldProject | null
  loadedScan(scanId: string): { root: THREE.Object3D; points: THREE.Points[]; manifest: ScanManifest; loaded: boolean } | undefined
  loadedScanIds(): string[]
  /** The id of the scan an object belongs to, or null. */
  scanIdOf(object: THREE.Object3D): string | null
  /** Pose an object from a matrix (the viewer's applyMatrix). */
  applyMatrix(object: THREE.Object3D, matrix: number[]): void
  /** Queue a save under the Edit panel's save line, replacing an earlier one with the same key. */
  save(key: string, edit: () => Promise<void>): Promise<boolean>
  /** POST a patch and take the world it answers with (postEditPatch). */
  postPlacement(body: Partial<EditPatch> & { targetId: string; scope: EditPatch['scope'] }): Promise<void>
  /** POST the undo route and take the world it answers with. */
  revert(scanId: string, patchId: string): Promise<void>
  /** The scan root moved: refresh the readout and the HUD. */
  changed(): void
  /**
   * A scan's compare style changed (a tint set or taken off, see-through switched). Styles replace each other on a scan, so
   * whatever else the editor shows with the same see-through style (the "Previous reference" layer) is put back here.
   */
  styled?(): void
  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void
}

export interface StitchTools {
  /** Attach the gizmo to something the person picked. A scan root gets the pivot proxy; anything else the gizmo as it was. */
  attach(target: THREE.Object3D): void
  detach(): void
  /** The scene was replaced (a Place switch). */
  reset(): void
  /**
   * A scan root was built, or rebuilt in place of `previous` (a preview swapped for the full scan). Its saved
   * matrix is the one it was given, unless `previous` had a move that was not saved: then the move is kept.
   */
  adopt(root: THREE.Object3D, previous: THREE.Object3D | null): void
  /**
   * The server now holds `matrix` for `target`: the matrix that was posted, which is not the one on screen when the
   * person moved the scan again while the save was in flight. Without `matrix`, what `target` shows.
   */
  markSaved(target: THREE.Object3D, matrix?: number[]): void
  /** The world changed (a save, an undo, a refresh): redraw what depends on it. */
  refresh(): void
  /** Styles were disturbed (a layer or view mode switch): put the compare styles back. */
  reapplyCompare(): void
  /** True while a scan is attached: its size is locked, so the Scale gizmo is not offered. */
  blocksScale(): boolean
  /** How many objects have a move that is not saved. */
  unsavedCount(): number
  /** WP-15a's hook: register the source of "Match to neighbour" proposals, or null to take the button away. */
  setNeighbourMatch(provider: NeighbourMatchProvider | null): void
}

/** The nudge buttons of each row, in the units its field shows: centimetres, or degrees for the turn. */
const NUDGE_ROWS: ReadonlyArray<{ axis: NudgeAxis; field: string; unit: string; steps: readonly number[]; of: string }> = [
  { axis: 'x', field: 'stitch-x', unit: 'cm', of: 'along X', steps: [-NUDGE_COARSE_M * 100, -NUDGE_FINE_M * 100, NUDGE_FINE_M * 100, NUDGE_COARSE_M * 100] },
  { axis: 'z', field: 'stitch-z', unit: 'cm', of: 'along Z', steps: [-NUDGE_COARSE_M * 100, -NUDGE_FINE_M * 100, NUDGE_FINE_M * 100, NUDGE_COARSE_M * 100] },
  { axis: 'y', field: 'stitch-y', unit: 'cm', of: 'in height', steps: [-NUDGE_COARSE_M * 100, -NUDGE_FINE_M * 100, NUDGE_FINE_M * 100, NUDGE_COARSE_M * 100] },
  { axis: 'yaw', field: 'stitch-yaw', unit: '°', of: 'of turn', steps: [-NUDGE_COARSE_DEG, -NUDGE_FINE_DEG, NUDGE_FINE_DEG, NUDGE_COARSE_DEG] },
]

const PIVOT_NOTES = {
  landmark: 'Turns around the calibrated landmark.',
  centroid: 'Turns around the middle of the scan\'s points.',
  origin: 'Turns around where this scan\'s session started.',
} as const

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

/** Build the tools. Touches the DOM, so it runs once, when the viewer boots. */
export function createStitchTools(host: StitchHost): StitchTools {
  const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null
  const tracker = new UnsavedTracker()
  const styles = new Map<string, CompareStyle>()
  // Every scan that has had a style, cleared or not. The editor keeps the material a scan had before a view mode
  // (wireframe, semantic) replaced it, and a styled copy is what it may keep: when the mode ends it puts that copy
  // back. A style that was cleared in the meantime has to be taken off that copy too, so these scans are visited on
  // every reapply and given the plain style when they have none.
  const everStyled = new Set<string>()
  let neighbour: NeighbourMatchProvider | null = null
  let busy = false
  // What the last action said, and the placement it said it about: a note is true of that placement and no other,
  // so a drag or a nudge that moves the scan again takes it off the line without anything having to clear it.
  let note = ''
  let noteMatrix: number[] | null = null

  const session = new PivotSession(host.gizmo, {
    addToScene: (proxy) => { host.scene()?.add(proxy) },
    apply: (root, matrix) => host.applyMatrix(root, matrix),
    changed: () => afterChange(),
  })

  // ── Where things are ──────────────────────────────────────────────────────

  function manifestOf(root: THREE.Object3D): ScanManifest | null {
    const scanId = host.scanIdOf(root)
    if (!scanId) return null
    return host.world()?.scans.find((scan) => scan.scanId === scanId) ?? host.loadedScan(scanId)?.manifest ?? null
  }

  function inScene(object: THREE.Object3D): boolean {
    const scene = host.scene()
    if (!scene) return false
    let node: THREE.Object3D = object
    while (node.parent) node = node.parent
    return node === scene
  }

  function selectedScanId(): string | null {
    const root = session.target
    return root ? host.scanIdOf(root) : null
  }

  // ── The Place precisely panel ─────────────────────────────────────────────

  function setNote(text: string): void {
    note = text
    noteMatrix = session.target ? matrixOf(session.target) : null
    renderStatus()
  }

  /**
   * The status line: the last action's note while it is still about the placement shown; else, for a move that is not
   * saved, the server's own reason when it would refuse it (the same check, src/world/scan-placement.ts, so the person
   * learns it here and not from a bare "Not saved"); else whether it is saved.
   */
  function renderStatus(): void {
    const line = byId('stitch-status')
    const root = session.target
    if (!line || !root) return
    // A drag asks for this on every pointer event, and a status line that says the same thing again is not redrawn.
    const show = (text: string): void => {
      if (line.textContent !== text) line.textContent = text
    }
    const current = note !== '' && noteMatrix !== null && matricesClose(matrixOf(root), noteMatrix, 1e-12)
    if (current) {
      show(note)
      return
    }
    if (!tracker.isDirty(root)) {
      show('')
      return
    }
    const verdict = checkPlacementMatrix(matrixOf(root))
    show(verdict.ok ? 'Moved. Not saved yet.' : `This will not save: ${verdict.message}`)
  }

  /**
   * The orange tint on Save Transform, for whatever the gizmo is on that has a move not saved: the scan the pivot
   * session drives, or else the object the gizmo was handed back to. It is cleared when there is nothing selected,
   * so the next thing a person picks does not inherit it.
   */
  function renderSaveHint(): void {
    const subject = session.target ?? host.gizmo.object ?? null
    const dirty = subject !== null && subject !== session.proxy && tracker.isDirty(subject)
    byId('edit-save-transform')?.classList.toggle('stitch-unsaved', dirty)
  }

  function setFieldValue(id: string, value: number): void {
    const input = byId<HTMLInputElement>(id)
    // A field being typed in is the person's, not ours, until they leave it.
    if (!input || document.activeElement === input) return
    input.value = String(value)
  }

  function renderPanel(): void {
    const root = session.target
    const precise = byId('stitch-section')
    const compare = byId('stitch-compare')
    if (precise) precise.hidden = !root
    if (compare) compare.hidden = !root
    const scale = byId<HTMLButtonElement>('transform-scale')
    if (scale) {
      scale.disabled = !!root
      scale.title = root ? 'The size of a scan is locked. Use Fix size to change it.' : ''
    }
    renderSaveHint()
    if (!root) return

    const manifest = manifestOf(root)
    const baseline = tracker.baselineOf(root) ?? matrixOf(root)
    const shown = describeOffset(session.offsetFrom(baseline))
    setFieldValue('stitch-x', shown.xCm)
    setFieldValue('stitch-z', shown.zCm)
    setFieldValue('stitch-y', shown.yCm)
    setFieldValue('stitch-yaw', shown.yawDeg)
    setFieldValue('stitch-size-field', Number(sizeLabel(matrixOf(root))))

    const pivotNote = byId('stitch-pivot-note')
    if (pivotNote) pivotNote.textContent = PIVOT_NOTES[session.pivotChoice.kind]

    const dirty = tracker.isDirty(root)
    const stored = manifest ? resetMatrix(manifest.calibratedLocalToWorld) : null
    const live = manifest ? liveScanPlacementPatches(host.world()?.editPatches ?? [], manifest) : []

    const discard = byId<HTMLButtonElement>('stitch-discard')
    if (discard) {
      discard.disabled = !dirty || busy
      discard.title = dirty ? 'Put the scan back where it was when you last saved.' : 'Nothing moved since the last save.'
    }
    const reset = byId<HTMLButtonElement>('stitch-reset')
    if (reset) {
      reset.textContent = manifest ? resetLabel(manifest) : 'Reset to calibrated'
      reset.disabled = !stored || busy || matricesClose(matrixOf(root), stored)
      reset.title = !stored
        ? 'No first placement is stored for this scan.'
        : matricesClose(matrixOf(root), stored)
          ? 'The scan is already at its first placement.'
          : 'Put the scan back where it was first placed, as a new saved move.'
    }
    const undo = byId<HTMLButtonElement>('stitch-undo')
    if (undo) {
      undo.disabled = dirty || busy || live.length === 0
      undo.title = live.length === 0
        ? 'No saved move to undo.'
        : dirty ? 'Save or discard your move first.' : 'Take back the last saved move.'
    }
    renderStatus()
    const match = byId<HTMLButtonElement>('stitch-match')
    if (match) {
      match.hidden = neighbour === null
      match.disabled = busy
    }
    renderCompare()
  }

  function renderCompare(): void {
    const scanId = selectedScanId()
    const style = scanId ? styles.get(scanId) ?? PLAIN_STYLE : PLAIN_STYLE
    for (const swatch of document.querySelectorAll<HTMLButtonElement>('#stitch-swatches [data-tint]')) {
      const tint = swatch.dataset['tint'] === 'none' ? null : Number(swatch.dataset['tint'])
      swatch.setAttribute('aria-pressed', String(tint === style.tint))
    }
    const ghost = byId<HTMLInputElement>('stitch-ghost')
    if (ghost) ghost.checked = style.ghost
  }

  /**
   * The marks on each scan in the list: a dot for a scan with an unsaved move, its tint, and a note on a scan whose
   * upload's placement was set aside. A drag asks for this sixty times a second, so it does nothing unless which
   * scans are unsaved or tinted has changed; `force` is for when the list or the world was replaced.
   *
   * `adopting` is a scan root that is being handed over and may not be in the scene yet: forgetting objects that
   * are not in the scene is what keeps a reloaded scan from holding the page hostage, and it must not forget the
   * root that is about to replace one.
   */
  let markerSignature = ''
  function renderMarkers(force = false, adopting: THREE.Object3D | null = null): void {
    const unsaved = new Set<string>()
    for (const object of tracker.dirty((candidate) => candidate === adopting || inScene(candidate))) {
      const scanId = host.scanIdOf(object)
      if (scanId) unsaved.add(scanId)
    }
    const signature = JSON.stringify([[...unsaved].sort(), [...styles].map(([id, style]) => [id, style.tint]).sort()])
    if (!force && signature === markerSignature) return
    markerSignature = signature
    // Which scans are flagged only changes with the world, and every place that takes a new world calls refresh(), which forces this.
    const flagged = new Map<string, string>()
    for (const scan of host.world()?.scans ?? []) {
      if (scan.projectTransformRejected) flagged.set(scan.scanId, scan.projectTransformRejected)
    }
    for (const item of document.querySelectorAll<HTMLElement>('.scan-item')) {
      const scanId = item.dataset['scanId'] ?? ''
      const isUnsaved = unsaved.has(scanId)
      item.classList.toggle('scan-dirty', isUnsaved)
      if (isUnsaved) item.setAttribute('data-unsaved', 'true')
      else item.removeAttribute('data-unsaved')
      const tint = styles.get(scanId)?.tint ?? null
      item.classList.toggle('scan-tinted', tint !== null)
      if (tint !== null) item.style.setProperty('--scan-tint', hex(tint))
      else item.style.removeProperty('--scan-tint')
      const why = flagged.get(scanId)
      item.classList.toggle('scan-flagged', why !== undefined)
      if (why !== undefined) item.setAttribute('title', why)
      else item.removeAttribute('title')
    }
  }

  function afterChange(): void {
    host.changed()
    renderPanel()
    renderMarkers()
  }

  // ── The actions ───────────────────────────────────────────────────────────

  function commitField(axis: NudgeAxis): void {
    const root = session.target
    const input = byId<HTMLInputElement>(NUDGE_ROWS.find((row) => row.axis === axis)!.field)
    if (!root || !input) return
    const value = Number(input.value)
    if (input.value.trim() === '' || !Number.isFinite(value)) {
      renderPanel()
      return
    }
    const baseline = tracker.baselineOf(root) ?? matrixOf(root)
    const now = session.offsetFrom(baseline)
    setNote('')
    session.moveTo(baseline, {
      dx: axis === 'x' ? value / 100 : now.dx,
      dy: axis === 'y' ? value / 100 : now.dy,
      dz: axis === 'z' ? value / 100 : now.dz,
      yawDeg: axis === 'yaw' ? value : now.yawDeg,
    })
  }

  function nudgeBy(axis: NudgeAxis, shown: number): void {
    setNote('')
    session.nudge(axis, axis === 'yaw' ? shown : shown / 100)
  }

  function discard(): void {
    const root = session.target
    const baseline = root ? tracker.baselineOf(root) : undefined
    if (!root || !baseline) return
    setNote('')
    session.setMatrix(baseline)
  }

  function resetToFirstPlacement(): void {
    const root = session.target
    const manifest = root ? manifestOf(root) : null
    const stored = manifest ? resetMatrix(manifest.calibratedLocalToWorld) : null
    const transform = manifest ? resetPatchTransform(manifest.calibratedLocalToWorld) : null
    if (!root || !manifest || !stored || !transform) return
    setNote('')
    session.setMatrix(stored)
    // Under the same key as Save Transform, so it replaces any save of this scan that has not gone through.
    void host.save(`transform:${root.uuid}`, async () => {
      await host.postPlacement({ scope: 'scan', scanId: manifest.scanId, targetId: manifest.filename, transform })
      // The server holds the stored matrix itself, not the copy the root recomposed from it.
      tracker.markSavedAs(root, stored)
      afterChange()
    })
  }

  async function undoLastSave(): Promise<void> {
    const root = session.target
    const manifest = root ? manifestOf(root) : null
    if (!root || !manifest) return
    const last = liveScanPlacementPatches(host.world()?.editPatches ?? [], manifest).at(-1)
    if (!last) return
    // Where the scan was when the request went out. A move made while it is out is the person's: the answer must not
    // take it away, whether it came from a nudge, a typed number or the gizmo.
    const shownThen = matrixOf(root)
    busy = true
    setNote('')
    renderPanel()
    try {
      await host.revert(manifest.scanId, last.patchId)
      const row = host.world()?.scans.find((scan) => scan.scanId === manifest.scanId)
      let said = 'Undone.'
      if (row && checkPlacementMatrix(row.localToWorld).ok) {
        const movedSince = !matricesClose(matrixOf(root), shownThen)
        if (movedSince) said = 'Undone. Your newer move is not saved yet.'
        // The scan the undo was for, whatever is selected by now.
        else if (session.target === root) session.setMatrix(row.localToWorld)
        else host.applyMatrix(root, row.localToWorld)
        // The server holds the undone placement either way, so a move made meanwhile is measured from it and stays unsaved.
        tracker.markSavedAs(root, row.localToWorld)
      }
      // What is said is about this scan; it is not said under another scan the person has selected since.
      setNote(session.target === root ? said : '')
    } catch (error) {
      setNote(session.target === root ? plainServerError(error, 'Could not undo. Try again.') : '')
    } finally {
      busy = false
      afterChange()
    }
  }

  function applySize(): void {
    const input = byId<HTMLInputElement>('stitch-size-field')
    if (!input) return
    const result = session.resize(Number(input.value))
    setNote(result.ok ? '' : result.message)
    if (!result.ok) renderPanel()
  }

  async function matchToNeighbour(): Promise<void> {
    const root = session.target
    const scanId = selectedScanId()
    if (!neighbour || !root || !scanId) return
    busy = true
    renderPanel()
    try {
      const proposal = await neighbour.propose(scanId)
      if (!proposal) {
        setNote('No match found.')
      } else if (session.target !== root) {
        setNote('')
      } else if (!checkPlacementMatrix(proposal.matrix).ok) {
        setNote('The match was not a placement the server would take.')
      } else {
        session.setMatrix(proposal.matrix)
        setNote(`Placed by ${proposal.label}. Not saved yet.`)
      }
    } catch (error) {
      setNote(plainServerError(error, 'Could not find a match.'))
    } finally {
      busy = false
      afterChange()
    }
  }

  // ── Compare ───────────────────────────────────────────────────────────────

  function setStyle(scanId: string, change: Partial<CompareStyle>): void {
    const style = { ...(styles.get(scanId) ?? PLAIN_STYLE), ...change }
    if (isPlainStyle(style)) styles.delete(scanId)
    else styles.set(scanId, style)
    everStyled.add(scanId)
    const loaded = host.loadedScan(scanId)
    if (loaded?.loaded) applyCompareStyle(loaded.root, style)
    host.styled?.()
    renderPanel()
    renderMarkers()
  }

  function tintEveryScanApart(): void {
    host.loadedScanIds().forEach((scanId, index) => setStyle(scanId, { tint: tintForIndex(index) }))
  }

  function clearTints(): void {
    for (const scanId of [...styles.keys()]) setStyle(scanId, { tint: null })
  }

  // ── DOM wiring ────────────────────────────────────────────────────────────

  for (const row of NUDGE_ROWS) {
    const holder = document.querySelector<HTMLElement>(`.stitch-nudges[data-axis="${row.axis}"]`)
    if (holder) {
      for (const step of row.steps) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'transform-btn'
        button.dataset['nudge'] = row.axis
        button.dataset['step'] = String(step)
        button.textContent = `${step > 0 ? '+' : '−'}${Math.abs(step)}`
        button.setAttribute('aria-label', `${step > 0 ? 'Add' : 'Take off'} ${Math.abs(step)} ${row.unit === 'cm' ? 'centimetres' : 'degrees'} ${row.of}`)
        button.addEventListener('click', () => nudgeBy(row.axis, step))
        holder.appendChild(button)
      }
    }
    // `change` fires when the person leaves the field or presses Enter, so half a number is never applied.
    byId<HTMLInputElement>(row.field)?.addEventListener('change', () => commitField(row.axis))
  }

  // A drag of anything but a scan (the session handles that one) still leaves a move that is not saved.
  host.gizmo.addEventListener('objectChange', () => {
    if (session.target) return
    renderSaveHint()
    renderMarkers()
  })

  byId<HTMLSelectElement>('stitch-snap')?.addEventListener('change', (event) => {
    session.setSnap((event.target as HTMLSelectElement).value as SnapMode)
  })
  byId('stitch-discard')?.addEventListener('click', discard)
  byId('stitch-reset')?.addEventListener('click', resetToFirstPlacement)
  byId('stitch-undo')?.addEventListener('click', () => void undoLastSave())
  byId('stitch-size-apply')?.addEventListener('click', applySize)
  byId('stitch-match')?.addEventListener('click', () => void matchToNeighbour())

  const swatches = byId('stitch-swatches')
  if (swatches) {
    for (const tint of [null, ...TINT_PALETTE]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'stitch-swatch'
      button.dataset['tint'] = tint === null ? 'none' : String(tint)
      if (tint !== null) button.style.background = hex(tint)
      button.textContent = tint === null ? '×' : ''
      button.setAttribute('aria-label', tint === null ? 'No tint' : `Tint this scan ${hex(tint)}`)
      button.title = button.getAttribute('aria-label') ?? ''
      button.addEventListener('click', () => {
        const scanId = selectedScanId()
        if (scanId) setStyle(scanId, { tint })
      })
      swatches.appendChild(button)
    }
  }
  byId<HTMLInputElement>('stitch-ghost')?.addEventListener('change', (event) => {
    const scanId = selectedScanId()
    if (scanId) setStyle(scanId, { ghost: (event.target as HTMLInputElement).checked })
  })
  byId('stitch-tint-all')?.addEventListener('click', tintEveryScanApart)
  byId('stitch-tint-clear')?.addEventListener('click', clearTints)

  // A page left with a move that is not saved loses it without a word. The editor already asks while a save is
  // pending or posting (viewer.ts); this is the move that never reached Save Transform.
  window.addEventListener('beforeunload', (event) => {
    if (tracker.dirty(inScene).length === 0) return
    event.preventDefault()
    event.returnValue = ''
  })

  // For the Playwright spec (tests/mock-editor-stitching.spec.ts): read what the tools did, behind the same
  // double gate as the editor's other test hook (a development build, and ?mock=editor).
  if (import.meta.env?.DEV && new URLSearchParams(location.search).get('mock') === 'editor') {
    ;(window as unknown as { __stitchTest: unknown }).__stitchTest = {
      state() {
        const root = session.target
        if (!root) return null
        const at = session.pivotPosition()
        const scanId = host.scanIdOf(root)
        const style = scanId ? styles.get(scanId) ?? PLAIN_STYLE : PLAIN_STYLE
        // The opacity the first drawn material under the scan has, which is what ghosting changes.
        let opacity: number | null = null
        root.traverse((node) => {
          const material = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
          if (opacity === null && material) opacity = (Array.isArray(material) ? material[0] : material)?.opacity ?? null
        })
        return {
          scanId,
          pivotKind: session.pivotChoice.kind,
          pivotWorld: [at.x, at.y, at.z],
          matrix: matrixOf(root),
          unsaved: tracker.isDirty(root),
          unsavedCount: tracker.dirty(inScene).length,
          gizmoOnProxy: host.gizmo.object === session.proxy,
          tint: style.tint,
          ghost: style.ghost,
          opacity,
        }
      },
    }
  }

  return {
    attach(target) {
      const scanId = target.userData['scope'] === 'scan-root' ? host.scanIdOf(target) : null
      const loaded = scanId ? host.loadedScan(scanId) : undefined
      tracker.trackIfNew(target)
      if (scanId && loaded && loaded.root === target) {
        const manifest = manifestOf(target) ?? loaded.manifest
        session.attachRoot(target, choosePivot(manifest, pointCentroid(target, loaded.points)))
        // A scan's size is locked, so the Scale gizmo is not offered: another mode keeps its place, Scale gives way.
        if (host.gizmo.mode === 'scale') host.setTransformMode('translate')
      } else {
        session.release()
        host.gizmo.attach(target)
      }
      setNote('')
      renderPanel()
      renderMarkers(true)
    },
    detach() {
      session.release()
      host.gizmo.detach()
      renderPanel()
    },
    reset() {
      session.release()
      tracker.clear()
      styles.clear()
      everStyled.clear()
      setNote('')
      renderPanel()
      renderMarkers(true)
    },
    adopt(root, previous) {
      // Carry first: it needs the predecessor's baseline. The viewer calls this before the new root is in the scene, and
      // refreshing the markers forgets what is not in the scene, so the root is named as one that is on its way in.
      if (!tracker.carry(previous, root)) tracker.track(root)
      // The root's own mark, not host.scanIdOf: a scan's first root is not in the viewer's loaded-scan map yet.
      const scanId = typeof root.userData['scanId'] === 'string' ? root.userData['scanId'] as string : null
      const style = scanId ? styles.get(scanId) : undefined
      if (style) applyCompareStyle(root, style)
      renderMarkers(true, root)
    },
    markSaved(target, matrix) {
      if (matrix && matrix.length === 16) tracker.markSavedAs(target, matrix)
      else tracker.markSaved(target)
      renderPanel()
      renderMarkers(true)
    },
    refresh() {
      renderPanel()
      renderMarkers(true)
    },
    reapplyCompare() {
      // Every scan that has ever had a style, not only those that have one now: a view mode can have put back a styled
      // copy of the material of a scan whose style was cleared meanwhile, and the plain style takes it off again.
      for (const scanId of everStyled) {
        const loaded = host.loadedScan(scanId)
        if (loaded?.loaded) applyCompareStyle(loaded.root, styles.get(scanId) ?? PLAIN_STYLE)
      }
    },
    blocksScale: () => session.target !== null,
    unsavedCount: () => tracker.dirty(inScene).length,
    setNeighbourMatch(provider) {
      neighbour = provider
      renderPanel()
    },
  }
}
