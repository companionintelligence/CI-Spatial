/**
 * Generates synthetic room images for computer-vision pipeline testing.
 *
 *   node scripts/generate-cv-images.mjs            → test-data/cv/
 *
 * Each image is a pseudo-3D front view of a test home: wall/floor split with
 * furniture drawn as solid palette-coloured rectangles (the colours the mock
 * inference engine detects).  Ground-truth bounding boxes are written to
 * expected.json so /infer responses can be scored (IoU + label accuracy).
 *
 * Deterministic: derived from the seeded test-home definitions.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jimp } from 'jimp'
import { buildTestHomes } from '../src/shared/test-homes.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'test-data', 'cv')
mkdirSync(outDir, { recursive: true })

const IMG_W = 640
const IMG_H = 480
const FLOOR_LINE = 0.72 // wall/floor split as fraction of height

/** Fill an axis-aligned rect on the raw RGBA bitmap */
function fillRect(image, x0, y0, x1, y1, r, g, b) {
  const { width, height, data } = image.bitmap
  const xa = Math.max(0, Math.round(x0))
  const ya = Math.max(0, Math.round(y0))
  const xb = Math.min(width, Math.round(x1))
  const yb = Math.min(height, Math.round(y1))
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
}

/**
 * Project a furniture box to a 2D screen rect: orthographic front view where
 * depth (z) pushes objects up the image and shrinks them slightly.
 */
function projectItem(item, dims) {
  const [W, H, D] = dims
  const [x, , z] = item.position
  const [w, h, d] = item.size
  void d

  const depth = (z + D / 2) / D                 // 0 = front, 1 = back
  const scale = 1 - depth * 0.35                // farther → smaller
  const u = (x + W / 2) / W                     // 0…1 horizontal
  const floorY = IMG_H * (FLOOR_LINE - depth * 0.18)

  const pxW = (w / W) * IMG_W * 0.9 * scale
  const pxH = (h / H) * IMG_H * 0.62 * scale
  const cx = u * IMG_W
  return { x0: cx - pxW / 2, y0: floorY - pxH, x1: cx + pxW / 2, y1: floorY }
}

function rectsOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

const homes = buildTestHomes()
const selected = homes.filter((h) => h.index % 3 !== 2) // 16 of 24
const expected = []

for (const home of selected) {
  const image = new Jimp({ width: IMG_W, height: IMG_H, color: 0x000000ff })
  // Wall (light grey gradient) + floor (cool slate — kept far from every
  // palette colour so the mock detector never classifies the background)
  for (let y = 0; y < IMG_H; y++) {
    const onFloor = y >= IMG_H * FLOOR_LINE
    const wallShade = 205 - Math.round((y / IMG_H) * 35)
    const r = onFloor ? 58 : wallShade
    const g = onFloor ? 62 : wallShade
    const b = onFloor ? 72 : wallShade + 4
    fillRect(image, 0, y, IMG_W, y + 1, r, g, b)
  }

  // Draw farthest first so nearer items occlude — but skip true overlaps so
  // ground truth stays exact (the mock detector sees full rectangles).
  const items = [...home.furniture].sort((a, b) => b.position[2] - a.position[2])
  const drawn = []
  const truths = []
  for (const item of items) {
    const rect = projectItem(item, home.dims)
    if (rect.x0 < 4 || rect.x1 > IMG_W - 4 || rect.y0 < 4) continue
    if (drawn.some((d) => rectsOverlap(d, rect))) continue
    drawn.push(rect)
    fillRect(image, rect.x0, rect.y0, rect.x1, rect.y1, item.rgb[0], item.rgb[1], item.rgb[2])
    truths.push({
      label: item.label,
      bbox: [
        +(rect.x0 / IMG_W).toFixed(4),
        +(rect.y0 / IMG_H).toFixed(4),
        +(rect.x1 / IMG_W).toFixed(4),
        +(rect.y1 / IMG_H).toFixed(4),
      ],
    })
  }
  if (truths.length === 0) continue

  const file = `cv-${String(home.index).padStart(2, '0')}-${home.slug}.jpg`
  const jpeg = await image.getBuffer('image/jpeg', { quality: 92 })
  writeFileSync(join(outDir, file), jpeg)
  expected.push({ file, home: home.slug, width: IMG_W, height: IMG_H, detections: truths })
  console.log(`  ${file}  ${truths.length} objects  ${(jpeg.byteLength / 1024).toFixed(0)} KB`)
}

writeFileSync(join(outDir, 'expected.json'), JSON.stringify(expected, null, 2))
console.log(`\n[cv-images] ${expected.length} images → ${outDir}`)
