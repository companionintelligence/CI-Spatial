import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGimbalAbsoluteAngle, buildGimbalRecenter, buildGimbalResetAndCenter, buildGimbalSetMode,
  buildGimbalSpeedControl, buildGimbalStickControlEnable, buildRawCommand,
} from './commands.mjs';
import { decodeFrame } from './duml.mjs';
import { CMD_SET, CMD_ID, GIMBAL_MODE } from './constants.mjs';
import {
  motionRefusal, moveRefusal, MotionRefusedError, OUTSIDE_MOTION_BUSY, SCAN_OWNS_GIMBAL,
} from './motion_gate.mjs';

// F5-1: a parked scan exempts the operator only while nothing else is driving the motors. A move or probe the
// backend started is still driving them, so a parked scan refuses non-stop motion while it runs, the same way an
// unparked scan does. Stops always pass. These are the pure rules, judged on the decoded bytes as backend.mjs
// judges them. No BLE, no gimbal, no network.

const judged = (frame) => decodeFrame(frame);
const PARKED_WITH_OUTSIDE = { scanRunning: true, parked: true, outsideMotion: true };
const PARKED_ALONE = { scanRunning: true, parked: true, outsideMotion: false };

test('F5-1: a parked scan refuses every non-stop motion while an outside move or probe is still driving', () => {
  const motion = [
    buildGimbalSpeedControl(1, { yawDegPerSec: 30 }),
    buildGimbalRecenter(1),
    buildGimbalAbsoluteAngle(1, { yawDeg: 20 }),
    buildGimbalSetMode(1, GIMBAL_MODE.FOLLOW),
    buildGimbalResetAndCenter(1),
    buildGimbalStickControlEnable(1, true),
  ];
  for (const frame of motion) {
    const f = judged(frame);
    const refusal = motionRefusal(f, PARKED_WITH_OUTSIDE);
    assert.ok(refusal instanceof MotionRefusedError, 'cmdId 0x' + f.cmdId.toString(16) + ' is refused');
    assert.equal(refusal.status, 409);
    assert.equal(refusal.message, OUTSIDE_MOTION_BUSY.error);
    assert.equal(refusal.remediation, OUTSIDE_MOTION_BUSY.remediation);
  }
});

test('F5-1: a raw frame that drives the gimbal is refused while a parked scan has an outside move, and a raw stop is not', () => {
  const drive = buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '1e000000008100' });
  assert.ok(motionRefusal(judged(drive), PARKED_WITH_OUTSIDE) instanceof MotionRefusedError);
  const stop = buildRawCommand(1, { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '0000000000008100' });
  assert.equal(motionRefusal(judged(stop), PARKED_WITH_OUTSIDE), null);
});

test('F5-1: a zero-speed stop goes through while a parked scan has an outside move driving', () => {
  assert.equal(motionRefusal(judged(buildGimbalSpeedControl(1, {})), PARKED_WITH_OUTSIDE), null);
});

test('F5-1: turning the stick off takes control away, so it goes through while an outside move is driving', () => {
  assert.equal(motionRefusal(judged(buildGimbalStickControlEnable(1, false)), PARKED_WITH_OUTSIDE), null);
});

test('F5-1 control: a parked scan with nothing outside still lets motion through, as before', () => {
  const frames = [
    buildGimbalSpeedControl(1, { yawDegPerSec: 30 }),
    buildGimbalRecenter(1),
    buildGimbalSetMode(1, GIMBAL_MODE.FOLLOW),
    buildGimbalStickControlEnable(1, true),
  ];
  for (const frame of frames) {
    assert.equal(motionRefusal(judged(frame), PARKED_ALONE), null);
  }
});

test('F5-1: an unparked running scan keeps its own wording, whether or not an outside move is driving', () => {
  const frame = judged(buildGimbalSpeedControl(1, { yawDegPerSec: 30 }));
  for (const outsideMotion of [false, true]) {
    const refusal = motionRefusal(frame, { scanRunning: true, parked: false, outsideMotion });
    assert.ok(refusal instanceof MotionRefusedError, 'outsideMotion ' + outsideMotion + ' is refused');
    assert.equal(refusal.message, SCAN_OWNS_GIMBAL.error);
    assert.equal(refusal.remediation, SCAN_OWNS_GIMBAL.remediation);
  }
});

test('F5-1: a parked scan refuses a new move-to or arc probe while another move or probe is still driving', () => {
  const refused = moveRefusal({ scanRunning: true, parked: true, outsideMotion: true });
  assert.ok(refused instanceof MotionRefusedError);
  assert.equal(refused.status, 409);
  assert.equal(refused.message, OUTSIDE_MOTION_BUSY.error);
  assert.equal(refused.remediation, OUTSIDE_MOTION_BUSY.remediation);
  assert.equal(moveRefusal({ scanRunning: true, parked: true, outsideMotion: false }), null);
});

test('F5-1 control: with no scan running, an outside move does not refuse another move here', () => {
  assert.equal(moveRefusal({ scanRunning: false, parked: false, outsideMotion: true }), null);
});
