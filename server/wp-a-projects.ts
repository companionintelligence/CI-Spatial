/**
 * The Places registry file (projects.json): how it is read and saved, and the
 * shape a Place body must have before it is stored.
 *
 * The file is the only copy of every Place, floor, room and area, so:
 *   - a missing file is an empty registry; any other read failure throws, and is
 *     never taken for "no Places yet" (the next save would overwrite the file);
 *   - an unparsable file throws on read, and the first save keeps a copy of its
 *     bytes as `<file>.corrupt-<timestamp>` before it replaces the file, so the
 *     bytes survive even when a later step fails;
 *   - each save keeps the previous version as `<file>.bak`. A corrupt file is not
 *     a version, so it never becomes the `.bak`.
 *
 * ## A Place's frame
 *
 * The frame (`spatialFrame`) is the Place's one durable reference, so it is not a field of the
 * whole-record PUT any more. Every client that edits a Place (the scanner's "Add an area", the
 * editor's hierarchy save, the Places panel, and a service-worker replay of a body queued
 * while offline) PUTs the whole record it last read, and a copy read before another device
 * calibrated has no frame. Rebuilding the stored Place from that body erased the frame.
 *
 * What a whole-record `PUT /projects/:id` does with the frame now, which is also what a client
 * built before this change gets:
 *   - the Place has a frame: it is kept, with its revision, whatever the body carries. A body that
 *     carries another frame, an older one, or none, does not change it. (A `spatialFrame` that is not
 *     an object at all is refused with 400, like any other malformed field.);
 *   - the Place has no frame and the body carries a frame that passes `validateSpatialFrame`: it is
 *     stored (create-if-absent), and the revision goes from 0 to 1. This is how a client built
 *     before the revision route existed still saves a first calibration;
 *   - the Place has no frame and the body carries a frame that does not pass: 400, and nothing in
 *     the body is stored;
 *   - the body's `spatialFrameRevision` is never read: the server owns it.
 * The other fields only the server writes are treated the same way: a stored `frameHistory`, `georeference`
 * and `georefVersion` are carried over, and whatever the body says about them is ignored.
 * The reply is the Place as stored, so a client can see that its frame was not the one kept. A
 * client built before this change does not look, and an override ("Use anyway") from such a client
 * no longer replaces a stored frame. That is deliberate: the one way to replace a frame is
 * `PUT /projects/:id/spatial-frame` with the revision the writer last saw (`applySpatialFrameWrite`).
 */
import type { Floor, GeoPose, PlaceArea, PlaceType, Project, ProjectSpatialFrame } from '../src/world/types.ts'
import {
  isFrameRevision,
  placeFrameRevision,
  sameSpatialFrame,
  validateSpatialFrame,
} from '../src/world/spatial-frame.ts'
import {
  appendFrameHistory,
  type FrameReplaces,
  type FrameWriteRefusalCode,
  parseFrameReplaces,
} from '../src/world/frame-generations.ts'
import { decideReplacement } from './place_frames.ts'

export function isPlaceType(value: unknown): value is PlaceType {
  return value === 'building' || value === 'floor' || value === 'room' || value === 'other'
}

/** The registry file exists but does not hold a JSON list of Places. */
export class RegistryUnparsableError extends Error {
  readonly path: string

  constructor(path: string, reason: string) {
    super(`projects registry at ${path} is not a readable list of Places: ${reason}`)
    this.name = 'RegistryUnparsableError'
    this.path = path
  }
}

/**
 * The records in the registry file, or `null` when there is no file yet.
 * Throws RegistryUnparsableError when the file is not a JSON list, and rethrows
 * any other read failure (permissions, I/O, too many open files).
 */
export async function readRegistry(path: string): Promise<Project[] | null> {
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new RegistryUnparsableError(path, err instanceof Error ? err.message : String(err))
  }
  if (!isRegistryList(parsed)) throw new RegistryUnparsableError(path, 'not a JSON list of Places')
  return parsed
}

/**
 * Whether the registry file exists but is not a JSON list of Places. A missing file is
 * not unparsable, and any other read failure throws.
 */
async function isUnparsableRegistry(path: string): Promise<boolean> {
  try {
    await readRegistry(path)
    return false
  } catch (err) {
    if (err instanceof RegistryUnparsableError) return true
    throw err
  }
}

/**
 * Keeps a copy of an unparsable registry as `<path>.corrupt-<now>`. The original stays in
 * place: the save's rename replaces it, and that is the last step. Returns the copy's path,
 * or null when the file is missing or readable. Other read failures throw.
 */
export async function copyUnparsableRegistryAside(path: string, now = Date.now()): Promise<string | null> {
  if (!(await isUnparsableRegistry(path))) return null
  const aside = `${path}.corrupt-${now}`
  await Deno.copyFile(path, aside)
  return aside
}

/**
 * Saves the registry. The new content is written to a temp file first, so a failed write
 * leaves the registry as it was. Then an unparsable file is copied aside, or else the current
 * file is copied to `<path>.bak`. The temp file is renamed over the registry last, the one step
 * that replaces the original. A failure before that step removes the temp file.
 * Returns the path an unparsable file was copied to, if there was one.
 */
export async function saveRegistry(path: string, projects: Project[], now = Date.now()): Promise<string | null> {
  const tmpFile = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify(projects, null, 2))
    const corruptCopy = await copyUnparsableRegistryAside(path, now)
    if (corruptCopy === null) {
      try {
        await Deno.copyFile(path, `${path}.bak`)
      } catch (err) {
        // No file to keep a copy of (the first save).
        if (!(err instanceof Deno.errors.NotFound)) throw err
      }
    }
    await Deno.rename(tmpFile, path)
    return corruptCopy
  } catch (err) {
    await Deno.remove(tmpFile).catch(() => undefined)
    throw err
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A JSON list whose every entry is an object: the only shape a registry file can have. */
function isRegistryList(value: unknown): value is Project[] {
  return Array.isArray(value) && value.every(isRecord)
}

/**
 * Why a Place body cannot be stored, or `null` when it can.
 *
 * `create` is POST /projects, which takes a name and the optional fields the
 * create form sends. `replace` is PUT /projects/:id, which takes the whole Place
 * the client holds, so `floors` (each with its rooms) must be present: the
 * registry reads every floor when it derives areas.
 */
export function placeBodyError(body: unknown, mode: 'create' | 'replace'): string | null {
  if (!isRecord(body)) return 'Place must be a JSON object'
  if (body.name !== undefined && typeof body.name !== 'string') return 'name must be text'
  if (mode === 'replace' && typeof body.name !== 'string') return 'name must be text'
  if (body.projectId !== undefined && typeof body.projectId !== 'string') return 'projectId must be text'
  if (body.placeType !== undefined && !isPlaceType(body.placeType)) {
    return 'placeType must be building, floor, room, or other'
  }
  if (body.parentProjectId !== undefined && body.parentProjectId !== null && typeof body.parentProjectId !== 'string') {
    return 'parentProjectId must be text or null'
  }
  if (body.address !== undefined && body.address !== null && typeof body.address !== 'string') {
    return 'address must be text'
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    return 'notes must be text'
  }
  if (body.geoPose !== undefined && body.geoPose !== null && !isRecord(body.geoPose)) {
    return 'geoPose must be an object'
  }
  // Only the shape here. Whether the frame is stored at all depends on the Place it is PUT to, so
  // `adoptedFrameError` checks the frame itself, and only when it would be used.
  if (mode === 'replace' && body.spatialFrame !== undefined && body.spatialFrame !== null && !isRecord(body.spatialFrame)) {
    return 'spatialFrame must be an object'
  }
  if (mode === 'replace') {
    if (!Array.isArray(body.floors)) return 'floors must be a list'
    for (const floor of body.floors) {
      if (!isRecord(floor) || typeof floor.floorId !== 'string') return 'each floor needs a floorId'
      if (!Array.isArray(floor.rooms)) return 'each floor needs a rooms list'
      for (const room of floor.rooms) {
        if (!isRecord(room) || typeof room.roomId !== 'string') return 'each room needs a roomId'
      }
    }
  }
  if (body.areas !== undefined) {
    if (!Array.isArray(body.areas)) return 'areas must be a list'
    for (const area of body.areas) {
      if (!isRecord(area) || typeof area.areaId !== 'string') return 'each area needs an areaId'
    }
  }
  return null
}

/** Whether a Place already holds a frame. A stored `null` is none. */
function holdsFrame(place: Project): boolean {
  return place.spatialFrame !== undefined && place.spatialFrame !== null
}

/**
 * Why the frame in a whole-record PUT body cannot be stored, or `null` when it can be or is not
 * going to be used. A frame is used only when the stored Place has none (create-if-absent), so a
 * body that carries a frame the Place does not need is never refused for it: a Place with a legacy
 * frame must stay editable by a client that sends that frame back.
 */
export function adoptedFrameError(body: Record<string, unknown>, stored: Project, projectId: string): string | null {
  if (holdsFrame(stored)) return null
  if (body.spatialFrame === undefined || body.spatialFrame === null) return null
  const check = validateSpatialFrame(body.spatialFrame, { projectId })
  return check.ok ? null : check.error
}

/**
 * The Place a PUT /projects/:id stores, built from its body and the Place it replaces. Only the
 * fields `Project` declares are copied, and the id comes from the URL. `createdAt` is the body's when
 * it sends one, else the stored Place's, and `updatedAt` is `now`. Anything else in the body is
 * dropped, so the registry holds only what a Place declares.
 *
 * The frame and its revision do not come from the body, except when the stored Place has no frame
 * (see the header). A stored frame is carried over unchanged.
 *
 * The body must already have passed `placeBodyError(body, 'replace')` and `adoptedFrameError`.
 */
export function placeFromBody(
  body: Record<string, unknown>,
  projectId: string,
  now: number,
  stored: Project,
): Project {
  const place: Project = {
    projectId,
    name: body.name as string,
    createdAt: typeof body.createdAt === 'number' ? body.createdAt : stored.createdAt,
    updatedAt: now,
    floors: body.floors as Floor[],
  }
  if (body.placeType !== undefined) place.placeType = body.placeType as PlaceType
  if (body.parentProjectId !== undefined) place.parentProjectId = body.parentProjectId as string | null
  if (body.buildingName !== undefined) place.buildingName = body.buildingName as string
  if (body.floorName !== undefined) place.floorName = body.floorName as string
  if (body.roomName !== undefined) place.roomName = body.roomName as string
  if (body.address !== undefined) place.address = body.address as string
  if (body.notes !== undefined) place.notes = body.notes as string
  if (body.geoPose !== undefined) place.geoPose = body.geoPose as GeoPose
  if (body.areas !== undefined) place.areas = body.areas as PlaceArea[]

  let revision = placeFrameRevision(stored)
  if (holdsFrame(stored)) {
    place.spatialFrame = stored.spatialFrame
  } else if (body.spatialFrame !== undefined && body.spatialFrame !== null) {
    const check = validateSpatialFrame(body.spatialFrame, { projectId })
    if (check.ok) {
      place.spatialFrame = check.frame
      revision += 1
    }
  }
  if (revision > 0) place.spatialFrameRevision = revision

  // The fields only the server writes (`Project.frameHistory`, `georeference`, `georefVersion`, documented in
  // src/world/types.ts) come from the stored Place and never from the body, as the frame and its revision do:
  // this rebuild copies only what it names, so a field it did not name would be erased by the next rename.
  if (stored.frameHistory !== undefined) place.frameHistory = stored.frameHistory
  if (stored.georeference !== undefined) place.georeference = stored.georeference
  if (stored.georefVersion !== undefined) place.georefVersion = stored.georefVersion
  return place
}

/** What `PUT /projects/:id/spatial-frame` answers. */
export type SpatialFrameWriteReply =
  | { status: 200; body: { revision: number; frame: ProjectSpatialFrame; unchanged?: true } }
  | { status: 400 | 404; body: { error: string } }
  | { status: 409; body: { error: string; code?: FrameWriteRefusalCode; current: { frame: ProjectSpatialFrame | null; revision: number } } }

/**
 * Applies one `{ frame, expectedRevision }` write to the registry's Places, in place.
 *
 * This is the only way to replace a stored frame. It is a compare-and-swap on the Place's frame
 * revision: the write is accepted when `expectedRevision` is the revision the Place holds, the frame
 * is stored, and the revision goes up by one. When it is not, nothing changes and the reply carries
 * the frame and revision the Place does hold, so the writer can see what it lost to.
 *
 * Writing the frame a Place already holds changes nothing and answers 200 with the current
 * revision, whatever `expectedRevision` says. A service-worker replay of a body the server already
 * applied, or a client retrying after a reply it never received, is therefore not a conflict.
 * `createdAt` is part of a frame, so two calibrations are never the same frame.
 *
 * ## Replacing a frame (ADR 0011)
 *
 * A frame is immutable once written, and a replacement is a new generation with a new `frameId`. When the
 * revision matches and the Place holds a frame, `decideReplacement` (./place_frames.ts) judges the write:
 *   - another generation (the ids differ) must carry `replaces: { frameId, reason }`, where `frameId` is the id
 *     of the frame the Place holds (null when it has none) and `reason` is `override`, `upgrade` or `merge`.
 *     Without it, or with another frame's id, the answer is 409 with the frame held and a `code`
 *     (`replaces-required`, `replaces-mismatch`), the same body as a stale revision, so a client that does
 *     not know the code adopts the held frame as it would for any lost race;
 *   - a write that passes appends `{ frameId, createdAt, method, separationM, supersededAt, reason }` of the
 *     replaced frame to `Project.frameHistory` (the newest `FRAME_HISTORY_LIMIT`), in the same step;
 *   - the id of the held frame on a frame that is not the held one, and the id of any frame the Place held before (its
 *     `frameHistory`) on another frame, are 409 `frame-id-reused`: an id names one reference, for good;
 *   - a frame with no id replacing one with none is what every writer did before ids and stays allowed.
 * A `replaces` that is not an object with a frame id (or null) and a known reason is a 400, like any malformed body.
 *
 * Call it inside `mutateProjects` (server/main.ts): that queue is what makes the read and the write
 * one step, and `saveRegistry` is what makes the write whole. `save` says whether to persist.
 */
export function applySpatialFrameWrite(
  projects: Project[],
  projectId: string,
  body: unknown,
  now: number,
): { result: SpatialFrameWriteReply; save: boolean } {
  const refuse = (status: 400 | 404, error: string) => ({ result: { status, body: { error } } as SpatialFrameWriteReply, save: false })
  if (!isRecord(body)) return refuse(400, 'Body must be a JSON object')
  if (!isFrameRevision(body.expectedRevision)) return refuse(400, 'expectedRevision must be a whole number, 0 or more')
  const check = validateSpatialFrame(body.frame, { projectId })
  if (!check.ok) return refuse(400, check.error)
  let replaces: FrameReplaces | null = null
  if (body.replaces !== undefined && body.replaces !== null) {
    const parsed = parseFrameReplaces(body.replaces)
    if (!parsed.ok) return refuse(400, parsed.error)
    replaces = parsed.replaces
  }

  const place = projects.find(candidate => candidate.projectId === projectId)
  if (!place) return refuse(404, 'Not found')

  const revision = placeFrameRevision(place)
  if (holdsFrame(place) && sameSpatialFrame(place.spatialFrame, check.frame)) {
    return {
      result: { status: 200, body: { revision, frame: place.spatialFrame as ProjectSpatialFrame, unchanged: true } },
      save: false,
    }
  }
  if (body.expectedRevision !== revision) {
    return {
      result: {
        status: 409,
        body: {
          error: 'The alignment of this Place changed since it was read',
          current: { frame: holdsFrame(place) ? place.spatialFrame as ProjectSpatialFrame : null, revision },
        },
      },
      save: false,
    }
  }

  if (holdsFrame(place)) {
    const decision = decideReplacement(place.spatialFrame as ProjectSpatialFrame, check.frame, replaces, now, place.frameHistory)
    if (!decision.ok) {
      const current = { frame: place.spatialFrame as ProjectSpatialFrame, revision }
      return { result: { status: 409, body: { error: decision.error, code: decision.code, current } }, save: false }
    }
    if (decision.entry) place.frameHistory = appendFrameHistory(place.frameHistory, decision.entry)
  }

  place.spatialFrame = check.frame
  place.spatialFrameRevision = revision + 1
  place.updatedAt = now
  return { result: { status: 200, body: { revision: revision + 1, frame: check.frame } }, save: true }
}
