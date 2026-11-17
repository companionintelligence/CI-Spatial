/**
 * What deleting a Place has to look at besides its registry entry (server/place_deletion.ts), against real temporary
 * directories: the scans made from an upload that hold a Place, its reference photos, and its world with the export built
 * from it.
 *
 * What these hold: an upload scan with no GLB is counted as the Place's; the photos are removed as a folder and never
 * through a link or an id that is not a Place id; every world that says it is the Place's goes, with its export, and no
 * other (another Place's, the default world, a file that is not a world); the export goes before the world, so a failure
 * leaves a world that still names the Place; a removal waits for the world's lock; and a world that is not there is not an error.
 *
 * tests/unit/deno/keyframe_routes.test.ts runs the same functions through DELETE /projects/:id.
 */
import { assert, assertEquals, assertFalse, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { removePlaceMedia, removePlaceWorlds, uploadScansOfPlace } from '../../../server/place_deletion.ts'
import { withWorldLock } from '../../../server/world/world_lock.ts'

const SESSION_A = 'sess-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'sess-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function withDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: 'place-deletion-' })
  try {
    await run(root)
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

async function names(dir: string): Promise<string[]> {
  const found: string[] = []
  for await (const entry of Deno.readDir(dir)) found.push(entry.name)
  return found.sort()
}

async function writeWorld(worlds: string, slug: string, projectId: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  await Deno.writeTextFile(`${worlds}/${slug}.json`, JSON.stringify({ worldId: `world-${slug}`, shareSlug: slug, projectId, ...extra }))
}

// ── The scans made from an upload ───────────────────────────────────────────────

Deno.test('a scan made from an upload, with no GLB yet, is counted as its Place\'s, and one with a GLB is not counted here', async () => {
  await withDir(async (scans) => {
    await Deno.writeTextFile(`${scans}/${SESSION_A}.json`, JSON.stringify({ sessionId: SESSION_A, projectId: 'proj-1' }))
    await Deno.writeTextFile(`${scans}/${SESSION_B}.json`, JSON.stringify({ sessionId: SESSION_B, projectId: 'proj-2' }))
    // A scan that has its GLB is one of the Place's GLB scans, counted by the caller.
    await Deno.writeTextFile(`${scans}/sess-cccccccc-cccc-4ccc-8ccc-cccccccccccc.json`, JSON.stringify({ projectId: 'proj-1' }))
    await Deno.writeFile(`${scans}/sess-cccccccc-cccc-4ccc-8ccc-cccccccccccc.glb`, new Uint8Array(8))
    // Not a session id, not JSON, and not an object: none of them names a Place.
    await Deno.writeTextFile(`${scans}/100_room.json`, JSON.stringify({ projectId: 'proj-1' }))
    await Deno.writeTextFile(`${scans}/sess-dddddddd-dddd-4ddd-8ddd-dddddddddddd.json`, 'not json')
    await Deno.writeTextFile(`${scans}/sess-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.json`, '[1,2]')
    assertEquals(await uploadScansOfPlace(scans, 'proj-1'), [`${SESSION_A}.glb`])
    assertEquals(await uploadScansOfPlace(scans, 'proj-2'), [`${SESSION_B}.glb`])
    assertEquals(await uploadScansOfPlace(scans, 'proj-3'), [])
  })
})

// ── Reference photos ────────────────────────────────────────────────────────────

Deno.test('a Place\'s reference photos are removed as a folder, and an id that is not a Place id removes nothing', async () => {
  await withDir(async (root) => {
    const media = `${root}/projects`
    await Deno.mkdir(`${media}/proj-1`, { recursive: true })
    await Deno.writeTextFile(`${media}/proj-1/ref-landmark.jpg`, 'photo')
    await Deno.mkdir(`${media}/proj-2`, { recursive: true })
    await Deno.mkdir(`${root}/victim`, { recursive: true })
    await Deno.writeTextFile(`${root}/victim/keep.txt`, 'keep')
    for (const id of ['../victim', '..', '.', 'proj-../victim', 'other', '', 'proj-']) {
      assertEquals(await removePlaceMedia(media, id), false, `${JSON.stringify(id)} is not a Place`)
    }
    assert(await exists(`${root}/victim/keep.txt`))
    assertEquals(await removePlaceMedia(media, 'proj-1'), true)
    assertFalse(await exists(`${media}/proj-1`))
    assert(await exists(`${media}/proj-2`), 'another Place\'s photos are not touched')
    assertEquals(await removePlaceMedia(media, 'proj-1'), false, 'a Place with no photos is not an error')
  })
})

Deno.test('a Place\'s media folder that is a link is left, and what it points at is not removed', async () => {
  await withDir(async (root) => {
    const media = `${root}/projects`
    await Deno.mkdir(media, { recursive: true })
    await Deno.mkdir(`${root}/outside`, { recursive: true })
    await Deno.writeTextFile(`${root}/outside/precious.txt`, 'precious')
    await Deno.symlink(`${root}/outside`, `${media}/proj-1`)
    assertEquals(await removePlaceMedia(media, 'proj-1'), false)
    assert(await exists(`${root}/outside/precious.txt`))
    assert((await Deno.lstat(`${media}/proj-1`)).isSymlink)
  })
})

// ── The Place's world ───────────────────────────────────────────────────────────

Deno.test('every world that says it is the Place\'s goes with its export, and no other', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1', { name: 'My Home', originGeoPose: { lat: 51.5014, lng: -0.1419, address: '12 Secret Lane' } })
    await Deno.writeTextFile(`${worlds}/project-proj-1.world.glb`, 'a copy of every scan')
    // A merge re-labelled the merged-away Place's world as the target's: it is the target's now, with its own export.
    await writeWorld(worlds, 'project-proj-9', 'proj-1')
    await Deno.writeTextFile(`${worlds}/project-proj-9.world.glb`, 'its export')
    await writeWorld(worlds, 'project-proj-2', 'proj-2')
    await Deno.writeTextFile(`${worlds}/project-proj-2.world.glb`, 'another Place\'s export')
    await writeWorld(worlds, 'default', null)
    await Deno.writeTextFile(`${worlds}/default.world.glb`, 'the default export')
    await Deno.writeTextFile(`${worlds}/project-proj-1.json.1234.tmp`, 'a write in progress')
    await Deno.writeTextFile(`${worlds}/broken.json`, 'not json')
    await Deno.writeTextFile(`${worlds}/list.json`, '[]')
    await Deno.writeTextFile(`${worlds}/notes.txt`, 'notes')

    assertEquals(await removePlaceWorlds(worlds, 'proj-1'), 2)
    assertEquals(await names(worlds), [
      'broken.json',
      'default.json',
      'default.world.glb',
      'list.json',
      'notes.txt',
      'project-proj-1.json.1234.tmp',
      'project-proj-2.json',
      'project-proj-2.world.glb',
    ], 'the Place\'s two worlds and their exports are gone; another Place\'s, the default world and what is not a world are not')
    assertEquals(await removePlaceWorlds(worlds, 'proj-1'), 0, 'a second call finds nothing')
  })
})

Deno.test('a Place with no world, and a worlds folder that is not there, are not errors', async () => {
  await withDir(async (root) => {
    await Deno.mkdir(`${root}/worlds`)
    assertEquals(await removePlaceWorlds(`${root}/worlds`, 'proj-1'), 0)
    assertEquals(await removePlaceWorlds(`${root}/no-such-folder`, 'proj-1'), 0)
  })
})

Deno.test('the export goes before the world, so a failure leaves a world that still names the Place, and a second try finishes', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1')
    // An export that is a folder with something in it cannot be removed as a file.
    await Deno.mkdir(`${worlds}/project-proj-1.world.glb`)
    await Deno.writeTextFile(`${worlds}/project-proj-1.world.glb/inside`, 'x')
    await assertRejects(() => removePlaceWorlds(worlds, 'proj-1'))
    assert(await exists(`${worlds}/project-proj-1.json`), 'the world is still here, so the Place can be found and deleted again')

    await Deno.remove(`${worlds}/project-proj-1.world.glb`, { recursive: true })
    assertEquals(await removePlaceWorlds(worlds, 'proj-1'), 1)
    assertFalse(await exists(`${worlds}/project-proj-1.json`))
  })
})

Deno.test('a world is removed inside its lock, so a write to it cannot land after it has gone', async () => {
  await withDir(async (worlds) => {
    await writeWorld(worlds, 'project-proj-1', 'proj-1')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding!: () => void
    const entered = new Promise<void>((resolve) => {
      holding = resolve
    })
    // A world write in progress: the lock is held until the test lets go.
    const writing = withWorldLock('project-proj-1', async () => {
      holding()
      await held
    })
    await entered
    let removed = false
    const removing = removePlaceWorlds(worlds, 'proj-1').then((count) => {
      removed = true
      return count
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assertFalse(removed, 'the removal waits for the write in progress')
    assert(await exists(`${worlds}/project-proj-1.json`))
    release()
    await writing
    assertEquals(await removing, 1)
    assertFalse(await exists(`${worlds}/project-proj-1.json`))
  })
})
