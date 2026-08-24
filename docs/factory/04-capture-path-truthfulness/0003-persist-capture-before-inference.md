> **Type:** Frontend
> **Wave:** 04-capture-path-truthfulness
> **Branch:** `fix/persist-capture-before-inference`
> **Commit style:** `fix(capture): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None to implement. Easiest to *observe* alongside 0004, which removes
> the toggle that currently makes the failure trivially reproducible.

## Goal

Stop destroying a capture when detection fails. Persist the frame, pose and timestamp as
soon as they are captured, and attach detections to that record afterwards — so an
inference failure costs a label, not the photograph.

## The defect, precisely

The capture handler in `src/main.ts` runs in this order:

| line | call | on inference failure |
|---|---|---|
| 334 | `const rawDets = await router.infer(blob)` | **throws** |
| 375 | `capture.captureDetectionThumbnail(blob, wd.bbox)` | skipped |
| 378 | `await store.upsert(merged, thumbMap)` | skipped — **the only persistence** |
| 380 | `showInferDialog(worldDets)` | skipped — the preview |
| 382 | `captureCount++` | skipped |
| 383 | `await store.saveSnapshot()` | skipped |
| 384 | `queueAutoSave()` | skipped |

`blob` is a local. When `router.infer()` throws, it goes out of scope and the frame is gone.
Nothing reached the store, so there is nothing for the preview or the Object Report to
render, and the capture counter never advanced.

Observed on a Lume Pad 2, 2026-08-18: six captures taken with the WebGPU engine selected,
all six logging `[main] Captured blob: 140842 bytes`, **zero** retained. From the user's
side the shutter worked six times and the app showed nothing — the reported symptom was
"the app doesn't show any of the six real captures in the preview or object report".

The catch block (`src/main.ts:390-440`) does set HUD text — the WebGPU error matches none
of the typed branches and lands on the final `else`, `'Capture failed — try again'`. So the
app is not *silent*, but it is **lossy**, and the message invites a retry of the one thing
that cannot be retried: being in that spot with the camera pointed at that thing.

## Why this is the ordering, not the error handling

The frame is the expensive, unrepeatable half of a capture. The user had to physically be
there. Detection is cheap, deterministic-ish, retryable, and — as ticket 0001 documents —
was until recently *wrong 82% of the time*. The current order makes the cheap, unreliable
step a precondition for durably storing the expensive, reliable one.

Fixing it also buys three things the app does not have today:

- **Retry** — a failed detection can be re-run against the stored frame, offline or later
- **Offline capture** — frames can be taken with no server and inferred on reconnect,
  which is what `public/sw.js`'s offline queue already implies the product wants
- **Diagnosis** — a frame that produced a bad detection can be inspected. Every frame
  behind the 219 fabricated scans in `worlds/default.json` is unrecoverable.

## Non-goals

- Do not build a retry *UI* in this ticket. Persist the frame and make re-inference
  possible; surfacing "3 captures pending detection" is a follow-up with its own design.
- Do not change `router.infer()`'s error types or the catch block's HUD copy. The copy
  should change once retry exists — promising a retry that does nothing is worse than the
  current message.
- Do not change the autosave/`queueAutoSave()` cadence or the GLB export path.
- Do not add a new persistence layer. `src/scene/store.ts` and its IndexedDB database
  already own captured state — see Pinned conventions and the `Do not rename` table in
  CLAUDE.md.
- Do not fix the stale-camera-frame defect here; that is ticket 0005. This ticket assumes
  the blob it is handed is whatever the provider produced, correct or not.

## Pinned conventions

**ADR 0001** — this changes what is persisted, so it states what it extends. Verified at
`489cdcd`:

| Existing | Where | How used |
| --- | --- | --- |
| `store` / `DetectionStore` | `src/scene/store.ts` | **extended**, not replaced. A capture record is added alongside detections; no second store is introduced |
| IndexedDB name `'ci-xr-scan'` | `src/scene/store.ts` | unchanged — CLAUDE.md lists it as load-bearing; renaming orphans every existing user's data |
| `store.upsert(merged, thumbMap)` | `src/main.ts:378` | kept for the detection half; the frame half is persisted earlier |
| `store.saveSnapshot()` | `src/main.ts:383` | reused as the snapshot boundary |
| `capture.captureDetectionThumbnail(blob, bbox)` | `src/capture/capture.ts:133` | unchanged; it needs a bbox, so it stays on the post-inference path |
| `RawFrame` / `Pose` | `src/ar/provider.ts` | reused as the shape of what gets stored; no parallel type |
| `checkStorageQuota(store, overlay)` | `src/main.ts:386` | **must** be considered — storing every frame changes the quota profile materially. See Risks |

New persisted state must extend the existing store, per ADR 0001. Do not introduce a
`CaptureRecord` that duplicates fields `WorldDetection` or `RawFrame` already carry.

## Before implementation

- `src/main.ts:315-445` — the whole capture handler, try block and catch block together
- `src/scene/store.ts` — the store's schema, `upsert`, `saveSnapshot`, and how thumbnails
  are keyed today
- `src/capture/capture.ts:40-90` — what the blob already is (JPEG, 1280 px long edge,
  quality 0.8) and what a stored frame would cost
- `src/inference/router.ts:125-166` — which failures throw vs which fall back to the server;
  only the timeout path currently degrades gracefully
- CLAUDE.md, `Do not rename` — before touching anything in `src/scene/store.ts`

## Open questions — answered

Settled 2026-08-18 against `2e2e532`, before any code was written.

- **Q: Store every capture's full JPEG, or only those whose inference failed?**
  **A: every capture**, into a new object store, under a bounded eviction policy. Storing
  only failures makes the write conditional on an outcome that has not happened yet —
  either the blob is buffered and written from the catch, which reintroduces the very loss
  window this ticket closes (merely narrowed to a crash), or it is written and then
  deleted, which is the same write plus a delete. Uniform storage also keeps the success
  path able to explain itself, and that is the diagnosis case: the frame worth inspecting
  is usually one that *succeeded* and returned something wrong. Quota is answered by
  bounding what is retained, not by refusing to store — see Eviction below.

  **Refined 2026-08-19.** Every capture is still *recorded*, but one whose inference failed
  **and** whose frame the quality monitor had already flagged — `lowLight` or `reflective`
  from `analyseFrame` (`src/capture/quality-monitor.ts`) — does not keep its **image**.
  Re-running detection on a frame too dark to read reproduces the same failure, so the JPEG
  buys nothing and the record alone carries the count. This is a correlation, not a proven
  cause: the router does not fail *because of* quality, so a dark frame captured during a
  server outage is discarded too. That is the intended trade — an unreadable frame is not
  worth 140 KB of a user's quota, and the capture is still represented either way.

- **Q: Does a stored-but-uninferred capture appear in the Object Report?**
  **A: yes, as a count, not as an object.** It carries no labels, so it cannot become a row
  in the object table without inventing one. `exportSessionSummary`
  (`src/export/summary.ts`, wired at `src/main.ts:209`) already prints a `| Captures | n |`
  row sourced from `captureCount`; that row gains its pending and failed breakdown, and a
  line naming what the failures cost. This is the minimum that satisfies "represented, not
  silently absent" without the retry UI the non-goals exclude.

- **Q: Should the offline queue in `public/sw.js` carry pending inferences?**
  **A: no — it structurally cannot.** The queue replays *outgoing* writes and discards what
  comes back: `public/sw.js:188-196` answers a queued request with a synthetic 202 carrying
  `X-Companion-Queued-Offline` and no body. Detections arrive **in the response** to the
  inference call, so a replayed inference would succeed on the wire and deliver its result
  nowhere. Reuse was the ADR 0001 default and was checked first; the shapes genuinely
  differ, so pending inference is tracked by capture-record `status` in the scan store
  instead. `public/sw.js` is unchanged by this ticket.

## Files impacted

Changed:
- `src/scene/store.ts` — the `'captures'` object store, its record type, and eviction
- `src/main.ts` — capture handler ordering; the failure path marks its record
- `src/capture/quality-monitor.ts` — `isFrameUnusable()`, one definition of "not worth keeping"
- `src/export/summary.ts` — the `| Captures |` row reports pending, failed and discarded

Settled as unchanged (see Open questions):
- `src/capture/capture.ts` — the blob it returns is already the right shape to store
- `public/sw.js` — its queue cannot carry a call whose result comes back in the response

## Schema pinned

Extends the existing scan store. Same IndexedDB database — `'ci-xr-scan'`, still sourced
from `SCAN_DB_NAME` in `src/shared/storage-keys.ts`, not renamed — with a **second object
store** alongside `'sessions'`, and `DB_VERSION` 1 → 2 for an additive `onupgradeneeded`.
Existing records continue to open untouched.

A separate object store rather than a field on the session record, because of how
`persist()` writes (`src/scene/store.ts:296`): it rewrites the *entire* session record on
every mutation — `idbPut(db, { sessionId, startedAt, detections: [...entries] })`. Frames
held inside that record would be rewritten on every capture, so capture #50 would push
50 × ~140 KB through IndexedDB on a single shutter press. One record per capture makes
each write O(1).

`objectStore: 'captures'`, `keyPath: 'captureId'`:

| field | type | why |
| --- | --- | --- |
| `captureId` | `string` | stable key; `<sessionId>-c<n>` so it sorts and names its origin |
| `sessionId` | `string` | which session owns it; matches `Session.sessionId` |
| `captureIndex` | `number` | the existing `WorldDetection.captureIndex` (`src/spatial/resolver.ts:27`) — detections already map onto captures, so no new correlation id is introduced |
| `timestamp` | `number` | `CaptureResult.timestamp`, straight through |
| `pose` | `CaptureResult['pose']` | reused as-is from `src/capture/capture.ts`; no parallel pose type |
| `blob` | `Blob \| null` | the JPEG. `null` once evicted — the record outlives the frame |
| `byteSize` | `number` | recorded at write time so the budget still sums after `blob` is gone |
| `status` | `'pending' \| 'inferred' \| 'failed'` | the only genuinely new field. Drives eviction order and the report counts |
| `detectionKeys` | `string[]` | the `label:bucket(worldPos)` keys this capture produced |
| `error` | `string?` | why inference failed, on the failed path |
| `frameDropped` | `'quality' \| 'budget'?` | why `blob` is gone, when it is. Absent while the frame is held, so a missing frame always explains itself |

`detectionKeys` holds keys, not detections: the detection bodies stay in `'sessions'` where
they already live, and a capture points at them. Nothing `WorldDetection` or
`CaptureResult` already carries is re-declared.

### Eviction

Modelled on the offline queue's bounds in `public/sw.js:59-60` (`MAX_QUEUE_ITEMS` /
`MAX_QUEUE_AGE_MS`), with one deliberate difference: that queue avoids a byte budget
because summing one would mean reading every queued body into memory
(`public/sw.js:52-58`). Here `byteSize` is already on the record, so a byte budget costs
nothing — and bytes, not item count, are what quota actually measures.

- Drop the **image** outright, at the moment of failure, when a capture's inference failed
  and `isFrameUnusable()` says the frame was the problem. This is not part of the budget —
  it runs whether or not there is pressure, because such a frame has no retry value
- Release **blobs** (record kept, `blob` → `null`) once retained frames exceed
  `MAX_CAPTURE_BYTES` (64 MB), or a frame is older than `MAX_CAPTURE_AGE_MS` (7 days)
- Delete **records** beyond `MAX_CAPTURE_ITEMS` (512), oldest first
- Order: oldest `'inferred'` first — they have already yielded their detections, so what is
  lost is diagnosis, not data. Only once none remain are `'failed'` records touched; those
  are the evidence this ticket exists to preserve
- **`'pending'` is never evicted, at any budget.** A pending record is a frame whose
  inference has not resolved, and dropping it is precisely the original bug

## Definition of Done

- [x] A capture is durably stored before `router.infer()` is called
- [x] An inference failure leaves the capture present and inspectable
- [x] Detections attach to the existing capture record rather than creating a second one
- [x] The success path stores exactly one record per capture (no duplicates)
- [ ] Storage quota behaviour is measured and `checkStorageQuota` still fires correctly
- [x] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [x] Unit: a capture whose inference rejects is still retrievable from the store
- [x] Unit: a capture whose inference succeeds yields one record carrying its detections
- [x] Extend `detection_store.test.ts` rather than adding a parallel spec file
- [ ] Manual: with the server stopped, take three captures; all three survive a reload

```
npx tsc --noEmit
npm run test:store
npm run verify
```

## Acceptance Criteria

- [ ] Given inference fails, When the user opens the Object Report, Then the capture is
      represented — not silently absent
- [ ] Given inference fails, When the app is reloaded, Then the capture is still there
- [ ] Given the server is unreachable for three captures and then returns, Then those three
      captures can be inferred without re-photographing anything
- [ ] Given a successful capture, Then behaviour is unchanged from today

## Risks / potential issues

- **Risk:** Storing every frame changes the storage profile sharply. At ~140 KB per JPEG, a
  long session is tens of MB, and `checkStorageQuota` exists because quota is already a live
  concern. — **Mitigation:** This is the first open question. Consider storing frames only
  until their detections land, then dropping the blob and keeping the record.
- **Risk:** Writing to IndexedDB before inference adds latency to the shutter, which already
  has no flash, haptic or sound (a known weakness in `../../product/UI_MANUAL.md:169-176`). —
  **Mitigation:** The write is off the critical path — fire it without awaiting before
  `router.infer()`, and reconcile on completion.
- **Risk:** Touching `src/scene/store.ts` risks the IndexedDB name and the persisted shape,
  both load-bearing per CLAUDE.md. — **Mitigation:** Additive schema change only; no rename,
  no field removal. Existing records must continue to open.
- **Risk:** Partial records leak if the app is killed between the frame write and the
  detection write. — **Mitigation:** Define the record as valid without detections; that is
  the entire point of the change.

## Subtasks

1. [x] Answer the three open questions, especially the quota one
2. [x] Pin the capture-record schema as an extension of the existing store
3. [x] Persist frame + pose + timestamp before `router.infer()`
4. [x] Attach detections to the existing record on success
5. [x] Make the failure path leave a complete, inspectable record
6. [x] Extend `detection_store.test.ts`
7. [ ] Measure quota impact across a realistic session
8. [ ] Re-verify on-device with the server deliberately stopped
