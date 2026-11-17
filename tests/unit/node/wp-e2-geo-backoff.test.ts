/**
 * GeoTracker's retry backoff for a failed address lookup (src/geo/geo-tracker.ts, F117). The wait is
 * measured on performance.now(), so a change to the wall clock does not move it (E4). It doubles from
 * 5 s and is held at the five-minute cap from the seventh failure on (E5). Time and fetch are stand-ins,
 * so nothing reaches the network. These cases live in a new file because wp-e-geo-tracker.test.ts is wave 1's.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e2-geo-backoff.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { GeoTracker, type GeoFix } from '../../../src/geo/geo-tracker.ts'

interface FakePosition {
  coords: { latitude: number, longitude: number, accuracy: number, altitude: number | null }
  timestamp: number
}

/** The public read, plus the two private steps the backoff runs through. The test reaches those through this view. */
interface Tracker {
  snapshot(): GeoFix | null
  _applyPosition(pos: FakePosition): GeoFix
  _geocode(fix: GeoFix): Promise<void>
}

const ROOM_A = { lat: 51.5, lng: -0.12 }
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

/** Answers each lookup by its call number, and records each request so a test can count them. */
function lookups(t: TestContext, answer: (call: number) => Promise<Response>): string[] {
  const asked: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    asked.push(new URL(String(input)).searchParams.get('lat') ?? '')
    return answer(asked.length)
  })
  return asked
}

test('a failed lookup waits on the monotonic clock, not on Date.now', async (t) => {
  t.mock.method(console, 'warn', () => {})
  let monotonic = 1_000
  t.mock.method(performance, 'now', () => monotonic)
  // Date.now is deliberately not mocked: the wait has to hold whatever the wall clock reads.
  const asked = lookups(t, async (call) => (call < 2 ? json({}, 503) : json(LONDON)))
  const geo = new GeoTracker() as unknown as Tracker
  const fix = geo._applyPosition(at(ROOM_A))

  await geo._geocode(fix) // try 1 fails: the wait is 5 s
  assert.equal(asked.length, 1)
  monotonic += 4_999
  await geo._geocode(fix)
  assert.equal(asked.length, 1, 'no retry in the first 5 s of monotonic time')
  monotonic += 1
  await geo._geocode(fix)
  assert.equal(asked.length, 2, 'the retry runs at 5 s')
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London')
})

test('failures back off by doubling up to the five-minute cap, and the cap holds', async (t) => {
  t.mock.method(console, 'warn', () => {})
  let monotonic = 0
  t.mock.method(performance, 'now', () => monotonic)
  // The first eight tries fail, and the ninth answers.
  const asked = lookups(t, async (call) => (call < 9 ? json({}, 503) : json(LONDON)))
  const geo = new GeoTracker() as unknown as Tracker
  const fix = geo._applyPosition(at(ROOM_A))
  // The wait after each failure, in seconds: doubling from 5 s, then held at the 300 s cap from the seventh failure on.
  const waits = [5, 10, 20, 40, 80, 160, 300, 300]

  for (const [i, seconds] of waits.entries()) {
    await geo._geocode(fix) // failure i + 1 happens here
    assert.equal(asked.length, i + 1)
    monotonic += seconds * 1_000 - 1
    await geo._geocode(fix)
    assert.equal(asked.length, i + 1, `failure ${i + 1} waits ${seconds} s: no retry one millisecond early`)
    monotonic += 1
  }

  await geo._geocode(fix) // the ninth try is due five minutes after the eighth failure
  assert.equal(asked.length, 9)
  assert.equal(geo.snapshot()?.address, 'Abbey Road, London')
})
