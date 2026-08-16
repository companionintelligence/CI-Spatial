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
import { SCAN_DB_NAME } from '../shared/storage-keys'

export interface StoredDetection extends WorldDetection {
  thumbnailDataUrl?: string
}

export interface Session {
  sessionId: string
  startedAt: number
  detections: Map<string, StoredDetection>
}

type ChangeListener = (detections: Map<string, StoredDetection>, selected: Set<string>) => void

const DB_NAME = SCAN_DB_NAME
const STORE_NAME = 'sessions'
const DB_VERSION = 1
const OPEN_TIMEOUT_MS = 5000 // give up on IndexedDB after 5 s (private mode, hung backends)

export class DetectionStore {
  readonly sessionId: string
  readonly startedAt: number
  private _detections: Map<string, StoredDetection> = new Map()
  private _selected: Set<string> = new Set()
  private listeners: Set<ChangeListener> = new Set()
  private db: IDBDatabase | null = null

  constructor() {
    this.sessionId = `session-${Date.now()}`
    this.startedAt = Date.now()
  }

  /** Open (or create) the IndexedDB.  Call once before using the store. */
  async open(): Promise<void> {
    try {
      this.db = await Promise.race([
        openDB(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS),
        ),
      ])
    } catch {
      console.warn('[store] IndexedDB unavailable — session persistence disabled')
      this.db = null
    }
  }

  /** Storage usage/quota via the StorageManager API; null when unavailable */
  async quotaStatus(): Promise<{ usage: number; quota: number } | null> {
    if (!navigator.storage?.estimate) return null
    try {
      const { usage, quota } = await navigator.storage.estimate()
      if (usage === undefined || quota === undefined) return null
      return { usage, quota }
    } catch {
      return null
    }
  }

  get detections(): Map<string, StoredDetection> {
    return this._detections
  }

  get selected(): Set<string> {
    return this._selected
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

  /** Patch an existing detection's mutable fields (label, description) */
  async updateDetection(key: string, patch: Partial<Pick<StoredDetection, 'label' | 'description'>>): Promise<void> {
    const det = this._detections.get(key)
    if (!det) return
    this._detections.set(key, { ...det, ...patch })
    this.notify()
    await this.persist()
  }

  /** Toggle visual selection for a detection key */
  toggleSelect(key: string): void {
    if (this._selected.has(key)) {
      this._selected.delete(key)
    } else {
      this._selected.add(key)
    }
    this.notify()
  }

  selectAll(): void {
    for (const key of this._detections.keys()) this._selected.add(key)
    this.notify()
  }

  deselectAll(): void {
    this._selected.clear()
    this.notify()
  }

  /** Clear this session's detections and re-persist */
  async clear(): Promise<void> {
    this._detections.clear()
    this._selected.clear()
    this.notify()
    await this.persist()
  }

  /** Persist the current session even when it has no detections yet. */
  async saveSnapshot(): Promise<void> {
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

  /** Load a specific session from IndexedDB into this store (replaces current view) */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.db) return false
    const sessions = await getAllSessions(this.db)
    const record = sessions.find((s) => s.sessionId === sessionId)
    if (!record) return false
    this._detections = new Map(record.detections as Array<[string, StoredDetection]>)
    this._selected.clear()
    this.notify()
    return true
  }

  /** Delete a session from IndexedDB */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.db) return
    await idbDelete(this.db, sessionId)
    // If we just deleted the current session, clear current view
    if (sessionId === this.sessionId) {
      this._detections.clear()
      this.notify()
    }
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn(this._detections, this._selected))
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

function idbDelete(db: IDBDatabase, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).delete(sessionId)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
