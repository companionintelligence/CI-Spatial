/**
 * The compass bench (public/compass-bench.html): the page DX3's survey reads, held to the app's own compass code.
 *
 * Procedure 4 of docs/testing/DEVICE_TESTING.md says the bench "shows the bearing the app would use". The app's
 * code is TypeScript (src/geo/compass-heading.ts) and the bench is a static page that is not bundled and cannot
 * import it, so the bench carries a second copy of the rule that turns one orientation event into a bearing. Two
 * copies drift. This test cuts the copy out of the page, runs it over a grid of events beside the app's code, and
 * fails if they disagree about the bearing or the axis for any of them.
 *
 * It also holds what the page says of the compass: every bearing is from MAGNETIC north (Apple documents
 * `webkitCompassHeading` that way, and an absolute `alpha` is measured in a frame whose Y axis points at magnetic
 * north), so the page must not call it true north.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/compass_bench.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { compassReadingFromEvent } from '../../../src/geo/compass-heading.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const HTML = readFileSync(join(ROOT, 'public/compass-bench.html'), 'utf8')

interface BenchRead {
  bearing: number | null
  axis: string | null
  source: string | null
  how: string
}

/** The page's rule, cut out between its markers and run on its own: it touches no DOM. */
function benchAdapter(): { readEvent: (e: object) => BenchRead } {
  const start = HTML.indexOf('// <compass-adapter>')
  const end = HTML.indexOf('// </compass-adapter>')
  assert.ok(start > 0 && end > start, 'the bench no longer marks its compass adapter: this test cannot find the rule to compare')
  const context = vm.createContext({ Math, isFinite })
  vm.runInContext(`${HTML.slice(start, end)}\nthis.readEvent = readEvent`, context)
  return context as unknown as { readEvent: (e: object) => BenchRead }
}

const { readEvent } = benchAdapter()
const app = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent)

/** `a - b` folded into (-180, 180]. */
function angDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}

/** Every kind of event the grid asks both about: iOS with and without accuracy, absolute and relative angles, numbers that are not numbers. */
function events(): object[] {
  const out: object[] = []
  const numbers = [0, 10, 25, 59.9, 60, 90, 120, 180, -25, -90, -180, 359, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]
  for (const heading of [0, 123.4, 359.9, 360, 725, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const webkitCompassAccuracy of [undefined, -1, 0, 10, Number.NaN]) out.push({ webkitCompassHeading: heading, webkitCompassAccuracy })
  }
  for (const alpha of [0, 33, 90, 180, 270, 359, Number.NaN, null, undefined]) {
    for (const beta of numbers) {
      for (const gamma of numbers) {
        out.push({ absolute: true, alpha, beta, gamma })
        out.push({ absolute: false, alpha, beta, gamma })
      }
    }
  }
  // The exact 60 degree line, where the camera axis is half horizontal: the four postures that put it there (the phone
  // pitched 60 degrees down or up in portrait, and rolled into either landscape) at every alpha. The guard that keeps
  // the line on the camera's side is a constant the bench copies, so the line is where a copy would drift.
  for (let alpha = 0; alpha < 360; alpha += 15) {
    for (const [beta, gamma] of [[30, 0], [0, 30], [150, 0], [0, -30], [-30, 0], [-150, 0]] as const) {
      out.push({ absolute: true, alpha, beta, gamma })
    }
  }
  out.push({}, { alpha: 90 }, { absolute: true })
  return out
}

test('the bench takes the same bearing and the same axis from every event as the app does', () => {
  const grid = events()
  let compared = 0
  let bearings = 0
  const axes = new Set<string | null>()
  for (const e of grid) {
    const mine = readEvent(e)
    const theirs = app(e)
    const want = theirs === undefined || theirs === null ? null : theirs.headingDeg
    const at = JSON.stringify(e)
    if (want === null) {
      assert.equal(mine.bearing, null, `${at}: the app has no bearing and the bench has ${mine.bearing}`)
      assert.equal(mine.axis, null, at)
    } else {
      assert.notEqual(mine.bearing, null, `${at}: the app has ${want} and the bench has none`)
      assert.ok(Math.abs(angDiff(mine.bearing!, want)) < 1e-9, `${at}: bench ${mine.bearing}, app ${want}`)
      assert.ok(mine.bearing! >= 0 && mine.bearing! < 360, `${at}: ${mine.bearing} is not in [0, 360)`)
      assert.equal(mine.axis, theirs!.axis, at)
      assert.equal(mine.source, theirs!.source === 'ios-compass' ? 'ios' : 'android', at)
      bearings++
      axes.add(mine.axis)
    }
    compared++
  }
  assert.ok(compared > 1500 && bearings > 600, `${compared} events, ${bearings} with a bearing: the grid has to reach every branch`)
  assert.deepEqual([...axes].sort(), ['camera', 'top', 'unknown'], 'and all three axes')
})

test('on the exact 60 degree line the bench and the app are both on the camera\'s side, and the constants the bench copies are flagged as adopted', () => {
  // A camera pitched 60 degrees down is the posture of a tap on the floor. cos(60 degrees) is 0.5000000000000001 and the same
  // sum in another order is 0.49999999999999994: without the guard the axis is decided by the last bit. A copy that lost
  // the guard would say `top` for some alphas and the app `camera`.
  for (let alpha = 0; alpha < 360; alpha += 1) {
    for (const [beta, gamma] of [[30, 0], [0, 30], [150, 0], [0, -30]] as const) {
      const e = { absolute: true, alpha, beta, gamma }
      assert.equal(readEvent(e).axis, 'camera', JSON.stringify(e))
      assert.equal(app(e)!.axis, 'camera', JSON.stringify(e))
    }
  }
  for (const name of ['MIN_AXIS_HORIZONTAL', 'ROUNDING_GUARD']) {
    const at = HTML.indexOf(`var ${name} =`)
    assert.ok(at > 0, `the bench no longer declares ${name}`)
    assert.match(HTML.slice(HTML.lastIndexOf('<script', at), at), /Adopted, not measured \(ADR 0005 rule 5\)/, `${name} carries no flag`)
  }
})

test('the bench has the bearing of a flat phone to the last digit, as the app has, and the camera where the app has it', () => {
  assert.equal(readEvent({ absolute: true, alpha: 270, beta: 0, gamma: 0 }).bearing, 90)
  assert.equal(readEvent({ absolute: true, alpha: 359 }).bearing, 1)
  assert.equal(readEvent({ absolute: true, alpha: 0, beta: 0, gamma: -90 }).axis, 'camera')
  assert.ok(Math.abs(angDiff(readEvent({ absolute: true, alpha: 0, beta: 0, gamma: -90 }).bearing!, 90)) < 1e-9)
})

test('every bearing the bench shows says it is from magnetic north, and none claims true north', () => {
  for (const e of [{ webkitCompassHeading: 10 }, { absolute: true, alpha: 10, beta: 90, gamma: 0 }, { absolute: true, alpha: 10, beta: 0, gamma: 0 }]) {
    assert.match(readEvent(e).how, /magnetic north/, JSON.stringify(e))
  }
  // The page may say what the bearing is not; it may not say it is true north.
  const claims = [...HTML.matchAll(/true[- ]north/gi)]
  assert.ok(claims.length > 0, 'the page says which north it is, and that is not true north')
  for (const claim of claims) {
    assert.equal(HTML.slice(claim.index - 4, claim.index), 'not ', `"${HTML.slice(claim.index - 30, claim.index + 20)}" claims true north`)
  }
  assert.match(HTML, /Bearings are from <b>magnetic<\/b> north/)
})

test('the bench says which axis an Android bearing is the bearing of, so a reading is not mistaken for the camera when it is the top edge', () => {
  assert.match(readEvent({ absolute: true, alpha: 10, beta: 90, gamma: 0 }).how, /where the camera points/)
  assert.match(readEvent({ absolute: true, alpha: 10, beta: 0, gamma: 0 }).how, /where the top edge points/)
  assert.match(readEvent({ webkitCompassHeading: 10 }).how, /axis not known/)
})

test('an event the app refuses is one the bench says it ignores, and does not blank the reading with', () => {
  for (const e of [{ webkitCompassHeading: 50, webkitCompassAccuracy: -1 }, { webkitCompassHeading: -1 }, { absolute: true, alpha: 5, beta: Number.NaN, gamma: 0 }]) {
    const read = readEvent(e)
    assert.equal(read.bearing, null, JSON.stringify(e))
    assert.match(read.how, /ignored/, JSON.stringify(e))
  }
  // The page keeps the last good reading across a null: the existing rule, read from its source.
  assert.match(HTML, /if \(bearing === null\) \{\s*\/\/ Do not blank the reading/)
})

test('the whole page runs against a stand-in DOM: the readout shows the bearing and which north and axis, and a relative event does not flicker it', () => {
  const script = HTML.slice(HTML.indexOf('<script>') + '<script>'.length, HTML.lastIndexOf('</script>'))
  interface Element { textContent: string, className: string, onclick: null | (() => void) }
  const elements = new Map<string, Element>()
  const element = (): Element => ({ textContent: '', className: '', onclick: null })
  const listeners = new Map<string, (e: object) => void>()
  const context = vm.createContext({
    Math,
    Date,
    isFinite,
    setInterval: () => 0,
    document: {
      getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id)! },
      createElement: () => element(),
      body: { insertBefore: () => {}, children: [0, 1, 2] },
    },
    window: { addEventListener: (type: string, fn: (e: object) => void) => { listeners.set(type, fn) } },
    DeviceOrientationEvent: undefined,
  })
  vm.runInContext(script, context)
  const absolute = listeners.get('deviceorientationabsolute')!
  const relative = listeners.get('deviceorientation')!
  assert.ok(typeof absolute === 'function' && typeof relative === 'function', 'the page listens to both streams')
  const now = () => elements.get('now')!.textContent
  const source = () => elements.get('src')!.textContent

  // An upright phone whose camera faces west (alpha 90, beta 90): 270 degrees, the camera's, from magnetic north.
  absolute({ type: 'deviceorientationabsolute', absolute: true, alpha: 90, beta: 90, gamma: 0 })
  assert.equal(now(), '270.0 deg')
  assert.match(source(), /using: alpha, beta and gamma with absolute=true \(Android, magnetic north, where the camera points\)/)
  assert.match(source(), /deviceorientationabsolute:1/)

  // Android's relative stream speaks between the absolute events: neither the bearing nor the source line changes.
  relative({ type: 'deviceorientation', absolute: false, alpha: 12, beta: 40, gamma: 3 })
  assert.equal(now(), '270.0 deg')
  assert.match(source(), /^using: alpha, beta and gamma with absolute=true/)

  // An iPhone event: its own heading, with the axis named as not known.
  absolute({ type: 'deviceorientation', webkitCompassHeading: 123.4, webkitCompassAccuracy: 10 })
  assert.equal(now(), '123.4 deg')
  assert.match(source(), /using: webkitCompassHeading \(iOS, magnetic north, axis not known\)/)

  // iOS says the heading is invalid: the reading is not blanked and not replaced.
  absolute({ type: 'deviceorientation', webkitCompassHeading: 77, webkitCompassAccuracy: -1 })
  assert.equal(now(), '123.4 deg')
})
