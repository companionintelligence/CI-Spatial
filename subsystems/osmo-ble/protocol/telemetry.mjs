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
