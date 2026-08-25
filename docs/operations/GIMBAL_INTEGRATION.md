# Gimbal-driven capture (DJI Osmo Mobile 6)

[`subsystems/osmo-ble/`](../../subsystems/osmo-ble/) controls a DJI Osmo Mobile 6 gimbal over
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

**Known gotcha — an unbonded gimbal ignores motor commands, and it looks like a code bug.**
Two separate problems presented as one symptom here on 2026-08-24, and the first was
misdiagnosed before the second was found. Both are now resolved; the sequence is recorded
because the *misdiagnosis* is the reusable lesson.

**Problem 1 — no macOS Bluetooth bond.** Before bonding, the gimbal honoured roughly one motor
command per connection and then silently ignored everything after it: `speed` at every tick
duration tried (250–900 ms), every settle gap tried (0–8 s), and `recenter` (a different command
type entirely) all left delta under 0.0002 — pure sensor noise, versus 0.02+ for anything that
actually moved. A plain `disconnect()`/`connect()` did not recover it. This looked exactly like
a protocol or timing bug, and was investigated as one at length. It was neither.

**Fix: pair the gimbal to macOS itself.** Running `POST /api/pair-trigger` (see below) surfaced
a *macOS* Bluetooth confirmation dialog — not the app's PIN flow. Accepting it created a real OS
bond, and the lockout vanished immediately: five consecutive `speed` commands all moved the
device, and reversing direction moved it freely at full delta. Note the device may show a plain
confirm rather than a PIN; the `SetPairingPin` handshake in `ble-transport.mjs` is a *different*
mechanism and was never the missing piece.

If motor commands go dead in this pattern, **check System Settings → Bluetooth for a bond before
touching any code.** `paired: false` in `/api/status` does not tell you — that flag is
`ble-transport.mjs`'s own heuristic (`this._paired = true // latch write channel regardless`),
not the OS bond state.

**Problem 2 — the closed-loop controller steered on a dead axis.** Even bonded, `move-to` still
ran to timeout. Measured directly: physical pan moves the `roll` channel, while `yaw` sits pinned
at exactly -90.00 ±0.05 regardless of how far the gimbal actually turns. `moveToClosedLoop` read
`yaw`, so its error never changed and it looped until `maxMs` with a flat history. Fixed by
steering on `quatToGimbalControlDeg`'s pan/tilt instead — see "Closed-loop positioning" below.

**The lesson worth keeping:** a gimbal that does not move has at least three unrelated causes
that look identical from the API — no OS bond, a wedged BLE stack (the 2026-08-23 entry above),
and a controller reading a channel that carries no information. A flat `history` array is
consistent with all three. Check the bond first (cheapest), then whether telemetry responds to a
raw `speed` probe at all, and only then suspect the control loop.

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
   [`.mcp.json`](../../.mcp.json) at the repo root (`{"command":"node","args":["subsystems/osmo-ble/server/mcp-server.mjs"]}`,
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

**Fixed 2026-08-24 — the feedback axis was wrong, and it never converged before this.** The loop
read `quatToEulerDeg().yaw`. Measured live on a mounted OM6, that channel is pinned at exactly
-90.00 ±0.05 no matter how far the gimbal pans; the physical pan lands in `roll` instead, while
tilt correctly lands in `pitch`. The two real axes are cleanly decoupled — tilting leaves roll
flat — they were simply mislabeled by a constant frame rotation. So the loop's error never
changed, its adaptive sign-flip had no gradient to work with, and every call ran to `maxMs`
reporting `converged: false` with a flat `history`.

Measurements, three equal pan nudges then three reversing:

```
start        pan(roll)=164.5   yaw=-90.00   tilt(pitch)=0.3
+pan x3      pan=144.8 -> 127.9 -> 105.7    yaw=-90.00 throughout
-pan x3      pan=123.1 -> 144.7 -> 164.2    yaw=-90.00 throughout
```

The loop now steers on `quatToGimbalControlDeg`'s pan/tilt (`protocol/telemetry.mjs`). Verified
after the fix: targets 140°, 165°, 130° and 150° all returned `converged: true` in 7–20 ticks,
landing within the 5° tolerance. `finalYaw`/`finalPitch` in the result are pan/tilt values — the
field names are kept for wire compatibility.

**Still check `converged` rather than assuming success**, and if a run does fail, read the
`history` array and confirm pan/tilt actually change between ticks. A flat history means the
gimbal is not moving at all (see the bond/wedge causes above), which is a different problem from
a move that merely fell short.

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

**The whole run is one command now.** The manual tool-by-tool sequence below still describes what
happens, and is what you want when driving it from an MCP client, but you no longer have to
orchestrate it by hand:

> **Verified end to end on real hardware, 2026-08-24.** One `npm run cli -- grid --ingest …`
> invocation: 9/9 positions converged (2–27 ticks each), 9 photos captured on the phone in the
> cradle, all 9 byte-distinct, `droppedBlurry: 0`, ingest job completed and the scan registered
> in the world as `status: ready`. The reconstruction itself reported its usual honest
> `skipped: No module named 'lingbot_map'` — that worker is not installed on this box. The CLI
> released the phone's MCP session on exit, confirmed by a fresh client being able to connect
> immediately afterwards.

```bash
npm run cli -- grid --dry-run                       # print the plan, touch nothing
npm run cli -- grid                                 # move -> photo at all 9 positions
npm run cli -- grid --ingest http://localhost:8000/ingest-photos
npm run cli -- grid --pans 100,130,160 --tilts -15,0,15 --out ./myscan
```

or press **Run grid capture** in the web UI (`npm run web`), which shows per-position progress
live. Both call `POST /api/grid-capture` on the backend, which is where the orchestration
actually lives — deliberately, so exactly one process ever holds an MCP session to the phone.

**Prerequisite — the phone's MCP URL and token:** set `ANDROID_MCP_URL` and `ANDROID_MCP_TOKEN`
in the *backend's* environment (the CLI can also pass `--device-url` / `--device-token`). The
per-device token variables in `.env.example` are the same values; see
[DEVICE_TESTING.md](../testing/DEVICE_TESTING.md) for the fleet table.

> **The phone caps concurrent MCP sessions, and a Claude Code session counts.** Verified
> 2026-08-24: with Claude Code attached to `android-beam-pro-1`, every backend `initialize`
> returned `503 {"error":"Too many active sessions"}`. There is no way around it — probing the
> device with a valid token showed that apart from `/mcp`, `/health` and the `/s/<hash>` share
> URLs, every path 404s, so MCP is the only control interface and there is no REST fallback.
> The backend therefore opens a session, runs the grid, and `DELETE`s it, holding the slot only
> for the duration of a capture — but it still cannot run while another client is attached.
> **Detach the phone's MCP server in Claude Code before running a grid capture from the CLI or
> web UI.**

A non-converged position is recorded, not fatal — the photo is still taken and the result
carries `converged: false`. Aborting would throw away the frames already captured, and a frame
from a position that is merely close is usually still usable; the caller decides.

The CLI also checks that the downloaded frames are byte-distinct and warns if they are not.
That is not a formality: wave 04 hit a stalled camera returning six byte-identical JPEGs across
47 minutes, and nothing notices unless something compares them.

### The underlying sequence

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
(`server/lingbot-map/lingbot_map_glb.ts`) or as the *separate*, unrelated `server/pipeline.ts` (which optimizes a
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
project's [`.mcp.json`](../../.mcp.json) and the user's global `~/.claude.json` `mcpServers` (so any
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
