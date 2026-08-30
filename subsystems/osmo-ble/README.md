# Osmo BLE Control

A web app (Web Bluetooth) and an MCP server (Node/`noble`) for pairing with and sending basic
test commands to a DJI Osmo Mobile 6 over Bluetooth LE — no DJI SDK, no DJI Mimo app.

**There is no officially sanctioned way to do this.** DJI's current Mobile SDK (V5) has zero
Osmo Mobile support (aircraft-only). The old V4 SDK briefly supported "Osmo Mobile" and "Osmo
Mobile 2" over BLE but was never updated past 2020 and requires a developer account + signed
App Key + one-time internet activation — more friction than a local test app should need. This
project instead builds on community reverse-engineering of DJI's DUML protocol.

**Provenance caveat — read the confidence column, not the prose.** The research below started
as a synthesis of reverse-engineering for the Osmo Pocket 3 and Osmo Action 3/4/5 Pro, which
share DJI's Mimo app and (very likely) the same wire protocol. Since then a good deal of it
*has* been checked against a real Osmo Mobile 6, and some of the original guesses were wrong:

- **Verified against real hardware:** the frame codec and pairing (bit-exact against a captured
  frame, `protocol/duml.test.mjs`); the speed command's axis order and signs (live-verified via
  the web UI joystick and corrected in `protocol/commands.mjs`); the motors moving at all, which
  requires a **macOS Bluetooth bond** and not just the app's PIN flow.
- **Disproved against real hardware:** the absolute-angle opcode (`GIMBAL_ABS_ANGLE`, cmdId
  `0x14`) does nothing — an A/B test on one gimbal in one session gave delta 0.126 for a speed
  command and 0.0002 for an absolute-angle command. The "mode" toggle (`GIMBAL_SET_WORK_MODE`,
  cmdId `0x44`) behaves as a portrait/landscape switch, not the lock/follow/fpv selector the
  SDK-derived name in `protocol/constants.mjs` implies.
- **Still unconfirmed for this device:** the write-characteristic choice (see below), and the
  telemetry cmdSet.

The full integration record — including the closed-loop rewrite that replaced the dead
absolute-angle opcode, the mislabeled feedback axis, and the BLE-wedge and unbonded-gimbal
gotchas — lives in [`../../docs/operations/GIMBAL_INTEGRATION.md`](../../docs/operations/GIMBAL_INTEGRATION.md).
Treat that document as the current state of the hardware; this README covers the protocol.

## Quick start

```bash
npm install
npm run test:protocol   # DUML codec vs. a real frame, the dome/station planner, device resolution
npm run backend         # :8788 — the ONE process that owns the BLE connection (node --watch)
npm run web             # http://localhost:8787 — "Scanner Control" UI (Web Bluetooth or backend)
npm run cli -- grid --stations 4 --dry-run   # scripted capture runs against the backend
npm run mcp             # MCP server over stdio, for use with Claude Code / Claude Desktop
```

**`npm run backend` is the one to start first for anything real.** The MCP server and the web
UI's backend mode are both thin HTTP clients of it, deliberately, so exactly one process ever
holds a BLE connection to the single physical gimbal — and because a Claude-Code-spawned
subprocess cannot be granted Bluetooth by macOS at all. Run it in a real interactive terminal.
Full reasoning in
[`../../docs/operations/GIMBAL_INTEGRATION.md`](../../docs/operations/GIMBAL_INTEGRATION.md).

**First run on macOS:** the first time `npm run mcp` accesses Bluetooth, macOS will show a
permission prompt for Terminal/Node under *System Settings → Privacy & Security → Bluetooth*.
Grant it, then re-run. If it hangs instead of prompting, it's very likely running without a
window session to show that prompt in (this happened when testing headlessly during
development) — run it from a normal interactive Terminal window, not a background/CI-style
shell.

**Web app requirement:** Web Bluetooth only works in Chrome/Edge (not Safari/Firefox), and only
over a secure context — `http://localhost` counts, plain `file://` does not, hence the tiny
static server in `web/server.mjs`.

## Multi-station capture — the scan that actually reconstructs

This gimbal is a third capture path for CI-Spatial, beside 8th Wall SLAM and native WebXR: a
tripod stands still, the gimbal sweeps a dome from that spot, the operator picks the tripod up
and carries it somewhere else, and it sweeps again. No AR runtime, no SLAM, no ARCore. That
matters because the test phone (XREAL Beam Pro) has no ARCore at all, so WebXR is permanently
dead on it, and 8th Wall's SLAM has been observed starting about two attempts in eight.

**The pause between domes is the entire capture.** Measured on real COLMAP runs over this
rig's own frames:

| capture                          | images registered | verdict                    |
| -------------------------------- | ----------------- | -------------------------- |
| single dome, rotating in place   | 3 / 17            | **degenerate**             |
| 5 stations × a dome each         | 36 / 36           | ready — 9,914 points       |
| continuous walkthrough           | 48 / 48           | ready                      |

A dome swept from one spot is pure rotation. The optical centre never moves, so there is no
translational baseline anywhere in the capture and monocular structure-from-motion has nothing
to triangulate. The parallax comes from the tripod moving *between* stations — this is ordinary
multi-station photogrammetry, the same principle as registering terrestrial laser scans from
several setups. The 36/36 run used 5 stations spread across a 6 × 4.4 m room as a rough ring
plus a centre point: deliberately **not collinear**, because stations in a line share one
baseline direction and reintroduce a degeneracy of their own.

So `stations: 1` is not a smaller capture, it is a capture of nothing, and every surface here
says so rather than reporting a successful run: the CLI exits non-zero, the web UI's summary
line warns before you press Run, and the `done` event carries `usable: false` with the reason.

### The reachable pan arc

The OM6 **cannot rotate through the front.** Its pan travels from roughly **+82° round through
180° to about −100°** — a 178° arc, with the ~182° spanning the front unreachable. Driving a
move into that stop does not error: the gimbal twitches against the limit and springs back
while the controller holds a speed command against it, which is exactly the condition that
thermally shut a real unit down on 2026-08-26 (a jam closes ~0.65° in 11 s where a healthy move
closes ~31° in 7.8 s; see `protocol/stall.mjs`).

A plan that crosses the dead zone is therefore a bug in the plan, not an operator error, and it
is made unplannable rather than detected at position 14 of 105:

- `protocol/dome.mjs` plans a dome as a **centre and a width** clamped to the arc, never a
  `-x..+x` pair — that spelling is how the dead zone used to get requested. The default is 150°
  centred on 171° (straight back), which is what the 36/36 capture swept and leaves 14° of
  margin at each stop.
- `POST /api/grid-capture` **refuses** an explicit `pans` list containing an unreachable column,
  with a 400 naming the columns and how far past the stop each one is.
- The web UI's pan from/to is read *along* the arc, so `96 → -114` sweeps 96 → 180 → −114 rather
  than numerically through 0, and the Run button is disabled while any column is in the dead
  zone.
- The old shipped `Dome` preset was `-150..150` step 30: **6 of its 11 columns were inside the
  stop.** Those numbers are kept as a regression fixture in `protocol/dome.test.mjs`.

Tilt has measured stops too — it converges down to about −40° but jams near +16° — and is
range-checked the same way.

### Configuring the phone it drives

Only needed for the modes where **this backend takes the photos** — `POST /api/capture-photo`,
the web UI's quick-shot buttons, and `grid-capture` without `--movement-only`. A movement-only
sweep never touches the phone (the scanner web app captures its own pose-tagged keyframes) and
needs none of this.

The phone in the cradle runs `android-remote-control-mcp`, and **its bearer token is per
device** — every phone runs its own server with its own token, which is why the repo has
`ANDROID_MCP_TOKEN_TAB_S8_ULTRA`, `_TAB_S9_ULTRA`, `_BEAM_PRO_1`, `_BEAM_PRO` and not one
shared value. The backend already knows where each phone lives: the repo's `.mcp.json` lists
every device as `android-<name>` with its URL and, in its `Authorization` header, the *name* of
the variable holding that device's token. So the whole configuration is one variable:

```bash
# In the shell that starts `npm run backend` (or in the repo's .env — see below).
export ANDROID_MCP_TOKEN_BEAM_PRO_1=...   # from that phone: Settings → Access
export ANDROID_MCP_DEVICE=beam-pro-1      # only needed if several phones have tokens set
```

Check it before the rig is on a tripod in the middle of a room:

```bash
curl -s localhost:8788/api/capture-device | jq
# { "configured": true, "device": "beam-pro-1",
#   "url": "http://beam-pro-1.<tailnet>.ts.net:8080/mcp",
#   "tokenEnv": "ANDROID_MCP_TOKEN_BEAM_PRO_1",
#   "urlSource": ".mcp.json android-beam-pro-1 (the only device with ANDROID_MCP_TOKEN_BEAM_PRO_1 set)" }
```

That endpoint reports the variable's **name**, never its value; no token is ever put in a
response, an NDJSON progress event, a manifest, or an error message.

Resolution order, highest first:

| | URL | Token |
| --- | --- | --- |
| 1 | `deviceUrl` in the request body (`--device-url`) | `deviceToken` in the body (`--device-token`) |
| 2 | `ANDROID_MCP_URL_<DEVICE>` | `ANDROID_MCP_TOKEN_<DEVICE>` for the named device |
| 3 | `.mcp.json`'s `android-<device>` entry | the variable that entry's `Authorization` header names |
| 4 | `ANDROID_MCP_URL` | `ANDROID_MCP_TOKEN` (single-phone shortcut; a per-device token always wins) |

Which device, when none is named: `ANDROID_MCP_DEVICE`, else the single `.mcp.json` device that
has a token set. **Several with tokens and no choice made is refused**, not guessed — driving
the phone on the desk instead of the one in the cradle produces a capture that looks fine until
someone opens the photos. Pass `--device beam-pro-1` (or `{"device": "beam-pro-1"}`) to choose
per run.

Tokens are read from the process environment first, and from the repo's `.env` as a fallback
(`ANDROID_MCP_*` names only, nothing is exported into the environment, a real environment
variable always wins). That fallback exists because on 2026-08-29 a six-column dome had to be
shuttled photo-by-photo by hand while `capture-photo` insisted `deviceToken is required` — the
token was in `.env` and the URL in `.mcp.json` the whole time, and the backend read neither.
Point them elsewhere with `ANDROID_MCP_CONFIG` / `ANDROID_MCP_ENV_FILE`, or set
`ANDROID_MCP_ENV_FILE=''` to ignore the file. With nothing configured a capture is still
refused outright, with a remediation naming the exact variable to set.

One thing configuration cannot fix: the phone caps concurrent MCP clients and answers `503
"Too many active sessions"` when it is full. **A Claude Code session attached to that phone
holds one of those slots** — detach it before a capture run.

### The flow

```bash
# Plan first; nothing moves.
npm run cli -- grid --stations 4 --dry-run

# Movement-only: the phone's scanner web app captures its own pose-tagged keyframes, and those
# VIO poses are metric, which is the only thing that gives the reconstruction a true scale.
npm run cli -- grid --stations 4 --movement-only --out ./scan-kitchen
```

For each station the backend sweeps the dome, then stops dead and waits:

```
── station 1/4 (station-01) ──
   1: pan=144.3 tilt=1.6  converged (12 ticks)
   ...
  station 1: 3/3 converged

  MOVE THE TRIPOD to station 2 of 4.
  Press Enter when it is down and level (Ctrl-C to stop here — the stations already captured are complete).
```

Confirm in whichever surface you have to hand — they are the same state, not three copies of
it:

- the CLI's Enter prompt (or `curl -XPOST :8788/api/grid-advance` when it is not a terminal),
- the web UI's **"I've moved it — continue"** button, which reappears after a page reload or a
  sleeping phone because the pause is reported in `GET /api/status` as `awaitingStation`,
- `POST /api/grid-advance` directly.

What the pause guarantees, for a wait of any length:

- **Motors are not latched.** The speed command is a latch, not a pulse, and the operator is
  about to pick the rig up — so the backend stops the motors before parking and again on every
  5-second heartbeat. Verified on hardware: the reported orientation is bit-stable across the
  whole pause.
- **The BLE link is not assumed.** Each heartbeat re-exercises it and reports `linkUp`, and
  `/api/grid-advance` refuses with a 409 if the link died while parked — while the operator is
  still standing at the gimbal, rather than as a wall of non-converged positions afterwards.
- **The HTTP stream keeps flowing.** A multi-minute silence on the NDJSON response reads as a
  hung connection to undici's own idle timeout, which is what killed two real runs before
  per-position streaming existed.
- **The manual controls come back.** The scan interlock that rejects joystick/recenter commands
  mid-sweep (two controllers fighting for two motors) is lifted while parked, because no
  controller is running. Confirmed on hardware: 409 during a sweep, 200 while parked.
- **It is bounded at 30 minutes.** Far past any real station move, but a run that parks forever
  holds the gimbal and can only be recovered by restarting the backend. An expiry ends the run
  as a *partial* capture, never as a completed one.

### A partial run is still a capture

Stopping after 3 of 5 stations must leave three whole domes, not a half-written directory:

- The CLI writes `manifest.json` **after every frame and every station**, so at any instant the
  directory describes itself — which stations exist, which frames belong to which, and whether
  the run had finished. Photos land in one subdirectory per station.
- Every frame carries its station on the wire and in its filename. "Which station was bad" is
  the first question when a solve comes back short, and a bare running index cannot answer it.
- `POST /api/grid-stop` while parked ends the run on a clean seam — a whole number of domes —
  and says so, rather than aborting mid-sweep.
- The verdict comes from one place (`assessCapture` in `protocol/dome.mjs`) for every consumer.
  `complete` means every planned station was swept; **`usable`** means it can be reconstructed,
  and it is false for a single station however many positions converged, false when nothing
  converged, and false when nothing was captured. The CLI's exit code is `usable && complete`.

## Registering the MCP server

For Claude Code / Claude Desktop, point an MCP config entry at:
```json
{
  "mcpServers": {
    "osmo-ble": { "command": "node", "args": ["/absolute/path/to/osmo-ble/server/mcp-server.mjs"] }
  }
}
```

### Remote access over Tailscale (HTTP transport)

`server/mcp-server.mjs` defaults to stdio (above) but also supports Streamable HTTP, for
registering it remotely the same way this project's other MCP servers (`android-tab-s8-ultra`
etc.) are — useful if you want to drive the gimbal from a machine other than the one it's
plugged into over BLE.

Start it with `--http` (or `MCP_TRANSPORT=http`) instead of the bare `npm run mcp`:
```bash
OSMO_MCP_TOKEN=<a-long-random-secret> node server/mcp-server.mjs --http
```

It binds all interfaces (like `server/backend.mjs`), so it's reachable over Tailscale as soon as
it's running. Env vars:

| Var | Default | Purpose |
|---|---|---|
| `OSMO_MCP_HTTP_PORT` | `8789` | Port to listen on (`8787` is `web/server.mjs`, `8788` is `server/backend.mjs`) |
| `OSMO_MCP_TOKEN` | *(required)* | Bearer token clients must send; the server refuses to start without one, since this port is reachable by anyone on the tailnet |

Every request to `/mcp` is checked against `Authorization: Bearer <OSMO_MCP_TOKEN>` before it
ever reaches the MCP transport — missing or wrong tokens get a `401` and nothing else.

Register it remotely the same way as the `android-*` entries:
```json
{
  "mcpServers": {
    "osmo-gimbal": {
      "type": "http",
      "url": "http://<this-machine>.<tailnet>.ts.net:8789/mcp",
      "headers": { "Authorization": "Bearer ${OSMO_MCP_TOKEN}" }
    }
  }
}
```

The stdio registration (`"command": "node", "args": [...]`) and the HTTP one are independent —
run whichever transport matches how you're registering it; both share the same BLE connection
logic and tool set.

Includes `gimbal_sweep`, `gimbal_move_to`, `plan_scan_grid` and `get_orientation` tools built for
driving automated capture sweeps — the intended use case is mounting a phone in the gimbal to
drive an external scanning client through a room, without that client needing any awareness of
the gimbal at all (see below). Positioning is **closed-loop** (speed corrections against live
telemetry) because the absolute-angle opcode is dead: always check `converged` in the result
rather than assuming a call that returned without erroring reached its target.

### As a subsystem for CI-Spatial

This lives at `subsystems/osmo-ble/` inside the CI-Spatial repo as its gimbal-control
subsystem — registered via the repo root's `.mcp.json`, with the integration contract documented
in `../../docs/operations/GIMBAL_INTEGRATION.md`. Key finding from that integration: CI-Spatial's scanner
client auto-captures purely off the phone's own tracked movement (distance/rotation thresholds),
so no signaling between this subsystem and the scanner client is needed for a basic sweep —
physically moving the phone via `gimbal_sweep` is sufficient on its own. For an exact photo
count instead, the backend orchestrates the whole run itself — `POST /api/grid-capture`, driven
by `npm run cli -- grid` or the web UI's **Run scan**, moving the gimbal and taking each photo
on the phone before feeding CI-Spatial's own `/ingest-photos`. See `GIMBAL_INTEGRATION.md`'s
grid-capture section.

**One thing to know before expecting 3D out of it:** a gimbal turning in place gives
structure-from-motion no parallax, so COLMAP cannot solve poses from a single-station grid —
measured on this rig at 29 of 36 image pairs classified `PLANAR_OR_PANORAMIC`. That constraint
and what to do about it are documented in `GIMBAL_INTEGRATION.md` and
`../../docs/pipelines/colmap-poses.md`.

## Layout

```
protocol/          shared codec — pure JS, runs unmodified in both Node and the browser
  duml.mjs            DUML frame encode/decode, CRC8/CRC16, notify-stream reassembly
  duml.test.mjs        validates the codec against a real captured frame — run this first
  stall.mjs            jam/wedge detection, per tick and per position (tested from real telemetry)
  dome.mjs             the reachable pan arc, dome planning, and the "is this a capture?" verdict
  dome.test.mjs        the arc and the COLMAP registration rates, as assertions
  device_registry.mjs  which phone to drive and which per-device token variable holds its
                       key — pure resolution over .mcp.json + the environment
  device_registry.test.mjs  the precedence table, the refusals, and "no refusal leaks a token"
  constants.mjs        BLE service/characteristic UUIDs, DUML component/cmdSet/cmdId constants
  commands.mjs          command builders (pairing, gimbal recenter/mode/nudge, raw/RE escape hatch)
  telemetry.mjs         decoders for the orientation frames the gimbal streams at 10-20Hz
                        (quatToEulerDeg, quatToGimbalControlDeg — the closed-loop feedback)
  phone_telemetry.mjs   wire shape for the PHONE's compass/tilt/GPS, relayed over the backend's
                        /ws — displayed alongside gimbal telemetry, never averaged into it
server/
  ble-transport.mjs      Node BLE transport (@stoprocent/noble): scan, connect, pair, write-char fallback
  backend.mjs             the single BLE owner: HTTP + /ws, closed-loop move-to, multi-station
                          capture (sweep a dome -> park for the tripod move -> sweep the next)
  android-capture.mjs     minimal MCP-over-HTTP client for the phone in the cradle (photo capture)
  device-config.mjs       finds .mcp.json and .env and feeds protocol/device_registry.mjs, so a
                          capture needs no token pasted into its request body
  cli.mjs                 scripted runs against the backend (scan/connect/grid/…); writes the
                          per-station output directory and its incremental manifest.json
  mcp-server.mjs          MCP server exposing it all as tools — an HTTP client of backend.mjs
web/                 "Scanner Control" PWA — two pathways, direct Web Bluetooth and backend
  index.html            markup + styles for both pathways
  app.mjs                 direct Web Bluetooth client, sharing protocol/* with the Node side
  backend-client.mjs      backend pathway: scan presets (planned along the reachable arc),
                          station count, the between-station prompt, the scan-in-progress lock
  orientation.mjs         compass dial + tilt gauge rendering
  joystick.mjs            virtual joystick (mouse/touch/arrow keys), shared by both pathways
  coverage.mjs            persistent cmdSet:cmdId coverage grid — "what have I actually tried"
  frame-log.mjs           structured, filterable TX/RX frame inspector
  ui.mjs                  tabs, settings drawer, connection dot
  manifest.json / sw.js / icon.svg   PWA install + offline shell
  server.mjs               zero-dependency static file server (for the localhost requirement)
```

## Protocol notes

### Framing (DUML) — high confidence, verified

```
offset  size  field       encoding    notes
0       1     magic       —           always 0x55
1       1     len_lo      —           low 8 bits of a 10-bit total length
2       1     ver/len_hi  —           bits[0:1]=length hi bits, bits[2:7]=version(=1) — 0x04 for payload<243B
3       1     hdr_crc8    —           CRC8 over bytes[0:3)
4       1     sender      —           component id (App=0x02, Camera=0x01, WiFi=0x07, ...)
5       1     receiver    —           component id
6-7     2     msgId       BIG-ENDIAN  sequence/transaction id
8       1     flags       —           0x00 notify, 0x40 request, 0x80 response, 0xC0 response-to-request
9       1     cmdSet      —           command group
10      1     cmdId       —           command within the group
11..N   N     payload     —           N = totalLength - 13
N+11    2     crc16       LITTLE-ENDIAN
```

- **CRC8** (header): `poly=0x31 init=0xEE xorout=0x00 refin=true refout=true`
- **CRC16** (whole frame minus its own trailer): `poly=0x1021 init=0x496C xorout=0x0000 refin=true refout=true`
  (this is *not* the standard CCITT-FALSE preset despite some libraries naming it that — the
  nonstandard init value matters, don't substitute a generic library default)
- **PackString** (PIN/identifier/SSID fields): `[1-byte length][utf8 bytes]`

Cross-verified identically by three independent implementations in three languages
(node-osmo/TS, lib-osmo-ble/JS, djictl/Go), and confirmed bit-exact against a real captured
`SetPairingPIN` frame in `protocol/duml.test.mjs`.

### BLE service/characteristics — write characteristic is unconfirmed for this device

Service: `0xfff0`. Four characteristics may be present: `fff0`, `fff3`, `fff4`, `fff5`.

| Role | Characteristic | Confidence |
|---|---|---|
| Notify (telemetry, acks) + pairing trigger | `fff4` | Consistent across sources |
| Write (DUML commands) — primary | `fff5`, write-without-response | Wireshark-verified vs. real Mimo traffic, on Osmo Pocket 3 |
| Write (DUML commands) — fallback | `fff3`, write-with-response | Older/other-model behavior; one source explicitly says fff3 "may work on Osmo Mobile" |

The code tries `fff5` first and falls back to `fff3`, latching whichever the device actually
responds on. This is the single biggest known unknown for Osmo Mobile 6 specifically — the two
best sources disagree about which characteristic real hardware accepts, split exactly along
product-line lines.

### Pairing — no encryption, PIN-confirmation only

1. Write `[0x01, 0x00]` to `fff4` to enter pairing mode.
2. Wait ~1s.
3. Send `SetPairingPIN` (sender=App, receiver=WiFi, cmdSet=0x07, cmdId=0x45), payload =
   `packString(identifier) + packString(pin)`.
4. **The PIN, when one appears, is device-generated — it is not a fixed default.** Every
   hardcoded PIN found in the source repos (`"love"`, `"5160"`) was a leftover development
   default from someone else's device, not a real secret to reuse. Don't assume it appears on the
   gimbal's own screen, though: on real hardware this has surfaced as a *macOS* Bluetooth
   confirmation dialog instead, and on Linux/BlueZ, as of 2026-08-26, neither a device-screen PIN
   nor a BlueZ agent prompt has been observed at all after `pair_trigger`. See the pairing gotcha
   in [`GIMBAL_INTEGRATION.md`](../../docs/operations/GIMBAL_INTEGRATION.md) for the live findings
   — this file only pins down the wire protocol, not what your OS actually shows you.
5. Response payload byte: `0x01` = already paired, `0x02` = pairing required (wait for user
   approval on the device).

No AES, no signature, no key exchange anywhere in any of the four technical sources reviewed —
confirmed by grepping all of them for encrypt/aes/signature/auth/nonce/token.

### Commands implemented — and what's deliberately missing

| Command | Confidence | Source |
|---|---|---|
| Pairing (`pair()` / Pair button) | High (byte-verified) | lib-osmo-ble, djictl, xaionaro capture |
| Gimbal speed nudge (`gimbal_nudge`) | **High — the one motion command confirmed to move real hardware.** Axis order and signs were live-verified via the joystick and corrected | lib-osmo-ble + live OM6 |
| Gimbal absolute angle (cmdId `0x14`) | **Disproved — does nothing on an OM6.** A/B tested against a speed command in the same session | live OM6 |
| Gimbal recenter (`gimbal_recenter`) | Rewritten: no longer an absolute-angle write (that opcode is dead). Now a closed-loop move to (0,0) on top of the speed command — and "0,0" is wherever this device's quaternion frame reads zero, not confirmed mechanical centre | live OM6 |
| Gimbal mode (`gimbal_set_mode`, cmdId `0x44`) | Reaches the device, but behaves as a **portrait/landscape switch**, not the lock/follow/fpv selector the SDK name implies | live OM6 |
| Battery/telemetry (`get_recent_frames`) | Low-medium, passive only — no query command exists, sources disagree on exact cmdSet | node-osmo, lib-osmo-ble |
| **Shutter / photo trigger** | **Not implemented** — zero byte-level data in any source | — |
| **Record start/stop** | **Not implemented** — one unused constant exists (djictl), never wired to a payload | — |

Osmo Mobile 6 has no onboard camera — it clamps a phone. The real Mimo app almost certainly
relays the gimbal's physical shutter *button press* to the phone as a notification, rather than
accepting a "take photo" command sent *to* the gimbal the way a Pocket 3 does. Guessing at that
without a capture risks sending an unknown command to the device for no benefit, so it's left
out. If you want it: capture your own Mimo↔OM6 BLE traffic (`adb bugreport bt-logs` while using
Mimo on Android, pull `FS/data/misc/bluetooth/logs/btsnoop_hci.log`, open in Wireshark) and look
for what fires when you press the physical shutter button — that's the fastest path to a real
answer, much faster than guessing from a different product's opcodes.

**Answered:** lib-osmo-ble's authors found gimbal-motion commands accepted with no error but
possibly not moving the motors over BLE alone on a Pocket 3, and suspected an active
WiFi/streaming session was required. On an OM6 that is **not** the blocker — the motors do move
over plain BLE. The real precondition is a **macOS Bluetooth bond**: unbonded, the gimbal
honours roughly one motor command per connection and then silently ignores everything after it,
at every tick duration and settle gap tried, which looks exactly like a protocol or timing bug
and was investigated as one at length. `POST /api/pair-trigger` surfaces the *OS* confirmation
dialog that creates the bond; the `SetPairingPin` handshake here is a different mechanism and
was never the missing piece. Note `paired: false` in `/api/status` does not tell you — that flag
is `ble-transport.mjs`'s own latch, not the OS bond state.

### Advanced / reverse-engineering escape hatch

Both the MCP server (`send_raw_command`) and the web UI ("Raw command" panel) let you send an
arbitrary `cmdSet`/`cmdId`/payload-hex frame and watch the response in the log — useful for
probing anything not covered above. Use deliberately, one frame at a time, watching what comes
back.

## Sources

- [datagutt/node-osmo](https://github.com/datagutt/node-osmo) — Osmo Action 3/4/5 Pro + Pocket 3, TS/noble. Low relevance (no gimbal commands) but confirmed the base frame shape.
- [yigitkonur/lib-osmo-ble](https://github.com/yigitkonur/lib-osmo-ble) — Osmo Pocket 3, JS/noble. The strongest source: Wireshark-verified against real Mimo traffic, includes gimbal motion commands.
- [xaionaro/reverse-engineering-dji](https://github.com/xaionaro/reverse-engineering-dji) — raw Wireshark captures + dissector plugin, Osmo Pocket 3. Ground truth for the frame shape.
- [xaionaro-go/djictl](https://github.com/xaionaro-go/djictl) — Go, actively maintained, tested. Confirms CRC params and pairing flow independently.
- [fvantienen/dji_rev](https://github.com/fvantienen/dji_rev) — firmware-image tooling, unrelated packet format. Not relevant to live BLE control.
- DJI official Mobile SDK (iOS/Android V5, legacy V4) — confirmed no viable officially-sanctioned path for a modern Osmo Mobile gimbal.
