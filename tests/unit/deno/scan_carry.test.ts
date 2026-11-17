/**
 * Carrying a scan between worlds (server/world/scan_carry.ts, ADR 0011), and the lock that lets one world's
 * holder reach for another's without waiting on it (`tryWithWorldLock`, server/world/world_lock.ts).
 *
 * What is pinned: what goes with a scan when its Place changes (its patches, comments and finished jobs, and its
 * row and placement when the scan is placed by its own record), what stays (a placement relative to the origin of the
 * world it was made in, which is kept and counted, and a job that can never run in the other world), that a row the
 * other world already has is never replaced, that patches go into its log in the order of their time, that a hand-over
 * done twice changes nothing the second time, that a world that cannot be read or saved puts the hand-over off and
 * loses nothing, and that the records of other scans are never touched. The same through the real server is in
 * frame_generations_route.test.ts; the retrying of a hand-over that could not be done is in world_hand_over.test.ts.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { adoptBundle, bundleScan, dropBundle, handEvictedScansOver, type HandOverWorlds } from '../../../server/world/scan_carry.ts'
import { scanIdFor } from '../../../server/scan_id.ts'
import { tryWithWorldLock, withWorldLock } from '../../../server/world/world_lock.ts'
import type { EditPatch, ReviewComment, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'

const EMPTY_GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const MOVED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, -1, 1]
const NUDGED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 4, 1]
/** Not a placement: the axes are not at right angles, so `checkPlacementMatrix` refuses it. */
const SKEWED = [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const T1 = '2026-11-16T09:00:00.000Z'
const T2 = '2026-11-16T09:10:00.000Z'
const T3 = '2026-11-16T09:20:00.000Z'

function scan(filename: string, extra: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId: `scan-${filename.replace(/\.glb$/, '').replace(/[^a-z0-9]+/g, '-')}`,
    projectId: 'proj-a',
    sessionId: null,
    filename,
    name: filename,
    glbUrl: `/scans/${filename}`,
    geoPose: EMPTY_GEO,
    localToWorld: IDENTITY,
    accuracyM: null,
    geoDistanceM: null,
    capturedAt: null,
    pointCount: null,
    detectionCount: null,
    layerIndex: [],
    status: 'ready',
    ...extra,
  }
}

const CALIBRATED = { calibrationMethod: 'two-point-ground', calibrationStatus: 'verified' } as const

function world(worldId: string, projectId: string, extra: Partial<WorldProject> = {}): WorldProject {
  return {
    worldId,
    name: worldId,
    shareSlug: worldId.replace(/^world-/, ''),
    projectId,
    originGeoPose: EMPTY_GEO,
    localFrame: { type: 'ENU_Y_UP', origin: EMPTY_GEO, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: [],
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: [],
    editPatches: [],
    createdAt: '2026-11-16T08:00:00.000Z',
    updatedAt: '2026-11-16T08:00:00.000Z',
    ...extra,
  }
}

function patch(patchId: string, worldId: string, extra: Partial<EditPatch>): EditPatch {
  return { patchId, worldId, targetId: 'x', scope: 'object', createdAt: T1, ...extra }
}

/** A placement patch: absolute, scope `scan`, the way the editor and the server write one. */
function placement(patchId: string, worldId: string, of: ScanManifest, matrix: number[], createdAt = T1): EditPatch {
  return patch(patchId, worldId, { scanId: of.scanId, targetId: of.filename, scope: 'scan', transform: { matrix }, createdAt })
}

function job(jobId: string, worldId: string, scanId: string | undefined, status: WorldJob['status'], createdAt: string): WorldJob {
  return { jobId, worldId, type: 'splat-train', status, scanId, capabilities: [], createdAt, updatedAt: createdAt }
}

function comment(commentId: string, worldId: string, scanId: string | null): ReviewComment {
  return { commentId, worldId, body: 'look here', scanId, actorId: 'local', actorRole: 'local', createdAt: '2026-11-16T09:30:00.000Z' }
}

/**
 * A world with two scans: `kitchen.glb`, placed by its own record (calibrated), with a hand-set placement, and
 * `hall.glb`, placed by the origin of this world, with a hand-set placement of its own.
 */
function sourceWorld(): { world: WorldProject; kitchen: ScanManifest; hall: ScanManifest } {
  const kitchen = scan('1700000000001_kitchen.glb', { ...CALIBRATED, localToWorld: MOVED, calibratedLocalToWorld: IDENTITY })
  const hall = scan('1700000000002_hall.glb', { localToWorld: MOVED })
  const w = world('world-project-proj-a', 'proj-a', {
    scans: [kitchen, hall],
    editPatches: [
      placement('p-move-kitchen', 'world-project-proj-a', kitchen, MOVED),
      patch('p-note-kitchen', 'world-project-proj-a', { scanId: kitchen.scanId, targetId: kitchen.filename, scope: 'scan', notes: 'the table moved' }),
      patch('p-label-kitchen', 'world-project-proj-a', { scanId: kitchen.scanId, targetId: `${kitchen.scanId}:Chair_001:lod`, scope: 'object', label: 'stool' }),
      placement('p-move-hall', 'world-project-proj-a', hall, MOVED),
      patch('p-note-hall', 'world-project-proj-a', { scanId: hall.scanId, targetId: hall.filename, scope: 'scan', notes: 'dark corner' }),
      patch('p-world', 'world-project-proj-a', { targetId: 'world', scope: 'world', notes: 'whole Place' }),
    ],
    comments: [comment('c-kitchen', 'world-project-proj-a', kitchen.scanId), comment('c-hall', 'world-project-proj-a', hall.scanId), comment('c-place', 'world-project-proj-a', null)],
    jobs: [
      job('j-q-kitchen', 'world-project-proj-a', kitchen.scanId, 'queued', '2026-11-16T10:03:00.000Z'),
      job('j-done-kitchen', 'world-project-proj-a', kitchen.scanId, 'completed', '2026-11-16T10:02:00.000Z'),
      job('j-failed-kitchen', 'world-project-proj-a', kitchen.scanId, 'failed', '2026-11-16T10:01:00.000Z'),
      job('j-running-kitchen', 'world-project-proj-a', kitchen.scanId, 'processing', '2026-11-16T10:00:30.000Z'),
      job('j-done-hall', 'world-project-proj-a', hall.scanId, 'completed', '2026-11-16T10:00:00.000Z'),
      job('j-place', 'world-project-proj-a', undefined, 'completed', '2026-11-16T09:00:00.000Z'),
    ],
  })
  return { world: w, kitchen, hall }
}

const ids = (items: Array<{ patchId?: string; commentId?: string; jobId?: string }>) =>
  items.map((item) => item.patchId ?? item.commentId ?? item.jobId)

// ── What goes with a scan ────────────────────────────────────────────────────────────────────────

Deno.test('a scan placed by its own record takes every patch that names it, the placement among them, its comments and the jobs that finished', () => {
  const { world: w, kitchen } = sourceWorld()
  const bundle = bundleScan(w, kitchen, true)
  assertEquals(bundle.placedByRecord, true)
  assertEquals(bundle.scan, kitchen)
  assertEquals(ids(bundle.patches), ['p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen'], 'the hand-set placement among them')
  assertEquals(bundle.kept, [])
  assertEquals(ids(bundle.comments), ['c-kitchen'])
  assertEquals(ids(bundle.jobs), ['j-done-kitchen', 'j-failed-kitchen'], 'a queued or running job cannot be run from another world')
  assertEquals(w.editPatches.length, 6, 'the world is only read')
})

Deno.test('a scan placed by the origin of its world keeps the placements set against that origin, and takes the rest', () => {
  const { world: w, hall } = sourceWorld()
  const bundle = bundleScan(w, hall, false)
  assertEquals(bundle.placedByRecord, false)
  assertEquals(ids(bundle.patches), ['p-note-hall'], 'the note travels')
  assertEquals(ids(bundle.kept), ['p-move-hall'], 'the matrix is a position in this world, and stays in it')
  assertEquals(ids(bundle.comments), ['c-hall'])
  assertEquals(ids(bundle.jobs), ['j-done-hall'])
})

Deno.test('a scan-scope patch that carries no matrix is not a placement: it travels with a scan placed by the origin of its world', () => {
  const { world: w, hall } = sourceWorld()
  w.editPatches.push(patch('p-nudge-hall', w.worldId, { scanId: hall.scanId, targetId: hall.filename, scope: 'scan', transform: { position: { x: 1, y: 0, z: 0 } } }))
  const bundle = bundleScan(w, hall, false)
  assertEquals(ids(bundle.patches), ['p-note-hall', 'p-nudge-hall'])
  assertEquals(ids(bundle.kept), ['p-move-hall'], 'only the matrix is a position in the world it was made in')
})

Deno.test('an undo record is a placement too: it carries a matrix, and stays with the others', () => {
  const { world: w, hall } = sourceWorld()
  w.editPatches.push({ ...placement('p-undo-hall', w.worldId, hall, IDENTITY, T2), revertsPatchId: 'p-move-hall' })
  assertEquals(ids(bundleScan(w, hall, false).kept), ['p-move-hall', 'p-undo-hall'])
  assertEquals(ids(bundleScan(w, hall, true).patches).filter((id) => id!.includes('hall')), ['p-move-hall', 'p-note-hall', 'p-undo-hall'])
})

Deno.test('a record names a scan by its id, the id an older build gave it, the id its file name gives, or its file name, and each is found: patches, comments and jobs', () => {
  const session = scan('1700000000003_lounge.glb', { ...CALIBRATED, sessionId: 'session-9' })
  const byFileName = scanIdFor(session.filename)
  assert(byFileName !== session.scanId, 'a row can carry an id other than the one its file name gives (the fixture says so)')
  const w = world('world-project-proj-a', 'proj-a', {
    scans: [session],
    editPatches: [
      patch('by-id', 'w', { scanId: session.scanId, targetId: 'x' }),
      patch('by-legacy-id', 'w', { scanId: 'scan-session-9', targetId: 'x' }),
      patch('by-file-id', 'w', { scanId: byFileName, targetId: 'x' }),
      patch('by-file', 'w', { targetId: session.filename, scope: 'scan' }),
      patch('by-nothing', 'w', { scanId: 'scan-other', targetId: 'x' }),
    ],
    comments: [comment('c-id', 'w', session.scanId), comment('c-legacy-id', 'w', 'scan-session-9'), comment('c-file-id', 'w', byFileName), comment('c-nothing', 'w', 'scan-other'), comment('c-none', 'w', null)],
    jobs: [
      job('j-id', 'w', session.scanId, 'completed', T1),
      job('j-legacy-id', 'w', 'scan-session-9', 'failed', T2),
      job('j-file-id', 'w', byFileName, 'completed', T2),
      job('j-nothing', 'w', 'scan-other', 'completed', T3),
    ],
  })
  const bundle = bundleScan(w, session, true)
  assertEquals(ids(bundle.patches), ['by-id', 'by-legacy-id', 'by-file-id', 'by-file'])
  assertEquals(ids(bundle.comments), ['c-id', 'c-legacy-id', 'c-file-id'])
  assertEquals(ids(bundle.jobs), ['j-id', 'j-legacy-id', 'j-file-id'])
  // And dropping them takes the same ones out, and no others.
  dropBundle(w, bundle)
  assertEquals(ids(w.editPatches), ['by-nothing'])
  assertEquals(ids(w.comments!), ['c-nothing', 'c-none'])
  assertEquals(ids(w.jobs), ['j-nothing'])
})

// ── Putting a bundle into the other world ────────────────────────────────────────────────────────

Deno.test('adopting a bundle files the row under the new Place, keeps the hand-set placement and names the other world on every record', () => {
  const { world: w, kitchen } = sourceWorld()
  const target = world('world-project-proj-b', 'proj-b', { scans: [scan('1700000000009_study.glb', { ...CALIBRATED })] })
  const added = adoptBundle(target, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(added, 1 + 3 + 1 + 2, 'the row, three patches, a comment, two jobs')
  const row = target.scans.find((candidate) => candidate.filename === kitchen.filename)!
  assertEquals(row.projectId, 'proj-b')
  assertEquals(row.localToWorld, MOVED, 'the manual alignment is not lost')
  assertEquals(row.calibratedLocalToWorld, IDENTITY, 'and the calibrated placement it can be reset to')
  assertEquals(target.scans.length, 2)
  assert(target.editPatches.every((carried) => carried.worldId === 'world-project-proj-b'))
  assert(target.comments!.every((carried) => carried.worldId === 'world-project-proj-b'))
  assert(target.jobs.every((carried) => carried.worldId === 'world-project-proj-b'))
  assertEquals(ids(target.editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen'])
  assertEquals(kitchen.projectId, 'proj-a', 'the source row is a different object, untouched')
})

Deno.test('a scan that is not placed by its record adds no row and none of its placements, and leaves the world\'s own row alone', () => {
  const { world: w, hall } = sourceWorld()
  const own = scan(hall.filename, { projectId: 'proj-b', localToWorld: IDENTITY })
  const target = world('world-project-proj-b', 'proj-b', { scans: [own] })
  adoptBundle(target, bundleScan(w, hall, false), 'proj-b')
  assertEquals(target.scans, [own], 'built from its record by the world that has it')
  assertEquals(target.scans[0]!.localToWorld, IDENTITY, 'not the matrix of another world\'s origin')
  assertEquals(ids(target.editPatches), ['p-note-hall'])

  const empty = world('world-project-proj-b', 'proj-b')
  adoptBundle(empty, bundleScan(w, hall, false), 'proj-b')
  assertEquals(empty.scans, [], 'a world with no row for it builds one on its next read')
})

Deno.test('a row the world already has is never replaced by the carried one: it takes the placement the patches say, and nothing else', () => {
  const { world: w, kitchen } = sourceWorld()
  // A row a read of the target built from the record: nobody moved it, its name is the record's.
  const built = scan(kitchen.filename, { ...CALIBRATED, projectId: 'proj-b', localToWorld: IDENTITY, calibratedLocalToWorld: IDENTITY, name: 'built from the record', status: 'processing' })
  const target = world('world-project-proj-b', 'proj-b', { scans: [built] })
  adoptBundle(target, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(target.scans.length, 1, 'one row for the file')
  assertEquals(target.scans[0]!.localToWorld, MOVED, 'where the person put it')
  assertEquals(target.scans[0]!.name, 'built from the record', 'the carried row\'s other fields were not written over it')
  assertEquals(target.scans[0]!.status, 'processing')
  assert(target.scans[0] === built, 'the same row, changed in place')
})

Deno.test('a row that has been moved here keeps its placement when an older move arrives, and takes the newer one when it is newer', () => {
  const { world: w, kitchen } = sourceWorld()
  const kitchenB = scan(kitchen.filename, { ...CALIBRATED, projectId: 'proj-b', localToWorld: NUDGED })
  const newer = world('world-project-proj-b', 'proj-b', { scans: [kitchenB], editPatches: [placement('p-here', 'world-project-proj-b', kitchenB, NUDGED, T3)] })
  adoptBundle(newer, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(newer.scans[0]!.localToWorld, NUDGED, 'the move made here after the one that arrived is the one the scan is at')
  assertEquals(ids(newer.editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen', 'p-here'], 'in the order of their time')

  const older = world('world-project-proj-b', 'proj-b', {
    scans: [scan(kitchen.filename, { ...CALIBRATED, projectId: 'proj-b', localToWorld: NUDGED })],
    editPatches: [placement('p-here-before', 'world-project-proj-b', kitchenB, NUDGED, '2026-11-16T08:00:00.000Z')],
  })
  adoptBundle(older, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(older.scans[0]!.localToWorld, MOVED, 'the move that arrived is the later one')
})

Deno.test('carried patches go into the log by the time they were made: after the ones made before, before the ones made after, and a time that is no time at the end', () => {
  const { world: w, kitchen } = sourceWorld()
  const stamped = (id: string, at: string) => patch(id, 'world-project-proj-b', { targetId: 'other-scan', createdAt: at })
  const target = world('world-project-proj-b', 'proj-b', {
    editPatches: [stamped('no-time', 'not a time'), stamped('early', '2026-11-16T08:00:00.000Z'), stamped('late', '2026-11-16T12:00:00.000Z')],
  })
  adoptBundle(target, bundleScan(w, kitchen, true), 'proj-b')
  // The kitchen's patches are all at T1 (09:00): between 'early' and 'late'. An entry with no usable time is later than nothing.
  assertEquals(ids(target.editPatches), ['no-time', 'early', 'p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen', 'late'])

  const same = world('world-project-proj-b', 'proj-b', { editPatches: [stamped('same-time', T1)] })
  adoptBundle(same, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(ids(same.editPatches), ['same-time', 'p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen'], 'a patch made at the same time goes after the one that was there')

  const unreadable = placement('p-no-time', w.worldId, kitchen, MOVED, 'whenever')
  const withNoTime = world('world-project-proj-a', 'proj-a', { scans: [kitchen], editPatches: [unreadable] })
  const empty = world('world-project-proj-b', 'proj-b', { editPatches: [stamped('early', '2026-11-16T08:00:00.000Z')] })
  adoptBundle(empty, bundleScan(withNoTime, kitchen, true), 'proj-b')
  assertEquals(ids(empty.editPatches), ['early', 'p-no-time'], 'a patch with no time is put at the end, where every patch used to go')
})

Deno.test('a row moves only when a placement came: a note arriving for a scan that was moved here leaves it where it is', () => {
  const { world: w, kitchen } = sourceWorld()
  const here = scan(kitchen.filename, { ...CALIBRATED, projectId: 'proj-b', localToWorld: NUDGED })
  const target = world('world-project-proj-b', 'proj-b', { scans: [here], editPatches: [placement('p-old-here', 'world-project-proj-b', here, MOVED, '2026-11-16T07:00:00.000Z')] })
  // Only the note and the object label come: the log's last placement (MOVED) disagrees with the row (NUDGED) and is not what the arrival is about.
  const bundle = bundleScan(w, kitchen, true)
  bundle.patches = bundle.patches.filter((candidate) => candidate.patchId !== 'p-move-kitchen')
  adoptBundle(target, bundle, 'proj-b')
  assertEquals(target.scans[0]!.localToWorld, NUDGED)
})

Deno.test('a placement that is not a usable one is never made the scan\'s: the row keeps the placement it has', () => {
  const { world: w, kitchen } = sourceWorld()
  w.editPatches = [placement('p-bad', w.worldId, kitchen, SKEWED, T2)]
  const here = scan(kitchen.filename, { ...CALIBRATED, projectId: 'proj-b', localToWorld: NUDGED })
  const target = world('world-project-proj-b', 'proj-b', { scans: [here] })
  adoptBundle(target, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(ids(target.editPatches), ['p-bad'], 'it is carried: it is the person\'s record')
  assertEquals(target.scans[0]!.localToWorld, NUDGED, 'and it moves nothing')
})

Deno.test('adopting the same bundle twice changes nothing the second time', () => {
  const { world: w, kitchen } = sourceWorld()
  const target = world('world-project-proj-b', 'proj-b')
  const bundle = bundleScan(w, kitchen, true)
  assertEquals(adoptBundle(target, bundle, 'proj-b') > 0, true)
  const once = JSON.stringify(target)
  assertEquals(adoptBundle(target, bundle, 'proj-b'), 0, 'nothing is added')
  assertEquals(JSON.stringify(target), once)
})

Deno.test('carried jobs go in newest first, among the jobs the world has', () => {
  const { world: w, kitchen } = sourceWorld()
  const target = world('world-project-proj-b', 'proj-b', {
    jobs: [
      job('own-new', 'world-project-proj-b', undefined, 'queued', '2026-11-16T12:00:00.000Z'),
      job('own-old', 'world-project-proj-b', undefined, 'completed', '2026-11-16T08:00:00.000Z'),
    ],
  })
  adoptBundle(target, bundleScan(w, kitchen, true), 'proj-b')
  assertEquals(ids(target.jobs), ['own-new', 'j-done-kitchen', 'j-failed-kitchen', 'own-old'])
})

// ── Taking the records out of the world a scan leaves ────────────────────────────────────────────

Deno.test('dropping a scan\'s records takes the patches that travelled, its comments and every job of it, and no other scan\'s', () => {
  const { world: w, kitchen } = sourceWorld()
  dropBundle(w, bundleScan(w, kitchen, true))
  assertEquals(ids(w.editPatches), ['p-move-hall', 'p-note-hall', 'p-world'])
  assertEquals(ids(w.comments!), ['c-hall', 'c-place'])
  assertEquals(ids(w.jobs), ['j-done-hall', 'j-place'], 'the queued and running jobs of the scan go too: they have no world to run in')
  assertEquals(w.scans.length, 2, 'the row is the caller\'s: refreshWorldScans already dropped it')
})

Deno.test('dropping a scan that is not placed by its record leaves the placements it kept', () => {
  const { world: w, hall } = sourceWorld()
  dropBundle(w, bundleScan(w, hall, false))
  assertEquals(ids(w.editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen', 'p-move-hall', 'p-world'], 'the hall\'s placement stays, its note went')
  assertEquals(ids(w.comments!), ['c-kitchen', 'c-place'])
  assertEquals(ids(w.jobs), ['j-q-kitchen', 'j-done-kitchen', 'j-failed-kitchen', 'j-running-kitchen', 'j-place'])
})

// ── The lock ─────────────────────────────────────────────────────────────────────────────────────

Deno.test('a world that is busy is not waited for, and a free one is run at once', async () => {
  let release!: () => void
  const held = withWorldLock('carry-busy', () => new Promise<void>((resolve) => { release = resolve }))
  let ran = false
  const tried = await tryWithWorldLock('carry-busy', async () => {
    ran = true
    return 1
  })
  assertEquals(tried, { ran: false })
  assertEquals(ran, false, 'nothing was run')
  release()
  await held
  await new Promise((resolve) => setTimeout(resolve, 0))
  assertEquals(await tryWithWorldLock('carry-busy', () => Promise.resolve('done')), { ran: true, value: 'done' })
  // A different world was never in the way.
  const other = withWorldLock('carry-other', () => new Promise<void>((resolve) => { release = resolve }))
  assertEquals(await tryWithWorldLock('carry-free', () => Promise.resolve(2)), { ran: true, value: 2 })
  release()
  await other
})

Deno.test('two holders that each need the other\'s world finish: neither waits for what the other holds', async () => {
  const outcomes: string[] = []
  const bothHold = Promise.withResolvers<void>()
  let holding = 0
  const holder = (mine: string, theirs: string) =>
    withWorldLock(mine, async () => {
      holding += 1
      if (holding === 2) bothHold.resolve()
      await bothHold.promise
      const reach = await tryWithWorldLock(theirs, () => Promise.resolve('reached'))
      outcomes.push(`${mine}->${theirs}: ${reach.ran ? 'ran' : 'busy'}`)
    })
  // With withWorldLock in place of tryWithWorldLock this is the deadlock: each holds one lock and queues for the other.
  await Promise.race([
    Promise.all([holder('carry-a', 'carry-b'), holder('carry-b', 'carry-a')]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('two holders waited on each other')), 2000)),
  ])
  assertEquals(outcomes.sort(), ['carry-a->carry-b: busy', 'carry-b->carry-a: busy'])
})

// ── The hand-over, with the worlds it needs stood in for ─────────────────────────────────────────

/** The server's side of the hand-over: Places, and worlds that are free unless a test says they are busy or broken. */
function fakeWorlds(options: { places?: string[]; busy?: string[]; broken?: string[]; registryError?: boolean } = {}) {
  const worlds = new Map<string, WorldProject>()
  const asked: string[] = []
  const io: HandOverWorlds = {
    places: () => options.registryError ? Promise.reject(new Error('registry is unreadable')) : Promise.resolve(new Set(options.places ?? ['proj-b'])),
    editIfFree: (projectId, edit) => {
      asked.push(projectId)
      if (options.busy?.includes(projectId)) return Promise.resolve(false)
      if (options.broken?.includes(projectId)) return Promise.reject(new Error(`the world of ${projectId} is cut short`))
      const target = worlds.get(projectId) ?? world(`world-project-${projectId}`, projectId)
      edit(target)
      worlds.set(projectId, target)
      return Promise.resolve(true)
    },
  }
  return { io, worlds, asked }
}

Deno.test('hand-over: the scans a world no longer holds go to the world of their new Place, and their records leave this one', async () => {
  const { world: source, kitchen, hall } = sourceWorld()
  source.scans = []
  const { io, worlds, asked } = fakeWorlds()
  const result = await handEvictedScansOver(source, [
    { scan: kitchen, toProjectId: 'proj-b', placedByRecord: true },
    { scan: hall, toProjectId: 'proj-b', placedByRecord: false },
  ], io)
  assertEquals(result, { stayed: [], kept: { [hall.filename]: 1 }, failures: [] })
  assertEquals(asked, ['proj-b'], 'one visit to the other world for both scans')
  const target = worlds.get('proj-b')!
  assertEquals(ids(target.editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen', 'p-note-hall'])
  assertEquals(ids(target.comments!), ['c-kitchen', 'c-hall'])
  assertEquals(target.scans.map((row) => row.filename), [kitchen.filename], 'only the scan that is placed by its record brings its row')
  assertEquals(ids(source.editPatches), ['p-move-hall', 'p-world'], 'what is left is the hall\'s placement, kept, and what is the Place\'s')
  assertEquals(ids(source.comments!), ['c-place'])
  assertEquals(ids(source.jobs), ['j-place'])
})

Deno.test('hand-over: a world that is busy is not waited for, and everything stays where it was', async () => {
  const { world: source, kitchen } = sourceWorld()
  const before = JSON.stringify(source)
  const { io, worlds } = fakeWorlds({ busy: ['proj-b'] })
  const result = await handEvictedScansOver(source, [{ scan: kitchen, toProjectId: 'proj-b', placedByRecord: true }], io)
  assertEquals(result, { stayed: [kitchen], kept: {}, failures: [] }, 'handed back, to stay until the world is read again; busy is not a failure')
  assertEquals(JSON.stringify(source), before, 'not one record was taken out')
  assertEquals(worlds.size, 0)
})

Deno.test('hand-over: a world that cannot be read or saved is that world\'s trouble: the scan stays with every record, the failure is reported, and nothing is thrown', async () => {
  const { world: source, kitchen, hall } = sourceWorld()
  const { io, worlds, asked } = fakeWorlds({ places: ['proj-b', 'proj-c'], broken: ['proj-b'] })
  const result = await handEvictedScansOver(source, [
    { scan: kitchen, toProjectId: 'proj-b', placedByRecord: true },
    { scan: hall, toProjectId: 'proj-c', placedByRecord: false },
  ], io)
  assertEquals(result.stayed, [kitchen], 'the kitchen waits for its world')
  assertEquals(result.failures.map((failure) => [failure.projectId, (failure.error as Error).message]), [['proj-b', 'the world of proj-b is cut short']])
  assertEquals(asked, ['proj-b', 'proj-c'], 'and the hall\'s world was still visited')
  assertEquals([...worlds.keys()], ['proj-c'])
  assertEquals(ids(source.editPatches), ['p-move-kitchen', 'p-note-kitchen', 'p-label-kitchen', 'p-move-hall', 'p-world'], 'nothing of the kitchen was taken out; the hall left')
  assertEquals(ids(source.comments!), ['c-kitchen', 'c-place'])
  assertEquals(ids(source.jobs).filter((id) => id!.endsWith('kitchen')), ['j-q-kitchen', 'j-done-kitchen', 'j-failed-kitchen', 'j-running-kitchen'], 'and every job of it is still here')
})

Deno.test('hand-over: scans for several Places are handled apart, and only the ones that were handed over lose their records', async () => {
  const { world: source, kitchen, hall } = sourceWorld()
  const { io, worlds } = fakeWorlds({ places: ['proj-b', 'proj-c'], busy: ['proj-c'] })
  const result = await handEvictedScansOver(source, [
    { scan: kitchen, toProjectId: 'proj-b', placedByRecord: true },
    { scan: hall, toProjectId: 'proj-c', placedByRecord: false },
  ], io)
  assertEquals(result.stayed, [hall])
  assertEquals([...worlds.keys()], ['proj-b'])
  assertEquals(ids(source.editPatches), ['p-move-hall', 'p-note-hall', 'p-world'], 'the kitchen left, the hall waits')
  assertEquals(ids(source.comments!), ['c-hall', 'c-place'])
})

Deno.test('hand-over: a scan filed under no Place, or under one that does not exist, has nowhere to go and all its records are dropped, a kept placement too', async () => {
  const { world: source, kitchen, hall } = sourceWorld()
  const { io, asked } = fakeWorlds({ places: ['proj-b'] })
  const result = await handEvictedScansOver(source, [
    { scan: kitchen, toProjectId: null, placedByRecord: true },
    { scan: hall, toProjectId: 'proj-gone', placedByRecord: false },
  ], io)
  assertEquals(result, { stayed: [], kept: {}, failures: [] })
  assertEquals(asked, [], 'no world was visited')
  assertEquals(ids(source.editPatches), ['p-world'], 'a placement kept for another world has no other world here: it goes with the scan')
  assertEquals(ids(source.comments!), ['c-place'])
  assertEquals(ids(source.jobs), ['j-place'])
})

Deno.test('hand-over: when the registry cannot be read nothing is dropped and nothing moves', async () => {
  const { world: source, kitchen, hall } = sourceWorld()
  const before = JSON.stringify(source)
  const { io, asked } = fakeWorlds({ registryError: true })
  const warned: unknown[][] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const result = await handEvictedScansOver(source, [
      { scan: kitchen, toProjectId: 'proj-b', placedByRecord: true },
      { scan: hall, toProjectId: null, placedByRecord: false },
    ], io)
    assertEquals(result.stayed, [kitchen, hall])
  } finally {
    console.warn = warn
  }
  assertEquals(JSON.stringify(source), before)
  assertEquals(asked, [])
  assertEquals(warned.length, 1, 'and it says so')
})

Deno.test('hand-over: with nothing evicted it asks for nothing', async () => {
  const { world: source } = sourceWorld()
  let asked = false
  const io: HandOverWorlds = {
    places: () => { asked = true; return Promise.resolve(new Set()) },
    editIfFree: () => { asked = true; return Promise.resolve(true) },
  }
  assertEquals(await handEvictedScansOver(source, [], io), { stayed: [], kept: {}, failures: [] })
  assertEquals(asked, false)
})
