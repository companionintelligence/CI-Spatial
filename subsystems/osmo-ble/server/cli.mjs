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

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

Automated capture:
  grid [--pans 120,145,170] [--tilts -10,0,10]
       [--device-url URL] [--device-token TOK]   (default: ANDROID_MCP_URL / ANDROID_MCP_TOKEN)
       [--out DIR]                        Download the photos here (default: ./grid-<timestamp>)
       [--ingest URL]                     POST them to a CI-Spatial /ingest-photos when done
       [--tolerance deg] [--max ms] [--resolution WxH] [--quality N] [--dry-run]
                                          Move -> photo at every grid position, in serpentine
                                          order. --dry-run prints the plan and exits.

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

    case 'grid': {
      const nums = (v, fallback) => (v === undefined ? fallback : String(v).split(',').map(Number));
      const pans = nums(flags.pans, [120, 145, 170]);
      const tilts = nums(flags.tilts, [-10, 0, 10]);

      if (flags['dry-run']) {
        // planGrid is the backend's own function, imported rather than reimplemented, so a
        // dry run can never disagree with what a real run would do.
        const { planGrid } = await import('./android-capture.mjs');
        const grid = planGrid({ pans, tilts });
        print(grid.map((g, i) => `  ${i + 1}: pan=${g.pan} tilt=${g.tilt}`).join('\n'));
        console.error(`\n(${grid.length} positions, serpentine. Drop --dry-run to run it.)`);
        return;
      }

      const outDir = flags.out || `grid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      console.error(`Running ${pans.length * tilts.length} positions — this takes a few minutes.`);
      console.error('(Live progress is broadcast on the backend WS; the web UI shows it as it goes.)\n');

      const run = await api('POST', '/api/grid-capture', {
        pans,
        tilts,
        deviceUrl: flags['device-url'],
        deviceToken: flags['device-token'],
        toleranceDeg: flags.tolerance ? Number(flags.tolerance) : undefined,
        maxMs: flags.max ? Number(flags.max) : undefined,
        resolution: flags.resolution,
        quality: flags.quality ? Number(flags.quality) : undefined,
      });

      for (const r of run.results) {
        console.error(`  ${String(r.position).padStart(2)}: pan=${(r.pan ?? 0).toFixed(1)} tilt=${(r.tilt ?? 0).toFixed(1)}  ${r.converged ? 'converged' : 'NOT converged'} (${r.ticks} ticks)`);
      }
      console.error(`\n  ${run.converged}/${run.total} converged`);

      mkdirSync(outDir, { recursive: true });
      const files = [];
      for (const r of run.results) {
        const dest = `${outDir}/pos-${String(r.position).padStart(2, '0')}.jpg`;
        const res = await fetch(r.photoUrl);
        if (!res.ok) throw new Error(`downloading position ${r.position}: HTTP ${res.status}`);
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        files.push(dest);
      }
      console.error(`  downloaded ${files.length} photo(s) to ${outDir}/`);

      // Distinct-bytes check, not a formality: a stalled camera returning the same frame over
      // and over is a real failure mode this project has hit before (wave 04, six byte-identical
      // JPEGs across 47 minutes), and it is invisible unless something compares them.
      const hashes = new Set(files.map((f) => createHash('md5').update(readFileSync(f)).digest('hex')));
      if (hashes.size !== files.length) {
        console.error(`  WARNING: only ${hashes.size} distinct image(s) among ${files.length} — the camera may be returning a stale frame.`);
      } else {
        console.error(`  all ${files.length} frames are byte-distinct`);
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
