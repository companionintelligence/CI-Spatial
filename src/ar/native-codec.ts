/**
 * Pure conversions for the native AR provider: the ScanAR plugin's wire format
 * (column-major 4×4 matrices, base64 payloads, native tracking strings) into the
 * shapes the scanner uses. No DOM and no Capacitor, so Node tests every branch.
 */
import type { Pose } from './provider.ts'
import type { TrackingStatus } from './tracking-quality.ts'
import { REASON_RELOCALIZING } from './frame-epoch.ts'

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Little-endian Float32 values from base64. Throws unless the payload holds exactly `count` values. */
export function decodeFloat32Base64(base64: string, count: number): Float32Array {
  const bytes = base64ToBytes(base64)
  if (bytes.byteLength !== count * 4) {
    throw new Error(`float payload is ${bytes.byteLength} bytes, expected ${count * 4}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const values = new Float32Array(count)
  for (let i = 0; i < count; i++) values[i] = view.getFloat32(i * 4, true)
  return values
}

/** True when `m` is 16 finite numbers, the shape of a column-major 4×4 matrix. */
export function isMatrix16(m: unknown): m is number[] {
  return Array.isArray(m) && m.length === 16 && m.every((v) => typeof v === 'number' && Number.isFinite(v))
}

export function assertMatrix16(m: unknown, what: string): asserts m is number[] {
  if (!isMatrix16(m)) throw new Error(`${what} must be 16 finite numbers, column-major`)
}

/**
 * Position and rotation from a column-major camera-to-world transform. The rotation is the
 * quaternion of the upper 3×3 block (Shepperd's method), so every branch stays numerically stable.
 */
export function poseFromTransform(m: readonly number[]): Pose {
  assertMatrix16(m, 'transform')
  // Row-major rotation entries r<row><col>, read from the column-major layout.
  const r00 = m[0]
  const r01 = m[4]
  const r02 = m[8]
  const r10 = m[1]
  const r11 = m[5]
  const r12 = m[9]
  const r20 = m[2]
  const r21 = m[6]
  const r22 = m[10]
  const trace = r00 + r11 + r22
  let x: number
  let y: number
  let z: number
  let w: number
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    w = 0.25 * s
    x = (r21 - r12) / s
    y = (r02 - r20) / s
    z = (r10 - r01) / s
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    w = (r21 - r12) / s
    x = 0.25 * s
    y = (r01 + r10) / s
    z = (r02 + r20) / s
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    w = (r02 - r20) / s
    x = (r01 + r10) / s
    y = 0.25 * s
    z = (r12 + r21) / s
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2
    w = (r10 - r01) / s
    x = (r02 + r20) / s
    y = (r12 + r21) / s
    z = 0.25 * s
  }
  return { position: { x: m[12], y: m[13], z: m[14] }, rotation: { x, y, z, w } }
}

/** Vertical field of view in degrees, read from the vertical focal term of a column-major projection. */
export function fovYDegFromProjection(p: readonly number[]): number {
  assertMatrix16(p, 'projection')
  if (!(p[5] > 0)) throw new Error('projection has no positive vertical focal term')
  return (2 * Math.atan(1 / p[5]) * 180) / Math.PI
}

/** Width over height, read from a column-major perspective projection: P[5] / P[0]. */
export function aspectFromProjection(p: readonly number[]): number {
  assertMatrix16(p, 'projection')
  if (!(p[0] > 0) || !(p[5] > 0)) throw new Error('projection has no positive focal terms')
  return p[5] / p[0]
}

/**
 * The provider's tracking status for a native tracking state. Unknown strings read as
 * UNKNOWN rather than NORMAL, so a native layer that adds a state cannot make the scanner
 * believe tracking is good.
 */
export function trackingStatusFromNative(state: string): TrackingStatus {
  switch (state) {
    case 'normal':
      return 'NORMAL'
    case 'notAvailable':
      return 'NOT_AVAILABLE'
    case 'limited.initializing':
      return 'INITIALIZING'
    case 'limited':
    case 'limited.excessiveMotion':
    case 'limited.insufficientFeatures':
    case 'limited.relocalizing':
      return 'LIMITED'
    default:
      return 'UNKNOWN'
  }
}

/**
 * The reason a native tracking state gives for being limited, in the words the tracking code reads (src/ar/frame-epoch.ts,
 * src/ar/tracking-quality.ts), or undefined for a state that names none. The status alone ("LIMITED") says tracking is poor;
 * the reason is what says a relocalization is under way, which is a discontinuity by itself however short it is.
 *
 * Only the reasons the two native layers send are named, each as that layer spells it (ScanARPlugin.swift `describe()`,
 * ScanARRenderer.java `trackingName()`). `relocalizing` is ARKit's alone: ARCore has no relocalization state, so a session on
 * Android never reports one, and nothing here makes one up. A `limited.` state this build does not know reads as no reason, as
 * trackingStatusFromNative() reads it as UNKNOWN: a layer that adds a state cannot make the app believe more than it said.
 */
export function trackingReasonFromNative(state: string): string | undefined {
  switch (state) {
    case 'limited.relocalizing':
      return REASON_RELOCALIZING
    case 'limited.initializing':
      return 'INITIALIZING'
    case 'limited.excessiveMotion':
      return 'EXCESSIVE_MOTION'
    case 'limited.insufficientFeatures':
      return 'INSUFFICIENT_FEATURES'
    default:
      return undefined
  }
}
