/**
 * DetectionStore — thumbnail precedence on upsert(), and capture durability.
 *
 * Two groups of tests here. The first covers which thumbnail a re-captured
 * detection keeps. The second covers the capture records added by
 * docs/factory/04-capture-path-truthfulness/0003: a frame is stored *before*
 * inference runs, so a failed detection costs a label rather than the
 * photograph, and eviction never reclaims a frame whose inference is still
 * outstanding.
 *
 * Detections are keyed `label:bucket(worldPos)` (src/main.ts), so pointing the camera at
 * the same object in the same place produces the same key on every capture. And boot
 * calls `resumeLatestSession()` (src/main.ts), which adopts the previous session's
 * detections — thumbnails included — so that key usually already exists before the user
 * captures anything.
 *
 * upsert() used to merge with `existing?.thumbnailDataUrl ?? thumbnails.get(key)`, so the
 * older image always won. Every other field refreshed (the new detection is spread first),
 * which is why the symptom read as "the camera works but the picture never changes": an
 * image captured in an earlier session was pinned to that object permanently.
 *
 * These tests construct the store WITHOUT calling open(), so `db` stays null and
 * persist() early-returns — the merge is exercised purely in memory, no IndexedDB.
 *
 * Run: npm run test:store
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DetectionStore, MAX_CAPTURE_ITEMS } from '../../../src/scene/store.ts'
import type { WorldDetection } from '../../../src/spatial/resolver.ts'
import type { CaptureResult } from '../../../src/capture/capture.ts'
import { isServerSessionId } from '../../../src/shared/session-id.ts'

/** Minimal WorldDetection — only the fields upsert() spreads are load-bearing here. */
function detection(label: string, x = 0): WorldDetection {
  return {
    label,
    confidence: 0.9,
    description: `a ${label}`,
    bbox: [0, 0, 1, 1],
    worldPos: { x, y: 0, z: 0 },
  } as unknown as WorldDetection
}

function one(key: string, det: WorldDetection): Map<string, WorldDetection> {
  return new Map([[key, det]])
}

test('upsert: a re-capture replaces the stored thumbnail', async () => {
  const store = new DetectionStore()
  const key = 'sofa:0,0,0'

  await store.upsert(one(key, detection('sofa')), new Map([[key, 'data:image/jpeg;base64,FIRST']]))
  assert.equal(store.detections.get(key)?.thumbnailDataUrl, 'data:image/jpeg;base64,FIRST')

  // Same object, same place, so the same key — this is the case that was broken.
  await store.upsert(one(key, detection('sofa')), new Map([[key, 'data:image/jpeg;base64,SECOND']]))
  assert.equal(
    store.detections.get(key)?.thumbnailDataUrl,
    'data:image/jpeg;base64,SECOND',
    'the freshly captured image must win over the one already stored',
  )
})

test('upsert: a capture with no thumbnail for that key keeps the previous one', async () => {
  const store = new DetectionStore()
  const key = 'tv:1,0,0'

  await store.upsert(one(key, detection('tv', 1)), new Map([[key, 'data:image/jpeg;base64,KEEP']]))
  // Nothing captured for this key this time — the fallback is what stops the tile going blank.
  await store.upsert(one(key, detection('tv', 1)), new Map())

  assert.equal(store.detections.get(key)?.thumbnailDataUrl, 'data:image/jpeg;base64,KEEP')
})

test('upsert: the non-image fields still refresh on a re-capture', async () => {
  // These always updated, even while the image was pinned — the new detection is spread
  // first. Pinned so a future change cannot quietly reverse the precedence.
  const store = new DetectionStore()
  const key = 'lamp:2,0,0'

  await store.upsert(one(key, detection('lamp', 2)), new Map([[key, 'thumb-a']]))
  const updated = { ...detection('lamp', 2), confidence: 0.42, description: 'a brass lamp' }
  await store.upsert(one(key, updated as WorldDetection), new Map([[key, 'thumb-b']]))

  const stored = store.detections.get(key)
  assert.equal(stored?.confidence, 0.42)
  assert.equal(stored?.description, 'a brass lamp')
  assert.equal(stored?.thumbnailDataUrl, 'thumb-b')
})

test('upsert: a different object at a different bucket does not inherit a thumbnail', async () => {
  const store = new DetectionStore()

  await store.upsert(one('chair:0,0,0', detection('chair')), new Map([['chair:0,0,0', 'thumb-chair']]))
  await store.upsert(one('chair:9,0,0', detection('chair', 9)), new Map())

  assert.equal(store.detections.get('chair:0,0,0')?.thumbnailDataUrl, 'thumb-chair')
  assert.equal(
    store.detections.get('chair:9,0,0')?.thumbnailDataUrl,
    undefined,
    'a distinct key starts with no image rather than borrowing another detection’s',
  )
})

// ── Captures ─────────────────────────────────────────────────────────────────
//
// A capture is written before inference is attempted. These pin the three
// properties that make it worth having: the frame survives a failure, a success
// attaches to the record already holding it rather than making a second, and
// the retention budget will go over rather than drop an unresolved capture.

function pose(): CaptureResult['pose'] {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
}

/** A stand-in JPEG. Only its byte length matters to the store. */
function frame(bytes = 8): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
}

test('putCapture: a capture whose inference fails is still there, frame intact', async () => {
  const store = new DetectionStore()
  // 140842 bytes is the size logged by all six captures that were lost on the
  // Lume Pad 2 session that found this defect.
  const rec = await store.putCapture({
    captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(140842),
  })

  // What the capture handler's catch block now does instead of losing the frame.
  await store.markCaptureFailed(rec.captureId, 'WebGPU worker error')

  const stored = store.getCapture(rec.captureId)
  assert.equal(stored?.status, 'failed')
  assert.equal(stored?.error, 'WebGPU worker error')
  assert.equal(stored?.byteSize, 140842)
  assert.ok(stored?.blob, 'the frame must outlive its failed inference — that is the whole change')
  assert.equal(store.captureCounts().failed, 1, 'and it must be counted, not silently absent')
})

test('attachDetections: a successful capture yields one record carrying its detections', async () => {
  const store = new DetectionStore()
  const rec = await store.putCapture({
    captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(),
  })
  await store.attachDetections(rec.captureId, ['sofa:0,0,0', 'tv:1,0,0'])

  assert.equal(store.captures.size, 1, 'detections attach to the frame record; they do not create a second')
  const stored = store.getCapture(rec.captureId)
  assert.equal(stored?.status, 'inferred')
  assert.equal(stored?.captureIndex, 1)
  assert.deepEqual(stored?.detectionKeys, ['sofa:0,0,0', 'tv:1,0,0'])
  assert.deepEqual(
    store.captureCounts(),
    { total: 1, pending: 0, inferred: 1, failed: 0, unusable: 0, retained: 1 },
  )
})

test('eviction: a capture whose inference has not resolved is never dropped', async () => {
  const store = new DetectionStore()
  const t0 = Date.now()
  const over = MAX_CAPTURE_ITEMS + 8

  for (let i = 1; i <= over; i++) {
    await store.putCapture({ captureIndex: i, timestamp: t0 + i, pose: pose(), blob: frame(1) })
  }

  // Every one is still pending, so the budget has nothing it is allowed to take
  // and sits over its cap instead. Dropping one here is the original bug.
  assert.equal(store.captures.size, over)
  assert.equal(store.captureCounts().pending, over)
})

test('eviction: the oldest inferred frame goes before any failed one', async () => {
  const store = new DetectionStore()
  const t0 = Date.now()
  const ids: string[] = []

  for (let i = 1; i <= MAX_CAPTURE_ITEMS; i++) {
    const rec = await store.putCapture({ captureIndex: i, timestamp: t0 + i, pose: pose(), blob: frame(1) })
    ids.push(rec.captureId)
  }
  // The two oldest resolved; the one after them failed.
  await store.attachDetections(ids[0], ['a:0,0,0'])
  await store.attachDetections(ids[1], ['b:0,0,0'])
  await store.markCaptureFailed(ids[2], 'server unreachable')

  // One more capture puts the store exactly one over the item cap.
  await store.putCapture({
    captureIndex: MAX_CAPTURE_ITEMS + 1, timestamp: t0 + MAX_CAPTURE_ITEMS + 1, pose: pose(), blob: frame(1),
  })

  assert.equal(store.captures.size, MAX_CAPTURE_ITEMS)
  assert.equal(store.getCapture(ids[0]), undefined, 'the oldest inferred capture is the one that goes')
  assert.ok(store.getCapture(ids[1]), 'and only as many as the budget actually requires')
  assert.ok(
    store.getCapture(ids[2]),
    'a failed capture outlives every inferred one — it is the evidence of what went wrong',
  )
})

test('discardFrame: a frame that failed on its own quality does not keep its image', async () => {
  const store = new DetectionStore()
  const rec = await store.putCapture({
    captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(140842),
  })

  // What the capture handler does when inference fails on a frame the quality
  // monitor had already flagged as too dark or reflective to read.
  await store.markCaptureFailed(rec.captureId, 'no objects legible')
  await store.discardFrame(rec.captureId, 'quality')

  const stored = store.getCapture(rec.captureId)
  assert.equal(stored?.blob, null, 'an unusable frame is not worth holding for a retry')
  assert.equal(stored?.frameDropped, 'quality', 'and a frame that is gone must say why')
  assert.equal(stored?.status, 'failed', 'the record survives, so the capture is still counted')
  assert.equal(stored?.byteSize, 140842, 'what it cost stays on the record')
  assert.deepEqual(
    store.captureCounts(),
    { total: 1, pending: 0, inferred: 0, failed: 1, unusable: 1, retained: 0 },
  )
})

test('discardFrame: a frame kept after a server failure is still re-inferrable', async () => {
  const store = new DetectionStore()
  const rec = await store.putCapture({
    captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(140842),
  })
  // The engine failed, not the photograph — nothing calls discardFrame here.
  await store.markCaptureFailed(rec.captureId, 'Server unreachable')

  const stored = store.getCapture(rec.captureId)
  assert.ok(stored?.blob, 'the frame outlives an error that had nothing to do with it')
  assert.equal(stored?.frameDropped, undefined)
  assert.equal(store.captureCounts().retained, 1)
})

// ── Session identity (07-scan-identity/0002) ───────────────────────────────
// These construct the store WITHOUT open(), so `db` is null and the IndexedDB
// half of adoptServerSession() early-returns — the identity move itself is
// pure in-memory state and is what these pin.

test('a fresh store starts with a local id that no server-session check accepts', () => {
  const store = new DetectionStore()

  assert.ok(
    store.sessionId.startsWith('local-'),
    `expected a local id, got ${store.sessionId}`,
  )
  assert.equal(
    isServerSessionId(store.sessionId),
    false,
    'a local id must never be mistaken for a server session',
  )
  // The retired shape, which looked like a server id and was accepted as one.
  assert.equal(/^session-\d+$/.test(store.sessionId), false)
})

test('adoptServerSession: the live id moves to the server id', async () => {
  const store = new DetectionStore()
  const local = store.sessionId

  await store.adoptServerSession('sess-11111111-2222-3333-4444-555555555555')

  assert.equal(store.sessionId, 'sess-11111111-2222-3333-4444-555555555555')
  assert.notEqual(store.sessionId, local)
  assert.ok(isServerSessionId(store.sessionId))
})

test('adoptServerSession: refuses anything that is not a server-minted id', async () => {
  const store = new DetectionStore()
  const local = store.sessionId

  await store.adoptServerSession('session-1787174216556') // the retired client shape
  assert.equal(store.sessionId, local, 'a client-shaped id must not be adopted')

  await store.adoptServerSession('local-abc')
  assert.equal(store.sessionId, local, 'a local id must not be adopted')
})

test('adoptServerSession: captures taken before streaming started follow the id', async () => {
  // The case the fork bug lives in: the user captures, *then* presses stream.
  // Those captures belong to the same walkthrough and must not be stranded
  // under the local id.
  const store = new DetectionStore()
  const local = store.sessionId
  const rec = await store.putCapture({
    captureIndex: 0, timestamp: Date.now(), pose: pose(), blob: frame(1024),
  })
  assert.equal(store.getCapture(rec.captureId)?.sessionId, local)

  await store.adoptServerSession('sess-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

  assert.equal(
    store.getCapture(rec.captureId)?.sessionId,
    'sess-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'the capture followed the session rather than being orphaned under the local id',
  )
})

test('adoptServerSession: re-adopting the same id is a no-op', async () => {
  const store = new DetectionStore()
  const id = 'sess-99999999-8888-7777-6666-555555555555'

  await store.adoptServerSession(id)
  await store.adoptServerSession(id)

  assert.equal(store.sessionId, id)
})
