/**
 * WP-C / F63, CAR-1 and CAR-2: the camera verdict follows the engine's reason.
 *
 * A `failed` camera status may carry a reason (the documentation of onCameraStatusChange names
 * none, https://8thwall.org/docs/api/engine/camerapipelinemodule/oncamerastatuschange; this
 * app reads one if the engine supplies it). Only DENY_CAMERA is a permission
 * problem, and only it gets the permission copy and the upload route. NO_CAMERA
 * and UNSPECIFIED get honest copy that makes no permission claim. A camera that
 * is still being asked for may have its prompt open, so after the bound it gets
 * neutral waiting copy and never the blocked verdict.
 *
 * The diagnostics pipeline module that start() registers is the one that hears
 * `onCameraStatusChange`. The XR8 stub captures that module and stops start()
 * right after, so the real closure runs.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-camera-verdict.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import type { PreflightVerdict } from '../../../src/ar/preflight.ts'

const CAMERA_BLOCKED = 'Camera access is blocked'
const CAMERA_WAITING = 'Waiting for camera permission'
const NO_CAMERA = 'No camera found'
const DID_NOT_START = 'Camera did not start'

/** Any wording that claims a permission state. Used on the non-permission verdicts. */
const PERMISSION_CLAIM = /permission|blocked|allow|denied|refused|not granted/i

// ─── Browser globals the provider reads ────────────────────────────────────

;(globalThis as { window?: unknown }).window = {
  location: { search: '' },
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
}
;(globalThis as { document?: unknown }).document = {
  visibilityState: 'visible',
  querySelector: () => null,
  addEventListener(): void {},
}

interface PipelineModule {
  name: string
  onCameraStatusChange?: (event: { status: string; reason?: string }) => void
}

let captured: PipelineModule[] = []
;(globalThis as { XR8?: unknown }).XR8 = {
  loadChunk: async () => {},
  addCameraPipelineModules(modules: PipelineModule[]): void {
    captured = modules
    // Stop start() here. The modules are all the camera-status tests need.
    throw new Error('stop after capture')
  },
  GlTextureRenderer: { pipelineModule: () => ({ name: 'gl' }) },
  Threejs: {
    pipelineModule: () => ({ name: 'three' }),
    xrScene: () => ({ scene: {}, camera: {}, renderer: {} }),
  },
  XrController: { pipelineModule: () => ({ name: 'xr' }) },
  CameraPixelArray: { pipelineModule: () => ({ name: 'pixels' }) },
  stop(): void {},
  run(): void {},
}

async function startedProvider(): Promise<{
  provider: EighthWallProvider
  verdicts: PreflightVerdict[]
  emitStatus: (status: string, reason?: string) => void
}> {
  const provider = new EighthWallProvider()
  const verdicts: PreflightVerdict[] = []
  provider.onPreflightVerdict((v) => verdicts.push(v))
  await provider.start({ width: 360, height: 640 } as unknown as HTMLCanvasElement).catch(() => undefined)
  const diag = captured.find((m) => m.name === 'ci-scan-diagnostics')
  assert.ok(diag?.onCameraStatusChange, 'the diagnostics module was not registered')
  const onStatus = diag.onCameraStatusChange
  return { provider, verdicts, emitStatus: (status, reason) => onStatus({ status, reason }) }
}

const blocked = (verdicts: PreflightVerdict[]): PreflightVerdict[] =>
  verdicts.filter((v) => v.headline === CAMERA_BLOCKED)

// ─── A refused permission (DENY_CAMERA) ────────────────────────────────────

test('F63: a camera refused for permission gives the permission verdict, unavailable', async () => {
  const { verdicts, emitStatus } = await startedProvider()
  emitStatus('failed', 'DENY_CAMERA')
  assert.equal(verdicts.length, 1)
  assert.equal(verdicts[0].outcome, 'unavailable')
  assert.equal(verdicts[0].headline, CAMERA_BLOCKED)
  assert.equal(verdicts[0].canScan, false)
  assert.equal(verdicts[0].routeToUpload, true)
  assert.doesNotMatch(verdicts[0].detail, /lens|covered/i)
})

// ─── Failures that are not a permission problem (CAR-1) ────────────────────

test('CAR-1: a camera with no device gives a non-permission verdict and no upload route', async () => {
  const { verdicts, emitStatus } = await startedProvider()
  emitStatus('failed', 'NO_CAMERA')
  assert.equal(verdicts.length, 1)
  const [v] = verdicts
  assert.equal(v.headline, NO_CAMERA)
  assert.equal(v.outcome, 'unavailable')
  assert.equal(v.canScan, false)
  assert.equal(v.routeToUpload, false)
  assert.doesNotMatch(`${v.headline} ${v.detail}`, PERMISSION_CLAIM)
  assert.equal(blocked(verdicts).length, 0)
})

test('CAR-1: a camera that fails for an unclassified reason makes no permission claim', async () => {
  const { verdicts, emitStatus } = await startedProvider()
  emitStatus('failed', 'UNSPECIFIED')
  assert.equal(verdicts.length, 1)
  const [v] = verdicts
  assert.equal(v.headline, DID_NOT_START)
  assert.equal(v.routeToUpload, false)
  assert.doesNotMatch(`${v.headline} ${v.detail}`, PERMISSION_CLAIM)
  assert.equal(blocked(verdicts).length, 0)
})

test('CAR-1: a failure with no reason is treated as unclassified, never as a denial', async () => {
  const { verdicts, emitStatus } = await startedProvider()
  emitStatus('failed')
  assert.equal(verdicts.length, 1)
  assert.equal(verdicts[0].headline, DID_NOT_START)
  assert.equal(verdicts[0].routeToUpload, false)
  assert.equal(blocked(verdicts).length, 0)
})

// ─── A prompt that is still open (CAR-2) ───────────────────────────────────

test('CAR-2: a prompt nobody answers gets neutral waiting copy after 10 s, never the blocked verdict', async (t) => {
  const { verdicts, emitStatus } = await startedProvider()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  emitStatus('requesting')
  t.mock.timers.tick(9_999)
  assert.equal(verdicts.length, 0, 'the verdict arrived before the bound')
  t.mock.timers.tick(1)
  assert.equal(verdicts.length, 1)
  const [v] = verdicts
  assert.equal(v.headline, CAMERA_WAITING)
  assert.equal(v.outcome, 'warming-up', 'a prompt that may still be open is not a dead end')
  assert.equal(v.routeToUpload, false)
  assert.equal(blocked(verdicts).length, 0)
})

test('CAR-2: a prompt answered inside the bound gives no waiting or blocked verdict', async (t) => {
  const { verdicts, emitStatus } = await startedProvider()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  emitStatus('requesting')
  t.mock.timers.tick(4_000)
  emitStatus('hasStream')
  t.mock.timers.tick(60_000)
  assert.equal(blocked(verdicts).length, 0)
  assert.equal(verdicts.filter((v) => v.headline === CAMERA_WAITING).length, 0)
})

test('F63: repeated requesting does not restart the bound', async (t) => {
  const { verdicts, emitStatus } = await startedProvider()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  emitStatus('requesting')
  t.mock.timers.tick(6_000)
  emitStatus('requesting')
  t.mock.timers.tick(4_000)
  assert.equal(verdicts.length, 1, 'the bound was measured from the second requesting')
  assert.equal(verdicts[0].headline, CAMERA_WAITING)
})

test('CAR-1: a refusal after the waiting verdict replaces it with the permission verdict', async (t) => {
  const { verdicts, emitStatus } = await startedProvider()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  emitStatus('requesting')
  t.mock.timers.tick(10_000)
  emitStatus('failed', 'DENY_CAMERA')
  assert.deepEqual(verdicts.map((v) => v.headline), [CAMERA_WAITING, CAMERA_BLOCKED])
  assert.equal(verdicts[1].routeToUpload, true)
})

test('F63: stop() cancels a pending camera-prompt verdict', async (t) => {
  const { provider, verdicts, emitStatus } = await startedProvider()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  emitStatus('requesting')
  provider.stop()
  t.mock.timers.tick(60_000)
  assert.equal(verdicts.length, 0)
})
