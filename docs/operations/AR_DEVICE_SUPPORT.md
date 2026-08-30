# AR device support

Which phones can actually run the live scanner, and how we know. Same rule as
`PLATFORM_SUPPORT.md`: a row is **VERIFIED** only if someone started a session on the hardware
and read the log back. Everything else says so.

The evidence for every claim here is `scans/client-logs.jsonl` — the remote console the phone
mirrors to the server when the scanner is opened with `?debug=remote,verbose`. Timestamps in
this document are that file's, and can be re-read.

| Device | WebXR path | 8th Wall path |
| --- | --- | --- |
| XREAL Beam Pro (Android 14, Chrome 151) | **VERIFIED dead** — no ARCore | **VERIFIED working, intermittently** — ~2 starts in 8 |
| Galaxy Tab S8 Ultra | UNVERIFIED | Camera permission prompt never raised (one report, `eighthwall.ts:571`) |
| iPhone / Safari | UNVERIFIED | UNVERIFIED — the platform 8th Wall exists for, never measured here |

## XREAL Beam Pro

### The WebXR path is dead, and permanently

`com.google.ar.core` is not in the installed-package list (checked twice against the full
list). `navigator.xr.isSessionSupported('immersive-ar')` still answers **true** — it reports
that the API exists, not that any service backs it — and `requestSession()` then rejects:

```
08-29 20:17:25 error [main] AR provider start failed:
  NotSupportedError: The specified session configuration is not supported.
```

Nothing in the app can fix this; it needs Google Play Services for AR installed on the device.
`startFailureVerdict()` in `src/ar/preflight.ts` already classifies exactly this rejection and
says so in words, which is the correct behaviour.

### The 8th Wall path works — the previous "this device cannot" conclusion was wrong

8th Wall runs its own SLAM and needs no ARCore, and on this device it does run. Measured
2026-08-30 08:16:11, a start that succeeded end to end:

```
08:16:11.333 +0.000s [main] Room scanner started
08:16:11.370 +0.037s [8thwall] Camera status: requesting
08:16:13.063 +1.693s [8thwall] Camera status: hasStream
08:16:13.137 +1.767s [8thwall] Camera status: hasVideo
08:16:13.703 +2.370s [8thwall] trackingStatus: NORMAL
08:16:13.703 +2.370s [8thwall] SLAM ready — first pose received via onUpdate
08:16:15.449 +4.116s [8thwall][aspect] {"fit":"contain","canvas":{"w":1080,"h":1440,"aspect":0.75},
  "frame":{"w":720,"h":960,"aspect":0.75},"trackSettings":{"w":720,"h":960},
  "fovYDeg":64.58,"projectionAspect":0.75,"crop":1}
```

A screenshot at that moment shows the live camera feed filling the canvas over a real room.
Note the diagnostic is not merely non-null but *correct*: `crop` is exactly 1.00 and
`projectionAspect` (0.75) equals `canvas.aspect` (0.75), which is what the `contain` fit in
`eighthwall.ts` is supposed to produce. The render and the keyframe intrinsics agree.

An earlier success is in the same log at 08-29 20:35:52, reached from a session whose camera
permission prompt had been sitting unanswered for 713 seconds: once the stream arrived, the
pipeline reached `hasVideo` in 44 ms and a first pose in 474 ms.

So the previous conclusion — that the pipeline structurally never emits a camera frame on this
device — is **refuted**. It emits frames, tracks NORMAL, and fits the canvas correctly.

### What is actually wrong: an intermittent stall before `hasVideo`

Eight starts observed, two succeeded. The failure is sharply defined and always identical:
the pipeline advances `requesting` → `hasStream` and then **stops**. It never reaches
`hasVideo`, never reports a frame size, and never produces a pose.

```
08:17:07.458 +0.000s [main] Room scanner started
08:17:07.493 +0.035s [8thwall] Camera status: requesting
08:17:08.118 +0.660s [8thwall] Camera status: hasStream
             (nothing further — no hasVideo, no pose)
08:17:11.457         [8thwall][aspect] "frame":"unreported","trackSettings":{"w":960,"h":720},
                       "projectionAspect":null,"crop":null
```

Every start, in order:

| # | Time | `hasStream` at | `hasVideo` | Pose | Negotiated track | Result |
| --- | --- | --- | --- | --- | --- | --- |
| — | 08-29 20:15 | +0.472 s | no | no | 960x720 landscape | fail |
| — | 08-29 20:23 | +713 s (prompt open) | +44 ms | +474 ms | — | **ok** |
| 1 | 08-30 08:16 | +1.693 s | +74 ms | +640 ms | 720x960 portrait | **ok** |
| 2 | 08-30 08:17:07 | +0.660 s | no | no | 960x720 landscape | fail |
| 3 | 08-30 08:17:55 | +0.497 s | no | no | 960x720 landscape | fail |
| 4 | 08-30 08:18:49 | +0.626 s | no | no | 960x720 landscape | fail |
| 5 | 08-30 08:22:18 | +0.814 s | no | no | 960x720 landscape | fail |
| 6 | 08-30 08:23:44 | +0.666 s | no | no | 960x720 landscape | fail |

The correlation is perfect across all eight: **a start succeeds when getUserMedia takes over
1.6 s and returns a portrait 720x960 track, and stalls when it returns in under 0.9 s with a
sensor-native landscape 960x720 track.** The device is held in portrait throughout.

### What that rules out

The stall is not any of the things worth suspecting first, and each is ruled out by evidence
rather than by argument:

- **Not XR8 rejecting the device.** The engine loads, `XR8.run()` is accepted, and the camera
  pipeline runs far enough to acquire a MediaStream and report it.
- **Not a licence or domain check.** Those fail before the camera is acquired, and would
  surface through `onException`. No `[8thwall] Pipeline exception` line appears in any run.
- **Not a chunk that failed to load.** `start()` rejects with a named error if `/xr.js` does
  not arrive within 10 s (`XR_LOAD_TIMEOUT_MS`); it never did.
- **Not a silent error inside the engine.** Both diagnostic hooks are wired
  (`eighthwall.ts`, module `ci-scan-diagnostics`) and neither `onException` nor camera status
  `failed` ever fired. The pipeline does not throw; it stalls.
- **Not camera contention with a previous session.** Run 4 was started after navigating to
  `about:blank` and confirming Android's camera privacy indicator had cleared. It stalled
  anyway.
- **Not a page that needed time to settle.** Run 6 waited 18 s between page load and starting
  AR. It stalled anyway.
- **Not the service worker.** Clearing it was tried on 08-29; it changed the engine's readiness
  report and none of the symptoms above.

What is left is inside 8th Wall's own camera pipeline, in the step between "we hold a
MediaStream" and "the video element is producing frames" — the transition the engine reports as
`hasVideo`. The one variable that tracks the outcome is the orientation of the track Chrome
hands back. The failing case is the sensor-native landscape track on a portrait device, which
is consistent with the engine waiting on a video element whose orientation never matches the
mode it configured. **That last step is inference, not measurement** — it is where the next
person should start, and it cannot be confirmed from outside a minified `xr.js`.

### Practical guidance

Live AR scanning on a Beam Pro works, but you should expect to press Start more than once.
Watch the remote log: `Camera status: hasVideo` within a second or so of `hasStream` means the
session is good. `hasStream` with nothing after it means this attempt stalled — stop and start
again rather than walking the room, because no pose will arrive.

Upload Content remains the reliable path on this device, with the caveat that it reconstructs
the room but places no objects in it (see `src/ar/preflight.ts`, `UPLOAD_NEXT_STEP`).

## A verdict bug this investigation found, and the fix

The reason this device was written off is worth recording, because the mistake is the one
CLAUDE.md warns about, running in the opposite direction: **reporting a failure it had not
earned.**

`firstFrameVerdict()` returns `'unavailable'` — headline "No camera frames from AR", detail
"This device cannot run the live scanner", `routeToUpload: true` — when the grace window
expires with no camera frame seen. That window was armed in `EighthWallProvider.start()` and
measured from `XR8.run()`. It therefore ran while `getUserMedia` was still pending, and on
08-29 20:23 it expired **708 seconds before the camera stream existed**, on a session that then
tracked NORMAL. The verdict was a statement about a permission dialog, delivered as a permanent
fact about the hardware.

Fixed in `src/ar/eighthwall.ts` by anchoring the clocks to the camera stream instead of to
session start:

- `_cameraStreamMs` records the first `hasStream`/`hasVideo`, and `_armPoseRuling()` starts the
  5 s window from there. Verified on device: the ruling now fires at `stream+5.002 s`
  (08-30 08:22:23) rather than `start+5 s`.
- While no stream has arrived, `_emitPreflight()` reports `elapsedMs: 0`, which keeps
  `firstFrameVerdict()` inside its grace window and therefore at `'warming-up'`. A pending
  camera permission can no longer be reported as an incapable device.
- The aspect diagnostic is armed from the stream too (`_armAspectDiagnostic()`). Fired from
  `start()` it routinely sampled a session with no stream and printed `frame: "unreported"`,
  `trackSettings: "unavailable"`, `projectionAspect: null` — the exact line that made this
  device look dead. Anchored to the stream, that same line now means what it says, and is what
  identifies the genuine stall above.
- `stop()` clears a pending ruling, so it cannot outlive the session it was judging.

`FIRST_POSE_TIMEOUT_MS` is unchanged, and the four-state verdict is unchanged: the grace window
was never too short, it was started too early.

### Still to fix, in a file this pass did not own

Two things in `src/ar/preflight.ts` are now known to be wrong, and are left for whoever owns
that file:

1. The module header states as established fact that on the Beam Pro "the pipeline never emits
   a frame". It does; the stall is intermittent, ~2 starts in 8.
2. `firstFrameVerdict()`'s no-frame branch says **"This device cannot run the live scanner"**
   and sets `routeToUpload: true`. With the timing fixed that branch is now only reached with a
   camera stream genuinely in hand, so it does describe a real stall — but it still overstates
   it as a permanent property of the device, and the measurement above says retrying is the
   right advice. The sentence should name the attempt, not the hardware.

## Related

- `docs/operations/PLATFORM_SUPPORT.md` — the same treatment for server-side pipelines.
- ADR 0007 — why a rotation-only sweep cannot be reconstructed, whatever the tracking does.
- `src/ar/preflight.ts` — the four-state verdict and the wording every dead end ends with.
