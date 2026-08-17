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
  private _sessionId: string
  private _startedAt: number
  private _detections: Map<string, StoredDetection> = new Map()
  private _selected: Set<string> = new Set()
  private listeners: Set<ChangeListener> = new Set()
  private db: IDBDatabase | null = null

  constructor() {
    this._sessionId = `session-${Date.now()}`
    this._startedAt = Date.now()
  }

  /**
   * The session every write lands in.
   *
   * Not readonly any more: resuming or loading a stored session has to move
   * this too. When it didn't, restored detections were written back under a
   * fresh id — the original record stayed behind with the pre-edit data and
   * the reload silently forked into two half-sessions.
   */
  get sessionId(): string {
    return this._sessionId
  }

  get startedAt(): number {
    return this._startedAt
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

  /**
   * Continue the most recent non-empty session, so a reload doesn't lose the
   * scan. Returns how many detections came back; 0 means there was nothing to
   * resume and this store keeps its own fresh session id.
   *
   * Empty sessions are skipped deliberately — they carry nothing to restore,
   * and resuming one would only pin the id of a session that never held
   * anything.
   */
  async resumeLatestSession(): Promise<number> {
    if (!this.db) return 0
    const sessions = await getAllSessions(this.db)
    const latest = sessions
      .filter((s) => (s.detections as unknown[]).length > 0)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!latest) return 0

    this.adopt(latest)
    this.notify()
    return this._detections.size
  }

  /**
   * Read a stored session without disturbing the live one.
   *
   * The history drawer needs this to preview a past session. Doing it by
   * loading into the live store and putting the old data back afterwards let
   * any capture landing mid-preview persist the *previewed* session's
   * detections under the active id, and dropped the user's selection on the
   * floor every time a row was expanded.
   */
  async readSession(sessionId: string): Promise<Map<string, StoredDetection> | null> {
    if (!this.db) return null
    const sessions = await getAllSessions(this.db)
    const record = sessions.find((s) => s.sessionId === sessionId)
    if (!record) return null
    return new Map(record.detections as Array<[string, StoredDetection]>)
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

  /**
   * Make a stored session the live one — its detections *and* its identity.
   *
   * Adopting the id is what makes a loaded session editable: edits now update
   * the record they came from instead of writing a duplicate under a new id,
   * and callers comparing against `sessionId` (the history drawer's
   * active-session check) start matching.
   *
   * Use readSession() to look at a session without taking it over.
   */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.db) return false
    const sessions = await getAllSessions(this.db)
    const record = sessions.find((s) => s.sessionId === sessionId)
    if (!record) return false
    this.adopt(record)
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

  /** Take over a stored record's data and identity. Callers notify(). */
  private adopt(record: { sessionId: string; startedAt: number; detections: unknown }): void {
    this._sessionId = record.sessionId
    this._startedAt = record.startedAt
    this._detections = new Map(record.detections as Array<[string, StoredDetection]>)
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn(this._detections, this._selected))
  }

  private async persist(): Promise<void> {
    if (!this.db) return
    const record = {
      sessionId: this._sessionId,
      startedAt: this._startedAt,
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
