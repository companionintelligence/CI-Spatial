/**
 * A short memory of camera poses, so a camera image can be paired with the pose it was taken at
 * rather than the pose the runtime reports now.
 *
 * Why it exists: a tag's pose in the session is the tag's pose in the camera (from the image)
 * carried through the camera's pose in the session. If the pose is not the one the image was exposed
 * at, the tag lands where the camera was, not where the tag is. A phone walked at 0.3 m/s moves 1 cm
 * in 33 ms and turns a few tenths of a degree, which is the size of the error this package is trying
 * to measure.
 *
 * Which frame the pixels of a camera-pixel delivery belong to is a hypothesis this module does not settle: the pixels
 * delivered with a frame may be the image of the previous frame while the pose the runtime reports is the current
 * one. A device run fits the lag (none, one or two frames; DX8 in docs/testing/DEVICE_TESTING.md), and the pairing
 * then asks for the pose at the timestamp the fitted lag names: push every frame's pose here with its timestamp and
 * ask for the pose at that earlier frame's timestamp. The WebXR companion `getUserMedia` stream has no frame
 * timestamp that is comparable with the XR clock at all, so it cannot be synchronised this way; see the WP-14a report.
 *
 * Interpolation is linear for position and spherical for rotation (shortest arc). It never
 * extrapolates, and it refuses to interpolate across a hole in the data.
 *
 * Browser-safe (ADR 0002), no dependency.
 */
import type { Pose } from '../provider.ts'

/** Largest gap between two samples that may be interpolated across, milliseconds. Adopted, not measured: a few frames at 30 fps. */
export const DEFAULT_MAX_GAP_MS = 100
/** How far outside the stored range a request is answered with the nearest sample, milliseconds. Adopted, not measured: under one frame at 30 fps. */
export const DEFAULT_EDGE_TOLERANCE_MS = 20

interface Sample {
  t: number
  pose: Pose
}

function slerp(a: Pose['rotation'], b: Pose['rotation'], u: number): Pose['rotation'] {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let ka: number
  let kb: number
  if (dot > 0.9995) {
    ka = 1 - u
    kb = u
  } else {
    const theta = Math.acos(dot)
    const s = Math.sin(theta)
    ka = Math.sin((1 - u) * theta) / s
    kb = Math.sin(u * theta) / s
  }
  const x = ka * a.x + kb * bx
  const y = ka * a.y + kb * by
  const z = ka * a.z + kb * bz
  const w = ka * a.w + kb * bw
  const n = Math.hypot(x, y, z, w) || 1
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

export class PoseHistory {
  private readonly samples: Sample[] = []
  private readonly capacity: number

  constructor(capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError('a pose history needs room for at least two samples')
    this.capacity = capacity
  }

  get size(): number {
    return this.samples.length
  }

  clear(): void {
    this.samples.length = 0
  }

  /**
   * Record the pose at `timestampMs`. A sample that is not newer than the newest one is ignored
   * (a runtime callback can fire twice for one frame), and a non-finite timestamp or pose is ignored.
   */
  push(pose: Pose, timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) return
    const p = pose.position
    const q = pose.rotation
    if (![p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite)) return
    const last = this.samples[this.samples.length - 1]
    if (last && timestampMs <= last.t) return
    this.samples.push({ t: timestampMs, pose: { position: { x: p.x, y: p.y, z: p.z }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } } })
    if (this.samples.length > this.capacity) this.samples.shift()
  }

  /**
   * The pose at `timestampMs`, interpolated between the two samples around it. Null when there is
   * no sample near enough: the time lies outside the stored range by more than `edgeToleranceMs`
   * (within it the nearest sample is returned, not extrapolated), or the two samples around it are
   * more than `maxGapMs` apart.
   */
  at(timestampMs: number, maxGapMs = DEFAULT_MAX_GAP_MS, edgeToleranceMs = DEFAULT_EDGE_TOLERANCE_MS): Pose | null {
    const s = this.samples
    if (s.length === 0 || !Number.isFinite(timestampMs)) return null
    const first = s[0]!
    const last = s[s.length - 1]!
    if (timestampMs < first.t) return first.t - timestampMs <= edgeToleranceMs ? this.copy(first.pose) : null
    if (timestampMs > last.t) return timestampMs - last.t <= edgeToleranceMs ? this.copy(last.pose) : null
    let lo = 0
    let hi = s.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (s[mid]!.t <= timestampMs) lo = mid
      else hi = mid
    }
    const a = s[lo]!
    const b = s[hi]!
    if (timestampMs === a.t) return this.copy(a.pose)
    if (timestampMs === b.t) return this.copy(b.pose)
    if (b.t - a.t > maxGapMs) return null
    const u = (timestampMs - a.t) / (b.t - a.t)
    return {
      position: {
        x: a.pose.position.x + (b.pose.position.x - a.pose.position.x) * u,
        y: a.pose.position.y + (b.pose.position.y - a.pose.position.y) * u,
        z: a.pose.position.z + (b.pose.position.z - a.pose.position.z) * u,
      },
      rotation: slerp(a.pose.rotation, b.pose.rotation, u),
    }
  }

  private copy(p: Pose): Pose {
    return { position: { ...p.position }, rotation: { ...p.rotation } }
  }
}
