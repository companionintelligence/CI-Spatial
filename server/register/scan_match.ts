/**
 * Scan-to-scan matching: the verifier behind the `place-register` job.
 *
 * Two scans of one room, taken in different sessions and each placed in the
 * Place frame by its own calibration, rarely agree. The two-point frame is built
 * from two single taps about a metre apart, and the only check on a return visit
 * is that the baseline length matched (docs/audits/2026-11-13-goal-readiness.md;
 * `alignmentStatusText` says so in its own words). Nothing in the app compares
 * what the two scans actually saw. This does: it lines the walls and obstacles
 * of the new scan up against an earlier one and reports how well they agree, and
 * by how much the new scan would have to move for them to agree better.
 *
 * ## What it does
 *
 * 1. Takes each scan's points, already in the Place frame (the caller carries
 *    them through `localToWorld`), finds the floor, keeps the points between
 *    {@link SLAB_MIN_ABOVE_FLOOR_M} and {@link SLAB_MAX_ABOVE_FLOOR_M} above it,
 *    and rasterises them into 2-D occupancy cells. Below that band is floor and
 *    floor clutter, above it is ceiling and lights; neither is a wall. A floor
 *    measured from a cloud is believed only if it sits within
 *    {@link FLOOR_HINT_TOLERANCE_M} of where the calibration puts it
 *    ({@link estimateFloor}).
 * 2. Searches for the planar move of the new scan that best lays its cells on the
 *    reference's: x, z and yaw about the vertical. Gravity fixes the other two
 *    rotations (an AR session's Y is up), and height comes from the two floors,
 *    not from the search. The search is correlative scan matching (Olson 2009):
 *    each pose is scored by looking every cell of the scan that turns up in a
 *    distance-weighted field built from the other scan, exhaustively at a coarse
 *    resolution and then refined three more times around the best few coarse
 *    peaks, each level halving the step, and finally nudged to the top of the
 *    peak between steps. There is no random number anywhere, so the same two
 *    scans give the same answer every time, whatever order their points arrive in.
 *    The scan that turns is the one that reaches less far, whichever it is called
 *    ({@link turnsReference}), so the answer does not depend on which scan is the
 *    new one: a walk through several rooms against a scan of one of them is judged
 *    by the room they share.
 * 3. Measures the answer rather than trusting it: how much of the smaller scan
 *    lines up, how far apart the lined-up cells really are, whether a second
 *    position fits about as well, and whether the score actually falls away as
 *    the scan slides off the best one.
 * 4. Returns a proposal only if every gate passes. Otherwise it returns the same
 *    numbers with `transform: null` and the first gate that failed.
 *
 * ## What it refuses, and why that is the point
 *
 * A matcher that always answers is a rounding machine. This one has four kinds of
 * no, and each is a real situation:
 *
 *  - **Low overlap.** Two scans of different rooms, or of one room's opposite
 *    ends, share nothing to line up. The best position found is a coincidence.
 *  - **Ambiguity.** A corridor's walls fix the sideways position and leave the
 *    position along it free; a row of identical pillars fits at every pillar; a
 *    square room fits at four turns if the search is allowed to turn that far.
 *    Two tests: is there a second local maximum of the score, inside the bound,
 *    nearly as high as the best (symmetry and repetition), and does the score fall
 *    away within a few tenths of a metre as the scan slides off the best position
 *    (a ridge, as in a corridor, does not). If either says the position is not
 *    determined, it is not, whatever the best score says, and no transform is
 *    returned.
 *  - **A move beyond the bound.** The calibration puts the new scan close to
 *    right. A best match that needs a metre or ten degrees more than that is
 *    more likely a wrong match, or a different frame (a one-point scan against a
 *    two-point Place differs by the baseline's bearing, anywhere from 0 to 180
 *    degrees), than a genuine correction. It is reported, not offered.
 *  - **A loose fit.** The walls overlap but sit further apart than scan noise
 *    explains.
 *
 * Nothing here says a scan is aligned, verified or right. It says how the new
 * scan's walls sit against the reference's, and what move would sit them closer.
 * That is the claim ADR 0005 rule 3 allows: a status that names a verification
 * must be backed by a measurement, and these numbers are the measurement.
 *
 * ## What it cannot see
 *
 * Scan geometry, not identity: two different rooms with the same plan match
 * perfectly, and two scans of one room that are both shifted the same way relative
 * to the building cannot be told from correct ones. A room turned by its own
 * symmetry about its own centre (a bare square by a quarter turn) fits itself, and
 * since that turn lies beyond the bound the answer is "no move", right for the
 * walls and silent about which wall is which. Unrelated mass between the band
 * limits (floating junk, a ceiling at or below the upper limit, a great deal of
 * furniture) flattens the score everywhere, and the position is then refused as not
 * settled. It also trusts the floor estimate (see {@link estimateFloor}) and the
 * gravity direction of the session. Both are properties of the data, checked here
 * only as far as the numbers allow.
 *
 * ## Constants
 *
 * Every threshold in this file is **adopted, not measured** (ADR 0005 rule 5).
 * There are no real two-scan captures in this repository to measure them on
 * (`test-data/real` is a README); they were set against synthetic rooms and are
 * tuned on the owner's real data under DX9 (docs/audits, shared-context.json).
 * Each says what it is and when to revisit it.
 *
 * No Deno API, no file access, no dependency beyond the shared proposal types, so
 * the module runs unchanged under Node. File access, reading GLBs and the job
 * live in ./place_register.ts.
 */
import type {
  BoundedCorrection,
  FloorSource,
  RegistrationDetails,
  RegistrationProposal,
  RegistrationRefusal,
} from '../../src/world/register-proposal.ts'

// ─── Adopted constants ───────────────────────────────────────────────────────

/**
 * Bottom of the wall and obstacle band, metres above the floor. Below this the
 * cloud is floor, skirting and things on the floor.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**, from the package brief
 * (WP-15). **Revisit when** a real scan's walls show gaps at this height (a
 * dado rail, a radiator) or its floor clutter shows as a wall.
 */
export const SLAB_MIN_ABOVE_FLOOR_M = 0.3

/**
 * Top of the band, metres above the floor. Above this is ceiling, lights and the
 * tops of tall cupboards.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**, from the package brief. **Revisit
 * when** a real room's ceiling points land below 2.0 m (a low ceiling or a
 * sloped one) and appear as walls.
 */
export const SLAB_MAX_ABOVE_FLOOR_M = 2.0

/**
 * Side of the finest occupancy cell, metres. A cell holds the mean position of
 * the points in it, so positions are finer than the cell.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**: the live point cloud already
 * de-duplicates at 5 cm (`DEFAULT_VOXEL_M`, src/scene/pointcloud.ts), so a finer
 * cell holds no more information. **Revisit when** real clouds are denser or
 * sparser than that.
 */
export const CELL_M = 0.05

/**
 * A cell with no other occupied cell within this many cells in every direction
 * is dropped as a speck, unless it holds two or more points. SLAM clouds carry
 * stray points; a wall is a chain of cells.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** a real wall
 * sampled more sparsely than every 10 cm loses its cells to this filter.
 */
export const SPECK_RADIUS_CELLS = 2

/**
 * Floor band width, metres, and the share of the cloud a band must hold to count
 * as a floor. The same two numbers `PointCloud.estimateFloorY` uses on the phone
 * (`FLOOR_BAND_M`, `FLOOR_MIN_BAND_SHARE` in src/scene/pointcloud.ts), so the
 * server finds the floor the way the capture did.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**, and carried over from values that
 * are themselves adopted (ticket 0006 closed unrun). **Revisit when** DX9 data
 * show a floor that is missed or a step or table taken for one.
 */
export const FLOOR_BAND_M = 0.05
export const FLOOR_MIN_BAND_SHARE = 0.04

/** Below this many points an estimate is noise, so none is made. Mirrors `MIN_POINTS_FOR_GROUND_ESTIMATE`. */
export const MIN_FLOOR_POINTS = 50

/**
 * How far a floor measured from the cloud may sit from the floor the calibration
 * promised, metres, before the cloud's layer is not believed to be the floor.
 * Both calibration tiers put the tapped landmark at project y = 0
 * (`anchorToProjectTransform` in src/world/geo.ts), so the promise is "the floor is
 * at 0 give or take the tap". A layer well away from that is a tabletop, a step, a
 * platform standing in for a floor that was seen only sparsely, or a ceiling taken
 * for a floor; the hint is used instead and no height claim is made. Without this,
 * a 28 cm platform in a scan whose floor was barely seen moved a correct proposal
 * 28 cm up or down.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**: about three times the 3 cm per-axis
 * tap noise the audit's simulations assume, which is itself unmeasured (DX2).
 * **Revisit when** DX2 gives the real vertical scatter of the landmark tap, or DX9
 * shows true floors rejected (a landmark tapped on a rug) or false ones believed.
 */
export const FLOOR_HINT_TOLERANCE_M = 0.1

/**
 * Fewest wall and obstacle cells either scan may have. Sixty 5 cm cells is three
 * metres of wall; less than that is not enough shape to match on.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** real scans that
 * are plainly matchable fall below it.
 */
export const MIN_OCCUPIED_CELLS = 60

/**
 * Widest scan, metres from its centre to its far wall (the 99th percentile of
 * the cells, so a few strays do not decide it). Wider than this is a building,
 * not a room, and the working grids would be larger than is sensible here.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** a real
 * whole-floor scan needs matching.
 */
export const MAX_RADIUS_M = 25

/**
 * The correction bound: the biggest move the matcher will propose. The
 * calibration places the new scan close to right. The audit's simulation of two
 * single-tap frames (re-run for this package, assuming 3 to 5 cm of tap noise,
 * which is itself unmeasured) puts two scans of one point 5 m from the landmark
 * 20 to 33 cm apart typically and 56 to 94 cm at the 95th percentile with a
 * one-metre baseline. A metre and ten degrees cover that range and stop well
 * short of a wrong match or a different frame.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX2 gives the
 * real tap noise, or DX9 shows genuine corrections outside these bounds.
 */
export const MAX_CORRECTION_TRANSLATION_M = 1.0
export const MAX_CORRECTION_YAW_DEG = 10
/** The biggest height change, between the two floors. More than this is probably another level. */
export const MAX_CORRECTION_DY_M = 0.3

/**
 * A new cell counts as lined up when a reference cell lies within this distance,
 * metres. Three cells: comfortably above the cell size and scan noise, well below
 * the half-metre at which two different walls could be mistaken for one.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX9 gives the
 * real wall-to-wall scatter between two scans of one room.
 */
export const INLIER_GATE_M = 0.15

/**
 * Least overlap, 0 to 1, at which a position is believed. Furniture moves and
 * scans cover different parts of a room, so this is far from 1; it is high enough
 * that a chance coincidence of a few walls does not pass.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX9 shows true
 * pairs below it, or false pairs above it.
 */
export const MIN_OVERLAP_FRACTION = 0.6

/**
 * Largest RMS gap, metres, between lined-up cells. Cell size alone leaves about
 * 2 cm; the rest is allowance for scan noise and drift.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX9 gives the
 * real residual of correct pairs.
 */
export const MAX_INLIER_RESIDUAL_M = 0.08

/**
 * The residual, metres, at or below which the fit costs the score nothing. Between
 * this and {@link MAX_INLIER_RESIDUAL_M} the fit factor of the score falls from 1
 * to 0, so a pair that only just passes the residual gate does not score as well as
 * one that fits closely. Cell size alone accounts for about 2 cm.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX9 gives the
 * real residual of correct pairs.
 */
export const FULL_FIT_RESIDUAL_M = 0.04

/**
 * The first distinctiveness test: is there a second place that fits about as well?
 * `peakRatio` is the highest other local maximum of the coarse score inside the
 * bound, divided by the best position's score. At or below {@link UNIQUE_RATIO} the
 * best position stands alone and this test scores 1; at or above
 * {@link AMBIGUOUS_RATIO} somewhere else is about as good and it scores 0. Rooms
 * with one right place leave only small bumps (ratios under 0.5 here); a square room
 * searched through a full turn, and a corridor, leave maxima as high as the best.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**, from synthetic rooms and corridors.
 * **Revisit when** DX9 shows ordinary rooms scoring as ambiguous, or symmetric
 * rooms passing.
 */
export const UNIQUE_RATIO = 0.6
export const AMBIGUOUS_RATIO = 0.9

/**
 * The second distinctiveness test: how far the region of near-best positions
 * reaches. Every pose around the best that scores at least
 * {@link NEAR_BEST_FRACTION} of it, grown outward from the best through the search
 * window, is the near-best region; its reach is the farthest it extends (a turn
 * counted as the distance the typical cell travels). A scan whose walls pin it in
 * both directions loses score within a few tens of centimetres; two parallel
 * walls, or one, do not lose it at all along their length. At or below
 * {@link UNIQUE_REACH_M} the position is pinned and this test scores 1; at or
 * above {@link AMBIGUOUS_REACH_M}, or when the region runs to the edge of the
 * window, it is not pinned and this test scores 0.
 *
 * **Adopted, not measured (ADR 0005 rule 5)**, from synthetic rooms: a full
 * rectangular room reaches about half a metre, two parallel walls run to the
 * window's edge. **Revisit when** DX9 shows ordinary rooms scoring as unpinned.
 */
export const NEAR_BEST_FRACTION = 0.85
export const UNIQUE_REACH_M = 0.6
export const AMBIGUOUS_REACH_M = 1.2

/**
 * Least distinctiveness at which a position is believed, and least combined score
 * (`overlapFraction` times distinctiveness times fit) at which a proposal is made.
 * The score gate catches a pair that passes each check narrowly and none well.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** **Revisit when** DX9 data exist.
 */
export const MIN_DISTINCTIVENESS = 0.3
export const MIN_ACCEPT_SCORE = 0.5

// ─── Working parameters (not thresholds) ─────────────────────────────────────
// How the search is built. They change speed and resolution, not what is accepted. Like the thresholds above they
// are **adopted, not measured (ADR 0005 rule 5)**: chosen on synthetic rooms for accuracy and run time, to be
// revisited when DX9 reports the real clouds' size and the real run time.

/** Translation step of the coarsest level, metres. Each later level halves it. */
const COARSE_STEP_M = 0.2
/** Blur of the field at each level, metres: coarse to fine. Wider than the step so the score is smooth between nodes. */
const LEVEL_SIGMA_M = [0.3, 0.15, 0.075, 0.05] as const
/** Moving cells are merged to this size at the first two levels, metres. The last two use every cell. */
const LEVEL_CELL_M = [0.2, 0.1, CELL_M, CELL_M] as const
/** Coarse peaks kept for refinement. */
const CANDIDATES = 8
/** Largest coarse rotation step, radians (1 degree), so the finest level turns in steps near an eighth of a degree. */
const MAX_COARSE_YAW_STEP_RAD = Math.PI / 180
/** The most cells used to score a pose; more are thinned evenly. Metrics always use every cell. */
const MAX_SCORING_CELLS = 20_000
/**
 * How much farther one scan must reach than the other (RMS distance from its centre) for the narrower one to be
 * the one the search turns, whatever the cell counts. Below it, the scan with fewer cells is turned.
 * **Adopted, not measured (ADR 0005 rule 5)**: chosen so a walk through several rooms (two or more times as wide)
 * is always judged from the room it shares, and two scans of one room, which differ by a few percent, never
 * flip on noise. **Revisit when** DX9 reports pairs of very different coverage.
 */
const ROLE_SPREAD_RATIO = 1.25
/** How far past the search window the refinement levels may move a pose, metres (the finer steps sum to under 0.4). */
const REFINE_SLACK_M = 0.5
/** The most field nodes any one level may allocate. */
const MAX_FIELD_NODES = 12_000_000
/** Coordinates beyond this are not data, and are dropped before they reach a grid key. */
const MAX_COORD_M = 50_000

const DEG = Math.PI / 180

export interface MatchCloud {
  /** x, y, z triples, metres, in the Place frame as the scan is placed now. Y is up. */
  positions: ArrayLike<number>
  /**
   * Where the calibration promises the floor is. The caller knows what the
   * calibration promises; the matcher does not. Used when the cloud shows no floor
   * of its own, and as the check on one it does show: a cloud layer farther than
   * {@link FLOOR_HINT_TOLERANCE_M} from it is not taken for the floor. Used for the
   * height band only: a floor taken from here is never used to correct height.
   */
  floorHintY?: number
}

/**
 * For tests and for callers that know better than the defaults. The search window grows with the bounds, and the
 * work with the square of the translation bound and the turn bound, so widen them only as far as the question needs.
 */
export interface MatchOptions {
  /** The bound on the move's size, metres. Defaults to {@link MAX_CORRECTION_TRANSLATION_M}. */
  maxTranslationM?: number
  /** The bound on the turn, degrees. Defaults to {@link MAX_CORRECTION_YAW_DEG}. */
  maxYawDeg?: number
  /** The bound on the height change, metres. Defaults to {@link MAX_CORRECTION_DY_M}. */
  maxDyM?: number
}

/** The thresholds a run used, flat, for the job artifact. */
export function matchParams(options: MatchOptions = {}): Record<string, number> {
  const bounds = resolveBounds(options)
  return {
    slabMinAboveFloorM: SLAB_MIN_ABOVE_FLOOR_M,
    slabMaxAboveFloorM: SLAB_MAX_ABOVE_FLOOR_M,
    cellM: CELL_M,
    maxCorrectionTranslationM: bounds.translationM,
    maxCorrectionYawDeg: bounds.yawDeg,
    maxCorrectionDyM: bounds.dyM,
    floorHintToleranceM: FLOOR_HINT_TOLERANCE_M,
    roleSpreadRatio: ROLE_SPREAD_RATIO,
    inlierGateM: INLIER_GATE_M,
    minOverlapFraction: MIN_OVERLAP_FRACTION,
    maxInlierResidualM: MAX_INLIER_RESIDUAL_M,
    fullFitResidualM: FULL_FIT_RESIDUAL_M,
    uniqueRatio: UNIQUE_RATIO,
    ambiguousRatio: AMBIGUOUS_RATIO,
    nearBestFraction: NEAR_BEST_FRACTION,
    uniqueReachM: UNIQUE_REACH_M,
    ambiguousReachM: AMBIGUOUS_REACH_M,
    minDistinctiveness: MIN_DISTINCTIVENESS,
    minAcceptScore: MIN_ACCEPT_SCORE,
    minOccupiedCells: MIN_OCCUPIED_CELLS,
  }
}

function resolveBounds(options: MatchOptions): { translationM: number; yawDeg: number; dyM: number } {
  return {
    translationM: options.maxTranslationM ?? MAX_CORRECTION_TRANSLATION_M,
    yawDeg: options.maxYawDeg ?? MAX_CORRECTION_YAW_DEG,
    dyM: options.maxDyM ?? MAX_CORRECTION_DY_M,
  }
}

// ─── Geometry the job needs too ──────────────────────────────────────────────

/**
 * `positions` carried through a column-major 4x4, as Float32Array triples. The
 * job uses it to move a scan's points from its own session frame into the Place
 * frame with `scan.localToWorld`.
 */
export function transformPositions(positions: ArrayLike<number>, matrix: readonly number[]): Float32Array {
  const n = Math.floor(positions.length / 3)
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!
    const y = positions[i * 3 + 1]!
    const z = positions[i * 3 + 2]!
    out[i * 3] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!
    out[i * 3 + 1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!
    out[i * 3 + 2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!
  }
  return out
}

/**
 * The column-major matrix that turns by `yawRad` about +Y (right-hand rule) and
 * then adds `(tx, ty, tz)`. The layout `composeYUpTransform` in src/world/geo.ts
 * uses: x' = c·x + s·z, z' = −s·x + c·z.
 */
export function yawTranslationMatrix(yawRad: number, tx: number, ty: number, tz: number): number[] {
  const c = Math.cos(yawRad)
  const s = Math.sin(yawRad)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]
}

// ─── Floors ──────────────────────────────────────────────────────────────────

export interface FloorEstimate {
  /** Floor height, metres, in the frame the positions are in. */
  y: number
  /** True when the cloud itself showed the floor; false when it is the caller's hint. */
  fromCloud: boolean
  /**
   * Set only when `fromCloud` is false although the cloud did show a floor-like
   * layer: the height of that layer, which sat too far from the hint to be believed.
   */
  cloudLayerY?: number
}

export function floorSourceOf(floor: FloorEstimate): FloorSource {
  if (floor.fromCloud) return 'cloud'
  return floor.cloudLayerY === undefined ? 'hint' : 'hint-over-cloud'
}

/**
 * The floor: the lowest height band that holds at least
 * {@link FLOOR_MIN_BAND_SHARE} of the cloud, refined to the mean of the points
 * around it. The same rule as the phone's `PointCloud.estimateFloorY`: lowest
 * well-supported band, not the densest, because a well-sampled tabletop can
 * out-vote a sparsely seen floor.
 *
 * That rule can still pick a layer that is not the floor: when the floor was seen
 * only sparsely, a platform, a step or a tabletop can be the lowest layer with
 * enough points, and with no floor and a low ceiling it is the ceiling. So when
 * the caller says where the calibration puts the floor, a layer farther than
 * {@link FLOOR_HINT_TOLERANCE_M} from that is not believed: the hint is returned,
 * marked as not from the cloud, with the layer's height beside it.
 *
 * Returns the caller's hint, marked as not from the cloud, when the cloud has no
 * such band, and null when there is no hint either. A guess is never invented.
 */
export function estimateFloor(positions: ArrayLike<number>, hintY?: number): FloorEstimate | null {
  const hint = typeof hintY === 'number' && Number.isFinite(hintY) ? hintY : null
  const n = Math.floor(positions.length / 3)
  let count = 0
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1]!
    if (!Number.isFinite(y) || Math.abs(y) > MAX_COORD_M) continue
    count++
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  if (count >= MIN_FLOOR_POINTS) {
    const bands = Math.max(1, Math.ceil((maxY - minY) / FLOOR_BAND_M) + 1)
    const counts = new Uint32Array(bands)
    for (let i = 0; i < n; i++) {
      const y = positions[i * 3 + 1]!
      if (!Number.isFinite(y) || Math.abs(y) > MAX_COORD_M) continue
      counts[Math.min(bands - 1, Math.floor((y - minY) / FLOOR_BAND_M))]!++
    }
    const required = count * FLOOR_MIN_BAND_SHARE
    for (let band = 0; band < bands; band++) {
      if (counts[band]! < required) continue
      // The band is a search grid, not the answer: refine to the mean of the points around it, and recentre
      // on that mean twice so the window sits on the cluster instead of on whichever band edge it fell near.
      let centre = minY + (band + 0.5) * FLOOR_BAND_M
      for (let pass = 0; pass < 3; pass++) {
        let sum = 0
        let inliers = 0
        for (let i = 0; i < n; i++) {
          const y = positions[i * 3 + 1]!
          if (Number.isFinite(y) && Math.abs(y - centre) <= FLOOR_BAND_M) {
            sum += y
            inliers++
          }
        }
        if (inliers === 0) break
        centre = sum / inliers
      }
      if (hint !== null && Math.abs(centre - hint) > FLOOR_HINT_TOLERANCE_M) {
        return { y: hint, fromCloud: false, cloudLayerY: centre }
      }
      return { y: centre, fromCloud: true }
    }
  }
  return hint !== null ? { y: hint, fromCloud: false } : null
}

// ─── Occupancy cells ─────────────────────────────────────────────────────────

/** Occupied cells as mean point positions, in a fixed order (by grid cell), so the same cloud always gives the same arrays. */
export interface Cells {
  n: number
  x: Float64Array
  z: Float64Array
}

const KEY_OFFSET = 1 << 21
const KEY_SPAN = 1 << 22

/** A grid cell's integer key. Safe for coordinates within {@link MAX_COORD_M} at any cell size used here. */
function cellKey(ix: number, iz: number): number {
  return (ix + KEY_OFFSET) * KEY_SPAN + (iz + KEY_OFFSET)
}

/**
 * The wall and obstacle cells of a cloud: points between the two band heights
 * above `floorY`, binned into `cellM` cells, each cell at the mean position of
 * its points, with isolated specks removed.
 */
export function extractWallCells(positions: ArrayLike<number>, floorY: number, cellM = CELL_M): Cells {
  const lo = floorY + SLAB_MIN_ABOVE_FLOOR_M
  const hi = floorY + SLAB_MAX_ABOVE_FLOOR_M
  const n = Math.floor(positions.length / 3)

  const slotOf = new Map<number, number>()
  const ixs: number[] = []
  const izs: number[] = []
  const sumX: number[] = []
  const sumZ: number[] = []
  const points: number[] = []
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!
    const y = positions[i * 3 + 1]!
    const z = positions[i * 3 + 2]!
    // Written as a negated range so NaN fails it too.
    if (!(y >= lo && y <= hi)) continue
    if (!(Math.abs(x) <= MAX_COORD_M && Math.abs(z) <= MAX_COORD_M)) continue
    const ix = Math.floor(x / cellM)
    const iz = Math.floor(z / cellM)
    const key = cellKey(ix, iz)
    let slot = slotOf.get(key)
    if (slot === undefined) {
      slot = ixs.length
      slotOf.set(key, slot)
      ixs.push(ix)
      izs.push(iz)
      sumX.push(0)
      sumZ.push(0)
      points.push(0)
    }
    sumX[slot]! += x
    sumZ[slot]! += z
    points[slot]!++
  }

  const kept: number[] = []
  for (let slot = 0; slot < ixs.length; slot++) {
    if (points[slot]! >= 2 || hasNeighbour(slotOf, ixs[slot]!, izs[slot]!)) kept.push(slot)
  }
  // Grid order, not arrival order: the cloud's point order must not change the answer.
  kept.sort((a, b) => cellKey(ixs[a]!, izs[a]!) - cellKey(ixs[b]!, izs[b]!))

  const out: Cells = { n: kept.length, x: new Float64Array(kept.length), z: new Float64Array(kept.length) }
  for (let i = 0; i < kept.length; i++) {
    const slot = kept[i]!
    out.x[i] = sumX[slot]! / points[slot]!
    out.z[i] = sumZ[slot]! / points[slot]!
  }
  return out
}

function hasNeighbour(slotOf: ReadonlyMap<number, number>, ix: number, iz: number): boolean {
  for (let dx = -SPECK_RADIUS_CELLS; dx <= SPECK_RADIUS_CELLS; dx++) {
    for (let dz = -SPECK_RADIUS_CELLS; dz <= SPECK_RADIUS_CELLS; dz++) {
      if (dx === 0 && dz === 0) continue
      if (slotOf.has(cellKey(ix + dx, iz + dz))) return true
    }
  }
  return false
}

/** `cells` merged into `size`-metre cells, each at the mean of the cells in it. Deterministic order. */
function coarsen(cells: Cells, size: number): Cells {
  if (size <= CELL_M) return cells
  const slotOf = new Map<number, number>()
  const keys: number[] = []
  const sumX: number[] = []
  const sumZ: number[] = []
  const count: number[] = []
  for (let i = 0; i < cells.n; i++) {
    const key = cellKey(Math.floor(cells.x[i]! / size), Math.floor(cells.z[i]! / size))
    let slot = slotOf.get(key)
    if (slot === undefined) {
      slot = keys.length
      slotOf.set(key, slot)
      keys.push(key)
      sumX.push(0)
      sumZ.push(0)
      count.push(0)
    }
    sumX[slot]! += cells.x[i]!
    sumZ[slot]! += cells.z[i]!
    count[slot]!++
  }
  const order = keys.map((_, slot) => slot).sort((a, b) => keys[a]! - keys[b]!)
  const out: Cells = { n: order.length, x: new Float64Array(order.length), z: new Float64Array(order.length) }
  order.forEach((slot, i) => {
    out.x[i] = sumX[slot]! / count[slot]!
    out.z[i] = sumZ[slot]! / count[slot]!
  })
  return out
}

/** At most `limit` cells, thinned evenly through the (spatially ordered) list. */
function thin(cells: Cells, limit: number): Cells {
  if (cells.n <= limit) return cells
  const stride = Math.ceil(cells.n / limit)
  const keep = Math.ceil(cells.n / stride)
  const out: Cells = { n: keep, x: new Float64Array(keep), z: new Float64Array(keep) }
  for (let i = 0; i < keep; i++) {
    out.x[i] = cells.x[i * stride]!
    out.z[i] = cells.z[i * stride]!
  }
  return out
}

// ─── Likelihood fields ───────────────────────────────────────────────────────

/** A regular grid of `exp(-d²/2σ²)`, where d is the distance from the node to the nearest reference cell. */
interface Field {
  x0: number
  z0: number
  step: number
  w: number
  h: number
  data: Float32Array
}

/**
 * The field over the box `[x0, x1] x [z0, z1]`. Each reference cell splats a
 * Gaussian onto the nodes within 3σ and a node keeps the largest value it is
 * given, which is the Gaussian of the nearest cell's distance. Beyond 3σ the
 * value is 0 (it would be under 1.2 %).
 */
function buildField(cells: Cells, x0: number, z0: number, x1: number, z1: number, step: number, sigma: number): Field {
  const w = Math.max(2, Math.ceil((x1 - x0) / step) + 1)
  const h = Math.max(2, Math.ceil((z1 - z0) / step) + 1)
  const data = new Float32Array(w * h)
  const radius = 3 * sigma
  const radius2 = radius * radius
  const reach = Math.ceil(radius / step)
  const scale = 1 / (2 * sigma * sigma)
  for (let i = 0; i < cells.n; i++) {
    const sx = cells.x[i]!
    const sz = cells.z[i]!
    const gx = (sx - x0) / step
    const gz = (sz - z0) / step
    const ixLo = Math.max(0, Math.ceil(gx - reach))
    const ixHi = Math.min(w - 1, Math.floor(gx + reach))
    const izLo = Math.max(0, Math.ceil(gz - reach))
    const izHi = Math.min(h - 1, Math.floor(gz + reach))
    for (let iz = izLo; iz <= izHi; iz++) {
      const dz = z0 + iz * step - sz
      const row = iz * w
      for (let ix = ixLo; ix <= ixHi; ix++) {
        const dx = x0 + ix * step - sx
        const d2 = dx * dx + dz * dz
        if (d2 > radius2) continue
        const value = Math.exp(-d2 * scale)
        if (value > data[row + ix]!) data[row + ix] = value
      }
    }
  }
  return { x0, z0, step, w, h, data }
}

/** Bilinear lookup. Outside the grid there is no reference nearby, so 0. */
function sample(field: Field, x: number, z: number): number {
  const gx = (x - field.x0) / field.step
  const gz = (z - field.z0) / field.step
  const ix = Math.floor(gx)
  const iz = Math.floor(gz)
  if (ix < 0 || iz < 0 || ix >= field.w - 1 || iz >= field.h - 1) return 0
  const fx = gx - ix
  const fz = gz - iz
  const i = iz * field.w + ix
  const d = field.data
  const a = d[i]! * (1 - fx) + d[i + 1]! * fx
  const b = d[i + field.w]! * (1 - fx) + d[i + field.w + 1]! * fx
  return a * (1 - fz) + b * fz
}

/** One resolution of the search: a field, the new scan's cells relative to the pivot, and the steps. */
interface Level {
  field: Field
  ux: Float64Array
  uz: Float64Array
  n: number
  step: number
  dTheta: number
}

/** Mean field value under the new cells turned by `theta` about the pivot and then moved by `(tx, tz)`. */
function scorePose(level: Level, px: number, pz: number, theta: number, tx: number, tz: number): number {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const bx = px + tx
  const bz = pz + tz
  let sum = 0
  for (let i = 0; i < level.n; i++) {
    const ux = level.ux[i]!
    const uz = level.uz[i]!
    sum += sample(level.field, bx + c * ux + s * uz, bz - s * ux + c * uz)
  }
  return level.n > 0 ? sum / level.n : 0
}

interface Pose {
  theta: number
  tx: number
  tz: number
  score: number
}

/** The best of the 5x5x5 poses around `start` at this level's step, scanned in a fixed order. */
function refinePose(level: Level, px: number, pz: number, start: Pose): Pose {
  let best: Pose = { ...start, score: -1 }
  for (let a = -2; a <= 2; a++) {
    const theta = start.theta + a * level.dTheta
    for (let i = -2; i <= 2; i++) {
      const tx = start.tx + i * level.step
      for (let k = -2; k <= 2; k++) {
        const tz = start.tz + k * level.step
        const score = scorePose(level, px, pz, theta, tx, tz)
        if (score > best.score) best = { theta, tx, tz, score }
      }
    }
  }
  return best
}

/**
 * The best pose, nudged to the top of the score's peak between the finest level's grid steps: along each of
 * the three axes in turn, the vertex of the parabola through the best pose and its two neighbours one step either
 * side. Kept only if it scores at least as well, so it can only help. This is what takes the answer below the
 * finest step, a few millimetres, without a finer (and much larger) field.
 */
function polishPose(level: Level, px: number, pz: number, pose: Pose): Pose {
  let current = pose
  const vertex = (minus: number, here: number, plus: number): number => {
    const curvature = minus - 2 * here + plus
    if (!(curvature < 0)) return 0
    return Math.min(0.5, Math.max(-0.5, 0.5 * (minus - plus) / curvature))
  }
  for (const axis of ['theta', 'tx', 'tz'] as const) {
    const step = axis === 'theta' ? level.dTheta : level.step
    const at = (offset: number): number =>
      scorePose(
        level,
        px,
        pz,
        current.theta + (axis === 'theta' ? offset : 0),
        current.tx + (axis === 'tx' ? offset : 0),
        current.tz + (axis === 'tz' ? offset : 0),
      )
    const shift = vertex(at(-step), current.score, at(step)) * step
    if (shift === 0) continue
    const next: Pose = {
      theta: current.theta + (axis === 'theta' ? shift : 0),
      tx: current.tx + (axis === 'tx' ? shift : 0),
      tz: current.tz + (axis === 'tz' ? shift : 0),
      score: 0,
    }
    next.score = scorePose(level, px, pz, next.theta, next.tx, next.tz)
    if (next.score >= current.score) current = next
  }
  return current
}

/** True when no neighbour of pose (a, i, k) in the coarse volume scores higher. Ties count, so a flat ridge is all peaks. */
function isLocalMaximum(volume: Float32Array, nA: number, nT: number, a: number, i: number, k: number): boolean {
  const value = volume[(a * nT + i) * nT + k]!
  for (let da = -1; da <= 1; da++) {
    const na = a + da
    if (na < 0 || na >= nA) continue
    for (let di = -1; di <= 1; di++) {
      const ni = i + di
      if (ni < 0 || ni >= nT) continue
      for (let dk = -1; dk <= 1; dk++) {
        const nk = k + dk
        if (nk < 0 || nk >= nT || (da === 0 && di === 0 && dk === 0)) continue
        if (volume[(na * nT + ni) * nT + nk]! > value) return false
      }
    }
  }
  return true
}

/**
 * How far the region of near-best poses reaches from the best, metres, or null when it runs to the edge of the
 * search window (so there is no telling how far it would go). The region is every pose in the coarse volume
 * that scores at least {@link NEAR_BEST_FRACTION} of the best and is joined to the best through such poses.
 * Distance counts a turn as `lever` metres per radian.
 */
function nearBestReach(
  volume: Float32Array,
  nA: number,
  nT: number,
  halfA: number,
  halfT: number,
  coarse: Level,
  lever: number,
  best: Pose,
  here: number,
): number | null {
  if (!(here > 0.02)) return null
  // Start from the best-scoring node next to the refined best: the refined pose is between nodes.
  const ca = Math.round(best.theta / coarse.dTheta) + halfA
  const ci = Math.round(best.tx / coarse.step) + halfT
  const ck = Math.round(best.tz / coarse.step) + halfT
  let seed = -1
  let seedScore = -1
  for (let a = Math.max(0, ca - 1); a <= Math.min(nA - 1, ca + 1); a++) {
    for (let i = Math.max(0, ci - 1); i <= Math.min(nT - 1, ci + 1); i++) {
      for (let k = Math.max(0, ck - 1); k <= Math.min(nT - 1, ck + 1); k++) {
        const index = (a * nT + i) * nT + k
        if (volume[index]! > seedScore) {
          seed = index
          seedScore = volume[index]!
        }
      }
    }
  }
  if (seed < 0) return null
  const floor = NEAR_BEST_FRACTION * Math.max(here, seedScore)
  const seedA = Math.floor(seed / (nT * nT))
  const seedI = Math.floor(seed / nT) % nT
  const seedK = seed % nT

  const seen = new Uint8Array(volume.length)
  const stack = [seed]
  seen[seed] = 1
  let reach = 0
  while (stack.length > 0) {
    const index = stack.pop()!
    const a = Math.floor(index / (nT * nT))
    const i = Math.floor(index / nT) % nT
    const k = index % nT
    if (a === 0 || a === nA - 1 || i === 0 || i === nT - 1 || k === 0 || k === nT - 1) return null
    reach = Math.max(reach, Math.sqrt(
      ((i - seedI) * coarse.step) ** 2 + ((k - seedK) * coarse.step) ** 2 + (lever * (a - seedA) * coarse.dTheta) ** 2,
    ))
    for (let da = -1; da <= 1; da++) {
      for (let di = -1; di <= 1; di++) {
        for (let dk = -1; dk <= 1; dk++) {
          const next = ((a + da) * nT + (i + di)) * nT + (k + dk)
          if (seen[next] === 1 || volume[next]! < floor) continue
          seen[next] = 1
          stack.push(next)
        }
      }
    }
  }
  return reach
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

// ─── Metrics at the final position ───────────────────────────────────────────

interface Lined {
  /** Cells of the first set with a cell of the second within the gate. */
  matched: number
  /** Sum of squared gap over those cells. */
  sumSquares: number
}

/**
 * For each point of `from`, the gap to the nearest point of `to`, kept when within
 * `gate`. `to` is bucketed at the gate size so only the nine buckets around a
 * point are looked in.
 */
function lineUp(
  fromX: Float64Array,
  fromZ: Float64Array,
  fromN: number,
  toX: Float64Array,
  toZ: Float64Array,
  toN: number,
  gate: number,
): Lined {
  const buckets = new Map<number, number[]>()
  for (let j = 0; j < toN; j++) {
    const key = cellKey(Math.floor(toX[j]! / gate), Math.floor(toZ[j]! / gate))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(j)
    else buckets.set(key, [j])
  }
  const gate2 = gate * gate
  let matched = 0
  let sumSquares = 0
  for (let i = 0; i < fromN; i++) {
    const x = fromX[i]!
    const z = fromZ[i]!
    const bx = Math.floor(x / gate)
    const bz = Math.floor(z / gate)
    let nearest = Infinity
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = buckets.get(cellKey(bx + dx, bz + dz))
        if (!bucket) continue
        for (const j of bucket) {
          const ex = toX[j]! - x
          const ez = toZ[j]! - z
          const d2 = ex * ex + ez * ez
          if (d2 < nearest) nearest = d2
        }
      }
    }
    if (nearest <= gate2) {
      matched++
      sumSquares += nearest
    }
  }
  return { matched, sumSquares }
}

// ─── Which scan turns ────────────────────────────────────────────────────────

/** Where a set of cells is centred and how far it reaches. */
interface Spread {
  /** Centroid of the cells: the point a turn is about. */
  px: number
  pz: number
  /** Each cell's distance from the centroid. */
  radii: Float64Array
  /** The 99th-percentile distance, so a few strays do not decide how far the scan reaches. */
  reach: number
  /** RMS distance of the cells inside `reach`: how far the typical cell travels per radian of turn. */
  rms: number
}

function measureSpread(cells: Cells): Spread {
  let px = 0
  let pz = 0
  for (let i = 0; i < cells.n; i++) {
    px += cells.x[i]!
    pz += cells.z[i]!
  }
  px /= cells.n
  pz /= cells.n
  const radii = new Float64Array(cells.n)
  for (let i = 0; i < cells.n; i++) radii[i] = Math.hypot(cells.x[i]! - px, cells.z[i]! - pz)
  const sorted = Float64Array.from(radii).sort()
  const reach = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!
  let sumR2 = 0
  let inside = 0
  for (let i = 0; i < cells.n; i++) {
    if (radii[i]! > reach) continue
    sumR2 += radii[i]! * radii[i]!
    inside++
  }
  return { px, pz, radii, reach, rms: Math.sqrt(sumR2 / Math.max(1, inside)) }
}

/**
 * True when the search should turn the reference scan, not the new one.
 *
 * The scan that reaches less far is turned, so that its centre, which is where the two overlap, is the pivot. When
 * the two reach about as far (within {@link ROLE_SPREAD_RATIO}), neither choice is better conditioned, and the one
 * with fewer cells is turned: the partial scan is the one that sits inside the other. Only when both are equal
 * does the caller's order decide, so the same pair gives the same answer whichever scan is called which.
 */
function turnsReference(refSpread: Spread, movSpread: Spread, refCells: number, movCells: number): boolean {
  if (movSpread.rms > ROLE_SPREAD_RATIO * refSpread.rms) return true
  if (refSpread.rms > ROLE_SPREAD_RATIO * movSpread.rms) return false
  return movCells > refCells
}

/**
 * False when no pose the search can reach brings a cell of `turn` within the match gate of a cell of `fixed`: the
 * box `fixed` fills against the box `turn` fills grown by everything the search may move it (the window, the
 * refinement's slack, and a turn of up to `searchYawRad` about the centroid for the farthest cell). Two scans of
 * rooms far apart cannot line up anywhere, and finding that out costs a few comparisons, not a search.
 */
function footprintsCanTouch(fixed: Cells, turn: Cells, spread: Spread, searchT: number, searchYawRad: number): boolean {
  let fx0 = Infinity
  let fx1 = -Infinity
  let fz0 = Infinity
  let fz1 = -Infinity
  for (let i = 0; i < fixed.n; i++) {
    fx0 = Math.min(fx0, fixed.x[i]!)
    fx1 = Math.max(fx1, fixed.x[i]!)
    fz0 = Math.min(fz0, fixed.z[i]!)
    fz1 = Math.max(fz1, fixed.z[i]!)
  }
  let tx0 = Infinity
  let tx1 = -Infinity
  let tz0 = Infinity
  let tz1 = -Infinity
  for (let i = 0; i < turn.n; i++) {
    if (spread.radii[i]! > spread.reach) continue
    tx0 = Math.min(tx0, turn.x[i]!)
    tx1 = Math.max(tx1, turn.x[i]!)
    tz0 = Math.min(tz0, turn.z[i]!)
    tz1 = Math.max(tz1, turn.z[i]!)
  }
  const travel = searchT + REFINE_SLACK_M + 2 * spread.reach * Math.sin(Math.min(searchYawRad, Math.PI) / 2) + INLIER_GATE_M
  return tx0 - travel <= fx1 && tx1 + travel >= fx0 && tz0 - travel <= fz1 && tz1 + travel >= fz0
}

/**
 * The inverse of a matrix built by {@link yawTranslationMatrix}: turn back, then undo the move. The job
 * proposes a correction for the new scan, and the search may have moved the other scan onto it instead.
 */
export function invertYawTranslation(m: readonly number[]): number[] {
  const c = m[0]!
  const s = m[8]!
  const tx = m[12]!
  const ty = m[13]!
  const tz = m[14]!
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, -(c * tx - s * tz), -ty, -(s * tx + c * tz), 1]
}

// ─── The search ──────────────────────────────────────────────────────────────

/**
 * How far the search looks: the bound plus the margin the near-best test needs, so a position at the very edge of
 * what is allowed still has room around it to show whether its score falls away or runs on. A turn is measured as
 * the distance the typical cell travels, so the same margin is a narrower angle for a bigger scan. `lever` is that
 * distance per radian.
 */
function searchWindow(spread: Spread, bound: { translationM: number; yawDeg: number }): { lever: number; searchT: number; searchYaw: number } {
  const lever = Math.max(spread.rms, 0.5)
  return {
    lever,
    searchT: bound.translationM + AMBIGUOUS_REACH_M,
    searchYaw: Math.min(180, bound.yawDeg + AMBIGUOUS_REACH_M / lever / DEG),
  }
}

/** What one search found, and what was measured at its best position. */
interface Found {
  /** The best pose: the turn about the pivot and the move of the pivot. */
  fin: Pose
  /** The turned cells against the fixed ones, and the other way round. */
  forward: Lined
  backward: Lined
  peakRatio: number
  nearBest: number | null
  searchT: number
  searchYaw: number
}

/**
 * Finds the pose of `turn` (turned about its centroid, then moved) that lays it best on `fixed`, and measures
 * the answer. Null when the field the search needs would be too large to build.
 *
 * Which scan is `turn` matters to the numbers: the pivot, the lever a turn acts through and the bound on the move
 * are all the turned scan's. `matchScans` therefore always turns the narrower scan, so that a walk through
 * several rooms is judged by the room it shares with the earlier scan and not by the far side of the house.
 */
function search(fixed: Cells, turn: Cells, spread: Spread, bound: { translationM: number; yawDeg: number }): Found | null {
  const { px, pz, reach } = spread
  const { lever, searchT, searchYaw } = searchWindow(spread, bound)

  // A few strays beyond the 99th percentile must not stretch the grids or the turn step.
  const trimmed: Cells = { n: 0, x: new Float64Array(turn.n), z: new Float64Array(turn.n) }
  for (let i = 0; i < turn.n; i++) {
    if (spread.radii[i]! > reach) continue
    trimmed.x[trimmed.n] = turn.x[i]!
    trimmed.z[trimmed.n] = turn.z[i]!
    trimmed.n++
  }

  // The turn step keeps the far cells moving no more than one translation step per rotation step.
  const turnReach = Math.max(reach, 0.5)
  const dTheta0 = Math.min(COARSE_STEP_M / turnReach, MAX_COARSE_YAW_STEP_RAD)

  const levels: Level[] = []
  for (let l = 0; l < LEVEL_SIGMA_M.length; l++) {
    const step = COARSE_STEP_M / 2 ** l
    const sigma = LEVEL_SIGMA_M[l]!
    // Every pose the search can reach: the window, plus what refinement may move past its edge, plus the blur.
    const box = reach + searchT + REFINE_SLACK_M + 3 * sigma
    const nodes = (2 * box / step + 2) ** 2
    if (nodes > MAX_FIELD_NODES) return null
    const field = buildField(fixed, px - box, pz - box, px + box, pz + box, step, sigma)
    const set = thin(coarsen(trimmed, LEVEL_CELL_M[l]!), MAX_SCORING_CELLS)
    const level: Level = {
      field,
      ux: new Float64Array(set.n),
      uz: new Float64Array(set.n),
      n: set.n,
      step,
      dTheta: dTheta0 / 2 ** l,
    }
    for (let i = 0; i < set.n; i++) {
      level.ux[i] = set.x[i]! - px
      level.uz[i] = set.z[i]! - pz
    }
    levels.push(level)
  }

  // Level 0: every pose in the search window, kept so the best position can be set against the rest.
  const coarse = levels[0]!
  const halfT = Math.ceil(searchT / coarse.step)
  const nT = 2 * halfT + 1
  const halfA = Math.ceil(searchYaw * DEG / coarse.dTheta)
  const nA = 2 * halfA + 1
  const volume = new Float32Array(nA * nT * nT)
  for (let a = 0; a < nA; a++) {
    const theta = (a - halfA) * coarse.dTheta
    for (let i = 0; i < nT; i++) {
      const tx = (i - halfT) * coarse.step
      for (let k = 0; k < nT; k++) {
        volume[(a * nT + i) * nT + k] = scorePose(coarse, px, pz, theta, tx, (k - halfT) * coarse.step)
      }
    }
  }

  // The best few coarse peaks, no two in the same neighbourhood.
  const order = Array.from({ length: volume.length }, (_, index) => index)
    .sort((p, q) => volume[q]! - volume[p]! || p - q)
  const poseOf = (index: number): Pose => ({
    theta: (Math.floor(index / (nT * nT)) - halfA) * coarse.dTheta,
    tx: (Math.floor(index / nT) % nT - halfT) * coarse.step,
    tz: (index % nT - halfT) * coarse.step,
    score: volume[index]!,
  })
  const peaks: Pose[] = []
  for (const index of order) {
    if (peaks.length >= CANDIDATES) break
    const pose = poseOf(index)
    const apart = peaks.every((other) =>
      Math.hypot(pose.tx - other.tx, pose.tz - other.tz) > 2 * coarse.step ||
      Math.abs(pose.theta - other.theta) > 2 * coarse.dTheta
    )
    if (apart) peaks.push(pose)
  }

  // Refine each peak through the three finer levels, and keep the best on the finest field.
  let best: Pose | null = null
  for (const peak of peaks) {
    let pose = peak
    for (let l = 1; l < levels.length; l++) pose = refinePose(levels[l]!, px, pz, pose)
    if (!best || pose.score > best.score) best = pose
  }
  if (!best) return null
  const fin: Pose = polishPose(levels[levels.length - 1]!, px, pz, best)

  // ── Measure the answer at the best position ──────────────────────────────
  const c = Math.cos(fin.theta)
  const s = Math.sin(fin.theta)
  const movedX = new Float64Array(turn.n)
  const movedZ = new Float64Array(turn.n)
  for (let i = 0; i < turn.n; i++) {
    const x = turn.x[i]! - px
    const z = turn.z[i]! - pz
    movedX[i] = px + fin.tx + c * x + s * z
    movedZ[i] = pz + fin.tz - s * x + c * z
  }
  const forward = lineUp(movedX, movedZ, turn.n, fixed.x, fixed.z, fixed.n, INLIER_GATE_M)
  const backward = lineUp(fixed.x, fixed.z, fixed.n, movedX, movedZ, turn.n, INLIER_GATE_M)

  // Is there another place that fits about as well? Looked for among the other local maxima of the coarse
  // score, not among all scores: the score falls away gradually from any peak, so "the best value outside a
  // radius" would measure how wide the peak is, not whether there is a second one. A corridor's score runs
  // flat along its length, a square room's repeats every quarter turn, a row of pillars repeats at each pillar;
  // each leaves local maxima as high as the best. A room with one right place leaves only small bumps.
  // Positions within three coarse steps of the best (translation and turn) are the best's own peak. Only
  // positions inside the bound compete: a better fit beyond it would be refused as too large whatever it scored,
  // so it cannot be what the proposal is mistaken for.
  const here = scorePose(coarse, px, pz, fin.theta, fin.tx, fin.tz)
  const near = 3
  const boundYaw = bound.yawDeg * DEG
  let elsewhere = 0
  for (let a = 0; a < nA; a++) {
    const theta = (a - halfA) * coarse.dTheta
    if (Math.abs(theta) > boundYaw + 1e-9) continue
    const turnedAway = Math.abs(theta - fin.theta) > near * coarse.dTheta
    for (let i = 0; i < nT; i++) {
      const tx = (i - halfT) * coarse.step
      for (let k = 0; k < nT; k++) {
        const value = volume[(a * nT + i) * nT + k]!
        if (value <= elsewhere) continue
        const tz = (k - halfT) * coarse.step
        if (Math.hypot(tx, tz) > bound.translationM + 1e-9) continue
        const movedAway = Math.hypot(tx - fin.tx, tz - fin.tz) > near * coarse.step
        if (!turnedAway && !movedAway) continue
        if (isLocalMaximum(volume, nA, nT, a, i, k)) elsewhere = value
      }
    }
  }
  const peakRatio = here > 0.02 ? Math.min(1, elsewhere / here) : 1

  // Is the best position pinned down, or does the score barely change as the scan slides? The region of poses
  // around the best that score at least NEAR_BEST_FRACTION of it, grown outward from the best through the
  // window. Its reach is the farthest it extends, a turn counted as the distance the typical cell travels. Two
  // parallel walls fit along their length almost as well as at the best position, so the region runs to the
  // window's edge and the position is not pinned, whatever the second-peak test says.
  const nearBest = nearBestReach(volume, nA, nT, halfA, halfT, coarse, lever, fin, here)
  return { fin, forward, backward, peakRatio, nearBest, searchT, searchYaw }
}

// ─── The matcher ─────────────────────────────────────────────────────────────

function zeroDetails(partial: Partial<RegistrationDetails> = {}): RegistrationDetails {
  return {
    movingCells: 0,
    referenceCells: 0,
    movingMatchedFraction: 0,
    referenceMatchedFraction: 0,
    distinctiveness: 0,
    fit: 0,
    peakRatio: 1,
    nearBestReachM: null,
    verticalChecked: false,
    searchedTranslationM: 0,
    searchedYawDeg: 0,
    ...partial,
  }
}

function refuse(
  reason: RegistrationRefusal,
  extra: Partial<Omit<RegistrationProposal, 'status' | 'transform' | 'reason'>> = {},
): RegistrationProposal {
  return {
    status: 'refused',
    transform: null,
    overlapFraction: 0,
    inlierResidualM: null,
    score: 0,
    boundedCorrection: null,
    details: zeroDetails(),
    ...extra,
    reason,
  }
}

/**
 * Lines `moving` up against `reference` and says what move, if any, would make
 * them agree better, and how far that answer can be trusted.
 *
 * Both clouds are in the Place frame as their scans are placed now. The result's
 * `transform` is a correction **in that frame** for the moving scan: apply it to
 * `moving.localToWorld` (`multiplyMat4(transform, localToWorld)`). The reference
 * is never moved.
 *
 * The answer does not depend on which scan is called which. The search turns the
 * scan that reaches less far, whichever it is, and the transform is inverted when
 * that was the reference, so a walk through several rooms matched against a scan
 * of one of them gets the verdict the same two scans get the other way round.
 * What the bound limits is the move of the part the two share, which is where the
 * narrower scan sits.
 *
 * Never throws for bad data: an empty, tiny, flat or non-finite cloud is a
 * refusal with its reason.
 */
export function matchScans(reference: MatchCloud, moving: MatchCloud, options: MatchOptions = {}): RegistrationProposal {
  const bound = resolveBounds(options)

  // Floors first: the height band is measured from them, so nothing else can start without them.
  const refFloor = estimateFloor(reference.positions, reference.floorHintY)
  const movFloor = estimateFloor(moving.positions, moving.floorHintY)
  if (!refFloor || !movFloor) return refuse('no-floor')
  const floors = { reference: floorSourceOf(refFloor), moving: floorSourceOf(movFloor) }

  // Both floors measured from the clouds, or no height claim at all. A hint places the band; it never moves a scan.
  const verticalChecked = refFloor.fromCloud && movFloor.fromCloud
  const dy = verticalChecked ? refFloor.y - movFloor.y : 0
  if (Math.abs(dy) > bound.dyM) {
    return refuse('floor-mismatch', {
      boundedCorrection: {
        translationM: 0,
        yawDeg: 0,
        dyM: dy,
        maxShiftM: 0,
        withinBound: false,
        bound,
      },
      details: zeroDetails({ verticalChecked, floors }),
    })
  }

  const refCells = extractWallCells(reference.positions, refFloor.y)
  const movCells = extractWallCells(moving.positions, movFloor.y)
  const base = zeroDetails({ movingCells: movCells.n, referenceCells: refCells.n, verticalChecked, floors })
  if (Math.min(refCells.n, movCells.n) < MIN_OCCUPIED_CELLS) return refuse('too-few-points', { details: base })

  // The scan that reaches less far is the one the search turns, so its centre is where the two scans overlap.
  const refSpread = measureSpread(refCells)
  const movSpread = measureSpread(movCells)
  const swapped = turnsReference(refSpread, movSpread, refCells.n, movCells.n)
  const fixed = swapped ? movCells : refCells
  const turn = swapped ? refCells : movCells
  const spread = swapped ? refSpread : movSpread
  if (spread.reach > MAX_RADIUS_M) return refuse('too-large', { details: base })

  const window = searchWindow(spread, bound)
  if (!footprintsCanTouch(fixed, turn, spread, window.searchT, window.searchYaw * DEG)) return refuse('low-overlap', { details: base })

  const found = search(fixed, turn, spread, bound)
  if (!found) return refuse('too-large', { details: base })
  const { fin } = found

  const turnedMatched = found.forward.matched / turn.n
  const fixedMatched = found.backward.matched / fixed.n
  const movingMatched = swapped ? fixedMatched : turnedMatched
  const referenceMatched = swapped ? turnedMatched : fixedMatched
  const overlapFraction = Math.max(movingMatched, referenceMatched)
  // The gap is always the narrower scan's cells against the other's, so it is the same whichever way round the scans came.
  const residual = found.forward.matched > 0 ? Math.sqrt(found.forward.sumSquares / found.forward.matched) : null

  const apartness = clamp01((AMBIGUOUS_RATIO - found.peakRatio) / (AMBIGUOUS_RATIO - UNIQUE_RATIO))
  const sharpness = found.nearBest === null
    ? 0
    : clamp01((AMBIGUOUS_REACH_M - found.nearBest) / (AMBIGUOUS_REACH_M - UNIQUE_REACH_M))
  const distinctiveness = Math.min(apartness, sharpness)
  // Closeness: full credit for a tight fit, none at the residual gate. A pair that lines up everywhere but only to
  // within a hand's width scores low, as it should; it is not the same as one that lines up to a centimetre.
  const fit = residual === null
    ? 0
    : clamp01((MAX_INLIER_RESIDUAL_M - residual) / (MAX_INLIER_RESIDUAL_M - FULL_FIT_RESIDUAL_M))
  const score = overlapFraction * distinctiveness * fit

  // The search turned about the pivot and then moved the pivot, as a matrix about the origin. When it turned the
  // reference, the move that lays the new scan on the reference is the inverse of that one. Height comes from
  // the floors and is a move of the new scan either way.
  const c = Math.cos(fin.theta)
  const s = Math.sin(fin.theta)
  const searched = yawTranslationMatrix(
    fin.theta,
    spread.px + fin.tx - c * spread.px - s * spread.pz,
    0,
    spread.pz + fin.tz + s * spread.px - c * spread.pz,
  )
  const correction = swapped ? invertYawTranslation(searched) : searched
  correction[13] = dy

  // The farthest a cell of the new scan moves, over the cells inside its 99th percentile so a stray does not set it.
  let maxShift = 0
  for (let i = 0; i < movCells.n; i++) {
    if (movSpread.radii[i]! > movSpread.reach) continue
    const x = movCells.x[i]!
    const z = movCells.z[i]!
    const toX = correction[0]! * x + correction[8]! * z + correction[12]!
    const toZ = correction[2]! * x + correction[10]! * z + correction[14]!
    maxShift = Math.max(maxShift, Math.hypot(toX - x, toZ - z))
  }

  const yawDeg = (swapped ? -fin.theta : fin.theta) / DEG
  const translationM = Math.hypot(fin.tx, fin.tz)
  const boundedCorrection: BoundedCorrection = {
    translationM,
    yawDeg,
    dyM: dy,
    maxShiftM: maxShift,
    withinBound: translationM <= bound.translationM && Math.abs(yawDeg) <= bound.yawDeg && Math.abs(dy) <= bound.dyM,
    bound,
  }
  const details = zeroDetails({
    movingCells: movCells.n,
    referenceCells: refCells.n,
    movingMatchedFraction: movingMatched,
    referenceMatchedFraction: referenceMatched,
    distinctiveness,
    fit,
    peakRatio: found.peakRatio,
    nearBestReachM: found.nearBest,
    verticalChecked,
    floors,
    searchedTranslationM: found.searchT,
    searchedYawDeg: found.searchYaw,
  })
  const measured = { overlapFraction, inlierResidualM: residual, score, boundedCorrection, details }

  // The gates, in the order a person would want the first failure named. Size comes before ambiguity: a best
  // position outside the bound is near the edge of the window, where the second-peak test has nothing to
  // compare it with, and "needs a bigger move than allowed" is the useful thing to say about it.
  if (overlapFraction < MIN_OVERLAP_FRACTION) return refuse('low-overlap', measured)
  if (residual === null || residual > MAX_INLIER_RESIDUAL_M) return refuse('loose-fit', measured)
  if (!boundedCorrection.withinBound) return refuse('correction-too-large', measured)
  if (distinctiveness < MIN_DISTINCTIVENESS) return refuse('ambiguous', measured)
  if (score < MIN_ACCEPT_SCORE) return refuse('low-score', measured)

  return { status: 'proposed', transform: correction, reason: null, ...measured }
}
