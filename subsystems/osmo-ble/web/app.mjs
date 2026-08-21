// Web Bluetooth client for the Osmo. Shares the exact same protocol codec/command builders
// as the Node MCP server (../protocol/*.mjs) — only the transport differs.

import { FrameReassembler, decodeFrame } from '../protocol/duml.mjs';
import { SERVICE_UUID, WRITE_CHAR_CANDIDATES_FULL, PAIRING_TRIGGER_BYTES } from '../protocol/constants.mjs';
import { MsgIdSequence, buildSetPairingPin, buildGimbalRecenter, buildGimbalResetAndCenter, buildGimbalSetMode, buildGimbalSpeedControl, buildGimbalStickControlEnable, buildRawCommand } from '../protocol/commands.mjs';
import { GIMBAL_MODE } from '../protocol/constants.mjs';
import { decodeQuaternion } from '../protocol/telemetry.mjs';
import { attachJoystick } from './joystick.mjs';
import { attachOrientationReadout } from './orientation.mjs';
import { attachFrameLog } from './frame-log.mjs';
import { attachCoverage } from './coverage.mjs';

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const els = {
  pair: document.getElementById('btn-pair'),
  triggerPair: document.getElementById('btn-trigger-pair'),
  pin: document.getElementById('pin'),
  recenter: document.getElementById('btn-recenter'),
  landscape: document.getElementById('btn-landscape'),
  stickToggle: document.getElementById('btn-stick-toggle'),
  orientation: document.getElementById('orientation-direct'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  joystickPad: document.getElementById('joystick-pad'),
  rawSend: document.getElementById('btn-raw-send'),
  rawCmdSet: document.getElementById('raw-cmdset'),
  rawCmdId: document.getElementById('raw-cmdid'),
  rawPayload: document.getElementById('raw-payload'),
  coverage: document.getElementById('coverage'),
  frames: document.getElementById('frames'),
};
const orientationReadout = attachOrientationReadout(els.orientation);

function loadIntoRawCommand({ cmdSet, cmdId, payloadHex }) {
  els.rawCmdSet.value = cmdSet;
  els.rawCmdId.value = cmdId;
  if (payloadHex !== undefined) els.rawPayload.value = payloadHex;
}
const frameLog = attachFrameLog(els.frames, { onSelect: loadIntoRawCommand });
const coverage = attachCoverage(els.coverage, { onSelect: loadIntoRawCommand });

// Every command here builds its own already-encoded frame bytes (no server round-trip to
// decode back), so this just re-decodes locally to get the same {cmdSet,cmdId,flags,payload}
// shape the frame inspector and coverage grid expect — one code path shared with the RX side.
function logAndTrackTx(frame, meta = {}) {
  const decoded = decodeFrame(frame);
  frameLog.add({
    at: Date.now(),
    dir: 'tx',
    cmdSet: decoded.cmdSet,
    cmdId: decoded.cmdId,
    flags: decoded.flags,
    msgId: decoded.msgId,
    payloadHex: hex(decoded.payload).replace(/ /g, ''),
  });
  coverage.record(decoded.cmdSet, decoded.cmdId, meta);
}

const PROPERTY_NAMES = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];

function log(line, cls = '') {
  const row = document.createElement('div');
  if (cls) row.className = cls;
  row.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function setControlsEnabled(enabled) {
  for (const el of [els.triggerPair, els.pin, els.recenter, els.landscape, els.stickToggle, ...els.modeButtons, els.rawSend]) {
    el.disabled = !enabled;
  }
  els.joystickPad.classList.toggle('disabled', !enabled);
}

const MAX_FRAME_HISTORY = 500;

class WebBleClient {
  constructor() {
    this.device = null;
    this.server = null;
    this.writeChar = null; // latched { characteristic, withResponse }
    this.writeCandidates = [];
    this.reassemblers = new Map(); // char uuid -> FrameReassembler
    this.msgIds = new MsgIdSequence();
    this.frameWaiters = [];
    this.frames = []; // rolling history of decoded frames, for console-driven inspection
    this.lastQuaternion = null;
  }

  /** Show the picker and remember the choice (persists across reloads via getDevices()). */
  async pickDevice() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser. Use Chrome/Edge on desktop or Android, over HTTPS or http://localhost.');
    }
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    log(`Selected device: ${device.name || '(unnamed)'} [${device.id}]`);
    return this.connectToDevice(device);
  }

  /**
   * Reconnect to a previously-granted device without showing the picker. Web Bluetooth
   * remembers permission per-origin once a device has been chosen once via pickDevice() —
   * getDevices() lists those, and gatt.connect() on one doesn't require a fresh user gesture.
   */
  async tryAutoReconnect() {
    if (!navigator.bluetooth?.getDevices) return false;
    const known = await navigator.bluetooth.getDevices();
    if (!known.length) return false;
    const device = known.find((d) => /osmo|om6/i.test(d.name || '')) || known[0];
    log(`Auto-reconnecting to previously-granted device: ${device.name || '(unnamed)'} [${device.id}]`);
    try {
      await this.connectToDevice(device);
      return true;
    } catch (err) {
      log(`Auto-reconnect failed: ${err.message}`, 'warn');
      return false;
    }
  }

  async connectToDevice(device) {
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', () => {
      log('Device disconnected.', 'warn');
      setStatus('Disconnected');
      setControlsEnabled(false);
    });

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    log(`Connected. Discovered service ${service.uuid}`);

    const allChars = await service.getCharacteristics();
    log(`Characteristics: ${allChars.map((c) => `${c.uuid} [${propsOf(c)}]`).join(', ')}`);

    for (const c of allChars) {
      if (c.properties.notify || c.properties.indicate) {
        c.addEventListener('characteristicvaluechanged', (ev) => this._handleNotify(c.uuid, ev.target.value));
        await c.startNotifications();
        log(`Subscribed to notifications on ${c.uuid}`);
      }
    }

    this.writeCandidates = [];
    for (const { uuid, withResponse } of WRITE_CHAR_CANDIDATES_FULL) {
      const characteristic = allChars.find((c) => c.uuid === uuid);
      if (characteristic) this.writeCandidates.push({ characteristic, withResponse, uuid });
    }
    setStatus(`Connected: ${this.device.name || this.device.id}`);
    setControlsEnabled(true);
  }

  async disconnect() {
    this.device?.gatt?.disconnect();
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected);
  }

  _handleNotify(sourceUuid, dataView) {
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    if (!this.reassemblers.has(sourceUuid)) this.reassemblers.set(sourceUuid, new FrameReassembler());
    const frames = this.reassemblers.get(sourceUuid).push(bytes);
    for (const frame of frames) {
      if (frame.error) {
        frameLog.add({ at: Date.now(), dir: 'rx', error: `[${sourceUuid}] ${frame.error.message}` });
        continue;
      }
      frameLog.add({
        at: Date.now(),
        dir: 'rx',
        cmdSet: frame.cmdSet,
        cmdId: frame.cmdId,
        flags: frame.flags,
        msgId: frame.msgId,
        payloadHex: hex(frame.payload).replace(/ /g, ''),
      });
      this.frames.push({ at: Date.now(), sourceUuid, ...frame });
      if (this.frames.length > MAX_FRAME_HISTORY) this.frames.shift();
      const quat = decodeQuaternion(frame);
      if (quat) {
        this.lastQuaternion = quat;
        orientationReadout.update(quat);
      }
      for (const waiter of [...this.frameWaiters]) {
        if (waiter.predicate(frame)) {
          this.frameWaiters = this.frameWaiters.filter((w) => w !== waiter);
          waiter.resolve(frame);
        }
      }
    }
  }

  _waitForFrame(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { predicate, resolve };
      this.frameWaiters.push(waiter);
      setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
    });
  }

  async _writeTo(characteristic, bytes, withoutResponse) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (withoutResponse && characteristic.writeValueWithoutResponse) {
      await characteristic.writeValueWithoutResponse(buf);
    } else if (!withoutResponse && characteristic.writeValueWithResponse) {
      await characteristic.writeValueWithResponse(buf);
    } else {
      await characteristic.writeValue(buf);
    }
  }

  async sendRaw(frameBytes) {
    if (this.writeChar) {
      await this._writeTo(this.writeChar.characteristic, frameBytes, !this.writeChar.withResponse);
      log(`TX [${this.writeChar.uuid}] ${hex(frameBytes)}`, 'tx');
      return;
    }
    for (const candidate of this.writeCandidates) {
      try {
        await this._writeTo(candidate.characteristic, frameBytes, candidate.withResponse === false);
        this.writeChar = candidate;
        log(`TX [${candidate.uuid}] ${hex(frameBytes)} (latched as write channel)`, 'tx');
        return;
      } catch (err) {
        log(`write to ${candidate.uuid} failed: ${err.message}`, 'warn');
      }
    }
    throw new Error('No write characteristic accepted the frame (tried fff5, fff3).');
  }

  async pair(pin, identifier) {
    // Trigger write goes through the same fff5-then-fff3 candidate probe as every other write
    // (sendRaw), not a hardcoded fff4: fff4 is notify-only on real hardware tested here (no
    // write/writeWithoutResponse property at all), so a hardcoded fff4 write always fails with
    // a GATT-level "Write Not Permitted" before ever reaching the device.
    await this.sendRaw(PAIRING_TRIGGER_BYTES);
    await new Promise((r) => setTimeout(r, 1000));

    const msgId = this.msgIds.next();
    const frame = buildSetPairingPin(msgId, pin, identifier || undefined);

    for (const candidate of this.writeCandidates) {
      const waiter = this._waitForFrame((f) => f.cmdSet === 0x07 && f.cmdId === 0x45 && (f.flags & 0x80) !== 0, 4000);
      try {
        await this._writeTo(candidate.characteristic, frame, candidate.withResponse === false);
        log(`TX [${candidate.uuid}] SetPairingPIN ${hex(frame)}`, 'tx');
      } catch (err) {
        log(`SetPairingPIN write to ${candidate.uuid} failed: ${err.message}`, 'warn');
        continue;
      }
      const response = await waiter;
      if (response) {
        this.writeChar = candidate;
        const status = response.payload.length >= 2 ? response.payload[1] : response.payload[0];
        return { alreadyPaired: status === 0x01, pairingRequired: status === 0x02 };
      }
    }
    throw new Error('No pairing response received on fff5 or fff3 within timeout.');
  }
}

function propsOf(characteristic) {
  // characteristic.properties exposes booleans as prototype getters, not own enumerable
  // properties, so Object.entries()/Object.keys() silently sees nothing — read by name.
  const p = characteristic.properties;
  return PROPERTY_NAMES.filter((name) => p[name] === true).join(',');
}

const client = new WebBleClient();
setControlsEnabled(false);

// Expose a console-driven debug API: window.osmo lets you send commands and inspect
// telemetry/history directly from DevTools without clicking through the UI each time.
window.osmo = {
  client,
  commands: { buildSetPairingPin, buildGimbalRecenter, buildGimbalResetAndCenter, buildGimbalSetMode, buildGimbalSpeedControl, buildRawCommand, MsgIdSequence },
  GIMBAL_MODE,
  decodeQuaternion,
  hex,
  frames: () => client.frames,
  latest: (n = 10) => client.frames.slice(-n),
  quaternion: () => client.lastQuaternion,
};

els.pair.addEventListener('click', async () => {
  els.pair.disabled = true;
  try {
    await client.pickDevice();
  } catch (err) {
    log(`Connect failed: ${err.message}`, 'warn');
    setStatus('Not connected');
  } finally {
    els.pair.disabled = false;
  }
});

// Auto-reconnect on page load to a previously-granted device — Web Bluetooth remembers the
// permission per-origin once you've picked it once, so reloading while testing (e.g. after
// an app.mjs change) doesn't need the picker again.
client.tryAutoReconnect();

els.triggerPair.addEventListener('click', async () => {
  const pin = els.pin.value.trim();
  if (!pin) {
    log('Enter the PIN shown on the device screen first.', 'warn');
    return;
  }
  try {
    const result = await client.pair(pin);
    log(`Pair result: ${JSON.stringify(result)}`, 'ok');
  } catch (err) {
    log(`Pair failed: ${err.message}`, 'warn');
  }
});

// Uses resetAndCenter (cmdId 0x4C), not the absoluteAngle(0,0,0) "recenter" builder — see the
// matching comment in backend-client.mjs for why.
els.recenter.addEventListener('click', async () => {
  const frame = buildGimbalResetAndCenter(client.msgIds.next());
  try {
    await client.sendRaw(frame);
    logAndTrackTx(frame, { label: 'ResetAndCenter' });
  } catch (err) {
    log(`Recenter failed: ${err.message}`, 'warn');
  }
});

for (const btn of els.modeButtons) {
  btn.addEventListener('click', async () => {
    const mode = { lock: GIMBAL_MODE.LOCK, follow: GIMBAL_MODE.FOLLOW, fpv: GIMBAL_MODE.FPV }[btn.dataset.mode];
    const frame = buildGimbalSetMode(client.msgIds.next(), mode);
    try {
      await client.sendRaw(frame);
      logAndTrackTx(frame, { label: `SetMode(${btn.dataset.mode})` });
    } catch (err) {
      log(`Set mode failed: ${err.message}`, 'warn');
    }
  });
}

// Promoted to the main view: the one cmdId-0x44 value with confirmed real-world behavior
// (rotates the phone mount to landscape) — see the drawer's "Orientation toggle" section for
// the other two still-unresolved byte values.
els.landscape.addEventListener('click', async () => {
  const frame = buildGimbalSetMode(client.msgIds.next(), GIMBAL_MODE.FOLLOW);
  try {
    await client.sendRaw(frame);
    logAndTrackTx(frame, { label: 'SetMode(follow / landscape)' });
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
  const frame = buildGimbalStickControlEnable(client.msgIds.next(), next);
  try {
    await client.sendRaw(frame);
    logAndTrackTx(frame, { label: `StickControlEnable(${next})` });
    stickEnabled = next;
    els.stickToggle.textContent = `Stick: ${stickEnabled ? 'ON' : 'OFF'}`;
    els.stickToggle.classList.toggle('active', stickEnabled);
  } catch (err) {
    log(`Stick control toggle failed: ${err.message}`, 'warn');
  }
});

// Joystick: click-drag, touch-drag, or focus + arrow keys. Continuously streams a speed
// vector while active, auto-stops (zero speed) on release.
attachJoystick(els.joystickPad, {
  onMove: (vector) => {
    client.sendRaw(buildGimbalSpeedControl(client.msgIds.next(), vector)).catch((err) => log(`Joystick move failed: ${err.message}`, 'warn'));
  },
  onStop: () => {
    client.sendRaw(buildGimbalSpeedControl(client.msgIds.next(), {})).catch(() => {
      /* best-effort stop */
    });
  },
});

els.rawSend.addEventListener('click', async () => {
  try {
    const cmdSet = Number(els.rawCmdSet.value);
    const cmdId = Number(els.rawCmdId.value);
    const payloadHex = els.rawPayload.value.trim().replace(/\s+/g, '');
    const frame = buildRawCommand(client.msgIds.next(), { cmdSet, cmdId, payloadHex });
    await client.sendRaw(frame);
    logAndTrackTx(frame, { label: 'Raw (manual probe)' });
  } catch (err) {
    log(`Raw send failed: ${err.message}`, 'warn');
  }
});
