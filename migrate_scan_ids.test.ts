/**
 * Deno unit + fixture tests for scan_id.ts's `scanIdFor` and
 * migrate_scan_ids.ts — the one-shot re-derivation of `ScanManifest.scanId`
 * that docs/factory/07-scan-identity/0001-unique-scan-id-per-upload.md adds.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertRejects } from 'jsr:@std/assert@^1.0.0/rejects'
import { assertThrows } from 'jsr:@std/assert@^1.0.0/throws'

import { migrateScanIds, migrateWorldScanIds } from './migrate_scan_ids.ts'
import { scanIdFor } from './scan_id.ts'
import type { EditPatch, ScanManifest, WorldJob, WorldProject } from './src/world/types.ts'

const FIXTURE_URL = new URL('./tests/fixtures/world-scan-id-collision.json', import.meta.url)

const NO_GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }

function makeScan(overrides: Partial<ScanManifest> & { filename: string }): ScanManifest {
  const stem = overrides.filename.replace(/\.glb$/, '')
  return {
    scanId: `scan-${stem.toLowerCase()}`,
    projectId: null,
    sessionId: null,
    name: stem,
    glbUrl: `/scans/${overrides.filename}`,
    geoPose: NO_GEO,
    localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'aligned',
    ...overrides,
  }
}

function makeWorld(overrides: Partial<WorldProject> = {}): WorldProject {
  return {
    worldId: 'world-default',
    name: 'Default World Scan',
    shareSlug: 'default',
    projectId: null,
    originGeoPose: NO_GEO,
    localFrame: { type: 'ENU_Y_UP', origin: NO_GEO, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [],
    things: [],
    thingObservations: [],
    members: [],
    jobs: [],
    editPatches: [],
    createdAt: '2026-08-19T21:00:00.000Z',
    updatedAt: '2026-08-19T21:00:00.000Z',
    ...overrides,
  }
}

function makePatch(overrides: Partial<EditPatch> & { patchId: string }): EditPatch {
  return {
    worldId: 'world-default',
    targetId: 'object-1',
    scope: 'object',
    createdAt: '2026-08-19T21:30:00.000Z',
    ...overrides,
  }
}

function makeJob(overrides: Partial<WorldJob> & { jobId: string }): WorldJob {
  return {
    worldId: 'world-default',
    type: 'memory-push',
    status: 'completed',
    capabilities: ['cpu'],
    payload: {},
    progress: 1,
    createdAt: '2026-08-19T21:20:00.000Z',
    updatedAt: '2026-08-19T21:20:30.000Z',
    ...overrides,
  }
}

// ── Derivation (scan_id.ts) ────────────────────────────────────────────────

Deno.test('scanIdFor: two uploads from one capture session get two distinct ids', () => {
  // The whole defect in one assertion: these two shared meta.sessionId
  // 'session-1787174216556', and therefore used to share one scanId.
  const a = scanIdFor('1787174311700_autosave-room-scan-2026-08-19T21-18-33.glb')
  const b = scanIdFor('1787174371857_autosave-room-scan-2026-08-19T21-19-32.glb')

  assert(a !== b, `expected distinct ids, both were ${a}`)
  assertEquals(a, 'scan-1787174311700_autosave-room-scan-2026-08-19t21-18-33')
  assertEquals(b, 'scan-1787174371857_autosave-room-scan-2026-08-19t21-19-32')
})

Deno.test('scanIdFor: a scan with no sessionId keeps the id the filename branch always gave it', () => {
  // This branch is unchanged by the ticket — it was already correct.
  assertEquals(scanIdFor('living-room.glb'), 'scan-living-room')
  assertEquals(scanIdFor('1787174311700_kitchen.glb'), 'scan-1787174311700_kitchen')
})

Deno.test('scanIdFor: a registerSessionScan-shaped filename keeps its exact current id', () => {
  // Regression guard for the video/photo-ingest path: registerSessionScan
  // synthesizes `${sessionId}.glb`, so the filename branch reproduces exactly
  // what the retired sessionId branch produced. These ids must not move.
  const sessionId = 'sess-video-ingest-9001'
  assertEquals(scanIdFor(`${sessionId}.glb`), `scan-${sessionId}`)
  assertEquals(scanIdFor('sess-1787174216556.glb'), 'scan-sess-1787174216556')
})

// ── Pure core (migrate_scan_ids.ts) ────────────────────────────────────────

Deno.test('migrateWorldScanIds: the real four-way collision becomes four distinct ids', async () => {
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject
  const collided = world.scans.filter(s => s.scanId === 'scan-session-1787174216556')
  assertEquals(collided.length, 4, 'fixture must start with the four-way collision')

  const result = migrateWorldScanIds(world)

  const ids = world.scans.map(s => s.scanId)
  assertEquals(new Set(ids).size, ids.length, `ids not unique after migration: ${ids.join(', ')}`)
  assertEquals(result.scansReided.length, 4) // the fifth (video-ingest) does not move
  assert(result.changed)
})

Deno.test('migrateWorldScanIds: the video-ingest scan is left exactly as it was', async () => {
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject
  const before = structuredClone(world.scans.find(s => s.filename === 'sess-video-ingest-9001.glb')!)

  migrateWorldScanIds(world)

  const after = world.scans.find(s => s.filename === 'sess-video-ingest-9001.glb')!
  assertEquals(after.scanId, before.scanId)
  assertEquals(after.frameSetUrl, before.frameSetUrl)
})

Deno.test('migrateWorldScanIds: an ambiguous patch follows the newest scan of its session, and says so', async () => {
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject
  const lines: string[] = []

  const result = migrateWorldScanIds(world, line => lines.push(line))

  const newest = world.scans.find(s => s.filename === '1787175480232_autosave-room-scan-2026-08-19T21-38-01.glb')!
  const patch = world.editPatches.find(p => p.patchId === 'patch-1787174600000-cccc3333')!
  assertEquals(patch.scanId, newest.scanId)

  const ambiguity = result.ambiguous.find(a => a.kind === 'patch' && a.id === 'patch-1787174600000-cccc3333')
  assert(ambiguity, 'the four-way remap must be reported as ambiguous')
  assertEquals(ambiguity.candidates, 4)
  assertEquals(ambiguity.chosenScanId, newest.scanId)
  assert(
    lines.some(l => l.includes('patch-1787174600000-cccc3333') && l.includes('4 scans')),
    `expected an ambiguity log naming the patch and the candidate count, got:\n${lines.join('\n')}`,
  )
})

Deno.test('migrateWorldScanIds: an unambiguous re-point happens with no ambiguity logged', () => {
  // One scan in its session, but its id still moves: the session id
  // ('session-42') and the upload filename are different strings.
  const scan = makeScan({
    filename: '1787000000001_solo-capture.glb',
    sessionId: 'session-42',
    scanId: 'scan-session-42',
  })
  const world = makeWorld({
    scans: [scan],
    editPatches: [makePatch({ patchId: 'patch-solo', scanId: 'scan-session-42' })],
  })
  const lines: string[] = []

  const result = migrateWorldScanIds(world, line => lines.push(line))

  assertEquals(world.editPatches[0].scanId, 'scan-1787000000001_solo-capture')
  assertEquals(result.patchesRepointed, 1)
  assertEquals(result.ambiguous.length, 0)
  assertEquals(lines.length, 0)
})

Deno.test('migrateWorldScanIds: a job on the collided id is re-pointed; one with no scanId is untouched', async () => {
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject

  const result = migrateWorldScanIds(world)

  const newest = world.scans.find(s => s.filename === '1787175480232_autosave-room-scan-2026-08-19T21-38-01.glb')!
  const memoryPush = world.jobs.find(j => j.jobId === 'job-1787174400000-aaaa1111')!
  const optimize = world.jobs.find(j => j.jobId === 'job-1787174500000-bbbb2222')!

  assertEquals(memoryPush.scanId, newest.scanId)
  assertEquals(optimize.scanId, undefined) // keys off payload.filename, never had a scanId
  assertEquals(result.jobsRepointed, 1)
})

Deno.test('migrateWorldScanIds: a filename-scoped patch is never touched', async () => {
  // applyStoredPatches() also matches patches on scan.filename, so these were
  // never broken and must not be double-remapped.
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject

  migrateWorldScanIds(world)

  const patch = world.editPatches.find(p => p.patchId === 'patch-1787174800000-eeee5555')!
  assertEquals(patch.scanId, undefined)
  assertEquals(patch.targetId, '1787174371857_autosave-room-scan-2026-08-19T21-19-32.glb')
})

Deno.test('migrateWorldScanIds: every frameSetUrl carries that scan’s own new id', async () => {
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject

  migrateWorldScanIds(world)

  for (const scan of world.scans) {
    assert(scan.sessionId, 'every fixture scan has a sessionId, so every one has a frameSetUrl')
    const frameSetUrl = scan.frameSetUrl
    assert(frameSetUrl, `${scan.filename} lost its frameSetUrl`)
    assertEquals(frameSetUrl, `/worlds/default/frames/${encodeURIComponent(scan.scanId)}`)
    assert(frameSetUrl.includes(scan.scanId), `frameSetUrl ${frameSetUrl} does not name ${scan.scanId}`)
  }
})

Deno.test('migrateWorldScanIds: a scan with no sessionId gets no frameSetUrl', () => {
  const world = makeWorld({
    scans: [makeScan({ filename: 'orphan.glb', sessionId: null, frameSetUrl: '/worlds/default/frames/stale' })],
  })

  migrateWorldScanIds(world)

  assertEquals(world.scans[0].frameSetUrl, undefined)
})

Deno.test('migrateWorldScanIds: a dangling patch reference is left alone, not guessed at', () => {
  const world = makeWorld({
    scans: [makeScan({ filename: 'a.glb' })],
    editPatches: [makePatch({ patchId: 'patch-dangling', scanId: 'scan-from-a-deleted-world' })],
  })

  const result = migrateWorldScanIds(world)

  assertEquals(world.editPatches[0].scanId, 'scan-from-a-deleted-world')
  assertEquals(result.patchesRepointed, 0)
})

Deno.test('migrateWorldScanIds: two filenames slugging to one id is a loud failure, not a silent dedupe', () => {
  // safeSlug maps every character outside [a-z0-9_-] to '-', so these two
  // distinct uploads derive the same id — the collision this migration exists
  // to remove, arriving through the back door.
  const world = makeWorld({
    scans: [makeScan({ filename: 'a.b.glb' }), makeScan({ filename: 'a-b.glb' })],
  })

  assertThrows(
    () => migrateWorldScanIds(world),
    Error,
    'not unique',
  )
})

Deno.test('migrateWorldScanIds: a second pass over an already-migrated world changes nothing', async () => {
  const world = JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as WorldProject

  migrateWorldScanIds(world)
  const afterFirst = structuredClone(world)
  const second = migrateWorldScanIds(world)

  assertEquals(second.changed, false)
  assertEquals(second.scansReided.length, 0)
  assertEquals(second.patchesRepointed, 0)
  assertEquals(second.jobsRepointed, 0)
  assertEquals(second.ambiguous.length, 0)
  assertEquals(JSON.stringify(world), JSON.stringify(afterFirst))
})

// ── Session backfill (ticket 0002, folded into this migration) ─────────────

Deno.test('migrateWorldScanIds: a sessionId with no directory is cleared to null', () => {
  const world = makeWorld({
    scans: [
      makeScan({ filename: 'a.glb', sessionId: 'session-1787174216556', frameSetUrl: '/worlds/default/frames/x' }),
      makeScan({ filename: 'b.glb', sessionId: 'sess-real-one' }),
    ],
  })

  const result = migrateWorldScanIds(world, () => {}, { sessionExists: (id) => id === 'sess-real-one' })

  assertEquals(world.scans[0].sessionId, null)
  assertEquals(world.scans[0].frameSetUrl, undefined, 'a scan with no session has no frame set')
  assertEquals(world.scans[1].sessionId, 'sess-real-one', 'a real session is left alone')
  assertEquals(result.sessionsCleared.length, 1)
  assertEquals(result.sessionsCleared[0].sessionId, 'session-1787174216556')
})

Deno.test('migrateWorldScanIds: the backfill is a no-op on a second run', () => {
  const world = makeWorld({
    scans: [makeScan({ filename: 'a.glb', sessionId: 'session-1787174216556' })],
  })
  const opts = { sessionExists: () => false }

  migrateWorldScanIds(world, () => {}, opts)
  const second = migrateWorldScanIds(world, () => {}, opts)

  assertEquals(second.changed, false)
  assertEquals(second.sessionsCleared.length, 0)
})

Deno.test('migrateWorldScanIds: clearing a session still re-points that scan’s patches correctly', () => {
  // Order matters: the legacy scanId is derived from sessionId, so the grouping
  // has to happen before the backfill nulls it. If it did not, the patch below
  // would be left dangling.
  const world = makeWorld({
    scans: [makeScan({ filename: '1787000000001_solo.glb', sessionId: 'session-42', scanId: 'scan-session-42' })],
    editPatches: [makePatch({ patchId: 'patch-solo', scanId: 'scan-session-42' })],
  })

  migrateWorldScanIds(world, () => {}, { sessionExists: () => false })

  assertEquals(world.scans[0].sessionId, null)
  assertEquals(world.editPatches[0].scanId, 'scan-1787000000001_solo')
})

Deno.test('migrateWorldScanIds: with no sessionExists supplied, session ids are left untouched', () => {
  const world = makeWorld({
    scans: [makeScan({ filename: 'a.glb', sessionId: 'session-1787174216556' })],
  })

  const result = migrateWorldScanIds(world)

  assertEquals(world.scans[0].sessionId, 'session-1787174216556')
  assertEquals(result.sessionsCleared.length, 0)
})

// ── File-level driver ──────────────────────────────────────────────────────

async function withWorldsDir(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'migrate-scan-ids-' })
  try {
    for (const [name, body] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${name}`, body)
    }
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('migrateScanIds: rewrites the world file, and a second run leaves it byte-identical', async () => {
  const fixture = await Deno.readTextFile(FIXTURE_URL)
  await withWorldsDir({ 'default.json': fixture }, async (dir) => {
    const first = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(first.filesWritten, 1)
    const afterFirst = await Deno.readTextFile(`${dir}/default.json`)

    const migrated = JSON.parse(afterFirst) as WorldProject
    const ids = migrated.scans.map(s => s.scanId)
    assertEquals(new Set(ids).size, 5)

    const second = await migrateScanIds({ worldsDir: dir, log: () => {} })
    assertEquals(second.filesWritten, 0)
    assertEquals(second.worlds[0].changed, false)
    assertEquals(await Deno.readTextFile(`${dir}/default.json`), afterFirst)
  })
})

Deno.test('migrateScanIds: a malformed world file throws instead of silently skipping', async () => {
  await withWorldsDir({ 'default.json': '{ this is not json' }, async (dir) => {
    await assertRejects(
      () => migrateScanIds({ worldsDir: dir, log: () => {} }),
      Error,
      'not valid JSON',
    )
  })
})

Deno.test('migrateScanIds: a JSON file that is not a world file throws rather than being rewritten', async () => {
  await withWorldsDir({ 'default.json': '{"hello":"world"}' }, async (dir) => {
    await assertRejects(
      () => migrateScanIds({ worldsDir: dir, log: () => {} }),
      Error,
      "no 'scans' array",
    )
  })
})

Deno.test('migrateScanIds: sessionsDir drives the backfill end to end', async () => {
  const fixture = await Deno.readTextFile(FIXTURE_URL)
  await withWorldsDir({ 'default.json': fixture }, async (dir) => {
    // A sessions root that exists but holds none of the fixture's ids: every
    // one of them is a phantom, which is the real-world state this backfills.
    const sessionsDir = `${dir}/sessions`
    await Deno.mkdir(sessionsDir)

    await migrateScanIds({ worldsDir: dir, sessionsDir, log: () => {} })

    const world = JSON.parse(await Deno.readTextFile(`${dir}/default.json`)) as WorldProject
    for (const scan of world.scans) {
      assertEquals(scan.sessionId, null, `${scan.filename} should have lost its phantom session`)
      assertEquals(scan.frameSetUrl, undefined)
    }
  })
})

Deno.test('migrateScanIds: a scan whose session directory really exists keeps it', async () => {
  const fixture = await Deno.readTextFile(FIXTURE_URL)
  await withWorldsDir({ 'default.json': fixture }, async (dir) => {
    const sessionsDir = `${dir}/sessions`
    await Deno.mkdir(`${sessionsDir}/sess-video-ingest-9001`, { recursive: true })

    await migrateScanIds({ worldsDir: dir, sessionsDir, log: () => {} })

    const world = JSON.parse(await Deno.readTextFile(`${dir}/default.json`)) as WorldProject
    const ingest = world.scans.find(s => s.filename === 'sess-video-ingest-9001.glb')!
    assertEquals(ingest.sessionId, 'sess-video-ingest-9001')
    assert(ingest.frameSetUrl?.includes('scan-sess-video-ingest-9001'))
  })
})

Deno.test('migrateScanIds: a missing worlds directory is a clean no-op, not a throw', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'migrate-scan-ids-gone-' })
  await Deno.remove(dir, { recursive: true })

  const summary = await migrateScanIds({ worldsDir: dir, log: () => {} })

  assertEquals(summary.filesWritten, 0)
  assertEquals(summary.worlds.length, 0)
})

Deno.test('migrateScanIds: every world file in the directory is migrated', async () => {
  const fixture = await Deno.readTextFile(FIXTURE_URL)
  const second = JSON.parse(fixture) as WorldProject
  second.shareSlug = 'annex'
  second.worldId = 'world-annex'

  await withWorldsDir(
    { 'default.json': fixture, 'annex.json': JSON.stringify(second, null, 2) },
    async (dir) => {
      const summary = await migrateScanIds({ worldsDir: dir, log: () => {} })

      assertEquals(summary.filesWritten, 2)
      assertEquals(summary.worlds.map(w => w.slug).sort(), ['annex', 'default'])

      const annex = JSON.parse(await Deno.readTextFile(`${dir}/annex.json`)) as WorldProject
      for (const scan of annex.scans) {
        assert(scan.frameSetUrl?.startsWith('/worlds/annex/frames/'), `wrong slug in ${scan.frameSetUrl}`)
      }
    },
  )
})
