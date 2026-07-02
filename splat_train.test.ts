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
