/**
 * WP-17a: the device-local list of persistent-anchor UUIDs (Quest Browser) and the helpers that keep and restore anchors
 * through it. The list is one localStorage key holding at most 5 entries. It must survive corrupt content and blocked
 * storage, never claim a save that did not happen, never leave the browser holding an anchor that nothing here can name, and
 * never drop an entry because of something the browser cannot be trusted to say (its own list of what it holds).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-17a-anchor-persistence.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANCHOR_FORGET_AFTER_AGE_MS,
  ANCHOR_FORGET_AFTER_REFUSALS,
  MAX_PERSISTENT_ANCHORS,
  createPersistentAnchorStore,
  forgetPersistedAnchor,
  persistAnchor,
  restoreAnchors,
  type AnchorCapability,
  type AnchorHandle,
  type PersistedAnchor,
  type PersistentAnchorStore,
  type RestoreResult,
} from '../../../src/ar/anchors.ts'
import { RUNTIME_ANCHOR_STORE_KEY } from '../../../src/shared/storage-keys.ts'

/** A Storage stand-in that remembers every key it was asked for, and can be made to fail. */
class MemoryStorage {
  items = new Map<string, string>()
  touched = new Set<string>()
  failReads = false
  failWrites = false
  getItem(key: string): string | null {
    this.touched.add(key)
    if (this.failReads) throw Object.assign(new Error('storage is blocked'), { name: 'SecurityError' })
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.touched.add(key)
    if (this.failWrites) throw Object.assign(new Error('storage is full'), { name: 'QuotaExceededError' })
    this.items.set(key, String(value))
  }
  removeItem(key: string): void {
    this.touched.add(key)
    this.items.delete(key)
  }
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const entry = (n: number, extra: Partial<PersistedAnchor> = {}): PersistedAnchor => ({
  uuid: uuid(n),
  projectId: 'place-a',
  role: 'landmark',
  savedAtMs: 1_000 + n,
  ...extra,
})

/** What the browser does with a restore of one uuid. */
type Restoring = 'places' | 'refuses' | 'silent'

/**
 * A capability that behaves like a browser keeping anchors, with the failures a test needs switched on. It records what it
 * was asked, in order, so a test can tell what the helpers did to the browser. What it lists (persistentAnchorIds) is
 * separate from what it holds (kept) and from how it answers a restore (restoring): the three disagree on a real Quest.
 */
class FakeKeeper implements AnchorCapability {
  supportsPersistence: boolean
  /** What the browser holds. A restore of anything else is refused. */
  kept = new Set<string>()
  /** What persistentAnchorIds() says. Null: the browser does not say. */
  listed: string[] | null = []
  refuseHandles = false
  /** Refuses deletePersistentAnchor, as a browser that is busy or has lost the anchor does. */
  refuseDeletes = false
  /** How a restore of one uuid ends. Anything not set is placed if the browser holds it, and refused if it does not. */
  restoring = new Map<string, Restoring>()
  /** What persistentIdOf says per handle, besides what requestPersistentHandle has given. */
  calls: string[] = []
  private handles = new Map<AnchorHandle, string>()
  private next = 1
  constructor(supportsPersistence = true) {
    this.supportsPersistence = supportsPersistence
  }
  createAnchor(): Promise<AnchorHandle | null> {
    return Promise.resolve({ id: `h${this.next++}` })
  }
  anchorPose(): null {
    return null
  }
  anchorDisplacement(): null {
    return null
  }
  rebase(): void {}
  release(): void {}
  onMoved(): () => void {
    return () => undefined
  }
  onLost(): () => void {
    return () => undefined
  }
  onReturned(): () => void {
    return () => undefined
  }
  onExpired(): () => void {
    return () => undefined
  }
  requestPersistentHandle(handle: AnchorHandle): Promise<string | null> {
    this.calls.push('request')
    if (this.refuseHandles) return Promise.resolve(null)
    let id = this.handles.get(handle)
    if (!id) {
      id = uuid(100 + this.handles.size)
      this.handles.set(handle, id)
    }
    this.kept.add(id)
    return Promise.resolve(id)
  }
  persistentIdOf(handle: AnchorHandle): string | null {
    return this.handles.get(handle) ?? null
  }
  restorePersistentAnchor(id: string): Promise<RestoreResult> {
    this.calls.push(`restore:${id}`)
    const how = this.restoring.get(id) ?? (this.kept.has(id) ? 'places' : 'refuses')
    if (how === 'refuses') return Promise.resolve({ status: 'refused' })
    if (how === 'silent') return Promise.resolve({ status: 'no-answer' })
    return Promise.resolve({ status: 'restored', handle: { id: `restored-${id}` } })
  }
  deletePersistentAnchor(id: string): Promise<boolean> {
    this.calls.push(`delete:${id}`)
    if (this.refuseDeletes) return Promise.resolve(false)
    return Promise.resolve(this.kept.delete(id))
  }
  persistentAnchorIds(): readonly string[] | null {
    return this.listed
  }
}

const OWNER = { projectId: 'place-a', role: 'landmark' }
const WEEK = ANCHOR_FORGET_AFTER_AGE_MS

// --- the list ----------------------------------------------------------------------------------------------------------------

test('the list keeps entries whole under one declared key, with a version, and touches nothing else', () => {
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  assert.deepEqual(store.list(), [])
  assert.deepEqual(store.save(entry(1, { frameId: 'frame-7' })), { ok: true })
  assert.deepEqual(store.save(entry(2)), { ok: true })

  assert.deepEqual(store.list(), [entry(1, { frameId: 'frame-7' }), entry(2)])
  const raw = JSON.parse(storage.items.get(RUNTIME_ANCHOR_STORE_KEY)!)
  assert.equal(raw.version, 1)
  assert.equal(raw.anchors.length, 2)
  assert.deepEqual([...storage.touched], [RUNTIME_ANCHOR_STORE_KEY], 'one key, no other')
})

test('the storage key is frozen: a renamed key would orphan every anchor the browser is still holding', () => {
  assert.equal(RUNTIME_ANCHOR_STORE_KEY, 'companion-scan-runtime-anchors')
})

test('the list holds at most 5, the lowest cap anyone reports for Quest Browser: a sixth new uuid is refused, a known uuid is still replaced, and a removal makes room', () => {
  assert.equal(MAX_PERSISTENT_ANCHORS, 5, 'reports of the Quest Browser cap are 5, 6 and 8: the list stays under the lowest')
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  for (let n = 1; n <= MAX_PERSISTENT_ANCHORS; n++) assert.deepEqual(store.save(entry(n)), { ok: true }, `entry ${n}`)

  const sixth = MAX_PERSISTENT_ANCHORS + 1
  const before = storage.items.get(RUNTIME_ANCHOR_STORE_KEY)
  assert.deepEqual(store.save(entry(sixth)), { ok: false, reason: 'full' })
  assert.equal(storage.items.get(RUNTIME_ANCHOR_STORE_KEY), before, 'a refused save writes nothing')
  assert.equal(store.list().length, 5)

  assert.deepEqual(store.save(entry(3, { role: 'heading-marker' })), { ok: true }, 'a full list can still update its own entry')
  assert.equal(store.list().length, 5)
  assert.equal(store.list()[2].role, 'heading-marker', 'in place, not moved to the end')

  assert.equal(store.remove(uuid(1)), true)
  assert.deepEqual(store.save(entry(sixth)), { ok: true })
  assert.equal(store.list().length, 5)
  assert.equal(store.remove(uuid(404)), false, 'removing what is not there is false')
})

test('a list written under the old cap of 8 still reads whole and restores whole: the lower cap only refuses new entries', async () => {
  // The previous build kept up to 8. The 6th to the 8th are anchors the browser may still hold, so nothing may drop or hide them now.
  const storage = new MemoryStorage()
  const written = Array.from({ length: 8 }, (_, i) => entry(i + 1))
  storage.items.set(RUNTIME_ANCHOR_STORE_KEY, JSON.stringify({ version: 1, anchors: written }))
  const store = createPersistentAnchorStore(storage)
  assert.deepEqual(store.list(), written, 'all eight read back')
  assert.deepEqual(store.save(entry(9)), { ok: false, reason: 'full' }, 'a new uuid is refused')
  assert.deepEqual(store.save(entry(7, { refusals: 1 })), { ok: true }, 'a uuid the list holds is still updated in place')
  assert.equal(store.list().length, 8)

  const keeper = new FakeKeeper()
  for (const kept of written) keeper.kept.add(kept.uuid)
  const outcome = await restoreAnchors(keeper, store, { projectId: 'place-a' })
  assert.equal(outcome.restored.length, 8, 'every entry is asked for, the ones beyond the cap included')

  // Taking the list down to 4 makes room for one more, and the fifth entry fills it: the cap is 5, not the 8 that wrote it.
  for (let n = 1; n <= 4; n++) assert.equal(store.remove(uuid(n)), true)
  assert.equal(store.list().length, 4)
  assert.deepEqual(store.save(entry(9)), { ok: true })
  assert.deepEqual(store.save(entry(10)), { ok: false, reason: 'full' })
})

test('the cap and the scope are explained where they are set: the three reported caps, and where anchors exist and where they are inert', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/ar/anchors.ts'), 'utf8')
  /** A comment as a reader sees it: the line breaks and the leading asterisks folded into single spaces. */
  const folded = (text: string): string => text.replace(/\s*\n\s*\*\s*/g, ' ')
  const capComment = folded(source.slice(0, source.indexOf('export const MAX_PERSISTENT_ANCHORS')).split('/**').pop()!)
  for (const report of ['a site can hold 8', '5 UUIDs per origin', 'about 6', 'across all origins']) {
    assert.ok(capComment.includes(report), `the comment on the cap no longer gives the report "${report}"`)
  }
  assert.match(capComment, /Adopted, not measured \(ADR 0005 rule 5\)/)
  assert.match(capComment, /DX6/)
  const header = folded(source.slice(0, source.indexOf("import { wrapDeg")))
  const scope = header.slice(header.indexOf('Scope.'), header.indexOf('A runtime anchor is not the calibration anchor'))
  assert.ok(scope.length > 100, 'the header has a Scope paragraph before the note on the calibration anchor')
  for (const place of ['Chrome on Android', 'Quest Browser', 'Android XR Chrome']) assert.ok(scope.includes(place), `the scope names ${place}`)
  for (const inert of ['Capacitor', 'WebViews', 'iPhone']) assert.ok(scope.includes(inert), `the scope says anchors are inert in ${inert}`)
  assert.match(scope, /inert/)
})

test('saving an entry whose uuid is the first on the list replaces it, on a list with room and on a full one', () => {
  for (const count of [3, MAX_PERSISTENT_ANCHORS]) {
    const store = createPersistentAnchorStore(new MemoryStorage())
    for (let n = 1; n <= count; n++) store.save(entry(n))
    assert.deepEqual(store.save(entry(1, { role: 'heading-marker', savedAtMs: 99 })), { ok: true }, `${count} entries`)
    const list = store.list()
    assert.equal(list.length, count, 'replaced, not added beside the old one')
    assert.deepEqual(list[0], entry(1, { role: 'heading-marker', savedAtMs: 99 }), 'the new content is what is read back')
  }
})

test('content that is corrupt reads as an empty list, and the next save writes a good one over it', () => {
  const corrupt = ['not json{', '"just a string"', 'null', '[]', '{}', '{"anchors":"nope"}', '{"anchors":{"a":1}}', '42']
  for (const raw of corrupt) {
    const storage = new MemoryStorage()
    storage.items.set(RUNTIME_ANCHOR_STORE_KEY, raw)
    const store = createPersistentAnchorStore(storage)
    assert.deepEqual(store.list(), [], `reads as empty: ${raw}`)
    assert.deepEqual(store.save(entry(1)), { ok: true }, `heals: ${raw}`)
    assert.deepEqual(store.list(), [entry(1)])
  }
})

test('one malformed entry costs only itself: the others, in order, are still read', () => {
  const storage = new MemoryStorage()
  storage.items.set(
    RUNTIME_ANCHOR_STORE_KEY,
    JSON.stringify({
      version: 1,
      anchors: [
        entry(1),
        { ...entry(2), role: '' },
        { ...entry(3), savedAtMs: null },
        { ...entry(4), uuid: 'x'.repeat(300) },
        null,
        'a string',
        entry(1, { role: 'a later copy of the first uuid' }),
        { ...entry(5), frameId: 7 },
        entry(6, { frameId: 'frame-2' }),
      ],
    }),
  )
  const store = createPersistentAnchorStore(storage)
  assert.deepEqual(store.list(), [entry(1), entry(5), entry(6, { frameId: 'frame-2' })])
})

test('a text field is kept up to 256 characters and refused beyond, so a corrupt value cannot fill the key', () => {
  const store = createPersistentAnchorStore(new MemoryStorage())
  assert.deepEqual(store.save(entry(1, { role: 'r'.repeat(256) })), { ok: true })
  assert.deepEqual(store.save(entry(2, { role: 'r'.repeat(257) })), { ok: false, reason: 'invalid' })
  assert.deepEqual(store.save(entry(3, { frameId: 'f'.repeat(256) })), { ok: true })
  assert.equal(store.list().length, 2)
})

test('the count of refusals is kept when it is a positive whole number, and read as none otherwise', () => {
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  assert.deepEqual(store.save(entry(1, { refusals: 2 })), { ok: true })
  assert.deepEqual(store.list(), [entry(1, { refusals: 2 })])
  assert.deepEqual(store.save(entry(1, { refusals: 0 })), { ok: true })
  assert.deepEqual(store.list(), [entry(1)], 'zero is the same as none')

  storage.items.set(
    RUNTIME_ANCHOR_STORE_KEY,
    JSON.stringify({ version: 1, anchors: [entry(1, { refusals: -1 }), entry(2, { refusals: 1.5 }), entry(3, { refusals: '3' as unknown as number }), entry(4, { refusals: 4 })] }),
  )
  assert.deepEqual(store.list(), [entry(1), entry(2), entry(3), entry(4, { refusals: 4 })], 'a count that is not a whole number above zero costs only the count')
})

test('storage that cannot be read gives an empty list and refuses to save, so what is stored is never overwritten blind', () => {
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  store.save(entry(1))
  const kept = storage.items.get(RUNTIME_ANCHOR_STORE_KEY)

  storage.failReads = true
  assert.deepEqual(store.list(), [])
  assert.deepEqual(store.save(entry(2)), { ok: false, reason: 'storage-unavailable' })
  assert.equal(store.remove(uuid(1)), false)
  assert.equal(storage.items.get(RUNTIME_ANCHOR_STORE_KEY), kept, 'nothing was written')
})

test('storage that cannot be written says so, and the list stays as it was', () => {
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  store.save(entry(1))

  storage.failWrites = true
  assert.deepEqual(store.save(entry(2)), { ok: false, reason: 'storage-unavailable' })
  assert.equal(store.remove(uuid(1)), false, 'a removal that could not be written did not happen')
  storage.failWrites = false
  assert.deepEqual(store.list(), [entry(1)])
})

test('with no storage given the list uses localStorage, and a localStorage that throws on access is a refusal, not an exception', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw Object.assign(new Error('access is denied'), { name: 'SecurityError' })
      },
    })
    const blocked = createPersistentAnchorStore()
    assert.deepEqual(blocked.list(), [])
    assert.deepEqual(blocked.save(entry(1)), { ok: false, reason: 'storage-unavailable' })
    assert.equal(blocked.remove(uuid(1)), false)

    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    const open = createPersistentAnchorStore()
    assert.deepEqual(open.save(entry(1)), { ok: true })
    assert.ok(storage.items.has(RUNTIME_ANCHOR_STORE_KEY), 'it wrote to localStorage')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('an entry that could not be read back is refused up front, with nothing written', () => {
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  for (const bad of [
    { ...entry(1), uuid: '' },
    { ...entry(1), projectId: '' },
    { ...entry(1), role: '' },
    { ...entry(1), savedAtMs: Number.NaN },
    { ...entry(1), uuid: 'u'.repeat(300) },
  ]) {
    assert.deepEqual(store.save(bad), { ok: false, reason: 'invalid' })
  }
  assert.equal(storage.items.size, 0)
})

// --- keeping an anchor ---------------------------------------------------------------------------------------------------------

test('persistAnchor asks the browser for a handle and writes down what it marks; asking again for the same anchor adds nothing', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  const handle = (await keeper.createAnchor())!

  const first = await persistAnchor(keeper, store, handle, { ...OWNER, frameId: 'frame-9' }, 5_000)
  assert.equal(first.ok, true)
  const kept = store.list()
  assert.equal(kept.length, 1)
  assert.deepEqual(kept[0], { uuid: first.ok ? first.uuid : '', projectId: 'place-a', role: 'landmark', savedAtMs: 5_000, frameId: 'frame-9' })

  const again = await persistAnchor(keeper, store, handle, OWNER, 6_000)
  assert.deepEqual(again, first)
  assert.equal(store.list().length, 1, 'one anchor, one entry')
})

test('a runtime that cannot keep anchors is told so without being asked', async () => {
  const keeper = new FakeKeeper(false)
  const store = createPersistentAnchorStore(new MemoryStorage())
  assert.deepEqual(await persistAnchor(keeper, store, { id: 'h' }, OWNER), { ok: false, reason: 'unsupported' })
  assert.deepEqual(keeper.calls, [])
  assert.deepEqual(store.list(), [])
})

test('a browser that refuses the handle leaves the list alone', async () => {
  const keeper = new FakeKeeper()
  keeper.refuseHandles = true
  const store = createPersistentAnchorStore(new MemoryStorage())
  assert.deepEqual(await persistAnchor(keeper, store, { id: 'h' }, OWNER), { ok: false, reason: 'runtime-refused' })
  assert.deepEqual(store.list(), [])
  assert.deepEqual(keeper.calls, ['request'], 'nothing was kept, so nothing is given back')
})

test('when the list is full an anchor with no handle yet is refused before the browser is asked: no slot is spent and the live anchor is left alone', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  for (let n = 1; n <= MAX_PERSISTENT_ANCHORS; n++) store.save(entry(n))

  const outcome = await persistAnchor(keeper, store, { id: 'sixth' }, OWNER)
  assert.deepEqual(outcome, { ok: false, reason: 'store-full' })
  assert.deepEqual(keeper.calls, [], 'the browser was not asked for a sixth handle, so it has nothing to give back')
  assert.equal(keeper.kept.size, 0)
  assert.equal(store.list().length, MAX_PERSISTENT_ANCHORS)
})

test('when the list is full an anchor that already has its handle on the list is still accepted', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  const handle = (await keeper.createAnchor())!
  assert.equal((await persistAnchor(keeper, store, handle, OWNER, 1)).ok, true)
  const named = store.list()[0].uuid
  for (let n = 1; n < MAX_PERSISTENT_ANCHORS; n++) store.save(entry(n))
  assert.equal(store.list().length, MAX_PERSISTENT_ANCHORS)

  const again = await persistAnchor(keeper, store, handle, { projectId: 'place-a', role: 'heading-marker' }, 2)
  assert.deepEqual(again, { ok: true, uuid: named })
  assert.equal(store.list().find((e) => e.uuid === named)?.role, 'heading-marker', 'its entry was updated in place')
})

test('when another tab fills the list between the check and the save, the browser copy is given back', async () => {
  const keeper = new FakeKeeper()
  const racing: PersistentAnchorStore = { list: () => [], save: () => ({ ok: false, reason: 'full' }), remove: () => false }
  assert.deepEqual(await persistAnchor(keeper, racing, { id: 'h' }, OWNER), { ok: false, reason: 'store-full' })
  assert.deepEqual(keeper.calls, ['request', `delete:${uuid(100)}`])
  assert.equal(keeper.kept.size, 0)
})

test('when the list cannot be written the browser copy is given back, unless an earlier save already named it', async () => {
  const storage = new MemoryStorage()
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(storage)
  const handle = { id: 'h' }

  storage.failWrites = true
  assert.deepEqual(await persistAnchor(keeper, store, handle, OWNER), { ok: false, reason: 'storage-unavailable' })
  assert.deepEqual(keeper.calls, ['request', `delete:${uuid(100)}`])
  assert.equal(keeper.kept.size, 0, 'nothing is left in the browser')

  storage.failWrites = false
  keeper.calls.length = 0
  assert.equal((await persistAnchor(keeper, store, handle, OWNER)).ok, true)
  storage.failWrites = true
  assert.deepEqual(await persistAnchor(keeper, store, handle, OWNER), { ok: false, reason: 'storage-unavailable' })
  assert.ok(!keeper.calls.some((call) => call.startsWith('delete:')), 'an anchor an earlier save named is not deleted')
  assert.equal(keeper.kept.size, 1)
})

test('when the list cannot be written and the browser will not give the copy back, the failure names the uuid it is now holding unnamed', async () => {
  const storage = new MemoryStorage()
  const keeper = new FakeKeeper()
  keeper.refuseDeletes = true
  const store = createPersistentAnchorStore(storage)
  storage.failWrites = true
  assert.deepEqual(await persistAnchor(keeper, store, { id: 'h' }, OWNER), { ok: false, reason: 'storage-unavailable', orphanedUuid: uuid(100) })
  assert.equal(keeper.kept.size, 1, 'it really is still in the browser')

  const clean = new FakeKeeper()
  const outcome = await persistAnchor(clean, store, { id: 'g' }, OWNER)
  assert.equal('orphanedUuid' in outcome, false, 'a rollback that worked leaves nothing to report')
})

test('a handle the list cannot hold is treated as a refusal, and the browser copy is given back', async () => {
  const keeper = new FakeKeeper()
  keeper.requestPersistentHandle = (handle) => {
    keeper.calls.push('request')
    void handle
    keeper.kept.add('u'.repeat(300))
    return Promise.resolve('u'.repeat(300))
  }
  const store = createPersistentAnchorStore(new MemoryStorage())
  assert.deepEqual(await persistAnchor(keeper, store, { id: 'h' }, OWNER), { ok: false, reason: 'runtime-refused' })
  assert.deepEqual(keeper.calls, ['request', `delete:${'u'.repeat(300)}`])
})

// --- bringing them back -----------------------------------------------------------------------------------------------------------

/** A list holding `entries`, and a browser that holds them all. */
function kept(keeper: FakeKeeper, store: PersistentAnchorStore, entries: PersistedAnchor[]): void {
  for (const e of entries) {
    store.save(e)
    keeper.kept.add(e.uuid)
  }
}

test('restoreAnchors brings back the entries of one Place, one at a time and in the order kept, and leaves the list as it was', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  const mine = [entry(1), entry(2, { role: 'heading-marker' })]
  const other = entry(3, { projectId: 'place-b' })
  kept(keeper, store, [mine[0], other, mine[1]])

  const outcome = await restoreAnchors(keeper, store, { projectId: 'place-a' })
  assert.equal(outcome.supported, true)
  assert.deepEqual(outcome.restored.map((r) => r.entry), mine)
  assert.deepEqual(outcome.restored.map((r) => r.handle.id), [`restored-${uuid(1)}`, `restored-${uuid(2)}`])
  assert.deepEqual(keeper.calls, [`restore:${uuid(1)}`, `restore:${uuid(2)}`], 'the other Place is not touched')
  assert.deepEqual(store.list().map((e) => e.uuid), [uuid(1), uuid(3), uuid(2)])
})

test('restoreAnchors can be narrowed to one frame, so anchors of a replaced frame are not brought back', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  kept(keeper, store, [entry(1, { frameId: 'old' }), entry(2, { frameId: 'new' }), entry(3)])
  const outcome = await restoreAnchors(keeper, store, { projectId: 'place-a', frameId: 'new' })
  assert.deepEqual(outcome.restored.map((r) => r.entry.uuid), [uuid(2)])
})

test('every entry is asked for whatever the browser lists: an empty, blank, missing or wrong list never costs an anchor the browser still holds', async () => {
  for (const listed of [[], [''], ['', ''], null, [uuid(77)]]) {
    const keeper = new FakeKeeper()
    keeper.listed = listed
    const store = createPersistentAnchorStore(new MemoryStorage())
    kept(keeper, store, [entry(1), entry(2)])
    const outcome = await restoreAnchors(keeper, store)
    assert.deepEqual(outcome.restored.map((r) => r.entry.uuid), [uuid(1), uuid(2)], `listed ${JSON.stringify(listed)}`)
    assert.deepEqual(outcome.forgotten, [])
    assert.deepEqual(store.list().map((e) => e.uuid), [uuid(1), uuid(2)])
    assert.deepEqual(keeper.calls, [`restore:${uuid(1)}`, `restore:${uuid(2)}`], 'and the browser really was asked')
  }
})

test('an entry the browser does not place stays on the list: it may be placeable in another session or another room', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  kept(keeper, store, [entry(1), entry(2), entry(3)])
  keeper.restoring.set(uuid(2), 'silent')

  const outcome = await restoreAnchors(keeper, store)
  assert.deepEqual(outcome.restored.map((r) => r.entry.uuid), [uuid(1), uuid(3)])
  assert.deepEqual(outcome.unresolved.map((e) => e.uuid), [uuid(2)])
  assert.deepEqual(outcome.forgotten, [])
  assert.deepEqual(store.list().map((e) => e.uuid), [uuid(1), uuid(2), uuid(3)])
  assert.equal(store.list()[1].refusals, undefined, 'a browser that did not answer has not refused anything')
})

test('a refusal counts against an entry once per session however often the helper is run, and a session with no answer counts for nothing', async () => {
  const store = createPersistentAnchorStore(new MemoryStorage())
  store.save(entry(1))
  const session = new FakeKeeper()
  for (let run = 0; run < 4; run++) await restoreAnchors(session, store, {}, 50)
  assert.equal(store.list()[0].refusals, 1, 'four runs in one session are one refusal')

  const later = new FakeKeeper()
  later.restoring.set(uuid(1), 'silent')
  await restoreAnchors(later, store, {}, 50)
  assert.equal(store.list()[0].refusals, 1, 'silence is not a refusal')

  const next = new FakeKeeper()
  await restoreAnchors(next, store, {}, 50)
  assert.equal(store.list()[0].refusals, 2, 'the next session counts again')
  assert.deepEqual((await restoreAnchors(next, store, {}, 50)).unresolved.map((e) => e.refusals), [2], 'and reports the count it has')
})

test('an entry is dropped only after enough refusals in separate sessions AND enough age: either one short keeps it', async () => {
  assert.equal(ANCHOR_FORGET_AFTER_REFUSALS, 3)
  assert.equal(WEEK, 7 * 24 * 60 * 60 * 1000)
  const fresh = entry(1, { savedAtMs: 0 })
  const cases: Array<[string, number, number, boolean]> = [
    // [what is short, refusals before this session, now, dropped?]
    ['two refusals on an old entry', 0, WEEK + 1, false],
    ['three refusals on an entry a millisecond short of a week', 2, WEEK - 1, false],
    ['three refusals on an entry exactly a week old', 2, WEEK, true],
    ['three refusals on an old entry', 2, 5 * WEEK, true],
    ['four refusals on an old entry', 3, 5 * WEEK, true],
  ]
  for (const [name, before, now, dropped] of cases) {
    const store = createPersistentAnchorStore(new MemoryStorage())
    store.save(before ? { ...fresh, refusals: before } : fresh)
    const outcome = await restoreAnchors(new FakeKeeper(), store, {}, now)
    assert.equal(outcome.forgotten.length === 1, dropped, name)
    assert.equal(store.list().length, dropped ? 0 : 1, name)
    if (dropped) assert.equal(outcome.forgotten[0].uuid, uuid(1))
    else assert.deepEqual(outcome.unresolved.map((e) => e.refusals), [before + 1], name)
  }
})

test('a restore that works clears the count of refusals, and an entry the list cannot rewrite is still reported, not lost', async () => {
  const storage = new MemoryStorage()
  const store = createPersistentAnchorStore(storage)
  store.save(entry(1, { refusals: 2 }))
  const keeper = new FakeKeeper()
  keeper.kept.add(uuid(1))
  const outcome = await restoreAnchors(keeper, store, {}, 5 * WEEK)
  assert.equal(outcome.restored.length, 1)
  assert.deepEqual(store.list(), [entry(1)], 'the next refusal starts from none')

  store.save(entry(2, { refusals: 1 }))
  storage.failWrites = true
  const failing = await restoreAnchors(new FakeKeeper(), store, { projectId: 'place-a' }, 5 * WEEK)
  assert.deepEqual(failing.unresolved.map((e) => e.uuid), [uuid(1), uuid(2)], 'a count that cannot be written costs only the count')
  assert.deepEqual(failing.forgotten, [])
})

test('a runtime that cannot keep anchors restores nothing and leaves the list for the browser that can', async () => {
  const keeper = new FakeKeeper(false)
  const store = createPersistentAnchorStore(new MemoryStorage())
  store.save(entry(1))
  const outcome = await restoreAnchors(keeper, store)
  assert.deepEqual(outcome, { supported: false, restored: [], unresolved: [], forgotten: [] })
  assert.deepEqual(keeper.calls, [])
  assert.equal(store.list().length, 1)
})

test('forgetPersistedAnchor deletes in the browser and on the list, and reports each half', async () => {
  const keeper = new FakeKeeper()
  const store = createPersistentAnchorStore(new MemoryStorage())
  store.save(entry(1))
  keeper.kept.add(uuid(1))

  assert.deepEqual(await forgetPersistedAnchor(keeper, store, uuid(1)), { runtime: true, store: true })
  assert.deepEqual(store.list(), [])
  assert.equal(keeper.kept.size, 0)
  assert.deepEqual(await forgetPersistedAnchor(keeper, store, uuid(1)), { runtime: false, store: false })

  const mute = new FakeKeeper(false)
  store.save(entry(2))
  assert.deepEqual(await forgetPersistedAnchor(mute, store, uuid(2)), { runtime: false, store: true })
  assert.deepEqual(mute.calls, [], 'a runtime that cannot keep anchors is not asked to delete one')
})

test('forgetPersistedAnchor keeps the list entry while the browser still holds the anchor, so nothing is left that nothing can name', async () => {
  const keeper = new FakeKeeper()
  keeper.refuseDeletes = true
  const store = createPersistentAnchorStore(new MemoryStorage())
  store.save(entry(1))
  keeper.kept.add(uuid(1))

  assert.deepEqual(await forgetPersistedAnchor(keeper, store, uuid(1)), { runtime: false, store: false })
  assert.deepEqual(store.list().map((e) => e.uuid), [uuid(1)], 'the way to try again is still there')
  assert.equal(keeper.kept.size, 1)

  keeper.refuseDeletes = false
  assert.deepEqual(await forgetPersistedAnchor(keeper, store, uuid(1)), { runtime: true, store: true })
})
