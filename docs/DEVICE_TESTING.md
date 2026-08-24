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
  npm run qr -- "/?project=default"               # scanner / uploader entry
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
| 2 | Select or create a **Place**, optionally choose an Area, and complete calibration | GPS/history may suggest a Place; Place selection and alignment are explicit before the scanner opens |
| 3 | Tap **Scan a Place** and grant permissions | Camera + motion permission prompts appear immediately (they must originate from the tap) |
| 4 | Grant both permissions | Camera feed visible; status HUD shows SLAM initialising, then tracking |
| 4 | Walk slowly around the room | Point count in the HUD stats grows; compass/geo chip resolves an address outdoors |
| 5 | Tap the capture button | Progress sweep → detection labels pinned in 3D within ~5–30 s (model-dependent; watch `X-Inference-Ms` in server logs) |
| 6 | Toggle 📷 auto-capture and keep walking | Capture ring pulses on movement; count badge increments; HUD shows per-capture status |
| 7 | Toggle ☁ keyframe streaming | Stream count badge increments as you move; box side: `journalctl --user -u cscan-server -f` shows `POST /sessions/<id>/keyframes` |
| 8 | Open the side panel → export GLB | Upload toast; file lands in `scans/` on the box; optimization job logs run (Draco + LODs) |
| 10 | On a desktop browser open `/editor?project=default` | The new scan appears in the selected Place; LODs load progressively |
| 10 | Share-sheet → Add to Home Screen, launch the PWA | Standalone app opens to the scanner with the same session history |
| 11 | Airplane-mode ON (keep Wi-Fi off), capture | HUD shows offline/queue messaging rather than a spinner hang |
| 12 | Airplane-mode OFF | Queued uploads flush (watch server logs); no data lost |

**Watch the box side throughout:** `journalctl --user -u cscan-server -f` for
API traffic and inference timing; `npm run logs:watch` for on-device console
errors (page must be loaded with `?debug=remote`).

## Checklist B — Android Chrome (WebXR)

Suggested devices: `hanzlas-z-fold7`, `tab-s8-ultra`. The latter can also be
driven remotely over MCP for the UI/permission steps — see
[Remote-controlled testing](#remote-controlled-testing-android-remote-control-mcp)
below.

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Open `/webxr.html` in Chrome | Support probe passes and auto-forwards to `/?ar=webxr` (needs ARCore / Play Services for AR) |
| 2 | Tap **Start AR** → grant camera | Native `immersive-ar` session starts; HUD (dom-overlay) stays visible over the camera |
| 3 | Sweep the camera slowly across surfaces | Point count grows from hit-test samples (slower than SLAM — expected) |
| 4 | Capture, auto-capture, ☁ streaming, export | Same expectations as Checklist A steps 5–9 |
| 5 | Note the 🥽 runtime toggle | In WebXR mode it links back to the 8th Wall scanner; in the 8th Wall scanner it only appears when `immersive-ar` is genuinely supported |

### B2 — calibration anchor decal (WebXR renderer verification)

**Why this exists as its own checklist.** PR #141 gave `WebXRProvider` a
`THREE.WebGLRenderer` bound to the session's GL context so the calibration decal
can draw over the passthrough. `src/ar/webxr.ts`'s own header says that half
"needs verification on a real WebXR device, not just review" — it replaced the
hand-rolled `session.requestAnimationFrame` loop with
`renderer.xr.setSession()` + `setAnimationLoop()`, added a `local-floor`/`local`
reference-space fallback on two independent request paths, added a guard for
Three's non-XR rAF firing with `frame === undefined`, and reordered renderer
disposal to follow `session.end()`. None of that is reachable from a unit test;
the automated coverage in `anchor_calibration.test.ts` deliberately does not
touch the renderer at all.

Needs an **ARCore-backed Android** (`galaxy-tab-s9-ultra` or
`liams-tab-s8-ultra`). iPhone/Safari does *not* exercise this code — no
`immersive-ar`, so it runs the 8th Wall provider instead. Quest browser is a
useful second data point because its controller-driven input hits the
`pointerdown` path a touchscreen never does, but is not required.

| # | Step | Expected result | Checks |
|---|---|---|---|
| 1 | Open `/webxr.html`, start AR, complete calibration | Anchor decal (ring + crosshair, red north tick) appears on the ground at the tapped point | the renderer draws at all |
| 2 | Walk around the decal | Stays on the same physical spot; does not slide with the camera | world-locking via the per-view pose/projection |
| 3 | Watch the camera feed during step 1–2 | No blanking, flicker or black frames | `renderer.autoClear = false` and the `frame === undefined` skip |
| 4 | Compare the north tick against a phone compass app | Tick points at true north | the 0°=north/90°=east claim, end to end through a real magnetometer |
| 5 | Continue scanning after calibration | Point count grows; capture still works | the `setAnimationLoop` swap did not disturb the frame loop's other work |
| 6 | Stop AR and start a second session **in the same page load** | Second session tracks and renders normally | renderer disposal ordering in `stop()` |
| 7 | Record runtime versions | Android / Chrome / ARCore versions noted below | — |

#### Results — B2

| Device | Android | Chrome | ARCore | 1 decal | 2 world-locked | 3 no flicker | 4 north | 5 scan ok | 6 restart | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

```bash
npm run qr -- "webxr.html"
```

## Results matrix

Copy per test session:

| Step | iphone182 | liam-ipad-pro | z-fold7 | tab-s8-ultra | Notes |
|------|-----------|---------------|---------|--------------|-------|
| Smoke page all green | | | | | |
| A2/B2 permissions from tap | | | | | |
| Tracking + point growth | | | | | |
| Capture → detection latency | | | | | |
| Keyframe streaming | | | | | |
| Export → viewer visible | | | | | |
| PWA install | | | | | |
| Offline queue + flush | | | | | |

## Room-loop benchmark — SLAM drift and calibration repeatability

A measurement protocol, not a pass/fail checklist. It exists because three
tolerance constants in the calibration system
(`GROUND_TAP_TOLERANCE_M`, `DEFAULT_SEPARATION_TOLERANCE_M`,
`MIN_POINT_SEPARATION_M`) are all bounded by one quantity nothing measures:
how repeatably this app places a point in a room. See
`docs/factory/09-ground-anchor-calibration/0006-room-loop-drift-benchmark.md`.

**Record every run, not a best or a mean.** Drift is stochastic — lighting,
pace and feature density vary — so five runs showing 4/4/5/4/19 cm is a
completely different finding from five showing 8/9/8/9/8 cm, and averaging
both to ~7 cm hides it.

### The instrument

Load the scanner with **`?debug=pose`** to show a live readout under the status
line:

```
pos 1.24 -0.03 -2.10
Δ 6cm · 2.4° · x0.03 y-0.01 z0.05
```

`pos` is the raw camera position in session-local metres. `Δ` is displacement,
yaw difference and per-axis offset **from the session's first tracked pose** —
so walking back to where you started should read near zero, with no arithmetic
in the field. The reference is taken from the first pose after tracking locks,
not at t=0, since the pre-lock pose is meaningless.

`?debug=` is a comma-separated list, so `?debug=pose,remote` shows the readout
*and* mirrors the console to `npm run logs:watch` — useful for recording
numbers without stopping to write them down.

```bash
npm run qr -- "?debug=pose,remote"
```

### Apparatus

Tape a marker on the floor at **Point A** and note a fixed facing direction
(a wall, a doorway). Tape a second marker at **Point B**, at least 1 m away.
Pick three fixed objects as capture targets. Define a perimeter path
A → B → C → D → A around the room.

One piece of tape does three jobs: it is the loop test's return point, the
calibration landmark, and the cross-session re-placement target.

### Procedure 1 — within-session loop drift

Repeat 5× per device. Note held-height and facing each run; both affect the
result and neither is fixed by the tape.

| Step | Action | Record |
|---|---|---|
| 1 | Stand on Point A, tap **Start AR** (`#start-ar-btn`) | Seconds from tap to tracking |
| 2 | Walk the perimeter at **< 0.8 m/s** (the speed above which the app itself warns) | Point count at each waypoint |
| 3 | Return to Point A, same facing | **`Δ` straight off the HUD** — distance and yaw |
| 4 | Exercise capture (`#capture-btn`), auto-capture (`#auto-capture-btn`), keyframe streaming (`#stream-btn`), WebRTC (`#rtc-stream-btn`) | Keyframe upload latency; any dropped frames |
| 5 | Capture one target object from two angles ≥ 60° apart | Did the two detections merge? (dedup radius is 0.4 m) |
| 6 | Tap **Done** (`#finish-scan-btn`) → export | Quality verdict; upload success |

**Targets, not thresholds.** < 10 cm translational and < 5° rotational is a
reasonable expectation. If real drift is consistently worse, that is a finding
about this app's tracking — record it and widen the calibration tolerances
accordingly. Do not treat it as a broken device.

**Point-accumulation rate is a baseline to measure, not a bar to clear.** The
two providers differ by construction: WebXR samples a 6×6 probe grid every
750 ms — a ceiling of 48 probes/sec before 5 cm voxel dedup discards repeats —
while 8th Wall harvests per-frame SLAM world points and can go substantially
higher. Record each separately; a number from one says nothing about the other.

#### Results — Procedure 1

| Run | Device | Held height | Facing | Time to track | Points @ A→B→C→D | Δ distance | Δ yaw | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |

### Procedure 2 — cross-session calibration repeatability

> **Not runnable yet — it needs ticket 0004.** Steps 3 and 4 read `separationM`
> and `residualM` off the two-point flow, and that flow does not exist: today's
> calibration is a single ground tap, `ProjectSpatialFrame.method` has one
> member (`'ground-tap-compass'`), and nothing anywhere computes a separation.
> Since 0004 depends on 0002, whose `DEFAULT_SEPARATION_TOLERANCE_M` this
> procedure is supposed to supply, the wave's stated order is circular. **Run
> Procedure 2a below instead** — it measures the same underlying quantity with
> what has shipped, and it is what 0002 should cite. Procedure 2 stays here as
> the confirmation run for after 0004 lands.

This is the one the calibration tolerances come from. Each run is a **separate
session** — fully stop and restart AR between runs, so tracking re-initialises
and the frame is genuinely rebuilt rather than carried over.

| Step | Action | Record |
|---|---|---|
| 1 | Start AR; complete the environment-scan step | Seconds to ground lock |
| 2 | Place the landmark on taped Point A | — |
| 3 | Place the heading marker on taped Point B | Reported `separationM` |
| 4 | Run 2 onward | Reported `residualM` against the stored frame |

**The spread of `separationM` across five independent sessions is the answer.**
Both markers sit on fixed tape, so the true distance never changes — every
centimetre of variation is the system's own repeatability. Set
`DEFAULT_SEPARATION_TOLERANCE_M` above the observed spread, or the check fires
on correct calibrations.

Run this **before reference photos exist** (wave 09 ticket 0007), so the spread
is a clean no-aid baseline. 0007 re-runs it with photos and compares; that
difference is the only honest measure of whether the photos help.

#### Results — Procedure 2

| Run | Device | Time to ground lock | `separationM` | `residualM` | Notes |
|---|---|---|---|---|---|
| 1 | | | | — (first) | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

Spread (max − min `separationM`): ______ m → proposed `DEFAULT_SEPARATION_TOLERANCE_M`: ______ m

### Procedure 2a — repeatability and floor-gate characterisation, on today's build

Everything Procedure 2 wants to know, measured with the one-point flow that has
actually shipped. Two independent measurements share one set of runs.

Each run is a **separate session** — fully stop and restart AR between runs.

**Where the numbers come from.** `pos` is session-local, so it means nothing
across sessions; `Δ` is anchored to the session's *first tracked pose*, so it is
comparable across sessions only if that first pose is on a fixed physical spot.
**Stand on taped Point A when you tap Start AR, and do not move until the HUD
shows a pose.** That is what makes run 3 comparable to run 1.

| Step | Action | Record |
|---|---|---|
| 1 | Stand on taped Point A. Tap **Start AR** (`#start-ar-btn`) and hold still until the readout appears | Seconds to tracking |
| 2 | Sweep the floor until calibration says *"Floor found"* | **Seconds to ground lock** |
| 3 | Aim at a table or counter (~0.75 m) and tap it | The **cm figure in the rejection message** — and that it *was* rejected |
| 4 | Aim at a chair seat (~0.45 m) and tap it | Same — this is the tight end of the margin |
| 5 | Tap taped Point A on the floor | Whether a correct floor tap is ever falsely rejected |
| 6 | Walk the perimeter loop, return to Point A, same facing | `Δ` distance and yaw (this is Procedure 1's number, for free) |
| 7 | Walk to taped Point B, stand on it, same facing every run | **`Δ` distance** — the measured A→B baseline |

**Step 7 is the repeatability figure.** The tape does not move, so the true A→B
distance is identical in all five runs; every centimetre of spread in `Δ` is the
system's own. Set `DEFAULT_SEPARATION_TOLERANCE_M` above that spread.

Read it as a **conservative proxy, not the real thing**: it measures pose
repeatability at a fixed physical offset, where 0004 will measure hit-test
repeatability against a visible mark. It carries operator noise (where exactly
you stand, how you hold the device) that aiming at a taped cross does not, so it
should if anything over-estimate the spread. That direction is the safe one — a
tolerance set too tight is what makes correct repeat visits report false
mismatches. Confirm it with the real Procedure 2 once 0004 ships.

**Steps 3–5 are the floor gate.** `GROUND_TAP_TOLERANCE_M = 0.25` is live on
`main` as a guess, and the rejection message already reports the measured height
in centimetres, so the gate characterises itself. What matters:

- A chair seat (~0.45 m) must report comfortably more than 25 cm. If it reports
  30 cm the margin is 5 cm, not the 20 cm the constant's comment assumes.
- A real floor tap must never be rejected. One false rejection in five runs is a
  finding, not noise — the gate is on the path to every scan.

#### Results — Procedure 2a

| Run | Device | Time to track | Time to ground lock | Table tap (cm) | Chair tap (cm) | Floor tap rejected? | Loop `Δ` (dist / yaw) | A→B `Δ` distance |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |

Tape-measured true A→B distance: ______ m (for reference; the spread is what matters, not the absolute error)

Spread (max − min A→B `Δ`): ______ m → proposed `DEFAULT_SEPARATION_TOLERANCE_M`: ______ m

Smallest reported chair-tap height: ______ cm → margin to `GROUND_TAP_TOLERANCE_M` (25 cm): ______ cm

`MIN_POINT_SEPARATION_M` follows from the spread rather than being measured
directly: two markers must be far enough apart that the spread is small relative
to the baseline, or the heading derived from them is noisy. The proposed 1.0 m
holds only if the spread is well under ~10 cm.

### Devices

At minimum one of each provider path — they share no tracking code:

- **8th Wall SLAM**: `iphone182` or `liam-ipad-pro` (Safari)
- **WebXR**: `galaxy-tab-s9-ultra` or `liams-tab-s8-ultra` (Chrome, needs ARCore)

## Remote-controlled testing (android-remote-control-mcp)

For Android devices, [android-remote-control-mcp](https://github.com/danielealbano/android-remote-control-mcp)
lets Claude Code drive Checklist B's UI steps directly — tapping **Start AR**,
granting the camera permission, hitting capture — without a human holding the
device for every run. It can't replace the physical "sweep the camera around
the room" steps, so use it for the repeatable UI/permission-flow parts and for
unattended `/smoke.html` checks, not as a full substitute for a walked run.

### One-time device setup

1. Install the `gms` build (or `foss`, on devices without Google Play
   services): `adb install -r android-remote-control-mcp-<version>-gms-release.apk`
2. **Settings → Apps → Android Remote Control MCP → ⋮ → Allow restricted
   settings**, confirm with PIN/biometric (Android 13+ blocks sideloaded apps
   from requesting Accessibility by default), then enable the **Accessibility
   Service** toggle. Nothing works without this — it's how the app reads the
   screen and injects taps.
3. In **Settings → Security**, confirm the **HTTPS** toggle is off (plain HTTP
   is the documented default, but the `edge` channel has been observed with
   it on). If it's on, Windows Node clients — including Claude Code's own
   runtime — complete the TLS handshake against the app's auto-generated
   self-signed cert and then get cleanly rejected (`self-signed certificate`)
   or reset, and the app documents no way for a client to trust or pin that
   cert. Plain HTTP avoids the whole problem.
4. Open the app's **Server** tab → **Start**. Note the bearer token under
   **Settings → Access**.

### The test fleet

Every device runs its own server with its own bearer token, reachable on the
tailnet at port 8080. There is no shared token — one per device, supplied via
the matching environment variable below.

| Tailnet host | Tailscale IP | Device | `.mcp.json` server | Token env var |
|---|---|---|---|---|
| `liams-tab-s8-ultra` | 100.86.76.113 | Galaxy Tab S8 Ultra (SM-X900) | `android-tab-s8-ultra` | `ANDROID_MCP_TOKEN_TAB_S8_ULTRA` |
| `galaxy-tab-s9-ultra` | 100.102.92.116 | Galaxy Tab S9 Ultra (SM-X910) | `android-tab-s9-ultra` | `ANDROID_MCP_TOKEN_TAB_S9_ULTRA` |
| `beam-pro-1` | 100.127.78.6 | XREAL X4000 | `android-beam-pro-1` | `ANDROID_MCP_TOKEN_BEAM_PRO_1` |
| `beam-pro` | 100.97.126.117 | XREAL X4200 | `android-beam-pro` | `ANDROID_MCP_TOKEN_BEAM_PRO` |

### Connecting Claude Code (tailnet — preferred)

`.mcp.json` points each server at `http://<host>.capybara-ulmer.ts.net:8080/mcp`,
with every token left as a `${...}` placeholder. Claude Code expands those
placeholders from its process environment. On Windows, persist the four values
for your user account:

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_TAB_S8_ULTRA", "<tab-s8 token>", "User")
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_TAB_S9_ULTRA", "<tab-s9 token>", "User")
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_BEAM_PRO_1", "<beam-pro-1 token>", "User")
[Environment]::SetEnvironmentVariable("ANDROID_MCP_TOKEN_BEAM_PRO", "<beam-pro token>", "User")
```

Close and reopen the terminal after setting them. A `.mcp.local.json` file is
git-ignored (safe to keep tokens in), but Claude Code does not automatically
merge it with `.mcp.json` — the env-var placeholders above are the mechanism
that actually works today.

For a temporary Bash session, export only the devices you need:

```bash
export ANDROID_MCP_TOKEN_TAB_S8_ULTRA=<token from that device's Settings → Access>
export ANDROID_MCP_TOKEN_TAB_S9_ULTRA=<token from that device's Settings → Access>
export ANDROID_MCP_TOKEN_BEAM_PRO_1=<token from that device's Settings → Access>
export ANDROID_MCP_TOKEN_BEAM_PRO=<token from that device's Settings → Access>
```

Export only the devices you actually need — a server whose variable is unset
simply fails to authenticate, it does not break the others.

Either way the tokens are read when the session starts, so a value supplied
mid-session does not take effect until Claude Code is restarted. **Never
hardcode them into `.mcp.json` itself** — that file is tracked, and a token
granting tap and screen-read control of a device is permanent once committed.

With the environment variables set, start Claude Code from the repository root
and accept the workspace trust prompt. Approve the project MCP servers when
Claude Code asks; otherwise `claude mcp list` can show them as pending or omit
them from the active session even though the JSON is valid. If the choices are
stale, run `claude mcp reset-project-choices`, restart Claude Code in this
repository, and approve the servers again. `claude_desktop_config.json` is for
Claude Desktop and does not replace this project-level Claude Code setup.

**The server must be bound to `0.0.0.0`, not `127.0.0.1`, or the tailnet address
refuses connections.** Set this in **Settings → General**. This is a deliberate
exposure tradeoff: on the tailnet, any peer can drive the device with just the
bearer token. See "Security notes" below.

### Connecting over adb (fallback, USB only)

Useful when a device isn't on the tailnet, or when you don't want to widen its
bind address. Forward a free host port to the device's 8080 — one host port per
device, since several devices cannot share one:

```bash
adb -s <serial> forward tcp:8081 tcp:8080
```

The tracked `.mcp.json` points that server at its tailnet hostname, so the
forward alone is not enough — override the URL for this machine in
`.mcp.local.json`, which takes precedence:

```bash
cat > .mcp.local.json <<'JSON'
{
  "mcpServers": {
    "android-tab-s9-ultra": {
      "type": "http",
      "url": "http://127.0.0.1:8081/mcp",
      "headers": { "Authorization": "Bearer <tab-s9 token>" }
    }
  }
}
JSON
```

Restart Claude Code afterward — MCP config is read at session start. Delete the
override to go back to the tailnet path.

Use the literal `127.0.0.1`, not `localhost`, and choose the host port
deliberately rather than defaulting to 8080. On a machine that also runs Docker
Desktop and/or WSL, `:8080` is frequently already taken on
`0.0.0.0`/`[::]`/`[::1]` — verified here, Docker Desktop held `0.0.0.0:8080`
and `[::]:8080` while wslrelay held `[::1]:8080`, which is why the example
forwards to 8081 instead. An IPv6-first resolver will happily route `localhost`
to that unrelated service instead of the adb forward, which only binds
`127.0.0.1` (IPv4). If a forward seems to hang or reset, run
`netstat -ano | findstr :<host-port>` and check which PID actually owns
`127.0.0.1:<host-port>` before assuming the phone is the problem.

### Diagnosing "connection refused"

Work down this list — the layers fail differently and the symptoms overlap.

**1. Is the host reachable at all?** `tailscale ping <host>`.

- *A pong, but the port still refuses* — the network is fine and the app is the
  problem. Skip to step 3.
- *No reply at all* — the device is not on the tailnet, and no amount of
  app-side debugging will help. `tailscale status` showing `offline, last seen
  <N>h ago` together with `tx <n> rx 0` means you are transmitting into a void.
  **A device can be awake, on Wi-Fi, and serving MCP perfectly while being
  completely absent from the tailnet** — observed on the tab-s8-ultra, which
  answered 200 with all 57 tools on its LAN address while its tailnet name was
  unreachable. Go to step 2.

**2. Is Tailscale actually running on the device?** Installed is not the same as
connected — the Android client is an app that has to be launched, and it does
not reliably survive the device sleeping. With the device on USB:

```bash
adb -s <serial> shell "pidof com.tailscale.ipn || echo NOT RUNNING"
```

```bash
adb -s <serial> shell "ip -4 addr show | grep -A1 tun"
```

No pid, or no `100.x` address on a `tun` interface, means the VPN is down. Open
the Tailscale app on the device and turn it on — that needs Android's
VPN-consent dialog and possibly a re-login, so it cannot be driven over adb.

To prove the app itself is healthy while the tunnel is down, probe the device's
LAN address directly. A 200 there isolates the fault to Tailscale:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://<lan-ip>:8080/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cc","version":"1"}}}'
```

**3. Is the server actually listening?** Check the socket *state*, not just the
address:

```bash
adb -s <serial> shell "cat /proc/net/tcp6 | awk '\$2 ~ /:1F90/ {print \$2, \$4}'"
```

`1F90` is port 8080 hex; state `0A` is LISTEN. **Anything else is not a
listener** — `06` is TIME_WAIT, and stale TIME_WAIT rows from earlier
connections look identical in the address column. Grepping the address alone
will tell you the server is bound to loopback when in fact it is not running at
all. Address `00000000...0000` is the `0.0.0.0` wildcard;
`0000...FFFF00000100007F` is `::ffff:127.0.0.1`.

**4. Is it bound to loopback?** Then only on-device clients reach it. Change the
bind in **Settings → General**.

### Tunnels (Cloudflare / ngrok) — read before trusting one

The app has a **Settings → Tunnel** page with an **Enable Remote Access**
toggle; `cloudflared` is bundled inside the app itself (`libcloudflared.so`,
spawned as a child of the app process), not installed separately. Three
non-obvious behaviors, all observed:

- **A dead tunnel URL does not mean the tunnel is off.** In Cloudflare "Free /
  Random temporary URL" mode, every reconnect mints a *brand-new* hostname. An
  old URL returning 530/1033 while a fresh one silently serves traffic is the
  normal state, not an anomaly. Check the app's **Public URL** row or the
  `libcloudflared.so` process — never a URL you saved earlier.
- **The Enable Remote Access toggle is inert while the server is running.** It
  reports `clickable` but not `enabled`, so both accessibility clicks and
  coordinate taps are silently no-ops. Stop the MCP server first, flip the
  toggle, then start the server again. Confirm with the node attribute, not the
  pixels — the switch renders almost identically on and off in dark mode:

  ```bash
  adb -s <serial> shell "uiautomator dump /sdcard/ui.xml >/dev/null; cat /sdcard/ui.xml" | tr '<' '
' | grep 'checkable="true"'
  ```

- **Stopping the MCP server kills the tunnel** (cloudflared is its child), but
  starting the server respawns it unless the toggle was turned off in between.
  `adb shell kill <cloudflared-pid>` fails with "Operation not permitted" — it
  runs as the app's UID, not shell's.

A `trycloudflare` quick tunnel is reachable by **anyone on the internet** with
the URL; the bearer token is the only control. Prefer the tailnet.

### Driving a device / taking screenshots

- `android_open_uri` opens a URL via `ACTION_VIEW`. It routes to the installed
  app when one claims the domain (reddit.com opens the Reddit app, not Chrome).
- `android_get_screen_state` with `include_screenshot=true` returns a JPEG with
  the accessibility node tree **drawn over it** in red. It is a debug aid, not a
  clean screenshot. For a real one use `adb exec-out screencap -p > out.png`,
  which needs USB.
- **An all-black screencap almost always means the screen is off, not a capture
  failure.** Check `dumpsys display | grep committedState` and wake with
  `input keyevent KEYCODE_WAKEUP`. Some devices (the XREAL X4000) re-sleep
  within seconds, so chain wake, swipe, and capture in one `adb shell`
  invocation rather than as separate commands.
- A device with a set lock screen (`locksettings get-disabled` → `false`,
  `dumpsys trust` → `deviceLocked=1`) cannot be driven past the keyguard
  without its PIN. Leave those devices unlocked before an unattended run.

### Security notes (from upstream)

- Upstream default bind is `127.0.0.1`. Widening it to `0.0.0.0` for tailnet
  access means any tailnet peer can read the screen and inject taps, with only
  the bearer token in the way. Do it deliberately, not by habit.
- The server is fully open to anyone who can reach it if both bearer-token and
  OAuth auth are disabled — don't disable both.
- Rotate a token that has been pasted into chat, a ticket, or a log.
- Stop the server (and any tunnel) when you're done testing.

## Triage

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Certificate warning on device | Cert missing/expired or hostname mismatch | `tailscale cert <host>` in the repo root, then `systemctl --user restart cscan-web` |
| Page loads over `http://` or "HTTPS required" banner | Opened via IP or wrong scheme | Use the `https://<host>.ts.net:5173` URL (npm run qr) |
| "Server unreachable — is Tailscale connected?" HUD | VPN off on the phone, or cscan-server down | Tailscale app → VPN on; `systemctl --user status cscan-server` |
| "Model warming up — retry in a few seconds" | First inference after idle loads weights into VRAM | Retry; check `journalctl -u ollama -f` |
| Detections very slow (>30 s) or 504 | Model too large / running on CPU | `ollama ps` should show 100% GPU; install/re-pick via `npm run setup:models` + `npm run bench:models`, set `OLLAMA_MODEL` in `~/.config/cscan/env` |
| Camera prompt never appears | Not a secure context, or Start not triggered by a user tap | Check /smoke.html Secure Context row; don't script the tap |
| HMR/live-reload dead on phone (dev mode) | `TAILSCALE_HOSTNAME` mismatch pins HMR to the wrong host | Export the right hostname before `npm start` (auto-detect usually handles it) |
| 🥽 toggle missing on iPhone Safari | Correct behavior — Safari has no WebXR `immersive-ar` | Use HelloXR (App Store id6757726359) for the WebXR path on iOS |
| No console output in `logs:watch` | Page loaded without `?debug=remote` | Reload with the query param (or set `localStorage['remote-log']='1'`) |
