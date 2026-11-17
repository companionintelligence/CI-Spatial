/**
 * WP-J (J11): a run that its deadline stopped is reported as a timeout, and the
 * message names the stage that was stopped, for each spawn-seam runner.
 *
 * The seam stands in for the deadline. It returns the same `timeoutReason` that
 * run_with_deadline.ts returns when it kills a child, so the mapping from that
 * reason to the manifest is what is under test. No binary runs here.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j-runner-timeouts.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import { runSplatTrain } from '../../../server/splat/splat_train.ts'
import { runSpirulaTrain } from '../../../server/splat/spirula_train.ts'
import { runSplatDetect } from '../../../server/splat/splat_detect.ts'
import { runSplatFinish } from '../../../server/splat/splat_finish.ts'
import { runPanopticScan } from '../../../server/panoptic/panoptic_scan.ts'
import { runColmapPoses } from '../../../server/colmap/colmap_poses.ts'

/** 2×2 baseline JPEG (SOF0), enough for the dataset reader to take its size. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
])

const EMPTY_PLY = 'ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n'

/** One posed keyframe, enough for the splat dataset builder. */
async function writeTinySession(sessionDir: string): Promise<void> {
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
}

Deno.test('splat-train: a Brush run the deadline stopped is reported as a timeout, naming Brush', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const sessionDir = `${tmp}/sess-wp-j-brush-0001`
    await writeTinySession(sessionDir)
    const result = await runSplatTrain({
      sessionDir,
      outputPlyPath: `${tmp}/scan.splat.ply`,
      brushBin: Deno.execPath(), // exists + executable so the guard passes
      _spawn: () => Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 1 h' }),
    })

    assertEquals(result.status, 'error')
    assertEquals(result.manifest.error, 'brush timed out after 1 h and was stopped')
    assertStringIncludes(result.manifest.remediation ?? '', 'time budget')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('spirula: a run the deadline stopped is reported as a timeout, naming Spirula', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const sessionDir = `${tmp}/sess-wp-j-spirula-0001`
    await writeTinySession(sessionDir)
    const result = await runSpirulaTrain({
      sessionDir,
      outputPlyPath: `${tmp}/scan.splat.ply`,
      spirulaBin: Deno.execPath(),
      _spawn: () => Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 3 h' }),
    })

    assertEquals(result.status, 'error')
    assertEquals(result.manifest.error, 'spirula timed out after 3 h and was stopped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('splat-detect: the analyzer stopped by the deadline is reported as a timeout, naming the analyzer', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const detectDir = `${tmp}/analyzer`
    await Deno.mkdir(detectDir, { recursive: true })
    await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
    const splatPlyPath = `${tmp}/scan.splat.ply`
    await Deno.writeTextFile(splatPlyPath, 'ply\n')
    const result = await runSplatDetect({
      splatPlyPath,
      outputInteractionsPath: `${tmp}/scan.interactions.json`,
      python: Deno.execPath(),
      detectDir,
      _spawn: () => Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 1 h' }),
    })

    assertEquals(result.status, 'error')
    assertEquals(result.manifest.error, 'splat-analyzer timed out after 1 h and was stopped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('splat-detect: the point-cloud converter stopped by the deadline is reported as a timeout', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const detectDir = `${tmp}/analyzer`
    await Deno.mkdir(detectDir, { recursive: true })
    await Deno.writeTextFile(`${detectDir}/run_local.py`, '# stub')
    const sessionDir = `${tmp}/sess-wp-j-detect-0001`
    await Deno.mkdir(sessionDir, { recursive: true })
    await Deno.writeTextFile(`${sessionDir}/lingbot-map.point-cloud.ply`, EMPTY_PLY)
    const result = await runSplatDetect({
      sessionDir,
      outputInteractionsPath: `${tmp}/scan.interactions.json`,
      python: Deno.execPath(),
      detectDir,
      // No splat, so the converter runs first. It is the stage that is stopped.
      _spawn: (_bin, args) => {
        if (args[0].endsWith('pointcloud_to_gs.py')) {
          return Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 1 h' })
        }
        return Promise.reject(new Error('the analyzer must not run after a stopped converter'))
      },
    })

    assertEquals(result.status, 'error')
    assertEquals(result.manifest.error, 'pointcloud_to_gs timed out after 1 h and was stopped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('splat-finish: a splat-transform leg the deadline stopped is reported as a timeout, naming the leg', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const splatPlyPath = `${tmp}/scan.splat.ply`
    await Deno.writeTextFile(splatPlyPath, EMPTY_PLY)
    const cliPath = `${tmp}/cli.mjs`
    await Deno.writeTextFile(cliPath, '// stand-in for splat-transform')
    const result = await runSplatFinish({
      splatPlyPath,
      outputSogPath: `${tmp}/scan.sog`,
      outputCompressedPlyPath: `${tmp}/scan.compressed.ply`,
      nodeBin: Deno.execPath(),
      cliPath,
      _spawn: () => Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 1 h' }),
    })

    assertEquals(result.status, 'error')
    assertEquals(result.manifest.error, 'splat-transform (sog) timed out after 1 h and was stopped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('panoptic: a worker the deadline stopped is reported as a timeout, naming the worker', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const panopticDir = `${tmp}/panoptic`
    await Deno.mkdir(panopticDir, { recursive: true })
    await Deno.writeTextFile(`${panopticDir}/panoptic_worker.py`, '# stub')
    const sessionDir = `${tmp}/sess-wp-j-panoptic-0001`
    await Deno.mkdir(sessionDir, { recursive: true })
    await Deno.writeFile(`${sessionDir}/kf-00000.jpg`, TINY_JPEG)
    const manifest = await runPanopticScan({
      sessionDir,
      python: Deno.execPath(),
      panopticDir,
      device: 'cpu',
      thingLabelsPath: '', // no thing list needed for this path
      _spawn: () => Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 1 h' }),
    })

    assertEquals(manifest.status, 'error')
    assert(manifest.error?.startsWith('panoptic worker timed out after 1 h and was stopped'), `error was: ${manifest.error}`)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('colmap-poses: a COLMAP step the deadline stopped is reported as a timeout, naming the step', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-j-timeouts-' })
  try {
    const sessionDir = `${tmp}/sess-wp-j-colmap-0001`
    await Deno.mkdir(sessionDir, { recursive: true })
    for (let i = 0; i < 3; i++) {
      await Deno.writeFile(`${sessionDir}/kf-${String(i).padStart(5, '0')}.jpg`, TINY_JPEG)
    }
    const result = await runColmapPoses({
      sessionDir,
      colmapBin: Deno.execPath(), // an explicit, runnable binary, so no PATH probe runs
      _spawn: () => Promise.resolve({ code: 137, stderr: '', timeoutReason: 'timed out after 2 h' }),
    })

    assertEquals(result.status, 'error')
    assertEquals(result.manifest.error, 'feature_extractor timed out after 2 h and was stopped')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
