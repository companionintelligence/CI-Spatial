/**
 * How good the splat that just trained actually is.
 *
 * Same shape, same words and the same reasoning as
 * `ColmapReconstructionQuality` in server/colmap/colmap_poses.ts — read that
 * file's doc comment first; this is the splat-stage member of the same verdict
 * family and deliberately not a second vocabulary (ADR 0001). `degenerate` is
 * the one boolean a caller must check, `status` reuses `ScanReviewStatus`,
 * `reasons` are codes so a caller can branch without parsing prose, and
 * `thresholds` is carried along so a manifest explains its own verdict.
 *
 * Why the splat stage needs its own verdict at all: a splat trained from a bad
 * reconstruction still writes a large, healthy-looking PLY. The two runs
 * measured here (sess-video-20260830-054518, 253,021 gaussians, 38.5 MB;
 * sess-video-20260830-033839, 246,838 gaussians, 37.5 MB) are indistinguishable
 * from a hypothetical ruined one by count and file size — those measure how
 * long densification ran, not whether the result describes a room. Nothing
 * downstream could tell, which is the same hole `quality` closed for COLMAP.
 *
 * ## Why the raw bounding box is reported but never gated
 *
 * Measured on this box, on the two *healthy* runs above, against their own
 * COLMAP seed clouds:
 *
 *   run                       seed diag   splat diag   trimmed diag   ratio(raw)  ratio(trimmed)
 *   sess-video-…-054518         29.10       84.96         30.00          2.92         1.135
 *   sess-video-…-033839         30.70      210.90         38.46          6.87         1.370
 *
 * Both splats are fine. Their raw extents are 2.9x and 6.9x the reconstruction
 * they were seeded from, because 3DGS densification leaves a thin tail of
 * enormous low-opacity gaussians behind the cameras — under 1.3% of the
 * gaussians sit outside the seed box even inflated only 1.5x. So a gate on the
 * raw extent would reject both. `CentreStats.trimmedSize` (the outer 0.5% per
 * axis discarded) is what tracks the room, and it is what every ratio here is
 * computed from. The raw box and `outlierSpread` stay on the manifest as facts,
 * because "this splat has a 200-unit tail" is worth seeing — it is just not
 * evidence of failure.
 *
 * ## Why there are two extent gates, not one
 *
 * A splat's extent can only be judged against something, and which something is
 * available depends on where the poses came from:
 *
 *   - Poses solved by COLMAP or LingBot-Map are scale-free. Their units are not
 *     metres and no threshold in metres means anything against them — the
 *     054518 seed cloud measures 20.7 x 10.8 x 17.4 in a room that is nothing
 *     like 20 m across. What IS meaningful is the ratio to the seed cloud, which
 *     is scale-invariant: both are in the same arbitrary frame.
 *   - Capture-time device poses (WebXR/8th Wall) ARE metric, and such a session
 *     often has no seed cloud at all (sess-a7e2f642's dataset has 17 posed
 *     frames and no `ply_file_path`), so there is nothing to take a ratio
 *     against — but the absolute metre check the repo already uses for scan
 *     GLBs applies directly.
 *
 * Applying either check to the other kind of session is the mistake this file
 * exists to avoid: it is the same error as testing a scale-free SfM pose
 * against a metre depth window, which is why the panoptic lift places nothing
 * on these captures.
 */

import type { ScanReviewStatus } from '../../src/world/types.ts'
import type { CentreStats } from './splat_ply_stats.ts'
import { centreStats, fractionOutside, readPlyCentres } from './splat_ply_stats.ts'

/** Why a splat was judged degenerate. Codes, so a caller can branch without parsing prose. */
export type SplatQualityReason =
  | 'no-gaussians'
  | 'too-few-gaussians'
  | 'truncated-ply'
  | 'sprawls-beyond-seed'
  | 'mass-outside-seed'
  | 'implausible-room-size'
  | 'degenerate-poses'

/**
 * Which frame the gaussian centres are expressed in, and therefore which
 * extent check can be applied at all. 'unknown' when the dataset builder did
 * not say — a manifest written before this field existed — and it disables
 * BOTH extent gates rather than guessing one.
 */
export type SplatScaleFrame = 'metric' | 'sfm-relative' | 'unknown'

export interface SplatQualityThresholds {
  minGaussians: number
  /** Trimmed splat diagonal ÷ trimmed seed diagonal, above which the splat sprawls. */
  maxExtentRatio: number
  /** How much the seed box is inflated before asking what fell outside it. */
  seedBoxInflation: number
  /** Fraction of centres allowed outside that inflated box. */
  maxOutsideSeedFraction: number
  /** Metre extent on any single axis, applied only to metric captures. */
  maxRoomExtentM: number
}

export interface SplatQuality {
  gaussianCount: number
  scaleFrame: SplatScaleFrame
  /** Trimmed extent of the gaussian centres, in whatever units `scaleFrame` names. */
  extent: [number, number, number]
  /** Untrimmed extent, and `rawDiagonal / trimmedDiagonal`. Reported, never gated. */
  rawExtent: [number, number, number]
  outlierSpread: number
  /** Trimmed splat diagonal ÷ trimmed seed diagonal. Absent when there was no seed cloud. */
  extentRatio?: number
  /** Trimmed extent of the seed cloud, so the ratio above can be checked by hand. */
  seedExtent?: [number, number, number]
  /** Share of centres outside the inflated seed box. Absent when there was no seed cloud. */
  outsideSeedFraction?: number
  /**
   * The one flag a caller must check before treating the splat as usable.
   * Derived, never set independently — exactly as in
   * `ColmapReconstructionQuality`, and for the same reason: a boolean cannot be
   * got wrong by comparing against the wrong string literal.
   */
  degenerate: boolean
  status: ScanReviewStatus
  reasons: SplatQualityReason[]
  thresholds: SplatQualityThresholds
}

/**
 * Gaussians below which the file is not a reconstruction of anything.
 *
 * Not a measured boundary and not meant to be one: the two real runs land at
 * 253,021 and 246,838, i.e. two and a half orders of magnitude clear, and there
 * is no run on record anywhere near it. It is set where it can only ever fire
 * on the unambiguous case — the same role `DEFAULT_MIN_POINTS_3D` plays for
 * COLMAP, and the same reason it is 100 rather than something fitted.
 * Override with SPLAT_MIN_GAUSSIANS.
 */
export const DEFAULT_MIN_GAUSSIANS = 1000

/**
 * Trimmed extent ratio above which the splat is not describing the seed's room.
 *
 * A diagonal ratio of 2 is a body EIGHT times the reconstruction's volume. The
 * two healthy runs sit at 1.135 and 1.370, so this has real headroom and, like
 * every threshold in this file, only catches the unambiguous case. Two runs is
 * not a measurement of a boundary and pretending otherwise would be the
 * dishonesty these gates exist to stop (ADR 0005 rule 5), so the number is
 * overridable — SPLAT_MAX_EXTENT_RATIO — and should be re-derived once enough
 * splats have been judged usable/unusable by eye to plot it.
 */
export const DEFAULT_MAX_EXTENT_RATIO = 2.0

/**
 * How far the seed box is grown before counting what fell outside, and how much
 * is allowed to.
 *
 * The seed cloud is sparse — COLMAP triangulates texture, not bare wall — so a
 * good splat reaches past it and an uninflated box would score a healthy run as
 * floater-ridden. At 1.5x, the two healthy runs put 0.5% and 1.1% of their
 * gaussians outside. The 25% allowance is therefore ~20x the observed healthy
 * value and means something in its own right: a quarter of the splat's mass
 * being nowhere near the reconstruction is not a splat of that room.
 */
export const DEFAULT_SEED_BOX_INFLATION = 1.5
export const DEFAULT_MAX_OUTSIDE_SEED_FRACTION = 0.25

/**
 * Metre extent that stops being a room, for metric captures only.
 *
 * 30 m is not a new tolerance: it is `ROOM_EXTENT_SANITY_M` from
 * scripts/audit-scan-glb.mjs, which already applies it to a scan's point cloud
 * with the same reasoning ("a room-sized capture that reports a 60 m extent is
 * not a big room, it is drift"). ADR 0001 says reuse it rather than pick a
 * second number for the same judgement. Override with SPLAT_MAX_ROOM_EXTENT_M.
 */
export const DEFAULT_MAX_ROOM_EXTENT_M = 30

export function resolveSplatQualityThresholds(): SplatQualityThresholds {
  return {
    minGaussians: numFromEnv('SPLAT_MIN_GAUSSIANS', DEFAULT_MIN_GAUSSIANS),
    maxExtentRatio: numFromEnv('SPLAT_MAX_EXTENT_RATIO', DEFAULT_MAX_EXTENT_RATIO),
    seedBoxInflation: DEFAULT_SEED_BOX_INFLATION,
    maxOutsideSeedFraction: numFromEnv('SPLAT_MAX_OUTSIDE_SEED_FRACTION', DEFAULT_MAX_OUTSIDE_SEED_FRACTION),
    maxRoomExtentM: numFromEnv('SPLAT_MAX_ROOM_EXTENT_M', DEFAULT_MAX_ROOM_EXTENT_M),
  }
}

export interface SplatQualityInput {
  splat: CentreStats
  /** Absent when the session had no seed cloud — then no ratio is computed. */
  seed?: CentreStats | null
  /** Share of centres outside the inflated seed box, from `fractionOutside`. */
  outsideSeedFraction?: number
  scaleFrame: SplatScaleFrame
  /**
   * The pose solve's own verdict, when the session has one on disk.
   *
   * Inherited rather than re-derived: this is the single most useful thing to
   * know about a splat, and the splat stage cannot measure it — a 3-of-17
   * solve produces a PLY as large and as well-formed as a 48-of-48 one. Only
   * `degenerate` is taken; the reasons stay in the solve's own manifest where
   * they were measured.
   */
  poseQuality?: { degenerate?: boolean } | null
}

/**
 * Judge a finished splat. Pure, so the thresholds can be exercised directly.
 *
 * As in `assessColmapQuality`, only 'ready' and 'needs-rescan' come out of
 * this. A 'needs-review' band would need a run that landed between a good splat
 * and a ruined one, and there is none on record — so the value stays in the
 * union (it is `ScanReviewStatus`'s, not ours) and reaching it needs evidence,
 * not a type change.
 */
export function assessSplatQuality(
  input: SplatQualityInput,
  thresholds: SplatQualityThresholds = resolveSplatQualityThresholds(),
): SplatQuality {
  const { splat, seed } = input
  const reasons: SplatQualityReason[] = []

  if (splat.count === 0) reasons.push('no-gaussians')
  else if (splat.count < thresholds.minGaussians) reasons.push('too-few-gaussians')

  // A short body means the writer was interrupted. Everything measured below is
  // then measured on a fragment, so say so rather than judge the fragment.
  if (splat.count < splat.declaredCount) reasons.push('truncated-ply')

  let extentRatio: number | undefined
  if (seed && seed.trimmedDiagonal > 0 && splat.count > 0) {
    extentRatio = round3(splat.trimmedDiagonal / seed.trimmedDiagonal)
    // Scale-free by construction (both clouds share the solver's frame), so
    // this is the check that applies to an SfM-posed session — and the only
    // one that can, since its units are not metres.
    if (extentRatio > thresholds.maxExtentRatio) reasons.push('sprawls-beyond-seed')
  }

  const outsideSeedFraction = input.outsideSeedFraction !== undefined
    ? round3(input.outsideSeedFraction)
    : undefined
  if (outsideSeedFraction !== undefined && outsideSeedFraction > thresholds.maxOutsideSeedFraction) {
    reasons.push('mass-outside-seed')
  }

  // Metres only. On a scale-free frame this comparison is meaningless, and
  // running it anyway is exactly the error described in this file's header.
  if (input.scaleFrame === 'metric' && splat.count > 0) {
    if (Math.max(...splat.trimmedSize) > thresholds.maxRoomExtentM) reasons.push('implausible-room-size')
  }

  if (input.poseQuality?.degenerate) reasons.push('degenerate-poses')

  const degenerate = reasons.length > 0
  return {
    gaussianCount: splat.count,
    scaleFrame: input.scaleFrame,
    extent: splat.trimmedSize.map(round3) as [number, number, number],
    rawExtent: splat.size.map(round3) as [number, number, number],
    outlierSpread: round3(splat.outlierSpread),
    ...(extentRatio !== undefined ? { extentRatio } : {}),
    ...(seed ? { seedExtent: seed.trimmedSize.map(round3) as [number, number, number] } : {}),
    ...(outsideSeedFraction !== undefined ? { outsideSeedFraction } : {}),
    degenerate,
    status: degenerate ? 'needs-rescan' : 'ready',
    reasons,
    thresholds,
  }
}

/**
 * Say what is wrong with the splat in the words of someone who walked the room.
 *
 * Mirrors `degenerateRemediation` in colmap_poses.ts, including its judgement
 * that "structure-from-motion failed to converge" is true and useless. Every
 * branch here ends in something the operator can do, because the only person
 * who can fix any of these is the one holding the phone.
 */
export function degenerateSplatRemediation(quality: SplatQuality): string {
  const facts: string[] = []
  if (quality.reasons.includes('no-gaussians')) {
    facts.push('the trainer produced a file with no 3D detail in it at all')
  }
  if (quality.reasons.includes('too-few-gaussians')) {
    facts.push(
      `the result holds only ${quality.gaussianCount} pieces of 3D detail ` +
        `(a usable room scan runs to hundreds of thousands)`,
    )
  }
  if (quality.reasons.includes('truncated-ply')) {
    facts.push('the result file is incomplete — it stops part-way through')
  }
  if (quality.reasons.includes('sprawls-beyond-seed') && quality.extentRatio !== undefined) {
    facts.push(
      `the 3D detail spreads ${quality.extentRatio.toFixed(1)}x wider than the room the ` +
        'photos actually reconstructed',
    )
  }
  if (quality.reasons.includes('mass-outside-seed') && quality.outsideSeedFraction !== undefined) {
    facts.push(
      `${Math.round(quality.outsideSeedFraction * 100)}% of the 3D detail sits outside the room entirely`,
    )
  }
  if (quality.reasons.includes('implausible-room-size')) {
    facts.push(
      `the scan measures ${quality.extent.map((n) => n.toFixed(1)).join(' x ')} m, which is bigger ` +
        'than the room it was taken in',
    )
  }
  if (quality.reasons.includes('degenerate-poses')) {
    // The pose solve already wrote a remediation aimed at this operator; do not
    // re-derive or paraphrase its numbers here — say which one to read.
    facts.push(
      'the photos could not be placed in 3D reliably in the first place (see this scan\'s ' +
        'reconstruction quality for what to change)',
    )
  }
  return (
    `This splat came out unusable: ${facts.join(', and ')}. ` +
    'The usual cause is the camera losing track: it drifts while you walk, so the same wall ends ' +
    'up in two places. To re-scan: keep every light on, walk slowly and steadily rather than ' +
    'turning on the spot, keep something with visible detail in view at all times, and return ' +
    'past somewhere you already scanned before you finish so the tracking can close the loop.'
  )
}

/**
 * Read what a finished run left on disk and judge it. The one impure function
 * here; `assessSplatQuality` above stays pure so the thresholds can be
 * exercised without a filesystem.
 *
 * Returns null when the splat PLY cannot be measured at all (missing, or a
 * header this reader does not accept). The drivers must NOT treat that as a
 * pass: an absent verdict is an unmeasured run, and a manifest that quietly
 * omits `quality` while saying `status: 'ok'` is precisely the "success it has
 * not earned" this stage keeps producing. They record `qualityError` instead.
 */
export async function measureSplatQuality(opts: {
  plyPath: string
  /** The dataset's `sparse_pc.ply`, when the session had a seed cloud. */
  seedPlyPath?: string
  /** Session dir, read for the pose solve's own verdict. */
  sessionDir: string
  scaleFrame: SplatScaleFrame
}): Promise<SplatQuality | null> {
  let splatBytes: Uint8Array
  try {
    splatBytes = await Deno.readFile(opts.plyPath)
  } catch {
    return null
  }
  const splatRead = readPlyCentres(splatBytes)
  if (!splatRead) return null
  const splat = centreStats(splatRead.xyz, splatRead.declaredCount)

  let seed: CentreStats | null = null
  let outsideSeedFraction: number | undefined
  const thresholds = resolveSplatQualityThresholds()
  if (opts.seedPlyPath) {
    try {
      const seedRead = readPlyCentres(await Deno.readFile(opts.seedPlyPath))
      if (seedRead && seedRead.xyz.length > 0) {
        seed = centreStats(seedRead.xyz, seedRead.declaredCount)
        outsideSeedFraction = fractionOutside(splatRead.xyz, seed, thresholds.seedBoxInflation)
      }
    } catch {
      // No seed cloud is a normal state (a device-posed capture has none), and
      // it costs only the ratio — never the whole verdict.
    }
  }

  return assessSplatQuality({
    splat,
    seed,
    outsideSeedFraction,
    scaleFrame: opts.scaleFrame,
    poseQuality: await readPoseQuality(opts.sessionDir),
  }, thresholds)
}

/**
 * The `quality` block colmap_poses.ts wrote for this session, if it ran.
 *
 * Read off disk rather than threaded through the call chain because a splat is
 * usually trained long after the solve, in a different job — and the file is
 * the only place the two stages meet. Any read failure is `null`, i.e. "no
 * verdict inherited", never "the poses were fine".
 */
async function readPoseQuality(sessionDir: string): Promise<{ degenerate?: boolean } | null> {
  try {
    const raw = await Deno.readTextFile(`${sessionDir}/colmap-poses.manifest.json`)
    const parsed = JSON.parse(raw) as { quality?: { degenerate?: unknown } }
    const degenerate = parsed.quality?.degenerate
    return typeof degenerate === 'boolean' ? { degenerate } : null
  } catch {
    return null
  }
}

/** Which frame the dataset's poses are in, from the builder's own count. */
export function scaleFrameOf(posedFrames?: { fromCapture: number; fromSolver: number }): SplatScaleFrame {
  if (!posedFrames) return 'unknown'
  return posedFrames.fromSolver > 0 ? 'sfm-relative' : 'metric'
}

function round3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0
}

function numFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
