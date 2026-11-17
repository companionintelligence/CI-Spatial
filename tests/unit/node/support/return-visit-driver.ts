/**
 * Drives the calibration modal on a visit to a Place, against a camera that is a perfect pinhole (WP-07).
 *
 * `runProjectCalibration` is the part of the app that takes a reference photo of each marker and, on a return visit,
 * tells the person how to find the same two again. Whether the crosshair of a photo is on its marker is only a question
 * if the camera is a camera, so this stand-in has one: a pose the test moves, a lens, and a hit test that answers the
 * floor point the camera's ray through the touched pixel meets (`floorRayPoint`, src/ar/ground-gate.ts). A tap then
 * lands where it looks like it lands, the phone can be turned or carried between a tap and a photo, and the photo the
 * host hands back is taken from wherever the camera is when it is asked for.
 *
 * Imperative where ./calibration-flow-driver.ts is a list of scenarios: a test says what the person does and looks at
 * what the card shows. The stand-in for the document is that file's (`FakeElement`), and so is the loader that finds the
 * modal's extensionless imports.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import { mock } from 'node:test'
import * as THREE from 'three'
import { SKIP_CHECK_LABEL } from '../../../../src/ar/constellation-copy.ts'
import { floorRayPoint } from '../../../../src/ar/ground-gate.ts'
import type { HitResult } from '../../../../src/ar/provider.ts'
import type { CalibrationResult } from '../../../../src/ar/project-calibration.ts'
import type { CalibrationReferencePhoto, Vec3 } from '../../../../src/world/types.ts'
import { FakeElement, loadModal } from './calibration-flow-driver.ts'

export type CameraPose = { position: Vec3; rotation: { x: number; y: number; z: number; w: number } }

/** The canvas, in CSS pixels: a phone held upright. */
export const VIEW = { width: 360, height: 640 }
export const FOV_Y_DEG = 60
export const ASPECT = VIEW.width / VIEW.height
/** The floor, in session metres. */
export const FLOOR_Y = 0
const NOW = Date.UTC(2026, 10, 16, 9, 30, 0)
const DEG = Math.PI / 180

/** The phone's start: 1.5 m up, looking at the floor ahead. */
export const START_POSE: CameraPose = poseFrom({ x: 0, y: 1.5, z: 0 }, -35, 0)

/** Pitch (negative looks down) and yaw (positive turns left), degrees, at a position. */
export function poseFrom(position: Vec3, pitchDeg: number, yawDeg: number): CameraPose {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchDeg * DEG, yawDeg * DEG, 0, 'YXZ'))
  return { position: { ...position }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

/** Where a marker falls in the view from a pose, by three.js (`Vector3.project`), as a tap would read it; null when behind or outside. */
export function seenFrom(marker: Vec3, pose: CameraPose): { x: number; y: number } | null {
  const camera = new THREE.PerspectiveCamera(FOV_Y_DEG, ASPECT, 0.01, 1000)
  camera.position.set(pose.position.x, pose.position.y, pose.position.z)
  camera.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)
  camera.updateMatrixWorld(true)
  const world = new THREE.Vector3(marker.x, marker.y, marker.z)
  if (!(world.clone().applyMatrix4(camera.matrixWorldInverse).z < 0)) return null
  const ndc = world.project(camera)
  const x = (ndc.x + 1) / 2
  const y = (1 - ndc.y) / 2
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}

export const BUTTONS = {
  confirm: 'project-calibration-confirm',
  commit: 'project-calibration-commit',
  /** The one check-point button (WP-04b): it skips the step while it is open, adds the point back from review, or takes a placed one away. */
  check: 'project-calibration-check',
  replace: 'project-calibration-replace',
  override: 'project-calibration-override',
  wrongPlace: 'project-calibration-wrong-place',
  fallback: 'project-calibration-fallback',
  skip: 'project-calibration-skip',
} as const

export type ButtonName = keyof typeof BUTTONS

/** A stored two-point frame, as a Place written by an earlier visit holds it. */
export function storedPair(
  options: { separationM?: number; toleranceM?: number | null; photos?: boolean | 'no-url'; labels?: [string, string]; checkPoints?: Vec3[] } = {},
): Record<string, unknown> {
  const separationM = options.separationM ?? 3.2
  const photo = (role: string, tapPoint: { x: number; y: number }) => ({
    url: options.photos === 'no-url' ? null : `/projects/p1/reference-photos/ref-${role}.jpg`,
    localKey: `p1:${role}`,
    tapPoint,
    pose: { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    capturedAt: '2026-11-01T00:00:00.000Z',
  })
  return {
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    ...(options.toleranceM === null ? { toleranceM: null } : { toleranceM: options.toleranceM ?? 0.15 }),
    anchorBearingDeg: 77,
    ...(options.labels ? { pointLabels: options.labels } : {}),
    ...(options.photos ? { referencePhotos: { landmark: photo('landmark', { x: 0.4, y: 0.3 }), headingMarker: photo('headingMarker', { x: 0.6, y: 0.7 }) } } : {}),
    ...(options.checkPoints ? { checkPoints: options.checkPoints } : {}),
  }
}

export interface VisitSetup {
  /** The Place's stored frame, as the record holds it. None: a first visit. */
  stored?: unknown
  /** The page's query string. */
  search?: string
  /** Whether the provider can say its lens (default true). A native-like provider with no field of view says none. */
  lens?: boolean
  /** Whether the host can take camera frames at all (default true). */
  capture?: boolean
  /** The camera frame's size in pixels. Default: the view's own, so the canvas shows all of it. */
  frame?: { width: number; height: number }
  /** What the host answers when asked for a stored photo. Default: a picture for every photo. `false`: the host has no loader. */
  loadReferencePhoto?: false | ((photo: CalibrationReferencePhoto) => Promise<string | null>)
  /** The host's answer to "Wrong Place? Choose another". Absent: the host has none. */
  onWrongPlace?: () => void
  /** Where the camera starts. */
  pose?: CameraPose
  /** The floor, in session metres (default `FLOOR_Y`, level with the session origin). A phone that starts 1.4 m up has it at -1.4. */
  floorY?: number
  /**
   * Whether the provider hands back one pose object for every call, changed in place as the phone moves, as a provider that
   * does not copy its pose does. Default: a new object each call.
   */
  reusePose?: boolean
}

export interface Visit {
  scene: THREE.Scene
  camera: { pose: CameraPose }
  /**
   * What the next camera frame does, and how many have been asked for. `'hold'`: the host answers each request when
   * `release()` is called, the frame taken from wherever the camera is then.
   */
  capture: { mode: 'ok' | 'reject' | 'null' | 'hold'; calls: number; release(): void }
  /** The photos the host was asked to load, in order. */
  loads: CalibrationReferencePhoto[]
  wrongPlaceCalls: number
  /** What the host's hit test does: answers at once, or `'hold'`: answers each touch when `release()` is called. */
  hits: { mode: 'ok' | 'hold'; release(): void }
  /**
   * A tap at a pixel of the view (0 to 1, from the top left): the floor point the camera's ray meets is what the hit test
   * answers, moved along the floor by `snap` metres when given. A feature-point hit snaps to the nearest mapped feature, a
   * little off the ray, so the marker is then not exactly where the pixel was tapped.
   */
  tap(u: number, v: number, snap?: { x?: number; z?: number }): Promise<Vec3>
  press(button: ButtonName): Promise<void>
  /**
   * Leaves the check-point step by its button, which skips it, when the card is in that step. A first calibration is offered a check
   * point once the heading marker is placed (WP-04b), and the commit is not on the card until the step is answered: a person who
   * wants the pair presses this, and a test of the pair does what the person does. Nothing is pressed in any other step, where the
   * same button adds the point back or takes it away.
   */
  skipCheckPoint(): Promise<void>
  type(text: string): Promise<void>
  advance(ms: number): Promise<void>
  settle(): Promise<void>
  /** A part of the card, by id. */
  part(id: string): FakeElement
  copy(): string
  status(): string
  /** The buttons the card is showing. */
  shown(): ButtonName[]
  /** The names of what the modal drew, one level down inside its placement group. */
  placementNames(): string[]
  /** The distance rings in the scene, with their centre and radius. */
  rings(): Array<{ centre: Vec3; radius: number }>
  closed(): boolean
  result(): Promise<CalibrationResult | null>
  /** Leaves the process as it found it. */
  dispose(): Promise<void>
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const OVERRIDDEN = ['document', 'location'] as const

export async function openVisit(setup: VisitSetup = {}): Promise<Visit> {
  const runModal = await loadModal()
  const card = new FakeElement()
  const canvas = new FakeElement()
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: VIEW.width, height: VIEW.height })
  const scene = new THREE.Scene()
  const camera = { pose: setup.pose ?? START_POSE }
  const waiting: Array<() => void> = []
  const capture = {
    mode: 'ok' as 'ok' | 'reject' | 'null' | 'hold',
    calls: 0,
    release: () => waiting.splice(0).forEach((arrive) => arrive()),
  }
  const loads: CalibrationReferencePhoto[] = []
  const floorY = setup.floorY ?? FLOOR_Y
  let nextHit: Vec3 = { x: 0, y: floorY, z: 0 }
  const frameSize = setup.frame ?? { ...VIEW }
  const wrong = { calls: 0 }
  const answering: Array<() => void> = []
  const hits = {
    mode: 'ok' as 'ok' | 'hold',
    release: () => answering.splice(0).forEach((answer) => answer()),
  }

  const saved = new Map(OVERRIDDEN.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const))
  Object.defineProperty(globalThis, 'document', { value: { createElement: () => card, body: { appendChild: () => {} } }, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'location', { value: { search: setup.search ?? '' }, configurable: true, writable: true })
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW })

  const copyPose = (): CameraPose => ({ position: { ...camera.pose.position }, rotation: { ...camera.pose.rotation } })
  /** The one object a provider that does not copy its pose gives back, changed in place to where the phone is. */
  const shared: CameraPose = copyPose()
  const providerPose = (): CameraPose => {
    if (!setup.reusePose) return copyPose()
    Object.assign(shared.position, camera.pose.position)
    Object.assign(shared.rotation, camera.pose.rotation)
    return shared
  }
  const project = { projectId: 'p1', name: 'Room', createdAt: 0, updatedAt: 0, floors: [], ...(setup.stored === undefined ? {} : { spatialFrame: setup.stored }) }
  const loader = setup.loadReferencePhoto === undefined
    ? async (photo: CalibrationReferencePhoto) => {
        loads.push(photo)
        return 'data:image/png;base64,AAAA'
      }
    : setup.loadReferencePhoto === false
      ? undefined
      : async (photo: CalibrationReferencePhoto) => {
          loads.push(photo)
          return (setup.loadReferencePhoto as (p: CalibrationReferencePhoto) => Promise<string | null>)(photo)
        }

  const result = runModal({
    provider: {
      getPose: () => providerPose(),
      isTracking: () => true,
      getScene: () => scene,
      ...(setup.lens === false ? {} : { getCameraFovY: () => FOV_Y_DEG, getCameraAspect: () => ASPECT }),
    } as never,
    project: project as never,
    canvas: canvas as never,
    async hitTest(): Promise<HitResult | null> {
      const position = nextHit
      if (hits.mode === 'hold') await new Promise<void>((answer) => answering.push(answer))
      return { position, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 1.5 }
    },
    bearing: () => 100,
    ground: () => ({ y: floorY, locked: true }),
    ...(setup.capture === false
      ? {}
      : {
          capturePhoto: async () => {
            capture.calls += 1
            if (capture.mode === 'reject') throw new Error('Capture already pending')
            if (capture.mode === 'null') return null
            if (capture.mode === 'hold') await new Promise<void>((arrive) => waiting.push(arrive))
            return { blob: new Blob(['frame']), thumbDataUrl: 'data:image/jpeg;base64,AAAA', pose: copyPose(), frameSize: { ...frameSize } }
          },
        }),
    ...(loader ? { loadReferencePhoto: loader } : {}),
    ...(setup.onWrongPlace ? { onWrongPlace: () => { wrong.calls += 1; setup.onWrongPlace!() } } : {}),
  })
  let closed = false
  void result.then(() => {
    closed = true
  })
  await settle()

  const part = (id: string): FakeElement => {
    const found = card.parts.get(id)
    if (!found) throw new Error(`the card has no element ${id}`)
    return found
  }

  const visit: Visit = {
    scene,
    camera,
    capture,
    loads,
    get wrongPlaceCalls() {
      return wrong.calls
    },
    hits,
    async tap(u, v, snap) {
      const hit = floorRayPoint({ ...camera.pose, fovYDeg: FOV_Y_DEG, aspect: ASPECT }, u, v, floorY)
      if (!hit) throw new Error(`the ray through (${u}, ${v}) does not meet the floor`)
      nextHit = { x: hit.position.x + (snap?.x ?? 0), y: hit.position.y, z: hit.position.z + (snap?.z ?? 0) }
      canvas.fire('touchstart', { touches: [{ clientX: u * VIEW.width, clientY: v * VIEW.height }] })
      await settle()
      return nextHit
    },
    async press(button) {
      part(BUTTONS[button]).click()
      await settle()
    },
    async skipCheckPoint() {
      const button = part(BUTTONS.check)
      if (!button.hidden && button.textContent === SKIP_CHECK_LABEL) await visit.press('check')
    },
    async type(text) {
      const input = part('project-calibration-label-input')
      input.value = text
      input.fire('input')
      await settle()
    },
    async advance(ms) {
      mock.timers.tick(ms)
      await settle()
    },
    settle,
    part,
    copy: () => part('project-calibration-copy').textContent,
    status: () => part('project-calibration-status').textContent,
    shown: () => (Object.keys(BUTTONS) as ButtonName[]).filter((name) => !part(BUTTONS[name]).hidden),
    placementNames() {
      const placement = scene.getObjectByName('calibration placement')
      return placement ? placement.children.map((child) => child.name) : []
    },
    rings() {
      const found: Array<{ centre: Vec3; radius: number }> = []
      scene.traverse((object) => {
        if (object.name !== 'calibration distance ring') return
        const positions = (object as THREE.LineSegments).geometry.getAttribute('position')
        let radius = 0
        for (let i = 0; i < positions.count; i++) radius = Math.max(radius, Math.hypot(positions.getX(i), positions.getZ(i)))
        found.push({ centre: { x: object.position.x, y: object.position.y, z: object.position.z }, radius })
      })
      return found
    },
    closed: () => closed,
    result: () => result,
    async dispose() {
      if (!closed) {
        part(BUTTONS.skip).click()
        await settle()
      }
      mock.timers.reset()
      for (const name of OVERRIDDEN) {
        const had = saved.get(name)
        if (had) Object.defineProperty(globalThis, name, had)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
  return visit
}
