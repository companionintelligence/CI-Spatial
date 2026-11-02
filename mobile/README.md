# Scan mobile shell

Capacitor 8 iOS and Android shell around the Scan web app in the repo root.

**Scaffold, not for store submission.** Nothing here is signed, uploaded or listed.

## Gates before any store build

- **Measure first.** The mobile wrapping assessment (2026-10-31, section 2, row "Scan") gates this app on measurement on real devices. Apple 4.2.1 rates a bare wrapper around an AR app as high review risk.
- **WebXR and AR do not run in the shell.** WebXR is unavailable in both WebViews. The 8th Wall path (`public/xr.js`) needs the camera and sensors, and it has not been run in the shell. Treat AR as unverified here.
- **xr.js licence.** `public/xr.js` is Niantic's proprietary XR ENGINE LICENSE AGREEMENT. Clause 1.2 forbids use in a paid product whose value derives from the software. It is bundled into this shell. Do not upload a store binary until the licence has been checked.
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

## Icons and launch screens

The app icon, the Android adaptive icon and both launch screens are generated from
the Scan mark in `public/icon-512.png` by `scripts/native-art.sh` (macOS, uses `sips`).
Run it after changing the mark, then `npm run sync`. The root test `npm run
test:native-art` checks the sizes, and that the iOS icon has no alpha channel. The
mark is a 512 px raster, so the iOS 1024 px icon is an upscale. A 1024 px vector
master is the next step for store art.

## Decisions (provisional)

| Item | Value | Why |
|---|---|---|
| Bundle id, Android applicationId | `com.companionintelligence.scan` | Provisional. An Android id is permanent once uploaded. |
| Display name | Scan | |
| Devices | iPhone only (`TARGETED_DEVICE_FAMILY = 1`) | First review is iPhone-only. |
| iOS minimum | 16.4 | The shipped bundle contains class static blocks, which Safari supports from 16.4. |
| Transport | HTTPS only | `androidScheme: https`, `server.cleartext: false`, `CapacitorHttp` off, `allowMixedContent: false`. There is no remote `url`. |
| Zoom | On, both platforms | WCAG 1.4.4. Capacitor defaults this to off. |
| PWA | Off in this build | `VITE_DISABLE_PWA` drops the service worker, the manifest and the link to it. See `pwaSwitch()` in `vite.config.ts`. |
| Sentry | None | The web code has no Sentry SDK. |
| Plugins | Capacitor core, App, Browser | App and Browser carry Companion Account sign-in from the browser sheet back to the app. No ARKit, ARCore or other native plugin. |
| URL scheme | `com.companionintelligence.scan://auth` | Where a shell sign-in ends. Registered in `Info.plist` (`CFBundleURLTypes`) and `AndroidManifest.xml` (an intent filter). Must match `SHELL_RETURN_URL` in `server/portal_auth.ts`. |
| iOS purpose strings | Camera, location when in use, motion | The code asks for these. No microphone: every `getUserMedia` call sets `audio: false`. No photo-library key: the file input uses the system picker. |
| Android permissions | `CAMERA`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Device motion needs no Android permission. |

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
