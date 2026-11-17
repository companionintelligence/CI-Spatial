/**
 * A frame's reference photos on disk (server/project_media.ts, ADR 0011): where a frame-scoped photo lives and which
 * names resolve, how an upload's `meta` is read for the frame roles, how a photo is stored without touching another
 * frame's, and how a Place that takes over another's frame gets photos of its own.
 *
 * The routes that call these, with the real server, are in frame_generations_route.test.ts. The Place's own
 * (legacy) photo helpers keep their tests in reference_photos.test.ts, which this change leaves as it was.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  copyFrameFolder,
  copyFramePhotos,
  FRAME_PHOTO_ROLES,
  framePhotoDirPath,
  framePhotoFileName,
  framePhotoRoleOf,
  framePhotoUrl,
  parseFramePhotoMeta,
  parseReferencePhotoMeta,
  REFERENCE_PHOTO_ROLES,
  roleForFramePhotoFile,
  storeFramePhoto,
} from '../../../server/project_media.ts'
import { framePhotoPath } from '../../../src/world/spatial-frame.ts'
import type { ProjectSpatialFrame } from '../../../src/world/types.ts'

const META = { tapPoint: { x: 0.4, y: 0.6 }, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, capturedAt: '2026-11-16T09:00:00.000Z' }
const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array) => new TextDecoder().decode(data)
const exists = (path: string) => Deno.stat(path).then(() => true, () => false)

Deno.test('a frame\'s photo folder is named by a Place id and a frame id that are both safe in a path, and by nothing else', () => {
  assertEquals(framePhotoDirPath('/media', 'proj-1700000000000', 'gen-a'), '/media/proj-1700000000000/frames/gen-a')
  assertEquals(framePhotoDirPath('/media', 'proj-x', '3f2b8c9e-5d41-4c7a-9b1e-0a6d2f7c8e14')?.endsWith('/frames/3f2b8c9e-5d41-4c7a-9b1e-0a6d2f7c8e14'), true)
  assertEquals(framePhotoDirPath('/media', 'proj-x', 'lq1abc-0123456789abcdef'), '/media/proj-x/frames/lq1abc-0123456789abcdef', 'the fallback shape of an id')
  const unsafe = ['', '..', '.', 'a/b', 'a\\b', 'a.b', 'a b', '../x', 'x'.repeat(65), null, undefined]
  for (const frameId of unsafe) assertEquals(framePhotoDirPath('/media', 'proj-x', frameId), null, String(frameId))
  for (const projectId of ['', '..', 'proj-', 'proj-../x', 'x', null, undefined]) assertEquals(framePhotoDirPath('/media', projectId, 'gen-a'), null, String(projectId))
})

Deno.test('only the names a role is stored under are served: an allowlist, and the URL a frame record carries is the one the file is named by', () => {
  for (const role of FRAME_PHOTO_ROLES) {
    assertEquals(roleForFramePhotoFile(framePhotoFileName(role)), role)
    assertEquals(framePhotoUrl('proj-x', 'gen-a', role), framePhotoPath('proj-x', 'gen-a', role))
    assert(framePhotoUrl('proj-x', 'gen-a', role).endsWith(`/${framePhotoFileName(role)}`), 'the URL ends with the file name')
  }
  assertEquals([...FRAME_PHOTO_ROLES], ['landmark', 'heading', 'check1', 'check2', 'check3'])
  for (const file of ['ref-headingMarker.jpg', 'ref-landmark.png', 'reference-photos.json', '../ref-landmark.jpg', 'ref-check4.jpg', 'REF-LANDMARK.JPG', '', null, undefined]) {
    assertEquals(roleForFramePhotoFile(file), null, String(file))
  }
})

Deno.test('an upload names a frame role; the legacy name of the heading marker is accepted and means heading', () => {
  assertEquals(framePhotoRoleOf('headingMarker'), 'heading')
  assertEquals(framePhotoRoleOf('heading'), 'heading')
  assertEquals(framePhotoRoleOf('check2'), 'check2')
  for (const role of ['', 'check4', 'Landmark', '../landmark', 7, null, undefined]) assertEquals(framePhotoRoleOf(role), null, String(role))

  const parsed = parseFramePhotoMeta(JSON.stringify({ role: 'headingMarker', ...META, label: ' radiator ' }))
  assert('meta' in parsed)
  assertEquals(parsed.meta.role, 'heading')
  assertEquals(parsed.meta.label, 'radiator')
  assertEquals(parsed.meta.tapPoint, META.tapPoint)
  assert('meta' in parseFramePhotoMeta(JSON.stringify({ role: 'check3', ...META })))

  // The same checks as the legacy upload, and the roles it names in the error are this route's.
  assertEquals(parseFramePhotoMeta(JSON.stringify({ role: 'check4', ...META })), { error: 'role must be one of landmark, heading, check1, check2, check3' })
  assertEquals(parseFramePhotoMeta(JSON.stringify({ role: 'landmark', ...META, tapPoint: { x: 2, y: 0.5 } })), { error: 'tapPoint must be { x, y } with both in 0..1' })
  assertEquals(parseFramePhotoMeta(undefined), { error: 'Missing meta field' })
  assertEquals(parseFramePhotoMeta('{'), { error: 'meta is not valid JSON' })
  // And the legacy parser, which shares the body of the checks, still takes its own two roles and not the new ones.
  assert('meta' in parseReferencePhotoMeta(JSON.stringify({ role: 'headingMarker', ...META })))
  assertEquals(parseReferencePhotoMeta(JSON.stringify({ role: 'heading', ...META })), { error: `role must be one of ${REFERENCE_PHOTO_ROLES.join(', ')}` })
})

Deno.test('a photo is stored in its own frame\'s folder, the same role again replaces its own file, and another frame\'s photos are never touched', async () => {
  const root = await Deno.makeTempDir({ prefix: 'frame-photos-' })
  try {
    const a = framePhotoDirPath(root, 'proj-1', 'gen-a')!
    const b = framePhotoDirPath(root, 'proj-1', 'gen-b')!
    const parse = (role: string) => {
      const parsed = parseFramePhotoMeta(JSON.stringify({ role, ...META }))
      assert('meta' in parsed)
      return parsed.meta
    }
    await storeFramePhoto(a, parse('landmark'), bytes('a landmark'))
    await storeFramePhoto(a, parse('heading'), bytes('a heading'))
    await storeFramePhoto(b, parse('landmark'), bytes('b landmark'))
    assertEquals(text(await Deno.readFile(`${a}/ref-landmark.jpg`)), 'a landmark')
    assertEquals(text(await Deno.readFile(`${b}/ref-landmark.jpg`)), 'b landmark', 'the same role in another frame is another file')
    await storeFramePhoto(a, parse('landmark'), bytes('a landmark, again'))
    assertEquals(text(await Deno.readFile(`${a}/ref-landmark.jpg`)), 'a landmark, again')
    assertEquals(text(await Deno.readFile(`${b}/ref-landmark.jpg`)), 'b landmark')
    assertEquals(await exists(`${b}/ref-heading.jpg`), false, 'a frame never shows another\'s photo')
    assertEquals(await exists(`${root}/proj-1/ref-landmark.jpg`), false, 'and nothing reaches the Place\'s own (legacy) folder')
    const index = JSON.parse(await Deno.readTextFile(`${a}/reference-photos.json`)) as Record<string, { file: string; bytes: number; role: string }>
    assertEquals(Object.keys(index).sort(), ['heading', 'landmark'])
    assertEquals([index['landmark']!.file, index['landmark']!.bytes], ['ref-landmark.jpg', bytes('a landmark, again').byteLength])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

// ── A Place that takes over another's frame ──────────────────────────────────────────────────────

function photoRecord(url: string | null, key: string) {
  return { url, localKey: key, ...META }
}

function twoPoint(extra: Record<string, unknown>): ProjectSpatialFrame {
  return {
    version: 1,
    createdAt: '2026-11-16T09:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: 2 },
    separationM: 2,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...extra,
  } as ProjectSpatialFrame
}

Deno.test('copying a frame to another Place copies the photos it has on the server, names the copies, and says null for the ones it does not have', async () => {
  const root = await Deno.makeTempDir({ prefix: 'frame-photos-' })
  try {
    const from = framePhotoDirPath(root, 'proj-a', 'gen-a')!
    await Deno.mkdir(from, { recursive: true })
    await Deno.writeFile(`${from}/ref-landmark.jpg`, bytes('landmark'))
    await Deno.writeFile(`${from}/ref-check1.jpg`, bytes('check one'))
    const frame = twoPoint({
      frameId: 'gen-a',
      referencePhotos: {
        landmark: photoRecord('/projects/proj-a/frames/gen-a/ref-landmark.jpg', 'proj-a:gen-a:landmark'),
        headingMarker: photoRecord('/projects/proj-a/frames/gen-a/ref-heading.jpg', 'proj-a:gen-a:heading'),
      },
      checkPoints: [
        { x: 1, y: 0, z: 1, photo: photoRecord('/projects/proj-a/frames/gen-a/ref-check1.jpg', 'proj-a:gen-a:check1') },
        { x: 1, y: 0, z: 2, photo: photoRecord(null, 'proj-a:gen-a:check2') },
        { x: 2, y: 0, z: 2 },
      ],
    })
    const before = JSON.stringify(frame)
    const copy = await copyFramePhotos(root, 'proj-a', 'proj-b', frame) as ProjectSpatialFrame & {
      referencePhotos: { landmark: { url: string | null }; headingMarker: { url: string | null } }
      checkPoints: Array<{ photo?: { url: string | null } }>
    }
    assertEquals(JSON.stringify(frame), before, 'the frame it was given is not changed')
    assertEquals(copy.referencePhotos.landmark.url, '/projects/proj-b/frames/gen-a/ref-landmark.jpg')
    assertEquals(copy.referencePhotos.headingMarker.url, null, 'it never reached the server, and the record says so')
    assertEquals(copy.checkPoints[0]!.photo!.url, '/projects/proj-b/frames/gen-a/ref-check1.jpg')
    assertEquals(copy.checkPoints[1]!.photo!.url, null)
    assertEquals(copy.checkPoints[2]!.photo, undefined)
    const to = framePhotoDirPath(root, 'proj-b', 'gen-a')!
    assertEquals(text(await Deno.readFile(`${to}/ref-landmark.jpg`)), 'landmark')
    assertEquals(text(await Deno.readFile(`${to}/ref-check1.jpg`)), 'check one')
    assertEquals(text(await Deno.readFile(`${from}/ref-landmark.jpg`)), 'landmark', 'the source keeps its own')
    // The record keeps what is the frame's own: the pose and tap point.
    assertEquals(copy.referencePhotos.landmark, { ...photoRecord('/projects/proj-b/frames/gen-a/ref-landmark.jpg', 'proj-a:gen-a:landmark') })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a frame written before ids has its photos in the Place\'s own folder, and the copy keeps that shape', async () => {
  const root = await Deno.makeTempDir({ prefix: 'frame-photos-' })
  try {
    await Deno.mkdir(`${root}/proj-a`, { recursive: true })
    await Deno.writeFile(`${root}/proj-a/ref-landmark.jpg`, bytes('legacy landmark'))
    const frame = twoPoint({
      referencePhotos: {
        landmark: photoRecord('/projects/proj-a/reference-photos/ref-landmark.jpg', 'proj-a:landmark'),
        headingMarker: photoRecord('/projects/proj-a/reference-photos/ref-headingMarker.jpg', 'proj-a:headingMarker'),
      },
    })
    const copy = await copyFramePhotos(root, 'proj-a', 'proj-b', frame) as ProjectSpatialFrame & { referencePhotos: { landmark: { url: string | null }; headingMarker: { url: string | null } } }
    assertEquals(copy.referencePhotos.landmark.url, '/projects/proj-b/reference-photos/ref-landmark.jpg')
    assertEquals(copy.referencePhotos.headingMarker.url, null)
    assertEquals(text(await Deno.readFile(`${root}/proj-b/ref-landmark.jpg`)), 'legacy landmark')
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('a copy never names a picture it did not make: a different file already there, a photo of another Place, a bad path, and a record that is not one', async () => {
  const root = await Deno.makeTempDir({ prefix: 'frame-photos-' })
  try {
    const from = framePhotoDirPath(root, 'proj-a', 'gen-a')!
    const to = framePhotoDirPath(root, 'proj-b', 'gen-a')!
    await Deno.mkdir(from, { recursive: true })
    await Deno.mkdir(to, { recursive: true })
    await Deno.writeFile(`${from}/ref-landmark.jpg`, bytes('the landmark'))
    await Deno.writeFile(`${to}/ref-landmark.jpg`, bytes('somebody else\'s picture'))
    await Deno.writeFile(`${from}/ref-heading.jpg`, bytes('the heading'))
    await Deno.writeFile(`${to}/ref-heading.jpg`, bytes('the heading'))
    // This Place has a picture for the role the record below names under another Place: copying by the role alone would take it.
    await Deno.writeFile(`${from}/ref-check1.jpg`, bytes('proj-a\'s own first check point'))
    const frame = twoPoint({
      frameId: 'gen-a',
      referencePhotos: {
        landmark: photoRecord('/projects/proj-a/frames/gen-a/ref-landmark.jpg', 'k1'),
        headingMarker: photoRecord('/projects/proj-a/frames/gen-a/ref-heading.jpg', 'k2'),
      },
      checkPoints: [
        { x: 1, y: 0, z: 1, photo: photoRecord('/projects/proj-zzz/frames/gen-a/ref-check1.jpg', 'k3') },
        { x: 1, y: 0, z: 2, photo: photoRecord('/projects/%E0%A4%A/frames/gen-a/ref-check2.jpg', 'k4') },
        { x: 2, y: 0, z: 2, photo: photoRecord('banana', 'k5') },
      ],
    })
    const copy = await copyFramePhotos(root, 'proj-a', 'proj-b', frame) as ProjectSpatialFrame & {
      referencePhotos: { landmark: { url: string | null }; headingMarker: { url: string | null } }
      checkPoints: Array<{ photo: { url: string | null } }>
    }
    assertEquals(copy.referencePhotos.landmark.url, null, 'another picture is at that path: it is not this frame\'s')
    assertEquals(text(await Deno.readFile(`${to}/ref-landmark.jpg`)), 'somebody else\'s picture', 'and it is not written over')
    assertEquals(copy.referencePhotos.headingMarker.url, '/projects/proj-b/frames/gen-a/ref-heading.jpg', 'the same bytes already there are the copy of an earlier try')
    assertEquals(copy.checkPoints.map((point) => point.photo.url), [null, null, null])
    assertEquals(await exists(`${to}/ref-check1.jpg`), false, 'a record that names another Place\'s picture gets nothing of this Place\'s')

    // A frame an older build stored with less than the type says, and one of the other method, are copied without a throw.
    const odd = twoPoint({ referencePhotos: { landmark: 'x', headingMarker: null }, checkPoints: 'many' })
    await copyFramePhotos(root, 'proj-a', 'proj-b', odd)
    const onePoint = { version: 1, createdAt: '2026-11-16T09:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 12 } as ProjectSpatialFrame
    assertEquals(await copyFramePhotos(root, 'proj-a', 'proj-b', onePoint), onePoint)
    // A Place id that is not one has no folder to copy into.
    const refused = await copyFramePhotos(root, 'proj-a', '../elsewhere', frame) as ProjectSpatialFrame & { referencePhotos: { headingMarker: { url: string | null } } }
    assertEquals(refused.referencePhotos.headingMarker.url, null)
    assertEquals(await exists(`${root}/../elsewhere`), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('copying a frame\'s folder copies the photos a frame can have, under their own names, and nothing else; what is there is kept; the source is not touched', async () => {
  const root = await Deno.makeTempDir({ prefix: 'frame-photos-' })
  try {
    const from = framePhotoDirPath(root, 'proj-a', 'gen-a')!
    const to = framePhotoDirPath(root, 'proj-b', 'gen-a')!
    await Deno.mkdir(from, { recursive: true })
    await Deno.writeFile(`${from}/ref-landmark.jpg`, bytes('landmark'))
    await Deno.writeFile(`${from}/ref-check2.jpg`, bytes('check two'))
    await Deno.writeFile(`${from}/reference-photos.json`, bytes('{}'))
    await Deno.writeFile(`${from}/ref-headingMarker.jpg`, bytes('not a name this folder uses'))
    await Deno.writeFile(`${from}/notes.txt`, bytes('not a photo'))

    assertEquals(await copyFrameFolder(root, 'proj-a', 'proj-b', 'gen-a'), 2)
    assertEquals(text(await Deno.readFile(`${to}/ref-landmark.jpg`)), 'landmark')
    assertEquals(text(await Deno.readFile(`${to}/ref-check2.jpg`)), 'check two')
    for (const other of ['reference-photos.json', 'ref-headingMarker.jpg', 'notes.txt']) assertEquals(await exists(`${to}/${other}`), false, other)
    assertEquals(text(await Deno.readFile(`${from}/ref-landmark.jpg`)), 'landmark', 'the source keeps its own')

    // Again: nothing more to copy. A different picture already at the other end is that Place\'s own, and stays.
    await Deno.writeFile(`${from}/ref-check3.jpg`, bytes('check three'))
    await Deno.writeFile(`${to}/ref-landmark.jpg`, bytes('b\'s own landmark'))
    assertEquals(await copyFrameFolder(root, 'proj-a', 'proj-b', 'gen-a'), 1)
    assertEquals(text(await Deno.readFile(`${to}/ref-landmark.jpg`)), 'b\'s own landmark')
    assertEquals(text(await Deno.readFile(`${to}/ref-check3.jpg`)), 'check three')

    // No folder is made for a frame that has no photos here, a frame id or Place id that is not safe has no folder, and a Place does not copy to itself.
    assertEquals(await copyFrameFolder(root, 'proj-a', 'proj-b', 'gen-none'), 0)
    assertEquals(await exists(framePhotoDirPath(root, 'proj-b', 'gen-none')!), false)
    assertEquals(await copyFrameFolder(root, 'proj-a', 'proj-b', '../gen-a'), 0)
    assertEquals(await copyFrameFolder(root, 'proj-a', '../elsewhere', 'gen-a'), 0)
    assertEquals(await copyFrameFolder(root, 'proj-a', 'proj-a', 'gen-a'), 0)
    assertEquals(await exists(`${root}/../elsewhere`), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
