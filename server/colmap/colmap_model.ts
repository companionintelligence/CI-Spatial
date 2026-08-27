/**
 * Readers for COLMAP's binary sparse-model files.
 *
 * Parses `images.bin` (the per-image extrinsics), `points3D.bin` (the sparse
 * cloud used to seed Brush's splat init) and `cameras.bin` (the solved
 * intrinsics). `rigs.bin` and `frames.bin` are left alone — the rig/frame
 * tables carry nothing this path uses.
 *
 * **`cameras.bin` used to be skipped, on a premise that was false.** This
 * header previously read "intrinsics already come from the keyframe records via
 * `deriveIntrinsics`". They do not. `deriveIntrinsics`
 * (`server/splat/splat_train_dataset.ts`) has an `fx`/`fy`/`cx`/`cy` branch that
 * nothing ever populates: `src/capture/keyframes.ts` is the only writer of a
 * keyframe's `intrinsics` block and it writes `{fovYDeg, aspect, width, height,
 * sourceWidth, sourceHeight}` — verified against real captures on disk. So the
 * fx/fy path is dead code and every reconstruction silently fell back to
 * `fl = h / (2·tan(fovY/2))` with the principal point pinned at dead centre.
 *
 * That fallback is weaker than it looks:
 *   - `fovYDeg` describes the DISPLAY frustum, not the uploaded pixels. Under
 *     `?camerafit=cover` those differ, and `src/ar/eighthwall.ts`'s own header
 *     spells out the consequence — "the reconstruction bends geometry to fit a
 *     lens the camera does not have".
 *   - Both providers initialise `_fovY = 60`, so a frame captured before the
 *     first real projection carries a fabricated 60°.
 *   - A real phone lens is not perfectly centred, and `cx = w/2, cy = h/2`
 *     cannot express that.
 *
 * Meanwhile COLMAP is already solving the real thing: `colmap_poses.ts` runs
 * feature extraction with `--ImageReader.single_camera 1
 * --ImageReader.camera_model SIMPLE_RADIAL`, so it fits f, cx, cy and k1 to the
 * ACTUAL uploaded JPEGs and writes them here. Reading them back is strictly
 * better than deriving, and costs one more file parse.
 *
 * Convention note — this is the part that silently corrupts a reconstruction
 * if you get it wrong. COLMAP stores each image's pose as a quaternion +
 * translation that together form the **world-to-camera** transform in the
 * **OpenCV** axis convention (x-right, y-down, z-forward). That is byte-for-
 * byte the same convention `lingbot_map_worker.py` writes into
 * `lingbot-map.poses.json` under the (misleading) key `cameraToWorld` — see
 * the long comment on `openCvW2cToC2w` in splat_train_dataset.ts. Emitting
 * COLMAP poses in that same shape is therefore deliberate reuse of an
 * already-audited conversion, not a coincidence of field names.
 *
 * These parsers are pure (Uint8Array in, plain objects out) so they can be
 * unit-tested without COLMAP installed.
 */

/** One registered image's world-to-camera pose, in COLMAP's OpenCV convention. */
export interface ColmapImage {
  imageId: number
  /** Quaternion (w, x, y, z) of the world→camera rotation. */
  qvec: [number, number, number, number]
  /** Translation (x, y, z) of the world→camera transform. */
  tvec: [number, number, number]
  cameraId: number
  /** Image path relative to COLMAP's `--image_path` root. */
  name: string
}

/** One camera's solved intrinsics, in pixels, for the image size COLMAP saw. */
export interface ColmapCamera {
  cameraId: number
  /** COLMAP's numeric model id, kept so an unexpected model is reportable. */
  modelId: number
  width: number
  height: number
  /** Focal length in pixels, x and y. Equal for the single-focal models. */
  fx: number
  fy: number
  /** Principal point in pixels — the whole reason to prefer this over w/2, h/2. */
  cx: number
  cy: number
}

/**
 * How to read each COLMAP camera model's `params` array.
 *
 * Ids and orders are COLMAP's own (`src/colmap/sensor/models.h`). Only the
 * models a phone capture can realistically produce are mapped; anything else
 * returns null and the caller falls back to `deriveIntrinsics` rather than
 * guessing at an unfamiliar parameterisation. SIMPLE_RADIAL (2) is what
 * `colmap_poses.ts` actually requests.
 */
const CAMERA_MODELS: Record<number, { name: string; params: number; read: (p: number[]) => { fx: number; fy: number; cx: number; cy: number } }> = {
  0: { name: 'SIMPLE_PINHOLE', params: 3, read: (p) => ({ fx: p[0]!, fy: p[0]!, cx: p[1]!, cy: p[2]! }) },
  1: { name: 'PINHOLE', params: 4, read: (p) => ({ fx: p[0]!, fy: p[1]!, cx: p[2]!, cy: p[3]! }) },
  2: { name: 'SIMPLE_RADIAL', params: 4, read: (p) => ({ fx: p[0]!, fy: p[0]!, cx: p[1]!, cy: p[2]! }) },
  3: { name: 'RADIAL', params: 5, read: (p) => ({ fx: p[0]!, fy: p[0]!, cx: p[1]!, cy: p[2]! }) },
  4: { name: 'OPENCV', params: 8, read: (p) => ({ fx: p[0]!, fy: p[1]!, cx: p[2]!, cy: p[3]! }) },
}

/** The number of `params` doubles COLMAP writes for a model id, or null if unknown. */
export function colmapCameraModelParamCount(modelId: number): number | null {
  return CAMERA_MODELS[modelId]?.params ?? null
}

/**
 * Parse `cameras.bin`.
 *
 * Layout (little-endian), per COLMAP's `ReadCamerasBinary`:
 *   u64                  number of cameras
 *   repeated:
 *     u32                camera_id
 *     i32                model_id
 *     u64                width
 *     u64                height
 *     f64 × num_params   model-specific parameters
 *
 * An unknown model id cannot be skipped safely — its parameter count is what
 * tells us where the next record starts — so parsing stops there and returns
 * what it has, rather than walking off into misaligned bytes and inventing
 * plausible-looking focal lengths.
 */
export function parseCamerasBin(buf: Uint8Array): ColmapCamera[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  const count = Number(dv.getBigUint64(o, true))
  o += 8

  const out: ColmapCamera[] = []
  for (let i = 0; i < count; i++) {
    const cameraId = dv.getUint32(o, true)
    o += 4
    const modelId = dv.getInt32(o, true)
    o += 4
    const width = Number(dv.getBigUint64(o, true))
    o += 8
    const height = Number(dv.getBigUint64(o, true))
    o += 8

    const model = CAMERA_MODELS[modelId]
    if (!model) break

    const params: number[] = []
    for (let p = 0; p < model.params; p++) {
      params.push(dv.getFloat64(o, true))
      o += 8
    }
    const { fx, fy, cx, cy } = model.read(params)
    out.push({ cameraId, modelId, width, height, fx, fy, cx, cy })
  }
  return out
}

/** One triangulated point from the sparse cloud. */
export interface ColmapPoint3D {
  xyz: [number, number, number]
  rgb: [number, number, number]
  error: number
  trackLength: number
}

/**
 * Parse `images.bin`.
 *
 * Layout (little-endian), per COLMAP's `ReadImagesBinary`:
 *   u64                        number of registered images
 *   repeated:
 *     i32                      image_id
 *     f64 × 4                  qw qx qy qz
 *     f64 × 3                  tx ty tz
 *     i32                      camera_id
 *     char*                    name, NUL-terminated
 *     u64                      num_points2D
 *     (f64, f64, u64) × N      x, y, point3D_id   — skipped, 24 bytes each
 */
export function parseImagesBin(buf: Uint8Array): ColmapImage[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  const count = Number(dv.getBigUint64(o, true))
  o += 8

  const out: ColmapImage[] = []
  for (let i = 0; i < count; i++) {
    const imageId = dv.getInt32(o, true)
    o += 4
    const qvec: [number, number, number, number] = [
      dv.getFloat64(o, true),
      dv.getFloat64(o + 8, true),
      dv.getFloat64(o + 16, true),
      dv.getFloat64(o + 24, true),
    ]
    o += 32
    const tvec: [number, number, number] = [
      dv.getFloat64(o, true),
      dv.getFloat64(o + 8, true),
      dv.getFloat64(o + 16, true),
    ]
    o += 24
    const cameraId = dv.getInt32(o, true)
    o += 4

    // NUL-terminated name. Decoded as UTF-8 rather than latin-1 because
    // COLMAP passes the filesystem path through unchanged.
    const start = o
    while (o < buf.length && buf[o] !== 0) o++
    const name = new TextDecoder().decode(buf.subarray(start, o))
    o++ // consume the NUL

    const numPoints2D = Number(dv.getBigUint64(o, true))
    o += 8
    o += numPoints2D * 24 // (x, y, point3D_id) — not needed here

    out.push({ imageId, qvec, tvec, cameraId, name })
  }
  return out
}

/**
 * Parse `points3D.bin`.
 *
 * Layout (little-endian), per COLMAP's `ReadPoints3DBinary`:
 *   u64                    number of points
 *   repeated:
 *     u64                  point3D_id
 *     f64 × 3              x y z
 *     u8 × 3               r g b
 *     f64                  reprojection error
 *     u64                  track length
 *     (i32, i32) × N       image_id, point2D_idx — skipped, 8 bytes each
 */
export function parsePoints3DBin(buf: Uint8Array): ColmapPoint3D[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  const count = Number(dv.getBigUint64(o, true))
  o += 8

  const out: ColmapPoint3D[] = []
  for (let i = 0; i < count; i++) {
    o += 8 // point3D_id
    const xyz: [number, number, number] = [
      dv.getFloat64(o, true),
      dv.getFloat64(o + 8, true),
      dv.getFloat64(o + 16, true),
    ]
    o += 24
    const rgb: [number, number, number] = [buf[o], buf[o + 1], buf[o + 2]]
    o += 3
    const error = dv.getFloat64(o, true)
    o += 8
    const trackLength = Number(dv.getBigUint64(o, true))
    o += 8
    o += trackLength * 8 // track entries

    out.push({ xyz, rgb, error, trackLength })
  }
  return out
}


/**
 * Estimate the world-space "up" direction of a COLMAP reconstruction from its
 * camera orientations.
 *
 * Structure-from-motion has no gravity reference — the world frame is whatever
 * the initial image pair happened to establish, so a reconstruction comes out
 * tilted at an arbitrary angle and a viewer that assumes Y-up renders the room
 * on its side. Brush notices the same thing and records its own guess in the
 * exported PLY (`comment Vertical axis: …`), which on the reference capture
 * came out as roughly -X.
 *
 * The estimate here uses the one gravity cue the capture actually carries: a
 * handheld phone is held roughly upright, and in COLMAP's OpenCV convention a
 * camera's +Y axis points *down* in its own image. The rows of the
 * world-to-camera rotation are the camera's basis vectors expressed in world
 * coordinates, so row 1 of each R is that camera's down-vector in world space.
 * Averaging over every registered view cancels the per-shot tilt and leaves
 * gravity.
 *
 * Returns null when the cameras disagree too much for the mean to mean
 * anything — a pathological capture (all views pointing at the ceiling, or two
 * frames at right angles) should be left alone rather than confidently rotated
 * to the wrong orientation.
 */
export function estimateUpAxis(images: ColmapImage[]): [number, number, number] | null {
  if (images.length < 3) return null
  let dx = 0, dy = 0, dz = 0
  for (const img of images) {
    const [w, x, y, z] = img.qvec
    // Row 1 of the world-to-camera rotation = camera +Y (down) in world space.
    dx += 2 * x * y + 2 * z * w
    dy += 1 - 2 * x * x - 2 * z * z
    dz += 2 * y * z - 2 * x * w
  }
  const n = images.length
  dx /= n; dy /= n; dz /= n
  const len = Math.hypot(dx, dy, dz)
  // A short mean vector means the per-camera down-vectors largely cancelled,
  // i.e. the views point in wildly different directions and no consistent
  // gravity direction can be read off them.
  if (len < 0.5) return null
  return [-dx / len, -dy / len, -dz / len]
}

/**
 * Rotation matrix taking unit vector `from` onto unit vector `to`, via
 * Rodrigues' formula around their cross product. Falls back to identity when
 * they already agree, and to a 180° flip about any perpendicular axis when
 * they are opposed (where the cross product vanishes and the axis is
 * genuinely undetermined).
 */
export function rotationBetween(
  from: [number, number, number],
  to: [number, number, number],
): number[][] {
  const [ax, ay, az] = from
  const [bx, by, bz] = to
  const dot = ax * bx + ay * by + az * bz
  if (dot > 0.999999) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  if (dot < -0.999999) {
    // Antiparallel: pick any axis perpendicular to `from` and rotate 180°.
    const perp: [number, number, number] = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    let px = ay * perp[2] - az * perp[1]
    let py = az * perp[0] - ax * perp[2]
    let pz = ax * perp[1] - ay * perp[0]
    const pl = Math.hypot(px, py, pz)
    px /= pl; py /= pl; pz /= pl
    return [
      [2 * px * px - 1, 2 * px * py, 2 * px * pz],
      [2 * px * py, 2 * py * py - 1, 2 * py * pz],
      [2 * px * pz, 2 * py * pz, 2 * pz * pz - 1],
    ]
  }
  const vx = ay * bz - az * by
  const vy = az * bx - ax * bz
  const vz = ax * by - ay * bx
  const c = 1 / (1 + dot)
  // I + [v]x + [v]x^2 * c
  return [
    [1 - (vy * vy + vz * vz) * c, -vz + vx * vy * c, vy + vx * vz * c],
    [vz + vx * vy * c, 1 - (vx * vx + vz * vz) * c, -vx + vy * vz * c],
    [-vy + vx * vz * c, vx + vy * vz * c, 1 - (vx * vx + vy * vy) * c],
  ]
}

/** Rotate a world point by `Q` (row-major 3x3). */
export function rotatePoint(Q: number[][], p: [number, number, number]): [number, number, number] {
  return [
    Q[0][0] * p[0] + Q[0][1] * p[1] + Q[0][2] * p[2],
    Q[1][0] * p[0] + Q[1][1] * p[1] + Q[1][2] * p[2],
    Q[2][0] * p[0] + Q[2][1] * p[1] + Q[2][2] * p[2],
  ]
}

/**
 * Re-express a world-to-camera pose in a world frame that has been rotated by
 * `Q`.
 *
 * With `x_cam = R·p + t` and a new world `p' = Q·p`, substituting `p = Qᵀ·p'`
 * gives `x_cam = (R·Qᵀ)·p' + t` — so the rotation composes on the right and the
 * translation is untouched. Getting that backwards silently mis-orients every
 * camera while leaving the point cloud correct, which is very hard to see.
 */
export function rotateImagePose(Q: number[][], img: ColmapImage): ColmapImage {
  const [w, x, y, z] = img.qvec
  const R = [
    [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
    [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
    [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
  ]
  // R' = R · Qᵀ
  const Rp = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    R[i][0] * Q[j][0] + R[i][1] * Q[j][1] + R[i][2] * Q[j][2]
  ))
  return { ...img, qvec: rotationToQuat(Rp), tvec: img.tvec }
}

/** Rotation matrix -> (w, x, y, z) quaternion, via the numerically stable branch form. */
export function rotationToQuat(R: number[][]): [number, number, number, number] {
  const tr = R[0][0] + R[1][1] + R[2][2]
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    return [s / 4, (R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s]
  }
  if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2
    return [(R[2][1] - R[1][2]) / s, s / 4, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s]
  }
  if (R[1][1] > R[2][2]) {
    const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2
    return [(R[0][2] - R[2][0]) / s, (R[0][1] + R[1][0]) / s, s / 4, (R[1][2] + R[2][1]) / s]
  }
  const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2
  return [(R[1][0] - R[0][1]) / s, (R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, s / 4]
}

/**
 * Serialise points as a binary little-endian PLY with xyz + uchar rgb.
 *
 * Matches the shape `buildBrushDataset` already accepts as `sparse_pc.ply`
 * (Brush's PLY importer treats a plain coloured cloud as SfM init), so the
 * COLMAP cloud drops into the same slot LingBot-Map's cloud occupies.
 */
export function pointsToPly(points: ColmapPoint3D[]): Uint8Array {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element vertex ${points.length}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    'end_header\n'
  const headerBytes = new TextEncoder().encode(header)

  const stride = 15 // 3 × f32 + 3 × u8
  const body = new Uint8Array(points.length * stride)
  const dv = new DataView(body.buffer)
  points.forEach((p, i) => {
    const o = i * stride
    dv.setFloat32(o, p.xyz[0], true)
    dv.setFloat32(o + 4, p.xyz[1], true)
    dv.setFloat32(o + 8, p.xyz[2], true)
    body[o + 12] = p.rgb[0]
    body[o + 13] = p.rgb[1]
    body[o + 14] = p.rgb[2]
  })

  const out = new Uint8Array(headerBytes.length + body.length)
  out.set(headerBytes, 0)
  out.set(body, headerBytes.length)
  return out
}

/**
 * Build the `poses.json` payload from parsed COLMAP images.
 *
 * `cameraToWorld` carries the 3×4 world-to-camera [R|t] matrix — the same
 * OpenCV convention (and the same misleading key name) that
 * `lingbot-map.poses.json` uses, so a single reader and a single conversion
 * serve both producers. `name` is reduced to its basename because COLMAP
 * paths are relative to its own image root, while the dataset builder keys
 * frames by the bare `kf-NNNNN.jpg` filename.
 */
export function buildPosesJson(images: ColmapImage[], tool = 'colmap', camera?: ColmapCamera): {
  tool: string
  camera?: { fx: number; fy: number; cx: number; cy: number; width: number; height: number }
  frames: Array<{ file: string; cameraToWorld: number[][] }>
} {
  const frames = images.map((img) => {
    const [w, x, y, z] = img.qvec
    // Quaternion → rotation matrix (world→camera), COLMAP's `QuaternionToRotationMatrix`.
    const R = [
      [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
      [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
      [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
    ]
    return {
      file: img.name.split('/').pop() ?? img.name,
      cameraToWorld: [
        [R[0][0], R[0][1], R[0][2], img.tvec[0]],
        [R[1][0], R[1][1], R[1][2], img.tvec[1]],
        [R[2][0], R[2][1], R[2][2], img.tvec[2]],
      ],
    }
  })
  // The solved intrinsics ride along with the poses deliberately: they were fit
  // to these exact images, in this exact model, so splitting them into a second
  // sidecar would let a consumer pair one solver's poses with another's lens.
  // Omitted entirely when COLMAP gave us nothing usable, so a reader can tell
  // "not solved" from "solved as zero".
  return camera
    ? {
      tool,
      camera: { fx: camera.fx, fy: camera.fy, cx: camera.cx, cy: camera.cy, width: camera.width, height: camera.height },
      frames,
    }
    : { tool, frames }
}
