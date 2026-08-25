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
import { viewportPointToImagePoint } from '../spatial/resolver'
import type { CalibrationReferencePhoto } from '../world/types'

export type ReferencePhotoRole = 'landmark' | 'headingMarker'

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
 * which photo is which.
 */
export function referencePhotoTitle(role: ReferencePhotoRole): string {
  return role === 'landmark' ? 'Point A — the landmark' : 'Point B — the heading marker'
}
