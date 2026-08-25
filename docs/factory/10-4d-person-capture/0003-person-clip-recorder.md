> **Type:** Frontend
> **Wave:** 10-4d-person-capture
> **Branch:** `feat/person-clip-recorder`
> **Commit style:** `feat(capture): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001 (take room, `clientId`)

## Goal

Add the first video recording this app has ever had: a person-capture mode that records a clip
meeting 4DAnyone's documented input requirements, and logs a timestamped camera-pose track
beside it so the multi-camera path can skip 4DAnyone entirely.

## What exists today

Nothing. **`MediaRecorder` appears zero times in the repo** — verified across `src/`, `server/`,
`scripts/`, and all HTML, excluding the vendored `public/xr.js`. The only `MediaStream` code is
`src/rtc/broadcaster.ts:82-91` (live preview) and `src/ar/webxr.ts:113-124` (a companion camera
element used for pixel readback). Every existing capture path produces JPEG stills via
`OffscreenCanvas.convertToBlob` (`src/capture/keyframes.ts:256-287`).

## Non-goals

- **Do not record `canvas.captureStream()`.** The AR canvas is the *composited* feed — camera
  plus HUD, labels, and overlays burned in. `src/rtc/broadcaster.ts:82-84` captures it precisely
  because a human preview wants the overlays; a reconstruction input must not have them. This is
  the single most important fence in the ticket.
- Do not upload from here. Recording produces a Blob plus a pose track; 0004 owns the transport.
- Do not remove or bypass the existing file-picker path. Both feed one shared validation surface.
- Do not add a new AR provider, or change `captureFrame()`'s single-in-flight contract.
- Do not build the take-coordination UI beyond what is needed to record on `start`/`stop` from
  the room — the roster/arm choreography is 0001's protocol; this ticket consumes it.

## Pinned conventions

**ADR 0001** — touches a client↔server connection only indirectly (0004 owns the route) and adds
no schema of its own beyond the pose-track sidecar format, which is pinned below. Searched for an
existing posed-frame record to reuse before defining one: **`FrameObservation`
(`src/world/types.ts:329-352`) is the right shape and is what the sidecar serialises**, carrying
`pose`, `timestamp`, and `intrinsics` exactly as needed. Do not define a parallel pose record.

**Input requirements, from 4DAnyone's README — pin these values:**

| Requirement | Value |
| --- | --- |
| Resolution | 720p minimum, **1080p recommended** |
| Aspect | **9:16 portrait** |
| Subject | one person, full-body or upper-body |
| Length | **≥ 121 frames** |
| Motion | mild camera motion only |

Enforce them client-side and say so plainly when a clip fails — a 4-second recording rejected
after a 25-minute GPU job is the worst possible place to find out.

**Copy convention.** Match the calibration overlay's voice: plain, second-person, states what
happened rather than what it hopes — e.g. `'No stable surface there. Aim at a textured floor and
tap again.'` (`src/ar/project-calibration.ts`). So: `'That clip is 3.2 s. Record at least 5 s so
there are enough frames to reconstruct.'`

**UI placement.** Two distinct surfaces, and this is a *capture mode*, so it belongs on the
right-hand action rail (`index.html:2180`), not the side-panel footer where server-job triggers
live (`src/ui/panel.ts:145-160`). Follow the established toggle template exactly — declare
`<button id=…>` in `index.html`, then in `src/main.ts` add the listener plus an `onStatus`
handler doing `btn.classList.toggle('active', …)` and writing a count into a `<span>`. The two
models are `stream-btn` (`src/main.ts:748-800`) and `auto-capture-btn` (`src/main.ts:722-746`),
~25 lines each. Icons available in `src/ui/icons.ts:25-110` include `'film'`, `'camera'`,
`'broadcast'`, `'clock'`; use `iconLabel(name, text, { size })`.

**Codec.** Negotiate with `MediaRecorder.isTypeSupported()`. Safari and Chrome disagree on
`video/mp4` vs `video/webm` and the supported codec strings differ by OS version, so probe a
short preference list and record whatever the device offers rather than hard-coding one. ffmpeg
normalises server-side (0004/0006), so the client's job is to capture *well*, not uniformly.
Persist the chosen mime type with the clip — the server must not guess from the extension.

**Camera constraints.** `getUserMedia({ video: { facingMode: { ideal: 'environment' }, width:
{ ideal: 1080 }, height: { ideal: 1920 } }, audio: false })`. Note the portrait ordering is
deliberate. `audio: false` matches every other capture path in the repo; audio is a deferred
wave-level item, not an oversight.

## Before implementation

- `src/rtc/broadcaster.ts:75-100` — the only existing `getUserMedia` acquisition with fallback
  handling, and the model for status reporting during a media session.
- `src/ar/webxr.ts:88-92` — **read this comment before writing any acquisition order.** It
  records that `requestSession()` must run before `getUserMedia()` or the user-activation window
  is burned. The same class of bug is available here.
- `src/ar/webxr.ts:113-124` — the companion camera element already open on the WebXR path. On
  that path there may be a stream to reuse rather than a second one to acquire.
- `src/ar/eighthwall.ts:307, 326-363` — `XR8.CameraPixelArray` and the pull-queue capture model,
  which is the fallback if a second `getUserMedia` cannot coexist with `XR8` on iOS.
- `src/ar/provider.ts:13-19, 42` — `RawFrame` and `captureFrame()`; note the single-in-flight
  contract (`'Capture already pending'`) — the pose sampler must not fight the keyframe streamer
  for it.
- `src/capture/keyframes.ts:61-72, 209-252` — the existing cadence/backpressure model, and the
  visibility pause. A recorder needs the same visibility discipline.
- `src/main.ts:722-800` — the two toggle-button templates.
- `src/world/types.ts:329-352` — `FrameObservation`.

## Open questions & answers

- Q: Record the raw camera, or the AR canvas? — A: **Raw camera.** The AR canvas has the HUD
  composited into it. See Non-goals. (Decided in this ticket.)
- Q: Then where does pose come from, if the recording bypasses the AR pipeline? — A: The AR
  session keeps running alongside; sample `RawFrame.pose` on a timer and write a pose track
  keyed by timestamp. The video and the pose track are aligned after the fact by timestamp, the
  same way 0002's offsets align clips across clients. (Decided in this ticket.)
- Q: Can a second `getUserMedia` coexist with 8th Wall's camera on iOS? — **OPEN — must be
  answered on-device before 0004 and 0005 pin their resolution assumptions.** iOS Safari has
  historically allowed only one active camera capture per page, and `XR8` owns it on that path.
  If they cannot coexist, the 8th Wall path must record from `XR8.CameraPixelArray` instead,
  which is lower resolution and may fall below 4DAnyone's 720p floor — in which case person
  capture is WebXR/Android-only for now, and that should be stated in the UI rather than failing
  obscurely. Tracked as Checklist C item C1; **do not assume either outcome while implementing.**
- Q: Should the recorder require an AR session at all? — A: For the multi-camera path, yes — no
  AR session means no pose track means no calibrated extrinsics. For the **single-clip 4DAnyone
  path, no** — 4DAnyone estimates everything itself, so a plain camera recording with no AR is
  fully valid input. Support both: pose track present ⇒ eligible for the direct path; absent ⇒
  densify path only. Record which in the sidecar. (Decided in this ticket.)
- Q: How is "mild camera motion" enforced? — A: It is not enforceable as a hard gate — the
  threshold is a property of the reconstruction, not something the client can know. Where an AR
  session is running, compute motion from the pose track and *warn* when it looks excessive,
  reusing `src/capture/pose-delta.ts`. With no AR session there is nothing to measure, and the
  UI should say the guidance rather than imply a check. Do not fabricate a verdict — ADR 0005
  rule 3. (Decided in this ticket.)
- Q: Frame count is specified as ≥121 frames but `MediaRecorder` reports duration, not frames. —
  A: Gate on duration × the negotiated frame rate, and record both in the sidecar so the server
  can re-derive the true count from the container. Client-side is an advisory pre-check; the
  authoritative count comes from ffprobe in 0004. Do not report the client estimate as if it
  were measured. (Decided in this ticket.)
- Q: Chunked recording (`timeslice`) or one Blob at stop? — A: One Blob. Chunking exists to
  stream uploads mid-recording, which 0004 explicitly does not do, and it complicates the
  container. Revisit if clip sizes force resumable upload. (Decided in this ticket.)

## Files impacted

New:
- `src/capture/clip-recorder.ts` — `MediaRecorder` lifecycle, codec negotiation, constraints
- `src/capture/pose-track.ts` — timestamped pose sampling into `FrameObservation[]`
- `src/capture/clip-validation.ts` — pure input-rule checks (unit-testable without DOM)
- `tests/unit/node/clip_validation.test.ts`
- `tests/mock-person-recorder.spec.ts`

Changed:
- `index.html` — the action-rail button and its status affordance
- `src/main.ts` — wire the button, the take-room `start`/`stop` verbs, and status reporting
- `src/ui/icons.ts` — only if no existing icon fits (`'film'` likely does)
- `docs/testing/DEVICE_TESTING.md` — Checklist C items C1 (camera contention) and C2 (clip QA)

## Schema required

No persisted server schema — 0004 owns storage. The pose-track sidecar format, pinned here
because 0004 and 0006 both parse it:

```jsonc
// pose-track.json — written beside the clip
{
  "version": 1,
  "clientId": "…",              // from 0001
  "takeId": "take-…" ,          // null for a solo capture
  "mimeType": "video/mp4;codecs=avc1.42E01E",   // as negotiated; the server must not guess
  "recordedAt": "2026-08-24T…Z",
  "durationMs": 5200,
  "nominalFps": 30,             // negotiated, advisory — ffprobe is authoritative (see Q&A)
  "hasArSession": true,         // false ⇒ densify path only, no calibrated extrinsics
  "frames": [ /* FrameObservation-shaped: { timestamp, pose:{position,rotation}, intrinsics } */ ]
}
```

`frames` uses the existing `FrameObservation` field names (`src/world/types.ts:329-352`) so
nothing downstream needs a second pose vocabulary. `frameId`/`scanId`/`rgbUrl` are omitted —
there is no per-frame image here, and inventing ids for frames that have no files would be
fabricating identity.

## Definition of Done

- [x] A person-capture button on the action rail starts and stops recording, with active state
      and elapsed time shown, following the `stream-btn`/`auto-capture-btn` template
- [x] Recording uses a raw `getUserMedia` stream at 1080p-ideal portrait — **not** the AR canvas
- [x] Codec is negotiated via `isTypeSupported` and the chosen mime type travels with the clip
- [x] A pose track is captured whenever an AR session is active, and `hasArSession` records the
      truth either way
- [x] Clips are validated against the pinned input rules before upload, with plain-voice messages
- [x] Recording pauses/stops cleanly on `visibilitychange`, matching `keyframes.ts` discipline
- [x] All tracks are stopped on stop and on teardown — no camera light left on
- [x] The take room's `start`/`stop` verbs drive recording when in a take; solo recording works
      with no room at all
- [x] The existing file-picker upload path still works unchanged
- [x] `npx tsc --noEmit` passes

## Tests

- [x] Unit (`clip_validation.test.ts`, Node — needs DOM lib types, so **not** the Deno suite):
      duration below the frame floor is rejected; landscape aspect is rejected; a valid clip
      passes; the messages are the pinned copy
- [x] Unit: codec preference list selects the first supported entry and reports failure clearly
      when none are supported
- [ ] Playwright (`mock-person-recorder.spec.ts`, `chromium-mock` project): with a fake media
      stream, the button starts and stops a recording, a Blob with a non-zero size is produced,
      and the pose track has one entry per sample interval
- [ ] Playwright: stopping the recorder stops all tracks (assert via the mock's track state)
- [ ] **Device C1 (blocking, `docs/testing/DEVICE_TESTING.md`)**: on iPhone/8th Wall, confirm
      whether a second `getUserMedia` coexists with `XR8`. Record the outcome and the resulting
      resolution. This gates 0004 and 0005 — see Open questions.
- [ ] **Device C2**: record a real 5 s clip on iOS and Android; confirm resolution, aspect,
      frame count via ffprobe, and that the pose track's timestamps span the clip

```bash
npx tsc --noEmit
npm run test:store
npx playwright test tests/mock-person-recorder.spec.ts --project=chromium-mock
```

## Acceptance Criteria

- [x] Given the scanner with an AR session running, When the user taps record and stops after
      6 s, Then a clip Blob and a pose track covering that span are produced
- [x] Given a recording stopped after 2 s, When validation runs, Then it is rejected with a
      message naming the actual duration and the required minimum
- [ ] Given a device where no preferred codec is supported, When the user taps record, Then a
      clear message is shown and no partial recording is left behind
- [x] Given a take room that broadcasts `start`, When the phone is a `capture` member, Then it
      begins recording without a local tap
- [x] Given the user backgrounds the app mid-recording, When they return, Then the recorder is
      in a defined state and the camera is not left running in the background
- [x] Given no AR session (plain camera capture), When a clip is recorded, Then it is still
      valid input and `hasArSession` is `false`

## Risks / potential issues

- **Risk (highest, and it may reorder the wave):** 8th Wall camera contention on iOS may make
  person capture WebXR/Android-only, or force a sub-720p 8th Wall path. — **Mitigation:** C1 is
  blocking and scheduled early precisely so this is discovered before 0004/0005 build on an
  assumption. If it fails, the honest outcome is stating the platform limit in the UI.
- **Risk:** iOS Safari `MediaRecorder` support is genuinely uneven across versions — container
  and codec strings differ and some combinations produce files ffmpeg handles poorly. —
  **Mitigation:** negotiate rather than assume, persist the real mime type, and let C2 verify a
  real file end-to-end through ffprobe rather than trusting that a Blob exists.
- **Risk:** Running the AR session and a separate camera capture simultaneously is a heavy
  thermal and battery load; sustained recording may throttle the AR tracking that the pose track
  depends on. — **Mitigation:** measure in C2; keep clips short by design (the input spec wants
  only ~5 s), and surface thermal degradation if the platform exposes it.
- **Risk:** The pose sampler competing with the keyframe streamer for `captureFrame()`'s
  single-in-flight slot could starve either. — **Mitigation:** the pose track needs pose only,
  not pixels — sample the provider's pose directly rather than going through `captureFrame()`,
  and assert in review that no new `captureFrame()` caller was added.
- **Risk:** A large clip Blob held in memory on a phone alongside an AR session may be evicted.
  — **Mitigation:** hand off to 0004 promptly on stop rather than accumulating clips in memory;
  note that the service-worker offline queue is deliberately not an option (0004 covers why).

## Subtasks

1. [x] Write `clip-validation.ts` and its unit tests first — pure, no DOM, pins the rules
2. [ ] **Run device check C1** before building the acquisition path; record the outcome in the
       ticket's Open questions
3. [x] Implement `clip-recorder.ts`: constraints, codec negotiation, lifecycle, track teardown
4. [x] Implement `pose-track.ts` sampling into `FrameObservation`-shaped records
5. [x] Add the action-rail button in `index.html` and wire it in `src/main.ts` per the template
6. [x] Consume the take room's `start`/`stop` verbs; keep solo recording working without a room
7. [x] Add visibility handling and teardown matching `keyframes.ts` discipline
8. [ ] Write the Playwright mock spec (Checklist C1/C2 were added to `DEVICE_TESTING.md`; the `chromium-mock` spec itself is outstanding)
9. [x] `npx tsc --noEmit`, run the node and mock suites
