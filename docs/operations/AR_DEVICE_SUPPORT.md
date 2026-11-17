# AR device support

Which phones can actually run the live scanner, and how we know. Same rule as
`PLATFORM_SUPPORT.md`: a row is **VERIFIED** only if someone started a session on the hardware
and read the log back. Everything else says so.

The evidence for every claim here is `scans/client-logs.jsonl` — the remote console the phone
mirrors to the server when the scanner is opened with `?debug=remote,verbose`. Timestamps in
this document are that file's, and can be re-read.

Which runtimes can pin a point to the room (runtime anchors) is a separate question, answered
from documents and not from a device: see [Runtime anchors](#runtime-anchors-where-they-exist-and-what-the-app-does-with-them).

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
person should start, with device logs (camera status transitions and the `[8thwall][aspect]` line)
and, for anything the documentation does not say, with Niantic's support channel.

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

## Runtime anchors: where they exist and what the app does with them

A runtime anchor is a point the AR runtime itself keeps pinned to the room: WebXR's
[Anchors Module](https://immersive-web.github.io/anchors/) (`XRFrame.createAnchor`,
`XRFrame.trackedAnchors`), or ARKit's `ARAnchor` and ARCore's `Anchor` in a native shell. In this
app they are an optional accelerator behind one capability (`ARProvider.anchors`,
`src/ar/anchors.ts`), never the foundation: the Place frame is still built from the taps, a caller
works when the capability is undefined, and nothing here is evidence for the word "verified" (ADR
0005 rules 3 and 5). **"Anchors granted" means the API exists. It does not mean the room is
pinned**: an emulator grants them and never lets one drift or go missing, and nothing measured yet
says that a real runtime's anchor stays where it was put.

### Where they exist (read from documents on 2026-11-16, no device run)

The rule at the top of this file applies: **no row below is VERIFIED**, because nobody has run a
session on the hardware and read a log back. "Documented" means a primary source says it, named
under the table. Device experiment DX6 (a Chrome ARCore phone and a Quest) turns each row into
something measured.

| Where the page runs | WebXR immersive-ar | Anchors | Persistent anchors | What the app does |
| --- | --- | --- | --- | --- |
| Chrome on Android, with ARCore | documented | documented, from Chrome 85 | none: documented as unsupported, and no plan found | asks for `anchors` as an optional feature; the capability exists when the browser grants it |
| Quest Browser | documented (passthrough) | documented (Quest 2 and Pro; Quest 3 not stated) | documented, a small device-local cache: Meta says 8 per site, other sources 5 or about 6, possibly shared by every site, and one report says deleting did not free a slot | same; persistence is a cache of at most 5 entries (the lowest figure any source gives) that is never uploaded or synced, and a restore that fails means place the anchor again |
| Chrome on Android XR | documented | listed among its supported modules | not documented | same as Chrome on Android; unverified |
| Samsung Internet, Wolvic | not independently evidenced (Samsung's entries are derived from Chrome's) | not independently evidenced | not independently evidenced | unverified: nothing is assumed |
| Android WebView, which is the Capacitor Android shell | no | `XRAnchor` is false there (Chromium issue 40652382, via MDN browser-compat-data) | no | **inert**: the capability is undefined |
| iPhone Safari, and the Capacitor iOS shell (WKWebView) | no: Safari has no WebXR AR | no | no | **inert**: the capability is undefined |
| 8th Wall, this app's default pose source on iPhone and Android | not WebXR: its own tracking | none is asked of it: `src/ar/eighthwall.ts` has no `anchors` member, and its VPS path is documented as excluded from the self-hosted binary | no | **inert**: the capability is undefined |
| Native ARKit and ARCore through the Capacitor `ArSession` plugin | not WebXR | ARKit has `ARAnchor` and `ARWorldMap` (iOS 12 and later); ARCore has anchors | ARKit `ARWorldMap` save and restore, native only | **not built**: the plugin is pose-only (below) |
| visionOS Safari | immersive-vr only (Apple staff) | no | no | not a target |

Sources, each read on 2026-11-16: the Anchors Module Editor's Draft of 27 April 2026
(https://immersive-web.github.io/anchors/); MDN browser-compat-data `api/XRAnchor.json` and
`api/XRSession.json`; Meta, Quest Browser WebXR mixed reality
(https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/); the Immersive Web
Working Group minutes of 24 March 2026 (https://www.w3.org/2026/03/24-immersive-web-irc) and anchors
issue 79 (https://github.com/immersive-web/anchors/issues/79, third-party reports, not reproduced
here); Android XR on the web (https://developer.android.com/develop/xr/web); Can I Use, WebXR
(https://caniuse.com/webxr); Apple staff on visionOS
(https://developer.apple.com/forums/thread/826845); ARKit `ARWorldMap`
(https://developer.apple.com/documentation/arkit/arworldmap); Niantic Spatial on what the
self-hosted 8th Wall engine includes
(https://info.nianticspatial.com/blog/8th-wall-update-engine-distribution-and-open-source-plans and
https://8thwall.org/docs/migration/self-hosted). The iOS web bridges that were read (HelloXR,
Needle Go, ios-webxr) document hit tests and camera frames and no anchors or world maps.

### What the app does with an anchor

An anchor event is a **frame discontinuity**, never a matrix to follow. A scan carries one
`sessionToProject`, and the points recorded before a correction sit in the old frame, so nothing
recomputes the Place frame from where an anchor is now: `tests/unit/node/wp-17a-anchor-guard.test.ts`
fails if any module other than `src/ar/anchors.ts` reads an anchor's pose. What the provider does
instead is number the stretches of tracking (`src/ar/frame-epoch.ts`), and the one-scan-one-frame
rule answers the rest: the scan holding the earlier points is finished, and the next one is
calibrated again in the new epoch.

The design guidance the numbers come from, written here because the code points at it: an anchor
is expected to move in the session frame when the runtime refines its map, and what does not move
is every number the app already stored. An anchor sees the same disturbances the viewer's own
signals do, from a second place, so it starts an epoch only for what nothing else accounts for:

- **A step** of at least 0.05 m, or 1 degree about the vertical, is an epoch. A "step" is how far
  the capability's last two reports of the anchor are apart, and it reports an anchor once it has
  moved a centimetre or half a degree, so a step can be that much more than one frame's movement.
- **An anchor the runtime stops locating is not an epoch when it goes** (it leaves
  `trackedAnchors`, or is listed with no pose). ARCore pauses every anchor whenever camera tracking
  pauses, so on Chrome a loss is what every blip looks like, and the viewer's own rule does not
  count a blip either (`RECOVERY_SUSPECT_MS`). An anchor that comes back where it was has measured
  that the frame did not move against it, which a recovery cannot say. A loss is counted
  (`getTrackingDiagnostics().anchors.lost`) and the handle is kept for the window below. It becomes
  an epoch in two cases: the anchor comes back displaced, which is a step; or the handle is given
  up, which is suspect (nothing was measured, and the anchor that could have said whether the frame
  moved is gone) and is an epoch only when nothing else accounts for the loss. An epoch at the
  first missing frame would make one tracking blip an epoch for every anchor held and none without.
- **One disturbance is one epoch, whoever sees it first.** One move of the frame moves every
  anchor. A step, or a handle given up, joins the epoch of a resume, a reset or a stretch of bad
  tracking that has one and starts none, when it comes while that is still going, or within half a
  second (`FRAME_JUMP_REFRACTORY_MS`) of the moment one began or ended, or when the anchor went
  while such an epoch was going or an epoch began while it was away. These are counted in
  `anchors.folded`; `suppressedJumps` stays the count of the viewer's own jumps folded together. An
  epoch that a resume (or a reset that came with no transform) began has no size: the first step
  an anchor measures in it becomes its size, and it counts as the frame shift it is. That is what
  an anchor is for: a resume cannot say how far the frame moved, and an anchor that comes back
  displaced can.
- **Drift** of 0.10 m or 2 degrees or more from where the anchor was first located is a quality
  flag and a "Check drift" prompt, not an epoch. A new epoch starts the count again: the provider
  rebases the anchors it can locate at every epoch, and leaves one that is away alone so that its
  return is still seen.

Google's guidance is to keep content within 8 m of its anchor and to use one anchor for nearby
content (https://developers.google.com/ar/develop/anchors), so one anchor per room or doorway.

**Every number here is adopted, not measured** (ADR 0005 rule 5), and each is a named constant
that says so beside its definition:

| Number | Value | Where | Replaced by |
| --- | --- | --- | --- |
| A step that starts an epoch: translation | 0.05 m | `ANCHOR_STEP_TRANSLATION_M`, `src/ar/frame-epoch.ts` | DX6, anchor drift over 60 s and 10 min |
| A step that starts an epoch: turn about the vertical | 1 degree | `ANCHOR_STEP_YAW_DEG` | DX6 |
| Drift that raises the flag: translation | 0.10 m | `ANCHOR_DRIFT_TRANSLATION_M` | DX6 |
| Drift that raises the flag: turn about the vertical | 2 degrees | `ANCHOR_DRIFT_YAW_DEG` | DX6 |
| The half second after an epoch, or after the trip or stretch that began it, in which an anchor's step or given-up handle joins it | 0.5 s | `FRAME_JUMP_REFRACTORY_MS`, `src/ar/frame-epoch.ts` (09a's number, reused) | DX4, with the jump thresholds |
| How long a lost anchor may be away before its handle is given up and the Place needs a new one (time the session is hidden is not counted) | 15 s | `ANCHOR_RETURN_WINDOW_MS`, `src/ar/anchors.ts` | DX6, the 3, 10 and 30 s losses |
| How many persistent anchors the app keeps on a device (Quest Browser) | 5 | `MAX_PERSISTENT_ANCHORS`, `src/ar/anchors.ts` | DX6, the cap probed from a second origin, and a check that a delete frees a slot |

On Chrome, an empty `trackedAnchors` during a tracking loss does not mean the anchor was deleted
for ever: Chromium's sources (`device/vr/android/arcore/arcore_impl.cc`,
`third_party/blink/renderer/modules/xr/xr_session.cc`) read as if Chrome can list an anchor with no
pose, or leave it out of the set for the frames a loss lasts. Whether Chrome ever fires a
reference-space `reset`, and whether the same `XRAnchor` object comes back after a loss, is **not
confirmed**. So a lost anchor starts no epoch when it goes, its handle is kept for the window above,
and one that is not back in time is given up. The tests drive the real provider over a stand-in
that copies those readings (`tests/unit/node/support/chrome-xr-session.ts`); they show what the app
does if Chrome does, and say nothing about whether it does.

### What is built, and what is not

Built: the capability (`src/ar/anchors.ts`: make an anchor, read it, report a step, a loss, a
return and a handle given up, and on Quest the device-local list of persistent anchors); the epoch
rule above (`FrameEpochTracker.noteAnchor` in `src/ar/frame-epoch.ts`, with `src/ar/anchor-epochs.ts`
as the seam from a capability to a tracker); the hook in `src/ar/webxr.ts`; the drift flag, read
from `getTrackingDiagnostics().anchors.driftFlagged`; and the tests over the Chrome stand-in.

Not built, and waiting for the calibration-flow wave: making an anchor at the landmark once a
calibration is committed, and at any calibrated point more than 8 m from an existing one; the
`anchors` list in the upload sidecar; the "Check drift" prompt that reads the flag; and, on Quest,
the copy "Remember this spot on this headset" and the restore at the start of a return visit. A
restored anchor there will only pre-position the ghosts: the taps still define the frame and the
status does not change, because nothing measured says an anchor stays put (ADR 0005 rule 3).

### What a device has to confirm (DX6)

On a Chrome ARCore phone, and on a Quest. Log, for every frame or event: the time, the reference
space type, `enabledFeatures`, which anchor object it is, whether it is in `trackedAnchors`, whether
its pose is null, its position and orientation, whether the viewer pose is null or emulated, the
count of `reset` events and whether each carried a transform, the visibility state, and the size of
`trackedAnchors`.

- Chrome: is `anchors` in `enabledFeatures`; is `requestPersistentHandle` absent; how long creation
  takes; how far an anchor drifts over 60 s still and over a 10 minute walk with loops back to a
  taped mark; how much a still anchor's pose jitters from frame to frame over those 60 s, and the
  largest single-frame excursion, because one frame of 5 cm is an epoch and there is no debounce;
  loss for 3, 10 and 30 s (camera covered), and for 10 s in the background: whether the same object
  returns, after how long, and whether its pose matches the one before the loss; how often an
  ordinary walk makes an anchor null for a few frames (each is counted in `anchors.lost` and none
  is an epoch); how many `reset` events there are in all of that; 1, 5, 20 and 50 anchors and the
  frame cost.
- Quest: a persistent handle round trip across closing the tab, restarting the browser and
  rebooting the headset; the cap, probed from a second origin, and whether deleting frees a slot;
  `recenter`; off-face and sleep; whether a second headset can restore the same handle (expected
  not).

### Exit plan

- **Store builds (App Store, Google Play) have no web anchor path.** The Capacitor shells run the
  page in WKWebView and Android WebView, where WebXR anchors are absent, and iPhone Safari has no
  WebXR AR. "WebXR first" is not an exit for store users. The route that gives them a real anchor
  or a saved map is the native one: ARKit `ARAnchor` and `ARWorldMap`, and ARCore anchors, behind
  the existing `ArSession` plugin. That plugin is unbuilt for this: it is pose-only, `hitTest`
  returns null, `captureFrame` rejects, and the Android side creates and resumes a session and
  never calls `update()`. It needs the camera and hit-test bridge first, then the anchor and
  world-map methods; it needs a Mac with Xcode and the Android SDK, and named devices. The other
  candidate is a Chrome-based Android shell, which is unverified. Which of the two to fund is the
  owner's decision (D11, with the cost of a Mac and devices).
- **On the web, WebXR anchors are for three runtimes only:** Chrome on Android, Quest Browser and
  Chrome on Android XR. Everywhere else the capability is undefined, which is a supported state and
  the one iPhone is in.
- **What does not change:** 8th Wall stays the pose source on the default path (D11); the Place
  frame is built from taps; a printed fiducial and server registration are the tiers that do not
  need a runtime anchor. ARCore Cloud Anchors, Geospatial and a cloud VPS are only ever an opt-in
  connector with its own consent, because camera-derived data leaves the device.
- `src/ar/native-provider.ts` carries the contract a native bridge has to meet for epochs (a
  tracking reason and an epoch on every pose push, an interruption flag on state pushes), ahead of
  the natives, which send neither yet. `tests/unit/node/native_provider.test.ts` reads both native
  sources and fails when a name drifts.

## Related

- `docs/operations/PLATFORM_SUPPORT.md` — the same treatment for server-side pipelines.
- ADR 0007 — why a rotation-only sweep cannot be reconstructed, whatever the tracking does.
- `src/ar/preflight.ts` — the four-state verdict and the wording every dead end ends with.
- `src/ar/anchors.ts` and `src/ar/frame-epoch.ts` — runtime anchors and the frame epochs they feed.
- ADR 0005 — why nothing here says "verified" before a measurement.
