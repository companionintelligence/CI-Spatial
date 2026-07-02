# On-device testing over Tailscale

Manual test protocol for real phones against a tailnet server (see
[DEPLOY.md](DEPLOY.md) for standing the server up). Two device paths:
**iPhone Safari** runs the 8th Wall SLAM scanner; **Android Chrome** runs the
native WebXR scanner.

## Prerequisites

- Phone has the Tailscale app installed, logged into the tailnet, VPN **on**.
- Server healthy: `curl -fs https://<host>:5173/health` shows
  `"engineLoadState":"ready"` (or `systemctl --user status cscan-server cscan-web`).
- Get URLs onto the phone with a terminal QR code:

  ```bash
  npm run qr -- "/smoke.html?debug=remote"        # diagnostics page
  npm run qr -- "/scanner.html?world=default"     # scanner
  npm run qr -- "/webxr.html"                     # WebXR entry (Android)
  ```

- To see the phone's console on the box, run `npm run logs:watch` and load
  pages with `?debug=remote` appended.

## 60-second triage — /smoke.html

Open `https://<host>:5173/smoke.html?debug=remote` on the device first. All
rows should be PASS (Service Worker may WARN on first visit; XR8 reports n/a —
it only loads in the scanner). Results also stream to `npm run logs:watch`.
If anything fails here, fix it before AR testing — see Triage below.

## Checklist A — iPhone Safari (8th Wall SLAM)

Suggested devices: `iphone182`, `liam-ipad-pro`.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open the scanner URL in Safari | Page loads with **no certificate warning** (Tailscale cert is CA-trusted) |
| 2 | Tap **Start AR** | Camera + motion permission prompts appear immediately (they must originate from the tap) |
| 3 | Grant both permissions | Camera feed visible; status HUD shows SLAM initialising, then tracking |
| 4 | Walk slowly around the room | Point count in the HUD stats grows; compass/geo chip resolves an address outdoors |
| 5 | Tap the capture button | Progress sweep → detection labels pinned in 3D within ~5–30 s (model-dependent; watch `X-Inference-Ms` in server logs) |
| 6 | Toggle 📷 auto-capture and keep walking | Capture ring pulses on movement; count badge increments; HUD shows per-capture status |
| 7 | Toggle ☁ keyframe streaming | Stream count badge increments as you move; box side: `journalctl --user -u cscan-server -f` shows `POST /sessions/<id>/keyframes` |
| 8 | Open the side panel → export GLB | Upload toast; file lands in `scans/` on the box; optimization job logs run (Draco + LODs) |
| 9 | On a desktop browser open `/viewer.html?world=default` | The new scan appears in the world; LODs load progressively |
| 10 | Share-sheet → Add to Home Screen, launch the PWA | Standalone app opens to the scanner with the same session history |
| 11 | Airplane-mode ON (keep Wi-Fi off), capture | HUD shows offline/queue messaging rather than a spinner hang |
| 12 | Airplane-mode OFF | Queued uploads flush (watch server logs); no data lost |

**Watch the box side throughout:** `journalctl --user -u cscan-server -f` for
API traffic and inference timing; `npm run logs:watch` for on-device console
errors (page must be loaded with `?debug=remote`).

## Checklist B — Android Chrome (WebXR)

Suggested device: `hanzlas-z-fold7`.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open `/webxr.html` in Chrome | Support probe passes and auto-forwards to `/?ar=webxr` (needs ARCore / Play Services for AR) |
| 2 | Tap **Start AR** → grant camera | Native `immersive-ar` session starts; HUD (dom-overlay) stays visible over the camera |
| 3 | Sweep the camera slowly across surfaces | Point count grows from hit-test samples (slower than SLAM — expected) |
| 4 | Capture, auto-capture, ☁ streaming, export | Same expectations as Checklist A steps 5–9 |
| 5 | Note the 🥽 runtime toggle | In WebXR mode it links back to the 8th Wall scanner; in the 8th Wall scanner it only appears when `immersive-ar` is genuinely supported |

## Results matrix

Copy per test session:

| Step | iphone182 | liam-ipad-pro | z-fold7 | Notes |
|------|-----------|---------------|---------|-------|
| Smoke page all green | | | | |
| A2/B2 permissions from tap | | | | |
| Tracking + point growth | | | | |
| Capture → detection latency | | | | |
| Keyframe streaming | | | | |
| Export → viewer visible | | | | |
| PWA install | | | | |
| Offline queue + flush | | | | |

## Triage

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Certificate warning on device | Cert missing/expired or hostname mismatch | `tailscale cert <host>` in the repo root, then `systemctl --user restart cscan-web` |
| Page loads over `http://` or "HTTPS required" banner | Opened via IP or wrong scheme | Use the `https://<host>.ts.net:5173` URL (npm run qr) |
| "Server unreachable — is Tailscale connected?" HUD | VPN off on the phone, or cscan-server down | Tailscale app → VPN on; `systemctl --user status cscan-server` |
| "Model warming up — retry in a few seconds" | First inference after idle loads weights into VRAM | Retry; check `journalctl -u ollama -f` |
| Detections very slow (>30 s) or 504 | Model too large / running on CPU | `ollama ps` should show 100% GPU; re-pick model via `npm run bench:models`, set `OLLAMA_MODEL` in `~/.config/cscan/env` |
| Camera prompt never appears | Not a secure context, or Start not triggered by a user tap | Check /smoke.html Secure Context row; don't script the tap |
| HMR/live-reload dead on phone (dev mode) | `TAILSCALE_HOSTNAME` mismatch pins HMR to the wrong host | Export the right hostname before `npm start` (auto-detect usually handles it) |
| 🥽 toggle missing on iPhone Safari | Correct behavior — Safari has no WebXR `immersive-ar` | Use HelloXR (App Store id6757726359) for the WebXR path on iOS |
| No console output in `logs:watch` | Page loaded without `?debug=remote` | Reload with the query param (or set `localStorage['remote-log']='1'`) |
