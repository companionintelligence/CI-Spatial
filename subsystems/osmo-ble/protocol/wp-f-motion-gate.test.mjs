import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGimbalAbsoluteAngle, buildGimbalRecenter, buildGimbalResetAndCenter, buildGimbalSetMode,
  buildGimbalSpeedControl, buildGimbalStickControlEnable, buildRawCommand,
} from './commands.mjs';
import { decodeFrame } from './duml.mjs';
import { CMD_SET, CMD_ID, GIMBAL_MODE } from './constants.mjs';
import { isMotionFrame, isStopFrame, motionRefusal, moveRefusal, MotionRefusedError } from './motion_gate.mjs';

// What backend.mjs does with each outgoing frame: decode the bytes that are about to leave, then ask.
const judged = (frame) => decodeFrame(frame);
const SCAN_RUNNING = { scanRunning: true };

test('every gimbal motion command is classed as motion', () => {
  const motion = [
    buildGimbalSpeedControl(1, { yawDegPerSec: 30 }),
    buildGimbalAbsoluteAngle(1, { yawDeg: 20 }),
    buildGimbalRecenter(1),
    buildGimbalSetMode(1, GIMBAL_MODE.FOLLOW),
    buildGimbalResetAndCenter(1),
  ];
  for (const frame of motion) {
    const f = judged(frame);
    assert.equal(isMotionFrame(f.cmdSet, f.cmdId), true, `cmdId 0x${f.cmdId.toString(16)} should be motion`);
  }
});

test('turning the stick on is motion, because the handle can then drive the mount; turning it off is not', () => {
  const on = judged(buildGimbalStickControlEnable(1, true));
  assert.equal(isMotionFrame(on.cmdSet, on.cmdId, on.payload), true);
  const off = judged(buildGimbalStickControlEnable(1, false));
  assert.equal(isMotionFrame(off.cmdSet, off.cmdId, off.payload), false);
});

test('a frame outside the gimbal command set is not motion', () => {
  const f = judged(buildRawCommand(1, { cmdSet: CMD_SET.WIFI, cmdId: CMD_ID.SET_PAIRING_PIN, payloadHex: '0100' }));
  assert.equal(isMotionFrame(f.cmdSet, f.cmdId), false);
});

test('an unrecognised gimbal-function id is treated as motion, because a raw frame can reach it', () => {
  const f = judged(buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: 0x7f }));
  assert.equal(isMotionFrame(f.cmdSet, f.cmdId), true);
});

test('an all-zero speed command is a stop', () => {
  const f = judged(buildGimbalSpeedControl(1, {}));
  assert.equal(isStopFrame(f.cmdSet, f.cmdId, f.payload), true);
});

test('a speed command moving any one axis is not a stop', () => {
  for (const axis of [{ yawDegPerSec: 5 }, { rollDegPerSec: 5 }, { pitchDegPerSec: 5 }]) {
    const f = judged(buildGimbalSpeedControl(1, axis));
    assert.equal(isStopFrame(f.cmdSet, f.cmdId, f.payload), false, JSON.stringify(axis));
  }
});

test('a zero-angle absolute move is not a stop: only speed commands can be', () => {
  const f = judged(buildGimbalRecenter(1));
  assert.equal(isStopFrame(f.cmdSet, f.cmdId, f.payload), false);
});

test('a speed payload too short to read its axes is not treated as a stop', () => {
  assert.equal(isStopFrame(CMD_SET.GIMBAL_FN, CMD_ID.GIMBAL_SPEED_CTRL, new Uint8Array(4)), false);
});

test('a running scan refuses every motion sent from outside, with a 409', () => {
  const outside = [
    buildGimbalSpeedControl(1, { yawDegPerSec: 30 }),
    buildGimbalAbsoluteAngle(1, { yawDeg: 20 }),
    buildGimbalRecenter(1),
    buildGimbalSetMode(1, GIMBAL_MODE.FOLLOW),
    buildGimbalResetAndCenter(1),
    buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '1e000000008100' }),
  ];
  for (const frame of outside) {
    const refusal = motionRefusal(judged(frame), SCAN_RUNNING);
    assert.ok(refusal instanceof MotionRefusedError, 'refused');
    assert.equal(refusal.status, 409);
    assert.match(refusal.remediation, /Wait for the scan/);
  }
});

test('a running scan still lets a stop through, so the motors can always be stopped', () => {
  assert.equal(motionRefusal(judged(buildGimbalSpeedControl(1, {})), SCAN_RUNNING), null);
});

test('a running scan refuses turning the stick on, with a 409, and allows turning it off', () => {
  const refused = motionRefusal(judged(buildGimbalStickControlEnable(1, true)), SCAN_RUNNING);
  assert.ok(refused instanceof MotionRefusedError, 'stick on is refused while a scan runs');
  assert.equal(refused.status, 409);
  assert.equal(motionRefusal(judged(buildGimbalStickControlEnable(1, false)), SCAN_RUNNING), null);
});

test('the stick toggle defaults to on, so a request with no enable value is refused during a scan', () => {
  assert.ok(motionRefusal(judged(buildGimbalStickControlEnable(1)), SCAN_RUNNING) instanceof MotionRefusedError);
});

test('a parked scan lets the stick be turned on, because nothing is controlling the motors then', () => {
  const frame = judged(buildGimbalStickControlEnable(1, true));
  assert.equal(motionRefusal(frame, { scanRunning: true, parked: true }), null);
});

test('a stick-enable frame that is not exactly one 0x00 byte is treated as on, and refused', () => {
  const empty = judged(buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_STICK_CONTROL_ENABLE }));
  assert.ok(motionRefusal(empty, SCAN_RUNNING) instanceof MotionRefusedError);
  const two = judged(buildRawCommand(1, {
    cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_STICK_CONTROL_ENABLE, payloadHex: '0000',
  }));
  assert.ok(motionRefusal(two, SCAN_RUNNING) instanceof MotionRefusedError);
});

test('a parked scan lets motion through, because nothing is controlling the motors then', () => {
  const frame = judged(buildGimbalSpeedControl(1, { yawDegPerSec: 30 }));
  assert.equal(motionRefusal(frame, { scanRunning: true, parked: true }), null);
});

test('the scan\'s own mode change is not refused when the scan sends it', () => {
  const frame = judged(buildGimbalSetMode(1, GIMBAL_MODE.FOLLOW));
  assert.equal(motionRefusal(frame, { scanRunning: true, runOwned: true }), null);
  assert.ok(motionRefusal(frame, { scanRunning: true }) instanceof MotionRefusedError);
});

test('with no scan running, every frame is allowed', () => {
  const frame = judged(buildGimbalSpeedControl(1, { yawDegPerSec: 30 }));
  assert.equal(motionRefusal(frame, { scanRunning: false }), null);
});

test('a closed-loop move is refused while a scan runs unparked, and allowed otherwise', () => {
  const refused = moveRefusal({ scanRunning: true, parked: false });
  assert.ok(refused instanceof MotionRefusedError);
  assert.equal(refused.status, 409);
  assert.equal(moveRefusal({ scanRunning: true, parked: true }), null);
  assert.equal(moveRefusal({ scanRunning: false, parked: false }), null);
});

test('a raw frame that drives the gimbal is refused by its bytes, not by its name', () => {
  const drive = buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '1e000000008100' });
  assert.ok(motionRefusal(judged(drive), SCAN_RUNNING) instanceof MotionRefusedError);
  const stop = buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '0000000000008100' });
  assert.equal(motionRefusal(judged(stop), SCAN_RUNNING), null);
});

test('a malformed raw payload is refused instead of being sent as different bytes', () => {
  for (const payloadHex of ['abc', '0g', '01 ff', 'zz', 0x1234, null]) {
    assert.throws(
      () => buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex }),
      RangeError,
      `payloadHex ${String(payloadHex)} should be refused`,
    );
  }
});

test('a well-formed raw payload is built byte for byte, in either case, and an empty one is empty', () => {
  const f = decodeFrame(buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '0aFf10' }));
  assert.deepEqual([...f.payload], [0x0a, 0xff, 0x10]);
  const empty = decodeFrame(buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL }));
  assert.equal(empty.payload.length, 0);
});
