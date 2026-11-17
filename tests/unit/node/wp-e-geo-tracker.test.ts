/**
 * GeoTracker's address rules (src/geo/geo-tracker.ts, F117). An address belongs to the cell it was
 * looked up for. A fix in a new cell starts without one, a reply for a cell the walk has left is not
 * shown on the current fix, one lookup per cell runs at a time, and a cell whose lookup failed waits
 * before it is asked again. GPS, sessionStorage and the lookup are stand-ins, so nothing reaches the
 * network.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e-geo-tracker.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { GeoTracker, type GeoFix } from '../../../src/geo/geo-tracker.ts'

interface FakePosition {
  coords: { latitude: number, longitude: number, accuracy: number, altitude: number | null }
  timestamp: number
}

/** The public read, plus the two private steps the address rules run through. The test reaches those through this view. */
interface Tracker {
  snapshot(): GeoFix | null
  _applyPosition(pos: FakePosition): GeoFix
  _geocode(fix: GeoFix): Promise<void>
}

const ROOM_A = { lat: 51.5, lng: -0.12 }
const ROOM_B = { lat: 51.6, lng: -0.3 }
const LONDON = {
  display_name: 'Abbey Road, London, United Kingdom',
  address: { road: 'Abbey Road', city: 'London', country: 'United Kingdom', country_code: 'gb' },
}

function at(place: { lat: number, lng: number }, nudge = 0): FakePosition {
  return {
    coords: { latitude: place.lat + nudge, longitude: place.lng, accuracy: 5, altitude: null },
    timestamp: 1_700_000_000_000,
  }
}

function newTracker(): Tracker {
  return new GeoTracker() as unknown as Tracker
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** Answers each lookup by its latitude, and records each request so a test can count them. */
function lookups(t: TestContext, answer: (lat: string, call: number) => Promise<Response>): string[] {
  const asked: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const lat = new URL(String(input)).searchParams.get('lat') ?? ''
    asked.push(lat)
    return answer(lat, asked.length)
  })
  return asked
}

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

test('a fix in a new cell starts without the address of the place it left', async (t) => {
  t.mock.method(console, 'warn', () => {})
  lookups(t, async () => json(LONDON))
  const geo = newTracker()
  await geo._geocode(geo._applyPosition(at(ROOM_A)))
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London', 'the first room gets its address')

  const moved = geo._applyPosition(at(ROOM_B))
  assert.equal(moved.address, null)
  assert.equal(moved.displayAddress, null)
  assert.equal(moved.addressComponents, null)
  assert.equal(geo.snapshot()?.address, null, 'nothing from the first room shows in the second')
})

test('a lookup that fails in a new room leaves that room without an address', async (t) => {
  t.mock.method(console, 'warn', () => {})
  lookups(t, async (lat) => (lat === '51.500000' ? json(LONDON) : json({ error: 'busy' }, 503)))
  const geo = newTracker()
  await geo._geocode(geo._applyPosition(at(ROOM_A)))
  const moved = geo._applyPosition(at(ROOM_B))
  await geo._geocode(moved)
  assert.equal(geo.snapshot()?.address, null, 'the old address is not left in place')
  assert.equal(moved.address, null)
})

test('a reply for a place the walk has left is not shown on the current fix, and is kept for its own place', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const late = deferred<Response>()
  const asked = lookups(t, () => late.promise)
  const geo = newTracker()
  const lookingUp = geo._geocode(geo._applyPosition(at(ROOM_A)))
  geo._applyPosition(at(ROOM_B))
  late.resolve(json(LONDON))
  await lookingUp
  assert.equal(geo.snapshot()?.address, null, 'the reply for room A is not shown in room B')
  assert.equal(geo.snapshot()?.lat, ROOM_B.lat)

  const back = geo._applyPosition(at(ROOM_A))
  await geo._geocode(back)
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London', 'the kept answer is used on return')
  assert.equal(asked.length, 1, 'room A was not asked a second time')
})

test('one lookup per cell at a time: a fix in a cell still waiting does not ask again', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const pending = deferred<Response>()
  const asked = lookups(t, () => pending.promise)
  const geo = newTracker()
  const first = geo._geocode(geo._applyPosition(at(ROOM_A)))
  const second = geo._geocode(geo._applyPosition(at(ROOM_A, 0.00001)))
  // The request is made, or not, before either call has awaited anything.
  assert.equal(asked.length, 1, 'the second fix in the same cell is not a second request')
  pending.resolve(json(LONDON))
  await Promise.all([first, second])
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London')
})

test('a cell whose lookup failed waits 5 s, then 10 s, before it is asked again', async (t) => {
  t.mock.method(console, 'warn', () => {})
  // The retry wait is measured on performance.now(), so that is the clock the test moves.
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const asked = lookups(t, async (_lat, call) => (call < 3 ? json({}, 503) : json(LONDON)))
  const geo = newTracker()
  const fix = geo._applyPosition(at(ROOM_A))

  await geo._geocode(fix) // try 1 fails: the wait is 5 s
  await geo._geocode(fix) // straight away: no request
  now += 4_999
  await geo._geocode(fix)
  assert.equal(asked.length, 1, 'no request in the first 5 s')

  now += 1
  await geo._geocode(fix) // try 2 fails: the wait is 10 s
  assert.equal(asked.length, 2)
  now += 9_999
  await geo._geocode(fix)
  assert.equal(asked.length, 2, 'no request in the next 10 s')

  now += 1
  await geo._geocode(fix) // try 3 answers
  assert.equal(asked.length, 3)
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London')

  await geo._geocode(fix) // answered, so it is kept and not asked again
  assert.equal(asked.length, 3)
})

test('a fix restored from an earlier session keeps its address only while the first new fix is in the same cell', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const earlier: GeoFix = {
    lat: ROOM_A.lat,
    lng: ROOM_A.lng,
    accuracy: 5,
    altitudeM: null,
    bearing: null,
    fixedAt: '2026-01-01T00:00:00.000Z',
    address: 'Old Street, Old Town',
    displayAddress: 'Old Street, Old Town, Nowhere',
    addressComponents: { city: 'Old Town' },
  }
  stubGlobal(t, 'sessionStorage', { getItem: () => JSON.stringify(earlier), setItem: () => {} })
  stubGlobal(t, 'window', { addEventListener: () => {} })
  // The first fix each start() receives. The test sets it before each start.
  let firstFix: FakePosition = at(ROOM_A)
  stubGlobal(t, 'navigator', {
    geolocation: {
      watchPosition: (onFix: (pos: FakePosition) => void) => {
        onFix(firstFix)
        return 1
      },
      clearWatch: () => {},
    },
  })
  // start() arms an 8 s fallback timer. It is held here so the test ends at once.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  lookups(t, () => new Promise<Response>(() => {}))

  // The same cell: about a metre from the restored fix, inside the same four-decimal cell.
  firstFix = at(ROOM_A, 0.00001)
  const same = await new GeoTracker().start()
  assert.equal(same?.address, 'Old Street, Old Town', 'the same room keeps the address it had')
  assert.equal(same?.displayAddress, 'Old Street, Old Town, Nowhere')
  assert.deepEqual(same?.addressComponents, { city: 'Old Town' })

  // A different cell: the restored address belongs to the place the fix came from, so it is cleared.
  firstFix = at(ROOM_B)
  const moved = await new GeoTracker().start()
  assert.equal(moved?.address, null, 'a new room starts without the old address')
  assert.equal(moved?.displayAddress, null)
  assert.equal(moved?.addressComponents, null)
})
