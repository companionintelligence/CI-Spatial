/**
 * The similarity algebra of the joint solve (server/register/sim3_chain.ts):
 * `T_new->Place = T_ref x Sim_ref^-1 x Sim_new`, with random known transforms.
 *
 * Every transform here is drawn at random and the expected answer is worked out another way: point by point through
 * the three stages, or with a general 4x4 inverse and the repo's own column-major product, neither of which shares
 * code with the chain. The two matrix conventions are tested against their real writers (`composeYUpTransform` for
 * `sessionToProject`, `similarityToRowMajor` for `SplatAlignManifest.projectTransform`), because the failure they
 * guard against is a transposed matrix that still looks like a transform.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { composeYUpTransform, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import { matricesAgree, multiplyMat4 } from '../../../src/world/register-proposal.ts'
import {
  applyColumnMajor,
  similarityToRowMajor,
  transpose4,
  type Vec3Tuple,
} from '../../../server/splat/splat_align.ts'
import {
  applySim3,
  chainToPlace,
  composeSim3,
  describeCorrection,
  fitSessionToSolver,
  identitySim3,
  invertSim3,
  MAX_UP_AXIS_TILT_DEG,
  registerSessionsToReference,
  type Sim3,
  sim3FromColumnMajor,
  sim3FromRowMajor,
  sim3ToColumnMajor,
  sim3ToRowMajor,
} from '../../../server/register/sim3_chain.ts'
import { gaussian, mulberry32, mulVec, rotY, type M3 } from './toy_sfm_scene.ts'

// ─── Random similarities ─────────────────────────────────────────────────────

/** A random proper rotation from a random unit quaternion (Shoemake). */
function randomRotation(next: () => number): M3 {
  const u1 = next()
  const u2 = next() * 2 * Math.PI
  const u3 = next() * 2 * Math.PI
  const a = Math.sqrt(1 - u1)
  const b = Math.sqrt(u1)
  const x = a * Math.sin(u2)
  const y = a * Math.cos(u2)
  const z = b * Math.sin(u3)
  const w = b * Math.cos(u3)
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}

function randomSim3(next: () => number, scale = 0.3 + next() * 2.7): Sim3 {
  return {
    rotation: randomRotation(next),
    translation: [(next() - 0.5) * 20, (next() - 0.5) * 20, (next() - 0.5) * 20],
    scale,
  }
}

/** A gravity-aligned session frame to the Place frame: a turn about up, a shift, a unit. */
function yawSim3(next: () => number, scale: number): Sim3 {
  return {
    rotation: rotY(next() * 360),
    translation: [(next() - 0.5) * 8, (next() - 0.5) * 0.4, (next() - 0.5) * 8],
    scale,
  }
}

function randomPoint(next: () => number, extent = 8): Vec3Tuple {
  return [(next() - 0.5) * extent, (next() - 0.5) * extent * 0.3, (next() - 0.5) * extent]
}

function near(a: Vec3Tuple, b: Vec3Tuple, tolerance = 1e-9): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance
}

function assertNear(a: Vec3Tuple, b: Vec3Tuple, tolerance = 1e-9, label = ''): void {
  assert(near(a, b, tolerance), `${label} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

function assertSimNear(a: Sim3, b: Sim3, tolerance = 1e-9): void {
  assert(Math.abs(a.scale - b.scale) <= tolerance * Math.max(1, b.scale), `scale ${a.scale} vs ${b.scale}`)
  assertNear(a.translation, b.translation, tolerance * 10, 'translation')
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert(Math.abs(a.rotation[i]![j]! - b.rotation[i]![j]!) <= tolerance, `rotation[${i}][${j}]`)
}

// ─── An independent 4x4 inverse and a row-major product ──────────────────────

/** General inverse of a 4x4 held column-major, by Gauss-Jordan with partial pivoting. Shares nothing with the chain. */
function inverse4ColumnMajor(m: number[]): number[] {
  // Row-major working copy: a[r][c] = m[c * 4 + r].
  const a = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]!))
  const inv = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)))
  for (let col = 0; col < 4; col++) {
    let pivot = col
    for (let r = col + 1; r < 4; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    ;[inv[col], inv[pivot]] = [inv[pivot]!, inv[col]!]
    const d = a[col]![col]!
    for (let c = 0; c < 4; c++) {
      a[col]![c]! /= d
      inv[col]![c]! /= d
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue
      const f = a[r]![col]!
      for (let c = 0; c < 4; c++) {
        a[r]![c]! -= f * a[col]![c]!
        inv[r]![c]! -= f * inv[col]![c]!
      }
    }
  }
  const out = new Array<number>(16)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = inv[r]![c]!
  return out
}

/** The row-major product `a . b`, written out. */
function mulRowMajor(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c]! += a[r * 4 + k]! * b[k * 4 + c]!
  }
  return out
}

// ─── Composition, inverse, application ───────────────────────────────────────

Deno.test('composing similarities applies the inner one first, and the inverse undoes one', () => {
  const next = mulberry32(1)
  for (let trial = 0; trial < 50; trial++) {
    const outer = randomSim3(next)
    const inner = randomSim3(next)
    const p = randomPoint(next)
    assertNear(applySim3(composeSim3(outer, inner), p), applySim3(outer, applySim3(inner, p)), 1e-9, 'compose')
    assertNear(applySim3(invertSim3(outer), applySim3(outer, p)), p, 1e-9, 'inverse')
    assertSimNear(composeSim3(outer, invertSim3(outer)), identitySim3(), 1e-9)
    assertSimNear(invertSim3(invertSim3(inner)), inner)
    assertEquals(composeSim3(outer, inner).scale, outer.scale * inner.scale)
  }
})

Deno.test('composition is not commutative: the order is the algebra', () => {
  const next = mulberry32(2)
  const a = randomSim3(next)
  const b = randomSim3(next)
  const p = randomPoint(next)
  assert(!near(applySim3(composeSim3(a, b), p), applySim3(composeSim3(b, a), p), 1e-3))
})

// ─── The two matrix conventions ──────────────────────────────────────────────

Deno.test('column-major puts the translation at 12 to 14 and the scale in the basis, as THREE reads it', () => {
  const next = mulberry32(3)
  for (let trial = 0; trial < 30; trial++) {
    const s = randomSim3(next)
    const m = sim3ToColumnMajor(s)
    assertEquals([m[12], m[13], m[14], m[15]], [...s.translation, 1])
    assertEquals([m[3], m[7], m[11]], [0, 0, 0])
    const p = randomPoint(next)
    // The repo's own column-major application (splat_align.ts, the one `metricCentresFromKeyframes` uses).
    assertNear(applyColumnMajor(m, p), applySim3(s, p), 1e-9, 'applyColumnMajor')
    assertSimNear(sim3FromColumnMajor(m)!, s)
  }
})

Deno.test('row-major puts the translation at 3, 7 and 11, and is the transpose of column-major', () => {
  const next = mulberry32(4)
  for (let trial = 0; trial < 30; trial++) {
    const s = randomSim3(next)
    const row = sim3ToRowMajor(s)
    assertEquals([row[3], row[7], row[11], row[15]], [...s.translation, 1])
    assertEquals([row[12], row[13], row[14]], [0, 0, 0])
    assertEquals(row, transpose4(sim3ToColumnMajor(s)))
    assertEquals(row, similarityToRowMajor(s), 'the writer SplatAlignManifest.projectTransform already has')
    assertSimNear(sim3FromRowMajor(row)!, s)
  }
})

Deno.test('a row-major matrix is not mistaken for a column-major one, nor the reverse', () => {
  const s: Sim3 = { rotation: rotY(30), translation: [1, 2, 3], scale: 1.1 }
  // Read as column-major, a row-major matrix has its translation in the bottom row: not a similarity.
  assertEquals(sim3FromColumnMajor(sim3ToRowMajor(s)), null)
  assertEquals(sim3FromRowMajor(sim3ToColumnMajor(s)), null)
  // With no translation the two layouts differ only by a transpose, which inverts a rotation: wrong, and silent.
  const turned: Sim3 = { rotation: rotY(30), translation: [0, 0, 0], scale: 1 }
  const misread = sim3FromColumnMajor(sim3ToRowMajor(turned))!
  assertSimNear(misread, invertSim3(turned))
  assert(!near(applySim3(misread, [1, 0, 0]), applySim3(turned, [1, 0, 0]), 1e-3))
})

Deno.test('the column-major reader reads what the app writes into sessionToProject', () => {
  // composeYUpTransform is the writer of sessionToProject's rotation and translation (src/world/geo.ts).
  for (const bearing of [0, 25, 90, 137, -61, 180]) {
    const m = composeYUpTransform({ x: 1.5, y: -0.2, z: 3 }, bearing, 1)
    const s = sim3FromColumnMajor(m)!
    assert(s, `bearing ${bearing}`)
    assert(Math.abs(s.scale - 1) < 1e-12, `scale ${s.scale}`)
    assertEquals(s.translation, [1.5, -0.2, 3])
    assertSimNear(s, { rotation: rotY(bearing), translation: [1.5, -0.2, 3], scale: 1 }, 1e-12)
  }
  // A scaled one reads as a scaled similarity.
  assert(Math.abs(sim3FromColumnMajor(composeYUpTransform({ x: 0, y: 0, z: 0 }, 40, 1.25))!.scale - 1.25) < 1e-12)

  // The two-point frame puts the landmark at the origin and the heading marker on +z.
  const landmark = { x: 2, y: 0.1, z: -1 }
  const marker = { x: 3.4, y: 0.1, z: 0.2 }
  const frame = sim3FromColumnMajor(twoPointToProjectTransform(landmark, marker))!
  assertNear(applySim3(frame, [landmark.x, landmark.y, landmark.z]), [0, 0, 0], 1e-12, 'landmark')
  const separation = Math.hypot(marker.x - landmark.x, marker.z - landmark.z)
  assertNear(applySim3(frame, [marker.x, marker.y, marker.z]), [0, 0, separation], 1e-12, 'marker')
})

Deno.test('a matrix that is not a similarity is refused rather than read', () => {
  const ok = sim3ToColumnMajor({ rotation: rotY(10), translation: [1, 2, 3], scale: 1 })
  assert(sim3FromColumnMajor(ok))
  assertEquals(sim3FromColumnMajor(ok.slice(0, 15)), null, 'not 16 numbers')
  assertEquals(sim3FromColumnMajor([...ok.slice(0, 5), NaN, ...ok.slice(6)]), null, 'not finite')
  const stretched = [...ok]
  stretched[10] = stretched[10]! * 2
  assertEquals(sim3FromColumnMajor(stretched), null, 'a stretch along one axis')
  const sheared = [...ok]
  sheared[4] = sheared[4]! + 0.3
  assertEquals(sim3FromColumnMajor(sheared), null, 'a shear')
  const mirrored = sim3ToColumnMajor({ rotation: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], scale: 1 })
  assertEquals(sim3FromColumnMajor(mirrored), null, 'a mirror')
  const perspective = [...ok]
  perspective[3] = 0.01
  assertEquals(sim3FromColumnMajor(perspective), null, 'a projective row')
  assertEquals(sim3FromColumnMajor([]), null)
})

// ─── The chain ───────────────────────────────────────────────────────────────

Deno.test('T_new->Place carries a point from the new session through the solver and back, on random transforms', () => {
  const next = mulberry32(5)
  for (let trial = 0; trial < 100; trial++) {
    const tRef = yawSim3(next, 1) // the reference's calibration: rigid
    const simRef = randomSim3(next) // A_ref -> W
    const simNew = randomSim3(next) // A_new -> W
    const chained = chainToPlace(tRef, simRef, simNew)
    for (let k = 0; k < 5; k++) {
      const p = randomPoint(next)
      // Stage by stage: into the solver, back into the reference's frame, through the reference's calibration.
      const inSolver = applySim3(simNew, p)
      const inReference = applySim3(invertSim3(simRef), inSolver)
      assertNear(applySim3(chained, p), applySim3(tRef, inReference), 1e-8, `trial ${trial}`)
    }
    assert(Math.abs(chained.scale - (tRef.scale * simNew.scale) / simRef.scale) < 1e-9, 'the scales multiply and divide')
  }
})

Deno.test('the chain is the matrix product in both conventions, checked against a general inverse', () => {
  const next = mulberry32(6)
  for (let trial = 0; trial < 50; trial++) {
    const tRef = yawSim3(next, 1)
    const simRef = randomSim3(next)
    const simNew = randomSim3(next)
    const chained = chainToPlace(tRef, simRef, simNew)

    // Column-major, with the repo's own product (multiplyMat4: the matrix that applies b first) and a Gauss-Jordan inverse.
    const colExpected = multiplyMat4(
      multiplyMat4(sim3ToColumnMajor(tRef), inverse4ColumnMajor(sim3ToColumnMajor(simRef))),
      sim3ToColumnMajor(simNew),
    )
    assert(matricesAgree(sim3ToColumnMajor(chained), colExpected, 1e-8), `column-major, trial ${trial}`)

    // Row-major: the same product written out the other way round, from the transposed matrices.
    const rowExpected = mulRowMajor(
      mulRowMajor(sim3ToRowMajor(tRef), transpose4(inverse4ColumnMajor(sim3ToColumnMajor(simRef)))),
      sim3ToRowMajor(simNew),
    )
    assert(matricesAgree(sim3ToRowMajor(chained), rowExpected, 1e-8), `row-major, trial ${trial}`)
    assert(matricesAgree(sim3ToRowMajor(chained), transpose4(sim3ToColumnMajor(chained)), 1e-12))
  }
})

Deno.test('the reference registered to itself is its own calibration', () => {
  const next = mulberry32(7)
  for (let trial = 0; trial < 20; trial++) {
    const tRef = yawSim3(next, 1)
    const simRef = randomSim3(next)
    assertSimNear(chainToPlace(tRef, simRef, simRef), tRef, 1e-9)
  }
})

Deno.test('a swapped order is a different transform', () => {
  const next = mulberry32(8)
  const tRef = yawSim3(next, 1)
  const simRef = randomSim3(next)
  const simNew = randomSim3(next)
  const right = chainToPlace(tRef, simRef, simNew)
  // Sim_ref^-1 . Sim_new . T_ref and T_ref . Sim_new . Sim_ref^-1 are the usual slips.
  const slips = [
    composeSim3(composeSim3(invertSim3(simRef), simNew), tRef),
    composeSim3(composeSim3(tRef, simNew), invertSim3(simRef)),
    composeSim3(composeSim3(tRef, simRef), invertSim3(simNew)),
  ]
  const p = randomPoint(next)
  for (const slip of slips) assert(!near(applySim3(slip, p), applySim3(right, p), 1e-3))
})

// ─── A whole registration, from camera centres ───────────────────────────────

/** Camera centres of one session round a ring, in the Place frame (a walk that is not a straight line). */
function ringCentres(next: () => number, n: number, around: Vec3Tuple): Vec3Tuple[] {
  return Array.from({ length: n }, (_, i): Vec3Tuple => {
    const a = (i / n) * 2 * Math.PI + next() * 0.2
    const r = 1 + next() * 1.2
    return [around[0] + r * Math.cos(a), 1.3 + (next() - 0.5) * 0.3, around[2] + r * Math.sin(a)]
  })
}

const files = (id: string, n: number) => Array.from({ length: n }, (_, i) => `${id}/kf-${String(i).padStart(5, '0')}.jpg`)

interface World {
  /** The solver's frame: any similarity of the Place frame. */
  solver: Sim3
  sessions: Array<{
    id: string
    /** Truth: this session's AR frame to the Place frame. */
    truth: Sim3
    placeCentres: Vec3Tuple[]
    arCentres: Map<string, Vec3Tuple>
    solverCentres: Map<string, Vec3Tuple>
  }>
}

/**
 * Build a world: sessions `ids` with the given units (Place metres per session unit), each walked on its own ring,
 * all seen by one solver whose frame is a random similarity (tilted, shifted, scaled) of the Place frame.
 * `noise` is the sigma added to the recorded AR centres and to the solver's, in metres.
 */
function makeWorld(seed: number, ids: string[], units: number[], noise = 0): World {
  const next = mulberry32(seed)
  const solver = randomSim3(next)
  const sessions = ids.map((id, s) => {
    const truth = yawSim3(next, units[s]!)
    const names = files(id, 24)
    const placeCentres = ringCentres(next, 24, [1 + next() * 2, 0, 1 + next() * 2])
    const inverse = invertSim3(truth)
    const arCentres = new Map<string, Vec3Tuple>()
    const solverCentres = new Map<string, Vec3Tuple>()
    placeCentres.forEach((p, i) => {
      const ar = applySim3(inverse, p)
      const sv = applySim3(solver, p)
      arCentres.set(names[i]!, [
        ar[0] + gaussian(next) * noise / units[s]!,
        ar[1] + gaussian(next) * noise / units[s]!,
        ar[2] + gaussian(next) * noise / units[s]!,
      ])
      solverCentres.set(names[i]!, [
        sv[0] + gaussian(next) * noise * solver.scale,
        sv[1] + gaussian(next) * noise * solver.scale,
        sv[2] + gaussian(next) * noise * solver.scale,
      ])
    })
    return { id, truth, placeCentres, arCentres, solverCentres }
  })
  return { solver, sessions }
}

/** Fit one session of a world, with any of the inputs replaced. */
function fitWorldSession(
  session: World['sessions'][number],
  replace: Partial<Parameters<typeof fitSessionToSolver>[0]> = {},
) {
  return fitSessionToSolver({
    sessionId: session.id,
    sessionCentres: session.arCentres,
    solverCentres: session.solverCentres,
    ...replace,
  })
}

function register(world: World, which: string[]) {
  const [ref, ...others] = world.sessions.filter((s) => which.includes(s.id))
  const fit = (s: World['sessions'][number]) => fitWorldSession(s)
  return {
    results: registerSessionsToReference(
      { sessionId: ref!.id, sessionToProject: sim3ToColumnMajor(ref!.truth), fit: fit(ref!) },
      others.map((s) => ({ sessionId: s.id, fit: fit(s) })),
    ),
    ref: ref!,
    others,
  }
}

Deno.test('noise-free centres recover each session\'s true frame in the Place frame, including its unit', () => {
  for (const seed of [11, 12, 13, 14, 15]) {
    const world = makeWorld(seed, ['sess-ref', 'sess-a', 'sess-b'], [1, 1, 1.15])
    const { results, others } = register(world, ['sess-ref', 'sess-a', 'sess-b'])
    assertEquals(results.length, 2)
    results.forEach((r, i) => {
      assert(r.ok, r.ok ? '' : r.message)
      assertSimNear(r.sessionToPlace, others[i]!.truth, 1e-8)
      assertEquals(sim3FromColumnMajor(r.sessionToPlaceColumnMajor) !== null, true)
      assert(matricesAgree(r.sessionToPlaceColumnMajor, sim3ToColumnMajor(others[i]!.truth), 1e-8))
      assert(matricesAgree(r.sessionToPlaceRowMajor, sim3ToRowMajor(others[i]!.truth), 1e-8))
      assert(r.residualSessionUnits < 1e-8)
      assertEquals(r.correspondenceCount, 24)
    })
  }
})

Deno.test('the per-session scale ratio is the unit mismatch between runtimes, and is recorded', () => {
  const world = makeWorld(21, ['sess-ref', 'sess-metric', 'sess-big', 'sess-small'], [1, 1, 1.12, 0.85])
  const { results } = register(world, ['sess-ref', 'sess-metric', 'sess-big', 'sess-small'])
  const [metric, big, small] = results
  assert(metric!.ok && big!.ok && small!.ok)
  assert(Math.abs(metric.scaleRatioToReference - 1) < 1e-9)
  assert(Math.abs(big.scaleRatioToReference - 1.12) < 1e-9, `${big.scaleRatioToReference}`)
  assert(Math.abs(small.scaleRatioToReference - 0.85) < 1e-9)
  // The ratio is the scale of the transform, and the Umeyama scales it is made of are on the record.
  assert(Math.abs(big.sessionToPlace.scale - 1.12) < 1e-9)
  const ref = world.sessions[0]!
  const refScale = fitWorldSession(ref)
  assert(refScale.ok)
  assert(Math.abs(big.umeyamaScale / refScale.sessionToSolver.scale - 1.12) < 1e-9)
  // Solver units per session unit: the solver's own scale times the unit of the session.
  assert(Math.abs(big.umeyamaScale - world.solver.scale * 1.12) < 1e-9)
})

Deno.test('the residual is reported in session units and in Place metres', () => {
  const world = makeWorld(22, ['sess-ref', 'sess-big'], [1, 1.5], 0.02)
  const { results } = register(world, ['sess-ref', 'sess-big'])
  const big = results[0]!
  assert(big.ok)
  assert(big.residualSessionUnits > 0.005 && big.residualSessionUnits < 0.1, `${big.residualSessionUnits}`)
  // A unit of this session is the recovered scale of Place metres, 1.5 to within the noise.
  assert(Math.abs(big.residualPlaceM - big.residualSessionUnits * big.sessionToPlace.scale) < 1e-12)
  assert(Math.abs(big.sessionToPlace.scale / 1.5 - 1) < 0.03, `${big.sessionToPlace.scale}`)
})

Deno.test('with 2 cm of noise on every camera centre the recovered frame is within a few centimetres and about a degree', () => {
  // Measured over these 60 seeds: the worst is 3.1 cm at the middle of the session, 0.58 degrees of yaw and 1.3% of
  // scale. The bounds below are twice that, so the test is a statement about the size of the error and not a
  // snapshot of one random draw. Two fits are chained, so the error is the reference's plus the new session's.

  let worstTranslation = 0
  let worstYaw = 0
  let worstScale = 0
  for (const seed of Array.from({ length: 60 }, (_, i) => 31 + i)) {
    const world = makeWorld(seed, ['sess-ref', 'sess-a'], [1, 1.1], 0.02)
    const { results, others } = register(world, ['sess-ref', 'sess-a'])
    const r = results[0]!
    assert(r.ok)
    // Where the true frame and the recovered one put the middle of the session's own cameras.
    const truth = others[0]!.truth
    const centroid = others[0]!.placeCentres.reduce<Vec3Tuple>(
      (acc, c) => [acc[0] + c[0] / 24, acc[1] + c[1] / 24, acc[2] + c[2] / 24],
      [0, 0, 0],
    )
    const arCentroid = applySim3(invertSim3(truth), centroid)
    const here = applySim3(r.sessionToPlace, arCentroid)
    worstTranslation = Math.max(worstTranslation, Math.hypot(here[0] - centroid[0], here[1] - centroid[1], here[2] - centroid[2]))
    // The turn about up between the recovered frame and the true one.
    const rel = composeSim3(r.sessionToPlace, invertSim3(truth))
    const yaw = (Math.atan2(rel.rotation[0]![2]! - rel.rotation[2]![0]!, rel.rotation[0]![0]! + rel.rotation[2]![2]!) * 180) / Math.PI
    worstYaw = Math.max(worstYaw, Math.abs(yaw))
    worstScale = Math.max(worstScale, Math.abs(r.scaleRatioToReference / 1.1 - 1))
  }
  assert(worstTranslation < 0.06, `centroid off by ${worstTranslation} m`)
  assert(worstYaw < 1.2, `yaw off by ${worstYaw} degrees`)
  assert(worstScale < 0.03, `scale off by ${worstScale}`)
})

Deno.test('the up axis comes from the fit to the AR poses: it is the session\'s +Y in the solver frame', () => {
  const world = makeWorld(41, ['sess-ref', 'sess-a'], [1, 1])
  const { results } = register(world, ['sess-ref', 'sess-a'])
  const r = results[0]!
  assert(r.ok)
  // Both sessions are gravity-aligned (a turn about +Y), so up in the solver frame is the solver's image of Place +Y.
  assertNear(r.upAxisInSolver, mulVec(world.solver.rotation as M3, [0, 1, 0]), 1e-9, 'upAxisInSolver')
  assert(Math.abs(Math.hypot(...r.upAxisInSolver) - 1) < 1e-9, 'a unit vector')
})

Deno.test('the reference alone fixes the way from the solver\'s frame back to the Place frame', () => {
  // T_ref . Sim_ref^-1 is made of the reference's calibration and the reference's fit and nothing of the new session.
  const world = makeWorld(51, ['sess-ref', 'sess-a'], [1, 1])
  const ref = world.sessions[0]!
  const refFit = fitWorldSession(ref)
  assert(refFit.ok)
  const placeFromSolver = composeSim3(ref.truth, invertSim3(refFit.sessionToSolver))
  // That is the inverse of the solver's own similarity of the Place frame, because the reference's truth is exact.
  assertSimNear(placeFromSolver, invertSim3(world.solver), 1e-8)
})

// ─── Star, not chain ─────────────────────────────────────────────────────────

Deno.test('a session is registered to the reference alone: the other sessions\' fits do not enter', () => {
  const world = makeWorld(61, ['sess-ref', 'sess-a', 'sess-b', 'sess-c'], [1, 1, 1.2, 0.9], 0.01)
  const fit = (s: World['sessions'][number]) => fitWorldSession(s)
  const [ref, a, b, c] = world.sessions
  const reference = { sessionId: ref!.id, sessionToProject: sim3ToColumnMajor(ref!.truth), fit: fit(ref!) }

  const all = registerSessionsToReference(reference, [a!, b!, c!].map((s) => ({ sessionId: s.id, fit: fit(s) })))
  const justC = registerSessionsToReference(reference, [{ sessionId: c!.id, fit: fit(c!) }])
  // B's fit corrupted (a refusal): C is untouched.
  const badB = fitWorldSession(b!, { sessionCentres: new Map([...b!.arCentres].slice(0, 2)) })
  assert(!badB.ok)
  const withBadB = registerSessionsToReference(reference, [
    { sessionId: b!.id, fit: badB },
    { sessionId: c!.id, fit: fit(c!) },
  ])
  assertEquals(all[2], justC[0])
  assertEquals(withBadB[1], justC[0])
  assert(!withBadB[0]!.ok && withBadB[0]!.reason === 'too-few-correspondences')
  assertEquals(all.map((r) => r.sessionId), ['sess-a', 'sess-b', 'sess-c'], 'results come back in the order given')
})

// ─── Refusals ────────────────────────────────────────────────────────────────

Deno.test('a fit needs enough frames paired to check itself against', () => {
  const world = makeWorld(71, ['sess-ref', 'sess-a'], [1, 1])
  const a = world.sessions[1]!
  const three = fitWorldSession(a, { sessionCentres: new Map([...a.arCentres].slice(0, 3)) })
  assert(!three.ok)
  assertEquals(three.reason, 'too-few-correspondences')
  assertEquals(three.correspondenceCount, 3)
  assert(three.message.includes('sess-a') && three.message.includes('4 are needed'), three.message)
  assert(fitWorldSession(a, { sessionCentres: new Map([...a.arCentres].slice(0, 4)) }).ok, 'four is enough')
  // Frames the solve did not place are not paired.
  const half = new Map([...a.solverCentres].slice(0, 2))
  assertEquals(fitWorldSession(a, { solverCentres: half }).ok, false)
})

Deno.test('camera centres on a straight line are refused: the turn about the line is undetermined', () => {
  const ar = new Map<string, Vec3Tuple>()
  const sv = new Map<string, Vec3Tuple>()
  for (let i = 0; i < 12; i++) {
    ar.set(`sess-l/kf-${i}.jpg`, [i * 0.3, 1.4, 0])
    sv.set(`sess-l/kf-${i}.jpg`, [i * 0.9, 0.2, 5])
  }
  const result = fitSessionToSolver({ sessionId: 'sess-l', sessionCentres: ar, solverCentres: sv })
  assert(!result.ok)
  assertEquals(result.reason, 'collinear')
  assert(result.message.includes('line'), result.message)
  assertEquals(result.correspondenceCount, 12)
})

Deno.test('solved camera positions that are all in one place are refused with that said, not described as a line', () => {
  const ar = new Map<string, Vec3Tuple>()
  const sv = new Map<string, Vec3Tuple>()
  const next = mulberry32(80)
  for (let i = 0; i < 10; i++) {
    ar.set(`sess-p/kf-${i}.jpg`, [next() * 3, 1.4, next() * 3])
    sv.set(`sess-p/kf-${i}.jpg`, [2, 2, 2])
  }
  const result = fitSessionToSolver({ sessionId: 'sess-p', sessionCentres: ar, solverCentres: sv })
  assert(!result.ok)
  assertEquals(result.reason, 'collinear')
  assert(result.message.includes('one place') && !result.message.includes('line'), result.message)
})

Deno.test('camera centres that all coincide are refused, not fitted to a scale of zero', () => {
  const ar = new Map<string, Vec3Tuple>()
  const sv = new Map<string, Vec3Tuple>()
  const next = mulberry32(81)
  for (let i = 0; i < 10; i++) {
    ar.set(`sess-z/kf-${i}.jpg`, [1, 1, 1])
    sv.set(`sess-z/kf-${i}.jpg`, [next() * 4, next() * 4, next() * 4])
  }
  const result = fitSessionToSolver({ sessionId: 'sess-z', sessionCentres: ar, solverCentres: sv })
  assert(!result.ok)
  assertEquals(result.reason, 'degenerate-scale')
  assert(result.message.includes('scale'), result.message)
})

Deno.test('a path the solve and the AR poses disagree about is refused with the number', () => {
  const world = makeWorld(91, ['sess-ref', 'sess-a'], [1, 1])
  const a = world.sessions[1]!
  const ar = new Map(a.arCentres)
  // Three of the 24 frames are 3 m off.
  for (const key of [...ar.keys()].slice(0, 3)) {
    const p = ar.get(key)!
    ar.set(key, [p[0] + 3, p[1], p[2] - 3])
  }
  const result = fitWorldSession(a, { sessionCentres: ar })
  assert(!result.ok)
  assertEquals(result.reason, 'high-residual')
  assert(result.residualSessionUnits! > 0.25)
  assert(result.umeyamaScale! > 0)
  assert(result.message.includes('0.25'), result.message)
  // The limit is a parameter.
  assert(fitWorldSession(a, { sessionCentres: ar, maxResidualM: 5 }).ok)
})

Deno.test('with no usable reference no session is registered, and each is told why', () => {
  const world = makeWorld(101, ['sess-ref', 'sess-a'], [1, 1])
  const [ref, a] = world.sessions
  const aFit = fitWorldSession(a!)

  // The reference's own fit failed.
  const noFrames = fitWorldSession(ref!, { sessionCentres: new Map() })
  const first = registerSessionsToReference({ sessionId: ref!.id, sessionToProject: sim3ToColumnMajor(ref!.truth), fit: noFrames }, [
    { sessionId: a!.id, fit: aFit },
  ])
  assert(!first[0]!.ok)
  assertEquals(first[0]!.reason, 'reference-unusable')
  assert(first[0]!.message.includes('sess-ref'), first[0]!.message)

  // The reference's calibration is not a similarity (a stretch).
  const refFit = fitWorldSession(ref!)
  const stretched = sim3ToColumnMajor(ref!.truth)
  stretched[5] = stretched[5]! * 1.5
  const second = registerSessionsToReference({ sessionId: ref!.id, sessionToProject: stretched, fit: refFit }, [{ sessionId: a!.id, fit: aFit }])
  assert(!second[0]!.ok)
  assertEquals(second[0]!.reason, 'reference-unusable')
  assert(second[0]!.message.includes('similarity'), second[0]!.message)
})

// ─── What registering would change ───────────────────────────────────────────

Deno.test('the correction between the registration and the scan\'s own calibration is read back as a turn, a shift and a height', () => {
  const next = mulberry32(111)
  const current = yawSim3(next, 1) // the scan's own sessionToProject
  const sessionCentres = Array.from({ length: 20 }, () => randomPoint(next, 4))

  // The solve puts the scan 7 degrees about up and 0.3 m / 0.05 m / -0.2 m from where its calibration does.
  const move: Sim3 = { rotation: rotY(7), translation: [0.3, 0.05, -0.2], scale: 1 }
  const registered = composeSim3(move, current)
  const result = describeCorrection(registered, sim3ToColumnMajor(current), sessionCentres)!
  assert(result)

  // The same numbers worked out from the points: where the middle of the scan sits now and where it would sit.
  const now = sessionCentres.map((c) => applySim3(current, c))
  const mean = now.reduce<Vec3Tuple>((acc, p) => [acc[0] + p[0] / 20, acc[1] + p[1] / 20, acc[2] + p[2] / 20], [0, 0, 0])
  const moved = applySim3(move, mean)
  assert(Math.abs(result.bounded.translationM - Math.hypot(moved[0] - mean[0], moved[2] - mean[2])) < 1e-9)
  assert(Math.abs(result.bounded.dyM - (moved[1] - mean[1])) < 1e-9)
  assert(Math.abs(result.bounded.yawDeg - 7) < 1e-9, `${result.bounded.yawDeg}`)
  assert(result.tiltDeg < 1e-6)
  assert(Math.abs(result.scale - 1) < 1e-12)
  assertEquals(result.bounded.withinBound, true)
  assert(result.bounded.maxShiftM >= result.bounded.translationM - 1e-9)

  // Applying the correction to the scan's calibration gives the registration: new = correction . current.
  assert(matricesAgree(multiplyMat4(result.transform, sim3ToColumnMajor(current)), sim3ToColumnMajor(registered), 1e-9))
})

Deno.test('a turn of the other sign is read as the other sign', () => {
  const next = mulberry32(112)
  const current = yawSim3(next, 1)
  const centres = Array.from({ length: 6 }, () => randomPoint(next, 4))
  const left = describeCorrection(composeSim3({ rotation: rotY(-12), translation: [0, 0, 0], scale: 1 }, current), sim3ToColumnMajor(current), centres)!
  assert(Math.abs(left.bounded.yawDeg + 12) < 1e-9)
  // 12 degrees is past the matcher's 10-degree limit.
  assertEquals(left.bounded.withinBound, false)
})

Deno.test('a correction past the matcher\'s limits is reported as outside them, with the limits', () => {
  const next = mulberry32(113)
  const current = yawSim3(next, 1)
  const centres = Array.from({ length: 6 }, () => randomPoint(next, 4))
  const far = describeCorrection(composeSim3({ rotation: rotY(2), translation: [1.5, 0, 0], scale: 1 }, current), sim3ToColumnMajor(current), centres)!
  assertEquals(far.bounded.withinBound, false)
  assertEquals(far.bounded.bound, { translationM: 1, yawDeg: 10, dyM: 0.3 })
  const high = describeCorrection(composeSim3({ rotation: rotY(1), translation: [0, 0.5, 0], scale: 1 }, current), sim3ToColumnMajor(current), centres)!
  assertEquals(high.bounded.withinBound, false)
})

Deno.test('a registration that tips the up axis or changes the unit says so beside the correction', () => {
  const next = mulberry32(114)
  const current = yawSim3(next, 1)
  const centres = Array.from({ length: 6 }, () => randomPoint(next, 4))
  const aboutX: M3 = [[1, 0, 0], [0, Math.cos(0.2), -Math.sin(0.2)], [0, Math.sin(0.2), Math.cos(0.2)]]
  const tipped = composeSim3({ rotation: aboutX, translation: [0, 0, 0], scale: 1.1 }, current)
  const result = describeCorrection(tipped, sim3ToColumnMajor(current), centres)!
  assert(Math.abs(result.tiltDeg - (0.2 * 180) / Math.PI) < 1e-9, `${result.tiltDeg}`)
  assert(Math.abs(result.scale - 1.1) < 1e-12)
})

Deno.test('describeCorrection answers null for a calibration that is not a similarity, or for no centres', () => {
  const s = yawSim3(mulberry32(115), 1)
  const bad = sim3ToColumnMajor(s)
  bad[0] = bad[0]! * 2
  assertEquals(describeCorrection(s, bad, [[0, 0, 0]]), null)
  assertEquals(describeCorrection(s, sim3ToColumnMajor(s), []), null)
})

// ─── The reader, held to what a similarity is ────────────────────────────────

Deno.test('columns of one length that are not at right angles are not a similarity', () => {
  // x and y images of the same length, five degrees short of perpendicular: the bottom row is right, the determinant is
  // positive, the lengths agree. Only the angle between the columns says it is a shear and not a turn.
  const k = 1.2
  const phi = 0.09
  const skewed = [
    k, 0, 0, 0,
    k * Math.sin(phi), k * Math.cos(phi), 0, 0,
    0, 0, k, 0,
    1, 2, 3, 1,
  ]
  assertEquals(sim3FromColumnMajor(skewed), null)
  // Squared back up to a right angle it reads.
  assert(sim3FromColumnMajor([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 1, 2, 3, 1]))
})

Deno.test('a calibration stored at float32 or six decimals is still read; five decimals is not, and nothing the app writes is rounded', () => {
  // SIM3_TOLERANCE is 1e-6 and the app writes sessionToProject as full doubles (nothing in src/ or server/ rounds it). The two
  // lossy storages a matrix could plausibly meet are read; a hand-rounded one is refused rather than guessed at.
  const next = mulberry32(300)
  let refusedAtFive = 0
  for (let trial = 0; trial < 200; trial++) {
    const m = composeYUpTransform({ x: (next() - 0.5) * 40, y: (next() - 0.5) * 3, z: (next() - 0.5) * 40 }, next() * 360, 1)
    assert(sim3FromColumnMajor(Array.from(new Float32Array(m))), `float32, trial ${trial}`)
    assert(sim3FromColumnMajor(m.map((v) => Number(v.toFixed(6)))), `six decimals, trial ${trial}`)
    if (!sim3FromColumnMajor(m.map((v) => Number(v.toFixed(5))))) refusedAtFive++
  }
  assert(refusedAtFive > 100, `${refusedAtFive} of 200 refused at five decimals`)
})

// ─── What a refused fit still says ───────────────────────────────────────────

Deno.test('a fit refused for its residual carries the scale it had, in solver units per session unit', () => {
  const world = makeWorld(121, ['sess-ref', 'sess-big'], [1, 1.5], 0.02)
  const big = world.sessions[1]!
  const refused = fitWorldSession(big, { maxResidualM: 0.001 })
  assert(!refused.ok)
  assertEquals(refused.reason, 'high-residual')
  const expected = world.solver.scale * 1.5
  assert(Math.abs(Math.abs(expected - 1 / expected)) > 0.3, 'a scale that is not its own inverse, so the two can be told apart')
  assert(Math.abs(refused.umeyamaScale! / expected - 1) < 0.03, `${refused.umeyamaScale} for a true ${expected}`)
  // The same number as the fit that was accepted would have carried.
  const accepted = fitWorldSession(big)
  assert(accepted.ok)
  assert(Math.abs(refused.umeyamaScale! - accepted.sessionToSolver.scale) < 1e-12)
})

// ─── A reference whose calibration has a scale ───────────────────────────────

Deno.test('the unit mismatch between sessions is kept apart from the scale of the reference\'s own calibration', () => {
  // The known-distance tier writes a scale into sessionToProject. A reference like that is read, and the registration
  // is then in the reference's units times the mismatch: sessionToPlace.scale says so, scaleRatioToReference does not.
  const world = makeWorld(131, ['sess-ref', 'sess-a'], [1.3, 1.3 * 1.2], 0.01)
  const { results } = register(world, ['sess-ref', 'sess-a'])
  const r = results[0]!
  assert(r.ok)
  assert(Math.abs(r.scaleRatioToReference - 1.2) < 0.02, `${r.scaleRatioToReference}`)
  assert(Math.abs(r.sessionToPlace.scale - 1.56) < 0.03, `${r.sessionToPlace.scale}`)
  assert(Math.abs(sim3FromColumnMajor(r.sessionToPlaceColumnMajor)!.scale - r.sessionToPlace.scale) < 1e-12, 'the matrix carries the placement scale')
  assert(Math.abs(r.residualPlaceM - r.residualSessionUnits * r.sessionToPlace.scale) < 1e-12)
  assert(Math.abs(r.residualPlaceM - r.residualSessionUnits * r.scaleRatioToReference) > 1e-4, 'and not the ratio alone')
})

// ─── The up axis ─────────────────────────────────────────────────────────────

/** Rodrigues' rotation by `deg` about the unit `axis`. */
function aboutAxis(axis: Vec3Tuple, deg: number): M3 {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  const [x, y, z] = axis
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ]
}

/** One session of a world, its solved centres turned by `deg` about an axis across the solver's up, so the solve tips it by exactly that. */
function tippedBy(world: World, session: World['sessions'][number], deg: number) {
  const up = mulVec(world.solver.rotation as M3, [0, 1, 0])
  const other: Vec3Tuple = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const cross: Vec3Tuple = [up[1] * other[2] - up[2] * other[1], up[2] * other[0] - up[0] * other[2], up[0] * other[1] - up[1] * other[0]]
  const n = Math.hypot(...cross)
  const q = aboutAxis([cross[0] / n, cross[1] / n, cross[2] / n], deg)
  return new Map([...session.solverCentres].map(([key, c]) => [key, mulVec(q, c)] as const))
}

Deno.test('through a correct solve two gravity-aligned sessions keep their up axes parallel, and the registration records it', () => {
  const world = makeWorld(141, ['sess-ref', 'sess-a', 'sess-b'], [1, 1, 1.1])
  const { results } = register(world, ['sess-ref', 'sess-a', 'sess-b'])
  for (const r of results) {
    assert(r.ok)
    assert(r.tiltDeg < 1e-6, `${r.tiltDeg} degrees`)
  }
})

Deno.test('a session the solve tips past the limit is refused with the angle, and the limit is a parameter', () => {
  const world = makeWorld(142, ['sess-ref', 'sess-a'], [1, 1])
  const [ref, a] = world.sessions
  const reference = { sessionId: ref!.id, sessionToProject: sim3ToColumnMajor(ref!.truth), fit: fitWorldSession(ref!) }
  const registerTipped = (deg: number, options?: { maxTiltDeg?: number }) =>
    registerSessionsToReference(reference, [{ sessionId: a!.id, fit: fitWorldSession(a!, { solverCentres: tippedBy(world, a!, deg) }) }], options)[0]!

  assertEquals(MAX_UP_AXIS_TILT_DEG, 5)
  const fine = registerTipped(4)
  assert(fine.ok)
  assert(Math.abs(fine.tiltDeg - 4) < 1e-6, `${fine.tiltDeg}`)

  const tipped = registerTipped(6)
  assert(!tipped.ok)
  assertEquals(tipped.reason, 'up-axis-disagrees')
  assert(Math.abs(tipped.tiltDeg! - 6) < 1e-6, `${tipped.tiltDeg}`)
  assert(tipped.message.includes('sess-a') && tipped.message.includes('sess-ref') && tipped.message.includes('6.0 degrees') && tipped.message.includes('5 degree'), tipped.message)
  assertEquals(tipped.correspondenceCount, 24)

  // A turn on the far side of the sphere, and a flip, are refused the same way.
  assertEquals(registerTipped(90).ok, false)
  assertEquals(registerTipped(180).ok, false)
  assert(Math.abs(registerTipped(180).tiltDeg! - 180) < 1e-6, 'the angle is exact all the way round')

  // The limit is a parameter, and is inclusive: a session at exactly the limit is registered, a hair past it is not.
  const exact = tipped.tiltDeg!
  assert(registerTipped(6, { maxTiltDeg: exact }).ok)
  assertEquals(registerTipped(6, { maxTiltDeg: exact - 1e-9 }).ok, false)
  assert(registerTipped(60, { maxTiltDeg: 90 }).ok)
})

/** Seeded draws, so the simulations below are the same on every run. */
function draws(seed: number) {
  const next = mulberry32(seed)
  return { next, gauss: () => gaussian(next) }
}

/** A loop of camera centres round a room, the way a walk goes: `radius` wide, with a little wobble in height. */
function loop(next: () => number, count: number, radius: number, heightSd = 0.05): Vec3Tuple[] {
  const phase = next() * 2 * Math.PI
  return Array.from({ length: count }, (_, i): Vec3Tuple => {
    const a = phase + (i / count) * 2 * Math.PI * (0.6 + 0.4 * next())
    return [2.5 + radius * Math.cos(a) * (0.8 + 0.4 * next()), 1.4 + (next() - 0.5) * 2 * heightSd, 2 + radius * 0.8 * Math.sin(a) * (0.8 + 0.4 * next())]
  })
}

Deno.test('the up-axis gate keeps correct registrations and stops a handful of wrongly registered frames', () => {
  // The numbers in MAX_UP_AXIS_TILT_DEG's comment, in small. A correct registration: both sessions on a loop of radius
  // 1.2 m, 3 cm of noise on every recorded centre, 8 frames in the new one. A wrong one: 4 frames COLMAP placed 0.5 m
  // from where they were, which the residual gate lets through now and then and the up axes do not.
  const { next, gauss } = draws(5150)
  const unitSolver = (): Sim3 => ({ rotation: randomRotation(next), translation: [(next() - 0.5) * 10, (next() - 0.5) * 10, (next() - 0.5) * 10], scale: 0.4 + next() })
  const session = (id: string, truth: Sim3, solver: Sim3, place: Vec3Tuple[], arNoise: number, solverOffset: number) => {
    const inverse = invertSim3(truth)
    const ar = new Map<string, Vec3Tuple>()
    const sv = new Map<string, Vec3Tuple>()
    place.forEach((p, i) => {
      const a = applySim3(inverse, p)
      const b = applySim3(solver, p)
      ar.set(`${id}/kf-${i}.jpg`, [a[0] + gauss() * arNoise, a[1] + gauss() * arNoise, a[2] + gauss() * arNoise])
      sv.set(`${id}/kf-${i}.jpg`, [b[0] + gauss() * (solverOffset || 0.01) * solver.scale, b[1] + gauss() * (solverOffset || 0.01) * solver.scale, b[2] + gauss() * (solverOffset || 0.01) * solver.scale])
    })
    return { ar, sv }
  }
  let kept = 0
  let throughResidualOnly = 0
  let throughBoth = 0
  const TRIALS = 600
  for (let t = 0; t < TRIALS; t++) {
    const solver = unitSolver()
    const truthRef = yawSim3(next, 1)
    const truthNew = yawSim3(next, 1)
    const ref = session('sess-ref', truthRef, solver, loop(next, 14, 1.2), 0.03, 0)
    const reference = { sessionId: 'sess-ref', sessionToProject: sim3ToColumnMajor(truthRef), fit: fitSessionToSolver({ sessionId: 'sess-ref', sessionCentres: ref.ar, solverCentres: ref.sv }) }

    const right = session('sess-new', truthNew, solver, loop(next, 8, 1.2), 0.03, 0)
    const rightRegistration = registerSessionsToReference(reference, [{ sessionId: 'sess-new', fit: fitSessionToSolver({ sessionId: 'sess-new', sessionCentres: right.ar, solverCentres: right.sv }) }])[0]!
    if (rightRegistration.ok) kept++

    // Wrong: the same frames, but each solved 0.5 m (per axis, in Place metres) from where it was.
    const wrong = session('sess-new', truthNew, solver, loop(next, 4, 1.2), 0, 0.5 / solver.scale)
    const wrongFit = fitSessionToSolver({ sessionId: 'sess-new', sessionCentres: wrong.ar, solverCentres: wrong.sv })
    if (wrongFit.ok) {
      throughResidualOnly++
      if (registerSessionsToReference(reference, [{ sessionId: 'sess-new', fit: wrongFit }])[0]!.ok) throughBoth++
    }
  }
  assert(kept >= TRIALS * 0.97, `${kept} of ${TRIALS} correct registrations kept`)
  // Measured at 20,000 trials: 7% pass the residual gate at 4 frames and 0.35% pass both. Here, 600 draws: wide margins.
  assert(throughResidualOnly >= TRIALS * 0.015, `${throughResidualOnly}: the residual gate alone lets some through, or this proves nothing`)
  assert(throughBoth <= Math.max(2, throughResidualOnly * 0.15), `${throughBoth} of ${throughResidualOnly} got past the up axes as well`)
})

Deno.test('a mirror image of a nearly flat camera path is fitted, and of a path with some height to it is not: the limit the header states', () => {
  // The solver's frame is the Place frame mirrored in x. Every session's cameras walk a loop; only the spread of their
  // heights separates the mirror from the real thing, because the proper rotation the fit is held to can turn a flat path over.
  const { next, gauss } = draws(5151)
  const rate = (heightSd: number): { registered: number; medianError: number } => {
    const errors: number[] = []
    for (let t = 0; t < 100; t++) {
      const truths = [yawSim3(next, 1), yawSim3(next, 1)]
      const sessions = truths.map((truth, s) => {
        const id = s ? 'sess-new' : 'sess-ref'
        const inverse = invertSim3(truth)
        const ar = new Map<string, Vec3Tuple>()
        const sv = new Map<string, Vec3Tuple>()
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * 2 * Math.PI + next() * 0.2
          const r = 1 + next() * 1.2
          const p: Vec3Tuple = [2 + r * Math.cos(a), 1.3 + gauss() * heightSd, 2 + r * Math.sin(a)]
          ar.set(`${id}/kf-${i}.jpg`, applySim3(inverse, p))
          sv.set(`${id}/kf-${i}.jpg`, [-p[0] + 3, p[1] + 1, p[2] - 2])
        }
        return { id, ar, sv }
      })
      const fits = sessions.map((s) => fitSessionToSolver({ sessionId: s.id, sessionCentres: s.ar, solverCentres: s.sv }))
      const registration = registerSessionsToReference({ sessionId: 'sess-ref', sessionToProject: sim3ToColumnMajor(truths[0]!), fit: fits[0]! }, [{ sessionId: 'sess-new', fit: fits[1]! }])[0]!
      if (!registration.ok) continue
      let worst = 0
      for (const centre of sessions[1]!.ar.values()) {
        const got = applySim3(registration.sessionToPlace, centre)
        const want = applySim3(truths[1]!, centre)
        worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]))
      }
      errors.push(worst)
    }
    errors.sort((a, b) => a - b)
    return { registered: errors.length, medianError: errors[Math.floor(errors.length / 2)] ?? NaN }
  }
  const flat = rate(0.05)
  const wobbly = rate(0.3)
  // Measured at 100 trials a spread: 99 registered at a 5 cm spread (the cameras themselves 7 cm off, median), 85 at 10 cm, 5 at 15 cm, none from 30 cm.
  assert(flat.registered >= 90, `${flat.registered} of 100 mirrored flat paths registered`)
  assert(flat.medianError > 0.03, `the cameras are not where they were: ${flat.medianError} m`)
  assertEquals(wobbly.registered, 0, 'a path with height to it shows the mirror')
})

Deno.test('a turn about up reports no tilt, to rounding', () => {
  // acos(r11) for a rotation about +Y is acos(1 - 1e-16) and loses everything under about 1e-6 degrees.
  const next = mulberry32(160)
  const current = yawSim3(next, 1)
  const centres = Array.from({ length: 6 }, () => randomPoint(next, 4))
  let worst = 0
  for (let t = 0; t < 200; t++) {
    const registered = composeSim3({ rotation: rotY((next() - 0.5) * 60), translation: [(next() - 0.5) * 2, 0, (next() - 0.5) * 2], scale: 1 }, current)
    worst = Math.max(worst, describeCorrection(registered, sim3ToColumnMajor(current), centres)!.tiltDeg)
  }
  assert(worst < 1e-9, `${worst} degrees of tilt for a pure turn`)
})

Deno.test('a correction downward past the height limit is outside it, as one upward is', () => {
  const next = mulberry32(161)
  const current = yawSim3(next, 1)
  const centres = Array.from({ length: 6 }, () => randomPoint(next, 4))
  const at = (dy: number) => describeCorrection(composeSim3({ rotation: rotY(0), translation: [0, dy, 0], scale: 1 }, current), sim3ToColumnMajor(current), centres)!.bounded
  assertEquals(at(0.2).withinBound, true)
  assertEquals(at(-0.2).withinBound, true)
  assertEquals(at(0.4).withinBound, false)
  assertEquals(at(-0.4).withinBound, false)
  assert(Math.abs(at(-0.4).dyM + 0.4) < 1e-9)
})

Deno.test('the largest shift is the largest over every centre, not the first, the last, or the first that moved', () => {
  // The scan's own calibration is the identity. The solve turns it 10 degrees about the origin, so a centre r from the
  // origin moves r x 2 sin(5 degrees): 0.174 m for the first listed, 0.697 m for the second (the largest), 0.349 m for
  // the third, and none for the last, which is at rest.
  const identity: Sim3 = identitySim3()
  const result = describeCorrection({ rotation: rotY(10), translation: [0, 0, 0], scale: 1 }, sim3ToColumnMajor(identity), [[1, 0, 0], [4, 0, 0], [2, 0, 0], [0, 0, 0]])!
  assert(Math.abs(result.bounded.maxShiftM - 8 * Math.sin((5 * Math.PI) / 180)) < 1e-12, `${result.bounded.maxShiftM}`)
  assert(result.bounded.maxShiftM > result.bounded.translationM, 'larger than the shift at the middle of the scan')
})

Deno.test('a tilt a millionth of a degree is reported as that, which an arccosine cannot', () => {
  // cos(1e-6 degrees) is 1 - 1.5e-16, which a double rounds to a neighbour of 1: the arccosine gives 0.85e-6 or 0.
  const next = mulberry32(163)
  const current = yawSim3(next, 1)
  const centres = Array.from({ length: 6 }, () => randomPoint(next, 4))
  for (const tiny of [1e-6, 3e-5, 1e-3]) {
    const tipped = composeSim3({ rotation: aboutAxis([1, 0, 0], tiny), translation: [0, 0, 0], scale: 1 }, current)
    const result = describeCorrection(tipped, sim3ToColumnMajor(current), centres)!
    assert(Math.abs(result.tiltDeg - tiny) < tiny * 1e-6, `${tiny} degrees came back as ${result.tiltDeg}`)
  }
})

Deno.test('a correction is worked out against a calibration that has a scale of its own', () => {
  // A scan whose sessionToProject is a scaled similarity (the known-distance tier): the correction still turns its current
  // placement into the registered one, point for point.
  const next = mulberry32(162)
  const current = yawSim3(next, 1.4)
  const move: Sim3 = { rotation: rotY(6), translation: [0.2, 0.04, -0.1], scale: 1.05 }
  const registered = composeSim3(move, current)
  const centres = Array.from({ length: 8 }, () => randomPoint(next, 4))
  const result = describeCorrection(registered, sim3ToColumnMajor(current), centres)!
  const correction = sim3FromColumnMajor(result.transform)!
  for (const c of centres) assertNear(applySim3(correction, applySim3(current, c)), applySim3(registered, c), 1e-9, 'correction . current')
  assert(Math.abs(result.scale - 1.05) < 1e-12)
})
