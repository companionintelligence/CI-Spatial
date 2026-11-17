/**
 * WP-A2 (F33): a LingBot cloud that its own run judged collapsed must not seed
 * the splat. The file stays on disk, so the dataset builder has to read the
 * verdict. Only an explicit degenerate verdict rejects the cloud.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-seed-verdict.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { buildBrushDataset, lingBotCloudCollapsed, SEED_CLOUDS } from '../../../server/splat/splat_train_dataset.ts'

async function withSession(manifest: unknown | null, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-a2-seed-' })
  try {
    if (manifest !== null) {
      await Deno.writeTextFile(
        `${dir}/lingbot-map.manifest.json`,
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      )
    }
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('seed verdict: a LingBot cloud judged degenerate is rejected as a seed', async () => {
  await withSession({ status: 'error', quality: { degenerate: true, status: 'needs-rescan' } }, async (dir) => {
    assertEquals(await lingBotCloudCollapsed(dir), true)
  })
})

Deno.test('seed verdict: a LingBot cloud judged ready is kept as a seed', async () => {
  await withSession({ status: 'ok', quality: { degenerate: false, status: 'ready' } }, async (dir) => {
    assertEquals(await lingBotCloudCollapsed(dir), false)
  })
})

Deno.test('seed verdict: a manifest from before the verdict existed is not rejected on that account', async () => {
  await withSession({ status: 'ok', pointCount: 1234 }, async (dir) => {
    assertEquals(await lingBotCloudCollapsed(dir), false)
  })
})

Deno.test('seed verdict: an unreadable manifest is not rejected', async () => {
  await withSession('{ not json', async (dir) => {
    assertEquals(await lingBotCloudCollapsed(dir), false)
  })
  await withSession(null, async (dir) => {
    assertEquals(await lingBotCloudCollapsed(dir), false)
  })
})

Deno.test('seed verdict: the LingBot cloud is still the seed of last resort, in the same order as before', () => {
  assertEquals(SEED_CLOUDS, ['colmap.point-cloud.ply', 'lingbot-map.point-cloud.ply'])
})

// ── Dataset level: does the verdict reach the Brush seed file? ───────────────

/** 2×2 baseline JPEG (SOF0), enough for the dataset reader to take its size. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
])

/**
 * A session with two posed keyframes, a LingBot cloud and no COLMAP cloud, so
 * the LingBot cloud is the only seed candidate. `manifest` null = no manifest.
 */
async function datasetSession(tmp: string, manifest: unknown | null): Promise<string> {
  const sessionDir = `${tmp}/sess-seed-verdict`
  await Deno.mkdir(sessionDir, { recursive: true })
  for (const file of ['kf-00000.jpg', 'kf-00001.jpg']) {
    await Deno.writeFile(`${sessionDir}/${file}`, TINY_JPEG)
  }
  const lines = [0, 1].map((i) =>
    JSON.stringify({
      index: i,
      file: `kf-${String(i).padStart(5, '0')}.jpg`,
      pose: { position: { x: i, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      intrinsics: { width: 2, height: 2, fovYDeg: 55 },
    })
  )
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, lines.join('\n') + '\n')
  await Deno.writeTextFile(
    `${sessionDir}/lingbot-map.point-cloud.ply`,
    'ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n',
  )
  if (manifest !== null) {
    await Deno.writeTextFile(`${sessionDir}/lingbot-map.manifest.json`, JSON.stringify(manifest))
  }
  return sessionDir
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

Deno.test('seed verdict: a degenerate LingBot manifest leaves the LingBot seed file absent from the dataset', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'wp-a2-seed-dataset-' })
  try {
    const sessionDir = await datasetSession(tmp, {
      status: 'error',
      quality: { degenerate: true, status: 'needs-rescan' },
    })
    const datasetDir = `${tmp}/brush-dataset`
    const result = await buildBrushDataset({ sessionDir, datasetDir })

    assertEquals(result.frameCount, 2, 'the frames themselves are still written')
    assertEquals(result.seedPlyPath, undefined)
    assertEquals(await exists(`${datasetDir}/sparse_pc.ply`), false)
    const transforms = JSON.parse(await Deno.readTextFile(`${datasetDir}/transforms.json`))
    assertEquals(transforms.ply_file_path, undefined)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('seed verdict: the same session with a ready LingBot verdict seeds the dataset from its cloud', async () => {
  // The control for the test above: the absence there is the verdict's doing.
  const tmp = await Deno.makeTempDir({ prefix: 'wp-a2-seed-dataset-' })
  try {
    const sessionDir = await datasetSession(tmp, { status: 'ok', quality: { degenerate: false, status: 'ready' } })
    const datasetDir = `${tmp}/brush-dataset`
    const result = await buildBrushDataset({ sessionDir, datasetDir })

    assertEquals(result.seedPlyPath, `${datasetDir}/sparse_pc.ply`)
    assertEquals(await exists(`${datasetDir}/sparse_pc.ply`), true)
    const transforms = JSON.parse(await Deno.readTextFile(`${datasetDir}/transforms.json`))
    assertEquals(transforms.ply_file_path, 'sparse_pc.ply')
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
