#!/usr/bin/env node
// Command-line client for server/backend.mjs's HTTP API — a terminal-friendly alternative to
// the web UI (web/server.mjs) or driving curl by hand, for exactly the same reason the MCP
// server is a thin HTTP client rather than its own BLE owner: this process does not hold the
// Bluetooth connection, backend.mjs does (see ../README.md's "Architecture" note and
// docs/operations/GIMBAL_INTEGRATION.md — one BLE connection, one owner). Start the backend
// first (`npm run backend`, in its own real terminal), then use this for scan/connect/pair/
// disconnect/command lifecycle testing without needing the browser open.
//
// Usage: node server/cli.mjs <command> [args...]
//   node server/cli.mjs help          — full command list
//
// "forget" only clears what THIS CLI remembers locally (.cli-state.json, gitignored) — not a
// macOS Bluetooth unpair. For that, use "forget-os" (wraps blueutil's EXPERIMENTAL --unpair;
// `brew install blueutil` if it's missing) or the manual System Settings -> Bluetooth ->
// (device) -> Forget step GIMBAL_INTEGRATION.md documents. Neither one fixes a wedged
// gimbal-side BLE stack (same doc, "gimbal itself can get into a stuck BLE state") — that's a
// physical button-combo reset on the gimbal, not a macOS pairing problem.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// The backend's own planners, imported rather than reimplemented, so a --dry-run can never
// disagree with what a real run would do and the CLI cannot offer a plan the backend refuses.
import { planGrid } from './android-capture.mjs';
import { planDomePans, unreachablePans, MIN_STATIONS_FOR_PARALLAX, PAN_ARC_START_DEG, PAN_ARC_END_DEG } from '../protocol/dome.mjs';

const BACKEND_URL = process.env.OSMO_BACKEND_URL || 'http://localhost:8788';
const STATE_FILE = fileURLToPath(new URL('../.cli-state.json', import.meta.url));

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Can't reach the backend at ${BACKEND_URL} — start it with "npm run backend" in a real terminal (${err.message})`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Backend returned HTTP ${res.status}`);
  return json;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function print(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

// Minimal flag parsing: positional args in order, plus --key value / --key=value anywhere.
// No dependency — matches the rest of this subsystem (zero non-runtime deps beyond noble/ws/
// zod/MCP SDK, all load-bearing, none argv-parsing related).
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HELP = `osmo-ble CLI — terminal client for server/backend.mjs (BACKEND_URL=${BACKEND_URL})

Connection lifecycle:
  scan [--timeout ms]                    Scan for nearby BLE devices (default 5000ms)
  connect [deviceId]                     Connect; omitted id reuses the last remembered one
  status                                 Connection/pairing state + last quaternion
  disconnect                             Disconnect the current BLE session
  forget                                 Clear the locally remembered device id (not a macOS unpair)
  forget-os [name]                       Real macOS Bluetooth unpair (needs blueutil); omitted
                                          name reuses the one remembered from the last scan
  reconnect [name]                       forget-os -> scan -> connect -> pair-trigger in one go —
                                          the recovery sequence for a stale/corrupt macOS bond.
                                          Still needs you to accept the OS dialog or enter a PIN.

Pairing:
  pair-trigger                           Send just the pairing-trigger bytes — puts the device
                                          into pairing mode so it shows a PIN, WITHOUT guessing
                                          one. Check the device screen after this, then run:
  pair <pin> [--identifier id]           Complete pairing with the PIN read off the device screen

Motion / commands:
  command <type> [--params '<json>']     Fire one command (speed, recenter, setMode, raw, ...)
  move-to <yawDeg> <pitchDeg>            Closed-loop absolute move
      [--tolerance deg] [--speed degPerSec] [--tick ms] [--settle ms] [--max ms]
  probe <type> [--params json] [--wait ms] [--stop-type type] [--stop-params json]
                                          Send one command, report before/after moved:true/false
  recenter-probe [--duration seconds]    Shorthand for: probe recenter --stop-type none

Automated capture:
  grid [--stations N]                     Sweep a dome, PAUSE while you carry the tripod to the
                                          next spot, sweep again. 3-5 stations for a room.
                                          A dome from ONE spot is pure rotation and cannot be
                                          reconstructed — measured, 3/17 images registered;
                                          5 stations registered 36/36. Default 1, which this
                                          tool will tell you is not a capture.
       [--station-labels a,b,c]           Names for the stations (default station-01, ...).
                                          Each becomes a subdirectory under --out.
       [--pan-center DEG] [--pan-span DEG] [--pan-step DEG]
                                          Dome width, clamped to the gimbal's reachable pan arc
                                          (+82° round through 180° to -100° — it cannot rotate
                                          through the front). Default: 150° centred on 171°.
       [--pans 120,145,170] [--tilts -25,0]
                                          Explicit columns/rows instead. Any pan in the dead
                                          zone is refused, not attempted.
       [--device NAME]                    Which phone to drive, by its .mcp.json name (e.g.
                                          beam-pro-1). Only needed when more than one device
                                          has its token set; otherwise ANDROID_MCP_DEVICE or
                                          the single configured device is used.
       [--device-url URL] [--device-token TOK]   Override the resolved device outright. Default:
                                          URL from .mcp.json's android-<device> entry (or
                                          ANDROID_MCP_URL), token from that device's own
                                          ANDROID_MCP_TOKEN_<DEVICE>.
       [--out DIR]                        Download the photos here (default: ./grid-<timestamp>)
                                          One subdirectory per station, plus a manifest.json
                                          rewritten as each frame lands — stop after 3 of 5
                                          stations and what is on disk is still 3 whole domes.
       [--ingest URL]                     POST them to a CI-Spatial /ingest-photos when done
       [--movement-only] [--dwell ms]     Sweep WITHOUT taking photos — the phone's scanner
                                          web app captures pose-tagged keyframes instead.
                                          Those AR poses are metric (device VIO), which is what
                                          lets splat-align recover a true scale. Use a pan step
                                          of at least the scanner's minRotationDeg (default 20)
                                          or some positions emit no keyframe at all.
       [--both-orientations]              2 shots per position: landscape (confirmed), then
                                          byte-0 (best-guess portrait, NOT independently
                                          confirmed) — see "Orientation toggle" in the web UI
       [--tolerance deg] [--max ms] [--resolution WxH] [--quality N] [--dry-run]
                                          Move -> photo at every grid position, in serpentine
                                          order. --dry-run prints the plan and exits.
       [--yes]                            Advance between stations without waiting for Enter —
                                          only for a rig that is not being carried. The pause
                                          is the point; skipping it captures every station from
                                          the same spot, which is the degenerate case.

Telemetry:
  frames [--limit N]                     Recent raw DUML frames (default 50)

  help                                   This text

Note: the phone caps concurrent MCP sessions. If \`grid\` reports "Too many active sessions",
something else is attached to it — a Claude Code session with that device's MCP server
connected is the usual cause. Detach it and retry.
`;

function jsonFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  try {
    return JSON.parse(flags[key]);
  } catch {
    throw new Error(`--${key} must be valid JSON, got: ${flags[key]}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      print(HELP);
      return;

    case 'scan': {
      const { devices } = await api('POST', '/api/scan', { timeoutMs: flags.timeout ? Number(flags.timeout) : undefined });
      print(devices);
      if (devices.length) {
        const best = devices.find((d) => d.likelyOsmo) ?? devices[0];
        // Remembered here (not just on connect) so `forget-os`/`reconnect` have a real advertised
        // name to unpair by even if the user never explicitly re-connects — scan is the only
        // step that ever sees the name at all; /api/connect's response doesn't carry it.
        saveState({ ...loadState(), lastDeviceId: best.id, lastDeviceName: best.name });
        console.error(`\n(${devices.length} found${devices.some((d) => d.likelyOsmo) ? '; ★ = likelyOsmo' : ''}. To connect: node server/cli.mjs connect ${best.id})`);
      }
      return;
    }

    case 'connect': {
      let deviceId = positional[0];
      if (!deviceId) {
        deviceId = loadState().lastDeviceId;
        if (!deviceId) throw new Error('No deviceId given and none remembered — run `scan` first, or pass one explicitly.');
        console.error(`(using remembered device ${deviceId.slice(0, 8)}…; pass one explicitly, or run \`forget\`, to override)`);
      }
      const info = await api('POST', '/api/connect', { deviceId });
      saveState({ ...loadState(), lastDeviceId: deviceId });
      print(info);
      return;
    }

    case 'forget': {
      try {
        unlinkSync(STATE_FILE);
        print({ forgotten: true, note: 'Cleared this CLI\'s remembered device id only — the gimbal and macOS Bluetooth pairing state are untouched.' });
      } catch {
        print({ forgotten: false, note: 'Nothing was remembered.' });
      }
      return;
    }

    case 'forget-os': {
      const name = positional[0] || loadState().lastDeviceName;
      if (!name) throw new Error('No device name given and none remembered — run `scan` first, or pass one explicitly: forget-os "OM6-E06YAM-2".');
      print(await api('POST', '/api/forget-os', { name }));
      return;
    }

    case 'reconnect': {
      // Convenience chain for the exact recovery sequence GIMBAL_INTEGRATION.md documents by
      // hand: unpair -> rescan -> reconnect -> re-trigger pairing. Does NOT complete pairing
      // itself (that needs a PIN read off the device screen, or the macOS confirm dialog
      // accepted by a human) — it gets you to the point of being ready for that.
      const name = positional[0] || loadState().lastDeviceName;
      if (!name) throw new Error('No device name given and none remembered — run `scan` first, or pass one explicitly: reconnect "OM6-E06YAM-2".');
      console.error(`Unpairing "${name}" from macOS...`);
      const forgetResult = await api('POST', '/api/forget-os', { name });
      print(forgetResult);
      if (!forgetResult.unpaired) {
        console.error('\nUnpair failed or blueutil is missing — continuing to rescan anyway; pairing may just re-confirm the existing bond.');
      }
      console.error('\nRescanning...');
      const { devices } = await api('POST', '/api/scan', {});
      const match = devices.find((d) => d.name === name) ?? devices.find((d) => d.likelyOsmo);
      if (!match) throw new Error(`"${name}" was not found in this scan — is it powered on and in range?`);
      saveState({ ...loadState(), lastDeviceId: match.id, lastDeviceName: match.name });
      console.error(`Connecting to ${match.name}...`);
      print(await api('POST', '/api/connect', { deviceId: match.id }));
      console.error('\nTriggering pairing...');
      await api('POST', '/api/pair-trigger');
      console.error('\nAccept the macOS Bluetooth confirmation dialog now (or read a PIN off the gimbal screen and run `pair <pin>`), then verify with: node server/cli.mjs recenter-probe');
      return;
    }

    case 'status':
      print(await api('GET', '/api/status'));
      return;

    case 'disconnect':
      print(await api('POST', '/api/disconnect'));
      return;

    case 'pair-trigger':
      print(await api('POST', '/api/pair-trigger'));
      console.error('\nCheck the gimbal\'s screen now for a PIN, then run: node server/cli.mjs pair <pin>');
      return;

    case 'pair': {
      const pin = positional[0];
      if (!pin) throw new Error('Usage: pair <pin> — read the PIN off the device screen first (try `pair-trigger` if none is showing).');
      print(await api('POST', '/api/pair', { pin, identifier: flags.identifier }));
      return;
    }

    case 'command': {
      const type = positional[0];
      if (!type) throw new Error('Usage: command <type> [--params \'{"...json..."}\']');
      print(await api('POST', '/api/command', { type, params: jsonFlag(flags, 'params') ?? {} }));
      return;
    }

    case 'move-to': {
      const [yawDeg, pitchDeg] = positional.map(Number);
      print(await api('POST', '/api/move-to', {
        yawDeg: Number.isFinite(yawDeg) ? yawDeg : undefined,
        pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : undefined,
        toleranceDeg: flags.tolerance ? Number(flags.tolerance) : undefined,
        speedDegPerSec: flags.speed ? Number(flags.speed) : undefined,
        tickMs: flags.tick ? Number(flags.tick) : undefined,
        settleMs: flags.settle ? Number(flags.settle) : undefined,
        maxMs: flags.max ? Number(flags.max) : undefined,
      }));
      return;
    }

    case 'probe': {
      const type = positional[0];
      if (!type) throw new Error('Usage: probe <type> [--params json] [--wait ms] [--stop-type type] [--stop-params json]');
      const stop = flags['stop-type']
        ? { type: flags['stop-type'], params: jsonFlag(flags, 'stop-params') ?? {} }
        : undefined;
      print(await api('POST', '/api/test/command-probe', {
        type,
        params: jsonFlag(flags, 'params') ?? {},
        waitMs: flags.wait ? Number(flags.wait) : undefined,
        stop,
      }));
      return;
    }

    case 'recenter-probe':
      print(await api('POST', '/api/test/recenter-probe', {
        durationSeconds: flags.duration ? Number(flags.duration) : undefined,
      }));
      return;

    case 'grid': {
      const nums = (v, fallback) => (v === undefined ? fallback : String(v).split(',').map(Number));
      const num = (v) => (v === undefined ? undefined : Number(v));
      const tilts = nums(flags.tilts, [-25, 0]);
      const stationsPlanned = Math.max(1, Math.trunc(Number(flags.stations ?? 1)) || 1);
      const stationLabels = flags['station-labels']
        ? String(flags['station-labels']).split(',').map((s) => s.trim()).filter(Boolean)
        : null;

      // Pan columns: an explicit list if given, otherwise the same centre/span planner the
      // backend uses, imported rather than reimplemented so a dry run and a real run cannot
      // disagree about where the gimbal is going.
      let pans;
      let panPlan = null;
      if (flags.pans !== undefined) {
        pans = nums(flags.pans);
        const bad = unreachablePans(pans);
        if (bad.length) {
          throw new Error(
            `${bad.length} of ${pans.length} pan column(s) are in the gimbal's dead zone `
            + `(${bad.map((b) => `${b.pan}°`).join(', ')}). Pan travels ${PAN_ARC_START_DEG}° round `
            + `through 180° to ${PAN_ARC_END_DEG}° and cannot rotate through the front; driving into `
            + 'the stop jams it. Use --pan-center/--pan-span and the plan is clamped for you.',
          );
        }
      } else {
        panPlan = planDomePans({
          centerDeg: num(flags['pan-center']),
          spanDeg: num(flags['pan-span']),
          stepDeg: num(flags['pan-step']) ?? 15,
        });
        pans = panPlan.pans;
        if (panPlan.clampedFrom) {
          console.error(`(pan span trimmed ${panPlan.clampedFrom}° -> ${panPlan.spanDeg}°: that is the whole reachable arc)`);
        }
      }

      const grid = planGrid({ pans, tilts });

      if (flags['dry-run']) {
        for (let s = 1; s <= stationsPlanned; s++) {
          console.error(`\n${stationLabels?.[s - 1] ?? `station-${String(s).padStart(2, '0')}`}:`);
          print(grid.map((g, i) => `  ${i + 1}: pan=${g.pan} tilt=${g.tilt}`).join('\n'));
          if (s < stationsPlanned) console.error('  --- pause: carry the tripod to the next spot ---');
        }
        console.error(`\n(${stationsPlanned} station(s) x ${grid.length} positions = ${stationsPlanned * grid.length}, serpentine.`);
        console.error(` pan ${panPlan ? `${panPlan.spanDeg}° centred on ${panPlan.centerDeg}°` : `[${pans.join(', ')}]`}, all inside the reachable arc.`);
        if (stationsPlanned < MIN_STATIONS_FOR_PARALLAX) {
          console.error(` WARNING: ${stationsPlanned} station has no translational baseline — a dome from one spot is pure`);
          console.error(' rotation and registered 3 of 17 images in COLMAP. Use --stations 3..5.)');
        } else {
          console.error(' Drop --dry-run to run it.)');
        }
        return;
      }

      const outDir = flags.out || `grid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      console.error(`Running ${stationsPlanned} station(s) x ${grid.length} positions — this takes a few minutes per station.`);
      console.error(`(Streaming progress below; each photo downloads to ${outDir}/<station>/ as its position finishes — a later failure only costs what comes after it.)\n`);
      if (stationsPlanned < MIN_STATIONS_FOR_PARALLAX) {
        console.error('WARNING: one station only. A dome swept from a single spot is pure rotation — no');
        console.error('translational baseline, nothing for structure-from-motion to triangulate. Measured:');
        console.error('3 of 17 images registered. Pass --stations 3 (or more) to capture something solvable.\n');
      }
      mkdirSync(outDir, { recursive: true });

      // The manifest is rewritten after every frame and every station rather than composed at
      // the end, and that is the whole answer to "what does a run stopped after 3 of 5 stations
      // leave behind". At any instant the directory describes itself: which stations exist,
      // which frames belong to which, and whether the run had finished. A manifest written only
      // on the happy path would make every interrupted run — the stop button, a dead battery, a
      // Ctrl-C — indistinguishable from a directory of loose JPEGs.
      const manifest = {
        prefix: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        backend: BACKEND_URL,
        plan: { pans, tilts, stationsPlanned, perStation: grid.length },
        stations: [],
        complete: false,
        usable: false,
        reason: 'Run in progress — this file is rewritten as each frame lands.',
      };
      const manifestPath = `${outDir}/manifest.json`;
      const writeManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      writeManifest();

      // Streamed NDJSON, not one buffered response (see backend.mjs's grid-capture handler for
      // why): a multi-minute request that sends zero bytes until the very end reads as a hung
      // connection to undici's own default timeout, which is exactly what silently killed two
      // real runs (22 and 84 positions) before this existed — both lost everything captured up
      // to that point because nothing had been downloaded yet. Downloading per-line as it
      // arrives is what fixes that: whatever already landed on disk survives a later failure.
      let gridRes;
      try {
        gridRes = await fetch(`${BACKEND_URL}/api/grid-capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pans,
            tilts,
            stations: stationsPlanned,
            ...(stationLabels ? { stationLabels } : {}),
            device: flags.device,
            deviceUrl: flags['device-url'],
            deviceToken: flags['device-token'],
            toleranceDeg: flags.tolerance ? Number(flags.tolerance) : undefined,
            maxMs: flags.max ? Number(flags.max) : undefined,
            resolution: flags.resolution,
            quality: flags.quality ? Number(flags.quality) : undefined,
            bothOrientations: Boolean(flags['both-orientations']),
            // --movement-only: sweep without taking photos, so the phone's scanner web app
            // captures pose-tagged keyframes instead. Those poses are what give the
            // reconstruction a real metric scale; MCP camera JPEGs carry none.
            capturePhotos: !flags['movement-only'],
            dwellMs: flags.dwell ? Number(flags.dwell) : undefined,
          }),
        });
      } catch (err) {
        throw new Error(`Can't reach the backend at ${BACKEND_URL} — start it with "npm run backend" in a real terminal (${err.message})`);
      }
      if (!gridRes.ok && !gridRes.body) throw new Error(`Backend returned HTTP ${gridRes.status}`);
      // A 4xx never streams — it is a rejected plan (a pan column in the dead zone, a missing
      // device token), and its body is one JSON object, not NDJSON. Reading it as a stream
      // would print a parse error over the top of a perfectly clear message.
      if (!gridRes.ok) {
        const rejected = await gridRes.json().catch(() => ({}));
        throw new Error(`${rejected.error || `HTTP ${gridRes.status}`}${rejected.remediation ? `\n  ${rejected.remediation}` : ''}`);
      }

      const files = [];
      let total = grid.length * stationsPlanned;
      let final = null;
      /** Stations already prompted for, so the 5-second heartbeats do not re-ask. */
      const prompted = new Set();
      let buf = '';
      for await (const chunk of gridRes.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          if (event.phase === 'start') {
            total = event.total;
            manifest.prefix = event.prefix;
            manifest.plan = { ...manifest.plan, ...event.plan, perStation: event.perStation, stationsPlanned: event.stationsPlanned };
            writeManifest();
          } else if (event.phase === 'station-start') {
            mkdirSync(`${outDir}/${event.stationLabel}`, { recursive: true });
            manifest.stations.push({ station: event.station, label: event.stationLabel, positions: 0, converged: 0, frames: [] });
            writeManifest();
            console.error(`\n── station ${event.station}/${event.stationsPlanned} (${event.stationLabel}) ──`);
          } else if (event.phase === 'awaiting-station') {
            if (prompted.has(event.nextStation)) continue;
            prompted.add(event.nextStation);
            console.error('');
            console.error(`  MOVE THE TRIPOD to station ${event.nextStation} of ${event.stationsPlanned}.`);
            console.error('  Somewhere the previous stations can see and that can see them, and NOT in a line');
            console.error('  with them — collinear stations share one baseline and stay degenerate.');
            if (!event.linkUp) console.error('  WARNING: the BLE link to the gimbal has dropped. Reconnect before advancing.');
            try {
              if (flags.yes) {
                console.error('  (--yes: advancing without waiting. Every station from the same spot is the degenerate case.)');
              } else if (!process.stdin.isTTY) {
                // Printed once, not on every 5-second heartbeat: a non-interactive caller is
                // usually a log, and the instruction does not get truer by repetition.
                console.error(`  Not a terminal — advance with:  curl -XPOST ${BACKEND_URL}/api/grid-advance`);
                continue;
              } else {
                console.error('  Press Enter when it is down and level (Ctrl-C to stop here — the stations already captured are complete).');
                await new Promise((resolve) => {
                  process.stdin.resume();
                  process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
                });
              }
              await api('POST', '/api/grid-advance');
            } catch (err) {
              // A refused advance is recoverable (a dropped BLE link is the expected cause), so
              // clear the prompt flag and let the next heartbeat ask again rather than leaving
              // the run parked with nobody about to try.
              console.error(`  Could not advance: ${err.message}`);
              prompted.delete(event.nextStation);
            }
          } else if (event.phase === 'captured') {
            console.error(`  ${String(event.stationPosition).padStart(2)}: pan=${(event.pan ?? 0).toFixed(1)} tilt=${(event.tilt ?? 0).toFixed(1)}  ${event.converged ? 'converged' : 'NOT converged'} (${event.ticks} ticks)`);
            const station = manifest.stations.find((s) => s.station === event.station);
            const frame = {
              station: event.station,
              stationLabel: event.stationLabel,
              stationPosition: event.stationPosition,
              position: event.position,
              target: event.target,
              pan: event.pan,
              tilt: event.tilt,
              converged: event.converged,
              ticks: event.ticks,
              files: [],
            };
            // Movement-only positions carry no photoUrl: this backend deliberately took no
            // photo, because the phone's own scanner app is capturing pose-tagged keyframes
            // instead. Downloading is not just skipped but *must* be — fetch(null) throws
            // "Failed to parse URL from null" and kills the run mid-sweep.
            if (!event.photoUrl) {
              frame.capturedBy = 'scanner-app';
              console.error('    (movement-only — the scanner app captures this position)');
            } else {
              const shots = [{ suffix: '', url: event.photoUrl }];
              if (event.photoUrlPortrait) shots.push({ suffix: '-portrait', url: event.photoUrlPortrait });
              for (const shot of shots) {
                const dest = `${outDir}/${event.stationLabel}/pos-${String(event.stationPosition).padStart(2, '0')}${shot.suffix}.jpg`;
                const photoRes = await fetch(shot.url);
                if (!photoRes.ok) {
                  console.error(`    WARNING: downloading position ${event.stationPosition}${shot.suffix}: HTTP ${photoRes.status} — skipped`);
                  continue;
                }
                writeFileSync(dest, Buffer.from(await photoRes.arrayBuffer()));
                files.push(dest);
                frame.files.push(dest.slice(outDir.length + 1));
              }
            }
            if (station) {
              station.frames.push(frame);
              station.positions++;
              if (event.converged) station.converged++;
            }
            writeManifest();
          } else if (event.phase === 'station-done') {
            console.error(`  station ${event.station}: ${event.converged}/${event.positions} converged`);
            writeManifest();
          } else if (event.phase === 'done') {
            final = event;
            total = event.total;
          } else if (event.phase === 'error') {
            console.error(`\n  Backend reported a fault: ${event.error}`);
          }
        }
      }

      manifest.finishedAt = new Date().toISOString();
      manifest.complete = final?.complete ?? false;
      manifest.usable = final?.usable ?? false;
      manifest.reason = final?.reason ?? (final ? null : 'The progress stream ended without a summary — the connection dropped mid-run.');
      writeManifest();

      console.error(`\n  ${final?.converged ?? 0}/${total} positions converged across ${manifest.stations.length} station(s)`);
      console.error(`  downloaded ${files.length} photo(s) to ${outDir}/`);
      console.error(`  manifest: ${manifestPath}`);

      // Distinct-bytes check, not a formality: a stalled camera returning the same frame over
      // and over is a real failure mode this project has hit before (wave 04, six byte-identical
      // JPEGs across 47 minutes), and it is invisible unless something compares them.
      if (files.length) {
        const hashes = new Set(files.map((f) => createHash('md5').update(readFileSync(f)).digest('hex')));
        if (hashes.size !== files.length) {
          console.error(`  WARNING: only ${hashes.size} distinct image(s) among ${files.length} — the camera may be returning a stale frame.`);
        } else {
          console.error(`  all ${files.length} frames are byte-distinct`);
        }
      }

      if (flags.ingest) {
        const form = new FormData();
        for (const f of files) form.append('files', new Blob([readFileSync(f)], { type: 'image/jpeg' }), f.split('/').pop());
        form.append('name', outDir.split('/').pop());
        const res = await fetch(flags.ingest, { method: 'POST', body: form });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status} ${JSON.stringify(json)}`);
        console.error('');
        print(json);
      }

      // The exit code is the one thing a script reads, so it has to mean "this can be
      // reconstructed", not "the process reached the end". A single-station run, a run where
      // nothing converged, and a run cut short of the stations it was asked for are all real
      // outcomes with usable frames on disk — and none of them is the capture that was
      // requested. Say which, and exit non-zero.
      if (!final) {
        console.error('\n  FAILED: the stream ended without a summary — the connection dropped mid-run.');
        console.error(`  Whatever is in ${outDir}/ is still intact; manifest.json says how far it got.`);
        process.exitCode = 1;
      } else if (!final.usable || !final.complete) {
        console.error(`\n  ${final.usable ? 'PARTIAL' : 'NOT USABLE'}: ${final.reason ?? 'the run did not complete every planned station.'}`);
        console.error(`  ${final.stationsUsable}/${final.stationsPlanned} station(s) captured.`
          + (final.usable ? ` Those ${final.stationsUsable} are complete domes and can be reconstructed on their own.` : ''));
        process.exitCode = 1;
      } else {
        console.error(`\n  OK: ${final.stationsUsable} station(s), ${final.framesConverged} converged frames — enough parallax to reconstruct.`);
      }
      return;
    }

    case 'frames':
      print((await api('GET', `/api/frames${flags.limit ? `?limit=${Number(flags.limit)}` : ''}`)).frames);
      return;

    default:
      throw new Error(`Unknown command "${cmd}". Run \`node server/cli.mjs help\` for the list.`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
