/**
 * ProjectStore — projects, floors, rooms, scan assignments, calibration
 * reference photos, and the frames a calibration made that the server has not
 * confirmed yet.
 *
 * Stored in its own IndexedDB database ('ci-xr-projects', v3) so it does not
 * conflict with the per-session detection store schema.
 *
 * Schema:
 *   objectStore 'projects'        keyPath: 'projectId'
 *   objectStore 'scans'           keyPath: 'scanId'
 *                                 index 'byProject' on 'projectId'
 *                                 index 'bySession' on 'sessionId'
 *   objectStore 'referencePhotos' keyPath: 'localKey'        (v2, ticket 0007)
 *                                 index 'byProject' on 'projectId'
 *   objectStore 'pendingFrame'    keyPath: 'projectId'       (v3)
 *
 * The database name is on CLAUDE.md's protected-identifier list: renaming it
 * orphans every existing user's Places. Adding a store behind a version bump
 * is additive and safe; renaming is not.
 *
 * ## Two kinds of record about a Place's frame
 *
 * 'projects' is a mirror: the Place as the server last said it, kept so the app
 * can start without a network. Any copy of a Place may be written over it, so a
 * frame that exists only there is not safe. 'pendingFrame' is the other kind: the
 * intent to save a frame, one row per Place, written before anything else and
 * removed only when the server has the frame (src/project/frame-sync.ts). Nothing
 * that writes a Place copy touches it.
 *
 * `updateProject` never lets a copy with a lower frame revision take the frame
 * from the record it replaces: two tabs share this database, and the one that
 * loaded the Place before a calibration would otherwise erase it on its next save.
 * The history of the frames it replaced and the georeference are held the same way.
 */

// ── Data types ─────────────────────────────────────────────────────────────────

export type {
  Floor,
  Project,
  ScanCalibration,
  Room,
  ScanEntry,
  ScanEntryQualitySummary,
  ScanStatus,
} from '../world/types'

import type { Floor, Project, ProjectSpatialFrame, Room, ScanEntry } from '../world/types'
import type { FrameReplaces } from '../world/frame-replacement.ts'
import { placeFrameRevision } from '../world/spatial-frame.ts'

/**
 * A reference photo's bytes, held locally so the aid works offline and on the
 * capturing device even when the upload never lands.
 *
 * The blob rather than a data URL, following `DetectionStore`'s `captures`
 * store (src/scene/store.ts) — the established choice for image bytes in this
 * app. `thumbDataUrl` is the small inline preview, cheap enough to render
 * without reading the full blob back.
 */
export interface ReferencePhotoRecord {
  localKey: string
  projectId: string
  role: ReferencePhotoRole
  blob: Blob
  thumbDataUrl: string
  capturedAt: string
}

/** The points a Place keeps a photo of: the landmark, the heading marker and up to three check points (the flow offers one). */
export type ReferencePhotoRole = 'landmark' | 'headingMarker' | 'check1' | 'check2' | 'check3'

/**
 * The local key for a Place's photo of one marker.
 *
 * Deterministic rather than unique-per-capture: the key is a function of what
 * the photo is of, never of when it was taken, so one frame has one photo per
 * marker (a check point adds a third, under its own role) and storing it again
 * (a retry) replaces it rather than adding a second.
 *
 * A frame that has an id (`frameId`, WP-08) keeps its photos under it:
 * `<projectId>:<frameId>:<role>`. The key a record names is looked up in this
 * database before the server's copy is asked for, so with one key per Place
 * and role a device that had calibrated the Place earlier showed its old photo
 * under the crosshair of a newer record another device had made. A key that
 * names the generation cannot be found by the record of another one. A frame
 * with no id (every one written before ids existed) keeps the old key, one pair
 * per Place that a re-calibration replaces (ticket 0007).
 *
 * A key that names a generation is not replaced by the next one, so the photos
 * of a frame that has been replaced are deleted when the frame that replaces
 * it is saved (`PendingFrameRecord.supersededPhotoKeys`, src/project/frame-sync.ts),
 * and nothing refers to them any more.
 */
export function referencePhotoKey(projectId: string, role: ReferencePhotoRole, frameId?: string): string {
  return frameId ? `${projectId}:${frameId}:${role}` : `${projectId}:${role}`
}

/**
 * Where a frame that has not reached the server stands.
 *   'pending'  not sent yet, or sent and not answered.
 *   'queued'   a service worker that does not know the opt-out header took the request offline and will replay it.
 *   'failed'   the server or the network refused it; a retry may succeed unless `permanent`.
 *   'conflict' another device saved a different frame first. The server's frame is in `current`.
 *   'photos'   the server holds the frame. Its reference photos, kept in this database, are still to be uploaded.
 */
export type PendingFrameSyncState = 'pending' | 'queued' | 'failed' | 'conflict' | 'photos'

/**
 * A frame a calibration made, until the server holds it and its photos are uploaded. One row per Place:
 * a newer calibration replaces the row. `expectedRevision` is the revision the client had read when it
 * calibrated, which is what the server compares, so a retry made days later is still a compare-and-swap
 * and never an overwrite.
 */
export interface PendingFrameRecord {
  projectId: string
  frame: ProjectSpatialFrame
  expectedRevision: number
  syncState: PendingFrameSyncState
  /** Device clock, in ms. For the person reading the log: nothing orders frames by it. */
  recordedAt: number
  updatedAt: number
  attempts: number
  lastError?: string
  /** A refusal no retry can change, such as the server finding the frame itself malformed. */
  permanent?: boolean
  /** What the server held when it refused. Set with state 'conflict'. */
  current?: { frame: ProjectSpatialFrame | null; revision: number }
  /**
   * The reference photos stored in this database (`referencePhotos`) that the server does not have yet. They are
   * uploaded only once the frame is saved, so a calibration that lost to another device cannot overwrite the
   * photos of the one that won. Absent or empty when there is nothing to upload.
   */
  photos?: ReferencePhotoRole[]
  /**
   * Set when this frame replaces a frame the Place holds: the generation it replaces and why (WP-08). Sent with every
   * try, so a retry made later says what it replaces. Absent on a first calibration, and on a row written before the
   * field existed, which is sent as it always was.
   */
  replaces?: FrameReplaces
  /**
   * The keys (`referencePhotoKey`) of the photos this phone kept for the frames this one replaces: the frame it held, and a
   * frame it held that the server never received. Deleted once the server holds this frame (WP-08), and never before: a
   * frame that lost, or has not been saved, leaves the photos of the frame the Place still has. Absent when this frame
   * replaced nothing, and on a row written before the field existed.
   */
  supersededPhotoKeys?: string[]
}

// ── DB constants ───────────────────────────────────────────────────────────────

const DB_NAME = 'ci-xr-projects'
/**
 * v2 added the `referencePhotos` store (wave 09 ticket 0007), the first upgrade this
 * database had. v3 adds `pendingFrame`. The database holds the Place records themselves
 * rather than regenerable session data, so `onupgradeneeded` below only ever *creates*
 * what is missing and never touches a store that exists. A v1 or v2 database keeps every
 * Place, scan and reference photo it had.
 */
const DB_VERSION = 3
const PROJECTS_STORE = 'projects'
const SCANS_STORE = 'scans'
const REFERENCE_PHOTOS_STORE = 'referencePhotos'
const PENDING_FRAME_STORE = 'pendingFrame'

/**
 * How long `open()` waits for an upgrade that another tab is holding up. A tab running a build from before
 * v3 keeps its connection to the database open and never offers to close it, so the upgrade cannot finish
 * until that tab is closed. Past this the store opens without a database: reads find nothing, the writes the
 * calibration makes fail and are caught where they are made, and the scan bookkeeping is skipped so an
 * export still reaches the server. The upgrade still finishes when the other tab lets go, and the store
 * starts working then. Adopted, not measured (ADR 0005 rule 5): long enough not to give up on a slow
 * device, short enough that boot is never held on a tab the person cannot see.
 */
const BLOCKED_OPEN_WAIT_MS = 3000

/**
 * `Project.georefVersion` as a count: absent, and anything that is not a whole number of at least 1, reads as 0,
 * as `placeFrameRevision` reads a frame revision.
 */
function georefVersionOf(place: Project): number {
  const version = place.georefVersion
  return typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 0
}

/**
 * `incoming`, with what only the server writes taken from `existing` wherever `existing` is the newer copy:
 *  - the frame and its revision, when `existing` holds a frame at a higher revision, and with them the history of
 *    the frames it replaced, which the server appends in the same step as the frame write (`Project.frameHistory`);
 *  - the georeference and its version, when `existing` holds a georeference at a higher `georefVersion`.
 * The two are counted apart, so a copy can be behind on one and not on the other. Everything else is `incoming`'s,
 * and when nothing is kept the answer is `incoming` itself.
 */
function keepNewerFromServer(existing: Project, incoming: Project): Project {
  let write = incoming
  if (existing.spatialFrame && placeFrameRevision(existing) > placeFrameRevision(incoming)) {
    write = { ...write, spatialFrame: existing.spatialFrame, spatialFrameRevision: existing.spatialFrameRevision }
    if (existing.frameHistory !== undefined) write.frameHistory = existing.frameHistory
  }
  if (existing.georeference && georefVersionOf(existing) > georefVersionOf(incoming)) {
    write = { ...write, georeference: existing.georeference, georefVersion: existing.georefVersion }
  }
  return write
}

// ── Store class ────────────────────────────────────────────────────────────────

export class ProjectStore {
  private db: IDBDatabase | null = null

  async open(): Promise<void> {
    this.db = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      let settled = false
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
          db.createObjectStore(PROJECTS_STORE, { keyPath: 'projectId' })
        }
        if (!db.objectStoreNames.contains(SCANS_STORE)) {
          const s = db.createObjectStore(SCANS_STORE, { keyPath: 'scanId' })
          s.createIndex('byProject', 'projectId', { unique: false })
          s.createIndex('bySession', 'sessionId', { unique: false })
        }
        // v1 → v2. Purely additive: a v1 database arrives here with its two
        // stores already populated and leaves with them untouched.
        if (!db.objectStoreNames.contains(REFERENCE_PHOTOS_STORE)) {
          const s = db.createObjectStore(REFERENCE_PHOTOS_STORE, { keyPath: 'localKey' })
          s.createIndex('byProject', 'projectId', { unique: false })
        }
        // v2 → v3. Purely additive as well.
        if (!db.objectStoreNames.contains(PENDING_FRAME_STORE)) {
          db.createObjectStore(PENDING_FRAME_STORE, { keyPath: 'projectId' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        // A later build that needs to upgrade must not be held up by this tab. This tab's store stops
        // working until it is reloaded, which is the lesser harm: it is running an older build.
        db.onversionchange = () => {
          db.close()
          if (this.db === db) this.db = null
        }
        if (settled) this.db = db
        else {
          settled = true
          resolve(db)
        }
      }
      req.onerror = () => {
        if (settled) return
        settled = true
        // An older build opening a database a newer one upgraded gets a VersionError here, and a browser that
        // refuses storage gets another. Neither is a reason to end the page's start: the store opens without a
        // database, as it does when an upgrade is blocked, and the frame is still sent to the server.
        console.warn('[projects] The Places database could not be opened:', req.error)
        resolve(null)
      }
      req.onblocked = () => {
        console.warn('[projects] The Places database is being upgraded, and another tab of this app is holding it open. Close that tab to finish.')
        setTimeout(() => {
          if (settled) return
          settled = true
          resolve(null)
        }, BLOCKED_OPEN_WAIT_MS)
      }
    })
  }

  // ── Project CRUD ─────────────────────────────────────────────────────────────

  async createProject(name: string, address?: string, notes?: string, geoPose?: Project['geoPose']): Promise<Project> {
    const now = Date.now()
    const project: Project = {
      projectId: `proj-${now}`,
      name,
      address,
      notes,
      geoPose,
      createdAt: now,
      updatedAt: now,
      floors: [{
        floorId: `floor-${now}`,
        name: 'Ground Floor',
        level: 0,
        rooms: [],
      }],
    }
    await this._put(PROJECTS_STORE, project)
    return project
  }

  async getProject(projectId: string): Promise<Project | null> {
    return this._get<Project>(PROJECTS_STORE, projectId)
  }

  async listProjects(): Promise<Project[]> {
    const all = await this._getAll<Project>(PROJECTS_STORE)
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Saves `project` as the mirror of its Place, unless that would take a frame away from a newer one.
   * Read and write are one transaction, so another tab cannot slip a calibration in between. The
   * frame and revision of the record being replaced are kept when its revision is higher than the
   * incoming copy's, and the history of the frames it replaced (`frameHistory`) stays with the frame; the
   * georeference and its version are kept the same way, by their own version (`georefVersion`). Every other
   * field is the incoming copy's. The server writes all five, and the mirror holds what it last said (a frame
   * the phone has only made waits in `pendingFrame`), so a copy that is behind on one of them is a stale copy
   * and not an edit.
   *
   * `authoritative` is for a copy that is the server's own answer (a saved frame, or the frame a refused write
   * lost to). The server is the one place a revision is counted, so what it says wins even when its revision is
   * lower than the mirror's: a registry restored from a backup is behind the phones that read it before, and a
   * guard that kept the higher number would leave them on a frame the server no longer holds.
   */
  async updateProject(project: Project, options: { authoritative?: boolean } = {}): Promise<void> {
    project.updatedAt = Date.now()
    await this._modify<Project>(PROJECTS_STORE, project.projectId, (existing) => {
      if (options.authoritative || !existing) return { write: project }
      return { write: keepNewerFromServer(existing, project) }
    })
  }

  async deleteProject(projectId: string): Promise<void> {
    const scans = await this.listScans(projectId)
    for (const s of scans) await this._delete(SCANS_STORE, s.scanId)
    await this._delete(PENDING_FRAME_STORE, projectId)
    await this._delete(PROJECTS_STORE, projectId)
  }

  /** Add a floor to an existing project */
  async addFloor(projectId: string, name: string, level: number): Promise<Floor | null> {
    const project = await this.getProject(projectId)
    if (!project) return null
    const floor: Floor = { floorId: `floor-${Date.now()}`, name, level, rooms: [] }
    project.floors.push(floor)
    project.floors.sort((a, b) => a.level - b.level)
    await this.updateProject(project)
    return floor
  }

  /** Add a room to a floor on an existing project */
  async addRoom(projectId: string, floorId: string, name: string, zone?: string): Promise<Room | null> {
    const project = await this.getProject(projectId)
    if (!project) return null
    const floor = project.floors.find(f => f.floorId === floorId)
    if (!floor) return null
    const room: Room = { roomId: `room-${Date.now()}`, name, zone }
    floor.rooms.push(room)
    await this.updateProject(project)
    return room
  }

  // ── Scan CRUD ─────────────────────────────────────────────────────────────────

  async addScan(entry: Omit<ScanEntry, 'scanId'>): Promise<ScanEntry> {
    const scan: ScanEntry = {
      ...entry,
      scanId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }
    // Without a database (an upgrade another tab is holding up, or a browser that refused one) the entry is
    // not kept, and the scan still goes to the server: this is bookkeeping, and an export that waits on it
    // would lose the scan to a store that is only a local list.
    if (this.db) await this._put(SCANS_STORE, scan)
    return scan
  }

  async updateScan(scan: ScanEntry): Promise<void> {
    if (this.db) await this._put(SCANS_STORE, scan)
  }

  async getScan(scanId: string): Promise<ScanEntry | null> {
    return this._get<ScanEntry>(SCANS_STORE, scanId)
  }

  async listScans(projectId: string | null): Promise<ScanEntry[]> {
    if (!this.db) return []
    // `null` is not a valid IndexedDB key: a scan with projectId: null never
    // gets an entry in the byProject index at all (the spec skips index entries
    // for invalid key-path values), so it can never be found through it, and
    // passing `null` as the index query is itself invalid. Unassigned scans
    // therefore need a full-store scan, not the index.
    if (projectId === null) {
      const all = await this._getAll<ScanEntry>(SCANS_STORE)
      return all.filter(scan => scan.projectId === null).sort((a, b) => b.capturedAt - a.capturedAt)
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(SCANS_STORE, 'readonly')
      const req = tx.objectStore(SCANS_STORE).index('byProject').getAll(projectId)
      req.onsuccess = () => resolve((req.result as ScanEntry[]).sort((a, b) => b.capturedAt - a.capturedAt))
      req.onerror  = () => reject(req.error)
    })
  }

  async getScanBySession(sessionId: string): Promise<ScanEntry | null> {
    if (!this.db) return null
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(SCANS_STORE, 'readonly')
      const req = tx.objectStore(SCANS_STORE).index('bySession').getAll(sessionId)
      req.onsuccess = () => resolve((req.result as ScanEntry[])[0] ?? null)
      req.onerror  = () => reject(req.error)
    })
  }

  async deleteScan(scanId: string): Promise<void> {
    await this._delete(SCANS_STORE, scanId)
  }

  // ── Calibration reference photos (ticket 0007) ────────────────────────────────

  /**
   * Store one marker's reference photo. Keyed by `localKey`, so re-calibrating
   * a Place with the same key **replaces** rather than appends — which is what
   * the ticket requires, and why {@link referencePhotoKey} derives the key from
   * the Place and the marker's role rather than from a timestamp.
   */
  async putReferencePhoto(record: ReferencePhotoRecord): Promise<void> {
    await this._put(REFERENCE_PHOTOS_STORE, record)
  }

  async getReferencePhoto(localKey: string): Promise<ReferencePhotoRecord | null> {
    return this._get<ReferencePhotoRecord>(REFERENCE_PHOTOS_STORE, localKey)
  }

  async listReferencePhotos(projectId: string): Promise<ReferencePhotoRecord[]> {
    if (!this.db) return []
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(REFERENCE_PHOTOS_STORE, 'readonly')
      const req = tx.objectStore(REFERENCE_PHOTOS_STORE).index('byProject').getAll(projectId)
      req.onsuccess = () => resolve(req.result as ReferencePhotoRecord[])
      req.onerror  = () => reject(req.error)
    })
  }

  async deleteReferencePhoto(localKey: string): Promise<void> {
    await this._delete(REFERENCE_PHOTOS_STORE, localKey)
  }

  // ── Frames not yet confirmed by the server ────────────────────────────────────

  /** Records the intent to save a frame. A Place has one: a newer calibration replaces the row. */
  async putPendingFrame(record: PendingFrameRecord): Promise<void> {
    await this._modify<PendingFrameRecord>(PENDING_FRAME_STORE, record.projectId, () => ({ write: record }))
  }

  async getPendingFrame(projectId: string): Promise<PendingFrameRecord | null> {
    return this._get<PendingFrameRecord>(PENDING_FRAME_STORE, projectId)
  }

  async listPendingFrames(): Promise<PendingFrameRecord[]> {
    return this._getAll<PendingFrameRecord>(PENDING_FRAME_STORE)
  }

  /**
   * Changes the row only while it still holds the frame made at `frameCreatedAt`. A retry that was
   * waiting on the network when the person calibrated again must not write its answer over the
   * newer row. Returns whether the row was changed.
   */
  async patchPendingFrame(
    projectId: string,
    frameCreatedAt: string,
    patch: Partial<PendingFrameRecord> | ((existing: PendingFrameRecord) => Partial<PendingFrameRecord>),
  ): Promise<boolean> {
    return this._modify<PendingFrameRecord>(PENDING_FRAME_STORE, projectId, (existing) => {
      if (!existing || existing.frame.createdAt !== frameCreatedAt) return undefined
      const changes = typeof patch === 'function' ? patch(existing) : patch
      return { write: { ...existing, ...changes, projectId } }
    })
  }

  /** Removes the row only while it still holds the frame made at `frameCreatedAt`. Returns whether it did. */
  async clearPendingFrame(projectId: string, frameCreatedAt: string): Promise<boolean> {
    return this._modify<PendingFrameRecord>(PENDING_FRAME_STORE, projectId, (existing) =>
      existing && existing.frame.createdAt === frameCreatedAt ? { remove: true } : undefined,
    )
  }

  // ── Private IDB helpers ────────────────────────────────────────────────────────

  /**
   * Read, decide, write: one transaction. `decide` sees the record now stored (or null) and answers
   * with the record to write, `{ remove: true }`, or nothing for no change. Resolves with whether it
   * changed anything, once the transaction has committed rather than when its last request answered.
   */
  private _modify<T>(
    store: string,
    key: string,
    decide: (existing: T | null) => { write: T } | { remove: true } | undefined,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return }
      const tx = this.db.transaction(store, 'readwrite')
      const objects = tx.objectStore(store)
      let changed = false
      const read = objects.get(key)
      read.onsuccess = () => {
        const outcome = decide((read.result ?? null) as T | null)
        if (!outcome) return
        changed = true
        if ('write' in outcome) objects.put(outcome.write)
        else objects.delete(key)
      }
      tx.oncomplete = () => resolve(changed)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB request failed'))
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
    })
  }

  private _put(store: string, record: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return }
      const tx = this.db.transaction(store, 'readwrite')
      const req = tx.objectStore(store).put(record)
      req.onsuccess = () => resolve()
      req.onerror  = () => reject(req.error)
    })
  }

  private _get<T>(store: string, key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve(null); return }
      const tx = this.db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(key)
      req.onsuccess = () => resolve((req.result ?? null) as T | null)
      req.onerror  = () => reject(req.error)
    })
  }

  private _getAll<T>(store: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve([]); return }
      const tx = this.db.transaction(store, 'readonly')
      const req = tx.objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result as T[])
      req.onerror  = () => reject(req.error)
    })
  }

  private _delete(store: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve(); return }
      const tx = this.db.transaction(store, 'readwrite')
      const req = tx.objectStore(store).delete(key)
      req.onsuccess = () => resolve()
      req.onerror  = () => reject(req.error)
    })
  }
}
