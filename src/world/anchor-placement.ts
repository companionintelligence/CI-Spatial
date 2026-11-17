/**
 * Where the World Editor draws a scan's calibration anchors, in the scan root's
 * own coordinates.
 *
 * A scan root is placed by `scan.localToWorld`. For a calibrated scan that matrix
 * is the capture's session-to-project transform M, so the root's local
 * coordinates are the AR **session** frame, and M carries them into project
 * space. M also pins the calibration's reference down: it sends the tapped
 * landmark L to project zero and, on the two-point tier, the heading marker H to
 * (0, 0, d) with d the separation the session measured. (A visit whose points
 * were fitted to the Place's stored ones, WP-04b, has a least-squares M: it sends
 * each tapped point to within its residual of the stored point, so L lands near
 * zero and not on it, and the pins' gap shows the spacing and not those residuals.)
 *
 * The anchor decal and the red pins are children of that root, so a project-space
 * point P is drawn by placing the child at **inverse(M)·P**, not at P. The editor
 * used to place them at root-local (0,0,0) and (0,0,d), reasoning that "the
 * calibrated reference always maps to project-space zero". That is true of the
 * *world* position and is why the slip was easy to miss, but root-local (0,0,0) is
 * the session origin, which M sends to M's own translation rather than to project
 * zero. Wherever the landmark was not tapped at the session origin — which is
 * everywhere — the decal and the pins were drawn away from the landmark, and a
 * perfect calibration showed as a gap against the white pins.
 *
 * Plain number arrays and no THREE, so Node tests can load it. Matrices are
 * column-major `number[16]`: the layout of `scan.localToWorld`,
 * `THREE.Matrix4.fromArray` and `transformPoint` in ./geo.ts.
 */
import { transformPoint } from './geo.ts'
import type { Vec3 } from './types.ts'

/**
 * Smallest `|det A| / (|c0|·|c1|·|c2|)` treated as invertible, where `A` is the
 * matrix's 3x3 block and `cN` its columns. By Hadamard's inequality the ratio
 * never exceeds 1, and it is exactly 1 for a rotation under any uniform scale,
 * which is every matrix a calibration produces. It measures how degenerate the
 * block is independently of its size; an absolute determinant threshold would
 * reject a legitimately small scale (a scale of 1e-4 has a determinant of 1e-12).
 */
const MIN_RELATIVE_DETERMINANT = 1e-9

function isMatrix16(matrix: unknown): matrix is number[] {
  if (!Array.isArray(matrix) || matrix.length !== 16) return false
  // Indexed rather than `every`, which skips the holes of a sparse array.
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(matrix[i])) return false
  }
  return true
}

/**
 * The inverse of a column-major affine 4x4, or `null` when `matrix` is not 16
 * finite numbers or its 3x3 block is singular.
 *
 * Affine means the bottom row is taken to be (0, 0, 0, 1), exactly as
 * `transformPoint` and `Matrix4.decompose` (which `applyMatrix` in viewer.ts goes
 * through) treat it. The inverse is exact for any invertible block, so a uniform
 * scale, a non-uniform one and a shear all invert; a calibration only ever
 * produces a rotation about Y with an optional uniform scale.
 */
export function invertAffine(matrix: number[]): number[] | null {
  if (!isMatrix16(matrix)) return null

  // The 3x3 block A, by row then column: its columns are matrix[0..2], [4..6]
  // and [8..10]. The translation t is matrix[12..14].
  const a00 = matrix[0]!, a10 = matrix[1]!, a20 = matrix[2]!
  const a01 = matrix[4]!, a11 = matrix[5]!, a21 = matrix[6]!
  const a02 = matrix[8]!, a12 = matrix[9]!, a22 = matrix[10]!
  const tx = matrix[12]!, ty = matrix[13]!, tz = matrix[14]!

  // Cofactors of the first row, which give the determinant by expansion along it.
  const c00 = a11 * a22 - a12 * a21
  const c01 = a12 * a20 - a10 * a22
  const c02 = a10 * a21 - a11 * a20
  const det = a00 * c00 + a01 * c01 + a02 * c02

  const columnsLength = Math.hypot(a00, a10, a20) * Math.hypot(a01, a11, a21) * Math.hypot(a02, a12, a22)
  // Written as a negated `>` so a NaN or an overflowed determinant is rejected too.
  if (!(Math.abs(det) > MIN_RELATIVE_DETERMINANT * columnsLength)) return null

  // B = A⁻¹ = adjugate(A) / det. The adjugate is the transposed cofactor matrix.
  const invDet = 1 / det
  const b00 = c00 * invDet
  const b01 = (a02 * a21 - a01 * a22) * invDet
  const b02 = (a01 * a12 - a02 * a11) * invDet
  const b10 = c01 * invDet
  const b11 = (a00 * a22 - a02 * a20) * invDet
  const b12 = (a02 * a10 - a00 * a12) * invDet
  const b20 = c02 * invDet
  const b21 = (a01 * a20 - a00 * a21) * invDet
  const b22 = (a00 * a11 - a01 * a10) * invDet

  // p = A⁻¹·(p' - t), so the inverse's translation is -A⁻¹·t.
  const result = [
    b00, b10, b20, 0,
    b01, b11, b21, 0,
    b02, b12, b22, 0,
    -(b00 * tx + b01 * ty + b02 * tz),
    -(b10 * tx + b11 * ty + b12 * tz),
    -(b20 * tx + b21 * ty + b22 * tz),
    1,
  ]
  return result.every((entry) => Number.isFinite(entry)) ? result : null
}

export interface SessionAnchorPositions {
  /**
   * The calibration's reference point — the landmark the user tapped — in the
   * scan root's own coordinates. Always present: it is the point `localToWorld`
   * sends to project zero, which every calibration method defines.
   */
  landmark: Vec3
  /**
   * The heading marker, in the scan root's own coordinates: the point that
   * `localToWorld` sends to (0, 0, separationM). Null when no usable separation
   * was given; the viewer hands one over on the `'two-point-ground'` tier only,
   * the one tier that has a heading marker.
   */
  headingMarker: Vec3 | null
}

/**
 * The root-local positions at which a scan root placed by `localToWorld` shows the
 * calibration's reference points — project zero, and `(0, 0, separationM)` — so
 * that once the root's matrix is applied they land on those project-space spots.
 *
 * For a scan that has not been moved since it was calibrated these are the
 * points the user tapped: the landmark L and the heading marker H, with H on the
 * landmark's ground plane.
 *
 * Falls back to the project-space points unchanged, which is what a root with no
 * usable matrix displays, when `localToWorld` is not 16 finite numbers (the viewer's
 * `applyMatrix` ignores a matrix of any other length, leaving the root at identity)
 * or has no inverse. It never returns NaN.
 *
 * @param localToWorld   the scan root's matrix (`scan.localToWorld`)
 * @param separationM    the landmark→heading-marker distance this session measured
 *                       (`scan.calibrationSeparationM`); omit it on the one-point tier
 */
export function sessionAnchorPositions(
  localToWorld: number[],
  separationM?: number | null,
): SessionAnchorPositions {
  const hasHeading = typeof separationM === 'number' && Number.isFinite(separationM) && separationM > 0
  const projectLandmark: Vec3 = { x: 0, y: 0, z: 0 }
  const projectHeading: Vec3 | null = hasHeading ? { x: 0, y: 0, z: separationM } : null

  const projectToSession = invertAffine(localToWorld)
  if (!projectToSession) return { landmark: projectLandmark, headingMarker: projectHeading }

  const landmark = transformPoint(projectToSession, projectLandmark)
  const headingMarker = projectHeading ? transformPoint(projectToSession, projectHeading) : null
  const finite = (p: Vec3 | null): boolean => p === null || [p.x, p.y, p.z].every(Number.isFinite)
  if (!finite(landmark) || !finite(headingMarker)) {
    return { landmark: projectLandmark, headingMarker: projectHeading }
  }
  return { landmark, headingMarker }
}
