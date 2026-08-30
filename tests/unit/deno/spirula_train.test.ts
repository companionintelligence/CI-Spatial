/**
 * Deno unit tests for the Spirula splat-train backend.
 *
 * Same scope and same reason as splat_train.test.ts: the real binary is a
 * Vulkan trainer that can't run in CI, so these cover the TS side only — arg
 * assembly, binary resolution, checkpoint discovery, and the skip/error/ok
 * contract the world-job coordinator depends on being identical to Brush's.
 *
 * The A/B against Brush that motivated this backend is not reproducible here
 * (it needs the GPU and a real 32-frame session); its numbers live in
 * docs/pipelines/splat-train.md — Backends.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'

import {
  buildSpirulaArgs,
  findSpirulaPly,
  resolveSpirulaParams,
  runSpirulaTrain,
  SPIRULA_CAMERA_MODEL,
} from '../../../server/splat/spirula_train.ts'

const BASE = { sessionDir: '/x/sess-1-a', outputPlyPath: '/x/a.splat.ply' }

Deno.test('resolveSpirulaParams honours explicit overrides over env defaults', () => {
  const p = resolveSpirulaParams({
    ...BASE,
    trainIters: 5000,
    shDegree: 1,
    preset: '360-camera',
    quality: 'ultra',
    device: 'NVIDIA',
  }, '/opt/spirula')
  assertEquals(p, {
    spirulaBin: '/opt/spirula',
    device: 'NVIDIA',
    trainIters: 5000,
    shDegree: 1,
    preset: '360-camera',
    quality: 'ultra',
  })
})

Deno.test('resolveSpirulaParams defaults match Brush so an A/B is like-for-like', () => {
  // 15000 iters / SH 2 are Brush's defaults, not Spirula's (30000 / 3). They
  // are deliberately mirrored: a backend switch must change the trainer, not
  // the training budget, or every comparison measures the wrong thing.
  const p = resolveSpirulaParams(BASE, '/opt/spirula')
  assertEquals(p.trainIters, 15000)
  assertEquals(p.shDegree, 2)
  assertEquals(p.preset, '3dgs')
  assertEquals(p.quality, 'medium')
  assertEquals(p.device, '')
})

Deno.test('buildSpirulaArgs assembles the headless CLI in a stable order', () => {
  const params = resolveSpirulaParams({ ...BASE, trainIters: 12000 }, '/opt/spirula')
  assertEquals(buildSpirulaArgs('/data/ds', '/data/ds/spirula-out', params), [
    'train',
    '3dgs',
    '--data', '/data/ds',
    '--data-format', 'nerfstudio',
    '--num-iterations', '12000',
    '--sh-degree', '2',
    '--quality', 'medium',
    '--output-dir-prefix', '/data/ds/spirula-out',
    '--output-dir-name', 'run',
    '--disable-viewer', '1',
    '--keep-viewer-alive', '0',
  ])
})

Deno.test('buildSpirulaArgs always disables the viewer', () => {
  // --keep-viewer-alive defaults to 1 in Spirula, i.e. the process stays up
  // serving a web viewer after training finishes. A WorldJob that spawns it
  // without these two flags never returns, so they are not optional and no
  // option may remove them.
  const args = buildSpirulaArgs('/d', '/d/out', resolveSpirulaParams(BASE, '/opt/spirula'))
  assertEquals(args[args.indexOf('--disable-viewer') + 1], '1')
  assertEquals(args[args.indexOf('--keep-viewer-alive') + 1], '0')
})

Deno.test('buildSpirulaArgs omits --device entirely when unpinned', () => {
  // Passing an empty string would be a *pin* to a device named "", not the
  // absence of one — Spirula would have to match it against its adapter list.
  const args = buildSpirulaArgs('/d', '/d/out', resolveSpirulaParams(BASE, '/opt/spirula'))
  assert(!args.includes('--device'))
  const pinned = buildSpirulaArgs('/d', '/d/out', resolveSpirulaParams({ ...BASE, device: '1' }, '/opt/spirula'))
  assertEquals(pinned[pinned.indexOf('--device') + 1], '1')
})

Deno.test('the Spirula camera model is not the one Brush wants', () => {
  // Measured, not assumed: `spirula train --data-format nerfstudio` exits 1
  // with "NerfstudioParser: unsupported camera model PERSPECTIVE" on the exact
  // transforms.json Brush trains on. This constant is the whole reason
  // buildBrushDataset gained a `cameraModel` option.
  assertEquals(SPIRULA_CAMERA_MODEL, 'OPENCV')
})

Deno.test('findSpirulaPly picks the highest step checkpoint', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  for (const step of ['step-000002000.ckpt', 'step-000015000.ckpt', 'step-000009000.ckpt']) {
    await Deno.mkdir(`${tmp}/${step}`, { recursive: true })
    await Deno.writeTextFile(`${tmp}/${step}/splat.ply`, 'ply\n')
  }
  // A checkpoint dir whose splat.ply never landed must not win despite the
  // higher step — that is the "trained but nothing landed" case, and silently
  // selecting it would hide it.
  await Deno.mkdir(`${tmp}/step-000030000.ckpt`, { recursive: true })
  // Not a checkpoint at all.
  await Deno.mkdir(`${tmp}/eval`, { recursive: true })

  const found = await findSpirulaPly(tmp)
  assertEquals(found?.step, 15000)
  assertEquals(found?.path, `${tmp}/step-000015000.ckpt/splat.ply`)
  assertEquals(await findSpirulaPly(`${tmp}/nope`), null)
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSpirulaTrain returns a skipped result when the binary is missing', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  const sessionDir = `${tmp}/sess-test-abcd`
  await Deno.mkdir(sessionDir, { recursive: true })
  const result = await runSpirulaTrain({
    sessionDir,
    outputPlyPath: `${tmp}/out.splat.ply`,
    spirulaBin: '/this/binary/definitely/does/not/exist',
  })
  assertEquals(result.status, 'skipped')
  assertEquals(result.exitCode, 0)
  assert(result.manifest.skippedReason?.includes('Spirula binary not found'))
  // The remediation must name the download, never a build: this repo may only
  // invoke a prebuilt GPL binary out-of-process (see spirula_train.ts header).
  assert(result.manifest.remediation?.includes('releases'))
  assert(!/cargo|build from source/i.test(result.manifest.remediation ?? ''))
  const written = JSON.parse(await Deno.readTextFile(`${tmp}/out.splat-train.manifest.json`))
  assertEquals(written.status, 'skipped')
  assertEquals(written.tool, 'spirula')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSpirulaTrain rejects an invalid session dir without spawning', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  const result = await runSpirulaTrain({
    sessionDir: '/etc',
    outputPlyPath: `${tmp}/out.splat.ply`,
    spirulaBin: Deno.execPath(),
    _spawn: () => {
      throw new Error('must not spawn for an invalid session dir')
    },
  })
  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 2)
  assert(result.manifest.error?.includes('invalid session directory'))
  await Deno.remove(tmp, { recursive: true })
})

/** Minimal one-keyframe session: a 2x2 baseline JPEG plus a posed record. */
async function writeTinySession(sessionDir: string): Promise<void> {
  await Deno.mkdir(sessionDir, { recursive: true })
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ])
  await Deno.writeFile(`${sessionDir}/kf-00000.jpg`, jpeg)
  await Deno.writeTextFile(
    `${sessionDir}/keyframes.jsonl`,
    JSON.stringify({
      index: 0,
      file: 'kf-00000.jpg',
      pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      intrinsics: { width: 2, height: 2, fovYDeg: 55 },
    }) + '\n',
  )
}

Deno.test('runSpirulaTrain lands the PLY + writes an ok manifest via an injected spawn', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  const sessionDir = `${tmp}/sess-test-wxyz`
  await writeTinySession(sessionDir)

  const outputPlyPath = `${tmp}/scan.splat.ply`
  let seenDataset = ''
  const result = await runSpirulaTrain({
    sessionDir,
    outputPlyPath,
    spirulaBin: Deno.execPath(), // exists + executable so the guard passes
    provenance: { sessionId: 'sess-test-wxyz', scanId: 'scan-1' },
    // Fake the run: write a tiny valid 3DGS PLY into a checkpoint dir, exactly
    // where the real binary puts it.
    _spawn: async (_bin, args) => {
      seenDataset = args[args.indexOf('--data') + 1]
      const prefix = args[args.indexOf('--output-dir-prefix') + 1]
      const ckpt = `${prefix}/run/step-000015000.ckpt`
      await Deno.mkdir(ckpt, { recursive: true })
      await Deno.writeTextFile(
        `${ckpt}/splat.ply`,
        'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nend_header\n',
      )
      return { code: 0, stderr: '' }
    },
  })

  assertEquals(result.status, 'ok')
  assertEquals(result.gaussianCount, 3)
  assertEquals(result.plyPath, outputPlyPath)
  assertEquals(new TextDecoder().decode((await Deno.readFile(outputPlyPath)).subarray(0, 3)), 'ply')

  // Its own dataset dir, so a Brush run on the same session is not clobbered:
  // the two backends disagree about camera_model and share nothing else.
  assertEquals(seenDataset, `${sessionDir}/spirula-dataset`)
  const transforms = JSON.parse(await Deno.readTextFile(`${sessionDir}/spirula-dataset/transforms.json`))
  assertEquals(transforms.camera_model, 'OPENCV')

  const manifest = JSON.parse(await Deno.readTextFile(`${tmp}/scan.splat-train.manifest.json`))
  assertEquals(manifest.tool, 'spirula')
  assertEquals(manifest.status, 'ok')
  assertEquals(manifest.gaussianCount, 3)
  assertEquals(manifest.frameCount, 1)
  assertEquals(manifest.sessionId, 'sess-test-wxyz')
  assert(typeof manifest.timing?.elapsedMs === 'number')
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSpirulaTrain keeps the stderr tail on a non-zero exit', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  const sessionDir = `${tmp}/sess-test-fail`
  await writeTinySession(sessionDir)

  const result = await runSpirulaTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    spirulaBin: Deno.execPath(),
    _spawn: () =>
      Promise.resolve({
        code: 1,
        stderr: 'error: NerfstudioParser: unsupported camera model PERSPECTIVE',
        stdout: 'Devices:\n  * [1] NVIDIA GeForce RTX 4080',
      }),
  })

  assertEquals(result.status, 'error')
  assertEquals(result.exitCode, 1)
  // A bare "spirula exited 1" is the end of the trail for anyone reading the
  // manifest later — the diagnosis has to be IN it, same as splat_train.ts.
  assert(result.manifest.error?.includes('unsupported camera model'))
  assert(result.manifest.remediation?.includes('--data-format nerfstudio'))
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSpirulaTrain falls back to stdout when a failure left stderr empty', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  const sessionDir = `${tmp}/sess-test-quiet`
  await writeTinySession(sessionDir)

  const result = await runSpirulaTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    spirulaBin: Deno.execPath(),
    // Spirula's progress and its device list go to stdout; only the diagnosis
    // goes to stderr. When a run dies without writing one, stdout is all the
    // evidence there is, and dropping it leaves the manifest saying nothing.
    _spawn: () => Promise.resolve({ code: 101, stderr: '   ', stdout: 'out of device memory while densifying' }),
  })

  assertEquals(result.status, 'error')
  assert(result.manifest.error?.includes('out of device memory'))
  await Deno.remove(tmp, { recursive: true })
})

Deno.test('runSpirulaTrain reports an ok-but-empty run rather than a false success', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'spirula-test-' })
  const sessionDir = `${tmp}/sess-test-empty`
  await writeTinySession(sessionDir)

  const result = await runSpirulaTrain({
    sessionDir,
    outputPlyPath: `${tmp}/scan.splat.ply`,
    spirulaBin: Deno.execPath(),
    _spawn: () => Promise.resolve({ code: 0, stderr: '' }),
  })

  assertEquals(result.status, 'error')
  assert(result.manifest.error?.includes('produced no splat.ply'))
  await Deno.remove(tmp, { recursive: true })
})
