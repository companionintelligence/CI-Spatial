/**
 * The hand-over of scans between worlds as the server runs it (server/world/world_hand_over.ts, ADR 0009): what happens
 * when the world a scan is going to is busy, or cannot be read or saved, and how the hand-over is finished without anybody
 * having to read the old world again.
 *
 * The worlds, the clock and the timers are stood in for, so that a world can be busy for exactly as long as a test
 * wants. `scan_carry.test.ts` holds what goes with a scan, and frame_generations_route.test.ts runs the same through
 * the real server.
 *
 * What is pinned: a free world is handed over to at once, with nothing to report; a world that is busy for a moment is
 * waited for in short steps and the answer is clean; one that stays busy leaves the scan and every record where they
 * were, says `pending`, and is finished by a timer that backs off and stops; a world that cannot be read or saved is the
 * same, and is warned of once; the world that cannot be read is the old one, and its scans are pending; and what a
 * route reports is only about the scans it filed.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  createWorldHandOver,
  HAND_OVER_ATTEMPTS,
  HAND_OVER_RETRIES,
  HAND_OVER_RETRY_FIRST_MS,
  HAND_OVER_WAIT_MS,
  handOverAnswer,
  type WorldHandOverDeps,
} from '../../../server/world/world_hand_over.ts'
import type { EvictedScan } from '../../../server/world/scan_carry.ts'
import type { EditPatch, ScanManifest, WorldProject } from '../../../src/world/types.ts'

const EMPTY_GEO = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const MOVED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, 0, -1, 1]
const AT = '2026-11-16T09:00:00.000Z'

function scan(filename: string): ScanManifest {
  return {
    scanId: `scan-${filename.replace(/\.glb$/, '')}`,
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
  }
}

function world(projectId: string, scans: ScanManifest[], editPatches: EditPatch[] = []): WorldProject {
  return {
    worldId: `world-project-${projectId}`,
    name: projectId,
    shareSlug: `project-${projectId}`,
    projectId,
    originGeoPose: EMPTY_GEO,
    localFrame: { type: 'ENU_Y_UP', origin: EMPTY_GEO, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans,
    things: [],
    thingObservations: [],
    members: [],
    comments: [],
    jobs: [],
    editPatches,
    createdAt: AT,
    updatedAt: AT,
  }
}

const note = (id: string, of: ScanManifest): EditPatch => ({ patchId: id, worldId: 'w', scanId: of.scanId, targetId: of.filename, scope: 'scan', notes: id, createdAt: AT })
const placement = (id: string, of: ScanManifest): EditPatch => ({ patchId: id, worldId: 'w', scanId: of.scanId, targetId: of.filename, scope: 'scan', transform: { matrix: MOVED }, createdAt: AT })
const ids = (patches: EditPatch[]) => patches.map((candidate) => candidate.patchId)

interface Timer {
  ms: number
  fire(): Promise<void>
}

/**
 * House A's world, which two scans were filed away from, and House B's, which they are going to. A read of House A's world
 * is a refresh: it evicts the scans filed under another Place, as `refreshWorldScans` does, and hands them over.
 */
function setup(options: { placedByRecord?: boolean; onSleep?: (waits: number, busy: Set<string>) => void } = {}) {
  const kitchen = scan('1700000000001_kitchen.glb')
  const hall = scan('1700000000002_hall.glb')
  /** A scan in a second world, House C's, which the route may have filed away from as well. */
  const attic = scan('1700000000003_attic.glb')
  const sources = new Map<string, WorldProject>([
    ['project-proj-a', world('proj-a', [kitchen, hall], [note('n-kitchen', kitchen), placement('m-kitchen', kitchen), note('n-hall', hall)])],
    ['project-proj-c', world('proj-c', [attic], [note('n-attic', attic)])],
  ])
  const targets = new Map<string, WorldProject>([['proj-b', world('proj-b', [])]])
  /** Where each scan's record says it is now, by file name: the sidecar's `projectId`. */
  const filedUnder = new Map<string, string>([[kitchen.filename, 'proj-b'], [hall.filename, 'proj-b'], [attic.filename, 'proj-b']])
  const busy = new Set<string>()
  const broken = new Set<string>()
  const unreadable = new Set<string>()
  const reads: string[] = []
  const slept: number[] = []
  const timers: Timer[] = []
  const warnings: string[] = []
  const handOverRef: { current?: ReturnType<typeof createWorldHandOver> } = {}

  const deps: WorldHandOverDeps = {
    places: () => Promise.resolve(new Set(['proj-a', 'proj-b', 'proj-c'])),
    editIfFree: (projectId, edit) => {
      if (busy.has(projectId)) return Promise.resolve(false)
      if (broken.has(projectId)) return Promise.reject(new Error(`the world of ${projectId} is cut short`))
      edit(targets.get(projectId)!)
      return Promise.resolve(true)
    },
    readWorld: async (slug) => {
      reads.push(slug)
      if (unreadable.has(slug)) throw new Error(`${slug} is cut short`)
      const source = sources.get(slug)!
      // What refreshWorldScans does: the rows whose record files them under another Place are evicted and handed over.
      const evicted: EvictedScan[] = source.scans
        .filter((row) => filedUnder.get(row.filename) !== source.projectId)
        .map((row) => ({ scan: row, toProjectId: filedUnder.get(row.filename) ?? null, placedByRecord: options.placedByRecord ?? true }))
      source.scans = source.scans.filter((row) => !evicted.some((entry) => entry.scan === row))
      source.scans.push(...await handOverRef.current!.handOver(source, evicted))
    },
    sleep: (ms) => {
      slept.push(ms)
      options.onSleep?.(slept.length, busy)
      return Promise.resolve()
    },
    later: (run, ms) => {
      timers.push({ ms, fire: async () => { await run() } })
    },
    warn: (message) => {
      warnings.push(message)
    },
  }
  const handOver = createWorldHandOver(deps)
  handOverRef.current = handOver
  /** What a route that filed these scans out of House A's world tells `settle`: the world, and the scans it held. */
  const files = (...of: ScanManifest[]) => new Map([['project-proj-a', new Set(of.map((candidate) => candidate.filename))]])
  return { kitchen, hall, attic, sources, targets, filedUnder, busy, broken, unreadable, reads, slept, timers, warnings, handOver, files, source: () => sources.get('project-proj-a')!, target: () => targets.get('proj-b')! }
}

Deno.test('a free world is handed over to at once: one read, nothing to report, no timer', async () => {
  const t = setup()
  const report = await t.handOver.settle(t.files(t.kitchen, t.hall))
  assertEquals(report, {})
  assertEquals(t.reads, ['project-proj-a'])
  assertEquals(t.slept, [])
  assertEquals(t.timers.length, 0)
  assertEquals(ids(t.target().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'])
  assertEquals(t.source().editPatches, [])
  assertEquals(t.source().scans, [])
})

Deno.test('a world that is busy for a moment is waited for in short steps, and the answer has nothing to say', async () => {
  // The world frees up while the route is waiting: the second wait is the last it needs.
  const t = setup({ onSleep: (waits, busy) => { if (waits === 2) busy.delete('proj-b') } })
  t.busy.add('proj-b')
  const report = await t.handOver.settle(t.files(t.kitchen, t.hall))
  assertEquals(report, {})
  assertEquals(t.slept, [HAND_OVER_WAIT_MS, HAND_OVER_WAIT_MS * 2], 'each wait a little longer than the last')
  assertEquals(t.reads.length, 3)
  assertEquals(t.timers.length, 0, 'nothing left to finish later')
  assertEquals(t.target().scans.map((row) => row.filename).sort(), [t.hall.filename, t.kitchen.filename].sort())
})

Deno.test('a world that stays busy leaves the scans and every record where they were, says pending, and a timer finishes the hand-over when the world is free', async () => {
  const t = setup()
  t.busy.add('proj-b')
  const report = await t.handOver.settle(t.files(t.kitchen, t.hall))
  assertEquals(report, { pending: 2 })
  assertEquals(t.reads.length, HAND_OVER_ATTEMPTS, 'it tried the number of times it says it does')
  assertEquals(t.slept, [HAND_OVER_WAIT_MS, HAND_OVER_WAIT_MS * 2, HAND_OVER_WAIT_MS * 3, HAND_OVER_WAIT_MS * 4], 'and waited between the tries, not after the last')
  // Not one record was taken from the world they are in, and the rows are still listed there.
  assertEquals(ids(t.source().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'])
  assertEquals(t.source().scans.map((row) => row.filename), [t.kitchen.filename, t.hall.filename])
  assertEquals(t.target().editPatches, [])
  // A timer was set, and nothing else.
  assertEquals(t.timers.map((timer) => timer.ms), [HAND_OVER_RETRY_FIRST_MS])

  // The world is free; the timer fires: the records arrive without anybody reading the old world.
  t.busy.delete('proj-b')
  await t.timers[0]!.fire()
  assertEquals(ids(t.target().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'])
  assertEquals(t.source().editPatches, [])
  assertEquals(t.source().scans, [])
  assertEquals(t.timers.length, 1, 'and no more timers are set')
})

Deno.test('a timer that finds the world still busy sets the next one, twice as long, and gives up after the last', async () => {
  const t = setup()
  t.busy.add('proj-b')
  await t.handOver.settle(t.files(t.kitchen))
  for (let i = 0; i < HAND_OVER_RETRIES; i++) {
    assertEquals(t.timers.length, i + 1, `timer ${i + 1} is there`)
    await t.timers[i]!.fire()
  }
  assertEquals(t.timers.map((timer) => timer.ms), Array.from({ length: HAND_OVER_RETRIES }, (_, i) => HAND_OVER_RETRY_FIRST_MS * 2 ** i))
  assertEquals(t.timers.length, HAND_OVER_RETRIES, 'it stops')
  // Not lost: the scan and its records are in the old world, and the next read of it completes the hand-over.
  assertEquals(ids(t.source().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'])
  t.busy.delete('proj-b')
  await t.handOver.settle(t.files(t.kitchen))
  assertEquals(ids(t.target().editPatches).includes('m-kitchen'), true)
})

Deno.test('a second route that finds the same world waiting does not set a second timer', async () => {
  const t = setup()
  t.busy.add('proj-b')
  await t.handOver.settle(t.files(t.kitchen))
  await t.handOver.settle(t.files(t.hall))
  assertEquals(t.timers.length, 1)
})

Deno.test('a world that cannot be read or saved is waited for like a busy one, and warned of once however often it is read', async () => {
  const t = setup()
  t.broken.add('proj-b')
  const report = await t.handOver.settle(t.files(t.kitchen, t.hall))
  assertEquals(report, { pending: 2 })
  assertEquals(ids(t.source().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'], 'nothing is dropped for a world that failed')
  assertEquals(t.warnings.length, 1, `${HAND_OVER_ATTEMPTS} reads, and one warning: ${t.warnings.join(' | ')}`)
  assert(t.warnings[0]!.includes('proj-b'), 'it names the world')
  await t.timers[0]!.fire()
  assertEquals(t.warnings.length, 1, 'and the timer\'s read does not say it again')

  // It is repaired: the next timer finishes the job.
  t.broken.delete('proj-b')
  await t.timers[1]!.fire()
  assertEquals(ids(t.target().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'])
  assertEquals(t.source().editPatches, [])
})

Deno.test('when the world the scans left cannot be read, every scan the route filed from it is pending, and it is read again later', async () => {
  const t = setup()
  t.unreadable.add('project-proj-a')
  const report = await t.handOver.settle(t.files(t.kitchen, t.hall))
  assertEquals(report, { pending: 2 })
  assertEquals(t.reads.length, 1, 'it is not read over and over: it cannot be')
  assertEquals(t.warnings.length, 1)
  assertEquals(t.timers.length, 1)
  t.unreadable.delete('project-proj-a')
  await t.timers[0]!.fire()
  assertEquals(ids(t.target().editPatches), ['n-kitchen', 'm-kitchen', 'n-hall'])
})

Deno.test('a world that was readable while its scans waited, and cannot be now, is read once and not tried again and again', async () => {
  const t = setup()
  t.busy.add('proj-b')
  assertEquals(await t.handOver.settle(t.files(t.kitchen, t.hall)), { pending: 2 })
  const before = t.reads.length
  t.unreadable.add('project-proj-a')
  assertEquals(await t.handOver.settle(t.files(t.kitchen, t.hall)), { pending: 2 })
  assertEquals(t.reads.length - before, 1, 'one failed read, not one for every try')
})

Deno.test('what a route reports is about the scans it filed: another scan waiting in the same world is not counted', async () => {
  const t = setup()
  t.busy.add('proj-b')
  const report = await t.handOver.settle(t.files(t.kitchen))
  assertEquals(report, { pending: 1 }, 'the hall is waiting too, and it is not this route\'s')
})

Deno.test('what a route reports is about the scans each world held: a world that cannot be read does not make the scans of another pending', async () => {
  const t = setup()
  t.unreadable.add('project-proj-a')
  const held = new Map([
    ['project-proj-a', new Set([t.kitchen.filename])],
    ['project-proj-c', new Set([t.attic.filename])],
  ])
  const report = await t.handOver.settle(held)
  assertEquals(report, { pending: 1 }, 'the kitchen, which the world that cannot be read held; the attic was handed over')
  assertEquals(t.target().scans.map((row) => row.filename), [t.attic.filename])
  assertEquals(ids(t.target().editPatches), ['n-attic'])
  assertEquals(t.timers.length, 1, 'one timer, for the world that could not be read')
  // And the other way: the readable world is the one that is waiting, the unreadable one held nothing of this route's.
  const u = setup()
  u.busy.add('proj-b')
  assertEquals(await u.handOver.settle(new Map([['project-proj-a', new Set([u.kitchen.filename])], ['project-proj-c', new Set<string>()]])), { pending: 1 })
})

Deno.test('placements kept in the world a scan left are counted once, for the route that moved it', async () => {
  const t = setup({ placedByRecord: false })
  const report = await t.handOver.settle(t.files(t.kitchen, t.hall))
  assertEquals(report, { placementsKept: 1 }, 'the kitchen\'s hand-set placement is a position in House A\'s world')
  assertEquals(ids(t.source().editPatches), ['m-kitchen'], 'it is still there')
  assertEquals(ids(t.target().editPatches), ['n-kitchen', 'n-hall'])
  // Asked again, for the same scans, there is nothing new to say.
  assertEquals(await t.handOver.settle(t.files(t.kitchen, t.hall)), {})
})

Deno.test('the answer carries a hand-over only when it has something to say', () => {
  assertEquals(handOverAnswer({}), {})
  assertEquals(handOverAnswer({ pending: 0, placementsKept: 0 }), {})
  assertEquals(handOverAnswer({ pending: 2 }), { handOver: { pending: 2 } })
  assertEquals(handOverAnswer({ placementsKept: 1 }), { handOver: { placementsKept: 1 } })
  assertEquals(handOverAnswer({ pending: 1, placementsKept: 3 }), { handOver: { pending: 1, placementsKept: 3 } })
})
