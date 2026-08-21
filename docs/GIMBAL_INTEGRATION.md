# Gimbal-driven capture (DJI Osmo Mobile 6)

A standalone subsystem — [`osmo-ble`](/Users/liam/devel/device-firmware-diag/osmo-ble/) — controls
a DJI Osmo Mobile 6 gimbal over Bluetooth LE via reverse-engineered DUML commands, and exposes
that control as an MCP server so Claude Code (or any MCP client) can drive automated capture
sweeps. It lives outside this repo as its own project; this doc covers how it plugs in here.

**Status (2026-08-21):** protocol codec and pairing are verified against a real captured frame.
Gimbal speed-control's axis order/signs were live-verified against a real OM6 via the web UI
joystick and corrected in `protocol/commands.mjs`; absolute-angle moves got the same fix by
inference (same struct family) but haven't been independently live-tested yet. The "mode"
toggle (cmdId 0x44) is confirmed to be a portrait/landscape switch, not a real lock/follow/fpv
selector. The web control UI was reworked into a compact one-handed PWA matching CI-Common's
design tokens (`packages/tokens/src/tokens.css`, dark theme), with a live orientation readout,
a persistent command-coverage grid, and a structured frame inspector replacing the old scrolling
text log. See that project's README for the full protocol writeup.

**Known gotcha, still open as of this doc:** code fixes to `osmo-ble` only take effect once the
long-running processes that loaded them are restarted — Node doesn't hot-reload modules, and
this has caused more than one "the fix isn't working" report that was actually just a stale
process. Two independent things can be stale at once: the standalone `server/backend.mjs` HTTP
process (restart with `npm run backend` in a real terminal — see the Bluetooth gotcha below), and
the `osmo-gimbal` MCP server subprocess Claude Code itself spawned (reconnect via `/mcp` in an
interactive session, or restart the session, to pick up new/changed tools).

## Why no signaling is needed

The scanner client (`index.html` + `src/capture/*`, `src/ar/*`) never needs to be told a scan
is happening from outside — it already captures purely off the phone's own tracked movement:

- **Auto-capture** (`src/capture/auto-capture.ts`) polls pose ~every 400ms and fires whenever
  the camera has moved ≥0.35m (default) and ≥2.5s has passed since the last capture.
- **Keyframe streaming** (`src/capture/keyframes.ts`) fires on ≥minDistanceM movement or
  ≥minRotationDeg rotation, polled ~every 350ms.

So mounting the phone in the Osmo Mobile 6 and running a gimbal sweep is, from the scanner
client's perspective, indistinguishable from a human moving the phone by hand — no API call,
room signal, or new code path into `index.html` is required for a basic integration. The
gimbal subsystem and the scanner client don't need to know about each other at all for the
simplest version of this to work.

The one loose coordination point that already exists, if you want it later: the Deno server
relays WebRTC signaling by `room` (`main.ts`, `rtcRooms: Map<string, {phone?, viewer?}>`) and
fires `peer-ready` once both a phone and a viewer are connected to the same room — an
orchestrator could poll or subscribe to that to know when it's safe to start a sweep, but
nothing in the gimbal subsystem depends on it today.

## Setup

1. Physically clamp the phone into the Osmo Mobile 6, running the scanner page (e.g.
   `npm run qr -- "/scanner.html?world=default"` to get it onto the phone, per
   [DEVICE_TESTING.md](DEVICE_TESTING.md)).
2. Register the MCP server for this project — already done via an `osmo-gimbal` entry in
   [`.mcp.json`](../.mcp.json) at the repo root, alongside the existing Android test-device
   entries. Claude Code picks this up automatically when working in this project. First run
   needs Bluetooth granted to the Node process from a normal (non-automated) terminal session —
   see that project's README for the exact gotcha.

   **Convention mismatch, worth resolving later:** the existing `.mcp.json` entries
   (`android-tab-s8-ultra` etc.) are all remote `http` servers reachable over Tailscale, which
   lets any collaborator's Claude Code session reach those devices from anywhere. `osmo-gimbal`
   is registered as a local `stdio` server instead — an absolute path on one specific Mac — so
   only Claude Code sessions running on that machine can use it. This is because the gimbal is
   a passive BLE peripheral with no onboard compute (unlike the Android tablets, which run their
   own MCP endpoint locally and expose it over Tailscale) — the control server has to run on
   whatever machine holds the live BLE connection. Wrapping `osmo-ble`'s MCP server in an HTTP
   transport exposed over Tailscale (matching the Android pattern) would let it be triggered
   from any collaborator's session, not just locally — worth doing once gimbal motion itself is
   confirmed working, not before.
3. From a Claude Code session in this project: `scan_devices` → `connect` → `pair` (PIN is
   shown on the gimbal's own screen) → then `gimbal_sweep` to drive a capture pass.

## `gimbal_sweep`

The tool built specifically for this use case (in `osmo-ble/server/mcp-server.mjs`): steps yaw
from `startYawDeg` to `endYawDeg` in `stepDeg` increments, dwelling `dwellMs` at each step
before moving on. Set `dwellMs` comfortably above the scanner client's auto-capture interval
(2.5s+ by default, see above) so each step actually registers as a fresh capture point rather
than motion blur mid-move. Returns the orientation quaternion sampled at each step (from the
gimbal's own telemetry, not the phone's SLAM pose) so you can confirm the gimbal actually moved.

Other relevant tools: `get_orientation` (poll current gimbal facing without waiting on a
sweep), `gimbal_recenter`, `gimbal_nudge` (interactive single move + auto-stop),
`get_recent_frames` (raw telemetry, useful for reverse-engineering anything undocumented).

## Automated N-shot grid capture (deterministic alternative to auto-capture)

The passive auto-capture approach above is fine for a rough sweep, but it depends on tuning
`minDistanceM`/`minRotationDeg` against `dwellMs` to reliably get one capture per step rather than
0 or 2+ (see the open question below) — for a call that wants an *exact* count (e.g. "9 photos"),
drive an explicit camera-capture tool instead of relying on the scanner client's own heuristics:

1. `plan_scan_grid` (in `osmo-gimbal`, pure computation, no device needed) — returns a
   serpentine-ordered `yawCount x pitchCount` grid of absolute `(yawDeg, pitchDeg)` targets
   across given ranges. Defaults to 3x3 = 9 targets, minimizing travel between consecutive steps.
2. For each target: `gimbal_move_to(yawDeg, pitchDeg)` (in `osmo-gimbal`) — moves, dwells, and
   returns a before/after orientation delta so you know the step actually registered.
3. Immediately after each move: a photo-capture tool call on whichever Android device is
   physically mounted in the gimbal cradle — `android_take_camera_photo` (returns base64 JPEG,
   capped at 1920x1080) or `android_save_camera_photo` (writes straight to a storage location on
   that device) on that device's MCP server (e.g. `android-beam-pro-1`).

This is inherently a cross-MCP-server sequence (gimbal moves come from `osmo-gimbal`, photos from
an `android-*` server) — no single tool call does both, since MCP servers can't call each other's
tools. Whatever orchestrates the loop (an interactive Claude Code session, or a script written
against both servers) is what makes it "one call" in practice.

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
   indefinitely on its own.

## Open questions for a deeper integration

- Whether to move `osmo-gimbal` from local `stdio` to a Tailscale-exposed `http` MCP server to
  match the Android device entries in `.mcp.json` (see the callout above).
- Whether `dwellMs` needs tuning against this project's actual `minDistanceM`/`minRotationDeg`
  thresholds (check `src/capture/auto-capture.ts` and `src/capture/keyframes.ts` for current
  values) to reliably trigger one capture per sweep step rather than 0 or 2+.
- Whether an orchestrator script coordinating both sides (start sweep + confirm capture count
  increased) is worth building, versus just running sweeps and checking scan quality after.
- Whether gimbal motion is confirmed to work over BLE-only on OM6 at all — flagged as the
  biggest open risk in the osmo-ble project; test with `get_orientation` before/after a command
  to check for a real orientation delta.
