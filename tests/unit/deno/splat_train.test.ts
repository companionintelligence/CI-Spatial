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
  DEFAULT_MAX_SPLATS,
  isValidSessionDir,
  resolveParams,
  runSplatTrain,
  stderrTail,
} from '../../../server/splat/splat_train.ts'
import {
  deriveIntrinsics,
  poseToMatrix,
  readJpegDimensions,
} from '../../../server/splat/splat_train_dataset.ts'

Deno.test('isValidSessionDir accepts canonical session ids', () => {
  assert(isValidSessionDir('/tmp/scans/sessions/sess-12345-abcde'))
})

Deno.test('isValidSessionDir rejects the retired client-minted shape', () => {
  // 07-scan-identity/0002 cut SESSION_ID_RE over to sess-* only, everywhere —
  // session-* named a directory the server never created. This file used to
  // carry its own, wider copy of the regex that still accepted it.
  assert(!isValidSessionDir('./scans/sessions/session-19710101-test'))
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
    maxSplats: 250_000,
    device: 'DiscreteGpu(0)',
    brushBin: '/opt/brush-cli',
  })
  assertEquals(p.trainIters, 5000)
  assertEquals(p.shDegree, 1)
  assertEquals(p.maxResolution, 800)
  assertEquals(p.maxSplats, 250_000)
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
    '--max-splats', '1000000',
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
    brushBin: Deno.execPath(),
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
    brushBin: Deno.execPath(), // exists + executable so the guard passes
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

import { buildBrushDataset } from '../../../server/splat/splat_train_dataset.ts'
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

// ─── Relative paths (the shape the world-job runner actually passes) ─────────
//
// Every fixture above hands the converter an ABSOLUTE path, because
// `Deno.makeTempDir()` returns one — and that is precisely why a total pipeline
// failure passed this suite. server/main.ts defaults SCANS_DIR to './scans', so
// the real caller passes './scans/sessions/sess-…'; the converter used that
// string verbatim as a symlink TARGET, which the kernel resolves against the
// directory holding the link (`brush-dataset/images/`), not our cwd. All 17
// links on the 17-frame session landed dangling, Brush reported "dataset
// contains no usable training views", and the manifest kept only "brush exited
// 1". These two tests pin the resolution, not the symptom.

/** Run `fn` with the process cwd temporarily moved to `dir`. */
async function withCwd(dir: string, fn: () => Promise<void>): Promise<void> {
  const previous = Deno.cwd()
  Deno.chdir(dir)
  try {
    await fn()
  } finally {
    Deno.chdir(previous)
  }
}

Deno.test('buildBrushDataset materialises READABLE images from a relative sessionDir', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-rel-' })
  // Nest the session so the relative path has real depth, like ./scans/sessions/<id>.
  const root = `${tmp}/scans/sessions`
  await Deno.mkdir(root, { recursive: true })
  await makeSession(root, { frames: 3 })

  await withCwd(tmp, async () => {
    const result = await buildBrushDataset({ sessionDir: './scans/sessions/sess-conv-test' })
    assertEquals(result.frameCount, 3)
    // stat() follows symlinks: a dangling link throws here, a real file does not.
    // This is the assertion that fails on the pre-fix converter.
    for await (const entry of Deno.readDir(result.imagesDir)) {
      const info = await Deno.stat(`${result.imagesDir}/${entry.name}`)
      assert(info.isFile, `${entry.name} must resolve to a real file`)
      assert(info.size > 0, `${entry.name} must be non-empty`)
    }
    assert(result.datasetDir.startsWith('/'), 'datasetDir must come back absolute')
    assert(result.imagesDir.startsWith('/'), 'imagesDir must come back absolute')
  })
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('buildBrushDataset returns an absolute datasetDir even when given a relative one', async () => {
  // The export path is derived from datasetDir, and brush-cli --help documents
  // --export-path as "relative to the dataset's parent directory" — so a
  // relative datasetDir writes the trained .ply into <sessionDir>/<that path>
  // and `findExportedPly` reports "no .ply" AFTER a full training run.
  const tmp = await Deno.makeTempDir({ prefix: 'splat-rel-ds-' })
  await makeSession(tmp)
  await withCwd(tmp, async () => {
    const result = await buildBrushDataset({ sessionDir: './sess-conv-test', datasetDir: './ds' })
    assertEquals(result.datasetDir, `${await Deno.realPath(tmp)}/ds`)
    assert(result.transformsPath.startsWith('/'))
  })
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
  const sessionDir = await makePoselessSession(tmp) // no pose file from any provider
  // The message must name the CPU solver first. Naming only the GPU-bound
  // provider is what sent every pose-less session to a dead end: the reader
  // now accepts either producer, so the remediation has to say so.
  const err = await assertRejects(
    () => buildBrushDataset({ sessionDir, datasetDir: `${tmp}/ds` }),
    Error,
    'run a colmap-poses job on this session first',
  )
  assert(err.message.includes('colmap.poses.json'), 'names the CPU provider it looked for')
  assert(err.message.includes('lingbot-map.poses.json'), 'still names the GPU provider')
  await Deno.remove(tmp, { recursive: true })
})

// ─── Driver error contract + export selection ─────────────────────────────────

Deno.test('runSplatTrain surfaces a brush failure as an error manifest with the stderr tail', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-err-' })
  const sessionDir = await makeSession(tmp)
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async () => ({
      code: 1,
      stderr: 'wgpu: picked DiscreteGpu\nError: Error when decoding format: dataset contains no usable training views',
    }),
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 1)
  assertStringIncludes(result.log ?? '', 'no usable training views')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.status, 'error')
  assertStringIncludes(manifest.error, 'brush exited 1')
  // The manifest is the only durable record of the run — `log` is returned and
  // then dropped. A bare "brush exited 1" is where the first real splat-train
  // job's trail ended; Brush's own diagnosis has to survive onto disk.
  assertStringIncludes(manifest.error, 'no usable training views')
  assertStringIncludes(manifest.remediation ?? '', Deno.execPath())
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('stderrTail keeps the END of the stream and caps its length', () => {
  // Brush logs adapter selection and training progress before it fails, so the
  // head of stderr is never the diagnosis.
  assertEquals(
    stderrTail('wgpu adapter: DiscreteGpu\n\nError: dataset contains no usable training views\n'),
    'wgpu adapter: DiscreteGpu | Error: dataset contains no usable training views',
  )
  assertEquals(stderrTail(''), '')
  assertEquals(stderrTail('   \n\n  '), '')
  assertEquals(stderrTail('a\nb\nc\nd\ne'), 'c | d | e')
  assertEquals(stderrTail('x'.repeat(50), 10).length, 10)
})

Deno.test('runSplatTrain explains a zero-exit run that produced no .ply', async () => {
  // The expensive failure mode: it fires only after a full training run, so the
  // message has to name the cause seen in practice (a non-absolute
  // --export-path, which Brush resolves against the dataset's parent dir)
  // rather than leaving the reader with "produced no .ply".
  const tmp = await Deno.makeTempDir({ prefix: 'splat-noply-' })
  const sessionDir = await makeSession(tmp)
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async () => ({ code: 0, stderr: '' }), // trains "fine", exports nothing
  })
  assertEquals(result.status, 'error')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertStringIncludes(manifest.error, 'no .ply')
  assertStringIncludes(manifest.remediation ?? '', 'export-path')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSplatTrain records an absolute sessionDir on the manifest', async () => {
  // A manifest that says './scans/sessions/sess-…' is only meaningful to a
  // reader who also knows the server's cwd.
  const tmp = await Deno.makeTempDir({ prefix: 'splat-abs-' })
  await makeSession(tmp)
  await withCwd(tmp, async () => {
    const result = await runSplatTrain({
      sessionDir: './sess-conv-test',
      outputPlyPath: `${tmp}/scan.splat.ply`,
      brushBin: '/this/binary/definitely/does/not/exist',
    })
    assertEquals(result.status, 'skipped')
    assert(result.manifest.sessionDir.startsWith('/'), `got ${result.manifest.sessionDir}`)
    assertStringIncludes(result.manifest.sessionDir, 'sess-conv-test')
    // The skip must name the build command and the env var, like colmap's does.
    assertStringIncludes(result.manifest.remediation ?? '', 'cargo build --release -p brush-cli')
    assertStringIncludes(result.manifest.remediation ?? '', 'BRUSH_BIN')
  })
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
    brushBin: Deno.execPath(),
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

// Runs ONLY with BRUSH_E2E=1: a ~200-iter real train on a local session.
// Mock-spawn tests cannot catch real CLI contract drift — the PINHOLE
// camera_model bug shipped precisely because nothing exercised the actual
// binary, and so did the relative-path bug above, which no mock could see
// because `_spawn` never reads the images. Takes ~10-30s on an idle GPU.
// Requires a built brush-cli (BRUSH_BIN or the default path).
//
// The session is DISCOVERED, not hardcoded: this test used to point at
// `scans/sessions/sess-fixture-lingbot`, which does not exist in this repo
// (scans/ is gitignored — .gitignore:68), so the one test that would have
// caught the relative-path failure could not run even when asked. Set
// SPLAT_E2E_SESSION to pin a specific session id.
async function richestSession(): Promise<string | null> {
  const root = `${Deno.cwd()}/scans/sessions`
  const pinned = Deno.env.get('SPLAT_E2E_SESSION')
  if (pinned) return `${root}/${pinned}`
  let best: { dir: string; frames: number } | null = null
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || !entry.name.startsWith('sess-')) continue
      let frames = 0
      for await (const file of Deno.readDir(`${root}/${entry.name}`)) {
        if (file.isFile && /^kf-\d+\.jpg$/.test(file.name)) frames++
      }
      // COLMAP's own floor is 3 frames; below that there is nothing to solve.
      if (frames >= 3 && (!best || frames > best.frames)) best = { dir: `${root}/${entry.name}`, frames }
    }
  } catch {
    return null
  }
  return best?.dir ?? null
}

Deno.test({
  name: 'BRUSH_E2E: real brush-cli trains a local session end-to-end',
  ignore: Deno.env.get('BRUSH_E2E') !== '1',
  fn: async () => {
    const source = await richestSession()
    if (!source) {
      throw new Error(
        'no session under scans/sessions/ has >=3 kf-*.jpg — capture one with the scanner, ' +
          'or set SPLAT_E2E_SESSION to a session id that does',
      )
    }
    const tmp = await Deno.makeTempDir({ prefix: 'splat-e2e-' })
    // Train on a copy so the real session never accumulates dataset dirs.
    const sessionDir = `${tmp}/${source.split('/').pop()}`
    await Deno.mkdir(sessionDir, { recursive: true })
    for await (const entry of Deno.readDir(source)) {
      if (entry.isFile) await Deno.copyFile(`${source}/${entry.name}`, `${sessionDir}/${entry.name}`)
    }
    const result = await runSplatTrain({
      sessionDir,
      outputPlyPath: `${tmp}/scan.splat.ply`,
      trainIters: 200,
      maxResolution: 320,
      evalEvery: 200,
    })
    assertEquals(result.status, 'ok', `${result.manifest.error ?? result.manifest.skippedReason ?? ''}`)
    assert((result.gaussianCount ?? 0) > 0, 'expected a non-empty splat')
    const bytes = await Deno.readFile(`${tmp}/scan.splat.ply`)
    assertEquals(new TextDecoder().decode(bytes.subarray(0, 3)), 'ply')
    await Deno.remove(tmp, { recursive: true })
  },
})

// ─── Gaussian budget + the splat's own quality verdict ────────────────────────

Deno.test('the default gaussian budget is the one both backends share', () => {
  // 1,000,000 rather than Brush's own 10,000,000: it is Spirula's --cap-max
  // default, and the lower of the two is the only value that constrains
  // anything. Measured at this budget on sess-video-20260830-054518, Brush
  // finished at 258,710 — a quarter of the way to it — while Spirula reached
  // 997,922, which is why the budget is matchable as an input and not as an
  // output.
  assertEquals(DEFAULT_MAX_SPLATS, 1_000_000)
  const p = resolveParams({ sessionDir: '/x/sess-1-a', outputPlyPath: '/x/a.splat.ply' })
  assertEquals(p.maxSplats, 1_000_000)
})

/**
 * A session with one keyframe plus, optionally, a seed cloud — the two inputs
 * the quality verdict measures against.
 */
async function qualitySession(tmp: string, opts?: { seedPoints?: number[][] }): Promise<string> {
  const sessionDir = `${tmp}/sess-quality-test`
  await Deno.mkdir(sessionDir, { recursive: true })
  await Deno.writeFile(`${sessionDir}/kf-00000.jpg`, TINY_JPEG)
  await Deno.writeTextFile(
    `${sessionDir}/keyframes.jsonl`,
    JSON.stringify({
      index: 0,
      file: 'kf-00000.jpg',
      pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      intrinsics: { width: 2, height: 2, fovYDeg: 55 },
    }) + '\n',
  )
  if (opts?.seedPoints) {
    await Deno.writeFile(`${sessionDir}/colmap.point-cloud.ply`, xyzPly(opts.seedPoints))
  }
  return sessionDir
}

/** A minimal binary xyz PLY — the shape of both seed clouds and (enough of) a splat. */
function xyzPly(rows: number[][]): Uint8Array {
  const header = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\n' +
      `element vertex ${rows.length}\n` +
      'property float x\nproperty float y\nproperty float z\nend_header\n',
  )
  const body = new Uint8Array(rows.length * 12)
  const view = new DataView(body.buffer)
  rows.forEach((r, i) => {
    view.setFloat32(i * 12, r[0], true)
    view.setFloat32(i * 12 + 4, r[1], true)
    view.setFloat32(i * 12 + 8, r[2], true)
  })
  const out = new Uint8Array(header.length + body.length)
  out.set(header)
  out.set(body, header.length)
  return out
}

Deno.test('a zero-gaussian export is an error, not an ok run with a small number', () => {
  // The defect this repo keeps producing: `countPlyVertices(...) ?? 0` used to
  // flow straight into `status: 'ok'`, so a completed train that exported an
  // empty PLY was indistinguishable from one that reconstructed the room.
  return (async () => {
    const tmp = await Deno.makeTempDir({ prefix: 'splat-empty-' })
    const sessionDir = await qualitySession(tmp)
    const result = await runSplatTrain({
      sessionDir,
      outputPlyPath: `${tmp}/scan.splat.ply`,
      brushBin: Deno.execPath(),
      _spawn: async (_bin, args) => {
        const exportPath = args[args.indexOf('--export-path') + 1]
        await Deno.writeFile(`${exportPath}/splat_15000.ply`, xyzPly([]))
        return { code: 0, stderr: '' }
      },
    })
    assertEquals(result.status, 'error')
    assertEquals(result.manifest.status, 'error')
    assertStringIncludes(result.manifest.error ?? '', '0 gaussians')
    assert(result.manifest.remediation, 'an error the operator can act on must carry a fix')
    await Deno.remove(tmp, { recursive: true })
  })()
})

Deno.test('an unreadable PLY header is an error too', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-badhdr-' })
  const sessionDir = await qualitySession(tmp)
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      await Deno.writeFile(`${exportPath}/splat_15000.ply`, new TextEncoder().encode('not a ply at all'))
      return { code: 0, stderr: '' }
    },
  })
  assertEquals(result.status, 'error')
  assertStringIncludes(result.manifest.error ?? '', 'no readable PLY header')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('an ok run carries a quality verdict measured against the seed cloud', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-quality-' })
  // Seed cloud spanning a 10-unit box; the "splat" fills the same box, so the
  // extent ratio is ~1 and the run is ready.
  const box = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10], [10, 10, 10]]
  const sessionDir = await qualitySession(tmp, { seedPoints: box })
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      const rows: number[][] = []
      for (let i = 0; i < 2000; i++) rows.push([(i % 11), ((i / 11 | 0) % 11), ((i / 121 | 0) % 11)])
      await Deno.writeFile(`${exportPath}/splat_15000.ply`, xyzPly(rows))
      return { code: 0, stderr: '' }
    },
  })
  assertEquals(result.status, 'ok')
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.quality.degenerate, false)
  assertEquals(manifest.quality.status, 'ready')
  // This session's single pose came from the keyframe record, so the frame is
  // metric and the metre gate is the one that applies.
  assertEquals(manifest.quality.scaleFrame, 'metric')
  assert(manifest.quality.extentRatio > 0, 'a seed cloud was present, so a ratio must be reported')
  assertEquals(manifest.remediation, undefined)
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('a splat far bigger than the room it came from is flagged, with a fix', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'splat-sprawl-' })
  const sessionDir = await qualitySession(tmp, { seedPoints: [[0, 0, 0], [1, 1, 1], [0, 1, 0], [1, 0, 1]] })
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      // 2000 gaussians spread over a 200-unit box against a 1-unit seed: a
      // large, well-formed, entirely healthy-looking PLY of the wrong room.
      const rows: number[][] = []
      for (let i = 0; i < 2000; i++) rows.push([(i % 200), ((i * 7) % 200), ((i * 13) % 200)])
      await Deno.writeFile(`${exportPath}/splat_15000.ply`, xyzPly(rows))
      return { code: 0, stderr: '' }
    },
  })
  // The stage succeeded — Brush ran and the .ply is still the most useful thing
  // to look at. What must not happen is it passing for a good scan.
  assertEquals(result.status, 'ok')
  assertEquals(result.quality?.degenerate, true)
  assert(result.quality?.reasons.includes('sprawls-beyond-seed'))
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.quality.status, 'needs-rescan')
  assertStringIncludes(manifest.remediation, 're-scan')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('a splat trained on a degenerate solve inherits that verdict', async () => {
  // sess-a7e2f642 in miniature: the poses are bad, the PLY is not. Only the
  // pose solve's own manifest knows, so the splat stage reads it.
  const tmp = await Deno.makeTempDir({ prefix: 'splat-badposes-' })
  const sessionDir = await qualitySession(tmp, { seedPoints: [[0, 0, 0], [10, 10, 10]] })
  await Deno.writeTextFile(
    `${sessionDir}/colmap-poses.manifest.json`,
    JSON.stringify({
      tool: 'colmap',
      status: 'ok',
      registeredImages: 3,
      frameCount: 17,
      quality: { degenerate: true, status: 'needs-rescan', reasons: ['low-registration-ratio'] },
    }),
  )
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      const rows: number[][] = []
      for (let i = 0; i < 2000; i++) rows.push([(i % 11), ((i / 11 | 0) % 11), ((i / 121 | 0) % 11)])
      await Deno.writeFile(`${exportPath}/splat_15000.ply`, xyzPly(rows))
      return { code: 0, stderr: '' }
    },
  })
  assertEquals(result.status, 'ok')
  assertEquals(result.quality?.reasons, ['degenerate-poses'])
  assertEquals(result.quality?.degenerate, true)
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('a splat that cannot be measured says so instead of staying silent', async () => {
  // An absent verdict on an `ok` manifest reads exactly like a passing one, so
  // the unmeasurable case has to be stated rather than omitted.
  const tmp = await Deno.makeTempDir({ prefix: 'splat-unmeasurable-' })
  const sessionDir = await qualitySession(tmp)
  const result = await runSplatTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    brushBin: Deno.execPath(),
    _spawn: async (_bin, args) => {
      const exportPath = args[args.indexOf('--export-path') + 1]
      // A header the vertex counter reads (so this is not the empty-PLY path)
      // but the centre reader refuses: it declares no y or z.
      await Deno.writeFile(
        `${exportPath}/splat_15000.ply`,
        new TextEncoder().encode(
          'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nend_header\n',
        ),
      )
      return { code: 0, stderr: '' }
    },
  })
  assertEquals(result.status, 'ok')
  assertEquals(result.quality, undefined)
  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.quality, undefined)
  assertStringIncludes(manifest.qualityError, 'could not measure')
  await Deno.remove(tmp, { recursive: true })
})
