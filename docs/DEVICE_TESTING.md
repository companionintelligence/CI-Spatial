# Device Testing

Open the VPN first on every device.

## Quick smoke

```bash
npm run qr -- /smoke.html
npm run logs:watch
```

Expected: secure context passes, `/health` passes, `/events` passes, IndexedDB
passes, and tiny `/infer` either passes or reports model warming while Ollama is
loading.

## iPhone Safari / 8th Wall

1. Scan `https://beta-1.capybara-ulmer.ts.net:5173/scanner.html?world=default`.
2. Confirm the lock icon uses the Tailscale certificate.
3. Tap Start AR and allow camera plus motion permissions from the tap prompt.
4. Move slowly until tracking locks and point count increases.
5. Tap capture. Expected: a downscaled image uploads, inference returns or shows
   a specific warmup/offline/timeout message.
6. Enable keyframe streaming and walk a short loop. Watch `npm run logs:watch`
   or server logs for session/keyframe activity.
7. Export. Expected: GLB downloads locally, uploads to the server, and viewer
   shows the scan in `/viewer.html?world=default`.
8. Reopen with `?debug=remote` when diagnosing mobile-only issues.

## Android Chrome / WebXR

1. Open `https://beta-1.capybara-ulmer.ts.net:5173/webxr.html`.
2. Start the immersive AR session.
3. Confirm hit-test/point accumulation updates the point counter.
4. Run the same capture, keyframe, export, and viewer checks as iPhone.

## Results Matrix

| Device | Browser | Smoke | AR start | Capture | Keyframes | Export/upload | Viewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| iphone182 | Safari |  |  |  |  |  |  |
| liam-ipad-pro | Safari |  |  |  |  |  |  |
| hanzlas-z-fold7 | Chrome |  |  |  |  |  |  |
