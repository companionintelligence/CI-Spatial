/**
 * The compass heading an orientation event gives (src/geo/compass-heading.ts), checked against a physical
 * model that shares no code with it.
 *
 * `360 - alpha` was the bearing of the TOP EDGE of the phone, and the app used it as the direction the camera
 * points. The two are the same when the phone is not rolled; rolled into landscape they are a
 * quarter turn apart. The code now takes the camera's own axis from the full rotation
 * R = Rz(alpha) Rx(beta) Ry(gamma) (W3C Device Orientation, intrinsic Z-X'-Y''). A formula checked against
 * the formula it was derived from proves nothing, so the oracle (./compass_oracle.ts, shared with
 * compass_pairing.test.ts) is built the other way round:
 *
 *   - a rigid body in a right-handed (east, north, up) world, whose three axes are CARRIED through
 *     the rotations one at a time with Rodrigues' formula (an intrinsic rotation is a rotation about the axis
 *     as it is now, so the pivot is the carried axis, not a fixed one). No matrix product, no closed form;
 *   - a phone placed by what a person does with it: turned to face a heading, tilted down by a pitch, rolled
 *     about the camera axis into portrait or landscape. Its camera heading is the heading it was turned to, by
 *     construction, whatever the roll;
 *   - the angles the browser would report for that pose, found by an inverse of its own (read off the carried
 *     axes), and checked by carrying a body through them again. Where two sets of angles describe one pose
 *     (the specification's ranges leave a second one), both are fed in.
 *
 * What a device's sensors report is not modelled: that is what the DX3 spin test is for. This holds the
 * arithmetic, the axis choice at 60 degrees, the discard rule and the iOS bookkeeping.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/compass_heading.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IOS_COMPASS_SIGMA_FLOOR_DEG,
  MIN_AXIS_HORIZONTAL,
  compassReadingFromEvent,
  headingFromAttitude,
  rawOrientationOf,
  type CompassReading,
} from '../../../src/geo/compass-heading.ts'
import { sessionFrameBearingDeg } from '../../../src/world/geo.ts'
// The physical model of an AR session and a perfect compass the bearing tests are measured against. It imports
// nothing from src/, so it is as independent here as it is there.
import { cameraRotation, perfectCompassBearing, trueSessionZBearing } from '../deno/physical_oracle.ts'
// The rigid body the headings are measured against (carried axes, a phone placed by heading, tilt and roll).
import {
  D2R,
  angDiff,
  axesFromEuler,
  bearingOf,
  dot,
  eulerAnglesFor,
  horizontalPart,
  norm360,
  phoneAt,
  scale,
  cross,
  type Axes,
} from './compass_oracle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// ── The oracle itself ────────────────────────────────────────────────────────────────────────

test('oracle: the carried axes stay a right-handed orthonormal frame through any rotation', () => {
  for (const [a, b, g] of [[0, 0, 0], [30, 40, 50], [200, -120, 70], [359, 179, -89], [10, 90, 0]] as const) {
    const f = axesFromEuler(a, b, g)
    assert.ok(Math.abs(dot(f.x, f.x) - 1) < 1e-12 && Math.abs(dot(f.y, f.y) - 1) < 1e-12 && Math.abs(dot(f.z, f.z) - 1) < 1e-12)
    assert.ok(Math.abs(dot(f.x, f.y)) < 1e-12 && Math.abs(dot(f.y, f.z)) < 1e-12 && Math.abs(dot(f.x, f.z)) < 1e-12)
    const xy = cross(f.x, f.y)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(xy[i]! - f.z[i]!) < 1e-12, `x cross y is z (right-handed) at ${a}, ${b}, ${g}`)
  }
})

test('oracle: the three W3C rotations do what the specification says, one at a time', () => {
  // alpha turns the phone about the vertical, counter-clockwise seen from above: a phone lying flat with its
  // top edge north faces west after 90 degrees, so its top edge's bearing is 270.
  assert.ok(Math.abs(bearingOf(axesFromEuler(90, 0, 0).y) - 270) < 1e-9)
  // beta tips the top edge up: at 90 the phone stands upright, screen towards the viewer in the south, and its camera faces north.
  const upright = axesFromEuler(0, 90, 0)
  assert.ok(Math.abs(upright.y[2] - 1) < 1e-12, 'the top edge is up')
  assert.ok(Math.abs(bearingOf(scale(upright.z, -1))) < 1e-9 || Math.abs(bearingOf(scale(upright.z, -1)) - 360) < 1e-9, 'the camera faces north')
  // gamma turns it about its long axis: -90 stands it on its long edge, screen facing west, camera facing east.
  const sideways = axesFromEuler(0, 0, -90)
  assert.ok(Math.abs(bearingOf(scale(sideways.z, -1)) - 90) < 1e-9)
})

test('oracle: a phone placed by heading, tilt and roll has its camera where it was put, whatever the roll', () => {
  for (const heading of [0, 37, 90, 181, 270, 359]) {
    for (const pitch of [-60, 0, 25, 60, 80]) {
      for (const roll of [0, 10, 90, 180, 270, -40]) {
        const p = phoneAt(heading, pitch, roll)
        const camera = scale(p.z, -1)
        assert.ok(Math.abs(angDiff(bearingOf(camera), heading)) < 1e-9, `heading ${heading}, pitch ${pitch}, roll ${roll}`)
        assert.ok(Math.abs(camera[2] + Math.sin(pitch * D2R)) < 1e-12, 'and it looks down by the pitch')
      }
    }
  }
})

// ── headingFromAttitude: hand-derived cases, no oracle ───────────────────────────────────────

test('hand-derived: a flat phone gives its top edge, 360 - alpha, to the last digit', () => {
  // Lying flat, the camera looks at the floor and has no bearing; the top edge points where alpha says.
  const cases: Array<[number, number]> = [[0, 0], [90, 270], [180, 180], [270, 90], [359, 1], [1, 359], [45, 315]]
  for (const [alpha, heading] of cases) {
    const got = headingFromAttitude(alpha, 0, 0)
    assert.deepEqual(got, { headingDeg: heading, axis: 'top' }, `alpha ${alpha}`)
  }
  // Turned over (face down): the top edge points the other way round, 180 - alpha.
  assert.deepEqual(headingFromAttitude(0, 180, 0), { headingDeg: 180, axis: 'top' })
  assert.deepEqual(headingFromAttitude(30, -180, 0), { headingDeg: 150, axis: 'top' })
})

test('hand-derived: upright in portrait, the camera faces where 360 - alpha says', () => {
  for (const [alpha, heading] of [[0, 0], [90, 270], [180, 180], [270, 90]] as const) {
    const got = headingFromAttitude(alpha, 90, 0)!
    assert.equal(got.axis, 'camera')
    assert.ok(Math.abs(angDiff(got.headingDeg, heading)) < 1e-9, `alpha ${alpha}: ${got.headingDeg}`)
  }
})

test('hand-derived: rolled into landscape, 360 - alpha is a quarter turn from where the camera looks', () => {
  // alpha 0, beta 0, gamma -90: the phone stands on its long edge with the screen facing west, so the camera faces east.
  const right = headingFromAttitude(0, 0, -90)!
  assert.equal(right.axis, 'camera')
  assert.ok(Math.abs(angDiff(right.headingDeg, 90)) < 1e-9, `${right.headingDeg}`)
  const left = headingFromAttitude(0, 0, 90)!
  assert.ok(Math.abs(angDiff(left.headingDeg, 270)) < 1e-9, `${left.headingDeg}`)
  // What the old conversion said for both, 360 - 0: north.
  assert.equal(Math.abs(angDiff(0, right.headingDeg)), 90)
  assert.equal(Math.abs(angDiff(0, left.headingDeg)), 90)
})

test('hand-derived: upright with a roll of g degrees, the camera is g degrees from the top edge, so 360 - alpha is g out', () => {
  for (const gamma of [-30, -10, 10, 30]) {
    const alpha = 100
    const got = headingFromAttitude(alpha, 90, gamma)!
    assert.equal(got.axis, 'camera')
    // The camera faces 360 - alpha - gamma: the heading the old conversion gave, less the roll.
    assert.ok(Math.abs(angDiff(got.headingDeg, 360 - alpha - gamma)) < 1e-9, `gamma ${gamma}: ${got.headingDeg}`)
    assert.ok(Math.abs(Math.abs(angDiff(got.headingDeg, 360 - alpha)) - Math.abs(gamma)) < 1e-9)
  }
})

// ── headingFromAttitude against the oracle ───────────────────────────────────────────────────

/** What the oracle says a pose's heading is, and which axis it is the heading of. */
function expectedFor(axes: Axes): { cameraHeading: number, topHeading: number, cameraHorizontal: number } {
  const camera = scale(axes.z, -1)
  return { cameraHeading: bearingOf(camera), topHeading: bearingOf(axes.y), cameraHorizontal: horizontalPart(camera) }
}

const HEADINGS = Array.from({ length: 24 }, (_, i) => i * 15).concat([359.99, 0.01])
/** Camera pitch below the horizon: level, a casual hold, 59 and 61 either side of the line, the tap posture, and nearly straight down or up. */
const PITCHES = [-85, -60, -30, 0, 10, 25, 45, 59, 60, 61, 70, 85, 89.9]
/** Rolls about the camera axis: portrait, a small lean, the two landscapes with a lean, upside down. */
const ROLLS = [0, 10, -10, 90, 100, 270, 260, 180]

test('every pose of a phone turned, tilted and rolled: the camera heading while the camera is within 60 degrees of level, else the top edge', () => {
  let cameraCases = 0
  let topCases = 0
  let lineCases = 0
  let compared = 0
  for (const heading of HEADINGS) {
    for (const pitch of PITCHES) {
      for (const roll of ROLLS) {
        const axes = phoneAt(heading, pitch, roll)
        const want = expectedFor(axes)
        for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
          const got = headingFromAttitude(alpha, beta, gamma)
          assert.ok(got !== null, `heading ${heading}, pitch ${pitch}, roll ${roll}: no heading from ${alpha}, ${beta}, ${gamma}`)
          const at = `heading ${heading}, pitch ${pitch}, roll ${roll} (angles ${alpha.toFixed(3)}, ${beta.toFixed(3)}, ${gamma.toFixed(3)})`
          compared++
          if (want.cameraHorizontal > MIN_AXIS_HORIZONTAL + 1e-7) {
            cameraCases++
            assert.equal(got.axis, 'camera', at)
            assert.ok(Math.abs(angDiff(got.headingDeg, want.cameraHeading)) < 1e-8, `${at}: ${got.headingDeg}, the camera faces ${want.cameraHeading}`)
            // The oracle's own account of the pose: the camera is where the person put it.
            assert.ok(Math.abs(angDiff(got.headingDeg, heading)) < 1e-8, `${at}: ${got.headingDeg}, the phone was turned to ${heading}`)
          } else if (want.cameraHorizontal < MIN_AXIS_HORIZONTAL - 1e-7) {
            topCases++
            assert.equal(got.axis, 'top', at)
            assert.ok(Math.abs(angDiff(got.headingDeg, want.topHeading)) < 1e-8, `${at}: ${got.headingDeg}, the top edge points ${want.topHeading}`)
          } else {
            // On the line, within 1e-7 of 0.5: either axis, but the heading must be that axis's own.
            lineCases++
            const own = got.axis === 'camera' ? want.cameraHeading : want.topHeading
            assert.ok(Math.abs(angDiff(got.headingDeg, own)) < 1e-8, `${at}: ${got.axis} ${got.headingDeg}, that axis points ${own}`)
          }
        }
      }
    }
  }
  assert.equal(compared, HEADINGS.length * PITCHES.length * ROLLS.length * 2, 'both sets of angles for every pose')
  // The grid splits as it was drawn: the pitches inside 60 degrees are all camera, those beyond it all top edge, and 60 itself is the line.
  const perPitch = HEADINGS.length * ROLLS.length * 2
  assert.equal(cameraCases, PITCHES.filter((p) => Math.abs(p) < 60).length * perPitch)
  assert.equal(topCases, PITCHES.filter((p) => Math.abs(p) > 60).length * perPitch)
  assert.equal(lineCases, PITCHES.filter((p) => Math.abs(p) === 60).length * perPitch)
})

test('a dense grid of raw angles: the heading is that of the carried body, and no finite attitude is discarded', () => {
  let n = 0
  let camera = 0
  let top = 0
  let worst = 0
  for (let alpha = 0; alpha < 360; alpha += 11.5) {
    for (let beta = -180; beta < 180; beta += 7) {
      for (let gamma = -90; gamma <= 90; gamma += 7.5) {
        const axes = axesFromEuler(alpha, beta, gamma)
        const want = expectedFor(axes)
        const got = headingFromAttitude(alpha, beta, gamma)
        // The discard rule's second half: a finite attitude always has a usable axis, because the two are at right angles.
        assert.ok(got !== null, `${alpha}, ${beta}, ${gamma} was discarded`)
        n++
        if (got.axis === 'camera') {
          camera++
          assert.ok(want.cameraHorizontal >= MIN_AXIS_HORIZONTAL - 1e-8, `${alpha}, ${beta}, ${gamma}: camera chosen with ${want.cameraHorizontal} horizontal`)
          worst = Math.max(worst, Math.abs(angDiff(got.headingDeg, want.cameraHeading)))
        } else {
          top++
          assert.ok(want.cameraHorizontal <= MIN_AXIS_HORIZONTAL + 1e-8, `${alpha}, ${beta}, ${gamma}: top edge chosen with the camera ${want.cameraHorizontal} horizontal`)
          assert.ok(horizontalPart(axes.y) >= Math.sqrt(3) / 2 - 1e-8, `${alpha}, ${beta}, ${gamma}: the top edge is steep too, which two axes at right angles cannot be`)
          worst = Math.max(worst, Math.abs(angDiff(got.headingDeg, want.topHeading)))
        }
      }
    }
  }
  assert.ok(worst < 1e-8, `worst error ${worst} degrees over ${n} attitudes`)
  assert.ok(camera > 10000 && top > 1000, `${camera} camera, ${top} top edge`)
})

test('the tap posture: a camera pitched 60 degrees down is on the camera side of the line, in portrait and in landscape', () => {
  for (const roll of [0, 90, 180, 270]) {
    for (const heading of [0, 123, 301]) {
      const axes = phoneAt(heading, 60, roll)
      for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
        const got = headingFromAttitude(alpha, beta, gamma)!
        // 60 degrees is the line, and the line belongs to the camera: cos(60) is 0.5000000000000001 and the same
        // sum in another order is 0.49999999999999994, which must not decide it.
        assert.equal(got.axis, 'camera', `roll ${roll}, heading ${heading}`)
        assert.ok(Math.abs(angDiff(got.headingDeg, heading)) < 1e-8, `roll ${roll}, heading ${heading}: ${got.headingDeg}`)
      }
    }
  }
})

test('past 60 degrees the top edge takes over: in portrait it is the same heading, in landscape a quarter turn off, and the reading says so', () => {
  const heading = 200
  const portrait = eulerAnglesFor(phoneAt(heading, 61, 0))[0]!
  const portraitGot = headingFromAttitude(...portrait)!
  assert.equal(portraitGot.axis, 'top')
  assert.ok(Math.abs(angDiff(portraitGot.headingDeg, heading)) < 1e-8, 'in portrait the top edge points where the camera faces')
  for (const [roll, offset] of [[90, 90], [270, -90]] as const) {
    const angles = eulerAnglesFor(phoneAt(heading, 61, roll))[0]!
    const got = headingFromAttitude(...angles)!
    assert.equal(got.axis, 'top', `roll ${roll}`)
    assert.ok(Math.abs(angDiff(got.headingDeg, heading + offset)) < 1e-8, `roll ${roll}: the top edge points ${got.headingDeg}, ${offset} degrees from the camera's heading`)
    // One degree less steep and it is the camera again.
    const shallower = headingFromAttitude(...eulerAnglesFor(phoneAt(heading, 59, roll))[0]!)!
    assert.equal(shallower.axis, 'camera')
    assert.ok(Math.abs(angDiff(shallower.headingDeg, heading)) < 1e-8)
  }
})

test('the camera heading does not depend on the screen orientation, the top edge does', () => {
  // The device frame is fixed to the phone in its natural orientation (W3C section 3.1), so rolling the phone
  // changes the angles but not where the camera faces.
  const heading = 77
  for (const pitch of [-50, 0, 30, 55]) {
    const headings = [0, 90, 180, 270].map((roll) => headingFromAttitude(...eulerAnglesFor(phoneAt(heading, pitch, roll))[0]!)!)
    for (const got of headings) {
      assert.equal(got.axis, 'camera')
      assert.ok(Math.abs(angDiff(got.headingDeg, heading)) < 1e-8, `pitch ${pitch}: ${got.headingDeg}`)
    }
  }
  const tops = [0, 90, 180, 270].map((roll) => headingFromAttitude(...eulerAnglesFor(phoneAt(heading, 80, roll))[0]!)!)
  assert.deepEqual(tops.map((t) => t.axis), ['top', 'top', 'top', 'top'])
  assert.deepEqual(tops.map((t) => Math.round(norm360(t.headingDeg - heading))), [0, 90, 180, 270], 'the top edge follows the roll')
})

test('the old conversion (360 - alpha) against the oracle: the camera axis fixes the lean and the landscape, a steep camera stays the top edge by the rule', () => {
  // The regression guard: what the app published until this change is the TOP EDGE's bearing (for |beta| < 90 it is
  // exactly -alpha, whatever gamma is), held against the oracle so it cannot come back unnoticed as "the camera".
  // [beta, gamma, how far the camera's bearing is from the top edge's, which axis the rule publishes]: the four
  // figures of the investigation (10 degrees of lean when upright, 23 at 25 degrees of tilt, 45 at 10 degrees of tilt,
  // 90 in landscape), recomputed from the carried body and not taken on trust.
  const figures: Array<[number, number, number, 'camera' | 'top']> = [
    [90, 10, 10, 'camera'],
    [25, 10, 22.6, 'top'],
    [10, 10, 45.4, 'top'],
    [0, -90, 90, 'camera'],
    [0, 90, 90, 'camera'],
    [90, -30, 30, 'camera'],
  ]
  const old = (alpha: number) => norm360(360 - alpha)
  for (const alpha of [0, 33, 120, 275]) {
    for (const [beta, gamma, apart, axis] of figures) {
      const axes = axesFromEuler(alpha, beta, gamma)
      const want = expectedFor(axes)
      assert.ok(Math.abs(Math.abs(angDiff(want.cameraHeading, want.topHeading)) - apart) < 0.1, `alpha ${alpha}, beta ${beta}, gamma ${gamma}: the oracle puts the camera ${angDiff(want.cameraHeading, want.topHeading)} from the top edge, the investigation said ${apart}`)
      // For |beta| < 90 the top edge's bearing is the old conversion, exactly.
      if (beta < 90) assert.ok(Math.abs(angDiff(want.topHeading, old(alpha))) < 1e-9, `the old conversion is the top edge's bearing at beta ${beta}`)
      const got = headingFromAttitude(alpha, beta, gamma)!
      assert.equal(got.axis, axis, `alpha ${alpha}, beta ${beta}, gamma ${gamma}`)
      if (axis === 'camera') {
        assert.ok(Math.abs(angDiff(got.headingDeg, want.cameraHeading)) < 1e-8)
        // And the old conversion was out by that much: the camera axis is what moves it.
        assert.ok(Math.abs(Math.abs(angDiff(old(alpha), got.headingDeg)) - apart) < 0.1 || beta === 90, `alpha ${alpha}, beta ${beta}, gamma ${gamma}`)
      } else {
        // A camera more than 60 degrees below the horizon has no reliable bearing of its own: the top edge, which is what was published before.
        assert.ok(Math.abs(angDiff(got.headingDeg, old(alpha))) < 1e-9, `alpha ${alpha}, beta ${beta}, gamma ${gamma}: ${got.headingDeg}`)
      }
    }
  }
  // Upright, the old conversion is out by exactly the lean, either way.
  for (const gamma of [-30, -10, 10, 30]) {
    const got = headingFromAttitude(100, 90, gamma)!
    assert.ok(Math.abs(Math.abs(angDiff(old(100), got.headingDeg)) - Math.abs(gamma)) < 1e-9)
  }
})

test('360 - alpha is the camera\'s bearing exactly when the phone is not rolled, and is what the rule publishes whenever it has fallen back to the top edge of a phone not turned over', () => {
  // What the module header and the telemetry sender (which keeps 360 - alpha) say about when the two agree: not
  // "only when upright", but at any tilt of an unrolled phone (gamma 0 and beta between 0 and 180), and on the top edge's side of the
  // 60 degree line (where the rule falls back to the top edge), and apart otherwise.
  const old = (alpha: number) => norm360(360 - alpha)
  let unrolled = 0
  let fallback = 0
  let apart = 0
  for (let alpha = 0; alpha < 360; alpha += 23) {
    for (let beta = -170; beta <= 170; beta += 10) {
      for (const gamma of [-90, -45, -10, 0, 10, 45, 90]) {
        const axes = axesFromEuler(alpha, beta, gamma)
        const want = expectedFor(axes)
        const rule = headingFromAttitude(alpha, beta, gamma)!
        if (gamma === 0 && beta > 0 && beta < 180) {
          assert.ok(Math.abs(angDiff(want.cameraHeading, old(alpha))) < 1e-8, `unrolled, beta ${beta}: the camera faces ${want.cameraHeading}, 360 - alpha says ${old(alpha)}`)
          unrolled++
        } else if (rule.axis === 'top' && beta > -90 && beta < 90) {
          assert.ok(Math.abs(angDiff(rule.headingDeg, old(alpha))) < 1e-8, `${alpha}, ${beta}, ${gamma}: the rule fell back to the top edge`)
          fallback++
        } else if (rule.axis === 'camera' && want.cameraHorizontal > 0.2 && Math.abs(angDiff(rule.headingDeg, old(alpha))) > 1) {
          apart++
        }
      }
    }
  }
  assert.ok(unrolled > 100 && fallback > 50 && apart > 100, `${unrolled} unrolled, ${fallback} fallen back, ${apart} apart`)
  // A tilt that is not upright, unrolled: the claim that it agrees only upright is the one this replaces.
  assert.ok(Math.abs(angDiff(expectedFor(axesFromEuler(100, 45, 0)).cameraHeading, old(100))) < 1e-8, 'tipped back 45 degrees and not rolled, the two agree')
})

test('end to end: the camera heading with the AR yaw gives the true bearing of session +Z in every posture within 60 degrees, landscape included; the old conversion does not', () => {
  // The calibration adds the camera's yaw in the session to the compass bearing (sessionFrameBearingDeg, F53). That
  // is right only if the bearing is the bearing of the SAME direction the yaw is read from: the camera's. A session
  // that started facing `psi` has +Z at psi + 180; a phone turned to face `heading`, tilted and rolled, reports the
  // angles generated here, and the AR pose has the camera at that heading and tilt (the roll about the camera axis
  // is invisible to a yaw read from the forward vector).
  let landscapeGuards = 0
  for (const psi of [0, 77, 200]) {
    for (const heading of [0, 45, 130, 290]) {
      for (const pitch of [0, 30, 55]) {
        for (const roll of [0, 90, 270, 15]) {
          const [alpha, beta, gamma] = eulerAnglesFor(phoneAt(heading, pitch, roll))[0]!
          const compass = headingFromAttitude(alpha, beta, gamma)!
          assert.equal(compass.axis, 'camera')
          // The AR camera: this session started facing psi, and the camera has since turned to `heading` (a left turn of psi - heading).
          const q = cameraRotation(psi - heading, pitch)
          assert.ok(Math.abs(angDiff(perfectCompassBearing(psi, q), heading)) < 1e-9, 'the model puts the camera where the phone is')
          const truth = trueSessionZBearing(psi)
          const got = sessionFrameBearingDeg(compass.headingDeg, q)!
          assert.ok(Math.abs(angDiff(got, truth)) < 1e-6, `psi ${psi}, heading ${heading}, pitch ${pitch}, roll ${roll}: ${got}, truth ${truth}`)
          // The old conversion, 360 - alpha, is the top edge's bearing: in landscape it is a quarter turn out, and so is the frame's.
          const old = sessionFrameBearingDeg(norm360(360 - alpha), q)!
          if (roll === 90 || roll === 270) {
            assert.ok(Math.abs(Math.abs(angDiff(old, truth)) - 90) < 1e-6, `psi ${psi}, heading ${heading}, pitch ${pitch}, roll ${roll}: the old conversion is ${angDiff(old, truth)} out`)
            landscapeGuards++
          }
          if (roll === 0) assert.ok(Math.abs(angDiff(old, truth)) < 1e-6, 'in portrait with no roll the old conversion was right')
        }
      }
    }
  }
  assert.equal(landscapeGuards, 3 * 4 * 3 * 2)
})

// ── beta, gamma and alpha edge cases ─────────────────────────────────────────────────────────

test('beta of +-90: upright or hanging, where alpha and gamma only matter together, the camera heading is still defined', () => {
  for (const beta of [90, -90]) {
    for (const [alpha, gamma] of [[0, 0], [40, 0], [40, 25], [200, -60], [359, 89]] as const) {
      const axes = axesFromEuler(alpha, beta, gamma)
      const want = expectedFor(axes)
      const got = headingFromAttitude(alpha, beta, gamma)!
      // Hanging (beta -90) the camera looks at the sky or the ground at an angle set by gamma.
      if (want.cameraHorizontal >= 0.5) {
        assert.equal(got.axis, 'camera', `beta ${beta}, alpha ${alpha}, gamma ${gamma}`)
        assert.ok(Math.abs(angDiff(got.headingDeg, want.cameraHeading)) < 1e-8, `beta ${beta}, alpha ${alpha}, gamma ${gamma}: ${got.headingDeg} against ${want.cameraHeading}`)
      } else {
        assert.equal(got.axis, 'top')
      }
    }
  }
  // Upright, the heading is a function of alpha + gamma alone: 360 - (alpha + gamma).
  const a = headingFromAttitude(30, 90, 20)!
  const b = headingFromAttitude(50, 90, 0)!
  assert.ok(Math.abs(angDiff(a.headingDeg, b.headingDeg)) < 1e-9)
  assert.ok(Math.abs(angDiff(a.headingDeg, 310)) < 1e-9)
})

test('beta of +-180 and gamma of +-90, the ends of the specification\'s ranges', () => {
  for (const [alpha, beta, gamma] of [[10, 180, 0], [10, -180, 0], [10, 0, -90], [10, 0, 90], [200, 180, 90], [200, -180, -90], [0, 179.99, 0], [0, -179.99, 0], [0, 0.01, 89.99]] as const) {
    const axes = axesFromEuler(alpha, beta, gamma)
    const want = expectedFor(axes)
    const got = headingFromAttitude(alpha, beta, gamma)!
    assert.ok(got !== null, `${alpha}, ${beta}, ${gamma}`)
    const own = got.axis === 'camera' ? want.cameraHeading : want.topHeading
    assert.ok(Math.abs(angDiff(got.headingDeg, own)) < 1e-8, `${alpha}, ${beta}, ${gamma}: ${got.axis} ${got.headingDeg} against ${own}`)
  }
  // Face down on a table and face up are both flat: the top edge.
  assert.equal(headingFromAttitude(0, 180, 0)!.axis, 'top')
  assert.equal(headingFromAttitude(0, 0, 0)!.axis, 'top')
})

test('alpha outside 0 to 360 is the same turn as inside it, and the heading is always in [0, 360)', () => {
  for (const alpha of [0, 360, -10, 350, 720, 725.5, -370]) {
    for (const [beta, gamma] of [[90, 0], [0, 0], [30, 20], [90, -90]] as const) {
      const got = headingFromAttitude(alpha, beta, gamma)!
      const same = headingFromAttitude(norm360(alpha), beta, gamma)!
      assert.ok(got.headingDeg >= 0 && got.headingDeg < 360, `${alpha}: ${got.headingDeg}`)
      assert.equal(got.axis, same.axis)
      assert.ok(Math.abs(angDiff(got.headingDeg, same.headingDeg)) < 1e-8)
    }
  }
})

test('the same pose described by its two sets of angles gives one heading and one axis', () => {
  let poses = 0
  for (const heading of [0, 100, 260]) {
    for (const pitch of [-45, 20, 55, 75]) {
      for (const roll of [0, 90, 180, 270, 35]) {
        const [first, second] = eulerAnglesFor(phoneAt(heading, pitch, roll)) as [[number, number, number], [number, number, number]]
        const a = headingFromAttitude(...first)!
        const b = headingFromAttitude(...second)!
        assert.equal(a.axis, b.axis)
        assert.ok(Math.abs(angDiff(a.headingDeg, b.headingDeg)) < 1e-8, `heading ${heading}, pitch ${pitch}, roll ${roll}`)
        poses++
      }
    }
  }
  assert.equal(poses, 60)
})

// ── The discard rule ─────────────────────────────────────────────────────────────────────────

test('an angle that is not a finite number discards the sample, and no other angles are ever discarded', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (const value of bad) {
    assert.equal(headingFromAttitude(value, 30, 10), null, `alpha ${value}`)
    assert.equal(headingFromAttitude(30, value, 10), null, `beta ${value}`)
    assert.equal(headingFromAttitude(30, 30, value), null, `gamma ${value}`)
  }
  assert.equal(headingFromAttitude(Number.NaN, Number.NaN, Number.NaN), null)
  assert.notEqual(headingFromAttitude(0, 0, 0), null, 'a flat phone is not discarded')
  assert.notEqual(headingFromAttitude(1e9, 1e9, 1e9), null, 'a huge finite angle is a rotation like any other')
})

test('an event with an angle that is not a finite number is refused, which clears the reading and keeps no stale heading', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(read({ absolute: true, alpha: bad, beta: 10, gamma: 10 }), null, `alpha ${bad}`)
    assert.equal(read({ absolute: true, alpha: 10, beta: bad, gamma: 10 }), null, `beta ${bad}`)
    assert.equal(read({ absolute: true, alpha: 10, beta: 10, gamma: bad }), null, `gamma ${bad}`)
  }
})

test('an event that carries no beta or gamma reads them as 0, as the specification\'s own example does: a flat phone, named as the top edge', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent) as CompassReading
  for (const e of [{ absolute: true, alpha: 270 }, { absolute: true, alpha: 270, beta: null, gamma: null }, { absolute: true, alpha: 270, beta: undefined }]) {
    const got = read(e)
    assert.equal(got.headingDeg, 90)
    assert.equal(got.axis, 'top')
  }
  // Only one of the two missing: the one that is there counts.
  assert.deepEqual(
    [read({ absolute: true, alpha: 0, beta: null, gamma: -90 }).headingDeg, read({ absolute: true, alpha: 0, beta: null, gamma: -90 }).axis],
    [90, 'camera'],
  )
  assert.equal(read({ absolute: true, alpha: 0, beta: 90, gamma: null }).axis, 'camera')
})

// ── The reading an event gives ───────────────────────────────────────────────────────────────

test('an Android reading is magnetic, says which axis it follows, and has no accuracy figure and no seed uncertainty', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent) as CompassReading
  const upright = read({ absolute: true, alpha: 90, beta: 90, gamma: 0 })
  assert.deepEqual(
    [upright.northReference, upright.axis, upright.source, upright.accuracyDeg, upright.sigmaDeg],
    ['magnetic', 'camera', 'android-absolute', null, null],
  )
  assert.ok(Math.abs(angDiff(upright.headingDeg, 270)) < 1e-9)
  const flat = read({ absolute: true, alpha: 90, beta: 0, gamma: 0 })
  assert.deepEqual([flat.axis, flat.headingDeg, flat.northReference], ['top', 270, 'magnetic'])
})

test('an iPhone reading is magnetic, names no axis, and is never given less than 25 degrees of uncertainty', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent) as CompassReading
  assert.equal(IOS_COMPASS_SIGMA_FLOOR_DEG, 25)
  const sharp = read({ webkitCompassHeading: 123.4, webkitCompassAccuracy: 10, beta: 60, gamma: 3, alpha: 12 })
  assert.deepEqual(
    [sharp.headingDeg, sharp.northReference, sharp.axis, sharp.source, sharp.accuracyDeg, sharp.sigmaDeg],
    [123.4, 'magnetic', 'unknown', 'ios-compass', 10, 25],
    'the platform says 10 and the floor says 25: the larger',
  )
  assert.equal(read({ webkitCompassHeading: 10, webkitCompassAccuracy: 40 }).sigmaDeg, 40, 'a worse figure than the floor stands')
  assert.equal(read({ webkitCompassHeading: 10, webkitCompassAccuracy: 25 }).sigmaDeg, 25)
  assert.equal(read({ webkitCompassHeading: 10, webkitCompassAccuracy: 0 }).sigmaDeg, 25, 'an accuracy of 0 is valid and the floor still holds')
  const none = read({ webkitCompassHeading: 10 })
  assert.deepEqual([none.accuracyDeg, none.sigmaDeg], [null, 25], 'no accuracy: null, which is unknown, and the floor')
  const odd = read({ webkitCompassHeading: 10, webkitCompassAccuracy: Number.NaN })
  assert.deepEqual([odd.accuracyDeg, odd.sigmaDeg], [null, 25], 'an accuracy that is not a number is no figure')
  assert.equal(read({ webkitCompassHeading: 10, webkitCompassAccuracy: Number.POSITIVE_INFINITY }).sigmaDeg, 25)
})

test('an iPhone heading Apple documents as invalid is refused: negative, not a number, or a negative accuracy', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent)
  assert.equal(read({ webkitCompassHeading: -1 }), null, 'a negative value indicates an invalid direction')
  assert.equal(read({ webkitCompassHeading: -0.001, webkitCompassAccuracy: 5 }), null)
  assert.equal(read({ webkitCompassHeading: 90, webkitCompassAccuracy: -1 }), null, '-1 means the compass is not calibrated')
  assert.equal(read({ webkitCompassHeading: 90, webkitCompassAccuracy: Number.NEGATIVE_INFINITY }), null)
  assert.equal(read({ webkitCompassHeading: Number.NaN }), null)
  assert.equal(read({ webkitCompassHeading: Number.POSITIVE_INFINITY, webkitCompassAccuracy: 10 }), null)
  assert.equal((read({ webkitCompassHeading: 0 }) as CompassReading).headingDeg, 0, 'north is a heading, not an invalid one')
})

test('an iPhone heading at or past 360 is folded into [0, 360), and one inside it is passed on as it came', () => {
  const read = (e: object) => (compassReadingFromEvent(e as unknown as DeviceOrientationEvent) as CompassReading).headingDeg
  assert.equal(read({ webkitCompassHeading: 360 }), 0)
  assert.equal(read({ webkitCompassHeading: 725 }), 5)
  assert.equal(read({ webkitCompassHeading: 359.9 }), 359.9)
  assert.equal(read({ webkitCompassHeading: 123.4 }), 123.4, 'not rounded or refolded: the number the platform gave')
})

test('an iPhone event is read for its heading even when it also carries an absolute alpha, and the heading is not recomputed from the angles', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent) as CompassReading
  const got = read({ webkitCompassHeading: 200, webkitCompassAccuracy: 12, absolute: true, alpha: 10, beta: 90, gamma: 0 })
  assert.equal(got.headingDeg, 200)
  assert.equal(got.source, 'ios-compass')
})

test('events that say nothing about the compass say nothing: a relative alpha, no alpha, an alpha that is not a number', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent)
  assert.equal(read({ absolute: false, alpha: 90, beta: 10, gamma: 10 }), undefined)
  assert.equal(read({ alpha: 90 }), undefined)
  assert.equal(read({ absolute: true, alpha: null, beta: null, gamma: null }), undefined)
  assert.equal(read({ absolute: true, alpha: '90' }), undefined)
  assert.equal(read({}), undefined)
})

test('the raw sample keeps the numbers as delivered, and null where a field is not a number or not there', () => {
  const raw = (e: object) => rawOrientationOf(e as unknown as DeviceOrientationEvent)
  assert.deepEqual(
    raw({ absolute: true, alpha: 12.5, beta: -80, gamma: 3, webkitCompassHeading: 100, webkitCompassAccuracy: 15 }),
    { alpha: 12.5, beta: -80, gamma: 3, absolute: true, webkitCompassHeading: 100, webkitCompassAccuracy: 15 },
  )
  assert.deepEqual(
    raw({}),
    { alpha: null, beta: null, gamma: null, absolute: null, webkitCompassHeading: null, webkitCompassAccuracy: null },
  )
  assert.deepEqual(
    raw({ absolute: false, alpha: null, beta: '5', gamma: undefined, webkitCompassHeading: 'north' }),
    { alpha: null, beta: null, gamma: null, absolute: false, webkitCompassHeading: null, webkitCompassAccuracy: null },
  )
  // Not cleaned up: a NaN the browser delivered is a NaN in the record, so the log shows what the sensor said.
  assert.ok(Number.isNaN(raw({ alpha: Number.NaN }).alpha))
  assert.equal(raw({ absolute: 1 }).absolute, null, 'a flag that is not a boolean is not one')
})

// ── What the app says about the compass ──────────────────────────────────────────────────────

test('source shape: the export summary calls the compass bearing magnetic, not true north', () => {
  // The line is user-visible text in a file that cannot be run here (it downloads and uploads), so it is read as source.
  const summary = read('src/export/summary.ts')
  assert.ok(summary.includes('° (magnetic north) |`'), 'the Compass Bearing row says which north it is')
  assert.ok(!/true[- ]north/i.test(summary), 'and nothing in it says true north')
})

test('source shape: the phone telemetry sender no longer says iOS applies declination, and cites Apple for what it does say', () => {
  const sender = read('src/capture/phone-telemetry-sender.ts')
  assert.doesNotMatch(sender, /iOS applies (magnetic )?declination/i)
  assert.match(sender, /relative to\s+\* magnetic north/)
  assert.ok(sender.includes('https://developer.apple.com/documentation/webkitjs/deviceorientationevent/1804777-webkitcompassheading'))
  // And it does not say its conversion is geo-tracker's: geo-tracker moved to the camera axis, this keeps the top edge.
  assert.doesNotMatch(sender, /Same conversion src\/geo\/geo-tracker\.ts uses/)
  assert.match(sender, /bearing of the TOP EDGE/)
})

test('source shape: GeoPose says it is a GPS fix and not an OGC GeoPose, and the fix says its bearing is magnetic', () => {
  const types = read('src/world/types.ts')
  const doc = types.slice(types.lastIndexOf('/**', types.indexOf('export interface GeoPose {')), types.indexOf('export interface GeoPose {'))
  assert.match(doc, /It is NOT an OGC GeoPose/)
  assert.match(doc, /MAGNETIC north/)
  assert.match(doc, /https:\/\/www\.ogc\.org\/standards\/geopose\//)
  const tracker = read('src/geo/geo-tracker.ts')
  assert.match(tracker.slice(tracker.indexOf('export interface GeoFix'), tracker.indexOf('export interface AddressComponents')), /clockwise from MAGNETIC north/)
})

test('source shape: the module uses no Deno API and imports only the browser-safe bearing helper (ADR 0002), and flags every constant it adopted (ADR 0005 rule 5)', () => {
  const source = read('src/geo/compass-heading.ts')
  assert.doesNotMatch(source, /\bDeno\.[A-Za-z]/, 'no use of the Deno namespace')
  assert.doesNotMatch(source, /\b(window|document|navigator|performance|Date)\b\./, 'and no DOM or clock: it is pure')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['../world/geo.ts', '../world/types.ts'], 'its imports are the browser-safe geometry module and the shared types')
  assert.match(source, /^import type \{ Quat \} from '\.\.\/world\/types\.ts'$/m, 'and the types are imported as types')
  for (const name of ['MIN_AXIS_HORIZONTAL', 'ROUNDING_GUARD', 'IOS_COMPASS_SIGMA_FLOOR_DEG', 'MIN_GRAVITY_IN_SCREEN_PLANE', 'MAX_SCREEN_TURN_RESIDUAL_DEG']) {
    const at = source.search(new RegExp(`const ${name} =`))
    assert.ok(at > 0, `${name} is declared`)
    const comment = source.slice(source.lastIndexOf('/**', at), at)
    assert.match(comment, /Adopted, not measured \(ADR 0005 rule 5\)/, `${name} carries the flag`)
  }
  // The relay's cut is the other constant this change adopted: it follows the server's.
  const relay = read('src/debug/remote-log.ts')
  const cut = relay.indexOf('const MAX_MSG_CHARS')
  assert.match(relay.slice(relay.lastIndexOf('/**', cut), cut), /Adopted, not measured \(ADR 0005 rule 5\)/)
})
