/**
 * Stall detection for the closed-loop gimbal move.
 *
 * Split out of backend.mjs so it can be tested against real captured telemetry
 * without a gimbal, a BLE stack, or a running backend — which matters because
 * the failure this guards against only appears on tired hardware, and is
 * therefore exactly the thing nobody can reproduce on demand.
 *
 * The distinction being drawn is between two states that look identical to a
 * timeout:
 *
 *   - converging slowly  — a longer maxMs would help
 *   - jammed             — a longer maxMs is 30 wasted seconds
 *
 * Telemetry keeps streaming at full rate in both cases. The only difference is
 * whether the reported angle changes.
 */

/**
 * Per-tick motion below this counts as "did not move".
 *
 * Measured on an OM6 on 2026-08-26: a tick genuinely driving the motors moves
 * pan by 5-15°, while a wedged axis reports ~0.005°. 0.25° sits two orders of
 * magnitude above that noise floor and an order below the smallest real step,
 * so the two populations do not overlap and this needs no tuning.
 */
export const STALL_EPSILON_DEG = 0.25;

/** Consecutive stalled ticks before declaring a jam (~2.4s at a 400ms tick). */
export const STALL_TICKS_LIMIT = 6;

/** Shortest signed distance between two angles, in degrees. */
export function wrapDeg(deg) {
  let d = deg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * How far the gimbal actually moved between two samples, in degrees.
 *
 * Pan is wrapped because it crosses ±180 mid-sweep — without that, one
 * wrap-around reads as a 340° leap and resets the stall counter, so a gimbal
 * that jams just after crossing the seam would never be detected.
 */
export function movedDeg(prev, cur) {
  return Math.abs(wrapDeg(cur.pan - prev.pan)) + Math.abs(cur.tilt - prev.tilt);
}

/**
 * Fold one sample into a running stall count.
 *
 * Returns the new consecutive-stalled-tick count. Callers treat
 * `>= STALL_TICKS_LIMIT` as jammed. Only meaningful while a correction is
 * actually being commanded — a gimbal sitting still because it has arrived is
 * not stalled, so callers must check convergence first.
 */
export function foldStall(stalledTicks, prev, cur) {
  if (!prev) return 0;
  return movedDeg(prev, cur) < STALL_EPSILON_DEG ? stalledTicks + 1 : 0;
}

/**
 * Index of the tick at which a run of samples should be declared jammed, or -1
 * if it never is. Pure convenience over foldStall for whole-history analysis.
 */
export function firstStallTick(samples) {
  let stalled = 0;
  for (let i = 0; i < samples.length; i++) {
    stalled = foldStall(stalled, i === 0 ? null : samples[i - 1], samples[i]);
    if (stalled >= STALL_TICKS_LIMIT) return i;
  }
  return -1;
}
