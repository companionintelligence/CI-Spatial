> **Type:** Frontend + Backend
> **Wave:** 09-ground-anchor-calibration
> **Branch:** `feat/calibration-reference-photos`
> **Commit style:** `feat(ar): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0002 (two-point schema) — **landed**. 0004 (the staged capture flow this
> hooks into) — **landed**. This ticket is unblocked.

## Goal

Capture a reference photo at each marker placement — landmark and heading marker — store them
per Place, and show them back on a return visit so the user re-places both markers on the same
physical spots. This attacks the re-acquisition half of cross-session error, which no other
ticket in this wave addresses.

## Why this is the other half of the error budget

Ticket 0006 frames cross-session error as:

> within-session drift **+** re-acquisition error (did the user place the landmark on the same
> physical spot?)

Everything else in this wave works on the first term. 0006 instruments drift, 0003 stabilises the
ground plane, 0004 removes the compass from the frame. **Nothing reduces the second term** —
today a returning user re-finds the landmark from memory, unaided, and any error there enters
the frame directly as a translation and (via the heading marker) a rotation.

A photo taken from where the user stood, with the exact tap point marked on it, converts that
from recall into recognition. It is also the cheapest term to attack: the capture, encode, and
upload machinery all already exist (see Pinned conventions) — this ticket is mostly wiring.

## Why a photo and not the stored points themselves

The obvious request is: the Place already has reference points, so draw them in AR when the
user comes back. That is not achievable, and the reason belongs here so it is not re-proposed
every time someone reads the schema.

A committed two-point frame stores:

```
landmark:      { x: 0, y: 0, z: 0 }
headingMarker: { x: 0, y: 0, z: separationM }
```

Those are project-space coordinates, and they are **tautological by construction** — the
landmark *is* the origin and the marker *is* on +Z at `separationM`. They carry no information
about where those points sit in the room.

Drawing them in a new session requires a transform from that session's arbitrary local
coordinates into project space. That transform is `sessionToProject` — precisely what
calibration produces. So the overlay would need the alignment, and the alignment is what the
overlay was supposed to help produce. No storage schema resolves this; bridging it is
relocalization (image targets, VPS, or persistent cloud anchors), which ticket 0004's open
questions already defer to a ticket of its own.

A photo sidesteps the circularity entirely, because recognition needs no transform.

## The return-visit flow

1. Stage 1 shows **photo A** with its crosshair. The user walks there and taps → landmark placed.
2. Stage 2 shows **photo B**. The user walks and taps → heading marker placed.
3. A candidate `sessionToProject` now exists. The re-measured separation is checked against the
   stored `separationM` within `toleranceM` (ticket 0004).
4. **Only now** can the stored reference points be drawn, because only now does the transform
   exist. Render both markers — and, where available, the previous scan — as confirmation the
   user is standing in the same frame as last time.

Step 4 is what satisfies "the reference points must show when the user opens the project
again". They appear as **verification after re-placement**, not as guidance before it. That
ordering is forced by the geometry rather than chosen, and the copy should not imply otherwise.

## Non-goals

- Do not do image-based relocalization, feature matching, or any automatic pose recovery from
  the photo. The photo is a **visual aid for a human**, not an input to the transform. Genuine
  automatic re-acquisition is image targets / VPS anchors — named in ticket 0004 as the reason
  the cited two-point reference exists at all, and out of scope for this wave.
- Do not embed image data in the `Project` JSON body. `PUT /projects/:id` (`main.ts:4066`)
  round-trips the whole record; base64 photos would bloat every project read and write. Store
  bytes separately, reference by URL.
- Do not block calibration on photo capture or upload succeeding. A failed capture, a denied
  camera frame, or an offline device must degrade to today's behavior, not trap the user.
- Do not add photos to the `'ground-tap-compass'` fallback member. That tier has no
  cross-session verification story at all (ticket 0002); adding a re-acquisition aid to it
  would imply one.
- Do not attempt to render the stored reference points as an AR overlay *before* calibration
  completes — it is circular, for the reason above. Drawing them after step 3 is in scope and
  required.
- Do not build a photo gallery, editing, or re-shoot UI in the World Editor. Capture-side only.
- Do not change `CaptureModule`'s existing encoding defaults or `captureFrame()`'s queue
  semantics.

## Pinned conventions

**ADR 0001** — touches schema and adds a client↔server connection. What is reused:

| Existing | Where | How used |
| --- | --- | --- |
| `CaptureModule.capture()` | `src/capture/capture.ts:50` | the encode path — RGBA → `ImageBitmap` → `OffscreenCanvas` → JPEG, with the existing `maxLongEdgePx` / `jpegQuality` / `MAX_BLOB_BYTES` fallback. Do not write a second encoder. |
| `CaptureResult.pose` | `src/capture/capture.ts:11` | already returned; stored so the vantage point is recoverable |
| `CaptureModule.captureThumbnail()` | `src/capture/capture.ts:79` | 256 px data-URL thumbnail for the local/offline preview |
| multipart `image` + `meta` upload | `POST /sessions/:id/keyframes` (`main.ts:800-841`) | the exact request shape and validation pattern the new route copies |
| `ProjectStore` / `ci-xr-projects` | `src/project/project-store.ts` | local persistence; **DB_VERSION must bump 1 → 2** for a new object store |
| `projectStore.updateProject()` + `PUT /projects/:id` | `src/main.ts`'s `projectStore.updateProject()` + `persistProjectSpatialFrame()` path | the existing Place write path for the frame's URL references |

**New route naming** follows the existing per-resource sub-path convention
(`/sessions/:id/keyframes`, `/projects/:id/merge`): `POST /projects/:id/reference-photos` and
`GET /projects/:id/reference-photos/:file`.

**Server storage** follows the `sessionDir()` pattern (`main.ts`): a per-project directory,
path-validated against traversal exactly as `sessionDir()` does — reuse that helper's approach
rather than re-deriving path safety.

**Blob-in-IndexedDB precedent**: `DetectionStore`'s `captures` store already persists image
blobs (`src/scene/store.ts`), so storing a `Blob` rather than a data URL is the established
choice.

**Do not rename** `ci-xr-projects` (CLAUDE.md's protected-identifier list). Adding an object
store via a version bump is additive and safe; renaming the database is not.

## Before implementation

- `src/capture/capture.ts:39-95` — `capture()` and `captureThumbnail()`.
- `main.ts:800-841` — the keyframe multipart handler, the shape to copy.
- `main.ts:4037-4086` — `GET`/`PUT /projects/:id`, and how a Place record round-trips.
- `src/project/project-store.ts:1-60` — DB name, version, and the `onupgradeneeded` block that
  must gain the new store.
- `src/ar/project-calibration.ts` — the `CalibrationOptions` shape and the placement flow
  ticket 0004 restructures.
- `src/shared/offline-queue.ts` — the existing offline upload queue, for the degradation path.

## Open questions & answers

- Q: A photo alone shows a wall or a stretch of floor — how does the user know *which* spot? —
  A: It does not, and this is the detail that makes the feature work or not. Store the tap's
  **normalised screen coordinates** alongside the image, and render a crosshair over the photo
  at those coordinates when showing it back. The tap coords are already computed in
  `runProjectCalibration()`'s `placeAt(x, y)` and currently discarded after the hit-test —
  capturing them costs nothing. Without this the feature is a vague hint; with it,
  it points at the spot. (Decided in this ticket.)
- Q: Local-only, or uploaded? — A: Both. Local IndexedDB makes it work offline and instantly;
  the server copy is what makes it work on a *different device*, which is the whole reason
  `spatialFrame` is synced via `PUT /projects/:id` at all. A Place calibrated on one phone and
  re-scanned on another is a real scenario for this app's fleet. (Decided in this ticket.)
- Q: What if the upload fails or the device is offline? — A: Keep the local copy, store the
  URL as pending, and let the existing offline queue retry. The calibration itself completes
  regardless — the photo is an aid, never a gate. A frame whose photo never uploaded is
  degraded, not invalid, and the UI should say so rather than silently showing nothing on the
  next device. (Decided in this ticket.)
- Q: Photo of the marker, or of the view *from* where the user stood? — A: The camera frame at
  the moment of placement, which is the view from where they stood, with the marker's tap point
  crosshaired. Storing `CaptureResult.pose` alongside means a future ticket could guide the user
  back to the same vantage; that is not built here, but the data costs nothing to keep and is
  unrecoverable later. (Decided in this ticket.)
- Q: Does capturing a frame mid-calibration conflict with anything? — A: `captureFrame()`
  rejects with "Capture already pending" if one is in flight, so this needs an answer.
  **Re-checked after ticket 0003 landed, because 0003 invalidated the original reasoning.**
  This ticket first argued "calibration runs before the scanner starts, so nothing is
  queued" — 0003 moved `scanner.start()` *ahead* of calibration (it had to; the ground gate
  had no data otherwise), so that sentence is no longer true.
  The conclusion survives on different grounds: `RoomScanner` only ever calls
  `provider.featurePoints()`, never `captureFrame()`, so it does not touch the capture queue
  at all; and `AutoCapture`, which does, is constructed before calibration but is opt-in and
  cannot be toggled while the modal covers the screen. So the queue is still free during
  calibration. Handle the rejection anyway — treat it as a failed photo, not a failed
  calibration. (Decided in this ticket; **re-verified 2026-08-24** against the post-0003
  ordering. Worth re-checking again after 0004 restructures the flow.)
- Q: Should the photo be re-captured when a marker is re-placed during adjustment (0004's
  tap-near flow)? — A: Yes — the photo must match the committed position or it actively
  misleads on the next visit. Capture on commit, not on each provisional placement, so
  adjustment does not burn frames. (Decided in this ticket.)
- Q: Storage growth? — A: Two photos per Place, replaced on re-calibration rather than
  appended. At the existing encode defaults that is a few hundred KB per Place — negligible
  against the scans themselves. No pruning policy needed. (Decided in this ticket.)

## Files impacted

New:
- none (all changes extend existing files)

Changed:
- `src/world/types.ts` (the `referencePhotos` field on 0002's two-point member)
- `src/project/project-store.ts` (DB_VERSION 1 → 2; new `referencePhotos` object store; CRUD)
- `src/ar/project-calibration.ts` (capture on commit; show stored photo per stage)
- `src/main.ts` (pass a capture accessor into `CalibrationOptions`; upload + persist)
- `index.html` (reference-photo panel with crosshair overlay, in the calibration card)
- `main.ts` (the two new routes)

## Schema required

Extends ticket 0002's `'two-point-ground'` member only:

```ts
export interface CalibrationReferencePhoto {
  /** Server URL, once uploaded. Null while pending or if upload never succeeded. */
  url: string | null
  /** Local IndexedDB key for the blob — always present on the capturing device. */
  localKey: string
  /** Normalised 0-1 screen coords of the tap within this frame; a crosshair is drawn here. */
  tapPoint: { x: number; y: number }
  /** Camera pose at capture, so the vantage point is recoverable later. */
  pose: { position: Vec3; rotation: Quat }
  capturedAt: string
}

// on the 'two-point-ground' member:
/**
 * Reference photos of each marker's physical setup, shown on a return visit
 * so the user re-places on the same spots. Purely a human aid — never an
 * input to the transform. Absent when capture or upload failed, which
 * degrades re-acquisition but does not invalidate the frame.
 */
referencePhotos?: {
  landmark: CalibrationReferencePhoto
  headingMarker: CalibrationReferencePhoto
}
```

Reuses `Vec3`/`Quat` (`src/world/types.ts:157-168`). Optional, so every frame written before
this ticket stays valid with no migration.

**IndexedDB** (`ci-xr-projects`, version 1 → 2): new object store `referencePhotos`,
`keyPath: 'localKey'`, holding `{ localKey, projectId, blob, thumbDataUrl, capturedAt }`, with
an index `byProject` on `projectId` matching the `scans` store's existing index convention.
The `onupgradeneeded` handler must create it without touching the existing two stores — the
existing `if (!db.objectStoreNames.contains(...))` guards already make this safe.

**Server**: `POST /projects/:id/reference-photos` — multipart `image` (File) + `meta` (JSON
string with `role: 'landmark' | 'headingMarker'`, `tapPoint`, `pose`), mirroring
`/sessions/:id/keyframes`'s validation. Writes to a per-project directory, returns `{ url }`.
`GET /projects/:id/reference-photos/:file` serves it back, path-validated.

## Definition of Done

- [x] A photo is captured on commit of each marker (not on provisional placement), with tap
      coords and pose — landmark on **Confirm landmark**, heading marker on **Use this
      alignment**, which are the two moments the user is still standing where they tapped.
      Re-placing a marker discards any photo already taken for it, because a photo of the
      previous spot is worse than none
- [x] Photos persist locally in the new `referencePhotos` store; `DB_VERSION` bumped to 2 with
      the existing stores untouched — proved against a **populated v1 database** in
      `tests/mock-project-store-upgrade.spec.ts`, not just a fresh one
- [x] Photos upload via the new route; the returned URL is stored on the frame and synced
      through the existing `PUT /projects/:id` path
- [x] Upload failure or offline leaves the local copy, marks the URL pending, and does not
      block calibration
- [x] On a return visit, each placement stage shows its stored reference photo with a
      crosshair at the recorded tap point
- [x] A frame whose photos are missing or un-uploaded says so rather than showing an empty
      panel — three distinct messages: no photo was ever taken, the photo never finished
      uploading and this is not the device that took it, or the load failed
- [x] Re-calibration replaces both photos rather than appending — the local key and the
      server filename are both derived from `(place, role)`, so replacement is structural
      rather than a cleanup step that can be forgotten
- [x] `pointLabels` is captured alongside each photo and shown with it on return
- [x] Both committed markers stay rendered in the AR scene for the rest of the session, not
      only the landmark
- [x] After a successful separation check, both stored markers are drawn in the live scene as
      confirmation (step 4 of the return-visit flow)
- [x] Photos are never read by any transform or verification code path — `sessionToProject` is
      built only by `twoPointToProjectTransform(landmark, headingMarker)` and
      `anchorToProjectTransform(landmark, bearingDeg)`; the sole reader of `referencePhotos`
      is the calibration panel
- [x] `npx tsc --noEmit`, `deno task check`, `deno task test` pass

## Tests

- [x] Deno (server): `POST /projects/:id/reference-photos` accepts a valid multipart body and
      returns a URL; rejects a missing `image`, a missing/invalid `meta`, and an unknown `role`
- [x] Deno (server): `GET` serves the stored bytes; a traversal attempt in `:file` is rejected.
      **Checked first, as asked, and the answer changed the split:** `/sessions/:id/keyframes`
      has no Deno coverage at all — its routes are exercised through `api-*` Playwright specs,
      and only its *shape* helpers are unit-tested (`session_id.ts`). So this mirrors that
      exactly: `tests/unit/deno/reference_photos.test.ts` proves the path/role/meta logic in
      `server/project_media.ts` (which exists separately from `main.ts` for the same reason
      `session_id.ts` does — `main.ts` cannot be imported without running `Deno.serve`), and
      `tests/api-reference-photos.spec.ts` proves the routes are wired to it and the bytes
      survive a round trip
- [x] Deno: the new test file is registered. Note the task is `deno test … tests/unit/deno/` —
      a **directory**, not the file list the ticket assumed, so dropping the file in registers it
- [x] Unit: crosshair placement maps normalised tap coords to pixel coords for a given rendered
      photo size — and, more importantly, the canvas→frame step in front of it. The tap is
      normalised against the canvas while the photo is the cover-cropped camera frame, so the
      naive value is wrong by however much the crop removed; `viewportPointToImagePoint` is
      tested as the exact inverse of the existing `imagePointToViewportPoint`
- [x] Playwright (`tests/`): with a stored frame carrying photos, the calibration overlay
      renders the reference panel; with a frame lacking them, it renders the explanatory empty
      state and calibration still completes. Also covers the second-device path (server copy
      only, no local blob) and that stage 2 shows point B's photo rather than point A's
- [x] ~~Manual~~ automated: `context.setOffline(true)` mid-calibration → calibration completes,
      both blobs are in IndexedDB, and both URLs record as pending. Deliberately browser-level
      offline rather than a Playwright route: `/projects` is a queueable prefix in
      `public/sw.js`, so the upload goes through the service worker and page-level
      interception never sees it — the first attempt at this test passed a route-abort straight
      through to the server
- [ ] **On-device, not run:** calibrate a Place with photos; return in a fresh session on a
      **second device**; confirm the photos load from the server and materially help
      re-placement. Record the `separationM` spread with photos available versus ticket 0006's
      Procedure 2 baseline without them — this is the measurement that says whether the
      feature actually reduced re-acquisition error. **It cannot be run yet:** 0006's
      Procedure 2/2a baseline was never taken (that ticket closed unrun), so there is nothing
      to compare against. Taking the baseline is the blocker, not this feature

```bash
npx tsc --noEmit && deno task check && deno task test
npx playwright test tests/ar-scan.spec.ts
```

## Acceptance Criteria

- [x] Given a first calibration, When both markers are committed, Then two photos are captured,
      stored locally, and uploaded
- [x] Given a return visit, When the landmark placement stage opens, Then its reference photo
      is shown with a crosshair on the recorded tap point
- [x] Given the heading-marker stage, Then its own photo is shown, not the landmark's
- [x] Given an offline device, When calibration runs, Then it completes, the photo is stored
      locally, and the pending state is visible rather than silent
- [x] Given a second device opening the same Place, Then the photos load from the server
      (covered headlessly — no local blob exists for the Place, so only the server copy can
      satisfy the panel; the real two-device run is the unrun on-device item above)
- [x] Given a Place calibrated before this ticket, Then calibration runs exactly as it does
      today with an explanatory empty state, no crash and no migration
- [x] Given any code path that builds `sessionToProject`, Then it does not read
      `referencePhotos`

## Risks / potential issues

- **Risk (this ticket's reason for existing):** `separationM` proves the two points were *the
  right distance apart*, never that they were *the same two points*. Two wrong-but-equidistant
  features pass. Tapping the correct pair in the **reverse order** also passes — while rotating
  the frame exactly 180° — and the check reports `'verified'` in both cases. — **Mitigation:**
  this is the failure photos and `pointLabels` exist to attack, and it is the argument for the
  ticket rather than a footnote to it. The residual cannot detect it; only the user can, and
  only if given something to recognise. Because order determines the frame's rotation, the panel
  must make unmistakably clear which photo is A and which is B.
- **Risk:** A reference photo creates false confidence — the user matches the photo's *view*
  and assumes the tap is therefore in the right place, when matching a wide shot by eye is
  worth perhaps tens of centimetres. — **Mitigation:** the crosshair is what makes it precise
  rather than suggestive, and the on-device test above measures whether the `separationM`
  spread actually improves rather than assuming it. If it does not, the honest outcome is to
  say so rather than keep a feature that only feels helpful.
- **Risk:** `DB_VERSION` 1 → 2 is the first upgrade this store has had; a botched
  `onupgradeneeded` can make an existing user's Places unreadable — and `ci-xr-projects` holds
  the Place records themselves, not regenerable session data. — **Mitigation:** the upgrade is
  purely additive and the existing `contains()` guards already prevent touching the current
  stores; test the upgrade path explicitly against a v1 database with real records, not just a
  fresh one.
- **Risk:** Photos of a room are more sensitive than point clouds — they may capture people,
  screens, or documents, and this route makes them durable per-Place rather than transient
  per-session. — **Mitigation:** flagged deliberately. They inherit the same server and
  Tailscale-scoped access as scans and keyframes, so no new exposure surface is created, but
  the calibration copy should make clear a photo is being kept, and a user must be able to
  proceed without one (already required above). Worth a second opinion before merge.
- **Risk:** Capturing a frame mid-calibration could contend with the capture queue if ticket
  0004's restructuring changes the ordering relative to `scanner.start()`. — **Mitigation:**
  the rejection is handled as a failed photo rather than a failed calibration; the ordering
  assumption is written into Open questions so 0004's implementer can invalidate it if it
  changes.

## Subtasks

1. [x] Add `CalibrationReferencePhoto` and the `referencePhotos` field to `src/world/types.ts`
2. [x] Bump `ProjectStore` to `DB_VERSION = 2`, add the `referencePhotos` store and CRUD; test
       the upgrade against a populated v1 database
3. [x] Add `POST`/`GET /projects/:id/reference-photos` to `main.ts`, copying the keyframe
       handler's multipart validation and `sessionDir()`-style path safety
4. [x] Write the server tests; register the file in `deno.json`
5. [x] Pass a capture accessor into `CalibrationOptions`; capture on marker commit with tap
       coords and pose
6. [x] Persist locally, upload, store the returned URL on the frame, sync via the existing
       Place write path
7. [x] Wire the offline/failure degradation path
8. [x] Add the reference-photo panel with crosshair overlay to `index.html`; show per stage
9. [x] Add the missing-photo empty state
10. [x] Write the crosshair unit test and the Playwright coverage
11. [x] `npx tsc --noEmit`, `deno task check`, `deno task test`, Playwright
12. [ ] **Not run.** The two-device on-device check; record the `separationM` spread against
        0006's Procedure 2 baseline — which does not exist yet, so this is blocked on 0006's
        measurement rather than on this ticket
13. [x] Capture and store `pointLabels` per marker; show them beside the photos on return
14. [x] Keep both committed markers in the scene for the session, and draw the stored pair once
        the separation check passes

## What landed, and what the implementation had to decide

Three things the ticket left open were settled during implementation. They are recorded here
because each one is a decision a reader would otherwise have to re-derive from the diff.

**The tap coordinate needed aspect correction the ticket did not anticipate.** The ticket says
to store "the tap's normalised screen coordinates". Those are normalised against the *canvas*;
the photo is the *camera frame*, and the AR feed is cover-cropped to fill the screen — so the
stored image contains strictly more than the user saw, and the two coordinate systems do not
agree. Storing the raw canvas value would put the crosshair off the tapped feature by however
much the crop removed. `src/spatial/resolver.ts` already owned that conversion in the other
direction (`imagePointToViewportPoint`, used for VLM bboxes), so this adds
`viewportPointToImagePoint` beside it rather than a second projection (ADR 0001), and the unit
test asserts the pair round-trips.

**"Capture on commit of each marker" resolves to Confirm and Commit, not to frame commit.** The
landmark's photo is taken when **Confirm landmark** is pressed and the heading marker's when
**Use this alignment** is pressed — the two moments the user is still standing where they
tapped. Capturing both at frame commit would give point A a photo taken from point B, whose
crosshair coordinates would be meaningless. A marker re-placed after its photo was taken drops
that photo rather than keeping a stale one.

**Point B could not be named where the ticket implies.** Placing the heading marker advances to
`'review'` in the same tick, so a label field bound to the placement stages alone is
unreachable for point B — the frame would have been committable with half its `pointLabels`.
The review stage therefore names the heading marker by default, and whichever marker is
selected when one is.

Two smaller notes: the reference panel's `display` rules each need their own `[hidden]` rule,
because an author-sheet `display` beats the UA sheet's `[hidden] { display: none }` and the
panel stayed on screen after `el.hidden = true`. And the offline test uses browser-level
offline rather than a Playwright route, because `/projects` is a queueable prefix in
`public/sw.js` — the upload goes through the service worker, and a route abort passes straight
through to the server.
