// The gimbal's motion interlock, as pure rules.
//
// Why it exists: a grid capture drives the same two motors through its own closed loop. Anything
// else that moves them while it runs (a joystick drag, a move-to, a probe, a raw frame, or a mount
// mode change that rotates the phone) is a second controller fighting the first, and the poses the
// capture is building stop meaning anything.
//
// server/backend.mjs owns the state (is a scan running, is it parked between stations, is an outside move
// or probe still driving the motors). It asks these functions what a frame may do. Nothing here keeps state
// of its own.

import { CMD_SET, CMD_ID } from './constants.mjs';

/** What the operator reads when a scan owns the gimbal. One wording for every refusal. */
export const SCAN_OWNS_GIMBAL = Object.freeze({
  error: 'A scan is running and owns the gimbal — motion commands are rejected until it finishes.',
  remediation: 'Wait for the scan to finish, or stop it, before moving the gimbal by hand.',
});

/**
 * What the operator reads when a scan is parked and a move or probe the backend started is still
 * driving the same motors. Only stops get through until that move or probe has finished.
 */
export const OUTSIDE_MOTION_BUSY = Object.freeze({
  error: 'A move or probe is still driving the gimbal — motion commands are rejected until it finishes.',
  remediation: 'Wait for it to finish, then try again. It stops on its own.',
});

/**
 * The interlock refused a motion. The request is well formed and lost a race for one physical
 * resource, so it is reported as 409 Conflict, not as a bad request. `wording` is one of the
 * frozen messages above.
 */
export class MotionRefusedError extends Error {
  constructor(wording = SCAN_OWNS_GIMBAL) {
    super(wording.error);
    this.name = 'MotionRefusedError';
    this.status = 409;
    this.remediation = wording.remediation;
  }
}

/**
 * True when a frame moves the mount or changes where it points.
 *
 * Every gimbal-function command does one of those, with one exception decided by its bytes. The
 * stick-enable toggle moves nothing by itself, but turning the handle's joystick ON hands the mount
 * to a second controller, so that counts as motion. Turning it OFF takes that control away, so it
 * does not. An unrecognised gimbal-function id counts as motion: a raw frame can reach any of them,
 * and refusing a harmless one during a scan costs nothing.
 *
 * @param {number} cmdSet
 * @param {number} cmdId
 * @param {Uint8Array|undefined} payload  decides the stick toggle; without it the toggle counts as ON
 * @returns {boolean}
 */
export function isMotionFrame(cmdSet, cmdId, payload) {
  if (cmdSet !== CMD_SET.GIMBAL_FN) return false;
  if (cmdId === CMD_ID.GIMBAL_STICK_CONTROL_ENABLE) return !isStickOffFrame(payload);
  return true;
}

/**
 * True for a stick-enable frame that turns the joystick OFF: exactly one 0x00 byte, which is what
 * buildGimbalStickControlEnable() writes. Anything longer, empty or missing is not read as OFF.
 *
 * @param {Uint8Array|undefined} payload
 * @returns {boolean}
 */
function isStickOffFrame(payload) {
  return payload?.length === 1 && payload[0] === 0x00;
}

/**
 * True for a speed command whose three axes are all zero: a stop.
 *
 * The axes are the first six payload bytes (int16 little-endian: yaw, roll, pitch), so all-zero
 * there is zero on the wire. A stop is never refused: it is the command that ends a latched speed,
 * and a scan is exactly when a gimbal may need one.
 *
 * @param {number} cmdSet
 * @param {number} cmdId
 * @param {Uint8Array|undefined} payload
 * @returns {boolean}
 */
export function isStopFrame(cmdSet, cmdId, payload) {
  if (cmdSet !== CMD_SET.GIMBAL_FN || cmdId !== CMD_ID.GIMBAL_SPEED_CTRL) return false;
  if (!payload || payload.length < 6) return false;
  for (let i = 0; i < 6; i++) {
    if (payload[i] !== 0) return false;
  }
  return true;
}

/**
 * The interlock's ruling on one frame about to leave the process.
 *
 * Refused only when a scan is running, the frame moves the mount, it is not a stop, and the frame did
 * not come from the scan itself. A parked scan is exempt while nothing else is driving the motors:
 * between stations nothing is controlling them, and the operator is carrying the rig and may need the
 * joystick and Center. A move or probe the backend started is a different case. While one is still
 * driving the motors (`outsideMotion`), a parked scan refuses non-stop motion just as an unparked one
 * does. Stops always pass.
 *
 * @param {{cmdSet: number, cmdId: number, payload?: Uint8Array}} frame  decoded from the bytes
 * @param {{scanRunning: boolean, parked?: boolean, runOwned?: boolean, outsideMotion?: boolean}} state
 * @returns {MotionRefusedError|null}  null when the frame may go out
 */
export function motionRefusal(frame, { scanRunning, parked = false, runOwned = false, outsideMotion = false }) {
  if (!scanRunning || runOwned) return null;
  if (parked && !outsideMotion) return null;
  if (!isMotionFrame(frame.cmdSet, frame.cmdId, frame.payload)) return null;
  if (isStopFrame(frame.cmdSet, frame.cmdId, frame.payload)) return null;
  return new MotionRefusedError(parked ? OUTSIDE_MOTION_BUSY : SCAN_OWNS_GIMBAL);
}

/**
 * The same ruling for a closed-loop move (move-to) and for an arc probe. Each sends its own speed
 * frames, one per tick, rather than going through buildAndSend() once, so its route asks this before
 * it starts. A parked scan refuses a new one while another move or probe is still driving the motors.
 *
 * @param {{scanRunning: boolean, parked?: boolean, outsideMotion?: boolean}} state
 * @returns {MotionRefusedError|null}
 */
export function moveRefusal({ scanRunning, parked = false, outsideMotion = false }) {
  if (!scanRunning) return null;
  if (!parked) return new MotionRefusedError(SCAN_OWNS_GIMBAL);
  return outsideMotion ? new MotionRefusedError(OUTSIDE_MOTION_BUSY) : null;
}
