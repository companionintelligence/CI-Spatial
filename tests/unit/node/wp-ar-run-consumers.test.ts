/**
 * Everything that places, counts or sends a stored detection reads this page's run only (WP-02).
 *
 * The store keeps every detection of its session, each stamped with the AR run that placed it
 * (detection_store.test.ts, wp-ar-run-reload.test.ts). What a person sees and what leaves the phone
 * must be the detections of the run whose frame the camera, the point cloud and the calibration are in.
 * A reader that takes the whole record instead is the bug: an earlier run's pin drawn at a wrong place, an
 * earlier run's object filed in a GLB under this run's calibration, a count that says four where the scan has
 * two. This file runs each reader against a store holding two runs, and then holds the modules to a short list
 * of the only places the whole record may be read.
 *
 * The two exporters are plain functions and run for real here, against stand-ins for FileReader, fetch and the
 * few document members they touch. The AR overlay, the history drawer and the side panel are run for real in
 * wp-ar-run-views.test.ts. main.ts is one large DOM module nothing here can load, so what it must do (start the run
 * once AR is running, merge into the run's detections, count the run's) is pinned by reading its source, in tests
 * named "source shape:" that claim no behaviour; the behaviour they depend on, `currentRunDetections()` and
 * `isCurrentRun()`, is run in the two store test files above.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-ar-run-consumers.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportToGLB } from '../../../src/export/gltf.ts'
import { exportSessionSummary } from '../../../src/export/summary.ts'
import { DetectionStore } from '../../../src/scene/store.ts'
import { PREVIOUS_RUN_LABEL, previousRunNotice, previousRunPanelNote } from '../../../src/ui/previous-run.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// ── A store holding two runs ───────────────────────────────────────────────────────────────────────

function detection(label: string, x: number, z: number): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0.1, 0.1, 0.4, 0.4],
    worldPos: { x, y: 0, z },
    worldRot: { x: 0, y: 0, z: 0, w: 1 },
    captureTimestamp: 1_787_174_311_700,
    captureIndex: 1,
  } as unknown as WorldDetection
}

function pose(): CaptureResult['pose'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

/** A stand-in JPEG. Only its byte length matters to the store. */
function frame(): Blob {
  return new Blob([new Uint8Array(8)], { type: 'image/jpeg' })
}

/**
 * The state a reload leaves: the earlier run's `sofa` and `lamp` are in the record, and this run has found
 * a `chair`. The earlier run's detections go in as that run's, and the store is then moved on to a new run.
 */
async function twoRunStore(): Promise<DetectionStore> {
  const store = new DetectionStore()
  store.startArRun('run-earlier')
  await store.upsert(new Map([
    ['sofa:0.0,0.0,-2.0', detection('sofa', 0, -2)],
    ['lamp:1.0,0.0,-2.0', detection('lamp', 1, -2)],
  ]), new Map())
  store.startArRun('run-now')
  await store.upsert(new Map([['chair:-1.0,0.0,-3.0', detection('chair', -1, -3)]]), new Map())
  return store
}

// ── The GLB and its upload sidecar ─────────────────────────────────────────────────────────────────

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buf) => { this.result = buf; this.onloadend?.() },
      (err) => this.onerror?.(err),
    )
  }
}

interface UploadMetadata {
  sessionId?: string | null
  detectionCount?: number
  labels?: string[]
  detections?: Array<{ label: string, worldPos: { x: number, y: number, z: number } }>
  calibrationMethod?: string | null
  projectTransform?: number[] | null
}

/** Runs `body` with FileReader and fetch stood in, and returns the GLB and metadata the upload carried. */
async function exportAndCapture(store: DetectionStore): Promise<{ glb: Uint8Array, metadata: UploadMetadata }> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { FileReader: g['FileReader'], fetch: g['fetch'] }
  let glb: Uint8Array | null = null
  let metadata: UploadMetadata | null = null
  g['FileReader'] = NodeFileReader
  g['fetch'] = async (_url: string, init?: RequestInit) => {
    const body = init?.body as FormData
    const file = body.get('file')
    if (file instanceof Blob) glb = new Uint8Array(await file.arrayBuffer())
    const meta = body.get('metadata')
    if (typeof meta === 'string') metadata = JSON.parse(meta) as UploadMetadata
    return new Response(JSON.stringify({ filename: 'stored.glb' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const positions = new Float32Array(24 * 3).map((_, i) => (i % 3 === 0 ? i * 0.01 : i * 0.005))
    const pointCloud = {
      count: 24,
      toFloat32Array: () => positions,
      boundingBox: () => ({ min: { x: 0, y: 0, z: -1 }, max: { x: 1, y: 1, z: 0 } }),
      estimateFloorY: () => 0,
    } as unknown as PointCloud
    const poses = [0, -0.5, -1].map((z): Pose => ({ position: { x: 0, y: 1.5, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }) as unknown as Pose)
    await exportToGLB({ store, pointCloud, poseHistory: poses }, { download: false, upload: true })
  } finally {
    g['FileReader'] = saved.FileReader
    g['fetch'] = saved.fetch
  }
  assert.ok(glb && metadata, 'the GLB and its metadata reached the upload')
  return { glb, metadata }
}

/** The `extras` of the GLB's first scene, which is where the exporter writes `scene.userData`. */
function glbSceneExtras(glb: Uint8Array): Record<string, unknown> {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as { scenes?: Array<{ extras?: Record<string, unknown> }> }
  return json.scenes?.[0]?.extras ?? {}
}

function glbDetectionLabels(glb: Uint8Array): string[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as { nodes?: Array<{ extras?: Record<string, unknown> }> }
  return (json.nodes ?? []).filter((node) => node.extras?.['objectType'] === 'detection').map((node) => String(node.extras?.['label']))
}

test('export: the GLB and the sidecar carry the run\'s detections, and an earlier run\'s are in neither', async () => {
  const store = await twoRunStore()
  assert.equal(store.detections.size, 3)
  const { glb, metadata } = await exportAndCapture(store)

  assert.deepEqual(glbDetectionLabels(glb), ['chair'], 'the file holds the chair this run found, and not the sofa or the lamp')
  assert.deepEqual(metadata.labels, ['chair'])
  assert.deepEqual(metadata.detections?.map((d) => d.label), ['chair'])
  assert.equal(metadata.detectionCount, 1)
  assert.deepEqual(metadata.detections?.[0]?.worldPos, { x: -1, y: 0, z: -3 })
})

test('export: a record that only an earlier run (or an older build) wrote exports no objects at all', async () => {
  const store = new DetectionStore()
  await store.upsert(new Map([['sofa:0.0,0.0,-2.0', detection('sofa', 0, -2)]]), new Map())   // no run: an older record's shape
  store.startArRun('run-now')
  const { glb, metadata } = await exportAndCapture(store)
  assert.deepEqual(glbDetectionLabels(glb), [])
  assert.equal(metadata.detectionCount, 0)
  assert.deepEqual(metadata.detections, [])
  assert.equal(store.detections.size, 1, 'and the record still holds it')
})

test('export: the same run\'s detections are exported, so a capture after a reload is not lost with the old ones', async () => {
  const store = new DetectionStore()
  store.startArRun('run-now')
  await store.upsert(new Map([
    ['sofa:0.0,0.0,-2.0', detection('sofa', 0, -2)],
    ['lamp:1.0,0.0,-2.0', detection('lamp', 1, -2)],
  ]), new Map())
  const { glb, metadata } = await exportAndCapture(store)
  assert.deepEqual(glbDetectionLabels(glb), ['sofa', 'lamp'])
  assert.equal(metadata.detectionCount, 2)
})

// ── The keyframe session an export names ─────────────────────────────────────────────────────────────

const EARLIER_SESSION = 'sess-11111111-2222-4333-8444-555555555555'
const THIS_RUNS_SESSION = 'sess-66666666-7777-4888-8999-000000000000'

test('export: a server session an earlier run opened is not named, in the GLB or in the upload', async () => {
  // What a resume leaves: the record is keyed by the server id the earlier run streamed under.
  const store = new DetectionStore()
  assert.equal(await store.adoptServerSession(EARLIER_SESSION), true)
  store.startArRun('run-now')                 // a new page's run: it did not open that session
  await store.upsert(new Map([['chair:-1.0,0.0,-3.0', detection('chair', -1, -3)]]), new Map())
  assert.equal(store.sessionId, EARLIER_SESSION)

  const { glb, metadata } = await exportAndCapture(store)
  assert.deepEqual(glbDetectionLabels(glb), ['chair'], 'this run\'s object is exported')
  assert.equal(glbSceneExtras(glb)['sessionId'], null, 'under no keyframe session: the earlier run\'s are in its frame')
  assert.equal(metadata.sessionId, null, 'and the server is not told this scan has them')
})

test('export: the session this run opened is the one named', async () => {
  const store = new DetectionStore()
  await store.adoptServerSession(EARLIER_SESSION)
  store.startArRun('run-now')
  await store.upsert(new Map([['chair:-1.0,0.0,-3.0', detection('chair', -1, -3)]]), new Map())
  assert.equal(await store.adoptServerSession(THIS_RUNS_SESSION), true)      // keyframe streaming starts in this run

  const { glb, metadata } = await exportAndCapture(store)
  assert.equal(glbSceneExtras(glb)['sessionId'], THIS_RUNS_SESSION)
  assert.equal(metadata.sessionId, THIS_RUNS_SESSION)
})

// ── The Markdown summary ───────────────────────────────────────────────────────────────────────────

/** Runs the Markdown summary for `store` against stand-ins for the document and fetch, and returns its text. */
async function summaryOf(store: DetectionStore, captureCount: number): Promise<string> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { document: g['document'], fetch: g['fetch'], create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let markdown: Blob | null = null
  g['document'] = { createElement: () => ({ click() {}, set href(_v: string) {}, set download(_v: string) {} }) }
  g['fetch'] = async () => new Response('{"filename":"s.md"}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  URL.createObjectURL = (blob: Blob | MediaSource) => { markdown = blob as Blob; return 'blob:summary' }
  URL.revokeObjectURL = () => {}
  try {
    const pointCloud = {
      count: 10,
      boundingBox: () => ({ min: { x: -2, y: 0, z: -4 }, max: { x: 2, y: 2, z: 0 } }),
    } as unknown as PointCloud
    await exportSessionSummary({ store, pointCloud, poseHistory: [], captureCount })
  } finally {
    g['document'] = saved.document
    g['fetch'] = saved.fetch
    URL.createObjectURL = saved.create
    URL.revokeObjectURL = saved.revoke
  }
  assert.ok(markdown)
  return await (markdown as Blob).text()
}

test('summary: the objects it lists, counts and lays out are this run\'s', async () => {
  const store = await twoRunStore()
  const text = await summaryOf(store, 3)
  assert.match(text, /\| Objects Detected \| 1 \|/, 'one object, not three')
  assert.match(text, /\*\*chair\*\*/)
  assert.doesNotMatch(text, /sofa|lamp/, 'an earlier run\'s objects, with positions in another frame, are not in the report')
})

test('summary: the captures it counts, and the failures it reports, are this run\'s', async () => {
  const store = new DetectionStore()
  const now = Date.now()
  store.startArRun('run-earlier')
  const failed = await store.putCapture({ captureIndex: 1, timestamp: now, pose: pose(), blob: frame() })
  const alsoFailed = await store.putCapture({ captureIndex: 2, timestamp: now, pose: pose(), blob: frame() })
  assert.ok(failed && alsoFailed)
  await store.markCaptureFailed(failed.captureId, 'engine error')
  await store.markCaptureFailed(alsoFailed.captureId, 'engine error')

  store.startArRun('run-now')
  const taken = await store.putCapture({ captureIndex: 3, timestamp: now, pose: pose(), blob: frame() })
  assert.ok(taken)
  await store.upsert(new Map([['chair:-1.0,0.0,-3.0', detection('chair', -1, -3)]]), new Map())
  await store.attachDetections(taken.captureId, ['chair:-1.0,0.0,-3.0'])

  const text = await summaryOf(store, store.captureCounts('run').total)
  assert.match(text, /\| Captures \| 1 \|/, 'one capture this run, and no failures to report')
  assert.doesNotMatch(text, /failed|pending|produced no detections/, 'the earlier run\'s two failures are not this scan\'s')
})

// ── What the person is told ────────────────────────────────────────────────────────────────────────

test('the drawer\'s label is the one the brief names', () => {
  assert.equal(PREVIOUS_RUN_LABEL, 'previous run, different frame')
})

test('the panel\'s empty state says where an earlier run\'s objects are, in the singular and the plural', () => {
  assert.equal(previousRunPanelNote(1), '1 object from an earlier run is in History, not shown here.')
  assert.equal(previousRunPanelNote(3), '3 objects from an earlier run are in History, not shown here.')
  for (const count of [1, 2, 40]) assert.doesNotMatch(previousRunPanelNote(count), /resumed|restored|exported/i)
})

test('the boot notice says the scan is kept and the objects are not shown or exported, and never "resumed"', () => {
  assert.equal(previousRunNotice(3), 'Earlier scan kept in History\n• 3 objects, not shown or exported')
  assert.equal(previousRunNotice(1), 'Earlier scan kept in History\n• 1 object, not shown or exported')
  for (const count of [1, 2, 40]) assert.doesNotMatch(previousRunNotice(count), /resumed|restored|loaded/i)
})

// ── Source shape: the DOM modules ──────────────────────────────────────────────────────────────────

/** Source with its comments removed, so a sentence about `store.detections` is not mistaken for a read. */
function code(path: string): string {
  return read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name)
    return statSync(join(ROOT, path)).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

test('source shape: only the store and the history drawer read the whole record; everything else reads the run', () => {
  const readers = sourceFiles('src')
    .filter((path) => /\bstore\.detections\b/.test(code(path)))
    .map((path) => relative('.', path))
    .sort()
  assert.deepEqual(
    readers,
    ['src/ui/history.ts'],
    'a module that places, counts or sends a stored position must read store.currentRunDetections(). A new reader of the whole record belongs here only if it lists detections without placing, counting or sending them',
  )
  const history = code('src/ui/history.ts')
  assert.equal(history.split('this.store.detections').length - 1, 1, 'the drawer reads the whole record once: the active session\'s rows, which it labels')
  assert.match(history, /this\._renderDetectionRows\(container, this\.store\.detections, sessionId, isActive\)/)
})

test('source shape: main.ts starts the run once AR is running, merges into the run, and counts the run', () => {
  const main = read('src/main.ts')
  const started = main.indexOf('await provider.start(canvas)')
  const run = main.indexOf('store.startArRun()')
  const scanner = main.indexOf('scanner.start(provider, (frame) => {')
  assert.ok(started > 0 && run > started && scanner > run, 'the run starts after the AR provider has started, and before anything is scanned')
  assert.equal(main.split('store.startArRun(').length - 1, 1, 'one place starts the run')
  assert.match(main.slice(started, run), /disableCaptureControls\('AR did not start/, 'and after the start-failure path has returned, so a failed start has no run')

  assert.match(main, /const merged = mergeDetections\(store\.currentRunDetections\(\), worldDets\)/, 'a new detection is merged into this run\'s, never into an earlier run\'s')
  assert.doesNotMatch(main, /mergeDetections\(store\.detections/)
  assert.match(
    main,
    /const resumed = await store\.resumeLatestSession\(\)\n  if \(resumed > 0\) \{\n(?:\s+\/\/.*\n)*\s+overlay\.setStatus\(previousRunNotice\(store\.previousRunCount\(\)\)\)\n  \}/,
    'the boot says what came back is kept, not shown, and says it only when something came back',
  )
  assert.doesNotMatch(main, /Resumed last scan/)
  assert.match(main, /\n  store\.startArRun\(\)\n/, 'the run starts on a line of its own at the top level of main(), so no condition or early return can skip it')
  // The counts that go to the server and onto the screen are the scan's own: no keyframe payload counts the whole record.
  assert.doesNotMatch(main, /detectionCount: store\.detections\.size/)
  assert.ok(main.split('detectionCount: store.currentRunDetections().size').length - 1 >= 4, 'the keyframe payloads count the run')
  assert.match(main, /store\.currentRunDetections\(\)\.size === 0 && poseHistory\.length === 0/, 'autosave sees an empty run as empty')
  assert.match(main, /store\.currentRunDetections\(\)\.size > 0 \|\| poseHistory\.length > 0/, 'the leave guard does not call a reloaded record unsaved work')
  assert.match(main, /items: \[\.\.\.store\.currentRunDetections\(\)\.values\(\)\]/, 'the live mirror shows positions in the live frame only')
  assert.match(main, /function currentQualitySummary\(detectionCount: number = store\.currentRunDetections\(\)\.size\)/)
})

test('source shape: the exporters read the run', () => {
  assert.match(code('src/export/gltf.ts'), /const boxes = \[\.\.\.store\.currentRunDetections\(\)\.values\(\)\]\.filter\(isBoxDetection\)/)
  assert.match(code('src/export/summary.ts'), /const dets = \[\.\.\.store\.currentRunDetections\(\)\.values\(\)\]/)
})

test('source shape: the retired wording is gone from the drawer and the panel', () => {
  assert.doesNotMatch(read('src/ui/history.ts'), /Load session into view/, 'loading no longer brings an earlier run\'s objects into view, so the tooltip does not say it does')
  assert.match(code('src/ui/panel.ts'), /previousRunPanelNote\(earlier\)/, 'the panel\'s empty state says where an earlier run\'s objects went (run in wp-ar-run-views.test.ts)')
})
