/**
 * A small in-memory IndexedDB for the tests that run the scan store (src/scene/store.ts) for real: the three object
 * stores it creates, requests that take effect when they are made and report on a later task, transactions that commit
 * once every request has reported and undo their writes if one fails, and records copied in and out so no store can
 * reach another's objects. The same shape as the one in wp-store-erase.test.ts and wp-ar-run-reload.test.ts, without the
 * holds and injected failures those use to reach interleavings between two tabs: the tests that use this one ask only
 * what was written.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
type Row = Record<string, unknown>

interface FakeRequest {
  result: unknown
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded?: (() => void) | null
}

interface FakeTx {
  pending: number
  state: 'active' | 'done' | 'aborted'
  undo: Array<() => void>
  error: unknown
  oncomplete: (() => void) | null
  onabort: (() => void) | null
  objectStore(name: string): unknown
}

/** The key path each object store is created with, as src/scene/store.ts declares them. */
const KEY_PATHS: Record<string, string> = { sessions: 'sessionId', captures: 'captureId', tripod: 'id' }

export interface FakeScanIdb {
  /** Installed as the global `indexedDB` that the store opens. */
  factory: unknown
  /** Copies of the rows now in an object store, for checking what was written. */
  rows(storeName: string): Row[]
}

export function fakeScanIdb(): FakeScanIdb {
  const stores = new Map<string, Map<unknown, Row>>()
  for (const name of Object.keys(KEY_PATHS)) stores.set(name, new Map())

  function settle(tx: FakeTx): void {
    if (tx.state !== 'active' || tx.pending > 0) return
    setTimeout(() => {
      if (tx.state !== 'active' || tx.pending > 0) return
      tx.state = 'done'
      tx.oncomplete?.()
    }, 0)
  }

  function abort(tx: FakeTx, error: unknown): void {
    if (tx.state !== 'active') return
    tx.state = 'aborted'
    tx.error = error
    for (const undo of tx.undo.reverse()) undo()
    tx.onabort?.()
  }

  function request(tx: FakeTx, run: () => unknown): FakeRequest {
    const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    tx.pending++
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown }
    try {
      if (tx.state !== 'active') throw new Error('transaction is not active')
      outcome = { ok: true, value: run() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    setTimeout(() => {
      if (tx.state === 'active') {
        if (outcome.ok) {
          req.result = outcome.value
          req.onsuccess?.()
        } else {
          req.error = outcome.error
          req.onerror?.()
          abort(tx, outcome.error)
        }
      }
      tx.pending--
      settle(tx)
    }, 0)
    return req
  }

  function storeOf(tx: FakeTx, name: string) {
    const rows = stores.get(name)
    if (!rows) throw new Error('no object store ' + name)
    const keyPath = KEY_PATHS[name] ?? 'id'
    const write = (key: unknown, next: Row | null): void => {
      if (tx.state !== 'active') return
      const before = rows.get(key)
      tx.undo.push(() => {
        if (before) rows.set(key, before)
        else rows.delete(key)
      })
      if (next) rows.set(key, next)
      else rows.delete(key)
    }
    return {
      put: (record: Row) => request(tx, () => {
        const copy = structuredClone(record)
        write(copy[keyPath], copy)
        return copy[keyPath]
      }),
      getAll: () => request(tx, () => [...rows.values()].map((row) => structuredClone(row))),
      count: (key: unknown) => request(tx, () => (rows.has(key) ? 1 : 0)),
      delete: (key: unknown) => request(tx, () => {
        write(key, null)
      }),
      openCursor: () => openCursor(tx, rows, write),
    }
  }

  function openCursor(tx: FakeTx, rows: Map<unknown, Row>, write: (key: unknown, next: Row | null) => void): FakeRequest {
    const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
    const keys = [...rows.keys()]
    let at = 0
    const cursorOn = (key: unknown) => ({
      key,
      value: structuredClone(rows.get(key) as Row),
      delete: () => write(key, null),
      update: (next: Row) => write(key, structuredClone(next)),
      continue: () => walk(),
    })
    const deliver = () => {
      if (tx.state === 'active') {
        while (at < keys.length && !rows.has(keys[at])) at++
        req.result = at < keys.length ? cursorOn(keys[at++]) : null
        req.onsuccess?.()
      }
      tx.pending--
      settle(tx)
    }
    const walk = () => {
      tx.pending++
      setTimeout(deliver, 0)
    }
    tx.pending++
    setTimeout(deliver, 0)
    return req
  }

  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      return {}
    },
    transaction: () => {
      const tx: FakeTx = {
        pending: 0,
        state: 'active',
        undo: [],
        error: null,
        oncomplete: null,
        onabort: null,
        objectStore: (name: string) => storeOf(tx, name),
      }
      settle(tx)
      return tx
    },
    close: () => {},
  }

  return {
    factory: {
      open: (): FakeRequest => {
        const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
        setTimeout(() => {
          req.result = database
          req.onupgradeneeded?.()
          req.onsuccess?.()
        }, 0)
        return req
      },
    },
    rows: (name: string) => [...(stores.get(name)?.values() ?? [])].map((row) => structuredClone(row)),
  }
}
