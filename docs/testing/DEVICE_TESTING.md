# On-device testing over Tailscale

Manual test protocol for real phones against a tailnet server (see
[DEPLOY.md](../operations/DEPLOY.md) for standing the server up). Two device paths:
**iPhone Safari** runs the 8th Wall SLAM scanner; **Android Chrome** runs the
native WebXR scanner.

## Prerequisites

- Phone has the Tailscale app installed, logged into the tailnet, VPN **on**.
- Server healthy: `curl -fs https://<host>:5173/health` shows
  `"engineLoadState":"ready"` (or `systemctl --user status cscan-server cscan-web`).
- Get URLs onto the phone with a terminal QR code:

  ```bash
  npm run qr -- "/smoke.html?debug=remote"        # diagnostics page
  npm run qr -- "/?project=default"               # scanner / uploader entry
  npm run qr -- "/webxr.html"                     # WebXR entry (Android)
  ```

- To see the phone's console on the box, run `npm run logs:watch` and load
  pages with `?debug=remote` appended.

## 60-second triage — /smoke.html

Open `https://<host>:5173/smoke.html?debug=remote` on the device first. All
rows should be PASS (Service Worker may WARN on first visit; XR8 reports n/a —
it only loads in the scanner). Results also stream to `npm run logs:watch`.
If anything fails here, fix it before AR testing — see Triage below.

## Checklist A — iPhone Safari (8th Wall SLAM)

Suggested devices: `iphone182`, `liam-ipad-pro`.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open the scanner URL in Safari | Page loads with **no certificate warning** (Tailscale cert is CA-trusted) |
| 2 | Select or create a **Place**, optionally choose an Area, and complete calibration | GPS/history may suggest a Place; Place selection and alignment are explicit before the scanner opens |
| 3 | Tap **Scan a Place** and grant permissions | Camera + motion permission prompts appear immediately (they must originate from the tap) |
| 4 | Grant both permissions | Camera feed visible; status HUD shows SLAM initialising, then tracking |
| 4 | Walk slowly around the room | Point count in the HUD stats grows; compass/geo chip resolves an address outdoors |
| 5 | Tap the capture button | Progress sweep → detection labels pinned in 3D within ~5–30 s (model-dependent; watch `X-Inference-Ms` in server logs) |
| 6 | Toggle 📷 auto-capture and keep walking | Capture ring pulses on movement; count badge increments; HUD shows per-capture status |
| 7 | Toggle ☁ keyframe streaming | Stream count badge increments as you move; box side: `journalctl --user -u cscan-server -f` shows `POST /sessions/<id>/keyframes` |
| 8 | Open the side panel → export GLB | Upload toast; file lands in `scans/` on the box; optimization job logs run (Draco + LODs) |
| 10 | On a desktop browser open `/editor?project=default` | The new scan appears in the selected Place; LODs load progressively |
| 10 | Share-sheet → Add to Home Screen, launch the PWA | Standalone app opens to the scanner with the same session history |
| 11 | Airplane-mode ON (keep Wi-Fi off), capture | HUD shows offline/queue messaging rather than a spinner hang |
| 12 | Airplane-mode OFF | Queued uploads flush (watch server logs); no data lost |

### A-origin — calibrated origin: ground plane, decal, return visit

Wave 12 ticket 0001. Run after step 2. Use a Place with **no** stored frame for the first pass,
then the same Place again for the return visit. Mock tests prove the decal is in the scene; only
a phone shows whether it lands on the floor.

| # | Step | Expected result |
|---|------|-----------------|
| O1 | First visit to a Place with no stored frame: wait for the readiness step to lock | The teal floor grid appears under the feed, dim until the floor estimate settles, then solid |
| O2 | Place the landmark on the floor and confirm, then place the heading point and commit | One origin appears on the floor: a white crosshair on the landmark and a teal arrow whose **tip sits on the heading point you tapped**. No second ring |
| O3 | Walk 3–4 m away and look back at the origin from two sides | Decal stays fixed on the floor; it does not float or swim with the camera. The arrow still points at the heading point |
| O4 | Turn slowly through 360° with the origin in view | The red north tick stays on the bearing the compass read at commit. Its label says session-local. Cross-check the first reading against a compass app |
| O5 | Keep scanning for several minutes | The floor grid is still visible at low opacity for the whole scan. Before ticket 0001 it was removed at commit |
| O6 | Export the scan (step 8), then open the World file for this Place | The scan's `calibrationGroundY` is a number in metres, not null. It is the height the floor grid was drawn at |
| O7 | Second visit, same Place: go through the reference photos and place both points | After the separation check passes, a dimmer **stored** origin appears. Its arrow and the committed arrow differ by the residual the status line reports |
| O8 | Second visit: deliberately place the heading point about 0.5 m off | The flow sends you back to re-place. No stored origin is drawn. Overriding the check still commits one origin |
| O9 | Skip calibration on a Place | The floor grid is removed with the flow. No origin appears, and scanning proceeds uncalibrated |
| O10 | Tap a point on a tabletop (~75 cm up) as the landmark | The existing "cm above the floor" gate rejects it. It still accepts a same-height retry |
| O11 | Tap **Continue uncalibrated** on a Place | Status reads "Heading unverified — scanning without project alignment. This scan does not set the Place frame." The Place's stored frame is unchanged on the next visit |
| O12 | Tap **Place anchor without floor check**, then commit | Status reads "Floor check bypassed — provisional…". On a return visit the commit is not `verified`, and a first visit leaves the Place with no frame. Use "Use one point instead (lower accuracy)" to check that the one-point button is labelled and explicit |
| O13 | Commit an origin with a compass fix, then turn to face along the origin's arrow | The amber **frame heading** needle sits under the teal device needle, and its label shows the same bearing, within the compass error you see. Note how far apart they sit. It also appears after a return-visit commit. It stays hidden after a one-point commit and after **Continue uncalibrated** |

The same checks apply on Android WebXR (Checklist B2). The decal is the same code path on both
runtimes.

**Watch the box side throughout:** `journalctl --user -u cscan-server -f` for
API traffic and inference timing; `npm run logs:watch` for on-device console
errors (page must be loaded with `?debug=remote`).

## Checklist B — Android Chrome (WebXR)

Suggested devices: `hanzlas-z-fold7`, `tab-s8-ultra`. The latter can also be
driven remotely over MCP for the UI/permission steps — see
[Remote-controlled testing](#remote-controlled-testing-android-remote-control-mcp)
below.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open `/webxr.html` in Chrome | Support probe passes and auto-forwards to `/?ar=webxr` (needs ARCore / Play Services for AR) |
| 2 | Tap **Start AR** → grant camera | Native `immersive-ar` session starts; HUD (dom-overlay) stays visible over the camera |
| 3 | Sweep the camera slowly across surfaces | Point count grows from hit-test samples (slower than SLAM — expected) |
| 4 | Capture, auto-capture, ☁ streaming, export | Same expectations as Checklist A steps 5–9 |
| 5 | Note the 🥽 runtime toggle | In WebXR mode it links back to the 8th Wall scanner; in the 8th Wall scanner it only appears when `immersive-ar` is genuinely supported |

### B2 — calibration anchor decal (WebXR renderer verification)

**Why this exists as its own checklist.** PR #141 gave `WebXRProvider` a
`THREE.WebGLRenderer` bound to the session's GL context so the calibration decal
can draw over the passthrough. `src/ar/webxr.ts`'s own header says that half
"needs verification on a real WebXR device, not just review" — it replaced the
hand-rolled `session.requestAnimationFrame` loop with
`renderer.xr.setSession()` + `setAnimationLoop()`, added a `local-floor`/`local`
reference-space fallback on two independent request paths, added a guard for
Three's non-XR rAF firing with `frame === undefined`, and reordered renderer
disposal to follow `session.end()`. None of that is reachable from a unit test;
the automated coverage in `anchor_calibration.test.ts` deliberately does not
touch the renderer at all.

Needs an **ARCore-backed Android** (`galaxy-tab-s9-ultra` or
`liams-tab-s8-ultra`). iPhone/Safari does *not* exercise this code — no
`immersive-ar`, so it runs the 8th Wall provider instead. Quest browser is a
useful second data point because its controller-driven input hits the
`pointerdown` path a touchscreen never does, but is not required.

| # | Step | Expected result | Checks |
|---|---|---|---|
| 1 | Open `/webxr.html`, start AR, complete calibration | Anchor decal (ring + crosshair, red north tick) appears on the ground at the tapped point | the renderer draws at all |
| 2 | Walk around the decal | Stays on the same physical spot; does not slide with the camera | world-locking via the per-view pose/projection |
| 3 | Watch the camera feed during step 1–2 | No blanking, flicker or black frames | `renderer.autoClear = false` and the `frame === undefined` skip |
| 4 | Turn at least 90° from where AR started, then compare the north tick against a phone compass app | Tick points the way the compass app says north is, and the spin test below passes | the sign of the yaw correction (a tick checked at the start orientation cannot tell the right rule from the wrong one) and the 0°=north/90°=east claim, end to end through a real magnetometer |
| 5 | Continue scanning after calibration | Point count grows; capture still works | the `setAnimationLoop` swap did not disturb the frame loop's other work |
| 6 | Stop AR and start a second session **in the same page load** | Second session tracks and renders normally | renderer disposal ordering in `stop()` |
| 7 | Record runtime versions | Android / Chrome / ARCore versions noted below | — |

#### B2 step 4: the compass spin test

`sessionFrameBearingDeg()` joins the compass bearing `B` and the camera's yaw in the session. A session
direction at yaw `y` has bearing `B_Z − y`, so turning right by `t` raises `B` by `t` and lowers the yaw by `t`:
the **sum** `B + yaw` is the bearing of the session's +Z axis and must not move while the phone turns on the
spot. The **difference** `B − yaw` is what an earlier build used, and it moves by twice the turn. At the
orientation AR started in, the two give the same number, so a check made there passes under either rule. The
turn is the test. This is computed, not measured: the unit tests use a physical model of a perfect compass, and
this step is what says whether a phone's compass behaves like it.

Open the page with `?debug=pose`. The pose readout's last line reads
`compass B · yaw Y · B+yaw S · B-yaw D · rule R · via V`, in whole degrees; `rule 2` is the current sign rule.
`B` is the bearing the calibration is given: the direction the camera faces, paired with the camera's pose.
`via` says how: `camera` (the camera's own bearing, while the camera is within 60° of level), `top` (the
camera's bearing worked out from the phone's top edge through the AR pose, while the camera points more than
60° up or down, as far as about 72° from level), `platform` (an iPhone's own heading, or any heading under
`?compass=alpha`: its axis is not known) or `withheld` (the compass has a reading that cannot be paired with
this pose: the camera looks nearly at the floor or the ceiling, or the browser and the AR runtime disagree
about how the phone is tipped or turned; the line then reads `compass none`). Add `&bearing=1` to run the previous sign
rule for the whole calibration (the tick, the one-point frame and the stored numbers, which are stamped `1`),
and `&compass=alpha` to run the earlier `360 − alpha` heading instead of the camera's, so each can be compared
with the new rule on one phone.

1. Stand still where AR started and note `B+yaw` and `B-yaw`. Hold the phone steady for a few seconds: the
   compass should not go to `none` (Android Chrome sends no event while the phone is still, and the last
   reading stands).
2. Turn 90° to the right on the spot, then hold still. Pass: `B+yaw` is within 5° of the first reading and
   `B-yaw` has moved by about 180°. Repeat for 90° to the left and for 180°.
3. Repeat with the phone tilted down 60° (the posture for tapping the floor), once more tilted down about 70°,
   and once about 80°, and note each separately. On Android `B` is where the camera points: its own bearing
   while the camera is within 60° of level (`via camera`), the same bearing worked out from the top edge past
   that, as far as about 72° (`via top`), and none beyond it (`via withheld`: a camera that looks nearly at the
   floor has no bearing to speak of). `B+yaw` should hold still in all of them: if it holds in `camera` and
   not in `top`, that is the finding, and `line.turn` (Procedure 4) says how the browser's frame and the AR
   pose's are turned against each other. On an iPhone which axis the heading follows
   is not known (`via platform`), and that is one of the things this test finds out. At 60° the camera's yaw
   is read from half of its forward direction's length, and nearer straight down from less, so it is the
   noisiest there. Write the numbers down and do not round them away. On a tablet, do one run in landscape
   too.
4. Calibrate, then compare the red north tick with a compass app, after turning. A constant `B+yaw` says the
   sign is right, not that it points at north: a constant offset (true against magnetic north, the phone's axis)
   shows only here, or against two surveyed points.

The spin test is the same on every runtime, so it is not only for the B2 device: run it on iPhone Safari
(8th Wall), on Android Chrome through `webxr.html` and on Android Chrome (8th Wall). Record, for each, the
readout lines and the compass app's reading.

#### Results — B2

| Device | Android | Chrome | ARCore | 1 decal | 2 world-locked | 3 no flicker | 4 north | 5 scan ok | 6 restart | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| liams-tab-s8-ultra | 16 | 151.0.7922.169 | 1.55.261550593 | — | — | — | — | — | — | 2026-08-23, driven over MCP. Session reached, decal not: see below. |

**Partial run, 2026-08-23 — what a remote MCP session can and cannot reach.**
Driven from a desk, device stationary. Established:

- `/webxr.html` loads over the Tailscale cert, the `immersive-ar` support probe
  passes, and it forwards into the scanner — **Checklist B step 1 ✅**.
- An `immersive-ar` session starts and the dom-overlay HUD composites over it:
  `#status-text`, the coverage chip and the capture button are all live in the
  accessibility tree while the session runs — **Checklist B step 2 ✅**.
- HUD read *"Tracking lost — move slowly"* throughout, which is correct for a
  device that never moved.

**Steps 1–6 of B2 remain unverified, and cannot be reached this way.** Every one
of them is downstream of a calibration tap; a tap needs a hit-test, a hit-test
needs tracking, and tracking needs the device carried through a textured room.
That is a hard boundary, not a tooling gap — B2 needs a person holding the
tablet.

One further remote-only caveat: `#pose-readout` is `aria-hidden="true"` by
design (it changes every tick and would flood a screen reader), so it never
appears in the accessibility tree and its content cannot be read over MCP at
all. Confirm the readout visually on the device.

```bash
npm run qr -- "webxr.html"
```

## Checklist C — 4D person capture

**Status: unrun.** Every item below needs a person holding a phone (two, for C3). That is a
hard boundary, not a tooling gap. The wave-10 code landed with these outstanding, and they are
tracked here rather than quietly assumed — the same way wave 09 tracks its B2 item.

### C1 — 8th Wall camera contention *(blocking; may reorder the feature)*

The person recorder opens its own `getUserMedia` stream at portrait 1080p, deliberately not
the AR canvas (which has the HUD composited into it and is unusable as a reconstruction
input). On the 8th Wall path the camera is owned by `XR8`, and iOS Safari has historically
allowed only one active capture per page.

1. iPhone → `/` (8th Wall path), start a scan, wait for tracking.
2. Tap the person-capture button on the action rail.
3. Record the outcome:
   - [ ] Recording starts and the AR session keeps tracking → **coexists**, nothing to change.
   - [ ] Recording fails with a camera error → **does not coexist.** Person capture is
         WebXR/Android-only until the 8th Wall path records from `XR8.CameraPixelArray`
         instead, which is lower resolution and may fall below 4DAnyone's 720p floor. Say so
         in the UI rather than failing obscurely.
4. Note the resolution actually delivered (`getSettings()` in the recorder status).

### C2 — Clip quality

1. Record a 6-second clip on iPhone and on Android.
2. Pull the clip (`GET /sessions/<id>/clip/clip.mp4`) and run `ffprobe` on it.
3. Confirm, per device:
   - [ ] Resolution ≥720p on the short edge, ideally 1080p
   - [ ] Portrait, roughly 9:16
   - [ ] Frame count ≥121 (`ffprobe -count_frames`)
   - [ ] The container actually decodes — the client-side count is an estimate from
         duration × nominal fps, and ffprobe is the authority
4. Confirm `pose-track.json` timestamps span the clip and `hasArSession` is true.
5. Note thermal behaviour: an AR session plus a separate camera capture is a heavy load, and
   sustained recording may throttle the tracking the pose track depends on.

### C3 — Multi-device sync residual *(supplies a constant)*

`DEFAULT_SYNC_TOLERANCE_MS` (`src/world/types.ts`) is currently **adopted at 50ms, not
measured**. ADR 0005 rule 5 says a tolerance must cite a measurement; this is the measurement.

1. Two phones on the same tailnet, both calibrated to the **same two ground markers** for one
   Place (this is what puts them in a shared frame — ADR 0005).
2. Both join one take; record a clip on each.
3. Read the residual back: `GET /takes/<takeId>` → each member's `sync.residualMs`.
4. Repeat ≥10 times and record the spread here:

   | Run | residualMs | Notes |
   | --- | --- | --- |
   |  |  |  |

5. Set `DEFAULT_SYNC_TOLERANCE_MS` from the observed spread and cite this table at its
   definition. **If the measured floor exceeds what a moving subject needs** (100ms at 1m/s is
   already 10cm of disagreement), the honest finding is that network round-trip sync is
   insufficient for multi-camera takes and only the single-clip densify path is viable — which
   would make 4DAnyone a dependency rather than a swappable densifier, and falsify ADR 0006's
   central claim. That is a real possible outcome, not a failure of the procedure.

### C4 — Playback

1. With the subsystem in stub mode (`cd subsystems/4d-capture && npm run stub`), queue a
   `person-4d-reconstruct` job for a person scan.
2. In the World Editor, open the scan's splat panel:
   - [ ] A "4D person" layer appears and animates on a loop
   - [ ] Toggling scan-splat visibility hides it and pauses playback
   - [ ] Resident memory stays bounded over a few minutes of looping (the windowed loader)

---

## Checklist D — native ARKit (Scan iOS shell)

The Capacitor iOS shell runs `ScanARPlugin.swift` (ARKit) in place of the 8th
Wall engine. Build it on a Mac: `npx cap sync ios` in `mobile/`, open
`mobile/ios/App/App.xcodeproj`, set **your** Apple development team under
Signing & Capabilities, and run it on the phone. Use an iPhone with LiDAR for
the depth rows, and one without for the rest.

To drive the plugin directly, turn on **Settings → Safari → Advanced → Web
Inspector** on the phone, then open the app's page from Safari's **Develop**
menu on the Mac and use the console. The commands below run there.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Launch the app, start the scanner, grant camera permission | The camera shows behind the web view, fitted whole (contain fit); the HUD sits on top |
| 2 | Walk slowly around a room | Pose events move the overlay; the HUD tracking reads NORMAL |
| 3 | Aim at a wall: `await Capacitor.Plugins.ScanAR.hitTest({ x: 0.5, y: 0.5 })` | `rotation` is not `[0,0,0,1]`; its Y axis is horizontal (the wall's normal), so a placed item faces the wall |
| 4 | Background the app for 10 s, then return | The Web Inspector shows the state after return: the first `tracking` event is `notAvailable`, then pose events carry `normal` or `limited.relocalizing`, and the scan keeps its coordinates |
| 5 | Walk the room for a few seconds, then `await Capacitor.Plugins.ScanAR.saveWorldMap({ name: 'room-7' })` | Resolves with `{ name, bytes }`. Right after start it rejects with ARKit's reason, so save once the room is mapped |
| 6 | Quit the app fully, relaunch, stand where the map was saved, and run `await Capacitor.Plugins.ScanAR.start({ depth: false, hitGrid: 20, worldMap: 'room-7' })` before the scanner starts | Resolves with `worldMap: "loaded"`; `tracking` events go `limited.relocalizing`, then `normal`, and the overlay lines up with the saved room |
| 7 | Quit the app fully again, relaunch, and run the same start with `worldMap: 'room-none'` | Resolves with `worldMap: "missing"`, and the session runs fresh |
| 8 | `await Capacitor.Plugins.ScanAR.saveWorldMap({ name: '../x' })` | Rejects: "A world map name may only use letters, digits, dashes and underscores" |
| 9 | On a LiDAR phone, quit the app and relaunch, then run `await Capacitor.Plugins.ScanAR.start({ depth: true, hitGrid: 20 })` and `await Capacitor.Plugins.ScanAR.captureFrame({ depth: true })` | The start resolves, and the result has a `depth` payload with `width`, `height` and `metersBase64` |
| 10 | With row 6's session running, background the app, wait 10 s, return, then open Xcode → Devices and Simulators → the app → Download Container | `AppData/Library/Application Support/ScanWorldMaps/room-7.worldmap` exists: the autosave ran when the app went to the background |

Rows 5–10 test the plugin directly. In the app, the native session takes its
map name from the page's `?world=` Place (never `default`), so these rows are
the check of relocalization until the Place flow is confirmed on a phone (see
ADR 0010).

## Results matrix

Copy per test session:

| Step | iphone182 | liam-ipad-pro | z-fold7 | tab-s8-ultra | Notes |
|------|-----------|---------------|---------|--------------|-------|
| Smoke page all green | | | | | |
| A2/B2 permissions from tap | | | | | |
| Tracking + point growth | | | | | |
| Capture → detection latency | | | | | |
| Keyframe streaming | | | | | |
| Export → viewer visible | | | | | |
| PWA install | | | | | |
| Offline queue + flush | | | | | |

## Room-loop benchmark — SLAM drift and calibration repeatability

A measurement protocol, not a pass/fail checklist (Procedures 2 to 4, 6 and 8 each end with the
decision rule that goes with the question they answer, and say what to change and what not to).
It exists because three tolerance constants in the calibration system
(`GROUND_TAP_TOLERANCE_M`, `DEFAULT_SEPARATION_TOLERANCE_M`,
`MIN_POINT_SEPARATION_M`) are all bounded by one quantity nothing measures:
how repeatably this app places a point in a room. See
`docs/factory/09-ground-anchor-calibration/0006-room-loop-drift-benchmark.md`.

The pass lines in Procedures 2 to 4, 6 and 8 (15 cm, 3%, 2%, 5%, 5°, and the figures those last
two give) were set before any data existed: they are **adopted, not measured** (ADR 0005 rule 5).
They say which result to act on and which to record and ask about. No constant in the code takes
its value from them; each constant has to cite the numbers this protocol produces.

**Record every run, not a best or a mean.** Drift is stochastic — lighting,
pace and feature density vary — so five runs showing 4/4/5/4/19 cm is a
completely different finding from five showing 8/9/8/9/8 cm, and averaging
both to ~7 cm hides it.

### The instrument

Load the scanner with **`?debug=pose`** to show a live readout under the status
line:

```
pos 1.24 -0.03 -2.10
Δ 6cm · 2.4° · x0.03 y-0.01 z0.05
```

`pos` is the raw camera position in session-local metres. `Δ` is displacement,
yaw difference and per-axis offset **from the session's first tracked pose** —
so walking back to where you started should read near zero, with no arithmetic
in the field. The reference is taken from the first pose after tracking locks,
not at t=0, since the pre-lock pose is meaningless.

`?debug=` is a comma-separated list, so `?debug=pose,remote` shows the readout
*and* mirrors the console to `npm run logs:watch` — useful for recording
numbers without stopping to write them down.

```bash
npm run qr -- "?debug=pose,remote"                 # 8th Wall path
npm run qr -- "webxr.html?debug=pose,remote"       # WebXR path (Android)
```

The WebXR form only started working on 2026-08-23. `/webxr.html` forwarded with
a hard-coded `location.replace('/?ar=webxr')`, which dropped the entire query
string — so the documented Android entry point silently disarmed the very
readout this benchmark is built on, and `?project=` / `?world=` with it. It now
carries the incoming params through. If you are testing an older build, reach
the scanner as `/?ar=webxr&debug=pose,remote` directly.

### Apparatus

Tape a marker on the floor at **Point A** and note a fixed facing direction
(a wall, a doorway). Tape a second marker at **Point B**, at least 1 m away.
Pick three fixed objects as capture targets. Define a perimeter path
A → B → C → D → A around the room.

One piece of tape does three jobs: it is the loop test's return point, the
calibration landmark, and the cross-session re-placement target.

### Procedure 1 — within-session loop drift

Repeat 5× per device. Note held-height and facing each run; both affect the
result and neither is fixed by the tape.

| Step | Action | Record |
|---|---|---|
| 1 | Stand on Point A, tap **Start AR** (`#start-ar-btn`) | Seconds from tap to tracking |
| 2 | Walk the perimeter at **< 0.8 m/s** (the speed above which the app itself warns) | Point count at each waypoint |
| 3 | Return to Point A, same facing | **`Δ` straight off the HUD** — distance and yaw |
| 4 | Exercise capture (`#capture-btn`), auto-capture (`#auto-capture-btn`), keyframe streaming (`#stream-btn`), WebRTC (`#rtc-stream-btn`) | Keyframe upload latency; any dropped frames |
| 5 | Capture one target object from two angles ≥ 60° apart | Did the two detections merge? (dedup radius is 0.4 m) |
| 6 | Tap **Done** (`#finish-scan-btn`) → export | Quality verdict; upload success |

**Targets, not thresholds.** < 10 cm translational and < 5° rotational is a
reasonable expectation. If real drift is consistently worse, that is a finding
about this app's tracking — record it and widen the calibration tolerances
accordingly. Do not treat it as a broken device.

**Point-accumulation rate is a baseline to measure, not a bar to clear.** The
two providers differ by construction: WebXR samples a 6×6 probe grid every
750 ms — a ceiling of 48 probes/sec before 5 cm voxel dedup discards repeats —
while 8th Wall harvests per-frame SLAM world points and can go substantially
higher. Record each separately; a number from one says nothing about the other.

#### Results — Procedure 1

| Run | Device | Held height | Facing | Time to track | Points @ A→B→C→D | Δ distance | Δ yaw | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |

### The probe line

Procedures 2, 3 and 4 read their numbers off one instrument, **`?debug=probe`**. Once
calibration has finished, every tap on the camera view logs one line:

```
[probe] {"v":1,"n":1,"rt":"8thwall","scale":"responsive-unconfigured","method":"two-point-ground","status":"provisional","sepM":2.003,"resM":0,"hit":1,"px":-0.412,"py":0.011,"pz":3.121,"hx":1.302,"hy":-1.289,"hz":0.512,"rng":2.31,"camY":0.203,"pitch":-52.4,"tx":0.512,"ty":0.731,"trk":"NORMAL","why":"UNSPECIFIED","jumps":0,"B":211.4,"yaw":-35.2,"Bplus":176.2,"Bminus":246.6,"scr":0,"y0":1.25,"ax":"camera","alpha":148.6,"beta":37.6,"gamma":0,"abs":1,"wkHead":null,"wkAcc":null,"turn":0,"kept":12,"sprM":0.011,"src":"burst","flrM":0.043,"rej":null,"chk":null,"fitN":null,"fitRms":null,"fitRes":null}
```

That line is an invented example of the shape, not a measurement. The code is
`src/capture/probe-log.ts`, and a test (`tests/unit/node/probe_log.test.ts`) keeps the
table below equal to the keys it writes.

**Arm it.** `probe` makes the lines and `remote` is what sends them off the phone, to the
same place `npm run logs:watch` reads. Without `remote` they stay in the phone's console.

```bash
npm run qr -- "?debug=remote,probe"                 # 8th Wall path (iPhone, Android)
npm run qr -- "webxr.html?debug=remote,probe"       # WebXR path (Android)
```

**Collect it.** Live, while the phone is being tapped:
`npm run logs:watch | grep --line-buffered '\[probe\]'`. Afterwards, on the box that
serves the app, from the repo root (or wherever `SCANS_DIR` points: the relay's lines are kept
in `client-logs.jsonl` there), this prints, for each probe line, the time on the phone's own
clock when the phone logged it, the address the server saw it come from, and then the line:

```bash
node -e 'const last = {}; for (const l of require("fs").readFileSync("scans/client-logs.jsonl","utf8").split("\n")) { try { const e = JSON.parse(l); if (!e.msg.startsWith("[probe] ")) continue; const p = JSON.parse(e.msg.slice(8)); const who = e.ip + " " + e.ua; const gap = p.n > 1 && last[who] !== p.n - 1 ? "GAP " : ""; last[who] = p.n; console.log(new Date(e.ts).toISOString(), e.ip, gap + JSON.stringify(p)) } catch {} }'
```

A new page starts again at `line.n` 1, and the lines come out in the order they arrived, so a
drop back to 1 is where one session ends and the next begins. Two phones tapped at once are
told apart by the second column: each phone reaches the server from its own address.

**Check for gaps.** Within one session `line.n` counts 1, 2, 3 with nothing skipped, and the
command puts `GAP` in front of a line whose predecessor from the same phone is missing. A
missing line is a missing measurement. The relay keeps the last 50 messages and sends a batch
every 3 s, so a tab closed too soon, a page that logs a lot, or a tap whose line could not be
written all leave a hole. Do not fill one by hand: run that session again.

**Wait five seconds after your last tap before you close the tab**: the last batch can
still be on the phone for 3 s. A tap that arrives before the runtime has a pose is ignored, a
tap on anything but the camera view (a button, the panel) is not a probe, and a second tap
while the first is still being measured is dropped: one tap is one line.

**What is in a line.** Numbers and short words from the code, never a GPS position, a photo,
a name, a street address or an id. The relay adds a timestamp, the page path and the phone's
user agent, and the server adds the network address it was reached from, as it does for any
remote log.
`null` means "not available", never zero: `line.B` is `null` without a compass reading, and
`line.px`, `line.py` and `line.pz` are `null` when you continued without a calibration.
`line.scale` is `null` only for a provider that names no scale mode, and `line.jumps` only for
one that keeps no count of frame shifts. Both runtimes the line is written for (8th Wall and
WebXR) name a scale mode and keep a count, so on either a `line.jumps` of 0 means none counted.
`line.chk` is `null` on a Place's first calibration, which compared nothing, and `line.fitN`,
`line.fitRms` and `line.fitRes` are `null` there and on any visit with no fit: one that tapped two
points (`chk` is then `separation`) and one whose points could not be fitted at all (a check point
on the wrong side, the pair tapped the other way round: `chk` is `constellation`). The
raw compass columns (`line.alpha` to `line.wkAcc`) are `null` until the page has had an
orientation event that says something about the compass, which a browser that sends only
relative orientation never has, `line.wkHead` and `line.wkAcc` are `null` on Android, which
has no such fields, and `line.abs` is `null` on an iPhone, whose events have no such property.
`line.turn` is `null` when gravity cannot be read in the screen's plane (the phone lies nearly
flat) or there is no orientation sample. A number the line has no room for (a thousand metres or
more, or a count over 99 999) is `null` too.
`line.kept`, `line.sprM`, `line.src`, `line.flrM` and `line.rej` are `null` when the tap was not read through
the sampler (see the table).

| Field | Unit | What it is |
|---|---|---|
| `v` | | Line format. Always 1. |
| `n` | | Which tap this is since the page loaded. The first tap after calibration is 1. It counts the taps that were measured, so a gap in the numbers is a line that is missing. |
| `rt` | | The AR runtime: `8thwall` or `webxr`. |
| `scale` | | The scale mode the provider reports. On 8th Wall `responsive-unconfigured`, `responsive-originY:<n>`, `absolute-ready`, `absolute-notready` or `absolute-notapplied` (the arms of Procedure 3 are told apart by it), on WebXR `webxr-metric`. `null` is "not reported", **not** "metres". |
| `method`, `status` | | The calibration this session used: `two-point-ground`, `ground-tap-compass` or `known-distance`; `provisional` or `verified`. `null` when you continued without one. |
| `sepM` | m | `separationM`: the distance between this session's two calibration taps. `null` on the one-point tier. |
| `resM` | m | `residualM`: that distance minus the stored pair's. 0 on a Place's first calibration, because nothing was compared. |
| `chk` | | The check the calibration's status rests on: `constellation` (three or more points were fitted to the Place's stored ones) or `separation` (only the distance between two was compared). `null` on a Place's first calibration, which compared nothing. |
| `fitN` | | How many points the fit used (3 for a landmark, a heading marker and one check point). `null` without a fit. |
| `fitRms` | m | The fit's root-mean-square horizontal residual: how far this session's points landed from the Place's stored ones on average. DX2 reads it, over five sessions, to set the tap noise (`SIGMA0_M`). `null` without a fit. |
| `fitRes` | m | Each point's horizontal residual after the fit, in the order the points were tapped: the landmark, the heading marker, then the check point. A list of numbers, or `null` without a fit. |
| `hit` | | 1 when the tap found a point (a surface hit, or the median of a burst of them), 0 when it found nothing or the sampler could place no point for it (`rej` says why). Every coordinate below is then `null`. A probe tap is read with the calibration's range and scatter limits lifted, so a tap beyond them still has `hit` 1. |
| `px`, `py`, `pz` | m | The tapped point in the **Place frame**: origin at the landmark, +Z towards the heading marker, +Y up. |
| `hx`, `hy`, `hz` | m | The same point in the **session frame**: the frame of this AR session, origin wherever AR started. |
| `rng` | m | How far from the camera the runtime says the hit is; for a burst, the median over the hits kept. |
| `camY` | m | The camera's height in the session frame at the tap. |
| `pitch` | deg | The camera's pitch at the tap: 0 level, −90 straight down, positive looks up. |
| `tx`, `ty` | 0 to 1 | Where on the camera view the tap landed, from the left and from the top. |
| `trk` | | The tracking status the runtime reported at the tap (`NORMAL`, `LIMITED`, ...). |
| `why` | | The runtime's tracking reason, when it gives one. 8th Wall documents `INITIALIZING` and `UNSPECIFIED`; the line writes whatever name the runtime reports. Which names a phone does report is for the walks of device experiment DX4 to list, from the `[8thwall] trackingStatus:` lines (not yet written up in this file). |
| `jumps` | | Frame shifts the provider has counted so far: measured pose jumps and the resets the runtime reports (the same count as the calibration card's "frame shifts"). A recovery or a resume that came with no measured step is not in it: the card shows those as "tracking interrupted", and the line does not carry them. Both runtimes count, so 0 is "none counted". `null` only for a provider that keeps no count: that is not "no shifts". |
| `B` | deg | The compass bearing the calibration is given (0 north, 90 east), clockwise from **magnetic** north: no declination is applied, so it is not a bearing from true north. It is the direction the camera faces, paired with this tap's pose (`GeoTracker.pairedCompass`): `webkitCompassHeading` on iOS, whose axis is not known, and on Android the direction the back camera points, worked out from `alpha`, `beta` and `gamma`. While the camera points more than 60° up or down the reading is the phone's top edge's, and `line.B` is the camera's bearing worked out from it through the AR pose, or `null` when that cannot be done (the camera looks within about 17° of straight up or down, or the browser and the AR runtime disagree about how the phone is tipped or turned). `line.ax` says which axis the reading follows. It does not wait for a GPS fix. |
| `yaw` | deg | Which way the camera faces in the session frame: 0 is session +Z, 90 is session +X. |
| `Bplus` | deg | `B + yaw`, folded into 0 to 360. This is what `sessionFrameBearingDeg` in `src/world/geo.ts` computes under the current sign rule (`bearingConvention` 2). |
| `Bminus` | deg | `B − yaw`, folded into 0 to 360. What `sessionFrameBearingDeg` computed under the earlier rule (convention 1), which `?bearing=1` still selects. |
| `scr` | deg | `screen.orientation.angle`: 0 upright, 90 or 270 on its side. |
| `y0` | m | The camera's height in the session frame at the first pose the scanner recorded once the runtime reported tracking: the height AR started from, as the runtime counts it. It starts again if you clear the session, so a fresh page per run keeps it the start height. |
| `ax` | | Which axis of the phone the compass reading follows: `camera` (where the back camera points), `top` (where the top edge of the screen points: the reading when the camera points more than 60° up or down, and for a phone that reports no tilt; `line.B` is then worked out from it through the AR pose, or `null`) or `unknown` (an iPhone's own heading, or any heading under `?compass=alpha`: which axis an iPhone's follows is what Procedure 4 is for). `null` when there is no compass sample or it was refused. |
| `alpha`, `beta`, `gamma` | deg | The raw angles of the last orientation event that said something about the compass, as the browser delivered them: Euler angles of type Z-X'-Y'' (`alpha` 0 to 360, `beta` −180 to 180, `gamma` −90 to 90). On Android that is the last *absolute* event, not whichever of the two streams spoke last. On an iPhone `alpha` counts from an arbitrary direction. |
| `abs` | | That event's `absolute` flag: 1 when its angles are measured from the earth's frame, 0 when from an arbitrary one, `null` when the event has no such property, which is every event on an iPhone (Safari on iOS does not implement it). |
| `wkHead`, `wkAcc` | deg | That event's `webkitCompassHeading` (the heading iOS reports for itself, from magnetic north) and `webkitCompassAccuracy` (the error iOS claims; **negative means iOS says the heading is invalid**, and then `line.B` is `null`). |
| `turn` | deg | How far the AR pose's camera frame is turned from the browser's orientation frame about the screen's normal, from −180 to 180, read from the direction gravity has in the plane of the screen in each (`screenTurnDeg` in `src/geo/compass-heading.ts`). About 0 when the two frames are the same, about 90 or −90 when one of them follows the screen into landscape and the other does not. The pairing of a top-edge heading rests on it, and this is the only measurement of it: Procedure 4 reads it. `null` when gravity cannot be read in the screen's plane (the phone lies nearly flat) or there is no sample. |
| `kept` | | The hits the tap's point is the median of: 12 for a burst of twelve usable hits, 1 for a tap read with one hit (`tap=single`, or a runtime whose burst saw no frame), 0 for a tap the floor ray placed with no hit at all. For a refused tap, the usable hits the sampler had counted when it refused it (none are counted for `tracking`). |
| `sprM` | m | How far the kept hits scatter: the root-mean-square distance from their median. `null` for one hit, which has no scatter to measure. For a tap refused for scatter (`rej` `unsteady`), the scatter that refused it. It is the jitter inside one tap, which `TAP_SPREAD_MAX_M` (4 cm, adopted) limits. It is not how far two visits' taps land from each other, and nothing here feeds it into the noise figure a verdict is judged by. |
| `src` | | Where the point came from: `burst` (the median of a burst of hits), `single-hit` (one hit) or `floor-ray` (the camera ray through the pixel met the fitted floor, which only `tap=floor` lets set the point). `null` for a refused tap. |
| `flrM` | m | How far the floor ray through the same pixel lay from the median of the hits, when the fitted floor was locked, supported and level enough to cast one (`floorFitIsReliable`); `null` otherwise. A feature-point hit that slid along the ray shows here. |
| `rej` | | Why a calibration tap at this spot would have been refused. With `hit` 1 it names the limit the tap was over, and the point is kept: `too-far` (`rng` beyond `TAP_RANGE_MAX_M`, 3 m, adopted) or `unsteady` (`sprM` beyond `TAP_SPREAD_MAX_M`, 4 cm, adopted), the range first if both. With `hit` 0 it names why no point could be placed: `tracking` (the map was not stable), `no-hit`, `too-few-hits`, or `unsteady` (too many of the hits were strays). `null` for a tap inside both limits. |

### Procedure 2 — probe-point protocol (DX2)

*This replaces the earlier Procedure 2, which recorded only the spread of `separationM`.* That
number is blind to what goes wrong: two taps the same distance apart give the same
`separationM` whether the frame sits where it did last time or half a metre away and turned a
few degrees. This procedure taps points the frame was **not** built from and asks where the
frame says they are. It is the first measurement of how repeatably this app places a point in
a room, and the tolerances should be set from it, not from a guess.

**Marks.** On a hard floor, put a tape cross at each:

| Mark | Where |
|---|---|
| **A** | The landmark. |
| **B** | 2 m from A. Moved to 1.2 m and to 4 m for the repeats. |
| **C** | About 4 m from A and about 2.5 m off the A–B line. |
| **D** | About 6 m from A, on either side of the line. |

With a tape, write down five distances to the centimetre: **A–B, A–C, B–C, A–D and B–D**. They
are the ground truth, and no coordinates are needed. They change when B moves, so measure
them again for each baseline.

**Which side.** For C and for D also write down which side of the line from A to B the mark is
on, as you see it standing on A and looking at B: **left** or **right**. The tape cannot tell
them apart; your eyes can, and it is the only thing that settles handedness. The Place frame is
right-handed (origin at A, +Z towards B, +Y up), so a mark on your left must come out with a
positive `line.px` and one on your right with a negative one. Moving B can change which side C
is on, so write it down again for each baseline.

**Why the short baseline is 1.2 m and not 1 m.** The scanner will not accept a pair of markers
closer than 1.0 m (`MIN_POINT_SEPARATION_M`): the card says "The markers are too close together
to fix a reliable heading" and keeps **Use this alignment** off. A baseline taped at exactly
1.000 m is read as shorter than 1.0 m in about half of all sessions, whatever the tap noise is,
because the reading is as likely to land under the tape as over it. A 1 m arm would be blocked
in half its sessions, and measured only in those where the taps happened to read long. 1.2 m
leaves 20 cm. That margin is adopted, not measured (ADR 0005 rule 5): how often it still blocks
a session is one of the results of this procedure.

**One session.** Each session is a fresh page: close the tab between them.

| Step | Action | Record |
|---|---|---|
| 1 | Close the browser tab completely. Open the scanner from the QR code with `?debug=remote,probe`. Choose this runtime and baseline's Place. Make one new Place for each runtime and baseline (for example `iphone-2m`, `android8w-2m`, `androidxr-2m`), so a return visit is compared with a pair of the same length that the same runtime made | — |
| 2 | Stand on A and tap **Start AR** (`#start-ar-btn`, the **Walk the room** card) | — |
| 3 | Calibrate the default way. Sweep the floor until the grid settles, tap A and choose **Confirm landmark**, walk to B and tap it, choose **Skip the check point** (this is the two-point arm; the three-point arm is under "Later repeats"), then choose **Use this alignment**. One tap each, from no more than 2 m away, the phone looking steeply down and held still while the ring on the card fills (about half a second: the tap is read as a burst of hits). If the card says a spot did not read steadily, or is too far away, hold still or move closer and tap again. A second tap is judged by the limits first: inside them it is an ordinary tap. Only where it exceeds the same limit again, at the same spot (its hits land within 10 cm of where the refused ones did, wherever on the screen your finger was), is it taken anyway, and the card says "Used anyway" and what it measured (that is not the **Use anyway** button of the mismatch screen below, which you must not choose). Write that down: for the landmark, the saved calibration then shows a scatter or a range past the limit; the heading marker's tap is not saved, so the card is the only record of it. If it says the markers do not match the stored pair, choose **Re-place points** and tap A and B again. **Do not choose "Replace this Place's reference"**: it rewrites the Place's frame. If it says the markers are too close together, the session is **blocked**: write down the separation the card shows, close the tab and start the session again. Do not walk further or tap again until the button comes on, because that measures a longer baseline than the one you taped | Whether a mismatch appeared; whether it was blocked, and the separation shown |
| 4 | Walk to about 2 m from C, hold the phone looking steeply down, and tap the middle of the C cross once, holding still for half a second while the tap is read | That is `line.n` 1 |
| 5 | Walk to about 2 m from D and tap the middle of the D cross once | That is `line.n` 2 |
| 6 | Optional. Walk back to A and tap C, then D, from there | `line.n` 3 and 4: the long-range taps. They are read with the range and scatter limits lifted, so they keep their position, and `line.rej` says `too-far` for a tap beyond 3 m: `line.rng` is how far |
| 7 | Wait five seconds after the last tap, then close the tab | — |

A tap with `line.hit` 0 found no surface or no point the sampler could place (`line.rej` says
why), and a tap that missed the cross is not a measurement. Tap the same cross again and note
which `line.n` is the real one for that mark. A tap with `line.rej` set and `line.hit` 1 is a
measurement all the same: it is the one a calibration tap would have been turned away for, so
keep it apart when you compare against the 2 m taps.

**Copy** the lines (see "The probe line") and, for each tap you keep: `line.n`, `line.px`,
`line.pz`, `line.rng`, `line.pitch`, `line.sepM`, `line.hit`, `line.rej`, `line.src`,
`line.kept`, `line.sprM` and `line.trk`. A `line.pitch` above −45 means the phone was not looking
steeply down: say so in the notes.

**Repeat.** Baselines of 2 m, 1.2 m and 4 m, five sessions each, on each of iPhone Safari (8th
Wall), Android Chrome (8th Wall) and Android Chrome through `webxr.html` (WebXR). That is 45
sessions; the 2 m baseline on one runtime is a good first day. A blocked session is not one of
the five: run another, and count the blocked ones for each baseline.

**The single-hit arm.** This build reads every tap as a burst of hits, so the sessions above are
the sampled arm (`line.src` `burst`). For the arm without sampling, repeat the 2 m baseline,
five sessions on each runtime, with `&tap=single` added to the address (`?debug=remote,probe&tap=single`):
one hit per tap, and `line.src` says `single-hit`. It is the burst without the burst, not the burst
without the median: there is no outlier rejection, no scatter to turn a tap away for (`line.sprM` is
`null`) and no wait for the phone to be held still. What it shares with the sampled arm is the tracking
gate, the 3 m range limit (on a calibration tap), the floor datum and the evidence the calibration
saves. The floor ray (`line.flrM`) is logged beside the hits in both arms and sets nothing;
for the arm where it sets the point, where the fitted floor is reliable, add `&tap=floor`
(`line.src` `floor-ray`). Whether sampling, or the floor ray, helps at all is what these sessions
decide, and a median removes the jitter inside one tap and not a feature that sits off the surface
in every frame, or a second tap that lands somewhere else.

**Later repeats.** With the three-point fit, repeat the 2 m baseline and probe D only: calibrate A and B
as above, then, in the step the card calls **Add a check point (recommended)**, tap the middle of
the C cross instead of skipping it (the card asks for 3 m from A and 2 m off the line; C is about
that), and choose **Use this alignment**. The return visits to that Place are then fitted (`line.chk`
is `constellation`, with `line.fitRms` and `line.fitRes`). Same marks, same five-session rule,
compared with the sessions above.

**Reading it.** For each runtime, baseline and mark, from the five sessions:

1. **Truth.** Let *s* be A–B and *dA*, *dB* the tape distances from A and from B to the mark.
   Then `z_true = (dA² − dB² + s²) / (2s)` and `x_true = √(dA² − z_true²)`. The tape cannot
   tell left from right, so give `x_true` the sign of the mean `line.px` of the five sessions.
2. **Error of a session** is the distance between (`line.px`, `line.pz`) and (`x_true`,
   `z_true`), in centimetres. Write all five down: do not average them.
3. **Spread** is the sample standard deviation (n − 1) of the five `line.px` and of the five
   `line.pz`. Call them σx and σz. The 1 m and 4 m baselines show what baseline length does.
4. **Bias** is the mean `line.px` minus `x_true`, and the mean `line.pz` minus `z_true`. A bias
   that is the same in every session is a constant offset (a unit or a heading error); the
   scatter around it is tap noise.
5. **Handedness.** Put the side you wrote down for each mark beside the sign of its five
   `line.px`. They agree when left is positive and right is negative in every session. If they
   disagree on a runtime, its Place frame comes out mirrored: that is the finding, and its x
   errors are not to be read until it is explained. (Step 1 took the sign of `x_true` from
   `line.px`, which cannot show this: the side you wrote down is what does.)

**Pass** when the largest of the five errors at D is **15 cm or less**. With five sessions the
95th percentile is the largest of them (nearest rank). The product's target for repeat captures
is 30.5 cm (`docs/product/PLACE_SCAN_DESIGN.md`), so an error between 15 and 30.5 cm meets the
product target and fails this one: record it. **Fail** when it is more than 15 cm. A fail is a
finding, not a broken device. Do not change `DEFAULT_SEPARATION_TOLERANCE_M`,
`MIN_POINT_SEPARATION_M` or `GROUND_TAP_TOLERANCE_M` from one runtime or one baseline: each
constant has to cite the measurement it came from (ADR 0005 rule 5).

#### Results — Procedure 2

Copy one block per runtime and baseline.

| Session | Mark | Side of A→B (L or R) | `line.n` | `line.px` (m) | `line.pz` (m) | `line.rng` (m) | `line.pitch` (°) | Error (cm) | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C | | | | | | | | |
| 1 | D | | | | | | | | |
| 2 | C | | | | | | | | |
| 2 | D | | | | | | | | |
| 3 | C | | | | | | | | |
| 3 | D | | | | | | | | |
| 4 | C | | | | | | | | |
| 4 | D | | | | | | | | |
| 5 | C | | | | | | | | |
| 5 | D | | | | | | | | |

Runtime: ______ · Baseline A–B (tape): ______ m · A–C ______ B–C ______ A–D ______ B–D ______ m

Sessions blocked as too close together: ______ of ______ started (separations shown: ______)

| Mark | σx (cm) | σz (cm) | Bias x (cm) | Bias z (cm) | Largest of five errors (cm) | Side agrees with the sign of `line.px` in all five? |
|---|---|---|---|---|---|---|
| C | | | | | | |
| D | | | | | | |

Pass (largest error at D ≤ 15 cm)? ______ · Handedness (left positive, right negative, every session)? ______

### Procedure 2a — repeatability and floor-gate characterisation, on today's build

The older, cheaper measurement of the same repeatability, read from the `?debug=pose` delta
instead of the probe line. Two independent measurements share one set of runs. Procedure 2
above taps points the frame was not built from; this one is a proxy for that.

Each run is a **separate session** — fully stop and restart AR between runs.

**Where the numbers come from.** `pos` is session-local, so it means nothing
across sessions; `Δ` is anchored to the session's *first tracked pose*, so it is
comparable across sessions only if that first pose is on a fixed physical spot.
**Stand on taped Point A when you tap Start AR, and do not move until the HUD
shows a pose.** That is what makes run 3 comparable to run 1.

| Step | Action | Record |
|---|---|---|
| 1 | Stand on taped Point A. Tap **Start AR** (`#start-ar-btn`) and hold still until the readout appears | Seconds to tracking |
| 2 | Sweep the floor until calibration says *"Floor found"* | **Seconds to ground lock** |
| 3 | Aim at a table or counter (~0.75 m) and tap it | The **cm figure in the rejection message** — and that it *was* rejected |
| 4 | Aim at a chair seat (~0.45 m) and tap it | Same — this is the tight end of the margin |
| 5 | Tap taped Point A on the floor | Whether a correct floor tap is ever falsely rejected |
| 6 | Walk the perimeter loop, return to Point A, same facing | `Δ` distance and yaw (this is Procedure 1's number, for free) |
| 7 | Walk to taped Point B, stand on it, same facing every run | **`Δ` distance** — the measured A→B baseline |

**Step 7 is the repeatability figure.** The tape does not move, so the true A→B
distance is identical in all five runs; every centimetre of spread in `Δ` is the
system's own. Set `DEFAULT_SEPARATION_TOLERANCE_M` above that spread.

Read it as a **conservative proxy, not the real thing**: it measures pose
repeatability at a fixed physical offset, where Procedure 2 measures hit-test
repeatability against a visible mark. It carries operator noise (where exactly
you stand, how you hold the device) that aiming at a taped cross does not, so it
should if anything over-estimate the spread. That direction is the safe one — a
tolerance set too tight is what makes correct repeat visits report false
mismatches. Confirm it with Procedure 2.

**Steps 3–5 are the floor gate.** `GROUND_TAP_TOLERANCE_M = 0.25` is live on
`main` as a guess, and the rejection message already reports the measured height
in centimetres, so the gate characterises itself. What matters:

- A chair seat (~0.45 m) must report comfortably more than 25 cm. If it reports
  30 cm the margin is 5 cm, not the 20 cm the constant's comment assumes.
- A real floor tap must never be rejected. One false rejection in five runs is a
  finding, not noise — the gate is on the path to every scan.

#### Results — Procedure 2a

| Run | Device | Time to track | Time to ground lock | Table tap (cm) | Chair tap (cm) | Floor tap rejected? | Loop `Δ` (dist / yaw) | A→B `Δ` distance |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |

Tape-measured true A→B distance: ______ m (for reference; the spread is what matters, not the absolute error)

Spread (max − min A→B `Δ`): ______ m → proposed `DEFAULT_SEPARATION_TOLERANCE_M`: ______ m

Smallest reported chair-tap height: ______ cm → margin to `GROUND_TAP_TOLERANCE_M` (25 cm): ______ cm

`MIN_POINT_SEPARATION_M` follows from the spread rather than being measured
directly: two markers must be far enough apart that the spread is small relative
to the baseline, or the heading derived from them is noisy. The proposed 1.0 m
holds only if the spread is well under ~10 cm.

### Procedure 3 — units tape test (DX1)

*Is a session metre a metre?* Every length in the calibration system, from the 0.15 m
separation gate to the size of a scan, assumes the runtime's unit is a metre. On the 8th Wall
path nothing checks that, and unless the address asks for one (`?scale=`, in the arms below)
the app sets no scale mode (it does not call `XrController.configure`), so the engine runs its
default. `separationM` cannot answer it: two taps in one session share one unit, so a
consistent error cancels. A tape can, in about an hour. If the unit turns out to depend on how
high the phone was when AR started, this moves to the top of the list: no tolerance should be
tuned before it is settled.

**Marks and devices.** Tape exactly **3.000 m** between two floor marks, **A** and **B**, on a
hard floor, and write the tape reading down. Use iPhone Safari (8th Wall), Android Chrome
(8th Wall), and Android Chrome through `webxr.html` (WebXR, whose unit is the metre by
definition, so it is the control). Use one scratch Place for the whole procedure.

**One run.** Each run is a fresh page. Do **5 runs at each of three start heights, 1.0 m, 1.3
m and 1.6 m, on each runtime**: 45 runs for the arm described by the steps below (arm R0, the
build as it is). The other two arms follow the table.

| Step | Action | Record |
|---|---|---|
| 1 | Close the tab completely. Open the scanner from the QR code with `?debug=remote,probe`. Choose the scratch Place | — |
| 2 | Hold the phone level and still at the start height, and **measure the height of the camera above the floor with the tape**. Tap **Start AR** (`#start-ar-btn`, the **Walk the room** card) and keep still until it tracks (in arm A the phone is moved instead, as the arm says below) | **Start height** (m, by tape) |
| 3 | Calibrate: sweep the floor until the grid settles, tap A and choose **Confirm landmark**, walk to B and tap it, choose **Skip the check point**, then choose **Use this alignment**. One tap each, from no more than 2 m away, the phone looking steeply down. If it says the markers do not match the stored pair, write that down, choose **Replace this Place's reference** and confirm (it only rewrites the scratch Place) and carry on | Whether a mismatch appeared |
| 4 | Tap the floor once anywhere. That tap is the line that carries the numbers | — |
| 5 | Wait five seconds, then close the tab | — |

From the line: `line.sepM` (the distance between your two taps, which the tape says is
3.000 m), `line.y0` (the engine's own number for where the first pose is: whatever it is,
write it next to the tape's start height), `line.rt` and `line.scale`. `line.scale` says which
configuration produced the unit, so it tells the arms below apart.

#### Arms: R0, R1 and A

The runs above are arm **R0**. Two more arms use the switches the build now has, on the two 8th
Wall runtimes only. Android Chrome through `webxr.html` is the metric control, and runs arm R0
alone: WebXR defines positions in metres, so no switch applies to it. Do the arms in this order,
because each one says whether the next is worth the hour. Each arm is 15 runs per runtime, 5 at
each start height.

| Arm | Address | `line.scale` must read | What it tests |
|---|---|---|---|
| **R0** | `?debug=remote,probe` | `responsive-unconfigured` on an 8th Wall runtime, `webxr-metric` on WebXR | The build as it is: the engine's own scale, left alone. |
| **A** | `?scale=absolute&debug=remote,probe,pose,verbose` | `absolute-ready`, or `absolute-notready` if tracking was not NORMAL when you tapped | The engine's own metric estimate ([configure](https://8thwall.org/docs/api/engine/xrcontroller/configure)): Niantic describes the phone as moved back and forth until it settles ([announcement](https://info.nianticspatial.com/blog/introducing-absolute-scale)). |
| **R1** | `?originY=<h>&debug=remote,probe`, with `<h>` the nominal start height of the run (1.0, 1.3 or 1.6), typed into the address before the run | `responsive-originY:1`, `responsive-originY:1.3` or `responsive-originY:1.6` | Responsive scale with the camera origin set to the height the phone really starts at, by the pattern of Niantic's own [onStart example](https://8thwall.org/docs/api/engine/camerapipelinemodule/onstart): if the unit follows the origin height, a unit is a metre when `<h>` is the true start height. Optional and cheap. |

`?originY=` takes 0.3 to 3 m and is ignored in absolute scale. In arm R1 `<h>` is the nominal
height, and the camera is held to it, not the other way round: the arm treats `<h>` as the true
start height, so every centimetre between the two is an error in the unit (2 cm at 1.0 m is 2%,
against the 3% this procedure judges by). Make a QR code for each height
(`npm run qr -- "?originY=1.3&debug=remote,probe"`), hold the camera within 2 cm of `<h>` by the
tape before **Start AR** (adopted, not measured), hold it again if it is not, and write the tape
reading beside `<h>`. If `line.scale` reads anything else, the run was not an arm run:
`responsive-unconfigured` in arm R1 means the height was not applied, and `absolute-notapplied` in
arm A means the engine did not take the setting. Write the run down and run it again. `verbose` in
arm A is for the lines below, and it fills the relay's 50-message buffer with the scanner's ticks,
so leave it out of the other arms.

**In arm A** the engine settles its estimate while the phone is moved, so step 2's "keep still"
does not apply: after **Start AR** move the phone gently back and forth until the calibration card's
tracking line reads `Tracking NORMAL`, then bring it back to the start height and hold it still. That
line is the live cue (start a stopwatch at the tap and stop it there; the log has the exact times
afterwards). Also write down, for each run:

1. The time from the camera starting (the `[8thwall] Camera status: hasStream` line) to the first
   `[8thwall] trackingStatus: NORMAL` line (a reason can follow the status in parentheses), and how many
   `trackingStatus` lines before it were not NORMAL. Read them with
   `grep -h '\[8thwall\]' scans/client-logs.jsonl`: each row's `ts` is the phone's clock in
   milliseconds. If the relay dropped one, take the stopwatch's time from the tap on
   **Start AR** instead, and say so.
2. The camera's height right after the first NORMAL: with the phone back at the start height you
   measured and held still, read `pos` (the second number is the height) in the `?debug=pose`
   readout. This is the direct check of the engine's own scale. `line.y0` is not this: it is the
   first pose the scanner recorded, which can come before NORMAL.
3. The time from **Start AR** (the **Walk the room** card) until the calibration lets you tap, and
   the motion it asked for: the card's words, and what you did. The build's own coaching prompt, and
   the time to ready, come with WP-06b; until then this is a stopwatch and what you did.
4. Whether a `[8thwall] frame discontinuity` line appears in the 60 s after the first NORMAL, which
   you spend still at the start height before step 3 of the table. Write down its `cause`,
   `translationM` and `yawDeg`.

#### Results — Procedure 3

Copy these tables for each runtime and arm. The start height is the nominal one first (the address
of arm R1 has it in it), then the tape's reading.

| Run | Arm | Runtime | Start height: nominal / tape (m) | `line.sepM` (m) | `line.y0` (m) | `line.scale` | Mismatch dialog? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | | 1.0 / | | | | | |
| 2 | | | 1.0 / | | | | | |
| 3 | | | 1.0 / | | | | | |
| 4 | | | 1.0 / | | | | | |
| 5 | | | 1.0 / | | | | | |
| 6 | | | 1.3 / | | | | | |
| 7 | | | 1.3 / | | | | | |
| 8 | | | 1.3 / | | | | | |
| 9 | | | 1.3 / | | | | | |
| 10 | | | 1.3 / | | | | | |
| 11 | | | 1.6 / | | | | | |
| 12 | | | 1.6 / | | | | | |
| 13 | | | 1.6 / | | | | | |
| 14 | | | 1.6 / | | | | | |
| 15 | | | 1.6 / | | | | | |

Arm A, per run (the same runs as above):

| Run | Runtime | Start height: nominal / tape (m) | Time to NORMAL (s) | `trackingStatus` lines before it that were not NORMAL | Camera height after NORMAL (m, `pos`) | Time to tap-ready (s) and the motion asked for | Discontinuity lines in the 60 s (`cause`, `translationM`, `yawDeg`) | `line.sepM` (m) | `line.scale` | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | 1.0 / | | | | | | | | |
| 2 | | 1.0 / | | | | | | | | |
| 3 | | 1.0 / | | | | | | | | |
| 4 | | 1.0 / | | | | | | | | |
| 5 | | 1.0 / | | | | | | | | |
| 6 | | 1.3 / | | | | | | | | |
| 7 | | 1.3 / | | | | | | | | |
| 8 | | 1.3 / | | | | | | | | |
| 9 | | 1.3 / | | | | | | | | |
| 10 | | 1.3 / | | | | | | | | |
| 11 | | 1.6 / | | | | | | | | |
| 12 | | 1.6 / | | | | | | | | |
| 13 | | 1.6 / | | | | | | | | |
| 14 | | 1.6 / | | | | | | | | |
| 15 | | 1.6 / | | | | | | | | |

For each runtime, arm and start height, take the five `line.sepM`: the **mean**, and the
**spread**, which is (largest − smallest) divided by the tape's 3.000 m, as a percentage.

**Decision**, per runtime and arm:

- **Units are fine** when, at every start height, the mean is within 3% of the tape (between
  2.910 and 3.090 m) and the spread is under 2% (under 0.060 m), **and** the three means do not
  rise or fall with the start height by more than the largest of the three spreads.
- **Units are suspect** when `line.sepM` tracks the start height (the means at 1.0, 1.3 and
  1.6 m move together with the height) or the spread at any height is over 5% (over 0.150 m).
  Send the table. This promotes unit handling above every other calibration change: a real
  scale has to ship before any tolerance is tuned.
- **Anything in between** is not a decision. Record it and ask; change no constant.

**Decision for arm A: flipping the default.** `DEFAULT_ENGINE_SCALE` in `src/ar/engine-config.ts`
becomes `'absolute'` only if, on each 8th Wall runtime, all of these hold. The figures are
**adopted, not measured** (ADR 0005 rule 5): this experiment is what replaces them.

- The mean `line.sepM` is within 3% of the tape and the spread is under 2% at every start height,
  and the means do not follow the start height (the rule above, for arm A).
- At least 4 of the 5 runs at each height reach NORMAL within 20 s of the camera starting, and the
  median time to NORMAL is 10 s or less.
- The camera's height right after the first NORMAL is within 5 cm of the start height you
  measured with the tape.
- No `frame discontinuity` line in the 60 s hold after the first NORMAL. (The build calls a step of
  0.30 m a jump: `FRAME_JUMP_TRANSLATION_M` in `src/ar/frame-epoch.ts`.)

If arm R0 already passes the first bullet, keep it: the default stays and `line.scale` is still
recorded. If arm A fails on time or reliability, the unit has to be fixed at the source instead,
with a printed tag of known size (Procedure 8) or a tape length typed in at the first calibration
(owner decision D3). Arm R1 passing while arm R0 fails says the unit follows the origin height,
and that a known start height would fix it. Flipping the default is the owner's decision D3: this
procedure supplies the table, and the flip is one line, recorded with the results.

### Procedure 4 — compass sign, handedness and offset (DX3)

*Does the compass turn the same way the session does?* `sessionFrameBearingDeg` in
`src/world/geo.ts` joins a compass bearing and a camera yaw, and it **adds** the yaw (the sign rule
`bearingConvention` 2; the earlier build subtracted it, and `?bearing=1` still selects that). In a
right-handed session, turning right raises the compass bearing and lowers the yaw, so it is the
**sum** that should hold still while turning on the spot, and the difference that should move
by twice the turn. If a real phone does that, adding cancels the turn; if it does the opposite,
the sign rule is wrong for that runtime. The arithmetic is checked by a test
(`tests/unit/node/probe_log.test.ts`). This procedure checks whether a real phone's compass and
a real session agree with it: about two minutes per posture, then a survey.

**Part 1: the spin test.** Use iPhone Safari (8th Wall), Android Chrome through `webxr.html`
(WebXR) and Android Chrome (8th Wall). Mark four facings on the floor from one spot with tape,
at 90° steps (use the corner of a room, or a square): **M0** is where you start, **M90** is
90° to the right of it, **M180** is behind, **M270** is 90° to the left.

| Step | Action | Record |
|---|---|---|
| 1 | Close the tab. Open the scanner with `?debug=remote,probe`. Stand on the spot facing M0, hold the phone the way you hold it to tap the floor, and tap **Start AR** (`#start-ar-btn`, the **Walk the room** card). If the app asks for a Place, choose one, and either calibrate or choose **Continue uncalibrated**: the compass columns are logged either way | — |
| 2 | Facing M0, tap the floor once | Line **T0** |
| 3 | Turn right on the spot to face M90. Tap | **T1** (turned +90°) |
| 4 | Turn back to M0. Tap | **T2** (turned 0°: it should repeat T0) |
| 5 | Turn left to face M270. Tap | **T3** (turned −90°) |
| 6 | Turn back to M0, then turn all the way round to face M180. Tap | **T4** (turned 180°) |
| 7 | Wait five seconds, then close the tab | — |

Do the whole list twice: once with the phone held as you would hold it level (`line.pitch`
near 0), once **tilted down about 60°** (`line.pitch` near −60: it is the posture of a tap). On
a tablet, or any device you can turn, do it again **in landscape** (`line.scr` reads 90 or
270). Check `line.pitch` and `line.scr` on the lines: they say what posture you really held. To compare the
camera's bearing with the earlier `360 − alpha` heading on one phone, do the list a third time with
`&compass=alpha` added to the address: its lines say `line.ax` `unknown`, and the pass rule below applies to
them too.

From each line: `line.B`, `line.yaw`, `line.Bplus` and `line.Bminus`, `line.ax`, the axis of the
phone the compass reading followed (on Android `camera` while the camera points within 60° of level
and `top` beyond it, so a tap at `line.pitch` −60 is on the line: write down which one you got), and
`line.turn`. Keep the whole line too: `line.alpha`, `line.beta`, `line.gamma`, `line.abs`,
`line.wkHead` and `line.wkAcc` are the raw sensor values `line.B` was worked out from. A level phone usually
finds no floor (`line.hit` 0), and that is fine here: the compass columns are logged for every
tap. If `line.B` is `null` the page had no compass reading on that device: write that down, and
open `/compass-bench.html` to see whether the browser gives one at all. If `line.wkAcc` is
negative, iOS says its compass is not calibrated and gives no usable heading: write that down
(`line.B` is `null` for that tap).

**Reading it.** Take T0 as the reference. For each later tap the turn *t* is the one in the
table (+90, 0, −90, 180). Compare around the circle (359° and 1° are 2° apart):

- `line.Bplus` should be within **5°** of its value at T0.
- `line.Bminus` should be within **5°** of its value at T0 **plus 2 × *t***.

**Pass** when both hold for every tap, in every posture, on that runtime. That confirms the
sign: the sum holds still and the difference moves by twice the turn. If it is the other way
round (`line.Bminus` holds still and `line.Bplus` moves by 2 × *t*), the sign is the other way
on that runtime: write it down as the finding, not as a pass. If neither holds, compare `line.B` at T0
and at T2, which are the same facing: if they differ by more than 5° the compass does not
repeat in this spot.

**The turn between the frames.** `line.turn` is read for every tap, and it is the number the pairing of
a top-edge heading rests on: it says how the AR runtime's camera frame is turned from the browser's about
the screen's normal. Write it down next to `line.scr` for each posture. In portrait (`line.scr` 0) it
should read about 0. In landscape it reads about 0 if both frames follow the phone, and about 90 or −90 if
one follows the screen and the other does not; either is fine: the app measures it, and uses it when the
camera points more than 60° up or down (`via top` in the pose readout), where `B+yaw` should hold still. A
reading that is not within 20° of
a multiple of 90° means the two do not describe one attitude: write it down, and expect `line.B` to be
`null` where `line.ax` is `top`. `line.turn` is `null` for a phone lying nearly flat, which is not a
finding.

**Which axis an iPhone follows.** Apple documents `webkitCompassHeading` as a direction relative to
magnetic north and says nothing about which axis of a tilted phone it follows, so an iPhone's lines
say `line.ax` `unknown` and the app gives them at least 25° of uncertainty
(`IOS_COMPASS_SIGMA_FLOOR_DEG` in `src/geo/compass-heading.ts`, adopted, not measured). The raw columns
settle it. On an iPhone `line.alpha` is not from north: it counts from an arbitrary direction, so it
differs from a compass bearing by an amount that should stay the same within one page (a reload, or slow
drift, changes it), and that is what lets two candidates be compared. For each tap work out the two
candidates from `line.alpha`, `line.beta` and `line.gamma` with
`axisHeadingsFromAttitude(line.alpha, line.beta, line.gamma)` in `src/geo/compass-heading.ts`: it gives
the camera's bearing (`camera.headingDeg`) and the top edge's (`top.headingDeg`, which is
`360 − line.alpha` when `line.beta` is between −90 and 90), each with the part of the axis that is
horizontal (`horizontal`). It is not `headingFromAttitude`, which picks one axis and so gives the
top edge for both candidates once the camera points more than 60° up or down. An axis that is nearly
vertical has a bearing that moves with the smallest tilt error: leave a candidate out of the
comparison for a tap where its `horizontal` is under 0.5. Subtract each candidate from `line.wkHead`
(round the circle: 359° and 1° are 2° apart). The candidate whose difference stays the same from tap
to tap, in every posture (level, tilted 60°, landscape), is the axis the compass follows; if neither
does, write that down. Taps made on one page only: a reload changes the constant.

#### Results — Procedure 4, part 1

| Runtime | Posture (`line.pitch`, `line.scr`) | Tap | Turn *t* | `line.B` | `line.ax` | `line.turn` | `line.yaw` | `line.Bplus` | `line.Bminus` | Bplus within 5° of T0? | Bminus within 5° of T0 + 2*t*? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | T0 | 0 | | | | | | | — | — |
| | | T1 | +90 | | | | | | | | |
| | | T2 | 0 | | | | | | | | |
| | | T3 | −90 | | | | | | | | |
| | | T4 | 180 | | | | | | | | |

**Part 2: offset and spread (a survey, not a pass or fail).** These are the numbers a
compass-based georeference would be judged by. They need a true bearing, so they take a map. The
instrument is `/compass-bench.html`: it shows the compass reading the app would take and where the
browser got it (`webkitCompassHeading` on iOS; on Android the direction the camera points, worked
out from `alpha`, `beta` and `gamma`, or the top edge's when the camera points more than 60° up or
down, as `src/geo/compass-heading.ts` reads them). Every bearing it shows is from magnetic north.

1. **Outdoors**, pick two points, P1 and P2, about 50 m apart that you can place on a map (two
   corners of a building will do). From the map get the **true** bearing from P1 to P2, and
   call it *T*.
2. Stand at P1. Mark four facings on the ground: along the line towards P2 (*T*), the two
   directions at right angles to it (a carpenter's square, or a taped 3-4-5 triangle with its
   4 m side along the line, gives the right angle) and back along the line. Their true bearings
   are *T*, *T* + 90, *T* + 180 and *T* + 270.
3. Open `/compass-bench.html` (on an iPhone, tap **Enable motion sensors** first). Face one
   mark with the phone held upright and its back camera pointing at the mark, hold still for ten
   seconds, tap **Mark spot**, and write down the `mean` and `sd` it shows for that mark. Do the
   same for the other three facings.
4. Do steps 2 and 3 again at P2, whose line back to P1 has true bearing *T* + 180.
5. **Indoors**, do steps 2 and 3 at **three** spots in the building, using walls whose true
   bearing you have from the map or the plan as the facings.

For each facing the **offset** is `mean − true bearing`, taken into the range −180 to 180. The
average offset over one spot's four facings is what the magnetic declination and a constant
bias add. How far apart the four offsets are is how much the compass bends with the way you
face. An indoor spot whose average offset differs from the outdoor one by more than its own
`sd` points at steel in the building.

#### Results — Procedure 4, part 2

| Place | Facing | True bearing | Bench `mean` | Bench `sd` | Offset |
|---|---|---|---|---|---|
| Outdoors, point 1 | 1 | | | | |
| | 2 | | | | |
| | 3 | | | | |
| | 4 | | | | |
| Indoors, spot 1 | 1 | | | | |

(Copy the facing rows for each spot: outdoors point 2, and indoors spots 1 to 3.)

### Procedure 5 — return-visit aids on and off (DX10)

*Does what a return visit is now shown make a person tap the same two spots again? Nothing has measured it.* A return visit
to a Place that holds a pair, as every session of Procedure 2 after the first is, is the measurement; this procedure takes it
twice, once with the aids and once without.

**The aids** are on by default. The card says to tap Point A again, the same spot as the photo (or "as last time" when the
photo is not on screen), and how far Point B was from A; once Point A is confirmed a white ring on the floor round it marks that
distance; in review a chip says whether the two markers are the stored distance apart (and that direction is not checked);
and review and the mismatch screen show both stored photos side by side, when the screen has room for them above the card
(on a phone about 650 px high or less they are left out). **`returnaids=off`** switches all of that off and gives the card the
words it had before: add it to the address (`npm run qr -- "?returnaids=off"`, or `&returnaids=off` after another parameter).
How a photo is taken does not change: that is a record, not an aid.

**Procedure.** Per runtime and baseline, make a Place and set its frame in session 1, as Procedure 2 does. Then run ten return
visits, each as a session of Procedure 2 is (its steps 1 to 7), alternating the arms (aids on, then off, and so on, so that
neither arm always goes first). Five sessions of each. Read the error at D from each as Procedure 2's "Reading it" does. Write
down, for each session, whether a mismatch appeared, which photo (if any) the person says they used, how long the card was open
from first tap to commit, and whether it stopped once to say a point had no photo and asked for a second press. Write down once
per phone whether the ring can be seen on the floor at about 3 m and whether the photos can be read at their size. Do not use
the mismatch screen's button that keeps the pair anyway: it rewrites the Place's frame.

**Reading it.** Write down the five errors of each arm: do not average them. No pass line is set, because there is no earlier
figure for it to come from; record which arm had the larger errors and by how much. The ring's radius assumes this session's
unit is the one the points were stored in, as every distance on the card does (Procedure 3 measures that).
### Procedure 6 — WebXR runtimes: resets, tracking loss and anchors (DX6)

*Does a WebXR runtime tell the app when its frame moves, and does a runtime anchor stay put?* The
app counts a frame shift only when the runtime shows one: a reference-space `reset` event, no
viewer pose, an emulated pose, a return from `hidden`, or a step in the pose
(`src/ar/frame-epoch.ts`). Nobody has measured how often Chrome with ARCore or a Quest does any of
that, whether Chrome ever fires `reset`, whether the same anchor comes back after a loss, or how
many persistent anchors a Quest Browser keeps (reports say 5, 6 and 8). The figures below are
**adopted, not measured** (ADR 0005 rule 5): this procedure is what replaces them. Anchors exist
only in Chrome on Android (ARCore), Quest Browser and Android XR Chrome, so there is nothing to run
on an iPhone or in the Capacitor shells.

**Devices.** A Chrome phone with ARCore (two models if you have them), a Quest 3 (a 3S or a 2 too,
if there is one) and, for step 6, a phone with no ARCore (the Beam Pro has none). For each, write
down the OS version (Android or Horizon OS), the browser version and, on the phones, the version of
Google Play Services for AR.

**Arm it.** `npm run qr -- "webxr.html?debug=remote,pose,probe"` for the phone, and the same address
typed into the headset's browser. Lines the page writes with `console.warn` reach
`npm run logs:watch` and `scans/client-logs.jsonl` under `remote` alone. Add `verbose` only to see
every status change (`[webxr] trackingStatus: ...`): it also fills the relay's 50-message buffer with
the scanner's ticks. Afterwards, on the box,
`grep -h '\[webxr\]\|\[scan\] tracking' scans/client-logs.jsonl`: each row's `ts` is the phone's clock
in milliseconds. The scan's upload metadata keeps the same events in `frameEpochs.jumps` (the most
recent 64, `FRAME_LOG_MAX`). Steps 1 and 6 need the page's console: `chrome://inspect/#devices` in a
desktop Chrome with the phone on USB, and for the headset the same with developer mode on and `adb`
running ([Meta's page](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/)).

**What the build writes today.** `[webxr] frame discontinuity <n>: <cause>` (warn) and a JSON object.
`cause` is `reset`, `recovered`, `resumed` or `jump`, and with WP-17b also `anchor` (an anchor
stepped, or the runtime stopped locating one) *(after WP-17b)*. A `reset` carries `transform`, the
runtime's own description of the move, or `null` when it gave none; `recovered` carries `degradedMs`,
`resumed` carries `hiddenMs`, and `jump` carries `translationM` and `yawDeg`. A
`[webxr] trackingStatus:` line reading `NOT_AVAILABLE` means no viewer pose, and one reading
`LIMITED` an emulated position. `[scan] tracking degraded (<status>)` and `[scan] tracking recovered`
(warn) bracket a stretch in either state. The calibration card's `Tracking <status>` line is the
same status live, while the card is open; the scanner and the pose readout run from the start of AR,
behind the card. `Δ` in the `?debug=pose` readout is the distance and yaw from the first pose
the page saw, and nothing moves that reference: not a loss, not a frame shift. So read `Δ` only
where AR was started, and judge a loss by the change in `Δ` across it. A new reference needs a new
page: close the tab.

**What steps 7 to 13 need.** The build creates no anchor and does not write the features the
session granted (`enabledFeatures`): that, and every readout about an anchor, comes with WP-17b and
is marked *(after WP-17b)*. The wiring alone is not enough for these steps: they need a DX6 kit in
the build. That is a line for each anchor event, with the time, the anchor's identity, whether it is
in `trackedAnchors` and whether its pose is null, whether the viewer pose is null or emulated, how
many resets have fired and whether the last had a `transform`, the page's visibility, and how many
anchors are tracked; the anchor's drift from where it was made, readable while you walk; a switch
that makes 1, 5, 20 or 50 anchors in one scan; the outcome of every persistence request (`store-full`
or `runtime-refused` when it failed); and the error name of every anchor or persistence request the
browser refuses (the build treats a refusal as "no" and keeps no name). Until WP-17b adds it, steps 7
to 13 cannot be run. Where the build's names differ from the ones below, the build's own
names win and this page is changed to match. The other features a Quest may grant
(`plane-detection`, `depth-sensing`, `light-estimation`, `camera-access`) are not asked for by the
build, so no run of it can say whether they are granted: that survey needs a switch that asks for
them, and is not part of this procedure.

| Step | Action | Write down | Pass when |
|---|---|---|---|
| 1 | Features, at the desk and before AR. In the page's console run `[typeof self.XRAnchor, typeof self.XRAnchor?.prototype.requestPersistentHandle, typeof self.XRSession?.prototype.restorePersistentAnchor]`. Do not tap **Start AR** yet | The three answers | The phone answers `function`, `undefined`, `undefined` and the headset `function`, `function`, `function`: the build assumes only a Quest can keep an anchor. Anything else is a finding: write it up before going on |
| 2 | Unplug. Stand on a taped mark A, facing the marked direction, tap **Start AR** (`#start-ar-btn`) there, grant the camera and choose a scratch Place if the app asks. Leave the calibration card open through step 5 (step 7 is where you calibrate): its `Tracking` line is on screen only while it is. Do not move until the pose readout shows a pose: that first pose is the one `Δ` is read from. Then hold still for 60 s | Every `frame discontinuity` line; `Δ` at the end of the 60 s; any prompt beyond the camera; the features the session granted (`enabledFeatures`: the build asks for `hit-test`, `dom-overlay`, `local-floor` and `anchors`) *(after WP-17b)* | No line in the 60 s. A line here is the epoch rule firing on nothing: write down its `cause` and size. `anchors` is among the granted features on both *(after WP-17b)*; anything else is a finding |
| 3 | Losses, on A, facing the marked direction. Phone: for each loss read `Δ` (all of it) and write it down, then cover the camera with a hand for 3 s, then 10 s, then 30 s, twice each with 20 s of normal tracking between; then switch to another app for 10 s and come back. After each, hold the phone where it was (a stand is better than a hand), wait until the card's tracking line reads `Tracking NORMAL`, and read `Δ` again. Quest: the same with the headset off for 10 s, and again for as long as it takes to go to sleep, put back on at A facing the same way | For each loss: its lines in order (status, `cause`, `degradedMs` or `hiddenMs`, whether a `reset` had a `transform`); `Δ` before and after; and the change, which is the distance between the two readings' x, y and z and the difference of their yaws. If the session ends instead of resuming, write that down as the result, close the tab and start AR on A again for the next loss | Every loss leaves at least one line, or the change is within 10 cm and 5°. These are this step's own figures (adopted: Procedure 1's targets for a whole walk, used here for one loss). A loss that leaves no line and a larger change is invisible to the one-scan-one-frame rule on that runtime: **fail**; write down how long it lasted |
| 4 | Close the tab and open the page again, so that `Δ` starts again: stand on A facing the marked direction and tap **Start AR** there. Walk 10 minutes through three rooms, back to A with the same facing every 2 to 3 minutes, holding the phone as for a scan | `Δ` distance and yaw at each return; the lines by `cause` for the whole walk; how many were `reset`, and how many of those had a `transform` | Record only: Procedure 1 judges `Δ` (targets of 10 cm and 5°, not thresholds), and the counts are the result. No `reset` line at all is a result, not a fault: say so |
| 5 | Quest only: standing on A, read `Δ`, long-press the Meta button to recenter, and read `Δ` again | The `reset` line and whether `transform` was there; `Δ` before and after; where the `anchors` entry sits before and after, against the physical mark *(after WP-17b)* | Record only: there is no figure to adopt a pass line from |
| 6 | A phone with no ARCore: in the console run `await navigator.xr.isSessionSupported('immersive-ar')`, then tap **Start AR** | The answer, and the error name and message the start ends with | Record only: it is the answer a real device gives, which `tests/mock-webxr-session-failure.spec.ts` imitates from the report that one said `true` and then refused the session |
| 7 | *(after WP-17b)* Anchor creation. Calibrate on A, so that the build asks the runtime for an anchor at the landmark. Take the readings in the next column for every anchor the build makes in steps 8 to 13 too | For each: the time from the request to the anchor being tracked, any failure with its error name (the kit logs it), and what happens to a request that has waited 3 s (Chrome's own limit: its ARCore code fails a creation request older than that, `kOutdatedAnchorCreationRequestThreshold` in `device/vr/android/arcore/arcore_impl.cc`). The hit-result route (`XRHitTestResult.createAnchor`) is not in the build and is compared only if WP-17b adds it | Record only. If the 95th percentile of the times is over 2 s, `ANCHOR_REQUEST_TIMEOUT_MS` (2 s, adopted) is too short: the build gives up on an anchor the runtime would still make |
| 8 | *(after WP-17b)* Drift. With the anchor from step 7, stay still for 60 s, then walk step 4's route and read the anchor at each return. Tape a mark E 9 m from A and tap it, and a mark D within 8 m, for probe lines | The `anchors` entry's `driftM` and `driftDeg` at 60 s, at each return and at 10 min, and at each return how far the landmark's decal sits from the tape on A (by rule); the probe's `line.px` and `line.pz` at E and at D against the tape | `driftM` within 0.10 m and `driftDeg` within 2° at 10 min (the drift flag WP-17b adopts). E against D: record only; the 8 m guidance is Google's, and this is its first check here |
| 9 | *(after WP-17b)* Loss with an anchor live: repeat step 3's losses (the phone's covers, the headset's time off) | Whether the anchor came back, as the same entry or a new one, how many seconds after the loss ended, how long its pose was null, and `driftM` on return | `driftM` within 0.10 m on return (adopted). The longest return time is recorded and sets how many seconds the build waits before it treats a missing anchor as gone. One that never comes back is a finding: the app re-places |
| 10 | *(after WP-17b)* Many anchors, made with the kit's switch: one short scan each with 1, 5, 20 and 50 anchors | The time between frames in each scan's `frameEpochs.motion.dtMs` histogram | Record only |
| 11 | *(Quest only, after WP-17b)* Calibrate on A and choose the build's "Remember this spot on this headset". Then, each time standing on A: (a) close the tab and open the page again, (b) restart the browser, (c) reboot the headset, (d) redo Space Setup. After each, start a return visit and let the build restore; then recenter once more and read it again | For each: restored or not, the error name if not (the kit logs it), the time to restore, and how far from A the restored ghost sits, from three start poses, and again after the recenter | Restores after (a) and (b) with the ghost within 0.10 m of A from every start pose (adopted). A refusal (`InvalidStateError`) means "re-place": write down which of (a) to (d) caused it |
| 12 | *(Quest only, after WP-17b)* Cap. Calibrate a new scratch Place and choose "Remember this spot on this headset" again, and again, until the build stops you or the browser refuses; repeat from the same page on a second origin (another port or host); delete one and add another; clear the site's history; try a private window | How many were kept before the first refusal, and whether it was the build's (`store-full`, which it answers at 5 without asking the browser) or the browser's (`runtime-refused`, with its error name from the kit); whether the second origin shares the count; whether a delete frees a slot; what clearing the history and a private window leave | Five kept from one origin and no refusal by the browser: `MAX_PERSISTENT_ANCHORS` (5) stays. A refusal by the browser before 5 is the evidence for a lower cap, and is the only one: set it to the count. The build never asks the browser for a sixth from one origin, so 6 and 8 are not reached from this page |
| 13 | *(Quest only, after WP-17b)* A second headset: open the page on it and let the build restore what the first one remembered | Whether anything restores | Nothing restores: no handle is synced by this app. Record it if something does |

If the page's overlay cannot be seen inside the headset's session (that the Quest Browser draws it
there is not confirmed), write that down: on the headset every `Δ` reading is then missing, steps 7
to 13 cannot be done (they need the page's buttons), and the lines of steps 2 to 5 are all there is.
The table, with Procedures 2 and 3 run on the same phone through `webxr.html` and through 8th Wall,
is what owner decision D11 (whether Android Chrome defaults to WebXR) needs. A fail in step 3 says
what the one-scan-one-frame rule cannot see on that runtime, not that the runtime is broken.

#### Results — Procedure 6

| Device | OS, browser, ARCore | Step | What you saw | Pass or fail |
|---|---|---|---|---|
| | | 1 | | |
| | | 2 | | |
| | | 3 | (see the table below) | |
| | | 4 | | |
| | | 5 | | |
| | | 6 | | |
| | | 7 to 10 | | |
| | | 11 to 13 | | |

Step 3, one row for each loss:

| Loss | `Δ` before | `Δ` after | Change (cm, °) | Lines, in order | Pass or fail |
|---|---|---|---|---|---|
| Cover 3 s | | | | | |
| Cover 3 s | | | | | |
| Cover 10 s | | | | | |
| Cover 10 s | | | | | |
| Cover 30 s | | | | | |
| Cover 30 s | | | | | |
| Other app 10 s | | | | | |
| Headset off 10 s | | | | | |
| Headset off until it sleeps | | | | | |

### Procedure 8 — fiducial feasibility (DX8)

*Can a phone find a printed tag, place it precisely enough to define a Place frame, and keep doing
it without overheating?* This needs WP-14a (the detector and the print sheets) and WP-14b (the
`?debug=tag` and `?debug=tagneg` readouts and the marker step). Every readout that comes with
WP-14b is marked *(after WP-14b)*, and the sheets *(after WP-14a)*: a build without that package
does not write them. The pass lines are the ones the spec of WP-14b adopts, except where a step says
that it is this page's own reading, and they are **adopted, not measured** (ADR 0005 rule 5): this
procedure is what replaces them. A fail sends the project to the AprilTag build the spec holds as
its contingency, not to a retuned constant.

**Apparatus.** Three phones, all on 8th Wall: the oldest iPhone you have, a mid-range Android and a
Pixel. (Whether the build gives the WebXR runtime camera frames to read is for WP-14b to say, so no
step here depends on it.) Sheets printed at 100%, never "fit to page": A4 with the 160 mm tag and A3
with the 200 mm and 230 mm tags, from `scripts/print-fiducial.mjs` *(after WP-14a)*. Measure the
100 mm scale bar and the black square of every print with a steel rule, to 0.5 mm, and write both
down: the size you use is the one you measured, except in step 8. Fix the wall tag on a flat, rigid
backing with its centre 1.2 m above the floor, and lay a second sheet flat on the floor. For the wall
tag, tape a floor mark at each range *r* and angle *a* off its normal: *r* sin *a* along the wall
from the tag's foot and *r* cos *a* out from it, with the phone held at the tag's height. For the
floor tag, tape marks 1, 2, 3 and 5 m from it along the floor and hold the phone 1.4 m above each. A
tag is read for pose from a side of 40 pixels and for identity only from 24, and the side is
f × size ÷ range face-on (an oblique view shortens it by the cosine of the angle): at a focal length
f of 720 px a 40 pixel side is 2.9 m for the 160 mm tag, 3.6 m for the 200 mm tag and 4.1 m for the
230 mm tag. So the 5 m cells show what the detector does beyond its pose range. The real f comes
from the phone's projection. For the floor tag the phone is 1.4 m up, so the line of sight is longer
than the distance *d* along the floor, and the side is f × size × 1.4 ÷ (*d*² + 1.4²): for the
200 mm tag that is 68 px at 1 m, 34 px at 2 m, 18 px at 3 m and 7.5 px at 5 m. Only the 1 m floor
cell is in pose range, the 2 m cell is in identity range, and the 3 m and 5 m cells lie below the
24 pixel identity limit: they are recorded, for the horizontal-mount policy, and not judged.

**Arm it.** `npm run qr -- "?debug=remote,probe,tag"`. `probe` is in the build today; `tag` is not.
`?debug=tag` *(after WP-14b)* writes the stage times, the side in pixels, the ambiguity ratio, the
residuals, the fused spread, the lag fit, `P[0]`, `P[5]`, `P[8]` and `P[9]` of the projection, `cols`,
`rows`, the canvas size and the fit mode. The build as it is writes the `[8thwall][aspect]` line
(`console.log`, so it needs `remote,verbose`) with `fit`, `canvas`, `frame`, `fovYDeg`,
`projectionAspect` and `crop`. It is printed once, about 4 s after the camera starts, and step 6
reads it: load the page for that step with `?debug=remote,tag,verbose` and leave `verbose` out
everywhere else, because it fills the relay's 50-message buffer with the scanner's ticks.

| Step | Action | Write down | Pass when |
|---|---|---|---|
| 1 | Print and measure the sheets as above | The printed size in mm and the scale bar's reading, for every print | Each print is within 0.5% of its size (adopted), so that the 100% print is a true 100%: otherwise print it again |
| 2 | Grid. On each phone, hold still for 2 s in each cell. The minimum is 16 cells: the 200 mm wall tag at 1, 2, 3 and 5 m, at 10°, 40° and 60° (12 cells), and the 200 mm floor tag at 1, 2, 3 and 5 m (4). The complete grid adds the 160 mm and 230 mm tags in the same cells (32 more) | Per cell: in how many of the hold's frames the tag was found, the side in pixels, and the spread over the hold of the per-frame position and yaw *(after WP-14b)* | The 200 mm wall tag is found in at least 90% of frames at 3 m, at 10° and 40°, on every phone (the spec names no angle: this reading is adopted, and the 60° cells are recorded, not judged). Below that on any phone: **fail** |
| 3 | Probe. Lay the probe mark P first: F is the floor point under the tag's centre (a plumb line), Q is 3.000 m from F along the foot of the wall, and P is where a tape from F reading 5.000 m crosses a tape from Q reading 5.831 m (the square root of 34), on the tag's side of the wall. Define the frame from the 200 mm wall tag with the build's marker step *(after WP-14b)*, from about 2 m, 40° to the side, sweeping sideways: its origin is F and its +Z the tag's outward normal. Then walk to about 3 m from the tag on the normal, hold the phone looking steeply down about 2 m from P, and tap the middle of P once, as in Procedure 2. Five sessions, closing the tab between them | The probe's `line.px`, `line.pz`, `line.rng` and `line.pitch` in each session (a `line.pitch` above −45 means the phone was not looking steeply down: say so), and the spread of the five (the repeatability) | Each is within 10 cm of P's true place, 0 m across and 5.000 m out along the normal (the spec's 10 cm at a 5 m probe: with five sessions the p95 is the largest). P is laid to within 2 cm sideways and 0.5 cm out with each tape read to 5 mm, and that comes out of the 10 cm. Otherwise **fail** |
| 4 | Time and heat. Run 5 minutes at 10 Hz on the oldest iPhone and the oldest Android, pointed at the tag, then 5 minutes with no tag | The stage times (grey conversion, quad search, refinement, decode, pose) *(after WP-14b)*, and the median and the 95th percentile of their sum for a frame; the battery percentage at the start and the end; the temperature at the start and the end (Android: the `temperature` line of `adb shell dumpsys battery`, in tenths of a degree Celsius; iPhone: none to read, so cool, warm or hot by hand, and whether it warns); whether the HUD stalls | The 95th percentile of the detector's time is at most 100 ms a frame, the budget at 10 Hz (adopted; the 95th percentile because a frame over budget delays the next). Heat and battery: record only |
| 5 | Lag. With the tag in view, sweep the phone past it at about 30° a second and let the build fit the reprojection error against a lag of 0, 1 and 2 frames | The rms error in pixels at each lag, per phone *(after WP-14b)* | One lag is lowest on all three phones and its rms is at most 0.8 px (the adopted reprojection gate). The lag that wins becomes the build's default, whatever the default is today |
| 6 | Focal factor and projection. Put the phone's camera exactly 2.000 m from the tag's centre by tape, facing the tag squarely | Detected range ÷ 2.000 per phone, and `P[0]`, `P[5]`, `P[8]`, `P[9]`, `cols`, `rows`, the canvas size and `contain` or `cover` *(after WP-14b)*; and, in the build today, `fit`, `canvas`, `frame`, `fovYDeg`, `projectionAspect` and `crop` of the `[8thwall][aspect]` line | The factor is between 0.98 and 1.02 (adopted: 2% of focal length is 6 cm at 3 m): outside it, write the factor down per model, because a per-model correction is needed. `P[8]` and `P[9]` read 0 and `P[5]` ÷ `P[0]` is within 0.5% of `cols` ÷ `rows` (the check the tag step makes before it runs, adopted): a model that fails it is one the tag step has to refuse |
| 7 | Unit from the print. On each phone in responsive scale (arm R0 of Procedure 3), with the 100% print, move the phone at least 0.3 m while it looks at the tag, then read the session units per metre the build gets from the print *(after WP-14b)* | That figure, and Procedure 3's for the same phone and start height (`line.sepM` ÷ 3.000) | Within 3% of each other (the spec's 3%, adopted). Outside it the print scale, the focal length or the tracking is wrong: the print sets no unit until that is explained |
| 8 | Prints at 95% and 105%. Print the sheet at 95% and at 105%, measure each, and give the build the sheet's nominal size and not the measured one (the point is what an unmeasured print does). Repeat step 6's 2.000 m tape check with each print. Where a runtime's unit is the metre (an 8th Wall phone in absolute scale, once Procedure 3's arm A has passed on it), also run the tag step with the 100% print and then each of these | Detected range ÷ 2.000 for each print, and the scale ratio the build reports for each print *(after WP-14b)* | The 100% print reads within 2% and the other two read about 1.05 (95%) and 0.95 (105%): the detector cannot see a print-scale error. On the metric runtime both mis-scaled prints are flagged as off by more than 3% and the 100% print is not. This ratio, the scale bar and the rule are the only checks |
| 9 | Negative images. Walk 10 minutes through three rooms, as in step 4 of Procedure 6, with no tag anywhere in view and the phone armed with `?debug=remote,probe,tagneg`. Repeat until the counters reach the total | Candidate quads, decode attempts and detections *(after WP-14b)*. No image leaves the phone | Zero detections in at least 3,000,000 candidate quads: with none in *n* the rate is under 3 ÷ *n* at 95%, so 3 million is the least that shows under 1e-6. One detection moves the total to 4.75 million and two to 6.3 million (the 95% limit for that count). Three million is about 100,000 negative images: 17 walks of ten minutes at 10 Hz, 6,000 frames each, and any other walk in this file can be run armed with `tagneg` and counts. A third detection **fails** the in-house family whatever the total: that is a cap this page adopts so that the run ends, not part of the 95% arithmetic (three detections would need 7.8 million quads to show under 1e-6, about 44 walks) |

A fail in step 2, 3 or 9 switches the shipping detector to the AprilTag build. Steps 4 to 6 set
constants (the frame rate, the lag, the focal factor per model) and do not pass or fail the
detector. Steps 7 and 8 say whether a wrong unit or a mis-scaled print is caught. Decide the tag
family here too, before any sheet is issued. Not here: the checks of a WebXR camera image (the size of
`view.camera` against the projection, whether a second camera stream coexists with ARCore) and of
`BarcodeDetector` in a Capacitor WebView belong with the two things the spec leaves out of the first
version, WebXR camera access and in-app QR decoding.

#### Results — Procedure 8

Copy one row per cell for step 2 and one row per phone for the other steps. For a wall cell, Range
is *r* and Angle is *a* off the tag's normal. For a floor cell, Range is the distance *d* along the
floor and Angle is the one the 1.4 m height gives, atan(*d* ÷ 1.4): 36° at 1 m, 55° at 2 m, 65° at
3 m and 74° at 5 m.

| Phone | Runtime | Step | Tag (mm) | Range (m) | Angle (°) | Wall or floor | What you saw | Pass or fail |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

### Devices

At minimum one of each provider path — they share no tracking code:

- **8th Wall SLAM**: `iphone182` or `liam-ipad-pro` (Safari)
- **WebXR**: `galaxy-tab-s9-ultra` or `liams-tab-s8-ultra` (Chrome, needs ARCore)

## Remote-controlled testing (android-remote-control-mcp)

For Android devices, [android-remote-control-mcp](https://github.com/danielealbano/android-remote-control-mcp)
lets Claude Code drive Checklist B's UI steps directly — tapping **Start AR**,
granting the camera permission, hitting capture — without a human holding the
device for every run. It can't replace the physical "sweep the camera around
the room" steps, so use it for the repeatable UI/permission-flow parts and for
unattended `/smoke.html` checks, not as a full substitute for a walked run.

### One-time device setup

1. Install the `gms` build (or `foss`, on devices without Google Play
   services): `adb install -r android-remote-control-mcp-<version>-gms-release.apk`
2. **Settings → Apps → Android Remote Control MCP → ⋮ → Allow restricted
   settings**, confirm with PIN/biometric (Android 13+ blocks sideloaded apps
   from requesting Accessibility by default), then enable the **Accessibility
   Service** toggle. Nothing works without this — it's how the app reads the
   screen and injects taps.
3. In **Settings → Security**, confirm the **HTTPS** toggle is off (plain HTTP
   is the documented default, but the `edge` channel has been observed with
   it on). If it's on, Windows Node clients — including Claude Code's own
   runtime — complete the TLS handshake against the app's auto-generated
   self-signed cert and then get cleanly rejected (`self-signed certificate`)
   or reset, and the app documents no way for a client to trust or pin that
   cert. Plain HTTP avoids the whole problem.
4. Open the app's **Server** tab → **Start**. Note the bearer token under
   **Settings → Access**.

### The test fleet

Every device runs its own server with its own bearer token, reachable on the
tailnet at port 8080. There is no shared token — one per device, supplied via
the matching environment variable below.

| Tailnet host | Tailscale IP | Device | `.mcp.json` server | Token env var |
|---|---|---|---|---|
| `liams-tab-s8-ultra` | 100.86.76.113 | Galaxy Tab S8 Ultra (SM-X900) | `android-tab-s8-ultra` | `ANDROID_MCP_TOKEN_TAB_S8_ULTRA` |
| `galaxy-tab-s9-ultra` | 100.102.92.116 | Galaxy Tab S9 Ultra (SM-X910) | `android-tab-s9-ultra` | `ANDROID_MCP_TOKEN_TAB_S9_ULTRA` |
| `beam-pro-1` | 100.127.78.6 | XREAL X4000 | `android-beam-pro-1` | `ANDROID_MCP_TOKEN_BEAM_PRO_1` |
| `beam-pro` | 100.97.126.117 | XREAL X4200 | `android-beam-pro` | `ANDROID_MCP_TOKEN_BEAM_PRO` |

### Connecting Claude Code (tailnet — preferred)

`.mcp.json` points each server at `http://<host>.capybara-ulmer.ts.net:8080/mcp`,
with every token left as a `${...}` placeholder. Claude Code expands those
placeholders from its process environment. On Windows, persist the four values
for your user account:

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_TAB_S8_ULTRA", "<tab-s8 token>", "User")
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_TAB_S9_ULTRA", "<tab-s9 token>", "User")
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_BEAM_PRO_1", "<beam-pro-1 token>", "User")
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_BEAM_PRO", "<beam-pro token>", "User")
```

Close and reopen the terminal after setting them. A `.mcp.local.json` file is
git-ignored (safe to keep tokens in), but Claude Code does not automatically
merge it with `.mcp.json` — the env-var placeholders above are the mechanism
that actually works today.

### The scripted path

`scripts/android-mcp.sh` does all of the below, and diagnoses it when it does
not work:

```bash
scripts/android-mcp.sh check     # probe every device: token, tailnet, MCP handshake
scripts/android-mcp.sh persist   # write the tokens into your shell profile, idempotently
scripts/android-mcp.sh launch    # or: exec `claude` with them loaded, without persisting
```

It reads tokens from the environment first, falling back to a gitignored `.env`
(the variable names are in `.env.example`). Two behaviours worth knowing:

- **`check` prefers the environment; `persist`/`launch`/`env` prefer `.env`.**
  `check` reports what Claude Code is *actually* using, while the other three
  build a new environment from the file you just edited. Preferring the shell
  there would re-persist a stale token over the corrected one.
- **`check` flags the case where they disagree.** A rotated token written to
  `.env` while the old value is still exported looks fine from either source
  alone — the shell silently wins, and the device keeps returning 401. That
  comparison is the only thing that reveals it.

`check` reads a 503 as a pass: the app caps concurrent MCP sessions, so
"Too many active sessions" means the token was accepted and the server is
healthy — usually your own Claude Code session already holding the connection.

For a temporary Bash session, export only the devices you need:

```bash
export ANDROID_MCP_TOKEN_TAB_S8_ULTRA=<token from that device's Settings → Access>
export ANDROID_MCP_TOKEN_TAB_S9_ULTRA=<token from that device's Settings → Access>
export ANDROID_MCP_TOKEN_BEAM_PRO_1=<token from that device's Settings → Access>
export ANDROID_MCP_TOKEN_BEAM_PRO=<token from that device's Settings → Access>
```

Export only the devices you actually need — a server whose variable is unset
simply fails to authenticate, it does not break the others.

Either way the tokens are read when the session starts, so a value supplied
mid-session does not take effect until Claude Code is restarted. **Never
hardcode them into `.mcp.json` itself** — that file is tracked, and a token
granting tap and screen-read control of a device is permanent once committed.

With the environment variables set, start Claude Code from the repository root
and accept the workspace trust prompt. Approve the project MCP servers when
Claude Code asks; otherwise `claude mcp list` can show them as pending or omit
them from the active session even though the JSON is valid. If the choices are
stale, run `claude mcp reset-project-choices`, restart Claude Code in this
repository, and approve the servers again. `claude_desktop_config.json` is for
Claude Desktop and does not replace this project-level Claude Code setup.

**The server must be bound to `0.0.0.0`, not `127.0.0.1`, or the tailnet address
refuses connections.** Set this in **Settings → General**. This is a deliberate
exposure tradeoff: on the tailnet, any peer can drive the device with just the
bearer token. See "Security notes" below.

### Connecting over adb (fallback, USB only)

Useful when a device isn't on the tailnet, or when you don't want to widen its
bind address. Forward a free host port to the device's 8080 — one host port per
device, since several devices cannot share one:

```bash
adb -s <serial> forward tcp:8081 tcp:8080
```

The tracked `.mcp.json` points that server at its tailnet hostname, so the
forward alone is not enough — override the URL for this machine in
`.mcp.local.json`, which takes precedence:

```bash
cat > .mcp.local.json <<'JSON'
{
  "mcpServers": {
    "android-tab-s9-ultra": {
      "type": "http",
      "url": "http://127.0.0.1:8081/mcp",
      "headers": { "Authorization": "Bearer <tab-s9 token>" }
    }
  }
}
JSON
```

Restart Claude Code afterward — MCP config is read at session start. Delete the
override to go back to the tailnet path.

Use the literal `127.0.0.1`, not `localhost`, and choose the host port
deliberately rather than defaulting to 8080. On a machine that also runs Docker
Desktop and/or WSL, `:8080` is frequently already taken on
`0.0.0.0`/`[::]`/`[::1]` — verified here, Docker Desktop held `0.0.0.0:8080`
and `[::]:8080` while wslrelay held `[::1]:8080`, which is why the example
forwards to 8081 instead. An IPv6-first resolver will happily route `localhost`
to that unrelated service instead of the adb forward, which only binds
`127.0.0.1` (IPv4). If a forward seems to hang or reset, run
`netstat -ano | findstr :<host-port>` and check which PID actually owns
`127.0.0.1:<host-port>` before assuming the phone is the problem.

### Diagnosing "connection refused"

Work down this list — the layers fail differently and the symptoms overlap.

**1. Is the host reachable at all?** `tailscale ping <host>`.

- *A pong, but the port still refuses* — the network is fine and the app is the
  problem. Skip to step 3.
- *No reply at all* — the device is not on the tailnet, and no amount of
  app-side debugging will help. `tailscale status` showing `offline, last seen
  <N>h ago` together with `tx <n> rx 0` means you are transmitting into a void.
  **A device can be awake, on Wi-Fi, and serving MCP perfectly while being
  completely absent from the tailnet** — observed on the tab-s8-ultra, which
  answered 200 with all 57 tools on its LAN address while its tailnet name was
  unreachable. Go to step 2.

**2. Is Tailscale actually running on the device?** Installed is not the same as
connected — the Android client is an app that has to be launched, and it does
not reliably survive the device sleeping. With the device on USB:

```bash
adb -s <serial> shell "pidof com.tailscale.ipn || echo NOT RUNNING"
```

```bash
adb -s <serial> shell "ip -4 addr show | grep -A1 tun"
```

No pid, or no `100.x` address on a `tun` interface, means the VPN is down. Open
the Tailscale app on the device and turn it on — that needs Android's
VPN-consent dialog and possibly a re-login, so it cannot be driven over adb.

To prove the app itself is healthy while the tunnel is down, probe the device's
LAN address directly. A 200 there isolates the fault to Tailscale:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<lan-ip>:8080/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cc","version":"1"}}}'
```

**3. Is the server actually listening?** Check the socket *state*, not just the
address:

```bash
adb -s <serial> shell "cat /proc/net/tcp6 | awk '\$2 ~ /:1F90/ {print \$2, \$4}'"
```

`1F90` is port 8080 hex; state `0A` is LISTEN. **Anything else is not a
listener** — `06` is TIME_WAIT, and stale TIME_WAIT rows from earlier
connections look identical in the address column. Grepping the address alone
will tell you the server is bound to loopback when in fact it is not running at
all. Address `00000000...0000` is the `0.0.0.0` wildcard;
`0000...FFFF00000100007F` is `::ffff:127.0.0.1`.

**4. Is it bound to loopback?** Then only on-device clients reach it. Change the
bind in **Settings → General**.

### Tunnels (Cloudflare / ngrok) — read before trusting one

The app has a **Settings → Tunnel** page with an **Enable Remote Access**
toggle; `cloudflared` is bundled inside the app itself (`libcloudflared.so`,
spawned as a child of the app process), not installed separately. Three
non-obvious behaviors, all observed:

- **A dead tunnel URL does not mean the tunnel is off.** In Cloudflare "Free /
  Random temporary URL" mode, every reconnect mints a *brand-new* hostname. An
  old URL returning 530/1033 while a fresh one silently serves traffic is the
  normal state, not an anomaly. Check the app's **Public URL** row or the
  `libcloudflared.so` process — never a URL you saved earlier.
- **The Enable Remote Access toggle is inert while the server is running.** It
  reports `clickable` but not `enabled`, so both accessibility clicks and
  coordinate taps are silently no-ops. Stop the MCP server first, flip the
  toggle, then start the server again. Confirm with the node attribute, not the
  pixels — the switch renders almost identically on and off in dark mode:

  ```bash
  adb -s <serial> shell "uiautomator dump /sdcard/ui.xml >/dev/null; cat /sdcard/ui.xml" | tr '<' '
' | grep 'checkable="true"'
  ```

- **Stopping the MCP server kills the tunnel** (cloudflared is its child), but
  starting the server respawns it unless the toggle was turned off in between.
  `adb shell kill <cloudflared-pid>` fails with "Operation not permitted" — it
  runs as the app's UID, not shell's.

A `trycloudflare` quick tunnel is reachable by **anyone on the internet** with
the URL; the bearer token is the only control. Prefer the tailnet.

### Driving a device / taking screenshots

- `android_open_uri` opens a URL via `ACTION_VIEW`. It routes to the installed
  app when one claims the domain (reddit.com opens the Reddit app, not Chrome).
- `android_get_screen_state` with `include_screenshot=true` returns a JPEG with
  the accessibility node tree **drawn over it** in red. It is a debug aid, not a
  clean screenshot. For a real one use `adb exec-out screencap -p > out.png`,
  which needs USB.
- **An all-black screencap almost always means the screen is off, not a capture
  failure.** Check `dumpsys display | grep committedState` and wake with
  `input keyevent KEYCODE_WAKEUP`. Some devices (the XREAL X4000) re-sleep
  within seconds, so chain wake, swipe, and capture in one `adb shell`
  invocation rather than as separate commands.
- A device with a set lock screen (`locksettings get-disabled` → `false`,
  `dumpsys trust` → `deviceLocked=1`) cannot be driven past the keyguard
  without its PIN. Leave those devices unlocked before an unattended run.

### Security notes (from upstream)

- Upstream default bind is `127.0.0.1`. Widening it to `0.0.0.0` for tailnet
  access means any tailnet peer can read the screen and inject taps, with only
  the bearer token in the way. Do it deliberately, not by habit.
- The server is fully open to anyone who can reach it if both bearer-token and
  OAuth auth are disabled — don't disable both.
- Rotate a token that has been pasted into chat, a ticket, or a log.
- Stop the server (and any tunnel) when you're done testing.

## Triage

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Certificate warning on device | Cert missing/expired or hostname mismatch | `tailscale cert <host>` in the repo root, then `systemctl --user restart cscan-web` |
| Page loads over `http://` or "HTTPS required" banner | Opened via IP or wrong scheme | Use the `https://<host>.ts.net:5173` URL (npm run qr) |
| "Server unreachable — is Tailscale connected?" HUD | VPN off on the phone, or cscan-server down | Tailscale app → VPN on; `systemctl --user status cscan-server` |
| "Model warming up — retry in a few seconds" | First inference after idle loads weights into VRAM | Retry; check `journalctl -u ollama -f` |
| Detections very slow (>30 s) or 504 | Model too large / running on CPU | `ollama ps` should show 100% GPU; install/re-pick via `npm run setup:models` + `npm run bench:models`, set `OLLAMA_MODEL` in `~/.config/cscan/env` |
| Camera prompt never appears | Not a secure context, or Start not triggered by a user tap | Check /smoke.html Secure Context row; don't script the tap |
| HMR/live-reload dead on phone (dev mode) | `TAILSCALE_HOSTNAME` mismatch pins HMR to the wrong host | Export the right hostname before `npm start` (auto-detect usually handles it) |
| 🥽 toggle missing on iPhone Safari | Correct behavior — Safari has no WebXR `immersive-ar` | Use HelloXR (App Store id6757726359) for the WebXR path on iOS |
| No console output in `logs:watch` | Page loaded without `?debug=remote` | Reload with the query param (or set `localStorage['remote-log']='1'`) |
