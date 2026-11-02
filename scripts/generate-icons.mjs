#!/usr/bin/env node
/**
 * Generates every app icon and launch image from the Companion mark, so the
 * PWA, the iOS shell and the Android shell ship one design:
 *
 *   npm run gen-icons
 *
 * The source is public/ci-logo-mark.svg. The background is the night-space
 * colour the app already uses (--background, theme_color, the Capacitor
 * backgroundColor). Chromium draws each image through Playwright, which is
 * already a dev dependency, so nothing new is installed.
 *
 * Store icons and launch images must carry no alpha channel. Those outputs are
 * re-encoded as RGB PNG here, because the browser only writes RGBA.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync, crc32 } from 'node:zlib'
import { chromium } from '@playwright/test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BG = '#041620'
const BG_RGB = [0x04, 0x16, 0x20]

// `mark` is the mark's width as a share of the image's shorter side. `rgb`
// writes an opaque RGB PNG. `round` clips to a circle, `transparent` drops the
// background (Android adaptive foregrounds).
const WEB = [
  { out: 'public/icon-192.png', width: 192, height: 192, mark: 0.62 },
  { out: 'public/icon-512.png', width: 512, height: 512, mark: 0.62 },
  // Maskable icons are cropped to a circle or squircle, so the mark sits inside the central 80%.
  { out: 'public/icon-maskable-512.png', width: 512, height: 512, mark: 0.46 },
  { out: 'public/apple-touch-icon.png', width: 180, height: 180, mark: 0.62, rgb: true },
]

const IOS_ICON = 'mobile/ios/App/App/Assets.xcassets'
const IOS = [
  { out: `${IOS_ICON}/AppIcon.appiconset/AppIcon-512@2x.png`, width: 1024, height: 1024, mark: 0.62, rgb: true },
  // The launch image is scaled to fill the screen and cropped at the sides, so the mark stays small and central.
  ...['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'].map((file) => ({
    out: `${IOS_ICON}/Splash.imageset/${file}`,
    width: 2732,
    height: 2732,
    mark: 0.16,
    rgb: true,
  })),
]

const ANDROID_RES = 'mobile/android/app/src/main/res'
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }
// Android 7.1+ round launchers take the round icon; the foreground keeps the mark inside the 66dp safe circle.
const ANDROID = [
  ...Object.entries(LEGACY).flatMap(([density, size]) => [
    { out: `${ANDROID_RES}/mipmap-${density}/ic_launcher.png`, width: size, height: size, mark: 0.62 },
    { out: `${ANDROID_RES}/mipmap-${density}/ic_launcher_round.png`, width: size, height: size, mark: 0.62, round: true },
  ]),
  ...Object.entries(FOREGROUND).map(([density, size]) => ({
    out: `${ANDROID_RES}/mipmap-${density}/ic_launcher_foreground.png`,
    width: size,
    height: size,
    mark: 0.46,
    transparent: true,
  })),
]

// Launch images, portrait and landscape, one per density bucket Capacitor writes.
const SPLASH = [
  { out: `${ANDROID_RES}/drawable/splash.png`, width: 480, height: 320, mark: 0.22, rgb: true },
  ...[
    ['mdpi', 320, 480, 480, 320],
    ['hdpi', 480, 800, 800, 480],
    ['xhdpi', 720, 1280, 1280, 720],
    ['xxhdpi', 960, 1600, 1600, 960],
    ['xxxhdpi', 1280, 1920, 1920, 1280],
  ].flatMap(([density, pw, ph, lw, lh]) => [
    { out: `${ANDROID_RES}/drawable-port-${density}/splash.png`, width: pw, height: ph, mark: 0.22, rgb: true },
    { out: `${ANDROID_RES}/drawable-land-${density}/splash.png`, width: lw, height: lh, mark: 0.22, rgb: true },
  ]),
]

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The mark's own markup, without its <svg> wrapper, so it can be placed at any size. */
function markInner() {
  const svg = readFileSync(join(ROOT, 'public/ci-logo-mark.svg'), 'utf8')
  return svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
}

async function renderPng(page, target, inner) {
  const { width, height, mark, round, transparent } = target
  const markPx = Math.round(Math.min(width, height) * mark)
  // The page must be transparent wherever the image is: outside a round icon, and everywhere on a foreground.
  const pageBackground = transparent || round ? 'transparent' : BG
  const stageBackground = transparent ? 'transparent' : BG
  // Headless Chromium cannot capture very small viewports, so draw on at least 512px and clip to the image.
  await page.setViewportSize({ width: Math.max(width, 512), height: Math.max(height, 512) })
  await page.setContent(`<!doctype html><html><head><style>
    html, body { margin: 0; background: ${pageBackground}; }
    #stage { width: ${width}px; height: ${height}px; display: flex; align-items: center; justify-content: center;
      background: ${stageBackground}; overflow: hidden; ${round ? 'border-radius: 50%;' : ''} }
  </style></head><body><div id="stage">
    <svg id="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 247.182 247.182"
      width="${markPx}" height="${markPx}">${inner}</svg>
  </div></body></html>`)
  // Centre the mark on its own ink, not on the padded viewBox the SVG ships with.
  await page.evaluate(() => {
    const svg = document.getElementById('mark')
    const box = svg.getBBox()
    const side = Math.max(box.width, box.height)
    const x = box.x + box.width / 2 - side / 2
    const y = box.y + box.height / 2 - side / 2
    svg.setAttribute('viewBox', `${x} ${y} ${side} ${side}`)
  })
  return page.screenshot({
    type: 'png',
    omitBackground: Boolean(transparent) || Boolean(round),
    clip: { x: 0, y: 0, width, height },
  })
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0)
  return Buffer.concat([head, data, tail])
}

/** Reverses the PNG scanline filters, leaving packed 8-bit RGBA pixels. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let predicted
      if (type === 0) predicted = 0
      else if (type === 1) predicted = a
      else if (type === 2) predicted = b
      else if (type === 3) predicted = (a + b) >> 1
      else if (type === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else throw new Error(`unknown PNG filter ${type}`)
      cur[x] = (line[x] + predicted) & 0xff
    }
    prev = cur
  }
  return out
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG, the two colour types Chromium writes. */
function decodePng(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG')
  let pos = 8
  let width
  let height
  let bpp
  const idat = []
  for (;;) {
    const length = png.readUInt32BE(pos)
    const type = png.toString('latin1', pos + 4, pos + 8)
    const body = png.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6)) {
        throw new Error('expected an 8-bit, non-interlaced RGB or RGBA PNG')
      }
      bpp = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + length
  }
  return { width, height, bpp, pixels: unfilter(inflateSync(Buffer.concat(idat)), width, height, bpp) }
}

/** Re-encodes a rendered PNG as RGB, flattening any alpha onto the background colour. */
function toRgbPng(png) {
  const { width, height, bpp, pixels } = decodePng(png)
  const rgb = Buffer.alloc(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    const alpha = bpp === 4 ? pixels[p * 4 + 3] / 255 : 1
    for (let k = 0; k < 3; k++) rgb[p * 3 + k] = Math.round(pixels[p * bpp + k] * alpha + BG_RGB[k] * (1 - alpha))
  }
  // Each scanline gets filter type 0 (none) in front of its pixels.
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const targets = [...WEB, ...IOS, ...ANDROID, ...SPLASH]
const inner = markInner()
let browser
try {
  browser = await chromium.launch()
} catch (err) {
  throw new Error(`generate-app-icons: Chromium is not available (${err.message.split('\n')[0]}). Run: npx playwright install chromium`)
}
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const target of targets) {
    let png = await renderPng(page, target, inner)
    if (target.rgb) png = toRgbPng(png)
    const file = join(ROOT, target.out)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, png)
    console.log(`${target.out}  ${target.width}x${target.height}`)
  }
} finally {
  await browser.close()
}
