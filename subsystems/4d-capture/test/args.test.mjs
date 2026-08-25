/**
 * Arg assembly for the two external tools.
 *
 * Neither can run here — 4DAnyone needs a 44 GiB CUDA GPU and Brush needs a
 * GPU at all — so what is testable is that the commands are assembled correctly
 * and that bad input is caught *before* a 25-minute job starts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDensifyArgs, densify, isValidViewsPerLayer } from '../stages/densify.mjs'
import { buildBrushArgs, buildTransforms, DEFAULT_TRAIN_ITERS } from '../stages/train.mjs'
import { buildStubPly, runStub } from '../stages/stub.mjs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('views_per_layer must be divisible by 4 or 6', () => {
  for (const good of [4, 6, 8, 12, 16, 24, 48]) assert.ok(isValidViewsPerLayer(good), `${good}`)
  for (const bad of [1, 2, 3, 5, 7, 10, 0, -6]) assert.ok(!isValidViewsPerLayer(bad), `${bad}`)
})

test('densify args match the documented CLI, in a stable order', () => {
  const args = buildDensifyArgs({ videoPath: '/clips/a.mp4', viewsPerLayer: 6, dataDir: '/work/d' })
  assert.deepEqual(args, ['inference.py', '--video_path', '/clips/a.mp4', '--views_per_layer', '6', '--data_dir', '/work/d'])
})

test('optional densify flags are omitted when unset, not passed empty', () => {
  const args = buildDensifyArgs({ videoPath: '/a.mp4', viewsPerLayer: 6 })
  assert.ok(!args.includes('--layer_pitches'))
  assert.ok(!args.includes('--start_yaw'))
  const full = buildDensifyArgs({ videoPath: '/a.mp4', viewsPerLayer: 16, layerPitches: [-10, 15, 35], startYaw: 0, yawSpan: 360 })
  assert.ok(full.includes('--layer_pitches'))
  assert.equal(full[full.indexOf('--layer_pitches') + 1], '[-10,15,35]')
})

test('an unconfigured 4DAnyone is skipped with remediation, never an error', async () => {
  // The contract the whole appliance depends on.
  const out = await densify({ clipPath: '/a.mp4', viewsPerLayer: 6, env: {}, workDir: '/tmp' })
  assert.equal(out.status, 'skipped')
  assert.match(out.remediation, /FDANYONE_DIR/)
})

test('a bad views_per_layer is caught before spawning', async () => {
  let spawned = false
  const out = await densify({
    clipPath: '/a.mp4', viewsPerLayer: 7, env: { FDANYONE_DIR: '/opt/4danyone' }, workDir: '/tmp',
    spawnFn: () => { spawned = true },
  })
  assert.equal(out.status, 'error')
  assert.ok(!spawned, 'must not start a 25-minute job with a value the model will reject')
})

test('brush args are assembled with the sequence-scale iteration default', () => {
  const args = buildBrushArgs({ datasetDir: '/d', exportDir: '/e', trainIters: DEFAULT_TRAIN_ITERS })
  assert.equal(args[0], '/d')
  assert.ok(args.includes('--export-path'))
  assert.equal(args[args.indexOf('--total-steps') + 1], String(DEFAULT_TRAIN_ITERS))
  // Lower than a static scan's 15000 because it is paid once per timestep.
  assert.ok(DEFAULT_TRAIN_ITERS < 15000)
})

test('transforms carry unflipped camera-to-world matrices', () => {
  const t = buildTransforms(
    { views: [{ viewIndex: 0, matrix: [[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }] },
    { width: 1080, height: 1920, fovYDeg: 60 },
  )
  assert.equal(t.w, 1080)
  assert.equal(t.h, 1920)
  // No axis flip — Companion-Scan poses are already in Nerfstudio's convention.
  assert.equal(t.frames[0].transform_matrix[0][3], 5)
  assert.equal(t.frames[0].file_path, 'images/view-000.jpg')
})

test('stub PLY is a valid binary INRIA 3DGS file', () => {
  const ply = buildStubPly(100, 0)
  const header = ply.subarray(0, ply.indexOf('end_header\n') + 11).toString('ascii')
  assert.match(header, /^ply\n/)
  assert.match(header, /format binary_little_endian 1\.0/)
  assert.match(header, /element vertex 100/)
  // The 17 properties SplatMesh expects.
  assert.match(header, /property float f_dc_0/)
  assert.match(header, /property float rot_3/)
  const headerEnd = ply.indexOf('end_header\n') + 'end_header\n'.length
  assert.equal(ply.length - headerEnd, 100 * 17 * 4)
})

test('consecutive stub frames actually differ, so playback proves something', () => {
  // A sequence of identical frames would "play" without exercising the clock.
  const phases = [0, 0.25, 0.5, 0.75]
  const frames = phases.map(p => buildStubPly(200, p))
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      assert.ok(!frames[i].equals(frames[j]), `phases ${phases[i]} and ${phases[j]} must differ`)
    }
  }
})

test('stub mode produces a complete loadable sequence with no GPU', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '4d-stub-'))
  try {
    const seq = path.join(dir, 'sequence')
    const result = await runStub({ takeId: 'take-x', sequenceDir: seq, frameCount: 6, fps: 5 })
    assert.equal(result.status, 'ok')
    assert.equal(result.frameCount, 6)
    assert.equal(result.viewSource, 'densified')
    const files = (await readdir(seq)).sort()
    assert.equal(files.length, 6)
    assert.equal(files[0], 'frame-00000.ply')
    assert.equal(files[5], 'frame-00005.ply')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stub mode reports multi-camera when the take had several clips', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), '4d-stub-'))
  try {
    const result = await runStub({ takeId: 't', sequenceDir: path.join(dir, 's'), frameCount: 2, clipCount: 3 })
    assert.equal(result.viewSource, 'multi-camera')
    assert.equal(result.clipCount, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
