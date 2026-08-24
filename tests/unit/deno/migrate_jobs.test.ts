/**
 * Deno unit + fixture tests for migrate_jobs.ts — the one-shot
 * jobs.json → WorldJob migration ticket
 * docs/factory/01-merge-jobs/0005-retire-jobqueue.md adds.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { migrateJobsToWorldJob, worldJobFromLegacyJob } from '../../../server/migrations/migrate_jobs.ts'
import type { Job } from '../../../jobs.ts'
import type { WorldProject } from '../../../src/world/types.ts'

function makeLegacyJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    type: 'optimize-scan',
    target: 'a.glb',
    status: 'done',
    createdAt: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:01.000Z',
    finishedAt: '2026-08-01T00:00:05.000Z',
    ...overrides,
  }
}

function makeWorldFixture(overrides: Partial<WorldProject> = {}): WorldProject {
  const geoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
  return {
    worldId: 'world-default',
    name: 'Default World Scan',
    shareSlug: 'default',
    projectId: null,
    originGeoPose: geoPose,
    localFrame: { type: 'ENU_Y_UP', origin: geoPose, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [],
    things: [],
    thingObservations: [],
    members: [],
    jobs: [],
    editPatches: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

// ── Pure translation ───────────────────────────────────────────────────────

Deno.test('worldJobFromLegacyJob: maps a completed job per the ADR 0003 field table', () => {
  const legacy = makeLegacyJob({
    id: 'job-legacy-done',
    target: 'living-room.glb',
    status: 'done',
    note: '4096 KB -> 812 KB (20%) + 3 LODs',
  })
  const wj = worldJobFromLegacyJob(legacy, 'world-default')

  assertEquals(wj.jobId, 'job-legacy-done') // reused verbatim, for idempotency
  assertEquals(wj.worldId, 'world-default')
  assertEquals(wj.type, 'optimize-scan')
  assertEquals(wj.status, 'completed')
  assertEquals(wj.scanId, undefined)
  assertEquals(wj.payload, { filename: 'living-room.glb' })
  assertEquals(wj.progress, 1)
  assertEquals(wj.createdAt, legacy.createdAt)
  assertEquals(wj.updatedAt, legacy.finishedAt)
  assertEquals(wj.result, '4096 KB -> 812 KB (20%) + 3 LODs')
  assertEquals(wj.error, undefined)
  assertEquals(wj.workerId, 'local-coordinator')
})

Deno.test('worldJobFromLegacyJob: maps an errored job, carrying the error through', () => {
  const legacy = makeLegacyJob({
    id: 'job-legacy-error',
    target: 'broken.glb',
    status: 'error',
    error: 'GLB has no scene graph',
    note: undefined,
  })
  const wj = worldJobFromLegacyJob(legacy, 'world-default')

  assertEquals(wj.status, 'failed')
  assertEquals(wj.error, 'GLB has no scene graph')
  assertEquals(wj.result, undefined)
  assertEquals(wj.progress, 1)
})

Deno.test('worldJobFromLegacyJob: a still-queued legacy job has no workerId and zero progress', () => {
  const legacy = makeLegacyJob({ id: 'job-legacy-queued', status: 'queued', startedAt: undefined, finishedAt: undefined })
  const wj = worldJobFromLegacyJob(legacy, 'world-default')

  assertEquals(wj.status, 'queued')
  assertEquals(wj.progress, 0)
  assertEquals(wj.workerId, undefined)
  assertEquals(wj.updatedAt, legacy.createdAt) // no startedAt/finishedAt to prefer
})

// ── Fixture-driven migration + idempotency ─────────────────────────────────

async function setupFixture() {
  const scansDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-scans-' })
  const worldsDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-worlds-' })

  // Two scans that exist on disk, one that's been deleted since.
  await Deno.writeTextFile(`${scansDir}/living-room.glb`, 'glb-bytes-living-room')
  await Deno.writeTextFile(`${scansDir}/kitchen.glb`, 'glb-bytes-kitchen')

  const legacyJobs: Job[] = [
    makeLegacyJob({
      id: 'job-1783300000000-aaaaaa',
      target: 'living-room.glb',
      status: 'done',
      startedAt: '2026-08-01T00:00:01.000Z',
      finishedAt: '2026-08-01T00:00:05.000Z',
      note: '4096 KB -> 812 KB (20%) + 3 LODs',
    }),
    makeLegacyJob({
      id: 'job-1783300000001-bbbbbb',
      target: 'kitchen.glb',
      status: 'error',
      startedAt: '2026-08-02T00:00:01.000Z',
      finishedAt: '2026-08-02T00:00:03.000Z',
      error: 'GLB has no scene graph',
    }),
    makeLegacyJob({
      id: 'job-1783300000002-cccccc',
      target: 'deleted-scan.glb', // no longer on disk
      status: 'done',
      note: 'used to be optimized',
    }),
  ]
  await Deno.writeTextFile(`${scansDir}/jobs.json`, JSON.stringify(legacyJobs, null, 2))

  const world = makeWorldFixture()
  await Deno.writeTextFile(`${worldsDir}/default.json`, JSON.stringify(world, null, 2))

  return { scansDir, worldsDir, legacyJobs }
}

async function cleanup(scansDir: string, worldsDir: string) {
  await Deno.remove(scansDir, { recursive: true })
  await Deno.remove(worldsDir, { recursive: true })
}

Deno.test('migrateJobsToWorldJob: migrates done+error entries, skips the one with a deleted target scan', async () => {
  const { scansDir, worldsDir } = await setupFixture()
  try {
    const logs: string[] = []
    const summary = await migrateJobsToWorldJob({ scansDir, worldsDir, log: (l) => logs.push(l) })

    assertEquals(summary.migrated.length, 2)
    assertEquals(summary.skippedAlreadyMigrated.length, 0)
    assertEquals(summary.skippedMissingScan.length, 1)
    assertEquals(summary.skippedMissingScan[0].legacyId, 'job-1783300000002-cccccc')

    const world = JSON.parse(await Deno.readTextFile(`${worldsDir}/default.json`)) as WorldProject
    assertEquals(world.jobs.length, 2)
    const byId = new Map(world.jobs.map((j) => [j.jobId, j]))

    const done = byId.get('job-1783300000000-aaaaaa')
    assert(done, 'completed job should be present')
    assertEquals(done!.status, 'completed')
    assertEquals(done!.type, 'optimize-scan')
    assertEquals(done!.payload, { filename: 'living-room.glb' })
    assertEquals(done!.result, '4096 KB -> 812 KB (20%) + 3 LODs')

    const failed = byId.get('job-1783300000001-bbbbbb')
    assert(failed, 'errored job should be present')
    assertEquals(failed!.status, 'failed')
    assertEquals(failed!.error, 'GLB has no scene graph')

    // The deleted-scan entry never made it into the world at all.
    assert(!byId.has('job-1783300000002-cccccc'))

    assert(logs.some((l) => l.includes('migrated: job-1783300000000-aaaaaa')))
    assert(logs.some((l) => l.includes('skip (target scan no longer exists')))
  } finally {
    await cleanup(scansDir, worldsDir)
  }
})

Deno.test('migrateJobsToWorldJob: running it twice does not duplicate entries (idempotent)', async () => {
  const { scansDir, worldsDir } = await setupFixture()
  try {
    const first = await migrateJobsToWorldJob({ scansDir, worldsDir, log: () => {} })
    assertEquals(first.migrated.length, 2)

    const afterFirst = JSON.parse(await Deno.readTextFile(`${worldsDir}/default.json`)) as WorldProject
    assertEquals(afterFirst.jobs.length, 2)

    const logs: string[] = []
    const second = await migrateJobsToWorldJob({ scansDir, worldsDir, log: (l) => logs.push(l) })
    assertEquals(second.migrated.length, 0)
    assertEquals(second.skippedAlreadyMigrated.length, 2)
    assert(logs.some((l) => l.includes('already migrated')))

    const afterSecond = JSON.parse(await Deno.readTextFile(`${worldsDir}/default.json`)) as WorldProject
    assertEquals(afterSecond.jobs.length, 2, 'no duplicate entries after a second run')
    assertEquals(
      new Set(afterSecond.jobs.map((j) => j.jobId)).size,
      2,
      'jobIds are still unique after the second run',
    )
  } finally {
    await cleanup(scansDir, worldsDir)
  }
})

Deno.test('migrateJobsToWorldJob: no jobs.json is a clean no-op, not an error', async () => {
  const scansDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-scans-empty-' })
  const worldsDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-worlds-empty-' })
  try {
    await Deno.writeTextFile(`${worldsDir}/default.json`, JSON.stringify(makeWorldFixture(), null, 2))
    const summary = await migrateJobsToWorldJob({ scansDir, worldsDir, log: () => {} })
    assertEquals(summary.migrated.length, 0)
    assertEquals(summary.skippedAlreadyMigrated.length, 0)
    assertEquals(summary.skippedMissingScan.length, 0)
  } finally {
    await cleanup(scansDir, worldsDir)
  }
})

Deno.test('migrateJobsToWorldJob: a malformed jobs.json throws instead of silently no-op-ing', async () => {
  // Regression guard: treating a parse failure like "file absent" would report
  // "nothing to migrate" for a file that genuinely holds history, inviting an
  // operator to delete it — the exact data loss this migration exists to avoid.
  const scansDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-scans-bad-' })
  const worldsDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-worlds-bad-' })
  try {
    await Deno.writeTextFile(`${worldsDir}/default.json`, JSON.stringify(makeWorldFixture(), null, 2))
    await Deno.writeTextFile(`${scansDir}/jobs.json`, '[{"id":"job-1","target":"a.glb",')
    let threw = false
    try {
      await migrateJobsToWorldJob({ scansDir, worldsDir, log: () => {} })
    } catch (err) {
      threw = true
      assert(String(err).includes('not valid JSON'))
    }
    assert(threw, 'a malformed jobs.json must not be mistaken for an absent one')
  } finally {
    await cleanup(scansDir, worldsDir)
  }
})

Deno.test('migrateJobsToWorldJob: missing default world is a clear, actionable error, not a crash', async () => {
  const scansDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-scans-noworld-' })
  const worldsDir = await Deno.makeTempDir({ prefix: 'migrate-jobs-worlds-noworld-' })
  try {
    await Deno.writeTextFile(`${scansDir}/jobs.json`, JSON.stringify([makeLegacyJob()], null, 2))
    let threw = false
    try {
      await migrateJobsToWorldJob({ scansDir, worldsDir, log: () => {} })
    } catch (err) {
      threw = true
      assert(String(err).includes('default'))
    }
    assert(threw, 'should throw when the target world does not exist yet')
  } finally {
    await cleanup(scansDir, worldsDir)
  }
})
