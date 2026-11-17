/**
 * The writers that make the records a Place and a scan are stored as, run for real, so a test can hold
 * the schema to what the app produces and not to what a test author remembers it producing.
 *
 * Three writers, none re-implemented here:
 *
 *  - the calibration commit: `runProjectCalibration` (src/ar/project-calibration.ts), the modal that builds a
 *    scan's `ScanCalibration` and the Place's `ProjectSpatialFrame`. It is a DOM module, so it is driven the way
 *    tests/unit/node/calibration_bearing_flow.test.ts drives it: a stand-in document that registers every
 *    `id="..."` in the flow's markup, taps fired on a stand-in canvas, and a physical model of the session and
 *    the floor (tests/unit/deno/physical_oracle.ts) that shares no code with the app;
 *  - the frame's trip to the server: `persistProjectSpatialFrame` (src/project/frame-sync.ts), which stores the
 *    reference photos and sends the frame with their records attached, against the real `ProjectStore` on an
 *    in-memory IndexedDB;
 *  - the scan's upload sidecar: `exportToGLB` (src/export/gltf.ts), whose `metadata` form field is the text the
 *    server stores as `<scan>.json`.
 *
 * Nothing here reads the modal's source: it drives the public entry point and keeps what it returns, so it does
 * not depend on where the commit's arithmetic lives (WP-04b step 0 plans to move it out of the modal). It does
 * depend on the flow's element ids (`project-calibration-confirm`, `-commit`, `-fallback`, `-override`,
 * `-label-input`), which tests/unit/node/calibration_bearing_flow.test.ts, wp-calibration-modal.test.ts and
 * tests/mock-two-point-calibration.spec.ts also use.
 *
 * Every global a writer reads (`document`, `location`, `FileReader`, `fetch`) is put back when the call ends.
 */
import { register } from 'node:module'
import * as THREE from 'three'
import { exportToGLB } from '../../../../src/export/gltf.ts'
import type { CalibrationResult } from '../../../../src/ar/project-calibration.ts'
import type { PendingReferencePhoto } from '../../../../src/ar/reference-photo.ts'
import type { DetectionStore } from '../../../../src/scene/store.ts'
import type { PointCloud } from '../../../../src/scene/pointcloud.ts'
import { persistProjectSpatialFrame, type FrameSyncEnv } from '../../../../src/project/frame-sync.ts'
import type { Project, ProjectSpatialFrame, ScanCalibration, Vec3 } from '../../../../src/world/types.ts'
import { cameraRotation, enuToSession, perfectCompassBearing } from '../../deno/physical_oracle.ts'
import { opened } from './fake-indexeddb.ts'

// The flow's imports are written for the bundler (`'../world/geo'`); Node needs the extension.
register(
  'data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const relative = /^\\.\\.?\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && relative) return nextResolve(specifier + '.ts', context)
    throw error
  }
}
`),
  import.meta.url,
)
const { runProjectCalibration } = await import('../../../../src/ar/project-calibration.ts')

// ── Globals ──────────────────────────────────────────────────────────────────────────────────────

/** Runs `run` with these globals set, and puts every one back as it was, whether `run` returns or throws. */
export async function withGlobals<T>(overrides: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const before = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries(overrides)) {
    before.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  try {
    return await run()
  } finally {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as Record<string, unknown>)[name]
    }
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

// ── A stand-in for the part of the DOM the flow touches ──────────────────────────────────────────

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
  remove(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 }
  }
}

// ── The calibration commit ───────────────────────────────────────────────────────────────────────

/** Where the floor is in the session, metres. Every tap lands on it. */
const FLOOR_Y = -1.2
/** The landmark's place in the room (east, north), metres from the session's physical origin. */
const LANDMARK_ENU = { east: 1.5, north: -2, up: FLOOR_Y }

export interface FlowScenario {
  /** What the Place already holds, which the visit is made against. Absent: a first calibration. */
  stored?: ProjectSpatialFrame
  /** `'one-point'` is #141's single-tap fallback. Default `'two-point'`. */
  tier?: 'two-point' | 'one-point'
  /** Distance between the two physical floor features tapped, metres. Default 2.4. */
  baselineM?: number
  /** True bearing the session started facing, degrees. Default 137. */
  psi?: number
  /** Degrees the camera has turned left since the session started, and tilted down. Defaults 75 and 60. */
  turn?: number
  down?: number
  /** True bearing of the baseline from point A to point B, degrees. Default 123. */
  baselineBearing?: number
  /** Names typed for point A and point B. */
  labels?: { landmark?: string; heading?: string }
  /** Whether the host can grab a camera frame for each marker's reference photo. */
  photos?: boolean
  /** Press "Use anyway" when the flow reports that the pair does not match the stored one. */
  override?: boolean
  /** The compass: `'perfect'` (default) or no reading. */
  compass?: 'perfect' | 'none'
  /** The Place's id, which the photo records name. Default `proj-1700000000000`. */
  projectId?: string
}

/**
 * Runs the real calibration flow for one scenario and returns what it returns to the host: the scan's
 * calibration, the Place frame when the frame changed, and the reference photos when it took any.
 */
export async function runRealCalibration(scenario: FlowScenario = {}): Promise<CalibrationResult> {
  const psi = scenario.psi ?? 137
  const turn = scenario.turn ?? 75
  const down = scenario.down ?? 60
  const baselineM = scenario.baselineM ?? 2.4
  const baselineRad = ((scenario.baselineBearing ?? 123) * Math.PI) / 180
  const rotation = cameraRotation(turn, down)
  const landmark = enuToSession(psi, LANDMARK_ENU)
  const marker = enuToSession(psi, {
    east: LANDMARK_ENU.east + baselineM * Math.sin(baselineRad),
    north: LANDMARK_ENU.north + baselineM * Math.cos(baselineRad),
    up: FLOOR_Y,
  })

  const card = new FakeElement()
  const canvas = new FakeElement()
  let hit: Vec3 = { x: 0, y: FLOOR_Y, z: 0 }
  const project = {
    projectId: scenario.projectId ?? 'proj-1700000000000',
    name: 'Room',
    createdAt: 0,
    updatedAt: 0,
    floors: [],
    ...(scenario.stored ? { spatialFrame: scenario.stored } : {}),
  } as Project

  return await withGlobals(
    { document: { createElement: () => card, body: { appendChild: () => {} } }, location: { search: '' } },
    async () => {
      const result = runProjectCalibration({
        provider: {
          getPose: () => ({ position: { x: 0, y: 1.5, z: 0 }, rotation }),
          isTracking: () => true,
          getScene: () => new THREE.Scene(),
        } as never,
        project,
        canvas: canvas as never,
        hitTest: async () => ({ position: hit, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 1.5 }),
        bearing: () => (scenario.compass === 'none' ? null : perfectCompassBearing(psi, rotation)),
        ground: () => ({ y: FLOOR_Y, locked: true }),
        ...(scenario.photos
          ? {
            capturePhoto: async () => ({
              blob: new Blob(['jpeg bytes'], { type: 'image/jpeg' }),
              thumbDataUrl: 'data:image/jpeg;base64,AAAA',
              pose: { position: { x: 0, y: 1.5, z: 0 }, rotation },
              frameSize: { width: 100, height: 100 },
            }),
          }
          : {}),
      })

      /** What the flow settled with. It is `null` only when the person cancels, which no scenario does. */
      const finished = async (): Promise<CalibrationResult> => {
        const outcome = await result
        if (outcome === null) throw new Error('the flow was cancelled and returned no calibration')
        return outcome
      }
      const press = (id: string): void => {
        const button = card.parts.get(id)
        if (!button) throw new Error(`the flow has no element ${id}`)
        if (button.hidden || button.disabled) throw new Error(`${id} cannot be pressed: it is ${button.hidden ? 'hidden' : 'disabled'}`)
        button.click()
      }
      const tap = async (at: Vec3, x: number): Promise<void> => {
        hit = at
        canvas.fire('touchstart', { touches: [{ clientX: x * 100, clientY: 50 }] })
        await settle()
      }
      const name = (text: string | undefined): void => {
        if (!text) return
        const input = card.parts.get('project-calibration-label-input')!
        input.value = text
        input.fire('input')
      }

      await tap(landmark, 0.3)
      if (scenario.tier === 'one-point') {
        press('project-calibration-fallback')
        return await finished()
      }
      name(scenario.labels?.landmark)
      press('project-calibration-confirm')
      await tap(marker, 0.7)
      // A first calibration is offered a check point after the heading marker (WP-04b); these scenarios are two-point ones, so a
      // person skips the step, with the one check-point button, when it is showing. A Place with a stored pair is not offered it.
      if (!card.parts.get('project-calibration-check')!.hidden) press('project-calibration-check')
      name(scenario.labels?.heading)
      press('project-calibration-commit')
      if (scenario.override) {
        await settle()
        press('project-calibration-override')
      }
      return await finished()
    },
  )
}

// ── The frame's trip to the server ───────────────────────────────────────────────────────────────

/** A frame the way the phone sends it: what the calibration made, with the records of its stored photos attached. */
export interface SentFrame {
  /** The body of `PUT /projects/:id/spatial-frame`. */
  body: { frame: ProjectSpatialFrame; expectedRevision: number }
  /** The photo uploads that followed it, by role. */
  uploads: string[]
}

/**
 * Sends a calibration's frame through the real client code (`persistProjectSpatialFrame`), against an in-memory
 * IndexedDB and a server that accepts everything, and returns what went over the wire.
 */
export async function sendFrameLikeThePhone(
  project: Project,
  frame: ProjectSpatialFrame,
  photos: PendingReferencePhoto[],
): Promise<SentFrame> {
  const { store } = await opened()
  const bodies: SentFrame['body'][] = []
  const uploads: string[] = []
  const env: FrameSyncEnv = {
    url: (path) => path,
    now: () => 1_700_000_001_000,
    online: () => true,
    fetchFn: (async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as SentFrame['body']
        bodies.push(body)
        return new Response(JSON.stringify({ revision: body.expectedRevision + 1, frame: body.frame }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (init?.body instanceof FormData) {
        uploads.push((JSON.parse(String(init.body.get('meta'))) as { role: string }).role)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  }
  const outcome = await persistProjectSpatialFrame(store, project, frame, { photos }, env)
  if (outcome.status !== 'saved') throw new Error(`the stand-in server did not keep the frame: ${outcome.status}`)
  if (bodies.length !== 1) throw new Error(`the frame went over the wire ${bodies.length} times`)
  return { body: bodies[0]!, uploads }
}

// ── The scan's upload sidecar ────────────────────────────────────────────────────────────────────

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = buffer
        this.onloadend?.()
      },
      (err) => this.onerror?.(err),
    )
  }
}

/**
 * The text `exportToGLB` hands the server as the scan's metadata, parsed: the sidecar the server stores next to the
 * GLB. `calibration` is what the scanner holds for the scan (`ScanEntry.calibration`), or null for a scan that never
 * calibrated.
 */
export async function realSidecar(calibration: ScanCalibration | null): Promise<Record<string, unknown>> {
  let metadata: string | null = null
  const detections = new Map()
  const store = {
    sessionId: 'sess-s0-golden',
    serverSessionOfThisRun: 'sess-s0-golden',
    detections,
    currentRunDetections: () => detections,
  } as unknown as DetectionStore
  const positions = new Float32Array(9)
  const pointCloud = {
    count: 3,
    toFloat32Array: () => positions,
    boundingBox: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
    estimateFloorY: () => 0,
  } as unknown as PointCloud
  const scanEntry = {
    scanId: 'scan-s0-golden',
    projectId: 'proj-1700000000000',
    sessionId: 'sess-s0-golden',
    name: 'Kitchen',
    status: 'draft' as const,
    capturedAt: 1_700_000_000_000,
    ...(calibration ? { calibration } : {}),
  }
  // The exporter reports each export with a log line and the glTF exporter warns about the stand-in's material;
  // neither is what this call is for, and a golden test prints one pair per record.
  const quiet = { ...console, log: () => {}, warn: () => {} }
  await withGlobals(
    {
      console: quiet,
      FileReader: NodeFileReader,
      fetch: async (_url: string, init?: RequestInit) => {
        const text = (init?.body as FormData | undefined)?.get('metadata')
        if (typeof text === 'string') metadata = text
        return new Response(JSON.stringify({ filename: 'stored.glb' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    },
    () => exportToGLB({ store, pointCloud, poseHistory: [], scanEntry }, { download: false, upload: true }),
  )
  if (metadata === null) throw new Error('the export sent no metadata')
  return JSON.parse(metadata) as Record<string, unknown>
}
