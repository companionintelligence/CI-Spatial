/**
 * GeoTracker writes a cached address to sessionStorage when it applies it (src/geo/geo-tracker.ts, E3-1).
 * A return to a cell that was looked up before is answered from the cache without a request, and the fix
 * it lands on must be stored with its address, so a reload after the return restores the address. The
 * lookup, sessionStorage and GPS are stand-ins, so nothing reaches the network.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e3-geo-cache-persist.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { GeoTracker, type GeoFix } from '../../../src/geo/geo-tracker.ts'

interface FakePosition {
  coords: { latitude: number, longitude: number, accuracy: number, altitude: number | null }
  timestamp: number
}

/** The public read, plus the two private steps the cache runs through. The test reaches those through this view. */
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

function at(place: { lat: number, lng: number }): FakePosition {
  return {
    coords: { latitude: place.lat, longitude: place.lng, accuracy: 5, altitude: null },
    timestamp: 1_700_000_000_000,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

test('a return to a cell answered before is stored with its address, so a reload restores it', async (t) => {
  t.mock.method(console, 'warn', () => {})
  // Room A's lookup answers. Room B's fails, so the cache only ever holds room A.
  const asked: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const lat = new URL(String(input)).searchParams.get('lat') ?? ''
    asked.push(lat)
    return lat === '51.500000' ? json(LONDON) : json({ error: 'busy' }, 503)
  })
  const writes: string[] = []
  stubGlobal(t, 'sessionStorage', {
    getItem: () => null,
    setItem: (_key: string, value: string) => { writes.push(value) },
  })
  const geo = new GeoTracker() as unknown as Tracker

  await geo._geocode(geo._applyPosition(at(ROOM_A)))
  await geo._geocode(geo._applyPosition(at(ROOM_B)))
  const back = geo._applyPosition(at(ROOM_A))
  assert.equal(geo.snapshot()?.address, null, 'the return starts without an address')

  const writesBefore = writes.length
  await geo._geocode(back)
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London', 'the cached answer is applied on return')
  assert.deepEqual(asked, ['51.500000', '51.600000'], 'the return is answered from the cache, not asked again')
  assert.ok(writes.length > writesBefore, 'the cached answer is written to sessionStorage')
  const stored = JSON.parse(writes.at(-1)!) as GeoFix
  assert.equal(stored.address, 'Abbey Road, London', 'a reload after the return restores the address')
  assert.equal(stored.displayAddress, LONDON.display_name)
})
