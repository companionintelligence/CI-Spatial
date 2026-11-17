/**
 * PoseHistory: pairing a camera image with the pose it was taken at.
 *
 * The last test puts a number on why it exists. A tag seen from a phone that is walking at 0.3 m/s
 * lands about a centimetre from where it is if the image is paired with the pose of the NEXT frame
 * (33 ms later), which is what the vendored 8th Wall `CameraPixelArray` hands over (see the header
 * of `src/ar/fiducial/pose-history.ts`). That is the same size as the accuracy the pose is meant to
 * have, so it is not a detail.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_pose_history.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { PoseHistory } from '../../../src/ar/fiducial/pose-history.ts'
import { fuseTagObservations } from '../../../src/ar/fiducial/tag-pose.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import type { TagObservation } from '../../../src/ar/fiducial/types.ts'
import { INTRINSICS_640, lookAtPose, projectSessionTag, quatFromMatrix, rotY } from '../../support/fiducial-render.ts'

function pose(x: number, yawDeg = 0): Pose {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yawDeg * Math.PI) / 180)
  return { position: { x, y: 1, z: 0 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
}

test('interpolates position linearly and rotation spherically between the two samples around the time asked for', () => {
  const h = new PoseHistory()
  h.push(pose(0, 0), 1000)
  h.push(pose(1, 90), 1100)
  const mid = h.at(1025)!
  assert.ok(Math.abs(mid.position.x - 0.25) < 1e-12)
  const expected = new THREE.Quaternion(0, 0, 0, 1).slerp(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), 0.25)
  assert.ok(Math.abs(Math.abs(mid.rotation.x * expected.x + mid.rotation.y * expected.y + mid.rotation.z * expected.z + mid.rotation.w * expected.w) - 1) < 1e-12)
  // A sample's own time returns it exactly.
  assert.deepEqual(h.at(1000), pose(0, 0))
  assert.deepEqual(h.at(1100), pose(1, 90))
})

test('rotation takes the short way round, even across the sign flip of a quaternion', () => {
  const h = new PoseHistory()
  const a = pose(0, 170)
  const bq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-170 * Math.PI) / 180)
  h.push(a, 0)
  h.push({ position: { x: 0, y: 1, z: 0 }, rotation: { x: bq.x, y: bq.y, z: bq.z, w: bq.w } }, 100)
  // Halfway between +170 and -170 degrees about y is 180 (a 20 degree arc), not 0.
  const m = h.at(50)!.rotation
  const yaw = 2 * Math.atan2(m.y, m.w) * (180 / Math.PI)
  assert.ok(Math.abs(Math.abs(yaw) - 180) < 1e-6, `yaw ${yaw}`)
})

test('never extrapolates, answers a request just outside the range with the nearest sample, and refuses a gap', () => {
  const h = new PoseHistory()
  h.push(pose(0), 1000)
  h.push(pose(1), 1033)
  h.push(pose(2), 1066)
  h.push(pose(5), 1400)
  assert.equal(h.at(900), null)
  assert.deepEqual(h.at(985), pose(0), 'within 20 ms before the first sample: the first sample, not an extrapolation')
  assert.deepEqual(h.at(1410), pose(5))
  assert.equal(h.at(1500), null)
  // 1066 -> 1400 is a hole of 334 ms: interpolating across it would invent a path.
  assert.equal(h.at(1200), null)
  assert.ok(h.at(1050))
  assert.ok(h.at(1200, 400), 'a caller who allows a longer gap gets the interpolation')
})

test('a sample that is not newer, or that is not a number, is ignored; the oldest is evicted past capacity', () => {
  const h = new PoseHistory(3)
  h.push(pose(0), 10)
  h.push(pose(1), 10)
  h.push(pose(2), 5)
  h.push(pose(3), Number.NaN)
  h.push({ position: { x: Number.NaN, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, 20)
  assert.equal(h.size, 1)
  h.push(pose(1), 20)
  h.push(pose(2), 30)
  h.push(pose(3), 40)
  assert.equal(h.size, 3)
  assert.deepEqual(h.at(10), pose(1), 'the oldest sample is gone: a request before the new first sample gets that one, not the evicted pose')
  assert.equal(h.at(-5), null)
  assert.deepEqual(h.at(20), pose(1))
  h.clear()
  assert.equal(h.size, 0)
  assert.equal(h.at(20), null)
  assert.throws(() => new PoseHistory(1), /at least two/)
})

test('what is stored cannot be changed through what was pushed or what was returned', () => {
  const h = new PoseHistory()
  const p = pose(0)
  h.push(p, 0)
  h.push(pose(1), 100)
  p.position.x = 99
  assert.equal(h.at(0)!.position.x, 0)
  const got = h.at(0)!
  got.position.x = 77
  assert.equal(h.at(0)!.position.x, 0)
})

test('pairing an image with the pose of the NEXT frame costs about a centimetre at walking speed; the history removes it', () => {
  const tagPosition = { x: 0.3, y: 1.3, z: -3 }
  const tag = { position: tagPosition, rotation: quatFromMatrix(rotY((20 * Math.PI) / 180)) }
  const K = INTRINSICS_640
  const frameMs = 33.3
  const base = lookAtPose({ x: 0, y: 1.2, z: -1 }, tagPosition)

  // Two ways a hand moves a phone: strafing at 0.3 m/s keeping its heading, and panning at 10 degrees per second on the spot.
  const strafe = (tMs: number): Pose => ({ position: { x: -0.45 + (0.3 * tMs) / 1000, y: 1.2, z: -1 }, rotation: base.rotation })
  const pan = (tMs: number): Pose => {
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (((-5 + (10 * tMs) / 1000) * Math.PI) / 180))
    const q = turn.multiply(new THREE.Quaternion(base.rotation.x, base.rotation.y, base.rotation.z, base.rotation.w))
    return { position: { x: 0, y: 1.2, z: -1 }, rotation: { x: q.x, y: q.y, z: q.z, w: q.w } }
  }

  for (const [name, camAt, expectedCm] of [['strafing 0.3 m/s', strafe, 1.0], ['panning 10 deg/s', pan, 1.15]] as const) {
    const history = new PoseHistory()
    history.push(camAt(0), 0)
    const withHistory: TagObservation[] = []
    const withLatest: TagObservation[] = []
    for (let n = 1; n <= 30; n++) {
      const tNow = n * frameMs
      const tImage = (n - 1) * frameMs // the pixels delivered at frame n are frame n - 1's
      history.push(camAt(tNow), tNow)
      const corners = projectSessionTag(tag, camAt(tImage), K, 0.2) as unknown as TagObservation['corners']
      const synced = history.at(tImage)
      assert.ok(synced, `no pose for ${tImage}`)
      withLatest.push({ corners, intrinsics: K, cameraPose: camAt(tNow) })
      withHistory.push({ corners, intrinsics: K, cameraPose: synced })
    }
    const err = (obs: TagObservation[]) => {
      const f = fuseTagObservations(obs, { tagSizeM: 0.2, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90 })
      assert.ok(f.pose, `${name}: ${f.reason}`)
      return Math.hypot(f.pose.position.x - tagPosition.x, f.pose.position.y - tagPosition.y, f.pose.position.z - tagPosition.z)
    }
    const unsynced = err(withLatest)
    const synced = err(withHistory)
    assert.ok(unsynced > 0.6 * (expectedCm / 100) && unsynced < 1.6 * (expectedCm / 100), `${name}: pairing with the next frame's pose moved the tag ${(unsynced * 100).toFixed(2)} cm (expected about ${expectedCm} cm)`)
    assert.ok(synced < 0.002, `${name}: with the history it is ${(synced * 100).toFixed(2)} cm off`)
  }
})
