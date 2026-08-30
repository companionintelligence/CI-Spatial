/**
 * Deno unit tests for the splat quality verdict.
 *
 * `assessSplatQuality` is pure, so every threshold can be exercised directly —
 * the same property `assessColmapQuality` has and for the same reason: these
 * gates decide whether a user is told to re-walk a room, and a gate that can
 * only be tested by running a 3-minute GPU train is a gate nobody tests.
 *
 * The "healthy" numbers below are not invented. They are the measured
 * sess-video-20260830-054518 run (48 keyframes, COLMAP 48/48, 12,430-point seed
 * cloud): Brush 258,710 gaussians, trimmed extent 22.262 x 10.678 x 20.507
 * against a seed's 19.315 x 10.071 x 14.960, 0.9% of centres outside the seed
 * box inflated 1.5x.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import {
  assessSplatQuality,
  DEFAULT_MAX_EXTENT_RATIO,
  DEFAULT_MAX_ROOM_EXTENT_M,
  degenerateSplatRemediation,
  resolveSplatQualityThresholds,
  scaleFrameOf,
} from '../../../server/splat/splat_quality.ts'
import type { CentreStats } from '../../../server/splat/splat_ply_stats.ts'

/** A CentreStats with the fields the verdict reads, sized as given. */
function stats(size: [number, number, number], count: number, opts?: {
  declaredCount?: number
  rawScale?: number
}): CentreStats {
  const raw = size.map((n) => n * (opts?.rawScale ?? 1)) as [number, number, number]
  return {
    count,
    declaredCount: opts?.declaredCount ?? count,
    min: [0, 0, 0],
    max: raw,
    size: raw,
    trimmedSize: size,
    diagonal: Math.hypot(...raw),
    trimmedDiagonal: Math.hypot(...size),
    outlierSpread: Math.hypot(...raw) / (Math.hypot(...size) || 1),
  }
}

const HEALTHY_SPLAT = stats([22.262, 10.678, 20.507], 258_710, { rawScale: 3.753 })
const HEALTHY_SEED = stats([19.315, 10.071, 14.960], 12_430)

Deno.test('the measured Brush run is judged ready', () => {
  const q = assessSplatQuality({
    splat: HEALTHY_SPLAT,
    seed: HEALTHY_SEED,
    outsideSeedFraction: 0.009,
    scaleFrame: 'sfm-relative',
  })
  assertEquals(q.reasons, [])
  assertEquals(q.degenerate, false)
  assertEquals(q.status, 'ready')
  assertEquals(q.extentRatio, 1.215)
  assertEquals(q.gaussianCount, 258_710)
})

Deno.test('a healthy splat is NOT failed by its raw bounding box', () => {
  // The whole reason the verdict measures the trimmed extent. This run's raw
  // box is 3.75x its trimmed one and 4.1x the seed cloud's — every gate must
  // still pass, or the check would reject the two known-good runs on this box.
  assert(HEALTHY_SPLAT.outlierSpread > 3)
  const q = assessSplatQuality({ splat: HEALTHY_SPLAT, seed: HEALTHY_SEED, scaleFrame: 'sfm-relative' })
  assertEquals(q.degenerate, false)
  assert(q.rawExtent[0] > q.extent[0], 'the raw box is still reported as a fact')
})

Deno.test('a splat sprawling past its own seed cloud is degenerate', () => {
  const sprawl = stats([60, 30, 45], 250_000)
  const q = assessSplatQuality({ splat: sprawl, seed: HEALTHY_SEED, scaleFrame: 'sfm-relative' })
  assertEquals(q.reasons, ['sprawls-beyond-seed'])
  assertEquals(q.degenerate, true)
  assertEquals(q.status, 'needs-rescan')
  assert((q.extentRatio ?? 0) > DEFAULT_MAX_EXTENT_RATIO)
})

Deno.test('mass sitting outside the seed cloud is degenerate on its own', () => {
  // Right size, wrong place: the extent ratio alone would wave this through.
  const q = assessSplatQuality({
    splat: HEALTHY_SPLAT,
    seed: HEALTHY_SEED,
    outsideSeedFraction: 0.4,
    scaleFrame: 'sfm-relative',
  })
  assertEquals(q.reasons, ['mass-outside-seed'])
  assertEquals(q.outsideSeedFraction, 0.4)
})

Deno.test('the metre gate applies to a metric capture and NEVER to a solved one', () => {
  // The same numbers, judged twice. COLMAP/LingBot poses are scale-free, so
  // "45 units" is not "45 metres" and testing it against a metre threshold is
  // the exact error that makes the panoptic lift place nothing on these
  // sessions. Only a capture-time (WebXR) pose set is in metres.
  const huge = stats([45, 12, 30], 250_000)
  assert(Math.max(...huge.trimmedSize) > DEFAULT_MAX_ROOM_EXTENT_M)

  const solved = assessSplatQuality({ splat: huge, scaleFrame: 'sfm-relative' })
  assertEquals(solved.reasons, [])
  assertEquals(solved.degenerate, false)

  const metric = assessSplatQuality({ splat: huge, scaleFrame: 'metric' })
  assertEquals(metric.reasons, ['implausible-room-size'])
  assertEquals(metric.degenerate, true)
})

Deno.test("an unknown frame runs neither extent gate rather than guessing one", () => {
  const huge = stats([45, 12, 30], 250_000)
  assertEquals(assessSplatQuality({ splat: huge, scaleFrame: 'unknown' }).reasons, [])
})

Deno.test('no seed cloud means no ratio — not a passing ratio', () => {
  const q = assessSplatQuality({ splat: HEALTHY_SPLAT, seed: null, scaleFrame: 'metric' })
  assertEquals(q.extentRatio, undefined)
  assertEquals(q.seedExtent, undefined)
  assertEquals(q.outsideSeedFraction, undefined)
})

Deno.test('a degenerate pose solve is inherited, however good the PLY looks', () => {
  // The failure this verdict exists for: a splat trained from a 3-of-17 solve
  // writes a file as large and as well-formed as one trained from 48 of 48.
  // Nothing the splat stage can measure about the PLY distinguishes them.
  const q = assessSplatQuality({
    splat: HEALTHY_SPLAT,
    seed: HEALTHY_SEED,
    outsideSeedFraction: 0.009,
    scaleFrame: 'sfm-relative',
    poseQuality: { degenerate: true },
  })
  assertEquals(q.reasons, ['degenerate-poses'])
  assertEquals(q.status, 'needs-rescan')
})

Deno.test('a healthy pose solve adds no reason, and a missing one adds no verdict', () => {
  for (const poseQuality of [{ degenerate: false }, null, undefined]) {
    const q = assessSplatQuality({
      splat: HEALTHY_SPLAT,
      seed: HEALTHY_SEED,
      outsideSeedFraction: 0.009,
      scaleFrame: 'sfm-relative',
      poseQuality,
    })
    assertEquals(q.reasons, [])
  }
})

Deno.test('an empty or near-empty splat is degenerate, not merely small', () => {
  assertEquals(assessSplatQuality({ splat: stats([0, 0, 0], 0), scaleFrame: 'metric' }).reasons, ['no-gaussians'])
  assertEquals(
    assessSplatQuality({ splat: stats([2, 2, 2], 12), scaleFrame: 'metric' }).reasons,
    ['too-few-gaussians'],
  )
})

Deno.test('a truncated PLY is called out rather than judged as a whole splat', () => {
  const short = stats([20, 10, 15], 100_000, { declaredCount: 258_710 })
  const q = assessSplatQuality({ splat: short, seed: HEALTHY_SEED, scaleFrame: 'sfm-relative' })
  assert(q.reasons.includes('truncated-ply'))
  assertEquals(q.degenerate, true)
})

Deno.test('the verdict carries the thresholds it was measured against', () => {
  const q = assessSplatQuality({ splat: HEALTHY_SPLAT, seed: HEALTHY_SEED, scaleFrame: 'sfm-relative' })
  assertEquals(q.thresholds, resolveSplatQualityThresholds())
  assertEquals(q.thresholds.maxExtentRatio, DEFAULT_MAX_EXTENT_RATIO)
})

Deno.test('thresholds are overridable from the environment', () => {
  Deno.env.set('SPLAT_MAX_EXTENT_RATIO', '1.05')
  try {
    const q = assessSplatQuality({ splat: HEALTHY_SPLAT, seed: HEALTHY_SEED, scaleFrame: 'sfm-relative' })
    assertEquals(q.thresholds.maxExtentRatio, 1.05)
    assert(q.reasons.includes('sprawls-beyond-seed'))
  } finally {
    Deno.env.delete('SPLAT_MAX_EXTENT_RATIO')
  }
})

Deno.test('the remediation names the measured fact, not the internals', () => {
  const q = assessSplatQuality({
    splat: stats([60, 30, 45], 250_000),
    seed: HEALTHY_SEED,
    outsideSeedFraction: 0.4,
    scaleFrame: 'sfm-relative',
  })
  const text = degenerateSplatRemediation(q)
  assertStringIncludes(text, 'wider than the room')
  assertStringIncludes(text, '40%')
  // Nothing about gaussians, PLY headers, seed clouds or job types — the
  // reader is the person who walked the room. Same rule as
  // colmap_poses.ts's degenerateRemediation.
  for (const jargon of ['gaussian', 'PLY', 'seed cloud', 'WorldJob', 'splat-train']) {
    assert(!text.includes(jargon), `remediation leaked "${jargon}": ${text}`)
  }
})

Deno.test('scaleFrameOf is metric only when no pose came from a solver', () => {
  assertEquals(scaleFrameOf({ fromCapture: 17, fromSolver: 0 }), 'metric')
  assertEquals(scaleFrameOf({ fromCapture: 0, fromSolver: 48 }), 'sfm-relative')
  // A mixed session is scale-free as a whole: one solved pose puts the shared
  // world frame in the solver's arbitrary units.
  assertEquals(scaleFrameOf({ fromCapture: 40, fromSolver: 8 }), 'sfm-relative')
  assertEquals(scaleFrameOf(undefined), 'unknown')
})
