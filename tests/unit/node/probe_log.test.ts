/**
 * The `?debug=probe` line: what a tap after calibration logs, and what it must never log.
 *
 * src/capture/probe-log.ts exists so that the numbers every calibration constant should come from are
 * collected on a phone: one `[probe]` JSON line per tap, over the `?debug=remote` relay. These tests hold
 * the parts a device run cannot recheck afterwards:
 *
 *  - the schema: every key, in order, always present, and nothing that identifies a person or a place;
 *  - the arithmetic: the Place-frame coordinates, the camera pitch and yaw, and the compass sum and
 *    difference. DX3 (docs/testing/DEVICE_TESTING.md, Procedure 4) asks a person to read `Bplus` and
 *    `Bminus` while turning on the spot; the test below turns a simulated camera and shows what each does,
 *    so the person is reading the right columns for the right reason. That is arithmetic, not a claim
 *    about any device: whether a real compass and a real session agree is what the device run is for;
 *  - the length: the relay cuts a message at its MAX_MSG_CHARS, which would leave invalid JSON, so the
 *    longest line the line's bounds allow, and a line built from absurd runtime numbers, are measured
 *    against that cap, read from the relay's own source, and the cap itself is held at or below what the
 *    server keeps of a message;
 *  - what is not available: `null`, never a zero that reads as a measurement (a runtime with no frame-shift
 *    counter logs `jumps: null`);
 *  - the wiring: inert unless `probe` is in `?debug=`, one line per tap, no line for a second tap while the
 *    first is being measured, and a scale-mode accessor that works whether or not a provider has one.
 *
 * `src/main.ts` is one DOM module and cannot be imported under node, so its call is read as source (the
 * way alignment_status.test.ts reads it). Those tests are named "source shape:" and claim no behaviour.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/probe_log.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HIT_TEST_GUARD_MS,
  MAX_ABS_VALUE,
  MAX_COUNT,
  PROBE_KEYS,
  PROBE_LINE_PREFIX,
  buildProbeRecord,
  cameraPitchDeg,
  formatProbeLine,
  installProbeLog,
  scaleModeOf,
  type ProbeCanvas,
  type ProbeLogDeps,
  type ProbeProvider,
  type ProbeReading,
  type ProbeRecord,
  type ProbeSample,
  type ProbeTapAnswer,
} from '../../../src/capture/probe-log.ts'
import { GeoTracker } from '../../../src/geo/geo-tracker.ts'
import type { CompassSample } from '../../../src/geo/compass-heading.ts'
import { twoPointSeparationM, twoPointToProjectTransform, anchorToProjectTransform } from '../../../src/world/geo.ts'
import type { ScanCalibration } from '../../../src/world/types.ts'
import type { HitResult, Pose } from '../../../src/ar/provider.ts'
import { arPoseFor, eulerAnglesFor, phoneAt } from './compass_oracle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

/** The pair tests/unit/deno/anchor_calibration.test.ts uses, in the first session's own frame. */
const LANDMARK = { x: 1.5, y: -1.2, z: -0.4 }
const HEADING_MARKER = { x: 3.1, y: -1.2, z: 1.9 }
const SEPARATION_M = twoPointSeparationM(LANDMARK, HEADING_MARKER)

const TWO_POINT: Extract<ScanCalibration, { method: 'two-point-ground' }> = {
  method: 'two-point-ground',
  sessionToProject: twoPointToProjectTransform(LANDMARK, HEADING_MARKER),
  separationM: SEPARATION_M,
  residualM: 0.022,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'verified',
}

const ONE_POINT: Extract<ScanCalibration, { method: 'ground-tap-compass' }> = {
  method: 'ground-tap-compass',
  sessionToProject: anchorToProjectTransform({ x: -2.2, y: -0.9, z: 1.6 }, 40),
  anchorBearingDeg: 40,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'provisional',
}

/** The last compass event of an Android phone held at 52 degrees of pitch, unrolled: the raw angles and the reading taken from them. */
const ANDROID_SAMPLE: CompassSample = {
  raw: { alpha: 148.64, beta: 37.56, gamma: 0.04, absolute: true, webkitCompassHeading: null, webkitCompassAccuracy: null },
  reading: { headingDeg: 211.36, northReference: 'magnetic', axis: 'camera', source: 'android-absolute', accuracyDeg: null, sigmaDeg: null },
}

/**
 * An iPhone's: its own heading and accuracy, and a relative alpha beside them. Its event has no `absolute`
 * property at all (Safari on iOS does not implement it), so the raw flag is null, not false.
 */
const IOS_SAMPLE: CompassSample = {
  raw: { alpha: 301.23, beta: 61.5, gamma: -4.11, absolute: null, webkitCompassHeading: 123.44, webkitCompassAccuracy: 15 },
  reading: { headingDeg: 123.44, northReference: 'magnetic', axis: 'unknown', source: 'ios-compass', accuracyDeg: 15, sigmaDeg: 25 },
}

type Quat = Pose['rotation']

/** Rotation about +Y by `deg`: a camera looking down its own -Z then faces (-sin, 0, -cos). */
function aboutY(deg: number): Quat {
  const half = (deg * Math.PI) / 360
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
}

/** Rotation about +X by `deg`: positive tilts a camera looking down -Z up, negative tilts it down. */
function aboutX(deg: number): Quat {
  const half = (deg * Math.PI) / 360
  return { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) }
}

/** Hamilton product a * b: b is applied first. */
function mul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

/** The camera's forward direction for a rotation, from the rotation matrix: -Z through the quaternion. */
function forwardOf(q: Quat): { x: number; y: number; z: number } {
  const { x, y, z, w } = q
  return {
    x: -(2 * (x * z + w * y)),
    y: -(2 * (y * z - w * x)),
    z: -(1 - 2 * (x * x + y * y)),
  }
}

const poseAt = (position: { x: number; y: number; z: number }, rotation: Quat): Pose => ({ position, rotation })

/** A reading with a calibration, a hit, and a camera 30 degrees off the +Z axis looking 20 degrees down. */
function reading(overrides: Partial<ProbeReading> = {}): ProbeReading {
  return {
    n: 3,
    runtime: '8thwall',
    scaleMode: null,
    calibration: TWO_POINT,
    hit: { position: HEADING_MARKER, distance: 3.456 },
    pose: poseAt({ x: 1, y: 0.2, z: 2 }, mul(aboutY(30), aboutX(-20))),
    tap: { x: 0.5123, y: 0.7312 },
    trackingStatus: 'NORMAL',
    trackingReason: 'UNSPECIFIED',
    poseJumps: 2,
    bearing: 100,
    screenAngle: 0,
    firstPose: { position: { x: 0, y: 1.25, z: 0 } },
    compassSample: ANDROID_SAMPLE,
    ...overrides,
  }
}

const parse = (line: string): Record<string, unknown> => JSON.parse(line.slice(PROBE_LINE_PREFIX.length))

// ── The schema ───────────────────────────────────────────────────────────────────────────────

test('a line is the prefix and then JSON, with every key of PROBE_KEYS in that order', () => {
  const line = formatProbeLine(buildProbeRecord(reading()))
  assert.ok(line.startsWith('[probe] '), 'the prefix a log can be filtered on')
  assert.deepEqual(Object.keys(parse(line)), [...PROBE_KEYS])
  assert.equal(parse(line)['v'], 1, 'the format version')
})

test('every key is present on every line, a miss and a tap with no calibration included', () => {
  for (const r of [reading(), reading({ hit: null }), reading({ calibration: null }), reading({ bearing: null, trackingReason: null })]) {
    assert.deepEqual(Object.keys(parse(formatProbeLine(buildProbeRecord(r)))), [...PROBE_KEYS])
  }
})

test('a line carries only numbers, null and short words: nothing that identifies a person or a place', () => {
  const FORBIDDEN = /lat|lng|lon|gps|geo|address|accuracy|photo|image|blob|url|name|email|user|token|session|scan|project|place|device|ua$|ip$/i
  const record = parse(formatProbeLine(buildProbeRecord(reading({ scaleMode: 'responsive', compassSample: IOS_SAMPLE }))))
  for (const key of Object.keys(record)) assert.doesNotMatch(key, FORBIDDEN, `key ${key} reads as identifying`)
  for (const [key, value] of Object.entries(record)) {
    const ok = value === null || typeof value === 'number' || (typeof value === 'string' && value.length <= 24)
    assert.ok(ok, `${key} is ${JSON.stringify(value)}: not a number, null or a short word`)
  }
})

test('the strings in a line are enum words from the code, not text that came from a person', () => {
  const record = parse(formatProbeLine(buildProbeRecord(reading({ scaleMode: 'absolute' }))))
  assert.equal(record['rt'], '8thwall')
  assert.equal(record['scale'], 'absolute')
  assert.equal(record['method'], 'two-point-ground')
  assert.equal(record['status'], 'verified')
  assert.equal(record['trk'], 'NORMAL')
  assert.equal(record['why'], 'UNSPECIFIED')
})

test('the Place-frame coordinates are the hit seen through sessionToProject', () => {
  // The heading marker as tapped is on project +Z at the separation; the landmark is the origin.
  const atMarker = buildProbeRecord(reading({ hit: { position: HEADING_MARKER, distance: 3 } }))
  assert.ok(Math.abs(atMarker.px! - 0) < 1e-3, `px ${atMarker.px}`)
  assert.ok(Math.abs(atMarker.py! - 0) < 1e-3, `py ${atMarker.py}`)
  assert.ok(Math.abs(atMarker.pz! - SEPARATION_M) < 1e-3, `pz ${atMarker.pz} vs ${SEPARATION_M}`)
  const atLandmark = buildProbeRecord(reading({ hit: { position: LANDMARK, distance: 2 } }))
  assert.deepEqual([atLandmark.px, atLandmark.py, atLandmark.pz], [0, 0, 0], 'the landmark is the origin')
  // A point 1 m to the side of the baseline, on the floor: it sits 1 m along project X (or -X), 0 along Z.
  const baseline = { x: HEADING_MARKER.x - LANDMARK.x, z: HEADING_MARKER.z - LANDMARK.z }
  const unit = { x: baseline.x / SEPARATION_M, z: baseline.z / SEPARATION_M }
  const beside = buildProbeRecord(reading({
    hit: { position: { x: LANDMARK.x + unit.z, y: LANDMARK.y, z: LANDMARK.z - unit.x }, distance: 2 },
  }))
  assert.ok(Math.abs(Math.abs(beside.px!) - 1) < 1e-3 && Math.abs(beside.pz!) < 1e-3, `beside the baseline: ${beside.px}, ${beside.pz}`)
})

test('the session-frame hit, the range and the calibration numbers are logged as measured, rounded to a millimetre', () => {
  const r = buildProbeRecord(reading({ hit: { position: { x: 0.41249, y: -1.30051, z: 1.77451 }, distance: 2.31049 } }))
  assert.deepEqual([r.hx, r.hy, r.hz, r.rng], [0.412, -1.301, 1.775, 2.31])
  assert.deepEqual([r.method, r.status, r.sepM, r.resM], ['two-point-ground', 'verified', 2.802, 0.022])
  assert.deepEqual([r.tx, r.ty], [0.512, 0.731])
  assert.equal(r.camY, 0.2)
  assert.equal(r.y0, 1.25)
  assert.equal(r.hit, 1)
  assert.equal(r.n, 3)
  assert.equal(r.jumps, 2)
  assert.equal(r.scr, 0)
})

test('a tap with no calibration still logs, with the Place-frame and calibration fields null', () => {
  const r = buildProbeRecord(reading({ calibration: undefined }))
  assert.deepEqual([r.method, r.status, r.sepM, r.resM, r.px, r.py, r.pz], [null, null, null, null, null, null, null])
  assert.notEqual(r.hx, null, 'the session-frame hit is still there')
  assert.equal(r.hit, 1)
})

test('the one-point tier has no separation or residual, and still gets Place-frame coordinates', () => {
  const r = buildProbeRecord(reading({ calibration: ONE_POINT }))
  assert.deepEqual([r.method, r.status, r.sepM, r.resM], ['ground-tap-compass', 'provisional', null, null])
  assert.notEqual(r.px, null)
})

test('a hit test that found nothing logs hit 0 with no coordinates, and keeps what the camera and tracking read', () => {
  const r = buildProbeRecord(reading({ hit: null }))
  assert.equal(r.hit, 0)
  assert.deepEqual([r.px, r.py, r.pz, r.hx, r.hy, r.hz, r.rng], [null, null, null, null, null, null, null])
  assert.notEqual(r.pitch, null)
  assert.notEqual(r.yaw, null)
  assert.equal(r.trk, 'NORMAL')
  assert.equal(r.camY, 0.2)
})

test('a non-finite number is null in the line, never NaN, Infinity or a made-up zero', () => {
  const r = buildProbeRecord(reading({
    hit: { position: { x: NaN, y: 0, z: 0 }, distance: 1 },
    bearing: Infinity,
    pose: poseAt({ x: 0, y: NaN, z: 0 }, aboutY(10)),
    firstPose: { position: { x: 0, y: Infinity, z: 0 } },
    screenAngle: NaN,
  }))
  assert.equal(r.hit, 0, 'a hit with a non-finite coordinate is not a hit')
  assert.equal(r.rng, null, 'and the range the runtime gave for it, which was finite, is not logged for a tap that found nothing')
  assert.deepEqual([r.camY, r.B, r.Bplus, r.Bminus, r.y0, r.scr], [null, null, null, null, null, null])
  assert.equal(formatProbeLine(r).includes('NaN'), false)
  assert.equal(formatProbeLine(r).includes('Infinity'), false)
})

test('a sessionToProject that is not 16 finite numbers leaves the Place-frame fields null', () => {
  for (const bad of [[], [1, 0, 0], new Array(16).fill(NaN), 'matrix' as unknown as number[]]) {
    const r = buildProbeRecord(reading({ calibration: { ...TWO_POINT, sessionToProject: bad } }))
    assert.deepEqual([r.px, r.py, r.pz], [null, null, null])
    assert.equal(r.hit, 1)
  }
})

// ── What the sampler found out about a tap ───────────────────────────────────────────────────

/** A tap the sampler accepted: the median of twelve hits that scattered 1.1 cm, 43 mm from the floor ray. */
const BURST_SAMPLE: ProbeSample = { kept: 12, spreadM: 0.0114, source: 'burst', floorRayDeltaM: 0.0432, refused: null, rangeM: null }

test('a tap read another way (one hit from the hit test) has the five sampler keys, and every one is null', () => {
  for (const r of [buildProbeRecord(reading()), buildProbeRecord(reading({ sample: null }))]) {
    assert.deepEqual([r.kept, r.sprM, r.src, r.flrM, r.rej], [null, null, null, null, null], 'nothing was measured, so nothing is claimed')
  }
})

test('a tap the sampler accepted logs its hits, its scatter, its source and the floor ray, rounded to a millimetre', () => {
  const r = buildProbeRecord(reading({ sample: BURST_SAMPLE }))
  assert.deepEqual([r.kept, r.sprM, r.src, r.flrM, r.rej], [12, 0.011, 'burst', 0.043, null])
  assert.equal(r.hit, 1)
  assert.equal(r.rng, 3.456, 'the range is the hit\'s own, which the sampler set to the range of the hits it kept')
})

test('a tap read with one hit has one hit kept and no scatter, and the source says so', () => {
  const r = buildProbeRecord(reading({ sample: { kept: 1, spreadM: null, source: 'single-hit', floorRayDeltaM: null, refused: null, rangeM: null } }))
  assert.deepEqual([r.kept, r.sprM, r.src, r.flrM], [1, null, 'single-hit', null], 'a scatter of one hit is not zero, it is not measured')
})

test('a tap the floor ray placed alone has no hits kept: that is 0, a measurement, and not null', () => {
  const r = buildProbeRecord(reading({ sample: { kept: 0, spreadM: null, source: 'floor-ray', floorRayDeltaM: null, refused: null, rangeM: null } }))
  assert.deepEqual([r.kept, r.src], [0, 'floor-ray'])
})

test('a tap the sampler refused logs hit 0, why, the hits it had, and the scatter that refused it', () => {
  const r = buildProbeRecord(reading({
    hit: null,
    sample: { kept: 9, spreadM: 0.0517, source: null, floorRayDeltaM: null, refused: 'unsteady', rangeM: null },
  }))
  assert.equal(r.hit, 0)
  assert.deepEqual([r.kept, r.sprM, r.src, r.flrM, r.rej], [9, 0.052, null, null, 'unsteady'])
  assert.deepEqual([r.px, r.hx, r.rng], [null, null, null], 'a refused tap has no point, and no range unless it was refused for one')
})

test('a tap refused for being too far logs how far, which is the number the range limit is set from', () => {
  const r = buildProbeRecord(reading({
    hit: null,
    sample: { kept: 14, spreadM: null, source: null, floorRayDeltaM: null, refused: 'too-far', rangeM: 4.1234 },
  }))
  assert.deepEqual([r.hit, r.rej, r.rng, r.kept], [0, 'too-far', 4.123, 14])
})

test('the range of a refusal is never logged beside a hit, which has a range of its own', () => {
  const r = buildProbeRecord(reading({ sample: { ...BURST_SAMPLE, rangeM: 9.9 } }))
  assert.equal(r.rng, 3.456)
})

test('the sampler\'s words are cut like every other word, its counts held to a count, and what is not a number is null', () => {
  const r = buildProbeRecord(reading({
    sample: { kept: -3, spreadM: Number.NaN, source: 'x'.repeat(80), floorRayDeltaM: Number.POSITIVE_INFINITY, refused: '', rangeM: null },
  }))
  assert.equal(r.kept, null, 'a count below zero is not one')
  assert.equal(r.sprM, null)
  assert.equal(r.src?.length, 24)
  assert.equal(r.flrM, null)
  assert.equal(r.rej, null, 'an empty word is no word')
  assert.equal(buildProbeRecord(reading({ sample: { ...BURST_SAMPLE, kept: 2.9 } })).kept, 2, 'a whole number')
  assert.equal(buildProbeRecord(reading({ sample: { ...BURST_SAMPLE, kept: MAX_COUNT + 1 } })).kept, null)
})

test('a typical sampled line still leaves headroom under the cap', () => {
  const cap = relayCap()
  const line = formatProbeLine(buildProbeRecord(reading({ scaleMode: 'responsive', sample: BURST_SAMPLE })))
  assert.ok(line.length < cap - 40, `${line.length} characters of ${cap}`)
})

// ── The arithmetic ───────────────────────────────────────────────────────────────────────────

test('camera pitch is negative looking down, positive looking up, zero level', () => {
  assert.ok(Math.abs(cameraPitchDeg(aboutX(0))!) < 1e-9)
  assert.ok(Math.abs(cameraPitchDeg(aboutX(-48.2))! - -48.2) < 1e-9, 'looking down')
  assert.ok(Math.abs(cameraPitchDeg(aboutX(30))! - 30) < 1e-9, 'looking up')
  assert.ok(Math.abs(cameraPitchDeg(aboutX(-90))! - -90) < 1e-9)
  // Turning on the spot does not change the pitch.
  assert.ok(Math.abs(cameraPitchDeg(mul(aboutY(137), aboutX(-60)))! - -60) < 1e-9)
  // Agrees with the forward vector's own height.
  const q = mul(aboutY(-80), aboutX(-35))
  assert.ok(Math.abs(Math.sin((cameraPitchDeg(q)! * Math.PI) / 180) - forwardOf(q).y) < 1e-12)
  assert.equal(cameraPitchDeg({ x: NaN, y: 0, z: 0, w: 1 }), null)
})

test('the line carries the pitch the camera had at the tap', () => {
  assert.equal(buildProbeRecord(reading({ pose: poseAt({ x: 0, y: 1, z: 0 }, aboutX(-48.2)) })).pitch, -48.2)
})

test('camera yaw is where the camera faces in the session frame: 0 is +Z, 90 is +X', () => {
  // A camera turned to face +X: forward (1, 0, 0). Rotation about Y by -90 turns -Z to +X.
  const east = buildProbeRecord(reading({ pose: poseAt({ x: 0, y: 1, z: 0 }, aboutY(-90)) }))
  assert.equal(east.yaw, 90)
  const forward = forwardOf(aboutY(-90))
  assert.ok(Math.abs(forward.x - 1) < 1e-12 && Math.abs(forward.z) < 1e-12)
  // Facing +Z needs a half turn from the camera's own -Z.
  assert.equal(buildProbeRecord(reading({ pose: poseAt({ x: 0, y: 1, z: 0 }, aboutY(180)) })).yaw, 0)
})

test('turning on the spot: B plus yaw holds still and B minus yaw moves by twice the turn', () => {
  // The arithmetic behind DX3, not a claim about a device. A person turning right by t degrees raises the compass
  // bearing by t. In a right-handed session frame a right turn is a rotation about +Y by -t, which lowers the camera
  // yaw by t. So the sum stays put and the difference moves by 2t. sessionFrameBearingDeg in src/world/geo.ts
  // computes the SUM under the current rule and computed the DIFFERENCE under the earlier one; a device run
  // (Procedure 4) says which of the two the real compass and the real session obey.
  const START = 40
  const sums: number[] = []
  const differences: number[] = []
  for (const turn of [0, 30, 90, 180, 270, 360]) {
    const r = buildProbeRecord(reading({
      bearing: (START + turn) % 360,
      pose: poseAt({ x: 0, y: 1.3, z: 0 }, aboutY(-turn)),
    }))
    sums.push(r.Bplus!)
    differences.push(r.Bminus!)
    assert.ok(r.Bplus! >= 0 && r.Bplus! < 360 && r.Bminus! >= 0 && r.Bminus! < 360, 'both are folded into [0, 360)')
  }
  /** The angular distance between two bearings, 0 to 180, across the wrap at 360. */
  const gap = (a: number, b: number) => Math.abs((((a - b + 180) % 360) + 360) % 360 - 180)
  for (const sum of sums) assert.ok(gap(sum, sums[0]!) < 0.11, `B+yaw drifted: ${sums.join(', ')}`)
  const turns = [0, 30, 90, 180, 270, 360]
  turns.forEach((turn, i) => {
    assert.ok(gap(differences[i]!, differences[0]! + 2 * turn) < 0.11, `B-yaw at ${turn} turned: ${differences.join(', ')}`)
  })
})

test('a bearing that rounds to 360 is written as 0', () => {
  const r = buildProbeRecord(reading({ bearing: 359.96, pose: poseAt({ x: 0, y: 1, z: 0 }, aboutY(180)) }))
  assert.equal(r.B, 0)
  assert.ok(r.Bplus! < 360 && r.Bminus! < 360)
})

test('no compass reading nulls the bearing columns and leaves the camera yaw', () => {
  const r = buildProbeRecord(reading({ bearing: null }))
  assert.deepEqual([r.B, r.Bplus, r.Bminus], [null, null, null])
  assert.notEqual(r.yaw, null)
})

// ── The raw compass sample ───────────────────────────────────────────────────────────────────

test('the raw orientation angles, the absolute flag and the axis of the bearing are logged, to a tenth of a degree', () => {
  const r = buildProbeRecord(reading({ compassSample: ANDROID_SAMPLE }))
  assert.deepEqual(
    [r.ax, r.alpha, r.beta, r.gamma, r.abs, r.wkHead, r.wkAcc],
    ['camera', 148.6, 37.6, 0, 1, null, null],
    'an Android sample has no iOS heading or accuracy, and that is null and not zero',
  )
})

test('an iPhone sample logs its own heading and accuracy beside the relative angles, and no axis it does not know', () => {
  const r = buildProbeRecord(reading({ compassSample: IOS_SAMPLE }))
  assert.deepEqual(
    [r.ax, r.alpha, r.beta, r.gamma, r.abs, r.wkHead, r.wkAcc],
    ['unknown', 301.2, 61.5, -4.1, null, 123.4, 15],
    'the axis of an iPhone heading is not known, and the line says so in those words; its event has no absolute flag, which is null and not 0',
  )
})

test('a tap with no compass sample, or a caller with no sensor to offer, logs null in every raw column and still logs the rest', () => {
  for (const sample of [null, undefined]) {
    const r = buildProbeRecord(reading({ compassSample: sample }))
    assert.deepEqual([r.ax, r.alpha, r.beta, r.gamma, r.abs, r.wkHead, r.wkAcc, r.turn], [null, null, null, null, null, null, null, null])
    assert.equal(r.B, 100, 'the bearing the page passed is still there')
    assert.equal(r.hit, 1)
  }
})

test('a refused sample logs the raw numbers the platform gave and no axis: that is how the log shows why there is no bearing', () => {
  const refused: CompassSample = {
    raw: { alpha: 12, beta: 10, gamma: 11, absolute: false, webkitCompassHeading: 77, webkitCompassAccuracy: -1 },
    reading: null,
  }
  const r = buildProbeRecord(reading({ bearing: null, compassSample: refused }))
  assert.deepEqual([r.B, r.ax, r.alpha, r.wkHead, r.wkAcc], [null, null, 12, 77, -1])
})

test('the absolute flag is 1 when the angles are from the earth\'s frame, 0 when they are not, and null when the event did not say', () => {
  const flag = (absolute: boolean | null) =>
    buildProbeRecord(reading({ compassSample: { raw: { ...ANDROID_SAMPLE.raw, absolute }, reading: ANDROID_SAMPLE.reading } })).abs
  assert.deepEqual([flag(true), flag(false), flag(null)], [1, 0, null])
})

test('a raw number that is not a number is null, never NaN or Infinity, and a negative accuracy is kept as the platform said it', () => {
  const sample: CompassSample = {
    raw: { alpha: Number.NaN, beta: Number.POSITIVE_INFINITY, gamma: Number.NEGATIVE_INFINITY, absolute: true, webkitCompassHeading: Number.NaN, webkitCompassAccuracy: -1 },
    reading: null,
  }
  const r = buildProbeRecord(reading({ compassSample: sample }))
  assert.deepEqual([r.alpha, r.beta, r.gamma, r.wkHead, r.wkAcc], [null, null, null, null, -1])
  const line = formatProbeLine(r)
  assert.equal(line.includes('NaN') || line.includes('Infinity'), false)
})

// ── The turn between the browser's frame and the AR pose's ───────────────────────────────────

/** The sample an Android phone placed this way delivers, with a reading that is not looked at. */
function sampleOf(axes: ReturnType<typeof phoneAt>): CompassSample {
  const [alpha, beta, gamma] = eulerAnglesFor(axes)[0]!
  return { raw: { alpha, beta, gamma, absolute: true, webkitCompassHeading: null, webkitCompassAccuracy: null }, reading: ANDROID_SAMPLE.reading }
}

test('the turn between the browser\'s frame and the pose\'s is logged to a tenth of a degree: 0 where they agree, a quarter turn where one follows the screen', () => {
  const axes = phoneAt(40, 30, 0)
  const sample = sampleOf(axes)
  for (const turn of [0, 90, -90, 180]) {
    const r = buildProbeRecord(reading({ compassSample: sample, pose: poseAt({ x: 0, y: 1, z: 0 }, arPoseFor(axes, 77, turn)) }))
    assert.ok(r.turn !== null, `turn ${turn}`)
    // 180 and -180 are the same turn: either is the measurement.
    const apart = Math.abs((((r.turn! - turn + 180) % 360) + 360) % 360 - 180)
    assert.ok(apart < 0.06, `the oracle turned the frames by ${turn}: the line says ${r.turn}`)
    assert.equal(r.turn, Math.round(r.turn! * 10) / 10, 'kept to a tenth of a degree')
  }
})

test('the turn is null where gravity cannot be read in the screen\'s plane, with no sample or no tilt, and is not a made-up zero', () => {
  const upright = phoneAt(40, 0, 0)
  const flatPhone = phoneAt(40, 85, 0)
  const q = arPoseFor(upright, 77, 0)
  assert.equal(buildProbeRecord(reading({ compassSample: null, pose: poseAt({ x: 0, y: 1, z: 0 }, q) })).turn, null, 'no sample')
  assert.equal(buildProbeRecord(reading({ compassSample: undefined, pose: poseAt({ x: 0, y: 1, z: 0 }, q) })).turn, null)
  assert.equal(buildProbeRecord(reading({ compassSample: sampleOf(flatPhone), pose: poseAt({ x: 0, y: 1, z: 0 }, q) })).turn, null, 'the sample says flat')
  assert.equal(buildProbeRecord(reading({ compassSample: sampleOf(upright), pose: poseAt({ x: 0, y: 1, z: 0 }, arPoseFor(flatPhone, 77, 0)) })).turn, null, 'the pose says flat')
  const noTilt: CompassSample = { raw: { alpha: 10, beta: null, gamma: null, absolute: true, webkitCompassHeading: null, webkitCompassAccuracy: null }, reading: ANDROID_SAMPLE.reading }
  assert.equal(buildProbeRecord(reading({ compassSample: noTilt })).turn, null, 'a tilt that was not delivered is not a flat phone')
  // A refused heading does not stop the turn being read: it is a fact about gravity and the frames, not about the compass.
  const refused: CompassSample = { ...sampleOf(upright), reading: null }
  assert.notEqual(buildProbeRecord(reading({ bearing: null, compassSample: refused, pose: poseAt({ x: 0, y: 1, z: 0 }, q) })).turn, null)
})

test('the new keys come after the old ones, so a line from before still reads the same up to y0', () => {
  assert.deepEqual(PROBE_KEYS.slice(0, 29), [
    'v', 'n', 'rt', 'scale', 'method', 'status', 'sepM', 'resM', 'hit', 'px', 'py', 'pz', 'hx', 'hy', 'hz', 'rng', 'camY', 'pitch',
    'tx', 'ty', 'trk', 'why', 'jumps', 'B', 'yaw', 'Bplus', 'Bminus', 'scr', 'y0',
  ])
  assert.deepEqual(PROBE_KEYS.slice(29), [
    'ax', 'alpha', 'beta', 'gamma', 'abs', 'wkHead', 'wkAcc', 'turn', 'kept', 'sprM', 'src', 'flrM', 'rej',
    // The calibration's fit summary (WP-04b), after the sampler's columns for the same reason.
    'chk', 'fitN', 'fitRms', 'fitRes',
  ])
})

// ── The cap ──────────────────────────────────────────────────────────────────────────────────

/** The relay's cut, read from the relay's own source so the check follows it. */
function relayCap(): number {
  const cap = Number(/const MAX_MSG_CHARS = (\d+)/.exec(read('src/debug/remote-log.ts'))?.[1])
  assert.ok(cap > 0, 'src/debug/remote-log.ts no longer has MAX_MSG_CHARS: the line must be checked against whatever cut replaced it')
  return cap
}

/** The widest a length or angle can be in a line: the bound itself, to the last digit the line keeps. */
const WIDEST = -(MAX_ABS_VALUE - 0.001)
/** The same for an angle, which keeps one decimal: -999.9. */
const WIDEST_DEG = -(MAX_ABS_VALUE - 0.1)

/**
 * The reading that writes the longest line the bounds allow: every number at its widest, every word as long as a
 * word may be, every key present. 'two-point-ground' with a separation, a residual and a fit is the widest calibration
 * (one-point has none of them); 'uncalibrated' is the longest status. The raw compass numbers are each a tenth short of
 * the bound (one decimal is kept, and 999.95 would round up to it), and the axis word is as long as a word may be,
 * though the type allows only three.
 */
function widestReading(): ProbeReading {
  const calibration: ScanCalibration = {
    ...TWO_POINT,
    sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    separationM: WIDEST,
    residualM: WIDEST,
    status: 'uncalibrated',
    // The widest fit: a count at the bound, and the schema's five points at the widest residual (a residual is a magnitude, so
    // a real one never has the sign this one has; the line is held to the widest the bounds allow).
    checkedBy: 'constellation',
    fit: {
      fitMethod: 'rigid',
      pointsUsed: MAX_COUNT,
      rmsResidualM: WIDEST,
      maxResidualM: WIDEST,
      perPoint: Array.from({ length: 5 }, () => ({ residualM: WIDEST, dx: 0, dy: 0, dz: 0 })),
      headingResidualDeg: 0,
      scaleRatio: 1,
    },
  }
  return reading({
    n: MAX_COUNT,
    runtime: 'r'.repeat(80),
    scaleMode: 's'.repeat(80),
    calibration,
    hit: { position: { x: WIDEST, y: WIDEST, z: WIDEST }, distance: WIDEST },
    // Pitched 70.4 down: as wide a pitch as -89.9 (five characters) and steep enough to leave gravity in the screen's plane
    // for `turn` to be read, so that no key is null in this line.
    pose: poseAt({ x: 0, y: WIDEST, z: 0 }, mul(aboutY(-179.9), aboutX(-70.4))),
    tap: { x: 0.999, y: 0.999 },
    trackingStatus: 'N'.repeat(80),
    trackingReason: 'R'.repeat(80),
    poseJumps: MAX_COUNT,
    bearing: 359.9,
    screenAngle: 270,
    firstPose: { position: { x: 0, y: WIDEST, z: 0 } },
    compassSample: {
      raw: { alpha: WIDEST_DEG, beta: WIDEST_DEG, gamma: WIDEST_DEG, absolute: false, webkitCompassHeading: WIDEST_DEG, webkitCompassAccuracy: WIDEST_DEG },
      reading: { ...ANDROID_SAMPLE.reading!, axis: 'a'.repeat(80) as never },
    },
    // The sampler's keys at their widest too. A real tap is accepted or refused, so `src` and `rej` never both hold a
    // word; the bound is for the line a runtime could write, and assumes it might.
    sample: { kept: MAX_COUNT, spreadM: WIDEST, source: 'x'.repeat(80), floorRayDeltaM: WIDEST, refused: 'y'.repeat(80), rangeM: WIDEST },
  })
}

test('the longest line the bounds allow fits the relay cap, which is read from the relay', () => {
  const cap = relayCap()
  const record = buildProbeRecord(widestReading())
  const line = formatProbeLine(record)
  // The line really is the widest: every numeric field holds a value, so nothing was left null to shorten it.
  for (const key of PROBE_KEYS) assert.notEqual(record[key], null, `${key} is null: this is not the longest line`)
  assert.ok(line.length <= cap, `the longest line is ${line.length} characters against the relay's ${cap}: ${line}`)
  assert.ok(line.length > cap - 100, `the cap (${cap}) is ${cap - line.length} characters over the longest line (${line.length}): room for the next keys, and not a cap nothing needs`)
  assert.doesNotThrow(() => parse(line), 'and it is still JSON')
  // `turn` is bounded to [-180, 180) and kept to a tenth, so -179.9 is as wide as it gets: still inside the cap.
  const widestTurn = formatProbeLine({ ...record, turn: -179.9 })
  assert.ok(widestTurn.length <= cap, `with the widest turn the line is ${widestTurn.length} characters against the relay's ${cap}`)
  assert.doesNotThrow(() => parse(widestTurn))
})

test('numbers a runtime got wrong cannot push a line past the relay cap or break its JSON', () => {
  const cap = relayCap()
  // 1e21 prints as 22 characters, MAX_VALUE as 309: without the bounds, a bad pose or hit would make a line the relay
  // cuts in the middle of a number, which is not JSON and which the collection command then drops without a word.
  const absurd = [1e21, -1e21, 1e300, Number.MAX_VALUE, -Number.MAX_VALUE, 123456789.123456, 1e6, -1e6]
  for (const value of absurd) {
    const calibration: ScanCalibration = { ...TWO_POINT, separationM: value, residualM: value }
    const line = formatProbeLine(buildProbeRecord(reading({
      n: Number.MAX_SAFE_INTEGER,
      calibration,
      hit: { position: { x: value, y: value, z: value }, distance: value },
      pose: poseAt({ x: value, y: value, z: value }, aboutY(10)),
      tap: { x: 0.5, y: 0.5 },
      poseJumps: Number.MAX_SAFE_INTEGER,
      bearing: value,
      screenAngle: value,
      firstPose: { position: { x: value, y: value, z: value } },
      compassSample: {
        raw: { alpha: value, beta: value, gamma: value, absolute: true, webkitCompassHeading: value, webkitCompassAccuracy: value },
        reading: ANDROID_SAMPLE.reading,
      },
      sample: { kept: Number.MAX_SAFE_INTEGER, spreadM: value, source: 'burst', floorRayDeltaM: value, refused: null, rangeM: value },
    })))
    assert.ok(line.length <= cap, `${value}: ${line.length} characters against the relay's ${cap}`)
    assert.doesNotThrow(() => parse(line), `${value}: still JSON`)
    assert.doesNotMatch(line, /e[+-]?\d/, `${value}: no exponent form in a line`)
    const record = parse(line)
    for (const key of ['sepM', 'resM', 'hx', 'hy', 'hz', 'px', 'py', 'pz', 'rng', 'camY', 'y0', 'jumps', 'alpha', 'beta', 'gamma', 'wkHead', 'wkAcc', 'kept', 'sprM', 'flrM']) {
      assert.equal(record[key], null, `${value}: ${key} is a number the line cannot carry, so it is null and not a clipped one`)
    }
    assert.equal(record['n'], MAX_COUNT, 'the tap number is held to the largest count, never dropped')
  }
})

test('the bounds sit where they say: just inside is kept as measured, at the bound it is null', () => {
  const near = buildProbeRecord(reading({
    n: MAX_COUNT,
    hit: { position: { x: 999.9994, y: -999.9994, z: 0 }, distance: 12 },
    poseJumps: MAX_COUNT,
  }))
  assert.deepEqual([near.hx, near.hy, near.n, near.jumps], [999.999, -999.999, MAX_COUNT, MAX_COUNT])
  const at = buildProbeRecord(reading({
    n: MAX_COUNT + 1,
    hit: { position: { x: MAX_ABS_VALUE, y: -MAX_ABS_VALUE, z: 0 }, distance: 12 },
    poseJumps: MAX_COUNT + 1,
  }))
  assert.deepEqual([at.hx, at.hy, at.jumps], [null, null, null])
  assert.equal(at.n, MAX_COUNT)
  // A count that is not a count is not reported, and a missing counter stays missing.
  for (const bad of [-1, NaN, Infinity]) assert.equal(buildProbeRecord(reading({ poseJumps: bad })).jumps, null, String(bad))
  assert.equal(buildProbeRecord(reading({ poseJumps: null })).jumps, null)
  assert.equal(buildProbeRecord(reading({ poseJumps: 0 })).jumps, 0, 'a counter that reads 0 is a measurement')
  assert.equal(buildProbeRecord(reading({ poseJumps: 2.9 })).jumps, 2, 'a whole number')
})

test('a typical line leaves headroom under the cap', () => {
  const cap = relayCap()
  const line = formatProbeLine(buildProbeRecord(reading({ scaleMode: 'responsive' })))
  assert.ok(line.length < cap - 40, `${line.length} characters of ${cap}`)
})

test("the relay's cut is not above what the server keeps of a message, or the server would cut the JSON a second time", () => {
  const relay = Number(/const MAX_MSG_CHARS = (\d+)/.exec(read('src/debug/remote-log.ts'))?.[1])
  const server = Number(/export const CLIENT_LOG_MSG_MAX_CHARS = ([\d_]+)/.exec(read('server/wp-a-client-logs.ts'))?.[1]?.replace(/_/g, ''))
  assert.ok(relay > 0 && server > 0, 'both constants are still where this test reads them')
  assert.ok(relay <= server, `the relay sends ${relay} characters and the server keeps ${server}`)
  // The line is the reason the relay's cut was raised from 500: the longest line now passes 500, so a relay at its old cut would break it.
  const widest = formatProbeLine({ ...buildProbeRecord(widestReading()), turn: -179.9 })
  assert.ok(widest.length > 500, `the longest line is ${widest.length} characters: if this is under 500 the relay's old cut was enough and this test has lost its point`)
  assert.ok(widest.length <= relay, `the longest line is ${widest.length} characters and the relay cuts at ${relay}`)
})

test('the relay\'s cut is not the server\'s whole allowance: a 16 KiB body holds more of the cut than of the server\'s limit, which is what a flush needs', () => {
  // The server refuses a whole POST over its body limit with a 413 and the relay empties its buffer before it
  // sends, so a cut that lets every message be long costs messages. Computed with the relay's own entry shape.
  const relay = Number(/const MAX_MSG_CHARS = (\d+)/.exec(read('src/debug/remote-log.ts'))?.[1])
  const server = Number(/export const CLIENT_LOG_MSG_MAX_CHARS = ([\d_]+)/.exec(read('server/wp-a-client-logs.ts'))?.[1]?.replace(/_/g, ''))
  const bodyLimit = Number(/export const CLIENT_LOG_MAX_BODY_BYTES = ([\d_]+)/.exec(read('server/wp-a-client-logs.ts'))?.[1]?.replace(/_/g, ''))
  assert.ok(relay > 0 && server > 0 && bodyLimit > 0)
  const entriesThatFit = (length: number): number => {
    const body = (n: number) => JSON.stringify({ entries: Array.from({ length: n }, () => ({ ts: 1731800000000, level: 'warn', msg: 'x'.repeat(length), url: '/scanner.html' })), ua: 'Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' })
    let n = 0
    while (Buffer.byteLength(body(n + 1)) <= bodyLimit) n++
    return n
  }
  assert.ok(relay < server, `the relay's ${relay} is not below the server's ${server}: every message may then use the whole allowance`)
  // Sixteen of the widest line the bounds allow, which no real line comes near: a flush holds a few probe lines, not fifty. It
  // was twenty at 740 characters; each column a package adds to the line costs a message or two of room, and this is where
  // the next one has to stop and decide again.
  assert.ok(entriesThatFit(relay) >= 16, `${entriesThatFit(relay)} messages of ${relay} characters fit in a ${bodyLimit} byte body`)
  assert.ok(entriesThatFit(relay) > entriesThatFit(server), 'and more than of the server\'s own limit')
})

test("source shape: the relay still mirrors console.warn, which is what the line is written with", () => {
  assert.match(read('src/debug/remote-log.ts'), /console\.warn = \(/, 'the relay no longer mirrors warn: probe lines would never leave the phone')
  assert.match(read('src/capture/probe-log.ts'), /console\.warn\(line\)/)
})

// ── The scale-mode accessor ──────────────────────────────────────────────────────────────────

test('scale mode: a provider without scaleKind is "not known", not an error', () => {
  assert.equal(scaleModeOf({}), null)
  assert.equal(scaleModeOf({ scaleKind: 'absolute' }), null, 'a property that is not a method')
})

test('scale mode: a provider that names one is passed on, as a short word', () => {
  assert.equal(scaleModeOf({ scaleKind: () => 'responsive' }), 'responsive')
  assert.equal(scaleModeOf({ scaleKind: () => 'x'.repeat(100) })?.length, 24)
})

test('scale mode: a method that throws, or answers with no word, is "not known"', () => {
  assert.equal(scaleModeOf({ scaleKind: () => { throw new Error('boom') } }), null)
  for (const answer of [undefined, null, '', 3, {}, ['absolute']]) {
    assert.equal(scaleModeOf({ scaleKind: () => answer }), null, JSON.stringify(answer))
  }
})

test('scale mode: the accessor is called on the provider, so a method that uses `this` works', () => {
  class Provider {
    private kind = 'absolute'
    scaleKind() { return this.kind }
  }
  assert.equal(scaleModeOf(new Provider()), 'absolute')
})

test('scale mode: the full scaleMode() is preferred over scaleKind(), and scaleKind() is the fallback', () => {
  // DX1 tells its arms apart from the line: 'responsive-originY:1.4' and 'absolute-notready' both have kind 'arbitrary'.
  assert.equal(scaleModeOf({ scaleMode: () => 'responsive-originY:1.4', scaleKind: () => 'arbitrary' }), 'responsive-originY:1.4')
  assert.equal(scaleModeOf({ scaleMode: () => 'absolute-notready', scaleKind: () => 'arbitrary' }), 'absolute-notready')
  assert.equal(scaleModeOf({ scaleMode: () => { throw new Error('boom') }, scaleKind: () => 'arbitrary' }), 'arbitrary')
  assert.equal(scaleModeOf({ scaleMode: () => null, scaleKind: () => 'metric' }), 'metric')
  assert.equal(scaleModeOf({ scaleMode: () => 'absolute-ready' }), 'absolute-ready')
  assert.equal(scaleModeOf({ scaleMode: () => '' }), null)
})

// ── The compass the line reads ───────────────────────────────────────────────────────────────

test('the compass bearing is the sensor and does not wait for a GPS fix, which the snapshot does', (t) => {
  // `snapshot()?.bearing` is null until the first position fix even when the compass reads fine. A measurement of
  // the compass has to read the sensor, so GeoTracker offers it directly.
  const fakeWindow = new EventTarget()
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })
  t.after(() => { delete (globalThis as Record<string, unknown>)['window'] })
  const geo = new GeoTracker()
  ;(geo as unknown as { _startOrientation(): void })._startOrientation()
  assert.equal(geo.compassBearing, null, 'no reading yet')

  // iOS: webkitCompassHeading is already a bearing, from magnetic north.
  fakeWindow.dispatchEvent(Object.assign(new Event('deviceorientation'), { webkitCompassHeading: 123.4 }))
  assert.equal(geo.compassBearing, 123.4)
  assert.equal(geo.snapshot(), null, 'no position fix: no snapshot, so no bearing through it')

  // Android: an absolute alpha counts anticlockwise. An event that reports no tilt is a flat phone, so the bearing is
  // its top edge's, 360 - alpha (src/geo/compass-heading.ts); with beta and gamma it is where the camera points.
  fakeWindow.dispatchEvent(Object.assign(new Event('deviceorientationabsolute'), { absolute: true, alpha: 270 }))
  assert.equal(geo.compassBearing, 90)

  // A relative alpha is not a bearing and is ignored, as it always was.
  fakeWindow.dispatchEvent(Object.assign(new Event('deviceorientation'), { absolute: false, alpha: 10 }))
  assert.equal(geo.compassBearing, 90)
})

test('the compass bearing is the live sensor only: a bearing restored with an earlier fix is not a reading', (t) => {
  // GeoTracker.start() restores the last fix from sessionStorage and drops its bearing (WP-10): a bearing from an
  // earlier page load says nothing about where the phone points now, so neither the snapshot nor a measurement of
  // the compass may use it. Only a sample read in this page counts.
  const fakeWindow = new EventTarget()
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })
  t.after(() => { delete (globalThis as Record<string, unknown>)['window'] })
  const geo = new GeoTracker()
  ;(geo as unknown as { _startOrientation(): void })._startOrientation()
  ;(geo as unknown as { _fix: unknown })._fix = {
    lat: 0, lng: 0, accuracy: 5, altitudeM: null, bearing: 77, fixedAt: '2026-11-01T10:00:00.000Z',
    address: null, displayAddress: null, addressComponents: null,
  }
  assert.equal(geo.snapshot()?.bearing, null, 'the snapshot carries the live compass only, not a bearing stored with the fix')
  assert.equal(geo.compassBearing, null, 'the compass has not read yet')
})

// ── The tap handler ──────────────────────────────────────────────────────────────────────────

class FakeCanvas extends EventTarget {
  rect = { left: 10, top: 20, width: 200, height: 400 }
  listeners = new Map<string, number>()
  private direct = new Map<string, Array<(event: Event) => void>>()
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1)
    if (typeof listener === 'function') this.direct.set(type, [...(this.direct.get(type) ?? []), listener as (event: Event) => void])
    super.addEventListener(type, listener, options)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) - 1)
    this.direct.set(type, (this.direct.get(type) ?? []).filter((candidate) => candidate !== listener))
    super.removeEventListener(type, listener, options)
  }
  getBoundingClientRect() {
    return this.rect
  }
  /**
   * Calls the registered listeners of an event one by one, in the caller's own stack. `dispatchEvent` reports a
   * listener's exception to the process (an uncaught exception, in the next tick), where this lets it reach the test.
   */
  fire(event: Event): void {
    for (const listener of this.direct.get(event.type) ?? []) listener(event)
  }
}

/** A one-finger touch tap whose exceptions, if the listener throws one, reach the caller. */
function tapTouchDirect(canvas: FakeCanvas, clientX: number, clientY: number): void {
  const event = new Event('touchstart')
  Object.assign(event, { touches: [{ clientX, clientY }] })
  canvas.fire(event)
}

function tapTouch(canvas: FakeCanvas, clientX: number, clientY: number, fingers = 1): void {
  const event = new Event('touchstart')
  Object.assign(event, { touches: Array.from({ length: fingers }, () => ({ clientX, clientY })) })
  canvas.dispatchEvent(event)
}

function tapPointer(canvas: FakeCanvas, clientX: number, clientY: number, pointerType: string): void {
  const event = new Event('pointerdown')
  Object.assign(event, { clientX, clientY, pointerType })
  canvas.dispatchEvent(event)
}

const settle = () => new Promise<void>((resolveSettle) => setTimeout(resolveSettle, 0))

function harness(over: Partial<ProbeLogDeps> = {}, provider: Partial<ProbeProvider> = {}) {
  const canvas = new FakeCanvas()
  const lines: string[] = []
  const calls: Array<[number, number]> = []
  const fullProvider: ProbeProvider = {
    getPose: () => poseAt({ x: 1, y: 0.2, z: 2 }, mul(aboutY(30), aboutX(-20))),
    isTracking: () => true,
    trackingStatus: () => 'NORMAL',
    getTrackingDiagnostics: () => ({ status: 'LIMITED', poseJumps: 1, lastJumpM: 0.4, reason: 'TOO_MUCH_MOTION' }),
    ...provider,
  }
  const deps: ProbeLogDeps = {
    canvas: canvas as unknown as ProbeCanvas,
    provider: fullProvider,
    runtime: 'webxr',
    hitTest: (x, y) => {
      calls.push([x, y])
      return { position: HEADING_MARKER, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 3 } satisfies HitResult
    },
    calibration: () => TWO_POINT,
    bearing: () => 100,
    compassSample: () => ANDROID_SAMPLE,
    firstPose: () => ({ position: { x: 0, y: 1.25, z: 0 } }),
    emit: (line) => lines.push(line),
    screenAngle: () => 0,
    ...over,
  }
  return { canvas, lines, calls, deps }
}

test('not armed: nothing is added to the page and nothing is logged', async () => {
  for (const search of ['', '?debug=remote', '?debug=pose,remote', '?world=default']) {
    const h = harness()
    assert.equal(installProbeLog(h.deps, search), null, `search ${JSON.stringify(search)}`)
    assert.equal(h.canvas.listeners.size, 0, 'no listener was added')
    tapTouch(h.canvas, 110, 220)
    await settle()
    assert.deepEqual(h.lines, [])
  }
})

test('armed by ?debug=probe, alone or in a list: one line per tap', async () => {
  for (const search of ['?debug=probe', '?debug=remote,probe', '?debug=probe,pose', '?debug=%20PROBE%20']) {
    const h = harness()
    const stop = installProbeLog(h.deps, search)
    assert.equal(typeof stop, 'function', search)
    tapTouch(h.canvas, 110, 220)
    await settle()
    assert.equal(h.lines.length, 1, search)
  }
})

test('a tap logs the normalised canvas point, hit-tests it, and reads the tracking diagnostics the provider gives', async () => {
  const h = harness()
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220) // (110-10)/200 = 0.5, (220-20)/400 = 0.5
  await settle()
  assert.deepEqual(h.calls, [[0.5, 0.5]], 'the hit test is asked for the canvas-normalised point, as calibration asks it')
  const record = parse(h.lines[0]!)
  assert.deepEqual([record['tx'], record['ty']], [0.5, 0.5])
  assert.equal(record['n'], 1)
  assert.equal(record['rt'], 'webxr')
  assert.equal(record['hit'], 1)
  assert.equal(record['trk'], 'LIMITED', "the diagnostics' status, not the cached one")
  assert.equal(record['why'], 'TOO_MUCH_MOTION')
  assert.equal(record['jumps'], 1)
  assert.equal(record['B'], 100)
  assert.equal(record['y0'], 1.25)
  assert.equal(record['method'], 'two-point-ground')
})

test('a tap logs the compass sample the page has, and a caller that offers none logs null columns and the rest of the line', async () => {
  const withSample = harness()
  installProbeLog(withSample.deps, '?debug=probe')
  tapTouch(withSample.canvas, 110, 220)
  const without = harness({ compassSample: undefined })
  installProbeLog(without.deps, '?debug=probe')
  tapTouch(without.canvas, 110, 220)
  await settle()
  const a = parse(withSample.lines[0]!)
  assert.deepEqual([a['ax'], a['alpha'], a['beta'], a['gamma'], a['abs'], a['wkHead'], a['wkAcc']], ['camera', 148.6, 37.6, 0, 1, null, null])
  assert.equal(typeof a['turn'], 'number', 'the turn between the two frames is read from the sample and the pose at the tap')
  const b = parse(without.lines[0]!)
  assert.deepEqual([b['ax'], b['alpha'], b['beta'], b['gamma'], b['abs'], b['wkHead'], b['wkAcc'], b['turn']], [null, null, null, null, null, null, null, null])
  assert.equal(b['B'], 100)
  assert.equal(b['hit'], 1)
})

test('a provider with no diagnostics falls back to its tracking status and no reason', async () => {
  const h = harness({}, { getTrackingDiagnostics: undefined })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  await settle()
  const record = parse(h.lines[0]!)
  assert.equal(record['trk'], 'NORMAL')
  assert.equal(record['why'], null)
  assert.equal(record['jumps'], null, 'no counter is not "no frame shifts": a zero here would read as a runtime that never shifted')
})

test('the scale mode is read from the provider when it has the accessor, and is null when it does not', async () => {
  const without = harness()
  installProbeLog(without.deps, '?debug=probe')
  tapTouch(without.canvas, 110, 220)
  const withIt = harness({}, { scaleKind: () => 'responsive' } as Partial<ProbeProvider>)
  installProbeLog(withIt.deps, '?debug=probe')
  tapTouch(withIt.canvas, 110, 220)
  await settle()
  assert.equal(parse(without.lines[0]!)['scale'], null)
  assert.equal(parse(withIt.lines[0]!)['scale'], 'responsive')
})

test('the counter counts taps, and the camera pose and compass are read at the tap and not when the hit test answers', async () => {
  let turned = false
  let release: (hit: HitResult) => void = () => {}
  const h = harness(
    {
      hitTest: () => new Promise<HitResult>((resolveHit) => { release = resolveHit }),
      bearing: () => (turned ? 200 : 100),
      compassSample: () => (turned ? IOS_SAMPLE : ANDROID_SAMPLE),
    },
    { getPose: () => poseAt({ x: 0, y: turned ? 9 : 1.1, z: 0 }, aboutY(0)) },
  )
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  turned = true // the phone moves on while the hit test runs
  release({ position: HEADING_MARKER, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 3 })
  await settle()
  const first = parse(h.lines[0]!)
  assert.equal(first['camY'], 1.1)
  assert.equal(first['B'], 100)
  assert.deepEqual([first['ax'], first['alpha']], ['camera', 148.6], 'the compass sample is the one at the tap, not the one when the hit test answered')
  tapTouch(h.canvas, 110, 220)
  await settle()
  release({ position: HEADING_MARKER, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 3 })
  await settle()
  assert.equal(parse(h.lines[1]!)['n'], 2)
  assert.equal(parse(h.lines[1]!)['camY'], 9)
})

test('a second tap while the first is being measured is dropped: one tap is one line', async () => {
  // Every hit test the probe starts is kept, so a tap that was wrongly let through has a hit test to answer and
  // would write a line of its own: dropping it is what keeps this at one.
  const started: Array<(hit: HitResult | null) => void> = []
  const h = harness({ hitTest: () => new Promise<HitResult | null>((resolveHit) => { started.push(resolveHit) }) })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  tapTouch(h.canvas, 120, 230)
  tapTouch(h.canvas, 130, 240)
  assert.equal(started.length, 1, 'one hit test was started, for the first tap')
  for (const release of started) release(null)
  await settle()
  assert.equal(h.lines.length, 1)
  tapTouch(h.canvas, 110, 220)
  assert.equal(started.length, 2, 'and the next tap is taken once the first is done')
  started[1]!(null)
  await settle()
  assert.equal(h.lines.length, 2)
  assert.deepEqual(h.lines.map((line) => parse(line)['n']), [1, 2], 'numbered in the order they were taken')
})

test('a hit test that finds nothing, or throws, is a line with hit 0', async () => {
  for (const hitTest of [() => null, () => Promise.resolve(null), () => { throw new Error('WASM map miss') }, () => Promise.reject(new Error('xr'))]) {
    const h = harness({ hitTest })
    installProbeLog(h.deps, '?debug=probe')
    tapTouch(h.canvas, 110, 220)
    await settle()
    assert.equal(h.lines.length, 1)
    assert.equal(parse(h.lines[0]!)['hit'], 0)
    assert.equal(parse(h.lines[0]!)['px'], null)
  }
})

// ── A probe tap read through the calibration's sampler ───────────────────────────────────────

/** What the sampler answers for an accepted tap at the heading marker, as `probeAnswerOf` shapes it. */
const ACCEPTED: ProbeTapAnswer = {
  hit: { position: HEADING_MARKER, distance: 2.5 },
  sample: BURST_SAMPLE,
}

test('with a sampler, the probe tap is read through it and not through the hit test, and the line says what it found', async () => {
  const asked: Array<[number, number]> = []
  const h = harness({
    sample: async (x, y) => {
      asked.push([x, y])
      return ACCEPTED
    },
  })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  await settle()
  assert.deepEqual(asked, [[0.5, 0.5]], 'asked for the canvas-normalised point, as the calibration asks it')
  assert.deepEqual(h.calls, [], 'the one-hit test was not used')
  const record = parse(h.lines[0]!)
  assert.deepEqual([record['hit'], record['rng'], record['kept'], record['sprM'], record['src'], record['flrM'], record['rej']], [1, 2.5, 12, 0.011, 'burst', 0.043, null])
  assert.ok(Math.abs((record['pz'] as number) - SEPARATION_M) < 1e-3, 'the point is placed in the Place frame like any other tap')
})

test('a tap the sampler refuses is a line with hit 0 and the reason, and the next tap is read', async () => {
  const answers: ProbeTapAnswer[] = [
    { hit: null, sample: { kept: 2, spreadM: null, source: null, floorRayDeltaM: null, refused: 'too-few-hits', rangeM: null } },
    ACCEPTED,
  ]
  const h = harness({ sample: async () => answers.shift()! })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  await settle()
  tapTouch(h.canvas, 110, 220)
  await settle()
  assert.equal(h.lines.length, 2)
  const [refused, accepted] = h.lines.map(parse)
  assert.deepEqual([refused!['n'], refused!['hit'], refused!['rej'], refused!['kept'], refused!['px']], [1, 0, 'too-few-hits', 2, null])
  assert.deepEqual([accepted!['n'], accepted!['hit'], accepted!['rej']], [2, 1, null])
})

test('a tap read with the limits lifted keeps its point whatever they would have said: hit 1, its own range, and the limit it was over', async () => {
  const far: ProbeTapAnswer = {
    hit: { position: HEADING_MARKER, distance: 4.8 },
    sample: { ...BURST_SAMPLE, refused: 'too-far' },
  }
  const h = harness({ sample: async () => far })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  await settle()
  const record = parse(h.lines[0]!)
  assert.deepEqual([record['hit'], record['rng'], record['rej'], record['kept']], [1, 4.8, 'too-far', 12])
  assert.ok(Math.abs((record['pz'] as number) - SEPARATION_M) < 1e-3, 'and the point is placed in the Place frame like any other tap')
})

test('a sampler that rejects, or answers nothing, is a tap that found nothing, as a failed hit test is', async () => {
  for (const sample of [() => Promise.reject(new Error('burst failed')), () => { throw new Error('boom') }, async () => null as unknown as ProbeTapAnswer]) {
    const h = harness({ sample })
    installProbeLog(h.deps, '?debug=probe')
    tapTouch(h.canvas, 110, 220)
    await settle()
    assert.equal(h.lines.length, 1)
    const record = parse(h.lines[0]!)
    assert.deepEqual([record['hit'], record['kept'], record['rej'], record['px']], [0, null, null, null])
  }
})

test('a sampler that never settles is given up on after three seconds, like a hit test that never does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness({ sample: () => new Promise<ProbeTapAnswer>(() => {}) })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  t.mock.timers.tick(2_999)
  await flushMicrotasks()
  assert.equal(h.lines.length, 0)
  t.mock.timers.tick(2)
  await flushMicrotasks()
  assert.equal(h.lines.length, 1)
  assert.equal(parse(h.lines[0]!)['hit'], 0)
})

/** Lets every promise continuation that is already queued run, however many hops a race and an await take. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('a hit test that never settles is given up on after three seconds, so the log does not stop for the rest of the session', async (t) => {
  // Three seconds in both directions, as literal numbers: a guard of one second would cut a slow WebXR answer short, and one
  // of half a minute would swallow a whole probe session (a tester taps every few seconds) behind a single lost promise.
  assert.equal(HIT_TEST_GUARD_MS, 3_000, 'the guard moved: this test, the module comment and the procedure all assume three seconds')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness({ hitTest: () => new Promise<HitResult | null>(() => {}) })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  t.mock.timers.tick(2_999)
  await flushMicrotasks()
  assert.equal(h.lines.length, 0, 'still waiting just inside the guard (the microtasks have all run, so a line would be there)')
  t.mock.timers.tick(2)
  await flushMicrotasks()
  assert.equal(h.lines.length, 1)
  assert.equal(parse(h.lines[0]!)['hit'], 0)
  // And the log is not stopped: the next tap is taken.
  tapTouch(h.canvas, 110, 220)
  t.mock.timers.tick(3_001)
  await flushMicrotasks()
  assert.deepEqual(h.lines.map((line) => parse(line)['n']), [1, 2])
})

test("the guard is longer than the WebXR provider's own hit-test timeout, so it only ever fires for a promise that never settles", () => {
  const providerTimeout = Number(/const HIT_TEST_TIMEOUT_MS = ([\d_]+)/.exec(read('src/ar/webxr.ts'))?.[1]?.replace(/_/g, ''))
  assert.ok(providerTimeout > 0, 'src/ar/webxr.ts no longer has HIT_TEST_TIMEOUT_MS: the guard must be compared with whatever bound replaced it')
  assert.ok(HIT_TEST_GUARD_MS > providerTimeout, `the guard (${HIT_TEST_GUARD_MS} ms) must outlast the provider's own (${providerTimeout} ms), or it would cut a slow answer short`)
})

test('the guard timer is cleared as soon as the hit test answers, so none is left pending after a tap', async (t) => {
  const pending = new Set<unknown>()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = realSet(() => { pending.delete(id); fn(...rest) }, ms)
    pending.add(id)
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (id: ReturnType<typeof setTimeout>) => { pending.delete(id); realClear(id) })
  const h = harness()
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  await settle()
  assert.equal(h.lines.length, 1)
  assert.equal(pending.size, 0, 'a three-second timer left behind by every tap would hold a page (and a test process) open')
})

test('taps that are not taps on the canvas, or came before tracking, are not logged', async () => {
  const h = harness()
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220, 2) // a pinch
  tapTouch(h.canvas, 5, 220) // left of the canvas
  tapTouch(h.canvas, 110, 900) // below it
  tapTouch(h.canvas, 211, 220) // right of it (the canvas spans 10 to 210)
  tapTouch(h.canvas, 110, 19) // above it (the canvas spans 20 to 420)
  tapPointer(h.canvas, 110, 220, 'touch') // the pointer half of a touchscreen tap, already taken as a touch
  await settle()
  assert.equal(h.lines.length, 0)
  h.canvas.rect = { left: 0, top: 0, width: 0, height: 0 } // mid-layout: the division is NaN
  tapTouch(h.canvas, 110, 220)
  await settle()
  assert.equal(h.lines.length, 0)

  const early = harness({}, { isTracking: () => false })
  installProbeLog(early.deps, '?debug=probe')
  tapTouch(early.canvas, 110, 220)
  await settle()
  assert.equal(early.lines.length, 0, 'before the runtime has a pose')
})

test('a pointer that is not a finger (a Quest controller, a mouse) is a tap', async () => {
  const h = harness()
  installProbeLog(h.deps, '?debug=probe')
  tapPointer(h.canvas, 110, 220, 'mouse')
  await settle()
  assert.equal(h.lines.length, 1)
})

test('stopping removes both listeners', async () => {
  const h = harness()
  const stop = installProbeLog(h.deps, '?debug=probe')!
  assert.deepEqual([h.canvas.listeners.get('touchstart'), h.canvas.listeners.get('pointerdown')], [1, 1])
  stop()
  assert.deepEqual([h.canvas.listeners.get('touchstart'), h.canvas.listeners.get('pointerdown')], [0, 0])
  tapTouch(h.canvas, 110, 220)
  await settle()
  assert.equal(h.lines.length, 0)
})

// ── A diagnostic does not break the page, or the next tap ────────────────────────────────────

test('a read that throws at the tap costs that tap, not the page and not the next tap', async () => {
  // The reads at the tap (the calibration, the compass, the pose, the first pose) are the app's own closures. If one
  // throws, the listener must not: the exception would reach the page, and the probe would be left "busy" for good,
  // silently logging nothing for the rest of the session.
  let failures = 1
  const h = harness({
    calibration: () => {
      if (failures-- > 0) throw new Error('closure boom')
      return TWO_POINT
    },
  })
  installProbeLog(h.deps, '?debug=probe')
  assert.doesNotThrow(() => tapTouchDirect(h.canvas, 110, 220), 'no exception reaches the page')
  await settle()
  assert.equal(h.lines.length, 0, 'the tap whose read threw has no line')
  tapTouchDirect(h.canvas, 110, 220)
  await settle()
  assert.equal(h.lines.length, 1, 'the next tap is taken: the probe was not left busy')
  assert.equal(parse(h.lines[0]!)['n'], 2, 'and the lost tap is a gap in n, which is how the person reading the log sees it')
})

test('each read the tap makes is survived the same way, and a tap that was accepted and lost is a gap in n', async () => {
  const POSE = poseAt({ x: 1, y: 0.2, z: 2 }, mul(aboutY(30), aboutX(-20)))
  /** Throws on its first call and answers as the harness would afterwards. */
  const once = <T>(answer: T): (() => T) => {
    let failed = false
    return () => {
      if (!failed) {
        failed = true
        throw new Error('boom')
      }
      return answer
    }
  }
  // Reads made once the tap is known to be a probe tap: the tap is counted first, so its loss shows as a gap.
  const afterAcceptance: Array<[string, Partial<ProbeLogDeps>, Partial<ProbeProvider>]> = [
    ['getPose', {}, { getPose: once(POSE) }],
    ['getTrackingDiagnostics', {}, { getTrackingDiagnostics: once({ status: 'NORMAL', poseJumps: 0, lastJumpM: 0 }) }],
    ['trackingStatus', {}, { getTrackingDiagnostics: undefined, trackingStatus: once('NORMAL') }],
    ['calibration', { calibration: once(TWO_POINT) }, {}],
    ['bearing', { bearing: once(100) }, {}],
    ['compassSample', { compassSample: once(ANDROID_SAMPLE) }, {}],
    ['firstPose', { firstPose: once({ position: { x: 0, y: 1.25, z: 0 } }) }, {}],
    ['screenAngle', { screenAngle: once(0) }, {}],
  ]
  for (const [name, over, provider] of afterAcceptance) {
    const h = harness(over, provider)
    installProbeLog(h.deps, '?debug=probe')
    assert.doesNotThrow(() => tapTouchDirect(h.canvas, 110, 220), name)
    await settle()
    assert.equal(h.lines.length, 0, `${name}: no line for the tap whose read threw`)
    tapTouchDirect(h.canvas, 110, 220)
    await settle()
    assert.equal(h.lines.length, 1, `${name}: the next tap is taken`)
    assert.equal(parse(h.lines[0]!)['n'], 2, `${name}: the lost tap was counted, so its loss is a gap`)
  }
  // Reads made to decide whether it is a probe tap at all: a tap that cannot be classified is not counted.
  const beforeAcceptance: Array<[string, Partial<ProbeLogDeps>, Partial<ProbeProvider>]> = [
    ['isTracking', {}, { isTracking: once(true) }],
    ['getBoundingClientRect', {}, {}],
  ]
  for (const [name, over, provider] of beforeAcceptance) {
    const h = harness(over, provider)
    if (name === 'getBoundingClientRect') {
      const rect = h.canvas.rect
      h.canvas.getBoundingClientRect = once(rect)
    }
    installProbeLog(h.deps, '?debug=probe')
    assert.doesNotThrow(() => tapTouchDirect(h.canvas, 110, 220), name)
    await settle()
    assert.equal(h.lines.length, 0, `${name}: no line`)
    tapTouchDirect(h.canvas, 110, 220)
    await settle()
    assert.equal(h.lines.length, 1, `${name}: the next tap is taken`)
    assert.equal(parse(h.lines[0]!)['n'], 1, `${name}: a tap that could not be classified was never counted`)
  }
})

test('an emit that throws does not leave the probe stuck, and is not an unhandled rejection', async () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    let failures = 1
    const written: string[] = []
    const h = harness({
      emit: (line) => {
        if (failures-- > 0) throw new Error('relay boom')
        written.push(line)
      },
    })
    installProbeLog(h.deps, '?debug=probe')
    tapTouchDirect(h.canvas, 110, 220)
    await settle()
    await settle()
    tapTouchDirect(h.canvas, 110, 220)
    await settle()
    assert.equal(written.length, 1, 'the next tap writes its line')
    assert.equal(parse(written[0]!)['n'], 2)
    assert.deepEqual(rejections, [], 'the failed write is swallowed where it happens')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

// ── The screen angle, read from the live screen when nothing is injected ─────────────────────

test('without an injected screen angle the live screen is read: screen.orientation, then the older window.orientation, else null', async (t) => {
  const g = globalThis as Record<string, unknown>
  const had = { screen: Object.getOwnPropertyDescriptor(g, 'screen'), window: Object.getOwnPropertyDescriptor(g, 'window') }
  t.after(() => {
    for (const name of ['screen', 'window'] as const) {
      if (had[name]) Object.defineProperty(g, name, had[name])
      else delete g[name]
    }
  })
  const angleOnNextTap = async (): Promise<unknown> => {
    const h = harness({ screenAngle: undefined })
    installProbeLog(h.deps, '?debug=probe')
    tapTouch(h.canvas, 110, 220)
    await settle()
    return parse(h.lines[0]!)['scr']
  }
  Object.defineProperty(g, 'screen', { value: { orientation: { angle: 90 } }, configurable: true, writable: true })
  assert.equal(await angleOnNextTap(), 90, 'screen.orientation.angle')
  // Older iOS Safari has no screen.orientation and keeps the angle on window.
  Object.defineProperty(g, 'screen', { value: {}, configurable: true, writable: true })
  Object.defineProperty(g, 'window', { value: { orientation: -90 }, configurable: true, writable: true })
  assert.equal(await angleOnNextTap(), -90, 'window.orientation')
  Object.defineProperty(g, 'window', { value: {}, configurable: true, writable: true })
  assert.equal(await angleOnNextTap(), null, 'neither: not available, not 0')
})

test('without an emit, a line goes to console.warn, which the remote relay mirrors', async (t) => {
  const seen: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { seen.push(args) })
  const h = harness({ emit: undefined })
  installProbeLog(h.deps, '?debug=probe')
  tapTouch(h.canvas, 110, 220)
  await settle()
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.length, 1, 'one string, so the relay joins nothing')
  assert.ok(String(seen[0]![0]).startsWith('[probe] {'))
})

// ── The wiring in src/main.ts ────────────────────────────────────────────────────────────────

test('source shape: main.ts arms the probe once, after the calibration step and before scanning starts', () => {
  const main = read('src/main.ts')
  const calls = main.match(/installProbeLog\(/g) ?? []
  assert.equal(calls.length, 1, 'one call')
  assert.match(main, /import \{ installProbeLog \} from '\.\/capture\/probe-log'/)
  const calibration = main.indexOf('await runProjectCalibration(')
  const probe = main.indexOf('installProbeLog({')
  const tracking = main.indexOf("overlay.setStatus('Move the camera to start tracking…')")
  assert.ok(calibration > 0 && probe > calibration && tracking > probe, 'it comes after calibration, so a probe tap is a point the frame was not built from')
})

test("source shape: the call hands the probe the scanner's own hit test and calibration, and the compass sensor", () => {
  const main = read('src/main.ts')
  const start = main.indexOf('installProbeLog({')
  const call = main.slice(start, main.indexOf('})', start))
  assert.match(call, /hitTest: async \(x, y\) => asyncHitTest \? await asyncHitTest\(x, y\) : provider\.hitTest\(x, y\)/, "the calibration flow's hit test")
  assert.match(call, /bearing: \(\) => geoTracker\.pairedCompass\(provider\.getPose\(\)\.rotation\)\?\.bearingDeg \?\? null/, 'the bearing the calibration is given, which does not wait for a GPS fix')
  assert.match(call, /compassSample: \(\) => geoTracker\.lastCompassSample/, 'and the last raw compass event with the reading taken from it')
  assert.match(call, /^installProbeLog\(\{\n    canvas,\n    provider,\n/, "the scanner's own canvas, which the calibration is also given, and the scanner's provider")
  assert.match(main.slice(main.indexOf('await runProjectCalibration({')), /\n      canvas,\n/, 'the calibration is handed the same `canvas`, so a probe tap lands where a calibration tap does')
  assert.match(call, /calibration: \(\) => sessionCalibration/)
  assert.match(call, /runtime: use8thWall \? '8thwall' : 'webxr'/)
  assert.match(call, /firstPose: \(\) => poseHistory\[0\]/)
})

test('source shape: probe is a known debug flag', () => {
  assert.match(read('src/shared/debug-flags.ts'), /\| 'probe'/)
})

// ── The fit (WP-04b) ─────────────────────────────────────────────────────────────────────────────────

const FIT: Extract<ScanCalibration, { method: 'two-point-ground' }> = {
  ...TWO_POINT,
  checkedBy: 'constellation',
  fit: {
    fitMethod: 'rigid',
    pointsUsed: 3,
    rmsResidualM: 0.031416,
    maxResidualM: 0.04,
    perPoint: [
      { residualM: 0.0204, dx: 0.02, dy: 0, dz: -0.004 },
      { residualM: 0.0299, dx: 0, dy: 0.01, dz: 0.0299 },
      { residualM: 0.04, dx: -0.04, dy: 0, dz: 0 },
    ],
    headingResidualDeg: 0.4,
    scaleRatio: 1.004,
  },
}

test('a session whose points were fitted logs the check, how many points, the rms and each point\'s residual, to a millimetre', () => {
  const r = buildProbeRecord(reading({ calibration: FIT }))
  assert.deepEqual([r.chk, r.fitN, r.fitRms, r.fitRes], ['constellation', 3, 0.031, [0.02, 0.03, 0.04]])
  const line = parse(formatProbeLine(r))
  assert.deepEqual([line['chk'], line['fitN'], line['fitRms'], line['fitRes']], ['constellation', 3, 0.031, [0.02, 0.03, 0.04]])
  assert.deepEqual(Object.keys(line).slice(-4), ['chk', 'fitN', 'fitRms', 'fitRes'], 'after the sampler\'s columns, so a line from before still reads the same')
})

test('a session checked by distance names the check and has no fit: null, never a zero that reads as a measurement', () => {
  const r = buildProbeRecord(reading({ calibration: { ...TWO_POINT, status: 'provisional', checkedBy: 'separation' } }))
  assert.deepEqual([r.chk, r.fitN, r.fitRms, r.fitRes], ['separation', null, null, null])
})

test('a first calibration, the one-point tier and no calibration have no check and no fit', () => {
  for (const calibration of [TWO_POINT, ONE_POINT, null]) {
    const r = buildProbeRecord(reading({ calibration }))
    assert.deepEqual([r.chk, r.fitN, r.fitRms, r.fitRes], [null, null, null, null])
  }
})

test('a one-point record that claims a fit does not log one (ADR 0005 rule 3: no other tier carries it)', () => {
  const claimed = { ...ONE_POINT, checkedBy: 'constellation', fit: FIT.fit } as unknown as ScanCalibration
  const r = buildProbeRecord(reading({ calibration: claimed }))
  assert.deepEqual([r.chk, r.fitN, r.fitRms, r.fitRes], [null, null, null, null])
})

test('what is not a number is null in its place, and a check that is not one of the two is not logged', () => {
  const odd = {
    ...FIT,
    checkedBy: 'banana',
    fit: { ...FIT.fit!, pointsUsed: Number.NaN, rmsResidualM: Number.POSITIVE_INFINITY, perPoint: [{ residualM: Number.NaN, dx: 0, dy: 0, dz: 0 }, { residualM: 1e9, dx: 0, dy: 0, dz: 0 }, { residualM: 0.02, dx: 0, dy: 0, dz: 0 }] },
  } as unknown as ScanCalibration
  const r = buildProbeRecord(reading({ calibration: odd }))
  assert.deepEqual([r.chk, r.fitN, r.fitRms, r.fitRes], [null, null, null, [null, null, 0.02]])
  const damaged = { ...FIT, fit: { ...FIT.fit!, perPoint: 'not a list' } } as unknown as ScanCalibration
  assert.equal(buildProbeRecord(reading({ calibration: damaged })).fitRes, null)
})

test('no more than the schema\'s five residuals are logged, so a line cannot outgrow the relay\'s cap', () => {
  const many = { ...FIT, fit: { ...FIT.fit!, perPoint: Array.from({ length: 40 }, () => ({ residualM: 0.01, dx: 0, dy: 0, dz: 0 })) } } as ScanCalibration
  assert.equal(buildProbeRecord(reading({ calibration: many })).fitRes!.length, 5)
})
