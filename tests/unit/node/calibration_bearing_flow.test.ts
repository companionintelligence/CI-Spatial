/**
 * The calibration flow itself (`runProjectCalibration`, src/ar/project-calibration.ts), driven end to end
 * against the physical model in tests/unit/deno/physical_oracle.ts: a session that starts facing some
 * bearing, a camera that turns and tilts, a perfect compass, and two physical floor features the user taps.
 *
 * The pure bearing functions are pinned in tests/unit/deno/world_registration.test.ts. This file is about
 * the wiring around them, which is where the sign error lived: what the flow hands `sessionFrameBearingDeg`,
 * which way it draws the AR north tick, what the one-point tier builds and when it refuses, and what lands on
 * the records it returns.
 *
 *  - The north tick is read off the real `calibration anchor landmark` group the flow adds to the scene, and
 *    must point at true north.
 *  - The two-point records carry `anchorBearingDeg` (true bearing of session +Z), `projectBearingDeg` (true
 *    bearing of the landmark-to-marker baseline) and `bearingConvention: 2`.
 *  - The one-point frame has project +Z at true north, and without a compass reading it does not commit: it
 *    says so, and nothing is dropped in the scene.
 *  - `?bearing=1` runs the old rule as a whole (tick, one-point frame, stored numbers), stamped `1`.
 *  - A Place frame written before any of this (no `bearingConvention`, no `projectBearingDeg`) still loads, and
 *    the visit against it still verifies.
 *
 * There is no DOM here. The flow builds its card with `innerHTML` and finds its parts by id, so the document
 * below is a stand-in that registers every `id="..."` in that markup and records writes and clicks. What it
 * cannot tell is how the card looks or whether a thumb can reach a button: that is for the browser specs.
 * The module is loaded through a resolve hook, because its imports are extensionless (Vite's habit) and Node
 * wants the extension.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/calibration_bearing_flow.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import * as THREE from 'three'
import type { CalibrationResult } from '../../../src/ar/project-calibration.ts'
import {
  BEARING_CONVENTION,
  LEGACY_BEARING_CONVENTION,
  readableAnchorBearingDeg,
  readableProjectBearingDeg,
  twoPointSeparationM,
} from '../../../src/world/geo.ts'
import type { BearingConvention, Project, ProjectSpatialFrame, Quat, Vec3 } from '../../../src/world/types.ts'
import {
  angDiff,
  applyColumnMajor,
  bearingOfSessionVector,
  cameraRotation,
  enuToSession,
  perfectCompassBearing,
  rotateByQuat,
  trueSessionZBearing,
} from '../deno/physical_oracle.ts'
import { compassReadingFromEvent, pairCompassWithPose, rawOrientationOf, type CompassReading } from '../../../src/geo/compass-heading.ts'
import { arPoseFor, eulerAnglesFor, phoneAt } from './compass_oracle.ts'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const relative = /^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && relative) return nextResolve(specifier + '.ts', context)
    throw error
  }
}
`), import.meta.url)

const { runProjectCalibration } = await import('../../../src/ar/project-calibration.ts')

// ── A stand-in for the part of the DOM the flow touches ────────────────────

class FakeElement {
  hidden = false
  disabled = false
  textContent = ''
  value = ''
  src = ''
  clientWidth = 100
  clientHeight = 100
  onload: (() => void) | null = null
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  classList = { toggle: () => false, add: () => {}, remove: () => {} }
  removed = false
  parts = new Map<string, FakeElement>()
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  set innerHTML(html: string) {
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) this.parts.set(match[1]!, new FakeElement())
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== fn))
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  click(): void {
    this.fire('click')
  }
  querySelector(selector: string): FakeElement | null {
    return this.parts.get(selector.replace(/^#/, '')) ?? null
  }
  querySelectorAll(): FakeElement[] {
    return []
  }
  appendChild(): void {}
  remove(): void {
    this.removed = true
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 }
  }
}

/** What each global was before the first stand-in went over it, so every test leaves the process as it found it. */
const ORIGINAL_GLOBALS = new Map<string, PropertyDescriptor | undefined>()

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  if (!ORIGINAL_GLOBALS.has(name)) ORIGINAL_GLOBALS.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    const had = ORIGINAL_GLOBALS.get(name)
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

// ── One flow, wired to the oracle ───────────────────────────────────────────

/** Where the floor is in the session, metres. The taps land on it. */
const FLOOR_Y = -1.2
const LANDMARK_ENU = { east: 1.5, north: -2, up: FLOOR_Y }
const BASELINE_M = 2.4

interface Setup {
  /** Bearing the session started facing. */
  psi: number
  /** Degrees turned LEFT since the session started. */
  turn: number
  /** Degrees the camera is tilted below the horizon. */
  down: number
  /** The camera's pose, when it is not simply `turn` and `down`: a phone with a roll, or a runtime whose frame has turned about the screen. */
  rotation?: Quat
  /** True bearing of the landmark-to-marker baseline. */
  baselineBearing: number
  /** `?bearing=1`, or nothing. */
  search?: string
  /** What the compass says. Defaults to a perfect one. */
  compass?: (perfect: number) => number | null
  project?: Partial<Project>
}

async function startFlow(t: TestContext, setup: Setup) {
  const card = new FakeElement()
  stubGlobal(t, 'document', { createElement: () => card, body: { appendChild: () => {} } })
  stubGlobal(t, 'location', { search: setup.search ?? '' })
  const scene = new THREE.Scene()
  const rotation: Quat = setup.rotation ?? cameraRotation(setup.turn, setup.down)
  const canvas = new FakeElement()
  let hit: Vec3 = { x: 0, y: FLOOR_Y, z: 0 }
  const perfect = () => perfectCompassBearing(setup.psi, rotation)
  const project = {
    projectId: 'p1', name: 'Room', createdAt: 0, updatedAt: 0, floors: [], ...setup.project,
  } as Project

  const result = runProjectCalibration({
    provider: {
      getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation }),
      isTracking: () => true,
      getScene: () => scene,
    } as never,
    project,
    canvas: canvas as never,
    hitTest: async () => ({ position: hit, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 1.5 }),
    bearing: () => (setup.compass ? setup.compass(perfect()) : perfect()),
    ground: () => ({ y: FLOOR_Y, locked: true }),
  })
  let closed = false
  void result.then(() => { closed = true })
  t.after(() => { if (!closed) card.parts.get('project-calibration-skip')?.click() })

  const part = (id: string) => card.parts.get(id)!
  /** Press a button the way a thumb can: it has to be showing and enabled. */
  const press = (id: string) => {
    const button = part(id)
    assert.equal(button.hidden, false, `${id} is hidden`)
    assert.equal(button.disabled, false, `${id} is disabled`)
    button.click()
  }
  const tap = async (session: Vec3, x = 0.5, y = 0.5) => {
    hit = session
    canvas.fire('touchstart', { touches: [{ clientX: x * 100, clientY: y * 100 }] })
    await settle()
  }
  const physical = (enu: { east: number; north: number; up: number }) => enuToSession(setup.psi, enu)
  const baselineRad = (setup.baselineBearing * Math.PI) / 180
  const markerEnu = {
    east: LANDMARK_ENU.east + BASELINE_M * Math.sin(baselineRad),
    north: LANDMARK_ENU.north + BASELINE_M * Math.cos(baselineRad),
    up: FLOOR_Y,
  }
  return {
    result,
    scene,
    part,
    press,
    status: () => part('project-calibration-status').textContent,
    isClosed: () => closed,
    perfect,
    tap,
    landmark: physical(LANDMARK_ENU),
    marker: physical(markerEnu),
    /**
     * Place the landmark, confirm it, place the heading marker: ready to commit two points. A first calibration is then in the
     * check-point step, which a person who wants two points skips with the one check-point button, as this does when it is showing
     * (a Place with a stored pair and no check point is not offered the step, and the button is not there).
     */
    async placeBoth() {
      await tap(this.landmark, 0.3, 0.5)
      press('project-calibration-confirm')
      await tap(this.marker, 0.7, 0.5)
      if (!part('project-calibration-check').hidden) press('project-calibration-check')
    },
    /** Where the north tick on the committed landmark decal points, in session space. */
    northTick(): Vec3 | null {
      const group = scene.getObjectByName('calibration anchor landmark')
      const tick = group?.children.find((child) => child.name === 'anchor north tick') as THREE.LineSegments | undefined
      if (!group || !tick) return null
      group.updateMatrixWorld(true)
      const pos = tick.geometry.getAttribute('position')
      const base = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(group.matrixWorld)
      const tip = new THREE.Vector3(pos.getX(1), pos.getY(1), pos.getZ(1)).applyMatrix4(group.matrixWorld)
      return { x: tip.x - base.x, y: tip.y - base.y, z: tip.z - base.z }
    },
  }
}

/** A handful of sessions: a plain one, a turned-and-tilted one, a right turn, and an about-face. */
const SETUPS: Setup[] = [
  { psi: 0, turn: 0, down: 0, baselineBearing: 40 },
  { psi: 137, turn: 75, down: 60, baselineBearing: 123 },
  { psi: 300, turn: -120, down: 25, baselineBearing: 250 },
  { psi: 45, turn: 180, down: 60, baselineBearing: 5 },
]
const name = (s: Setup) => `start ${s.psi}, turned ${s.turn}, tilted ${s.down}`

function assertRecordBearings(
  record: { anchorBearingDeg: number | null; projectBearingDeg?: number | null; bearingConvention?: BearingConvention },
  setup: Setup,
  label: string,
) {
  assert.equal(record.bearingConvention, BEARING_CONVENTION, `${label}: stamped with the current rule`)
  assert.ok(Math.abs(angDiff(record.anchorBearingDeg!, trueSessionZBearing(setup.psi))) < 1e-6, `${label}: anchorBearingDeg ${record.anchorBearingDeg}`)
  assert.ok(Math.abs(angDiff(record.projectBearingDeg!, setup.baselineBearing)) < 1e-6, `${label}: projectBearingDeg ${record.projectBearingDeg}`)
  assert.ok(Math.abs(angDiff(readableAnchorBearingDeg(record)!, trueSessionZBearing(setup.psi))) < 1e-6, `${label}: readable`)
  assert.ok(Math.abs(angDiff(readableProjectBearingDeg(record)!, setup.baselineBearing)) < 1e-6, `${label}: readable project bearing`)
}

// ── Two points ──────────────────────────────────────────────────────────────

for (const setup of SETUPS) {
  test(`two points (${name(setup)}): the records carry the true bearings and the tick points at north`, async (t) => {
    const flow = await startFlow(t, setup)
    await flow.placeBoth()
    flow.press('project-calibration-commit')
    const result = (await flow.result) as CalibrationResult
    assert.equal(result.calibration.method, 'two-point-ground')
    assert.equal(result.calibration.status, 'provisional', 'a first calibration has nothing to verify against')
    assertRecordBearings(result.calibration as never, setup, 'calibration')
    const frame = result.spatialFrame as Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
    assert.equal(frame.method, 'two-point-ground')
    assertRecordBearings(frame, setup, 'Place frame')

    const tick = flow.northTick()!
    assert.ok(tick, 'the committed landmark carries a north tick')
    assert.ok(Math.abs(angDiff(bearingOfSessionVector(setup.psi, tick), 0)) < 1e-4, `the tick points at ${bearingOfSessionVector(setup.psi, tick)}`)

    // The frame itself is geometry only: the landmark is the origin and the marker is on +Z.
    const m = (result.calibration as { sessionToProject: number[] }).sessionToProject
    const landmark = applyColumnMajor(m, flow.landmark)
    const marker = applyColumnMajor(m, flow.marker)
    assert.ok(Math.hypot(landmark.x, landmark.z) < 1e-9)
    assert.ok(Math.abs(marker.x) < 1e-9 && Math.abs(marker.z - twoPointSeparationM(flow.landmark, flow.marker)) < 1e-9)
  })
}

test('two points with no compass reading: the frame stands, the bearings are null, and no tick is drawn', async (t) => {
  const setup = SETUPS[1]!
  const flow = await startFlow(t, { ...setup, compass: () => null })
  await flow.placeBoth()
  flow.press('project-calibration-commit')
  const result = (await flow.result) as CalibrationResult
  const calibration = result.calibration as { anchorBearingDeg: number | null; projectBearingDeg?: number | null; bearingConvention?: BearingConvention }
  assert.equal(calibration.anchorBearingDeg, null)
  assert.equal(calibration.projectBearingDeg, null)
  assert.equal(calibration.bearingConvention, BEARING_CONVENTION)
  assert.equal(readableAnchorBearingDeg(calibration), null)
  assert.equal((result.spatialFrame as { projectBearingDeg?: number | null }).projectBearingDeg, null)
  assert.equal(flow.northTick(), null, 'no compass, no tick')
  assert.ok(flow.scene.getObjectByName('calibration anchor landmark'), 'the landmark itself is still drawn')
})

// ── One point ───────────────────────────────────────────────────────────────

for (const setup of SETUPS) {
  test(`one point (${name(setup)}): project +Z is true north and the tick points at north`, async (t) => {
    const flow = await startFlow(t, setup)
    await flow.tap(flow.landmark)
    flow.press('project-calibration-fallback')
    const result = (await flow.result) as CalibrationResult
    assert.equal(result.calibration.method, 'ground-tap-compass')
    const calibration = result.calibration as { sessionToProject: number[]; anchorBearingDeg: number | null; bearingConvention?: BearingConvention }
    assert.equal(calibration.bearingConvention, BEARING_CONVENTION)
    assert.ok(Math.abs(angDiff(calibration.anchorBearingDeg!, trueSessionZBearing(setup.psi))) < 1e-6)

    const m = calibration.sessionToProject
    const origin = applyColumnMajor(m, enuToSession(setup.psi, { east: 0, north: 0, up: 0 }))
    const direction = (enu: { east: number; north: number; up: number }) => {
      const p = applyColumnMajor(m, enuToSession(setup.psi, enu))
      return { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }
    }
    const north = direction({ east: 0, north: 1, up: 0 })
    const east = direction({ east: 1, north: 0, up: 0 })
    assert.ok(Math.abs(north.z - 1) < 1e-9 && Math.abs(north.x) < 1e-9, `north maps to (${north.x}, ${north.z}), not project +Z`)
    assert.ok(Math.abs(east.x + 1) < 1e-9, 'east maps to project -X: +X is west on a right-handed frame')
    const tapped = applyColumnMajor(m, flow.landmark)
    assert.ok(Math.hypot(tapped.x, tapped.y, tapped.z) < 1e-9, 'the tapped point is the origin')

    const frame = result.spatialFrame!
    assert.equal(frame.method, 'ground-tap-compass')
    assert.equal((frame as { bearingConvention?: BearingConvention }).bearingConvention, BEARING_CONVENTION)
    assert.ok(Math.abs(angDiff((frame as { anchorBearingDeg: number }).anchorBearingDeg, trueSessionZBearing(setup.psi))) < 1e-6)

    const tick = flow.northTick()!
    assert.ok(Math.abs(angDiff(bearingOfSessionVector(setup.psi, tick), 0)) < 1e-4)
  })
}

test('one point with no compass reading: it does not commit, says why, and drops nothing', async (t) => {
  const flow = await startFlow(t, { ...SETUPS[1]!, compass: () => null })
  await flow.tap(flow.landmark)
  flow.press('project-calibration-fallback')
  await settle()
  assert.equal(flow.isClosed(), false, 'the flow is still open')
  assert.equal(
    flow.status(),
    'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.',
  )
  assert.equal(flow.scene.getObjectByName('calibration anchor landmark'), undefined, 'no anchor was committed to the scene')
  // Two points is still on offer: the compass was never needed for it.
  flow.press('project-calibration-confirm')
  assert.equal(flow.part('project-calibration-title').textContent, 'Place the heading marker')
})

test('one point: a compass that returns after a refusal lets the same flow commit', async (t) => {
  const setup = SETUPS[2]!
  let available = false
  const flow = await startFlow(t, { ...setup, compass: (perfect) => (available ? perfect : null) })
  await flow.tap(flow.landmark)
  flow.press('project-calibration-fallback')
  await settle()
  assert.equal(flow.isClosed(), false)
  available = true
  flow.press('project-calibration-fallback')
  const result = (await flow.result) as CalibrationResult
  const calibration = result.calibration as { anchorBearingDeg: number | null }
  assert.ok(Math.abs(angDiff(calibration.anchorBearingDeg!, trueSessionZBearing(setup.psi))) < 1e-6)
})

// ── One point, with the compass the app really hands it ──────────────────────

/**
 * A phone placed this way, in a session that started facing `psi`: the pose a runtime reports (its camera frame turned
 * from the phone's by `turn` about the screen), and the compass bearing the app hands the flow for the angles the browser
 * would report for it, through the very function main.ts's getter calls (`pairCompassWithPose`).
 */
function placedPhone(psi: number, heading: number, pitchDown: number, roll: number, turn: number) {
  const axes = phoneAt(heading, pitchDown, roll)
  const rotation = arPoseFor(axes, trueSessionZBearing(psi), turn)
  const [alpha, beta, gamma] = eulerAnglesFor(axes)[0]!
  const event = { absolute: true, alpha, beta, gamma } as unknown as DeviceOrientationEvent
  const sample = { raw: rawOrientationOf(event), reading: compassReadingFromEvent(event) as CompassReading | null }
  return { rotation, bearing: () => pairCompassWithPose(sample, rotation)?.bearingDeg ?? null, axis: sample.reading!.axis }
}

for (const [label, pitchDown, roll, turn] of [
  ['portrait, 10 degrees of lean, camera 62 down', 62, 10, 0],
  ['landscape, camera 66 down', 66, 90, 0],
  ['landscape, camera 66 down, the runtime\'s frame turned a quarter', 66, 90, 90],
  ['the other landscape, camera 70 down, the frame turned the other way', 70, 270, 270],
] as const) {
  test(`one point (${label}): the camera is past 60 degrees, so the compass reading is the top edge's, and the frame is still aligned to true north`, { timeout: 20_000 }, async (t) => {
    const psi = 137
    const phone = placedPhone(psi, 301, pitchDown, roll, turn)
    assert.equal(phone.axis, 'top', 'the reading the browser gives is the top edge\'s')
    const flow = await startFlow(t, { psi, turn: 0, down: 0, baselineBearing: 123, rotation: phone.rotation, compass: phone.bearing })
    await flow.tap(flow.landmark)
    flow.press('project-calibration-fallback')
    await settle()
    // A flow that refused would stay open for ever and the test would wait on its result: say so instead.
    assert.equal(flow.isClosed(), true, `the one point did not commit: ${flow.status()}`)
    const result = (await flow.result) as CalibrationResult
    const calibration = result.calibration as { sessionToProject: number[]; anchorBearingDeg: number | null }
    assert.ok(Math.abs(angDiff(calibration.anchorBearingDeg!, trueSessionZBearing(psi))) < 1e-6, `anchorBearingDeg ${calibration.anchorBearingDeg}`)
    // Project +Z is true north: north in the session, through the frame.
    const m = calibration.sessionToProject
    const origin = applyColumnMajor(m, enuToSession(psi, { east: 0, north: 0, up: 0 }))
    const north = applyColumnMajor(m, enuToSession(psi, { east: 0, north: 1, up: 0 }))
    assert.ok(Math.abs(north.z - origin.z - 1) < 1e-9 && Math.abs(north.x - origin.x) < 1e-9, `north maps to (${north.x - origin.x}, ${north.z - origin.z}), not project +Z`)
    assert.ok(Math.abs(angDiff(bearingOfSessionVector(psi, flow.northTick()!), 0)) < 1e-4, 'and the tick points at north')
  })
}

test('one point with the camera looking at the floor: the compass has a reading and no bearing to give, so it does not commit, and says what to do', { timeout: 20_000 }, async (t) => {
  const psi = 137
  const phone = placedPhone(psi, 301, 85, 90, 0)
  const flow = await startFlow(t, { psi, turn: 0, down: 0, baselineBearing: 123, rotation: phone.rotation, compass: phone.bearing })
  await flow.tap(flow.landmark)
  flow.press('project-calibration-fallback')
  await settle()
  assert.equal(flow.isClosed(), false, 'the flow is still open: a bearing that may be a quarter turn out is not stored')
  assert.match(flow.status(), /^No usable compass bearing, so one point cannot set the heading\. Point the camera ahead, not down/)
  assert.equal(flow.scene.getObjectByName('calibration anchor landmark'), undefined, 'nothing was committed to the scene')
})

test('two points with the camera looking at the floor: the frame stands and the bearings are null, as with no compass', { timeout: 20_000 }, async (t) => {
  const psi = 137
  const phone = placedPhone(psi, 301, 85, 90, 0)
  const flow = await startFlow(t, { psi, turn: 0, down: 0, baselineBearing: 123, rotation: phone.rotation, compass: phone.bearing })
  await flow.placeBoth()
  flow.press('project-calibration-commit')
  await settle()
  assert.equal(flow.isClosed(), true, 'the two points committed')
  const result = (await flow.result) as CalibrationResult
  const calibration = result.calibration as { anchorBearingDeg: number | null; projectBearingDeg?: number | null }
  assert.equal(calibration.anchorBearingDeg, null)
  assert.equal(calibration.projectBearingDeg, null)
  assert.equal(result.calibration.method, 'two-point-ground')
})

// ── ?bearing=1: the old rule, as a whole ────────────────────────────────────

/** The camera's yaw in the session, `atan2(x, z)` of its forward `q * (0, 0, -1)`, from the oracle's own rotation. */
function cameraYaw(q: Quat): number {
  const forward = rotateByQuat(q, { x: 0, y: 0, z: -1 })
  return (Math.atan2(forward.x, forward.z) * 180) / Math.PI
}

test('?bearing=1 runs the old rule end to end, stamped 1, so it can be compared with the new one on a phone', async (t) => {
  for (const setup of SETUPS) {
    // Two points: the stored bearings follow the old rule, and say so.
    const two = await startFlow(t, { ...setup, search: '?bearing=1' })
    await two.placeBoth()
    two.press('project-calibration-commit')
    const twoResult = (await two.result) as CalibrationResult
    const record = twoResult.calibration as { anchorBearingDeg: number; bearingConvention?: BearingConvention }
    assert.equal(record.bearingConvention, LEGACY_BEARING_CONVENTION, name(setup))
    const compass = two.perfect()
    const legacyFrame = (((compass - cameraYaw(cameraRotation(setup.turn, setup.down))) % 360) + 360) % 360
    assert.ok(Math.abs(angDiff(record.anchorBearingDeg, legacyFrame)) < 1e-6, `${name(setup)}: the old rule's number`)
    assert.equal(readableAnchorBearingDeg(record), null, 'and it is not readable as a current bearing')
    // The old tick: at twice the compass bearing.
    const tick = two.northTick()!
    assert.ok(Math.abs(angDiff(bearingOfSessionVector(setup.psi, tick), 2 * compass)) < 1e-4, `${name(setup)}: tick`)

    // One point: the old frame, with project +Z at twice the compass bearing.
    const one = await startFlow(t, { ...setup, search: '?bearing=1' })
    await one.tap(one.landmark)
    one.press('project-calibration-fallback')
    const oneResult = (await one.result) as CalibrationResult
    const m = (oneResult.calibration as { sessionToProject: number[] }).sessionToProject
    const intoProjectZ: Vec3 = { x: m[2]!, y: m[6]!, z: m[10]! }
    assert.ok(Math.abs(angDiff(bearingOfSessionVector(setup.psi, intoProjectZ), 2 * compass)) < 1e-6, `${name(setup)}: one point`)
    assert.equal((oneResult.calibration as { bearingConvention?: BearingConvention }).bearingConvention, LEGACY_BEARING_CONVENTION)
  }
})

// ── A Place frame stored before this change still loads ─────────────────────

test('a Place frame written before bearings were stamped still loads, and the visit against it is compared by distance', async (t) => {
  const setup = SETUPS[1]!
  const landmark = enuToSession(setup.psi, LANDMARK_ENU)
  const baselineRad = (setup.baselineBearing * Math.PI) / 180
  const marker = enuToSession(setup.psi, {
    east: LANDMARK_ENU.east + BASELINE_M * Math.sin(baselineRad),
    north: LANDMARK_ENU.north + BASELINE_M * Math.cos(baselineRad),
    up: FLOOR_Y,
  })
  const separationM = twoPointSeparationM(landmark, marker)
  // As the previous build wrote it: a bearing and no stamp, no project bearing.
  const stored = JSON.parse(JSON.stringify({
    version: 1,
    createdAt: '2026-05-01T00:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: 77,
  })) as ProjectSpatialFrame
  const flow = await startFlow(t, { ...setup, project: { spatialFrame: stored } })
  await flow.placeBoth()
  flow.press('project-calibration-commit')
  const result = (await flow.result) as CalibrationResult
  assert.equal(result.calibration.status, 'provisional', 'two points compare a distance and nothing else: never verified')
  assert.equal(result.calibration.method === 'two-point-ground' && result.calibration.checkedBy, 'separation')
  assert.equal(result.spatialFrame, undefined, 'a visit that matched leaves the stored frame alone')
  assertRecordBearings(result.calibration as never, setup, 'this visit')
  assert.equal(readableAnchorBearingDeg(stored as { anchorBearingDeg: number }), null, 'the stored 77 is unreadable, and is not touched')
  assert.equal((stored as { anchorBearingDeg: number }).anchorBearingDeg, 77)

  // And the one-point tier against a stored frame of the old kind.
  const oneFlow = await startFlow(t, { ...setup, project: { spatialFrame: { version: 1, createdAt: 'x', method: 'ground-tap-compass', anchorBearingDeg: null } } })
  await oneFlow.tap(oneFlow.landmark)
  oneFlow.press('project-calibration-fallback')
  const oneResult = (await oneFlow.result) as CalibrationResult
  assert.equal(oneResult.spatialFrame, undefined, 'an existing frame is never replaced by the one-point tier')
  assert.equal(oneResult.calibration.method, 'ground-tap-compass')
})
