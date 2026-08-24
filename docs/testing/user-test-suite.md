# CI-Spatial User Test Suite

Last updated: 2026-08-20

## Live Tablet Target

The Galaxy Tab S9 Ultra MCP is reachable through the local `.mcp.local.json` config. Do not commit that file or any bearer token.

Confirmed live app over Tailscale:

- Scanner / uploader: `https://everxr-01.capybara-ulmer.ts.net:5173/?project=default`
- Mock scanner for repeatable tablet smoke: `https://everxr-01.capybara-ulmer.ts.net:5173/?mock=xr8&onboarding=0&project=default`
- Spatial Editor: `https://everxr-01.capybara-ulmer.ts.net:5173/editor?project=default`
- Health: `https://everxr-01.capybara-ulmer.ts.net:5173/health`

The mock URL is only for deterministic UI/regression coverage. It is never valid
evidence for a real-camera test. Live camera evidence must use the clean scanner URL
without `mock` or `onboarding=0` query parameters and must show the physical room.

## Real-Camera Device Protocol

Use this protocol for every Android MCP device. A run is invalid if either image
deliverable shows a flat colour, browser chrome, a permission dialog, or a mock
colour-blob scene.

1. Record the device name, Android/Chrome versions if visible, Tailscale app URL,
   room/location, lighting, and the device location shown by the app.
2. Close the existing Chrome tab for CI-Spatial. If the device is in a stale or
   blank Chrome state, close Chrome itself, reopen it, and navigate to the clean
   scanner URL: `https://everxr-01.capybara-ulmer.ts.net:5173/`.
3. Do not use `?mock=xr8`, `?mock=webxr`, or `?onboarding=0`. Those routes can render
   simulated camera pixels or bypass the permission flow.
4. Start a new session and grant camera and motion permissions. Resolve every OS
   permission prompt before continuing. If permission is denied, stop and repeat
   step 2 rather than treating the HUD as a working camera.
5. Tap `Start AR`, then wait for the status to become `Tracking — tap to capture`.
   `Starting AR…`, `Move camera to initialise tracking…`, `Tracking lost`, and a
   permission banner are not capture-ready states.
6. Verify the feed is real before pressing Capture: point at a high-contrast real
   object, move the device slowly, and confirm that the camera area contains
   recognisable room features that change with movement. A uniform dark, white,
   blue, or otherwise solid screen is a failed precondition. Save a screenshot of
   this valid live-camera state as the first deliverable.
7. If the feed is solid or blank, do not capture. Close the Chrome tab/app and
   retry from step 2. If it remains broken, open the desktop viewer at
   `/editor`, wait for it to load, then navigate back to the scanner and
   repeat steps 4-6. This desktop-to-AR reset is a recovery action, not a pass.
8. Press Capture exactly once after the live-feed check. Wait for the status to
   report `<n> objects detected` or an explicit `0 objects detected`. A timeout,
   uniform-frame warning, or server error invalidates the attempt and requires a
   retry from step 2.
9. After tags render, take a second screenshot. The camera background must still
   show the real room and the generated tags/object count must be visible. If the
   post-tag screenshot is solid or contains no generated result, report the run as
   failed even if the server returned HTTP 200.
10. Copy both screenshots into `public/real-camera-artifacts/` using stable device
    names, and report their raw Tailscale URLs plus the device location.

### Failure diagnosis to record

- `Camera frame is uniform`: the browser/provider returned a decodable placeholder
  instead of useful camera pixels. This is a camera startup, permission, stale-tab,
  or WebView/canvas lifecycle problem, not evidence that the vision model failed.
- `Move camera…` forever: inspect camera permission and provider startup first; pose
  readiness alone does not prove that camera pixels are available.
- A valid room image with `0 objects detected`: this is an inference/detection result
  and should be distinguished from a blank/solid frame.
- MCP HTTP 503: the device controller is unavailable; do not classify it as an app
  camera failure until the device MCP is reachable again.

The app now rejects nearly uniform captured frames before inference and gives the
Chrome-reopen recovery message. This is an additional guard, not a replacement for
the visual pre-capture check above.

## Fast Paths

Use three layers so the full suite stays efficient:

1. Tablet MCP smoke, 3-5 minutes: proves the actual tablet can reach the Tailscale launch, load Chrome securely, and exercise the UI. It may use the mock route, but it is not a real-camera pass.
2. Mock browser regression, 8-15 minutes: uses Playwright with the XR8/WebXR mocks to cover the everyday product flow without requiring physical device movement.
3. API and processing regression, 10-25 minutes: exercises ingestion, generated home scans, mock CV, world jobs, splat/LingBot layers, auth, persistence, and server edge cases.

## Commands

Run the tablet smoke:

```bash
npm run test:tablet-user
```

Useful overrides:

```bash
TABLET_TEST_URL=https://everxr-01.capybara-ulmer.ts.net:5173 npm run test:tablet-user
TABLET_KEEP_GOING=1 npm run test:tablet-user
TABLET_MCP_URL=http://galaxy-tab-s9-ultra.capybara-ulmer.ts.net:8080/mcp TABLET_MCP_BEARER=... npm run test:tablet-user
```

Run the browser-level product flow:

```bash
npm run test:mock
npx playwright test --project=chromium-mock mock-ui-mobile mock-xr8-scan mock-webxr-emulated mock-session-reload mock-offline-queue mock-splat-toolbox mock-editor-homes
```

Run the server/processing checks:

```bash
npm run test:api
npm run eval:cv
npm run test:splat:unit
npm run test:auth:unit
```

## 10-Minute User Smoke

| Area | Test | Pass signal |
|---|---|---|
| Tailscale launch | Open scanner on the tablet in Chrome. | Secure Chrome URL is on the `everxr-01` Tailscale host and page title/text says Companion Scan. |
| Start screen | Inspect the first screen. | Scan a Place and Upload Content entry points are present; each opens Place/Area selection before its scanner or uploader. |
| Mock scan | Open `?mock=xr8&onboarding=0`, tap Start AR. | HUD switches to scanning/tracking and point/capture UI is usable. |
| Capture | Tap Capture once. | Latest Scan or object/review feedback appears without a capture-failed status. |
| Review/export | Tap Menu. | Export GLB, Export Summary, Generate Floor Plan, Scene Description, Object Report, Clear session, Start Live Stream, and Server controls are visible. |
| History | Tap Session history. | Scan Memory drawer opens and does not cover navigation permanently. |
| Spatial Editor | Open `/editor?project=default`. | Place-first editor loads with project, scan/layer controls, guided processing, and an empty-Place state when appropriate. |

## Feature Coverage Matrix

| Feature group | Fastest user-level test | Deeper automated coverage |
|---|---|---|
| FTUE and help | Force onboarding with `?mock=xr8&onboarding=1`; step through all 5 cards. | `mock-ui-mobile` onboarding screenshots. |
| Secure remote access | Tablet MCP smoke against the Tailscale URL. | `iphone-usb` Playwright project with `VITE_URL`. |
| Live AR scan HUD | Real-Camera Device Protocol on a physical device. | `mock-xr8-scan`, `mock-ui-mobile` for simulated coverage only. |
| Capture and inference | Capture one mock frame. | `api-cv-mock`, `mock-xr8-scan`, `eval:cv`. |
| Quality verdict and export gate | Capture sparse and ready scans, then export from Menu. | `mock-export-outcome`, `mock-status-line`. |
| Video walkthrough upload | Select a small walkthrough video from the start screen. | `mock-splat-toolbox` upload test, `api-video-ingest`. |
| Keyframe streaming | Toggle Stream keyframes during a mock scan. | `api-video-ingest`, `api-house-readiness`, session sidecar checks. |
| Auto-capture | Toggle Auto-capture during a mock scan and let it run briefly. | `mock-ui-mobile`, capture module unit coverage. |
| Session persistence | Capture, reload, verify count is restored; clear, reload, verify empty. | `mock-session-reload`. |
| Offline queue/PWA | Install/open PWA, capture offline, restore network. | `mock-offline-queue`, service-worker checks in Chromium. |
| Scan history | Open Scan Memory and restore/delete a session. | `mock-ui-mobile`, `mock-session-reload`. |
| Desktop editor | Open the Spatial Editor, select a scan, edit semantic metadata and notes. | `mock-editor-homes`, `editor_pick.test.ts`. |
| Measurements and layers | Toggle layers, wireframe/downsample, measurement tool. | `mock-editor-homes`, viewer unit tests. |
| Live desktop stream | Start Live Stream, connect viewer room, verify peer-ready. | RTC tests in `server.spec.ts`. |
| Guided processing | Run Prepare, Understand, Reconstruct, then Publish for a selected scan. | `api-optimize-scan-worldjob`, `mock-lingbot-map`, `mock-splat-toolbox`, `world_job_pump.test.ts`. |
| Places and locations | Create a Place and Area, assign a scan, verify map position and ENU provenance. | `project.spec.ts`, `api-test-homes`, `api-house-readiness`. |
| Auth/share links | Open view/comment/edit/scanner/owner links and verify capabilities. | `portal_auth.test.ts`, auth Playwright/API coverage. |

## Manual Real-Room Pass

Run this when changing AR provider code, export format, quality gates, or tablet layout:

1. Open the scanner URL without `mock=xr8`.
2. Walk one room for 30-60 seconds with steady motion and varied angles.
3. Capture at least three objects from different positions.
4. Toggle Auto-capture for 20 seconds, then turn it off.
5. Toggle Stream keyframes for 10 seconds, then turn it off.
6. Open Menu and export GLB plus summary.
7. Use View in 3D to inspect the exported scan in the viewer.
8. Edit one object label/tags/notes, move/rotate one scan, and reload the viewer to confirm persistence.
9. Queue one server-processing job and verify it appears in jobs/layers.
10. Clear the session only after export has been verified.

Record device, browser version, app URL, room type, lighting quality, and any permission prompts seen.
