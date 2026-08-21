#!/usr/bin/env node
// MCP server exposing DJI Osmo BLE pairing + basic gimbal controls as tools an LLM can call.
// Transport: stdio by default (standard for local MCP servers used by Claude Desktop / Claude
// Code), with an optional Streamable HTTP transport for remote/Tailscale access — see
// "HTTP transport" below the tool definitions and ../README.md.
//
// Confidence levels (see ../README.md for the full research writeup): the pairing handshake
// and frame codec are verified against a real captured DUML frame. Gimbal recenter/mode/nudge
// are MEDIUM confidence, ported from Osmo Pocket 3 reverse-engineering, not yet confirmed
// against an Osmo Mobile 6. Shutter/record are deliberately NOT implemented — no source had
// verified byte-level data for them; guessing risks sending an unknown command to the device.
//
// ARCHITECTURE (changed 2026-08-21): this process does NOT hold its own BLE connection anymore.
// It never reliably could — this is a Claude Code-spawned subprocess, parented by the same
// process tree as Claude's own tool execution, and macOS refuses that tree Bluetooth access
// (confirmed via an actual crash report: TCC / missing NSBluetoothAlwaysUsageDescription). Every
// tool here is now a thin HTTP client of server/backend.mjs, which the user runs in a real
// terminal — the only place BLE has been proven to work. This also means there's only ever one
// BLE connection to the single physical gimbal, not two independent ones fighting over it.

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const BACKEND_URL = process.env.OSMO_BACKEND_URL || 'http://localhost:8788';

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}

/** Thin client for server/backend.mjs's HTTP API — see that file for route definitions. */
async function backendFetch(path, { method = 'GET', body } = {}) {
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

// Tool registration lives in a factory rather than at module scope so the HTTP transport can
// give each request its own McpServer instance (see "HTTP transport" below — the Streamable
// HTTP transport in stateless mode explicitly forbids reusing one transport, and by extension
// one connected server, across requests). Every tool below is a stateless backendFetch() call,
// so there's no device state to keep consistent across McpServer instances anymore.
function createMcpServer() {
  const server = new McpServer({ name: 'osmo-ble', version: '0.1.0' });

  server.registerTool(
    'scan_devices',
    {
      title: 'Scan for BLE devices',
      description:
        'Scan for nearby Bluetooth LE devices for a few seconds and list them, with DJI/Osmo-looking devices ranked first. Use the returned id with connect().',
      inputSchema: { timeoutMs: z.number().int().min(1000).max(20000).optional().describe('Scan duration in ms (default 5000)') },
      annotations: { readOnlyHint: true },
    },
    async ({ timeoutMs }) => {
      try {
        const { devices } = await backendFetch('/api/scan', { method: 'POST', body: { timeoutMs: timeoutMs ?? 5000 } });
        return textResult(devices);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'connect',
    {
      title: 'Connect to a device',
      description:
        'Connect to a BLE peripheral by id (from scan_devices) and discover its Osmo control service/characteristics. Does not pair yet — call pair() next.',
      inputSchema: { deviceId: z.string().describe('Peripheral id returned by scan_devices') },
    },
    async ({ deviceId }) => {
      try {
        const info = await backendFetch('/api/connect', { method: 'POST', body: { deviceId } });
        return textResult(info);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'pair',
    {
      title: 'Pair with the connected device',
      description:
        "Run the pairing handshake. The gimbal shows a PIN code on its own screen when it enters pairing mode (triggered by this call) — read that PIN and pass it here. Do not guess a PIN; it's device-generated per pairing attempt in the real DJI Mimo app flow.",
      inputSchema: {
        pin: z.string().describe('PIN code shown on the device screen'),
        identifier: z.string().optional().describe('App instance identifier string (defaults to a harmless constant used by prior research)'),
      },
    },
    async ({ pin, identifier }) => {
      try {
        const result = await backendFetch('/api/pair', { method: 'POST', body: { pin, identifier } });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'status',
    {
      title: 'Connection status',
      description: 'Report whether we are connected and paired.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const status = await backendFetch('/api/status');
        return textResult({ connected: status.connected, paired: status.paired });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'disconnect',
    { title: 'Disconnect', description: 'Disconnect from the current device.', inputSchema: {} },
    async () => {
      try {
        await backendFetch('/api/disconnect', { method: 'POST' });
        return textResult({ disconnected: true });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'get_recent_frames',
    {
      title: 'Get recent DUML frames',
      description:
        'Return the most recently received decoded (or failed-to-decode) frames from the device — telemetry, battery, pairing acks, etc. Useful for reverse-engineering unknown notifications and for reading battery level, which the device pushes passively rather than in response to a query.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('Max frames to return, most recent last (default 50)') },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      try {
        const { frames } = await backendFetch(`/api/frames?limit=${limit ?? 50}`);
        return textResult(frames);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'gimbal_recenter',
    {
      title: 'Recenter gimbal',
      description:
        'MEDIUM CONFIDENCE: ask the gimbal to move to angle (0,0,0), as a recenter proxy. Not a verified dedicated recenter opcode. Community research on a related Osmo model reports gimbal-motion commands may be silently ignored over BLE-only (possibly requiring an active WiFi/stream session) — treat this as the first thing to test to find out whether motion control works at all on this device.',
      inputSchema: { durationSeconds: z.number().min(0.1).max(10).optional().describe('Move duration in seconds (default 1)') },
    },
    async ({ durationSeconds }) => {
      try {
        const result = await backendFetch('/api/command', { method: 'POST', body: { type: 'recenter', params: { durationSeconds: durationSeconds ?? 1 } } });
        return textResult({ sent: true, ...result });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'get_orientation',
    {
      title: 'Get current gimbal orientation',
      description:
        'Return the most recent orientation quaternion [x,y,z,w] decoded from the gimbal\'s continuous, unprompted telemetry stream (cmdSet=0x4 cmdId=0x5, ~10-20Hz once connected — no query needed). Returns null if no telemetry has arrived yet. Useful for orchestration: e.g. confirming a scanner client\'s host device has actually turned before triggering a capture.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const status = await backendFetch('/api/status');
        return textResult({ quaternion: status.lastQuaternion });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'gimbal_sweep',
    {
      title: 'Sweep gimbal across a yaw range',
      description:
        'MEDIUM CONFIDENCE, built on the same ABS_ANGLE primitive as gimbal_recenter: step the gimbal yaw from startYawDeg to endYawDeg in stepDeg increments, dwelling dwellMs at each step before moving on — intended for driving a phone mounted in the gimbal through a scan sweep (e.g. for CI-Spatial\'s room scanner, which auto-captures purely off the phone\'s own tracked movement/rotation, so no separate signal into the scanner client is needed beyond physically moving it). Set dwellMs comfortably above the scanner client\'s auto-capture interval (check its config; ~2.5s+ is a safe starting point) so each step actually registers as a new capture rather than motion blur. Capped at 60 steps per call — narrow the range or increase stepDeg for a coarser sweep, or issue multiple calls for a longer one. For interleaving a photo capture between steps yourself, use gimbal_move_to instead.',
      inputSchema: {
        startYawDeg: z.number().min(-160).max(160),
        endYawDeg: z.number().min(-160).max(160),
        stepDeg: z.number().min(1).max(90).optional().describe('Degrees per step (default 15)'),
        dwellMs: z.number().int().min(200).max(30000).optional().describe('Milliseconds to hold/settle at each step before capturing orientation and moving on (default 3000)'),
        pitchDeg: z.number().min(-60).max(60).optional().describe('Constant pitch to hold throughout the sweep (default 0)'),
        moveDurationSeconds: z.number().min(0.1).max(5).optional().describe('Commanded move duration per step, passed to the gimbal (default 1)'),
      },
    },
    async ({ startYawDeg, endYawDeg, stepDeg, dwellMs, pitchDeg, moveDurationSeconds }) => {
      try {
        const step = stepDeg ?? 15;
        const dwell = dwellMs ?? 3000;
        const span = endYawDeg - startYawDeg;
        const direction = span >= 0 ? 1 : -1;
        const count = Math.floor(Math.abs(span) / step) + 1;
        if (count > 60) {
          throw new Error(`Sweep would take ${count} steps (max 60) — narrow the range or increase stepDeg`);
        }
        const results = [];
        for (let i = 0; i < count; i++) {
          const yawDeg = i === count - 1 ? endYawDeg : startYawDeg + direction * step * i;
          const probe = await backendFetch('/api/test/command-probe', {
            method: 'POST',
            body: {
              type: 'absoluteAngle',
              params: { yawDeg, pitchDeg: pitchDeg ?? 0, durationSeconds: moveDurationSeconds ?? 1 },
              waitMs: dwell,
            },
          });
          results.push({ step: i, yawDeg, quaternionAfterDwell: probe.after });
        }
        return textResult({ stepsSent: results.length, results });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'gimbal_move_to',
    {
      title: 'Move gimbal to an absolute angle and verify',
      description:
        'Move to a single absolute (yawDeg, pitchDeg), dwell dwellMs to let motion settle, and report the orientation quaternion before/after plus a delta-based moved verdict — the single-step primitive behind gimbal_sweep, exposed on its own so a caller can interleave something else (e.g. a photo-capture tool call on a different MCP server) between steps of a multi-position scan (see plan_scan_grid for computing the target grid). Axis mapping was corrected and live-verified via the joystick on 2026-08-21 (see protocol/commands.mjs).',
      inputSchema: {
        yawDeg: z.number().min(-160).max(160).optional().describe('Target yaw in degrees (default 0)'),
        pitchDeg: z.number().min(-60).max(60).optional().describe('Target pitch in degrees (default 0)'),
        dwellMs: z.number().int().min(200).max(30000).optional().describe('Milliseconds to hold/settle before sampling orientation (default 2000)'),
        moveDurationSeconds: z.number().min(0.1).max(5).optional().describe('Commanded move duration, passed to the gimbal (default 1)'),
      },
    },
    async ({ yawDeg, pitchDeg, dwellMs, moveDurationSeconds }) => {
      try {
        const probe = await backendFetch('/api/test/command-probe', {
          method: 'POST',
          body: {
            type: 'absoluteAngle',
            params: { yawDeg: yawDeg ?? 0, pitchDeg: pitchDeg ?? 0, durationSeconds: moveDurationSeconds ?? 1 },
            waitMs: dwellMs ?? 2000,
          },
        });
        return textResult({ yawDeg: yawDeg ?? 0, pitchDeg: pitchDeg ?? 0, ...probe });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'plan_scan_grid',
    {
      title: 'Plan a yaw/pitch grid scan',
      description:
        'Pure planning helper, no device interaction (works even before connecting) — computes an evenly-spaced yawCount x pitchCount grid of absolute (yawDeg, pitchDeg) targets across the given ranges, in a serpentine (boustrophedon) order that minimizes total travel between consecutive steps. Feed each returned target into gimbal_move_to, interleaving a photo-capture tool call after each one, to drive a fully automated N-position scan (e.g. the default 3x3 = 9 targets for a "9 photos" sweep). Does not itself move anything or take photos.',
      inputSchema: {
        yawCount: z.number().int().min(1).max(10).optional().describe('Number of yaw positions (default 3)'),
        pitchCount: z.number().int().min(1).max(10).optional().describe('Number of pitch positions (default 3)'),
        yawRangeDeg: z.number().min(1).max(160).optional().describe('Total yaw span, centered on 0 (default 40, i.e. -20..+20)'),
        pitchRangeDeg: z.number().min(1).max(120).optional().describe('Total pitch span, centered on 0 (default 30, i.e. -15..+15)'),
      },
    },
    async ({ yawCount, pitchCount, yawRangeDeg, pitchRangeDeg }) => {
      const yCount = yawCount ?? 3;
      const pCount = pitchCount ?? 3;
      const yRange = yawRangeDeg ?? 40;
      const pRange = pitchRangeDeg ?? 30;
      const yawSteps = Array.from({ length: yCount }, (_, i) => (yCount === 1 ? 0 : -yRange / 2 + (yRange * i) / (yCount - 1)));
      const pitchSteps = Array.from({ length: pCount }, (_, i) => (pCount === 1 ? 0 : -pRange / 2 + (pRange * i) / (pCount - 1)));
      const targets = [];
      let index = 0;
      for (let row = 0; row < pCount; row++) {
        const cols = row % 2 === 0 ? yawSteps.map((v, i) => [i, v]) : yawSteps.map((v, i) => [i, v]).reverse();
        for (const [col, yawDeg] of cols) {
          targets.push({ index: index++, row, col, yawDeg: Math.round(yawDeg * 10) / 10, pitchDeg: Math.round(pitchSteps[row] * 10) / 10 });
        }
      }
      return textResult({ totalTargets: targets.length, targets });
    }
  );

  server.registerTool(
    'gimbal_set_mode',
    {
      title: 'Set gimbal mode',
      description:
        'CONFIRMED this is a portrait/landscape toggle (cmdId 0x44), not a real lock/follow/fpv mode selector — kept under its original lock/follow/fpv names for backward compat with existing callers, but "follow" is the one confirmed value (rotates the phone mount to landscape); lock/fpv are unresolved.',
      inputSchema: { mode: z.enum(['lock', 'follow', 'fpv']) },
    },
    async ({ mode }) => {
      try {
        const result = await backendFetch('/api/command', { method: 'POST', body: { type: 'setMode', params: { mode } } });
        return textResult({ sent: true, mode, ...result });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'gimbal_nudge',
    {
      title: 'Nudge gimbal',
      description:
        'MEDIUM CONFIDENCE: move the gimbal at a given angular speed (deg/sec, roughly -180..180) on each axis for a short duration, then automatically send a stop (zero speed) command — a safety measure so a forgotten command does not leave the gimbal moving indefinitely.',
      inputSchema: {
        pitchDegPerSec: z.number().min(-180).max(180).optional(),
        rollDegPerSec: z.number().min(-180).max(180).optional(),
        yawDegPerSec: z.number().min(-180).max(180).optional(),
        durationMs: z.number().int().min(50).max(3000).optional().describe('How long to move before auto-stopping (default 500ms)'),
      },
    },
    async ({ pitchDegPerSec, rollDegPerSec, yawDegPerSec, durationMs }) => {
      try {
        const speeds = { pitchDegPerSec, rollDegPerSec, yawDegPerSec };
        await backendFetch('/api/command', { method: 'POST', body: { type: 'speed', params: speeds } });
        await new Promise((resolve) => setTimeout(resolve, durationMs ?? 500));
        await backendFetch('/api/command', { method: 'POST', body: { type: 'speed', params: {} } });
        return textResult({ sent: true, ...speeds });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'send_raw_command',
    {
      title: 'Send a raw DUML command (advanced)',
      description:
        'EXPERIMENTAL / REVERSE-ENGINEERING TOOL: build and send an arbitrary DUML frame from a cmdSet/cmdId/payload hex string. Use this deliberately to probe unknown commands while watching get_recent_frames for the response — not a verified command in itself. Sending unknown DUML frames could trigger unexpected device behavior.',
      inputSchema: {
        cmdSet: z.number().int().min(0).max(255),
        cmdId: z.number().int().min(0).max(255),
        payloadHex: z.string().optional().describe('Hex-encoded payload bytes, e.g. "01ff00" (default: empty)'),
        receiver: z.number().int().min(0).max(255).optional().describe('DUML receiver component id (default: Camera = 0x01)'),
      },
    },
    async ({ cmdSet, cmdId, payloadHex, receiver }) => {
      try {
        const result = await backendFetch('/api/command', {
          method: 'POST',
          body: { type: 'raw', params: { cmdSet, cmdId, payloadHex: payloadHex ?? '', receiver } },
        });
        return textResult({ sent: true, ...result });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

// --- Transport selection --------------------------------------------------
// Default: stdio, unchanged, for the existing .mcp.json subprocess entries.
// Opt in to HTTP with either `--http` or MCP_TRANSPORT=http, so this same
// invocation (`node server/mcp-server.mjs`) still works exactly as before.
const HTTP_MODE = process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

if (HTTP_MODE) {
  await startHttpServer();
} else {
  const server = createMcpServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}

// --- HTTP transport ---------------------------------------------------------
// Streamable HTTP, for remote access over Tailscale — same pattern as the
// android-* entries in .mcp.json ({"type":"http","url":"http://<host>:PORT/mcp",
// "headers":{"Authorization":"Bearer ${TOKEN}"}}). Binds all interfaces (no
// host arg to .listen(), mirroring server/backend.mjs) so it's reachable from
// the tailnet.
//
// Stateless mode (sessionIdGenerator: undefined): no session bookkeeping across
// requests. The SDK explicitly forbids reusing one StreamableHTTPServerTransport
// (and, by extension, the McpServer connected to it) across more than one HTTP
// request in this mode, so we build a fresh McpServer + transport pair per
// request via createMcpServer(). There's no device state to worry about keeping
// in sync anymore — every tool call is a fresh backendFetch() to the real BLE
// owner (server/backend.mjs).
async function startHttpServer() {
  const PORT = Number(process.env.OSMO_MCP_HTTP_PORT) || 8789;
  const TOKEN = process.env.OSMO_MCP_TOKEN;
  if (!TOKEN) {
    console.error(
      'OSMO_MCP_TOKEN is not set. Refusing to start the HTTP transport unauthenticated — ' +
        'this port is reachable from the whole Tailscale tailnet. Set OSMO_MCP_TOKEN and retry.'
    );
    process.exit(1);
  }

  function isAuthorized(req) {
    const header = req.headers['authorization'] || '';
    const expected = `Bearer ${TOKEN}`;
    const got = Buffer.from(header);
    const want = Buffer.from(expected);
    // Length check before timingSafeEqual: it throws on mismatched buffer lengths
    // rather than returning false, and the length itself isn't secret.
    return got.length === want.length && timingSafeEqual(got, want);
  }

  const httpServer = http.createServer(async (req, res) => {
    // Auth check is a thin gate in front of the handler — happens before any
    // request is handed to the MCP transport, for every path and method.
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No route for ${req.method} ${url.pathname}` }));
      return;
    }

    const requestServer = createMcpServer();
    const requestTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      requestTransport.close();
      requestServer.close();
    });

    try {
      await requestServer.connect(requestTransport);
      await requestTransport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`Osmo BLE MCP server: HTTP transport listening on 0.0.0.0:${PORT}/mcp`);
  });
}
