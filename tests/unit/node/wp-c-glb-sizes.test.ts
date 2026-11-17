/**
 * WP-C / F58 and CAR-7: the GLB no longer carries made-up metric sizes for detections.
 *
 * The sizes were image fractions times fixed constants, written in metres with
 * no flag to say they were guesses. Removing the field does not hide the Size
 * row: the inspector measures the box itself and prints a row for every object.
 * The boxes that remain keep the node names the viewer's LOD ids are built from,
 * and are flagged as placeholders in their extras. The flag (dimensionsEstimated)
 * is what the Size-row guard reads.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-glb-sizes.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportToGLB } from '../../../src/export/gltf.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'

const SESSION_ID = 'sess-wpc-glb'

// ─── Shims: exportToGLB runs in node with FileReader and an upload fetch ───

let onFileReaderYield: (() => void) | null = null

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null

  readAsArrayBuffer(blob: Blob): void {
    onFileReaderYield?.()
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

let lastUploadedGlb: Uint8Array | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const body = init?.body as FormData | undefined
  const file = body?.get('file')
  if (file instanceof Blob) lastUploadedGlb = new Uint8Array(await file.arrayBuffer())
  return new Response(JSON.stringify({ filename: 'stored.glb' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

function detection(label: string, x: number, captureIndex: number): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x, y: 0, z: -1 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1787174311700,
    captureIndex,
  } as WorldDetection
}

function storeStub(detections: Array<[string, WorldDetection]>): DetectionStore {
  const live = new Map(detections)
  return { sessionId: SESSION_ID, serverSessionOfThisRun: SESSION_ID, detections: live, currentRunDetections: () => live } as unknown as DetectionStore
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

function glbJson(glb: Uint8Array): { nodes?: GlbNode[] } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
}

async function exportedDetectionNodes(): Promise<GlbNode[]> {
  lastUploadedGlb = null
  const result = await exportToGLB(
    {
      store: storeStub([
        ['chair:0', detection('chair', 0, 2)],
        ['lamp:1', detection('lamp', 1.5, 3)],
      ]),
      pointCloud: pointCloudStub(24),
      poseHistory: [pose(0), pose(-0.5), pose(-1)],
    },
    { download: false, upload: true },
  )
  assert.ok(result.size > 0, 'the exporter produced no bytes')
  assert.ok(lastUploadedGlb, 'no GLB reached the upload path')
  const json = glbJson(lastUploadedGlb)
  return (json.nodes ?? []).filter((n) => n.extras?.['objectType'] === 'detection')
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('F58: exported detection boxes carry no made-up dimensions', async () => {
  const nodes = await exportedDetectionNodes()
  assert.equal(nodes.length, 2, 'the two detections were not both exported')
  for (const node of nodes) {
    assert.equal('dimensions' in (node.extras ?? {}), false, `${node.name} still carries dimensions`)
  }
})

test('F58: the detection extras that are real observations are still written', async () => {
  const nodes = await exportedDetectionNodes()
  const chair = nodes.find((n) => n.extras?.['label'] === 'chair')
  assert.ok(chair, 'no chair node in the GLB')
  assert.deepEqual(chair.extras?.['bbox'], [0.1, 0.1, 0.4, 0.4])
  assert.equal(chair.extras?.['confidence'], 0.9)
})

test('CAR3-1: a placeholder box keeps its objectId and its node name in the safe-name format', async () => {
  const nodes = await exportedDetectionNodes()
  const chair = nodes.find((n) => n.extras?.['label'] === 'chair')
  const lamp = nodes.find((n) => n.extras?.['label'] === 'lamp')
  assert.ok(chair && lamp, 'the chair and lamp nodes were not both exported')
  // The viewer keys saved patches and hides on the LOD id, which is built from the node name,
  // so both keep the safe label, an underscore and the three-digit index.
  assert.equal(chair.extras?.['objectId'], 'chair_001')
  assert.equal(lamp.extras?.['objectId'], 'lamp_002')
  assert.equal(chair.name, 'chair_001')
  assert.equal(lamp.name, 'lamp_002')
})

test('CAR-7: every detection box is flagged as a placeholder, not a measurement', async () => {
  const nodes = await exportedDetectionNodes()
  assert.equal(nodes.length, 2, 'the two detections were not both exported')
  for (const node of nodes) {
    assert.match(node.name ?? '', /^(chair|lamp)_\d{3}$/, `${node.name} is not named in the safe-name format`)
    assert.equal(node.extras?.['dimensionsEstimated'], true, `${node.name} does not flag its size as estimated`)
    assert.equal(node.extras?.['dimensionsBasis'], 'placeholder', `${node.name} does not say its size is a placeholder`)
    assert.equal(node.extras?.['placeholder'], true, `${node.name} carries no placeholder marker`)
  }
})
