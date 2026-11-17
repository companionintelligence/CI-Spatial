/**
 * What the scan's epoch log keeps for a re-anchor (WP-09b, src/ar/frame-epoch.ts): the drift checks, which the sidecar
 * carries as `frameEpochs.closures`, and the calibration a new scan does not have.
 *
 * The sidecar is written by the real exporter (src/export/gltf.ts), as frame_epoch_sidecar.test.ts does, so what is
 * asserted is what the server will find in the file: `closures` when a check was made and no such key when none was, the
 * same record in the GLB's scene extras, a calibration epoch of `null` for a scan that has none, and a sidecar from before
 * any of this still reading as it always did.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-09b-epoch-log.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { FRAME_LOG_MAX, ScanFrameEpochLog } from '../../../src/ar/frame-epoch.ts'
import { closureRecord, type FrameClosureRecord } from '../../../src/ar/closure.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import { FakeProvider } from './support/reanchor-rig.ts'

// ─── Shims: exportToGLB runs in node with FileReader and an upload fetch ───

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = buf
        this.onloadend?.()
      },
      (err) => this.onerror?.(err),
    )
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader

let lastGlb: Uint8Array | null = null
let lastMetadata: Record<string, unknown> | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const body = init?.body as FormData | undefined
  const file = body?.get('file')
  if (file instanceof Blob) lastGlb = new Uint8Array(await file.arrayBuffer())
  const metadata = body?.get('metadata')
  if (typeof metadata === 'string') lastMetadata = JSON.parse(metadata) as Record<string, unknown>
  return new Response(JSON.stringify({ filename: 'stored.glb' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const store = { sessionId: 'sess-closures', detections: new Map(), currentRunDetections: () => new Map(), serverSessionOfThisRun: null } as unknown as DetectionStore

function cloud(): PointCloud {
  const count = 24
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i * 0.1
    positions[i * 3 + 1] = i * 0.05
    positions[i * 3 + 2] = -i * 0.1
  }
  return {
    count,
    toFloat32Array: () => positions,
    boundingBox: () => ({ min: { x: 0, y: 0, z: -2.3 }, max: { x: 2.3, y: 1.15, z: 0 } }),
    estimateFloorY: () => 0,
    epochCounts: () => [{ epoch: 0, count }],
    groundObjects: () => [],
  } as unknown as PointCloud
}

const pose: Pose = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

interface GlbJson {
  scenes?: Array<{ extras?: Record<string, unknown> }>
}

function sceneExtras(glb: Uint8Array): Record<string, unknown> {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GlbJson
  return json.scenes?.[0]?.extras ?? {}
}

const check = (over: Partial<FrameClosureRecord> = {}): FrameClosureRecord => ({
  ...closureRecord(
    { translationM: 0.2, dyM: 0.01, yawDeg: 5, baselineM: 3, points: 2 },
    { at: '2026-11-17T09:30:00.000Z', epoch: 0, pathLengthM: 12.5, taps: [{ source: 'burst', spreadM: 0.01, rangeM: 2.2 }] },
  ),
  ...over,
})

function attached(): { log: ScanFrameEpochLog; provider: FakeProvider } {
  const provider = new FakeProvider()
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  return { log, provider }
}

async function exported(log: ScanFrameEpochLog): Promise<{ sidecar: Record<string, unknown>; extras: Record<string, unknown> }> {
  lastGlb = null
  lastMetadata = null
  await exportToGLB(
    { store, pointCloud: cloud(), poseHistory: [pose], frameEpochs: log.snapshot(cloud()) },
    { download: false, upload: true, filenamePrefix: 'room-scan', autoSaved: false },
  )
  assert.ok(lastMetadata && lastGlb, 'the export uploaded a scan')
  return { sidecar: lastMetadata!, extras: sceneExtras(lastGlb!) }
}

// ─── The drift checks ───────────────────────────────────────────────────────

test('a drift check is written into the sidecar and the GLB extras as frameEpochs.closures, whole', async () => {
  const { log } = attached()
  log.noteCalibrated(0)
  const record = check()
  log.noteClosure(record)
  const { sidecar, extras } = await exported(log)
  const frameEpochs = sidecar['frameEpochs'] as { closures?: FrameClosureRecord[] }
  assert.deepEqual(frameEpochs.closures, [record], 'the sidecar the server stores')
  assert.deepEqual((extras['frameEpochs'] as { closures?: FrameClosureRecord[] }).closures, [record], 'and the file\'s own copy')
  assert.equal(frameEpochs.closures![0]!.translationM, 0.2)
  assert.equal(frameEpochs.closures![0]!.pathLengthM, 12.5)
  assert.equal(frameEpochs.closures![0]!.yawDeg, 5)
})

test('a scan with no drift check has no closures key: absent means nothing was asked, never "no drift"', async () => {
  const { log } = attached()
  log.noteCalibrated(0)
  const { sidecar } = await exported(log)
  assert.equal('closures' in (sidecar['frameEpochs'] as object), false)
})

test('the checks are kept in the order they were made, and a record the caller changes afterwards does not change the log', () => {
  const { log } = attached()
  const first = check({ translationM: 0.1 })
  log.noteClosure(first)
  log.noteClosure(check({ translationM: 0.3, exceeded: true }))
  first.translationM = 99
  first.taps[0]!.rangeM = 99
  assert.deepEqual(log.closures.map((c) => c.translationM), [0.1, 0.3])
  assert.equal(log.closures[0]!.taps[0]!.rangeM, 2.2)
  assert.equal(log.closureExceeded, true, 'any check over its limits')
  const snapshot = log.snapshot()
  snapshot.closures![0]!.translationM = 42
  assert.equal(log.closures[0]!.translationM, 0.1, 'nor does one that changes the snapshot')
})

test('only the most recent checks are kept, so a scan cannot grow its sidecar without limit', () => {
  const { log } = attached()
  for (let i = 0; i < FRAME_LOG_MAX + 10; i++) log.noteClosure(check({ translationM: i / 1000 }))
  assert.equal(log.closures.length, FRAME_LOG_MAX)
  assert.equal(log.closures[0]!.translationM, 10 / 1000, 'the oldest ten are the ones dropped')
  assert.equal(log.closures[FRAME_LOG_MAX - 1]!.translationM, (FRAME_LOG_MAX + 9) / 1000)
})

test('a new scan starts with no checks, and with the old one\'s gap no longer marking it', () => {
  const { log } = attached()
  log.noteClosure(check({ exceeded: true }))
  assert.equal(log.closureExceeded, true)
  log.reset()
  assert.deepEqual([...log.closures], [])
  assert.equal(log.closureExceeded, false)
  assert.equal(log.snapshot().closures, undefined)
})

// ─── The calibration a new scan does not have ───────────────────────────────

test('a scan that has forgotten its calibration says null in its sidecar, and is counted from its own start', async () => {
  const { log, provider } = attached()
  log.noteCalibrated(0)
  provider.discontinuity()
  provider.discontinuity()
  log.reset()
  assert.equal(log.frameShifts, 2, 'a Clear keeps the calibration, so the shifts since it still count')
  log.forgetCalibration()
  assert.equal(log.frameShifts, 0)
  assert.equal(log.calibrationEpoch, null)
  assert.equal(log.anchorEpoch, log.baseEpoch, 'the geometry is placed in the epoch the scan began in')
  const { sidecar } = await exported(log)
  assert.equal((sidecar['frameEpochs'] as { calibrationEpoch: unknown }).calibrationEpoch, null)
})

test('a scan begun after a re-anchor and calibrated in its own epoch counts shifts from there, not from the scan before', () => {
  const { log, provider } = attached()
  log.noteCalibrated(0)
  provider.discontinuity()
  assert.equal(log.frameShifts, 1)
  // What the page does at a re-anchor: the next scan begins in the epoch the runtime moved to, with no calibration until it has one.
  log.reset()
  log.forgetCalibration()
  assert.equal(log.frameShifts, 0)
  log.noteCalibrated(1)
  assert.equal(log.calibrationEpoch, 1)
  assert.equal(log.frameShifts, 0, 'calibrated in the epoch it began in: nothing has happened to it yet')
  provider.discontinuity()
  assert.equal(log.frameShifts, 1, 'only the shift since the calibration the scan has now')
})

test('the part of the sidecar that was there before is unchanged: the same keys in the same order, with nothing added when there is nothing to add', () => {
  const { log } = attached()
  log.noteCalibrated(0)
  assert.deepEqual(Object.keys(log.snapshot(cloud())), [
    'version', 'baseEpoch', 'calibrationEpoch', 'currentEpoch', 'floorEpoch', 'floorBasis', 'mixedEpochs', 'epochCount',
    'epochs', 'epochsOmitted', 'jumpCount', 'jumps', 'limitedMs', 'suppressedJumps', 'motion', 'thresholds',
  ])
  log.noteClosure(check())
  const keys = Object.keys(log.snapshot(cloud()))
  assert.deepEqual(keys.slice(-2), ['closures', 'thresholds'], 'the record goes in before the thresholds that explain it')
})
