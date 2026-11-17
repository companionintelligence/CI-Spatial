/**
 * Read a print sheet back: the SVG `scripts/print-fiducial.mjs` writes is parsed as geometry so a
 * test can check what a ruler would, and so the printed tag itself (not the dictionary's idea of
 * it) can be drawn into a synthetic camera frame and handed to the detector.
 *
 * Only the constructs the generator emits are understood: a root `<svg>` with `width`/`height` in
 * millimetres and a matching viewBox, `<rect>` elements, and paths made of absolute `M`, `H`, `V`
 * and `Z` commands that trace axis-aligned rectangles. Anything else throws, so a generator change
 * that the parser cannot read fails loudly instead of passing quietly.
 */
import type { PlanarArtwork } from './fiducial-render.ts'

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface ParsedSheet {
  /** Page size from the root `width` / `height`, millimetres. */
  widthMm: number
  heightMm: number
  /** The viewBox numbers; equal to the page size when one user unit is one millimetre. */
  viewBox: [number, number, number, number]
  /** `data-*` attributes of the root element. */
  data: Record<string, string>
  /** The ink of the tag, as rectangles in millimetres on the page. */
  inkRects: Rect[]
  /** The quiet-zone rectangle (the white square the tag sits in). */
  quietZone: Rect
  /** The tag group's own `data-*`. */
  tag: { id: number; sizeMm: number; xMm: number; yMm: number }
  cropMarkPath: string
  /** Absolute path commands of the scale bar, and its declared length. */
  scaleBar: { lengthMm: number; path: string }
  qr: { xMm: number; yMm: number; svg: string }
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)
  return m ? m[1]! : null
}

function mustAttr(tag: string, name: string): string {
  const v = attr(tag, name)
  if (v === null) throw new Error(`sheet: <${tag.slice(0, 40)}...> has no ${name}`)
  return v
}

function mmValue(text: string): number {
  const m = /^(-?[0-9.]+)mm$/.exec(text)
  if (!m) throw new Error(`sheet: "${text}" is not a size in millimetres`)
  return Number(m[1])
}

/** The rectangles of a path built from `M x y H x V y H x Z` groups. */
export function pathRects(d: string): Rect[] {
  const rects: Rect[] = []
  const re = /M(-?[0-9.]+) (-?[0-9.]+)H(-?[0-9.]+)V(-?[0-9.]+)H(-?[0-9.]+)Z/g
  let consumed = 0
  for (let m = re.exec(d); m; m = re.exec(d)) {
    if (m.index !== consumed) throw new Error(`sheet: path has a segment that is not a rectangle near ${consumed}`)
    consumed = m.index + m[0].length
    const x0 = Number(m[1])
    const y0 = Number(m[2])
    const x1 = Number(m[3])
    const y1 = Number(m[4])
    if (Number(m[5]) !== x0) throw new Error('sheet: rectangle does not close on its starting x')
    rects.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) })
  }
  if (consumed !== d.length) throw new Error('sheet: path has trailing commands that are not rectangles')
  return rects
}

export function parseSheet(svg: string): ParsedSheet {
  const root = /^<svg\b([^>]*)>/.exec(svg)
  if (!root) throw new Error('sheet: not an <svg> document')
  const rootTag = root[1]!
  const widthMm = mmValue(mustAttr(rootTag, 'width'))
  const heightMm = mmValue(mustAttr(rootTag, 'height'))
  const vb = mustAttr(rootTag, 'viewBox').split(' ').map(Number)
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) throw new Error('sheet: bad viewBox')
  const data: Record<string, string> = {}
  for (const m of rootTag.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) data[m[1]!] = m[2]!

  const inkPath = /<path id="tag-ink" d="([^"]*)"/.exec(svg)
  if (!inkPath) throw new Error('sheet: no tag-ink path')
  const quiet = /<rect id="quiet-zone" x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)"/.exec(svg)
  if (!quiet) throw new Error('sheet: no quiet-zone rect')
  const tagGroup = /<g id="tag" ([^>]*)>/.exec(svg)
  if (!tagGroup) throw new Error('sheet: no tag group')
  const crop = /<path id="crop-marks" d="([^"]*)"/.exec(svg)
  if (!crop) throw new Error('sheet: no crop marks')
  const bar = /<g id="scale-bar" data-length-mm="([^"]*)"><path d="([^"]*)"/.exec(svg)
  if (!bar) throw new Error('sheet: no scale bar')
  const qr = /<g id="qr" transform="translate\(([^ ]*) ([^)]*)\)">(<svg [\s\S]*?<\/svg>)<\/g>/.exec(svg)
  if (!qr) throw new Error('sheet: no qr block')

  const qx = Number(quiet[1])
  const qy = Number(quiet[2])
  return {
    widthMm,
    heightMm,
    viewBox: [vb[0]!, vb[1]!, vb[2]!, vb[3]!],
    data,
    inkRects: pathRects(inkPath[1]!),
    quietZone: { x0: qx, y0: qy, x1: qx + Number(quiet[3]), y1: qy + Number(quiet[4]) },
    tag: {
      id: Number(mustAttr(tagGroup[1]!, 'data-tag-id')),
      sizeMm: Number(mustAttr(tagGroup[1]!, 'data-size-mm')),
      xMm: Number(mustAttr(tagGroup[1]!, 'data-x-mm')),
      yMm: Number(mustAttr(tagGroup[1]!, 'data-y-mm')),
    },
    cropMarkPath: crop[1]!,
    scaleBar: { lengthMm: Number(bar[1]), path: bar[2]! },
    qr: { xMm: Number(qr[1]), yMm: Number(qr[2]), svg: qr[3]! },
  }
}

/**
 * The printed tag as a camera would see it: reflectance 25 where the sheet has ink, 225 on the
 * white quiet zone, off the sheet beyond it. Plane coordinates are metres from the tag centre with
 * +x right and +y up, the frame `fiducial-render.ts` uses; the sheet's millimetres and downward y
 * are converted here, so a mirrored or flipped print would be drawn mirrored or flipped.
 */
export function sheetArtwork(sheet: ParsedSheet): PlanarArtwork {
  const cx = sheet.tag.xMm + sheet.tag.sizeMm / 2
  const cy = sheet.tag.yMm + sheet.tag.sizeMm / 2
  const quiet = sheet.quietZone
  const half = (quiet.x1 - quiet.x0) / 2 / 1000
  return {
    halfExtent: half,
    shade(x, y) {
      const px = cx + x * 1000
      const py = cy - y * 1000
      if (px < quiet.x0 || px > quiet.x1 || py < quiet.y0 || py > quiet.y1) return -1
      for (const r of sheet.inkRects) if (px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1) return 25
      return 225
    },
  }
}
