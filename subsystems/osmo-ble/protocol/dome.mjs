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
 * ---- Why the reachable arc exists, and why it is a VALUE rather than two constants ----
 *
 * The OM6's pan cannot rotate through the front. Its reachable travel is about 178 degrees
 * wide and the ~182 degrees spanning the front is a dead zone. Driving a move into that stop
 * does not error: the gimbal twitches against the limit and springs back while the controller
 * holds a speed command against it, which is the exact condition that cooked the hardware on
 * 2026-08-26 (see stall.mjs's foldProgress for the tick-level telemetry).
 *
 * The WIDTH of that arc is a property of the chassis. WHERE it falls in the reported yaw frame
 * is not — it is fixed to the tripod base, and the reported frame is not. Measured on
 * 2026-08-29, one gimbal, one session, two tripod positions a couple of metres apart:
 *
 *   position A   targets -174 / -144 / -114  reached -175.6 / -145.6 / -116.0   all converged
 *                (the arc ran +82 round through 180 to -100, the constants below)
 *
 *   the tripod was picked up, carried, and set down
 *
 *   position B   targets  96 / 126 / 156     reached   93.0 /  122.0 /  153.5   all converged
 *                targets -174 / -144 / -114  ALL reached 171.3 / 171.3 / 171.0  none converged
 *                probed directly: 171 -> 171.1 converged;
 *                                 178, -175, -150 all stalled at 171.0-171.1
 *
 * The mechanical stop moved from -100 to about +171 in the reported frame — 89 degrees — for
 * no reason other than the tripod being carried across a room. A plan built from the constants
 * drove straight into it, and every position after that reported the run-level wedge abort.
 *
 * So the arc is `{ startDeg, endDeg }` data that a caller can MEASURE (see createArcProbe) and
 * hand to the planner, with the constants below as the fallback for "nothing has been measured
 * yet" — never as an assumption a plan is entitled to make twice.
 *
 * A plan that crosses the dead zone is still a bug in the plan rather than an operator error,
 * and it is still cheaper to make unplannable than to detect at position 14 of 105.
 */

import { wrapDeg, STUCK_POSE_EPSILON_DEG, NO_PROGRESS_DEG } from './stall.mjs';

/**
 * Ends of the reachable pan arc as first measured, on 2026-08-26, from ONE tripod position.
 *
 * The arc runs START -> 180 -> END (i.e. across the +/-180 seam, behind the operator), NOT the
 * short way through 0. Treated as hard limits rather than soft guidance because the failure
 * mode past them is thermal, not a rejected command.
 *
 * These are the FALLBACK, not the truth: they describe the tripod position they were measured
 * from and nothing else (see the module comment for the 89-degree shift measured on
 * 2026-08-29). Anything that can measure the arc where the tripod is actually standing should
 * do that and pass the result instead.
 */
export const PAN_ARC_START_DEG = 82;
export const PAN_ARC_END_DEG = -100;

/**
 * Build an arc value from its two ends.
 *
 * `endArc` is the end unwrapped forward from the start onto a monotonic line, so every
 * reachability test is one comparison instead of a case split that has to reason about the
 * +/-180 seam. The arc always runs from `startDeg` in the direction of INCREASING pan to
 * `endDeg`; that direction is what a probe measures, so the two are the same convention.
 *
 * `source` is carried on the value on purpose: every consumer that prints an arc has to be able
 * to say whether it was measured here and now or inherited from a tripod position that no
 * longer exists. ADR 0005 rule 3 — a claim needs a measurement, and "which measurement" is part
 * of the claim.
 */
export function makeArc({ startDeg, endDeg, source = 'measured', measuredAt = null, note = null } = {}) {
  const start = wrapDeg(Number(startDeg));
  const end = wrapDeg(Number(endDeg));
  const endArc = end < start ? end + 360 : end;
  return {
    startDeg: Math.round(start * 10) / 10,
    endDeg: Math.round(end * 10) / 10,
    startArc: start,
    endArc,
    spanDeg: Math.round((endArc - start) * 10) / 10,
    centerDeg: Math.round(wrapDeg((start + endArc) / 2) * 10) / 10,
    source,
    measuredAt,
    note,
  };
}

/** The fallback arc: the 2026-08-26 constants, as a value. */
export const DEFAULT_PAN_ARC = makeArc({
  startDeg: PAN_ARC_START_DEG,
  endDeg: PAN_ARC_END_DEG,
  source: 'default',
  note: 'measured 2026-08-26 from one tripod position; the arc is base-relative, so this is a fallback, not a reading of where the tripod is now',
});

/** Total reachable pan travel, in degrees. 178, not 360 — the front is unreachable. */
export const PAN_ARC_SPAN_DEG = DEFAULT_PAN_ARC.spanDeg;

/** Midpoint of the fallback arc (171 deg, i.e. just past straight-back). */
export const PAN_ARC_CENTER_DEG = DEFAULT_PAN_ARC.centerDeg;

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
 * Coerce an arc argument, loudly.
 *
 * Every arc-aware function here takes the arc as a trailing optional parameter, which makes
 * `pans.map(toArcDeg)` a live trap: `map` passes the INDEX as the second argument, so the
 * planner would silently measure against `0` instead of an arc and call the dead zone
 * reachable. That is not a style problem — it is a plan that drives into a mechanical stop, the
 * one failure this module exists to prevent — so a non-arc second argument throws here rather
 * than being quietly ignored. (It threw exactly once, in this module's own test, which is how
 * the trap was found.)
 */
function asArc(arc) {
  if (arc === undefined || arc === null) return DEFAULT_PAN_ARC;
  if (typeof arc === 'object' && Number.isFinite(arc.startArc) && Number.isFinite(arc.endArc)) return arc;
  throw new TypeError(
    `expected a reachable-arc object (see makeArc), got ${JSON.stringify(arc)}. `
    + 'A common cause is a point-free `pans.map(toArcDeg)` — map passes the index as the second '
    + 'argument. Write `pans.map((p) => toArcDeg(p))`.',
  );
}

/**
 * Map a pan angle onto the arc's monotonic coordinate.
 *
 * Angles inside the default arc land in [82, 260]; angles in its dead zone land above 260,
 * which is what makes the reachability test a single comparison instead of a two-interval case
 * split that has to reason about the seam.
 */
export function toArcDeg(panDeg, arcIn = DEFAULT_PAN_ARC) {
  const arc = asArc(arcIn);
  const w = wrapDeg(panDeg);
  return w < arc.startArc ? w + 360 : w;
}

/** Inverse of toArcDeg: back to the gimbal's own (-180, 180] degrees. */
export function fromArcDeg(arcDeg) {
  return wrapDeg(arcDeg);
}

/** Whether the gimbal can physically reach this pan angle, per the arc given. */
export function isPanReachable(panDeg, arcIn = DEFAULT_PAN_ARC) {
  const arc = asArc(arcIn);
  return toArcDeg(panDeg, arc) <= arc.endArc + 1e-9;
}

/** Every pan in the list the gimbal cannot reach, with how far into the dead zone it sits. */
export function unreachablePans(pans, arcIn = DEFAULT_PAN_ARC) {
  const arc = asArc(arcIn);
  return pans
    .filter((pan) => !isPanReachable(pan, arc))
    .map((pan) => ({
      pan,
      // Distance to the nearer limit, so the message can say which way to move.
      intoDeadZoneDeg: Math.round(Math.min(
        toArcDeg(pan, arc) - arc.endArc,
        arc.startArc + 360 - toArcDeg(pan, arc),
      ) * 10) / 10,
    }));
}

/**
 * Human-readable arc, for the one sentence every refusal and every jam message needs.
 */
export function describeArc(arcIn = DEFAULT_PAN_ARC) {
  const arc = asArc(arcIn);
  const provenance = arc.source === 'measured'
    ? `measured from this tripod position${arc.measuredAt ? ` at ${new Date(arc.measuredAt).toISOString()}` : ''}`
    : 'the built-in fallback, NOT measured from this tripod position';
  return `${arc.startDeg}° round through 180° to ${arc.endDeg}° (${arc.spanDeg}° wide, ${provenance})`;
}

/**
 * Plan one dome's pan column angles, guaranteed inside the reachable arc.
 *
 * Takes a centre and a span rather than a from/to pair on purpose: from/to invites writing
 * -150..150, which reads as "a wide sweep" and is in fact a 300-degree request straight
 * through the dead zone. A centre and a width cannot express that — the span is clamped to
 * what exists, and the caller is told it was.
 *
 * `arc` is the reachable arc to plan inside; it defaults to the fallback constants, so a
 * caller that has measured nothing gets exactly the behaviour it got before arcs were values.
 * A caller that HAS measured the arc where the tripod is standing passes it, and the columns
 * move with the tripod instead of pointing at where the arc used to be.
 *
 * `stepDeg` and `count` are alternative ways to say the same thing; `count` wins if both are
 * given. Returns the clamp as data (`clampedFrom`) rather than throwing, because a span a few
 * degrees too wide is a plan to trim, not a run to refuse.
 */
export function planDomePans({ centerDeg, spanDeg = DEFAULT_PAN_SPAN_DEG, stepDeg = 15, count, arc: arcIn = DEFAULT_PAN_ARC } = {}) {
  const arc = asArc(arcIn);
  const center = centerDeg === undefined || centerDeg === null ? arc.centerDeg : centerDeg;
  if (!isPanReachable(center, arc)) {
    throw new Error(
      `dome centre pan ${center}° is in the gimbal's dead zone — the reachable arc is `
      + `${describeArc(arc)} (it cannot rotate through the front). `
      + `Centre the dome near ${arc.centerDeg}° instead.`,
    );
  }
  const requestedSpan = Math.abs(Number(spanDeg) || 0);
  const centerArc = toArcDeg(center, arc);

  // Clamp the ends independently, then re-derive the span, so an off-centre dome slides along
  // the arc instead of shrinking symmetrically around a centre it cannot keep.
  let lo = centerArc - requestedSpan / 2;
  let hi = centerArc + requestedSpan / 2;
  const clampedFrom = lo < arc.startArc || hi > arc.endArc ? requestedSpan : null;
  if (lo < arc.startArc) { hi += arc.startArc - lo; lo = arc.startArc; }
  if (hi > arc.endArc) { lo -= hi - arc.endArc; hi = arc.endArc; }
  lo = Math.max(lo, arc.startArc);
  hi = Math.min(hi, arc.endArc);

  const span = hi - lo;
  const n = count !== undefined
    ? Math.max(1, Math.trunc(count))
    : Math.max(1, Math.floor(span / Math.max(1, Math.abs(stepDeg))) + 1);
  const pans = Array.from({ length: n }, (_, i) => {
    const a = n === 1 ? (lo + hi) / 2 : lo + (span * i) / (n - 1);
    return Math.round(fromArcDeg(a) * 10) / 10;
  });

  return {
    pans,
    centerDeg: Math.round(fromArcDeg((lo + hi) / 2) * 10) / 10,
    spanDeg: Math.round(span * 10) / 10,
    stepDeg: n > 1 ? Math.round((span / (n - 1)) * 10) / 10 : 0,
    requestedSpanDeg: requestedSpan,
    clampedFrom,
    arc: { startDeg: arc.startDeg, endDeg: arc.endDeg, spanDeg: arc.spanDeg, source: arc.source, measuredAt: arc.measuredAt },
  };
}

/* ------------------------------------------------------------------------------------------
 * Measuring the arc where the tripod is actually standing.
 * ---------------------------------------------------------------------------------------- */

/**
 * How far each probe move reaches for.
 *
 * 35 degrees is a deliberate compromise between two costs that pull opposite ways. (It was 45
 * when this was first written, and the paragraph below is why it came down.)
 *
 * Bigger steps are cheaper — the arc is ~180 degrees wide, so crossing it takes ceil(180/step)
 * moves — but every probe step is issued as a wrapDeg-shortest-path move, and the controller
 * takes the SHORT way round. A step small enough that the short way is unambiguous can never be
 * sent the wrong way round through the dead zone, whatever the arc turns out to be; a step of
 * 90+ degrees can.
 *
 * 35 degrees is the size a step can actually FINISH in one budget at the measured travel rate
 * (~3.5 deg/s against a 10-second probe budget — see PROBE_MOVE_MAX_MS in backend.mjs for why
 * that budget is deliberately short). A step bigger than its budget is not wrong, just slower:
 * it gets re-issued from where it reached. It still crosses the whole arc in six.
 *
 * Accuracy does NOT depend on this. A step that runs into a stop reports the pose it jammed at,
 * which IS the stop — 2026-08-29, targets 178 / -175 / -150 all ended at 171.0-171.1; 2026-08-30,
 * two independent probes put the same stop at 169.5 and 169.6. The step size decides how many
 * moves the probe costs, not how well it measures.
 */
export const PROBE_STEP_DEG = 35;

/**
 * Steps in one direction before giving up on finding a stop that way.
 *
 * 7 x 35 = 245 degrees, comfortably more than the ~180-degree arc from any pose inside it. Seven
 * converged steps with no stop means the arc is not what this module thinks an arc is, and the
 * honest answer is to report that rather than to keep driving.
 */
export const PROBE_MAX_STEPS_PER_DIRECTION = 7;

/**
 * Hard ceiling on probe moves, re-issues included.
 *
 * A budget rather than a guideline because this is the one routine in the subsystem that drives
 * INTO a mechanical stop on purpose. Bounding it bounds the exposure. 18 covers the worst
 * legitimate shape — a couple of steps out to one stop, six back across the arc, a re-issue or
 * two, and a stop-confirming move at each end. The first successful live probe (2026-08-30,
 * 45-degree steps) took 7 moves and 85 seconds.
 */
export const PROBE_MAX_MOVES = 18;

/**
 * How far inside each measured stop the usable arc is pulled.
 *
 * The probe measures the contact point. A plan must not target the contact point: the move
 * tolerance is 5 degrees, so a column planned exactly on the stop can be "converged" while
 * resting against it, holding a speed command the whole time. 8 degrees clears that with room,
 * and still leaves 178 - 16 = 162 degrees of usable arc, which the 150-degree default dome fits
 * inside without clamping.
 */
export const PROBE_STOP_MARGIN_DEG = 8;

/** A measured span outside this range is not an arc; the probe reports it rather than using it. */
export const PROBE_MIN_PLAUSIBLE_SPAN_DEG = 90;
export const PROBE_MAX_PLAUSIBLE_SPAN_DEG = 200;

/**
 * A probe of the reachable arc, as a state machine over moves the caller performs.
 *
 * ---- Why measure at all, and why THIS much ----
 *
 * The arc is base-relative (module comment). The operator has just set the tripod down, which is
 * the one moment in a capture when a minute of gimbal time costs nothing: nobody is waiting on a
 * frame, and the alternative is a dome that jams at position 14 and takes the run with it.
 *
 * So the probe is sized to be worth waiting for and no larger. It measures BOTH stops, because
 * measuring one and deriving the other from the 178-degree span would put the far column of a
 * 150-degree dome on top of a limit that was never checked — which is precisely the failure this
 * exists to remove, reintroduced with a smaller error bar. It does NOT bisect, refine, or
 * repeat: a step that runs into a stop already reports the stop's pose to a tenth of a degree,
 * and every extra move is another second of motor time against a limit.
 *
 * Cost: 3-7 moves in practice (roughly 20-50 s), and {@link PROBE_MAX_MOVES} in the worst case.
 * From mid-arc that is two or three steps out to the first stop and four back across to the
 * second.
 *
 * ---- Safety ----
 *
 * Every step is a normal closed-loop move, so the caller's existing stall guard decides when a
 * step has hit a stop and the caller's `finally` stops the motors — the probe issues no commands
 * of its own and cannot leave a speed latched. What it adds is that it stops ASKING: a direction
 * is finished the moment a step jams, so the stop is touched once per end, not held against.
 *
 * A step is judged to have found a stop when the move did not converge AND either the move loop
 * reported it stalled, or a repeat of the same target ended at the same pose (within
 * STUCK_POSE_EPSILON_DEG — the same test createWedgeGuard uses on a run's moves, for the same
 * reason: one short move can be a slow move, two at the same pose is a wall).
 *
 * Usage:
 *
 *   const probe = createArcProbe({ startPan });
 *   for (let step; (step = probe.next()); ) {
 *     const move = await moveToClosedLoop({ yawDeg: step.target, ... });
 *     probe.observe({ converged: move.converged, finalPan: move.finalYaw, stalled: move.stalled });
 *   }
 *   const result = probe.result();
 */
export function createArcProbe({
  startPan,
  stepDeg = PROBE_STEP_DEG,
  maxMoves = PROBE_MAX_MOVES,
  maxStepsPerDirection = PROBE_MAX_STEPS_PER_DIRECTION,
  marginDeg = PROBE_STOP_MARGIN_DEG,
} = {}) {
  const step = Math.abs(Number(stepDeg)) || PROBE_STEP_DEG;
  /** Current best knowledge of where the gimbal is. Seeded from telemetry, then from each move. */
  let here = wrapDeg(Number(startPan) || 0);
  /** +1 = probing toward increasing pan, -1 = the other way. The + end is measured first. */
  let dir = 1;
  let stepsThisDir = 0;
  let attempt = 0;
  let moves = 0;
  let lastFailPose = null;
  let pending = null;
  /**
   * A target to aim at again rather than stepping on from, or null to take a fresh step.
   *
   * This is not an optimisation, it is the difference between a probe that works and one that
   * gives up half way. Measured on the first live run, 2026-08-30: the move loop travels about
   * 2-4 degrees per second, so a 45-degree step regularly runs out of its budget 10 degrees
   * short — three times in a row on the return leg. Stepping on from wherever a short move
   * landed makes every subsequent step start further behind; re-issuing the same target makes
   * the next attempt a SHORTER move that finishes the job. A short move that is still travelling
   * is a slow move, not a wall, and the two must not be confused: only a move that stops making
   * progress ends a leg.
   */
  let retryTarget = null;
  let stopPlus = null;
  let stopMinus = null;
  let abandoned = null;
  const trace = [];

  const finished = () => stopPlus !== null && stopMinus !== null;
  const setStop = (pose) => {
    if (dir > 0) stopPlus = pose; else stopMinus = pose;
    dir = -dir;
    stepsThisDir = 0;
    attempt = 0;
    lastFailPose = null;
    retryTarget = null;
  };

  return {
    /** The next probe move to perform, or null when the probe is over (finished or abandoned). */
    next() {
      if (abandoned || finished()) return null;
      if (moves >= maxMoves) {
        abandoned = `probe budget of ${maxMoves} moves spent without finding both stops`;
        return null;
      }
      const target = retryTarget ?? Math.round(wrapDeg(here + dir * step) * 10) / 10;
      pending = {
        target,
        direction: dir,
        attempt: attempt + 1,
        reissued: retryTarget !== null,
        from: Math.round(here * 10) / 10,
        fromPan: here,
        movesSoFar: moves,
      };
      return pending;
    },

    /**
     * Fold the outcome of the move `next()` asked for.
     *
     * `finalPan` may be null (a move that never saw telemetry) — that is not a stop, it is a
     * probe that cannot see, and it abandons rather than inventing a limit from a blind move.
     */
    observe({ converged, finalPan, stalled } = {}) {
      moves++;
      const target = pending?.target ?? null;
      const from = pending?.fromPan ?? null;
      pending = null;
      if (finalPan === null || finalPan === undefined || !Number.isFinite(finalPan)) {
        abandoned = 'a probe move returned no pose — with no telemetry there is nothing to measure the arc against';
        trace.push({ target, direction: dir, converged: false, finalPan: null, verdict: 'no-telemetry' });
        return;
      }
      const pose = wrapDeg(finalPan);
      here = pose;

      if (converged) {
        stepsThisDir++;
        attempt = 0;
        lastFailPose = null;
        retryTarget = null;
        trace.push({ target, direction: dir, converged: true, finalPan: Math.round(pose * 10) / 10, verdict: 'reachable' });
        if (stepsThisDir >= maxStepsPerDirection) {
          // Seven steps of travel with no stop (245 degrees at the default step size, more
          // than the arc is wide from anywhere inside it). Not a measurement — say so instead of
          // pretending the last pose was a limit.
          abandoned = `no stop found within ${maxStepsPerDirection} steps (${Math.round(maxStepsPerDirection * step)}°) going ${dir > 0 ? 'up' : 'down'} in pan`;
        }
        return;
      }

      const repeatedPose = lastFailPose !== null
        && Math.abs(wrapDeg(pose - lastFailPose)) < STUCK_POSE_EPSILON_DEG;
      if (stalled === true || repeatedPose) {
        trace.push({ target, direction: dir, converged: false, finalPan: Math.round(pose * 10) / 10, verdict: 'stop' });
        setStop(pose);
        return;
      }
      // Short of the target, and not against anything. Two different things look like this and
      // they get different answers.
      const travelled = from === null ? null : Math.abs(wrapDeg(pose - from));
      lastFailPose = pose;
      retryTarget = target;
      if (travelled !== null && travelled >= NO_PROGRESS_DEG) {
        // Still travelling — it simply ran out of budget. Aim at the same target again; it is a
        // shorter move from here. Not counted as a failed attempt, because nothing failed.
        attempt = 0;
        trace.push({ target, direction: dir, converged: false, finalPan: Math.round(pose * 10) / 10, travelledDeg: Math.round(travelled * 10) / 10, verdict: 'partial' });
        return;
      }
      attempt++;
      trace.push({ target, direction: dir, converged: false, finalPan: Math.round(pose * 10) / 10, travelledDeg: travelled === null ? null : Math.round(travelled * 10) / 10, verdict: 'short' });
      if (attempt >= 3) {
        abandoned = `a probe move toward ${target}° neither converged, jammed, nor travelled anywhere in 3 attempts (last pose ${Math.round(pose * 10) / 10}°)`;
      }
    },

    /**
     * What the probe measured.
     *
     * `ok: false` is a real outcome, not an error: the caller falls back to the constants and
     * says which arc it is using. An unmeasured arc reported as measured is the defect this
     * whole module is about.
     */
    result() {
      if (stopPlus === null || stopMinus === null) {
        return {
          ok: false,
          arc: null,
          moves,
          stops: { plusDeg: stopPlus, minusDeg: stopMinus },
          reason: abandoned ?? 'probe did not run to completion',
          trace,
        };
      }
      // Travelling from the - stop in the + direction is, by construction, the way the probe
      // came, so this is the reachable width and never the dead zone's.
      const spanDeg = Math.round((((stopPlus - stopMinus) % 360) + 360) % 360 * 10) / 10;
      if (spanDeg < PROBE_MIN_PLAUSIBLE_SPAN_DEG || spanDeg > PROBE_MAX_PLAUSIBLE_SPAN_DEG) {
        return {
          ok: false,
          arc: null,
          moves,
          stops: { plusDeg: Math.round(stopPlus * 10) / 10, minusDeg: Math.round(stopMinus * 10) / 10 },
          spanDeg,
          reason: `the two stops are ${spanDeg}° apart, outside the ${PROBE_MIN_PLAUSIBLE_SPAN_DEG}-${PROBE_MAX_PLAUSIBLE_SPAN_DEG}° a real pan arc has been measured at. `
            + 'Something other than a mechanical limit stopped a probe move; not using this as an arc.',
          trace,
        };
      }
      return {
        ok: true,
        moves,
        stops: { plusDeg: Math.round(stopPlus * 10) / 10, minusDeg: Math.round(stopMinus * 10) / 10 },
        spanDeg,
        marginDeg,
        arc: makeArc({
          startDeg: stopMinus + marginDeg,
          endDeg: stopPlus - marginDeg,
          source: 'measured',
          measuredAt: Date.now(),
          note: `stops measured at ${Math.round(stopMinus * 10) / 10}° and ${Math.round(stopPlus * 10) / 10}° (${spanDeg}° apart), inset ${marginDeg}° at each end`,
        }),
        trace,
      };
    },

    /** For a caller that wants to narrate progress. */
    get moves() { return moves; },
    get stops() { return { plusDeg: stopPlus, minusDeg: stopMinus }; },
  };
}

/**
 * Headroom the arc in use claims the gimbal still had, at the pose it actually stopped at.
 *
 * Positive means "the arc says there was more travel that way".
 *
 * `outside` is the case that has to be REPORTED rather than measured: the pose is in what the
 * arc in use calls the dead zone, so there is no headroom to state — the arc has already been
 * contradicted by the gimbal simply being there, which is a stronger disproof than any margin.
 *
 * Measuring it anyway is what this did before, and the numbers it produced were nonsense in the
 * one message written for a confused operator. Measured against the fallback arc (82 round to
 * -100, 178 degrees wide): a stop reported at pan -95 while heading for -100 printed "still had
 * 183 degrees of travel that way", and at pan 20 it printed 298 — both wider than the whole
 * arc. Worse, a pose just short of the arc's START came out NEGATIVE (pan 81 heading for -100
 * gave -181), which is below the interior margin, so the verdict flipped to "a mechanical stop
 * reached the ordinary way" and sent the operator to reset the gimbal and check the cradle —
 * the exact wrong remediation this function exists to stop giving. A shifted arc is precisely
 * the condition that puts a real pose outside the believed one, so this is not a corner.
 */
function headroomAheadDeg(panDeg, targetDeg, arc) {
  const pos = toArcDeg(panDeg, arc);
  if (pos > arc.endArc + 1e-9) return { outside: true, headroomDeg: 0 };
  const toStart = pos - arc.startArc;
  const toEnd = arc.endArc - pos;
  const heading = targetDeg === null || targetDeg === undefined ? 0 : Math.sign(wrapDeg(targetDeg - panDeg));
  const ahead = heading > 0 ? toEnd : heading < 0 ? toStart : Math.max(toStart, toEnd);
  return { outside: false, headroomDeg: Math.max(0, ahead) };
}

/**
 * Margin below which a jam at that pose is "against the stop the plan already knew about"
 * rather than "the arc moved". One dome column step (15 degrees) minus a tolerance's worth.
 */
export const JAM_INTERIOR_MARGIN_DEG = 12;

/**
 * Say what a jam MEANS, by comparing where the gimbal stopped against the arc it was planned
 * against.
 *
 * This exists because of what the operator was told before it did. The run-level message was
 * "Gimbal stopped moving — 3 consecutive positions ended at the same pose", followed by advice
 * to hardware-reset the gimbal and check the phone is balanced in the cradle. Every word of that
 * is about a mechanical fault. On 2026-08-29 there was no mechanical fault: the tripod had been
 * carried two metres, the arc had come with it, and the plan was driving at a pan the gimbal had
 * been able to reach twenty minutes earlier and could not reach now. The operator has no way to
 * guess that from the pose alone, and the remediation it was given — reset the gimbal, re-run —
 * reproduces the jam exactly.
 *
 * The test is simple and is the whole diagnosis: if the gimbal stopped dead somewhere the arc in
 * use says it still had travel — or somewhere it says the gimbal cannot even be — then the arc in
 * use is wrong, and the only thing that moves an arc is moving its base.
 *
 * Returns `{ shifted, message, ... }`; `message` is written for an operator standing at a
 * tripod, and names the one action that fixes it. `outsideArc` says which of the two disproofs
 * it is: a pose the arc puts in its own dead zone is not a headroom measurement at all, and
 * `headroomDeg` is 0 there rather than a distance to somewhere the gimbal is not.
 */
export function diagnoseJam({ panDeg, targetDeg = null, arc: arcIn = DEFAULT_PAN_ARC } = {}) {
  const arc = asArc(arcIn);
  if (panDeg === null || panDeg === undefined || !Number.isFinite(panDeg)) {
    return { shifted: false, headroomDeg: null, outsideArc: false, message: null };
  }
  const pan = Math.round(wrapDeg(panDeg) * 10) / 10;
  const reach = headroomAheadDeg(pan, targetDeg, arc);
  const headroom = Math.round(reach.headroomDeg * 10) / 10;
  // Either disproof is enough, and the dead-zone one is the stronger: a gimbal reporting a pose
  // the arc calls unreachable has already contradicted that arc, whatever the margin says.
  const shifted = reach.outside || headroom > JAM_INTERIOR_MARGIN_DEG;

  if (!shifted) {
    return {
      shifted: false,
      headroomDeg: headroom,
      outsideArc: false,
      impliedStopDeg: pan,
      arc: { startDeg: arc.startDeg, endDeg: arc.endDeg, spanDeg: arc.spanDeg, source: arc.source },
      message:
        `It stopped at pan ${pan}°, which is ${headroom}° from the end of the arc it was planned `
        + `against (${describeArc(arc)}) — i.e. against a limit the plan already knew about. `
        + 'That is a mechanical stop reached the ordinary way, so check the rig: the cradle '
        + 'balance, a cable or a strap fouling the yoke, or the gimbal needing a reset.',
    };
  }

  // Two ways the arc can be disproved, and they are not the same sentence. "It still had travel
  // that way" is a measurement; "it is not even on the arc" is not, and saying it as one printed
  // distances wider than the whole arc (see headroomAheadDeg).
  const observation = reach.outside
    ? `It stopped at pan ${pan}°, which is not on the arc it was planned against at all — that arc `
      + 'puts this pose in the dead zone, so the gimbal has just reported being somewhere the plan '
      + 'believed it could not go.'
    : `It stopped at pan ${pan}°, and the arc it was planned against says it still had ${headroom}° `
      + 'of travel that way.';

  return {
    shifted: true,
    headroomDeg: headroom,
    outsideArc: reach.outside,
    impliedStopDeg: pan,
    arc: { startDeg: arc.startDeg, endDeg: arc.endDeg, spanDeg: arc.spanDeg, source: arc.source },
    message:
      `${observation} So the gimbal is not broken — ITS REACHABLE ARC HAS MOVED. Pan swings `
      + `about ${PAN_ARC_SPAN_DEG}° and cannot rotate through the front, and where that arc falls is `
      + `fixed to the TRIPOD BASE, not to the reported angles: pick the tripod up, set it down `
      + `facing differently, and the same reported pan is now on the far side of a stop. Measured on `
      + `2026-08-29, one carry across a room moved the stop by 89°. The arc in use here is `
      + `${describeArc(arc)}; the real stop is at about ${pan}°. `
      + 'Re-measure the arc from where the tripod is standing now (POST /api/arc-probe — measured '
      + 'live at 7 moves and 85 seconds) and re-run — the plan is rebuilt against whatever it measures. Resetting the '
      + 'gimbal will not help, because nothing is wrong with the gimbal.',
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
