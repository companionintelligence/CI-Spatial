// Decoders for unsolicited telemetry frames the gimbal streams once connected+subscribed —
// discovered live against a real Osmo Mobile 6 (see ../README.md). Shared between the Node
// backend and the browser client so both interpret telemetry identically.

/**
 * The gimbal streams continuous orientation telemetry unprompted (cmdSet=0x4, cmdId=0x5) —
 * a normalized quaternion at payload offset 24 (4 little-endian float32s, magnitude ~1.0).
 * This is real ground truth for testing whether a command actually moved the gimbal: diff
 * this before/after sending one.
 */
export function decodeQuaternion(frame) {
  if (frame.cmdSet !== 0x4 || frame.cmdId !== 0x5 || frame.payload.length < 40) return null;
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset + 24, 16);
  return [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true), view.getFloat32(12, true)];
}

/** Euclidean distance between two quaternion samples — a simple "did orientation change" metric. */
export function quaternionDelta(a, b) {
  if (!a || !b) return null;
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}

/**
 * Standard ZYX Tait-Bryan extraction — an APPROXIMATE decomposition, not a calibrated attitude
 * readout. We haven't confirmed which axis of the gimbal's own quaternion frame maps to which
 * real-world pitch/yaw/roll, and Euler angles from a tilted device mix axes together (classic
 * gimbal-lock-adjacent coupling) — treat this as a relative-change indicator. Shared by the web
 * orientation readout and the backend's closed-loop move-to controller (server/backend.mjs).
 */
export function quatToEulerDeg([x, y, z, w]) {
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);

  const toDeg = (r) => (r * 180) / Math.PI;
  return { roll: toDeg(roll), pitch: toDeg(pitch), yaw: toDeg(yaw) };
}
