/**
 * What a scan's placement may be, what it started as, and how a move is taken back.
 *
 * A scan sits in its Place by one matrix, `ScanManifest.localToWorld`, and the editor's only
 * way to change it is a `scope: 'scan'` EditPatch carrying an absolute matrix. Nothing checked
 * that matrix: sixteen anything was stored and applied, a NaN made the scan vanish, a skewed
 * one smeared it, and the placement the scan arrived with was overwritten, so a bad move could
 * not be taken back. Everything here is pure and works on plain `number[]` column-major
 * matrices (the layout of `localToWorld`, `THREE.Matrix4.fromArray` and `transformPoint` in
 * ./geo.ts), so the Deno server and the editor use the same rules.
 *
 * Deno-API-free on purpose (ADR 0002): the editor imports this file, and so do Node tests.
 *
 * ## The numbers in here are adopted, not measured (ADR 0005 rule 5)
 *
 * - {@link PLACEMENT_SCALE_MIN} and {@link PLACEMENT_SCALE_MAX}, 0.5 and 2, are the range the
 *   alignment investigation (WP-16) proposed for a scan's size. A calibrated capture has scale 1;
 *   only the editor's "Fix size" action should move it, and a factor of two either way is already
 *   a different room. No scan has been measured against that range.
 * - {@link PLACEMENT_TOLERANCE}, 1e-6, is how far a rotation may be from orthonormal. It is far
 *   above double-precision round-off (a rotation turned through thousands of gizmo steps stays
 *   within 1e-12; tests/unit/node/transform_tools.test.ts measures that) and far below anything a
 *   person could see (1e-6 of a 10 m scan is 10 micrometres). What is measured is the round-off
 *   headroom, not the choice of 1e-6.
 */
import type { EditPatch, ScanManifest, TransformPatch, WorldProject } from './types.ts'

/** Smallest size a scan placement may carry. Adopted, not measured (ADR 0005 rule 5). */
export const PLACEMENT_SCALE_MIN = 0.5
/** Largest size a scan placement may carry. Adopted, not measured (ADR 0005 rule 5). */
export const PLACEMENT_SCALE_MAX = 2
/** How far from orthonormal a placement's axes may be. Adopted, not measured (ADR 0005 rule 5). */
export const PLACEMENT_TOLERANCE = 1e-6

export type MatrixRejection =
  | 'not-a-list'
  | 'wrong-length'
  | 'not-finite'
  | 'not-affine'
  | 'degenerate'
  | 'skewed'
  | 'stretched'
  | 'mirrored'
  | 'scale-range'

export type MatrixCheck =
  | {
    ok: true
    /** The common axis length: 1 for a rigid placement. */
    scale: number
  }
  | { ok: false; reason: MatrixRejection; message: string }

type Rejected = Extract<MatrixCheck, { ok: false }>

function rejected(reason: MatrixRejection, message: string): Rejected {
  return { ok: false, reason, message }
}

/** The failure of a value that is not 16 finite numbers with a bottom row of 0, 0, 0, 1, or null. */
function shapeProblem(value: unknown): Rejected | null {
  if (!Array.isArray(value)) return rejected('not-a-list', 'A matrix must be a list of 16 numbers.')
  if (value.length !== 16) return rejected('wrong-length', `A matrix needs 16 numbers, not ${value.length}.`)
  // Indexed rather than `every`, which skips the holes of a sparse array.
  for (let i = 0; i < 16; i++) {
    const entry: unknown = value[i]
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return rejected('not-finite', `A matrix can only hold real numbers, and number ${i + 1} is not one.`)
    }
  }
  const m = value as number[]
  if (
    Math.abs(m[3]!) > PLACEMENT_TOLERANCE || Math.abs(m[7]!) > PLACEMENT_TOLERANCE
    || Math.abs(m[11]!) > PLACEMENT_TOLERANCE || Math.abs(m[15]! - 1) > PLACEMENT_TOLERANCE
  ) {
    return rejected('not-affine', 'The last row of a matrix must be 0, 0, 0, 1.')
  }
  return null
}

interface AxisStats {
  /** Lengths of the three axes (columns of the 3x3 block). */
  s0: number
  s1: number
  s2: number
  /** Dot products of the axis pairs (0,1), (0,2) and (1,2). */
  d01: number
  d02: number
  d12: number
  /** Determinant of the 3x3 block: negative for a mirror. */
  det: number
}

function axisStats(m: number[]): AxisStats {
  const [a0, a1, a2, , b0, b1, b2, , c0, c1, c2] = m as [
    number, number, number, number, number, number, number, number, number, number, number,
  ]
  return {
    s0: Math.hypot(a0, a1, a2),
    s1: Math.hypot(b0, b1, b2),
    s2: Math.hypot(c0, c1, c2),
    d01: a0 * b0 + a1 * b1 + a2 * b2,
    d02: a0 * c0 + a1 * c1 + a2 * c2,
    d12: b0 * c0 + b1 * c1 + b2 * c2,
    det: a0 * (b1 * c2 - b2 * c1) + a1 * (b2 * c0 - b0 * c2) + a2 * (b0 * c1 - b1 * c0),
  }
}

/**
 * Whether `value` may be stored as a scan's placement: 16 finite numbers, a bottom row of
 * 0, 0, 0, 1, a rotation whose axes are at right angles and equally long (within
 * {@link PLACEMENT_TOLERANCE}), no mirror, and a size inside
 * [{@link PLACEMENT_SCALE_MIN}, {@link PLACEMENT_SCALE_MAX}]. The message is for a person.
 *
 * Every matrix a calibration produces passes: a rotation about Y and a translation, size 1.
 */
export function checkPlacementMatrix(value: unknown): MatrixCheck {
  const problem = shapeProblem(value)
  if (problem) return problem
  const stats = axisStats(value as number[])
  const scale = (stats.s0 + stats.s1 + stats.s2) / 3
  if (!(scale > 0)) return rejected('scale-range', 'The scan would shrink to nothing.')
  if (Math.max(Math.abs(stats.s0 - scale), Math.abs(stats.s1 - scale), Math.abs(stats.s2 - scale)) > PLACEMENT_TOLERANCE * scale) {
    return rejected('stretched', 'The scan would be stretched. Its size must change evenly.')
  }
  if (Math.max(Math.abs(stats.d01), Math.abs(stats.d02), Math.abs(stats.d12)) > PLACEMENT_TOLERANCE * scale * scale) {
    return rejected('skewed', 'The scan would be skewed. Its axes must stay at right angles.')
  }
  if (stats.det < 0) return rejected('mirrored', 'The scan would be mirrored.')
  // The ends of the range are inside it. A size of exactly 2 that a turn has been composed into comes out as 2.0000000000000004
  // for a fair share of turns (the placement test sweeps 3000 and counts them), so the range gets the same relative slack as the
  // axes: Fix size can offer 0.5 and 2 and the server takes them.
  if (scale < PLACEMENT_SCALE_MIN * (1 - PLACEMENT_TOLERANCE) || scale > PLACEMENT_SCALE_MAX * (1 + PLACEMENT_TOLERANCE)) {
    return rejected(
      'scale-range',
      `The scan's size must stay between ${PLACEMENT_SCALE_MIN} and ${PLACEMENT_SCALE_MAX} times, and this is ${Number(scale.toPrecision(3))}.`,
    )
  }
  return { ok: true, scale }
}

/**
 * Whether `value` may be stored as the transform of anything that is not a whole scan (an object
 * inside one): 16 finite numbers, an affine bottom row, and a 3x3 block that is not flat. A
 * person may resize an object along one axis, so unlike {@link checkPlacementMatrix} it allows
 * uneven size and skew.
 */
export function checkTransformMatrix(value: unknown): MatrixCheck {
  const problem = shapeProblem(value)
  if (problem) return problem
  const stats = axisStats(value as number[])
  const axes = stats.s0 * stats.s1 * stats.s2
  // The same relative test anchor-placement.ts uses to call a block singular: it does not depend on size.
  if (!(Math.abs(stats.det) > 1e-9 * axes)) return rejected('degenerate', 'The object would be flattened to nothing.')
  return { ok: true, scale: (stats.s0 + stats.s1 + stats.s2) / 3 }
}

/** A copy of `matrix` with every -0 written as 0, so it and its JSON round trip are the same bits. */
export function normaliseZeros(matrix: readonly number[]): number[] {
  return matrix.map((entry) => entry + 0)
}

/**
 * The position, rotation and scale an EditPatch carries beside its matrix, read out of `matrix` the way
 * three.js's `Matrix4.decompose` does (tests/unit/node/transform_tools.test.ts checks them against it).
 * Only `matrix` is applied by anything; the rest is for a reader of the patch log. `matrix` is copied
 * unchanged, which is what makes a reset to a stored placement exact.
 */
export function placementTransform(matrix: readonly number[]): TransformPatch {
  const m = [...matrix] as [
    number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number,
  ]
  const stats = axisStats(m)
  const sx = stats.det < 0 ? -stats.s0 : stats.s0
  const sy = stats.s1
  const sz = stats.s2
  // Divide each axis by its own length to leave a pure rotation (an axis of length 0 cannot be
  // normalised; such a matrix is not a placement, and gets the identity rotation).
  const r = (value: number, scale: number): number => (scale === 0 ? 0 : value / scale)
  const m11 = r(m[0], sx), m21 = r(m[1], sx), m31 = r(m[2], sx)
  const m12 = r(m[4], sy), m22 = r(m[5], sy), m32 = r(m[6], sy)
  const m13 = r(m[8], sz), m23 = r(m[9], sz), m33 = r(m[10], sz)

  let x: number
  let y: number
  let z: number
  let w: number
  const trace = m11 + m22 + m33
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m32 - m23) * s
    y = (m13 - m31) * s
    z = (m21 - m12) * s
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    w = (m32 - m23) / s
    x = 0.25 * s
    y = (m12 + m21) / s
    z = (m13 + m31) / s
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    w = (m13 - m31) / s
    x = (m12 + m21) / s
    y = 0.25 * s
    z = (m23 + m32) / s
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
    w = (m21 - m12) / s
    x = (m13 + m31) / s
    y = (m23 + m32) / s
    z = 0.25 * s
  }
  const finite = [x, y, z, w].every(Number.isFinite)
  return {
    matrix: [...matrix],
    position: { x: m[12], y: m[13], z: m[14] },
    rotation: finite ? { x, y, z, w } : { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: sx, y: sy, z: sz },
  }
}

// ─── The log of placement patches ────────────────────────────────────────────

type ScanKey = Pick<ScanManifest, 'scanId' | 'filename'>

/**
 * A patch that sets a whole scan's placement: scope 'scan' and a matrix. An entry that is not a patch at all (a world file
 * edited by hand or cut short can hold one) is not one, and reading the log past it must not fail every read of the world.
 */
export function isScanPlacementPatch(patch: EditPatch): boolean {
  return !!patch && typeof patch === 'object' && patch.scope === 'scan' && Array.isArray(patch.transform?.matrix)
}

/**
 * Whether `patch` is about `scan`: the match the server (applyPatchToWorld) and the editor
 * (applyStoredPatches) both make, by scan id or by the scan's filename as the target.
 */
export function patchTargetsScan(patch: EditPatch, scan: ScanKey): boolean {
  return patch.scanId === scan.scanId || patch.targetId === scan.filename
}

/**
 * The placement patches of `scan` that still count, oldest first. A patch an undo record names is out,
 * and so is the undo record itself: it only carries a matrix so that replaying the log needs no
 * special case. Taking the last entry is therefore "the move an undo would take back", and taking
 * it twice steps back past the first undo instead of redoing the move.
 */
export function liveScanPlacementPatches(patches: readonly EditPatch[], scan: ScanKey): EditPatch[] {
  const undone = new Set<string>()
  for (const patch of patches) {
    if (patch?.revertsPatchId) undone.add(patch.revertsPatchId)
  }
  return patches.filter((patch) =>
    isScanPlacementPatch(patch)
    && patchTargetsScan(patch, scan)
    && !patch.revertsPatchId
    && !undone.has(patch.patchId))
}

export type RevertPlan =
  | {
    ok: true
    scan: ScanManifest
    /** The patch the undo takes back. */
    target: EditPatch
    /** The placement the scan gets back: a copy, safe to store. */
    matrix: number[]
    restoredTo: 'earlier-move' | 'first-placement'
  }
  | { ok: false; status: 404 | 409; message: string }

/**
 * What undoing the last saved move of a scan would do, or why it cannot be done.
 *
 * With `scanId` it is that scan's last live placement patch. Without it, the newest one in the
 * whole log, whichever scan it belongs to. With `patchId` the undo is refused unless that is the
 * patch about to be taken back, so a request made from a stale view (or replayed later from the
 * offline queue) cannot undo a different move than the one the person saw.
 *
 * The scan goes back to the nearest earlier live move whose matrix is a valid placement, or, with
 * none, to its stored first placement. Both are checked, because the log can hold matrices from
 * before they were validated, and an undo must never put a scan somewhere that makes it vanish.
 */
export function planRevert(
  world: Pick<WorldProject, 'scans' | 'editPatches'>,
  request: { scanId?: string | null; patchId?: string | null },
): RevertPlan {
  const scans = request.scanId ? world.scans.filter((scan) => scan.scanId === request.scanId) : world.scans
  if (request.scanId && scans.length === 0) return { ok: false, status: 404, message: 'Scan not found in this Place.' }

  let best: { scan: ScanManifest; live: EditPatch[]; index: number } | null = null
  for (const scan of scans) {
    const live = liveScanPlacementPatches(world.editPatches, scan)
    const last = live[live.length - 1]
    if (!last) continue
    const index = world.editPatches.indexOf(last)
    if (!best || index > best.index) best = { scan, live, index }
  }
  if (!best) return { ok: false, status: 409, message: 'There is no saved move to undo.' }

  const target = best.live[best.live.length - 1]!
  if (request.patchId && request.patchId !== target.patchId) {
    return { ok: false, status: 409, message: 'This scan was changed after you opened it. Reload the Place and try again.' }
  }

  for (let i = best.live.length - 2; i >= 0; i--) {
    const earlier = best.live[i]!.transform?.matrix
    if (checkPlacementMatrix(earlier).ok) {
      return { ok: true, scan: best.scan, target, matrix: [...earlier!], restoredTo: 'earlier-move' }
    }
  }
  const first = best.scan.calibratedLocalToWorld
  if (checkPlacementMatrix(first).ok) {
    return { ok: true, scan: best.scan, target, matrix: [...first!], restoredTo: 'first-placement' }
  }
  return {
    ok: false,
    status: 409,
    message: 'The placement this scan started with was not stored, so its first move cannot be undone.',
  }
}

/** The patch an undo records: an ordinary scan patch carrying the placement the scan gets back. */
export function buildRevertPatch(
  worldId: string,
  plan: Extract<RevertPlan, { ok: true }>,
  stamp: { patchId: string; actorId: string; createdAt: string },
): EditPatch {
  return {
    patchId: stamp.patchId,
    worldId,
    scanId: plan.scan.scanId,
    targetId: plan.scan.filename,
    scope: 'scan',
    transform: placementTransform(plan.matrix),
    actorId: stamp.actorId,
    revertsPatchId: plan.target.patchId,
    createdAt: stamp.createdAt,
  }
}

// ─── The placement a scan arrived with ───────────────────────────────────────

/**
 * What to store as a scan's first placement, or null when there is nothing trustworthy to store.
 *
 * A calibration the upload carried (its sidecar's `projectTransform`, when it is a valid placement) is the
 * scan's calibrated placement, and it is read whether or not the row is at it: a row freezes the placement it
 * had when it was first built, and one built before its sidecar was readable sits by GPS or the grid while the
 * sidecar says where the calibration put it. The calibration is what "Reset to calibrated" has to go back to.
 *
 * With no usable calibration, a scan nobody has patched still sits where it was first put, so its current
 * matrix is its first placement. A scan that has been patched lost that matrix when the first patch
 * overwrote it, and a GPS or grid placement has no record anywhere else, so a scan like that which was moved
 * before this field existed gets no first placement rather than a guessed one. Either way the value must be
 * a valid placement, or a reset to it would be refused by the same check that guards every patch.
 */
function firstSightMatrix(scan: ScanManifest, patched: boolean, sidecarProjectTransform: unknown): number[] | null {
  if (checkPlacementMatrix(sidecarProjectTransform).ok) return normaliseZeros(sidecarProjectTransform as number[])
  if (patched) return null
  return checkPlacementMatrix(scan.localToWorld).ok ? normaliseZeros(scan.localToWorld) : null
}

/**
 * Give every scan in `world` that has no `calibratedLocalToWorld` its first placement, and leave
 * every scan that has one alone: the value is written once and never overwritten, whatever the
 * sidecar or the row says later. Returns whether anything was written, so the caller knows to
 * save the world.
 *
 * Runs inside the world's lock (ADR 0004), on every read, before any patch is applied: a patch
 * always reaches a world that has already been stamped, so `localToWorld` is still the first
 * placement at the moment of stamping for any scan that has no patch yet.
 *
 * The stamp is only as good as what can be read when it is taken. The upload route stores a scan's
 * sidecar before its .glb can be listed (server/world/scan_store.ts), so a scan that came through it is
 * never first seen without its calibration. A .glb copied into the scans directory by hand ahead of its
 * sidecar can be, and is then stamped from the placement its row was given; the stamp is not corrected
 * afterwards, because a stamp that can change is no longer the placement a bad move can be taken back to.
 *
 * @param sidecarProjectTransformFor the `projectTransform` of a scan's upload sidecar, by filename
 */
export function stampFirstSightPlacements(
  world: Pick<WorldProject, 'scans' | 'editPatches'>,
  sidecarProjectTransformFor: (filename: string) => unknown,
): boolean {
  // Once, not once per scan: a world with hundreds of scans and thousands of patches is read on every request.
  const patchedScanIds = new Set<string>()
  const patchedFilenames = new Set<string>()
  for (const patch of world.editPatches) {
    if (!isScanPlacementPatch(patch)) continue
    if (patch.scanId) patchedScanIds.add(patch.scanId)
    patchedFilenames.add(patch.targetId)
  }

  let changed = false
  for (const scan of world.scans) {
    if (scan.calibratedLocalToWorld !== undefined) continue
    const patched = patchedScanIds.has(scan.scanId) || patchedFilenames.has(scan.filename)
    const matrix = firstSightMatrix(scan, patched, sidecarProjectTransformFor(scan.filename))
    if (!matrix) continue
    scan.calibratedLocalToWorld = matrix
    changed = true
  }
  return changed
}
