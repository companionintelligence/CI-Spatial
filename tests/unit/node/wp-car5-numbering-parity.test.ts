/**
 * CAR5-1: the exporter numbers the boxes the server numbers, including when it skips entries.
 *
 * The server numbers a detection box by its place among the entries that survive detectionsFromMeta
 * (server/main.ts): it drops an empty label and a position that is not a number. The exporter must
 * drop the same entries, or every box after one of them gets an LOD id one index too low, and saved
 * edits and hides stop matching. Each kind of skipped entry sits before real boxes in the fixture, so
 * a numbering that counted it would show. A whitespace-only label is kept on both sides, because
 * neither side trims.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-car5-numbering-parity.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { collectDetections } from '../../../src/viewer/detections.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'

const SESSION_ID = 'sess-car5-numbering'

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

interface Position {
  x: number
  y: number
  z: number
}

interface UploadMetadata {
  detectionCount?: number
  labels?: string[]
  detections?: Array<{ label: string; confidence: number | null; worldPos: Position }>
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

// ─── Fixture ───────────────────────────────────────────────────────────────

function detection(label: string, x: number, y = 0): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: 'a ' + label,
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x, y, z: -1 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1787174311700,
    captureIndex: 2,
  } as WorldDetection
}

/**
 * Store order. The blank label and the lamp (its position is not finite) are skipped, so the boxes
 * after them must take the numbers the server gives them. The whitespace-only label is kept.
 */
const DETECTIONS: Array<[string, WorldDetection]> = [
  ['chair:0', detection('chair', 0)],
  ['blank:1', detection('', 1)],
  ['coffee table:2', detection('coffee table', 2)],
  ['spaces:3', detection('   ', 3)],
  ['lamp:4', detection('lamp', 4, Number.NaN)],
  ['desk:5', detection('desk', 5)],
]

/** The node name each kept box gets, by label: the numbers the server rule gives them. */
const EXPECTED_NAMES: Record<string, string> = {
  chair: 'chair_001',
  'coffee table': 'coffee_table_002',
  '   ': 'Object_003',
  desk: 'desk_004',
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

async function exportFixture(): Promise<{ glb: Uint8Array; metadata: UploadMetadata }> {
  lastGlb = null
  lastMetadata = null
  await exportToGLB(
    {
      store: { sessionId: SESSION_ID, serverSessionOfThisRun: SESSION_ID, currentRunDetections: () => new Map(DETECTIONS) } as unknown as DetectionStore,
      pointCloud: pointCloudStub(24),
      poseHistory: [pose(0), pose(-0.5), pose(-1)],
    },
    { download: false, upload: true },
  )
  const glb = lastGlb
  const metadata = lastMetadata
  assert.ok(glb && metadata, 'the GLB and its metadata did not both reach the upload path')
  return { glb, metadata }
}

// ─── The three readers ─────────────────────────────────────────────────────

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

/** Node names keyed by label, as the GLB writes them. */
function namesByLabel(nodes: GlbNode[]): Record<string, string | undefined> {
  return Object.fromEntries(nodes.map((node) => [String(node.extras?.['label']), node.name]))
}

/**
 * The server's naming, copied from detectionsFromMeta and detectionLikesForWorld in server/main.ts.
 * The CAR5-3 tests in wp-car4-lod-ids.test.ts tie this copy to the source text.
 */
function serverNamesByLabel(metadata: UploadMetadata): Record<string, string> {
  const kept = (metadata.detections ?? []).filter((d) => {
    const pos = d.worldPos as Partial<Position> | null
    return Boolean(d.label) && Boolean(pos) &&
      typeof pos?.x === 'number' && typeof pos?.y === 'number' && typeof pos?.z === 'number'
  })
  return Object.fromEntries(kept.map((d, index) => {
    const safeName = d.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'
    return [d.label, safeName + '_' + String(index + 1).padStart(3, '0')]
  }))
}

/** The scene the viewer works from: the GLB loaded the way the viewer loads it. */
async function loadViewerScene(glb: Uint8Array): Promise<Object3D> {
  const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer
  return new Promise<Object3D>((resolve, reject) => {
    new GLTFLoader().parse(bytes, '', (gltf) => resolve(gltf.scene), reject)
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('CAR5-1: the GLB boxes the entries the server keeps, and the skipped entries take no number', async () => {
  const { glb } = await exportFixture()
  assert.deepEqual(
    namesByLabel(glbDetectionNodes(glb)),
    EXPECTED_NAMES,
    'the GLB numbers a skipped entry, or numbers a kept box differently from the server',
  )

  // The viewer finds the same boxes in the GLB, through the helper it uses.
  const boxes = collectDetections(await loadViewerScene(glb))
  assert.deepEqual(
    boxes.map(({ node }) => node.name).sort(),
    Object.values(EXPECTED_NAMES).sort(),
    'the viewer finds different boxes from the GLB',
  )
})

test('CAR5-1: the upload lists the same boxes, and the server rule names them the same way as the GLB', async () => {
  const { glb, metadata } = await exportFixture()
  const kept = ['chair', 'coffee table', '   ', 'desk']
  assert.deepEqual(metadata.labels, kept, 'the upload lists a skipped entry, or misses a kept box')
  assert.equal(metadata.detectionCount, kept.length, 'the upload counts a different number of boxes than it lists')
  assert.equal(metadata.detections?.length, kept.length, 'the upload carries a different number of entries than it lists')
  assert.deepEqual(serverNamesByLabel(metadata), EXPECTED_NAMES, 'the server rule names the uploaded entries differently')
  assert.deepEqual(
    namesByLabel(glbDetectionNodes(glb)),
    serverNamesByLabel(metadata),
    'the GLB and the server disagree on a box name',
  )
})
