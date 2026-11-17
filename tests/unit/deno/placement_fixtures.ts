/**
 * Matrices the placement tests share (patch_validate.test.ts, patch_routes.test.ts). Not a test file: Deno only runs
 * what is named `*.test.ts`.
 */

/** `size` times a rotation taken from a random unit quaternion, with a translation: what composing a turn into a placement leaves. */
export function rotatedBy(next: () => number, size: number): number[] {
  const q = [next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5]
  const length = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!)
  const [x, y, z, w] = q.map((entry) => entry / length) as [number, number, number, number]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2
  return [
    (1 - (yy + zz)) * size, (xy + wz) * size, (xz - wy) * size, 0,
    (xy - wz) * size, (1 - (xx + zz)) * size, (yz + wx) * size, 0,
    (xz + wy) * size, (yz - wx) * size, (1 - (xx + yy)) * size, 0,
    next() * 10, next() * 3, next() * 10, 1,
  ]
}
