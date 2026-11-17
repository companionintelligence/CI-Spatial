/**
 * What a person sees of an earlier run's objects: the AR pins, the side panel and the history drawer (WP-02).
 *
 * A reload starts a new AR run, and an object an earlier run saved has its position in that run's frame. The
 * store keeps it (detection_store.test.ts, wp-ar-run-reload.test.ts) and answers `currentRunDetections()` with
 * this run's objects only. This file runs the three classes that put a stored object in front of a person, against
 * a real store and a small stand-in for the document, and asks what they drew:
 *
 *  - the AR overlay builds a pin for this run's objects only, takes it down when the run changes, and hides rather
 *    than moves a pin whose object left the run between two store notifications;
 *  - the side panel counts, lists and enables export for this run's objects only, says where an earlier run's went,
 *    and its Clear reports the scan it erased and not the record's whole size;
 *  - the history drawer lists an earlier run's object with "previous run, different frame", offers no selection on
 *    it (nothing of it is in the view to select), and reports the scan a load or a delete leaves as this run's.
 *
 * The three classes declare their dependencies as constructor parameter properties, which Node's strip-only loader
 * cannot run, so a load hook transforms those three files (module.stripTypeScriptTypes in "transform" mode) and
 * leaves every other module to the default loader. Node runs each test file in its own process, so the hook and the
 * globals installed below reach no other test.
 *
 * The stand-in document is only what these classes touch. It does not lay anything out, so what is asserted is what
 * was built and what was set on it: which pins exist and whether each is shown, which rows carry which text, which
 * buttons exist, and what a click hands to the host.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-ar-run-views.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PREVIOUS_RUN_LABEL } from '../../../src/ui/previous-run.ts'
import type { StoredDetection } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'

// The classes' imports are written for the bundler (`'./icons'`), and three of them use parameter properties.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
      if (missing && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (/\/src\/ui\/(history|panel|overlay)\.ts$/.test(url)) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

// ── A small stand-in for the document ──────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void

/** Elements that have been given an id, which is all `getElementById` can find. */
const registry = new Map<string, El>()

class El {
  readonly tag: string
  className = ''
  textContent = ''
  title = ''
  value = ''
  disabled = false
  hidden = false
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  children: El[] = []
  parent: El | null = null
  attrs: Record<string, string> = {}
  listeners = new Map<string, Listener[]>()
  private _id = ''
  private _html = ''
  readonly classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.names(), ...names])].join(' ') },
    remove: (...names: string[]) => { this.className = this.names().filter((n) => !names.includes(n)).join(' ') },
    contains: (name: string) => this.names().includes(name),
    toggle: (name: string, on?: boolean) => {
      if (on ?? !this.names().includes(name)) this.classList.add(name)
      else this.classList.remove(name)
    },
  }
  constructor(tag: string) { this.tag = tag }
  private names(): string[] { return this.className.split(' ').filter(Boolean) }
  get id(): string { return this._id }
  set id(value: string) {
    this._id = value
    if (value) registry.set(value, this)
  }
  get innerHTML(): string { return this._html }
  /** The markup is read for its tags and the text after each, which is all these classes' assertions need. */
  set innerHTML(markup: string) {
    this._html = markup
    this.children = []
    for (const [, tag, attributes, text] of markup.matchAll(/<(\w+)([^>]*)>([^<]*)/g)) {
      const child = new El(tag!)
      child.parent = this
      child.className = /class="([^"]*)"/.exec(attributes!)?.[1] ?? ''
      child.textContent = text!.replace(/\s+/g, ' ').trim()
      if (/\sdata-previous-run-note(?=[\s>=])/.test(attributes!)) child.dataset['previousRunNote'] = ''
      this.children.push(child)
    }
  }
  append(...nodes: El[]): void { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  appendChild(node: El): El { this.append(node); return node }
  insertBefore(node: El, reference: El | null): void {
    const at = reference ? this.children.indexOf(reference) : -1
    node.parent = this
    if (at < 0) this.children.push(node)
    else this.children.splice(at, 0, node)
  }
  after(node: El): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node)
    node.parent = this.parent
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  contains(node: El | null): boolean { return !!node && (node === this || this.children.some((child) => child.contains(node))) }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  removeEventListener(): void {}
  setAttribute(name: string, value: string): void { this.attrs[name] = value }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null }
  removeAttribute(name: string): void { delete this.attrs[name] }
  focus(): void {}
  getBoundingClientRect(): { left: number, top: number, width: number, height: number } { return { left: 0, top: 0, width: 400, height: 800 } }
  get scrollHeight(): number { return 0 }
  get clientHeight(): number { return 0 }
  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.names().includes(selector.slice(1))
    if (selector.startsWith('#')) return this._id === selector.slice(1)
    const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1]
    if (attribute) {
      const camel = attribute.replace(/^data-/, '').replace(/-(\w)/g, (_, c: string) => c.toUpperCase())
      return attribute in this.attrs || this.dataset[camel] !== undefined
    }
    return this.tag === selector
  }
  find(predicate: (node: El) => boolean): El[] {
    return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.find(predicate)])
  }
  querySelector<T = El>(selector: string): T | null { return (this.find((node) => node.matches(selector))[0] ?? null) as unknown as T | null }
  querySelectorAll<T = El>(selector: string): T[] { return this.find((node) => node.matches(selector)) as unknown as T[] }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({ stopPropagation() {} }) }
  /** Every piece of text under this element, joined. */
  get allText(): string { return [this.textContent, ...this.children.map((child) => child.allText)].filter(Boolean).join(' | ') }
}

function install(ids: string[]): void {
  registry.clear()
  for (const id of ids) {
    const el = new El('div')
    el.id = id
  }
  const g = globalThis as unknown as Record<string, unknown>
  g['document'] = {
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: (tag: string) => new El(tag),
    addEventListener() {},
    body: new El('body'),
    activeElement: null,
  }
  g['window'] = { innerWidth: 400, innerHeight: 800, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
  g['HTMLElement'] = El
  g['HTMLInputElement'] = class {}
  g['HTMLTextAreaElement'] = class {}
  g['confirm'] = () => true
}

const OVERLAY_IDS = ['ar-overlay', 'status-text', 'progress-bar-wrap', 'progress-bar-fill', 'capture-btn', 'camerafeed']
const HISTORY_IDS = ['history-drawer', 'history-btn', 'history-body', 'history-close']
const PANEL_IDS = ['side-panel', 'panel-content', 'panel-footer', 'panel-toggle']

const THREE = await import('three')
const { DetectionStore } = await import('../../../src/scene/store.ts')
const { AROverlay } = await import('../../../src/ui/overlay.ts')
const { SessionHistory } = await import('../../../src/ui/history.ts')
const { SidePanel } = await import('../../../src/ui/panel.ts')
type Store = InstanceType<typeof DetectionStore>

/** A detection of `label` at (x, 0, z), straight ahead of a camera at the origin looking down -z. */
function found(label: string, x: number, z = -2): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x, y: 0, z },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1_000,
  } as unknown as WorldDetection
}

const keyOf = (label: string, x: number, z = -2) => `${label}:${x.toFixed(1)},0.0,${z.toFixed(1)}`

/** The state after a reload: run A found a sofa, and this page is run B and has found a lamp. */
async function reloadedStore(): Promise<Store> {
  const store = new DetectionStore()
  store.startArRun('run-A')
  await store.upsert(new Map([[keyOf('sofa', 0), found('sofa', 0)]]), new Map())
  store.startArRun('run-B')
  await store.upsert(new Map([[keyOf('lamp', 0.5), found('lamp', 0.5)]]), new Map())
  return store
}

// ── The AR pins ────────────────────────────────────────────────────────────────────────────────────

const provider = {
  isTracking: () => true,
  getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
  getCameraFovY: () => 60,
  getCameraAspect: () => 0.5,
}

function pinsOf(): El[] {
  return registry.get('ar-overlay')!.children.filter((child) => child.className.includes('ar-pin-wrap'))
}

function camera(): InstanceType<typeof THREE.PerspectiveCamera> {
  const cam = new THREE.PerspectiveCamera(60, 0.5, 0.01, 1000)
  cam.position.set(0, 0, 0)
  cam.updateMatrixWorld(true)
  return cam
}

test('pins: one is built for each object this run found, and none for an earlier run\'s', async () => {
  install(OVERLAY_IDS)
  const store = new DetectionStore()
  const overlay = new AROverlay(store, false, provider as never)

  store.startArRun('run-A')
  await store.upsert(new Map([[keyOf('sofa', 0), found('sofa', 0)]]), new Map())
  assert.deepEqual(pinsOf().map((pin) => pin.dataset['key']), [keyOf('sofa', 0)], 'run A\'s own sofa has a pin while run A is the run')

  store.startArRun('run-B')                  // a reload, in effect
  assert.deepEqual(pinsOf(), [], 'the new run\'s frame is not the sofa\'s: its pin is taken down')
  await store.upsert(new Map([[keyOf('lamp', 0.5), found('lamp', 0.5)]]), new Map())
  assert.deepEqual(pinsOf().map((pin) => pin.dataset['key']), [keyOf('lamp', 0.5)])
  assert.equal(store.detections.size, 2, 'and the sofa is still in the record')

  overlay.tick(camera())
  assert.deepEqual(pinsOf().map((pin) => pin.style['display']), ['block'], 'the lamp is placed on the next frame')
})

test('pins: a record that only an earlier run wrote has no pins at all, even once AR is running', async () => {
  install(OVERLAY_IDS)
  const store = new DetectionStore()
  const overlay = new AROverlay(store, false, provider as never)
  await store.upsert(new Map([[keyOf('sofa', 0), found('sofa', 0)]]), new Map())     // a record from before runs were stamped
  store.startArRun('run-B')
  overlay.tick(camera())
  assert.deepEqual(pinsOf(), [])
})

test('pins: one whose object left the run between two store notifications is hidden, not moved to a wrong place', async () => {
  install(OVERLAY_IDS)
  const store = new DetectionStore()
  const overlay = new AROverlay(store, false, provider as never)
  store.startArRun('run-A')
  await store.upsert(new Map([[keyOf('sofa', 0), found('sofa', 0)]]), new Map())
  overlay.tick(camera())
  const [pin] = pinsOf()
  assert.equal(pin?.style['display'], 'block', 'placed while its run is the run')

  // The run changes and the overlay is not told (a notification the page has not delivered yet).
  ;(store as unknown as { notify(): void }).notify = () => {}
  store.startArRun('run-B')
  assert.equal(pinsOf().length, 1, 'the overlay still holds the pin')
  overlay.tick(camera())
  assert.equal(pin?.style['display'], 'none', 'but a frame no longer places it')
})

// ── The side panel ─────────────────────────────────────────────────────────────────────────────────

function mountPanel(store: Store, onScanReset?: (count: number) => void): InstanceType<typeof SidePanel> {
  install(PANEL_IDS)
  const panel = new SidePanel(store, () => 'exported', undefined, undefined, undefined, 'server', undefined, undefined, null, onScanReset)
  panel.mount()
  return panel
}

const badge = () => registry.get('panel-toggle')!.getAttribute('data-count')
const listText = () => registry.get('panel-content')!.allText

test('panel: after a reload it counts and lists nothing, says where the earlier run\'s object is, and offers no export', async () => {
  const store = new DetectionStore()
  store.startArRun('run-A')
  await store.upsert(new Map([[keyOf('sofa', 0), found('sofa', 0)]]), new Map())
  store.startArRun('run-B')
  mountPanel(store)

  assert.equal(badge(), '', 'the badge counts this run\'s objects, and there are none')
  assert.match(listText(), /No objects yet/)
  assert.match(listText(), /1 object from an earlier run is in History, not shown here\./)
  assert.doesNotMatch(listText(), /sofa/, 'the earlier run\'s object is not listed')
  assert.equal(registry.get('panel-export-glb-btn')?.disabled, true, 'there is nothing of this run to export')
  assert.equal(registry.get('panel-export-hint')?.hidden, false, 'and the panel says why')
})

test('panel: an object this run finds is listed and counted, and the earlier run\'s still is not', async () => {
  const store = await reloadedStore()
  mountPanel(store)

  assert.equal(badge(), '1')
  assert.match(listText(), /lamp/)
  assert.doesNotMatch(listText(), /sofa/)
  assert.doesNotMatch(listText(), /earlier run/, 'with something to show, there is no empty-state note')
  assert.equal(registry.get('panel-export-glb-btn')?.disabled, false)

  // The list follows the store: a second object, then the run changing under it.
  await store.upsert(new Map([[keyOf('desk', 1.5), found('desk', 1.5)]]), new Map())
  assert.equal(badge(), '2')
  store.startArRun('run-C')
  assert.equal(badge(), '', 'a new run empties the view at once')
  assert.match(listText(), /3 objects from an earlier run are in History, not shown here\./, 'the sofa, the lamp and the desk: all of them are an earlier run\'s now')
})

test('panel: opening it recounts the badge from the run, so a stale value cannot survive it after a reload', async () => {
  const store = new DetectionStore()
  store.startArRun('run-A')
  await store.upsert(new Map([[keyOf('sofa', 0), found('sofa', 0)]]), new Map())
  store.startArRun('run-B')
  mountPanel(store)
  registry.get('panel-toggle')!.click()
  assert.equal(registry.get('side-panel')!.classList.contains('open'), true, 'the panel opened')
  assert.equal(badge(), '', 'opening it does not count the record\'s earlier run')

  // The badge is set when the panel opens as well as when the list renders: put a stale value in and open it again.
  registry.get('panel-toggle')!.setAttribute('data-count', '9')
  registry.get('panel-toggle')!.click()                       // closes
  registry.get('panel-toggle')!.click()                       // opens again
  assert.equal(registry.get('side-panel')!.classList.contains('open'), true)
  assert.equal(badge(), '', 'recounted from this run\'s objects: none')
})

test('panel: Clear erases the whole record, and reports the scan it erased as this run\'s objects', async () => {
  const store = await reloadedStore()
  assert.equal(store.detections.size, 2)
  const reset: number[] = []
  mountPanel(store, (count) => reset.push(count))
  registry.get('panel-clear-session-btn')!.click()
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(reset, [1], 'the scan that was on screen had one object: the sofa was never in it')
  assert.equal(store.detections.size, 0, 'but Clear erases the record, as it always did')
  assert.equal(badge(), '')
})

// ── The history drawer ─────────────────────────────────────────────────────────────────────────────

interface Drawer {
  _buildDetectionRow(key: string, det: StoredDetection, sessionId: string, isActive: boolean): El
}

function drawerFor(store: Store, onScanReset: (count: number) => void = () => {}): { history: InstanceType<typeof SessionHistory>, rows: Drawer } {
  install(HISTORY_IDS)
  const history = new SessionHistory(store, onScanReset)
  history.mount()
  return { history, rows: history as unknown as Drawer }
}

const stamped = (label: string, x: number, arRunId?: string): StoredDetection =>
  ({ ...found(label, x), detectionId: `d-${label}`, lastSeenAt: 1_000, observations: [], ...(arRunId ? { arRunId } : {}) }) as unknown as StoredDetection

test('drawer: an earlier run\'s row says "previous run, different frame", and this run\'s and legacy rows are told apart', () => {
  const store = new DetectionStore()
  store.startArRun('run-now')
  const { rows } = drawerFor(store)

  const earlier = rows._buildDetectionRow('sofa:0.0,0.0,-2.0', stamped('sofa', 0, 'run-before'), 'sid', false)
  const legacy = rows._buildDetectionRow('lamp:1.0,0.0,-2.0', stamped('lamp', 1), 'sid', false)
  const current = rows._buildDetectionRow('chair:2.0,0.0,-2.0', stamped('chair', 2, 'run-now'), 'sid', false)
  assert.equal(PREVIOUS_RUN_LABEL, 'previous run, different frame')
  assert.match(earlier.allText, /previous run, different frame/)
  assert.match(legacy.allText, /previous run, different frame/, 'a record from before runs were stamped is an earlier run\'s')
  assert.doesNotMatch(current.allText, /previous run/)
  assert.equal(earlier.find((node) => node.dataset['previousRun'] !== undefined).length, 1)
})

test('drawer: on the live session only this run\'s objects can be selected', () => {
  const store = new DetectionStore()
  store.startArRun('run-now')
  const { rows } = drawerFor(store)
  const selectors = (det: StoredDetection) =>
    rows._buildDetectionRow('k', det, 'sid', true).find((node) => node.tag === 'button' && /^(Select|Deselect) /.test(node.attrs['aria-label'] ?? ''))

  assert.equal(selectors(stamped('chair', 2, 'run-now')).length, 1, 'an object in the view can be selected')
  assert.equal(selectors(stamped('sofa', 0, 'run-before')).length, 0, 'one that is in no view cannot')
  assert.equal(selectors(stamped('lamp', 1)).length, 0)
})

test('drawer: after a reload the live session lists the earlier run\'s object labelled and this run\'s selectable', async () => {
  const store = await reloadedStore()
  const { history } = drawerFor(store)
  store.allSessions = async () => [{ sessionId: store.sessionId, startedAt: store.startedAt, count: store.detections.size }]
  await history.open()

  const body = registry.get('history-body')!
  const card = body.children[0]!
  const header = card.children[0]!
  for (const fn of header.listeners.get('click') ?? []) await (fn as (event: unknown) => Promise<void>)({})

  assert.equal(card.find((node) => node.dataset['previousRun'] !== undefined).length, 1, 'one row, the sofa\'s, is labelled')
  const selectable = card.find((node) => node.tag === 'button' && /^(Select|Deselect) /.test(node.attrs['aria-label'] ?? ''))
  assert.deepEqual(selectable.map((node) => node.attrs['aria-label']), ['Select lamp'])
})

/** A drawer over a store holding a sofa from run A and a lamp from this run, with the drawer's two IndexedDB calls stood in. */
async function openDrawer(onScanReset: (count: number) => void): Promise<{ store: Store, body: El }> {
  const store = await reloadedStore()
  assert.equal(store.detections.size, 2, 'the record holds both runs\' objects')
  assert.equal(store.currentRunDetections().size, 1, 'and the scan on screen holds this run\'s one')
  const { history } = drawerFor(store, onScanReset)
  store.allSessions = async () => [
    { sessionId: store.sessionId, startedAt: store.startedAt + 1, count: store.detections.size },
    { sessionId: 'local-other', startedAt: store.startedAt, count: 1 },
  ]
  store.loadSession = async (id: string) => { (store as unknown as { _sessionId: string })._sessionId = id; return true }
  store.deleteSession = async () => true
  await history.open()
  return { store, body: registry.get('history-body')! }
}

/** The one button of a session's card whose accessible name starts with `name`. */
function cardButton(body: El, sessionId: string, name: RegExp): El {
  const [button] = body.children
    .filter((card) => card.dataset['sessionId'] === sessionId)
    .flatMap((card) => card.find((node) => node.tag === 'button' && name.test(node.attrs['aria-label'] ?? '')))
  assert.ok(button, `${sessionId} has a ${String(name)} button`)
  return button
}

const idle = () => new Promise<void>((resolve) => setImmediate(resolve))

test('drawer: loading another session reports the scan it leaves as this run\'s objects, not the record\'s', async () => {
  const reset: number[] = []
  const { store, body } = await openDrawer((count) => reset.push(count))
  cardButton(body, 'local-other', /^Load session/).click()
  await idle()
  assert.equal(store.sessionId, 'local-other', 'the store moved on')
  assert.deepEqual(reset, [1], 'the scan left had one object in it: the sofa of the earlier run was never part of it')
})

test('drawer: deleting the live session reports the scan it erases as this run\'s objects, not the record\'s', async () => {
  const reset: number[] = []
  const { store, body } = await openDrawer((count) => reset.push(count))
  cardButton(body, store.sessionId, /^Delete session/).click()
  await idle()
  assert.deepEqual(reset, [1])
})

test('drawer: deleting a session that is not the live one resets nothing', async () => {
  const reset: number[] = []
  const { body } = await openDrawer((count) => reset.push(count))
  cardButton(body, 'local-other', /^Delete session/).click()
  await idle()
  assert.deepEqual(reset, [])
})
