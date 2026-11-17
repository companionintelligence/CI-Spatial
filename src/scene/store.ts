/**
 * Scene store — reactive accumulator of world detections.
 *
 * Backed by IndexedDB for session persistence across page reloads.
 * Subscribers are notified synchronously after every mutation.
 *
 * Schema (IndexedDB):
 *   DB: 'ci-xr-scan'  version: 3
 *   objectStore: 'sessions'  keyPath: 'sessionId'
 *     Each record: { sessionId, startedAt, detections: StoredDetection[] }
 *   objectStore: 'captures'  keyPath: 'captureId'
 *     Each record: CaptureRecord — one captured frame, see below
 *   objectStore: 'tripod'  keyPath: 'id'
 *     One 'meta' record plus one record per finished tripod spot — see
 *     src/capture/tripod-persistence.ts for what is kept and what is not.
 *
 * Captures live in their own object store rather than on the session record
 * because persist() rewrites the *entire* session record on every mutation.
 * A frame held inside that record would be rewritten on every subsequent
 * capture, so capture #50 would push 50 x ~140 KB through IndexedDB on one
 * shutter press. One record per capture keeps each write O(1).
 *
 * AR runs. A position is only meaningful inside the SLAM frame that produced it, and
 * every page load starts a new frame. So each detection and each capture record carries
 * `arRunId`, the id of the run that placed it (additive and optional: nothing indexes it,
 * so the database version stays 3, and a record from an older build simply has none).
 * `currentRunDetections()` is the one question the pins, the panel, the exports and the
 * counts ask: which stored detections are in the frame this page is showing. One stamped by
 * another run, or by a build that stamped nothing, is not. It is not deleted either: it stays
 * in the record, the history drawer lists it as a previous run, and it is only kept out of
 * every view and export that would put it under this page's calibration.
 */
import type { WorldDetection } from '../spatial/resolver'
// Explicit .ts extension so Node's ESM loader can resolve this when detection_store.test.ts
// imports the store directly — the same reason src/shared/test-homes.ts:10 carries one.
import { SCAN_DB_NAME } from '../shared/storage-keys.ts'
import { isServerSessionId, newLocalSessionId } from '../shared/session-id.ts'
import { newArRunId } from '../shared/ar-run-id.ts'
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
  /**
   * The AR run whose frame `worldPos` is in (src/shared/ar-run-id.ts). Absent on a record written
   * before runs were stamped, and that reads as "some earlier run": see
   * {@link DetectionStore.isCurrentRun}. Stamped by upsert() with the run in progress, never by a caller; a
   * detection that arrives at upsert() already stamped by another run keeps that stamp.
   */
  arRunId?: string
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
  /**
   * `label:bucket(worldPos)` keys into the detections map; no detection data duplicated. A key names
   * a detection only inside the capture's own run (`arRunId` below): a later run can put another
   * detection at the same place and so under the same key.
   */
  detectionKeys: string[]
  /**
   * The AR run whose frame `pose` is in — the same id the capture's detections carry. Absent on a
   * record from a build that stamped no runs, and on one taken before any run was started.
   */
  arRunId?: string
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
/**
 * The tripod path's in-progress capture, so a discarded tab does not cost the
 * operator the spots they have already walked to. ADR 0001: one more store in
 * the database that already exists, not a second database — and the database
 * NAME is frozen (CLAUDE.md "Do not rename"), which adding a store does not
 * touch.
 */
const TRIPOD_STORE = 'tripod'
const DB_VERSION = 3   // 1 -> 2 adds CAPTURES_STORE, 2 -> 3 adds TRIPOD_STORE; additive throughout
const OPEN_TIMEOUT_MS = 5000 // give up on IndexedDB after 5 s (private mode, hung backends)
/**
 * Where an erase or a rename is announced to the other tabs on this origin. Its
 * own name, not the database's: it is never stored, and nothing else in the app
 * listens on it.
 */
const ERASE_CHANNEL = 'ci-xr-scan-erase'

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

/**
 * A session renamed from one server id to another. It travels on the erase
 * channel beside the bare erased-id strings, and the `kind` tag keeps the two apart.
 */
interface RenameNotice {
  kind: 'rename'
  from: string
  to: string
}

function isRenameNotice(data: unknown): data is RenameNotice {
  if (typeof data !== 'object' || data === null) return false
  const notice = data as Partial<RenameNotice>
  return notice.kind === 'rename' && typeof notice.from === 'string' && typeof notice.to === 'string'
}

/**
 * Open one store's end of the erase channel, or null where BroadcastChannel is
 * missing or refuses to open. Then an erase or a rename reaches only this tab.
 *
 * Each store opens its own channel. A BroadcastChannel never delivers to the
 * object that posted, so one shared channel would leave every other store in
 * the page deaf to an erase.
 */
function openEraseChannel(
  onErased: (sessionId: string) => void,
  onRenamed: (from: string, to: string) => void,
): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(ERASE_CHANNEL)
  } catch {
    // The class is there but the channel will not open. Treat it as absent.
    return null
  }
  channel.onmessage = (ev: MessageEvent<unknown>) => {
    const data = ev.data
    if (typeof data === 'string') onErased(data)
    else if (isRenameNotice(data)) onRenamed(data.from, data.to)
  }
  // Node keeps a process alive while a channel is open. Browsers have no unref,
  // so this takes effect only in the Node test runs.
  const handle = channel as unknown as { unref?: () => void }
  handle.unref?.()
  return channel
}

/** A promise settled from outside, for an erase that must be registered as in flight before its first step runs. */
function deferred(): { promise: Promise<void>, resolve: () => void, reject: (err: unknown) => void } {
  let resolve: () => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res()
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Options for {@link DetectionStore}. */
export interface DetectionStoreOptions {
  /**
   * Read on open, then write nothing. The constructor of DetectionStore says what a
   * read-only store does and does not do. The default store is writable.
   */
  readOnly?: boolean
}

export class DetectionStore {
  private _sessionId: string
  private _startedAt: number
  private _detections: Map<string, StoredDetection> = new Map()
  private _selected: Set<string> = new Set()
  private _captures: Map<string, CaptureRecord> = new Map()
  private listeners: Set<ChangeListener> = new Set()
  private db: IDBDatabase | null = null
  /** Fixed at construction. A read-only store writes nothing: see the constructor. */
  private readonly readOnly: boolean
  /**
   * This store's end of the erase channel. Null where BroadcastChannel does not exist or will not open,
   * and always for a read-only store, which neither hears nor announces an erase or a rename.
   */
  private readonly eraseChannel: BroadcastChannel | null
  /** Erases in flight, keyed by session id. A second erase of the same id waits on the first. */
  private readonly erasing = new Map<string, Promise<void>>()
  /**
   * Ids whose record has been erased, here or in another tab. Nothing loads,
   * adopts or writes one of these again. Session ids are never reused, so no
   * session that should load is blocked.
   */
  private readonly erased = new Set<string>()
  /**
   * Session ids this store has seen on disk, by loading them or writing them. A
   * write for one of these is skipped when its record has gone. Either another tab
   * erased it, or another tab moved it to a server id (see persist). A broadcast
   * can arrive a turn late; the missing record cannot.
   */
  private readonly onDisk = new Set<string>()
  /**
   * Set once another tab has moved this store's scan to a server id. A superseded
   * store keeps the state it had and writes nothing more. See isSuperseded.
   */
  private _superseded = false
  /** The server id the scan was moved to, once superseded. An erase of it is still heard here. */
  private movedTo = ''
  /** Called once each, when this store is superseded. See onSuperseded. */
  private readonly supersededListeners = new Set<() => void>()
  /**
   * The AR run this page is in, or null until the AR runtime has started and there is a frame at all.
   * Memory only, on purpose: a run ends with the page, so a stored id must never be taken for the live one.
   */
  private _arRunId: string | null = null
  /**
   * The server session ids that this page's run opened (adoptServerSession, called when keyframe streaming starts).
   * Emptied when the run changes. Memory only, for the same reason as `_arRunId`: a stored session id says nothing
   * about which page opened it, and a resumed one was opened by an earlier page.
   */
  private readonly _serverSessionsOpenedInRun = new Set<string>()

  /**
   * `new DetectionStore({ readOnly: true })` makes a read-only store. It reads on open exactly as a
   * writable one does: its capture records and frames are restored. After that it writes nothing.
   * It makes no IndexedDB record write or delete. Opening an older database runs the same additive
   * schema upgrade a writable store runs, because the reads need its stores. It writes no session
   * record, saves nothing, releases no frame, and never re-keys or supersedes a session. It announces
   * nothing to the other tabs and takes no part in the erase channel, so it keeps what it read until it
   * is opened again. Every write method resolves false, or 0 where it returns a count, and leaves memory
   * as it was. Reads keep working, and loadSession still takes a stored record into memory, since that
   * writes nothing. The default store is writable.
   */
  constructor(options: DetectionStoreOptions = {}) {
    // Local until a server session exists. The old `session-${Date.now()}` was
    // minted here too, but looked like a server id and was accepted as one —
    // so every scan named a keyframe directory that had never been created.
    // `local-…` is deliberately a shape SESSION_ID_RE rejects.
    this._sessionId = newLocalSessionId()
    this._startedAt = Date.now()
    this.readOnly = options.readOnly === true
    this.eraseChannel = this.readOnly
      ? null
      : openEraseChannel(
        (sessionId) => this.applyRemoteErase(sessionId),
        (from, to) => this.applyRemoteRename(from, to),
      )
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
   *
   * Empty (`''`) while no session is live: after the live one is erased, until
   * a capture, a stream or a stored session starts or loads one. Nothing is
   * written under an empty id.
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
   * dropped. Not doing this is the fork bug the `sessionId` comment above
   * describes, and it would strand every capture taken before the user
   * pressed the stream button.
   *
   * This is the only re-key, and only the renaming tab writes it. Another tab that
   * still holds the old id hears of the move (see applyRemoteRename) and is
   * superseded: it keeps its state and writes nothing more. A tab the message never
   * reaches is superseded on its next save, found by start time (see persist).
   *
   * A no-op when the id is unchanged. Refuses ids that are not server-minted, so
   * a local id can never masquerade as one, and ids that are being erased or
   * have been erased. A superseded store refuses too: it has no scan of its own to move.
   * It also refuses, and re-keys nothing, when another tab has already moved the frames it holds.
   */
  async adoptServerSession(sessionId: string): Promise<boolean> {
    // A superseded or read-only store re-keys nothing, under any id.
    if (!this.writable) return false
    // An id being erased, or already erased, is refused: adopting it would write
    // its record back on the next save.
    if (!isServerSessionId(sessionId) || this.isErased(sessionId)) return false
    if (sessionId === this._sessionId) return true
    const previous = this._sessionId
    this._sessionId = sessionId

    // No live scan (the last one was erased): nothing to carry over. Nothing is
    // written here either. The next save writes the adopted id's record, even an
    // empty one (see saveSnapshot).
    if (!previous) {
      this._startedAt = Date.now()
      return this.openedByThisRun(sessionId)
    }

    // In-memory first, and unconditionally: the live capture records reference
    // the session by value, and they must follow it even when IndexedDB never
    // opened. Persisting is the optional half, not the re-keying.
    const moved = this.moveCaptures(previous, sessionId)

    if (!this.db) return this.openedByThisRun(sessionId)
    // Captures before the session record: a crash between the two leaves
    // captures pointing at a session row that is about to be written, rather
    // than a session row whose captures cannot be found. They go in one
    // transaction started before this call returns, so an erase that starts
    // afterwards finds every row already under the new id. The rows are read in that same
    // transaction, and a row another session holds means another tab has moved this scan: the
    // batch is then undone and nothing is re-keyed here (see idbMoveCaptureRows).
    if (moved.length > 0) {
      // An aborted batch (null) wrote nothing, so it is not applied either.
      const outcome = await idbMoveCaptureRows(this.db, moved, previous, sessionId).catch((): null => null)
      if (outcome === null || !outcome.applied) {
        // This store keeps the id and the frames it had. A batch undone because another session owns a row
        // means another tab has moved the scan, and that move supersedes this store. An aborted batch does not.
        this.moveCaptures(sessionId, previous)
        this._sessionId = previous
        if (outcome) this.refusedCaptureRow(previous, outcome.owner)
        return false
      }
    }
    await this.persist()
    await idbDelete(this.db, STORE_NAME, previous).catch(() => {})
    this.onDisk.delete(previous)
    // Not announced when this tab has already erased the new id: the erase reaches the others on its own.
    if (!this.isErased(sessionId)) this.announce({ kind: 'rename', from: previous, to: sessionId })
    return this.openedByThisRun(sessionId)
  }

  /**
   * Note that this page's run opened `sessionId`, now that taking it on has succeeded. Called only on the paths
   * that end in an adopted id: a refused or rolled-back adoption leaves nothing here to undo, and the id that was
   * already live is not marked (see serverSessionOfThisRun).
   */
  private openedByThisRun(sessionId: string): true {
    this._serverSessionsOpenedInRun.add(sessionId)
    return true
  }

  get startedAt(): number {
    return this._startedAt
  }

  /**
   * True once another tab has moved this store's scan to a server id. The renaming
   * tab writes that record and its frames from then on. A superseded store keeps the
   * state it had, and each write method of it resolves to false. A later erase by
   * another tab of the scan it was moved to still clears it here, from memory.
   */
  get isSuperseded(): boolean {
    return this._superseded
  }

  /**
   * False when this store may write nothing: it is read-only, or superseded. Each write method checks
   * this first, so a refused write changes nothing, in memory or on disk.
   */
  private get writable(): boolean {
    return !this.readOnly && !this._superseded
  }

  /**
   * Call `listener` once, when this store becomes superseded. Returns the function
   * that stops it being called.
   */
  onSuperseded(listener: () => void): () => void {
    this.supersededListeners.add(listener)
    return () => {
      this.supersededListeners.delete(listener)
    }
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

  // ── AR runs ─────────────────────────────────────────────────────────────────
  //
  // `detections` is everything the live session's record holds, and the history drawer and the
  // persisted record need exactly that. What the AR view shows, what an export carries and what a
  // count says is the part of it placed by this page's run, because that part is in the frame
  // the live camera and the live calibration are in.

  /** The id of the AR run this page is in, or null until the AR runtime has started. */
  get arRunId(): string | null {
    return this._arRunId
  }

  /**
   * Begin this page's AR run. Call it once the AR runtime has started and there is a frame, and not
   * before: until then no stored detection is in a frame that exists.
   *
   * From here on upsert() stamps what it writes with the run, and the detections the record held
   * already (a resumed session's, a loaded one's) are previous-run, because the run is new.
   * Returns the id. With none given a fresh one is made. Starting a second run in one page (a tracker
   * that restarts into a new origin) does to the first run's detections what a reload does.
   *
   * Listeners are told, so the pins and the panel stop showing what is no longer in the frame. This
   * writes nothing: the id is memory only, and a read-only or superseded store may start a run too.
   */
  startArRun(arRunId: string = newArRunId()): string {
    const id = arRunId || newArRunId()
    if (id === this._arRunId) return id
    this._arRunId = id
    // A server session opened by the run that ended holds keyframes in that run's frame.
    this._serverSessionsOpenedInRun.clear()
    try {
      this.notify()
    } catch (err) {
      // A listener's failure must not fail the AR start it was told about.
      console.warn('[store] a listener failed after the AR run started:', err)
    }
    return id
  }

  /**
   * Whether a stored detection is in the frame this page is showing: this page's run placed it.
   *
   * False for one another run placed, false for one with no id (written before runs were stamped,
   * so it can only be from an earlier page), and false for every detection until a run has started.
   * This is the one place that policy lives (owner decision D14: previous-run detections are kept
   * read-only in the history drawer and never put under the live calibration).
   */
  isCurrentRun(det: Pick<StoredDetection, 'arRunId'>): boolean {
    return this._arRunId !== null && det.arRunId === this._arRunId
  }

  /**
   * The detections that are in this page's frame, by key: what the pins, the panel list and count,
   * the GLB and summary exports and every "how many objects" figure read. A new Map each call, so
   * it is a snapshot, and a caller that holds it sees none of the changes after it.
   *
   * The whole record is `detections`, and only the history drawer and the persisted record want it.
   * A reader that places, counts or sends a position and takes `detections` instead is the bug this
   * method exists to stop, and tests/unit/node/wp-ar-run-consumers.test.ts lists the modules that
   * may read the whole record.
   */
  currentRunDetections(): Map<string, StoredDetection> {
    const current = new Map<string, StoredDetection>()
    for (const [key, det] of this._detections) {
      if (this.isCurrentRun(det)) current.set(key, det)
    }
    return current
  }

  /** How many stored detections are not in this page's frame: the record's size less the current run's. */
  previousRunCount(): number {
    let previous = 0
    for (const det of this._detections.values()) {
      if (!this.isCurrentRun(det)) previous++
    }
    return previous
  }

  /**
   * The live session's server id when this page's run opened it, and null otherwise: for a session that has
   * only a local id, for one that resume or a load took over from an earlier page, for one a run that has since
   * ended opened, and before AR has started.
   *
   * This is the id an export may name as the keyframe session of what it carries. A server session is a
   * directory of keyframes in the SLAM frame of the run that streamed them, and the GLB, the point cloud and
   * the calibration an export holds are this run's. A resumed record keeps the earlier run's server id
   * (resumeLatestSession adopts the session whole), so exporting `sessionId` from a page that never opened a
   * session of its own would send the server this run's scan labelled with another run's keyframes.
   * `sessionId` itself is unchanged: it is still the record's key, and still what the history drawer lists.
   */
  get serverSessionOfThisRun(): string | null {
    return this._arRunId !== null && isServerSessionId(this._sessionId) && this._serverSessionsOpenedInRun.has(this._sessionId)
      ? this._sessionId
      : null
  }

  /**
   * Add or update this run's detections; persists to IndexedDB and notifies listeners. Resolves
   * false when the save is refused. A read-only or superseded store, or one with no live session,
   * changes nothing here at all.
   *
   * What is passed in is written into this page's frame, and each detection is stamped with the run
   * (see startArRun). So the caller merges into `currentRunDetections()` and not into `detections`.
   * A detection that arrives already carrying another run's id is that run's data written back (a caller
   * that merged into the whole record): it keeps its id and is not claimed for this run, because
   * re-stamping it would put a position from another frame under this run's calibration, which is the one
   * thing the stamp exists to prevent. The store says so on the console; the caller is the bug.
   *
   * A key held by a previous-run detection is not overwritten. The key is `label:bucket(worldPos)`
   * (main.ts), and every run's positions are measured from its own origin, so two runs that started
   * in the same place put the same object under the same key. The earlier detection is archived
   * data and keeps its key, and the new one is written under the same key with this run's tag after it.
   * `attachDetections` follows a capture's keys to where its run's detections went.
   *
   * With no run started (AR has not begun) there is no previous run to protect, and an unstamped detection
   * is written under its key as it always was. Nothing calls it then: a capture needs a pose, and a pose
   * needs the AR runtime that starts the run.
   */
  async upsert(incoming: Map<string, WorldDetection>, thumbnails: Map<string, string>): Promise<boolean> {
    // Superseded: the scan's record and frames belong to the tab that moved it. No live
    // session means the scan was erased while this capture was still being analysed. Its
    // detections belong to that scan: drop them rather than show them or save them under a new one.
    if (!this.writable || !this._sessionId) return false
    let foreign = 0
    for (const [key, det] of incoming) {
      const carried = (det as StoredDetection).arRunId
      const carriesAnotherRun = typeof carried === 'string' && carried !== this._arRunId
      if (carriesAnotherRun) foreign++
      const run = carriesAnotherRun ? carried : this._arRunId
      const target = run === null ? key : this.slotFor(key, run)
      const existing = this._detections.get(target)
      this._detections.set(target, {
        ...det,
        ...(run !== null ? { arRunId: run } : {}),
        // The freshly captured thumbnail wins. The previous one is kept only when this
        // capture produced none for this key — otherwise a detection resumed from an
        // earlier session pins its old image forever, because the key is
        // `label:bucket(worldPos)` (main.ts) and every re-capture of the same object
        // in the same place matches it. `existing` is what sits in this run's own slot, so
        // an earlier run's picture is never borrowed by a later run's detection.
        thumbnailDataUrl: thumbnails.get(key) ?? existing?.thumbnailDataUrl,
      })
    }
    if (foreign > 0) {
      console.warn(`[store] upsert was handed ${foreign} detection${foreign === 1 ? '' : 's'} stamped by another AR run; kept as that run's, not claimed for this one`)
    }
    this.notify()
    return this.persist()
  }

  /**
   * Where `runId`'s own detection of `key` is, or would go: `key` itself when it holds nothing or holds that
   * run's detection (so a re-capture lands on the detection it updates), and otherwise `key` with the run's
   * tag after it, then `-2`, `-3` and so on past each of those that another run's detection holds.
   */
  private slotFor(key: string, runId: string): string {
    const tagged = `${key}@${runId.slice(0, 8)}`
    let candidate = key
    for (let n = 1; ; n++) {
      const held = this._detections.get(candidate)
      if (held === undefined || held.arRunId === runId) return candidate
      candidate = n === 1 ? tagged : `${tagged}-${n}`
    }
  }

  /**
   * The key a capture of `runId` should name for the detection `key` stands for: the slot that run's
   * detection is in, or `key` unchanged when the run stored nothing there (a detection merged into a
   * neighbour under another key, as before runs existed).
   */
  private keyOfRun(key: string, runId: string): string {
    const slot = this.slotFor(key, runId)
    return this._detections.get(slot)?.arRunId === runId ? slot : key
  }

  /** Patch an existing detection's mutable fields (label, description). Resolves false when refused. */
  async updateDetection(key: string, patch: Partial<Pick<StoredDetection, 'label' | 'description'>>): Promise<boolean> {
    if (!this.writable) return false
    const det = this._detections.get(key)
    if (!det) return false
    this._detections.set(key, { ...det, ...patch })
    this.notify()
    return this.persist()
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
  async clear(): Promise<boolean> {
    // A read-only or superseded store keeps the scan as it was, and deletes nothing.
    if (!this.writable) return false
    this._detections.clear()
    this._selected.clear()
    await this.dropCapturesForSession(this._sessionId)
    this.notify()
    return this.persist()
  }

  /**
   * Begin a new scan under a new session id and leave the one that was live as it is: the scan ends here, and its
   * record, its captures and its frames stay in the history exactly as the last save left them. This is the store's half of
   * a re-anchor (src/ar/reanchor-flow.ts): the next scan is in another frame, so what it stores must not be written into
   * the record of the one before. A Clear is not this: it empties the live record and keeps its id.
   *
   * The scan being left is not written again here. Every change to a record is saved as it is made, and the host saves
   * the scan (`saveSnapshot`) before it ends it (src/ar/reanchor-host.ts), so the record is whole. The new session is a
   * `local-` id and has no record until something is saved into it (a capture, or `saveSnapshot`), as a session started
   * after an erase has none: an empty record written now would list as "0 objects" in the history drawer, which is why
   * boot writes none either. The detections handed out earlier through `detections` are the old scan's and stay so: the
   * new session has its own, empty, map. The selection is cleared. The AR run is untouched: `startArRun` is how a new scan
   * is stamped.
   *
   * Returns false, and changes nothing, when this store is read-only or superseded: it has no scan of its own to end.
   * Synchronous, so nothing can be recorded into the old session between the end of the scan and the start of the next.
   */
  beginSession(): boolean {
    if (!this.writable) return false
    this._sessionId = newLocalSessionId()
    this._startedAt = Date.now()
    this._detections = new Map()
    this._selected.clear()
    this.notify()
    return true
  }

  /** Persist the current session even when it has no detections yet. Resolves false when refused. */
  async saveSnapshot(): Promise<boolean> {
    return this.persist()
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
   *
   * The id names the session this store holds. When none is held, a writable store starts one
   * (see ensureLiveSession). A superseded store starts none, and one whose scan another tab then
   * erased holds none, so the id's session part is empty. putCapture refuses both, so no record
   * is written under such an id.
   */
  captureIdFor(captureIndex: number): string {
    return `${this.ensureLiveSession()}-c${captureIndex}`
  }

  /**
   * The live session's id, starting a new local session first if none is live.
   *
   * Only the capture path starts one. That is how a scan begins again after an
   * erase; saves and reads never do, so an autosave cannot start an empty session.
   * A superseded store starts none: its scan is another tab's now. A read-only store starts none either.
   */
  private ensureLiveSession(): string {
    if (!this._sessionId && this.writable) {
      this._sessionId = newLocalSessionId()
      this._startedAt = Date.now()
    }
    return this._sessionId
  }

  /**
   * How many of *this session's* captures are in each state, for the summary.
   *
   * Scoped to the live session because the summary is: `_captures` also holds
   * records restored from earlier sessions, and counting those would report a
   * capture total that does not match the scan being exported.
   *
   * `'run'` narrows that to the captures this page's AR run took, which is what a scan's summary
   * describes once a reload has resumed the record: the objects it lists, the points and the path it
   * measures are this run's, and an earlier run's failed captures are not part of this scan. A capture
   * with no run stamped on it (a record from before runs were stamped) is an earlier run's.
   *
   * This is what stops a failed capture being silently absent: it cannot be a
   * row in the object table, having no labels to put there, but it is counted.
   */
  captureCounts(scope: 'session' | 'run' = 'session'): {
    total: number; pending: number; inferred: number; failed: number
    unusable: number; retained: number
  } {
    let total = 0, pending = 0, inferred = 0, failed = 0, unusable = 0, retained = 0
    for (const rec of this._captures.values()) {
      if (rec.sessionId !== this._sessionId) continue
      if (scope === 'run' && (this._arRunId === null || rec.arRunId !== this._arRunId)) continue
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
   * be a second failure mode on the path this is meant to make reliable. Resolves
   * false, and writes nothing, when this store is read-only or superseded, or when the row the frame
   * would overwrite belongs to another session (see persistCapture).
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
  }): Promise<CaptureRecord | false> {
    // Refused before any id is minted: a frame taken now would land under the moved scan's id.
    if (!this.writable) return false
    const record: CaptureRecord = {
      captureId: this.captureIdFor(input.captureIndex),
      sessionId: this.ensureLiveSession(),
      captureIndex: input.captureIndex,
      timestamp: input.timestamp,
      pose: input.pose,
      blob: input.blob,
      byteSize: input.blob.size,
      status: 'pending',
      detectionKeys: [],
      // The pose above is in this run's frame, and says so.
      ...(this._arRunId !== null ? { arRunId: this._arRunId } : {}),
      engine: input.engine ?? 'server',
    }
    const previous = this._captures.get(record.captureId)
    this._captures.set(record.captureId, record)
    // The frame is written under the live session's id. A store that has learnt its scan
    // was moved writes no frame (see persistCapture). Until then a frame is written here,
    // and it stays under this id: the renaming tab does not re-key it.
    if (!(await this.persistCapture(record))) {
      // Refused: this store does not hold the frame. Whatever was under the id is put back.
      if (this._captures.get(record.captureId) === record) {
        if (previous) this._captures.set(record.captureId, previous)
        else this._captures.delete(record.captureId)
      }
      return false
    }
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
  async attachDetections(captureId: string, detectionKeys: string[]): Promise<boolean> {
    if (!this.writable) return false
    const record = this._captures.get(captureId)
    if (!record) return false
    const before = { detectionKeys: record.detectionKeys, status: record.status, error: record.error }
    // The keys arrive as main.ts derives them, `label:bucket(worldPos)`. Where this capture's run found an
    // object that an earlier run had already stored under that key, the run's own detection is under the key's
    // tagged form (see upsert), and that is the one the capture names: a key means a detection only inside the
    // run that took the capture (CaptureRecord.detectionKeys).
    const runId = record.arRunId
    record.detectionKeys = runId === undefined ? detectionKeys : detectionKeys.map((key) => this.keyOfRun(key, runId))
    record.status = 'inferred'
    delete record.error
    if (!(await this.persistCapture(record))) {
      // Refused: the record is as it was.
      record.detectionKeys = before.detectionKeys
      record.status = before.status
      if (before.error === undefined) delete record.error
      else record.error = before.error
      return false
    }
    await this.evictCaptures()
    return true
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
  async markCaptureFailed(captureId: string, error: string): Promise<boolean> {
    if (!this.writable) return false
    const record = this._captures.get(captureId)
    if (!record) return false
    const before = { status: record.status, error: record.error }
    record.status = 'failed'
    record.error = error
    if (!(await this.persistCapture(record))) {
      // Refused: the record is as it was.
      record.status = before.status
      if (before.error === undefined) delete record.error
      else record.error = before.error
      return false
    }
    return true
  }

  /** Restore captures from IndexedDB. Called by open(); failure is non-fatal. */
  private async loadCaptures(): Promise<void> {
    if (!this.db) return
    try {
      const records = await idbGetAll<CaptureRecord>(this.db, CAPTURES_STORE)
      records.sort((a, b) => a.timestamp - b.timestamp)
      for (const rec of records) {
        // An erase that started or finished while this read was in flight has its rows going, or gone.
        // A frame from before that must not come back.
        if (this.isErased(rec.sessionId)) continue
        this._captures.set(rec.captureId, rec)
      }
    } catch {
      console.warn('[store] could not restore captures')
    }
  }

  /**
   * Mirror one capture record to IndexedDB. No-op without a db. Never throws.
   *
   * Resolves true when the change made in memory may stand: the record is written, there is
   * no db, or the write failed for a reason other than another session's row (quota exhaustion
   * lands here, and the in-memory record survives this session). Resolves false, and writes
   * nothing, when this store is superseded or the stored row belongs to another session.
   *
   * The row must still carry the sessionId this record is held under. A row under another id
   * was moved by another tab, and this store does not write over it. The check is made in the
   * same transaction as the write (see idbPutCaptureRow). A frame of a session this store is no
   * longer live on still passes, because its row still carries that id, so the retention budget
   * keeps releasing it.
   *
   * This row-owner rule is for writable stores. The cross-page cases the store reviews reproduced
   * need two writable pages on one origin, and the page lock in the scanner prevents a second
   * writable page. A read-only store is refused at the first line, before any row is read.
   */
  private async persistCapture(record: CaptureRecord): Promise<boolean> {
    if (!this.writable) return false
    if (!this.db) return true
    let outcome: CaptureRowOutcome
    try {
      outcome = await idbPutCaptureRow(this.db, record)
    } catch (e) {
      // Quota exhaustion lands here. The in-memory record survives, so the
      // capture is still usable this session — it just will not outlive a reload.
      console.warn('[store] capture not persisted:', e)
      return true
    }
    if (outcome.applied) return true
    this.refusedCaptureRow(record.sessionId, outcome.owner)
    return false
  }

  /**
   * A capture row this store tried to write, delete or re-key belongs to another session, `owner`.
   * A row under a server id is the scan moved to it, and applyRemoteRename deals with that: a
   * store live on `from` is superseded, and any other store drops its in-memory copies, as an
   * erase would. A row under this store's own live id was re-keyed here, so nothing changes.
   */
  private refusedCaptureRow(from: string, owner: string): void {
    if (owner !== this._sessionId) this.applyRemoteRename(from, owner)
  }

  /**
   * Hold the retained frames inside their budget.
   *
   * Two tiers: blobs are released (record kept) against an age and byte budget,
   * then whole records are deleted against an item cap. Both walk 'inferred'
   * before 'failed' and neither touches 'pending' — so a run of captures whose
   * inference is all still in flight sits over budget rather than dropping one.
   * That is deliberate; a pending frame is the thing being protected. A release or a delete
   * whose row another tab owns is refused (see persistCapture), and a superseded store releases nothing.
   */
  private async evictCaptures(): Promise<void> {
    if (!this.writable) return
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

    // Bytes — release oldest inferred frames until back under budget. The total is read again
    // each time, because a refused release can drop another session's records from memory.
    const heldBytes = (): number => {
      let total = 0
      for (const rec of this._captures.values()) if (rec.blob) total += rec.byteSize
      return total
    }
    if (heldBytes() > MAX_CAPTURE_BYTES) {
      for (const rec of evictable()) {
        if (heldBytes() <= MAX_CAPTURE_BYTES || this._superseded) break
        if (!rec.blob) continue
        await this.discardFrame(rec.captureId, 'budget')
      }
    }

    // Items — a blob-less record is tiny, but not free. The record leaves memory first, so no
    // write can reach it while its row is going. A refused delete leaves the row in place, and a
    // superseded store puts the record back, because it keeps the state it had.
    for (const rec of evictable()) {
      if (this._captures.size <= MAX_CAPTURE_ITEMS || this._superseded) break
      if (!this._captures.has(rec.captureId)) continue
      this._captures.delete(rec.captureId)
      if (!(await this.deleteCaptureRecord(rec)) && this._superseded) {
        if (!this._captures.has(rec.captureId)) this._captures.set(rec.captureId, rec)
        break
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
  async discardFrame(captureId: string, reason: 'quality' | 'budget'): Promise<boolean> {
    if (!this.writable) return false
    const record = this._captures.get(captureId)
    if (!record?.blob) return false
    const before = { blob: record.blob, frameDropped: record.frameDropped }
    record.blob = null
    record.frameDropped = reason
    if (!(await this.persistCapture(record))) {
      // Refused: the frame is held as it was.
      record.blob = before.blob
      if (before.frameDropped === undefined) delete record.frameDropped
      else record.frameDropped = before.frameDropped
      return false
    }
    return true
  }

  /**
   * Delete one evicted record's row, unless the row belongs to another session (see
   * persistCapture). Resolves false only when the delete is refused. The caller has already
   * dropped the record from memory.
   */
  private async deleteCaptureRecord(record: CaptureRecord): Promise<boolean> {
    if (!this.writable) return false
    if (!this.db) return true
    let outcome: CaptureRowOutcome
    try {
      outcome = await idbDeleteCaptureRow(this.db, record.captureId, record.sessionId)
    } catch {
      // The in-memory delete already happened. Disk catches up next open.
      return true
    }
    if (outcome.applied) return true
    this.refusedCaptureRow(record.sessionId, outcome.owner)
    return false
  }

  /**
   * Forget every capture belonging to a session, blobs included. Memory is cleared
   * before the first await, so no record of the session is still held while its
   * rows are going. The rows are matched by the sessionId they hold.
   */
  private async dropCapturesForSession(sessionId: string): Promise<void> {
    if (!sessionId) return
    this.takeCaptures(sessionId)
    if (!this.db) return
    await idbDropSessionRows(this.db, sessionId, false).catch(() => {
      // The in-memory copies are already gone, but the rows are still in IndexedDB under
      // this id. The next open restores every stored row (loadCaptures), so they come back
      // into memory until the retention budget releases them. A pending one is never released.
    })
  }

  /** Remove a session's captures from memory, and return them. Awaits nothing. */
  private takeCaptures(sessionId: string): CaptureRecord[] {
    const taken: CaptureRecord[] = []
    for (const [key, rec] of [...this._captures]) {
      if (rec.sessionId !== sessionId) continue
      this._captures.delete(key)
      taken.push(rec)
    }
    return taken
  }

  /**
   * Re-key this store's in-memory captures from one session id to another. Returns the
   * moved records. Only the renaming tab calls this, from adoptServerSession.
   */
  private moveCaptures(from: string, to: string): CaptureRecord[] {
    const moved: CaptureRecord[] = []
    for (const [key, rec] of [...this._captures]) {
      if (rec.sessionId !== from) continue
      const next = { ...rec, sessionId: to }
      this._captures.set(key, next)
      moved.push(next)
    }
    return moved
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
   *
   * A session that is being erased, or was erased here or in another tab, is
   * not resumed: its record may already be gone.
   *
   * What comes back is the record, and the detections in it were placed in the frame of whichever
   * run made them: this page is a new run, with a new origin. So they are previous-run until proven
   * otherwise (see isCurrentRun): kept, listed in the history drawer, and out of the pins, the panel
   * and every export. The count returned is how many came back, not how many are in view, and
   * `currentRunDetections().size` is how many are.
   */
  async resumeLatestSession(): Promise<number> {
    // A superseded or read-only store does not take on another session, so nothing is resumed and this is 0.
    if (!this.db || !this.writable) return 0
    const sessions = await getAllSessions(this.db)
    const latest = sessions
      .filter((s) => !this.isErased(s.sessionId))
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
   *
   * Its detections keep the run they were stamped with. Only the ones this page's own run placed
   * are in view afterwards (see currentRunDetections); the others are loaded and editable, and stay
   * out of the pins and the exports.
   *
   * An id being erased, or already erased, is refused: this returns false and the
   * live scan is left as it is. So is a load into a superseded store.
   */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.db || this._superseded || this.isErased(sessionId)) return false
    const sessions = await getAllSessions(this.db)
    // Erased while the read was in flight: the record it returned may already be gone.
    if (this.isErased(sessionId)) return false
    const record = sessions.find((s) => s.sessionId === sessionId)
    if (!record) return false
    this.adopt(record)
    this._selected.clear()
    this.notify()
    return true
  }

  /**
   * Delete a session from IndexedDB, along with the frames it captured.
   *
   * Erasing the live session ends it. Its id is cleared before the first await,
   * so no save can write the record back while it is being removed, and late
   * detections are dropped (see upsert). The next capture starts a new session.
   * The record and every row stored under the id go in one transaction, so a
   * failure leaves them as they were, and the live scan is restored.
   *
   * Once the record is gone, the id is refused for good here (loadSession,
   * adoptServerSession, resumeLatestSession and persist all check it), and the
   * other tabs on this origin are told to drop it too (see applyRemoteErase).
   *
   * With no database there is nothing to erase, so this resolves false without changing
   * anything: the live scan stays as it is. An empty id is ignored as well. A superseded
   * store erases nothing, and resolves false too: the scan's record is another tab's now.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.writable || !this.db || !sessionId) return false
    // A second erase of the same id waits for the first. Starting its own would
    // run a second restore against a record the first one is still removing.
    const running = this.erasing.get(sessionId)
    if (running) return running.then(() => true)
    // In the erasing set before the erase runs. Its first step notifies subscribers,
    // and one of them may ask for this same id during that notify. That must be refused.
    const erase = deferred()
    this.erasing.set(sessionId, erase.promise)
    this.eraseRecord(this.db, sessionId).then(erase.resolve, erase.reject)
    try {
      await erase.promise
    } finally {
      this.erasing.delete(sessionId)
    }
    return true
  }

  /**
   * The erase itself, once deleteSession has registered it as in flight.
   *
   * The live scan is cleared and the change shown first. Then the frames leave
   * memory, and the record and its rows go in one transaction. A failure puts
   * back what was taken, and the live scan too, unless a new scan has started or
   * another tab has erased this id meanwhile. Only a record that is really gone
   * is refused for good and announced.
   */
  private async eraseRecord(db: IDBDatabase, sessionId: string): Promise<void> {
    const live = sessionId === this._sessionId
    const kept = { detections: this._detections, selected: this._selected }
    let frames: CaptureRecord[] = []
    try {
      if (live) {
        this._sessionId = ''
        this._detections = new Map()
        this._selected = new Set()
        // A listener that throws is reported here. It does not change the outcome of the erase.
        try {
          this.notify()
        } catch (notifyErr) {
          console.warn('[store] a listener failed after an erase:', notifyErr)
        }
      }
      frames = this.takeCaptures(sessionId)
      await idbDropSessionRows(db, sessionId, true)
    } catch (err) {
      // The record is still on disk, so put back what this erase took. Nothing is put back
      // when another tab has erased the id meanwhile.
      const erasedElsewhere = this.erased.has(sessionId)
      if (!erasedElsewhere) {
        for (const rec of frames) {
          if (!this._captures.has(rec.captureId)) this._captures.set(rec.captureId, rec)
        }
      }
      if (live && !this._sessionId && !erasedElsewhere) {
        this._sessionId = sessionId
        this._detections = kept.detections
        this._selected = kept.selected
        // Restoring the scan is not undone by a listener that throws: the original error is what is thrown.
        try {
          this.notify()
        } catch (notifyErr) {
          console.warn('[store] a listener failed after an erase:', notifyErr)
        }
      }
      throw err
    }
    this.erased.add(sessionId)
    this.announce(sessionId)
  }

  /**
   * Another tab on this origin erased a session. Refuse the id here from now on,
   * drop its frames, and clear the live scan if it is this one, the same way the
   * erasing tab does. A tab holding some other session live is not disturbed.
   *
   * The state is cleared before any listener hears of it. A listener that throws
   * is reported here, and does not reject the save that found the record gone.
   */
  private applyRemoteErase(sessionId: string): void {
    if (!sessionId) return
    if (this._superseded) {
      // A superseded store writes nothing and deletes no row. An erase of the scan it was
      // moved to is still a genuine erase, so it clears this store from memory.
      if (sessionId === this.movedTo) this.clearSuperseded(sessionId)
      return
    }
    this.erased.add(sessionId)
    const live = sessionId === this._sessionId
    if (live) {
      this._sessionId = ''
      this._detections = new Map()
      this._selected = new Set()
    }
    this.dropCapturesForSession(sessionId).catch(() => {})
    if (!live) return
    try {
      this.notify()
    } catch (err) {
      console.warn('[store] a listener failed after an erase:', err)
    }
  }

  /**
   * Another tab renamed a session from `from` to `to`. The renaming tab has already
   * written the record and its frames under `to`, and it is the only writer of them
   * from now on. A store that holds `from` live is superseded (see supersede): it keeps
   * its state and writes nothing, so nothing it holds is re-keyed into the renamed
   * record. A store that holds another session drops its in-memory copies of the moved
   * frames, as an erase would. They are no longer its to write, and an eviction or a
   * late attach here could otherwise write them back over the renamed record. A superseded
   * store changes nothing else, but it does record a second move of the scan it was moved to,
   * so that an erase of the new id is still heard (see movedTo).
   */
  private applyRemoteRename(from: string, to: string): void {
    if (!from || from === to || !isServerSessionId(to) || this.isErased(to)) return
    if (this._superseded) {
      if (from === this.movedTo) this.movedTo = to
      return
    }
    if (this._sessionId === from) {
      this.supersede(to)
      return
    }
    this.takeCaptures(from)
  }

  /**
   * This store's scan was moved to `to` by another tab. Its state is kept, and it writes
   * nothing from here on, under any id. Listeners hear of it once. A listener that throws
   * is reported here, not thrown into the message or the save that found the move.
   */
  private supersede(to: string): void {
    if (this._superseded) return
    this._superseded = true
    this.movedTo = to
    for (const listener of [...this.supersededListeners]) {
      try {
        listener()
      } catch (err) {
        console.warn('[store] a listener failed after the scan was moved:', err)
      }
    }
  }

  /**
   * The scan this superseded store was moved to has been erased by another tab. Clear it
   * here, from memory only. The erasing tab has already removed the rows, and this store
   * deletes none. The page then shows an empty scan, as after any erase.
   */
  private clearSuperseded(sessionId: string): void {
    this.erased.add(sessionId)
    if (this._sessionId) this.takeCaptures(this._sessionId)
    this.takeCaptures(sessionId)
    this._sessionId = ''
    this._detections = new Map()
    this._selected = new Set()
    try {
      this.notify()
    } catch (err) {
      console.warn('[store] a listener failed after an erase:', err)
    }
  }

  /** Post one message to the other tabs. Best effort: the local change has already happened. */
  private announce(message: string | RenameNotice): void {
    try {
      this.eraseChannel?.postMessage(message)
    } catch {
      // Without a working channel the other tabs stay unaware until they reload.
    }
  }

  /** Whether an erase has started on this id, or finished on it, here or in another tab. */
  private isErased(sessionId: string): boolean {
    return this.erasing.has(sessionId) || this.erased.has(sessionId)
  }

  /** Take over a stored record's data and identity. Callers notify(). */
  private adopt(record: { sessionId: string; startedAt: number; detections: unknown }): void {
    this._sessionId = record.sessionId
    this.onDisk.add(record.sessionId)
    this._startedAt = record.startedAt
    this._detections = new Map(
      (record.detections as Array<[string, StoredDetection]>)
        .map(([key, det]) => [key, normalizeStoredDetection(det, record.sessionId)]),
    )
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn(this._detections, this._selected))
  }

  /**
   * Write the live session's record. Resolves false when the write is refused (this store
   * is read-only or superseded, or its scan was erased), and true when it is accepted. With no
   * database, and a writable store, there is nothing to write and nothing is refused, so that resolves true.
   *
   * Single writer. A scan's record and frames have one writer at a time: the tab that holds
   * the scan live and has not been moved. The rule for the record: a record the store has seen
   * on disk, by loading it or by writing it, is written only while it is still there, and a
   * record it has never seen on disk is written. When a record it has seen has gone, another
   * tab either erased the scan or moved it:
   *
   *  - Erased. No server-id record carries this scan's start time, so this store clears the
   *    scan and refuses the id from now on.
   *  - Moved. A rename keeps the start time, so the renamed record is listed with it. This
   *    store is superseded: it keeps its state and writes nothing more, under any id. The
   *    renaming tab writes the renamed record and its frames from then on. Nothing is merged.
   *    A save made here after the move is refused, and a frame this tab wrote under the old
   *    id before it learnt of the move stays under that id.
   *
   * The listing is read in the same transaction as the check. Before a listed record is
   * taken as the move, a fresh read confirms that a record with this start time is still
   * there. So a record that another tab erased after the listing reads as an erase.
   */
  private async persist(): Promise<boolean> {
    // A read-only or superseded store writes nothing under any id. No live session: the last one was
    // erased and no scan has started since, and writing here would bring that record back
    // under its old id. An erased id is never written, even by a stale reference that still holds it.
    if (!this.writable || !this._sessionId || this.erased.has(this._sessionId)) return false
    if (!this.db) return true
    const id = this._sessionId
    const record = {
      sessionId: id,
      startedAt: this._startedAt,
      detections: [...this._detections.entries()],
    }
    // A record this store has seen on disk is written only while it is still there.
    const outcome = await idbPutIfPresent(this.db, STORE_NAME, record, this.onDisk.has(id))
    if (outcome.written) {
      this.onDisk.add(id)
      return true
    }
    // Checked again here, after the read: an id this store erased, or is erasing, is never taken for a move.
    if (this.isErased(id) || outcome.renamedIds.every((to) => this.isErased(to))) {
      this.applyRemoteErase(id)
      return false
    }
    // The listing may be stale by now, so the server-id records are read again before this store is superseded by one.
    let rows: Array<{ sessionId: string, startedAt: number }>
    try {
      rows = await getAllSessions(this.db)
    } catch {
      // Not confirmed, so nothing is decided: this save is refused and the scan stays as it is.
      return false
    }
    const movedTo = rows.find((row) =>
      row.startedAt === record.startedAt && isServerSessionId(row.sessionId) && !this.isErased(row.sessionId),
    )?.sessionId
    if (movedTo === undefined) {
      this.applyRemoteErase(id)
      return false
    }
    this.applyRemoteRename(id, movedTo)
    return false
  }
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      // Additive only. On the 1 -> 2 and 2 -> 3 upgrades the existing stores
      // are already there and are left exactly as they are — every stored
      // session and every pending capture frame must keep opening.
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
      }
      if (!db.objectStoreNames.contains(CAPTURES_STORE)) {
        db.createObjectStore(CAPTURES_STORE, { keyPath: 'captureId' })
      }
      if (!db.objectStoreNames.contains(TRIPOD_STORE)) {
        db.createObjectStore(TRIPOD_STORE, { keyPath: 'id' })
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

/**
 * Write a session record, or skip it when it must already exist and does not.
 *
 * What the code relies on: the existence check and the write are requests in one
 * readwrite transaction on the sessions store. IndexedDB runs readwrite transactions
 * that overlap a store one after another, in the order they were created, so another
 * tab's write or delete is either entirely before this transaction or entirely after it.
 * It cannot land between the check and the write. Resolves { written: true } when the
 * record was written.
 *
 * When the record has gone, the same transaction lists the server-id records that
 * carry this record's start time, and resolves { written: false, renamedIds }. A
 * rename keeps the start time (see adoptServerSession), so those are where a renamed
 * scan went. The listing is read in the transaction that found the record gone, so it
 * describes the same state as that check. The code acts on the reply when it arrives,
 * and persist confirms a listed record with a fresh read before it acts on one.
 *
 * What the test fake does not exercise: the fake in the wp-store test files runs each
 * request as it is made and never holds one readwrite transaction back for another, so
 * it cannot show the ordering above. The tests reach each interleaving by holding a
 * reply (see idb.hold and holdNextReply), which lets another tab's write land between
 * the check and the reply, and they check the outcome. Nothing in them shows that a real
 * transaction is serialised. The window between the put of a renamed record and the
 * delete of the old one in adoptServerSession is two transactions, and no test covers
 * a save that lands in it (STORE7-8).
 */
function idbPutIfPresent(
  db: IDBDatabase,
  storeName: string,
  record: { sessionId: string, startedAt: number },
  mustExist: boolean,
): Promise<{ written: true } | { written: false, renamedIds: string[] }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const put = () => {
      const req = store.put(record)
      req.onsuccess = () => resolve({ written: true })
      req.onerror = () => reject(req.error)
    }
    if (!mustExist) {
      put()
      return
    }
    const check = store.count(record.sessionId)
    check.onsuccess = () => {
      if (check.result > 0) {
        put()
        return
      }
      const all = store.getAll()
      all.onsuccess = () => {
        const renamedIds = (all.result as Array<{ sessionId: string, startedAt: number }>)
          .filter((row) => row.startedAt === record.startedAt && isServerSessionId(row.sessionId))
          .map((row) => row.sessionId)
        resolve({ written: false, renamedIds })
      }
      all.onerror = () => reject(all.error)
    }
    check.onerror = () => reject(check.error)
  })
}

/** What a guarded capture-row write or delete came to: applied, or refused because the stored row belongs to `owner`. */
type CaptureRowOutcome = { applied: true } | { applied: false, owner: string }

/**
 * Write one capture record, unless the row stored under its captureId belongs to another session.
 *
 * The lookup and the put are requests in one readwrite transaction on the captures store, so
 * another tab's write or delete lands entirely before it or entirely after it (see
 * idbPutIfPresent). A row that does not exist yet is written. A row under another sessionId is
 * left as it is, and the outcome names the sessionId it holds. The lookup is a key query, so it
 * reads that one row.
 */
function idbPutCaptureRow(db: IDBDatabase, record: CaptureRecord): Promise<CaptureRowOutcome> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CAPTURES_STORE, 'readwrite')
    tx.onabort = () => reject(tx.error ?? new Error('capture write aborted'))
    const store = tx.objectStore(CAPTURES_STORE)
    const lookup = store.openCursor(record.captureId)
    lookup.onerror = () => reject(lookup.error)
    lookup.onsuccess = () => {
      const hit = lookup.result
      // A key query answers with that row or with nothing. Any other row is passed over.
      if (hit && hit.key !== record.captureId) {
        hit.continue()
        return
      }
      const owner = hit ? (hit.value as CaptureRecord).sessionId : record.sessionId
      if (owner !== record.sessionId) {
        resolve({ applied: false, owner })
        return
      }
      const put = store.put(record)
      put.onsuccess = () => resolve({ applied: true })
      put.onerror = () => reject(put.error)
    }
  })
}

/**
 * Delete the capture row stored under `captureId`, unless it belongs to another session. The
 * transaction is shaped as in idbPutCaptureRow. A row that is not there is already gone.
 */
function idbDeleteCaptureRow(db: IDBDatabase, captureId: string, sessionId: string): Promise<CaptureRowOutcome> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CAPTURES_STORE, 'readwrite')
    tx.onabort = () => reject(tx.error ?? new Error('capture delete aborted'))
    const store = tx.objectStore(CAPTURES_STORE)
    const lookup = store.openCursor(captureId)
    lookup.onerror = () => reject(lookup.error)
    lookup.onsuccess = () => {
      const hit = lookup.result
      if (hit && hit.key !== captureId) {
        hit.continue()
        return
      }
      if (!hit) {
        resolve({ applied: true })
        return
      }
      const owner = (hit.value as CaptureRecord).sessionId
      if (owner !== sessionId) {
        resolve({ applied: false, owner })
        return
      }
      const del = store.delete(captureId)
      del.onsuccess = () => resolve({ applied: true })
      del.onerror = () => reject(del.error)
    }
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

/**
 * Re-key a batch of capture rows from `from` to `to`, and undo the batch if another tab has moved the
 * scan. The rows are read in the same readwrite transaction that writes them, and the writes are made
 * in the same turn as the reads, as the rename always made them. Requests in one transaction run in the order
 * they are made, so each read sees the row as it stood before this batch. A row under a session other
 * than `from` or `to` means another tab has moved this scan. The batch then puts every row back as it
 * stood, so the transaction commits nothing from it. Resolves { applied: true } once the transaction has
 * committed, or { applied: false, owner } with the session the row belongs to when the batch was undone.
 */
function idbMoveCaptureRows(db: IDBDatabase, records: CaptureRecord[], from: string, to: string): Promise<CaptureRowOutcome> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CAPTURES_STORE, 'readwrite')
    tx.oncomplete = () => resolve({ applied: true })
    tx.onabort = () => reject(tx.error ?? new Error('capture move aborted'))
    const store = tx.objectStore(CAPTURES_STORE)
    const before = new Map<string, CaptureRecord | undefined>()
    let read = 0
    for (const record of records) {
      const lookup = store.openCursor(record.captureId)
      lookup.onerror = () => reject(lookup.error)
      lookup.onsuccess = () => {
        const hit = lookup.result
        // A key query answers with that row or with nothing. Any other row is passed over.
        if (hit && hit.key !== record.captureId) {
          hit.continue()
          return
        }
        before.set(record.captureId, hit ? (hit.value as CaptureRecord) : undefined)
        read++
        if (read < records.length) return
        const foreign = [...before.values()].find((row) => row !== undefined && row.sessionId !== from && row.sessionId !== to)
        if (foreign === undefined) return
        // Undo the batch: each row goes back as it stood, or is removed if it was not there.
        for (const record of records) {
          const old = before.get(record.captureId)
          if (old) store.put(old)
          else store.delete(record.captureId)
        }
        resolve({ applied: false, owner: foreign.sessionId })
      }
    }
    // The batch is written now, as it always was. The reads above decide whether it stays.
    for (const record of records) store.put(record)
  })
}

/**
 * Delete the capture rows stored under one session id, and optionally that
 * session's record too, in one transaction. Each row is matched by the sessionId
 * it holds, not by its captureId. A rename keeps the captureIds, so an id-based
 * delete would take a renamed session's frames along with the old one.
 */
function idbDropSessionRows(db: IDBDatabase, sessionId: string, alsoRecord: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(alsoRecord ? [STORE_NAME, CAPTURES_STORE] : CAPTURES_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    if (alsoRecord) tx.objectStore(STORE_NAME).delete(sessionId)
    const cursor = tx.objectStore(CAPTURES_STORE).openCursor()
    cursor.onsuccess = () => {
      const hit = cursor.result
      if (!hit) return
      if ((hit.value as CaptureRecord).sessionId === sessionId) hit.delete()
      hit.continue()
    }
  })
}

// ─── The tripod path's in-progress capture ────────────────────────────────────
//
// Free functions rather than a second class: there is exactly one in-progress
// tripod capture per browser, it has no subscribers, and DetectionStore is
// about detections in a scan session — which a tripod capture is not. They
// share this file only because they share the database, which is the point
// (ADR 0001) and the reason `openDB`, `idbPut`, `idbGetAll` and `idbDelete`
// above are reused untouched.
//
// Every one of these swallows its own failure and reports it in the return
// value. Storage is an optional capability here, exactly like the camera: a
// private-mode tab that will not give the page a database must still be able
// to run a whole tripod capture in memory, the way it did before any of this
// existed. Nothing below is allowed to be the reason a capture cannot start.

/**
 * Open the shared database for a one-off tripod read or write.
 *
 * Not cached: these calls happen a handful of times per capture (a spot
 * finishes, a spot is discarded, the capture is sent), and holding a connection
 * open across a whole capture would block the upgrade of a tab opened
 * afterwards. The same 5 s ceiling the session store uses, for the same hung
 * backends.
 */
async function openTripodDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    return await Promise.race([
      openDB(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS),
      ),
    ])
  } catch {
    return null
  }
}

/**
 * Write the capture's shape, and one spot's photos if any are given.
 *
 * `spot` is written first: if the two writes come apart — the tab dies between
 * them — a photo record with no meta pointing at it is invisible and harmless,
 * where meta naming a spot whose photos never landed is a capture that claims a
 * spot it cannot upload. `restoreTripodCapture` refuses that shape anyway; this
 * makes it not happen.
 *
 * Returns false when nothing was written, so the caller can stop promising the
 * operator that closing the app is safe.
 */
export async function saveTripodCapture(
  meta: unknown,
  spot?: { id: string, files: File[] },
): Promise<boolean> {
  const db = await openTripodDB()
  if (!db) return false
  try {
    if (spot) await idbPut(db, TRIPOD_STORE, { id: spot.id, files: spot.files })
    await idbPut(db, TRIPOD_STORE, meta)
    return true
  } catch {
    return false
  } finally {
    db.close()
  }
}

/** Everything stored for the in-progress capture: the meta record and the spots. */
export async function loadTripodCapture(): Promise<{ meta: unknown, banks: Array<{ id: string, files: File[] }> } | null> {
  const db = await openTripodDB()
  if (!db) return null
  try {
    const rows = await idbGetAll<{ id: string, files?: File[] }>(db, TRIPOD_STORE)
    const meta = rows.find(row => row?.id === 'meta') ?? null
    if (!meta) return null
    const banks = rows
      .filter((row): row is { id: string, files: File[] } => row?.id !== 'meta' && Array.isArray(row?.files))
    return { meta, banks }
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Drop one spot's photos. Called when a spot is discarded, and only then. */
export async function deleteTripodSpot(id: string): Promise<void> {
  const db = await openTripodDB()
  if (!db) return
  try {
    await idbDelete(db, TRIPOD_STORE, id)
  } catch {
    // Nothing to do about it and nothing to say: the photos are already out of
    // the capture, and an orphan record is dropped by the next clear.
  } finally {
    db.close()
  }
}

/**
 * Throw the whole stored capture away.
 *
 * Called when a capture is sent and when one is abandoned, which between them
 * are every way a capture ends. Without it a phone accumulates the JPEGs of
 * every tripod capture it has ever started, forever, in a database whose other
 * two stores are carefully bounded.
 */
export async function clearTripodCapture(): Promise<void> {
  const db = await openTripodDB()
  if (!db) return
  try {
    const rows = await idbGetAll<{ id: string }>(db, TRIPOD_STORE)
    for (const row of rows) {
      if (typeof row?.id === 'string') await idbDelete(db, TRIPOD_STORE, row.id)
    }
  } catch {
    // Same as above: best effort. A stored capture that outlives its send is
    // recovered on the next open and can be thrown away from there.
  } finally {
    db.close()
  }
}
