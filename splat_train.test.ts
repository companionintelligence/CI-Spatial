/**
 * Deno unit tests for the splat-train driver surface. The real Brush binary is
 * a GPU trainer that can't run in CI, so — like lingbot_map.test.ts — these
 * cover only the TS side: validation gates, CLI arg assembly, PLY vertex
 * counting, and the "binary missing → skipped manifest" fallback the
 * world-job coordinator relies on.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'

import {
  buildBrushArgs,
  countPlyVertices,
  isValidSessionDir,
  resolveParams,
  runSplatTrain,
} from './splat_train.ts'
import {
  deriveIntrinsics,
  poseToMatrix,
  readJpegDimensions,
} from './splat_train_dataset.ts'

Deno.test('isValidSessionDir accepts canonical session ids', () => {
  assert(isValidSessionDir('/tmp/scans/sessions/sess-12345-abcde'))
  assert(isValidSessionDir('./scans/sessions/session-19710101-test'))
})

Deno.test('isValidSessionDir rejects path traversal and other dirs', () => {
  assert(!isValidSessionDir('/etc/passwd'))
  assert(!isValidSessionDir('../../etc'))
  assert(!isValidSessionDir('/tmp/scans/sessions/'))
})

Deno.test('resolveParams honours explicit overrides over env defaults', () => {
  const p = resolveParams({
    sessionDir: '/x/sess-1-a',
    outputPlyPath: '/x/a.splat.ply',
    trainIters: 5000,
    shDegree: 1,
    maxResolution: 800,
    device: 'DiscreteGpu(0)',
    brushBin: '/opt/brush-cli',
  })
  assertEquals(p.trainIters, 5000)
  assertEquals(p.shDegree, 1)
  assertEquals(p.maxResolution, 800)
  assertEquals(p.device, 'DiscreteGpu(0)')
  assertEquals(p.brushBin, '/opt/brush-cli')
  assertEquals(p.evalEvery, 5000)
})

Deno.test('buildBrushArgs assembles the headless CLI in a stable order', () => {
  const params = resolveParams({
    sessionDir: '/x/sess-1-a',
    outputPlyPath: '/x/a.splat.ply',
    trainIters: 12000,
    shDegree: 2,
    maxResolution: 1280,
  })
  const args = buildBrushArgs('/data/ds', '/data/ds/exports', params)
  assertEquals(args, [
    '/data/ds',
    '--total-train-iters', '12000',
    '--sh-degree', '2',
    '--max-resolution', '1280',
    '--export-every', '12000',
    '--export-path', '/data/ds/exports',
    '--export-name', 'splat_{iter}.ply',
    '--eval-every', '12000',
  ])
})

Deno.test('countPlyVertices reads the vertex element from a PLY header', () => {
  const header = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\nelement vertex 4242\nproperty float x\nend_header\n',
  )
  assertEquals(countPlyVertices(header), 4242)
  assertEquals(countPlyVertices(new TextEncoder().encode('not a ply')), null)
})

Deno.test('poseToMatrix drops OpenGL/Blender c2w pose in without a flip', () => {
  const m = poseToMatrix({ position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })
  assertEquals(m, [
    [1, 0, 0, 1],
    [0, 1, 0, 2],
    [0, 0, 1, 3],
    [0, 0, 0, 1],
  ])
})

Deno.test('deriveIntrinsics scales client fx/fy to actual pixels', () => {
  const intr = deriveIntrinsics({ width: 640, height: 480, fx: 540, fy: 540, cx: 320, cy: 240 }, 1280, 960)
  assertEquals(intr.flX, 1080)
  assertEquals(intr.flY, 1080)
  assertEquals(intr.cx, 640)
  assertEquals(intr.cy, 480)
})

Deno.test('deriveIntrinsics falls back to fovY when no fx/fy given', () => {
  const intr = deriveIntrinsics({ fovYDeg: 90 }, 1000, 1000)
  // fl_y = h / (2·tan(45°)) = 1000 / 2 = 500
  assert(Math.abs(intr.flY - 500) < 1e-6)
  assertEquals(intr.cx, 500)
  assertEquals(intr.cy, 500)
})

Deno.test('readJpegDimensions parses a baseline JPEG SOF0', () => {
  // Minimal SOI + SOF0 with 3x7 dims + EOI.
  const bytes = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // length 17
    0x08, // precision
    0x00, 0x07, // height 7
    0x00, 0x03, // width 3
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // components
    0xff, 0xd9, // EOI
  ])
  assertEquals(readJpegDimensions(bytes), { w: 3, h: 7 })
})

Deno.test('runSplatTrain returns a skipped result when the Brush binary is missing', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-test-' })
  const sessionDir = `${tmp}/sess-test-abcd`
  await Deno.mkdir(sessionDir, { recursive: true })
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/out.splat.ply`,
    brushBin: '/this/binary/definitely/does/not/exist',
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('Brush binary not found'))
  assert(typeof result.manifest.remediation === 'string')
  // The manifest must be written even on skip.
  const manifestPath = `${tmp}/out.splat-train.manifest.json`
  const written = JSON.parse(await Deno.readTextFile(manifestPath))
  assertEquals(written.status, 'skipped')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatTrain rejects an invalid session dir without touching Brush', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-test-' })
  const result = await runSplatTrain({
    sessionDir: '/etc',
    outputPlyPath: `${tmp}/out.splat.ply`,
    brushBin: '/bin/true',
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 2)
  assert(result.manifest.error?.includes('invalid session directory'))
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatTrain lands the PLY + writes an ok manifest via an injected spawn', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-test-' })
  const sessionDir = `${tmp}/sess-test-wxyz`
  await Deno.mkdir(sessionDir, { recursive: true })
  // Minimal keyframe session with one readable JPEG.
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ])
  await Deno.writeFile(`${sessionDir}/kf-00000.jpg`, jpeg)
  await Deno.writeTextFile(
    `${sessionDir}/keyframes.jsonl`,
    JSON.stringify({ index: 0, file: 'kf-00000.jpg', pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, intrinsics: { width: 2, height: 2, fovYDeg: 55 } }) + '\n',
  )

  const outputPlyPath = `${tmp}/scan.splat.ply`
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath,
    brushBin: '/bin/true', // exists + executable so the guard passes
    provenance: { sessionId: 'sess-test-wxyz', scanId: 'scan-1' },
    // Fake the Brush run: write a tiny valid 3DGS PLY into the export dir.
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      const ply = new TextEncoder().encode(
        'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nend_header\n',
      )
      await Deno.writeFile(`${exportPath}/splat_15000.ply`, ply)
      return { code: 0, stderr: '' }
    },
  })

  assertEquals(result.status, 'ok')
  assertEquals(result.gaussianCount, 3)
  assertEquals(result.plyPath, outputPlyPath)
  const landed = await Deno.readFile(outputPlyPath)
  assertEquals(new TextDecoder().decode(landed.subarray(0, 3)), 'ply')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.status, 'ok')
  assertEquals(manifest.gaussianCount, 3)
  assertEquals(manifest.scanId, 'scan-1')
  await Deno.remove(tmp, { recursive: true })
})

// ─── Converter regression + edge cases ────────────────────────────────────────

import { buildBrushDataset } from './splat_train_dataset.ts'
import { assertRejects } from 'jsr:@std/assert@^1.0.0/rejects'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

/** 2×2 baseline JPEG (SOF0) — enough for readJpegDimensions to parse. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
])

async function makeSession(tmp: string, opts?: { frames?: number; withCloud?: boolean; lyingDims?: boolean; skipImageIdx?: number }) {
  const sessionDir = `${tmp}/sess-conv-test`
  await Deno.mkdir(sessionDir, { recursive: true })
  const n = opts?.frames ?? 2
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const file = `kf-${String(i).padStart(5, '0')}.jpg`
    if (i !== opts?.skipImageIdx) await Deno.writeFile(`${sessionDir}/${file}`, TINY_JPEG)
    lines.push(JSON.stringify({
      index: i,
      file,
      pose: { position: { x: i, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      // Optionally lie about dimensions — the converter must trust the JPEG bytes.
      intrinsics: { width: opts?.lyingDims ? 480 : 2, height: opts?.lyingDims ? 480 : 2, fovYDeg: 55 },
    }))
  }
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, lines.join('\n') + '\n')
  if (opts?.withCloud) {
    await Deno.writeTextFile(
      `${sessionDir}/lingbot-map.point-cloud.ply`,
      'ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n',
    )
  }
  return sessionDir
}

Deno.test('buildBrushDataset writes camera_model PERSPECTIVE — never the COLMAP name PINHOLE', async () => {
  // Regression: Brush's nerfstudio loader accepts PERSPECTIVE/OPENCV/OPENCV_FISHEYE/unset
  // and hard-errors on `PINHOLE`. This shipped once (fixed in 65c6e54) — lock it in.
  const tmp = await Deno.makeTempDir({ prefix: 'splat-conv-' })
  const sessionDir = await makeSession(tmp)
  const result = await buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` })
  const transforms = JSON.parse(await Deno.readTextFile(`${result.datasetDir}/transforms.json`))
  assertEquals(transforms.camera_model, 'PERSPECTIVE')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('buildBrushDataset trusts real JPEG dimensions over lying metadata', async () => {
  // The lingbot fixture's metadata claims 480px while the JPEGs are 640×360;
  // Brush projects through w/h, so wrong dims corrupt cx/cy and the training.
  const tmp = await Deno.makeTempDir({ prefix: 'splat-conv-' })
  const sessionDir = await makeSession(tmp, { lyingDims: true })
  const result = await buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` })
  const transforms = JSON.parse(await Deno.readTextFile(`${result.datasetDir}/transforms.json`))
  for (const frame of transforms.frames) {
    assertEquals(frame.w, 2)
    assertEquals(frame.h, 2)
    assert(frame.cx <= 2 && frame.cy <= 2, `cx/cy must be scaled to real pixels, got ${frame.cx}/${frame.cy}`)
  }
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('buildBrushDataset seeds ply_file_path only when the session has a point cloud', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-conv-' })
  const bare = await buildBrushDataset({ sessionDir: await makeSession(`${tmp}/a`), datasetDir: `${tmp}/ds-a` })
  const bareTransforms = JSON.parse(await Deno.readTextFile(`${bare.datasetDir}/transforms.json`))
  assertEquals(bareTransforms.ply_file_path, undefined)

  const seeded = await buildBrushDataset({ sessionDir: await makeSession(`${tmp}/b`, { withCloud: true }), datasetDir: `${tmp}/ds-b` })
  const seededTransforms = JSON.parse(await Deno.readTextFile(`${seeded.datasetDir}/transforms.json`))
  assert(typeof seededTransforms.ply_file_path === 'string' && seededTransforms.ply_file_path.length > 0)
  // The referenced cloud must resolve relative to transforms.json.
  await Deno.stat(`${seeded.datasetDir}/${seededTransforms.ply_file_path}`)
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('buildBrushDataset rejects a session with no keyframes', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-conv-' })
  const sessionDir = `${tmp}/sess-empty`
  await Deno.mkdir(sessionDir, { recursive: true })
  await assertRejects(
    () => buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` }),
    Error,
    'no keyframes',
  )
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('buildBrushDataset drops frames whose image is missing and reports the count', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-conv-' })
  const sessionDir = await makeSession(tmp, { frames: 3, skipImageIdx: 1 })
  const result = await buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` })
  assertEquals(result.droppedFrames, 1)
  const transforms = JSON.parse(await Deno.readTextFile(`${result.datasetDir}/transforms.json`))
  assertEquals(transforms.frames.length, 2)
  await Deno.remove(tmp, { recursive: true })
})

// ─── Pose fallback (video-ingest sessions) ───────────────────────────────────

/** Write a pose-LESS keyframe session (video-ingest style: records carry no pose). */
async function makePoselessSession(tmp: string, files = ['kf-00000.jpg', 'kf-00001.jpg']) {
  const sessionDir = `${tmp}/sess-poseless`
  await Deno.mkdir(sessionDir, { recursive: true })
  const lines: string[] = []
  files.forEach((file, i) => {
    // No `pose` key at all — mirrors scripts/ingest-video.mjs output.
    lines.push(JSON.stringify({ index: i, file, timestamp: i / 2, intrinsics: { width: 2, height: 2, fovYDeg: 55 } }))
  })
  for (const file of files) await Deno.writeFile(`${sessionDir}/${file}`, TINY_JPEG)
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, lines.join('\n') + '\n')
  return sessionDir
}

Deno.test('buildBrushDataset falls back to lingbot-map.poses.json when records lack pose', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-pose-' })
  const sessionDir = await makePoselessSession(tmp)
  // Identity cameraToWorld (OpenCV w2c) → the driver inverts + flips Y/Z axes,
  // yielding the OpenGL c2w diag(1,-1,-1,1). Only kf-00000 is given a pose.
  await Deno.writeTextFile(
    `${sessionDir}/lingbot-map.poses.json`,
    JSON.stringify({
      frames: [
        { file: 'kf-00000.jpg', cameraToWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
        { file: 'kf-00001.jpg', cameraToWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
      ],
    }),
  )

  const result = await buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` })
  assertEquals(result.frameCount, 2)
  const transforms = JSON.parse(await Deno.readTextFile(`${result.datasetDir}/transforms.json`))
  assertEquals(transforms.frames.length, 2)
  // OpenCV→OpenGL flip on an identity extrinsic.
  assertEquals(transforms.frames[0].transform_matrix, [
    [1, 0, 0, 0],
    [0, -1, 0, 0],
    [0, 0, -1, 0],
    [0, 0, 0, 1],
  ])
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('buildBrushDataset gives a clear error when no pose is available anywhere', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-pose-' })
  const sessionDir = await makePoselessSession(tmp) // no lingbot-map.poses.json written
  await assertRejects(
    () => buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` }),
    Error,
    'run a lingbot-map-reconstruct job on this session first',
  )
  await Deno.remove(tmp, { recursive: true })
})

// ─── Driver error contract + export selection ─────────────────────────────────

Deno.test('runSplatTrain surfaces a brush failure as an error manifest with the stderr tail', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-err-' })
  const sessionDir = await makeSession(tmp)
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: '/bin/true',
    _spawn: async () => ({ code: 1, stderr: 'Error: Unsupported nerfstudio camera_model `PINHOLE`' }),
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 1)
  assertStringIncludes(result.log ?? '', 'PINHOLE')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.status, 'error')
  assertStringIncludes(manifest.error, 'brush exited 1')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatTrain lands the highest-iteration export among decoys', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-pick-' })
  const sessionDir = await makeSession(tmp)
  const plyWithVertices = (n: number) =>
    new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nend_header\n`)
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: '/bin/true',
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      await Deno.writeFile(`${exportPath}/splat_100.ply`, plyWithVertices(1))
      await Deno.writeFile(`${exportPath}/splat_2000.ply`, plyWithVertices(7))
      await Deno.writeTextFile(`${exportPath}/notes.txt`, 'decoy')
      return { code: 0, stderr: '' }
    },
  })
  assertEquals(result.status, 'ok')
  assertEquals(result.gaussianCount, 7)
  await Deno.remove(tmp, { recursive: true })
})

// ─── Env-gated real-Brush end-to-end ──────────────────────────────────────────

// Runs ONLY with BRUSH_E2E=1: a ~200-iter real train on the fixture session.
// Mock-spawn tests cannot catch real CLI contract drift — the PINHOLE
// camera_model bug shipped precisely because nothing exercised the actual
// binary. Takes ~10-30s on an idle GPU. Requires the fixture session and a
// built brush-cli (BRUSH_BIN or the default path).
Deno.test({
  name: 'BRUSH_E2E: real brush-cli trains the fixture session end-to-end',
  ignore: Deno.env.get('BRUSH_E2E') !== '1',
  fn: async () => {
    const fixture = `${Deno.cwd()}/scans/sessions/sess-fixture-lingbot`
    try {
      await Deno.stat(`${fixture}/keyframes.jsonl`)
    } catch {
      throw new Error('fixture session missing — copy scans/sessions/sess-fixture-lingbot in first')
    }
    const tmp = await Deno.makeTempDir({ prefix: 'splat-e2e-' })
    // Train on a copy so the shared fixture never accumulates dataset dirs.
    const sessionDir = `${tmp}/sess-fixture-lingbot`
    await Deno.mkdir(sessionDir, { recursive: true })
    for await (const entry of Deno.readDir(fixture)) {
      if (entry.isFile) await Deno.copyFile(`${fixture}/${entry.name}`, `${sessionDir}/${entry.name}`)
    }
    const result = await runSplatTrain({
      sessionDir,
      outputPlyPath: `${tmp}/scan.splat.ply`,
      trainIters: 200,
      maxResolution: 320,
      evalEvery: 200,
    })
    assertEquals(result.status, 'ok')
    assert((result.gaussianCount ?? 0) > 0, 'expected a non-empty splat')
    const bytes = await Deno.readFile(`${tmp}/scan.splat.ply`)
    assertEquals(new TextDecoder().decode(bytes.subarray(0, 3)), 'ply')
    await Deno.remove(tmp, { recursive: true })
  },
})
