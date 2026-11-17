/**
 * The print sheet (`scripts/print-fiducial.mjs`) and the payload its QR code carries.
 *
 * A sheet is only worth printing if a ruler laid on the paper agrees with the file, so these tests
 * read the SVG back as geometry (`tests/support/fiducial-sheet.ts`) and measure it: the page, the
 * black square, the cell grid, the white margin, the scale bar. They then draw the PRINTED tag (the
 * parsed ink, not the dictionary's idea of it) into synthetic camera frames and hand those to the
 * detector, which is the only check that catches a sheet that is mirrored, turned, or has a margin
 * too thin to read.
 *
 * The QR code is a stub here: the sheet takes its renderer as an argument, and the repo's real one sits on
 * a vendored encoder that plain type-stripping cannot load (it uses a TypeScript namespace). Everything that
 * needs the real code (the byte-for-byte snapshots, the modules matching the encoder's, the command line)
 * is in `fiducial_print_sheet_qr.test.ts`, which runs under `--experimental-transform-types`. This file
 * runs under the repo's standard `node --experimental-strip-types`.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_print_sheet.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSheet, MAX_SIZE_MM, MIN_SIZE_MM, PAGES, sheetLayout } from '../../../scripts/print-fiducial.mjs'
import { CSCAN5_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import { parseTagPayload, serializeTagPayload } from '../../../src/ar/fiducial/payload.ts'
import { INTRINSICS_640, mat3Apply, renderFrame, tagPose } from '../../support/fiducial-render.ts'
import { parseSheet, pathRects, sheetArtwork } from '../../support/fiducial-sheet.ts'

/** A QR renderer that draws nothing a decoder could read but has the shape the sheet embeds: a standalone `<svg>` of the asked size. */
function stubQr(text: string, options: { size: number; level: 'L' | 'M' | 'Q' | 'H'; label: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.size}" height="${options.size}" viewBox="0 0 ${options.size} ${options.size}" role="img" aria-label="${options.label.replace(/[<>&"]/g, '')}"><path d="M0 0h${options.size}v${options.size}h-${options.size}z" fill="#111111" data-payload-length="${text.length}"/></svg>`
}

function sheet(args: Partial<Parameters<typeof buildSheet>[0]> = {}) {
  return buildSheet({ tagId: 7, sizeMm: 120, placeId: 'place-kitchen-1', roomId: 'room-a', page: 'a4', qrSvg: stubQr, ...args })
}

test('the output is deterministic, and every input reaches it', () => {
  assert.equal(sheet().svg, sheet().svg)
  const base = sheet().svg
  for (const change of [{ tagId: 8 }, { sizeMm: 121 }, { placeId: 'place-kitchen-2' }, { roomId: 'room-b' }, { roomId: null }, { page: 'letter' as const }, { quietCells: 1.5 }]) {
    assert.notEqual(sheet(change).svg, base, `changing ${JSON.stringify(change)} changed nothing`)
  }
})

test('physical size by parsing the file: the page, the black square, the cells, the margin and the scale bar are the sizes they claim', () => {
  for (const [tagId, sizeMm, page] of [[7, 120, 'a4'], [23, 200, 'a3'], [0, 60, 'a4'], [31, 100, 'letter'], [12, 300, 'a2'], [5, 440, 'a0'], [30, 600, 'a0']] as const) {
    const built = sheet({ tagId, sizeMm, page })
    const p = parseSheet(built.svg)
    const label = `id ${tagId}, ${sizeMm} mm, ${page}`

    // One user unit is one millimetre, and the page is the page.
    assert.deepEqual([p.widthMm, p.heightMm], [PAGES[page].widthMm, PAGES[page].heightMm], label)
    assert.deepEqual(p.viewBox, [0, 0, p.widthMm, p.heightMm], label)

    // The ink's extent is the black square, exactly (to a tenth of a micrometre).
    const x0 = Math.min(...p.inkRects.map((r) => r.x0))
    const x1 = Math.max(...p.inkRects.map((r) => r.x1))
    const y0 = Math.min(...p.inkRects.map((r) => r.y0))
    const y1 = Math.max(...p.inkRects.map((r) => r.y1))
    assert.ok(Math.abs(x1 - x0 - sizeMm) < 1e-3, `${label}: ink is ${x1 - x0} mm wide`)
    assert.ok(Math.abs(y1 - y0 - sizeMm) < 1e-3, `${label}: ink is ${y1 - y0} mm tall`)
    assert.equal(p.tag.sizeMm, sizeMm)
    assert.ok(Math.abs(p.tag.xMm - x0) < 1e-3 && Math.abs(p.tag.yMm - y0) < 1e-3, `${label}: the tag group is not where the ink is`)

    // Every ink rectangle is a whole number of cells wide and one cell tall, on the grid.
    const cell = sizeMm / 7
    for (const r of p.inkRects) {
      assert.ok(Math.abs((r.y1 - r.y0) - cell) < 1e-3, `${label}: a row ${r.y1 - r.y0} mm tall`)
      const cells = (r.x1 - r.x0) / cell
      assert.ok(Math.abs(cells - Math.round(cells)) < 1e-3, `${label}: a run ${cells} cells wide`)
      const col = (r.x0 - x0) / cell
      assert.ok(Math.abs(col - Math.round(col)) < 1e-3, `${label}: a run starts ${col} cells in`)
      const row = (r.y0 - y0) / cell
      assert.ok(Math.abs(row - Math.round(row)) < 1e-3, `${label}: a row starts ${row} cells down`)
    }

    // The white margin is a whole cell all round, kept clear of ink; the crop marks stand outside it.
    const q = p.quietZone
    assert.ok(Math.abs(x0 - q.x0 - cell) < 1e-3 && Math.abs(q.x1 - x1 - cell) < 1e-3 && Math.abs(y0 - q.y0 - cell) < 1e-3 && Math.abs(q.y1 - y1 - cell) < 1e-3, `${label}: margin is not one cell`)
    assert.ok(Math.abs(Number(p.data['data-quiet-mm']) - cell) < 1e-3)
    const marks = [...p.cropMarkPath.matchAll(/([MHV])(-?[0-9.]+)(?: (-?[0-9.]+))?/g)]
    assert.equal(marks.length, 8 * 2 + 0, `${label}: crop mark segments`) // 8 segments of an M and an H or V each
    // Every mark lies on a line through a trim corner and outside the trim square.
    for (const m of p.cropMarkPath.matchAll(/M(-?[0-9.]+) (-?[0-9.]+)H(-?[0-9.]+)/g)) {
      const [a, y, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      assert.ok(Math.abs(y - q.y0) < 1e-3 || Math.abs(y - q.y1) < 1e-3, `${label}: a horizontal mark at y ${y}`)
      assert.ok(Math.min(a, b) >= q.x1 - 1e-3 || Math.max(a, b) <= q.x0 + 1e-3, `${label}: a horizontal mark inside the margin`)
    }
    for (const m of p.cropMarkPath.matchAll(/M(-?[0-9.]+) (-?[0-9.]+)V(-?[0-9.]+)/g)) {
      const [x, a, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      assert.ok(Math.abs(x - q.x0) < 1e-3 || Math.abs(x - q.x1) < 1e-3, `${label}: a vertical mark at x ${x}`)
      assert.ok(Math.min(a, b) >= q.y1 - 1e-3 || Math.max(a, b) <= q.y0 + 1e-3, `${label}: a vertical mark inside the margin`)
    }

    // The scale bar is 100 mm, as drawn.
    const bar = /M(-?[0-9.]+) (-?[0-9.]+)H(-?[0-9.]+)/.exec(p.scaleBar.path)!
    assert.equal(p.scaleBar.lengthMm, 100)
    assert.ok(Math.abs(Number(bar[3]) - Number(bar[1]) - 100) < 1e-3, `${label}: the bar is ${Number(bar[3]) - Number(bar[1])} mm`)

    // Everything is on the page.
    for (const [name, a, b, c, d] of [
      ['tag', p.quietZone.x0, p.quietZone.y0, p.quietZone.x1, p.quietZone.y1],
      ['bar', Number(bar[1]), Number(bar[2]), Number(bar[3]), Number(bar[2])],
      ['qr', p.qr.xMm, p.qr.yMm, p.qr.xMm + built.geometry.qrSizeMm, p.qr.yMm + built.geometry.qrSizeMm],
    ] as const) {
      assert.ok(a >= 0 && b >= 0 && c <= p.widthMm && d <= p.heightMm, `${label}: ${name} is off the page`)
    }
    assert.ok(Math.abs(built.geometry.sizeMm - sizeMm) < 1e-12 && Math.abs(built.geometry.cellMm - cell) < 1e-12)
  }
})

test('the printed cells are the dictionary\'s pattern, for every id, read back from the file', () => {
  for (let id = 0; id < CSCAN5_V1.size; id++) {
    const p = parseSheet(sheet({ tagId: id, sizeMm: 140 }).svg)
    const cell = p.tag.sizeMm / 7
    const grid = Array.from({ length: 7 }, () => new Array<number>(7).fill(0))
    for (const r of p.inkRects) {
      const row = Math.round((r.y0 - p.tag.yMm) / cell)
      const c0 = Math.round((r.x0 - p.tag.xMm) / cell)
      const c1 = Math.round((r.x1 - p.tag.xMm) / cell)
      for (let c = c0; c < c1; c++) grid[row]![c] = 1
    }
    const pattern = CSCAN5_V1.pattern(id)
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const border = r === 0 || c === 0 || r === 6 || c === 6
        assert.equal(grid[r]![c], border ? 1 : pattern[(r - 1) * 5 + (c - 1)], `id ${id}, cell (${r}, ${c})`)
      }
    }
  }
})

test('the PRINTED tag, drawn into camera frames at all four turns, is read as the right id with the corners in printed order', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  let read = 0
  for (let id = 0; id < CSCAN5_V1.size; id++) {
    const p = parseSheet(sheet({ tagId: id, sizeMm: 200, page: 'a3' }).svg)
    const art = sheetArtwork(p)
    for (const spin of [0, 90, 180, 270]) {
      const pose = tagPose({ x: 0.04, y: -0.03, z: 1.5 }, spin + ((id * 7) % 20), ((id * 11) % 40) - 20, ((id * 5) % 20) - 10)
      const img = renderFrame({ width: 640, height: 480, intrinsics: INTRINSICS_640, items: [{ artwork: art, pose }], noiseSigma: 2, blurSigma: 0.6, seed: id * 4 + spin / 90 + 1, supersample: 3 })
      const found = det.detect(img)
      assert.equal(found.length, 1, `id ${id}, spin ${spin}: ${found.length} detections`)
      assert.equal(found[0]!.id, id, `id ${id}, spin ${spin} read as ${found[0]!.id}`)
      // Corners: printed top-left first, to within a pixel of where the black square's corners really are.
      const h = 0.1
      const truth = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
        const q = mat3Apply(pose.rotation, { x: x!, y: y!, z: 0 })
        return { x: (500 * (q.x + pose.translation.x)) / (q.z + pose.translation.z) + 320, y: (500 * (q.y + pose.translation.y)) / (q.z + pose.translation.z) + 240 }
      })
      for (let c = 0; c < 4; c++) assert.ok(Math.hypot(found[0]!.corners[c]!.x - truth[c]!.x, found[0]!.corners[c]!.y - truth[c]!.y) < 0.5, `id ${id}, spin ${spin}, corner ${c}`)
      read++
    }
  }
  assert.equal(read, 128)
})

test('a sheet whose white margin were thinner than one cell is refused, and the margin it makes is enough to read', () => {
  assert.throws(() => sheet({ quietCells: 0.5 }), /at least 1 cell/)
  assert.throws(() => sheet({ quietCells: 0 }), /at least 1 cell/)
  // A wider margin still reads.
  const p = parseSheet(sheet({ sizeMm: 100, quietCells: 2 }).svg)
  assert.ok(Math.abs(Number(p.data['data-quiet-mm']) - 2 * (100 / 7)) < 1e-3)
  const img = renderFrame({ width: 640, height: 480, intrinsics: INTRINSICS_640, items: [{ artwork: sheetArtwork(p), pose: tagPose({ x: 0, y: 0, z: 1.2 }, 30, 10, 5) }], noiseSigma: 2, seed: 4 })
  assert.equal(new FiducialDetector(CSCAN5_V1).detect(img)[0]?.id, 7)
})

test('the payload line parses back to what was asked for, and is on the sheet as text', () => {
  const built = sheet()
  const text = serializeTagPayload(built.payload)
  assert.deepEqual(parseTagPayload(text), { v: 1, family: 'cscan-5x5-v1', tagId: 7, placeId: 'place-kitchen-1', roomId: 'room-a', printedSizeMm: 120 })
  assert.equal(text, '{"v":1,"family":"cscan-5x5-v1","tagId":7,"placeId":"place-kitchen-1","roomId":"room-a","printedSizeMm":120}')
  // The renderer was handed that line, and the sheet says so in the description and as printed text.
  assert.ok(built.svg.includes(`data-payload-length="${text.length}"`), 'the QR renderer was not given the payload line')
  assert.ok(built.svg.includes('<desc>' + text.replace(/"/g, '&quot;') + '</desc>'))
  assert.ok(built.svg.includes('Place: place-kitchen-1') && built.svg.includes('Room: room-a'))
  assert.ok(built.svg.includes('Print at 100% (actual size), not fit to page.'))
  assert.ok(built.svg.includes('The bar below is 100 mm.'))
  assert.ok(built.svg.includes('Mount it flat on a hard surface: a curled sheet moves the corners.'), 'the sheet must ask for a flat mounting')
  assert.ok(sheet({ roomId: null }).svg.includes('Room: none (the whole Place)'))
  assert.match(parseSheet(built.svg).qr.svg, /width="36" height="36"/)
})

test('payload parsing is strict about what it needs and ignores what it does not know', () => {
  const ok = { v: 1, family: 'cscan-5x5-v1', tagId: 3, placeId: 'p', roomId: null, printedSizeMm: 200 }
  assert.deepEqual(parseTagPayload(JSON.stringify(ok)), ok)
  assert.deepEqual(parseTagPayload(JSON.stringify({ ...ok, roomId: undefined, future: 'field' })), ok, 'an unknown field is ignored, a missing room is none')
  for (const bad of [
    'not json', '[]', 'null', '7', JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, family: '' }), JSON.stringify({ ...ok, tagId: -1 }), JSON.stringify({ ...ok, tagId: 1.5 }),
    JSON.stringify({ ...ok, tagId: '3' }), JSON.stringify({ ...ok, placeId: '' }), JSON.stringify({ ...ok, placeId: 'x'.repeat(201) }), JSON.stringify({ ...ok, roomId: 7 }),
    JSON.stringify({ ...ok, printedSizeMm: 0 }), JSON.stringify({ ...ok, printedSizeMm: -5 }), JSON.stringify({ ...ok, printedSizeMm: 99999 }), JSON.stringify({ ...ok, printedSizeMm: '200' }),
  ]) {
    assert.equal(parseTagPayload(bad), null, bad)
  }
})

test('page choice: the smallest page that fits, up to A0, an error that says what would, and the fit rule is the arithmetic', () => {
  assert.equal(sheet({ sizeMm: 120, page: 'auto' }).page.name, 'a4')
  assert.equal(sheet({ sizeMm: 140, page: 'auto' }).page.name, 'a4')
  assert.equal(sheet({ sizeMm: 145, page: 'auto' }).page.name, 'a3')
  assert.equal(sheet({ sizeMm: 200, page: 'auto' }).page.name, 'a3')
  assert.equal(sheet({ sizeMm: 300, page: 'auto' }).page.name, 'a2')
  // 400 mm needs A1 and 440 mm A0; 600 mm, the largest the generator makes, still has a page.
  assert.equal(sheet({ sizeMm: 400, page: 'auto' }).page.name, 'a1')
  assert.equal(sheet({ sizeMm: 440, page: 'auto' }).page.name, 'a0')
  assert.equal(sheet({ sizeMm: MAX_SIZE_MM, page: 'auto' }).page.name, 'a0')
  assert.throws(() => sheet({ sizeMm: 400, page: 'a2' }), /needs a page at least 543\.2857 x 615\.2857 mm/)
  assert.throws(() => sheet({ sizeMm: 200, page: 'a4' }), /"a4" is 210 x 297 mm/)
  assert.throws(() => sheet({ sizeMm: 200, page: 'tabloid' }), /tabloid/)
  assert.equal(sheet({ sizeMm: 100, page: 'tabloid' }).page.name, 'tabloid')
  assert.throws(() => sheet({ page: 'a5' as never }), /unknown page "a5"/)
  // `fits` is the layout's own verdict: the largest tag that fits A4 does, one more millimetre does not.
  const quiet = (s: number) => s / 7
  assert.equal(sheetLayout(PAGES.a4, 140, quiet(140)).fits, true)
  assert.equal(sheetLayout(PAGES.a4, 142, quiet(142)).fits, false)
  // Every size the generator accepts has a page it fits on: the advice in the error message is always possible.
  for (let size = MIN_SIZE_MM; size <= MAX_SIZE_MM; size += 20) assert.doesNotThrow(() => sheet({ sizeMm: size, page: 'auto' }), `${size} mm`)
})

test('arguments outside what can be printed and read are refused with the reason', () => {
  assert.throws(() => sheet({ tagId: 32 }), /whole number from 0 to 31/)
  assert.throws(() => sheet({ tagId: -1 }), /whole number from 0 to 31/)
  assert.throws(() => sheet({ tagId: 1.5 }), /whole number/)
  assert.throws(() => sheet({ sizeMm: MIN_SIZE_MM - 1 }), /size must be from 40 to 600 mm/)
  assert.throws(() => sheet({ sizeMm: MAX_SIZE_MM + 1 }), /size must be from 40 to 600 mm/)
  assert.throws(() => sheet({ sizeMm: Number.NaN }), /size must be/)
  assert.throws(() => sheet({ placeId: '' }), /place id is required/)
})

test('text that comes from the Place is escaped, never interpreted', () => {
  const nasty = 'p"<script>&</script>'
  const built = sheet({ placeId: nasty, roomId: 'r<&>' })
  assert.ok(!built.svg.includes('<script>'))
  assert.ok(built.svg.includes('p&quot;&lt;script&gt;&amp;&lt;/script&gt;'))
  const p = parseSheet(built.svg)
  assert.equal(p.tag.id, 7)
  // The document is still one well-formed tree.
  assertBalanced(built.svg)
})

/** Every start tag has its end tag, in order, and no stray angle bracket is left in text or attributes. */
function assertBalanced(svg: string): void {
  const stack: string[] = []
  let last = 0
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    const between = svg.slice(last, m.index)
    assert.ok(!between.includes('<') && !between.includes('>'), `a raw angle bracket in text near byte ${m.index}`)
    last = m.index + m[0].length
    if (m[1]) {
      assert.equal(stack.pop(), m[2], `</${m[2]}> closes the wrong element`)
    } else if (!m[4]) {
      stack.push(m[2]!)
    }
  }
  assert.deepEqual(stack, [], 'unclosed elements')
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>\n'))
}

test('a sheet made with the generator is a well-formed document', () => {
  assertBalanced(sheet().svg)
  assertBalanced(sheet({ tagId: 23, sizeMm: 200, page: 'a3', placeId: 'place-hall-9', roomId: null }).svg)
})

test('pathRects refuses a path that is not made of rectangles', () => {
  assert.deepEqual(pathRects('M1 2H3V4H1Z'), [{ x0: 1, y0: 2, x1: 3, y1: 4 }])
  assert.throws(() => pathRects('M1 2H3V4H1ZL5 5'), /trailing commands/)
  assert.throws(() => pathRects('M1 2H3V4H2Z'), /does not close/)
})
