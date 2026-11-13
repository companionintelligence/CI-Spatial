# Device test kit

Start here before any phone, tablet, headset or Mac test. Run the preflight first, from the box that serves the app.

```bash
npm run device:preflight
```

It checks the Tailscale host, the HTTPS origin, the Vite proxy into the API, CORS for both native shells, the shell bundles' host, the Android APK, the iOS manifest and permission keys, and the iOS Swift syntax. It exits non-zero on a real failure and prints the phone URLs.

This kit is on `feat/goal-integration`, which contains every branch built in this round. Each feature is listed below with what was checked on the dev box and what only a device run can show.

## Surfaces

| Surface | Entry point | Checked on the dev box | You run on a device |
| --- | --- | --- | --- |
| iPhone Safari, web scanner | `scanner.html?world=default` | Page answers 200 over Tailscale HTTPS; API through the proxy; CORS for both shells. Pins now map through the camera canvas (unit-tested) | 8th Wall tracking, camera, motion permission, pin alignment at the top and bottom of the frame, capture, keyframe streaming |
| iOS Capacitor shell | `mobile/ios` | `cap sync ios` works (the `CapApp-SPM` manifest is tracked). Permission keys present. Swift files parse. ArSession plugin registered in the project | Build and run in Xcode on a Mac. ARKit session is not implemented; only the plugin contract is |
| Android Chrome, WebXR | `webxr.html` | Page answers 200 | An ARCore-backed `immersive-ar` session, tracking and capture |
| Android Capacitor shell | `mobile/android` | Debug APK builds (ARCore 1.57.0 plugin compiled in). Installs and launches on an Android 16 emulator. The ArSession plugin registers at startup; the start screen renders with no fatal errors | Install on an ARCore-capable phone. Check `ArSession.isSupported` reports true. The camera pipeline is not implemented |
| Quest headset, scan | `webxr.html` | Page answers 200 | An `immersive-ar` scan with keyframes |
| Quest headset, edit | `xr-world.html?world=<slug>` | Three Playwright tests on the iwer Quest 3 emulator: enter VR, select, relabel, move, saved as patches; a refused save reverts; no immersive-vr says so | Enter VR on a real Quest. Select, move and relabel a Thing. Reload the desktop catalogue and check the change |
| Desktop catalogue | `viewer.html` (Things tab) | One Playwright test on a mocked world: search, label and scan filters, relabel, clear | Your own multi-scan place: search, filter, relabel and clear across real rooms |
| Whole-Place glTF | start an `export-world` job, then `GET /worlds/<slug>/export.glb` | 14 Deno tests. The Khronos glTF validator reports 0 issues on samples and on live exports | Open the file in a glTF viewer and check each scan lands where it was scanned |

## What to run on each device

### Phone, web scanner
1. `npm run device:preflight`. Every line should PASS.
2. `npm run qr -- "/smoke.html?debug=remote"` and scan it with the phone. Every smoke row should PASS before any AR test.
3. Walk one room. Watch a tag pin at the top and bottom of the frame and compare it with the object. Record the offset in pixels.

### iPhone, native shell (needs a Mac and Xcode)
1. `cd mobile && VITE_API_BASE=https://<host>:5173 npm run build:web && npx cap sync ios`
2. Open `mobile/ios/App/App.xcodeproj` in Xcode. Set your signing team. Build and run on the phone.
3. Expected: the start screen renders. The camera and motion prompts appear when a scan starts. The ArSession plugin is not yet driving a session, so AR scanning in the shell is not available; use the web scanner for AR.

### Android, native shell
1. `cd mobile && VITE_API_BASE=https://<host>:5173 npm run build:web && npx cap sync android && (cd android && ./gradlew assembleDebug)`
2. Install `mobile/android/app/build/outputs/apk/debug/app-debug.apk` on an ARCore-capable phone.
3. Expected: the start screen renders. Note whether ArSession reports supported in the Capacitor console. The camera pipeline is not implemented, so AR scanning in the shell is not available.

### Quest headset, edit a place
1. Open `https://<host>:5173/xr-world.html?world=<slug>` in the Quest browser and press Enter VR.
2. Point a controller at a marker and pull the trigger: it should highlight. Push the thumbstick up or down: the label should cycle. Hold the grip and move: the marker should follow.
3. Reload the desktop catalogue for that place. The relabel and the move should be there.

### AMD, Apple and Intel machines: which GPU backend the workers get
Run this in a Python with torch installed:

```bash
python3 scripts/gpu_backend_report.py --out gpu-report.json
```

It prints one line (`ok`, `downgraded`, `failed` or `no-torch`) and writes the full report. Send the JSON file back. To ask for one backend, add `--device xpu` or `--device mps`. A request the machine cannot meet is reported as `downgraded`, with the reason.

## Building the shells

Both shells need an `https` origin with a root path for the Scan server. The build refuses anything else (`mobile/scripts/check-api-base.mjs`). Use the Vite origin, which proxies the API.

```bash
cd mobile
VITE_API_BASE=https://<host>:5173 npm run build:web
npx cap sync ios        # then open ios/App/App.xcodeproj on a Mac
npx cap sync android && (cd android && ./gradlew assembleDebug)
```

The Android emulator is the quickest way to see the Android shell run. It has no ARCore camera pose, so it shows that the shell boots, not that AR works. On this box it was run with the `pixel_6` device, because this SDK has no `pixel_7` definition.

## Recording a run

- Record the device, OS and browser versions, the room, the lighting, and the URL.
- `docs/testing/DEVICE_TESTING.md` has the per-device checklists. `docs/testing/HOUSE_VALIDATION.md` is the whole-house protocol.
- The full gap analysis and the build waves are in `docs/audits/2026-11-13-goal-readiness.md`.

## Not verified by anyone yet

- Real-device AR on a phone or a headset. The ARCore and ARKit camera pipelines are not built.
- An Xcode build of the iOS shell (no Mac here).
- AMD ROCm, Apple MPS and Intel XPU hardware runs. Only fake-torch tests cover them; use the GPU report on each machine.
- The catalogue on real multi-scan places. The Playwright test uses mocked data.
- Consumers of the whole-Place file other than the Khronos validator.

## Decisions still open

- **Merged per-place GLB.** The factory design docs say it is deferred; this branch builds it. Confirm before merge.
- **Uncalibrated scans in cross-scan matching.** GPS-placed scans are matched in the Place frame as well. Choose whether they should be excluded until calibrated.
- **Access to `GET /worlds/<slug>/export.glb`.** It uses the same viewer guard as the world itself, like the scan geometry it contains.
