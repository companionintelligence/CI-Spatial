#!/usr/bin/env node
/**
 * print-fiducial.mjs — an exact-size, print-ready SVG sheet for one Companion Scan marker.
 *
 *   npm run print:fiducial -- --id 7 --size-mm 200 --place-id <place> [--room-id <room>] \
 *       [--page auto|a4|a3|a2|a1|a0|letter|tabloid] [--out marker-7.svg]
 *
 * (`npm run print:fiducial` is `node --experimental-transform-types --no-warnings scripts/print-fiducial.mjs`;
 * run that directly where the npm script is not wired.)
 *
 * The sheet carries, at physical size (1 SVG user unit = 1 mm, `width`/`height` in mm):
 *   - the tag: a black square of exactly `--size-mm` edge length, `bits + 2` cells across, in the
 *     orientation the detector expects (see `src/ar/fiducial/dictionary.ts`), inside a white quiet
 *     zone of `--quiet-cells` cells (default and minimum 1: the detector samples half a cell outside
 *     the border and expects white there);
 *   - crop marks at the corners of the tag plus its quiet zone, so it can be trimmed and mounted;
 *   - the tag id, family, printed size and cell size as text;
 *   - a QR code and a text line carrying `{ v, family, tagId, placeId, roomId, printedSizeMm }`
 *     (`src/ar/fiducial/payload.ts`);
 *   - a 100 mm scale bar. Printers set to "fit to page" shrink a sheet by a few percent and nothing
 *     in the file can see that; the bar lets a person measure it, and the measured tag size is the
 *     number the Place should be told;
 *   - a line asking for the sheet to be mounted flat: the detector locates the four edges as straight
 *     lines, so a bowed or curled edge moves the corners by about its sag (a 1 % bow of a side is a
 *     0.65 px corner shift on a 72 px tag, measured on synthetic frames).
 *
 * Deterministic: the same arguments give the same bytes, so a sheet can be diffed and the QR code
 * does not change when nothing else did. No clock, no randomness.
 *
 * Needs `--experimental-transform-types` (the npm script passes it): the QR renderer it reuses,
 * `src/ui/qr-code.ts`, sits on the vendored Nayuki encoder, which uses a TypeScript namespace that
 * plain type-stripping cannot load. It is the repo's one SVG QR path; `npm run qr` (qrcode-terminal)
 * only draws to a terminal.
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { CSCAN5_V1 } from '../src/ar/fiducial/dictionary.ts'
import { serializeTagPayload } from '../src/ar/fiducial/payload.ts'

/** Portrait page sizes, millimetres. */
export const PAGES = {
  a4: { widthMm: 210, heightMm: 297 },
  a3: { widthMm: 297, heightMm: 420 },
  a2: { widthMm: 420, heightMm: 594 },
  a1: { widthMm: 594, heightMm: 841 },
  a0: { widthMm: 841, heightMm: 1189 },
  letter: { widthMm: 215.9, heightMm: 279.4 },
  tabloid: { widthMm: 279.4, heightMm: 431.8 },
}

/** What `--page auto` tries, smallest first. Letter and tabloid are chosen by name only: a metric default for a metric repo. */
const AUTO_PAGES = ['a4', 'a3', 'a2', 'a1', 'a0']

/**
 * Smallest and largest tag the generator will make, millimetres. Adopted, not measured: below 40 mm no
 * phone reads it at a useful range; the largest is what an A0 sheet holds with its margin and footer (631 mm),
 * rounded down, so every size the generator accepts has a page it fits on.
 */
export const MIN_SIZE_MM = 40
export const MAX_SIZE_MM = 600

/**
 * Layout dimensions, millimetres: where the margins, text, marks and QR code sit. A design choice, not a
 * measurement (ADR 0005 rule 5 governs tolerances on the world, and none of these is one): the black
 * square and its cell grid are exact, and these only place the rest around them. The 100 mm scale bar is
 * a round length a person can lay a ruler on.
 */
const MARGIN_MM = 8
const HEADER_MM = 16
const GAP_MM = 2
const CROP_GAP_MM = 1.5
const CROP_LEN_MM = 5
const FOOTER_GAP_MM = 4
const FOOTER_MM = 50
const QR_MM = 36
const SCALE_BAR_MM = 100
const INK = '#000000'
const PAPER = '#ffffff'
const FONT = 'Helvetica, Arial, sans-serif'
const MONO = 'Courier New, Courier, monospace'

/** A number as it is written into the SVG: at most four decimals (0.1 micrometre), no trailing zeros, no exponent. */
export function mm(n) {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? '0' : String(r)
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Break `text` into lines of at most `width` characters, deterministically. */
function wrap(text, width) {
  const lines = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}

/**
 * The repo's QR renderer, loaded on demand so that building a sheet with an injected renderer (a
 * test, or a caller that has its own) does not need the transform flag.
 *
 * @returns {Promise<(text: string, options: { size: number, level: 'L'|'M'|'Q'|'H', label: string }) => string>}
 */
export async function loadQrSvg() {
  try {
    const mod = await import('../src/ui/qr-code.ts')
    return mod.qrCodeSvg
  } catch (e) {
    throw new Error(
      `could not load src/ui/qr-code.ts (${e instanceof Error ? e.message.split('\n')[0] : e}). ` +
        'Run this through npm run print:fiducial, which passes --experimental-transform-types.',
    )
  }
}

/**
 * Where everything goes, in millimetres, for a tag of `sizeMm` on a page of `page`. Pure arithmetic;
 * `buildSheet` and the tests both read it.
 *
 * @param {{ widthMm: number, heightMm: number }} page
 * @param {number} sizeMm
 * @param {number} quietMm
 */
export function sheetLayout(page, sizeMm, quietMm) {
  const trim = sizeMm + 2 * quietMm
  const reach = CROP_GAP_MM + CROP_LEN_MM
  const neededWidth = trim + 2 * reach + 2 * MARGIN_MM
  const neededHeight = MARGIN_MM + HEADER_MM + GAP_MM + reach + trim + reach + FOOTER_GAP_MM + FOOTER_MM + MARGIN_MM
  const trimX = (page.widthMm - trim) / 2
  const trimY = MARGIN_MM + HEADER_MM + GAP_MM + reach
  return {
    fits: neededWidth <= page.widthMm + 1e-9 && neededHeight <= page.heightMm + 1e-9,
    neededWidth,
    neededHeight,
    trim,
    trimX,
    trimY,
    tagX: trimX + quietMm,
    tagY: trimY + quietMm,
    footerY: trimY + trim + reach + FOOTER_GAP_MM,
  }
}

/**
 * Build one sheet.
 *
 * @param {object} args
 * @param {number} args.tagId
 * @param {number} args.sizeMm              edge of the black square
 * @param {string} args.placeId
 * @param {string | null} [args.roomId]
 * @param {'auto' | keyof typeof PAGES} [args.page]
 * @param {number} [args.quietCells]        white margin around the black square, in cells (>= 1)
 * @param {typeof CSCAN5_V1} [args.dictionary]
 * @param {(text: string, options: { size: number, level: 'L'|'M'|'Q'|'H', label: string }) => string} args.qrSvg
 */
export function buildSheet(args) {
  const dictionary = args.dictionary ?? CSCAN5_V1
  const { tagId, sizeMm, placeId } = args
  const roomId = args.roomId ?? null
  const quietCells = args.quietCells ?? 1
  if (!Number.isInteger(tagId) || tagId < 0 || tagId >= dictionary.size) throw new RangeError(`tag id must be a whole number from 0 to ${dictionary.size - 1}`)
  if (!Number.isFinite(sizeMm) || sizeMm < MIN_SIZE_MM || sizeMm > MAX_SIZE_MM) throw new RangeError(`size must be from ${MIN_SIZE_MM} to ${MAX_SIZE_MM} mm`)
  if (typeof placeId !== 'string' || placeId.length === 0) throw new RangeError('a place id is required')
  if (!(quietCells >= 1)) throw new RangeError('the white margin must be at least 1 cell: the detector reads half a cell outside the border')

  const bits = dictionary.bits
  const cells = bits + 2
  const cellMm = sizeMm / cells
  const quietMm = quietCells * cellMm

  const wanted = args.page ?? 'auto'
  const candidates = wanted === 'auto' ? AUTO_PAGES : [wanted]
  /** @type {{ name: string, widthMm: number, heightMm: number } | null} */
  let page = null
  let layout = null
  for (const name of candidates) {
    const size = PAGES[name]
    if (!size) throw new RangeError(`unknown page "${name}" (use ${Object.keys(PAGES).join(', ')} or auto)`)
    const l = sheetLayout(size, sizeMm, quietMm)
    if (l.fits) {
      page = { name, ...size }
      layout = l
      break
    }
  }
  if (!page || !layout) {
    const largest = PAGES[candidates[candidates.length - 1]]
    const need = sheetLayout(largest, sizeMm, quietMm)
    throw new RangeError(
      `a ${mm(sizeMm)} mm tag with its margin needs a page at least ${mm(need.neededWidth)} x ${mm(need.neededHeight)} mm; ` +
        `${wanted === 'auto' ? 'the largest page tried' : `"${wanted}"`} is ${mm(largest.widthMm)} x ${mm(largest.heightMm)} mm. Choose a smaller tag or a larger page.`,
    )
  }

  /** @type {import('../src/ar/fiducial/types.ts').TagPayload} */
  const payload = { v: 1, family: dictionary.name, tagId, placeId, roomId, printedSizeMm: sizeMm }
  const payloadText = serializeTagPayload(payload)

  // Ink: one rectangle per horizontal run of black cells, absolute coordinates so that shared edges are the same string.
  const pattern = dictionary.pattern(tagId)
  const isBlack = (r, c) => r === 0 || c === 0 || r === cells - 1 || c === cells - 1 || pattern[(r - 1) * bits + (c - 1)] === 1
  let ink = ''
  for (let r = 0; r < cells; r++) {
    let c = 0
    while (c < cells) {
      if (!isBlack(r, c)) {
        c++
        continue
      }
      const start = c
      while (c < cells && isBlack(r, c)) c++
      const x0 = layout.tagX + start * cellMm
      const x1 = layout.tagX + c * cellMm
      const y0 = layout.tagY + r * cellMm
      const y1 = layout.tagY + (r + 1) * cellMm
      ink += `M${mm(x0)} ${mm(y0)}H${mm(x1)}V${mm(y1)}H${mm(x0)}Z`
    }
  }

  // Crop marks: the extension of each trim edge, outside the trim square.
  const tx0 = layout.trimX
  const ty0 = layout.trimY
  const tx1 = layout.trimX + layout.trim
  const ty1 = layout.trimY + layout.trim
  const g = CROP_GAP_MM
  const L = CROP_LEN_MM
  let crop = ''
  for (const [x, y, sx, sy] of [[tx0, ty0, -1, -1], [tx1, ty0, 1, -1], [tx1, ty1, 1, 1], [tx0, ty1, -1, 1]]) {
    crop += `M${mm(x + sx * g)} ${mm(y)}H${mm(x + sx * (g + L))}M${mm(x)} ${mm(y + sy * g)}V${mm(y + sy * (g + L))}`
  }

  const cx = page.widthMm / 2
  const left = layout.trimX
  const fy = layout.footerY
  const qrX = Math.max(left, page.widthMm - MARGIN_MM - QR_MM)
  const textWidth = Math.floor((qrX - left - 3) / 1.55)
  const payloadLines = wrap(payloadText, Math.max(20, textWidth))

  const lines = [
    `Place: ${placeId}`,
    `Room: ${roomId ?? 'none (the whole Place)'}`,
    `Cell ${mm(cellMm)} mm. White margin ${mm(quietMm)} mm: keep it clear.`,
    'Print at 100% (actual size), not fit to page.',
    'Mount it flat on a hard surface: a curled sheet moves the corners.',
    `The bar below is ${SCALE_BAR_MM} mm. If it measures less or more,`,
    `the black square is ${mm(sizeMm)} mm x measured / ${SCALE_BAR_MM} mm.`,
  ]
  let text = ''
  let ty = fy + 3.4
  for (const line of lines) {
    text += `<text x="${mm(left)}" y="${mm(ty)}" font-family="${FONT}" font-size="3.2" fill="${INK}">${escapeXml(line)}</text>`
    ty += 4.2
  }
  const barY = ty + 1.5
  const bar =
    `<g id="scale-bar" data-length-mm="${SCALE_BAR_MM}"><path d="M${mm(left)} ${mm(barY)}H${mm(left + SCALE_BAR_MM)}M${mm(left)} ${mm(barY - 1.5)}V${mm(barY + 1.5)}M${mm(left + SCALE_BAR_MM)} ${mm(barY - 1.5)}V${mm(barY + 1.5)}" stroke="${INK}" stroke-width="0.25" fill="none"/>` +
    `<text x="${mm(left + SCALE_BAR_MM + 2)}" y="${mm(barY + 1)}" font-family="${FONT}" font-size="3.2" fill="${INK}">${SCALE_BAR_MM} mm</text></g>`
  let payloadText2 = ''
  let py = barY + 5.5
  for (const line of payloadLines) {
    payloadText2 += `<text x="${mm(left)}" y="${mm(py)}" font-family="${MONO}" font-size="2.4" fill="${INK}" xml:space="preserve">${escapeXml(line)}</text>`
    py += 3
  }

  const qr = args.qrSvg(payloadText, { size: QR_MM, level: 'M', label: `Marker ${tagId}: ${placeId}` })

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(page.widthMm)}mm" height="${mm(page.heightMm)}mm" viewBox="0 0 ${mm(page.widthMm)} ${mm(page.heightMm)}" ` +
    `data-family="${escapeXml(dictionary.name)}" data-tag-id="${tagId}" data-size-mm="${mm(sizeMm)}" data-cell-mm="${mm(cellMm)}" data-quiet-mm="${mm(quietMm)}" data-page="${page.name}">` +
    `<title>Companion Scan marker ${tagId}, ${mm(sizeMm)} mm</title>` +
    `<desc>${escapeXml(payloadText)}</desc>` +
    `<rect id="page" width="${mm(page.widthMm)}" height="${mm(page.heightMm)}" fill="${PAPER}"/>` +
    `<g id="header"><text x="${mm(cx)}" y="${mm(MARGIN_MM + 6)}" text-anchor="middle" font-family="${FONT}" font-size="6" font-weight="bold" fill="${INK}">Companion Scan marker</text>` +
    `<text x="${mm(cx)}" y="${mm(MARGIN_MM + 12)}" text-anchor="middle" font-family="${FONT}" font-size="3.8" fill="${INK}">Tag ${tagId} · ${escapeXml(dictionary.name)} · black square ${mm(sizeMm)} mm</text></g>` +
    `<path id="crop-marks" d="${crop}" stroke="${INK}" stroke-width="0.25" fill="none"/>` +
    `<g id="tag" data-tag-id="${tagId}" data-size-mm="${mm(sizeMm)}" data-x-mm="${mm(layout.tagX)}" data-y-mm="${mm(layout.tagY)}">` +
    `<rect id="quiet-zone" x="${mm(layout.trimX)}" y="${mm(layout.trimY)}" width="${mm(layout.trim)}" height="${mm(layout.trim)}" fill="${PAPER}"/>` +
    `<path id="tag-ink" d="${ink}" fill="${INK}"/></g>` +
    `<g id="footer">${text}${bar}${payloadText2}<g id="qr" transform="translate(${mm(qrX)} ${mm(fy)})">${qr}</g></g>` +
    '</svg>\n'

  return {
    svg,
    page,
    payload,
    geometry: { tagXMm: layout.tagX, tagYMm: layout.tagY, sizeMm, cellMm, quietMm, trimMm: layout.trim, qrXMm: qrX, qrYMm: fy, qrSizeMm: QR_MM },
  }
}

function usage() {
  return [
    'usage: npm run print:fiducial -- --id <0..31> --size-mm <edge> --place-id <id> [--room-id <id>]',
    '                                 [--page auto|a4|a3|a2|a1|a0|letter|tabloid] [--quiet-cells 1] [--out file.svg]',
    '       (or: node --experimental-transform-types --no-warnings scripts/print-fiducial.mjs <the same arguments>)',
    '',
    `  --size-mm      edge of the black square, ${MIN_SIZE_MM} to ${MAX_SIZE_MM} (default 200)`,
    '  --page         default auto: the smallest of A4, A3, A2, A1, A0 that holds the tag and its margin',
    '  --out          write the SVG here instead of standard output',
  ].join('\n')
}

function parseArgs(argv) {
  const out = { id: null, sizeMm: 200, placeId: null, roomId: null, page: 'auto', quietCells: 1, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new RangeError(`${a} needs a value`)
      return v
    }
    if (a === '--id') out.id = Number(next())
    else if (a === '--size-mm') out.sizeMm = Number(next())
    else if (a === '--place-id') out.placeId = next()
    else if (a === '--room-id') out.roomId = next()
    else if (a === '--page') out.page = next()
    else if (a === '--quiet-cells') out.quietCells = Number(next())
    else if (a === '--out') out.out = next()
    else if (a === '--help' || a === '-h') out.help = true
    else throw new RangeError(`unknown argument ${a}`)
  }
  return out
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`${e.message}\n\n${usage()}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(usage())
    return
  }
  try {
    if (args.id === null || args.placeId === null) throw new RangeError('--id and --place-id are required')
    const qrSvg = await loadQrSvg()
    const { svg, page, geometry } = buildSheet({ tagId: args.id, sizeMm: args.sizeMm, placeId: args.placeId, roomId: args.roomId, page: args.page, quietCells: args.quietCells, qrSvg })
    if (args.out) {
      writeFileSync(args.out, svg)
      console.error(`wrote ${args.out}: ${page.name.toUpperCase()} (${mm(page.widthMm)} x ${mm(page.heightMm)} mm), black square ${mm(geometry.sizeMm)} mm, cell ${mm(geometry.cellMm)} mm`)
    } else {
      process.stdout.write(svg)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
