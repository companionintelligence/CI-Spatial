/**
 * Shared CV test palette — one saturated, well-separated colour per furniture
 * label.  Used by:
 *   - scripts/generate-cv-images.mjs   (draws synthetic room images)
 *   - inference.ts mock engine          (detects these colours as objects)
 *   - public/test-fixtures/xr8-mock.js  (paints the fake camera feed — keep
 *     its inline copy in sync when editing)
 *
 * Runtime-agnostic: imported by Deno (server), Node (scripts), and Vite.
 */

export interface PaletteEntry {
  label: string
  /** sRGB 0-255 */
  rgb: [number, number, number]
  /**
   * Plain-English name for `rgb`. The mock engine reports the colour it actually
   * matched as part of the detection description, so the description reads as a
   * description rather than as engine debug output. See inference.ts
   * `describeMockBlob`.
   */
  colorName: string
}

export const CV_PALETTE: PaletteEntry[] = [
  { label: 'chair', rgb: [41, 98, 255], colorName: 'blue' },
  { label: 'sofa', rgb: [255, 109, 0], colorName: 'orange' },
  { label: 'bed', rgb: [170, 0, 255], colorName: 'purple' },
  { label: 'table', rgb: [109, 76, 65], colorName: 'walnut' },
  { label: 'lamp', rgb: [255, 214, 0], colorName: 'yellow' },
  { label: 'plant', rgb: [0, 200, 83], colorName: 'green' },
  { label: 'tv', rgb: [0, 184, 212], colorName: 'teal' },
  { label: 'shelf', rgb: [197, 17, 98], colorName: 'crimson' },
]

/** Per-channel tolerance used by the mock detector (JPEG compression noise) */
export const PALETTE_TOLERANCE = 28

export function paletteColorFor(label: string): [number, number, number] {
  return CV_PALETTE.find((p) => p.label === label)?.rgb ?? [176, 190, 197]
}

/** Plain-English colour name for a palette label; '' when the label is unknown. */
export function paletteColorNameFor(label: string): string {
  return CV_PALETTE.find((p) => p.label === label)?.colorName ?? ''
}

/** Classify an sRGB pixel against the palette; null when it matches nothing */
export function classifyPixel(r: number, g: number, b: number): string | null {
  for (const entry of CV_PALETTE) {
    if (
      Math.abs(r - entry.rgb[0]) <= PALETTE_TOLERANCE &&
      Math.abs(g - entry.rgb[1]) <= PALETTE_TOLERANCE &&
      Math.abs(b - entry.rgb[2]) <= PALETTE_TOLERANCE
    ) {
      return entry.label
    }
  }
  return null
}
