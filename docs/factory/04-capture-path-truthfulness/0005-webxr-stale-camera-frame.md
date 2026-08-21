> **Type:** Frontend
> **Wave:** 04-capture-path-truthfulness
> **Branch:** `fix/webxr-stale-camera-frame`
> **Commit style:** `fix(ar): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Lands cleanly alongside 0002 (same file, disjoint regions) and is
> made far easier to *diagnose* by 0003, which would preserve the offending frames.

## Goal

Stop the WebXR provider handing every capture the same frozen camera frame. Detect that the
companion `getUserMedia` stream has stalled, and recover it, rather than silently
re-encoding the last decoded frame forever.

## The defect, precisely

`WebXRProvider.start()` (`src/ar/webxr.ts:54-62`) opens a `getUserMedia` camera stream into
a detached `<video>` element, and *then* requests the `immersive-ar` session. Two clients on
one physical camera. The file's own header comment explains why the companion stream exists:
raw XR camera access is too sparsely supported to rely on.

Captures are produced by `drawImage(self.videoEl, 0, 0)` (`src/ar/webxr.ts:153`), gated on
`self.videoEl.readyState >= 2` (`:146`). That gate is the problem: `readyState` stays at or
above `HAVE_CURRENT_DATA` for a stream that has *stopped advancing*, so `drawImage` keeps
returning the last decoded frame indefinitely. The capture path cannot tell a live frame
from a corpse.

Evidence, Lume Pad 2, 2026-08-18 — `[main] Captured blob: N bytes` from the client console:

| Session | Byte count | Occurrences | Span |
|---|---|---|---|
| desk scene | 40549 | 6 | — |
| earlier | 78603 | 6 | — |
| WebGPU + server | **140842** | 6+ | **47 minutes** |

Byte-identical JPEGs are effectively impossible from a live camera — sensor noise alone
perturbs the encoding between frames. Six identical encodings spanning 47 minutes of a
handheld tablet is a frozen frame, not a still scene.

Corroborating, from `adb shell dumpsys media.camera`:

```
14:24:39 : EVICT device 0 client held by package com.android.chrome (PID 5466)
 - Evicted by device 0 client for package com.android.chrome (PID 5466)
```

Chrome evicting its own camera client — the `getUserMedia` track and the ARCore session
contending for camera 0.

The related failure mode is already visible in the logs as
`[capture] Error: Timed out waiting for camera frame` (`src/ar/webxr.ts:197`), which is what
happens when `videoEl` is absent entirely rather than merely stalled. Same root cause,
louder symptom.

## What it costs downstream

A stale frame is worse than a missing one, because everything downstream treats it as real:

- Detections are inferred against a scene the user is no longer looking at, then placed in
  the world at the *current* pose. Objects land in the wrong place with full confidence.
- On 2026-08-18 the frozen frame was a near-black, noise-heavy capture taken while the feed
  was down. `qwen3-vl:4b` spent **37.8 s** on it and returned nothing. The same model on the
  same settings with a live frame returns 8 correct objects in 17 s. The configuration was
  never at fault; the input was.
- Recovery today is a full page reload, which ends the AR session and loses the scan.

## Non-goals

- Do not remove the companion `getUserMedia` stream in favour of WebXR raw camera access.
  The header comment at `src/ar/webxr.ts:5` is still true — `camera-access` is not widely
  enough supported. Revisit only with device-support evidence.
- Do not fix this by lengthening the `captureFrame` timeout (`:190-200`). The stalled case
  does not time out; it succeeds with garbage. A longer timeout changes nothing.
- Do not change the probe-grid work from ticket 0002. Same file, different concern; keep the
  diffs separable.
- Do not paper over it by disabling capture in WebXR mode. Detection on the native WebXR
  path is the only working configuration on this device class.
- Do not persist a stale frame as though it were valid — coordinate with 0003 so a detected
  stall marks the capture rejected rather than storing a duplicate.

## Pinned conventions

**ADR 0001** — this changes a client-side capture path; it states what it reuses. Verified
at `489cdcd`:

| Existing | Where | How used |
| --- | --- | --- |
| `videoStream` / `videoEl` | `src/ar/webxr.ts:18-19` | reused; the fields stay, gaining a liveness check and a re-acquire path |
| the `readyState >= 2` gate | `src/ar/webxr.ts:146` | **extended**, not replaced — it is necessary but not sufficient |
| `captureQueue` + its reject path | `src/ar/webxr.ts:190-200` | reused as the existing channel for reporting a frame that cannot be produced |
| `[capture]` HUD error mapping | `src/main.ts` catch block | reused; a stall should surface through the existing typed branches, not a new toast |
| `stop()` track teardown | `src/ar/webxr.ts` | reused by any re-acquire path — tracks must be stopped before re-requesting |

No new type or connection. A liveness check plus a recovery path on an existing stream.

## Before implementation

- `src/ar/webxr.ts:40-70` — the `getUserMedia` acquisition and its non-fatal catch
- `src/ar/webxr.ts:140-175` — the capture resolution block and the `readyState` gate
- `src/ar/webxr.ts:185-205` — `captureFrame()` and its timeout
- `src/main.ts` catch block — where a stall should surface to the user
- MDN on `MediaStreamTrack.muted` and `HTMLVideoElement.currentTime` — the two candidate
  liveness signals

## Open questions & answers

- Q: What is the reliable liveness signal? — OPEN. Candidates: `videoEl.currentTime` failing
  to advance between frames (direct, cheap, no API support questions); `track.muted`, which
  the spec sets when a source stops delivering; `track.readyState === 'ended'`, which only
  catches full teardown. `currentTime` stagnation is the strongest candidate because it
  detects the observed symptom directly rather than inferring it. **Confirm on-device.**
- Q: Can the stream be re-acquired without ending the XR session? — OPEN. If ARCore holds
  camera 0 exclusively, a fresh `getUserMedia` may fail or evict the XR session — which
  would be worse than the bug. **This is the load-bearing unknown; answer it before
  designing the recovery.**
- Q: If re-acquisition is impossible, what is the correct behaviour? — OPEN. Falling back to
  rejecting the capture with an honest "camera stream stalled — restart the scan" is
  strictly better than silently returning a stale frame, and may be the whole fix.
- Q: Is the stall triggered by a specific event, or is it time-based? — OPEN. The 2026-08-18
  data has it coinciding with the WebGPU error storm and a camera EVICT, but causation was
  not established. Worth reproducing deliberately.

## Files impacted

Changed:
- `src/ar/webxr.ts`

Possibly changed:
- `src/main.ts` — if a new typed failure needs HUD copy

## Schema required

None.

## Definition of Done

- [ ] A stalled companion stream is detected rather than silently re-encoded
- [ ] A capture is never produced from a frame known to be stale
- [ ] Either the stream is re-acquired without ending the XR session, or the user is told
      plainly that the scan must be restarted
- [ ] The existing `Timed out waiting for camera frame` path still behaves as today
- [ ] `npx tsc --noEmit` and `npm run verify` pass

## Tests

- [ ] Manual, on-device: capture repeatedly across several minutes and assert the logged
      blob byte count is **not** identical across captures of different scenes
- [ ] Manual: force a stall (background the tab, or trigger the camera contention observed
      on 2026-08-18) and confirm the app reports it instead of returning a stale frame
- [ ] `npm run verify`

```
npx tsc --noEmit
npm run verify
```

## Acceptance Criteria

- [ ] Given a live session, When two captures are taken of visibly different scenes, Then
      their encoded byte counts differ
- [ ] Given the companion stream has stalled, When a capture is requested, Then it does not
      return the previous frame
- [ ] Given a stall, Then the user sees an actionable message rather than a confident
      detection of a scene they are no longer pointing at

## Risks / potential issues

- **Risk:** Re-acquiring `getUserMedia` may evict the ARCore session and kill tracking —
  turning a bad capture into a lost scan. — **Mitigation:** The second open question. If
  re-acquisition proves unsafe, reject-and-inform is the correct scope.
- **Risk:** A liveness check on every frame adds per-frame cost. — **Mitigation:**
  `currentTime` is a cheap property read; check on capture rather than every frame if it
  shows up in profiling.
- **Risk:** False positives would reject good captures — the opposite failure, and a worse
  user experience than today for anyone unaffected. — **Mitigation:** Require stagnation
  across a margin of frames, not a single sample; a genuinely static `currentTime` across
  several hundred ms is unambiguous.
- **Risk:** This may be specific to the Lume Pad 2 / ARCore / Chrome 151 combination. —
  **Mitigation:** Confirmed on exactly one device. Reproduce elsewhere before assuming
  generality; the detect-and-report half is safe regardless of cause.

## Subtasks

1. [ ] Reproduce the stall deliberately and establish what triggers it
2. [ ] Answer whether the stream can be re-acquired without ending the XR session
3. [ ] Pick the liveness signal and confirm it fires on-device
4. [ ] Implement detection; refuse to produce a capture from a stale frame
5. [ ] Implement recovery, or the honest failure path if recovery proves unsafe
6. [ ] Coordinate with 0003 so a rejected capture is not persisted as valid
7. [ ] Re-verify across a multi-minute session, checking blob byte counts differ
