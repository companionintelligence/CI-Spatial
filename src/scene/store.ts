/**
 * Scene store — reactive accumulator of world detections.
 *
 * Backed by IndexedDB for session persistence across page reloads.
 * Subscribers are notified synchronously after every mutation.
 *
 * Schema (IndexedDB):
 *   DB: 'ci-xr-scan'  version: 2
 *   objectStore: 'sessions'  keyPath: 'sessionId'
 *     Each record: { sessionId, startedAt, detections: StoredDetection[] }
 *   objectStore: 'captures'  keyPath: 'captureId'
 *     Each record: CaptureRecord — one captured frame, see below
 *
 * Captures live in their own object store rather than on the session record
 * because persist() rewrites the *entire* session record on every mutation.
 * A frame held inside that record would be rewritten on every subsequent
 * capture, so capture #50 would push 50 x ~140 KB through IndexedDB on one
 * shutter press. One record per capture keeps each write O(1).
 */
import type { WorldDetection } from '../spatial/resolver'
// Explicit .ts extension so Node's ESM loader can resolve this when detection_store.test.ts
// imports the store directly — the same reason src/shared/test-homes.ts:10 carries one.
import { SCAN_DB_NAME } from '../shared/storage-keys.ts'
import { isServerSessionId, newLocalSessionId } from '../shared/session-id.ts'
import { quotaStatus as sharedQuotaStatus } from '../shared/storage-quota.ts'
// Type-only, so it is erased before Node's loader sees it and needs no .ts
// extension. Reusing CaptureResult's pose is the point: a capture record stores
// the pose the capture module already produced, it does not declare a new one.
import type { CaptureResult } from '../capture/capture'
// Type-only. Wave 05 ticket 0004 (docs/factory/05-on-device-inference/
// 0004-ungate-toggle-and-fallback-policy.md) — ADR 0001 forbids a parallel
// provenance record, so `CaptureRecord.engine` below extends the capture
// record wave 04 ticket 0003 already added instead of introducing one.
import type { InferMode } from '../inference/router'

export interface StoredDetection extends WorldDetection {
  thumbnailDataUrl?: string
}

export function normalizeStoredDetection(det: StoredDetection, sessionId: string): StoredDetection {
  const captureTimestamp = typeof det.captureTimestamp === 'number' ? det.captureTimestamp : Date.now()
  return {
    ...det,
    detectionId: det.detectionId ?? `det-${sessionId}-${captureTimestamp}-${stableDetectionKey(det).slice(0, 8)}`,
    lastSeenAt: det.lastSeenAt ?? captureTimestamp,
    observations: Array.isArray(det.observations) && det.observations.length > 0
      ? det.observations
      : [{
        observationId: `obs-${sessionId}-${captureTimestamp}-${stableDetectionKey(det).slice(0, 8)}`,
        sessionId,
        label: det.label,
        confidence: det.confidence,
        description: det.description,
        bbox: det.bbox,
        worldPos: det.worldPos,
        worldRot: det.worldRot,
        captureTimestamp,
        ...(det.captureIndex !== undefined ? { captureIndex: det.captureIndex } : {}),
      }],
  }
}

function stableDetectionKey(det: Pick<WorldDetection, 'label' | 'worldPos'>): string {
  return `${det.label}-${det.worldPos.x.toFixed(2)}-${det.worldPos.y.toFixed(2)}-${det.worldPos.z.toFixed(2)}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
}

/**
 * Where a capture is in its lifecycle.
 *
 * 'pending' is the state this whole store exists for: the frame is durably
 * written but its inference has not resolved. Nothing evicts a pending record.
 */
export type CaptureStatus = 'pending' | 'inferred' | 'failed'

/**
 * One captured frame — the expensive, unrepeatable half of a capture.
 *
 * Written before inference runs, so an inference failure costs a label rather
 * than the photograph. Detections are attached afterwards by key; their bodies
 * stay in the 'sessions' store where they already live.
 *
 * `blob` is nullable because the frame can be dropped while the record is kept:
 * the retention budget reclaims old frames, and a frame whose inference failed
 * on its own quality is dropped outright rather than held for a retry that would
 * fail the same way. Such a capture still knows its index, pose, timestamp and
 * detections, it just cannot be re-inferred or re-examined. `frameDropped` says
 * which of the two happened, so a missing frame always explains itself.
 */
export interface CaptureRecord {
  captureId: string
  sessionId: string
  /** Matches WorldDetection.captureIndex — the existing capture<->detection link */
  captureIndex: number
  timestamp: number
  pose: CaptureResult['pose']
  blob: Blob | null
  /** Recorded at write time so the byte budget still sums after `blob` is gone */
  byteSize: number
  status: CaptureStatus
  /** `label:bucket(worldPos)` keys into the detections map; no detection data duplicated */
  detectionKeys: string[]
  /**
   * Which inference path this capture was sent to — 'server' or 'webgpu'.
   * Wave 05 ticket 0004: recorded on both success and failure (the field
   * names what was *attempted*, not just what succeeded), which is what
   * makes a mixed-provenance scan legible instead of opaque. Optional
   * because captures written before this ticket landed have no such field.
   */
  engine?: InferMode
  /** Why inference failed, on the failed path */
  error?: string
  /**
   * Why `blob` is gone, when it is. 'quality' — the frame itself was the
   * problem. 'budget' — the retention budget reclaimed it. Absent while the
   * frame is still held.
   */
  frameDropped?: 'quality' | 'budget'
}

export interface Session {
  sessionId: string
  startedAt: number
  detections: Map<string, StoredDetection>
}

type ChangeListener = (detections: Map<string, StoredDetection>, selected: Set<string>) => void

const DB_NAME = SCAN_DB_NAME
const STORE_NAME = 'sessions'
const CAPTURES_STORE = 'captures'
const DB_VERSION = 2   // 1 -> 2 adds CAPTURES_STORE; additive, existing records still open
const OPEN_TIMEOUT_MS = 5000 // give up on IndexedDB after 5 s (private mode, hung backends)

// Capture retention bounds, modelled on the offline queue's MAX_QUEUE_ITEMS /
// MAX_QUEUE_AGE_MS in public/sw.js. One deliberate difference: that queue avoids
// a byte budget because summing one would mean reading every queued body into
// memory. Here byteSize is already on the record, so a byte budget is free — and
// bytes, not item count, are what storage quota actually measures.
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024      // release blobs past 64 MB retained
const MAX_CAPTURE_AGE_MS = 7 * 24 * 60 * 60 * 1000  // release blobs older than 7 days
export const MAX_CAPTURE_ITEMS = 512            // delete whole records past this many

/**
 * Eviction order. An 'inferred' capture has already yielded its detections, so
 * releasing it costs diagnosis, not data — those go first. 'failed' captures are
 * the evidence this store exists to preserve, so they go only once no inferred
 * frame is left. 'pending' ranks last and is filtered out before it can ever be
 * reached: dropping a frame whose inference has not resolved is the original bug.
 */
const EVICT_RANK: Record<CaptureStatus, number> = { inferred: 0, failed: 1, pending: 2 }

export class DetectionStore {
  private _sessionId: string
  private _startedAt: number
  private _detections: Map<string, StoredDetection> = new Map()
  private _selected: Set<string> = new Set()
  private _captures: Map<string, CaptureRecord> = new Map()
  private listeners: Set<ChangeListener> = new Set()
  private db: IDBDatabase | null = null

  constructor() {
    // Local until a server session exists. The old `session-${Date.now()}` was
    // minted here too, but looked like a server id and was accepted as one —
    // so every scan named a keyframe directory that had never been created.
    // `local-…` is deliberately a shape SESSION_ID_RE rejects.
    this._sessionId = newLocalSessionId()
    this._startedAt = Date.now()
  }

  /**
   * The session every write lands in.
   *
   * Not readonly any more: resuming or loading a stored session has to move
   * this too. When it didn't, restored detections were written back under a
   * fresh id — the original record stayed behind with the pre-edit data and
   * the reload silently forked into two half-sessions.
   *
   * It may be a `local-…` id (no server session) or a `sess-…` one adopted
   * from the server — see {@link adoptServerSession}. Use
   * `isServerSessionId()` before treating it as a keyframe-directory name;
   * anything persisted server-side must record `null` rather than a local id.
   */
  get sessionId(): string {
    return this._sessionId
  }

  /**
   * Take the server's capture-session id as this store's identity, carrying
   * the existing record over to it.
   *
   * Called when `KeyframeStreamer.start()` opens a session — which can happen
   * after captures already exist under the local id. Those captures belong to
   * the same walkthrough, so the record is *renamed*, not forked: everything
   * already written is re-keyed to the server id and the local record is
   * dropped. Not doing this is the fork bug the `sessionId` setter comment
   * above describes, and it would strand every capture taken before the user
   * pressed the stream button.
   *
   * A no-op when the id is unchanged, and refuses ids that are not
   * server-minted so a local id can never masquerade as one.
   */
  async adoptServerSession(sessionId: string): Promise<void> {
    if (!isServerSessionId(sessionId) || sessionId === this._sessionId) return
    const previous = this._sessionId
    this._sessionId = sessionId

    // In-memory first, and unconditionally: the live capture records reference
    // the session by value, and they must follow it even when IndexedDB never
    // opened. Persisting is the optional half, not the re-keying.
    const moved: CaptureRecord[] = []
    for (const [key, rec] of this._captures) {
      if (rec.sessionId !== previous) continue
      const next = { ...rec, sessionId }
      this._captures.set(key, next)
      moved.push(next)
    }

    if (!this.db) return
    // Captures before the session record: a crash between the two leaves
    // captures pointing at a session row that is about to be written, rather
    // than a session row whose captures cannot be found.
    for (const rec of moved) {
      await idbPut(this.db, CAPTURES_STORE, rec).catch(() => {})
    }
    await this.persist()
    await idbDelete(this.db, STORE_NAME, previous).catch(() => {})
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
    if (this.db) await this.loadCaptures()
  }

  /**
   * Storage usage/quota via the StorageManager API; null when unavailable.
   * Delegates to src/shared/storage-quota.ts — see that file's header for
   * why this is shared rather than reimplemented (ADR 0001).
   */
  async quotaStatus(): Promise<{ usage: number; quota: number } | null> {
    return sharedQuotaStatus()
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
        // The freshly captured thumbnail wins. The previous one is kept only when this
        // capture produced none for this key — otherwise a detection resumed from an
        // earlier session pins its old image forever, because the key is
        // `label:bucket(worldPos)` (main.ts) and every re-capture of the same object
        // in the same place matches it.
        thumbnailDataUrl: thumbnails.get(key) ?? existing?.thumbnailDataUrl,
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

  /**
   * Clear this session's detections and captures, and re-persist.
   *
   * The frames go too. Leaving them would strand tens of MB in IndexedDB behind
   * a session the user has just emptied, with no surface left that can reach
   * them — the eviction budget would eventually reclaim it, days later.
   */
  async clear(): Promise<void> {
    this._detections.clear()
    this._selected.clear()
    await this.dropCapturesForSession(this._sessionId)
    this.notify()
    await this.persist()
  }

  /** Persist the current session even when it has no detections yet. */
  async saveSnapshot(): Promise<void> {
    await this.persist()
  }

  // ── Captures ────────────────────────────────────────────────────────────────
  //
  // A capture is written *before* inference runs, so a failure costs a label
  // rather than the frame. Everything here mirrors how detections are held: an
  // in-memory map that is the source of truth for readers, mirrored to
  // IndexedDB when a db is open and silently skipped when it is not.

  /** Every capture this store knows about, live and restored */
  get captures(): Map<string, CaptureRecord> {
    return this._captures
  }

  /** Look one capture up by id */
  getCapture(captureId: string): CaptureRecord | undefined {
    return this._captures.get(captureId)
  }

  /**
   * The id a capture at this index will be stored under.
   *
   * Derived rather than random so the capture handler can name the record it
   * just fired off without awaiting the write — and so the format lives in one
   * place instead of being re-spelled at the call site.
   */
  captureIdFor(captureIndex: number): string {
    return `${this._sessionId}-c${captureIndex}`
  }

  /**
   * How many of *this session's* captures are in each state, for the summary.
   *
   * Scoped to the live session because the summary is: `_captures` also holds
   * records restored from earlier sessions, and counting those would report a
   * capture total that does not match the scan being exported.
   *
   * This is what stops a failed capture being silently absent: it cannot be a
   * row in the object table, having no labels to put there, but it is counted.
   */
  captureCounts(): {
    total: number; pending: number; inferred: number; failed: number
    unusable: number; retained: number
  } {
    let total = 0, pending = 0, inferred = 0, failed = 0, unusable = 0, retained = 0
    for (const rec of this._captures.values()) {
      if (rec.sessionId !== this._sessionId) continue
      total++
      if (rec.status === 'pending') pending++
      else if (rec.status === 'inferred') inferred++
      else failed++
      if (rec.frameDropped === 'quality') unusable++
      if (rec.blob) retained++
    }
    return { total, pending, inferred, failed, unusable, retained }
  }

  /**
   * Durably store a frame before anything is asked of it.
   *
   * Resolves once the record exists in memory and, if a db is open, on disk.
   * Never rejects: the capture handler calls this without awaiting so the
   * shutter is not blocked on IndexedDB, and an unhandled rejection there would
   * be a second failure mode on the path this is meant to make reliable.
   */
  async putCapture(input: {
    captureIndex: number
    timestamp: number
    pose: CaptureResult['pose']
    blob: Blob
    /**
     * Which engine this capture was sent to. Optional and defaults to
     * 'server' — the pre-ticket-0004 behaviour — so the many existing
     * callers in tests/unit/node/detection_store.test.ts that predate
     * provenance don't need updating for a field they aren't testing.
     */
    engine?: InferMode
  }): Promise<CaptureRecord> {
    const record: CaptureRecord = {
      captureId: this.captureIdFor(input.captureIndex),
      sessionId: this._sessionId,
      captureIndex: input.captureIndex,
      timestamp: input.timestamp,
      pose: input.pose,
      blob: input.blob,
      byteSize: input.blob.size,
      status: 'pending',
      detectionKeys: [],
      engine: input.engine ?? 'server',
    }
    this._captures.set(record.captureId, record)
    await this.persistCapture(record)
    await this.evictCaptures()
    return record
  }

  /**
   * Attach a capture's detections to the record already holding its frame.
   *
   * The success path ends here, so exactly one record exists per capture — the
   * one putCapture() wrote. Passing no keys is a real outcome (the model found
   * nothing) and still resolves the record out of 'pending'.
   */
  async attachDetections(captureId: string, detectionKeys: string[]): Promise<void> {
    const record = this._captures.get(captureId)
    if (!record) return
    record.detectionKeys = detectionKeys
    record.status = 'inferred'
    delete record.error
    await this.persistCapture(record)
    await this.evictCaptures()
  }

  /**
   * Mark a capture's inference as failed, keeping the frame.
   *
   * The record stays complete and inspectable — that is the entire point. A
   * failed capture is also the last thing evicted, after every inferred one,
   * because it is the only evidence of what went wrong.
   *
   * Whether the *image* is worth keeping is a separate question the caller
   * answers with discardFrame(): a frame that failed on a server or engine error
   * can be re-inferred once that is fixed, one that failed on its own quality
   * cannot.
   */
  async markCaptureFailed(captureId: string, error: string): Promise<void> {
    const record = this._captures.get(captureId)
    if (!record) return
    record.status = 'failed'
    record.error = error
    await this.persistCapture(record)
  }

  /** Restore captures from IndexedDB. Called by open(); failure is non-fatal. */
  private async loadCaptures(): Promise<void> {
    if (!this.db) return
    try {
      const records = await idbGetAll<CaptureRecord>(this.db, CAPTURES_STORE)
      records.sort((a, b) => a.timestamp - b.timestamp)
      for (const rec of records) this._captures.set(rec.captureId, rec)
    } catch {
      console.warn('[store] could not restore captures')
    }
  }

  /** Mirror one capture record to IndexedDB. No-op without a db, never throws. */
  private async persistCapture(record: CaptureRecord): Promise<void> {
    if (!this.db) return
    try {
      await idbPut(this.db, CAPTURES_STORE, record)
    } catch (e) {
      // Quota exhaustion lands here. The in-memory record survives, so the
      // capture is still usable this session — it just will not outlive a reload.
      console.warn('[store] capture not persisted:', e)
    }
  }

  /**
   * Hold the retained frames inside their budget.
   *
   * Two tiers: blobs are released (record kept) against an age and byte budget,
   * then whole records are deleted against an item cap. Both walk 'inferred'
   * before 'failed' and neither touches 'pending' — so a run of captures whose
   * inference is all still in flight sits over budget rather than dropping one.
   * That is deliberate; a pending frame is the thing being protected.
   */
  private async evictCaptures(): Promise<void> {
    const now = Date.now()
    const evictable = (): CaptureRecord[] =>
      [...this._captures.values()]
        .filter((r) => r.status !== 'pending')
        .sort((a, b) => EVICT_RANK[a.status] - EVICT_RANK[b.status] || a.timestamp - b.timestamp)

    // Age — a frame this old is not plausibly going to be re-inferred
    for (const rec of evictable()) {
      if (rec.blob && now - rec.timestamp > MAX_CAPTURE_AGE_MS) {
        await this.discardFrame(rec.captureId, 'budget')
      }
    }

    // Bytes — release oldest inferred frames until back under budget
    let retained = 0
    for (const rec of this._captures.values()) if (rec.blob) retained += rec.byteSize
    if (retained > MAX_CAPTURE_BYTES) {
      for (const rec of evictable()) {
        if (retained <= MAX_CAPTURE_BYTES) break
        if (!rec.blob) continue
        retained -= rec.byteSize
        await this.discardFrame(rec.captureId, 'budget')
      }
    }

    // Items — a blob-less record is tiny, but not free
    let over = this._captures.size - MAX_CAPTURE_ITEMS
    if (over > 0) {
      for (const rec of evictable()) {
        if (over <= 0) break
        this._captures.delete(rec.captureId)
        await this.deleteCaptureRecord(rec.captureId)
        over--
      }
    }
  }

  /**
   * Drop a capture's image, keeping everything that describes it.
   *
   * 'quality' — the frame itself was the problem, so a retry would fail the same
   * way and holding the JPEG buys nothing. 'budget' — the retention budget
   * reclaimed it. Either way the record survives, so the capture is still
   * counted and still explains itself.
   */
  async discardFrame(captureId: string, reason: 'quality' | 'budget'): Promise<void> {
    const record = this._captures.get(captureId)
    if (!record?.blob) return
    record.blob = null
    record.frameDropped = reason
    await this.persistCapture(record)
  }

  private async deleteCaptureRecord(captureId: string): Promise<void> {
    if (!this.db) return
    try {
      await idbDelete(this.db, CAPTURES_STORE, captureId)
    } catch { /* the in-memory delete already happened; disk catches up next open */ }
  }

  /** Forget every capture belonging to a session, blobs included */
  private async dropCapturesForSession(sessionId: string): Promise<void> {
    for (const rec of [...this._captures.values()]) {
      if (rec.sessionId !== sessionId) continue
      this._captures.delete(rec.captureId)
      await this.deleteCaptureRecord(rec.captureId)
    }
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
   * The most recent record wins even when it is empty. An empty record now
   * only exists because the user pressed "Clear session" — boot no longer
   * writes one — so skipping empties would resume the scan *before* the one
   * they just cleared, handing back an older scan they never asked for.
   */
  async resumeLatestSession(): Promise<number> {
    if (!this.db) return 0
    const sessions = await getAllSessions(this.db)
    const latest = sessions.sort((a, b) => b.startedAt - a.startedAt)[0]
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
    return new Map(
      (record.detections as Array<[string, StoredDetection]>)
        .map(([key, det]) => [key, normalizeStoredDetection(det, record.sessionId)]),
    )
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

  /** Delete a session from IndexedDB, along with the frames it captured */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.db) return
    await this.dropCapturesForSession(sessionId)
    await idbDelete(this.db, STORE_NAME, sessionId)
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
    this._detections = new Map(
      (record.detections as Array<[string, StoredDetection]>)
        .map(([key, det]) => [key, normalizeStoredDetection(det, record.sessionId)]),
    )
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
    await idbPut(this.db, STORE_NAME, record)
  }
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      // Additive only. On the 1 -> 2 upgrade 'sessions' already exists and is
      // left exactly as it is — every stored session must keep opening.
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(CAPTURES_STORE)) {
        db.createObjectStore(CAPTURES_STORE, { keyPath: 'captureId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// These three take the object store by name rather than closing over
// STORE_NAME, so 'captures' reuses them instead of getting a second, near
// identical set of helpers alongside.

function idbPut(db: IDBDatabase, storeName: string, record: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).put(record)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

function getAllSessions(db: IDBDatabase): Promise<
  Array<{ sessionId: string; startedAt: number; detections: unknown[] }>
> {
  return idbGetAll<{ sessionId: string; startedAt: number; detections: unknown[] }>(db, STORE_NAME)
}

function idbDelete(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
