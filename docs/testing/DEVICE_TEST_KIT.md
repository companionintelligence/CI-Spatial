# Device test kit

Start here before any phone, tablet, headset or Mac test. Run the preflight first, from the box that serves the app.

```bash
npm run device:preflight
```

It checks the Tailscale host, the HTTPS origin, the Vite proxy into the API, the CORS answer Vite gives the two phone shells' origins (`capacitor://localhost` and `https://localhost`), the mobile shell bundle's host, the Android APK, the iOS manifest and permission keys, and the iOS Swift syntax. It exits non-zero on a real failure and prints the phone URLs. It names the host from `TAILSCALE_HOSTNAME`, then `VITE_HOSTNAME`, then the Tailscale CLI, the way the server and `npm run qr` do.

Two things it does not check:

- The CORS lines show the answer Vite gives to a preflight (`vite.config.ts` answers it before the proxy), not the Deno server's own rule, and the desktop app's three Tauri origins are not among them.
- It opens no WebSocket, so a server that refuses the page's origin on `/events` or `/rtc-signal` (403) shows only on a device, as an editor or scanner with no live updates.

The server admits `https://<TAILSCALE_HOSTNAME>` on any port, `ALLOWED_ORIGIN_PREFIX`, `APP_BASE_URL` and the native apps' own origins. It admits localhost and LAN pages only when it runs with `ALLOW_DEV_ORIGINS=1` (`server/origin.ts`), which a phone test never needs: open the page on the tailnet host, and check that the `[server] Hostname:` line at server startup names that host.

Each feature is listed below with what was checked on the dev box and what only a device run can show.

## Surfaces

| Surface | Entry point | Checked on the dev box | You run on a device |
| --- | --- | --- | --- |
| iPhone Safari, web scanner | `scanner.html?world=default` | Page answers 200 over Tailscale HTTPS; API through the proxy; Vite's CORS answer for the two phone shells' origins. Pins now map through the camera canvas (unit-tested) | 8th Wall tracking, camera, motion permission, pin alignment at the top and bottom of the frame, capture, keyframe streaming |
| iOS Capacitor shell | `mobile/ios` | `cap sync ios` works (the `CapApp-SPM` manifest is tracked). Permission keys present. `ScanARPlugin.swift` is in the Xcode target and `ScanBridgeViewController` registers it. Not observed on this tree: that the Swift files parse (it was observed before the branches were merged, on a tree that registered a different plugin) | Build and run in Xcode on a Mac. In the Web Inspector read `Capacitor.Plugins.ScanAR.capabilities()`: `supported` should be true. The page then chooses the native runtime when it loads (its status line reads "ARKit ready" before AR starts, which says only that it was chosen). A native start shows `[native-ar] trackingStatus:` lines in the console and no `the native session did not start` warning; that warning means it fell back to the 8th Wall path. Neither has run on a phone (see "AR in the shells") |
| Android Chrome, WebXR | `webxr.html` | Page answers 200 | An ARCore-backed `immersive-ar` session, tracking and capture |
| Android Capacitor shell | `mobile/android` | `MainActivity` registers `ScanARPlugin`, and ARCore is declared once (`arcoreVersion` in `mobile/android/variables.gradle`). Not observed on this tree: the debug APK build, an install and launch on an Android 16 emulator, and the start screen (all three were observed before the branches were merged, on a tree that registered a different plugin) | Install on an ARCore-capable phone with Google Play Services for AR installed. Read `Capacitor.Plugins.ScanAR.capabilities()` in the WebView console (Chrome's `chrome://inspect`, on the debug build): `supported` is true only when ARCore is installed, and `reason` says why not. The page then chooses the native runtime when it loads (its status line reads "ARCore ready" before AR starts, which says only that it was chosen), or the 8th Wall path when `supported` is false. A native start shows `[native-ar] trackingStatus:` lines in the console and no `the native session did not start` warning; that warning means it fell back to the 8th Wall path (see "AR in the shells") |
| Quest headset, scan | `webxr.html` | Page answers 200 | An `immersive-ar` scan with keyframes |
| Quest headset, edit | `xr-world.html?world=<slug>` | Three Playwright tests on the iwer Quest 3 emulator: enter VR, select, relabel, move, saved as patches; a refused save reverts; no immersive-vr says so | Enter VR on a real Quest. Select, move and relabel a Thing. Reload the desktop catalogue and check the change |
| Desktop catalogue | `viewer.html` (Things tab) | One Playwright test on a mocked world: search, label and scan filters, relabel, clear | Your own multi-scan place: search, filter, relabel and clear across real rooms |
| Whole-Place glTF | queue an `export-world` job (the editor's Publish step, or Export world in the Advanced queue), then `GET /worlds/<slug>/export.glb` | 14 Deno tests. The Khronos glTF validator reports 0 issues on samples and on live exports | Open the file in a glTF viewer and check each scan lands where it was scanned |

The whole-Place file holds every scan's geometry, so `GET /worlds/<slug>/export.glb` follows the same viewer rule as `GET /worlds/<slug>/frames/<scanId>`. With strict world auth on (sign-in on, `WORLD_STRICT_AUTH=1` or `SCAN_REQUIRE_AUTH=1`) it needs a viewer's world token, sent as `?token=` or `Authorization: Bearer`. An install that is open by design serves it without one.

## AR in the shells

- Both shells register one plugin, `ScanAR` (`ScanARPlugin.swift` on iOS, `ScanARPlugin.java` and `ScanARRenderer.java` on Android; ADR 0009). When the page loads the scanner asks it `ScanAR.capabilities()`, and when that reports `supported` the page chooses the native runtime, ARKit on iOS and ARCore on Android (`src/main.ts`, `src/ar/native.ts`), and writes "ARKit ready" or "ARCore ready" to the status line: that says the native runtime was chosen, not that its session started, which happens when AR starts (Walk the room). When it does not (a phone without ARKit, or an Android phone without Google Play Services for AR installed: the plugin asks Google Play for nothing, and `reason` says what is missing) the scanner starts on 8th Wall (`public/xr.js`), and on WebXR if that engine is missing. `?ar=webxr` and `?ar=8thwall` force a web runtime. When a native session was supported and still fails to start, the same canvas goes to 8th Wall, then WebXR, and the console says `[native-ar] the native session did not start; using the web runtime:` and why.
- `ScanAR` is more than a pose. It hands the page camera frames (`captureFrame`) and exact hit tests (`hitTest`), keeps an ARKit world map of a named Place on an iPhone (`saveWorldMap`; the map stays on the phone, ADR 0010), and has one origin anchor on Android (`setOriginAnchor` and `getOriginAnchor`) that the page never calls. None of it has run on a phone (`README.md`, "Not done yet", and `mobile/README.md`, "Not done"), so the first on-device run is the thing to try, and what it shows (which runtime started, which status line, which `[native-ar]` lines) is the result to record.
- Checklist D in `docs/testing/DEVICE_TESTING.md` is the iOS run of the plugin, row by row. Android has no checklist of its own yet: use rows 1 to 3 of it and the console lines.
- The `ArSession` plugin is in the tree and registered by neither shell. `src/ar/native-provider.ts` is its provider, nothing in `src/` imports it (only its tests do), the iOS target does not compile `ArSessionPlugin.swift`, and `ArSessionPlugin.java` compiles into the Android app and is never put on the bridge. Whether both native designs stay is the owner's decision (ADR 0009). So `Capacitor.Plugins.ArSession` is undefined in a shell, and a check that expects it fails by design.
- What the unregistered plugin would do, for the owner's decision. iOS (`ArSessionPlugin.swift`): `isSupported`, `start` and `stop`; `start` runs an ARKit world-tracking session and pushes `pose` and `state` events, with no camera feed, no frames and no hit test. Android (`ArSessionPlugin.java`): `isSupported` (ARCore availability), `start` (asks Google Play to install or update ARCore if needed, then creates and resumes a session) and `stop`; it runs no frame loop, so it sends `state` events and no pose, and no camera frames. This plugin is unregistered, so none of this runs.

## What to run on each device

### Phone, web scanner
1. `npm run device:preflight`. Every line should PASS.
2. `npm run qr -- "/smoke.html?debug=remote"` and scan it with the phone. Every smoke row should PASS before any AR test.
3. Walk one room. Watch a tag pin at the top and bottom of the frame and compare it with the object. Record the offset in pixels.

### iPhone, native shell (needs a Mac and Xcode)
1. `cd mobile && npm run build:web && npx cap sync ios`. To start the app on this box, put `VITE_API_BASE=https://<host>:5173` before `npm run build:web` (see "Building the shells").
2. Open `mobile/ios/App/App.xcodeproj` in Xcode. Set your signing team. Build and run on the phone.
3. Give the app its Scan server unless the build named one. On the first-run screen's Server row, choose Add server and enter `https://<host>:5173`. An address saved on the phone beats the build's, so check that the row names this box.
4. Expected: the start screen renders and the Server row names this box. Tap Walk the room, pick or create a Place, and confirm. The camera and motion prompts should appear and the scanner should start on the ARKit session: `[native-ar] trackingStatus:` lines in the Web Inspector and no `the native session did not start` warning (the "ARKit ready" status line before AR starts says only that the native runtime was chosen). That has not been run on a phone yet (see "AR in the shells"), so write down exactly what happens, with the `[native-ar]` lines.

### Android, native shell
1. `cd mobile && npm run build:web && npx cap sync android && (cd android && ./gradlew assembleDebug)`. To start the app on this box, put `VITE_API_BASE=https://<host>:5173` before `npm run build:web` (see "Building the shells").
2. Install `mobile/android/app/build/outputs/apk/debug/app-debug.apk` on an ARCore-capable phone.
3. Give the app its Scan server as for iOS, unless the build named one.
4. Expected: the start screen renders and the Server row names this box. Tap Walk the room, pick or create a Place, and confirm. The camera, motion and location prompts should appear and the scanner should start on the ARCore session when `Capacitor.Plugins.ScanAR.capabilities()` reports `supported` (`[native-ar] trackingStatus:` lines and no `the native session did not start` warning), and on 8th Wall (status line "8th Wall ready") when it does not. Write down what `capabilities()` returns (`supported` and `reason`) and what happens.

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

`VITE_API_BASE` is optional. A build that sets it starts the app on that Scan server, and the build refuses a value that is not an `https` origin with a root path (`mobile/scripts/check-api-base.mjs`). A build that leaves it unset asks for the server on first run, which is how release builds are made. Either way, an address saved in the app overrides the build's (`src/shared/api-base.ts`), so a phone that was used against another server keeps pointing there until the Server row is changed. For a test against this box, use the Vite origin, which proxies the API.

```bash
cd mobile
VITE_API_BASE=https://<host>:5173 npm run build:web   # or without the variable, and set the server in the app
npx cap sync ios        # then open ios/App/App.xcodeproj on a Mac
npx cap sync android && (cd android && ./gradlew assembleDebug)
```

The preflight's "shell bundle host" line looks for this box's address inside `mobile/www`. A bundle built without `VITE_API_BASE` holds none, so the line says it was built for another host. That WARN is expected for such a bundle, which asks for its server on first run.

`cap sync ios` takes the Swift Package Manager path only when `ios/App/CapApp-SPM` exists. That folder holds the
generated `Package.swift`, and it is tracked so a fresh clone can sync. Without it, a fresh clone fails at `pod install`.

## Android emulator

The emulator is the quickest way to see the Android shell run. It has no ARCore and no
camera pose, so it proves the shell boots, not that AR works.

```bash
sdkmanager "emulator" "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
  "system-images;android-36;google_apis;x86_64"
avdmanager create avd -n ci-android36 -k "system-images;android-36;google_apis;x86_64" -d pixel_6
emulator -avd ci-android36 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.companionintelligence.scan -c android.intent.category.LAUNCHER 1
```

- The device name is whatever `avdmanager list device` shows. On the SDK that recipe was run with, it was `pixel_6`, not `pixel_7`.
- The emulator needs read and write access to `/dev/kvm`.
- The location prompt appears on first launch. Accept it, then the app continues.

## Recording a run

- Record the device, OS and browser versions, the room, the lighting, and the URL.
- `docs/testing/DEVICE_TESTING.md` has the per-device checklists. `docs/testing/HOUSE_VALIDATION.md` is the whole-house protocol.
- `docs/audits/2026-11-13-goal-readiness.md` is the gap analysis this kit was built from. It is a dated record from before the work was merged, so gaps it lists as open (the whole-Place export, headset editing, the catalogue) have since been built.

## Not verified by anyone yet

- Real-device AR on a phone or a headset: the native `ScanAR` session on both platforms (ARKit, and ARCore), and the 8th Wall path that takes over in the shells when it cannot start. The unregistered `ArSession` plugin has not run either.
- An Xcode build of the iOS shell for this tree, and a run of it on a phone (no Mac here). The mobile-build workflow's simulator job compiled the Swift on main before the branches were merged (`mobile/README.md`).
- AMD ROCm, Apple MPS and Intel XPU hardware runs. Only fake-torch tests cover them; use the GPU report on each machine.
- The catalogue on real multi-scan places. The Playwright test uses mocked data.
- Consumers of the whole-Place file other than the Khronos validator.

## Decisions still open

- **Record that the whole-Place export is built.** The `export-world` job writes `<slug>.world.glb`, and `GET /worlds/<slug>/export.glb` serves it. Four factory design docs still list a merged per-place GLB as an owner decision deferred to a later wave: `docs/factory/07-scan-identity/0003-node-level-glb-provenance.md` and `0004-pipeline-preserves-provenance.md`, and `docs/factory/08-places-and-things/README.md` and `0005-world-as-derived-view.md`. No ADR records that it was built, so nothing in the repository records the decision to build it.
- **Uncalibrated scans in cross-scan matching.** GPS-placed scans are matched in the Place frame as well. Choose whether they should be excluded until calibrated.
