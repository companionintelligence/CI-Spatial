/**
 * How the calibration flow reads a tap, and what it does when the map moves under the points it has placed.
 *
 * `sampleTap()` (./tap-sampling.ts) turns a short burst of hits into one measurement, or a refusal that says why.
 * `watchLandmark()` (./tracking-quality.ts) says when the frame a landmark was placed in can no longer be
 * trusted. Neither knew about the modal (./project-calibration.ts): this is what joins them to it, so that the
 * modal has a few lines to call and not a tap policy to carry (WP-05b).
 *
 * ## What it does
 *
 *  - **Reads a tap** through the host's sampler (`CalibrationTapSampler`, built by `calibrationTapSampler()` where
 *    the provider is), and answers the modal's `TapReader` (./calibration-commit.ts): a point, or the sentence to
 *    show for a refusal. While tracking is not stable it does not start a burst at all: "Hold still, tracking is
 *    recovering" at once, and no second wait for a tap that was going to be refused.
 *  - **Shows the wait.** A burst takes up to `TAP_BURST_WINDOW_MS` and the phone has to be still for it. The
 *    hold-still ring (`holdRingFor()`, `paintHoldRing()`) fills as the burst runs and turns to the warning colour
 *    when the hits so far scatter more than the limit, which is the person's cue that their hand moved.
 *  - **Lets a person insist, on the spot that was refused and on no other.** A tap refused for being too far, or for
 *    scattering past the limit, is not final: tapping that same spot again lets the limit past if it is exceeded
 *    again (`SampleTapOptions.insist`, ./tap-sampling.ts). "The same spot" is where the hits land in the map, within
 *    `TAP_SAME_SPOT_M` of where the refused tap's did, and not where on the screen the finger was: a second tap
 *    aimed anywhere else is judged by the limits as the first was, and a second tap that is inside them is taken as
 *    an ordinary one. Without it a device whose hits scatter more than the adopted limit could never calibrate.
 *    A tap taken this way says so on the card (`usedAnywayText()`), and the numbers it was taken with are the ones
 *    kept, so for the landmark the record shows a scatter or a range past the limit (the heading marker's tap is
 *    shown on the card and not kept: `ScanCalibration.tap` is the landmark's). A refusal for tracking, for no hit, or
 *    for too many strays is never insisted on.
 *  - **Keeps what each accepted tap measured**, and hands it back for the landmark at commit: the floor height
 *    the frame takes (`landmarkDatum()`, ./ground-gate.ts) and the `ScanCalibration.tap` evidence
 *    (`tapEvidence()`). The landmark is found by its position, which is the tap's own, so the modal passes no tap
 *    around: `frameLandmark()` is called with the point it holds and gives back the point the frame is built from.
 *  - **Watches the landmark.** From the tap that placed it, the provider's frame-shift counters are watched until
 *    the commit, and from its confirmation the clock too (`placementDisturbed()`, `LANDMARK_TO_COMMIT_BUDGET_MS`):
 *    a shift while the person types a label is seen when they confirm, and the 90 seconds are the walk to the
 *    second point, which begins at the confirmation. `isDisturbed()` is the commit options' `isDisturbed`; `shifted()`
 *    is the same without the clock, for a tier with no walk and for the moment after the modal's photo wait.
 *  - **Says whether the map is steady now** (`stable()`), for the moments a point is fixed in it: the
 *    confirmation and the commit, which the modal turns away, with `unstableText`, while it is not.
 *
 * ## What it does not do
 *
 * It does not make a tap more accurate than the map allows: a burst removes the jitter inside one tap and nothing
 * of a feature that sits off the surface in every frame, or of the person tapping a different spot next visit
 * (./tap-sampling.ts says so at length). It does not feed the burst's scatter into the noise figure a verdict is
 * judged by: that scatter is the jitter inside one tap, and `TAP_SIGMA0_M` (../world/baseline-guidance.ts) is how far
 * a tap lands from where it should between visits, which is what a verdict has to allow for and nothing has
 * measured. Both are for DX2 and DX5 to settle, and every limit here is adopted until they have.
 *
 * ## Debug flag
 *
 * `?tap=single` reads every tap with one hit, through the same tracking and range gates and the same datum: the
 * arm of DX2 (docs/testing/DEVICE_TESTING.md, Procedure 2) that the burst is compared against. It is not the burst
 * with the median taken out: there is no burst at all, so no outlier rejection, no scatter to refuse and no wait
 * for the phone to be held still. `?tap=floor` lets the floor ray set the position where the fit is reliable, which
 * is the arm DX5 needs to decide whether it should; the floor gate and the height warning between the two markers
 * still judge what the hits measured, not where the ray put the point. Neither is on by default.
 *
 * Pure: no DOM, no Deno, no provider of its own (ADR 0002: the browser and the Node tests import this file). The
 * ring and the note are painted onto whatever elements the modal hands over, through the few members of them that
 * are used.
 */
import {
  TAP_MIN_HITS,
  TAP_RANGE_MAX_M,
  TAP_SAME_SPOT_M,
  TAP_SPREAD_MAX_M,
  sampleTap,
  tapEvidence,
  tapLandmarkDatum,
  tapRefusalText,
  tapSurfaceY,
  type FloorRayUse,
  type TapInsist,
  type TapProgress,
  type TapProvider,
  type TapRefusal,
  type TapResult,
  type TapSample,
} from './tap-sampling.ts'
import type { GroundReading } from './ground-gate.ts'
import type { HitResult } from './provider.ts'
import type { RefusedTap, TapReader, TappedPoint } from './calibration-commit.ts'
import {
  TRACKING_RECOVERING_TEXT,
  placementDisturbedText,
  trackingIsStableForPlacement,
  watchLandmark,
  type LandmarkWatch,
  type PlacementDisturbance,
  type PlacementVerdict,
  type ShiftCounters,
} from './tracking-quality.ts'
import type { ProbeTapAnswer } from '../capture/probe-log.ts'
import type { TapEvidence } from '../world/calibration-evidence.ts'
import type { Vec3 } from '../world/types.ts'

// ── The debug flag ───────────────────────────────────────────────────────────

/**
 * How a calibration tap is read: `'sampled'`, a burst of hits (the default), `'single'`, one hit (DX2's comparison
 * arm), or `'floor'`, a burst whose position the floor ray sets where the fitted floor is reliable (DX5's arm).
 */
export type TapMode = 'sampled' | 'single' | 'floor'

/**
 * The tap mode a page asks for: `?tap=single` or `?tap=floor`. Anything else, including no `tap` at all, is the
 * default. The value is trimmed and compared in lower case, so a hand-typed URL is read as it was meant.
 */
export function tapModeFromSearch(search: string): TapMode {
  let value: string | null = null
  try {
    value = new URLSearchParams(search).get('tap')
  } catch {
    return 'sampled'
  }
  const asked = (value ?? '').trim().toLowerCase()
  return asked === 'single' || asked === 'floor' ? asked : 'sampled'
}

// ── The host's sampler ───────────────────────────────────────────────────────

/** What the flow adds to one tap's read: where the ring is told about it, and what the person insisted on. */
export interface TapExtra {
  onProgress?: (progress: TapProgress) => void
  /** The refused tap this one confirms, if it does (`SampleTapOptions.insist`). */
  insist?: TapInsist
  /** Overrides for the two limits, which only a probe lifts (`SampleTapOptions`). A person's way past a limit is `insist`. */
  spreadMaxM?: number
  rangeMaxM?: number
  /**
   * The floor reading the flow took before the tap, so that the floor ray and the floor height the tap gives the
   * frame come from one reading and not from two a refit apart. Absent: the sampler reads the floor itself.
   */
  floor?: GroundReading | null
}

/**
 * Reads one tap at normalised canvas coordinates. The host builds it (`calibrationTapSampler()`) and hands it to
 * `runProjectCalibration` as `sampleTap`; the probe after calibration reads its taps through the same one.
 */
export interface CalibrationTapSampler {
  (x: number, y: number, extra?: TapExtra): Promise<TapResult>
  /**
   * Whether a tap is read by holding the phone still for a burst of hits: false for `?tap=single` and for a
   * provider that has no burst, where the flow has no reason to ask the person to hold still. Absent, it does.
   */
  readonly holdsStill?: boolean
}

export interface TapSamplerDeps {
  /** The AR provider: what `sampleTap()` reads, and nothing else of it. */
  provider: TapProvider
  /**
   * The host's own hit test, for a provider whose synchronous one answers nothing. WebXR's does always, so the
   * host passes its asynchronous one; 8th Wall's is read directly.
   */
  singleHit?: (x: number, y: number) => Promise<HitResult | null>
  /** `pointCloud.groundEstimate()`: the fitted floor, read fresh for every tap. */
  ground: () => GroundReading | null
  /** The page's query string, for `?tap=`. */
  search?: string
}

/**
 * The provider as `sampleTap()` sees it when it must not run a burst: the same camera and the same status, and no
 * `hitTestBurstAsync`, so the tap is one hit through the host's hit test and the same gates.
 */
export function withoutBurst(provider: TapProvider): TapProvider {
  return {
    hitTest: (x, y) => provider.hitTest(x, y),
    getPose: () => provider.getPose(),
    getCameraFovY: () => provider.getCameraFovY(),
    getCameraAspect: () => provider.getCameraAspect(),
    trackingStatus: () => provider.trackingStatus(),
  }
}

/**
 * The sampler the host passes to the flow: `sampleTap(provider, x, y, {singleHit, floor, floorRay})`.
 *
 * The floor ray is a cross-check and ships as one (`'cross-check'`): the hits set the position and its distance from
 * the floor ray through the same pixel is reported beside it. `'prefer'`, where the ray sets the position, is only
 * `?tap=floor`, until DX5 has put a taped point against both (ADR 0005 rule 5: nothing here has measured the floor
 * ray, so nothing here trusts it).
 */
export function calibrationTapSampler(deps: TapSamplerDeps): CalibrationTapSampler {
  const mode = tapModeFromSearch(deps.search ?? '')
  const provider = mode === 'single' ? withoutBurst(deps.provider) : deps.provider
  const floorRay: FloorRayUse = mode === 'floor' ? 'prefer' : 'cross-check'
  const read = (x: number, y: number, extra: TapExtra = {}): Promise<TapResult> =>
    sampleTap(provider, x, y, {
      singleHit: deps.singleHit,
      floor: extra.floor !== undefined ? extra.floor : deps.ground(),
      floorRay,
      onProgress: extra.onProgress,
      insist: extra.insist,
      spreadMaxM: extra.spreadMaxM,
      rangeMaxM: extra.rangeMaxM,
    })
  return Object.assign(read, { holdsStill: typeof provider.hitTestBurstAsync === 'function' })
}

// ── The hold-still ring ──────────────────────────────────────────────────────

/** How far a burst has run, and whether the hits so far say the phone is being held still. */
export interface HoldRing {
  /** 0 to 1: how much of the burst's window has passed. */
  fraction: number
  /**
   * False when the hits so far scatter more than the limit the tap will be judged by. True otherwise, including
   * before there are enough hits to say: nothing has shown the hand move, and the ring does not say it did.
   */
  steady: boolean
}

/**
 * The ring for a burst's progress. `spreadMaxM` is the limit the hits are compared with, `TAP_SPREAD_MAX_M` unless a
 * caller says otherwise: the ring says what the hits so far show, which is the same whether or not the tap, if it
 * scatters, is later let past that limit by a person who insisted.
 */
export function holdRingFor(progress: TapProgress, spreadMaxM: number = TAP_SPREAD_MAX_M): HoldRing {
  const { elapsedMs, windowMs, hits, spreadM } = progress
  const fraction = windowMs > 0 ? Math.min(1, Math.max(0, elapsedMs / windowMs)) : 1
  const scattered = hits >= TAP_MIN_HITS && spreadM !== null && Number.isFinite(spreadM) && spreadM > spreadMaxM
  return { fraction: Number.isFinite(fraction) ? fraction : 0, steady: !scattered }
}

/** The part of an element the ring is drawn on: the card's `<div>` is one, and so is a test's plain object. */
export interface HoldRingTarget {
  /** `HTMLElement.hidden` is a boolean or one of two words, so the element's own type is what is asked for. */
  hidden: boolean | string
  dataset: Record<string, string | undefined>
  style: { background: string }
}

/**
 * Draws the ring, or hides it for `null`. A conic gradient sets how much is filled; the colour is the stylesheet's
 * (`--hold-ring`, per `data-state`), so the warning colour is a CSS decision and not a number in here.
 */
export function paintHoldRing(target: HoldRingTarget, ring: HoldRing | null): void {
  if (!ring) {
    target.hidden = true
    return
  }
  target.hidden = false
  target.dataset['state'] = ring.steady ? 'steady' : 'unsteady'
  target.style.background = `conic-gradient(var(--hold-ring, #72ddd4) ${Math.round(ring.fraction * 360)}deg, rgba(114, 221, 212, 0.18) 0)`
}

/** The part of an element the note about a tap that was used anyway is written on. */
export interface NoteTarget {
  hidden: boolean | string
  textContent: string | null
}

// ── What a person is told about a tap taken past a limit ─────────────────────

/**
 * The note for a tap the sampler let past a limit because the person insisted: what it measured, and the limit it
 * was over, so that it is never taken for an ordinary one. Null for a tap that was inside every limit, including one
 * that was insisted on and then read well. Two decimals for the range: a spot a few centimetres past the limit would
 * otherwise read, rounded, as at it.
 */
export function usedAnywayText(tap: TapSample): string | null {
  const parts: string[] = []
  if (tap.insisted?.includes('range')) {
    parts.push(`that spot is ${tap.rangeM.toFixed(2)} m away, over the ${TAP_RANGE_MAX_M} m limit`)
  }
  if (tap.insisted?.includes('spread') && tap.spreadM !== null) {
    parts.push(`its readings scattered ${(tap.spreadM * 100).toFixed(1)} cm, over the ${Number((TAP_SPREAD_MAX_M * 100).toFixed(1))} cm limit`)
  }
  return parts.length > 0 ? `Used anyway: ${parts.join(', and ')}.` : null
}

// ── The flow's side ──────────────────────────────────────────────────────────

/** What a refused tap that can be insisted on is told, after what was wrong with it. */
export const TAP_USE_ANYWAY_TEXT = 'Or tap the same spot again to use it anyway.'

/** What the status line says while a tap is read, with no sampler (the words the flow has always used). */
export const READING_TEXT = 'Reading the surface…'

/** What it says while a burst runs: the same, and the instruction the burst depends on. */
export const HOLD_STILL_READING_TEXT = 'Hold still, reading the surface…'

/** What the flow keeps of an accepted tap until the commit asks for it. */
interface MeasuredTap {
  evidence: TapEvidence
  /** The floor height the frame takes from this tap, session metres (`landmarkDatum().y`). */
  floorDatumY: number
  /** How high the hits measured, which is not the position's height when the floor ray placed it. */
  surfaceY: number
}

/** The spot a person may insist on: where the last refusal for a limit landed, and which limits have refused it there. */
interface RefusedSpot {
  position: Vec3
  spread: boolean
  range: boolean
}

/**
 * How many accepted taps are remembered. The landmark is one of the last few: a person who places and moves it a
 * handful of times is the long case, and the map is a few hundred bytes. Not a tuning figure.
 */
const REMEMBERED_TAPS = 32

/** The provider as the watch reads it: the counters of frame shifts, and the status a burst is not started in. */
export interface TapFlowProvider {
  trackingStatus?(): string
  getTrackingDiagnostics?(): (ShiftCounters & { reason?: string }) | undefined
}

export interface CalibrationTapsDeps {
  /** The host's sampler. Absent, the flow reads taps as it always did, and records nothing about how they were read. */
  sampler?: CalibrationTapSampler
  provider: TapFlowProvider
  /** `options.ground` of the flow: the fitted floor, for the floor height a tap gives the frame. */
  ground: () => GroundReading | null
  /**
   * Whether a landmark is placed and its commit is still to come: the landmark stage once a landmark is on the
   * map, and the heading, review and mismatch stages.
   */
  watching: () => boolean
  /** The element the hold-still ring is drawn on, asked for when it is drawn, so the flow may make it after this. */
  ring?: () => HoldRingTarget | null
  /** The element the note about a tap used anyway is written on, asked for when it is written. */
  note?: () => NoteTarget | null
  /** The clock the 90 seconds are counted on. Default `Date.now`, read at the time, so a test's fake clock is the one used. */
  now?: () => number
}

export interface CalibrationTaps {
  /** `resolveCommitOptions({ sampleTap })`. Undefined without a sampler. */
  read: TapReader | undefined
  /** What the status line says while a tap is read. */
  readingText: string
  /**
   * A landmark tap was just accepted in the landmark stage: the map is watched for a shift from here, so that one
   * that happens before the confirmation is seen at it. The clock is not started: the walk to the second point
   * begins at the confirmation.
   */
  landmarkPlaced(): void
  /** The landmark was just confirmed: the frame it is in is watched, and the clock run, from here until the commit. */
  landmarkConfirmed(): void
  /** The points were cleared: a note about the tap that placed one is about nothing now. */
  clearNote(): void
  /** `resolveCommitOptions({ isDisturbed })`. False until a landmark is placed, and outside the stages that wait for a commit. */
  isDisturbed(): boolean
  /**
   * Whether the map has shifted since the landmark was placed, with no regard to how long ago: `isDisturbed()` without
   * the clock. For a commit that has no walk to a second point, and for the moment after a wait the person did not choose.
   */
  shifted(): boolean
  /** What the person is told when `isDisturbed()` or `shifted()` has said yes. */
  disturbedText(): string
  /** Whether the map is steady enough, at this moment, to fix a point in it. */
  stable(): boolean
  /** What the person is told when it is not. */
  readonly unstableText: string
  /**
   * The landmark as the two-point frame is built from it: at the floor height its own tap gave
   * (`landmarkDatum()`), with the evidence of how that tap was measured. A point that no accepted tap placed, and a
   * flow with no sampler, give the point as it is and no evidence.
   */
  frameLandmark(landmark: Vec3 | null): { landmark: Vec3 | null; tap?: TapEvidence }
  /**
   * How far the height a tap measured, `tapped`, lies above the landmark's own, for the warning that one of the two
   * markers is probably not on the floor. Read from what the hits measured where a tap is remembered, and from the
   * point's own height where it is not (with no sampler: always), so it is the same number the flow always gave
   * except where the floor ray placed a tap and its height is the fitted floor's by construction. 0 with no landmark.
   */
  heightAboveLandmarkM(landmark: Vec3 | null, tapped: Vec3): number
}

function key(point: Vec3): string {
  return `${point.x}|${point.y}|${point.z}`
}

const distanceBetween = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** A call that must not take the flow down: a provider's accessor that throws says nothing. */
function quietly<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

export function createCalibrationTaps(deps: CalibrationTapsDeps): CalibrationTaps {
  const now = deps.now ?? (() => Date.now())
  const measured = new Map<string, MeasuredTap>()
  let watch: LandmarkWatch | null = null
  let disturbance: PlacementDisturbance | null = null
  let refusedSpot: RefusedSpot | null = null

  const paint = (ring: HoldRing | null): void => {
    const target = quietly(() => deps.ring?.() ?? null)
    if (target) quietly(() => paintHoldRing(target, ring))
  }

  const writeNote = (text: string | null): void => {
    const target = quietly(() => deps.note?.() ?? null)
    if (!target) return
    quietly(() => {
      target.textContent = text ?? ''
      target.hidden = text === null
    })
  }

  const stableNow = (): boolean => {
    const status = quietly(() => deps.provider.trackingStatus?.())
    const reason = quietly(() => deps.provider.getTrackingDiagnostics?.()?.reason)
    return trackingIsStableForPlacement(status, reason)
  }

  const refusalLine = (refusal: TapRefusal, canInsist: boolean): string =>
    canInsist ? `${tapRefusalText(refusal)} ${TAP_USE_ANYWAY_TEXT}` : tapRefusalText(refusal)

  /**
   * The spot the next tap may insist on after this refusal. Only a refusal for a limit that measured it, at a place
   * it can name, is one: not a map that moved, not a spot with no hits, not one whose hits mostly strayed. Two refusals
   * at one spot are one spot refused twice, for both of the limits it was refused for.
   */
  function spotRefused(refusal: TapRefusal, before: RefusedSpot | null): RefusedSpot | null {
    const at = refusal.position
    const scatter = refusal.reason === 'unsteady' && refusal.spreadM !== undefined
    const far = refusal.reason === 'too-far' && refusal.rangeM !== undefined
    if (!at || !(scatter || far)) return null
    const same = before !== null && distanceBetween(at, before.position) <= TAP_SAME_SPOT_M
    return { position: at, spread: scatter || (same && before.spread), range: far || (same && before.range) }
  }

  async function readOne(sampler: CalibrationTapSampler, x: number, y: number): Promise<TappedPoint | RefusedTap> {
    writeNote(null)
    // A burst started in a map that is not stable would be refused after its whole window. Say so now.
    if (!stableNow()) {
      refusedSpot = null
      return { refused: TRACKING_RECOVERING_TEXT }
    }

    const before = refusedSpot
    const floor = quietly(() => deps.ground()) ?? null
    try {
      const result = await sampler(x, y, {
        floor,
        onProgress: (progress) => paint(holdRingFor(progress)),
        ...(before ? { insist: { position: before.position, range: before.range, spread: before.spread } } : {}),
      })
      if (!result.ok) {
        refusedSpot = spotRefused(result, before)
        return { refused: refusalLine(result, refusedSpot !== null) }
      }
      refusedSpot = null
      const datum = tapLandmarkDatum(result, floor)
      measured.set(key(result.position), {
        evidence: tapEvidence(result, datum),
        floorDatumY: datum.y,
        surfaceY: tapSurfaceY(result),
      })
      if (measured.size > REMEMBERED_TAPS) measured.delete(measured.keys().next().value as string)
      writeNote(usedAnywayText(result))
      return { position: result.position, surfaceY: tapSurfaceY(result) }
    } finally {
      paint(null)
    }
  }

  /** The watch's verdict, where a commit is waiting on a landmark that is placed; null where nothing is. */
  const verdictNow = (): PlacementVerdict | null => (watch && deps.watching() ? watch.check() : null)

  const sampler = deps.sampler
  return {
    read: sampler ? (x, y) => readOne(sampler, x, y) : undefined,
    readingText: sampler && sampler.holdsStill !== false ? HOLD_STILL_READING_TEXT : READING_TEXT,
    landmarkPlaced() {
      disturbance = null
      // A clock that stands still: nothing placed here is late, and the 90 seconds begin at the confirmation.
      watch = watchLandmark(() => deps.provider.getTrackingDiagnostics?.(), () => 0)
    },
    landmarkConfirmed() {
      disturbance = null
      writeNote(null)
      watch = watchLandmark(() => deps.provider.getTrackingDiagnostics?.(), now)
    },
    clearNote: () => writeNote(null),
    isDisturbed() {
      const verdict = verdictNow()
      if (!verdict?.disturbed) {
        disturbance = null
        return false
      }
      disturbance = verdict.reason
      return true
    },
    shifted() {
      const verdict = verdictNow()
      if (!verdict?.disturbed || verdict.reason === 'too-long') {
        disturbance = null
        return false
      }
      disturbance = verdict.reason
      return true
    },
    disturbedText: () => placementDisturbedText(disturbance ?? 'pose-jump'),
    stable: stableNow,
    unstableText: TRACKING_RECOVERING_TEXT,
    frameLandmark(landmark) {
      const own = landmark ? measured.get(key(landmark)) : undefined
      if (!landmark || !own) return { landmark }
      return { landmark: { x: landmark.x, y: own.floorDatumY, z: landmark.z }, tap: own.evidence }
    },
    heightAboveLandmarkM(landmark, tapped) {
      if (!landmark) return 0
      const heightOf = (point: Vec3): number => measured.get(key(point))?.surfaceY ?? point.y
      return heightOf(tapped) - heightOf(landmark)
    },
  }
}

// ── The probe after calibration ──────────────────────────────────────────────

/**
 * Which limit a tap that was read, but with the limits lifted, would have been refused for: the range first, as the
 * sampler checks it, then the scatter. Null for a tap that is inside both. The limits are the sampler's own
 * (`TAP_RANGE_MAX_M`, `TAP_SPREAD_MAX_M`), so the answer is the one a calibration tap at this spot would have got.
 */
export function limitRefusal(tap: TapSample): 'too-far' | 'unsteady' | null {
  if (!(tap.rangeM <= TAP_RANGE_MAX_M)) return 'too-far'
  if (tap.spreadM !== null && tap.spreadM > TAP_SPREAD_MAX_M) return 'unsteady'
  return null
}

/**
 * A tap read through the sampler, as the probe line (../capture/probe-log.ts) logs it: the point and its range as a
 * hit, and what the read found out about it. A tap the sampler read with the limits lifted keeps its point whatever
 * the limits would have said, and says in `refused` what they would have (`limitRefusal()`); a tap the sampler could
 * not place at all has no hit, and says why, with the scatter or the range that refused it where there was one:
 * those are the numbers a limit is set from.
 */
export function probeAnswerOf(result: TapResult): ProbeTapAnswer {
  if (!result.ok) {
    return {
      hit: null,
      sample: {
        kept: result.n,
        spreadM: result.spreadM ?? null,
        source: null,
        floorRayDeltaM: null,
        refused: result.reason,
        rangeM: result.rangeM ?? null,
      },
    }
  }
  return {
    hit: { position: result.position, distance: result.rangeM },
    sample: {
      kept: result.n,
      spreadM: result.spreadM,
      source: result.source,
      floorRayDeltaM: result.floorRay?.deltaM ?? null,
      refused: limitRefusal(result),
      rangeM: null,
    },
  }
}

/**
 * What the probe reads its taps with: the calibration's own sampler, the limits lifted. A probe tap is a measurement,
 * not a placement, and the long-range taps and the 5 m runs of DX5 are measurements of exactly the spots the limits
 * turn a calibration away from; reading them through the limits would log nothing where it matters. The line keeps the
 * point and says what the limits would have said (`probeAnswerOf`), so a tap the calibration would have refused is one
 * that can be told apart and not one that is missing.
 */
export function probeTapReader(sampler: CalibrationTapSampler): (x: number, y: number) => Promise<ProbeTapAnswer> {
  return async (x, y) =>
    probeAnswerOf(await sampler(x, y, { spreadMaxM: Number.POSITIVE_INFINITY, rangeMaxM: Number.POSITIVE_INFINITY }))
}
