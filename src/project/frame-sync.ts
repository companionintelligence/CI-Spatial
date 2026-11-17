/**
 * Getting a Place's frame to the server, and keeping it until it is there.
 *
 * A calibration produces the Place's one durable reference. It used to leave the phone as four steps that
 * did not depend on each other being safe: the frame was set in memory, the reference photos were stored and
 * uploaded, the Place was written to IndexedDB without a guard (a storage error there ended the page's start
 * and skipped everything after it), and then the whole Place was PUT. A queued offline PUT counted as
 * delivered, the queue could evict it, and a frame that only IndexedDB held was never read back.
 *
 * Now, in this order, and no step stops the ones after it:
 *   1. the intent is recorded in IndexedDB (`pendingFrame`), before anything that can fail or take time;
 *   2. the reference photos are stored in IndexedDB and their records, with the path the server will serve
 *      them from, are attached to the frame. Nothing is uploaded yet;
 *   3. the frame is sent to `PUT /projects/:id/spatial-frame` with the revision this client last read;
 *   4. the outcome decides what is kept: the row goes when the server holds the frame, and stays, marked,
 *      when it does not;
 *   5. only once the server holds the frame are the photos uploaded, and each goes where its frame's own photos
 *      are kept (see "Photos" below). A calibration that lost to another device never uploads, so it cannot
 *      replace the winner's photos and leave the winner's frame drawing its crosshairs on somebody else's picture.
 *   6. once the server holds a frame that replaced another, the photos this phone kept for the frames it replaced
 *      are deleted: nothing refers to them any more.
 * Every IndexedDB step is wrapped, and bounded in time. A phone whose storage is full, blocked or stalled still
 * sends the frame.
 *
 * ## Photos
 *
 * A frame that has an id (every one this build writes, WP-08) keeps its photos with it: the record names
 * `/projects/:id/frames/:frameId/ref-<role>.jpg`, the photo is uploaded to `POST /projects/:id/frames/:frameId/reference-photos`
 * with the role the frame knows (`heading` for the heading marker), and this phone keeps the blob under
 * `<projectId>:<frameId>:<role>`. A replaced frame leaves the previous frame's photos where they were, on the server and here.
 * A frame with no id (written before ids existed, and waiting in a row an older build left) keeps one pair per Place: the
 * legacy path, the legacy route and the key `<projectId>:<role>`. The server closes that route for a Place whose frame has an
 * id, so a frame with an id is never sent there.
 *
 * ## One Place, one writer at a time
 *
 * A calibration and a retry of an earlier one for the same Place take a lock (`withPlaceLock`), so they never
 * overlap in this page. The calibration reads the revision after the retry has finished, from a Place the retry
 * has just told what the server holds, and a retry cannot send a frame half way through being written. Another tab
 * is not covered by the lock, and does not need to be: the server compares revisions.
 *
 * ## Replacing a frame the server never received
 *
 * A write that replaces a frame names the generation the SERVER holds, and the server refuses it when that is not the one
 * it has (ADR 0011). The phone's copy of the Place can hold a frame the server never received: one made offline, or one
 * whose request failed, waiting in its row. Replacing that frame replaces what the row replaced, and nothing the server has
 * not seen, so the new write carries the row's own `replaces` (`replacesAtServer`). Without that, the second replacement
 * would name a frame the server has never held, be refused, and take the first down with it although no other device wrote.
 * One case it cannot see: a replacement the server applied whose answer never reached the phone, followed at once by another
 * before any retry. The second names a frame the server has already replaced, is refused as a lost race, and the phone adopts
 * the first.
 *
 * ## Outcomes
 *
 *   saved     the server holds this frame (a 200, or a 409 whose current frame is this one: the request was
 *             already applied, by an earlier try or a replay);
 *   queued    a service worker that does not know the opt-out header took the request offline (a 202 with its
 *             header, which `resp.ok` also calls success). Not delivered. A current worker never queues this
 *             write: the row in IndexedDB is the one queue, so a second calibration replaces the first instead
 *             of both being replayed, and the same frame is never sent into the worker's queue again and again;
 *   conflict  another device saved a different frame first. The server's frame is adopted into the local copy
 *             and this one is kept in the row, never sent again;
 *   failed    the network or the server refused it. Retried when the page loads, when the connection comes
 *             back and when the Place picker opens, unless the server found the frame itself malformed.
 *
 * A 409 that carries the very frame being sent in another form (same `createdAt`: this calibration, saved a
 * moment earlier without its photo records by a retry in another tab) is not a conflict. The write is sent once
 * more, naming the revision the server holds, and replaces it.
 *
 * ## What the person is told
 *
 * "Alignment not synced yet" while a frame is waiting to be saved. A frame that lost to another device never
 * will be, so it has its own sentence, and the scans that follow are not stamped with the calibration that lost
 * (`frameSyncStatusText`).
 */
import type { CalibrationReferencePhoto, Project, ProjectSpatialFrame } from '../world/types'
import { apiBase, apiUrl } from '../shared/api-base.ts'
import { NO_QUEUE_HEADER, isQueuedOffline } from '../shared/offline-queue.ts'
import { CHECK_PHOTO_ROLES, type FramePhotoRole, framePhotoPath, placeFrameRevision, referencePhotoPath, sameSpatialFrame } from '../world/spatial-frame.ts'
import { frameIdOf, isFrameReplaces, type FrameReplaces } from '../world/frame-replacement.ts'
import type { PendingReferencePhoto } from '../ar/reference-photo.ts'
import { writeStatus, type StatusNode } from '../ui/status-line.ts'
import { referencePhotoKey, type PendingFrameRecord, type ProjectStore, type ReferencePhotoRole } from './project-store.ts'

/** The sentence a frame that is waiting to be saved adds: in the status line after a calibration, and beside the Place in the picker. */
export const FRAME_NOT_SYNCED_TEXT = 'Alignment not synced yet'

/**
 * What the status line says when the server already holds a different frame for this Place: a lost race, or an
 * earlier calibration from another phone that this one had not read. Both lines are what the code knows: the server
 * answered with another frame, and the scan is no longer stamped with the calibration that lost to it.
 */
export const FRAME_CONFLICT_TEXT = '⚠ This Place already has a different alignment\n• Scans from here are not aligned to it'

/** What the Place picker says when a Place or an Area could not be made because the phone is offline. */
export const PLACE_NEEDS_CONNECTION = 'Creating a Place needs a connection'
export const AREA_NEEDS_CONNECTION = 'Adding an Area needs a connection'

/**
 * Longest one request about a frame or a photo may take before it counts as failed, in ms. Adopted, not measured
 * (ADR 0005 rule 5): long enough for a slow link to take a few hundred kilobytes, short enough that a link that
 * accepts the connection and never answers does not hold the scanner's start for as long as a browser would.
 */
export const FRAME_REQUEST_TIMEOUT_MS = 20_000

/**
 * Longest one IndexedDB step may take before the steps after it go on without it, in ms. Adopted, not measured
 * (ADR 0005 rule 5). A transaction that neither succeeds nor fails (another tab holding a long write, a stalled
 * WebKit) is not a rejection, so a `catch` never sees it, and it would otherwise hold the frame back from the
 * server for as long as it stays stuck.
 */
export const LOCAL_STEP_TIMEOUT_MS = 5_000

/**
 * How long the scanner waits for a retry that is still running before it opens the calibration, in ms. Adopted, not
 * measured (ADR 0005 rule 5). A retry that finishes in this time hands the calibration the frame and revision the server
 * holds. One that does not is let go on: the calibration takes a few seconds at the least, and the lock makes it wait
 * its turn for the same Place.
 */
export const BOOT_RETRY_WAIT_MS = 3_000

/** The store calls this module makes. A `ProjectStore` has them all. */
export type FrameStore = Pick<
  ProjectStore,
  | 'getProject'
  | 'updateProject'
  | 'putPendingFrame'
  | 'getPendingFrame'
  | 'listPendingFrames'
  | 'patchPendingFrame'
  | 'clearPendingFrame'
  | 'putReferencePhoto'
  | 'getReferencePhoto'
  | 'deleteReferencePhoto'
>

/** What the browser supplies. A test supplies its own. */
export interface FrameSyncEnv {
  /** Looked up when called, not when the module loads: a native shell replaces `fetch` to add its session token. */
  fetchFn: typeof fetch
  url: (path: string) => string
  now: () => number
  /** False only when the browser knows it is offline. True is not a promise, which is why a request can still fail. */
  online: () => boolean
  /** Headers that keep a service worker from queueing the frame's write. Empty where there is no worker to ask. */
  noQueue?: () => Record<string, string>
  /** Longest one request may take, in ms. `FRAME_REQUEST_TIMEOUT_MS` when absent. */
  requestTimeoutMs?: number
  /** Longest one IndexedDB step may take, in ms. `LOCAL_STEP_TIMEOUT_MS` when absent. */
  localStepTimeoutMs?: number
}

export function browserFrameSyncEnv(): FrameSyncEnv {
  return {
    fetchFn: (input, init) => fetch(input, init),
    url: apiUrl,
    now: () => Date.now(),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    noQueue: noQueueHeaders,
  }
}

export type FrameSyncOutcome =
  | { status: 'saved'; revision: number; frame: ProjectSpatialFrame }
  | { status: 'queued' }
  | { status: 'conflict'; current: { frame: ProjectSpatialFrame | null; revision: number } }
  | { status: 'failed'; reason: string; permanent: boolean }

function failed(reason: string, permanent = false): FrameSyncOutcome {
  return { status: 'failed', reason, permanent }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** One request, given up on after `env.requestTimeoutMs`. Rejects as `fetch` does, and on the timeout. */
export async function fetchWithin(env: FrameSyncEnv, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.requestTimeoutMs ?? FRAME_REQUEST_TIMEOUT_MS)
  try {
    return await env.fetchFn(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sends one frame, naming the revision it expects the Place to be at. Never throws.
 *
 * `replaces` is carried by a write that replaces a frame the Place holds (WP-08): it names that frame's generation
 * and why it is being replaced, and the server refuses the write when it names another. A first calibration has
 * none.
 *
 * The queued header is read before the status: a queued write is a 202, and a 202 is `ok`.
 */
export async function sendSpatialFrame(
  env: FrameSyncEnv,
  projectId: string,
  frame: ProjectSpatialFrame,
  expectedRevision: number,
  replaces?: FrameReplaces,
): Promise<FrameSyncOutcome> {
  let response: Response
  try {
    response = await fetchWithin(env, env.url(`/projects/${encodeURIComponent(projectId)}/spatial-frame`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...env.noQueue?.() },
      body: JSON.stringify({ frame, expectedRevision, ...(replaces ? { replaces } : {}) }),
    })
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
  if (isQueuedOffline(response)) return { status: 'queued' }

  const body = await readJson(response)
  if (response.status === 200 && typeof body?.['revision'] === 'number') {
    const stored = body['frame']
    return { status: 'saved', revision: body['revision'], frame: (typeof stored === 'object' && stored !== null ? stored : frame) as ProjectSpatialFrame }
  }
  if (response.status === 409) {
    const current = body?.['current'] as { frame?: unknown; revision?: unknown } | undefined
    if (current && typeof current.revision === 'number') {
      // The frame is already there: the same request was applied before, by a replay or an earlier try.
      if (sameSpatialFrame(current.frame, frame)) return { status: 'saved', revision: current.revision, frame }
      return {
        status: 'conflict',
        current: {
          frame: typeof current.frame === 'object' && current.frame !== null ? current.frame as ProjectSpatialFrame : null,
          revision: current.revision,
        },
      }
    }
  }
  const reason = typeof body?.['error'] === 'string' ? body['error'] : `HTTP ${response.status}`
  // A 400 or 413 is the server finding this frame unacceptable, and sending the same bytes again gets the same answer.
  // A 404 is permanent only when it is the registry's own "Not found" (the Place was deleted or merged away): any other
  // 404 is a server that does not have the route yet.
  const permanent = response.status === 400 || response.status === 413 || (response.status === 404 && body?.['error'] === 'Not found')
  return failed(reason, permanent)
}

/**
 * `sendSpatialFrame`, and once more when the server holds this very calibration in another form. The two forms
 * share `createdAt`, which a calibration sets once and nothing else repeats: a retry in another tab sent the
 * row before the photo records were attached to it, or an earlier try's answer never arrived. That is not
 * another device winning, and giving up there would report this phone as having lost to itself.
 */
async function sendFrame(
  env: FrameSyncEnv,
  projectId: string,
  frame: ProjectSpatialFrame,
  expectedRevision: number,
  replaces?: FrameReplaces,
): Promise<FrameSyncOutcome> {
  const outcome = await sendSpatialFrame(env, projectId, frame, expectedRevision, replaces)
  if (outcome.status === 'conflict' && outcome.current.frame?.createdAt === frame.createdAt) {
    return sendSpatialFrame(env, projectId, frame, outcome.current.revision, replaces)
  }
  return outcome
}

/**
 * Runs one IndexedDB step. A failure is a warning, never a reason to skip the steps after it, and neither is a
 * step that does not answer within `env.localStepTimeoutMs`. Resolves with `undefined` in both cases.
 */
async function local<T>(env: FrameSyncEnv, what: string, step: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      step(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[frame-sync] Gave up waiting to ${what}.`)
          resolve(undefined)
        }, env.localStepTimeoutMs ?? LOCAL_STEP_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    console.warn(`[frame-sync] Could not ${what}:`, error)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// ── One writer per Place ───────────────────────────────────────────────────────

const placeLocks = new Map<string, Promise<void>>()

/** Runs `work` once every earlier call for the same Place has finished, whether it succeeded or not. */
function withPlaceLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const run = (placeLocks.get(projectId) ?? Promise.resolve()).then(work)
  const tail = run.then(() => undefined, () => undefined)
  placeLocks.set(projectId, tail)
  void tail.then(() => {
    if (placeLocks.get(projectId) === tail) placeLocks.delete(projectId)
  })
  return run
}

// ── What happened to a frame, for whoever is showing the Place ─────────────────

export interface FrameSettled {
  projectId: string
  /** The frame that was sent. For a conflict, not the Place's. */
  frame: ProjectSpatialFrame
  outcome: FrameSyncOutcome
}

const settledListeners = new Set<(event: FrameSettled) => void>()

/**
 * Calls `listener` whenever a frame's send has been answered, from a calibration or from a retry the page did not
 * start. The page's copy of the Place is the one thing a retry cannot reach by itself: a listener hands it the
 * server's answer (`adoptFrameOutcome`), so a later calibration names the revision the server holds and a lost
 * race is seen. Returns what to call to stop listening.
 */
export function onFrameSettled(listener: (event: FrameSettled) => void): () => void {
  settledListeners.add(listener)
  return () => {
    settledListeners.delete(listener)
  }
}

function announce(event: FrameSettled): void {
  for (const listener of [...settledListeners]) {
    try {
      listener(event)
    } catch (error) {
      console.warn('[frame-sync] A listener for a settled frame failed:', error)
    }
  }
}

/**
 * Gives a Place what the server said about its frame: after a save, the frame and the revision it was saved at; after a
 * conflict, the frame and revision the server holds, or no frame when it holds none. Any other answer changes nothing.
 */
export function adoptFrameOutcome(project: Project, outcome: FrameSyncOutcome): void {
  if (outcome.status === 'saved') {
    project.spatialFrame = outcome.frame
    project.spatialFrameRevision = outcome.revision
  } else if (outcome.status === 'conflict') {
    if (outcome.current.frame) project.spatialFrame = outcome.current.frame
    else delete project.spatialFrame
    project.spatialFrameRevision = outcome.current.revision
  }
}

/** What a settled outcome does to the row, the Place copy in IndexedDB and the Place in memory. */
async function settle(
  env: FrameSyncEnv,
  store: FrameStore | null,
  row: PendingFrameRecord,
  outcome: FrameSyncOutcome,
  project: Project | null,
): Promise<void> {
  const { projectId } = row
  const createdAt = row.frame.createdAt
  if (project) adoptFrameOutcome(project, outcome)

  if (store) {
    // The mirror follows the server's word, and never the frame a phone has only made: it is written from an answer,
    // and an answer may be lower than what it holds (a registry restored from a backup).
    const mirror = async (frame: ProjectSpatialFrame | null, revision: number): Promise<void> => {
      const copy = project ? { ...project } : await local(env, 'read the Place', () => store.getProject(projectId))
      if (!copy) return
      const next: Project = { ...copy, spatialFrameRevision: revision }
      if (frame) next.spatialFrame = frame
      else delete next.spatialFrame
      await local(env, 'mirror the Place', () => store.updateProject(next, { authoritative: true }))
    }
    const stamp = env.now()
    if (outcome.status === 'saved') {
      if (row.photos?.length) {
        await local(env, 'keep the photos waiting', () => store.patchPendingFrame(projectId, createdAt, { syncState: 'photos', updatedAt: stamp }))
      } else {
        await local(env, 'clear the saved frame', () => store.clearPendingFrame(projectId, createdAt))
      }
      await mirror(outcome.frame, outcome.revision)
      await dropSupersededPhotos(env, store, row)
    } else if (outcome.status === 'queued') {
      await local(env, 'mark the frame queued', () => store.patchPendingFrame(projectId, createdAt, (existing) => ({ syncState: 'queued', updatedAt: stamp, attempts: existing.attempts + 1 })))
    } else if (outcome.status === 'conflict') {
      const marked = await local(env, 'mark the frame in conflict', () =>
        store.patchPendingFrame(projectId, createdAt, (existing) => ({
          syncState: 'conflict',
          current: outcome.current,
          updatedAt: stamp,
          attempts: existing.attempts + 1,
          photos: [],
        })))
      // This calibration's photos will never be uploaded, and they are stored where the Place's own photos are looked up
      // first on this phone: leaving them would show them against the other device's frame.
      if (marked) await dropStagedPhotos(env, store, row)
      await mirror(outcome.current.frame, outcome.current.revision)
    } else {
      await local(env, 'mark the frame failed', () =>
        store.patchPendingFrame(projectId, createdAt, (existing) => ({
          syncState: 'failed',
          lastError: outcome.reason,
          permanent: outcome.permanent,
          updatedAt: stamp,
          attempts: existing.attempts + 1,
        })))
    }
  }
  announce({ projectId, frame: row.frame, outcome })
}

// ── Reference photos ───────────────────────────────────────────────────────────

/** The photos every frame with photos has: the two markers'. They are kept together, or not at all. */
const MARKER_PHOTO_ROLES: readonly ReferencePhotoRole[] = ['landmark', 'headingMarker']

/** The role a frame's own photo of a marker is named by, in its path and in the upload: the frame calls the heading marker's `heading`. */
function frameRoleOf(role: ReferencePhotoRole): FramePhotoRole {
  return role === 'headingMarker' ? 'heading' : role
}

/**
 * The photo records a two-point frame carries, by role: the two markers' (`referencePhotos`) and a check point's, which is
 * on the point (`checkPoints[i].photo`). Nothing for a frame of the other method or one with none.
 */
function photoRecords(frame: ProjectSpatialFrame): Partial<Record<ReferencePhotoRole, CalibrationReferencePhoto>> | undefined {
  if (frame.method !== 'two-point-ground') return undefined
  const records: Partial<Record<ReferencePhotoRole, CalibrationReferencePhoto>> = { ...frame.referencePhotos }
  frame.checkPoints?.forEach((point, index) => {
    const role = CHECK_PHOTO_ROLES[index]
    if (role && point.photo) records[role] = point.photo
  })
  return Object.keys(records).length > 0 ? records : undefined
}

/** What the person typed for the point a photo is of, when they typed anything. */
function photoLabel(frame: ProjectSpatialFrame, role: ReferencePhotoRole): string | undefined {
  if (frame.method !== 'two-point-ground') return undefined
  if (role === 'landmark' || role === 'headingMarker') return frame.pointLabels?.[role === 'landmark' ? 0 : 1]?.trim()
  return frame.checkPoints?.[CHECK_PHOTO_ROLES.indexOf(role)]?.label?.trim()
}

/**
 * The keys a frame's photo records name: where this phone keeps the pictures that frame's record points at. A record a
 * server or an older build wrote may hold less than the type says, so only a record with a text key is one.
 */
function photoKeysOf(frame: ProjectSpatialFrame | null | undefined): string[] {
  if (!frame || frame.method !== 'two-point-ground') return []
  const records: Array<CalibrationReferencePhoto | undefined> = [frame.referencePhotos?.landmark, frame.referencePhotos?.headingMarker]
  for (const point of frame.checkPoints ?? []) records.push(point?.photo)
  return records.flatMap((record) => (typeof record?.localKey === 'string' ? [record.localKey] : []))
}

/**
 * Stores the photos a calibration captured in IndexedDB and returns a copy of `frame` with their records on it, each
 * with the path the server will serve it from (fixed by Place, frame and role: the frame's own photo path when it has an
 * id), and the roles to upload later. Nothing is uploaded. `frame` itself is not changed. A frame keeps both marker photos
 * or none: when either could not be stored the roles are empty and the frame comes back as it was. The schema pairs them on
 * purpose: a panel that showed a photo for A and none for B would let the person confirm half a reference and believe they
 * had confirmed all of it. A check point's photo is an aid of its own and optional, so one that could not be stored leaves
 * its point without a photo and holds nothing else back.
 */
async function stagePhotos(
  env: FrameSyncEnv,
  store: FrameStore,
  projectId: string,
  frame: ProjectSpatialFrame,
  photos: readonly PendingReferencePhoto[],
): Promise<{ frame: ProjectSpatialFrame; roles: ReferencePhotoRole[] }> {
  const none = { frame, roles: [] as ReferencePhotoRole[] }
  // A check point's photo is only kept for a point the frame stores: the roles follow the points, and a copy of a photo no point
  // owns would sit on the phone under a key nothing reads.
  const keptPhotos = photos.filter((photo) => {
    const index = CHECK_PHOTO_ROLES.indexOf(photo.role as typeof CHECK_PHOTO_ROLES[number])
    return index < 0 || (frame.method === 'two-point-ground' && index < (frame.checkPoints?.length ?? 0))
  })
  if (keptPhotos.length === 0) return none
  const records: Partial<Record<ReferencePhotoRole, CalibrationReferencePhoto>> = {}
  // A frame with an id keeps its photos under that id, here (referencePhotoKey) and on the server (framePhotoPath), so a
  // copy a device took for an earlier generation is never found by the record of a later one.
  const frameId = frameIdOf(frame)
  for (const photo of keptPhotos) {
    const localKey = referencePhotoKey(projectId, photo.role, frameId ?? undefined)
    const stored = await local(env, 'store a reference photo', async () => {
      await store.putReferencePhoto({
        localKey,
        projectId,
        role: photo.role,
        blob: photo.blob,
        thumbDataUrl: photo.thumbDataUrl,
        capturedAt: photo.capturedAt,
      })
      return true
    })
    if (!stored) continue
    records[photo.role] = {
      url: frameId === null ? referencePhotoPath(projectId, photo.role) : framePhotoPath(projectId, frameId, frameRoleOf(photo.role)),
      localKey,
      tapPoint: photo.tapPoint,
      pose: photo.pose,
      capturedAt: photo.capturedAt,
    }
  }
  const { landmark, headingMarker } = records
  if (!landmark || !headingMarker || frame.method !== 'two-point-ground') {
    console.warn('[frame-sync] Both reference photos have to be stored for a frame to keep them. The frame keeps none.')
    return none
  }
  const roles: ReferencePhotoRole[] = [...MARKER_PHOTO_ROLES]
  const checkPoints = frame.checkPoints?.map((point, index) => {
    const role = CHECK_PHOTO_ROLES[index]
    const photo = role ? records[role] : undefined
    if (!role || !photo) return point
    roles.push(role)
    return { ...point, photo }
  })
  return { frame: { ...frame, referencePhotos: { landmark, headingMarker }, ...(checkPoints ? { checkPoints } : {}) }, roles }
}

/** Deletes the stored photos of a frame that will never be uploaded. */
async function dropStagedPhotos(env: FrameSyncEnv, store: FrameStore, row: PendingFrameRecord): Promise<void> {
  const records = photoRecords(row.frame)
  if (!records) return
  for (const role of row.photos ?? []) {
    const record = records[role]
    if (record) await local(env, 'drop a reference photo that lost', () => store.deleteReferencePhoto(record.localKey))
  }
}

/**
 * Whether a photo the server refused is worth sending again. A refusal it will give again for these bytes is not: a 400 or a
 * 413, a 409 from the legacy route a frame with an id never uses, a 404 that carries the server's own sentence (this Place or
 * this reference is not there). A timeout, a limit and a server error may pass. A 404 with no sentence on the route that
 * keeps a frame's own photos is a server that does not have that route yet, which is older than this build: the photo waits
 * for it, and is sent when the server has been updated.
 */
async function worthSendingAgain(response: Response, frameScoped: boolean): Promise<boolean> {
  const { status } = response
  const refused = status >= 400 && status < 500 && status !== 408 && status !== 429
  if (!refused) return true
  if (status !== 404 && status !== 409) return false
  const body = await readJson(response)
  if (status === 409 && body?.['code'] === 'legacy-photos-closed') {
    console.warn('[frame-sync] The server keeps the photos of each reference with that reference, so a photo of a frame with no id is not taken.')
  }
  return status === 404 && frameScoped && typeof body?.['error'] !== 'string'
}

/**
 * Sends one photo, to where its frame's photos are kept: `POST /projects/:id/frames/:frameId/reference-photos` for a frame with an
 * id, with the role the frame knows, and the Place's own route for a frame with none. 'done' when the server has it or the service
 * worker holds it, 'retry' when sending it again may work.
 */
async function postPhoto(
  env: FrameSyncEnv,
  row: PendingFrameRecord,
  role: ReferencePhotoRole,
  record: CalibrationReferencePhoto,
  blob: Blob,
): Promise<'done' | 'retry'> {
  const label = photoLabel(row.frame, role)
  const frameId = frameIdOf(row.frame)
  const sentRole = frameId === null ? role : frameRoleOf(role)
  const place = `/projects/${encodeURIComponent(row.projectId)}`
  const form = new FormData()
  form.append('image', blob, `ref-${sentRole}.jpg`)
  form.append('meta', JSON.stringify({
    role: sentRole,
    tapPoint: record.tapPoint,
    pose: record.pose,
    capturedAt: record.capturedAt,
    ...(label ? { label } : {}),
  }))
  try {
    const response = await fetchWithin(env, env.url(frameId === null ? `${place}/reference-photos` : `${place}/frames/${encodeURIComponent(frameId)}/reference-photos`), {
      method: 'POST',
      body: form,
    })
    // A worker that queued it holds it durably and delivers it: from here it is the worker's.
    if (isQueuedOffline(response) || response.ok) return 'done'
    return await worthSendingAgain(response, frameId !== null) ? 'retry' : 'done'
  } catch (error) {
    console.warn('[frame-sync] A reference photo could not be uploaded:', error)
    return 'retry'
  }
}

/** Deletes the photos this phone kept for the frames a saved frame replaced: nothing refers to them any more. */
async function dropSupersededPhotos(env: FrameSyncEnv, store: FrameStore, row: PendingFrameRecord): Promise<void> {
  for (const localKey of row.supersededPhotoKeys ?? []) {
    await local(env, 'drop a reference photo of a replaced frame', () => store.deleteReferencePhoto(localKey))
  }
}

/**
 * Uploads the photos a saved frame still has waiting, from the copies in IndexedDB, and keeps the row only for those
 * that did not go. A photo whose copy is gone has nothing left to send and is let go.
 */
async function uploadPhotos(env: FrameSyncEnv, store: FrameStore, row: PendingFrameRecord): Promise<void> {
  const records = photoRecords(row.frame)
  const remaining: ReferencePhotoRole[] = []
  for (const role of row.photos ?? []) {
    const record = records?.[role]
    if (!record) continue
    const stored = await local(env, 'read a reference photo', () => store.getReferencePhoto(record.localKey))
    if (stored === undefined) {
      remaining.push(role)
      continue
    }
    if (stored === null) {
      console.warn(`[frame-sync] The ${role} reference photo is no longer stored on this phone, so it cannot be uploaded.`)
      continue
    }
    if (await postPhoto(env, row, role, record, stored.blob) === 'retry') remaining.push(role)
  }
  if (remaining.length === 0) {
    await local(env, 'clear the saved frame', () => store.clearPendingFrame(row.projectId, row.frame.createdAt))
  } else {
    await local(env, 'keep the photos still to upload', () =>
      store.patchPendingFrame(row.projectId, row.frame.createdAt, { photos: remaining, updatedAt: env.now() }))
  }
}

// ── Sending a row ──────────────────────────────────────────────────────────────

/** Sends the row's frame and settles the answer. The photos follow once the server holds the frame, and not before. */
async function sendRow(
  env: FrameSyncEnv,
  store: FrameStore | null,
  row: PendingFrameRecord,
  project: Project | null,
): Promise<FrameSyncOutcome> {
  // A row is what a person's storage returns, which another build or a failing disk may have changed: only a well formed
  // `replaces` is sent. A write that needs one and has none is refused by the server, and the answer is a conflict.
  const replaces = isFrameReplaces(row.replaces) ? row.replaces : undefined
  const outcome = await sendFrame(env, row.projectId, row.frame, row.expectedRevision, replaces)
  await settle(env, store, row, outcome, project)
  if (outcome.status === 'saved' && store && row.photos?.length) await uploadPhotos(env, store, row)
  return outcome
}

export interface PersistOptions {
  /** What the calibration captured of the two markers, and of the check point when it took one, as the flow hands it over. */
  photos?: readonly PendingReferencePhoto[]
  /**
   * Set when `frame` replaces a frame the Place holds (WP-08): which generation, and why. Kept on the row, so a retry
   * made days later still says what it replaces, and a server that finds the frame it holds is another one refuses it.
   * It names the frame the phone held. When that frame never reached the server, what is sent is what that frame's row
   * replaced instead (`replacesAtServer`).
   */
  replaces?: FrameReplaces
}

/** Whether the frame the phone holds is the one in `earlier`, a row whose frame the server has not been given. */
function heldIsUnsent(held: ProjectSpatialFrame | undefined, earlier: PendingFrameRecord | null): earlier is PendingFrameRecord {
  // A row in 'photos' state is one the server holds. One in conflict has handed the Place the server's frame, so it is not the held one.
  return held !== undefined && earlier !== null && earlier.syncState !== 'photos' && earlier.frame.createdAt === held.createdAt
}

/**
 * What a frame replaces at the server. `wanted` is what the calibration says it replaces: the frame the phone held. When that
 * is a frame the server never received (`earlier`: its row is still waiting, because the request was made offline or failed),
 * the new frame replaces what that frame replaced, and nothing the server has not seen: the row's own `replaces`, or none
 * when it replaced nothing. In every other case the held frame is the server's and `wanted` is right.
 */
export function replacesAtServer(
  wanted: FrameReplaces | undefined,
  held: ProjectSpatialFrame | undefined,
  earlier: PendingFrameRecord | null,
): FrameReplaces | undefined {
  if (!wanted || !heldIsUnsent(held, earlier)) return wanted
  return isFrameReplaces(earlier.replaces) ? earlier.replaces : undefined
}

/**
 * The keys of the photos this phone kept for the frames a new frame replaces, to delete once the server holds it: the frame the
 * phone held, and when that one never reached the server, the frame its row replaced too. Not a key the new frame's own
 * photos will use, which a frame with no id shares with the one before it.
 */
function supersededKeys(
  projectId: string,
  frame: ProjectSpatialFrame,
  held: ProjectSpatialFrame | undefined,
  earlier: PendingFrameRecord | null,
): string[] {
  // Every photo this frame may have, the check points' too: none of its own keys is superseded by itself.
  const own = new Set([...MARKER_PHOTO_ROLES, ...CHECK_PHOTO_ROLES].map((role) => referencePhotoKey(projectId, role, frameIdOf(frame) ?? undefined)))
  const keys = [...photoKeysOf(held), ...(heldIsUnsent(held, earlier) ? earlier.supersededPhotoKeys ?? [] : [])]
  return [...new Set(keys)].filter((key) => !own.has(key))
}

/**
 * The calibration commit's persistence: records the intent, stores the photos, sends the frame, records how it went
 * and, once the server holds the frame, uploads the photos. `frame` becomes the Place's (`project.spatialFrame`), and
 * the revision it names is the one `project` carries when the commit gets its turn. Never throws.
 */
export async function persistProjectSpatialFrame(
  store: FrameStore | null,
  project: Project,
  frame: ProjectSpatialFrame,
  options: PersistOptions = {},
  env: FrameSyncEnv = browserFrameSyncEnv(),
): Promise<FrameSyncOutcome> {
  const { projectId } = project
  return withPlaceLock(projectId, async () => {
    // Taken now, not on the way in: a retry that held the lock first has just told the Place what the server holds.
    const expectedRevision = placeFrameRevision(project)
    const held = project.spatialFrame
    // The row this one replaces, read before it is: a frame the server never received is not one the new frame can name.
    const earlier = options.replaces && store ? (await local(env, 'read the frame waiting', () => store.getPendingFrame(projectId))) ?? null : null
    const replaces = replacesAtServer(options.replaces, held, earlier)
    const superseded = options.replaces ? supersededKeys(projectId, frame, held, earlier) : []
    project.spatialFrame = frame
    const row: PendingFrameRecord = {
      projectId,
      frame,
      expectedRevision,
      syncState: 'pending',
      recordedAt: env.now(),
      updatedAt: env.now(),
      attempts: 0,
      ...(replaces ? { replaces } : {}),
      ...(superseded.length > 0 ? { supersededPhotoKeys: superseded } : {}),
    }
    if (store) {
      await local(env, 'record the frame to save', () => store.putPendingFrame(row))
      const staged = await stagePhotos(env, store, projectId, frame, options.photos ?? [])
      if (staged.roles.length > 0) {
        row.frame = staged.frame
        row.photos = staged.roles
        project.spatialFrame = staged.frame
        await local(env, 'record the frame with its photos', () =>
          store.patchPendingFrame(projectId, frame.createdAt, { frame: staged.frame, photos: staged.roles }))
      }
    }
    return sendRow(env, store, row, project)
  })
}

const inFlight = new WeakMap<object, Promise<{ changed: boolean }>>()

/** What brought a retry about. A frame the service worker may still hold is not sent again just because the picker opened. */
export type RetryTrigger = 'load' | 'online' | 'picker'

/**
 * Sends every frame still waiting, and uploads the photos of every frame the server holds. Called when the page loads,
 * when the browser says it is online again and when the Place picker opens. Single-flight per store, so those can fire
 * together.
 *
 * A row in conflict is not sent again, and neither is one the server found malformed. While the browser knows it is
 * offline nothing is sent. A row a service worker queued (one that does not know the opt-out header) is sent again on
 * load and on reconnecting only: every send into a worker's queue is one more copy there, and the picker opens as often as
 * the person likes. Resolves with whether any frame reached the server or lost to another, which is when a picker redraws.
 */
export function retryPendingFrames(
  store: FrameStore | null,
  env: FrameSyncEnv = browserFrameSyncEnv(),
  trigger: RetryTrigger = 'load',
): Promise<{ changed: boolean }> {
  if (!store) return Promise.resolve({ changed: false })
  const running = inFlight.get(store)
  if (running) return running
  const run = (async () => {
    const listed = (await local(env, 'read the frames waiting', () => store.listPendingFrames())) ?? []
    let changed = false
    for (const { projectId } of listed) {
      const step = await withPlaceLock(projectId, async (): Promise<'next' | 'stop' | 'changed'> => {
        // Read again under the lock: a calibration that held it first may have replaced the row.
        const row = await local(env, 'read the waiting frame', () => store.getPendingFrame(projectId))
        if (!row) return 'next'
        if (row.syncState === 'conflict' || row.permanent) return 'next'
        if (row.syncState === 'queued' && trigger === 'picker') return 'next'
        if (!env.online()) return 'stop'
        if (row.syncState === 'photos') {
          await uploadPhotos(env, store, row)
          return 'next'
        }
        const outcome = await sendRow(env, store, row, null)
        return outcome.status === 'saved' || outcome.status === 'conflict' ? 'changed' : 'next'
      })
      if (step === 'stop') break
      if (step === 'changed') changed = true
    }
    return { changed }
  })().finally(() => inFlight.delete(store))
  inFlight.set(store, run)
  return run
}

/**
 * Resolves when the retry now running for `store` has finished, or after `waitMs`, whichever is first. The scanner waits
 * on it before it opens the calibration, so the Place it calibrates against already carries what the server holds.
 */
export async function whenFramesSettled(store: object | null, waitMs: number = BOOT_RETRY_WAIT_MS): Promise<void> {
  const running = store ? inFlight.get(store) : undefined
  if (!running) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    running.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    }),
  ])
  clearTimeout(timer)
}

// ── Which Place the scanner starts on ──────────────────────────────────────────

export interface PlaceList {
  /** False when the request failed (no network, or a status that is not a success). An empty list that succeeded is `ok`. */
  ok: boolean
  places: Project[]
}

/** The Places the server lists. Never throws, and says whether the answer was one. */
export async function fetchPlaceList(env: FrameSyncEnv = browserFrameSyncEnv()): Promise<PlaceList> {
  try {
    const response = await fetchWithin(env, env.url('/projects'), {})
    if (!response.ok || isQueuedOffline(response)) return { ok: false, places: [] }
    const body: unknown = await response.json()
    return Array.isArray(body) ? { ok: true, places: body as Project[] } : { ok: false, places: [] }
  } catch {
    return { ok: false, places: [] }
  }
}

/** A Place carrying the frame of the higher revision of the two copies. A tie goes to the first, the server's. */
function preferHigherRevision(server: Project, mirror: Project | null): Project {
  if (!mirror?.spatialFrame || placeFrameRevision(mirror) <= placeFrameRevision(server)) return server
  return { ...server, spatialFrame: mirror.spatialFrame, spatialFrameRevision: mirror.spatialFrameRevision }
}

/**
 * The Place as the scanner should work with it: when a calibration here has not reached the server, its frame
 * stands, so a person who calibrated offline is not asked to do it again on the next visit. That holds only while the
 * Place is at the revision the calibration was made against. Past it, another device has saved a frame since, this
 * one can only lose, and standing for the Place would have the person calibrate against a frame the server refuses.
 * A frame the server refused, or that lost to another device's, never stands.
 */
export function withPendingFrame(place: Project, rows: readonly PendingFrameRecord[]): Project {
  const row = rows.find((candidate) => candidate.projectId === place.projectId)
  if (!row || !waitsToBeSaved(row) || row.expectedRevision !== placeFrameRevision(place)) return place
  return { ...place, spatialFrame: row.frame }
}

/** Whether a row still has a frame to send: not one that lost, not one the server refused, and not one the server already holds. */
function waitsToBeSaved(row: PendingFrameRecord): boolean {
  return row.syncState !== 'conflict' && row.syncState !== 'photos' && !row.permanent
}

/**
 * The Places whose frame is still on its way to the server: waiting, queued, or failed in a way a retry may fix.
 * A frame that lost to another device's is not on its way (the Place has the other frame, here too), neither is one
 * the server found malformed, and a frame the server holds is not, whatever its photos are doing.
 */
export function unsyncedPlaceIds(rows: readonly PendingFrameRecord[]): Set<string> {
  return new Set(rows.filter(waitsToBeSaved).map((row) => row.projectId))
}

export interface InitialPlaceOptions {
  store: FrameStore | null
  list: PlaceList
  /** The `project` query parameter. */
  queryProject: string | null
  /** What an earlier visit stored as the selection: JSON, as written. */
  storedSelection: string | null
  /** Called when the query parameter named a Place the server lists, so a reload keeps it. */
  onQueryChoice: (projectId: string) => void
  env?: FrameSyncEnv
}

/**
 * The Place this visit starts on, or null when the person has to choose.
 *
 * The server's copy is the Place, and the copy in IndexedDB is a fallback with one exception: when it holds a
 * higher frame revision, its frame is the one used. The IndexedDB copy stands in for the Place only when the list
 * request FAILED. A list that came back without the Place means the server no longer has it (merged away or
 * deleted), and offering the copy would bring it back to life: the scan would be uploaded to a Place that is gone.
 */
export async function resolveInitialPlace(options: InitialPlaceOptions): Promise<Project | null> {
  const { store, list } = options
  const env = options.env ?? browserFrameSyncEnv()
  const rows = store ? (await local(env, 'read the frames waiting', () => store.listPendingFrames())) ?? [] : []
  const read = (projectId: string) => (store ? local(env, 'read the Place', () => store.getProject(projectId)) : Promise.resolve(null))
  const fromServer = async (place: Project) => withPendingFrame(preferHigherRevision(place, (await read(place.projectId)) ?? null), rows)

  const fromQuery = options.queryProject ? list.places.find((place) => place.projectId === options.queryProject) : undefined
  if (fromQuery) {
    options.onQueryChoice(fromQuery.projectId)
    return fromServer(fromQuery)
  }

  if (options.storedSelection) {
    try {
      const projectId = (JSON.parse(options.storedSelection) as { projectId?: string | null }).projectId
      if (projectId === null) return null
      const match = list.places.find((place) => place.projectId === projectId)
      if (match) return fromServer(match)
      if (projectId && !list.ok) {
        const mirrored = await read(projectId)
        if (mirrored) return withPendingFrame(mirrored, rows)
      }
    } catch { /* bad prior value */ }
  }

  // A place must never be inferred from the first project in the registry.
  // The user explicitly chooses a saved place or creates a new one.
  return null
}

// ── Creating a Place or an Area ────────────────────────────────────────────────

/**
 * Headers that keep the service worker from queueing a write the person is about to be told did not happen, or that
 * this module queues itself. Only a page the worker can queue for needs it: served from the same origin as the server,
 * and controlled by a worker. A native shell has no worker and talks to another origin, where a custom header would
 * also need a CORS preflight.
 */
export function noQueueHeaders(): Record<string, string> {
  const worker = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : undefined
  return worker && apiBase() === '' ? { [NO_QUEUE_HEADER]: '1' } : {}
}

export type CreatedPlace =
  | { ok: true; place: Project }
  | { ok: false; reason: 'needs-connection' | 'rejected' }

/**
 * The Place a create or an add-area request answered with. A service worker that took the request offline answers
 * 202 with a body that is not a Place (`{ ok: false, queuedOffline: true, queueId }`), and `response.ok` is true for
 * it, so that is checked first. A body that is not a Place with an id and its floors is refused too: a record with
 * no `projectId` has no key to store under, and selecting it sent the scan to no Place at all.
 */
export async function readCreatedPlace(response: Response): Promise<CreatedPlace> {
  if (isQueuedOffline(response)) return { ok: false, reason: 'needs-connection' }
  if (!response.ok) return { ok: false, reason: 'rejected' }
  const body = await readJson(response)
  if (!body || typeof body['projectId'] !== 'string' || body['projectId'].length === 0 || !Array.isArray(body['floors'])) {
    return { ok: false, reason: 'rejected' }
  }
  return { ok: true, place: body as unknown as Project }
}

// ── What the person is told ────────────────────────────────────────────────────

/**
 * The status line after a calibration: the calibration's own outcome (`calibrationText`), then what the frame's
 * sync adds. A frame the server holds adds nothing. One that is waiting adds "Alignment not synced yet" as a line of its
 * own. One that lost to another device replaces the calibration's outcome, because that outcome describes a frame
 * the Place no longer has.
 */
export function frameSyncStatusText(calibrationText: string, outcome: FrameSyncOutcome | null): string {
  if (!outcome || outcome.status === 'saved') return calibrationText
  if (outcome.status === 'conflict') return FRAME_CONFLICT_TEXT
  return calibrationText.includes(FRAME_NOT_SYNCED_TEXT) ? calibrationText : `${calibrationText}\n• ${FRAME_NOT_SYNCED_TEXT}`
}

/**
 * Writes `frameSyncStatusText` over the line the calibration's own outcome was just written to, holding the line as that
 * did, so the two are read together. A frame the server holds writes nothing.
 */
export function showFrameSyncNote(el: StatusNode | null, outcome: FrameSyncOutcome | null): void {
  if (!el || !outcome || outcome.status === 'saved') return
  writeStatus(el, frameSyncStatusText(el.textContent ?? '', outcome), 'sticky')
}
