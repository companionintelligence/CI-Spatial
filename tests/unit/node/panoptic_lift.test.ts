/**
 * Panoptic segment -> 3D lift geometry and confidence policy.
 *
 * The pure half (src/shared/panoptic_lift.ts). Every cloud here is synthetic
 * and constructed so the right answer is known by arithmetic rather than by
 * eyeballing a scan — a lift test whose expected value came from running the
 * lift proves only that it is deterministic.
 *
 * The cases that matter most are the ones where the correct output is NO
 * output. `src/spatial/resolver.ts`'s min-perpendicular policy returned a
 * confident position for 50 of 50 thing segments on a scan whose own
 * session.json says 'needs-rescan'; the tests below pin the abstentions that
 * replaced that.
 *
 * Run: npm run test:panoptic:lift
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cameraRay,
  clusterByDepth,
  coneHalfAngle,
  gatherCone,
  liftConfidence,
  liftRemediation,
  liftSegment,
  MAX_CONE_HALF_ANGLE_RAD,
  MAX_DEPTH_M,
  MIN_CLUSTER_POINTS,
  MIN_CONFIDENCE,
  MIN_DEPTH_M,
  nearestConeHitDepth,
  type LiftCamera,
} from '../../../src/shared/panoptic_lift.ts'

/**
 * A camera at the origin looking down -Z, 720x960 with a 759 px focal length —
 * the real lens from sess-a7e2f642 (fovYDeg 64.577 over a 960 px frame gives
 * fl_y = 960 / (2·tan(64.577°/2)) = 759.0).
 */
const FL = 759
const CAM: LiftCamera = {
  cameraToWorld: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  flX: FL,
  flY: FL,
  cx: 360,
  cy: 480,
}
const CENTRE: [number, number] = [360, 480]

/**
 * A patch of surface at depth `z` in front of the camera, `n` points spread
 * over a `spanM` square, plus a little depth jitter so it is a surface rather
 * than a mathematical plane.
 */
function slab(z: number, n: number, spanM = 0.2, jitterM = 0.02): number[] {
  const out: number[] = []
  const side = Math.ceil(Math.sqrt(n))
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / Math.max(1, side - 1) - 0.5
    const gy = Math.floor(i / side) / Math.max(1, side - 1) - 0.5
    // Deterministic pseudo-jitter — a seeded pattern, not Math.random, so a
    // failure is reproducible.
    const j = ((i * 2654435761) % 1000) / 1000 - 0.5
    out.push(gx * spanM, gy * spanM, -(z + j * 2 * jitterM))
  }
  return out
}

const cloudOf = (...parts: number[][]) => {
  const flat = parts.flat()
  return { positions: new Float32Array(flat), count: flat.length / 3 }
}

// A 20000 px mask (a chair-sized segment in a 720x960 frame) — 5.99 degrees.
const AREA = 20_000

// ── ray construction ────────────────────────────────────────────────────────

test('the centre pixel casts straight down -Z', () => {
  const ray = cameraRay(CAM, 360, 480)
  assert.ok(ray)
  assert.deepEqual(ray.origin, { x: 0, y: 0, z: 0 })
  assert.ok(Math.abs(ray.direction.x) < 1e-12)
  assert.ok(Math.abs(ray.direction.y) < 1e-12)
  assert.equal(ray.direction.z, -1)
})

test('pixel y grows DOWN while world y grows UP', () => {
  // The worker reports centroidPx from numpy's ys.mean(), so row 0 is the top
  // of the image. Getting this sign wrong mirrors every object vertically
  // through the camera and is invisible in a room that is roughly symmetric.
  const below = cameraRay(CAM, 360, 480 + FL) // one focal length down-frame
  assert.ok(below)
  assert.ok(below.direction.y < 0, 'a pixel below centre must point downward in world space')
  const above = cameraRay(CAM, 360, 480 - FL)
  assert.ok(above)
  assert.ok(above.direction.y > 0)
  // 45 degrees off-axis at exactly one focal length.
  assert.ok(Math.abs(Math.abs(below.direction.y) - Math.SQRT1_2) < 1e-9)
})

test('a malformed or collapsed camera yields no ray at all', () => {
  assert.equal(cameraRay({ ...CAM, cameraToWorld: [] }, 360, 480), null)
  assert.equal(cameraRay({ ...CAM, flY: 0 }, 360, 480), null)
  assert.equal(cameraRay(CAM, Number.NaN, 480), null)
  const zeroed = { ...CAM, cameraToWorld: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]] }
  assert.equal(cameraRay(zeroed, 360, 480), null, 'a zero basis would make every direction NaN')
})

// ── the cone ────────────────────────────────────────────────────────────────

test('the cone comes from the mask area, not from a fixed radius', () => {
  // This is the whole difference from resolver.ts's 0.25 m cylinder: a bigger
  // mask subtends a bigger cone, and the cone widens with depth.
  const small = coneHalfAngle(2_000, FL)
  const large = coneHalfAngle(20_000, FL)
  assert.ok(large > small)
  // atan(sqrt(20000/pi)/759) = 6.001 degrees; atan(sqrt(2000/pi)/759) = 1.904.
  assert.ok(Math.abs((large * 180) / Math.PI - 6.001) < 0.01)
  assert.ok(Math.abs((small * 180) / Math.PI - 1.904) < 0.01)
})

test('a bbox narrows the cone for an elongated mask, and the area disc does not', () => {
  // Measured motivation: all three 'curtain' segments on sess-a7e2f642 are
  // about 95 x 435 px. The area disc gives a 92 px radius — twice the 46 px the
  // curtain is actually wide — so that cone was collecting depth from either
  // side of the curtain. 10 of that session's 50 thing segments have a bbox
  // aspect over 2.5.
  const areaPx = 95 * 435
  const disc = coneHalfAngle(areaPx, FL)
  const inscribed = coneHalfAngle(areaPx, FL, [0, 0, 94, 434])
  assert.ok(inscribed < disc)
  // min(w, h) / 2 = 47.5 px against sqrt(41325/pi) = 114.7 px.
  assert.ok(Math.abs(Math.atan(47.5 / FL) - inscribed) < 1e-9)
})

test('a compact mask is barely affected either way', () => {
  // The two measures agree for a roughly square segment (median ratio 0.90
  // across the 50 measured), so preferring the bbox costs nothing there.
  const side = 141 // ~20000 px, the chair-sized case
  const disc = coneHalfAngle(side * side, FL)
  const inscribed = coneHalfAngle(side * side, FL, [0, 0, side - 1, side - 1])
  assert.ok(Math.abs(inscribed / disc - 1) < 0.15)
})

test('a malformed bbox falls back to the area disc instead of collapsing the cone', () => {
  const areaPx = 20_000
  const disc = coneHalfAngle(areaPx, FL)
  for (const bad of [
    [0, 0, 0, 0],
    [Number.NaN, 0, 10, 10],
  ] as const) {
    // A zero-extent or non-finite box must not narrow the cone to nothing —
    // that would turn a data defect into a silent 'no-geometry'.
    const got = coneHalfAngle(areaPx, FL, bad as unknown as [number, number, number, number])
    assert.ok(got > 0, `bbox ${JSON.stringify(bad)} collapsed the cone`)
  }
  // A 1x1 box is degenerate but well-formed; it legitimately gives a tiny cone.
  assert.ok(coneHalfAngle(areaPx, FL, [5, 5, 5, 5]) < disc)
})

test('an enormous mask is clamped rather than sweeping the room', () => {
  // A third of a 720x960 frame implies a 19-degree cone, which at 5 m is a
  // 1.7 m-radius disc — a search, not a ray.
  assert.equal(coneHalfAngle(720 * 960 / 3, FL), MAX_CONE_HALF_ANGLE_RAD)
  assert.equal(coneHalfAngle(0, FL), 0)
})

test('the depth window excludes points nearer than MIN_DEPTH_M or past MAX_DEPTH_M', () => {
  const ray = cameraRay(CAM, ...CENTRE)!
  const cloud = cloudOf(slab(MIN_DEPTH_M - 0.1, 40), slab(MAX_DEPTH_M + 0.5, 40), slab(2.0, 40))
  const cone = gatherCone(ray, cloud.positions, cloud.count, coneHalfAngle(AREA, FL))
  assert.equal(cone.length, 40, 'only the in-window slab survives')
  for (const p of cone) assert.ok(p.depth >= MIN_DEPTH_M && p.depth <= MAX_DEPTH_M)
})

test('cone points come back ordered near to far', () => {
  const ray = cameraRay(CAM, ...CENTRE)!
  const cloud = cloudOf(slab(3.5, 30), slab(1.0, 30))
  const cone = gatherCone(ray, cloud.positions, cloud.count, coneHalfAngle(AREA, FL))
  for (let i = 1; i < cone.length; i++) assert.ok(cone[i].depth >= cone[i - 1].depth)
})

// ── clustering ──────────────────────────────────────────────────────────────

test('a depth gap splits one run into two surfaces', () => {
  const near = Array.from({ length: 5 }, (_, i) => ({ depth: 1.0 + i * 0.01, x: 0, y: 0, z: -1 }))
  const far = Array.from({ length: 5 }, (_, i) => ({ depth: 3.0 + i * 0.01, x: 0, y: 0, z: -3 }))
  const clusters = clusterByDepth([...near, ...far])
  assert.equal(clusters.length, 2)
  assert.ok(clusters[0].depth < clusters[1].depth, 'nearest cluster first')
  assert.ok(clusters[0].spread < 0.05)
})

// ── the three cases the brief names ─────────────────────────────────────────

test('a segment with a real surface behind it lifts cleanly', () => {
  // 40 points on a slab 2.0 m down -Z. The answer is arithmetic: the centroid
  // of a slab centred on the ray is on the ray at the slab's depth.
  const cloud = cloudOf(slab(2.0, 40))
  const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, cloud.positions, cloud.count)

  assert.ok(r.worldPos, `expected a position, got ${r.reason}`)
  assert.ok(Math.abs(r.worldPos.z + 2.0) < 0.05, `depth should be ~2.0 m, got ${r.worldPos.z}`)
  assert.ok(Math.abs(r.worldPos.x) < 0.05 && Math.abs(r.worldPos.y) < 0.05)
  assert.equal(r.reason, undefined)
  assert.ok(typeof r.confidence === 'number' && r.confidence > MIN_CONFIDENCE)
  assert.ok(r.confidence <= 1)
  assert.equal(r.debug.clusterPoints, 40)
})

test('an off-centre segment lifts to an off-axis position, not to the ray centre', () => {
  // Guards against a lift that quietly reports the cluster's depth along a
  // hard-coded forward axis. The mask is one focal length right of centre, so
  // the surface at 2 m must land at x ≈ +2 m.
  const at2m: number[] = []
  for (let i = 0; i < 40; i++) {
    const g = (i % 7) / 6 - 0.5
    const h = Math.floor(i / 7) / 5 - 0.5
    at2m.push(2.0 + g * 0.1, h * 0.1, -2.0)
  }
  const cloud = cloudOf(at2m)
  const r = liftSegment({ camera: CAM, centroidPx: [360 + FL, 480], areaPx: AREA, segScore: 0.9 }, cloud.positions, cloud.count)
  assert.ok(r.worldPos, `expected a position, got ${r.reason}`)
  assert.ok(Math.abs(r.worldPos.x - 2.0) < 0.1, `x should be ~2.0, got ${r.worldPos.x}`)
})

test('a segment with no usable depth says so instead of guessing', () => {
  const empty = { positions: new Float32Array(0), count: 0 }
  const none = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.95 }, empty.positions, empty.count)
  assert.equal(none.worldPos, null)
  assert.equal(none.confidence, null, 'no position means no confidence — never a default')
  assert.equal(none.reason, 'no-geometry')

  // Points present, but too few to be a surface. This is the common case on a
  // real sparse scan: 33 of sess-a7e2f642's 50 thing segments land here.
  const thin = cloudOf(slab(2.0, MIN_CLUSTER_POINTS - 1))
  const under = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.95 }, thin.positions, thin.count)
  assert.equal(under.worldPos, null)
  assert.equal(under.confidence, null)
  assert.equal(under.reason, 'unsupported')
  assert.equal(under.debug.conePoints, MIN_CLUSTER_POINTS - 1, 'the diagnostics still say what was seen')

  // A high segmenter score cannot buy a position. The model being certain the
  // pixels are a chair says nothing about where the chair is.
  assert.equal(
    liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 1.0 }, thin.positions, thin.count).worldPos,
    null,
  )
})

test('a centroid off its own mask abstains before any geometry is consulted', () => {
  // A U-shaped or split mask puts the mean of its pixel coordinates in the gap
  // between its parts, so the ray misses the object and finds whatever is
  // visible through the hole. Measured: 2 of 50 thing segments on
  // sess-a7e2f642, both 'bed'. The cloud below is a perfectly good surface —
  // the point is that a good surface at the wrong place is the failure.
  const cloud = cloudOf(slab(2.0, 40))
  const base = { camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.95 }

  const off = liftSegment({ ...base, centroidOnMask: false }, cloud.positions, cloud.count)
  assert.equal(off.worldPos, null)
  assert.equal(off.confidence, null)
  assert.equal(off.reason, 'centroid-off-mask')

  const on = liftSegment({ ...base, centroidOnMask: true }, cloud.positions, cloud.count)
  assert.ok(on.worldPos)

  // undefined means "the worker did not report it" — an older segments file
  // must still lift, not be rejected as though the check had failed.
  const unreported = liftSegment(base, cloud.positions, cloud.count)
  assert.ok(unreported.worldPos, 'an unreported flag must not be read as false')
  assert.deepEqual(unreported.worldPos, on.worldPos)
})

test('a smeared cluster is depth-ambiguous rather than averaged into a number', () => {
  // A ray grazing a wall along its length: every point within CLUSTER_GAP_M of
  // its neighbour, so it is one run, but spanning metres end to end. Its mean
  // depth describes nothing.
  const smear: number[] = []
  for (let i = 0; i < 40; i++) smear.push(0, 0, -(1.0 + i * 0.05))
  const cloud = cloudOf(smear)
  const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, cloud.positions, cloud.count)
  assert.equal(r.worldPos, null)
  assert.equal(r.reason, 'depth-ambiguous')
  assert.ok(r.debug.spreadM !== null && r.debug.spreadM > 0.35)
})

test('two supported surfaces more than a metre apart abstain instead of picking one', () => {
  // The failure the old policy hid: on sess-a7e2f642, min-perpendicular
  // silently resolved this shape the far way round in 12 of 28 comparable
  // segments (p90 disagreement 4.63 m).
  const cloud = cloudOf(slab(1.0, 30), slab(4.0, 30))
  const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, cloud.positions, cloud.count)
  assert.equal(r.worldPos, null)
  assert.equal(r.reason, 'multi-surface')
})

test('a thin far rival does not veto a well-supported near surface', () => {
  // The other half of the multi-surface rule: an occluder with real support in
  // front of scattered background is still an answer.
  const cloud = cloudOf(slab(1.0, 40), slab(4.0, 5))
  const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, cloud.positions, cloud.count)
  assert.ok(r.worldPos, `expected the near surface, got ${r.reason}`)
  assert.ok(Math.abs(r.worldPos.z + 1.0) < 0.05)
})

test('the nearest supported surface wins — the first thing the camera could see', () => {
  const cloud = cloudOf(slab(2.0, 40), slab(2.8, 60))
  const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, cloud.positions, cloud.count)
  assert.ok(r.worldPos, `expected a position, got ${r.reason}`)
  assert.ok(Math.abs(r.worldPos.z + 2.0) < 0.1, 'the denser far surface must not win on point count')
})

// ── the confidence boundary ─────────────────────────────────────────────────

test('confidence falls with distance, spread and thin support — each independently', () => {
  const baseArgs = { segScore: 0.9, clusterPoints: 30, conePoints: 30, spreadM: 0.02, depthM: 1.0 }
  const best = liftConfidence(baseArgs)
  assert.ok(liftConfidence({ ...baseArgs, depthM: 4.5 }) < best, 'range')
  assert.ok(liftConfidence({ ...baseArgs, spreadM: 0.3 }) < best, 'spread')
  assert.ok(liftConfidence({ ...baseArgs, clusterPoints: 12 }) < best, 'support')
  assert.ok(liftConfidence({ ...baseArgs, conePoints: 100 }) < best, 'cone fraction')
  assert.ok(liftConfidence({ ...baseArgs, segScore: 0.3 }) < best, 'segmenter score')
  assert.ok(best > 0 && best <= 1)
})

test('confidence stays inside 0..1 for degenerate inputs', () => {
  for (const args of [
    { segScore: 5, clusterPoints: 1e6, conePoints: 1, spreadM: -1, depthM: -10 },
    { segScore: -1, clusterPoints: 0, conePoints: 0, spreadM: 10, depthM: 1e9 },
    { segScore: Number.NaN, clusterPoints: 10, conePoints: 10, spreadM: 0.1, depthM: 1 },
  ]) {
    const c = liftConfidence(args)
    assert.ok(Number.isFinite(c) && c >= 0 && c <= 1, `got ${c} for ${JSON.stringify(args)}`)
  }
})

test('MIN_CONFIDENCE is the boundary, and it is a real boundary in both directions', () => {
  // Same geometry, same cloud; only the segmenter's own score moves. The
  // confidence factors are all multiplicative, so segScore scales the product
  // linearly — which makes it the clean way to walk the threshold.
  const cloud = cloudOf(slab(2.0, 40))
  const at = (segScore: number) =>
    liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore }, cloud.positions, cloud.count)

  const strong = at(0.95)
  assert.ok(strong.worldPos && strong.confidence! >= MIN_CONFIDENCE)

  // Scale the score so the product lands just under the floor.
  const ratio = MIN_CONFIDENCE / strong.confidence!
  const under = at(0.95 * ratio * 0.9)
  assert.equal(under.worldPos, null, 'below the floor there is no position')
  assert.equal(under.confidence, null)
  assert.equal(under.reason, 'low-confidence')
  // The number is still recorded, because "rejected at 0.19" and "rejected at
  // 0.02" are different facts and the sidecar has to be able to say which.
  assert.ok(under.debug.rawConfidence !== null && under.debug.rawConfidence < MIN_CONFIDENCE)

  const over = at(0.95 * ratio * 1.1)
  assert.ok(over.worldPos, 'just above the floor there is')
  assert.ok(over.confidence! >= MIN_CONFIDENCE)
})

test('a position and a confidence are always present or absent together', () => {
  // The invariant the whole module exists to hold: no position without a
  // confidence, no confidence without a position, and a reason exactly when
  // there is neither.
  const clouds = [
    cloudOf(),
    cloudOf(slab(2.0, 40)),
    cloudOf(slab(2.0, 3)),
    cloudOf(slab(1.0, 30), slab(4.0, 30)),
  ]
  for (const cloud of clouds) {
    for (const segScore of [0.01, 0.5, 0.99]) {
      const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore }, cloud.positions, cloud.count)
      assert.equal(r.worldPos === null, r.confidence === null)
      assert.equal(r.worldPos === null, r.reason !== undefined)
      if (r.worldPos) {
        for (const v of [r.worldPos.x, r.worldPos.y, r.worldPos.z]) assert.ok(Number.isFinite(v))
      }
    }
  }
})

// ── the non-negotiable: a no-parallax dome must not invent depth ────────────

test('a gimbal dome over an empty cloud produces no positions at all', () => {
  // A dome capture rotates in place: every ray shares an origin, so there is no
  // baseline and no parallax anywhere in the capture. Sweeping the full yaw
  // range must yield 100% abstention rather than a plausible-looking room.
  let positions = 0
  for (let deg = 0; deg < 360; deg += 15) {
    const a = (deg * Math.PI) / 180
    const cam: LiftCamera = {
      ...CAM,
      cameraToWorld: [
        [Math.cos(a), 0, Math.sin(a), 0],
        [0, 1, 0, 1.5],
        [-Math.sin(a), 0, Math.cos(a), 0],
        [0, 0, 0, 1],
      ],
    }
    const r = liftSegment(
      { camera: cam, centroidPx: CENTRE, areaPx: AREA, segScore: 0.99 },
      new Float32Array(0),
      0,
    )
    if (r.worldPos) positions++
    assert.equal(r.reason, 'no-geometry')
  }
  assert.equal(positions, 0)
})

test('a dome with geometry still lifts, and lifts to the same place from every angle', () => {
  // The complement: abstention must come from missing evidence, not from
  // rotation. A ring of cameras around one object all see it in the same spot.
  const target = { x: 0, y: 1.5, z: -2.0 }
  const cloud: number[] = []
  for (let i = 0; i < 60; i++) {
    const j = ((i * 2654435761) % 1000) / 1000 - 0.5
    cloud.push(
      target.x + (((i % 8) / 7) - 0.5) * 0.15,
      target.y + ((Math.floor(i / 8) / 7) - 0.5) * 0.15,
      target.z + j * 0.03,
    )
  }
  const positions = new Float32Array(cloud)
  const seen: number[] = []
  for (const deg of [-10, -5, 0, 5, 10]) {
    const a = (deg * Math.PI) / 180
    const cam: LiftCamera = {
      ...CAM,
      cameraToWorld: [
        [Math.cos(a), 0, Math.sin(a), 0],
        [0, 1, 0, 1.5],
        [-Math.sin(a), 0, Math.cos(a), 0],
        [0, 0, 0, 1],
      ],
    }
    // Aim the segment centroid back at the target for this camera angle.
    // Rᵀ·(0,0,-1) = (sin a, 0, -cos a), so the target's normalised x is tan(a).
    const px = 360 + Math.tan(a) * FL
    const r = liftSegment({ camera: cam, centroidPx: [px, 480], areaPx: AREA, segScore: 0.9 }, positions, cloud.length / 3)
    assert.ok(r.worldPos, `${deg} deg: expected a position, got ${r.reason}`)
    seen.push(Math.hypot(r.worldPos.x - target.x, r.worldPos.y - target.y, r.worldPos.z - target.z))
  }
  // Well inside THING_MATCH_RADIUS_M (0.75 m), so these fuse to ONE Thing.
  for (const d of seen) assert.ok(d < 0.1, `every view must agree to within 0.1 m, got ${d}`)
})

// ── an empty window is not an empty cloud ───────────────────────────────────

test('geometry outside the depth window is out-of-range, not no-geometry', () => {
  // The distinction that cost an evening. Measured on
  // sess-video-20260830-033839 (COLMAP, 32 registered images, 9362 points) with
  // the solver's own poses: 23 of 29 thing segments reported 'no-geometry',
  // which reads as "too sparse to hit anything". Those same 23 cones held 1 to
  // 605 points each (median 109) at 3.6-18.1 along the ray. The cloud was
  // dense; it was in the solver's arbitrary unit, so a metre window rejected
  // every point. Both states must be nameable, or the manifest sends the
  // reader after the wrong fix.
  const beyond = cloudOf(slab(MAX_DEPTH_M + 3.0, 60))
  const far = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, beyond.positions, beyond.count)
  assert.equal(far.worldPos, null)
  assert.equal(far.confidence, null)
  assert.equal(far.reason, 'out-of-range')
  assert.equal(far.debug.conePoints, 0, 'the WINDOWED cone really is empty — that is the point')
  assert.ok(far.debug.nearestDepthM !== null)
  assert.ok(
    Math.abs(far.debug.nearestDepthM - (MAX_DEPTH_M + 3.0)) < 0.1,
    `nearestDepthM should name where the geometry actually is, got ${far.debug.nearestDepthM}`,
  )

  // Nearer than MIN_DEPTH_M is the same failure from the other side.
  const near = cloudOf(slab(MIN_DEPTH_M / 2, 60, 0.05))
  const close = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, near.positions, near.count)
  assert.equal(close.reason, 'out-of-range')

  // A genuinely empty cloud keeps the old reason, and reports no depth at all —
  // there is no "where it actually is" to report.
  const none = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, new Float32Array(0), 0)
  assert.equal(none.reason, 'no-geometry')
  assert.equal(none.debug.nearestDepthM, null)

  // Geometry that is in front but OUTSIDE the cone is also no-geometry: the
  // probe must not widen the cone, only drop the window.
  const beside = cloudOf(slab(3.0, 60, 0.05).map((v, i) => (i % 3 === 0 ? v + 5.0 : v)))
  const aside = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.9 }, beside.positions, beside.count)
  assert.equal(aside.reason, 'no-geometry')
  assert.equal(aside.debug.nearestDepthM, null)
})

test('a successful lift never carries a nearestDepthM — the window was not the constraint', () => {
  const cloud = cloudOf(slab(2.0, 40))
  const r = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.95 }, cloud.positions, cloud.count)
  assert.ok(r.worldPos)
  assert.equal(r.debug.nearestDepthM, null)

  // Nor does an 'unsupported' one: points WERE inside the window, so the probe
  // is not run and would answer a question nobody asked.
  const thin = cloudOf(slab(2.0, MIN_CLUSTER_POINTS - 1))
  const under = liftSegment({ camera: CAM, centroidPx: CENTRE, areaPx: AREA, segScore: 0.95 }, thin.positions, thin.count)
  assert.equal(under.reason, 'unsupported')
  assert.equal(under.debug.nearestDepthM, null)
})

test('the probe ignores the window but not the cone, and never looks behind the camera', () => {
  const ray = cameraRay(CAM, 360, 480)
  assert.ok(ray)
  // Behind the camera along +Z. A dot product would make this a NEGATIVE depth;
  // returning it would put an object behind the viewer.
  const behind = cloudOf(slab(2.0, 40).map((v, i) => (i % 3 === 2 ? -v : v)))
  assert.equal(nearestConeHitDepth(ray, behind.positions, behind.count, coneHalfAngle(AREA, FL)), null)

  // Two surfaces beyond the window: the NEAREST is the informative one.
  const two = cloudOf(slab(9.0, 40, 0.05), slab(6.0, 40, 0.05))
  const d = nearestConeHitDepth(ray, two.positions, two.count, coneHalfAngle(AREA, FL))
  assert.ok(d !== null && Math.abs(d - 6.0) < 0.1, `expected ~6.0, got ${d}`)
})

// ── a run that placed nothing must say what to do about it ──────────────────

test('the dominant abstention picks the remediation, and only when nothing placed', () => {
  // Measured: both video-ingest sessions on disk write keyframes.jsonl records
  // of {index, file, timestamp} and nothing else — 0 of 32 and 0 of 48 frames
  // carry a pose. A session that ALSO has SfM poses needs a different sentence
  // from one that has none, because "there are poses, they are the wrong kind"
  // is a different instruction to an operator.
  const withSolved = liftRemediation({ 'no-pose': 29 }, { hasSolvedPoses: true })
  const withoutSolved = liftRemediation({ 'no-pose': 29 }, { hasSolvedPoses: false })
  assert.ok(withSolved && withoutSolved && withSolved !== withoutSolved)
  assert.match(withSolved, /scale|metric/i)

  // The units case must not read like a coverage case, or it sends the reader
  // off to re-scan a room that was scanned perfectly well.
  const range = liftRemediation({ 'out-of-range': 23, unsupported: 6 }, { hasSolvedPoses: true })
  assert.ok(range)
  assert.match(range, /metre/i)
  assert.notEqual(range, liftRemediation({ 'no-geometry': 23 }, { hasSolvedPoses: false }))

  // Ties and unknown reasons must not fabricate advice.
  assert.equal(liftRemediation({}, { hasSolvedPoses: false }), undefined)
  assert.equal(liftRemediation({ 'degenerate-camera': 4 }, { hasSolvedPoses: false }), undefined)
})

test('MAX_DEPTH_M matches the resolver bound it was lifted from', () => {
  // src/spatial/resolver.ts's MAX_HIT_DISTANCE_M and raycastPointCloud's
  // maxDepth are both 5.0. If one moves, this stage's idea of a believable
  // distance must move with it, or the two disagree about the same room.
  assert.equal(MAX_DEPTH_M, 5.0)
  assert.equal(MIN_DEPTH_M, 0.5)
})
