/**
 * On-device model provisioning — wave 05 ticket 0002
 * (docs/factory/05-on-device-inference/0002-browser-model-provisioning.md).
 *
 * Downloads the ~2.2 GB of LFM2.5-VL-1.6B-ONNX weights that Vite already
 * serves from `public/models/LiquidAI/LFM2.5-VL-1.6B-ONNX/` (populated by
 * `download_models.py`, unchanged by this file — see that ticket's
 * Non-goals), caches them so a reload doesn't re-pay the transfer, verifies
 * them so a truncated download is never handed to `onnxruntime-web` as a
 * working session, and is honest about all of it while it happens.
 *
 * Deliberately NOT here: the WebGPU inference runtime itself (ticket 0003),
 * and the toggle/fallback policy that decides when to *use* this cache
 * (ticket 0004). This module answers exactly one question — "are the
 * weights on this device, and if not, get them there" — and every
 * capture/inference code path is free to ignore it entirely, which is what
 * keeps an interrupted or failed download from ever discarding a capture.
 *
 * ── Caching mechanism (this ticket's central open question) ────────────────
 * IndexedDB, not the Cache API and not public/sw.js's existing caches:
 *   - The existing service worker intercepts every same-origin GET in its
 *     scope (public/sw.js's `fetch` listener) and, for anything not in
 *     API_PREFIXES, runs `staleWhileRevalidate()` against its app-shell
 *     cache. That function calls `cache.put()` on every 2xx response — but
 *     the Cache API spec rejects `put()` for a 206 Partial Content response,
 *     which is exactly what a resumable Range request returns. Routing this
 *     module's downloads through the installed worker would therefore throw
 *     on every resumed chunk, and could serve a stale *whole-file* cache hit
 *     for a request that asked for a specific byte range. This file's
 *     `/models/` exclusion in public/sw.js's fetch handler (additive — see
 *     that file) takes model requests out of the worker entirely, so this
 *     was never actually a choice between "the SW's cache" and "a new one";
 *     it's a choice between the SW and something else, and IndexedDB is
 *     what the rest of this app already uses for exactly this kind of
 *     large, durable, per-record blob (src/scene/store.ts's capture
 *     records; public/sw.js's own offline-upload-queue bodies) — reusing it
 *     here is the ADR 0001 answer, not a new storage paradigm.
 *   - IndexedDB also sidesteps the Cache API's other complication for this
 *     use case: public/sw.js's `activate` handler deletes every cache whose
 *     name isn't its own `CACHE_VERSION` on every worker update, which would
 *     silently wipe a Cache-API-based model store on the next deploy. An
 *     IndexedDB database is untouched by that sweep.
 *
 * ── Resumability ─────────────────────────────────────────────────────────
 * Each file downloads via a streamed `fetch()`, flushing received chunks to
 * an IndexedDB 'partial' record every few MB so an interruption loses at
 * most that buffer, not the whole file. A later attempt resumes with
 * `Range: bytes=<received>-`; if the server responds with anything other
 * than 206 (no Range support, or the file changed underneath us), the
 * partial record is discarded and the file restarts rather than trusting a
 * byte alignment that can no longer be verified.
 *
 * ── Verification ─────────────────────────────────────────────────────────
 * A file is only ever promoted to the 'complete' store — the one any reader
 * should trust — once its received byte count matches the size this module
 * itself measured from the server (Content-Length / Content-Range) before
 * transferring a single byte. A size mismatch keeps the partial record (so
 * a retry can still resume most of it) and never writes 'complete'.
 *
 * ── Persistence ───────────────────────────────────────────────────────────
 * `navigator.storage.persist()` is requested once per provisioning attempt
 * (grant is heuristic and per-origin, not per-call, so asking repeatedly in
 * one session buys nothing). Refusal does not block the download — the
 * weights still work for the current session — but is recorded on
 * `ProvisioningStatus.persisted` so the caller can warn honestly instead of
 * silently hoping the browser doesn't evict them.
 */
// Explicit .ts extensions: see src/scene/store.ts's identical note — this
// module is imported directly by tests/unit/node/model_provisioning.test.ts,
// and Node's ESM loader needs the real specifier, not Vite's bundler
// resolution.
import { MODEL_CACHE_DB_NAME } from '../shared/storage-keys.ts'
import { quotaStatus } from '../shared/storage-quota.ts'

// ─── Model manifest ──────────────────────────────────────────────────────
// Mirrors download_models.py's META + ONNX_FILES lists exactly. That script
// is Python and this is TypeScript, so — same as CACHE_VERSION/QUEUE_DB in
// public/sw.js mirroring src/shared/storage-keys.ts — the two are hand-kept
// in sync rather than shared via import. tests/unit/node/model_provisioning.test.ts
// reads download_models.py's source and asserts these two arrays haven't
// drifted from it.

export const MODEL_ID = 'LiquidAI/LFM2.5-VL-1.6B-ONNX'
export const MODEL_BASE_PATH = `/models/${MODEL_ID}/`

export const MODEL_META_FILES: readonly string[] = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'processor_config.json',
  'chat_template.jinja',
]

export const MODEL_ONNX_FILES: readonly string[] = [
  'onnx/embed_tokens_fp16.onnx',
  'onnx/embed_tokens_fp16.onnx_data',
  'onnx/embed_images_fp16.onnx',
  'onnx/embed_images_fp16.onnx_data',
  'onnx/decoder_q4.onnx',
  'onnx/decoder_q4.onnx_data',
]

export const MODEL_FILES: readonly string[] = [...MODEL_META_FILES, ...MODEL_ONNX_FILES]

// ─── Public types ────────────────────────────────────────────────────────

export type FileState = 'absent' | 'partial' | 'ready'

export interface FileStatus {
  path: string
  state: FileState
  bytesReady: number
  /** null until this module has measured the server's size for this file. */
  bytesTotal: number | null
}

export interface ProvisioningStatus {
  state: 'absent' | 'partial' | 'ready' | 'error'
  files: FileStatus[]
  bytesReady: number
  /** null until every file's size is known. */
  bytesTotal: number | null
  /** null = never asked (or the API doesn't exist here); otherwise the last grant result. */
  persisted: boolean | null
  error?: string
}

// ─── IndexedDB layer ─────────────────────────────────────────────────────

const DB_VERSION = 1
const STORE_COMPLETE = 'complete'
const STORE_PARTIAL = 'partial'
const STORE_META = 'meta'

interface CompleteRecord {
  path: string
  byteSize: number
  blob: Blob
  downloadedAt: number
}

interface PartialRecord {
  path: string
  /** Expected total for this file, once known; null if interrupted before the first response arrived. */
  byteSize: number | null
  bytesReceived: number
  parts: Blob[]
  updatedAt: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MODEL_CACHE_DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_COMPLETE)) db.createObjectStore(STORE_COMPLETE, { keyPath: 'path' })
      if (!db.objectStoreNames.contains(STORE_PARTIAL)) db.createObjectStore(STORE_PARTIAL, { keyPath: 'path' })
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const r = tx.objectStore(store).get(key)
    r.onsuccess = () => resolve(r.result as T | undefined)
    r.onerror = () => reject(r.error)
  })
}

function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const r = tx.objectStore(store).getAll()
    r.onsuccess = () => resolve((r.result as T[]) ?? [])
    r.onerror = () => reject(r.error)
  })
}

/**
 * Rejects with a plain `Error('storage-full')` on QuotaExceededError rather
 * than the raw DOMException, so callers (and the UI copy in src/main.ts) can
 * tell "the device is full" apart from every other IndexedDB failure without
 * sniffing `.name` at every call site.
 */
function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value)
    tx.oncomplete = () => resolve()
    tx.onerror = () => {
      const err = tx.error
      reject(err?.name === 'QuotaExceededError' ? new Error('storage-full') : (err ?? new Error('IndexedDB write failed')))
    }
  })
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbClear(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ─── Pure helpers (unit tested directly — no IndexedDB/fetch involved) ────

/** `"bytes 0-0/2372813312"` → `2372813312`. null for anything that doesn't carry a known total. */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null
  const total = header.split('/')[1]
  if (!total || total === '*') return null
  const n = Number(total)
  return Number.isFinite(n) ? n : null
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'unknown size'
  const gb = bytes / 1024 ** 3
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  return `${Math.max(1, Math.round(mb))} MB`
}

/** Rolls per-file states into the overall status the UI switches on. */
export function overallState(files: readonly Pick<FileStatus, 'state'>[]): ProvisioningStatus['state'] {
  if (files.length > 0 && files.every((f) => f.state === 'ready')) return 'ready'
  if (files.some((f) => f.state === 'partial' || f.state === 'ready')) return 'partial'
  return 'absent'
}

// ─── Status ──────────────────────────────────────────────────────────────

/**
 * Current provisioning state, read from IndexedDB. Never touches the
 * network by default — `probe: true` additionally measures any file whose
 * size isn't already known/cached, so a caller can show an honest total
 * before the user commits to downloading (Acceptance Criteria: "a size
 * figure before it starts").
 */
export async function getProvisioningStatus(opts: { probe?: boolean } = {}): Promise<ProvisioningStatus> {
  const db = await openDB()
  let completeRows: CompleteRecord[]
  let partialRows: PartialRecord[]
  let sizesRow: { key: string; value: Record<string, number> } | undefined
  let persistedRow: { key: string; value: boolean } | undefined
  try {
    ;[completeRows, partialRows, sizesRow, persistedRow] = await Promise.all([
      idbGetAll<CompleteRecord>(db, STORE_COMPLETE),
      idbGetAll<PartialRecord>(db, STORE_PARTIAL),
      idbGet<{ key: string; value: Record<string, number> }>(db, STORE_META, 'sizes'),
      idbGet<{ key: string; value: boolean }>(db, STORE_META, 'persisted'),
    ])
  } finally {
    db.close()
  }

  let sizes = sizesRow?.value ?? {}
  if (opts.probe && MODEL_FILES.some((p) => sizes[p] === undefined)) {
    try {
      sizes = await probeAndCacheSizes()
    } catch {
      // Best-effort — status still returns, just without a total.
    }
  }

  const completeByPath = new Map(completeRows.map((r) => [r.path, r]))
  const partialByPath = new Map(partialRows.map((r) => [r.path, r]))

  const files: FileStatus[] = MODEL_FILES.map((path) => {
    const complete = completeByPath.get(path)
    const partial = partialByPath.get(path)
    const bytesTotal = complete?.byteSize ?? partial?.byteSize ?? sizes[path] ?? null
    if (complete) return { path, state: 'ready', bytesReady: complete.byteSize, bytesTotal }
    if (partial) return { path, state: 'partial', bytesReady: partial.bytesReceived, bytesTotal }
    return { path, state: 'absent', bytesReady: 0, bytesTotal }
  })

  const bytesReady = files.reduce((sum, f) => sum + f.bytesReady, 0)
  const bytesTotal = files.every((f) => f.bytesTotal !== null)
    ? files.reduce((sum, f) => sum + (f.bytesTotal ?? 0), 0)
    : null

  return {
    state: overallState(files),
    files,
    bytesReady,
    bytesTotal,
    persisted: persistedRow?.value ?? null,
  }
}

/** Sum of bytes this module currently holds — what src/main.ts's checkStorageQuota adds to scan-data usage. */
export async function estimateModelCacheBytes(): Promise<number> {
  return (await getProvisioningStatus()).bytesReady
}

// ─── Size probing ────────────────────────────────────────────────────────

async function headContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return null
    const len = res.headers.get('content-length')
    return len ? Number(len) : null
  } catch {
    return null
  }
}

async function rangeContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    if (!res.ok && res.status !== 206) return null
    const fromRange = parseContentRangeTotal(res.headers.get('content-range'))
    if (fromRange !== null) return fromRange
    // Server ignored the Range header and returned the whole file (status 200) —
    // its Content-Length is then the real total.
    const len = res.headers.get('content-length')
    return len ? Number(len) : null
  } catch {
    return null
  }
}

/**
 * Measures every file's size via HEAD (falling back to a 1-byte Range GET
 * for servers that don't implement HEAD) and caches the result in
 * IndexedDB so repeat status checks don't re-probe the network.
 */
async function probeAndCacheSizes(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    MODEL_FILES.map(async (path) => {
      const url = MODEL_BASE_PATH + path
      const bytes = (await headContentLength(url)) ?? (await rangeContentLength(url))
      if (bytes === null) throw new Error(`could not determine size of ${path}`)
      return [path, bytes] as const
    }),
  )
  const sizes = Object.fromEntries(entries)
  const db = await openDB()
  try {
    await idbPut(db, STORE_META, { key: 'sizes', value: sizes })
  } finally {
    db.close()
  }
  return sizes
}

// ─── Persistence ─────────────────────────────────────────────────────────

async function requestPersistence(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null
  let granted: boolean
  try {
    granted = await navigator.storage.persist()
  } catch {
    return null
  }
  const db = await openDB()
  try {
    await idbPut(db, STORE_META, { key: 'persisted', value: granted })
  } finally {
    db.close()
  }
  return granted
}

// ─── Download ────────────────────────────────────────────────────────────

/** Flush accumulated chunks to the 'partial' store at least this often, so an interruption loses little. */
const FLUSH_BYTES = 4 * 1024 * 1024

/**
 * Downloads (or resumes) one file, verifies its size, and promotes it to
 * the 'complete' store. Throws on any failure — the caller (provisionModel)
 * is what decides how that surfaces; this function never writes a
 * size-mismatched result to 'complete'.
 */
async function downloadFile(path: string, expectedBytes: number, onFileProgress: (bytesReady: number) => void): Promise<void> {
  const db = await openDB()
  try {
    const existingComplete = await idbGet<CompleteRecord>(db, STORE_COMPLETE, path)
    if (existingComplete) {
      if (existingComplete.byteSize === expectedBytes) {
        onFileProgress(existingComplete.byteSize)
        return
      }
      // The server's size no longer matches what we have on disk (a
      // re-published model, most likely) — don't trust a stale blob.
      await idbDelete(db, STORE_COMPLETE, path)
    }

    const existingPartial = await idbGet<PartialRecord>(db, STORE_PARTIAL, path)
    let parts: Blob[] = existingPartial?.parts ?? []
    let bytesReceived = existingPartial?.bytesReceived ?? 0
    const resuming = bytesReceived > 0

    const url = MODEL_BASE_PATH + path
    const response = await fetch(url, resuming ? { headers: { Range: `bytes=${bytesReceived}-` } } : {})

    if (resuming && response.status !== 206) {
      // No Range support, or the file moved under us — restart clean rather
      // than trust an alignment we can no longer verify.
      parts = []
      bytesReceived = 0
    } else if (!response.ok && response.status !== 206) {
      throw new Error(`${path}: HTTP ${response.status}`)
    }

    if (response.body) {
      const reader = response.body.getReader()
      let sinceFlush = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(new Blob([value as BlobPart]))
        bytesReceived += value.byteLength
        sinceFlush += value.byteLength
        onFileProgress(bytesReceived)
        if (sinceFlush >= FLUSH_BYTES) {
          await idbPut(db, STORE_PARTIAL, { path, byteSize: expectedBytes, bytesReceived, parts, updatedAt: Date.now() } satisfies PartialRecord)
          sinceFlush = 0
        }
      }
    } else {
      // No streaming reader available in this browser — whole-body fallback.
      const buf = await response.arrayBuffer()
      parts.push(new Blob([buf]))
      bytesReceived += buf.byteLength
      onFileProgress(bytesReceived)
    }

    if (bytesReceived !== expectedBytes) {
      // Truncated (or, rarely, over-length) transfer. Keep the partial
      // record — a retry can resume most of it — but never promote this to
      // 'complete': that store is what any future reader trusts blindly.
      await idbPut(db, STORE_PARTIAL, { path, byteSize: expectedBytes, bytesReceived, parts, updatedAt: Date.now() } satisfies PartialRecord)
      throw new Error(`${path}: expected ${expectedBytes} bytes, received ${bytesReceived}`)
    }

    const blob = new Blob(parts)
    await idbPut(db, STORE_COMPLETE, { path, byteSize: bytesReceived, blob, downloadedAt: Date.now() } satisfies CompleteRecord)
    await idbDelete(db, STORE_PARTIAL, path)
    onFileProgress(bytesReceived)
  } finally {
    db.close()
  }
}

// ─── Top-level entry points ────────────────────────────────────────────────

/**
 * Downloads every file the model needs, in order, reporting progress
 * through the same `{stage, pct}` shape webgpu.worker.ts's progress
 * messages and src/ui/overlay.ts's setProgress already use (Pinned
 * Conventions — reused, not a second progress surface). Safe to call again
 * after a failure or interruption: already-complete files are skipped, and
 * partial files resume.
 */
export async function provisionModel(onProgress?: (stage: string, pct: number) => void): Promise<ProvisioningStatus> {
  const report = (stage: string, pct: number) => onProgress?.(stage, pct)

  const persisted = await requestPersistence()

  report('Checking model size…', 0)
  let sizes: Record<string, number>
  try {
    sizes = await probeAndCacheSizes()
  } catch (err) {
    report('Could not reach the model files', 0)
    const status = await getProvisioningStatus()
    return { ...status, state: 'error', persisted, error: err instanceof Error ? err.message : String(err) }
  }
  const bytesTotal = Object.values(sizes).reduce((a, b) => a + b, 0)
  report(`Model is ${formatBytes(bytesTotal)} — starting download`, 0)

  const already = await getProvisioningStatus()
  const remaining = bytesTotal - already.bytesReady
  const quota = await quotaStatus()
  if (quota && remaining > 0 && quota.quota - quota.usage < remaining) {
    report('Not enough free storage for the on-device model', 0)
    return { ...already, bytesTotal, state: 'error', persisted, error: 'insufficient-storage' }
  }

  // Bytes already ready in every file OTHER than the one currently
  // downloading — the running baseline that the active file's own live
  // progress is added on top of, so overall pct stays accurate mid-file
  // without re-summing all files on every chunk.
  let bytesReadyOutsideCurrent = already.bytesReady
  for (const path of MODEL_FILES) {
    const initialForThisFile = already.files.find((f) => f.path === path)?.bytesReady ?? 0
    bytesReadyOutsideCurrent -= initialForThisFile
    try {
      await downloadFile(path, sizes[path], (fileBytesReady) => {
        const readySoFar = bytesReadyOutsideCurrent + fileBytesReady
        const pct = bytesTotal > 0 ? Math.min(readySoFar / bytesTotal, 0.999) : 0
        report(`Downloading on-device model — ${formatBytes(readySoFar)} / ${formatBytes(bytesTotal)}`, pct)
      })
    } catch (err) {
      report('Model download failed', 0)
      const status = await getProvisioningStatus()
      return { ...status, bytesTotal, state: 'error', persisted, error: err instanceof Error ? err.message : String(err) }
    }
    bytesReadyOutsideCurrent += sizes[path]
  }

  report('On-device model ready', 1)
  const finalStatus = await getProvisioningStatus()
  return { ...finalStatus, persisted }
}

/**
 * Deletes every cached file (complete and partial). Only ever touches this
 * module's own IndexedDB database — never DetectionStore's scan data, which
 * is the whole point of the separate database (Risks: "any eviction policy
 * must prefer dropping weights"; this is the explicit, user-initiated form
 * of that — there is no automatic eviction here at all).
 */
export async function removeProvisionedModel(): Promise<void> {
  const db = await openDB()
  try {
    await idbClear(db, STORE_COMPLETE)
    await idbClear(db, STORE_PARTIAL)
  } finally {
    db.close()
  }
}
