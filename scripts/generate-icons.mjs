#!/usr/bin/env node
/**
 * scripts/generate-icons.mjs
 * Generates PWA icons at 192×192 and 512×512 using pure Node.js (no deps).
 * Run once: node scripts/generate-icons.mjs
 */
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(__dirname, '../public')

// ─── Minimal PNG encoder ──────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (~crc) >>> 0
}

function chunk(type, data) {
  const tBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const combined = Buffer.concat([tBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(combined), 0)
  return Buffer.concat([lenBuf, tBuf, data, crcBuf])
}

function encodePNG(size, rgbFn) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB

  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    row[0] = 0 // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b] = rgbFn(x, y, size)
      row[1 + x * 3] = Math.max(0, Math.min(255, r))
      row[2 + x * 3] = Math.max(0, Math.min(255, g))
      row[3 + x * 3] = Math.max(0, Math.min(255, b))
    }
    rows.push(row)
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 6 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── Icon pixel function ───────────────────────────────────────────────────────
// Design: dark navy bg · outer scan ring (cyan) · corner brackets · center dot
function iconPixel(x, y, size) {
  const cx = size / 2, cy = size / 2
  // Normalized coords -1..1
  const nx = (x - cx) / (size * 0.5)
  const ny = (y - cy) / (size * 0.5)
  const dist = Math.sqrt(nx * nx + ny * ny)
  const angle = Math.atan2(ny, nx)

  // Base background: dark navy, subtly brighter toward center
  const bg = 1 - Math.min(1, dist * 0.6)
  let r = Math.round(6 + bg * 14)
  let g = Math.round(10 + bg * 16)
  let b = Math.round(22 + bg * 26)

  // Outer scan ring (radius ~0.77)
  if (dist > 0.70 && dist < 0.84) {
    const fade = 1 - Math.abs(dist - 0.77) / 0.07
    r = Math.round(r + fade * (20 - r))
    g = Math.round(g + fade * (200 - g))
    b = Math.round(b + fade * (255 - b))
  }

  // Dashed mid ring (radius ~0.52)
  if (dist > 0.49 && dist < 0.55) {
    const dashAngle = ((angle % (Math.PI / 4)) + Math.PI * 2) % (Math.PI / 4)
    if (dashAngle < Math.PI / 4 * 0.55) {
      const fade = 1 - Math.abs(dist - 0.52) / 0.03
      r = Math.round(r + fade * (0 - r))
      g = Math.round(g + fade * (140 - g))
      b = Math.round(b + fade * (210 - b))
    }
  }

  // Corner brackets (viewfinder)
  // Each bracket: short horizontal + vertical arm at corner of a square
  const bPos = 0.44  // distance from center to corner of bracket square
  const bLen = 0.17  // length of each arm
  const bThk = 0.042 // thickness of arm
  const ax = Math.abs(nx), ay = Math.abs(ny)
  // Horizontal arm: x ∈ [bPos-bLen, bPos+bThk], y ∈ [bPos-bThk/2, bPos+bThk/2]
  const inHArm = ax >= bPos - bLen && ax <= bPos + bThk &&
                 ay >= bPos - bThk / 2 && ay <= bPos + bThk / 2
  // Vertical arm:   y ∈ [bPos-bLen, bPos+bThk], x ∈ [bPos-bThk/2, bPos+bThk/2]
  const inVArm = ay >= bPos - bLen && ay <= bPos + bThk &&
                 ax >= bPos - bThk / 2 && ax <= bPos + bThk / 2
  if (inHArm || inVArm) {
    r = Math.round(r * 0.1 + 60 * 0.9)
    g = Math.round(g * 0.1 + 220 * 0.9)
    b = Math.round(b * 0.1 + 255 * 0.9)
  }

  // Scan lines (subtle horizontal lines in the inner area)
  if (dist < 0.47) {
    const scanY = ((y / size) * 20) % 1
    if (scanY < 0.18) {
      r = Math.round(r + 8)
      g = Math.round(g + 20)
      b = Math.round(b + 30)
    }
  }

  // Center dot
  if (dist < 0.055) {
    const fade = 1 - dist / 0.055
    r = Math.round(r + fade * (80 - r))
    g = Math.round(g + fade * (230 - g))
    b = Math.round(b + fade * (255 - b))
  }

  return [r, g, b]
}

// ─── Generate ─────────────────────────────────────────────────────────────────
if (!existsSync(PUBLIC)) mkdirSync(PUBLIC, { recursive: true })

for (const size of [192, 512]) {
  const png = encodePNG(size, iconPixel)
  const out = join(PUBLIC, `icon-${size}.png`)
  writeFileSync(out, png)
  console.log(`✓ ${out}  (${(png.length / 1024).toFixed(1)} KB)`)
}

console.log('Done!')
