/**
 * Readers for COLMAP's binary sparse-model files.
 *
 * Only the two files the pose pipeline needs are parsed — `images.bin` (the
 * per-image extrinsics) and `points3D.bin` (the sparse cloud used to seed
 * Brush's splat init). `cameras.bin`, `rigs.bin` and `frames.bin` are left
 * alone: intrinsics already come from the keyframe records via
 * `deriveIntrinsics`, and the rig/frame tables carry nothing this path uses.
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
export function buildPosesJson(images: ColmapImage[], tool = 'colmap'): {
  tool: string
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
  return { tool, frames }
}
