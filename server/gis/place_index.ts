/**
 * Place index — turning scattered scan `GeoPose`s into queryable candidate places.
 *
 * Every scan already carries a `GeoPose` (phone GPS + compass + reverse geocode,
 * `src/world/types.ts`). Until now that data only produced a placement offset
 * (`server/world/world_membership.ts:placeScanTransform`) and a text label. This
 * module answers the two spatial questions multi-scan fusion and CI-Server
 * recording actually need:
 *
 *   - "which scans are near here?"          → {@link scansNear}
 *   - "which scans are the same place?"     → {@link clusterScansByProximity}
 *
 * ## What this layer can and cannot do — read this before trusting a result
 *
 * Consumer GNSS on a phone is **metre-to-tens-of-metres** accurate outdoors with
 * a clear sky, and materially worse indoors — which is exactly where a room
 * scanner runs. Indoors a handset typically falls back to Wi-Fi/cell
 * trilateration, and `GeolocationCoordinates.accuracy` routinely reports tens of
 * metres. Ticket `docs/factory/08-places-and-things/0003-scanner-place-picker.md`
 * records the observed field behaviour on this repo's own hardware: good fixes
 * around ±5 m, bad ones ±33 m, and up to ~65 m of apparent wander while standing
 * still.
 *
 * Therefore: **this layer narrows candidates to a building or a plot. It cannot
 * identify a room.** A 4 m hallway and the bedroom off it are one GPS reading.
 * Anything that needs room-level identity needs the next tier up — visual
 * relocalisation / VPS against the scan's own imagery, or the existing
 * `ScanCalibration` two-point ground frame (`twoPointToProjectTransform` in
 * `src/world/geo.ts`, per
 * `docs/adr/0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md`),
 * which is reproducible across sessions precisely because it uses no GPS and no
 * compass at all. Nothing here should be presented to a user as "you are in the
 * kitchen"; it supports "you are at Home — which room?".
 *
 * ## Earth model: there is exactly one, and it is not a haversine
 *
 * Per ADR 0001 and the explicit decision pinned in
 * `docs/factory/08-places-and-things/0003-scanner-place-picker.md` ("rather than
 * adding a second (haversine) projection, so there is exactly one earth model in
 * the repo") and repeated in `.../0005-world-as-derived-view.md` ("Do not
 * hand-roll a second haversine"), this module **adds no distance formula**. It
 * re-exports `distanceM` and `geoToEnu` from `src/world/geo.ts` unchanged, and
 * every function below is built on them.
 *
 * `distanceM` is the horizontal length of the `geoToEnu` vector — an
 * equirectangular projection about the mean latitude of the two points, on a
 * sphere of the WGS-84 equatorial radius. Measured against an independent
 * Vincenty inverse solution on the WGS-84 ellipsoid (see
 * `tests/unit/deno/place_index.test.ts`, which pins these numbers):
 *
 * | separation | `distanceM` error vs. WGS-84 geodesic |
 * | ---------- | ------------------------------------- |
 * | 10 m       | +3 cm  (+0.29 %)                      |
 * | 1 km       | +2.9 m (+0.29 %)                      |
 * | 8.3 km     | +8.6 m (+0.10 %)                      |
 * | 5585 km    | +242 km (+4.3 %)                      |
 *
 * At the scales this layer works at — metres to a few kilometres — the model
 * error is one to two orders of magnitude below the GPS accuracy it is measuring
 * against, so a true haversine would change no decision this module makes while
 * adding a second earth model to keep in sync. **Beyond ~100 km the
 * approximation degrades fast and this module's answers are meaningless** — that
 * is fine, because "scans near here" at continental range is not a question
 * anyone asks of a room scanner, but do not reuse these functions for one.
 *
 * ## Deliberately Deno-API-free
 *
 * Nothing here touches `Deno.*`, so the whole module is unit-testable without
 * `main.ts`'s top-level side effects — the same pattern `world_prune.ts`,
 * `world_lock.ts` and `world_membership.ts` follow (ADR 0004). It lives under
 * `server/` because it is a server-side query layer, not because it needs a
 * server runtime.
 *
 * ## No new "place" type
 *
 * The place is the existing `WorldProject` / `Project` (ADR 0001; the wave 08
 * ownership rule is *Project owns membership, World derives it*). A
 * {@link ProximityCluster} is a **query result**, not a stored entity — a
 * suggestion that some scans might belong to one place. Nothing here persists,
 * and nothing here should grow an id.
 */

import { distanceM, enuToGeo, geoToEnu, hasGeoPose } from '../../src/world/geo.ts'
import type { GeoPose, Vec3 } from '../../src/world/types.ts'

// Re-exported so callers of this module get the one earth model without a
// second import path that could later drift to a different implementation.
export { distanceM, enuToGeo, geoToEnu, hasGeoPose }

/**
 * Accuracy assumed for a fix that reports `accuracyM: null`.
 *
 * `null` means "the device did not say", which is emphatically not "perfect".
 * Treating it as 0 would let an unknown-quality fix dominate a weighted centroid
 * and pass every confidence check — the exact silent-precision failure this
 * module is supposed to avoid. 20 m is a deliberately pessimistic stand-in for a
 * typical mixed indoor/outdoor handset fix, chosen so an unknown fix is
 * *usable but never authoritative*.
 *
 * **Adopted by decision, not measured.** Revisit if real `null`-accuracy fixes
 * turn out to come from a specific platform whose true spread is known.
 */
export const ASSUMED_ACCURACY_M = 20

/**
 * Floor applied to any reported accuracy before it is used as an uncertainty.
 *
 * A handset occasionally reports a sub-metre `accuracy` that its physics cannot
 * support (a fused/smoothed value, or a stale high-confidence fix). Without a
 * floor, one such reading gets near-infinite weight in the inverse-variance
 * centroid below and a division by zero when it reports exactly 0.
 */
export const ACCURACY_FLOOR_M = 1

/**
 * Hard cap on how far positional uncertainty may stretch a proximity test.
 *
 * Two fixes at ±40 m combine to ±57 m of slack; without a cap, one bad fix
 * links a whole neighbourhood into a single "place". 50 m is roughly the
 * observed worst-case stationary wander (~65 m, ticket 08/0003) rounded down —
 * far enough to keep a genuinely bad fix attached to its building, short enough
 * that it cannot reach the next one.
 *
 * **Adopted by decision, not measured.**
 */
export const MAX_ACCURACY_SLACK_M = 50

/**
 * Divisor converting a reported accuracy radius to a 1σ standard deviation.
 *
 * The W3C Geolocation API specifies `GeolocationCoordinates.accuracy` as a
 * **95 % confidence** radius, and `src/geo/geo-tracker.ts:139` copies that field
 * straight through into `GeoPose.accuracyM`. What it does not pin down is
 * *which* 95 %: read radially, a 2-D circular normal's 95 % radius is ≈ 2.45σ
 * (Rayleigh); read per-axis it is ≈ 1.96σ. **Which one a given platform means
 * has not been verified here.** 1.96 is used because it is the conservative
 * reading — it yields the *larger* σ and therefore the lower confidence.
 *
 * Revisit if a platform's `accuracy` is ever benchmarked against a surveyed
 * point; until then this divisor is a documented assumption, not a measurement.
 */
export const ACCURACY_SIGMA_DIVISOR = 1.96

/**
 * Lower bound on a cluster centroid's accuracy, as a fraction of its best
 * member's accuracy.
 *
 * The inverse-variance centroid below assumes the members' errors are
 * independent, which they are not: fixes taken minutes apart in one building
 * share ionospheric delay, satellite geometry and multipath, so averaging them
 * cancels almost none of the common-mode bias. Without this floor, ten ±10 m
 * fixes would claim a ±3.2 m centroid the physics does not support.
 *
 * 0.5 says averaging may buy at most a factor of two over the single best fix.
 * **Adopted by decision, not measured** — it is a conservative bound, not a
 * result. Revisit if repeated fixes at a surveyed point ever get benchmarked.
 */
export const CENTROID_ACCURACY_FLOOR_FRACTION = 0.5

/**
 * Minimal shape this module needs from a scan. `ScanManifest`
 * (`src/world/types.ts`) satisfies it structurally, so nothing has to be mapped
 * or wrapped — and per ADR 0001 no new scan type is introduced. Generic
 * parameters below are `T extends GeoLocatedScan`, so callers get their own
 * richer type back out of every result.
 */
export interface GeoLocatedScan {
  scanId: string
  geoPose: GeoPose
}

/** One scan returned by {@link scansNear}, with everything needed to judge it. */
export interface ScanProximityHit<T extends GeoLocatedScan> {
  scan: T
  /** Horizontal separation from the query point, in metres (`distanceM`). */
  distanceM: number
  /** Combined 95 % uncertainty of the two fixes — see {@link combinedAccuracyM}. */
  combinedAccuracyM: number
  /**
   * `true` when the *measured* distance is inside `radiusM`. `false` marks a hit
   * admitted only by the accuracy slack: probably inside, not measurably so.
   * A caller wanting the strict set filters on this rather than on a re-derived
   * distance threshold.
   */
  withinMeasuredRadius: boolean
  /** P(true separation ≤ `radiusM`) — see {@link withinRadiusConfidence}. */
  confidence: number
}

/**
 * A group of scans that plausibly share one place. **A query result, not a
 * stored entity** — the place itself is a `WorldProject`/`Project` (ADR 0001).
 */
export interface ProximityCluster<T extends GeoLocatedScan> {
  /** Members, nearest-to-centroid first. Never empty. */
  members: T[]
  /**
   * Inverse-variance weighted mean position. Its `accuracyM` is the combined
   * accuracy of the average, floored per {@link CENTROID_ACCURACY_FLOOR_FRACTION};
   * `bearing` is always `null` because a place has no heading.
   */
  centroid: GeoPose
  /** Distance from the centroid to the furthest member, in metres. */
  spreadM: number
  /**
   * Weakest member's {@link withinRadiusConfidence} against the centroid — i.e.
   * how confident the cluster is that its *loosest* member really belongs.
   *
   * Read it together with `linkedByAccuracySlack`, not instead of it. Because
   * it is measured from the centroid rather than along the widest link, a group
   * of poor fixes lands in the middle of the range (~0.6 for two ±30 m fixes
   * 40 m apart at a 25 m radius) rather than near zero — which is honest: those
   * scans genuinely cannot be told apart, so neither "one place" nor "two" is
   * refuted. It collapses towards zero only when the fixes are precise *and*
   * the group is too spread out for the radius, which is the case where the
   * grouping really is contradicted by the measurements.
   */
  confidence: number
  /**
   * `true` when at least one member was joined only because accuracy slack
   * stretched the radius, i.e. the group is held together by uncertainty rather
   * than by measurement. Surface it; do not average it away.
   */
  linkedByAccuracySlack: boolean
}

export interface ProximityClustering<T extends GeoLocatedScan> {
  clusters: ProximityCluster<T>[]
  /**
   * Scans with no usable fix, in input order. They are **never** folded into a
   * cluster: a null/0,0 `GeoPose` is missing data, not a position, and
   * `hasGeoPose` already treats a literal 0,0 as missing for that reason. They
   * are returned rather than dropped so a caller can show "3 scans have no
   * location" instead of quietly losing them.
   */
  unlocated: T[]
}

export interface ProximityOptions {
  /** Override {@link MAX_ACCURACY_SLACK_M} for one call. */
  maxAccuracySlackM?: number
  /** Override {@link ASSUMED_ACCURACY_M} for one call. */
  assumedAccuracyM?: number
}

/**
 * The uncertainty to use for a fix: its reported accuracy, or the assumed
 * default when it reported none, floored at {@link ACCURACY_FLOOR_M}.
 * Non-finite and negative values are treated as "not reported".
 */
export function effectiveAccuracyM(pose: GeoPose, assumed = ASSUMED_ACCURACY_M): number {
  const reported = pose.accuracyM
  const usable = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
    ? reported
    : assumed
  return Math.max(usable, ACCURACY_FLOOR_M)
}

/**
 * Combined 95 % uncertainty of a *separation* between two fixes.
 *
 * Errors from two independent fixes add in quadrature, and because a 95 % radius
 * is a fixed multiple of σ the same quadrature applies directly to the reported
 * radii. Concretely: ±3 m against ±3 m gives ±4.2 m, but ±3 m against ±30 m
 * gives ±30.1 m — the bad fix dominates, which is the correct behaviour and the
 * reason this module never treats a ±30 m fix as if it were a ±3 m one.
 */
export function combinedAccuracyM(a: GeoPose, b: GeoPose, assumed = ASSUMED_ACCURACY_M): number {
  return Math.hypot(effectiveAccuracyM(a, assumed), effectiveAccuracyM(b, assumed))
}

/**
 * Φ(z), the standard normal CDF, via the Abramowitz & Stegun 7.1.26 rational
 * approximation to erf (|error| < 1.5e-7 — far tighter than anything GPS
 * uncertainty justifies). Exported so the approximation itself can be pinned by
 * a test rather than only exercised indirectly.
 */
export function standardNormalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const poly = t * (0.254829592
    + t * (-0.284496736
    + t * (1.421413741
    + t * (-1.453152027
    + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

/**
 * Probability that the *true* separation is within `radiusM`, given a measured
 * separation and the combined 95 % accuracy of the two fixes.
 *
 * Models the measured distance as normal about the truth with
 * σ = `combinedAccuracyM / ACCURACY_SIGMA_DIVISOR`, so the answer is
 * `Φ((radiusM − measured) / σ)`:
 *
 *   - measured well inside the radius → →1
 *   - measured exactly at the radius  → 0.5, by construction
 *   - measured well outside           → →0
 *
 * **This is a calibrated-looking number from an uncalibrated input.** The
 * normal approximation ignores that a distance between two 2-D fixes is
 * non-central-chi rather than normal (it cannot go below zero, and is biased
 * upward when the separation is small relative to σ), and it inherits whatever
 * optimism the platform baked into `accuracy`. Treat it as a ranking and
 * thresholding aid, not as a probability to report to a user or to multiply into
 * some other likelihood.
 */
export function withinRadiusConfidence(measuredM: number, radiusM: number, combinedM: number): number {
  const sigma = Math.max(combinedM, ACCURACY_FLOOR_M) / ACCURACY_SIGMA_DIVISOR
  return standardNormalCdf((radiusM - measuredM) / sigma)
}

/** Slack added to a radius test, capped so one bad fix cannot swallow a city. */
function accuracySlackM(a: GeoPose, b: GeoPose, options: ProximityOptions): number {
  const cap = options.maxAccuracySlackM ?? MAX_ACCURACY_SLACK_M
  return Math.min(combinedAccuracyM(a, b, options.assumedAccuracyM ?? ASSUMED_ACCURACY_M), cap)
}

/**
 * Scans within `radiusM` of `target`, nearest first.
 *
 * **How accuracy is handled — the honest version.** A strict `d <= radiusM` cut
 * would silently pretend every fix is exact: a scan measured 12 m away with a
 * combined ±30 m uncertainty is, on the evidence, *more likely inside* a 15 m
 * radius than outside it, and dropping it at 15.1 m would be a precision claim
 * the data cannot support. So the search admits everything out to
 * `radiusM + slack` (slack = combined accuracy, capped at
 * {@link MAX_ACCURACY_SLACK_M}) and reports, per hit, both whether the *measured*
 * distance was inside (`withinMeasuredRadius`) and how likely the *true*
 * distance is (`confidence`). Callers choose: filter on `withinMeasuredRadius`
 * for the strict set, threshold on `confidence` for the useful one.
 *
 * Scans with no usable fix are omitted — they are not "at distance 0", and
 * there is no distance to sort them by. {@link clusterScansByProximity} returns
 * them explicitly in `unlocated` when a caller needs to account for every scan.
 * A `target` with no fix yields an empty result rather than a throw: "I don't
 * know where you are" is a normal state on this platform, not an error.
 *
 * O(n) in the scan count; ordering is total and deterministic (distance, then
 * combined accuracy, then `scanId`) so equal-distance results never reshuffle
 * between calls.
 */
export function scansNear<T extends GeoLocatedScan>(
  scans: readonly T[],
  target: GeoPose,
  radiusM: number,
  options: ProximityOptions = {},
): ScanProximityHit<T>[] {
  if (!hasGeoPose(target)) return []

  const hits: ScanProximityHit<T>[] = []
  for (const scan of scans) {
    if (!hasGeoPose(scan.geoPose)) continue
    const measured = distanceM(target, scan.geoPose)
    if (measured === null) continue

    const combined = combinedAccuracyM(target, scan.geoPose, options.assumedAccuracyM ?? ASSUMED_ACCURACY_M)
    const slack = accuracySlackM(target, scan.geoPose, options)
    if (measured > radiusM + slack) continue

    hits.push({
      scan,
      distanceM: measured,
      combinedAccuracyM: combined,
      withinMeasuredRadius: measured <= radiusM,
      confidence: withinRadiusConfidence(measured, radiusM, combined),
    })
  }

  hits.sort((a, b) =>
    a.distanceM - b.distanceM
    || a.combinedAccuracyM - b.combinedAccuracyM
    || a.scan.scanId.localeCompare(b.scan.scanId)
  )
  return hits
}

/**
 * Groups scans into candidate places by proximity.
 *
 * **How accuracy is handled — the honest version.** Two scans are linked when
 * their measured separation is within `radiusM` *plus* the slack their own fixes
 * justify (combined 95 % accuracy, capped at {@link MAX_ACCURACY_SLACK_M}). So a
 * pair of ±3 m fixes must genuinely be close to link, while a pair including a
 * ±30 m fix is given the benefit of its own doubt — a scan is not exiled to its
 * own "place" because the phone had a bad moment indoors. The cost is stated,
 * not hidden: a cluster that needed slack sets `linkedByAccuracySlack`, and the
 * weakest link shows up in `confidence`. Nothing here silently ignores
 * `accuracyM`, and nothing treats a ±30 m fix as a ±3 m one.
 *
 * **Single-link agglomeration, with the chaining caveat that implies.** A links
 * to B and B links to C puts all three in one cluster even if A and C are far
 * apart — the classic single-link failure. That is the right default here (a
 * corridor of scans through one building *is* one place, and a centroid-first
 * method would split it arbitrarily), but it means a line of scans down a street
 * at `radiusM` spacing collapses into one cluster. `spreadM` is what exposes
 * that: a cluster whose spread greatly exceeds `radiusM` chained, and the caller
 * should not present it as a single room or unit.
 *
 * O(n²) in the located-scan count. Deliberate: scan counts here are tens to low
 * hundreds, and a grid index would add a second spatial structure to maintain
 * for no measurable gain at that size. Revisit above a few thousand scans.
 *
 * Clusters come back largest first (ties broken by the first member's `scanId`)
 * so the most-supported candidate leads; members within a cluster are ordered
 * nearest-to-centroid first.
 */
export function clusterScansByProximity<T extends GeoLocatedScan>(
  scans: readonly T[],
  radiusM: number,
  options: ProximityOptions = {},
): ProximityClustering<T> {
  const located: T[] = []
  const unlocated: T[] = []
  for (const scan of scans) {
    if (hasGeoPose(scan.geoPose)) located.push(scan)
    else unlocated.push(scan)
  }

  const assigned = new Array<boolean>(located.length).fill(false)
  const clusters: ProximityCluster<T>[] = []

  for (let seed = 0; seed < located.length; seed++) {
    if (assigned[seed]) continue

    // Breadth-first flood over the "linked" graph: single-link agglomeration
    // without materialising the full adjacency matrix.
    const memberIndices: number[] = [seed]
    assigned[seed] = true
    let usedSlack = false

    for (let cursor = 0; cursor < memberIndices.length; cursor++) {
      const a = located[memberIndices[cursor]!]!.geoPose
      for (let other = 0; other < located.length; other++) {
        if (assigned[other]) continue
        const b = located[other]!.geoPose
        const measured = distanceM(a, b)
        if (measured === null) continue
        const slack = accuracySlackM(a, b, options)
        if (measured > radiusM + slack) continue
        if (measured > radiusM) usedSlack = true
        assigned[other] = true
        memberIndices.push(other)
      }
    }

    const members = memberIndices.map((index) => located[index]!)
    clusters.push(buildCluster(members, radiusM, usedSlack, options))
  }

  clusters.sort((a, b) =>
    b.members.length - a.members.length
    || a.members[0]!.scanId.localeCompare(b.members[0]!.scanId)
  )
  return { clusters, unlocated }
}

/**
 * Centroid, spread and confidence for one finished group.
 *
 * The centroid is an **inverse-variance weighted mean in ENU metres** about the
 * group's best-fixed member, converted back to WGS-84 with `enuToGeo`. Weighting
 * by 1/σ² is what makes accuracy-awareness show up in the position and not just
 * in a flag: a ±3 m fix pulls the centroid 100× harder than a ±30 m one, so a
 * single bad indoor reading cannot drag a well-surveyed place off its spot.
 *
 * Working in the local ENU tangent plane rather than averaging degrees is not a
 * nicety — averaging longitudes weights a degree differently at different
 * latitudes and breaks outright across the antimeridian. Doing it in metres
 * about a local origin reuses the one earth model and sidesteps both.
 */
function buildCluster<T extends GeoLocatedScan>(
  members: readonly T[],
  radiusM: number,
  usedSlack: boolean,
  options: ProximityOptions,
): ProximityCluster<T> {
  const assumed = options.assumedAccuracyM ?? ASSUMED_ACCURACY_M
  const anchor = members.reduce((best, scan) =>
    effectiveAccuracyM(scan.geoPose, assumed) < effectiveAccuracyM(best.geoPose, assumed) ? scan : best
  )
  const anchorPose = anchor.geoPose

  let weightSum = 0
  const sum: Vec3 = { x: 0, y: 0, z: 0 }
  for (const member of members) {
    const sigma = effectiveAccuracyM(member.geoPose, assumed)
    const weight = 1 / (sigma * sigma)
    const enu = geoToEnu(anchorPose, member.geoPose)
    sum.x += enu.x * weight
    sum.y += enu.y * weight
    sum.z += enu.z * weight
    weightSum += weight
  }

  const mean: Vec3 = { x: sum.x / weightSum, y: sum.y / weightSum, z: sum.z / weightSum }
  // Standard error of an inverse-variance weighted mean is 1/sqrt(Σ 1/σ²), then
  // floored because the independence that formula assumes does not hold for GPS
  // fixes taken in one place — see CENTROID_ACCURACY_FLOOR_FRACTION.
  const bestAccuracy = effectiveAccuracyM(anchorPose, assumed)
  const centroidAccuracyM = Math.max(
    1 / Math.sqrt(weightSum),
    bestAccuracy * CENTROID_ACCURACY_FLOOR_FRACTION,
  )

  const projected = enuToGeo(anchorPose, mean)
  const centroid: GeoPose = {
    lat: projected.lat,
    lng: projected.lng,
    altitudeM: projected.altitudeM,
    // A place has no heading. `enuToGeo` spreads the origin pose, which would
    // otherwise smuggle the anchor scan's compass bearing in as if it described
    // the place.
    bearing: null,
    accuracyM: centroidAccuracyM,
    // Kept from the best-fixed member that has one, so a cluster can be labelled
    // without a second reverse-geocode round trip. It describes that member's
    // fix, not the centroid — hence "nearest known address", never "the address".
    address: anchorPose.address ?? members.find((m) => m.geoPose.address)?.geoPose.address ?? null,
    displayAddress: anchorPose.displayAddress
      ?? members.find((m) => m.geoPose.displayAddress)?.geoPose.displayAddress ?? null,
  }

  const withDistance = members.map((member) => ({
    member,
    distance: distanceM(centroid, member.geoPose) ?? 0,
  }))
  withDistance.sort((a, b) => a.distance - b.distance || a.member.scanId.localeCompare(b.member.scanId))

  let spreadM = 0
  let confidence = 1
  for (const { member, distance } of withDistance) {
    spreadM = Math.max(spreadM, distance)
    confidence = Math.min(
      confidence,
      withinRadiusConfidence(distance, radiusM, combinedAccuracyM(centroid, member.geoPose, assumed)),
    )
  }

  return {
    members: withDistance.map((entry) => entry.member),
    centroid,
    spreadM,
    confidence,
    linkedByAccuracySlack: usedSlack,
  }
}
