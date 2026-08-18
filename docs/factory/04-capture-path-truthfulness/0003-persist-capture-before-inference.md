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

## Open questions & answers

- Q: Store every capture's full JPEG, or only those whose inference failed? — OPEN. Storing
  all is simpler, uniform, and unlocks retry and diagnosis; storing only failures is far
  cheaper but leaves the success path unable to explain itself. Quota (see Risks) probably
  decides this. **Answer before coding.**
- Q: Does a stored-but-uninferred capture appear in the Object Report? — OPEN. It has no
  labels, so it is not an object; but a capture that vanishes from every surface is the
  current bug. Likely a distinct "pending" affordance, which argues for scoping the UI
  follow-up at the same time.
- Q: Should the existing offline queue in `public/sw.js` carry pending inferences? — OPEN.
  It already exists for uploads and CLAUDE.md flags its cache names as load-bearing. Reusing
  it is the ADR 0001 answer; confirm it can carry this shape before assuming so.

## Files impacted

Changed:
- `src/main.ts` — capture handler ordering
- `src/scene/store.ts` — capture-record persistence

Possibly changed (settle the open questions first):
- `src/capture/capture.ts`
- `public/sw.js`

## Schema required

To be pinned once the first open question is answered. Constraints that hold either way:

- Extends the existing store; no new IndexedDB database, no rename of `'ci-xr-scan'`
- Must carry enough to re-run inference later: the JPEG blob, the capture `Pose`, the
  capture timestamp, and the session id
- Must be reconcilable with the detections that arrive afterwards — a stable capture id
  that `WorldDetection.captureIndex` (`src/main.ts:369`) can already be mapped onto

## Definition of Done

- [ ] A capture is durably stored before `router.infer()` is called
- [ ] An inference failure leaves the capture present and inspectable
- [ ] Detections attach to the existing capture record rather than creating a second one
- [ ] The success path stores exactly one record per capture (no duplicates)
- [ ] Storage quota behaviour is measured and `checkStorageQuota` still fires correctly
- [ ] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [ ] Unit: a capture whose inference rejects is still retrievable from the store
- [ ] Unit: a capture whose inference succeeds yields one record carrying its detections
- [ ] Extend `detection_store.test.ts` rather than adding a parallel spec file
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
  has no flash, haptic or sound (a known weakness in `docs/UI_MANUAL.md:169-176`). —
  **Mitigation:** The write is off the critical path — fire it without awaiting before
  `router.infer()`, and reconcile on completion.
- **Risk:** Touching `src/scene/store.ts` risks the IndexedDB name and the persisted shape,
  both load-bearing per CLAUDE.md. — **Mitigation:** Additive schema change only; no rename,
  no field removal. Existing records must continue to open.
- **Risk:** Partial records leak if the app is killed between the frame write and the
  detection write. — **Mitigation:** Define the record as valid without detections; that is
  the entire point of the change.

## Subtasks

1. [ ] Answer the three open questions, especially the quota one
2. [ ] Pin the capture-record schema as an extension of the existing store
3. [ ] Persist frame + pose + timestamp before `router.infer()`
4. [ ] Attach detections to the existing record on success
5. [ ] Make the failure path leave a complete, inspectable record
6. [ ] Extend `detection_store.test.ts`
7. [ ] Measure quota impact across a realistic session
8. [ ] Re-verify on-device with the server deliberately stopped
