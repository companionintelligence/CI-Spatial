/**
 * ProjectStore — projects, floors, rooms, and scan assignments.
 *
 * Stored in its own IndexedDB database ('ci-xr-projects', v1) so it does not
 * conflict with the per-session detection store schema.
 *
 * Schema:
 *   objectStore 'projects'  keyPath: 'projectId'
 *   objectStore 'scans'     keyPath: 'scanId'
 *                           index 'byProject' on 'projectId'
 *                           index 'bySession' on 'sessionId'
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

import type { Floor, Project, Room, ScanEntry } from '../world/types'

// ── DB constants ───────────────────────────────────────────────────────────────

const DB_NAME = 'ci-xr-projects'
const DB_VERSION = 1
const PROJECTS_STORE = 'projects'
const SCANS_STORE = 'scans'

// ── Store class ────────────────────────────────────────────────────────────────

export class ProjectStore {
  private db: IDBDatabase | null = null

  async open(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
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
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror  = () => reject(req.error)
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

  async updateProject(project: Project): Promise<void> {
    project.updatedAt = Date.now()
    await this._put(PROJECTS_STORE, project)
  }

  async deleteProject(projectId: string): Promise<void> {
    const scans = await this.listScans(projectId)
    for (const s of scans) await this._delete(SCANS_STORE, s.scanId)
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
    await this._put(SCANS_STORE, scan)
    return scan
  }

  async updateScan(scan: ScanEntry): Promise<void> {
    await this._put(SCANS_STORE, scan)
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

  // ── Private IDB helpers ────────────────────────────────────────────────────────

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
