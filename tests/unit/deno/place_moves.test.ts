/**
 * What the registry does about frames when scans are put in another Place (server/place_moves.ts, ADR 0009), with the
 * registry, the stored scans and the photo folder stood in for: a moved scan is judged before anything is touched and
 * the Place changes only once the scans are filed; a merge across frames describes the other Place's reference in the
 * target's history and copies its photos; a Place with no frame takes the one the scans were measured against.
 *
 * The decisions themselves are in frame_generations.test.ts, and the same through the real server in
 * frame_generations_route.test.ts. What this file adds is the order of things: that a plan changes nothing, that a
 * commit judges again on the registry as it is by then, and that nothing is described twice.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { createPlaceMoves, isScanNamed, type PlaceMoveDeps, type StoredScanFacts } from '../../../server/place_moves.ts'
import { framePhotoDirPath } from '../../../server/project_media.ts'
import { frameHistoryEntry } from '../../../src/world/frame-generations.ts'
import type { FrameHistoryEntry, Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

const AT_A = '2026-11-16T08:00:00.000Z'
const AT_B = '2026-11-16T09:00:00.000Z'
const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function frame(createdAt: string, separationM: number, extra: Record<string, unknown> = {}): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...extra,
  } as ProjectSpatialFrame
}

const photo = (url: string | null, key: string) => ({
  url,
  localKey: key,
  tapPoint: { x: 0.4, y: 0.6 },
  pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: AT_A,
})

const GEN_A = frame(AT_A, 2, { frameId: 'gen-a', referencePhotos: { landmark: photo('/projects/proj-a/frames/gen-a/ref-landmark.jpg', 'proj-a:gen-a:landmark'), headingMarker: photo(null, 'proj-a:gen-a:heading') } })
const GEN_B = frame(AT_B, 3, { frameId: 'gen-b' })
const LEGACY = frame(AT_A, 2)

function place(projectId: string, extra: Partial<Project> = {}): Project {
  return { projectId, name: `Place ${projectId}`, createdAt: 1, updatedAt: 1, floors: [], ...extra }
}

const old = (id: string, supersededAt: string): FrameHistoryEntry => ({ frameId: id, createdAt: AT_A, method: 'two-point-ground', separationM: 2, supersededAt, reason: 'override' })

/** The sidecar of a two-point scan of a Place, naming the generation it was measured against. */
function twoPoint(filename: string, projectId: string, frameId?: string, extra: Record<string, unknown> = {}): StoredScanFacts {
  return {
    filename,
    meta: {
      projectId,
      calibrationMethod: 'two-point-ground',
      calibrationStatus: 'verified',
      calibration: { method: 'two-point-ground', separationM: 2, residualM: 0, toleranceM: 0.15, calibratedAt: AT_A, ...(frameId ? { frameId } : {}) },
      ...extra,
    },
  }
}

const uncalibrated = (filename: string, projectId: string): StoredScanFacts => ({ filename, meta: { projectId, calibrationMethod: null, calibrationStatus: 'uncalibrated', calibration: null } })

async function setup(places: Project[], scans: StoredScanFacts[]) {
  const mediaDir = await Deno.makeTempDir({ prefix: 'place-moves-' })
  let registry = structuredClone(places)
  let saves = 0
  const deps: PlaceMoveDeps = {
    mediaDir,
    listStoredScans: () => Promise.resolve(scans),
    loadProjects: () => Promise.resolve(structuredClone(registry)),
    mutateProjects: async (mutator) => {
      const projects = structuredClone(registry)
      const { result, save } = await mutator(projects)
      if (save) {
        registry = projects
        saves += 1
      }
      return result
    },
    countScans: (projectId) => Promise.resolve(scans.filter((scan) => scan.meta['projectId'] === projectId).length),
    now: () => NOW,
  }
  const writePhoto = async (projectId: string, frameId: string, role: string, text: string) => {
    const dir = framePhotoDirPath(mediaDir, projectId, frameId)!
    await Deno.mkdir(dir, { recursive: true })
    await Deno.writeTextFile(`${dir}/ref-${role}.jpg`, text)
  }
  const readPhoto = (projectId: string, frameId: string, role: string) =>
    Deno.readTextFile(`${framePhotoDirPath(mediaDir, projectId, frameId)!}/ref-${role}.jpg`).catch(() => null)
  return {
    moves: createPlaceMoves(deps),
    registry: () => registry,
    place: (id: string) => registry.find((candidate) => candidate.projectId === id)!,
    setRegistry: (next: Project[]) => { registry = structuredClone(next) },
    saves: () => saves,
    writePhoto,
    readPhoto,
    cleanup: () => Deno.remove(mediaDir, { recursive: true }),
  }
}

Deno.test('a stored scan is the one a request names by its id, its file name or its session, and by nothing else', () => {
  assertEquals(isScanNamed('1700000000001_kitchen.glb', {}, 'scan-1700000000001_kitchen'), true, 'the id the server derives from the file')
  assertEquals(isScanNamed('1700000000001_kitchen.glb', {}, '1700000000001_kitchen.glb'), true)
  assertEquals(isScanNamed('1700000000001_kitchen.glb', { sessionId: 'sess-1' }, 'sess-1'), true)
  assertEquals(isScanNamed('1700000000001_kitchen.glb', { sessionId: 'sess-1' }, 'sess-2'), false)
  assertEquals(isScanNamed('1700000000001_kitchen.glb', { sessionId: '' }, ''), false, 'an empty session is none')
  assertEquals(isScanNamed('1700000000001_kitchen.glb', { sessionId: null }, 'scan-other'), false)
})

Deno.test('a plan names the stored scans the request means, refuses a move across frames, and changes nothing', async () => {
  const t = await setup(
    [place('proj-a', { spatialFrame: GEN_A, spatialFrameRevision: 1 }), place('proj-b', { spatialFrame: GEN_B, spatialFrameRevision: 1 })],
    [twoPoint('k.glb', 'proj-a', 'gen-a'), twoPoint('s.glb', 'proj-a', 'gen-a', { sessionId: 'sess-1' }), twoPoint('s2.glb', 'proj-a', 'gen-a', { sessionId: 'sess-1' })],
  )
  try {
    const before = JSON.stringify(t.registry())
    assertEquals(await t.moves.planScanMove('scan-nowhere', 'proj-b', true), { kind: 'none' })
    const refused = await t.moves.planScanMove('scan-k', 'proj-b', false)
    assert(refused.kind === 'refused')
    assertEquals([refused.body.code, refused.body.scans, refused.body.target?.frameId, refused.body.source?.frameId], ['frame-mismatch', 1, 'gen-b', 'gen-a'])
    // A request that names several scans (they share a session) is judged on all of them, and says how many.
    const session = await t.moves.planScanMove('sess-1', 'proj-b', false)
    assert(session.kind === 'refused')
    assertEquals(session.body.scans, 2)
    const accepted = await t.moves.planScanMove('sess-1', 'proj-b', true)
    assert(accepted.kind === 'go')
    assertEquals(accepted.filenames, ['s.glb', 's2.glb'], 'exactly the scans the request names, for the route to file')
    assertEquals(JSON.stringify(t.registry()), before, 'a plan changes nothing')
    assertEquals(t.saves(), 0)
  } finally {
    await t.cleanup()
  }
})

Deno.test('what is not in a Place frame, and a move within the scan\'s own Place, is never refused and changes no Place when committed', async () => {
  const t = await setup(
    [place('proj-a', { spatialFrame: GEN_A, spatialFrameRevision: 1 }), place('proj-b', { spatialFrame: GEN_B, spatialFrameRevision: 1 })],
    [uncalibrated('u.glb', 'proj-a'), twoPoint('prev.glb', 'proj-a', 'gen-b')],
  )
  try {
    const before = JSON.stringify(t.registry())
    for (const [name, target] of [['scan-u', 'proj-b'], ['scan-prev', 'proj-a']] as const) {
      const plan = await t.moves.planScanMove(name, target, false)
      assert(plan.kind === 'go', `${name} into ${target}`)
      await plan.commit()
    }
    assertEquals(JSON.stringify(t.registry()), before)
    assertEquals(t.saves(), 0, 'the registry was not even written')
  } finally {
    await t.cleanup()
  }
})

Deno.test('a Place changes when its scans are filed, not when the move is judged: a plan whose commit never comes has changed nothing', async () => {
  const t = await setup([place('proj-a', { spatialFrame: GEN_A, spatialFrameRevision: 1 }), place('proj-c')], [twoPoint('k.glb', 'proj-a', 'gen-a')])
  try {
    const plan = await t.moves.planScanMove('scan-k', 'proj-c', false)
    assert(plan.kind === 'go')
    assertEquals(t.place('proj-c').spatialFrame, undefined, 'the plan took no frame')
    await plan.commit()
    const shed = t.place('proj-c')
    assertEquals([(shed.spatialFrame as { frameId: string }).frameId, shed.spatialFrameRevision, shed.updatedAt], ['gen-a', 1, NOW], 'the commit did, and said when')
    assertEquals(shed.frameHistory, undefined, 'one scan came, not the Place: the generations the other Place held before are not listed')
  } finally {
    await t.cleanup()
  }
})

Deno.test('a commit judges again on the registry as it is by then: a Place that took a frame in the meantime is not given another', async () => {
  const t = await setup([place('proj-a', { spatialFrame: GEN_A, spatialFrameRevision: 1 }), place('proj-c')], [twoPoint('k.glb', 'proj-a', 'gen-a')])
  try {
    const plan = await t.moves.planScanMove('scan-k', 'proj-c', false)
    assert(plan.kind === 'go')
    // Meanwhile another device calibrates the Shed.
    t.setRegistry([t.place('proj-a'), place('proj-c', { spatialFrame: GEN_B, spatialFrameRevision: 1 })])
    await plan.commit()
    const shed = t.place('proj-c')
    assertEquals([(shed.spatialFrame as { frameId: string }).frameId, shed.spatialFrameRevision, shed.frameHistory], ['gen-b', 1, undefined], 'its own frame, untouched: the request did not say it knows')
    assertEquals(t.saves(), 0)
  } finally {
    await t.cleanup()
  }
})

Deno.test('a scan moved across frames with the flag brings the generation it names into the target\'s history, with its photos, once', async () => {
  const t = await setup(
    [place('proj-a', { spatialFrame: GEN_A, spatialFrameRevision: 1, frameHistory: [old('gen-0', AT_A)] }), place('proj-b', { spatialFrame: GEN_B, spatialFrameRevision: 4 })],
    [twoPoint('k.glb', 'proj-a', 'gen-a'), twoPoint('p.glb', 'proj-a', 'gen-0'), twoPoint('n.glb', 'proj-a')],
  )
  try {
    await t.writePhoto('proj-a', 'gen-a', 'landmark', 'landmark of a')
    await t.writePhoto('proj-a', 'gen-0', 'heading', 'heading of the generation before')
    const commit = async (name: string) => {
      const plan = await t.moves.planScanMove(name, 'proj-b', true)
      assert(plan.kind === 'go', name)
      await plan.commit()
    }
    await commit('scan-k')
    assertEquals(t.place('proj-b').frameHistory, [{ frameId: 'gen-a', createdAt: AT_A, method: 'two-point-ground', separationM: 2, supersededAt: new Date(NOW).toISOString(), reason: 'merge' }])
    assertEquals(t.place('proj-b').spatialFrameRevision, 4, 'the target\'s frame is not written: its revision stays')
    assertEquals(t.place('proj-b').updatedAt, NOW)
    assertEquals(await t.readPhoto('proj-b', 'gen-a', 'landmark'), 'landmark of a', 'the target serves it')
    assertEquals(await t.readPhoto('proj-a', 'gen-a', 'landmark'), 'landmark of a', 'the source keeps its own')

    // The same generation again, from another scan: described once. One that was held before comes as the history has it.
    const savesAfterFirst = t.saves()
    await commit('scan-k')
    assertEquals([t.place('proj-b').frameHistory!.length, t.saves()], [1, savesAfterFirst], 'nothing new, nothing written')
    await commit('scan-p')
    assertEquals(t.place('proj-b').frameHistory!.map((entry) => [entry.frameId, entry.reason]), [['gen-0', 'override'], ['gen-a', 'merge']], 'by its own time, with the reason its Place gave')
    assertEquals(await t.readPhoto('proj-b', 'gen-0', 'heading'), 'heading of the generation before')
    // A scan that names no generation has none to bring.
    const unrecorded = t.saves()
    await commit('scan-n')
    assertEquals(t.saves(), unrecorded)
  } finally {
    await t.cleanup()
  }
})

Deno.test('merging across frames is refused with the number of scans until the request says it knows, and then describes the source\'s reference in the target\'s history', async () => {
  const t = await setup(
    [place('proj-b', { spatialFrame: GEN_B, spatialFrameRevision: 3 }), place('proj-a', { name: 'House A', spatialFrame: GEN_A, spatialFrameRevision: 1, frameHistory: [old('gen-0', AT_A)] })],
    [twoPoint('k.glb', 'proj-a', 'gen-a'), twoPoint('l.glb', 'proj-a', 'gen-0')],
  )
  try {
    await t.writePhoto('proj-a', 'gen-a', 'landmark', 'landmark of a')
    await t.writePhoto('proj-a', 'gen-0', 'check1', 'first check of the generation before')
    const target = () => t.place('proj-b')
    const before = JSON.stringify(t.registry())
    const asked = structuredClone(t.registry())
    const refused = await t.moves.mergeFrames(asked.find((p) => p.projectId === 'proj-b')!, asked.find((p) => p.projectId === 'proj-a')!, false)
    assertEquals([refused?.code, refused?.scans, refused?.source?.frameId, refused?.target?.frameId], ['frame-mismatch', 2, 'gen-a', 'gen-b'])
    assert(refused!.error.includes('"House A"'))
    assertEquals(JSON.stringify(asked.find((p) => p.projectId === 'proj-b')), JSON.stringify(t.place('proj-b')), 'the target was not changed by a refusal')
    assertEquals(JSON.stringify(t.registry()), before)

    const merging = structuredClone(t.registry())
    const [into, from] = [merging.find((p) => p.projectId === 'proj-b')!, merging.find((p) => p.projectId === 'proj-a')!]
    assertEquals(await t.moves.mergeFrames(into, from, true), null)
    assertEquals(into.spatialFrame, GEN_B, 'the target keeps its own frame')
    assertEquals(into.spatialFrameRevision, 3)
    assertEquals(into.frameHistory!.map((entry) => [entry.frameId, entry.reason]), [['gen-0', 'override'], ['gen-a', 'merge']])
    assertEquals(into.frameHistory![1]!.supersededAt, new Date(NOW).toISOString())
    assertEquals(await t.readPhoto('proj-b', 'gen-a', 'landmark'), 'landmark of a')
    assertEquals(await t.readPhoto('proj-b', 'gen-0', 'check1'), 'first check of the generation before')
    assertEquals(target().frameHistory, undefined, 'the registry is the mutator\'s to save: it saw only copies')
  } finally {
    await t.cleanup()
  }
})

Deno.test('merging into a Place with no frame gives it the source\'s frame with photos of its own, its revision and the generations before it; the same generation only brings the history', async () => {
  const t = await setup([place('proj-c'), place('proj-a', { spatialFrame: GEN_A, spatialFrameRevision: 5, frameHistory: [old('gen-0', AT_A)] }), place('proj-twin', { spatialFrame: GEN_A, spatialFrameRevision: 2 })], [])
  try {
    await t.writePhoto('proj-a', 'gen-a', 'landmark', 'landmark of a')
    await t.writePhoto('proj-a', 'gen-0', 'landmark', 'landmark of the generation before')
    const projects = structuredClone(t.registry())
    const get = (id: string) => projects.find((candidate) => candidate.projectId === id)!
    assertEquals(await t.moves.mergeFrames(get('proj-c'), get('proj-a'), false), null)
    const shed = get('proj-c')
    assertEquals([shed.spatialFrameRevision, shed.updatedAt, shed.frameHistory?.map((entry) => entry.frameId)], [1, NOW, ['gen-0']])
    assertEquals((shed.spatialFrame as { referencePhotos: { landmark: { url: string | null }; headingMarker: { url: string | null } } }).referencePhotos.landmark.url, '/projects/proj-c/frames/gen-a/ref-landmark.jpg')
    assertEquals(await t.readPhoto('proj-c', 'gen-a', 'landmark'), 'landmark of a')
    assertEquals(await t.readPhoto('proj-c', 'gen-0', 'landmark'), 'landmark of the generation before')

    // The same generation: the history comes, the frame and its revision are the target's own.
    assertEquals(await t.moves.mergeFrames(get('proj-twin'), get('proj-a'), false), null)
    const twin = get('proj-twin')
    assertEquals([twin.spatialFrameRevision, twin.frameHistory?.map((entry) => entry.frameId)], [2, ['gen-0']])
    // The generation the target holds now is never described as one it had before.
    const holder = place('proj-d', { spatialFrame: GEN_B, spatialFrameRevision: 1 })
    const other = place('proj-e', { spatialFrame: GEN_B, spatialFrameRevision: 1, frameHistory: [frameHistoryEntry(GEN_B, 'override', NOW - 1), old('gen-0', AT_A)] })
    assertEquals(await t.moves.mergeFrames(holder, other, false), null)
    assertEquals(holder.frameHistory?.map((entry) => entry.frameId), ['gen-0'])
  } finally {
    await t.cleanup()
  }
})

Deno.test('a frame with no id that the target already describes is not described again, and the target is left exactly as it was', async () => {
  const legacy = { frameId: null, createdAt: '2026-11-01T00:00:00.000Z', method: 'two-point-ground', separationM: 2, supersededAt: AT_A, reason: 'upgrade' } as FrameHistoryEntry
  const t = await setup([
    place('proj-b', { spatialFrame: GEN_B, spatialFrameRevision: 3, updatedAt: 7, frameHistory: [legacy] }),
    place('proj-a', { spatialFrame: GEN_B, spatialFrameRevision: 1, frameHistory: [{ ...legacy }] }),
  ], [])
  try {
    const projects = structuredClone(t.registry())
    const target = projects.find((candidate) => candidate.projectId === 'proj-b')!
    const before = JSON.stringify(target)
    assertEquals(await t.moves.mergeFrames(target, projects.find((candidate) => candidate.projectId === 'proj-a')!, false), null)
    assertEquals(JSON.stringify(target), before, 'nothing new to say, so the Place is not changed, and its updatedAt is not moved')
  } finally {
    await t.cleanup()
  }
})

Deno.test('merging a source that holds no frame and no history changes the target not at all', async () => {
  const t = await setup([place('proj-b', { spatialFrame: GEN_B, spatialFrameRevision: 3, updatedAt: 7 }), place('proj-n'), place('proj-legacy', { spatialFrame: LEGACY })], [])
  try {
    const projects = structuredClone(t.registry())
    const target = projects.find((candidate) => candidate.projectId === 'proj-b')!
    const before = JSON.stringify(target)
    assertEquals(await t.moves.mergeFrames(target, projects.find((candidate) => candidate.projectId === 'proj-n')!, false), null)
    assertEquals(JSON.stringify(target), before)
    // A frame with no id is described by nothing a scan can name, so it is not described.
    assertEquals(await t.moves.mergeFrames(target, projects.find((candidate) => candidate.projectId === 'proj-legacy')!, true), null)
    assertEquals(target.frameHistory, undefined)
  } finally {
    await t.cleanup()
  }
})
