/**
 * The registry save order and the Place a PUT stores (server/wp-a-projects.ts).
 *
 * A save writes its temp file first, so a failed write leaves the registry, and a corrupt one, as they
 * were. The original is replaced only by the final rename. A corrupt file survives a successful save as
 * a `.corrupt-<time>` copy, and is never kept as the `.bak`. A PUT stores only the fields the Project
 * type declares, and keeps the Place's frame (see "A Place's frame" in server/wp-a-projects.ts).
 *
 * The test that pinned `spatialFrame: { origin: [0, 0, 0] }` as stored verbatim changed on purpose. That
 * value is not a frame any writer produces, and the server used to keep whatever it was handed (the same
 * hole stored `spatialFrame: 'banana'`). A body's frame is now stored only when it passes
 * `validateSpatialFrame` and the Place has none, so the test stores a real frame and a second test pins
 * that the old value is refused.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { adoptedFrameError, placeFromBody, readRegistry, saveRegistry } from '../../../server/wp-a-projects.ts'
import type { Project, ProjectSpatialFrame } from '../../../src/world/types.ts'

async function tempRegistry(): Promise<{ dir: string; file: string }> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-s-projects-' })
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

/** A Place as the registry holds it, created at `createdAt`. */
function stored(createdAt = 111, extra: Partial<Project> = {}): Project {
  return { ...place('proj-1'), createdAt, ...extra }
}

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

/** The names of the entries in `dir`, sorted. */
async function namesIn(dir: string): Promise<string[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) names.push(entry.name)
  return names.sort()
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/**
 * A registry name long enough that the temp file's name (the registry name, a UUID and `.tmp`) is past
 * the 255-byte limit on one file name. The registry and its `.bak` still fit. Creating the temp file
 * then fails with "File name too long", for root too, so the write itself is what fails.
 */
const LONG_NAME = `${'p'.repeat(230)}.json`

Deno.test('a save whose temp file cannot be written leaves the registry and its .bak as they were', async () => {
  const { dir } = await tempRegistry()
  const file = `${dir}/${LONG_NAME}`
  try {
    // A save under this name could not write its temp file, so the registry and its .bak are written directly.
    await Deno.writeTextFile(file, JSON.stringify([place('proj-1')]))
    await Deno.writeTextFile(`${file}.bak`, JSON.stringify([place('proj-0')]))
    const before = await Deno.readTextFile(file)
    const bakBefore = await Deno.readTextFile(`${file}.bak`)
    const err = await saveRegistry(file, [place('proj-2')]).then(() => null, (e: unknown) => e)
    assert(err instanceof Error && /too long/i.test(err.message), 'the save fails while writing its temp file')
    assertEquals(await Deno.readTextFile(file), before, 'the registry is unchanged')
    assertEquals(await Deno.readTextFile(`${file}.bak`), bakBefore, 'the .bak is unchanged')
    assertEquals(await namesIn(dir), [LONG_NAME, `${LONG_NAME}.bak`].sort(), 'no temp file is left behind')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a save that fails after its temp file is written removes that file and leaves the registry as it was', async () => {
  const { dir, file } = await tempRegistry()
  try {
    await saveRegistry(file, [place('proj-1')])
    // A directory where the .bak copy goes makes that copy fail after the temp file is written and before the rename.
    await Deno.mkdir(`${file}.bak`)
    const before = await Deno.readTextFile(file)
    // The failure is the .bak copy: it is an IsADirectory error, and its message names the .bak path.
    await assertRejects(
      () => saveRegistry(file, [place('proj-2')]),
      Deno.errors.IsADirectory,
      file + '.bak',
    )
    assertEquals(await Deno.readTextFile(file), before, 'the registry is unchanged')
    assertEquals(await namesIn(dir), ['projects.json', 'projects.json.bak'], 'the temp file is removed')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a corrupt registry survives a successful save as a .corrupt copy, and is never kept as the .bak', async () => {
  const { dir, file } = await tempRegistry()
  try {
    await Deno.writeTextFile(file, 'garbage{ not json')
    assertEquals(await saveRegistry(file, [place('proj-1')], 777), `${file}.corrupt-777`, 'the save reports the copy')
    assertEquals(await Deno.readTextFile(`${file}.corrupt-777`), 'garbage{ not json', 'the bytes survive')
    assertEquals((await readRegistry(file))?.map(p => p.projectId), ['proj-1'], 'the new registry is in place')
    assertEquals(await exists(`${file}.bak`), false, 'no .bak is made from the corrupt bytes')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a corrupt registry is not replaced when its copy cannot be made, and the next save keeps it', async () => {
  const { dir, file } = await tempRegistry()
  try {
    await Deno.writeTextFile(file, 'garbage{ not json')
    // A directory where the copy goes makes the copy fail after the temp file is written and before the rename.
    await Deno.mkdir(`${file}.corrupt-1`)
    // The failure is the corrupt copy-aside: it is an IsADirectory error, and its message names the .corrupt-1 path.
    await assertRejects(
      () => saveRegistry(file, [place('proj-1')], 1),
      Deno.errors.IsADirectory,
      file + '.corrupt-1',
    )
    assertEquals(await Deno.readTextFile(file), 'garbage{ not json', 'the registry is unchanged')
    assertEquals(await saveRegistry(file, [place('proj-2')], 2), `${file}.corrupt-2`)
    assertEquals(await Deno.readTextFile(`${file}.corrupt-2`), 'garbage{ not json')
    assertEquals((await readRegistry(file))?.map(p => p.projectId), ['proj-2'])
    assertEquals(
      await namesIn(dir),
      ['projects.json', 'projects.json.corrupt-1', 'projects.json.corrupt-2'],
      'the failed save left no temp file or .bak',
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a PUT stores only the fields Project declares, with the id from the URL', () => {
  const body = {
    projectId: 'proj-from-body',
    name: 'Renamed',
    placeType: 'building',
    parentProjectId: null,
    buildingName: 'Block A',
    address: '1 Main St',
    notes: 'keys with the office',
    geoPose: { lat: 51.5, lng: -0.1 },
    spatialFrame: FRAME_A,
    areas: [{ areaId: 'area-1', name: 'Site', kind: 'site', parentAreaId: null }],
    floors: [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [] }],
    updatedAt: 5,
    isAdmin: true,
    scans: ['never-a-field-of-a-place.glb'],
  }
  const stored = placeFromBody(body, 'proj-1', 1000, place('proj-1'))
  assertEquals(stored.projectId, 'proj-1', 'the URL names the Place')
  assertEquals(stored.name, 'Renamed')
  assertEquals(stored.placeType, 'building')
  assertEquals(stored.parentProjectId, null)
  assertEquals(stored.buildingName, 'Block A')
  assertEquals(stored.address, '1 Main St')
  assertEquals(stored.notes, 'keys with the office')
  assertEquals(stored.geoPose as unknown, body.geoPose)
  assertEquals(stored.spatialFrame, FRAME_A, 'a Place with no frame takes the body\'s, once it is a frame')
  assertEquals(stored.spatialFrameRevision, 1, 'and counts it')
  assertEquals(stored.areas, [{ areaId: 'area-1', name: 'Site', kind: 'site', parentAreaId: null }])
  assertEquals(stored.floors, [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [] }])
  assertEquals(stored.updatedAt, 1000, 'the save time, not the body value')
  assertEquals('isAdmin' in stored, false, 'an undeclared field is dropped')
  assertEquals('scans' in stored, false, 'a field another record owns is dropped')
})

Deno.test('a PUT keeps the stored createdAt unless the body sends one', () => {
  const minimal = { name: 'Only a name', floors: [] }
  assertEquals(placeFromBody(minimal, 'proj-1', 1000, stored(111)).createdAt, 111)
  assertEquals(placeFromBody({ ...minimal, createdAt: 42 }, 'proj-1', 1000, stored(111)).createdAt, 42)
})

Deno.test('a PUT writes no key for an optional field the body leaves out', () => {
  const result = placeFromBody({ name: 'Only a name', floors: [] }, 'proj-1', 1000, stored())
  assertEquals(Object.keys(result).sort(), ['createdAt', 'floors', 'name', 'projectId', 'updatedAt'])
})

// ── The frame (the change this file's header describes) ───────────────────────────────────────────

Deno.test('the value this file used to pin as a stored frame is not stored, and is named when a Place could have used it', () => {
  const body = { name: 'Only a name', floors: [], spatialFrame: { origin: [0, 0, 0] } }
  assertEquals(placeFromBody(body, 'proj-1', 1000, stored()).spatialFrame, undefined, 'the registry never holds it')
  assertEquals(adoptedFrameError(body, stored(), 'proj-1'), 'spatialFrame.version must be 1', 'and the route says why it refused')
  // 'banana' got in the same way before: the body's shape is refused earlier still (placeBodyError).
  assertEquals(placeFromBody({ ...body, spatialFrame: 'banana' }, 'proj-1', 1000, stored()).spatialFrame, undefined)
})

Deno.test('a PUT keeps the frame and revision the Place holds, whatever the body carries', () => {
  const held = stored(111, { spatialFrame: FRAME_A, spatialFrameRevision: 4 })
  const bodies: Array<[string, Record<string, unknown>]> = [
    ['no frame', { name: 'Renamed', floors: [] }],
    ['a null frame', { name: 'Renamed', floors: [], spatialFrame: null }],
    ['another valid frame', { name: 'Renamed', floors: [], spatialFrame: FRAME_B }],
    ['an older frame from a stale tab', { name: 'Renamed', floors: [], spatialFrame: frame('2025-01-01T00:00:00.000Z') }],
    ['a frame that is not valid', { name: 'Renamed', floors: [], spatialFrame: { origin: [0, 0, 0] } }],
    ['a revision of its own', { name: 'Renamed', floors: [], spatialFrameRevision: 99 }],
    ['a revision of zero and no frame', { name: 'Renamed', floors: [], spatialFrameRevision: 0 }],
  ]
  for (const [what, body] of bodies) {
    const result = placeFromBody(body, 'proj-1', 1000, held)
    assertEquals(result.name, 'Renamed', `${what}: the rest of the record is still replaced`)
    assertEquals(result.spatialFrame, FRAME_A, `${what}: the frame is kept`)
    assertEquals(result.spatialFrameRevision, 4, `${what}: and so is its revision`)
    assertEquals(adoptedFrameError(body, held, 'proj-1'), null, `${what}: a frame the Place does not need is never a reason to refuse the save`)
  }
})

Deno.test('a Place with no frame takes a valid one from a whole-record body, once, and counts it', () => {
  const first = placeFromBody({ name: 'Home', floors: [], spatialFrame: FRAME_A }, 'proj-1', 1000, stored())
  assertEquals(first.spatialFrame, FRAME_A)
  assertEquals(first.spatialFrameRevision, 1, 'from a Place that read as revision 0')
  // The same body again, now against the Place it made: the frame is held, so it is carried and not counted twice.
  const again = placeFromBody({ name: 'Home', floors: [], spatialFrame: FRAME_B }, 'proj-1', 2000, first)
  assertEquals(again.spatialFrame, FRAME_A)
  assertEquals(again.spatialFrameRevision, 1)
  // The revision is a count of accepted writes, so it carries on from where the Place was, not from 0.
  const counted = placeFromBody({ name: 'Home', floors: [], spatialFrame: FRAME_B }, 'proj-1', 1000, stored(111, { spatialFrameRevision: 3 }))
  assertEquals(counted.spatialFrameRevision, 4)
})

Deno.test('a Place without a frame stays without one, and without a revision key, when the body brings none', () => {
  const result = placeFromBody({ name: 'Home', floors: [], spatialFrameRevision: 7 }, 'proj-1', 1000, stored())
  assertEquals('spatialFrame' in result, false)
  assertEquals('spatialFrameRevision' in result, false, 'the body\'s revision is not read')
})

Deno.test('a body\'s frame is refused only when the Place would have used it', () => {
  const garbage = { name: 'Home', floors: [], spatialFrame: { ...FRAME_A, separationM: 0.2, headingMarker: { x: 0, y: 0, z: 0.2 } } }
  assert(adoptedFrameError(garbage, stored(), 'proj-1')?.includes('at least 1 m'), 'a Place with no frame refuses a frame it could not keep')
  assertEquals(adoptedFrameError(garbage, stored(111, { spatialFrame: FRAME_A }), 'proj-1'), null, 'a Place with a frame ignores it')
  assertEquals(adoptedFrameError({ name: 'Home', floors: [] }, stored(), 'proj-1'), null, 'no frame in the body, nothing to refuse')
  assertEquals(
    adoptedFrameError({ name: 'Home', floors: [], spatialFrame: FRAME_A }, stored(), 'proj-2'),
    null,
    'a frame with no photos has no URL to belong to another Place',
  )
})
