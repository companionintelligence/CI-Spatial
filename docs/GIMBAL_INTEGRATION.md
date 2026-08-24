# Gimbal-driven capture (DJI Osmo Mobile 6)

[`subsystems/osmo-ble/`](../subsystems/osmo-ble/) controls a DJI Osmo Mobile 6 gimbal over
Bluetooth LE via reverse-engineered DUML commands, and exposes that control as an MCP server so
Claude Code (or any MCP client) can drive automated capture sweeps. It's vendored into this repo
(moved in from a standalone project on 2026-08-21) so a fresh clone gets the whole system in one
place — see the [root README's quick-setup section](../README.md#quick-setup) to get running.

**Status (2026-08-21):** protocol codec and pairing are verified against a real captured frame.
Gimbal speed-control's axis order/signs were live-verified against a real OM6 via the web UI
joystick and corrected in `subsystems/osmo-ble/protocol/commands.mjs`. **The absolute-angle opcode
(cmdId 0x14) is confirmed non-functional** — a direct A/B test against real hardware (speed
command: delta 0.126, moved; absolute-angle command: delta 0.0002, not moved, same gimbal, same
session) showed it does nothing, consistent with earlier disassembly finding that DJI's real
angle-set commands are larger structs our guess never matched. `gimbal_move_to`, `gimbal_sweep`,
and `gimbal_recenter` were all rewritten to use closed-loop positioning instead — see
"Closed-loop positioning" below. The "mode" toggle (cmdId 0x44) is confirmed to be a
portrait/landscape switch, not a real lock/follow/fpv selector. The web control UI is a compact
one-handed PWA matching CI-Common's design tokens (`packages/tokens/src/tokens.css`, dark theme),
with a live orientation readout, a persistent command-coverage grid, and a structured frame
inspector.

**Architecture — one BLE connection, owned by `server/backend.mjs`:** the `osmo-gimbal` MCP
server does **not** hold its own Bluetooth connection. It's a Claude Code-spawned subprocess,
parented by the same process tree as Claude's own tool execution — and a captured macOS crash
report (`namespace: TCC`, missing `NSBluetoothAlwaysUsageDescription`) proved that tree cannot be
granted Bluetooth access. Every gimbal MCP tool is a thin HTTP client of
`subsystems/osmo-ble/server/backend.mjs` instead, which you run yourself in a real terminal — the
only place BLE has been proven to work. This also means there's only ever one BLE connection to
the single physical gimbal, not two independent ones fighting over it.

**Known gotcha:** code changes only take effect once the long-running processes that loaded them
restart — Node doesn't hot-reload modules. `server/backend.mjs` now runs under `node --watch`
(`npm run backend`, restarts itself on save) but the `osmo-gimbal` MCP server subprocess still
needs an explicit `/mcp` reconnect (or a session restart) to pick up code changes or new tools.

**Known gotcha — the gimbal itself can get into a stuck BLE state.** Observed 2026-08-23: after
heavy scan/connect/disconnect churn plus a `bluetoothd` restart on the Mac side, the gimbal started
advertising as two separate peripherals at once (`OM6-E06YAM-1`/`-2`, same manufacturer data) and
refused new connections (`Error: Peripheral already connected`) even after a clean
`disconnect()`/rescan from our side — i.e. this was the *gimbal's* BLE stack wedged, not just ours.
**Fix: a hardware Bluetooth reset on the gimbal itself** — hold the shutter button, mode/switch
button, and trigger together for about a second. If a backend restart + rescan doesn't recover a
connection, try this before assuming it's a code or macOS-side problem.

## Why no signaling is needed for a passive sweep

The scanner client (`index.html` + `src/capture/*`, `src/ar/*`) never needs to be told a scan is
happening from outside — it already captures purely off the phone's own tracked movement:

- **Auto-capture** (`src/capture/auto-capture.ts`) polls pose ~every 400ms and fires whenever
  the camera has moved ≥0.35m (default) and ≥2.5s has passed since the last capture.
- **Keyframe streaming** (`src/capture/keyframes.ts`) fires on ≥minDistanceM movement or
  ≥minRotationDeg rotation, polled ~every 350ms.

So mounting the phone in the Osmo Mobile 6 and running a gimbal sweep is, from the scanner
client's perspective, indistinguishable from a human moving the phone by hand. For an *exact*
photo count instead of "however many the heuristics trigger," see the grid-capture section below
— it bypasses this scanner client entirely in favor of a plain camera app.

## Setup

1. Install `subsystems/osmo-ble`'s own dependencies: `cd subsystems/osmo-ble && npm install`.
2. Register the MCP server — already done via the `osmo-gimbal` entry in
   [`.mcp.json`](../.mcp.json) at the repo root (`{"command":"node","args":["subsystems/osmo-ble/server/mcp-server.mjs"]}`,
   a repo-relative path so it works for any clone). Claude Code picks this up automatically.
3. Start the backend yourself, in a real terminal (see the architecture note above for why this
   can't be automated): `cd subsystems/osmo-ble && npm run backend`. First run needs Bluetooth
   granted to the Node process by macOS.
4. From a Claude Code session in this project: `scan_devices` → `connect` → `pair` (PIN is shown
   on the gimbal's own screen) → then `gimbal_sweep` or `gimbal_move_to` to drive it.

## Closed-loop positioning (`gimbal_move_to`, `gimbal_sweep`, `gimbal_recenter`)

Since the absolute-angle opcode does nothing, "move to an absolute angle" is instead built on top
of the confirmed-working speed command: `moveToClosedLoop` (`server/backend.mjs`) sends speed
corrections in a loop, reading the live quaternion after each tick via `quatToEulerDeg`
(`protocol/telemetry.mjs`, shared with the web UI's orientation readout), until the error is
within `toleranceDeg` or `maxMs` elapses. Two things this does NOT solve, handled defensively
instead:
- Euler angles from a tilted device mix axes together — this is a relative-change indicator, not
  a calibrated attitude readout, so "converged" means "close enough," not exact degrees.
- The correspondence between `quatToEulerDeg`'s sign and which physical direction a positive
  commanded speed drives each axis was never independently calibrated. Each axis adaptively flips
  its own sign the first time a correction makes that axis's error worse instead of better, so a
  wrong initial guess self-corrects rather than diverging.

`gimbal_move_to(yawDeg, pitchDeg)` exposes this as a single step, returning
`{converged, timedOut, ticks, finalYaw, finalPitch, history}` — **check `converged`**, don't
assume a call that returned without erroring actually reached the target. `gimbal_sweep` strings
several of these together across a yaw range; `gimbal_recenter` targets `(0, 0)` (caveat: "0,0" is
wherever this device's quaternion frame reads as zero, not independently confirmed to be true
mechanical center).

**Movement-only rehearsal, live-tested 2026-08-21** (no photo capture — `android-beam-pro-1` was
unreachable at the time): before the closed-loop version existed, the 9-position grid from
`plan_scan_grid` was driven as 8 consecutive relative `gimbal_nudge` calls (delta between
successive targets → speed × duration, e.g. a 20° yaw delta at 30°/s ≈ 667ms), confirming the
grid-traversal *pattern* works end to end (cumulative quaternion delta ≈0.30 start-to-finish) even
before closed-loop absolute positioning existed. Prefer `gimbal_move_to` per-step going forward —
it gets verified convergence instead of open-loop timing.

Other relevant tools: `get_orientation` (poll current facing), `gimbal_nudge` (interactive single
speed move + auto-stop, no positioning), `get_recent_frames` (raw telemetry), `plan_scan_grid`
(see below).

## Automated N-shot grid capture → Companion Scan's real ingest pipeline

For an *exact* photo count (e.g. "9 photos") rather than relying on auto-capture heuristics,
drive an explicit camera-capture tool instead — verified against this repo's actual capture→3D
pipeline, not invented:

1. `plan_scan_grid` (in `osmo-gimbal`, pure computation, no device needed) — returns a
   serpentine-ordered `yawCount x pitchCount` grid of absolute `(yawDeg, pitchDeg)` targets.
   Defaults to 3x3 = 9 targets, minimizing travel between consecutive steps.
2. For each target: `gimbal_move_to(yawDeg, pitchDeg)` — closed-loop move, check `converged` in
   the result (see "Closed-loop positioning" above) before treating the step as actually there.
3. Immediately after each move: a photo-capture tool call on whichever Android device is
   physically mounted in the gimbal cradle — `android_take_camera_photo` or
   `android_save_camera_photo` on that device's MCP server (e.g. `android-beam-pro-1`), using its
   **plain camera app**, not the AR scanner page. (This mode doesn't need live SLAM tracking —
   that's what the passive sweep above is for.)
4. `POST /ingest-photos` (`main.ts:809-903`, multipart `files: File[]`, optional `name`) with the
   collected photos → `202 {sessionId, scanId, jobId, frameCount, droppedBlurry}`. This is the
   real, already-built ingest path for a pose-less photo batch: it EXIF-orders, blur-filters, and
   auto-enqueues a `lingbot-map-reconstruct` job (pose estimation runs server-side).
5. Poll `GET /worlds/default/jobs` for that `jobId` until `status` is `completed` or `failed`.
6. The completed job's artifact exposes `pointCloudUrl: /sessions/{sessionId}/lingbot-map.point-cloud.ply`
   and `posesUrl: .../lingbot-map.poses.json`.

**Correction to a common assumption:** this pipeline's real end artifact is a point cloud /
gaussian splat (`.ply`/`.sog`), not a GLTF — a `.glb` only exists as an optional lossy sidecar
(`lingbot_map_glb.ts`) or as the *separate*, unrelated `pipeline.ts` (which optimizes a
pre-existing mobile-exported `.glb`, not something this pipeline produces). A full gaussian splat
is a further, manually-enqueued `splat-train` job — worth doing, but 9 sparse gridded photos is
thin input for 3DGS quality; the point cloud is the realistic fast result from one run.

This whole sequence is inherently cross-MCP-server (gimbal moves from `osmo-gimbal`, photos from
an `android-*` server, ingest via a plain HTTP call to this repo's own Deno server) — no single
tool call does all of it, since MCP servers can't call each other's tools. Whatever orchestrates
the loop (an interactive Claude Code session, or a script written against all three) is what
makes it "one call" in practice.

## Android capture device (MCP) setup

The Android device mounted in the gimbal cradle is driven the same way as this repo's other test
devices — via `danielealbano/android-remote-control-mcp`, an accessibility-service-based remote
control app running on-device, exposed as an HTTP MCP server over Tailscale.

**Registration** (already done for the known devices) — an entry per device in *both* this
project's [`.mcp.json`](../.mcp.json) and the user's global `~/.claude.json` `mcpServers` (so any
project/session can reach it, not just this one):
```json
"android-beam-pro-1": {
  "type": "http",
  "url": "http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp",
  "headers": { "Authorization": "Bearer ${ANDROID_MCP_TOKEN_BEAM_PRO_1}" }
}
```
The bearer token comes from `${ANDROID_MCP_TOKEN_BEAM_PRO_1}`, an env var sourced from
`~/.claude/settings.json`'s `env` block — **not** a project `.env` file, which Claude Code does
not auto-load for this purpose.

**When a device's MCP connection is down** (confirmed to happen mid-session — the exact failure
this section exists to cover): reconnecting the on-device app is necessary but not always
sufficient; Claude Code's own client-side connection to that server may also need re-establishing.
Troubleshooting order:
1. On the device itself: confirm the Android Remote Control MCP app is running/foregrounded (its
   own persistent notification, "MCP Server Running", should be present in the notification
   shade — if it's gone, the app process died and needs relaunching).
2. Confirm network reachability from this Mac: `tailscale ping <device>.capybara-ulmer.ts.net`.
3. From an interactive Claude Code session, reconnect the specific server via `/mcp` (or restart
   the session) — a session that failed to connect at startup does not necessarily keep retrying
   indefinitely on its own, and fixing the device side alone does not re-establish an already-
   failed session-level connection.

## Verification checklist (this integration's testing plan)

- **Backend + MCP proxy**: with `npm run backend` running and connected, call
  `mcp__osmo-gimbal__gimbal_move_to` directly and confirm it returns without erroring — **done,
  2026-08-21**.
- **Closed-loop convergence**: call `gimbal_move_to` with a nonzero target and confirm
  `converged: true` with a plausible `finalYaw`/`finalPitch`, not just "didn't error" — pending a
  live gimbal connection (dropped when editing `backend.mjs` restarted the `--watch` process, and
  the gimbal itself stopped advertising over BLE shortly after — check it's powered on/awake and
  in range, then `scan_devices` → `connect` again).
- **Dev-loop**: touch `subsystems/osmo-ble/protocol/commands.mjs` and confirm the watched backend
  restarts itself (its stdout prints the restart) — confirmed working, but note the restart drops
  the live BLE connection every time, requiring a reconnect after each code change.
- **Full pipeline**: run the 9-step grid-capture loop for real (closed-loop moves + real photo
  capture on the mounted Android device, not the relative-nudge rehearsal), confirm
  `/ingest-photos` returns 202 with a `jobId`, poll it to `completed`, and confirm the resulting
  point cloud actually looks room-shaped before calling a run successful.

## Open questions for a deeper integration

- Whether to move `osmo-gimbal` from local `stdio` to a Tailscale-exposed `http` MCP server to
  match the Android device entries in `.mcp.json`, so it's usable from any collaborator's
  session, not just the one Mac holding the physical gimbal.
- Whether `dwellMs` needs tuning against this project's actual `minDistanceM`/`minRotationDeg`
  thresholds (check `src/capture/auto-capture.ts` and `src/capture/keyframes.ts`) for the
  *passive* sweep path specifically — the grid-capture path above sidesteps this by using
  explicit photo capture instead.
- Whether closed-loop `gimbal_move_to`'s adaptive sign-flip actually converges cleanly on live
  hardware across the full grid range, or whether it needs a smarter controller (e.g. slowing
  down near the tolerance boundary instead of a flat bang-bang speed) — untested pending gimbal
  reconnection.
- Whether the gimbal dropping off BLE advertising mid-session (observed 2026-08-21, cause
  unconfirmed — battery/sleep timeout/handling) needs a documented wake procedure once understood.
