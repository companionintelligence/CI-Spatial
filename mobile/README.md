# Scan mobile shell

Capacitor 8 iOS and Android shell around the Scan web app in the repo root.

**Not a store build.** The Android app is published only as a GitHub pre-release: a release APK built by `.github/workflows/native-release.yml` and signed with the project's release key or a throwaway key (see *Publishing*). Nothing is uploaded to Google Play or the App Store, and iOS is not built for release at all.

## Gates

Still open for the Android pre-release:

- **AR capture has not run on a phone.** See *Native AR capture* below. The release notes say so.
- **The identifiers are provisional.** `com.companionintelligence.scan` names where the app keeps its local scans, and is permanent once on Google Play, so confirm it before people rely on a build.
- **iOS and the stores are the owner's to do.** They need the owner's Apple and Google accounts (see *Publishing*).

Before any store build, also:

- **Measure first.** The mobile wrapping assessment (2026-10-31, section 2, row "Scan") gates this app on measurement on real devices. Apple 4.2.1 rates a bare wrapper around an AR app as high review risk.
- **AR runs natively, and neither native path has run on a device.** WebXR is unavailable in both WebViews, so the shell's AR is the `ScanAR` plugin, which runs ARKit (iOS) and ARCore (Android) itself. See *Native AR capture*. The 8th Wall path (`public/xr.js`) has not been run in the shell either.
- **xr.js licence.** `public/xr.js` and its files are Niantic Spatial's proprietary XR Engine, under the XR Engine License Agreement, and they are bundled into this shell unmodified. The Agreement and Niantic's guidance allow the original binary in a free app that shows Niantic's copyright notice and a link to the Agreement; the app shows both under Legal notices (`src/ui/legal-notices.ts`, on the first-run screen and in the editor's Navigate menu). Clause 1.2 still forbids a paid product whose value comes mainly from the engine, so re-check it before any paid build. It is also the fallback when a native session cannot start, so the native runtime does not take it out of the shell. Niantic can end the licence on five days' notice (section 7.2). The owner's sign-off also covers the hosted web app: it serves the same engine (`public/xr.js`) but shows no Niantic notice, a gap older than the apps, and whether section 1.3.2 asks it for one is the owner's call.
- **Server address.** The shell reaches the Scan server whose address the person sets in the app (see *Server address* below). Companion Account sign-in runs in the system browser sheet and gives the shell a session token (see *Companion Account sign-in*). It is verified on the iOS simulator against a stand-in Portal only.

## Build

Run these inside this directory, after `npm ci` in the repo root. It is a standalone npm project, not part of the root workspace.

```bash
npm ci                    # once
npm run build             # the web build into www/, then cap sync for both platforms
npm run open:ios
npm run open:android
```

For Android alone, as the workflows do: `npm run build:web`, then `npx cap sync android`, then `./gradlew assembleRelease` (or `assembleDebug`) in `android/`.

`npm run build:web` is `scripts/native/build-web.mjs mobile`: the root Vite build with `VITE_DISABLE_PWA=1` into `www/`, without the model weights (`public/models`, whose licence is unchecked) or the test-only files, with `THIRD-PARTY-NOTICES.txt` and `LICENSE.txt` added. It refuses a `.env` file that sets a `VITE_` variable, so no local setting is baked in. It also stops unless the XR Engine files in `www/` are Niantic's published bytes (`scripts/native/check-xr-engine.mjs`), which a Windows clone made before `.gitattributes` does not have: delete `public/xr*.js` and run `git checkout -- public` to fix one. Git ignores everything `cap sync` writes, so run `npm run sync` after a clone.

The release APK's libraries, transitive ones included, are pinned in `android/app/gradle.lockfile`, and `THIRD-PARTY-NOTICES.txt` lists them from it. The release build uses the versions pinned there, and fails when it would take in a library the lockfile does not list or leave out one it does, so the notices cannot fall behind the APK. After changing a dependency or updating Capacitor, run `npx cap sync android`, then in `android/`: `./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks`. A library from a group the notices do not know yet stops the web build until its licence is checked and added to `ANDROID_LICENCES` in `scripts/native/third-party-notices.mjs`.

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
| Android backup | Off: `allowBackup="false"`, and `res/xml/data_extraction_rules.xml` excludes every domain from cloud backup and device-to-device transfer | The WebView's storage holds the session token and the scans. `allowBackup="false"` alone still lets Android 12 and later copy them to a new phone. |
| Version | `versionName` 0.2.1, `versionCode` 3 | In step with the desktop app (`scripts/native/check-versions.mjs`). Raise `versionCode` by one with every release. |
| Release signing | Four environment variables, or `keystore.properties` | See *Publishing*. The release build type is never debuggable. |

## Server address

The shell has no server of its own. The person sets their Scan server's https address on the first-run screen (the Server row) or in the editor (Navigate, Scan server), and the app keeps it on the device. See [the README](../README.md#the-scan-server-in-the-android-ios-and-desktop-apps) for the rules, including why plain http is refused. Every server path in `src/` goes through `apiUrl()` or `wsUrl()` in `src/shared/api-base.ts`, which put that origin in front of it. The hosted web app never reads the saved address, so its URLs are unchanged.

A build can also name a default server, which an address saved in the app overrides:

```bash
VITE_API_BASE=https://<server-origin> npm run build
```

`scripts/check-api-base.mjs` lets the variable be unset, and refuses a value that is not an https origin.

The server accepts the shell's origins: `capacitor://localhost` (iOS) and `https://localhost` (Android), in `server/origin.ts`, beside the desktop app's. In dev, Vite answers CORS preflights before its proxy, so `vite.config.ts` lists the same origins. Without that, the shell's JSON requests fail in dev. Live events and capture have not run in the shell on a device.

## Companion Account sign-in

The shell's origin never receives the server's session cookie, so the shell signs in another way. "Sign in with Companion Account" opens the server's sign-in in the system browser sheet, with a PKCE challenge the shell made. The server completes the Portal sign-in as it does on the web. Then it redirects to `com.companionintelligence.scan://auth?code=…`, with a one-time code that lasts 60 seconds. The app opens that URL, closes the sheet, and trades the code and its verifier at `POST /authenticate/shell/exchange` for a session token. From then on the shell sends the token as `Authorization: Bearer`, and the first-run status row reads "Signed in." The code is in `src/shared/shell-sign-in.ts`, and the server half is in `server/portal_auth.ts`. The desktop app uses the same code with its own scheme; see [desktop/README.md](../desktop/README.md#companion-account-sign-in).

- The token is the server's signed session, valid for seven days. The shell keeps it in the WebView's `localStorage`. The Android app is left out of backup and device-to-device transfer (see *Decisions*), so the token does not leave the phone that way. Move it to the Keychain (iOS) or the Keystore (Android) before a store build.
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
- iOS: **compiled, not run on a device.** The mobile-build workflow's iOS Simulator job compiles the Swift and passed on the current commit (run 44013563826). The workflow runs only when someone starts it by hand. This build host has no Xcode.
- Web: `npm run test:native-ar` covers the codec, the provider against a fake plugin (including the fallback), and the runtime choice. `tests/mock-native-ar.spec.ts` runs the scanner in Chromium on a stand-in plugin, and checks the handover to the 8th Wall mock.

**Known gaps.**

- Android: Capacitor offers no pause hook to plugins, so backgrounding the app is not handled. The next frame reports a camera error, and the web app starts the session again.
- iOS: ARKit stops the session when the app is backgrounded. The plugin reports the interruption as tracking `notAvailable`, and autosaves the map of a named Place (ADR 0010). The pose events carry the state again after the app returns.
- The keyframe upload does not send the depth map yet (`FrameObservation.depthUrl` in `src/world/types.ts` is the slot for it).

## Publishing

**GitHub pre-release (Android).** `.github/workflows/native-release.yml`, run by hand with a tag, builds the release APK with the desktop installers and publishes them together; see the README's *Desktop and Android apps*. Its `android_signing` input picks the key: `auto` uses the release key when the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` are all set, and a throwaway key generated in the job and never stored when none of them is. With only some of them set, `auto` stops and names the missing ones rather than fall back to a throwaway key: a misnamed secret would otherwise put out an APK that everyone must uninstall, losing their scans, before the first one signed with the release key. `keystore` and `throwaway` force one, and `skip` publishes an unsigned APK. The APK's name says which. Android updates an app only with a build signed by the same key, so every APK signed with a throwaway key needs the previous one uninstalled first.

**Stores.** Nothing in this folder uploads anything. The steps below need the owner's Apple and Google accounts.

**iOS (TestFlight).** Create the App Store Connect app for `com.companionintelligence.scan` first. Then, from `mobile/ios/App`:

```bash
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath ../../build/Scan.xcarchive \
  DEVELOPMENT_TEAM=<team-id> archive
```

Export and upload from Xcode Organizer, or with `xcodebuild -exportArchive` and an `app-store-connect` export options plist.

**Android (Play internal testing).** Create the Play app for `com.companionintelligence.scan` and an upload key. Give Gradle the key in one of two ways, all four values or none:

- the environment, as the release workflow does: `ANDROID_SIGNING_STORE_FILE` (the keystore's path), `ANDROID_SIGNING_STORE_PASSWORD`, `ANDROID_SIGNING_KEY_ALIAS` and `ANDROID_SIGNING_KEY_PASSWORD`;
- or `mobile/android/keystore.properties` (git-ignored), for a local build, with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`.

With neither, the release build is unsigned; with only some of the environment variables, Gradle stops and names the missing ones. The release build type is never debuggable. Then, from `mobile/android`:

```bash
./gradlew bundleRelease
```

The bundle is `app/build/outputs/bundle/release/app-release.aab`.

## Not done

- AR capture on a real phone: camera, motion and location prompts, the 8th Wall SLAM start, GLB export, and the sign-in return on Android.
- The store gates in PR #244: the measurement step, and the owner's sign-off on the XR Engine licence (see *xr.js licence* above) before any store binary.
- `PrivacyInfo.xcprivacy` is drafted with no collected data types, and the draft's comment lists what the owner must decide. The privacy policy and the App Privacy and Play data-safety answers are still open. Location goes to OpenStreetMap Nominatim, and captures go to the Scan server.
- Companion Account sign-in against the real Portal, and on Android. Both are unverified (see *Companion Account sign-in*).
- Keychain or Keystore storage for the shell's session token. It is in `localStorage` for now.
- A 1024 px vector master for the app icon (see *Icons and launch screens*).
- `ScanAR` on a device. An ARKit iPhone has not run it: the simulator job compiles the Swift, but ARKit behaviour is only verified on a phone. An ARCore Android phone has not run a session either (the build passes).
- Depth in the keyframe upload (`FrameObservation.depthUrl`), and a UI entry point for the depth capture.
- Pause and resume handling in the plugin on both platforms (see *Native AR capture*).
