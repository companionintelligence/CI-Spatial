/**
 * The Places registry (server/wp-a-projects.ts). The file is the only copy of every Place,
 * floor, room and area, so a read error must never look like "no Places yet", a corrupt file
 * must survive a save, and a malformed Place body must be refused before it is stored.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import {
  adoptedFrameError,
  applySpatialFrameWrite,
  isPlaceType,
  placeBodyError,
  placeFromBody,
  readRegistry,
  RegistryUnparsableError,
  saveRegistry,
} from '../../../server/wp-a-projects.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

async function tempRegistry(): Promise<{ dir: string; file: string }> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-a-projects-' })
  return { dir, file: `${dir}/projects.json` }
}

function place(projectId: string): Project {
  return {
    projectId,
    name: `Place ${projectId}`,
    createdAt: 1,
    updatedAt: 1,
    floors: [{ floorId: `floor-${projectId}`, name: 'Ground Floor', level: 0, rooms: [] }],
  }
}

Deno.test('a missing registry reads as no registry yet, not as an error', async () => {
  const { dir, file } = await tempRegistry()
  try {
    assertEquals(await readRegistry(file), null)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a registry that is not a JSON list throws, and is never read as empty', async () => {
  const { dir, file } = await tempRegistry()
  try {
    await Deno.writeTextFile(file, '{"not":"a list"}')
    await assertRejects(() => readRegistry(file), RegistryUnparsableError)
    await Deno.writeTextFile(file, '[{"projectId": ')
    await assertRejects(() => readRegistry(file), RegistryUnparsableError)
    await Deno.writeTextFile(file, '[1, "two"]')
    await assertRejects(() => readRegistry(file), RegistryUnparsableError, 'not a JSON list of Places')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a read failure other than a missing file is rethrown, not treated as an unparsable registry', async () => {
  const { dir } = await tempRegistry()
  try {
    // A directory cannot be read as a file: that is an I/O-class failure, not bad content.
    const err = await readRegistry(dir).then(() => null, (e: unknown) => e)
    assert(err instanceof Error, 'a read failure must reject')
    assert(!(err instanceof RegistryUnparsableError), 'an I/O failure must not look like bad content')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a corrupt registry is kept aside as a copy by the next save, and its bytes survive', async () => {
  const { dir, file } = await tempRegistry()
  try {
    await Deno.writeTextFile(file, 'garbage{ not json')
    const corruptCopy = await saveRegistry(file, [place('proj-1')], 1234)
    assertEquals(corruptCopy, `${file}.corrupt-1234`)
    assertEquals(await Deno.readTextFile(`${file}.corrupt-1234`), 'garbage{ not json')
    assertEquals((await readRegistry(file))?.map(p => p.projectId), ['proj-1'])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('each save keeps the previous registry as .bak', async () => {
  const { dir, file } = await tempRegistry()
  try {
    await saveRegistry(file, [place('proj-1')])
    await saveRegistry(file, [place('proj-1'), place('proj-2')])
    const bak = JSON.parse(await Deno.readTextFile(`${file}.bak`)) as Project[]
    assertEquals(bak.map(p => p.projectId), ['proj-1'], 'the .bak is the version before the last save')
    assertEquals((await readRegistry(file))?.length, 2)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('the first save creates the registry and leaves no .bak', async () => {
  const { dir, file } = await tempRegistry()
  try {
    assertEquals(await saveRegistry(file, [place('proj-1')]), null, 'there was no corrupt file to copy aside')
    assertEquals((await readRegistry(file))?.length, 1)
    await assertRejects(() => Deno.stat(`${file}.bak`))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('isPlaceType accepts exactly the four Place types', () => {
  for (const value of ['building', 'floor', 'room', 'other']) assertEquals(isPlaceType(value), true, value)
  for (const value of ['house', '', null, undefined, 3]) assertEquals(isPlaceType(value), false, String(value))
})

// The body the web client PUTs is the whole Place it read from GET /projects.
const CLIENT_PLACE = {
  projectId: 'proj-1700000000000',
  name: 'Kitchen wing',
  placeType: 'building',
  parentProjectId: null,
  address: '1 Example Road',
  notes: '',
  geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
  createdAt: 1700000000000,
  updatedAt: 1700000000500,
  areas: [{ areaId: 'area-1', name: 'Kitchen wing', kind: 'site', parentAreaId: null }],
  floors: [{
    floorId: 'floor-1',
    name: 'Ground Floor',
    level: 0,
    rooms: [{ roomId: 'room-1', name: 'Kitchen' }],
  }],
}

Deno.test('a Place body in the shape the client sends is accepted for replace', () => {
  assertEquals(placeBodyError(CLIENT_PLACE, 'replace'), null)
})

Deno.test('a Place body in the shape the create form sends is accepted for create', () => {
  assertEquals(
    placeBodyError({ name: 'Home', placeType: 'building', address: '1 Main', geoPose: { lat: 51.5, lng: -0.1 } }, 'create'),
    null,
  )
  assertEquals(placeBodyError({}, 'create'), null, 'a missing name is answered by the route, not here')
})

Deno.test('a replace body without floors is refused, since every later read walks floors', () => {
  const { floors: _floors, ...withoutFloors } = CLIENT_PLACE
  assertEquals(placeBodyError(withoutFloors, 'replace'), 'floors must be a list')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, floors: 'none' }, 'replace'), 'floors must be a list')
})

Deno.test('floors, rooms and areas must have the ids and list shapes the registry reads', () => {
  assertEquals(placeBodyError({ ...CLIENT_PLACE, floors: [{ name: 'x', level: 0, rooms: [] }] }, 'replace'), 'each floor needs a floorId')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, floors: [{ floorId: 'f', name: 'x', level: 0 }] }, 'replace'), 'each floor needs a rooms list')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, floors: [{ floorId: 'f', name: 'x', level: 0, rooms: [{ name: 'no id' }] }] }, 'replace'), 'each room needs a roomId')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, areas: 'site' }, 'replace'), 'areas must be a list')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, areas: [{ name: 'no id' }] }, 'replace'), 'each area needs an areaId')
})

Deno.test('an unknown placeType is refused, and every known one is accepted', () => {
  assertEquals(placeBodyError({ ...CLIENT_PLACE, placeType: 'castle' }, 'replace'), 'placeType must be building, floor, room, or other')
  for (const placeType of ['building', 'floor', 'room', 'other']) {
    assertEquals(placeBodyError({ ...CLIENT_PLACE, placeType }, 'replace'), null, placeType)
  }
})

Deno.test('a body that is not an object, and a non-text name or id, are refused', () => {
  assertEquals(placeBodyError(null, 'replace'), 'Place must be a JSON object')
  assertEquals(placeBodyError([CLIENT_PLACE], 'replace'), 'Place must be a JSON object')
  assertEquals(placeBodyError('Home', 'create'), 'Place must be a JSON object')
  assertEquals(placeBodyError({ name: 5 }, 'create'), 'name must be text')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, name: undefined }, 'replace'), 'name must be text')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, projectId: 42 }, 'replace'), 'projectId must be text')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, parentProjectId: 7 }, 'replace'), 'parentProjectId must be text or null')
})

// ── The frame in a whole-record body, and the one route that replaces it ──────────────────────────

Deno.test('a spatialFrame in a replace body has to be an object, and nothing else about it is judged there', () => {
  assertEquals(placeBodyError({ ...CLIENT_PLACE, spatialFrame: { version: 1 } }, 'replace'), null, 'the shape only: adoptedFrameError judges the frame when the Place can use it')
  assertEquals(placeBodyError({ ...CLIENT_PLACE, spatialFrame: null }, 'replace'), null)
  assertEquals(placeBodyError({ ...CLIENT_PLACE, spatialFrame: undefined }, 'replace'), null)
  for (const bad of ['banana', 5, true, [], [{}]]) {
    assertEquals(placeBodyError({ ...CLIENT_PLACE, spatialFrame: bad }, 'replace'), 'spatialFrame must be an object', JSON.stringify(bad))
  }
  assertEquals(placeBodyError({ name: 'Home', spatialFrame: 'banana' }, 'create'), null, 'a create body has no frame, and the route does not read one')
})

function frame(createdAt: string, separationM = 2): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt,
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: separationM },
    separationM,
    toleranceM: 0.15,
    anchorBearingDeg: null,
  }
}

const FRAME_A = frame('2026-11-16T09:00:00.000Z', 2)
const FRAME_B = frame('2026-11-16T10:00:00.000Z', 3)

function registry(...places: Array<Partial<Project>>): Project[] {
  return places.map((extra, i) => ({ ...place(`proj-${i + 1}`), ...extra }))
}

Deno.test('the first frame write is accepted at revision 0, stored, and counted as revision 1', () => {
  const projects = registry({})
  const { result, save } = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 5000)
  assertEquals(result, { status: 200, body: { revision: 1, frame: FRAME_A } })
  assertEquals(save, true)
  assertEquals(projects[0]!.spatialFrame, FRAME_A)
  assertEquals(projects[0]!.spatialFrameRevision, 1)
  assertEquals(projects[0]!.updatedAt, 5000, 'a frame write is a save of the Place')
})

Deno.test('every accepted write adds one to the revision, and the next writer must name it', () => {
  const projects = registry({})
  assertEquals(applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 1).result.status, 200)
  const second = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_B, expectedRevision: 1 }, 2)
  assertEquals(second.result, { status: 200, body: { revision: 2, frame: FRAME_B } })
  assertEquals(projects[0]!.spatialFrame, FRAME_B)
  assertEquals(projects[0]!.spatialFrameRevision, 2)
  const third = applySpatialFrameWrite(projects, 'proj-1', { frame: frame('2026-11-16T11:00:00.000Z', 4), expectedRevision: 2 }, 3)
  assertEquals(third.result.status === 200 && third.result.body.revision, 3)
})

Deno.test('a write that names a stale revision is a 409 that returns the frame and revision held, and changes nothing', () => {
  const projects = registry({ spatialFrame: FRAME_B, spatialFrameRevision: 2, updatedAt: 77 })
  const { result, save } = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 1 }, 5000)
  assertEquals(result.status, 409)
  assertEquals(result.status === 409 && result.body.current, { frame: FRAME_B, revision: 2 })
  assertEquals(save, false, 'nothing is persisted')
  assertEquals(projects[0]!.spatialFrame, FRAME_B)
  assertEquals(projects[0]!.spatialFrameRevision, 2)
  assertEquals(projects[0]!.updatedAt, 77)
})

Deno.test('a write that names a revision the Place has not reached is a 409 too', () => {
  const projects = registry({ spatialFrame: FRAME_A, spatialFrameRevision: 1 })
  const { result, save } = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_B, expectedRevision: 5 }, 5000)
  assertEquals(result.status, 409)
  assertEquals(save, false)
  assertEquals(projects[0]!.spatialFrame, FRAME_A)
})

Deno.test('a Place with no frame answers a 409 with a null frame, so the writer can tell it lost the first calibration', () => {
  const projects = registry({ spatialFrameRevision: 2 })
  const { result } = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 5000)
  assertEquals(result.status === 409 && result.body.current, { frame: null, revision: 2 })
})

Deno.test('writing the frame a Place already holds is not a conflict, and does not count: a replay is safe', () => {
  const projects = registry({ spatialFrame: FRAME_A, spatialFrameRevision: 1, updatedAt: 77 })
  // The service worker replays a queued body that named revision 0, after the server applied it once.
  const replay = applySpatialFrameWrite(projects, 'proj-1', { frame: { ...FRAME_A }, expectedRevision: 0 }, 5000)
  assertEquals(replay.result, { status: 200, body: { revision: 1, frame: FRAME_A, unchanged: true } })
  assertEquals(replay.save, false)
  assertEquals(projects[0]!.spatialFrameRevision, 1)
  assertEquals(projects[0]!.updatedAt, 77)
  // Whatever revision it names, even one that was never held.
  assertEquals(applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 9 }, 5000).result.status, 200)
  // A different calibration never counts as a replay, because createdAt is part of the frame.
  const other = applySpatialFrameWrite(projects, 'proj-1', { frame: frame(FRAME_A.createdAt.replace('09:00', '09:01')), expectedRevision: 0 }, 5000)
  assertEquals(other.result.status, 409)
})

Deno.test('a Place saved before revisions existed reads as revision 0, and a frame it holds can be replaced at 0', () => {
  // A legacy record: a frame of a method the app no longer writes, and no revision key at all.
  const legacy = { version: 1, method: 'raycast-reference-triangle', toleranceM: 0.3, createdAt: '2026-07-01T00:00:00.000Z' }
  const projects = registry({ spatialFrame: legacy as unknown as ProjectSpatialFrame })
  const { result, save } = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 5000)
  assertEquals(result, { status: 200, body: { revision: 1, frame: FRAME_A } })
  assertEquals(save, true)
  assertEquals(projects[0]!.spatialFrame, FRAME_A, 'the route is the one way to replace it')
})

Deno.test('a write that is not well formed is a 400 and changes nothing', () => {
  const rejects: Array<[string, unknown, string]> = [
    ['a body that is not an object', 'banana', 'Body must be a JSON object'],
    ['an array', [FRAME_A], 'Body must be a JSON object'],
    ['no expectedRevision', { frame: FRAME_A }, 'expectedRevision must be a whole number, 0 or more'],
    ['a negative revision', { frame: FRAME_A, expectedRevision: -1 }, 'expectedRevision must be a whole number, 0 or more'],
    ['a fractional revision', { frame: FRAME_A, expectedRevision: 0.5 }, 'expectedRevision must be a whole number, 0 or more'],
    ['a revision as text', { frame: FRAME_A, expectedRevision: '0' }, 'expectedRevision must be a whole number, 0 or more'],
    ['no frame', { expectedRevision: 0 }, 'spatialFrame must be an object'],
    ['a frame that is a string', { frame: 'banana', expectedRevision: 0 }, 'spatialFrame must be an object'],
    ['an old-shape frame', { frame: { origin: [0, 0, 0] }, expectedRevision: 0 }, 'spatialFrame.version must be 1'],
    ['an unknown method', { frame: { ...FRAME_A, method: 'three-point' }, expectedRevision: 0 }, 'spatialFrame.method must be two-point-ground or ground-tap-compass'],
    ['a separation that is not finite', { frame: { ...FRAME_A, separationM: Infinity }, expectedRevision: 0 }, 'spatialFrame.separationM must be a finite number'],
    ['a photo of another Place', {
      frame: {
        ...FRAME_A,
        referencePhotos: {
          landmark: { url: '/projects/proj-9/reference-photos/ref-landmark.jpg', localKey: 'k', tapPoint: { x: 0, y: 0 }, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: 'x' },
          headingMarker: { url: null, localKey: 'k', tapPoint: { x: 0, y: 0 }, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: 'x' },
        },
      },
      expectedRevision: 0,
    }, 'spatialFrame.referencePhotos.landmark.url belongs to another Place'],
  ]
  for (const [what, body, error] of rejects) {
    const projects = registry({})
    const { result, save } = applySpatialFrameWrite(projects, 'proj-1', body, 5000)
    assertEquals(result, { status: 400, body: { error } }, what)
    assertEquals(save, false, what)
    assertEquals('spatialFrame' in projects[0]!, false, `${what}: nothing was stored`)
  }
})

Deno.test('a write for a Place that does not exist is a 404, after the body has been judged', () => {
  const projects = registry({})
  assertEquals(applySpatialFrameWrite(projects, 'proj-404', { frame: FRAME_A, expectedRevision: 0 }, 5000), {
    result: { status: 404, body: { error: 'Not found' } },
    save: false,
  })
  assertEquals(applySpatialFrameWrite(projects, 'proj-404', { frame: 'banana', expectedRevision: 0 }, 5000).result.status, 400)
})

Deno.test('the revision and the frame survive the registry file: save, then read', async () => {
  const { dir, file } = await tempRegistry()
  try {
    const projects = registry({}, {})
    applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 5000)
    await saveRegistry(file, projects)
    const reread = await readRegistry(file)
    assertEquals(reread?.[0]?.spatialFrame, FRAME_A)
    assertEquals(reread?.[0]?.spatialFrameRevision, 1)
    assertEquals('spatialFrameRevision' in (reread?.[1] ?? {}), false, 'a Place never calibrated keeps no revision key')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

// ── What survived a second round of mutation: replay identity, a stored null, and the photo tie ──────

Deno.test('two frames that share a createdAt but differ in content are not the same write: a stale writer is refused', () => {
  const projects = registry({ spatialFrame: FRAME_A, spatialFrameRevision: 1, updatedAt: 77 })
  // The same calibration instant, another pair of spots (3 m apart instead of 2): only the content tells it apart.
  const sibling = { ...frame(FRAME_A.createdAt, 3) }
  const { result, save } = applySpatialFrameWrite(projects, 'proj-1', { frame: sibling, expectedRevision: 0 }, 5000)
  assertEquals(result.status, 409)
  assertEquals(result.status === 409 && result.body.current, { frame: FRAME_A, revision: 1 })
  assertEquals(save, false)
  assertEquals(projects[0]!.spatialFrame, FRAME_A, 'the Place keeps the frame it held')
  // And with the revision it holds, the sibling is a real write, not a replay.
  const named = applySpatialFrameWrite(projects, 'proj-1', { frame: sibling, expectedRevision: 1 }, 6000)
  assertEquals(named.result.status === 200 && named.result.body.revision, 2)
  assertEquals(projects[0]!.spatialFrame, sibling)
})

Deno.test('a Place whose stored frame is null holds none: the route takes a first write at 0, and a whole-record body supplies one', () => {
  const stored = (): Project => ({ ...place('proj-1'), spatialFrame: null as unknown as undefined })
  const projects = [stored()]
  const { result, save } = applySpatialFrameWrite(projects, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 5000)
  assertEquals(result, { status: 200, body: { revision: 1, frame: FRAME_A } })
  assertEquals(save, true)

  const behind = [{ ...stored(), spatialFrameRevision: 2 }]
  const lost = applySpatialFrameWrite(behind, 'proj-1', { frame: FRAME_A, expectedRevision: 0 }, 5000)
  assertEquals(lost.result.status === 409 && lost.result.body.current, { frame: null, revision: 2 }, 'a null frame is reported as none')

  const body = { ...CLIENT_PLACE, spatialFrame: FRAME_A }
  assertEquals(adoptedFrameError(body, stored(), 'proj-1'), null)
  const adopted = placeFromBody(body, 'proj-1', 5000, stored())
  assertEquals(adopted.spatialFrame, FRAME_A, 'create-if-absent applies to a stored null')
  assertEquals(adopted.spatialFrameRevision, 1)
})

const FOREIGN_PHOTOS = {
  landmark: { url: '/projects/proj-9/reference-photos/ref-landmark.jpg', localKey: 'proj-9:landmark', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: '2026-11-16T09:00:00.000Z' },
  headingMarker: { url: '/projects/proj-9/reference-photos/ref-headingMarker.jpg', localKey: 'proj-9:headingMarker', tapPoint: { x: 0.5, y: 0.5 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: '2026-11-16T09:00:00.000Z' },
}

Deno.test('a whole-record body whose frame carries another Place\'s photos is refused when the Place would use it, and is never stored', () => {
  const bare = place('proj-1')
  const body = { ...CLIENT_PLACE, spatialFrame: { ...FRAME_A, referencePhotos: FOREIGN_PHOTOS } }
  const error = adoptedFrameError(body, bare, 'proj-1')
  assertEquals(error, 'spatialFrame.referencePhotos.landmark.url belongs to another Place')
  // The refusal is the route's; placeFromBody must not store the frame either, for a caller that skips it.
  const built = placeFromBody(body, 'proj-1', 5000, bare)
  assertEquals('spatialFrame' in built, false, 'the frame was not stored')
  assertEquals('spatialFrameRevision' in built, false, 'and nothing was counted')
  // The same photos on their own Place are a frame like any other.
  assertEquals(adoptedFrameError(body, bare, 'proj-9'), null)
  assertEquals(placeFromBody(body, 'proj-9', 5000, place('proj-9')).spatialFrameRevision, 1)
})
