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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { OsmoBleTransport } from './ble-transport.mjs';
import { createStallGuard, createWedgeGuard } from '../protocol/stall.mjs';
import { computeCorrection, shouldFlipSign, poseAlreadyActedOn } from '../protocol/control.mjs';
import { buildGimbalRecenter, buildGimbalAbsoluteAngle, buildGimbalSetMode, buildGimbalSpeedControl, buildGimbalStickControlEnable, buildGimbalResetAndCenter, buildRawCommand } from '../protocol/commands.mjs';
import { GIMBAL_MODE } from '../protocol/constants.mjs';
import { quaternionDelta, quatToGimbalControlDeg } from '../protocol/telemetry.mjs';
import { AndroidMcpClient, capturePhoto, planGrid } from './android-capture.mjs';
import { PHONE_TELEMETRY, isPhoneTelemetry, normalizePhoneTelemetry } from '../protocol/phone_telemetry.mjs';

const PORT = Number(process.env.BACKEND_PORT) || 8788;
const transport = new OsmoBleTransport();
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True while a grid capture owns the gimbal.
 *
 * This is a real interlock, not a UI nicety. `moveToClosedLoop` steers by reading telemetry,
 * computing an error, and sending a speed correction — so any OTHER speed command arriving
 * mid-run is a second controller fighting the first for the same two motors. Observed on
 * hardware: a stray joystick touch during a 105-position dome left the gimbal pinned at one
 * pose (pan -121.5, tilt -27.6) for six consecutive positions, each burning the full `maxMs`
 * timeout and photographing the same view.
 *
 * Guarded at the HTTP boundary specifically: the grid's own corrections go through
 * `buildAndSend()` directly and are unaffected, so this blocks external interference without
 * blocking the run itself.
 */
let gridRunning = false;
/** Set by POST /api/grid-stop; the run loop checks it between positions and unwinds cleanly. */
let gridCancelRequested = false;
// Run-level wedge detection lives in protocol/stall.mjs (createWedgeGuard), next to the
// tick-level stall guard and its tests — see that file for the overheating incident that
// made it a shared function rather than an inline check in one of the two capture paths.

/**
 * Real macOS Bluetooth unpair, via blueutil's `--unpair` (EXPERIMENTAL per its own --help —
 * wraps a private IOBluetoothDevice API Apple doesn't document, not something to treat as
 * bulletproof).
 *
 * Why this exists despite cli.mjs's `forget` command already existing: that command is
 * explicitly local-only (clears .cli-state.json, leaves the OS pairing untouched — see its own
 * comment) because at the time it was written there was no reliable macOS CLI for a real
 * unpair. blueutil fills that gap. Kept as a separate endpoint/command (`forget-os`, not a
 * behavior change to `forget`) rather than overloading the existing one, so a script already
 * depending on `forget`'s narrower, documented meaning doesn't silently start doing something
 * bigger.
 *
 * Disconnects first: unpairing while noble still holds the GATT connection open has produced
 * inconsistent state in testing elsewhere in this file's own history (see the BLE-wedge and
 * bond gotchas in docs/operations/GIMBAL_INTEGRATION.md) — tearing down our own connection
 * first at least rules that out as a contributor.
 *
 * Does NOT fix a wedged gimbal-side BLE stack (docs/operations/GIMBAL_INTEGRATION.md's
 * "gimbal itself can get into a stuck BLE state" gotcha) — that one is on the gimbal, not in
 * macOS's pairing database, and its only known fix is the physical button-combo reset. This
 * only clears what macOS itself remembers, so a stale/corrupt bond can be forced fresh.
 */
async function unpairMacOSBluetooth(name) {
  try {
    await transport.disconnect();
  } catch {
    // already disconnected — fine, we're about to unpair regardless
  }
  try {
    const { stdout, stderr } = await execFileAsync('blueutil', ['--unpair', name]);
    return { unpaired: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    // Distinguish "blueutil isn't installed" (a setup gap the caller can fix) from "blueutil
    // ran and failed" (e.g. the name wasn't found, or the device was never paired to begin
    // with) — both are real outcomes, but only one has an actionable remediation.
    if (err.code === 'ENOENT') {
      return {
        unpaired: false,
        error: 'blueutil is not installed',
        remediation: 'brew install blueutil',
      };
    }
    return { unpaired: false, error: err.stderr?.trim() || err.message }
  }
}

const wsClients = new Set();
// `except` skips one socket — used when relaying a message that ARRIVED on /ws, so the phone
// that sent its own telemetry doesn't get it echoed back over a mobile link that is already the
// scarcest thing in this setup. Defaulted to null, so every existing single-argument caller
// (frames, status, grid-progress) behaves exactly as before.
function broadcast(msg, except = null) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws === except) continue;
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

// ── Phone telemetry relay ────────────────────────────────────────────────────────────────────
// The operator's phone posts its own compass/orientation/GPS samples UP the same /ws socket the
// control UI already listens on, and we fan them back out to the other clients. This is a relay,
// not a fusion step: the gimbal's quaternion is relative to wherever it booted and has no compass
// reference at all, while the phone's heading is absolute and unreliable indoors — ADR 0005's
// rule (geometry for relative alignment, compass for absolute orientation) means these two are
// displayed side by side and never averaged into one number. The wire shape is pinned in
// ../protocol/phone_telemetry.mjs; this file validates against it rather than re-deriving what a
// valid frame looks like, so the sender, the relay and the readout can't drift apart.
//
// Only the newest sample is kept, not a history: its one job is to let GET /api/status (and the
// status frame every new WS client gets on connect) hand a late-joining control UI something to
// render immediately, instead of a blank readout until the phone's next tick. `at` stays the
// phone's own timestamp — re-stamping it here would hide how stale the sample is, which is
// exactly what a reader needs to know when a phone has walked out of Wi-Fi range.
let lastPhoneTelemetry = null;

// A valid frame is ~250 bytes of JSON; this is generous headroom, not a measured limit. The point
// is only that an inbound frame from a phone browser cannot be arbitrarily large — this is the
// first inbound message path on /ws and its sender is an untrusted network peer.
const PHONE_TELEMETRY_MAX_BYTES = 4096;

// Rate-limited because a phone stuck sending garbage does so at its send rate (~4Hz), and an
// unthrottled warn per frame buries every other line in the log.
//
// The counter is CUMULATIVE, not per-window, and deliberately so: a window counter that resets
// each time it prints loses the tail of any burst that stops before the next window opens — the
// log's last word would be "dropped 1" after dropping six. A running total is a number that is
// still true whenever it is next printed, and the delta between two lines is the burst size.
let droppedInboundTotal = 0;
let droppedInboundWarnedAt = 0;
function warnDroppedInbound(reason) {
  droppedInboundTotal++;
  const now = Date.now();
  if (now - droppedInboundWarnedAt < 5000) return;
  console.warn(`[ws] ${droppedInboundTotal} inbound frame(s) dropped since start; most recent: ${reason}`);
  droppedInboundWarnedAt = now;
}

/**
 * Handle one inbound /ws message. Returns on every failure path and never throws: an exception
 * escaping a 'message' listener is an uncaught error that kills the process — i.e. a phone
 * browser reloading mid-scan could take the backend, and the BLE connection with it, down.
 * That is the whole reason this is a function with early returns rather than inline parsing.
 */
function handleInboundWsMessage(ws, data, isBinary) {
  if (isBinary) {
    warnDroppedInbound('binary frame (nothing on /ws speaks binary)');
    return;
  }
  if (data.length > PHONE_TELEMETRY_MAX_BYTES) {
    warnDroppedInbound(`${data.length} bytes exceeds the ${PHONE_TELEMETRY_MAX_BYTES}-byte cap`);
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data.toString('utf8'));
  } catch (err) {
    warnDroppedInbound(`not JSON (${err.message})`);
    return;
  }
  if (!msg || typeof msg !== 'object' || msg.type !== PHONE_TELEMETRY) {
    warnDroppedInbound(`unhandled type ${JSON.stringify(msg?.type)}`);
    return;
  }
  if (!isPhoneTelemetry(msg)) {
    warnDroppedInbound('failed isPhoneTelemetry() — a field the contract types number|null was neither');
    return;
  }
  // Validate FIRST, then normalize — not normalize instead of validating. normalizePhoneTelemetry
  // coerces anything it doesn't recognize to null, so on its own it would happily turn a garbage
  // frame into a well-formed all-null one and relay that as if the phone had genuinely reported
  // "no heading, no fix". A dropped frame is honest; a fabricated empty one is not.
  lastPhoneTelemetry = normalizePhoneTelemetry(msg);
  broadcast(lastPhoneTelemetry, ws);
}

function statusPayload() {
  return {
    connected: transport.connected,
    paired: transport.paired,
    lastQuaternion: transport.lastQuaternion,
    // Newest phone sample, or null if none has arrived this process lifetime. Included here (and
    // so in GET /api/status and the on-connect status frame) so a client that connects between
    // phone ticks isn't blank; it is a cache of the last relayed frame, not a live reading.
    phoneTelemetry: lastPhoneTelemetry,
    // Whether a grid capture currently owns the gimbal. On status (not only on the WS progress
    // stream) so a client that loads or reconnects mid-scan can lock its manual controls
    // immediately, instead of offering a joystick that the backend will reject.
    scanning: gridRunning,
  };
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
/**
 * Closed-loop move, with stall detection.
 *
 * The loop used to spin until `maxMs` no matter what. Observed 2026-08-26: a
 * move-to travelled 84.7° → 75.66°, hit a limit, and then sat at *exactly*
 * 75.66 for the remaining 27 seconds while the error stayed at -50.7°. It
 * reported `timedOut` — technically true, and useless: the caller cannot tell
 * "the axis is jammed, stop asking" from "nearly there, needs longer", and the
 * documented remedy was to eyeball the history array by hand.
 *
 * A wedged gimbal is the normal end state of a long session here (sweeps
 * degraded 18 → 11 → 9 → 4 positions before jamming), so this is the common
 * case, not an edge one. Detecting it costs one comparison per tick and turns
 * 30 wasted seconds into ~2.5, per move, for every caller: move_to, sweep,
 * grid capture and the CLI all route through this function.
 */
/**
 * Command both axes to zero speed. Safe to call any time; never throws.
 *
 * The gimbal's speed command is a LATCH, not a pulse: it keeps driving at the commanded rate
 * until something tells it otherwise. So every path that leaves a speed command outstanding
 * leaves the motors running — including a thrown error, an aborted scan, and (the one that
 * actually bit us) the BLE link simply going away, because `node --watch` restarted this
 * process mid-move. On 2026-08-26 that cooked a real OM6 repeatedly: it would keep driving
 * against its own end-stop long after the run was over, until it thermally shut itself off.
 *
 * Errors are swallowed deliberately — this runs on failure and shutdown paths where the
 * transport may already be gone, and a throw here would mask the original fault.
 */
async function stopMotors() {
  if (!transport.connected) return;
  try {
    await transport.sendRaw(buildGimbalSpeedControl(transport.nextMsgId(), {}));
  } catch (err) {
    console.warn(`[safety] could not stop motors: ${err.message}`);
  }
}

/**
 * Closed-loop move with a guaranteed stop.
 *
 * The drive loop is separated from this wrapper purely so the `finally` cannot be bypassed by
 * any of driveClosedLoop's several early returns (converged, jammed, timed out) or by a throw
 * out of the middle of a tick.
 */
async function moveToClosedLoop(opts) {
  try {
    return await driveClosedLoop(opts);
  } finally {
    await stopMotors();
  }
}

async function driveClosedLoop({ yawDeg = 0, pitchDeg = 0, toleranceDeg = 3, speedDegPerSec = 25, tickMs = 250, settleMs = 150, maxMs = 8000 }) {
  const start = Date.now();
  const history = [];
  let yawSign = 1;
  let pitchSign = 1;
  let prevYawError = null;
  let prevPitchError = null;
  const guard = createStallGuard();

  let actedOnPose = null;

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

    // Freshness gate, on the DERIVED pan/tilt rather than the raw quaternion.
    //
    // The gimbal re-sends its last orientation instead of staying quiet, so frames keep arriving
    // carrying a measurement that has not changed. Acting on each arrival means issuing 2-3 full
    // corrections against one real measurement, so each step travels 2-3x what the controller
    // intended — that is the overshoot, and the limit cycle it produces is what the scanner
    // reports as "Moving too fast".
    //
    // Gating on the quaternion does NOT work: q and -q encode the same rotation, and the device
    // does emit both, so raw-value comparison sees "new data" for a pose that is bit-identical
    // once decoded. pan/tilt is also the actual control input, so it is the honest thing to
    // compare. Bit-identical degrees are unambiguous — real IMU noise never reproduces a float64
    // exactly.
    if (poseAlreadyActedOn({ yaw, pitch }, actedOnPose)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(60, tickMs)));
      continue;
    }
    actedOnPose = { yaw, pitch };
    const yawError = wrapDeg(yawDeg - yaw);
    const pitchError = pitchDeg - pitch;

    // Sign-mapping correction — see shouldFlipSign() for why an overshoot must NOT count.
    if (shouldFlipSign(yawError, prevYawError)) yawSign *= -1;
    if (shouldFlipSign(pitchError, prevPitchError)) pitchSign *= -1;

    history.push({ tMs: Date.now() - start, yaw, pitch, yawError, pitchError });
    if (Math.abs(yawError) <= toleranceDeg && Math.abs(pitchError) <= toleranceDeg) {
      return { converged: true, timedOut: false, stalled: false, ticks: history.length, finalYaw: yaw, finalPitch: pitch, history };
    }

    // Still outside tolerance — so if nothing moved this tick, the axis is not
    // merely slow. Counted only while a correction is actually being commanded,
    // which is guaranteed here: we are past the convergence return above.
    const verdict = guard.observe({ pan: yaw, tilt: pitch });
    if (verdict === 'flip-sign') {
      // Stalled, but only in the direction tried so far. The correction sign
      // comes from an approximate Euler decomposition that does not hold at
      // every pose; flipping recovers that case. Falls through to the drive
      // code below so the flipped direction is actually commanded this tick.
      yawSign *= -1;
      pitchSign *= -1;
    } else if (verdict === 'jammed') {
      // Leave the motors stopped rather than holding a speed the gimbal is
      // ignoring — a wedged axis that frees itself should not lurch.
      await transport.sendRaw(buildGimbalSpeedControl(transport.nextMsgId(), {}));
      return {
        converged: false,
        timedOut: false,
        stalled: true,
        signProbed: guard.flipped,
        stallReason:
          `pan/tilt stopped moving while still ${Math.abs(yawError).toFixed(1)}° from target, `
          + `in BOTH correction directions (the sign was flipped and retried). The axis is `
          + `jammed or at a limit; a longer maxMs will not help. Recenter, or power-cycle the `
          + `gimbal. If a raw gimbal_nudge still moves it, the fault is in this loop, not the `
          + `hardware.`,
        ticks: history.length,
        finalYaw: yaw,
        finalPitch: pitch,
        history,
      };
    }

    // Proportional correction, not bang-bang — see computeCorrection().
    const yawSpeed = computeCorrection(yawError, { toleranceDeg, speedDegPerSec, sign: yawSign });
    const pitchSpeed = computeCorrection(pitchError, { toleranceDeg, speedDegPerSec, sign: pitchSign });

    await transport.sendRaw(buildGimbalSpeedControl(transport.nextMsgId(), { yawDegPerSec: yawSpeed, pitchDegPerSec: pitchSpeed }));
    await new Promise((resolve) => setTimeout(resolve, tickMs));
    await transport.sendRaw(buildGimbalSpeedControl(transport.nextMsgId(), {}));
    await new Promise((resolve) => setTimeout(resolve, settleMs));

    prevYawError = yawError;
    prevPitchError = pitchError;
  }

  const quat = transport.lastQuaternion;
  const final = quat ? quatToGimbalControlDeg(quat) : { pan: null, tilt: null };
  return { converged: false, timedOut: true, stalled: false, ticks: history.length, finalYaw: final.pan, finalPitch: final.tilt, history };
}

const routes = {
  'GET /': async () => [
    200,
    {
      ok: true,
      message: 'Osmo BLE backend is running.',
      routes: ['GET /api/status', 'POST /api/scan', 'POST /api/connect', 'POST /api/pair-trigger', 'POST /api/pair', 'POST /api/disconnect', 'POST /api/forget-os', 'POST /api/command', 'POST /api/move-to', 'POST /api/capture-photo', 'POST /api/grid-capture', 'POST /api/grid-stop', 'GET /api/scan-sessions', 'GET /api/frames', 'POST /api/test/recenter-probe', 'POST /api/test/command-probe', 'WS /ws'],
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

  // A real macOS unpair (see unpairMacOSBluetooth's own comment for why this is separate from
  // cli.mjs's local-only `forget`). `name` is required rather than defaulted to a guessed DJI
  // device name: this repo's own docs record the gimbal advertising under either
  // "OM6-E06YAM-1" or "OM6-E06YAM-2" depending on BLE stack state (GIMBAL_INTEGRATION.md's
  // "started advertising as two separate peripherals at once" gotcha), so a hardcoded suffix
  // would silently no-op against the wrong one. The caller (cli.mjs) remembers the real name
  // from its own scan/connect step for exactly this reason.
  'POST /api/forget-os': async (req) => {
    const { name } = await readJsonBody(req);
    if (!name) return [400, { error: 'name is required — the exact advertised device name (see `scan`/`status`), not a guess.' }];
    const result = await unpairMacOSBluetooth(name);
    broadcast({ type: 'status', ...statusPayload() });
    return [result.unpaired ? 200 : 502, result];
  },

  // Stop a running grid. Needed because killing the HTTP client does NOT stop the server-side
  // loop — it kept sweeping with nobody listening, and `gridRunning` then held the motion
  // interlock closed so the gimbal could not even be recovered by hand.
  'POST /api/grid-stop': async () => {
    if (!gridRunning) return [200, { stopped: false, note: 'No scan is running.' }];
    gridCancelRequested = true;
    return [200, { stopped: true, note: 'Scan will stop after the current position.' }];
  },

  'POST /api/command': async (req) => {
    const { type, params } = await readJsonBody(req);
    // Motion commands only — a scan does not care about setMode/raw probes, and blocking
    // those would be surprising. 409 (conflict) rather than 400: the request is well-formed,
    // it just lost a race for a single physical resource.
    // An all-zero `speed` is a STOP, not a motion command, and must never be refused — refusing
    // it means the one command that can save overheating motors is unavailable exactly while a
    // scan is driving them.
    const isStopCommand = type === 'speed'
      && !['yawDegPerSec', 'pitchDegPerSec', 'rollDegPerSec'].some((k) => Number(params?.[k]) || 0);
    if (gridRunning && !isStopCommand && (type === 'speed' || type === 'recenter' || type === 'resetAndCenter')) {
      return [409, {
        error: 'A scan is running and owns the gimbal — motion commands are rejected until it finishes.',
        remediation: 'Wait for the scan to finish, or stop it, before moving the gimbal by hand.',
      }];
    }
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
  // caps concurrent sessions (see android-capture.mjs).
  //
  // Streamed as NDJSON (one JSON object per line, flushed as each position finishes) rather
  // than buffered into one response sent only at the very end. Two real failures on real
  // hardware forced this: a ~20+ position run (each position: up to 15s move + an MCP photo
  // round-trip) easily runs 5-10+ minutes, and a response that sends zero bytes for that long
  // is indistinguishable from a hung connection to anything timing it — undici's client-side
  // default eventually kills it with a bare "fetch failed", which is exactly what happened here
  // (twice, at 22 and 84 positions). Writing headers immediately and a line per position keeps
  // the connection demonstrably alive throughout. The second problem this fixes: the old
  // buffer-everything shape meant a failure on position 20 of 22 discarded the 19 already
  // captured, because the CLI only downloaded photos after the whole request resolved — with
  // streaming, the CLI downloads each photo as its line arrives, so a later failure only costs
  // the positions after it, not everything before it.
  //
  // Still broadcasts on the existing WS too (unchanged) — the web UI keeps working exactly as
  // before; NDJSON is the second, independent consumer for callers (the CLI) that would rather
  // not hold a WS connection open just to watch one HTTP call finish.
  'POST /api/grid-capture': async (req, url, res) => {
    const body = await readJsonBody(req);
    const pans = body.pans ?? [120, 145, 170];
    const tilts = body.tilts ?? [-10, 0, 10];
    const deviceUrl = body.deviceUrl ?? process.env.ANDROID_MCP_URL;
    const deviceToken = body.deviceToken ?? process.env.ANDROID_MCP_TOKEN;
    // Movement-only: sweep the grid but take no photos over MCP. The phone runs the scanner
    // web app instead, which captures its own keyframes AND tags each with an AR pose from
    // the device's visual-inertial odometry.
    //
    // That pose is the whole point. The MCP camera path produces bare JPEGs with no pose, so
    // structure-from-motion can only ever recover the room up to an unknown scale — there is
    // nothing metric anywhere in the capture to fit against, and splat-align correctly skips.
    // VIO poses ARE metric (the IMU measures real acceleration), so they give the fit a real
    // metric side and the reconstruction a true scale.
    //
    // Note the scanner fires a keyframe every `minRotationDeg` (default 20°) of rotation, so a
    // grid whose pan step is smaller than that will not produce one keyframe per position.
    const capturePhotos = body.capturePhotos !== false;
    if (capturePhotos && !deviceUrl) return [400, { error: 'deviceUrl is required (or set ANDROID_MCP_URL)' }];
    if (capturePhotos && !deviceToken) return [400, { error: 'deviceToken is required (or set ANDROID_MCP_TOKEN) — see .env.example' }];
    if (!transport.connected) return [400, { error: 'not connected to a gimbal — scan + connect first' }];

    const grid = planGrid({ pans, tilts });
    const prefix = body.prefix ?? `grid-${Date.now()}`;
    const client = capturePhotos ? new AndroidMcpClient({ url: deviceUrl, token: deviceToken }) : null;
    const results = [];

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    const emit = (event) => {
      broadcast({ type: 'grid-progress', ...event });
      res.write(JSON.stringify(event) + '\n');
    };

    emit({ phase: 'start', total: grid.length, prefix });
    gridRunning = true;
    gridCancelRequested = false;
    const wedge = createWedgeGuard();
    /** Remediation text for an aborted run; only called once the guard has tripped. */
    const wedgeMessage = (move) =>
      `Gimbal stopped moving — ${wedge.stuckPositions} consecutive positions ended at the same pose `
      + `(pan ${move.finalYaw.toFixed(1)}, tilt ${move.finalPitch.toFixed(1)})`
      + `${move.stalled === true ? ', with the move loop reporting the axis jammed' : ''}. `
      + 'Stopping so the motors are not driven into a jam until they overheat. Hold '
      + 'Shutter + Switch + Trigger together for ~1s to hardware-reset the gimbal, check the '
      + 'phone is balanced in the cradle, then reconnect and re-run.';
    try {
      if (client) await client.open();
      for (const [i, target] of grid.entries()) {
        const position = i + 1;
        emit({ phase: 'moving', position, total: grid.length, target });

        const move = await moveToClosedLoop({
          yawDeg: target.pan,
          pitchDeg: target.tilt,
          toleranceDeg: body.toleranceDeg ?? 5,
          maxMs: body.maxMs ?? 15000,
        });

        // A non-converged move is recorded, not fatal: a photo from a position that is merely
        // close is still usable, and aborting the whole run would throw away the frames already
        // captured. The caller decides what to do with `converged: false`.
        emit({ phase: 'capturing', position, total: grid.length, converged: move.converged });
        if (!capturePhotos) {
          // Hold still long enough for the scanner's pose poller (~350ms) to see a settled
          // pose and emit a keyframe. Moving straight on would blur the frame it captures.
          await sleep(body.dwellMs ?? 1200);
          const entry = { position, target, converged: move.converged, ticks: move.ticks, pan: move.finalYaw, tilt: move.finalPitch, photoUrl: null, capturedBy: 'scanner-app' };
          results.push(entry);
          emit({ phase: 'captured', ...entry, total: grid.length });
          if (wedge.observe(move)) {
            emit({
              phase: 'error',
              error: `${wedgeMessage(move)} The ${results.length} position(s) captured so far are on disk.`,
              captured: results.length,
            });
            res.end();
            return;
          }
          if (gridCancelRequested) {
            emit({ phase: 'error', error: `Scan stopped by request after ${results.length} position(s).`, captured: results.length });
            res.end();
            return;
          }
          continue;
        }

        const photoOpts = { cameraId: body.cameraId ?? '0', resolution: body.resolution ?? '1280x720', quality: body.quality ?? 85 };
        let photoUrl, photoUrlPortrait;
        if (body.bothOrientations) {
          // 'follow' is confirmed landscape; 'lock' (byte 0) is only a best guess at portrait —
          // see the "Orientation toggle" section's own caveat. Land landscape first (the
          // confirmed one) so a run that only manages one shot per position before a failure
          // still has the orientation we trust.
          await buildAndSend('setMode', { mode: 'follow' });
          await sleep(1000);
          photoUrl = await capturePhoto(client, { path: `${prefix}/pos-${String(position).padStart(2, '0')}-landscape.jpg`, ...photoOpts });
          await buildAndSend('setMode', { mode: 'lock' });
          await sleep(1000);
          photoUrlPortrait = await capturePhoto(client, { path: `${prefix}/pos-${String(position).padStart(2, '0')}-portrait.jpg`, ...photoOpts });
        } else {
          photoUrl = await capturePhoto(client, { path: `${prefix}/pos-${String(position).padStart(2, '0')}.jpg`, ...photoOpts });
        }

        const entry = { position, target, converged: move.converged, ticks: move.ticks, pan: move.finalYaw, tilt: move.finalPitch, photoUrl, ...(photoUrlPortrait ? { photoUrlPortrait } : {}) };
        results.push(entry);
        emit({ phase: 'captured', ...entry, total: grid.length });

        // Wedge/jam detection — createWedgeGuard() in protocol/stall.mjs, shared with the
        // movement-only path above rather than written inline here (that split is what let the
        // scanner path run with no wedge check at all).
        if (wedge.observe(move)) {
          emit({
            phase: 'error',
            error: `${wedgeMessage(move)} The ${results.length} position(s) captured so far are on disk.`,
            captured: results.length,
          });
          res.end();
          return;
        }

        if (gridCancelRequested) {
          emit({ phase: 'error', error: `Scan stopped by request after ${results.length} position(s).`, captured: results.length });
          res.end();
          return;
        }
      }
    } catch (err) {
      emit({ phase: 'error', error: String(err.message || err), captured: results.length });
      res.end();
      return;
    } finally {
      // Before anything else: a run that ended early (wedge abort, stop request, thrown error)
      // can still have a speed command latched. Leaving it is how the gimbal overheats.
      await stopMotors();
      gridRunning = false;
      if (client) await client.close();
    }

    const converged = results.filter((r) => r.converged).length;
    emit({ phase: 'done', total: grid.length, converged });
    res.end();
  },

  // One-off capture at the gimbal's CURRENT position — not a grid, just "take a photo now"
  // for the quick-action buttons. `bothOrientations: true` shoots landscape (confirmed via
  // setMode('follow')) then rotates to the byte-0 orientation and shoots again; that second
  // orientation is NOT independently confirmed to be portrait — see the "Orientation toggle"
  // section's own caveat — so callers should treat it as best-effort, not verified.
  'POST /api/capture-photo': async (req) => {
    const body = await readJsonBody(req);
    const deviceUrl = body.deviceUrl ?? process.env.ANDROID_MCP_URL;
    const deviceToken = body.deviceToken ?? process.env.ANDROID_MCP_TOKEN;
    if (!deviceUrl) return [400, { error: 'deviceUrl is required (or set ANDROID_MCP_URL)' }];
    if (!deviceToken) return [400, { error: 'deviceToken is required (or set ANDROID_MCP_TOKEN) — see .env.example' }];
    const prefix = body.prefix ?? `shot-${Date.now()}`;
    const client = new AndroidMcpClient({ url: deviceUrl, token: deviceToken });
    const shots = [];
    try {
      await client.open();
      if (body.bothOrientations) {
        await buildAndSend('setMode', { mode: 'follow' }); // confirmed landscape
        await sleep(1200); // let the physical rotation settle before the shot
        shots.push({ orientation: 'landscape', photoUrl: await capturePhoto(client, {
          path: `${prefix}-landscape.jpg`, cameraId: body.cameraId ?? '0',
          resolution: body.resolution ?? '1280x720', quality: body.quality ?? 85,
        }) });
        await buildAndSend('setMode', { mode: 'lock' }); // best-guess portrait — unconfirmed
        await sleep(1200);
        shots.push({ orientation: 'portrait-unconfirmed', photoUrl: await capturePhoto(client, {
          path: `${prefix}-portrait.jpg`, cameraId: body.cameraId ?? '0',
          resolution: body.resolution ?? '1280x720', quality: body.quality ?? 85,
        }) });
      } else {
        shots.push({ orientation: body.orientation ?? 'current', photoUrl: await capturePhoto(client, {
          path: `${prefix}.jpg`, cameraId: body.cameraId ?? '0',
          resolution: body.resolution ?? '1280x720', quality: body.quality ?? 85,
        }) });
      }
    } catch (err) {
      return [500, { error: String(err.message || err), shots }];
    } finally {
      await client.close();
    }
    return [200, { shots }];
  },

  // Which capture session did a movement-only sweep actually feed?
  //
  // In movement-only mode this backend never touches the phone — the scanner web app streams
  // its own pose-tagged keyframes straight to the CI-Spatial server. That is the point (those
  // AR poses are the only metric reference the pipeline has), but it also means this backend
  // is blind to whether anything was captured. An operator would otherwise sweep 27 positions,
  // see "done", and only discover an empty session minutes later in the editor.
  //
  // So ask the scan server directly. Proxied through here rather than called from the browser
  // because the control UI is served from a different origin and the scan server sets no CORS
  // header for it; the backend already talks to that host for ingest.
  'GET /api/scan-sessions': async (req, url) => {
    const base = url.searchParams.get('server') || process.env.CI_SPATIAL_URL || 'http://localhost:8000';
    try {
      const res = await fetch(`${base}/sessions`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [502, { error: `scan server returned HTTP ${res.status}`, base }];
      const sessions = await res.json();
      // Newest first, and only the live-AR ones: a photo-ingest session is a previous upload,
      // never something this sweep produced.
      const live = (Array.isArray(sessions) ? sessions : [])
        .filter((s) => s && s.source !== 'photo-ingest')
        .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
      return [200, { base, liveSessions: live.slice(0, 5), total: live.length }];
    } catch (err) {
      return [502, {
        error: String(err.message || err),
        base,
        remediation: 'Is the CI-Spatial Deno server running on that origin? Set CI_SPATIAL_URL to point elsewhere.',
      }];
    }
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
    // /api/grid-capture streams its own response (see that handler's own comment for why —
    // long-running, no single buffered body) and manages `res` directly, so it returns
    // undefined instead of a [code, body] tuple. Every other route is unchanged.
    const result = await handler(req, url, res);
    if (result !== undefined) {
      const [code, body] = result;
      sendJson(res, code, body);
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end(JSON.stringify({ phase: 'error', error: err.message }) + '\n');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'status', ...statusPayload() }));
  // /ws used to be send-only; phone telemetry is the first thing that talks back up it. See
  // handleInboundWsMessage for why every rejection path there returns instead of throwing.
  ws.on('message', (data, isBinary) => handleInboundWsMessage(ws, data, isBinary));
  // ws re-throws a socket 'error' as an uncaught exception when nothing is listening for it, so
  // without this line a phone dropping off Wi-Fi mid-send can kill the backend. Logged and
  // dropped; the 'close' that follows does the actual cleanup.
  ws.on('error', (err) => console.warn(`[ws] client socket error: ${err.message}`));
  ws.on('close', () => wsClients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`Osmo BLE backend: http://localhost:${PORT}  (WebSocket at /ws)`);
});

/**
 * Stop the motors before this process goes away.
 *
 * `npm run backend` runs under `node --watch`, which SIGTERMs and respawns on every file save.
 * Without this the gimbal keeps driving at whatever speed was latched when the process died —
 * and because the BLE link drops with it, nothing can tell it to stop. Editing this very file
 * mid-session is therefore enough to cook the hardware, which is exactly what happened on
 * 2026-08-26 (several unexplained thermal shutdowns, each one right after a save).
 *
 * Registered for the signals `--watch`, Ctrl-C and a normal kill actually send. `exit` cannot
 * be used: it is synchronous and the stop frame is an async BLE write.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR2']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    gridCancelRequested = true;
    await stopMotors();
    process.exit(0);
  });
}
