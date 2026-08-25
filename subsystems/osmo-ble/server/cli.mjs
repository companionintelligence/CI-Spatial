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
// "forget" here only clears what THIS CLI remembers locally (.cli-state.json, gitignored) — it
// is not a macOS Bluetooth unpair. There is no reliable, official macOS CLI for that; use
// System Settings → Bluetooth → (device) → Forget, the same manual step already documented in
// GIMBAL_INTEGRATION.md for recovering a wedged gimbal-side BLE state.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

Telemetry:
  frames [--limit N]                     Recent raw DUML frames (default 50)

  help                                   This text
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
