# Gimbal-driven capture (DJI Osmo Mobile 6)

[`subsystems/osmo-ble/`](../subsystems/osmo-ble/) controls a DJI Osmo Mobile 6 gimbal over
Bluetooth LE via reverse-engineered DUML commands, and exposes that control as an MCP server so
Claude Code (or any MCP client) can drive automated capture sweeps. It's vendored into this repo
(moved in from a standalone project on 2026-08-21) so a fresh clone gets the whole system in one
place — see the [root README's quick-setup section](../README.md#quick-setup) to get running.

**Status (2026-08-21):** protocol codec and pairing are verified against a real captured frame.
Gimbal speed-control's axis order/signs were live-verified against a real OM6 via the web UI
joystick and corrected in `subsystems/osmo-ble/protocol/commands.mjs`; absolute-angle moves got
the same fix by inference (same struct family) but haven't been independently live-tested yet.
The "mode" toggle (cmdId 0x44) is confirmed to be a portrait/landscape switch, not a real
lock/follow/fpv selector. The web control UI is a compact one-handed PWA matching CI-Common's
design tokens (`packages/tokens/src/tokens.css`, dark theme), with a live orientation readout, a
persistent command-coverage grid, and a structured frame inspector.

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

## `gimbal_sweep` / `gimbal_move_to`

`gimbal_sweep`: steps yaw from `startYawDeg` to `endYawDeg` in `stepDeg` increments, dwelling
`dwellMs` at each step — for driving a phone mounted in the gimbal through a passive scan sweep
(set `dwellMs` above the scanner client's auto-capture interval, 2.5s+, so each step registers as
a fresh capture). `gimbal_move_to`: the single-step primitive behind it, exposed on its own so a
caller can interleave a photo-capture tool call between steps (see below).

Other relevant tools: `get_orientation` (poll current facing), `gimbal_recenter`, `gimbal_nudge`
(interactive single move + auto-stop), `get_recent_frames` (raw telemetry), `plan_scan_grid` (see
below).

## Automated N-shot grid capture → Companion Scan's real ingest pipeline

For an *exact* photo count (e.g. "9 photos") rather than relying on auto-capture heuristics,
drive an explicit camera-capture tool instead — verified against this repo's actual capture→3D
pipeline, not invented:

1. `plan_scan_grid` (in `osmo-gimbal`, pure computation, no device needed) — returns a
   serpentine-ordered `yawCount x pitchCount` grid of absolute `(yawDeg, pitchDeg)` targets.
   Defaults to 3x3 = 9 targets, minimizing travel between consecutive steps.
2. For each target: `gimbal_move_to(yawDeg, pitchDeg)` — moves, dwells, and returns a
   before/after orientation delta so you know the step actually registered.
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
  `mcp__osmo-gimbal__gimbal_move_to` directly and confirm it returns a real `moved: true`/`false`
  verdict instead of erroring — proof the MCP-to-backend proxy actually works end to end.
- **Dev-loop**: touch `subsystems/osmo-ble/protocol/commands.mjs` and confirm the watched backend
  restarts itself (its stdout prints the restart).
- **Full pipeline**: run the 9-step grid-capture loop for real, confirm `/ingest-photos` returns
  202 with a `jobId`, poll it to `completed`, and confirm the resulting point cloud actually
  looks room-shaped (not degenerate/empty) before calling a run successful.

## Open questions for a deeper integration

- Whether to move `osmo-gimbal` from local `stdio` to a Tailscale-exposed `http` MCP server to
  match the Android device entries in `.mcp.json`, so it's usable from any collaborator's
  session, not just the one Mac holding the physical gimbal.
- Whether `dwellMs` needs tuning against this project's actual `minDistanceM`/`minRotationDeg`
  thresholds (check `src/capture/auto-capture.ts` and `src/capture/keyframes.ts`) for the
  *passive* sweep path specifically — the grid-capture path above sidesteps this by using
  explicit photo capture instead.
- Whether gimbal motion is confirmed to work over BLE-only on OM6 at all in every mode — medium
  confidence overall; speed-control is live-verified, absolute-angle is not yet.
