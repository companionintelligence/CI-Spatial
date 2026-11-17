/**
 * A synthetic room rendered from known cameras, for the opt-in COLMAP toy test
 * (colmap_toy_sfm.test.ts). Not a test file: Deno only runs what is named `*.test.ts`.
 *
 * Why a renderer and not a few photographs: the toy test has to prove the joint solve gets the
 * *geometry* right (one camera per session, a chain back to the Place frame), and for that it needs
 * the truth: where every camera really was, in the Place frame, and how each session's own AR frame
 * (its units, its heading, its origin) relates to that frame. A rendered room has all of it by
 * construction. It also needs no real user data, which no test may feed to COLMAP.
 *
 * The room is a closed box (5 x 2.6 x 4 m, y up, floor at y = 0) with two boxes standing in it. Every
 * wall, the floor, the ceiling and every box face carries its own smooth multi-scale noise, so SIFT
 * finds blobs at several scales and no two places look alike. The cameras are pinholes (principal point at the
 * image centre, no distortion), so the intrinsics a session records are exact except for the noise this
 * module adds to the AR positions.
 *
 * Nothing here is measured against a phone. The cameras walk a ring around the middle of the room and
 * look outward at the walls, which is a far easier set than a handheld scan of a real room (no blur, no
 * rolling shutter, no lighting change, no moved furniture). What passing on it shows is that the plumbing
 * is right and the chain algebra recovers a known similarity. It does not show anything about real rooms.
 */
import { Buffer } from 'node:buffer'
import { rotationToQuat } from '../../../server/colmap/colmap_model.ts'

export type V3 = [number, number, number]
export type M3 = [V3, V3, V3]

/** A small deterministic generator, so the scene and the AR noise are the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard-normal draws from a uniform generator (Box-Muller). */
export function gaussian(next: () => number): number {
  const u = Math.max(next(), 1e-12)
  const v = next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ─── Small linear algebra (row-major 3x3) ────────────────────────────────────

export function rotY(deg: number): M3 {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
}

export function matMul(a: M3, b: M3): M3 {
  const out: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i]![j] = a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!
  }
  return out
}

export function transpose(m: M3): M3 {
  return [[m[0]![0]!, m[1]![0]!, m[2]![0]!], [m[0]![1]!, m[1]![1]!, m[2]![1]!], [m[0]![2]!, m[1]![2]!, m[2]![2]!]]
}

export function mulVec(m: M3, v: V3): V3 {
  return [
    m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
    m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
    m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
  ]
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function unit(v: V3): V3 {
  const n = Math.hypot(v[0], v[1], v[2])
  return [v[0] / n, v[1] / n, v[2] / n]
}

/**
 * Camera-to-world rotation in the OpenGL convention the AR runtimes record (x right, y up, the camera
 * looks down -z), for a camera at `from` looking at `target`. Columns are right, up and back.
 */
export function lookAtGl(from: V3, target: V3): M3 {
  const forward = unit(sub(target, from))
  const right = unit(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  return [
    [right[0], up[0], -forward[0]],
    [right[1], up[1], -forward[1]],
    [right[2], up[2], -forward[2]],
  ]
}

// ─── The room ────────────────────────────────────────────────────────────────

export const ROOM_MIN: V3 = [0, 0, 0]
export const ROOM_MAX: V3 = [5, 2.6, 4]

interface Block {
  min: V3
  max: V3
}

/** Two boxes standing on the floor, so the room is not six planes and nothing is homography-degenerate. */
const BLOCKS: Block[] = [
  { min: [3.3, 0, 0.6], max: [4.1, 0.9, 1.4] },
  { min: [0.6, 0, 2.8], max: [1.2, 1.4, 3.4] },
]

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy, seed)
  const b = hash2(ix + 1, iy, seed)
  const c = hash2(ix, iy + 1, seed)
  const d = hash2(ix + 1, iy + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** Octave frequencies per metre and their weights: blobs from a third of a metre down to a couple of centimetres. */
const OCTAVES: ReadonlyArray<readonly [number, number]> = [[3, 0.34], [7, 0.3], [17, 0.24], [40, 0.12]]

/** Brightness 0..1 of surface `surface` at surface coordinates (u, v), in metres. */
function surfaceLuminance(surface: number, u: number, v: number): number {
  let sum = 0
  for (let k = 0; k < OCTAVES.length; k++) {
    const [freq, weight] = OCTAVES[k]!
    sum += weight * valueNoise(u * freq, v * freq, surface * 131 + k * 17 + 5)
  }
  return Math.min(1, Math.max(0, (sum - 0.5) * 2.4 + 0.5))
}

/** The tint of each surface, so the colour channels carry a little information too. */
function tint(surface: number): V3 {
  const r = hash2(surface, 1, 99)
  const g = hash2(surface, 2, 99)
  const b = hash2(surface, 3, 99)
  return [0.75 + 0.25 * r, 0.75 + 0.25 * g, 0.75 + 0.25 * b]
}

/** Surface ids: room faces 0-5 (axis * 2 + side), then 6 + 6 * block + the same numbering for a block's faces. */
function colourAt(surface: number, p: V3, axis: number): V3 {
  const u = axis === 0 ? p[1] : p[0]
  const v = axis === 2 ? p[1] : p[2]
  const lum = surfaceLuminance(surface, u + surface * 3.7, v + surface * 1.9)
  const t = tint(surface)
  return [lum * t[0], lum * t[1], lum * t[2]]
}

/** The colour seen along a ray from `origin` (inside the room) in direction `dir`. */
export function castRay(origin: V3, dir: V3): V3 {
  let bestT = Infinity
  let bestAxis = -1
  let bestSurface = -1
  // The room: the nearest wall the ray runs into from inside.
  for (let axis = 0; axis < 3; axis++) {
    const d = dir[axis]!
    if (d === 0) continue
    const wall = d > 0 ? ROOM_MAX[axis]! : ROOM_MIN[axis]!
    const t = (wall - origin[axis]!) / d
    if (t > 1e-6 && t < bestT) {
      bestT = t
      bestAxis = axis
      bestSurface = axis * 2 + (d > 0 ? 1 : 0)
    }
  }
  // The boxes: the slab method, nearest entry in front of the room wall.
  for (let bi = 0; bi < BLOCKS.length; bi++) {
    const block = BLOCKS[bi]!
    let tNear = -Infinity
    let tFar = Infinity
    let nearAxis = -1
    let nearSide = 0
    for (let axis = 0; axis < 3; axis++) {
      const d = dir[axis]!
      const o = origin[axis]!
      if (d === 0) {
        if (o < block.min[axis]! || o > block.max[axis]!) {
          tNear = Infinity
          break
        }
        continue
      }
      let t0 = (block.min[axis]! - o) / d
      let t1 = (block.max[axis]! - o) / d
      let side = 0
      if (t0 > t1) {
        const swap = t0
        t0 = t1
        t1 = swap
        side = 1
      }
      if (t0 > tNear) {
        tNear = t0
        nearAxis = axis
        nearSide = side
      }
      if (t1 < tFar) tFar = t1
    }
    if (tNear <= tFar && tNear > 1e-6 && tNear < bestT) {
      bestT = tNear
      bestAxis = nearAxis
      bestSurface = 6 + bi * 6 + nearAxis * 2 + nearSide
    }
  }
  const hit: V3 = [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT, origin[2] + dir[2] * bestT]
  return colourAt(bestSurface, hit, bestAxis)
}

// ─── Cameras and sessions ────────────────────────────────────────────────────

export interface ToyView {
  /** Camera centre in the Place frame, metres. */
  position: V3
  /** Camera-to-world rotation in the Place frame, OpenGL convention (columns right, up, back). */
  rotation: M3
}

export interface ToySessionSpec {
  /** A server session id (`sess-...`), which is also the folder name COLMAP sees. */
  sessionId: string
  width: number
  height: number
  /** The true focal length in pixels (square pixels, principal point at the centre). */
  focalPx: number
  /**
   * Place metres per unit of this session's own AR frame: the unit mismatch between runtimes. 1 for a
   * metric runtime. Truth, never recorded anywhere: the toy test must recover it.
   */
  unit: number
  /** The session frame's heading against the Place frame, degrees about +Y. */
  yawDeg: number
  /** The session frame's origin in the Place frame, metres. */
  origin: V3
  /** Where this session's cameras really were, in the Place frame. */
  views: ToyView[]
  /** Sigma of the noise added to the recorded AR positions, in the session's own units. */
  positionNoise: number
  seed: number
}

/** `x_place = unit * R * x_session + t`: the truth the chain has to recover. */
export interface ToyAxes {
  rotation: M3
  translation: V3
  unit: number
}

export function sessionTruth(spec: ToySessionSpec): ToyAxes {
  return { rotation: rotY(spec.yawDeg), translation: spec.origin, unit: spec.unit }
}

/** A ring of cameras round `centre`, each looking outward at the walls, slightly up or down. */
export function ringViews(
  centre: V3,
  radii: [number, number],
  count: number,
  startDeg: number,
  height: number,
  seed: number,
): ToyView[] {
  const next = mulberry32(seed)
  const views: ToyView[] = []
  for (let i = 0; i < count; i++) {
    const a = ((startDeg + (360 * i) / count) * Math.PI) / 180
    const wobble = (next() - 0.5) * 0.12
    const position: V3 = [centre[0] + radii[0] * Math.cos(a), height + wobble, centre[2] + radii[1] * Math.sin(a)]
    // Looking outward, a little off the radial so neighbouring views overlap and no two see the same patch.
    const look = a + ((next() - 0.5) * 24 * Math.PI) / 180
    const pitch = (next() - 0.5) * 0.5
    const target: V3 = [position[0] + 3 * Math.cos(look), position[1] + pitch * 1.5, position[2] + 3 * Math.sin(look)]
    views.push({ position, rotation: lookAtGl(position, target) })
  }
  return views
}

/** Render one view to RGBA bytes. */
export function renderView(spec: Pick<ToySessionSpec, 'width' | 'height' | 'focalPx'>, view: ToyView): Uint8Array {
  const { width, height, focalPx } = spec
  const out = new Uint8Array(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const r = view.rotation
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Pixel ray in the OpenGL camera frame: x right, y up, looking down -z.
      const gx = (x + 0.5 - cx) / focalPx
      const gy = -(y + 0.5 - cy) / focalPx
      const gz = -1
      const dir = unit([
        r[0]![0]! * gx + r[0]![1]! * gy + r[0]![2]! * gz,
        r[1]![0]! * gx + r[1]![1]! * gy + r[1]![2]! * gz,
        r[2]![0]! * gx + r[2]![1]! * gy + r[2]![2]! * gz,
      ])
      const c = castRay(view.position, dir)
      const o = (y * width + x) * 4
      out[o] = Math.round(c[0] * 255)
      out[o + 1] = Math.round(c[1] * 255)
      out[o + 2] = Math.round(c[2] * 255)
      out[o + 3] = 255
    }
  }
  return out
}

/** The image flipped left to right: what a capture whose camera image is mirrored would hand COLMAP. */
export function mirrorRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      const to = (y * width + (width - 1 - x)) * 4
      out[to] = rgba[from]!
      out[to + 1] = rgba[from + 1]!
      out[to + 2] = rgba[from + 2]!
      out[to + 3] = rgba[from + 3]!
    }
  }
  return out
}

export async function encodeJpeg(rgba: Uint8Array, width: number, height: number, quality = 92): Promise<Uint8Array> {
  const { Jimp } = await import('jimp')
  const image = Jimp.fromBitmap({ data: Buffer.from(rgba), width, height })
  return new Uint8Array(await image.getBuffer('image/jpeg', { quality }))
}

/** What `writeToySession` leaves behind, for the test to compare a solve against. */
export interface ToySessionOnDisk {
  sessionDir: string
  /** `kf-00000.jpg` ... in capture order. */
  files: string[]
  /** The pose each keyframe record carries: camera-to-world in the session's own frame, with the noise. */
  recorded: Array<{ position: V3; rotation: M3 }>
  /** The vertical field of view each record carries, degrees. */
  fovYDeg: number
}

/**
 * Write one session the way the server does: `kf-NNNNN.jpg` and a `keyframes.jsonl` line per frame with the
 * AR pose (in the session's own frame and units, plus noise) and the intrinsics the phone reports.
 * `mirrorImages` flips every picture left to right and leaves the poses alone: a session whose images cannot match
 * the others', for the test that a session COLMAP cannot tie is not registered.
 */
export async function writeToySession(
  parent: string,
  spec: ToySessionSpec,
  options: { mirrorImages?: boolean } = {},
): Promise<ToySessionOnDisk> {
  const sessionDir = `${parent}/${spec.sessionId}`
  await Deno.mkdir(sessionDir, { recursive: true })
  const truth = sessionTruth(spec)
  const toSession = transpose(truth.rotation)
  const next = mulberry32(spec.seed)
  const fovYDeg = (2 * Math.atan(spec.height / (2 * spec.focalPx)) * 180) / Math.PI
  const lines: string[] = []
  const files: string[] = []
  const recorded: ToySessionOnDisk['recorded'] = []

  for (let i = 0; i < spec.views.length; i++) {
    const view = spec.views[i]!
    const file = `kf-${String(i).padStart(5, '0')}.jpg`
    const rendered = renderView(spec, view)
    const jpeg = await encodeJpeg(options.mirrorImages ? mirrorRgba(rendered, spec.width, spec.height) : rendered, spec.width, spec.height)
    await Deno.writeFile(`${sessionDir}/${file}`, jpeg)

    // Place -> session: x_s = R^T (x_p - t) / unit; the orientation turns by R^T and is not scaled.
    const local = mulVec(toSession, sub(view.position, truth.translation))
    const position: V3 = [
      local[0] / truth.unit + gaussian(next) * spec.positionNoise,
      local[1] / truth.unit + gaussian(next) * spec.positionNoise,
      local[2] / truth.unit + gaussian(next) * spec.positionNoise,
    ]
    const rotation = matMul(toSession, view.rotation)
    const [w, x, y, z] = rotationToQuat(rotation)
    recorded.push({ position, rotation })
    files.push(file)
    lines.push(JSON.stringify({
      index: i,
      file,
      timestamp: i * 1000,
      capturedAt: 1_700_000_000_000 + i * 1000,
      pose: { position: { x: position[0], y: position[1], z: position[2] }, rotation: { x, y, z, w } },
      epoch: 0,
      intrinsics: {
        fovYDeg,
        aspect: spec.width / spec.height,
        width: spec.width,
        height: spec.height,
        sourceWidth: spec.width,
        sourceHeight: spec.height,
      },
      bytes: jpeg.byteLength,
      receivedAt: 1_700_000_000_000 + i * 1000,
    }))
  }
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, lines.join('\n') + '\n')
  return { sessionDir, files, recorded, fovYDeg }
}
