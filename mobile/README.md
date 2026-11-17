# Scan mobile shell

Capacitor 8 iOS and Android shell around the Scan web app in the repo root.

**Scaffold, not for store submission.** Nothing here is signed, uploaded or listed.

## Gates before any store build

- **Measure first.** The mobile wrapping assessment (2026-10-31, section 2, row "Scan") gates this app on measurement on real devices. Apple 4.2.1 rates a bare wrapper around an AR app as high review risk.
- **AR runs natively, and neither native path has run on a device.** WebXR is unavailable in both WebViews, so the shell's AR is the `ScanAR` plugin, which runs ARKit (iOS) and ARCore (Android) itself. See *Native AR capture*. The 8th Wall path (`public/xr.js`) has not been run in the shell either.
- **xr.js licence.** `public/xr.js` is Niantic's proprietary XR ENGINE LICENSE AGREEMENT. Clause 1.2 forbids use in a paid product whose value derives from the software. It is bundled into this shell, and it is also the fallback when a native session cannot start. Do not upload a store binary until the licence has been checked.
- **Server origin.** The shell reaches a Companion Scan server only through `VITE_API_BASE` (see *Server origin* below). Companion Account sign-in runs in the system browser sheet and gives the shell a session token (see *Companion Account sign-in*). It is verified on the iOS simulator against a stand-in Portal only.

## Build

Run these inside this directory. It is a standalone npm project, not part of the root workspace.

```bash
npm install     # once
npm run build   # web build with VITE_DISABLE_PWA=1 into www/, then cap sync
npm run open:ios
npm run open:android
```

`npm run build` writes `www/`, which `cap sync` copies into both native projects. Git ignores everything `cap sync` writes, so run `npm run sync` after a clone.

`ios/App/CapApp-SPM` is the local Swift package the Xcode project depends on. It is committed, taken from the Capacitor 8 SPM template, and `cap sync` updates it. Without it, `cap sync` falls back to CocoaPods and fails on the missing Podfile.

The Android debug build is `./gradlew assembleDebug` from `android/`. It needs JDK 21, and the Android SDK with platform 36 and build-tools 36.0.0 (`ANDROID_HOME` set).

## Icons and launch screens

The app icon and both launch screens are drawn from `scripts/icon-source/scan-reticle.svg` by `npm run gen-icons` at the repo root. The background is the night-space colour `#041620`, the one `index.html`, `public/manifest.json` and `capacitor.config.ts` use. `tests/unit/node/app_icons.test.ts` fails if they drift apart. Rerun the script after changing the reticle or the colour, and don't edit the PNGs by hand.

## Decisions (provisional)

| Item | Value | Why |
|---|---|---|
| Bundle id, Android applicationId | `com.companionintelligence.scan` | Provisional. An Android id is permanent once uploaded. |
| Display name | Scan | |
| Devices | iPhone only (`TARGETED_DEVICE_FAMILY = 1`) | First review is iPhone-only. |
| iOS minimum | 16.4 | The shipped bundle contains class static blocks, which Safari supports from 16.4. |
| Orientation | Portrait only, both platforms | The native camera is fitted to the portrait overlay rect. iOS: `ScanBridgeViewController`. Android: `screenOrientation="portrait"`. |
| AR runtime | Native (ARKit or ARCore) first, then 8th Wall, then WebXR | See *Native AR capture*. The web runtimes are the fallback when a native session cannot start. |
| Transport | HTTPS only | `androidScheme: https`, `server.cleartext: false`, `CapacitorHttp` off, `allowMixedContent: false`. There is no remote `url`. |
| Zoom | On, both platforms | WCAG 1.4.4. Capacitor defaults this to off. |
| PWA | Off in this build | `VITE_DISABLE_PWA` drops the service worker, the manifest and the link to it. See `pwaSwitch()` in `vite.config.ts`. |
| Sentry | None | The web code has no Sentry SDK. |
| Plugins | Capacitor core, App, Browser, and the local `ScanAR` plugin (ARKit on iOS, ARCore on Android) | App and Browser carry Companion Account sign-in from the browser sheet back to the app. `ScanAR` carries the native AR session; see *Native AR capture*. |
| URL scheme | `com.companionintelligence.scan://auth` | Where a shell sign-in ends. Registered in `Info.plist` (`CFBundleURLTypes`) and `AndroidManifest.xml` (an intent filter). Must match `SHELL_RETURN_URL` in `server/portal_auth.ts`. |
| iOS purpose strings | Camera, location when in use, motion | The code asks for these. No microphone: every `getUserMedia` call sets `audio: false`. No photo-library key: the file input uses the system picker. |
| Android permissions | `CAMERA`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Device motion needs no Android permission. ARCore is optional (`com.google.ar.core` meta-data `optional`), so the app installs on phones without it. |

## Server origin

The shell has no server of its own. `VITE_API_BASE` must be the Scan server's https origin, for example `https://scan.example.ts.net`. `npm run build` refuses to run without one (`scripts/check-api-base.mjs`). Every server path in `src/` goes through `apiUrl()` or `wsUrl()` in `src/shared/api-base.ts`. With the variable unset, the hosted web app's URLs are unchanged.

```bash
VITE_API_BASE=https://<server-origin> npm run build
```

The server accepts the shell's origins: `capacitor://localhost` (iOS, allowed in `server/main.ts`) and `https://localhost` (Android, already allowed). In dev, Vite answers CORS preflights before its proxy, so `vite.config.ts` lists the same two origins. Without that, the shell's JSON requests fail in dev. Live events and capture have not run in the shell on a device.

## Companion Account sign-in

The shell's origin never receives the server's session cookie, so the shell signs in another way. "Sign in with Companion Account" opens the server's sign-in in the system browser sheet, with a PKCE challenge the shell made. The server completes the Portal sign-in as it does on the web. Then it redirects to `com.companionintelligence.scan://auth?code=…`, with a one-time code that lasts 60 seconds. The app opens that URL, closes the sheet, and trades the code and its verifier at `POST /authenticate/shell/exchange` for a session token. From then on the shell sends the token as `Authorization: Bearer`, and the first-run status row reads "Signed in." The code is in `src/shared/shell-sign-in.ts`, and the server half is in `server/portal_auth.ts`.

- The token is the server's signed session, valid for seven days. The shell keeps it in the WebView's `localStorage`. Move it to the Keychain (iOS) or the Keystore (Android) before a store build.
- There is no sign-out in the shell, as there is none on the web. A token lasts until it expires. The server checks the allowlist on every call, so removing an account from `PORTAL_OIDC_ALLOWED_EMAILS` ends its shell access at once.
- Verified on the iOS simulator: the full round trip, the status row after an app restart, and the app returning from the sheet. That run used a local stand-in for the Portal, not the real one. Android is not verified: its intent filter and Custom Tabs return have not run on a device.

## Native AR capture

The shell runs AR natively, with ARKit on iOS and ARCore on Android, through the `ScanAR` Capacitor plugin. The web side is `NativeARProvider` (`src/ar/native.ts`). It implements the same `ARProvider` contract as the 8th Wall and WebXR providers, so the scanner above it does not change.

**Which runtime starts.** In the shell, the scanner starts on the native runtime when `ScanAR.capabilities()` reports `supported`. If the native session cannot start, the same canvas goes to the 8th Wall provider (once its engine loads), and then to WebXR. In a browser, native is never chosen, so the 8th Wall and WebXR paths are as they were. `?ar=webxr` and `?ar=8thwall` keep their runtimes (`src/ar/runtime-select.ts`).

**The plugin.** Native code: `ios/App/App/ScanARPlugin.swift` and `android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java`, with the GL frame loop in `ScanARRenderer.java`. The JavaScript shape is in `src/ar/native-bridge.ts`.

- `capabilities()` returns `platform`, `engine`, `supported`, `depth`, and a `reason` when unsupported.
- `start({ depth, hitGrid })` returns `rect` (CSS pixels, where the overlay canvas goes) and `cameraAspect`.
- `stop()` ends the session and gives the WebView back its background.
- `captureFrame({ depth })` returns the full camera frame as a JPEG in portrait, the camera-to-world transform, the projection, and optionally depth in metres.
- `hitTest({ x, y })` returns an exact hit at normalised coordinates of the rect.
- Events: `pose` (about 30 per second), `points` (about 5 per second, capped at 1500 each), `hits` (a grid of samples, about twice a second), `tracking` on change, and `error`.

**Choices that matter.**

- The camera is fitted whole inside the WebView ("contain"), the same as the 8th Wall provider. A keyframe is then the full frame, and its lens matches the overlay (see the `CameraFit` note in `src/ar/eighthwall.ts`).
- The overlay renders the scanner's Three.js scene from the native pose and projection every frame. The page is transparent while a session runs, and `<html>` carries the `native-ar` class.
- Depth is optional and sent only when asked for: LiDAR on iOS, the ARCore depth API on Android.

**Verification status.**

- Android: the debug build compiles (`./gradlew assembleDebug`, JDK 21 and SDK 36). It has **not run on a device**.
- iOS: **not compiled.** The build host has no Xcode. The Swift is written against the Capacitor and ARKit APIs and needs a Mac build before anyone relies on it.
- Web: `npm run test:native-ar` covers the codec, the provider against a fake plugin (including the fallback), and the runtime choice. `tests/mock-native-ar.spec.ts` runs the scanner in Chromium on a stand-in plugin, and checks the handover to the 8th Wall mock.

**Known gaps.**

- Android: Capacitor offers no pause hook to plugins, so backgrounding the app is not handled. The next frame reports a camera error, and the web app starts the session again.
- iOS: ARKit stops the session when the app is backgrounded. The plugin does not report that yet.
- The keyframe upload does not send the depth map yet (`FrameObservation.depthUrl` in `src/world/types.ts` is the slot for it).

## Publishing

Nothing in this folder uploads anything. The steps below need the owner's Apple and Google accounts.

**iOS (TestFlight).** Create the App Store Connect app for `com.companionintelligence.scan` first. Then, from `mobile/ios/App`:

```bash
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../../build/Scan.xcarchive \
  DEVELOPMENT_TEAM=<team-id> archive
```

Export and upload from Xcode Organizer, or with `xcodebuild -exportArchive` and an `app-store-connect` export options plist.

**Android (Play internal testing).** Create the Play app for `com.companionintelligence.scan` and an upload key. Write `mobile/android/keystore.properties` (git-ignored) with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`. Then, from `mobile/android`:

```bash
./gradlew bundleRelease
```

The bundle is `app/build/outputs/bundle/release/app-release.aab`.

## Not done

- The store gates in PR #244: the measurement step, and the xr.js licence check before any store binary.
- `PrivacyInfo.xcprivacy`, the privacy policy, and the App Privacy and Play data-safety answers. Location goes to OpenStreetMap Nominatim, and captures go to the Scan server.
- Companion Account sign-in against the real Portal, and on Android. Both are unverified (see *Companion Account sign-in*).
- Keychain or Keystore storage for the shell's session token. It is in `localStorage` for now.
- A 1024 px vector master for the app icon (see *Icons and launch screens*).
- `ScanAR` on a device. An ARKit iPhone (the Swift has never been compiled), and an ARCore Android phone (the build passes; no session has run).
- Depth in the keyframe upload (`FrameObservation.depthUrl`), and a UI entry point for the depth capture.
- Pause and resume handling in the plugin on both platforms (see *Native AR capture*).
