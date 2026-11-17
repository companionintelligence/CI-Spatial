# 0009. Native ARKit and ARCore runtimes sit beside the 8th Wall provider

- **Status:** Accepted. Device verification pending.
- **Date:** 2026-11-08
- **Related issue:** none

## Context

The Scan shell (`mobile/`, Capacitor 8) wraps the web app in a WebView. Neither WebView runs WebXR, and the 8th Wall path had never run inside the shell. So the shell had no AR at all, and its only capture route was a walkthrough video.

The scanner talks to AR through one contract, `ARProvider` (`src/ar/provider.ts`). Two implementations exist: the 8th Wall engine (`src/ar/eighthwall.ts`, loaded from `public/xr.js`, with its own load timeout and fallback) and WebXR (`src/ar/webxr.ts`). Both are browser runtimes. A native AR session (ARKit on iOS, ARCore on Android) gives a camera, a pose, feature points and hit tests inside the app, without the WebView.

The earlier Lumina comparison showed the gap that matters: a native capture path is the only one that can give metric scale on a phone without relying on a user-entered distance.

## Decision

We will add a third `ARProvider`, `NativeARProvider` (`src/ar/native.ts`). It is backed by a Capacitor plugin, `ScanAR`, implemented in ARKit (`ScanARPlugin.swift`) and ARCore (`ScanARPlugin.java`, `ScanARRenderer.java`).

- In the shell, the scanner starts on the native runtime when the plugin reports that a session can start. The 8th Wall and WebXR runtimes keep their code and their order. They become the fallback when a native session fails to start, and the same canvas is handed over.
- The native layer fits the whole camera image inside the WebView ("contain"), as the 8th Wall provider does, so a keyframe is the full, uncropped frame and its lens matches the overlay. Pose and projection come from the native layer; the overlay renders the scanner's Three.js scene from them.
- Pose, points, and a grid of hit samples arrive as events. The synchronous `ARProvider` methods read the latest copy. Captures and exact hit tests are requested on demand. Depth is optional and requested per call.
- The SLAM point-distance rule moves to `src/ar/point-filter.ts`, so both providers apply one rule.
- The shell is portrait-only, on both platforms, because the native camera is fitted to a portrait overlay rect.

Constraints this satisfies:

- `ARProvider` remains the only seam the scanner sees. No scanner code changes beyond the runtime choice in `src/main.ts`.
- ADR 0001: the native runtime reuses `ARProvider`, `RawFrame`, `Pose` and `HitResult`. Depth, when it reaches the server, uses the existing `FrameObservation.depthUrl` slot. No new persisted type is introduced.

## Consequences

- The 8th Wall configuration (`public/xr.js`, `XR8_LOAD_TIMEOUT_MS`, `createEighthWallProvider`) is unchanged. A native phone does not wait for the engine, and it loads only when a native session fails.
- Neither native path has run on a device. The Android debug build compiles. The iOS simulator CI job compiles the Swift; this build host has no Xcode. The first on-device run is the gate: an ARKit iPhone with and without LiDAR, and an ARCore phone such as the Galaxy Tab S9 Ultra or the Tab S8 Ultra in `docs/testing/DEVICE_TESTING.md`.
- The `xr.js` licence (see `mobile/README.md`) still gates any store build, because the fallback is the 8th Wall engine.
- Android cannot pause the session when the app is backgrounded, because Capacitor offers no pause hook to plugins. That is a known gap. iOS reports an ARKit interruption as tracking `notAvailable`, and [ADR 0010](0010-ios-world-maps-stay-on-the-phone.md) covers its world maps.
- Revisit this decision when the first device run shows the contain-fit overlay out of register with the camera, when exact hit tests are too slow for calibration, or when a store review asks for the 8th Wall engine to be removed from the shell.
