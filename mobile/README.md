# Scan mobile shell

Capacitor 8 iOS and Android shell around the Scan web app in the repo root.

**Scaffold, not for store submission.** Nothing here is signed, uploaded or listed.

## Gates before any store build

- **Measure first.** The mobile wrapping assessment (2026-10-31, section 2, row "Scan") gates this app on measurement on real devices. Apple 4.2.1 rates a bare wrapper around an AR app as high review risk.
- **WebXR and AR do not run in the shell.** WebXR is unavailable in both WebViews. The 8th Wall path (`public/xr.js`) needs the camera and sensors, and it has not been run in the shell. Treat AR as unverified here.
- **xr.js licence.** `public/xr.js` is Niantic's proprietary XR ENGINE LICENSE AGREEMENT. Clause 1.2 forbids use in a paid product whose value derives from the software. It is bundled into this shell. Do not upload a store binary until the licence has been checked.
- **No server yet.** The web code calls relative URLs (`/projects`, `/sessions`, `/worlds`, `/authenticate`, `/events`). In the shell these resolve to `capacitor://localhost` (iOS) or `https://localhost` (Android), where nothing answers. A base-URL helper is needed before the shell can reach a Companion Scan server.

## Build

Run these inside this directory. It is a standalone npm project, not part of the root workspace.

```bash
npm install     # once
npm run build   # web build with VITE_DISABLE_PWA=1 into www/, then cap sync
npm run open:ios
npm run open:android
```

`npm run build` writes `www/`, which `cap sync` copies into both native projects. Git ignores everything `cap sync` writes, so run `npm run sync` after a clone.

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
| Plugins | Capacitor core only | No ARKit, ARCore or other native plugin. |
| iOS purpose strings | Camera, location when in use, motion | The code asks for these. No microphone: every `getUserMedia` call sets `audio: false`. No photo-library key: the file input uses the system picker. |
| Android permissions | `CAMERA`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Device motion needs no Android permission. |

## Not done

Signing, App Store Connect, Play Console, store listings, the app icon (Capacitor's default), `PrivacyInfo.xcprivacy`, the privacy policy and the Play data-safety answers. The data-safety answers must cover location: the web code sends coordinates to OpenStreetMap Nominatim for reverse geocoding.
