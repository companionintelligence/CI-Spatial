/**
 * CAR4-1: for the fixture, each detection box has the viewer LOD id that the server writes for it.
 *
 * Saved edits, hides and focus for a detection box are keyed on its LOD id: the scan id, the node
 * name and a lod suffix. The viewer builds that id in upgradeSemanticMeshes (src/viewer/viewer.ts).
 * The server builds it for the same box in detectionLikesForWorld (server/main.ts), from the label
 * and the box's place among the entries it keeps. The two agree only while the node name keeps the
 * safe-label, underscore, three-digit-index format.
 *
 * What runs for real: the exporter writes the GLB and the upload metadata, GLTFLoader reads the GLB
 * back, and collectDetections() (the viewer's own helper) finds the boxes. What does not run: the
 * viewer's and the server's id rules. They are copied in viewerLodId() and serverLodIds(), because
 * neither source file can be imported under node. The CAR5-3 tests at the end read both files and
 * fail when the copied lines change, so a rename on either side is caught.
 *
 * The fixture has three numbered boxes and one blank-label box that the exporter must skip. It has
 * no duplicate labels, no whitespace-only label and no position that is not finite.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-car4-lod-ids.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { collectDetections } from '../../../src/viewer/detections.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'

const SCAN_ID = 'scan-car4-lod'
const SESSION_ID = 'sess-car4-lod'

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

interface UploadMetadata {
  detections?: Array<{ label: string; confidence: number | null; worldPos: Position }>
}

interface Upload {
  glb: Uint8Array
  metadata: UploadMetadata
}

/** Every upload the exporter made. The fetch stub records the GLB and the metadata sent with it. */
const uploads: Upload[] = []
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const body = init?.body as FormData | undefined
  const file = body?.get('file')
  const metadata = body?.get('metadata')
  if (file instanceof Blob && typeof metadata === 'string') {
    uploads.push({
      glb: new Uint8Array(await file.arrayBuffer()),
      metadata: JSON.parse(metadata) as UploadMetadata,
    })
  }
  return new Response(JSON.stringify({ filename: 'stored.glb' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

interface Position {
  x: number
  y: number
  z: number
}

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

/**
 * A label with a space is included so the safe-name rule is exercised on both sides. The blank
 * label after the first box is one the exporter skips and the server drops, so the boxes after it
 * must keep the numbers the server gives them (CAR5-1).
 */
const DETECTIONS: Array<[string, WorldDetection]> = [
  ['chair:0', detection('chair', 0, 2)],
  ['blank:1', detection('', 1, 2)],
  ['coffee table:2', detection('coffee table', 2, 2)],
  ['lamp:3', detection('lamp', 4, 3)],
]

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

async function exportFixture(): Promise<Upload> {
  uploads.length = 0
  await exportToGLB(
    {
      store: { sessionId: SESSION_ID, serverSessionOfThisRun: SESSION_ID, currentRunDetections: () => new Map(DETECTIONS) } as unknown as DetectionStore,
      pointCloud: pointCloudStub(24),
      poseHistory: [pose(0), pose(-0.5), pose(-1)],
    },
    { download: false, upload: true },
  )
  assert.equal(uploads.length, 1, 'the GLB and its metadata did not reach the upload path')
  return uploads[0]
}

// ─── The two readers ───────────────────────────────────────────────────────

/** The exporter's own output: the node names and extras as written in the GLB JSON. */
function glbNodes(glb: Uint8Array): Array<{ name?: string; extras?: Record<string, unknown> }> {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
    nodes?: Array<{ name?: string; extras?: Record<string, unknown> }>
  }
  return json.nodes ?? []
}

/** The scene the viewer works from: the GLB loaded the way the viewer loads it. */
async function loadViewerScene(glb: Uint8Array): Promise<Object3D> {
  const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer
  return new Promise<Object3D>((resolve, reject) => {
    new GLTFLoader().parse(bytes, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/**
 * The viewer's LOD id for a loaded detection (viewer.ts, upgradeSemanticMeshes: name, then objectId).
 * A copy of the rule, not a call: the CAR5-3 tests at the end tie the copy to the source.
 */
function viewerLodId(scanId: string, node: Object3D, mesh: Object3D): string {
  const label = String((node.userData as Record<string, unknown>)['label'])
  const name = node.name || mesh.name || label
  return `${scanId}:${name}:lod`
}

/** The label and position that tell the viewer's boxes and the server's entries apart. */
function boxKey(label: string, pos: Position): string {
  return `${label}@${pos.x},${pos.y},${pos.z}`
}

/**
 * The LOD id the server writes for each detection (server/main.ts, detectionLikesForWorld):
 * the safe label, an underscore and the one-based index among the entries that survive
 * detectionsFromMeta, which needs a non-empty label and a position. Keyed by label and position
 * so each box can be matched to its entry. A copy of the rule, not a call: see the CAR5-3 tests.
 */
function serverLodIds(scanId: string, metadata: UploadMetadata): Map<string, string> {
  const ids = new Map<string, string>()
  const withPositions = (metadata.detections ?? []).filter((d) => d.label && d.worldPos)
  withPositions.forEach((detection, index) => {
    const safeName = detection.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'
    const name = `${safeName}_${String(index + 1).padStart(3, '0')}`
    ids.set(boxKey(detection.label, detection.worldPos), `${scanId}:${name}:lod`)
  })
  return ids
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('CAR4-1: the exporter names each detection node in the safe-name format, with no placeholder prefix', async () => {
  const { glb } = await exportFixture()
  const names = glbNodes(glb)
    .filter((n) => n.extras?.['objectType'] === 'detection')
    .map((n) => n.name)
    .sort()
  assert.deepEqual(names, ['chair_001', 'coffee_table_002', 'lamp_003'])
})

test('CAR4-1: each box in the fixture has the viewer LOD id that the server rule writes for it', async () => {
  const { glb, metadata } = await exportFixture()
  const boxes = collectDetections(await loadViewerScene(glb))
  assert.equal(boxes.length, 3, 'the viewer did not find all three detection boxes')

  const serverIds = serverLodIds(SCAN_ID, metadata)
  assert.equal(serverIds.size, 3, 'the server would not write an id for every box')

  for (const { node, mesh } of boxes) {
    const data = node.userData as Record<string, unknown>
    assert.equal(data['dimensionsEstimated'], true, `${node.name} is not flagged as a placeholder`)
    assert.equal(data['placeholder'], true, `${node.name} carries no placeholder marker in its extras`)
    const expected = serverIds.get(boxKey(String(data['label']), data['worldPos'] as Position))
    assert.ok(expected, `the server writes no LOD id for ${node.name}`)
    assert.equal(viewerLodId(SCAN_ID, node, mesh), expected, `${node.name} resolves to a different LOD id in the viewer`)
  }
})

// ─── Source anchors (CAR5-3) ───────────────────────────────────────────────

// viewer.ts and server/main.ts cannot be imported under node, so viewerLodId() and serverLodIds()
// copy their rules. These checks read the source those rules come from and fail when a copied line
// is renamed or changed, so a rename on either side cannot leave the tests above green.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The text of a file in this repo. */
function sourceOf(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** The text of one top-level function: from its header to the closing brace in column zero. */
function functionSource(source: string, header: string): string {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, 'no function with this header is in its file: ' + header)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, 'the function with this header does not close in its file: ' + header)
  return source.slice(start, end)
}

test('CAR5-3: server/main.ts keeps the numbering rule that serverLodIds() copies', () => {
  const server = sourceOf('server/main.ts')

  const parsed = functionSource(server, 'function detectionsFromMeta(')
  assert.ok(
    parsed.includes("if (!label || !pos || typeof pos !== 'object') continue"),
    'detectionsFromMeta no longer drops an entry with an empty label or no position',
  )
  assert.ok(
    parsed.includes("if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue"),
    'detectionsFromMeta no longer drops an entry whose position is not a number',
  )

  // The numbering itself moved out of detectionLikesForWorld into thingLikesForScan
  // (server/thing_match.ts) when Things began to be compared in the Place frame, so each position
  // could go through the scan's localToWorld. The rule is unchanged. What this test pins is that the
  // caller still hands over exactly the entries that survive detectionsFromMeta, in order, and that
  // thingLikesForScan numbers them the way viewerLodId() expects.
  const caller = functionSource(server, 'async function detectionLikesForWorld(')
  assert.ok(
    caller.includes('thingLikesForScan(scan, withPositions)'),
    'detectionLikesForWorld no longer hands the entries that survive detectionsFromMeta to thingLikesForScan',
  )

  const numbering = functionSource(sourceOf('server/thing_match.ts'), 'export function thingLikesForScan(')
  assert.ok(
    numbering.includes('withPositions.map((detection, index) => {'),
    'thingLikesForScan no longer numbers the entries that survive detectionsFromMeta',
  )
  assert.ok(
    numbering.includes("const safeName = detection.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'Object'"),
    'thingLikesForScan no longer builds the safe name that the exporter uses',
  )
  assert.match(
    numbering,
    /const name = `\$\{safeName\}_\$\{String\(index \+ 1\)\.padStart\(3, '0'\)\}`/,
    'thingLikesForScan no longer names a box as the safe label, an underscore and the one-based index',
  )
  assert.match(
    numbering,
    /targetId: `\$\{scan\.scanId\}:\$\{name\}:lod`/,
    'thingLikesForScan no longer builds the LOD id as scan id, name and the lod suffix',
  )
})

test('CAR5-3: viewer.ts keeps the naming rule that viewerLodId() copies', () => {
  const viewer = sourceOf('src/viewer/viewer.ts')
  const upgrade = functionSource(viewer, 'function upgradeSemanticMeshes(')
  assert.ok(
    upgrade.includes('const name = node.name || mesh.name || label'),
    'upgradeSemanticMeshes no longer takes the name from the node, then the mesh, then the label',
  )
  assert.match(
    upgrade,
    /objectId: `\$\{scanId\}:\$\{name\}:lod`/,
    'upgradeSemanticMeshes no longer writes the LOD id as scan id, name and the lod suffix',
  )
})
