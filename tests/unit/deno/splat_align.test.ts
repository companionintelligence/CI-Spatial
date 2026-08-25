/**
 * Deno unit tests for the Umeyama similarity fit that gives a splat metres.
 *
 * This is the stage with the least visible failure mode in the whole pipeline.
 * A wrong scale does not crash, does not warn, and renders identically to a
 * right one — it just makes every distance, every fusion and every measurement
 * downstream quietly wrong. So these tests assert the algebra directly rather
 * than smoke-testing that a manifest appeared:
 *
 *   - a known rotation/translation/scale must come back out to ~1e-9;
 *   - a mirrored correspondence must NOT return a mirrored rotation
 *     (det(R) = +1), the one failure that survives every other check;
 *   - collinear and coincident inputs must stay finite, and the collinear case
 *     must demonstrate *why* the residual alone cannot police it;
 *   - `projectTransform` must be row-major, because the column-major misread
 *     silently transposes against THREE.Matrix4.fromArray;
 *   - the driver must pair correspondences by filename, since COLMAP's frame
 *     order is not the capture order.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'

import {
  applyColumnMajor,
  COLLINEAR_SPREAD_RATIO,
  DEFAULT_MAX_RESIDUAL_M,
  det3,
  pairByFilename,
  runSplatAlign,
  similarityToRowMajor,
  svd3,
  umeyamaSimilarity,
  type Vec3Tuple,
} from '../../../server/splat/splat_align.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Rodrigues: row-major 3x3 rotation of `angle` radians about `axis`. */
function rotationFromAxisAngle(axis: Vec3Tuple, angle: number): number[][] {
  const n = Math.hypot(...axis)
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = 1 - c
  return [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ]
}

function applySimilarity(r: number[][], s: number, t: Vec3Tuple, p: Vec3Tuple): Vec3Tuple {
  return [
    s * (r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2]) + t[0],
    s * (r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2]) + t[1],
    s * (r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2]) + t[2],
  ]
}

/** Inverse of {@link applySimilarity} — used to build an SfM side from a metric one. */
function applyInverseSimilarity(r: number[][], s: number, t: Vec3Tuple, p: Vec3Tuple): Vec3Tuple {
  const d: Vec3Tuple = [(p[0] - t[0]) / s, (p[1] - t[1]) / s, (p[2] - t[2]) / s]
  // Rᵀ = R⁻¹ for a rotation.
  return [
    r[0][0] * d[0] + r[1][0] * d[1] + r[2][0] * d[2],
    r[0][1] * d[0] + r[1][1] * d[1] + r[2][1] * d[2],
    r[0][2] * d[0] + r[1][2] * d[1] + r[2][2] * d[2],
  ]
}

/**
 * Apply a **column-major** 4x4 — the convention `ScanCalibration.sessionToProject`
 * is stored in (THREE.Matrix4: basis column c at 4c..4c+2, translation at
 * 12/13/14). Written out here rather than imported from the module under test
 * on purpose: this is the fixture's independent statement of the convention, so
 * a driver that reads the calibration matrix row-major disagrees with it
 * instead of agreeing with its own bug.
 */
function toProject(m: number[], p: Vec3Tuple): Vec3Tuple {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ]
}

/** Apply a row-major 4x4 — the convention `projectTransform` is specified in. */
function applyRowMajor(m: number[], p: Vec3Tuple): Vec3Tuple {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ]
}

const close = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

function assertVecClose(got: Vec3Tuple, want: Vec3Tuple, eps: number, what: string) {
  got.forEach((v, i) => assert(close(v, want[i], eps), `${what}[${i}]: ${v} vs ${want[i]}`))
}

function assertAllFinite(fit: { rotation: number[][]; translation: Vec3Tuple; scale: number; residualM: number }) {
  assert(Number.isFinite(fit.scale), `scale is ${fit.scale}`)
  assert(Number.isFinite(fit.residualM), `residualM is ${fit.residualM}`)
  fit.translation.forEach((v, i) => assert(Number.isFinite(v), `translation[${i}] is ${v}`))
  fit.rotation.forEach((row, i) =>
    row.forEach((v, j) => assert(Number.isFinite(v), `rotation[${i}][${j}] is ${v}`))
  )
}

/** A camera path with real 3D extent — the well-conditioned case. */
const CLOUD: Vec3Tuple[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [0.5, -0.3, 2],
  [-1.2, 0.7, 0.4],
  [2, 1, -1],
]

const TRUTH_R = rotationFromAxisAngle([0.3, 0.5, 0.81], 0.7)
const TRUTH_S = 2.37
const TRUTH_T: Vec3Tuple = [1.5, -0.25, 4]

// ─── The fit ─────────────────────────────────────────────────────────────────

Deno.test('umeyamaSimilarity recovers a known rotation, translation and scale', () => {
  const target = CLOUD.map((p) => applySimilarity(TRUTH_R, TRUTH_S, TRUTH_T, p))
  const fit = umeyamaSimilarity(CLOUD, target)

  assert(close(fit.scale, TRUTH_S, 1e-9), `scale ${fit.scale} vs ${TRUTH_S}`)
  assertVecClose(fit.translation, TRUTH_T, 1e-9, 'translation')
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert(close(fit.rotation[i][j], TRUTH_R[i][j], 1e-9), `R[${i}][${j}] ${fit.rotation[i][j]} vs ${TRUTH_R[i][j]}`)
    }
  }
  assert(fit.residualM < 1e-9, `an exact correspondence must fit exactly, got ${fit.residualM}`)
  assert(close(det3(fit.rotation), 1, 1e-9), `det(R) must be +1, got ${det3(fit.rotation)}`)
  assert(!fit.degenerate)
  assert(fit.spreadRatio > 0.3, `an isotropic cloud should be well conditioned, got ${fit.spreadRatio}`)
})

Deno.test('umeyamaSimilarity refuses to mirror: a reflected correspondence still returns det(R)=+1', () => {
  // The classic silent failure: the unconstrained least-squares minimiser over
  // all 3x3 matrices would happily return a reflection here, which mirrors the
  // whole scene while fitting the points about as well. Umeyama's S-correction
  // is what rules that out, so this asserts the correction actually fires.
  const mirrored = CLOUD.map((p): Vec3Tuple => [p[0], p[1], -p[2]])
  const fit = umeyamaSimilarity(CLOUD, mirrored)

  assertAllFinite(fit)
  assert(close(det3(fit.rotation), 1, 1e-9), `det(R) must be +1, got ${det3(fit.rotation)}`)
  // A mirror is not reachable by a proper rotation, so the best proper fit must
  // leave real error behind. A ~0 residual here would mean a reflection slipped
  // through and "fit" perfectly.
  assert(fit.residualM > 0.1, `a mirrored correspondence cannot fit exactly, got ${fit.residualM}`)

  // Same check through the rotated-and-mirrored case, where the reflection is
  // not axis-aligned and cannot be spotted by inspection.
  const twisted = CLOUD.map((p) => applySimilarity(TRUTH_R, TRUTH_S, TRUTH_T, [p[0], -p[1], p[2]]))
  const twistedFit = umeyamaSimilarity(CLOUD, twisted)
  assertAllFinite(twistedFit)
  assert(close(det3(twistedFit.rotation), 1, 1e-9), `det(R) must be +1, got ${det3(twistedFit.rotation)}`)
})

Deno.test('umeyamaSimilarity stays finite on collinear input, and flags what the residual cannot', () => {
  // A capture walked in a straight line. The similarity that maps the line onto
  // the line is not unique — the roll about it is free — so the fit is
  // under-determined even though nothing about it looks wrong.
  const line: Vec3Tuple[] = [0, 1, 2, 3, 4, 5].map((i): Vec3Tuple => [i * 0.4, i * 0.4, i * 0.4])
  const target = line.map((p) => applySimilarity(TRUTH_R, TRUTH_S, TRUTH_T, p))
  const fit = umeyamaSimilarity(line, target)

  assertAllFinite(fit)
  assert(close(det3(fit.rotation), 1, 1e-9), `det(R) must be +1, got ${det3(fit.rotation)}`)
  // The scale IS recoverable along the line, and the residual is ~0 — which is
  // precisely why the residual is not allowed to be the only guard.
  assert(close(fit.scale, TRUTH_S, 1e-6), `scale along the line is recoverable: ${fit.scale}`)
  assert(fit.residualM < 1e-6, `a collinear fit hides in the residual, got ${fit.residualM}`)
  assert(
    fit.spreadRatio < COLLINEAR_SPREAD_RATIO,
    `spreadRatio must catch collinearity, got ${fit.spreadRatio}`,
  )
})

Deno.test('umeyamaSimilarity survives coincident points and empty input without NaN', () => {
  // Every camera centre identical: source variance is 0, so scale is a 0/0.
  const stack: Vec3Tuple[] = [[2, 2, 2], [2, 2, 2], [2, 2, 2], [2, 2, 2]]
  const spread: Vec3Tuple[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const fit = umeyamaSimilarity(stack, spread)
  assertAllFinite(fit)
  assert(fit.degenerate, 'a zero-extent source cloud must be reported as degenerate')

  const empty = umeyamaSimilarity([], [])
  assertAllFinite(empty)
  assert(empty.degenerate)
  assertEquals(empty.scale, 1)
  assertEquals(empty.residualM, 0)

  // Mismatched lengths must not read past the end of the shorter set.
  const ragged = umeyamaSimilarity(CLOUD, [CLOUD[0], CLOUD[1]])
  assertAllFinite(ragged)
})

Deno.test('umeyamaSimilarity reports scale 0 when the TARGET cloud has no extent', () => {
  // The failure neither existing guard sees. Every metric centre coincident
  // (what a present-but-all-zero pose block produces) zeroes the
  // cross-covariance, so tr(D·S)/σx² is exactly 0 — a rank-0 transform that
  // maps the whole source onto that one point, hence a residual of exactly 0.
  const dst = CLOUD.map((): Vec3Tuple => [3, 0.5, -2])
  const fit = umeyamaSimilarity(CLOUD, dst)

  assertAllFinite(fit)
  assertEquals(fit.scale, 0, 'not a NaN, not a fallback 1 — exactly 0')
  assert(fit.residualM < 1e-12, `a rank-0 transform hits every target exactly: ${fit.residualM}`)
  assertEquals(fit.degenerate, false, '`degenerate` inspects the SOURCE cloud, which is fine here')
  assert(fit.spreadRatio > 0.3, `and the source is well conditioned too, got ${fit.spreadRatio}`)
  // Which is the whole point: a caller that only checks `degenerate`,
  // `spreadRatio` and `residualM` would publish this.
  assertEquals(similarityToRowMajor(fit).slice(0, 3), [0, 0, 0], 'the rotation block is all zeros')
})

// ─── The SVD's documented invariant ──────────────────────────────────────────

/**
 * Deterministic LCG. A randomised sweep is the only way to state "for every
 * matrix" with any confidence, but a *seeded* one so a failure is reproducible
 * and a pass is not luck that varies per run.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function matMul3T(a: number[][], b: number[][]): number[][] {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
  }
  return out
}
function transposeT(m: number[][]): number[][] {
  return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
}
/** max|MᵀM − I| — 0 for a perfectly orthonormal M. */
function orthonormalityError(m: number[][]): number {
  const g = matMul3T(transposeT(m), m)
  let worst = 0
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(g[i][j] - (i === j ? 1 : 0)))
  }
  return worst
}

Deno.test('svd3 returns an orthonormal U, and umeyama a det=+1 rotation, at every rank', () => {
  // This is the invariant `svd3` and `SimilarityFit.rotation` both document, and
  // it used to be false. A rank-1 M — which is exactly what a collinear camera
  // path's cross-covariance is — has two U columns to fill, and filling both
  // from "some vector perpendicular to u0" produced the SAME vector twice: a
  // singular U, and det(U·S·Vᵀ) = 0 rather than +1. Nothing else in the module
  // reports that, because a rank-0 rotation still multiplies without erroring.
  const rnd = lcg(0x5eed1)
  const r = () => rnd() * 2 - 1
  const vec = () => [r(), r(), r()]
  const outer = (a: number[], b: number[]) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i] * b[j]))

  const cases: Array<{ m: number[][]; kind: string }> = [
    // The zero matrix: no direction carries anything.
    { m: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], kind: 'zero' },
  ]
  for (let t = 0; t < 3000; t++) {
    cases.push({ m: [vec(), vec(), vec()], kind: 'full-rank' })
    cases.push({ m: outer(vec(), vec()), kind: 'rank-1' })
    const [a, b, c, d] = [vec(), vec(), vec(), vec()]
    const o1 = outer(a, b), o2 = outer(c, d)
    cases.push({ m: [0, 1, 2].map((i) => [0, 1, 2].map((j) => o1[i][j] + o2[i][j])), kind: 'rank-2' })
    // Rank-1 plus noise far below the 1e-9 relative rank threshold: the case
    // where a "singular value" is entirely rounding.
    const base = outer(vec(), vec())
    cases.push({
      m: [0, 1, 2].map((i) => [0, 1, 2].map((j) => base[i][j] + 1e-14 * r())),
      kind: 'near-rank-1',
    })
  }

  let worstOrth = 0
  let worstDet = 0
  for (const { m, kind } of cases) {
    const { u, d } = svd3(m)
    const oe = orthonormalityError(u)
    worstOrth = Math.max(worstOrth, oe)
    assert(oe <= 1e-9, `${kind}: max|UᵀU − I| = ${oe} for ${JSON.stringify(m)}`)
    d.forEach((x, i) => assert(Number.isFinite(x) && x >= 0, `${kind}: d[${i}] = ${x}`))

    // And the invariant the caller depends on: the fit through this covariance
    // is a proper rotation. Driven through the public entry point so it is the
    // shipped path, not a re-implementation of it, that is pinned.
    const src = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]] as Vec3Tuple[]
    const dst = src.map((p): Vec3Tuple => [
      m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
      m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
      m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
    ])
    const fit = umeyamaSimilarity(src, dst)
    assertAllFinite(fit)
    const de = Math.abs(det3(fit.rotation) - 1)
    worstDet = Math.max(worstDet, de)
    assert(de <= 1e-9, `${kind}: det(R) = ${det3(fit.rotation)} for ${JSON.stringify(m)}`)
    assert(orthonormalityError(fit.rotation) <= 1e-9, `${kind}: R is not orthonormal`)
  }
  // Not an assertion, a record: what the tolerances above are actually worth on
  // this fixture set (roughly 1e-13 and 1e-15 when this was written).
  assert(worstOrth <= 1e-9 && worstDet <= 1e-9, `worstOrth=${worstOrth} worstDet=${worstDet}`)
})

Deno.test('a corrupted correspondence shows up as a large residual', () => {
  const target = CLOUD.map((p) => applySimilarity(TRUTH_R, TRUTH_S, TRUTH_T, p))
  const clean = umeyamaSimilarity(CLOUD, target)
  assert(clean.residualM < 1e-9)

  // One frame paired with the wrong physical viewpoint, a metre away.
  const corrupted = target.map((p, i): Vec3Tuple => (i === 3 ? [p[0] + 1, p[1], p[2]] : p))
  const fit = umeyamaSimilarity(CLOUD, corrupted)

  assertAllFinite(fit)
  assert(
    fit.residualM > DEFAULT_MAX_RESIDUAL_M,
    `a 1m mis-pair must breach the ${DEFAULT_MAX_RESIDUAL_M}m guard, got ${fit.residualM}`,
  )
})

// ─── The row-major convention ────────────────────────────────────────────────

Deno.test('projectTransform is ROW-major with the scale folded into the rotation block', () => {
  const target = CLOUD.map((p) => applySimilarity(TRUTH_R, TRUTH_S, TRUTH_T, p))
  const fit = umeyamaSimilarity(CLOUD, target)
  const m = similarityToRowMajor(fit)

  assertEquals(m.length, 16)
  // Row-major: the translation lives in the 4th COLUMN (indices 3/7/11).
  // Column-major would put it at 12/13/14 — the misread THREE.Matrix4.fromArray
  // would make, so pin both halves of the claim.
  assert(close(m[3], TRUTH_T[0], 1e-9), `m[3] must be tx, got ${m[3]}`)
  assert(close(m[7], TRUTH_T[1], 1e-9), `m[7] must be ty, got ${m[7]}`)
  assert(close(m[11], TRUTH_T[2], 1e-9), `m[11] must be tz, got ${m[11]}`)
  assertEquals([m[12], m[13], m[14], m[15]], [0, 0, 0, 1], 'row-major bottom row must be [0,0,0,1]')

  // Scale is folded in, not left for the caller to apply.
  assert(close(m[0], TRUTH_S * TRUTH_R[0][0], 1e-9), `m[0] must be s*r00, got ${m[0]}`)
  assert(close(m[1], TRUTH_S * TRUTH_R[0][1], 1e-9), `m[1] must be s*r01, got ${m[1]}`)
  assert(close(m[4], TRUTH_S * TRUTH_R[1][0], 1e-9), `m[4] must be s*r10, got ${m[4]}`)

  // And it actually transports the points when read row-major.
  CLOUD.forEach((p, i) => assertVecClose(applyRowMajor(m, p), target[i], 1e-9, `row-major point ${i}`))
})

// ─── Correspondence pairing ──────────────────────────────────────────────────

Deno.test('pairByFilename ignores order and drops unmatched frames', () => {
  const sfm = new Map<string, Vec3Tuple>([
    ['kf-00002.jpg', [2, 0, 0]],
    ['kf-00000.jpg', [0, 0, 0]],
    ['kf-00009.jpg', [9, 0, 0]], // solved but never captured with a pose
  ])
  const metric = new Map<string, Vec3Tuple>([
    ['kf-00000.jpg', [0, 1, 0]],
    ['kf-00002.jpg', [2, 1, 0]],
    ['kf-00005.jpg', [5, 1, 0]], // captured but never registered by the solver
  ])
  const paired = pairByFilename(sfm, metric)
  assertEquals(paired.files, ['kf-00000.jpg', 'kf-00002.jpg'])
  assertEquals(paired.source, [[0, 0, 0], [2, 0, 0]])
  assertEquals(paired.target, [[0, 1, 0], [2, 1, 0]])
})

Deno.test('applyColumnMajor reads sessionToProject in the THREE column-major layout', () => {
  // A yaw of +90° about Y plus a translation, laid out column-major: basis
  // column c at 4c..4c+2, translation at 12/13/14. Hand-computed expectation,
  // so this fails if the indexing is ever "tidied" into row-major:
  //   x' = z + 3,  y' = y + 0.5,  z' = -x - 2
  const m = [
    0, 0, -1, 0,
    0, 1, 0, 0,
    1, 0, 0, 0,
    3, 0.5, -2, 1,
  ]
  assertEquals(applyColumnMajor(m, [1, 2, 3]), [6, 2.5, -3])
  assertEquals(applyColumnMajor(m, [0, 0, 0]), [3, 0.5, -2], 'the translation lives at 12/13/14')
})

// ─── The driver ──────────────────────────────────────────────────────────────

/**
 * `ScanCalibration.sessionToProject` is COLUMN-major (THREE.Matrix4 layout,
 * translation at 12/13/14) — the opposite of the manifest's row-major
 * `projectTransform`. This is a yaw of +90° about Y plus a translation, chosen
 * because its 3x3 block is asymmetric and its translation is non-zero, so a
 * row-major misread of it produces different metric targets rather than the
 * same ones.
 */
const SESSION_TO_PROJECT = [
  0, 0, -1, 0,
  0, 1, 0, 0,
  1, 0, 0, 0,
  3, 0.5, -2, 1,
]

const CALIBRATION: ScanCalibration = {
  sessionToProject: SESSION_TO_PROJECT,
  calibratedAt: '2026-08-25T00:00:00.000Z',
  status: 'verified',
  method: 'two-point-ground',
  separationM: 2,
  residualM: 0.01,
  toleranceM: 0.05,
  anchorBearingDeg: null,
}

interface Frame {
  file: string
  /** Camera centre in the AR session's local frame. */
  local: Vec3Tuple
  /** Camera centre in the solver's arbitrary SfM frame. */
  sfm: Vec3Tuple
}

/**
 * Write the two inputs the driver reads: capture-time poses in
 * keyframes.jsonl and solved poses in colmap.poses.json.
 *
 * The solved file mirrors what `buildPosesJson` emits — an OpenCV 3x4
 * world-to-camera [R|t] under the key `cameraToWorld` (the key is a
 * misnomer inherited from LingBot-Map; see `openCvW2cToC2w`). With R = I the
 * centre is −t, so `t = −centre` puts the camera where this fixture wants it.
 */
async function writeSession(sessionDir: string, frames: Frame[], sfmOrder?: string[]): Promise<void> {
  await Deno.mkdir(sessionDir, { recursive: true })
  const jsonl = frames
    .map((f, i) =>
      JSON.stringify({
        index: i,
        file: f.file,
        pose: {
          position: { x: f.local[0], y: f.local[1], z: f.local[2] },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        intrinsics: { width: 640, height: 480, fovYDeg: 55 },
      })
    )
    .join('\n')
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, jsonl + '\n')

  const ordered = sfmOrder ? sfmOrder.map((f) => frames.find((x) => x.file === f)!) : frames
  await Deno.writeTextFile(
    `${sessionDir}/colmap.poses.json`,
    JSON.stringify({
      tool: 'colmap',
      frames: ordered.map((f) => ({
        file: f.file,
        cameraToWorld: [
          [1, 0, 0, -f.sfm[0]],
          [0, 1, 0, -f.sfm[1]],
          [0, 0, 1, -f.sfm[2]],
        ],
      })),
    }),
  )
}

/** Build frames whose SfM centres are the known similarity, inverted, of the metric ones. */
function framesFor(locals: Vec3Tuple[]): Frame[] {
  return locals.map((local, i) => {
    const metric = toProject(SESSION_TO_PROJECT, local)
    return {
      file: `kf-0000${i}.jpg`,
      local,
      sfm: applyInverseSimilarity(TRUTH_R, TRUTH_S, TRUTH_T, metric),
    }
  })
}

Deno.test('runSplatAlign recovers metric scale, pairing by filename rather than index', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-ok`
  const frames = framesFor(CLOUD)
  // Deliberately hand COLMAP's file a different order from the capture order,
  // and hold one keyframe back from the solver: this is the normal case, and
  // index-pairing would silently fit unrelated viewpoints to each other.
  const shuffled = ['kf-00004.jpg', 'kf-00000.jpg', 'kf-00007.jpg', 'kf-00002.jpg', 'kf-00005.jpg', 'kf-00001.jpg', 'kf-00003.jpg']
  await writeSession(sessionDir, frames, shuffled)

  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })

    assertEquals(r.status, 'ok', `expected ok, got ${r.status}: ${r.manifest.skippedReason ?? r.manifest.error}`)
    assertEquals(r.correspondenceCount, shuffled.length, 'only the solved frames should be paired')
    assert(close(r.scale!, TRUTH_S, 1e-6), `scale ${r.scale} vs ${TRUTH_S}`)
    assert(r.residualM! < 1e-6, `an exact fixture must fit exactly, got ${r.residualM}`)
    assertEquals(r.manifest.tool, 'umeyama')
    assertEquals(r.manifest.calibrationMethod, 'two-point-ground')
    assertEquals(r.projectTransform!.length, 16)

    // The transform must carry every SfM centre onto the metric centre this
    // test computed for itself with column-major indexing — the assertion that
    // fails if the driver reads `sessionToProject` in the wrong order.
    for (const f of frames) {
      if (!shuffled.includes(f.file)) continue
      const expected = toProject(SESSION_TO_PROJECT, f.local)
      assertVecClose(applyRowMajor(r.projectTransform!, f.sfm), expected, 1e-6, `mapped ${f.file}`)
    }

    // The sidecar is what the coordinator and the viewer actually read.
    const written = JSON.parse(await Deno.readTextFile(`${sessionDir}/splat-align.manifest.json`))
    assertEquals(written.status, 'ok')
    assertEquals(written.projectTransform.length, 16)
    assert(close(written.scale, TRUTH_S, 1e-6))
    assertEquals(written.params.minCorrespondences, 4)
    assertEquals(written.params.maxResidualM, DEFAULT_MAX_RESIDUAL_M)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('an uncalibrated scan is skipped — an unverified metre is not a metre', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-nocal`
  await writeSession(sessionDir, framesFor(CLOUD))
  try {
    const r = await runSplatAlign({ sessionDir })
    assertEquals(r.status, 'skipped')
    assert(r.manifest.remediation, 'a skip must tell the operator how to fix it')
    assertEquals(r.manifest.scale, undefined, 'a skipped fit must not report a scale')
    // The manifest is written even on skip — the coordinator relies on that.
    const written = JSON.parse(await Deno.readTextFile(`${sessionDir}/splat-align.manifest.json`))
    assertEquals(written.status, 'skipped')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('too few correspondences are skipped, not fitted', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-thin`
  const frames = framesFor(CLOUD.slice(0, 3))
  await writeSession(sessionDir, frames)
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })
    assertEquals(r.status, 'skipped')
    assertEquals(r.manifest.correspondenceCount, 3)
    assert(r.manifest.skippedReason?.includes('4 are needed'), r.manifest.skippedReason ?? '(none)')
    assert(r.manifest.remediation)
    assertEquals(r.manifest.projectTransform, undefined)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a fit whose residual breaches the limit is skipped, and says so with the number', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-bad`
  const frames = framesFor(CLOUD)
  // One frame's SfM centre belongs to a different physical viewpoint.
  frames[2].sfm = [frames[2].sfm[0] + 1.5, frames[2].sfm[1] - 1, frames[2].sfm[2]]
  await writeSession(sessionDir, frames)
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })
    assertEquals(r.status, 'skipped', 'a fit that cannot be verified must not claim success')
    assert(r.manifest.residualM! > DEFAULT_MAX_RESIDUAL_M, `residual ${r.manifest.residualM}`)
    assertEquals(r.manifest.projectTransform, undefined, 'no transform may be published from a failed fit')
    assert(r.manifest.remediation)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a fit that resolves to scale 0 is skipped — an `ok` there collapses the splat to a point', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-zeroscale`
  // Every keyframe carries a pose block that is *present but all zero* — the
  // shape `recordHasPose` accepts, and what an AR session that never tracked
  // writes. All eight land on the same project-space point, so the fit comes
  // back with scale 0 and residual 0: rank-0, and indistinguishable from a
  // perfect fit by every other gate the driver has.
  const frames: Frame[] = CLOUD.map((p, i) => ({ file: `kf-0000${i}.jpg`, local: [0, 0, 0], sfm: p }))
  await writeSession(sessionDir, frames)
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })

    assertEquals(r.status, 'skipped', 'a zero scale is not a fit')
    assertEquals(r.projectTransform, undefined, 'and no rank-0 matrix may reach a consumer')
    assertEquals(r.manifest.projectTransform, undefined)
    assertEquals(r.manifest.scale, undefined, '0 must not be published under the name `scale`')
    assert(r.manifest.skippedReason?.includes('scale of 0'), r.manifest.skippedReason ?? '(none)')
    assert(r.manifest.remediation?.includes('pose'), r.manifest.remediation ?? '(none)')
    assertEquals(r.manifest.correspondenceCount, frames.length)

    const written = JSON.parse(await Deno.readTextFile(`${sessionDir}/splat-align.manifest.json`))
    assertEquals(written.status, 'skipped')
    assertEquals(written.scale, undefined)
    assertEquals(written.projectTransform, undefined)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a session with no solved poses is skipped with a pointer at colmap-poses', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-nosfm`
  await writeSession(sessionDir, framesFor(CLOUD))
  await Deno.remove(`${sessionDir}/colmap.poses.json`)
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })
    assertEquals(r.status, 'skipped')
    assert(r.manifest.remediation?.includes('colmap-poses'), r.manifest.remediation ?? '(none)')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a pose-less (ingest) session is skipped: there is no metric path to fit against', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-noposes`
  const frames = framesFor(CLOUD)
  await writeSession(sessionDir, frames)
  // Rewrite keyframes.jsonl the way photo-ingest writes it: no pose block.
  await Deno.writeTextFile(
    `${sessionDir}/keyframes.jsonl`,
    frames.map((f, i) => JSON.stringify({ index: i, file: f.file, pose: null })).join('\n') + '\n',
  )
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })
    assertEquals(r.status, 'skipped')
    assert(r.manifest.skippedReason?.includes('capture-time pose'), r.manifest.skippedReason ?? '(none)')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a straight-line capture is skipped rather than fitted with an arbitrary roll', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/sess-align-line`
  const line: Vec3Tuple[] = [0, 1, 2, 3, 4, 5].map((i): Vec3Tuple => [i * 0.5, 0, 0])
  await writeSession(sessionDir, framesFor(line))
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })
    assertEquals(r.status, 'skipped')
    assert(r.manifest.skippedReason?.includes('collinear'), r.manifest.skippedReason ?? '(none)')
    assertEquals(r.manifest.projectTransform, undefined)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a session directory that is not a server session id is an error, not a skip', async () => {
  const root = await Deno.makeTempDir()
  const sessionDir = `${root}/local-not-a-session`
  await writeSession(sessionDir, framesFor(CLOUD))
  try {
    const r = await runSplatAlign({ sessionDir, calibration: CALIBRATION })
    assertEquals(r.status, 'error')
    assertEquals(r.manifest.error, 'invalid session directory')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
