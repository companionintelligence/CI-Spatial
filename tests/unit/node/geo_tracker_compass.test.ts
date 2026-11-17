/**
 * The compass half of GeoTracker (src/geo/geo-tracker.ts): three hygiene rules, none of which changes
 * how a bearing is worked out.
 *
 *  1. The compass is not gated on a GPS fix. `snapshot()` is null without a fix, and the calibration read
 *     its bearing through it, so a phone with a working magnetometer and no GPS lock (indoors, which is
 *     where calibration happens) had no compass at all. `compassBearing` reads the sensor alone.
 *  2. A bearing from an earlier page load is not served. The restored fix carried its `bearing` back in,
 *     and `snapshot()` served it until the first sensor event: for ever if the page was never given
 *     permission to read the sensor. What is NOT here is an age limit: Chromium sends an orientation
 *     event only when an angle has moved 0.1 degrees or more, so a phone resting on a surface goes silent,
 *     and its last reading is still the right one (an earlier version of this rule dropped a reading after
 *     2 s and made the compass vanish at rest).
 *  3. iOS's `webkitCompassAccuracy` is negative when iOS itself says the heading is invalid (an
 *     uncalibrated magnetometer), and a heading or alpha that is not a number is no bearing. Neither is
 *     published as one. Apple also documents a negative `webkitCompassHeading` as invalid.
 *  4. On Android the bearing is where the back camera points, worked out from alpha, beta and gamma, and
 *     not `360 - alpha`, which is the top edge of the phone (src/geo/compass-heading.ts, and
 *     compass_heading.test.ts for the arithmetic against a physical model). Every reading says it is
 *     magnetic and which axis it follows, and the last event that said anything about the compass is kept raw
 *     for the device test of the compass (`?debug=probe`).
 *  5. What the calibration is handed is that bearing paired with the AR camera's pose (`pairedCompass`): the
 *     camera's own, or, past 60 degrees, the one worked out from the top edge, or nothing
 *     (compass_pairing.test.ts has the arithmetic). `?compass=alpha` runs the earlier `360 - alpha` rule.
 *
 * GPS, sessionStorage, the window's event hub and the clock are stand-ins, so nothing reaches a sensor
 * or the network. Every rule above has a case here that fails when the rule is broken.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/geo_tracker_compass.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compassBearingFromEvent, GeoTracker, type GeoFix } from '../../../src/geo/geo-tracker.ts'
import type { CompassReading, CompassRule, CompassSample, PairedCompass } from '../../../src/geo/compass-heading.ts'
import { sessionFrameBearingDeg } from '../../../src/world/geo.ts'
import { angDiff, arPoseFor, eulerAnglesFor, phoneAt, type Quaternion } from './compass_oracle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

interface OrientationEventLike {
  absolute?: boolean
  alpha?: number | null
  beta?: number | null
  gamma?: number | null
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

interface Tracker {
  onUpdate: (fix: GeoFix) => void
  snapshot(): GeoFix | null
  readonly compassBearing: number | null
  readonly compassReading: CompassReading | null
  readonly lastCompassSample: CompassSample | null
  pairedCompass(cameraRotation: Quaternion): PairedCompass | null
  start(): Promise<GeoFix | null>
  _applyPosition(pos: { coords: { latitude: number, longitude: number, accuracy: number, altitude: number | null }, timestamp: number }): GeoFix
  readonly fix: GeoFix | null
}

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

const FIX_AT_HOME = {
  coords: { latitude: 51.5, longitude: -0.12, accuracy: 5, altitude: null },
  timestamp: 1_700_000_000_000,
}

type Listener = (e: OrientationEventLike) => void

interface Rig {
  geo: Tracker
  /** One orientation event, as the browser delivers it to the window. */
  emit: (e: OrientationEventLike) => void
  /** The performance.now() value the tracker sees. Nothing in the tracker should depend on it. */
  clock: { now: number }
}

/**
 * A tracker started against stand-ins. `emit` delivers one orientation event to whatever the tracker
 * registered on the window, `clock` is the performance.now() value the tracker sees, and `gps` decides
 * whether a fix ever arrives.
 */
async function startTracker(
  t: TestContext,
  options: { gps: boolean, restored?: GeoFix | null, stored?: string, compassRule?: CompassRule },
): Promise<Rig> {
  t.mock.method(console, 'warn', () => {})
  const windowListeners = new Map<string, Listener[]>()
  stubGlobal(t, 'window', {
    addEventListener: (type: string, fn: Listener) => { windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]) },
  })
  stubGlobal(t, 'sessionStorage', {
    getItem: () => options.stored ?? (options.restored ? JSON.stringify(options.restored) : null),
    setItem: () => {},
  })
  stubGlobal(t, 'navigator', {
    geolocation: {
      watchPosition: (onFix: (pos: typeof FIX_AT_HOME) => void, onError: (err: { message: string }) => void) => {
        if (options.gps) onFix(FIX_AT_HOME)
        else onError({ message: 'no fix' })
        return 1
      },
      clearWatch: () => {},
    },
  })
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(() => {}))
  // start() arms an 8 s fallback timer. It is held here so the test ends at once.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clock = { now: 10_000 }
  t.mock.method(performance, 'now', () => clock.now)

  const geo = new GeoTracker(options.compassRule ? { compassRule: options.compassRule } : undefined) as unknown as Tracker
  await geo.start()
  const orientation = windowListeners.get('deviceorientation') ?? []
  assert.ok(orientation.length > 0, 'the tracker listens for orientation events')
  assert.ok((windowListeners.get('deviceorientationabsolute') ?? []).length > 0, 'and for the absolute ones')
  return { geo, emit: (e) => { for (const fn of orientation) fn(e) }, clock }
}

test('the compass reads with no GPS fix: snapshot() is null, compassBearing is not', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  emit({ webkitCompassHeading: 123, webkitCompassAccuracy: 10 })
  assert.equal(geo.snapshot(), null, 'there is no fix to snapshot')
  // What the calibration used to ask for. It was null whenever the GPS was.
  assert.equal(geo.snapshot()?.bearing ?? null, null)
  assert.equal(geo.compassBearing, 123)
})

test('the live fix and the update callback carry the bearing each event reads, and null when it is invalid', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  const seen: Array<number | null> = []
  geo.onUpdate = (fix) => { seen.push(fix.bearing) }
  emit({ webkitCompassHeading: 10 })
  emit({ webkitCompassHeading: 20 })
  emit({ webkitCompassHeading: 30, webkitCompassAccuracy: -1 })
  assert.deepEqual(seen, [10, 20, null])
  assert.equal(geo.fix?.bearing, null)
  emit({ absolute: true, alpha: 270 })
  assert.equal(geo.fix?.bearing, 90)
})

test('a reading does not expire: a phone resting on a surface sends no events, and its last reading is still the bearing', async (t) => {
  // Chromium sends an orientation event only when an angle has moved 0.1 degrees or more from the last one
  // it sent, so a steady phone is silent. Silence is not a reason to stop reporting where it points.
  const { geo, emit, clock } = await startTracker(t, { gps: true })
  emit({ webkitCompassHeading: 40 })
  assert.equal(geo.compassBearing, 40)
  assert.equal(geo.snapshot()?.bearing, 40)

  for (const silence of [2_001, 60_000, 3_600_000]) {
    clock.now += silence
    assert.equal(geo.compassBearing, 40, `${silence} ms of silence`)
    assert.equal(geo.snapshot()?.bearing, 40, `${silence} ms of silence, through the snapshot`)
    assert.equal(geo._applyPosition(FIX_AT_HOME).bearing, 40, `${silence} ms of silence, on a new fix`)
  }

  // And a new reading replaces it, as it always did.
  emit({ webkitCompassHeading: 75 })
  assert.equal(geo.compassBearing, 75)
  assert.equal(geo._applyPosition(FIX_AT_HOME).bearing, 75, 'a fresh reading rides on the new fix')
})

test('the bearing restored from an earlier page load is not a bearing, even if the sensor never speaks', async (t) => {
  const earlier: GeoFix = {
    lat: 51.5, lng: -0.12, accuracy: 5, altitudeM: null, bearing: 200,
    fixedAt: '2026-01-01T00:00:00.000Z', address: null, displayAddress: null, addressComponents: null,
  }
  // No GPS and no orientation event: nothing in this page load has measured a direction.
  const { geo } = await startTracker(t, { gps: false, restored: earlier })
  assert.equal(geo.fix?.lat, 51.5, 'the restored fix itself is kept')
  assert.equal(geo.fix?.bearing, null, 'its bearing is not')
  assert.equal(geo.snapshot()?.bearing, null)
  assert.equal(geo.compassBearing, null)
})

test('a stored session value that is not a fix restores no fix, as before', async (t) => {
  const { geo } = await startTracker(t, { gps: false, stored: 'null' })
  assert.equal(geo.fix, null)
  assert.equal(geo.snapshot(), null)
})

test('an iOS heading flagged invalid by a negative accuracy is not published, and clears what was there', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ webkitCompassHeading: 90, webkitCompassAccuracy: 15 })
  assert.equal(geo.compassBearing, 90)

  emit({ webkitCompassHeading: 91, webkitCompassAccuracy: -1 })
  assert.equal(geo.compassBearing, null, 'invalid now: neither 91 nor the 90 from before')
  assert.equal(geo.snapshot()?.bearing, null)

  emit({ webkitCompassHeading: 92, webkitCompassAccuracy: 0 })
  assert.equal(geo.compassBearing, 92, 'an accuracy of 0 is a valid reading')
  emit({ webkitCompassHeading: 93 })
  assert.equal(geo.compassBearing, 93, 'no accuracy at all is accepted, as before')
})

test('compassBearingFromEvent: iOS heading, Android absolute alpha, and events that say nothing', () => {
  const read = (e: OrientationEventLike) => compassBearingFromEvent(e as unknown as DeviceOrientationEvent)
  assert.equal(read({ webkitCompassHeading: 270 }), 270)
  assert.equal(read({ webkitCompassHeading: 270, webkitCompassAccuracy: 25 }), 270)
  assert.equal(read({ webkitCompassHeading: 270, webkitCompassAccuracy: -1 }), null)
  // alpha counts counter-clockwise, a bearing clockwise.
  assert.equal(read({ absolute: true, alpha: 90 }), 270)
  assert.equal(read({ absolute: true, alpha: 0 }), 0)
  assert.equal(read({ absolute: true, alpha: 359 }), 1)
  // A relative alpha counts from an arbitrary direction fixed at page load: not a compass.
  assert.equal(read({ absolute: false, alpha: 90 }), undefined)
  assert.equal(read({ alpha: 90 }), undefined)
  assert.equal(read({ absolute: true, alpha: null }), undefined)
  assert.equal(read({}), undefined)
  // A number that is not a number is no bearing: null, so it clears what was there instead of riding into the
  // stored fix and the editor as NaN.
  assert.equal(read({ webkitCompassHeading: Number.NaN }), null)
  assert.equal(read({ webkitCompassHeading: Number.POSITIVE_INFINITY, webkitCompassAccuracy: 10 }), null)
  assert.equal(read({ absolute: true, alpha: Number.NaN }), null)
  assert.equal(read({ absolute: true, alpha: Number.NEGATIVE_INFINITY }), null)
})

test('a heading that is not a number clears the bearing and never reaches the fix', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ absolute: true, alpha: 90 })
  assert.equal(geo.compassBearing, 270)
  emit({ absolute: true, alpha: Number.NaN })
  assert.equal(geo.compassBearing, null, 'neither NaN nor the 270 from before')
  assert.equal(geo.snapshot()?.bearing, null)
  assert.equal(geo._applyPosition(FIX_AT_HOME).bearing, null)
  emit({ webkitCompassHeading: Number.NaN })
  assert.equal(geo.compassBearing, null)
  emit({ webkitCompassHeading: 64 })
  assert.equal(geo.compassBearing, 64)
})

test('a relative-alpha event neither sets a bearing nor clears the one from the compass', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ absolute: false, alpha: 10 })
  assert.equal(geo.compassBearing, null, 'a relative alpha alone is no compass')
  emit({ absolute: true, alpha: 90 })
  assert.equal(geo.compassBearing, 270)
  emit({ absolute: false, alpha: 12 })
  assert.equal(geo.compassBearing, 270, 'the absolute reading still stands')
})

test('source shape: the calibration reads the compass paired with the camera\'s pose, not the bare bearing and not the GPS-gated snapshot()', () => {
  // src/main.ts is one DOM module and cannot be imported under node, so its wiring is read as text. This
  // claims no behaviour; that the calibration gets a bearing indoors, and the right one, is what the cases above
  // and compass_pairing.test.ts are for.
  const main = read('src/main.ts')
  const call = main.slice(main.indexOf('await runProjectCalibration({'))
  const options = call.slice(0, call.indexOf('ground: () =>'))
  assert.ok(options.includes('bearing: () => geoTracker.pairedCompass(provider.getPose().rotation)?.bearingDeg ?? null,'))
  assert.ok(!options.includes('geoTracker.compassBearing'), 'the calibration is handed the bare heading again: a top-edge heading would be paired with the camera\'s yaw')
  assert.ok(!options.includes('geoTracker.snapshot()'), 'the calibration option is read through snapshot() again')
})

test('source shape: the tracker is built with the rule the page\'s query selects', () => {
  const main = read('src/main.ts')
  assert.ok(main.includes('const geoTracker = new GeoTracker({ compassRule: compassRuleFromSearch(location.search) })'))
  assert.ok(main.includes("import { compassRuleFromSearch } from './geo/compass-heading'"))
})

test('source shape: ?debug=pose prints the compass spin line next to the pose', () => {
  const main = read('src/main.ts')
  assert.ok(main.includes("import { bearingConventionFromSearch, compassSpinTerms, distanceM, formatCompassSpin } from './world/geo'"))
  // Appended to the readout's own text, not computed and dropped, from the bearing the calibration is given (paired
  // with this pose), with how it was paired.
  assert.ok(main.includes('const paired = geoTracker.pairedCompass(pose.rotation)'))
  assert.ok(main.includes("const via = paired?.via ?? (geoTracker.compassReading ? 'withheld' : null)"))
  assert.match(
    main,
    /el\.textContent \+=\s*`\\n\$\{formatCompassSpin\(compassSpinTerms\(paired\?\.bearingDeg \?\? null, pose\.rotation\), bearingConventionFromSearch\(location\.search\), via\)\}`/,
  )
})

// ── The camera's direction, and what is kept with it ─────────────────────────────────────────

/** The angular distance between two bearings, 0 to 180, across the wrap at 360. */
const gap = (a: number, b: number) => Math.abs((((a - b + 180) % 360) + 360) % 360 - 180)

test('Android: the bearing is where the camera points, so a phone rolled into landscape reads a quarter turn from what 360 - alpha says', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  // Standing on its long edge with the screen facing west, the camera faces east. 360 - alpha would say north.
  emit({ absolute: true, alpha: 0, beta: 0, gamma: -90 })
  assert.ok(gap(geo.compassBearing!, 90) < 1e-9, `${geo.compassBearing}`)
  assert.equal(geo.compassReading?.axis, 'camera')
  assert.ok(gap(geo.snapshot()!.bearing!, 90) < 1e-9, 'the fix carries the same number')
  emit({ absolute: true, alpha: 0, beta: 0, gamma: 90 })
  assert.ok(gap(geo.compassBearing!, 270) < 1e-9, `${geo.compassBearing}`)
})

test('Android: upright and leaning over by g degrees, the bearing is the camera\'s, g degrees from 360 - alpha', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  emit({ absolute: true, alpha: 100, beta: 90, gamma: 0 })
  assert.ok(gap(geo.compassBearing!, 260) < 1e-9, 'unrolled it is 360 - alpha')
  emit({ absolute: true, alpha: 100, beta: 90, gamma: 10 })
  assert.ok(gap(geo.compassBearing!, 250) < 1e-9, `${geo.compassBearing}: the old conversion would still say 260`)
})

test('Android: a phone lying flat reads its top edge, 360 - alpha, and the reading says it is the top edge and not the camera', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ absolute: true, alpha: 90, beta: 0, gamma: 0 })
  assert.equal(geo.compassBearing, 270)
  assert.equal(geo.compassReading?.axis, 'top')
  // 5 degrees up from flat is still a camera pointing at the floor.
  emit({ absolute: true, alpha: 90, beta: 5, gamma: 0 })
  assert.equal(geo.compassReading?.axis, 'top')
  // Upright it is the camera again.
  emit({ absolute: true, alpha: 90, beta: 80, gamma: 0 })
  assert.equal(geo.compassReading?.axis, 'camera')
})

test('every reading says it is magnetic, which axis it follows and where it came from', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  /** Read afresh each time, so that nothing here is narrowed by what the last line asserted. */
  const reading = () => geo.compassReading
  assert.equal(reading(), null, 'none before the first event')
  emit({ absolute: true, alpha: 90, beta: 90, gamma: 0 })
  assert.deepEqual(
    [reading()?.northReference, reading()?.axis, reading()?.source, reading()?.sigmaDeg],
    ['magnetic', 'camera', 'android-absolute', null],
  )
  emit({ webkitCompassHeading: 200, webkitCompassAccuracy: 12, beta: 70, gamma: 2 })
  assert.deepEqual(
    [reading()?.northReference, reading()?.axis, reading()?.source, reading()?.headingDeg, reading()?.accuracyDeg],
    ['magnetic', 'unknown', 'ios-compass', 200, 12],
  )
  assert.equal(geo.compassBearing, reading()?.headingDeg, 'the bearing is the reading\'s heading')
})

test('an iPhone reading carries at least 25 degrees of uncertainty, and the platform\'s own figure when it is worse', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  emit({ webkitCompassHeading: 10, webkitCompassAccuracy: 8 })
  assert.equal(geo.compassReading?.sigmaDeg, 25)
  emit({ webkitCompassHeading: 10, webkitCompassAccuracy: 45 })
  assert.equal(geo.compassReading?.sigmaDeg, 45)
  emit({ webkitCompassHeading: 10 })
  assert.equal(geo.compassReading?.sigmaDeg, 25)
})

test('a reading is cleared with the bearing: invalid iOS, a negative heading, or an angle that is not a number', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ absolute: true, alpha: 90, beta: 90, gamma: 0 })
  assert.notEqual(geo.compassReading, null)
  emit({ absolute: true, alpha: 90, beta: Number.NaN, gamma: 0 })
  assert.equal(geo.compassReading, null, 'a beta that is not a number discards the sample')
  assert.equal(geo.compassBearing, null)
  assert.equal(geo.snapshot()?.bearing, null)

  emit({ webkitCompassHeading: 50, webkitCompassAccuracy: 10 })
  assert.equal(geo.compassBearing, 50)
  emit({ webkitCompassHeading: -1 })
  assert.equal(geo.compassBearing, null, 'Apple: a negative value indicates an invalid direction')
  assert.equal(geo.compassReading, null)
  emit({ webkitCompassHeading: 60, webkitCompassAccuracy: -1 })
  assert.equal(geo.compassReading, null)
})

test('the last compass sample is the raw event and the reading taken from it, and a relative event does not replace it', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  /** Read afresh each time, so that nothing here is narrowed by what the last line asserted. */
  const sample = () => geo.lastCompassSample
  assert.equal(sample(), null, 'nothing yet')
  // A relative event first: it says nothing about the compass, so there is still no sample.
  emit({ absolute: false, alpha: 10, beta: 20, gamma: 30 })
  assert.equal(sample(), null)

  emit({ absolute: true, alpha: 150, beta: 40, gamma: -3 })
  const first = sample()!
  assert.deepEqual(first.raw, { alpha: 150, beta: 40, gamma: -3, absolute: true, webkitCompassHeading: null, webkitCompassAccuracy: null })
  assert.equal(first.reading, geo.compassReading, 'the reading is the one the bearing comes from')

  // Android sends both streams: the relative one speaks again and the sample is still the absolute event.
  emit({ absolute: false, alpha: 11, beta: 21, gamma: 31 })
  assert.equal(sample(), first)
  emit({ absolute: true, alpha: 151, beta: 41, gamma: -4 })
  assert.equal(sample()!.raw.alpha, 151)
})

test('an iPhone sample keeps alpha, beta and gamma beside the heading, which is what the axis comparison needs', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  // An iPhone's event has no `absolute` property at all (Safari on iOS does not implement it).
  emit({ webkitCompassHeading: 123.4, webkitCompassAccuracy: 15, alpha: 301.2, beta: 61.5, gamma: -4.1 })
  assert.deepEqual(geo.lastCompassSample!.raw, {
    alpha: 301.2, beta: 61.5, gamma: -4.1, absolute: null, webkitCompassHeading: 123.4, webkitCompassAccuracy: 15,
  })
  assert.equal(geo.lastCompassSample!.reading?.axis, 'unknown')
})

test('a refused sample is still kept raw, so the log shows what the sensor said, but it has no reading', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ webkitCompassHeading: 77, webkitCompassAccuracy: -1, beta: 10, gamma: 11, alpha: 12 })
  assert.equal(geo.compassBearing, null)
  assert.equal(geo.lastCompassSample!.reading, null)
  assert.equal(geo.lastCompassSample!.raw.webkitCompassAccuracy, -1)
  assert.equal(geo.lastCompassSample!.raw.webkitCompassHeading, 77)
  emit({ absolute: true, alpha: 5, beta: Number.NaN, gamma: 0 })
  assert.equal(geo.lastCompassSample!.reading, null)
  assert.ok(Number.isNaN(geo.lastCompassSample!.raw.beta))
})

test('a sample is not restored from an earlier page load, as the bearing is not', async (t) => {
  const earlier: GeoFix = {
    lat: 51.5, lng: -0.12, accuracy: 5, altitudeM: null, bearing: 200,
    fixedAt: '2026-01-01T00:00:00.000Z', address: null, displayAddress: null, addressComponents: null,
  }
  const { geo } = await startTracker(t, { gps: false, restored: earlier })
  assert.equal(geo.lastCompassSample, null)
  assert.equal(geo.compassReading, null)
})

test('source shape: the probe is handed the last compass sample, read at the tap like the bearing', () => {
  const main = read('src/main.ts')
  const start = main.indexOf('installProbeLog({')
  const call = main.slice(start, main.indexOf('})', start))
  assert.ok(call.includes('compassSample: () => geoTracker.lastCompassSample,'))
  assert.ok(call.includes('bearing: () => geoTracker.pairedCompass(provider.getPose().rotation)?.bearingDeg ?? null,'), 'and the bearing the calibration is given, so a line measures what a calibration would have used')
})

// ── The bearing paired with the camera's pose ────────────────────────────────────────────────

/** Deliver the first set of angles a phone placed this way would report, and return the phone's axes. */
function emitPhone(emit: Rig['emit'], heading: number, pitchDown: number, roll: number) {
  const axes = phoneAt(heading, pitchDown, roll)
  const [alpha, beta, gamma] = eulerAnglesFor(axes)[0]!
  emit({ absolute: true, alpha, beta, gamma })
  return axes
}

test('pairedCompass: the camera\'s heading within 60 degrees of level, the true frame bearing past it as far as it can be told, and nothing when the camera looks at the floor', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  const TRUE_BZ = 77
  for (const [roll, turn] of [[0, 0], [10, 0], [90, 0], [90, 90], [270, 270]] as const) {
    for (const [pitch, via] of [[30, 'camera'], [60, 'camera'], [62, 'top'], [66, 'top'], [70, 'top']] as const) {
      const axes = emitPhone(emit, 40, pitch, roll)
      const q = arPoseFor(axes, TRUE_BZ, turn)
      const paired = geo.pairedCompass(q)
      assert.ok(paired !== null, `pitch ${pitch}, roll ${roll}, turn ${turn}`)
      assert.equal(paired.via, via, `pitch ${pitch}, roll ${roll}`)
      assert.ok(Math.abs(angDiff(sessionFrameBearingDeg(paired.bearingDeg, q)!, TRUE_BZ)) < 1e-6, `pitch ${pitch}, roll ${roll}, turn ${turn}: the calibration's frame bearing`)
    }
    // Looking nearly at the floor: the tracker has a heading (the top edge's), and the pairing has none to give.
    const flat = emitPhone(emit, 40, 82, roll)
    assert.notEqual(geo.compassBearing, null)
    assert.equal(geo.pairedCompass(arPoseFor(flat, TRUE_BZ, 0)), null, `roll ${roll}: nothing is better than a bearing that may be a quarter turn out`)
  }
})

test('pairedCompass: the bare heading past 60 degrees is the top edge\'s, which is what the calibration used to be handed, and it was out by the roll', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  const TRUE_BZ = 77
  const axes = emitPhone(emit, 40, 66, 90)
  const q = arPoseFor(axes, TRUE_BZ, 0)
  assert.equal(geo.compassReading?.axis, 'top')
  // The bare heading with the camera's yaw (what main.ts used to hand over, and sessionFrameBearingDeg then added the yaw to):
  assert.ok(Math.abs(angDiff(sessionFrameBearingDeg(geo.compassBearing, q)!, TRUE_BZ)) > 45, 'in landscape the top edge is a quarter turn from the camera')
  // The paired bearing: exact.
  assert.ok(Math.abs(angDiff(sessionFrameBearingDeg(geo.pairedCompass(q)!.bearingDeg, q)!, TRUE_BZ)) < 1e-6)
})

test('pairedCompass: needs no GPS fix, is null until an event and again when one is refused, and is not served from an earlier page load', async (t) => {
  const earlier: GeoFix = {
    lat: 51.5, lng: -0.12, accuracy: 5, altitudeM: null, bearing: 200,
    fixedAt: '2026-01-01T00:00:00.000Z', address: null, displayAddress: null, addressComponents: null,
  }
  const { geo, emit } = await startTracker(t, { gps: false, restored: earlier })
  const axes = phoneAt(40, 30, 0)
  const q = arPoseFor(axes, 77, 0)
  assert.equal(geo.snapshot()?.bearing ?? null, null)
  assert.equal(geo.pairedCompass(q), null, 'no event yet: the restored bearing is not one')
  emitPhone(emit, 40, 30, 0)
  assert.ok(geo.pairedCompass(q) !== null, 'with no GPS fix, the compass is there')
  emit({ absolute: true, alpha: 90, beta: Number.NaN, gamma: 0 })
  assert.equal(geo.pairedCompass(q), null, 'a refused sample clears it, as it clears the bearing')
  // A relative event does not clear or replace it.
  emitPhone(emit, 40, 30, 0)
  emit({ absolute: false, alpha: 11, beta: 21, gamma: 31 })
  assert.ok(geo.pairedCompass(q) !== null)
})

test('pairedCompass: an iPhone\'s heading is handed over as it is, and says its axis is not known', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: true })
  emit({ webkitCompassHeading: 200, webkitCompassAccuracy: 12, beta: 70, gamma: 2, alpha: 12 })
  for (const q of [arPoseFor(phoneAt(40, 65, 10), 77, 0), arPoseFor(phoneAt(40, 85, 90), 77, 90)]) {
    assert.deepEqual(geo.pairedCompass(q), { bearingDeg: 200, via: 'platform' })
  }
  emit({ webkitCompassHeading: 201, webkitCompassAccuracy: -1 })
  assert.equal(geo.pairedCompass(arPoseFor(phoneAt(40, 65, 10), 77, 0)), null, 'an invalid heading is nothing')
})

test('?compass=alpha: the tracker runs the earlier rule, 360 - alpha whatever the tilt, with no axis claimed and the heading paired as it always was', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false, compassRule: 'alpha' })
  // Standing on its long edge with the screen facing west, the camera faces east: the default rule says 90 (above), this one 360 - 0.
  emit({ absolute: true, alpha: 0, beta: 0, gamma: -90 })
  assert.equal(geo.compassBearing, 0)
  assert.equal(geo.compassReading?.axis, 'unknown')
  assert.equal(geo.compassReading?.northReference, 'magnetic')
  const q = arPoseFor(phoneAt(40, 30, 0), 77, 0)
  assert.deepEqual(geo.pairedCompass(q), { bearingDeg: 0, via: 'platform' })
  // The raw sample is kept under either rule.
  assert.deepEqual(geo.lastCompassSample!.raw, { alpha: 0, beta: 0, gamma: -90, absolute: true, webkitCompassHeading: null, webkitCompassAccuracy: null })
  // The earlier rule says nothing about a tilt it never read: not even NaN stops it.
  emit({ absolute: true, alpha: 100, beta: Number.NaN, gamma: 0 })
  assert.equal(geo.compassBearing, 260)
  // An iPhone is unaffected by it.
  emit({ webkitCompassHeading: 33, webkitCompassAccuracy: 9 })
  assert.equal(geo.compassBearing, 33)
  assert.equal(geo.compassReading?.axis, 'unknown')
})

test('without the switch the default rule is in force: a tracker built with no options reads the camera\'s bearing', async (t) => {
  const { geo, emit } = await startTracker(t, { gps: false })
  emit({ absolute: true, alpha: 0, beta: 0, gamma: -90 })
  assert.ok(gap(geo.compassBearing!, 90) < 1e-9)
  assert.equal(geo.compassReading?.axis, 'camera')
})

test('compassBearingFromEvent takes the rule: the default is the camera\'s bearing, \'alpha\' is the earlier one', () => {
  const read = (e: OrientationEventLike, rule?: CompassRule) => compassBearingFromEvent(e as unknown as DeviceOrientationEvent, rule)
  const landscape = { absolute: true, alpha: 0, beta: 0, gamma: -90 }
  assert.ok(gap(read(landscape)!, 90) < 1e-9)
  assert.ok(gap(read(landscape, 'attitude')!, 90) < 1e-9)
  assert.equal(read(landscape, 'alpha'), 0)
})

// The quaternion type the tracker takes is the one the oracle builds.
const _poseTypeIsShared: Quaternion = { x: 0, y: 0, z: 0, w: 1 }
void _poseTypeIsShared
