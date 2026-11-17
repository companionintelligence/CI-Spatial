/**
 * WP-A2 (F33): a LingBot run that finished is not yet a result. Its cloud is
 * judged against its own camera walk, and a collapsed or near-empty cloud comes
 * back as an error, with the verdict written to the manifest.
 *
 * The end-to-end tests use a stand-in worker (a shell script that copies
 * fixtures into the session), so no model or GPU is needed.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-lingbot-quality.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import {
  assessLingBotQuality,
  DEFAULT_LINGBOT_QUALITY_THRESHOLDS,
  lingBotDegenerateReport,
  runLingBotMapReconstruction,
} from '../../../server/lingbot-map/lingbot_map.ts'
import { lingBotCloudCollapsed } from '../../../server/splat/splat_train_dataset.ts'
import { degenerateCloudRefusal } from '../../../server/wp-a-cloud-verdict.ts'
import { whichPath } from '../../../server/exec_probe.ts'

// ── Pure verdict ─────────────────────────────────────────────────────────────

Deno.test('lingbot quality: a healthy run is ready, and its ratio is on the record', () => {
  const q = assessLingBotQuality({ pointCount: 2_400_000, frameCount: 16, cloudExtent: 6, cameraBaseline: 2.5 })
  assertEquals(q.degenerate, false)
  assertEquals(q.status, 'ready')
  assertEquals(q.reasons, [])
  assertEquals(q.extentRatio, 2.4)
  assertEquals(q.thresholds, DEFAULT_LINGBOT_QUALITY_THRESHOLDS)
})

Deno.test('lingbot quality: the August collapse, a 3.7 cm cube made of 2.4M points, is degenerate', () => {
  // The count passes any sensible floor. Only the extent sees the collapse.
  const cubeDiagonal = Math.hypot(0.037, 0.037, 0.037)
  const q = assessLingBotQuality({
    pointCount: 2_436_672,
    frameCount: 16,
    cloudExtent: cubeDiagonal,
    cameraBaseline: 2.5,
  })
  assertEquals(q.degenerate, true)
  assertEquals(q.status, 'needs-rescan')
  assertEquals(q.reasons, ['collapsed-extent'])
})

Deno.test('lingbot quality: an empty cloud is degenerate on both counts', () => {
  const q = assessLingBotQuality({ pointCount: 0, frameCount: 16, cloudExtent: 0, cameraBaseline: 2.5 })
  assertEquals(q.degenerate, true)
  assertEquals(q.reasons, ['too-few-points', 'collapsed-extent'])
})

Deno.test('lingbot quality: with no camera walk to measure against, the extent is not judged', () => {
  const q = assessLingBotQuality({ pointCount: 50_000, frameCount: 16, cloudExtent: 0.001, cameraBaseline: null })
  assertEquals(q.degenerate, false)
  assertEquals(q.extentRatio, null)
  assertEquals(q.cameraBaseline, null)
})

Deno.test('lingbot quality: a cameraBaseline of zero is "not measured", not a divide by zero', () => {
  const q = assessLingBotQuality({ pointCount: 50_000, frameCount: 16, cloudExtent: 1, cameraBaseline: 0 })
  assertEquals(q.extentRatio, null)
  assertEquals(q.degenerate, false)
})

Deno.test('lingbot quality: a sparse cloud is too few points even when its extent is fine', () => {
  const q = assessLingBotQuality({ pointCount: 800, frameCount: 16, cloudExtent: 6, cameraBaseline: 2.5 })
  assertEquals(q.pointsPerFrame, 50)
  assertEquals(q.reasons, ['too-few-points'])
})

Deno.test('lingbot quality: a missing frame count is judged as one frame, not as zero', () => {
  const q = assessLingBotQuality({ pointCount: 50, frameCount: 0, cloudExtent: 6, cameraBaseline: 2.5 })
  assertEquals(q.pointsPerFrame, 50)
  assertEquals(q.reasons, ['too-few-points'])
})

Deno.test('lingbot quality: a ratio exactly at the floor is not collapsed; just under it is', () => {
  const atFloor = assessLingBotQuality({ pointCount: 50_000, frameCount: 16, cloudExtent: 0.2, cameraBaseline: 2 })
  assertEquals(atFloor.extentRatio, 0.1)
  assertEquals(atFloor.degenerate, false)
  const under = assessLingBotQuality({ pointCount: 50_000, frameCount: 16, cloudExtent: 0.199, cameraBaseline: 2 })
  assertEquals(under.reasons, ['collapsed-extent'])
})

Deno.test('lingbot quality: the report names the measured numbers and the floor, and says how to re-scan', () => {
  const q = assessLingBotQuality({
    pointCount: 2_436_672,
    frameCount: 16,
    cloudExtent: Math.hypot(0.037, 0.037, 0.037),
    cameraBaseline: 2.5,
  })
  const report = lingBotDegenerateReport(q)
  assertStringIncludes(report.error, 'collapsed')
  assertStringIncludes(report.error, '3%')
  assertStringIncludes(report.error, 'at least 10%')
  assertStringIncludes(report.remediation, 'Re-scan')
  assert(!report.error.includes('undefined') && !report.remediation.includes('undefined'))
})

// ── End to end, through a stand-in worker ────────────────────────────────────

const SH = await whichPath('sh')
const SLEEP = await whichPath('sleep')
const isWindows = Deno.build.os === 'windows'

/** A binary PLY of xyz float32 points, in the layout the LingBot worker writes. */
function plyFile(points: Array<[number, number, number]>): Uint8Array {
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${points.length}`,
    'property float x',
    'property float y',
    'property float z',
    'end_header',
    '',
  ].join('\n')
  const head = new TextEncoder().encode(header)
  const body = new Uint8Array(points.length * 12)
  const view = new DataView(body.buffer)
  points.forEach(([x, y, z], i) => {
    view.setFloat32(i * 12, x, true)
    view.setFloat32(i * 12 + 4, y, true)
    view.setFloat32(i * 12 + 8, z, true)
  })
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

/** `frames` camera poses walking `step` metres apart along x, as OpenCV world-to-camera rows. */
function posesJson(frames: number, step: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    frames: Array.from({ length: frames }, (_, i) => ({
      index: i,
      file: `kf-${String(i).padStart(5, '0')}.jpg`,
      cameraToWorld: [[1, 0, 0, -i * step], [0, 1, 0, 0], [0, 0, 1, 0]],
    })),
  })
}

function manifestJson(pointCount: number, frameCount: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    tool: 'lingbot-map',
    status: 'ok',
    frameCount,
    pointCount,
    params: { resolvedDevice: 'cpu', deviceVendor: 'CPU' },
  })
}

/** Points inside the 3.7 cm cube the August audit recorded. */
function collapsedCloud(n: number): Array<[number, number, number]> {
  return Array.from({ length: n }, (_, i) => [
    0.0465 + ((i * 37) % 100) / 100 * 0.037,
    -0.0113 + ((i * 53) % 100) / 100 * 0.0364,
    -0.0916 + ((i * 71) % 100) / 100 * 0.0367,
  ] as [number, number, number])
}

/** Points spread across a room about 6 m by 2 m by 4 m. */
function roomCloud(n: number): Array<[number, number, number]> {
  return Array.from({ length: n }, (_, i) => [
    -3 + ((i * 37) % 100) / 100 * 6,
    -1 + ((i * 53) % 100) / 100 * 2,
    -2 + ((i * 71) % 100) / 100 * 4,
  ] as [number, number, number])
}

interface Fixture {
  root: string
  sessionDir: string
  worker: string
}

/**
 * A session directory and a worker script. The worker copies the fixture files
 * named in `files` into the session, as the real worker would write them.
 */
async function fixtureSession(files: Record<string, Uint8Array | string | null>): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: 'wp-a2-lingbot-' })
  const sessionDir = `${root}/sess-lingbot-wp-a2-0001`
  await Deno.mkdir(sessionDir, { recursive: true })
  const fx = `${root}/fx`
  await Deno.mkdir(fx)
  const copies: string[] = []
  for (const [name, body] of Object.entries(files)) {
    if (body === null) continue
    const src = `${fx}/${name}`
    if (typeof body === 'string') await Deno.writeTextFile(src, body)
    else await Deno.writeFile(src, body)
    const dest = name.startsWith('manifest')
      ? 'lingbot-map.manifest.json'
      : name.startsWith('poses')
      ? 'lingbot-map.poses.json'
      : 'lingbot-map.point-cloud.ply'
    copies.push(`cp '${src}' '${sessionDir}/${dest}'`)
  }
  const worker = `${root}/worker.sh`
  await Deno.writeTextFile(worker, ['#!/bin/sh', ...copies, 'exit 0', ''].join('\n'))
  return { root, sessionDir, worker }
}

Deno.test({
  name: 'lingbot run: a collapsed cloud comes back as an error, and the manifest says why',
  ignore: isWindows || SH === null,
  fn: async () => {
    const fixture = await fixtureSession({
      'cloud.ply': plyFile(collapsedCloud(2000)),
      'poses.json': posesJson(16, 0.15),
      'manifest.json': manifestJson(2000, 16),
    })
    try {
      const result = await runLingBotMapReconstruction({
        sessionDir: fixture.sessionDir,
        scriptPath: fixture.worker,
        python: SH!,
        device: 'cpu',
      })

      assertEquals(result.status, 'error')
      assertEquals(result.quality?.degenerate, true)
      assertEquals(result.quality?.reasons, ['collapsed-extent'])
      assertStringIncludes(result.error ?? '', 'collapsed')
      assertEquals(result.pointCloudFile, undefined)

      const manifest = JSON.parse(await Deno.readTextFile(`${fixture.sessionDir}/lingbot-map.manifest.json`))
      assertEquals(manifest.status, 'error')
      assertEquals(manifest.quality.degenerate, true)
      assert(typeof manifest.remediation === 'string' && manifest.remediation.length > 0)
      // The fix is held once, in `remediation`, and not repeated inside `error`.
      assertStringIncludes(manifest.error, 'collapsed')
      assert(!manifest.error.includes(manifest.remediation))
      assertEquals(result.remediation, manifest.remediation)
      assert(!(result.error ?? '').includes(manifest.remediation))
    } finally {
      await Deno.remove(fixture.root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'lingbot run: a healthy cloud stays ok, and the manifest records its verdict',
  ignore: isWindows || SH === null,
  fn: async () => {
    const fixture = await fixtureSession({
      'cloud.ply': plyFile(roomCloud(2000)),
      'poses.json': posesJson(16, 0.15),
      'manifest.json': manifestJson(2000, 16),
    })
    try {
      const result = await runLingBotMapReconstruction({
        sessionDir: fixture.sessionDir,
        scriptPath: fixture.worker,
        python: SH!,
        device: 'cpu',
      })

      assertEquals(result.status, 'ok', `expected ok, got ${result.status}: ${result.error}`)
      assertEquals(result.quality?.degenerate, false)
      assertEquals(result.pointCloudFile, 'lingbot-map.point-cloud.ply')

      const manifest = JSON.parse(await Deno.readTextFile(`${fixture.sessionDir}/lingbot-map.manifest.json`))
      assertEquals(manifest.status, 'ok')
      assertEquals(manifest.quality.status, 'ready')
    } finally {
      await Deno.remove(fixture.root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'lingbot run: an ok run whose cloud cannot be read is left ok, but says it was not measured',
  ignore: isWindows || SH === null,
  fn: async () => {
    const fixture = await fixtureSession({
      'poses.json': posesJson(16, 0.15),
      'manifest.json': manifestJson(2000, 16),
    })
    try {
      const result = await runLingBotMapReconstruction({
        sessionDir: fixture.sessionDir,
        scriptPath: fixture.worker,
        python: SH!,
        device: 'cpu',
      })

      assertEquals(result.status, 'ok')
      assertEquals(result.quality, undefined)
      assertStringIncludes(result.qualityError ?? '', 'could not measure')
    } finally {
      await Deno.remove(fixture.root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'lingbot run: a worker past LINGBOT_MAP_TIMEOUT_MS is stopped, and its stale ok manifest is replaced',
  ignore: isWindows || SLEEP === null,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'wp-a2-lingbot-' })
    const sessionDir = `${root}/sess-lingbot-wp-a2-0002`
    await Deno.mkdir(sessionDir, { recursive: true })
    // A manifest left by an earlier run that said ok. A killed worker must not
    // let that stand as this run's result.
    await Deno.writeTextFile(`${sessionDir}/lingbot-map.manifest.json`, manifestJson(2000, 16))
    const worker = `${root}/hang.sh`
    await Deno.writeTextFile(worker, `#!/bin/sh\nexec sleep 30\n`)
    const previous = Deno.env.get('LINGBOT_MAP_TIMEOUT_MS')
    try {
      Deno.env.set('LINGBOT_MAP_TIMEOUT_MS', '300')
      const started = performance.now()
      const result = await runLingBotMapReconstruction({
        sessionDir,
        scriptPath: worker,
        python: SH!,
        device: 'cpu',
      })
      const took = performance.now() - started

      assertEquals(result.status, 'error')
      assertStringIncludes(result.error ?? '', 'timed out after 300 ms and was stopped')
      assert(took < 10_000, `took ${took}ms, so the worker was not stopped`)

      // The earlier run's `ok` must not outlive this one: the file now records the timeout.
      const manifest = JSON.parse(await Deno.readTextFile(`${sessionDir}/lingbot-map.manifest.json`))
      assertEquals(manifest.status, 'error')
      assertEquals(manifest.reason, 'timeout')
      assertStringIncludes(manifest.error, 'timed out after 300 ms')
    } finally {
      if (previous === undefined) Deno.env.delete('LINGBOT_MAP_TIMEOUT_MS')
      else Deno.env.set('LINGBOT_MAP_TIMEOUT_MS', previous)
      await Deno.remove(root, { recursive: true })
    }
  },
})

Deno.test({
  name: 'lingbot run: a timeout after a degenerate run keeps the cloud refused, with its fix on the record',
  ignore: isWindows || SH === null || SLEEP === null,
  fn: async () => {
    // The verdict from the degenerate run is what keeps its collapsed cloud out of
    // the splat seed, the detect input and the artifact route. The cloud is still on
    // disk after a later run times out, so the timeout must not erase the verdict.
    const fixture = await fixtureSession({
      'cloud.ply': plyFile(collapsedCloud(2000)),
      'poses.json': posesJson(16, 0.15),
      'manifest.json': manifestJson(2000, 16),
    })
    const hang = `${fixture.root}/hang.sh`
    await Deno.writeTextFile(hang, `#!/bin/sh\nexec sleep 30\n`)
    const previous = Deno.env.get('LINGBOT_MAP_TIMEOUT_MS')
    try {
      const degenerate = await runLingBotMapReconstruction({
        sessionDir: fixture.sessionDir,
        scriptPath: fixture.worker,
        python: SH!,
        device: 'cpu',
      })
      assertEquals(degenerate.quality?.degenerate, true)

      Deno.env.set('LINGBOT_MAP_TIMEOUT_MS', '300')
      const timedOut = await runLingBotMapReconstruction({
        sessionDir: fixture.sessionDir,
        scriptPath: hang,
        python: SH!,
        device: 'cpu',
      })
      assertStringIncludes(timedOut.error ?? '', 'timed out after 300 ms and was stopped')

      assertEquals(await lingBotCloudCollapsed(fixture.sessionDir), true)
      const manifest = JSON.parse(await Deno.readTextFile(`${fixture.sessionDir}/lingbot-map.manifest.json`))
      const refusal = degenerateCloudRefusal(manifest)
      assert(refusal !== null, 'the collapsed cloud must still be refused')
      assertEquals(refusal.reasons, ['collapsed-extent'])
      assertEquals(refusal.remediation, degenerate.remediation)
      // This run's own outcome is still what the file records, and it no longer says ok.
      assertEquals(manifest.status, 'error')
      assertEquals(manifest.reason, 'timeout')
    } finally {
      if (previous === undefined) Deno.env.delete('LINGBOT_MAP_TIMEOUT_MS')
      else Deno.env.set('LINGBOT_MAP_TIMEOUT_MS', previous)
      await Deno.remove(fixture.root, { recursive: true })
    }
  },
})
