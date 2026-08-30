/**
 * The known-distance calibration tier — a metre stick for a capture that never
 * ran an AR runtime.
 *
 * splat_align.ts's Umeyama fit needs two descriptions of one camera path: the
 * solver's, and a metric one. The metric one has always come from capture-time
 * AR poses carried through `ScanCalibration.sessionToProject`. A tripod-station
 * capture (`station_dome.ts`) has none — that is the whole reason it exists, the
 * test phone has no ARCore — and an uploaded video has none either. Those
 * captures reconstruct perfectly well and then sit at an arbitrary size forever,
 * which makes every distance, every object placement and every merge with a
 * second visit meaningless.
 *
 * One physically measured length fixes that, because a monocular solve is a
 * *similarity* of reality, not merely something similar to it: measured on the
 * five-station capture in `scans/sessions/sess-video-20260830-163024`, whose
 * ground-truth camera positions are known, a Umeyama fit of all 36 solved
 * centres onto truth has an RMS of 0.000433 m. At that fidelity a single
 * distance determines the scale of the entire reconstruction, and the ten
 * inter-station distances it was never given come back with an RMS error of
 * 0.00012 m (see the measurements in tests/unit/deno/known_distance.test.ts,
 * which run against that session).
 *
 * ── What one distance does and does not buy ────────────────────────────────
 *
 * Scale:   fully determined.  metres ÷ solved separation.
 * Up:      determined *only* if the solve found gravity and rotated onto it,
 *          which `ColmapPosesManifest.gravityAligned` records and
 *          {@link readSolveGravity} reads. Never assumed.
 * Heading: free. A single length says nothing about which way the room faces,
 *          and this module does not invent one — an unrecorded guess here would
 *          reappear as a confidently mis-rotated room in every downstream
 *          placement. The World Editor's two-point flow is what settles it.
 * Origin:  free, in the same way. The frame is anchored at the first measured
 *          viewpoint so that re-solving the same capture (which moves the
 *          solver's own zero somewhere else entirely) lands on a comparable
 *          frame — reproducibility, not meaning.
 *
 * `SplatAlignManifest.determined` is where those four facts are published, and
 * they are what a consumer must branch on before treating the transform as a
 * placement rather than a size.
 *
 * Per ADR 0001 this reuses rather than reinvents: the metric frame is a
 * `ScanCalibration` variant, not a new calibration shape; the solved centres
 * arrive from splat_align's `sfmCentresFromPoses` over
 * `readSolvedPoses`; the tolerance is `DEFAULT_SEPARATION_TOLERANCE_M`, the
 * same number the two-point tier judges a separation with; and the viewpoint
 * grouping reads the `station` field `station_dome.ts` already documents, which
 * the keyframe upload route spreads into keyframes.jsonl verbatim.
 */

import { DEFAULT_SEPARATION_TOLERANCE_M } from '../../src/world/geo.ts'
import type { ScanCalibration } from '../../src/world/types.ts'
import type { ColmapPosesManifest } from '../../src/world/manifests.ts'
import type { KeyframeRecord } from '../splat/splat_train_dataset.ts'
import type { Vec3Tuple } from '../splat/splat_align.ts'

/**
 * Frames below this in a viewpoint group and the group is not a measurement.
 *
 * Two is the first count at which the scatter of the group's frames about their
 * own centre is a measured quantity rather than 0 by construction — the same
 * reasoning `DEFAULT_MIN_CORRESPONDENCES` uses in splat_align.ts, one dimension
 * down. It is a floor on *evidence*, not a capture guideline: `station_dome.ts`
 * separately wants `MIN_FRAMES_PER_STATION` (4) for a dome worth solving, and a
 * capture that clears that clears this many times over.
 */
export const MIN_FRAMES_PER_VIEWPOINT = 2

/** Prefix of the viewpoint ids {@link viewpointsFromKeyframes} produces. */
export const STATION_VIEWPOINT_PREFIX = 'station-'

/** A set of keyframes the operator says were all shot from one physical spot. */
export interface Viewpoint {
  /** Stable within a session; `station-0`, `station-1`, … for a tripod capture. */
  id: string
  /** Keyframe filenames, in capture order. */
  files: string[]
}

/** One tape reading: "these two viewpoints are this many metres apart". */
export interface DistanceMeasurement {
  from: string
  to: string
  metres: number
}

export interface KnownDistanceInput {
  /** Solved camera centres by keyframe filename — splat_align's `sfmCentresFromPoses`. */
  centres: Map<string, Vec3Tuple>
  viewpoints: Viewpoint[]
  /** At least one. Two spanning *different* pairs of viewpoints is what makes `'verified'` reachable. */
  measurements: DistanceMeasurement[]
  /** From the solve's own manifest — see {@link readSolveGravity}. Never defaulted to true. */
  gravityAligned: boolean
  /** Max disagreement, in metres, this frame may show and still be published. */
  toleranceM?: number
  /** Refuse a viewpoint backed by fewer frames. Default {@link MIN_FRAMES_PER_VIEWPOINT}. */
  minFramesPerViewpoint?: number
  /** Stamped into the calibration record. Defaults to now. */
  calibratedAt?: string
}

export interface KnownDistanceFrame {
  ok: true
  calibration: Extract<ScanCalibration, { method: 'known-distance' }>
  /** Multiply a solve-space length by this to get metres. */
  scale: number
  /** See `SplatAlignManifest.residualSource` — the two cases are not the same measurement. */
  residualM: number
  residualSource: 'known-distance-cross-check' | 'viewpoint-scatter'
  /** Always measured, and always the residual when only one distance was given. */
  viewpointScatterM: number
  /** The first measurement, and the separation it corresponded to in solve units. */
  measuredM: number
  solvedSeparation: number
  measurementCount: number
  /** Solved camera centres backing the referenced viewpoints. */
  frameCount: number
}

export interface KnownDistanceRefusal {
  ok: false
  /** One sentence, in the words of someone standing in the room. */
  reason: string
  remediation: string
}

export type KnownDistanceResult = KnownDistanceFrame | KnownDistanceRefusal

/**
 * Group a session's keyframes into viewpoints by their `station` index.
 *
 * The integer/non-negative rule is `summarizeStationCoverage`'s, deliberately
 * spelled the same way: a float or a string in that field means the capture
 * tool wrote something *else* there, and coercing it would invent a viewpoint
 * out of a bug. It is repeated rather than imported because that function
 * parses raw JSONL and this one takes records `readKeyframes` already parsed —
 * one parse, two readers, not two parses.
 *
 * A session whose frames carry no `station` yields no viewpoints, which is the
 * honest answer for a walkthrough video: it has no repeated fixed spots, so
 * there is nothing for a tape measure to span. That refusal is
 * {@link solveKnownDistanceFrame}'s to make, not this function's.
 */
export function viewpointsFromKeyframes(records: KeyframeRecord[]): Viewpoint[] {
  const byStation = new Map<number, string[]>()
  for (const rec of records) {
    const file = rec.file
    if (typeof file !== 'string' || !file) continue
    const raw = (rec as Record<string, unknown>)['station']
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) continue
    const files = byStation.get(raw) ?? []
    files.push(file)
    byStation.set(raw, files)
  }
  return [...byStation.keys()]
    .sort((a, b) => a - b)
    .map((station) => ({ id: `${STATION_VIEWPOINT_PREFIX}${station}`, files: byStation.get(station)! }))
}

/**
 * Whether the camera solve established a vertical, read from its own manifest.
 *
 * Only COLMAP records this: `colmap_poses.ts` estimates an up axis from the
 * camera orientations and, when it finds one, rotates poses *and* points onto
 * +Y before writing them, then reports `gravityAligned`. LingBot-Map's manifest
 * has no equivalent field and its output is not rotated, so a LingBot-only
 * session correctly comes back `false` — absent evidence is not evidence of an
 * upright frame, and treating it as one tilts every measurement taken off the
 * result by an unknown angle.
 */
export async function readSolveGravity(sessionDir: string): Promise<boolean> {
  let raw: string
  try {
    raw = await Deno.readTextFile(`${sessionDir}/colmap-poses.manifest.json`)
  } catch {
    return false
  }
  try {
    const manifest = JSON.parse(raw) as ColmapPosesManifest
    return manifest.status === 'ok' && manifest.gravityAligned === true
  } catch {
    return false
  }
}

/**
 * Build the metric frame one or more measured distances determine, or say why
 * one cannot be built.
 *
 * Every refusal below is a state the operator can act on, and none of them is
 * an approximation that got waved through: a scale that is wrong is worse than
 * a scale that is absent, because everything downstream trusts it silently.
 */
export function solveKnownDistanceFrame(input: KnownDistanceInput): KnownDistanceResult {
  const toleranceM = input.toleranceM ?? DEFAULT_SEPARATION_TOLERANCE_M
  const minFrames = input.minFramesPerViewpoint ?? MIN_FRAMES_PER_VIEWPOINT

  if (input.measurements.length === 0) {
    return {
      ok: false,
      reason: 'no measured distance was supplied, so nothing says how big this capture is',
      remediation:
        'Measure the real distance between two of the spots the camera stood at, and record it against those two spots.',
    }
  }

  // Viewpoint centres. A viewpoint the solve did not place at all is a
  // different failure from one it placed badly, so it is named separately.
  const centres = new Map<string, Vec3Tuple>()
  const counts = new Map<string, number>()
  const scatterSamples = new Map<string, Vec3Tuple[]>()
  for (const vp of input.viewpoints) {
    const solved: Vec3Tuple[] = []
    for (const file of vp.files) {
      const c = input.centres.get(file)
      if (c && c.every(Number.isFinite)) solved.push(c)
    }
    if (solved.length === 0) continue
    centres.set(vp.id, centroid(solved))
    counts.set(vp.id, solved.length)
    scatterSamples.set(vp.id, solved)
  }

  const referenced = new Set<string>()
  for (const m of input.measurements) {
    referenced.add(m.from)
    referenced.add(m.to)
  }

  for (const id of referenced) {
    if (!centres.has(id)) {
      return {
        ok: false,
        reason: `the camera solve placed no frames at ${describe(id)}, so it cannot be one end of a measured distance`,
        remediation:
          'Check that the measurement names spots this capture actually recorded, and that the solve covered them — a solve that dropped frames leaves some spots unplaced.',
      }
    }
    const n = counts.get(id) ?? 0
    if (n < minFrames) {
      return {
        ok: false,
        reason:
          `${describe(id)} rests on ${n} solved frame(s); ${minFrames} are needed before it is a spot ` +
          'rather than a single reading with nothing to check it against',
        remediation:
          'Re-capture that spot with more frames, or re-run the camera solve so it places more of the ones already taken.',
      }
    }
  }

  // Least-squares single scale over every supplied distance: minimising
  // Σ(s·lᵢ − dᵢ)² gives s = Σ(dᵢlᵢ)/Σ(lᵢ²). With one distance it collapses to
  // d/l — the exact answer, which is the point of the tier — and with several
  // it is the one scale that best explains all of them at once.
  let num = 0
  let den = 0
  const solvedLengths: number[] = []
  for (const m of input.measurements) {
    if (!(m.metres > 0) || !Number.isFinite(m.metres)) {
      return {
        ok: false,
        reason: `a measured distance of ${m.metres} metres cannot size anything`,
        remediation: 'Record the distance between the two spots as a positive number of metres.',
      }
    }
    const l = distance(centres.get(m.from)!, centres.get(m.to)!)
    if (!(l > 0)) {
      return {
        ok: false,
        reason:
          `the camera solve put ${describe(m.from)} and ${describe(m.to)} in the same place, ` +
          'so the distance between them cannot be used to size the capture',
        remediation:
          'Measure between two spots the camera really moved between — the tripod has to travel between them for the solve to tell them apart.',
      }
    }
    solvedLengths.push(l)
    num += m.metres * l
    den += l * l
  }
  const scale = num / den
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return {
      ok: false,
      reason: `the measured distances resolve to a size factor of ${scale}, which cannot size anything`,
      remediation: 'Check the recorded distances and re-run the calibration.',
    }
  }

  // The two measurements. Both are in metres, and both are real: neither is a
  // constant standing in for a check that never ran.
  let crossSq = 0
  for (let i = 0; i < input.measurements.length; i++) {
    const err = scale * solvedLengths[i] - input.measurements[i].metres
    crossSq += err * err
  }
  const crossCheckM = Math.sqrt(crossSq / input.measurements.length)

  let scatterSq = 0
  let frameCount = 0
  for (const id of referenced) {
    const samples = scatterSamples.get(id)!
    const c = centres.get(id)!
    for (const p of samples) {
      const d = distance(p, c) * scale
      scatterSq += d * d
      frameCount += 1
    }
  }
  const viewpointScatterM = Math.sqrt(scatterSq / frameCount)

  // With one distance the cross-check is 0 by construction — the scale was
  // fitted to it — so it is not evidence and must not be published as if it
  // were. The scatter is, and it is the one that fails loudly when the frames
  // grouped under a spot were not all shot from it.
  //
  // Counting *measurements* here is not enough, and the difference is not
  // hypothetical: the same pair supplied twice (or once each way round —
  // `station-0`→`station-1` and `station-1`→`station-0`, which any two-field
  // form can produce) is a single constraint written twice. The least-squares
  // scale absorbs it exactly, so `crossCheckM` comes back 0 on the real
  // five-station capture and the frame was published `'verified'` with a
  // residual of 0 — the identical zero-by-construction the paragraph above
  // refuses to treat as evidence. Redundancy is a second *pair*, not a second
  // row, so that is what is counted.
  const distinctPairs = new Set(input.measurements.map((m) => [m.from, m.to].sort().join('\u0000')))
  const hasCrossCheck = distinctPairs.size >= 2
  const residualM = hasCrossCheck ? crossCheckM : viewpointScatterM
  const residualSource = hasCrossCheck ? 'known-distance-cross-check' as const : 'viewpoint-scatter' as const

  if (!(viewpointScatterM <= toleranceM)) {
    return {
      ok: false,
      reason:
        `the frames grouped under one spot land ${viewpointScatterM.toFixed(2)}m apart from it on average, ` +
        `past the ${toleranceM}m limit — they were not all shot from the same place, so the measured distance ` +
        'does not describe what it is being applied to',
      remediation:
        'Check that each frame is labelled with the spot it was actually taken from, and that the tripod did not move mid-sweep.',
    }
  }
  // Gated on the row count, not on `hasCrossCheck`: two readings of the *same*
  // pair are not redundancy worth calling verified, but if they disagree they
  // still contradict each other, and averaging a contradiction into a size is
  // exactly the silent-wrong-scale failure this module exists to refuse.
  if (input.measurements.length >= 2 && !(crossCheckM <= toleranceM)) {
    return {
      ok: false,
      reason:
        `the measured distances disagree with each other by ${crossCheckM.toFixed(2)}m once the capture is sized, ` +
        `past the ${toleranceM}m limit — no single size explains them all`,
      remediation:
        'Re-measure the distances between the spots; one of the tape readings, or one of the spots it was recorded against, is wrong.',
    }
  }

  // Anchor at the first measurement's `from` spot. See the header: this buys
  // reproducibility across re-solves, not meaning — the frame's origin and its
  // heading are both still arbitrary, which is what `determined` publishes.
  const anchor = centres.get(input.measurements[0].from)!
  const sessionToProject = columnMajorScaleAbout(scale, anchor)

  return {
    ok: true,
    calibration: {
      method: 'known-distance',
      sessionToProject,
      calibratedAt: input.calibratedAt ?? new Date().toISOString(),
      // A second agreeing distance across a different pair of spots is the same
      // kind of evidence the two-point tier calls verified: a measurement the
      // frame did not get to fit, which it then predicted inside tolerance. One
      // distance can never reach it, and neither can the same one written twice.
      status: hasCrossCheck ? 'verified' : 'provisional',
      separationM: input.measurements[0].metres,
      residualM,
      toleranceM,
      gravityAligned: input.gravityAligned,
    },
    scale,
    residualM,
    residualSource,
    viewpointScatterM,
    measuredM: input.measurements[0].metres,
    solvedSeparation: solvedLengths[0],
    measurementCount: input.measurements.length,
    frameCount,
  }
}

/**
 * A uniform scale about `anchor`, in the **column-major** layout
 * `ScanCalibration.sessionToProject` is specified as (translation at 12/13/14,
 * the THREE.Matrix4 convention `composeYUpTransform` writes).
 *
 * The rotation block is the identity in both the gravity-aligned and the
 * gravity-unknown case, for different reasons: aligned, the solve already put
 * +Y up and there is nothing left to rotate; unknown, there is no up to rotate
 * onto and inventing one would tilt every later measurement by a made-up angle.
 * The two cases are told apart by `gravityAligned`, never by the matrix.
 */
export function columnMajorScaleAbout(scale: number, anchor: Vec3Tuple): number[] {
  return [
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    -scale * anchor[0], -scale * anchor[1], -scale * anchor[2], 1,
  ]
}

/** `station-2` → `the spot labelled 2`. Ids are internal; the sentence is not. */
function describe(viewpointId: string): string {
  if (viewpointId.startsWith(STATION_VIEWPOINT_PREFIX)) {
    return `the spot labelled ${viewpointId.slice(STATION_VIEWPOINT_PREFIX.length)}`
  }
  return `the spot "${viewpointId}"`
}

function centroid(points: Vec3Tuple[]): Vec3Tuple {
  const c: Vec3Tuple = [0, 0, 0]
  for (const p of points) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  return [c[0] / points.length, c[1] / points.length, c[2] / points.length]
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
