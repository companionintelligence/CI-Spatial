/**
 * Where a pin lands on screen, from a projected point in normalised device coordinates.
 *
 * The camera canvas is not always the whole viewport. Under the `contain` fit (eighthwall.ts)
 * it is sized to the camera's aspect and centred, so the image covers only part of one axis.
 * Mapping NDC through the full window moves a pin off its object, by tens of pixels at the
 * top and bottom edges of a portrait phone. Mapping through the canvas's own rect fixes it.
 *
 * Pure, with no DOM and no imports, so it can be tested under plain node.
 */

export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/** The camera canvas's rect when it has a size, otherwise the whole viewport. */
export function cameraViewRect(canvasRect: ScreenRect | null, viewport: { width: number; height: number }): ScreenRect {
  if (canvasRect && canvasRect.width > 0 && canvasRect.height > 0) return canvasRect
  return { left: 0, top: 0, width: viewport.width, height: viewport.height }
}

/** Viewport CSS pixels of a point given in NDC (-1..1 on each axis) inside a view rect. */
export function ndcToScreen(ndcX: number, ndcY: number, rect: ScreenRect): { x: number; y: number } {
  return {
    x: rect.left + ((ndcX + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndcY) / 2) * rect.height,
  }
}
