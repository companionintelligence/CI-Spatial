/**
 * The native AR codec (src/ar/native-codec.ts): column-major matrices, projections, tracking
 * states, and base64 payloads, as the ScanAR plugin sends them. Runs in Node with no device.
 *
 * Run: npm run test:native-ar
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aspectFromProjection,
  base64ToBytes,
  decodeFloat32Base64,
  fovYDegFromProjection,
  isMatrix16,
  poseFromTransform,
  trackingStatusFromNative,
} from '../../../src/ar/native-codec.ts'
import * as codec from '../../../src/ar/native-codec.ts'
import { classifyTracking } from '../../../src/ar/frame-epoch.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A column-major perspective projection for a vertical field of view and an aspect (width / height). */
function perspective(fovYDeg: number, aspect: number): number[] {
  const t = Math.tan((fovYDeg * Math.PI) / 360)
  const near = 0.01
  const far = 100
  return [
    1 / (aspect * t), 0, 0, 0,
    0, 1 / t, 0, 0,
    0, 0, -(far + near) / (far - near), -1,
    0, 0, (-2 * far * near) / (far - near), 0,
  ]
}

function float32LE(values: number[]): string {
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  values.forEach((value, i) => view.setFloat32(i * 4, value, true))
  return Buffer.from(buffer).toString('base64')
}

test('poseFromTransform: the identity is the origin with no rotation', () => {
  const pose = poseFromTransform(IDENTITY)
  assert.deepEqual(pose.position, { x: 0, y: 0, z: 0 })
  assert.deepEqual(pose.rotation, { x: 0, y: 0, z: 0, w: 1 })
})

test('poseFromTransform: a 90° yaw about +Y with a translation', () => {
  // Column-major: the columns are (0,0,-1), (0,1,0), (1,0,0), and the translation is (1,2,3).
  const pose = poseFromTransform([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1])
  assert.deepEqual(pose.position, { x: 1, y: 2, z: 3 })
  const half = Math.SQRT1_2
  assert.ok(Math.abs(pose.rotation.x) < 1e-12)
  assert.ok(Math.abs(pose.rotation.y - half) < 1e-12)
  assert.ok(Math.abs(pose.rotation.z) < 1e-12)
  assert.ok(Math.abs(pose.rotation.w - half) < 1e-12)
})

test('poseFromTransform: a 180° turn about +X takes the largest-diagonal branch', () => {
  const pose = poseFromTransform([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])
  assert.ok(Math.abs(Math.abs(pose.rotation.x) - 1) < 1e-12)
  assert.ok(Math.abs(pose.rotation.w) < 1e-12)
})

test('poseFromTransform rejects anything but 16 finite numbers', () => {
  assert.throws(() => poseFromTransform([1, 0, 0]), /16 finite numbers/)
  assert.throws(() => poseFromTransform([...IDENTITY.slice(0, 15), Number.NaN]), /16 finite numbers/)
  assert.equal(isMatrix16(IDENTITY), true)
  assert.equal(isMatrix16([...IDENTITY.slice(0, 15), Infinity]), false)
})

test('fovYDegFromProjection reads the vertical field of view back out of a projection', () => {
  assert.ok(Math.abs(fovYDegFromProjection(perspective(60, 0.75)) - 60) < 1e-9)
  assert.ok(Math.abs(fovYDegFromProjection(perspective(45, 1.333)) - 45) < 1e-9)
})

test('aspectFromProjection reads width over height back out of a projection', () => {
  assert.ok(Math.abs(aspectFromProjection(perspective(60, 0.75)) - 0.75) < 1e-9)
  assert.ok(Math.abs(aspectFromProjection(perspective(60, 1.5)) - 1.5) < 1e-9)
})

test('projection readers refuse a projection without positive focal terms', () => {
  const broken = perspective(60, 0.75)
  broken[5] = 0
  assert.throws(() => fovYDegFromProjection(broken), /vertical focal/)
  assert.throws(() => aspectFromProjection(broken), /focal terms/)
})

test('trackingStatusFromNative maps each native state, and an unknown state reads as UNKNOWN', () => {
  assert.equal(trackingStatusFromNative('normal'), 'NORMAL')
  assert.equal(trackingStatusFromNative('notAvailable'), 'NOT_AVAILABLE')
  assert.equal(trackingStatusFromNative('limited.initializing'), 'INITIALIZING')
  assert.equal(trackingStatusFromNative('limited.excessiveMotion'), 'LIMITED')
  assert.equal(trackingStatusFromNative('limited.insufficientFeatures'), 'LIMITED')
  assert.equal(trackingStatusFromNative('limited.relocalizing'), 'LIMITED')
  assert.equal(trackingStatusFromNative('limited'), 'LIMITED')
  assert.equal(trackingStatusFromNative('something-new'), 'UNKNOWN')
})

test('base64ToBytes round-trips raw bytes', () => {
  assert.deepEqual(Array.from(base64ToBytes(Buffer.from([0, 127, 255]).toString('base64'))), [0, 127, 255])
})

test('decodeFloat32Base64 reads little-endian values and refuses a payload of the wrong size', () => {
  assert.deepEqual(Array.from(decodeFloat32Base64(float32LE([1.5, 2.25, 0.125, 4]), 4)), [1.5, 2.25, 0.125, 4])
  assert.throws(() => decodeFloat32Base64(float32LE([1, 2, 3]), 4), /expected 16/)
})

// ── The reason a native state gives for being limited ────────────────────────────────────────────────

test('trackingReasonFromNative gives the reason a limited state names, in the words the tracking code reads, and none for a state that names none', () => {
  const reasonOf = (state: string) => (codec as unknown as { trackingReasonFromNative(state: string): string | undefined }).trackingReasonFromNative(state)
  assert.equal(reasonOf('limited.relocalizing'), 'RELOCALIZING', 'the one reason that is a discontinuity by itself (src/ar/frame-epoch.ts, REASON_RELOCALIZING)')
  assert.equal(reasonOf('limited.initializing'), 'INITIALIZING')
  assert.equal(reasonOf('limited.excessiveMotion'), 'EXCESSIVE_MOTION', 'the native layer\'s own word, not another runtime\'s')
  assert.equal(reasonOf('limited.insufficientFeatures'), 'INSUFFICIENT_FEATURES')
  for (const state of ['normal', 'notAvailable', 'limited', 'limited.somethingNew', 'LIMITED', '', 'relocalizing']) {
    assert.equal(reasonOf(state), undefined, `"${state}" names no reason, and none is made up`)
  }
})

/** The string literals a function body returns, from its declaration to the closing brace the source indents by four spaces. */
function returnedStrings(source: string, declaration: string): string[] {
  const from = source.indexOf(declaration)
  assert.notEqual(from, -1, `the source declares ${declaration}`)
  const body = source.slice(from, source.indexOf('\n    }\n', from))
  return [...body.matchAll(/return "([^"]+)"/g)].map((m) => m[1]!)
}

test('every tracking state either native layer can send is one the codec reads, and ARKit alone says it is relocalizing', () => {
  const swift = returnedStrings(read('mobile/ios/App/App/ScanARPlugin.swift'), 'private static func describe(')
  const java = returnedStrings(read('mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARRenderer.java'), 'private static String trackingName(')
  assert.ok(swift.length >= 6 && java.length >= 5, 'the two functions were read')
  for (const state of [...swift, ...java]) {
    assert.notEqual(trackingStatusFromNative(state), 'UNKNOWN', `"${state}" is sent, and the codec does not read it`)
    if (state.startsWith('limited.')) {
      assert.notEqual(codec.trackingReasonFromNative(state), undefined, `"${state}" names a reason the codec drops`)
    }
  }
  // The asymmetry the epoch tests rely on, from the sources: ARKit has a relocalizing state, ARCore has no word for one.
  // If Android starts to send it, a relocalization is a signal there too and the "no signal is invented" test must change.
  assert.ok(swift.includes('limited.relocalizing'))
  assert.ok(!java.includes('limited.relocalizing'))
  // And what a status read from them is, for the tracker: a limited state is degraded, and relocalizing alone is a discontinuity.
  assert.equal(classifyTracking(trackingStatusFromNative('limited.relocalizing'), codec.trackingReasonFromNative('limited.relocalizing')), 'degraded')
})
