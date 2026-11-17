/**
 * The place-register WorldJob (server/register/place_register.ts): choosing what
 * to compare, reading scan GLBs into the Place frame, running to a terminal state
 * through the same host seam `server/main.ts` fills, and the server's half of
 * "apply once".
 *
 * The matcher's own behaviour is tests/unit/deno/scan_match.test.ts. This file is
 * about the job around it, and about what the job may and may not do:
 *
 *  - it proposes and never moves: after any run, proposed or refused, every scan
 *    still has the `localToWorld` and the `status` it had before, and no scan is
 *    ever `'aligned'` (that word is a claim; nothing here earns it);
 *  - it follows the one job system: dedupe on (type, scanId), single-flight, boot
 *    requeue and the bounded history all apply to it through the shared helpers;
 *  - its patch guard writes provenance only for a patch that is exactly what the
 *    named job proposed, and writes it once.
 *
 * `server/main.ts` serves at import and cannot be loaded here, so the job's few
 * needs from it arrive as a host (`PlaceRegisterHost`), which these tests fill with
 * an in-memory world. The same job running against the real server, its routes,
 * its pump and its files is tests/unit/deno/place_register_server.test.ts.
 *
 * Run: deno task test
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'

import type { EditPatch, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'
import {
  buildRegisterPatch,
  multiplyMat4,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  PLACE_REGISTER_SKIP_ARTIFACT,
  readPlaceRegisterResult,
} from '../../../src/world/register-proposal.ts'
import {
  areaRelation,
  comparePlacedClouds,
  guardRegistrationPatch,
  isPlaceCalibrated,
  MAX_REFERENCE_CANDIDATES,
  MAX_REFERENCE_SCANS,
  patchedScanIds,
  PLACE_REGISTER_EXCLUDE_OTHER_AREAS,
  placeRegisterResultText,
  type PlaceRegisterHost,
  planPlaceRegister,
  queuePlaceRegisterForScan,
  readPlacedCloud,
  runPlaceRegisterJob,
} from '../../../server/register/place_register.ts'
import { transformPositions } from '../../../server/register/scan_match.ts'
import {
  findDuplicateWorldJob,
  MAX_WORLD_JOB_HISTORY,
  recoverStuckWorldJobs,
  trimWorldJobHistory,
  WorldJobPump,
} from '../../../server/world/world_job_pump.ts'
import { pointCloudGlb } from '../../fixtures/place-register/point-cloud-glb.ts'
import {
  corners,
  makeRoom,
  misplacementMatrix,
  type Misplacement,
  recoveryError,
} from '../../fixtures/place-register/synthetic-room.ts'

const ROOM = { width: 6, depth: 4, centre: { x: 3, z: 2 } } as const
const room = (seed: number, extra: object = {}) =>
  makeRoom({ ...ROOM, noiseM: 0.02, seed, boxes: [{ x: 1.2, z: 1, w: 0.8, d: 0.6, h: 0.9 }, { x: 4.5, z: 3, w: 1.2, d: 0.5, h: 0.5 }], ...extra })
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const ERROR: Misplacement = { yawDeg: 3, dx: 0.3, dz: -0.2 }
const SLUG = 'project-proj-1'

// ─── A world to run against ─────────────────────────────────────────────────

function scan(scanId: string, overrides: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId,
    projectId: 'proj-1',
    sessionId: null,
    filename: `${scanId}.glb`,
    name: `Scan ${scanId}`,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
    localToWorld: [...IDENTITY],
    accuracyM: null,
    geoDistanceM: null,
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'provisional',
    capturedAt: '2026-11-10T09:00:00.000Z',
    pointCount: 1000,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
    ...overrides,
  }
}

function job(scanId: string, overrides: Partial<WorldJob> = {}): WorldJob {
  return {
    jobId: `job-${scanId}`,
    worldId: 'world-project-proj-1',
    type: 'place-register',
    status: 'processing',
    scanId,
    capabilities: [],
    progress: 0.35,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  }
}

function world(scans: ScanManifest[], jobs: WorldJob[] = [], editPatches: EditPatch[] = []): WorldProject {
  return {
    worldId: 'world-project-proj-1',
    name: 'Test place',
    shareSlug: SLUG,
    projectId: 'proj-1',
    originGeoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
    localFrame: {
      type: 'ENU_Y_UP',
      origin: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
      units: 'meters',
      axes: { x: 'east', y: 'up', z: 'north' },
    },
    scans,
    things: [],
    thingObservations: [],
    members: [],
    jobs,
    editPatches,
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
  }
}

/** An in-memory stand-in for the pieces of server/main.ts the job uses. */
function fakeHost(current: WorldProject, glbs: Map<string, Uint8Array | null>, overrides: Partial<PlaceRegisterHost> = {}) {
  const log = { commits: 0, fails: [] as string[], reads: [] as string[] }
  const host: PlaceRegisterHost = {
    claim: async (_slug, jobId) => {
      const found = current.jobs.find((candidate) => candidate.jobId === jobId)
      const owner = found && current.scans.find((candidate) => candidate.scanId === found.scanId)
      if (!found || !owner) {
        if (found) {
          found.status = 'failed'
          found.error = 'place-register requires a selected scan.'
        }
        return null
      }
      return { scan: owner, payload: found.payload }
    },
    loadWorld: async () => structuredClone(current),
    readScanGlbBytes: async (filename) => {
      log.reads.push(filename)
      return glbs.get(filename) ?? null
    },
    commit: async (_slug, jobId, mutate) => {
      const found = current.jobs.find((candidate) => candidate.jobId === jobId)
      if (!found) return null
      log.commits++
      return mutate(found, current)
    },
    fail: async (_slug, jobId, reason) => {
      log.fails.push(reason)
      const found = current.jobs.find((candidate) => candidate.jobId === jobId)
      if (found) {
        found.status = 'failed'
        found.error = reason
        found.result = reason
      }
    },
    now: () => '2026-11-16T10:00:01.000Z',
    ...overrides,
  }
  return { host, log }
}

/**
 * Two scans of the room. The reference sits where it was calibrated; the new scan's calibration left it
 * misplaced by ERROR, which is what the job should find. Both GLBs hold the room as the scan saw it, in its own
 * session frame: the placement error is entirely in `localToWorld`, where a calibration error lives.
 */
async function twoScans(moving: Float32Array = room(2)) {
  const reference = scan('a', { capturedAt: '2026-11-10T09:00:00.000Z' })
  const second = scan('b', { capturedAt: '2026-11-12T09:00:00.000Z', localToWorld: misplacementMatrix(ERROR) })
  const glbs = new Map<string, Uint8Array | null>([
    [reference.filename, await pointCloudGlb(room(1))],
    [second.filename, await pointCloudGlb(moving)],
  ])
  return { reference, second, glbs }
}

// ─── Choosing what to compare ────────────────────────────────────────────────

Deno.test('isPlaceCalibrated: the two tiers whose frame is the Place, and no other', () => {
  assertEquals(isPlaceCalibrated({ calibrationMethod: 'two-point-ground' }), true)
  assertEquals(isPlaceCalibrated({ calibrationMethod: 'ground-tap-compass' }), true)
  assertEquals(isPlaceCalibrated({ calibrationMethod: 'known-distance' }), false, 'its matrix is in solver coordinates')
  assertEquals(isPlaceCalibrated({ calibrationMethod: undefined }), false, 'placed by GPS or on a grid')
})

Deno.test('planPlaceRegister: names why there is nothing to compare', () => {
  const lonely = world([scan('a')])
  assertEquals(planPlaceRegister(lonely, 'nope'), { ok: false, reason: 'scan-missing', message: 'This scan is no longer in the Place.' })
  const alone = planPlaceRegister(lonely, 'a')
  assert(!alone.ok && alone.reason === 'no-other-scan')

  const uncalibrated = world([scan('a'), scan('b', { calibrationMethod: undefined, calibrationStatus: 'uncalibrated' })])
  const plan = planPlaceRegister(uncalibrated, 'b')
  assert(!plan.ok && plan.reason === 'not-calibrated')
  // An uncalibrated scan is no reference either: its placement says nothing about where it is in the Place.
  const noReference = planPlaceRegister(uncalibrated, 'a')
  assert(!noReference.ok && noReference.reason === 'no-other-scan')
})

Deno.test('planPlaceRegister: references are the other calibrated scans, newest first, and no more than the cap', () => {
  const scans = [
    scan('new', { capturedAt: '2026-11-15T00:00:00.000Z' }),
    scan('old', { capturedAt: '2026-11-01T00:00:00.000Z' }),
    scan('mid', { capturedAt: '2026-11-08T00:00:00.000Z', calibrationMethod: 'ground-tap-compass' }),
    scan('solver', { capturedAt: '2026-11-14T00:00:00.000Z', calibrationMethod: 'known-distance' }),
    scan('grid', { capturedAt: '2026-11-13T00:00:00.000Z', calibrationMethod: undefined }),
  ]
  const plan = planPlaceRegister(world(scans), 'new')
  assert(plan.ok)
  assertEquals(plan.references.map((reference) => reference.scanId), ['mid', 'old'])

  const crowd = Array.from({ length: 12 }, (_, i) => scan(`s${i}`, { capturedAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }))
  const crowded = planPlaceRegister(world([scan('x', { capturedAt: '2026-11-30T00:00:00.000Z' }), ...crowd]), 'x')
  assert(crowded.ok)
  assertEquals(crowded.references.length, MAX_REFERENCE_CANDIDATES)
  assertEquals(crowded.references[0]!.scanId, 's11', 'the most recent first')
  assert(MAX_REFERENCE_CANDIDATES > MAX_REFERENCE_SCANS, 'more are read than are searched, so searches go to scans that can touch')
})

Deno.test('areaRelation: the same area, no word about an area, or a different one', () => {
  assertEquals(areaRelation({ areaId: 'kitchen' }, { areaId: 'kitchen' }), 'same')
  assertEquals(areaRelation({ areaId: ' kitchen ' }, { areaId: 'kitchen' }), 'same', 'stray spaces are not a different room')
  assertEquals(areaRelation({ areaId: 'kitchen' }, { areaId: 'hall' }), 'different')
  assertEquals(areaRelation({ areaId: 'kitchen' }, { areaId: null }), 'unknown')
  assertEquals(areaRelation({ areaId: undefined }, { areaId: 'hall' }), 'unknown')
  assertEquals(areaRelation({ areaId: '' }, { areaId: '  ' }), 'unknown', 'an empty area is no area')
})

Deno.test('planPlaceRegister: the earlier scan of this room is never dropped for newer scans of other rooms', () => {
  // The kitchen is scanned, then four other rooms, then the kitchen again: the newest four others are not the kitchen.
  const scans = [
    scan('kitchen-1', { areaId: 'kitchen', capturedAt: '2026-11-01T00:00:00.000Z' }),
    scan('living', { areaId: 'living', capturedAt: '2026-11-02T00:00:00.000Z' }),
    scan('bedroom', { areaId: 'bedroom', capturedAt: '2026-11-03T00:00:00.000Z' }),
    scan('bath', { areaId: 'bath', capturedAt: '2026-11-04T00:00:00.000Z' }),
    scan('hall', { areaId: 'hall', capturedAt: '2026-11-05T00:00:00.000Z' }),
    scan('kitchen-2', { areaId: 'kitchen', capturedAt: '2026-11-06T00:00:00.000Z' }),
  ]
  const plan = planPlaceRegister(world(scans), 'kitchen-2')
  assert(plan.ok)
  assertEquals(plan.references.map((reference) => reference.scanId), ['kitchen-1'], 'other rooms are not compared at all')
})

Deno.test('planPlaceRegister: the same area comes first, then scans with no area, each newest first; another area is left out', () => {
  const scans = [
    scan('new', { areaId: 'kitchen', capturedAt: '2026-11-20T00:00:00.000Z' }),
    scan('same-old', { areaId: 'kitchen', capturedAt: '2026-11-01T00:00:00.000Z' }),
    scan('same-mid', { areaId: 'kitchen', capturedAt: '2026-11-05T00:00:00.000Z' }),
    scan('unfiled-new', { areaId: null, capturedAt: '2026-11-18T00:00:00.000Z' }),
    scan('unfiled-old', { capturedAt: '2026-11-02T00:00:00.000Z' }),
    scan('elsewhere', { areaId: 'hall', capturedAt: '2026-11-19T00:00:00.000Z' }),
  ]
  const plan = planPlaceRegister(world(scans), 'new')
  assert(plan.ok)
  assertEquals(plan.references.map((reference) => reference.scanId), ['same-mid', 'same-old', 'unfiled-new', 'unfiled-old'])

  // A new scan with no area rules nothing out: nothing was said about where it is.
  const unfiled = planPlaceRegister(world([scan('x', { areaId: null, capturedAt: '2026-11-21T00:00:00.000Z' }), ...scans.slice(1)]), 'x')
  assert(unfiled.ok)
  assertEquals(unfiled.references.map((reference) => reference.scanId).sort(), ['elsewhere', 'same-mid', 'same-old', 'unfiled-new', 'unfiled-old'])
})

Deno.test('planPlaceRegister: with the switch off, scans filed under another area are ranked last and not left out', () => {
  const scans = [
    scan('new', { areaId: 'kitchen', capturedAt: '2026-11-20T00:00:00.000Z' }),
    scan('elsewhere-new', { areaId: 'hall', capturedAt: '2026-11-19T00:00:00.000Z' }),
    scan('unfiled', { areaId: null, capturedAt: '2026-11-10T00:00:00.000Z' }),
    scan('same-old', { areaId: 'kitchen', capturedAt: '2026-11-01T00:00:00.000Z' }),
  ]
  const off = planPlaceRegister(world(scans), 'new', MAX_REFERENCE_CANDIDATES, { excludeOtherAreas: false })
  assert(off.ok)
  assertEquals(off.references.map((reference) => reference.scanId), ['same-old', 'unfiled', 'elsewhere-new'])
  const on = planPlaceRegister(world(scans), 'new', MAX_REFERENCE_CANDIDATES, { excludeOtherAreas: true })
  assert(on.ok)
  assertEquals(on.references.map((reference) => reference.scanId), ['same-old', 'unfiled'])
  assertEquals(PLACE_REGISTER_EXCLUDE_OTHER_AREAS, true, 'the recommended default')
  const defaulted = planPlaceRegister(world(scans), 'new')
  assert(defaulted.ok)
  assertEquals(defaulted.references.length, 2)
})

Deno.test('planPlaceRegister: when every other scan is filed under another area it says so, and not that there are none', () => {
  const plan = planPlaceRegister(world([scan('a', { areaId: 'kitchen' }), scan('b', { areaId: 'hall' })]), 'a')
  assert(!plan.ok)
  assertEquals(plan.reason, 'no-other-scan')
  assertEquals(plan.message, 'No other calibrated scan in this scan\'s area to compare it with. The Place\'s other scans are filed under other areas.')
  const none = planPlaceRegister(world([scan('a', { areaId: 'kitchen' })]), 'a')
  assert(!none.ok)
  assertEquals(none.message, 'No other calibrated scan in this Place to compare it with.')
})

// ─── Reading a scan into the Place frame ─────────────────────────────────────

Deno.test('readPlacedCloud: carries the points through the node hierarchy and then through localToWorld', async () => {
  const points = [1, 0.5, 2, -3, 1.2, 0.25, 0.4, 0.8, -1]
  // The cloud sits on a node scaled by 2.5, with the vertices stored divided by it, as an optimized scan does.
  const bytes = await pointCloudGlb(points, { scale: 2.5 })
  const placement = misplacementMatrix({ yawDeg: 30, dx: 4, dz: -2, dy: 0.1 })
  const s = scan('a', { localToWorld: placement })
  const cloud = await readPlacedCloud({ readScanGlbBytes: async () => bytes }, s)
  assert(cloud)
  const expected = transformPositions(points, placement)
  assertEquals(cloud.positions.length, expected.length)
  for (let i = 0; i < expected.length; i++) assertAlmostEquals(cloud.positions[i]!, expected[i]!, 1e-4)
})

Deno.test('readPlacedCloud: no file, an unreadable file and a scan with no placement are no cloud, not a crash', async () => {
  assertEquals(await readPlacedCloud({ readScanGlbBytes: async () => null }, scan('a')), null)
  assertEquals(await readPlacedCloud({ readScanGlbBytes: async () => new Uint8Array([1, 2, 3, 4, 5]) }, scan('a')), null)
  const bytes = await pointCloudGlb([0, 1, 0, 1, 1, 1])
  assertEquals(await readPlacedCloud({ readScanGlbBytes: async () => bytes }, scan('a', { localToWorld: [1, 2, 3] })), null)
})

// ─── Running the job ─────────────────────────────────────────────────────────

Deno.test('place-register: finds the placement error, stores it as a proposal, and moves nothing', async () => {
  const { reference, second, glbs } = await twoScans()
  const current = world([reference, second], [job('b')])
  const before = structuredClone(current.scans)
  const { host, log } = fakeHost(current, glbs)

  await runPlaceRegisterJob(host, SLUG, 'job-b')

  const finished = current.jobs[0]!
  assertEquals(finished.status, 'completed')
  assertEquals(finished.progress, 1)
  assertEquals(log.fails, [])
  assertEquals(log.commits, 1)

  const result = readPlaceRegisterResult(finished)
  assert(result, 'the artifact reads back as a proposal')
  assertEquals(finished.artifacts![0]!.type, PLACE_REGISTER_PROPOSAL_ARTIFACT)
  assertEquals(result.proposal.status, 'proposed')
  assertEquals(result.moving.scanId, 'b')
  assertEquals(result.reference.scanId, 'a')
  assertEquals(result.moving.localToWorld, misplacementMatrix(ERROR), 'the placement the proposal was measured from')
  const recovered = recoveryError(result.proposal.transform!, ERROR, corners(ROOM))
  assert(recovered.positionM < 0.05 && Math.abs(recovered.yawDeg) < 1, `${recovered.positionM} m, ${recovered.yawDeg} deg`)

  // Every pair reports its residual: the measurement this package exists to produce.
  assertEquals(result.comparisons.length, 1)
  assertEquals(typeof result.comparisons[0]!.inlierResidualM, 'number')
  assert(result.params['maxCorrectionTranslationM'] !== undefined)

  // The honest-label rule: a proposal is not an alignment. Nothing about any scan changed.
  assertEquals(current.scans, before)
  assert(current.scans.every((s) => s.status !== 'aligned'))
  assertEquals(current.editPatches, [])
  assert(/Nothing moves until you apply it/.test(finished.result!))
  assert(!/aligned|verified/i.test(finished.result!), finished.result)
})

Deno.test('place-register: a no-op run never sets "aligned" and is never presented as applied', async () => {
  // A different room entirely: nothing to line up.
  const { reference, second, glbs } = await twoScans(makeRoom({ width: 5, depth: 3, centre: { x: 9, z: 7 }, noiseM: 0.02, seed: 5 }))
  const current = world([reference, second], [job('b')])
  const before = structuredClone(current.scans)
  const { host, log } = fakeHost(current, glbs)

  await runPlaceRegisterJob(host, SLUG, 'job-b')

  const finished = current.jobs[0]!
  assertEquals(finished.status, 'completed')
  const result = readPlaceRegisterResult(finished)!
  assertEquals(result.proposal.status, 'refused')
  assertEquals(result.proposal.transform, null)
  assertEquals(result.proposal.reason, 'low-overlap')
  assert(result.proposal.score < 0.5)
  assert(finished.result!.startsWith('No move proposed'), finished.result)
  assert(!/aligned|verified|applied/i.test(finished.result!), finished.result)
  assertEquals(buildRegisterPatch(result, 'job-b'), null, 'there is nothing to apply')
  assertEquals(current.scans, before)
  assert(current.scans.every((s) => s.status !== 'aligned'))
  assertEquals(log.fails, [])
})

Deno.test('place-register: with several references it reports every pair and offers the best', async () => {
  const { reference, second, glbs } = await twoScans()
  const stranger = scan('c', { capturedAt: '2026-11-11T09:00:00.000Z' })
  const missing = scan('d', { capturedAt: '2026-11-13T09:00:00.000Z' })
  glbs.set(stranger.filename, await pointCloudGlb(makeRoom({ width: 5, depth: 3, centre: { x: 9, z: 7 }, noiseM: 0.02, seed: 5 })))
  const current = world([reference, stranger, missing, second], [job('b')])
  const { host } = fakeHost(current, glbs)

  await runPlaceRegisterJob(host, SLUG, 'job-b')

  const result = readPlaceRegisterResult(current.jobs[0]!)!
  assertEquals(result.reference.scanId, 'a', 'the one that lines up, not the most recent')
  assertEquals(result.comparisons.map((row) => [row.referenceScanId, row.status]).sort(), [
    ['a', 'proposed'],
    ['c', 'refused'],
    ['d', 'skipped'],
  ])
  const skipped = result.comparisons.find((row) => row.referenceScanId === 'd')!
  assertEquals(skipped.reason, 'no-geometry')
  for (const row of result.comparisons.filter((candidate) => candidate.status !== 'skipped')) {
    assert(row.inlierResidualM === null || typeof row.inlierResidualM === 'number')
    assert(row.elapsedMs >= 0)
  }
})

Deno.test('place-register: running it twice gives the same proposal (a requeued job re-runs safely)', async () => {
  const { reference, second, glbs } = await twoScans()
  const current = world([reference, second], [job('b')])
  const { host } = fakeHost(current, glbs)
  await runPlaceRegisterJob(host, SLUG, 'job-b')
  const first = structuredClone(readPlaceRegisterResult(current.jobs[0]!)!)

  current.jobs[0]!.status = 'queued'
  const [requeued] = recoverStuckWorldJobs(current.jobs)
  assertEquals(requeued?.result, 'requeued after restart')
  await runPlaceRegisterJob(host, SLUG, 'job-b')
  const again = readPlaceRegisterResult(current.jobs[0]!)!
  assertEquals(again.proposal, first.proposal)
  assertEquals(again.moving, first.moving)
  assertEquals(current.jobs[0]!.status, 'completed')
})

Deno.test('place-register: nothing to compare is a completed job that says why, not a failure', async () => {
  const lone = scan('a')
  const glbs = new Map([[lone.filename, await pointCloudGlb(room(1))]])
  const current = world([lone], [job('a')])
  const { host, log } = fakeHost(current, glbs)
  await runPlaceRegisterJob(host, SLUG, 'job-a')
  assertEquals(current.jobs[0]!.status, 'completed')
  assertEquals(current.jobs[0]!.artifacts![0]!.type, PLACE_REGISTER_SKIP_ARTIFACT)
  assertEquals(current.jobs[0]!.artifacts![0]!.metadata!['reason'], 'no-other-scan')
  assertEquals(current.jobs[0]!.result, 'No other calibrated scan in this Place to compare it with.')
  assertEquals(readPlaceRegisterResult(current.jobs[0]!), null, 'a skip is not a proposal')
  assertEquals(log.fails, [])

  const gridPlaced = scan('g', { calibrationMethod: undefined, calibrationStatus: 'uncalibrated' })
  const second = world([scan('a'), gridPlaced], [job('g')])
  await runPlaceRegisterJob(fakeHost(second, glbs).host, SLUG, 'job-g')
  assertEquals(second.jobs[0]!.artifacts![0]!.metadata!['reason'], 'not-calibrated')

  const noFile = world([scan('a'), scan('b')], [job('b')])
  await runPlaceRegisterJob(fakeHost(noFile, new Map()).host, SLUG, 'job-b')
  assertEquals(noFile.jobs[0]!.status, 'completed')
  assertEquals(noFile.jobs[0]!.artifacts![0]!.metadata!['reason'], 'no-geometry')
})

Deno.test('place-register: an error in the job fails the job, with the message, and the world is untouched', async () => {
  const { reference, second, glbs } = await twoScans()
  const current = world([reference, second], [job('b')])
  const before = structuredClone(current.scans)
  const { host, log } = fakeHost(current, glbs, {
    readScanGlbBytes: async () => {
      throw new Error('the scans disk is not mounted')
    },
  })
  await runPlaceRegisterJob(host, SLUG, 'job-b')
  assertEquals(current.jobs[0]!.status, 'failed')
  assertEquals(current.jobs[0]!.error, 'the scans disk is not mounted')
  assertEquals(log.fails, ['the scans disk is not mounted'])
  assertEquals(current.scans, before)
})

Deno.test('place-register: a job whose scan is gone is failed by the claim, and nothing else runs', async () => {
  const current = world([scan('a')], [job('ghost')])
  const { host, log } = fakeHost(current, new Map())
  await runPlaceRegisterJob(host, SLUG, 'job-ghost')
  assertEquals(current.jobs[0]!.status, 'failed')
  assertEquals(log.commits, 0)
  assertEquals(log.reads, [])
})

Deno.test('placeRegisterResultText: says what was measured and never "aligned" or "verified"', async () => {
  const { reference, second, glbs } = await twoScans()
  const current = world([reference, second], [job('b')])
  await runPlaceRegisterJob(fakeHost(current, glbs).host, SLUG, 'job-b')
  const result = readPlaceRegisterResult(current.jobs[0]!)!
  const text = placeRegisterResultText(result)
  assert(/^Proposed a move for "Scan b"/.test(text), text)
  assert(/lines up/.test(text) && /cm/.test(text), text)
  assert(!/aligned|verified/i.test(text))
  const none = placeRegisterResultText({ ...result, proposal: { ...result.proposal, status: 'refused', transform: null, reason: 'ambiguous' } })
  assert(/^No move proposed for "Scan b": The walls do not settle one position\./.test(none), none)
})

// ─── The one job system ──────────────────────────────────────────────────────

Deno.test('queuePlaceRegisterForScan: a second calibrated scan joining a Place queues one proposal, and no more', () => {
  const create = (target: WorldProject, type: 'place-register', scanId: string, payload: Record<string, unknown>): WorldJob => {
    // The dedupe createWorldJob applies: one queued or processing job per (type, target).
    const existing = findDuplicateWorldJob(target.jobs, type, scanId)
    if (existing) return existing
    const made: WorldJob = { ...job(scanId, { status: 'queued', progress: 0, payload }) }
    target.jobs.unshift(made)
    target.jobs = trimWorldJobHistory(target.jobs)
    return made
  }

  const first = world([scan('a')])
  assertEquals(queuePlaceRegisterForScan(first, 'a', create), null, 'the first scan in a Place has nothing to be compared with')
  assertEquals(first.jobs.length, 0)

  const joined = world([scan('a'), scan('b', { capturedAt: '2026-11-12T00:00:00.000Z' })])
  const queued = queuePlaceRegisterForScan(joined, 'b', create)
  assert(queued)
  assertEquals(queued.type, 'place-register')
  assertEquals(queued.scanId, 'b')
  assertEquals(queued.payload, { source: 'joined-place', referenceScanIds: ['a'] })
  assertEquals(queuePlaceRegisterForScan(joined, 'b', create)?.jobId, queued.jobId, 'asked again, it is the same job')
  assertEquals(joined.jobs.length, 1)

  const uncalibrated = world([scan('a'), scan('u', { calibrationMethod: undefined })])
  assertEquals(queuePlaceRegisterForScan(uncalibrated, 'u', create), null)
})

Deno.test('place-register: the pump runs these jobs one at a time, and a stuck one is requeued like any other', async () => {
  const { reference, second, glbs } = await twoScans()
  const third = scan('e', { capturedAt: '2026-11-13T09:00:00.000Z', localToWorld: misplacementMatrix({ yawDeg: -2, dx: -0.2, dz: 0.3 }) })
  glbs.set(third.filename, await pointCloudGlb(room(3)))
  const current = world([reference, second, third], [job('b', { status: 'queued' }), job('e', { status: 'queued' })])
  const { host } = fakeHost(current, glbs)

  const order: string[] = []
  let running = 0
  let overlap = false
  const pump = new WorldJobPump(async (slug, jobId) => {
    running++
    if (running > 1) overlap = true
    order.push(`start:${jobId}`)
    const found = current.jobs.find((candidate) => candidate.jobId === jobId)!
    found.status = 'processing'
    await runPlaceRegisterJob(host, slug, jobId)
    order.push(`end:${jobId}`)
    running--
  })
  pump.enqueue(SLUG, 'job-b')
  pump.enqueue(SLUG, 'job-e')
  for (let i = 0; i < 200 && (pump.isWorking || pump.pendingCount > 0); i++) await new Promise((resolve) => setTimeout(resolve, 50))

  assertEquals(order, ['start:job-b', 'end:job-b', 'start:job-e', 'end:job-e'])
  assertEquals(overlap, false)
  assertEquals(current.jobs.map((candidate) => candidate.status), ['completed', 'completed'])

  const stuck = [job('b', { status: 'processing' }), job('x', { type: 'splat-train', status: 'completed' })]
  assertEquals(recoverStuckWorldJobs(stuck).map((recovered) => recovered.jobId), ['job-b'])
  assertEquals(stuck[0]!.status, 'queued')
})

Deno.test('place-register: the bounded history keeps a place-register job that is still active', () => {
  const settled = Array.from({ length: MAX_WORLD_JOB_HISTORY + 20 }, (_, i) =>
    job(`s${i}`, { jobId: `job-s${i}`, status: 'completed' }))
  const live = job('live', { status: 'queued' })
  const trimmed = trimWorldJobHistory([...settled, live])
  assert(trimmed.includes(live))
  assert(trimmed.length < settled.length)
})

// ─── The server's half of "apply once" ───────────────────────────────────────

/** A world with a finished job whose proposal is for scan b, and the patch body Apply would send. */
async function proposedWorld() {
  const { reference, second, glbs } = await twoScans()
  const current = world([reference, second], [job('b')])
  await runPlaceRegisterJob(fakeHost(current, glbs).host, SLUG, 'job-b')
  const result = readPlaceRegisterResult(current.jobs[0]!)!
  const body = buildRegisterPatch(result, 'job-b')!
  return { current, result, body }
}

/** What the route does with a patch the guard accepted. */
function applyBody(current: WorldProject, body: ReturnType<typeof buildRegisterPatch> & object): EditPatch {
  const patch: EditPatch = {
    patchId: 'patch-1',
    worldId: current.worldId,
    scanId: body.scanId,
    targetId: body.targetId,
    scope: 'scan',
    transform: body.transform,
    provenance: body.provenance,
    createdAt: '2026-11-16T10:05:00.000Z',
  }
  current.editPatches.push(patch)
  current.scans.find((s) => s.scanId === body.scanId)!.localToWorld = body.transform.matrix
  return patch
}

Deno.test('guardRegistrationPatch: a patch with no provenance is none of its business', async () => {
  const { current, body } = await proposedWorld()
  assertEquals(guardRegistrationPatch(current, { scope: 'scan', scanId: 'b', transform: { matrix: IDENTITY } }), { kind: 'plain' })
  assertEquals(guardRegistrationPatch(current, { scope: 'object', targetId: 'x', provenance: null } as never), { kind: 'plain' })
  assert(body.provenance)
})

Deno.test('guardRegistrationPatch: the patch the job proposed is accepted, with the job\'s own numbers as its provenance', async () => {
  const { current, result, body } = await proposedWorld()
  const guard = guardRegistrationPatch(current, body)
  assertEquals(guard.kind, 'ok')
  assert(guard.kind === 'ok')
  assertEquals(guard.provenance, {
    source: 'place-register',
    jobId: 'job-b',
    score: result.proposal.score,
    residualM: result.proposal.inlierResidualM,
  })
  // Extra keys a client adds are not stored.
  const padded = { ...body, provenance: { ...body.provenance, note: 'trust me' } }
  const guarded = guardRegistrationPatch(current, padded)
  assert(guarded.kind === 'ok')
  assertEquals(Object.keys(guarded.provenance).sort(), ['jobId', 'residualM', 'score', 'source'])
})

Deno.test('guardRegistrationPatch: a second apply of the same job gets the first patch back and writes nothing', async () => {
  const { current, body } = await proposedWorld()
  const first = applyBody(current, body)
  const again = guardRegistrationPatch(current, body)
  assertEquals(again.kind, 'duplicate')
  assert(again.kind === 'duplicate')
  assertEquals(again.patch.patchId, first.patchId)
  // The scan has moved, so by the freshness rule alone this would read as stale. Applied is checked first.
  assertNotEquals(current.scans.find((s) => s.scanId === 'b')!.localToWorld, misplacementMatrix(ERROR))
})

Deno.test('guardRegistrationPatch: a scan moved by hand since the check is not moved again on an old measurement', async () => {
  const { current, body } = await proposedWorld()
  current.scans.find((s) => s.scanId === 'b')!.localToWorld = multiplyMat4(misplacementMatrix({ yawDeg: 0, dx: 0.05, dz: 0 }), misplacementMatrix(ERROR))
  const stale = guardRegistrationPatch(current, body)
  assertEquals(stale.kind, 'refused')
  assert(stale.kind === 'refused')
  assertEquals(stale.status, 409)

  const { current: other, body: otherBody } = await proposedWorld()
  other.scans.find((s) => s.scanId === 'a')!.localToWorld = misplacementMatrix({ yawDeg: 0, dx: 0.5, dz: 0 })
  assertEquals((guardRegistrationPatch(other, otherBody) as { status?: number }).status, 409, 'the reference moved')
})

Deno.test('guardRegistrationPatch: provenance is only written for what the named job proposed', async () => {
  const { current, body } = await proposedWorld()
  const refusedWith = (patch: object, status = 400): void => {
    const guard = guardRegistrationPatch(current, patch as never)
    assertEquals(guard.kind, 'refused', JSON.stringify(patch).slice(0, 120))
    assert(guard.kind === 'refused')
    assertEquals(guard.status, status)
    assert(guard.error.length > 10)
  }
  refusedWith({ ...body, transform: { ...body.transform, matrix: misplacementMatrix({ yawDeg: 0, dx: 1, dz: 0 }) } })
  refusedWith({ ...body, provenance: { ...body.provenance, score: 0.99 } })
  refusedWith({ ...body, provenance: { ...body.provenance, residualM: 0.001 } })
  refusedWith({ ...body, provenance: { ...body.provenance, jobId: 'job-nope' } })
  refusedWith({ ...body, provenance: { ...body.provenance, source: 'someone-else' } })
  refusedWith({ ...body, provenance: 'place-register' })
  refusedWith({ ...body, provenance: { source: 'place-register', jobId: 'job-b' } })
  refusedWith({ ...body, scope: 'object' })
  refusedWith({ ...body, scanId: 'a' })

  // A job that proposed nothing, or is still running, has nothing to apply.
  const noMove = structuredClone(current)
  noMove.jobs[0]!.artifacts![0]!.metadata!['proposal'] = { ...(noMove.jobs[0]!.artifacts![0]!.metadata!['proposal'] as object), status: 'refused', transform: null, reason: 'ambiguous' }
  assertEquals(guardRegistrationPatch(noMove, body).kind, 'refused')
  const running = structuredClone(current)
  running.jobs[0]!.status = 'processing'
  assertEquals(guardRegistrationPatch(running, body).kind, 'refused')
})

Deno.test('comparePlacedClouds: returns null when nothing could be compared', async () => {
  assertEquals(await comparePlacedClouds({ scan: scan('b'), positions: room(2) }, [{ scan: scan('a'), load: async () => null }]), null)
  assertEquals(await comparePlacedClouds({ scan: scan('b'), positions: room(2) }, []), null)
})

// ─── The comparison loop ─────────────────────────────────────────────────────

/** A candidate whose cloud is `positions`, counting how many times it is read. */
function candidate(id: string, positions: ArrayLike<number> | null, reads: string[] = []) {
  return {
    scan: scan(id),
    load: async () => {
      reads.push(id)
      return positions
    },
  }
}

/** A room nowhere near ROOM: its footprint cannot meet the new scan's anywhere the search reaches. */
const farRoom = (seed: number) => makeRoom({ width: 5, depth: 4, centre: { x: 60 + seed * 20, z: 40 }, noiseM: 0.02, seed })

Deno.test('comparePlacedClouds: gives the rest of the server a turn before every search', async () => {
  const turns: string[] = []
  const moving = { scan: scan('b'), positions: misplacementOf(room(2)) }
  const reads: string[] = []
  const result = await comparePlacedClouds(
    moving,
    [candidate('a', room(1), reads), candidate('c', room(3), reads)],
    {
      yieldToServer: async () => {
        turns.push(`yield after ${reads.join('+')}`)
      },
    },
  )
  assert(result)
  assertEquals(turns, ['yield after a', 'yield after a+c'], 'one turn per pair, each after its cloud was read and before its search')
})

Deno.test('comparePlacedClouds: reads each cloud when its pair is reached and stops reading once the searches are done', async () => {
  const moving = { scan: scan('b'), positions: misplacementOf(room(2)) }
  const reads: string[] = []
  const result = await comparePlacedClouds(
    moving,
    [candidate('a', room(1), reads), candidate('c', room(3), reads), candidate('d', room(4), reads), candidate('e', room(5), reads)],
    { maxSearched: 2, yieldToServer: async () => {} },
  )
  assert(result)
  assertEquals(reads, ['a', 'c'], 'two searches, two reads: the others are never read')
  assertEquals(result.comparisons.map((row) => row.referenceScanId), ['a', 'c'])
})

Deno.test('comparePlacedClouds: a scan that cannot touch the new one is turned away at no cost to the searches', async () => {
  const moving = { scan: scan('b'), positions: misplacementOf(room(2)) }
  const result = await comparePlacedClouds(
    moving,
    [candidate('far1', farRoom(1)), candidate('far2', farRoom(2)), candidate('far3', farRoom(3)), candidate('a', room(1))],
    { maxSearched: 1, yieldToServer: async () => {} },
  )
  assert(result)
  assertEquals(result.comparisons.map((row) => [row.referenceScanId, row.status, row.reason]), [
    ['far1', 'refused', 'low-overlap'],
    ['far2', 'refused', 'low-overlap'],
    ['far3', 'refused', 'low-overlap'],
    ['a', 'proposed', null],
  ])
  assertEquals(result.reference.scanId, 'a')
})

/** The new scan's points in the Place frame as the job hands them over: placed by a calibration that is off by ERROR. */
function misplacementOf(points: Float32Array): Float32Array {
  return transformPositions(points, misplacementMatrix(ERROR))
}

Deno.test('place-register: both Place tiers promise the floor at project height 0, so a scan that saw no floor is still compared, with no height claim', async () => {
  for (const method of ['two-point-ground', 'ground-tap-compass'] as const) {
    const reference = scan('a', { capturedAt: '2026-11-10T09:00:00.000Z' })
    const second = scan('b', { calibrationMethod: method, capturedAt: '2026-11-12T09:00:00.000Z', localToWorld: misplacementMatrix(ERROR) })
    // The new scan has walls and a ceiling and no floor: the only horizontal layer is 2.6 m up.
    const glbs = new Map<string, Uint8Array | null>([
      [reference.filename, await pointCloudGlb(room(1))],
      [second.filename, await pointCloudGlb(room(2, { noFloor: true, boxes: [] }))],
    ])
    const current = world([reference, second], [job('b')])
    await runPlaceRegisterJob(fakeHost(current, glbs).host, SLUG, 'job-b')
    const result = readPlaceRegisterResult(current.jobs[0]!)!
    assertEquals(result.proposal.status, 'proposed', `${method}: ${result.proposal.reason}`)
    assertEquals(result.proposal.details.floors, { reference: 'cloud', moving: 'hint-over-cloud' }, method)
    assertEquals(result.proposal.details.verticalChecked, false, method)
    assertEquals(result.proposal.transform![13], 0, `${method}: no height claim, so no height move`)
    const recovered = recoveryError(result.proposal.transform!, ERROR, corners(ROOM))
    assert(recovered.positionM < 0.05 && Math.abs(recovered.yawDeg) < 1, `${method}: ${recovered.positionM} m, ${recovered.yawDeg} deg`)
  }
})

Deno.test('patchedScanIds: the scans a scan patch has placed, and no others', () => {
  const patch = (overrides: Partial<EditPatch>): EditPatch => ({
    patchId: 'p', worldId: 'w', scope: 'scan', scanId: 'b', targetId: 'b.glb', transform: { matrix: IDENTITY }, createdAt: '2026-11-16T10:00:00.000Z', ...overrides,
  })
  assertEquals([...patchedScanIds([patch({}), patch({ scanId: 'c' })])].sort(), ['b', 'c'])
  assertEquals([...patchedScanIds([patch({ scope: 'object' }), patch({ transform: undefined }), patch({ scanId: undefined })])], [], 'only a scan patch with a matrix places a scan')
  assertEquals(patchedScanIds(undefined).size, 0, 'older world files have no patches')
})

Deno.test('place-register: a scan a patch has lifted keeps no promise about its floor, so its own floor is used as it is', async () => {
  // The scan was moved up 20 cm in the editor. Its floor now sits at 0.2 in the Place frame; the calibration's promise
  // (project height 0) was about where the capture put it.
  const lift: Misplacement = { ...ERROR, dy: 0.2 }
  const reference = scan('a', { capturedAt: '2026-11-10T09:00:00.000Z' })
  const lifted = scan('b', { capturedAt: '2026-11-12T09:00:00.000Z', localToWorld: misplacementMatrix(lift) })
  const glbs = new Map<string, Uint8Array | null>([
    [reference.filename, await pointCloudGlb(room(1))],
    [lifted.filename, await pointCloudGlb(room(2))],
  ])
  const patch: EditPatch = {
    patchId: 'patch-1', worldId: 'world-project-proj-1', scope: 'scan', scanId: 'b', targetId: lifted.filename,
    transform: { matrix: misplacementMatrix(lift) }, createdAt: '2026-11-12T10:00:00.000Z',
  }

  const patched = world([reference, lifted], [job('b')], [patch])
  await runPlaceRegisterJob(fakeHost(patched, glbs).host, SLUG, 'job-b')
  const measured = readPlaceRegisterResult(patched.jobs[0]!)!
  assertEquals(measured.proposal.status, 'proposed', String(measured.proposal.reason))
  assertEquals(measured.proposal.details.floors, { reference: 'cloud', moving: 'cloud' })
  assertEquals(measured.proposal.details.verticalChecked, true)
  assertAlmostEquals(measured.proposal.transform![13]!, -0.2, 0.01, 'the 20 cm is a measured height change')

  // The same scan with nothing on record about a patch: the promise stands, its floor 20 cm off it is not believed.
  const unpatched = world([reference, lifted], [job('b')])
  await runPlaceRegisterJob(fakeHost(unpatched, glbs).host, SLUG, 'job-b')
  const promised = readPlaceRegisterResult(unpatched.jobs[0]!)!
  assertEquals(promised.proposal.details.floors, { reference: 'cloud', moving: 'hint-over-cloud' })
  assertEquals(promised.proposal.transform![13], 0)
})

// ─── Several scans in one Place ──────────────────────────────────────────────

Deno.test('place-register: five newer scans of other rooms do not keep the job from the earlier scan of this one', async () => {
  const earlier = scan('kitchen-1', { areaId: 'kitchen', capturedAt: '2026-11-01T09:00:00.000Z' })
  const glbs = new Map<string, Uint8Array | null>([[earlier.filename, await pointCloudGlb(room(1))]])
  const others: ScanManifest[] = []
  for (let i = 0; i < 5; i++) {
    // Each filed under its own area, and placed nowhere near the kitchen: they would crowd a newest-first list of four.
    const other = scan(`room-${i}`, { areaId: `room-${i}`, capturedAt: `2026-11-0${i + 2}T09:00:00.000Z` })
    others.push(other)
    glbs.set(other.filename, await pointCloudGlb(farRoom(i + 1)))
  }
  const again = scan('kitchen-2', { areaId: 'kitchen', capturedAt: '2026-11-10T09:00:00.000Z', localToWorld: misplacementMatrix(ERROR) })
  glbs.set(again.filename, await pointCloudGlb(room(2)))
  const current = world([earlier, ...others, again], [job('kitchen-2')])
  const { host, log } = fakeHost(current, glbs)

  await runPlaceRegisterJob(host, SLUG, 'job-kitchen-2')

  const result = readPlaceRegisterResult(current.jobs[0]!)!
  assertEquals(result.proposal.status, 'proposed', String(result.proposal.reason))
  assertEquals(result.reference.scanId, 'kitchen-1')
  assertEquals(result.comparisons.map((row) => row.referenceScanId), ['kitchen-1'], 'the other rooms were never compared')
  assert(!log.reads.some((name) => name.startsWith('room-')), `their clouds were not even read: ${log.reads}`)
})

Deno.test('place-register: with no areas filed, scans far away cannot use up the searches either', async () => {
  const earlier = scan('first', { capturedAt: '2026-11-01T09:00:00.000Z' })
  const glbs = new Map<string, Uint8Array | null>([[earlier.filename, await pointCloudGlb(room(1))]])
  const others: ScanManifest[] = []
  for (let i = 0; i < 5; i++) {
    const other = scan(`far-${i}`, { capturedAt: `2026-11-0${i + 2}T09:00:00.000Z` })
    others.push(other)
    glbs.set(other.filename, await pointCloudGlb(farRoom(i + 1)))
  }
  const again = scan('again', { capturedAt: '2026-11-10T09:00:00.000Z', localToWorld: misplacementMatrix(ERROR) })
  glbs.set(again.filename, await pointCloudGlb(room(2)))
  const current = world([earlier, ...others, again], [job('again')])

  await runPlaceRegisterJob(fakeHost(current, glbs).host, SLUG, 'job-again')

  const result = readPlaceRegisterResult(current.jobs[0]!)!
  assertEquals(result.proposal.status, 'proposed', String(result.proposal.reason))
  assertEquals(result.reference.scanId, 'first', 'six candidates, the oldest the right one')
  assertEquals(result.comparisons.length, 6)
  assertEquals(result.comparisons.filter((row) => row.reason === 'low-overlap').length, 5)
})
