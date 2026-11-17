/**
 * The state around the calibration's reference photos (WP-07): where each crosshair goes, when a photo is taken again,
 * and what the commit holds on. src/ar/reference-photo-flow.ts, with no modal and no DOM: the host is a stand-in whose
 * camera is a perfect pinhole, so a marker's place in a picture is known from first principles.
 *
 * The expected crosshair is never computed by the code under test. It is three.js's own `Vector3.project()` on a
 * PerspectiveCamera built the way src/main.ts builds a capture camera, then the cover-crop a canvas puts on a camera
 * frame worked by hand (a frame taller than the view loses the sides, a wider one the top and bottom). The pure
 * projection is held to the same oracle in reference_photo_projection.test.ts; this file holds the flow around it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-reference-photo-flow.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  createReferencePhotoFlow,
  lensOfProvider,
  type CameraPose,
  type PhotoLens,
  type ReferencePhotoHost,
} from '../../../src/ar/reference-photo-flow.ts'
import type { ARProvider, HitResult } from '../../../src/ar/provider.ts'
import type { ReferencePhotoCapture } from '../../../src/ar/reference-photo.ts'
import type { RawDetection } from '../../../src/inference/prompt.ts'
import { posesAreStill, resolveDetections } from '../../../src/spatial/resolver.ts'
import type { Vec3 } from '../../../src/world/types.ts'

const DEG = Math.PI / 180
const VIEW = { width: 360, height: 640 }
const LENS: PhotoLens = { fovYDeg: 60, aspect: VIEW.width / VIEW.height }
const EYE: Vec3 = { x: 0, y: 1.5, z: 0 }

function poseFrom(position: Vec3, pitchDeg: number, yawDeg: number): CameraPose {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchDeg * DEG, yawDeg * DEG, 0, 'YXZ'))
  return { position: { ...position }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

/** three.js's answer for where a marker falls in the view, in the normalised coordinates a tap is read in. Null when behind or outside. */
function threeView(marker: Vec3, pose: CameraPose, lens: PhotoLens): { x: number; y: number } | null {
  const camera = new THREE.PerspectiveCamera(lens.fovYDeg, lens.aspect, 0.01, 1000)
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

/**
 * The cover-crop worked by hand: the frame is scaled to cover the view and centred, so a point at `p` of the view is at
 * `(p * view - offset) / (frame * scale)` of the frame, per axis.
 */
function intoPhoto(p: { x: number; y: number }, frame: { width: number; height: number }): { x: number; y: number } {
  const scale = Math.max(VIEW.width / frame.width, VIEW.height / frame.height)
  const offsetX = (VIEW.width - frame.width * scale) / 2
  const offsetY = (VIEW.height - frame.height * scale) / 2
  return { x: (p.x * VIEW.width - offsetX) / (frame.width * scale), y: (p.y * VIEW.height - offsetY) / (frame.height * scale) }
}

function near(actual: number, expected: number, tolerance = 1e-9, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} is not ${expected} (within ${tolerance})`)
}

interface Rig {
  flow: ReturnType<typeof createReferencePhotoFlow>
  /** The camera now; a frame is taken from here. */
  camera: { pose: CameraPose }
  state: { capture: 'ok' | 'reject' | 'null'; lens: PhotoLens | null; frame: { width: number; height: number } }
  calls: { capture: number; pose: number }
}

/** A flow over a perfect-pinhole host. */
function rig(overrides: { lens?: PhotoLens | null; withCapture?: boolean; frame?: { width: number; height: number } } = {}): Rig {
  const camera = { pose: poseFrom(EYE, -35, 0) }
  const state: Rig['state'] = {
    capture: 'ok',
    lens: overrides.lens === undefined ? LENS : overrides.lens,
    frame: overrides.frame ?? { width: VIEW.width, height: VIEW.height },
  }
  const calls = { capture: 0, pose: 0 }
  const host: ReferencePhotoHost = {
    ...(overrides.withCapture === false
      ? {}
      : {
          capturePhoto: async (): Promise<ReferencePhotoCapture | null> => {
            calls.capture++
            if (state.capture === 'reject') throw new Error('Capture already pending')
            if (state.capture === 'null') return null
            return {
              blob: new Blob(['frame']),
              thumbDataUrl: 'data:image/jpeg;base64,AAAA',
              pose: { position: { ...camera.pose.position }, rotation: { ...camera.pose.rotation } },
              frameSize: { ...state.frame },
            }
          },
        }),
    view: () => ({ ...VIEW }),
    lens: () => state.lens,
    pose: () => {
      calls.pose++
      return camera.pose
    },
    now: () => '2026-11-16T09:30:00.000Z',
  }
  return { flow: createReferencePhotoFlow(host), camera, state, calls }
}

/** The floor point 3 m ahead and a little to the left of the camera at rest, so it is well inside the view. */
const MARKER: Vec3 = { x: -0.4, y: 0, z: -2.2 }

// ── The lens ──────────────────────────────────────────────────────────────────────────────────────

test('a provider\'s lens is its field of view and aspect, and null when either is not a lens', () => {
  assert.deepEqual(lensOfProvider({ getCameraFovY: () => 62.5, getCameraAspect: () => 0.5625 }), { fovYDeg: 62.5, aspect: 0.5625 })
  // The native provider measures no field of view and says NaN, and a stand-in may have no such method at all.
  assert.equal(lensOfProvider({ getCameraFovY: () => Number.NaN, getCameraAspect: () => 0.5625 }), null)
  assert.equal(lensOfProvider({ getCameraAspect: () => 0.5625 }), null)
  assert.equal(lensOfProvider({ getCameraFovY: () => 60 }), null)
  assert.equal(lensOfProvider({}), null)
  assert.equal(lensOfProvider({ getCameraFovY: () => 0, getCameraAspect: () => 1 }), null)
  assert.equal(lensOfProvider({ getCameraFovY: () => 180, getCameraAspect: () => 1 }), null)
  assert.equal(lensOfProvider({ getCameraFovY: () => 60, getCameraAspect: () => 0 }), null)
  assert.equal(lensOfProvider({ getCameraFovY: () => 60, getCameraAspect: () => Number.POSITIVE_INFINITY }), null)
})

// ── Where the crosshair goes ──────────────────────────────────────────────────────────────────────

test('a phone that has not moved since the tap: the crosshair is the tap, whatever the lens would say', async () => {
  const { flow } = rig()
  // A marker that is nowhere near where this tap's ray goes: a lens-only answer could not put the crosshair on the tap.
  const tap = flow.touch(0.31, 0.77)
  const task = flow.begin('landmark', { x: 40, y: 0, z: 90 }, tap)
  const photo = await task
  assert.ok(photo)
  assert.deepEqual(photo.tapPoint, { x: 0.31, y: 0.77 })
})

test('a phone that turned 5 degrees before the photo: the crosshair is where the marker is now, 48.5 px off the raw tap', async () => {
  const { flow, camera } = rig()
  // The user taps a marker 3 m straight ahead, then turns right by 5 degrees (a rotation of -5 about +Y) before the frame.
  const eye = poseFrom(EYE, 0, 0)
  camera.pose = eye
  const marker: Vec3 = { x: 0, y: 1.5, z: -3 }
  const tap = flow.touch(0.5, 0.5)
  camera.pose = poseFrom(EYE, 0, -5)
  const photo = await flow.begin('headingMarker', marker, tap)
  assert.ok(photo)
  const expected = threeView(marker, camera.pose, LENS)!
  near(photo.tapPoint.x, expected.x, 1e-9, 'x')
  near(photo.tapPoint.y, expected.y, 1e-9, 'y')
  // focal * tan(5 degrees): 554.256 px * 0.087489 = 48.49 px of the 360 across, to the left of where it was tapped.
  const focalPx = VIEW.height / 2 / Math.tan(30 * DEG)
  near((0.5 - photo.tapPoint.x) * VIEW.width, focalPx * Math.tan(5 * DEG), 1e-6, 'shift in px')
  assert.ok(Math.abs((0.5 - photo.tapPoint.x) * VIEW.width - 48.49) < 0.01)
})

test('a provider that gives back one pose object and changes it in place cannot make a phone that turned look as if it had not', async () => {
  const { flow, camera } = rig()
  const eye = poseFrom(EYE, 0, 0)
  camera.pose = eye
  const marker: Vec3 = { x: 0, y: 1.5, z: -3 }
  // The pose the tap is made from is read here, from an object the provider will go on changing.
  const tap = flow.touch(0.5, 0.5)
  const turned = poseFrom(EYE, 0, -5)
  Object.assign(camera.pose.position, turned.position)
  Object.assign(camera.pose.rotation, turned.rotation)
  assert.strictEqual(camera.pose, eye, 'the provider\'s one object, now where the phone is')
  const photo = await flow.begin('headingMarker', marker, tap)
  assert.ok(photo)
  const expected = threeView(marker, turned, LENS)!
  near(photo.tapPoint.x, expected.x, 1e-9, 'x: where the marker is now, not the tap')
  assert.ok(Math.abs(photo.tapPoint.x - 0.5) * VIEW.width > 40, 'the turn moved the marker in the picture by 48.5 px')
})

test('a camera that moved far enough that the marker left the view: no photo, and the commit says so', async () => {
  const { flow, camera } = rig()
  const tap = flow.touch(0.5, 0.5)
  camera.pose = poseFrom(EYE, 0, -75)
  const outcome = await flow.settle({ role: 'headingMarker', task: flow.begin('headingMarker', { x: 0, y: 1.5, z: -3 }, tap), marker: { x: 0, y: 1.5, z: -3 }, tap })
  assert.equal(outcome, null)
  const hold = flow.holdText()
  assert.ok(hold)
  assert.match(hold, /^Point B is not in the camera view\./)
})

test('still means 2 cm and 2 degrees, the resolver\'s own rule: a hair inside is the tap, a hair outside is the projection', async () => {
  const marker: Vec3 = { x: 0, y: 1.5, z: -3 }
  const cases: Array<{ label: string; moved: CameraPose; viaTap: boolean }> = [
    { label: '1.9 cm', moved: poseFrom({ x: 0.019, y: 1.5, z: 0 }, 0, 0), viaTap: true },
    { label: '2.1 cm', moved: poseFrom({ x: 0.021, y: 1.5, z: 0 }, 0, 0), viaTap: false },
    { label: '1.9 degrees', moved: poseFrom(EYE, 0, -1.9), viaTap: true },
    { label: '2.1 degrees', moved: poseFrom(EYE, 0, -2.1), viaTap: false },
  ]
  for (const { label, moved, viaTap } of cases) {
    const { flow, camera } = rig()
    camera.pose = poseFrom(EYE, 0, 0)
    const tap = flow.touch(0.5, 0.5)
    camera.pose = moved
    const photo = await flow.begin('landmark', marker, tap)
    assert.ok(photo, label)
    const projected = threeView(marker, moved, LENS)!
    if (viaTap) {
      assert.deepEqual(photo.tapPoint, { x: 0.5, y: 0.5 }, `${label}: the tap`)
    } else {
      near(photo.tapPoint.x, projected.x, 1e-9, `${label}: x`)
      near(photo.tapPoint.y, projected.y, 1e-9, `${label}: y`)
      assert.notDeepEqual(photo.tapPoint, { x: 0.5, y: 0.5 }, `${label}: not the tap`)
    }
  }
})

test('a runtime with no lens has only the tap to go on: that is the crosshair, as before, and the camera pose is never read', async () => {
  const { flow, camera, calls } = rig({ lens: null })
  const tap = flow.touch(0.62, 0.41)
  camera.pose = poseFrom(EYE, 10, -40)
  const photo = await flow.begin('landmark', { x: 0, y: 0, z: -3 }, tap)
  assert.ok(photo)
  assert.deepEqual(photo.tapPoint, { x: 0.62, y: 0.41 })
  assert.equal(calls.pose, 0, 'a pose is only read to tell whether the phone has moved, which needs a lens to be worth anything')
})

test('the crosshair is mapped through the cover-crop: a frame taller than the view loses its sides, a wider one its top and bottom', async () => {
  for (const frame of [{ width: 1080, height: 1440 }, { width: 1920, height: 1080 }, { width: 640, height: 640 }]) {
    const { flow, camera } = rig({ frame })
    camera.pose = poseFrom(EYE, -35, 0)
    const tap = flow.touch(0.4, 0.6)
    camera.pose = poseFrom(EYE, -35, -6)
    const marker: Vec3 = { x: -0.2, y: 0, z: -2.0 }
    const photo = await flow.begin('landmark', marker, tap)
    const inView = threeView(marker, camera.pose, LENS)
    assert.ok(photo && inView, `${frame.width}x${frame.height}`)
    const expected = intoPhoto(inView, frame)
    near(photo.tapPoint.x, expected.x, 1e-9, `${frame.width}x${frame.height} x`)
    near(photo.tapPoint.y, expected.y, 1e-9, `${frame.width}x${frame.height} y`)
  }
})

test('a photo carries what the stored record has always carried, in the order it has always been written', async () => {
  const { flow } = rig()
  const photo = await flow.begin('headingMarker', MARKER, flow.touch(0.5, 0.5))
  assert.ok(photo)
  assert.deepEqual(Object.keys(photo), ['role', 'blob', 'thumbDataUrl', 'tapPoint', 'pose', 'capturedAt', 'label'])
  assert.equal(photo.role, 'headingMarker')
  assert.equal(photo.capturedAt, '2026-11-16T09:30:00.000Z')
  assert.equal(photo.label, null)
})

// ── The rule that says the phone has not moved ────────────────────────────────────────────────────

test('two poses are the same place within 2 cm and 2 degrees, the limits excluded', () => {
  const home = poseFrom(EYE, -35, 10)
  assert.equal(posesAreStill(home, home), true)
  assert.equal(posesAreStill(home, poseFrom({ x: 0.0199, y: 1.5, z: 0 }, -35, 10)), true)
  assert.equal(posesAreStill(home, poseFrom({ x: 0, y: 1.5, z: -0.0201 }, -35, 10)), false)
  assert.equal(posesAreStill(home, poseFrom(EYE, -35, 11.9)), true)
  assert.equal(posesAreStill(home, poseFrom(EYE, -35, 12.1)), false)
  assert.equal(posesAreStill(home, poseFrom(EYE, -37.1, 10)), false, 'a tilt counts as a turn')
  // A pose with a number that is not one is not the same place as anything.
  assert.equal(posesAreStill(home, { ...home, position: { ...home.position, x: Number.NaN } }), false)
  assert.equal(posesAreStill({ ...home, rotation: { ...home.rotation, w: Number.NaN } }, home), false)
})

test('the resolver reads the same rule as before it was shared: a live hit test is used while the phone is where the frame was taken, and skipped once it is not', async () => {
  const liveHit: HitResult = { position: { x: 1, y: 2, z: -3 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 1 }
  const detection: RawDetection = { label: 'chair', bbox: [0.4, 0.4, 0.6, 0.6], confidence: 0.9, description: 'a chair' }
  const taken = poseFrom({ x: 0, y: 0, z: 0 }, 0, 0)
  const resolveFrom = async (now: CameraPose) => {
    const provider = {
      start: () => Promise.resolve(),
      stop: () => {},
      captureFrame: () => Promise.reject(new Error('not used')),
      hitTest: () => liveHit,
      featurePoints: () => [],
      getPose: () => now,
      isTracking: () => true,
      getCameraFovY: () => 60,
      getCameraAspect: () => 1,
    } as ARProvider
    return resolveDetections([detection], 1000, { provider, cameraPose: taken })
  }
  const originalLog = console.log
  console.log = () => {}
  try {
    const still = await resolveFrom(poseFrom({ x: 0.019, y: 0, z: 0 }, 0, 1.9))
    assert.deepEqual(still[0]?.worldPos, liveHit.position, 'still: the live hit is the answer')
    for (const moved of [poseFrom({ x: 0.021, y: 0, z: 0 }, 0, 0), poseFrom({ x: 0, y: 0, z: 0 }, 0, 2.1)]) {
      const results = await resolveFrom(moved)
      assert.notDeepEqual(results[0]?.worldPos, liveHit.position, 'moved: the live hit test is not asked, and the capture-time camera answers')
    }
  } finally {
    console.log = originalLog
  }
})

// ── Starting a photo ──────────────────────────────────────────────────────────────────────────────

test('a host that takes no photos has nothing to start, and nothing to miss: no task, and no hold', async () => {
  const { flow } = rig({ withCapture: false })
  assert.equal(flow.begin('landmark', MARKER, flow.touch(0.5, 0.5)), null)
  const got = await flow.settle({ role: 'landmark', task: null, marker: MARKER, tap: null })
  assert.equal(got, null)
  assert.equal(flow.holdText(), null)
})

test('no marker, no task', () => {
  const { flow } = rig()
  assert.equal(flow.begin('landmark', null, flow.touch(0.5, 0.5)), null)
})

test('a capture that refuses is a photo that did not happen: the task resolves null, it never rejects', async () => {
  const { flow, state } = rig()
  state.capture = 'reject'
  assert.equal(await flow.begin('landmark', MARKER, flow.touch(0.5, 0.5)), null)
})

test('asking again for a marker whose photo is good, or still on its way, keeps it; a moved marker or a failed try is asked for again', async () => {
  const { flow, state, calls } = rig()
  const tap = flow.touch(0.5, 0.5)
  const first = flow.begin('headingMarker', MARKER, tap)!
  assert.equal(flow.begin('headingMarker', MARKER, tap, first), first, 'pending')
  assert.ok(await first)
  assert.equal(flow.begin('headingMarker', { ...MARKER }, tap, first), first, 'good, for a marker at the same place')
  assert.equal(calls.capture, 1, 'one frame for all of that')

  const moved = flow.begin('headingMarker', { ...MARKER, x: MARKER.x + 0.5 }, tap, first)!
  assert.notEqual(moved, first, 'a marker that moved is another photo')
  await moved
  assert.equal(calls.capture, 2)

  state.capture = 'reject'
  const failed = flow.begin('headingMarker', MARKER, tap, undefined)!
  assert.equal(await failed, null)
  state.capture = 'ok'
  const again = flow.begin('headingMarker', MARKER, tap, failed)!
  assert.notEqual(again, failed, 'a try that failed is tried again')
  assert.ok(await again)
})

// ── Settling at the commit ────────────────────────────────────────────────────────────────────────

test('a good photo is the photo: nothing is taken again, and nothing is held', async () => {
  const { flow, calls } = rig()
  const tap = flow.touch(0.5, 0.5)
  const task = flow.begin('landmark', MARKER, tap)
  const photo = await flow.settle({ role: 'landmark', task, marker: MARKER, tap })
  assert.ok(photo)
  assert.equal(calls.capture, 1)
  assert.equal(flow.holdText(), null)
})

test('a point whose photo came to nothing is photographed again at the commit, and a good second try holds nothing', async () => {
  const { flow, state, calls } = rig()
  state.capture = 'reject'
  const tap = flow.touch(0.5, 0.5)
  const task = flow.begin('landmark', MARKER, tap)
  assert.equal(await task, null)
  state.capture = 'ok'
  const photo = await flow.settle({ role: 'landmark', task, marker: MARKER, tap })
  assert.ok(photo)
  assert.equal(calls.capture, 2, 'once for the task, once for the second try')
  assert.equal(flow.holdText(), null)
})

test('a point with no task at all is photographed at the commit: the heading marker\'s case, and a dropped landmark\'s', async () => {
  const { flow, calls } = rig()
  const photo = await flow.settle({ role: 'headingMarker', task: null, marker: MARKER, tap: flow.touch(0.5, 0.5) })
  assert.ok(photo)
  assert.equal(calls.capture, 1)
})

test('a host with no frame to give is asked once and not again: that is no photo to hold the commit for', async () => {
  const { flow, state, calls } = rig()
  state.capture = 'null'
  const tap = flow.touch(0.5, 0.5)
  const task = flow.begin('landmark', MARKER, tap)
  assert.equal(await task, null)
  assert.equal(await flow.settle({ role: 'landmark', task, marker: MARKER, tap }), null)
  assert.equal(calls.capture, 1, 'the commit did not ask again')
  assert.equal(flow.holdText(), null)
})

// ── What the commit holds on ──────────────────────────────────────────────────────────────────────

/** Settles both points the way the modal does, then asks what to hold on, as the button named `button` on the card was pressed. */
async function commit(rigged: Rig, landmark: Vec3, heading: Vec3, tapOf: { landmark: ReturnType<Rig['flow']['touch']>; heading: ReturnType<Rig['flow']['touch']> }, tasks: { landmark: ReturnType<Rig['flow']['begin']>; heading: ReturnType<Rig['flow']['begin']> }, button: string | null | undefined = 'Use this alignment') {
  const photos = [
    await rigged.flow.settle({ role: 'landmark', task: tasks.landmark, marker: landmark, tap: tapOf.landmark }),
    await rigged.flow.settle({ role: 'headingMarker', task: tasks.heading, marker: heading, tap: tapOf.heading }),
  ]
  return { photos, hold: rigged.flow.holdText(button) }
}

test('a point that is out of view holds the commit once, and the press after it goes on with what there is', async () => {
  const r = rig()
  const landmark: Vec3 = { x: -0.4, y: 0, z: -2.2 }
  const heading: Vec3 = { x: 0.9, y: 0, z: -2.4 }
  const tapA = r.flow.touch(0.45, 0.62)
  const tapB = r.flow.touch(0.62, 0.7)
  const taskA = r.flow.begin('landmark', landmark, tapA)
  assert.ok(await taskA, 'the landmark was photographed at Confirm, with the camera where it was')
  // The person has turned away to the side by the time they press Commit: B is gone from the view, A's photo is good.
  r.camera.pose = poseFrom(EYE, -35, -80)
  const first = await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: taskA, heading: r.flow.begin('headingMarker', heading, tapB) })
  assert.equal(first.photos[0] !== null, true, 'A\'s good photo is kept')
  assert.equal(first.photos[1], null)
  assert.match(first.hold!, /^Point B is not in the camera view\. Aim at it, then press Use this alignment again\. If a photo is still missing/)

  // Nothing changed; the press after it goes on, without a second sentence.
  const second = await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: taskA, heading: r.flow.begin('headingMarker', heading, tapB) })
  assert.equal(second.hold, null)
  assert.equal(second.photos[1], null)
})

test('the hold tells the person to press the button they pressed, whatever the card calls it, or "the same button" when it is told none', async () => {
  for (const [button, expected] of [['Use anyway', 'Use anyway'], ["Replace this Place's reference", "Replace this Place's reference"], [null, 'the same button']] as const) {
    const r = rig()
    const landmark: Vec3 = { x: -0.4, y: 0, z: -2.2 }
    const heading: Vec3 = { x: 0.9, y: 0, z: -2.4 }
    const tapA = r.flow.touch(0.45, 0.62)
    const tapB = r.flow.touch(0.62, 0.7)
    const taskA = r.flow.begin('landmark', landmark, tapA)
    await taskA
    r.camera.pose = poseFrom(EYE, -35, -80)
    const out = await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: taskA, heading: r.flow.begin('headingMarker', heading, tapB) }, button)
    assert.equal(out.hold, `Point B is not in the camera view. Aim at it, then press ${expected} again. If a photo is still missing, the alignment is saved without reference photos.`)
  }
})

test('aiming at the missing point and pressing again gets its photo, keeps the other\'s, and holds nothing', async () => {
  const r = rig()
  const landmark: Vec3 = { x: -0.4, y: 0, z: -2.2 }
  const heading: Vec3 = { x: 0.9, y: 0, z: -2.4 }
  const tapA = r.flow.touch(0.45, 0.62)
  const tapB = r.flow.touch(0.62, 0.7)
  const taskA = r.flow.begin('landmark', landmark, tapA)
  await taskA
  r.camera.pose = poseFrom(EYE, -35, -80)
  const taskB1 = r.flow.begin('headingMarker', heading, tapB)
  const first = await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: taskA, heading: taskB1 })
  assert.ok(first.hold)
  const capturesAfterFirst = r.calls.capture

  // The phone is aimed at B again, not exactly where it was when B was tapped: 8 degrees to the right of it.
  r.camera.pose = poseFrom(EYE, -35, -8)
  const taskB2 = r.flow.begin('headingMarker', heading, tapB, taskB1)
  const second = await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: taskA, heading: taskB2 })
  assert.equal(second.hold, null)
  assert.ok(second.photos[0] && second.photos[1], 'both points have a photo now')
  const expected = threeView(heading, r.camera.pose, LENS)!
  near(second.photos[1]!.tapPoint.x, expected.x, 1e-9, 'B\'s crosshair is B, seen from where the phone is now')
  assert.equal(r.calls.capture - capturesAfterFirst, 1, 'only B was photographed again: A\'s good photo was kept')
})

test('a camera that gave no frame holds the commit with its own sentence, once', async () => {
  const r = rig()
  r.state.capture = 'reject'
  const tapA = r.flow.touch(0.45, 0.62)
  const tapB = r.flow.touch(0.62, 0.7)
  const landmark: Vec3 = { x: -0.4, y: 0, z: -2.2 }
  const heading: Vec3 = { x: 0.9, y: 0, z: -2.4 }
  const run = () => commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: r.flow.begin('landmark', landmark, tapA), heading: r.flow.begin('headingMarker', heading, tapB) })
  const first = await run()
  assert.match(first.hold!, /^The camera gave no photo of Points A and B\./)
  const second = await run()
  assert.equal(second.hold, null, 'told once')
})

test('a person who moves a marker after being told is told again if it is still missing: it is another situation', async () => {
  const r = rig()
  const tapA = r.flow.touch(0.45, 0.62)
  const tapB = r.flow.touch(0.62, 0.7)
  r.camera.pose = poseFrom(EYE, -35, -80)
  const landmark: Vec3 = { x: -0.4, y: 0, z: -2.2 }
  const heading: Vec3 = { x: 0.9, y: 0, z: -2.4 }
  const first = await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, { landmark: null, heading: null })
  assert.ok(first.hold)
  const moved = await commit(r, landmark, { ...heading, x: 1.2 }, { landmark: tapA, heading: tapB }, { landmark: null, heading: null })
  assert.ok(moved.hold, 'the heading marker is elsewhere: the earlier telling does not cover it')
})

test('a situation that is mended and then breaks again is told again', async () => {
  const r = rig()
  const tapA = r.flow.touch(0.45, 0.62)
  const tapB = r.flow.touch(0.62, 0.7)
  const landmark: Vec3 = { x: -0.4, y: 0, z: -2.2 }
  const heading: Vec3 = { x: 0.9, y: 0, z: -2.4 }
  r.camera.pose = poseFrom(EYE, -35, -80)
  const args = () => ({ landmark: r.flow.begin('landmark', landmark, tapA), heading: r.flow.begin('headingMarker', heading, tapB) })
  assert.ok((await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, args())).hold, 'out of view: told')
  r.camera.pose = poseFrom(EYE, -35, 0)
  assert.equal((await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, args())).hold, null, 'in view: nothing')
  r.camera.pose = poseFrom(EYE, -35, -80)
  assert.ok((await commit(r, landmark, heading, { landmark: tapA, heading: tapB }, args())).hold, 'out of view again: told again')
})

test('what the person was last told is read once: a hold is the situation since the last hold, not a running total', async () => {
  const r = rig()
  assert.equal(r.flow.holdText(), null, 'nothing settled, nothing to say')
  const tap = r.flow.touch(0.5, 0.5)
  await r.flow.settle({ role: 'landmark', task: null, marker: MARKER, tap })
  assert.equal(r.flow.holdText(), null, 'a good photo')
  assert.equal(r.flow.holdText(), null, 'and asking again says nothing')
})
