/**
 * The closed-loop control law for a gimbal move.
 *
 * Split out of backend.mjs for the same reason stall.mjs was: the failures these guard against
 * only appear on real hardware mid-session, so they are exactly the things nobody can reproduce
 * on demand. As pure functions they can be replayed against telemetry captured from a real OM6.
 *
 * All three functions here fix a specific measured defect from the 2026-08-26 Linux session —
 * see each one's comment for the trace that motivated it.
 */

/**
 * Commanded speed per degree of error.
 *
 * At 0.6 a 25° error asks for 15°/s while a 6° error asks for ~3.6°/s, so the approach
 * decelerates into the tolerance window instead of arriving at full speed and sailing through.
 */
export const PROPORTIONAL_GAIN = 0.6;

/**
 * Floor for a commanded correction, in deg/sec.
 *
 * The motors have a startup deadband: a low or brief command produces no motion at all
 * (measured — a 400ms pulse at 20°/s moved the quaternion by 0.0002, i.e. nothing, while
 * sustained repeats moved it tens of degrees). Without a floor the proportional term shrinks
 * below that deadband near the target and the move stalls just short of arriving.
 */
export const MIN_EFFECTIVE_SPEED_DEG_PER_SEC = 8;

/**
 * Speed to command for one axis, in deg/sec. Zero once inside tolerance.
 *
 * Replaces a bang-bang law that commanded a flat `speedDegPerSec` (25) whenever the error
 * exceeded tolerance, regardless of whether that error was 3° or 90°. One 250ms pulse at 25°/s
 * is ~6° of travel against a 3° tolerance HALF-band, so the smallest step the controller could
 * take was about twice its own target window: it could only land inside tolerance by luck and
 * otherwise limit-cycled at the step size. That is the measured
 * -19.1 → -25.1 → -11.1 → +5.6 → -8.6 → -25.4 oscillation, and it is also why a move that
 * STARTED near its target converged fine — a near-target start is already inside one step.
 *
 * `sign` is the axis's learned direction mapping (see shouldFlipSign).
 */
export function computeCorrection(error, { toleranceDeg, speedDegPerSec, sign = 1 }) {
  if (Math.abs(error) <= toleranceDeg) return 0;
  const wanted = Math.abs(error) * PROPORTIONAL_GAIN;
  const magnitude = Math.min(speedDegPerSec, Math.max(MIN_EFFECTIVE_SPEED_DEG_PER_SEC, wanted));
  return Math.sign(error) * sign * magnitude;
}

/**
 * Whether an axis's learned direction mapping should be inverted.
 *
 * The commanded direction comes from an approximate Euler decomposition that does not hold at
 * every pose, so each axis learns its sign by watching whether its correction helped. The
 * subtlety that broke this: an OVERSHOOT also makes the error grow — but there the error has
 * changed SIGN, and `Math.sign(error)` in computeCorrection already reverses the command on its
 * own. Flipping the learned sign as well reverses it twice and drives hard the wrong way.
 *
 * Replaying the 2026-08-26 traces, the correct sign was -1 for the whole run: tick 2's flip
 * learned it, and tick 5's flip — an overshoot from -5.6 to +8.6, a sign change, not a wrong
 * mapping — destroyed it and commanded full speed outward, taking -8.6 out to -25.4.
 *
 * So: only a growing error on the SAME side of zero indicates a wrong mapping.
 */
export function shouldFlipSign(error, prevError, epsilonDeg = 0.5) {
  if (prevError === null || prevError === undefined) return false;
  if (Math.sign(error) !== Math.sign(prevError)) return false;
  return Math.abs(error) > Math.abs(prevError) + epsilonDeg;
}

/**
 * Whether this pose is the same measurement the loop already acted on.
 *
 * The gimbal re-sends its last orientation rather than staying quiet, so frames keep arriving
 * carrying a measurement that has not changed. Acting on each arrival issues 2-3 full
 * corrections against one real measurement, so each step travels 2-3x what the controller
 * intended — the overshoot, and the limit cycle the phone's scanner reports as
 * "Moving too fast".
 *
 * Compares the DERIVED pan/tilt, not the raw quaternion: q and -q encode the same rotation and
 * the device emits both, so raw-value comparison sees "new data" for a pose that is identical
 * once decoded. pan/tilt is also the actual control input. Bit-identical degrees are
 * unambiguous — real IMU noise never reproduces a float64 exactly.
 */
export function poseAlreadyActedOn(pose, actedOn) {
  if (!actedOn) return false;
  return pose.yaw === actedOn.yaw && pose.pitch === actedOn.pitch;
}
