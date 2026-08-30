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
} from './dome.mjs';

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
  const arcs = plan.pans.map(toArcDeg);
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
