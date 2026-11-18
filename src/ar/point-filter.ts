/**
 * Which SLAM points a scan keeps.
 *
 * Shared by the 8th Wall provider (eighthwall.ts) and the native ARKit / ARCore provider
 * (native.ts), so every runtime applies one distance rule. Moved here unchanged from
 * eighthwall.ts: the reasoning in the comments below is the 8th Wall reasoning.
 *
 * It does not decide when the camera has moved too far between two frames: that is FrameEpochTracker's (./frame-epoch.ts),
 * for every runtime. The flat 0.30 m rule that was kept here (`POSE_JUMP_THRESHOLD_M`) is gone: only the native provider read it,
 * and it uses that tracker now.
 */
import type { Pose } from './provider'

type Point3 = { x: number; y: number; z: number }

export const MIN_POINT_DISTANCE_M = 0.08

/**
 * Farthest a SLAM feature may be from the camera and still be recorded.
 *
 * Was 50m, which is an outdoor number and is what set every indoor scan's
 * bounding box. SLAM depth comes from triangulating a feature across frames, so
 * its error grows with range against the baseline the camera actually travelled
 * — and this app's main rig is a gimbal that ROTATES IN PLACE, giving a baseline
 * near zero. Far-field depth is then guesswork, and the guesses pile up against
 * whatever ceiling this constant sets.
 *
 * Measured on a real 21-position gimbal dome of one room (2026-08-27), by
 * distance from each point to the nearest recorded camera pose:
 *
 *     cap    kept          extent (w x h x d)
 *      50m   6377 (100%)   61.0 x 49.6 x 54.3 m      <- outdoor cap, absurd for a room
 *      20m   5898 (92.5%)  23.8 x 12.0 x 25.0 m
 *      12m   5531 (86.7%)  15.9 x 11.0 x 15.0 m      <- here
 *      10m   5362 (84.1%)  12.8 x 11.0 x 12.8 m
 *       8m   5041 (79.0%)  10.9 x  8.4 x 10.4 m
 *
 * 12m keeps the large majority of points while bringing the cloud back to room
 * scale. That matters beyond tidiness: the bounding box is what splat-align and
 * COLMAP key their metric fit off, so a 61m box makes the whole reconstruction's
 * scale wrong by an order of magnitude while still looking plausible in the
 * viewer. Headroom above a typical room is deliberate — a view down a hallway or
 * through a doorway is real geometry worth keeping.
 *
 * This does NOT manufacture parallax; it only stops unreliable far-field points
 * from setting the scale. A capture that needs true far geometry needs the rig
 * to translate between stations.
 */
export const MAX_POINT_DISTANCE_M = 12

function finitePoint(p: Point3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

export function poseDistance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function usefulWorldPoint(p: Point3, pose: Pose): boolean {
  if (!finitePoint(p)) return false
  const dist = poseDistance(p, pose.position)
  return dist >= MIN_POINT_DISTANCE_M && dist <= MAX_POINT_DISTANCE_M
}
