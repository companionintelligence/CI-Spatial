/**
 * The file operations of a Place's photo storage (ADR 0011): storing a frame's photo, copying the photos a frame keeps from
 * one Place's folder to another's. The layout, the roles, the paths and the validation are `./project_media_meta.ts`
 * (pure, and re-exported here so this module is still the one place the server imports them from).
 */
import {
  FRAME_PHOTO_ROLES,
  type FramePhotoMeta,
  framePhotoDirPath,
  framePhotoFileName,
  projectMediaDirPath,
} from './project_media_meta.ts'
import type { CalibrationReferencePhoto, ProjectSpatialFrame } from '../src/world/types.ts'

export * from './project_media_meta.ts'

/** `<dir>/reference-photos.json`: the record of what was uploaded into a photo folder, beside the photos. */
async function readPhotoIndex(dir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/reference-photos.json`)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Stores one photo of a frame, in that frame's folder. The same role uploaded again (a retry whose reply was
 * lost) replaces its own file, and nothing outside the folder: another frame's photo is never touched. The
 * folder keeps the index of what it was sent, as the Place's folder does.
 */
export async function storeFramePhoto(dir: string, meta: FramePhotoMeta, bytes: Uint8Array): Promise<void> {
  await Deno.mkdir(dir, { recursive: true })
  const name = framePhotoFileName(meta.role)
  await Deno.writeFile(`${dir}/${name}`, bytes)
  await Deno.writeTextFile(
    `${dir}/reference-photos.json`,
    JSON.stringify({ ...(await readPhotoIndex(dir)), [meta.role]: { ...meta, file: name, bytes: bytes.byteLength, receivedAt: Date.now() } }, null, 2),
  )
}

/**
 * The photo records of a frame, each with the slot it sits in, in the order a frame holds them: the landmark's
 * and the heading marker's, then each check point's. A record is changed in place by whoever holds the frame.
 */
function photoRecordsOf(frame: ProjectSpatialFrame): CalibrationReferencePhoto[] {
  if (frame.method !== 'two-point-ground') return []
  const candidates: unknown[] = []
  if (frame.referencePhotos) candidates.push(frame.referencePhotos.landmark, frame.referencePhotos.headingMarker)
  for (const point of Array.isArray(frame.checkPoints) ? frame.checkPoints : []) candidates.push(point?.photo)
  // A frame an older build stored may hold less than the type says: only a record with a path, or with null, is one.
  return candidates.filter((candidate): candidate is CalibrationReferencePhoto =>
    typeof candidate === 'object' && candidate !== null
    && (typeof (candidate as { url?: unknown }).url === 'string' || (candidate as { url?: unknown }).url === null))
}

/** `decodeURIComponent`, or null for text that is not a valid encoding. */
function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/** Whether two files hold the same bytes. Throws NotFound when either is missing. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([Deno.readFile(a), Deno.readFile(b)])
  return first.length === second.length && first.every((byte, i) => byte === second[i])
}

const SCOPED_PHOTO_URL = /^\/projects\/([^/]+)\/frames\/([A-Za-z0-9_-]{1,64})\/(ref-[A-Za-z0-9]+\.jpg)$/
const LEGACY_PHOTO_URL = /^\/projects\/([^/]+)\/reference-photos\/(ref-[A-Za-z0-9]+\.jpg)$/

/**
 * A copy of `frame` that belongs to the Place `toProjectId`, for a Place that takes over the frame of another
 * (a merge, or a scan moved into a Place that has none): each photo the frame has on the server is copied into the
 * Place's own folder, in the same shape of path, and the record names the copy. A photo that is not on the server
 * (its upload never landed), that names another Place than `fromProjectId`, or whose copy fails, is left with a
 * null `url`: the record is still the frame's own (the pose, the tap point, the device's copy), and it says it
 * has no picture on the server instead of naming one that is not there. A file already at the copy's path is
 * kept, never written over. `frame` is not changed.
 */
export async function copyFramePhotos(
  root: string,
  fromProjectId: string,
  toProjectId: string,
  frame: ProjectSpatialFrame,
): Promise<ProjectSpatialFrame> {
  const copy = structuredClone(frame)
  const fromDir = projectMediaDirPath(root, fromProjectId)
  const toDir = projectMediaDirPath(root, toProjectId)
  for (const record of photoRecordsOf(copy)) {
    const url = record.url
    if (url === null) continue
    record.url = null
    const scoped = SCOPED_PHOTO_URL.exec(url)
    const legacy = scoped ? null : LEGACY_PHOTO_URL.exec(url)
    const owner = scoped?.[1] ?? legacy?.[1]
    if (!fromDir || !toDir || owner === undefined || safeDecode(owner) !== fromProjectId) continue
    const frameId = scoped?.[2]
    const file = (scoped?.[3] ?? legacy?.[2])!
    const folder = frameId ? `frames/${frameId}/` : ''
    try {
      await Deno.mkdir(`${toDir}/${folder}`, { recursive: true })
      const source = `${fromDir}/${folder}${file}`
      const target = `${toDir}/${folder}${file}`
      try {
        // A file that is already there is the copy of an earlier try, or it is another picture: only the same
        // bytes may be named by this record.
        if (!(await sameBytes(source, target))) continue
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error
        await Deno.copyFile(source, target)
      }
      record.url = frameId
        ? `/projects/${encodeURIComponent(toProjectId)}/frames/${frameId}/${file}`
        : `/projects/${encodeURIComponent(toProjectId)}/reference-photos/${file}`
    } catch {
      record.url = null
    }
  }
  return copy
}

/**
 * Copies the photos a Place's folder holds for one of its frames into another Place's folder, for a Place that has
 * taken in scans of that frame and describes it in its history (a merge, a scan moved in with the flag), so the Place
 * the scans are in now can serve the photos of the frame they were measured against. Only the photos a frame can
 * have (`FRAME_PHOTO_ROLES`) are copied, each under its own name; a photo that is not there is not made up, and one
 * already at the other end is kept, never written over by another picture. Answers how many files were copied.
 * Nothing in the source folder is changed or removed.
 */
export async function copyFrameFolder(
  root: string,
  fromProjectId: string,
  toProjectId: string,
  frameId: string,
): Promise<number> {
  const from = framePhotoDirPath(root, fromProjectId, frameId)
  const to = framePhotoDirPath(root, toProjectId, frameId)
  if (from === null || to === null || from === to) return 0
  const exists = (path: string) => Deno.stat(path).then(() => true, () => false)
  let copied = 0
  for (const role of FRAME_PHOTO_ROLES) {
    const name = framePhotoFileName(role)
    // A photo that is not there is not copied, and one already at the other end is that Place's own: it stays.
    if (!(await exists(`${from}/${name}`)) || (await exists(`${to}/${name}`))) continue
    try {
      await Deno.mkdir(to, { recursive: true })
      await Deno.copyFile(`${from}/${name}`, `${to}/${name}`)
      copied += 1
    } catch { /* this one could not be copied: the others still are */ }
  }
  return copied
}
