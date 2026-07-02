/**
 * Companion-Scan session → Nerfstudio dataset converter for Brush training.
 *
 * Brush's dataset loader understands the Nerfstudio `transforms.json` layout:
 * a single shared/per-frame intrinsic block plus a `frames[]` array where each
 * frame carries a `file_path` and a 4×4 camera-to-world `transform_matrix`.
 *
 * A Companion-Scan session already stores exactly the inputs a splat trainer
 * needs — pose-tagged JPEG keyframes streamed from the phone:
 *
 *   scans/sessions/<id>/
 *   ├── kf-00000.jpg …            downscaled RGB keyframes
 *   ├── keyframes.jsonl           one JSON record / keyframe (pose + intrinsics)
 *   └── lingbot-map.point-cloud.ply   (optional) seed cloud from a prior job
 *
 * This module reads that session and writes a `brush-dataset/` subdirectory:
 *
 *   scans/sessions/<id>/brush-dataset/
 *   ├── transforms.json
 *   ├── images/kf-00000.jpg …     symlinked (fallback: copied) from the session
 *   └── sparse_pc.ply             (optional) copy of the seed point cloud
 *
 * Convention notes baked in from the spike:
 *   - Companion-Scan / WebXR / three.js poses are already OpenGL/Blender
 *     camera-to-world (right/up/back, camera looks down -Z). Nerfstudio uses
 *     the same convention, so NO axis flip is applied — position + quaternion
 *     map straight into the 4×4 matrix.
 *   - Image dimensions are read from the actual JPEG (SOF marker), never
 *     trusted from the metadata, because the phone downscales frames and the
 *     recorded `width`/`height` can drift from what actually landed on disk.
 *   - `fl_x`/`fl_y` are derived per-frame from the recorded `fovYDeg`
 *     (or `fx`/`fy` when the client supplied them) scaled to the real pixels.
 *
 * The module is pure + Deno-runnable so it can be unit-tested without spawning
 * Brush. It does no network I/O.
 */

export interface KeyframeRecord {
  index?: number
  file?: string
  timestamp?: number | null
  pose?: {
    position?: { x?: number; y?: number; z?: number }
    rotation?: { x?: number; y?: number; z?: number; w?: number }
  } | null
  intrinsics?: {
    width?: number
    height?: number
    sourceWidth?: number
    sourceHeight?: number
    fovYDeg?: number
    aspect?: number
    fx?: number
    fy?: number
    cx?: number
    cy?: number
  } | null
}

export interface NerfstudioFrame {
  file_path: string
  /** Row-major 4×4 camera-to-world (OpenGL/Blender convention, no flip). */
  transform_matrix: number[][]
  fl_x: number
  fl_y: number
  cx: number
  cy: number
  w: number
  h: number
}

export interface NerfstudioTransforms {
  camera_model: 'OPENCV' | 'PINHOLE'
  /** Provenance so a re-run / debugging can trace which session produced this. */
  ci_source?: { sessionId: string; frameCount: number; generatedAt: string }
  /** Path (relative to transforms.json) to the seed point cloud, when present. */
  ply_file_path?: string
  frames: NerfstudioFrame[]
}

export interface BuildDatasetOptions {
  /** Absolute path to the session directory (scans/sessions/<id>). */
  sessionDir: string
  /**
   * Where to write the dataset. Defaults to `<sessionDir>/brush-dataset`.
   * The directory (and its `images/` child) is created if missing.
   */
  datasetDir?: string
  /**
   * How to bring images into the dataset. 'symlink' (default) avoids copying
   * megabytes of JPEG; falls back to 'copy' automatically if symlinking fails
   * (e.g. cross-device). 'copy' forces a byte copy.
   */
  imageMode?: 'symlink' | 'copy'
}

export interface BuildDatasetResult {
  datasetDir: string
  transformsPath: string
  imagesDir: string
  frameCount: number
  /** Absolute path of the copied seed PLY, when the session had one. */
  seedPlyPath?: string
  /** Frames that were dropped because the image was missing or unreadable. */
  droppedFrames: number
}

const KEYFRAME_FILE_RE = /^kf-\d{5}\.jpg$/

/**
 * Read a Companion-Scan session directory and materialise a Nerfstudio dataset
 * Brush can train on. Returns the dataset path + stats. Throws only on
 * unrecoverable input (no keyframes.jsonl, or zero usable frames) so the
 * caller can turn that into a `skipped` manifest.
 */
export async function buildBrushDataset(opts: BuildDatasetOptions): Promise<BuildDatasetResult> {
  const sessionDir = opts.sessionDir
  const datasetDir = opts.datasetDir ?? `${sessionDir}/brush-dataset`
  const imagesDir = `${datasetDir}/images`
  const imageMode = opts.imageMode ?? 'symlink'

  const records = await readKeyframes(sessionDir)
  if (records.length === 0) {
    throw new Error('no keyframes found in session (keyframes.jsonl empty or missing)')
  }

  await Deno.mkdir(imagesDir, { recursive: true })

  const frames: NerfstudioFrame[] = []
  let dropped = 0
  for (const rec of records) {
    const file = rec.file
    if (!file || !KEYFRAME_FILE_RE.test(file)) {
      dropped++
      continue
    }
    const srcPath = `${sessionDir}/${file}`
    let bytes: Uint8Array
    try {
      bytes = await Deno.readFile(srcPath)
    } catch {
      dropped++
      continue
    }
    const dims = readJpegDimensions(bytes)
    if (!dims) {
      dropped++
      continue
    }
    const { w, h } = dims

    // Materialise the image into the dataset's images/ dir.
    const destPath = `${imagesDir}/${file}`
    await materialiseImage(srcPath, destPath, bytes, imageMode)

    const intr = deriveIntrinsics(rec.intrinsics ?? {}, w, h)
    const transform = poseToMatrix(rec.pose ?? {})

    frames.push({
      file_path: `images/${file}`,
      transform_matrix: transform,
      fl_x: intr.flX,
      fl_y: intr.flY,
      cx: intr.cx,
      cy: intr.cy,
      w,
      h,
    })
  }

  if (frames.length === 0) {
    throw new Error('no usable keyframes (all images missing/unreadable)')
  }

  // Seed the splat init from a prior LingBot-Map point cloud when present —
  // Brush's PLY importer accepts a plain xyz(+rgb) cloud as SfM init.
  let seedPlyPath: string | undefined
  const srcPly = `${sessionDir}/lingbot-map.point-cloud.ply`
  try {
    const plyBytes = await Deno.readFile(srcPly)
    seedPlyPath = `${datasetDir}/sparse_pc.ply`
    await Deno.writeFile(seedPlyPath, plyBytes)
  } catch {
    // no seed cloud — Brush will random-init inside the camera frustums
    seedPlyPath = undefined
  }

  const transforms: NerfstudioTransforms = {
    camera_model: 'PINHOLE',
    ci_source: {
      sessionId: sessionDir.split('/').filter(Boolean).pop() ?? '',
      frameCount: frames.length,
      generatedAt: new Date().toISOString(),
    },
    ...(seedPlyPath ? { ply_file_path: 'sparse_pc.ply' } : {}),
    frames,
  }

  const transformsPath = `${datasetDir}/transforms.json`
  await Deno.writeTextFile(transformsPath, JSON.stringify(transforms, null, 2))

  return {
    datasetDir,
    transformsPath,
    imagesDir,
    frameCount: frames.length,
    seedPlyPath,
    droppedFrames: dropped,
  }
}

/** Read + parse keyframes.jsonl in capture order. */
export async function readKeyframes(sessionDir: string): Promise<KeyframeRecord[]> {
  let raw: string
  try {
    raw = await Deno.readTextFile(`${sessionDir}/keyframes.jsonl`)
  } catch {
    return []
  }
  const out: KeyframeRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as KeyframeRecord)
    } catch {
      // skip malformed line
    }
  }
  out.sort((a, b) => {
    const ai = typeof a.index === 'number' ? a.index : Number.MAX_SAFE_INTEGER
    const bi = typeof b.index === 'number' ? b.index : Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    return (a.file ?? '').localeCompare(b.file ?? '')
  })
  return out
}

interface DerivedIntrinsics {
  flX: number
  flY: number
  cx: number
  cy: number
}

/**
 * Derive pinhole intrinsics in real pixel units.
 *
 * Precedence:
 *   1. Explicit `fx`/`fy` from the client, scaled by the recorded→actual
 *      pixel ratio when the recorded width/height differ from the JPEG.
 *   2. Vertical FOV → focal length: fl_y = h / (2·tan(fovY/2)); fl_x from
 *      the aspect ratio.
 *   3. A safe fallback of a ~55° vertical FOV.
 *
 * cx/cy default to the image centre unless the client supplied a principal
 * point (also scaled to actual pixels).
 */
export function deriveIntrinsics(
  intrinsics: NonNullable<KeyframeRecord['intrinsics']>,
  actualW: number,
  actualH: number,
): DerivedIntrinsics {
  const recW = numberOr(intrinsics.width, actualW)
  const recH = numberOr(intrinsics.height, actualH)
  const sx = recW > 0 ? actualW / recW : 1
  const sy = recH > 0 ? actualH / recH : 1

  let flX: number | null = null
  let flY: number | null = null
  if (isPositive(intrinsics.fx)) flX = intrinsics.fx! * sx
  if (isPositive(intrinsics.fy)) flY = intrinsics.fy! * sy

  if (flY === null) {
    const fovY = isPositive(intrinsics.fovYDeg) ? intrinsics.fovYDeg! : 55
    flY = actualH / (2 * Math.tan((fovY * Math.PI) / 180 / 2))
  }
  if (flX === null) {
    // Phone keyframes have square pixels (the FOV is vertical + the frame is a
    // uniform downscale), so fl_x == fl_y in focal-length pixel units.
    flX = flY
  }

  const cx = isPositive(intrinsics.cx) ? intrinsics.cx! * sx : actualW / 2
  const cy = isPositive(intrinsics.cy) ? intrinsics.cy! * sy : actualH / 2

  return { flX, flY, cx, cy }
}

/**
 * Build a row-major 4×4 camera-to-world matrix from a Companion-Scan pose.
 * The pose is already in the OpenGL/Blender convention, so the rotation
 * quaternion and translation drop straight in — no coordinate flip.
 */
export function poseToMatrix(pose: NonNullable<KeyframeRecord['pose']>): number[][] {
  const p = pose.position ?? {}
  const q = pose.rotation ?? {}
  const px = numberOr(p.x, 0)
  const py = numberOr(p.y, 0)
  const pz = numberOr(p.z, 0)

  let qx = numberOr(q.x, 0)
  let qy = numberOr(q.y, 0)
  let qz = numberOr(q.z, 0)
  let qw = numberOr(q.w, 1)
  // Normalise so a slightly-off quaternion still yields an orthonormal basis.
  const n = Math.hypot(qx, qy, qz, qw) || 1
  qx /= n
  qy /= n
  qz /= n
  qw /= n

  const xx = qx * qx, yy = qy * qy, zz = qz * qz
  const xy = qx * qy, xz = qx * qz, yz = qy * qz
  const wx = qw * qx, wy = qw * qy, wz = qw * qz

  const r00 = 1 - 2 * (yy + zz)
  const r01 = 2 * (xy - wz)
  const r02 = 2 * (xz + wy)
  const r10 = 2 * (xy + wz)
  const r11 = 1 - 2 * (xx + zz)
  const r12 = 2 * (yz - wx)
  const r20 = 2 * (xz - wy)
  const r21 = 2 * (yz + wx)
  const r22 = 1 - 2 * (xx + yy)

  return [
    [r00, r01, r02, px],
    [r10, r11, r12, py],
    [r20, r21, r22, pz],
    [0, 0, 0, 1],
  ]
}

/**
 * Extract (width, height) from a JPEG by scanning for the first Start-Of-Frame
 * marker. Returns null when the bytes are not a recognisable baseline/progressive
 * JPEG. Pure — no decoding, just header walking.
 */
export function readJpegDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  // SOI
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    // Every marker starts with 0xFF; skip fill bytes.
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    let marker = bytes[i + 1]
    // Skip padding 0xFF runs.
    while (marker === 0xff && i + 1 < bytes.length) {
      i++
      marker = bytes[i + 1]
    }
    i += 2
    // Standalone markers (no length): RSTn (D0-D7), SOI(D8), EOI(D9), TEM(01).
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    if (i + 1 >= bytes.length) break
    const segLen = (bytes[i] << 8) | bytes[i + 1]
    if (segLen < 2) return null
    // SOF markers: C0-CF except C4 (DHT), C8 (JPG), CC (DAC).
    const isSOF = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSOF) {
      // segment: [len(2)][precision(1)][height(2)][width(2)]…
      if (i + 6 >= bytes.length) return null
      const h = (bytes[i + 3] << 8) | bytes[i + 4]
      const w = (bytes[i + 5] << 8) | bytes[i + 6]
      if (w > 0 && h > 0) return { w, h }
      return null
    }
    i += segLen
  }
  return null
}

async function materialiseImage(
  srcPath: string,
  destPath: string,
  bytes: Uint8Array,
  mode: 'symlink' | 'copy',
): Promise<void> {
  // Idempotent: remove a stale dest first so re-runs don't fail on EEXIST.
  try {
    await Deno.remove(destPath)
  } catch {
    // not present
  }
  if (mode === 'symlink') {
    try {
      await Deno.symlink(srcPath, destPath)
      return
    } catch {
      // fall through to copy (cross-device, no symlink perms, etc.)
    }
  }
  await Deno.writeFile(destPath, bytes)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
