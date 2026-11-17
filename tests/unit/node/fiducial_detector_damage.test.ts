/**
 * What the detector refuses, and what it forgives, when the tag or the scene is not pristine.
 *
 * Each test here exists because a mutation of the detector left every other test green: removing the
 * border check, the quiet-zone check, the trimming of outlying edge points, the shape filters. A
 * detector that is only ever shown clean tags and plain backgrounds cannot tell those checks from
 * decoration, so these frames are damaged on purpose:
 *
 *  - a border with white cells, or a dark bar laid in the white margin: refused, and counted as such;
 *  - one white border cell and a short dark mark in the margin: forgiven, which is what the default
 *    tolerances say;
 *  - a nick bitten out of the border: the corners do not move (outlying edge points are trimmed);
 *  - tape, a card or a finger laid over part of an edge, up to about a third of it: the corners do not
 *    move (the edge is fitted to the majority of its samples, not to all of them); over about half of it
 *    the read is refused as pose-grade rather than moved; a bowed sheet is refused beyond 1.5 % of a side;
 *  - frames of bare shapes, drawn pixel by pixel: squares become candidates, thin outlines, discs,
 *    triangles, pentagons, hexagons, L-shapes and crosses do not.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_detector_damage.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSCAN5_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import { INTRINSICS_640, dictionaryTagArtwork, mat3Apply, patchArtwork, renderFrame, tagPose, warpArtwork, type PlanarArtwork, type RigidPose } from '../../support/fiducial-render.ts'
import type { FiducialImage } from '../../../src/ar/fiducial/types.ts'

const K = INTRINSICS_640
const SIZE_M = 0.2
const CELLS = 7
const CELL = SIZE_M / CELLS
const HALF = SIZE_M / 2

interface Defects {
  /** Border cells (row, column in the 7x7 grid, row 0 on top) printed white instead of black. */
  whiteBorder?: Array<[number, number]>
  /** A dark bar laid above the tag in the white margin: from `fromCells` to `toCells` beyond the border, this fraction of a side long, centred. */
  marginBar?: { fromCells: number; toCells: number; fraction: number }
  /** A white nick bitten into the left border edge: this deep (metres), between these plane heights (metres). */
  nick?: { depthM: number; yFrom: number; yTo: number }
}

/** The printed tag of `id` with the given defects, in the tag's own plane (metres, +x right, +y up). */
function damagedTag(id: number, defects: Defects): PlanarArtwork {
  const pattern = CSCAN5_V1.pattern(id)
  const white = new Set((defects.whiteBorder ?? []).map(([r, c]) => r * 100 + c))
  const extent = HALF + CELL
  return {
    halfExtent: extent + CELL,
    shade(x, y) {
      const ax = Math.abs(x)
      const ay = Math.abs(y)
      if (ax > extent + CELL || ay > extent + CELL) return -1
      const bar = defects.marginBar
      if (bar && y > HALF + bar.fromCells * CELL && y < HALF + bar.toCells * CELL && ax < (bar.fraction * SIZE_M) / 2) return 25
      if (ax > HALF || ay > HALF) return 225
      const nick = defects.nick
      if (nick && x <= -HALF + nick.depthM && y >= nick.yFrom && y <= nick.yTo) return 225
      const col = Math.max(0, Math.min(CELLS - 1, Math.floor((x + HALF) / CELL)))
      const row = Math.max(0, Math.min(CELLS - 1, Math.floor((HALF - y) / CELL)))
      if (row === 0 || col === 0 || row === CELLS - 1 || col === CELLS - 1) return white.has(row * 100 + col) ? 225 : 25
      return pattern[(row - 1) * 5 + (col - 1)] ? 25 : 225
    },
  }
}

/** Frames of the tag with these defects at twelve in-plane turns, one noisy render each. */
function frames(defects: Defects, count = 12): Array<{ image: FiducialImage; pose: RigidPose }> {
  const out: Array<{ image: FiducialImage; pose: RigidPose }> = []
  for (let i = 0; i < count; i++) {
    const pose = tagPose({ x: 0.02, y: -0.02, z: 1.3 }, i * (360 / count), 8, 4)
    out.push({ pose, image: renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: damagedTag(9, defects), pose }], noiseSigma: 2, blurSigma: 0.5, seed: i + 1, supersample: 4 }) })
  }
  return out
}

function readCount(det: FiducialDetector, set: Array<{ image: FiducialImage }>): number {
  return set.filter(({ image }) => det.detect(image).some((d) => d.id === 9)).length
}

test('a border with white cells in it is refused and counted; one white cell is forgiven; the tolerance is the caller\'s', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  assert.equal(readCount(det, frames({})), 12, 'the undamaged tag reads in every turn')
  assert.equal(readCount(det, frames({ whiteBorder: [[0, 3]] })), 12, 'one white border cell is within the default tolerance of one')

  const two = frames({ whiteBorder: [[0, 3], [0, 4]] })
  assert.equal(readCount(det, two), 0, 'two white border cells read as a tag')
  assert.ok(det.stats.rejected.border >= 1, `rejections: ${JSON.stringify(det.stats.rejected)}`)
  assert.equal(readCount(new FiducialDetector(CSCAN5_V1, { maxBorderErrors: 2 }), two), 12, 'a caller who allows two gets them')

  const three = frames({ whiteBorder: [[0, 3], [3, 0], [6, 3]] })
  assert.equal(readCount(det, three), 0)
  assert.equal(readCount(new FiducialDetector(CSCAN5_V1, { maxBorderErrors: 24 }), three) > 0, true, 'with the check off, the damaged tag is read: the refusal above was the check')
})

test('a short dark mark in the white margin is forgiven; a bar along most of a side is refused and counted', () => {
  // The finest level only: at the coarse pyramid levels the thin white gap between the border and a bar this close to it
  // closes, the polygon takes in the bar, and where its corners then fall decides whether a ring sample lands on it. That is a
  // property of the pyramid, not of the quiet-zone check this test is about.
  const det = new FiducialDetector(CSCAN5_V1, { levels: 1 })
  // The bar covers the whole of what a quiet-zone sample looks at (it samples 0.28 to 0.72 of a cell beyond the border:
  // a bar over 0.3 to 0.7 only half-covers that, and whether it is refused then depends on where a pixel falls).
  const mark = frames({ marginBar: { fromCells: 0.15, toCells: 0.85, fraction: 0.4 } })
  assert.equal(readCount(det, mark), 12, 'a mark over 40 % of one side is within the default tolerance of four samples')

  for (const fraction of [0.8, 1.0]) {
    const bar = frames({ marginBar: { fromCells: 0.15, toCells: 0.85, fraction } })
    assert.equal(readCount(det, bar), 0, `a bar over ${fraction * 100} % of a side read as a tag`)
    assert.ok(det.stats.rejected.quiet >= 1 || det.stats.rejected.border >= 1 || det.stats.rejected.match >= 1, `rejections: ${JSON.stringify(det.stats.rejected)}`)
    assert.equal(readCount(new FiducialDetector(CSCAN5_V1, { levels: 1, maxQuietErrors: 28 }), bar), 12, 'with the margin check off the tag reads: the refusal was the check')
  }
  const quietRefusals = frames({ marginBar: { fromCells: 0.15, toCells: 0.85, fraction: 1.0 } })
  let counted = 0
  for (const { image } of quietRefusals) {
    det.detect(image)
    counted += det.stats.rejected.quiet
  }
  assert.ok(counted >= 6, `the margin check was named as the reason ${counted} times of 12`)
})

test('a nick bitten into the border does not move the corners: outlying edge points are trimmed before the fit', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const errs: number[] = []
  const metresPerPixel = 1.3 / K.fx
  for (let i = 0; i < 24; i++) {
    const pose = tagPose({ x: 0.03, y: -0.02, z: 1.3 }, i * 15, 10, 5)
    const nick = { depthM: 2 * metresPerPixel, yFrom: 0.02, yTo: 0.045 }
    const image = renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: damagedTag(9, { nick }), pose }], noiseSigma: 2, blurSigma: 0.6, seed: i + 1, supersample: 4 })
    const found = det.detect(image)
    assert.equal(found.length, 1, `frame ${i}`)
    assert.equal(found[0]!.id, 9)
    const h = HALF
    const truth = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
      const p = mat3Apply(pose.rotation, { x: x!, y: y!, z: 0 })
      const [X, Y, Z] = [p.x + pose.translation.x, p.y + pose.translation.y, p.z + pose.translation.z]
      return { x: (K.fx * X) / Z + K.cx, y: (K.fy * Y) / Z + K.cy }
    })
    // The nick is in the left edge: the printed top-left and bottom-left corners bound it.
    for (const c of [0, 3]) errs.push(Math.hypot(found[0]!.corners[c]!.x - truth[c]!.x, found[0]!.corners[c]!.y - truth[c]!.y))
  }
  errs.sort((a, b) => a - b)
  const median = errs[errs.length >> 1]!
  assert.ok(median < 0.1, `median corner error ${median.toFixed(3)} px with a nick 2 px deep`)
  assert.ok(errs[errs.length - 1]! < 0.5, `worst corner error ${errs[errs.length - 1]!.toFixed(3)} px`)
})

// ---------------------------------------------------------------------------------------------
// Something laid over an edge, and a sheet that is not flat
// ---------------------------------------------------------------------------------------------

/** Where the black square's four corners really land, printed top-left first. */
function truthCorners(pose: RigidPose): Array<{ x: number; y: number }> {
  return [[-HALF, HALF], [HALF, HALF], [HALF, -HALF], [-HALF, -HALF]].map(([x, y]) => {
    const p = mat3Apply(pose.rotation, { x: x!, y: y!, z: 0 })
    const [X, Y, Z] = [p.x + pose.translation.x, p.y + pose.translation.y, p.z + pose.translation.z]
    return { x: (K.fx * X) / Z + K.cx, y: (K.fy * Y) / Z + K.cy }
  })
}

function worstCornerError(found: ReadonlyArray<{ x: number; y: number }>, pose: RigidPose): number {
  const truth = truthCorners(pose)
  return Math.max(...found.map((c, i) => Math.hypot(c.x - truth[i]!.x, c.y - truth[i]!.y)))
}

/**
 * Frames of tag 9 with a white patch laid over its TOP border edge, from `from` to `to` along the side (0 is the
 * printed top-left corner, 1 the top-right) and `depthCells` of a cell deep, at twelve in-plane turns. At 1.3 m the
 * tag is 77 px across and a cell 11 px, so 0.2 of a cell is 2 px.
 */
function coveredFrames(cover: { from: number; to: number; depthCells: number }, count = 12): Array<{ image: FiducialImage; pose: RigidPose }> {
  const out: Array<{ image: FiducialImage; pose: RigidPose }> = []
  const patch = patchArtwork({ x0: -HALF + cover.from * SIZE_M, x1: -HALF + cover.to * SIZE_M, y0: HALF - cover.depthCells * CELL, y1: HALF + 0.9 * CELL }, 225)
  for (let i = 0; i < count; i++) {
    const pose = tagPose({ x: 0.02, y: -0.02, z: 1.3 }, i * (360 / count) + 7, 8, 4)
    out.push({ pose, image: renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: dictionaryTagArtwork(CSCAN5_V1, 9, SIZE_M), pose }, { artwork: patch, pose }], noiseSigma: 2, blurSigma: 0.6, seed: i + 1, supersample: 3 }) })
  }
  return out
}

test('something laid over a minority of an edge does not move the corners: tape, a card or a finger over up to a third of a side, at any depth', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  // The cases that moved corners by 1 to 12 px when the edge was fitted by least squares over all its samples: a strip from a
  // corner (25 % of the side, 2 px deep is the smallest that moved them by a quarter of a pixel), a centred one, shallow and deep.
  const covers = [
    { from: 0, to: 0.25, depthCells: 0.18 },
    { from: 0, to: 0.25, depthCells: 0.5 },
    { from: 0, to: 0.35, depthCells: 0.4 },
    { from: 0, to: 0.4, depthCells: 0.09 },
    { from: 0, to: 0.4, depthCells: 0.27 },
    { from: 0.35, to: 0.65, depthCells: 0.4 },
    { from: 0.65, to: 1, depthCells: 0.3 },
    { from: 0.1, to: 0.4, depthCells: 0.45 },
  ]
  let reads = 0
  for (const cover of covers) {
    for (const { image, pose } of coveredFrames(cover)) {
      const found = det.detect(image).filter((d) => d.id === 9)
      assert.equal(found.length, 1, `cover ${JSON.stringify(cover)}`)
      reads++
      assert.equal(found[0]!.refined, true, `cover ${JSON.stringify(cover)}: not refined`)
      const err = worstCornerError(found[0]!.corners, pose)
      assert.ok(err < 0.3, `cover ${JSON.stringify(cover)}: worst corner ${err.toFixed(2)} px`)
    }
  }
  assert.equal(reads, covers.length * 12)
})

test('an edge more than about half covered is refused as pose-grade, never moved and reported as refined, and what is reported then is the polygon', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const polygonOnly = new FiducialDetector(CSCAN5_V1, { refineCorners: false })
  // `onOutline`: a strip over the middle of a side leaves its two ends, so the outermost line the outline supports is still the edge and
  // the polygon's corners are within a couple of pixels of the truth. A strip from a corner hides the corner itself, and nothing can find it.
  const covers = [
    { from: 0.25, to: 0.75, depthCells: 0.4, onOutline: true },
    { from: 0.2, to: 0.7, depthCells: 0.5, onOutline: true },
    { from: 0.3, to: 0.7, depthCells: 0.3, onOutline: true },
    { from: 0, to: 0.5, depthCells: 0.4, onOutline: false },
    { from: 0, to: 0.55, depthCells: 0.3, onOutline: false },
    // Over 60 % of an edge, shallow and deep: the cases in which the edge that is left looks like the edge.
    { from: 0, to: 0.6, depthCells: 0.18, onOutline: false },
    { from: 0, to: 0.6, depthCells: 0.27, onOutline: false },
    { from: 0.2, to: 0.8, depthCells: 0.55, onOutline: false },
  ]
  let n = 0
  let refused = 0
  let onOutlineFrames = 0
  let onOutlineFinest = 0
  for (const cover of covers) {
    for (const { image, pose } of coveredFrames(cover)) {
      n++
      if (cover.onOutline) onOutlineFrames++
      const found = det.detect(image).filter((d) => d.id === 9)
      if (found.length === 0) {
        refused++
        continue
      }
      const d = found[0]!
      const err = worstCornerError(d.corners, pose)
      assert.equal(d.refined && err > 0.3, false, `cover ${JSON.stringify(cover)}: a refined read with a corner ${err.toFixed(2)} px out`)
      if (d.refined) continue
      refused++
      // What is reported for a read that is not refined is the polygon the geometry stage made, not a half-fitted mixture.
      const polygon = polygonOnly.detect(image).filter((x) => x.id === 9)
      assert.equal(polygon.length, 1, `cover ${JSON.stringify(cover)}: the polygon alone did not read`)
      assert.deepEqual(d.corners, polygon[0]!.corners, `cover ${JSON.stringify(cover)}: an unrefined read reports corners that are not the polygon's`)
      if (cover.onOutline && d.level === 0 && err < 2) onOutlineFinest++
    }
  }
  // The test has teeth only if the refusal is what happens: most of these frames are refused, not lucky.
  assert.ok(refused >= 0.7 * n, `only ${refused} of ${n} frames were refused`)
  // A strip over the middle of a side leaves its two ends, and the polygon's side is fitted to the outermost line the outline
  // supports there. Without that, the polygon settles on the strip's edge, which is too far in for the finest level's quad to
  // be accepted, and what is read is a coarse level's polygon, several pixels out.
  assert.ok(onOutlineFinest >= 20, `only ${onOutlineFinest} of ${onOutlineFrames} frames over the middle of a side were read at the finest level with the corners on the outline`)
})

/**
 * An axis-aligned, noise-free, whole-pixel version of the covered edge: a 72 px tag at (120, 80) in a 320x240 frame with a white strip over
 * part of its top border, binomially blurred. The corner positions are exact, so a corner error is the detector's alone.
 */
function pixelStripFrame(cover: { from: number; to: number; depthPx: number }): FiducialImage {
  const W = 320
  const H = 240
  const side = 72
  const cell = side / 7
  const x0 = 120
  const y0 = 80
  const pattern = CSCAN5_V1.pattern(12)
  const sharp = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = x + (sx + 0.5) / 4 - x0
          const v = y + (sy + 0.5) / 4 - y0
          let level = 110
          if (u >= -cell && u < side + cell && v >= -cell && v < side + cell) level = 230
          if (u >= 0 && u < side && v >= 0 && v < side) {
            const c = Math.floor(u / cell)
            const r = Math.floor(v / cell)
            level = r === 0 || c === 0 || r === 6 || c === 6 || pattern[(r - 1) * 5 + (c - 1)] ? 20 : 230
          }
          if (u >= cover.from * side && u < cover.to * side && v >= -0.01 && v < cover.depthPx) level = 230
          acc += level
        }
      }
      sharp[y * W + x] = acc / 16
    }
  }
  // A colour frame of grey pixels, quantised the way a canvas does (round half to even), as the strip map this was measured on was.
  const out = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0
      let weight = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1)
          sum += sharp[Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))]! * w
          weight += w
        }
      }
      const o = (y * W + x) * 4
      out[o] = sum / weight
      out[o + 1] = sum / weight
      out[o + 2] = sum / weight
      out[o + 3] = 255
    }
  }
  return { data: out, width: W, height: H, channels: 4 }
}

test('a strip over an edge, drawn exactly: up to 35 % of it never moves a refined corner, and the deep ones over more of it are refused', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const truth = [[120, 80], [192, 80], [192, 152], [120, 152]]
  const worst = (d: { corners: ReadonlyArray<{ x: number; y: number }> }) => Math.max(...d.corners.map((c, i) => Math.hypot(c.x - truth[i]![0]!, c.y - truth[i]![1]!)))
  let refined = 0
  // The reliable region of the table of strip length, position and depth that this build measured (a tag 72 px across, a strip 1 to 6 px deep over the
  // top edge): over a tenth to a third of the edge, from the middle or from a corner, the refined corners are within 0.07 px of the truth.
  for (const [from, to] of [[0.46, 0.54], [0.42, 0.58], [0.375, 0.625], [0.325, 0.675], [0, 0.1], [0, 0.2], [0, 0.35]] as const) {
    for (const depthPx of [1, 2, 3, 4, 5, 6]) {
      const found = det.detect(pixelStripFrame({ from, to, depthPx })).filter((d) => d.id === 12)
      if (found.length === 0) continue
      if (found[0]!.refined) {
        refined++
        assert.ok(worst(found[0]!) < 0.3, `strip ${from}-${to} ${depthPx} px: refined with a corner ${worst(found[0]!).toFixed(2)} px out`)
      }
    }
  }
  assert.ok(refined >= 36, `only ${refined} of 42 minority strips were refined`)
  // Cells measured to be refused: strips over half of an edge or more, 2 px deep or more. A step found at the edge of the search window (the real edge
  // being just beyond it) was once taken for the edge in the 60 % strips 6 px deep and called refined, 6 px out.
  let checked = 0
  const refused: Array<[number, number, number]> = [[0.3, 0.7, 2], [0.3, 0.7, 4], [0.25, 0.75, 2], [0.25, 0.75, 5], [0.2, 0.8, 3], [0.2, 0.8, 6], [0, 0.5, 2], [0, 0.5, 5], [0, 0.6, 2], [0, 0.6, 4], [0, 0.6, 6]]
  for (const [from, to, depthPx] of refused) {
    const found = det.detect(pixelStripFrame({ from, to, depthPx })).filter((d) => d.id === 12)
    if (found.length === 0) continue
    checked++
    assert.equal(found[0]!.refined, false, `strip ${from}-${to} ${depthPx} px: refined, with a corner ${worst(found[0]!).toFixed(2)} px out`)
  }
  assert.ok(checked >= 9, `${checked} of ${refused.length} refused cells were read at all`)
})

test('what the fit says about a covered edge: the share of samples on the line falls with the cover, and a refined read has at least 60 % of them', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const clean = coveredFrames({ from: 0, to: 0, depthCells: 0 }, 6).map(({ image }) => det.detect(image)[0]!)
  const covered = coveredFrames({ from: 0.35, to: 0.65, depthCells: 0.4 }, 6).map(({ image }) => det.detect(image)[0]!)
  for (const d of clean) assert.ok(d.edgeInlierFraction !== null && d.edgeInlierFraction > 0.9, `clean: ${d.edgeInlierFraction}`)
  for (const d of covered) {
    assert.equal(d.refined, true)
    assert.ok(d.edgeInlierFraction !== null && d.edgeInlierFraction >= 0.6 && d.edgeInlierFraction < 0.85, `a third of an edge covered: ${d.edgeInlierFraction}`)
  }
  // The fraction goes into the ranking score: the same tag with an edge covered ranks below the clean one.
  assert.ok(Math.min(...clean.map((d) => d.quality)) > Math.max(...covered.map((d) => d.quality)), 'a covered edge ranks below a clean one')
})

/** The tag with its top edge bowed outward by `sag` of a side at the middle (a curled sheet), the rest of the sheet carried with it. */
function bowedTag(sag: number): PlanarArtwork {
  return warpArtwork(dictionaryTagArtwork(CSCAN5_V1, 9, SIZE_M), (x, y) => [x, y - sag * SIZE_M * (1 - (x / HALF) ** 2) * Math.max(0, (y + HALF) / SIZE_M)], 0.03)
}

test('a bowed sheet: a bow of 1 % of a side moves the corners by about a pixel and is read; a bow past 1.5 % is refused as pose-grade', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  for (const [sag, refinedExpected] of [[0.005, true], [0.01, true], [0.025, false], [0.04, false]] as const) {
    let refined = 0
    let worst = 0
    for (let i = 0; i < 12; i++) {
      const pose = tagPose({ x: 0.02, y: -0.01, z: 1.4 }, i * 30 + 11, 8, 4)
      const image = renderFrame({ width: 640, height: 480, intrinsics: K, items: [{ artwork: bowedTag(sag), pose }], noiseSigma: 2, blurSigma: 0.6, seed: i + 1, supersample: 3 })
      const found = det.detect(image).filter((d) => d.id === 9)
      assert.equal(found.length, 1, `sag ${sag}, frame ${i}`)
      if (found[0]!.refined) refined++
      worst = Math.max(worst, worstCornerError(found[0]!.corners, pose))
    }
    if (refinedExpected) {
      assert.equal(refined, 12, `sag ${sag}: ${refined} of 12 refined`)
      // About the size of the bow, and the sheet's own distortion: the measurement is reported so a flatness requirement can be stated from it.
      assert.ok(worst < 1.6, `sag ${sag}: worst corner ${worst.toFixed(2)} px`)
    } else {
      assert.equal(refined, 0, `sag ${sag}: ${refined} of 12 refined, the corners are ${worst.toFixed(2)} px out`)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// Bare shapes, drawn pixel by pixel: which become candidates for decoding at all
// ---------------------------------------------------------------------------------------------

const W = 640
const H = 480
const CX = 320
const CY = 240

function shapeFrame(dark: (x: number, y: number) => boolean): FiducialImage {
  const d = new Uint8Array(W * H).fill(225)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dark(x + 0.5, y + 0.5)) d[y * W + x] = 25
  return { data: d, width: W, height: H, channels: 1 }
}

function polygon(n: number, radius = 45, rotation = 0.3): Array<[number, number]> {
  return Array.from({ length: n }, (_, i) => [CX + radius * Math.cos(rotation + (2 * Math.PI * i) / n), CY + radius * Math.sin(rotation + (2 * Math.PI * i) / n)] as [number, number])
}

function insidePolygon(pts: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!
    const [xj, yj] = pts[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function candidates(det: FiducialDetector, dark: (x: number, y: number) => boolean): number {
  det.detect(shapeFrame(dark))
  return det.stats.candidates
}

test('a filled square and a thick square outline become candidates; the matcher then refuses them, as they carry no code', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  assert.ok(candidates(det, (x, y) => Math.abs(x - CX) < 35 && Math.abs(y - CY) < 35) >= 1, 'a filled square is a candidate')
  assert.equal(det.stats.detections, 0)
  assert.ok(det.stats.rejected.contrast + det.stats.rejected.border + det.stats.rejected.match >= 1, `rejections: ${JSON.stringify(det.stats.rejected)}`)
  assert.ok(candidates(det, (x, y) => Math.max(Math.abs(x - CX), Math.abs(y - CY)) < 35 && Math.max(Math.abs(x - CX), Math.abs(y - CY)) >= 29) >= 1, 'a 6 px square band is a candidate')
})

test('a one-pixel outline is not a candidate: a band must be thick enough to be a tag\'s border', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  assert.equal(candidates(det, (x, y) => Math.max(Math.abs(x - CX), Math.abs(y - CY)) < 35 && Math.max(Math.abs(x - CX), Math.abs(y - CY)) >= 34), 0)
})

test('a shape that touches the frame edge is not a candidate: a tag cut off by the edge cannot be read', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  assert.ok(candidates(det, (x, y) => x > 4 && x < 74 && Math.abs(y - CY) < 35) >= 1, 'the same square a few pixels inside the frame is a candidate')
  assert.equal(candidates(det, (x, y) => x < 74 && Math.abs(y - CY) < 35), 0, 'touching the left edge')
  assert.equal(candidates(det, (x, y) => x > W - 74 && Math.abs(y - CY) < 35), 0, 'touching the right edge')
  assert.equal(candidates(det, (x, y) => y < 74 && Math.abs(x - CX) < 35), 0, 'touching the top edge')
  assert.equal(candidates(det, (x, y) => y > H - 74 && Math.abs(x - CX) < 35), 0, 'touching the bottom edge')
})

test('discs, triangles, pentagons, hexagons, L-shapes and crosses are not candidates: only quadrilaterals reach the matcher', () => {
  const det = new FiducialDetector(CSCAN5_V1)
  const shapes: Array<[string, (x: number, y: number) => boolean]> = [
    ['disc', (x, y) => Math.hypot(x - CX, y - CY) < 45],
    ['triangle', (x, y) => insidePolygon(polygon(3), x, y)],
    ['pentagon', (x, y) => insidePolygon(polygon(5), x, y)],
    ['hexagon', (x, y) => insidePolygon(polygon(6), x, y)],
    ['L shape', (x, y) => Math.abs(x - CX) < 35 && Math.abs(y - CY) < 35 && !(x > CX && y < CY)],
    ['cross', (x, y) => (Math.abs(x - CX) < 12 && Math.abs(y - CY) < 40) || (Math.abs(y - CY) < 12 && Math.abs(x - CX) < 40)],
  ]
  for (const [name, dark] of shapes) assert.equal(candidates(det, dark), 0, `${name} became a candidate`)
})
