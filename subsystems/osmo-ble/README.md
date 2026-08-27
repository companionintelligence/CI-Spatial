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
npm run test:protocol   # verifies the DUML codec against a real captured frame
npm run backend         # :8788 — the ONE process that owns the BLE connection (node --watch)
npm run web             # http://localhost:8787 — "Scanner Control" UI (Web Bluetooth or backend)
npm run cli -- grid --dry-run   # scripted capture runs against the backend
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
  constants.mjs        BLE service/characteristic UUIDs, DUML component/cmdSet/cmdId constants
  commands.mjs          command builders (pairing, gimbal recenter/mode/nudge, raw/RE escape hatch)
  telemetry.mjs         decoders for the orientation frames the gimbal streams at 10-20Hz
                        (quatToEulerDeg, quatToGimbalControlDeg — the closed-loop feedback)
  phone_telemetry.mjs   wire shape for the PHONE's compass/tilt/GPS, relayed over the backend's
                        /ws — displayed alongside gimbal telemetry, never averaged into it
server/
  ble-transport.mjs      Node BLE transport (@stoprocent/noble): scan, connect, pair, write-char fallback
  backend.mjs             the single BLE owner: HTTP + /ws, closed-loop move-to, grid capture
  android-capture.mjs     minimal MCP-over-HTTP client for the phone in the cradle (photo capture)
  cli.mjs                 scripted runs against the backend (scan/connect/grid/…)
  mcp-server.mjs          MCP server exposing it all as tools — an HTTP client of backend.mjs
web/                 "Scanner Control" PWA — two pathways, direct Web Bluetooth and backend
  index.html            markup + styles for both pathways
  app.mjs                 direct Web Bluetooth client, sharing protocol/* with the Node side
  backend-client.mjs      backend pathway: scan presets, grid runs, the scan-in-progress lock
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
