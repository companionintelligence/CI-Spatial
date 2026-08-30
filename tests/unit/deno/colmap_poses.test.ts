/**
 * Deno unit tests for the COLMAP pose-solver surface.
 *
 * COLMAP itself is an external binary that CI does not install, so — like
 * splat_train.test.ts — these cover the TS side only: the binary-model
 * parsers, the pose-format conversion that lets one reader serve both COLMAP
 * and LingBot-Map, PLY serialisation, and the "binary missing → skipped
 * manifest" fallback the world-job coordinator depends on.
 *
 * The parsers are the part worth testing hard: they read little-endian binary
 * laid out by another program, so a silent offset error would surface far
 * downstream as a subtly wrong reconstruction rather than as a crash.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'

import {
  buildPosesJson,
  estimateUpAxis,
  colmapCameraModelParamCount,
  parseCamerasBin,
  parseImagesBin,
  parsePoints3DBin,
  pointsToPly,
  rotateImagePose,
  rotatePoint,
  rotationBetween,
  rotationToQuat,
} from '../../../server/colmap/colmap_model.ts'
import {
  assessColmapQuality,
  DEFAULT_MIN_POINTS_3D,
  DEFAULT_MIN_REGISTRATION_RATIO,
  degenerateRemediation,
  isValidSessionDir,
  resolveParams,
  resolveQualityThresholds,
  runColmapPoses,
} from '../../../server/colmap/colmap_poses.ts'
import { deriveIntrinsics, openCvW2cToC2w, POSE_SOURCES, readSolvedCamera, SEED_CLOUDS } from '../../../server/splat/splat_train_dataset.ts'

/** Encode one images.bin record the way COLMAP's writer lays it out. */
function encodeImagesBin(
  entries: Array<{ id: number; q: number[]; t: number[]; cam: number; name: string; nPts?: number }>,
): Uint8Array {
  const parts: Uint8Array[] = []
  const head = new Uint8Array(8)
  new DataView(head.buffer).setBigUint64(0, BigInt(entries.length), true)
  parts.push(head)

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name)
    const nPts = e.nPts ?? 0
    const buf = new Uint8Array(4 + 32 + 24 + 4 + nameBytes.length + 1 + 8 + nPts * 24)
    const dv = new DataView(buf.buffer)
    let o = 0
    dv.setInt32(o, e.id, true); o += 4
    for (const v of e.q) { dv.setFloat64(o, v, true); o += 8 }
    for (const v of e.t) { dv.setFloat64(o, v, true); o += 8 }
    dv.setInt32(o, e.cam, true); o += 4
    buf.set(nameBytes, o); o += nameBytes.length
    buf[o] = 0; o += 1
    dv.setBigUint64(o, BigInt(nPts), true)
    parts.push(buf)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

Deno.test('parseImagesBin round-trips ids, pose, and name', () => {
  const bytes = encodeImagesBin([
    { id: 7, q: [1, 0, 0, 0], t: [1, 2, 3], cam: 1, name: 'kf-00000.jpg' },
    // A trailing points2D block must be skipped, not misread as the next record.
    { id: 9, q: [0, 1, 0, 0], t: [4, 5, 6], cam: 1, name: 'sub/kf-00001.jpg', nPts: 3 },
  ])
  const imgs = parseImagesBin(bytes)
  assertEquals(imgs.length, 2)
  assertEquals(imgs[0].imageId, 7)
  assertEquals(imgs[0].name, 'kf-00000.jpg')
  assertEquals(imgs[0].tvec, [1, 2, 3])
  assertEquals(imgs[1].name, 'sub/kf-00001.jpg')
  assertEquals(imgs[1].qvec, [0, 1, 0, 0])
})

Deno.test('parseImagesBin handles an empty model', () => {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setBigUint64(0, 0n, true)
  assertEquals(parseImagesBin(head).length, 0)
})

Deno.test('parsePoints3DBin reads xyz/rgb and skips tracks', () => {
  const trackLen = 2
  const buf = new Uint8Array(8 + (8 + 24 + 3 + 8 + 8 + trackLen * 8))
  const dv = new DataView(buf.buffer)
  let o = 0
  dv.setBigUint64(o, 1n, true); o += 8
  dv.setBigUint64(o, 42n, true); o += 8
  dv.setFloat64(o, 1.5, true); dv.setFloat64(o + 8, -2.5, true); dv.setFloat64(o + 16, 3.5, true); o += 24
  buf[o] = 10; buf[o + 1] = 20; buf[o + 2] = 30; o += 3
  dv.setFloat64(o, 0.42, true); o += 8
  dv.setBigUint64(o, BigInt(trackLen), true)

  const pts = parsePoints3DBin(buf)
  assertEquals(pts.length, 1)
  assertEquals(pts[0].xyz, [1.5, -2.5, 3.5])
  assertEquals(pts[0].rgb, [10, 20, 30])
  assertEquals(pts[0].trackLength, trackLen)
})

Deno.test('pointsToPly writes a parseable binary header and body', () => {
  const ply = pointsToPly([
    { xyz: [1, 2, 3], rgb: [255, 0, 0], error: 0, trackLength: 2 },
    { xyz: [4, 5, 6], rgb: [0, 255, 0], error: 0, trackLength: 2 },
  ])
  const text = new TextDecoder().decode(ply.subarray(0, 200))
  assert(text.startsWith('ply\n'))
  assert(text.includes('element vertex 2'))
  assert(text.includes('format binary_little_endian 1.0'))

  const headerEnd = text.indexOf('end_header\n') + 'end_header\n'.length
  assertEquals(ply.length - headerEnd, 2 * 15) // 3×f32 + 3×u8 per vertex
  const dv = new DataView(ply.buffer, ply.byteOffset + headerEnd)
  assertEquals(dv.getFloat32(0, true), 1)
  assertEquals(ply[headerEnd + 12], 255)
})

Deno.test('buildPosesJson emits the shared OpenCV w2c shape, keyed by basename', () => {
  // Identity rotation, translation (1,2,3): the camera sits at -t in world space.
  const out = buildPosesJson([
    { imageId: 1, qvec: [1, 0, 0, 0], tvec: [1, 2, 3], cameraId: 1, name: 'images/kf-00000.jpg' },
  ])
  assertEquals(out.tool, 'colmap')
  assertEquals(out.frames[0].file, 'kf-00000.jpg', 'COLMAP paths are relative to its own image root')
  assertEquals(out.frames[0].cameraToWorld.length, 3)
  assertEquals(out.frames[0].cameraToWorld[0], [1, 0, 0, 1])
})

Deno.test('COLMAP poses convert through the same reader LingBot-Map uses', () => {
  // The whole point of matching formats (ADR 0001): buildPosesJson's output
  // must be consumable by the converter written for lingbot-map.poses.json.
  const { frames } = buildPosesJson([
    { imageId: 1, qvec: [1, 0, 0, 0], tvec: [1, 2, 3], cameraId: 1, name: 'kf-00000.jpg' },
  ])
  const c2w = openCvW2cToC2w(frames[0].cameraToWorld)
  assert(c2w, 'shared converter must accept a COLMAP-produced pose')
  // Inverting an identity-rotation w2c puts the camera centre at -t, and the
  // OpenCV→OpenGL axis flip negates the Y and Z basis columns.
  assertEquals(c2w![0], [1, -0, -0, -1])
  assertEquals(c2w![1][3], -2)
  assertEquals(c2w![2][3], -3)
  assertEquals(c2w![3], [0, 0, 0, 1])
})

Deno.test('pose sources and seed clouds stay aligned', () => {
  // A mismatch here would seed the splat in a different world frame than the
  // cameras it is trained against — silent, and visually catastrophic.
  assertEquals(POSE_SOURCES.length, SEED_CLOUDS.length)
  assertEquals(POSE_SOURCES[0].split('.')[0], SEED_CLOUDS[0].split('.')[0])
  assertEquals(POSE_SOURCES[1].split('.')[0], SEED_CLOUDS[1].split('.')[0])
})

Deno.test('isValidSessionDir accepts server ids and rejects traversal', () => {
  assert(isValidSessionDir('/scans/sessions/sess-photo-20260824-192434'))
  assert(!isValidSessionDir('/scans/sessions/local-123'))
  assert(!isValidSessionDir('/scans/sessions/..'))
})

Deno.test('resolveParams honours env overrides', () => {
  const prev = Deno.env.get('COLMAP_BIN')
  try {
    Deno.env.set('COLMAP_BIN', '/opt/colmap/bin/colmap')
    assertEquals(resolveParams({ sessionDir: '/x' }).colmapBin, '/opt/colmap/bin/colmap')
    // An explicit option still beats the env var.
    assertEquals(resolveParams({ sessionDir: '/x', colmapBin: '/other' }).colmapBin, '/other')
  } finally {
    if (prev === undefined) Deno.env.delete('COLMAP_BIN')
    else Deno.env.set('COLMAP_BIN', prev)
  }
})

Deno.test('a missing COLMAP binary is a skip, not a failure', async () => {
  const dir = await Deno.makeTempDir()
  const sessionDir = `${dir}/sess-photo-test`
  await Deno.mkdir(sessionDir)
  try {
    const r = await runColmapPoses({ sessionDir, colmapBin: `${dir}/definitely-not-here` })
    assertEquals(r.status, 'skipped', 'an absent optional tool must not fail the job')
    assertEquals(r.exitCode, 0)
    assert(r.manifest.remediation, 'a skip must tell the operator how to fix it')
    // The manifest is written even on skip — the coordinator relies on that.
    const written = JSON.parse(await Deno.readTextFile(`${sessionDir}/colmap-poses.manifest.json`))
    assertEquals(written.status, 'skipped')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a session with too few keyframes skips with a capture hint', async () => {
  const dir = await Deno.makeTempDir()
  const sessionDir = `${dir}/sess-photo-thin`
  await Deno.mkdir(sessionDir)
  await Deno.writeFile(`${sessionDir}/kf-00000.jpg`, new Uint8Array([0xff, 0xd8]))
  try {
    // _spawn asserts COLMAP is never reached: the guard must fire first.
    const r = await runColmapPoses({
      sessionDir,
      colmapBin: Deno.execPath(),
      _spawn: () => {
        throw new Error('COLMAP must not be spawned for a too-thin session')
      },
    })
    assertEquals(r.status, 'skipped')
    assert(r.manifest.skippedReason?.includes('at least 3'))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

// ─── Gravity alignment ────────────────────────────────────────────────────────
// SfM has no gravity reference, so these rotations decide whether a room
// renders upright or on its side. A sign error here is invisible in every
// other test and only shows up as a wrong-looking splat, so check the algebra.

const norm = (v: number[]) => Math.hypot(...v)
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

Deno.test('rotationBetween maps `from` onto `to`', () => {
  const cases: Array<[[number, number, number], [number, number, number]]> = [
    [[-1, 0, 0], [0, 1, 0]],
    [[0, 0, 1], [0, 1, 0]],
    [[0.577, 0.577, 0.577], [0, 1, 0]],
  ]
  for (const [from, to] of cases) {
    const f = from.map((v) => v / norm(from)) as [number, number, number]
    const got = rotatePoint(rotationBetween(f, to), f)
    got.forEach((v, i) => assert(close(v, to[i], 1e-6), `axis ${i}: ${v} vs ${to[i]}`))
  }
})

Deno.test('rotationBetween handles the identity and antiparallel corner cases', () => {
  const id = rotationBetween([0, 1, 0], [0, 1, 0])
  assertEquals(id, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  // Antiparallel: the cross product vanishes and the axis is undetermined, so
  // the only thing that must hold is that the vector actually ends up flipped.
  const flipped = rotatePoint(rotationBetween([0, -1, 0], [0, 1, 0]), [0, -1, 0])
  assert(close(flipped[1], 1, 1e-6), `expected +Y, got ${flipped.join(',')}`)
})

Deno.test('rotationToQuat round-trips through all four branches', () => {
  // One matrix per branch of the stable quaternion extraction.
  const mats = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],            // trace > 0
    [[1, 0, 0], [0, -1, 0], [0, 0, -1]],          // R00 dominant
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],          // R11 dominant
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],          // R22 dominant
  ]
  for (const R of mats) {
    const q = rotationToQuat(R)
    assert(close(norm(q), 1, 1e-6), `quaternion not unit: ${q.join(',')}`)
  }
})

Deno.test('estimateUpAxis recovers gravity from upright cameras', () => {
  // Identity rotation => camera +Y (down in OpenCV) is world +Y, so world "up"
  // must come back as -Y.
  const imgs = [0, 1, 2, 3].map((i) => ({
    imageId: i, qvec: [1, 0, 0, 0] as [number, number, number, number],
    tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: `kf-0000${i}.jpg`,
  }))
  const up = estimateUpAxis(imgs)
  assert(up, 'consistent cameras must yield an up estimate')
  assertEquals(up!.map((v) => Math.round(v)), [-0, -1, -0])
})

Deno.test('estimateUpAxis declines when cameras disagree', () => {
  // Too few views to average, and mutually cancelling views, must both bail
  // rather than confidently rotate the scene to a wrong orientation.
  assertEquals(estimateUpAxis([]), null)
  const opposed = [
    { imageId: 1, qvec: [1, 0, 0, 0] as [number, number, number, number], tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: 'a.jpg' },
    { imageId: 2, qvec: [0, 0, 0, 1] as [number, number, number, number], tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: 'b.jpg' },
    { imageId: 3, qvec: [1, 0, 0, 0] as [number, number, number, number], tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: 'c.jpg' },
    { imageId: 4, qvec: [0, 0, 0, 1] as [number, number, number, number], tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: 'd.jpg' },
  ]
  assertEquals(estimateUpAxis(opposed), null, 'cancelling down-vectors carry no gravity signal')
})

Deno.test('rotating the world keeps cameras and points in the same frame', () => {
  // The whole point of rotating poses and points together: a point in front of
  // a camera must still be in front of it afterwards. Composing the rotation on
  // the wrong side leaves the cloud right and every camera wrong.
  const img = {
    imageId: 1, qvec: [1, 0, 0, 0] as [number, number, number, number],
    tvec: [0, 0, 0] as [number, number, number], cameraId: 1, name: 'kf-00000.jpg',
  }
  const world: [number, number, number] = [0, 0, 5] // 5m down the camera axis
  const Q = rotationBetween([-1, 0, 0], [0, 1, 0])

  const rotImg = rotateImagePose(Q, img)
  const rotPt = rotatePoint(Q, world)

  // Project through the rotated pose and compare with the original camera-space
  // coordinate (identity R, zero t => camera space == world space).
  const [w, x, y, z] = rotImg.qvec
  const R = [
    [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
    [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
    [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
  ]
  const cam = rotatePoint(R, rotPt)
  cam.forEach((v, i) => assert(close(v, world[i], 1e-6), `axis ${i}: ${v} vs ${world[i]}`))
})

/** Encode one cameras.bin record the way COLMAP's writer lays it out. */
function encodeCamerasBin(
  entries: Array<{ id: number; model: number; w: number; h: number; params: number[] }>,
): Uint8Array {
  const parts: Uint8Array[] = []
  const head = new Uint8Array(8)
  new DataView(head.buffer).setBigUint64(0, BigInt(entries.length), true)
  parts.push(head)

  for (const e of entries) {
    const rec = new Uint8Array(4 + 4 + 8 + 8 + e.params.length * 8)
    const dv = new DataView(rec.buffer)
    let o = 0
    dv.setUint32(o, e.id, true); o += 4
    dv.setInt32(o, e.model, true); o += 4
    dv.setBigUint64(o, BigInt(e.w), true); o += 8
    dv.setBigUint64(o, BigInt(e.h), true); o += 8
    for (const v of e.params) { dv.setFloat64(o, v, true); o += 8 }
    parts.push(rec)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

Deno.test('parseCamerasBin reads SIMPLE_RADIAL — the model colmap_poses actually requests', () => {
  // colmap_poses.ts passes --ImageReader.camera_model SIMPLE_RADIAL, whose
  // params are [f, cx, cy, k1]: one focal length shared by both axes.
  const bytes = encodeCamerasBin([{ id: 1, model: 2, w: 720, h: 960, params: [812.5, 358.1, 483.7, -0.021] }])
  const cams = parseCamerasBin(bytes)
  assertEquals(cams.length, 1)
  assertEquals(cams[0].fx, 812.5)
  assertEquals(cams[0].fy, 812.5)
  assertEquals(cams[0].width, 720)
  assertEquals(cams[0].height, 960)
  // The whole point of reading this file: a principal point that is NOT w/2, h/2.
  assert(cams[0].cx !== 360)
  assert(cams[0].cy !== 480)
})

Deno.test('parseCamerasBin reads PINHOLE with independent fx/fy', () => {
  const bytes = encodeCamerasBin([{ id: 3, model: 1, w: 1280, h: 720, params: [900, 910, 640, 360] }])
  const cams = parseCamerasBin(bytes)
  assertEquals(cams[0].fx, 900)
  assertEquals(cams[0].fy, 910)
  assertEquals(cams[0].cameraId, 3)
})

Deno.test('parseCamerasBin walks multiple records of differing models', () => {
  // Each model has a different params length, so a wrong stride would corrupt
  // every record after the first rather than fail loudly.
  const bytes = encodeCamerasBin([
    { id: 1, model: 0, w: 640, h: 480, params: [500, 320, 240] },
    { id: 2, model: 4, w: 800, h: 600, params: [700, 701, 400, 300, 0, 0, 0, 0] },
  ])
  const cams = parseCamerasBin(bytes)
  assertEquals(cams.length, 2)
  assertEquals(cams[1].cameraId, 2)
  assertEquals(cams[1].fx, 700)
  assertEquals(cams[1].fy, 701)
})

Deno.test('parseCamerasBin stops at an unknown model rather than misaligning', () => {
  // An unknown model's params length is unknown, so there is no safe way to find
  // the next record. Returning the good prefix beats inventing focal lengths
  // from misaligned bytes, which would look plausible and be wrong.
  const bytes = encodeCamerasBin([
    { id: 1, model: 2, w: 720, h: 960, params: [800, 360, 480, 0] },
    { id: 2, model: 99, w: 720, h: 960, params: [1, 2, 3] },
  ])
  const cams = parseCamerasBin(bytes)
  assertEquals(cams.length, 1)
  assertEquals(cams[0].cameraId, 1)
})

Deno.test('parseCamerasBin handles an empty model file', () => {
  assertEquals(parseCamerasBin(encodeCamerasBin([])).length, 0)
})

Deno.test('camera model param counts match COLMAP', () => {
  assertEquals(colmapCameraModelParamCount(0), 3)  // SIMPLE_PINHOLE f,cx,cy
  assertEquals(colmapCameraModelParamCount(1), 4)  // PINHOLE fx,fy,cx,cy
  assertEquals(colmapCameraModelParamCount(2), 4)  // SIMPLE_RADIAL f,cx,cy,k1
  assertEquals(colmapCameraModelParamCount(3), 5)  // RADIAL f,cx,cy,k1,k2
  assertEquals(colmapCameraModelParamCount(4), 8)  // OPENCV fx,fy,cx,cy,k1,k2,p1,p2
  assertEquals(colmapCameraModelParamCount(99), null)
})

Deno.test('buildPosesJson carries the solved camera, and omits it when absent', () => {
  const imgs = parseImagesBin(encodeImagesBin([{ id: 1, q: [1, 0, 0, 0], t: [0, 0, 0], cam: 1, name: 'kf-00000.jpg' }]))
  const withCam = buildPosesJson(imgs, 'colmap', {
    cameraId: 1, modelId: 2, width: 720, height: 960, fx: 812.5, fy: 812.5, cx: 358.1, cy: 483.7,
  })
  assertEquals(withCam.camera?.fx, 812.5)
  assertEquals(withCam.camera?.cx, 358.1)
  // Absent means "not solved" — distinguishable from solved-as-zero.
  assertEquals(buildPosesJson(imgs).camera, undefined)
})

Deno.test('readSolvedCamera prefers COLMAP and ignores a camera-less pose file', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/${POSE_SOURCES[0]}`, JSON.stringify({
      tool: 'colmap',
      camera: { fx: 800, fy: 800, cx: 355, cy: 470, width: 720, height: 960 },
      frames: [],
    }))
    const cam = await readSolvedCamera(dir)
    assertEquals(cam?.fx, 800)
    assertEquals(cam?.cx, 355)

    // A pose file with no camera block must not masquerade as a solved lens.
    const bare = await Deno.makeTempDir()
    await Deno.writeTextFile(`${bare}/${POSE_SOURCES[0]}`, JSON.stringify({ tool: 'colmap', frames: [] }))
    assertEquals(await readSolvedCamera(bare), null)
    await Deno.remove(bare, { recursive: true })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('readSolvedCamera rejects a partial or nonsense camera block', async () => {
  const dir = await Deno.makeTempDir()
  try {
    // Missing cy, and a zero focal length: either would silently produce a
    // garbage lens if it were allowed through.
    for (const cam of [
      { fx: 800, fy: 800, cx: 355, width: 720, height: 960 },
      { fx: 0, fy: 800, cx: 355, cy: 470, width: 720, height: 960 },
    ]) {
      await Deno.writeTextFile(`${dir}/${POSE_SOURCES[0]}`, JSON.stringify({ tool: 'colmap', camera: cam, frames: [] }))
      assertEquals(await readSolvedCamera(dir), null)
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a solved camera beats the FOV fallback, and rescales to the actual image', () => {
  // The fallback can only ever centre the principal point; the solved lens does not.
  const fallback = deriveIntrinsics({ fovYDeg: 64.577, width: 720, height: 960 }, 720, 960)
  assertEquals(fallback.cx, 360)
  assertEquals(fallback.cy, 480)

  const solved = deriveIntrinsics({ fx: 812.5, fy: 812.5, cx: 358.1, cy: 483.7, width: 720, height: 960 }, 720, 960)
  assertEquals(solved.cx, 358.1)
  assertEquals(solved.flX, 812.5)

  // Half-size image => every pixel quantity halves.
  const half = deriveIntrinsics({ fx: 812.5, fy: 812.5, cx: 358.1, cy: 483.7, width: 720, height: 960 }, 360, 480)
  assertEquals(half.flX, 406.25)
  assertEquals(half.cx, 179.05)
})

// ─── Reconstruction quality ───────────────────────────────────────────────────
// A COLMAP run that registers a handful of frames exits 0 and writes a real
// poses.json, so before this gate existed the only difference between a good
// solve and a useless one was numbers nobody compared. The two runs asserted on
// below are the measured ones (2026-08-30); they are the whole evidence base for
// the thresholds, so they are pinned here rather than paraphrased.

const GOOD_RUN = { registeredImages: 32, frameCount: 32, pointCount: 9362 }
const BAD_RUN = { registeredImages: 3, frameCount: 17, pointCount: 1 }

Deno.test('assessColmapQuality passes the measured good solve', () => {
  const q = assessColmapQuality(GOOD_RUN, { minRegistrationRatio: 0.6, minPoints3D: 100 })
  assertEquals(q.degenerate, false)
  assertEquals(q.status, 'ready')
  assertEquals(q.registrationRatio, 1)
  assertEquals(q.reasons, [])
})

Deno.test('assessColmapQuality condemns the measured 3-of-17 solve', () => {
  const q = assessColmapQuality(BAD_RUN, { minRegistrationRatio: 0.6, minPoints3D: 100 })
  assertEquals(q.degenerate, true)
  assertEquals(q.status, 'needs-rescan')
  assertEquals(q.registrationRatio, 0.176)
  assertEquals(q.reasons, ['low-registration-ratio', 'too-few-points'])
  // The verdict has to carry what it was judged against, or a manifest read
  // months later cannot say whether the bar moved or the capture did.
  assertEquals(q.thresholds.minRegistrationRatio, 0.6)
})

Deno.test('the ratio gate carries a bad capture the point floor lets through', () => {
  // Re-running the same 17 phone keyframes through the real solver produced
  // 2/17 with 159 points, not 3/17 with 1 — the mapper's initialisation is
  // stochastic and a capture this weak has no dominant solution to settle on.
  // 159 clears minPoints3D, so a points-only gate would have called that run
  // fine. This is the case that says both thresholds have to stay.
  const q = assessColmapQuality({ registeredImages: 2, frameCount: 17, pointCount: 159 })
  assertEquals(q.degenerate, true)
  assertEquals(q.reasons, ['low-registration-ratio'])
})

Deno.test('a single triangulated point is degenerate at any registration ratio', () => {
  // The ratio gate alone would wave this through: every frame is posed, and the
  // model still has no structure. That is why there are two thresholds.
  const q = assessColmapQuality({ registeredImages: 8, frameCount: 8, pointCount: 1 })
  assertEquals(q.degenerate, true)
  assertEquals(q.reasons, ['too-few-points'])
})

Deno.test('quality thresholds are overridable, including disabling the point floor', () => {
  const prevRatio = Deno.env.get('COLMAP_MIN_REGISTRATION_RATIO')
  const prevPts = Deno.env.get('COLMAP_MIN_POINTS3D')
  try {
    // Defaults first, so the override below is demonstrably doing the work.
    assertEquals(resolveQualityThresholds().minRegistrationRatio, DEFAULT_MIN_REGISTRATION_RATIO)
    assertEquals(resolveQualityThresholds().minPoints3D, DEFAULT_MIN_POINTS_3D)

    Deno.env.set('COLMAP_MIN_REGISTRATION_RATIO', '0.15')
    // 0 must survive: it is the documented way to turn the point floor off, and
    // the int helper next to it would have silently restored the default.
    Deno.env.set('COLMAP_MIN_POINTS3D', '0')
    const t = resolveQualityThresholds()
    assertEquals(t.minRegistrationRatio, 0.15)
    assertEquals(t.minPoints3D, 0)
    assertEquals(assessColmapQuality(BAD_RUN, t).degenerate, false, 'a loosened gate must actually loosen')

    // Garbage falls back rather than producing a threshold of NaN, which would
    // compare false against everything and disable the gate by accident.
    Deno.env.set('COLMAP_MIN_REGISTRATION_RATIO', 'soon')
    assertEquals(resolveQualityThresholds().minRegistrationRatio, DEFAULT_MIN_REGISTRATION_RATIO)
  } finally {
    if (prevRatio === undefined) Deno.env.delete('COLMAP_MIN_REGISTRATION_RATIO')
    else Deno.env.set('COLMAP_MIN_REGISTRATION_RATIO', prevRatio)
    if (prevPts === undefined) Deno.env.delete('COLMAP_MIN_POINTS3D')
    else Deno.env.set('COLMAP_MIN_POINTS3D', prevPts)
  }
})

Deno.test('the remediation tells a non-expert what to do in the room', () => {
  const q = assessColmapQuality(BAD_RUN, { minRegistrationRatio: 0.6, minPoints3D: 100 })
  const msg = degenerateRemediation(q, BAD_RUN)
  // The real cause on 2026-08-30 was a dim, low-texture room (50–330 SIFT
  // features per frame), so light, texture and parallax are the three things
  // the message has to name. Someone holding a phone cannot act on anything else.
  for (const cue of ['light', 'pattern', 'walk sideways']) {
    assert(msg.toLowerCase().includes(cue), `remediation must mention "${cue}": ${msg}`)
  }
  // The counts belong in it too — "3 of 17" is what makes it credible.
  assert(msg.includes('3 of 17'))
  // And jargon must stay out: naming the algorithm is not an instruction.
  for (const jargon of ['structure-from-motion', 'sfm', 'colmap', 'triangulat']) {
    assert(!msg.toLowerCase().includes(jargon), `remediation must avoid jargon "${jargon}": ${msg}`)
  }
})

/** Encode a points3D.bin holding `n` points, tracks empty. */
function encodePoints3DBin(n: number): Uint8Array {
  const rec = 8 + 24 + 3 + 8 + 8
  const buf = new Uint8Array(8 + n * rec)
  const dv = new DataView(buf.buffer)
  dv.setBigUint64(0, BigInt(n), true)
  for (let i = 0; i < n; i++) {
    let o = 8 + i * rec
    dv.setBigUint64(o, BigInt(i + 1), true); o += 8
    dv.setFloat64(o, i, true); dv.setFloat64(o + 8, 0, true); dv.setFloat64(o + 16, 0, true); o += 24
    buf[o] = 128; buf[o + 1] = 128; buf[o + 2] = 128; o += 3
    dv.setFloat64(o, 0.5, true); o += 8
    dv.setBigUint64(o, 0n, true)
  }
  return buf
}

/**
 * Drive `runColmapPoses` end to end against a stubbed COLMAP that emits a model
 * of exactly the shape asked for. This is the part the pure-function tests
 * cannot cover: that the verdict actually reaches the manifest on disk, which
 * is the only thing the world-job coordinator and splat_train ever read.
 */
async function runWithStubbedModel(
  opts: { keyframes: number; registered: number; points: number },
): Promise<{ dir: string; result: Awaited<ReturnType<typeof runColmapPoses>> }> {
  const dir = await Deno.makeTempDir()
  const sessionDir = `${dir}/sess-photo-stub`
  await Deno.mkdir(sessionDir)
  for (let i = 0; i < opts.keyframes; i++) {
    await Deno.writeFile(`${sessionDir}/kf-${String(i).padStart(5, '0')}.jpg`, new Uint8Array([0xff, 0xd8]))
  }
  const images = Array.from({ length: opts.registered }, (_, i) => ({
    id: i + 1,
    q: [1, 0, 0, 0],
    t: [i, 0, 0],
    cam: 1,
    name: `kf-${String(i).padStart(5, '0')}.jpg`,
  }))

  const result = await runColmapPoses({
    sessionDir,
    colmapBin: Deno.execPath(), // any runnable binary: the spawn is stubbed below
    _spawn: async (_bin, args) => {
      if (args[0] === 'mapper') {
        const out = args[args.indexOf('--output_path') + 1]
        const model = `${out}/0`
        await Deno.mkdir(model, { recursive: true })
        await Deno.writeFile(`${model}/images.bin`, encodeImagesBin(images))
        await Deno.writeFile(`${model}/points3D.bin`, encodePoints3DBin(opts.points))
      }
      return { code: 0, stderr: '' }
    },
  })
  return { dir, result }
}

Deno.test('a degenerate solve stays status ok but is flagged, with a remediation on disk', async () => {
  // The exact run that motivated this: 3 of 17 posed, 1 point, exit 0.
  const { dir, result } = await runWithStubbedModel({ keyframes: 17, registered: 3, points: 1 })
  try {
    // 'ok' is correct and deliberate: COLMAP ran every step and wrote real
    // files. 'error' would blame the tool, 'skipped' would deny it ran.
    assertEquals(result.status, 'ok')
    assertEquals(result.exitCode, 0)
    assertEquals(result.quality?.degenerate, true)
    assertEquals(result.quality?.status, 'needs-rescan')
    assertEquals(result.registeredImages, 3)

    const written = JSON.parse(await Deno.readTextFile(`${dir}/sess-photo-stub/colmap-poses.manifest.json`))
    assertEquals(written.status, 'ok')
    assertEquals(written.frameCount, 17)
    assertEquals(written.registeredImages, 3)
    assertEquals(written.quality.degenerate, true)
    assertEquals(written.quality.registrationRatio, 0.176)
    assert(written.remediation?.includes('3 of 17'), 'the envelope slot every consumer already reads must carry the fix')
    // The poses are still written: a bad model is the best diagnostic there is.
    assertEquals(written.posesPath, 'colmap.poses.json')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a healthy solve carries a ready verdict and no remediation', async () => {
  const { dir, result } = await runWithStubbedModel({ keyframes: 12, registered: 12, points: 4000 })
  try {
    assertEquals(result.status, 'ok')
    assertEquals(result.quality?.degenerate, false)
    assertEquals(result.quality?.status, 'ready')
    const written = JSON.parse(await Deno.readTextFile(`${dir}/sess-photo-stub/colmap-poses.manifest.json`))
    // Absent, not empty-string: "nothing to remedy" must not read as advice.
    assertEquals(written.remediation, undefined)
    assertEquals(written.quality.reasons, [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
