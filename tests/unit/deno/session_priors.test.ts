/**
 * What a session's keyframe records say about where its camera was (server/register/session_priors.ts): the key a frame
 * goes by, which epoch's poses to trust, the recorded camera centres, and the pair-list images in the Place frame.
 *
 * The Place-frame placement is checked against `composeYUpTransform` and `transformPoint`, the writer and reader of
 * `sessionToProject` in src/world/geo.ts, by a route that shares no code with the function under test: the viewing
 * direction is recovered by placing two points and subtracting.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { composeYUpTransform, transformPoint } from '../../../src/world/geo.ts'
import { buildPairList } from '../../../server/register/pair_list.ts'
import {
  chooseSessionEpoch,
  folderOfKey,
  frameKey,
  keyedRecords,
  pairImagesFromKeyframes,
  placementProblem,
  recordEpoch,
  sessionCentres,
} from '../../../server/register/session_priors.ts'
import { sim3ToColumnMajor, sim3ToRowMajor } from '../../../server/register/sim3_chain.ts'
import type { KeyframeRecord } from '../../../server/splat/splat_train_dataset.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A record whose camera is at (x, y, z) turned `yawDeg` about +Y (the AR pose convention: it looks down its own -z). */
function record(
  index: number,
  at: [number, number, number] | null,
  yawDeg = 0,
  epoch?: number,
  file = `kf-${String(index).padStart(5, '0')}.jpg`,
): KeyframeRecord {
  const half = (yawDeg * Math.PI) / 360
  return {
    index,
    file,
    ...(at
      ? { pose: { position: { x: at[0], y: at[1], z: at[2] }, rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) } } }
      : {}),
    ...(epoch === undefined ? {} : { epoch }),
  } as KeyframeRecord
}

// ─── Keys ────────────────────────────────────────────────────────────────────

Deno.test('a frame\'s key is its COLMAP image name, and the folder comes back out of it', () => {
  assertEquals(frameKey('sess-aaaa', 'kf-00003.jpg'), 'sess-aaaa/kf-00003.jpg')
  assertEquals(folderOfKey('sess-aaaa/kf-00003.jpg'), 'sess-aaaa')
  assertEquals(folderOfKey('kf-00003.jpg'), null)
})

Deno.test('keyedRecords gives every reader that pairs by filename the joint key, and drops a record with no file', () => {
  const keyed = keyedRecords([record(0, [0, 0, 0]), { index: 1 }, record(2, [1, 0, 0])], 'sess-aaaa')
  assertEquals(keyed.map((r) => r.file), ['sess-aaaa/kf-00000.jpg', 'sess-aaaa/kf-00002.jpg'])
  assertEquals(keyed[0]!.pose?.position?.x, 0, 'everything else on the record is kept')
})

// ─── Epochs ──────────────────────────────────────────────────────────────────

Deno.test('a record with no usable epoch is in epoch 0', () => {
  assertEquals(recordEpoch(record(0, [0, 0, 0])), 0)
  assertEquals(recordEpoch(record(0, [0, 0, 0], 0, 3)), 3)
  for (const bad of [-1, 1.5, NaN, '2', null]) {
    assertEquals(recordEpoch({ ...record(0, [0, 0, 0]), epoch: bad } as KeyframeRecord), 0, `epoch ${String(bad)}`)
  }
})

Deno.test('the epoch the calibration was made in is the one the poses are read from, whatever the majority is', () => {
  const records = [
    record(0, [0, 0, 0], 0, 0), record(1, [1, 0, 0], 0, 0),
    record(2, [2, 0, 0], 0, 1), record(3, [3, 0, 0], 0, 1), record(4, [4, 0, 0], 0, 1),
  ]
  const named = chooseSessionEpoch(records, 0)
  assertEquals(named.epoch, 0)
  assertEquals(named.source, 'calibration')
  assertEquals(named.counts, [{ epoch: 0, frames: 2 }, { epoch: 1, frames: 3 }])
  assertEquals(named.mixed, true)

  // Named but empty: the calibration says nothing about the other epochs, so there are no frames, not other frames.
  const empty = chooseSessionEpoch(records, 7)
  assertEquals(empty.epoch, 7)
  assertEquals(sessionCentres(records, 'sess-aaaa', empty.epoch).size, 0)
})

Deno.test('with no calibration epoch named, the epoch with the most posed frames is used, and it says it guessed', () => {
  const records = [
    record(0, [0, 0, 0], 0, 0),
    record(1, [1, 0, 0], 0, 1), record(2, [2, 0, 0], 0, 1),
    record(3, null, 0, 2), record(4, null, 0, 2), record(5, null, 0, 2), // unposed: not counted
  ]
  const guessed = chooseSessionEpoch(records)
  assertEquals(guessed.epoch, 1)
  assertEquals(guessed.source, 'majority')
  assertEquals(guessed.counts, [{ epoch: 0, frames: 1 }, { epoch: 1, frames: 2 }])

  // A tie goes to the lowest epoch, so the choice does not depend on record order.
  const tie = [record(0, [0, 0, 0], 0, 1), record(1, [1, 0, 0], 0, 0)]
  assertEquals(chooseSessionEpoch(tie).epoch, 0)
  assertEquals(chooseSessionEpoch([...tie].reverse()).epoch, 0)

  const none = chooseSessionEpoch([record(0, null)])
  assertEquals(none.epoch, null)
  assertEquals(none.source, 'none')
  assertEquals(none.mixed, false)
})

// ─── Recorded camera centres ─────────────────────────────────────────────────

Deno.test('the recorded centres are the session-frame positions, keyed by frame, for one epoch only', () => {
  const records = [
    record(0, [1, 2, 3], 0, 0), record(1, [4, 5, 6], 0, 0), record(2, [7, 8, 9], 0, 1), record(3, null, 0, 0),
  ]
  const centres = sessionCentres(records, 'sess-aaaa', 0)
  assertEquals([...centres.keys()], ['sess-aaaa/kf-00000.jpg', 'sess-aaaa/kf-00001.jpg'])
  assertEquals(centres.get('sess-aaaa/kf-00000.jpg'), [1, 2, 3])
  assertEquals(centres.get('sess-aaaa/kf-00001.jpg'), [4, 5, 6])
  assertEquals(sessionCentres(records, 'sess-aaaa', 1).size, 1)
  assertEquals(sessionCentres(records, 'sess-aaaa', null).size, 0)
})

// ─── Pair-list images in the Place frame ─────────────────────────────────────

Deno.test('with the identity calibration the images sit where the poses say, looking down their own -z', () => {
  const images = pairImagesFromKeyframes(
    [record(0, [1, 1.5, 2], 0), record(1, [0, 1.5, 0], 90), record(2, [0, 1.5, 0], 180)],
    'sess-aaaa',
    { sessionToProject: IDENTITY, epoch: 0 },
  )
  assertEquals(images.map((i) => i.name), ['sess-aaaa/kf-00000.jpg', 'sess-aaaa/kf-00001.jpg', 'sess-aaaa/kf-00002.jpg'])
  assertEquals(images.map((i) => i.sessionId), ['sess-aaaa', 'sess-aaaa', 'sess-aaaa'])
  assertEquals(images.map((i) => i.index), [0, 1, 2])
  assertEquals(images[0]!.position, [1, 1.5, 2])
  const near = (a: readonly number[] | undefined, b: number[]) => assert(a && a.every((v, i) => Math.abs(v - b[i]!) < 1e-12), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  near(images[0]!.forward, [0, 0, -1]) // no turn: looking down -z
  near(images[1]!.forward, [-1, 0, 0]) // a quarter turn about +Y: looking down -x
  near(images[2]!.forward, [0, 0, 1]) // a half turn: looking down +z
})

Deno.test('a calibration is applied the way the editor applies it: the centre through the whole matrix, the direction through its rotation', () => {
  const calibration = composeYUpTransform({ x: 3, y: -0.5, z: 7 }, 37)
  const records = [record(0, [1, 1.5, 2], 20), record(1, [-2, 1.4, 0.5], -75)]
  const images = pairImagesFromKeyframes(records, 'sess-aaaa', { sessionToProject: calibration, epoch: 0 })
  records.forEach((rec, i) => {
    const p = rec.pose!.position!
    // The centre: transformPoint, the reader of sessionToProject in src/world/geo.ts.
    const placed = transformPoint(calibration, { x: p.x!, y: p.y!, z: p.z! })
    assert(Math.abs(images[i]!.position![0] - placed.x) < 1e-12 && Math.abs(images[i]!.position![1] - placed.y) < 1e-12 && Math.abs(images[i]!.position![2] - placed.z) < 1e-12)
    // The direction, by another route: place a point one metre along the camera's own -z and subtract the centre.
    const half = ((i === 0 ? 20 : -75) * Math.PI) / 360
    const yaw = 2 * half
    const ahead = { x: p.x! - Math.sin(yaw), y: p.y!, z: p.z! - Math.cos(yaw) }
    const toward = transformPoint(calibration, ahead)
    const d = [toward.x - placed.x, toward.y - placed.y, toward.z - placed.z]
    const f = images[i]!.forward!
    assert(Math.abs(f[0] - d[0]!) < 1e-12 && Math.abs(f[1] - d[1]!) < 1e-12 && Math.abs(f[2] - d[2]!) < 1e-12, `${i}: ${f} vs ${d}`)
    assert(Math.abs(Math.hypot(...f) - 1) < 1e-12, 'a unit direction')
  })
})

Deno.test('a scale in the calibration moves the centre but does not stretch the viewing direction', () => {
  const images = pairImagesFromKeyframes([record(0, [1, 0, 1], 0)], 'sess-aaaa', { sessionToProject: composeYUpTransform({ x: 0, y: 0, z: 0 }, 0, 2), epoch: 0 })
  assertEquals(images[0]!.position, [2, 0, 2])
  assert(Math.abs(Math.hypot(...images[0]!.forward!) - 1) < 1e-12)
})

Deno.test('a frame in another epoch, with no pose, or with no placement is left unposed and keeps its place in the sequence', () => {
  const records = [record(0, [0, 0, 0], 0, 0), record(1, [1, 0, 0], 0, 1), record(2, null, 0, 0), record(3, [3, 0, 0], 0, 0)]
  const placed = pairImagesFromKeyframes(records, 'sess-aaaa', { sessionToProject: IDENTITY, epoch: 0 })
  assertEquals(placed.map((i) => i.position !== undefined), [true, false, false, true])
  assertEquals(placed.map((i) => i.index), [0, 1, 2, 3])
  for (const placement of [undefined, { sessionToProject: IDENTITY, epoch: null }, { sessionToProject: [1, 2, 3], epoch: 0 }]) {
    const none = pairImagesFromKeyframes(records, 'sess-aaaa', placement)
    assertEquals(none.every((i) => i.position === undefined && i.forward === undefined), true)
    assertEquals(none.length, 4)
  }
})

Deno.test('only frames of the calibration\'s own epoch are posed, the ones before it as much as the ones after', () => {
  // The calibration was made in epoch 1. A frame from epoch 0 was taken before the frame shifted and one from epoch 2
  // after the next: it says nothing about where either is, so neither is placed by it.
  const records = [record(0, [0, 0, 0], 0, 0), record(1, [1, 0, 0], 0, 1), record(2, [2, 0, 0], 0, 2), record(3, [3, 0, 0], 0, 1)]
  const images = pairImagesFromKeyframes(records, 'sess-aaaa', { sessionToProject: IDENTITY, epoch: 1 })
  assertEquals(images.map((i) => i.position !== undefined), [false, true, false, true])
  assertEquals(sessionCentres(records, 'sess-aaaa', 1).size, 2)
})

Deno.test('a placement is a column-major similarity or it is refused with the reason, and a refused one poses nothing', () => {
  const calibration = composeYUpTransform({ x: 3, y: -0.5, z: 7 }, 37)
  assertEquals(placementProblem(undefined), null)
  assertEquals(placementProblem({ sessionToProject: IDENTITY, epoch: 0 }), null)
  assertEquals(placementProblem({ sessionToProject: calibration, epoch: 0 }), null)
  assertEquals(placementProblem({ sessionToProject: composeYUpTransform({ x: 0, y: 0, z: 0 }, 10, 1.3), epoch: 0 }), null, 'a scale is a similarity')
  assertEquals(placementProblem({ sessionToProject: [1, 2, 3], epoch: 0 })?.includes('column-major similarity'), true)
  // With no epoch no frame is posed, so what the matrix is does not matter.
  assertEquals(placementProblem({ sessionToProject: [1, 2, 3], epoch: null }), null)

  // The other layout: the same transform written row-major, as SplatAlignManifest.projectTransform has it.
  const rowMajor = sim3ToRowMajor({ rotation: [[Math.cos(0.6), 0, Math.sin(0.6)], [0, 1, 0], [-Math.sin(0.6), 0, Math.cos(0.6)]], translation: [3, -0.5, 7], scale: 1 })
  const problem = placementProblem({ sessionToProject: rowMajor, epoch: 0 })
  assert(problem !== null && problem.includes('row-major'), String(problem))
  const records = [record(0, [1, 1.5, 2], 0), record(1, [0, 1.5, 0], 90)]
  const unposed = pairImagesFromKeyframes(records, 'sess-aaaa', { sessionToProject: rowMajor, epoch: 0 })
  assertEquals(unposed.map((i) => i.position), [undefined, undefined], 'it would have put every frame in the wrong place; it puts none')
  // The same transform, as the column-major matrix it should have been, poses them.
  const column = sim3ToColumnMajor({ rotation: [[Math.cos(0.6), 0, Math.sin(0.6)], [0, 1, 0], [-Math.sin(0.6), 0, Math.cos(0.6)]], translation: [3, -0.5, 7], scale: 1 })
  assertEquals(pairImagesFromKeyframes(records, 'sess-aaaa', { sessionToProject: column, epoch: 0 }).map((i) => i.position !== undefined), [true, true])

  // A mirror is not a similarity either.
  const mirrored = sim3ToColumnMajor({ rotation: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], scale: 1 })
  assert(placementProblem({ sessionToProject: mirrored, epoch: 0 }) !== null)
})

Deno.test('records with no index are numbered in order, and records with no file are left out', () => {
  const images = pairImagesFromKeyframes(
    [{ file: 'kf-00000.jpg' }, { file: 'kf-00001.jpg' }, { index: 9 }, { file: 'kf-00002.jpg', index: 7 }, { file: 'kf-00003.jpg' }] as KeyframeRecord[],
    'sess-aaaa',
  )
  assertEquals(images.map((i) => i.index), [0, 1, 7, 8])
})

// ─── Priors and the pair list together ───────────────────────────────────────

Deno.test('two sessions recorded in different AR frames are tied by their calibrations, and not tied without them', () => {
  // The same corridor walked twice. Session B's AR frame is turned a quarter about +Y and shifted, so its recorded
  // positions look nothing like A's, and only B's calibration puts them back.
  const walkA = Array.from({ length: 12 }, (_, i) => record(i, [i * 0.3, 1.5, 0], 0))
  const calibrationB = composeYUpTransform({ x: 4, y: 0, z: -2 }, 90)
  // Place -> B's frame: undo the turn and the shift (for a quarter turn the inverse is the transpose).
  const toB = (x: number, z: number) => {
    const dx = x - 4
    const dz = z + 2
    // x' = c x + s z, z' = -s x + c z with the bearing b = 90 degrees (c = 0, s = 1) maps B -> Place; invert it.
    return { x: -dz, z: dx }
  }
  const walkB = Array.from({ length: 12 }, (_, i) => {
    const b = toB(i * 0.3, 1)
    return record(i, [b.x, 1.5, b.z], -90) // looking the way A looks, seen from B's turned frame
  })

  const placementOf = (calibration: number[]) => ({ sessionToProject: calibration, epoch: 0 })
  const imagesWith = (calibrationOfB: number[]) => [
    ...pairImagesFromKeyframes(walkA, 'sess-aaaa', placementOf(IDENTITY)),
    ...pairImagesFromKeyframes(walkB, 'sess-bbbb', placementOf(calibrationOfB)),
  ]

  // Check the construction itself: with B's calibration the two walks are one metre apart and look the same way.
  const placed = pairImagesFromKeyframes(walkB, 'sess-bbbb', placementOf(calibrationB))
  assert(Math.abs(placed[0]!.position![2] - 1) < 1e-9 && Math.abs(placed[0]!.position![0] - 0) < 1e-9, JSON.stringify(placed[0]))

  const tied = buildPairList(imagesWith(calibrationB))
  assert(tied.ok && tied.stats.crossSessionPairs > 0 && tied.stats.isolatedSessions.length === 0)
  // Treat B's frame as if it were the Place frame (no calibration): its walk is 4 m away and turned, so nothing ties.
  const untied = buildPairList(imagesWith(IDENTITY))
  assert(untied.ok)
  assertEquals(untied.stats.crossSessionPairs, 0)
  assertEquals(untied.stats.isolatedSessions, ['sess-aaaa', 'sess-bbbb'])
})
