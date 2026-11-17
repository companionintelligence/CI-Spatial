/**
 * The upload sidecar and the GLB extras carry which stretches of tracking a scan was
 * recorded in (WP-09, `frameEpochs`), and the exporter draws the floor of the right one.
 *
 * Old callers pass no `frameEpochs`. The sidecar then says `null`, which means "not
 * recorded" and never "no shifts", every key it always had is still there, and the floor is
 * fitted as it always was. That, and the shape of a record that is passed, is what the
 * server, which reads sidecars by key and ignores keys it does not know, relies on.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/frame_epoch_sidecar.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { FRAME_EPOCH_ADOPTED, ScanFrameEpochLog, type FrameDiscontinuity, type FrameEpochSource, type FrameEpochsSidecar } from '../../../src/ar/frame-epoch.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { ScanQualitySummary } from '../../../src/world/types.ts'

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
  return new Response(JSON.stringify({ filename: 'stored.glb' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Fixture ───────────────────────────────────────────────────────────────

// The run-scoped parts the export reads (WP-02): this run's detections, and the server session this run opened.
const store = { sessionId: 'sess-frame-epochs', detections: new Map(), currentRunDetections: () => new Map(), serverSessionOfThisRun: null } as unknown as DetectionStore

/** A cloud whose floor fit is whatever `floorFor(epoch)` says, and which records what it was asked. */
function cloud(floorFor: (epoch: number | undefined) => number): { cloud: PointCloud; asked: Array<number | undefined> } {
  const asked: Array<number | undefined> = []
  const count = 24
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i * 0.1
    positions[i * 3 + 1] = i * 0.05
    positions[i * 3 + 2] = -i * 0.1
  }
  return {
    asked,
    cloud: {
      count,
      toFloat32Array: () => positions,
      boundingBox: () => ({ min: { x: 0, y: 0, z: -2.3 }, max: { x: 2.3, y: 1.15, z: 0 } }),
      estimateFloorY: (epoch?: number) => {
        asked.push(epoch)
        return floorFor(epoch)
      },
    } as unknown as PointCloud,
  }
}

const pose: Pose = { position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }

const RECORD: FrameEpochsSidecar = {
  version: 1,
  baseEpoch: 0,
  calibrationEpoch: 0,
  currentEpoch: 2,
  floorEpoch: 1,
  floorBasis: 'locked',
  mixedEpochs: true,
  epochCount: 3,
  epochsOmitted: 0,
  epochs: [
    { epoch: 0, cause: 'start', startedAt: '2026-11-16T10:00:00.000Z', pointCount: 0, ground: null },
    {
      epoch: 1,
      cause: 'jump',
      startedAt: '2026-11-16T10:01:00.000Z',
      pointCount: 300,
      ground: { y: -0.37, epoch: 1, normal: { x: 0, y: 1, z: 0 }, locked: true, sampleCount: 300, inlierCount: 280, residualM: 0.004, fallback: false },
    },
    { epoch: 2, cause: 'recovered', startedAt: '2026-11-16T10:02:00.000Z', pointCount: 40, ground: null },
  ],
  jumpCount: 2,
  jumps: [
    { epoch: 1, cause: 'jump', atMs: 61_000, at: '2026-11-16T10:01:00.000Z', translationM: 0.42, yawDeg: 1.5, speedMps: 12.6 },
    { epoch: 2, cause: 'recovered', atMs: 122_000, at: '2026-11-16T10:02:00.000Z', degradedMs: 2500, reason: 'RELOCALIZING' },
  ],
  limitedMs: 2500,
  suppressedJumps: 0,
  motion: null,
  thresholds: { ...FRAME_EPOCH_ADOPTED, basis: 'adopted, not measured' },
}

interface GlbJson {
  scenes?: Array<{ extras?: Record<string, unknown> }>
  nodes?: Array<{ name?: string; extras?: Record<string, unknown> }>
}

/** The GLB's JSON chunk, the way the viewer and the server's optimize pass read it. */
function glbJson(glb: Uint8Array): GlbJson {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GlbJson
}

async function exportWith(
  extra: { frameEpochs?: FrameEpochsSidecar; qualitySummary?: ScanQualitySummary },
  floorFor: (epoch: number | undefined) => number = () => 0.11,
  realCloud?: PointCloud,
): Promise<{ metadata: Record<string, unknown>; json: GlbJson; asked: Array<number | undefined> }> {
  lastGlb = null
  lastMetadata = null
  const c = cloud(floorFor)
  await exportToGLB(
    { store, pointCloud: realCloud ?? c.cloud, poseHistory: [pose, pose], ...extra },
    { download: false, upload: true },
  )
  assert.ok(lastGlb && lastMetadata, 'the upload did not carry a GLB and its metadata')
  return { metadata: lastMetadata, json: glbJson(lastGlb), asked: c.asked }
}

/** Every key the sidecar had before WP-09 added `frameEpochs`. */
const KEYS_BEFORE = [
  'detectionCount', 'labels', 'detections', 'exportedAt', 'capturedAt', 'sessionId', 'scanName',
  'projectId', 'areaId', 'floorId', 'roomId', 'projectTransform', 'calibrationMethod',
  'calibrationStatus', 'calibration', 'autoSaved', 'pointCount', 'poseCount', 'qualityStatus',
  'qualityCoverageScore', 'qualityMissingAreas', 'qualityLowLightFrames', 'qualityDriftEvents',
  'qualityReflectiveWarnings', 'qualityRecommendations', 'qualitySummary', 'geoLat', 'geoLng',
  'geoAltitudeM', 'geoAccuracy', 'geoBearing', 'geoAddress', 'geoDisplayAddress', 'geoFixedAt',
]

// ─── An old caller ─────────────────────────────────────────────────────────

test('a caller that passes no frameEpochs gets null in the sidecar and the GLB extras, never "no shifts"', async () => {
  const { metadata, json } = await exportWith({})
  assert.equal(metadata['frameEpochs'], null)
  assert.equal(json.scenes?.[0].extras?.['frameEpochs'], null)
})

test('every key the sidecar had before is still there, and the only new ones are frameEpochs and the unit', async () => {
  const { metadata } = await exportWith({})
  for (const key of KEYS_BEFORE) assert.ok(key in metadata, `the sidecar lost ${key}`)
  // scaleMode and scaleKind arrive with the units package (WP-06a), beside frameEpochs.
  assert.deepEqual(Object.keys(metadata).filter((k) => !KEYS_BEFORE.includes(k)).sort(), ['frameEpochs', 'scaleKind', 'scaleMode'])
})

test('with no frameEpochs the floor is fitted over every point, as it always was', async () => {
  const { json, asked } = await exportWith({}, () => 0.11)
  assert.deepEqual(asked, [undefined])
  const floor = json.nodes?.find((n) => n.name === 'floor-plane')
  assert.equal(floor?.extras?.['y'], 0.11)
  assert.equal(json.scenes?.[0].extras?.['floorY'], 0.11)
})

// ─── A record ──────────────────────────────────────────────────────────────

test('a frameEpochs record is written to the sidecar and the GLB extras unchanged', async () => {
  const { metadata, json } = await exportWith({ frameEpochs: RECORD })
  assert.deepEqual(metadata['frameEpochs'], RECORD)
  assert.deepEqual(json.scenes?.[0].extras?.['frameEpochs'], RECORD)
})

test('the floor drawn is the ground object kept for the epoch the record chose', async () => {
  const { json, asked } = await exportWith({ frameEpochs: RECORD }, () => 99)
  const floor = json.nodes?.find((n) => n.name === 'floor-plane')
  assert.equal(floor?.extras?.['y'], -0.37, 'the kept floor of epoch 1')
  assert.equal(json.scenes?.[0].extras?.['floorY'], -0.37)
  assert.deepEqual(asked, [], 'a floor that was kept is not fitted again')
})

test('with no ground object for that epoch, the floor is fitted over that epoch\'s points only', async () => {
  const noGround: FrameEpochsSidecar = {
    ...RECORD,
    floorEpoch: 1,
    epochs: RECORD.epochs.map((e) => (e.epoch === 1 ? { ...e, ground: null } : e)),
  }
  const { json, asked } = await exportWith({ frameEpochs: noGround }, (epoch) => (epoch === 1 ? 0.25 : -9))
  assert.deepEqual(asked, [1])
  assert.equal(json.nodes?.find((n) => n.name === 'floor-plane')?.extras?.['y'], 0.25)
})

test('a record of an empty cloud (no floor epoch) leaves the floor fitted over every point', async () => {
  const empty: FrameEpochsSidecar = { ...RECORD, floorEpoch: null, mixedEpochs: false }
  const { asked } = await exportWith({ frameEpochs: empty })
  assert.deepEqual(asked, [undefined])
})

test('the record survives the JSON it is sent in: nothing in it is undefined', async () => {
  const { metadata } = await exportWith({ frameEpochs: RECORD })
  assert.deepEqual(JSON.parse(JSON.stringify(metadata['frameEpochs'])), RECORD)
})

// ─── The quality summary alongside it ──────────────────────────────────────

test('the quality summary\'s new counts ride in the embedded summary, and the flat drift key is the same number', async () => {
  const summary: ScanQualitySummary = {
    coverageScore: 0.9,
    coverageText: 'Excellent',
    pointCount: 1600,
    detectionCount: 0,
    poseCount: 2,
    keyframeCount: 5,
    lowLightFrames: 0,
    driftEvents: 3,
    fastMotionEvents: 3,
    frameShifts: 2,
    limitedMs: 2500,
    reflectiveWarnings: 0,
    missingAreas: 0,
    trackingLost: false,
    status: 'needs-review',
    recommendations: ['Tracking was interrupted: parts may be shifted'],
    capturedAt: '2026-11-16T10:03:00.000Z',
  }
  const { metadata } = await exportWith({ qualitySummary: summary, frameEpochs: RECORD })
  assert.deepEqual(metadata['qualitySummary'], summary)
  assert.equal(metadata['qualityStatus'], 'needs-review')
  assert.equal(metadata['qualityDriftEvents'], 3, 'the key the server reads is unchanged')
})

// ─── A real cloud and a real log: which floor the GLB gets ─────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Points on the floor (`floorShare` of them) and on four walls, as a phone sweeping a 6 x 5 m room sees them. */
function room(rand: () => number, n: number, floorY: number, floorShare = 0.3): Array<{ x: number; y: number; z: number }> {
  const pts: Array<{ x: number; y: number; z: number }> = []
  for (let i = 0; i < n; i++) {
    if (rand() < floorShare) {
      pts.push({ x: rand() * 6, y: floorY + (rand() - 0.5) * 0.03, z: rand() * 5 })
    } else {
      const h = floorY + 0.4 + rand() * 2.2
      const wall = Math.floor(rand() * 4)
      pts.push(wall === 0 ? { x: 0, y: h, z: rand() * 5 } : wall === 1 ? { x: 6, y: h, z: rand() * 5 } : wall === 2 ? { x: rand() * 6, y: h, z: 0 } : { x: rand() * 6, y: h, z: 5 })
    }
  }
  return pts
}

/** A provider-shaped source whose epoch the test moves, firing the event the way the tracker does. */
function movingSource(): FrameEpochSource & { bump(cause?: FrameDiscontinuity['cause']): void } {
  const listeners = new Set<(e: FrameDiscontinuity) => void>()
  let epoch = 0
  return {
    getFrameEpoch: () => epoch,
    onFrameDiscontinuity(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    bump(cause = 'recovered') {
      epoch++
      for (const l of listeners) l({ epoch, cause, atMs: epoch * 1_000 })
    },
  }
}

async function scanThat(firstEpochPoints: number, wallsOnly: boolean): Promise<{ floorY: number; record: FrameEpochsSidecar; cloud: PointCloud }> {
  const rand = rng(11)
  const source = movingSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  let clock = 0
  const cloudUnderTest = new PointCloud(0.05, () => clock)
  if (firstEpochPoints > 0) cloudUnderTest.add(room(rand, firstEpochPoints, 0, wallsOnly ? 0 : 0.3), 0)
  clock += 600
  source.bump()
  for (let i = 0; i < 160; i++) {
    cloudUnderTest.add(room(rand, 40, 0), 1)
    clock += 600
  }
  const record = log.snapshot(cloudUnderTest)
  const { json } = await exportWith({ frameEpochs: record }, () => 99, cloudUnderTest)
  const floorY = json.nodes?.find((n) => n.name === 'floor-plane')?.extras?.['y'] as number
  return { floorY, record, cloud: cloudUnderTest }
}

test('a scan whose first stretch of tracking saw only a few points of wall draws the floor of the stretch that holds the room', async () => {
  // Epoch 0 is 40 wall points (too few to fit any floor); a suspect recovery starts epoch 1, which holds the room.
  // Taking the floor from the earliest epoch, whatever it held, drew it 0.50 m up, at head height.
  const { floorY, record } = await scanThat(40, true)
  assert.equal(record.floorEpoch, 1)
  assert.equal(record.floorBasis, 'locked')
  assert.ok(Math.abs(floorY) < 0.02, `the floor was drawn at ${floorY}`)
})

test('the same when the first stretch had enough wall points to fit a floor that is not one', async () => {
  const { floorY, record } = await scanThat(120, true)
  assert.equal(record.floorEpoch, 1)
  assert.ok(Math.abs(floorY) < 0.02, `the floor was drawn at ${floorY}`)
})

test('a scan that is all one epoch draws the floor it always did', async () => {
  const { floorY, record } = await scanThat(0, false)
  assert.equal(record.mixedEpochs, false)
  assert.ok(Math.abs(floorY) < 0.02)
})

test('a first stretch that saw the floor well is the floor drawn: the calibration\'s frame is preferred when it can be trusted', async () => {
  const rand = rng(5)
  const source = movingSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  let clock = 0
  const c = new PointCloud(0.05, () => clock)
  for (let i = 0; i < 100; i++) {
    c.add(room(rand, 40, 0), 0)
    clock += 600
  }
  log.noteCalibrated()
  source.bump()
  // After the shift the engine's frame has the same floor 0.30 m higher, and more points are seen in it.
  for (let i = 0; i < 160; i++) {
    c.add(room(rand, 40, 0.3), 1)
    clock += 600
  }
  const record = log.snapshot(c)
  assert.equal(record.floorEpoch, 0, 'the frame the Place was measured in')
  assert.equal(record.calibrationEpoch, 0)
  const { json } = await exportWith({ frameEpochs: record }, () => 99, c)
  const floorY = json.nodes?.find((n) => n.name === 'floor-plane')?.extras?.['y'] as number
  assert.ok(Math.abs(floorY) < 0.02, `the calibration's frame has the floor at 0, and the GLB drew ${floorY}`)
})

test('the sidecar of a scan that was calibrated before a shift and cleared after it says both epochs', async () => {
  const source = movingSource()
  const log = new ScanFrameEpochLog()
  log.attach(source)
  log.noteCalibrated()
  source.bump()
  log.reset()
  const { metadata } = await exportWith({ frameEpochs: log.snapshot() })
  const record = metadata['frameEpochs'] as FrameEpochsSidecar
  assert.equal(record.calibrationEpoch, 0)
  assert.equal(record.baseEpoch, 1)
  assert.equal(record.currentEpoch, 1)
})
