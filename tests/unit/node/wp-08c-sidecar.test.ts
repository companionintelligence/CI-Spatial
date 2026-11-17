/**
 * The generation of the Place's reference, in a scan's upload sidecar (WP-08): src/export/gltf.ts.
 *
 * A scan's calibration names the generation of the reference it was measured against (`ScanCalibration.frameId`). The exporter
 * already writes the whole calibration record into the sidecar, and the server reads the generation from it
 * (`calibrationFromMeta`, server/calibration_fields.ts). But the `splat-align` job later replaces that nested record with
 * another tier's, and a generation that lived only there would be lost to the editor, which would then read the scan as an
 * unknown generation and not as a previous reference. So the exporter writes it flat as well, beside the tier, where the job
 * leaves it.
 *
 * exportToGLB runs here under Node with the shims the other sidecar tests use (a FileReader, and an upload `fetch` that keeps
 * what it was sent).
 *
 * Run: npm run test:wave, or
 *      node --experimental-strip-types --no-warnings --test tests/unit/node/wp-08c-sidecar.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { calibrationFromMeta } from '../../../server/calibration_fields.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { ScanEntry } from '../../../src/project/project-store.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

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

let lastMetadata: Record<string, unknown> | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const metadata = (init?.body as FormData | undefined)?.get('metadata')
  if (typeof metadata === 'string') lastMetadata = JSON.parse(metadata) as Record<string, unknown>
  return new Response(JSON.stringify({ filename: 'stored.glb' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const pointCloud = {
  count: 2,
  toFloat32Array: () => new Float32Array([0, 0, 0, 0.1, 0.05, -0.1]),
  boundingBox: () => ({ min: { x: 0, y: 0, z: -0.1 }, max: { x: 0.1, y: 0.05, z: 0 } }),
  estimateFloorY: () => 0,
} as unknown as PointCloud

/** Exports one scan carrying `calibration`, and returns the sidecar it uploaded. */
async function sidecarFor(calibration: ScanCalibration | undefined): Promise<Record<string, unknown>> {
  const scanEntry: ScanEntry = { scanId: 'scan-1', projectId: 'place-1', sessionId: 'sess-08c', name: 'scan', status: 'draft', capturedAt: Date.now(), calibration }
  const store = { sessionId: 'sess-08c', detections: new Map(), currentRunDetections: () => new Map(), serverSessionOfThisRun: null } as unknown as DetectionStore
  lastMetadata = null
  await exportToGLB({ store, pointCloud, poseHistory: [], scanEntry }, { download: false, upload: true })
  assert.ok(lastMetadata, 'the export did not reach the upload path')
  return lastMetadata
}

const TWO_POINT = (extra: Record<string, unknown> = {}): ScanCalibration => ({
  method: 'two-point-ground',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  separationM: 3,
  residualM: 0.02,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: '2026-11-16T09:30:00.000Z',
  status: 'verified',
  ...extra,
}) as ScanCalibration

test('a calibration that names a generation writes it flat beside the tier, and in the whole record', async () => {
  const calibration = TWO_POINT({ frameId: 'frame-now' })
  const metadata = await sidecarFor(calibration)
  assert.equal(metadata['calibrationFrameId'], 'frame-now')
  assert.deepEqual(metadata['calibration'], calibration, 'the whole record carries it too')
  assert.equal(metadata['calibrationMethod'], 'two-point-ground', 'and what was there is unchanged')
})

test('a calibration that names none leaves the key off, so the sidecar of an unknown generation is what it always was', async () => {
  const metadata = await sidecarFor(TWO_POINT())
  assert.equal('calibrationFrameId' in metadata, false)
  const oneNone = await sidecarFor(undefined)
  assert.equal('calibrationFrameId' in oneNone, false)
  const onePoint = await sidecarFor({
    method: 'ground-tap-compass',
    sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    anchorBearingDeg: 40,
    calibratedAt: '2026-11-16T09:30:00.000Z',
    status: 'provisional',
  })
  assert.equal('calibrationFrameId' in onePoint, false, 'a one-point scan is not in a Place frame generation')
})

test('the server reads the generation from the flat key, and it survives the job that replaces the nested record', async () => {
  const metadata = await sidecarFor(TWO_POINT({ frameId: 'frame-now' }))
  assert.equal(calibrationFromMeta(metadata).calibrationFrameId, 'frame-now', 'as uploaded')

  // `splat-align` writes a known-distance record over the nested one and leaves the flat keys alone.
  const afterJob = { ...metadata, calibration: { method: 'known-distance', separationM: 3.2, residualM: 0.02, toleranceM: 0.1, gravityAligned: true } }
  assert.equal(calibrationFromMeta(afterJob).calibrationFrameId, 'frame-now', 'the editor still knows which reference the scan was placed by')

  // Without the flat key the same scan would read as an unknown generation: the case this guards.
  const { calibrationFrameId: _flat, ...withoutFlat } = metadata
  assert.equal(calibrationFromMeta({ ...withoutFlat, calibration: afterJob.calibration }).calibrationFrameId, undefined)
})

test('a sidecar a previous build wrote, with the generation only in the record or not at all, is read as before', async () => {
  const metadata = await sidecarFor(TWO_POINT({ frameId: 'frame-now' }))
  const { calibrationFrameId: _flat, ...recordOnly } = metadata
  assert.equal(calibrationFromMeta(recordOnly).calibrationFrameId, 'frame-now', 'the record is still read when there is no flat key')
  assert.equal('calibrationFrameId' in calibrationFromMeta((await sidecarFor(TWO_POINT())) as Record<string, unknown>), false, 'and a record with no id reads as unknown')
})
