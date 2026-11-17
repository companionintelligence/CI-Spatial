/**
 * WP-A2 (F25): migrate_scan_ids must not clear session links on a guess. A
 * missing sessions directory, or a run that would clear more links than the
 * limit, is refused before the first write. A changed world is backed up first.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-migrate-guard.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertRejects } from 'jsr:@std/assert@^1.0.0/rejects'
import {
  migrateScanIds,
  SESSION_CLEAR_LIMIT,
} from '../../../server/migrations/migrate_scan_ids.ts'
import type { ScanManifest, WorldProject } from '../../../src/world/types.ts'

const FIXTURE_URL = new URL('tests/fixtures/world-scan-id-collision.json', new URL('../../../', import.meta.url))

async function fixtureText(): Promise<string> {
  return await Deno.readTextFile(FIXTURE_URL)
}

/**
 * A world of `count` scans, each holding its own phantom session link. Built
 * from the fixture world so every other field has its real shape.
 */
async function phantomWorld(count: number): Promise<WorldProject> {
  const base = JSON.parse(await fixtureText()) as WorldProject
  const template: ScanManifest = base.scans[0]
  const scans = Array.from({ length: count }, (_, i): ScanManifest => ({
    ...template,
    filename: `${1_787_000_000_000 + i}_phantom-${i}.glb`,
    scanId: `scan-phantom-${i}`,
    sessionId: `sess-phantom-${i}`,
    frameSetUrl: undefined,
  }))
  return { ...base, worldId: 'world-phantoms', shareSlug: 'phantoms', scans, editPatches: [], jobs: [] }
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-a2-migrate-' })
  try {
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

async function backupDirsIn(worldsDir: string): Promise<string[]> {
  const found: string[] = []
  for await (const entry of Deno.readDir(worldsDir)) {
    if (entry.isDirectory && entry.name.startsWith('.pre-migrate-')) found.push(entry.name)
  }
  return found
}

Deno.test('migrateScanIds guard: a missing sessions directory is refused, and nothing is written', async () => {
  await withDir(async (dir) => {
    const worldPath = `${dir}/default.json`
    const original = await fixtureText()
    await Deno.writeTextFile(worldPath, original)

    await assertRejects(
      () => migrateScanIds({ worldsDir: dir, sessionsDir: `${dir}/no-such-sessions`, log: () => {} }),
      Error,
      'does not exist',
    )

    assertEquals(await Deno.readTextFile(worldPath), original, 'the world file was rewritten')
    assertEquals(await backupDirsIn(dir), [], 'a backup was made for a run that was refused')
  })
})

Deno.test('migrateScanIds guard: a missing sessions directory is fine when no world holds a session link', async () => {
  await withDir(async (dir) => {
    const world = JSON.parse(await fixtureText()) as WorldProject
    for (const scan of world.scans) scan.sessionId = null
    await Deno.writeTextFile(`${dir}/default.json`, JSON.stringify(world, null, 2))

    const summary = await migrateScanIds({ worldsDir: dir, sessionsDir: `${dir}/no-such-sessions`, log: () => {} })

    assertEquals(summary.worlds.length, 1)
    assertEquals(summary.worlds[0].sessionsCleared.length, 0)
  })
})

Deno.test('migrateScanIds guard: clearing more links than the limit is refused without forceClear', async () => {
  await withDir(async (dir) => {
    const worldPath = `${dir}/phantoms.json`
    const original = JSON.stringify(await phantomWorld(SESSION_CLEAR_LIMIT + 2), null, 2)
    await Deno.writeTextFile(worldPath, original)
    const sessionsDir = `${dir}/sessions`
    await Deno.mkdir(sessionsDir)

    await assertRejects(
      () => migrateScanIds({ worldsDir: dir, sessionsDir, log: () => {} }),
      Error,
      '--force-clear',
    )

    assertEquals(await Deno.readTextFile(worldPath), original, 'the world file was rewritten')
    assertEquals(await backupDirsIn(dir), [], 'a backup was made for a run that was refused')
  })
})

Deno.test('migrateScanIds guard: forceClear allows the run, and the backup holds the bytes from before it', async () => {
  await withDir(async (dir) => {
    const worldPath = `${dir}/phantoms.json`
    const original = JSON.stringify(await phantomWorld(SESSION_CLEAR_LIMIT + 2), null, 2)
    await Deno.writeTextFile(worldPath, original)
    const sessionsDir = `${dir}/sessions`
    await Deno.mkdir(sessionsDir)

    const summary = await migrateScanIds({ worldsDir: dir, sessionsDir, forceClear: true, log: () => {} })

    assertEquals(summary.filesWritten, 1)
    const migrated = JSON.parse(await Deno.readTextFile(worldPath)) as WorldProject
    for (const scan of migrated.scans) assertEquals(scan.sessionId, null)

    const backups = await backupDirsIn(dir)
    assertEquals(backups.length, 1)
    assertEquals(
      await Deno.readTextFile(`${dir}/${backups[0]}/phantoms.json`),
      original,
      'the backup does not hold the world as it was before the run',
    )
  })
})

Deno.test('migrateScanIds guard: a backup is written only by a run that changes something', async () => {
  await withDir(async (dir) => {
    const fixture = await fixtureText()
    await Deno.writeTextFile(`${dir}/default.json`, fixture)

    const first = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(first.filesWritten, 1)
    assertEquals((await backupDirsIn(dir)).length, 1)

    const second = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(second.filesWritten, 0)
    assertEquals((await backupDirsIn(dir)).length, 1, 'a no-op run made a second backup')
  })
})

Deno.test('migrateScanIds guard: the backup directory is not read as a world', async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/default.json`, await fixtureText())
    await migrateScanIds({ worldsDir: dir, log: () => {} })
    assert((await backupDirsIn(dir)).length === 1)

    const again = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(again.worlds.map((w) => w.slug), ['default'])
  })
})
