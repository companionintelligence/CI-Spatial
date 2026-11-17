/**
 * A small in-memory IndexedDB for the tests that run the phone's frame code (src/project/project-store.ts and
 * src/project/frame-sync.ts) for real, in the style of wp-store-erase.test.ts: a request takes effect in order
 * and reports afterwards, transactions on one database run one at a time, a failed request aborts its
 * transaction and undoes its writes, a database upgrades by version and refuses to while another connection is
 * open, a connection that is closing refuses new transactions, and a failure can be injected at any request.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import { ProjectStore } from '../../../../src/project/project-store.ts'

// ── A small IndexedDB ────────────────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>
export type Op = 'put' | 'get' | 'getAll' | 'delete'

export interface StoreSpec {
  name: string
  keyPath: string
  indexes?: Record<string, string>
  rows?: Row[]
}

export interface FakeStoreState {
  keyPath: string
  indexes: Map<string, string>
  rows: Map<unknown, Row>
}

export interface FakeDbState {
  version: number
  stores: Map<string, FakeStoreState>
}

export class FakeRequest {
  result: unknown = undefined
  error: unknown = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
  onblocked: (() => void) | null = null
}

export class FakeTx {
  ops: Array<() => void> = []
  undo: Array<() => void> = []
  aborted = false
  error: unknown = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  readonly connection: FakeConnection
  readonly stores: string[]
  constructor(connection: FakeConnection, stores: string[]) {
    this.connection = connection
    this.stores = stores
  }

  objectStore(name: string) {
    const state = this.connection.state.stores.get(name)
    if (!state) throw new Error(`NotFoundError: no object store ${name}`)
    const request = (op: Op, effect: () => unknown) => this.connection.fake.request(this, name, op, effect)
    const write = (key: unknown, next: Row | null) => {
      const before = state.rows.get(key)
      this.undo.push(() => (before ? state.rows.set(key, before) : state.rows.delete(key)))
      if (next) state.rows.set(key, next)
      else state.rows.delete(key)
    }
    return {
      keyPath: state.keyPath,
      put: (record: Row) => {
        // The spec throws DataError at the call when the record has no value at its key path.
        if (record[state.keyPath] === undefined) throw new Error('DataError: the record has no key')
        const copy = structuredClone(record)
        return request('put', () => {
          write(copy[state.keyPath], copy)
          return copy[state.keyPath]
        })
      },
      get: (key: unknown) => request('get', () => structuredClone(state.rows.get(key))),
      getAll: () => request('getAll', () => [...state.rows.values()].map((row) => structuredClone(row))),
      delete: (key: unknown) => request('delete', () => write(key, null)),
      index: (indexName: string) => ({
        getAll: (value: unknown) =>
          request('getAll', () => {
            const path = state.indexes.get(indexName)!
            return [...state.rows.values()].filter((row) => row[path] === value).map((row) => structuredClone(row))
          }),
      }),
    }
  }
}

export class FakeConnection {
  onversionchange: ((event: { oldVersion: number; newVersion: number | null }) => void) | null = null
  closed = false
  readonly fake: FakeIndexedDB
  readonly name: string
  readonly state: FakeDbState
  constructor(fake: FakeIndexedDB, name: string, state: FakeDbState) {
    this.fake = fake
    this.name = name
    this.state = state
  }
  get version() {
    return this.state.version
  }
  readonly objectStoreNames = { contains: (store: string) => this.state.stores.has(store) }
  createObjectStore(store: string, options: { keyPath: string }) {
    const created: FakeStoreState = { keyPath: options.keyPath, indexes: new Map(), rows: new Map() }
    this.state.stores.set(store, created)
    return { createIndex: (index: string, keyPath: string) => void created.indexes.set(index, keyPath) }
  }
  transaction(stores: string | string[]): FakeTx {
    // As a real connection does once it is closing: a store that kept using one would fail here.
    if (this.closed) throw new Error('InvalidStateError: the database connection is closing')
    const tx = new FakeTx(this, Array.isArray(stores) ? stores : [stores])
    for (const store of tx.stores) if (!this.state.stores.has(store)) throw new Error(`NotFoundError: no object store ${store}`)
    this.fake.enqueue(tx)
    return tx
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.fake.release(this)
  }
}

export class FakeIndexedDB {
  readonly databases = new Map<string, FakeDbState>()
  readonly connections = new Map<string, Set<FakeConnection>>()
  /** Open requests waiting for a connection to let go. */
  private readonly waiting = new Map<string, Array<() => void>>()
  private readonly queue: FakeTx[] = []
  private pumping = false
  private readonly failures: Array<{ store: string; op: Op; error: Error; abortOnly: boolean }> = []
  /** How many times an open request reported `blocked`. */
  blockedCount = 0

  /** Installed as the global `indexedDB` that the store opens. */
  readonly factory = { open: (name: string, version: number) => this.open(name, version) }

  /** A database as an older build left it, at `version`, with its stores, indexes and rows. */
  seed(name: string, version: number, stores: StoreSpec[]): void {
    const state: FakeDbState = { version, stores: new Map() }
    for (const spec of stores) {
      state.stores.set(spec.name, {
        keyPath: spec.keyPath,
        indexes: new Map(Object.entries(spec.indexes ?? {})),
        rows: new Map((spec.rows ?? []).map((row) => [row[spec.keyPath], structuredClone(row)])),
      })
    }
    this.databases.set(name, state)
  }

  /** The rows now in a store of a database, copied. */
  rows(name: string, store: string): Row[] {
    return [...(this.databases.get(name)?.stores.get(store)?.rows.values() ?? [])].map((row) => structuredClone(row))
  }

  stores(name: string): string[] {
    return [...(this.databases.get(name)?.stores.keys() ?? [])].sort()
  }

  /**
   * The next `op` on `store` fails once with `error`, as a full disk or a private window makes it. With
   * `abortOnly` the request reports no error and the transaction just aborts, as one does when the browser
   * cannot commit it (the quota is hit at the end, not at the request).
   */
  failNext(store: string, op: Op, error = new Error('QuotaExceededError'), abortOnly = false): void {
    this.failures.push({ store, op, error, abortOnly })
  }

  /** An open connection as an older build holds it: it never offers to close. */
  async connect(name: string, version: number): Promise<FakeConnection> {
    return await new Promise((resolveOpen, rejectOpen) => {
      const request = this.open(name, version)
      request.onsuccess = () => resolveOpen(request.result as FakeConnection)
      request.onerror = () => rejectOpen(request.error)
    })
  }

  open(name: string, version: number): FakeRequest {
    const request = new FakeRequest()
    const attempt = () => {
      const state = this.databases.get(name)
      const current = state?.version ?? 0
      if (version < current) {
        request.error = new Error('VersionError')
        request.onerror?.()
        return
      }
      const others = [...(this.connections.get(name) ?? [])]
      if (version > current && others.length > 0) {
        for (const other of others) other.onversionchange?.({ oldVersion: current, newVersion: version })
        if ((this.connections.get(name)?.size ?? 0) > 0) {
          this.blockedCount += 1
          request.onblocked?.()
          this.waiting.set(name, [...(this.waiting.get(name) ?? []), attempt])
          return
        }
      }
      const target = state ?? { version: 0, stores: new Map<string, FakeStoreState>() }
      this.databases.set(name, target)
      const connection = new FakeConnection(this, name, target)
      request.result = connection
      if (version > current) {
        target.version = version
        request.onupgradeneeded?.()
      }
      this.connections.set(name, (this.connections.get(name) ?? new Set()).add(connection))
      request.onsuccess?.()
    }
    queueMicrotask(attempt)
    return request
  }

  release(connection: FakeConnection): void {
    this.connections.get(connection.name)?.delete(connection)
    const waiting = this.waiting.get(connection.name) ?? []
    this.waiting.delete(connection.name)
    for (const retry of waiting) queueMicrotask(retry)
  }

  enqueue(tx: FakeTx): void {
    this.queue.push(tx)
    queueMicrotask(() => void this.pump())
  }

  request(tx: FakeTx, store: string, op: Op, effect: () => unknown): FakeRequest {
    const request = new FakeRequest()
    tx.ops.push(() => {
      const at = this.failures.findIndex((failure) => failure.store === store && failure.op === op)
      if (at >= 0) {
        const failure = this.failures.splice(at, 1)[0]!
        request.error = failure.error
        if (!failure.abortOnly) request.onerror?.()
        this.abort(tx, request.error, !failure.abortOnly)
        return
      }
      request.result = effect()
      request.onsuccess?.()
    })
    return request
  }

  private abort(tx: FakeTx, error: unknown, reportError = true): void {
    tx.aborted = true
    tx.error = error
    for (const undo of tx.undo.reverse()) undo()
    if (reportError) tx.onerror?.()
    tx.onabort?.()
  }

  /** One transaction at a time, each running its requests in the order they were made, each reporting on its own turn. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    while (this.queue.length > 0) {
      const tx = this.queue.shift()!
      await Promise.resolve()
      while (tx.ops.length > 0 && !tx.aborted) {
        const op = tx.ops.shift()!
        await Promise.resolve()
        op()
      }
      if (!tx.aborted) tx.oncomplete?.()
    }
    this.pumping = false
  }
}

export const DB = 'ci-xr-projects'

export function install(): FakeIndexedDB {
  const fake = new FakeIndexedDB()
  ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = fake.factory
  return fake
}

export async function opened(): Promise<{ fake: FakeIndexedDB; store: ProjectStore }> {
  const fake = install()
  const store = new ProjectStore()
  await store.open()
  return { fake, store }
}

/** Let the microtasks and the one task a request needs to report run. */
export const settle = () => new Promise<void>((done) => setImmediate(done))

