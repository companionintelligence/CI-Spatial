import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  ACCURACY_FLOOR_M,
  ASSUMED_ACCURACY_M,
  clusterScansByProximity,
  combinedAccuracyM,
  distanceM,
  effectiveAccuracyM,
  enuToGeo,
  type GeoLocatedScan,
  geoToEnu,
  scansNear,
  standardNormalCdf,
  withinRadiusConfidence,
} from '../../../server/gis/place_index.ts'
import type { GeoPose, ScanManifest } from '../../../src/world/types.ts'

/**
 * The ADR 0001 claim, checked by the type-checker rather than by a comment:
 * `ScanManifest` satisfies `GeoLocatedScan` structurally, so this module needs
 * no adapter, no wrapper and no second scan type. `deno check` fails here if
 * `ScanManifest` ever loses `scanId` or `geoPose`.
 */
const _scanManifestIsGeoLocated: (m: ScanManifest) => GeoLocatedScan = (m) => m

/**
 * Metres per degree of latitude on the sphere `src/world/geo.ts` uses
 * (WGS-84 equatorial radius): 6378137 × π/180. Written out rather than derived
 * from the module under test so fixtures are built independently of it.
 */
const M_PER_DEG_LAT = 111319.49079327358

function pose(lat: number, lng: number, accuracyM: number | null = 5, extra: Partial<GeoPose> = {}): GeoPose {
  return { lat, lng, altitudeM: null, bearing: null, accuracyM, ...extra }
}

/** A pose `northM`/`eastM` metres from `base`, computed without the module under test. */
function offsetPose(base: GeoPose, northM: number, eastM: number, accuracyM: number | null = 5): GeoPose {
  const lat = base.lat! + northM / M_PER_DEG_LAT
  const lng = base.lng! + eastM / (M_PER_DEG_LAT * Math.cos(base.lat! * Math.PI / 180))
  return pose(lat, lng, accuracyM)
}

function scan(scanId: string, geoPose: GeoPose): GeoLocatedScan {
  return { scanId, geoPose }
}

const NO_FIX: GeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const SF = pose(37.7749, -122.4194)

// ---------------------------------------------------------------------------
// The earth model. These pin the accuracy table in place_index.ts's module doc.
// Reference distances are from an independent Vincenty inverse solution on the
// WGS-84 ellipsoid (a ~1e-12-convergent implementation, not this repo's math),
// so they are ground truth for these coordinates rather than restatements of
// what the code already computes.
// ---------------------------------------------------------------------------

Deno.test('distanceM: pure north-south separation matches the sphere exactly', () => {
  // 0.001° of latitude is R·Δφ by construction — no projection error at all in
  // the north component, so this is an exact check of the model, not a tolerance.
  // (Latitude 0 with longitude 0 cannot be used as the origin: hasGeoPose reads
  // a literal 0,0 as "no fix", which the null-fix test below asserts directly.)
  const d = distanceM(pose(37.7749, -122.4194), pose(37.7759, -122.4194))
  assert(d !== null)
  assertAlmostEquals(d, 111.3195, 1e-3)
})

Deno.test('distanceM: agrees with a WGS-84 geodesic to ~0.3% at scan and city scale', () => {
  const cases: Array<
    { label: string; a: GeoPose; b: GeoPose; vincentyM: number; maxRelError: number; maxAbsErrorM: number }
  > = [
    // ~10 m apart — the scale at which two scans of one room differ. The model
    // error here is centimetres, against a GPS accuracy of metres: that ratio is
    // the whole justification for not adding a second (haversine) earth model.
    { label: '10 m', a: SF, b: pose(37.77499, -122.4194), vincentyM: 9.9893, maxRelError: 0.004, maxAbsErrorM: 0.1 },
    // ~1 km — "another building on the same block".
    { label: '1 km', a: SF, b: pose(37.7839, -122.4194), vincentyM: 998.9308, maxRelError: 0.004, maxAbsErrorM: 5 },
    // ~8.3 km — across a city. Statue of Liberty to Empire State Building.
    {
      label: '8.3 km',
      a: pose(40.689247, -74.044502),
      b: pose(40.748817, -73.985428),
      vincentyM: 8286.9091,
      maxRelError: 0.002,
      maxAbsErrorM: 20,
    },
  ]

  for (const { label, a, b, vincentyM, maxRelError, maxAbsErrorM } of cases) {
    const d = distanceM(a, b)
    assert(d !== null, `${label}: expected a distance`)
    const absError = Math.abs(d - vincentyM)
    const relError = absError / vincentyM
    assert(
      relError <= maxRelError,
      `${label}: distanceM=${d.toFixed(4)} vs Vincenty=${vincentyM} is ${(relError * 100).toFixed(3)}% off`,
    )
    assert(absError <= maxAbsErrorM, `${label}: absolute error ${absError.toFixed(3)} m exceeds ${maxAbsErrorM} m`)
  }
})

Deno.test('distanceM: the equirectangular model is wrong at continental range', () => {
  // Documented limitation, asserted so nobody reuses this layer for it. New York
  // to London: Vincenty says 5,585,234 m; the flat model says ~5,826,803 m.
  const d = distanceM(pose(40.7128, -74.0060), pose(51.5074, -0.1278))
  assert(d !== null)
  const relError = (d - 5585233.5789) / 5585233.5789
  assert(relError > 0.04, `expected >4% overestimate at continental range, got ${(relError * 100).toFixed(2)}%`)
})

Deno.test('distanceM: null when either side lacks a fix', () => {
  assertEquals(distanceM(SF, NO_FIX), null)
  assertEquals(distanceM(NO_FIX, SF), null)
  assertEquals(distanceM(NO_FIX, NO_FIX), null)
  // hasGeoPose treats a literal 0,0 as "no fix" — a null island reading is a
  // missing fix, never a position in the Gulf of Guinea.
  assertEquals(distanceM(SF, pose(0, 0)), null)
})

// ---------------------------------------------------------------------------
// ENU: the bridge between GPS and the project's Y-up metric space. LocalFrame
// declares { x: 'east', y: 'up', z: 'north' } and this must match it exactly.
// ---------------------------------------------------------------------------

Deno.test('geoToEnu: x is east, y is up, z is north (LocalFrame ENU_Y_UP)', () => {
  const origin = pose(37.7749, -122.4194, 5, { altitudeM: 10 })

  const north = geoToEnu(origin, offsetPose(origin, 100, 0))
  assertAlmostEquals(north.z, 100, 1e-6)
  assertAlmostEquals(north.x, 0, 1e-9)

  const east = geoToEnu(origin, offsetPose(origin, 0, 100))
  assertAlmostEquals(east.x, 100, 1e-6)
  assertAlmostEquals(east.z, 0, 1e-9)

  // Sign conventions, not just magnitudes: south is −z, west is −x.
  assert(geoToEnu(origin, offsetPose(origin, -100, 0)).z < 0)
  assert(geoToEnu(origin, offsetPose(origin, 0, -100)).x < 0)

  // Altitude is the up axis; a purely vertical offset moves y alone.
  const up = geoToEnu(origin, { ...origin, altitudeM: 13 })
  assertAlmostEquals(up.y, 3, 1e-9)
  assertAlmostEquals(up.x, 0, 1e-9)
  assertAlmostEquals(up.z, 0, 1e-9)
})

Deno.test('geoToEnu/enuToGeo round-trip is sub-millimetre at scan scale', () => {
  const origin = pose(37.7749, -122.4194, 5, { altitudeM: 42 })
  const point = offsetPose(origin, 137, -84)
  const back = enuToGeo(origin, geoToEnu(origin, point))

  const drift = distanceM(point, back)
  assert(drift !== null)
  // Not exactly zero: geoToEnu scales east by cos(mean latitude) while enuToGeo
  // scales it back by cos(origin latitude). Over a 137 m north offset those
  // cosines differ by ~5e-6 relative, i.e. well under a millimetre of east
  // error. The asymmetry grows with the north offset, so this bound is a scan-
  // scale claim only.
  assert(drift < 0.001, `round-trip drift ${drift} m should be sub-millimetre`)
})

Deno.test('geoToEnu: no fix yields the origin rather than a bogus offset', () => {
  assertEquals(geoToEnu(SF, NO_FIX), { x: 0, y: 0, z: 0 })
  assertEquals(geoToEnu(NO_FIX, SF), { x: 0, y: 0, z: 0 })
})

// ---------------------------------------------------------------------------
// Accuracy handling
// ---------------------------------------------------------------------------

Deno.test('effectiveAccuracyM: unreported accuracy is pessimistic, never perfect', () => {
  assertEquals(effectiveAccuracyM(pose(1, 1, null)), ASSUMED_ACCURACY_M)
  assertEquals(effectiveAccuracyM(pose(1, 1, 0)), ASSUMED_ACCURACY_M)
  assertEquals(effectiveAccuracyM(pose(1, 1, -3)), ASSUMED_ACCURACY_M)
  assertEquals(effectiveAccuracyM(pose(1, 1, Number.NaN)), ASSUMED_ACCURACY_M)
  // A reported sub-metre fix is floored: no consumer handset earns more trust
  // than this, and a 0 would divide by zero in the centroid weighting.
  assertEquals(effectiveAccuracyM(pose(1, 1, 0.2)), ACCURACY_FLOOR_M)
  assertEquals(effectiveAccuracyM(pose(1, 1, 7)), 7)
  assertEquals(effectiveAccuracyM(pose(1, 1, null), 4), 4)
})

Deno.test('combinedAccuracyM: quadrature, so the worse fix dominates', () => {
  assertAlmostEquals(combinedAccuracyM(pose(1, 1, 3), pose(1, 1, 3)), 4.2426, 1e-3)
  // ±3 m against ±30 m is ±30.1 m, not ±16.5 m: averaging the two would be the
  // silent-precision bug this module exists to avoid.
  assertAlmostEquals(combinedAccuracyM(pose(1, 1, 3), pose(1, 1, 30)), 30.1496, 1e-3)
})

Deno.test('standardNormalCdf: matches known values of Phi', () => {
  assertAlmostEquals(standardNormalCdf(0), 0.5, 1e-7)
  assertAlmostEquals(standardNormalCdf(1), 0.8413447, 1e-6)
  assertAlmostEquals(standardNormalCdf(-1), 0.1586553, 1e-6)
  assertAlmostEquals(standardNormalCdf(1.959964), 0.975, 1e-6)
  assertAlmostEquals(standardNormalCdf(-1.959964), 0.025, 1e-6)
  assertEquals(standardNormalCdf(Number.POSITIVE_INFINITY), 1)
  assertEquals(standardNormalCdf(Number.NEGATIVE_INFINITY), 0)
})

Deno.test('withinRadiusConfidence: 0.5 exactly at the radius, monotonic either side', () => {
  assertAlmostEquals(withinRadiusConfidence(20, 20, 10), 0.5, 1e-9)
  assert(withinRadiusConfidence(5, 20, 10) > 0.99)
  assert(withinRadiusConfidence(40, 20, 10) < 0.01)
  // Same geometry, worse fixes → less certainty in both directions.
  assert(withinRadiusConfidence(5, 20, 40) < withinRadiusConfidence(5, 20, 4))
  assert(withinRadiusConfidence(40, 20, 40) > withinRadiusConfidence(40, 20, 4))
})

// ---------------------------------------------------------------------------
// scansNear
// ---------------------------------------------------------------------------

Deno.test('scansNear: nearest first, with distance and confidence per hit', () => {
  const near = scan('near', offsetPose(SF, 3, 0, 4))
  const mid = scan('mid', offsetPose(SF, 12, 0, 4))
  const far = scan('far', offsetPose(SF, 400, 0, 4))

  const hits = scansNear([far, mid, near], SF, 20, { maxAccuracySlackM: 0 })
  assertEquals(hits.map((h) => h.scan.scanId), ['near', 'mid'])
  assertAlmostEquals(hits[0]!.distanceM, 3, 0.01)
  assertAlmostEquals(hits[1]!.distanceM, 12, 0.01)
  assert(hits[0]!.confidence > hits[1]!.confidence)
  assert(hits.every((h) => h.withinMeasuredRadius))
})

Deno.test('scansNear: a poor fix just outside the radius is admitted and flagged, not dropped', () => {
  // Identical geometry in both halves — 26 m from the query point, radius 20 m.
  // Only the reported accuracy differs.
  //
  // ±30 m fixes: 26 m is well inside the combined uncertainty, so the scan is
  // admitted by slack and flagged as not measurably inside. Dropping it at
  // 20.0 m would assert a precision the data cannot support.
  const sloppy = scan('sloppy', offsetPose(SF, 26, 0, 30))
  const [hit] = scansNear([sloppy], pose(37.7749, -122.4194, 30), 20)

  assert(hit, 'expected the slack-admitted scan to be returned')
  assertEquals(hit.withinMeasuredRadius, false)
  // Roughly 0.39: the measurement leans outside, but not nearly hard enough to
  // rule it out. That "live possibility, not a coin flip, not a rounding error"
  // band is exactly what the flag plus the score are for.
  assert(
    hit.confidence > 0.3 && hit.confidence < 0.5,
    `confidence ${hit.confidence} should say "probably outside, but far from settled"`,
  )

  // ±3 m fixes at the same 26 m: now the measurement is trustworthy enough to
  // exclude on (slack is only ±4.2 m), so the scan is genuinely out of range.
  const precise = scan('precise', offsetPose(SF, 26, 0, 3))
  assertEquals(scansNear([precise], pose(37.7749, -122.4194, 3), 20).length, 0)
})

Deno.test('scansNear: unlocated scans and an unlocated target are handled, not thrown', () => {
  const located = scan('located', offsetPose(SF, 2, 0))
  const homeless = scan('homeless', NO_FIX)

  assertEquals(scansNear([located, homeless], SF, 50).map((h) => h.scan.scanId), ['located'])
  assertEquals(scansNear([located, homeless], NO_FIX, 50), [])
  assertEquals(scansNear([], SF, 50), [])
})

Deno.test('scansNear: ordering is total, so equidistant hits never reshuffle', () => {
  // Two scans exactly the same distance out, in opposite directions.
  const b = scan('b', offsetPose(SF, 10, 0, 5))
  const a = scan('a', offsetPose(SF, -10, 0, 5))
  assertEquals(scansNear([b, a], SF, 50).map((h) => h.scan.scanId), ['a', 'b'])
  assertEquals(scansNear([a, b], SF, 50).map((h) => h.scan.scanId), ['a', 'b'])
})

// ---------------------------------------------------------------------------
// clusterScansByProximity
// ---------------------------------------------------------------------------

Deno.test('clusterScansByProximity: precise fixes 200 m apart stay two places', () => {
  const home = [
    scan('home-a', offsetPose(SF, 0, 0, 3)),
    scan('home-b', offsetPose(SF, 4, 2, 3)),
    scan('home-c', offsetPose(SF, -3, 1, 3)),
  ]
  const office = [
    scan('office-a', offsetPose(SF, 200, 0, 3)),
    scan('office-b', offsetPose(SF, 204, 1, 3)),
  ]

  const { clusters, unlocated } = clusterScansByProximity([...home, ...office], 25)
  assertEquals(unlocated, [])
  assertEquals(clusters.length, 2)
  // Largest first.
  assertEquals(clusters[0]!.members.map((m) => m.scanId).sort(), ['home-a', 'home-b', 'home-c'])
  assertEquals(clusters[1]!.members.map((m) => m.scanId).sort(), ['office-a', 'office-b'])
  assert(clusters.every((c) => !c.linkedByAccuracySlack), 'tight fixes should not need slack')
  assert(clusters[0]!.spreadM < 10, `spread ${clusters[0]!.spreadM} should stay small for a tight group`)
  assert(clusters[0]!.confidence > 0.99)
})

Deno.test('clusterScansByProximity: accuracy-aware — the same geometry clusters differently by fix quality', () => {
  // Identical positions in both runs: two scans 40 m apart, radius 25 m. Only
  // the reported accuracy differs. This is the core accuracy-awareness claim.
  const geometry: Array<[string, number]> = [['a', 0], ['b', 40]]

  const precise = geometry.map(([id, north]) => scan(id, offsetPose(SF, north, 0, 3)))
  const preciseResult = clusterScansByProximity(precise, 25)
  assertEquals(preciseResult.clusters.length, 2, '±3 m fixes 40 m apart are measurably different places')

  const sloppy = geometry.map(([id, north]) => scan(id, offsetPose(SF, north, 0, 30)))
  const sloppyResult = clusterScansByProximity(sloppy, 25)
  assertEquals(sloppyResult.clusters.length, 1, '±30 m fixes 40 m apart cannot be told apart')
  assertEquals(sloppyResult.clusters[0]!.linkedByAccuracySlack, true)
  // The cost of that merge is reported, not hidden. Confidence is measured from
  // the centroid, so each member sits ~20 m out against a 25 m radius — nominally
  // inside, but with ±37 m of combined uncertainty that lands near 0.6: barely
  // more likely in than out, and far below the >0.99 a genuinely tight group
  // scores. `linkedByAccuracySlack` is the categorical signal; this is the
  // graded one.
  assert(
    sloppyResult.clusters[0]!.confidence < 0.7,
    `slack-held cluster should not claim confidence (got ${sloppyResult.clusters[0]!.confidence})`,
  )
  assert(
    sloppyResult.clusters[0]!.confidence < preciseResult.clusters[0]!.confidence,
    'the uncertain grouping must score below the measured one',
  )
})

Deno.test('clusterScansByProximity: one bad fix does not drag the centroid off a well-fixed place', () => {
  const members = [
    scan('good-a', offsetPose(SF, 0, 0, 3)),
    scan('good-b', offsetPose(SF, 2, 0, 3)),
    scan('bad', offsetPose(SF, 40, 0, 30)),
  ]
  const { clusters } = clusterScansByProximity(members, 25)
  assertEquals(clusters.length, 1)

  const centroid = clusters[0]!.centroid
  const pulledNorthM = geoToEnu(SF, centroid).z
  // Unweighted, the mean would sit 14 m north. Inverse-variance weighting keeps
  // it under 2 m because a ±3 m fix outweighs a ±30 m one 100:1.
  assert(pulledNorthM < 2, `centroid pulled ${pulledNorthM.toFixed(2)} m north; expected < 2 m`)
  assertEquals(centroid.bearing, null, 'a place has no heading')
  // Averaging correlated fixes cannot beat the best one by more than the pinned
  // factor — the centroid must not claim sub-metre accuracy from ±3 m inputs.
  assert(centroid.accuracyM !== null && centroid.accuracyM >= 1.5, `centroid accuracy ${centroid.accuracyM}`)
  // Members come back nearest-to-centroid first.
  assertEquals(clusters[0]!.members.at(-1)!.scanId, 'bad')
})

Deno.test('clusterScansByProximity: single-link chaining is exposed by spreadM', () => {
  // Four scans in a line at 20 m spacing with a 25 m radius: every neighbour
  // links, so all four become one cluster spanning 60 m. That is single-link
  // behaviour working as designed — spreadM is what tells the caller not to call
  // this one room.
  const line = [0, 20, 40, 60].map((north, i) => scan(`s${i}`, offsetPose(SF, north, 0, 3)))
  const { clusters } = clusterScansByProximity(line, 25)

  assertEquals(clusters.length, 1)
  assertEquals(clusters[0]!.members.length, 4)
  assert(clusters[0]!.spreadM > 25, `spread ${clusters[0]!.spreadM} m should exceed the 25 m radius`)
})

Deno.test('clusterScansByProximity: scans without a fix are surfaced, never clustered or dropped', () => {
  const members = [
    scan('located-a', offsetPose(SF, 0, 0, 3)),
    scan('no-fix', NO_FIX),
    scan('null-island', pose(0, 0, 3)),
    scan('located-b', offsetPose(SF, 3, 0, 3)),
  ]
  const { clusters, unlocated } = clusterScansByProximity(members, 25)

  assertEquals(clusters.length, 1)
  assertEquals(clusters[0]!.members.length, 2)
  // Input order preserved, and every scan is accounted for exactly once.
  assertEquals(unlocated.map((s) => s.scanId), ['no-fix', 'null-island'])
  assertEquals(clusters.flatMap((c) => c.members).length + unlocated.length, members.length)
})

Deno.test('clusterScansByProximity: empty input', () => {
  const result = clusterScansByProximity([], 25)
  assertEquals(result.clusters, [])
  assertEquals(result.unlocated, [])
})

Deno.test('clusterScansByProximity: a single scan is a cluster of one', () => {
  const only = scan('only', offsetPose(SF, 0, 0, 8))
  const { clusters } = clusterScansByProximity([only], 25)
  assertEquals(clusters.length, 1)
  assertEquals(clusters[0]!.members, [only])
  assertEquals(clusters[0]!.spreadM, 0)
  assertEquals(clusters[0]!.linkedByAccuracySlack, false)
  // A lone ±8 m fix cannot improve on itself.
  assertAlmostEquals(clusters[0]!.centroid.accuracyM!, 8, 1e-9)
})

Deno.test('clusterScansByProximity: the slack cap stops one bad fix swallowing the map', () => {
  // 400 m apart. Even ±30 m fixes must not link that far: the cap is what keeps
  // accuracy-awareness from degenerating into "everything is one place".
  const far = [
    scan('a', offsetPose(SF, 0, 0, 30)),
    scan('b', offsetPose(SF, 400, 0, 30)),
  ]
  assertEquals(clusterScansByProximity(far, 25).clusters.length, 2)
})

Deno.test('clusterScansByProximity: cluster centroid carries the best-fixed address forward', () => {
  const members = [
    scan('labelled', pose(37.7749, -122.4194, 3, { address: '1 Market St', displayAddress: '1 Market St' })),
    scan('unlabelled', offsetPose(SF, 4, 0, 25)),
  ]
  const { clusters } = clusterScansByProximity(members, 25)
  assertEquals(clusters[0]!.centroid.address, '1 Market St')
})
