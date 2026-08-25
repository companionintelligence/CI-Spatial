#!/usr/bin/env node
// Standalone Node backend that owns the BLE connection to the Osmo (via @stoprocent/noble)
// and exposes it over HTTP + WebSocket, so the web UI (or any other client) can control the
// device without the browser holding the connection itself. This sidesteps Web Bluetooth's
// per-session device-picker requirement entirely — once you've scanned/connected once, noble
// reconnects by peripheral id with no user gesture needed, unlike navigator.bluetooth.
//
// Run with `npm run backend`. Must be started from a normal interactive session — a headless/
// automated process launch may never get the macOS Bluetooth permission prompt and will hang
// on the first BLE call (see ../README.md "Known environment gotcha").

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { OsmoBleTransport } from './ble-transport.mjs';
import { buildGimbalRecenter, buildGimbalAbsoluteAngle, buildGimbalSetMode, buildGimbalSpeedControl, buildGimbalStickControlEnable, buildGimbalResetAndCenter, buildRawCommand } from '../protocol/commands.mjs';
import { GIMBAL_MODE } from '../protocol/constants.mjs';
import { quaternionDelta, quatToGimbalControlDeg } from '../protocol/telemetry.mjs';
import { AndroidMcpClient, capturePhoto, planGrid } from './android-capture.mjs';

const PORT = Number(process.env.BACKEND_PORT) || 8788;
const transport = new OsmoBleTransport();

const wsClients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

transport.on('frame', (frame) => {
  broadcast({
    type: 'frame',
    at: frame.at,
    sourceCharUuid: frame.sourceCharUuid,
    error: frame.error ? String(frame.error.message || frame.error) : undefined,
    sender: frame.sender,
    receiver: frame.receiver,
    msgId: frame.msgId,
    flags: frame.flags,
    cmdSet: frame.cmdSet,
    cmdId: frame.cmdId,
    payloadHex: frame.payload ? Buffer.from(frame.payload).toString('hex') : undefined,
  });
});
transport.on('disconnect', () => broadcast({ type: 'status', connected: false, paired: false }));

function statusPayload() {
  return { connected: transport.connected, paired: transport.paired, lastQuaternion: transport.lastQuaternion };
}

function sendJson(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const GIMBAL_MODE_BY_NAME = { lock: GIMBAL_MODE.LOCK, follow: GIMBAL_MODE.FOLLOW, fpv: GIMBAL_MODE.FPV };

async function buildAndSend(type, params = {}) {
  let frame;
  switch (type) {
    case 'recenter':
      frame = buildGimbalRecenter(transport.nextMsgId(), params.durationSeconds ?? 1);
      break;
    case 'absoluteAngle':
      frame = buildGimbalAbsoluteAngle(transport.nextMsgId(), params);
      break;
    case 'setMode': {
      const mode = GIMBAL_MODE_BY_NAME[params.mode];
      if (mode === undefined) throw new Error(`Unknown mode "${params.mode}" (expected lock/follow/fpv)`);
      frame = buildGimbalSetMode(transport.nextMsgId(), mode);
      break;
    }
    case 'speed':
      frame = buildGimbalSpeedControl(transport.nextMsgId(), params);
      break;
    case 'stickControlEnable':
      frame = buildGimbalStickControlEnable(transport.nextMsgId(), params.enable ?? true);
      break;
    case 'resetAndCenter': {
      const mode = params.mode !== undefined ? GIMBAL_MODE_BY_NAME[params.mode] : undefined;
      frame = buildGimbalResetAndCenter(transport.nextMsgId(), mode);
      break;
    }
    case 'raw':
      frame = buildRawCommand(transport.nextMsgId(), params);
      break;
    default:
      throw new Error(`Unknown command type "${type}"`);
  }
  await transport.sendRaw(frame);
  return { frameHex: Buffer.from(frame).toString('hex') };
}

function wrapDeg(d) {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

/**
 * Closed-loop absolute positioning, built to replace the broken absolute-angle opcode
 * (cmdId 0x14 — live-tested 2026-08-21 and confirmed to do nothing on this hardware; the real
 * angle-set commands per disassembly are larger structs our guess never matched). Uses the
 * CONFIRMED-working speed-control command instead, driven by live quaternion feedback via
 * quatToGimbalControlDeg's pan/tilt.
 *
 * Feedback axis (fixed 2026-08-24): steer on pan/tilt, never the raw `yaw` channel. This used
 * to read quatToEulerDeg().yaw, which on a real mounted OM6 is pinned at -90 while physical pan
 * lands in `roll` — so the error never changed, the sign-flip below never had a gradient, and
 * every call ran to maxMs with a flat history. That looked exactly like "the gimbal ignored the
 * command," and was misdiagnosed as such twice before the channels were measured directly. See
 * quatToGimbalControlDeg for the numbers.
 *
 * Two remaining sources of imprecision, both handled defensively rather than assumed away:
 *   1. Euler angles from a tilted device still mix axes — pan/tilt is a relative-change
 *      indicator, not a calibrated attitude readout, so treat convergence as "close enough,"
 *      not exact.
 *   2. We don't have an independently-verified mapping between the pan/tilt sign and which
 *      physical direction a positive commanded speed drives each axis. Rather than assume a
 *      correspondence and risk silently correcting in the wrong direction forever, each axis
 *      adaptively flips its sign the first time a nonzero-speed tick makes that axis's error
 *      worse instead of better — self-correcting regardless of which way the mapping runs.
 *      (Observable in a real run: tick 2 often steps backwards once, then drives straight in.)
 */
async function moveToClosedLoop({ yawDeg = 0, pitchDeg = 0, toleranceDeg = 3, speedDegPerSec = 25, tickMs = 250, settleMs = 150, maxMs = 8000 }) {
  const start = Date.now();
  const history = [];
  let yawSign = 1;
  let pitchSign = 1;
  let prevYawError = null;
  let prevPitchError = null;

  while (Date.now() - start < maxMs) {
    const quat = transport.lastQuaternion;
    if (!quat) {
      await new Promise((resolve) => setTimeout(resolve, tickMs));
      continue;
    }
    // pan/tilt, NOT the raw yaw/pitch channels — the gimbal's `yaw` channel is pinned at -90
    // at this mount orientation and physical pan shows up in `roll` instead. Steering on `yaw`
    // is what made every move-to run to timeout with a flat history. See
    // quatToGimbalControlDeg's comment for the measurements.
    const { pan: yaw, tilt: pitch } = quatToGimbalControlDeg(quat);
    const yawError = wrapDeg(yawDeg - yaw);
    const pitchError = pitchDeg - pitch;

    if (prevYawError !== null && Math.abs(yawError) > Math.abs(prevYawError) + 0.5) yawSign *= -1;
    if (prevPitchError !== null && Math.abs(pitchError) > Math.abs(prevPitchError) + 0.5) pitchSign *= -1;

    history.push({ tMs: Date.now() - start, yaw, pitch, yawError, pitchError });
    if (Math.abs(yawError) <= toleranceDeg && Math.abs(pitchError) <= toleranceDeg) {
      return { converged: true, timedOut: false, ticks: history.length, finalYaw: yaw, finalPitch: pitch, history };
    }

    const yawSpeed = Math.abs(yawError) > toleranceDeg ? Math.sign(yawError) * yawSign * speedDegPerSec : 0;
    const pitchSpeed = Math.abs(pitchError) > toleranceDeg ? Math.sign(pitchError) * pitchSign * speedDegPerSec : 0;

    await transport.sendRaw(buildGimbalSpeedControl(transport.nextMsgId(), { yawDegPerSec: yawSpeed, pitchDegPerSec: pitchSpeed }));
    await new Promise((resolve) => setTimeout(resolve, tickMs));
    await transport.sendRaw(buildGimbalSpeedControl(transport.nextMsgId(), {}));
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    prevYawError = yawError;
    prevPitchError = pitchError;
  }

  const quat = transport.lastQuaternion;
  const final = quat ? quatToGimbalControlDeg(quat) : { pan: null, tilt: null };
  return { converged: false, timedOut: true, ticks: history.length, finalYaw: final.pan, finalPitch: final.tilt, history };
}

const routes = {
  'GET /': async () => [
    200,
    {
      ok: true,
      message: 'Osmo BLE backend is running.',
      routes: ['GET /api/status', 'POST /api/scan', 'POST /api/connect', 'POST /api/pair-trigger', 'POST /api/pair', 'POST /api/disconnect', 'POST /api/command', 'POST /api/move-to', 'POST /api/grid-capture', 'GET /api/frames', 'POST /api/test/recenter-probe', 'POST /api/test/command-probe', 'WS /ws'],
    },
  ],
  'GET /api/status': async () => [200, statusPayload()],

  'POST /api/scan': async (req) => {
    const { timeoutMs } = await readJsonBody(req);
    const devices = await transport.scan(timeoutMs ?? 5000);
    return [200, { devices }];
  },

  'POST /api/connect': async (req) => {
    const { deviceId } = await readJsonBody(req);
    if (!deviceId) return [400, { error: 'deviceId is required' }];
    const info = await transport.connect(deviceId);
    broadcast({ type: 'status', ...statusPayload() });
    return [200, { connected: true, ...info }];
  },

  // Separate from /api/pair so a caller without a PIN yet can make the device show one, rather
  // than guessing at the required `pin` on /api/pair — see triggerPairing()'s own comment for
  // why guessing is worse than just not pairing (real device-side lockout risk).
  'POST /api/pair-trigger': async () => {
    await transport.triggerPairing();
    return [200, { triggered: true }];
  },

  'POST /api/pair': async (req) => {
    const { pin, identifier } = await readJsonBody(req);
    if (!pin) return [400, { error: 'pin is required (read it off the device screen)' }];
    const result = await transport.pair(pin, { identifier });
    broadcast({ type: 'status', ...statusPayload() });
    return [200, result];
  },

  'POST /api/disconnect': async () => {
    await transport.disconnect();
    broadcast({ type: 'status', ...statusPayload() });
    return [200, { disconnected: true }];
  },

  'POST /api/command': async (req) => {
    const { type, params } = await readJsonBody(req);
    const result = await buildAndSend(type, params);
    return [200, result];
  },

  // Closed-loop absolute positioning — see moveToClosedLoop's own comment for why this exists
  // instead of the absolute-angle command (confirmed non-functional on this hardware).
  'POST /api/move-to': async (req) => {
    const { yawDeg, pitchDeg, toleranceDeg, speedDegPerSec, tickMs, settleMs, maxMs } = await readJsonBody(req);
    const result = await moveToClosedLoop({ yawDeg, pitchDeg, toleranceDeg, speedDegPerSec, tickMs, settleMs, maxMs });
    return [200, result];
  },

  // Drive a full grid capture: move -> photo -> move -> photo, for every position. Lives here
  // rather than in the CLI or the web UI so both get the same implementation and, more
  // importantly, so exactly one process ever holds an MCP session to the phone — the device
  // caps concurrent sessions (see android-capture.mjs). Progress is broadcast over the existing
  // WS as it goes, because a 9-position run takes minutes and a silent HTTP request that long
  // is indistinguishable from a hang.
  'POST /api/grid-capture': async (req) => {
    const body = await readJsonBody(req);
    const pans = body.pans ?? [120, 145, 170];
    const tilts = body.tilts ?? [-10, 0, 10];
    const deviceUrl = body.deviceUrl ?? process.env.ANDROID_MCP_URL;
    const deviceToken = body.deviceToken ?? process.env.ANDROID_MCP_TOKEN;
    if (!deviceUrl) return [400, { error: 'deviceUrl is required (or set ANDROID_MCP_URL)' }];
    if (!deviceToken) return [400, { error: 'deviceToken is required (or set ANDROID_MCP_TOKEN) — see .env.example' }];
    if (!transport.connected) return [400, { error: 'not connected to a gimbal — scan + connect first' }];

    const grid = planGrid({ pans, tilts });
    const prefix = body.prefix ?? `grid-${Date.now()}`;
    const client = new AndroidMcpClient({ url: deviceUrl, token: deviceToken });
    const results = [];

    broadcast({ type: 'grid-progress', phase: 'start', total: grid.length });
    try {
      await client.open();
      for (const [i, target] of grid.entries()) {
        const position = i + 1;
        broadcast({ type: 'grid-progress', phase: 'moving', position, total: grid.length, target });

        const move = await moveToClosedLoop({
          yawDeg: target.pan,
          pitchDeg: target.tilt,
          toleranceDeg: body.toleranceDeg ?? 5,
          maxMs: body.maxMs ?? 15000,
        });

        // A non-converged move is recorded, not fatal: a photo from a position that is merely
        // close is still usable, and aborting the whole run would throw away the frames already
        // captured. The caller decides what to do with `converged: false`.
        broadcast({ type: 'grid-progress', phase: 'capturing', position, total: grid.length, converged: move.converged });
        const photoUrl = await capturePhoto(client, {
          path: `${prefix}/pos-${String(position).padStart(2, '0')}.jpg`,
          cameraId: body.cameraId ?? '0',
          resolution: body.resolution ?? '1280x720',
          quality: body.quality ?? 85,
        });

        const entry = { position, target, converged: move.converged, ticks: move.ticks, pan: move.finalYaw, tilt: move.finalPitch, photoUrl };
        results.push(entry);
        broadcast({ type: 'grid-progress', phase: 'captured', ...entry, total: grid.length });
      }
    } catch (err) {
      broadcast({ type: 'grid-progress', phase: 'error', error: String(err.message || err), captured: results.length });
      // Partial results are returned alongside the error — the frames already on the phone are
      // real and the caller may still want them.
      return [500, { error: String(err.message || err), captured: results.length, results }];
    } finally {
      await client.close();
    }

    const converged = results.filter((r) => r.converged).length;
    broadcast({ type: 'grid-progress', phase: 'done', total: grid.length, converged });
    return [200, { prefix, total: grid.length, converged, results }];
  },

  'GET /api/frames': async (req, url) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return [200, { frames: transport.frames.slice(-limit) }];
  },

  // Automated test: capture orientation, send a command, capture orientation again, and
  // report whether it actually changed — the fastest way to confirm (or rule out) that a
  // given command physically moves the gimbal over BLE-only.
  'POST /api/test/recenter-probe': async (req) => {
    const { durationSeconds } = await readJsonBody(req);
    const before = transport.lastQuaternion;
    await buildAndSend('recenter', { durationSeconds: durationSeconds ?? 1 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after = transport.lastQuaternion;
    const delta = quaternionDelta(before, after);
    return [200, { before, after, delta, moved: delta !== null && delta > 0.02 }];
  },

  // Generic version of the above: fires ANY command type/params, captures orientation
  // before/after, and optionally fires a second "stop" command afterward (for speed-control
  // nudges, which move continuously until told to stop). Backs the labeled test-matrix buttons
  // in the web UI so each corrected command builder can be probed against real hardware and
  // given an objective moved/not-moved verdict, not just eyeballed.
  'POST /api/test/command-probe': async (req) => {
    const { type, params, waitMs, stop } = await readJsonBody(req);
    if (!type) return [400, { error: 'type is required' }];
    const before = transport.lastQuaternion;
    const sent = await buildAndSend(type, params ?? {});
    await new Promise((resolve) => setTimeout(resolve, waitMs ?? 1500));
    const after = transport.lastQuaternion;
    const delta = quaternionDelta(before, after);
    if (stop) await buildAndSend(stop.type, stop.params ?? {});
    return [200, { sent, before, after, delta, moved: delta !== null && delta > 0.02 }];
  },
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) {
    sendJson(res, 404, { error: `No route for ${key}` });
    return;
  }
  try {
    const [code, body] = await handler(req, url);
    sendJson(res, code, body);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'status', ...statusPayload() }));
  ws.on('close', () => wsClients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`Osmo BLE backend: http://localhost:${PORT}  (WebSocket at /ws)`);
});
