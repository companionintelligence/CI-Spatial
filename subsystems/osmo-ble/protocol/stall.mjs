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

/**
 * Stall state machine for one closed-loop move.
 *
 * Encapsulated rather than left as loose flags in the control loop because the
 * inline version grew two control-flow bugs in a single sitting: a `continue`
 * that spun the loop without ever commanding the flipped direction, and then a
 * missing `else` that flipped the sign and returned "jammed" in the same tick.
 * Both were invisible in the happy path and only showed up as a nonsense
 * "did not move for 0 consecutive ticks" in an error string. Three states and
 * one transition is small enough to test exhaustively; the loop just asks.
 *
 * Verdicts:
 *   'ok'         — keep driving
 *   'flip-sign'  — stalled, but the correction sign has not been tried the
 *                  other way yet. Flip and keep driving.
 *   'jammed'     — stalled in both directions. Give up.
 *
 * The flip matters because the sign is derived from an approximate Euler
 * decomposition that does not hold at every pose. Measured 2026-08-26: a move
 * sat at pan -53.6 for three separate attempts and was reported jammed; with
 * the flip it moved -53.6 -> -122.7 and converged in 6.9s. A "jam" that is
 * really a sign error is the common case, not the rare one.
 */
export function createStallGuard() {
  let stalled = 0;
  let flipped = false;
  let prev = null;
  return {
    /** Fold one sample; returns 'ok' | 'flip-sign' | 'jammed'. */
    observe(cur) {
      stalled = foldStall(stalled, prev, cur);
      prev = cur;
      if (stalled < STALL_TICKS_LIMIT) return 'ok';
      if (!flipped) {
        flipped = true;
        // Reset so the flipped direction gets a full budget of its own before
        // being judged — otherwise one leftover tick condemns it immediately.
        stalled = 0;
        return 'flip-sign';
      }
      return 'jammed';
    },
    /** Consecutive stalled ticks, for the diagnostic message. */
    get stalledTicks() { return stalled; },
    /** Whether the sign was flipped during this move. */
    get flipped() { return flipped; },
  };
}

/** Pose movement below this (degrees) between consecutive non-converged MOVES reads as "not moving". */
export const STUCK_POSE_EPSILON_DEG = 1.5;

/** How many such positions in a row before calling the whole run wedged. Two could be a tight corner. */
export const STUCK_POSITIONS_LIMIT = 3;

/**
 * Run-level wedge detection: the grid-scan analogue of createStallGuard().
 *
 * createStallGuard() judges TICKS within one move. This judges MOVES within one
 * scan run, and exists because those are genuinely different failures: a single
 * move can legitimately fall short (tight corner, tolerance a hair too small),
 * but a whole run whose consecutive moves all end at the *same* pose is a gimbal
 * that has stopped moving, and every further position just drives the motors
 * into the jam.
 *
 * That is not hypothetical. On 2026-08-26 a movement-only run took an OM6
 * through 10 consecutive positions all reporting pan 105.56 / tilt 27.18 —
 * bit-identical — because the movement-only branch `continue`d past the inline
 * wedge check that then lived only in the photo path. The motors held against
 * the jam for the whole run and the gimbal overheated and shut itself off. The
 * guard is a shared function now precisely so a second caller cannot skip it.
 *
 * `stalled` (from moveToClosedLoop, whose own createStallGuard already probed
 * BOTH correction directions) is the strongest available signal, so it counts
 * on its own; otherwise fall back to comparing poses.
 */
export function createWedgeGuard() {
  let stuckRun = 0;
  let lastPose = null;
  return {
    /**
     * Fold one completed move. Returns true when the run should abort.
     *
     * A converged move clears the count: progress anywhere means the gimbal is
     * alive, so a later jam gets a full budget of its own rather than inheriting
     * stale suspicion.
     */
    observe(move) {
      if (move.converged || move.finalYaw == null || move.finalPitch == null) {
        stuckRun = 0;
        lastPose = null;
        return false;
      }
      const poseRepeated = lastPose !== null
        && Math.abs(wrapDeg(move.finalYaw - lastPose.pan)) < STUCK_POSE_EPSILON_DEG
        && Math.abs(move.finalPitch - lastPose.tilt) < STUCK_POSE_EPSILON_DEG;
      stuckRun = (move.stalled === true || poseRepeated) ? stuckRun + 1 : 1;
      lastPose = { pan: move.finalYaw, tilt: move.finalPitch };
      return stuckRun >= STUCK_POSITIONS_LIMIT;
    },
    /** Consecutive stuck positions, for the diagnostic message. */
    get stuckPositions() { return stuckRun; },
  };
}
