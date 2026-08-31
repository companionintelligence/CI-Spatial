/**
 * Dome planning and capture assessment, tested against the two measurements the module exists
 * to enforce: the OM6's reachable pan arc, and the COLMAP registration rates that decide
 * whether a run is a capture or an empty success.
 *
 * Neither is synthetic. The arc (+82 through 180 to -100) was measured on the real unit by
 * driving pan into both stops; the registration rates come from real COLMAP runs over this
 * rig's own frames — 3/17 from a single rotating dome, 36/36 from five stations.
 *
 * Run: npm run test:protocol
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAN_ARC_START_DEG,
  PAN_ARC_END_DEG,
  PAN_ARC_SPAN_DEG,
  PAN_ARC_CENTER_DEG,
  DEFAULT_PAN_SPAN_DEG,
  MIN_STATIONS_FOR_PARALLAX,
  toArcDeg,
  fromArcDeg,
  isPanReachable,
  unreachablePans,
  planDomePans,
  assessCapture,
  makeArc,
  DEFAULT_PAN_ARC,
  describeArc,
  createArcProbe,
  diagnoseJam,
  PROBE_STOP_MARGIN_DEG,
  PROBE_MAX_MOVES,
  JAM_INTERIOR_MARGIN_DEG,
} from './dome.mjs';

/**
 * A gimbal with a pan arc that is 178 degrees wide and falls WHEREVER `minusStop` says.
 *
 * The whole point of the fixture: the reported yaw frame and the mechanical stops are
 * independent, which is what the 2026-08-29 tripod carry demonstrated. Positions are tracked in
 * a linear coordinate from the - stop so a move can be clamped at a limit exactly the way the
 * hardware clamps it.
 *
 * `move(target)` reproduces the two outcomes a real move-to reports, and the distinction the
 * probe turns on: a move that travels a long way and then meets a stop reports `stalled: false`
 * (it closed plenty of distance, it just did not arrive), while a REPEAT of that move from the
 * stop travels nothing and reports `stalled: true`. Both were observed live —
 * target -174 from 153.5 ended at 171.3, and the next two targets ended at 171.3 and 171.0.
 */
function fakeGimbal({ minusStop, spanDeg = 178, pan = 0, toleranceDeg = 5, maxTravelPerMove = Infinity }) {
  const norm = (d) => ((d % 360) + 360) % 360;
  let here = norm(pan - minusStop);
  return {
    get pan() { return wrap(minusStop + here); },
    move(target) {
      const from = here;
      const want = wrap(target - wrap(minusStop + here));
      // `maxTravelPerMove` is the budget running out mid-move, which is the real behaviour and
      // not an edge case: measured 2026-08-30, the loop travels 2-4 deg/s, so a 45-degree step
      // routinely ends short of its target while still perfectly healthy.
      const delta = Math.sign(want) * Math.min(Math.abs(want), maxTravelPerMove);
      here = Math.min(spanDeg, Math.max(0, here + delta));
      const finalPan = wrap(minusStop + here);
      const converged = Math.abs(wrap(target - finalPan)) <= toleranceDeg;
      return { converged, finalPan, stalled: !converged && Math.abs(here - from) < 2 };
    },
  };
}

function wrap(d) {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

/** Drive a probe to completion against a fake gimbal; returns its result. */
function runProbe(gimbal, opts = {}) {
  const probe = createArcProbe({ startPan: gimbal.pan, ...opts });
  for (let step; (step = probe.next());) probe.observe(gimbal.move(step.target));
  return probe.result();
}

test('the reachable arc is the measured one: 178 degrees the long way round, not 360', () => {
  assert.equal(PAN_ARC_START_DEG, 82);
  assert.equal(PAN_ARC_END_DEG, -100);
  assert.equal(PAN_ARC_SPAN_DEG, 178);
  assert.equal(PAN_ARC_CENTER_DEG, 171);
});

test('reachability follows the arc across the seam, not the short way through zero', () => {
  for (const pan of [82, 90, 120, 150, 179.9, 180, -180, -150, -120, -100]) {
    assert.equal(isPanReachable(pan), true, `${pan}° should be reachable`);
  }
  // The dead zone is the ~182 degrees spanning the front, which the gimbal cannot rotate
  // through. 0 is dead centre of it.
  for (const pan of [81.9, 60, 30, 0, -30, -60, -99.9]) {
    assert.equal(isPanReachable(pan), false, `${pan}° is in the dead zone`);
  }
});

test('arc coordinates are monotonic across the +/-180 seam', () => {
  // The whole point of the arc coordinate: 179 -> -179 is a 2-degree step, not a 358-degree
  // leap, so a planner can space columns evenly without special-casing the seam.
  assert.equal(toArcDeg(179), 179);
  assert.equal(toArcDeg(-179), 181);
  assert.equal(toArcDeg(-100), 260);
  assert.equal(fromArcDeg(260), -100);
  assert.equal(fromArcDeg(181), -179);
});

test('the default dome sits wholly inside the arc, clear of both stops', () => {
  const plan = planDomePans();
  assert.equal(plan.spanDeg, DEFAULT_PAN_SPAN_DEG);
  assert.equal(plan.clampedFrom, null);
  assert.equal(unreachablePans(plan.pans).length, 0);
  // 14 degrees of margin at each end (178 arc - 150 span, split). A move that overshoots its
  // 5-degree tolerance still lands inside the arc rather than against a stop.
  // Not `plan.pans.map(toArcDeg)`: map passes the index as the second argument, which is now
  // the arc. asArc() throws on that rather than silently planning against index 0.
  const arcs = plan.pans.map((p) => toArcDeg(p));
  assert.ok(Math.min(...arcs) - PAN_ARC_START_DEG >= 13.9, 'margin at the +82 stop');
  assert.ok(260 - Math.max(...arcs) >= 13.9, 'margin at the -100 stop');
});

test('an over-wide span is clamped to the arc rather than crossing the dead zone', () => {
  // 300 degrees is roughly what a from/to pair of -150..150 asks for, and it does not exist.
  const plan = planDomePans({ spanDeg: 300, stepDeg: 15 });
  assert.equal(plan.requestedSpanDeg, 300);
  assert.equal(plan.clampedFrom, 300);
  assert.equal(plan.spanDeg, PAN_ARC_SPAN_DEG);
  assert.deepEqual(unreachablePans(plan.pans), []);
});

test('an off-centre dome slides along the arc instead of overhanging a stop', () => {
  // Centred 20 degrees from the +82 stop with a 150-degree span: half of it would hang off the
  // end. Sliding keeps the full requested width; shrinking symmetrically would silently halve
  // the coverage the operator asked for.
  const plan = planDomePans({ centerDeg: 102, spanDeg: 150, stepDeg: 15 });
  assert.equal(plan.spanDeg, 150);
  assert.deepEqual(unreachablePans(plan.pans), []);
  assert.equal(toArcDeg(plan.pans[0]), PAN_ARC_START_DEG);
});

test('a dome centred in the dead zone is refused, not silently relocated', () => {
  // Refusing beats relocating: a centre of 0 means the caller believes the front is reachable,
  // and quietly swinging the dome 171 degrees round the back would produce a capture of a
  // completely different part of the room than the one they asked for.
  assert.throws(() => planDomePans({ centerDeg: 0 }), /dead zone/);
  assert.throws(() => planDomePans({ centerDeg: -45 }), /reachable arc/);
});

test('no centre/span combination inside the arc can plan a target in the dead zone', () => {
  // Property sweep rather than a handful of cases: this is the invariant the whole module
  // exists for, and it is the one a later "just widen the span" edit would break.
  for (let center = PAN_ARC_START_DEG; center <= 260; center += 1) {
    for (const span of [10, 45, 90, 150, 178, 200, 360]) {
      const plan = planDomePans({ centerDeg: fromArcDeg(center), spanDeg: span, stepDeg: 10 });
      const bad = unreachablePans(plan.pans);
      assert.equal(bad.length, 0, `centre ${center} span ${span} planned into the dead zone: ${JSON.stringify(bad)}`);
    }
  }
});

test('the old -150..150 step-30 preset is 6 of 11 columns inside the stop', () => {
  // Kept as a regression fixture: this was the shipped "Dome" preset. It reads as a wide sweep
  // and is in fact a request to drive pan into its mechanical limit six times per tilt row —
  // the condition that overheats the unit.
  const oldPreset = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
  const bad = unreachablePans(oldPreset);
  assert.equal(bad.length, 6);
  assert.deepEqual(bad.map((b) => b.pan), [-90, -60, -30, 0, 30, 60]);
});

test('unreachablePans reports how far into the dead zone a target sits', () => {
  const [justPast] = unreachablePans([80]);
  assert.equal(justPast.intoDeadZoneDeg, 2); // 2 degrees short of the +82 stop
  const [middle] = unreachablePans([-9]);
  assert.equal(middle.intoDeadZoneDeg, 91); // the far side of the dead zone
});

test('a single station is never reported as a usable capture', () => {
  // The measurement this encodes: one dome, rotating in place, registered 3 of 17 images.
  const verdict = assessCapture({ stationsPlanned: 1, stations: [{ station: 1, positions: 21, converged: 21 }] });
  assert.equal(verdict.usable, false);
  assert.equal(verdict.stationsUsable, 1);
  assert.match(verdict.reason, /pure rotation/);
  assert.match(verdict.reason, /3 of 17/);
  assert.equal(MIN_STATIONS_FOR_PARALLAX, 2);
});

test('a run where nothing converged is loud, even though every position was visited', () => {
  const verdict = assessCapture({
    stationsPlanned: 2,
    stations: [{ station: 1, positions: 12, converged: 0 }, { station: 2, positions: 12, converged: 0 }],
  });
  assert.equal(verdict.usable, false);
  assert.equal(verdict.complete, false);
  assert.equal(verdict.framesAttempted, 24);
  assert.equal(verdict.framesConverged, 0);
  assert.match(verdict.reason, /none converged/);
});

test('a run that captured nothing at all says so rather than reporting an empty success', () => {
  const verdict = assessCapture({ stationsPlanned: 5, stations: [] });
  assert.equal(verdict.complete, false);
  assert.equal(verdict.usable, false);
  assert.match(verdict.reason, /Nothing was captured/);
});

test('the 5-station shape that reconstructed is complete and usable', () => {
  const stations = Array.from({ length: 5 }, (_, i) => ({ station: i + 1, positions: 12, converged: 12 }));
  const verdict = assessCapture({ stationsPlanned: 5, stations });
  assert.equal(verdict.complete, true);
  assert.equal(verdict.usable, true);
  assert.equal(verdict.framesConverged, 60);
  assert.equal(verdict.reason, null);
});

test('stopping after 3 of 5 stations is incomplete but still a usable capture', () => {
  // Requirement in its own right: a partial run must not be reported as a failure, because
  // three stations do have parallax. It must also not be reported as complete.
  const stations = Array.from({ length: 3 }, (_, i) => ({ station: i + 1, positions: 12, converged: 12 }));
  const verdict = assessCapture({
    stationsPlanned: 5,
    stations,
    incompleteReason: 'stopped by request after 3 station(s)',
  });
  assert.equal(verdict.complete, false);
  assert.equal(verdict.usable, true);
  assert.equal(verdict.stationsUsable, 3);
  assert.equal(verdict.reason, 'stopped by request after 3 station(s)');
});

test('a station the gimbal visited but never held a pose at does not count toward parallax', () => {
  const verdict = assessCapture({
    stationsPlanned: 2,
    stations: [{ station: 1, positions: 12, converged: 12 }, { station: 2, positions: 12, converged: 0 }],
  });
  assert.equal(verdict.stationsUsable, 1);
  assert.equal(verdict.usable, false);
  assert.match(verdict.reason, /Only 1 station captured/);
});

/* ---------------------------------------------------------------------------------------- *
 * The arc is base-relative: measured, not assumed.
 * ---------------------------------------------------------------------------------------- */

test('the fallback arc is still the 2026-08-26 constants, and says it is a fallback', () => {
  assert.equal(DEFAULT_PAN_ARC.startDeg, PAN_ARC_START_DEG);
  assert.equal(DEFAULT_PAN_ARC.endDeg, PAN_ARC_END_DEG);
  assert.equal(DEFAULT_PAN_ARC.spanDeg, 178);
  assert.equal(DEFAULT_PAN_ARC.source, 'default');
  // Every message that prints an arc has to disclose that the constants were not measured here.
  assert.match(describeArc(), /NOT measured from this tripod position/);
});

test('an arc measured at the other tripod position accepts what the constants refuse', () => {
  // 2026-08-29, position B: the stop was probed to 171 and the far end is 178 degrees back.
  const arc = makeArc({ startDeg: -7, endDeg: 171 });
  assert.equal(arc.spanDeg, 178);
  assert.equal(arc.centerDeg, 82);
  // Every target that actually converged that evening.
  for (const pan of [96, 126, 156, 171]) {
    assert.equal(isPanReachable(pan, arc), true, `${pan}° converged on the real gimbal`);
  }
  // Every target that stalled at 171 — reachable per the constants, not per the truth.
  for (const pan of [178, -175, -174, -150, -144, -114]) {
    assert.equal(isPanReachable(pan, DEFAULT_PAN_ARC), true, `${pan}° looks fine to the constants`);
    assert.equal(isPanReachable(pan, arc), false, `${pan}° stalled at the stop on the real gimbal`);
  }
});

test('a plan respects the measured arc, and the same plan against the constants would have jammed', () => {
  const arc = makeArc({ startDeg: -7, endDeg: 171 });
  const measured = planDomePans({ arc });
  assert.deepEqual(unreachablePans(measured.pans, arc), []);
  assert.equal(measured.arc.source, 'measured');
  // The default-arc plan is the one that was actually run, and six of its eleven columns are
  // past the stop that evening's probe found at 171.
  const assumed = planDomePans();
  assert.ok(unreachablePans(assumed.pans, arc).length >= 5, 'the constants plan into the real stop');
});

test('planning falls back to the constants when nothing has been measured', () => {
  assert.deepEqual(planDomePans().pans, planDomePans({ arc: DEFAULT_PAN_ARC }).pans);
  assert.equal(planDomePans().arc.source, 'default');
});

test('a point-free pans.map(toArcDeg) throws instead of planning against an index', () => {
  // map passes the index as the arc. Silently treating that as "no arc" is how a dead-zone
  // column gets called reachable, so it is a throw.
  assert.throws(() => [96, -174].map(toArcDeg), /point-free/);
});

/* ---------------------------------------------------------------------------------------- *
 * The probe.
 * ---------------------------------------------------------------------------------------- */

test('the probe finds the stops where they actually are, not where the constants say', () => {
  // The rig as it stood on 2026-08-29 after the carry: stops at -7 and 171.
  const gimbal = fakeGimbal({ minusStop: -7, pan: 112 });
  const result = runProbe(gimbal);
  assert.equal(result.ok, true);
  assert.equal(result.stops.plusDeg, 171);
  assert.equal(result.stops.minusDeg, -7);
  assert.equal(result.spanDeg, 178);
  // The usable arc is inset from the contact points, because a column planned ON a stop can
  // report "converged" while resting against it.
  assert.equal(result.arc.startDeg, -7 + PROBE_STOP_MARGIN_DEG);
  assert.equal(result.arc.endDeg, 171 - PROBE_STOP_MARGIN_DEG);
  assert.equal(result.arc.source, 'measured');
  // Cheap enough to be worth doing at every station. Live, with 45-degree steps, this shape
  // took 7 moves and 85 seconds on 2026-08-30; the steps are 35 degrees now (see
  // PROBE_STEP_DEG) so the move count is a little higher and each move is shorter.
  assert.ok(result.moves <= 12, `probe took ${result.moves} moves`);
  // And the default dome fits inside what it measured, without clamping.
  const plan = planDomePans({ arc: result.arc });
  assert.equal(plan.clampedFrom, null);
  assert.deepEqual(unreachablePans(plan.pans, result.arc), []);
});

test('the probe measures the same width wherever the arc happens to fall', () => {
  // The chassis does not change when the tripod moves; only the offset does. Sweeping the
  // offset all the way round is the property that says so.
  for (let minusStop = -180; minusStop < 180; minusStop += 17) {
    const gimbal = fakeGimbal({ minusStop, pan: wrap(minusStop + 90) });
    const result = runProbe(gimbal);
    assert.equal(result.ok, true, `no arc found with the - stop at ${minusStop}`);
    assert.equal(result.spanDeg, 178, `wrong span with the - stop at ${minusStop}`);
    assert.ok(Math.abs(wrap(result.stops.minusDeg - minusStop)) < 0.5, `wrong - stop at ${minusStop}`);
    assert.ok(result.moves <= PROBE_MAX_MOVES, `${result.moves} moves at ${minusStop}`);
  }
});

test('a probe that starts already against a stop still measures both ends', () => {
  const gimbal = fakeGimbal({ minusStop: -7, pan: 171 });
  const result = runProbe(gimbal);
  assert.equal(result.ok, true);
  assert.equal(result.stops.plusDeg, 171);
  assert.equal(result.stops.minusDeg, -7);
});

test('a probe that cannot see reports that, rather than inventing a limit', () => {
  // A move with no telemetry returns finalYaw: null. Treating that as a stop would write a
  // fabricated arc into the planner — the exact class of unearned claim this subsystem keeps
  // producing.
  const probe = createArcProbe({ startPan: 112 });
  probe.next();
  probe.observe({ converged: false, finalPan: null, stalled: false });
  assert.equal(probe.next(), null);
  const result = probe.result();
  assert.equal(result.ok, false);
  assert.equal(result.arc, null);
  assert.match(result.reason, /no pose/);
});

test('a probe is bounded, and an unbounded one reports failure instead of an arc', () => {
  // A gimbal with no stops at all: every step converges forever. The probe must stop asking.
  const endless = { pan: 0, move(target) { this.pan = wrap(target); return { converged: true, finalPan: this.pan, stalled: false }; } };
  const result = runProbe(endless);
  assert.equal(result.ok, false);
  assert.equal(result.arc, null);
  assert.ok(result.moves <= PROBE_MAX_MOVES);
  assert.match(result.reason, /no stop found/);
});

test('two stops too close together are not an arc, and are not used as one', () => {
  const gimbal = fakeGimbal({ minusStop: 40, spanDeg: 30, pan: 55 });
  const result = runProbe(gimbal);
  assert.equal(result.ok, false);
  assert.equal(result.arc, null);
  assert.equal(result.spanDeg, 30);
  assert.match(result.reason, /outside the 90-200/);
});

/* ---------------------------------------------------------------------------------------- *
 * Saying what a jam means.
 * ---------------------------------------------------------------------------------------- */

test('a jam where the arc claimed headroom is reported as the arc having moved', () => {
  // The measured failure: planned against the constants, driving from 153.5 toward -174, the
  // gimbal stopped dead at 171.3 — 89 degrees short of where the constants put the stop.
  const d = diagnoseJam({ panDeg: 171.3, targetDeg: -174, arc: DEFAULT_PAN_ARC });
  assert.equal(d.shifted, true);
  assert.equal(d.headroomDeg, 88.7);
  assert.equal(d.impliedStopDeg, 171.3);
  assert.match(d.message, /REACHABLE ARC HAS MOVED/);
  assert.match(d.message, /TRIPOD BASE/);
  assert.match(d.message, /arc-probe/);
  // And it must not send the operator after a mechanical fault, which is what the old message
  // did — hardware-reset the gimbal, check the cradle balance — none of which was wrong.
  assert.doesNotMatch(d.message, /balanced|hardware-reset/);
});

test('a jam at a limit the plan already knew about is not blamed on the tripod', () => {
  // Stopped 2 degrees short of the arc's own end (-100 is the end; -102 is just inside it): an
  // ordinary mechanical stop, and telling the operator their arc has shifted here would send
  // them to re-probe a rig that is genuinely fouled.
  const d = diagnoseJam({ panDeg: -102, targetDeg: -100, arc: DEFAULT_PAN_ARC });
  assert.equal(d.shifted, false);
  assert.ok(d.headroomDeg <= JAM_INTERIOR_MARGIN_DEG);
  assert.match(d.message, /limit the plan already knew about/);
});

test('the jam diagnosis reads the direction of travel, not just the pose', () => {
  // Same pose, opposite headings. Stopping at 90 while heading DOWN in pan is 8 degrees from
  // the +82 stop — arrived at a known limit; heading up, the same pose has 170 degrees of
  // claimed headroom and the stop should not be there at all.
  assert.equal(diagnoseJam({ panDeg: 90, targetDeg: 82, arc: DEFAULT_PAN_ARC }).shifted, false);
  assert.equal(diagnoseJam({ panDeg: 90, targetDeg: 156, arc: DEFAULT_PAN_ARC }).shifted, true);
});

test('a jam with no pose to compare says nothing rather than guessing', () => {
  assert.equal(diagnoseJam({ panDeg: null, targetDeg: 96 }).message, null);
});

test('a jam at a pose the arc calls unreachable is the arc being disproved, not a rig fault', () => {
  // The pose a SHIFTED arc actually produces: the gimbal reports being somewhere the arc in use
  // puts in its own dead zone. Measuring a headroom there is meaningless, and doing it printed
  // distances wider than the arc — 183 degrees at pan -95, 298 at pan 20, against an arc 178
  // degrees wide. Worst of all, a pose just short of the arc's START came out NEGATIVE (-181 at
  // pan 81), fell under the interior margin, and flipped the verdict to "a mechanical stop
  // reached the ordinary way" — sending the operator to reset a gimbal that was fine, which is
  // the one outcome this function exists to prevent.
  for (const pan of [-95, -20, 20, 60, 81]) {
    const d = diagnoseJam({ panDeg: pan, targetDeg: -100, arc: DEFAULT_PAN_ARC });
    assert.equal(d.shifted, true, `pan ${pan} should disprove the arc`);
    assert.equal(d.outsideArc, true, `pan ${pan} is in the arc's own dead zone`);
    assert.equal(d.headroomDeg, 0, `pan ${pan} has no headroom to state`);
    assert.match(d.message, /not on the arc it was planned against at all/);
    assert.match(d.message, /REACHABLE ARC HAS MOVED/);
    assert.doesNotMatch(d.message, /balanced|hardware-reset/);
  }
});

test('no jam message ever claims more travel than the arc is wide', () => {
  // The invariant behind the case above, stated as an invariant: a headroom is a distance along
  // the arc, so it cannot exceed the arc, and it cannot be negative.
  for (let pan = -180; pan <= 180; pan += 1) {
    for (const target of [-174, -100, 0, 82, 171]) {
      const d = diagnoseJam({ panDeg: pan, targetDeg: target, arc: DEFAULT_PAN_ARC });
      assert.ok(d.headroomDeg >= 0, `pan ${pan} -> ${target} gave ${d.headroomDeg}`);
      assert.ok(d.headroomDeg <= PAN_ARC_SPAN_DEG, `pan ${pan} -> ${target} gave ${d.headroomDeg}`);
    }
  }
});

test('a probe whose moves run out of budget still finds both stops', () => {
  // The defect the first live probe hit: with 45-degree steps and a move loop that travels a
  // few degrees a second, three steps in a row ended ~10 degrees short. Stepping on from where
  // each one landed made the next start further behind and the probe gave up with one stop
  // measured. Re-issuing the same target turns a short move into a shorter one that finishes.
  const gimbal = fakeGimbal({ minusStop: -7, pan: 112, maxTravelPerMove: 24 });
  const result = runProbe(gimbal);
  assert.equal(result.ok, true);
  assert.equal(result.stops.plusDeg, 171);
  assert.equal(result.stops.minusDeg, -7);
  assert.ok(result.moves <= PROBE_MAX_MOVES, `${result.moves} moves`);
  // Budget-limited moves are recorded as what they are — still travelling — never as a limit.
  assert.ok(result.trace.some((t) => t.verdict === 'partial'), 'short-but-travelling steps are traced as partial');
});

test('a gimbal that stops travelling without a stall flag is still read as a stop', () => {
  // The move loop only reports `stalled` once its own guard has probed both correction
  // directions, which a short budget can end before. Two moves ending at the same pose is the
  // same test createWedgeGuard applies to a run, and it is what actually found the + stop live:
  // target -173.3 ended at 169.7, target -145.3 ended at 169.5.
  const probe = createArcProbe({ startPan: 112 });
  probe.next();
  probe.observe({ converged: false, finalPan: 169.7, stalled: false });
  probe.next();
  probe.observe({ converged: false, finalPan: 169.5, stalled: false });
  assert.equal(probe.stops.plusDeg, 169.5);
});
