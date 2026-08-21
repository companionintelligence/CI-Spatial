// Command builders on top of the raw DUML codec. Each export documents its confidence
// level per the protocol research (see ../README.md) — none of this has been verified
// against a real Osmo Mobile 6 yet.

import { encodeFrame, packString } from './duml.mjs';
import { COMPONENT, FLAGS, CMD_SET, CMD_ID, GIMBAL_MODE, DEFAULT_IDENTIFIER } from './constants.mjs';

/** Monotonic big-endian msgId sequence, matching the pattern all three reference implementations use. */
export class MsgIdSequence {
  constructor(start = 0x0100) {
    this._next = start & 0xffff;
  }
  next() {
    const id = this._next;
    this._next = (this._next + 1) & 0xffff;
    return id;
  }
}

/**
 * SetPairingPIN request. HIGH confidence (byte-exact test vector verified in duml.test.mjs).
 * The PIN is shown on the gimbal's own screen during pairing — do not hardcode a guessed
 * default; the caller must supply what the device actually displays.
 */
export function buildSetPairingPin(msgId, pin, identifier = DEFAULT_IDENTIFIER) {
  const payload = new Uint8Array([...packString(identifier), ...packString(pin)]);
  return encodeFrame({
    sender: COMPONENT.APP,
    receiver: COMPONENT.WIFI,
    msgId,
    flags: FLAGS.REQUEST,
    cmdSet: CMD_SET.WIFI,
    cmdId: CMD_ID.SET_PAIRING_PIN,
    payload,
  });
}

// Live telemetry from a real OM6 shows all cmdSet=0x04 (gimbal-function) traffic sourced from
// DUML component 0x04 — component 0x01 ("Camera" in the generic DJI component table) never
// appears at all, which makes sense since OM6 has no camera. Default gimbal-function command
// receivers to 0x04 accordingly (COMPONENT.FLIGHT_CONTROLLER is a generic-product name; on this
// device it's empirically the active gimbal-control board).
const GIMBAL_RECEIVER = COMPONENT.FLIGHT_CONTROLLER;

/**
 * Enable/disable handheld-gimbal joystick (stick) control. HIGH confidence — payload
 * structure CONFIRMED by disassembling HandheldGimbalAbstraction::SetStickGimbalControlEnabled
 * in libdjisdk_jni.so: it copies the input bool verbatim to a single output byte, exactly
 * matching what's implemented here. Still don't know if it's actually a *required*
 * precondition before speed/angle commands are honored — that part remains untested live.
 */
export function buildGimbalStickControlEnable(msgId, enable = true) {
  const payload = Uint8Array.from([enable ? 0x01 : 0x00]);
  return encodeFrame({
    sender: COMPONENT.APP,
    receiver: GIMBAL_RECEIVER,
    msgId,
    flags: FLAGS.REQUEST,
    cmdSet: CMD_SET.GIMBAL_FN,
    cmdId: CMD_ID.GIMBAL_STICK_CONTROL_ENABLE,
    payload,
  });
}

/**
 * Gimbal absolute-angle move (the "ex"/extended angle struct). MEDIUM confidence — payload
 * shape confirmed by disassembling GimbalAbstraction::GetRotateAnglePack in libdjisdk_jni.so
 * (a GimbalAngleRotation object: doubles at +0x10/+0x18/+0x20 become the three int16 axis
 * fields ×10 here; a duration double at +0x30 is TRUNCATED then ×10, not rounded-then-×10 —
 * matches the real code's int-cast-before-multiply order). The flags byte is a 4-bit field
 * (bit0/1/2/3 from four separate source booleans, not one "all axes" flag) — 0x0F ("enable
 * everything") is our best guess for that bitfield, not independently confirmed. cmdId 0x0A
 * (GIMBAL_ANGLE_SET) turned out to be TWO different, larger/more complex structs in this SDK
 * version (a 13-byte variant and a much bigger multi-field "_new" variant) — neither matches
 * this simple 8-byte shape, so 0x0A isn't a drop-in alternative if this one doesn't work.
 *
 * AXIS ORDER: buildGimbalSpeedControl's identical-shaped struct turned out to have yaw at
 * offset0/tilt(inverted) at offset4, not pitch/yaw as originally assumed — applying the same
 * swap+negate here since it's the same axis-field convention family, but unlike speed control
 * this hasn't been independently live-tested (recenter, the only live-tested caller, sends all
 * zeros so it can't distinguish axis order at all). Treat pitch/yaw here as INFERRED, not
 * confirmed, until a non-zero angle move is tested live.
 */
export function buildGimbalAbsoluteAngle(msgId, { pitchDeg = 0, rollDeg = 0, yawDeg = 0, durationSeconds = 1 } = {}) {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setInt16(0, Math.round(yawDeg * 10), true);
  view.setInt16(2, Math.round(rollDeg * 10), true);
  view.setInt16(4, Math.round(-pitchDeg * 10), true);
  payload[6] = 0x0f; // 4-bit per-axis/enable flag field — 0x0F is a best-guess "all enabled"
  payload[7] = Math.min(255, Math.trunc(durationSeconds) * 10); // real code truncates before scaling
  return encodeFrame({
    sender: COMPONENT.APP,
    receiver: GIMBAL_RECEIVER,
    msgId,
    flags: FLAGS.REQUEST,
    cmdSet: CMD_SET.GIMBAL_FN,
    cmdId: CMD_ID.GIMBAL_ABS_ANGLE,
    payload,
  });
}

/** Gimbal recenter — a thin buildGimbalAbsoluteAngle(0,0,0) alias, kept for existing callers. */
export function buildGimbalRecenter(msgId, durationSeconds = 1) {
  return buildGimbalAbsoluteAngle(msgId, { durationSeconds });
}

/**
 * Gimbal speed-control "nudge" — commands the gimbal to move at a given angular speed on
 * each axis (degrees/sec, roughly -180..180) rather than to a fixed angle. HIGH confidence —
 * payload structure CONFIRMED by disassembling GimbalAbstraction::ActionRotateSpeed in
 * libdjisdk_jni.so: it's 8 bytes, not the 7 previously guessed (ported from a different
 * product's community research) — three int16LE axis fields ×10 exactly as before, but the
 * flags byte is 0x81 (not 0x01) and there's a trailing 0x00 padding byte we were missing
 * entirely.
 *
 * AXIS ORDER: LIVE-VERIFIED on a real OM6 via the web UI joystick (2026-08-21) — the
 * "pitch@offset0 / roll@offset2 / yaw@offset4" order assumed from a sibling struct's
 * debug-logged field order was WRONG for this struct. Empirically: offset0 drives pan
 * (yaw) with positive = pan right, and offset4 drives tilt (pitch) with positive = tilt
 * DOWN (so pitchDegPerSec, where positive should mean tilt up by this function's own
 * convention, must be negated going into offset4). Roll's offset/sign is still unconfirmed
 * — no live roll test has been done — so rollDegPerSec is passed straight through as before.
 */
export function buildGimbalSpeedControl(msgId, { pitchDegPerSec = 0, rollDegPerSec = 0, yawDegPerSec = 0 } = {}) {
  const clamp = (v) => Math.max(-180, Math.min(180, v));
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setInt16(0, Math.round(clamp(yawDegPerSec) * 10), true);
  view.setInt16(2, Math.round(clamp(rollDegPerSec) * 10), true);
  view.setInt16(4, Math.round(clamp(-pitchDegPerSec) * 10), true);
  payload[6] = 0x81; // confirmed fixed constant (previously wrongly guessed as 0x01)
  payload[7] = 0x00; // confirmed trailing padding byte, previously missing entirely
  return encodeFrame({
    sender: COMPONENT.APP,
    receiver: GIMBAL_RECEIVER,
    msgId,
    flags: FLAGS.REQUEST,
    cmdSet: CMD_SET.GIMBAL_FN,
    cmdId: CMD_ID.GIMBAL_SPEED_CTRL,
    payload,
  });
}

/**
 * Gimbal mode switch (lock / follow / fpv). CONFIRMED not what it claims to be — disassembly
 * found cmdId 0x44 (GIMBAL_SET_WORK_MODE)'s only caller in the whole binary is
 * GimbalVerticalShotEnabledSet, and live testing on a real OM6 (2026-08-21) matches: sending
 * mode=FOLLOW physically rotates the phone mount to landscape. This is a portrait/vertical-shot
 * toggle, not a lock/follow/fpv selector — the UI should stop calling it "mode" and label it as
 * an orientation/vertical-shot toggle instead. The payload shape (byte0 fixed 0xFE, byte1 the
 * selector, values seen: 1, 3, 4) is otherwise accurate; semantics of 1 vs 3 vs 4 beyond
 * "landscape happens on FOLLOW's value" are still unresolved. No verified cmdId for a general
 * gimbal work-mode selector exists.
 */
export function buildGimbalSetMode(msgId, mode) {
  if (![GIMBAL_MODE.LOCK, GIMBAL_MODE.FOLLOW, GIMBAL_MODE.FPV].includes(mode)) {
    throw new RangeError(`buildGimbalSetMode: invalid mode ${mode}`);
  }
  const payload = Uint8Array.from([0xfe, mode]);
  return encodeFrame({
    sender: COMPONENT.APP,
    receiver: GIMBAL_RECEIVER,
    msgId,
    flags: FLAGS.REQUEST,
    cmdSet: CMD_SET.GIMBAL_FN,
    cmdId: CMD_ID.GIMBAL_SET_WORK_MODE,
    payload,
  });
}

/**
 * Reset gimbal and return to center. LOW confidence / speculative — libdjisdk_jni.so confirms
 * cmdId GIMBAL_RESET_AND_CENTER (0x4C) is DJI's real dedicated recenter action (SDK alias
 * "action_gimbal_set_reset"), but no payload struct fields were recoverable from strings, so
 * this reuses the same 2-byte [mode, 0x00] shape as buildGimbalSetMode as a best guess.
 */
export function buildGimbalResetAndCenter(msgId, mode = GIMBAL_MODE.FOLLOW) {
  const payload = Uint8Array.from([mode, 0x00]);
  return encodeFrame({
    sender: COMPONENT.APP,
    receiver: GIMBAL_RECEIVER,
    msgId,
    flags: FLAGS.REQUEST,
    cmdSet: CMD_SET.GIMBAL_FN,
    cmdId: CMD_ID.GIMBAL_RESET_AND_CENTER,
    payload,
  });
}

/**
 * Escape hatch for reverse-engineering: build an arbitrary DUML frame. LOW confidence by
 * definition — this is for probing/capturing what the real device does with a given
 * cmdSet/cmdId/payload, not a verified command. Use deliberately and log the response.
 */
export function buildRawCommand(msgId, { sender = COMPONENT.APP, receiver = COMPONENT.CAMERA, flags = FLAGS.REQUEST, cmdSet, cmdId, payloadHex = '' }) {
  const payload = payloadHex.length ? Uint8Array.from(payloadHex.match(/../g).map((b) => parseInt(b, 16))) : new Uint8Array(0);
  return encodeFrame({ sender, receiver, msgId, flags, cmdSet, cmdId, payload });
}
