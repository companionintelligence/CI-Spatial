/**
 * CAR5-2: the upload's sidecar describes the same boxes as the GLB, even when the store changes mid-export.
 *
 * exportToGLB builds the GLB's boxes from the store. GLTFExporter then yields to the event loop on its
 * binary path (FileReader), and only after that does uploadToServer write the sidecar. This test edits
 * the live store inside that yield: one label changed, one detection erased, one added. The GLB and the
 * sidecar must both still describe the store as it was when the export began.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-car5-sidecar-snapshot.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportToGLB } from '../../../src/export/gltf.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'

const SESSION_ID = 'sess-car5-snapshot'

// ─── Shims: exportToGLB runs in node with FileReader and an upload fetch ───

/** Runs once, at the yield inside GLTFExporter's binary path, after the GLB's boxes are built. */
let atYield: (() => void) | null = null

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null

  readAsArrayBuffer(blob: Blob): void {
    const hook = atYield
    atYield = null
    hook?.()
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

interface UploadMetadata {
  detectionCount?: number
  labels?: string[]
  detections?: Array<{ label: string; confidence: number | null; worldPos: { x: number; y: number; z: number } }>
}

/** What the last upload carried. The metadata is parsed the way the server parses it. */
let lastGlb: Uint8Array | null = null
let lastMetadata: UploadMetadata | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const body = init?.body as FormData | undefined
  const file = body?.get('file')
  if (file instanceof Blob) lastGlb = new Uint8Array(await file.arrayBuffer())
  const metadata = body?.get('metadata')
  if (typeof metadata === 'string') lastMetadata = JSON.parse(metadata) as UploadMetadata
  return new Response(JSON.stringify({ filename: 'stored.glb' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The last upload. Read through a function, so TypeScript does not narrow the variables to null. */
function lastUpload(): { glb: Uint8Array | null; metadata: UploadMetadata | null } {
  return { glb: lastGlb, metadata: lastMetadata }
}

// ─── Fixture ───────────────────────────────────────────────────────────────

function detection(label: string, x: number): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: 'a ' + label,
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x, y: 0, z: -1 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1787174311700,
    captureIndex: 2,
  } as WorldDetection
}

function pointCloudStub(count: number): PointCloud {
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i * 0.1
    positions[i * 3 + 1] = i * 0.05
    positions[i * 3 + 2] = -i * 0.1
  }
  return {
    count,
    toFloat32Array: () => positions,
    boundingBox: () => ({
      min: { x: 0, y: 0, z: -(count - 1) * 0.1 },
      max: { x: (count - 1) * 0.1, y: (count - 1) * 0.05, z: 0 },
    }),
    estimateFloorY: () => 0,
  } as unknown as PointCloud
}

function pose(z: number): Pose {
  return { position: { x: 0, y: 1.5, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } } as unknown as Pose
}

interface GlbNode {
  name?: string
  extras?: Record<string, unknown>
}

/** The detection nodes as the exporter wrote them into the GLB's JSON chunk. */
function glbDetectionNodes(glb: Uint8Array): GlbNode[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as { nodes?: GlbNode[] }
  return (json.nodes ?? []).filter((node) => node.extras?.['objectType'] === 'detection')
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('CAR5-2: an edit, an erase and an addition during the export leave the GLB and its sidecar on the same boxes', async () => {
  const detections = new Map<string, WorldDetection>([
    ['chair:0', detection('chair', 0)],
    ['lamp:1', detection('lamp', 1.5)],
    ['desk:2', detection('desk', 3)],
  ])
  // The exporter reads the run's detections, which here are all of them.
  const store = { sessionId: SESSION_ID, serverSessionOfThisRun: SESSION_ID, detections, currentRunDetections: () => detections } as unknown as DetectionStore

  let edited = false
  atYield = () => {
    const chair = detections.get('chair:0')
    if (chair) detections.set('chair:0', { ...chair, label: 'sofa' })
    detections.delete('lamp:1')
    detections.set('bed:3', detection('bed', 5))
    edited = true
  }

  lastGlb = null
  lastMetadata = null
  await exportToGLB(
    { store, pointCloud: pointCloudStub(24), poseHistory: [pose(0), pose(-0.5), pose(-1)] },
    { download: false, upload: true },
  )
  const { glb, metadata } = lastUpload()
  assert.ok(edited, 'the store was not changed during the export, so the test proves nothing')
  assert.ok(glb && metadata, 'the GLB and its metadata did not both reach the upload path')

  // The live store did change. A sidecar that read it after the yield would describe this, not the GLB.
  assert.deepEqual([...detections.values()].map((d) => d.label), ['sofa', 'desk', 'bed'])

  const boxes = glbDetectionNodes(glb)
  const boxLabels = boxes.map((node) => String(node.extras?.['label']))
  assert.deepEqual(boxLabels, ['chair', 'lamp', 'desk'], 'the GLB does not describe the store as the export began')
  assert.deepEqual(metadata.labels, ['chair', 'lamp', 'desk'], 'the sidecar labels differ from the GLB boxes')
  assert.deepEqual(
    metadata.detections?.map((d) => d.label),
    ['chair', 'lamp', 'desk'],
    'the sidecar detections differ from the GLB boxes',
  )
  assert.equal(metadata.detectionCount, 3, 'the sidecar counts a different number of detections than the GLB boxes')

  for (const box of boxes) {
    const label = String(box.extras?.['label'])
    const entry: { worldPos: unknown } | undefined = metadata.detections?.find((d) => d.label === label)
    assert.deepEqual(entry?.worldPos, box.extras?.['worldPos'], label + ' has a different position in the sidecar')
  }
})
