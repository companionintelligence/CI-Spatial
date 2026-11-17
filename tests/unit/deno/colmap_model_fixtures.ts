/**
 * Encoders for the binary files a stubbed COLMAP writes, and a JPEG header the size reader accepts. Shared by the
 * joint-solve and golden tests (colmap_joint.test.ts); not a test file, which Deno only runs when it is named
 * `*.test.ts`.
 *
 * These write the layouts `parseImagesBin`, `parseCamerasBin` and `parsePoints3DBin` read, which are COLMAP's own
 * (server/colmap/colmap_model.ts). They are the same shapes colmap_poses.test.ts encodes for its own stubs; that file
 * keeps its private copies so it is not edited for a new feature.
 */

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** One registered image: id, world-to-camera quaternion (w, x, y, z) and translation, camera id, name. */
export interface StubImage {
  id: number
  q: number[]
  t: number[]
  cam: number
  name: string
}

export function encodeImagesBin(entries: StubImage[]): Uint8Array {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setBigUint64(0, BigInt(entries.length), true)
  const parts: Uint8Array[] = [head]
  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name)
    const buf = new Uint8Array(4 + 32 + 24 + 4 + nameBytes.length + 1 + 8)
    const dv = new DataView(buf.buffer)
    let o = 0
    dv.setInt32(o, e.id, true); o += 4
    for (const v of e.q) { dv.setFloat64(o, v, true); o += 8 }
    for (const v of e.t) { dv.setFloat64(o, v, true); o += 8 }
    dv.setInt32(o, e.cam, true); o += 4
    buf.set(nameBytes, o); o += nameBytes.length
    buf[o] = 0; o += 1
    dv.setBigUint64(o, 0n, true)
    parts.push(buf)
  }
  return concat(parts)
}

/** One SIMPLE_RADIAL camera (model id 2): `params` is `[f, cx, cy, k]`. */
export interface StubCamera {
  id: number
  w: number
  h: number
  params: number[]
}

export function encodeCamerasBin(cameras: StubCamera[]): Uint8Array {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setBigUint64(0, BigInt(cameras.length), true)
  const parts: Uint8Array[] = [head]
  for (const c of cameras) {
    const buf = new Uint8Array(4 + 4 + 8 + 8 + c.params.length * 8)
    const dv = new DataView(buf.buffer)
    let o = 0
    dv.setUint32(o, c.id, true); o += 4
    dv.setInt32(o, 2, true); o += 4
    dv.setBigUint64(o, BigInt(c.w), true); o += 8
    dv.setBigUint64(o, BigInt(c.h), true); o += 8
    for (const p of c.params) { dv.setFloat64(o, p, true); o += 8 }
    parts.push(buf)
  }
  return concat(parts)
}

/** `n` points with empty tracks and a reprojection error of `error` each. */
export function encodePoints3DBin(n: number, error = 0.5): Uint8Array {
  const rec = 8 + 24 + 3 + 8 + 8
  const buf = new Uint8Array(8 + n * rec)
  const dv = new DataView(buf.buffer)
  dv.setBigUint64(0, BigInt(n), true)
  for (let i = 0; i < n; i++) {
    let o = 8 + i * rec
    dv.setBigUint64(o, BigInt(i + 1), true); o += 8
    dv.setFloat64(o, i * 0.01, true); dv.setFloat64(o + 8, (i % 7) * 0.1, true); dv.setFloat64(o + 16, (i % 5) * 0.2, true); o += 24
    buf[o] = 128; buf[o + 1] = 64 + (i % 50); buf[o + 2] = 200; o += 3
    dv.setFloat64(o, error, true); o += 8
    dv.setBigUint64(o, 0n, true)
  }
  return buf
}

/**
 * The first bytes of a baseline JPEG: start of image, a start-of-frame segment naming `width` x `height`, end of image.
 * `readJpegDimensions` reads exactly this much, so a stub frame can carry the size the driver reads without being a
 * picture. `salt` makes two frames differ in content without changing their size.
 */
export function jpegHeader(width: number, height: number, salt = 0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
    salt & 0xff,
  ])
}

/** The unit quaternion (w, x, y, z) for a turn of `deg` degrees about +Y. */
export function quatAboutY(deg: number): number[] {
  const half = (deg * Math.PI) / 360
  return [Math.cos(half), 0, Math.sin(half), 0]
}
