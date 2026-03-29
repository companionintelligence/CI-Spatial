/**
 * Scene store — reactive accumulator of world detections.
 *
 * Backed by IndexedDB for session persistence across page reloads.
 * Subscribers are notified synchronously after every mutation.
 *
 * Schema (IndexedDB):
 *   DB: 'ci-xr-scan'  version: 1
 *   objectStore: 'sessions'  keyPath: 'sessionId'
 *   Each record: { sessionId, startedAt, detections: StoredDetection[] }
 */
import type { WorldDetection } from '../spatial/resolver'

export interface StoredDetection extends WorldDetection {
  thumbnailDataUrl?: string
}

export interface Session {
  sessionId: string
  startedAt: number
  detections: Map<string, StoredDetection>
}

type ChangeListener = (detections: Map<string, StoredDetection>) => void

const DB_NAME = 'ci-xr-scan'
const STORE_NAME = 'sessions'
const DB_VERSION = 1

export class DetectionStore {
  readonly sessionId: string
  readonly startedAt: number
  private _detections: Map<string, StoredDetection> = new Map()
  private listeners: Set<ChangeListener> = new Set()
  private db: IDBDatabase | null = null

  constructor() {
    this.sessionId = `session-${Date.now()}`
    this.startedAt = Date.now()
  }

  /** Open (or create) the IndexedDB.  Call once before using the store. */
  async open(): Promise<void> {
    this.db = await openDB()
  }

  get detections(): Map<string, StoredDetection> {
    return this._detections
  }

  /** Add or update detections; persists to IndexedDB and notifies listeners */
  async upsert(incoming: Map<string, WorldDetection>, thumbnails: Map<string, string>): Promise<void> {
    for (const [key, det] of incoming) {
      const existing = this._detections.get(key)
      this._detections.set(key, {
        ...det,
        thumbnailDataUrl: existing?.thumbnailDataUrl ?? thumbnails.get(key),
      })
    }
    this.notify()
    await this.persist()
  }

  /** Clear this session's detections and re-persist */
  async clear(): Promise<void> {
    this._detections.clear()
    this.notify()
    await this.persist()
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Load most-recent session from IndexedDB into this store */
  async loadLatestSession(): Promise<void> {
    if (!this.db) return
    const sessions = await getAllSessions(this.db)
    if (!sessions.length) return
    const latest = sessions.sort((a, b) => b.startedAt - a.startedAt)[0]
    this._detections = new Map(
      (latest.detections as Array<[string, StoredDetection]>),
    )
    this.notify()
  }

  /** Return all sessions stored in IndexedDB */
  async allSessions(): Promise<Array<{ sessionId: string; startedAt: number; count: number }>> {
    if (!this.db) return []
    const sessions = await getAllSessions(this.db)
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      count: (s.detections as unknown[]).length,
    }))
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn(this._detections))
  }

  private async persist(): Promise<void> {
    if (!this.db) return
    const record = {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      detections: [...this._detections.entries()],
    }
    await idbPut(this.db, record)
  }
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, record: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).put(record)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function getAllSessions(db: IDBDatabase): Promise<
  Array<{ sessionId: string; startedAt: number; detections: unknown[] }>
> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as Array<{ sessionId: string; startedAt: number; detections: unknown[] }>)
    req.onerror = () => reject(req.error)
  })
}
