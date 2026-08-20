/**
 * Node-level provenance in the exported GLB — ticket
 * docs/factory/07-scan-identity/0003-node-level-glb-provenance.md.
 *
 * Provenance used to be written once at scene level, plus `sourceScanIds` on
 * detection meshes. Every other node carried only `roomName`/`floorName`,
 * which are place labels rather than identity: two walkthroughs of the same
 * room both write `Room_Unknown`. Merge two such files and the geometry is
 * anonymous.
 *
 * These assert against the **written bytes**, not the in-memory scene:
 * `GLTFExporter` serializes `userData` to `extras` as JSON and silently drops
 * anything it cannot handle, so an in-memory assertion would pass through a
 * silent drop.
 *
 * `exportToGLB` is browser code but runs here, with two shims. `DetectionStore`
 * and `PointCloud` are structural stubs — the exporter reads only `sessionId`,
 * `detections`, and three point-cloud methods. `download: false` skips
 * `triggerDownload()`, and `fetch` is stubbed to capture the uploaded bytes,
 * which is simply where the finished GLB is reachable from outside.
 *
 * Two DOM globals are needed that the ticket's feasibility note did not
 * anticipate: `FileReader` (used by `GLTFExporter`'s binary path, not only by
 * `getCanvas()` for textures) and `fetch`. Both are shimmed below. The
 * exporter's own extensionless relative imports also had to gain a `.ts` to
 * resolve under Node's ESM loader — the ADR 0002 cross-runtime seam.
 *
 * Run: npm run test:provenance
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { exportToGLB } from './src/export/gltf.ts'
import type { DetectionStore } from './src/scene/store.ts'
import type { PointCloud } from './src/scene/pointcloud.ts'
import type { Pose } from './src/ar/provider.ts'
import type { WorldDetection } from './src/spatial/resolver.ts'
import { NODE_PROVENANCE_KEYS } from './src/shared/provenance.ts'
import * as THREE from 'three'
import { SceneEditor } from './src/viewer/editor.ts'

const SESSION_ID = 'sess-11111111-2222-3333-4444-555555555555'

function detection(label: string, x: number, captureIndex?: number): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x, y: 0, z: -1 },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1787174311700,
    ...(captureIndex !== undefined ? { captureIndex } : {}),
  } as WorldDetection
}

/** Only `sessionId` and `detections` are read by the exporter. */
function storeStub(detections: Array<[string, WorldDetection]>, sessionId = SESSION_ID): DetectionStore {
  return { sessionId, detections: new Map(detections) } as unknown as DetectionStore
}

/** A point cloud with `count` points on a diagonal, plus the two derived reads. */
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
  return {
    position: { x: 0, y: 1.5, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  } as unknown as Pose
}

interface GlbJson {
  scenes?: Array<Record<string, unknown>>
  nodes?: Array<Record<string, unknown>>
}

/** Same JSON-chunk read as pipeline_detection_graph.test.ts. */
function glbJson(glb: Uint8Array): GlbJson {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
}

type Extras = Record<string, unknown>

function extrasOf(node: Record<string, unknown>): Extras {
  return (node['extras'] ?? {}) as Extras
}

/**
 * `GLTFExporter`'s binary path converts its buffers through `FileReader`, which
 * Node has no global for. (The ticket's feasibility note said the exporter
 * touches the DOM only in `getCanvas()`, for textures — this is a second
 * place.) The shim is faithful enough for the one call site: read a Blob into
 * `result` as an ArrayBuffer, then fire `onloadend`.
 */
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

/**
 * `exportToGLB` returns a byte count, not the bytes. Rather than reach into its
 * internals, take them off the upload path — which is also the path that
 * carries them to the server in production. The stub answers as the real
 * endpoint does so the exporter's own outcome handling is exercised too.
 */
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

/** Export a representative scan and hand back its parsed JSON chunk. */
async function exportFixture(
  detections: Array<[string, WorldDetection]> = [
    ['chair:0', detection('chair', 0, 2)],
    ['lamp:1', detection('lamp', 1.5, 3)],
  ],
  sessionId = SESSION_ID,
): Promise<GlbJson> {
  lastUploadedGlb = null
  const result = await exportToGLB(
    {
      store: storeStub(detections, sessionId),
      pointCloud: pointCloudStub(24),
      poseHistory: [pose(0), pose(-0.5), pose(-1)],
    },
    { download: false, upload: true },
  )
  assert.ok(result.size > 0, 'the exporter produced no bytes')
  assert.ok(lastUploadedGlb, 'no GLB reached the upload path')

  // Self-check the capture: if this is not a GLB, every assertion below would
  // be testing the wrong bytes.
  const magic = new TextDecoder().decode(lastUploadedGlb.subarray(0, 4))
  assert.equal(magic, 'glTF', `captured bytes are not a GLB (magic ${JSON.stringify(magic)})`)
  return glbJson(lastUploadedGlb)
}

test('every node the exporter writes carries the session id', async () => {
  const json = await exportFixture()
  const nodes = json.nodes ?? []
  assert.ok(nodes.length >= 6, `expected the full hierarchy, got ${nodes.length} nodes`)

  const named = nodes.filter((n) => typeof n['name'] === 'string')
  const bare: string[] = []
  for (const node of named) {
    const name = node['name'] as string
    const extras = extrasOf(node)
    // The wireframe child is a rendering artifact and is deliberately unnamed
    // and unstamped; skip anything with no extras at all and check below.
    if (Object.keys(extras).length === 0) continue
    if (extras['sessionId'] !== SESSION_ID) bare.push(name)
  }
  assert.deepEqual(bare, [], `these nodes carry no sessionId: ${bare.join(', ')}`)

  // Named coverage: the six node kinds the ticket enumerates, plus detections.
  const names = named.map((n) => n['name'] as string)
  for (const expected of ['Floor_Ground', 'Room_Unknown', 'point-cloud', 'camera-path', 'floor-plane', 'detections']) {
    assert.ok(names.includes(expected), `missing node ${expected} — fixture no longer representative`)
  }
})

test('capturedAt is one value, shared by the scene and every node', async () => {
  const json = await exportFixture()
  const sceneExtras = (json.scenes?.[0]?.['extras'] ?? {}) as Extras
  const sceneCapturedAt = sceneExtras['capturedAt']

  assert.equal(typeof sceneCapturedAt, 'string')
  assert.ok(
    !Number.isNaN(Date.parse(sceneCapturedAt as string)),
    `scene capturedAt does not parse: ${String(sceneCapturedAt)}`,
  )

  for (const node of json.nodes ?? []) {
    const extras = extrasOf(node)
    if (Object.keys(extras).length === 0) continue
    assert.equal(
      extras['capturedAt'],
      sceneCapturedAt,
      `${String(node['name'])} disagrees with the scene timestamp`,
    )
  }
})

test('captureIndex round-trips to the GLB', async () => {
  // Bug A: captureIndex exists on WorldDetection, is persisted to IndexedDB and
  // is the summary's "Scan #" column — the GLB was the one artifact that
  // dropped it. This assertion fails on main.
  const json = await exportFixture()
  const detections = (json.nodes ?? []).filter((n) => extrasOf(n)['objectType'] === 'detection')
  assert.equal(detections.length, 2)

  const byLabel = new Map(detections.map((n) => [extrasOf(n)['label'], extrasOf(n)]))
  assert.equal(byLabel.get('chair')?.['captureIndex'], 2)
  assert.equal(byLabel.get('lamp')?.['captureIndex'], 3)
})

test('a detection with no captureIndex omits the key rather than writing null', async () => {
  const json = await exportFixture([['chair:0', detection('chair', 0)]])
  const det = (json.nodes ?? []).find((n) => extrasOf(n)['objectType'] === 'detection')
  assert.ok(det, 'no detection node in the export')

  const extras = extrasOf(det)
  assert.equal(
    'captureIndex' in extras,
    false,
    '"not attributed" and "attributed to nothing" are different claims',
  )
})

test('sourceScanIds is an array carrying the session id', async () => {
  const json = await exportFixture()
  const det = (json.nodes ?? []).find((n) => extrasOf(n)['objectType'] === 'detection')
  assert.deepEqual(extrasOf(det!)['sourceScanIds'], [SESSION_ID])
})

test('no node carries a client-written scanId', async () => {
  // The client cannot know it — the server derives it from the stored filename
  // during the optimize pass (ticket 0004). Guessing would bake in a wrong id.
  const json = await exportFixture()
  const guessed = (json.nodes ?? [])
    .filter((n) => extrasOf(n)['scanId'] !== undefined)
    .map((n) => String(n['name']))
  assert.deepEqual(guessed, [], `these nodes guessed a scanId: ${guessed.join(', ')}`)
})

test('the wireframe child carries no provenance', async () => {
  const json = await exportFixture()
  const nodes = json.nodes ?? []
  const detectionNodes = nodes.filter((n) => extrasOf(n)['objectType'] === 'detection')
  assert.ok(detectionNodes.length > 0)

  for (const det of detectionNodes) {
    for (const childIndex of (det['children'] ?? []) as number[]) {
      const extras = extrasOf(nodes[childIndex])
      for (const key of NODE_PROVENANCE_KEYS) {
        assert.equal(
          key in extras,
          false,
          `wireframe child carries ${key}; one provenance record per logical object`,
        )
      }
    }
  }
})

test('two sessions of the same room differ on every node, though the place labels match', async () => {
  // The acceptance criterion that says why place labels are not identity.
  const a = await exportFixture()
  const b = await exportFixture(
    [['chair:0', detection('chair', 0, 1)]],
    'sess-99999999-8888-7777-6666-555555555555',
  )

  const roomOf = (json: GlbJson) => (json.nodes ?? []).find((n) => n['name'] === 'Room_Unknown')
  const roomA = extrasOf(roomOf(a)!)
  const roomB = extrasOf(roomOf(b)!)

  assert.equal(roomA['roomName'], roomB['roomName'], 'the place label is the same on both')
  assert.notEqual(roomA['sessionId'], roomB['sessionId'], 'but the identity is not')
})

test('a capture with no server session writes null rather than a local id', async () => {
  // Since 07-scan-identity/0002: a local id names no keyframe directory, so
  // null is the honest value and ScanProvenance.sessionId is nullable.
  const json = await exportFixture([['chair:0', detection('chair', 0, 1)]], 'local-abc-def')
  const room = (json.nodes ?? []).find((n) => n['name'] === 'Room_Unknown')

  assert.equal(extrasOf(room!)['sessionId'], null)
})

// ── Bug B: the exporter and the inspector agreed on no key at all ──────────

test('getInspectorData reads sourceScanIds, the key the exporter actually writes', () => {
  // The read was `ud['sourceScan']` (singular) while gltf.ts wrote
  // `sourceScanIds` (plural), so InspectorData.sourceScan was unconditionally
  // undefined — and nothing rendered it either, which is how the mismatch
  // survived. This assertion fails on main.
  const editor = new SceneEditor()
  const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  node.name = 'chair_001'
  node.userData = {
    label: 'chair',
    sourceScanIds: ['sess-11111111-2222-3333-4444-555555555555'],
    sessionId: 'sess-11111111-2222-3333-4444-555555555555',
    capturedAt: '2026-08-19T21:18:33.000Z',
    captureIndex: 2,
  }

  const data = editor.getInspectorData(node)

  assert.deepEqual(data.sourceScanIds, ['sess-11111111-2222-3333-4444-555555555555'])
  assert.equal(data.sessionId, 'sess-11111111-2222-3333-4444-555555555555')
  assert.equal(data.capturedAt, '2026-08-19T21:18:33.000Z')
  assert.equal(data.captureIndex, 2)
  // Stamped server-side in ticket 0004, so absent on a raw upload.
  assert.equal(data.scanId, undefined)
})

test('getInspectorData: a node with no provenance yields undefined, not []', () => {
  const editor = new SceneEditor()
  const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  node.userData = { label: 'chair' }

  const data = editor.getInspectorData(node)

  assert.equal(data.sourceScanIds, undefined, 'the inspector row must not render for a bare node')
  assert.equal(data.captureIndex, undefined)
})
