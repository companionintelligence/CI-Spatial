# Device test kit

Start here before any phone, tablet or headset test. Run the preflight first. It checks
what a device test depends on without anyone noticing: the Tailscale host, the HTTPS
origin, the Vite proxy into the API, CORS for both native shells, the shell bundles, and
the iOS project.

```bash
npm run device:preflight
```

It exits non-zero on a real failure, and prints the URLs to open on each device.

## Surfaces and what each one needs

| Surface | Entry point | Verified on the dev box (2026-11-13) | Needs a real device |
| --- | --- | --- | --- |
| iPhone Safari, web scanner | `scanner.html?world=default` | Page answers 200 over Tailscale HTTPS. API through the proxy answers. Both shell origins pass CORS | 8th Wall SLAM tracking, camera, motion permission, capture and keyframe streaming |
| iOS Capacitor shell | `mobile/ios` | `cap sync ios` works (after the `CapApp-SPM` fix below). `Info.plist` has camera, location and motion descriptions. Swift sources parse | Xcode build, signing, install, camera and motion inside WKWebView, 8th Wall inside the shell |
| Android Chrome, WebXR | `webxr.html` | Page answers 200 | An ARCore-backed `immersive-ar` session, tracking and capture |
| Android Capacitor shell | `mobile/android` | Debug APK builds (Gradle 8.14.3, JDK 21, compileSdk 36). Installs and launches on an Android 16 emulator. Onboarding and the start screen render | Real camera, sensors and AR. The emulator has no ARCore and no camera pose |
| Quest headset (WebXR) | `webxr.html` | Page answers 200 | An `immersive-ar` scan. Editing in XR is not built yet (see the gaps below) |
| Desktop editor | `editor?project=default` | Page answers 200 | Catalogue checks against real scans |

The preflight prints the phone URLs for the web surfaces.

## Android emulator (verified on this box)

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

- The device name is whatever `avdmanager list device` shows. On this SDK it is `pixel_6`,
  not `pixel_7`.
- The emulator needs read and write access to `/dev/kvm`.
- The location prompt appears on first launch. Accept it, then the app continues.

## Building the shells

Both shells need an `https` origin with a root path for the Scan server. The build refuses
anything else (`mobile/scripts/check-api-base.mjs`). Use the Vite origin, which proxies the API.

```bash
cd mobile
VITE_API_BASE=https://<your-host>.ts.net:5173 npm run build:web
npx cap sync ios        # on a Mac, then open ios/App/App.xcodeproj in Xcode
npx cap sync android && (cd android && ./gradlew assembleDebug)
```

`cap sync ios` takes the Swift Package Manager path only when `ios/App/CapApp-SPM`
exists. That folder holds the generated `Package.swift`, and it is tracked so a fresh
clone can sync. Before this fix, a fresh clone failed at `pod install`.

## Recording a run

- Open `smoke.html?debug=remote` first. The rows must pass before any AR test.
- Record the device, OS and browser versions, the room, the lighting, and the URL.
- `docs/testing/DEVICE_TESTING.md` has the checklists for each device.
- `docs/testing/HOUSE_VALIDATION.md` is the whole-house protocol.

## Gaps to know before a whole-house test

The full gap analysis, with the build waves and the decisions still needed from you, is in
`docs/audits/2026-11-13-goal-readiness.md`.

- Headset editing is not built. The WebXR path only requests `immersive-ar` for scanning.
  There is no `immersive-vr` view, and no controller select, move or relabel of a tag.
- A cross-scan tag catalogue is not verified yet. The editor shows the detections of a
  world, and filters them by label. A list of every tag across the rooms of a place is
  still to be confirmed.
- iOS has no native AR provider. The shell is a WebView, so the AR path is 8th Wall in
  WKWebView, which has not been tested on a device.
- The seeded test-home GLBs in `scans/` predate the current exporter. They lack the
  `class` and `structuralCategory` fields that newer exports write. They still validate,
  and their tags are present.
