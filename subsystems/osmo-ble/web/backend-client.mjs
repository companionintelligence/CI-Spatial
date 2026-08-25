// Browser-side client for the standalone Node backend (server/backend.mjs). Talks over
// HTTP for commands/queries and WebSocket for live frame/status streaming — no Web Bluetooth
// involved on this path at all, so no picker, no per-tab connection lifetime.

import { attachJoystick } from './joystick.mjs';
import { attachOrientationReadout } from './orientation.mjs';
import { attachFrameLog } from './frame-log.mjs';
import { attachCoverage } from './coverage.mjs';
import { decodeQuaternion } from '../protocol/telemetry.mjs';
import { decodeFrame } from '../protocol/duml.mjs';
import { PHONE_TELEMETRY, isPhoneTelemetry } from '../protocol/phone_telemetry.mjs';

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
  gridBothOrientations: document.getElementById('be-grid-both'),
  gridRun: document.getElementById('be-btn-grid'),
  gridProgress: document.getElementById('be-grid-progress'),
  gridBar: document.getElementById('be-grid-bar'),
  captureMode: document.getElementById('be-capture-mode'),
  gridResults: document.getElementById('be-grid-results'),
  gridSummary: document.getElementById('be-grid-summary'),
  scanTypes: [...document.querySelectorAll('#be-scan-types .scan-type')],
  axis: {
    pan: {
      from: document.getElementById('be-pan-from'),
      to: document.getElementById('be-pan-to'),
      step: document.getElementById('be-pan-step'),
    },
    tilt: {
      from: document.getElementById('be-tilt-from'),
      to: document.getElementById('be-tilt-to'),
      step: document.getElementById('be-tilt-step'),
    },
  },
  capture: document.getElementById('be-btn-capture'),
  captureBoth: document.getElementById('be-btn-capture-both'),
  testMatrix: document.getElementById('be-test-matrix'),
  coverage: document.getElementById('be-coverage'),
  frames: document.getElementById('be-frames'),
  log: document.getElementById('be-log'),
};
// showPhone: only this pathway can ever receive phone-sensor frames — they ride the same
// backend WebSocket as gimbal telemetry, which the direct/Web-Bluetooth panel never opens.
const orientationReadout = attachOrientationReadout(els.orientation, { showPhone: true });

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

/**
 * Lock the manual controls while a scan owns the gimbal, and say so loudly.
 *
 * The joystick is the one that actually matters: it streams `speed` commands to the same two
 * motors the grid's closed-loop controller is steering, so a single stray touch mid-run puts
 * two controllers in a fight. That is not hypothetical — it wedged a 105-position dome at one
 * pose for six consecutive positions, each burning the full timeout and photographing the same
 * view. The backend rejects those commands too (409); this is the half that stops the user
 * being offered a control that cannot work.
 */
let scanActive = false;
function setScanActive(active) {
  scanActive = active;
  document.body.classList.toggle('scanning', active);
  // Pointer-events off as well as the visual disable: `.disabled` on the pad is a class the
  // joystick module also uses for "not connected", and a class alone still lets a touch start
  // a drag on some builds.
  els.joystickPad?.classList.toggle('disabled', active || !lastConnected);
  els.joystickPad?.toggleAttribute('inert', active);
  for (const el of [els.recenter, els.landscape, els.stickToggle, els.capture, els.captureBoth]) {
    if (el) el.disabled = active || !lastConnected;
  }
  if (els.gridRun) els.gridRun.disabled = active || !lastConnected;
}

// Tracked so setScanActive can restore the right state when a scan ends: "enabled" is the AND
// of connected and not-scanning, and neither alone is enough to decide it.
let lastConnected = false;

function setConnectedControlsEnabled(enabled) {
  lastConnected = enabled;
  for (const el of [els.disconnect, els.pin, els.pair, els.recenter, els.landscape, els.stickToggle, els.gridRun, els.capture, els.captureBoth, ...els.modeButtons, els.rawSend, ...testButtons]) {
    el.disabled = !enabled;
  }
  els.joystickPad.classList.toggle('disabled', !enabled);
  // A reconnect mid-scan must not hand the joystick back — re-apply the scan lock last.
  if (scanActive) setScanActive(true);
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
    } else if (msg.type === 'grid-progress') {
      renderGridProgress(msg);
    } else if (msg.type === PHONE_TELEMETRY) {
      // The phone's own sensors, relayed onto this same socket. Validated with the shared
      // predicate from the protocol module rather than trusted on the `type` tag alone, and
      // handed to a separate readout entry point — it is a different reference frame from the
      // gimbal quaternion below and the two must never be mixed (see phone_telemetry.mjs).
      if (isPhoneTelemetry(msg)) orientationReadout.updatePhone(msg);
      else log('Dropped a malformed phone-telemetry frame.', 'warn');
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

// A port/landscape TOGGLE, not a one-way "set landscape": alternates between the one
// cmdId-0x44 value with confirmed real-world behavior ('follow' — rotates the phone mount to
// landscape) and byte 0 ('lock'), which is only a best guess at portrait — see the drawer's
// "Orientation toggle" section for why that byte is still unconfirmed. The button label always
// names the orientation a click will move TO, and only ever claims "Portrait" with a caveat.
let currentOrientation = 'landscape'; // assumed starting state; no query exists to read it back
function renderOrientationButton() {
  els.landscape.textContent = currentOrientation === 'landscape' ? 'Portrait*' : 'Landscape';
  els.landscape.title = currentOrientation === 'landscape'
    ? '*byte 0 — best-guess portrait, not independently confirmed'
    : 'Confirmed: rotates the phone mount to landscape';
}
renderOrientationButton();
els.landscape.addEventListener('click', async () => {
  const target = currentOrientation === 'landscape' ? 'lock' : 'follow';
  try {
    const { frameHex } = await api('POST', '/api/command', { type: 'setMode', params: { mode: target } });
    logTxFrame(frameHex, { label: `SetMode(${target}${target === 'follow' ? ' / landscape' : ' / best-guess portrait'})` });
    currentOrientation = target === 'follow' ? 'landscape' : 'portrait';
    renderOrientationButton();
  } catch (err) {
    log(`Orientation toggle failed: ${err.message}`, 'warn');
  }
});

// Every photo path — one-off or scan — runs through the phone's MCP server, and it fails in one
// of two ways you cannot guess from the error text alone. This used to be a permanent paragraph
// under the Auto scan panel; it is screen space spent on something that only matters at the
// moment a capture actually fails, so it is logged there instead.
const MCP_HINT = 'Photos go through the phone\'s MCP server: the backend needs ANDROID_MCP_URL + ANDROID_MCP_TOKEN, and the phone allows one MCP session at a time — detach any other one (e.g. a Claude Code session) first.';

// One-off "take a photo right now" quick actions — not a scan, just the gimbal's current
// position. Both hit /api/capture-photo, which owns its own MCP session to the phone the same
// way /api/grid-capture does (see that endpoint's own comment for why this can't live here).
els.capture?.addEventListener('click', async () => {
  els.capture.disabled = true;
  try {
    log('Capturing photo...');
    const { shots } = await api('POST', '/api/capture-photo', {});
    log(`Captured: ${shots[0]?.photoUrl ?? '(no url)'}`, 'ok');
  } catch (err) {
    log(`Capture failed: ${err.message}`, 'warn');
    log(MCP_HINT, 'warn');
  } finally {
    els.capture.disabled = false;
  }
});
els.captureBoth?.addEventListener('click', async () => {
  els.captureBoth.disabled = true;
  try {
    log('Capturing landscape + best-guess portrait...');
    const { shots } = await api('POST', '/api/capture-photo', { bothOrientations: true });
    for (const s of shots) log(`  ${s.orientation}: ${s.photoUrl}`, 'ok');
  } catch (err) {
    log(`Capture failed: ${err.message}`, 'warn');
    log(MCP_HINT, 'warn');
  } finally {
    els.captureBoth.disabled = false;
  }
});

// ── Scan type + grid parameters ─────────────────────────────────────────────
// Each preset is a from/to/step range per axis, which is what the old comma-separated lists
// already were in disguise.
//
// Ordered widest-first, and `dome` is the default: reconstruction quality is driven by how
// much of the room each station sees, and the failure this pipeline actually keeps hitting is
// too FEW distinct viewing angles, not too many. A measured example from this rig: a capture
// confined to one narrow station classified 29 of 36 image pairs PLANAR_OR_PANORAMIC and
// registered only 4 of 9 images. Defaulting to the widest sweep puts the good outcome on the
// path of least resistance; the narrower presets stay one tap away for a quick check.
//
// Every range sits inside what was actually probed as safe on hardware: yaw sweeps cleanly
// across ~+/-175 degrees provided a single move never has to cross the +/-180 seam, and tilt
// converges down to about -40 degrees but stalls near +16 degrees — a real mechanical limit,
// not a display choice. Nothing here goes past those.
//
// The interior rows of the multi-row presets are interpolations, not separately measured
// angles: they lie between two tilts that were run on hardware, which is a plan choice rather
// than a re-measurement. "Custom" is simply whatever is in the fields.
const SCAN_PRESETS = {
  // Full dome — the default. 21 pan columns x 5 tilt rows = 105 positions. That is a long run
  // (tens of minutes of gimbal-and-phone time), which is exactly why the position count is
  // rendered live under the fields rather than left for the operator to work out.
  dome: { pan: { from: -150, to: 150, step: 15 }, tilt: { from: -30, to: 10, step: 10 } },
  // Quick 25 — a 5x5 block around centre, for a fast look rather than a reconstruction.
  // Deliberately 25 and not 9: nine frames from one station is below what structure-from-motion
  // needs to register reliably, so the old preset produced runs that looked complete and then
  // failed to reconstruct.
  quick25: { pan: { from: -60, to: 60, step: 30 }, tilt: { from: -30, to: 10, step: 10 } },
  // Horizontal band — a wide, shallow sweep for long or corridor-shaped rooms, where the
  // useful information is spread around the horizon rather than up and down. Denser in pan
  // than the old version (17 columns at 20 degrees, was 11 at 30) because pan is the axis that
  // carries the coverage here, and shallower in tilt (2 rows) so it stays a band.
  band: { pan: { from: -160, to: 160, step: 20 }, tilt: { from: -10, to: 5, step: 15 } },
};

// A few hundred positions is hours of gimbal-and-phone time, and a mistyped step is the easy
// way to ask for one by accident (a step of 0 wouldn't terminate at all). Generation stops at
// this many values per axis and the summary line says so, rather than truncating in silence.
const MAX_STEPS_PER_AXIS = 60;

// Mirrors DEFAULT_KEYFRAME_OPTIONS.minRotationDeg in src/capture/keyframes.ts. Duplicated
// rather than imported because that is TypeScript inside the Vite app and this is a plain
// ES module served by a different server — the same deliberate parallel-implementation pair
// as vite.config.ts/server/main.ts's resolveHostname. If the scanner default changes, this
// must change with it, and nothing will fail loudly.
const SCANNER_MIN_ROTATION_DEG = 20;

function axisValues({ from, to, step }) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const stride = Math.max(1, Math.abs(step));
  const out = [];
  // The 1e-9 slack keeps the far endpoint in when lo/hi/stride divide evenly but land a hair
  // under hi through float accumulation.
  for (let v = lo; v <= hi + 1e-9 && out.length < MAX_STEPS_PER_AXIS; v += stride) {
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}

// An empty or half-typed field reads as 0 rather than NaN — mid-edit the box is legitimately
// blank, and a NaN would poison the whole grid instead of just that number.
function readAxis(name) {
  const group = els.axis[name];
  const num = (el) => {
    const v = Number(el.value);
    return el.value.trim() !== '' && Number.isFinite(v) ? v : 0;
  };
  return { from: num(group.from), to: num(group.to), step: num(group.step) };
}

function currentGrid() {
  const pan = readAxis('pan');
  const tilt = readAxis('tilt');
  return { pans: axisValues(pan), tilts: axisValues(tilt) };
}

// The position count was never visible before the run started — the old free-text lists made
// you count commas. It is the number that decides whether this is a two-minute or a two-hour
// run, so it is stated next to the control that sets it.
function renderGridSummary() {
  const { pans, tilts } = currentGrid();
  const total = document.createElement('strong');
  total.textContent = `${pans.length * tilts.length} positions`;
  const detail = document.createElement('span');
  detail.textContent = ` · pan ${pans[0]}…${pans[pans.length - 1]}° ×${pans.length} · tilt ${tilts[0]}…${tilts[tilts.length - 1]}° ×${tilts.length}`;
  els.gridSummary.replaceChildren(total, detail);
  if (pans.length >= MAX_STEPS_PER_AXIS || tilts.length >= MAX_STEPS_PER_AXIS) {
    const capped = document.createElement('span');
    capped.className = 'gp-capped';
    capped.textContent = ` · capped at ${MAX_STEPS_PER_AXIS} per axis`;
    els.gridSummary.appendChild(capped);
  }

  // Scanner mode has a step floor that camera mode does not, and getting it wrong fails
  // SILENTLY: the scanner emits a keyframe only once the camera has rotated at least
  // minRotationDeg (default 20), so a finer grid drives the gimbal through every position and
  // captures nothing at some of them. The run reports 105/105 "converged" and the session ends
  // up with far fewer frames than positions, which looks like a capture bug rather than a
  // configuration one. Say so before the run, not after.
  if (els.captureMode?.value === 'scanner') {
    const panStep = Math.abs(readAxis('pan').step);
    const tiltStep = Math.abs(readAxis('tilt').step);
    const tooFine = [
      panStep && panStep < SCANNER_MIN_ROTATION_DEG ? `pan ${panStep}°` : null,
      tiltStep && tiltStep < SCANNER_MIN_ROTATION_DEG ? `tilt ${tiltStep}°` : null,
    ].filter(Boolean);
    if (tooFine.length) {
      const warn = document.createElement('span');
      warn.className = 'gp-warn';
      warn.textContent = ` · ${tooFine.join(' and ')} below the scanner's ${SCANNER_MIN_ROTATION_DEG}° keyframe threshold — those positions capture nothing`;
      els.gridSummary.appendChild(warn);
    }
  }
}

let selectedPreset = null;
function selectPreset(name) {
  selectedPreset = name;
  for (const btn of els.scanTypes) btn.classList.toggle('selected', btn.dataset.preset === name);
  const preset = SCAN_PRESETS[name]; // 'custom' has no entry, so it leaves the fields alone
  if (preset) {
    for (const axis of ['pan', 'tilt']) {
      for (const key of ['from', 'to', 'step']) els.axis[axis][key].value = String(preset[axis][key]);
    }
  }
  renderGridSummary();
}
for (const btn of els.scanTypes) btn.addEventListener('click', () => selectPreset(btn.dataset.preset));

// Hand-editing any number means the plan is no longer the preset that is lit, so the selection
// moves to Custom instead of leaving a name on screen that no longer describes the fields.
for (const axis of ['pan', 'tilt']) {
  for (const key of ['from', 'to', 'step']) {
    els.axis[axis][key].addEventListener('input', () => {
      if (selectedPreset === 'custom') renderGridSummary();
      else selectPreset('custom');
    });
  }
}
selectPreset('dome');

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

// ── Grid capture ───────────────────────────────────────────────────────────────
// The run itself lives in the backend (POST /api/grid-capture), not here, for the same reason
// the BLE connection does: the phone caps concurrent MCP sessions, so exactly one process may
// hold one. This panel starts the run and renders the progress the backend broadcasts on the
// WS the page is already connected to — a 9-position run takes minutes, and a silent request
// that long is indistinguishable from a hang.
function renderGridProgress(msg) {
  if (msg.phase === 'start') {
    els.gridResults.innerHTML = '';
    els.gridProgress.textContent = `Starting ${msg.total}-position run…`;
    setScanActive(true);
    return;
  }
  if (msg.phase === 'moving') {
    els.gridProgress.textContent = `[${msg.position}/${msg.total}] moving to pan=${msg.target.pan} tilt=${msg.target.tilt}…`;
    return;
  }
  if (msg.phase === 'moving' || msg.phase === 'capturing') {
    // A bare "[n/total]" line is easy to miss on a phone held at arm's length while the rig
    // is moving; the bar is the part that reads at a glance from across the room.
    const pct = msg.total ? Math.round((msg.position / msg.total) * 100) : 0;
    if (els.gridBar) els.gridBar.style.width = `${pct}%`;
  }
  if (msg.phase === 'capturing') {
    els.gridProgress.textContent = `[${msg.position}/${msg.total}] ${msg.converged ? 'converged' : 'NOT converged'} — taking photo…`;
    return;
  }
  if (msg.phase === 'captured') {
    const row = document.createElement('div');
    row.className = 'test-row';
    const verdict = msg.converged ? 'converged' : 'NOT converged';
    row.innerHTML = `<span class="verdict ${msg.converged ? 'moved' : 'notmoved'}">${verdict}</span>`;
    const label = document.createElement('span');
    label.className = 'test-desc';
    label.textContent = `${msg.position}. pan=${(msg.pan ?? 0).toFixed(1)} tilt=${(msg.tilt ?? 0).toFixed(1)} (${msg.ticks} ticks)`;
    row.appendChild(label);
    // The photo stays on the phone; these link to the device's own share URL rather than
    // proxying bytes through the backend.
    const shots = [{ href: msg.photoUrl, text: 'photo' }];
    if (msg.photoUrlPortrait) shots.push({ href: msg.photoUrlPortrait, text: 'photo (portrait*)' });
    for (const shot of shots) {
      const link = document.createElement('a');
      link.href = shot.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = shot.text;
      link.style.marginLeft = '6px';
      row.appendChild(link);
    }
    els.gridResults.appendChild(row);
    return;
  }
  if (msg.phase === 'done') {
    setScanActive(false);
    els.gridProgress.textContent = `Done — ${msg.converged}/${msg.total} converged.`;
    return;
  }
  if (msg.phase === 'error') {
    setScanActive(false);
    els.gridProgress.textContent = `Failed after ${msg.captured} position(s): ${msg.error}`;
  }
}

// Not routed through the shared api() helper: that does a single res.json(), but this
// endpoint streams NDJSON (one JSON object per line, see backend.mjs's grid-capture handler)
// so a multi-minute run keeps the connection demonstrably alive instead of sending zero bytes
// until the very end — which is what silently killed real runs before this existed. This page
// already renders progress from the WS broadcast (renderGridProgress below), so the stream here
// only needs to be read to know when the run actually finished — but reading and discarding it
// still matters, since an unconsumed body can itself stall/backpressure the connection.
els.gridRun?.addEventListener('click', async () => {
  els.gridRun.disabled = true;
  try {
    // Same generator the summary line above the button rendered from, so the run is exactly the
    // one the count promised — no second parse of the same fields to drift out of step with it.
    const { pans, tilts } = currentGrid();
    const bothOrientations = els.gridBothOrientations?.checked ?? false;
    log(`Grid capture: ${pans.length * tilts.length} position(s)${bothOrientations ? ' x 2 orientations' : ''}...`);
    const res = await fetch(`${baseUrl()}/api/grid-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pans, tilts, bothOrientations }),
    });
    if (!res.body) throw new Error(`HTTP ${res.status}`);
    let buf = '';
    let final = null;
    for await (const chunk of res.body) {
      buf += new TextDecoder().decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.phase === 'done' || event.phase === 'error') final = event;
      }
    }
    if (final?.phase === 'error') throw new Error(final.error);
    log(`Grid capture done: ${final?.converged ?? '?'}/${final?.total ?? '?'} converged.`, 'ok');
  } catch (err) {
    // The backend broadcasts partial progress on the WS as it goes, and renderGridProgress has
    // already drawn whatever completed — so this only needs to report, not reconstruct state.
    log(`Grid capture failed: ${err.message}`, 'warn');
    log(MCP_HINT, 'warn');
    els.gridProgress.textContent = `Failed: ${err.message}`;
  } finally {
    els.gridRun.disabled = false;
  }
});
