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
// The same arc the backend plans and validates against — imported so a plan this tool hands an
// agent can never be one the backend then refuses (or worse, one the gimbal tries).
import { planDomePans, unreachablePans, makeArc, describeArc, DEFAULT_PAN_ARC, PAN_ARC_START_DEG, PAN_ARC_END_DEG, PAN_ARC_CENTER_DEG, PAN_ARC_SPAN_DEG, DEFAULT_PAN_SPAN_DEG, MIN_STATIONS_FOR_PARALLAX } from '../protocol/dome.mjs';

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
    'pair_trigger',
    {
      title: 'Put the gimbal into pairing mode, without a PIN',
      description:
        'Sends just the pairing-trigger bytes, no PIN — the gimbal is expected to enter pairing mode and show a PIN on its own screen. Use this when you do not have a PIN yet, so the caller does not have to guess one for the `pair` tool: a wrong PIN is a real device-side attempt that can trip a lockout, making the eventual real pairing attempt harder. After calling this, check the device screen, then call `pair` with what it shows.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await backendFetch('/api/pair-trigger', { method: 'POST' });
        return textResult(result);
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
        "Run the pairing handshake. The gimbal shows a PIN code on its own screen when it enters pairing mode (triggered by this call) — read that PIN and pass it here. Do not guess a PIN; it's device-generated per pairing attempt in the real DJI Mimo app flow. If no PIN is showing yet, call pair_trigger first to make the device display one without also submitting a guess.",
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
      description:
        'Report the state of the BLE link. `connected` means telemetry is FLOWING, not merely '
        + 'that a connect call returned — `link` carries the full state: "disconnected", '
        + '"connecting", "linked" (a GATT handle exists so commands go out, but nothing is '
        + 'coming back, so any closed-loop move would run blind) or "streaming". Treat "linked" '
        + 'as broken: reconnect before relying on move_to, sweeps or probes.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const status = await backendFetch('/api/status');
        return textResult({
          connected: status.connected,
          link: status.link,
          linkDetail: status.linkDetail,
          subscribedChars: status.subscribedChars,
          paired: status.paired,
        });
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
        'Recenter via the same closed-loop positioning as gimbal_move_to (targets yaw=0, pitch=0 in the approximate Euler decomposition of the live quaternion) — the dedicated recenter/absolute-angle opcodes were both either unverified or, in the absolute-angle case, confirmed non-functional on this hardware (2026-08-21). Caveat: "0,0" here is wherever this device\'s quaternion frame reads as zero, which is not independently confirmed to be the true mechanical center.',
      inputSchema: {
        toleranceDeg: z.number().min(0.5).max(20).optional().describe('Convergence deadband in degrees (default 3)'),
        speedDegPerSec: z.number().min(5).max(60).optional().describe('Correction speed while error exceeds tolerance (default 25)'),
      },
    },
    async ({ toleranceDeg, speedDegPerSec }) => {
      try {
        const result = await backendFetch('/api/move-to', { method: 'POST', body: { yawDeg: 0, pitchDeg: 0, toleranceDeg, speedDegPerSec } });
        return textResult(result);
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
        'MEDIUM CONFIDENCE — step the gimbal yaw from startYawDeg to endYawDeg in stepDeg increments using the same closed-loop positioning as gimbal_move_to (the absolute-angle opcode this used to rely on is confirmed non-functional on this hardware), dwelling dwellMs at each step before moving on — intended for driving a phone mounted in the gimbal through a scan sweep (e.g. for CI-Spatial\'s room scanner, which auto-captures purely off the phone\'s own tracked movement/rotation). Set dwellMs comfortably above the scanner client\'s auto-capture interval (~2.5s+) so each step actually registers as a new capture rather than motion blur. Capped at 60 steps per call. For interleaving a photo capture between steps yourself, use gimbal_move_to instead. Note (2026-08-24): the underlying closed-loop positioning had a wrong-feedback-axis bug that stopped it ever converging on real hardware; fixed, see gimbal_move_to and GIMBAL_INTEGRATION.md. If the gimbal has no macOS Bluetooth bond it will still ignore motor commands outright, which shows up as every step reporting a flat history — check the bond before suspecting this tool.',
      inputSchema: {
        startYawDeg: z.number().min(-160).max(160),
        endYawDeg: z.number().min(-160).max(160),
        stepDeg: z.number().min(1).max(90).optional().describe('Degrees per step (default 15)'),
        dwellMs: z.number().int().min(200).max(30000).optional().describe('Extra milliseconds to hold at each step after convergence, before moving on (default 3000)'),
        pitchDeg: z.number().min(-60).max(60).optional().describe('Constant pitch to hold throughout the sweep (default 0)'),
      },
    },
    async ({ startYawDeg, endYawDeg, stepDeg, dwellMs, pitchDeg }) => {
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
          const moveResult = await backendFetch('/api/move-to', {
            method: 'POST',
            body: { yawDeg, pitchDeg: pitchDeg ?? 0 },
          });
          await new Promise((resolve) => setTimeout(resolve, dwell));
          results.push({ step: i, yawDeg, ...moveResult });
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
      title: 'Move gimbal to an absolute angle (closed-loop)',
      description:
        'Move to a single absolute (yawDeg, pitchDeg) using closed-loop speed control driven by live quaternion feedback, not the absolute-angle opcode — that opcode (cmdId 0x14) was live-tested 2026-08-21 and confirmed to do nothing on this hardware, likely because our guessed payload struct never matched DJI\'s real (larger) angle-set structs. This is the single-step primitive behind gimbal_sweep, exposed on its own so a caller can interleave something else (e.g. a photo-capture tool call on a different MCP server) between steps of a multi-position scan (see plan_scan_grid). Returns {converged, timedOut, ticks, finalYaw, finalPitch, history} — check `converged` before assuming the position was actually reached; the yaw/pitch mapping used for feedback is an approximate Euler decomposition, not a calibrated attitude readout, so treat "close enough within toleranceDeg" as the real contract, not exact degrees. Fixed 2026-08-24: the loop previously steered on the raw `yaw` Euler channel, which on a mounted OM6 is pinned at -90 while physical pan lands in `roll` — so it never converged on real hardware. It now steers on measured pan/tilt (see GIMBAL_INTEGRATION.md). finalYaw/finalPitch carry pan/tilt values; the field names are kept for wire compatibility. If a call does report timedOut, read the history array and check whether pan/tilt actually change between ticks — a completely flat history means the gimbal is not moving at all (no macOS Bluetooth bond, or a wedged BLE stack), which is a different problem from a move that fell short. A result carrying `noTelemetry: true` is a third, distinct outcome: the gimbal stopped sending telemetry mid-move, so the loop gave up rather than driving blind for the rest of maxMs. Reconnect (the `connect` tool) before retrying — a longer maxMs cannot help, and neither can a bigger tolerance.',
      inputSchema: {
        yawDeg: z.number().min(-160).max(160).optional().describe('Target yaw in degrees (default 0)'),
        pitchDeg: z.number().min(-60).max(60).optional().describe('Target pitch in degrees (default 0)'),
        toleranceDeg: z.number().min(0.5).max(20).optional().describe('Convergence deadband in degrees (default 3)'),
        speedDegPerSec: z.number().min(5).max(60).optional().describe('Correction speed while error exceeds tolerance (default 25)'),
        maxMs: z.number().int().min(1000).max(30000).optional().describe('Give up and report timedOut if not converged by then (default 8000)'),
      },
    },
    async ({ yawDeg, pitchDeg, toleranceDeg, speedDegPerSec, maxMs }) => {
      try {
        const result = await backendFetch('/api/move-to', {
          method: 'POST',
          body: { yawDeg: yawDeg ?? 0, pitchDeg: pitchDeg ?? 0, toleranceDeg, speedDegPerSec, maxMs },
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'probe_pan_arc',
    {
      title: 'Measure the reachable pan arc from this tripod position',
      description:
        'Drives the gimbal to each end of its pan travel and reports where the mechanical stops actually are RIGHT NOW. Do this after the tripod is set down, and again after every time it is moved. Why it is not optional: pan swings about 178 degrees and cannot rotate through the front, and WHERE that arc falls is fixed to the tripod BASE, not to the reported angles. Measured 2026-08-29 on one gimbal in one session — from one tripod position targets -174/-144/-114 all converged; the tripod was carried two metres and set down, and the same targets all stalled at 171, because the stop had moved 89 degrees in the reported frame. A plan built from the built-in limits drove straight into it and the run died reporting only that the gimbal had stopped moving. The backend remembers this measurement, plans every subsequent dome inside it, and forgets it whenever the tripod is (or may have been) moved. Costs a handful of moves; measured live 2026-08-30 at 7 moves and 85 seconds. Safe: it approaches each end at reduced speed, stops asking the moment a step meets a stop, and stops the motors on every exit path.',
      inputSchema: {
        stepDeg: z.number().min(10).max(60).optional().describe('How far each probe step reaches (default 35). Smaller is gentler and slower; accuracy does not depend on it, because a step that meets a stop reports the pose it jammed at.'),
      },
    },
    async ({ stepDeg }) => {
      try {
        return textResult(await backendFetch('/api/arc-probe', { method: 'POST', body: { stepDeg } }));
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
        'Pure planning helper, no device interaction (works even before connecting) — computes one STATION\'s dome: an evenly-spaced yawCount x pitchCount grid of absolute (yawDeg, pitchDeg) targets in a serpentine (boustrophedon) order that minimizes travel between consecutive steps. Feed each target into gimbal_move_to, interleaving a photo-capture call. TWO things this deliberately will not let you plan. (1) Yaw is planned along the gimbal\'s REACHABLE ARC (+82 degrees round through 180 to about -100) and centred on 171 (straight back), not on 0: the OM6 cannot rotate through the front, and a move into that stop does not error — it twitches against the limit while the controller holds a speed command against it, which has thermally shut a real unit down. yawRangeDeg is a WIDTH, clamped to the 178-degree arc; it is not a -x..+x pair, because that spelling is how the dead zone got requested. (2) One dome is not a capture. A dome swept from a single tripod position is pure rotation with no translational baseline — measured on real COLMAP runs, that registers 3 of 17 images, while 5 domes from 5 spots register 36 of 36. Plan 3-5 stations, moving the tripod between them and NOT in a straight line, and drive them with POST /api/grid-capture {stations: N} (which pauses between domes) rather than by looping this tool from one spot.',
      inputSchema: {
        yawCount: z.number().int().min(1).max(20).optional().describe('Number of yaw columns (default 7)'),
        pitchCount: z.number().int().min(1).max(10).optional().describe('Number of pitch rows (default 2)'),
        yawRangeDeg: z.number().min(1).max(178).optional().describe(`Total yaw WIDTH along the reachable arc, centred on yawCenterDeg (default ${DEFAULT_PAN_SPAN_DEG}); clamped to the ${PAN_ARC_SPAN_DEG}-degree arc`),
        yawCenterDeg: z.number().min(-180).max(180).optional().describe(`Centre of the dome (default ${PAN_ARC_CENTER_DEG}, straight back). Must be inside ${PAN_ARC_START_DEG}..180..${PAN_ARC_END_DEG}`),
        pitchRangeDeg: z.number().min(1).max(50).optional().describe('Total pitch span, centered on -10 (default 30, i.e. -25..+5)'),
        stations: z.number().int().min(1).max(12).optional().describe('How many tripod positions this dome will be repeated from (default 1). Only annotates the result — the pause between stations lives in POST /api/grid-capture.'),
      },
    },
    async ({ yawCount, pitchCount, yawRangeDeg, yawCenterDeg, pitchRangeDeg, stations }) => {
      // Plan against the arc the backend has MEASURED from this tripod position, if it has one.
      // Without this the tool is a pure function of constants that were measured somewhere else,
      // which is how a plan comes back looking valid and drives into a stop. Falls back to the
      // constants — and says which it used — when the backend is unreachable or has nothing
      // measured; it never refuses to plan.
      let arc = DEFAULT_PAN_ARC;
      try {
        const status = await backendFetch('/api/status');
        if (status?.panArc?.source === 'measured') {
          arc = makeArc({ startDeg: status.panArc.startDeg, endDeg: status.panArc.endDeg, source: 'measured', measuredAt: status.panArc.measuredAt });
        }
      } catch {
        /* no backend to ask; the fallback is reported below rather than assumed silently */
      }
      const yCount = yawCount ?? 7;
      const pCount = pitchCount ?? 2;
      const pRange = pitchRangeDeg ?? 30;
      const stationCount = stations ?? 1;
      let dome;
      try {
        dome = planDomePans({ centerDeg: yawCenterDeg, spanDeg: yawRangeDeg ?? DEFAULT_PAN_SPAN_DEG, count: yCount, arc });
      } catch (err) {
        return errorResult(err);
      }
      // Pitch is centred on -10, not 0: the useful information in a room is below the horizon
      // (floor, furniture, where walls meet), and tilt's measured travel is asymmetric anyway —
      // it converges to about -40 but jams near +16.
      const pitchSteps = Array.from({ length: pCount }, (_, i) => (pCount === 1 ? -10 : -10 - pRange / 2 + (pRange * i) / (pCount - 1)));
      const targets = [];
      let index = 0;
      for (let row = 0; row < pCount; row++) {
        const cols = row % 2 === 0 ? dome.pans.map((v, i) => [i, v]) : dome.pans.map((v, i) => [i, v]).reverse();
        for (const [col, yawDeg] of cols) {
          targets.push({ index: index++, row, col, yawDeg, pitchDeg: Math.round(pitchSteps[row] * 10) / 10 });
        }
      }
      // Belt and braces on the invariant this tool exists to hold: the planner already
      // guarantees it, and an agent acting on a bad plan drives real motors into a real stop.
      const unreachable = unreachablePans(targets.map((t) => t.yawDeg), arc);
      if (unreachable.length) return errorResult(new Error(`planner produced ${unreachable.length} target(s) in the dead zone — this is a bug, do not drive them`));
      return textResult({
        totalTargets: targets.length,
        perStation: targets.length,
        stations: stationCount,
        totalAcrossStations: targets.length * stationCount,
        yaw: {
          centerDeg: dome.centerDeg,
          spanDeg: dome.spanDeg,
          clampedFromDeg: dome.clampedFrom,
          reachableArc: dome.arc,
          // Never printed without its provenance: "measured here" and "measured at some other
          // tripod position" are different claims about the same two numbers.
          reachableArcNote: describeArc(arc),
          ...(arc.source === 'measured' ? {} : { measureItFirst: 'Run probe_pan_arc — the arc is fixed to the tripod base and these limits were measured somewhere else.' }),
        },
        ...(stationCount < MIN_STATIONS_FOR_PARALLAX
          ? {
            warning:
              'One station only. A dome from a single spot is pure rotation — no translational '
              + 'baseline, so structure-from-motion cannot triangulate: measured, 3 of 17 images '
              + 'registered. Repeat this dome from 3-5 tripod positions (not collinear).',
          }
          : {}),
        targets,
      });
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
