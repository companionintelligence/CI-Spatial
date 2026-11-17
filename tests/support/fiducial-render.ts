/**
 * Synthetic camera frames for the printed-fiducial tests (WP-14a).
 *
 * Draws a planar tag (or any planar artwork) at a KNOWN pose under KNOWN intrinsics into a luma
 * frame, with optional blur, exposure change, uneven lighting and sensor noise, all seeded so a
 * test run is byte-identical every time. The pose tests then compare what the detector and the
 * pose solver recover with what was drawn, which is the only way to know their error without a
 * phone.
 *
 * ## What it models, and what it does not
 *
 * Models: a pinhole camera, perspective-correct drawing (each pixel is `supersample` x
 * `supersample` ray samples intersected with the tag plane, so edges carry true area coverage),
 * Gaussian blur, a gain / offset / gamma exposure curve, a linear lighting gradient, Gaussian
 * pixel noise, 8-bit quantisation.
 *
 * Does NOT model: lens distortion, rolling shutter, motion blur, demosaicing and JPEG artefacts,
 * auto-exposure that changes between frames, specular glare, a printer's dot gain. The accuracy
 * the tests measure here is therefore a best case for the detector and the pose solver; what a
 * phone does is DX8's question, and nothing in these tests answers it.
 *
 * Conventions are those of `src/ar/fiducial/types.ts`: pixel (i, j) covers [i, i+1] x [j, j+1],
 * the tag frame is x right / y up / z toward the viewer, and the camera frame is OpenCV-style
 * (x right, y down, z forward).
 */
import { mulberry32 } from '../../src/shared/test-homes.ts'
import type { CameraIntrinsics, Dictionary, FiducialImage, Mat3 } from '../../src/ar/fiducial/types.ts'
import type { Vec3 } from '../../src/world/types.ts'

/** A rigid transform tag -> camera. `rotation` is row-major 3x3. */
export interface RigidPose {
  rotation: Mat3
  translation: Vec3
}

/**
 * What is printed on a plane, in the plane's own metres: a function from a point to a
 * reflectance in 0..255, or a negative number for "not on the sheet". `halfExtent` bounds the
 * sheet: every point with |x| or |y| above it is off the sheet.
 */
export interface PlanarArtwork {
  halfExtent: number
  shade(x: number, y: number): number
}

export interface PlacedArtwork {
  artwork: PlanarArtwork
  pose: RigidPose
}

export interface ExposureCurve {
  /** Multiplies the level (1 = unchanged, 0.4 = under-exposed). */
  gain?: number
  /** Added after the gain, in levels. */
  offset?: number
  /** Applied last on the 0..1 level; above 1 darkens the midtones. */
  gamma?: number
}

export interface RenderOptions {
  width: number
  height: number
  intrinsics: CameraIntrinsics
  items: readonly PlacedArtwork[]
  /** A flat background level, or a per-pixel float image (width * height, 0..255). Default 120. */
  background?: number | Float32Array
  /** Gaussian blur sigma in pixels, applied after drawing. Default 0. */
  blurSigma?: number
  exposure?: ExposureCurve
  /** Linear lighting gradient: the level is multiplied by 1 + gx * (x / width - 0.5) + gy * (y / height - 0.5). */
  shading?: { gx: number; gy: number }
  /**
   * Any lighting at all, as a multiplier at an image position (a pixel's centre, in pixels): a shadow with
   * an edge, a spot, a gradient across the tag and not across the frame. Applied with `shading`, before the
   * exposure curve and the noise, so the noise is the sensor's and is not scaled by the light.
   */
  light?: (x: number, y: number) => number
  /** Gaussian noise sigma in 8-bit levels. Default 0. */
  noiseSigma?: number
  /** Seed for the noise. Default 1. */
  seed?: number
  /** Ray samples per pixel along each axis. Default 4. */
  supersample?: number
  /** 1 = a luma plane, 4 = RGBA (grey, alpha 255). Default 1. */
  channels?: 1 | 4
}

// ---------------------------------------------------------------------------------------------
// Small rotation helpers. Row-major 3x3 arrays; kept local because the tests must not share code
// with the module they are checking.
// ---------------------------------------------------------------------------------------------

export function mat3Mul(a: Mat3, b: Mat3): number[] {
  const out = new Array<number>(9).fill(0)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0
      for (let k = 0; k < 3; k++) s += a[r * 3 + k]! * b[k * 3 + c]!
      out[r * 3 + c] = s
    }
  }
  return out
}

export function mat3Apply(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z,
    y: m[3]! * v.x + m[4]! * v.y + m[5]! * v.z,
    z: m[6]! * v.x + m[7]! * v.y + m[8]! * v.z,
  }
}

export function mat3Transpose(m: Mat3): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]
}

export function rotX(rad: number): number[] {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}

export function rotY(rad: number): number[] {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}

export function rotZ(rad: number): number[] {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

const DEG = Math.PI / 180

/**
 * The rotation of a tag that faces the camera squarely and upright: tag x is camera +x (right),
 * tag y (up) is camera -y (up the image), and the tag's outward normal points back at the camera
 * (camera -z).
 */
export const FACING: readonly number[] = [1, 0, 0, 0, -1, 0, 0, 0, -1]

/**
 * A tag pose from how it is held: `spinDeg` turns it in its own plane, `yawDeg` about its own
 * vertical axis (turning it left or right), `pitchDeg` about its own horizontal axis, applied in
 * that order to a tag facing the camera. `centre` is the tag centre in the camera frame, metres.
 */
export function tagPose(centre: Vec3, spinDeg = 0, yawDeg = 0, pitchDeg = 0): RigidPose {
  const own = mat3Mul(rotZ(spinDeg * DEG), mat3Mul(rotY(yawDeg * DEG), rotX(pitchDeg * DEG)))
  return { rotation: mat3Mul(FACING, own), translation: centre }
}

/** The angle in degrees of the rotation taking `a` to `b`. */
export function rotationAngleDeg(a: Mat3, b: Mat3): number {
  const rel = mat3Mul(mat3Transpose(a), b)
  const tr = rel[0]! + rel[4]! + rel[8]!
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG
}

// ---------------------------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------------------------

export interface TagArtworkOptions {
  /** White margin around the black square, in cells. Default 1. */
  quietCells?: number
  /** Reflectance of the black ink and of the paper, 0..255. Defaults 25 and 225. */
  ink?: number
  paper?: number
}

/**
 * The printed tag for a code: a `(bits + 2)`-cell black square (outer ring black, data cells as
 * given, 1 = black) of edge `sizeM`, centred on the plane origin, inside a white quiet zone.
 */
export function tagArtwork(pattern: ArrayLike<number>, bits: number, sizeM: number, options: TagArtworkOptions = {}): PlanarArtwork {
  const quiet = options.quietCells ?? 1
  const ink = options.ink ?? 25
  const paper = options.paper ?? 225
  const cells = bits + 2
  const cell = sizeM / cells
  const half = sizeM / 2
  const extent = half + quiet * cell
  return {
    halfExtent: extent,
    shade(x, y) {
      const ax = Math.abs(x)
      const ay = Math.abs(y)
      if (ax > extent || ay > extent) return -1
      if (ax > half || ay > half) return paper
      let col = Math.floor((x + half) / cell)
      let row = Math.floor((half - y) / cell)
      if (col < 0) col = 0
      if (col >= cells) col = cells - 1
      if (row < 0) row = 0
      if (row >= cells) row = cells - 1
      if (row === 0 || col === 0 || row === cells - 1 || col === cells - 1) return ink
      return pattern[(row - 1) * bits + (col - 1)] ? ink : paper
    },
  }
}

/**
 * An artwork seen through a warp of its plane: `shade(x, y)` reads `base` where `warp(x, y)` says. A sheet
 * that curls or bows is one (its edges are no longer straight lines in the plane's own coordinates). `halfExtent`
 * is `base`'s plus `slack`, for a warp that pulls points from beyond it.
 */
export function warpArtwork(base: PlanarArtwork, warp: (x: number, y: number) => [number, number], slack = 0): PlanarArtwork {
  return {
    halfExtent: base.halfExtent + slack,
    shade(x, y) {
      const [u, v] = warp(x, y)
      return base.shade(u, v)
    },
  }
}

/**
 * A patch of one flat level on the plane and nothing elsewhere: a later item in `renderFrame`'s list, at the
 * same pose as the tag, hides that part of it (tape, a card, a finger lying on the sheet). Corners in the
 * plane's metres.
 */
export function patchArtwork(rect: { x0: number; y0: number; x1: number; y1: number }, level: number): PlanarArtwork {
  return {
    halfExtent: Math.max(Math.abs(rect.x0), Math.abs(rect.x1), Math.abs(rect.y0), Math.abs(rect.y1)),
    shade: (x, y) => (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1 ? level : -1),
  }
}

/** The printed artwork for a dictionary id. */
export function dictionaryTagArtwork(dictionary: Dictionary, id: number, sizeM: number, options: TagArtworkOptions = {}): PlanarArtwork {
  return tagArtwork(dictionary.pattern(id), dictionary.bits, sizeM, options)
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** A pair of independent N(0, 1) draws per call, from a seeded uniform source. */
function gaussianSource(seed: number): () => number {
  const rand = mulberry32(seed)
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    let u = 0
    while (u === 0) u = rand()
    const v = rand()
    const mag = Math.sqrt(-2 * Math.log(u))
    spare = mag * Math.sin(2 * Math.PI * v)
    return mag * Math.cos(2 * Math.PI * v)
  }
}

const NOISE_TABLE_BITS = 20
let noiseTable: Float32Array | null = null

/**
 * One million N(0, 1) draws from a fixed seed, built once per process. A frame walks it with a
 * start and an odd stride taken from its own seed, so every pixel of a frame reads a different
 * entry, different seeds read different entries, and a frame costs a table lookup per pixel
 * instead of a logarithm.
 */
function normalTable(): Float32Array {
  if (!noiseTable) {
    noiseTable = new Float32Array(1 << NOISE_TABLE_BITS)
    const next = gaussianSource(0x5eed)
    for (let i = 0; i < noiseTable.length; i++) noiseTable[i] = next()
  }
  return noiseTable
}

function invert3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const inv = 1 / det
  return [
    A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
  ]
}

/** Image -> plane homography for the plane z = 0 of `pose`, under `K`. */
function imageToPlane(K: CameraIntrinsics, pose: RigidPose): number[] {
  const r = pose.rotation
  const t = pose.translation
  // K * [r1 r2 t]
  const cols = [
    [r[0]!, r[3]!, r[6]!],
    [r[1]!, r[4]!, r[7]!],
    [t.x, t.y, t.z],
  ]
  const h = new Array<number>(9)
  for (let c = 0; c < 3; c++) {
    const [x, y, z] = cols[c]!
    h[0 * 3 + c] = K.fx * x + K.cx * z!
    h[1 * 3 + c] = K.fy * y! + K.cy * z!
    h[2 * 3 + c] = z!
  }
  return invert3(h)
}

/** Draw one artwork; returns the pixel rectangle it touched as [x0, y0, x1, y1) or null if it is off the frame. */
function drawItem(buf: Float32Array, width: number, height: number, K: CameraIntrinsics, item: PlacedArtwork, S: number): [number, number, number, number] | null {
  const m = imageToPlane(K, item.pose)
  const e = item.artwork.halfExtent
  const r = item.pose.rotation
  const t = item.pose.translation
  // Bounding box of the sheet's four corners in the image.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [sx, sy] of [[-e, -e], [e, -e], [e, e], [-e, e]] as const) {
    const px = r[0]! * sx + r[1]! * sy + t.x
    const py = r[3]! * sx + r[4]! * sy + t.y
    const pz = r[6]! * sx + r[7]! * sy + t.z
    if (pz <= 1e-6) return null
    const u = K.fx * px / pz + K.cx
    const v = K.fy * py / pz + K.cy
    if (u < minX) minX = u
    if (u > maxX) maxX = u
    if (v < minY) minY = v
    if (v > maxY) maxY = v
  }
  const x0 = Math.max(0, Math.floor(minX) - 1)
  const x1 = Math.min(width - 1, Math.ceil(maxX) + 1)
  const y0 = Math.max(0, Math.floor(minY) - 1)
  const y1 = Math.min(height - 1, Math.ceil(maxY) + 1)
  const inv = 1 / (S * S)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const base = buf[y * width + x]!
      let acc = 0
      for (let sy = 0; sy < S; sy++) {
        const v = y + (sy + 0.5) / S
        for (let sx = 0; sx < S; sx++) {
          const u = x + (sx + 0.5) / S
          const w = m[6]! * u + m[7]! * v + m[8]!
          let val = -1
          if (w !== 0) {
            val = item.artwork.shade((m[0]! * u + m[1]! * v + m[2]!) / w, (m[3]! * u + m[4]! * v + m[5]!) / w)
          }
          acc += val >= 0 ? val : base
        }
      }
      buf[y * width + x] = acc * inv
    }
  }
  return x1 < x0 || y1 < y0 ? null : [x0, y0, x1 + 1, y1 + 1]
}

/** Blur the rectangle [x0, x1) x [y0, y1) of `buf` in place, reading beyond it only as far as the kernel reaches. */
function gaussianBlur(buf: Float32Array, width: number, height: number, sigma: number, x0 = 0, y0 = 0, x1 = width, y1 = height): void {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum
  const tmp = new Float32Array(buf.length)
  // The horizontal pass must cover the rows the vertical pass will read.
  const ya = Math.max(0, y0 - radius)
  const yb = Math.min(height, y1 + radius)
  for (let y = ya; y < yb; y++) {
    const row = y * width
    for (let x = x0; x < x1; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k
        if (xx < 0) xx = 0
        else if (xx >= width) xx = width - 1
        acc += buf[row + xx]! * kernel[k + radius]!
      }
      tmp[row + x] = acc
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k
        if (yy < 0) yy = 0
        else if (yy >= height) yy = height - 1
        acc += tmp[yy * width + x]! * kernel[k + radius]!
      }
      buf[y * width + x] = acc
    }
  }
}

/** Render a frame. Deterministic for a given set of options. */
export function renderFrame(options: RenderOptions): FiducialImage {
  const { width, height, intrinsics, items } = options
  const S = options.supersample ?? 4
  const buf = new Float32Array(width * height)
  const bg = options.background ?? 120
  const flat = typeof bg === 'number'
  if (flat) buf.fill(bg)
  else buf.set(bg)

  let bx0 = width
  let by0 = height
  let bx1 = 0
  let by1 = 0
  for (const item of items) {
    const box = drawItem(buf, width, height, intrinsics, item, S)
    if (!box) continue
    bx0 = Math.min(bx0, box[0])
    by0 = Math.min(by0, box[1])
    bx1 = Math.max(bx1, box[2])
    by1 = Math.max(by1, box[3])
  }

  const sigma = options.blurSigma ?? 0
  if (sigma > 0) {
    if (!flat) {
      gaussianBlur(buf, width, height, sigma)
    } else if (bx1 > bx0) {
      // A flat background is unchanged by blur, so only the artwork's rectangle (plus the reach of the kernel) needs it.
      const reach = Math.ceil(sigma * 3) + 1
      gaussianBlur(buf, width, height, sigma, Math.max(0, bx0 - reach), Math.max(0, by0 - reach), Math.min(width, bx1 + reach), Math.min(height, by1 + reach))
    }
  }

  const gain = options.exposure?.gain ?? 1
  const offset = options.exposure?.offset ?? 0
  const gamma = options.exposure?.gamma ?? 1
  const shading = options.shading
  const light = options.light
  const noise = options.noiseSigma ?? 0
  const channels = options.channels ?? 1
  // Gamma through a 16-steps-per-level table; the affine part stays exact.
  let gammaLut: Float32Array | null = null
  if (gamma !== 1) {
    gammaLut = new Float32Array(255 * 16 + 2)
    for (let i = 0; i < gammaLut.length; i++) gammaLut[i] = 255 * Math.pow(Math.min(255, i / 16) / 255, gamma)
  }
  const table = noise > 0 ? normalTable() : null
  const mask = (1 << NOISE_TABLE_BITS) - 1
  const seed = options.seed ?? 1
  const start = Math.imul(seed, 2654435761) & mask
  const stride = (Math.imul(seed, 40503) | 1) & mask | 1

  const out = new Uint8Array(width * height * channels)
  let k = start
  for (let y = 0; y < height; y++) {
    const shadeY = shading ? shading.gy * (y / height - 0.5) : 0
    for (let x = 0; x < width; x++) {
      let v = buf[y * width + x]!
      if (shading) v *= 1 + shading.gx * (x / width - 0.5) + shadeY
      if (light) v *= light(x + 0.5, y + 0.5)
      v = v * gain + offset
      if (gammaLut) {
        const c = v < 0 ? 0 : v > 255 ? 255 : v
        v = gammaLut[(c * 16) | 0]!
      }
      if (table) {
        v += table[k]! * noise
        k = (k + stride) & mask
      }
      const q = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
      if (channels === 1) {
        out[y * width + x] = q
      } else {
        const o = (y * width + x) * 4
        out[o] = q
        out[o + 1] = q
        out[o + 2] = q
        out[o + 3] = 255
      }
    }
  }
  return { data: out, width, height, channels }
}

/** The convenience used by most tests: one dictionary tag at one pose. */
export function renderTag(args: {
  dictionary: Dictionary
  id: number
  sizeM: number
  pose: RigidPose
  intrinsics: CameraIntrinsics
  tag?: TagArtworkOptions
} & Partial<Omit<RenderOptions, 'items' | 'intrinsics' | 'width' | 'height'>> & { width?: number; height?: number }): FiducialImage {
  const { dictionary, id, sizeM, pose, intrinsics, tag, ...rest } = args
  return renderFrame({
    ...rest,
    width: rest.width ?? intrinsics.width,
    height: rest.height ?? intrinsics.height,
    intrinsics,
    items: [{ artwork: dictionaryTagArtwork(dictionary, id, sizeM, tag), pose }],
  })
}

/** 640x480 at fx = fy = 500 (about 65 degrees across): a typical phone frame at the size the brief names. */
export const INTRINSICS_640: CameraIntrinsics = { fx: 500, fy: 500, cx: 320, cy: 240, width: 640, height: 480 }

/** 1280x960 at fx = fy = 1000: the same lens at twice the resolution. */
export const INTRINSICS_1280: CameraIntrinsics = { fx: 1000, fy: 1000, cx: 640, cy: 480, width: 1280, height: 960 }

// ---------------------------------------------------------------------------------------------
// Backgrounds with no tag in them
// ---------------------------------------------------------------------------------------------

/** Pure sensor noise around a flat level: the image a covered lens would give. */
export function noiseOnlyFrame(width: number, height: number, level: number, sigma: number, seed: number): FiducialImage {
  return renderFrame({
    width,
    height,
    intrinsics: { fx: 500, fy: 500, cx: width / 2, cy: height / 2, width, height },
    items: [],
    background: level,
    noiseSigma: sigma,
    seed,
  })
}

/** Smooth value noise in 0..1, `octaves` layers deep. */
function fractalField(width: number, height: number, octaves: number, rand: () => number): Float32Array {
  const out = new Float32Array(width * height)
  let amp = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const cell = Math.max(2, Math.round(Math.max(width, height) / 2 ** (o + 1)))
    const gw = Math.ceil(width / cell) + 2
    const gh = Math.ceil(height / cell) + 2
    const grid = new Float32Array(gw * gh)
    for (let i = 0; i < grid.length; i++) grid[i] = rand()
    for (let y = 0; y < height; y++) {
      const gy = y / cell
      const iy = Math.floor(gy)
      const fy = gy - iy
      const sy = fy * fy * (3 - 2 * fy)
      for (let x = 0; x < width; x++) {
        const gx = x / cell
        const ix = Math.floor(gx)
        const fx = gx - ix
        const sx = fx * fx * (3 - 2 * fx)
        const a = grid[iy * gw + ix]!
        const b = grid[iy * gw + ix + 1]!
        const c = grid[(iy + 1) * gw + ix]!
        const d = grid[(iy + 1) * gw + ix + 1]!
        out[y * width + x]! += amp * (a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy)
      }
    }
    total += amp
    amp *= 0.55
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total
  return out
}

export type TextureKind = 'fractal' | 'furniture' | 'text' | 'tiles' | 'decoys' | 'random-decoys'

/**
 * A frame of something that is not a tag but has the structure a room has: soft shading,
 * straight edges, dark rectangles with light margins (windows, picture frames, screens), rows of
 * small glyphs, grids of tiles, and "decoys": black squares with a light margin and a random
 * 5x5 grid inside that is far from every code in `avoid`. `'random-decoys'` is the same with the grid
 * drawn at random and not kept away from the codes, so a few of them are by chance within a bit or two
 * of one: that is the kind that measures how often a decoder would be fooled. Seeded; returns a luma frame.
 */
export function textureFrame(kind: TextureKind, width: number, height: number, seed: number, avoid?: Dictionary): FiducialImage {
  const rand = mulberry32(seed * 7919 + 17)
  const field = fractalField(width, height, kind === 'fractal' ? 6 : 3, rand)
  const base = new Float32Array(width * height)
  for (let i = 0; i < base.length; i++) base[i] = 60 + 150 * field[i]!

  const fillRect = (x0: number, y0: number, w: number, h: number, level: number) => {
    const xa = Math.max(0, Math.floor(x0))
    const xb = Math.min(width, Math.ceil(x0 + w))
    const ya = Math.max(0, Math.floor(y0))
    const yb = Math.min(height, Math.ceil(y0 + h))
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) base[y * width + x] = level
  }

  if (kind === 'furniture') {
    const count = 6 + Math.floor(rand() * 10)
    for (let i = 0; i < count; i++) {
      const w = 30 + rand() * 180
      const h = 30 + rand() * 140
      const x = rand() * (width - w)
      const y = rand() * (height - h)
      fillRect(x, y, w, h, 20 + rand() * 200)
      // A light margin and an inner panel: a picture frame or a window.
      if (rand() < 0.5) fillRect(x + w * 0.1, y + h * 0.1, w * 0.8, h * 0.8, 40 + rand() * 180)
    }
  } else if (kind === 'text') {
    for (let line = 0; line < 14; line++) {
      const y = 12 + line * 32
      let x = 20
      while (x < width - 30) {
        const w = 4 + rand() * 14
        fillRect(x, y, w, 10 + rand() * 8, 20 + rand() * 40)
        x += w + 3 + rand() * 6
      }
    }
  } else if (kind === 'tiles') {
    const tile = 16 + Math.floor(rand() * 40)
    const phase = Math.floor(rand() * tile)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tx = Math.floor((x + phase) / tile)
        const ty = Math.floor((y + phase) / tile)
        base[y * width + x] = (tx + ty) % 2 === 0 ? 30 : 215
      }
    }
  } else if (kind === 'decoys' || kind === 'random-decoys') {
    const bits = avoid?.bits ?? 5
    const count = 4 + Math.floor(rand() * 5)
    for (let i = 0; i < count; i++) {
      const side = 40 + Math.floor(rand() * 110)
      const x = Math.floor(rand() * (width - side * 1.6)) + side * 0.3
      const y = Math.floor(rand() * (height - side * 1.6)) + side * 0.3
      // White margin, black square, then a random grid that is not a code.
      fillRect(x - side * 0.15, y - side * 0.15, side * 1.3, side * 1.3, 225)
      fillRect(x, y, side, side, 25)
      const cell = side / (bits + 2)
      const grid = randomNonCode(bits, rand, kind === 'decoys' ? avoid : undefined)
      for (let r = 0; r < bits; r++) {
        for (let c = 0; c < bits; c++) {
          if (!grid[r * bits + c]) fillRect(x + (c + 1) * cell, y + (r + 1) * cell, cell, cell, 225)
        }
      }
    }
  }

  return renderFrame({
    width,
    height,
    intrinsics: { fx: 500, fy: 500, cx: width / 2, cy: height / 2, width, height },
    items: [],
    background: base,
    noiseSigma: 2 + rand() * 3,
    blurSigma: rand() * 0.8,
    seed: seed + 3,
  })
}

/** A random bits x bits grid more than `maxCorrectableBits` flips away from every code of `avoid`, in every rotation. */
export function randomNonCode(bits: number, rand: () => number, avoid?: Dictionary): Uint8Array {
  for (;;) {
    const grid = new Uint8Array(bits * bits)
    for (let i = 0; i < grid.length; i++) grid[i] = rand() < 0.5 ? 1 : 0
    if (!avoid) return grid
    // `match` with a ceiling at the correctable limit answers "is any code that close": null means
    // none is (two codes cannot both be within that reach, so null is never an ambiguity).
    if (avoid.match(grid, avoid.maxCorrectableBits) === null) return grid
  }
}

// ---------------------------------------------------------------------------------------------
// Session-frame scenes: a tag fixed in the world, a camera that moves. Written from the three.js
// camera model directly (a camera looks down -z with +y up), NOT through the module's own
// OpenCV-to-three.js conversion, so a flipped axis there cannot cancel itself out here.
// ---------------------------------------------------------------------------------------------

export interface SessionPoseLike {
  position: Vec3
  rotation: { x: number; y: number; z: number; w: number }
}

/** A row-major rotation matrix as a unit quaternion. */
export function quatFromMatrix(m: Mat3): { x: number; y: number; z: number; w: number } {
  const tr = m[0]! + m[4]! + m[8]!
  let x: number
  let y: number
  let z: number
  let w: number
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s
    x = (m[7]! - m[5]!) / s
    y = (m[2]! - m[6]!) / s
    z = (m[3]! - m[1]!) / s
  } else if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = Math.sqrt(1 + m[0]! - m[4]! - m[8]!) * 2
    w = (m[7]! - m[5]!) / s
    x = 0.25 * s
    y = (m[1]! + m[3]!) / s
    z = (m[2]! + m[6]!) / s
  } else if (m[4]! > m[8]!) {
    const s = Math.sqrt(1 + m[4]! - m[0]! - m[8]!) * 2
    w = (m[2]! - m[6]!) / s
    x = (m[1]! + m[3]!) / s
    y = 0.25 * s
    z = (m[5]! + m[7]!) / s
  } else {
    const s = Math.sqrt(1 + m[8]! - m[0]! - m[4]!) * 2
    w = (m[3]! - m[1]!) / s
    x = (m[2]! + m[6]!) / s
    y = (m[5]! + m[7]!) / s
    z = 0.25 * s
  }
  const n = Math.hypot(x, y, z, w)
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

export function matrixFromQuat(q: { x: number; y: number; z: number; w: number }): number[] {
  const { x, y, z, w } = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function crossV(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function unit(a: Vec3): Vec3 {
  const n = Math.hypot(a.x, a.y, a.z)
  return { x: a.x / n, y: a.y / n, z: a.z / n }
}

/** A three.js camera pose at `position` looking at `target`, +y up as far as it can be (three.js `lookAt` for a camera). */
export function lookAtPose(position: Vec3, target: Vec3, up: Vec3 = { x: 0, y: 1, z: 0 }): SessionPoseLike {
  const z = unit(sub(position, target))
  const x = unit(crossV(up, z))
  const y = crossV(z, x)
  const m = [x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z]
  return { position, rotation: quatFromMatrix(m) }
}

/**
 * Where a tag fixed in the session shows up in a camera: the four corners (printed top-left,
 * top-right, bottom-right, bottom-left) in pixels, by the three.js camera model. The tag pose maps
 * tag-frame points (x right, y up, z out) to session coordinates.
 */
export function projectSessionTag(tag: SessionPoseLike, camera: SessionPoseLike, K: CameraIntrinsics, sizeM: number): Array<{ x: number; y: number }> {
  const rt = matrixFromQuat(tag.rotation)
  const rc = matrixFromQuat(camera.rotation)
  const h = sizeM / 2
  return [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
    const s = mat3Apply(rt, { x: x!, y: y!, z: 0 })
    const world = { x: s.x + tag.position.x, y: s.y + tag.position.y, z: s.z + tag.position.z }
    const d = sub(world, camera.position)
    // camera-local = R_c^T d
    const local = mat3Apply(mat3Transpose(rc), d)
    return { x: K.cx + (K.fx * local.x) / -local.z, y: K.cy - (K.fy * local.y) / -local.z }
  })
}
