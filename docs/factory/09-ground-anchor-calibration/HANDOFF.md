# Handoff — wave 09 ground-anchor calibration

Written 2026-08-25, after PR #166 landed. Read this before touching calibration, the
spatial resolver, or the on-device test harness.

## Start here

```bash
git fetch origin && git checkout main && git reset --hard origin/main
npm ci                      # NOT npm install — see Environment below
deno task check && deno task test && npx tsc --noEmit
```

Then start the app and confirm the ports are yours before assuming anything is broken:

```bash
netstat -ano | grep -E ':(8000|5173|5174)\s.*LISTENING'
```

`npm start` runs the Deno API on `:8000` and Vite on `:5173`. **Other git worktrees of this
repo run their own Vite instances**, so a busy port often means a different checkout is
serving, not that you have a stale process. Override with `VITE_PORT` / `PORT` rather than
killing someone else's server.

## Where the wave stands

| Ticket | State |
|---|---|
| 0001 honest calibration status | landed |
| 0002 two-point frame schema | landed — **atlas badge still says open; it is not** |
| 0003 environment-scan readiness | landed |
| 0004 staged two-point flow | landed (PR #166) |
| 0005 anchor tests + WebXR verification | code landed, **on-device checklist unrun** |
| 0006 room-loop drift benchmark | **closed unrun** — instrument shipped, measurement never taken |
| 0007 reference photos | specced and revised, **not implemented** |

## The three things most likely to bite you

### 1. Absolute orientation does not exist

Nothing reads `anchorBearingDeg`. Nothing reads `spatialFrame` except `src/main.ts` writing
it. A scan's world placement comes **only** from `localToWorld = matrixFromMeta(projectTransform)`
in `server/main.ts`, which is the session's own `sessionToProject`.

Consequence: a two-point frame orients the room so that **the direction the user walked
becomes +Z**. That is arbitrary relative to the real world. Users report this as "rotated,
and it doesn't line up." It is not a bug in the frame — the frame is internally correct and
reproducible. Absolute orientation was simply never implemented, and ADR 0005 assumed a
consumer that does not exist.

Scoped out deliberately: current requirement is aligning scans **within one Place**, not
across Places. Revisit when the World Editor needs to be geo-referenced.

### 2. There is a real 180° bug in the compass path, still unfixed

`composeYUpTransform(t, bearing)` maps local **+Z** to the ENU direction at `bearing`
(`geoToEnu` defines `x=east, y=up, z=north`). But the camera looks down **−Z** —
`viewportRay()` in `src/ar/webxr.ts` builds the ray with `z: -1/len`.

So feeding it the *camera's* compass heading orients the scan 180° from reality. This affects
both placement paths that use a compass:

- `server/main.ts` GPS fallback: `composeYUpTransform(translation, geoPose.bearing, 1)`
- `anchorToProjectTransform(tapPos, bearingDeg)` — the one-point tier

I grepped `src/world/`, `src/spatial/` and the server: there is **no compensating flip
anywhere**. Two-point frames are immune (their heading is geometric), but older scans of the
same Place carry this and will not overlay new ones.

There is a second, larger error hiding behind it: `bearing` is sampled at *tap* time and
describes the **device's** heading, not the session frame's. The correct frame yaw is
`bearing − camera_yaw_within_session`, and that term is ignored entirely. The `Pose` rotation
quaternion is available, so it is computable — it just isn't computed.

### 3. Reversed point order rotates the frame exactly 180°, and passes verification

`+Z = landmark → heading marker`. Tap the same two features in the opposite order and the
frame rotates 180° while `separationM` is bit-identical — so the residual check passes and
reports `'verified'`.

Ticket 0004 warned that separation proves "the right distance apart, not the same two
points." This is sharper: reversal is a *guaranteed* 180° error that verification actively
blesses. Ticket 0007's photos and `pointLabels` are the mitigation; neither is implemented.

## Other findings worth knowing

**`estimateFloorY()` is an 8th-percentile, not a plane fit.** It has been observed ~2 m out
on a real capture (returned +0.84 m while the lowest detected object sat at −0.05 m). The
frame no longer depends on it — PR #166 anchors the floor to the landmark's measured tap —
but `isTapOnGround()` still does, so a bad estimate makes the gate reject genuine floor taps
as "cm above the floor". The floor overlay added in #166 makes this visible; check it against
the real floor before blaming the tolerance. Upgrading this to a RANSAC plane fit over the
existing point cloud is the highest-value improvement available and costs the user nothing.

**Detections can still be badly placed.** #166 bounded hit-test acceptance at
`MAX_HIT_DISTANCE_M = 5.0` (it previously had no upper bound at all, making the primary path
more permissive than its own 5 m fallback). Before that fix a captured room recorded a sofa
23 m away and a monitor 4.7 m in the air. Re-scan before trusting any spatial measurement
taken from data captured earlier than 2026-08-25.

**Galaxy Tab S8 Ultra: the camera never renders in the app.** Ruled out by direct test:
tab contention (1 tab, still fails), stuck/embargoed permission (full reset, still no
prompt), device/Chrome camera health (a plain `getUserMedia` probe streams the back camera on
the same origin), and `/xr.js` failing to load (serves 200, and `XR8.run()` is reached). The
diagnostics added in #166 — `onCameraStatusChange` / `onException` — stay **silent** on that
device too, which narrows it to 8th Wall bailing before it installs its camera module. Use
`/camera-check.html` to re-confirm the device is healthy in one tap. The S9 works fine.

## Environment gotchas

- **`npm ci`, never `npm install`.** See CLAUDE.md — a mutated tree produces a Playwright
  error that names the wrong cause ("two different versions of @playwright/test").
- **Some Factory docs are CRLF.** Writing them with Python in text mode converts the whole
  file and turns a 60-line diff into 700. Read as bytes, normalise, restore on write.
- **Playwright `chromium-mock` uses `testMatch: /mock-.*\.spec\.ts/`.** A spec not named
  `mock-*` silently will not run ("No tests found").
- **Point Playwright at the right port:** `VITE_URL=https://<host>:<port> npx playwright test
  --project=chromium-mock <spec>`.
- A `tailscale serve` mapping fronts port 5174 on this machine; it proxies to
  `https+insecure://localhost:5174` and gives a trusted cert for on-device testing.

## Test harness notes

**The xr8 mock was broken in two ways, both fixed in #166** — but the fixes matter for
interpreting older results:

1. `XR8.Threejs` was missing entirely, so `eighthwall.ts`'s `start()` threw and **every
   `mock-xr8-*` spec had been dead**.
2. `onStart` was never dispatched to pipeline modules, so `provider.getScene()` returned
   null and **no decal was ever created under the mock** — any test asserting on anchor
   markers, the baseline or the floor grid was passing against an empty scene.

`tests/mock-xr8-scan.spec.ts` is **still red** for a third, separate reason: it never
dismisses the Wave 09 Scanner Location sheet, so AR never starts. Left alone deliberately —
fixing it is a small change to that spec (select a Place, or click `#place-skip-btn`).

**Writing calibration tests:** two constraints, both learned the hard way and documented in
`tests/mock-two-point-calibration.spec.ts`:

- The calibration card is centred along the bottom (~x 0.35–0.65 at 1280px) and takes pointer
  events by design. A tap there hits the card, not the canvas, and silently places nothing.
- Pairs closer than `ANCHOR_RADIUS_M` (0.35 m) *select* rather than place — intended tap-near
  behaviour, not a failure. The mock maps screen x to world x as `(x − 0.5) * 4.0`.
- The mock's pose drifts between taps. Use `XR8.freezeAt(n)` when a test needs a deterministic
  separation.

## Driving the Android tablets

`.mcp.json` defines one MCP server per device, each with its own bearer token from an env var
(see `docs/testing/DEVICE_TESTING.md`). The S9 (`galaxy-tab-s9-ultra`) works; the S8
(`liams-tab-s8-ultra`) has the camera problem above.

**The bridge can tap and read the screen but cannot execute JavaScript in the device's
browser.** That constraint drove a design choice worth reusing: `public/compass-bench.html`
and `public/camera-check.html` compute their numbers on-device and render them as text, which
the accessibility tree exposes and the agent can read. Do the same for any future on-device
measurement.

Also: the accessibility tree **lags the WebView**, and node ids churn constantly because the
Scanner Location modal re-renders on every geolocation tick. Re-query immediately before
tapping, and fall back to coordinate taps read off a screenshot when a node id goes stale.

## Suggested order of work

1. **Run 0006's benchmark** if the constants are ever doubted — closed unrun, revisit triggers
   are recorded at each constant's definition.
2. **Implement 0007** (reference photos + `pointLabels`). It is the only mitigation for the
   reversed-pair 180°, and its dependencies are landed.
3. **Persist both committed markers.** `dropCommittedOrigin()` handles the landmark only;
   `clearPlacement()` tears the heading marker's decal down at commit. Required by 0007 and
   already in its DoD.
4. **Upgrade `estimateFloorY()` to a plane fit.**
5. **Fix the −Z/+Z compass bug** if older scans need to overlay new ones.
6. **Run the on-device checks** — 0005's WebXR checklist and 0004's compass-independence
   check, which is the clearest single demonstration this wave was worth doing.
