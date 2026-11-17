/**
 * WP-C / F51: each provider maps an image-normalised bbox centre into the
 * coordinates its own hit-test takes.
 *
 * 8th Wall's default `contain` fit puts the whole camera frame on the canvas,
 * and its hit-test takes canvas coordinates, so the point is unchanged. Under
 * `cover`, and for WebXR, the window cover-crop applies. Every provider used to
 * get the cover-crop, which put a portrait `contain` detection off the left edge.
 *
 * Known numbers: a 4:3 camera frame (640 x 480) on a 9:16 portrait window
 * (360 x 640) and on a 16:9 landscape window (1280 x 720).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-resolver-contract.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { imagePointToViewportPoint, resolveDetections } from '../../../src/spatial/resolver.ts'
import type { ARProvider, HitResult, Pose } from '../../../src/ar/provider.ts'
import type { RawDetection } from '../../../src/inference/prompt.ts'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { WebXRProvider } from '../../../src/ar/webxr.ts'

const FRAME = { width: 640, height: 480 }
const PORTRAIT = { width: 360, height: 640 }
const LANDSCAPE = { width: 1280, height: 720 }

/** The fit is read from the page URL when the provider is constructed. */
function eighthWall(search: string): EighthWallProvider {
  ;(globalThis as { window?: unknown }).window = { location: { search } }
  return new EighthWallProvider()
}

const HIT: HitResult = {
  position: { x: 1, y: 2, z: -3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  distance: 2,
}

const POSE: Pose = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
}

/** A detection whose bbox centre is (0.25, 0.5) in image coordinates. */
const detection: RawDetection = {
  label: 'chair',
  bbox: [0.1, 0.4, 0.4, 0.6],
  confidence: 0.9,
  description: 'a chair',
}

/** Records the point hitTest is asked for. Used as the provider's own hitTest. */
function recordingHitTest(seen: Array<{ x: number; y: number }>): (x: number, y: number) => HitResult | null {
  return (x, y) => {
    seen.push({ x, y })
    return HIT
  }
}

// ─── The provider contract, with known numbers ─────────────────────────────

test('8th Wall contain (default), portrait: the image point is unchanged', () => {
  const p = eighthWall('')
  assert.deepEqual(p.imagePointToHitTestPoint(0.25, 0.5, FRAME, PORTRAIT), { x: 0.25, y: 0.5 })
})

test('8th Wall contain, landscape: the image point is unchanged', () => {
  const p = eighthWall('')
  assert.deepEqual(p.imagePointToHitTestPoint(0.25, 0.25, FRAME, LANDSCAPE), { x: 0.25, y: 0.25 })
})

test('8th Wall cover (?camerafit=cover), portrait: the frame is cropped left and right', () => {
  // Scale 4/3: the frame is 853.3 px wide in a 360 px window, so 246.7 px is
  // cropped off each side. x = (0.25 x 853.3 - 246.7) / 360 = -33.3 / 360.
  const p = eighthWall('?camerafit=cover')
  const m = p.imagePointToHitTestPoint(0.25, 0.5, FRAME, PORTRAIT)
  assert.ok(Math.abs(m.x - -1 / 10.8) < 1e-9, `x was ${m.x}`)
  assert.ok(Math.abs(m.y - 0.5) < 1e-9, `y was ${m.y}`)
})

test('8th Wall cover, landscape: the frame is cropped top and bottom', () => {
  // Scale 2: the frame is 960 px tall in a 720 px window, so 120 px is cropped
  // off the top. y = (0.25 x 960 - 120) / 720 = 120 / 720.
  const p = eighthWall('?camerafit=cover')
  const m = p.imagePointToHitTestPoint(0.25, 0.25, FRAME, LANDSCAPE)
  assert.equal(m.x, 0.25)
  assert.ok(Math.abs(m.y - 1 / 6) < 1e-9, `y was ${m.y}`)
})

test('the centre of the frame stays at the centre under both fits', () => {
  assert.deepEqual(eighthWall('').imagePointToHitTestPoint(0.5, 0.5, FRAME, PORTRAIT), { x: 0.5, y: 0.5 })
  const cover = eighthWall('?camerafit=cover').imagePointToHitTestPoint(0.5, 0.5, FRAME, PORTRAIT)
  assert.ok(Math.abs(cover.x - 0.5) < 1e-9 && Math.abs(cover.y - 0.5) < 1e-9)
})

test('WebXR keeps the window cover-crop, which is what it used before', () => {
  const p = new WebXRProvider()
  const m = p.imagePointToHitTestPoint(0.25, 0.5, FRAME, PORTRAIT)
  assert.ok(Math.abs(m.x - -1 / 10.8) < 1e-9, `x was ${m.x}`)
  assert.ok(Math.abs(m.y - 0.5) < 1e-9, `y was ${m.y}`)
})

test('the cover-crop helper itself is unchanged for a 4:3 frame on a 9:16 window', () => {
  const m = imagePointToViewportPoint(0.25, 0.5, FRAME, PORTRAIT)
  assert.ok(Math.abs(m.x - -1 / 10.8) < 1e-9, `x was ${m.x}`)
})

// ─── What resolveDetections hands to the hit-test ──────────────────────────

test('resolveDetections, 8th Wall contain, portrait: hitTest gets the unchanged point', async () => {
  const seen: Array<{ x: number; y: number }> = []
  const p = eighthWall('')
  p.hitTest = recordingHitTest(seen)
  const results = await resolveDetections([detection], 1000, {
    provider: p,
    imageSize: FRAME,
    viewportSize: PORTRAIT,
  })
  assert.equal(seen.length, 1)
  assert.ok(Math.abs(seen[0].x - 0.25) < 1e-9 && Math.abs(seen[0].y - 0.5) < 1e-9, JSON.stringify(seen[0]))
  assert.deepEqual(results[0].worldPos, HIT.position)
})

test('resolveDetections, 8th Wall cover, portrait: hitTest gets the cropped point', async () => {
  const seen: Array<{ x: number; y: number }> = []
  const p = eighthWall('?camerafit=cover')
  p.hitTest = recordingHitTest(seen)
  await resolveDetections([detection], 1000, { provider: p, imageSize: FRAME, viewportSize: PORTRAIT })
  assert.ok(Math.abs(seen[0].x - -1 / 10.8) < 1e-9, `x was ${seen[0].x}`)
  assert.ok(Math.abs(seen[0].y - 0.5) < 1e-9, `y was ${seen[0].y}`)
})

test('resolveDetections, a provider with no contract keeps the window cover-crop', async () => {
  const seen: Array<{ x: number; y: number }> = []
  const bare: ARProvider = {
    start: () => Promise.resolve(),
    stop: () => {},
    captureFrame: () => Promise.reject(new Error('not used')),
    hitTest: recordingHitTest(seen),
    featurePoints: () => [],
    getPose: () => POSE,
    isTracking: () => true,
    trackingStatus: () => 'UNKNOWN',
    getCameraFovY: () => 60,
    getCameraAspect: () => 1,
  } as unknown as ARProvider
  await resolveDetections([detection], 1000, { provider: bare, imageSize: FRAME, viewportSize: PORTRAIT })
  assert.ok(Math.abs(seen[0].x - -1 / 10.8) < 1e-9, `x was ${seen[0].x}`)
})

test('resolveDetections, 8th Wall contain: the capture-camera ray uses image-normalised NDC', async () => {
  // No hit-test result, so the bbox-ray fallback runs. The camera is built for the
  // 4:3 camera frame, as main.ts builds it under contain, so NDC x = 2 x 0.25 - 1 = -0.5.
  const p = eighthWall('')
  p.hitTest = () => null
  const camera = new THREE.PerspectiveCamera(60, FRAME.width / FRAME.height, 0.01, 1000)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  const results = await resolveDetections([detection], 1000, {
    provider: p,
    imageSize: FRAME,
    viewportSize: PORTRAIT,
    captureCamera: camera,
  })
  // Expected: the ray through NDC (-0.5, 0), taken 2 m out along its direction.
  const t = Math.tan(THREE.MathUtils.degToRad(60) / 2)
  const dirX = -0.5 * (FRAME.width / FRAME.height) * t
  const expectedX = (2 * dirX) / Math.hypot(dirX, 1)
  assert.equal(results.length, 1)
  assert.ok(Math.abs(results[0].worldPos.x - expectedX) < 1e-6, `x was ${results[0].worldPos.x}, expected ${expectedX}`)
  assert.ok(Math.abs(results[0].worldPos.y) < 1e-9, `y was ${results[0].worldPos.y}`)
})
