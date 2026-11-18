/**
 * Tap quality: a tap is a short burst of hits read as one measurement, not one
 * snapped sample.
 *
 * Why. A calibration marker used to be `results[0]` of one hit test (8th Wall:
 * a feature point of the map, which need not lie on the surface the person
 * pointed at; WebXR: one frame, then the source cancelled). The Place's frame is
 * built from two such samples a metre or so apart, so a few centimetres of tap
 * noise is a degree or more of heading (src/world/geo.ts works the figure from
 * an assumed 3 cm), and nothing ever averaged it. `sampleTap()` asks the
 * provider for a burst of hits over about
 * `TAP_BURST_WINDOW_MS` while the phone is held still, throws away the hits that
 * disagree with the rest, and reports the per-axis median with how far the kept
 * hits scatter and how far away the spot is. It refuses a tap that is too far,
 * too scattered, or taken while tracking was not stable.
 *
 * What it cannot do. It removes the jitter inside one tap. It cannot remove a
 * systematic error (a feature that sits 6 cm off the surface in every frame) or
 * the person re-tapping a different spot next visit. Whether it helps at all is
 * what DX2 and DX5 measure; every limit below is adopted until they have.
 *
 * Pure: no DOM, no Deno, nothing from the engine. The providers hand over the
 * frames they saw (`HitBurstFrame` in ./provider.ts), this file judges them.
 */
import type { ARProvider, BurstFrameListener, HitBurst, HitBurstFrame, HitResult, Pose } from './provider.ts'
import {
  FLOOR_DATUM_FIT_ONLY_FLAG,
  floorFitIsReliable,
  floorRayAgrees,
  floorRayPoint,
  landmarkDatum,
  type FloorRayPoint,
  type GroundReading,
  type LandmarkDatum,
} from './ground-gate.ts'
import { TRACKING_RECOVERING_TEXT, cameraJumped, trackingIsStableForPlacement } from './tracking-quality.ts'
import type { TapEvidence, TapSource } from '../world/calibration-evidence.ts'
import type { Vec3 } from '../world/types.ts'

// `ScanCalibration.tap` stores a `TapEvidence`, so the two types are declared in ../world/calibration-evidence.ts,
// where the server and the editor can import them without this module's provider (ADR 0002). They keep their names here.
export type { TapEvidence, TapSource }

/**
 * How long a tap's burst runs, in milliseconds, counted from its first frame. It
 * closes on the first frame at or past this, so it can run up to one frame
 * interval longer: 467 ms at 30 frames a second, 600 ms at 5. At about 30 new
 * camera frames a second this is some fifteen frames, which leaves room for the
 * 8 to 12 hits the work package asked for when a few frames find none, and is
 * short enough to hold a phone still for. A faster camera gives more frames, and
 * all of them are used; the display refreshing faster than the camera does not
 * (a repeat of the same camera frame is not a frame, see
 * `EighthWallProvider.hitTestBurstAsync`). A caller may ask for less, never more.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** DX5 records frames per window
 * and whether hand tremor is covered.
 */
export const TAP_BURST_WINDOW_MS = 450

/**
 * Fewest usable hits a burst may rest on. Three is the least with which a
 * median-absolute-deviation rule can tell one stray hit from two that agree.
 * Below it the burst is refused, not averaged.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** A statistical floor, not a
 * device figure.
 */
export const TAP_MIN_HITS = 3

/**
 * Largest scatter a tap's kept hits may show, in metres: the root-mean-square
 * distance of the kept hits from the reported point.
 *
 * The scatter is everything that moved the hit during the burst: the map's own
 * jitter, and the hand. A burst hit-tests one screen pixel, so the camera
 * drifting during the window moves the point under it; a hand that is not held
 * still is read as an unsteady surface, which is the advice the person is given.
 * `TapSample.firstHit` keeps what one hit at the moment of the tap would have
 * been, so DX2 can set it beside the median from the same session.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** The work package's starting
 * value. For hits that scatter alike on every axis it is a per-axis scatter of
 * about 2.3 cm (the root of three divides it). In simulation, not on a device, a
 * clean burst of fourteen hits is accepted every time at 1.5 cm per axis, 96 %
 * of the time at 2 cm, 44 % at 2.5 cm, 9 % at 3 cm and almost never at 4 cm;
 * tap_sampling.test.ts pins that. The 3 cm "hit-test noise" in src/world/geo.ts
 * is an assumption about how far one tap lands from where it should, never
 * verified, and is not a measure of how far hits scatter within one burst, which
 * nothing has measured either: the two are not to be read against each other. If
 * DX2 finds real bursts in the 2.5 to 3 cm range, this is the constant to widen,
 * and the caller's "use anyway" (`SampleTapOptions.insist`: a second tap at the
 * spot that was refused) is what keeps a person from being stuck until it is.
 * DX2 and DX5 set it, and decide whether sampling helps at all.
 */
export const TAP_SPREAD_MAX_M = 0.04

/**
 * Farthest a tap may be from the camera, in metres. SLAM depth error grows with
 * range (point-filter.ts `MAX_POINT_DISTANCE_M`, which every runtime shares) and
 * a shallow view slides a hit along the floor, so taps are steered close and
 * steeply down.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** The work package's starting
 * value. DX5 taps at 1, 2, 3 and 5 m and sets it.
 */
export const TAP_RANGE_MAX_M = 3

/**
 * How near, in metres, a second tap's hits must land to where a refused tap's did for the second to be the same spot,
 * and so to be let past the limit that refused the first (`SampleTapOptions.insist`). It is measured in the
 * session's own metres, between the two medians of the usable hits, and not on the screen: the hits are fixed in the
 * map, and a person who steps closer, or whose thumb lands a few pixels off, is still tapping the spot they were
 * refused for, while one who aims somewhere else is not, wherever on the screen that is.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** The same ten centimetres, on the same reasoning, as
 * `FLOOR_RAY_AGREE_M` in ./ground-gate.ts ("two different places" above it), and a constant of its own because DX2's
 * probe taps at one spot and DX5's range runs are what show how far two taps at the same spot land apart. Too small
 * and a person who means the same spot is refused again; too large and a tap meant for another spot slips past a limit.
 */
export const TAP_SAME_SPOT_M = 0.10

/**
 * A hit is an outlier when, on any axis, it lies more than this many robust
 * standard deviations (1.4826 x the median absolute deviation) from that axis's
 * median. 3.5 is the cutoff of the modified z-score (Iglewicz and Hoaglin), the
 * textbook rule for a sample this small.
 *
 * A median absolute deviation over about twelve hits is itself noisy, which is
 * why 3 was not enough. In simulation (not on a device), a clean Gaussian burst
 * of 12 hits at 1 cm per axis loses about 6 % of its genuine hits at 3 and
 * about 3 % at 3.5, and is refused for losing too many about 1 time in 480 at 3
 * and 1 in 4,500 at 3.5, while a stray 8 cm off is still caught 99.8 % of the
 * time at 3.5. tap_sampling.test.ts runs that simulation and fails if the
 * cutoff is tightened enough to lose more than 4.5 %.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** A convention, not a device
 * figure.
 */
export const TAP_OUTLIER_K = 3.5

/**
 * Smallest robust scale the outlier rule uses, in metres. Without it a burst
 * where over half the hits are bit-identical (a stationary phone against a
 * static map snaps to the same feature frame after frame) has a deviation of
 * zero and every hit that differs by a millimetre is thrown out.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** 5 mm times `TAP_OUTLIER_K` puts
 * the least anything is called an outlier at 1.5 cm.
 */
export const TAP_OUTLIER_SCALE_FLOOR_M = 0.005

/**
 * Smallest share of the usable hits that must survive outlier rejection. If more
 * than this share had to be thrown away, the median is that of a majority that
 * barely is one, and the tap is refused as unsteady.
 *
 * **Adopted, not measured (ADR 0005 rule 5).** DX5's per-tap hit logs show how
 * often real bursts lose hits.
 */
export const TAP_MIN_INLIER_FRACTION = 0.6

/**
 * How the fitted floor takes part when the fit is reliable (`floorFitIsReliable()`).
 *
 * - `'cross-check'`: the feature hits set the position, the floor ray is reported beside it.
 * - `'fallback'`: as above, and a tap that found no usable hits is placed by the floor ray, flagged
 *   `source: 'floor-ray'`.
 * - `'prefer'`: the floor ray sets the position and the hits only gate and cross-check it (the work
 *   package's recommended end state). The hits do not veto it: where they disagree with the ray,
 *   `TapSample.floorRay.agrees` says so and the caller decides.
 *
 * Under `'prefer'` and `'fallback'` the position's height is the fitted floor's by construction. Anything that
 * asks how high the person tapped (the floor gate `isTapOnGround()`, the landmark's datum) reads
 * `tapSurfaceY()` and `tapLandmarkDatum()`, which look at what the hits measured, or it is asking the fit about
 * itself and a tap on a tabletop passes.
 *
 * Which one ships is DX5's decision: nothing here has measured the floor ray against a taped point.
 */
export type FloorRayUse = 'cross-check' | 'fallback' | 'prefer'

/** What of an `ARProvider` a tap reads. A fake with these members is a provider as far as `sampleTap()` is concerned. */
export type TapProvider = Pick<
  ARProvider,
  'hitTest' | 'hitTestBurstAsync' | 'getPose' | 'getCameraFovY' | 'getCameraAspect' | 'trackingStatus'
>

/** The two limits a tap can be let past, named as `TapSample.insisted` and `TapInsist` name them. */
export type TapLimit = 'range' | 'spread'

/**
 * A tap that confirms a refused one: "use it anyway". It lets the limits it names past, and only for a tap whose hits
 * land within `TAP_SAME_SPOT_M` of `position`, where the refused tap's did (`TapRefusal.position`). Every tap is
 * judged by the limits first: a second tap that is inside them is simply taken, and a limit is passed only where the
 * tap really exceeds it, at the spot it was refused for. Nothing else is lifted, so a second tap that lands
 * somewhere else is refused as the first would have been, whatever else about it is the same.
 */
export interface TapInsist {
  /** Where the refused tap landed. */
  position: Vec3
  /** The limits that refused it, which this tap may pass. */
  range?: boolean
  spread?: boolean
}

/** How a burst is going while it runs, for a screen that shows the person the tap is being read. */
export interface TapProgress {
  /** Milliseconds since the burst's first frame. */
  elapsedMs: number
  /** How long the burst was asked for, so a ring can be drawn as `elapsedMs / windowMs`. */
  windowMs: number
  /** New camera frames the burst has seen so far, and how many of them had a usable hit. */
  frames: number
  hits: number
  /** How far the hits so far scatter (what `TapSample.spreadM` will be), once there are `TAP_MIN_HITS` of them. */
  spreadM: number | null
}

export interface SampleTapOptions {
  /** How long the burst may run. Clamped to `TAP_BURST_WINDOW_MS`. */
  windowMs?: number
  /**
   * The host's own hit test, used when the provider has no burst or its burst saw no frame. WebXR's
   * synchronous `hitTest()` always answers null, so `main.ts` passes its async one here.
   */
  singleHit?: (x: number, y: number) => Promise<HitResult | null>
  /** `pointCloud.groundEstimate()`. Used only when `floorFitIsReliable()` says it can be. */
  floor?: GroundReading | null
  /** How a reliable floor takes part. Default `'cross-check'`. */
  floorRay?: FloorRayUse
  /**
   * Overrides for `TAP_SPREAD_MAX_M` and `TAP_RANGE_MAX_M`, for tests and device runs: a probe that measures
   * what the limits would have refused passes `Number.POSITIVE_INFINITY`. The tracking, hit-count and
   * outlier-fraction rules have no override. A person's "use anyway" is not this: it is `insist`, which lifts a
   * limit for the spot that was refused and for no other.
   */
  spreadMaxM?: number
  rangeMaxM?: number
  /** The refused tap this one confirms, if it does. See `TapInsist`. */
  insist?: TapInsist
  /**
   * Called as each frame of the burst arrives, to draw the "hold still" ring and the scatter so far. It cannot
   * change the tap, and a call that throws is ignored. Not called for a tap read with one hit.
   */
  onProgress?: (progress: TapProgress) => void
}

/** A tap that passed. */
export interface TapSample {
  ok: true
  /** Where the tap landed, session metres. Per-axis median of the kept hits unless `source` says otherwise. */
  position: Vec3
  /** Camera to `position`, metres. */
  rangeM: number
  /**
   * RMS distance of the kept hits from the median, metres, in three dimensions (x, y and z
   * together, not per axis). Null where there was one hit or none to measure.
   *
   * It is the scatter of the hits inside ONE burst, taken within `TAP_BURST_WINDOW_MS` of each other.
   * It is not the noise of a tap between visits, and it must not feed sigma-hat (the per-axis tap
   * noise the frame fit and its verdict assume: today the adopted `TAP_SIGMA0_M` in
   * src/world/baseline-guidance.ts, and any `sigmaHat()` built on it). Two reasons. With the refusal
   * at `TAP_SPREAD_MAX_M` an accepted burst scatters by at most about 2.3 cm per axis if it scatters
   * alike on every axis, which is below the 3 cm sigma-hat assumes, so it would read as a better tap
   * than the assumption. And it sees none of what makes two visits disagree: map drift between
   * sessions, the feature the hit test settled on (the same one in every frame has no spread however
   * far it lies from the surface the person pointed at), or the person tapping a slightly different
   * spot. Sigma-hat stays the adopted 3 cm until DX2 gives a measured between-session figure.
   */
  spreadM: number | null
  /** Hits kept. 0 for a tap set by the floor ray alone. */
  n: number
  /** Hits received and not kept: outliers and hits that were not finite numbers. */
  rejected: number
  source: TapSource
  /**
   * The per-axis median of the kept hits, whichever source set `position`: the two are equal unless `source` is
   * `'floor-ray'`. Absent when no hit was kept, which is a tap the floor ray placed alone.
   */
  hitPosition?: Vec3
  /**
   * The first frame's hit, where one hit at the moment of the tap would have put it, when that frame had a
   * usable one. Kept beside the median so DX2 can compute the scatter of both from one session.
   */
  firstHit?: Vec3
  /** The floor ray through the same pixel, when the fit was reliable and there were hits to compare it with. */
  floorRay?: { position: Vec3; deltaM: number; agrees: boolean }
  /**
   * The limits this tap exceeded and was let past because it confirmed a refused one (`SampleTapOptions.insist`).
   * Absent for a tap that was inside the limits, which is every tap that was not insisted on and most that were.
   * `rangeM` and `spreadM` are what they measured either way, so a record of this tap is one of a tap over its
   * limit, and says so by its numbers.
   */
  insisted?: TapLimit[]
}

/** Why a tap was refused. */
export type TapRefusalReason =
  /**
   * The runtime's tracking was not stable at some frame of the burst, a frame shift happened inside it, or the
   * camera stepped between two of its frames farther than a hand can.
   */
  | 'tracking'
  /** No hit at all. */
  | 'no-hit'
  /** Hits, but fewer than `TAP_MIN_HITS`. */
  | 'too-few-hits'
  /** The spot is beyond the range limit. */
  | 'too-far'
  /**
   * The hits disagree (too scattered, or too many were thrown away), or the only hit there was had to be read
   * late, after a burst that did not run, and the camera had moved on by then.
   */
  | 'unsteady'

export interface TapRefusal {
  ok: false
  reason: TapRefusalReason
  /** Usable hits the burst had. */
  n: number
  /** Set for `'too-far'`. */
  rangeM?: number
  /** Set for `'unsteady'` when scatter was the cause. */
  spreadM?: number
  /**
   * Where the hits it did read put the spot, so that a second tap can be told to be the same spot
   * (`SampleTapOptions.insist`): the per-axis median of the usable hits, or the floor ray's point for a tap that no
   * hit placed. Set for the two refusals a person may insist on, `'too-far'` and `'unsteady'` for scatter. Not for
   * the others: a map that moved, a spot with no hits and one whose hits mostly strayed have no place to confirm.
   */
  position?: Vec3
}

export type TapResult = TapSample | TapRefusal

export function tapEvidence(tap: TapSample, datum?: LandmarkDatum | null): TapEvidence {
  return {
    tapSpreadM: tap.spreadM,
    tapRangeM: tap.rangeM,
    tapSource: tap.source,
    landmarkAboveFloorM: datum?.landmarkAboveFloorM ?? null,
  }
}

/**
 * How high the person tapped, for the floor gate (`isTapOnGround()`, `isSameHeightRetry()` and the "N cm above the
 * floor" line in ./ground-gate.ts): the height the hits measured. It is not `position.y` when the floor ray placed
 * the tap, because that is the fitted floor's by construction, so a tap on a tabletop would sit exactly on the
 * floor. A tap the floor ray placed with no hit at all measured nothing, and its `position.y` is all there is.
 */
export function tapSurfaceY(tap: TapSample): number {
  return tap.hitPosition?.y ?? tap.position.y
}

/**
 * The floor height a landmark tap gives the frame (`landmarkDatum()` in ./ground-gate.ts), read from the height
 * the hits measured and not from `position`. They differ when the floor ray placed the tap: its `y` is the
 * fitted floor's by construction, so a datum taken from it would say "the fit and the tap agree" about a
 * landmark whose hits sat 12 cm up. A tap the floor ray placed with no hit at all has no height of its own, and
 * is the fitted floor's, flagged as such.
 */
export function tapLandmarkDatum(tap: TapSample, ground: GroundReading | null | undefined): LandmarkDatum {
  if (!tap.hitPosition) {
    return { y: tap.position.y, source: 'fit-only', landmarkAboveFloorM: null, flag: FLOOR_DATUM_FIT_ONLY_FLAG }
  }
  return landmarkDatum(tap.hitPosition.y, ground)
}

// ── Statistics ───────────────────────────────────────────────────────────────

const AXES = ['x', 'y', 'z'] as const

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function medianPoint(points: readonly Vec3[]): Vec3 {
  return {
    x: median(points.map((p) => p.x)),
    y: median(points.map((p) => p.y)),
    z: median(points.map((p) => p.z)),
  }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function isFinitePoint(p: Vec3 | null | undefined): p is Vec3 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

/** A hit with its frame's camera pose, which is what its range is measured from when the runtime gave none. */
interface Sample {
  hit: HitResult
  pose?: Pose
}

/** The frames that had a hit whose position is a finite number. */
function usableSamples(frames: readonly HitBurstFrame[]): Sample[] {
  return frames.flatMap((f) => (f.hit && isFinitePoint(f.hit.position) ? [{ hit: f.hit, pose: f.pose }] : []))
}

/** Root-mean-square distance of the samples from a point: the scatter `TAP_SPREAD_MAX_M` limits. */
function scatterAbout(samples: readonly Sample[], centre: Vec3): number {
  return Math.sqrt(samples.reduce((sum, s) => sum + distance(s.hit.position, centre) ** 2, 0) / samples.length)
}

/**
 * The samples that agree with the rest: on every axis within `TAP_OUTLIER_K` robust deviations of that
 * axis's median. The scale is floored by `TAP_OUTLIER_SCALE_FLOOR_M` so a burst of identical hits has a
 * usable one.
 */
function withoutOutliers(samples: readonly Sample[]): Sample[] {
  const limits = AXES.map((axis) => {
    const values = samples.map((s) => s.hit.position[axis])
    const centre = median(values)
    const mad = median(values.map((v) => Math.abs(v - centre)))
    return { centre, limit: TAP_OUTLIER_K * Math.max(1.4826 * mad, TAP_OUTLIER_SCALE_FLOOR_M) }
  })
  return samples.filter((s) => AXES.every((axis, i) => Math.abs(s.hit.position[axis] - limits[i].centre) <= limits[i].limit))
}

// ── Gathering the hits ───────────────────────────────────────────────────────

function currentPose(provider: TapProvider): Pose | undefined {
  try {
    return provider.getPose()
  } catch {
    return undefined
  }
}

/** Radians between two orientations. NaN where either is not a usable rotation. */
function turnBetween(a: Pose['rotation'], b: Pose['rotation']): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) / (Math.hypot(a.x, a.y, a.z, a.w) * Math.hypot(b.x, b.y, b.z, b.w))
  return 2 * Math.acos(Math.min(1, dot))
}

/**
 * How far the point under a tapped pixel can have slid between two camera poses: how far the camera moved, plus
 * the turn times the range, which is how far a turn swings the ray at the hit. Undefined where there is not the
 * evidence to say (a pose or hit missing, a number that is not a number).
 */
function slideSince(then: Pose | undefined, now: Pose | undefined, hit: HitResult | null): number | undefined {
  if (!then || !now || !hit) return undefined
  const rangeM = Number.isFinite(hit.distance) && hit.distance > 0 ? hit.distance : distance(hit.position, now.position)
  const slide = distance(then.position, now.position) + rangeM * turnBetween(then.rotation, now.rotation)
  return Number.isFinite(slide) ? slide : undefined
}

interface Gathered {
  frames: HitBurstFrame[]
  /** True when the frames are a burst, false when they are the one hit a provider without a burst gave. */
  burst: boolean
  /**
   * For a hit read after a burst that saw no frame: how far the camera had moved by then (see `slideSince()`).
   * The hit is read at the pixel, wherever the phone now points, so a tap read late is read right only if the
   * phone has not moved. Unset where the hit was read at once, or there is nothing to compare.
   */
  slideM?: number
}

/**
 * The frames a tap is judged on: the provider's burst, or, when it has none or its burst saw no frame at
 * all (the mechanism did not run, which is not the same as a surface with no hits), one hit through the
 * host's own hit test, as taps were taken before sampling. A hit read after a burst that did not run is read
 * late, so what the camera did in between is measured for `sampleTap()` to judge.
 */
async function gather(
  provider: TapProvider,
  x: number,
  y: number,
  windowMs: number,
  opts: SampleTapOptions,
): Promise<Gathered> {
  const poseAtTap = currentPose(provider)
  const hasBurst = typeof provider.hitTestBurstAsync === 'function'
  if (hasBurst) {
    const seen: HitBurstFrame[] = []
    const onProgress = opts.onProgress
    const onFrame: BurstFrameListener | undefined = onProgress
      ? (frame, elapsedMs) => {
          seen.push(frame)
          try {
            onProgress(progressOf(seen, elapsedMs, windowMs))
          } catch {
            // A screen that fails to draw the ring must not cost the tap its reading.
          }
        }
      : undefined
    let burst: HitBurst | null = null
    try {
      burst = await provider.hitTestBurstAsync!(x, y, windowMs, onFrame)
    } catch {
      burst = null
    }
    if (burst && burst.frames.length > 0) return { frames: burst.frames, burst: true }
  }

  let hit: HitResult | null = null
  try {
    hit = await (opts.singleHit ? opts.singleHit(x, y) : provider.hitTest(x, y))
  } catch {
    hit = null
  }
  const pose = currentPose(provider)
  const frame: HitBurstFrame = { hit, pose, status: provider.trackingStatus() }
  return { frames: [frame], burst: false, slideM: hasBurst ? slideSince(poseAtTap, pose, hit) : undefined }
}

/** What a tap is so far, from the frames a burst has delivered. */
function progressOf(frames: readonly HitBurstFrame[], elapsedMs: number, windowMs: number): TapProgress {
  const samples = usableSamples(frames)
  let spreadM: number | null = null
  if (samples.length >= TAP_MIN_HITS) {
    const kept = withoutOutliers(samples)
    if (kept.length > 0) spreadM = scatterAbout(kept, medianPoint(kept.map((s) => s.hit.position)))
  }
  return { elapsedMs, windowMs, frames: frames.length, hits: samples.length, spreadM }
}

/**
 * Some frame of the burst was not stable for placement, the provider's frame-shift count moved inside it, or
 * the camera stepped farther between two frames than a hand can (`cameraJumped()`), which is the only way a
 * runtime with no status and no count, WebXR, shows a shift. The step is read between each frame that had a
 * pose and the last one that did, so a stretch of frames with none does not hide it.
 */
function trackingWasDisturbed(frames: readonly HitBurstFrame[]): boolean {
  if (frames.some((f) => !trackingIsStableForPlacement(f.status, f.reason))) return true
  const counts = frames.map((f) => f.poseJumps).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (new Set(counts).size > 1) return true
  let last: Vec3 | null = null
  for (const f of frames) {
    if (!f.pose) continue
    if (last && cameraJumped(last, f.pose.position)) return true
    last = f.pose.position
  }
  return false
}

/** Camera to hit: the runtime's own distance when it gave a usable one, else measured from the frame's pose. */
function rangeOfSample(sample: Sample, fallbackPose: Pose | undefined): number {
  const { hit } = sample
  if (Number.isFinite(hit.distance) && hit.distance > 0) return hit.distance
  const pose = sample.pose ?? fallbackPose
  return pose ? distance(hit.position, pose.position) : Number.NaN
}

/** The floor ray through the pixel, from every frame that had a pose (hand tremor included), as one median. */
function floorRayThrough(
  provider: TapProvider,
  frames: readonly HitBurstFrame[],
  x: number,
  y: number,
  floorY: number,
): FloorRayPoint | null {
  const fovYDeg = provider.getCameraFovY()
  const aspect = provider.getCameraAspect()
  const poses = frames.flatMap((f) => (f.pose ? [f.pose] : []))
  if (poses.length === 0) {
    const pose = currentPose(provider)
    if (pose) poses.push(pose)
  }
  const points = poses.flatMap((pose) => {
    const point = floorRayPoint({ position: pose.position, rotation: pose.rotation, fovYDeg, aspect }, x, y, floorY)
    return point ? [point] : []
  })
  if (points.length === 0) return null
  return { position: medianPoint(points.map((p) => p.position)), rangeM: median(points.map((p) => p.rangeM)) }
}

// ── The tap ──────────────────────────────────────────────────────────────────

function refuse(
  reason: TapRefusalReason,
  n: number,
  extra: { rangeM?: number; spreadM?: number; position?: Vec3 } = {},
): TapRefusal {
  return { ok: false, reason, n, ...extra }
}

/**
 * Read one tap. `x` and `y` are the normalised canvas coordinates `hitTest()` takes.
 *
 * In order: refuse if tracking was not stable at any frame of the burst, or a hit read after a burst that did not
 * run was read after the camera had moved; refuse (or, with a reliable floor and `floorRay` set to `'fallback'`
 * or `'prefer'`, place by the floor ray) when there were fewer than `TAP_MIN_HITS` usable hits; refuse if the
 * spot is farther than the range limit (a range that cannot be measured at all is refused too); drop hits that
 * are outliers on any axis; refuse if too many had to go, or the rest scatter by more than the limit; and
 * report the per-axis median of what is left.
 *
 * The two limits a person can do something about, the range and the scatter, are the ones a second tap may pass
 * (`opts.insist`), and only where it exceeds them at the spot the first was refused for: it is judged by them
 * first, passes them where it is inside, and says in `insisted` which it was let past. A refusal for either carries
 * where the spot was (`TapRefusal.position`), so that the flow can tell the second tap which spot that was.
 *
 * A hit whose position is not a finite number is dropped and counted in `rejected`. Identical hits are a
 * valid burst with a scatter of zero. A provider whose burst saw no frame at all is read with one hit.
 */
export async function sampleTap(
  provider: TapProvider,
  x: number,
  y: number,
  opts: SampleTapOptions = {},
): Promise<TapResult> {
  const windowMs = Math.min(TAP_BURST_WINDOW_MS, Math.max(0, opts.windowMs ?? TAP_BURST_WINDOW_MS))
  const spreadMaxM = opts.spreadMaxM ?? TAP_SPREAD_MAX_M
  const rangeMaxM = opts.rangeMaxM ?? TAP_RANGE_MAX_M
  const floorRayUse = opts.floorRay ?? 'cross-check'

  const { frames, burst, slideM } = await gather(provider, x, y, windowMs, opts)
  if (trackingWasDisturbed(frames)) return refuse('tracking', 0)
  if (slideM !== undefined && slideM > spreadMaxM) return refuse('unsteady', 0)

  const ground = floorFitIsReliable(opts.floor) ? opts.floor : null
  const ray = ground ? floorRayThrough(provider, frames, x, y, ground.y) : null

  const received = frames.filter((f) => f.hit !== null).length
  const samples = usableSamples(frames)
  const first = frames[0]?.hit
  const firstHit = first && isFinitePoint(first.position) ? { ...first.position } : undefined

  // A limit this tap exceeds is passed only for a person who was refused for it at this very spot.
  const insisted: TapLimit[] = []
  const mayPass = (limit: TapLimit, at: Vec3): boolean => {
    const { insist } = opts
    return !!insist && insist[limit] === true && isFinitePoint(insist.position) && distance(at, insist.position) <= TAP_SAME_SPOT_M
  }
  const pass = (limit: TapLimit): void => {
    if (!insisted.includes(limit)) insisted.push(limit)
  }

  if (samples.length < (burst ? TAP_MIN_HITS : 1)) {
    if (ray && floorRayUse !== 'cross-check') {
      if (ray.rangeM > rangeMaxM) {
        if (!mayPass('range', ray.position)) return refuse('too-far', samples.length, { rangeM: ray.rangeM, position: ray.position })
        pass('range')
      }
      const placed: TapSample = {
        ok: true,
        position: ray.position,
        rangeM: ray.rangeM,
        spreadM: null,
        n: 0,
        rejected: received,
        source: 'floor-ray',
      }
      if (firstHit) placed.firstHit = firstHit
      if (insisted.length > 0) placed.insisted = insisted
      return placed
    }
    return refuse(samples.length === 0 ? 'no-hit' : 'too-few-hits', samples.length)
  }

  const fallbackPose = currentPose(provider)
  const hitsAt = medianPoint(samples.map((s) => s.hit.position))
  const hitRangeM = median(samples.map((s) => rangeOfSample(s, fallbackPose)).filter(Number.isFinite))
  if (!(hitRangeM <= rangeMaxM)) {
    const measured = Number.isFinite(hitRangeM)
    // A range that could not be measured is a limit nobody can say they were over: it is not passed.
    if (!(measured && mayPass('range', hitsAt))) {
      return refuse('too-far', samples.length, { ...(measured ? { rangeM: hitRangeM } : {}), position: hitsAt })
    }
    pass('range')
  }

  const kept = samples.length === 1 ? samples : withoutOutliers(samples)
  if (kept.length < Math.min(samples.length, TAP_MIN_HITS) || kept.length / samples.length < TAP_MIN_INLIER_FRACTION) {
    return refuse('unsteady', kept.length)
  }

  const position = medianPoint(kept.map((s) => s.hit.position))
  let spreadM: number | null = null
  if (burst) {
    spreadM = scatterAbout(kept, position)
    if (spreadM > spreadMaxM) {
      if (!mayPass('spread', hitsAt)) return refuse('unsteady', kept.length, { spreadM, position: hitsAt })
      pass('spread')
    }
  }

  const keptRangeM = median(kept.map((s) => rangeOfSample(s, fallbackPose)).filter(Number.isFinite))
  const tap: TapSample = {
    ok: true,
    position,
    rangeM: Number.isFinite(keptRangeM) ? keptRangeM : hitRangeM,
    spreadM,
    n: kept.length,
    rejected: received - kept.length,
    source: burst ? 'burst' : 'single-hit',
    hitPosition: { ...position },
  }
  if (firstHit) tap.firstHit = firstHit

  if (ray) {
    const deltaM = distance(ray.position, position)
    tap.floorRay = { position: ray.position, deltaM, agrees: floorRayAgrees(deltaM) }
    if (floorRayUse === 'prefer') {
      if (ray.rangeM > rangeMaxM) {
        if (!mayPass('range', hitsAt)) return refuse('too-far', kept.length, { rangeM: ray.rangeM, position: hitsAt })
        pass('range')
      }
      tap.position = ray.position
      tap.rangeM = ray.rangeM
      tap.source = 'floor-ray'
    }
  }
  if (insisted.length > 0) tap.insisted = insisted
  return tap
}

// ── What the person is told ──────────────────────────────────────────────────

/**
 * The line shown for a refused tap. Short, plain, and only what `sampleTap()` found: a distance it measured, a
 * state it read. A number that does not exist is never printed.
 */
export function tapRefusalText(refusal: TapRefusal): string {
  switch (refusal.reason) {
    case 'tracking':
      return TRACKING_RECOVERING_TEXT
    case 'no-hit':
      return 'No stable surface there. Aim at a textured floor and tap again.'
    case 'too-few-hits':
      return 'Too few readings of that spot. Hold still and tap again.'
    case 'too-far': {
      const { rangeM } = refusal
      if (rangeM === undefined || !Number.isFinite(rangeM)) return 'Move closer to that spot and tap again.'
      // A distance that rounds to the limit would read as inside it, which is not what refused it.
      return Number(rangeM.toFixed(1)) <= TAP_RANGE_MAX_M
        ? `That spot is just over ${TAP_RANGE_MAX_M} m away. Move closer and tap again.`
        : `That spot is ${rangeM.toFixed(1)} m away. Move closer and tap again.`
    }
    case 'unsteady':
      return 'That spot did not read steadily. Hold still, or aim at a more textured spot.'
  }
}
