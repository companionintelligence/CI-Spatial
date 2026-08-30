/**
 * Renders a synthetic walkthrough clip for exercising /ingest-video end to end.
 *
 * The point of this fixture is PARALLAX. A pan over a still image, or anything
 * ffmpeg's own lavfi sources can synthesise, gives a reconstructor no baseline:
 * every frame is the same view, structure-from-motion finds no depth, and the
 * ingest "passes" while proving nothing. So this ray-traces a room interior
 * (walls, floor, ceiling, plus free-standing furniture boxes that occlude and
 * disocclude each other) from a camera that physically walks through it — the
 * near boxes sweep across the far wall exactly as they would on a phone.
 *
 * Texture is procedural value-noise summed over five octaves and seeded per
 * face, deliberately NON-repeating: a tiled checker would give a matcher
 * thousands of identical corners and it would happily match the wrong ones.
 *
 * Rendering is split across worker threads by frame (each worker owns whole
 * frames, so there is no seam-stitching), written as binary PPM, and encoded
 * with ffmpeg. Frames are deleted afterwards; only the .mp4 survives.
 *
 * Usage:
 *   node tests/fixtures/video-ingest/make-walkthrough.mjs [--seconds 16]
 *     [--fps 15] [--width 1920] [--height 1080] [--out <path>]
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname

// ── Scene ────────────────────────────────────────────────────────────────────
// Metres, Y up. The room is a box the camera stands inside; furniture are solid
// boxes it walks past. Kept small and explicit so the ray tests stay trivial.
const ROOM = { min: [0, 0, 0], max: [6, 2.6, 4.4] }
const FURNITURE = [
  { min: [0.6, 0.0, 0.5], max: [2.0, 0.75, 1.4], tint: [0.78, 0.42, 0.28], seed: 11 }, // low cabinet
  { min: [3.4, 0.0, 0.3], max: [4.2, 1.85, 1.1], tint: [0.52, 0.60, 0.72], seed: 23 }, // tall shelf
  { min: [2.2, 0.0, 2.4], max: [4.6, 0.45, 3.6], tint: [0.55, 0.55, 0.50], seed: 37 }, // bed / bench
  { min: [0.4, 0.0, 3.1], max: [1.3, 1.05, 3.9], tint: [0.30, 0.55, 0.40], seed: 53 }, // side table
  { min: [4.9, 0.9, 1.8], max: [5.9, 1.7, 2.6], tint: [0.66, 0.60, 0.30], seed: 71 }, // wall unit
  { min: [1.5, 0.0, 1.9], max: [1.9, 1.3, 2.3], tint: [0.48, 0.30, 0.52], seed: 89 }, // column
]
// Two lights, not one. With a single ceiling lamp the face of a box turned away
// from it renders as a near-flat dark patch — the texture is still there but the
// detector has no contrast to find it in, so the boxes contribute silhouettes
// only. The fill light near the walk-in corner keeps every visible face textured.
const LIGHTS = [
  { p: [3.0, 2.45, 2.2], power: 1.5 },
  { p: [0.8, 2.1, 0.6], power: 0.85 },
]

/**
 * Camera path: a curved walk diagonally across the room, aimed by look-at at an
 * interest point that drifts through the middle of the furniture.
 *
 * Both halves are load-bearing. The curve gives parallax — a dead-straight dolly
 * down the view axis produces almost none for anything near the image centre.
 * The look-at keeps the furniture framed; an unconstrained yaw sweep spent most
 * of the clip pointed at a blank corner, which is parallax nothing can use.
 */
function cameraAt(t) {
  const eye = [
    0.9 + 4.2 * t + 0.35 * Math.sin(t * Math.PI * 2),
    1.52 + 0.035 * Math.sin(t * 18.0),
    0.85 + 2.4 * t - 0.5 * Math.sin(t * Math.PI),
  ]
  const target = [
    3.0 + 1.6 * Math.sin(t * Math.PI * 0.8),
    1.15 + 0.15 * Math.sin(t * 7.0),
    2.6 - 0.8 * Math.cos(t * Math.PI * 0.6),
  ]
  const roll = 0.03 * Math.sin(t * 9.0)
  return { eye, target, roll }
}

// ── Procedural texture ───────────────────────────────────────────────────────
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(u, v, seed) {
  const x0 = Math.floor(u), y0 = Math.floor(v)
  const fx = u - x0, fy = v - y0
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed)
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed)
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy
}

/**
 * Five octaves of value noise plus a faint large-scale wash. The high octaves
 * are what a feature detector actually latches onto; the wash keeps neighbouring
 * regions distinguishable so matches are globally unambiguous, not just locally.
 */
function surfaceAlbedo(u, v, seed, tint, out) {
  // Frequencies are in cycles per metre, so a 0.4 m furniture face still gets
  // several cycles of the base octave — at freq 3.5 the small boxes came out
  // almost untextured while the walls looked fine.
  let n = 0, amp = 0.5, freq = 7.0
  for (let o = 0; o < 5; o++) {
    n += amp * valueNoise(u * freq, v * freq, seed + o * 977)
    amp *= 0.5
    freq *= 2.7
  }
  const wash = 0.22 * valueNoise(u * 0.6, v * 0.6, seed + 4001)
  const speck = valueNoise(u * 41, v * 41, seed + 6007) > 0.9 ? 0.1 : 0
  const shade = 0.30 + 0.85 * n + wash + speck
  out[0] = Math.min(1, tint[0] * shade)
  out[1] = Math.min(1, tint[1] * shade)
  out[2] = Math.min(1, tint[2] * shade)
}

const WALL_TINTS = [
  [0.72, 0.70, 0.64], [0.66, 0.68, 0.72], [0.70, 0.65, 0.60],
  [0.62, 0.66, 0.63], [0.55, 0.55, 0.58], [0.80, 0.78, 0.74],
]

/** Slab test for a ray that starts INSIDE the box: returns the exit hit. */
function hitRoom(o, d) {
  let t = Infinity, axis = 0, sign = 1
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) continue
    const bound = d[a] > 0 ? ROOM.max[a] : ROOM.min[a]
    const tc = (bound - o[a]) / d[a]
    if (tc > 1e-6 && tc < t) { t = tc; axis = a; sign = d[a] > 0 ? 1 : -1 }
  }
  return { t, axis, sign }
}

/** Slab test for a ray outside the box: returns entry t, or Infinity. */
function hitBox(box, o, d) {
  let tmin = 1e-6, tmax = Infinity, axis = 0, sign = 1
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < box.min[a] || o[a] > box.max[a]) return { t: Infinity, axis: 0, sign: 1 }
      continue
    }
    const inv = 1 / d[a]
    let t0 = (box.min[a] - o[a]) * inv, t1 = (box.max[a] - o[a]) * inv
    let s = -1
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; s = 1 }
    if (t0 > tmin) { tmin = t0; axis = a; sign = s }
    if (t1 < tmax) tmax = t1
    if (tmax < tmin) return { t: Infinity, axis: 0, sign: 1 }
  }
  return { t: tmin, axis, sign }
}

function uvFor(axis, p) {
  if (axis === 0) return [p[2], p[1]]
  if (axis === 1) return [p[0], p[2]]
  return [p[0], p[1]]
}

const albedo = [0, 0, 0]

function shade(o, d, out) {
  const room = hitRoom(o, d)
  let best = room.t, bestAxis = room.axis, bestSign = room.sign
  let tint = WALL_TINTS[room.axis * 2 + (room.sign > 0 ? 1 : 0)]
  let seed = 101 + room.axis * 7 + (room.sign > 0 ? 3 : 0)
  for (const box of FURNITURE) {
    const h = hitBox(box, o, d)
    if (h.t < best) { best = h.t; bestAxis = h.axis; bestSign = h.sign; tint = box.tint; seed = box.seed }
  }

  const p = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best]
  const [u, v] = uvFor(bestAxis, p)
  surfaceAlbedo(u, v, seed, tint, albedo)

  const n = [0, 0, 0]
  n[bestAxis] = -bestSign
  // Inverse-square-ish falloff with a floor. Tuned so nothing clips to pure
  // white: a blown-out wall carries no gradient, and a feature detector sees a
  // flat region exactly where the texture was supposed to be.
  let lit = 0.42
  for (const { p: lp, power } of LIGHTS) {
    const l = [lp[0] - p[0], lp[1] - p[1], lp[2] - p[2]]
    const ld = Math.hypot(l[0], l[1], l[2]) || 1
    const ndl = Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / ld)
    lit += power * ndl / (1 + 0.2 * ld * ld)
  }

  out[0] = Math.min(255, albedo[0] * lit * 255) | 0
  out[1] = Math.min(255, albedo[1] * lit * 255) | 0
  out[2] = Math.min(255, albedo[2] * lit * 255) | 0
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function renderFrame(t, width, height) {
  const { eye, target, roll } = cameraAt(t)
  const fwd = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]])
  const up = [Math.sin(roll), Math.cos(roll), 0]
  const right = normalize(cross(fwd, up))
  const upv = cross(right, fwd)
  // 65° horizontal FOV, roughly a phone's rear camera.
  const tanHalf = Math.tan((65 * Math.PI / 180) / 2)
  const aspect = width / height
  const buf = Buffer.allocUnsafe(width * height * 3)
  const px = [0, 0, 0]
  const d = [0, 0, 0]
  let i = 0
  for (let y = 0; y < height; y++) {
    const ndcY = (1 - 2 * (y + 0.5) / height) * tanHalf
    for (let x = 0; x < width; x++) {
      const ndcX = (2 * (x + 0.5) / width - 1) * tanHalf * aspect
      d[0] = fwd[0] + right[0] * ndcX + upv[0] * ndcY
      d[1] = fwd[1] + right[1] * ndcX + upv[1] * ndcY
      d[2] = fwd[2] + right[2] * ndcX + upv[2] * ndcY
      const len = Math.hypot(d[0], d[1], d[2])
      d[0] /= len; d[1] /= len; d[2] /= len
      shade(eye, d, px)
      buf[i++] = px[0]; buf[i++] = px[1]; buf[i++] = px[2]
    }
  }
  return buf
}

// ── Worker: render an assigned set of whole frames ───────────────────────────
if (!isMainThread) {
  const { frames, width, height, totalFrames, framesDir } = workerData
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`)
  const { writeFileSync } = await import('node:fs')
  for (const f of frames) {
    const buf = renderFrame(f / (totalFrames - 1), width, height)
    writeFileSync(path.join(framesDir, `f-${String(f).padStart(5, '0')}.ppm`), Buffer.concat([header, buf]))
  }
  parentPort.postMessage(frames.length)
} else {
  const args = {}
  const list = process.argv.slice(2)
  for (let i = 0; i < list.length; i += 2) args[list[i].replace(/^--/, '')] = list[i + 1]

  const SECONDS = Number(args.seconds ?? 16)
  const FPS = Number(args.fps ?? 15)
  const WIDTH = Number(args.width ?? 1920)
  const HEIGHT = Number(args.height ?? 1080)
  const OUT = args.out ?? path.join(HERE, 'walkthrough-1080p.mp4')
  const TOTAL = Math.round(SECONDS * FPS)
  const framesDir = path.join(HERE, '.frames')

  await rm(framesDir, { recursive: true, force: true })
  await mkdir(framesDir, { recursive: true })

  const workers = Math.max(1, Math.min(availableParallelism(), TOTAL))
  const buckets = Array.from({ length: workers }, () => [])
  for (let f = 0; f < TOTAL; f++) buckets[f % workers].push(f)

  const started = Date.now()
  await Promise.all(buckets.map((frames) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { frames, width: WIDTH, height: HEIGHT, totalFrames: TOTAL, framesDir },
    })
    w.on('message', resolve)
    w.on('error', reject)
  })))
  console.log(`[make-walkthrough] rendered ${TOTAL} frames ${WIDTH}x${HEIGHT} in ${((Date.now() - started) / 1000).toFixed(1)}s across ${workers} workers`)

  execFileSync('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'f-%05d.ppm'),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    OUT,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  await rm(framesDir, { recursive: true, force: true })
  console.log(`[make-walkthrough] wrote ${OUT}`)
}
