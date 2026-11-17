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
import { newArRunId } from '../../../src/shared/ar-run-id.ts'
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

// Wave 05 ticket 0004 (docs/factory/05-on-device-inference/
// 0004-ungate-toggle-and-fallback-policy.md) — provenance extends the
// existing capture record (ADR 0001) rather than adding a parallel one.

test('putCapture: records which engine the capture was sent to', async () => {
  const store = new DetectionStore()
  const rec = await store.putCapture({
    captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(), engine: 'webgpu',
  })
  assert.equal(rec.engine, 'webgpu')
  assert.equal(store.getCapture(rec.captureId)?.engine, 'webgpu')
})

test('putCapture: engine defaults to server when the caller omits it', async () => {
  const store = new DetectionStore()
  const rec = await store.putCapture({
    captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame(),
  })
  assert.equal(rec.engine, 'server')
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

// ── AR runs (WP-02) ──────────────────────────────────────────────────────────
//
// A position is only meaningful inside the SLAM frame that produced it, and every page load starts a new
// frame. The store stamps each detection and capture with the run that placed it, and `currentRunDetections()`
// is what the pins, the panel, the exports and the counts read. These tests run in memory, as the thumbnail
// tests above do. The round trip through IndexedDB, with a reload in the middle, is in
// tests/unit/node/wp-ar-run-reload.test.ts, and the readers of the store are in wp-ar-run-consumers.test.ts.

/** What a capture of one object yields to upsert(): the label, a position, and the key main.ts files it under. */
function placed(label: string, x: number, z = 0): [string, WorldDetection] {
  return [`${label}:${x.toFixed(1)},0.0,${z.toFixed(1)}`, detection(label, x)]
}

function labels(map: Map<string, unknown>): string[] {
  return [...map.keys()].sort()
}

test('newArRunId: uses randomUUID where the page has it, and is a fresh id each time', () => {
  const id = newArRunId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(newArRunId(), id)
  const given = newArRunId({ randomUUID: () => 'from-the-page-0000-0000-0000-000000000000' })
  assert.equal(given, 'from-the-page-0000-0000-0000-000000000000', 'the page\'s own generator is the one used')
})

test('newArRunId: an old webview with no randomUUID gets the time and random bytes, which is still distinct and dot-free', () => {
  const oldWebview = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    const bytes = new Uint8Array((array as unknown as Uint8Array).buffer)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff
    return array
  } }
  const id = newArRunId(oldWebview)
  assert.match(id, /^[0-9a-z]+-[0-9a-f]{16}$/, `the fallback shape, got ${id}`)
  assert.equal(id.includes('.'), false, 'a dot is reserved for a later epoch suffix')
  // No crypto at all: Math.random stands in, and the ids are still different from one another.
  const bare = new Set(Array.from({ length: 50 }, () => newArRunId({})))
  assert.equal(bare.size, 50)
  for (const each of bare) assert.match(each, /^[0-9a-z]+-[0-9a-f]{16}$/)
})

test('newArRunId: the fallback id is made of the page\'s random bytes, or of Math.random where there are none', () => {
  // A page with getRandomValues but no randomUUID: the id carries exactly the bytes it was handed.
  const filled = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    new Uint8Array((array as unknown as Uint8Array).buffer).fill(0xab)
    return array
  } }
  assert.match(newArRunId(filled), /^[0-9a-z]+-abababababababab$/, 'eight bytes, all of them the page\'s')

  // A page with neither: Math.random is the source, and a different stream gives a different id.
  const realRandom = Math.random
  try {
    Math.random = () => 0.5                     // floor(0.5 * 256) = 128 = 0x80
    assert.match(newArRunId({}), /^[0-9a-z]+-8080808080808080$/)
    Math.random = () => 0.999                   // floor(0.999 * 256) = 255 = 0xff
    assert.match(newArRunId({}), /^[0-9a-z]+-ffffffffffffffff$/)
    // With getRandomValues present, Math.random is not consulted at all.
    Math.random = () => { throw new Error('Math.random was used although the page has getRandomValues') }
    assert.match(newArRunId(filled), /^[0-9a-z]+-abababababababab$/)
  } finally {
    Math.random = realRandom
  }
})

test('before the AR runtime starts no detection is in the frame, whatever the record holds', async () => {
  const store = new DetectionStore()
  const [k, d] = placed('sofa', 0)
  await store.upsert(new Map([[k, d]]), new Map())

  assert.equal(store.arRunId, null)
  assert.equal(store.detections.size, 1, 'the record holds it')
  assert.equal(store.currentRunDetections().size, 0, 'and there is no frame for it to be in yet')
  assert.equal(store.previousRunCount(), 1)
  assert.equal(store.detections.get(k)?.arRunId, undefined, 'with no run to say, nothing is stamped')
})

test('startArRun: names the run, stamps what upsert writes from then on, and returns the id', async () => {
  const store = new DetectionStore()
  const id = store.startArRun()
  assert.equal(store.arRunId, id)
  assert.match(id, /^[0-9a-f-]{36}$/)

  const [k, d] = placed('sofa', 0)
  await store.upsert(new Map([[k, d]]), new Map())
  assert.equal(store.detections.get(k)?.arRunId, id)
  assert.deepEqual(labels(store.currentRunDetections()), [k])
  assert.equal(store.previousRunCount(), 0)

  assert.equal(store.startArRun('run-given'), 'run-given', 'a caller may name the run')
  assert.equal(store.arRunId, 'run-given')
  const fresh = store.startArRun('')
  assert.equal(fresh, store.arRunId, 'an empty id is not a name: a fresh one is made instead')
  assert.notEqual(fresh, 'run-given')
  assert.notEqual(fresh, '', 'the run has a name; an empty string would read as no run to a caller that tests for one')
  assert.match(fresh, /^[0-9a-f-]{36}$/)
  assert.notEqual(store.startArRun(''), fresh, 'each empty id is a new run, not the previous fresh one again')
})

test('a second run in the same page turns the first run\'s detections into previous-run ones', async () => {
  const store = new DetectionStore()
  store.startArRun('run-a')
  const [ka, a] = placed('sofa', 0)
  await store.upsert(new Map([[ka, a]]), new Map())
  assert.deepEqual(labels(store.currentRunDetections()), [ka])

  store.startArRun('run-b')
  assert.equal(store.currentRunDetections().size, 0, 'run A\'s frame is gone, and so is its place in the view')
  assert.equal(store.detections.get(ka)?.arRunId, 'run-a', 'but it is still in the record, still stamped with its own run')
  assert.equal(store.previousRunCount(), 1)
  assert.equal(store.isCurrentRun({ arRunId: 'run-a' }), false)
  assert.equal(store.isCurrentRun({ arRunId: 'run-b' }), true)
  assert.equal(store.isCurrentRun({}), false, 'no id reads as an earlier run, never as this one')
})

test('startArRun tells the listeners, once, so the pins and the panel drop what is no longer in the frame', async () => {
  const store = new DetectionStore()
  let told = 0
  store.subscribe(() => { told++ })
  store.startArRun('run-a')
  assert.equal(told, 1)
  store.startArRun('run-a')
  assert.equal(told, 1, 'the same run again is not news')
  store.startArRun('run-b')
  assert.equal(told, 2)
})

test('startArRun survives a listener that throws: the AR start it was told about must not fail', () => {
  const store = new DetectionStore()
  store.subscribe(() => { throw new Error('listener failed') })
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    assert.doesNotThrow(() => store.startArRun('run-a'))
  } finally {
    console.warn = originalWarn
  }
  assert.equal(store.arRunId, 'run-a', 'the run began')
  assert.equal(warnings.length, 1, 'and the failure was reported, not swallowed')
})

test('a read-only store may start a run: it writes nothing, so there is nothing to refuse', async () => {
  const readOnly = new DetectionStore({ readOnly: true })
  assert.equal(readOnly.startArRun('run-a'), 'run-a')
  const [k, d] = placed('sofa', 0)
  assert.equal(await readOnly.upsert(new Map([[k, d]]), new Map()), false)
  assert.equal(readOnly.detections.size, 0)
})

test('upsert: merging into the current run leaves an earlier run\'s detections exactly as they were', async () => {
  const store = new DetectionStore()
  store.startArRun('run-a')
  const [ka, a] = placed('sofa', 0)
  await store.upsert(new Map([[ka, a]]), new Map([[ka, 'thumb-a']]))
  const earlier = store.detections.get(ka)!

  store.startArRun('run-b')
  const [kb, b] = placed('lamp', 3)
  await store.upsert(new Map([[kb, b]]), new Map())

  assert.equal(store.detections.get(ka), earlier, 'the very same stored object: nothing was rewritten')
  assert.equal(store.detections.get(ka)?.arRunId, 'run-a')
  assert.equal(store.detections.get(ka)?.thumbnailDataUrl, 'thumb-a')
  assert.deepEqual(labels(store.currentRunDetections()), [kb])
  assert.equal(store.detections.get(kb)?.arRunId, 'run-b')
})

test('upsert: an object found again by the next run does not overwrite the earlier run\'s record of it', async () => {
  // Every run starts at its own origin, so the same chair in the same room is under the same key in both.
  const store = new DetectionStore()
  store.startArRun('run-a')
  const key = 'chair:1.0,0.0,2.0'
  await store.upsert(new Map([[key, { ...detection('chair', 1), description: 'the chair, run A' } as WorldDetection]]), new Map())
  const earlier = store.detections.get(key)!

  store.startArRun('run-bbbbbbbb-cccc')
  await store.upsert(
    new Map([[key, { ...detection('chair', 1), description: 'the chair, run B' } as WorldDetection]]),
    new Map([[key, 'thumb-b']]),
  )

  assert.equal(store.detections.size, 2, 'both are kept')
  assert.equal(store.detections.get(key), earlier, 'the earlier run\'s detection keeps its key and every field')
  assert.equal(store.detections.get(key)?.description, 'the chair, run A')
  const now = store.currentRunDetections()
  assert.deepEqual(labels(now), ['chair:1.0,0.0,2.0@run-bbbb'], 'this run\'s is under the same key with its tag after it')
  const ours = now.get('chair:1.0,0.0,2.0@run-bbbb')!
  assert.equal(ours.description, 'the chair, run B')
  assert.equal(ours.thumbnailDataUrl, 'thumb-b', 'the new image is this object\'s, and the earlier run\'s image is not borrowed')
  assert.equal(ours.arRunId, 'run-bbbbbbbb-cccc')
})

test('upsert: a re-capture inside the run updates its own detection in place, collision or not', async () => {
  const store = new DetectionStore()
  store.startArRun('run-a')
  const key = 'chair:1.0,0.0,2.0'
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  store.startArRun('run-b')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  const [taggedKey] = [...store.currentRunDetections().keys()]
  assert.ok(taggedKey && taggedKey !== key)

  // main.ts merges into currentRunDetections(), so the next capture of that chair arrives under the tagged key.
  const updated = { ...store.currentRunDetections().get(taggedKey!)!, confidence: 0.42 }
  await store.upsert(new Map([[taggedKey!, updated]]), new Map())

  assert.equal(store.detections.size, 2, 'still one detection per run: no second copy, no key with two tags')
  assert.equal(store.detections.get(taggedKey!)?.confidence, 0.42)
  assert.equal(store.detections.get(key)?.arRunId, 'run-a')
})

test('upsert: a tagged key that an earlier run holds is stepped over, never overwritten', async () => {
  const store = new DetectionStore()
  const key = 'chair:1.0,0.0,2.0'
  store.startArRun('run-aaaaaaaa')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  // A second earlier run whose own tag is the same eight characters as the third run's.
  store.startArRun('run-bbbbbbbb-first')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  store.startArRun('run-bbbbbbbb-second')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())

  assert.equal(store.detections.size, 3, 'three runs, three detections, nothing lost')
  assert.deepEqual(labels(store.currentRunDetections()), ['chair:1.0,0.0,2.0@run-bbbb-2'])
  assert.equal(store.previousRunCount(), 2)
})

test('putCapture: a capture is stamped with the run whose frame its pose is in', async () => {
  const store = new DetectionStore()
  const before = await store.putCapture({ captureIndex: 1, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.equal('arRunId' in before, false, 'no run yet, so no field at all (a record from before this looks the same)')

  store.startArRun('run-a')
  const during = await store.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.equal(during.arRunId, 'run-a')
  assert.equal(store.getCapture(during.captureId)?.arRunId, 'run-a')

  await store.attachDetections(during.captureId, ['sofa:0,0,0'])
  assert.equal(store.getCapture(during.captureId)?.arRunId, 'run-a', 'attaching its detections keeps the stamp')
  await store.adoptServerSession('sess-22222222-3333-4444-5555-666666666666')
  assert.equal(store.getCapture(during.captureId)?.arRunId, 'run-a', 'so does the rename to a server session')
})

test('clear() empties both runs\' detections: Clear erases the scan\'s record, not only the run in view', async () => {
  const store = new DetectionStore()
  store.startArRun('run-a')
  await store.upsert(new Map([placed('sofa', 0)]), new Map())
  store.startArRun('run-b')
  await store.upsert(new Map([placed('lamp', 3)]), new Map())
  assert.equal(store.detections.size, 2)

  await store.clear()
  assert.equal(store.detections.size, 0)
  assert.equal(store.currentRunDetections().size, 0)
  assert.equal(store.previousRunCount(), 0)
})

// ── AR runs, second pass (review of WP-02) ───────────────────────────────────

test('upsert: a later run that re-finds an object with no new picture does not inherit the earlier run\'s', async () => {
  const store = new DetectionStore()
  const key = 'chair:1.0,0.0,2.0'
  store.startArRun('run-a')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map([[key, 'thumb-of-run-a']]))

  store.startArRun('run-bbbbbbbb')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())           // this capture made no picture

  const [mine] = [...store.currentRunDetections().values()]
  assert.ok(mine, 'run B has its own detection of the chair')
  assert.equal(mine.thumbnailDataUrl, undefined, 'a picture of run A\'s frame is not this run\'s object')
  assert.equal(store.detections.get(key)?.thumbnailDataUrl, 'thumb-of-run-a', 'and run A keeps its own')
})

test('upsert: a later run\'s own picture is kept across its later captures, under the tagged key', async () => {
  const store = new DetectionStore()
  const key = 'chair:1.0,0.0,2.0'
  store.startArRun('run-a')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map([[key, 'thumb-of-run-a']]))
  store.startArRun('run-bbbbbbbb')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map([[key, 'thumb-of-run-b']]))
  const [taggedKey] = [...store.currentRunDetections().keys()]
  assert.equal(taggedKey, `${key}@run-bbbb`)
  assert.equal(store.detections.get(taggedKey!)?.thumbnailDataUrl, 'thumb-of-run-b', 'the picture is looked up by the key it arrived under, then stored under the tagged one')

  // main.ts merges the next capture into the run's detections, so it arrives under the tagged key with no picture of its own.
  await store.upsert(new Map([[taggedKey!, detection('chair', 1)]]), new Map())
  assert.equal(store.detections.get(taggedKey!)?.thumbnailDataUrl, 'thumb-of-run-b')
})

test('Clear ends the scan, not the run: the next capture is still this run\'s', async () => {
  const store = new DetectionStore()
  const run = store.startArRun('run-a')
  await store.upsert(new Map([['chair:1.0,0.0,2.0', detection('chair', 1)]]), new Map())

  await store.clear()
  assert.equal(store.arRunId, run, 'the camera\'s frame is the same one after a Clear')
  const afterClear = await store.putCapture({ captureIndex: 5, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(afterClear)
  await store.upsert(new Map([['lamp:3.0,0.0,2.0', detection('lamp', 3)]]), new Map())
  assert.deepEqual(labels(store.currentRunDetections()), ['lamp:3.0,0.0,2.0'], 'the lamp found after Clear is in view')
  assert.equal(store.getCapture(afterClear.captureId)?.arRunId, run, 'and its capture row carries the run')
  assert.equal(store.captureCounts('run').total, 1)
})

test('upsert: a detection already stamped by another run keeps that stamp, is not claimed for this run, and is reported', async () => {
  const store = new DetectionStore()
  store.startArRun('run-a')
  const [ka, a] = placed('sofa', 0)
  await store.upsert(new Map([[ka, a]]), new Map())
  store.startArRun('run-b')

  // A caller that merged into the whole record hands run A's sofa back, edited.
  const earlier = { ...store.detections.get(ka)!, confidence: 0.33 }
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    await store.upsert(new Map([[ka, earlier as WorldDetection]]), new Map())
  } finally {
    console.warn = originalWarn
  }

  assert.equal(store.detections.get(ka)?.arRunId, 'run-a', 'still run A\'s: re-stamping it would put its position under run B\'s calibration')
  assert.equal(store.detections.get(ka)?.confidence, 0.33, 'the edit itself is kept')
  assert.equal(store.detections.size, 1, 'written back in its own slot, not duplicated')
  assert.equal(store.currentRunDetections().size, 0, 'and it is not in this run\'s view')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /stamped by another AR run/)
})

test('upsert: a detection stamped by this run is not reported, and one handed over with no run at all carries no stamp field', async () => {
  const store = new DetectionStore()
  const originalWarn = console.warn
  let warned = 0
  console.warn = () => { warned++ }
  try {
    const [k, d] = placed('sofa', 0)
    await store.upsert(new Map([[k, d]]), new Map())
    assert.equal('arRunId' in store.detections.get(k)!, false, 'no run, so not even an undefined field in the record')

    store.startArRun('run-a')
    const [k2, d2] = placed('lamp', 3)
    await store.upsert(new Map([[k2, d2]]), new Map())
    const mine = store.detections.get(k2)!
    await store.upsert(new Map([[k2, { ...mine, confidence: 0.5 } as WorldDetection]]), new Map())
    assert.equal(store.detections.get(k2)?.arRunId, 'run-a')
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warned, 0)
})

test('attachDetections: a capture names the detection of its own run, also when an earlier run holds the plain key', async () => {
  const store = new DetectionStore()
  const key = 'chair:1.0,0.0,2.0'
  store.startArRun('run-aaaaaaaa')
  const capA = await store.putCapture({ captureIndex: 1, timestamp: 1, pose: pose(), blob: frame() })
  assert.ok(capA)
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  await store.attachDetections(capA.captureId, [key])

  store.startArRun('run-bbbbbbbb')
  const capB = await store.putCapture({ captureIndex: 2, timestamp: 2, pose: pose(), blob: frame() })
  assert.ok(capB)
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())   // collides: stored under the tagged key
  await store.attachDetections(capB.captureId, [key, 'lamp:9.0,0.0,9.0'])

  const owner = (captureId: string) => store.getCapture(captureId)!.detectionKeys.map((k) => store.detections.get(k)?.arRunId)
  assert.deepEqual(store.getCapture(capA.captureId)!.detectionKeys, [key], 'run A\'s capture names its own detection')
  assert.deepEqual(store.getCapture(capB.captureId)!.detectionKeys, [`${key}@run-bbbb`, 'lamp:9.0,0.0,9.0'], 'run B\'s names run B\'s, and a key B stored nothing under is left as it was')
  assert.deepEqual(owner(capA.captureId), ['run-aaaaaaaa'])
  assert.deepEqual(owner(capB.captureId), ['run-bbbbbbbb', undefined])
})

test('attachDetections: past a numbered key it still finds the run\'s own, and a capture with no run names its keys as given', async () => {
  const store = new DetectionStore()
  const key = 'chair:1.0,0.0,2.0'
  store.startArRun('run-aaaaaaaa')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  store.startArRun('run-bbbbbbbb-first')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  store.startArRun('run-bbbbbbbb-second')
  const cap = await store.putCapture({ captureIndex: 3, timestamp: 3, pose: pose(), blob: frame() })
  assert.ok(cap)
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  await store.attachDetections(cap.captureId, [key])
  assert.deepEqual(store.getCapture(cap.captureId)!.detectionKeys, [`${key}@run-bbbb-2`])

  // A capture stored before any run was started has no run to follow: its keys are as it was given them.
  const early = new DetectionStore()
  const unstamped = await early.putCapture({ captureIndex: 1, timestamp: 1, pose: pose(), blob: frame() })
  assert.ok(unstamped)
  await early.attachDetections(unstamped.captureId, [key, `${key}@run-xxxx`])
  assert.deepEqual(early.getCapture(unstamped.captureId)!.detectionKeys, [key, `${key}@run-xxxx`])
})

test('attachDetections: a key another run holds, with nothing of this run\'s under it or its tagged form, is named as it was given', async () => {
  const store = new DetectionStore()
  const key = 'chair:1.0,0.0,2.0'
  store.startArRun('run-aaaaaaaa')
  await store.upsert(new Map([[key, detection('chair', 1)]]), new Map())
  store.startArRun('run-bbbbbbbb')
  const cap = await store.putCapture({ captureIndex: 2, timestamp: Date.now(), pose: pose(), blob: frame() })
  assert.ok(cap)
  // The new sighting was merged into a neighbouring detection of this run under some other key, so run B has
  // nothing stored under this key. The capture does not name run A's detection for it, nor a key that does not exist.
  await store.attachDetections(cap.captureId, [key])
  assert.deepEqual(store.getCapture(cap.captureId)!.detectionKeys, [key])
  assert.equal(store.detections.has(`${key}@run-bbbb`), false)
})

test('captureCounts: "run" counts the captures this page\'s run took, and the default still counts the session', async () => {
  const store = new DetectionStore()
  // A capture from before runs were stamped: no run on it.
  const now = Date.now()
  const legacy = await store.putCapture({ captureIndex: 1, timestamp: now, pose: pose(), blob: frame() })
  assert.ok(legacy)
  assert.deepEqual(store.captureCounts('run'), { total: 0, pending: 0, inferred: 0, failed: 0, unusable: 0, retained: 0 }, 'before a run there is nothing of its own')

  store.startArRun('run-a')
  const failedInA = await store.putCapture({ captureIndex: 2, timestamp: now, pose: pose(), blob: frame() })
  assert.ok(failedInA)
  await store.markCaptureFailed(failedInA.captureId, 'engine error')

  store.startArRun('run-b')
  const inB = await store.putCapture({ captureIndex: 3, timestamp: now, pose: pose(), blob: frame() })
  assert.ok(inB)
  await store.attachDetections(inB.captureId, [])

  assert.equal(store.captureCounts().total, 3, 'the session holds all three, as before')
  assert.equal(store.captureCounts('session').failed, 1)
  assert.deepEqual(
    store.captureCounts('run'),
    { total: 1, pending: 0, inferred: 1, failed: 0, unusable: 0, retained: 1 },
    'this run took one, which found nothing and did not fail',
  )
})

test('serverSessionOfThisRun: only a server session this run opened, never a local id or an earlier run\'s', async () => {
  const store = new DetectionStore()
  assert.equal(store.serverSessionOfThisRun, null, 'a fresh store has a local id')

  // Adopted before AR starts (nothing does this in the app): there is no run for it to belong to.
  const early = 'sess-00000000-0000-4000-8000-000000000001'
  assert.equal(await store.adoptServerSession(early), true)
  assert.equal(store.sessionId, early)
  assert.equal(store.serverSessionOfThisRun, null, 'no run yet')
  store.startArRun('run-a')
  assert.equal(store.serverSessionOfThisRun, null, 'and one opened before the run began is not the run\'s')
  assert.equal(await store.adoptServerSession(early), true, 'naming the id that is already live is a no-op')
  assert.equal(store.serverSessionOfThisRun, null, 'and does not make it this run\'s')

  const opened = 'sess-00000000-0000-4000-8000-000000000002'
  assert.equal(await store.adoptServerSession(opened), true)
  assert.equal(store.serverSessionOfThisRun, opened, 'streamed in this run')
  assert.equal(store.sessionId, opened)

  store.startArRun('run-b')
  assert.equal(store.sessionId, opened, 'the record is still keyed by it')
  assert.equal(store.serverSessionOfThisRun, null, 'a new run in the page is a new frame, so the keyframes of the old one are not its own')

  const again = 'sess-00000000-0000-4000-8000-000000000003'
  await store.adoptServerSession(again)
  assert.equal(store.serverSessionOfThisRun, again)
  assert.equal(await store.adoptServerSession('local-not-a-server-id'), false)
  assert.equal(store.serverSessionOfThisRun, again, 'a refused id changes nothing')
})
