// Browser-side client for the standalone Node backend (server/backend.mjs). Talks over
// HTTP for commands/queries and WebSocket for live frame/status streaming — no Web Bluetooth
// involved on this path at all, so no picker, no per-tab connection lifetime.

import { attachJoystick } from './joystick.mjs';
import { attachOrientationReadout } from './orientation.mjs';
import { attachFrameLog } from './frame-log.mjs';
import { attachCoverage } from './coverage.mjs';
import { decodeQuaternion } from '../protocol/telemetry.mjs';
import { decodeFrame } from '../protocol/duml.mjs';

const els = {
  url: document.getElementById('be-url'),
  status: document.getElementById('be-status'),
  scan: document.getElementById('be-btn-scan'),
  devices: document.getElementById('be-devices'),
  connect: document.getElementById('be-btn-connect'),
  disconnect: document.getElementById('be-btn-disconnect'),
  pin: document.getElementById('be-pin'),
  pair: document.getElementById('be-btn-pair'),
  recenter: document.getElementById('be-btn-recenter'),
  landscape: document.getElementById('be-btn-landscape'),
  stickToggle: document.getElementById('be-btn-stick-toggle'),
  orientation: document.getElementById('orientation-server'),
  modeButtons: [...document.querySelectorAll('[data-be-mode]')],
  joystickPad: document.getElementById('be-joystick-pad'),
  rawCmdSet: document.getElementById('be-raw-cmdset'),
  rawCmdId: document.getElementById('be-raw-cmdid'),
  rawPayload: document.getElementById('be-raw-payload'),
  rawSend: document.getElementById('be-btn-raw-send'),
  testMatrix: document.getElementById('be-test-matrix'),
  coverage: document.getElementById('be-coverage'),
  frames: document.getElementById('be-frames'),
  log: document.getElementById('be-log'),
};
const orientationReadout = attachOrientationReadout(els.orientation);

// Clicking a frame-log row or a coverage-grid cell loads it straight into Raw Command so a
// gap in coverage, or an unknown RX frame you just spotted, is one click from being probed.
function loadIntoRawCommand({ cmdSet, cmdId, payloadHex }) {
  els.rawCmdSet.value = cmdSet;
  els.rawCmdId.value = cmdId;
  if (payloadHex !== undefined) els.rawPayload.value = payloadHex;
}
const frameLog = attachFrameLog(els.frames, { onSelect: loadIntoRawCommand });
const coverage = attachCoverage(els.coverage, { onSelect: loadIntoRawCommand });

function hexToBytes(hex) {
  return new Uint8Array((hex.match(/../g) || []).map((b) => parseInt(b, 16)));
}

// Every outbound command comes back from the backend as a fully-encoded frameHex string, not
// decomposed fields — decode it (the same codec used everywhere else) rather than maintaining a
// second cmdSet/cmdId lookup table per command type, so this can't drift out of sync with
// commands.mjs. Feeds both the frame inspector (always) and the coverage grid (when the caller
// has a verdict, e.g. from the test matrix's moved/no-movement probe).
function logTxFrame(frameHex, { label, verdict } = {}) {
  try {
    const frame = decodeFrame(hexToBytes(frameHex));
    frameLog.add({
      at: Date.now(),
      dir: 'tx',
      cmdSet: frame.cmdSet,
      cmdId: frame.cmdId,
      flags: frame.flags,
      msgId: frame.msgId,
      payloadHex: Array.from(frame.payload).map((b) => b.toString(16).padStart(2, '0')).join(''),
    });
    coverage.record(frame.cmdSet, frame.cmdId, { label, verdict: verdict || 'sent' });
    return frame;
  } catch (err) {
    frameLog.add({ at: Date.now(), dir: 'tx', error: `decode failed: ${err.message}`, note: frameHex });
    return null;
  }
}

// One row per corrected command variant worth testing live against the real gimbal.
// `stop` (for the speed nudges, which move continuously) is fired AFTER the before/after
// telemetry read, so the delta reflects the nudge itself and the gimbal doesn't keep spinning.
const TEST_DEFS = [
  { id: 'stick-enable', label: 'Stick control: Enable', desc: 'stickControlEnable(true) — HIGH confidence, disassembly-confirmed. Precondition for motion commands?', type: 'stickControlEnable', params: { enable: true }, waitMs: 800 },
  { id: 'stick-disable', label: 'Stick control: Disable', desc: 'stickControlEnable(false)', type: 'stickControlEnable', params: { enable: false }, waitMs: 800 },
  { id: 'recenter', label: 'Recenter (0,0,0)', desc: 'absoluteAngle all-zero — MEDIUM confidence struct shape', type: 'recenter', params: { durationSeconds: 1 }, waitMs: 2000 },
  { id: 'angle-pitch-up', label: 'Angle: Pitch +20°', desc: 'absoluteAngle pitchDeg=20', type: 'absoluteAngle', params: { pitchDeg: 20, durationSeconds: 1 }, waitMs: 2000 },
  { id: 'angle-pitch-down', label: 'Angle: Pitch -20°', desc: 'absoluteAngle pitchDeg=-20', type: 'absoluteAngle', params: { pitchDeg: -20, durationSeconds: 1 }, waitMs: 2000 },
  { id: 'angle-yaw-right', label: 'Angle: Yaw +20°', desc: 'absoluteAngle yawDeg=20', type: 'absoluteAngle', params: { yawDeg: 20, durationSeconds: 1 }, waitMs: 2000 },
  { id: 'angle-yaw-left', label: 'Angle: Yaw -20°', desc: 'absoluteAngle yawDeg=-20', type: 'absoluteAngle', params: { yawDeg: -20, durationSeconds: 1 }, waitMs: 2000 },
  { id: 'speed-pan-right', label: 'Speed: Pan right (nudge)', desc: 'speed yawDegPerSec=30 for ~0.9s, then auto-stop — axis/sign live-verified via joystick 2026-08-21', type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 900, stop: { type: 'speed', params: {} } },
  { id: 'speed-pan-left', label: 'Speed: Pan left (nudge)', desc: 'speed yawDegPerSec=-30', type: 'speed', params: { yawDegPerSec: -30 }, waitMs: 900, stop: { type: 'speed', params: {} } },
  { id: 'speed-tilt-up', label: 'Speed: Tilt up (nudge)', desc: 'speed pitchDegPerSec=30 — positive now means tilt UP (axis fix 2026-08-21)', type: 'speed', params: { pitchDegPerSec: 30 }, waitMs: 900, stop: { type: 'speed', params: {} } },
  { id: 'speed-tilt-down', label: 'Speed: Tilt down (nudge)', desc: 'speed pitchDegPerSec=-30', type: 'speed', params: { pitchDegPerSec: -30 }, waitMs: 900, stop: { type: 'speed', params: {} } },
  { id: 'reset-center', label: 'Reset & center', desc: 'resetAndCenter — LOW confidence, speculative payload', type: 'resetAndCenter', params: {}, waitMs: 2000 },
  { id: 'mode-lock', label: 'Orientation: byte 0', desc: 'setMode(lock) — CONFIRMED this is a portrait/landscape toggle, not lock/follow/fpv (see commands.mjs)', type: 'setMode', params: { mode: 'lock' }, waitMs: 1200 },
  { id: 'mode-follow', label: 'Orientation: byte 1 (landscape)', desc: 'setMode(follow) — live-confirmed 2026-08-21: rotates phone mount to landscape', type: 'setMode', params: { mode: 'follow' }, waitMs: 1200 },
  { id: 'mode-fpv', label: 'Orientation: byte 2', desc: 'setMode(fpv)', type: 'setMode', params: { mode: 'fpv' }, waitMs: 1200 },
];

function log(line, cls = '') {
  const row = document.createElement('div');
  if (cls) row.className = cls;
  row.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
}

function baseUrl() {
  return els.url.value.replace(/\/$/, '');
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Can't reach ${baseUrl()} — is the backend running? Start it with "npm run backend" in a terminal.`);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function setConnectedControlsEnabled(enabled) {
  for (const el of [els.disconnect, els.pin, els.pair, els.recenter, els.landscape, els.stickToggle, ...els.modeButtons, els.rawSend, ...testButtons]) {
    el.disabled = !enabled;
  }
  els.joystickPad.classList.toggle('disabled', !enabled);
}

// Auto-reconnects on a fixed interval so the page picks up the backend the moment you start it
// (or if it restarts mid-session) without a manual reload. Logging is debounced to once per
// down-streak — otherwise every retry tick would spam the log while the backend is simply not
// up yet, which is the common case while you're still starting it in a terminal.
let ws = null;
let reconnectTimer = null;
let hasLoggedDown = false;
const RECONNECT_MS = 2000;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, RECONNECT_MS);
}

// Remembers the last device we successfully connected to (noble reconnects by peripheral id
// with no scan needed, same as a manual dropdown pick) so a page reload doesn't require
// re-scanning and re-selecting by hand. "Forgetting" just clears this — connect() itself has
// no server-side notion of a remembered device to forget.
const DEVICE_ID_KEY = 'osmo-be-device-id';
function rememberDevice(deviceId) {
  try {
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  } catch {
    /* private browsing / storage disabled — just won't persist across reloads */
  }
}
function forgetDevice() {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    /* ignore */
  }
}

// Runs once per page load, the first time we learn the backend is up but not connected to a
// gimbal. Tries the remembered device id first (fast, no scan); if that fails — the device is
// off, out of range, or its id changed — forgets it and falls back to a fresh scan, connecting
// to the top-ranked (likelyOsmo, then strongest rssi) result.
let autoconnectAttempted = false;
async function tryAutoconnect() {
  if (autoconnectAttempted) return;
  autoconnectAttempted = true;

  let deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    /* ignore */
  }

  if (deviceId) {
    try {
      const info = await api('POST', '/api/connect', { deviceId });
      log(`Auto-connected to remembered device (${deviceId.slice(0, 8)}…). Service ${info.serviceUuid}`, 'ok');
      return;
    } catch (err) {
      log(`Auto-connect to remembered device failed (${err.message}) — forgetting it and rescanning.`, 'warn');
      forgetDevice();
    }
  }

  try {
    log('Auto-connect: scanning for the gimbal...');
    const { devices } = await api('POST', '/api/scan', { timeoutMs: 5000 });
    els.devices.innerHTML = '';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.likelyOsmo ? '★ ' : ''}${d.name} (${d.id.slice(0, 8)}…) rssi=${d.rssi}`;
      els.devices.appendChild(opt);
    }
    els.connect.disabled = devices.length === 0;
    if (!devices.length) {
      log('Auto-connect: no devices found nearby.', 'warn');
      return;
    }
    const best = devices[0]; // scan() already ranks likelyOsmo first, then strongest rssi
    els.devices.value = best.id;
    const info = await api('POST', '/api/connect', { deviceId: best.id });
    rememberDevice(best.id);
    log(`Auto-connected to ${best.name} (${best.id.slice(0, 8)}…). Service ${info.serviceUuid}`, 'ok');
  } catch (err) {
    log(`Auto-connect failed: ${err.message}`, 'warn');
  }
}

function connectWs() {
  const wsUrl = baseUrl().replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(wsUrl);
  ws.addEventListener('open', () => {
    els.status.textContent = 'backend connected';
    log(`WS connected to ${wsUrl}`, 'ok');
    hasLoggedDown = false;
  });
  ws.addEventListener('close', () => {
    els.status.textContent = `backend not reachable at ${baseUrl()} — start it with "npm run backend" in a terminal (auto-retrying every ${RECONNECT_MS / 1000}s)`;
    setConnectedControlsEnabled(false);
    if (!hasLoggedDown) {
      log(`WS closed — will keep retrying ${wsUrl} every ${RECONNECT_MS / 1000}s until the backend is up`, 'warn');
      hasLoggedDown = true;
    }
    scheduleReconnect();
  });
  ws.addEventListener('error', () => {
    /* 'close' always follows 'error' for a WebSocket — logging/retry is handled there. */
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'status') {
      setConnectedControlsEnabled(msg.connected);
      els.status.textContent = `backend: ${msg.connected ? 'connected' : 'not connected'}${msg.paired ? ', paired' : ''}`;
      if (!msg.connected) tryAutoconnect();
    } else if (msg.type === 'frame') {
      if (msg.error) {
        frameLog.add({ at: msg.at, dir: 'rx', error: msg.error });
      } else {
        frameLog.add({ at: msg.at, dir: 'rx', cmdSet: msg.cmdSet, cmdId: msg.cmdId, flags: msg.flags, msgId: msg.msgId, payloadHex: msg.payloadHex });
        const payload = new Uint8Array((msg.payloadHex.match(/../g) || []).map((b) => parseInt(b, 16)));
        const quat = decodeQuaternion({ cmdSet: msg.cmdSet, cmdId: msg.cmdId, payload });
        if (quat) orientationReadout.update(quat);
      }
    }
  });
}
connectWs();

els.scan.addEventListener('click', async () => {
  els.scan.disabled = true;
  try {
    log('Scanning (5s)...');
    const { devices } = await api('POST', '/api/scan', { timeoutMs: 5000 });
    els.devices.innerHTML = '';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.likelyOsmo ? '★ ' : ''}${d.name} (${d.id.slice(0, 8)}…) rssi=${d.rssi}`;
      els.devices.appendChild(opt);
    }
    log(`Found ${devices.length} device(s).`, 'ok');
    els.connect.disabled = devices.length === 0;
  } catch (err) {
    log(`Scan failed: ${err.message}`, 'warn');
  } finally {
    els.scan.disabled = false;
  }
});

els.connect.addEventListener('click', async () => {
  const deviceId = els.devices.value;
  if (!deviceId) return;
  try {
    const info = await api('POST', '/api/connect', { deviceId });
    rememberDevice(deviceId);
    log(`Connected. Service ${info.serviceUuid}, characteristics: ${info.characteristics.map((c) => `${c.uuid}[${c.properties.join(',')}]`).join(', ')}`, 'ok');
  } catch (err) {
    log(`Connect failed: ${err.message}`, 'warn');
  }
});

els.disconnect.addEventListener('click', async () => {
  try {
    await api('POST', '/api/disconnect');
    log('Disconnected.');
  } catch (err) {
    log(`Disconnect failed: ${err.message}`, 'warn');
  }
});

els.pair.addEventListener('click', async () => {
  const pin = els.pin.value.trim();
  if (!pin) {
    log('Enter the PIN shown on the device screen first.', 'warn');
    return;
  }
  try {
    const result = await api('POST', '/api/pair', { pin });
    log(`Pair result: ${JSON.stringify(result)}`, 'ok');
  } catch (err) {
    log(`Pair failed: ${err.message}`, 'warn');
  }
});

// Uses resetAndCenter (cmdId 0x4C), not the absoluteAngle(0,0,0) "recenter" builder — disassembly
// identified 0x4C as DJI's actual dedicated recenter action (SDK alias "action_gimbal_set_reset");
// 0x14 was only ever a guessed struct shape with no confirmed real-world behavior, and testing
// showed it does nothing. The command-test-matrix below still has both for comparison.
els.recenter.addEventListener('click', async () => {
  try {
    const { frameHex } = await api('POST', '/api/command', { type: 'resetAndCenter', params: {} });
    logTxFrame(frameHex, { label: 'ResetAndCenter' });
  } catch (err) {
    log(`Recenter failed: ${err.message}`, 'warn');
  }
});

for (const btn of els.modeButtons) {
  btn.addEventListener('click', async () => {
    try {
      const { frameHex } = await api('POST', '/api/command', { type: 'setMode', params: { mode: btn.dataset.beMode } });
      logTxFrame(frameHex, { label: `SetMode(${btn.dataset.beMode})` });
    } catch (err) {
      log(`Set mode failed: ${err.message}`, 'warn');
    }
  });
}

// Promoted to the main view: the one cmdId-0x44 value with confirmed real-world behavior
// (rotates the phone mount to landscape) — see the drawer's "Orientation toggle" section for
// the other two still-unresolved byte values.
els.landscape.addEventListener('click', async () => {
  try {
    const { frameHex } = await api('POST', '/api/command', { type: 'setMode', params: { mode: 'follow' } });
    logTxFrame(frameHex, { label: 'SetMode(follow / landscape)' });
  } catch (err) {
    log(`Landscape toggle failed: ${err.message}`, 'warn');
  }
});

// Promoted to the main view since the test matrix flags this as a possible precondition for
// motion commands to be honored — a local toggle (not read back from the device, which has no
// query for this state) tracking what we last told it.
let stickEnabled = false;
els.stickToggle.addEventListener('click', async () => {
  const next = !stickEnabled;
  try {
    const { frameHex } = await api('POST', '/api/command', { type: 'stickControlEnable', params: { enable: next } });
    logTxFrame(frameHex, { label: `StickControlEnable(${next})` });
    stickEnabled = next;
    els.stickToggle.textContent = `Stick: ${stickEnabled ? 'ON' : 'OFF'}`;
    els.stickToggle.classList.toggle('active', stickEnabled);
  } catch (err) {
    log(`Stick control toggle failed: ${err.message}`, 'warn');
  }
});

attachJoystick(els.joystickPad, {
  onMove: (vector) => {
    api('POST', '/api/command', { type: 'speed', params: vector }).catch((err) => log(`Joystick move failed: ${err.message}`, 'warn'));
  },
  onStop: () => {
    api('POST', '/api/command', { type: 'speed', params: {} }).catch(() => {
      /* best-effort stop */
    });
  },
});

els.rawSend.addEventListener('click', async () => {
  try {
    const params = {
      cmdSet: Number(els.rawCmdSet.value),
      cmdId: Number(els.rawCmdId.value),
      payloadHex: els.rawPayload.value.trim().replace(/\s+/g, ''),
    };
    const { frameHex } = await api('POST', '/api/command', { type: 'raw', params });
    logTxFrame(frameHex, { label: 'Raw (manual probe)' });
  } catch (err) {
    log(`Raw send failed: ${err.message}`, 'warn');
  }
});

// Build the labeled test matrix rows from TEST_DEFS. Each button fires its command via the
// generic /api/test/command-probe endpoint and shows an inline moved/no-movement verdict, so
// you can pair what you see on the physical gimbal with an objective telemetry-based check.
const testButtons = [];
for (const def of TEST_DEFS) {
  const row = document.createElement('div');
  row.className = 'test-row';

  const btn = document.createElement('button');
  btn.textContent = def.label;
  btn.disabled = true;
  row.appendChild(btn);

  const desc = document.createElement('span');
  desc.className = 'test-desc';
  desc.textContent = def.desc;
  row.appendChild(desc);

  const verdict = document.createElement('span');
  verdict.className = 'verdict';
  row.appendChild(verdict);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    verdict.textContent = 'running...';
    verdict.className = 'verdict';
    try {
      const result = await api('POST', '/api/test/command-probe', {
        type: def.type,
        params: def.params,
        waitMs: def.waitMs,
        stop: def.stop,
      });
      verdict.textContent = result.moved
        ? `MOVED (delta=${result.delta.toFixed(4)})`
        : `no detected movement (delta=${result.delta === null ? 'n/a — no telemetry yet' : result.delta.toFixed(4)})`;
      verdict.className = 'verdict ' + (result.moved ? 'moved' : 'notmoved');
      logTxFrame(result.sent.frameHex, {
        label: def.label,
        verdict: result.moved ? 'moved' : result.delta === null ? 'sent' : 'no-movement',
      });
    } catch (err) {
      verdict.textContent = `error: ${err.message}`;
      verdict.className = 'verdict';
      log(`[${def.label}] failed: ${err.message}`, 'warn');
    } finally {
      btn.disabled = false;
    }
  });

  els.testMatrix.appendChild(row);
  testButtons.push(btn);
}
