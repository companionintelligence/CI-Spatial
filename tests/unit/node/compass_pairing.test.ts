/**
 * Pairing a compass heading with the AR camera's pose (`pairCompassWithPose`, `screenTurnDeg` and
 * `axisHeadingsFromAttitude` in src/geo/compass-heading.ts), checked against a physical model that shares no
 * code with it (./compass_oracle.ts).
 *
 * The calibration turns a compass bearing into the bearing of the AR session's +Z axis by adding the camera's
 * yaw in the session (`sessionFrameBearingDeg`, F53). That is right only if the bearing and the yaw describe the
 * SAME direction. The camera's forward direction is the same in the browser's frame and the AR runtime's whatever
 * either does to its frame when the screen is rotated, and its heading is used as it stands. The top edge is not:
 * the heading the rule falls back to when the camera points more than 60 degrees up or down belongs to the top
 * edge, and paired with the camera's forward yaw it was wrong by the phone's lean or roll (up to 90 degrees in
 * landscape), and stepped at the 60 degree line. The code now measures, from the direction of gravity each side
 * sees, how the runtime's camera frame is turned against the browser's about the screen's normal, carries the
 * top edge's heading to the camera through that turn, and withholds a bearing it cannot carry.
 *
 * What is held here:
 *
 *  - the bearing handed to the calibration gives the TRUE bearing of the session's +Z axis, to 1e-6 degrees, in
 *    every posture where one is handed over: with the camera within 60 degrees of level (the heading as it is),
 *    and beyond it as far as gravity can be read in the screen's plane (72.5 degrees from level), for the four
 *    ways the two frames can be turned against each other (none, a quarter either way, a half), for portrait and
 *    landscape, with lean, and for both sets of angles that describe one pose;
 *  - past that, nothing is handed over: never a bearing that is a quarter turn out;
 *  - the two sides of the 60 degree line agree, which the old pairing did not;
 *  - the turn is measured, not assumed: it is what the oracle turned the runtime's frame by;
 *  - a pair of sources that do not describe one attitude is refused, and ordinary sensor error is not;
 *  - the earlier rule `?compass=alpha` gives exactly the numbers the earlier code did, and says it follows no axis.
 *
 * What a device's sensors and an AR runtime report is not modelled: that is what DX3 is for.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/compass_pairing.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_GRAVITY_DISAGREEMENT_DEG,
  MAX_SCREEN_TURN_RESIDUAL_DEG,
  MIN_AXIS_HORIZONTAL,
  MIN_GRAVITY_IN_SCREEN_PLANE,
  axisHeadingsFromAttitude,
  compassReadingFromEvent,
  compassRuleFromSearch,
  headingFromAttitude,
  pairCompassWithPose,
  rawOrientationOf,
  screenTurnDeg,
  type CompassReading,
  type CompassSample,
} from '../../../src/geo/compass-heading.ts'
import { normaliseBearingDeg, sessionFrameBearingDeg } from '../../../src/world/geo.ts'
// The shared physical model of an AR session: quaternion arithmetic written out, as independent of src/ as this is.
import { mulQuat, pitchQuat, rotateByQuat } from '../deno/physical_oracle.ts'
import {
  R2D,
  angDiff,
  arPoseFor,
  axesFromEuler,
  bearingOf,
  dot,
  eulerAnglesFor,
  horizontalPart,
  phoneAt,
  scale,
  sessionAxes,
  type Axes,
  type Quaternion,
  type V,
} from './compass_oracle.ts'

/** The camera axis in earth coordinates: the phone's -Z. */
const cameraOf = (axes: Axes): V => scale(axes.z, -1)

/** The sample an Android phone with these angles delivers, made by the app's own reader. */
function absoluteSample(alpha: number, beta: number, gamma: number): CompassSample {
  const event = { absolute: true, alpha, beta, gamma } as unknown as DeviceOrientationEvent
  return { raw: rawOrientationOf(event), reading: compassReadingFromEvent(event) as CompassReading | null }
}

/** What the calibration's frame bearing is for a paired bearing and a pose: the number that is stored. */
const frameBearing = (bearingDeg: number, q: Quaternion): number => sessionFrameBearingDeg(bearingDeg, q)!

const TURNS = [0, 90, 180, 270] as const
const SESSION_BEARINGS = [0, 77, 200, 333]
const HEADINGS = [0, 41, 130, 290, 359.5]
const ROLLS = [0, 10, -10, 45, 90, 100, 180, 270]

/** Camera pitch below the horizon (negative looks up) inside the band where gravity can be read in the screen's plane but the camera is past 60 degrees. */
const BAND_PITCHES = [60.5, 62, 65, 68, 70, 72, 72.4, -60.5, -62, -65, -70, -72.4]
/** Within 60 degrees of level: the camera's own heading is the reading. */
const CAMERA_PITCHES = [-59, -45, -30, 0, 10, 25, 45, 59, 60]
/** Beyond the band: the camera looks nearly straight down or up and gravity is not in the screen's plane to read. */
const FLAT_PITCHES = [72.7, 73, 75, 80, 85, 89.9, -72.7, -80, -89.9]

/** How far the camera axis is from level, as the part of it that is horizontal: 1 is level, 0 is vertical. */
const cameraHorizontal = (axes: Axes): number => horizontalPart(cameraOf(axes))

// ── The oracle's AR pose ─────────────────────────────────────────────────────────────────────

test('oracle: the AR pose maps the camera frame onto the physical axes, in a session whose +Y is up and whose +Z is where it was put', () => {
  for (const bz of SESSION_BEARINGS) {
    const s = sessionAxes(bz)
    assert.ok(Math.abs(dot(s.y, [0, 0, 1])) > 1 - 1e-12, 'session +Y is earth up')
    assert.ok(Math.abs(angDiff(bearingOf(s.z), bz)) < 1e-9, 'session +Z points at its bearing')
    const xz = [s.x[1] * s.y[2] - s.x[2] * s.y[1], s.x[2] * s.y[0] - s.x[0] * s.y[2], s.x[0] * s.y[1] - s.x[1] * s.y[0]]
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(xz[i]! - s.z[i]!) < 1e-12, 'X cross Y is Z: right-handed')
    for (const heading of [0, 123]) {
      for (const [pitch, roll] of [[0, 0], [65, 10], [-70, 90], [30, 270]] as const) {
        const axes = phoneAt(heading, pitch, roll)
        for (const turn of TURNS) {
          const q = arPoseFor(axes, bz, turn)
          // The camera's forward (-Z) is the phone's camera axis, whatever the runtime does about the screen.
          const forward = rotateByQuat(q, { x: 0, y: 0, z: -1 })
          const camera = cameraOf(axes)
          const expected = [dot(camera, s.x), dot(camera, s.y), dot(camera, s.z)]
          assert.ok(Math.abs(forward.x - expected[0]!) < 1e-9 && Math.abs(forward.y - expected[1]!) < 1e-9 && Math.abs(forward.z - expected[2]!) < 1e-9, `forward, turn ${turn}`)
          // The camera's own up (+Y) is the phone's top edge turned by `turn` about the screen's normal.
          const up = rotateByQuat(q, { x: 0, y: 1, z: 0 })
          const t = (turn * Math.PI) / 180
          const edge = [-Math.sin(t) * axes.x[0] + Math.cos(t) * axes.y[0], -Math.sin(t) * axes.x[1] + Math.cos(t) * axes.y[1], -Math.sin(t) * axes.x[2] + Math.cos(t) * axes.y[2]] as V
          const edgeInSession = [dot(edge, s.x), dot(edge, s.y), dot(edge, s.z)]
          assert.ok(Math.abs(up.x - edgeInSession[0]!) < 1e-9 && Math.abs(up.y - edgeInSession[1]!) < 1e-9 && Math.abs(up.z - edgeInSession[2]!) < 1e-9, `up, turn ${turn}`)
          // A direction at session yaw y has the bearing B_Z - y (the relation sessionFrameBearingDeg rests on).
          const yaw = Math.atan2(forward.x, forward.z) * R2D
          assert.ok(Math.abs(angDiff(bearingOf(camera), bz - yaw)) < 1e-9, `bearing = B_Z - yaw, turn ${turn}`)
        }
      }
    }
  }
})

// ── The turn between the two frames is measured ──────────────────────────────────────────────

test('the turn between the browser\'s frame and the pose\'s frame is read off gravity and is what the runtime\'s frame was turned by', () => {
  let measured = 0
  for (const bz of [77, 333]) {
    for (const heading of HEADINGS) {
      for (const pitch of [...CAMERA_PITCHES, ...BAND_PITCHES]) {
        for (const roll of ROLLS) {
          const axes = phoneAt(heading, pitch, roll)
          const horizontal = cameraHorizontal(axes)
          for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
            for (const turn of TURNS) {
              const q = arPoseFor(axes, bz, turn)
              const got = screenTurnDeg(absoluteSample(alpha, beta, gamma).raw, q)
              const at = `heading ${heading}, pitch ${pitch}, roll ${roll}, turn ${turn}`
              if (horizontal > MIN_GRAVITY_IN_SCREEN_PLANE + 1e-6) {
                assert.ok(got !== null, `${at}: not measured with ${horizontal} of gravity in the screen's plane`)
                assert.ok(Math.abs(angDiff(got, turn)) < 1e-8, `${at}: measured ${got}`)
                assert.ok(got >= -180 && got < 180, `${at}: ${got} is outside [-180, 180)`)
                measured++
              } else if (horizontal < MIN_GRAVITY_IN_SCREEN_PLANE - 1e-6) {
                assert.equal(got, null, `${at}: measured from ${horizontal} of gravity in the screen's plane`)
              }
            }
          }
        }
      }
    }
  }
  assert.ok(measured > 3000, `${measured} measured`)
})

test('the turn is not measured without a beta and a gamma, from a pose that is not finite, or from a phone too flat to show gravity', () => {
  const axes = phoneAt(40, 55, 0)
  const q = arPoseFor(axes, 77, 0)
  const raw = absoluteSample(...(eulerAnglesFor(axes)[0]!)).raw
  assert.notEqual(screenTurnDeg(raw, q), null)
  assert.equal(screenTurnDeg(null, q), null)
  assert.equal(screenTurnDeg(undefined, q), null)
  assert.equal(screenTurnDeg({ ...raw, beta: null }, q), null, 'a missing tilt reads as flat for a heading, which is no measurement of gravity')
  assert.equal(screenTurnDeg({ ...raw, gamma: null }, q), null)
  assert.equal(screenTurnDeg({ ...raw, beta: Number.NaN }, q), null)
  assert.equal(screenTurnDeg(raw, { x: Number.NaN, y: 0, z: 0, w: 1 }), null)
  // Flat on a table, the camera at the floor: gravity has nothing in the screen's plane on either side.
  assert.equal(screenTurnDeg({ ...raw, beta: 0, gamma: 0 }, q), null, 'the browser side is flat')
})

test('either side too flat is enough to refuse: the pose says upright and the sensor says flat reads nothing', () => {
  const upright = arPoseFor(phoneAt(40, 0, 0), 77, 0)
  const flat = absoluteSample(0, 0, 0).raw
  assert.equal(screenTurnDeg(flat, upright), null, 'the sensor side has no arrow')
  const flatPose = arPoseFor(phoneAt(40, 89.9, 0), 77, 0)
  const uprightRaw = absoluteSample(...(eulerAnglesFor(phoneAt(40, 0, 0))[0]!)).raw
  assert.equal(screenTurnDeg(uprightRaw, flatPose), null, 'the pose side has no arrow')
})

// ── Within 60 degrees: the camera's own heading, as it stands ────────────────────────────────

test('with the camera within 60 degrees of level the heading is the camera\'s and gives the true bearing of session +Z, whatever the runtime does about the screen', () => {
  let cases = 0
  for (const bz of SESSION_BEARINGS) {
    for (const heading of HEADINGS) {
      for (const pitch of CAMERA_PITCHES) {
        for (const roll of ROLLS) {
          const axes = phoneAt(heading, pitch, roll)
          for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
            const sample = absoluteSample(alpha, beta, gamma)
            for (const turn of TURNS) {
              const q = arPoseFor(axes, bz, turn)
              const paired = pairCompassWithPose(sample, q)
              const at = `session ${bz}, heading ${heading}, pitch ${pitch}, roll ${roll}, turn ${turn}`
              assert.ok(paired !== null, at)
              assert.equal(paired.via, 'camera', at)
              assert.equal(paired.bearingDeg, sample.reading!.headingDeg, `${at}: the camera's heading is handed over as it is`)
              assert.ok(Math.abs(angDiff(frameBearing(paired.bearingDeg, q), bz)) < 1e-6, `${at}: the frame's bearing is ${frameBearing(paired.bearingDeg, q)}`)
              cases++
            }
          }
        }
      }
    }
  }
  assert.equal(cases, SESSION_BEARINGS.length * HEADINGS.length * CAMERA_PITCHES.length * ROLLS.length * 2 * TURNS.length)
})

// ── Past 60 degrees, as far as gravity can be read ───────────────────────────────────────────

test('past 60 degrees the top edge\'s heading is carried to the camera: the frame\'s bearing is the true one, for every way the two frames can be turned', () => {
  let cases = 0
  const turnsSeen = new Set<number>()
  for (const bz of SESSION_BEARINGS) {
    for (const heading of HEADINGS) {
      for (const pitch of BAND_PITCHES) {
        for (const roll of ROLLS) {
          const axes = phoneAt(heading, pitch, roll)
          assert.ok(cameraHorizontal(axes) < MIN_AXIS_HORIZONTAL - 1e-7 && cameraHorizontal(axes) > MIN_GRAVITY_IN_SCREEN_PLANE + 1e-4, 'the grid is in the band')
          for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
            const sample = absoluteSample(alpha, beta, gamma)
            assert.equal(sample.reading!.axis, 'top', 'past 60 degrees the reading is the top edge\'s')
            for (const turn of TURNS) {
              const q = arPoseFor(axes, bz, turn)
              const paired = pairCompassWithPose(sample, q)
              const at = `session ${bz}, heading ${heading}, pitch ${pitch}, roll ${roll}, turn ${turn} (angles ${alpha.toFixed(2)}, ${beta.toFixed(2)}, ${gamma.toFixed(2)})`
              assert.ok(paired !== null, `${at}: nothing handed over`)
              assert.equal(paired.via, 'top', at)
              assert.ok(paired.bearingDeg >= 0 && paired.bearingDeg < 360, `${at}: ${paired.bearingDeg}`)
              assert.ok(Math.abs(angDiff(frameBearing(paired.bearingDeg, q), bz)) < 1e-6, `${at}: the frame's bearing is ${frameBearing(paired.bearingDeg, q)}, the session's +Z points at ${bz}`)
              turnsSeen.add(turn)
              cases++
            }
          }
        }
      }
    }
  }
  assert.equal(cases, SESSION_BEARINGS.length * HEADINGS.length * BAND_PITCHES.length * ROLLS.length * 2 * TURNS.length)
  assert.deepEqual([...turnsSeen].sort((a, b) => a - b), [0, 90, 180, 270])
})

test('what is handed over is not the camera\'s own bearing once the top edge is the reading, and it is the camera\'s bearing in the session\'s terms: the two agree where both are known', () => {
  // The paired bearing is what the camera's compass bearing would have to be for B + yaw to be the session's bearing, so
  // with a perfect compass it is the camera's true bearing: the heading the phone was turned to.
  for (const bz of [77, 200]) {
    for (const [heading, pitch, roll, turn] of [[40, 65, 10, 0], [40, 62, 90, 90], [200, 70, 270, 270], [310, 68, 0, 180]] as const) {
      const axes = phoneAt(heading, pitch, roll)
      const q = arPoseFor(axes, bz, turn)
      const sample = absoluteSample(...(eulerAnglesFor(axes)[0]!))
      assert.equal(sample.reading!.axis, 'top')
      const paired = pairCompassWithPose(sample, q)!
      assert.ok(Math.abs(angDiff(paired.bearingDeg, heading)) < 1e-6, `the camera faces ${heading}: ${paired.bearingDeg}`)
      // And the top edge's own heading, which is what the reading holds, is not that number (except where the phone is not rolled).
      if (roll !== 0) assert.ok(Math.abs(angDiff(sample.reading!.headingDeg, heading)) > 1, `the top edge points ${sample.reading!.headingDeg}, the camera ${heading}`)
    }
  }
})

test('the 60 degree line is not a step: a camera pitched 59.9 and 60.1 degrees down gives the same frame bearing, in portrait with a lean and in landscape', () => {
  // The earlier pairing paired the top edge's heading with the camera's forward yaw, so crossing the line changed the
  // bearing by the phone's lean (10 degrees here) or roll (90 in landscape), and a hand that trembles across it changed it back.
  for (const bz of [77, 200]) {
    for (const [roll, turn] of [[10, 0], [-10, 0], [90, 0], [90, 90], [270, 270], [100, 90]] as const) {
      const frames: number[] = []
      const axesUsed: string[] = []
      for (const pitch of [59.7, 59.9, 60, 60.1, 60.3]) {
        const axes = phoneAt(40, pitch, roll)
        const q = arPoseFor(axes, bz, turn)
        const sample = absoluteSample(...(eulerAnglesFor(axes)[0]!))
        const paired = pairCompassWithPose(sample, q)
        assert.ok(paired !== null, `pitch ${pitch}, roll ${roll}`)
        axesUsed.push(sample.reading!.axis)
        frames.push(frameBearing(paired.bearingDeg, q))
      }
      assert.ok(axesUsed.includes('camera') && axesUsed.includes('top'), `the pitches straddle the line: ${axesUsed.join(' ')}`)
      for (const frame of frames) assert.ok(Math.abs(angDiff(frame, bz)) < 1e-6, `roll ${roll}, turn ${turn}: ${frames.join(', ')} against ${bz}`)
    }
  }
})

test('the postures the investigation found wrong: a camera 61, 65 and 70 degrees down with a 10 degree lean, and landscape at 65, are exact, and 80 degrees down is withheld, not 45 degrees out', () => {
  const TRUE_BZ = 77
  // [label, heading, pitch down, roll, expected]: the camera faces 40 in every row.
  const rows: Array<[string, number, number, number, 'exact' | 'withheld']> = [
    ['portrait, 10 degree lean, camera 61 down', 40, 61, 10, 'exact'],
    ['portrait, 10 degree lean, camera 65 down', 40, 65, 10, 'exact'],
    ['portrait, 10 degree lean, camera 70 down', 40, 70, 10, 'exact'],
    ['landscape (tablet), camera 65 down', 40, 65, 90, 'exact'],
    ['landscape (tablet), camera 70 down', 40, 70, 270, 'exact'],
    ['portrait, 10 degree lean, camera 80 down', 40, 80, 10, 'withheld'],
    ['landscape (tablet), camera 80 down', 40, 80, 90, 'withheld'],
  ]
  for (const [label, heading, pitch, roll, expected] of rows) {
    for (const turn of TURNS) {
      const axes = phoneAt(heading, pitch, roll)
      const q = arPoseFor(axes, TRUE_BZ, turn)
      const sample = absoluteSample(...(eulerAnglesFor(axes)[0]!))
      const paired = pairCompassWithPose(sample, q)
      if (expected === 'exact') {
        assert.ok(paired !== null, `${label}, turn ${turn}`)
        assert.ok(Math.abs(angDiff(frameBearing(paired.bearingDeg, q), TRUE_BZ)) < 1e-6, `${label}, turn ${turn}: ${frameBearing(paired.bearingDeg, q)}`)
      } else {
        assert.equal(paired, null, `${label}, turn ${turn}`)
      }
      // The pairing the code used before: the heading as it stands, with the camera's forward yaw. It is what the rows were found wrong by.
      if (expected === 'exact' && roll !== 0) {
        const before = sessionFrameBearingDeg(sample.reading!.headingDeg, q)!
        assert.ok(Math.abs(angDiff(before, TRUE_BZ)) > 5, `${label}: the heading paired with the forward yaw was ${angDiff(before, TRUE_BZ)} out`)
      }
    }
  }
})

test('the figures of the investigation (beta 25 gamma 10, beta 10 gamma 10): the first is exact now, the second is withheld rather than 45 degrees out', () => {
  const TRUE_BZ = 200
  for (const alpha of [0, 120, 275]) {
    for (const turn of TURNS) {
      const axes = axesFromEuler(alpha, 25, 10)
      const q = arPoseFor(axes, TRUE_BZ, turn)
      const paired = pairCompassWithPose(absoluteSample(alpha, 25, 10), q)
      assert.ok(paired !== null && paired.via === 'top', `alpha ${alpha}, turn ${turn}`)
      assert.ok(Math.abs(angDiff(frameBearing(paired.bearingDeg, q), TRUE_BZ)) < 1e-6)

      const steep = axesFromEuler(alpha, 10, 10)
      assert.ok(cameraHorizontal(steep) < MIN_GRAVITY_IN_SCREEN_PLANE, 'the camera is 80 degrees down')
      assert.equal(pairCompassWithPose(absoluteSample(alpha, 10, 10), arPoseFor(steep, TRUE_BZ, turn)), null)
    }
  }
})

// ── Beyond: never a bearing that may be a quarter turn out ───────────────────────────────────

test('past 72.5 degrees the camera looks nearly at the floor or the ceiling and no bearing is handed over, in any posture', () => {
  let cases = 0
  for (const bz of [77, 333]) {
    for (const heading of HEADINGS) {
      for (const pitch of FLAT_PITCHES) {
        for (const roll of ROLLS) {
          const axes = phoneAt(heading, pitch, roll)
          for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
            for (const turn of TURNS) {
              const paired = pairCompassWithPose(absoluteSample(alpha, beta, gamma), arPoseFor(axes, bz, turn))
              assert.equal(paired, null, `pitch ${pitch}, roll ${roll}, turn ${turn}`)
              cases++
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 1000)
})

test('over a dense grid of raw angles, a bearing that is handed over is always the true one, and every posture within 72.5 degrees of level has one', () => {
  let handed = 0
  let withheld = 0
  let viaTop = 0
  let inBand = 0
  for (let alpha = 0; alpha < 360; alpha += 47) {
    for (let beta = -180; beta < 180; beta += 9) {
      for (let gamma = -90; gamma <= 90; gamma += 10) {
        const axes = axesFromEuler(alpha, beta, gamma)
        const horizontal = cameraHorizontal(axes)
        const sample = absoluteSample(alpha, beta, gamma)
        for (const bz of [77, 250]) {
          for (const turn of TURNS) {
            const q = arPoseFor(axes, bz, turn)
            const paired = pairCompassWithPose(sample, q)
            if (paired !== null) {
              handed++
              if (paired.via === 'top') viaTop++
              assert.ok(Math.abs(angDiff(frameBearing(paired.bearingDeg, q), bz)) < 1e-6, `${alpha}, ${beta}, ${gamma}, turn ${turn}: ${paired.via} gave ${frameBearing(paired.bearingDeg, q)} for ${bz}`)
            } else {
              withheld++
              assert.ok(horizontal < MIN_GRAVITY_IN_SCREEN_PLANE + 1e-6, `${alpha}, ${beta}, ${gamma}, turn ${turn}: withheld with ${horizontal} of the camera horizontal`)
            }
            if (horizontal > MIN_GRAVITY_IN_SCREEN_PLANE + 1e-6) inBand++
          }
        }
      }
    }
  }
  assert.ok(viaTop > 100, `${viaTop} via the top edge`)
  assert.ok(withheld > 100, `${withheld} withheld`)
  assert.equal(handed, inBand, 'a bearing is handed over exactly while the camera is within 72.5 degrees of level')
})

// ── Sensor error is not a reason to refuse; two sources that disagree are ────────────────────

/** The pose tilted by `degrees` about the session's +X axis, after the fact: an error in the pose's tilt. */
const tiltedBy = (q: Quaternion, degrees: number): Quaternion => mulQuat(pitchQuat(degrees), q)

test('ordinary tilt error on either side does not cost the bearing, and moves it by about the error', () => {
  const TRUE_BZ = 77
  for (const [heading, pitch, roll, turn] of [[40, 64, 10, 0], [40, 66, 90, 90], [200, 68, 270, 270], [310, 63, 0, 180], [100, -66, 10, 0]] as const) {
    const axes = phoneAt(heading, pitch, roll)
    const [alpha, beta, gamma] = eulerAnglesFor(axes)[0]!
    const q = arPoseFor(axes, TRUE_BZ, turn)
    for (const [dBeta, dGamma, dPose] of [[2, -1.5, 0.5], [-3, 2, -1], [3, 3, 1], [0, 0, 2]] as const) {
      const paired = pairCompassWithPose(absoluteSample(alpha, beta + dBeta, gamma + dGamma), tiltedBy(q, dPose))
      const at = `heading ${heading}, pitch ${pitch}, roll ${roll}, turn ${turn}, errors ${dBeta}, ${dGamma}, ${dPose}`
      assert.ok(paired !== null, `${at}: refused for ordinary error`)
      // The error in the bearing is about the tilt error: the top edge is well conditioned (at least 0.866 of it is horizontal).
      const error = Math.abs(angDiff(frameBearing(paired.bearingDeg, tiltedBy(q, dPose)), TRUE_BZ))
      assert.ok(error < 8, `${at}: ${error} degrees out`)
    }
  }
})

test('two sources that do not describe one attitude are refused: a frame turned 45 degrees, a pose that has pitched on, a phone that was lifted', () => {
  const TRUE_BZ = 77
  const axes = phoneAt(40, 66, 10)
  const [alpha, beta, gamma] = eulerAnglesFor(axes)[0]!
  const sample = absoluteSample(alpha, beta, gamma)
  // The runtime's frame turned by 45 degrees: not one of the four ways up a screen has.
  for (const turn of [45, 135, -45, 225]) {
    assert.equal(pairCompassWithPose(sample, arPoseFor(axes, TRUE_BZ, turn)), null, `turn ${turn}`)
  }
  // A turn just past the tolerance is refused and just inside it is accepted: the line is where the constant says.
  assert.ok(pairCompassWithPose(sample, arPoseFor(axes, TRUE_BZ, MAX_SCREEN_TURN_RESIDUAL_DEG - 1)) !== null)
  assert.equal(pairCompassWithPose(sample, arPoseFor(axes, TRUE_BZ, MAX_SCREEN_TURN_RESIDUAL_DEG + 1)), null)
  assert.ok(pairCompassWithPose(sample, arPoseFor(axes, TRUE_BZ, 90 - (MAX_SCREEN_TURN_RESIDUAL_DEG - 1))) !== null)
  assert.equal(pairCompassWithPose(sample, arPoseFor(axes, TRUE_BZ, 90 - (MAX_SCREEN_TURN_RESIDUAL_DEG + 1))), null)
  // A pose that has pitched on 25 degrees since the compass event: the arrow of gravity in the screen's plane is nearly gone.
  const pitched = arPoseFor(phoneAt(40, 66 + 25, 10), TRUE_BZ, 0)
  assert.equal(pairCompassWithPose(sample, pitched), null)
})

test('two sources that agree about the direction of gravity in the screen\'s plane and not about how far the phone is tipped are refused, at the line the constant sets', () => {
  // Raised to the horizon since the event (a stale sample), or the other way: same lean, so the arrow points the same way
  // in the screen's plane and a check of the turn alone is satisfied, but it is 46 degrees longer on one side.
  const TRUE_BZ = 77
  const sample = absoluteSample(...(eulerAnglesFor(phoneAt(40, 66, 10))[0]!))
  assert.equal(sample.reading!.axis, 'top')
  const gapOf = (pitchOfPose: number) => pairCompassWithPose(sample, arPoseFor(phoneAt(40, pitchOfPose, 10), TRUE_BZ, 0))
  assert.equal(gapOf(20), null, 'the pose side is 46 degrees from the sample')
  assert.equal(gapOf(66 - (MAX_GRAVITY_DISAGREEMENT_DEG + 1)), null, 'just past the line')
  assert.ok(gapOf(66 - (MAX_GRAVITY_DISAGREEMENT_DEG - 1)) !== null, 'just inside it')
  assert.ok(gapOf(66 + 4) !== null, 'a few degrees of error either way is not a disagreement')
  assert.ok(gapOf(66) !== null)
})

// ── What is not the top edge ─────────────────────────────────────────────────────────────────

test('an iPhone\'s heading is handed over as it is and says so: its axis is not known, and it is paired as it always was', () => {
  const read = (e: object) => compassReadingFromEvent(e as unknown as DeviceOrientationEvent) as CompassReading
  for (const [heading, beta, gamma] of [[123.4, 61.5, -4.1], [10, 10, 80], [359, 0, 0]] as const) {
    const event = { webkitCompassHeading: heading, webkitCompassAccuracy: 15, alpha: 301, beta, gamma }
    const sample: CompassSample = { raw: rawOrientationOf(event as unknown as DeviceOrientationEvent), reading: read(event) }
    for (const q of [arPoseFor(phoneAt(40, 65, 10), 77, 0), arPoseFor(phoneAt(40, 85, 0), 77, 90), { x: 0, y: 0, z: 0, w: 1 }]) {
      assert.deepEqual(pairCompassWithPose(sample, q), { bearingDeg: heading, via: 'platform' })
    }
  }
})

test('no sample, a refused sample, and a reading that is not usable hand over nothing', () => {
  const q = arPoseFor(phoneAt(40, 30, 0), 77, 0)
  assert.equal(pairCompassWithPose(null, q), null)
  assert.equal(pairCompassWithPose(undefined, q), null)
  const refused: CompassSample = { raw: { alpha: 10, beta: 20, gamma: 30, absolute: true, webkitCompassHeading: 50, webkitCompassAccuracy: -1 }, reading: null }
  assert.equal(pairCompassWithPose(refused, q), null)
})

test('a top-edge reading with no beta or gamma, or with a pose that is not finite, hands over nothing', () => {
  const q = arPoseFor(phoneAt(40, 66, 0), 77, 0)
  // An event with only an alpha is read as a flat phone (the top edge) and gravity is not in it.
  const flatOnly = absoluteSample(30, Number.NaN, 0)
  assert.equal(flatOnly.reading, null)
  const noTilt: CompassSample = { raw: { alpha: 30, beta: null, gamma: null, absolute: true, webkitCompassHeading: null, webkitCompassAccuracy: null }, reading: compassReadingFromEvent({ absolute: true, alpha: 30 } as unknown as DeviceOrientationEvent) as CompassReading | null }
  assert.equal(noTilt.reading!.axis, 'top')
  assert.equal(pairCompassWithPose(noTilt, q), null)
  const axes = phoneAt(40, 66, 0)
  const sample = absoluteSample(...(eulerAnglesFor(axes)[0]!))
  assert.equal(pairCompassWithPose(sample, { x: Number.NaN, y: 0, z: 0, w: 1 }), null)
  assert.equal(pairCompassWithPose(sample, { x: 0, y: Number.POSITIVE_INFINITY, z: 0, w: 1 }), null)
})

// ── The earlier rule ─────────────────────────────────────────────────────────────────────────

test('?compass=alpha selects the earlier rule and nothing else does', () => {
  assert.equal(compassRuleFromSearch('?compass=alpha'), 'alpha')
  assert.equal(compassRuleFromSearch('?debug=pose&compass=alpha&bearing=1'), 'alpha')
  for (const search of ['', '?compass=attitude', '?compass=', '?compass=Alpha', '?compass=top', '?debug=compass', '?world=default']) {
    assert.equal(compassRuleFromSearch(search), 'attitude', JSON.stringify(search))
  }
})

test('under the earlier rule an Android heading is 360 - alpha whatever the tilt, claims no axis, and is paired as it always was', () => {
  const read = (e: object, rule?: 'attitude' | 'alpha') => compassReadingFromEvent(e as unknown as DeviceOrientationEvent, rule)
  /** The earlier code, as it was: `(360 - alpha) % 360` for an absolute event with a finite alpha. */
  const earlier = (alpha: number): number => normaliseBearingDeg(360 - alpha)
  let compared = 0
  for (const alpha of [0, 0.5, 33, 90, 180, 270, 359.9]) {
    for (const beta of [-180, -90, -30, 0, 30, 90, 150, 180]) {
      for (const gamma of [-90, -30, 0, 30, 90]) {
        const reading = read({ absolute: true, alpha, beta, gamma }, 'alpha') as CompassReading
        assert.equal(reading.headingDeg, earlier(alpha), `${alpha}, ${beta}, ${gamma}`)
        assert.deepEqual([reading.axis, reading.northReference, reading.source, reading.accuracyDeg, reading.sigmaDeg], ['unknown', 'magnetic', 'android-absolute', null, null])
        // The default rule differs from it where the camera is not on the top edge's side: the switch changes something.
        const sample: CompassSample = { raw: rawOrientationOf({ absolute: true, alpha, beta, gamma } as unknown as DeviceOrientationEvent), reading }
        assert.deepEqual(pairCompassWithPose(sample, arPoseFor(phoneAt(40, 65, 10), 77, 0)), { bearingDeg: reading.headingDeg, via: 'platform' })
        compared++
      }
    }
  }
  assert.equal(compared, 7 * 8 * 5)
  // A heading that cannot be read is refused under either rule, and an event with no alpha says nothing under either.
  assert.equal(read({ absolute: true, alpha: Number.NaN }, 'alpha'), null)
  assert.equal(read({ absolute: true, alpha: Number.POSITIVE_INFINITY, beta: 10, gamma: 10 }, 'alpha'), null)
  assert.equal(read({ absolute: false, alpha: 10 }, 'alpha'), undefined)
  assert.equal(read({ absolute: true, alpha: null }, 'alpha'), undefined)
  // Beta and gamma that are not numbers are ignored by it, because it never reads them: the attitude rule discards the sample.
  assert.equal((read({ absolute: true, alpha: 90, beta: Number.NaN, gamma: 0 }, 'alpha') as CompassReading).headingDeg, 270)
  assert.equal(read({ absolute: true, alpha: 90, beta: Number.NaN, gamma: 0 }), null)
  // iOS is unaffected by the rule.
  const ios = { webkitCompassHeading: 123.4, webkitCompassAccuracy: 12 }
  assert.deepEqual(read(ios, 'alpha'), read(ios, 'attitude'))
})

test('the default rule gives a different number from the earlier one exactly where the camera is not on the top edge\'s side', () => {
  const read = (e: object, rule: 'attitude' | 'alpha') => (compassReadingFromEvent(e as unknown as DeviceOrientationEvent, rule) as CompassReading).headingDeg
  // Rolled into landscape: a quarter turn apart. Unrolled and upright: the same.
  assert.equal(Math.abs(angDiff(read({ absolute: true, alpha: 0, beta: 0, gamma: -90 }, 'attitude'), read({ absolute: true, alpha: 0, beta: 0, gamma: -90 }, 'alpha'))), 90)
  assert.ok(Math.abs(angDiff(read({ absolute: true, alpha: 100, beta: 90, gamma: 0 }, 'attitude'), read({ absolute: true, alpha: 100, beta: 90, gamma: 0 }, 'alpha'))) < 1e-9)
})

// ── Both axes, for the device test ───────────────────────────────────────────────────────────

test('both axes of the phone each have their own bearing and horizontal part, whichever the rule would use', () => {
  let compared = 0
  for (const heading of HEADINGS) {
    for (const pitch of [-85, -60, -30, 0, 25, 59, 60, 61, 70, 80, 89.9]) {
      for (const roll of ROLLS) {
        const axes = phoneAt(heading, pitch, roll)
        for (const [alpha, beta, gamma] of eulerAnglesFor(axes)) {
          const got = axisHeadingsFromAttitude(alpha, beta, gamma)!
          const at = `heading ${heading}, pitch ${pitch}, roll ${roll}`
          assert.ok(got !== null, at)
          assert.ok(Math.abs(got.camera.horizontal - horizontalPart(cameraOf(axes))) < 1e-9, `${at}: camera horizontal`)
          assert.ok(Math.abs(got.top.horizontal - horizontalPart(axes.y)) < 1e-9, `${at}: top horizontal`)
          if (got.camera.headingDeg !== null) assert.ok(Math.abs(angDiff(got.camera.headingDeg, bearingOf(cameraOf(axes)))) < 1e-8, `${at}: camera ${got.camera.headingDeg}`)
          else assert.ok(got.camera.horizontal < 1e-8, `${at}: no camera bearing with ${got.camera.horizontal} horizontal`)
          if (got.top.headingDeg !== null) assert.ok(Math.abs(angDiff(got.top.headingDeg, bearingOf(axes.y))) < 1e-8, `${at}: top ${got.top.headingDeg}`)
          // Where the rule picks an axis, its heading is that axis's.
          const chosen = headingFromAttitude(alpha, beta, gamma)!
          const own = chosen.axis === 'camera' ? got.camera.headingDeg : got.top.headingDeg
          assert.ok(own !== null && Math.abs(angDiff(chosen.headingDeg, own)) < 1e-8, `${at}: the rule's ${chosen.axis} heading`)
          compared++
        }
      }
    }
  }
  assert.equal(compared, HEADINGS.length * 11 * ROLLS.length * 2)
})

test('the device test\'s camera candidate is the camera, where the rule would have fallen back to the top edge: landscape, 70 and 80 degrees down', () => {
  // The case that made the first recipe unable to tell the candidates apart: alpha 100, beta 0, gamma 20 is a phone on its
  // side with the camera 70 degrees below level. headingFromAttitude gives the top edge's 260; the camera faces 170.
  for (const [gamma, camera] of [[50, 170], [20, 170], [10, 170]] as const) {
    const rule = headingFromAttitude(100, 0, gamma)!
    const both = axisHeadingsFromAttitude(100, 0, gamma)!
    assert.ok(Math.abs(angDiff(both.camera.headingDeg!, camera)) < 1e-9, `gamma ${gamma}: camera ${both.camera.headingDeg}`)
    assert.ok(Math.abs(angDiff(both.top.headingDeg!, 260)) < 1e-9, `gamma ${gamma}: top ${both.top.headingDeg}`)
    if (gamma < 30) assert.deepEqual([rule.axis, rule.headingDeg], ['top', 260], 'the rule itself has fallen back, which is why the helper exists')
  }
})

test('an axis that is vertical has no bearing, and angles that are not numbers give none at all', () => {
  const flat = axisHeadingsFromAttitude(40, 0, 0)!
  assert.equal(flat.camera.headingDeg, null, 'the camera looks at the floor')
  assert.equal(flat.camera.horizontal, 0)
  assert.equal(flat.top.headingDeg, 320)
  const upright = axisHeadingsFromAttitude(40, 90, 0)!
  assert.equal(upright.top.headingDeg, null, 'upright, the top edge points at the sky')
  assert.ok(Math.abs(angDiff(upright.camera.headingDeg!, 320)) < 1e-9)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(axisHeadingsFromAttitude(bad, 0, 0), null)
    assert.equal(axisHeadingsFromAttitude(0, bad, 0), null)
    assert.equal(axisHeadingsFromAttitude(0, 0, bad), null)
  }
})
