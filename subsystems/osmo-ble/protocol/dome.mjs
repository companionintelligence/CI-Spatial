/**
 * Dome planning for a multi-station capture, and the verdict on whether the result can
 * actually be solved.
 *
 * Split out of backend.mjs for the same reason stall.mjs was: it is the part that can be
 * tested against measurements without a gimbal, a BLE stack or a phone, and it encodes two
 * numbers that were expensive to learn and are easy to quietly violate.
 *
 * ---- Why stations exist at all ----
 *
 * A dome swept from ONE tripod position is pure rotation. The optical centre never moves, so
 * there is no translational baseline anywhere in the capture and monocular structure-from-
 * motion has nothing to triangulate against. Measured on real COLMAP runs over this rig's own
 * frames:
 *
 *   single dome, rotating in place      3 / 17 images registered   DEGENERATE
 *   5 stations x a dome each           36 / 36 images registered   ready, 9,914 points
 *   continuous walkthrough             48 / 48 images registered   ready
 *
 * The parallax comes from the tripod MOVING BETWEEN stations, not from anything inside a
 * dome — this is ordinary multi-station photogrammetry, the same principle as registering
 * terrestrial laser scans from several setups. The 36/36 run used 5 stations spread over a
 * 6 x 4.4 m room as a rough ring plus a centre point; deliberately NOT collinear, because
 * stations on a line share one baseline direction and reintroduce a degeneracy of their own.
 *
 * That is why assessCapture() below refuses to call a one-station run a capture.
 *
 * ---- Why the reachable arc exists ----
 *
 * The OM6's pan cannot rotate through the front. Its reachable travel, measured on the real
 * unit, runs from roughly +82 degrees round through 180 to about -100 — so the arc is 178
 * degrees wide and the ~182 degrees spanning the front is a dead zone. Driving a move into
 * that stop does not error: the gimbal twitches against the limit and springs back while the
 * controller holds a speed command against it, which is the exact condition that cooked the
 * hardware on 2026-08-26 (see stall.mjs's foldProgress for the tick-level telemetry).
 *
 * So a plan that crosses the dead zone is a bug in the plan, not an operator error, and it is
 * cheaper to make unplannable than to detect at position 14 of 105.
 */

import { wrapDeg } from './stall.mjs';

/**
 * Ends of the reachable pan arc, in the gimbal's own degrees.
 *
 * The arc runs START -> 180 -> END (i.e. across the +/-180 seam, behind the operator), NOT the
 * short way through 0. Measured on the real OM6; treated as hard limits rather than soft
 * guidance because the failure mode past them is thermal, not a rejected command.
 */
export const PAN_ARC_START_DEG = 82;
export const PAN_ARC_END_DEG = -100;

/** Arc coordinates: the same two limits unwrapped onto a monotonic line through 180. */
const ARC_START = PAN_ARC_START_DEG;
const ARC_END = PAN_ARC_END_DEG + 360; // -100 -> 260

/** Total reachable pan travel, in degrees. 178, not 360 — the front is unreachable. */
export const PAN_ARC_SPAN_DEG = ARC_END - ARC_START;

/** Midpoint of the reachable arc (171 deg, i.e. just past straight-back). */
export const PAN_ARC_CENTER_DEG = wrapDeg((ARC_START + ARC_END) / 2);

/**
 * Default dome width. 150 degrees is what the 36/36 capture actually swept: wide enough that
 * consecutive stations share plenty of overlapping view, and 28 degrees clear of both
 * mechanical stops so a move that overshoots its tolerance still lands inside the arc.
 */
export const DEFAULT_PAN_SPAN_DEG = 150;

/**
 * Fewest completed stations that can produce a solvable capture.
 *
 * Two, not one, and this is a measurement rather than a preference: one dome registered 3 of
 * 17 images because it has no baseline at all. Two stations is the point at which parallax
 * exists; it is a floor, not a recommendation (the run that actually reconstructed used 5).
 */
export const MIN_STATIONS_FOR_PARALLAX = 2;

/**
 * Map a pan angle onto the arc's monotonic coordinate.
 *
 * Angles inside the arc land in [82, 260]; angles in the dead zone land above 260, which is
 * what makes the reachability test a single comparison instead of a two-interval case split
 * that has to reason about the seam.
 */
export function toArcDeg(panDeg) {
  const w = wrapDeg(panDeg);
  return w < ARC_START ? w + 360 : w;
}

/** Inverse of toArcDeg: back to the gimbal's own (-180, 180] degrees. */
export function fromArcDeg(arcDeg) {
  return wrapDeg(arcDeg);
}

/** Whether the gimbal can physically reach this pan angle. */
export function isPanReachable(panDeg) {
  return toArcDeg(panDeg) <= ARC_END + 1e-9;
}

/** Every pan in the list the gimbal cannot reach, with how far into the dead zone it sits. */
export function unreachablePans(pans) {
  return pans
    .filter((pan) => !isPanReachable(pan))
    .map((pan) => ({
      pan,
      // Distance to the nearer limit, so the message can say which way to move.
      intoDeadZoneDeg: Math.round(Math.min(toArcDeg(pan) - ARC_END, ARC_START + 360 - toArcDeg(pan)) * 10) / 10,
    }));
}

/**
 * Plan one dome's pan column angles, guaranteed inside the reachable arc.
 *
 * Takes a centre and a span rather than a from/to pair on purpose: from/to invites writing
 * -150..150, which reads as "a wide sweep" and is in fact a 300-degree request straight
 * through the dead zone. A centre and a width cannot express that — the span is clamped to
 * what exists, and the caller is told it was.
 *
 * `stepDeg` and `count` are alternative ways to say the same thing; `count` wins if both are
 * given. Returns the clamp as data (`clampedFrom`) rather than throwing, because a span a few
 * degrees too wide is a plan to trim, not a run to refuse.
 */
export function planDomePans({ centerDeg = PAN_ARC_CENTER_DEG, spanDeg = DEFAULT_PAN_SPAN_DEG, stepDeg = 15, count } = {}) {
  if (!isPanReachable(centerDeg)) {
    throw new Error(
      `dome centre pan ${centerDeg}° is in the gimbal's dead zone — the reachable arc is `
      + `${PAN_ARC_START_DEG}° through 180° to ${PAN_ARC_END_DEG}° (it cannot rotate through the front). `
      + `Centre the dome near ${PAN_ARC_CENTER_DEG}° (straight back) instead.`,
    );
  }
  const requestedSpan = Math.abs(Number(spanDeg) || 0);
  const centerArc = toArcDeg(centerDeg);

  // Clamp the ends independently, then re-derive the span, so an off-centre dome slides along
  // the arc instead of shrinking symmetrically around a centre it cannot keep.
  let lo = centerArc - requestedSpan / 2;
  let hi = centerArc + requestedSpan / 2;
  const clampedFrom = lo < ARC_START || hi > ARC_END ? requestedSpan : null;
  if (lo < ARC_START) { hi += ARC_START - lo; lo = ARC_START; }
  if (hi > ARC_END) { lo -= hi - ARC_END; hi = ARC_END; }
  lo = Math.max(lo, ARC_START);
  hi = Math.min(hi, ARC_END);

  const span = hi - lo;
  const n = count !== undefined
    ? Math.max(1, Math.trunc(count))
    : Math.max(1, Math.floor(span / Math.max(1, Math.abs(stepDeg))) + 1);
  const pans = Array.from({ length: n }, (_, i) => {
    const arc = n === 1 ? (lo + hi) / 2 : lo + (span * i) / (n - 1);
    return Math.round(fromArcDeg(arc) * 10) / 10;
  });

  return {
    pans,
    centerDeg: Math.round(fromArcDeg((lo + hi) / 2) * 10) / 10,
    spanDeg: Math.round(span * 10) / 10,
    stepDeg: n > 1 ? Math.round((span / (n - 1)) * 10) / 10 : 0,
    requestedSpanDeg: requestedSpan,
    clampedFrom,
    arc: { startDeg: PAN_ARC_START_DEG, endDeg: PAN_ARC_END_DEG, spanDeg: PAN_ARC_SPAN_DEG },
  };
}

/**
 * Verdict on a finished (or abandoned) run: is this a capture, or an empty directory that
 * happens to have exited zero?
 *
 * This function exists because the failure this pipeline keeps producing is a run that reports
 * "done" and reconstructs into nothing — 105 positions "converged" against a scanner that
 * emitted no keyframes, or a full dome from one spot that COLMAP registers 3 of 17 images
 * from. Both look like success at the point of exit. Every caller (CLI exit code, web UI
 * banner, NDJSON `done` event) reads its verdict from here rather than each deciding for
 * itself, so there is one definition of "earned".
 *
 * `stations` is the per-station summary the run accumulated: `{ station, label, positions,
 * converged }`. A station with zero converged positions is not counted — the gimbal was there
 * but never actually held a pose.
 */
export function assessCapture({ stationsPlanned = 1, stations = [], incompleteReason = null } = {}) {
  const usable = stations.filter((s) => s.converged > 0);
  const framesConverged = stations.reduce((n, s) => n + s.converged, 0);
  const framesAttempted = stations.reduce((n, s) => n + s.positions, 0);
  const complete = !incompleteReason && usable.length >= stationsPlanned;

  let reason = null;
  if (framesAttempted === 0) {
    reason = 'Nothing was captured — the run ended before its first position.';
  } else if (framesConverged === 0) {
    reason = `${framesAttempted} position(s) were attempted and none converged: the gimbal never `
      + 'held a commanded pose, so every frame is from an unknown direction. Check the gimbal is '
      + 'not jammed against a limit and re-run.';
  } else if (usable.length < MIN_STATIONS_FOR_PARALLAX) {
    reason = `Only ${usable.length} station captured. A dome swept from one spot is pure rotation — `
      + 'there is no translational baseline anywhere in it, and structure-from-motion registered '
      + '3 of 17 images on exactly this input. Move the tripod and sweep at least one more '
      + 'station (5 registered 36 of 36).';
  }

  return {
    complete,
    // The honest headline: usable means "this can be reconstructed", not "the process exited".
    usable: framesConverged > 0 && usable.length >= MIN_STATIONS_FOR_PARALLAX,
    stationsUsable: usable.length,
    stationsPlanned,
    framesAttempted,
    framesConverged,
    reason: reason ?? (complete ? null : incompleteReason),
    incompleteReason,
  };
}
