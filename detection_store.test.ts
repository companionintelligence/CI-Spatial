/**
 * DetectionStore.upsert() — which thumbnail a re-captured detection keeps.
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
import { DetectionStore } from './src/scene/store.ts'
import type { WorldDetection } from './src/spatial/resolver.ts'

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
