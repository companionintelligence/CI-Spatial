/**
 * The map tile source (src/geo/tile-source.ts) and the basemap on a Leaflet map
 * (src/geo/basemap-layer.ts).
 *
 * What it holds to the code: a map has no basemap unless the server names one, and then asks no
 * tile host for anything; a host that is not the app's own is asked about once per device before
 * any request; every tile request carries the Referer policy that lets the tile host see the page
 * and no other host; the credit is a link whenever tiles are shown; and a tile that is a
 * provider's notice, not a map, is reported and never drawn.
 *
 * The detector runs on two kinds of tile, and the difference matters:
 *  - REAL: tests/fixtures/basemap/carto-key-required.png is the file `carto_tile_test.png` of the
 *    WP-12 brief: 2,513 bytes, 256 by 256, the key-required tile CARTO sends for a keyless raster
 *    request, which the alignment investigation's critic reported receiving. Its SHA-256 is on
 *    KNOWN_FAILURE_TILES, and the first test holds the fixture and the list together.
 *  - SYNTHETIC: OpenStreetMap's "Access blocked" tiles. No real one was available: the build
 *    sandbox had no network, and requesting one would itself be a tile request. The OSM wiki's
 *    "Blocked tiles" page shows three of them (a missing Referer, a missing credit and a
 *    general policy block) without giving their HTTP status or bytes. Two stand-ins are built:
 *    a 256 by 256 grayscale PNG made with zlib in this file (a pale tile with a band of dark and
 *    pale pixels where lettering would be, same bytes for every address), and
 *    tests/fixtures/basemap/synthetic-notice-2colour-pillow.png, a two-colour palette PNG with
 *    lettering that Pillow 12.1.1 drew (a 256 px 'P' image with two palette entries, text in
 *    Pillow's default font at 14 and 9 points, saved with `bits=1`), which is small (under
 *    the size floor) the way a notice drawn in two colours is. They have what the brief says
 *    of the real one (a PNG that is the same for every tile) and no more. So what these tests
 *    show is that the detector catches a notice of that shape, not that it catches
 *    OpenStreetMap's own; that needs a real tile, listed as an open item (the three files on
 *    that wiki page, hashed).
 *
 * The flat-tile reader (isFlatPng, over readPngPixels) is held to two kinds of PNG as well.
 * Encoders: the builder in this file writes every colour type, bit depth and row filter, and
 * the reader must return the pixels that were encoded. Real encoders: the CARTO tile above
 * (written by CARTO's encoder), tests/fixtures/basemap/flat-512-rgba-pillow.png (Pillow's own
 * flat retina tile: `Image.new('RGBA', (512, 512), (170, 211, 223, 255)).save(path)`, 2,204
 * bytes, rows filtered by Pillow) and the synthetic notice. For those three the pixels the reader
 * returns are hashed against what Pillow, a decoder that is not this one, reads from the same files.
 *
 * What runs for real: everything in both modules except the DOM and Leaflet, which are
 * small stand-ins below (as legal_notices.test.ts does for the document). That a tile
 * paints on a phone is for a device or the browser specs. The wiring in main.ts, geomap.ts and
 * server/main.ts is read as source, in tests named "source shape:" that claim no behaviour.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/tile_source.test.ts
 * (or `npm run test:tile-source`, once that script is in package.json)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  BASEMAP_CONFIG_PROBLEMS,
  BASEMAP_ENV_VAR,
  DEFAULT_MAX_ZOOM,
  KNOWN_FAILURE_TILES,
  NOTICE_MIN_BYTES,
  TILE_ERROR_RUN,
  TILE_REFERRER_POLICY,
  attributionHtml,
  basemapFromEnv,
  basemapProblemText,
  basemapStatusText,
  classifyTile,
  imageFormat,
  isFlatPng,
  judgeTiles,
  noBasemap,
  normalizeBasemap,
  readPngPixels,
  sha256Hex,
  tileHost,
  tileOrigin,
  tileSampleFromBytes,
  tileUrl,
  tileXY,
  type BasemapConfig,
  type BasemapConfigProblem,
  type BasemapStatus,
  type TileSample,
} from '../../../src/geo/tile-source.ts'
import { attachBasemap, fetchTileSample, readAnswer, writeAnswer, type ConsentStorage } from '../../../src/geo/basemap-layer.ts'
import { BASEMAP_CONSENT_KEY } from '../../../src/shared/storage-keys.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// ── Tiles ─────────────────────────────────────────────────────────────────────

/** REAL: the key-required tile CARTO sends for a keyless raster request. */
const CARTO_TILE = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/basemap/carto-key-required.png')))

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** The parts end to end. */
function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A 256 by 256 8-bit grayscale PNG of `pixel(x, y)`, filter 0, zlib level 9. */
function png(pixel: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array(256 * (256 + 1))
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) raw[y * 257 + 1 + x] = pixel(x, y)
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, 256)
  view.setUint32(4, 256)
  header[8] = 8 // bit depth
  header[9] = 0 // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/** Deterministic pseudo-random bits, so every run builds the same bytes. */
function bits(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 31 }
}

/**
 * SYNTHETIC: stands in for an OpenStreetMap "Access blocked" tile. A pale tile with a band of
 * dark and pale pixels where lettering would be: not the real picture, and not claimed to be.
 */
const NOTICE_TILE = (() => {
  const next = bits(0x0b10c4ed)
  const lettering = Array.from({ length: 48 * 256 }, () => next())
  return png((x, y) => (y >= 100 && y < 148 && lettering[(y - 100) * 256 + x] ? 40 : 238))
})()

/** A map-like tile: content that depends on where it is, as a real tile's does. */
function mapTile(z: number, x: number, y: number): Uint8Array {
  const next = bits(z * 7919 + x * 104729 + y * 1299709 + 1)
  const blocks = Array.from({ length: 64 * 64 }, () => next() * 40 + next() * 20 + next() * 10 + 120)
  return png((px, py) => blocks[(py >> 2) * 64 + (px >> 2)]!)
}

/** A blank tile: open sea, or one flat fill. The same bytes in every place, and small. */
const BLANK_TILE = png(() => 232)

/** REAL encoder: Pillow's flat retina tile, 512 by 512 RGBA in a sea colour. One flat fill, and over the size floor. */
const FLAT_RETINA_TILE = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/basemap/flat-512-rgba-pillow.png')))

/** SYNTHETIC picture, real encoder: lettering in two colours on a flat colour, as Pillow drew it. Not flat, and under the size floor. */
const SMALL_NOTICE_TILE = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/basemap/synthetic-notice-2colour-pillow.png')))

// ── A PNG builder for the flat-tile reader: any colour type, bit depth and row filter ─────────

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

interface PngSpec {
  width: number
  height: number
  depth: 1 | 2 | 4 | 8 | 16
  colourType: 0 | 2 | 3 | 4 | 6
  /** The unfiltered pixel bytes of row `y`. */
  row: (y: number) => Uint8Array
  /** The filter byte of row `y`, 0 to 4. */
  filter?: (y: number) => number
  /** The IHDR interlace byte. */
  interlace?: number
  /** The IHDR compression byte. */
  compression?: number
  /** Cut the compressed data into IDAT chunks this long. */
  split?: number
  /** Leave the IEND chunk out, as a file cut short does. */
  noEnd?: boolean
}

/** The PNG specification's predictor, 9.4: whichever of left, up and up-left is nearest `left + up - upLeft`, ties in that order. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
  const nearest = Math.min(...distances)
  return [left, up, upLeft][distances.indexOf(nearest)]!
}

/** The scanlines with each row's filter applied: a filter byte, then each byte minus what the filter predicts from the unfiltered neighbours. */
function filterRows(spec: PngSpec): Uint8Array {
  const bytesBack = Math.max(1, (CHANNELS[spec.colourType]! * spec.depth) >> 3)
  const rows = Array.from({ length: spec.height }, (_, y) => spec.row(y))
  const rowBytes = rows[0]!.length
  const out = new Uint8Array(spec.height * (rowBytes + 1))
  rows.forEach((row, y) => {
    const above = y > 0 ? rows[y - 1]! : new Uint8Array(rowBytes)
    const kind = spec.filter ? spec.filter(y) : 0
    out[y * (rowBytes + 1)] = kind
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bytesBack ? row[i - bytesBack]! : 0
      const up = above[i]!
      const upLeft = i >= bytesBack ? above[i - bytesBack]! : 0
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][kind] ?? 0
      out[y * (rowBytes + 1) + 1 + i] = (row[i]! - predicted) & 0xff
    }
  })
  return out
}

function encodePng(spec: PngSpec): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, spec.width)
  view.setUint32(4, spec.height)
  header[8] = spec.depth
  header[9] = spec.colourType
  header[10] = spec.compression ?? 0
  header[12] = spec.interlace ?? 0
  const compressed = deflateSync(filterRows(spec), { level: 9 })
  const parts = [PNG_SIGNATURE, chunk('IHDR', header)]
  if (spec.colourType === 3) parts.push(chunk('PLTE', new Uint8Array([0, 0, 0, 170, 211, 223, 255, 255, 255, 10, 20, 30])))
  const size = spec.split ?? compressed.length
  for (let at = 0; at < compressed.length; at += size) parts.push(chunk('IDAT', compressed.subarray(at, at + size)))
  if (!spec.noEnd) parts.push(chunk('IEND', new Uint8Array(0)))
  return joinBytes(...parts)
}

/** One pixel's bytes for a colour type and depth, none of them 0 or 255 alone so no filter predicts them by luck; for 1, 2 and 4 bits, a slot value. */
function flatPixel(colourType: number, depth: number): number[] {
  if (depth < 8) return [Math.max(1, (1 << depth) >> 1)]
  return Array.from({ length: (CHANNELS[colourType]! * depth) >> 3 }, (_, i) => (170 + 41 * i) & 0xff)
}

/** A row of `width` pixels that are all `pixel`. Packed depths fill every slot of each byte with the slot value. */
function flatRow(width: number, depth: number, pixel: number[]): Uint8Array {
  if (depth >= 8) {
    const row = new Uint8Array(width * pixel.length)
    for (let x = 0; x < width; x++) row.set(pixel, x * pixel.length)
    return row
  }
  return new Uint8Array((width * depth) / 8).fill(pixel[0]! * ({ 1: 0xff, 2: 0x55, 4: 0x11 } as Record<number, number>)[depth]!)
}

/** `row` with the pixel at `x` changed: the low bit of its last byte, or of its slot when pixels are packed. */
function withPixelChanged(row: Uint8Array, x: number, depth: number, bytesPerPixel: number): Uint8Array {
  const changed = row.slice()
  if (depth >= 8) changed[x * bytesPerPixel + bytesPerPixel - 1]! ^= 1
  else changed[Math.floor((x * depth) / 8)]! ^= 1 << (8 - depth - ((x * depth) % 8))
  return changed
}

async function sample(bytes: Uint8Array, over: Partial<TileSample> = {}): Promise<TileSample> {
  return { ...(await tileSampleFromBytes(bytes, { status: 200, contentType: 'image/png' })), ...over }
}

// ── The setting ───────────────────────────────────────────────────────────────

const CREDIT = { text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' }
const GOOD = { urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: [CREDIT], maxZoom: 19 }
const env = (value: string | undefined) => (name: string) => (name === BASEMAP_ENV_VAR ? value : undefined)

test('no setting means no basemap, whatever else the environment holds', () => {
  for (const value of [undefined, '', '   ']) {
    assert.deepEqual(basemapFromEnv(env(value)), noBasemap(), `value ${JSON.stringify(value)}`)
  }
  assert.deepEqual(basemapFromEnv((name) => (name === 'MAP_TILE_URL' ? 'something else' : undefined)), noBasemap(), 'another variable is not this one')
  const none = noBasemap()
  assert.equal(none.kind, 'none')
  assert.equal(none.urlTemplate, '', 'no address is built in: not as a default, not as a fallback')
  assert.deepEqual(none.attribution, [])
  assert.equal(none.problem, undefined)
})

test('a valid setting is a raster basemap, as the server reports it', () => {
  const config = basemapFromEnv(env(JSON.stringify(GOOD)))
  assert.deepEqual(config, { kind: 'raster', urlTemplate: GOOD.urlTemplate, attribution: [CREDIT], maxZoom: 19, requiresKey: false })
  assert.deepEqual(normalizeBasemap(config), config, 'what the server sends validates to itself, so the page and the server share one set of rules')
  assert.equal(normalizeBasemap({ ...GOOD, maxZoom: undefined }).maxZoom, DEFAULT_MAX_ZOOM)
  assert.equal(normalizeBasemap({ ...GOOD, attribution: CREDIT }).attribution.length, 1, 'one credit may be given without a list')
})

test('a key in the address, or the setting, marks the basemap as one that needs a key', () => {
  for (const query of ['?key=abc', '?api_key=abc', '?apikey=abc', '?access_token=abc', '?x=1&token=abc', '?KEY=abc', '?Api_Key=abc', '?ACCESS_TOKEN=abc']) {
    assert.equal(normalizeBasemap({ ...GOOD, urlTemplate: `https://tiles.example.com/{z}/{x}/{y}.png${query}` }).requiresKey, true, query)
  }
  assert.equal(normalizeBasemap(GOOD).requiresKey, false)
  assert.equal(normalizeBasemap({ ...GOOD, requiresKey: true }).requiresKey, true)
  assert.equal(normalizeBasemap({ ...GOOD, urlTemplate: `${GOOD.urlTemplate}?key=abc`, requiresKey: false }).requiresKey, false, 'the setting wins')
})

test('Docker keeps the quotes a shell would strip, and the setting still reads', () => {
  const json = JSON.stringify(GOOD)
  assert.equal(basemapFromEnv(env(`'${json}'`)).kind, 'raster')
  assert.equal(basemapFromEnv(env(`  ${json}\n`)).kind, 'raster', 'a value with spaces or a newline around it, as an env file can leave one')
  assert.equal(basemapFromEnv(env(`"${json.replaceAll('"', '\\"')}"`)).problem, 'not-json', 'only a plain quoted value is unwrapped, not an escaped string')
})

test('a setting that cannot be used is no basemap, with the reason, and never a half-built one', () => {
  const cases: Array<[string, unknown, BasemapConfigProblem]> = [
    ['not JSON', '{nope', 'not-json'],
    ['JSON null', 'null', 'invalid'],
    ['a number', '3', 'invalid'],
    ['a list', '[]', 'invalid'],
    ['an unknown kind', JSON.stringify({ ...GOOD, kind: 'tms' }), 'unknown-kind'],
    ['no address', JSON.stringify({ attribution: [CREDIT] }), 'no-url'],
    ['an empty address', JSON.stringify({ ...GOOD, urlTemplate: '  ' }), 'no-url'],
    ['http', JSON.stringify({ ...GOOD, urlTemplate: 'http://tiles.example.com/{z}/{x}/{y}.png' }), 'bad-url'],
    ['a relative address', JSON.stringify({ ...GOOD, urlTemplate: '/tiles/{z}/{x}/{y}.png' }), 'bad-url'],
    ['a user name in the address', JSON.stringify({ ...GOOD, urlTemplate: 'https://me:pw@tiles.example.com/{z}/{x}/{y}.png' }), 'bad-url'],
    ['no {y}', JSON.stringify({ ...GOOD, urlTemplate: 'https://tiles.example.com/{z}/{x}.png' }), 'bad-template'],
    ['{s} subdomains', JSON.stringify({ ...GOOD, urlTemplate: 'https://{s}.tiles.example.com/{z}/{x}/{y}.png' }), 'bad-template'],
    ['another placeholder', JSON.stringify({ ...GOOD, urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png?k={key}' }), 'bad-template'],
    ['no credit', JSON.stringify({ urlTemplate: GOOD.urlTemplate }), 'no-attribution'],
    ['an empty credit list', JSON.stringify({ ...GOOD, attribution: [] }), 'no-attribution'],
    ['a credit with no link', JSON.stringify({ ...GOOD, attribution: [{ text: 'x' }] }), 'bad-attribution'],
    ['a credit with no text', JSON.stringify({ ...GOOD, attribution: [{ text: ' ', href: CREDIT.href }] }), 'bad-attribution'],
    ['a credit link that is http', JSON.stringify({ ...GOOD, attribution: [{ text: 'x', href: 'http://example.com' }] }), 'bad-attribution'],
    ['a credit link that is a script', JSON.stringify({ ...GOOD, attribution: [{ text: 'x', href: 'javascript:alert(1)' }] }), 'bad-attribution'],
    ['a credit link with a user name', JSON.stringify({ ...GOOD, attribution: [{ text: 'x', href: 'https://me:pw@example.com/' }] }), 'bad-attribution'],
    ['five credits', JSON.stringify({ ...GOOD, attribution: Array.from({ length: 5 }, () => CREDIT) }), 'bad-attribution'],
    ['a fractional zoom', JSON.stringify({ ...GOOD, maxZoom: 18.5 }), 'bad-zoom'],
    ['a zoom out of range', JSON.stringify({ ...GOOD, maxZoom: 23 }), 'bad-zoom'],
    ['requiresKey that is not a boolean', JSON.stringify({ ...GOOD, requiresKey: 'yes' }), 'invalid'],
  ]
  for (const [what, value, problem] of cases) {
    const config = basemapFromEnv(env(value as string))
    assert.deepEqual(config, noBasemap(problem), what)
    assert.ok(basemapProblemText(problem).length > 0, `${what}: the reason has words`)
  }
})

test('a placeholder in the host or the port is refused: the host a person is asked about is the host the requests go to', () => {
  const inTheHost = [
    'https://{z}.tiles.example.com/{x}/{y}.png',
    'https://tiles.example.com.{x}.attacker.example/{z}/{y}.png',
    'https://tiles.example.com:{z}/{x}/{y}.png',
    'https://{x}{y}{z}.attacker.example/a.png',
    'https://tiles.example.com{r}/{z}/{x}/{y}.png',
    'https://tiles.example.com@{r}/{z}/{x}/{y}.png',
    'HTTPS:{z}.tiles.example.com/{x}/{y}.png',
    'https:///{z}.tiles.example.com/{x}/{y}.png',
  ]
  for (const urlTemplate of inTheHost) assert.deepEqual(normalizeBasemap({ ...GOOD, urlTemplate }), noBasemap('bad-template'), urlTemplate)
  assert.match(basemapProblemText('bad-template'), /after the host/, 'the reason says where placeholders go')
})

test('every address that is accepted sends its requests to the host the person is asked about, at any zoom and on any screen', () => {
  const accepted = [
    'https://tiles.example.com/{z}/{x}/{y}.png',
    'https://tiles.example.com/{z}/{x}/{y}{r}.png?key=k',
    'https://TILES.Example.COM:443/{z}/{x}/{y}.png',
    'https://tiles.example.com:8443/{z}/{x}/{y}.png',
    'https://tiles.example.com\\{z}\\{x}\\{y}.png',
    'https://tiles.example.com?z={z}&x={x}&y={y}',
    'https:tiles.example.com/{z}/{x}/{y}.png',
    'https://[::1]:8443/{z}/{x}/{y}.png',
  ]
  for (const urlTemplate of accepted) {
    const config = normalizeBasemap({ ...GOOD, urlTemplate })
    assert.equal(config.kind, 'raster', urlTemplate)
    for (const retina of [false, true]) {
      for (const tile of [{ z: 0, x: 0, y: 0 }, { z: 16, x: 32744, y: 21792 }, { z: 22, x: 4194303, y: 4194303 }]) {
        const requested = new URL(tileUrl(config.urlTemplate, tile, retina))
        assert.equal(requested.host, tileHost(config.urlTemplate), `${urlTemplate}: the request goes to the host the person is asked about`)
        assert.equal(requested.origin, tileOrigin(config.urlTemplate), `${urlTemplate}: and to the origin that is compared with the app's own`)
      }
    }
  }
})

test('a server\'s "no basemap, and here is why" validates to itself, so the map can say why', () => {
  for (const problem of BASEMAP_CONFIG_PROBLEMS) {
    assert.deepEqual(normalizeBasemap(noBasemap(problem)), noBasemap(problem), problem)
    assert.deepEqual(normalizeBasemap(JSON.parse(JSON.stringify(noBasemap(problem)))), noBasemap(problem), `${problem}, as it arrives in JSON`)
    assert.ok(basemapProblemText(problem).length > 0, `${problem} has words`)
  }
  assert.deepEqual(normalizeBasemap({ kind: 'none', problem: 'not-a-code' }), noBasemap(), 'a code this build does not know is dropped')
  assert.deepEqual(normalizeBasemap({ kind: 'none', problem: { text: '<script>' } }), noBasemap(), 'and so is anything that is not one of the codes')
})

test('a vector source is kept as vector, and is not drawn', () => {
  const config = basemapFromEnv(env(JSON.stringify({ kind: 'vector', urlTemplate: 'https://tiles.example.com/style.json' })))
  assert.equal(config.kind, 'vector')
  assert.equal(config.urlTemplate, '', 'the address is not carried: nothing here can draw it')
  assert.equal(basemapStatusText({ state: 'unsupported' }).headline, 'Vector tiles are not supported in this build')
})

test('an older server, with no basemap block, is no basemap and no problem', () => {
  assert.deepEqual(normalizeBasemap(undefined), noBasemap())
  assert.deepEqual(normalizeBasemap(null), noBasemap())
  assert.equal(normalizeBasemap('text').problem, 'invalid')
})

test('the reason a setting was refused never repeats the setting, which may hold a key', () => {
  const secret = 'sk_live_do_not_log_me'
  const config = basemapFromEnv(env(JSON.stringify({ urlTemplate: `http://tiles.example.com/{z}/{x}/{y}.png?key=${secret}`, attribution: [CREDIT] })))
  assert.equal(config.problem, 'bad-url')
  assert.doesNotMatch(JSON.stringify(config) + basemapProblemText(config.problem!), new RegExp(secret))
})

test('ADR 0002: the module the server and the browser both import holds no server-runtime reference', () => {
  assert.doesNotMatch(read('src/geo/tile-source.ts'), /\bDeno\b|\bdocument\.|\bwindow\.|\blocalStorage\b|\bHTMLElement\b/, 'no Deno, no DOM: grep Deno. finds nothing, as ADR 0002 asks')
})

test('the check can start from a tile\'s bytes, and the same bytes give the same verdict as the sample the page builds', async () => {
  const fromBytes = await tileSampleFromBytes(CARTO_TILE, { status: 200, contentType: 'image/png' })
  assert.deepEqual(fromBytes, { status: 200, contentType: 'image/png', byteLength: 2513, sha256: 'cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc', format: 'png', flat: false })
  assert.deepEqual(classifyTile(fromBytes), { ok: false, problem: 'key-required' })
})

test('no tile provider is named anywhere the browser loads, and none is built in', () => {
  const skip = new Set(['node_modules', 'models'])
  const text = /\.(ts|js|mjs|html|css|json|md|txt|svg|webmanifest)$/
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(path) } else if (text.test(entry.name) && /cartocdn/i.test(read(path))) hits.push(path)
    }
  }
  walk('src')
  walk('public')
  for (const page of ['index.html', 'viewer.html', 'scanner.html', 'webxr.html', 'xr-world.html']) if (/cartocdn/i.test(read(page))) hits.push(page)
  assert.deepEqual(hits, [], 'grep -rn cartocdn src/ public/ returns nothing')
})

// ── Addresses ─────────────────────────────────────────────────────────────────

test('tileXY puts a point in the standard web-mercator tile', () => {
  // Reference values from python's math, with the textbook ln(tan(lat) + 1/cos(lat)): not the asinh form the code uses.
  assert.deepEqual(tileXY(51.5074, -0.1278, 10), { x: 511, y: 340 }, 'London at zoom 10')
  assert.deepEqual(tileXY(51.5074, -0.1278, 16), { x: 32744, y: 21792 }, 'London at zoom 16')
  assert.deepEqual(tileXY(0, 0, 1), { x: 1, y: 1 })
  assert.deepEqual(tileXY(35.6762, 139.6503, 14), { x: 14547, y: 6451 }, 'Tokyo at zoom 14')
  assert.deepEqual(tileXY(-33.8688, 151.2093, 8), { x: 235, y: 153 }, 'Sydney at zoom 8')
  assert.deepEqual(tileXY(10, -180.5, 2), { x: 3, y: 1 }, 'longitude wraps')
  assert.deepEqual(tileXY(89.9, 0, 3), { x: 4, y: 0 }, 'latitude is clamped to the poles of the projection')
  assert.deepEqual(tileXY(-89.9, 0, 3), { x: 4, y: 7 })
})

test('tileUrl fills the placeholders as Leaflet does, {r} included', () => {
  const template = 'https://tiles.example.com/{z}/{x}/{y}{r}.png?key=k'
  assert.equal(tileUrl(template, { z: 17, x: 65535, y: 43210 }, false), 'https://tiles.example.com/17/65535/43210.png?key=k')
  assert.equal(tileUrl(template, { z: 3, x: 4, y: 5 }, true), 'https://tiles.example.com/3/4/5@2x.png?key=k')
  assert.equal(tileHost('https://tiles.example.com:8443/{z}/{x}/{y}.png'), 'tiles.example.com:8443')
  assert.equal(tileOrigin('https://tiles.example.com:8443/{z}/{x}/{y}.png'), 'https://tiles.example.com:8443')
  assert.equal(tileHost('not an address'), null)
})

test('the credit is a real link that leaves the app, and a setting cannot put markup in the page', () => {
  const html = attributionHtml([CREDIT, { text: 'Tiles by <b>Example</b> & "Co"', href: 'https://example.com/a?b=1&c="2"' }])
  const links = [...html.matchAll(/<a href="([^"]*)" target="_blank" rel="noopener noreferrer">([^<]*)<\/a>/g)]
  assert.equal(links.length, 2, 'every credit is an <a> with a real href')
  assert.equal(links[0]![1], CREDIT.href)
  assert.equal(links[0]![2], CREDIT.text)
  assert.doesNotMatch(html, /<b>|"Co"/, 'the text is escaped')
  const credits = normalizeBasemap({ ...GOOD, attribution: [{ text: 'x', href: 'https://example.com/a"onmouseover="alert(1)' }] }).attribution
  assert.doesNotMatch(attributionHtml(credits), /"onmouseover/, 'a quote in a link is encoded, not an attribute break')
  assert.equal(attributionHtml([]), '', 'no credits, no markup: the layer is never added without one')
})

test('the Referer policy is one OpenStreetMap lists as keeping the Referer', () => {
  // https://wiki.openstreetmap.org/wiki/Referer, read 2026-11-16: these keep it; no-referrer and same-origin break it.
  assert.ok(['no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(TILE_REFERRER_POLICY))
})

// ── Telling a notice from a map ───────────────────────────────────────────────

test('the real CARTO key-required tile is reported as a missing key, and the list holds the file', async () => {
  assert.equal(CARTO_TILE.length, 2513, 'the fixture is the 2,513-byte tile of the brief')
  assert.equal(imageFormat(CARTO_TILE), 'png')
  const hash = await sha256Hex(CARTO_TILE)
  assert.equal(hash, 'cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc')
  assert.deepEqual(KNOWN_FAILURE_TILES.map((tile) => ({ problem: tile.problem, byteLength: tile.byteLength, sha256: tile.sha256 })), [
    { problem: 'key-required', byteLength: 2513, sha256: hash },
  ])
  assert.deepEqual(classifyTile(await sample(CARTO_TILE)), { ok: false, problem: 'key-required' })
  assert.deepEqual(judgeTiles(await sample(CARTO_TILE), await sample(CARTO_TILE)), { ok: false, problem: 'key-required' })
})

test('the key-required tile is named as such even when it comes with an error status', async () => {
  assert.deepEqual(classifyTile(await sample(CARTO_TILE, { status: 403 })), { ok: false, problem: 'key-required' }, 'a named failure says more than the status that carried it')
})

test('one byte different is not the key-required tile, and the size must match as well as the hash', async () => {
  const altered = CARTO_TILE.slice()
  altered[altered.length - 20] ^= 0xff
  assert.deepEqual(classifyTile(await sample(altered)), { ok: true, checked: true })
  assert.deepEqual(classifyTile(await sample(CARTO_TILE, { byteLength: 2514 })), { ok: true, checked: true })
})

test('a map-like tile passes, and so does a pair of different tiles', async () => {
  const here = mapTile(17, 65488, 43591)
  const beside = mapTile(17, 65489, 43591)
  assert.notDeepEqual(here, beside)
  assert.ok(here.length > NOTICE_MIN_BYTES, 'the stand-in map tile is not small')
  assert.deepEqual(classifyTile(await sample(here)), { ok: true, checked: true })
  assert.deepEqual(judgeTiles(await sample(here), await sample(beside)), { ok: true, checked: true })
})

test('SYNTHETIC OSM-style notice: one picture for two different tiles is a notice, not a map', async () => {
  assert.equal(imageFormat(NOTICE_TILE), 'png')
  assert.ok(NOTICE_TILE.length >= NOTICE_MIN_BYTES, `the stand-in is ${NOTICE_TILE.length} bytes, as a notice with words on it is`)
  const verdict = judgeTiles(await sample(NOTICE_TILE), await sample(NOTICE_TILE))
  assert.deepEqual(verdict, { ok: false, problem: 'notice' })
  // The same two requests, answered with a real tile each, are not a notice.
  assert.equal(judgeTiles(await sample(mapTile(17, 1, 1)), await sample(mapTile(17, 2, 1))).ok, true)
})

test('a flat tile in two places is not a notice, however large it is', async () => {
  const blank = await sample(BLANK_TILE)
  assert.equal(blank.flat, true)
  assert.deepEqual(judgeTiles(blank, blank), { ok: true, checked: true }, 'open sea, a forest, an empty part of an extract: the one picture a map repeats')
  // A real encoder's flat retina tile is over the old size floor, and is still only sea.
  assert.ok(FLAT_RETINA_TILE.length > NOTICE_MIN_BYTES, `Pillow's flat 512 px RGBA tile is ${FLAT_RETINA_TILE.length} bytes`)
  const retina = await sample(FLAT_RETINA_TILE)
  assert.equal(retina.flat, true)
  assert.deepEqual(judgeTiles(retina, retina), { ok: true, checked: true }, 'a size floor alone would have called this a notice, and Check again would not have helped')
})

test('lettering in two colours is a notice, though it is smaller than the size floor', async () => {
  assert.ok(SMALL_NOTICE_TILE.length < NOTICE_MIN_BYTES, `the stand-in is ${SMALL_NOTICE_TILE.length} bytes`)
  assert.equal(imageFormat(SMALL_NOTICE_TILE), 'png')
  const small = await sample(SMALL_NOTICE_TILE)
  assert.equal(small.flat, false, 'two colours are not one flat fill')
  assert.deepEqual(judgeTiles(small, small), { ok: false, problem: 'notice' })
  assert.deepEqual(judgeTiles(small, await sample(mapTile(17, 2, 1))), { ok: true, checked: true }, 'but not when the neighbour is a different tile')
})

test('a picture that could not be read falls back to the size floor, which a flat WebP is under and a JPEG is not', async () => {
  const noisy = (length: number, seed: number, magic: number[]): Uint8Array => {
    const next = bits(seed)
    const out = Uint8Array.from({ length }, () => (next() << 7) | (next() << 6) | (next() << 5) | (next() << 4) | (next() << 3) | (next() << 2) | (next() << 1) | next())
    out.set(magic)
    return out
  }
  const webp = (length: number, seed: number) => noisy(length, seed, [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const jpeg = (length: number, seed: number) => noisy(length, seed, [0xff, 0xd8, 0xff, 0xe0])
  const bigWebp = await sample(webp(NOTICE_MIN_BYTES, 1), { contentType: 'image/webp' })
  const smallWebp = await sample(webp(NOTICE_MIN_BYTES - 1, 2), { contentType: 'image/webp' })
  assert.equal(bigWebp.format, 'webp')
  assert.equal(bigWebp.flat, null, 'a WebP is not read for flatness')
  assert.deepEqual(judgeTiles(bigWebp, bigWebp), { ok: false, problem: 'notice' }, 'the same WebP for two places at the floor or over it is a notice')
  assert.deepEqual(judgeTiles(smallWebp, smallWebp), { ok: true, checked: true }, 'under the floor it passes: a flat 256 px WebP is 44 to 192 bytes (Pillow 12.1.1)')
  // The floor cannot tell a flat JPEG from a notice: a flat 256 px JPEG is 1,652 bytes (Pillow 12.1.1), over it.
  const flatSizedJpeg = await sample(jpeg(1652, 3), { contentType: 'image/jpeg' })
  assert.equal(flatSizedJpeg.flat, null)
  assert.deepEqual(judgeTiles(flatSizedJpeg, flatSizedJpeg), { ok: false, problem: 'notice' }, 'the limit NOTICE_MIN_BYTES names: the same JPEG for two places is a notice')
  // A PNG this reader does not read (interlaced) is judged the same way, by size.
  const noise = bits(5)
  const row = () => Uint8Array.from({ length: 64 }, () => (noise() << 7) | (noise() << 6) | (noise() << 5) | (noise() << 4) | (noise() << 3) | (noise() << 2) | (noise() << 1) | noise())
  const interlacedNoisy = await sample(encodePng({ width: 64, height: 64, depth: 8, colourType: 0, row, interlace: 1 }))
  const interlacedFlat = await sample(encodePng({ width: 64, height: 64, depth: 8, colourType: 0, row: () => new Uint8Array(64).fill(9), interlace: 1 }))
  assert.equal(interlacedNoisy.flat, null)
  assert.equal(interlacedFlat.flat, null)
  assert.ok(interlacedNoisy.byteLength >= NOTICE_MIN_BYTES, `${interlacedNoisy.byteLength} bytes`)
  assert.ok(interlacedFlat.byteLength < NOTICE_MIN_BYTES, `${interlacedFlat.byteLength} bytes`)
  assert.deepEqual(judgeTiles(interlacedNoisy, interlacedNoisy), { ok: false, problem: 'notice' })
  assert.deepEqual(judgeTiles(interlacedFlat, interlacedFlat), { ok: true, checked: true })
})

test('the neighbour is judged on its own: a known notice, a refusal, a limit or a login page beside a good tile is reported', async () => {
  const good = await sample(mapTile(17, 1, 1))
  const other = mapTile(17, 2, 1)
  assert.deepEqual(judgeTiles(good, await sample(CARTO_TILE)), { ok: false, problem: 'key-required' }, 'the known key-required tile as the neighbour')
  for (const status of [401, 403, 451]) assert.deepEqual(judgeTiles(good, await sample(other, { status })), { ok: false, problem: 'refused', httpStatus: status }, String(status))
  assert.deepEqual(judgeTiles(good, await sample(other, { status: 429 })), { ok: false, problem: 'rate-limited', httpStatus: 429 }, 'a limiter that answers the second request')
  const html = new TextEncoder().encode('<html>Sign in</html>')
  assert.deepEqual(judgeTiles(good, await sample(html, { contentType: 'text/html' })), { ok: false, problem: 'not-an-image' })
  // A neighbour that is merely missing is not held against the map: the tile under the centre decides.
  for (const status of [404, 500, 503]) assert.deepEqual(judgeTiles(good, await sample(other, { status })), { ok: true, checked: true }, String(status))
  assert.deepEqual(judgeTiles(good, null), { ok: true, checked: true }, 'no answer for the neighbour')
  assert.deepEqual(judgeTiles(await sample(other, { status: 403 }), good), { ok: false, problem: 'refused', httpStatus: 403 }, 'and the centre tile is judged first')
  const unhashed = await sample(mapTile(17, 1, 1), { sha256: null })
  assert.deepEqual(judgeTiles(unhashed, await sample(other, { status: 403 })), { ok: false, problem: 'refused', httpStatus: 403 }, 'a status needs no hash')
  assert.deepEqual(judgeTiles(good, { ...good, sha256: 'f'.repeat(64) }), { ok: true, checked: true }, 'two tiles of the same size are not the same picture')
})

// ── Whether a tile is one flat colour ─────────────────────────────────────────

const LAYOUTS: Array<[PngSpec['colourType'], Array<PngSpec['depth']>]> = [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]
const FILTERS: Array<[string, (y: number) => number]> = [['None', () => 0], ['Sub', () => 1], ['Up', () => 2], ['Average', () => 3], ['Paeth', () => 4], ['mixed', (y) => y % 5]]

test('isFlatPng sees a flat picture, and a single pixel that differs, in every colour type, bit depth and row filter', async () => {
  const width = 64
  const height = 40
  let different = 0
  for (const [colourType, depths] of LAYOUTS) {
    for (const depth of depths) {
      const bytesPerPixel = (CHANNELS[colourType]! * depth) >> 3
      const flat = flatRow(width, depth, flatPixel(colourType, depth))
      for (const [filterName, filter] of FILTERS) {
        const label = `colour type ${colourType}, ${depth} bit, ${filterName} filter`
        const picture = (row: (y: number) => Uint8Array) => encodePng({ width, height, depth, colourType, row, filter })
        assert.equal(await isFlatPng(picture(() => flat)), true, `${label}: flat`)
        for (const [where, x, y] of [['first', 0, 0], ['middle', 31, 17], ['last', width - 1, height - 1]] as const) {
          const changed = withPixelChanged(flat, x, depth, bytesPerPixel)
          assert.equal(await isFlatPng(picture((rowIndex) => (rowIndex === y ? changed : flat))), false, `${label}: the ${where} pixel differs`)
          different += 1
        }
      }
    }
  }
  assert.equal(different, 15 * 6 * 3, 'every layout, filter and position was tried')
})

test('readPngPixels returns exactly the pixels that were encoded, in every colour type, bit depth and row filter', async () => {
  const noise = bits(11)
  const byte = () => (noise() << 7) | (noise() << 6) | (noise() << 5) | (noise() << 4) | (noise() << 3) | (noise() << 2) | (noise() << 1) | noise()
  const width = 64
  const height = 24
  let pictures = 0
  for (const [colourType, depths] of LAYOUTS) {
    for (const depth of depths) {
      const rowBytes = (width * CHANNELS[colourType]! * depth) / 8
      for (const [filterName, filter] of FILTERS) {
        const label = `colour type ${colourType}, ${depth} bit, ${filterName} filter`
        const rows = Array.from({ length: height }, () => Uint8Array.from({ length: rowBytes }, byte))
        const decoded = await readPngPixels(encodePng({ width, height, depth, colourType, row: (y) => rows[y]!, filter }))
        assert.ok(decoded, label)
        assert.deepEqual([decoded.width, decoded.height, decoded.depth, decoded.colourType, decoded.rowBytes], [width, height, depth, colourType, rowBytes], label)
        assert.deepEqual(decoded.pixels, joinBytes(...rows), `${label}: every pixel is the one that was encoded`)
        pictures += 1
      }
    }
  }
  assert.equal(pictures, 15 * 6)
})

test('readPngPixels agrees with Pillow, a decoder that is not this one, on the real fixtures', async () => {
  // The expected SHA-256 of each picture's pixel bytes is Pillow 12.1.1's `Image.open(path).tobytes()`, with 4-bit and
  // 1-bit palette indices packed back into rows, the first pixel in the high bits as a PNG stores them.
  const fixtures: Array<[string, Uint8Array, string]> = [
    ['the CARTO key-required tile (4-bit palette, written by CARTO\'s encoder)', CARTO_TILE, '2eaf1667d10ba8f2f9b2f8c744cc35425adeb3cd402d2499a9c7d396cc7e0e23'],
    ['the Pillow-drawn notice (1-bit palette)', SMALL_NOTICE_TILE, 'f1f5c2d05cc6d4df2cf9bd476598808d782c766872b99f2421187cb4019a6d8f'],
    ['Pillow\'s flat retina tile (8-bit RGBA)', FLAT_RETINA_TILE, '5d70c41cfdec8b73a7466a18d8695ee59d12a11dd12213cb8f88aebc9341eb60'],
  ]
  for (const [what, bytes, hash] of fixtures) {
    const picture = await readPngPixels(bytes)
    assert.ok(picture, what)
    assert.equal(await sha256Hex(picture.pixels), hash, what)
  }
})

test('isFlatPng: packed pixels that alternate are not flat even when every byte is the same', async () => {
  for (const [colourType, depth, stripe] of [[0, 1, 0xaa], [0, 2, 0x1b], [0, 4, 0x12], [3, 1, 0xaa], [3, 2, 0x1b], [3, 4, 0x12]] as const) {
    const row = () => new Uint8Array((64 * depth) / 8).fill(stripe)
    assert.equal(await isFlatPng(encodePng({ width: 64, height: 8, depth, colourType, row })), false, `colour type ${colourType}, ${depth} bit: every byte is ${stripe.toString(16)}, which holds more than one colour`)
  }
})

test('the size floor sits between the sizes it was set from: a flat WebP under it, a WebP notice over it', () => {
  // Pillow 12.1.1: a flat 512 px lossy WebP is 542 bytes, and the CARTO notice as a lossy WebP is 1,384 (see NOTICE_MIN_BYTES).
  assert.ok(542 < NOTICE_MIN_BYTES && NOTICE_MIN_BYTES <= 1384, `the floor is ${NOTICE_MIN_BYTES}`)
})

test('isFlatPng: rows that are each flat but differ from one another are not flat, and map-sized tiles read in every filter', async () => {
  const stripe = (y: number) => flatRow(64, 8, [10, 20, 30, y % 2 === 0 ? 255 : 254])
  for (const [filterName, filter] of FILTERS) {
    assert.equal(await isFlatPng(encodePng({ width: 64, height: 40, depth: 8, colourType: 6, row: stripe, filter })), false, `${filterName}: stripes`)
    for (const size of [256, 512]) {
      const row = () => flatRow(size, 8, [170, 211, 223, 255])
      assert.equal(await isFlatPng(encodePng({ width: size, height: size, depth: 8, colourType: 6, row, filter })), true, `${filterName}: a flat ${size} px tile`)
    }
  }
})

test('isFlatPng on real encoders: Pillow\'s flat retina tile is flat, the CARTO notice and a Pillow-drawn notice are not', async () => {
  assert.equal(await isFlatPng(FLAT_RETINA_TILE), true)
  assert.equal(await isFlatPng(CARTO_TILE), false, 'a real 4-bit palette tile from CARTO\'s encoder')
  assert.equal(await isFlatPng(SMALL_NOTICE_TILE), false, 'a real 1-bit palette PNG, packed pixels')
})

test('isFlatPng does not guess: an interlaced, cut-short, oversize or odd PNG, and anything that is not a PNG, is null', async () => {
  const gray = (over: Partial<PngSpec> = {}): PngSpec => ({ width: 64, height: 40, depth: 8, colourType: 0, row: () => new Uint8Array(64).fill(200), ...over })
  const whole = encodePng(gray())
  assert.equal(await isFlatPng(whole), true, 'the control: this one reads')
  assert.equal(await isFlatPng(encodePng(gray({ interlace: 1 }))), null, 'interlaced')
  assert.equal(await isFlatPng(encodePng(gray({ compression: 1 }))), null, 'a compression method other than 0')
  assert.equal(await isFlatPng(whole.subarray(0, whole.length - 20)), null, 'cut short, so a chunk runs past the end')
  assert.equal(await isFlatPng(encodePng(gray({ noEnd: true }))), true, 'a missing end chunk does not matter when the pixels are all there')
  assert.equal(await isFlatPng(encodePng(gray({ split: 7 }))), true, 'pixel data in many IDAT chunks is joined')
  assert.equal(await isFlatPng(new TextEncoder().encode('<html>')), null, 'not a PNG')
  const wrongSignature = whole.slice()
  wrongSignature[1] = 0x51
  assert.equal(await isFlatPng(wrongSignature), null, 'chunks that would read, after a signature that is not a PNG\'s')
  assert.equal(await isFlatPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null, 'a signature and nothing else')
  assert.equal(await isFlatPng(encodePng(gray({ width: 2048, height: 2, row: () => new Uint8Array(2048) }))), null, 'wider than a map tile')
  assert.equal(await isFlatPng(encodePng(gray({ width: 30, row: () => new Uint8Array(4), depth: 1 }))), null, 'a packed row that ends in padding bits')
  assert.equal(await isFlatPng(encodePng(gray({ colourType: 2, depth: 4, row: () => new Uint8Array(96) }))), null, 'a bit depth the colour type does not allow')
  assert.equal(await isFlatPng(encodePng(gray({ filter: () => 5 }))), null, 'a row filter that does not exist')

  const taller = whole.slice()
  new DataView(taller.buffer).setUint32(20, 80)
  assert.equal(await isFlatPng(taller), null, 'the header says 80 rows and the pixel data holds 40')

  const idatFirst = joinBytes(PNG_SIGNATURE, chunk('IDAT', deflateSync(new Uint8Array(65 * 40))), whole.subarray(8, 33), chunk('IEND', new Uint8Array(0)))
  assert.equal(await isFlatPng(idatFirst), null, 'pixel data before the header')

  // A picture over the size the reader will inflate is refused before anything is inflated.
  const header = whole.slice(8, 33)
  const view = new DataView(header.buffer)
  view.setUint32(8, 1024)
  view.setUint32(12, 1024)
  header[16] = 16
  header[17] = 6
  const pixelBytes = 1024 * (1024 * 8 + 1)
  const huge = joinBytes(PNG_SIGNATURE, header, chunk('IDAT', deflateSync(new Uint8Array(pixelBytes))), chunk('IEND', new Uint8Array(0)))
  assert.equal(await isFlatPng(huge), null, `1024 by 1024 at 16 bits and four channels is ${pixelBytes} bytes inflated, more than the reader inflates, though the data is all there`)
})

test('isFlatPng reads no further than the picture holds, so a stream that inflates to more is not a way to use memory', async () => {
  const rows = 40
  const header = encodePng({ width: 64, height: rows, depth: 8, colourType: 0, row: () => new Uint8Array(64) }).subarray(8, 33)
  const flatRows = new Uint8Array(65 * rows)
  for (let y = 0; y < rows; y++) flatRows.fill(200, y * 65 + 1, (y + 1) * 65)
  const noise = Uint8Array.from({ length: 65 * rows * 2 }, (_, i) => (i * 31 + 7) & 0xff)
  const longer = joinBytes(PNG_SIGNATURE, header, chunk('IDAT', deflateSync(joinBytes(flatRows, noise))), chunk('IEND', new Uint8Array(0)))
  assert.equal(await isFlatPng(longer), true, 'the 40 rows the header names are flat; the 80 rows of noise after them are not looked at')

  // 64 MiB of zeros compresses to about 64 KiB. Count what the inflater produces before the reader is done with it.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream')!
  const RealDecompressionStream = globalThis.DecompressionStream
  let produced = 0
  class CountingDecompressionStream {
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
    constructor(format: CompressionFormat) {
      const real = new RealDecompressionStream(format)
      const counter = new TransformStream<Uint8Array, Uint8Array>({ transform(piece, controller) { produced += piece.byteLength; controller.enqueue(piece) } })
      this.writable = real.writable as WritableStream<Uint8Array>
      this.readable = (real.readable as ReadableStream<Uint8Array>).pipeThrough(counter)
    }
  }
  const bomb = joinBytes(PNG_SIGNATURE, header, chunk('IDAT', deflateSync(new Uint8Array(64 * 1024 * 1024))), chunk('IEND', new Uint8Array(0)))
  assert.ok(bomb.length < 256 * 1024, `the bomb is ${bomb.length} bytes on the wire`)
  Object.defineProperty(globalThis, 'DecompressionStream', { value: CountingDecompressionStream, configurable: true, writable: true })
  try {
    assert.equal(await isFlatPng(bomb), true, 'the first 40 rows are zeros, which are flat')
  } finally {
    Object.defineProperty(globalThis, 'DecompressionStream', original)
  }
  assert.ok(produced > 0, 'the counter was in the path')
  assert.ok(produced < 4 * 1024 * 1024, `the inflater was stopped after ${produced} bytes of the 64 MiB it holds`)
})

test('isFlatPng is null where the runtime cannot inflate, so the size floor is used', async () => {
  const whole = encodePng({ width: 64, height: 40, depth: 8, colourType: 0, row: () => new Uint8Array(64).fill(200) })
  const original = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream')!
  Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, configurable: true, writable: true })
  try {
    assert.equal(await isFlatPng(whole), null)
    const noInflate = await tileSampleFromBytes(whole, { status: 200, contentType: 'image/png' })
    assert.equal(noInflate.flat, null)
    assert.equal(noInflate.format, 'png')
  } finally {
    Object.defineProperty(globalThis, 'DecompressionStream', original)
  }
  assert.equal(await isFlatPng(whole), true, 'and it reads again once the runtime can')
})

test('a single unknown notice tile, with nothing to compare it with, passes: the limit of the check', async () => {
  assert.deepEqual(judgeTiles(await sample(NOTICE_TILE), null), { ok: true, checked: true })
  assert.deepEqual(judgeTiles(await sample(NOTICE_TILE), await sample(NOTICE_TILE, { status: 404 })), { ok: true, checked: true }, 'a neighbour that is missing is not a second picture')
})

test('a refused, limited or missing tile is a provider problem, by status', async () => {
  const body = mapTile(17, 1, 1)
  for (const status of [401, 403, 451]) assert.deepEqual(classifyTile(await sample(body, { status })), { ok: false, problem: 'refused', httpStatus: status }, String(status))
  assert.deepEqual(classifyTile(await sample(body, { status: 429 })), { ok: false, problem: 'rate-limited', httpStatus: 429 })
  for (const status of [404, 500, 503]) assert.deepEqual(classifyTile(await sample(body, { status })), { ok: false, problem: 'unavailable', httpStatus: status }, String(status))
  assert.deepEqual(classifyTile(null), { ok: false, problem: 'unavailable' }, 'no answer at all')
})

test('a 200 that is not an image is a provider problem, not a blank tile', async () => {
  const html = new TextEncoder().encode('<html><body>Sign in to the network</body></html>')
  assert.deepEqual(classifyTile(await sample(html, { contentType: 'text/html; charset=utf-8' })), { ok: false, problem: 'not-an-image' })
  const octet = await sample(mapTile(17, 1, 1), { contentType: 'application/octet-stream' })
  assert.deepEqual(classifyTile(octet), { ok: true, checked: true }, 'a PNG served with a generic type is still a PNG')
  assert.equal(imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg')
  assert.equal(imageFormat(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(imageFormat(html), null)
})

test('a tile that could not be hashed is let through as unchecked, and says so', async () => {
  const unhashed = await sample(mapTile(17, 1, 1), { sha256: null })
  assert.deepEqual(classifyTile(unhashed), { ok: true, checked: false })
  assert.deepEqual(judgeTiles(unhashed, unhashed), { ok: true, checked: false }, 'with no hash there is nothing to compare')
  assert.match(basemapStatusText({ state: 'ready', host: 'tiles.example.com', checked: false }).detail, /could not be checked/)
})

// ── What the map says ─────────────────────────────────────────────────────────

test('every state has words, they claim nothing was verified, and none names a provider', () => {
  const states: BasemapStatus[] = [
    { state: 'checking' }, { state: 'checking', host: 'tiles.example.com' }, { state: 'none' }, { state: 'unavailable' },
    { state: 'misconfigured', problem: 'bad-url' }, { state: 'unsupported' }, { state: 'needs-consent', host: 'tiles.example.com' },
    { state: 'declined', host: 'tiles.example.com' }, { state: 'ready', host: 'tiles.example.com', checked: true },
    ...(['key-required', 'refused', 'rate-limited', 'notice', 'not-an-image', 'unavailable', 'stalled'] as const).flatMap((problem) => [
      { state: 'provider-problem', host: 'tiles.example.com', problem, requiresKey: false } as BasemapStatus,
      { state: 'provider-problem', host: 'tiles.example.com', problem, httpStatus: 403, requiresKey: true } as BasemapStatus,
    ]),
  ]
  for (const status of states) {
    const { headline, detail } = basemapStatusText(status)
    assert.ok(headline.length > 0, JSON.stringify(status))
    assert.doesNotMatch(`${headline} ${detail}`, /verified|CARTO|OpenStreetMap|undefined|NaN/i, JSON.stringify(status))
  }
  assert.equal(basemapStatusText({ state: 'none' }).headline, 'No basemap configured')
  assert.match(basemapStatusText({ state: 'provider-problem', host: 'h', problem: 'refused', httpStatus: 403, requiresKey: false }).headline, /HTTP 403/)
  assert.doesNotMatch(basemapStatusText({ state: 'provider-problem', host: 'h', problem: 'refused', requiresKey: false }).headline, /\(HTTP/, 'no status, no figure')
})

test('the consent question says what the host sees, and a host that said nothing is not blamed for more than is known', () => {
  const { headline, detail } = basemapStatusText({ state: 'needs-consent', host: 'tiles.example.com' })
  assert.match(headline, /Show map tiles from tiles\.example\.com\?/)
  assert.match(detail, /where the map is looking/)
  assert.match(detail, /your IP address/, 'the host also sees who is asking')
  assert.match(detail, /this app's address/, 'and, as Referer, which app')
  const silent = basemapStatusText({ state: 'provider-problem', host: 'tiles.example.com', problem: 'unavailable', requiresKey: false })
  assert.match(silent.headline, /did not answer the check/)
  assert.match(silent.detail, /may not allow this page to read its tiles/, 'no answer and a refusal to be read look the same from the page')
  const busy = basemapStatusText({ state: 'provider-problem', host: 'tiles.example.com', problem: 'unavailable', httpStatus: 503, requiresKey: false })
  assert.match(busy.headline, /HTTP 503/)
  assert.doesNotMatch(busy.detail, /allow this page/, 'a host that answered 503 did answer')
  const stalled = basemapStatusText({ state: 'provider-problem', host: 'tiles.example.com', problem: 'stalled', requiresKey: false })
  assert.match(stalled.headline, /stopped loading/)
  assert.ok(stalled.detail.includes(`${TILE_ERROR_RUN} tiles in a row`), 'it says how many failed, from the constant the layer counts with')
  assert.doesNotMatch(stalled.detail, /No map shown/, 'tiles that loaded are still on the map')
})

// ── The basemap on a map, drawn into stand-ins for Leaflet and the document ─────────────────

class FakeElement {
  tag: string
  children: FakeElement[] = []
  attributes = new Map<string, string>()
  className = ''
  textContent = ''
  type = ''
  style = { cssText: '' }
  removed = false
  listeners = new Map<string, Array<(event: { stopPropagation(): void }) => void>>()
  constructor(tag: string) { this.tag = tag }
  appendChild(node: FakeElement): FakeElement { this.children.push(node); return node }
  replaceChildren(...nodes: FakeElement[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(type: string, listener: (event: { stopPropagation(): void }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  remove(): void { this.removed = true }
  /** A click on this element, bubbling to `above` the way the browser does: this element's listeners, then each ancestor's. */
  click(above: FakeElement[] = []): { stopped: boolean } {
    const event = { stopped: false, stopPropagation() { event.stopped = true } }
    for (const el of [this, ...above]) {
      if (el !== this && event.stopped) break
      for (const listener of el.listeners.get('click') ?? []) listener(event)
    }
    return event
  }
  all(): FakeElement[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

interface FakeLayer {
  url: string
  options: Record<string, unknown>
  added: boolean
  removed: boolean
  addTo(map: unknown): FakeLayer
  remove(): void
  /** Leaflet's Evented.on, for `tileload` and `tileerror`. */
  on(type: string, listener: () => void): FakeLayer
  /** What Leaflet does when a tile image loads or fails: tells every listener. */
  fire(type: string): void
}

function fakeLeaflet() {
  const layers: FakeLayer[] = []
  const shielded: FakeElement[] = []
  const controls: Array<{ options: unknown }> = []
  const L = {
    tileLayer: (url: string, options: Record<string, unknown>) => {
      const listeners = new Map<string, Array<() => void>>()
      const layer: FakeLayer = {
        url,
        options,
        added: false,
        removed: false,
        addTo() { layer.added = true; return layer },
        remove() { layer.removed = true },
        on(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); return layer },
        fire(type) { for (const listener of listeners.get(type) ?? []) listener() },
      }
      layers.push(layer)
      return layer
    },
    control: { attribution: (options: unknown) => ({ addTo(map: { attributionControl?: unknown }) { controls.push({ options }); map.attributionControl = {}; return this } }) },
    DomEvent: { disableClickPropagation: (el: FakeElement) => { shielded.push(el) } },
  }
  return { L, layers, shielded, controls }
}

function fakeMap(over: { zoom?: number; maxZoom?: number; attribution?: boolean } = {}) {
  const container = new FakeElement('div')
  return {
    container,
    options: { maxZoom: over.maxZoom },
    attributionControl: over.attribution === false ? undefined : {},
    getContainer: () => container,
    getZoom: () => over.zoom ?? 16,
    getCenter: () => ({ lat: 51.5074, lng: -0.1278 }),
    whenReady: (fn: () => void) => fn(),
  }
}

function fakeStorage(initial: Record<string, string> = {}, blocked = false): ConsentStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => { if (blocked) throw new Error('blocked'); return data.get(key) ?? null },
    setItem: (key, value) => { if (blocked) throw new Error('blocked'); data.set(key, value) },
  }
}

const THIRD_PARTY = { ...GOOD }
const HOST = 'tiles.example.com'

/** Attaches the basemap with the server answering `basemap`, and every tile request recorded. */
async function attach(basemap: unknown, over: {
  storage?: ConsentStorage | null
  own?: string[]
  tile?: (url: string) => Promise<TileSample | null>
  zoom?: number
  maxZoom?: number
  attribution?: boolean
  settings?: () => Promise<unknown>
  retina?: boolean
} = {}) {
  const leaflet = fakeLeaflet()
  const map = fakeMap({ zoom: over.zoom, maxZoom: over.maxZoom, attribution: over.attribution })
  const requested: string[] = []
  const settingsCalls: number[] = []
  const handle = attachBasemap({ L: leaflet.L as never, map: map as never }, {
    loadSettings: over.settings ?? (async () => { settingsCalls.push(1); return { generatedAt: 'x', basemap } }),
    fetchTile: async (url) => { requested.push(url); return over.tile ? over.tile(url) : sample(mapTile(1, requested.length, 1)) },
    storage: over.storage === undefined ? fakeStorage() : over.storage,
    ownOrigins: () => over.own ?? ['https://scan.example.test'],
    retina: () => over.retina ?? false,
    document: { createElement: (tag: string) => new FakeElement(tag) } as never,
  })
  const status = await handle.settled()
  return { handle, status, leaflet, map, requested, settingsCalls }
}

const box = (map: { container: FakeElement }) => map.container.children[0]!
const wordsIn = (el: FakeElement) => el.all().map((node) => node.textContent).filter(Boolean).join(' | ')
const buttonsIn = (el: FakeElement) => el.all().filter((node) => node.tag === 'button')

test('provider none, the default: pins on a blank canvas, a line that says so, and no tile request at all', async () => {
  const { status, requested, leaflet, map, settingsCalls } = await attach(noBasemap())
  assert.deepEqual(status, { state: 'none' })
  assert.deepEqual(requested, [], 'not one tile request, not even the check')
  assert.deepEqual(leaflet.layers, [], 'no tile layer is made')
  assert.equal(settingsCalls.length, 1, 'only the Scan server was asked, for its settings')
  assert.match(wordsIn(box(map)), /No basemap configured/)
  assert.deepEqual(buttonsIn(box(map)), [], 'nothing to press: there is nothing to turn on')
  assert.equal(box(map).attributes.get('role'), 'status', 'a screen reader hears the state')
  assert.equal(box(map).attributes.get('aria-live'), 'polite', 'and hears it when it changes')
  assert.doesNotMatch(box(map).style.cssText, /display:\s*none/, 'the box is on screen, not hidden')
  assert.deepEqual(leaflet.shielded, [box(map)], 'a press on the box does not pan the map')
})

test('a click on a button in the box stops at the box, even though the button redraws the box and is gone by then', async () => {
  const { map } = await attach(THIRD_PARTY)
  const [show, keep] = buttonsIn(box(map))
  const press = keep!.click([box(map), map.container])
  assert.equal(press.stopped, true, 'the click did not bubble past the box to the map container')
  assert.equal(box(map).children.includes(keep!), false, 'the button was replaced while it was handling the click: Leaflet could not find the box above it')
  assert.ok(show, 'and the box has its buttons again')
})

test('a server that sends no basemap block, a bad one, or nothing at all, also makes no tile request', async () => {
  const outcomes: Array<[unknown, BasemapStatus]> = [
    [undefined, { state: 'none' }],
    [{ kind: 'tms' }, { state: 'misconfigured', problem: 'unknown-kind' }],
    [{ kind: 'vector', urlTemplate: 'https://tiles.example.com/style.json' }, { state: 'unsupported' }],
  ]
  for (const [basemap, expected] of outcomes) {
    const { status, requested, leaflet, map } = await attach(basemap)
    assert.deepEqual(status, expected, JSON.stringify(basemap))
    assert.deepEqual(requested, [], JSON.stringify(basemap))
    assert.deepEqual(leaflet.layers, [], JSON.stringify(basemap))
    assert.deepEqual(buttonsIn(box(map)), [], 'no consent is asked for a map that has nothing to draw')
  }
  const refused = await attach(undefined, { settings: async () => { throw new Error('HTTP 401') } })
  assert.deepEqual(refused.status, { state: 'unavailable' })
  assert.match(wordsIn(box(refused.map)), /Basemap settings unavailable/)
  assert.deepEqual(refused.requested, [])
  const garbage = await attach(undefined, { settings: async () => 'not a report' })
  assert.deepEqual(garbage.status, { state: 'unavailable' })
  const bad = await attach({ urlTemplate: 'http://tiles.example.com/{z}/{x}/{y}.png', attribution: [CREDIT] })
  assert.deepEqual(bad.status, { state: 'misconfigured', problem: 'bad-url' })
  assert.match(wordsIn(box(bad.map)), /Basemap setting is not valid/)
})

test('a tile host that is not the app\'s own is asked about first, and nothing is requested until the answer is yes', async () => {
  const { status, requested, leaflet, map } = await attach(THIRD_PARTY)
  assert.deepEqual(status, { state: 'needs-consent', host: HOST })
  assert.deepEqual(requested, [], 'no tile request, no layer, before the person has said yes')
  assert.deepEqual(leaflet.layers, [])
  assert.match(wordsIn(box(map)), /Show map tiles from tiles\.example\.com\?/)
  assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Show map', 'Keep blank'])
})

test('yes saves the answer for the device, reads one tile and its neighbour, then draws the map', async () => {
  const storage = fakeStorage()
  const { handle, requested, leaflet, map } = await attach(THIRD_PARTY, { storage })
  buttonsIn(box(map))[0]!.click()
  const status = await handle.settled()
  assert.deepEqual(status, { state: 'ready', host: HOST, checked: true })
  assert.deepEqual(JSON.parse(storage.data.get(BASEMAP_CONSENT_KEY)!), { host: HOST, allowed: true })
  assert.deepEqual(requested, ['https://tiles.example.com/16/32744/21792.png', 'https://tiles.example.com/16/32745/21792.png'], 'the tile under the centre (London at zoom 16), and the one to its right')
  assert.equal(leaflet.layers.length, 1)
  assert.equal(leaflet.layers[0]!.added, true)
  assert.match(wordsIn(box(map)), /Map tiles from tiles\.example\.com/)
  assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Turn off'], 'a yes can be withdrawn')
})

test('once answered, the question is not asked again on this device, by either map', async () => {
  const storage = fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: HOST, allowed: true }) })
  const second = await attach(THIRD_PARTY, { storage })
  assert.equal(second.status.state, 'ready', 'a saved yes goes straight to the check')
  assert.equal(second.requested.length, 2)
  const declined = await attach(THIRD_PARTY, { storage: fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: HOST, allowed: false }) }) })
  assert.deepEqual(declined.status, { state: 'declined', host: HOST }, 'a saved no is kept too')
  assert.deepEqual(declined.requested, [])
  assert.deepEqual(declined.leaflet.layers, [])
  assert.deepEqual(buttonsIn(box(declined.map)).map((b) => b.textContent), ['Show map'], 'and can be changed')
})

test('the answer belongs to its host: a server that names another host asks again', async () => {
  const storage = fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: 'old.example.com', allowed: true }) })
  const { status, requested } = await attach(THIRD_PARTY, { storage })
  assert.deepEqual(status, { state: 'needs-consent', host: HOST })
  assert.deepEqual(requested, [])
})

test('no, and turning it off, leave the pins on a blank canvas and ask the host for nothing', async () => {
  const storage = fakeStorage()
  const first = await attach(THIRD_PARTY, { storage })
  buttonsIn(box(first.map))[1]!.click()
  assert.deepEqual(first.handle.status(), { state: 'declined', host: HOST })
  assert.deepEqual(JSON.parse(storage.data.get(BASEMAP_CONSENT_KEY)!), { host: HOST, allowed: false })
  assert.deepEqual(first.requested, [])

  const on = await attach(THIRD_PARTY, { storage: fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: HOST, allowed: true }) }) })
  const storageOn = fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: HOST, allowed: true }) })
  const withdraw = await attach(THIRD_PARTY, { storage: storageOn })
  assert.equal(on.leaflet.layers[0]!.removed, false)
  buttonsIn(box(withdraw.map)).find((b) => b.textContent === 'Turn off')!.click()
  assert.equal(withdraw.leaflet.layers[0]!.removed, true, 'the tiles come off the map')
  assert.deepEqual(JSON.parse(storageOn.data.get(BASEMAP_CONSENT_KEY)!), { host: HOST, allowed: false })
  assert.deepEqual(withdraw.handle.status(), { state: 'declined', host: HOST })
})

test('the app\'s own origin, the page\'s or the Scan server\'s, is not asked about', async () => {
  for (const own of [['https://tiles.example.com'], ['https://scan.example.test', 'https://tiles.example.com']]) {
    const { status, requested, map } = await attach(THIRD_PARTY, { own })
    assert.equal(status.state, 'ready', own.join(' '))
    assert.equal(requested.length, 2)
    assert.deepEqual(buttonsIn(box(map)), [], 'no consent, so nothing to withdraw')
  }
  const port = await attach({ ...GOOD, urlTemplate: 'https://tiles.example.com:8443/{z}/{x}/{y}.png' }, { own: ['https://tiles.example.com'] })
  assert.equal(port.status.state, 'needs-consent', 'another port is another origin')
})

test('with storage blocked the answer lasts for the page, and nothing throws', async () => {
  const { handle, map, requested } = await attach(THIRD_PARTY, { storage: fakeStorage({}, true) })
  assert.equal(handle.status().state, 'needs-consent')
  buttonsIn(box(map))[0]!.click()
  assert.equal((await handle.settled()).state, 'ready')
  assert.equal(requested.length, 2)
  assert.equal(readAnswer(null), null)
  writeAnswer(null, { host: HOST, allowed: true })
  assert.equal(readAnswer(fakeStorage({ [BASEMAP_CONSENT_KEY]: '{not json' })), null)
  assert.equal(readAnswer(fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: 3 }) })), null)
})

test('the tile layer carries the Referer policy, the credit as a link, and the provider\'s zoom limits', async () => {
  const { leaflet, map } = await attach({ ...GOOD, maxZoom: 17 }, { own: ['https://tiles.example.com'], maxZoom: 19 })
  const layer = leaflet.layers[0]!
  assert.equal(layer.url, GOOD.urlTemplate)
  assert.equal(layer.options.referrerPolicy, TILE_REFERRER_POLICY, 'tiles keep their Referer whatever the page sets')
  assert.match(layer.options.attribution as string, /<a href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors<\/a>/)
  assert.equal(layer.options.maxNativeZoom, 17)
  assert.equal(layer.options.maxZoom, 19, 'the map may zoom past the provider\'s limit; the layer enlarges its deepest tiles')
  assert.equal(layer.options.crossOrigin, 'anonymous', 'tile images are asked for in CORS mode, with cookies for the page\'s own origin only: left unset, the browser sends a third-party tile host its cookies with every tile')
  assert.equal(leaflet.controls.length, 0, 'a map with an attribution control uses it')
  assert.equal(map.attributionControl !== undefined, true)
})

test('a map made without an attribution control gets one, so no tile is drawn without its credit', async () => {
  const { leaflet, map, status } = await attach(GOOD, { own: ['https://tiles.example.com'], attribution: false })
  assert.equal(status.state, 'ready')
  assert.equal(leaflet.controls.length, 1)
  assert.deepEqual(leaflet.controls[0]!.options, { prefix: false })
  assert.notEqual(map.attributionControl, undefined)
})

test('the CARTO key-required tile is reported and never drawn', async () => {
  const { status, leaflet, map, requested } = await attach(
    { ...GOOD, urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}.png' },
    { own: ['https://tiles.example.com'], tile: () => sample(CARTO_TILE) },
  )
  assert.deepEqual(status, { state: 'provider-problem', host: HOST, problem: 'key-required', httpStatus: undefined, requiresKey: false })
  assert.deepEqual(leaflet.layers, [], 'no tile layer: the watermark is never shown as a map')
  assert.match(wordsIn(box(map)), /The tile provider wants an API key/)
  assert.equal(requested.length, 2)
  assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Check again'])
})

test('SYNTHETIC OSM-style notice, the same for every tile, is reported and never drawn', async () => {
  const { status, leaflet, map } = await attach(GOOD, { own: ['https://tiles.example.com'], tile: () => sample(NOTICE_TILE) })
  assert.equal(status.state, 'provider-problem')
  assert.equal((status as { problem: string }).problem, 'notice')
  assert.deepEqual(leaflet.layers, [])
  assert.match(wordsIn(box(map)), /sent a notice, not a map/)
})

test('a refusing host, a host that does not answer and a login page are all reported, and none is drawn', async () => {
  const cases: Array<[string, (url: string) => Promise<TileSample | null>, string, RegExp]> = [
    ['403', () => sample(mapTile(1, 1, 1), { status: 403 }), 'refused', /refused the request \(HTTP 403\)/],
    ['429', () => sample(mapTile(1, 1, 1), { status: 429 }), 'rate-limited', /limiting requests \(HTTP 429\)/],
    ['no answer', async () => null, 'unavailable', /did not answer the check/],
    ['a login page', () => sample(new TextEncoder().encode('<html>'), { contentType: 'text/html' }), 'not-an-image', /did not send a map image/],
    ['a limiter that answers the neighbour with 429', (url) => sample(mapTile(1, 1, url.endsWith('/32745/21792.png') ? 2 : 1), { status: url.endsWith('/32745/21792.png') ? 429 : 200 }), 'rate-limited', /limiting requests \(HTTP 429\)/],
    ['the key-required tile as the neighbour', (url) => sample(url.endsWith('/32745/21792.png') ? CARTO_TILE : mapTile(1, 1, 1)), 'key-required', /wants an API key/],
  ]
  for (const [what, tile, problem, words] of cases) {
    const { status, leaflet, map } = await attach(GOOD, { own: ['https://tiles.example.com'], tile })
    assert.equal((status as { problem?: string }).problem, problem, what)
    assert.deepEqual(leaflet.layers, [], what)
    assert.match(wordsIn(box(map)), words, what)
  }
})

test('"Check again" asks the Scan server for its settings again, and a fixed provider then draws', async () => {
  let broken = true
  const { handle, map, leaflet, settingsCalls } = await attach(GOOD, {
    own: ['https://tiles.example.com'],
    tile: (url) => (broken ? sample(CARTO_TILE) : sample(mapTile(1, [...url].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7), 1))),
  })
  assert.equal(handle.status().state, 'provider-problem')
  broken = false
  buttonsIn(box(map))[0]!.click()
  assert.equal((await handle.settled()).state, 'ready')
  assert.equal(leaflet.layers.length, 1)
  assert.equal(settingsCalls.length, 2, 'the settings are read again, so a restarted server is noticed')
})

test('the check reads the address the map will: the same {r}, at the map\'s zoom, never past the provider\'s', async () => {
  const retina = await attach({ ...GOOD, urlTemplate: 'https://tiles.example.com/{z}/{x}/{y}{r}.png' }, { own: ['https://tiles.example.com'], retina: true, zoom: 3.4 })
  assert.match(retina.requested[0]!, /^https:\/\/tiles\.example\.com\/3\/\d+\/\d+@2x\.png$/)
  const deep = await attach({ ...GOOD, maxZoom: 12 }, { own: ['https://tiles.example.com'], zoom: 18 })
  assert.match(deep.requested[0]!, /^https:\/\/tiles\.example\.com\/12\//)
  const world = await attach(GOOD, { own: ['https://tiles.example.com'], zoom: 0 })
  assert.match(world.requested[0]!, /\/1\//, 'zoom 0 has one tile, so a neighbour would be the same tile: the check starts at zoom 1')
})

test('the default fetches ask the right things: settings from the Scan server, a tile with the Referer policy and no cookie', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (String(input).includes('/capabilities')) return new Response(JSON.stringify({ basemap: noBasemap() }), { status: 200 })
    return new Response(new Uint8Array(mapTile(1, 1, 1)), { status: 200, headers: { 'content-type': 'image/png' } })
  }) as typeof fetch
  try {
    const leaflet = fakeLeaflet()
    const map = fakeMap()
    const handle = attachBasemap({ L: leaflet.L as never, map: map as never }, { document: { createElement: (tag: string) => new FakeElement(tag) } as never, storage: fakeStorage() })
    assert.deepEqual(await handle.settled(), { state: 'none' })
    assert.equal(calls[0]!.url, '/capabilities?versions=0', 'the route the server already has, in its cheap mode')
    assert.equal(calls[0]!.init.credentials, 'same-origin')
    assert.equal(calls[0]!.init.cache, 'no-cache', 'a retry after a fix is not answered from the 30 s the route allows')

    const tile = await fetchTileSample('https://tiles.example.com/3/4/5.png')
    assert.equal(tile?.status, 200)
    assert.equal(tile?.format, 'png')
    const init = calls[1]!.init
    assert.equal(init.referrerPolicy, TILE_REFERRER_POLICY, 'the check sends the Referer the map will')
    assert.equal(init.credentials, 'same-origin', 'the credentials of an anonymous image, which the layer uses: the page\'s cookies go to the page\'s own origin and to no other host')
    assert.equal(init.cache, undefined, 'the default cache mode: the provider\'s Cache-Control is honoured, never bypassed')
    assert.equal(init.headers, undefined, 'no Authorization, and no header that asks a cache to skip')
    assert.ok(init.signal, 'it times out')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the check does not read a body that cannot be a tile, and a host that fails to answer is no answer', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('huge')) return new Response('x', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024) } })
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  try {
    const huge = await fetchTileSample('https://tiles.example.com/huge.png')
    assert.equal(huge?.sha256, null)
    assert.equal(huge?.byteLength, 5 * 1024 * 1024)
    assert.equal(await fetchTileSample('https://tiles.example.com/1/2/3.png'), null, 'a network error or a CORS refusal')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('two answers in a row make one map, not two layers: a run that was overtaken draws nothing', async () => {
  const gates: Array<() => void> = []
  const gated = () => new Promise<void>((resolve) => { gates.push(resolve) })
  const { handle, map, leaflet } = await attach(THIRD_PARTY, {
    tile: async (url) => { await gated(); return sample(mapTile(1, [...url].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7), 1)) },
  })
  const show = buttonsIn(box(map))[0]!
  show.click()
  show.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  while (gates.length > 0) { gates.shift()!(); await new Promise((resolve) => setTimeout(resolve, 0)) }
  assert.equal((await handle.settled()).state, 'ready')
  assert.equal(leaflet.layers.filter((layer) => layer.added && !layer.removed).length, 1, 'one layer is on the map')
})

test('a tile answer that arrives after the map is gone draws nothing', async () => {
  let release!: () => void
  const slow = new Promise<void>((resolve) => { release = resolve })
  const leaflet = fakeLeaflet()
  const map = fakeMap()
  const handle = attachBasemap({ L: leaflet.L as never, map: map as never }, {
    loadSettings: async () => ({ basemap: GOOD }),
    fetchTile: async (url) => { await slow; return sample(mapTile(1, [...url].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7), 1)) },
    storage: fakeStorage(),
    ownOrigins: () => ['https://tiles.example.com'],
    retina: () => false,
    document: { createElement: (tag: string) => new FakeElement(tag) } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(handle.status().state, 'checking', 'the check is waiting on its tiles')
  handle.dispose()
  release()
  await handle.settled()
  assert.deepEqual(leaflet.layers, [], 'the tiles came back after dispose, and nothing was drawn')
})

test('disposing removes the box and the tiles, and a late answer draws nothing', async () => {
  let release!: () => void
  const slow = new Promise<void>((resolve) => { release = resolve })
  const leaflet = fakeLeaflet()
  const map = fakeMap()
  const handle = attachBasemap({ L: leaflet.L as never, map: map as never }, {
    loadSettings: async () => { await slow; return { basemap: GOOD } },
    fetchTile: async () => sample(mapTile(1, 1, 1)),
    storage: fakeStorage(),
    ownOrigins: () => ['https://tiles.example.com'],
    retina: () => false,
    document: { createElement: (tag: string) => new FakeElement(tag) } as never,
  })
  handle.dispose()
  release()
  await handle.settled()
  assert.equal(box(map).removed, true)
  assert.deepEqual(leaflet.layers, [], 'the answer arrived after the map was gone, and drew nothing')
})

test('a yes can be withdrawn while the host refuses, limits or does not answer, and withdrawing sends it nothing more', async () => {
  const problems: Array<[string, (url: string) => Promise<TileSample | null>]> = [
    ['403', () => sample(mapTile(1, 1, 1), { status: 403 })],
    ['429', () => sample(mapTile(1, 1, 1), { status: 429 })],
    ['no answer', async () => null],
    ['the key-required tile', () => sample(CARTO_TILE)],
  ]
  for (const [what, tile] of problems) {
    const storage = fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: HOST, allowed: true }) })
    const { handle, map, requested, leaflet } = await attach(THIRD_PARTY, { storage, tile })
    assert.equal(handle.status().state, 'provider-problem', what)
    assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Check again', 'Turn off'], `${what}: Check again alone would only send the host more requests`)
    const asked = requested.length
    buttonsIn(box(map)).find((b) => b.textContent === 'Turn off')!.click()
    assert.deepEqual(handle.status(), { state: 'declined', host: HOST }, what)
    assert.deepEqual(JSON.parse(storage.data.get(BASEMAP_CONSENT_KEY)!), { host: HOST, allowed: false }, what)
    assert.equal(requested.length, asked, `${what}: Turn off asks the host for nothing`)
    assert.deepEqual(leaflet.layers, [], what)
    const later = await attach(THIRD_PARTY, { storage, tile })
    assert.deepEqual(later.requested, [], `${what}: the next page load does not ask the host again`)
    assert.deepEqual(later.handle.status(), { state: 'declined', host: HOST }, what)
  }
})

test('a host that is the app\'s own has no yes to withdraw: a problem there offers Check again only', async () => {
  const { map } = await attach(GOOD, { own: ['https://tiles.example.com'], tile: () => sample(mapTile(1, 1, 1), { status: 403 }) })
  assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Check again'])
})

test('tiles that stop loading after the check are reported, and the next tile that loads clears the report', async () => {
  const { handle, map, leaflet } = await attach(GOOD, { own: ['https://tiles.example.com'] })
  const layer = leaflet.layers[0]!
  assert.deepEqual(handle.status(), { state: 'ready', host: HOST, checked: true })
  for (let i = 0; i < TILE_ERROR_RUN - 1; i++) layer.fire('tileerror')
  assert.equal(handle.status().state, 'ready', 'a tile or two that is missing is ordinary')
  layer.fire('tileload')
  for (let i = 0; i < TILE_ERROR_RUN - 1; i++) layer.fire('tileerror')
  assert.equal(handle.status().state, 'ready', 'a tile that loaded in between starts the count again')
  layer.fire('tileerror')
  assert.deepEqual(handle.status(), { state: 'provider-problem', host: HOST, problem: 'stalled', requiresKey: false })
  assert.match(wordsIn(box(map)), /Map tiles stopped loading/)
  assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Check again'], 'the app\'s own host: there is no yes to withdraw')
  assert.equal(layer.removed, false, 'the tiles that did load stay on the map')
  const drawn = box(map).children
  layer.fire('tileerror')
  layer.fire('tileerror')
  assert.equal(box(map).children, drawn, 'more failures do not redraw the box')
  layer.fire('tileload')
  assert.deepEqual(handle.status(), { state: 'ready', host: HOST, checked: true })
  assert.match(wordsIn(box(map)), /Map tiles from tiles\.example\.com/)
})

test('a stalled map can be checked again or turned off, and a layer that was replaced or turned off reports nothing', async () => {
  const storage = fakeStorage({ [BASEMAP_CONSENT_KEY]: JSON.stringify({ host: HOST, allowed: true }) })
  const { handle, map, leaflet, requested } = await attach(THIRD_PARTY, { storage })
  const first = leaflet.layers[0]!
  for (let i = 0; i < TILE_ERROR_RUN; i++) first.fire('tileerror')
  assert.equal(handle.status().state, 'provider-problem')
  assert.deepEqual(buttonsIn(box(map)).map((b) => b.textContent), ['Check again', 'Turn off'])

  buttonsIn(box(map)).find((b) => b.textContent === 'Check again')!.click()
  assert.equal((await handle.settled()).state, 'ready')
  assert.equal(first.removed, true, 'the old layer is taken off the map')
  assert.equal(leaflet.layers.length, 2, 'and a new one is made once the check passes')
  for (let i = 0; i < TILE_ERROR_RUN + 2; i++) first.fire('tileerror')
  assert.equal(handle.status().state, 'ready', 'failures from the layer that was replaced mean nothing')

  const second = leaflet.layers[1]!
  for (let i = 0; i < TILE_ERROR_RUN; i++) second.fire('tileerror')
  assert.equal(handle.status().state, 'provider-problem', 'the new layer is watched the same way')
  first.fire('tileload')
  assert.equal(handle.status().state, 'provider-problem', 'a tile that loads on the layer that was replaced does not clear the new layer\'s report')
  const asked = requested.length
  buttonsIn(box(map)).find((b) => b.textContent === 'Turn off')!.click()
  assert.equal(second.removed, true)
  assert.deepEqual(handle.status(), { state: 'declined', host: HOST })
  assert.equal(requested.length, asked, 'turning off asks the host for nothing')
  for (let i = 0; i < TILE_ERROR_RUN; i++) second.fire('tileerror')
  assert.deepEqual(handle.status(), { state: 'declined', host: HOST }, 'a layer that was turned off reports nothing')
})

test('a server that could not use its setting says so on the map, in the shape it really sends', async () => {
  const cases: Array<[string, string, RegExp]> = [
    ['not JSON', '{"urlTemplate": ', /The setting is not valid JSON/],
    ['an http address', JSON.stringify({ ...GOOD, urlTemplate: 'http://tiles.example.com/{z}/{x}/{y}.png' }), /must be https/],
    ['no credit link', JSON.stringify({ urlTemplate: GOOD.urlTemplate }), /no credit link/],
    ['a placeholder in the host', JSON.stringify({ ...GOOD, urlTemplate: 'https://{z}.tiles.example.com/{x}/{y}.png' }), /after the host/],
  ]
  for (const [what, value, words] of cases) {
    // What GET /capabilities sends is the shared module's answer for the environment, as JSON.
    const served = JSON.parse(JSON.stringify(basemapFromEnv(env(value)))) as { kind: string; problem?: string }
    assert.equal(served.kind, 'none', what)
    assert.ok(served.problem, `${what}: the server says why`)
    const { status, requested, map, leaflet } = await attach(served)
    assert.equal(status.state, 'misconfigured', what)
    assert.match(wordsIn(box(map)), /Basemap setting is not valid/, what)
    assert.match(wordsIn(box(map)), words, what)
    assert.deepEqual(requested, [], what)
    assert.deepEqual(leaflet.layers, [], what)
  }
})

test('a settings answer that arrives after a newer run has finished changes nothing', async () => {
  let calls = 0
  const release: Array<() => void> = []
  const { handle, map, leaflet } = await attach(THIRD_PARTY, {
    settings: () => {
      calls += 1
      return calls === 2 ? new Promise((resolve) => release.push(() => resolve({ basemap: THIRD_PARTY }))) : Promise.resolve({ basemap: THIRD_PARTY })
    },
  })
  const showMap = () => buttonsIn(box(map)).find((b) => b.textContent === 'Show map')!
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
  showMap().click()
  await settle()
  assert.equal(handle.status().state, 'needs-consent', 'run 2 is waiting for its settings, and the question is still on the map')
  showMap().click()
  await settle()
  assert.equal(handle.status().state, 'ready', 'run 3 asked again and was answered at once')
  assert.equal(leaflet.layers.filter((layer) => layer.added && !layer.removed).length, 1)
  release[0]!()
  await settle()
  assert.equal(handle.status().state, 'ready', 'the overtaken run did not put "Checking" back over a finished map')
  assert.match(wordsIn(box(map)), /Map tiles from tiles\.example\.com/)
  assert.equal(leaflet.layers.filter((layer) => layer.added && !layer.removed).length, 1)
})

test('the defaults read the page the way a browser supplies it: its origin and the Scan server\'s, its pixel ratio, its localStorage and its document', async () => {
  const names = ['location', 'devicePixelRatio', 'localStorage', 'Capacitor', 'document']
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const storage = fakeStorage({ 'companion-scan-server': 'https://scan.example.test' })
  const supply = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  supply('location', { origin: 'https://app.example.test' })
  supply('devicePixelRatio', 2)
  supply('localStorage', storage)
  supply('Capacitor', { isNativePlatform: () => true })
  supply('document', { createElement: (tag: string) => new FakeElement(tag) })
  try {
    const requested: string[] = []
    const fetchTile = async (url: string) => { requested.push(url); return sample(mapTile(1, requested.length, 1)) }

    // A tile host on the Scan server's origin, which the shell saved on the device, is the app's own: no question, and a retina screen gets "@2x".
    const own = fakeLeaflet()
    const ownMap = fakeMap()
    const ownHandle = attachBasemap({ L: own.L as never, map: ownMap as never }, {
      loadSettings: async () => ({ basemap: { ...GOOD, urlTemplate: 'https://scan.example.test/tiles/{z}/{x}/{y}{r}.png' } }),
      fetchTile,
    })
    assert.equal((await ownHandle.settled()).state, 'ready', 'the Scan server named in the page\'s localStorage is the app\'s own origin')
    assert.match(requested[0]!, /^https:\/\/scan\.example\.test\/tiles\/16\/\d+\/\d+@2x\.png$/, 'a pixel ratio over 1 is a retina screen')
    assert.equal(own.layers.length, 1)

    // A tile host on the page's own origin is the app's own as well.
    const page = fakeLeaflet()
    const pageHandle = attachBasemap({ L: page.L as never, map: fakeMap() as never }, {
      loadSettings: async () => ({ basemap: { ...GOOD, urlTemplate: 'https://app.example.test/tiles/{z}/{x}/{y}.png' } }),
      fetchTile,
    })
    assert.equal((await pageHandle.settled()).state, 'ready', 'the page\'s own origin is the app\'s own')

    supply('devicePixelRatio', 1)
    const plain = fakeLeaflet()
    const plainMap = fakeMap()
    const before = requested.length
    const plainHandle = attachBasemap({ L: plain.L as never, map: plainMap as never }, {
      loadSettings: async () => ({ basemap: { ...GOOD, urlTemplate: 'https://scan.example.test/tiles/{z}/{x}/{y}{r}.png' } }),
      fetchTile,
    })
    assert.equal((await plainHandle.settled()).state, 'ready')
    assert.match(requested[before]!, /\/\d+\.png$/, 'a pixel ratio of 1 is not a retina screen: no suffix')

    // Any other host is asked about, and the answer is saved in the page's localStorage.
    const other = fakeLeaflet()
    const otherMap = fakeMap()
    const otherHandle = attachBasemap({ L: other.L as never, map: otherMap as never }, { loadSettings: async () => ({ basemap: GOOD }), fetchTile })
    assert.equal((await otherHandle.settled()).state, 'needs-consent')
    buttonsIn(box(otherMap))[0]!.click()
    assert.equal((await otherHandle.settled()).state, 'ready')
    assert.deepEqual(JSON.parse(storage.data.get(BASEMAP_CONSENT_KEY)!), { host: HOST, allowed: true }, 'saved where the next page load reads it')
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as unknown as Record<string, unknown>)[name]
    }
  }
})

// ── Source shape: the wiring in the hubs and the files around them ─────────────────────────

test('source shape: both maps draw their tiles through the basemap layer, and neither names a layer of its own', () => {
  const main = read('src/main.ts')
  const geomap = read('src/viewer/geomap.ts')
  for (const [file, text] of [['src/main.ts', main], ['src/viewer/geomap.ts', geomap]] as const) {
    assert.match(text, /attachBasemap\(/, `${file} calls attachBasemap`)
    assert.match(text, /geo\/basemap-layer/, `${file} loads it from src/geo/basemap-layer.ts`)
    assert.doesNotMatch(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), /\.tileLayer\(/, `${file} makes no tile layer of its own`)
  }
  const start = geomap.match(/private async _startBasemap\(\): Promise<void> \{\s*(if \([^\n]*\) return)/)?.[1] ?? ''
  assert.match(start, /!this\._open/, 'the editor map starts its basemap only once its drawer is open: the first line of _startBasemap says so')
  assert.match(geomap, /open\(\): void \{[\s\S]*?void this\._startBasemap\(\)/, 'and opening the drawer starts it')
  assert.doesNotMatch(geomap, /OpenStreetMap tile layer \(no API key required\)/, 'the stale line about the tile layer is gone')
  assert.doesNotMatch(geomap, /basemaps\.|cartocdn/i, 'and no host is named in the file')
  assert.match(geomap, /#geomap-drawer \.leaflet-container \{ background: #0a222e; \}/, 'the pins sit on the drawer\'s own colour, not Leaflet\'s light grey, when no tile is drawn')
  assert.doesNotMatch(main, /dark tile layer from CartoDB/)
})

test('source shape: only the basemap layer makes a tile layer, across the whole browser source', () => {
  const owners: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (/\.ts$/.test(entry.name) && /\bL\.tileLayer\(|\.tileLayer\(/.test(read(path).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) owners.push(path)
    }
  }
  walk('src')
  assert.deepEqual(owners, ['src/geo/basemap-layer.ts'])
})

test('source shape: GET /capabilities carries the basemap the environment names, and the server says when it cannot use the value', () => {
  const server = read('server/main.ts')
  assert.match(server, /import \{[^}]*basemapFromEnv[^}]*\} from '\.\.\/src\/geo\/tile-source\.ts'/)
  assert.match(server, /const BASEMAP = basemapFromEnv\(\(name\) => Deno\.env\.get\(name\)\)/)
  assert.match(server, /app\.get\('\/capabilities'[\s\S]*?return c\.json\(\{ \.\.\.report, basemap: BASEMAP \}\)/)
  assert.match(server, /if \(BASEMAP\.problem\) \{\s*console\.warn\(/)
  assert.doesNotMatch(server.match(/if \(BASEMAP\.problem\) \{[\s\S]*?\n\}/)![0], /Deno\.env|\$\{BASEMAP\.urlTemplate/, 'the warning never prints the value')
})

test('source shape: the pages can reach the route, and the service worker does not keep a copy of it', () => {
  assert.match(read('vite.config.ts'), /PROXIED_ROUTES = \[[\s\S]*?'\/capabilities'[\s\S]*?\]/, 'the dev proxy forwards /capabilities to the Deno server')
  assert.match(read('public/sw.js'), /const API_PREFIXES = \[[\s\S]*?'\/capabilities'[\s\S]*?\]/, 'the service worker leaves /capabilities to the network: a stale copy would outlive a change of provider')
})

test('the service worker never keeps a third-party tile or the capability report, and keeps a same-origin tile like any same-origin file', async () => {
  const handlers: Record<string, (event: { request: Request; respondWith(answer: Promise<Response>): void }) => void> = {}
  const stored: string[] = []
  const context = vm.createContext({
    self: { location: { origin: 'https://scan.example.test' }, addEventListener: (type: string, listener: (typeof handlers)[string]) => { handlers[type] = listener } },
    caches: { open: async () => ({ match: async () => undefined, put: async (request: Request) => { stored.push(request.url) } }) },
    fetch: async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } }),
    Request,
    Response,
    URL,
    Headers,
  })
  vm.runInContext(read('public/sw.js'), context, { filename: 'public/sw.js' })
  async function answered(url: string): Promise<boolean> {
    let answer: Promise<Response> | null = null
    handlers.fetch!({ request: new Request(url), respondWith: (response) => { answer = response } })
    if (answer) await answer
    await new Promise((resolve) => setTimeout(resolve, 0))
    return answer !== null
  }
  assert.equal(await answered('https://tiles.example.com/16/32744/21792.png'), false, 'a third-party tile goes straight to the network')
  assert.deepEqual(stored, [], 'and nothing of it is stored')
  assert.equal(await answered('https://scan.example.test/capabilities?versions=0'), false, 'the capability report is never answered from the cache: a stale one would outlive a change of provider')
  assert.deepEqual(stored, [])
  // The limit that tile-source.ts and .env.example name: a tile host on the page's own origin is an ordinary same-origin GET.
  assert.equal(await answered('https://scan.example.test/tiles/16/32744/21792.png'), true)
  assert.deepEqual(stored, ['https://scan.example.test/tiles/16/32744/21792.png'], 'it is kept, as any same-origin file is, with no bound on how many')
  const text = read('src/geo/tile-source.ts') + read('.env.example')
  assert.match(text, /no limit on how many/, 'and both documents say so')
})

test('the tile credit on the scanner drawer reads over any basemap: 4.5 to 1 or better against a white tile, at 11 px or more', () => {
  const css = read('index.html')
  const rule = (selector: string): Record<string, string> => {
    const start = css.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `${selector} has a rule in index.html`)
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
    return Object.fromEntries(body.split(';').map((declaration) => declaration.trim()).filter(Boolean).map((declaration) => {
      const colon = declaration.indexOf(':')
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).replace(/!important/, '').trim()]
    }))
  }
  const colour = (value: string): number[] => {
    const rgba = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
    if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])]
    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
    assert.ok(hex, `a colour this test can read: ${value}`)
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit) : hex[1]!.match(/../g)!
    return [...digits.map((pair) => parseInt(pair, 16)), 1]
  }
  const over = (top: number[], below: number[]): number[] => [0, 1, 2].map((i) => top[3]! * top[i]! + (1 - top[3]!) * below[i]!)
  const luminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.slice(0, 3).map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const contrast = (a: number[], b: number[]): number => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high! + 0.05) / (low! + 0.05)
  }
  const panel = rule('.leaflet-control-attribution')
  const link = rule('.leaflet-control-attribution a')
  const white = [255, 255, 255, 1]
  const lightLand = [242, 239, 233, 1] // a pale street map's land colour
  for (const [what, backdrop] of [['a white tile', white], ['a pale street map', lightLand]] as const) {
    const behind = over(colour(panel.background!), backdrop)
    for (const [which, text] of [['the credit text', colour(panel.color!)], ['the credit link', colour(link.color!)]] as const) {
      const ratio = contrast(over(text, behind), behind)
      assert.ok(ratio >= 4.5, `${which} over ${what} is ${ratio.toFixed(2)} to 1`)
    }
  }
  assert.ok(Number.parseFloat(panel['font-size']!) >= 11, `the credit is ${panel['font-size']}`)
  assert.match(link['text-decoration']!, /underline/, 'a link looks like one')
})

test('source shape: the storage key is declared once, with the others', () => {
  assert.equal(BASEMAP_CONSENT_KEY, 'companion-scan-basemap-consent')
  const sources = ['src/geo/basemap-layer.ts', 'src/geo/tile-source.ts', 'src/main.ts', 'src/viewer/geomap.ts']
  for (const file of sources) assert.doesNotMatch(read(file), /'companion-scan-basemap-consent'/, `${file} imports the key from storage-keys.ts`)
})

test('the setting the docs show is one the code accepts, in .env.example and in the deploy example', () => {
  for (const [file, quoted] of [['.env.example', false], ['deploy/cscan.env.example', true]] as const) {
    const line = read(file).split('\n').find((candidate) => candidate.startsWith(`#${BASEMAP_ENV_VAR}=`))
    assert.ok(line, `${file} documents ${BASEMAP_ENV_VAR}`)
    const value = line.slice(`#${BASEMAP_ENV_VAR}=`.length)
    assert.equal(value.startsWith("'"), quoted, `${file}: the deploy example quotes the value for systemd and a shell`)
    const config: BasemapConfig = basemapFromEnv(env(value))
    assert.equal(config.kind, 'raster', `${file}: the example is a usable raster setting`)
    assert.equal(config.problem, undefined)
    assert.ok(config.attribution.length > 0)
  }
  const example = read('.env.example')
  assert.match(example, /Unset, which is the default: no basemap/)
  assert.match(example, /ask no tile host for anything/)
})

test('source shape: the shells name themselves to a tile host, and the privacy notes name the tile host', () => {
  assert.match(read('mobile/capacitor.config.ts'), /appendUserAgent: 'CompanionScan'/)
  const notDone = read('mobile/README.md').split('## Not done')[1] ?? ''
  assert.match(notDone, /map tile host \(`MAP_TILE_SOURCE`\)[^.]*once the person allows it on the device/)
  assert.match(notDone, /the privacy policy/, 'the line that lists the privacy work is still there')
})
