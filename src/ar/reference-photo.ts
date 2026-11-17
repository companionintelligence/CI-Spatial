/**
 * Calibration reference photos — the capture-side shapes and the crosshair
 * geometry (wave 09 ticket 0007).
 *
 * A reference photo is the camera frame at the moment a marker was committed,
 * with the tap point recorded so a crosshair can be drawn back over it on a
 * return visit. It is **a visual aid for a human, never an input to the
 * transform** — nothing that builds `sessionToProject` may read any of this.
 *
 * It exists because `separationM` proves the two points were the right
 * *distance* apart and never that they were the *same two points*. Tapping the
 * correct pair in reverse order passes the separation check while rotating the
 * frame exactly 180°, and reports `'verified'`. The residual cannot detect
 * that; only the user can, and only if given something to recognise.
 */
import { viewportPointToImagePoint } from '../spatial/resolver.ts'
import { twoPointSeparationM } from '../world/geo.ts'
import type { CalibrationReferencePhoto, Vec3 } from '../world/types'

/**
 * Which point a photo is of: the landmark, the heading marker, or a check point (`check1` is the first, the one the flow
 * offers; the schema holds up to three).
 */
export type ReferencePhotoRole = 'landmark' | 'headingMarker' | 'check1' | 'check2' | 'check3'

/** Width/height of either the camera frame or the rendered photo, in pixels. */
export interface PhotoSize {
  width: number
  height: number
}

/**
 * One frame grabbed for a marker, before it has been stored or uploaded.
 *
 * Carries the bytes rather than a URL because neither the local key nor the
 * server URL exists yet — persistence is the caller's job, and it must be able
 * to fail without taking calibration down with it.
 */
export interface PendingReferencePhoto {
  role: ReferencePhotoRole
  blob: Blob
  thumbDataUrl: string
  /** Normalised 0-1 coords **within this photo**, already aspect-corrected. */
  tapPoint: { x: number; y: number }
  pose: CalibrationReferencePhoto['pose']
  capturedAt: string
  /** The user's typed description of the feature, when they gave one. */
  label: string | null
}

/** What the calibration flow asks the host for when it wants a frame. */
export interface ReferencePhotoCapture {
  blob: Blob
  thumbDataUrl: string
  pose: CalibrationReferencePhoto['pose']
  /** Raw camera-frame dimensions, needed to aspect-correct the tap point. */
  frameSize: PhotoSize
}

/**
 * Where the tap landed **within the stored photo**, given where it landed on
 * the canvas.
 *
 * The AR feed is cover-cropped to fill the screen, so the stored frame
 * contains strictly more than the user saw and the two coordinate systems do
 * not agree. `viewportPointToImagePoint` owns that conversion (ADR 0001 — one
 * owner for the cover-crop convention); this wrapper exists to name the
 * calibration-specific meaning and to guarantee the result is storable.
 *
 * Returns `null` when the correction lands outside the frame, which can only
 * mean the sizes passed do not describe this capture. A crosshair drawn from
 * such a coordinate would sit off the tapped feature while still looking
 * authoritative, so no crosshair is the honest outcome.
 */
export function tapPointWithinPhoto(
  canvasPoint: { x: number; y: number },
  frameSize: PhotoSize,
  viewportSize: PhotoSize,
): { x: number; y: number } | null {
  const mapped = viewportPointToImagePoint(canvasPoint.x, canvasPoint.y, frameSize, viewportSize)
  if (!Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) return null
  if (mapped.x < 0 || mapped.x > 1 || mapped.y < 0 || mapped.y > 1) return null
  return mapped
}

/**
 * Pixel offset of the crosshair within a photo rendered at `rendered` pixels.
 *
 * Trivial arithmetic, tested deliberately: it is the same class of projection
 * bug ticket 0005 guards elsewhere, and this is the last step between a
 * correctly-recorded tap and a crosshair the user acts on. Off-by-a-factor
 * here is invisible in review and points the user at the wrong feature.
 *
 * Non-finite or degenerate sizes yield the photo's centre rather than NaN,
 * which CSS would silently drop — leaving a crosshair pinned at the origin,
 * confidently wrong.
 */
export function referenceCrosshairPixels(
  tapPoint: { x: number; y: number },
  rendered: PhotoSize,
): { left: number; top: number } {
  const w = Number.isFinite(rendered.width) && rendered.width > 0 ? rendered.width : 0
  const h = Number.isFinite(rendered.height) && rendered.height > 0 ? rendered.height : 0
  const x = Number.isFinite(tapPoint.x) ? Math.min(Math.max(tapPoint.x, 0), 1) : 0.5
  const y = Number.isFinite(tapPoint.y) ? Math.min(Math.max(tapPoint.y, 0), 1) : 0.5
  return { left: x * w, top: y * h }
}

/**
 * Human-facing name for a marker. The A/B wording is not decoration: order
 * determines the frame's rotation, so the panel has to make unmistakably clear
 * which photo is which. A check point carries on the lettering: C is the first.
 */
export function referencePhotoTitle(role: ReferencePhotoRole): string {
  if (role === 'landmark') return 'Point A — the landmark'
  if (role === 'headingMarker') return 'Point B — the heading marker'
  return `Point ${role === 'check1' ? 'C' : role === 'check2' ? 'D' : 'E'} — the check point`
}

/**
 * Where a marker lands in the view a camera has, in the normalised coordinates a tap is read in: `u` across from the
 * left edge, `v` down from the top, both 0 to 1. They are `u` and `v` and not the `x` and `y` of a tap because they are
 * in the view and not yet in a photo: `tapPointWithinPhoto` takes `{ x: u, y: v }` and returns the point in the photo.
 */
export interface MarkerInView {
  u: number
  v: number
}

/**
 * Where a marker sits in the picture a camera at `capturePose` took: the crosshair for a reference photo, worked out
 * from the marker's position and not from the tap that placed it. Null when the marker is behind the camera or in
 * its plane, outside the view, or when a number is not one, the field of view is not a lens (`fovYDeg` outside 0 to
 * 180 exclusive, `aspect` not above 0) or the rotation has no length.
 *
 * ## Why the tap is the wrong crosshair
 *
 * The tap is read at the moment the marker is placed. The photo is grabbed later: at Confirm for the landmark, at
 * Commit for the heading marker, after the review and any label typed. A phone that has moved in between has its
 * picture moved with it, and the tap then points at another place in the photo than the one it was made at. For the
 * heading marker that is the normal case. The marker does not move with the phone, so its position through the pose
 * the *photo* was taken at is right however far the phone went.
 *
 * ## Built the way `src/main.ts` builds a capture camera
 *
 * `new THREE.PerspectiveCamera(provider.getCameraFovY(), provider.getCameraAspect(), ...)` at the pose's position and
 * quaternion: it looks down its own -Z with +Y up, `fovYDeg` is the vertical field of view, `aspect` is width over
 * height, and the lens is a symmetric pinhole (distortion and a principal point off the centre are not modelled, as
 * in every camera the app builds from those two numbers). `markerSession` and `capturePose` are in the same session
 * frame, as the markers and `ReferencePhotoCapture.pose` are. The pixel convention is the one `hitTest()` takes and
 * `floorRayPoint()` inverts: NDC `(2u - 1, 1 - 2v)`, a horizontal half-extent of `aspect * tan(fovY / 2)`. Pass the
 * pose a tap was read at and a marker that tap placed on the floor, and `(u, v)` is the tap again.
 *
 * ## The view, and the photo
 *
 * `(u, v)` is in the view the field of view and aspect describe, which is the canvas the user tapped on. The stored
 * photo is the camera frame, and the canvas cover-crops it, so a point in the view is not yet a point in the photo.
 * Hand `{ x: u, y: v }` to `tapPointWithinPhoto` as `canvasPoint`, with the frame's size and the canvas's, for the one
 * a `CalibrationReferencePhoto` records; that wrapper owns the crop (ADR 0001).
 *
 * A null here means the marker is outside the canvas view, the picture the person had in front of them. It is not proof
 * that the stored photo leaves the marker out: where the canvas crops the frame, the margin the person never saw is
 * part of the photo, and a marker standing in it is null here though the photo shows it. Whether to keep or retake such
 * a photo is the caller's decision; this answers for what the person could see.
 *
 * Edges count as in view; a marker exactly on one may fall either side of it by rounding.
 */
export function projectMarkerIntoPhoto(
  markerSession: Vec3,
  capturePose: CalibrationReferencePhoto['pose'],
  fovYDeg: number,
  aspect: number,
): MarkerInView | null {
  const { position: p, rotation: q } = capturePose
  const finite = [markerSession.x, markerSession.y, markerSession.z, p.x, p.y, p.z, q.x, q.y, q.z, q.w, fovYDeg, aspect]
    .every(Number.isFinite)
  if (!finite || !(fovYDeg > 0 && fovYDeg < 180) || !(aspect > 0)) return null
  const norm = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(norm > 1e-9)) return null

  // The marker's offset from the camera in the camera's own axes: the inverse (conjugate) of the pose rotation applied
  // to it. v' = v + w t + q x t, with t = 2 q x v, q the vector part; the conjugate negates the vector part.
  const dx = markerSession.x - p.x
  const dy = markerSession.y - p.y
  const dz = markerSession.z - p.z
  const qx = -q.x / norm
  const qy = -q.y / norm
  const qz = -q.z / norm
  const qw = q.w / norm
  const tx = 2 * (qy * dz - qz * dy)
  const ty = 2 * (qz * dx - qx * dz)
  const tz = 2 * (qx * dy - qy * dx)
  const cx = dx + qw * tx + (qy * tz - qz * ty)
  const cy = dy + qw * ty + (qz * tx - qx * tz)
  const cz = dz + qw * tz + (qx * ty - qy * tx)

  const depth = -cz
  if (!(depth > 0)) return null
  const tanHalf = Math.tan((fovYDeg * Math.PI) / 360)
  const u = (cx / (depth * aspect * tanHalf) + 1) / 2
  const v = (1 - cy / (depth * tanHalf)) / 2
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null
  return { u, v }
}

/**
 * The radius, in metres, of the floor ring that marks each stored point on a return visit: how far it lies from the
 * landmark along the floor, in the order given.
 *
 * The visit asks the person to stand where the Place was calibrated. Once they have tapped the landmark again, a ring
 * of this radius around it shows where each other stored point is in distance, if not in direction: walk to the
 * circle, then use the photo for the direction. No transform is involved. A ground distance is the same in the stored
 * frame and in this session's, so the ring is drawn round the landmark's session position at the stored radius.
 *
 * `points` are the stored points in the stored frame (the heading marker, and any check points a later frame
 * carries), `landmark` the stored landmark in the same frame: `(0, 0, 0)` in a record this app wrote. The distance is
 * the one `twoPointSeparationM` measures, in the ground plane, because a ring lies on the floor and a stored
 * `separationM` is that distance. A point that is not a number, or lies at the landmark (no ring to draw), has no
 * radius and is left out, so the result can be shorter than `points` and `radii[i]` need not belong to `points[i]`. A
 * caller that labels each ring measures each point itself with `twoPointSeparationM`, which this wraps.
 *
 * It assumes this session's unit is the one the points were stored in; `scaleKind()` on the provider says what a unit
 * is worth, and a ring in a session whose unit is not the stored one is as wrong as every other distance on screen.
 */
export function ringRadiiFromStoredPoints(points: readonly Vec3[], landmark: Vec3): number[] {
  const radii: number[] = []
  for (const point of points) {
    const radius = twoPointSeparationM(landmark, point)
    if (Number.isFinite(radius) && radius > 0) radii.push(radius)
  }
  return radii
}
