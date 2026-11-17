/**
 * The Edit tab's "Place precisely" and "Compare" sections (src/viewer/stitch-tools.ts): what the buttons,
 * fields and markers do, with the real pivot session, the real THREE objects and a small stand-in for the
 * browser's DOM.
 *
 * The stand-in implements only what the tools use, and throws on a selector it does not know, so a new
 * lookup cannot slip past unexercised. A separate test checks every id and selector the tools look up
 * against viewer.html, so the markup and the code cannot drift apart. What is left to a real browser is
 * layout, the gizmo's own pointer handling and the look of the page: tests/mock-editor-stitching.spec.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/stitch_tools_dom.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { twoPointToProjectTransform, composeYUpTransform } from '../../../src/world/geo.ts'
import { PLACEMENT_SCALE_MAX, PLACEMENT_SCALE_MIN, buildRevertPatch, checkPlacementMatrix, normaliseZeros, planRevert, stampFirstSightPlacements } from '../../../src/world/scan-placement.ts'
import { createStitchTools, type StitchHost, type StitchTools } from '../../../src/viewer/stitch-tools.ts'
import { matrixOf, type GizmoLike } from '../../../src/viewer/stitch-session.ts'
import { SceneEditor, type ViewMode } from '../../../src/viewer/editor.ts'
import { GHOST_OPACITY_FACTOR, TINT_PALETTE, baseMaterial } from '../../../src/viewer/compare-style.ts'
import { degreesToRadians, matricesClose, NUDGE_COARSE_DEG, NUDGE_COARSE_M, NUDGE_FINE_DEG, NUDGE_FINE_M, pivotWorld, scaleOf, yawMatrix, type Matrix16 } from '../../../src/viewer/transform-tools.ts'
import type { EditPatch, ScanManifest, Vec3, WorldProject } from '../../../src/world/types.ts'

// ─── A small DOM ─────────────────────────────────────────────────────────────

type Listener = (event: { target: StubElement; preventDefault(): void; defaultPrevented: boolean; returnValue?: unknown }) => void

class StubElement {
  readonly tagName: string
  id = ''
  hidden = false
  disabled = false
  title = ''
  textContent = ''
  value = ''
  checked = false
  type = ''
  className = ''
  readonly dataset: Record<string, string> = {}
  readonly style: { background: string; setProperty(name: string, value: string): void; removeProperty(name: string): void; props: Map<string, string> }
  readonly children: StubElement[] = []
  readonly classes = new Set<string>()
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const on = force ?? !this.classes.has(name)
      if (on) this.classes.add(name)
      else this.classes.delete(name)
      return on
    },
    contains: (name: string): boolean => this.classes.has(name),
  }
  private readonly attrs = new Map<string, string>()
  private readonly listeners = new Map<string, Listener[]>()

  constructor(tagName = 'div') {
    this.tagName = tagName
    const props = new Map<string, string>()
    this.style = {
      background: '',
      props,
      setProperty: (name, value) => { props.set(name, value) },
      removeProperty: (name) => { props.delete(name) },
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  appendChild(child: StubElement): StubElement {
    this.children.push(child)
    return child
  }

  fire(type: string, extra: Partial<{ returnValue: unknown }> = {}): { defaultPrevented: boolean } {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return event
  }

  click(): void {
    if (this.disabled) return
    this.fire('click')
  }
}

interface Dom {
  byId: Map<string, StubElement>
  nudges: Map<string, StubElement>
  scanItems: StubElement[]
  beforeUnload: Listener[]
  lookups: Set<string>
}

/** The ids viewer.html's Edit tab has, as the tools find them. */
const IDS = [
  'stitch-section', 'stitch-compare', 'stitch-pivot-note', 'stitch-status', 'stitch-snap', 'stitch-discard', 'stitch-reset',
  'stitch-undo', 'stitch-size-apply', 'stitch-size-field', 'stitch-match', 'stitch-swatches', 'stitch-ghost', 'stitch-tint-all',
  'stitch-tint-clear', 'stitch-x', 'stitch-z', 'stitch-y', 'stitch-yaw', 'transform-scale', 'edit-save-transform',
]

function installDom(): Dom {
  const dom: Dom = { byId: new Map(), nudges: new Map(), scanItems: [], beforeUnload: [], lookups: new Set() }
  for (const id of IDS) {
    const element = new StubElement(id.includes('field') || /^stitch-(x|z|y|yaw)$/.test(id) ? 'input' : id === 'stitch-snap' ? 'select' : 'div')
    element.id = id
    dom.byId.set(id, element)
  }
  for (const axis of ['x', 'z', 'y', 'yaw']) {
    const holder = new StubElement('div')
    holder.dataset['axis'] = axis
    dom.nudges.set(axis, holder)
  }
  dom.byId.get('stitch-section')!.hidden = true
  dom.byId.get('stitch-compare')!.hidden = true
  dom.byId.get('stitch-match')!.hidden = true
  dom.byId.get('stitch-size-field')!.value = '1'
  const document = {
    activeElement: null as StubElement | null,
    getElementById: (id: string) => {
      dom.lookups.add(`#${id}`)
      return dom.byId.get(id) ?? null
    },
    createElement: (tag: string) => new StubElement(tag),
    querySelector: (selector: string) => {
      dom.lookups.add(selector)
      const axis = /^\.stitch-nudges\[data-axis="(\w+)"\]$/.exec(selector)?.[1]
      if (axis) return dom.nudges.get(axis) ?? null
      throw new Error(`the DOM stand-in does not know the selector ${selector}`)
    },
    querySelectorAll: (selector: string) => {
      dom.lookups.add(selector)
      if (selector === '.scan-item') return dom.scanItems
      if (selector === '#stitch-swatches [data-tint]') return dom.byId.get('stitch-swatches')!.children.filter((child) => child.dataset['tint'] !== undefined)
      throw new Error(`the DOM stand-in does not know the selector ${selector}`)
    },
  }
  const window = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'beforeunload') dom.beforeUnload.push(listener)
    },
  }
  Object.assign(globalThis, { document, window, location: { search: '' } })
  return dom
}

// ─── A world and a host ──────────────────────────────────────────────────────

const CALIBRATED = twoPointToProjectTransform({ x: 1.5, y: 0, z: -0.4 }, { x: 3.1, y: 0, z: 1.9 })

function manifest(scanId: string, over: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId,
    projectId: null,
    sessionId: null,
    filename: `${scanId}.glb`,
    name: scanId,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
    localToWorld: normaliseZeros(CALIBRATED),
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'ready',
    calibrationStatus: 'provisional',
    calibrationMethod: 'two-point-ground',
    ...over,
  }
}

function poseRoot(root: THREE.Object3D, matrix: readonly number[]): void {
  new THREE.Matrix4().fromArray([...matrix]).decompose(root.position, root.quaternion, root.scale)
  root.updateMatrixWorld(true)
}

class Gizmo implements GizmoLike {
  object: THREE.Object3D | undefined
  mode: 'translate' | 'rotate' | 'scale' = 'translate'
  rotationSnap: number | null = null
  private readonly listeners = new Map<string, Array<(event: { value?: boolean }) => void>>()
  attach(object: THREE.Object3D): this { this.object = object; return this }
  detach(): this { this.object = undefined; return this }
  setRotationSnap(radians: number | null): this { this.rotationSnap = radians; return this }
  addEventListener(type: 'objectChange' | 'dragging-changed', listener: (event: { value?: boolean }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(type: 'objectChange' | 'dragging-changed', event: { value?: boolean } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

interface Rig {
  dom: Dom
  scene: THREE.Scene
  world: WorldProject
  gizmo: Gizmo
  tools: StitchTools
  roots: Map<string, THREE.Group>
  clouds: Map<string, THREE.Points>
  calls: { save: string[]; post: Array<Parameters<StitchHost['postPlacement']>[0]>; revert: Array<{ scanId: string; patchId: string }>; changed: number; styled: number; modes: string[] }
  fail: { post: boolean; revert: string | null; answer: number[] | null }
  select(scanId: string): void
}

function rig(scanIds: string[] = ['scan-a'], overrides: Record<string, Partial<ScanManifest>> = {}): Rig {
  const dom = installDom()
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  scene.add(group)
  const world = {
    worldId: 'world-test', name: 'w', shareSlug: 'default', projectId: null,
    scans: scanIds.map((id) => manifest(id, overrides[id])), editPatches: [] as EditPatch[],
    things: [], thingObservations: [], members: [], jobs: [], createdAt: '', updatedAt: '',
  } as unknown as WorldProject
  stampFirstSightPlacements(world, () => undefined)
  const roots = new Map<string, THREE.Group>()
  const clouds = new Map<string, THREE.Points>()
  for (const scan of world.scans) {
    const root = new THREE.Group()
    root.userData['scope'] = 'scan-root'
    root.userData['scanId'] = scan.scanId
    const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, vertexColors: true }))
    cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 2, 4, 0, 4], 3))
    root.add(cloud)
    poseRoot(root, scan.localToWorld)
    group.add(root)
    roots.set(scan.scanId, root)
    clouds.set(scan.scanId, cloud)
    const item = new StubElement('div')
    item.dataset['scanId'] = scan.scanId
    dom.scanItems.push(item)
  }
  const gizmo = new Gizmo()
  const calls: Rig['calls'] = { save: [], post: [], revert: [], changed: 0, styled: 0, modes: [] }
  const fail = { post: false, revert: null as string | null, answer: null as number[] | null }
  // As the viewer's scanForObject: a scan is only known once its root is in the loaded-scan map.
  const scanIdOf = (object: THREE.Object3D): string | null => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const id = node.userData['scanId']
      if (typeof id === 'string' && roots.has(id)) return id
    }
    return null
  }
  const host: StitchHost = {
    gizmo,
    scene: () => scene,
    world: () => world,
    loadedScan: (scanId) => {
      const root = roots.get(scanId)
      return root ? { root, points: [clouds.get(scanId)!], manifest: world.scans.find((s) => s.scanId === scanId)!, loaded: true } : undefined
    },
    loadedScanIds: () => [...roots.keys()],
    scanIdOf,
    applyMatrix: (object, matrix) => poseRoot(object, matrix),
    save: async (key, edit) => {
      calls.save.push(key)
      try {
        await edit()
        return true
      } catch {
        return false
      }
    },
    // What the server does with a patch: store it, and make its matrix the scan's placement.
    postPlacement: async (body) => {
      calls.post.push(body)
      if (fail.post) throw new Error('503 down')
      const patch = { patchId: `patch-${world.editPatches.length + 1}`, worldId: world.worldId, createdAt: '', ...body } as EditPatch
      world.editPatches.push(patch)
      const scan = world.scans.find((s) => s.scanId === body.scanId)
      if (scan && body.transform?.matrix) scan.localToWorld = body.transform.matrix
    },
    revert: async (scanId, patchId) => {
      calls.revert.push({ scanId, patchId })
      if (fail.revert) throw Object.assign(new Error(`409 ${JSON.stringify({ error: fail.revert })}`), { status: 409 })
      const plan = planRevert(world, { scanId, patchId })
      if (!plan.ok) throw Object.assign(new Error(`${plan.status} ${JSON.stringify({ error: plan.message })}`), { status: plan.status })
      const patch = buildRevertPatch(world.worldId, plan, { patchId: `patch-${world.editPatches.length + 1}`, actorId: 'test', createdAt: '' })
      world.editPatches.push(patch)
      plan.scan.localToWorld = fail.answer ?? patch.transform!.matrix!
    },
    changed: () => { calls.changed++ },
    styled: () => { calls.styled++ },
    setTransformMode: (mode) => { calls.modes.push(mode); gizmo.mode = mode },
  }
  const tools = createStitchTools(host)
  for (const root of roots.values()) tools.adopt(root, null)
  return { dom, scene, world, gizmo, tools, roots, clouds, calls, fail, select: (scanId) => tools.attach(roots.get(scanId)!) }
}

const el = (r: Rig, id: string): StubElement => r.dom.byId.get(id)!
const nudgeButton = (r: Rig, axis: string, step: number): StubElement => r.dom.nudges.get(axis)!.children.find((b) => b.dataset['step'] === String(step))!
const rootMatrix = (r: Rig, scanId = 'scan-a'): Matrix16 => matrixOf(r.roots.get(scanId)!)
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const pivotOf = (r: Rig, scanId = 'scan-a'): Vec3 => pivotWorld(rootMatrix(r, scanId), twoPointLandmark())
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function twoPointLandmark(): Vec3 {
  // The calibration sends the landmark to the Place's zero, so the landmark is inverse(calibrated) · 0.
  const m = CALIBRATED
  // Rotation block is orthonormal: inverse is its transpose.
  const t = { x: m[12]!, y: m[13]!, z: m[14]! }
  return {
    x: -(m[0]! * t.x + m[1]! * t.y + m[2]! * t.z),
    y: -(m[4]! * t.x + m[5]! * t.y + m[6]! * t.z),
    z: -(m[8]! * t.x + m[9]! * t.y + m[10]! * t.z),
  }
}

// ─── The markup and the code agree ───────────────────────────────────────────

test('every id and selector the tools look up is in viewer.html, and the nudge and swatch holders exist for every row', () => {
  const html = readFileSync(new URL('../../../viewer.html', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../../../src/viewer/stitch-tools.ts', import.meta.url), 'utf8')
  const wanted = new Set<string>()
  for (const match of source.matchAll(/byId(?:<[^>]+>)?\('([\w-]+)'\)/g)) wanted.add(match[1]!)
  for (const match of source.matchAll(/field: '([\w-]+)'/g)) wanted.add(match[1]!)
  assert.ok(wanted.size >= 18, `the tools look up ${wanted.size} ids`)
  for (const id of wanted) assert.match(html, new RegExp(`id="${id}"`), `viewer.html has #${id}`)
  for (const axis of ['x', 'z', 'y', 'yaw']) assert.match(html, new RegExp(`class="stitch-nudges" data-axis="${axis}"`), `a nudge holder for ${axis}`)
  // The ids the DOM stand-in installs are the ones the tools use, so a lookup missing from IDS would be caught below.
  for (const id of IDS) assert.ok(wanted.has(id) || id === 'transform-scale' || id === 'edit-save-transform', `${id} is looked up`)
  // The tools do not look up an id the stand-in lacks.
  const r = rig()
  r.select('scan-a')
  for (const lookup of r.dom.lookups) if (/^#[\w-]+$/.test(lookup)) assert.ok(r.dom.byId.has(lookup.slice(1)), `${lookup} is installed`)
  // And the Scale button the tools lock is the editor's own.
  assert.match(html, /id="transform-scale"/)
  assert.match(html, /id="edit-save-transform"/)
  // The snap menu names the same steps the arithmetic snaps to.
  assert.match(html, new RegExp(`<option value="fine">${NUDGE_FINE_M * 100} cm and ${NUDGE_FINE_DEG}°</option>`))
  assert.match(html, new RegExp(`<option value="coarse">${NUDGE_COARSE_M * 100} cm and ${NUDGE_COARSE_DEG}°</option>`))
})

test('the words on the Edit tab say what the code does: the see-through share, the direction of a turn, the range of a size, what the numbers are', () => {
  const html = readFileSync(new URL('../../../viewer.html', import.meta.url), 'utf8')
  // See through is the share the styling really keeps, as a percentage.
  assert.match(html, new RegExp(`<span>See through \\(${GHOST_OPACITY_FACTOR * 100}%\\)</span>`))
  // A positive turn is the one the arithmetic makes: it carries +Z toward +X.
  assert.match(html, /title="Positive turns the scan from \+Z toward \+X"/)
  const carried = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().fromArray(yawMatrix(30)))
  assert.ok(carried.x > 0.4 && Math.abs(carried.z - Math.cos(Math.PI / 6)) < 1e-12, 'a positive turn does carry +Z toward +X')
  // The size field offers the range the server enforces, and the hint says what the action does to the scan.
  assert.match(html, new RegExp(`id="stitch-size-field"[^>]*min="${PLACEMENT_SCALE_MIN}" max="${PLACEMENT_SCALE_MAX}"`))
  assert.match(html, /Changes how big the whole scan is\. Use it only when a distance you know measures wrong\./)
  // The numbers are measured from what the server holds, which is what the fields do.
  assert.match(html, /Numbers are how far the scan has moved since it was last saved\./)
  // The snap menu and the buttons say what they are.
  for (const words of ['Discard changes', 'Reset to calibrated', 'Undo last save', 'Apply size', 'Tint every scan apart', 'Clear tints', 'Match to neighbour']) {
    assert.ok(html.includes(`>${words}</button>`), words)
  }
})

// ─── The tools ───────────────────────────────────────────────────────────────

test('the nudge buttons are 1 and 5 cm, and 0.5 and 2 degrees, built from the same constants the arithmetic uses', () => {
  const r = rig()
  const labels = (axis: string): string[] => r.dom.nudges.get(axis)!.children.map((b) => b.textContent)
  for (const axis of ['x', 'z', 'y']) assert.deepEqual(labels(axis), ['−5', '−1', '+1', '+5'], axis)
  assert.deepEqual(labels('yaw'), ['−2', '−0.5', '+0.5', '+2'])
  assert.match(nudgeButton(r, 'x', -5).getAttribute('aria-label')!, /Take off 5 centimetres along X/)
  assert.match(nudgeButton(r, 'yaw', 0.5).getAttribute('aria-label')!, /Add 0.5 degrees of turn/)
  assert.equal(r.dom.byId.get('stitch-swatches')!.children.length, TINT_PALETTE.length + 1, 'no tint, and one swatch per colour')
})

test('selecting a scan shows the sections, locks the Scale button, stands the gizmo on the landmark and starts clean', () => {
  const r = rig()
  assert.equal(el(r, 'stitch-section').hidden, true, 'nothing selected yet')
  r.select('scan-a')
  assert.equal(el(r, 'stitch-section').hidden, false)
  assert.equal(el(r, 'stitch-compare').hidden, false)
  assert.equal(el(r, 'transform-scale').disabled, true)
  assert.match(el(r, 'transform-scale').title, /size of a scan is locked/)
  assert.equal(r.tools.blocksScale(), true)
  assert.equal(el(r, 'stitch-pivot-note').textContent, 'Turns around the calibrated landmark.')
  assert.equal(r.gizmo.object?.name, 'stitch pivot proxy')
  assert.ok(distance(r.gizmo.object!.position, { x: 0, y: 0, z: 0 }) < 1e-12, 'on the Place\'s zero, which is the landmark')
  for (const id of ['stitch-x', 'stitch-z', 'stitch-y', 'stitch-yaw']) assert.equal(el(r, id).value, '0', id)
  assert.equal(el(r, 'stitch-status').textContent, '')
  assert.equal(el(r, 'stitch-discard').disabled, true)
  assert.equal(el(r, 'stitch-undo').disabled, true)
  assert.equal(el(r, 'stitch-undo').title, 'No saved move to undo.')
  assert.equal(el(r, 'stitch-reset').disabled, true, 'it is already at its first placement')
  assert.equal(el(r, 'stitch-reset').textContent, 'Reset to calibrated')
  assert.equal(r.tools.unsavedCount(), 0)
})

test('a scan that is not calibrated says it turns about the middle of its points, and its reset says "first placement"', () => {
  const r = rig(['scan-gps'], { 'scan-gps': { calibrationStatus: 'uncalibrated', calibrationMethod: undefined, localToWorld: composeYUpTransform({ x: 5, y: 0, z: 5 }, 0) } })
  const world = r.world.scans[0]!
  world.calibratedLocalToWorld = undefined
  stampFirstSightPlacements(r.world, () => undefined)
  r.select('scan-gps')
  assert.equal(el(r, 'stitch-pivot-note').textContent, 'Turns around the middle of the scan\'s points.')
  assert.equal(el(r, 'stitch-reset').textContent, 'Reset to first placement')
  // The middle of (0,0,0), (2,0,2), (4,0,4) is (2,0,2) in the root's coordinates, so (7,0,7) in the Place.
  assert.ok(distance(r.gizmo.object!.position, { x: 7, y: 0, z: 7 }) < 1e-9, JSON.stringify(r.gizmo.object!.position))
})

test('a nudge moves the scan, fills the field, marks the scan and the Save button, and arms the leave guard', () => {
  const r = rig()
  r.select('scan-a')
  const before = pivotOf(r)
  nudgeButton(r, 'x', 1).click()
  assert.ok(distance(pivotOf(r), { x: before.x + 0.01, y: before.y, z: before.z }) < 1e-12)
  assert.equal(el(r, 'stitch-x').value, '1')
  assert.equal(el(r, 'stitch-status').textContent, 'Moved. Not saved yet.')
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-dirty'), true)
  assert.equal(r.dom.scanItems[0]!.getAttribute('data-unsaved'), 'true')
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), true)
  assert.equal(el(r, 'stitch-discard').disabled, false)
  assert.equal(el(r, 'stitch-undo').disabled, true, 'a move has to be saved or discarded before an undo')
  assert.equal(r.tools.unsavedCount(), 1)
  assert.equal(r.calls.changed > 0, true, 'the readout was told')

  const leaving = r.dom.beforeUnload[0]!
  const event = { target: el(r, 'stitch-x'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, returnValue: 'unset' as unknown }
  leaving(event)
  assert.equal(event.defaultPrevented, true, 'the page asks before it is left')
  assert.equal(event.returnValue, '')

  nudgeButton(r, 'yaw', 2).click()
  assert.ok(distance(pivotOf(r), { x: before.x + 0.01, y: before.y, z: before.z }) < 1e-12, 'a turn leaves the pivot')
  assert.equal(el(r, 'stitch-yaw').value, '2')
})

test('typing a number and leaving the field moves the scan to it, and a bad entry is put back', () => {
  const r = rig()
  r.select('scan-a')
  const before = pivotOf(r)
  el(r, 'stitch-z').value = '-12.5'
  el(r, 'stitch-z').fire('change')
  assert.ok(distance(pivotOf(r), { x: before.x, y: before.y, z: before.z - 0.125 }) < 1e-12)
  assert.equal(el(r, 'stitch-z').value, '-12.5')

  el(r, 'stitch-yaw').value = '3'
  el(r, 'stitch-yaw').fire('change')
  assert.ok(distance(pivotOf(r), { x: before.x, y: before.y, z: before.z - 0.125 }) < 1e-12, 'turning kept the shift')
  assert.equal(el(r, 'stitch-yaw').value, '3')

  const matrix = rootMatrix(r)
  for (const bad of ['', 'abc', ' ']) {
    el(r, 'stitch-x').value = bad
    el(r, 'stitch-x').fire('change')
    assert.deepEqual(rootMatrix(r), matrix, `"${bad}" changed nothing`)
    assert.equal(el(r, 'stitch-x').value, '0', 'and the field shows the real number again')
  }
})

test('Discard puts the scan back where it was when it was last saved, and clears the marker and the guard', () => {
  const r = rig()
  r.select('scan-a')
  const start = rootMatrix(r)
  nudgeButton(r, 'z', 5).click()
  nudgeButton(r, 'yaw', -2).click()
  assert.equal(r.tools.unsavedCount(), 1)
  el(r, 'stitch-discard').click()
  assert.deepEqual(rootMatrix(r), start)
  assert.equal(r.tools.unsavedCount(), 0)
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-dirty'), false)
  assert.equal(r.dom.scanItems[0]!.getAttribute('data-unsaved'), null)
  assert.equal(el(r, 'stitch-z').value, '0')
  const leaving = { target: el(r, 'stitch-x'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  r.dom.beforeUnload[0]!(leaving)
  assert.equal(leaving.defaultPrevented, false, 'nothing to lose, so the page is left alone')
})

test('a move saved while the person moved the scan again leaves it unsaved: the server holds what was posted', () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  const posted = rootMatrix(r)
  nudgeButton(r, 'x', 1).click()
  r.tools.markSaved(r.roots.get('scan-a')!, posted)
  assert.equal(r.tools.unsavedCount(), 1, 'the extra centimetre is not saved')
  assert.equal(el(r, 'stitch-x').value, '1')
  r.tools.markSaved(r.roots.get('scan-a')!)
  assert.equal(r.tools.unsavedCount(), 0)
})

test('saving a move makes it the saved one: clean again, with an undo to take it back', () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  // What Save Transform does: post the root's matrix, and tell the tools.
  const root = r.roots.get('scan-a')!
  r.world.scans[0]!.localToWorld = matrixOf(root)
  r.world.editPatches.push({ patchId: 'p1', worldId: 'w', scope: 'scan', scanId: 'scan-a', targetId: 'scan-a.glb', transform: { matrix: matrixOf(root) }, createdAt: '' })
  r.tools.markSaved(root)
  assert.equal(r.tools.unsavedCount(), 0)
  assert.equal(el(r, 'stitch-x').value, '0', 'the numbers are "since the last save"')
  assert.equal(el(r, 'stitch-undo').disabled, false)
  assert.equal(el(r, 'stitch-undo').title, 'Take back the last saved move.')
  assert.equal(el(r, 'stitch-reset').disabled, false, 'it is 5 cm from its first placement')
  assert.equal(el(r, 'stitch-reset').title, 'Put the scan back where it was first placed, as a new saved move.')
})

test('Undo is off while the scan has a move that is not saved, and comes back when it is discarded', () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  r.world.scans[0]!.localToWorld = rootMatrix(r)
  r.world.editPatches.push({ patchId: 'p1', worldId: 'w', scope: 'scan', scanId: 'scan-a', targetId: 'scan-a.glb', transform: { matrix: rootMatrix(r) }, createdAt: '' })
  r.tools.markSaved(r.roots.get('scan-a')!)
  assert.equal(el(r, 'stitch-undo').disabled, false, 'a saved move can be undone')
  nudgeButton(r, 'z', 1).click()
  assert.equal(el(r, 'stitch-undo').disabled, true, 'but not under an unsaved one')
  assert.equal(el(r, 'stitch-undo').title, 'Save or discard your move first.')
  el(r, 'stitch-discard').click()
  assert.equal(el(r, 'stitch-undo').disabled, false)
})

test('a note is about the placement it was made for: a gizmo drag that moves the scan on takes it off the line', () => {
  const r = rig()
  r.select('scan-a')
  el(r, 'stitch-size-field').value = '3'
  el(r, 'stitch-size-apply').click()
  assert.equal(el(r, 'stitch-status').textContent, 'Size must stay between 0.5 and 2 times.')
  r.gizmo.object!.position.x += 0.02
  r.gizmo.fire('objectChange')
  assert.equal(el(r, 'stitch-status').textContent, 'Moved. Not saved yet.', 'the refusal was about the size, not about this move')
})

test('a move the server would refuse says so before Save is pressed, in the server\'s own words, and Fix size brings it back', () => {
  // A scan saved by an older build at three times its size: the server stores it as it is, and refuses to save a move of it.
  const big = [...CALIBRATED]
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) big[i] = big[i]! * 3
  const r = rig(['scan-big'], { 'scan-big': { localToWorld: big } })
  r.select('scan-big')
  assert.equal(el(r, 'stitch-status').textContent, '', 'nothing moved, so nothing to warn about')
  nudgeButton(r, 'x', 1).click()
  assert.equal(el(r, 'stitch-status').textContent, 'This will not save: The scan\'s size must stay between 0.5 and 2 times, and this is 3.')
  el(r, 'stitch-size-field').value = '1.5'
  el(r, 'stitch-size-apply').click()
  assert.equal(el(r, 'stitch-status').textContent, 'Moved. Not saved yet.', 'a size the server takes')
  assert.equal(checkPlacementMatrix(rootMatrix(r, 'scan-big')).ok, true)
})

test('Reset posts the stored first placement untouched as a scan patch, under the Save Transform key, and is clean after', async () => {
  const r = rig()
  r.select('scan-a')
  const stored = r.world.scans[0]!.calibratedLocalToWorld!
  nudgeButton(r, 'x', 5).click()
  nudgeButton(r, 'yaw', 2).click()
  r.world.scans[0]!.localToWorld = rootMatrix(r)
  r.tools.markSaved(r.roots.get('scan-a')!)
  nudgeButton(r, 'z', 1).click()

  el(r, 'stitch-reset').click()
  await settle()
  const root = r.roots.get('scan-a')!
  assert.deepEqual(r.calls.save, [`transform:${root.uuid}`])
  assert.equal(r.calls.post.length, 1)
  const body = r.calls.post[0]!
  assert.equal(body.scope, 'scan')
  assert.equal(body.scanId, 'scan-a')
  assert.equal(body.targetId, 'scan-a.glb')
  assert.equal(body.revertsPatchId, undefined, 'an ordinary patch, not an undo record')
  assert.equal(body.transform!.matrix!.every((entry, i) => Object.is(entry, stored[i])), true, 'the stored matrix, bit for bit')
  assert.ok(Math.abs(scaleOf(rootMatrix(r)) - 1) < 1e-12)
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rootMatrix(r)[i]! - stored[i]!) < 1e-12)
  assert.equal(r.tools.unsavedCount(), 0, 'the server holds it now')
  assert.equal(el(r, 'stitch-reset').disabled, true)
  assert.equal(el(r, 'stitch-reset').title, 'The scan is already at its first placement.')
})

test('a reset that did not reach the server leaves the scan marked as unsaved', async () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  r.world.scans[0]!.localToWorld = rootMatrix(r)
  r.tools.markSaved(r.roots.get('scan-a')!)
  r.fail.post = true
  el(r, 'stitch-reset').click()
  await settle()
  assert.equal(r.tools.unsavedCount(), 1, 'the scan shows its first placement but the server does not hold it')
})

test('Undo last save asks the server for the move the person saw, puts the scan where it answers, and says so', async () => {
  const r = rig()
  r.select('scan-a')
  const first = matrixOf(r.roots.get('scan-a')!)
  const save = (patchId: string): void => {
    const matrix = rootMatrix(r)
    r.world.scans[0]!.localToWorld = matrix
    r.world.editPatches.push({ patchId, worldId: 'w', scope: 'scan', scanId: 'scan-a', targetId: 'scan-a.glb', transform: { matrix }, createdAt: '' })
    r.tools.markSaved(r.roots.get('scan-a')!)
  }
  nudgeButton(r, 'x', 5).click()
  save('p1')
  const afterFirst = rootMatrix(r)
  nudgeButton(r, 'z', 5).click()
  save('p2')

  el(r, 'stitch-undo').click()
  assert.equal(el(r, 'stitch-undo').disabled, true, 'busy while the request is out')
  await settle()
  assert.deepEqual(r.calls.revert, [{ scanId: 'scan-a', patchId: 'p2' }])
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rootMatrix(r)[i]! - afterFirst[i]!) < 1e-12)
  assert.equal(el(r, 'stitch-status').textContent, 'Undone.')
  assert.equal(r.tools.unsavedCount(), 0, 'the undone placement is the one the server holds')
  assert.equal(el(r, 'stitch-undo').disabled, false, 'there is still p1 to take back')

  el(r, 'stitch-undo').click()
  await settle()
  assert.deepEqual(r.calls.revert.at(-1), { scanId: 'scan-a', patchId: 'p1' }, 'the second undo goes past the first')
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rootMatrix(r)[i]! - first[i]!) < 1e-9)
  assert.equal(el(r, 'stitch-undo').disabled, true, 'nothing left')
  assert.equal(el(r, 'stitch-undo').title, 'No saved move to undo.')
})

test('an undo the server refuses says what the server said, and changes nothing', async () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  r.world.scans[0]!.localToWorld = rootMatrix(r)
  r.world.editPatches.push({ patchId: 'p1', worldId: 'w', scope: 'scan', scanId: 'scan-a', targetId: 'scan-a.glb', transform: { matrix: rootMatrix(r) }, createdAt: '' })
  r.tools.markSaved(r.roots.get('scan-a')!)
  const before = rootMatrix(r)
  r.fail.revert = 'This scan was changed after you opened it. Reload the Place and try again.'
  el(r, 'stitch-undo').click()
  await settle()
  assert.equal(el(r, 'stitch-status').textContent, 'This scan was changed after you opened it. Reload the Place and try again.')
  assert.deepEqual(rootMatrix(r), before)
  assert.equal(el(r, 'stitch-undo').disabled, false, 'not stuck busy')
})

test('Fix size is the one way to change the size, inside 0.5 to 2, about the pivot, and it needs saving like any move', () => {
  const r = rig()
  r.select('scan-a')
  const at = pivotOf(r)
  el(r, 'stitch-size-field').value = '1.25'
  el(r, 'stitch-size-apply').click()
  assert.ok(Math.abs(scaleOf(rootMatrix(r)) - 1.25) < 1e-12)
  assert.ok(distance(pivotOf(r), at) < 1e-9, 'the pivot stayed')
  assert.equal(r.tools.unsavedCount(), 1)
  assert.equal(checkPlacementMatrix(rootMatrix(r)).ok, true, 'a size the server will take')

  el(r, 'stitch-size-field').value = '3'
  el(r, 'stitch-size-apply').click()
  assert.equal(el(r, 'stitch-status').textContent, 'Size must stay between 0.5 and 2 times.')
  assert.ok(Math.abs(scaleOf(rootMatrix(r)) - 1.25) < 1e-12, 'a refused size changes nothing')
  assert.equal(el(r, 'stitch-size-field').value, '1.25', 'and the field shows the real size again')
})

test('the snap menu sets the gizmo\'s turn step, and Off clears it', () => {
  const r = rig()
  r.select('scan-a')
  const menu = el(r, 'stitch-snap')
  menu.value = 'fine'
  menu.fire('change')
  assert.ok(Math.abs(r.gizmo.rotationSnap! - degreesToRadians(NUDGE_FINE_DEG)) < 1e-15)
  menu.value = 'coarse'
  menu.fire('change')
  assert.ok(Math.abs(r.gizmo.rotationSnap! - degreesToRadians(2)) < 1e-15)
  menu.value = 'off'
  menu.fire('change')
  assert.equal(r.gizmo.rotationSnap, null)
})

test('a drag of the gizmo marks the scan unsaved, just as a nudge does', () => {
  const r = rig()
  r.select('scan-a')
  r.gizmo.object!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (3 * Math.PI) / 180)
  r.gizmo.fire('objectChange')
  assert.equal(r.tools.unsavedCount(), 1)
  assert.equal(el(r, 'stitch-yaw').value, '3')
  r.gizmo.fire('dragging-changed', { value: false })
  assert.equal(el(r, 'stitch-yaw').value, '3', 'ending the drag does not lose the number')
})

test('selecting something that is not a whole scan hands the gizmo back as it was, and hides the sections', () => {
  const r = rig()
  r.select('scan-a')
  const lod = new THREE.Group()
  r.roots.get('scan-a')!.add(lod)
  r.tools.attach(lod)
  assert.equal(r.gizmo.object, lod)
  assert.equal(el(r, 'stitch-section').hidden, true)
  assert.equal(el(r, 'transform-scale').disabled, false)
  assert.equal(r.tools.blocksScale(), false)
  lod.position.x += 0.5
  assert.equal(r.tools.unsavedCount(), 1, 'an object dragged and not saved is unsaved too')
  r.tools.markSaved(lod)
  assert.equal(r.tools.unsavedCount(), 0)
  r.tools.detach()
  assert.equal(r.gizmo.object, undefined)
})

test('an open Scale mode gives way when a scan is selected, and another mode keeps its place', () => {
  const r = rig(['scan-a', 'scan-b'])
  r.gizmo.mode = 'scale'
  r.select('scan-a')
  assert.deepEqual(r.calls.modes, ['translate'])
  r.gizmo.mode = 'rotate'
  r.select('scan-b')
  assert.deepEqual(r.calls.modes, ['translate'], 'rotate is left alone')
})

/**
 * A scan root rebuilt the way integrateScanRoot (src/viewer/viewer.ts) rebuilds one: the root it replaces leaves the scene,
 * the new one is posed from the matrix the server holds and handed to the tools while it has no parent yet, and only after
 * that is it added to the scene and made the scan's root. A test that added it first would never see what the tools do with
 * a root that is not in the scene, which is the state the viewer hands it over in.
 */
function rebuildRoot(r: Rig, scanId = 'scan-a', inSceneFirst = false): THREE.Group {
  const old = r.roots.get(scanId)!
  const group = old.parent!
  group.remove(old)
  const rebuilt = new THREE.Group()
  rebuilt.userData['scope'] = 'scan-root'
  rebuilt.userData['scanId'] = scanId
  const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, vertexColors: true }))
  cloud.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 2, 4, 0, 4], 3))
  rebuilt.add(cloud)
  poseRoot(rebuilt, r.world.scans.find((scan) => scan.scanId === scanId)!.localToWorld)
  if (inSceneFirst) group.add(rebuilt)
  r.tools.adopt(rebuilt, old)
  if (!inSceneFirst) group.add(rebuilt)
  r.roots.set(scanId, rebuilt)
  r.clouds.set(scanId, cloud)
  return rebuilt
}

const sameMatrix = (a: readonly number[], b: readonly number[], message: string): void => {
  assert.ok(matricesClose(a, b, 1e-12), message)
}

const leaveGuard = (r: Rig): { defaultPrevented: boolean } => {
  const leaving = { target: el(r, 'stitch-x'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  r.dom.beforeUnload[0]!(leaving)
  return leaving
}

for (const [inSceneFirst, order] of [[false, 'handed over before it is in the scene, as the viewer does today'], [true, 'handed over once it is in the scene']] as const) {
  test(`a scan root rebuilt while it has an unsaved move keeps the move, the marker and the leave guard, ${order}`, () => {
    const r = rig()
    r.select('scan-a')
    const saved = rootMatrix(r)
    nudgeButton(r, 'x', 5).click()
    const moved = rootMatrix(r)
    const rebuilt = rebuildRoot(r, 'scan-a', inSceneFirst)
    r.tools.attach(rebuilt) // the viewer selects the new root again
    sameMatrix(matrixOf(rebuilt), moved, 'the new root shows the move')
    assert.equal(r.tools.unsavedCount(), 1, 'and it is still unsaved: the server holds the old placement')
    assert.equal(r.dom.scanItems[0]!.classes.has('scan-dirty'), true)
    assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), true)
    assert.equal(leaveGuard(r).defaultPrevented, true, 'the page still asks before it is left')
    el(r, 'stitch-discard').click()
    sameMatrix(rootMatrix(r), saved, 'discarding goes to what the server holds, not to the move')
    assert.equal(r.tools.unsavedCount(), 0)
  })
}

test('two rebuilds in a row, the preview and then the full scan, carry the move through both', () => {
  const r = rig()
  r.select('scan-a')
  const saved = rootMatrix(r)
  nudgeButton(r, 'z', 5).click()
  const moved = rootMatrix(r)
  rebuildRoot(r)
  const full = rebuildRoot(r)
  r.tools.attach(full)
  sameMatrix(matrixOf(full), moved, 'the second rebuild did not snap it back to the saved placement')
  assert.equal(r.tools.unsavedCount(), 1)
  el(r, 'stitch-discard').click()
  sameMatrix(rootMatrix(r), saved, 'the baseline is still the saved placement')
})

test('a scan root rebuilt with nothing unsaved takes the matrix the server holds now, and a first root is clean', () => {
  const r = rig()
  r.select('scan-a')
  // Another editor moved the scan and the world refresh brought it: the new root is posed from that.
  r.world.scans[0]!.localToWorld = composeYUpTransform({ x: 3, y: 0, z: 1 }, 20)
  const rebuilt = rebuildRoot(r)
  r.tools.attach(rebuilt)
  sameMatrix(matrixOf(rebuilt), r.world.scans[0]!.localToWorld, 'the server\'s matrix')
  assert.equal(r.tools.unsavedCount(), 0)
  const first = new THREE.Group()
  first.userData['scope'] = 'scan-root'
  first.userData['scanId'] = 'scan-new'
  r.tools.adopt(first, null)
  assert.equal(r.tools.unsavedCount(), 0, 'a root nobody has moved is not unsaved')
})

test('a Place switch forgets every unsaved move and every tint, and the page can be left', () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  el(r, 'stitch-tint-all').click()
  assert.equal(r.tools.unsavedCount(), 1)
  r.tools.reset()
  assert.equal(r.tools.unsavedCount(), 0)
  assert.equal(el(r, 'stitch-section').hidden, true)
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-tinted'), false)
  const leaving = { target: el(r, 'stitch-x'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  r.dom.beforeUnload[0]!(leaving)
  assert.equal(leaving.defaultPrevented, false)
})

// ─── The Save hint, an undo in flight, the status line, flagged scans ────────

test('a field the person is typing in is not rewritten by what the scan does meanwhile, and shows the real number once they leave it', () => {
  const r = rig()
  r.select('scan-a')
  const field = el(r, 'stitch-x')
  field.value = '12'
  const page = (globalThis as unknown as { document: { activeElement: unknown } }).document
  page.activeElement = field
  nudgeButton(r, 'z', 1).click()
  assert.equal(field.value, '12', 'half a number is left alone')
  assert.equal(el(r, 'stitch-z').value, '1', 'while the other fields follow the move')
  page.activeElement = null
  nudgeButton(r, 'z', 1).click()
  assert.equal(field.value, '0', 'and once it is not being typed in it shows where the scan is')
})

test('the orange hint on Save follows what has an unsaved move: gone when nothing is selected, and set for an object that was dragged', () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), true)

  const object = new THREE.Group()
  object.userData['scope'] = 'object'
  r.roots.get('scan-a')!.add(object)
  r.tools.attach(object)
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), false, 'the next thing picked does not inherit it')
  object.position.x += 0.5
  r.gizmo.fire('objectChange')
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), true, 'a dragged object has a move that is not saved')
  r.tools.markSaved(object)
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), false)

  r.select('scan-a')
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), true, 'the scan still has its own')
  r.tools.detach()
  assert.equal(el(r, 'edit-save-transform').classes.has('stitch-unsaved'), false, 'and nothing is selected now')
})

/** What Save Transform leaves behind for the first move of `scan-a`: the move is the server\'s placement and a patch in the log. */
function saveFirstMove(r: Rig, patchId = 'p1'): Matrix16 {
  const matrix = rootMatrix(r)
  r.world.scans[0]!.localToWorld = matrix
  r.world.editPatches.push({ patchId, worldId: 'w', scope: 'scan', scanId: 'scan-a', targetId: 'scan-a.glb', transform: { matrix }, createdAt: '' })
  r.tools.markSaved(r.roots.get('scan-a')!)
  return matrix
}

test('a move made while an undo is out is not taken away by its answer, and stays unsaved from the undone placement', async () => {
  const r = rig()
  r.select('scan-a')
  const first = rootMatrix(r)
  nudgeButton(r, 'x', 5).click()
  saveFirstMove(r)
  el(r, 'stitch-undo').click()
  nudgeButton(r, 'z', 1).click()
  const during = rootMatrix(r)
  await settle()
  sameMatrix(rootMatrix(r), during, 'the nudge made while the request was out is still there')
  assert.equal(r.tools.unsavedCount(), 1, 'and it is not saved')
  assert.equal(el(r, 'stitch-status').textContent, 'Undone. Your newer move is not saved yet.')
  assert.equal(el(r, 'stitch-undo').disabled, true, 'the undo is off under an unsaved move')
  el(r, 'stitch-discard').click()
  sameMatrix(rootMatrix(r), first, 'discarding goes to the undone placement, which is what the server holds now')
  assert.equal(r.tools.unsavedCount(), 0)
})

test('an undo that lands after another scan was selected still puts its own scan back, and the new selection is untouched', async () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  const first = rootMatrix(r)
  nudgeButton(r, 'x', 5).click()
  saveFirstMove(r)
  el(r, 'stitch-undo').click()
  r.select('scan-b')
  const otherBefore = rootMatrix(r, 'scan-b')
  await settle()
  sameMatrix(rootMatrix(r, 'scan-a'), first, 'scan-a is back at the placement the undo gave it')
  sameMatrix(rootMatrix(r, 'scan-b'), otherBefore, 'scan-b did not move')
  assert.equal(r.tools.unsavedCount(), 0, 'what scan-a shows is what the server holds')
  assert.equal(r.gizmo.object?.name, 'stitch pivot proxy')
  assert.equal(el(r, 'stitch-status').textContent, '', 'and "Undone." is not said under scan-b, which was not undone')
})

test('an undo the server refuses after another scan was selected says nothing under the new selection', async () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  saveFirstMove(r)
  r.fail.revert = 'This scan was changed after you opened it. Reload the Place and try again.'
  el(r, 'stitch-undo').click()
  r.select('scan-b')
  await settle()
  assert.equal(el(r, 'stitch-status').textContent, '')
  nudgeButton(r, 'x', 1).click()
  assert.equal(el(r, 'stitch-discard').disabled, false, 'and the panel is not stuck busy: a move on scan-b can be discarded')
})

test('a drag that keeps saying the same thing writes the status line once, not on every pointer event', () => {
  const r = rig()
  r.select('scan-a')
  const line = el(r, 'stitch-status')
  let text = line.textContent
  let writes = 0
  Object.defineProperty(line, 'textContent', { configurable: true, get: () => text, set: (value: string) => { writes++; text = value } })
  for (let event = 0; event < 60; event++) {
    r.gizmo.object!.position.x += 0.001
    r.gizmo.fire('objectChange')
  }
  assert.equal(line.textContent, 'Moved. Not saved yet.')
  assert.equal(writes, 1)
})

test('a scan whose upload\'s placement was set aside is flagged in the list with the server\'s reason, and the mark follows the world', () => {
  const why = 'The scan would be skewed. Its axes must stay at right angles.'
  const r = rig(['scan-a', 'scan-b'], { 'scan-b': { projectTransformRejected: why } })
  r.tools.refresh()
  assert.equal(r.dom.scanItems[1]!.classes.has('scan-flagged'), true)
  assert.equal(r.dom.scanItems[1]!.getAttribute('title'), why)
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-flagged'), false)
  assert.equal(r.dom.scanItems[0]!.getAttribute('title'), null)
  r.world.scans[1]!.projectTransformRejected = undefined
  r.tools.refresh()
  assert.equal(r.dom.scanItems[1]!.classes.has('scan-flagged'), false, 'cleared when the server no longer says it')
  assert.equal(r.dom.scanItems[1]!.getAttribute('title'), null)
})

test('each field moves the scan along its own axis, and shows only its own number', () => {
  const r = rig()
  r.select('scan-a')
  const before = pivotOf(r)
  el(r, 'stitch-x').value = '3'
  el(r, 'stitch-x').fire('change')
  el(r, 'stitch-y').value = '-2'
  el(r, 'stitch-y').fire('change')
  el(r, 'stitch-z').value = '7'
  el(r, 'stitch-z').fire('change')
  assert.ok(distance(pivotOf(r), { x: before.x + 0.03, y: before.y - 0.02, z: before.z + 0.07 }) < 1e-12, 'x, height and z are each their own metres')
  assert.deepEqual(['stitch-x', 'stitch-y', 'stitch-z', 'stitch-yaw'].map((id) => el(r, id).value), ['3', '-2', '7', '0'])
  nudgeButton(r, 'y', 5).click()
  assert.deepEqual(['stitch-x', 'stitch-y', 'stitch-z'].map((id) => el(r, id).value), ['3', '3', '7'], 'a height nudge shows in the height field only')
})

test('a typed number is a distance from what the server holds, not from where the scan is now', () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  const placed = rootMatrix(r)
  el(r, 'stitch-x').value = '5'
  el(r, 'stitch-x').fire('change')
  sameMatrix(rootMatrix(r), placed, 'typing the 5 cm the scan is already at moves nothing')
  el(r, 'stitch-x').value = '8'
  el(r, 'stitch-x').fire('change')
  assert.ok(Math.abs(pivotOf(r).x - (pivotWorld(placed, twoPointLandmark()).x + 0.03)) < 1e-12, '8 cm is 3 cm further')
})

test('a note is taken off the line by a move of half a millimetre', () => {
  const r = rig()
  r.select('scan-a')
  el(r, 'stitch-size-field').value = '3'
  el(r, 'stitch-size-apply').click()
  assert.equal(el(r, 'stitch-status').textContent, 'Size must stay between 0.5 and 2 times.')
  r.gizmo.object!.position.x += 0.0005
  r.gizmo.fire('objectChange')
  assert.equal(el(r, 'stitch-status').textContent, 'Moved. Not saved yet.')
})

test('letting go of the scan hides the sections and gives the Scale button back', () => {
  const r = rig()
  r.select('scan-a')
  assert.equal(r.tools.blocksScale(), true)
  r.tools.detach()
  assert.equal(el(r, 'stitch-section').hidden, true)
  assert.equal(el(r, 'stitch-compare').hidden, true)
  assert.equal(el(r, 'transform-scale').disabled, false)
  assert.equal(r.tools.blocksScale(), false, 'nothing is selected, so nothing is locked')
  assert.equal(r.gizmo.object, undefined)
})

test('a scan with no landmark and no points turns about where its session started, and says so', () => {
  const r = rig(['scan-x'], { 'scan-x': { calibrationStatus: 'uncalibrated', calibrationMethod: undefined } })
  r.clouds.get('scan-x')!.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
  r.select('scan-x')
  assert.equal(el(r, 'stitch-pivot-note').textContent, 'Turns around where this scan\'s session started.')
  assert.equal(r.tools.blocksScale(), true)
})

test('a move that leaves the scene is forgotten: the list and the leave guard do not hold the page for it', () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  assert.equal(r.tools.unsavedCount(), 1)
  r.roots.get('scan-a')!.removeFromParent()
  assert.equal(r.tools.unsavedCount(), 0)
  assert.equal(leaveGuard(r).defaultPrevented, false)
})

test('while an undo is out, nothing that would change the placement is offered but a nudge, and Undo is off', async () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  saveFirstMove(r)
  nudgeButton(r, 'z', 1).click()
  r.tools.setNeighbourMatch({ propose: async () => null })
  assert.equal(el(r, 'stitch-reset').disabled, false, 'the scan is 5 cm from its first placement, so Reset is on')
  assert.equal(el(r, 'stitch-discard').disabled, false, 'and there is a move to discard')
  assert.equal(el(r, 'stitch-match').disabled, false)
  el(r, 'stitch-discard').click()
  nudgeButton(r, 'z', 1).click()
  el(r, 'stitch-discard').click()
  // An undo is in flight: the actions that would replace the placement wait for its answer.
  el(r, 'stitch-undo').click()
  assert.equal(el(r, 'stitch-undo').disabled, true)
  assert.equal(el(r, 'stitch-reset').disabled, true, 'Reset waits for the undo')
  assert.equal(el(r, 'stitch-match').disabled, true, 'so does Match to neighbour')
  nudgeButton(r, 'x', 1).click()
  assert.equal(el(r, 'stitch-discard').disabled, true, 'and so does Discard, even with a nudge made meanwhile')
  await settle()
  assert.equal(el(r, 'stitch-match').disabled, false)
  assert.equal(el(r, 'stitch-discard').disabled, false, 'the nudge made meanwhile is unsaved, and can be discarded now')
})

test('an undo whose answer is not a placement the server would take leaves the scan where it was', async () => {
  const r = rig()
  r.select('scan-a')
  nudgeButton(r, 'x', 5).click()
  saveFirstMove(r)
  const shown = rootMatrix(r)
  r.fail.answer = [...CALIBRATED].map((entry, i) => (i === 12 ? Number.NaN : entry))
  el(r, 'stitch-undo').click()
  await settle()
  assert.deepEqual(rootMatrix(r), shown, 'a NaN placement is never drawn')
  assert.equal(r.tools.unsavedCount(), 0, 'and the saved placement is still the one the scan shows')
  assert.equal(el(r, 'stitch-reset').disabled, false, 'not stuck busy: Reset is on again')
})

test('a placement proposed for one scan does not land on the scan selected by the time it arrives', async () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  let arrive!: (proposal: { matrix: number[]; label: string }) => void
  r.tools.setNeighbourMatch({ propose: () => new Promise((resolve) => { arrive = resolve }) })
  el(r, 'stitch-match').click()
  r.select('scan-b')
  const b = rootMatrix(r, 'scan-b')
  const a = rootMatrix(r, 'scan-a')
  arrive({ matrix: composeYUpTransform({ x: 9, y: 0, z: 9 }, 40), label: 'the overlap with Kitchen' })
  await settle()
  sameMatrix(rootMatrix(r, 'scan-b'), b, 'the selected scan did not move')
  sameMatrix(rootMatrix(r, 'scan-a'), a, 'and neither did the one it was for: the answer is dropped')
  assert.equal(r.tools.unsavedCount(), 0)
  assert.equal(el(r, 'stitch-status').textContent, '')
})

// ─── Compare ─────────────────────────────────────────────────────────────────

const swatches = (r: Rig): StubElement[] => el(r, 'stitch-swatches').children
const cloudMaterial = (r: Rig, scanId: string): THREE.PointsMaterial => r.clouds.get(scanId)!.material as THREE.PointsMaterial

test('a tint is on the selected scan only, shows in the list, and the swatch says which is on', () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  swatches(r)[1]!.click()
  assert.equal(cloudMaterial(r, 'scan-a').color.getHex(), TINT_PALETTE[0])
  assert.equal(cloudMaterial(r, 'scan-b').color.getHex(), 0xffffff, 'the other scan is untouched')
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-tinted'), true)
  assert.equal(r.dom.scanItems[0]!.style.props.get('--scan-tint'), `#${TINT_PALETTE[0]!.toString(16)}`)
  assert.equal(r.dom.scanItems[1]!.classes.has('scan-tinted'), false)
  assert.equal(swatches(r)[1]!.getAttribute('aria-pressed'), 'true')
  assert.equal(swatches(r)[0]!.getAttribute('aria-pressed'), 'false')

  r.select('scan-b')
  assert.equal(swatches(r)[1]!.getAttribute('aria-pressed'), 'false', 'the swatch follows the selected scan')
  assert.equal(swatches(r)[0]!.getAttribute('aria-pressed'), 'true', 'which has no tint')

  r.select('scan-a')
  swatches(r)[0]!.click()
  assert.equal(cloudMaterial(r, 'scan-a').color.getHex(), 0xffffff)
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-tinted'), false)
})

test('See through is half opacity on the selected scan, and clearing it puts the scan\'s own material back', () => {
  const r = rig(['scan-a'])
  const original = cloudMaterial(r, 'scan-a')
  r.select('scan-a')
  el(r, 'stitch-ghost').checked = true
  el(r, 'stitch-ghost').fire('change')
  const ghosted = cloudMaterial(r, 'scan-a')
  assert.equal(ghosted.opacity, 0.5)
  assert.equal(ghosted.transparent, true)
  assert.equal(baseMaterial(ghosted), original)
  assert.equal(original.opacity, 1, 'the original is untouched')
  el(r, 'stitch-ghost').checked = false
  el(r, 'stitch-ghost').fire('change')
  assert.equal(cloudMaterial(r, 'scan-a'), original)
})

test('the See through box and the swatches show the selected scan\'s own style', () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  el(r, 'stitch-ghost').checked = true
  el(r, 'stitch-ghost').fire('change')
  r.select('scan-b')
  assert.equal(el(r, 'stitch-ghost').checked, false, 'scan-b is not see-through')
  r.select('scan-a')
  assert.equal(el(r, 'stitch-ghost').checked, true, 'scan-a is')
})

test('Tint every scan apart gives each scan its own colour, and Clear tints takes them all off', () => {
  const r = rig(['scan-a', 'scan-b', 'scan-c'])
  r.select('scan-a')
  el(r, 'stitch-tint-all').click()
  const hexes = ['scan-a', 'scan-b', 'scan-c'].map((id) => cloudMaterial(r, id).color.getHex())
  assert.deepEqual(hexes, [TINT_PALETTE[0], TINT_PALETTE[1], TINT_PALETTE[2]])
  assert.equal(r.dom.scanItems.every((item) => item.classes.has('scan-tinted')), true)
  el(r, 'stitch-tint-clear').click()
  assert.deepEqual(['scan-a', 'scan-b', 'scan-c'].map((id) => cloudMaterial(r, id).color.getHex()), [0xffffff, 0xffffff, 0xffffff])
  assert.equal(r.dom.scanItems.some((item) => item.classes.has('scan-tinted')), false)
})

test('every change of a scan\'s compare style tells the host, so whatever else shows the see-through style can be put back (WP-08)', () => {
  const r = rig(['scan-a', 'scan-b'])
  r.select('scan-a')
  assert.equal(r.calls.styled, 0, 'selecting a scan changes no style')
  swatches(r)[1]!.click()
  assert.equal(r.calls.styled, 1, 'a tint')
  el(r, 'stitch-ghost').checked = true
  el(r, 'stitch-ghost').fire('change')
  assert.equal(r.calls.styled, 2, 'see-through')
  el(r, 'stitch-tint-clear').click()
  assert.equal(r.calls.styled, 3, 'taking the tint off, which leaves the scan see-through and no longer the colour the layer had it in')
})

test('a tint survives the editor swapping materials (reapply), and a rebuilt scan root comes up tinted', () => {
  const r = rig(['scan-a'])
  r.select('scan-a')
  swatches(r)[2]!.click()
  // A view mode replaces the material; the tools put the style back on whatever is there now.
  r.clouds.get('scan-a')!.material = new THREE.PointsMaterial({ color: 0xffffff })
  r.tools.reapplyCompare()
  assert.equal(cloudMaterial(r, 'scan-a').color.getHex(), TINT_PALETTE[1])

  const rebuilt = new THREE.Group()
  rebuilt.userData['scope'] = 'scan-root'
  rebuilt.userData['scanId'] = 'scan-a'
  const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff }))
  rebuilt.add(cloud)
  r.tools.adopt(rebuilt, null)
  assert.equal((cloud.material as THREE.PointsMaterial).color.getHex(), TINT_PALETTE[1])
})

/**
 * The editor's own view modes, with the follow-up the viewer makes after each one: `editor.setMode(...)` and then
 * `applyLayerVisibility()`, which calls `stitch.reapplyCompare()`. The scan gets a mesh, because the editor swaps the
 * materials of meshes and leaves point clouds alone.
 */
function withEditorModes(r: Rig, scanId = 'scan-a'): { mesh: THREE.Mesh; mode(next: ViewMode): void; material(): THREE.MeshStandardMaterial } {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff }))
  r.roots.get(scanId)!.add(mesh)
  const editor = new SceneEditor()
  editor.setScene(r.scene)
  editor.setMode('solid')
  return {
    mesh,
    mode(next) {
      editor.setMode(next)
      r.tools.reapplyCompare()
    },
    material: () => mesh.material as THREE.MeshStandardMaterial,
  }
}

test('a tint cleared while a view mode is on does not come back when the mode ends', () => {
  const r = rig()
  const view = withEditorModes(r)
  r.select('scan-a')
  swatches(r)[2]!.click()
  assert.equal(view.material().color.getHex(), TINT_PALETTE[1], 'tinted in solid')
  view.mode('wireframe')
  assert.equal(view.material().wireframe, true)
  assert.notEqual(view.material().color.getHex(), 0x4fc3f7, 'the wireframe carries the tint too')
  el(r, 'stitch-tint-clear').click()
  view.mode('solid')
  assert.equal(view.material().color.getHex(), 0xffffff, 'the scan\'s own colour, not the tinted copy the editor had kept')
  assert.equal(view.material().wireframe, false)
  // A second round of modes does not bring it back either.
  view.mode('wireframe')
  view.mode('solid')
  assert.equal(view.material().color.getHex(), 0xffffff)
  assert.equal(r.dom.scanItems[0]!.classes.has('scan-tinted'), false)
})

test('see through cleared while a view mode is on does not come back when the mode ends', () => {
  const r = rig()
  const view = withEditorModes(r)
  r.select('scan-a')
  el(r, 'stitch-ghost').checked = true
  el(r, 'stitch-ghost').fire('change')
  assert.equal(view.material().opacity, 0.5)
  view.mode('semantic')
  el(r, 'stitch-ghost').checked = false
  el(r, 'stitch-ghost').fire('change')
  view.mode('solid')
  assert.equal(view.material().opacity, 1)
  assert.equal(view.material().transparent, false)
  assert.equal(view.material().depthWrite, true)
})

test('a tint set in solid follows the scan through every view mode and back, and a scan never styled is left alone', () => {
  const r = rig(['scan-a', 'scan-b'])
  const view = withEditorModes(r)
  const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff }))
  r.roots.get('scan-b')!.add(other)
  r.select('scan-a')
  swatches(r)[1]!.click()
  const untouched = other.material
  for (const mode of ['wireframe', 'semantic', 'points', 'solid'] as const) view.mode(mode)
  assert.equal(view.material().color.getHex(), TINT_PALETTE[0], 'tinted again in solid')
  assert.equal(other.material, untouched, 'the other scan\'s material was never copied')
})

// ─── Match to neighbour ──────────────────────────────────────────────────────

test('Match to neighbour appears only when a proposal source is registered, and only ever puts an unsaved move on the scan', async () => {
  const r = rig()
  r.select('scan-a')
  assert.equal(el(r, 'stitch-match').hidden, true, 'nothing registered')

  const proposed = composeYUpTransform({ x: 1, y: 0, z: 2 }, 14)
  let asked: string | null = null
  r.tools.setNeighbourMatch({ propose: async (scanId) => { asked = scanId; return { matrix: proposed, label: 'the overlap with Kitchen' } } })
  assert.equal(el(r, 'stitch-match').hidden, false)
  el(r, 'stitch-match').click()
  await settle()
  assert.equal(asked, 'scan-a')
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(rootMatrix(r)[i]! - proposed[i]!) < 1e-12)
  assert.equal(r.tools.unsavedCount(), 1, 'it is a draft')
  assert.equal(r.calls.post.length, 0, 'and nothing was sent to the server')
  assert.equal(el(r, 'stitch-status').textContent, 'Placed by the overlap with Kitchen. Not saved yet.', 'it says where the placement came from')
  nudgeButton(r, 'x', 1).click()
  assert.equal(el(r, 'stitch-status').textContent, 'Moved. Not saved yet.', 'a further move takes the note off: it was about the placement before')

  el(r, 'stitch-discard').click()
  r.tools.setNeighbourMatch({ propose: async () => null })
  el(r, 'stitch-match').click()
  await settle()
  assert.equal(el(r, 'stitch-status').textContent, 'No match found.')

  const skewed = [...proposed]
  skewed[4] += 0.2
  r.tools.setNeighbourMatch({ propose: async () => ({ matrix: skewed, label: 'x' }) })
  const before = rootMatrix(r)
  el(r, 'stitch-match').click()
  await settle()
  assert.equal(el(r, 'stitch-status').textContent, 'The match was not a placement the server would take.')
  assert.deepEqual(rootMatrix(r), before)

  r.tools.setNeighbourMatch({ propose: async () => { throw new Error('503 down') } })
  el(r, 'stitch-match').click()
  await settle()
  assert.equal(el(r, 'stitch-status').textContent, 'Could not find a match.')

  r.tools.setNeighbourMatch(null)
  assert.equal(el(r, 'stitch-match').hidden, true)
})
